import json
import os
from pathlib import Path
import tempfile
from types import SimpleNamespace
import unittest
from unittest.mock import Mock, patch

from cs2demo.metrics import calculate_metrics, steam_id
from cs2demo.parser import _tickrate, _validate_events, parse_demo

SELF = "76561197964020430"
ALLY = "76561198244754626"
ENEMY = "76561198073049527"
ENEMY2 = "76561198194694750"


def event(tick, **extra):
    return {"tick": tick, "total_rounds_played": 0, "is_warmup_period": False, **extra}


def death(tick, attacker=SELF, victim=ENEMY, attacker_team=2, victim_team=3, **extra):
    return event(tick, **{"attacker_steamid": attacker, "user_steamid": victim,
                         "attacker_team_num": attacker_team, "user_team_num": victim_team,
                         "assister_steamid": None, "headshot": False, "weapon": "ak47", **extra})


def hurt(tick, damage, health, attacker=SELF, victim=ENEMY, attacker_team=2, victim_team=3):
    return event(tick, attacker_steamid=attacker, user_steamid=victim,
                 attacker_team_num=attacker_team, user_team_num=victim_team,
                 dmg_health=damage, health=health, weapon="ak47")


def fixture():
    events = {"round_freeze_end": [event(100)], "round_end": [event(1000, reason=9, winner=2)],
              "player_death": [], "player_hurt": []}
    samples = [{"tick": 100, "steamid": int(SELF), "is_alive": True, "team_num": 2,
                "X": 12.5, "Y": -20, "Z": 100}]
    return events, samples


class DemoMetricTests(unittest.TestCase):
    def test_effective_damage_caps_overkill_after_other_players_damage(self):
        events, samples = fixture()
        events["player_hurt"] = [hurt(110, 70, 30, attacker=ALLY), hurt(120, 400, 0),
                                 hurt(130, 20, 80, victim=ALLY, victim_team=2),
                                 hurt(140, 200, 0, victim=ENEMY2)]
        events["player_death"] = [death(120, headshot=True), death(140, victim=ENEMY2)]
        result = calculate_metrics(events, samples, SELF)
        self.assertEqual(result["summary"]["damage"], 130)
        self.assertEqual(result["summary"]["adr"], 130)
        self.assertEqual(result["summary"]["headshot_pct"], 50)
        self.assertEqual(result["summary"]["by_weapon"]["ak47"]["damage"], 130)
        self.assertEqual(result["rounds"][0]["kills"], 2)
        json.dumps(result, allow_nan=False)

    def test_trade_window_inclusive_at_5_seconds_64_ticks(self):
        events, samples = fixture()
        events["player_death"] = [death(200, ENEMY, SELF, 3, 2),
                                  death(520, ALLY, ENEMY, 2, 3)]
        result = calculate_metrics(events, samples, SELF)
        self.assertTrue(result["rounds"][0]["traded"])
        self.assertEqual(result["summary"]["kast_pct"], 100)
        self.assertEqual(result["summary"]["opening_deaths"], 1)
        events["player_death"][1]["tick"] = 521
        result = calculate_metrics(events, samples, SELF)
        self.assertFalse(result["rounds"][0]["traded"])
        self.assertEqual(result["summary"]["kast_pct"], 0)

    def test_enemy_trade_does_not_count_as_teammate_trade(self):
        events, samples = fixture()
        events["player_death"] = [death(200, ENEMY, SELF, 3, 2),
                                  death(300, ENEMY2, ENEMY, 3, 3)]
        self.assertFalse(calculate_metrics(events, samples, SELF)["rounds"][0]["traded"])

    def test_assists_survival_and_side_aggregation(self):
        events, samples = fixture()
        assisted = death(300, ALLY, ENEMY)
        assisted["assister_steamid"] = SELF
        assisted["assistedflash"] = True
        events["player_death"] = [assisted]
        events["round_freeze_end"].append(event(1100, total_rounds_played=1))
        events["round_end"].append(event(1400, total_rounds_played=1, reason=8, winner=3))
        samples.append({**samples[0], "tick": 1100, "team_num": 3})
        result = calculate_metrics(events, samples, SELF)
        self.assertEqual(result["summary"]["assists"], 1)
        self.assertEqual(result["summary"]["by_side"]["CT"]["rounds"], 1)
        self.assertIsNone(result["summary"]["headshot_pct"])
        self.assertEqual(result["summary"]["kast_pct"], 100)

    def test_warmup_postround_surrender_incomplete_and_absent_rounds_excluded(self):
        events, samples = fixture()
        events["player_death"] = [death(90), death(110, is_warmup_period=True), death(1001)]
        events["round_freeze_end"].extend([event(1100, total_rounds_played=1),
                                          event(1500, total_rounds_played=2),
                                          event(2000, total_rounds_played=3)])
        events["round_end"].extend([event(1400, total_rounds_played=1, reason=18, winner=2),
                                   event(2400, total_rounds_played=3, reason=8, winner=3)])
        result = calculate_metrics(events, samples, SELF)
        self.assertEqual(result["summary"]["rounds"], 1)
        self.assertEqual(result["summary"]["kills"], 0)
        self.assertTrue(result["limitations"])

    def test_identity_precision_and_target_not_present(self):
        self.assertEqual(steam_id(int(SELF)), SELF)
        self.assertIsNone(steam_id(float(SELF)))
        with tempfile.TemporaryDirectory() as directory:
            demo = Path(directory) / "test.dem"
            demo.write_bytes(b"PBDEMS2\x00fake")
            fake = Mock()
            fake.parse_player_info.return_value.to_dict.return_value = [{"steamid": int(ALLY), "name": "other"}]
            with patch.dict("sys.modules", {"demoparser2": SimpleNamespace(DemoParser=lambda _: fake)}):
                with self.assertRaisesRegex(ValueError, "not found"):
                    parse_demo(demo, SELF)
        events, samples = fixture()
        with self.assertRaisesRegex(ValueError, "target player"):
            calculate_metrics(events, [{**samples[0], "steamid": int(ALLY)}], SELF)

    def test_incompatible_schema_fails_instead_of_generating_zero_damage(self):
        events, _ = fixture()
        events["player_hurt"] = [hurt(150, 20, 80)]
        del events["player_hurt"][0]["health"]
        with self.assertRaisesRegex(ValueError, "health"):
            _validate_events(events)

    def test_tickrate_is_inferred_and_fallback_is_explicit(self):
        records = [event(tick, game_time=tick / 128) for tick in (128, 256, 512)]
        self.assertEqual(_tickrate({"round_end": records})[0], 128)
        self.assertIn("assumed", _tickrate({})[1])

    def test_samples_contain_only_living_self_with_finite_coordinates(self):
        events, samples = fixture()
        samples.extend([{**samples[0], "tick": 228, "is_alive": False},
                        {**samples[0], "tick": 356, "steamid": int(ENEMY)},
                        {**samples[0], "tick": 484, "X": float("nan")}])
        positions = calculate_metrics(events, samples, SELF)["rounds"][0]["positions"]
        self.assertEqual(positions, [{"tick": 100, "x": 12.5, "y": -20.0, "z": 100.0}])

    def test_restarted_match_does_not_silently_merge_duplicate_rounds(self):
        events,samples=fixture()
        events['round_freeze_end'].append(event(1200))
        events['round_end'].append(event(2000,reason=9,winner=2))
        samples.append({**samples[0],'tick':1200})
        with self.assertRaisesRegex(ValueError,'restart'):
            calculate_metrics(events,samples,SELF)

    def test_round_end_counter_may_increment_before_the_event_is_emitted(self):
        events,samples=fixture()
        events['round_end'][0]['total_rounds_played']=1
        result=calculate_metrics(events,samples,SELF)
        self.assertEqual(result['summary']['rounds'],1)
        self.assertEqual(result['rounds'][0]['round_number'],1)
        events['round_end'][0]['total_rounds_played']=2
        with self.assertRaises(ValueError): calculate_metrics(events,samples,SELF)

    def test_numeric_warmup_flags_are_explicit_and_unknown_flags_stay_excluded(self):
        events,samples=fixture()
        for rows in events.values():
            for row in rows: row['is_warmup_period']=0
        self.assertEqual(calculate_metrics(events,samples,SELF)['summary']['rounds'],1)
        events['round_end'][0]['is_warmup_period']=None
        with self.assertRaises(ValueError): calculate_metrics(events,samples,SELF)

    def test_modern_synthesized_round_reason_and_winner_enums(self):
        events,samples=fixture()
        events['round_end'][0].update(total_rounds_played=1,reason='ct_killed',winner='T')
        result=calculate_metrics(events,samples,SELF)
        self.assertEqual(result['summary']['rounds'],1)
        self.assertTrue(result['rounds'][0]['won'])
        for reason in ('ct_surrender','game_start','unknown_reason',None):
            events['round_end'][0]['reason']=reason
            with self.assertRaises(ValueError): calculate_metrics(events,samples,SELF)

    @unittest.skipUnless(os.environ.get("CS2_PUBLIC_TEST_DEMO"), "optional 58 MB public demoparser fixture")
    def test_public_valve_demo_integration(self):
        # LaihoE/demoparser commit 45ca85aeac8fb0de9d385124d2c7fe0e7b8ff0c8,
        # src/parser/test_demo.dem (Valve Mirage; this identity is a public fixture).
        result = parse_demo(Path(os.environ["CS2_PUBLIC_TEST_DEMO"]), SELF)
        self.assertEqual(result["provenance"]["source_sha256"],
                         "84a1a4191302bdd2a3bbb5a727842093744b1fb1a228aeec630369e44b622cb2")
        self.assertEqual(result["map_name"], "de_mirage")
        self.assertEqual(result["summary"]["rounds"], 9)
        self.assertEqual(result["summary"]["kills"], 11)
        self.assertEqual(result["summary"]["damage"], 1207)
        self.assertEqual(result["provenance"]["tickrate"], 64)
        self.assertGreater(sum(len(row["positions"]) for row in result["rounds"]), 0)
        json.dumps(result, allow_nan=False)


if __name__ == "__main__":
    unittest.main()
