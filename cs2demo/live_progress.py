"""Best-effort live progress for a private GitHub Actions Demo sync."""

from __future__ import annotations

import base64
from collections import deque
from datetime import datetime, timezone
import json
import os
import re
from threading import Condition, Thread
import time
from urllib.error import HTTPError, URLError
from urllib.request import HTTPRedirectHandler, Request, build_opener


BRANCH = "cs2-sync-progress"
FILENAME = "demo-sync-progress.json"
MAX_RECORD_BYTES = 8 * 1024
MAX_TRANSFER_BYTES = 2 * 1024**3
PHASES = frozenset({
    "discovering", "resolving", "connecting", "downloading", "decompressing",
    "validating", "parsing", "analyzing", "saving", "checkpointing", "reporting",
    "retrying", "settled", "finished",
})
PARSER_STAGES = frozenset({
    "start", "header", "player_info", "events", "positions", "metrics", "all_player_metrics",
    "advanced_metrics", "crosshair_windows", "mechanics_targets", "radar_replay", "tactical_replay",
})
OUTCOMES = frozenset({
    "idle", "ok", "partial", "failed", "blocked_auth", "waiting_for_replays",
    "deferred_steam_playing_elsewhere",
})
BATCH_COUNTS = ("selected_this_run", "attempted_this_run", "completed_this_run", "deferred_this_run", "settled_this_run")
HISTORY_FIELDS = ("phase", "job_id", "job_index", "attempt", "parser_stage", "error_code")
SHA = re.compile(r"[0-9a-f]{40}")
RUN = re.compile(r"[1-9][0-9]{0,15}")
ATTEMPT = re.compile(r"[1-9][0-9]{0,5}")
REPOSITORY = re.compile(r"[A-Za-z0-9_-]{1,100}/[A-Za-z0-9_.-]{1,100}")
SAFE_TOKEN = re.compile(r"[A-Za-z0-9_.-]{1,512}")


class _NeverRedirect(HTTPRedirectHandler):
    """The workflow token only goes to the fixed GitHub API origin."""

    def redirect_request(self, req, fp, code, msg, headers, newurl):
        return None


class _GitHubProgressStore:
    def __init__(self, repository, base_sha, token, *, request=None):
        self._project = f"/repos/{repository}"
        self._base_sha = base_sha
        self._token = token
        self._request = request or self._github_request
        self._ready = False
        self._project_private = None
        self._read_sha = True
        self._sha = None
        self._opener = build_opener(_NeverRedirect())

    def _github_request(self, method, path, payload=None):
        headers = {
            "Accept": "application/vnd.github+json",
            "Authorization": f"Bearer {self._token}",
            "Content-Type": "application/json",
            "User-Agent": "cs2-demo-sync-progress",
            "X-GitHub-Api-Version": "2022-11-28",
        }
        data = json.dumps(payload).encode() if payload is not None else None
        request = Request(f"https://api.github.com{path}", data, headers, method=method)
        try:
            with self._opener.open(request, timeout=4) as response:
                data = response.read(32 * 1024 + 1)
                body = json.loads(data) if 0 < len(data) <= 32 * 1024 else None
                return response.status, body if isinstance(body, dict) else {}
        except HTTPError as error:
            error.close()
            return error.code, {}
        except (URLError, OSError, ValueError):
            return 0, {}

    def _prepare(self):
        if self._project_private is None:
            status, data = self._request("GET", self._project)
            if status != 200:
                return False
            self._project_private = data.get("private") is True
        if not self._project_private:
            return False
        path = f"{self._project}/git/ref/heads/{BRANCH}"
        status, _ = self._request("GET", path)
        if status == 404:
            status, _ = self._request("POST", f"{self._project}/git/refs", {
                "ref": f"refs/heads/{BRANCH}", "sha": self._base_sha,
            })
            if status == 422:
                status, _ = self._request("GET", path)
        self._ready = status in (200, 201)
        return self._ready

    def __call__(self, document):
        if not self._ready and not self._prepare():
            return
        path = f"{self._project}/contents/{FILENAME}"
        if self._read_sha:
            status, data = self._request("GET", f"{path}?ref={BRANCH}")
            sha = data.get("sha", "")
            if status == 200 and isinstance(sha, str) and SHA.fullmatch(sha):
                self._sha = sha
            elif status == 404:
                self._sha = None
            else:
                return
            self._read_sha = False
        content = json.dumps(document, separators=(",", ":")).encode()
        if len(content) > MAX_RECORD_BYTES:
            return
        payload = {
            "message": "Record Demo sync progress [skip ci]",
            "branch": BRANCH,
            "content": base64.b64encode(content).decode("ascii"),
        }
        if self._sha:
            payload["sha"] = self._sha
        status, data = self._request("PUT", path, payload)
        saved = data.get("content")
        new_sha = saved.get("sha") if isinstance(saved, dict) else None
        if status in (200, 201) and isinstance(new_sha, str) and SHA.fullmatch(new_sha):
            self._sha = new_sha
        else:
            # A conflicted or uncertain response may already have advanced the file.
            # Refresh its compare-and-swap value on the next event.
            self._read_sha = True


def _integer(value, minimum, maximum):
    return type(value) is int and minimum <= value <= maximum


def _utc(value):
    if not isinstance(value, str) or len(value) > 40:
        return None
    try:
        time_value = datetime.fromisoformat(value.replace("Z", "+00:00"))
        if time_value.tzinfo is not None:
            return time_value.astimezone(timezone.utc).isoformat(timespec="seconds").replace("+00:00", "Z")
    except (ValueError, OverflowError):
        pass
    return None


def _safe_fields(phase, fields):
    result = {}
    for name, minimum, maximum in (
        ("job_index", 1, 20), ("attempt", 1, 20), ("received_bytes", 0, MAX_TRANSFER_BYTES),
        ("total_bytes", 1, MAX_TRANSFER_BYTES),
    ):
        value = fields.get(name)
        if _integer(value, minimum, maximum):
            result[name] = value
    if result.get("received_bytes", 0) > result.get("total_bytes", MAX_TRANSFER_BYTES):
        result.pop("total_bytes", None)
    for name, pattern in (("job_id", r"[a-f0-9]{24}"), ("error_code", r"[a-z0-9_]{1,64}")):
        value = fields.get(name)
        if isinstance(value, str) and re.fullmatch(pattern, value):
            result[name] = value
    for name, allowed in (("parser_stage", PARSER_STAGES), ("run_outcome", OUTCOMES if phase == "finished" else ())):
        value = fields.get(name)
        if isinstance(value, str) and value in allowed:
            result[name] = value
    retry = _utc(fields.get("retry_at"))
    if retry:
        result["retry_at"] = retry
    return result


class LiveProgress:
    """Coalesce observed updates in a background writer and reserve a final write."""

    def __init__(self, run_id, run_attempt, store, *, interval=5, write_limit=48):
        self._identity = {"schema_version": 1, "workflow_run_id": run_id, "workflow_run_attempt": run_attempt}
        self._store = store
        self._interval = interval
        self._write_limit = write_limit
        self._condition = Condition()
        self._pending = None
        self._closing = False
        self._sequence = 0
        self._counts = {}
        self._history = deque(maxlen=8)
        self._thread = Thread(target=self._publish, name="demo-live-progress", daemon=True)
        self._thread.start()

    @classmethod
    def from_environment(cls):
        env = os.environ
        if env.get("GITHUB_ACTIONS") != "true" or env.get("GITHUB_REF") != "refs/heads/main":
            return None
        repository = env.get("GITHUB_REPOSITORY", "")
        base_sha = env.get("GITHUB_SHA", "")
        token = env.get("CS2_LIVE_PROGRESS_TOKEN", "")
        run_id = env.get("GITHUB_RUN_ID", "")
        run_attempt = env.get("GITHUB_RUN_ATTEMPT", "")
        if not (REPOSITORY.fullmatch(repository) and repository.rsplit("/", 1)[-1] not in {".", ".."}
                and SHA.fullmatch(base_sha) and SAFE_TOKEN.fullmatch(token)
                and RUN.fullmatch(run_id) and ATTEMPT.fullmatch(run_attempt)):
            return None
        return cls(run_id, int(run_attempt), _GitHubProgressStore(repository, base_sha, token))

    def update(self, phase, **fields):
        if not isinstance(phase, str) or phase not in PHASES:
            return
        observed = {"phase": phase, **_safe_fields(phase, fields)}
        now = datetime.now(timezone.utc).isoformat(timespec="seconds").replace("+00:00", "Z")
        history = {key: observed[key] for key in HISTORY_FIELDS if key in observed}
        with self._condition:
            if self._closing:
                return
            for key in BATCH_COUNTS:
                if _integer(fields.get(key), 0, 20):
                    self._counts[key] = fields[key]
            last = self._history[-1] if self._history else {}
            if not last or history != {key: last[key] for key in HISTORY_FIELDS if key in last}:
                self._history.append({"at": now, **history})
            self._sequence += 1
            self._pending = {
                **self._identity, "sequence": self._sequence, "updated_at": now,
                **self._counts, **observed, "recent": list(self._history),
            }
            self._condition.notify_all()

    def _publish(self):
        writes = 0
        next_write = 0
        while True:
            with self._condition:
                while not self._closing:
                    if self._pending is None or writes >= self._write_limit - 1:
                        self._condition.wait()
                        continue
                    delay = next_write - time.monotonic()
                    if delay <= 0:
                        break
                    self._condition.wait(delay)
                if self._pending is None or writes >= self._write_limit:
                    return
                document, self._pending = self._pending, None
            try:
                self._store(document)
            except Exception:
                # Never let an unavailable status channel interfere with Demo sync.
                pass
            writes += 1
            next_write = time.monotonic() + self._interval

    def close(self):
        with self._condition:
            self._closing = True
            self._condition.notify_all()
        self._thread.join(timeout=5)
