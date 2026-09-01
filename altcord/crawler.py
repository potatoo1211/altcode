import asyncio
import logging
from typing import Optional
import discord
from .database import (
    get_channel_crawl_state,
    update_channel_crawl_state,
    bulk_save_messages,
    get_db
)

logger = logging.getLogger("altcord.crawler")


def serialize_discord_message(msg: discord.Message) -> dict:
    attachments = []
    for a in msg.attachments:
        attachments.append({
            "id": a.id,
            "filename": a.filename,
            "url": a.url,
            "proxy_url": a.proxy_url,
            "size": a.size,
            "content_type": a.content_type,
            "width": a.width,
            "height": a.height
        })
        
    embeds = []
    for e in msg.embeds:
        embeds.append(e.to_dict())

    reply_to_id = None
    if msg.reference and msg.reference.message_id:
        reply_to_id = msg.reference.message_id
    elif msg.content:
        import re
        link_match = re.search(r"https?://(?:ptb\.|canary\.)?discord(?:app)?\.com/channels/(?:\d+|@me)/\d+/(\d+)", msg.content)
        if link_match:
            try:
                reply_to_id = int(link_match.group(1))
            except ValueError:
                pass

    author_color = None
    if msg.guild:
        mem = msg.guild.get_member(msg.author.id)
        if mem and mem.color and mem.color.value != 0:
            author_color = f"#{mem.color.value:06x}"

    stickers = []
    if hasattr(msg, "stickers") and msg.stickers:
        for s in msg.stickers:
            stickers.append({
                "id": str(s.id),
                "name": s.name,
                "format": str(getattr(s, "format", "png")),
                "url": s.url
            })
    elif hasattr(msg, "sticker_items") and msg.sticker_items:
        for s in msg.sticker_items:
            stickers.append({
                "id": str(s.id),
                "name": s.name,
                "format": str(getattr(s, "format_type", "png")),
                "url": s.url
            })


    reactions = []
    if hasattr(msg, "reactions") and msg.reactions:
        for r in msg.reactions:
            em = r.emoji
            if isinstance(em, (discord.Emoji, discord.PartialEmoji)):
                emoji_data = {
                    "id": str(em.id),
                    "name": em.name,
                    "animated": getattr(em, "animated", False),
                    "url": str(em.url) if getattr(em, "url", None) else f"https://cdn.discordapp.com/emojis/{em.id}.png",
                    "is_custom": True
                }
            else:
                emoji_data = {
                    "id": None,
                    "name": str(em),
                    "animated": False,
                    "url": None,
                    "is_custom": False
                }
            reactions.append({
                "emoji": emoji_data,
                "count": r.count,
                "me": getattr(r, "me", False)
            })

    return {
        "id": msg.id,
        "guild_id": msg.guild.id if msg.guild else 0,
        "channel_id": msg.channel.id,
        "author_id": msg.author.id,
        "author_name": msg.author.display_name or msg.author.name,
        "author_avatar": msg.author.display_avatar.url if msg.author.display_avatar else None,
        "author_color": author_color,
        "is_bot": msg.author.bot,
        "content": msg.content or "",
        "attachments": attachments,
        "embeds": embeds,
        "stickers": stickers,
        "reactions": reactions,
        "reply_to_id": reply_to_id,
        "created_at": msg.created_at.timestamp(),
        "edited_at": msg.edited_at.timestamp() if msg.edited_at else None,
        "is_pinned": msg.pinned
    }


class MessageCrawler:
    def __init__(self, client: discord.Client):
        self.client = client
        self.is_running = False
        self.task: Optional[asyncio.Task] = None
        self._pause_event = asyncio.Event()
        self._pause_event.set()

    def start(self):
        if not self.is_running:
            self.is_running = True
            self.task = asyncio.create_task(self._crawl_loop())
            logger.info("Message crawler started.")

    def stop(self):
        self.is_running = False
        if self.task:
            self.task.cancel()

    async def _crawl_loop(self):
        await self.client.wait_until_ready()
        logger.info("Crawler initialized after bot ready.")

        while self.is_running:
            try:
                for guild in self.client.guilds:
                    if not self.is_running:
                        break

                    channels_to_crawl = []
                    for channel in guild.text_channels:
                        channels_to_crawl.append(channel)
                        for thread in channel.threads:
                            channels_to_crawl.append(thread)

                    for channel in channels_to_crawl:
                        if not self.is_running:
                            break

                        # 権限チェック
                        perms = channel.permissions_for(guild.me)
                        if not perms.read_messages or not perms.read_message_history:
                            continue

                        await self._crawl_channel(channel)
                        # 各チャンネル処理間に少しウェイト
                        await asyncio.sleep(0.5)

                # 全ギルドの走査完了後、5分待機して再度新しい投稿や未取得分を巡回
                await asyncio.sleep(300)
            except asyncio.CancelledError:
                break
            except Exception as e:
                logger.error(f"Error in crawler loop: {e}")
                await asyncio.sleep(10)

    async def _crawl_channel(self, channel: discord.abc.Messageable):
        state = get_channel_crawl_state(channel.id)
        if state and state.get("is_completed"):
            return

        oldest_id = state.get("oldest_message_id") if state else None

        # 巡回実行
        batch_limit = 100
        consecutive_empty = 0

        while self.is_running:
            try:
                before_obj = discord.Object(id=oldest_id) if oldest_id else None
                messages = [m async for m in channel.history(limit=batch_limit, before=before_obj)]

                if not messages:
                    # 過去ログ走査終了
                    update_channel_crawl_state(
                        channel_id=channel.id,
                        guild_id=channel.guild.id,
                        oldest_id=oldest_id,
                        newest_id=None,
                        is_completed=True
                    )
                    break

                serialized = [serialize_discord_message(m) for m in messages]
                bulk_save_messages(serialized)

                oldest_id = messages[-1].id
                update_channel_crawl_state(
                    channel_id=channel.id,
                    guild_id=channel.guild.id,
                    oldest_id=oldest_id,
                    newest_id=messages[0].id,
                    is_completed=False
                )

                if len(messages) < batch_limit:
                    # これ以上過去ログなし
                    update_channel_crawl_state(
                        channel_id=channel.id,
                        guild_id=channel.guild.id,
                        oldest_id=oldest_id,
                        newest_id=None,
                        is_completed=True
                    )
                    break

                # レートリミット回避の適切なインターバル (0.6秒)
                await asyncio.sleep(0.6)
            except discord.Forbidden:
                break
            except discord.HTTPException as e:
                if e.status == 429:
                    retry_after = getattr(e, "retry_after", 5.0)
                    await asyncio.sleep(retry_after)
                else:
                    break
            except Exception as e:
                logger.error(f"Error crawling channel {channel.id}: {e}")
                break
