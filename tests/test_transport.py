import base64
import gzip
import hashlib
import json
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch

from cs2demo.transport import export_dashboard_transport
from cs2demo.shards import canonical_bytes, load_dashboard, reassemble
from tests.test_shards import source_snapshot


class DashboardTransportTests(unittest.TestCase):
    def _decode_unit(self, root, operation):
        parts = []
        for expected, row in enumerate(operation["chunks"]):
            path = root / row["path"].removeprefix("reports/")
            self.assertLess(path.stat().st_size, 1024 * 1024)
            chunk = json.loads(path.read_bytes())
            self.assertEqual(chunk["index"], expected)
            self.assertEqual(row["index"], expected)
            part = base64.b64decode(chunk["data"], validate=True)
            self.assertEqual(len(part), row["compressed_bytes"])
            self.assertEqual(hashlib.sha256(part).hexdigest(), row["sha256"])
            self.assertEqual(chunk["sha256"], row["sha256"])
            parts.append(part)
        compressed = b"".join(parts)
        raw = gzip.decompress(compressed)
        self.assertEqual(len(raw), operation["decoded_bytes"])
        self.assertEqual(len(compressed), operation["compressed_bytes"])
        self.assertEqual(hashlib.sha256(raw).hexdigest(), operation["decoded_sha256"])
        self.assertEqual(hashlib.sha256(compressed).hexdigest(), operation["compressed_sha256"])
        return json.loads(raw)

    def test_match_first_atomic_index_last_and_exact_json_byte_roundtrip(self):
        snapshot = source_snapshot(3)
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            full_raw = canonical_bytes(snapshot) + b"\n"
            (root / "dashboard.json").write_bytes(full_raw)
            with patch("cs2demo.transport.CHUNK_BYTES", 99):
                manifest = export_dashboard_transport(root)
            self.assertEqual(manifest["schema_version"], "2.0")
            operations = manifest["operations"]
            self.assertEqual([row["kind"] for row in operations],
                             ["match_upload"] * 3 + ["statistics_upload"] * 3 + ["index_commit"])
            self.assertEqual(manifest["match_count"], 3)
            self.assertEqual(manifest["rounds"], 3)
            self.assertEqual(manifest["report_sha256"], hashlib.sha256(full_raw).hexdigest())
            shards = {}
            for operation in operations[:3]:
                value = self._decode_unit(root, operation)
                storage = value["_cs2_storage"]
                self.assertEqual(storage["kind"], "match_upload")
                self.assertEqual(storage["profile"], snapshot["profile"])
                self.assertEqual(storage["source_revision"], manifest["source_revision"])
                raw = value["match_json"].encode("utf-8")
                reference = storage["reference"]
                self.assertEqual(len(raw), reference["decoded_bytes"])
                self.assertEqual(hashlib.sha256(raw).hexdigest(), reference["content_sha256"])
                # 1.0 and long binary64 spellings survive as source text. A
                # JavaScript parse/stringify cycle would change at least 1.0.
                self.assertIn(b'"error_degrees":1.0', raw)
                shards[reference["match_id"]] = raw
            for operation in operations[3:-1]:
                value = self._decode_unit(root, operation)
                self.assertEqual(value["_cs2_storage"]["kind"], "statistics_upload")
                raw = value["statistics_json"].encode("utf-8")
                reference = value["_cs2_storage"]["reference"]
                self.assertEqual(hashlib.sha256(raw).hexdigest(), reference["content_sha256"])
                self.assertEqual(len(raw), reference["decoded_bytes"])
                self.assertTrue(reference["path"].startswith("reports/dashboard.statistics/"))
            commit = self._decode_unit(root, operations[-1])
            self.assertEqual(commit["_cs2_storage"]["kind"], "index_commit")
            index_raw = commit["index_json"].encode("utf-8")
            self.assertEqual(hashlib.sha256(index_raw).hexdigest(), manifest["index_sha256"])
            self.assertEqual(reassemble(json.loads(index_raw), lambda ref: shards[ref["match_id"]]), snapshot)

    def test_full_history_can_exceed_one_request_without_losing_samples(self):
        snapshot = source_snapshot(4)
        for match in snapshot["matches"]:
            match["replay"]["rounds"][0]["frames"]["data"] = "A" * 12000
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            raw = canonical_bytes(snapshot)
            (root / "dashboard.json").write_bytes(raw)
            self.assertGreater(len(raw), 20000)
            with patch("cs2demo.transport.MAX_DECODED_BYTES", 20000):
                with self.assertRaisesRegex(ValueError, "decoded_limit"):
                    export_dashboard_transport(root, version="1.0")
                manifest = export_dashboard_transport(root)
            self.assertGreater(manifest["decoded_bytes"], 20000)
            for operation in manifest["operations"]:
                self.assertLessEqual(operation["decoded_bytes"], 20000)
                self._decode_unit(root, operation)

    def test_v2_determinism_cleanup_and_bounds_apply_to_each_operation(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            (root / "dashboard.json").write_bytes(canonical_bytes(source_snapshot()))
            stale = root / "dashboard.transport" / "match-stale" / "part-999.json"
            stale.parent.mkdir(parents=True)
            stale.write_text("old")
            first = export_dashboard_transport(root)
            self.assertFalse(stale.exists())
            self.assertEqual(first, export_dashboard_transport(root))
            with patch("cs2demo.transport.MAX_DECODED_BYTES", 10):
                with self.assertRaisesRegex(ValueError, "decoded_limit"):
                    export_dashboard_transport(root)
            with patch("cs2demo.transport.MAX_COMPRESSED_BYTES", 10):
                with self.assertRaisesRegex(ValueError, "compressed_limit"):
                    export_dashboard_transport(root)

    def test_over_100_mib_history_persists_without_any_growing_full_report(self):
        snapshot = source_snapshot(18)
        payload = "A" * (6 * 1024 * 1024)
        for match in snapshot["matches"]:
            match["replay"]["rounds"][0]["frames"]["data"] = payload
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            manifest = export_dashboard_transport(root, snapshot=snapshot)
            self.assertGreater(manifest["source_report_bytes"], 100 * 1024 * 1024)
            self.assertEqual(manifest["report_path"], "reports/dashboard.index.json")
            self.assertEqual(manifest["statistics_count"], 18)
            self.assertFalse((root / "dashboard.json").exists())
            self.assertLess((root / "dashboard.index.json").stat().st_size, 100_000)
            self.assertTrue(all(path.stat().st_size <= 16 * 1024 * 1024
                                for path in root.rglob("*.json")))
            # Independent regeneration reads only the committed index/shards.
            self.assertEqual(export_dashboard_transport(root), manifest)
            restored = load_dashboard(root)
            self.assertEqual(restored, snapshot)
            self.assertEqual(len(restored["matches"]), 18)

    def test_exact_report_revision_and_lossless_chunks(self):
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp)
            value = {"generated_at": "2026-10-17T00:00:00Z", "matches": [{"rounds": [{"label": "头部"}]}]}
            raw = (json.dumps(value, ensure_ascii=False, indent=2) + "\n").encode()
            (root / "dashboard.json").write_bytes(raw)
            with patch("cs2demo.transport.CHUNK_BYTES", 13):
                manifest = export_dashboard_transport(root, version="1.0")
            compressed = b""
            for row in manifest["chunks"]:
                chunk = json.loads((root / row["path"].removeprefix("reports/")).read_text())
                data = base64.b64decode(chunk["data"], validate=True)
                self.assertEqual(chunk["sha256"], hashlib.sha256(data).hexdigest())
                self.assertEqual(row["index"], chunk["index"])
                compressed += data
            decoded = gzip.decompress(compressed)
            self.assertEqual(json.loads(decoded), value)
            self.assertEqual(len(decoded), manifest["decoded_bytes"])
            self.assertEqual(hashlib.sha256(decoded).hexdigest(), manifest["decoded_sha256"])
            self.assertEqual(hashlib.sha256(compressed).hexdigest(), manifest["compressed_sha256"])
            self.assertEqual(hashlib.sha1(b"blob " + str(len(raw)).encode() + b"\0" + raw).hexdigest(), manifest["source_revision"])
            self.assertEqual((manifest["match_count"], manifest["rounds"]), (1, 1))

    def test_determinism_stale_chunk_cleanup_and_actual_size_bound(self):
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp)
            (root / "dashboard.json").write_text(json.dumps({"matches": [], "label": "x" * 100}))
            (root / "dashboard.transport").mkdir()
            (root / "dashboard.transport/part-999.json").write_text("old")
            first = export_dashboard_transport(root, version="1.0")
            self.assertFalse((root / "dashboard.transport/part-999.json").exists())
            self.assertEqual(first, export_dashboard_transport(root, version="1.0"))
            with patch("cs2demo.transport.MAX_DECODED_BYTES", 10):
                with self.assertRaisesRegex(ValueError, "decoded_limit"):
                    export_dashboard_transport(root, version="1.0")
            with patch("cs2demo.transport.MAX_COMPRESSED_BYTES", 10):
                with self.assertRaisesRegex(ValueError, "compressed_limit"):
                    export_dashboard_transport(root, version="1.0")
