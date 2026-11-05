"""Mechanics invariants: real recoil, bearing geometry and opportunity rates."""
import json
import math
import os
from pathlib import Path
import unittest

from cs2demo.l3 import calculate_l3
from cs2demo.mechanics import calculate_mechanics, target_sample_ticks, shot_bursts, summarize_mechanics
from cs2demo.parser import parse_demo, _dense_ticks
from cs2demo.advanced import ANALYSIS_VERSION

SELF = "76561198000000000"
ENEMY = "76561197964020430"


def event(tick, **kwargs):
    return {"tick": tick, "is_warmup_period": False, **kwargs}


def fixture():
    rounds = [{"round_number": 1, "start_tick": 0, "end_tick": 200, "side": "T",
               "deaths": 0, "opening_kill": False, "opening_death": False,
               "analysis": {"timeline": []}}]
    shots = [event(t, user_steamid=SELF, weapon="ak47", user_team_num=2,
                   user_is_airborne=False, user_velocity_X=0, user_velocity_Y=0) for t in (100, 106, 112)]
    hurts = [event(t, attacker_steamid=SELF, user_steamid=ENEMY, attacker_team_num=2,
                   user_team_num=3, user_name="Enemy", weapon="ak47", dmg_health=20,
                   health=80 - i * 20) for i, t in enumerate((106, 112))]
    rows, x = [], 0
    for tick in range(35, 130):
        if tick <= 97:
            x += 120 / 64
        rows.append({"tick": tick, "steamid": SELF, "X": x, "Y": 0, "Z": 0,
                     "is_alive": True, "team_num": 2, "is_airborne": False,
                     "pitch": (tick - 100) * .2 if tick >= 100 else 0,
                     "yaw": 10 if tick <= 100 else max(0, 10 - (tick - 100)),
                     "aim_punch_angle": [-(tick - 100) * .1, 0, 0] if tick >= 100 else [0, 0, 0],
                     "fl_recoil_idx": 1, "accuracy_penalty": .02})
    targets = [{"tick": t, "steamid": ENEMY, "X": 1000, "Y": 0, "is_alive": True, "team_num": 3}
               for t in sorted(set(range(84, 113, 4)) | {100, 106, 112})]
    return {"weapon_fire": shots, "player_hurt": hurts}, rows, targets, rounds


class MechanicsTests(unittest.TestCase):
    def calculate(self, events=None, rows=None, targets=None, rounds=None):
        e, r, t, rs = fixture()
        events, rows, targets, rounds = events or e, rows if rows is not None else r, targets if targets is not None else t, rounds or rs
        calculate_l3(events, rows, rounds, SELF, tickrate=64, sampling={"interval_ticks": 1})
        return calculate_mechanics(events, rows, targets, rounds, SELF, tickrate=64), rounds

    def test_horizontal_target_error_and_primary_secondary_correction(self):
        result, rounds = self.calculate()
        target = rounds[0]["analysis"]["level3"]["mechanics"]["targeting"]["observations"][0]
        self.assertEqual(target["first_shot_yaw_error_degrees"], 10)
        self.assertEqual(target["secondary_correction_degrees"], 10)
        self.assertEqual(target["first_hit_delay_ms"], 93.75)
        self.assertEqual(result["targeting"]["first_shot_alignment_pct"], 0)
        self.assertFalse(result["coverage"]["visibility_verified"])
        self.assertIsNone(result["coverage"]["preaim_success_pct"])
        self.assertEqual(rounds[0]["analysis"]["level3"]["mechanics"]["targeting"]["observed_bursts"], 1)

    def test_yaw_wrap_and_target_height_do_not_create_3d_error(self):
        events, rows, targets, rounds = fixture()
        for r in rows:
            r["yaw"] = 179
        for t in targets:
            t.update(X=-1000, Y=-20, Z=99999)
        result, _ = self.calculate(events, rows, targets, rounds)
        self.assertLess(result["targeting"]["median_first_shot_yaw_error_degrees"], 3)
        self.assertEqual(result["coverage"]["target_geometry"], "horizontal_origin_bearing")

    def test_no_hurt_or_wrong_identity_never_infers_a_target(self):
        events, rows, targets, rounds = fixture()
        events["player_hurt"] = []
        result, _ = self.calculate(events, rows, targets, rounds)
        self.assertEqual(result["targeting"]["associated_bursts"], 0)
        self.assertIsNone(result["targeting"]["first_shot_alignment_pct"])
        events, rows, targets, rounds = fixture()
        targets = [dict(t, steamid="76561197964020431") for t in targets]
        result, _ = self.calculate(events, rows, targets, rounds)
        self.assertEqual(result["targeting"]["observed_bursts"], 0)
        self.assertIsNone(result["targeting"]["median_first_shot_yaw_error_degrees"])

    def test_recoil_traces_use_recorded_punch_without_an_assumed_scale(self):
        result, rounds = self.calculate()
        for section in ("targeting", "stopping", "spray"):
            self.assertNotIn("observations", result[section])
        spray = rounds[0]["analysis"]["level3"]["mechanics"]["spray"]["observations"][0]
        self.assertEqual(spray["trace"][-1]["punch_pitch_degrees"], -1.2)
        self.assertEqual(spray["trace"][-1]["pitch_delta_degrees"], 2.4)
        self.assertEqual(spray["vertical_countermotion_pct"], 100)
        self.assertIsNone(result["coverage"]["recoil_scale_applied"])
        self.assertEqual(spray["hit_shots"], 2)
        self.assertEqual(spray["shots"], 3)
        self.assertEqual(result["spray"]["shot_index_breakdown"][-1]["shot_index"], 3)

    def test_pellets_and_penetration_cannot_inflate_associated_shot_count(self):
        events, rows, targets, rounds = fixture()
        events["player_hurt"].append(dict(events["player_hurt"][0], user_steamid="76561197964020431"))
        result, rounds = self.calculate(events, rows, targets, rounds)
        self.assertEqual(result["spray"]["hit_shots"], 2)
        self.assertEqual(rounds[0]["analysis"]["level3"]["mechanics"]["targeting"]["observations"][0]["target_count"], 2)
        self.assertLessEqual(result["spray"]["shot_hit_pct"], 100)

    def test_spray_yaw_trace_unwraps_continuous_turn_across_seam(self):
        events, rows, targets, rounds = fixture()
        for row in rows:
            # Relative yaw crosses +179 to -179 while physically moving 2°.
            row["yaw"] = 0 if row["tick"] <= 100 else 179 if row["tick"] == 101 else -179
        result, rounds = self.calculate(events, rows, targets, rounds)
        spray = rounds[0]["analysis"]["level3"]["mechanics"]["spray"]["observations"][0]
        self.assertEqual(spray["horizontal_view_span_degrees"], 181)
        self.assertEqual(spray["trace"][-1]["yaw_delta_degrees"], 181)

    def test_cz75_auto_three_shot_burst_has_spray_analysis(self):
        events, rows, targets, rounds = fixture()
        for stream in ("weapon_fire", "player_hurt"):
            for row in events[stream]:
                row["weapon"] = "cz75a"
        result, rounds = self.calculate(events, rows, targets, rounds)
        self.assertEqual(result["spray"]["bursts"], 1)
        self.assertEqual(result["spray"]["shots"], 3)
        self.assertEqual(result["spray"]["hit_shots"], 2)
        self.assertEqual(rounds[0]["analysis"]["level3"]["mechanics"]["spray"]["observations"][0]["weapon"], "cz75a")

    def test_old_or_wrong_weapon_hurts_cannot_be_matched_to_a_shot(self):
        events, rows, targets, rounds = fixture()
        events["player_hurt"] = [dict(events["player_hurt"][0], tick=110), dict(events["player_hurt"][1], weapon="deagle")]
        result, _ = self.calculate(events, rows, targets, rounds)
        self.assertEqual(result["spray"]["hit_shots"], 0)
        self.assertEqual(result["targeting"]["associated_bursts"], 0)

    def test_move_to_fire_denominator_excludes_held_angles_and_missing_data(self):
        result, _ = self.calculate()
        self.assertEqual(result["stopping"]["eligible_opportunities"], 1)
        self.assertEqual(result["stopping"]["stop_before_fire_pct"], 100)
        events, rows, targets, rounds = fixture()
        for r in rows:
            r["X"] = 0
        result, _ = self.calculate(events, rows, targets, rounds)
        self.assertEqual(result["stopping"]["eligible_opportunities"], 0)
        self.assertIsNone(result["stopping"]["stop_before_fire_pct"])
        self.assertEqual(rounds[0]["analysis"]["level3"]["mechanics"]["stopping"]["observations"][0]["reason"], "already_stationary")
        result, _ = self.calculate(rows=[])
        self.assertEqual(result["stopping"]["unknown_opportunities"], 1)

    def test_moving_grounded_fire_is_an_observed_failure_not_missing(self):
        events, rows, targets, rounds = fixture()
        for r in rows:
            r["X"] = r["tick"] * 120 / 64
        result, _ = self.calculate(events, rows, targets, rounds)
        self.assertEqual(result["stopping"]["eligible_opportunities"], 1)
        self.assertEqual(result["stopping"]["stop_before_fire_pct"], 0)
        self.assertEqual(result["stopping"]["moving_at_fire"], 1)

    def test_landing_interval_is_not_a_grounded_move_to_fire_opportunity(self):
        events, rows, targets, rounds = fixture()
        for row in rows:
            row["X"] = row["tick"] * 120 / 64
            row["is_airborne"] = row["tick"] < 100
        result, rounds = self.calculate(events, rows, targets, rounds)
        self.assertEqual(result["stopping"]["eligible_opportunities"], 0)
        self.assertEqual(result["stopping"]["unknown_opportunities"], 1)
        self.assertIsNone(result["stopping"]["stop_before_fire_pct"])
        stop = rounds[0]["analysis"]["level3"]["mechanics"]["stopping"]["observations"][0]
        self.assertEqual(stop["reason"], "landing_transition")

    def test_spray_countermotion_rate_pools_pairs_instead_of_burst_percentages(self):
        _, rounds = self.calculate()
        spray = rounds[0]["analysis"]["level3"]["mechanics"]["spray"]["observations"][0]
        a = dict(spray, vertical_countermotion_pairs=1, vertical_recoil_change_pairs=1,
                 vertical_countermotion_pct=100)
        b = dict(spray, vertical_countermotion_pairs=0, vertical_recoil_change_pairs=9,
                 vertical_countermotion_pct=0)
        result = summarize_mechanics([], [], [a, b])
        self.assertEqual(result["spray"]["vertical_countermotion_pct"], 10)
        self.assertEqual(result["spray"]["median_vertical_countermotion_pct"], 50)

    def test_bursts_do_not_cross_rounds_and_dense_samples_cover_whole_spray(self):
        events, rows, targets, rounds = fixture()
        ticks, sampling = _dense_ticks(events, rounds, SELF, 64)
        self.assertTrue(all(t in ticks for t in range(100, 129)))
        self.assertTrue(sampling["full_burst_duration"])
        ticks, sampling = target_sample_ticks(events, rounds, SELF, 64)
        self.assertTrue({100, 106, 112}.issubset(ticks))
        rounds[0]["end_tick"] = 105
        rounds.append({**rounds[0], "round_number": 2, "start_tick": 106, "end_tick": 200})
        self.assertEqual(len(shot_bursts(events, rounds, SELF, 64)), 2)

    @unittest.skipUnless(os.environ.get("CS2_PUBLIC_TEST_DEMO"), "optional pinned real Valve replay")
    def test_real_demo_punch_and_target_bearing_integration(self):
        result = parse_demo(Path(os.environ["CS2_PUBLIC_TEST_DEMO"]), "76561197964020430")
        self.assertEqual(result["analysis_version"], ANALYSIS_VERSION)
        self.assertEqual(result["provenance"]["source_sha256"], "84a1a4191302bdd2a3bbb5a727842093744b1fb1a228aeec630369e44b622cb2")
        model = result["analysis"]["level3"]["mechanics"]
        self.assertGreater(model["targeting"]["observed_bursts"], 0)
        self.assertGreater(model["stopping"]["eligible_opportunities"], 0)
        self.assertGreater(model["spray"]["bursts"], 0)
        self.assertTrue(any(abs(p["punch_pitch_degrees"] or 0) > .1 for r in result["rounds"] for b in r["analysis"]["level3"]["mechanics"]["spray"]["observations"] for p in b["trace"]))
        self.assertIsNone(result["analysis"]["level3"]["preaim"]["median_deviation_degrees"])
        json.dumps(result, allow_nan=False)


if __name__ == "__main__":
    unittest.main()
