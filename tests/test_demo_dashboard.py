import json
from pathlib import Path
import tempfile
import unittest

from cs2demo.dashboard import generate_dashboard
from cs2demo.shards import load_dashboard
from cs2demo.report import generate_reports, load_validated_matches
from tests.test_demo_report import fixture_id


SID = "76561198096123254"
OTHER = "76561198000000000"


def write_json(path, value):
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(value), encoding="utf-8")


def round_record(number=1, **extra):
    return {"round_number": number, "side": "T", "won": True,
            "start_tick": 100, "end_tick": 740, "winner": 2,
            "kills": 1, "deaths": 1, "assists": 0, "damage": 100,
            "headshot_kills": 1, "opening_kill": True, "opening_death": False,
            "survived": False, "traded": False, "kast": True, "positions": [], **extra}


def match_record(job_id, rounds=None, **extra):
    return {"schema_version": "1.0", "match_id": fixture_id(job_id),
            "player": {"steamid": SID, "name": "Self"}, "map_name": "de_ancient",
            "rounds": rounds if rounds is not None else [round_record()],
            "summary": {"adr": 90000, "by_weapon": {}},
            "parsed_at": "2026-10-15T07:00:00Z", "match_started_at": "2026-10-09T14:00:00Z",
            "provenance": {"tickrate": 64, "position_sample_seconds": 2, "match_time_verified": True},
            "limitations": ["Observed live rounds only."], **extra}


class DashboardTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.root = Path(self.tmp.name)
        self.data, self.reports = self.root / "data", self.root / "reports"
        self.jobs = {}

    def tearDown(self):
        self.tmp.cleanup()

    def add(self, job_id, result=None, **job_extra):
        stable_id = fixture_id(job_id)
        self.jobs[stable_id] = {"id": stable_id, "status": "complete", "source": "steam_gc",
                             "result_path": f"demo_matches/{stable_id}.json", **job_extra}
        write_json(self.data / "demo_matches" / f"{stable_id}.json", result or match_record(job_id))

    def export(self, **queue_extra):
        write_json(self.data / "demo_jobs.json", {"schema_version": 1, "steamid64": SID, "jobs": self.jobs, **queue_extra})
        return generate_dashboard(self.data, self.reports, SID)

    def test_aggregate_uses_round_and_event_denominators_not_summary_averages(self):
        self.add("short", match_record("short", [round_record(kills=2, headshot_kills=1)]))
        longer = [round_record(i + 1, side="CT", kills=0, headshot_kills=0, damage=0, kast=False)
                  for i in range(9)]
        self.add("long", match_record("long", longer, map_name="de_dust2"))
        result = self.export()
        self.assertEqual(result["aggregate"]["rounds"], 10)
        self.assertEqual(result["aggregate"]["adr"], 10)
        self.assertEqual(result["aggregate"]["kast_pct"], 10)
        self.assertEqual(result["aggregate"]["headshot_pct"], 50)
        self.assertEqual(result["aggregate"]["kd"], .2)
        short = next(row for row in result["matches"] if row["match_id"] == fixture_id("short"))
        self.assertEqual(short["summary"]["adr"], 100)
        self.assertEqual(result["by_side"]["CT"]["rounds"], 9)
        self.assertEqual(result["by_map"]["de_dust2"]["rounds"], 9)

    def test_foreign_orphan_pending_and_duplicate_source_are_excluded(self):
        digest = "a" * 64
        self.add("self", match_record("self", provenance={"source_sha256": digest}))
        self.add("duplicate", match_record("duplicate", provenance={"source_sha256": digest}), source="local_file")
        self.add("foreign", match_record("foreign", player={"steamid": OTHER}))
        self.add("pending", status="pending")
        write_json(self.data / "demo_matches" / "orphan.json", match_record("orphan"))
        self.jobs["outside"] = {"status": "complete", "result_path": "../outside.json"}
        write_json(self.root / "outside.json", match_record("outside"))
        result = self.export()
        self.assertEqual([row["match_id"] for row in result["matches"]], [fixture_id("self")])
        self.assertEqual({row["reason"] for row in result["excluded"]}, {
            "duplicate_demo_sha256", "result_account_mismatch", "result_path_outside_demo_matches"})
        self.assertEqual(result["sync"]["status_counts"]["pending"], 1)
        self.assertFalse(result["coverage"]["official_match_coverage_known"])
        self.assertEqual(self.export(steamid64=OTHER)["matches"], [])

    def test_no_queue_never_reads_orphan_or_fills_unknown_metrics_with_zero(self):
        write_json(self.data / "demo_matches" / "orphan.json", match_record("orphan"))
        result = generate_dashboard(self.data, self.reports, SID)
        self.assertEqual(result["matches"], [])
        self.assertIsNone(result["aggregate"]["adr"])
        self.assertIsNone(result["aggregate"]["headshot_pct"])
        self.assertIsNone(result["generated_at"])
        self.assertIsNone(result["sync"]["last_run_at"])
        self.assertIsNone(result["sync"]["completed_this_run"])
        self.assertEqual(result["training_plan"]["priorities"], [])

    def test_sparse_positions_keep_real_coordinates_timing_and_place(self):
        points = [{"tick": 100, "x": -230.5, "y": 40, "z": -20, "place": "Mid"},
                  {"tick": 228, "x": -100, "y": 100, "z": -20},
                  {"tick": 250, "x": float("nan"), "y": 0, "z": 0}]
        self.add("own", match_record("own", [round_record(positions=points)]))
        item = self.export()["matches"][0]
        row = item["rounds"][0]
        self.assertEqual(row["elapsed_seconds"], 10)
        self.assertEqual([point["seconds"] for point in row["positions"]], [0, 2])
        self.assertEqual(row["positions"][0]["x"], -230.5)
        self.assertEqual(row["positions"][0]["place"], "Mid")
        self.assertEqual(row["evidence_id"], f"{fixture_id('own')}:r1")
        self.assertEqual(item["capabilities"]["positions"], "sampled")
        self.assertEqual(item["capabilities"]["aim"], "not_captured")
        self.assertIsNone(row["aim"])
        self.assertEqual(row["events"], [])

    def test_advanced_rounds_preserve_nulls_evidence_and_analysis_definitions(self):
        advanced = {"aim": {"firearm_shots": 0, "moving_shot_pct": None},
                    "economy": {"balance": 0, "equipment_value": None},
                    "timeline": [{"type": "damage", "tick": 164, "damage": 20}],
                    "positioning": {"death_positions": [{"x": -10, "y": 20, "z": 5}]}}
        analysis = {"version": "2.0", "level2": {"opening_conversion": {"wins": 0, "rate": None}},
                    "level3": {"reaction": {"status": "unavailable", "value": None, "reason": "Visibility not verified"}},
                    "definitions": {"moving_shot_pct": "Thresholded observed speed, not a counter-strafe grade"}}
        self.add("own", match_record("own", [round_record(analysis=advanced)], analysis=analysis))
        item = self.export()["matches"][0]
        row = item["rounds"][0]
        self.assertEqual(item["analysis"], analysis)
        self.assertEqual(row["analysis"], advanced)
        self.assertIsNone(row["aim"]["moving_shot_pct"])
        self.assertEqual(row["economy"]["balance"], 0)
        self.assertEqual(row["events"][0]["seconds"], 1)
        self.assertEqual(row["events"][0]["evidence_id"], f"{fixture_id('own')}:r1:e0")
        self.assertEqual(item["capabilities"]["timeline_events"], "available")
        self.assertEqual(item["capabilities"]["economy"], "available")

    def test_display_counter_labels_survive_while_acquisition_fields_stay_private(self):
        positions = {"place_samples": {"Bombsite A": 4, "长门": 2, "Secret": 3, "bad\nlabel": 1,
                                       "http://private.invalid": 2, "refresh_token": "do-not-export"},
                     "deaths_by_place": {"Long A": 2}, "api_key": "never-export"}
        self.add("own", match_record("own", analysis={"version": "2.0", "level3": {"positioning": positions}}))
        item = self.export()["matches"][0]
        exported = item["analysis"]["level3"]["positioning"]
        self.assertEqual(exported["place_samples"], {"Bombsite A": 4, "长门": 2, "Secret": 3})
        self.assertEqual(exported["deaths_by_place"], {"Long A": 2})
        self.assertNotIn("api_key", exported)
        self.assertNotIn("never-export", json.dumps(item))
        self.assertNotIn("do-not-export", json.dumps(item))

    def test_capabilities_separate_event_counts_from_motion_and_heuristic_coverage(self):
        row = round_record(analysis={"aim": {"firearm_shots": 20, "shots_with_speed": 0}, "timeline": []})
        advanced = {"version": "2.0", "level2": {"engagements": {"observed_episodes": 0}},
                    "level3": {"decision_quality": {"status": "unavailable", "score": None, "reason": "not_enough_evidence"},
                               "crosshair": {"status": "unavailable", "reason": "dense_angle_window_incomplete"}}}
        self.add("own", match_record("own", [row], analysis_version="2.0", analysis=advanced))
        item = self.export()["matches"][0]
        self.assertEqual(item["analysis_version"], "2.0")
        self.assertEqual(item["capabilities"]["advanced"], "available")
        self.assertEqual(item["capabilities"]["aim"], "available")
        self.assertEqual(item["capabilities"]["shot_motion"], "unavailable")
        self.assertEqual(item["capability_details"]["shot_motion"]["observations"], 0)
        self.assertEqual(item["capability_details"]["shot_motion"]["denominator"], 20)
        self.assertEqual(item["capabilities"]["duels"], "observed_subset")
        self.assertEqual(item["capabilities"]["decision_quality"], "unavailable")
        self.assertEqual(item["capability_details"]["crosshair"]["reason"], "dense_angle_window_incomplete")
        self.assertEqual(item["capabilities"]["trade_success"], "unavailable")
        advanced["level3"]["decision_quality"].update(score=62, status="heuristic", scored_rounds=1)
        row["analysis"]["aim"]["shots_with_speed"] = 8
        self.add("own", match_record("own", [row], analysis=advanced))
        item = self.export()["matches"][0]
        self.assertEqual(item["analysis_version"], "2.0")
        self.assertEqual(item["capabilities"]["shot_motion"], "observed")
        self.assertEqual(item["capabilities"]["decision_quality"], "heuristic")
        self.assertEqual(item["capability_details"]["decision_quality"]["observations"], 1)
        self.add("own", match_record("own"))
        legacy = self.export()["matches"][0]
        self.assertIsNone(legacy["analysis_version"])
        self.assertEqual(legacy["capabilities"]["advanced"], "not_captured")
        self.assertEqual(legacy["capabilities"]["duels"], "not_captured")

    def test_legacy_dense_braking_is_redacted_without_changing_event_motion_or_current_models(self):
        counter = {"status": "observed", "first_burst_shots": 2, "shots_with_speed": 2,
                   "moving_first_burst_shots": 1, "moving_first_burst_pct": 50,
                   "median_stop_to_shot_ms": 62.5, "observed_braking_shots": 1,
                   "complete_movement_windows": 2,
                   "observations": [{"tick": 300, "speed": 0, "airborne": False,
                                     "prior_peak_speed": 240, "stop_tick": 296,
                                     "stop_to_shot_ms": 62.5, "status": "observed", "reason": None}]}
        aim = {"firearm_shots": 2, "shots_with_speed": 2, "moving_shots": 1,
               "shot_observations": [{"tick": 300, "speed": 0, "pitch": 2, "yaw": 90}]}
        crosshair = {"status": "observed", "median_path_degrees": 12.5}

        def source(version):
            return match_record("own", [round_record(analysis={"aim": aim, "level3": {"counter_strafe": counter, "crosshair": crosshair}})],
                                analysis_version=version, analysis={"version": version,
                                "level3": {"aim": aim, "counter_strafe": counter, "crosshair": crosshair}})

        original = source("2.0")
        self.add("own", original)
        result = self.export()["matches"][0]
        self.assertEqual(result["summary"]["damage"], 100)
        self.assertEqual(result["analysis"]["level3"]["aim"], aim)
        self.assertEqual(result["rounds"][0]["aim"], aim)
        self.assertEqual(result["analysis"]["level3"]["crosshair"], crosshair)
        for exported in (result["analysis"]["level3"]["counter_strafe"], result["rounds"][0]["analysis"]["level3"]["counter_strafe"]):
            for field in ("median_stop_to_shot_ms", "observed_braking_shots", "complete_movement_windows"):
                self.assertIsNone(exported[field])
            self.assertEqual(exported["dense_motion_reason"], "dense_motion_requires_analysis_2_1")
            self.assertEqual(exported["shots_with_speed"], 2)
            self.assertEqual(exported["moving_first_burst_pct"], 50)
            for observation in exported["observations"]:
                self.assertEqual(observation["status"], "unavailable")
                self.assertEqual(observation["reason"], "dense_motion_requires_analysis_2_1")
                self.assertEqual(observation["speed"], 0)
                for field in ("prior_peak_speed", "stop_tick", "stop_to_shot_ms"):
                    self.assertIsNone(observation[field])
        # A frontend that recomputes the median from scoped observations has no
        # remaining invalid stop values. The original acquired result is intact.
        observations = result["rounds"][0]["analysis"]["level3"]["counter_strafe"]["observations"]
        self.assertEqual([row["stop_to_shot_ms"] for row in observations if row["stop_to_shot_ms"] is not None], [])
        self.assertEqual(json.loads((self.data / f"demo_matches/{fixture_id('own')}.json").read_text()), original)
        for version in ("2.1",):
            self.add("own", source(version))
            current = self.export()["matches"][0]
            self.assertEqual(current["analysis"]["level3"]["counter_strafe"], counter)
            self.assertEqual(current["rounds"][0]["analysis"]["level3"]["counter_strafe"], counter)

    def test_training_rules_link_actual_rounds_and_never_claim_model_analysis(self):
        self.add("own", match_record("own", [
            round_record(1, kills=0, headshot_kills=0, damage=0, opening_kill=False, opening_death=True, kast=False),
            round_record(2, kills=3, headshot_kills=1, damage=240, traded=True),
        ]))
        result = self.export()
        plan = result["training_plan"]
        self.assertEqual(plan["kind"], "deterministic")
        self.assertFalse(plan["generated_by_model"])
        self.assertTrue(plan["sample_warning"])
        ids = {row["evidence_id"] for row in result["matches"][0]["rounds"]}
        for priority in plan["priorities"]:
            self.assertTrue(set(priority["evidence_ids"]).issubset(ids))
            self.assertEqual(priority["confidence"], "low")
        zero = next(row for row in plan["priorities"] if row["id"] == "review_zero_damage_deaths")
        self.assertEqual(zero["evidence_ids"], [f"{fixture_id('own')}:r1"])
        self.assertEqual(result["ai_coach"]["status"], "not_configured")
        self.assertIsNone(result["ai_coach"]["analysis"])
        self.assertIsNone(result["ai_coach"]["model"])

    def test_refresh_time_is_utc_stable_and_private_failure_details_are_not_exported(self):
        self.add("own")
        self.jobs["retry"] = {"status": "retry", "last_error_code": "download_network_error",
                              "last_error": "secret-inline", "url": "http://private.invalid?token=secret",
                              "failure_details": {"secret": "do-not-export"}}
        write_json(self.reports / "demo_status.json", {
            "last_run_at": "2026-10-15T16:00:00+08:00", "run_outcome": "partial",
            "attempted_this_run": 1, "completed_this_run": 0, "secret": "worker-secret"})
        result = self.export()
        self.assertEqual(result["generated_at"], "2026-10-15T08:00:00+00:00")
        self.assertEqual(result["sync"]["run_outcome"], "partial")
        text = json.dumps(load_dashboard(self.reports))
        self.assertNotIn("private.invalid", text)
        self.assertNotIn("worker-secret", text)
        self.assertNotIn("secret-inline", text)
        before = (self.reports / "dashboard.index.json").stat().st_mtime_ns
        self.assertEqual(self.export(), result)
        self.assertEqual((self.reports / "dashboard.index.json").stat().st_mtime_ns, before)
        self.assertFalse((self.reports / "dashboard.json").exists())

    def test_unverified_time_disables_trend_and_returns_null_match_time(self):
        self.add("unknown", match_record("unknown", provenance={"tickrate": 64}))
        result = self.export()
        self.assertEqual(result["chronology"]["basis"], "parse_order")
        self.assertFalse(result["comparison"]["trend_supported"])
        self.assertIsNone(result["matches"][0]["match_started_at"])
        self.assertFalse(result["matches"][0]["match_time_verified"])

    def test_shared_loader_and_report_export_use_identical_validated_matches(self):
        self.add("own")
        self.add("foreign", match_record("foreign", player={"steamid": OTHER}))
        self.export()
        validated = load_validated_matches(self.data, SID)
        report = generate_reports(self.data, self.reports, SID)
        dashboard = load_dashboard(self.reports)
        self.assertEqual([row["match_id"] for row in validated["matches"]], [fixture_id("own")])
        for field in ("aggregate", "comparison", "by_map", "by_side", "by_weapon", "coverage", "excluded"):
            self.assertEqual(report[field], dashboard[field])


if __name__ == "__main__":
    unittest.main()
