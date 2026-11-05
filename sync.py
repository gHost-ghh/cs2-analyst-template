#!/usr/bin/env python3
"""Sync Valve match sharing codes and Leetify's own public API into private GitHub repo.

Requires only Python 3.11+. No Steam passwords or game coordinator sessions.
Data is self-only. Leetify data is incomplete if it has not processed a Valve match.
"""
from __future__ import annotations

import csv
import hashlib
import json
import os
from collections import Counter
from datetime import datetime, timezone
from pathlib import Path
import re
import sys
import time
from urllib.error import HTTPError, URLError
from urllib.parse import urlencode
from urllib.request import Request, urlopen

ROOT = Path(__file__).resolve().parent
DATA = ROOT / "data"
REPORTS = ROOT / "reports"
BASE = "https://api-public.cs-prod.leetify.com"
STEAM_URL = "https://api.steampowered.com/ICSGOPlayers_730/GetNextMatchSharingCode/v1/"
VALVE_SOURCES = {"matchmaking", "matchmaking_competitive"}
SHARE_PATTERN = re.compile(r"^CSGO-(?:[A-Za-z0-9]{5}-){4}[A-Za-z0-9]{5}$")


def iso_now() -> str:
    return datetime.now(timezone.utc).replace(microsecond=0).isoformat()


def read_json(path: Path, default):
    if not path.is_file():
        return default
    with path.open(encoding="utf-8") as fp:
        return json.load(fp)


def write_json_if_changed(path: Path, obj) -> bool:
    content = json.dumps(obj, ensure_ascii=False, indent=2, sort_keys=True) + "\n"
    if path.exists() and path.read_text(encoding="utf-8") == content:
        return False
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(content, encoding="utf-8")
    return True


def write_text_if_changed(path: Path, content: str) -> bool:
    if path.exists() and path.read_text(encoding="utf-8") == content:
        return False
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(content, encoding="utf-8")
    return True


def get_json(url: str, query: dict[str, str] | None = None, leetify_key: str = ""):
    """Fetch API data; redact secret-bearing URL from any error message."""
    full = url + (("?" + urlencode(query)) if query else "")
    headers = {"Accept": "application/json", "User-Agent": "cs2-self-stats/1.0"}
    if leetify_key:
        headers["_leetify_key"] = leetify_key
    for attempt in range(3):
        try:
            with urlopen(Request(full, headers=headers), timeout=25) as res:
                return json.load(res)
        except HTTPError as e:
            if e.code in {429, 500, 502, 503, 504} and attempt < 2:
                time.sleep(2 ** attempt + 1)
                continue
            raise RuntimeError(f"API HTTP {e.code}, path={url.split('?', 1)[0]}, no credentials logged") from None
        except (URLError, TimeoutError, OSError, ValueError) as e:
            if attempt < 2:
                time.sleep(2 ** attempt + 1)
                continue
            raise RuntimeError(f"API network/JSON failure ({type(e).__name__}), path={url.split('?', 1)[0]}") from None
    raise RuntimeError("API failed after retries")


def read_leetify_matches(obj) -> list[dict]:
    if isinstance(obj, list):
        matches = obj
    elif isinstance(obj, dict) and isinstance(obj.get("matches"), list):
        matches = obj["matches"]
    else:
        raise RuntimeError("Leetify matches response has unexpected format; inspect official API docs")
    if not all(isinstance(m, dict) for m in matches):
        raise RuntimeError("Leetify matches included a non-object record")
    return matches


def get_player_stats(match: dict, steamid: str) -> dict | None:
    stats = match.get("stats")
    if not isinstance(stats, list):
        return None
    identified = False
    for item in stats:
        if not isinstance(item, dict):
            continue
        ids = [item.get(k) for k in ("steam64_id", "steamid64", "steam_id", "steamid", "steam64Id")]
        user = item.get("player")
        if isinstance(user, dict):
            ids += [user.get(k) for k in ("steam64_id", "steam_id", "steamid")]
        identified = identified or any(v is not None for v in ids)
        if steamid in [str(v) for v in ids if v is not None]:
            return item
    # When an API returns a per-user-only list, the sole item is unambiguous.
    if not identified and len(stats) == 1 and isinstance(stats[0], dict):
        return stats[0]
    return None


def sync_steam_codes() -> tuple[set[str], bool]:
    keys = ["STEAM_WEB_API_KEY", "STEAM_MATCH_AUTH_CODE", "STEAM_KNOWNCODE"]
    present = [bool(os.getenv(k, "").strip()) for k in keys]
    if not any(present):
        print("Steam code discovery not configured: will sync Leetify only (coverage unknown).")
        return set(), False
    if not all(present):
        raise RuntimeError("Steam discovery needs all three secrets: STEAM_WEB_API_KEY, STEAM_MATCH_AUTH_CODE, STEAM_KNOWNCODE")
    seed = os.environ["STEAM_KNOWNCODE"].strip()
    if not SHARE_PATTERN.fullmatch(seed):
        raise RuntimeError("STEAM_KNOWNCODE is not a valid match sharing code")
    path = DATA / "official_codes.json"
    old = read_json(path, {"cursor": seed, "codes": [seed]})
    codes = list(dict.fromkeys(old.get("codes", [seed])))
    if seed not in codes:
        codes.insert(0, seed)
    cursor = old.get("cursor", seed)
    if not SHARE_PATTERN.fullmatch(cursor):
        raise RuntimeError("Stored Steam cursor is invalid")
    seen = set(codes)
    new = 0
    # Checkpoint before and during discovery: Demo work can continue even if
    # a later Steam request or Leetify request fails in this run.
    write_json_if_changed(path, {"cursor": cursor, "codes": codes})
    for _ in range(200):  # Avoid an unbounded loop or rate-limit burst.
        response = get_json(STEAM_URL, {
            "key": os.environ["STEAM_WEB_API_KEY"].strip(),
            "steamid": os.environ["STEAMID64"].strip(),
            "steamidkey": os.environ["STEAM_MATCH_AUTH_CODE"].strip(),
            "knowncode": cursor,
        })
        result = response.get("result", {}) if isinstance(response, dict) else {}
        nxt = result.get("nextcode") if isinstance(result, dict) else None
        if not nxt or str(nxt).lower() in ("n/a", "none", "null"):
            break
        if not isinstance(nxt, str) or not SHARE_PATTERN.fullmatch(nxt):
            raise RuntimeError("Steam returned an unexpected share code; not moving cursor")
        if nxt == cursor:
            break
        cursor = nxt
        if nxt in seen:
            break
        codes.append(nxt)
        seen.add(nxt)
        new += 1
        write_json_if_changed(path, {"cursor": cursor, "codes": codes})
        time.sleep(0.3)
    write_json_if_changed(path, {"cursor": cursor, "codes": codes})
    print(f"Steam codes: {len(codes)} total, {new} new. Includes the initial seed.")
    return set(codes), True


def normalize_match(item: dict, steamid: str) -> dict | None:
    source = item.get("data_source")
    if source not in VALVE_SOURCES:  # Do not mix FACEIT / third-party games into Valve analyses.
        return None
    game_id = item.get("id") or item.get("data_source_match_id")
    if not game_id:
        return None
    return {
        "id": str(game_id),
        "finished_at": item.get("finished_at"),
        "data_source": source,
        "data_source_match_id": item.get("data_source_match_id"),
        "map_name": item.get("map_name"),
        "team_scores": item.get("team_scores"),
        "has_banned_player": item.get("has_banned_player"),
        "player_stats": get_player_stats(item, steamid),
        "stats_provider": "Leetify Public API",
    }


def sync_leetify(steamid: str) -> tuple[list[dict], bool]:
    api_key = os.getenv("LEETIFY_API_KEY", "").strip()
    profile = get_json(f"{BASE}/v3/profile", {"steam64_id": steamid}, leetify_key=api_key)
    if not isinstance(profile, dict):
        raise RuntimeError("Leetify profile response is not an object")
    matches = read_leetify_matches(get_json(f"{BASE}/v3/profile/matches", {"steam64_id": steamid}, leetify_key=api_key))
    # Only store the user's own aggregate profile fields, not teammate identities.
    filtered_profile = {k: profile.get(k) for k in (
        "steam64_id", "name", "privacy_mode", "winrate", "total_matches",
        "first_match_date", "ranks", "rating", "stats") if k in profile}
    write_json_if_changed(DATA / "profile.json", filtered_profile)
    added = 0
    updated = 0
    for raw in matches:
        item = normalize_match(raw, steamid)
        if not item:
            continue
        safe_id = hashlib.sha256(f"{item['data_source']}:{item['id']}".encode()).hexdigest()[:24]
        path = DATA / "matches" / (safe_id + ".json")
        existed = path.exists()
        if write_json_if_changed(path, item):
            if existed: updated += 1
            else: added += 1
    print(f"Leetify returned {len(matches)} matches (all modes), added {added}, updated {updated} Valve records.")
    return load_matches(), bool(matches)


def load_matches() -> list[dict]:
    result = []
    for path in sorted((DATA / "matches").glob("*.json")):
        result.append(read_json(path, {}))
    return sorted(result, key=lambda m: m.get("finished_at") or "", reverse=True)


def metric(stats: dict | None, *keys):
    if not isinstance(stats, dict):
        return None
    for key in keys:
        value = stats.get(key)
        if isinstance(value, (int, float)) and not isinstance(value, bool):
            return value
    return None


def outcome(stats: dict | None) -> str:
    if not isinstance(stats, dict):
        return "unknown"
    for field in ("match_outcome", "outcome", "result"):
        text = stats.get(field)
        if isinstance(text, str) and text.lower() in {"win", "loss", "tie", "draw"}:
            return "tie" if text.lower() == "draw" else text.lower()
    won, lost = metric(stats, "rounds_won"), metric(stats, "rounds_lost")
    if won is not None and lost is not None:
        return "win" if won > lost else "loss" if won < lost else "tie"
    return "unknown"


def build_report(matches: list[dict], steam_codes: set[str], steam_enabled: bool, steamid: str):
    REPORTS.mkdir(parents=True, exist_ok=True)
    headers = ["finished_at", "map", "mode", "share_code", "result", "kills", "deaths", "assists", "adr", "leetify_rating", "player_stats_found"]
    rows = []
    for m in matches:
        p = m.get("player_stats")
        rows.append({
            "finished_at": m.get("finished_at") or "",
            "map": m.get("map_name") or "",
            "mode": m.get("data_source") or "",
            "share_code": m.get("data_source_match_id") or "",
            "result": outcome(p),
            "kills": metric(p, "total_kills", "kills"),
            "deaths": metric(p, "total_deaths", "deaths"),
            "assists": metric(p, "total_assists", "assists"),
            "adr": metric(p, "adr", "damage_per_round", "dpr"),
            "leetify_rating": metric(p, "leetify_rating"),
            "player_stats_found": p is not None,
        })
    import io
    buff = io.StringIO()
    writer = csv.DictWriter(buff, fieldnames=headers, lineterminator="\n")
    writer.writeheader()
    writer.writerows(rows)
    write_text_if_changed(REPORTS / "match_history.csv", buff.getvalue())

    known_codes = {m.get("data_source_match_id") for m in matches
                   if isinstance(m.get("data_source_match_id"), str)
                   and SHARE_PATTERN.fullmatch(m["data_source_match_id"])}
    pending = sorted(c for c in steam_codes if c not in known_codes)
    code_mapping_complete = len(known_codes) == len(matches)
    recent = matches[:30]
    valid_outcomes = [outcome(m.get("player_stats")) for m in recent]
    win_n = sum(x == "win" for x in valid_outcomes)
    loss_n = sum(x == "loss" for x in valid_outcomes)
    tie_n = sum(x == "tie" for x in valid_outcomes)
    ks = [metric(m.get("player_stats"), "total_kills", "kills") for m in recent]
    ds = [metric(m.get("player_stats"), "total_deaths", "deaths") for m in recent]
    paired = [(k, d) for k, d in zip(ks, ds) if k is not None and d is not None]
    kd = (sum(k for k, _ in paired) / sum(d for _, d in paired)) if paired and sum(d for _, d in paired) else None
    maps = Counter((m.get("map_name") or "unknown") for m in recent)
    profile = read_json(DATA / "profile.json", {})
    snapshot = {
        "steamid64": steamid, "recorded_valve_matches": len(matches),
        "steam_discovery_enabled": steam_enabled,
        "known_steam_share_codes_including_seed": len(steam_codes) if steam_enabled else None,
        "steam_codes_not_yet_in_leetify": pending if steam_enabled and code_mapping_complete else None,
        "steam_codes_without_verified_link": pending if steam_enabled else None,
        "leetify_records_without_share_code": len(matches) - len(known_codes),
        "recent_30_matches": len(recent), "recent_30_maps": dict(maps),
        "recent_30_win_loss_tie_known": {"wins": win_n, "losses": loss_n, "ties": tie_n},
        "recent_30_kd_ratio_if_present": round(kd, 3) if kd is not None else None,
        "recent_30_matches_without_self_stats": sum(m.get("player_stats") is None for m in recent),
        "profile_aggregate_winrate": profile.get("winrate"),
        "profile_total_matches_all_sources": profile.get("total_matches"),
    }
    write_json_if_changed(REPORTS / "snapshot.json", snapshot)
    lines = ["# CS2 官匹自动战绩摘要", "", "Demo 自动下载与逐回合分析见 [Demo 分析报告](demo_latest.md)，其任务状态独立于 Leetify。", "", "数据来源：Steam 官方分享代码（如已启用）与 Leetify Public API。",
             "本仓库仅保存 Valve 官匹；Leetify 未处理的比赛不会被当作 0 击杀或负场。", "",
             f"- 已收录 Valve 官匹详细记录：**{len(matches)}** 场",
             f"- 最近 30 场可识别胜/负/平：**{win_n}/{loss_n}/{tie_n}**（其余结果未知）",
             f"- 最近 30 场可计算的总击杀/总死亡 K/D：**{f'{kd:.2f}' if kd is not None else '未知'}**（{len(paired)} 场有 K/D 数据）",
             f"- 最近 30 场缺少个人详细统计：**{snapshot['recent_30_matches_without_self_stats']}** 场", ""]
    if steam_enabled:
        lines += [f"- Steam 发现分享代码（含初始种子）：**{len(steam_codes)}** 个"]
        if code_mapping_complete:
            lines += [f"- Steam 已发现但 Leetify 未匹配：**{len(pending)}** 个", ""]
        else:
            lines += [f"- Leetify 有 **{len(matches) - len(known_codes)}** 场没有返回分享代码；覆盖率暂不可验证。",
                      f"- 尚未建立分享代码关联：**{len(pending)}** 个，不能据此断言比赛缺失。", ""]
    else:
        lines += ["- Steam 官方比赛发现：**未启用**，因此无法确认 Leetify 是否遗漏了官匹。", ""]
    lines += ["## 最近 30 场地图分布", ""]
    for name, count in maps.most_common():
        lines.append(f"- {name}: {count}")
    if not maps:
        lines.append("- 暂无比赛记录")
    lines += ["", "## 数据完整性", "", "- 胜率仅在能识别胜负结果的样本上计算，不能把未知结果当成负场。",
              "- 如果 Leetify 没有识别某场游戏，官方分享代码仍可留存在 official_codes.json 中。",
              "- 比赛历史 CSV 保留每场原始记录关联信息；JSON 文件保留更丰富的单场字段。", ""]
    if pending:
        lines += ["## 尚未关联的比赛分享代码（最多列出 15 个）", ""]
        lines.extend("- `" + c + "`" for c in pending[:15])
        lines += [""]
    write_text_if_changed(REPORTS / "latest.md", "\n".join(lines))


def main():
    steamid = os.getenv("STEAMID64", "").strip()
    if not re.fullmatch(r"7656119\d{10}", steamid):
        raise RuntimeError("Set STEAMID64 to your 17-digit SteamID64 in GitHub Actions secrets")
    DATA.mkdir(parents=True, exist_ok=True)
    account_path = DATA / "account.json"
    account = read_json(account_path, {})
    if account.get("steamid64") not in (None, steamid):
        raise RuntimeError("STEAMID64 differs from the account already stored in this repository; use a separate repository")
    write_json_if_changed(account_path, {"steamid64": steamid})
    codes, steam_enabled = sync_steam_codes()
    matches, _ = sync_leetify(steamid)
    build_report(matches, codes, steam_enabled, steamid)
    write_json_if_changed(REPORTS / "sync_status.json", {"last_success_at": iso_now(), "recorded_valve_matches": len(matches)})
    print(f"Sync complete. {len(matches)} Valve matches in database. See reports/latest.md")


if __name__ == "__main__":
    try:
        main()
    except Exception as e:
        # Avoid accidental credential output from exception chain.
        print(f"Sync error: {e}", file=sys.stderr)
        sys.exit(1)
