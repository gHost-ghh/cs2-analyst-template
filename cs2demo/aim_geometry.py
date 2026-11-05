"""Perspective body references from recorded player transforms.

The pinned parser exports origins, duck amount, body rotation and eye angles.
It does not export evaluated bone matrices. The shapes in this module are an
anatomical *reference*, not the model, collision hull, or an engine hitbox.
Only player_hurt hitgroups establish an observed hit location.
"""

from __future__ import annotations

from collections import defaultdict
import math

from .advanced import HITGROUPS, _hitgroup
from .metrics import number, steam_id

VERSION = "1.0"
BODY_ROTATION_FIELD = "CCSPlayerPawn.CBodyComponentBaseAnimGraph.m_angRotation"
CAMERA_FIELDS = ["tick", "eye_z", "duck_amount", "yaw_degrees", "pitch_degrees", "eye_x", "eye_y", "eye_source"]
POSE_FIELDS = ["tick", "duck_amount", "body_yaw_degrees", "eye_pitch_degrees", "is_airborne"]
# Deliberate reference dimensions, not a statement about a particular agent
# mesh. Neither the model's eye attachment nor its skinned vertices are parsed.
DIMENSIONS = {"standing_height": 72.0, "crouching_height": 54.0,
              "standing_eye_height": 64.0, "crouching_eye_height": 46.0}


def _q(value, digits=3):
    value = number(value)
    return round(value, digits) if value is not None else None


def duck_amount(row):
    value = number(row.get("duck_amount"))
    # Unknown posture is not standing. Reject malformed out-of-range telemetry.
    return value if value is not None and 0 <= value <= 1 else None


def body_yaw(row):
    rotation = row.get(BODY_ROTATION_FIELD)
    if isinstance(rotation, (list, tuple)) and len(rotation) >= 2:
        value = number(rotation[1])
        if value is not None:
            return (value + 180) % 360 - 180
    return None


def reference_height(duck):
    duck = number(duck)
    return 72.0 - 18.0 * duck if duck is not None and 0 <= duck <= 1 else None


def reference_eye(row):
    """A stance-derived eye reference; never claim a recorded eye attachment."""
    duck = duck_amount(row)
    xyz = [number(row.get(axis)) for axis in ("X", "Y", "Z")]
    if duck is None or any(value is None for value in xyz):
        return None
    return xyz[0], xyz[1], xyz[2] + 64.0 - 18.0 * duck


def _coords3(value):
    if not isinstance(value, (list, tuple)) or len(value) != 3:
        return None
    result = tuple(number(item) for item in value)
    return result if all(item is not None for item in result) else None


def recorded_fire_origins(event_rows, steamid, live_fire_ticks):
    """Unique exact-tick origin from FireBullets TE, tied to live own shots.

    FireBullets has no warmup flag. A matching observed live weapon_fire is
    required; ambiguous duplicate temporary-entity records are not selected.
    """
    by_tick = defaultdict(list)
    for row in event_rows:
        tick = number(row.get("tick"))
        if steam_id(row.get("user_steamid")) == steamid and tick is not None and int(tick) in live_fire_ticks:
            by_tick[int(tick)].append(row)
    result = {}
    for tick, rows in by_tick.items():
        if len(rows) == 1:
            coords = _coords3([rows[0].get("origin_" + axis) for axis in ("x", "y", "z")])
            if coords is not None:
                result[tick] = coords
    return result


def camera_basis(yaw_degrees, pitch_degrees):
    """Source camera basis: +pitch looks down; screen right is -Y at yaw 0."""
    yaw, pitch = number(yaw_degrees), number(pitch_degrees)
    if yaw is None or pitch is None:
        return None
    yaw, pitch = math.radians(yaw), math.radians(pitch)
    sy, cy, sp, cp = math.sin(yaw), math.cos(yaw), math.sin(pitch), math.cos(pitch)
    return ((cp * cy, cp * sy, -sp), (sy, -cy, 0.0), (sp * cy, sp * sy, cp))


def project_world(point, eye, yaw_degrees, pitch_degrees, *, near=1.0):
    """Project to a focal-length-one camera plane, with up/right positive.

    No FOV, canvas size or aspect ratio is assumed. A renderer applies one
    common focal scale to both axes. Points on/behind the near plane are gaps.
    """
    basis = camera_basis(yaw_degrees, pitch_degrees)
    if basis is None or not isinstance(point, (list, tuple)) or not isinstance(eye, (list, tuple)):
        return None
    if len(point) != 3 or len(eye) != 3:
        return None
    values = [number(value) for value in (*point, *eye)]
    near = number(near)
    if any(value is None for value in values) or near is None or near <= 0:
        return None
    delta = [values[i] - values[i + 3] for i in range(3)]
    depth, right, up = [sum(a * b for a, b in zip(delta, vector)) for vector in basis]
    if depth <= near:
        return None
    return {"x": right / depth, "y": up / depth, "depth": depth,
            "distance": math.sqrt(sum(value * value for value in delta))}


def _reference_regions(height):
    """Simple local contours; no gait, weapon animation, or bone evaluation."""
    # Coordinates are (lateral, vertical). A small reference depth below keeps
    # profiles visible; neither contour nor depth is an engine hitbox.
    head_bottom, shoulders, hips = height - 12, height - 19, height * .43
    return {
        "head": [(0, height), (4.5, height - 2), (5.5, height - 7), (4, head_bottom),
                 (-4, head_bottom), (-5.5, height - 7), (-4.5, height - 2)],
        "chest": [(-8, shoulders), (-4, head_bottom), (4, head_bottom), (8, shoulders),
                  (7, height * .61), (-7, height * .61)],
        "stomach": [(-7, height * .61), (7, height * .61), (7, hips), (-7, hips)],
        "right_arm": [(-8, shoulders), (-12, shoulders - 4), (-13, height * .49),
                      (-9, height * .47), (-7, height * .61)],
        "left_arm": [(8, shoulders), (12, shoulders - 4), (13, height * .49),
                     (9, height * .47), (7, height * .61)],
        "right_leg": [(-7, hips), (-.5, hips), (-1.5, 2), (-9, 0), (-9, 4)],
        "left_leg": [(7, hips), (.5, hips), (1.5, 2), (9, 0), (9, 4)],
    }


def _convex_hull(points):
    points = sorted(set(points))
    if len(points) <= 2:
        return points
    def cross(a, b, c):
        return (b[0] - a[0]) * (c[1] - a[1]) - (b[1] - a[1]) * (c[0] - a[0])
    lower, upper = [], []
    for point in points:
        while len(lower) >= 2 and cross(lower[-2], lower[-1], point) <= 0:
            lower.pop()
        lower.append(point)
    for point in reversed(points):
        while len(upper) >= 2 and cross(upper[-2], upper[-1], point) <= 0:
            upper.pop()
        upper.append(point)
    return lower[:-1] + upper[:-1]


def project_body_reference(own, target, *, fire_origin=None):
    """A pure, inspectable perspective contour API for the future query layer.

    Missing posture, view, body rotation or coordinates means unavailable.
    A head-on/profile change follows recorded body yaw. It does not reproduce
    animated limbs, model skinning, occlusion, or the enemy's actual hitboxes.
    """
    observed_eye = _coords3(fire_origin)
    eye, yaw, pitch = observed_eye or reference_eye(own), number(own.get("yaw")), number(own.get("pitch"))
    target_yaw, height = body_yaw(target), reference_height(duck_amount(target))
    origin = [number(target.get(axis)) for axis in ("X", "Y", "Z")]
    result = {"status": "unavailable", "kind": "stance_body_reference", "exact_animation": False,
              "eye_height_source": "fire_bullets" if observed_eye else "stance_reference", "visibility_verified": False, "regions": {}}
    if eye is None or yaw is None or pitch is None or target_yaw is None or height is None or any(x is None for x in origin):
        result["reason"] = "pose_or_camera_missing"
        return result
    lateral = (-math.sin(math.radians(target_yaw)), math.cos(math.radians(target_yaw)))
    forward = (math.cos(math.radians(target_yaw)), math.sin(math.radians(target_yaw)))
    for name, contour in _reference_regions(height).items():
        thickness = 5.0 if name in ("head", "chest", "stomach") else 3.0
        world = [(origin[0] + lateral[0] * x + forward[0] * depth,
                  origin[1] + lateral[1] * x + forward[1] * depth, origin[2] + z)
                 for x, z in contour for depth in (-thickness, thickness)]
        projected = [project_world(point, eye, yaw, pitch) for point in world]
        if all(point is not None for point in projected):
            result["regions"][name] = [list(point) for point in _convex_hull(
                [(_q(point["x"], 6), _q(point["y"], 6)) for point in projected])]
    result["status"] = "reference" if result["regions"] else "out_of_view"
    result["reason"] = None if result["regions"] else "behind_or_crosses_near_plane"
    return result


def _angle(a, b):
    norm = math.sqrt(sum(x * x for x in a) * sum(x * x for x in b))
    return math.degrees(math.acos(max(-1.0, min(1.0, sum(x * y for x, y in zip(a, b)) / norm)))) if norm else None


def _reference_observation(own, target, *, fire_origin=None):
    eye, height = _coords3(fire_origin) or reference_eye(own), reference_height(duck_amount(target))
    yaw, pitch = number(own.get("yaw")), number(own.get("pitch"))
    xyz = [number(target.get(axis)) for axis in ("X", "Y", "Z")]
    if eye is None or height is None or yaw is None or pitch is None or any(value is None for value in xyz):
        return None
    dx, dy = xyz[0] - eye[0], xyz[1] - eye[1]
    distance = math.hypot(dx, dy)
    if distance < 1:
        return None
    head = (dx, dy, xyz[2] + height - 6 - eye[2])
    basis = camera_basis(yaw, pitch)
    bearing = math.degrees(math.atan2(dy, dx))
    head_pitch = -math.degrees(math.atan2(head[2], distance))
    body_top_pitch = -math.degrees(math.atan2(xyz[2] + height - eye[2], distance))
    body_bottom_pitch = -math.degrees(math.atan2(xyz[2] - eye[2], distance))
    head_bottom_pitch = -math.degrees(math.atan2(xyz[2] + height - 12 - eye[2], distance))
    # This is a reference-center angular separation, never a hit test.
    yaw_error = (yaw - bearing + 180) % 360 - 180
    own_origin = [number(own.get(axis)) for axis in ("X", "Y", "Z")]
    return {"distance_units": _q(math.dist(own_origin, xyz), 2) if all(value is not None for value in own_origin) else None,
            "head_reference_error_degrees": _q(_angle(basis[0], head)),
            "head_reference_yaw_error_degrees": _q(abs(yaw_error)),
            "head_reference_pitch_error_degrees": _q(abs(pitch - head_pitch)),
            "head_reference_offset_degrees": [_q(yaw_error), _q(pitch - head_pitch)],
            "body_height_degrees": _q(abs(body_bottom_pitch - body_top_pitch)),
            "head_height_degrees": _q(abs(head_bottom_pitch - body_top_pitch))}


def enrich_aim_window(window, own_samples, target_samples, associated_hits=(), *, fire_origins=None):
    """Add compact camera/pose evidence and per-victim observed hit locations.

    ``associated_hits`` contains (linked_fire_tick, player_hurt_row, effectiveHP)
    from the existing unique same-weapon association, never spatial matching.
    Rows remain aligned to the existing point ticks, including explicit gaps.
    """
    own = {int(row["tick"]): row for row in own_samples if number(row.get("tick")) is not None}
    fire_origins = fire_origins or {}
    opponents = defaultdict(dict)
    for row in target_samples:
        sid, tick = steam_id(row.get("steamid")), number(row.get("tick"))
        if sid is not None and tick is not None:
            opponents[sid][int(tick)] = row
    targets = [{**target} for target in window.get("targets", [])]
    target_indices = {target["steamid"]: index for index, target in enumerate(targets)}
    details = []
    group_codes = {name: code for code, name in HITGROUPS.items()}
    for shot_tick, hurt, damage in associated_hits:
        target_index = target_indices.get(steam_id(hurt.get("user_steamid")))
        if target_index is None:
            continue
        details.append({"shot_tick": int(shot_tick), "tick": int(hurt["tick"]),
                        "target_index": target_index, "hitgroup": group_codes.get(_hitgroup(hurt.get("hitgroup"))),
                        "damage": _q(damage)})
    details.sort(key=lambda row: (row["shot_tick"], row["tick"], row["target_index"]))
    hit_ticks = {(item["shot_tick"], item["target_index"]) for item in details}

    camera = []
    for point in window.get("points", []):
        tick, row = int(point[0]), own.get(int(point[0]), {})
        # Existing angular gaps also invalidate the camera; a nearby snapshot
        # does not supply a missing exact fire-tick transform.
        valid = row.get("is_alive") is True and point[1] is not None and point[2] is not None
        observed_eye = _coords3(fire_origins.get(tick)) if valid else None
        eye = observed_eye or (reference_eye(row) if valid else None)
        camera.append([tick, _q(eye[2], 2) if eye else None,
                       _q(duck_amount(row)) if valid else None,
                       _q(row.get("yaw")) if valid else None, _q(row.get("pitch")) if valid else None,
                       _q(eye[0], 2) if eye else None, _q(eye[1], 2) if eye else None,
                       1 if observed_eye else 0 if eye else None])
    for index, target in enumerate(targets):
        pose = []
        for point in target.get("points", []):
            tick, row = int(point[0]), opponents[target["steamid"]].get(int(point[0]), {})
            valid = (point[1] is not None and (row.get("is_alive") is True or (tick, index) in hit_ticks))
            pose.append([tick, _q(duck_amount(row)) if valid else None,
                         _q(body_yaw(row)) if valid else None, _q(row.get("pitch")) if valid else None,
                         row.get("is_airborne") if valid and isinstance(row.get("is_airborne"), bool) else None])
        target.update(pose_fields=POSE_FIELDS, body_frames=pose)

    observations = []
    primary = window.get("primary_target_index")
    if isinstance(primary, int) and not isinstance(primary, bool) and 0 <= primary < len(targets):
        target = targets[primary]
        camera_by_tick = {row[0]: row for row in camera}
        target_points = {row[0]: row for row in target.get("points", [])}
        for shot in window.get("shot_markers", []):
            tick = int(shot[0])
            camera_row, target_point = camera_by_tick.get(tick), target_points.get(tick)
            if not camera_row or camera_row[1] is None or not target_point or target_point[1] is None:
                continue
            target_row = opponents[target["steamid"]].get(tick, {})
            if target_row.get("is_alive") is not True and (tick, primary) not in hit_ticks:
                continue
            observation = _reference_observation(own.get(tick, {}), target_row,
                                                 fire_origin=fire_origins.get(tick))
            if observation:
                observations.append({"shot_tick": tick, "target_index": primary,
                                     "eye_source": "fire_bullets" if camera_row[7] == 1 else "stance_reference", **observation})
    poses = [row for target in targets for row in target["body_frames"]]
    sources = {row[7] for row in camera if row[7] is not None}
    geometry = {"version": VERSION, "kind": "stance_body_reference", "exact_animation": False,
                "visibility_verified": False,
                "eye_height_source": "mixed" if sources == {0, 1} else "fire_bullets" if sources == {1} else "stance_reference",
                "eye_source_codes": {"0": "stance_reference", "1": "fire_bullets"}, "dimensions": dict(DIMENSIONS),
                "camera_fields": CAMERA_FIELDS, "camera": camera, "observations": observations,
                "coverage": {"camera_samples": len(camera), "camera_with_eye_reference": sum(row[1] is not None for row in camera),
                             "target_pose_samples": len(poses), "target_with_duck_amount": sum(row[1] is not None for row in poses),
                             "target_with_body_rotation": sum(row[2] is not None for row in poses),
                             "camera_with_recorded_fire_origin": sum(row[7] == 1 for row in camera),
                             "engine_bone_matrices": False, "engine_animation_evaluated": False}}
    return {**window, "targets": targets, "geometry": geometry, "hit_details": details}
