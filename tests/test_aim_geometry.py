"""Recorded posture, perspective, and actual hitgroups stay distinguishable."""
import copy
import json
import math
import unittest

from cs2demo.aim_geometry import (
    BODY_ROTATION_FIELD, body_yaw, camera_basis, enrich_aim_window,
    project_body_reference, project_world, reference_eye, recorded_fire_origins,
)
from cs2demo.mechanics import calculate_mechanics

SELF = "76561198000000000"
ENEMY = "76561197964020430"
OTHER = "76561197964020431"


def player(sid=SELF, tick=100, **changes):
    return {"tick": tick, "steamid": sid, "X": 0, "Y": 0, "Z": 0,
            "yaw": 0, "pitch": 0, "is_alive": True, "is_airborne": False,
            "duck_amount": 0, BODY_ROTATION_FIELD: [0, 180, 0], **changes}


def window():
    return {"points": [[100, 0, 0, 0, 0, 0], [104, 0, 0, 0, 0, 0]],
            "targets": [{"steamid": ENEMY, "points": [[100, 0, 0, 1000, 0, 0], [104, 0, 0, 1000, 0, 0]]}],
            "primary_target_index": 0, "shot_markers": [[100, 1, True, 20, [0], 0, [1]]]}


class CameraProjectionTests(unittest.TestCase):
    def test_source_camera_screen_axes_and_pitch(self):
        eye = (0, 0, 64)
        self.assertEqual(project_world((100, 0, 64), eye, 0, 0)["x"], 0)
        self.assertLess(project_world((100, 10, 64), eye, 0, 0)["x"], 0)
        self.assertGreater(project_world((100, -10, 64), eye, 0, 0)["x"], 0)
        self.assertGreater(project_world((100, 0, 74), eye, 0, 0)["y"], 0)
        down = project_world((100, 0, -36), eye, 0, 45)
        self.assertAlmostEqual(down["x"], 0)
        self.assertAlmostEqual(down["y"], 0)
        left = project_world((0, 100, 64), eye, 90, 0)
        self.assertAlmostEqual(left["x"], 0)

    def test_common_focal_projection_preserves_distance_scale(self):
        near = project_world((100, 10, 74), (0, 0, 64), 0, 0)
        far = project_world((200, 10, 74), (0, 0, 64), 0, 0)
        self.assertAlmostEqual(near["x"], far["x"] * 2)
        self.assertAlmostEqual(near["y"], far["y"] * 2)
        for yaw, pitch in ((0, 0), (90, 45), (-179, -89)):
            basis = camera_basis(yaw, pitch)
            for vector in basis:
                self.assertAlmostEqual(sum(v * v for v in vector), 1)
            self.assertAlmostEqual(sum(a * b for a, b in zip(basis[0], basis[1])), 0)

    def test_behind_near_plane_nonfinite_and_missing_points_are_gaps(self):
        for point in ((-100, 0, 0), (1, 0, 0), (0, 100, 0), (math.nan, 0, 0), None):
            self.assertIsNone(project_world(point, (0, 0, 64), 0, 0))
        self.assertIsNone(project_world((100, 0, 0), (0, 0, 64), None, 0))
        self.assertIsNone(project_world((100, 0, 0), (0, 0, 64), 0, 0, near=0))

    def test_duck_transition_changes_reference_eye_not_world_origin(self):
        self.assertEqual(reference_eye(player()), (0, 0, 64))
        self.assertEqual(reference_eye(player(duck_amount=.5)), (0, 0, 55))
        self.assertEqual(reference_eye(player(duck_amount=1, Z=200)), (0, 0, 246))
        for duck in (None, -1, 2, True, math.nan):
            self.assertIsNone(reference_eye(player(duck_amount=duck)))

    def test_actual_body_rotation_is_not_replaced_by_eye_yaw(self):
        self.assertEqual(body_yaw(player(**{BODY_ROTATION_FIELD: [0, 270, 0]})), -90)
        self.assertIsNone(body_yaw(player(yaw=90, **{BODY_ROTATION_FIELD: None})))
        self.assertIsNone(body_yaw(player(**{BODY_ROTATION_FIELD: [0, math.nan, 0]})))

    def test_body_projection_has_region_contours_and_observed_facing(self):
        target = player(ENEMY, X=1000)
        result = project_body_reference(player(), target)
        self.assertEqual(result["status"], "reference")
        self.assertFalse(result["exact_animation"])
        self.assertFalse(result["visibility_verified"])
        self.assertEqual(result["eye_height_source"], "stance_reference")
        self.assertIn("head", result["regions"])
        self.assertIn("left_leg", result["regions"])
        self.assertTrue(all(len(points) >= 3 for points in result["regions"].values()))
        head_up = max(point[1] for point in result["regions"]["head"])
        torso_up = max(point[1] for point in result["regions"]["stomach"])
        self.assertGreater(head_up, torso_up)
        # Profile remains a finite reference volume rather than collapsing to
        # a line, but is visibly narrower than the front-facing torso.
        profile = project_body_reference(player(), dict(target, **{BODY_ROTATION_FIELD: [0, 90, 0]}))
        def width(points):
            return max(p[0] for p in points) - min(p[0] for p in points)
        self.assertGreater(width(profile["regions"]["chest"]), 0)
        self.assertLess(width(profile["regions"]["chest"]), width(result["regions"]["chest"]))
        # Anatomical sides follow the target, not the viewer: facing away at
        # yaw 0, the target's left (+Y) is on the viewer's screen left.
        away = project_body_reference(player(), dict(target, **{BODY_ROTATION_FIELD: [0, 0, 0]}))
        mean_x = lambda points: sum(point[0] for point in points) / len(points)
        self.assertLess(mean_x(away["regions"]["left_arm"]), mean_x(away["regions"]["right_arm"]))
        self.assertGreater(mean_x(result["regions"]["left_arm"]), mean_x(result["regions"]["right_arm"]))

    def test_crouch_and_elevation_move_regions_without_inventing_gait(self):
        standing = project_body_reference(player(), player(ENEMY, X=1000))
        crouched = project_body_reference(player(), player(ENEMY, X=1000, duck_amount=1))
        raised = project_body_reference(player(), player(ENEMY, X=1000, Z=100))
        top = lambda result: max(p[1] for p in result["regions"]["head"])
        self.assertLess(top(crouched), top(standing))
        self.assertGreater(top(raised), top(standing))
        missing = project_body_reference(player(), player(ENEMY, X=1000, duck_amount=None))
        self.assertEqual(missing["status"], "unavailable")
        behind = project_body_reference(player(), player(ENEMY, X=-1000))
        self.assertEqual(behind["status"], "out_of_view")


class AimGeometryEvidenceTests(unittest.TestCase):
    def test_exact_tick_camera_pose_and_per_victim_hit_location(self):
        own = [player(tick=100), player(tick=104, duck_amount=.5)]
        enemies = [player(ENEMY, tick=100, X=1000), player(ENEMY, tick=104, X=1000, duck_amount=1)]
        hurt = {"tick": 101, "user_steamid": ENEMY, "hitgroup": "head"}
        result = enrich_aim_window(window(), own, enemies, [(100, hurt, 20)])
        self.assertEqual(result["geometry"]["camera"], [[100, 64.0, 0.0, 0.0, 0.0, 0.0, 0.0, 0], [104, 55.0, .5, 0.0, 0.0, 0.0, 0.0, 0]])
        self.assertEqual(result["targets"][0]["body_frames"][1], [104, 1.0, -180.0, 0.0, False])
        self.assertEqual(result["hit_details"], [{"shot_tick": 100, "tick": 101, "target_index": 0, "hitgroup": 1, "damage": 20.0}])
        self.assertEqual(result["geometry"]["observations"][0]["distance_units"], 1000)
        self.assertFalse(result["geometry"]["coverage"]["engine_animation_evaluated"])
        json.dumps(result, allow_nan=False)

    def test_unknown_posture_is_not_turned_into_standing_or_an_aim_score(self):
        result = enrich_aim_window(window(), [player(duck_amount=None)], [player(ENEMY, X=1000, duck_amount=None)])
        self.assertIsNone(result["geometry"]["camera"][0][1])
        self.assertIsNone(result["targets"][0]["body_frames"][0][1])
        self.assertEqual(result["geometry"]["observations"], [])
        self.assertEqual(result["hit_details"], [])
        self.assertEqual(result["geometry"]["coverage"]["camera_with_eye_reference"], 0)

    def test_no_nearby_row_fills_an_exact_fire_tick_gap(self):
        own = [player(tick=99), player(tick=104)]
        targets = [player(ENEMY, tick=99, X=1000), player(ENEMY, tick=104, X=1000)]
        result = enrich_aim_window(window(), own, targets)
        self.assertEqual(result["geometry"]["camera"][0], [100, None, None, None, None, None, None, None])
        self.assertEqual(result["targets"][0]["body_frames"][0], [100, None, None, None, None])
        self.assertEqual(result["geometry"]["observations"], [])

    def test_dead_pose_exists_only_for_the_exact_linked_hit_shot(self):
        own = [player(tick=100), player(tick=104)]
        enemies = [player(ENEMY, tick=100, X=1000, is_alive=False), player(ENEMY, tick=104, X=1000, is_alive=False)]
        hurt = {"tick": 100, "user_steamid": ENEMY, "hitgroup": 2}
        result = enrich_aim_window(window(), own, enemies, [(100, hurt, 20)])
        self.assertEqual(result["targets"][0]["body_frames"][0][1], 0)
        self.assertEqual(result["targets"][0]["body_frames"][1][1:], [None, None, None, None])

    def test_penetration_preserves_different_actual_hitgroups_for_each_victim(self):
        original = window()
        original["targets"].append({"steamid": OTHER, "points": copy.deepcopy(original["targets"][0]["points"])})
        hits = [(100, {"tick": 100, "user_steamid": ENEMY, "hitgroup": "head"}, 20),
                (100, {"tick": 101, "user_steamid": OTHER, "hitgroup": 7}, 12)]
        result = enrich_aim_window(original, [player()], [player(ENEMY, X=1000), player(OTHER, X=1200)], hits)
        self.assertEqual([(h["target_index"], h["hitgroup"]) for h in result["hit_details"]], [(0, 1), (1, 7)])
        # An outline or head-center proximity never changes an observed leg hit.
        self.assertEqual(result["hit_details"][1]["hitgroup"], 7)
        self.assertNotIn("hit_details", original)

    def test_reference_head_error_is_zero_when_recorded_view_targets_reference_center(self):
        pitch = -math.degrees(math.atan2(2, 1000))  # stand reference head center Z66, eye Z64
        own = player(pitch=pitch)
        result = enrich_aim_window(window(), [own], [player(ENEMY, X=1000)])
        observed = result["geometry"]["observations"][0]
        self.assertAlmostEqual(observed["head_reference_error_degrees"], 0)
        self.assertAlmostEqual(observed["head_reference_pitch_error_degrees"], 0)
        self.assertNotIn("success", observed)
        self.assertNotIn("hitgroup", observed)

    def test_missed_burst_has_pose_context_without_an_inferred_target(self):
        original = window()
        original["primary_target_index"] = None
        result = enrich_aim_window(original, [player()], [player(ENEMY, X=1000)])
        self.assertEqual(result["geometry"]["observations"], [])
        self.assertEqual(result["hit_details"], [])
        self.assertEqual(result["targets"][0]["body_frames"][0][1], 0)

    def test_integrated_mechanics_retains_exact_camera_and_hit_evidence(self):
        rounds = [{"round_number": 1, "start_tick": 0, "end_tick": 200, "side": "T", "analysis": {}}]
        shot = {"tick": 100, "user_steamid": SELF, "user_team_num": 2, "weapon": "ak47", "is_warmup_period": False}
        hurt = {"tick": 101, "attacker_steamid": SELF, "user_steamid": ENEMY, "attacker_team_num": 2,
                "user_team_num": 3, "weapon": "ak47", "dmg_health": 20, "health": 80,
                "hitgroup": 2, "is_warmup_period": False}
        own = [player(tick=tick, team_num=2) for tick in range(0, 201)]
        targets = [player(ENEMY, tick=tick, X=1000, team_num=3) for tick in range(0, 201)]
        aggregate = calculate_mechanics({"weapon_fire": [shot], "player_hurt": [hurt]}, own, targets, rounds, SELF)
        playback = rounds[0]["analysis"]["level3"]["mechanics"]["aim_playback"]
        result = playback["windows"][0]
        exact = next(row for row in result["geometry"]["camera"] if row[0] == 100)
        self.assertEqual(exact[1:], [64, 0, 0, 0, 0, 0, 0])
        self.assertEqual(result["hit_details"][0]["shot_tick"], 100)
        self.assertEqual(result["hit_details"][0]["tick"], 101)
        self.assertEqual(result["hit_details"][0]["hitgroup"], 2)
        self.assertEqual(aggregate["aim_playback"]["body_reference_windows"], 1)
        self.assertEqual(aggregate["aim_playback"]["observed_hitgroup_events"], 1)
        self.assertNotIn("windows", aggregate["aim_playback"])

    def test_recorded_fire_origin_uses_all_three_coordinates_and_missing_duck(self):
        # The server FireBullets origin may differ from the end-of-tick pawn
        # origin, including XY. It must not be recentered on the pawn's feet.
        original = window()
        result = enrich_aim_window(original, [player(duck_amount=None), player(tick=104)],
                                   [player(ENEMY, X=1000)], fire_origins={100: (.5, -1.4, 63.66)})
        self.assertEqual(result["geometry"]["camera"][0], [100, 63.66, None, 0, 0, .5, -1.4, 1])
        self.assertEqual(result["geometry"]["eye_height_source"], "mixed")
        self.assertEqual(result["geometry"]["coverage"]["camera_with_recorded_fire_origin"], 1)
        self.assertEqual(result["geometry"]["observations"][0]["eye_source"], "fire_bullets")

    def test_only_unique_exact_live_fire_temporary_entity_is_accepted(self):
        row = {"tick": 100, "user_steamid": SELF, "origin_x": .5, "origin_y": -1.4, "origin_z": 63.66}
        self.assertEqual(recorded_fire_origins([row], SELF, {100}), {100: (.5, -1.4, 63.66)})
        self.assertEqual(recorded_fire_origins([row], SELF, {101}), {})
        self.assertEqual(recorded_fire_origins([row], ENEMY, {100}), {})
        self.assertEqual(recorded_fire_origins([row, dict(row)], SELF, {100}), {})
        self.assertEqual(recorded_fire_origins([dict(row, origin_z=math.nan)], SELF, {100}), {})


if __name__ == "__main__":
    unittest.main()
