"""L3 invariants: observable mechanics, bounded evidence, no invented LoS."""

import json
import unittest

from cs2demo.l3 import calculate_l3
from cs2demo.parser import _guard_event_velocity, DENSE_SAMPLE_FIELDS


SELF = "76561198000000000"
ENEMY = "76561197964020430"
TEAMMATE = "76561197964020431"


def round_(**kwargs):
    return {"round_number": 1, "start_tick": 0, "end_tick": 300,
            "side": "T", "deaths": 0, "traded": False,
            "opening_kill": False, "opening_death": False,
            "analysis": {"timeline": []}, **kwargs}


def event(tick, **kwargs):
    return {"tick": tick, "is_warmup_period": False, **kwargs}


def shot(tick=100, **kwargs):
    return event(tick, user_steamid=SELF, weapon="ak47", user_velocity_X=0,
                 user_velocity_Y=0, user_is_airborne=False, **kwargs)


def samples(start=68, end=100, speed=0, yaw=0):
    return [{"tick": tick, "steamid": SELF, "is_alive": True, "is_airborne": False,
             "velocity_X": speed, "velocity_Y": 0, "pitch": 0, "yaw": yaw,
             "X": speed * (tick - start) / 64, "Y": 0, "Z": 0}
            for tick in range(start, end + 1, 4)]


def one_tick_motion(start=35, end=100, speed=120, stop=97):
    """Coordinates from known displacement intervals, without parser velocity."""
    result, x = [], 0.0
    for tick in range(start, end + 1):
        if tick > start and tick <= stop:
            x += speed / 64
        result.append({"tick": tick, "steamid": SELF, "is_alive": True, "is_airborne": False,
                       "X": x, "Y": 0, "Z": 0, "pitch": 0, "yaw": 0})
    return result


class L3Tests(unittest.TestCase):
    def calculate(self, events=None, rows=None, round_data=None, **kwargs):
        rounds = [round_data or round_()]
        result = calculate_l3(events or {"weapon_fire": [shot()]}, rows if rows is not None else samples(),
                              rounds, SELF, tickrate=64, sampling={"interval_ticks": 4}, **kwargs)
        return result, rounds[0]["analysis"]["level3"]

    def test_yaw_wrap_is_two_degrees_not_358(self):
        rows = samples()
        for row in rows:
            row["yaw"] = 179 if row["tick"] < 96 else -179
        result, detail = self.calculate(rows=rows)
        self.assertAlmostEqual(result["crosshair"]["median_path_degrees"], 2, places=3)
        self.assertEqual(detail["crosshair"]["observations"][0]["trace"][-1]["offset_ms"], 0)

    def test_excess_path_measures_rotation_not_aim_error(self):
        rows = samples()
        angles = {84: 0, 88: 10, 92: 20, 96: 10, 100: 0}
        for row in rows:
            row["yaw"] = angles.get(row["tick"], 0)
        result, _ = self.calculate(rows=rows)
        self.assertEqual(result["crosshair"]["median_path_degrees"], 40)
        self.assertEqual(result["crosshair"]["median_net_turn_degrees"], 0)
        self.assertEqual(result["crosshair"]["median_excess_turn_degrees"], 40)
        self.assertIn("not target correction", result["crosshair"]["definition"])

    def test_sparse_and_wrong_identity_samples_cannot_fabricate_paths(self):
        rows = [dict(s, steamid=ENEMY) for s in samples()]
        result, _ = self.calculate(rows=rows)
        self.assertIsNone(result["crosshair"]["median_path_degrees"])
        self.assertEqual(result["coverage"]["dense_self_samples"], 0)
        result, _ = self.calculate(rows=[samples()[0], samples()[-1]])
        self.assertIsNone(result["crosshair"]["median_path_degrees"])

    def test_gaps_and_round_start_clipping_do_not_score_full_window(self):
        rows = [s for s in samples() if s["tick"] != 92]
        result, _ = self.calculate(rows=rows)
        self.assertIsNone(result["crosshair"]["median_path_degrees"])
        result, _ = self.calculate(round_data=round_(start_tick=90))
        self.assertIsNone(result["crosshair"]["median_path_degrees"])

    def test_velocity_braking_does_not_claim_keyboard_counterstrafe(self):
        rows = samples()
        x = 0
        for row in rows:
            row["velocity_X"] = 120 if row["tick"] <= 84 else 0
            x += row["velocity_X"] * 4 / 64
            row["X"] = x
        result, detail = self.calculate(rows=rows)
        self.assertEqual(result["counter_strafe"]["observed_braking_shots"], 1)
        self.assertEqual(result["counter_strafe"]["median_stop_to_shot_ms"], 187.5)
        self.assertFalse(result["counter_strafe"]["counter_strafe_input_verified"])
        self.assertIsNone(result["counter_strafe"]["counter_strafe_success_pct"])
        self.assertEqual(detail["counter_strafe"]["observations"][0]["stop_tick"], 88)

    def test_dense_motion_uses_actual_coordinate_tick_delta_not_parser_velocity(self):
        rows = samples(speed=120)
        # The pinned parser's filtered velocity can contain a 4x rate error or
        # a large previous-window displacement. Neither may enter braking.
        for row in rows:
            row["velocity_X"] = 23934.912
        result, detail = self.calculate(rows=rows)
        motion = detail["counter_strafe"]["observations"][0]
        self.assertEqual(motion["prior_peak_speed"], 120)
        self.assertEqual(result["coverage"]["dense_motion_samples"], len(rows) - 1)
        self.assertEqual(motion["speed"], 0)  # full-event shot observation
        self.assertEqual(motion["speed_source"], "event_previous_tick_position_delta_64hz")

    def test_dense_gap_and_round_boundary_are_unknown_not_cross_window_velocity(self):
        rows = samples()
        rows[0].update(tick=1, X=-100000)
        result, detail = self.calculate(rows=rows)
        self.assertIn("dense_sample_gap", result["coverage"]["dense_motion_unavailable_reasons"])
        # The pair across this discontinuity is excluded, not capped/replaced.
        observation = detail["counter_strafe"]["observations"][0]
        self.assertEqual(observation["prior_peak_speed"], 0)
        self.assertFalse(observation["window_complete"])
        self.assertEqual(observation["braking_reason"], "prior_movement_not_observed")
        rounds = [round_(end_tick=64), round_(round_number=2, start_tick=68)]
        result = calculate_l3({"weapon_fire": [shot()]}, [dict(samples()[0], tick=64), *samples()],
                              rounds, SELF, tickrate=64, sampling={"interval_ticks": 4})
        self.assertIn("round_boundary", result["coverage"]["dense_motion_unavailable_reasons"])

    def test_dense_missing_coordinates_or_living_state_cannot_use_custom_velocity(self):
        rows = samples(speed=120)
        for row in rows:
            row.pop("X")
        result, detail = self.calculate(rows=rows)
        self.assertEqual(result["coverage"]["dense_motion_samples"], 0)
        self.assertIsNone(detail["counter_strafe"]["observations"][0]["prior_peak_speed"])
        rows = samples(speed=120)
        for row in rows:
            row["is_alive"] = None
        result, _ = self.calculate(rows=rows)
        self.assertEqual(result["coverage"]["dense_motion_samples"], 0)

    def test_non64_event_custom_velocity_uses_marked_dense_average_instead(self):
        rounds = [round_()]
        result = calculate_l3({"weapon_fire": [shot()]}, samples(speed=120), rounds, SELF,
                              tickrate=128, sampling={"interval_ticks": 4})
        observation = rounds[0]["analysis"]["level3"]["counter_strafe"]["observations"][0]
        self.assertEqual(observation["speed"], 240)
        self.assertEqual(observation["speed_source"], "dense_position_interval_average")

    def test_adapter_never_requests_filtered_custom_velocity_and_guards_non64_events(self):
        self.assertNotIn("velocity_X", DENSE_SAMPLE_FIELDS)
        self.assertNotIn("velocity_Y", DENSE_SAMPLE_FIELDS)
        events = {"weapon_fire": [shot()]}
        provenance = _guard_event_velocity(events, 128)
        self.assertEqual(provenance["status"], "unavailable")
        self.assertIsNone(events["weapon_fire"][0]["user_velocity_X"])
        self.assertIsNone(events["weapon_fire"][0]["user_velocity_Y"])

    def test_airborne_or_never_moving_is_not_a_braking_observation(self):
        rows = samples(speed=0)
        result, _ = self.calculate(rows=rows)
        self.assertEqual(result["counter_strafe"]["observed_braking_shots"], 0)
        rows = samples(speed=120)
        rows[-1].update(velocity_X=0, is_airborne=True)
        airborne_shot = shot()
        airborne_shot["user_is_airborne"] = True
        result, _ = self.calculate(events={"weapon_fire": [airborne_shot]}, rows=rows)
        self.assertEqual(result["counter_strafe"]["observed_braking_shots"], 0)
        self.assertEqual(result["counter_strafe"]["braking_reason_counts"], {"airborne_at_shot": 1})

    def calculate_one_tick(self, rows=None, fire=None, round_data=None):
        rounds = [round_data or round_()]
        result = calculate_l3({"weapon_fire": [fire or shot()]}, rows if rows is not None else one_tick_motion(),
                              rounds, SELF, tickrate=64, sampling={"interval_ticks": 1, "pre_seconds": 1, "support_ticks": 1})
        return result["counter_strafe"], rounds[0]["analysis"]["level3"]["counter_strafe"]["observations"][0]

    def test_actual_shot_tick_motion_wins_over_known_lagged_event_velocity(self):
        fire = shot()
        fire["user_velocity_X"] = 120
        counter, observation = self.calculate_one_tick(rows=one_tick_motion(stop=98), fire=fire)
        self.assertEqual(observation["speed"], 0)
        self.assertEqual(observation["event_speed"], 120)
        self.assertEqual(observation["speed_source"], "dense_one_tick_position_interval_average")
        self.assertTrue(observation["event_dense_motion_disagreement"])
        self.assertEqual(observation["braking_status"], "observed")
        self.assertEqual(observation["stop_kind"], "fast_brake")
        self.assertEqual(counter["observed_fast_braking_shots"], 1)
        self.assertEqual(counter["moving_first_burst_pct"], 0)
        self.assertFalse(counter["counter_strafe_input_verified"])

    def test_low_speed_stop_is_observed_separately_without_arbitrary_80_exclusion(self):
        counter, observation = self.calculate_one_tick(rows=one_tick_motion(speed=60, stop=90))
        self.assertEqual(observation["prior_peak_speed"], 60)
        self.assertEqual(observation["stop_kind"], "slow_stop")
        self.assertEqual(observation["braking_status"], "observed")
        self.assertEqual(counter["observed_braking_shots"], 1)
        self.assertEqual(counter["observed_slow_stop_shots"], 1)
        self.assertEqual(counter["observed_fast_braking_shots"], 0)

    def test_fast_classification_uses_latest_motion_segment_not_earlier_sprint(self):
        rows = one_tick_motion()
        x = 0
        for row in rows:
            speed = 120 if row["tick"] <= 60 else 20 if 81 <= row["tick"] <= 90 else 0
            x += speed / 64
            row["X"] = x
        _, observation = self.calculate_one_tick(rows=rows)
        self.assertEqual(observation["prior_peak_speed"], 120)
        self.assertEqual(observation["transition_peak_speed"], 20)
        self.assertEqual(observation["stop_kind"], "slow_stop")

    def test_stationary_and_moving_states_are_explained_not_missing_windows(self):
        counter, observation = self.calculate_one_tick(rows=one_tick_motion(speed=0))
        self.assertTrue(observation["window_complete"])
        self.assertEqual(observation["braking_status"], "not_applicable")
        self.assertEqual(observation["braking_reason"], "already_stationary_in_lookback")
        self.assertEqual(counter["braking_status_counts"], {"not_applicable": 1})
        self.assertEqual(counter["braking_reason_counts"], {"already_stationary_in_lookback": 1})
        counter, observation = self.calculate_one_tick(rows=one_tick_motion(stop=100))
        self.assertEqual(observation["braking_reason"], "moving_at_shot")
        self.assertEqual(observation["braking_status"], "not_applicable")
        self.assertEqual(counter["moving_first_burst_pct"], 100)
        self.assertIsNone(counter["median_stop_to_shot_ms"])

    def test_one_stationary_interval_cannot_create_zero_ms_braking_score(self):
        counter, observation = self.calculate_one_tick(rows=one_tick_motion(stop=99))
        self.assertEqual(observation["stationary_interval_samples"], 1)
        self.assertEqual(observation["braking_reason"], "stop_not_sustained_before_shot")
        self.assertEqual(observation["braking_status"], "unavailable")
        self.assertIsNone(observation["stop_to_shot_ms"])
        self.assertEqual(counter["observed_braking_shots"], 0)

    def test_observed_transition_in_short_round_start_window_retains_timing_and_coverage(self):
        rows = one_tick_motion(start=80, stop=95)
        counter, observation = self.calculate_one_tick(rows=rows, round_data=round_(start_tick=80))
        self.assertFalse(observation["window_complete"])
        self.assertEqual(observation["window_reason"], "round_start_clipped")
        self.assertEqual(observation["braking_status"], "observed")
        self.assertEqual(counter["complete_movement_windows"], 0)
        self.assertEqual(counter["observed_partial_window_stops"], 1)

    def test_gap_before_observed_transition_does_not_destroy_valid_suffix(self):
        rows = one_tick_motion()
        rows = [r for r in rows if r["tick"] < 60 or r["tick"] > 75]
        counter, observation = self.calculate_one_tick(rows=rows)
        self.assertFalse(observation["window_complete"])
        self.assertEqual(observation["window_reason"], "dense_sample_gap")
        self.assertEqual(observation["braking_status"], "observed")
        self.assertEqual(observation["prior_peak_speed"], 120)
        self.assertEqual(counter["observed_partial_window_stops"], 1)

    def test_missing_position_inside_transition_cannot_bridge_to_earlier_motion(self):
        rows = one_tick_motion(stop=97)
        next(r for r in rows if r["tick"] == 98)["X"] = None
        _, observation = self.calculate_one_tick(rows=rows)
        self.assertEqual(observation["braking_status"], "unavailable")
        self.assertEqual(observation["braking_reason"], "prior_movement_not_observed")
        self.assertIsNone(observation["stop_to_shot_ms"])

    def test_braking_timing_carries_sampling_bounds_and_sustained_ground_requirement(self):
        counter, observation = self.calculate_one_tick()
        self.assertEqual(observation["stop_interval_start_tick"], 96)
        self.assertEqual(observation["stop_interval_end_tick"], 98)
        self.assertEqual(observation["stop_to_shot_ms_min"], 31.25)
        self.assertEqual(observation["stop_to_shot_ms_max"], 62.5)
        self.assertEqual(counter["sampling_uncertainty_ms"], 31.25)
        rows = one_tick_motion()
        next(r for r in rows if r["tick"] == 97)["is_airborne"] = True
        _, observation = self.calculate_one_tick(rows=rows)
        self.assertEqual(observation["braking_reason"], "airborne_during_transition")
        self.assertEqual(observation["braking_status"], "not_applicable")

    def test_flash_intervals_are_unioned_clipped_and_association_is_not_credit(self):
        blind = lambda tick, duration, victim=ENEMY, team=3: event(tick, attacker_steamid=SELF,
            user_steamid=victim, attacker_team_num=2, user_team_num=team, blind_duration=duration)
        death = event(150, attacker_steamid=TEAMMATE, user_steamid=ENEMY, attacker_team_num=2,
                      user_team_num=3, assistedflash=False, thrusmoke=False)
        events = {"player_blind": [blind(100, 1), blind(132, 1), blind(280, 1),
                                    blind(120, .5, TEAMMATE, 2)], "player_death": [death]}
        result, _ = self.calculate(events=events, rows=[])
        # Enemy intervals [100,196) and [280,300): 116/64 seconds.
        self.assertEqual(result["utility_effects"]["enemy_blind_seconds_union"], 1.812)
        self.assertEqual(result["utility_effects"]["team_blind_seconds_union"], .5)
        self.assertEqual(result["utility_effects"]["enemy_kills_during_reported_blind"], 1)
        self.assertEqual(result["utility_effects"]["flash_assists"], 0)

    def test_missing_flash_stream_is_unknown_and_smoke_flag_is_only_observed(self):
        death = event(150, attacker_steamid=SELF, user_steamid=ENEMY, attacker_team_num=2,
                      user_team_num=3, thrusmoke=True)
        result, _ = self.calculate(events={"player_death": [death]}, rows=[])
        self.assertIsNone(result["utility_effects"]["enemy_blind_seconds_union"])
        self.assertEqual(result["utility_effects"]["kills_through_smoke"], 1)
        self.assertIsNone(result["utility_effects"]["smoke_tactical_score"])

    def test_missing_blind_duration_cannot_become_perfect_friendly_flash(self):
        blind = event(100, attacker_steamid=SELF, user_steamid=TEAMMATE,
                      attacker_team_num=2, user_team_num=2, blind_duration=None)
        detonation = event(99, user_steamid=SELF)
        result, detail = self.calculate(events={"weapon_fire": [shot()], "player_blind": [blind],
                                               "flashbang_detonate": [detonation]})
        self.assertIsNone(result["utility_effects"]["team_blind_seconds_union"])
        self.assertEqual(result["utility_effects"]["blind_events_missing_duration"], 1)
        self.assertNotIn("friendly_flash_protection", [c["key"] for c in detail["decision_quality"]["components"]])
        self.assertIsNone(detail["decision_quality"]["score"])

    def test_default_visibility_is_unavailable_even_with_angles_and_positions(self):
        rows = samples()
        for row in rows:
            row.update(X=100, Y=100, Z=0, enemy_X=200, enemy_Y=100, enemy_Z=0)
        result, _ = self.calculate(rows=rows, map_identity="de_ancient")
        self.assertEqual(result["visibility"]["status"], "unavailable")
        self.assertIsNone(result["visibility"]["visible_onsets"])
        self.assertIsNone(result["preaim"]["median_deviation_degrees"])
        self.assertIsNone(result["reaction"]["median_estimated_latency_ms"])

    def test_stale_map_or_static_only_geometry_cannot_enable_visibility(self):
        class Provider:
            metadata = {"map_name": "de_test", "map_sha256": "a" * 64,
                        "geometry_sha256": "b" * 64, "geometry_version": "test",
                        "static_occlusion_verified": True, "dynamic_occlusion_verified": False,
                        "view_origin_verified": True, "target_head_verified": True, "field_of_view_verified": True,
                        "coverage_start_tick": 0, "coverage_end_tick": 300, "temporal_step_ticks": 4}
            def visibility_samples(self, *_):
                raise AssertionError("Unverified provider must never be queried")
        provider = Provider()
        identity = {"verified": True, "map_name": "de_test", "map_sha256": "a" * 64}
        result, _ = self.calculate(visibility_provider=provider, map_identity=identity)
        self.assertEqual(result["visibility"]["reason"], "visibility_provider_coverage_incomplete")
        provider.metadata = dict(provider.metadata, dynamic_occlusion_verified=True)
        identity["map_sha256"] = "c" * 64
        result, _ = self.calculate(visibility_provider=provider, map_identity=identity)
        self.assertEqual(result["visibility"]["reason"], "visibility_map_identity_not_verified")

    def test_verified_provider_requires_false_to_true_transition_and_target_association(self):
        class Provider:
            metadata = {"map_name": "de_test", "map_sha256": "a" * 64,
                        "geometry_sha256": "b" * 64, "geometry_version": "test",
                        "static_occlusion_verified": True, "dynamic_occlusion_verified": True,
                        "view_origin_verified": True, "target_head_verified": True, "field_of_view_verified": True,
                        "coverage_start_tick": 0, "coverage_end_tick": 300, "temporal_step_ticks": 4}
            def visibility_samples(self, *_):
                return [{"tick": t, "visible": t >= 80, "target_steamid": ENEMY, "target_team_num": 3,
                         "pitch": 0, "yaw": 0, "eye_x": 0, "eye_y": 0, "eye_z": 64,
                         "target_x": 100, "target_y": 0, "target_z": 64} for t in range(76, 105, 4)]
        identity = {"verified": True, "map_name": "de_test", "map_sha256": "a" * 64}
        hurt = event(101, attacker_steamid=SELF, user_steamid=ENEMY, attacker_team_num=2, user_team_num=3)
        result, _ = self.calculate(events={"weapon_fire": [shot()], "player_hurt": [hurt]},
                                  visibility_provider=Provider(), map_identity=identity)
        self.assertEqual(result["preaim"]["median_deviation_degrees"], 0)
        self.assertEqual(result["reaction"]["median_estimated_latency_ms"], 312.5)
        self.assertIn("not human reaction", result["reaction"]["definition"])

    def test_heuristic_requires_evidence_and_discloses_weighted_components(self):
        result, detail = self.calculate()
        self.assertIsNone(result["decision_quality"]["score"])
        data = round_(deaths=1, traded=True)
        result, detail = self.calculate(round_data=data)
        self.assertEqual(result["decision_quality"]["score"], 100)
        self.assertEqual(detail["decision_quality"]["available_weight"], 60)
        self.assertFalse(detail["decision_quality"]["professional_rating"])
        self.assertEqual(len(detail["decision_quality"]["components"]), 2)

    def test_output_is_strict_finite_json_and_unknowns_remain_null(self):
        rows = samples()
        rows[0]["yaw"] = float("nan")
        result, detail = self.calculate(rows=rows)
        json.dumps({"match": result, "round": detail}, allow_nan=False)
        self.assertIsNone(result["preaim"]["median_deviation_degrees"])

    def test_warmup_and_post_round_shots_do_not_enter_models(self):
        warmup = shot(100)
        warmup["is_warmup_period"] = True
        result, _ = self.calculate(events={"weapon_fire": [warmup, shot(400)]}, rows=samples())
        self.assertEqual(result["counter_strafe"]["first_burst_shots"], 0)


if __name__ == "__main__":
    unittest.main()
