import csv
from datetime import datetime, timedelta, timezone
import hashlib
import json
from pathlib import Path
import tempfile
import unittest

from cs2demo.report import generate_reports


SID = "76561198096123254"
OTHER = "76561198000000000"


def fixture_id(label):
    return hashlib.sha256(label.encode()).hexdigest()[:24]


def write_json(path, value):
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(value), encoding="utf-8")


def make_round(number=1, damage=100, kills=1, side="T", kast=True):
    return {
        "round_number": number, "side": side, "won": True,
        "kills": kills, "deaths": 1, "assists": 0, "damage": damage,
        "headshot_kills": kills, "opening_kill": bool(kills),
        "opening_death": False, "survived": False, "traded": False,
        "kast": kast, "positions": [],
    }


def make_match(job_id, rounds=None, steamid=SID, **extra):
    return {
        "schema_version": "1.0", "match_id": fixture_id(job_id),
        "map_name": "de_mirage", "player": {"steamid": steamid, "name": "self"},
        "rounds": rounds if rounds is not None else [make_round()],
        "summary": {"adr": 99999, "by_weapon": {}},
        "parsed_at": "2026-10-15T01:00:00+00:00",
        "provenance": {"trade_window_seconds": 5}, "limitations": [], **extra,
    }


class TestDemoReport(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.root = Path(self.tmp.name)
        self.data = self.root / "data"
        self.reports = self.root / "reports"
        self.jobs = {}

    def tearDown(self):
        self.tmp.cleanup()

    def add_match(self, job_id, match=None, status="complete", **job_extra):
        stable_id = fixture_id(job_id)
        self.jobs[stable_id] = {
            "id": stable_id, "status": status, "source": "steam_gc",
            "result_path": f"demo_matches/{stable_id}.json", **job_extra,
        }
        write_json(self.data / "demo_matches" / f"{stable_id}.json", match or make_match(job_id))

    def run_report(self, **queue_extra):
        write_json(self.data / "demo_jobs.json", {
            "schema_version": 1, "steamid64": SID, "jobs": self.jobs, **queue_extra,
        })
        return generate_reports(self.data, self.reports, SID)

    def test_recent_discovery_and_file_gaps_are_visible_without_raw_payloads(self):
        write_json(self.data/'gc_discovery.json',{
            'status':'discovered','last_checked_at':'2026-10-15T05:00:00Z',
            'returned_matches':8,'newly_queued':6,'unencodable_matches':0,
            'url':'http://private.invalid/token','secret':'do-not-render'})
        self.jobs={'a':{'status':'unavailable','last_error_code':'http_404',
                        'last_attempt_at':'2026-10-15T05:00:00Z','next_attempt_at':'2026-10-15T09:00:00Z'},
                   'b':{'status':'unavailable','last_error_code':'replay_url_unavailable'}}
        snapshot=self.run_report()
        report=(self.reports/'demo_latest.md').read_text()
        self.assertEqual(snapshot['gc_discovery']['returned_matches'],8)
        self.assertEqual(len(snapshot['unfinished_jobs']),2)
        self.assertIn('2026-10-15 13:00:00',report)
        self.assertIn('HTTP 404',report)
        self.assertIn('不能证明 Demo 已过期',report)
        self.assertNotIn('private.invalid',json.dumps(snapshot))
        self.assertNotIn('do-not-render',report)

    def test_empty_report_and_credential_retry_status_are_actionable(self):
        self.jobs = {
            "a": {"status": "blocked_auth"},
            "b": {"status": "retry", "last_error": "SECRET must never render"},
        }
        snapshot = self.run_report()
        self.assertEqual(snapshot["matches_analyzed"], 0)
        self.assertIsNone(snapshot["aggregate"]["adr"])
        self.assertIsNone(snapshot["aggregate"]["headshot_pct"])
        report = (self.reports / "demo_latest.md").read_text()
        self.assertIn("Steam GC 登录凭据", report)
        self.assertIn("待重试任务", report)
        self.assertIn("当前不生成个人表现结论", report)
        self.assertNotIn("SECRET", report)
        for filename in ("demo_history.csv", "demo_rounds.csv"):
            with (self.reports / filename).open() as fp:
                self.assertEqual(list(csv.DictReader(fp)), [])
        self.assertEqual(json.loads((self.reports / "demo_snapshot.json").read_text()), snapshot)

    def test_missing_queue_does_not_read_orphan_results(self):
        write_json(self.data / "demo_matches" / "orphan.json", make_match("orphan"))
        snapshot = generate_reports(self.data, self.reports, SID)
        self.assertEqual(snapshot["matches_analyzed"], 0)
        self.assertEqual(snapshot["queue_jobs"], 0)

    def test_only_complete_and_confirmed_self_results_are_used(self):
        self.add_match("self")
        self.add_match("other", make_match("other", steamid=OTHER))
        self.add_match("pending", status="pending")
        self.add_match("retry", status="retry")
        self.add_match("unknown-player", make_match("unknown-player", player={"name": "self"}))
        write_json(self.data / "demo_matches" / "orphan.json", make_match("orphan"))
        snapshot = self.run_report()
        self.assertEqual(snapshot["matches_analyzed"], 1)
        self.assertEqual(snapshot["aggregate"]["kills"], 1)
        self.assertEqual({item["reason"] for item in snapshot["excluded"]}, {"result_account_mismatch"})
        mismatch = self.run_report(steamid64=OTHER)
        self.assertEqual(mismatch["matches_analyzed"], 0)
        self.assertIn("queue_account_mismatch", [item["reason"] for item in mismatch["excluded"]])

    def test_aggregates_use_event_denominators_and_side_samples(self):
        self.add_match("a", make_match("a", [make_round(damage=100, kills=2)]))
        longer = [make_round(i + 1, damage=0, kills=0, side="CT", kast=False) for i in range(9)]
        self.add_match("b", make_match("b", longer))
        snapshot = self.run_report()
        self.assertEqual(snapshot["aggregate"]["adr"], 10)
        self.assertEqual(snapshot["aggregate"]["kast_pct"], 10)
        self.assertEqual(snapshot["aggregate"]["headshot_pct"], 100)
        self.assertEqual(snapshot["aggregate"]["kd"], 0.2)
        self.assertEqual(snapshot["by_side"]["T"]["rounds"], 1)
        self.assertEqual(snapshot["by_side"]["CT"]["rounds"], 9)
        self.assertEqual(snapshot["by_map"]["de_mirage"]["match_count"], 2)
        with (self.reports / "demo_rounds.csv").open() as fp:
            self.assertEqual(len(list(csv.DictReader(fp))), 10)

    def test_zero_kills_or_deaths_have_undefined_ratios(self):
        item = make_round(kills=0)
        item["deaths"] = 0
        self.add_match("empty-events", make_match("empty-events", [item]))
        snapshot = self.run_report()
        self.assertIsNone(snapshot["aggregate"]["headshot_pct"])
        self.assertIsNone(snapshot["aggregate"]["kd"])
        self.assertEqual(snapshot["aggregate"]["rounds"], 1)

    def test_parse_order_is_not_presented_as_match_chronology(self):
        for index in range(31):
            job_id = f"job{index:02}"
            parsed = (datetime(2026, 10, 1, tzinfo=timezone.utc) + timedelta(hours=index)).isoformat()
            self.add_match(job_id, make_match(job_id, parsed_at=parsed))
        snapshot = self.run_report()
        self.assertEqual(snapshot["comparison"]["recent30"]["match_count"], 30)
        self.assertEqual(snapshot["comparison"]["previous30"]["match_count"], 1)
        self.assertFalse(snapshot["comparison"]["trend_supported"])
        self.assertIsNone(snapshot["comparison"]["deltas"])
        self.assertEqual(snapshot["chronology"]["basis"], "parse_order")
        report = (self.reports / "demo_latest.md").read_text()
        self.assertIn("仅表示解析顺序", report)
        self.assertIn("不生成时间趋势比较", report)
        with (self.reports / "demo_history.csv").open() as fp:
            self.assertEqual(next(csv.DictReader(fp))["match_id"], fixture_id("job30"))

    def test_recent30_uses_verified_match_time_not_parse_time(self):
        for index in range(60):
            job_id = f"job{index:02}"
            match_time = (datetime(2026, 8, 1, tzinfo=timezone.utc) + timedelta(days=index)).isoformat()
            self.add_match(job_id, make_match(
                job_id, [make_round(damage=100 if index >= 30 else 50)],
                match_started_at=match_time,
                parsed_at=(datetime(2026, 10, 1, tzinfo=timezone.utc) - timedelta(hours=index)).isoformat(),
                provenance={"match_time_verified": True},
            ))
        snapshot = self.run_report()
        self.assertEqual(snapshot["chronology"]["basis"], "verified_match_time")
        self.assertTrue(snapshot["comparison"]["trend_supported"])
        self.assertEqual(snapshot["comparison"]["recent30"]["match_count"], 30)
        self.assertEqual(snapshot["comparison"]["previous30"]["match_count"], 30)
        self.assertEqual(snapshot["comparison"]["deltas"]["adr"], 50)
        with (self.reports / "demo_history.csv").open() as fp:
            self.assertEqual(next(csv.DictReader(fp))["match_id"], fixture_id("job59"))
        # A plain timestamp without explicit source verification cannot support a trend.
        path = self.data / "demo_matches" / f"{fixture_id('job00')}.json"
        match = json.loads(path.read_text())
        match["provenance"].pop("match_time_verified")
        write_json(path, match)
        self.assertEqual(self.run_report()["chronology"]["basis"], "parse_order")

    def test_missing_invalid_and_foreign_files_do_not_silently_count(self):
        self.add_match("valid")
        self.add_match("foreign", make_match("different"))
        self.add_match("bad-round", make_match("bad-round", [make_round(damage=float("nan"))]))
        self.add_match("duplicate-round", make_match("duplicate-round", [make_round(), make_round()]))
        self.add_match("new-schema", make_match("new-schema", schema_version="2.0"))
        self.jobs["outside"] = {"status": "complete", "result_path": "../outside.json"}
        self.jobs["missing"] = {"status": "complete", "result_path": "demo_matches/missing.json"}
        write_json(self.root / "outside.json", make_match("outside"))
        snapshot = self.run_report()
        self.assertEqual(snapshot["matches_analyzed"], 1)
        self.assertEqual(snapshot["aggregate"]["rounds"], 1)
        reasons = {item["reason"] for item in snapshot["excluded"]}
        self.assertEqual(reasons, {
            "result_job_id_mismatch", "invalid_or_empty_rounds", "duplicate_round_number",
            "unsupported_result_schema", "result_path_outside_demo_matches", "unreadable_result",
        })

    def test_weapon_events_no_implicit_leetify_merge_and_stable_output(self):
        match = make_match("a", summary={"by_weapon": {"ak47": {"kills": 2, "headshot_kills": 1, "damage": 210}}}, limitations=["缺少原始视角"])
        self.add_match("a", match, source="manual_url")
        self.add_match("b", make_match("b", summary=match["summary"]))
        snapshot = self.run_report()
        self.assertEqual(snapshot["matches_analyzed"], 2)
        self.assertEqual(snapshot["by_weapon"]["ak47"]["damage"], 420)
        self.assertFalse(snapshot["coverage"]["official_match_coverage_known"])
        report = (self.reports / "demo_latest.md").read_text()
        self.assertIn("不隐式合并去重", report)
        self.assertIn("不是 Leetify Rating", report)
        self.assertIn("缺少原始视角", report)
        self.assertIn("manual\\_url", report)
        before = {str(p.relative_to(self.reports)): (p.read_bytes(), p.stat().st_mtime_ns)
                  for p in self.reports.rglob('*') if p.is_file()}
        self.run_report()
        self.assertEqual(before, {str(p.relative_to(self.reports)): (p.read_bytes(), p.stat().st_mtime_ns)
                                 for p in self.reports.rglob('*') if p.is_file()})

    def test_csv_text_cannot_be_interpreted_as_spreadsheet_formula(self):
        self.add_match("a", make_match("a", map_name="=1+1"))
        self.run_report()
        with (self.reports / "demo_history.csv").open() as fp:
            self.assertEqual(next(csv.DictReader(fp))["map_name"], "'=1+1")

    def test_exact_file_sha_dedup_preserves_official_metadata(self):
        digest = "ab" * 32
        self.add_match("a-manual", make_match("a-manual", provenance={"source_sha256": digest}), source="manual_url")
        self.add_match("z-official", make_match(
            "z-official", match_started_at="2026-10-14T12:00:00Z",
            provenance={"source_sha256": digest, "match_time_verified": True},
        ))
        snapshot = self.run_report()
        self.assertEqual(snapshot["matches_analyzed"], 1)
        self.assertEqual(snapshot["chronology"]["basis"], "verified_match_time")
        self.assertEqual(snapshot["excluded"], [{
            "job_id": fixture_id("a-manual"), "reason": "duplicate_demo_sha256", "duplicate_of": fixture_id("z-official"),
        }])
        # A new file with the same map/time is not an exact-identity match.
        self.add_match("other-file", make_match(
            "other-file", match_started_at="2026-10-14T12:00:00Z",
            provenance={"source_sha256": "cd" * 32, "match_time_verified": True},
        ))
        self.assertEqual(self.run_report()["matches_analyzed"], 2)


if __name__ == "__main__":
    unittest.main()
