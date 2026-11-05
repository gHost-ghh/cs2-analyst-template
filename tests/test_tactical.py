import json
import os
from pathlib import Path
import unittest

from cs2demo.parser import parse_demo
from cs2demo.replay import replay_ticks
from cs2demo.tactical import build_tactical

OWN = "76561197964020430"
ENEMY = "76561198000000002"
ALLY = "76561198000000003"
INDEXES = {OWN: 0, ENEMY: 1, ALLY: 2}
ROUND = {"round_number": 1, "start_tick": 100, "end_tick": 1000}


def event(tick, **extra):
    return {"tick": tick, "is_warmup_period": False, "user_steamid": OWN, "user_team_num": 2,
            "user_X": 0, "user_Y": 1, "user_Z": 2, **extra}


def effect(tick, entity=10, **extra):
    return event(tick, **{"entityid": entity, "x": 100, "y": 200, "z": 0, **extra})


def hurt(tick, *, attacker=OWN, victim=ENEMY, weapon="hegrenade", damage=30, health=70, **extra):
    return event(tick, **{"attacker_steamid": attacker, "user_steamid": victim,
                 "attacker_team_num": 2, "user_team_num": 3, "weapon": weapon, "dmg_health": damage,
                 "health": health, **extra})


def path_row(tick, *, entity=10, kind="CSmokeGrenadeProjectile", sid=OWN, **extra):
    return {"tick": tick, "grenade_entity_id": entity, "grenade_type": kind,
            "steamid": int(sid), "x": tick, "y": 2, "z": 3, **extra}


def sample(tick, sid=OWN, *, inventory=None, **extra):
    return {"tick": tick, "steamid": int(sid), "X": tick, "Y": 1, "Z": 2,
            "is_alive": True, "team_num": 2, **({"inventory": inventory} if inventory is not None else {}), **extra}


def build(events, grenades=None, samples=None, rounds=None):
    rounds, coverage = build_tactical(events, grenades or [], samples or [], rounds or [ROUND], INDEXES)
    return rounds[1], coverage


class TacticalTests(unittest.TestCase):
    def test_exact_tactical_ticks_join_sixteen_hz_and_exclude_warmup_and_postround(self):
        events = {"smokegrenade_detonate": [effect(173), effect(175, is_warmup_period=True)],
                  "inferno_expire": [effect(797)], "bomb_planted": [event(433), event(1001)]}
        ticks, coverage = replay_ticks([ROUND], events, 64)
        self.assertTrue({100, 173, 433, 797, 1000}.issubset(ticks))
        self.assertNotIn(175, ticks)
        self.assertNotIn(1001, ticks)
        self.assertEqual(coverage["sample_hz"], 16)
        self.assertEqual(coverage["exact_tactical_ticks"], 3)

    def test_persistent_effect_requires_correct_observed_expiry_and_fences_entity_reuse(self):
        events = {"smokegrenade_detonate": [effect(200), effect(600)],
                  "smokegrenade_expired": [effect(500, entity=99), effect(550, user_steamid=ENEMY), effect(800)]}
        round_, _ = build(events)
        first, second = round_["effects"]
        self.assertIsNone(first["end_tick"])
        self.assertEqual(second["end_tick"], 800)
        self.assertEqual(first["position"], [100, 200, 0])

    def test_projectile_path_keeps_observed_points_and_stops_at_detonation(self):
        grenades = [path_row(tick) for tick in range(180, 231)]
        grenades += [path_row(200, kind="CSmokeGrenade", x=float("nan")), path_row(205, entity=11, z=float("inf"))]
        round_, _ = build({"smokegrenade_detonate": [effect(211)], "smokegrenade_expired": [effect(800)]}, grenades)
        self.assertEqual(len(round_["grenades"]), 1)
        path = round_["grenades"][0]
        self.assertEqual(path["start_tick"], 180)
        self.assertEqual(path["end_tick"], 211)
        self.assertEqual(path["points"][-1], [211, 211, 2, 3])
        self.assertTrue(all(point[0] in range(180, 212) for point in path["points"]))
        self.assertEqual(path["effect_id"], round_["effects"][0]["id"])
        self.assertEqual(round_["effects"][0]["flight_id"], path["id"])
        json.dumps(round_, allow_nan=False)

    def test_reused_projectile_entity_and_fire_entity_do_not_guess_flight_links(self):
        grenades = [path_row(tick, kind="CMolotovProjectile") for tick in (180, 184, 188, 600, 604)]
        round_, _ = build({"inferno_startburn": [effect(190, entity=30)], "inferno_expire": [effect(700, entity=30)]},
                          grenades, samples=[sample(180)])
        self.assertEqual(len(round_["grenades"]), 2)
        self.assertTrue(all(row["effect_id"] is None for row in round_["grenades"]))
        self.assertIsNone(round_["effects"][0]["flight_id"])
        self.assertTrue(all(row["team"] == 2 for row in round_["grenades"]))

    def test_flash_requires_same_entity_thrower_tick_and_retains_observed_blind_interval(self):
        blind = hurt(200, weapon="flashbang", entityid=10, blind_duration=2.5)
        events = {"flashbang_detonate": [effect(200)], "player_blind": [blind, {**blind, "entityid": 11},
                  {**blind, "tick": 201}, {**blind, "attacker_steamid": ALLY}],
                  "player_death": [hurt(300, weapon="ak47"), hurt(400, weapon="ak47")]}
        round_, coverage = build(events)
        flash = round_["effects"][0]
        self.assertEqual(len(flash["impacts"]), 1)
        self.assertEqual(flash["impacts"][0]["end_tick"], 360)
        self.assertEqual(flash["summary"]["enemy_blind_seconds"], 2.5)
        self.assertEqual(flash["summary"]["kills_during_blind"], 1)
        self.assertEqual(flash["summary"]["utility_kills"], 0)
        self.assertIsNone(flash["end_tick"])
        self.assertEqual(coverage["unassociated_blind_events"], 3)

    def test_utility_damage_uses_unique_thrower_weapon_time_and_caps_remaining_hp(self):
        events = {"hegrenade_detonate": [effect(200)],
                  "player_hurt": [hurt(190, weapon="ak47", damage=80, health=20), hurt(200, damage=50, health=0)],
                  "player_death": [hurt(200, damage=50, health=0)]}
        round_, _ = build(events)
        he = round_["effects"][0]
        self.assertEqual(he["impacts"][0]["damage"], 20)
        self.assertTrue(he["impacts"][0]["lethal"])
        self.assertEqual(he["summary"]["enemy_damage"], 20)
        self.assertEqual(he["summary"]["utility_kills"], 1)
        # Two simultaneous same-owner HE detonations cannot be attributed by
        # nearest coordinates. Keep the damage event explicitly unassociated.
        events["hegrenade_detonate"].append(effect(200, entity=11, x=9999))
        ambiguous, coverage = build(events)
        self.assertTrue(all(not row["impacts"] for row in ambiguous["effects"]))
        self.assertEqual(coverage["unassociated_damage_events"], 1)

    def test_fire_damage_requires_observed_lifetime_without_persistent_guess(self):
        events = {"inferno_startburn": [effect(200)], "player_hurt": [hurt(300, weapon="inferno")]}
        round_, coverage = build(events)
        self.assertIsNone(round_["effects"][0]["end_tick"])
        self.assertEqual(round_["effects"][0]["impacts"], [])
        self.assertEqual(coverage["unassociated_damage_events"], 1)
        events["inferno_expire"] = [effect(500)]
        observed, coverage = build(events)
        self.assertEqual(observed["effects"][0]["impacts"][0]["damage"], 30)
        self.assertEqual(coverage["unassociated_damage_events"], 0)

    def test_damage_relation_distinguishes_enemy_team_self(self):
        events = {"hegrenade_detonate": [effect(200)], "player_hurt": [
            hurt(200, victim=ENEMY), hurt(200, victim=ALLY, user_team_num=2), hurt(200, victim=OWN, user_team_num=2)]}
        round_, _ = build(events)
        summary = round_["effects"][0]["summary"]
        self.assertEqual((summary["enemy_damage"], summary["team_damage"], summary["self_damage"]), (30, 30, 30))
        self.assertEqual((summary["enemy_victims"], summary["team_victims"]), (1, 1))

    def test_bomb_observed_inventory_and_absence_terminate_carrier_without_guessing(self):
        samples = [sample(100), sample(108, inventory=["C4 Explosive"]), sample(116, inventory=[]),
                   sample(124, inventory=[]), sample(132, inventory=["C4 Explosive"], is_alive=False)]
        round_, _ = build({}, samples=samples)
        self.assertEqual(round_["bomb"]["carrier_frames"], [[108, 0, 108, 1, 2], [116, None, None, None, None]])
        self.assertTrue(round_["bomb"]["carrier_position_observed"])
        no_inventory, _ = build({"bomb_pickup": [event(110)]}, samples=[sample(100), sample(120)])
        self.assertEqual(no_inventory["bomb"]["carrier_frames"], [])
        self.assertFalse(no_inventory["bomb"]["carrier_position_observed"])
        conflict, _ = build({}, samples=[sample(100, inventory=["C4 Explosive"]), sample(100, ALLY, inventory=["C4 Explosive"])])
        self.assertEqual(conflict["bomb"]["carrier_conflicts"], 1)
        self.assertIsNone(conflict["bomb"]["carrier_frames"][0][1])

    def test_bomb_timers_are_actual_terminal_events_and_positions_are_labeled(self):
        events = {"bomb_planted": [event(200, site=185)], "bomb_begindefuse": [event(600, haskit=True)],
                  "bomb_abortdefuse": [event(650)], "bomb_defused": [event(900)], "bomb_exploded": [event(1001)]}
        round_, _ = build(events)
        plant = round_["bomb"]["plants"][0]
        self.assertEqual((plant["terminal_tick"], plant["terminal_kind"]), (900, "defused"))
        self.assertEqual(plant["site"], 185)
        self.assertIn("abortdefuse", [row["kind"] for row in round_["bomb"]["events"]])
        self.assertNotIn("exploded", [row["kind"] for row in round_["bomb"]["events"]])
        del events["bomb_defused"]
        unknown, _ = build(events)
        self.assertIsNone(unknown["bomb"]["plants"][0]["terminal_tick"])

    def test_dense_bomb_carrier_positions_are_bounded_but_changes_and_events_are_exact(self):
        samples = [sample(tick, inventory=["C4 Explosive"], X=10 if tick < 112 else 20)
                   for tick in range(100, 117, 4)]
        samples += [sample(117, inventory=[]), sample(118, inventory=["C4 Explosive"], X=25)]
        round_, _ = build({"bomb_beginplant": [event(104)]}, samples=samples)
        frames = round_["bomb"]["carrier_frames"]
        self.assertEqual([row[0] for row in frames], [100, 104, 112, 117, 118])
        self.assertEqual(frames[3][1:], [None, None, None, None])
        self.assertEqual(round_["bomb"]["carrier_sample_hz"], 8)
        self.assertTrue(all(row["position_reference"] == "player_origin" for row in round_["bomb"]["events"]))

    @unittest.skipUnless(os.environ.get("CS2_PUBLIC_TEST_DEMO"), "optional pinned public demo")
    def test_real_fixture_observes_all_utility_types_and_c4_without_changing_personal_stats(self):
        result = parse_demo(Path(os.environ["CS2_PUBLIC_TEST_DEMO"]), OWN)
        self.assertEqual((result["summary"]["rounds"], result["summary"]["kills"], result["summary"]["damage"]), (9, 11, 1207))
        replay = result["replay"]
        coverage = replay["coverage"]["tactical"]
        self.assertEqual(coverage["grenade_status"], "observed")
        self.assertEqual(coverage["grenades"], 150)
        self.assertEqual(coverage["effects"], 147)
        self.assertEqual(coverage["impacts"], 125)
        self.assertEqual(coverage["bomb_events"], 27)
        tail_bomb = [event["kind"] for item in replay["rounds"]
                     for event in item["tactical"]["bomb"]["events"]
                     if event["tick"] > item["decision_tick"]]
        self.assertEqual(tail_bomb, ["beginplant", "planted"])
        self.assertEqual(coverage["unassociated_damage_events"], 0)
        self.assertEqual(coverage["unassociated_blind_events"], 0)
        effects = [e for r in replay["rounds"] for e in r["tactical"]["effects"]]
        self.assertEqual({e["kind"] for e in effects}, {"smoke", "fire", "flash", "he"})
        self.assertEqual(sum(e["end_tick"] is not None for e in effects if e["kind"] == "smoke"), 38)
        self.assertEqual(sum(e["end_tick"] is None for e in effects if e["kind"] == "smoke"), 2)
        self.assertTrue(any(r["tactical"]["bomb"]["carrier_frames"] for r in replay["rounds"]))
        self.assertLess(sum(len(json.dumps(r["tactical"], separators=(",", ":"))) for r in replay["rounds"]), 500000)
        self.assertFalse(coverage["truncated"])
        json.dumps(result, allow_nan=False)


if __name__ == "__main__":
    unittest.main()
