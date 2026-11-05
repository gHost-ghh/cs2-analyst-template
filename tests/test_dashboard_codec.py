"""Lossless lazy detail export preserves evidence and enforces expansion bounds."""
import base64
import copy
import gzip
import json
import os
from pathlib import Path
import unittest

from cs2demo.dashboard import MAX_DETAIL_BYTES, _clean, _encode_detail, _export_replay, _match, _round
from cs2demo.replay import _encode_frames


def decode(value):
    raw = gzip.decompress(base64.b64decode(value["data"], validate=True))
    if len(raw) != value["decoded_bytes"]:
        raise AssertionError("wrong decoded byte declaration")
    return json.loads(raw)


class DashboardDetailCodecTests(unittest.TestCase):
    def test_shots_roundtrip_with_metadata_and_no_text_truncation(self):
        shots = [{"id": str(i), "tick": i, "origin": [i * .17, i * -.31, 64],
                  "direction": {"yaw": i * .011, "pitch": i * -.027},
                  "impacts": [], "hurts": [], "weapon": "ak47"} for i in range(700)]
        source = {"version": "1.2", "rounds": [{"round_number": 1, "shots": shots,
                   "frames": _encode_frames([[100, [[0, 0, 0, 0, 0, 0, 1, 2, 100, 0]]]])}]}
        original = copy.deepcopy(source)
        exported = _export_replay(source)
        packed = exported["rounds"][0]["shots"]
        self.assertGreater(len(packed["data"]), 4000)
        self.assertEqual(packed["count"], len(shots))
        self.assertEqual(decode(packed), shots)
        self.assertEqual(exported["rounds"][0]["frames"], source["rounds"][0]["frames"])
        self.assertEqual(source, original)
        self.assertEqual(exported, _export_replay(source))

    def test_aim_arrays_roundtrip_and_light_evidence_stays_available(self):
        points = [[tick, tick * .1731, -tick * .3147, tick * .81, 4, 9] for tick in range(512)]
        window = {"tick": 200, "weapon": "ak47", "points": points,
                  "targets": [{"steamid": "76561198000000002", "points": points,
                               "body_frames": [[t, .5, 90, -4, False] for t in range(512)]}],
                  "geometry": {"exact_animation": False, "camera": points},
                  "shot_markers": [[200, 1, True, 15, [0], 0, [2]]],
                  "hit_details": [{"shot_tick": 200, "target_index": 0, "hitgroup": 2, "damage": 15}],
                  "metrics": {"excess_path_degrees": 3.14}, "primary_target_index": 0}
        source = {"round_number": 1, "start_tick": 0, "end_tick": 512,
                  "analysis": {"level3": {"mechanics": {"aim_playback": {"windows": [window]}}}}}
        original = copy.deepcopy(source)
        exported = _round(source, "fixture", 64)
        actual = exported["analysis"]["level3"]["mechanics"]["aim_playback"]["windows"][0]
        self.assertEqual(decode(actual["trajectory"]), {key: window[key] for key in ("points", "targets", "geometry")})
        self.assertGreater(len(actual["trajectory"]["data"]), 4000)
        for key in ("points", "targets", "geometry"):
            self.assertNotIn(key, actual)
        for key in ("tick", "weapon", "shot_markers", "hit_details", "metrics", "primary_target_index"):
            self.assertEqual(actual[key], window[key])
        self.assertEqual(source, original)

    def test_cleanup_precedes_compression_and_nulls_remain_null(self):
        source = {"round_number": 1, "start_tick": 0, "end_tick": 10,
                  "analysis": {"level3": {"mechanics": {"aim_playback": {"windows": [{
                      "points": [[1, None, float("nan"), 0, 0, 0]],
                      "targets": [{"name": "Player", "api_key": "must-not-export"}],
                      "geometry": {"source_url": "https://private.invalid", "exact_animation": False}}]}}}}}
        actual = _round(source, "fixture", 64)["analysis"]["level3"]["mechanics"]["aim_playback"]["windows"][0]
        value = decode(actual["trajectory"])
        self.assertEqual(value["points"][0][1:3], [None, None])
        self.assertEqual(value["targets"], [{"name": "Player"}])
        self.assertEqual(value["geometry"], {"exact_animation": False})

    def test_detail_expansion_bound_and_nonfinite_rejection(self):
        # Bound concerns decoded bytes, even when a repeating input compresses
        # to a tiny gzip stream.
        with self.assertRaisesRegex(ValueError, "decoded_byte_limit"):
            _encode_detail({"value": "x" * MAX_DETAIL_BYTES})
        with self.assertRaises(ValueError):
            _encode_detail([float("nan")])
        self.assertEqual(decode(_encode_detail([], count=0)), [])

    @unittest.skipUnless(os.environ.get("CS2_PUBLIC_TEST_DEMO"), "optional pinned real Valve replay")
    def test_real_parser_evidence_matches_every_decoded_export_block(self):
        from cs2demo.parser import parse_demo
        raw = parse_demo(Path(os.environ["CS2_PUBLIC_TEST_DEMO"]), "76561197964020430")
        raw.update(match_id="public-codec-fixture", source="local_file")
        exported = _match(raw)
        for source, actual in zip(raw["replay"]["rounds"], exported["replay"]["rounds"]):
            self.assertEqual(decode(actual["shots"]), _clean(source["shots"]))
            self.assertEqual(actual["shots"]["count"], len(source["shots"]))
        for source, actual in zip(raw["rounds"], exported["rounds"]):
            a = source["analysis"]["level3"]["mechanics"]["aim_playback"]["windows"]
            b = actual["analysis"]["level3"]["mechanics"]["aim_playback"]["windows"]
            self.assertEqual(len(a), len(b))
            for original, packed in zip(a, b):
                self.assertEqual(decode(packed["trajectory"]), _clean(
                    {key: original[key] for key in ("points", "targets", "geometry") if key in original}))


if __name__ == "__main__":
    unittest.main()
