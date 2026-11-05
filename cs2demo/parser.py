"""CS2 .dem adapter, verified with demoparser2 0.42.0 on Python 3.12."""

from __future__ import annotations

import hashlib
from importlib.metadata import version
from pathlib import Path
import re
from statistics import median

from .metrics import calculate_metrics, number, round_windows, steam_id, ROUND_REASON_CODES
from .advanced import ANALYSIS_VERSION, BURST_GAP_SECONDS, FIREARMS, _weapon, calculate_advanced
from .replay import replay_ticks, build_replay
from .tactical import PROJECTILES
from .mechanics import calculate_mechanics, target_sample_ticks
from .players import build_player_stats

SCHEMA_VERSION = "1.0"
TRADE_WINDOW_SECONDS = 5.0
POSITION_SAMPLE_SECONDS = 2.0
EVENTS = ["round_freeze_end", "round_end", "player_death", "player_hurt"]
OPTIONAL_EVENTS = ["weapon_fire", "player_blind", "flashbang_detonate", "smokegrenade_detonate",
                   "round_prestart", "round_start", "round_officially_ended",
                   "hegrenade_detonate", "inferno_startburn", "smokegrenade_expired", "inferno_expire",
                   "decoy_started", "decoy_expired", "bomb_beginplant", "bomb_abortplant", "bomb_planted",
                   "bomb_begindefuse", "bomb_abortdefuse", "bomb_dropped", "bomb_pickup",
                   "bomb_defused", "bomb_exploded", "bullet_impact", "fire_bullets"]
EVENT_PLAYER_FIELDS = ["team_num", "X", "Y", "Z", "last_place_name", "velocity_X", "velocity_Y",
                       "is_airborne", "pitch", "yaw", "health", "armor_value"]
SAMPLE_FIELDS = ["X", "Y", "Z", "team_num", "is_alive", "last_place_name",
                 "current_equip_value", "balance", "armor_value", "has_helmet"]
DENSE_SAMPLE_FIELDS = ["X", "Y", "Z", "pitch", "yaw",
                       "is_alive", "team_num", "is_airborne", "aim_punch_angle",
                       "shots_fired", "accuracy_penalty", "fl_recoil_idx", "duck_amount", "health",
                       "CCSPlayerPawn.CBodyComponentBaseAnimGraph.m_angRotation"]
TARGET_SAMPLE_FIELDS = ["X", "Y", "Z", "yaw", "pitch", "is_alive", "team_num", "is_airborne", "duck_amount", "health",
                        "CCSPlayerPawn.CBodyComponentBaseAnimGraph.m_angRotation"]
REPLAY_SAMPLE_FIELDS = ["X", "Y", "Z", "yaw", "pitch", "is_alive", "team_num", "inventory", "health", "armor_value"]


class RoundMetadataError(ValueError):
    def __init__(self, events):
        super().__init__("No complete live rounds were found in this demo")
        self.diagnostics = {}
        for name in ("round_freeze_end", "round_end"):
            rows = events.get(name, [])
            samples = rows[:3] + rows[-3:]
            self.diagnostics[name] = {
                "count": len(rows),
                "warmup_false": sum(e.get("is_warmup_period") is False for e in rows),
                "warmup_true": sum(e.get("is_warmup_period") is True for e in rows),
                "samples": [{key: (row.get(key) if isinstance(row.get(key), bool)
                                    or row.get(key) in tuple(ROUND_REASON_CODES) + ("T", "CT") else number(row.get(key)))
                             for key in ("tick", "is_warmup_period", "total_rounds_played", "reason", "winner")}
                            for row in samples],
            }


def _validate_events(events: dict[str, list[dict]]) -> None:
    common = {"tick", "is_warmup_period", "total_rounds_played"}
    fields = {
        "round_freeze_end": common,
        "round_end": common | {"winner", "reason"},
        "player_death": common | {"attacker_steamid", "user_steamid", "assister_steamid", "attacker_team_num", "user_team_num", "headshot"},
        "player_hurt": common | {"attacker_steamid", "user_steamid", "attacker_team_num", "user_team_num", "dmg_health", "health"},
    }
    for name, rows in events.items():
        if name in fields and rows and not fields[name].issubset(rows[0]):
            missing = sorted(fields[name] - rows[0].keys())
            raise ValueError(f"Demo event {name} lacks required fields: {', '.join(missing)}")


def _tickrate(events: dict[str, list[dict]]) -> tuple[float, str]:
    points = sorted({(int(e["tick"]), number(e.get("game_time")))
                     for rows in events.values() for e in rows if number(e.get("game_time")) is not None})
    ratios = [(b[0] - a[0]) / (b[1] - a[1]) for a, b in zip(points, points[1:])
              if b[0] > a[0] and b[1] - a[1] >= 1]
    plausible = [ratio for ratio in ratios if 16 <= ratio <= 256]
    if len(plausible) >= 2:
        return round(median(plausible), 4), "median event tick/game_time deltas"
    return 64.0, "assumed CS2 default; insufficient game_time observations"


def _guard_event_velocity(events, tickrate):
    """The pinned event parser's position-derived velocity hardcodes 64Hz."""
    supported = abs(tickrate - 64.0) <= .001
    if not supported:
        for rows in events.values():
            for row in rows:
                for key in tuple(row):
                    if key.endswith(("_velocity_X", "_velocity_Y", "_velocity_Z")):
                        row[key] = None
    return {"status": "estimated" if supported else "unavailable",
            "reason": None if supported else "pinned_event_parser_velocity_requires_64hz",
            "definition": "demoparser2 0.42.0 full-event parsing keeps consecutive position history and multiplies its previous-position difference by 64. It is a lagged server-demo estimate, not client input or exact subtick velocity. Non-64Hz event motion is unavailable."}


def _dense_ticks(events, windows, steamid, tickrate):
    """Bound crosshair/movement windows and keep actual shot ticks first."""
    own_shots = sorted((e for e in events.get("weapon_fire", [])
                        if steam_id(e.get("user_steamid")) == steamid and _weapon(e.get("weapon")) in FIREARMS
                        and e.get("is_warmup_period") in (False, 0)
                        and any(w["start_tick"] <= e["tick"] <= w["end_tick"] for w in windows)), key=lambda e: e["tick"])
    bursts = []
    previous = None
    for shot in own_shots:
        if previous is None or _weapon(shot.get("weapon")) != _weapon(previous.get("weapon")) or shot["tick"] - previous["tick"] > BURST_GAP_SECONDS * tickrate:
            bursts.append([shot])
        else:
            bursts[-1].append(shot)
        previous = shot
    requested = {int(e["tick"]) for e in own_shots}
    for burst in bursts[:512]:
        shot = burst[0]
        window = next(w for w in windows if w["start_tick"] <= shot["tick"] <= w["end_tick"])
        lower = max(window["start_tick"], int(shot["tick"] - tickrate) - 1)
        upper = min(window["end_tick"], int(burst[-1]["tick"] + tickrate * .25))
        requested.update(range(lower, upper + 1))
    exact = sorted({int(e["tick"]) for e in own_shots})[:80000]
    selected = sorted(set(exact) | set(sorted(requested - set(exact))[:max(0, 80000 - len(exact))]))
    return selected, {"interval_ticks": 1, "pre_seconds": 1.0, "post_seconds": .25, "support_ticks": 1, "burst_limit": 512,
                      "requested_bursts": len(bursts), "selected_bursts": min(512, len(bursts)),
                      "requested_ticks": len(requested), "selected_ticks": len(selected),
                      "max_ticks": 80000, "full_burst_duration": True,
                      "truncated": len(bursts) > 512 or len(requested) > len(selected)}


def parse_demo(path: Path, steamid: str, *, progress=None) -> dict:
    """Return JSON-serializable personal stats; reject absent/ambiguous identity."""
    steamid = str(steamid)
    if not re.fullmatch(r"7656119\d{10}", steamid):
        raise ValueError("steamid must be a SteamID64 (17 decimal digits)")
    path = Path(path)
    if not path.is_file():
        raise FileNotFoundError(path)
    with path.open("rb") as handle:
        if handle.read(8) != b"PBDEMS2\x00":
            raise ValueError("Input is not an uncompressed CS2 Source 2 demo")
    try:
        from demoparser2 import DemoParser
    except ImportError as exc:
        raise RuntimeError("Install the pinned demoparser2 dependency before parsing demos") from exc
    report = progress or (lambda stage: None)
    report("header")
    parser = DemoParser(str(path))
    header = parser.parse_header()
    report("player_info")
    info = parser.parse_player_info().to_dict("records")
    target = next((row for row in info if steam_id(row.get("steamid")) == steamid), None)
    if target is None:
        raise ValueError("Configured SteamID64 was not found in this demo; refusing to attribute another player's stats")
    report("events")
    parsed = parser.parse_events(EVENTS + OPTIONAL_EVENTS, player=EVENT_PLAYER_FIELDS,
                                 other=["total_rounds_played", "is_warmup_period", "game_time"])
    events = {name: frame.to_dict("records") for name, frame in parsed}
    available_events = {name for name, rows in events.items() if rows}
    for name in EVENTS:
        events.setdefault(name, [])
    _validate_events(events)
    tickrate, tickrate_source = _tickrate(events)
    event_velocity = _guard_event_velocity(events, tickrate)
    windows, _ = round_windows(events)
    ticks = sorted({tick for window in windows
                    for tick in range(window["start_tick"], window["end_tick"] + 1,
                                      max(1, round(tickrate * POSITION_SAMPLE_SECONDS)))})
    if not ticks:
        raise RoundMetadataError(events)
    # Sparse roster snapshots support economy and teammate spacing. High-rate
    # radar replay is separately sampled and compressed after personal metrics.
    report("positions")
    samples = parser.parse_ticks(SAMPLE_FIELDS, ticks=ticks).to_dict("records")
    report("metrics")
    result = calculate_metrics(events, samples, steamid, tickrate=tickrate,
                               trade_window_seconds=TRADE_WINDOW_SECONDS)
    report("all_player_metrics")
    players = build_player_stats(events, samples, result["rounds"], info, steamid, tickrate=tickrate,
                                 trade_window_seconds=TRADE_WINDOW_SECONDS, available_events=available_events)
    report("advanced_metrics")
    analysis = calculate_advanced(events, samples, result["rounds"], steamid, tickrate=tickrate,
                                  sample_seconds=POSITION_SAMPLE_SECONDS,
                                  trade_window_seconds=TRADE_WINDOW_SECONDS, available_events=available_events)
    report("crosshair_windows")
    dense_ticks, dense_sampling = _dense_ticks(events, result["rounds"], steamid, tickrate)
    dense_samples = parser.parse_ticks(DENSE_SAMPLE_FIELDS, players=[int(steamid)], ticks=dense_ticks).to_dict("records") if dense_ticks else []
    from .l3 import calculate_l3
    analysis["level3"].update(calculate_l3(events, dense_samples, result["rounds"], steamid,
                                          tickrate=tickrate, available_events=available_events,
                                          map_identity=header.get("map_name"), sampling=dense_sampling))
    report("mechanics_targets")
    target_ticks, target_sampling = target_sample_ticks(events, result["rounds"], steamid, tickrate)
    target_samples = parser.parse_ticks(TARGET_SAMPLE_FIELDS, ticks=target_ticks).to_dict("records") if target_ticks else []
    analysis["level3"]["mechanics"] = calculate_mechanics(events, dense_samples, target_samples, result["rounds"],
                                                         steamid, tickrate=tickrate)
    analysis["level3"]["mechanics"]["coverage"]["target_sampling"] = target_sampling
    del target_samples, dense_samples
    report("radar_replay")
    from .native_animation import recording_bounds
    recording = recording_bounds(path)
    recording_end_tick = recording["recording_end_tick"]
    radar_ticks, radar_sampling = replay_ticks(result["rounds"], events, tickrate,
                                               recording_end_tick=recording_end_tick)
    radar_samples = parser.parse_ticks(REPLAY_SAMPLE_FIELDS, ticks=radar_ticks).to_dict("records")
    report("tactical_replay")
    grenade_status = "not_observed"
    grenade_samples = []
    try:
        grenade_frame = parser.parse_grenades()
        required = {"grenade_type", "grenade_entity_id", "tick", "x", "y", "z", "steamid"}
        if required.issubset(grenade_frame.columns):
            grenade_frame = grenade_frame[grenade_frame["grenade_type"].isin(PROJECTILES)
                                            & grenade_frame[["x", "y", "z"]].notna().all(axis=1)]
            grenade_samples = grenade_frame.to_dict("records")
            grenade_status = "observed" if grenade_samples else "not_observed"
        else:
            grenade_status = "unavailable"
        del grenade_frame
    except Exception:
        # Optional projectile telemetry must not discard valid match metrics.
        grenade_status = "unavailable"
    replay = build_replay(events, radar_samples, result["rounds"], info, steamid,
                          tickrate=tickrate, sampling=radar_sampling,
                          grenades=grenade_samples, grenade_status=grenade_status,
                          recording_end_tick=recording_end_tick)
    del radar_samples, grenade_samples
    with path.open("rb") as handle:
        digest = hashlib.file_digest(handle, "sha256").hexdigest()
    limitations = result["limitations"] + [
        "Counts cover observed live rounds only (freeze end through round end); warmup, post-round events, surrenders and incomplete rounds are excluded. They can differ from the final in-game scoreboard.",
        "Damage is enemy HP damage capped at remaining HP; each competitive round starts from 100 HP. Armor and team damage are excluded.",
        "KAST uses credited assists including flash assists; traded means the enemy killer is killed by a teammate within 5 seconds in the same live round.",
        "Positions are raw world coordinates sampled every 2 seconds while alive; travel is a sampled lower bound and spacing ignores walls, visibility and route length. No tactical position rating is inferred.",
        "Aim observations describe firearm events, movement and airborne state at the shot tick; movement speed and sampled crosshair paths alone are not accuracy or counter-strafe quality scores.",
        "Enemy visibility, preaim target error and reaction time require verified map geometry and matching timestamps; they remain unavailable when that evidence is absent.",
        "Flash seconds sum event-reported blind durations per victim; overlapping flashes can double count and do not establish fully blind time or flash quality.",
        "Absent optional event streams are marked not_observed and unavailable metrics are null; missing events must not be interpreted as perfect aim or zero utility use.",
        "The demo header has no verified match timestamp; ingestion time must not be used as match chronology.",
        "Bot or unknown Steam identities are excluded from enemy events; only standard competitive rounds are supported.",
    ]
    if tickrate_source.startswith("assumed"):
        limitations.append("Tickrate was assumed at 64; the trade/position windows may be inaccurate on a nonstandard server.")
    return {"schema_version": SCHEMA_VERSION, "analysis_version": ANALYSIS_VERSION, "map_name": header.get("map_name"),
            "player": {"steamid": steamid, "name": target.get("name")},
            "rounds": result["rounds"], "summary": result["summary"], "analysis": analysis,
            "players": players,
            "replay": replay,
            "limitations": sorted(set(limitations)),
            "provenance": {"parser": "demoparser2", "parser_version": version("demoparser2"),
                           "source_sha256": digest, "source_bytes": path.stat().st_size,
                           "tickrate": tickrate, "tickrate_source": tickrate_source,
                           "trade_window_seconds": TRADE_WINDOW_SECONDS,
                           "position_sample_seconds": POSITION_SAMPLE_SECONDS,
                           "analysis_version": ANALYSIS_VERSION,
                           "dense_sampling": dense_sampling,
                           "replay_sampling": replay["coverage"],
                           "recording_bounds": recording,
                           "event_velocity": event_velocity,
                           "dense_velocity_definition": "Own alive X/Y position difference divided by actual adjacent selected-tick time; same live round and tick gap <= sampling interval. Interval-average motion; filtered parser velocity properties are not requested.",
                           "round_filter": "observed freeze_end + normal round_end; target alive on T/CT at freeze_end; live interval only",
                           "damage_definition": "enemy effective HP damage; min(raw damage, victim remaining HP)",
                           "headshot_definition": "enemy headshot kills / enemy kills; null when no kills"}}
