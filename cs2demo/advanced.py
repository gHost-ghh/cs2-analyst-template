"""Auditable round tactics and aim/spatial observations, without inferred visibility.

The data is deliberately descriptive. A GOTV trajectory does not establish that
an opponent was visible, that a smoke worked, or that a shot should have hit.
"""

from __future__ import annotations

from collections import Counter, defaultdict
import math
from statistics import median

from .metrics import _enemy, _live, _team, number, steam_id

ANALYSIS_VERSION = "2.6"
MOVING_SPEED_THRESHOLD = 10.0
SEPARATION_THRESHOLD = 1200.0
BURST_GAP_SECONDS = 0.3
ENGAGEMENT_GAP_SECONDS = 3.0
HOTSPOT_CELL_UNITS = 256
UTILITY_WEAPONS = {"hegrenade", "inferno", "molotov", "incgrenade"}
GRENADE_EVENTS = {
    "flashbang_detonate": "flashbang", "smokegrenade_detonate": "smokegrenade",
    "hegrenade_detonate": "hegrenade", "inferno_startburn": "fire",
}
HITGROUPS = {0: "generic", 1: "head", 2: "chest", 3: "stomach", 4: "left_arm",
             5: "right_arm", 6: "left_leg", 7: "right_leg", 8: "neck", 10: "gear"}
FIREARMS = {
    "ak47", "aug", "awp", "bizon", "cz75a", "deagle", "elite", "famas",
    "fiveseven", "g3sg1", "galilar", "glock", "hkp2000", "m249", "m4a1",
    "m4a1_silencer", "mac10", "mag7", "mp5sd", "mp7", "mp9", "negev",
    "nova", "p250", "p90", "revolver", "sawedoff", "scar20", "sg556",
    "ssg08", "tec9", "ump45", "usp_silencer", "xm1014",
}


def _weapon(value):
    return str(value or "unknown").removeprefix("weapon_")


def _hitgroup(value):
    if isinstance(value, str) and value in HITGROUPS.values():
        return value
    return HITGROUPS.get(number(value))


def _ratio(numerator, denominator):
    return round(100 * numerator / denominator, 2) if denominator else None


def _median(values):
    return round(median(values), 2) if values else None


def _sum_known(values):
    known = [v for v in values if v is not None]
    return round(sum(known), 2) if known else None


def _coords(row, prefix=""):
    result = [number(row.get(prefix + axis)) for axis in ("X", "Y", "Z")]
    return result if all(v is not None for v in result) else None


def _place(row, prefix=""):
    value = row.get(prefix + "last_place_name")
    return value.strip()[:80] if isinstance(value, str) and value.strip() else None


def _effective_hurts(rows):
    remaining = defaultdict(lambda: 100)
    result = []
    for row in sorted(rows, key=lambda e: e["tick"]):
        victim = steam_id(row.get("user_steamid"))
        raw, after = number(row.get("dmg_health")), number(row.get("health"))
        if not victim or raw is None or raw < 0:
            continue
        damage = int(min(raw, max(0, remaining[victim])))
        remaining[victim] = max(0, int(after)) if after is not None else max(0, remaining[victim] - damage)
        result.append((row, damage))
    return result


def _economy(state, roster, side):
    def observed(name):
        value = number(state.get(name))
        return round(value, 2) if value is not None and value >= 0 else None

    totals = {}
    for label, team in (("team", side), ("opponent", 5 - side)):
        values = [number(s.get("current_equip_value")) for s in roster
                  if _team(s.get("team_num")) == team and s.get("is_alive") is True]
        totals[label + "_equipment_value"] = int(sum(values)) if len(values) == 5 and all(v is not None and v >= 0 for v in values) else None
    return {"equipment_value": observed("current_equip_value"), "balance": observed("balance"),
            "armor": observed("armor_value"), "helmet": state.get("has_helmet") if isinstance(state.get("has_helmet"), bool) else None,
            **totals, "snapshot_tick": int(state["tick"])}


def _tactics(round_, deaths, roster, steamid, tickrate, trade_window_seconds):
    side = 2 if round_["side"] == "T" else 3
    enemies = [e for e in deaths if _enemy(e)]
    trade_kills = []
    for kill in enemies:
        if steam_id(kill.get("attacker_steamid")) != steamid:
            continue
        victim = steam_id(kill.get("user_steamid"))
        candidates = [death for death in enemies
                      if steam_id(death.get("attacker_steamid")) == victim
                      and _team(death.get("user_team_num")) == side
                      and steam_id(death.get("user_steamid")) != steamid
                      and 0 <= kill["tick"] - death["tick"] <= trade_window_seconds * tickrate]
        if candidates:
            previous = max(candidates, key=lambda e: e["tick"])
            trade_kills.append({"tick": int(kill["tick"]), "seconds_after_teammate_death": round((kill["tick"] - previous["tick"]) / tickrate, 3)})
    alive = {steam_id(s.get("steamid")): _team(s.get("team_num")) for s in roster
             if s.get("is_alive") is True and steam_id(s.get("steamid")) and _team(s.get("team_num"))}
    complete_roster = sum(t == 2 for t in alive.values()) == 5 and sum(t == 3 for t in alive.values()) == 5
    clutch = None
    alive_timeline = []
    if complete_roster:
        by_tick = defaultdict(list)
        for death in deaths:
            by_tick[int(death["tick"])].append(death)
        # Apply simultaneous deaths together; their event ordering is not a real
        # interval in which the target could have faced a clutch.
        for tick, group in sorted(by_tick.items()):
            for death in group:
                alive.pop(steam_id(death.get("user_steamid")), None)
            team_count = sum(t == side for t in alive.values())
            enemy_count = sum(t != side for t in alive.values())
            alive_timeline.append({"tick": tick, "team_alive": team_count, "opponents_alive": enemy_count})
            if clutch is None and steamid in alive and team_count == 1 and enemy_count >= 1:
                clutch = {"tick": tick, "opponents": enemy_count, "won": round_["won"], "survived": round_["survived"]}
    enemy_death = any(_enemy(e) and steam_id(e.get("user_steamid")) == steamid for e in deaths)
    return {"trade_kills": len(trade_kills), "trade_kill_events": trade_kills,
            "death_traded": bool(enemy_death and round_["traded"]),
            "untraded_death": bool(enemy_death and not round_["traded"])}, clutch, complete_roster, alive_timeline


def _utility(events, hurts, steamid, available):
    damage = sum(effective for e, effective in hurts if _enemy(e)
                 and steam_id(e.get("attacker_steamid")) == steamid and _weapon(e.get("weapon")) in UTILITY_WEAPONS)
    blind_events = [e for e in events.get("player_blind", []) if steam_id(e.get("attacker_steamid")) == steamid]
    enemy = [e for e in blind_events if _enemy(e)]
    team = [e for e in blind_events if steam_id(e.get("user_steamid")) != steamid
            and _team(e.get("attacker_team_num")) == _team(e.get("user_team_num"))
            and _team(e.get("attacker_team_num")) is not None]
    own = [e for e in blind_events if steam_id(e.get("user_steamid")) == steamid]
    def duration(rows):
        return _sum_known([value if (value := number(e.get("blind_duration"))) is not None and value >= 0 else None for e in rows]) if rows else (0.0 if "player_blind" in available else None)
    def duration_count(rows):
        return sum((value := number(e.get("blind_duration"))) is not None and value >= 0 for e in rows) if "player_blind" in available else None
    detonations = {label: sum(steam_id(e.get("user_steamid")) == steamid for e in events.get(name, []))
                   if name in available else None for name, label in GRENADE_EVENTS.items()}
    return {"damage": damage, "enemy_blind_events": len(enemy) if "player_blind" in available else None,
            "enemy_blind_seconds": duration(enemy), "team_blind_events": len(team) if "player_blind" in available else None,
            "team_blind_seconds": duration(team), "self_blind_events": len(own) if "player_blind" in available else None,
            "self_blind_seconds": duration(own), "enemy_blind_events_with_duration": duration_count(enemy),
            "team_blind_events_with_duration": duration_count(team), "self_blind_events_with_duration": duration_count(own),
            "detonations": detonations}


def _aim(shots, hurts, steamid, tickrate, available):
    own_shots = [s for s in shots if steam_id(s.get("user_steamid")) == steamid and _weapon(s.get("weapon")) in FIREARMS]
    own_shots.sort(key=lambda e: e["tick"])
    speeds, first_speeds, airborne = [], [], []
    shot_observations = []
    previous = None
    for shot in own_shots:
        vx, vy = number(shot.get("user_velocity_X")), number(shot.get("user_velocity_Y"))
        speed = math.hypot(vx, vy) if vx is not None and vy is not None else None
        first = previous is None or _weapon(previous.get("weapon")) != _weapon(shot.get("weapon")) or shot["tick"] - previous["tick"] > BURST_GAP_SECONDS * tickrate
        if speed is not None:
            speeds.append(speed)
            if first:
                first_speeds.append(speed)
        if isinstance(shot.get("user_is_airborne"), bool):
            airborne.append(shot["user_is_airborne"])
        shot_observations.append({"tick": int(shot["tick"]), "weapon": _weapon(shot.get("weapon")),
                                  "speed": round(speed, 2) if speed is not None else None, "burst_first": first,
                                  "airborne": shot.get("user_is_airborne") if isinstance(shot.get("user_is_airborne"), bool) else None,
                                  "pitch": number(shot.get("user_pitch")), "yaw": number(shot.get("user_yaw")),
                                  "place": _place(shot, "user_")})
        previous = shot
    firearm_hurts = [(e, d) for e, d in hurts if _enemy(e) and steam_id(e.get("attacker_steamid")) == steamid
                     and _weapon(e.get("weapon")) in FIREARMS]
    known_hitgroups = [_hitgroup(e.get("hitgroup")) for e, _ in firearm_hurts if _hitgroup(e.get("hitgroup")) is not None]
    observed = "weapon_fire" in available
    return {"firearm_shots": len(own_shots) if observed else None,
            "shots_with_speed": len(speeds) if observed else None,
            "moving_shots": sum(v > MOVING_SPEED_THRESHOLD for v in speeds) if observed else None,
            "moving_shot_pct": _ratio(sum(v > MOVING_SPEED_THRESHOLD for v in speeds), len(speeds)),
            "median_shot_speed": _median(speeds), "burst_first_shots_with_speed": len(first_speeds) if observed else None,
            "moving_burst_first_shots": sum(v > MOVING_SPEED_THRESHOLD for v in first_speeds) if observed else None,
            "moving_burst_first_shot_pct": _ratio(sum(v > MOVING_SPEED_THRESHOLD for v in first_speeds), len(first_speeds)),
            "shots_with_airborne_state": len(airborne) if observed else None,
            "airborne_shots": sum(airborne) if observed else None,
            "enemy_firearm_hurt_events": len(firearm_hurts),
            "enemy_firearm_damage": sum(d for _, d in firearm_hurts),
            "firearm_hurt_events_with_hitgroup": len(known_hitgroups),
            "head_hurt_events": sum(group == "head" for group in known_hitgroups) if known_hitgroups or not firearm_hurts else None,
            "shot_observations": shot_observations}


def _positioning(round_, samples, self_samples, deaths, steamid, tickrate, sample_seconds):
    frames = defaultdict(list)
    for row in samples:
        frames[int(row["tick"])].append(row)
    own = sorted((s for s in self_samples if s.get("is_alive") is True), key=lambda s: s["tick"])
    distance, pairs = 0.0, 0
    for a, b in zip(own, own[1:]):
        ca, cb = _coords(a), _coords(b)
        if ca and cb and 0 < b["tick"] - a["tick"] <= (sample_seconds + 0.1) * tickrate:
            distance += math.dist(ca, cb)
            pairs += 1
    spacing = []
    places = Counter()
    for sample in own:
        xy = _coords(sample)
        side = _team(sample.get("team_num"))
        mates = [_coords(row) for row in frames[int(sample["tick"])]
                 if steam_id(row.get("steamid")) != steamid and _team(row.get("team_num")) == side and row.get("is_alive") is True]
        mates = [m for m in mates if m]
        if xy and mates:
            spacing.append(min(math.hypot(xy[0] - m[0], xy[1] - m[1]) for m in mates))
        if _place(sample):
            places[_place(sample)] += 1
    kill_places, death_places = Counter(), Counter()
    for death in deaths:
        if _enemy(death) and steam_id(death.get("attacker_steamid")) == steamid and _place(death, "attacker_"):
            kill_places[_place(death, "attacker_")] += 1
        if steam_id(death.get("user_steamid")) == steamid and _place(death, "user_"):
            death_places[_place(death, "user_")] += 1
    for point in round_["positions"]:
        sample = next((s for s in own if int(s["tick"]) == point["tick"]), None)
        if sample and _place(sample):
            point["place"] = _place(sample)
    return {"alive_position_samples": len(own), "distance_sample_pairs": pairs,
            "sampled_distance_units": round(distance, 2) if pairs else None,
            "teammate_distance_samples": len(spacing), "median_nearest_teammate_units": _median(spacing),
            "separated_samples": sum(d > SEPARATION_THRESHOLD for d in spacing),
            "separated_sample_pct": _ratio(sum(d > SEPARATION_THRESHOLD for d in spacing), len(spacing)),
            "place_samples": dict(places), "kills_by_place": dict(kill_places), "deaths_by_place": dict(death_places)}, spacing


def _timeline(round_, events, hurts, steamid, tickrate):
    rows = []
    def add(event, kind, **extra):
        rows.append({"tick": int(event["tick"]), "seconds": round((event["tick"] - round_["start_tick"]) / tickrate, 3), "type": kind, **extra})
    for death in events.get("player_death", []):
        if steam_id(death.get("attacker_steamid")) == steamid and _enemy(death):
            add(death, "kill", weapon=_weapon(death.get("weapon")), headshot=bool(death.get("headshot")), place=_place(death, "attacker_"))
        elif steam_id(death.get("user_steamid")) == steamid:
            add(death, "death", weapon=_weapon(death.get("weapon")), place=_place(death, "user_"))
        elif steam_id(death.get("assister_steamid")) == steamid and _enemy(death):
            add(death, "assist", flash=bool(death.get("assistedflash")))
    for event, damage in hurts:
        if steam_id(event.get("attacker_steamid")) == steamid and _enemy(event):
            add(event, "damage", damage=damage, weapon=_weapon(event.get("weapon")), hitgroup=_hitgroup(event.get("hitgroup")))
        elif steam_id(event.get("user_steamid")) == steamid:
            add(event, "damage_received", damage=damage, weapon=_weapon(event.get("weapon")))
    for name, label in GRENADE_EVENTS.items():
        for event in events.get(name, []):
            if steam_id(event.get("user_steamid")) == steamid:
                add(event, "utility_detonation", utility=label)
    for name in ("bomb_planted", "bomb_defused"):
        for event in events.get(name, []):
            actor = "self" if steam_id(event.get("user_steamid")) == steamid else "teammate" if _team(event.get("user_team_num")) == (2 if round_["side"] == "T" else 3) else "opponent"
            add(event, name, actor=actor, place=_place(event, "user_"))
    return sorted(rows, key=lambda row: (row["tick"], row["type"]))


def _engagements(round_, events, hurts, steamid, tickrate):
    """Damage/kill-bounded exchanges; missed-only and visible-but-unfired duels
    cannot be recovered. Multi-opponent clusters are never rated as 1v1 wins.
    """
    interactions = []
    for event, damage in hurts:
        if not _enemy(event) or _weapon(event.get("weapon")) not in FIREARMS:
            continue
        attacker, victim = steam_id(event.get("attacker_steamid")), steam_id(event.get("user_steamid"))
        if steamid not in (attacker, victim):
            continue
        outgoing = attacker == steamid
        xyz = _coords(event, "attacker_" if outgoing else "user_")
        interactions.append({"tick": int(event["tick"]), "opponent": victim if outgoing else attacker,
                             "type": "damage_dealt" if outgoing else "damage_received", "damage": damage,
                             "position": dict(zip(("x", "y", "z"), xyz)) if xyz else None})
    for event in events.get("player_death", []):
        if not _enemy(event):
            continue
        attacker, victim = steam_id(event.get("attacker_steamid")), steam_id(event.get("user_steamid"))
        if steamid not in (attacker, victim):
            continue
        outgoing = attacker == steamid
        xyz = _coords(event, "attacker_" if outgoing else "user_")
        interactions.append({"tick": int(event["tick"]), "opponent": victim if outgoing else attacker,
                             "type": "kill" if outgoing else "death", "firearm": _weapon(event.get("weapon")) in FIREARMS,
                             "position": dict(zip(("x", "y", "z"), xyz)) if xyz else None})
    interactions.sort(key=lambda e: (e["tick"], e["type"] in ("kill", "death")))
    clusters = []
    for interaction in interactions:
        if not clusters or interaction["tick"] - clusters[-1][-1]["tick"] > ENGAGEMENT_GAP_SECONDS * tickrate or clusters[-1][-1]["type"] == "death":
            clusters.append([])
        clusters[-1].append(interaction)
    episodes = []
    for cluster in clusters:
        # A utility-only terminal event is useful in the round timeline but does
        # not establish a firearm engagement.
        if not any(e["type"].startswith("damage_") or e.get("firearm") for e in cluster):
            continue
        opponents = {e["opponent"] for e in cluster}
        terminal = [e for e in cluster if e["type"] in ("kill", "death") and e.get("firearm")]
        mutually_terminal = {e["type"] for e in terminal} == {"kill", "death"}
        result = "mixed" if len(opponents) != 1 else "unresolved" if mutually_terminal else "win" if terminal and terminal[-1]["type"] == "kill" else "loss" if terminal else "unresolved"
        positions = [{"tick": e["tick"], **e["position"], "type": e["type"]} for e in cluster if e["position"]]
        episodes.append({"start_tick": cluster[0]["tick"], "end_tick": cluster[-1]["tick"],
                         "seconds": round((cluster[0]["tick"] - round_["start_tick"]) / tickrate, 3),
                         "duration_seconds": round((cluster[-1]["tick"] - cluster[0]["tick"]) / tickrate, 3),
                         "opponents": len(opponents), "result": result,
                         "damage_dealt": sum(e.get("damage", 0) for e in cluster if e["type"] == "damage_dealt"),
                         "damage_received": sum(e.get("damage", 0) for e in cluster if e["type"] == "damage_received"),
                         "positions": positions})
    return episodes


def _hotspots(rounds):
    bins = {}
    for round_ in rounds:
        visited = set()
        def cell(point):
            key = (math.floor(point["x"] / HOTSPOT_CELL_UNITS), math.floor(point["y"] / HOTSPOT_CELL_UNITS))
            if key not in bins:
                bins[key] = {"x": key[0] * HOTSPOT_CELL_UNITS, "y": key[1] * HOTSPOT_CELL_UNITS,
                             "size": HOTSPOT_CELL_UNITS, "position_samples": 0, "round_visits": 0, "deaths": 0}
            visited.add(key)
            return bins[key]
        for point in round_["positions"]:
            cell(point)["position_samples"] += 1
        for point in round_["analysis"]["positioning"]["death_positions"]:
            cell(point)["deaths"] += 1
        for key in visited:
            bins[key]["round_visits"] += 1
    result = []
    for item in bins.values():
        item["deaths_per_100_observed_round_visits"] = _ratio(item["deaths"], item["round_visits"])
        item["sample_status"] = "observed" if item["round_visits"] >= 10 else "insufficient_sample"
        result.append(item)
    return sorted(result, key=lambda r: (-r["deaths"], -r["round_visits"], r["x"], r["y"]))


def calculate_advanced(events, samples, rounds, steamid, *, tickrate=64.0, sample_seconds=2.0, trade_window_seconds=5.0, available_events=None):
    """Attach round evidence and return weighted game summaries.

    Optional event streams are marked unknown when absent from the entire demo;
    their absence must not be presented as zero utility or perfect mechanics.
    """
    available = set(available_events if available_events is not None else (name for name, rows in events.items() if rows))
    summaries, all_spacing = [], []
    roster_rounds = 0
    for round_ in rounds:
        start, end = round_["start_tick"], round_["end_tick"]
        in_round = {name: [e for e in rows if start <= e["tick"] <= end and _live(e)] for name, rows in events.items()}
        selected = [s for s in samples if start <= s["tick"] <= end]
        own = [s for s in selected if steam_id(s.get("steamid")) == steamid]
        roster = [s for s in selected if s["tick"] == start]
        state = next((s for s in own if s["tick"] == start), {})
        side = 2 if round_["side"] == "T" else 3
        hurts = _effective_hurts(in_round.get("player_hurt", []))
        deaths = in_round.get("player_death", [])
        opening_death = next((e for e in sorted(deaths, key=lambda e: e["tick"]) if _enemy(e)), None)
        opening = {"team_advantage": _team(opening_death.get("attacker_team_num")) == side,
                   "by_self": steam_id(opening_death.get("attacker_steamid")) == steamid,
                   "seconds": round((opening_death["tick"] - start) / tickrate, 3)} if opening_death else None
        trading, clutch, complete_roster, alive_timeline = _tactics(round_, deaths, roster, steamid, tickrate, trade_window_seconds)
        roster_rounds += complete_roster
        positions, spacing = _positioning(round_, selected, own, deaths, steamid, tickrate, sample_seconds)
        positions["death_positions"] = [{"tick": int(e["tick"]), **dict(zip(("x", "y", "z"), _coords(e, "user_"))),
                                          "place": _place(e, "user_")}
                                         for e in deaths if steam_id(e.get("user_steamid")) == steamid and _coords(e, "user_")]
        engagements = _engagements(round_, in_round, hurts, steamid, tickrate)
        positions["engagement_positions"] = [point for episode in engagements for point in episode["positions"]]
        all_spacing.extend(spacing)
        timeline = _timeline(round_, in_round, hurts, steamid, tickrate)
        def first(kind):
            return next((e["seconds"] for e in timeline if e["type"] == kind), None)
        aim = _aim(in_round.get("weapon_fire", []), hurts, steamid, tickrate, available)
        utility = _utility(in_round, hurts, steamid, available)
        utility["flash_assists"] = sum(steam_id(e.get("assister_steamid")) == steamid and bool(e.get("assistedflash")) and _enemy(e) for e in deaths)
        analysis = {"economy": _economy(state, roster, side), "utility": utility,
                    "trading": trading, "clutch": clutch, "clutch_roster_verified": complete_roster,
                    "timing": {"duration_seconds": round((end - start) / tickrate, 3),
                               "first_damage_seconds": first("damage"), "first_kill_seconds": first("kill"),
                               "death_seconds": first("death")},
                    "aim": aim, "positioning": positions, "engagements": engagements, "opening": opening,
                    "timeline": timeline, "alive_timeline": alive_timeline}
        round_["analysis"] = analysis
        summaries.append(analysis)
    count = len(rounds)
    def total(section, key):
        return _sum_known([r[section].get(key) for r in summaries])
    utility = {key: total("utility", key) for key in ("damage", "enemy_blind_events", "enemy_blind_seconds", "team_blind_events", "team_blind_seconds", "self_blind_events", "self_blind_seconds", "flash_assists", "enemy_blind_events_with_duration", "team_blind_events_with_duration", "self_blind_events_with_duration")}
    for group in ("enemy", "team", "self"):
        if utility[group + "_blind_events"] and utility[group + "_blind_events_with_duration"] != utility[group + "_blind_events"]:
            # A partial duration sum is not the full blind-time total.
            utility[group + "_blind_seconds"] = None
    utility["detonations"] = {label: _sum_known([r["utility"]["detonations"][label] for r in summaries]) for label in GRENADE_EVENTS.values()}
    aim = {key: total("aim", key) for key in ("firearm_shots", "shots_with_speed", "moving_shots", "burst_first_shots_with_speed", "moving_burst_first_shots", "shots_with_airborne_state", "airborne_shots", "enemy_firearm_hurt_events", "enemy_firearm_damage", "firearm_hurt_events_with_hitgroup", "head_hurt_events")}
    aim["moving_shot_pct"] = _ratio(aim["moving_shots"] or 0, aim["shots_with_speed"] or 0)
    aim["moving_burst_first_shot_pct"] = _ratio(aim["moving_burst_first_shots"] or 0, aim["burst_first_shots_with_speed"] or 0)
    if not aim["firearm_hurt_events_with_hitgroup"] and aim["enemy_firearm_hurt_events"]:
        aim["head_hurt_events"] = None
    shots = [s for r in summaries for s in r["aim"]["shot_observations"]]
    aim["median_shot_speed"] = _median([s["speed"] for s in shots if s["speed"] is not None])
    aim["moving_speed_threshold_units_per_second"] = MOVING_SPEED_THRESHOLD
    aim["burst_gap_seconds"] = BURST_GAP_SECONDS
    pos = {key: total("positioning", key) for key in ("alive_position_samples", "distance_sample_pairs", "sampled_distance_units", "teammate_distance_samples", "separated_samples")}
    pos["median_nearest_teammate_units"] = _median(all_spacing)
    pos["separated_sample_pct"] = _ratio(pos["separated_samples"] or 0, pos["teammate_distance_samples"] or 0)
    pos["separation_threshold_units"] = SEPARATION_THRESHOLD
    pos["death_positions"] = [point for r in summaries for point in r["positioning"]["death_positions"]]
    pos["engagement_positions"] = [point for r in summaries for point in r["positioning"]["engagement_positions"]]
    pos["hotspots"] = _hotspots(rounds)
    for key in ("place_samples", "kills_by_place", "deaths_by_place"):
        merged = Counter()
        for row in summaries:
            merged.update(row["positioning"][key])
        pos[key] = dict(merged)
    economy = {"observed_rounds": sum(r["economy"]["equipment_value"] is not None for r in summaries)}
    for key in ("equipment_value", "balance", "armor", "team_equipment_value", "opponent_equipment_value"):
        values = [r["economy"][key] for r in summaries if r["economy"][key] is not None]
        economy["average_" + key] = round(sum(values) / len(values), 2) if values else None
    clutches = [r["clutch"] for r in summaries if r["clutch"]]
    clutch_summary = {"roster_verified_rounds": roster_rounds, "attempts": len(clutches) if roster_rounds else None,
                      "wins": sum(c["won"] is True for c in clutches) if roster_rounds else None,
                      "by_opponents": {str(n): {"attempts": sum(c["opponents"] == n for c in clutches), "wins": sum(c["opponents"] == n and c["won"] is True for c in clutches)} for n in sorted({c["opponents"] for c in clutches})}}
    timing = {"median_" + key: _median([r["timing"][key] for r in summaries if r["timing"][key] is not None])
              for key in ("first_damage_seconds", "first_kill_seconds", "death_seconds")}
    episodes = [e for r in summaries for e in r["engagements"]]
    wins, losses = sum(e["result"] == "win" for e in episodes), sum(e["result"] == "loss" for e in episodes)
    opening_kills = [r for r in rounds if r["opening_kill"]]
    opening_deaths = [r for r in rounds if r["opening_death"]]
    team_opening_kills = [r for r in rounds if r["analysis"]["opening"] and r["analysis"]["opening"]["team_advantage"]]
    team_opening_deaths = [r for r in rounds if r["analysis"]["opening"] and not r["analysis"]["opening"]["team_advantage"]]
    trading_summary = {key: int(total("trading", key) or 0) for key in ("trade_kills", "death_traded", "untraded_death")}
    trading_summary["death_traded_pct"] = _ratio(trading_summary["death_traded"], trading_summary["death_traded"] + trading_summary["untraded_death"])
    trading_summary["trade_success_pct"] = None
    return {"version": ANALYSIS_VERSION,
            "level2": {"economy": economy, "utility": utility,
                       "trading": trading_summary,
                       "clutches": clutch_summary, "timing": timing,
                       "engagements": {"observed_episodes": len(episodes), "single_opponent_wins": wins,
                                       "single_opponent_losses": losses, "single_opponent_win_pct": _ratio(wins, wins + losses),
                                       "unresolved": sum(e["result"] == "unresolved" for e in episodes),
                                       "mixed_opponent_episodes": sum(e["result"] == "mixed" for e in episodes), "gap_seconds": ENGAGEMENT_GAP_SECONDS},
                       "opening_conversion": {"opening_kill_rounds": len(opening_kills), "wins_after_opening_kill": sum(r["won"] is True for r in opening_kills),
                                              "win_pct_after_opening_kill": _ratio(sum(r["won"] is True for r in opening_kills), len(opening_kills)),
                                              "opening_death_rounds": len(opening_deaths), "wins_after_opening_death": sum(r["won"] is True for r in opening_deaths),
                                              "win_pct_after_opening_death": _ratio(sum(r["won"] is True for r in opening_deaths), len(opening_deaths)),
                                              "team_opening_kill_rounds": len(team_opening_kills), "wins_after_team_opening_kill": sum(r["won"] is True for r in team_opening_kills),
                                              "win_pct_after_team_opening_kill": _ratio(sum(r["won"] is True for r in team_opening_kills), len(team_opening_kills)),
                                              "team_opening_death_rounds": len(team_opening_deaths), "wins_after_team_opening_death": sum(r["won"] is True for r in team_opening_deaths),
                                              "win_pct_after_team_opening_death": _ratio(sum(r["won"] is True for r in team_opening_deaths), len(team_opening_deaths))}},
            "level3": {"aim": aim, "positioning": pos},
            "coverage": {"rounds": count, "complete_start_roster_rounds": roster_rounds,
                         "event_streams": {name: "observed" if name in available else "not_observed" for name in ("weapon_fire", "player_blind", *GRENADE_EVENTS)},
                         "shot_speed_pct": _ratio(aim["shots_with_speed"] or 0, aim["firearm_shots"] or 0),
                         "equipment_round_pct": _ratio(economy["observed_rounds"], count)},
            "definitions": {
                "economy": "Equipment, cash and armor at the observed freeze-end tick; team totals require five valid living players per side. No inferred buy classification.",
                "utility": "Enemy effective HP damage from HE/fire; blind durations are reported event durations summed per victim, may overlap, and do not measure fully blind time. Detonations count observed live events, not grenades purchased/thrown.",
                "trading": "Target kill of an enemy who killed a teammate within 5 seconds; traded-death percentage uses enemy-caused deaths. Trade success percentage is null because missed attempts, opportunity, line of sight and tradeability are not inferred.",
                "engagements": "Observed enemy firearm damage/kill clusters separated by >3 seconds or target death. A single-opponent cluster with a firearm kill/death is a resolved exchange; multi-opponent, utility-only and unresolved exchanges are excluded from win percentage. Missed-only encounters and unobserved enemies are absent; this is not a universal duel rating.",
                "hotspots": "256-unit raw-coordinate cells. Deaths per 100 observed round visits includes sampled visits and exact death cells; fewer than 10 visits is insufficient_sample. Sampling can miss short visits; this is descriptive exposure, not a causal high-risk tactical grade.",
                "clutches": "First observed 1vN state reconstructed from a verified five-versus-five freeze-end roster and simultaneous death groups; success means the target team won the round.",
                "aim": "Firearm shot events and event-associated server-demo movement estimates from lagged position history. Moving means speed >10 game units/s; burst-first follows a >0.3s gap or weapon change. These are observations, not accuracy/counter-strafe scores. Hurt events are not bullets hit (pellets/penetration).",
                "positioning": "Two-second living samples; sampled path distance is a lower bound. Teammate spacing is horizontal straight-line distance, ignores walls/routes/visibility, and separation >1200 units is descriptive. Place labels come from the Demo and may be missing.",
                "unsupported": "No visibility/occlusion, reaction time, crosshair placement error, spray control, expected kill probability, professional rating or causal tactical grade is claimed.",
            }}
