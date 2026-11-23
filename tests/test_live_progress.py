import base64
import json
import os
from threading import Event
import unittest
from unittest.mock import patch

from cs2demo.live_progress import BRANCH, FILENAME, LiveProgress, _GitHubProgressStore


class LiveProgressTests(unittest.TestCase):
    def test_transitions_coalesce_while_a_terminal_write_is_reserved(self):
        sent = []
        started = Event()
        release = Event()

        def store(record):
            sent.append(record)
            if len(sent) == 1:
                started.set()
                release.wait(2)

        progress = LiveProgress("12345", 2, store, write_limit=2)
        try:
            progress.update("discovering")
            self.assertTrue(started.wait(2))
            progress.update("connecting", selected_this_run=2, job_id="a" * 24, job_index=1, attempt=1)
            for size in range(1, 11):
                progress.update("downloading", job_id="a" * 24, job_index=1, attempt=1,
                                received_bytes=size, total_bytes=10)
            progress.update("parsing", job_id="a" * 24, job_index=1, parser_stage="events")
            progress.update("finished", attempted_this_run=2, completed_this_run=1,
                            settled_this_run=2, run_outcome="partial")
        finally:
            release.set()
            progress.close()
        self.assertEqual([item["phase"] for item in sent], ["discovering", "finished"])
        last = sent[-1]
        self.assertEqual(last["workflow_run_id"], "12345")
        self.assertEqual(last["workflow_run_attempt"], 2)
        self.assertEqual(last["schema_version"], 1)
        self.assertEqual(last["run_outcome"], "partial")
        self.assertEqual(last["selected_this_run"], 2)
        self.assertEqual(last["settled_this_run"], 2)
        self.assertNotIn("job_id", last)
        self.assertNotIn("received_bytes", last)
        self.assertEqual([item["phase"] for item in last["recent"]],
                         ["discovering", "connecting", "downloading", "parsing", "finished"])
        self.assertTrue(all(item["at"].endswith("Z") for item in last["recent"]))

    def test_frame_drops_unbounded_details_instead_of_guessing_totals(self):
        sent = []
        progress = LiveProgress("12345", 1, sent.append, write_limit=1)
        try:
            progress.update("downloading", url="https://example.invalid/private",
                            job_id="personal-match", parser_stage="fake-stage", selected_this_run=True,
                            received_bytes=26, total_bytes=25, run_outcome="ok", error_code="x/private")
        finally:
            progress.close()
        frame = sent[0]
        self.assertEqual(frame["received_bytes"], 26)
        self.assertFalse({"url", "job_id", "parser_stage", "selected_this_run", "total_bytes", "run_outcome", "error_code"}
                         .intersection(frame))
        self.assertNotIn("private", json.dumps(frame))

    def test_writer_failure_is_isolated_from_sync(self):
        called = Event()

        def store(_):
            called.set()
            raise OSError("fixture status transport failure")

        progress = LiveProgress("12345", 1, store)
        progress.update("finished", run_outcome="failed")
        progress.close()
        self.assertTrue(called.is_set())

    def test_live_writer_only_activates_for_trusted_action_environment(self):
        with patch.dict(os.environ, {"CS2_LIVE_PROGRESS_TOKEN": "fixture-token"}, clear=True):
            self.assertIsNone(LiveProgress.from_environment())
        env = {"GITHUB_ACTIONS": "true", "GITHUB_REF": "refs/heads/main", "GITHUB_REPOSITORY": "owner/repository",
               "GITHUB_SHA": "f" * 40, "GITHUB_RUN_ID": "123456", "GITHUB_RUN_ATTEMPT": "1"}
        with patch.dict(os.environ, env, clear=True):
            self.assertIsNone(LiveProgress.from_environment())


class GitHubProgressStoreTests(unittest.TestCase):
    def test_store_wont_touch_a_public_repository_ref(self):
        calls = []

        def request(method, path, payload=None):
            calls.append((method, path, payload))
            return 200, {"private": False}

        store = _GitHubProgressStore("owner/repository", "a" * 40, "fixture", request=request)
        store({"phase": "parsing"})
        store({"phase": "finished"})
        self.assertEqual(calls, [("GET", "/repos/owner/repository", None)])

    def test_private_progress_ref_initialization_and_ordinary_contents_cas(self):
        calls = []
        statuses = iter([
            (200, {"private": True}), (404, {}), (201, {}), (404, {}),
            (201, {"content": {"sha": "b" * 40}}), (409, {}),
            (200, {"sha": "c" * 40}), (200, {"content": {"sha": "d" * 40}}),
        ])

        def request(method, path, payload=None):
            calls.append((method, path, payload))
            return next(statuses)

        store = _GitHubProgressStore("owner/repository", "a" * 40, "fixture", request=request)
        for phase in ["discovering", "parsing", "finished"]:
            store({"phase": phase})
        self.assertEqual(calls[2], ("POST", "/repos/owner/repository/git/refs", {
            "ref": f"refs/heads/{BRANCH}", "sha": "a" * 40,
        }))
        self.assertEqual(calls[6][1], f"/repos/owner/repository/contents/{FILENAME}?ref={BRANCH}")
        writes = [payload for method, _, payload in calls if method == "PUT"]
        self.assertTrue(all(payload["branch"] == BRANCH for payload in writes))
        self.assertTrue(all("force" not in payload for payload in writes))
        self.assertEqual([payload.get("sha") for payload in writes], [None, "b" * 40, "c" * 40])
        self.assertEqual([json.loads(base64.b64decode(payload["content"]))["phase"] for payload in writes],
                         ["discovering", "parsing", "finished"])
