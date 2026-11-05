import copy
import json
import unittest

from cs2demo.metrics import calculate_metrics
from cs2demo.players import aggregate_player, build_player_directory, build_player_stats, match_players
from cs2demo.replay import _encode_frames


OWNER = "76561198000000001"
ALLY = "76561198000000002"
ENEMY = "76561198000000003"
ENEMY2 = "76561198000000004"
ALL = [f"765611980000000{index:02d}" for index in range(1, 11)]


def event(tick, **values):
    return {"tick": tick, "is_warmup_period": False, "total_rounds_played": 0, **values}


def death(tick, attacker, victim, *, team=2, victim_team=3, **values):
    return event(tick, attacker_steamid=attacker, user_steamid=victim, attacker_team_num=team,
                 user_team_num=victim_team, assister_steamid=None, headshot=False, weapon="ak47", **values)


def hurt(tick, attacker, victim, damage, health, *, team=2, victim_team=3, weapon="ak47"):
    return event(tick, attacker_steamid=attacker, user_steamid=victim, attacker_team_num=team,
                 user_team_num=victim_team, dmg_health=damage, health=health, weapon=weapon)


def fixture():
    events = {"round_freeze_end": [event(100), event(1000, total_rounds_played=1)],
              "round_end": [event(600, winner=2, reason=9), event(1300, winner=3, reason=8, total_rounds_played=1)],
              "player_death": [death(120, OWNER, ENEMY), death(130, ENEMY2, ALLY, team=3, victim_team=2),
                               death(140, OWNER, ENEMY2)],
              "player_hurt": [hurt(110, ALLY, ENEMY, 80, 20), hurt(115, ENEMY, ALLY, 30, 70, team=3, victim_team=2),
                              hurt(116, OWNER, ALLY, 5, 65, victim_team=2), hurt(120, OWNER, ENEMY, 200, 0),
                              hurt(140, OWNER, ENEMY2, 100, 0)],
              "weapon_fire": [event(120, user_steamid=OWNER, weapon="ak47"), event(125, user_steamid=OWNER, weapon="smokegrenade")],
              "player_blind": [event(150, attacker_steamid=ALLY, user_steamid=ENEMY2, attacker_team_num=2, user_team_num=3, blind_duration=2.25)]}
    events["player_death"][0]["assister_steamid"] = ALLY
    events["player_death"][0]["headshot"] = True
    samples = []
    for tick in (100, 1000):
        for identity in ALL:
            team = 2 if identity in (OWNER, ALLY, *ALL[4:7]) else 3
            if tick == 1000:
                team = 5 - team
            samples.append({"tick": tick, "steamid": int(identity), "name": "duplicate label" if identity in (ALLY, ENEMY) else identity,
                            "team_num": team, "is_alive": True, "X": 0, "Y": 0, "Z": 0})
    rounds = calculate_metrics(events, samples, OWNER)["rounds"]
    info = [{"steamid": identity, "name": "duplicate label" if identity in (ALLY, ENEMY) else identity} for identity in ALL]
    return events, samples, rounds, info


class AllPlayerTests(unittest.TestCase):
    def test_ten_players_damage_cap_trades_assists_and_side_switch(self):
        events, samples, rounds, info = fixture()
        players = build_player_stats(events, samples, rounds, info, OWNER)
        self.assertEqual(len(players), 10)
        own = next(row for row in players if row["steamid"] == OWNER)
        ally = next(row for row in players if row["steamid"] == ALLY)
        self.assertEqual(own["summary"]["damage"], 120)
        self.assertEqual(own["summary"]["friendly_damage"], 5)
        self.assertEqual(own["summary"]["adr"], 60)
        self.assertEqual(own["summary"]["opening_kills"], 1)
        self.assertEqual(own["summary"]["trade_kills"], 1)
        self.assertEqual(own["summary"]["headshot_pct"], 50)
        self.assertEqual(own["summary"]["shots"], 1)
        self.assertEqual(own["by_side"]["CT"]["rounds"], 1)
        self.assertEqual(ally["summary"]["assists"], 1)
        self.assertEqual(ally["summary"]["traded_rounds"], 1)
        self.assertEqual(ally["summary"]["flash_enemy_seconds"], 2.25)
        self.assertEqual(ally["relation"], "teammate")
        self.assertEqual(ally["teammate_rounds"], 2)
        self.assertEqual(sum(event["damage"] for row in own["rounds"] for event in row["events"] if event["type"] == "damage"), 120)
        self.assertEqual([event["type"] for event in ally["rounds"][0]["events"] if event["tick"] == 150], ["flash"])
        for key in ("kills", "deaths", "assists", "damage", "headshot_kills"):
            self.assertEqual(own["summary"][key], sum(row[key] for row in rounds))
        json.dumps(players, allow_nan=False)

    def test_missing_participation_and_float_identity_not_filled(self):
        events, samples, rounds, info = fixture()
        samples = [state for state in samples if not (str(state["steamid"]) == ALLY and state["tick"] == 1000)]
        samples.append({**samples[0], "steamid": float(76561198000000111)})
        players = build_player_stats(events, samples, rounds, info, OWNER, available_events={"player_death", "player_hurt"})
        ally = next(row for row in players if row["steamid"] == ALLY)
        self.assertEqual(ally["summary"]["rounds"], 1)
        self.assertEqual(ally["coverage"]["complete_live_rounds"], 1)
        self.assertIsNone(ally["summary"]["shots"])
        self.assertIsNone(ally["summary"]["flash_enemy_seconds"])
        self.assertEqual(len(players), 10)
        self.assertTrue(all(isinstance(row["steamid"], str) for row in players))

    def test_warmup_postround_and_teamkills_not_enemy_kills(self):
        events, samples, rounds, info = fixture()
        events["player_death"] += [death(90, OWNER, ENEMY), death(601, OWNER, ENEMY),
                                   death(200, OWNER, ALLY, victim_team=2), death(250, OWNER, ENEMY, is_warmup_period=True)]
        players = build_player_stats(events, samples, rounds, info, OWNER)
        own = next(row for row in players if row["is_self"])
        self.assertEqual(own["summary"]["kills"], 2)

    def test_ratios_pool_known_counts_with_explicit_denominators(self):
        _, _, rounds, _ = fixture()
        rows = copy.deepcopy(rounds)
        rows[0].update(damage=100, kills=2, headshot_kills=1, kast=True)
        rows[1].update(damage=None, kills=0, headshot_kills=0, kast=False)
        aggregate = aggregate_player(rows)
        self.assertEqual(aggregate["rounds"], 2)
        self.assertEqual(aggregate["adr_rounds"], 1)
        self.assertEqual(aggregate["adr"], 100)
        self.assertEqual(aggregate["kast_pct"], 50)
        self.assertEqual(aggregate["headshot_pct"], 50)
        self.assertIsNone(aggregate_player([])["damage"])

    def test_repeated_teammates_compare_identical_rounds_and_exact_ids(self):
        events, samples, rounds, info = fixture()
        first = build_player_stats(events, samples, rounds, info, OWNER)
        other = copy.deepcopy(first)
        for player in other:
            if player["steamid"] == ALLY:
                player["rounds"] = player["rounds"][:1]
                player["rounds"][0]["damage"] = 20
                player["name"] = "new alias"
                player["aliases"] = ["new alias"]
        matches = [{"match_id": "one", "map_name": "de_dust2", "players": first},
                   {"match_id": "two", "map_name": "de_nuke", "players": other}]
        result = build_player_directory([*matches, matches[0]], OWNER)
        ally = next(row for row in result["players"] if row["steamid"] == ALLY)
        enemy = next(row for row in result["players"] if row["steamid"] == ENEMY)
        self.assertEqual(ally["shared_matches"], 2)
        self.assertEqual(ally["summary"]["rounds"], 3)
        self.assertEqual(ally["summary"]["damage"], 100)
        self.assertEqual(ally["summary"]["adr"], 33.33)
        self.assertEqual(ally["comparison"]["shared_rounds"], 3)
        self.assertEqual(ally["comparison"]["owner"]["rounds"], 3)
        self.assertEqual(ally["comparison"]["owner"]["damage"], 240)
        self.assertIn(ALLY, result["frequent_teammates"])
        self.assertNotIn(ENEMY, result["frequent_teammates"])
        self.assertIsNone(enemy["teammate_comparison"])
        self.assertEqual(ally["aliases"], ["duplicate label", "new alias"])
        self.assertNotEqual(ally["steamid"], enemy["steamid"])

    def test_legacy_replay_recovers_kills_but_leaves_damage_unknown(self):
        _, _, rounds, _ = fixture()
        frames = _encode_frames([[100, [[0, 0, 0, 0, 0, 0, 1, 2], [1, 0, 0, 0, 0, 0, 1, 2], [2, 0, 0, 0, 0, 0, 1, 3]]]])
        match = {"player": {"steamid": OWNER, "name": "owner"}, "rounds": rounds[:1], "summary": {},
                 "replay": {"tickrate": 64, "player_fields": ["player_index", "x", "y", "z", "yaw", "pitch", "alive", "team"],
                            "players": [{"index": 0, "steamid": OWNER, "name": "owner"}, {"index": 1, "steamid": ALLY, "name": "ally"},
                                        {"index": 2, "steamid": ENEMY, "name": "enemy"}],
                            "rounds": [{"round_number": 1, "frames": frames,
                                        "kills": [{"tick": 120, "attacker_index": 1, "victim_index": 2, "assister_index": None, "headshot": True, "weapon": "ak47"}]}]}}
        players = match_players(match)
        own = next(row for row in players if row["is_self"])
        ally = next(row for row in players if row["steamid"] == ALLY)
        self.assertEqual(own["summary"]["damage"], 120)
        self.assertEqual(ally["summary"]["kills"], 1)
        self.assertEqual(ally["summary"]["headshot_pct"], 100)
        self.assertIsNone(ally["summary"]["damage"])
        self.assertIsNone(ally["summary"]["adr"])
        self.assertIsNone(ally["summary"]["utility_damage"])
        self.assertEqual(ally["coverage"]["damage_rounds"], 0)

    def test_legacy_without_replay_keeps_only_known_owner(self):
        _, _, rounds, _ = fixture()
        players = match_players({"player": {"steamid": OWNER}, "rounds": rounds})
        self.assertEqual(len(players), 1)
        self.assertEqual(players[0]["steamid"], OWNER)
        self.assertEqual(players[0]["summary"]["damage"], 120)

    def test_unknown_damage_metadata_excludes_round_from_adr_denominator(self):
        events, samples, rounds, info = fixture()
        events["player_hurt"].append(hurt(160, OWNER, ENEMY2, 1, 0, victim_team=None))
        own = next(row for row in build_player_stats(events, samples, rounds, info, OWNER) if row["is_self"])
        self.assertIsNone(own["rounds"][0]["damage"])
        self.assertEqual(own["summary"]["adr_rounds"], 1)
        self.assertEqual(own["summary"]["adr"], 0)
        self.assertEqual(own["coverage"]["damage_rounds"], 1)

    def test_minimal_legacy_round_has_no_fabricated_tick_bounds(self):
        _, _, rounds, _ = fixture()
        row = {key: value for key, value in rounds[0].items() if key not in ("start_tick", "end_tick", "winner")}
        own = match_players({"player": {"steamid": OWNER}, "rounds": [row]})[0]
        self.assertIsNone(own["rounds"][0]["start_tick"])
        self.assertIsNone(own["rounds"][0]["end_tick"])
        self.assertEqual(own["summary"]["damage"], 120)


if __name__ == "__main__":
    unittest.main()
