import hashlib
import json
import os
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch

from cs2demo.advanced import ANALYSIS_VERSION
from cs2demo.download import DownloadError, MAGIC, materialize_demo
from cs2demo.native_sources import (MANIFEST_NAME, NativeSourceError, fingerprint,
                                    load_native_sources, record_native_source,
                                    validate_native_source_url)
from cs2demo.pipeline import run_pipeline

SID = "76561198096123254"
CODE = "CSGO-CQNLr-6sp23-JwjmS-kQPwR-tm7SA"
IDENT = "a" * 24
URL = "http://replay237.csgo.com.cn/730/match_123.dem.bz2"
RAW = MAGIC + b"native source fixture"


def parsed_fixture(path, steamid):
    raw = path.read_bytes()
    return {"schema_version": "1.0", "analysis_version": ANALYSIS_VERSION,
            "player": {"steamid": steamid}, "map_name": "de_test",
            "rounds": [{"round_number": 1, "side": "CT", "kills": 1, "deaths": 0,
                        "assists": 0, "damage": 100, "headshot_kills": 1, "opening_kill": True,
                        "opening_death": False, "survived": True, "traded": False, "kast": True}],
            "summary": {"rounds": 1, "kills": 1, "deaths": 0, "assists": 0, "damage": 100},
            "provenance": {"source_sha256": hashlib.sha256(raw).hexdigest(), "source_bytes": len(raw)}}


class NativeSourceManifestTests(unittest.TestCase):
    def test_only_query_free_gc_locations_are_reusable(self):
        for host in ("replay1.valve.net", "replay4.wmsj.cn", "replay237.csgo.com.cn"):
            url = f"https://{host}/730/match_123.456-abc.dem.bz2"
            self.assertEqual(validate_native_source_url(url), url)
        for bad in ("https://replay1.valve.net/730/a.dem?", "https://replay1.valve.net/730/a.dem#",
                    "https://replay1.valve.net/730/a.dem?key=private", "https://files.example.org/730/a.dem",
                    "https://replay1.valve.net:443/730/a.dem", "http://replay1.valve.net:80/730/a.dem",
                    "https://replay1.valve.net/x.dem", "https://replay1.valve.net/730/../a.dem",
                    "https://replay1.valve.net/730/%61.dem", "https://u:p@replay1.valve.net/730/a.dem",
                    "https://replay1.valve.net.evil.com/730/a.dem", "file:///730/a.dem",
                    "https://replay1.valve.net/730/a\n.dem", "https://replay1.valve.net/730/" + "a" * 257 + ".dem"):
            with self.subTest(url=bad), self.assertRaisesRegex(NativeSourceError, "^native_source_url_not_allowed$"):
                validate_native_source_url(bad)

    def test_manifest_binds_exact_bytes_and_rejects_owner_or_fingerprint_conflicts(self):
        receipt = {"sha256": hashlib.sha256(RAW).hexdigest(), "bytes": len(RAW)}
        provenance = {"source_sha256": receipt["sha256"], "source_bytes": receipt["bytes"]}
        with tempfile.TemporaryDirectory() as tmp:
            data = Path(tmp)
            manifest = load_native_sources(data, SID)
            record_native_source(manifest, IDENT, URL, receipt, provenance)
            (data / MANIFEST_NAME).write_text(json.dumps(manifest))
            self.assertEqual(load_native_sources(data, SID)["matches"][IDENT], {"url": URL, **receipt})
            with self.assertRaisesRegex(NativeSourceError, "native_source_manifest_invalid"):
                load_native_sources(data, "76561198000000001")
            with self.assertRaisesRegex(NativeSourceError, "native_source_fingerprint_mismatch"):
                record_native_source(manifest, IDENT, URL, {**receipt, "bytes": len(RAW) + 1}, provenance)
            other = {"sha256": "b" * 64, "bytes": len(RAW)}
            with self.assertRaisesRegex(NativeSourceError, "native_source_existing_fingerprint_mismatch"):
                record_native_source(manifest, IDENT, URL, other, other)
            self.assertIsNone(fingerprint({**provenance, "sha256": "c" * 64}))
            self.assertIsNone(fingerprint({"sha256": receipt["sha256"], "bytes": True}))
            manifest["matches"][IDENT]["url"] = "https://replay1.valve.net/730/a.dem?token=private"
            (data / MANIFEST_NAME).write_text(json.dumps(manifest))
            with self.assertRaisesRegex(NativeSourceError, "native_source_manifest_invalid"):
                load_native_sources(data, SID)


class NativeSourcePipelineTests(unittest.TestCase):
    def setUp(self):
        for mocked in (patch.dict(os.environ, {"STEAM_REFRESH_TOKEN": "test"}, clear=True),
                       patch("cs2demo.pipeline.discover_recent_codes", return_value={"status": "discovered"})):
            mocked.start()
            self.addCleanup(mocked.stop)

    def download(self, url, directory, **kwargs):
        source = directory / "input.dem"
        source.write_bytes(RAW)
        target = directory / "replay.dem"
        return target, materialize_demo(source, target)

    def assert_locations_private(self, root):
        for path in [root / "data/demo_jobs.json", *list((root / "data/demo_matches").glob("*.json")),
                     *list((root / "reports").rglob("*"))]:
            if path.is_file():
                self.assertNotIn(URL.encode(), path.read_bytes(), str(path))

    def prepare_complete(self, root, code=CODE):
        replay = root / "input.dem"
        replay.write_bytes(RAW)
        run_pipeline(root, SID, code=code, local_demo=replay, parser=parsed_fixture)
        state_path = root / "data/demo_jobs.json"
        state = json.loads(state_path.read_text())
        job = next(item for item in state["jobs"].values() if item["share_code"] == code)
        job["source"] = "steam_gc"
        state_path.write_text(json.dumps(state))
        return job, root / "data" / job["result_path"]

    def test_successful_acquisition_persists_source_only_in_private_manifest(self):
        with tempfile.TemporaryDirectory() as tmp, patch("cs2demo.pipeline.download_demo", side_effect=self.download):
            root = Path(tmp)
            result = run_pipeline(root, SID, code=CODE, url=URL, parser=parsed_fixture)
            self.assertEqual(result["matches_analyzed"], 1)
            manifest = load_native_sources(root / "data", SID)
            self.assertEqual(len(manifest["matches"]), 1)
            entry = next(iter(manifest["matches"].values()))
            self.assertEqual(entry, {"url": URL, "sha256": hashlib.sha256(RAW).hexdigest(), "bytes": len(RAW)})
            self.assert_locations_private(root)

    def test_parse_failure_or_signed_url_never_creates_reusable_source(self):
        for parse_ok, url in ((False, URL), (True, URL + "?private=redact")):
            with self.subTest(parse_ok=parse_ok), tempfile.TemporaryDirectory() as tmp, \
                    patch("cs2demo.pipeline.download_demo", side_effect=self.download):
                root = Path(tmp)
                def parse(path, steamid):
                    if not parse_ok:
                        raise ValueError("private input")
                    return parsed_fixture(path, steamid)
                run_pipeline(root, SID, code=CODE, url=url, parser=parse)
                self.assertFalse((root / "data" / MANIFEST_NAME).exists())
                self.assert_locations_private(root)
                self.assertNotIn("private=redact", (root / "data/demo_jobs.json").read_text())

    def test_backfill_is_opt_in_bounded_idempotent_and_preserves_analysis(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            first, first_path = self.prepare_complete(root)
            second_code = "CSGO-00000-6sp23-JwjmS-kQPwR-tm7SA"
            self.prepare_complete(root, second_code)
            old = first_path.read_bytes()
            answers = {code: {"status": "resolved", "url": URL} for code in (CODE, second_code)}
            with patch("cs2demo.pipeline.resolve_codes", return_value=answers), \
                    patch("cs2demo.pipeline.download_demo", side_effect=self.download) as downloader:
                run_pipeline(root, SID, parser=lambda *args: self.fail("completed match must not be parsed"))
                downloader.assert_not_called()
                run_pipeline(root, SID, limit=1, backfill_native_sources=True,
                             parser=lambda *args: self.fail("source backfill must not parse"))
                self.assertEqual(downloader.call_count, 1)
                self.assertEqual(len(load_native_sources(root / "data", SID)["matches"]), 1)
                self.assertEqual(first_path.read_bytes(), old)
                status = json.loads((root / "reports/demo_status.json").read_text())
                self.assertEqual(status["completed_this_run"], 0)
                self.assertEqual(status["native_sources_verified_this_run"], 1)
                self.assertEqual(status["run_outcome"], "ok")
                # Explicit completed share-code selects only that matching source;
                # an already verified match never triggers another download.
                run_pipeline(root, SID, code=CODE, backfill_native_sources=True)
                self.assertEqual(downloader.call_count, 1)
                run_pipeline(root, SID, limit=1, backfill_native_sources=True)
                self.assertEqual(downloader.call_count, 2)
                run_pipeline(root, SID, backfill_native_sources=True)
                self.assertEqual(downloader.call_count, 2)
            self.assert_locations_private(root)

    def test_backfill_mismatch_or_expired_source_retains_prior_match_and_backoff(self):
        for mismatch in (True, False):
            with self.subTest(mismatch=mismatch), tempfile.TemporaryDirectory() as tmp:
                root = Path(tmp)
                job, path = self.prepare_complete(root)
                original = path.read_bytes()
                def unavailable_or_changed(url, directory, **kwargs):
                    if mismatch:
                        target, receipt = self.download(url, directory)
                        return target, {**receipt, "sha256": "f" * 64}
                    raise DownloadError("http_404")
                with patch("cs2demo.pipeline.resolve_codes", return_value={CODE: {"status": "resolved", "url": URL}}), \
                        patch("cs2demo.pipeline.download_demo", side_effect=unavailable_or_changed) as downloader:
                    run_pipeline(root, SID, backfill_native_sources=True)
                    saved = json.loads((root / "data/demo_jobs.json").read_text())["jobs"][job["id"]]
                    self.assertEqual(saved["status"], "complete")
                    self.assertEqual(saved["native_source_last_error_code"],
                                     "native_source_fingerprint_mismatch" if mismatch else "http_404")
                    self.assertEqual(path.read_bytes(), original)
                    self.assertFalse((root / "data" / MANIFEST_NAME).exists())
                    run_pipeline(root, SID, backfill_native_sources=True)
                    self.assertEqual(downloader.call_count, 1)


if __name__ == "__main__":
    unittest.main()
