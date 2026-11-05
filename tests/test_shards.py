"""Complete match shards preserve every statistical input and original sample."""
import copy
import hashlib
import json
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch

from cs2demo.shards import (canonical_bytes, export_complete_dashboard, export_dashboard_shards, git_blob_sha,
                            load_dashboard, project_snapshot, reassemble, snapshot_identity, verify_match)


def source_snapshot(count=2):
    observations = {"observations": [{"success": True, "error_degrees": 1.0,
                     "trace": [[1, 2.123456789012345, 3], [2, 4, 5]]}]}
    analysis = {"level3": {"crosshair": copy.deepcopy(observations),
                "counter_strafe": copy.deepcopy(observations),
                "mechanics": {"targeting": copy.deepcopy(observations),
                "stopping": copy.deepcopy(observations),
                "spray": copy.deepcopy(observations),
                "aim_playback": {"windows": [{"tick": 1, "metrics": {"error": 1.0},
                    "shot_markers": [[1, True]], "trajectory": {
                    "encoding": "gzip-base64-json", "count": 2,
                    "decoded_bytes": 16, "data": "original-packed-body-points"}}]}}}}
    match = {"rounds": [{"round_number": 1, "kills": 2, "damage": 97,
                         "analysis": copy.deepcopy(analysis)}],
             "analysis": analysis, "players": [{"steamid64": "76561198000000002",
                "rounds": [{"round_number": 1, "damage": 63, "kast": True,
                            "events": [{"type": "shot", "tick": 1}]}]}],
             "events": [{"type": "kill", "tick": 1}],
             "positions": [[1, 123, 456]],
             "replay": {"sample_hz": 16, "rounds": [{"round_number": 1,
                "result": {"reason": "bomb_defused", "ct_alive": 2, "t_alive": 1},
                "frames": {"encoding": "gzip-base64-json", "count": 3,
                           "decoded_bytes": 32, "data": "original-packed-frames"},
                "shots": [{"tick": 1, "origin": [1.0, 2, 64]}],
                "tactical": {"bomb": [{"tick": 1, "state": "carried"}]},
                "damage_events": [{"tick": 1, "damage": 97}],
                "unassociated_impacts": []}]}}
    matches = []
    for index in range(count):
        row = copy.deepcopy(match)
        row["match_id"] = f"{index + 1:024x}"
        matches.append(row)
    return {"schema_version": "1.0", "profile": {"steamid64": "76561198000000001"},
            "generated_at": "2026-10-18T00:00:00+00:00", "matches": matches,
            "player_directory": {"players": [{"rounds": 4}]},
            "sync": {"status_counts": {"complete": count}}}


class DashboardShardsTests(unittest.TestCase):
    def test_exact_reassembly_with_statistics_and_explicit_missing_detail(self):
        snapshot = source_snapshot()
        original = copy.deepcopy(snapshot)
        statistics = {}
        index, shards = project_snapshot(snapshot, "a" * 40, statistics_out=statistics)
        self.assertEqual(reassemble(index, lambda ref: shards[ref["match_id"]]), original)
        self.assertEqual(snapshot, original)
        self.assertEqual(index["player_directory"], snapshot["player_directory"])
        for projected, full in zip(index["matches"], snapshot["matches"]):
            self.assertNotIn("rounds", projected["players"][0])
            self.assertEqual(projected["players"][0]["_cs2_deferred"]["rounds"]["count"], 1)
            self.assertNotIn("positions", projected)
            self.assertNotIn("events", projected)
            self.assertNotIn("analysis", projected)
            self.assertEqual(projected["rounds"][0]["damage"], 97)
            self.assertNotIn("analysis", projected["rounds"][0])
            stats = verify_match(statistics[full["match_id"]], projected["statistics_ref"], statistics=True)
            self.assertEqual(stats["positions"], full["positions"])
            self.assertEqual(stats["events"], full["events"])
            self.assertNotIn("events", stats["players"][0]["rounds"][0])
            self.assertEqual(stats["players"][0]["rounds"][0]["damage"], 63)
            mechanics = stats["analysis"]["level3"]["mechanics"]
            self.assertEqual(mechanics["spray"], full["analysis"]["level3"]["mechanics"]["spray"])
            self.assertEqual(mechanics["targeting"]["observations"][0]["error_degrees"], 1.0)
            self.assertNotIn("trace", mechanics["targeting"]["observations"][0])
            self.assertIn("trace", mechanics["targeting"]["observations"][0]["_cs2_deferred"])
            self.assertNotIn("rounds", projected["replay"])
            replay = stats["replay"]["rounds"][0]
            self.assertEqual(replay["result"], full["replay"]["rounds"][0]["result"])
            self.assertEqual(replay["frames"]["count"], 3)
            self.assertNotIn("data", replay["frames"])
            self.assertNotIn("shots", replay)
            self.assertEqual(replay["_cs2_deferred"]["shots"]["count"], 1)

    def test_corrupt_wrong_identity_and_substituted_reference_rejected(self):
        snapshot = source_snapshot()
        index, shards = project_snapshot(snapshot, "b" * 40)
        reference = index["matches"][0]["detail_ref"]
        raw = shards[reference["match_id"]]
        with self.assertRaisesRegex(ValueError, "length_mismatch"):
            verify_match(raw + b" ", reference)
        with self.assertRaisesRegex(ValueError, "digest_mismatch"):
            verify_match(raw.replace(b"97", b"98"), reference)
        wrong = json.loads(raw)
        wrong["match_id"] = "f" * 24
        wrong_bytes = canonical_bytes(wrong)
        altered = {**reference, "decoded_bytes": len(wrong_bytes),
                   "content_sha256": hashlib.sha256(wrong_bytes).hexdigest()}
        with self.assertRaisesRegex(ValueError, "identity_mismatch"):
            verify_match(wrong_bytes, altered)
        bad_index = copy.deepcopy(index)
        bad_index["matches"][0]["detail_ref"]["source_revision"] = "c" * 40
        with self.assertRaisesRegex(ValueError, "invalid_dashboard_shard_index"):
            reassemble(bad_index, lambda ref: shards[ref["match_id"]])
        bad_index = copy.deepcopy(index)
        bad_index["_cs2_storage"]["match_refs"][1] = bad_index["_cs2_storage"]["match_refs"][0]
        with self.assertRaisesRegex(ValueError, "invalid_dashboard_shard_index"):
            reassemble(bad_index, lambda ref: shards[ref["match_id"]])

    def test_export_exact_byte_identity_and_stale_shard_cleanup(self):
        snapshot = source_snapshot()
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            raw = canonical_bytes(snapshot) + b"\n"
            (root / "dashboard.json").write_bytes(raw)
            stale = root / "dashboard.matches" / ("f" * 24 + ".json")
            stale.parent.mkdir()
            stale.write_text("stale")
            index, shards = export_dashboard_shards(root)
            self.assertFalse(stale.exists())
            self.assertEqual(index["_cs2_storage"]["source_revision"], git_blob_sha(raw))
            for reference in index["_cs2_storage"]["match_refs"]:
                actual = (root / reference["path"].removeprefix("reports/")).read_bytes()
                self.assertEqual(actual, shards[reference["match_id"]])
                self.assertEqual(len(actual), reference["decoded_bytes"])
                self.assertEqual(hashlib.sha256(actual).hexdigest(), reference["content_sha256"])
            self.assertEqual(json.loads((root / "dashboard.index.json").read_bytes()), index)
            for reference in index["_cs2_storage"]["statistics_refs"]:
                raw = (root / reference["path"].removeprefix("reports/")).read_bytes()
                stats = verify_match(raw, reference, statistics=True)
                self.assertEqual(stats["detail_ref"]["match_id"], reference["match_id"])

    def test_streamed_identity_matches_historic_canonical_file_and_no_monolith_is_needed(self):
        snapshot = source_snapshot()
        snapshot["label"] = "头部 / 胸部 😀"
        raw = canonical_bytes(snapshot) + b"\n"
        identity = snapshot_identity(snapshot)
        self.assertEqual(identity, {"source_revision": git_blob_sha(raw),
                         "report_sha256": hashlib.sha256(raw).hexdigest(), "report_bytes": len(raw)})
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            index, _ = export_dashboard_shards(root, snapshot=snapshot)
            self.assertFalse((root / "dashboard.json").exists())
            self.assertEqual(index["_cs2_storage"]["source_revision"], identity["source_revision"])
            self.assertEqual(load_dashboard(root), snapshot)
            exported = root.parent / (root.name + "-export.json")
            try:
                self.assertEqual(export_complete_dashboard(root, exported), {"matches": 2, "bytes": len(raw)})
                self.assertEqual(exported.read_bytes(), raw)
            finally:
                exported.unlink(missing_ok=True)
            with self.assertRaisesRegex(ValueError, "would_overwrite_source"):
                export_complete_dashboard(root, root / "dashboard.index.json")

    def test_invalid_source_and_real_per_object_expansion_bounds(self):
        for bad in ({}, {**source_snapshot(), "profile": []}):
            with self.assertRaisesRegex(ValueError, "invalid_dashboard_shard_source"):
                project_snapshot(bad, "a" * 40)
        for reserved in ("_cs2_deferred", "detail_ref", "_cs2_storage"):
            bad = source_snapshot()
            bad["matches"][0][reserved] = {}
            with self.assertRaisesRegex(ValueError, "reserved_dashboard_shard_field"):
                project_snapshot(bad, "a" * 40)
        bad = source_snapshot()
        bad["matches"][1]["match_id"] = bad["matches"][0]["match_id"]
        with self.assertRaisesRegex(ValueError, "invalid_dashboard_shard_match_id"):
            project_snapshot(bad, "a" * 40)
        with patch("cs2demo.shards.MAX_MATCH_BYTES", 64):
            with self.assertRaisesRegex(ValueError, "match_shard_decoded_limit"):
                project_snapshot(source_snapshot(), "a" * 40)
        with patch("cs2demo.shards.MAX_INDEX_BYTES", 64):
            with self.assertRaisesRegex(ValueError, "index_decoded_limit"):
                project_snapshot(source_snapshot(), "a" * 40)


if __name__ == "__main__":
    unittest.main()
