"""Persistent, incremental cloud worker independent of Leetify availability."""
from __future__ import annotations

import argparse
from datetime import datetime, timedelta, timezone
import hashlib
import json
import os
from pathlib import Path
import re
import subprocess
import sys
import tempfile
from threading import Event, Thread

from sync import SHARE_PATTERN, read_json
from .download import DownloadError, download_demo, materialize_demo
from .native_sources import (MANIFEST_NAME, NativeSourceError, fingerprint,
                             has_native_source, load_native_sources, record_native_source)

ROOT = Path(__file__).resolve().parents[1]
STEAM_PLAYING_ELSEWHERE = "steam_playing_elsewhere"
PARSER_STAGES = {"start", "header", "player_info", "events", "positions", "metrics",
                 "advanced_metrics", "all_player_metrics", "crosshair_windows",
                 "mechanics_targets", "radar_replay", "tactical_replay"}
REPLAY_WAIT_ERRORS = {"replay_url_unavailable", "gc_url_unavailable", "match_unavailable", "http_404"}
TRANSPORT_ERRORS = {"download_network_error", "download_socket_timeout", "download_connection_reset",
                    "download_timeout", "truncated_download", "http_408", "http_429",
                    "http_500", "http_502", "http_503", "http_504"}


def write_json_if_changed(path: Path, value):
    """Atomic checkpoints survive process termination without truncating the queue."""
    content = json.dumps(value, ensure_ascii=False, indent=2, sort_keys=True, allow_nan=False) + "\n"
    if path.exists() and path.read_text(encoding="utf-8") == content:
        return
    path.parent.mkdir(parents=True, exist_ok=True)
    temporary = None
    try:
        with tempfile.NamedTemporaryFile(mode="w", encoding="utf-8", dir=path.parent, delete=False) as fp:
            temporary = Path(fp.name)
            fp.write(content)
            fp.flush()
            os.fsync(fp.fileno())
        os.replace(temporary, path)
    finally:
        if temporary:
            temporary.unlink(missing_ok=True)


def read_parser_stage(path: Path):
    try:
        value = read_json(path, {})
        return value.get("stage") if isinstance(value, dict) else None
    except (OSError, ValueError):
        return None


def parse_bounded(path: Path, steamid: str, *, on_progress=None) -> dict:
    """Isolate the native parser: a crash/timeout must leave the parent queue intact."""
    output = path.parent / "parsed.json"
    progress_path = output.with_name("parse_progress.json")
    # The parser needs no credentials, including the Steam login session.
    parser_env = {key: value for key, value in os.environ.items()
                  if not key.startswith("STEAM_") and key not in {"LEETIFY_API_KEY", "CS2_DEMO_URL", "CS2_LIVE_PROGRESS_TOKEN"}}
    stop = Event()
    watch = None
    if on_progress:
        def monitor():
            previous = "start"
            while not stop.wait(0.5):
                stage = read_parser_stage(progress_path)
                if stage in PARSER_STAGES and stage != previous:
                    previous = stage
                    phase = "parsing" if stage in {"header", "player_info", "events", "positions"} else "analyzing"
                    on_progress(phase, parser_stage=stage)

        on_progress("parsing", parser_stage="start")
        watch = Thread(target=monitor, name="cs2-parser-progress", daemon=True)
        watch.start()
    try:
        proc = subprocess.run([sys.executable, "-m", "cs2demo.parse_worker", str(path), steamid, str(output)],
                              cwd=ROOT, env=parser_env, capture_output=True, timeout=240, check=False)
        if proc.returncode != 0 or not output.is_file():
            detail = read_json(output, {})
            code = detail.get("error_code", "")
            if not re.fullmatch(r"parser_[a-z_]{1,40}", str(code)):
                stderr = (proc.stderr or b"").lower()
                code = "parser_memory_limit" if any(s in stderr for s in (b"memory allocation", b"out of memory", b"cannot allocate memory")) else "parser_worker_failed"
            stage = detail.get("error_stage") or read_parser_stage(progress_path)
            if stage in PARSER_STAGES:
                code += "_" + stage
            raise DownloadError(code, details=detail.get("error_details") or {})
        return json.loads(output.read_text(encoding="utf-8"))
    except subprocess.TimeoutExpired:
        raise DownloadError("parser_timeout") from None
    finally:
        if watch:
            stop.set()
            watch.join()


def now_utc() -> datetime:
    return datetime.now(timezone.utc).replace(microsecond=0)


def job_id(value: str) -> str:
    return hashlib.sha256(value.encode()).hexdigest()[:24]


def ensure_account(data: Path, steamid: str):
    if not re.fullmatch(r"7656119\d{10}", steamid):
        raise RuntimeError("invalid_steamid64")
    account = read_json(data / "account.json", {})
    if account.get("steamid64") not in (None, steamid):
        raise RuntimeError("account_mismatch")
    write_json_if_changed(data / "account.json", {"steamid64": steamid})


def enqueue(state: dict, code: str | None = None, *, url: str | None = None, local: bool = False) -> dict:
    identity = code or url
    if not identity:
        raise RuntimeError("missing_job_identity")
    if code and not SHARE_PATTERN.fullmatch(code):
        raise RuntimeError("invalid_share_code")
    ident = job_id(identity)
    # A complete result is immutable unless explicitly reprocessed with a new schema.
    job = state["jobs"].setdefault(ident, {
        "id": ident, "share_code": code,
        "source": "local_file" if local else "manual_url" if url else "steam_gc",
        "status": "pending", "attempts": 0,
    })
    return job


def load_state(data: Path, steamid: str) -> dict:
    state = read_json(data / "demo_jobs.json", {"schema_version": 1, "steamid64": steamid, "jobs": {}})
    if state.get("schema_version") != 1 or state.get("steamid64") != steamid or not isinstance(state.get("jobs"), dict):
        raise RuntimeError("invalid_demo_state_or_account")
    for job in state["jobs"].values():
        if job.get("download_receipt") or job.get("last_error_code", "").startswith("parser_"):
            job["download_completed_before"] = True
    codes = read_json(data / "official_codes.json", {}).get("codes", [])
    # Insertion order is Steam discovery order; the worker prioritises newest pending codes.
    for code in codes:
        enqueue(state, code)
    for path in (data / "matches").glob("*.json"):
        code = read_json(path, {}).get("data_source_match_id")
        if isinstance(code, str) and SHARE_PATTERN.fullmatch(code):
            enqueue(state, code)
    return state


def due(job: dict, now: datetime, force=False) -> bool:
    if job["status"] == "complete":
        return False
    # Older workers applied a download backoff when Steam never allowed a request.
    if job["status"] == "retry" and job.get("last_error_code") == STEAM_PLAYING_ELSEWHERE:
        return True
    if force or not job.get("next_attempt_at"):
        return True
    return datetime.fromisoformat(job["next_attempt_at"]) <= now


def mark_failure(job: dict, code: str, now: datetime, *, status="retry", retry_after_seconds=None):
    # Only bounded codes generated by us are saved. Never save arbitrary exceptions/URLs.
    if job.get("native_source_backfill_in_progress"):
        job["native_source_last_error_code"] = code
        job["native_source_next_attempt_at"] = (now + timedelta(hours=24)).isoformat()
        job.pop("native_source_backfill_in_progress", None)
        return
    if job.get("analysis_upgrade_in_progress"):
        # An unavailable old replay must not hide an already validated match.
        job["upgrade_last_error_code"] = code
        job["upgrade_next_attempt_at"] = (now + timedelta(hours=24)).isoformat()
        job.pop("analysis_upgrade_in_progress", None)
        return
    kind = "transport" if code in TRANSPORT_ERRORS else "publication" if code in REPLAY_WAIT_ERRORS else "other"
    previous_streak = job.get("acquisition_failure_streak") if job.get("acquisition_failure_kind") == kind else None
    streak = min(8, previous_streak + 1) if type(previous_streak) is int and previous_streak > 0 else 1
    job.update(status=status, last_error_code=code, acquisition_failure_kind=kind, acquisition_failure_streak=streak)
    delay = timedelta(hours=12 if status == "blocked_auth" else min(24, 2 ** min(job["attempts"], 5)))
    if kind == "transport" and status == "retry":
        delay = timedelta(minutes=min(60, 10 * 2 ** (streak - 1)))
    if kind == "publication" and status == "unavailable":
        match_time = job.get("match_started_at") or job.get("discovered_match_started_at")
        try:
            age = now - datetime.fromisoformat(match_time.replace("Z", "+00:00"))
        except (AttributeError, ValueError, TypeError):
            age = None
        if age is not None and timedelta(0) <= age <= timedelta(days=2):
            delay = timedelta(minutes=min(240, 30 * 2 ** (streak - 1)))
    if type(retry_after_seconds) is int and retry_after_seconds > 0:
        delay = max(delay, timedelta(seconds=min(86400, retry_after_seconds)))
    job["next_attempt_at"] = (now + delay).isoformat()


def resolve_codes(jobs: list[dict], directory: Path) -> dict:
    if not jobs:
        return {}
    inp, out = directory / "resolve-input.json", directory / "resolve-output.json"
    inp.write_text(json.dumps([{"id": j["id"], "share_code": j["share_code"]} for j in jobs]))
    try:
        subprocess.run(["node", str(ROOT / "steam" / "resolve.mjs"), "--input", str(inp), "--output", str(out)],
                                capture_output=True, timeout=240, check=False)
        # Node stdout/stderr intentionally stay private; a third-party SDK could log a URL.
        if not out.is_file():
            return {j["share_code"]: {"status": "transient", "error_code": "resolver_process_failed"} for j in jobs}
        rows = json.loads(out.read_text())
        if not isinstance(rows, list):
            raise ValueError()
        return {r["share_code"]: r for r in rows if isinstance(r, dict) and r.get("share_code")}
    except (subprocess.TimeoutExpired, OSError, ValueError):
        return {j["share_code"]: {"status": "transient", "error_code": "resolver_failed"} for j in jobs}


def discover_recent_codes(data: Path, state: dict) -> dict:
    """GC's recent window supplements the Web API cursor; it is not full history."""
    try:
        with tempfile.TemporaryDirectory(prefix="cs2-discovery-") as tmp:
            output = Path(tmp) / "recent.json"
            subprocess.run(["node", str(ROOT / "steam" / "discover.mjs"), "--output", str(output)],
                           capture_output=True, timeout=140, check=False)
            result = json.loads(output.read_text(encoding="utf-8"))
        if not isinstance(result, dict) or result.get("status") not in {"discovered", "transient", "expired", "unavailable"}:
            raise ValueError()
    except (OSError, ValueError, subprocess.TimeoutExpired):
        result = {"status": "transient", "error_code": "gc_discovery_failed"}
    matches = result.get("matches", [])
    matches = matches if isinstance(matches, list) else []
    added = 0
    if result["status"] == "discovered":
        # Recent responses are newest first; insert old-to-new for queue priority.
        for entry in reversed(matches[:8]):
            code = entry.get("share_code") if isinstance(entry, dict) else None
            if isinstance(code, str) and SHARE_PATTERN.fullmatch(code):
                before = len(state["jobs"])
                job = enqueue(state, code)
                job.setdefault("discovered_by", "steam_gc_recent")
                if entry.get("match_time_verified") is True and isinstance(entry.get("match_started_at"), str):
                    try:
                        parsed_time = datetime.fromisoformat(entry["match_started_at"].replace("Z", "+00:00"))
                        if parsed_time.tzinfo is not None:
                            # Used for acquisition priority only; analysis-time proof
                            # still comes from the exact resolved replay response.
                            job["discovered_match_started_at"] = parsed_time.astimezone(timezone.utc).isoformat()
                    except ValueError:
                        pass
                added += len(state["jobs"]) - before
    skipped = result.get("unencodable_matches", [])
    metadata = {"last_checked_at": now_utc().isoformat(), "status": result["status"],
                "returned_matches": len(matches), "newly_queued": added,
                "unencodable_matches": len(skipped) if isinstance(skipped, list) else 0}
    error = str(result.get("error_code", "")).lower()
    if re.fullmatch(r"[a-z0-9_]{1,64}", error):
        metadata["error_code"] = error
    write_json_if_changed(data / "gc_discovery.json", metadata)
    return metadata


def steam_session_in_use(result: dict | None) -> bool:
    return (bool(result) and result.get("status") == "transient"
            and str(result.get("error_code", "")).lower() == STEAM_PLAYING_ELSEWHERE)


def run_pipeline(root: Path, steamid: str, *, limit: int = 1, url: str | None = None,
                 code: str | None = None, local_demo: Path | None = None,
                 force: bool = False, parser=None, upgrade_analysis: bool = False,
                 download_timeout_seconds: int = 900, checkpoint_publisher=None,
                 backfill_native_sources: bool = False, live_progress=None) -> dict:
    if not isinstance(limit, int) or isinstance(limit, bool) or not 1 <= limit <= 20:
        raise ValueError("invalid_job_limit")
    if not isinstance(download_timeout_seconds, int) or isinstance(download_timeout_seconds, bool) or not 60 <= download_timeout_seconds <= 1800:
        raise ValueError("invalid_download_timeout")
    data, reports = root / "data", root / "reports"
    ensure_account(data, steamid)
    state = load_state(data, steamid)
    native_sources = load_native_sources(data, steamid)
    save = lambda: write_json_if_changed(data / "demo_jobs.json", state)
    override = None
    if url or local_demo:
        override = enqueue(state, code, url=url or "local:" + str(local_demo.resolve()), local=bool(local_demo))
    elif code:
        override = enqueue(state, code)
    save()
    current = now_utc()
    token_available = bool(os.getenv("STEAM_REFRESH_TOKEN", "").strip())
    discovery = None
    if token_available and not (url or local_demo):
        if live_progress:
            live_progress.update("discovering")
        discovery = discover_recent_codes(data, state)
        save()
    if token_available:
        for job in state["jobs"].values():
            if job.get("last_error_code") == "steam_refresh_token_missing":
                job.pop("next_attempt_at", None)
                job.pop("last_error_code", None)
                job["status"] = "pending"
    candidates = [j for j in state["jobs"].values() if due(j, current, force or j is override)]
    upgrades = []
    if upgrade_analysis:
        from .advanced import ANALYSIS_VERSION
        for job in state["jobs"].values():
            if job.get("status") != "complete" or job.get("source") != "steam_gc":
                continue
            result_path = data / str(job.get("result_path", ""))
            if result_path.parent != data / "demo_matches" or not result_path.is_file():
                continue
            previous = read_json(result_path, {})
            if previous.get("player", {}).get("steamid") != steamid or previous.get("analysis_version") == ANALYSIS_VERSION:
                continue
            next_at = job.get("upgrade_next_attempt_at")
            if next_at and not force and datetime.fromisoformat(next_at) > current:
                continue
            upgrades.append(job)
    source_backfills = {}
    if backfill_native_sources:
        for job in state["jobs"].values():
            if job.get("status") != "complete" or job.get("source") != "steam_gc" or job in upgrades:
                continue
            result_path = (data / str(job.get("result_path", ""))).resolve()
            if result_path.parent != (data / "demo_matches").resolve() or not result_path.is_file():
                continue
            previous = read_json(result_path, {})
            if (previous.get("player", {}).get("steamid") != steamid
                    or previous.get("match_id") != job.get("id")
                    or fingerprint(previous.get("provenance")) is None
                    or has_native_source(native_sources, job["id"], previous["provenance"])):
                continue
            next_at = job.get("native_source_next_attempt_at")
            if next_at and not force and datetime.fromisoformat(next_at) > current:
                continue
            source_backfills[job["id"]] = (job, previous["provenance"])
    # Fair retries: unattempted first, then least recently tried; newest discovery first on ties.
    candidates.reverse()
    candidates.sort(key=lambda j: j.get("discovered_match_started_at", ""), reverse=True)
    candidates.sort(key=lambda j: j.get("last_attempt_at", ""))
    if force:
        candidates.sort(key=lambda j: (bool(j.get("download_completed_before")) and j.get("last_error_code") != "http_404",
                        j.get("discovered_match_started_at") or j.get("match_started_at", "")), reverse=True)
    if override and override["id"] in source_backfills and override not in candidates:
        candidates.insert(0, override)
    if override in candidates:
        candidates.remove(override)
        candidates.insert(0, override)
    if not override:
        # Each old result is upgraded once, within the same bounded per-run budget.
        # Native-source-only downloads are opt-in and share that same limit.
        candidates = list(reversed(upgrades)) + candidates + [item[0] for item in source_backfills.values()]
    selected = candidates[:limit]
    resolve_jobs = [j for j in selected if j is not override and j.get("share_code") and token_available]
    if override and not (url or local_demo) and token_available and override in selected:
        resolve_jobs.append(override)
    extra_hosts = tuple(x.strip().lower() for x in os.getenv("CS2_DEMO_ALLOWED_HOSTS", "").split(",") if x.strip())
    completed_this_run = 0
    native_sources_verified_this_run = 0
    attempted_this_run = 0
    deferred_jobs = set()
    job_results = []
    discovery_deferred = steam_session_in_use(discovery)
    run_id = os.getenv("GITHUB_RUN_ID", "")
    run_attempt = os.getenv("GITHUB_RUN_ATTEMPT", "")
    github_run = (os.getenv("GITHUB_ACTIONS") == "true"
                  and re.fullmatch(r"[1-9][0-9]{0,15}", run_id)
                  and re.fullmatch(r"[1-9][0-9]{0,5}", run_attempt))

    def progress(phase, **fields):
        if live_progress:
            live_progress.update(phase, selected_this_run=len(selected), attempted_this_run=attempted_this_run,
                                 completed_this_run=completed_this_run, deferred_this_run=len(deferred_jobs),
                                 settled_this_run=len(job_results), **fields)

    def record_run_status(outcome, checkpoint_state, **result):
        status = {
            "last_run_at": now_utc().isoformat(), "attempted_this_run": attempted_this_run,
            "completed_this_run": completed_this_run, "run_outcome": outcome,
            "checkpoint_state": checkpoint_state, "job_results": job_results,
            "deferred_this_run": len(deferred_jobs), "selected_this_run": len(selected), "settled_this_run": len(job_results),
            "native_sources_verified_this_run": native_sources_verified_this_run,
            "gc_discovery_status": discovery["status"] if discovery else "not_checked",
            "steam_session_configured": token_available, **result,
        }
        if github_run:
            status.update(workflow_run_id=run_id, workflow_run_attempt=int(run_attempt))
        discovery_error = (discovery or {}).get("error_code")
        if isinstance(discovery_error, str) and re.fullmatch(r"[a-z0-9_]{1,64}", discovery_error, re.I):
            status["gc_discovery_error_code"] = discovery_error.lower()
        write_json_if_changed(reports / "demo_status.json", status)

    def checkpoint_progress(**fields):
        if checkpoint_publisher is None:
            return
        progress("checkpointing", **fields)
        # Reports can fail independently of an already validated parse result.
        # Keep the raw result and queue durable even when report export fails.
        ready = False
        try:
            from .report import generate_reports
            checkpoint = generate_reports(data, reports, steamid)
            record_run_status("partial", "processing", status_counts=checkpoint["status_counts"],
                              matches_analyzed=checkpoint["matches_analyzed"])
            ready = True
        except Exception:
            print("Demo checkpoint: report_generation_failed; preserving parsed data", flush=True)
        checkpoint_publisher.mark_reports_ready(ready)
        try:
            checkpoint_publisher.publish(include_reports=ready)
        except Exception:
            # The next settled job and the final workflow step retry the commit.
            # Never include Git output, which may contain authenticated URLs.
            print("Demo checkpoint: publish_failed; local progress retained", flush=True)

    def settle_job(job, index, *, source_only=False, upgrading=False, deferred=False):
        error_key, retry_key = (("native_source_last_error_code", "native_source_next_attempt_at") if source_only
                                else ("upgrade_last_error_code", "upgrade_next_attempt_at") if upgrading
                                else ("last_error_code", "next_attempt_at"))
        error = STEAM_PLAYING_ELSEWHERE if deferred else job.get(error_key)
        retry_at = None if deferred else job.get(retry_key)
        status = "deferred" if deferred else job["status"]
        if source_only or upgrading:
            status = "deferred" if deferred else "retry" if error else "verified" if source_only else "complete"
        result = {"job_id": job["id"], "job_index": index, "status": status}
        if isinstance(error, str) and re.fullmatch(r"[a-z0-9_]{1,95}", error):
            result["error_code"] = error
        if isinstance(retry_at, str):
            result["retry_at"] = retry_at
        job_results.append(result)
        fields = {key: value for key, value in result.items() if key != "status"}
        progress("settled", **fields)
        if not deferred:
            checkpoint_progress(**fields)

    with tempfile.TemporaryDirectory(prefix="cs2-demo-") as temp:
        temp_dir = Path(temp)
        if resolve_jobs:
            progress("resolving")
        resolved = resolve_codes(resolve_jobs, temp_dir)
        for index, job in enumerate(selected, 1):
            job_url = url if job is override else None
            using_local_demo = job is override and local_demo is not None
            answer = resolved.get(job.get("share_code"), {})
            if not (job_url or using_local_demo) and steam_session_in_use(answer):
                deferred_jobs.add(job["id"])
                print(f"Demo job {job['id']}: deferred ({STEAM_PLAYING_ELSEWHERE})", flush=True)
                settle_job(job, index, deferred=True)
                continue
            print(f"Demo job {job['id']}: starting", flush=True)
            attempt_time = now_utc()
            attempted_this_run += 1
            job["attempts"] += 1
            job["last_attempt_at"] = attempt_time.isoformat()
            source_only = job["id"] in source_backfills
            upgrading = job in upgrades

            def job_progress(phase, **fields):
                progress(phase, job_id=job["id"], job_index=index, **fields)

            progress_options = {"on_progress": job_progress} if live_progress else {}
            if source_only:
                job["native_source_backfill_in_progress"] = True
                job["native_source_last_attempt_at"] = attempt_time.isoformat()
            if upgrading:
                job["analysis_upgrade_in_progress"] = True
                job["upgrade_last_attempt_at"] = attempt_time.isoformat()
                job["upgrade_next_attempt_at"] = (attempt_time + timedelta(hours=24)).isoformat()
            # Match-time proof applies to the URL resolved in this attempt.
            # A later manually supplied file may be a different match.
            if not source_only:
                job.pop("match_started_at", None)
                job.pop("timestamp_provenance", None)
                job.pop("failure_details", None)
                job.pop("download_receipt", None)
            save()
            if not (job_url or using_local_demo):
                if not job.get("share_code"):
                    mark_failure(job, "manual_url_required", now_utc(), status="unavailable")
                    save()
                    settle_job(job, index, source_only=source_only, upgrading=upgrading)
                    continue
                if not token_available:
                    mark_failure(job, "steam_refresh_token_missing", now_utc(), status="blocked_auth")
                    save()
                    settle_job(job, index, source_only=source_only, upgrading=upgrading)
                    continue
                diagnostics = answer.get("replay_url_diagnostics")
                if isinstance(diagnostics, list):
                    # Diagnostics contain only sanitized host/scheme/reason, never URLs.
                    job["replay_url_diagnostics"] = [
                        {key: str(item[key])[:253] for key in ("host", "scheme", "reason") if key in item}
                        for item in diagnostics[:10] if isinstance(item, dict)]
                if not source_only and answer.get("match_time_verified") is True and isinstance(answer.get("match_started_at"), str):
                    job["match_started_at"] = answer["match_started_at"]
                    job["timestamp_provenance"] = "Steam GC matchList.matchtime"
                if answer.get("status") != "resolved" or not answer.get("url"):
                    status = answer.get("status")
                    error = str(answer.get("error_code", "gc_url_unavailable")).lower()
                    if not re.fullmatch(r"[a-z0-9_]{1,64}", error):
                        error = "resolver_failed"
                    mark_failure(job, error, now_utc(),
                                 status="blocked_auth" if status == "expired" or error in {
                                     "steam_account_mismatch", "steam_auth_rejected", "steam_guard_reauth_required",
                                     "steam_refresh_token_invalid", "steam_refresh_token_requires_client"}
                                 else "unavailable" if status == "unavailable" else "retry")
                    save()
                    settle_job(job, index, source_only=source_only, upgrading=upgrading)
                    continue
                job_url = answer["url"]
            try:
                with tempfile.TemporaryDirectory(dir=temp_dir) as item_tmp:
                    workdir = Path(item_tmp)
                    if using_local_demo:
                        demo = workdir / "replay.dem"
                        receipt = materialize_demo(local_demo, demo, **progress_options)
                    else:
                        demo, receipt = download_demo(job_url, workdir, extra_hosts=extra_hosts,
                                                      timeout_seconds=download_timeout_seconds, **progress_options)
                    if source_only:
                        job_progress("saving")
                        try:
                            record_native_source(native_sources, job["id"], job_url, receipt,
                                                 source_backfills[job["id"]][1])
                        except NativeSourceError as exc:
                            raise DownloadError(str(exc)) from None
                        write_json_if_changed(data / MANIFEST_NAME, native_sources)
                        for key in ("native_source_backfill_in_progress", "native_source_last_error_code",
                                    "native_source_next_attempt_at"):
                            job.pop(key, None)
                        native_sources_verified_this_run += 1
                        print(f"Demo job {job['id']}: native render source verified", flush=True)
                        save()
                        settle_job(job, index, source_only=True)
                        continue
                    job["download_receipt"] = receipt
                    job["download_completed_before"] = True
                    save()
                    print(f"Demo job {job['id']}: downloaded {receipt.get('bytes', 0)} bytes; parsing", flush=True)
                    analysis = parse_bounded(demo, steamid, **progress_options) if parser is None else parser(demo, steamid)
                    if analysis.get("player", {}).get("steamid") != steamid:
                        raise RuntimeError("parsed_account_mismatch")
                    if job is override and (url or local_demo):
                        job["source"] = "local_file" if local_demo else "manual_url"
                    analysis.update({"match_id": job["id"], "share_code": job.get("share_code"),
                                     "source": job["source"], "parsed_at": now_utc().isoformat()})
                    analysis.setdefault("provenance", {}).update(receipt)
                    if job.get("match_started_at") and job.get("timestamp_provenance"):
                        analysis["match_started_at"] = job["match_started_at"]
                        analysis["provenance"].update({"match_time_verified": True,
                                                        "timestamp_provenance": job["timestamp_provenance"]})
                    result_path = f"demo_matches/{job['id']}.json"
                    job_progress("saving")
                    write_json_if_changed(data / result_path, analysis)
                    job.update({"status": "complete", "result_path": result_path, "parsed_at": analysis["parsed_at"]})
                    job["analysis_version"] = analysis.get("analysis_version")
                    if job_url and not using_local_demo:
                        try:
                            record_native_source(native_sources, job["id"], job_url, receipt,
                                                 analysis.get("provenance", {}))
                            write_json_if_changed(data / MANIFEST_NAME, native_sources)
                            for key in ("native_source_last_error_code", "native_source_next_attempt_at"):
                                job.pop(key, None)
                        except NativeSourceError as exc:
                            # The analysis can be valid even when a custom/signed
                            # URL is unsuitable for a reusable native source.
                            job["native_source_last_error_code"] = str(exc)
                        except OSError:
                            job["native_source_last_error_code"] = "native_source_manifest_write_failed"
                    for key in ("analysis_upgrade_in_progress", "upgrade_last_error_code", "upgrade_next_attempt_at"):
                        job.pop(key, None)
                    completed_this_run += 1
                    print(f"Demo job {job['id']}: complete", flush=True)
                    for key in ("last_error_code", "next_attempt_at", "acquisition_failure_kind", "acquisition_failure_streak"):
                        job.pop(key, None)
            except DownloadError as exc:
                mark_failure(job, exc.code, now_utc(), status="unavailable" if exc.code == "http_404" else "retry",
                             retry_after_seconds=exc.details.get("retry_after_seconds"))
                if exc.details:
                    job["failure_details"] = exc.details
                print(f"Demo job {job['id']}: {exc.code}", flush=True)
            except Exception as exc:
                # Exception messages from parser/SDK may contain identifiers or inputs.
                mark_failure(job, "parser_or_storage_" + type(exc).__name__.lower(), now_utc())
            save()
            settle_job(job, index, source_only=source_only, upgrading=upgrading)
    progress("reporting")
    from .report import generate_reports
    try:
        snapshot = generate_reports(data, reports, steamid)
    except Exception:
        if checkpoint_publisher is not None:
            checkpoint_publisher.mark_reports_ready(False)
            try:
                checkpoint_publisher.publish(include_reports=False)
            except Exception:
                print("Demo checkpoint: publish_failed; local progress retained", flush=True)
        raise
    successful_this_run = completed_this_run + native_sources_verified_this_run
    outcome = "idle" if not attempted_this_run else "ok" if successful_this_run == attempted_this_run else "partial" if successful_this_run else "failed"
    def waiting_for_replay(job):
        return job["status"] == "unavailable" and job.get("last_error_code") in REPLAY_WAIT_ERRORS

    if not completed_this_run and state["jobs"] and all(
            j["status"] == "complete" or waiting_for_replay(j) for j in state["jobs"].values()
    ) and snapshot["status_counts"].get("unavailable"):
        outcome = "waiting_for_replays"
    if discovery and discovery["status"] != "discovered" and not discovery_deferred:
        outcome = "blocked_auth" if discovery["status"] == "expired" or discovery.get("error_code", "").startswith(
            ("steam_auth_", "steam_guard_", "steam_account_", "steam_refresh_token_")) else "failed"
    elif discovery_deferred or deferred_jobs:
        # A Steam safety pause should not hide a separate failure in an attempted job.
        replay_waits = sum(job["id"] not in deferred_jobs and waiting_for_replay(job) for job in selected)
        if attempted_this_run == successful_this_run + replay_waits:
            outcome = "deferred_steam_playing_elsewhere"
        else:
            outcome = "partial" if successful_this_run else "failed"
    if snapshot["status_counts"].get("blocked_auth"):
        outcome = "blocked_auth"
    snapshot["run_outcome"] = outcome
    snapshot["deferred_this_run"] = len(deferred_jobs)
    # Tracks worker execution, separate from individual Demo parse success.
    record_run_status(outcome, "final", status_counts=snapshot["status_counts"], matches_analyzed=snapshot["matches_analyzed"])
    from .dashboard import generate_dashboard
    try:
        generate_dashboard(data, reports, steamid)
    except Exception:
        if checkpoint_publisher is not None:
            checkpoint_publisher.mark_reports_ready(False)
            try:
                checkpoint_publisher.publish(include_reports=False)
            except Exception:
                print("Demo checkpoint: publish_failed; local progress retained", flush=True)
        raise
    if checkpoint_publisher is not None:
        progress("checkpointing")
        checkpoint_publisher.mark_reports_ready(True)
        checkpoint_publisher.publish(include_reports=True)
    progress("finished", run_outcome=outcome)
    return snapshot


def main():
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("--root", type=Path, default=ROOT)
    ap.add_argument("--steamid", default=os.getenv("STEAMID64", ""))
    ap.add_argument("--limit", type=int, default=1)
    ap.add_argument("--download-timeout", type=int, default=900, help="Total seconds per replay download, including retry and decompression")
    ap.add_argument("--demo-url", default=os.getenv("CS2_DEMO_URL") or None)
    ap.add_argument("--share-code", default=os.getenv("CS2_DEMO_SHARE_CODE") or None)
    ap.add_argument("--local-demo", type=Path)
    ap.add_argument("--retry-now", action="store_true")
    ap.add_argument("--upgrade-analysis", action="store_true", help="Re-download old completed GC matches for the current analysis version; keep prior results if unavailable")
    ap.add_argument("--backfill-native-sources", action="store_true", help="Opt-in, bounded re-download of completed GC matches missing a verified local-render source; preserve existing analysis")
    ap.add_argument("--publish-checkpoints", action="store_true", help="Publish each settled job to main from the trusted GitHub Actions worker")
    args = ap.parse_args()
    if not 1 <= args.limit <= 20:
        ap.error("--limit must be between 1 and 20")
    if not 60 <= args.download_timeout <= 1800:
        ap.error("--download-timeout must be between 60 and 1800 seconds")
    if args.demo_url and args.local_demo:
        ap.error("choose --demo-url or --local-demo")
    publisher = None
    live = None
    try:
        if args.publish_checkpoints:
            from .checkpoint import GitCheckpointPublisher
            from .live_progress import LiveProgress
            live = LiveProgress.from_environment()
            os.environ.pop("CS2_LIVE_PROGRESS_TOKEN", None)
            publisher = GitCheckpointPublisher(args.root)
        result = run_pipeline(args.root, args.steamid.strip(), limit=args.limit, url=args.demo_url,
                              code=args.share_code, local_demo=args.local_demo, force=args.retry_now,
                              upgrade_analysis=args.upgrade_analysis,
                              backfill_native_sources=args.backfill_native_sources,
                              download_timeout_seconds=args.download_timeout,
                              checkpoint_publisher=publisher, live_progress=live)
        print(json.dumps({"matches_analyzed": result["matches_analyzed"], "status_counts": result["status_counts"],
                          "run_outcome": result["run_outcome"], "deferred_this_run": result["deferred_this_run"]}))
        status = result["status_counts"]
        # Missing setup is a visible blocked state, not a successful end-to-end run.
        if status.get("blocked_auth"):
            print("Demo downloads blocked: configure or renew STEAM_REFRESH_TOKEN; see docs/cloud-demo.md", file=sys.stderr)
        return 2 if result["run_outcome"] == "blocked_auth" else 1 if result["run_outcome"] == "failed" else 0
    except Exception as exc:
        from .checkpoint import CheckpointError
        reason = str(exc) if isinstance(exc, CheckpointError) and re.fullmatch(r"checkpoint_[a-z_]{1,64}", str(exc)) else type(exc).__name__
        print(f"Demo worker failed ({reason}); no credentials logged", file=sys.stderr)
        if live:
            live.update("finished", run_outcome="failed", error_code="sync_worker_failed")
        return 1
    finally:
        if live:
            live.close()
        if publisher and publisher.published:
            from .checkpoint import write_workflow_output
            write_workflow_output("checkpoint_published", "true")


if __name__ == "__main__":
    sys.exit(main())
