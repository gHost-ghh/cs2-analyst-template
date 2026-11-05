import copy
import json
import unittest

from cs2demo.advanced import ANALYSIS_VERSION, calculate_advanced
from cs2demo.metrics import calculate_metrics
from cs2demo.parser import _dense_ticks
from tests.test_demo_metrics import SELF, ALLY, ENEMY, ENEMY2, death, event, fixture, hurt


def roster(samples):
    result = copy.deepcopy(samples)
    result[0].update(current_equip_value=3700, balance=1500, armor_value=100, has_helmet=True,
                     last_place_name="TSpawn")
    members = [(ALLY, 2), ("76561198000000001", 2), ("76561198000000002", 2),
               ("76561198000000003", 2), (ENEMY, 3), (ENEMY2, 3),
               ("76561198000000004", 3), ("76561198000000005", 3), ("76561198000000006", 3)]
    for sid, team in members:
        result.append({**result[0], "steamid": int(sid), "team_num": team, "current_equip_value": 2000})
    return result


def calculate(events, samples, available=None):
    base = calculate_metrics(events, samples, SELF)
    advanced = calculate_advanced(events, samples, base["rounds"], SELF, available_events=available)
    return advanced, base["rounds"][0]["analysis"]


class AdvancedDemoTests(unittest.TestCase):
    def test_economy_snapshot_is_observed_and_team_total_requires_complete_roster(self):
        events, samples = fixture()
        samples = roster(samples)
        summary, round_ = calculate(events, samples)
        self.assertEqual(round_["economy"]["equipment_value"], 3700)
        self.assertEqual(round_["economy"]["team_equipment_value"], 11700)
        self.assertEqual(round_["economy"]["opponent_equipment_value"], 10000)
        self.assertEqual(summary["coverage"]["equipment_round_pct"], 100)
        samples[-1]["current_equip_value"] = None
        summary, round_ = calculate(events, samples)
        self.assertIsNone(round_["economy"]["opponent_equipment_value"])

    def test_utility_damage_caps_overkill_and_separates_enemy_team_and_self_flashes(self):
        events, samples = fixture()
        he = hurt(120, 300, 0)
        he["weapon"] = "hegrenade"
        events["player_hurt"] = [hurt(110, 80, 20, attacker=ALLY), he]
        def blind(tick, victim, team, duration):
            return event(tick, attacker_steamid=SELF, user_steamid=victim,
                         attacker_team_num=2, user_team_num=team, blind_duration=duration)
        events["player_blind"] = [blind(150, ENEMY, 3, 2.2), blind(150, ALLY, 2, 1.3), blind(150, SELF, 2, .5)]
        summary, round_ = calculate(events, samples)
        self.assertEqual(round_["utility"]["damage"], 20)
        self.assertEqual(summary["level2"]["utility"]["enemy_blind_seconds"], 2.2)
        self.assertEqual(round_["utility"]["team_blind_events"], 1)
        self.assertEqual(round_["utility"]["self_blind_events"], 1)
        self.assertIsNone(round_["utility"]["detonations"]["smokegrenade"])

    def test_missing_optional_stream_is_null_not_perfect_aim_or_zero_flashes(self):
        events, samples = fixture()
        summary, round_ = calculate(events, samples)
        self.assertIsNone(summary["level3"]["aim"]["firearm_shots"])
        self.assertIsNone(round_["aim"]["moving_shot_pct"])
        self.assertIsNone(round_["utility"]["enemy_blind_events"])
        self.assertEqual(summary["coverage"]["event_streams"]["weapon_fire"], "not_observed")

    def test_shot_motion_uses_observed_denominators_and_burst_boundaries(self):
        events, samples = fixture()
        def shot(tick, speed=None, weapon="weapon_ak47", airborne=False):
            return event(tick, user_steamid=SELF, weapon=weapon, user_velocity_X=speed,
                         user_velocity_Y=0 if speed is not None else None, user_is_airborne=airborne,
                         user_pitch=1, user_yaw=179)
        events["weapon_fire"] = [shot(150, 20), shot(160, 0), shot(190, None),
                                  shot(240, 30, airborne=True), shot(250, 100, "weapon_hegrenade")]
        summary, round_ = calculate(events, samples)
        aim = summary["level3"]["aim"]
        self.assertEqual(aim["firearm_shots"], 4)
        self.assertEqual(aim["shots_with_speed"], 3)
        self.assertEqual(aim["moving_shot_pct"], 66.67)
        self.assertEqual(aim["burst_first_shots_with_speed"], 2)
        self.assertEqual(aim["moving_burst_first_shot_pct"], 100)
        self.assertEqual(aim["airborne_shots"], 1)
        self.assertNotIn("accuracy", aim)
        self.assertEqual(len(round_["aim"]["shot_observations"]), 4)
        json.dumps(summary, allow_nan=False)

    def test_trade_is_once_per_kill_and_includes_window_boundary(self):
        events, samples = fixture()
        events["player_death"] = [death(150, ENEMY, ALLY, 3, 2), death(470)]
        summary, round_ = calculate(events, samples)
        self.assertEqual(summary["level2"]["trading"]["trade_kills"], 1)
        self.assertEqual(round_["trading"]["trade_kill_events"][0]["seconds_after_teammate_death"], 5)
        events["player_death"][1]["tick"] = 471
        self.assertEqual(calculate(events, samples)[0]["level2"]["trading"]["trade_kills"], 0)

    def test_clutch_requires_complete_roster_and_groups_simultaneous_deaths(self):
        events, samples = fixture()
        samples = roster(samples)
        allies = [ALLY, "76561198000000001", "76561198000000002", "76561198000000003"]
        events["player_death"] = [death(200 + i, ENEMY, sid, 3, 2) for i, sid in enumerate(allies)]
        summary, round_ = calculate(events, samples)
        self.assertEqual(round_["clutch"]["opponents"], 5)
        self.assertEqual(summary["level2"]["clutches"]["wins"], 1)
        events["player_death"].append(death(203, ENEMY, SELF, 3, 2))
        self.assertIsNone(calculate(events, samples)[1]["clutch"])
        events["player_death"].pop()
        self.assertIsNone(calculate(events, samples[:-1])[1]["clutch"])

    def test_position_distance_and_spacing_do_not_use_other_players_as_target(self):
        events, samples = fixture()
        samples[0]["last_place_name"] = "TSpawn"
        samples.append({**samples[0], "tick": 228, "X": 15.5, "Y": -16, "last_place_name": "Middle"})
        samples.append({**samples[0], "steamid": int(ALLY), "X": 1312.5})
        samples.append({**samples[1], "steamid": int(ALLY), "X": 115.5})
        summary, round_ = calculate(events, samples)
        positions = summary["level3"]["positioning"]
        self.assertEqual(positions["sampled_distance_units"], 5)
        self.assertEqual(positions["teammate_distance_samples"], 2)
        self.assertEqual(positions["median_nearest_teammate_units"], 700)
        self.assertEqual(positions["separated_sample_pct"], 50)
        self.assertEqual(round_["positioning"]["place_samples"], {"TSpawn": 1, "Middle": 1})

    def test_exchange_win_rate_excludes_mixed_and_unresolved_observations(self):
        events, samples = fixture()
        events["player_hurt"] = [hurt(120, 50, 50), hurt(130, 50, 0),
                                 hurt(400, 20, 80, victim=ENEMY2),
                                 hurt(410, 30, 70, attacker=ENEMY, victim=SELF, attacker_team=3, victim_team=2)]
        events["player_death"] = [death(130), death(420, ENEMY, SELF, 3, 2)]
        summary, round_ = calculate(events, samples)
        exchanges = summary["level2"]["engagements"]
        self.assertEqual(exchanges["single_opponent_wins"], 1)
        self.assertEqual(exchanges["single_opponent_win_pct"], 100)
        self.assertEqual(exchanges["mixed_opponent_episodes"], 1)
        self.assertEqual(round_["engagements"][0]["damage_dealt"], 100)
        self.assertEqual(summary["level2"]["opening_conversion"]["win_pct_after_opening_kill"], 100)

    def test_utility_kills_do_not_masquerade_as_firearm_duel_wins(self):
        events, samples = fixture()
        events["player_death"] = [death(130, weapon="hegrenade")]
        summary, round_ = calculate(events, samples)
        self.assertEqual(summary["level2"]["engagements"]["observed_episodes"], 0)
        self.assertIsNone(summary["level2"]["engagements"]["single_opponent_win_pct"])

    def test_modern_named_and_legacy_numeric_hitgroups_are_both_supported(self):
        events, samples = fixture()
        events["player_hurt"] = [{**hurt(130, 10, 90), "hitgroup": "head"},
                                 {**hurt(150, 10, 80), "hitgroup": 1},
                                 {**hurt(170, 10, 70), "hitgroup": "chest"}]
        summary, round_ = calculate(events, samples)
        self.assertEqual(summary["level3"]["aim"]["head_hurt_events"], 2)
        self.assertEqual(summary["level3"]["aim"]["firearm_hurt_events_with_hitgroup"], 3)
        self.assertEqual(round_["timeline"][0]["hitgroup"], "head")

    def test_death_cells_include_exact_event_position_but_never_claim_sparse_risk_grade(self):
        events, samples = fixture()
        events["player_death"] = [death(300, ENEMY, SELF, 3, 2, user_X=-500, user_Y=400, user_Z=12)]
        summary, round_ = calculate(events, samples)
        self.assertEqual(round_["positioning"]["death_positions"][0]["x"], -500)
        cell = next(c for c in summary["level3"]["positioning"]["hotspots"] if c["deaths"])
        self.assertEqual(cell["x"], -512)
        self.assertEqual(cell["deaths_per_100_observed_round_visits"], 100)
        self.assertEqual(cell["sample_status"], "insufficient_sample")

    def test_dense_crosshair_ticks_are_bounded_to_live_window_and_keep_exact_shots(self):
        events, _ = fixture()
        events["weapon_fire"] = [event(tick, user_steamid=SELF, weapon="weapon_ak47") for tick in (110, 160, 990)]
        ticks, sampling = _dense_ticks(events, [{"start_tick": 100, "end_tick": 1000}], SELF, 64)
        self.assertEqual(min(ticks), 100)
        self.assertLessEqual(max(ticks), 1000)
        self.assertTrue({110, 160, 990}.issubset(ticks))
        self.assertEqual(sampling["selected_bursts"], 3)
        self.assertFalse(sampling["truncated"])


if __name__ == "__main__":
    unittest.main()
