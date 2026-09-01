import asyncio
import os
import sys
import re
import json
import time
import shutil
import logging
from pathlib import Path
from typing import Optional, List, Dict, Any

# パス解決（直接 python altcord/server.py で実行された場合でも動作するように対応）
BASE_DIR = Path(__file__).resolve().parent.parent
if str(BASE_DIR) not in sys.path:
    sys.path.insert(0, str(BASE_DIR))

import discord
from fastapi import FastAPI, Request, WebSocket, WebSocketDisconnect, UploadFile, File, Form, Depends, HTTPException, Query, Header
from fastapi.responses import HTMLResponse, JSONResponse, FileResponse, StreamingResponse
from fastapi.staticfiles import StaticFiles
from fastapi.middleware.cors import CORSMiddleware
from dotenv import load_dotenv

try:
    from .database import (
        create_user,
        authenticate_user,
        get_user_by_session,
        update_user_profile,
        save_message_dict,
        bulk_save_messages,
        get_cached_messages,
        get_cached_messages_context,
        get_guild_recent_messages,
        delete_cached_message,
        update_cached_message_content,
        UPLOADS_DIR,
        DB_DIR
    )
    from .crawler import MessageCrawler, serialize_discord_message
    from .search import execute_search
except ImportError:
    from altcord.database import (
        create_user,
        authenticate_user,
        get_user_by_session,
        update_user_profile,
        save_message_dict,
        bulk_save_messages,
        get_cached_messages,
        get_cached_messages_context,
        get_guild_recent_messages,
        delete_cached_message,
        update_cached_message_content,
        UPLOADS_DIR,
        DB_DIR
    )
    from altcord.crawler import MessageCrawler, serialize_discord_message
    from altcord.search import execute_search

logging.basicConfig(level=logging.INFO)
logger = logging.getLogger("altcord.server")

# .env をカレントディレクトリに依存せず BASE_DIR から明示的に読み込む
# （systemd 等、想定と違う作業ディレクトリから起動された場合に .env が
#   見つからずトークンが読めない、という事故を防ぐ）
load_dotenv(BASE_DIR / ".env")
TOKEN = os.getenv("TOOLS_BOT_TOKEN")
# アイコン画像専用保存チャンネルID
AVATAR_STORAGE_CHANNEL_ID = 1503248182786654330

# Discordクライアント初期化
intents = discord.Intents.default()
intents.message_content = True
intents.members = True
intents.guilds = True
intents.typing = True
intents.reactions = True
discord_client = discord.Client(intents=intents)

app = FastAPI(title="Altcord Backend API")

# 全オリジンからのアクセス（HTML直接起動・XAMPP・外部オリジン等）を許可するCORS設定
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

crawler = MessageCrawler(discord_client)

# WebSocketコネクション管理
class ConnectionManager:
    def __init__(self):
        self.active_connections: List[WebSocket] = []
        # SSE client queues: each entry is an asyncio.Queue
        self.sse_queues: List[asyncio.Queue] = []

    async def connect(self, websocket: WebSocket):
        await websocket.accept()
        self.active_connections.append(websocket)

    def disconnect(self, websocket: WebSocket):
        if websocket in self.active_connections:
            self.active_connections.remove(websocket)

    def add_sse_client(self) -> asyncio.Queue:
        q: asyncio.Queue = asyncio.Queue(maxsize=100)
        self.sse_queues.append(q)
        return q

    def remove_sse_client(self, q: asyncio.Queue):
        if q in self.sse_queues:
            self.sse_queues.remove(q)

    async def broadcast(self, message: dict):
        disconnected = []
        for connection in self.active_connections:
            try:
                await connection.send_json(message)
            except Exception:
                disconnected.append(connection)
        for conn in disconnected:
            self.disconnect(conn)
        # Also push to SSE clients
        dead_sse = []
        for q in self.sse_queues:
            try:
                q.put_nowait(message)
            except asyncio.QueueFull:
                dead_sse.append(q)
        for q in dead_sse:
            self.remove_sse_client(q)

ws_manager = ConnectionManager()

# Webhook取得/作成ヘルパー
WEBHOOK_NAME = "AltcordWebhook"

async def get_channel_webhook(channel):
    is_thread = isinstance(channel, discord.Thread)
    webhook_channel = channel.parent if is_thread else channel
    if webhook_channel is None:
        raise RuntimeError("Webhookを作成できるチャンネルが見つかりません")

    try:
        webhooks = await webhook_channel.webhooks()
        webhook = discord.utils.get(webhooks, name=WEBHOOK_NAME)
        if webhook is None:
            webhook = await webhook_channel.create_webhook(name=WEBHOOK_NAME)
        return webhook, channel if is_thread else None
    except Exception as e:
        logger.error(f"Failed to obtain webhook: {e}")
        raise e


async def upload_image_to_discord_cdn(file_path: Path, filename: str, fallback_channel=None) -> Optional[str]:
    """専用チャンネル(1503248182786654330)またはフォールバックチャンネルにアイコンを送信し、永続CDN URLを取得"""
    # 1. 専用保管チャンネルへ送信
    try:
        channel = discord_client.get_channel(AVATAR_STORAGE_CHANNEL_ID)
        if not channel:
            try:
                channel = await discord_client.fetch_channel(AVATAR_STORAGE_CHANNEL_ID)
            except Exception:
                channel = None

        if channel:
            d_file = discord.File(str(file_path), filename=filename)
            temp_msg = await channel.send(content=f"Altcord Avatar Sync: `{filename}`", file=d_file)
            if temp_msg.attachments:
                logger.info(f"Uploaded avatar to dedicated storage channel: {temp_msg.attachments[0].url}")
                return temp_msg.attachments[0].url
    except Exception as e:
        logger.warning(f"Dedicated channel avatar upload failed: {e}")

    # 2. 失敗時は現在のアクティブチャンネルを利用（emurate方式）
    if fallback_channel:
        try:
            d_file = discord.File(str(file_path), filename=filename)
            temp_msg = await fallback_channel.send(file=d_file)
            if temp_msg.attachments:
                url = temp_msg.attachments[0].url
                logger.info(f"Uploaded avatar via active channel fallback: {url}")
                try:
                    await temp_msg.delete()
                except Exception:
                    pass
                return url
        except Exception as e:
            logger.error(f"Active channel fallback avatar upload failed: {e}")

    return None


# Discordイベントハンドラ
@discord_client.event
async def on_ready():
    logger.info(f"[Altcord Bot] Logged in as {discord_client.user} (ID: {discord_client.user.id})")
    crawler.start()


@discord_client.event
async def on_message(message: discord.Message):
    # アバター保管用チャンネルのメッセージはチャット履歴への不要な同期を避ける
    if message.channel.id == AVATAR_STORAGE_CHANNEL_ID and message.author.id == discord_client.user.id:
        return

    serialized = serialize_discord_message(message)
    save_message_dict(serialized)
    await ws_manager.broadcast({
        "type": "new_message",
        "data": serialized
    })


@discord_client.event
async def on_message_edit(before: discord.Message, after: discord.Message):
    serialized = serialize_discord_message(after)
    save_message_dict(serialized)
    await ws_manager.broadcast({
        "type": "edit_message",
        "data": serialized
    })


@discord_client.event
async def on_message_delete(message: discord.Message):
    delete_cached_message(message.id)
    await ws_manager.broadcast({
        "type": "delete_message",
        "data": {
            "id": message.id,
            "channel_id": message.channel.id,
            "guild_id": message.guild.id if message.guild else 0
        }
    })

@discord_client.event
async def on_raw_reaction_add(payload: discord.RawReactionActionEvent):
    try:
        channel = discord_client.get_channel(payload.channel_id)
        if not channel:
            channel = await discord_client.fetch_channel(payload.channel_id)
        if channel:
            msg = await channel.fetch_message(payload.message_id)
            serialized = serialize_discord_message(msg)
            save_message_dict(serialized)
            await ws_manager.broadcast({
                "type": "reaction_update",
                "data": {
                    "message_id": msg.id,
                    "channel_id": msg.channel.id,
                    "guild_id": msg.guild.id if msg.guild else 0,
                    "reactions": serialized.get("reactions", [])
                }
            })
    except Exception as e:
        logger.debug(f"Reaction add sync error: {e}")


@discord_client.event
async def on_raw_reaction_remove(payload: discord.RawReactionActionEvent):
    try:
        channel = discord_client.get_channel(payload.channel_id)
        if not channel:
            channel = await discord_client.fetch_channel(payload.channel_id)
        if channel:
            msg = await channel.fetch_message(payload.message_id)
            serialized = serialize_discord_message(msg)
            save_message_dict(serialized)
            await ws_manager.broadcast({
                "type": "reaction_update",
                "data": {
                    "message_id": msg.id,
                    "channel_id": msg.channel.id,
                    "guild_id": msg.guild.id if msg.guild else 0,
                    "reactions": serialized.get("reactions", [])
                }
            })
    except Exception as e:
        logger.debug(f"Reaction remove sync error: {e}")



# 認証依存性
async def get_current_user(authorization: Optional[str] = Header(None)):
    if not authorization:
        raise HTTPException(status_code=401, detail="認証が必要です")
    token = authorization.replace("Bearer ", "").strip()
    user = get_user_by_session(token)
    if not user:
        raise HTTPException(status_code=401, detail="無効または期限切れのセッションです")
    return user


# ========================
# APIエンドポイント
# ========================

# 認証・ユーザー関連
@app.post("/api/auth/register")
async def api_register(
    username: str = Form(...),
    password: str = Form(...),
    nickname: Optional[str] = Form(""),
    avatar: Optional[UploadFile] = File(None)
):
    avatar_url = "/static/default_avatar.png"
    if avatar and avatar.filename:
        ext = Path(avatar.filename).suffix or ".png"
        saved_filename = f"avatar_{username}_{int(time.time()*1000)}{ext}"
        saved_path = UPLOADS_DIR / saved_filename
        with open(saved_path, "wb") as f:
            shutil.copyfileobj(avatar.file, f)
        avatar_url = f"/uploads/{saved_filename}"

        # 指定チャンネルへアップロードしてCDN URL取得
        cdn_url = await upload_image_to_discord_cdn(saved_path, saved_filename)
        if cdn_url:
            avatar_url = cdn_url

    user = create_user(username, password, nickname or username, avatar_url)
    if not user:
        raise HTTPException(status_code=400, detail="ユーザーIDが既に使用されているか、入力内容が無効です")
        
    token = authenticate_user(username, password)
    return {"status": "success", "token": token, "user": user}


@app.post("/api/auth/login")
async def api_login(
    username: str = Form(...),
    password: str = Form(...)
):
    token = authenticate_user(username, password)
    if not token:
        raise HTTPException(status_code=400, detail="ユーザーIDまたはパスワードが間違っています")
    user = get_user_by_session(token)
    return {"status": "success", "token": token, "user": user}


@app.get("/api/auth/me")
async def api_me(user: dict = Depends(get_current_user)):
    return {"status": "success", "user": user}


@app.post("/api/auth/profile")
async def api_update_profile(
    nickname: Optional[str] = Form(None),
    avatar: Optional[UploadFile] = File(None),
    user: dict = Depends(get_current_user)
):
    avatar_url = None
    if avatar and avatar.filename:
        ext = Path(avatar.filename).suffix or ".png"
        saved_filename = f"avatar_{user['id']}_{int(time.time()*1000)}{ext}"
        saved_path = UPLOADS_DIR / saved_filename
        with open(saved_path, "wb") as f:
            shutil.copyfileobj(avatar.file, f)
        avatar_url = f"/uploads/{saved_filename}"

        # 指定チャンネルへアップロードしてCDN URL取得
        cdn_url = await upload_image_to_discord_cdn(saved_path, saved_filename)
        if cdn_url:
            avatar_url = cdn_url

    updated = update_user_profile(user["id"], nickname=nickname, avatar_url=avatar_url)
    return {"status": "success", "user": updated}


HIDDEN_GUILD_IDS = {1503248181281030196}

# ギルド（サーバー）関連
@app.get("/api/guilds")
async def api_get_guilds(user: dict = Depends(get_current_user)):
    guilds_list = []
    for g in discord_client.guilds:
        # Bot用開発サーバー・保管用サーバーを一覧から非表示
        if g.id in HIDDEN_GUILD_IDS or ("bot" in g.name.lower() and "dev" in g.name.lower()):
            continue
        guilds_list.append({
            "id": str(g.id),
            "name": g.name,
            "icon_url": g.icon.url if g.icon else None,
            "member_count": g.member_count,
            "description": g.description or ""
        })
    return {"status": "success", "guilds": guilds_list}


@app.get("/api/guilds/{guild_id}/emojis")
async def api_get_emojis(guild_id: int, user: dict = Depends(get_current_user)):
    guild = discord_client.get_guild(guild_id)
    if not guild:
        raise HTTPException(status_code=404, detail="サーバーが見つかりません")
    emojis = []
    for e in guild.emojis:
        emojis.append({
            "id": str(e.id),
            "name": e.name,
            "animated": e.animated,
            "url": str(e.url)
        })
    return {"status": "success", "emojis": emojis}


@app.get("/api/guilds/{guild_id}/stickers")
async def api_get_stickers(guild_id: int, user: dict = Depends(get_current_user)):
    guild = discord_client.get_guild(guild_id)
    if not guild:
        raise HTTPException(status_code=404, detail="サーバーが見つかりません")
    stickers = []
    for s in guild.stickers:
        stickers.append({
            "id": str(s.id),
            "name": s.name,
            "format": str(s.format),
            "url": str(s.url) if hasattr(s, "url") else f"https://media.discordapp.net/stickers/{s.id}.png"
        })
    return {"status": "success", "stickers": stickers}


@app.get("/api/guilds/{guild_id}/sync")
async def api_get_guild_sync(
    guild_id: int,
    since_id: int = Query(0, ge=0),
    limit: int = Query(50, ge=1, le=200),
    user: dict = Depends(get_current_user)
):
    guild = discord_client.get_guild(guild_id)
    if not guild:
        raise HTTPException(status_code=404, detail="サーバーが見つかりません")

    messages = get_guild_recent_messages(guild_id, since_id=since_id, limit=limit)
    return {"status": "success", "messages": messages}


@app.get("/api/guilds/{guild_id}/channels")
async def api_get_channels(guild_id: int, user: dict = Depends(get_current_user)):
    guild = discord_client.get_guild(guild_id)
    if not guild:
        raise HTTPException(status_code=404, detail="サーバーが見つかりません")

    categories = []
    category_map = {}

    for cat in guild.categories:
        c_data = {
            "id": str(cat.id),
            "name": cat.name,
            "position": cat.position,
            "channels": []
        }
        categories.append(c_data)
        category_map[cat.id] = c_data

    uncategorized = {
        "id": "uncategorized",
        "name": "チャンネル",
        "position": -1,
        "channels": []
    }

    for ch in guild.channels:
        if isinstance(ch, discord.CategoryChannel):
            continue

        ch_type = "text"
        if isinstance(ch, discord.VoiceChannel):
            ch_type = "voice"
        elif isinstance(ch, discord.StageChannel):
            ch_type = "stage"
        elif isinstance(ch, discord.ForumChannel):
            ch_type = "forum"

        threads = []
        if hasattr(ch, "threads"):
            for thr in ch.threads:
                threads.append({
                    "id": str(thr.id),
                    "name": thr.name,
                    "parent_id": str(ch.id),
                    "is_thread": True,
                    "archived": thr.archived,
                    "message_count": thr.message_count
                })

        ch_data = {
            "id": str(ch.id),
            "name": ch.name,
            "type": ch_type,
            "topic": getattr(ch, "topic", "") or "",
            "position": ch.position,
            "threads": threads
        }

        if ch.category_id and ch.category_id in category_map:
            category_map[ch.category_id]["channels"].append(ch_data)
        else:
            uncategorized["channels"].append(ch_data)

    result_categories = []
    if uncategorized["channels"]:
        uncategorized["channels"].sort(key=lambda c: (1 if c["type"] == "voice" else 0, c["position"]))
        result_categories.append(uncategorized)

    for cat in sorted(categories, key=lambda c: c["position"]):
        cat["channels"].sort(key=lambda c: (1 if c["type"] == "voice" else 0, c["position"]))
        result_categories.append(cat)

    return {
        "status": "success",
        "guild": {
            "id": str(guild.id),
            "name": guild.name,
            "icon_url": guild.icon.url if guild.icon else None
        },
        "categories": result_categories
    }


@app.get("/api/guilds/{guild_id}/members")
async def api_get_members(guild_id: int, user: dict = Depends(get_current_user)):
    guild = discord_client.get_guild(guild_id)
    if not guild:
        raise HTTPException(status_code=404, detail="サーバーが見つかりません")

    hoisted_roles = [r for r in guild.roles if r.hoist]
    hoisted_roles.sort(key=lambda r: r.position, reverse=True)

    groups_dict = {}
    for r in hoisted_roles:
        groups_dict[r.id] = {
            "id": str(r.id),
            "name": r.name,
            "color": f"#{r.color.value:06x}" if r.color.value != 0 else "#99aab5",
            "position": r.position,
            "members": []
        }

    online_members = []
    offline_members = []

    for m in guild.members:
        member_hoist = None
        for r in hoisted_roles:
            if r in m.roles:
                member_hoist = r
                break

        role_color = f"#{m.color.value:06x}" if m.color and m.color.value != 0 else "#dbdee1"
        top_role_name = m.top_role.name if m.top_role and m.top_role.name != "@everyone" else None

        member_data = {
            "id": str(m.id),
            "username": m.name,
            "nickname": m.display_name,
            "avatar_url": m.display_avatar.url if m.display_avatar else None,
            "is_bot": m.bot,
            "status": str(m.status),
            "top_role": top_role_name,
            "role_color": role_color,
            "hoist_role_id": str(member_hoist.id) if member_hoist else None
        }

        if member_hoist:
            groups_dict[member_hoist.id]["members"].append(member_data)
        else:
            if m.status == discord.Status.offline:
                offline_members.append(member_data)
            else:
                online_members.append(member_data)

    status_order = {"online": 0, "idle": 1, "dnd": 2, "offline": 3}
    for g in groups_dict.values():
        g["members"].sort(key=lambda x: (status_order.get(x["status"], 4), x["nickname"].lower()))
    online_members.sort(key=lambda x: (status_order.get(x["status"], 4), x["nickname"].lower()))
    offline_members.sort(key=lambda x: x["nickname"].lower())

    result_groups = []
    for r in hoisted_roles:
        g = groups_dict[r.id]
        if g["members"]:
            result_groups.append(g)

    if online_members:
        result_groups.append({
            "id": "online",
            "name": "オンライン",
            "color": "#99aab5",
            "position": -1,
            "members": online_members
        })

    if offline_members:
        result_groups.append({
            "id": "offline",
            "name": "オフライン",
            "color": "#99aab5",
            "position": -2,
            "members": offline_members
        })

    return {"status": "success", "groups": result_groups}


# メッセージ履歴取得
@app.get("/api/channels/{channel_id}/messages")
async def api_get_messages(
    channel_id: int,
    before: Optional[int] = None,
    limit: int = 50,
    user: dict = Depends(get_current_user)
):
    cached = get_cached_messages(channel_id, before_id=before, limit=limit)
    if len(cached) >= limit:
        return {"status": "success", "messages": cached, "from_cache": True}

    channel = discord_client.get_channel(channel_id)
    if not channel:
        try:
            channel = await discord_client.fetch_channel(channel_id)
        except Exception:
            channel = None

    if channel and hasattr(channel, "history"):
        try:
            before_obj = discord.Object(id=before) if before else None
            fetched_msgs = [m async for m in channel.history(limit=limit, before=before_obj)]
            if fetched_msgs:
                serialized = [serialize_discord_message(m) for m in fetched_msgs]
                bulk_save_messages(serialized)
                cached = get_cached_messages(channel_id, before_id=before, limit=limit)
        except Exception as e:
            logger.error(f"Error fetching messages from Discord: {e}")

    return {"status": "success", "messages": cached, "from_cache": False}


# メッセージコンテキスト取得 (ジャンプ用: 前後メッセージ一括取得)
@app.get("/api/channels/{channel_id}/context/{message_id}")
async def api_get_message_context(
    channel_id: int,
    message_id: int,
    limit: int = 50,
    user: dict = Depends(get_current_user)
):
    cached = get_cached_messages_context(channel_id, message_id=message_id, limit=limit)
    if any(m["id"] == message_id for m in cached):
        return {"status": "success", "messages": cached, "target_id": message_id, "from_cache": True}

    channel = discord_client.get_channel(channel_id)
    if not channel:
        try:
            channel = await discord_client.fetch_channel(channel_id)
        except Exception:
            channel = None

    if channel and hasattr(channel, "history"):
        try:
            target_obj = discord.Object(id=message_id)
            fetched_msgs = [m async for m in channel.history(limit=limit, around=target_obj)]
            if fetched_msgs:
                serialized = [serialize_discord_message(m) for m in fetched_msgs]
                bulk_save_messages(serialized)
                cached = get_cached_messages_context(channel_id, message_id=message_id, limit=limit)
        except Exception as e:
            logger.error(f"Error fetching message context around {message_id}: {e}")

    return {"status": "success", "messages": cached, "target_id": message_id}


# ギルド全チャンネル新着メッセージ同期 (リアルタイムポーリング用)
@app.get("/api/guilds/{guild_id}/sync")
async def api_sync_guild_messages(
    guild_id: int,
    since_id: Optional[int] = 0,
    limit: int = 50,
    user: dict = Depends(get_current_user)
):
    recent = get_guild_recent_messages(guild_id, since_id=since_id or 0, limit=limit)
    return {"status": "success", "messages": recent, "guild_id": guild_id}



def evaluate_dice_commands(content: str) -> Optional[List[str]]:
    """Evaluates dice expressions like d20, 1d100, 2d6+3 found in content"""
    if not content:
        return None
    import random
    dice_pattern = r'\b(?:([0-9]{1,3})[dD]([0-9]{1,4})(?:([+-])([0-9]{1,4}))?|[dD]([0-9]{1,4}))\b'
    matches = list(re.finditer(dice_pattern, content))
    if not matches:
        return None

    results = []
    for m in matches[:5]:
        if m.group(5):
            num = 1
            sides = int(m.group(5))
            op, mod = None, 0
        else:
            num = int(m.group(1)) if m.group(1) else 1
            sides = int(m.group(2))
            op = m.group(3)
            mod = int(m.group(4)) if m.group(4) else 0

        if sides <= 0 or num <= 0 or num > 100 or sides > 10000:
            continue

        rolls = [random.randint(1, sides) for _ in range(num)]
        raw_sum = sum(rolls)
        if op == '+':
            total = raw_sum + mod
            mod_str = f"+{mod}"
        elif op == '-':
            total = raw_sum - mod
            mod_str = f"-{mod}"
        else:
            total = raw_sum
            mod_str = ""

        roll_str = f"[{', '.join(map(str, rolls))}]" if num > 1 else f"[{rolls[0]}]"
        results.append(f"🎲 **{m.group(0)}**: {roll_str}{mod_str} = **{total}**")

    return results if results else None


# メッセージ送信
@app.post("/api/channels/{channel_id}/messages")
async def api_send_message(
    channel_id: int,
    content: Optional[str] = Form(""),
    reply_to_id: Optional[int] = Form(None),
    files: List[UploadFile] = File([]),
    user: dict = Depends(get_current_user)
):
    channel = discord_client.get_channel(channel_id)
    if not channel:
        try:
            channel = await discord_client.fetch_channel(channel_id)
        except Exception:
            raise HTTPException(status_code=404, detail="チャンネルが見つかりません")

    guild_id = channel.guild.id if hasattr(channel, "guild") and channel.guild else 0

    # リプライ処理: 冒頭にメッセージリンクを付加
    final_content = content or ""
    if reply_to_id and guild_id:
        msg_link = f"https://discord.com/channels/{guild_id}/{channel_id}/{reply_to_id}"
        if final_content:
            final_content = f"{msg_link}\n{final_content}"
        else:
            final_content = msg_link

    discord_files = []
    temp_saved_files = []
    try:
        for f in files:
            if f.filename:
                temp_path = UPLOADS_DIR / f"temp_{int(time.time()*1000)}_{f.filename}"
                with open(temp_path, "wb") as buffer:
                    shutil.copyfileobj(f.file, buffer)
                temp_saved_files.append(temp_path)
                discord_files.append(discord.File(str(temp_path), filename=f.filename))

        if not final_content and not discord_files:
            raise HTTPException(status_code=400, detail="メッセージ本文またはファイルを添付してください")

        webhook, thread = await get_channel_webhook(channel)

        # WebhookアバターURLの整形 & 必要に応じて専用チャンネルへアップロード
        avatar_url = user.get("avatar_url")
        if avatar_url:
            if avatar_url.startswith("/uploads/"):
                local_file = UPLOADS_DIR / Path(avatar_url).name
                if local_file.exists():
                    try:
                        with open(local_file, "rb") as af:
                            avatar_bytes = af.read()
                        await webhook.edit(avatar=avatar_bytes)
                    except Exception as we:
                        logger.warning(f"Webhook avatar edit note: {we}")

                    cdn_url = await upload_image_to_discord_cdn(local_file, local_file.name, fallback_channel=channel)
                    if cdn_url:
                        avatar_url = cdn_url
                        update_user_profile(user["id"], avatar_url=cdn_url)
                    else:
                        avatar_url = None
            elif not avatar_url.startswith("http"):
                avatar_url = None

        raw_name = user.get("nickname") or user.get("id")
        web_username = raw_name if str(raw_name).startswith("🔷 ") else f"🔷 {raw_name}"

        kwargs = {
            "content": final_content if final_content else None,
            "username": web_username,
            "allowed_mentions": discord.AllowedMentions.none(),
            "files": discord_files
        }
        if avatar_url:
            kwargs["avatar_url"] = avatar_url
        if thread is not None:
            kwargs["thread"] = thread

        sent_msg = await webhook.send(**kwargs, wait=True)
        serialized = serialize_discord_message(sent_msg)
        # Webhook message avatar fallback fix
        if avatar_url and (not serialized.get("author_avatar") or "default_avatar" in str(serialized.get("author_avatar"))):
            serialized["author_avatar"] = avatar_url
        save_message_dict(serialized)

        # ダイス等のBotトリガーを検出・自動実行してチャンネルへ返答
        if content:
            dice_results = evaluate_dice_commands(content)
            if dice_results:
                dice_text = "\n".join(dice_results)
                try:
                    dice_embed = discord.Embed(
                        description=dice_text,
                        color=0x5865f2
                    )
                    dice_embed.set_author(
                        name=f"{user.get('nickname') or user.get('id')} のダイス結果",
                        icon_url=avatar_url if avatar_url and avatar_url.startswith("http") else "https://cdn.discordapp.com/embed/avatars/0.png"
                    )
                    
                    dice_kwargs = {
                        "embed": dice_embed,
                        "username": "Dice Bot",
                        "avatar_url": "https://cdn.discordapp.com/embed/avatars/2.png"
                    }
                    if thread is not None:
                        dice_kwargs["thread"] = thread

                    dice_msg = await webhook.send(**dice_kwargs, wait=True)
                    dice_serialized = serialize_discord_message(dice_msg)
                    save_message_dict(dice_serialized)
                    await ws_manager.broadcast({
                        "type": "new_message",
                        "data": dice_serialized
                    })
                except Exception as de:
                    logger.warning(f"Failed to send dice response: {de}")

        return {"status": "success", "message": serialized}
    except Exception as e:
        logger.error(f"Failed to send webhook message: {e}")
        raise HTTPException(status_code=500, detail=f"メッセージの送信に失敗しました: {str(e)}")
    finally:
        for p in temp_saved_files:
            try:
                if p.exists():
                    p.unlink()
            except Exception:
                pass


# メッセージ削除 (Webから送信したメッセージ / チャンネル内のメッセージ)
@app.delete("/api/channels/{channel_id}/messages/{message_id}")
async def api_delete_message(
    channel_id: int,
    message_id: int,
    user: dict = Depends(get_current_user)
):
    channel = discord_client.get_channel(channel_id)
    if not channel:
        try:
            channel = await discord_client.fetch_channel(channel_id)
        except Exception:
            channel = None

    # 1. Webhook 経由での削除を試行 (Webhook送信メッセージを確実に消去)
    if channel and hasattr(channel, "guild") and channel.guild:
        try:
            webhook = await get_or_create_webhook(channel)
            await webhook.delete_message(message_id)
        except Exception:
            pass

    # 2. ボット直接の削除を試行
    if channel:
        try:
            msg = await channel.fetch_message(message_id)
            await msg.delete()
        except Exception:
            pass

    # 3. ローカルキャッシュからは確実に削除
    delete_cached_message(message_id)

    # 4. 全クライアントに削除イベントをブロードキャスト
    guild_id = channel.guild.id if channel and hasattr(channel, "guild") and channel.guild else 0
    await ws_manager.broadcast({
        "type": "delete_message",
        "data": {
            "id": message_id,
            "channel_id": channel_id,
            "guild_id": guild_id
        }
    })
    return {"status": "success"}


# 改良検索API
@app.get("/api/guilds/{guild_id}/search")
async def api_guild_search(
    guild_id: int,
    q: str = Query(...),
    channel_id: Optional[int] = Query(None),
    limit: int = Query(25, ge=1, le=100),
    offset: int = Query(0, ge=0),
    user: dict = Depends(get_current_user)
):
    result = execute_search(guild_id=guild_id, query_str=q, channel_id=channel_id, limit=limit, offset=offset)
    return {"status": "success", "result": result}



# WebSocket
@app.websocket("/ws")
async def websocket_endpoint(websocket: WebSocket, token: Optional[str] = Query(None)):
    await ws_manager.connect(websocket)
    try:
        while True:
            data = await websocket.receive_text()
            try:
                msg = json.loads(data)
                if msg.get("type") == "ping":
                    await websocket.send_json({"type": "pong"})
            except Exception:
                pass
    except WebSocketDisconnect:
        ws_manager.disconnect(websocket)
    except Exception:
        ws_manager.disconnect(websocket)



# SSE (Server-Sent Events) エンドポイント
# xsrv.jp等、WebSocketをプロキシできない共有ホスティング環境向けフォールバック
@app.get("/api/events")
async def sse_events(
    request: Request,
    authorization: Optional[str] = Header(None),
    token: Optional[str] = Query(None)
):
    actual_token = None
    if authorization:
        actual_token = authorization.replace("Bearer ", "").strip()
    elif token:
        actual_token = token.strip()

    if not actual_token or not get_user_by_session(actual_token):
        raise HTTPException(status_code=401, detail="認証が必要です")

    queue = ws_manager.add_sse_client()

    async def event_generator():
        try:
            while True:
                if await request.is_disconnected():
                    break
                try:
                    msg = await asyncio.wait_for(queue.get(), timeout=25.0)
                    yield f"data: {json.dumps(msg)}\n\n"
                except asyncio.TimeoutError:
                    # heartbeat to keep connection alive
                    yield ": heartbeat\n\n"
        finally:
            ws_manager.remove_sse_client(queue)

    return StreamingResponse(
        event_generator(),
        media_type="text/event-stream",
        headers={
            "Cache-Control": "no-cache",
            "X-Accel-Buffering": "no",  # disable nginx/Apache buffering
        },
    )

# 静的ファイル配信
STATIC_DIR = DB_DIR / "static"
STATIC_DIR.mkdir(parents=True, exist_ok=True)
app.mount("/static", StaticFiles(directory=str(STATIC_DIR)), name="static")
app.mount("/uploads", StaticFiles(directory=str(UPLOADS_DIR)), name="uploads")

@app.get("/", response_class=HTMLResponse)
async def serve_index():
    index_file = STATIC_DIR / "index.html"
    if index_file.exists():
        return FileResponse(str(index_file))
    return HTMLResponse("<h1>Altcord is ready. Frontend loading...</h1>")


def run_server():
    import uvicorn
    uvicorn.run(app, host="0.0.0.0", port=8000, log_level="info")


async def run_discord_bot():
    """
    discord_client.start() は接続が確立した後の切断/再接続は内部で
    自動リトライしてくれるが、ログイン自体が失敗した場合
    (discord.LoginFailure) は例外を送出する。これを asyncio.gather に
    そのまま投げると Web API 側 (server.serve()) まで巻き込んで
    落ちてしまうため、ここで個別に捕捉してループさせる。
    """
    while True:
        try:
            await discord_client.start(TOKEN)
            # start() が正常終了 (client.close() 等) した場合はループを抜ける
            break
        except discord.LoginFailure:
            logger.error(
                "Discordへのログインに失敗しました。ALTCORD_BOT_TOKEN が無効か、"
                "失効(再発行)されている可能性があります。.env のトークンを確認してください。"
                " Web API 自体は動作を継続します。"
            )
            break
        except Exception as e:
            logger.error(f"Discordクライアントで予期しないエラーが発生しました: {e}. 10秒後に再接続を試みます。")
            await asyncio.sleep(10)


async def main():
    import uvicorn
    config = uvicorn.Config(app, host="0.0.0.0", port=8000, log_level="info")
    server = uvicorn.Server(config)

    await asyncio.gather(
        run_discord_bot(),
        server.serve()
    )

if __name__ == "__main__":
    asyncio.run(main())
