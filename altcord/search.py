import re
import json
import datetime
from typing import List, Dict, Any, Tuple, Optional
from .database import get_db


def parse_search_query(query_str: str) -> Dict[str, Any]:
    """
    Parses Discord-style search queries:
    - "exact phrase" -> exact matching
    - normal words -> substring partial matching
    - from:username / from:"user name" / from:@user / from:id
    - has:image, has:video, has:file, has:link, has:embed
    - in:channel_id / in:channel_name / in:"channel name" / in:#channel
    - before:YYYY-MM-DD, after:YYYY-MM-DD, during:YYYY-MM-DD, to:YYYY-MM-DD
    """
    parsed = {
        "exact_phrases": [],
        "plain_terms": [],
        "from_user": [],
        "has_filters": [],
        "in_channels": [],
        "before_ts": None,
        "after_ts": None,
        "during_range": None
    }
    
    # フィルタ正規表現: key:"value" または key:value
    filter_pattern = r'\b(from|in|has|before|after|during|to):(?:"([^"]+)"|\'([^\']+)\'|(\S+))'
    
    def handle_filter(match):
        prefix = match.group(1).lower()
        val = match.group(2) or match.group(3) or match.group(4) or ""
        val = val.strip()
        if not val:
            return ""
        
        if prefix == "from":
            clean_user = re.sub(r'^[🚩⬜✅🔷@\s]+', '', val).strip()
            if clean_user:
                parsed["from_user"].append(clean_user)
            elif val:
                parsed["from_user"].append(val)
        elif prefix == "in":
            clean_ch = re.sub(r'^[#\s]+', '', val).strip()
            if clean_ch:
                parsed["in_channels"].append(clean_ch)
            elif val:
                parsed["in_channels"].append(val)
        elif prefix == "has":
            parsed["has_filters"].append(val.lower())
        elif prefix in ("before", "to"):
            try:
                dt = datetime.datetime.strptime(val, "%Y-%m-%d")
                parsed["before_ts"] = dt.timestamp()
            except ValueError:
                pass
        elif prefix == "after":
            try:
                dt = datetime.datetime.strptime(val, "%Y-%m-%d")
                parsed["after_ts"] = dt.timestamp() + 86400
            except ValueError:
                pass
        elif prefix == "during":
            try:
                dt_start = datetime.datetime.strptime(val, "%Y-%m-%d")
                parsed["during_range"] = (dt_start.timestamp(), dt_start.timestamp() + 86400)
            except ValueError:
                pass
        return " "

    # 1. フィルタを抽出して query_str から除去
    remaining = re.sub(filter_pattern, handle_filter, query_str, flags=re.IGNORECASE)
    
    # 2. 引用符の完全一致フレーズを抽出
    quoted_pattern = r'["\']([^"\']+)["\']'
    for q in re.findall(quoted_pattern, remaining):
        if q.strip():
            parsed["exact_phrases"].append(q.strip())
    remaining = re.sub(quoted_pattern, ' ', remaining)
    
    # 3. 残りの通常単語
    for term in remaining.split():
        if term.strip():
            parsed["plain_terms"].append(term.strip())
            
    return parsed


def execute_search(
    guild_id: int,
    query_str: str,
    channel_id: Optional[int] = None,
    limit: int = 25,
    offset: int = 0
) -> Dict[str, Any]:
    parsed = parse_search_query(query_str)
    
    conditions = ["guild_id = ?"]
    params: List[Any] = [guild_id]
    
    if channel_id:
        conditions.append("channel_id = ?")
        params.append(channel_id)
        
    # 1. 引用符の完全一致
    for phrase in parsed["exact_phrases"]:
        conditions.append("INSTR(LOWER(content), LOWER(?)) > 0")
        params.append(phrase)
        
    # 2. 通常単語の部分一致
    for term in parsed["plain_terms"]:
        conditions.append("LOWER(content) LIKE ?")
        params.append(f"%{term.lower()}%")
        
    # 3. from フィルタ (ユーザー名 or ID or 表示名部分一致)
    if parsed["from_user"]:
        from_clauses = []
        for user_filter in parsed["from_user"]:
            if user_filter.isdigit():
                from_clauses.append("(author_id = ? OR LOWER(author_name) LIKE ?)")
                params.extend([int(user_filter), f"%{user_filter.lower()}%"])
            else:
                from_clauses.append("LOWER(author_name) LIKE ?")
                params.append(f"%{user_filter.lower()}%")
        conditions.append(f"({' OR '.join(from_clauses)})")
        
    # 4. in フィルタ (channel_id または channel_idリスト)
    if parsed["in_channels"]:
        in_clauses = []
        for ch_filter in parsed["in_channels"]:
            if ch_filter.isdigit():
                in_clauses.append("channel_id = ?")
                params.append(int(ch_filter))
        if in_clauses:
            conditions.append(f"({' OR '.join(in_clauses)})")
            
    # 5. has フィルタ
    for has_val in parsed["has_filters"]:
        if has_val in ("image", "images", "img"):
            conditions.append("""(
                attachments_json LIKE '%image/%' OR attachments_json LIKE '%.png%' OR 
                attachments_json LIKE '%.jpg%' OR attachments_json LIKE '%.jpeg%' OR 
                attachments_json LIKE '%.webp%' OR attachments_json LIKE '%.gif%'
            )""")
        elif has_val in ("video", "videos", "vid"):
            conditions.append("""(
                attachments_json LIKE '%video/%' OR attachments_json LIKE '%.mp4%' OR 
                attachments_json LIKE '%.webm%' OR attachments_json LIKE '%.mov%'
            )""")
        elif has_val in ("file", "files"):
            conditions.append("(attachments_json IS NOT NULL AND attachments_json != '[]')")
        elif has_val in ("link", "links", "url"):
            conditions.append("(content LIKE '%http://%' OR content LIKE '%https://%')")
        elif has_val in ("embed", "embeds"):
            conditions.append("(embeds_json IS NOT NULL AND embeds_json != '[]')")
            
    # 6. 日時フィルタ
    if parsed["during_range"]:
        start_ts, end_ts = parsed["during_range"]
        conditions.append("created_at >= ? AND created_at < ?")
        params.extend([start_ts, end_ts])
    else:
        if parsed["before_ts"]:
            conditions.append("created_at < ?")
            params.append(parsed["before_ts"])
        if parsed["after_ts"]:
            conditions.append("created_at >= ?")
            params.append(parsed["after_ts"])
            
    where_clause = " AND ".join(conditions)
    
    with get_db() as conn:
        cursor = conn.cursor()
        
        # 総件数カウント
        count_query = f"SELECT COUNT(*) AS total FROM messages WHERE {where_clause}"
        cursor.execute(count_query, params)
        total_count = cursor.fetchone()["total"]
        
        # ページネーション取得
        data_query = f"""
            SELECT * FROM messages 
            WHERE {where_clause}
            ORDER BY created_at DESC
            LIMIT ? OFFSET ?
        """
        cursor.execute(data_query, params + [limit, offset])
        rows = cursor.fetchall()
        
        messages = []
        for r in rows:
            d = dict(r)
            d["attachments"] = json.loads(d["attachments_json"]) if d.get("attachments_json") else []
            d["embeds"] = json.loads(d["embeds_json"]) if d.get("embeds_json") else []
            d["stickers"] = json.loads(d["stickers_json"]) if d.get("stickers_json") else []
            d["reactions"] = json.loads(d["reactions_json"]) if d.get("reactions_json") else []
            if "attachments_json" in d: del d["attachments_json"]
            if "embeds_json" in d: del d["embeds_json"]
            if "stickers_json" in d: del d["stickers_json"]
            if "reactions_json" in d: del d["reactions_json"]
            messages.append(d)
            
        return {
            "total": total_count,
            "limit": limit,
            "offset": offset,
            "query": query_str,
            "parsed": parsed,
            "messages": messages
        }
