"""Bounded, observed all-player radar, shot/impact and health evidence.

Frames are compact gzip/base64 JSON to avoid multiplying the Dashboard's size
when report files are indented. No coordinate interpolation or ballistic model
is used. A killer/victim connection is explicitly distinct from a bullet ray.
"""
from __future__ import annotations

import base64
from collections import Counter, defaultdict
import gzip
import hashlib
import json
import math

from .metrics import _live, _team, number, steam_id, round_reason
from .advanced import FIREARMS
from .tactical import build_tactical, tactical_ticks

VERSION = "1.3"
SAMPLE_HZ = 16.0
MAX_FRAMES = 40000
MAX_PLAYERS = 32
MAX_KILLS = 2048
MAX_IMPACTS_PER_KILL = 16
MAX_SHOTS = 32768
MAX_BULLET_IMPACTS = 131072
MAX_DAMAGE_EVENTS = 32768
MAX_IMPACTS_PER_SHOT = 64
MAX_HURTS_PER_SHOT = 32
MAX_DECODED_ROUND_BYTES = 8 * 1024 * 1024
PLAYER_FIELDS = ["player_index", "x", "y", "z", "yaw", "pitch", "alive", "team", "health", "armor"]


def _tick(value):
    value = number(value)
    return int(value) if value is not None and value >= 0 and value == int(value) else None


def _q(value):
    value = number(value)
    return round(value, 1) if value is not None else None


def _xyz(row, prefix="", *, impact=False):
    keys = ("x", "y", "z") if impact else ("X", "Y", "Z")
    point = [_q(row.get(prefix + key)) for key in keys]
    return point if all(value is not None for value in point) else None


def _stat(value):
    value = number(value)
    return int(value) if value is not None and 0 <= value <= 100 and value == int(value) else None


def _origin(row, prefix="user_"):
    """Use only reported coordinates, never a yaw ray or assumed view height."""
    eye = [_q(row.get(prefix + key)) for key in ("eye_X", "eye_Y", "eye_Z")]
    if all(value is not None for value in eye):
        return eye, "observed_eye_position"
    point = _xyz(row, prefix)
    return point, "observed_player_origin" if point else None


def _firearm(row):
    return str(row.get("weapon") or "").removeprefix("weapon_") in FIREARMS


def _in_round(row, rounds):
    tick = _tick(row.get("tick"))
    return tick is not None and _live(row) and any(r["start_tick"] <= tick <= r["end_tick"] for r in rounds)


def _identity(row, prefix=""):
    raw = row.get(prefix + "steamid")
    sid = steam_id(raw)
    if sid:
        return sid
    name = row.get(prefix + "name")
    # A floating-point SteamID is not a bot and must never be rounded into an
    # account. Anonymous bots can be displayed using their Demo names only.
    if raw in (None, 0, "0") and isinstance(name, str) and name.strip():
        return "bot:" + hashlib.sha256(name.encode()).hexdigest()[:16]
    return None


def replay_windows(rounds, events, *, recording_end_tick=None):
    """Keep the post-decision tail without changing official metric rounds.

    A new prestart/start resets entities, so the preceding playback owns ticks
    only through boundary - 1. The final round can use the actual recording end;
    no fixed nominal round-end delay or invented extra footage is appended.
    """
    boundaries = []
    for priority, name in enumerate(("round_prestart", "round_start", "round_officially_ended")):
        for event in events.get(name, []):
            tick = _tick(event.get("tick"))
            if tick is not None and _live(event):
                boundaries.append((tick, priority, name))
    boundaries.sort()
    recording_end_tick = _tick(recording_end_tick)
    ordered = sorted(rounds, key=lambda row: row["start_tick"])
    output = []
    for index, row in enumerate(ordered):
        start = _tick(row.get("start_tick"))
        decision = _tick(row.get("decision_tick", row.get("end_tick")))
        if start is None or decision is None or decision < start:
            continue
        next_start = _tick(ordered[index + 1].get("start_tick")) if index + 1 < len(ordered) else None
        future_freezes = [tick for event in events.get("round_freeze_end", [])
                          if _live(event) and (tick := _tick(event.get("tick"))) is not None and tick > decision]
        if future_freezes:
            next_start = min(future_freezes + ([next_start] if next_start is not None else []))
        candidates = [entry for entry in boundaries if decision < entry[0]
                      and (next_start is None or entry[0] <= next_start)]
        resets = [entry for entry in candidates if entry[1] < 2]
        boundary = (resets or candidates)[0] if candidates else None
        end, source = decision, "live_end_only"
        if boundary:
            end, source = boundary[0] - 1, boundary[2]
        elif next_start is None and recording_end_tick is not None and recording_end_tick >= decision:
            end, source = recording_end_tick, "recording_end"
        if recording_end_tick is not None:
            end = min(end, max(decision, recording_end_tick))
        phases = [{"phase": "live", "start_tick": start, "end_tick": decision}]
        if end > decision:
            phases.append({"phase": "post_round", "start_tick": decision + 1, "end_tick": end})
        output.append({**row, "start_tick": start, "end_tick": end, "decision_tick": decision,
                       "live_end_tick": decision, "playback_end_tick": end,
                       "playback_end_source": source,
                       "next_round_start_tick": boundary[0] if boundary and boundary[1] < 2 else None,
                       "phases": phases})
    return output


def replay_ticks(rounds, events, tickrate, *, max_frames=MAX_FRAMES, recording_end_tick=None):
    """Select regular ticks plus exact kill, shot, impact and health ticks.

    Standard games request 16Hz. A long overtime game can exceed the fixed frame
    budget; then a uniform coarser interval is disclosed and all kill ticks are
    retained. No unobserved intermediate positions are created.
    """
    if not number(tickrate) or tickrate <= 0:
        raise ValueError("tickrate must be finite and positive")
    interval = max(1, round(tickrate / SAMPLE_HZ))
    valid = [row for row in replay_windows(rounds, events, recording_end_tick=recording_end_tick) if _tick(row.get("start_tick")) is not None
             and _tick(row.get("end_tick")) is not None and row["end_tick"] >= row["start_tick"]]
    deaths = [event for event in events.get("player_death", []) if _tick(event.get("tick")) is not None and _live(event)
              and any(row["start_tick"] <= event["tick"] <= row["end_tick"] for row in valid)][:MAX_KILLS]
    exact_tactical, tactical_truncated = tactical_ticks(valid, events)
    essential = {int(event["tick"]) for event in deaths}
    essential.update(exact_tactical)
    essential.update(int(row[key]) for row in valid for key in ("start_tick", "end_tick"))
    essential.update(row["decision_tick"] for row in valid)
    essential.update(row["decision_tick"] + 1 for row in valid if row["end_tick"] > row["decision_tick"])
    if len(essential) > max_frames:
        raise ValueError("replay_required_ticks_exceed_frame_budget")
    shot_ticks = {int(row["tick"]) for name in ("weapon_fire", "bullet_impact", "player_hurt")
                  for row in events.get(name, []) if _in_round(row, valid)
                  and (name != "weapon_fire" or _firearm(row))}
    optional_ticks = sorted(shot_ticks - essential)
    available = max_frames - len(essential)
    shot_ticks_truncated = len(optional_ticks) > available
    if shot_ticks_truncated:
        optional_ticks = [optional_ticks[math.floor(index * len(optional_ticks) / available)]
                          for index in range(available)] if available else []
    essential.update(optional_ticks)
    requested_regular = sum((int(row["end_tick"]) - int(row["start_tick"])) // interval + 1 for row in valid)
    budget = max(1, max_frames - len(essential))
    selected_interval = max(interval, math.ceil(sum(int(row["end_tick"]) - int(row["start_tick"]) + 1 for row in valid) / budget))
    selected = set(essential)
    for row in valid:
        selected.update(range(int(row["start_tick"]), int(row["end_tick"]) + 1, selected_interval))
    trimmed = len(selected) > max_frames
    if trimmed:
        extras = sorted(selected - essential)
        remaining = max_frames - len(essential)
        selected = essential | {extras[math.floor(index * len(extras) / remaining)] for index in range(remaining)}
    return sorted(selected), {
        "requested_sample_hz": SAMPLE_HZ, "sample_hz": round(tickrate / selected_interval, 4),
        "interval_ticks": selected_interval, "base_interval_ticks": interval,
        "max_frames": max_frames, "requested_regular_frames": requested_regular,
        "selected_frames": len(selected), "exact_kill_ticks": len({int(row["tick"]) for row in deaths}),
        "exact_tactical_ticks": len(exact_tactical), "tactical_ticks_truncated": tactical_truncated,
        "exact_shot_impact_health_ticks": len(shot_ticks & essential),
        "requested_shot_impact_health_ticks": len(shot_ticks), "shot_ticks_truncated": shot_ticks_truncated,
        "truncated": selected_interval > interval or trimmed or tactical_truncated or shot_ticks_truncated,
        "reason": "frame_budget_reduced_sampling_rate" if selected_interval > interval or trimmed or shot_ticks_truncated else None,
    }


def _encode_frames(frames):
    raw = json.dumps(frames, ensure_ascii=False, separators=(",", ":"), allow_nan=False).encode()
    if len(raw) > MAX_DECODED_ROUND_BYTES:
        raise ValueError("replay_round_exceeds_decoded_byte_limit")
    encoded = base64.b64encode(gzip.compress(raw, compresslevel=6, mtime=0)).decode("ascii")
    return {"encoding": "gzip-base64-json", "data": encoded, "count": len(frames),
            "start_tick": frames[0][0] if frames else None, "end_tick": frames[-1][0] if frames else None,
            "decoded_bytes": len(raw)}


def _build_shots(events, rounds, indexes, tickrate):
    """Keep observed firearm events and exact-shooter/tick impact evidence.

    CS2's server event stream supplies hit positions, not a continuous flight
    path or muzzle transform. Multiple impacts may be penetration or pellets;
    event order is retained without inventing a traversal order.
    """
    output = {r["round_number"]: {"shots": [], "unassociated_impacts": [], "damage_events": []} for r in rounds}
    fires = sorted((row for row in events.get("weapon_fire", [])
                    if _in_round(row, rounds) and _firearm(row) and _identity(row, "user_") in indexes),
                   key=lambda row: row["tick"])
    truncated = len(fires) > MAX_SHOTS
    groups = defaultdict(list)
    fire_counts = Counter((int(row["tick"]), _identity(row, "user_")) for row in fires)
    network_fires = defaultdict(list)
    for row in events.get("fire_bullets", []):
        tick, shooter = _tick(row.get("tick")), _identity(row, "user_")
        if tick is not None and shooter in indexes:
            # The parser's network-message adapter has no warmup flag. It is
            # used only after association to a live weapon_fire event below.
            network_fires[(tick, shooter)].append(row)
    observed_fire_origins = 0
    observed_fire_directions = 0
    for index, row in enumerate(fires[:MAX_SHOTS]):
        round_ = next(r for r in rounds if r["start_tick"] <= row["tick"] <= r["end_tick"])
        tick, shooter = int(row["tick"]), _identity(row, "user_")
        origin, reference = _origin(row)
        network = network_fires.get((tick, shooter), [])
        network = network[0] if len(network) == 1 and fire_counts[(tick, shooter)] == 1 else None
        direction = None
        if network:
            fire_origin = [_q(network.get("origin_" + key)) for key in ("x", "y", "z")]
            if all(value is not None for value in fire_origin):
                origin, reference = fire_origin, "observed_fire_origin"
                observed_fire_origins += 1
            pitch, yaw = _q(network.get("angles_x")), _q(network.get("angles_y"))
            if pitch is not None and yaw is not None:
                direction = {"pitch": pitch, "yaw": yaw, "roll": _q(network.get("angles_z")), "source": "fire_bullets"}
                observed_fire_directions += 1
        shot = {"id": f"r{round_['round_number']}:t{tick}:s{index}", "tick": tick,
                "phase": "post_round" if tick > round_["decision_tick"] else "live",
                "seconds": round((tick - round_["start_tick"]) / tickrate, 4),
                "shooter_index": indexes[shooter], "weapon": str(row.get("weapon") or "").removeprefix("weapon_")[:64],
                "origin": origin, "origin_reference": reference, "direction": direction,
                "fire_telemetry_status": "observed" if network else "not_observed",
                "spread": number(network.get("spread")) if network else None,
                "inaccuracy": number(network.get("inaccuracy")) if network else None,
                "recoil_index": number(network.get("recoil_index")) if network else None,
                "seed": _tick(network.get("seed")) if network else None,
                "fire_telemetry": {key: number(network.get(key)) for key in ("item_def_index", "attack_type", "mode", "num_bullets_remaining", "player_inair", "player_scoped", "weapon_id")} if network else None,
                "impacts": [], "hurts": []}
        output[round_["round_number"]]["shots"].append(shot)
        groups[(tick, shooter)].append(shot)
    impact_rows = [(sequence, row) for sequence, row in enumerate(events.get("bullet_impact", []))
                   if _in_round(row, rounds) and _identity(row, "user_") in indexes and _xyz(row, impact=True)]
    truncated |= len(impact_rows) > MAX_BULLET_IMPACTS
    associated, ambiguous, missing_origin = 0, 0, 0
    for sequence, row in impact_rows[:MAX_BULLET_IMPACTS]:
        tick, shooter = int(row["tick"]), _identity(row, "user_")
        round_ = next(r for r in rounds if r["start_tick"] <= tick <= r["end_tick"])
        candidates = groups.get((tick, shooter), [])
        origin, reference = _origin(row)
        if len(candidates) == 1 and (origin is None or candidates[0]["origin_reference"] == "observed_fire_origin"):
            origin, reference = candidates[0]["origin"], candidates[0]["origin_reference"]
        missing_origin += origin is None
        impact = {"tick": tick, "position": _xyz(row, impact=True), "sequence": sequence,
                  "origin": origin, "origin_reference": reference,
                  "association": "same_shooter_same_tick" if len(candidates) == 1 else "ambiguous_same_tick" if candidates else "no_matching_fire_event"}
        if len(candidates) == 1 and len(candidates[0]["impacts"]) < MAX_IMPACTS_PER_SHOT:
            candidates[0]["impacts"].append(impact)
            associated += 1
        else:
            # All actual endpoints stay available even if a shotgun exceeds the
            # per-shot association bound or several fires share one tick.
            if len(candidates) == 1:
                impact["association"] = "per_shot_association_limit"
                truncated = True
            impact["shooter_index"] = indexes[shooter]
            output[round_["round_number"]]["unassociated_impacts"].append(impact)
            ambiguous += len(candidates) > 1
    damage_count = 0
    damage_rows = sorted((row for row in events.get("player_hurt", []) if _in_round(row, rounds)), key=lambda row: row["tick"])
    truncated |= len(damage_rows) > MAX_DAMAGE_EVENTS
    for row in damage_rows[:MAX_DAMAGE_EVENTS]:
        tick, attacker, victim = int(row["tick"]), _identity(row, "attacker_"), _identity(row, "user_")
        if victim not in indexes:
            continue
        round_ = next(r for r in rounds if r["start_tick"] <= tick <= r["end_tick"])
        damage = number(row.get("dmg_health"))
        hurt = {"tick": tick, "attacker_index": indexes.get(attacker), "victim_index": indexes[victim],
                "phase": "post_round" if tick > round_["decision_tick"] else "live",
                "damage": int(damage) if damage is not None and damage >= 0 else None,
                "health": _stat(row.get("health")), "armor": _stat(row.get("armor")),
                "hitgroup": row.get("hitgroup") if isinstance(row.get("hitgroup"), (str, int)) else None,
                "weapon": str(row.get("weapon") or "").removeprefix("weapon_")[:64]}
        output[round_["round_number"]]["damage_events"].append(hurt)
        damage_count += 1
        candidates = [shot for shot in groups.get((tick, attacker), []) if shot["weapon"] == hurt["weapon"]] if _firearm(row) else []
        if len(candidates) == 1 and len(candidates[0]["hurts"]) < MAX_HURTS_PER_SHOT:
            candidates[0]["hurts"].append(hurt)
    return output, {"observed_shots": min(len(fires), MAX_SHOTS), "observed_bullet_impacts": min(len(impact_rows), MAX_BULLET_IMPACTS),
                    "associated_bullet_impacts": associated, "unassociated_bullet_impacts": min(len(impact_rows), MAX_BULLET_IMPACTS) - associated,
                    "ambiguous_bullet_impacts": ambiguous, "impacts_missing_origin": missing_origin,
                    "observed_damage_events": damage_count, "shots_truncated": truncated,
                    "observed_fire_origins": observed_fire_origins, "observed_fire_directions": observed_fire_directions,
                    "bullet_origin": "observed_fire_origin_when_uniquely_matched_else_observed_player_origin",
                    "bullet_path": "observed_impact_connections", "penetration_order_verified": False}


def _round_result(events, round_, frames):
    decision = round_.get("decision_tick", round_["end_tick"])
    ends = [row for row in events.get("round_end", [])
            if _live(row) and _tick(row.get("tick")) == decision]
    end_event = ends[0] if len(ends) == 1 else None
    code = round_reason(end_event.get("reason")) if end_event else None
    reasons = {1: "bomb_exploded", 7: "bomb_defused", 8: "t_killed", 9: "ct_killed", 10: "draw",
               11: "hostages_rescued", 12: "time_ran_out", 13: "hostages_not_rescued"}
    winner = _team(end_event.get("winner")) if end_event else _team(round_.get("winner"))
    states = next((frame[1] for frame in frames if frame[0] == decision), [])
    # A competitive end-state census requires the entire two-sided roster.
    # Missing player rows cannot silently turn into an apparent survivor zero.
    complete = len(states) == 10 and len({row[0] for row in states}) == 10 and all(sum(row[7] == team for row in states) == 5 for team in (2, 3))
    survivors = None
    if complete:
        survivors = {}
        for team, side in ((2, "T"), (3, "CT")):
            living = [row[0] for row in states if row[7] == team and row[6] == 1]
            survivors[side] = {"count": len(living), "player_indices": living}
    return {"winner": winner, "winner_side": {2: "T", 3: "CT"}.get(winner),
            "decision_tick": decision,
            "reason_code": int(code) if code is not None else None, "reason": reasons.get(code),
            "source": "round_end" if end_event else None,
            "survivors": survivors, "survivor_status": "observed" if complete else "unavailable"}


def build_replay(events, samples, rounds, player_info, steamid, *, tickrate=64.0, sampling=None,
                 grenades=None, grenade_status="not_observed", recording_end_tick=None):
    """Create a JSON-safe personal-match replay without altering metric input."""
    sampling = dict(sampling or {})
    rounds = replay_windows(rounds, events, recording_end_tick=recording_end_tick)
    names = {}
    for row in player_info:
        identity = _identity(row)
        if identity:
            names[identity] = str(row.get("name") or "Unknown")[:128]
    for row in samples:
        identity = _identity(row)
        if identity:
            names.setdefault(identity, str(row.get("name") or "Unknown")[:128])
    live_deaths = [event for event in events.get("player_death", []) if _tick(event.get("tick")) is not None and _live(event)
                   and any(row["start_tick"] <= event["tick"] <= row["end_tick"] for row in rounds)]
    live_deaths.sort(key=lambda event: event["tick"])
    kills_truncated = len(live_deaths) > MAX_KILLS
    live_deaths = live_deaths[:MAX_KILLS]
    for row in live_deaths:
        for prefix in ("attacker_", "user_", "assister_"):
            identity = _identity(row, prefix)
            if identity:
                names.setdefault(identity, str(row.get(prefix + "name") or "Unknown")[:128])
    for name, prefixes in (("weapon_fire", ("user_",)), ("bullet_impact", ("user_",)),
                           ("player_hurt", ("attacker_", "user_"))):
        for row in events.get(name, []):
            if not _in_round(row, rounds):
                continue
            for prefix in prefixes:
                identity = _identity(row, prefix)
                if identity:
                    names.setdefault(identity, str(row.get(prefix + "name") or "Unknown")[:128])
    own = str(steamid)
    identities = sorted(names, key=lambda identity: (identity != own, identity))[:MAX_PLAYERS]
    indexes = {identity: index for index, identity in enumerate(identities)}
    players = [{"index": index, "steamid": None if identity.startswith("bot:") else identity,
                "name": names[identity], "is_bot": identity.startswith("bot:")} for identity, index in indexes.items()]
    tactical_rounds, tactical_coverage = build_tactical(events, grenades or [], samples, rounds, indexes,
                                                         tickrate=tickrate, grenade_status=grenade_status)
    shot_rounds, shot_coverage = _build_shots(events, rounds, indexes, tickrate)
    by_tick = defaultdict(list)
    for row in samples:
        tick = _tick(row.get("tick"))
        if tick is not None:
            by_tick[tick].append(row)
    impacts = defaultdict(list)
    for impact in events.get("bullet_impact", []):
        tick, identity = _tick(impact.get("tick")), _identity(impact, "user_")
        if tick is not None and identity in indexes and _live(impact) and _xyz(impact, impact=True):
            key = (tick, identity)
            if len(impacts[key]) < MAX_IMPACTS_PER_KILL:
                impacts[key].append(impact)
    replay_rounds = []
    missing_state_rows = 0
    missing_kill_ticks = []
    health_rows = 0
    armor_rows = 0
    post_round_frames = 0
    for round_ in rounds:
        start, end = int(round_["start_tick"]), int(round_["end_tick"])
        deaths = [event for event in live_deaths if start <= event["tick"] <= end]
        death_states = defaultdict(list)
        kills = []
        for event_index, death in enumerate(deaths):
            attacker, victim, assister = (_identity(death, prefix) for prefix in ("attacker_", "user_", "assister_"))
            attacker_position, victim_position = _xyz(death, "attacker_"), _xyz(death, "user_")
            if victim in indexes:
                death_states[indexes[victim]].append((int(death["tick"]), victim_position, _q(death.get("user_yaw")), _q(death.get("user_pitch"))))
            tick = int(death["tick"])
            weapon = str(death.get("weapon") or "unknown")[:64]
            firearm = weapon.removeprefix("weapon_") in FIREARMS and attacker != victim
            bullet_impacts = [{"tick": tick, "shooter_index": indexes[attacker],
                               "position": _xyz(impact, impact=True), "from": _xyz(impact, "user_") or attacker_position,
                               "association": "same_shooter_same_tick", "victim_hit_verified": False,
                               "muzzle_origin_verified": False} for impact in impacts.get((tick, attacker), [])] if firearm else []
            team_a, team_v = _team(death.get("attacker_team_num")), _team(death.get("user_team_num"))
            kills.append({"id": f"r{round_['round_number']}:t{tick}:k{event_index}", "tick": tick,
                          "phase": "post_round" if tick > round_["decision_tick"] else "live",
                          "seconds": round((tick - start) / tickrate, 4),
                          "attacker_index": indexes.get(attacker), "victim_index": indexes.get(victim),
                          "assister_index": indexes.get(assister), "weapon": weapon, "firearm": firearm,
                          "headshot": death.get("headshot") is True,
                          "through_smoke": death.get("thrusmoke") is True,
                          "attacker_blind": death.get("attackerblind") is True,
                          "flash_assist": death.get("assistedflash") is True, "self_kill": bool(attacker and attacker == victim),
                          "teamkill": bool(attacker != victim and team_a is not None and team_a == team_v),
                          "attacker_position": attacker_position, "victim_position": victim_position,
                          "kill_direction": {"from": attacker_position, "to": victim_position, "kind": "killer_victim_connection",
                                             "origin_reference": "player_world_origin", "ballistic_path_verified": False} if firearm and attacker_position and victim_position else None,
                          "bullet_impacts": bullet_impacts})
        frames = []
        last_alive = {}
        for tick in sorted(tick for tick in by_tick if start <= tick <= end):
            states = []
            for row in by_tick[tick]:
                identity = _identity(row)
                index = indexes.get(identity)
                point = _xyz(row)
                team = _team(row.get("team_num"))
                alive = row.get("is_alive")
                if index is None or point is None or team is None or not isinstance(alive, bool):
                    missing_state_rows += 1
                    continue
                yaw, pitch = _q(row.get("yaw")), _q(row.get("pitch"))
                evidence = next((entry for entry in reversed(death_states.get(index, [])) if entry[0] <= tick), None)
                if evidence:
                    alive = False
                if alive:
                    last_alive[index] = (point, yaw, pitch)
                else:
                    if evidence and evidence[1]:
                        point, yaw, pitch = evidence[1:]
                    elif index in last_alive:
                        point, yaw, pitch = last_alive[index]
                    else:
                        # Never display an unidentified spectator/entity location.
                        continue
                health, armor = _stat(row.get("health")), _stat(row.get("armor_value"))
                health_rows += health is not None
                armor_rows += armor is not None
                states.append([index, *point, yaw, pitch, int(alive), team, health if alive else 0, armor])
            if states:
                frames.append([tick, sorted(states, key=lambda row: row[0])])
        frame_ticks = {row[0] for row in frames}
        post_round_frames += sum(frame[0] > round_["decision_tick"] for frame in frames)
        for observed_kill in kills:
            observed_kill["frame_observed"] = observed_kill["tick"] in frame_ticks
            if not observed_kill["frame_observed"]:
                missing_kill_ticks.append(observed_kill["tick"])
        replay_rounds.append({"round_number": round_["round_number"], "start_tick": start, "end_tick": end,
                              **{key: round_[key] for key in ("decision_tick", "live_end_tick", "playback_end_tick",
                                                               "playback_end_source", "next_round_start_tick", "phases")},
                              "frames": _encode_frames(frames), "kills": kills,
                              **shot_rounds.get(round_["round_number"], {}),
                              "result": _round_result(events, round_, frames),
                              "tactical": tactical_rounds.get(round_["round_number"])})
    frame_count = sum(row["frames"]["count"] for row in replay_rounds)
    kill_count = sum(len(row["kills"]) for row in replay_rounds)
    partial = sampling.get("truncated") or kills_truncated or len(names) > MAX_PLAYERS or missing_kill_ticks or shot_coverage["shots_truncated"]
    return {"version": VERSION, "status": "unavailable" if not frame_count else "partial" if partial else "observed",
            "reason": "no_valid_all_player_frames" if not frame_count else sampling.get("reason") or ("exact_kill_frames_missing" if missing_kill_ticks else None),
            "sample_hz": sampling.get("sample_hz"), "interval_ticks": sampling.get("interval_ticks"),
            "tickrate": tickrate, "player_fields": PLAYER_FIELDS, "players": players, "rounds": replay_rounds,
            "recording_end_tick": _tick(recording_end_tick),
            "coverage": {**sampling, "observed_frames": frame_count, "observed_kills": kill_count,
                         "players": len(players), "players_truncated": len(names) > MAX_PLAYERS,
                         "post_round_frames": post_round_frames,
                         "kills_truncated": kills_truncated, "invalid_state_rows": missing_state_rows,
                         "missing_kill_ticks": sorted(set(missing_kill_ticks)),
                         "bullet_impact_status": "observed" if impacts else "not_observed",
                         **shot_coverage,
                         "health_status": "observed" if health_rows else "not_observed", "health_observed_rows": health_rows,
                         "armor_status": "observed" if armor_rows else "not_observed", "armor_observed_rows": armor_rows,
                         "tactical": tactical_coverage,
                         "max_decoded_round_bytes": MAX_DECODED_ROUND_BYTES,
                         "position_decimals": 1, "angle_decimals": 1},
            "definitions": {
                "frames": "Observed parser ticks, nominally 16Hz plus exact kill, utility, shot, impact and damage ticks within the frame budget. Array fields follow player_fields; alive is 0/1, team is 2/3; health/armor are observed values or null.",
                "result": "Winner, reason and survivor census use the exact official round_end decision_tick. The subsequent playback tail never changes competitive statistics or the decision-time survivor count.",
                "phases": "Live play ends inclusively at decision_tick/live_end_tick. Post-round playback continues through playback_end_tick, immediately before the next observed round_prestart/start boundary, or through the actual recording end for the final round. Reset/freeze-time entities are not carried back into the preceding round. Missing reset boundaries keep the live endpoint only.",
                "dead_players": "After death the displayed pose is frozen at the exact death event, or the last observed living pose when death coordinates are absent. Spectator/entity movement is excluded.",
                "kills": "All observed death events in the replay interval, including post-round events, other players, teamkills and suicides. phase distinguishes live from post_round; competitive metrics remain restricted to the official live interval. Exact kill ticks are explicitly requested.",
                "kill_direction": "Killer-to-victim world-origin connection at the death event, not a measured bullet trajectory, muzzle ray, visibility proof or ballistic path.",
                "bullet_impacts": "Only observed bullet_impact events from the same shooter on the exact kill tick. The impact connection starts at the reported player world origin, not a verified muzzle; victim association and ballistic flight are unverified. Missing impacts do not imply zero shots.",
                "shots": "Observed firearm fire events throughout the live and post-round replay interval, with explicit phase. A unique exact-shooter/tick fire_bullets message supplies actual fire origin, direction and spread telemetry where present. Direction is distinct from an impact ray: random spread, collision and the endpoint are unverified without bullet_impact. Each impact association requires a unique same-shooter same-tick fire. Sequence is parser event order, not verified travel or penetration order.",
                "damage_events": "Observed player_hurt events for every indexed player throughout the live and post-round replay interval, with explicit phase. Health and armor are reported post-event values; damage is the event-reported dmg_health and can include overkill. Hitgroup is the reported hit classification, not an inferred skeletal pose.",
                "encoding": "Per-round frames are UTF-8 compact JSON compressed with gzip (mtime 0), then base64. Enforce declared decoded_bytes and max_decoded_round_bytes when decoding.",
            }}
