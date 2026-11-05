"""Observed projectile paths, utility outcomes and C4 observations for radar replay.

Effect glyphs can use an illustrative radius; this adapter never supplies an
invented smoke volume, fire polygon, line of sight, or nominal C4 countdown.
"""
from __future__ import annotations

from collections import defaultdict
import math

from .metrics import _live, _team, number, steam_id

VERSION = "1.0"
PATH_HZ = 16.0
MAX_GRENADES = 1024
MAX_PATH_POINTS = 24000
MAX_POINTS_PER_PATH = 512
MAX_EFFECTS = 2048
MAX_IMPACTS_PER_EFFECT = 256
MAX_BOMB_EVENTS = 256
PROJECTILES = {"CSmokeGrenadeProjectile": "smoke", "CFlashbangProjectile": "flash",
               "CHEGrenadeProjectile": "he", "CMolotovProjectile": "fire",
               "CIncendiaryGrenadeProjectile": "fire", "CDecoyProjectile": "decoy"}
EFFECT_EVENTS = {"smokegrenade_detonate": "smoke", "flashbang_detonate": "flash",
                 "hegrenade_detonate": "he", "inferno_startburn": "fire",
                 "decoy_started": "decoy"}
END_EVENTS = {"smoke": "smokegrenade_expired", "fire": "inferno_expire", "decoy": "decoy_expired"}
BOMB_EVENTS = {"bomb_beginplant": "beginplant", "bomb_abortplant": "abortplant",
               "bomb_planted": "planted", "bomb_begindefuse": "begindefuse",
               "bomb_abortdefuse": "abortdefuse", "bomb_dropped": "dropped",
               "bomb_pickup": "pickup", "bomb_defused": "defused", "bomb_exploded": "exploded"}
EXACT_EVENTS = tuple(EFFECT_EVENTS) + tuple(END_EVENTS.values()) + tuple(BOMB_EVENTS)


def _tick(value):
    value = number(value)
    return int(value) if value is not None and value >= 0 and value == int(value) else None


def _entity(event):
    return _tick(event.get("entityid", event.get("grenade_entity_id")))


def _xyz(event, prefix="", *, lower=False):
    point = [number(event.get(prefix + name)) for name in (("x", "y", "z") if lower else ("X", "Y", "Z"))]
    return [round(value, 1) for value in point] if all(value is not None for value in point) else None


def _relation(row):
    attacker, victim = steam_id(row.get("attacker_steamid")), steam_id(row.get("user_steamid"))
    if attacker and attacker == victim:
        return "self"
    team, victim_team = _team(row.get("attacker_team_num")), _team(row.get("user_team_num"))
    return "unknown" if team is None or victim_team is None else "team" if team == victim_team else "enemy"


def _kind(weapon):
    return {"hegrenade": "he", "inferno": "fire", "molotov": "fire", "incgrenade": "fire"}.get(str(weapon or "").removeprefix("weapon_"))


def tactical_ticks(rounds, events):
    """Bound exact utility/C4 ticks within supplied playback windows; exclude warmup."""
    ticks = sorted({_tick(row.get("tick")) for name in EXACT_EVENTS for row in events.get(name, [])
                    if _live(row) and _tick(row.get("tick")) is not None
                    and any(r["start_tick"] <= row["tick"] <= r["end_tick"] for r in rounds)})
    return ticks[:4096], len(ticks) > 4096


def _effects(events, round_, indexes, tickrate):
    start, end = round_["start_tick"], round_["end_tick"]
    output = []
    for event_name, kind in EFFECT_EVENTS.items():
        for event in events.get(event_name, []):
            tick, entity, sid = _tick(event.get("tick")), _entity(event), steam_id(event.get("user_steamid"))
            if tick is None or not start <= tick <= end or not _live(event):
                continue
            point = _xyz(event, lower=True)
            if point is None:
                continue
            # Entity indexes are reused. The next same-kind detonation fences the
            # association even when an expiry record is missing.
            next_start = min((other["tick"] for other in events.get(event_name, [])
                              if _entity(other) == entity and _tick(other.get("tick")) is not None
                              and other["tick"] > tick), default=math.inf)
            ends = [row for row in events.get(END_EVENTS.get(kind, ""), [])
                    if entity is not None and _entity(row) == entity and _live(row)
                    and _tick(row.get("tick")) is not None and tick < row["tick"] < next_start
                    and (not sid or not steam_id(row.get("user_steamid")) or steam_id(row.get("user_steamid")) == sid)]
            expiry = min((int(row["tick"]) for row in ends), default=None)
            # A persistent effect must have an observed expiry. Unknown expiry
            # remains null, including fire; clients show only a short onset pulse.
            output.append({"id": f"r{round_['round_number']}:e{entity}:t{tick}:{kind}", "kind": kind,
                           "entity_id": entity, "tick": tick, "end_tick": expiry, "position": point,
                           "thrower_index": indexes.get(sid), "team": _team(event.get("user_team_num")),
                           "flight_id": None, "impacts": [], "kills": [],
                           "summary": {}, "_sid": sid, "_association_end": min(expiry if expiry is not None else tick, next_start - 1)})
    output.sort(key=lambda row: (row["tick"], row["id"]))
    return output[:MAX_EFFECTS], len(output) > MAX_EFFECTS


def _impacts(events, effects, round_, indexes, tickrate):
    start, end = round_["start_tick"], round_["end_tick"]
    unassociated = {"damage": 0, "blind": 0}
    remaining = defaultdict(lambda: 100)
    deaths = [row for row in events.get("player_death", []) if _live(row) and _tick(row.get("tick")) is not None
              and start <= row["tick"] <= end]
    damage_rows = sorted((row for row in events.get("player_hurt", []) if _live(row) and _tick(row.get("tick")) is not None
                          and start <= row["tick"] <= end), key=lambda row: row["tick"])
    for row in damage_rows:
        sid, victim = steam_id(row.get("attacker_steamid")), steam_id(row.get("user_steamid"))
        raw, after = number(row.get("dmg_health")), number(row.get("health"))
        if victim is None or raw is None or raw < 0:
            continue
        damage = int(min(raw, max(0, remaining[victim])))
        remaining[victim] = max(0, int(after)) if after is not None else max(0, remaining[victim] - damage)
        kind = _kind(row.get("weapon"))
        if not kind:
            continue
        candidates = [effect for effect in effects if sid and effect["_sid"] == sid and effect["kind"] == kind
                      and (effect["tick"] <= row["tick"] <= effect["_association_end"] if kind == "fire"
                           else 0 <= row["tick"] - effect["tick"] <= max(1, round(tickrate * .125)))]
        # Hurt has no projectile id. A unique matching thrower+weapon+time is
        # required, rather than nearest grenade position or nearest timestamp.
        if len(candidates) != 1:
            unassociated["damage"] += 1
            continue
        effect = candidates[0]
        if len(effect["impacts"]) >= MAX_IMPACTS_PER_EFFECT:
            unassociated["damage"] += 1
            continue
        lethal = any(death["tick"] == row["tick"] and steam_id(death.get("attacker_steamid")) == sid
                     and steam_id(death.get("user_steamid")) == victim and _kind(death.get("weapon")) == kind for death in deaths)
        effect["impacts"].append({"tick": int(row["tick"]), "victim_index": indexes.get(victim),
                                  "position": _xyz(row, "user_"), "relation": _relation(row),
                                  "damage": damage, "blind_seconds": None, "lethal": lethal,
                                  "association": "unique_thrower_weapon_time"})
        if lethal:
            effect["kills"].append({"tick": int(row["tick"]), "attacker_index": indexes.get(sid),
                                    "victim_index": indexes.get(victim), "kind": "utility_damage"})
    for row in events.get("player_blind", []):
        tick, sid, victim = _tick(row.get("tick")), steam_id(row.get("attacker_steamid")), steam_id(row.get("user_steamid"))
        duration, entity = number(row.get("blind_duration")), _entity(row)
        if tick is None or not start <= tick <= end or not _live(row) or duration is None or not 0 < duration <= 30:
            continue
        candidates = [effect for effect in effects if effect["kind"] == "flash" and entity is not None
                      and effect["entity_id"] == entity and sid and effect["_sid"] == sid and effect["tick"] == tick]
        if len(candidates) != 1 or len(candidates[0]["impacts"]) >= MAX_IMPACTS_PER_EFFECT:
            unassociated["blind"] += 1
            continue
        effect = candidates[0]
        blind_end = tick + round(duration * tickrate)
        effect["impacts"].append({"tick": tick, "end_tick": blind_end, "victim_index": indexes.get(victim),
                                  "position": _xyz(row, "user_"), "relation": _relation(row), "damage": None,
                                  "blind_seconds": round(duration, 4), "lethal": False,
                                  "association": "same_entity_thrower_tick"})
        # Describes temporal overlap only, never a causal flash kill claim.
        for death in deaths:
            if victim and steam_id(death.get("user_steamid")) == victim and tick <= death["tick"] <= blind_end:
                effect["kills"].append({"tick": int(death["tick"]),
                                        "attacker_index": indexes.get(steam_id(death.get("attacker_steamid"))),
                                        "victim_index": indexes.get(victim), "kind": "during_observed_blind"})
    for effect in effects:
        impacts = effect["impacts"]
        effect["summary"] = {"enemy_damage": sum(row["damage"] or 0 for row in impacts if row["relation"] == "enemy"),
                             "team_damage": sum(row["damage"] or 0 for row in impacts if row["relation"] == "team"),
                             "self_damage": sum(row["damage"] or 0 for row in impacts if row["relation"] == "self"),
                             "enemy_blind_seconds": round(sum(row["blind_seconds"] or 0 for row in impacts if row["relation"] == "enemy"), 4),
                             "team_blind_seconds": round(sum(row["blind_seconds"] or 0 for row in impacts if row["relation"] == "team"), 4),
                             "enemy_victims": len({row["victim_index"] for row in impacts if row["relation"] == "enemy" and row["victim_index"] is not None}),
                             "team_victims": len({row["victim_index"] for row in impacts if row["relation"] == "team" and row["victim_index"] is not None}),
                             "utility_kills": sum(row["kind"] == "utility_damage" for row in effect["kills"]),
                             "kills_during_blind": sum(row["kind"] == "during_observed_blind" for row in effect["kills"])}
    return unassociated


def _paths(grenades, effects, round_, indexes, tickrate, point_budget, teams):
    start, end = round_["start_tick"], round_["end_tick"]
    groups = defaultdict(dict)
    for row in grenades:
        tick, entity, kind = _tick(row.get("tick")), _entity(row), PROJECTILES.get(row.get("grenade_type"))
        point, sid = _xyz(row, lower=True), steam_id(row.get("steamid"))
        if tick is not None and start <= tick <= end and entity is not None and kind and point is not None:
            groups[(entity, kind, sid)][tick] = point
    paths = []
    truncated = False
    stride = max(1, round(tickrate / PATH_HZ))
    for (entity, kind, sid), positions in sorted(groups.items(), key=lambda item: min(item[1])):
        # A reused entity id separated by missing observations is a new path.
        segments = []
        for tick in sorted(positions):
            if not segments or tick - segments[-1][-1] > max(2, round(tickrate * .5)):
                segments.append([])
            segments[-1].append(tick)
        for segment in segments:
            first, last = segment[0], segment[-1]
            candidates = [effect for effect in effects if effect["entity_id"] == entity and effect["kind"] == kind
                          and sid and effect["_sid"] == sid and first <= effect["tick"] <= last + 1]
            effect = candidates[0] if len(candidates) == 1 else None
            if effect:
                last = min(last, effect["tick"])
                segment = [tick for tick in segment if tick <= last]
            if not segment:
                continue
            ticks = [tick for tick in segment if tick == first or tick == last or (tick - first) % stride == 0]
            # Preserve every observed bounce-direction change is unnecessary for
            # bounded display; actual 16Hz points form an observed sampled path.
            if len(ticks) > MAX_POINTS_PER_PATH:
                ticks = [ticks[math.floor(i * (len(ticks) - 1) / (MAX_POINTS_PER_PATH - 1))] for i in range(MAX_POINTS_PER_PATH)]
                truncated = True
            if len(paths) >= MAX_GRENADES or len(ticks) > point_budget:
                truncated = True
                continue
            point_budget -= len(ticks)
            identifier = f"r{round_['round_number']}:g{entity}:t{first}"
            paths.append({"id": identifier, "kind": kind, "entity_id": entity,
                          "thrower_index": indexes.get(sid), "team": effect["team"] if effect else teams.get(sid),
                          "start_tick": first, "end_tick": last, "points": [[tick, *positions[tick]] for tick in ticks],
                          "effect_id": effect["id"] if effect else None})
            if effect:
                effect["flight_id"] = identifier
    return paths, point_budget, truncated


def _bomb(events, samples, round_, indexes, tickrate=64.0):
    start, end = round_["start_tick"], round_["end_tick"]
    output = []
    for name, kind in BOMB_EVENTS.items():
        for event in events.get(name, []):
            tick = _tick(event.get("tick"))
            if tick is None or not start <= tick <= end or not _live(event):
                continue
            site = number(event.get("site"))
            output.append({"tick": tick, "kind": kind, "player_index": indexes.get(steam_id(event.get("user_steamid"))),
                           "position": _xyz(event, "user_"), "position_reference": "player_origin",
                           "site": int(site) if site is not None else None,
                           "haskit": event.get("haskit") if isinstance(event.get("haskit"), bool) else None})
    output.sort(key=lambda row: (row["tick"], row["kind"]))
    truncated = len(output) > MAX_BOMB_EVENTS
    output = output[:MAX_BOMB_EVENTS]
    by_tick = defaultdict(list)
    for row in samples:
        tick = _tick(row.get("tick"))
        if tick is not None and start <= tick <= end and isinstance(row.get("inventory"), (list, tuple)):
            by_tick[tick].append(row)
    carriers = []
    conflicts = 0
    carrier_interval = max(1, round(tickrate / 8))
    event_ticks = {row["tick"] for row in output}
    for tick, rows in sorted(by_tick.items()):
        found = [row for row in rows if row.get("is_alive") is True and "C4 Explosive" in row["inventory"]
                 and steam_id(row.get("steamid")) in indexes and _xyz(row)]
        if len(found) == 1:
            row = found[0]
            carrier = indexes[steam_id(row.get("steamid"))]
            position = _xyz(row)
            if (not carriers or carriers[-1][1] != carrier or tick in event_ticks
                    or tick - carriers[-1][0] >= carrier_interval and carriers[-1][2:] != position):
                carriers.append([tick, carrier, *position])
        else:
            # Consecutive absence samples carry no changing coordinate data.
            # Emit the first observed absence to terminate a preceding carrier.
            if not carriers or carriers[-1][1] is not None:
                carriers.append([tick, None, None, None, None])
            conflicts += len(found) > 1
    plants = []
    for index, row in enumerate(output):
        if row["kind"] != "planted":
            continue
        terminal = next((other for other in output[index + 1:] if other["kind"] in ("defused", "exploded", "planted")), None)
        if terminal and terminal["kind"] == "planted":
            terminal = None
        plants.append({"tick": row["tick"], "position": row["position"], "site": row["site"],
                       "terminal_tick": terminal["tick"] if terminal else None,
                       "terminal_kind": terminal["kind"] if terminal else None})
    return {"events": output, "plants": plants, "carrier_frames": carriers,
            "carrier_position_observed": bool(by_tick), "carrier_source": "observed_inventory_c4",
            "carrier_sample_hz": 8.0,
            "carrier_conflicts": conflicts, "truncated": truncated}


def build_tactical(events, grenades, samples, rounds, indexes, *, tickrate=64.0, grenade_status="observed"):
    """Return round-number keyed utility and bomb telemetry plus compact coverage."""
    output = {}
    budget = MAX_PATH_POINTS
    totals = {"grenades": 0, "path_points": 0, "effects": 0, "impacts": 0, "bomb_events": 0,
              "carrier_frames": 0, "unassociated_damage_events": 0, "unassociated_blind_events": 0}
    any_truncated = False
    for round_ in rounds:
        effects, effects_truncated = _effects(events, round_, indexes, tickrate)
        unassociated = _impacts(events, effects, round_, indexes, tickrate)
        observed_teams = defaultdict(set)
        for row in samples:
            sid, team, tick = steam_id(row.get("steamid")), _team(row.get("team_num")), _tick(row.get("tick"))
            if sid and team and tick is not None and round_["start_tick"] <= tick <= round_["end_tick"]:
                observed_teams[sid].add(team)
        teams = {sid: next(iter(values)) for sid, values in observed_teams.items() if len(values) == 1}
        paths, budget, paths_truncated = _paths(grenades, effects, round_, indexes, tickrate, budget, teams)
        bomb = _bomb(events, samples, round_, indexes, tickrate)
        for effect in effects:
            effect.pop("_sid", None)
            effect.pop("_association_end", None)
        truncated = effects_truncated or paths_truncated or bomb["truncated"]
        output[round_["round_number"]] = {"version": VERSION, "grenades": paths, "effects": effects,
                                          "bomb": bomb, "coverage": {"grenade_status": grenade_status,
                                          "path_sample_hz": PATH_HZ, "truncated": truncated,
                                          "unassociated_damage_events": unassociated["damage"],
                                          "unassociated_blind_events": unassociated["blind"]}}
        totals["grenades"] += len(paths)
        totals["path_points"] += sum(len(row["points"]) for row in paths)
        totals["effects"] += len(effects)
        totals["impacts"] += sum(len(row["impacts"]) for row in effects)
        totals["bomb_events"] += len(bomb["events"])
        totals["carrier_frames"] += len(bomb["carrier_frames"])
        totals["unassociated_damage_events"] += unassociated["damage"]
        totals["unassociated_blind_events"] += unassociated["blind"]
        any_truncated |= truncated
    return output, {"version": VERSION, "grenade_status": grenade_status, **totals, "truncated": any_truncated,
                    "max_path_points": MAX_PATH_POINTS, "path_sample_hz": PATH_HZ,
                    "effect_footprint": "event_center_only", "effect_expiry": "observed_same_entity_event_only",
                    "c4_position": "observed_carrier_origin_or_event_player_origin",
                    "c4_timer": "observed_plant_and_terminal_events_only"}
