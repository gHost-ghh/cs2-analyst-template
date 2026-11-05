"""Deterministic, self-only reports from completed CS2 Demo queue jobs.

Demo events support explicit counts, not proprietary aim/reaction ratings. Results
are kept separate from Leetify because time/map similarity cannot establish match
identity. No network requests or model calls are made by this module.
"""
from __future__ import annotations

from collections import Counter, defaultdict
import csv
from datetime import datetime, timezone
import io
import json
import math
from pathlib import Path
import re
from zoneinfo import ZoneInfo


COUNT_FIELDS = ("kills", "deaths", "assists", "damage", "headshot_kills")
BOOL_FIELDS = ("opening_kill", "opening_death", "survived", "traded", "kast")
STATUSES = ("pending", "retry", "complete", "blocked_auth", "unavailable")
DISCOVERY_STATUSES = ("discovered", "transient", "expired", "unavailable")
STATUS_LABELS = {"pending": "待处理", "retry": "待重试", "blocked_auth": "需要 Steam 凭据", "unavailable": "暂不可用", "unknown": "未知"}
ERROR_EXPLANATIONS = {
    "replay_host_not_allowed": "GC 返回的下载域名不在许可名单内，需要核对域名配置；不能把此状态解释为 Demo 已过期。",
    "replay_url_unavailable": "GC 未返回这场比赛的下载链接；这不能证明 Demo 已过期，任务会保留并按计划重试。",
    "gc_url_unavailable": "GC 未返回这场比赛的下载链接；这不能证明 Demo 已过期，任务会保留并按计划重试。",
    "match_unavailable": "GC 暂未返回这场比赛；不能据此证明比赛不存在或 Demo 已过期。",
    "http_404": "下载服务器返回 HTTP 404，文件可能已过期、缺失或暂未提供；不能仅凭这次响应确定原因。",
    "steam_refresh_token_missing": "尚未配置 Steam 登录令牌；比赛授权码和 Steam Web API Key 不能替代 GC 登录。",
    "steam_refresh_token_expired": "Steam 登录令牌已过期，需要在云端重新扫码并更新 Secret 后重试。",
    "steam_refresh_token_rejected": "Steam 登录令牌被拒绝或撤销，需要在云端重新扫码并更新 Secret 后重试。",
    "steam_refresh_token_invalid": "Steam 登录令牌格式无效，需要更新云端 Secret。",
    "steam_auth_rejected": "Steam 拒绝登录，需要检查云端凭据和账号状态。",
    "steam_guard_reauth_required": "Steam 要求重新验证登录，需要在云端重新扫码。",
    "steam_account_mismatch": "Steam 会话账号与指定 SteamID64 不同，任务不会混入其他账号的数据。",
    "steam_playing_elsewhere": "检测到其他设备的游戏会话，本次保留任务并稍后重试。",
}
HISTORY_FIELDS = (
    "match_id", "match_started_at", "chronology_basis", "parsed_at", "map_name",
    "source", "share_code", "rounds", "kills", "deaths", "assists", "damage",
    "adr", "kd", "headshot_kills", "headshot_pct", "kast_rounds", "kast_pct",
    "opening_kills", "opening_deaths",
)
ROUND_FIELDS = (
    "match_id", "map_name", "round_number", "side", "won", *COUNT_FIELDS,
    *BOOL_FIELDS,
)


def _read(path: Path):
    try:
        return json.loads(path.read_text(encoding="utf-8"))
    except (OSError, ValueError):
        return None


def _write(path: Path, text: str) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    if not path.exists() or path.read_text(encoding="utf-8") != text:
        path.write_text(text, encoding="utf-8")


def _csv(path: Path, columns: tuple[str, ...], rows: list[dict]) -> None:
    buffer = io.StringIO(newline="")
    writer = csv.DictWriter(buffer, fieldnames=columns, lineterminator="\n")
    writer.writeheader()
    for row in rows:
        # CSV is also opened in spreadsheet software. Keep text fields literal.
        safe = {
            k: ("'" + v if isinstance(v, str) and v.startswith(("=", "+", "-", "@", "\t", "\r")) else v)
            for k, v in row.items() if k in columns
        }
        writer.writerow(safe)
    _write(path, buffer.getvalue())


def _number(value) -> bool:
    return isinstance(value, (int, float)) and not isinstance(value, bool) and math.isfinite(value) and value >= 0


def _valid_round(item) -> bool:
    if not isinstance(item, dict):
        return False
    if not all(_number(item.get(key)) for key in COUNT_FIELDS):
        return False
    if not all(isinstance(item.get(key), bool) for key in BOOL_FIELDS):
        return False
    if not isinstance(item.get("round_number"), int) or isinstance(item.get("round_number"), bool):
        return False
    if item["round_number"] < 1 or item.get("side") not in {"T", "CT"}:
        return False
    return item["headshot_kills"] <= item["kills"]


def _timestamp(value) -> datetime | None:
    if not isinstance(value, str):
        return None
    try:
        timestamp = datetime.fromisoformat(value.replace("Z", "+00:00"))
        if timestamp.tzinfo is not None:
            return timestamp.astimezone(timezone.utc)
    except ValueError:
        pass
    return None


def _verified_time(match: dict) -> datetime | None:
    provenance = match.get("provenance")
    if not isinstance(provenance, dict) or provenance.get("match_time_verified") is not True:
        return None
    # A parser timestamp, demo file mtime, or HTTP Last-Modified is not a match time.
    return _timestamp(match.get("match_started_at"))


def _aggregate(rounds: list[dict]) -> dict:
    totals = {key: sum(item[key] for item in rounds) for key in COUNT_FIELDS}
    count = len(rounds)
    totals.update({
        "rounds": count,
        "adr": round(totals["damage"] / count, 2) if count else None,
        "kd": round(totals["kills"] / totals["deaths"], 3) if totals["deaths"] else None,
        "headshot_pct": round(100 * totals["headshot_kills"] / totals["kills"], 2) if totals["kills"] else None,
        "kast_rounds": sum(item["kast"] for item in rounds),
        "kast_pct": round(100 * sum(item["kast"] for item in rounds) / count, 2) if count else None,
        "opening_kills": sum(item["opening_kill"] for item in rounds),
        "opening_deaths": sum(item["opening_death"] for item in rounds),
        "survived_rounds": sum(item["survived"] for item in rounds),
        "traded_rounds": sum(item["traded"] for item in rounds),
    })
    return totals


def _period(matches: list[dict]) -> dict:
    return {"match_count": len(matches), **_aggregate([r for match in matches for r in match["rounds"]])}


def _markdown(value) -> str:
    text = str(value).replace("\n", " ").replace("\r", " ")
    for char in ("\\", "`", "*", "_", "[", "]", "<", ">", "|"):
        text = text.replace(char, "\\" + char)
    return text


def _format(value, digits: int = 2) -> str:
    if value is None:
        return "—"
    if isinstance(value, int):
        return str(value)
    return f"{value:.{digits}f}"


def _display_time(value) -> str:
    parsed = _timestamp(value)
    return parsed.astimezone(ZoneInfo("Asia/Shanghai")).strftime("%Y-%m-%d %H:%M:%S") if parsed else "未知"


def _safe_error(value) -> str | None:
    return value if isinstance(value, str) and re.fullmatch(r"[a-z0-9_]{1,64}", value) else None


def _gc_discovery(path: Path) -> dict:
    """Never copy upstream payloads, URLs, tokens, or arbitrary error messages."""
    raw = _read(path)
    if not isinstance(raw, dict) or raw.get("status") not in DISCOVERY_STATUSES:
        return {}
    result = {"status": raw["status"]}
    checked_at = _timestamp(raw.get("last_checked_at"))
    if checked_at:
        result["last_checked_at"] = checked_at.isoformat()
    for key in ("returned_matches", "newly_queued", "unencodable_matches"):
        value = raw.get(key)
        if isinstance(value, int) and not isinstance(value, bool) and value >= 0:
            result[key] = value
    code = _safe_error(raw.get("error_code"))
    if code:
        result["error_code"] = code
    return result


def _unfinished_job(job_id, job: dict) -> dict:
    """Bound the diagnostic fields independently from the acquisition payload."""
    identity = str(job_id)
    if not re.fullmatch(r"[A-Za-z0-9_-]{1,64}", identity):
        identity = "unknown_job"
    row = {"job_id": identity, "status": job.get("status") if job.get("status") in STATUSES else "unknown"}
    code = job.get("share_code")
    if isinstance(code, str) and re.fullmatch(r"CSGO-(?:[A-Za-z0-9]{5}-){4}[A-Za-z0-9]{5}", code):
        row["share_code"] = code
    error = _safe_error(job.get("last_error_code"))
    if error:
        row["last_error_code"] = error
    for field in ("last_attempt_at", "next_attempt_at"):
        timestamp = _timestamp(job.get(field))
        if timestamp:
            row[field] = timestamp.isoformat()
    return row


def _render_diagnostics(snapshot: dict) -> list[str]:
    discovery = snapshot["gc_discovery"]
    lines = ["## 最近比赛发现与下载状态", ""]
    if discovery:
        labels = {"discovered": "查询成功", "transient": "暂时失败", "expired": "登录令牌过期或被拒绝", "unavailable": "暂不可用"}
        lines.append(f"Steam GC 最近比赛发现：**{labels[discovery['status']]}**；最后检查：{_display_time(discovery.get('last_checked_at'))}（北京时间）。")
        if discovery["status"] == "discovered":
            counts = [f"{label} **{discovery[field]}** 场" for field, label in (
                ("returned_matches", "返回比赛"), ("newly_queued", "新增入队"), ("unencodable_matches", "无法生成分享代码"),
            ) if field in discovery]
            if counts:
                lines.append("，".join(counts) + "。")
            lines.append("GC 仅提供最近最多约 8 场的窗口。查询成功只表示发现步骤完成，不表示 Demo 已下载或解析成功；返回 0 场也不能证明历史比赛完整或本人没有比赛。")
        elif discovery["status"] == "expired":
            lines.append("需要在云端重新扫码并更新 Steam 登录 Secret，再手动触发重试；已有比赛结果继续保留。")
        else:
            lines.append("本次发现没有成功完成；已有队列继续保留，不能将下载 0 场直接解释为本人没有比赛。")
        if discovery.get("error_code"):
            error = discovery["error_code"]
            lines.append(f"发现错误码：`{error}`。" + ERROR_EXPLANATIONS.get(error, "查看云端任务诊断并按计划重试；报告不保存上游原始错误或凭据。"))
    else:
        lines.append("尚无可用的 Steam GC 最近比赛发现记录；当前队列也可能来自历史分享代码或手动输入，不能据此确认最近比赛已发现。")
    unfinished = snapshot["unfinished_jobs"]
    if unfinished:
        lines += ["", "未完成任务（按最近尝试时间排列，最多显示 20 条；时间均为北京时间）：", "", "| 分享代码或任务 ID | 状态 | 错误码 | 上次尝试 | 下次重试 |", "| --- | --- | --- | --- | --- |"]
        for job in unfinished[:20]:
            identity = job.get("share_code") or job["job_id"]
            error = f"`{job['last_error_code']}`" if job.get("last_error_code") else "—"
            lines.append(f"| `{identity}` | {STATUS_LABELS[job['status']]} | {error} | {_display_time(job.get('last_attempt_at'))} | {_display_time(job.get('next_attempt_at'))} |")
        if len(unfinished) > 20:
            lines += ["", f"其余 {len(unfinished) - 20} 条任务见 `demo_snapshot.json` 的 `unfinished_jobs`。"]
        errors = sorted({job["last_error_code"] for job in unfinished if job.get("last_error_code")})
        explained = set()
        for error in errors:
            explanation = ERROR_EXPLANATIONS.get(error)
            if explanation and explanation not in explained:
                lines += ["", f"- `{error}`：{explanation}"]
                explained.add(explanation)
    else:
        lines += ["", "当前本人队列没有未完成任务；这仍不代表覆盖了全部历史官匹。"]
    return lines + [""]


def _percent(value) -> str:
    return "—" if value is None else _format(value) + "%"


def _source_hash(result: dict, job: dict) -> str | None:
    provenance = result.get("provenance")
    candidates = []
    if isinstance(provenance, dict):
        candidates.extend([provenance.get("source_sha256"), provenance.get("sha256")])
    candidates.append(job.get("downloaded_sha256"))
    for value in candidates:
        if isinstance(value, str) and len(value) == 64 and all(c in "0123456789abcdef" for c in value.lower()):
            return value.lower()
    return None


def _training(snapshot: dict) -> list[str]:
    stats = snapshot["aggregate"]
    matches = snapshot["matches_analyzed"]
    rounds = stats["rounds"]
    if not rounds:
        return ["先完成一场本人 Demo 的解析，再按回合复盘；当前不生成个人表现结论。"]
    advice = [f"当前样本为 {matches} 场、{rounds} 个有效回合；建议结合原始 Demo 核验具体回合，再决定训练重点。"]
    if rounds < 100 or matches < 5:
        advice.append("样本不足 5 场或 100 回合，先积累数据；不据此判断水平升降或长期短板。")
    opening_deaths = stats["opening_deaths"]
    if opening_deaths:
        advice.append(f"优先回看 {opening_deaths} 个本人首死回合：记录是否有队友可补枪、是否有闪光支持，以及能否安全撤回。首死本身不能判断决策对错。")
    missed = rounds - stats["kast_rounds"]
    if missed:
        advice.append(f"抽查 {missed} 个未满足 KAST 的回合，结合站位、经济和团队计划，寻找可验证的支援或存活机会。")
    advice.append("如要练准星预瞄或反应，另做可复核的训练测试；本报告的事件计数不能直接测量这些能力。")
    return advice


def _render(snapshot: dict, matches: list[dict]) -> str:
    stats = snapshot["aggregate"]
    statuses = snapshot["status_counts"]
    lines = [
        "# CS2 Demo 自动分析", "",
        f"SteamID64：`{_markdown(snapshot['steamid64'])}`。仅汇总队列中已完成、且解析结果确认属于本人的比赛。", "",
        f"已分析 **{snapshot['matches_analyzed']}** 场、**{stats['rounds']}** 个有效回合。",
        f"队列：待处理 {statuses['pending']}，待重试 {statuses['retry']}，已完成 {statuses['complete']}，需要 Steam 凭据 {statuses['blocked_auth']}，暂不可用 {statuses['unavailable']}。", "",
        "队列完成比例只表示已发现任务的处理进度。历史官匹可能未发现、Demo 可能已过期、部分回合可能被过滤，完整官匹覆盖率未知。手动 URL / 本地文件的比赛来源也未自动确认为官匹。", "",
    ]
    if statuses["blocked_auth"]:
        lines += ["需要配置 Steam GC 登录凭据后，自动下载任务才能继续；比赛授权码 / Steam Web API Key 本身不能建立 GC 会话。请通过云端 Secret 配置，不要把凭据写进报告。", ""]
    if statuses["retry"]:
        lines += ["待重试任务会按队列的重试时间再次处理；本次报告保留已完成的结果，不把下载失败记作零表现。", ""]
    if snapshot["excluded"]:
        lines += [f"另有 **{len(snapshot['excluded'])}** 条任务或结果未纳入，原因见 `demo_snapshot.json`；它们不参与统计分母。", ""]
    lines += _render_diagnostics(snapshot)
    lines += [
        "## 事件统计", "",
        "| 有效回合 | 击杀 / 死亡 / 助攻 | ADR | K/D | 爆头击杀占比 | KAST | 首杀 / 首死 |",
        "| ---: | ---: | ---: | ---: | ---: | ---: | ---: |",
        f"| {stats['rounds']} | {stats['kills']} / {stats['deaths']} / {stats['assists']} | {_format(stats['adr'])} | {_format(stats['kd'])} | {_percent(stats['headshot_pct'])} | {_percent(stats['kast_pct'])} | {stats['opening_kills']} / {stats['opening_deaths']} |", "",
        "ADR = 有效回合内对敌伤害总和 ÷ 有效回合数；K/D 在死亡为 0 时留空；爆头占比 = 爆头击杀 ÷ 击杀，击杀为 0 时留空。KAST = 有击杀、助攻、存活或被队友在交易窗口内补掉的回合占比；交易窗口取每份结果的 provenance。", "",
        "所有汇总直接累计回合事件。跨比赛 ADR、KAST 按回合加权，爆头占比按击杀加权；不平均各场百分比。这里只统计解析器保留的有效回合，具体过滤条件见结果 provenance。", "",
        "## 最近样本与长期积累", "",
        snapshot["chronology"]["description"], "",
        "| 分组 | 场数 | 有效回合 | ADR | KAST | 首杀 / 首死 |",
        "| --- | ---: | ---: | ---: | ---: | ---: |",
    ]
    comparison = snapshot["comparison"]
    for label, key in (("最近 30 场", "recent30"), ("此前 30 场", "previous30")):
        if snapshot["chronology"]["basis"] != "verified_match_time":
            label = label.replace("场", "份解析结果")
        group = comparison[key]
        lines.append(f"| {label} | {group['match_count']} | {group['rounds']} | {_format(group['adr'])} | {_percent(group['kast_pct'])} | {group['opening_kills']} / {group['opening_deaths']} |")
    lines += ["", "分组不足 30 场时显示实际样本量；数据是描述性统计，地图、阵营、对手、经济及版本差异均可能影响比较。"]
    if comparison["deltas"] is not None:
        delta = comparison["deltas"]
        lines += ["", f"按已核验比赛时间分组：ADR 差值 {_format(delta['adr'])}，KAST 差值 {_format(delta['kast_pct'])} 个百分点。差值不能单独证明能力变化。"]
    lines += ["", "## 地图与阵营", "", "| 地图 | 场数 | 有效回合 | ADR | KAST |", "| --- | ---: | ---: | ---: | ---: |"]
    for map_name, group in snapshot["by_map"].items():
        lines.append(f"| {_markdown(map_name)} | {group['match_count']} | {group['rounds']} | {_format(group['adr'])} | {_percent(group['kast_pct'])} |")
    if not snapshot["by_map"]:
        lines.append("| 暂无已解析比赛 | 0 | 0 | — | — |")
    lines += ["", "| 阵营 | 有效回合 | ADR | KAST | 首杀 / 首死 |", "| --- | ---: | ---: | ---: | ---: |"]
    for side, group in snapshot["by_side"].items():
        lines.append(f"| {side} | {group['rounds']} | {_format(group['adr'])} | {_percent(group['kast_pct'])} | {group['opening_kills']} / {group['opening_deaths']} |")
    if snapshot["by_weapon"]:
        lines += ["", "## 武器事件", "", "| 武器 | 击杀 | 爆头击杀 | 对敌伤害 |", "| --- | ---: | ---: | ---: |"]
        for weapon, group in snapshot["by_weapon"].items():
            lines.append(f"| {_markdown(weapon)} | {group['kills']} | {group['headshot_kills']} | {_format(group['damage'])} |")
        lines += ["", "武器表为解析结果提供的事件累计，不使用总回合数伪造单武器 ADR，也不推算命中率。"]
    lines += ["", "## 下一次复盘", ""]
    lines += [f"- {item}" for item in _training(snapshot)]
    lines += ["", "## 数据边界", "", "- 这是确定性的 Demo 事件统计，不是 Leetify Rating，也不等于准星放置、反应时间或瞄准水平评分。", "- Demo 与 Leetify 的数据分开保留；不能仅按比赛时间或地图认定为同一场，也不隐式合并去重。Demo 队列仅按相同结果路径或完全相同文件的 SHA-256 去重。", "- 不推断未获取比赛的表现，不把空值或下载失败填为 0。位置采样用于后续复盘，当前报告不生成预瞄或反应时间结论。"]
    lines += [f"- {_markdown(item)}" for item in snapshot["limitations"]]
    lines += ["", "## 纳入比赛", "", "| 任务 ID | 地图 | 来源 | 有效回合 | 解析时间（北京时间） |", "| --- | --- | --- | ---: | --- |"]
    for match in matches:
        lines.append(f"| `{_markdown(match['match_id'])}` | {_markdown(match.get('map_name', 'unknown'))} | {_markdown(match['source'])} | {len(match['rounds'])} | {_display_time(match.get('parsed_at'))} |")
    if not matches:
        lines.append("| 暂无已完成且确认属于本人的结果 | — | — | 0 | — |")
    lines += ["", "明细：`demo_history.csv`（比赛）、`demo_rounds.csv`（回合）、`demo_snapshot.json`（汇总及排除原因）。", ""]
    return "\n".join(lines)


def load_validated_matches(data_dir: Path, steamid: str) -> dict:
    """Load queue-linked personal results and bounded acquisition diagnostics.

    Only registered ``data/demo_matches`` results are read. Orphan files, paths
    outside that directory, another account, malformed rounds, and unsupported
    schema versions cannot silently contribute to personal statistics.
    """
    data_dir = Path(data_dir)
    steamid = str(steamid)
    queue_path = data_dir / "demo_jobs.json"
    queue = _read(queue_path)
    excluded, matches, limitations = [], [], set()
    jobs = queue.get("jobs", {}) if isinstance(queue, dict) else {}
    if not isinstance(jobs, dict):
        jobs = {}
        excluded.append({"job_id": None, "reason": "invalid_queue_jobs"})
    if queue_path.exists() and not isinstance(queue, dict):
        excluded.append({"job_id": None, "reason": "unreadable_queue"})
    owner_matches = isinstance(queue, dict) and str(queue.get("steamid64", "")) == steamid
    if jobs and not owner_matches:
        excluded.append({"job_id": None, "reason": "queue_account_mismatch"})
    if isinstance(queue, dict) and queue.get("schema_version") != 1:
        owner_matches = False
        excluded.append({"job_id": None, "reason": "unsupported_queue_schema"})
    counts = Counter({status: 0 for status in STATUSES})
    unfinished_jobs = []
    result_root = (data_dir / "demo_matches").resolve()
    seen_paths = set()
    seen_hashes = {}
    # Prefer the official acquisition record when the same bytes were also
    # submitted manually; GC can supply a separately verified match timestamp.
    ordered_jobs = sorted(jobs.items(), key=lambda pair: (
        not (isinstance(pair[1], dict) and pair[1].get("source") == "steam_gc"), str(pair[0]),
    ))
    for job_id, job in ordered_jobs:
        if not isinstance(job, dict):
            excluded.append({"job_id": str(job_id), "reason": "invalid_job"})
            continue
        status = job.get("status", "unknown")
        counts[status if isinstance(status, str) and status in STATUSES else "unknown"] += 1
        if owner_matches and status != "complete":
            unfinished_jobs.append(_unfinished_job(job_id, job))
        if not owner_matches or status != "complete":
            continue
        result_path = job.get("result_path")
        if not isinstance(result_path, str) or not result_path:
            excluded.append({"job_id": str(job_id), "reason": "missing_result_path"})
            continue
        path = Path(result_path)
        path = (path if path.is_absolute() else data_dir / path).resolve()
        if path.parent != result_root or path.suffix != ".json":
            excluded.append({"job_id": str(job_id), "reason": "result_path_outside_demo_matches"})
            continue
        if path in seen_paths:
            excluded.append({"job_id": str(job_id), "reason": "duplicate_result_path"})
            continue
        result = _read(path)
        if not isinstance(result, dict):
            excluded.append({"job_id": str(job_id), "reason": "unreadable_result"})
            continue
        if result.get("schema_version") != "1.0":
            excluded.append({"job_id": str(job_id), "reason": "unsupported_result_schema"})
            continue
        player = result.get("player")
        if not isinstance(player, dict) or str(player.get("steamid", "")) != steamid:
            excluded.append({"job_id": str(job_id), "reason": "result_account_mismatch"})
            continue
        if result.get("match_id") != str(job_id):
            excluded.append({"job_id": str(job_id), "reason": "result_job_id_mismatch"})
            continue
        rounds = result.get("rounds")
        if not isinstance(rounds, list) or not rounds or not all(_valid_round(r) for r in rounds):
            excluded.append({"job_id": str(job_id), "reason": "invalid_or_empty_rounds"})
            continue
        numbers = [r["round_number"] for r in rounds]
        if len(set(numbers)) != len(numbers):
            excluded.append({"job_id": str(job_id), "reason": "duplicate_round_number"})
            continue
        source_hash = _source_hash(result, job)
        if source_hash is not None and source_hash in seen_hashes:
            excluded.append({"job_id": str(job_id), "reason": "duplicate_demo_sha256", "duplicate_of": seen_hashes[source_hash]})
            continue
        seen_paths.add(path)
        if source_hash is not None:
            seen_hashes[source_hash] = str(job_id)
        # The queue establishes acquisition source; result metadata cannot override it.
        result["source"] = job.get("source", "unknown")
        result["share_code"] = job.get("share_code") or result.get("share_code") or ""
        result["parsed_at"] = result.get("parsed_at") or job.get("parsed_at") or ""
        matches.append(result)
        source_limitations = result.get("limitations", [])
        if isinstance(source_limitations, list):
            limitations.update(item for item in source_limitations if isinstance(item, str))
    verified_count = sum(_verified_time(match) is not None for match in matches)
    verified = bool(matches) and verified_count == len(matches)
    basis = "verified_match_time" if verified else "parse_order"
    floor = datetime.min.replace(tzinfo=timezone.utc)
    matches.sort(key=lambda match: ((_verified_time(match) if verified else _timestamp(match.get("parsed_at"))) or floor, match["match_id"]), reverse=True)
    unfinished_jobs.sort(key=lambda job: (_timestamp(job.get("last_attempt_at")) or floor, job["job_id"]), reverse=True)
    return {
        "matches": matches, "excluded": excluded, "limitations": sorted(limitations),
        "status_counts": dict(sorted(counts.items())), "unfinished_jobs": unfinished_jobs,
        "queue_jobs": len(jobs),
        "gc_discovery": _gc_discovery(data_dir / "gc_discovery.json") if owner_matches else {},
        "coverage": {"official_match_coverage_known": False, "completed_jobs_analyzed": len(matches), "discovered_jobs": len(jobs)},
        "chronology": {
            "basis": basis, "verified_match_count": verified_count,
            "description": ("全部纳入结果均有明确标记已核验的比赛时间，按比赛时间分组。" if verified else "缺少完整、经核验的比赛时间，以下按解析时间排列（缺失时以任务 ID 稳定排序），仅表示解析顺序；补录旧 Demo 也会排到前面，不生成时间趋势比较。"),
        },
    }


def generate_reports(data_dir: Path, reports_dir: Path, steamid: str) -> dict:
    """Write deterministic reports from the shared validated personal dataset."""
    data_dir, reports_dir = Path(data_dir), Path(reports_dir)
    steamid = str(steamid)
    validated = load_validated_matches(data_dir, steamid)
    matches = validated["matches"]
    basis = validated["chronology"]["basis"]
    verified = basis == "verified_match_time"
    rounds = [item for match in matches for item in match["rounds"]]
    by_map = defaultdict(list)
    for match in matches:
        by_map[str(match.get("map_name") or "unknown")].append(match)
    by_side = {side: _aggregate([r for r in rounds if r["side"] == side]) for side in ("T", "CT")}
    by_weapon = defaultdict(lambda: {"kills": 0, "headshot_kills": 0, "damage": 0})
    for match in matches:
        summary = match.get("summary")
        weapons = summary.get("by_weapon", {}) if isinstance(summary, dict) else {}
        if isinstance(weapons, dict):
            for weapon, values in weapons.items():
                if isinstance(values, dict) and all(_number(values.get(k)) for k in ("kills", "headshot_kills", "damage")):
                    for key in ("kills", "headshot_kills", "damage"):
                        by_weapon[str(weapon)][key] += values[key]
    recent, previous = _period(matches[:30]), _period(matches[30:60])
    deltas = None
    if verified and recent["rounds"] and previous["rounds"]:
        deltas = {key: round(recent[key] - previous[key], 2) for key in ("adr", "kast_pct")}
    snapshot = {
        "schema_version": "1.0", "steamid64": steamid,
        "matches_analyzed": len(matches), "rounds_analyzed": len(rounds),
        **{key: validated[key] for key in ("queue_jobs", "status_counts", "gc_discovery", "unfinished_jobs", "coverage")},
        "aggregate": _aggregate(rounds),
        "by_map": {name: _period(group) for name, group in sorted(by_map.items())},
        "by_side": by_side, "by_weapon": dict(sorted(by_weapon.items())),
        "chronology": validated["chronology"],
        "comparison": {"basis": basis, "trend_supported": deltas is not None, "recent30": recent, "previous30": previous, "deltas": deltas},
        "excluded": validated["excluded"], "limitations": validated["limitations"],
    }
    history, round_rows = [], []
    for match in matches:
        verified_time = _verified_time(match)
        history.append({
            "match_id": match["match_id"], "match_started_at": verified_time.isoformat() if verified_time else "",
            "chronology_basis": basis, "parsed_at": match.get("parsed_at", ""),
            "map_name": match.get("map_name") or "unknown", "source": match["source"],
            "share_code": match["share_code"], **_aggregate(match["rounds"]),
        })
        for item in match["rounds"]:
            round_rows.append({"match_id": match["match_id"], "map_name": match.get("map_name") or "unknown", **{k: item.get(k, "") for k in ROUND_FIELDS if k not in {"match_id", "map_name"}}})
    _csv(reports_dir / "demo_history.csv", HISTORY_FIELDS, history)
    _csv(reports_dir / "demo_rounds.csv", ROUND_FIELDS, round_rows)
    _write(reports_dir / "demo_snapshot.json", json.dumps(snapshot, ensure_ascii=False, indent=2, sort_keys=True, allow_nan=False) + "\n")
    _write(reports_dir / "demo_latest.md", _render(snapshot, matches))
    from .dashboard import generate_dashboard
    generate_dashboard(data_dir, reports_dir, steamid, validated=validated, snapshot=snapshot)
    return snapshot
