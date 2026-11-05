"""Playable angular traces preserve shots and observed opponent geometry."""
import json
import math
import os
from pathlib import Path
import unittest

from cs2demo.mechanics import calculate_mechanics, target_sample_ticks
from cs2demo.parser import parse_demo

SELF = "76561198000000000"
ENEMY = "76561197964020430"
OTHER = "76561197964020431"
FRIEND = "76561197964020432"


def fixture(*, hurts=True, fire_ticks=(100, 106, 112)):
    rounds = [{"round_number": 1, "start_tick": 0, "end_tick": 400, "side": "T", "analysis": {}}]
    events = {"weapon_fire": [{"tick": t, "user_steamid": SELF, "user_team_num": 2,
                               "weapon": "ak47", "is_warmup_period": False} for t in fire_ticks],
              "player_hurt": []}
    if hurts:
        events["player_hurt"] = [{"tick": 106, "attacker_steamid": SELF, "user_steamid": ENEMY,
                                 "attacker_team_num": 2, "user_team_num": 3, "user_name": "Enemy",
                                 "weapon": "ak47", "dmg_health": 20, "health": 80, "hitgroup": 1,
                                 "is_warmup_period": False}]
    own = [{"tick": tick, "steamid": SELF, "X": tick, "Y": 0, "Z": 0,
            "yaw": 8 - tick * .04, "pitch": 0, "team_num": 2,
            "is_alive": True, "is_airborne": False} for tick in range(0, 401)]
    ticks, _ = target_sample_ticks(events, rounds, SELF, 64)
    targets = [{"tick": tick, "steamid": sid, "name": name, "X": 1000, "Y": y, "Z": 0,
                "team_num": team, "is_alive": True}
               for tick in ticks for sid, name, y, team in ((ENEMY, "Enemy", 0, 3),
                                                          (OTHER, "Other", 100, 3),
                                                          (FRIEND, "Friend", 200, 2))]
    return events, own, targets, rounds


def calculate(parts):
    events, own, targets, rounds = parts
    aggregate = calculate_mechanics(events, own, targets, rounds, SELF, tickrate=64)
    return aggregate, rounds[0]["analysis"]["level3"]["mechanics"]["aim_playback"]["windows"][0]


class AimPlaybackTests(unittest.TestCase):
    def test_window_contains_full_pre_fire_burst_and_post_context_and_exact_shots(self):
        aggregate, window = calculate(fixture())
        self.assertEqual((window["start_tick"], window["finish_tick"]), (36, 128))
        self.assertEqual([p[0] for p in window["shot_markers"]], [100, 106, 112])
        self.assertTrue({100, 106, 112}.issubset({p[0] for p in window["points"]}))
        self.assertEqual([p[2] for p in window["shot_markers"]], [False, True, False])
        self.assertEqual(window["shot_markers"][1][3:], [20, [0], 64.0, [1]])
        self.assertTrue(window["coverage"]["pre_window_complete"])
        self.assertNotIn("windows", aggregate["aim_playback"])
        self.assertEqual(aggregate["aim_playback"]["total_bursts"], 1)
        self.assertEqual(window["metrics"]["first_shot_yaw_error_degrees"], 4)
        self.assertEqual(window["metrics"]["excess_path_degrees"], 0)
        json.dumps(window, allow_nan=False)

    def test_all_missed_bursts_keep_view_and_observed_opponents_without_intended_target(self):
        aggregate, window = calculate(fixture(hurts=False))
        self.assertEqual(len(window["targets"]), 2)
        self.assertNotIn(FRIEND, {t["steamid"] for t in window["targets"]})
        self.assertTrue(all(not t["damage_associated"] for t in window["targets"]))
        self.assertIsNone(window["primary_target_index"])
        self.assertIsNone(window["metrics"]["first_shot_yaw_error_degrees"])
        self.assertIsNone(window["metrics"]["overshoot_count"])
        self.assertGreater(len(window["points"]), 2)
        self.assertEqual(aggregate["aim_playback"]["associated_windows"], 0)
        self.assertEqual(aggregate["targeting"]["associated_bursts"], 0)

    def test_dense_yaw_unwrap_does_not_jump_at_180_degrees(self):
        parts = fixture()
        for row in parts[1]:
            row["yaw"] = 179 if row["tick"] <= 100 else -179
        for row in parts[2]:
            angle = math.radians(179 if row["tick"] <= 100 else -179)
            row.update(X=row["tick"] + 1000 * math.cos(angle), Y=1000 * math.sin(angle))
        _, window = calculate(parts)
        last = next(p for p in window["points"] if p[0] == 112)
        target = next(p for p in window["targets"][0]["points"] if p[0] == 112)
        self.assertEqual(last[1], 2)
        self.assertAlmostEqual(target[1], 2, places=2)
        self.assertEqual(window["metrics"]["first_shot_yaw_error_degrees"], 0)

    def test_complete_turn_is_preserved_before_chart_sampling(self):
        parts = fixture(hurts=False)
        for row in parts[1]:
            row["yaw"] = (row["tick"] * 6 + 180) % 360 - 180
        _, window = calculate(parts)
        self.assertEqual(window["metrics"]["acquisition_path_degrees"], 384)
        self.assertEqual(window["points"][0][1], -384)
        self.assertEqual(next(p for p in window["points"] if p[0] == 100)[1], 0)
        self.assertEqual(next(p for p in window["targets"][0]["points"] if p[0] == 100)[1], 120)

    def test_dead_targets_stop_except_at_exact_associated_damage_shot(self):
        parts = fixture()
        for row in parts[2]:
            if row["steamid"] == ENEMY and row["tick"] >= 106:
                row["is_alive"] = False
        _, window = calculate(parts)
        points = {p[0]: p for p in window["targets"][0]["points"]}
        self.assertIsNotNone(points[106][1])
        self.assertIsNone(points[112][1])
        self.assertTrue(all(v is None for v in points[128][1:]))

    def test_missing_target_sample_is_a_null_gap_and_not_a_held_position(self):
        parts = fixture()
        parts[2][:] = [row for row in parts[2] if not (row["steamid"] == ENEMY and row["tick"] == 100)]
        _, window = calculate(parts)
        missing = next(p for p in window["targets"][0]["points"] if p[0] == 100)
        self.assertEqual(missing, [100, None, None, None, None, None])
        self.assertIsNone(window["metrics"]["first_shot_yaw_error_degrees"])
        self.assertIsNone(window["metrics"]["overshoot_count"])

    def test_missing_own_exact_shot_has_null_coordinates_and_speed_without_approximation(self):
        parts = fixture()
        parts[1][:] = [row for row in parts[1] if row["tick"] != 100]
        _, window = calculate(parts)
        shot_point = next(p for p in window["points"] if p[0] == 100)
        self.assertTrue(all(v is None for v in shot_point[1:]))
        self.assertIsNone(window["shot_markers"][0][5])
        self.assertFalse(window["coverage"]["pre_window_complete"])
        self.assertIsNone(window["metrics"]["acquisition_path_degrees"])

    def test_multiple_hurt_targets_keep_first_association_and_correct_marker_indexes(self):
        parts = fixture()
        parts[0]["player_hurt"].append(dict(parts[0]["player_hurt"][0], tick=112,
                                              user_steamid=OTHER, user_name="Other", hitgroup=2))
        aggregate, window = calculate(parts)
        self.assertEqual([t["steamid"] for t in window["targets"]], [ENEMY, OTHER])
        self.assertTrue(all(t["damage_associated"] for t in window["targets"]))
        self.assertEqual(window["shot_markers"][1][4], [0])
        self.assertEqual(window["shot_markers"][2][4], [1])
        self.assertEqual(aggregate["targeting"]["associated_bursts"], 1)

    def test_named_and_numeric_hitgroups_produce_the_same_compact_code(self):
        parts = fixture()
        parts[0]["player_hurt"][0]["hitgroup"] = "head"
        _, window = calculate(parts)
        self.assertEqual(window["shot_markers"][1][6], [1])

    def test_player_origin_pitch_is_optional_and_not_assumed_head_height(self):
        parts = fixture()
        for row in parts[2]:
            row["Z"] = 900
        _, window = calculate(parts)
        self.assertEqual(window["metrics"]["first_shot_pitch_error_degrees"], 45)
        self.assertEqual(window["coverage"]["target_geometry"], "player_origin_bearing")
        self.assertFalse(window["coverage"]["visibility_verified"])
        parts = fixture()
        for row in parts[2]:
            row.pop("Z")
        _, window = calculate(parts)
        self.assertIsNotNone(window["metrics"]["first_shot_yaw_error_degrees"])
        self.assertIsNone(window["metrics"]["first_shot_pitch_error_degrees"])

    def test_round_start_clips_window_and_invalidates_full_second_metrics(self):
        parts = fixture()
        parts[3][0]["start_tick"] = 90
        _, window = calculate(parts)
        self.assertEqual(window["start_tick"], 90)
        self.assertFalse(window["coverage"]["pre_window_complete"])
        self.assertIsNone(window["metrics"]["acquisition_path_degrees"])
        self.assertIsNone(window["metrics"]["overshoot_count"])

    def test_overshoot_uses_deadband_and_requires_complete_target_path(self):
        parts = fixture()
        for row in parts[1]:
            row["yaw"] = 2 if row["tick"] < 68 else -.1 if row["tick"] < 80 else -2
        _, window = calculate(parts)
        self.assertEqual(window["metrics"]["overshoot_count"], 1)

    def test_back_facing_error_wrap_does_not_count_as_crossing_the_target(self):
        parts = fixture()
        for row in parts[1]:
            row["yaw"] = 179 if row["tick"] < 68 else -179
        _, window = calculate(parts)
        self.assertEqual(window["metrics"]["overshoot_count"], 0)

    def test_context_sampling_preserves_start_end_and_every_shot(self):
        events, _, _, rounds = fixture(fire_ticks=(100, 106, 113))
        ticks, coverage = target_sample_ticks(events, rounds, SELF, 64)
        self.assertTrue({36, 100, 106, 113, 129}.issubset(ticks))
        self.assertEqual(coverage["pre_seconds"], 1)
        self.assertEqual(coverage["post_seconds"], .25)
        self.assertEqual(coverage["sample_hz"], 32)
        self.assertEqual(coverage["interval_ticks"], 2)
        self.assertLessEqual(len(ticks), 32000)

    def test_pathological_long_burst_bounds_trajectory_but_keeps_every_shot_marker(self):
        parts = fixture(hurts=False, fire_ticks=tuple(range(100, 3700, 6)))
        parts[3][0]["end_tick"] = 4000
        _, window = calculate(parts)
        self.assertEqual(len(window["shot_markers"]), 600)
        self.assertLessEqual(len(window["points"]), 512)
        self.assertTrue(window["coverage"]["trajectory_truncated"])
        self.assertEqual(window["shot_markers"][-1][0], 3694)

    def test_windows_have_a_match_level_hard_limit_and_report_omissions(self):
        events, _, _, rounds = fixture(hurts=False, fire_ticks=tuple(range(100, 24100, 40)))
        rounds[0]["end_tick"] = 25000
        model = calculate_mechanics(events, [], [], rounds, SELF, tickrate=64)["aim_playback"]
        self.assertEqual(model["total_bursts"], 600)
        self.assertEqual(model["returned_windows"], 512)
        self.assertTrue(model["truncated"])
        self.assertEqual(len(rounds[0]["analysis"]["level3"]["mechanics"]["aim_playback"]["windows"]), 512)

    @unittest.skipUnless(os.environ.get("CS2_PUBLIC_TEST_DEMO"), "optional pinned real Valve replay")
    def test_real_demo_windows_all_firearm_bursts_and_measured_opponents(self):
        report = parse_demo(Path(os.environ["CS2_PUBLIC_TEST_DEMO"]), "76561197964020430")
        aggregate = report["analysis"]["level3"]["mechanics"]["aim_playback"]
        windows = [w for r in report["rounds"] for w in r["analysis"]["level3"]["mechanics"]["aim_playback"]["windows"]]
        self.assertEqual(len(windows), aggregate["total_bursts"])
        self.assertEqual(sum(w["shots"] for w in windows), sum(len(w["shot_markers"]) for w in windows))
        self.assertTrue(any(w["primary_target_index"] is None and w["targets"] for w in windows))
        self.assertTrue(any(w["primary_target_index"] is not None for w in windows))
        self.assertTrue(all(len(w["points"]) <= 512 for w in windows))
        json.dumps(report, allow_nan=False)


if __name__ == "__main__":
    unittest.main()
