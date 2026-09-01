import os
import sqlite3
import json
import time
import hashlib
import secrets
import contextlib
from pathlib import Path
from typing import Optional, List, Dict, Any

DB_DIR = Path(__file__).resolve().parent
DB_PATH = DB_DIR / "altcord.db"
UPLOADS_DIR = DB_DIR / "uploads"
UPLOADS_DIR.mkdir(parents=True, exist_ok=True)


@contextlib.contextmanager
def get_db():
    """
    sqlite3.Connection を `with` で使うと commit/rollback はされるが
    接続自体はクローズされない（sqlite3 の仕様）。このため、これまでは
    get_db() を呼ぶたびに新しい接続とファイルディスクリプタが残り続けていた。
    ここではコンテキストマネージャ化し、ブロックを抜けるときに確実に
    close() されるようにする。呼び出し側の `with get_db() as conn:` という
    書き方はそのまま変更不要。
    """
    conn = sqlite3.connect(str(DB_PATH), check_same_thread=False)
    conn.row_factory = sqlite3.Row
    conn.execute("PRAGMA journal_mode = WAL;")
    conn.execute("PRAGMA synchronous = NORMAL;")
    try:
        yield conn
        conn.commit()
    except Exception:
        conn.rollback()
        raise
    finally:
        conn.close()


def hash_password(password: str) -> str:
    salt = secrets.token_hex(16)
    hashed = hashlib.sha256((salt + password).encode("utf-8")).hexdigest()
    return f"{salt}:{hashed}"


def verify_password(password: str, stored_hash: str) -> bool:
    if ":" not in stored_hash:
        return False
    salt, hashed = stored_hash.split(":", 1)
    check_hash = hashlib.sha256((salt + password).encode("utf-8")).hexdigest()
    return check_hash == hashed


def init_db():
    with get_db() as conn:
        cursor = conn.cursor()
        
        # ユーザーテーブル
        cursor.execute("""
            CREATE TABLE IF NOT EXISTS users (
                id TEXT PRIMARY KEY,
                password_hash TEXT NOT NULL,
                nickname TEXT NOT NULL,
                avatar_url TEXT NOT NULL,
                created_at REAL NOT NULL
            );
        """)
        
        # セッションテーブル
        cursor.execute("""
            CREATE TABLE IF NOT EXISTS sessions (
                token TEXT PRIMARY KEY,
                user_id TEXT NOT NULL,
                expires_at REAL NOT NULL,
                FOREIGN KEY (user_id) REFERENCES users (id) ON DELETE CASCADE
            );
        """)
        
        # メッセージキャッシュテーブル（軽量かつ高速）
        cursor.execute("""
            CREATE TABLE IF NOT EXISTS messages (
                id INTEGER PRIMARY KEY,
                guild_id INTEGER NOT NULL,
                channel_id INTEGER NOT NULL,
                author_id INTEGER NOT NULL,
                author_name TEXT NOT NULL,
                author_avatar TEXT,
                is_bot INTEGER DEFAULT 0,
                content TEXT DEFAULT '',
                attachments_json TEXT DEFAULT '[]',
                embeds_json TEXT DEFAULT '[]',
                reply_to_id INTEGER DEFAULT NULL,
                created_at REAL NOT NULL,
                edited_at REAL DEFAULT NULL,
                is_pinned INTEGER DEFAULT 0
            );
        """)
        
        # チャンネル巡回状態テーブル
        cursor.execute("""
            CREATE TABLE IF NOT EXISTS channel_crawl_state (
                channel_id INTEGER PRIMARY KEY,
                guild_id INTEGER NOT NULL,
                oldest_message_id INTEGER,
                newest_message_id INTEGER,
                is_completed INTEGER DEFAULT 0,
                last_crawled_at REAL DEFAULT 0
            );
        """)
        
        # 高速クエリ用インデックス
        cursor.execute("CREATE INDEX IF NOT EXISTS idx_msg_channel ON messages(channel_id, id DESC);")
        cursor.execute("CREATE INDEX IF NOT EXISTS idx_msg_guild ON messages(guild_id, created_at DESC);")
        cursor.execute("CREATE INDEX IF NOT EXISTS idx_msg_author ON messages(author_name);")
        cursor.execute("CREATE INDEX IF NOT EXISTS idx_msg_created ON messages(created_at DESC);")

        # stickers_json / reactions_json カラムの追加（後方互換マイグレーション）
        cursor.execute("PRAGMA table_info(messages);")
        cols = [col[1] for col in cursor.fetchall()]
        if "stickers_json" not in cols:
            try:
                cursor.execute("ALTER TABLE messages ADD COLUMN stickers_json TEXT DEFAULT '[]';")
            except Exception:
                pass
        if "reactions_json" not in cols:
            try:
                cursor.execute("ALTER TABLE messages ADD COLUMN reactions_json TEXT DEFAULT '[]';")
            except Exception:
                pass

        conn.commit()


# ユーザー認証関連
def create_user(username: str, password: str, nickname: str, avatar_url: str) -> Optional[Dict[str, Any]]:
    username = username.strip()
    nickname = nickname.strip() or username
    if not username or not password:
        return None
    
    pwd_hash = hash_password(password)
    now = time.time()
    
    with get_db() as conn:
        cursor = conn.cursor()
        try:
            cursor.execute(
                "INSERT INTO users (id, password_hash, nickname, avatar_url, created_at) VALUES (?, ?, ?, ?, ?)",
                (username, pwd_hash, nickname, avatar_url, now)
            )
            conn.commit()
            return {"id": username, "nickname": nickname, "avatar_url": avatar_url, "created_at": now}
        except sqlite3.IntegrityError:
            return None


def authenticate_user(username: str, password: str) -> Optional[str]:
    username = username.strip()
    with get_db() as conn:
        cursor = conn.cursor()
        cursor.execute("SELECT password_hash FROM users WHERE id = ?", (username,))
        row = cursor.fetchone()
        if not row or not verify_password(password, row["password_hash"]):
            return None
        
        token = secrets.token_urlsafe(32)
        expires_at = time.time() + (86400 * 30)  # 30 days
        cursor.execute(
            "INSERT INTO sessions (token, user_id, expires_at) VALUES (?, ?, ?)",
            (token, username, expires_at)
        )
        conn.commit()
        return token


def get_user_by_session(token: str) -> Optional[Dict[str, Any]]:
    if not token:
        return None
    now = time.time()
    with get_db() as conn:
        cursor = conn.cursor()
        cursor.execute("""
            SELECT u.id, u.nickname, u.avatar_url, u.created_at
            FROM sessions s
            JOIN users u ON s.user_id = u.id
            WHERE s.token = ? AND s.expires_at > ?
        """, (token, now))
        row = cursor.fetchone()
        if row:
            return dict(row)
        return None


def update_user_profile(user_id: str, nickname: Optional[str] = None, avatar_url: Optional[str] = None) -> Optional[Dict[str, Any]]:
    with get_db() as conn:
        cursor = conn.cursor()
        updates = []
        params = []
        if nickname is not None:
            updates.append("nickname = ?")
            params.append(nickname.strip() or user_id)
        if avatar_url is not None:
            updates.append("avatar_url = ?")
            params.append(avatar_url)
        
        if not updates:
            return None
            
        params.append(user_id)
        cursor.execute(f"UPDATE users SET {', '.join(updates)} WHERE id = ?", tuple(params))
        conn.commit()
        
        cursor.execute("SELECT id, nickname, avatar_url, created_at FROM users WHERE id = ?", (user_id,))
        row = cursor.fetchone()
        return dict(row) if row else None


# メッセージキャッシュ関連
def save_message_dict(msg_dict: Dict[str, Any]) -> None:
    with get_db() as conn:
        cursor = conn.cursor()
        cursor.execute("""
            INSERT OR REPLACE INTO messages (
                id, guild_id, channel_id, author_id, author_name, author_avatar, is_bot,
                content, attachments_json, embeds_json, stickers_json, reactions_json, reply_to_id, created_at, edited_at, is_pinned
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        """, (
            msg_dict["id"],
            msg_dict["guild_id"],
            msg_dict["channel_id"],
            msg_dict["author_id"],
            msg_dict["author_name"],
            msg_dict.get("author_avatar"),
            1 if msg_dict.get("is_bot") else 0,
            msg_dict.get("content", ""),
            json.dumps(msg_dict.get("attachments", []), ensure_ascii=False),
            json.dumps(msg_dict.get("embeds", []), ensure_ascii=False),
            json.dumps(msg_dict.get("stickers", []), ensure_ascii=False),
            json.dumps(msg_dict.get("reactions", []), ensure_ascii=False),
            msg_dict.get("reply_to_id"),
            msg_dict["created_at"],
            msg_dict.get("edited_at"),
            1 if msg_dict.get("is_pinned") else 0
        ))
        conn.commit()


def bulk_save_messages(messages_list: List[Dict[str, Any]]) -> None:
    if not messages_list:
        return
    with get_db() as conn:
        cursor = conn.cursor()
        cursor.executemany("""
            INSERT OR REPLACE INTO messages (
                id, guild_id, channel_id, author_id, author_name, author_avatar, is_bot,
                content, attachments_json, embeds_json, stickers_json, reactions_json, reply_to_id, created_at, edited_at, is_pinned
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        """, [
            (
                m["id"],
                m["guild_id"],
                m["channel_id"],
                m["author_id"],
                m["author_name"],
                m.get("author_avatar"),
                1 if m.get("is_bot") else 0,
                m.get("content", ""),
                json.dumps(m.get("attachments", []), ensure_ascii=False),
                json.dumps(m.get("embeds", []), ensure_ascii=False),
                json.dumps(m.get("stickers", []), ensure_ascii=False),
                json.dumps(m.get("reactions", []), ensure_ascii=False),
                m.get("reply_to_id"),
                m["created_at"],
                m.get("edited_at"),
                1 if m.get("is_pinned") else 0
            ) for m in messages_list
        ])
        conn.commit()


def get_cached_messages(channel_id: int, before_id: Optional[int] = None, limit: int = 50) -> List[Dict[str, Any]]:
    with get_db() as conn:
        cursor = conn.cursor()
        if before_id:
            cursor.execute("""
                SELECT * FROM messages
                WHERE channel_id = ? AND id < ?
                ORDER BY id DESC LIMIT ?
            """, (channel_id, before_id, limit))
        else:
            cursor.execute("""
                SELECT * FROM messages
                WHERE channel_id = ?
                ORDER BY id DESC LIMIT ?
            """, (channel_id, limit))
        
        rows = cursor.fetchall()
        result = []
        for r in reversed(rows):
            d = dict(r)
            d["attachments"] = json.loads(d["attachments_json"]) if d.get("attachments_json") else []
            d["embeds"] = json.loads(d["embeds_json"]) if d.get("embeds_json") else []
            d["stickers"] = json.loads(d["stickers_json"]) if d.get("stickers_json") else []
            d["reactions"] = json.loads(d["reactions_json"]) if d.get("reactions_json") else []
            if "attachments_json" in d: del d["attachments_json"]
            if "embeds_json" in d: del d["embeds_json"]
            if "stickers_json" in d: del d["stickers_json"]
            if "reactions_json" in d: del d["reactions_json"]
            result.append(d)
        return result


def delete_cached_message(message_id: int) -> None:
    with get_db() as conn:
        cursor = conn.cursor()
        cursor.execute("DELETE FROM messages WHERE id = ?", (message_id,))
        conn.commit()


def update_cached_message_content(message_id: int, content: str, edited_at: float) -> None:
    with get_db() as conn:
        cursor = conn.cursor()
        cursor.execute("UPDATE messages SET content = ?, edited_at = ? WHERE id = ?", (content, edited_at, message_id))
        conn.commit()


# 巡回状態
def get_channel_crawl_state(channel_id: int) -> Optional[Dict[str, Any]]:
    with get_db() as conn:
        cursor = conn.cursor()
        cursor.execute("SELECT * FROM channel_crawl_state WHERE channel_id = ?", (channel_id,))
        row = cursor.fetchone()
        return dict(row) if row else None


def update_channel_crawl_state(channel_id: int, guild_id: int, oldest_id: Optional[int], newest_id: Optional[int], is_completed: bool) -> None:
    with get_db() as conn:
        cursor = conn.cursor()
        now = time.time()
        cursor.execute("""
            INSERT INTO channel_crawl_state (channel_id, guild_id, oldest_message_id, newest_message_id, is_completed, last_crawled_at)
            VALUES (?, ?, ?, ?, ?, ?)
            ON CONFLICT(channel_id) DO UPDATE SET
                oldest_message_id = COALESCE(?, oldest_message_id),
                newest_message_id = COALESCE(?, newest_message_id),
                is_completed = ?,
                last_crawled_at = ?
        """, (channel_id, guild_id, oldest_id, newest_id, 1 if is_completed else 0, now, oldest_id, newest_id, 1 if is_completed else 0, now))
        conn.commit()


init_db()


def get_cached_messages_context(channel_id: int, message_id: int, limit: int = 50) -> List[Dict[str, Any]]:
    """指定したメッセージの前後(過去と未来)を合わせて limit 件取得"""
    half = limit // 2
    with get_db() as conn:
        cursor = conn.cursor()
        # 過去側 (message_id 以前)
        cursor.execute("""
            SELECT * FROM messages
            WHERE channel_id = ? AND id <= ?
            ORDER BY id DESC LIMIT ?
        """, (channel_id, message_id, half + 1))
        past_rows = cursor.fetchall()

        # 未来側 (message_id より新しい)
        cursor.execute("""
            SELECT * FROM messages
            WHERE channel_id = ? AND id > ?
            ORDER BY id ASC LIMIT ?
        """, (channel_id, message_id, half))
        future_rows = cursor.fetchall()

        all_rows = list(reversed(past_rows)) + list(future_rows)
        # 重複削除
        seen_ids = set()
        unique_rows = []
        for r in all_rows:
            if r["id"] not in seen_ids:
                seen_ids.add(r["id"])
                unique_rows.append(r)

        result = []
        for r in unique_rows:
            d = dict(r)
            d["attachments"] = json.loads(d["attachments_json"]) if d.get("attachments_json") else []
            d["embeds"] = json.loads(d["embeds_json"]) if d.get("embeds_json") else []
            d["stickers"] = json.loads(d["stickers_json"]) if d.get("stickers_json") else []
            d["reactions"] = json.loads(d["reactions_json"]) if d.get("reactions_json") else []
            if "attachments_json" in d: del d["attachments_json"]
            if "embeds_json" in d: del d["embeds_json"]
            if "stickers_json" in d: del d["stickers_json"]
            if "reactions_json" in d: del d["reactions_json"]
            result.append(d)
        return result


def get_guild_recent_messages(guild_id: int, since_id: int = 0, limit: int = 50) -> List[Dict[str, Any]]:
    """ギルド全体の全チャンネル新着メッセージを一括取得 (ポーリング用)"""
    with get_db() as conn:
        cursor = conn.cursor()
        if since_id > 0:
            cursor.execute("""
                SELECT * FROM messages
                WHERE guild_id = ? AND id > ?
                ORDER BY id ASC LIMIT ?
            """, (guild_id, since_id, limit))
        else:
            cursor.execute("""
                SELECT * FROM messages
                WHERE guild_id = ?
                ORDER BY id DESC LIMIT ?
            """, (guild_id, limit))
        
        rows = cursor.fetchall()
        result = []
        for r in (rows if since_id > 0 else reversed(rows)):
            d = dict(r)
            d["attachments"] = json.loads(d["attachments_json"]) if d.get("attachments_json") else []
            d["embeds"] = json.loads(d["embeds_json"]) if d.get("embeds_json") else []
            d["stickers"] = json.loads(d["stickers_json"]) if d.get("stickers_json") else []
            d["reactions"] = json.loads(d["reactions_json"]) if d.get("reactions_json") else []
            if "attachments_json" in d: del d["attachments_json"]
            if "embeds_json" in d: del d["embeds_json"]
            if "stickers_json" in d: del d["stickers_json"]
            if "reactions_json" in d: del d["reactions_json"]
            result.append(d)
        return result
