import base64
import gzip
import json
import os
from pathlib import Path
import tempfile
import unittest

from cs2demo.dashboard import generate_dashboard
from cs2demo.parser import _dense_ticks, parse_demo
from cs2demo.replay import build_replay, replay_ticks, replay_windows, PLAYER_FIELDS
from tests.test_demo_dashboard import match_record, round_record, write_json, SID, fixture_id


ALLY = "76561198000000001"
ENEMY = "76561198000000002"


def event(tick, **extra):
    return {"tick": tick, "is_warmup_period": False, **extra}


def kill(tick, attacker=SID, victim=ENEMY, weapon="ak47", **extra):
    return event(tick, attacker_steamid=attacker, user_steamid=victim,
                 attacker_name="Self" if attacker == SID else "Other",
                 user_name="Self" if victim == SID else "Other",
                 attacker_team_num=2 if attacker == SID else 3,
                 user_team_num=2 if victim == SID else 3,
                 attacker_X=10, attacker_Y=20, attacker_Z=5,
                 user_X=30, user_Y=40, user_Z=6,
                 user_yaw=90, user_pitch=2, weapon=weapon, headshot=True, **extra)


def state(tick, sid, x, *, alive=True):
    return {"tick": tick, "steamid": int(sid), "name": "Self" if sid == SID else "Other",
            "team_num": 2 if sid == SID else 3, "is_alive": alive,
            "X": x, "Y": 20, "Z": 5, "yaw": 90, "pitch": 2}


def decode(round_):
    encoded = round_["frames"]
    raw = gzip.decompress(base64.b64decode(encoded["data"]))
    assert len(raw) == encoded["decoded_bytes"]
    frames = json.loads(raw)
    assert len(frames) == encoded["count"]
    return frames


class DemoReplayTests(unittest.TestCase):
    def test_tail_uses_actual_next_prestart_without_changing_official_rounds(self):
        rounds = [round_record(1, start_tick=100, end_tick=300), round_record(2, start_tick=600, end_tick=800)]
        original = json.loads(json.dumps(rounds))
        events = {"round_prestart": [event(400), event(900)],
                  "round_start": [event(401), event(901)],
                  "round_officially_ended": [event(350), event(900)]}
        windows = replay_windows(rounds, events, recording_end_tick=1000)
        self.assertEqual(rounds, original)
        self.assertEqual([(r["decision_tick"], r["playback_end_tick"]) for r in windows], [(300, 399), (800, 899)])
        self.assertEqual(windows[0]["playback_end_source"], "round_prestart")
        self.assertEqual(windows[0]["phases"], [{"phase": "live", "start_tick": 100, "end_tick": 300},
                                               {"phase": "post_round", "start_tick": 301, "end_tick": 399}])
        ticks, _ = replay_ticks(rounds, events, 64, recording_end_tick=1000)
        self.assertTrue({300, 301, 399, 800, 801, 899}.issubset(ticks))
        self.assertNotIn(400, ticks)
        self.assertFalse(set(range(400, 600)) & set(ticks))

    def test_tail_fallbacks_use_observed_boundaries_or_actual_recording_end(self):
        rounds = [round_record(start_tick=100, end_tick=300)]
        self.assertEqual(replay_windows(rounds, {"round_start": [event(400)]})[0]["end_tick"], 399)
        self.assertEqual(replay_windows(rounds, {"round_officially_ended": [event(450)]})[0]["end_tick"], 449)
        final = replay_windows(rounds, {}, recording_end_tick=430)[0]
        self.assertEqual((final["end_tick"], final["playback_end_source"]), (430, "recording_end"))
        self.assertEqual(replay_windows(rounds, {})[0]["end_tick"], 300)
        incomplete_next = replay_windows(rounds, {"round_freeze_end": [event(500)]}, recording_end_tick=1000)[0]
        self.assertEqual(incomplete_next["end_tick"], 300)
        self.assertEqual(replay_windows(rounds, {"round_prestart": [event(400, is_warmup_period=True)]})[0]["end_tick"], 300)

    def test_post_round_kills_damage_and_c4_survive_but_decision_survivors_stay_fixed(self):
        ids = [SID] + [str(int(ENEMY) + i) for i in range(9)]
        events = {"round_end": [event(300, winner="CT", reason="time_ran_out")],
                  "round_prestart": [event(500)],
                  "player_death": [kill(350, attacker=ids[5], victim=SID), kill(500)],
                  "weapon_fire": [event(350, user_steamid=ids[5], weapon="ak47"), event(500, user_steamid=SID, weapon="ak47")],
                  "player_hurt": [event(350, attacker_steamid=ids[5], user_steamid=SID, weapon="ak47", dmg_health=100, health=0)],
                  "bomb_planted": [event(200, user_steamid=SID, user_X=10, user_Y=20, user_Z=5)],
                  "bomb_exploded": [event(400, user_steamid=SID, user_X=10, user_Y=20, user_Z=5)]}
        samples = [{**state(tick, sid, i*30 + (tick-100)/10, alive=not(i==0 and tick>=350)),
                    "team_num": 2 if i<5 else 3, "health": 0 if i==0 and tick>=350 else 100}
                   for tick in (100, 300, 350, 400, 499, 500) for i, sid in enumerate(ids)]
        ticks, _ = replay_ticks([round_record(start_tick=100, end_tick=300)], events, 64)
        self.assertTrue({300, 301, 350, 400, 499}.issubset(ticks))
        self.assertNotIn(500, ticks)
        replay = build_replay(events, samples, [round_record(start_tick=100, end_tick=300)], [], SID)
        round_ = replay["rounds"][0]
        self.assertEqual(round_["decision_tick"], 300)
        self.assertEqual(round_["end_tick"], 499)
        self.assertEqual(round_["result"]["survivors"]["T"]["count"], 5)
        self.assertEqual(round_["result"]["decision_tick"], 300)
        self.assertEqual(round_["kills"][0]["phase"], "post_round")
        self.assertEqual(round_["shots"][0]["phase"], "post_round")
        self.assertEqual(round_["damage_events"][0]["phase"], "post_round")
        self.assertEqual(len(round_["kills"]), 1)
        self.assertEqual(round_["tactical"]["bomb"]["plants"][0]["terminal_tick"], 400)
        frames = decode(round_)
        self.assertEqual(frames[-1][0], 499)
        self.assertEqual(frames[-1][1][0][6:9:2], [0, 0])
        self.assertGreater(frames[-1][1][1][1], frames[1][1][1][1])
        self.assertGreater(replay["coverage"]["post_round_frames"], 0)

    def test_sampling_is_sixteen_hz_and_includes_exact_kills_and_round_boundaries(self):
        rounds = [round_record(start_tick=100, end_tick=740)]
        events = {"player_death": [kill(169), kill(171, is_warmup_period=True)]}
        ticks, sampling = replay_ticks(rounds, events, 64)
        self.assertTrue({100, 169, 740}.issubset(ticks))
        self.assertNotIn(171, ticks)
        self.assertEqual(sampling["sample_hz"], 16)
        self.assertEqual(sampling["interval_ticks"], 4)
        self.assertFalse(sampling["truncated"])

    def test_long_game_sampling_is_bounded_and_keeps_all_kill_ticks(self):
        rounds = [round_record(1, start_tick=100, end_tick=10000), round_record(2, start_tick=11000, end_tick=18000)]
        events = {"player_death": [kill(169), kill(15001), kill(15002)]}
        ticks, sampling = replay_ticks(rounds, events, 64, max_frames=12)
        self.assertLessEqual(len(ticks), 12)
        self.assertTrue({100, 10000, 11000, 18000, 169, 15001, 15002}.issubset(ticks))
        self.assertTrue(sampling["truncated"])
        self.assertLess(sampling["sample_hz"], 8)

    def test_all_players_continue_after_self_death_and_dead_pose_is_frozen(self):
        rounds = [round_record(start_tick=100, end_tick=300)]
        events = {"player_death": [kill(169, attacker=ENEMY, victim=SID)]}
        samples = [state(100, SID, 0), state(100, ENEMY, 100),
                   state(169, SID, 500, alive=False), state(169, ENEMY, 120),
                   state(300, SID, 9999, alive=False), state(300, ENEMY, 180)]
        replay = build_replay(events, samples, rounds, [], SID, tickrate=64,
                              sampling={"sample_hz": 8, "interval_ticks": 8})
        frames = decode(replay["rounds"][0])
        self.assertEqual(replay["player_fields"], PLAYER_FIELDS)
        self.assertEqual(len(replay["players"]), 2)
        own = next(player["index"] for player in replay["players"] if player["steamid"] == SID)
        enemy = next(player["index"] for player in replay["players"] if player["steamid"] == ENEMY)
        final = {row[0]: row for row in frames[-1][1]}
        self.assertEqual(final[own][1:4], [30, 40, 6])
        self.assertEqual(final[own][6], 0)
        self.assertEqual(final[enemy][1], 180)
        self.assertEqual(final[enemy][6], 1)
        self.assertEqual(frames[-1][0], 300)

    def test_simultaneous_all_player_kills_have_distinct_ids_and_direction_is_not_ballistic(self):
        rounds = [round_record(start_tick=100, end_tick=300)]
        events = {"player_death": [kill(169), kill(169, attacker=ENEMY, victim=ALLY)]}
        samples = [state(tick, sid, index * 30) for tick in (100, 169, 300) for index, sid in enumerate((SID, ALLY, ENEMY))]
        replay = build_replay(events, samples, rounds, [], SID)
        kills = replay["rounds"][0]["kills"]
        self.assertEqual(len(kills), 2)
        self.assertEqual(len({row["id"] for row in kills}), 2)
        self.assertNotEqual(kills[0]["attacker_index"], kills[1]["attacker_index"])
        self.assertEqual(kills[0]["kill_direction"]["kind"], "killer_victim_connection")
        self.assertFalse(kills[0]["kill_direction"]["ballistic_path_verified"])
        self.assertEqual(kills[0]["bullet_impacts"], [])
        self.assertTrue(all(row["frame_observed"] for row in kills))

    def test_missing_parser_kill_frame_is_disclosed_instead_of_invented(self):
        rounds = [round_record(start_tick=100, end_tick=300)]
        replay = build_replay({"player_death": [kill(169)]}, [state(100, SID, 0)], rounds, [], SID)
        self.assertEqual(replay["status"], "partial")
        self.assertEqual(replay["coverage"]["missing_kill_ticks"], [169])
        self.assertFalse(replay["rounds"][0]["kills"][0]["frame_observed"])
        self.assertNotIn(169, {row[0] for row in decode(replay["rounds"][0])})

    def test_impacts_require_same_shooter_tick_and_firearm_without_claiming_victim_hit(self):
        impact = event(169, user_steamid=SID, user_name="Self", x=100, y=200, z=20,
                       user_X=10, user_Y=20, user_Z=5)
        events = {"player_death": [kill(169), kill(200, weapon="hegrenade"),
                                  kill(240, attacker=SID, victim=SID)],
                  "bullet_impact": [impact, {**impact, "tick": 168}, {**impact, "user_steamid": ENEMY},
                                    {**impact, "tick": 200}, {**impact, "tick": 240}]}
        rounds = [round_record(start_tick=100, end_tick=300)]
        samples = [state(100, SID, 0), state(100, ENEMY, 100)]
        replay = build_replay(events, samples, rounds, [], SID)
        kills = replay["rounds"][0]["kills"]
        self.assertEqual(len(kills[0]["bullet_impacts"]), 1)
        observed = kills[0]["bullet_impacts"][0]
        self.assertEqual(observed["position"], [100, 200, 20])
        self.assertEqual(observed["association"], "same_shooter_same_tick")
        self.assertFalse(observed["victim_hit_verified"])
        self.assertFalse(observed["muzzle_origin_verified"])
        for row in kills[1:]:
            self.assertEqual(row["bullet_impacts"], [])
            self.assertIsNone(row["kill_direction"])

    def test_all_firearm_shots_keep_observed_impacts_without_requiring_a_kill(self):
        fire = event(131, user_steamid=ENEMY, user_name="Enemy", weapon="weapon_nova",
                     user_X=30, user_Y=40, user_Z=6)
        impact = event(131, user_steamid=ENEMY, user_name="Enemy", x=50, y=60, z=70,
                       user_X=30, user_Y=40, user_Z=6)
        events = {"weapon_fire": [fire, {**fire, "tick": 141, "weapon": "hegrenade"},
                                  {**fire, "tick": 151, "weapon": "ak47"}],
                  "bullet_impact": [impact, {**impact, "x": 55}, {**impact, "tick": 132}],
                  "player_hurt": [event(131, attacker_steamid=ENEMY, user_steamid=SID,
                                        weapon="nova", dmg_health=28, health=72, armor=60, hitgroup="chest")]}
        rounds = [round_record(start_tick=100, end_tick=300)]
        samples = [state(100, sid, i * 30) for i, sid in enumerate((SID, ENEMY))]
        replay = build_replay(events, samples, rounds, [], SID)
        shots = replay["rounds"][0]["shots"]
        self.assertEqual(len(shots), 2)
        self.assertEqual(shots[0]["origin"], [30, 40, 6])
        self.assertEqual(shots[0]["origin_reference"], "observed_player_origin")
        self.assertEqual([row["position"][0] for row in shots[0]["impacts"]], [50, 55])
        self.assertEqual(shots[0]["hurts"][0]["health"], 72)
        self.assertEqual(shots[1]["impacts"], [])
        orphan = replay["rounds"][0]["unassociated_impacts"][0]
        self.assertEqual(orphan["tick"], 132)
        self.assertEqual(orphan["association"], "no_matching_fire_event")
        self.assertFalse(replay["coverage"]["penetration_order_verified"])
        self.assertEqual(replay["coverage"]["observed_shots"], 2)
        ticks, sampling = replay_ticks(rounds, events, 64)
        self.assertTrue({131, 132, 151}.issubset(ticks))
        self.assertEqual(sampling["requested_shot_impact_health_ticks"], 3)

    def test_ambiguous_same_tick_fires_do_not_duplicate_pellets_or_invent_a_muzzle(self):
        fire = event(131, user_steamid=SID, user_name="Self", weapon="ak47")
        impact = event(131, user_steamid=SID, user_name="Self", x=50, y=60, z=70)
        events = {"weapon_fire": [fire, fire], "bullet_impact": [impact]}
        replay = build_replay(events, [state(100, SID, 0)], [round_record(start_tick=100, end_tick=300)], [], SID)
        round_ = replay["rounds"][0]
        self.assertTrue(all(not shot["impacts"] for shot in round_["shots"]))
        self.assertEqual(len(round_["unassociated_impacts"]), 1)
        self.assertIsNone(round_["unassociated_impacts"][0]["origin"])
        self.assertEqual(round_["unassociated_impacts"][0]["association"], "ambiguous_same_tick")
        self.assertEqual(replay["coverage"]["ambiguous_bullet_impacts"], 1)

    def test_network_fire_telemetry_supplies_observed_origin_and_separate_direction(self):
        fire = event(131, user_steamid=SID, user_name="Self", weapon="ak47", user_X=1, user_Y=2, user_Z=3)
        network = {"tick": 131, "user_steamid": SID, "origin_x": 1.5, "origin_y": 2.5, "origin_z": 67,
                   "angles_x": -3, "angles_y": 92, "angles_z": 0, "spread": .004, "inaccuracy": .012,
                   "seed": 4087024135, "recoil_index": 2, "num_bullets_remaining": 28, "item_def_index": 7}
        impact = event(131, user_steamid=SID, x=50, y=60, z=70, user_X=1, user_Y=2, user_Z=3)
        events = {"weapon_fire": [fire], "fire_bullets": [network], "bullet_impact": [impact]}
        replay = build_replay(events, [state(100, SID, 0)], [round_record(start_tick=100, end_tick=300)], [], SID)
        shot = replay["rounds"][0]["shots"][0]
        self.assertEqual(shot["origin"], [1.5, 2.5, 67])
        self.assertEqual(shot["origin_reference"], "observed_fire_origin")
        self.assertEqual(shot["direction"], {"pitch": -3, "yaw": 92, "roll": 0, "source": "fire_bullets"})
        self.assertEqual(shot["seed"], 4087024135)
        self.assertEqual(shot["impacts"][0]["origin"], shot["origin"])
        duplicate = build_replay({**events, "fire_bullets": [network, network]}, [state(100, SID, 0)],
                                 [round_record(start_tick=100, end_tick=300)], [], SID)
        ambiguous = duplicate["rounds"][0]["shots"][0]
        self.assertIsNone(ambiguous["direction"])
        self.assertEqual(ambiguous["origin_reference"], "observed_player_origin")

    def test_health_and_armor_are_observed_for_each_player_and_missing_values_stay_null(self):
        samples = [{**state(100, SID, 0), "health": 72, "armor_value": 60},
                   {**state(100, ENEMY, 100), "health": 100, "armor_value": 100},
                   state(108, SID, 5), {**state(108, ENEMY, 120, alive=False), "health": 0, "armor_value": 90}]
        replay = build_replay({}, samples, [round_record(start_tick=100, end_tick=300)], [], SID)
        frames = decode(replay["rounds"][0])
        self.assertEqual(frames[0][1][0][8:], [72, 60])
        self.assertEqual(frames[0][1][1][8:], [100, 100])
        self.assertEqual(frames[1][1][0][8:], [None, None])
        self.assertEqual(frames[1][1][1][8:], [0, 90])
        self.assertEqual(replay["coverage"]["health_observed_rows"], 3)

    def test_shot_frame_budget_preserves_kills_and_reports_missing_exact_shot_ticks(self):
        rounds = [round_record(start_tick=100, end_tick=300)]
        events = {"player_death": [kill(169)],
                  "weapon_fire": [event(tick, user_steamid=SID, weapon="ak47") for tick in range(110, 200)]}
        ticks, sampling = replay_ticks(rounds, events, 64, max_frames=12)
        self.assertLessEqual(len(ticks), 12)
        self.assertTrue({100, 169, 300}.issubset(ticks))
        self.assertTrue(sampling["shot_ticks_truncated"])
        self.assertLess(sampling["exact_shot_impact_health_ticks"], sampling["requested_shot_impact_health_ticks"])

    def test_round_result_uses_exact_reason_and_complete_ten_player_end_census(self):
        ids = [SID] + [str(int(ENEMY) + i) for i in range(9)]
        samples = [{**state(300, sid, i * 30, alive=i % 3 != 0), "team_num": 2 if i < 5 else 3}
                   for i, sid in enumerate(ids)]
        # Dead players need an actual earlier living point to remain displayable.
        samples += [{**state(100, sid, i * 30), "team_num": 2 if i < 5 else 3} for i, sid in enumerate(ids)]
        rounds = [round_record(start_tick=100, end_tick=300)]
        events = {"round_end": [event(300, winner="CT", reason="bomb_defused")]}
        replay = build_replay(events, samples, rounds, [], SID)
        result = replay["rounds"][0]["result"]
        self.assertEqual((result["winner"], result["reason_code"], result["reason"]), (3, 7, "bomb_defused"))
        self.assertEqual(result["survivor_status"], "observed")
        self.assertEqual(result["survivors"]["T"]["count"], 3)
        self.assertEqual(result["survivors"]["CT"]["count"], 3)
        incomplete = build_replay(events, [row for row in samples if str(row["steamid"]) != ids[-1]], rounds, [], SID)
        self.assertIsNone(incomplete["rounds"][0]["result"]["survivors"])

    def test_gzip_payload_over_display_text_limit_survives_dashboard_export(self):
        rounds = [round_record(start_tick=100, end_tick=10000)]
        samples = [state(tick, sid, (tick * 17.31 + index * 123) % 9999)
                   for tick in range(100, 10001, 8) for index, sid in enumerate((SID, ALLY, ENEMY))]
        replay = build_replay({}, samples, rounds, [], SID)
        encoded = replay["rounds"][0]["frames"]["data"]
        self.assertGreater(len(encoded), 4000)
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            write_json(root / "data/demo_jobs.json", {"schema_version": 1, "steamid64": SID,
                       "jobs": {fixture_id("own"): {"status": "complete", "source": "local_file", "result_path": "demo_matches/own.json"}}})
            write_json(root / "data/demo_matches/own.json", match_record("own", rounds, replay=replay))
            result = generate_dashboard(root / "data", root / "reports", SID)
            exported = result["matches"][0]["replay"]
            self.assertEqual(exported["rounds"][0]["frames"]["data"], encoded)
            self.assertEqual(decode(exported["rounds"][0]), decode(replay["rounds"][0]))

    def test_dense_braking_lookback_has_one_predecessor_and_exact_one_tick_samples(self):
        events = {"weapon_fire": [event(300, user_steamid=SID, weapon="ak47")]}
        ticks, sampling = _dense_ticks(events, [{"start_tick": 100, "end_tick": 500}], SID, 64)
        self.assertEqual(min(ticks), 235)
        self.assertTrue(set(range(235, 317)).issubset(ticks))
        self.assertEqual(sampling["interval_ticks"], 1)
        self.assertEqual(sampling["pre_seconds"], 1)
        self.assertEqual(sampling["support_ticks"], 1)

    @unittest.skipUnless(os.environ.get("CS2_PUBLIC_TEST_DEMO"), "optional public Demo fixture")
    def test_real_public_demo_has_full_round_all_player_frames_and_all_kills(self):
        result = parse_demo(Path(os.environ["CS2_PUBLIC_TEST_DEMO"]), "76561197964020430")
        replay = result["replay"]
        self.assertEqual(replay["sample_hz"], 16)
        self.assertEqual(len(replay["players"]), 10)
        self.assertGreater(replay["coverage"]["observed_kills"], result["summary"]["kills"])
        self.assertLessEqual(replay["coverage"]["observed_frames"], 40000)
        self.assertGreater(replay["coverage"]["post_round_frames"], 1000)
        self.assertEqual(sum(kill["phase"] == "post_round" for round_ in replay["rounds"]
                             for kill in round_["kills"]), 2)
        for round_ in replay["rounds"]:
            ticks = {row[0] for row in decode(round_)}
            self.assertTrue({row["tick"] for row in round_["kills"]}.issubset(ticks))
            self.assertEqual(round_["decision_tick"], next(row["end_tick"] for row in result["rounds"]
                                                           if row["round_number"] == round_["round_number"]))
            self.assertEqual(round_["playback_end_tick"], round_["next_round_start_tick"] - 1)
            self.assertEqual(round_["playback_end_tick"] - round_["decision_tick"], 447)
            self.assertIn(round_["playback_end_tick"], ticks)
        self.assertLess(len(json.dumps(replay, separators=(",", ":"))), 4 * 1024 * 1024)


if __name__ == "__main__":
    unittest.main()
