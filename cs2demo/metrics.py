"""Deterministic, self-only metrics from demoparser2 event records.

All windows are inclusive from freeze end through the normal round_end event.
This deliberately excludes warmup, post-round farming and unfinished rounds.
"""

from __future__ import annotations

from collections import defaultdict
import math
from typing import Any, Mapping, Sequence

SIDES = {2: "T", 3: "CT"}
NORMAL_END_REASONS = {1, 7, 8, 9, 10, 11, 12, 13}
# demoparser2 synthesizes these string enums for modern Source 2 demos.
# Mapping verified against src/parser/src/maps.rs::ROUND_WIN_REASON.
ROUND_REASON_CODES = {
    "still_in_progress": 0, "bomb_exploded": 1, "vip_escaped": 2,
    "vip_killed": 3, "t_saved": 4, "ct_stopped_escape": 5,
    "RoundEndReasonTerroristsStopped": 6, "bomb_defused": 7,
    "t_killed": 8, "ct_killed": 9, "draw": 10, "hostage_rescued": 11,
    "time_ran_out": 12, "RoundEndReasonHostagesNotRescued": 13,
    "terrorists_not_escaped": 14, "vip_not_escaped": 15,
    "game_start": 16, "t_surrender": 17, "ct_surrender": 18,
    "t_planted": 19, "ct_reached_hostage": 20,
}


def number(value: Any) -> float | None:
    if value is None or isinstance(value, bool):
        return None
    try:
        result = float(value)
    except (TypeError, ValueError):
        return None
    return result if math.isfinite(result) else None


def steam_id(value: Any) -> str | None:
    # Never round-trip SteamID64 through float: it loses identity precision.
    if value is None or isinstance(value, (float, bool)):
        return None
    result = str(value)
    return result if result.isdigit() and result != "0" else None


def _team(value: Any) -> int | None:
    if value in ("T", "CT"):
        return 2 if value == "T" else 3
    value = number(value)
    return int(value) if value in SIDES else None


def round_reason(value: Any) -> float | int | None:
    return ROUND_REASON_CODES.get(value) if isinstance(value, str) and value in ROUND_REASON_CODES else number(value)


def _enemy(event: Mapping[str, Any]) -> bool:
    attacker = steam_id(event.get("attacker_steamid"))
    victim = steam_id(event.get("user_steamid"))
    team = _team(event.get("attacker_team_num"))
    victim_team = _team(event.get("user_team_num"))
    return bool(attacker and victim and attacker != victim and team and victim_team and team != victim_team)


def _live(event: Mapping[str, Any]) -> bool:
    warmup = event.get("is_warmup_period")
    return warmup is False or (isinstance(warmup, (int, float)) and not isinstance(warmup, bool) and warmup == 0)


def round_windows(events: Mapping[str, Sequence[dict]]) -> tuple[list[dict], list[str]]:
    """Require an observed live start and a completed ordinary game round."""
    starts = sorted((e for e in events.get("round_freeze_end", []) if _live(e)), key=lambda e: e["tick"])
    ends = sorted((e for e in events.get("round_end", []) if _live(e)), key=lambda e: e["tick"])
    windows, limitations = [], []
    for index, start in enumerate(starts):
        next_tick = starts[index + 1]["tick"] if index + 1 < len(starts) else math.inf
        start_count = number(start.get("total_rounds_played"))
        if start_count is None or start_count < 0 or not start_count.is_integer():
            limitations.append("Excluded a round start with an unknown completed-round counter.")
            continue
        matching = [e for e in ends if start["tick"] <= e["tick"] < next_tick
                    and number(e.get("total_rounds_played")) in {start_count, start_count + 1}]
        if not matching:
            limitations.append("Excluded a round with no observed normal round end (truncated/incomplete demo).")
            continue
        end = matching[0]
        if round_reason(end.get("reason")) not in NORMAL_END_REASONS:
            limitations.append("Excluded a surrender, restart or unsupported round-end reason.")
            continue
        windows.append({"round_number": int(start["total_rounds_played"]) + 1,
                        "start_tick": int(start["tick"]), "end_tick": int(end["tick"]),
                        "winner": _team(end.get("winner"))})
    if len(ends) > len(windows):
        limitations.append("Round ends without a complete live freeze-end/end pair were excluded.")
    return windows, sorted(set(limitations))


def _aggregate(rounds: Sequence[dict]) -> dict:
    total = {name: sum(int(r[name]) for r in rounds)
             for name in ("kills", "deaths", "assists", "damage", "headshot_kills")}
    count = len(rounds)
    total.update(rounds=count, wins=sum(r["won"] is True for r in rounds),
                 kast_rounds=sum(bool(r["kast"]) for r in rounds),
                 opening_kills=sum(bool(r["opening_kill"]) for r in rounds),
                 opening_deaths=sum(bool(r["opening_death"]) for r in rounds))
    total["adr"] = round(total["damage"] / count, 2) if count else None
    total["headshot_pct"] = round(100 * total["headshot_kills"] / total["kills"], 2) if total["kills"] else None
    total["kast_pct"] = round(100 * total["kast_rounds"] / count, 2) if count else None
    return total


def calculate_metrics(events: Mapping[str, Sequence[dict]], samples: Sequence[dict], steamid: str,
                      *, tickrate: float = 64.0, trade_window_seconds: float = 5.0) -> dict:
    """Compute counts only for the requested identity and observed participating rounds."""
    if not math.isfinite(tickrate) or tickrate <= 0 or trade_window_seconds <= 0:
        raise ValueError("tickrate and trade window must be positive")
    windows, limitations = round_windows(events)
    self_samples = [s for s in samples if steam_id(s.get("steamid")) == steamid]
    by_tick = {int(s["tick"]): s for s in self_samples}
    deaths = sorted(events.get("player_death", []), key=lambda e: e["tick"])
    hurts = sorted(events.get("player_hurt", []), key=lambda e: e["tick"])
    weapons = defaultdict(lambda: {"kills": 0, "headshot_kills": 0, "damage": 0})
    rounds = []
    for window in windows:
        start, end = window["start_tick"], window["end_tick"]
        state = by_tick.get(start)
        if not state or state.get("is_alive") is not True or _team(state.get("team_num")) is None:
            limitations.append("Excluded rounds where the target was not observed alive on T/CT at freeze end.")
            continue
        side_num = _team(state["team_num"])
        round_deaths = [e for e in deaths if start <= e["tick"] <= end and _live(e)]
        if any(steam_id(e.get("attacker_steamid")) == steamid and steam_id(e.get("user_steamid"))
               and (_team(e.get("attacker_team_num")) is None or _team(e.get("user_team_num")) is None)
               for e in round_deaths):
            limitations.append("Some target kill events lacked team metadata and could not be classified as enemy kills.")
        enemy_deaths = [e for e in round_deaths if _enemy(e)]
        kills = [e for e in enemy_deaths if steam_id(e.get("attacker_steamid")) == steamid]
        own_deaths = [e for e in round_deaths if steam_id(e.get("user_steamid")) == steamid]
        assists = [e for e in enemy_deaths if steam_id(e.get("assister_steamid")) == steamid
                   and steam_id(e.get("attacker_steamid")) != steamid]
        opening = enemy_deaths[0] if enemy_deaths else {}
        traded = False
        for death in own_deaths:
            killer = steam_id(death.get("attacker_steamid"))
            if not _enemy(death):
                continue
            for revenge in enemy_deaths:
                delta = revenge["tick"] - death["tick"]
                if 0 <= delta <= trade_window_seconds * tickrate and steam_id(revenge.get("user_steamid")) == killer:
                    if _team(revenge.get("attacker_team_num")) == side_num:
                        traded = True
                        break
        # Track every victim's remaining health, including damage from other players.
        # Event health is post-hit; dmg_health may exceed the actual remaining HP.
        remaining = defaultdict(lambda: 100)
        damage = 0
        for hurt in hurts:
            if not (start <= hurt["tick"] <= end and _live(hurt)):
                continue
            victim = steam_id(hurt.get("user_steamid"))
            raw = number(hurt.get("dmg_health"))
            after = number(hurt.get("health"))
            if not victim or raw is None or raw < 0:
                limitations.append("Some hurt events lacked a valid identity/damage and were excluded.")
                continue
            effective = int(min(raw, max(0, remaining[victim])))
            remaining[victim] = max(0, int(after)) if after is not None else max(0, remaining[victim] - effective)
            if after is None:
                limitations.append("Some damage was capped with reconstructed HP because the hurt event lacked remaining health.")
            if steam_id(hurt.get("attacker_steamid")) == steamid and _enemy(hurt):
                damage += effective
                weapons[str(hurt.get("weapon") or "unknown")]["damage"] += effective
            elif steam_id(hurt.get("attacker_steamid")) == steamid and victim != steamid and (
                    _team(hurt.get("attacker_team_num")) is None or _team(hurt.get("user_team_num")) is None):
                limitations.append("Some target damage events lacked team metadata and could not be classified as enemy damage.")
        for kill in kills:
            weapon = weapons[str(kill.get("weapon") or "unknown")]
            weapon["kills"] += 1
            weapon["headshot_kills"] += int(bool(kill.get("headshot")))
        positions = []
        for sample in self_samples:
            if start <= sample["tick"] <= end and sample.get("is_alive") is True:
                xyz = [number(sample.get(axis)) for axis in ("X", "Y", "Z")]
                if all(value is not None for value in xyz):
                    positions.append({"tick": int(sample["tick"]), **dict(zip(("x", "y", "z"), xyz))})
        survived = not own_deaths
        rounds.append({**window, "side": SIDES[side_num], "won": side_num == window["winner"] if window["winner"] else None,
                       "kills": len(kills), "deaths": len(own_deaths), "assists": len(assists), "damage": damage,
                       "headshot_kills": sum(bool(e.get("headshot")) for e in kills),
                       "opening_kill": steam_id(opening.get("attacker_steamid")) == steamid,
                       "opening_death": steam_id(opening.get("user_steamid")) == steamid,
                       "survived": survived, "traded": traded,
                       "kast": bool(kills or assists or survived or traded), "positions": positions})
    if not rounds:
        raise ValueError("No complete live rounds with the target player participating were found")
    if len({r["round_number"] for r in rounds}) != len(rounds):
        raise ValueError("Repeated round numbers after a match restart are unsupported; refusing to merge games")
    summary = _aggregate(rounds)
    summary["by_side"] = {side: _aggregate([r for r in rounds if r["side"] == side])
                          for side in ("T", "CT") if any(r["side"] == side for r in rounds)}
    summary["by_weapon"] = dict(sorted(weapons.items()))
    return {"rounds": rounds, "summary": summary, "limitations": sorted(set(limitations))}
