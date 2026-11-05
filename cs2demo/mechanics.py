"""Event-linked mechanics: measured view, recoil and move-to-fire evidence.

The target is the victim of an observed firearm hurt, not an inferred visible
enemy. Only horizontal bearing is used: demo origins do not identify a head or
eye position. Shot/hurt associations count firing events, never projectiles.
"""
from __future__ import annotations

from collections import defaultdict
import math
from statistics import median

from .advanced import BURST_GAP_SECONDS, FIREARMS, HITGROUPS, _effective_hurts, _hitgroup, _weapon
from .aim_geometry import enrich_aim_window, recorded_fire_origins
from .metrics import _enemy, _live, number, steam_id

VERSION = "1.2"
ALIGNMENT_DEGREES = 2.0
MAX_TARGET_TICKS = 32000
PLAYBACK_SAMPLE_HZ = 32
MAX_TRACE_POINTS = 512
MAX_PLAYBACK_WINDOWS = 512
PLAYBACK_POINT_FIELDS = ["tick", "yaw_delta_degrees", "pitch_delta_degrees", "x", "y", "z"]
PLAYBACK_SHOT_FIELDS = ["tick", "shot_index", "hit", "damage", "target_indices", "speed", "hitgroups"]
AUTO_WEAPONS = {"ak47", "aug", "bizon", "cz75a", "famas", "galilar", "m249", "m4a1", "m4a1_silencer",
                "mac10", "mp5sd", "mp7", "mp9", "negev", "p90", "sg556", "ump45"}


def _q(value, digits=3):
    value = number(value)
    return round(value, digits) if value is not None else None


def _median(values):
    values = [x for x in values if number(x) is not None]
    return _q(median(values)) if values else None


def _pct(n, d):
    return round(100 * n / d, 2) if d else None


def _wrap(angle):
    return (angle + 180) % 360 - 180


def _punch(row):
    value = row.get("aim_punch_angle")
    if isinstance(value, (list, tuple)) and len(value) >= 2 and all(number(x) is not None for x in value[:2]):
        return float(value[0]), float(value[1])
    return None


def shot_bursts(events, rounds, steamid, tickrate):
    """Split only within complete live rounds; a new weapon starts a burst."""
    result = []
    for round_ in rounds:
        own = sorted((e for e in events.get("weapon_fire", [])
                      if _live(e) and steam_id(e.get("user_steamid")) == steamid
                      and _weapon(e.get("weapon")) in FIREARMS
                      and number(e.get("tick")) is not None
                      and round_["start_tick"] <= e["tick"] <= round_["end_tick"]), key=lambda x: x["tick"])
        bursts = []
        for shot in own:
            if (not bursts or _weapon(bursts[-1][-1].get("weapon")) != _weapon(shot.get("weapon"))
                    or shot["tick"] - bursts[-1][-1]["tick"] > BURST_GAP_SECONDS * tickrate):
                bursts.append([])
            bursts[-1].append(shot)
        for shots in bursts:
            result.append({"round": round_, "shots": shots})
    return result


def target_sample_ticks(events, rounds, steamid, tickrate):
    """32Hz target context plus exact fire ticks; bounded separately."""
    interval = max(1, round(tickrate / PLAYBACK_SAMPLE_HZ))
    exact, regular = set(), set()
    for burst in shot_bursts(events, rounds, steamid, tickrate):
        round_, shots = burst["round"], burst["shots"]
        exact.update(int(s["tick"]) for s in shots)
        lower = max(round_["start_tick"], int(shots[0]["tick"] - tickrate))
        upper = min(round_["end_tick"], int(shots[-1]["tick"] + .25 * tickrate))
        regular.update(range(lower, upper + 1, interval))
        regular.update((lower, upper))
    selected = exact | set(sorted(regular - exact)[:max(0, MAX_TARGET_TICKS - len(exact))])
    # More exact shots than the budget cannot occur in normal matches; still
    # preserve a hard limit for malformed or pathological inputs.
    selected = sorted(selected)[:MAX_TARGET_TICKS]
    return selected, {"sample_hz": tickrate / interval, "interval_ticks": interval,
                      "selected_ticks": len(selected), "max_ticks": MAX_TARGET_TICKS,
                      "pre_seconds": 1.0, "post_seconds": .25,
                      "truncated": len(regular | exact) > len(selected)}


def _hurt_associations(events, rounds, steamid, tickrate):
    """Match an enemy hurt to the unique latest same-weapon fire within 2 ticks.

    A shot may damage several enemies. Pellets and penetration can produce
    multiple hurts, so every fire remains a single binary association.
    """
    matches = defaultdict(list)
    ambiguous = 0
    for round_ in rounds:
        start, end = round_["start_tick"], round_["end_tick"]
        shots = [e for e in events.get("weapon_fire", []) if _live(e)
                 and steam_id(e.get("user_steamid")) == steamid
                 and start <= e.get("tick", -1) <= end and _weapon(e.get("weapon")) in FIREARMS]
        hurts = [e for e in events.get("player_hurt", []) if _live(e) and start <= e.get("tick", -1) <= end]
        for hurt, damage in _effective_hurts(hurts):
            if steam_id(hurt.get("attacker_steamid")) != steamid or not _enemy(hurt):
                continue
            candidates = [s for s in shots if _weapon(s.get("weapon")) == _weapon(hurt.get("weapon"))
                          and 0 <= hurt["tick"] - s["tick"] <= 2]
            latest = max((s["tick"] for s in candidates), default=None)
            candidates = [s for s in candidates if s["tick"] == latest]
            if len(candidates) == 1:
                key = (round_["round_number"], int(latest), _weapon(hurt.get("weapon")))
                matches[key].append((hurt, damage))
            elif candidates:
                ambiguous += 1
    return matches, ambiguous


def _base(burst):
    round_, shots = burst["round"], burst["shots"]
    tick, end = int(shots[0]["tick"]), int(shots[-1]["tick"])
    return {"burst_id": f"r{round_['round_number']}:b{tick}", "round_number": round_["round_number"],
            "tick": tick, "end_tick": end, "weapon": _weapon(shots[0].get("weapon")), "shots": len(shots)}


def _target_observation(burst, samples, target_rows, associations, tickrate):
    base = _base(burst)
    shots = burst["shots"]
    associated = [(s, h, d) for s in shots for h, d in associations.get(
        (base["round_number"], int(s["tick"]), base["weapon"]), [])]
    if not associated:
        return None
    # Earliest damaged enemy provides an explicit, inspectable association.
    first_shot, first_hurt, _ = min(associated, key=lambda item: (item[1]["tick"], item[0]["tick"]))
    target = steam_id(first_hurt.get("user_steamid"))
    target_hurt_shot_ticks = {int(s["tick"]) for s, h, _ in associated if steam_id(h.get("user_steamid")) == target}
    first_tick = base["tick"]
    own = {int(s["tick"]): s for s in samples}
    targets = {int(s["tick"]): s for s in target_rows if steam_id(s.get("steamid")) == target}
    trace = []
    lower = max(burst["round"]["start_tick"], int(first_tick - tickrate * .25))
    for tick in sorted(set(own) & set(targets)):
        if not lower <= tick <= base["end_tick"]:
            continue
        self_row, victim = own[tick], targets[tick]
        vals = [number(r.get(k)) for r in (self_row, victim) for k in ("X", "Y")]
        yaw = number(self_row.get("yaw"))
        if yaw is None or any(v is None for v in vals) or self_row.get("is_alive") is not True:
            continue
        # A death-event frame can mark the victim dead even though this is the
        # exact firing tick. Its retained origin remains valid for that frame.
        if victim.get("is_alive") is not True and tick not in target_hurt_shot_ticks:
            continue
        dx, dy = vals[2] - vals[0], vals[3] - vals[1]
        if math.hypot(dx, dy) < 1:
            continue
        error = _wrap(yaw - math.degrees(math.atan2(dy, dx)))
        trace.append({"tick": tick, "offset_ms": _q(1000 * (tick - first_tick) / tickrate, 2),
                      "yaw_error_degrees": _q(error), "absolute_error_degrees": _q(abs(error)),
                      "phase": "before_fire" if tick < first_tick else "after_fire"})
    exact = next((s for s in trace if s["tick"] == first_tick), None)
    initial = trace[0] if trace and trace[0]["tick"] <= lower + max(1, round(tickrate / PLAYBACK_SAMPLE_HZ)) else None
    # Primary correction needs the full fixed lookback; round-start clipping
    # does not become a shorter, falsely comparable acquisition measurement.
    if first_tick - burst["round"]["start_tick"] < .25 * tickrate:
        initial = None
    later = [s["absolute_error_degrees"] for s in trace if s["tick"] > first_tick]
    damage = sum(d for _, _, d in associated)
    return {**base, "status": "observed" if exact else "unavailable",
            "reason": None if exact else "same_tick_target_bearing_missing",
            "target_steamid": target, "target_name": str(first_hurt.get("user_name") or "")[:128],
            "target_count": len({steam_id(h.get("user_steamid")) for _, h, _ in associated}),
            "hit_shots": len({int(s["tick"]) for s, _, _ in associated}), "damage": damage,
            "first_shot_yaw_error_degrees": exact["absolute_error_degrees"] if exact else None,
            "initial_yaw_error_degrees": initial["absolute_error_degrees"] if initial else None,
            "primary_correction_degrees": _q(initial["absolute_error_degrees"] - exact["absolute_error_degrees"]) if initial and exact else None,
            "secondary_correction_degrees": _q(exact["absolute_error_degrees"] - min(later)) if exact and later else None,
            "first_hit_delay_ms": _q(1000 * (first_hurt["tick"] - first_tick) / tickrate, 2),
            "trace": trace[:MAX_TRACE_POINTS]}


def _sample_trace_ticks(lower, upper, shots, tickrate):
    """Prefer exact shots, then evenly retain the complete context window."""
    interval = max(1, round(tickrate / PLAYBACK_SAMPLE_HZ))
    exact = {int(s["tick"]) for s in shots}
    context = sorted((set(range(lower, upper + 1, interval)) | {lower, upper}) - exact)
    budget = max(0, MAX_TRACE_POINTS - len(exact))
    if len(context) > budget:
        context = [context[math.floor(i * len(context) / budget)] for i in range(budget)] if budget else []
    # Malformed inputs with >512 shots still retain every shot marker. The
    # trajectory itself remains bounded; coverage reports omitted samples.
    return sorted(exact | set(context))[:MAX_TRACE_POINTS]


def _angular_path(points):
    valid = [p for p in points if p[1] is not None and p[2] is not None]
    if len(valid) < 2:
        return None, None
    distance = sum(math.hypot(b[1] - a[1], b[2] - a[2]) for a, b in zip(valid, valid[1:]))
    net = math.hypot(valid[-1][1] - valid[0][1], valid[-1][2] - valid[0][2])
    return _q(distance), _q(net)


def _aim_playback_window(burst, samples, target_rows, associations, tickrate, fire_origins=None):
    """Recorded view trajectory for every burst, with damage-linked targets.

    Targets share the first-shot angular coordinate system with the view. Their
    bearings use recorded player origins; they are not visible head hitboxes.
    Unknown/dead target samples become explicit nulls rather than held positions.
    """
    from .l3 import _speed

    base = _base(burst)
    first, end = base["tick"], base["end_tick"]
    lower = max(burst["round"]["start_tick"], int(first - tickrate))
    upper = min(burst["round"]["end_tick"], int(end + .25 * tickrate))
    interval = max(1, round(tickrate / PLAYBACK_SAMPLE_HZ))
    selected = _sample_trace_ticks(lower, upper, burst["shots"], tickrate)
    own = {int(s["tick"]): s for s in samples if lower <= s["tick"] <= upper}
    # Sparse all-player context is a fallback if the bounded dense parse has
    # no own row. Never use a nearby row for an exact shot.
    for row in target_rows:
        if steam_id(row.get("steamid")) == steam_id(burst["shots"][0].get("user_steamid")):
            tick = int(row["tick"])
            if lower <= tick <= upper:
                own.setdefault(tick, row)
    anchor = own.get(first, {})
    anchor_yaw, anchor_pitch = number(anchor.get("yaw")), number(anchor.get("pitch"))
    if anchor.get("is_alive") is not True:
        anchor_yaw = anchor_pitch = None
    reference = {"tick": first, "yaw_degrees": _q(anchor_yaw), "pitch_degrees": _q(anchor_pitch)}

    # Unwrap the dense view before chart thinning so a complete turn and a
    # crossing of +/-180 degrees remain continuous in the same basis.
    unwrapped, previous, continuous = {}, None, 0.0
    for tick, row in sorted(own.items()):
        yaw = number(row.get("yaw"))
        if yaw is None or row.get("is_alive") is not True:
            continue
        if previous is None:
            continuous = yaw
        else:
            continuous += _wrap(yaw - previous)
        previous = yaw
        unwrapped[tick] = continuous
    origin = unwrapped.get(first)
    points = []
    for tick in selected:
        row = own.get(tick, {})
        alive = row.get("is_alive") is True
        yaw = _q(unwrapped[tick] - origin) if origin is not None and tick in unwrapped and alive else None
        pitch = number(row.get("pitch"))
        points.append([tick, yaw, _q(pitch - anchor_pitch) if alive and pitch is not None and anchor_pitch is not None else None,
                       *[_q(row.get(axis), 2) if alive else None for axis in ("X", "Y", "Z")]])

    associated = [(int(s["tick"]), h, d) for s in burst["shots"]
                  for h, d in associations.get((base["round_number"], int(s["tick"]), base["weapon"]), [])]
    first_hurts = {}
    for shot_tick, hurt, _ in sorted(associated, key=lambda item: (item[1]["tick"], item[0])):
        first_hurts.setdefault(steam_id(hurt.get("user_steamid")), hurt)
    own_team = number(anchor.get("team_num"))
    if own_team not in (2, 3):
        own_team = number(burst["shots"][0].get("user_team_num"))
    roster = {}
    for row in target_rows:
        sid, team = steam_id(row.get("steamid")), number(row.get("team_num"))
        if sid and own_team in (2, 3) and team in (2, 3) and team != own_team and lower <= row["tick"] <= upper:
            roster.setdefault(sid, row)
    target_ids = list(first_hurts) + sorted(set(roster) - set(first_hurts))
    targets = []
    for target in target_ids:
        victims = {int(s["tick"]): s for s in target_rows if steam_id(s.get("steamid")) == target}
        hurt_ticks = {tick for tick, h, _ in associated if steam_id(h.get("user_steamid")) == target}
        track, prior_bearing, target_unwrapped = [], None, None
        for point in points:
            tick, own_yaw = point[0], point[1]
            row, victim = own.get(tick, {}), victims.get(tick, {})
            xy = [number(r.get(axis)) for r in (row, victim) for axis in ("X", "Y")]
            valid = (own_yaw is not None and all(v is not None for v in xy)
                     and (victim.get("is_alive") is True or tick in hurt_ticks))
            if not valid:
                track.append([tick, None, None, None, None, None])
                prior_bearing = None
                continue
            dx, dy = xy[2] - xy[0], xy[3] - xy[1]
            distance = math.hypot(dx, dy)
            if distance < 1:
                track.append([tick, None, None, None, None, None])
                prior_bearing = None
                continue
            bearing = math.degrees(math.atan2(dy, dx))
            if prior_bearing is None:
                target_unwrapped = own_yaw + _wrap(bearing - number(row.get("yaw")))
            else:
                target_unwrapped += _wrap(bearing - prior_bearing)
            prior_bearing = bearing
            self_z, target_z = number(row.get("Z")), number(victim.get("Z"))
            pitch = (-math.degrees(math.atan2(target_z - self_z, distance)) - anchor_pitch
                     if self_z is not None and target_z is not None and anchor_pitch is not None else None)
            track.append([tick, _q(target_unwrapped), _q(pitch), *[_q(victim.get(axis), 2) for axis in ("X", "Y", "Z")]])
        # Put the target branch nearest the first-shot reference, even if the
        # player's pre-fire view completed more than one full revolution.
        target_reference = min((p for p in track if p[1] is not None),
                               key=lambda p: abs(p[0] - first), default=None)
        if target_reference:
            turn_offset = target_reference[1] - _wrap(target_reference[1])
            for point in track:
                if point[1] is not None:
                    point[1] = _q(point[1] - turn_offset)
        name = first_hurts.get(target, {}).get("user_name") or roster.get(target, {}).get("name") or ""
        targets.append({"steamid": target, "name": str(name)[:128],
                        "team_num": int(number(roster[target].get("team_num"))) if target in roster else None,
                        "damage_associated": target in first_hurts, "points": track})

    markers = []
    for index, shot in enumerate(burst["shots"], 1):
        tick = int(shot["tick"])
        rows = associations.get((base["round_number"], tick, base["weapon"]), [])
        group_codes = {name: code for code, name in HITGROUPS.items()}
        hitgroups = sorted({group_codes[_hitgroup(h.get("hitgroup"))] for h, _ in rows
                            if _hitgroup(h.get("hitgroup")) in group_codes})
        markers.append([tick, index, bool(rows), sum(d for _, d in rows),
                        sorted({target_ids.index(steam_id(h.get("user_steamid"))) for h, _ in rows}),
                        _q(_speed(own[tick])) if tick in own else None, hitgroups])

    before = [p for p in points if p[0] <= first]
    valid_before = [p for p in before if p[1] is not None and p[2] is not None]
    complete = (lower == int(first - tickrate) and len(valid_before) == len(before)
                and bool(valid_before) and valid_before[-1][0] == first
                and all(b[0] - a[0] <= interval * 2 for a, b in zip(before, before[1:])))
    distance, net = _angular_path(valid_before) if complete else (None, None)
    first_point = next((p for p in points if p[0] == first), None)
    primary = targets[0]["points"] if first_hurts else []
    first_target = next((p for p in primary if p[0] == first), None)
    first_yaw_error = abs(_wrap(first_point[1] - first_target[1])) if first_point and first_target and first_point[1] is not None and first_target[1] is not None else None
    first_pitch_error = abs(first_point[2] - first_target[2]) if first_point and first_target and first_point[2] is not None and first_target[2] is not None else None
    crossings = None
    if complete and primary and all(p[1] is not None for p in primary if p[0] <= first):
        errors = []
        target_by_tick = {p[0]: p for p in primary}
        for point in before:
            error = _wrap(point[1] - target_by_tick[point[0]][1])
            if abs(error) > .25:
                errors.append(error)
        # A +179 to -179 transition crosses the back-facing wrap seam, not
        # the target direction. Only zero crossings on the same branch count.
        crossings = sum(a * b < 0 and abs(b - a) <= 180 for a, b in zip(errors, errors[1:]))
    firing = [p for p in points if first <= p[0] <= end and p[1] is not None and p[2] is not None]
    dispersion = None
    if len(firing) >= 2 and firing[0][0] == first and firing[-1][0] == end:
        mean_yaw = sum(p[1] for p in firing) / len(firing)
        mean_pitch = sum(p[2] for p in firing) / len(firing)
        dispersion = math.sqrt(sum((p[1] - mean_yaw) ** 2 + (p[2] - mean_pitch) ** 2 for p in firing) / len(firing))
    window = {**base, "start_tick": lower, "finish_tick": upper, "tickrate": tickrate,
            "status": "observed" if any(p[1] is not None and p[2] is not None for p in points) else "unavailable",
            "reference": reference, "points": points, "shot_markers": markers, "targets": targets,
            "primary_target_index": 0 if first_hurts else None,
            "metrics": {"first_shot_yaw_error_degrees": _q(first_yaw_error),
                        "first_shot_pitch_error_degrees": _q(first_pitch_error),
                        "acquisition_path_degrees": distance, "acquisition_net_degrees": net,
                        "excess_path_degrees": _q(max(0, distance - net)) if distance is not None and net is not None else None,
                        "overshoot_count": crossings, "fire_stability_degrees": _q(dispersion)},
            "coverage": {"pre_window_complete": complete, "target_geometry": "player_origin_bearing",
                         "visibility_verified": False, "sample_interval_ticks": interval,
                         "missing_own_points": sum(p[1] is None or p[2] is None for p in points),
                         "trajectory_truncated": len(selected) < len(set(range(lower, upper + 1, interval)) | {lower, upper} | {int(s["tick"]) for s in burst["shots"]})}}
    return enrich_aim_window(window, own.values(),
                             (row for row in target_rows if lower <= row["tick"] <= upper), associated,
                             fire_origins=fire_origins)


def _summarize_playback(windows, total_bursts):
    return {"version": "1.1", "point_fields": PLAYBACK_POINT_FIELDS, "shot_fields": PLAYBACK_SHOT_FIELDS,
            "total_bursts": total_bursts, "returned_windows": len(windows),
            "associated_windows": sum(w["primary_target_index"] is not None for w in windows),
            "body_reference_windows": sum(w.get("geometry", {}).get("coverage", {}).get("camera_with_eye_reference", 0) > 0
                                           and w.get("geometry", {}).get("coverage", {}).get("target_with_duck_amount", 0) > 0 for w in windows),
            "observed_hitgroup_events": sum(len(w.get("hit_details", [])) for w in windows),
            "truncated": len(windows) < total_bursts, "max_windows": MAX_PLAYBACK_WINDOWS,
            "windows": windows}


def _stopping_observation(burst, samples, tickrate):
    from .l3 import STOP_SPEED, _speed
    base = _base(burst)
    round_, tick = burst["round"], base["tick"]
    original = next((o for o in round_.get("analysis", {}).get("level3", {}).get("counter_strafe", {}).get("observations", []) if o.get("tick") == tick), {})
    trace = [{"tick": int(s["tick"]), "offset_ms": _q(1000 * (s["tick"] - tick) / tickrate, 2), "speed": _q(_speed(s))}
             for s in samples if max(round_["start_tick"], tick - round(tickrate)) <= s["tick"] <= tick]
    base.update(eligible=None, success=None, status="unavailable", reason="movement_window_missing",
                speed=original.get("speed"), prior_peak_speed=original.get("prior_peak_speed"),
                stop_to_shot_ms=original.get("stop_to_shot_ms"), trace=trace)
    at_shot = next((s for s in samples if s["tick"] == tick), None)
    airborne = at_shot.get("is_airborne") if at_shot else None
    if airborne is True:
        base.update(eligible=False, status="not_applicable", reason="airborne_at_fire")
        return base
    if airborne is not False or not original:
        return base
    by_tick = {int(s["tick"]): s for s in samples}
    preceding = by_tick.get(at_shot.get("velocity_interval_start_tick")) if at_shot else None
    if preceding and preceding.get("is_airborne") is True:
        base["reason"] = "landing_transition"
        return base
    # Only use the continuous valid grounded suffix to define an opportunity.
    suffix = []
    for sample in reversed([s for s in samples if tick - round(tickrate) <= s["tick"] <= tick]):
        start_row = by_tick.get(sample.get("velocity_interval_start_tick"))
        if (number(sample.get("velocity_X")) is None or sample.get("is_airborne") is not False
                or not start_row or start_row.get("is_airborne") is not False
                or suffix and suffix[-1].get("velocity_interval_start_tick") != sample["tick"]):
            break
        suffix.append(sample)
    speeds = [_speed(s) for s in suffix]
    moved = any(s is not None and s > STOP_SPEED for s in speeds)
    speed = _speed(at_shot) if at_shot else None
    if moved and speed is not None:
        base.update(eligible=True, success=original.get("braking_status") == "observed",
                    status="observed", reason=None if original.get("braking_status") == "observed" else
                    "moving_at_fire" if speed > STOP_SPEED else "stop_not_sustained_before_fire", speed=_q(speed))
    elif (original.get("window_complete") and speed is not None and suffix
          and suffix[-1].get("velocity_interval_start_tick", tick) <= tick - round(tickrate)):
        base.update(eligible=False, status="not_applicable", reason="already_stationary")
    return base


def _spray_observation(burst, samples, associations, tickrate):
    base = _base(burst)
    if base["weapon"] not in AUTO_WEAPONS or base["shots"] < 3:
        return None
    first, end = base["tick"], base["end_tick"]
    valid = [s for s in samples if first <= s["tick"] <= end and number(s.get("pitch")) is not None
             and number(s.get("yaw")) is not None and s.get("is_alive") is True]
    by_tick = {int(s["tick"]): s for s in valid}
    first_row = by_tick.get(first)
    shot_map = {int(s["tick"]): i + 1 for i, s in enumerate(burst["shots"])}
    trace, hits, damage = [], 0, 0
    for tick, shot_index in shot_map.items():
        rows = associations.get((base["round_number"], tick, base["weapon"]), [])
        hits += bool(rows)
        damage += sum(d for _, d in rows)
    if first_row:
        first_pitch, first_yaw = number(first_row["pitch"]), number(first_row["yaw"])
        previous_yaw, unwrapped_yaw = first_yaw, 0.0
        for row in valid:
            punch = _punch(row)
            tick = int(row["tick"])
            current_yaw = number(row["yaw"])
            unwrapped_yaw += _wrap(current_yaw - previous_yaw)
            previous_yaw = current_yaw
            rows = associations.get((base["round_number"], tick, base["weapon"]), [])
            trace.append({"tick": tick, "offset_ms": _q(1000 * (tick - first) / tickrate, 2),
                          "shot_index": shot_map.get(tick),
                          "pitch_delta_degrees": _q(number(row["pitch"]) - first_pitch),
                          "yaw_delta_degrees": _q(unwrapped_yaw),
                          "punch_pitch_degrees": _q(punch[0]) if punch else None,
                          "punch_yaw_degrees": _q(punch[1]) if punch else None,
                          "accuracy_penalty": _q(row.get("accuracy_penalty"), 6),
                          "recoil_index": _q(row.get("fl_recoil_idx")),
                          "hit": bool(rows) if tick in shot_map else None,
                          "damage": sum(d for _, d in rows) if tick in shot_map else None})
    opposing, eligible_pairs = 0, 0
    for a, b in zip(trace, trace[1:]):
        if (b["tick"] - a["tick"] != 1 or a["punch_pitch_degrees"] is None or b["punch_pitch_degrees"] is None):
            continue
        recoil_change = b["punch_pitch_degrees"] - a["punch_pitch_degrees"]
        view_change = b["pitch_delta_degrees"] - a["pitch_delta_degrees"]
        if abs(recoil_change) >= .02:
            eligible_pairs += 1
            opposing += view_change * recoil_change < 0
    pitch = [s["pitch_delta_degrees"] for s in trace]
    yaw = [s["yaw_delta_degrees"] for s in trace]
    # Keep every actual shot plus 16Hz context. Full per-tick pairs above still
    # determine the countermotion statistic; chart density is a separate bound.
    chart_interval = max(1, round(tickrate / 16))
    chart = [point for point in trace if point["shot_index"] is not None
             or (point["tick"] - first) % chart_interval == 0 or point["tick"] == end]
    if len(chart) > MAX_TRACE_POINTS:
        essential = [point for point in chart if point["shot_index"] is not None]
        others = [point for point in chart if point["shot_index"] is None]
        budget = max(0, MAX_TRACE_POINTS - len(essential))
        selected = {others[math.floor(i * len(others) / budget)]["tick"] for i in range(budget)} if budget else set()
        chart = [point for point in chart if point["shot_index"] is not None or point["tick"] in selected][:MAX_TRACE_POINTS]
    return {**base, "status": "observed" if any(s["punch_pitch_degrees"] is not None for s in trace) else "unavailable",
            "reason": None if any(s["punch_pitch_degrees"] is not None for s in trace) else "recoil_samples_missing",
            "hit_shots": hits, "damage": damage, "duration_ms": _q(1000 * (end - first) / tickrate, 2),
            "shot_hit_pct": _pct(hits, base["shots"]),
            "vertical_countermotion_pairs": opposing, "vertical_recoil_change_pairs": eligible_pairs,
            "vertical_countermotion_pct": _pct(opposing, eligible_pairs),
            "vertical_view_span_degrees": _q(max(pitch) - min(pitch)) if pitch else None,
            "horizontal_view_span_degrees": _q(max(yaw) - min(yaw)) if yaw else None,
            "trace_interval_ticks": chart_interval, "trace": chart}


def summarize_mechanics(targeting, stopping, sprays, weapon_counts=None, *, ambiguous_hurts=0):
    """Pool raw observations; rates and medians are never averaged by round."""
    observed = [o for o in targeting if o.get("first_shot_yaw_error_degrees") is not None]
    aligned = sum(o["first_shot_yaw_error_degrees"] <= ALIGNMENT_DEGREES for o in observed)
    eligible = [o for o in stopping if o.get("eligible") is True]
    success = sum(o.get("success") is True for o in eligible)
    shot_indices = defaultdict(lambda: {"shots": 0, "hit_shots": 0, "damage": 0})
    for burst in sprays:
        for point in burst["trace"]:
            if point["shot_index"] is not None:
                value = shot_indices[point["shot_index"]]
                value["shots"] += 1
                value["hit_shots"] += point["hit"] is True
                value["damage"] += point["damage"] or 0
    shots, hits = sum(o["shots"] for o in sprays), sum(o["hit_shots"] for o in sprays)
    countermotion_pairs = sum(o.get("vertical_countermotion_pairs", 0) for o in sprays)
    recoil_change_pairs = sum(o.get("vertical_recoil_change_pairs", 0) for o in sprays)
    weapons = []
    for weapon in sorted(set((weapon_counts or {}).keys()) | {o["weapon"] for o in targeting + stopping + sprays}):
        t = [o for o in observed if o["weapon"] == weapon]
        s = [o for o in eligible if o["weapon"] == weapon]
        p = [o for o in sprays if o["weapon"] == weapon]
        count = (weapon_counts or {}).get(weapon, {})
        weapons.append({"weapon": weapon, "bursts": count.get("bursts", len([o for o in stopping if o["weapon"] == weapon])),
                        "shots": count.get("shots"), "hit_shots": count.get("hit_shots"),
                        "shot_hit_pct": _pct(count.get("hit_shots", 0), count.get("shots", 0)),
                        "targeted_bursts": len(t), "median_first_shot_yaw_error_degrees": _median(o["first_shot_yaw_error_degrees"] for o in t),
                        "stopping_opportunities": len(s), "stopped_in_time": sum(o["success"] is True for o in s),
                        "stop_before_fire_pct": _pct(sum(o["success"] is True for o in s), len(s)), "spray_bursts": len(p)})
    return {"version": VERSION,
            "targeting": {"status": "observed" if observed else "unavailable", "reason": None if observed else "no_same_tick_damage_associated_target",
                          "associated_bursts": len(targeting), "observed_bursts": len(observed),
                          "alignment_threshold_degrees": ALIGNMENT_DEGREES, "aligned_first_shots": aligned,
                          "first_shot_alignment_pct": _pct(aligned, len(observed)),
                          "median_first_shot_yaw_error_degrees": _median(o["first_shot_yaw_error_degrees"] for o in observed),
                          "median_primary_correction_degrees": _median(o["primary_correction_degrees"] for o in targeting),
                          "median_secondary_correction_degrees": _median(o["secondary_correction_degrees"] for o in targeting),
                          "definition": "首个受伤敌人的水平位置与视角夹角；对准阈值为 2°。", "observations": targeting},
            "stopping": {"status": "observed" if eligible else "unavailable", "reason": None if eligible else "no_observed_grounded_move_to_fire_opportunities",
                         "eligible_opportunities": len(eligible), "stopped_in_time": success, "stop_before_fire_pct": _pct(success, len(eligible)),
                         "moving_at_fire": sum(o.get("reason") == "moving_at_fire" for o in eligible),
                         "unknown_opportunities": sum(o.get("eligible") is None for o in stopping),
                         "threshold_units_per_second": 10.0, "definition": "首发前 1 秒内有地面移动，且开枪前已连续两帧降至 10 单位/秒以内。", "observations": stopping},
            "spray": {"status": "observed" if any(o["status"] == "observed" for o in sprays) else "unavailable",
                      "reason": None if any(o["status"] == "observed" for o in sprays) else "no_observed_automatic_spray",
                      "bursts": len(sprays), "shots": shots, "hit_shots": hits, "shot_hit_pct": _pct(hits, shots),
                      "vertical_countermotion_pairs": countermotion_pairs, "vertical_recoil_change_pairs": recoil_change_pairs,
                      "vertical_countermotion_pct": _pct(countermotion_pairs, recoil_change_pairs),
                      "median_vertical_countermotion_pct": _median(o["vertical_countermotion_pct"] for o in sprays),
                      "definition": "自动武器连续 3 发以上的视角、后坐力与伤害记录。", "observations": sprays,
                      "shot_index_breakdown": [{"shot_index": i, **v, "shot_hit_pct": _pct(v["hit_shots"], v["shots"])} for i, v in sorted(shot_indices.items())]},
            "weapon_breakdown": weapons,
            "coverage": {"ambiguous_hurt_events": ambiguous_hurts, "hurt_association_max_tick_delay": 2,
                         "target_geometry": "horizontal_origin_bearing", "visibility_verified": False,
                         "recoil_scale_applied": None, "preaim_success_pct": None}}


def calculate_mechanics(events, dense_samples, target_samples, rounds, steamid, *, tickrate=64.0):
    """Attach per-round mechanics and return a correctly pooled match model."""
    from .l3 import _position_velocity
    own = sorted((dict(s) for s in dense_samples if steam_id(s.get("steamid")) == steamid), key=lambda x: x["tick"])
    own = _position_velocity(own, rounds, tickrate, 1)
    associations, ambiguous = _hurt_associations(events, rounds, steamid, tickrate)
    targeting, stopping, sprays, playback = [], [], [], []
    counts = defaultdict(lambda: {"bursts": 0, "shots": 0, "hit_shots": 0})
    by_round = defaultdict(lambda: {"targeting": [], "stopping": [], "sprays": [], "playback": [], "bursts": 0,
                                   "counts": defaultdict(lambda: {"bursts": 0, "shots": 0, "hit_shots": 0})})
    bursts = shot_bursts(events, rounds, steamid, tickrate)
    fire_origins = recorded_fire_origins(events.get("fire_bullets", []), steamid,
                                        {int(shot["tick"]) for burst in bursts for shot in burst["shots"]})
    for burst in bursts:
        base = _base(burst)
        round_ = burst["round"]
        samples = [s for s in own if round_["start_tick"] <= s["tick"] <= round_["end_tick"]]
        target = _target_observation(burst, samples, target_samples, associations, tickrate)
        stop = _stopping_observation(burst, samples, tickrate)
        spray = _spray_observation(burst, samples, associations, tickrate)
        by_round[base["round_number"]]["bursts"] += 1
        if len(playback) < MAX_PLAYBACK_WINDOWS:
            window = _aim_playback_window(burst, samples, target_samples, associations, tickrate, fire_origins)
            playback.append(window)
            by_round[base["round_number"]]["playback"].append(window)
        for array, key, value in ((targeting, "targeting", target), (stopping, "stopping", stop), (sprays, "sprays", spray)):
            if value is not None:
                array.append(value)
                by_round[base["round_number"]][key].append(value)
        for bucket in (counts[base["weapon"]], by_round[base["round_number"]]["counts"][base["weapon"]]):
            bucket["bursts"] += 1
            bucket["shots"] += base["shots"]
            bucket["hit_shots"] += sum(bool(associations.get((base["round_number"], int(s["tick"]), base["weapon"]))) for s in burst["shots"])
    for round_ in rounds:
        row = by_round[round_["round_number"]]
        round_.setdefault("analysis", {}).setdefault("level3", {})["mechanics"] = summarize_mechanics(
            row["targeting"], row["stopping"], row["sprays"], row["counts"])
        round_["analysis"]["level3"]["mechanics"]["aim_playback"] = _summarize_playback(row["playback"], row["bursts"])
    aggregate = summarize_mechanics(targeting, stopping, sprays, counts, ambiguous_hurts=ambiguous)
    aggregate["aim_playback"] = _summarize_playback(playback, sum(row["bursts"] for row in by_round.values()))
    aggregate["aim_playback"].pop("windows")
    # Raw traces have a single owner: round.analysis.level3.mechanics. The
    # match model carries pooled summaries without duplicating those arrays.
    for section in ("targeting", "stopping", "spray"):
        aggregate[section].pop("observations", None)
    return aggregate
