"""Bounded, inspectable L3 observations from GOTV events and dense self ticks.

These are server-demo observations, not raw mouse/key input. Visibility-based
metrics deliberately require a verified map/occlusion provider. The default
path never treats an enemy coordinate as a visible target.
"""

from __future__ import annotations

from collections import Counter, defaultdict
import math
import re
from statistics import median

from .metrics import _enemy, _live, _team, number, steam_id

VERSION = "3.3"
PATH_SECONDS = 0.25
BRAKE_SECONDS = 1.0
BURST_GAP_SECONDS = 0.3
STOP_SPEED = 10.0
PRIOR_MOVEMENT_SPEED = 80.0
MAX_DENSE_GAP_SECONDS = 0.08
MIN_STOP_SAMPLES = 2
FIREARMS = {
    "ak47", "aug", "awp", "bizon", "cz75a", "deagle", "elite", "famas",
    "fiveseven", "g3sg1", "galilar", "glock", "hkp2000", "m249", "m4a1",
    "m4a1_silencer", "mac10", "mag7", "mp5sd", "mp7", "mp9", "negev",
    "nova", "p250", "p90", "revolver", "sawedoff", "scar20", "sg556",
    "ssg08", "tec9", "ump45", "usp_silencer", "xm1014",
}
VISIBILITY_REASON = "verified_map_and_dynamic_occlusion_required"


def _records(rows):
    return rows.to_dict("records") if hasattr(rows, "to_dict") else list(rows or [])


def _median(values):
    return round(median(values), 3) if values else None


def _pct(n, d):
    return round(100 * n / d, 2) if d else None


def _weapon(row):
    return str(row.get("weapon") or "").removeprefix("weapon_")


def _value(row, field, prefix=""):
    return number(row.get(prefix + field))


def _speed(row, prefix=""):
    x, y = _value(row, "velocity_X", prefix), _value(row, "velocity_Y", prefix)
    return math.hypot(x, y) if x is not None and y is not None else None


def _angles(row, prefix=""):
    pitch, yaw = _value(row, "pitch", prefix), _value(row, "yaw", prefix)
    return (pitch, yaw) if pitch is not None and yaw is not None and -90 <= pitch <= 90 else None


def _look(angles):
    pitch, yaw = map(math.radians, angles)
    return math.cos(pitch) * math.cos(yaw), math.cos(pitch) * math.sin(yaw), -math.sin(pitch)


def _angular_distance(a, b):
    # Unit-vector angle is stable at the yaw wrap and near vertical pitch.
    va, vb = _look(a), _look(b)
    dot = max(-1.0, min(1.0, sum(x * y for x, y in zip(va, vb))))
    return math.degrees(math.acos(dot))


def _first_bursts(shots):
    previous = None
    result = []
    for shot in sorted(shots, key=lambda s: s["tick"]):
        if (previous is None or _weapon(previous) != _weapon(shot)
                or shot["tick"] - previous["tick"] > BURST_GAP_SECONDS * shot["_tickrate"]):
            result.append(shot)
        previous = shot
    return result


def _continuous(rows, start, end, tickrate, interval):
    return (len(rows) >= 3 and rows[0]["tick"] <= start + interval
            and rows[-1]["tick"] == end
            and all(0 < b["tick"] - a["tick"] <= MAX_DENSE_GAP_SECONDS * tickrate + 1e-6
                    for a, b in zip(rows, rows[1:])))


def _position_velocity(samples, rounds, tickrate, interval):
    """Derive interval-average motion; never trust filtered parse_ticks velocity.

    demoparser2 0.42.0's custom velocity fields subtract the two previous
    *selected* positions and multiply by 64 without dividing by their tick gap.
    In parse_ticks this inflates 4-tick sampling and crosses separated windows.
    A coordinate difference is usable only across a short, living pair in the
    same observed live round. Each invalid pair stays unknown, not zero/capped.
    """
    output = []
    previous = None
    for original in samples:
        row = dict(original)
        row.update(velocity_X=None, velocity_Y=None,
                   velocity_source="position_delta_over_actual_tick_delta",
                   velocity_interval_ticks=None, velocity_interval_start_tick=None,
                   velocity_reason="no_previous_dense_sample")
        current_round = next((i for i, r in enumerate(rounds) if r["start_tick"] <= row["tick"] <= r["end_tick"]), None)
        if previous is not None:
            old, previous_round = previous
            gap = row["tick"] - old["tick"]
            if current_round is None or previous_round != current_round:
                row["velocity_reason"] = "round_boundary"
            elif not 0 < gap <= interval:
                row["velocity_reason"] = "dense_sample_gap"
            elif old.get("is_alive") is not True or row.get("is_alive") is not True:
                row["velocity_reason"] = "living_state_not_verified"
            else:
                xy = [_value(r, axis) for r in (old, row) for axis in ("X", "Y")]
                if any(v is None for v in xy):
                    row["velocity_reason"] = "position_coordinates_missing"
                else:
                    row.update(velocity_X=(xy[2] - xy[0]) * tickrate / gap,
                               velocity_Y=(xy[3] - xy[1]) * tickrate / gap,
                               velocity_interval_ticks=gap,
                               velocity_interval_start_tick=int(old["tick"]), velocity_reason=None)
        output.append(row)
        previous = original, current_round
    return output


def _movement_suffix(samples, tick, start):
    """Only use consecutive valid displacement intervals ending at this shot.

    A missing coordinate or life-state record breaks the suffix even if the
    surrounding valid rows are close enough to pass a generic gap threshold.
    """
    selected = [s for s in samples if start <= s["tick"] <= tick]
    if not selected or selected[-1]["tick"] != tick:
        return [], "dense_samples_not_observed"
    suffix = []
    for sample in reversed(selected):
        if _speed(sample) is None:
            reason = sample.get("velocity_reason") or "dense_sample_gap"
            return list(reversed(suffix)), reason
        if suffix and suffix[-1].get("velocity_interval_start_tick") != sample["tick"]:
            return list(reversed(suffix)), "dense_sample_gap"
        suffix.append(sample)
    return list(reversed(suffix)), None


def _braking_observation(shot, samples, round_, tickrate, interval, speed, speed_source, airborne):
    tick = int(shot["tick"])
    requested_start = tick - round(BRAKE_SECONDS * tickrate)
    start = max(round_["start_tick"], requested_start)
    suffix, break_reason = _movement_suffix(samples, tick, start)
    first_interval = suffix[0].get("velocity_interval_start_tick") if suffix else None
    complete = first_interval is not None and first_interval <= requested_start and requested_start >= round_["start_tick"]
    clipped = requested_start < round_["start_tick"]
    reason_aliases = {"no_previous_dense_sample": "prior_movement_not_observed", "round_boundary": "round_start_clipped"}
    window_reason = None if complete else "round_start_clipped" if clipped else reason_aliases.get(break_reason, break_reason) or "dense_sample_gap"
    peak = max((_speed(s) for s in suffix), default=None)
    observation = {"tick": tick, "weapon": _weapon(shot), "speed": round(speed, 3) if speed is not None else None,
                   "speed_source": speed_source, "airborne": airborne if isinstance(airborne, bool) else None,
                   "status": "observed" if complete else "unavailable", "reason": window_reason,
                   "braking_status": "unavailable", "braking_reason": None, "stop_kind": None,
                   "stop_to_shot_ms": None, "stop_to_shot_ms_min": None, "stop_to_shot_ms_max": None,
                   "stop_tick": None, "stop_interval_start_tick": None, "stop_interval_end_tick": None,
                   "prior_peak_speed": round(peak, 3) if peak is not None else None,
                   "transition_peak_speed": None,
                   "window_start_tick": start, "requested_window_seconds": BRAKE_SECONDS,
                   "window_complete": complete, "window_reason": window_reason, "window_samples": len(suffix),
                   "continuous_suffix_ms": round(1000 * (tick - first_interval) / tickrate, 2) if first_interval is not None else 0.0,
                   "stationary_interval_samples": 0, "minimum_stationary_interval_samples": MIN_STOP_SAMPLES}
    def fail(reason, status="unavailable"):
        observation.update(braking_status=status, braking_reason=reason)
        return observation
    # These are observed firing states, not missing measurements or failed
    # counter-strafes. A full one-second history is unnecessary to classify them.
    if airborne is True:
        return fail("airborne_at_shot", "not_applicable")
    if speed is None:
        return fail("shot_velocity_missing")
    if speed > STOP_SPEED:
        return fail("moving_at_shot", "not_applicable")
    if airborne is not False:
        return fail("ground_state_unknown")
    if not suffix:
        return fail(window_reason or "dense_samples_not_observed")
    # Event motion is a lagged two-previous-tick estimate; dense motion is an
    # interval average. Disagreement near a transition is reported, not resolved
    # by inventing an instantaneous stop at the firing tick.
    if _speed(suffix[-1]) > STOP_SPEED:
        return fail("event_dense_motion_disagreement")
    last_moving = max((i for i, s in enumerate(suffix) if _speed(s) > STOP_SPEED), default=None)
    stationary = suffix[last_moving + 1:] if last_moving is not None else suffix
    observation["stationary_interval_samples"] = len(stationary)
    if last_moving is None:
        return fail("already_stationary_in_lookback", "not_applicable") if complete else fail("prior_movement_not_observed")
    transition = suffix[last_moving:]
    if any(s.get("is_airborne") is True for s in transition):
        return fail("airborne_during_transition", "not_applicable")
    if any(s.get("is_airborne") is not False for s in transition):
        return fail("ground_state_unknown_during_transition")
    if len(stationary) < MIN_STOP_SAMPLES:
        return fail("stop_not_sustained_before_shot")
    stop = stationary[0]
    movement_start = last_moving
    while movement_start > 0 and _speed(suffix[movement_start - 1]) > STOP_SPEED:
        movement_start -= 1
    transition_peak = max(_speed(s) for s in suffix[movement_start:last_moving + 1])
    bracket_start = suffix[last_moving].get("velocity_interval_start_tick")
    bracket_end = int(stop["tick"])
    delay = round(1000 * (tick - bracket_end) / tickrate, 2)
    observation.update(braking_status="observed", braking_reason=None,
                       stop_kind="fast_brake" if transition_peak >= PRIOR_MOVEMENT_SPEED else "slow_stop",
                       transition_peak_speed=round(transition_peak, 3),
                       stop_tick=bracket_end, stop_interval_start_tick=bracket_start, stop_interval_end_tick=bracket_end,
                       stop_to_shot_ms=delay, stop_to_shot_ms_min=delay,
                       stop_to_shot_ms_max=round(1000 * (tick - bracket_start) / tickrate, 2))
    return observation


def _braking_summary(observations):
    statuses = dict(Counter(p["braking_status"] for p in observations))
    reasons = dict(Counter(p["braking_reason"] for p in observations if p["braking_reason"]))
    times = [p["stop_to_shot_ms"] for p in observations if p["stop_to_shot_ms"] is not None]
    status = "observed" if times else "not_applicable" if observations and all(p["braking_status"] == "not_applicable" for p in observations) else "unavailable"
    reason = None if times else max(reasons, key=reasons.get) if reasons else "no_first_burst_shots"
    return {"braking_status": status, "braking_reason": reason,
            "braking_status_counts": statuses, "braking_reason_counts": reasons,
            "observed_braking_shots": len(times), "observed_fast_braking_shots": sum(p["stop_kind"] == "fast_brake" for p in observations),
            "observed_slow_stop_shots": sum(p["stop_kind"] == "slow_stop" for p in observations),
            "complete_movement_windows": sum(p["window_complete"] for p in observations),
            "observed_partial_window_stops": sum(p["braking_status"] == "observed" and not p["window_complete"] for p in observations),
            "motion_source_counts": dict(Counter(p["speed_source"] for p in observations if p["speed_source"])),
            "event_dense_disagreement_shots": sum(p.get("event_dense_motion_disagreement") is True for p in observations),
            "median_stop_to_shot_ms": _median(times)}


def _shot_models(shots, samples, round_, tickrate, interval):
    bursts = _first_bursts(shots)
    paths, braking, shot_speeds = [], [], []
    for shot in bursts:
        tick = int(shot["tick"])
        start = max(round_["start_tick"], tick - round(PATH_SECONDS * tickrate))
        angle_rows = [s for s in samples if start <= s["tick"] <= tick and _angles(s) is not None]
        path = {"tick": tick, "weapon": _weapon(shot), "status": "unavailable",
                "reason": "dense_angle_window_incomplete", "path_degrees": None,
                "net_turn_degrees": None, "excess_turn_degrees": None, "trace": []}
        # A window shortened by round start is not comparable with the fixed
        # quarter-second observation window used for other bursts.
        if tick - round_["start_tick"] >= PATH_SECONDS * tickrate and _continuous(angle_rows, start, tick, tickrate, interval):
            total = sum(_angular_distance(_angles(a), _angles(b)) for a, b in zip(angle_rows, angle_rows[1:]))
            net = _angular_distance(_angles(angle_rows[0]), _angles(angle_rows[-1]))
            path.update(status="observed", reason=None, path_degrees=round(total, 3),
                        net_turn_degrees=round(net, 3), excess_turn_degrees=round(max(0, total - net), 3),
                        trace=[{"tick": int(s["tick"]), "offset_ms": round(1000 * (s["tick"] - tick) / tickrate, 2),
                                "pitch": _angles(s)[0], "yaw": _angles(s)[1]} for s in angle_rows])
        paths.append(path)
        # Full-event parsing maintains consecutive-tick history, unlike filtered
        # parse_ticks. Its custom velocity is a lagged two-previous-position
        # estimate with a hardcoded 64Hz multiplier, so use it only at 64Hz.
        at_shot = next((s for s in samples if s["tick"] == tick), None)
        event_speed = _speed(shot, "user_") if math.isclose(tickrate, 64.0, abs_tol=0.001) else None
        dense_speed = _speed(at_shot) if at_shot else None
        dense_interval = at_shot.get("velocity_interval_ticks") if at_shot else None
        # A verified adjacent-position interval ending at the actual firing tick
        # is better aligned than demoparser2's lagged event custom velocity.
        # Coarse legacy dense averages remain a fallback, not a replacement for
        # the event estimate, since they may span a real last-moment stop.
        if dense_speed is not None and dense_interval == 1:
            speed, speed_source = dense_speed, "dense_one_tick_position_interval_average"
        elif event_speed is not None:
            speed, speed_source = event_speed, "event_previous_tick_position_delta_64hz"
        else:
            speed, speed_source = dense_speed, "dense_position_interval_average" if dense_speed is not None else None
        airborne = at_shot.get("is_airborne") if at_shot and dense_interval == 1 else shot.get("user_is_airborne")
        if not isinstance(airborne, bool):
            airborne = shot.get("user_is_airborne") if isinstance(shot.get("user_is_airborne"), bool) else at_shot.get("is_airborne") if at_shot else None
        if speed is not None:
            shot_speeds.append(speed)
        observation = _braking_observation(shot, samples, round_, tickrate, interval, speed, speed_source, airborne)
        observation.update(event_speed=round(event_speed, 3) if event_speed is not None else None,
                           dense_speed=round(dense_speed, 3) if dense_speed is not None else None,
                           dense_speed_interval_ticks=dense_interval,
                           event_dense_motion_disagreement=(event_speed > STOP_SPEED) != (dense_speed > STOP_SPEED) if event_speed is not None and dense_speed is not None else None)
        braking.append(observation)
    observed = [p for p in paths if p["status"] == "observed"]
    crosshair = {"status": "observed" if observed else "unavailable",
                 "reason": None if observed else "dense_angle_window_incomplete",
                 "burst_windows": len(bursts), "observed_windows": len(observed),
                 "median_path_degrees": _median([p["path_degrees"] for p in observed]),
                 "median_net_turn_degrees": _median([p["net_turn_degrees"] for p in observed]),
                 "median_excess_turn_degrees": _median([p["excess_turn_degrees"] for p in observed]),
                 "window_seconds": PATH_SECONDS, "observations": paths,
                 "definition": "Summed sampled view-direction arc, net rotation and excess path during 250ms before burst-first fire. Excess is path minus net, not target correction or aim error; sampled path is a lower bound."}
    counter = {"status": "observed" if shot_speeds else "unavailable",
               "reason": None if shot_speeds else "shot_velocity_not_observed",
               "first_burst_shots": len(bursts), "shots_with_speed": len(shot_speeds),
               "moving_first_burst_shots": sum(v > STOP_SPEED for v in shot_speeds),
               "moving_first_burst_pct": _pct(sum(v > STOP_SPEED for v in shot_speeds), len(shot_speeds)),
               **_braking_summary(braking), "counter_strafe_input_verified": False,
               "counter_strafe_success_pct": None, "stop_speed_threshold": STOP_SPEED,
               "prior_movement_threshold": STOP_SPEED, "fast_prior_movement_threshold": PRIOR_MOVEMENT_SPEED,
               "lookback_seconds": BRAKE_SECONDS, "minimum_stationary_interval_samples": MIN_STOP_SAMPLES,
               "sampling_uncertainty_ms": round(2000 * interval / tickrate, 2), "observations": braking,
               "stop_timing_definition": "The displayed delay ends at the first observed <=10 units/s interval endpoint after moving. Min/max span the adjacent moving and stopped position intervals; these are server-demo sampling bounds, not client-input or subtick reaction measurements.",
               "dense_velocity_definition": "Interval-average horizontal motion from own alive positions: (current-position minus previous-position)*tickrate/actual_tick_gap; gaps >sampling interval, round boundaries and missing positions are unknown. Filtered demoparser2 custom velocity is never used.",
               "definition": "Burst-first movement prefers a valid one-tick position interval ending at the shot; legacy fallback is the 64Hz event parser's lagged estimate, then a marked dense interval average. Both motion sources and disagreements remain visible. Moving means >10 units/s. Stops require an observed grounded >10 to <=10 units/s transition followed by at least two stationary displacement intervals within a continuous suffix of the one-second lookback. Peak >=80 in the immediately preceding uninterrupted moving segment identifies fast_brake; lower-speed motion is slow_stop. Partial windows retain explicit coverage; moving or already-stationary shots are not missing data. No opposite-key input, weapon accuracy recovery or counter-strafe success is inferred."}
    return crosshair, counter


def _merged_intervals(intervals):
    merged = []
    for start, end in sorted(intervals):
        if merged and start <= merged[-1][1]:
            merged[-1] = (merged[-1][0], max(merged[-1][1], end))
        else:
            merged.append((start, end))
    return merged


def _flash_and_smoke(events, round_, steamid, tickrate, available):
    intervals = {"enemy": defaultdict(list), "team": defaultdict(list), "self": defaultdict(list)}
    raw_duration_events = 0
    friendly_blind_ticks = []
    incomplete_groups = set()
    missing_duration_events = 0
    for event in events.get("player_blind", []):
        if steam_id(event.get("attacker_steamid")) != steamid:
            continue
        victim = steam_id(event.get("user_steamid"))
        duration = number(event.get("blind_duration"))
        if not victim:
            incomplete_groups.update(intervals)
            continue
        own_team, victim_team = _team(event.get("attacker_team_num")), _team(event.get("user_team_num"))
        if own_team not in (2, 3) or victim_team not in (2, 3):
            incomplete_groups.update(intervals)
            continue
        group = "self" if victim == steamid else "team" if own_team == victim_team else "enemy"
        if group == "team":
            friendly_blind_ticks.append(int(event["tick"]))
        if duration is None or duration < 0:
            incomplete_groups.add(group)
            missing_duration_events += 1
            continue
        end = min(round_["end_tick"], event["tick"] + duration * tickrate)
        intervals[group][victim].append((event["tick"], end))
        raw_duration_events += 1
    for group in intervals.values():
        for victim, items in group.items():
            group[victim] = _merged_intervals(items)
    def seconds(group):
        if group in incomplete_groups:
            return None
        return round(sum(end - start for rows in intervals[group].values() for start, end in rows) / tickrate, 3)
    def during(group, victim, tick):
        return any(start <= tick < end for start, end in intervals[group].get(victim, []))
    deaths = events.get("player_death", [])
    blind_kills = [e for e in deaths if _enemy(e) and during("enemy", steam_id(e.get("user_steamid")), e["tick"])]
    team_deaths = [e for e in deaths if during("team", steam_id(e.get("user_steamid")), e["tick"])]
    smoke_flags_known = all(isinstance(e.get("thrusmoke"), bool) for e in deaths)
    flash_observed = "player_blind" in available
    smoke_count = sum(steam_id(e.get("user_steamid")) == steamid for e in events.get("smokegrenade_detonate", []))
    flash_count = sum(steam_id(e.get("user_steamid")) == steamid for e in events.get("flashbang_detonate", []))
    return {"status": "observed" if flash_observed or "smokegrenade_detonate" in available else "unavailable",
            "reason": None if flash_observed or "smokegrenade_detonate" in available else "utility_streams_not_observed",
            "enemy_blind_seconds_union": seconds("enemy") if flash_observed else None,
            "team_blind_seconds_union": seconds("team") if flash_observed else None,
            "self_blind_seconds_union": seconds("self") if flash_observed else None,
            "reported_duration_events": raw_duration_events if flash_observed else None,
            "blind_events_missing_duration": missing_duration_events if flash_observed else None,
            "blind_interval_coverage_complete": not incomplete_groups if flash_observed else None,
            "enemy_kills_during_reported_blind": len(blind_kills) if flash_observed and "enemy" not in incomplete_groups else None,
            "self_kills_during_reported_blind": sum(steam_id(e.get("attacker_steamid")) == steamid for e in blind_kills) if flash_observed and "enemy" not in incomplete_groups else None,
            "teammate_deaths_during_reported_team_blind": len(team_deaths) if flash_observed and "team" not in incomplete_groups else None,
            "flash_assists": sum(_enemy(e) and steam_id(e.get("assister_steamid")) == steamid and e.get("assistedflash") is True for e in deaths),
            "kills_through_smoke": sum(_enemy(e) and steam_id(e.get("attacker_steamid")) == steamid and e.get("thrusmoke") is True for e in deaths) if smoke_flags_known else None,
            "smoke_detonations": smoke_count if "smokegrenade_detonate" in available else None,
            "flash_detonations": flash_count if "flashbang_detonate" in available else None,
            "friendly_blind_event_ticks": sorted(set(friendly_blind_ticks)),
            "smoke_tactical_score": None, "smoke_tactical_status": "unavailable",
            "smoke_tactical_reason": "dynamic_smoke_occlusion_and_counterfactual_not_available",
            "evidence_ticks": sorted({int(e["tick"]) for e in blind_kills + team_deaths}),
            "definition": "Blind duration intervals are unioned per victim and clipped to this round; they remain reported durations, not measured full blindness. Kills during intervals are temporal associations, not causal flash credit. Through-smoke is the death-event flag and cannot identify whose smoke blocked which angle."}


def _visibility_gate(provider, map_identity, rounds):
    """Accept an externally verified occlusion implementation, never raw positions.

    The provider owns geometry/runtime validation and exposes metadata plus
    visibility_samples(round_, steamid). Requiring the exact validated map hash
    prevents silently using a similarly named or outdated map mesh. Dynamic
    occlusion includes smokes/doors; static triangles alone are insufficient.
    """
    if provider is None or not isinstance(map_identity, dict):
        return False, VISIBILITY_REASON, None
    meta = getattr(provider, "metadata", None)
    if not isinstance(meta, dict):
        return False, "visibility_provider_metadata_missing", None
    if (map_identity.get("verified") is not True or not re.fullmatch(r"[a-fA-F0-9]{64}", str(map_identity.get("map_sha256", "")))
            or meta.get("map_sha256") != map_identity["map_sha256"] or meta.get("map_name") != map_identity.get("map_name")):
        return False, "visibility_map_identity_not_verified", None
    required = ("static_occlusion_verified", "dynamic_occlusion_verified", "view_origin_verified",
                "target_head_verified", "field_of_view_verified")
    if (not all(meta.get(key) is True for key in required) or not meta.get("geometry_version")
            or not re.fullmatch(r"[a-fA-F0-9]{64}", str(meta.get("geometry_sha256", "")))):
        return False, "visibility_provider_coverage_incomplete", None
    start, end = number(meta.get("coverage_start_tick")), number(meta.get("coverage_end_tick"))
    if rounds and (start is None or end is None or start > min(r["start_tick"] for r in rounds) or end < max(r["end_tick"] for r in rounds)):
        return False, "visibility_temporal_coverage_incomplete", None
    step = number(meta.get("temporal_step_ticks"))
    if step is None or step <= 0 or not callable(getattr(provider, "visibility_samples", None)):
        return False, "visibility_provider_interface_incomplete", None
    return True, None, dict(meta, temporal_step_ticks=step)


def _visibility_models(provider, enabled, reason, metadata, round_, events, steamid, tickrate):
    visibility = {"status": "unavailable", "reason": reason, "visible_onsets": None,
                  "definition": "Requires exact map identity, static geometry, dynamic occlusion, verified eye origin, field of view and target head positions. Enemy coordinates alone never establish visibility."}
    preaim = {"status": "unavailable", "reason": reason, "median_deviation_degrees": None, "observations": [],
              "definition": "Angle between view direction and verified target-head direction at a sampled false-to-true visibility transition."}
    reaction = {"status": "unavailable", "reason": reason, "median_estimated_latency_ms": None, "observations": [],
                "definition": "Estimated sampled visible-onset to first target-associated shot that causes a hurt within 125ms; hit-conditioned server-demo latency, not human reaction time. Network and sampling delay remain."}
    if not enabled:
        return visibility, preaim, reaction
    # Providers must emit explicit invisible samples as well as visible ones;
    # a first observation that is already visible is not a visibility onset.
    rows = _records(provider.visibility_samples(round_, steamid))
    groups = defaultdict(list)
    for row in rows:
        target = steam_id(row.get("target_steamid"))
        tick = number(row.get("tick"))
        enemy_team = 3 if round_.get("side") == "T" else 2
        if (target and target != steamid and _team(row.get("target_team_num")) == enemy_team
                and tick is not None and round_["start_tick"] <= tick <= round_["end_tick"] and isinstance(row.get("visible"), bool)):
            groups[target].append(row)
    onsets = []
    max_gap = min(metadata["temporal_step_ticks"] * 1.01, tickrate * MAX_DENSE_GAP_SECONDS)
    for target, samples in groups.items():
        samples.sort(key=lambda s: s["tick"])
        for a, b in zip(samples, samples[1:]):
            if a["visible"] is not False or b["visible"] is not True or not 0 < b["tick"] - a["tick"] <= max_gap:
                continue
            origin = [_value(b, "eye_" + axis) for axis in ("x", "y", "z")]
            target_pos = [_value(b, "target_" + axis) for axis in ("x", "y", "z")]
            angles = _angles(b)
            if angles is None or any(v is None for v in origin + target_pos):
                continue
            delta = [x - y for x, y in zip(target_pos, origin)]
            norm = math.sqrt(sum(v * v for v in delta))
            if norm <= 0:
                continue
            dot = max(-1.0, min(1.0, sum(v * d / norm for v, d in zip(_look(angles), delta))))
            onset = {"tick": int(b["tick"]), "target_steamid": target,
                     "deviation_degrees": round(math.degrees(math.acos(dot)), 3),
                     "onset_uncertainty_ms": round(1000 * (b["tick"] - a["tick"]) / tickrate, 2)}
            onsets.append(onset)
            # Associate only a shot followed by damage to this target. This is
            # intentionally not a general all-opportunity reaction score.
            fires = [s for s in events.get("weapon_fire", []) if steam_id(s.get("user_steamid")) == steamid
                     and _weapon(s) in FIREARMS and 0 <= s["tick"] - b["tick"] <= tickrate]
            if not fires:
                continue
            shot = min(fires, key=lambda e: e["tick"])
            hurt = next((h for h in events.get("player_hurt", []) if steam_id(h.get("attacker_steamid")) == steamid
                         and steam_id(h.get("user_steamid")) == target and _enemy(h)
                         and 0 <= h["tick"] - shot["tick"] <= tickrate * 0.125), None)
            visible_segment = [s for s in samples if b["tick"] <= s["tick"] <= shot["tick"]]
            covers_shot = (visible_segment and shot["tick"] - visible_segment[-1]["tick"] <= max_gap
                           and all(0 < y["tick"] - x["tick"] <= max_gap for x, y in zip(visible_segment, visible_segment[1:])))
            if hurt is not None and covers_shot and all(s.get("visible") is True for s in visible_segment):
                reaction["observations"].append({"tick": int(shot["tick"]), "visible_tick": int(b["tick"]),
                                                  "target_steamid": target, "estimated_latency_ms": round(1000 * (shot["tick"] - b["tick"]) / tickrate, 2),
                                                  "onset_uncertainty_ms": onset["onset_uncertainty_ms"]})
    visibility.update(status="verified_provider", reason=None, visible_onsets=len(onsets),
                      geometry_version=metadata["geometry_version"], map_sha256=metadata["map_sha256"],
                      geometry_sha256=metadata["geometry_sha256"])
    preaim.update(status="observed" if onsets else "unavailable", reason=None if onsets else "no_verified_visibility_onsets",
                  median_deviation_degrees=_median([s["deviation_degrees"] for s in onsets]), observations=onsets)
    obs = reaction["observations"]
    reaction.update(status="estimated" if obs else "unavailable", reason=None if obs else "no_target_associated_visibility_shot_pairs",
                    median_estimated_latency_ms=_median([o["estimated_latency_ms"] for o in obs]))
    return visibility, preaim, reaction


def _decision(round_, counter, utility):
    """A disclosed evidence rubric for review, not an inferred optimal action."""
    components = []
    def add(key, weight, value, ticks, definition):
        components.append({"key": key, "weight": weight, "value": round(value, 2),
                           "evidence_ticks": ticks, "definition": definition})
    analysis = round_.get("analysis", {})
    timeline = analysis.get("timeline", [])
    if round_.get("deaths", 0) > 0:
        add("death_trade_outcome", 35, 100 if round_.get("traded") is True else 0,
            [e["tick"] for e in timeline if e.get("type") == "death"],
            "100 if this observed death was traded within five seconds, otherwise 0; also depends on teammate actions.")
    if round_.get("opening_kill") or round_.get("opening_death"):
        add("opening_outcome", 25, 100 if round_.get("opening_kill") else 0,
            [e["tick"] for e in timeline if e.get("type") in ("kill", "death")][:1],
            "100 for round opening kill, 0 for opening death; outcome does not prove the choice was good/bad.")
    if counter["shots_with_speed"]:
        add("first_burst_stationary_share", 25, 100 - counter["moving_first_burst_pct"],
            [s["tick"] for s in counter["observations"] if s["speed"] is not None],
            "Share of observed burst-first shots at <=10 horizontal units/s; weapon/context can justify moving fire.")
    if utility.get("flash_detonations") and utility.get("team_blind_seconds_union") is not None:
        add("friendly_flash_protection", 15, 100 if utility["team_blind_seconds_union"] == 0 else 0,
            utility["friendly_blind_event_ticks"], "100 when own observed flash detonations have no reported teammate blind interval, otherwise 0.")
    weight = sum(c["weight"] for c in components)
    score = round(sum(c["weight"] * c["value"] for c in components) / weight, 1) if len(components) >= 2 else None
    return {"status": "heuristic" if score is not None else "unavailable",
            "reason": None if score is not None else "fewer_than_two_applicable_evidence_components",
            "score": score, "available_weight": weight, "possible_weight": 100,
            "components": components, "scope": "limited_evidence_heuristic", "professional_rating": False,
            "definition": "Review rubric: weighted mean of applicable death-trade outcome(35), opening outcome(25), stationary first-burst share(25), and friendly-flash protection(15). At least two components required. Different coverage is not directly comparable; no map visibility, communication, intention, counterfactual or pro benchmark is inferred."}


def calculate_l3(events, dense_samples, rounds, steamid, *, tickrate=64.0,
                 available_events=None, visibility_provider=None, map_identity=None, sampling=None):
    """Attach ``round.analysis.level3`` and return weighted game observations.

    Inputs are transient event rows and bounded, exact-player dense self ticks.
    Samples from another Steam identity are always excluded. A caller may pass a
    verified optional visibility provider; absent providers produce null values.
    """
    if not isinstance(tickrate, (int, float)) or not math.isfinite(tickrate) or tickrate <= 0:
        raise ValueError("tickrate must be finite and positive")
    steamid = steam_id(steamid)
    if not steamid:
        raise ValueError("steamid must be an exact Steam identity")
    events = {name: _records(rows) for name, rows in events.items()}
    available = set(available_events if available_events is not None else (n for n, rows in events.items() if rows))
    sampling = dict(sampling or {})
    interval = number(sampling.get("interval_ticks")) or max(1, round(tickrate / 16))
    samples_by_tick = {}
    for row in _records(dense_samples):
        tick = number(row.get("tick"))
        if steam_id(row.get("steamid")) == steamid and tick is not None and tick == int(tick) and row.get("is_alive") is not False:
            samples_by_tick[int(tick)] = dict(row, tick=int(tick))
    samples = _position_velocity(sorted(samples_by_tick.values(), key=lambda s: s["tick"]), rounds, tickrate, interval)
    enabled, reason, metadata = _visibility_gate(visibility_provider, map_identity, rounds)
    output = []
    for round_ in rounds:
        start, end = round_["start_tick"], round_["end_tick"]
        selected = {name: [e for e in rows if number(e.get("tick")) is not None and start <= e["tick"] <= end and _live(e)] for name, rows in events.items()}
        shots = [dict(s, _tickrate=tickrate) for s in selected.get("weapon_fire", [])
                 if steam_id(s.get("user_steamid")) == steamid and _weapon(s) in FIREARMS]
        own_samples = [s for s in samples if start <= s["tick"] <= end]
        crosshair, counter = _shot_models(shots, own_samples, round_, tickrate, interval)
        utility = _flash_and_smoke(selected, round_, steamid, tickrate, available)
        visibility, preaim, reaction = _visibility_models(visibility_provider, enabled, reason, metadata, round_, selected, steamid, tickrate)
        row = {"version": VERSION, "crosshair": crosshair, "counter_strafe": counter,
               "utility_effects": utility, "visibility": visibility, "preaim": preaim, "reaction": reaction,
               "decision_quality": _decision(round_, counter, utility)}
        round_.setdefault("analysis", {})["level3"] = row
        output.append(row)
    paths = [p for row in output for p in row["crosshair"]["observations"] if p["status"] == "observed"]
    bursts = [p for row in output for p in row["counter_strafe"]["observations"]]
    speeds = [p["speed"] for p in bursts if p["speed"] is not None]
    def total(section, key):
        known = [r[section].get(key) for r in output if r[section].get(key) is not None]
        return round(sum(known), 3) if known else None
    crosshair = {key: output[0]["crosshair"][key] for key in ("definition", "window_seconds")} if output else {}
    crosshair.update(status="observed" if paths else "unavailable", reason=None if paths else "dense_angle_window_incomplete",
                     burst_windows=sum(r["crosshair"]["burst_windows"] for r in output), observed_windows=len(paths),
                     median_path_degrees=_median([p["path_degrees"] for p in paths]),
                     median_net_turn_degrees=_median([p["net_turn_degrees"] for p in paths]),
                     median_excess_turn_degrees=_median([p["excess_turn_degrees"] for p in paths]))
    counter = {key: output[0]["counter_strafe"][key] for key in ("definition", "dense_velocity_definition", "stop_timing_definition", "stop_speed_threshold", "prior_movement_threshold", "fast_prior_movement_threshold", "lookback_seconds", "minimum_stationary_interval_samples", "sampling_uncertainty_ms")} if output else {}
    counter.update(status="observed" if speeds else "unavailable", reason=None if speeds else "shot_velocity_not_observed",
                   first_burst_shots=len(bursts), shots_with_speed=len(speeds),
                   moving_first_burst_shots=sum(v > STOP_SPEED for v in speeds),
                   moving_first_burst_pct=_pct(sum(v > STOP_SPEED for v in speeds), len(speeds)),
                   **_braking_summary(bursts),
                   counter_strafe_input_verified=False, counter_strafe_success_pct=None)
    utility_keys = ("enemy_blind_seconds_union", "team_blind_seconds_union", "self_blind_seconds_union",
                    "reported_duration_events", "blind_events_missing_duration", "enemy_kills_during_reported_blind", "self_kills_during_reported_blind",
                    "teammate_deaths_during_reported_team_blind", "flash_assists", "kills_through_smoke", "smoke_detonations", "flash_detonations")
    utility = {key: total("utility_effects", key) for key in utility_keys}
    # Do not present a sum over known rounds as a full-match union when any
    # own blind interval is unobservable in a relevant round.
    for key in ("enemy_blind_seconds_union", "team_blind_seconds_union", "self_blind_seconds_union",
                "enemy_kills_during_reported_blind", "self_kills_during_reported_blind", "teammate_deaths_during_reported_team_blind"):
        if any(r["utility_effects"].get(key) is None for r in output):
            utility[key] = None
    utility["blind_interval_coverage_complete"] = all(r["utility_effects"].get("blind_interval_coverage_complete") is True for r in output) if output else None
    observed_utility = any(r["utility_effects"]["status"] == "observed" for r in output)
    utility.update(status="observed" if observed_utility else "unavailable", reason=None if observed_utility else "utility_streams_not_observed",
                   smoke_tactical_score=None, smoke_tactical_status="unavailable",
                   smoke_tactical_reason="dynamic_smoke_occlusion_and_counterfactual_not_available",
                   definition=output[0]["utility_effects"]["definition"] if output else None)
    preaim_obs = [o for r in output for o in r["preaim"]["observations"]]
    reaction_obs = [o for r in output for o in r["reaction"]["observations"]]
    visibility = dict(output[0]["visibility"]) if output else {"status": "unavailable", "reason": reason}
    visibility["visible_onsets"] = len(preaim_obs) if enabled else None
    preaim = {"status": "observed" if preaim_obs else "unavailable", "reason": None if preaim_obs else (reason or "no_verified_visibility_onsets"),
              "median_deviation_degrees": _median([o["deviation_degrees"] for o in preaim_obs]), "observations": len(preaim_obs) if enabled else None,
              "definition": output[0]["preaim"]["definition"] if output else None}
    reaction = {"status": "estimated" if reaction_obs else "unavailable", "reason": None if reaction_obs else (reason or "no_target_associated_visibility_shot_pairs"),
                "median_estimated_latency_ms": _median([o["estimated_latency_ms"] for o in reaction_obs]), "observations": len(reaction_obs) if enabled else None,
                "definition": output[0]["reaction"]["definition"] if output else None}
    scored = [r["decision_quality"] for r in output if r["decision_quality"]["score"] is not None]
    weight = sum(r["available_weight"] for r in scored)
    decision = {"status": "heuristic" if scored else "unavailable", "reason": None if scored else "insufficient_applicable_round_evidence",
                "score": round(sum(c["weight"] * c["value"] for r in scored for c in r["components"]) / weight, 1) if weight else None,
                "scored_rounds": len(scored), "available_weight": weight, "possible_weight": 100 * len(rounds),
                "scope": "limited_evidence_heuristic", "professional_rating": False,
                "definition": output[0]["decision_quality"]["definition"] if output else None}
    return {"version": VERSION, "crosshair": crosshair, "counter_strafe": counter,
            "utility_effects": utility, "visibility": visibility, "preaim": preaim, "reaction": reaction,
            "decision_quality": decision,
            "coverage": {"dense_self_samples": len(samples), "sampling": sampling,
                         "dense_motion_samples": sum(_speed(s) is not None for s in samples),
                         "dense_motion_unavailable_reasons": dict(Counter(s["velocity_reason"] for s in samples if s["velocity_reason"])),
                         "crosshair_window_pct": _pct(len(paths), len(bursts)),
                         "first_burst_speed_pct": _pct(len(speeds), len(bursts)),
                         "decision_scored_round_pct": _pct(len(scored), len(rounds)),
                         "visibility_provider_verified": enabled}}
