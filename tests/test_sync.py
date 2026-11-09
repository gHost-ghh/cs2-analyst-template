import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch
import sync

SID = "76561198096123254"
CODE1 = "CSGO-CQNLr-6sp23-JwjmS-kQPwR-tm7SA"
CODE2 = "CSGO-GADqf-jjyJ8-cSP2r-smZRo-TO2xK"

class TestSync(unittest.TestCase):
    def test_optional_leetify_keeps_cached_records_and_steam_discovery(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            with patch.object(sync, "DATA", root / "data"), patch.object(sync, "REPORTS", root / "reports"), \
                 patch.dict("os.environ", {"STEAMID64": SID, "CS2_SKIP_LEETIFY": "true"}, clear=True), \
                 patch.object(sync, "sync_steam_codes", return_value=({CODE1}, True)) as steam, \
                 patch.object(sync, "sync_leetify") as leetify:
                cached = root / "data/matches/cached.json"
                sync.write_json_if_changed(cached, {"id": "cached", "data_source": "matchmaking", "finished_at": "2026-01-01T00:00:00Z", "player_stats": None})
                original = cached.read_bytes()
                sync.main()
                steam.assert_called_once()
                leetify.assert_not_called()
                self.assertEqual(cached.read_bytes(), original)
                self.assertEqual(sync.read_json(root / "reports/sync_status.json", {})["leetify_status"], "disabled")
                self.assertEqual(sync.read_json(root / "reports/sync_status.json", {})["recorded_valve_matches"], 1)

    def test_existing_default_still_runs_leetify_enrichment(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            with patch.object(sync, "DATA", root / "data"), patch.object(sync, "REPORTS", root / "reports"), \
                 patch.dict("os.environ", {"STEAMID64": SID}, clear=True), \
                 patch.object(sync, "sync_steam_codes", return_value=(set(), False)), \
                 patch.object(sync, "sync_leetify", return_value=([], False)) as leetify:
                sync.main()
                leetify.assert_called_once_with(SID)
                self.assertEqual(sync.read_json(root / "reports/sync_status.json", {})["leetify_status"], "enabled")

    def test_parse_matches(self):
        self.assertEqual(len(sync.read_leetify_matches([{"id": "abc"}])), 1)
        self.assertEqual(len(sync.read_leetify_matches({"matches": [{"id":"abc"}]})), 1)
        with self.assertRaises(RuntimeError): sync.read_leetify_matches({"error": "oops"})

    def test_player_selection(self):
        stats = [{"steam64_id": "other", "total_kills": 8}, {"steam64_id": SID, "total_kills": 25}]
        self.assertEqual(sync.get_player_stats({"stats":stats}, SID)["total_kills"], 25)
        self.assertIsNone(sync.get_player_stats({"stats":[{},{}]}, SID))
        self.assertEqual(sync.get_player_stats({"stats":[{"total_kills":19}]}, SID)["total_kills"], 19)
        self.assertIsNone(sync.get_player_stats({"stats":[{"steam64_id":"other","total_kills":19}]}, SID))

    def test_documented_leetify_fields(self):
        self.assertEqual(sync.outcome({"rounds_won":13,"rounds_lost":3}), "win")
        self.assertEqual(sync.outcome({"rounds_won":4,"rounds_lost":13}), "loss")
        self.assertEqual(sync.outcome({"rounds_won":12,"rounds_lost":12}), "tie")
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            match = {"data_source":"matchmaking", "player_stats":{"steam64_id":SID,"dpr":160.81,"rounds_won":13,"rounds_lost":3}}
            with patch.object(sync, "DATA", root/"data"), patch.object(sync, "REPORTS", root/"reports"):
                sync.build_report([match], {CODE1}, True, SID)
                report=(root/"reports"/"latest.md").read_text()
                self.assertIn("覆盖率暂不可验证", report)
                snapshot=sync.read_json(root/"reports"/"snapshot.json", {})
                self.assertIsNone(snapshot["steam_codes_not_yet_in_leetify"])
                self.assertIn("160.81", (root/"reports"/"match_history.csv").read_text())

    def test_steam_cursor_and_idempotency(self):
        with tempfile.TemporaryDirectory() as tmp:
            with patch.object(sync, "DATA", Path(tmp)):
                settings = {"STEAMID64":SID,"STEAM_WEB_API_KEY":"test","STEAM_MATCH_AUTH_CODE":"test","STEAM_KNOWNCODE":CODE1}
                def fake_get(url, query, bearer=""):
                    if query["knowncode"] == CODE1: return {"result":{"nextcode":CODE2}}
                    return {"result":{"nextcode":"n/a"}}
                with patch.dict("os.environ", settings, clear=True), patch.object(sync, "get_json", side_effect=fake_get), patch.object(sync.time, "sleep", return_value=None):
                    codes, enabled = sync.sync_steam_codes()
                    self.assertEqual(codes, {CODE1, CODE2})
                    self.assertTrue(enabled)
                    codes2, enabled2 = sync.sync_steam_codes()
                    self.assertEqual(codes2, codes)
                    self.assertEqual(sync.read_json(Path(tmp)/"official_codes.json", {})["cursor"],CODE2)

    def test_normalize_official_only(self):
        sample = {"id":"123", "data_source":"matchmaking", "stats":[{"steam64_id":SID,"total_kills":22}]}
        self.assertEqual(sync.normalize_match(sample,SID)["player_stats"]["total_kills"],22)
        self.assertIsNone(sync.normalize_match({**sample,"data_source":"faceit"},SID))

    def test_steam_partial_discovery_is_saved_before_later_api_failure(self):
        with tempfile.TemporaryDirectory() as tmp, patch.object(sync,'DATA',Path(tmp)):
            settings={'STEAMID64':SID,'STEAM_WEB_API_KEY':'test','STEAM_MATCH_AUTH_CODE':'test','STEAM_KNOWNCODE':CODE1}
            with patch.dict('os.environ',settings,clear=True), \
                 patch.object(sync,'get_json',side_effect=[{'result':{'nextcode':CODE2}},RuntimeError('rate limited')]), \
                 patch.object(sync.time,'sleep',return_value=None):
                with self.assertRaises(RuntimeError): sync.sync_steam_codes()
            saved=sync.read_json(Path(tmp)/'official_codes.json',{})
            self.assertEqual(saved['cursor'],CODE2)
            self.assertEqual(saved['codes'],[CODE1,CODE2])

    def test_reports(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            with patch.object(sync, "DATA", root/"data"), patch.object(sync, "REPORTS", root/"reports"):
                matches = [
                    {"finished_at":"2026-10-14T09:00:00Z","map_name":"de_mirage","data_source":"matchmaking","data_source_match_id":CODE2,"player_stats":{"match_outcome":"win","total_kills":20,"total_deaths":10}},
                    {"finished_at":"2026-10-13T09:00:00Z","map_name":"de_nuke","data_source":"matchmaking","data_source_match_id":CODE1,"player_stats":None},
                ]
                sync.build_report(matches, {CODE1,CODE2}, True, SID)
                report=(root/"reports"/"latest.md").read_text(encoding="utf-8")
                self.assertIn("2.00",report)
                self.assertIn("缺少个人详细统计：**1**",report)
                self.assertTrue((root/"reports"/"match_history.csv").is_file())

if __name__ == "__main__": unittest.main()
