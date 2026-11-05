"""Observed all-player statistics and Steam-ID based shared-match cohorts.

Player names are display labels. Only exact SteamID strings establish identity;
comparisons use the same completed participating rounds on both sides.
"""
from __future__ import annotations

import base64
from collections import defaultdict
import gzip
import io
import json
import math

from .advanced import FIREARMS, _weapon
from .metrics import SIDES, _enemy, _live, _team, number, steam_id

VERSION = "1.0"
MAX_PLAYERS = 32
COUNT_FIELDS = ("kills", "deaths", "assists", "damage", "headshot_kills", "trade_kills",
                "shots", "firearm_damage_events", "damage_received", "friendly_damage",
                "utility_damage", "flash_enemy_seconds", "flash_team_seconds", "flash_self_seconds")
BOOL_FIELDS = ("opening_kill", "opening_death", "traded", "survived", "kast")
UTILITY_WEAPONS = {"hegrenade", "inferno", "molotov", "incgrenade"}


def _known(value):
    return isinstance(value, (int, float)) and not isinstance(value, bool) and math.isfinite(value) and value >= 0


def _sid(value):
    result = steam_id(value)
    return result if result and len(result) == 17 and result.startswith("7656119") else None


def _sum(rows, key):
    values = [row[key] for row in rows if _known(row.get(key))]
    return round(sum(values), 3) if values else None


def aggregate_player(rounds):
    """Aggregate evidence counts, then recompute ratios using known denominators."""
    total = {key: _sum(rounds, key) for key in COUNT_FIELDS}
    total["rounds"] = len(rounds)
    total["wins"] = sum(row.get("won") is True for row in rounds)
    total["wins_observed_rounds"] = sum(isinstance(row.get("won"), bool) for row in rounds)
    for source, target in (("opening_kill", "opening_kills"), ("opening_death", "opening_deaths"),
                           ("traded", "traded_rounds"), ("survived", "survived_rounds"), ("kast", "kast_rounds")):
        values = [row[source] for row in rounds if isinstance(row.get(source), bool)]
        total[target] = sum(values) if values else None
    damage_rounds = sum(_known(row.get("damage")) for row in rounds)
    kast_rounds = sum(isinstance(row.get("kast"), bool) for row in rounds)
    total["adr_rounds"] = damage_rounds
    total["kast_observed_rounds"] = kast_rounds
    total["shot_observed_rounds"] = sum(_known(row.get("shots")) for row in rounds)
    total["utility_observed_rounds"] = sum(_known(row.get("utility_damage")) for row in rounds)
    total["adr"] = round(total["damage"] / damage_rounds, 2) if damage_rounds else None
    total["kd"] = round(total["kills"] / total["deaths"], 3) if total["deaths"] else None
    total["kast_pct"] = round(100 * total["kast_rounds"] / kast_rounds, 2) if kast_rounds else None
    total["headshot_pct"] = round(100 * total["headshot_kills"] / total["kills"], 2) if total["kills"] else None
    total["win_pct"] = round(100 * total["wins"] / total["wins_observed_rounds"], 2) if total["wins_observed_rounds"] else None
    return total


def _weapon_sum(rounds):
    result = {}
    for row in rounds:
        weapons = row.get("by_weapon")
        for name, stats in weapons.items() if isinstance(weapons, dict) else []:
            if not isinstance(stats, dict):
                continue
            entry = result.setdefault(name, {key: None for key in ("kills", "headshot_kills", "damage", "shots")})
            for key in entry:
                if _known(stats.get(key)):
                    entry[key] = (entry[key] or 0) + stats[key]
    return dict(sorted(result.items()))


def _relation(rounds, owner=False):
    if owner:
        return "self"
    teammate = any(row.get("relation") == "teammate" for row in rounds)
    opponent = any(row.get("relation") == "opponent" for row in rounds)
    return "mixed" if teammate and opponent else "teammate" if teammate else "opponent" if opponent else "unknown"


def _profile(identity, name, rounds, owner, *, source, aliases=None):
    rounds.sort(key=lambda row: row["round_number"])
    return {"steamid": identity, "name": str(name or "Unknown")[:128],
            "aliases": sorted(set(str(value)[:128] for value in (aliases or [name]) if value)),
            "is_self": identity == owner, "relation": _relation(rounds, identity == owner),
            "teammate_rounds": sum(row.get("relation") == "teammate" for row in rounds),
            "opponent_rounds": sum(row.get("relation") == "opponent" for row in rounds),
            "coverage": {"source": source, "complete_live_rounds": len(rounds),
                         "damage_rounds": sum(_known(row.get("damage")) for row in rounds),
                         "shot_rounds": sum(_known(row.get("shots")) for row in rounds),
                         "utility_rounds": sum(_known(row.get("utility_damage")) for row in rounds)},
            "summary": aggregate_player(rounds),
            "by_side": {side: aggregate_player([row for row in rounds if row.get("side") == side]) for side in ("T", "CT")},
            "by_weapon": _weapon_sum(rounds), "rounds": rounds}


def _blank_round(window, team, own_team, identity, owner, *, damage_known, shots_known, utility_known, flash_known):
    return {key: window.get(key) for key in ("round_number", "start_tick", "end_tick", "winner")} | {
        "side": SIDES[team], "won": team == window.get("winner") if window.get("winner") else None,
        "relation": "self" if identity == owner else "teammate" if own_team == team else "opponent" if own_team else "unknown",
        "kills": 0, "deaths": 0, "assists": 0, "headshot_kills": 0, "trade_kills": 0,
        "damage": 0 if damage_known else None, "damage_received": 0 if damage_known else None,
        "friendly_damage": 0 if damage_known else None, "firearm_damage_events": 0 if damage_known else None,
        "shots": 0 if shots_known else None, "utility_damage": 0 if utility_known else None,
        "flash_enemy_seconds": 0 if flash_known else None, "flash_team_seconds": 0 if flash_known else None,
        "flash_self_seconds": 0 if flash_known else None,
        "opening_kill": False, "opening_death": False, "traded": False, "survived": True, "kast": True,
        "by_weapon": {}, "events": [],
    }


def _weapon_row(row, weapon, *, damage_known, shots_known):
    return row["by_weapon"].setdefault(weapon, {"kills": 0, "headshot_kills": 0,
                                               "damage": 0 if damage_known else None,
                                               "shots": 0 if shots_known else None})


def _apply_deaths(rows, deaths, teams, tickrate, trade_window_seconds, *, damage_known, shots_known):
    enemies = [event for event in deaths if _enemy(event)]
    for event in deaths:
        victim = _sid(event.get("user_steamid"))
        if victim in rows:
            rows[victim]["deaths"] += 1
            rows[victim]["survived"] = False
    for index, event in enumerate(enemies):
        attacker, victim, assister = (_sid(event.get(prefix + "steamid")) for prefix in ("attacker_", "user_", "assister_"))
        if attacker in rows:
            row = rows[attacker]
            row["kills"] += 1
            row["headshot_kills"] += int(event.get("headshot") is True)
            row["opening_kill"] = row["opening_kill"] or index == 0
            weapon = _weapon_row(row, _weapon(event.get("weapon")), damage_known=damage_known, shots_known=shots_known)
            weapon["kills"] += 1
            weapon["headshot_kills"] += int(event.get("headshot") is True)
        if victim in rows and index == 0:
            rows[victim]["opening_death"] = True
        if assister in rows and assister != attacker and teams.get(assister) == _team(event.get("attacker_team_num")):
            rows[assister]["assists"] += 1
        for revenge in enemies[index + 1:]:
            delta = revenge["tick"] - event["tick"]
            if delta > trade_window_seconds * tickrate:
                break
            revenge_attacker, revenge_victim = (_sid(revenge.get(prefix + "steamid")) for prefix in ("attacker_", "user_"))
            if delta >= 0 and revenge_victim == attacker and _team(revenge.get("attacker_team_num")) == _team(event.get("user_team_num")):
                if victim in rows:
                    rows[victim]["traded"] = True
                if revenge_attacker in rows:
                    trade_id = (revenge["tick"], revenge_attacker, revenge_victim)
                    counted = rows[revenge_attacker].setdefault("_trade_ids", set())
                    if trade_id not in counted:
                        rows[revenge_attacker]["trade_kills"] += 1
                        counted.add(trade_id)
                break
    for row in rows.values():
        row["kast"] = bool(row["kills"] or row["assists"] or row["survived"] or row["traded"])
        row.pop("_trade_ids", None)


def build_player_stats(events, samples, rounds, player_info, steamid, *, tickrate=64.0,
                       trade_window_seconds=5.0, available_events=None):
    """Build all participating human players from existing full event streams."""
    owner = str(steamid)
    if not _sid(owner) or not number(tickrate) or tickrate <= 0 or not number(trade_window_seconds) or trade_window_seconds <= 0:
        raise ValueError("valid SteamID, positive tickrate and trade window required")
    available = set(events) if available_events is None else set(available_events)
    # Core death/hurt streams are always requested and validated by the adapter.
    damage_known, shots_known = "player_hurt" in events, "weapon_fire" in available
    flash_known = "player_blind" in available
    names, aliases = {}, defaultdict(set)
    for state in [*player_info, *samples]:
        identity = _sid(state.get("steamid"))
        name = state.get("name")
        if identity and isinstance(name, str) and name.strip():
            names.setdefault(identity, name[:128])
            aliases[identity].add(name[:128])
    starts = {int(row["start_tick"]) for row in rounds}
    initial = defaultdict(dict)
    for state in samples:
        identity = _sid(state.get("steamid"))
        if identity and state.get("tick") in starts and state.get("is_alive") is True and _team(state.get("team_num")):
            initial[int(state["tick"])][identity] = _team(state["team_num"])
    selected = {key: sorted([event for event in events.get(key, []) if _live(event) and _known(event.get("tick"))], key=lambda event: event["tick"])
                for key in ("player_death", "player_hurt", "weapon_fire", "player_blind")}
    collected = defaultdict(list)
    for window in rounds:
        start, end = window["start_tick"], window["end_tick"]
        teams = initial[start]
        rows = {identity: _blank_round(window, team, teams.get(owner), identity, owner, damage_known=damage_known,
                                     shots_known=shots_known, utility_known=damage_known, flash_known=flash_known)
                for identity, team in teams.items()}
        def add_event(identity, source, kind, **extra):
            if identity in rows:
                rows[identity]["events"].append({"tick": int(source["tick"]),
                                                "seconds": round((source["tick"] - start) / tickrate, 4),
                                                "type": kind, **extra})
        deaths = [event for event in selected["player_death"] if start <= event["tick"] <= end]
        _apply_deaths(rows, deaths, teams, tickrate, trade_window_seconds, damage_known=damage_known, shots_known=shots_known)
        for event in deaths:
            attacker, victim, assister = (_sid(event.get(prefix + "steamid")) for prefix in ("attacker_", "user_", "assister_"))
            add_event(victim, event, "death", attacker_steamid=attacker, weapon=_weapon(event.get("weapon")))
            if _enemy(event):
                add_event(attacker, event, "kill", target_steamid=victim, weapon=_weapon(event.get("weapon")), headshot=event.get("headshot") is True)
                if assister != attacker and teams.get(assister) == _team(event.get("attacker_team_num")):
                    add_event(assister, event, "assist", target_steamid=victim, flash=event.get("assistedflash") is True)
        remaining = defaultdict(lambda: 100)
        incomplete_damage = set()
        incomplete_received = set()
        for event in selected["player_hurt"]:
            if not start <= event["tick"] <= end:
                continue
            victim, attacker = _sid(event.get("user_steamid")), _sid(event.get("attacker_steamid"))
            raw, after = number(event.get("dmg_health")), number(event.get("health"))
            if not victim or raw is None or raw < 0:
                if attacker in rows:
                    incomplete_damage.add(attacker)
                continue
            damage = int(min(raw, max(0, remaining[victim])))
            remaining[victim] = max(0, int(after)) if after is not None else max(0, remaining[victim] - damage)
            if attacker and attacker != victim and (_team(event.get("attacker_team_num")) is None or _team(event.get("user_team_num")) is None):
                incomplete_damage.add(attacker)
                incomplete_received.add(victim)
            if victim in rows and _enemy(event):
                rows[victim]["damage_received"] += damage
                add_event(victim, event, "damage_received", attacker_steamid=attacker, damage=damage, weapon=_weapon(event.get("weapon")), health_after=after)
            if attacker not in rows:
                continue
            row = rows[attacker]
            if _enemy(event):
                row["damage"] += damage
                weapon = _weapon(event.get("weapon"))
                add_event(attacker, event, "damage", target_steamid=victim, damage=damage, weapon=weapon,
                          hitgroup=event.get("hitgroup") if isinstance(event.get("hitgroup"), (str, int)) else None)
                _weapon_row(row, weapon, damage_known=damage_known, shots_known=shots_known)["damage"] += damage
                if weapon in UTILITY_WEAPONS:
                    row["utility_damage"] += damage
                if weapon in FIREARMS:
                    row["firearm_damage_events"] += 1
            elif victim != attacker and _team(event.get("attacker_team_num")) and _team(event.get("attacker_team_num")) == _team(event.get("user_team_num")):
                row["friendly_damage"] += damage
                add_event(attacker, event, "friendly_damage", target_steamid=victim, damage=damage, weapon=_weapon(event.get("weapon")))
        for event in selected["weapon_fire"]:
            identity, weapon = _sid(event.get("user_steamid")), _weapon(event.get("weapon"))
            if shots_known and start <= event["tick"] <= end and identity in rows and weapon in FIREARMS:
                rows[identity]["shots"] += 1
                _weapon_row(rows[identity], weapon, damage_known=damage_known, shots_known=shots_known)["shots"] += 1
                add_event(identity, event, "shot", weapon=weapon)
        for event in selected["player_blind"]:
            identity, victim = _sid(event.get("attacker_steamid")), _sid(event.get("user_steamid"))
            duration = number(event.get("blind_duration"))
            if not flash_known or not start <= event["tick"] <= end or identity not in rows or duration is None or duration < 0:
                continue
            attacker_team, victim_team = _team(event.get("attacker_team_num")), _team(event.get("user_team_num"))
            key = "flash_self_seconds" if identity == victim else "flash_team_seconds" if attacker_team and attacker_team == victim_team else "flash_enemy_seconds" if attacker_team and victim_team else None
            if key:
                rows[identity][key] += duration
                add_event(identity, event, "flash", target_steamid=victim, duration=round(duration, 3),
                          relation="self" if identity == victim else "teammate" if attacker_team == victim_team else "opponent")
        for kind in ("bomb_planted", "bomb_defused"):
            for event in events.get(kind, []):
                if _live(event) and _known(event.get("tick")) and start <= event["tick"] <= end:
                    add_event(_sid(event.get("user_steamid")), event, kind)
        for identity, row in rows.items():
            if identity in incomplete_damage:
                for key in ("damage", "friendly_damage", "utility_damage", "firearm_damage_events"):
                    row[key] = None
                for stats in row["by_weapon"].values():
                    stats["damage"] = None
            if identity in incomplete_received:
                row["damage_received"] = None
            for key in ("flash_enemy_seconds", "flash_team_seconds", "flash_self_seconds"):
                if row[key] is not None:
                    row[key] = round(row[key], 3)
            row["events"].sort(key=lambda event: (event["tick"], event["type"]))
            collected[identity].append(row)
    return [_profile(identity, names.get(identity), group, owner, source="events", aliases=aliases.get(identity))
            for identity, group in sorted(collected.items(), key=lambda item: (item[0] != owner, item[0]))[:MAX_PLAYERS]]


def _first_frame(frame):
    if not isinstance(frame, dict) or frame.get("encoding") != "gzip-base64-json" or not isinstance(frame.get("data"), str):
        return None
    from .replay import MAX_DECODED_ROUND_BYTES
    try:
        raw = base64.b64decode(frame["data"], validate=True)
        with gzip.GzipFile(fileobj=io.BytesIO(raw)) as stream:
            decoded = stream.read(MAX_DECODED_ROUND_BYTES + 1)
        if len(decoded) > MAX_DECODED_ROUND_BYTES:
            return None
        frames = json.loads(decoded)
        return frames[0] if isinstance(frames, list) and frames else None
    except (ValueError, OSError, EOFError, TypeError):
        return None


def match_players(match, steamid=None):
    """Return current statistics or recover the explicitly retained legacy subset."""
    owner = str(steamid or match.get("player", {}).get("steamid") or "")
    existing = match.get("players")
    if isinstance(existing, list) and existing:
        return [row for row in existing if isinstance(row, dict) and _sid(row.get("steamid"))]
    replay = match.get("replay")
    replay = replay if isinstance(replay, dict) else {}
    roster = {row.get("index"): row for row in replay.get("players", [])
              if isinstance(row, dict) and _sid(row.get("steamid")) and not row.get("is_bot")}
    windows = {row["round_number"]: row for row in match.get("rounds", []) if isinstance(row, dict)}
    collected = defaultdict(list)
    fields = replay.get("player_fields", [])
    indexes = {key: fields.index(key) for key in ("player_index", "alive", "team") if key in fields}
    tickrate = number(replay.get("tickrate")) or number(match.get("provenance", {}).get("tickrate")) or 64.0
    for replay_round in replay.get("rounds", []):
        window = windows.get(replay_round.get("round_number"))
        frame = _first_frame(replay_round.get("frames"))
        if not window or not isinstance(frame, list) or len(frame) != 2 or frame[0] != window.get("start_tick") or len(indexes) != 3:
            continue
        teams = {}
        for state in frame[1] if isinstance(frame[1], list) else []:
            if not isinstance(state, list) or len(state) <= max(indexes.values()):
                continue
            info = roster.get(state[indexes["player_index"]])
            team = _team(state[indexes["team"]])
            if info and state[indexes["alive"]] in (1, True) and team:
                teams[info["steamid"]] = team
        rows = {identity: _blank_round(window, team, teams.get(owner), identity, owner, damage_known=False,
                                     shots_known=False, utility_known=False, flash_known=False) for identity, team in teams.items()}
        deaths = []
        for event in replay_round.get("kills", []):
            if not isinstance(event, dict):
                continue
            attacker, victim, assister = (roster.get(event.get(key + "_index"), {}).get("steamid") for key in ("attacker", "victim", "assister"))
            deaths.append({"tick": event.get("tick"), "attacker_steamid": attacker, "user_steamid": victim,
                           "assister_steamid": assister, "attacker_team_num": teams.get(attacker), "user_team_num": teams.get(victim),
                           "weapon": event.get("weapon"), "headshot": event.get("headshot") is True})
        deaths.sort(key=lambda event: event.get("tick") or 0)
        _apply_deaths(rows, deaths, teams, tickrate, 5.0, damage_known=False, shots_known=False)
        for event in deaths:
            attacker, victim, assister = (event.get(prefix + "steamid") for prefix in ("attacker_", "user_", "assister_"))
            if victim in rows:
                rows[victim]["events"].append({"type": "death", "tick": event["tick"], "attacker_steamid": attacker,
                                               "weapon": _weapon(event.get("weapon"))})
            if _enemy(event):
                if attacker in rows:
                    rows[attacker]["events"].append({"type": "kill", "tick": event["tick"], "target_steamid": victim,
                                                    "weapon": _weapon(event.get("weapon")), "headshot": event.get("headshot") is True})
                if assister in rows and assister != attacker and teams.get(assister) == _team(event.get("attacker_team_num")):
                    rows[assister]["events"].append({"type": "assist", "tick": event["tick"], "target_steamid": victim})
        if owner in rows:
            for key in (*COUNT_FIELDS, *BOOL_FIELDS):
                if key in window:
                    rows[owner][key] = window[key]
            analysis = window.get("analysis") if isinstance(window.get("analysis"), dict) else {}
            aim, utility = analysis.get("aim", {}), analysis.get("utility", {})
            if isinstance(aim, dict) and _known(aim.get("firearm_shots")):
                rows[owner]["shots"] = aim["firearm_shots"]
            if isinstance(utility, dict) and _known(utility.get("damage")):
                rows[owner]["utility_damage"] = utility["damage"]
            if isinstance(utility, dict):
                for source, target in (("enemy_blind_seconds", "flash_enemy_seconds"), ("team_blind_seconds", "flash_team_seconds"), ("self_blind_seconds", "flash_self_seconds")):
                    if _known(utility.get(source)):
                        rows[owner][target] = utility[source]
            timeline = analysis.get("timeline")
            if isinstance(timeline, list):
                rows[owner]["events"] = [dict(event) for event in timeline if isinstance(event, dict)]
                for stats in rows[owner]["by_weapon"].values():
                    stats["damage"] = 0
                for event in timeline:
                    if isinstance(event, dict) and event.get("type") == "damage" and _known(event.get("damage")):
                        weapon = _weapon_row(rows[owner], _weapon(event.get("weapon")), damage_known=True, shots_known=False)
                        weapon["damage"] += event["damage"]
        for identity, row in rows.items():
            collected[identity].append(row)
    # Pre-replay legacy results still retain the configured player's valid rounds.
    if owner and owner not in collected:
        for source in match.get("rounds", []):
            if isinstance(source, dict) and _team(source.get("side")):
                row = _blank_round(source, _team(source["side"]), _team(source["side"]), owner, owner,
                                   damage_known=True, shots_known=False, utility_known=False, flash_known=False)
                for key in (*COUNT_FIELDS, *BOOL_FIELDS):
                    if key in source:
                        row[key] = source[key]
                analysis = source.get("analysis") if isinstance(source.get("analysis"), dict) else {}
                if isinstance(analysis.get("timeline"), list):
                    row["events"] = [dict(event) for event in analysis["timeline"] if isinstance(event, dict)]
                collected[owner].append(row)
    names = {row["steamid"]: row.get("name") for row in roster.values()}
    names[owner] = match.get("player", {}).get("name") or names.get(owner)
    profiles = [_profile(identity, names.get(identity), group, owner, source="legacy_replay")
                for identity, group in sorted(collected.items(), key=lambda item: (item[0] != owner, item[0]))[:MAX_PLAYERS]]
    # The personal weapon summary has full damage even when legacy replay kills
    # retain only weapon kill evidence for the remaining participants.
    for profile in profiles:
        if profile["is_self"] and isinstance(match.get("summary", {}).get("by_weapon"), dict):
            profile["by_weapon"] = {name: {**stats, "shots": None} for name, stats in match["summary"]["by_weapon"].items() if isinstance(stats, dict)}
    return profiles


def _comparison(pairs):
    if not pairs:
        return None
    player = aggregate_player([pair[2] for pair in pairs])
    owner = aggregate_player([pair[3] for pair in pairs])
    deltas = {key: round(player[key] - owner[key], 3) if _known(player.get(key)) and _known(owner.get(key)) else None
              for key in ("adr", "kd", "kast_pct", "headshot_pct", "kills", "deaths", "assists", "opening_kills", "opening_deaths", "utility_damage")}
    return {"basis": "same_match_same_round", "shared_rounds": len(pairs),
            "match_ids": sorted({pair[0] for pair in pairs}), "player": player, "owner": owner, "deltas": deltas}


def build_player_directory(matches, steamid):
    """Join exact accounts and compare only intersecting match/round evidence."""
    owner = str(steamid)
    grouped = defaultdict(list)
    seen_matches = set()
    for match in matches:
        match_id = match.get("match_id")
        if not isinstance(match_id, str) or match_id in seen_matches:
            continue
        seen_matches.add(match_id)
        players = match_players(match, owner)
        own = next((player for player in players if player["steamid"] == owner), {})
        own_rounds = {row["round_number"]: row for row in own.get("rounds", [])}
        for player in players:
            grouped[player["steamid"]].append((match, player, own_rounds))
    directory = []
    for identity, entries in sorted(grouped.items(), key=lambda item: (item[0] != owner, item[0])):
        rounds, aliases, pairs, encounters = [], set(), [], []
        by_map = defaultdict(list)
        for match, player, own_rounds in entries:
            group = player.get("rounds", [])
            rounds.extend(group)
            aliases.update(player.get("aliases", []) or [player.get("name")])
            by_map[match.get("map_name") or "unknown"].extend(group)
            pairs.extend((match["match_id"], row["round_number"], row, own_rounds[row["round_number"]]) for row in group if row["round_number"] in own_rounds)
            encounters.append({"match_id": match["match_id"], "map_name": match.get("map_name"),
                               "relation": player["relation"], "teammate_rounds": player["teammate_rounds"],
                               "opponent_rounds": player["opponent_rounds"], "summary": player["summary"]})
        profile = _profile(identity, entries[0][1]["name"], rounds, owner, source="mixed" if len({entry[1]["coverage"]["source"] for entry in entries}) > 1 else entries[0][1]["coverage"]["source"], aliases=aliases)
        profile.pop("rounds")  # Per-match rounds remain at matches[].players[].rounds.
        profile.update(shared_matches=len(entries), match_ids=[entry[0]["match_id"] for entry in entries],
                       teammate_matches=sum(entry[1]["teammate_rounds"] > 0 for entry in entries),
                       opponent_matches=sum(entry[1]["opponent_rounds"] > 0 for entry in entries),
                       by_map={name: aggregate_player(group) for name, group in sorted(by_map.items())},
                       by_weapon=_weapon_sum([{"by_weapon": entry[1].get("by_weapon")} for entry in entries]),
                       encounters=encounters,
                       comparison=_comparison(pairs) if identity != owner else None,
                       teammate_comparison=_comparison([pair for pair in pairs if pair[2].get("relation") == "teammate"]) if identity != owner else None)
        directory.append(profile)
    frequent = sorted((row for row in directory if not row["is_self"] and row["teammate_matches"] >= 2),
                      key=lambda row: (-row["teammate_matches"], -row["teammate_rounds"], row["steamid"]))
    return {"version": VERSION, "identity_key": "steamid", "players": directory,
            "frequent_teammates": [row["steamid"] for row in frequent],
            "coverage": {"matches": len(seen_matches), "players": len(directory),
                         "full_event_matches": sum(any(player.get("coverage", {}).get("source") == "events" for player in match.get("players", [])) for match in matches)}}
