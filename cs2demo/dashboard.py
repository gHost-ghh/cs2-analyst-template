"""Export a private Dashboard dataset from validated personal Demo results.

This module makes no network or model calls. Training actions are explicit rules
with round-level evidence; the reserved OpenAI response remains disconnected.
"""
from __future__ import annotations

import argparse
import base64
from collections import defaultdict
import gzip
import hashlib
import json
import math
import os
from pathlib import Path
import re

from .report import (
    COUNT_FIELDS, BOOL_FIELDS, _aggregate, _period, _read, _timestamp,
    _verified_time, load_validated_matches,
)
from .players import build_player_directory, match_players

SCHEMA_VERSION = "1.0"
ANALYSIS_VERSION = "dashboard-1.0"
ROUND_FIELDS = (
    "round_number", "side", "won", "start_tick", "end_tick", "winner",
    *COUNT_FIELDS, *BOOL_FIELDS,
)
PROVENANCE_FIELDS = (
    "source_sha256", "sha256", "source_bytes", "bytes", "compressed_bytes",
    "parser", "parser_version", "analysis_version", "tickrate", "tickrate_source",
    "position_sample_seconds", "trade_window_seconds", "round_filter",
    "dense_sampling", "event_velocity", "dense_velocity_definition",
    "damage_definition", "headshot_definition", "match_time_verified",
    "timestamp_provenance", "download_host", "download_protocol",
    "replay_sampling", "recording_bounds",
)
RUN_OUTCOMES = {"idle", "ok", "partial", "failed", "blocked_auth", "waiting_for_replays"}
MAX_DETAIL_BYTES = 8 * 1024 * 1024


def _finite(value):
    return isinstance(value, (int, float)) and not isinstance(value, bool) and math.isfinite(value)


def _clean(value, *, display_counters=False):
    """Bound additive parser fields and omit acquisition credentials/URLs."""
    if value is None or isinstance(value, bool):
        return value
    if isinstance(value, (int, float)):
        return value if _finite(value) else None
    if isinstance(value, str):
        return None if re.search(r"https?://", value, re.I) else value[:4000]
    if isinstance(value, list):
        return [_clean(item) for item in value[:100000]]
    if isinstance(value, dict):
        # Place labels are data (e.g. Nuke's "Secret"), not credential field
        # names. Only nonnegative numeric counts qualify for that exception.
        return {str(key): _clean(item, display_counters=key in {"place_samples", "kills_by_place", "deaths_by_place"}) for key, item in value.items()
                if isinstance(key, str) and 1 <= len(key) <= 128
                and not any(ord(char) < 32 or ord(char) == 127 for char in key)
                and not re.search(r"https?://", key, re.I)
                and (not display_counters and not re.search(r"token|password|secret|api.?key|url", key, re.I)
                     or display_counters and _finite(item) and item >= 0)}
    return None


def _encode_detail(value, *, count=None):
    """Losslessly package already-cleaned detail without lowering sample rates.

    Keep each expansion bounded independently of the complete snapshot. The
    zero gzip timestamp makes repeated exports byte-for-byte reproducible.
    Encoded strings must be attached after ``_clean``'s display-text limit.
    """
    raw = json.dumps(value, ensure_ascii=False, separators=(",", ":"), allow_nan=False).encode("utf-8")
    if len(raw) > MAX_DETAIL_BYTES:
        raise ValueError("dashboard_detail_exceeds_decoded_byte_limit")
    result = {"encoding": "gzip-base64-json", "data": base64.b64encode(
        gzip.compress(raw, compresslevel=6, mtime=0)).decode("ascii"), "decoded_bytes": len(raw)}
    if count is not None:
        result["count"] = count
    return result


def _encode_aim_trajectories(analysis):
    """Move only playback arrays into a bounded, lazily readable envelope."""
    if not isinstance(analysis, dict):
        return
    level3 = analysis.get("level3")
    mechanics = level3.get("mechanics") if isinstance(level3, dict) else None
    playback = mechanics.get("aim_playback") if isinstance(mechanics, dict) else None
    windows = playback.get("windows") if isinstance(playback, dict) else None
    for window in windows if isinstance(windows, list) else []:
        if not isinstance(window, dict):
            continue
        trajectory = {key: window.pop(key) for key in ("points", "targets", "geometry") if key in window}
        if trajectory:
            window["trajectory"] = _encode_detail(trajectory)


def _utc(value):
    stamp = _timestamp(value)
    return stamp.isoformat() if stamp else None


def _latest(values):
    stamps = [stamp for value in values if (stamp := _timestamp(value)) is not None]
    return max(stamps).isoformat() if stamps else None


def _evidence_id(match_id, round_number):
    return f"{match_id}:r{round_number}"


def _weapons(matches):
    result = defaultdict(lambda: {"kills": 0, "headshot_kills": 0, "damage": 0})
    for match in matches:
        summary = match.get("summary")
        rows = summary.get("by_weapon", {}) if isinstance(summary, dict) else {}
        if not isinstance(rows, dict):
            continue
        for name, row in rows.items():
            if isinstance(row, dict) and all(_finite(row.get(key)) and row[key] >= 0
                                             for key in ("kills", "headshot_kills", "damage")):
                for key in ("kills", "headshot_kills", "damage"):
                    result[str(name)][key] += row[key]
    return dict(sorted(result.items()))


def _dataset_summary(validated):
    matches = validated["matches"]
    rounds = [row for match in matches for row in match["rounds"]]
    by_map = defaultdict(list)
    for match in matches:
        by_map[str(match.get("map_name") or "unknown")].append(match)
    recent, previous = _period(matches[:30]), _period(matches[30:60])
    verified = validated["chronology"]["basis"] == "verified_match_time"
    deltas = ({key: round(recent[key] - previous[key], 2) for key in ("adr", "kast_pct")}
              if verified and recent["rounds"] and previous["rounds"] else None)
    return {
        "matches_analyzed": len(matches), "rounds_analyzed": len(rounds),
        "aggregate": _aggregate(rounds),
        "by_map": {name: _period(group) for name, group in sorted(by_map.items())},
        "by_side": {side: _aggregate([row for row in rounds if row["side"] == side]) for side in ("T", "CT")},
        "by_weapon": _weapons(matches),
        "comparison": {"basis": validated["chronology"]["basis"], "trend_supported": deltas is not None,
                       "recent30": recent, "previous30": previous, "deltas": deltas},
    }


def _ai_coach():
    return {"status": "not_configured", "provider": "openai", "model": None,
            "analysis": None, "message": "尚未连接 ChatGPT API；当前训练建议由可核验的 Demo 规则生成。"}


def _training_plan(matches):
    linked = [(match["match_id"], row) for match in matches for row in match["rounds"]]
    rounds = len(linked)
    sufficient = len(matches) >= 5 and rounds >= 100
    priorities = []

    def add(kind, title, selected, observation, exercise, success_measure):
        if not selected:
            return
        priorities.append({
            "id": kind, "title": title, "evidence_ids": [_evidence_id(mid, row["round_number"]) for mid, row in selected[:12]],
            "evidence_count": len(selected), "observation": observation,
            "exercise": exercise, "success_measure": success_measure,
            "sample_rounds": rounds, "confidence": "moderate" if sufficient else "low",
        })

    no_damage = [(mid, row) for mid, row in linked if row["deaths"] > 0 and row["damage"] == 0]
    deaths = sum(row["deaths"] for _, row in linked)
    add("review_zero_damage_deaths", "复盘零伤害阵亡", no_damage,
        f"在 {rounds} 个有效回合中，有 {len(no_damage)} 回合阵亡且未造成敌方 HP 伤害。该记录不能单独判断枪法或走位原因。",
        "逐个查看所列回合的接敌路径，记录首次交火前的掩体、可撤退路线与队友是否能支援；每次只选一个调整。",
        "接下来 5 场按相同口径记录零伤害阵亡回合数 / 有效回合数，检查所选调整是否奏效。")
    opening = [(mid, row) for mid, row in linked if row["opening_death"]]
    add("review_opening_deaths", "检查首个交火的准备", opening,
        f"观察到 {len(opening)} 次本人首死；这是回合首个有效敌方击杀的计数，不等于接敌机会成功率。",
        "回看列出的首死回合，标注接敌前是否有闪光、掩体和队友支援；下一场预先选定一个可重复的首个交火方案。",
        "在接下来 5 场记录首杀、首死及方案执行情况，再比较每百回合首死次数。")
    untraded = [(mid, row) for mid, row in linked if row["deaths"] > 0 and not row["traded"]]
    add("review_trade_spacing", "复盘阵亡后的补枪条件", untraded,
        f"{deaths} 次阵亡中，{len(untraded)} 个阵亡回合未观察到队友在 5 秒内击杀该击杀者；这不证明当时存在可补枪机会。",
        "与固定队友检查这些回合的前后距离和撤退路线，选一条常用进攻路线练习协同接敌与报点。",
        "后续 5 场同时记录补枪回合 / 阵亡回合，并人工注明当时是否具备补枪条件。")
    positive = [(mid, row) for mid, row in linked if row["kills"] >= 2]
    add("repeat_multi_kill_setup", "保留有效的接敌安排", positive,
        f"观察到 {len(positive)} 个多杀回合，可作为对照样本；多杀本身不能证明战术质量。",
        "对照零伤害阵亡回合，记录多杀回合的接敌距离、掩体与队友配合，选择一个可重复的安排进行训练。",
        "在后续比赛记录该安排的执行次数、存活与有效伤害，避免仅用击杀数评价执行。")
    return {
        "kind": "deterministic", "label": "Demo 规则训练计划", "generated_by_model": False,
        "sample_warning": (None if sufficient else "当前样本不足 5 场或 100 回合；建议用于逐回合复盘，不能据此确定长期水平或改善趋势。"),
        "sample_matches": len(matches), "sample_rounds": rounds,
        "priorities": priorities[:4],
    }


def _round(row, match_id, tickrate):
    result = {key: _clean(row.get(key)) for key in ROUND_FIELDS}
    result["evidence_id"] = _evidence_id(match_id, row["round_number"])
    start, end = row.get("start_tick"), row.get("end_tick")
    result["elapsed_seconds"] = round((end - start) / tickrate, 3) if (
        tickrate and _finite(start) and _finite(end) and end >= start) else None
    positions = []
    for point in row.get("positions", []) if isinstance(row.get("positions"), list) else []:
        if not isinstance(point, dict) or not all(_finite(point.get(key)) for key in ("tick", "x", "y", "z")):
            continue
        positions.append({key: point[key] for key in ("tick", "x", "y", "z")})
        if isinstance(point.get("place"), str):
            positions[-1]["place"] = point["place"][:80]
        positions[-1]["seconds"] = round((point["tick"] - start) / tickrate, 3) if tickrate and _finite(start) else None
    result["positions"] = positions
    analysis = row.get("analysis") if isinstance(row.get("analysis"), dict) else {}
    events = row.get("events", analysis.get("timeline"))
    result["events"] = _clean(events) if isinstance(events, list) else []
    for index, event in enumerate(result["events"]):
        if not isinstance(event, dict):
            continue
        event["evidence_id"] = f"{result['evidence_id']}:e{index}"
        event["seconds"] = (round((event["tick"] - start) / tickrate, 3)
                            if tickrate and _finite(start) and _finite(event.get("tick")) else None)
    for key in ("analysis", "economy", "aim", "utility", "movement", "positioning", "duels"):
        result[key] = _clean(row.get(key, analysis.get(key)))
    _encode_aim_trajectories(result["analysis"])
    return result


def _capabilities(analysis, rounds):
    """Availability follows observed denominators, never an analysis version alone."""
    analysis = analysis if isinstance(analysis, dict) else {}
    level2 = analysis.get("level2") if isinstance(analysis.get("level2"), dict) else {}
    level3 = analysis.get("level3") if isinstance(analysis.get("level3"), dict) else {}
    details = {}

    def add(key, status, reason, observations=None, denominator=None, definition=None):
        details[key] = {"status": status, "reason": reason, "observations": observations,
                        "denominator": denominator, "definition": definition}

    add("round_stats", "available", None, len(rounds), len(rounds), "Observed complete live rounds attributed to the configured Steam identity.")
    add("advanced", "available" if level2 or level3 else "not_captured",
        None if level2 or level3 else "legacy_result_requires_advanced_reparse",
        definition="Advanced fields were parsed; each metric retains its own coverage and availability.")
    points = sum(len(row["positions"]) for row in rounds)
    add("positions", "sampled" if points else "not_captured", None if points else "no_valid_self_position_samples", points,
        definition="Sparse world-coordinate self samples; neither exact path length nor visibility is established.")
    timeline_rounds = sum(isinstance(row.get("analysis"), dict) and isinstance(row["analysis"].get("timeline"), list) or bool(row["events"]) for row in rounds)
    add("timeline_events", "available" if timeline_rounds else "not_captured", None if timeline_rounds else "event_timeline_not_retained", timeline_rounds, len(rounds))
    shot_counts = [row["aim"]["firearm_shots"] for row in rounds if isinstance(row.get("aim"), dict) and _finite(row["aim"].get("firearm_shots"))]
    shot_speeds = [row["aim"]["shots_with_speed"] for row in rounds if isinstance(row.get("aim"), dict) and _finite(row["aim"].get("shots_with_speed"))]
    shots = sum(shot_counts) if shot_counts else None
    speeds = sum(shot_speeds) if shot_speeds else None
    add("aim", "available" if shots is not None else "not_captured", None if shots is not None else "weapon_fire_stream_not_observed", shots,
        definition="Observed firearm event count; this does not imply aim accuracy or view/velocity coverage.")
    add("shot_motion", "observed" if speeds else "unavailable", None if speeds else "no_shots_with_observed_velocity", speeds, shots,
        "Horizontal speed at observed firearm ticks; moving-shot percentages use only shots with speed.")
    economy_rounds = sum(isinstance(row.get("economy"), dict) and any(
        row["economy"].get(key) is not None for key in ("equipment_value", "balance", "armor", "helmet")) for row in rounds)
    add("economy", "available" if economy_rounds else "not_captured", None if economy_rounds else "no_observed_economy_state", economy_rounds, len(rounds))
    engagements = level2.get("engagements") if isinstance(level2.get("engagements"), dict) else {}
    episodes = engagements.get("observed_episodes")
    add("duels", "observed_subset" if _finite(episodes) else "not_captured", None if _finite(episodes) else "engagement_events_not_retained", episodes if _finite(episodes) else None,
        definition="Damage/kill-bounded firearm exchanges only; missed-only encounters and multi-opponent results cannot form a universal duel rating.")
    add("trade_success", "unavailable", "trade_opportunities_and_line_of_sight_not_verified", definition="Observed trade counts and traded-death rates are distinct from success per available trade opportunity.")
    for key in ("crosshair", "counter_strafe", "visibility", "preaim", "reaction"):
        metric = level3.get(key) if isinstance(level3.get(key), dict) else {}
        add(key, metric.get("status", "not_captured"), metric.get("reason", "advanced_metric_not_captured") if metric.get("status") not in {"observed", "estimated", "verified_provider"} else None,
            definition=metric.get("definition"))
    mechanics = level3.get("mechanics") if isinstance(level3.get("mechanics"), dict) else {}
    for key, denominator in (("targeting", "observed_bursts"), ("stopping", "eligible_opportunities"), ("spray", "bursts")):
        metric = mechanics.get(key) if isinstance(mechanics.get(key), dict) else {}
        add("mechanics_" + key, metric.get("status", "not_captured"), metric.get("reason"),
            metric.get(denominator), definition=metric.get("definition"))
    decision = level3.get("decision_quality") if isinstance(level3.get("decision_quality"), dict) else {}
    score_known = _finite(decision.get("score"))
    add("decision_quality", "heuristic" if score_known else "unavailable", None if score_known else decision.get("reason", "decision_evidence_not_captured"),
        decision.get("scored_rounds") if _finite(decision.get("scored_rounds")) else None, len(rounds),
        decision.get("definition") or "Limited disclosed evidence rubric; no professional or calibrated tactical rating.")
    return {key: row["status"] for key, row in details.items()}, details


def _guard_legacy_dense_motion(analysis, analysis_version):
    """Hide invalid 2.0 braking evidence while retaining valid shot events.

    demoparser2's sparse-tick velocity was unsuitable for the old dense stop
    model. Analysis 2.1 derives that motion from adjacent observed positions.
    Redact the copied observations as well as their aggregates so a filtered
    Dashboard cannot reconstruct the invalid stop values from legacy results.
    """
    if analysis_version != "2.0" or not isinstance(analysis, dict):
        return
    level3 = analysis.get("level3")
    counter = level3.get("counter_strafe") if isinstance(level3, dict) else None
    if not isinstance(counter, dict):
        return
    reason = "dense_motion_requires_analysis_2_1"
    counter["dense_motion_status"] = "unavailable"
    counter["dense_motion_reason"] = reason
    for field in ("median_stop_to_shot_ms", "observed_braking_shots", "complete_movement_windows"):
        counter[field] = None
    observations = counter.get("observations")
    for observation in observations if isinstance(observations, list) else []:
        if isinstance(observation, dict):
            for field in ("prior_peak_speed", "stop_tick", "stop_to_shot_ms"):
                observation[field] = None
            observation.update(status="unavailable", reason=reason)


def _export_replay(value):
    """Preserve bounded compressed frame strings beyond display-text limits."""
    if not isinstance(value, dict):
        return None
    from .replay import MAX_DECODED_ROUND_BYTES
    result = _clean(value)
    source_rounds = value.get("rounds")
    if not isinstance(source_rounds, list):
        return result
    for source, exported in zip(source_rounds, result.get("rounds", [])):
        frames = source.get("frames") if isinstance(source, dict) else None
        if not isinstance(frames, dict) or not isinstance(exported, dict):
            continue
        data, decoded_bytes = frames.get("data"), frames.get("decoded_bytes")
        if (frames.get("encoding") == "gzip-base64-json" and isinstance(data, str)
                and len(data) <= 4 * math.ceil(MAX_DECODED_ROUND_BYTES / 3)
                and re.fullmatch(r"[A-Za-z0-9+/]*={0,2}", data)
                and isinstance(decoded_bytes, int) and 0 <= decoded_bytes <= MAX_DECODED_ROUND_BYTES):
            exported["frames"]["data"] = data
        else:
            exported["frames"] = {"encoding": "unavailable", "count": 0, "reason": "invalid_compressed_replay_bounds"}
        shots = exported.get("shots")
        if isinstance(shots, list):
            exported["shots"] = _encode_detail(shots, count=len(shots))
    return result


def _match(match):
    match_id = match["match_id"]
    provenance = match.get("provenance") if isinstance(match.get("provenance"), dict) else {}
    tickrate = provenance.get("tickrate")
    tickrate = tickrate if _finite(tickrate) and tickrate > 0 else None
    rounds = [_round(row, match_id, tickrate) for row in match["rounds"]]
    summary = _aggregate(match["rounds"])
    summary.update({
        "wins": sum(row.get("won") is True for row in match["rounds"]),
        "by_side": {side: _aggregate([row for row in match["rounds"] if row["side"] == side]) for side in ("T", "CT")},
        "by_weapon": _weapons([match]),
    })
    analysis = _clean(match.get("analysis"))
    analysis_version = match.get("analysis_version") or (analysis.get("version") if isinstance(analysis, dict) else None)
    _guard_legacy_dense_motion(analysis, analysis_version)
    _encode_aim_trajectories(analysis)
    for row in rounds:
        _guard_legacy_dense_motion(row.get("analysis"), analysis_version)
    capabilities, capability_details = _capabilities(analysis, rounds)
    verified = _verified_time(match)
    players = _clean(match_players(match))
    for player in players:
        for row in player.get("rounds", []):
            row["evidence_id"] = f"{match_id}:p{player['steamid']}:r{row['round_number']}"
            for index, event in enumerate(row.get("events", [])):
                event["evidence_id"] = f"{row['evidence_id']}:e{index}"
                if "seconds" not in event:
                    event["seconds"] = (round((event["tick"] - row["start_tick"]) / tickrate, 4)
                                        if tickrate and _finite(event.get("tick")) and _finite(row.get("start_tick")) else None)
    return {
        "match_id": match_id, "map_name": str(match.get("map_name") or "unknown"),
        "match_started_at": verified.isoformat() if verified else None,
        "match_time_verified": verified is not None, "parsed_at": _utc(match.get("parsed_at")),
        "source": match["source"], "summary": summary, "rounds": rounds, "analysis": analysis,
        "replay": _export_replay(match.get("replay")),
        "players": players,
        "analysis_version": _clean(analysis_version),
        "capabilities": capabilities, "capability_details": capability_details,
        "provenance": {key: _clean(provenance[key]) for key in PROVENANCE_FIELDS if key in provenance},
        "limitations": _clean(match.get("limitations", [])),
        "training_plan": _training_plan([match]), "ai_coach": _ai_coach(),
    }


def generate_dashboard(data_dir: Path, reports_dir: Path, steamid: str, *, validated=None, snapshot=None) -> dict:
    """Write the authoritative index and complete-match files.

    The default timestamp reflects known source freshness, so identical inputs
    produce identical bytes. The receiving server records its own ingestion time.
    """
    data_dir, reports_dir = Path(data_dir), Path(reports_dir)
    validated = validated if validated is not None else load_validated_matches(data_dir, str(steamid))
    matches = validated["matches"]
    summary = _dataset_summary(validated)
    worker = _read(reports_dir / "demo_status.json")
    worker = worker if isinstance(worker, dict) else {}
    latest_parse = _latest([match.get("parsed_at") for match in matches])
    last_run = _utc(worker.get("last_run_at"))
    profile = matches[0].get("player", {}) if matches else {}
    exported_matches = [_match(match) for match in matches]
    result = {
        "schema_version": SCHEMA_VERSION,
        "generated_at": _latest([latest_parse, last_run, validated["gc_discovery"].get("last_checked_at")]),
        "profile": {"steamid64": str(steamid), "name": str(profile.get("name") or "CS2 Player")[:128]},
        "source": {"repository": __import__("os").environ.get("GITHUB_REPOSITORY", "__GITHUB_REPOSITORY__"), "analysis_version": ANALYSIS_VERSION,
                   "latest_parse_at": latest_parse, "match_time_basis": validated["chronology"]["basis"],
                   "official_match_coverage_known": False},
        "sync": {"last_run_at": last_run, "run_outcome": worker.get("run_outcome") if worker.get("run_outcome") in RUN_OUTCOMES else "unknown",
                 "attempted_this_run": worker.get("attempted_this_run") if isinstance(worker.get("attempted_this_run"), int) else None,
                 "completed_this_run": worker.get("completed_this_run") if isinstance(worker.get("completed_this_run"), int) else None,
                 "discovery": validated["gc_discovery"], "status_counts": validated["status_counts"],
                 "unfinished_jobs": validated["unfinished_jobs"]},
        **summary,
        **{key: validated[key] for key in ("chronology", "coverage", "excluded", "limitations")},
        "matches": exported_matches,
        "player_directory": _clean(build_player_directory(exported_matches, str(steamid))),
        "training_plan": _training_plan(matches), "ai_coach": _ai_coach(),
    }
    canonical = json.dumps(result, ensure_ascii=False, sort_keys=True, separators=(",", ":"), allow_nan=False)
    result["source"]["snapshot_sha256"] = hashlib.sha256(canonical.encode()).hexdigest()
    from .transport import export_dashboard_transport
    export_dashboard_transport(reports_dir, snapshot=result)
    # Remove a legacy monolith only after every exact match file, the index and
    # all bounded transport operations have exported successfully. Git stages
    # this deletion together with those replacements at the next checkpoint.
    (reports_dir / "dashboard.json").unlink(missing_ok=True)
    return result


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--root", type=Path, default=Path(__file__).resolve().parents[1])
    parser.add_argument("--steamid", default=os.getenv("STEAMID64", ""))
    args = parser.parse_args()
    steamid = args.steamid
    if not steamid:
        account = _read(args.root / "data" / "account.json")
        steamid = str(account.get("steamid64", "")) if isinstance(account, dict) else ""
    if not re.fullmatch(r"7656119\d{10}", steamid):
        parser.error("A valid own SteamID64 is required")
    result = generate_dashboard(args.root / "data", args.root / "reports", steamid)
    print(f"Dashboard export: {result['matches_analyzed']} verified own matches, {result['rounds_analyzed']} observed live rounds")


if __name__ == "__main__":
    main()
