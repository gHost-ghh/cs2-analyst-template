"""Lossless complete-match storage with an explicitly deferred statistics index.

The statistics index and immutable complete-match files are authoritative.
Replacing projected matches restores the complete source snapshot exactly;
the growing full-history JSON is never required as a repository file.
"""
from __future__ import annotations

import copy
import hashlib
import json
import re
from pathlib import Path

MAX_MATCH_BYTES = 16 * 1024 * 1024
MAX_INDEX_BYTES = 32 * 1024 * 1024
MATCH_ID = re.compile(r"^[a-f0-9]{24}$")
SHA256 = re.compile(r"^[a-f0-9]{64}$")
REVISION = re.compile(r"^(?:[a-f0-9]{40}|[a-f0-9]{64})$")
RESERVED = {"_cs2_storage", "_cs2_deferred", "detail_ref", "statistics_ref"}


def canonical_bytes(value) -> bytes:
    return json.dumps(value, ensure_ascii=False, sort_keys=True,
                      separators=(",", ":"), allow_nan=False).encode("utf-8")


def git_blob_sha(raw: bytes) -> str:
    return hashlib.sha1(b"blob " + str(len(raw)).encode("ascii") + b"\0" + raw).hexdigest()


def snapshot_identity(snapshot: dict) -> dict:
    """Hash the canonical full export without allocating or writing that file.

    Preserve the historic Git-blob revision contract, including its trailing
    newline. Only bounded encoder fragments cross this boundary even when the
    complete history is larger than GitHub's per-file limit.
    """
    encoder = json.JSONEncoder(ensure_ascii=False, sort_keys=True,
                               separators=(",", ":"), allow_nan=False)
    size = sum(len(part.encode("utf-8")) for part in encoder.iterencode(snapshot)) + 1
    git_digest = hashlib.sha1(b"blob " + str(size).encode("ascii") + b"\0")
    digest = hashlib.sha256()
    for part in encoder.iterencode(snapshot):
        raw = part.encode("utf-8")
        git_digest.update(raw)
        digest.update(raw)
    git_digest.update(b"\n")
    digest.update(b"\n")
    return {"source_revision": git_digest.hexdigest(),
            "report_sha256": digest.hexdigest(), "report_bytes": size}


def _check_reserved(value):
    if isinstance(value, dict):
        if RESERVED.intersection(value):
            raise ValueError("reserved_dashboard_shard_field")
        for child in value.values():
            _check_reserved(child)
    elif isinstance(value, list):
        for child in value:
            _check_reserved(child)


def _defer(parent, key, path):
    if not isinstance(parent, dict) or key not in parent or parent[key] is None:
        return
    value = parent.pop(key)
    metadata = {"path": [*path, key], "kind": "array" if isinstance(value, list)
                else "object" if isinstance(value, dict) else "text"}
    if isinstance(value, list):
        metadata["count"] = len(value)
    if isinstance(value, dict):
        for name in ("encoding", "count", "decoded_bytes"):
            if name in value:
                metadata[name] = value[name]
    parent.setdefault("_cs2_deferred", {})[key] = metadata


def _project_analysis(analysis, path):
    if not isinstance(analysis, dict):
        return
    level3 = analysis.get("level3") or {}
    for name in ("crosshair", "counter_strafe"):
        for index, observation in enumerate((level3.get(name) or {}).get("observations") or []):
            for key in ("trace", "points", "samples"):
                _defer(observation, key, [*path, "level3", name, "observations", str(index)])
    mechanics = level3.get("mechanics") or {}
    # Current statistics derive shot-index accuracy from spray traces. Keep
    # these exact traces, all observation scalars and every player round.
    for name in ("targeting", "stopping"):
        for index, observation in enumerate((mechanics.get(name) or {}).get("observations") or []):
            _defer(observation, "trace", [*path, "level3", "mechanics", name,
                                         "observations", str(index)])
    for index, window in enumerate((mechanics.get("aim_playback") or {}).get("windows") or []):
        for key in ("trajectory", "points", "targets", "geometry"):
            _defer(window, key, [*path, "level3", "mechanics", "aim_playback",
                                 "windows", str(index)])


def project_statistics_match(match: dict, reference: dict) -> dict:
    """Retain every global statistical input, deferring only full-detail data."""
    result = copy.deepcopy(match)
    _project_analysis(result.get("analysis"), ["analysis"])
    for index, row in enumerate(result.get("rounds") or []):
        _project_analysis(row.get("analysis"), ["rounds", str(index), "analysis"])
    # Other-player round totals support all cross-match comparisons. Their
    # duplicate event streams are detail and are read from the exact shard.
    for player_index, player in enumerate(result.get("players") or []):
        for round_index, row in enumerate(player.get("rounds") or []):
            _defer(row, "events", ["players", str(player_index), "rounds", str(round_index)])
    for index, row in enumerate((result.get("replay") or {}).get("rounds") or []):
        path = ["replay", "rounds", str(index)]
        for key in ("frames", "shots"):
            value = row.get(key)
            if isinstance(value, dict) and value.get("encoding") == "gzip-base64-json":
                _defer(value, "data", [*path, key])
            else:
                _defer(row, key, path)
        for key in ("tactical", "damage_events", "unassociated_impacts"):
            _defer(row, key, path)
    result["detail_ref"] = copy.deepcopy(reference)
    return result


def project_match(statistics: dict, reference: dict) -> dict:
    """Project a small root row; exact statistics remain independently loaded."""
    result = copy.deepcopy(statistics)
    if "coverage" not in result and isinstance((statistics.get("analysis") or {}).get("coverage"), dict):
        result["coverage"] = copy.deepcopy(statistics["analysis"]["coverage"])
    for key in ("analysis", "positions", "events", "training_plan", "capability_details"):
        _defer(result, key, [])
    for index, row in enumerate(result.get("rounds") or []):
        for key in ("analysis", "positions", "events", "aim", "positioning", "utility", "economy"):
            _defer(row, key, ["rounds", str(index)])
    for index, player in enumerate(result.get("players") or []):
        for key in ("rounds", "by_side", "by_weapon"):
            _defer(player, key, ["players", str(index)])
    _defer(result.get("replay"), "rounds", ["replay"])
    result["statistics_ref"] = copy.deepcopy(reference)
    return result


def validate_reference(reference: dict, *, statistics: bool = False) -> None:
    if (not isinstance(reference, dict)
            or reference.get("schema_version") != "1.0"
            or not MATCH_ID.fullmatch(str(reference.get("match_id", "")))
            or not SHA256.fullmatch(str(reference.get("content_sha256", "")))
            or type(reference.get("decoded_bytes")) is not int
            or not 1 <= reference["decoded_bytes"] <= MAX_MATCH_BYTES
            or not REVISION.fullmatch(str(reference.get("source_revision", "")))
            or reference.get("path") != f"reports/dashboard.{'statistics' if statistics else 'matches'}/{reference.get('match_id')}.json"):
        raise ValueError("invalid_dashboard_match_reference")


def project_snapshot(snapshot: dict, source_revision: str, *, statistics_out=None):
    """Return index and exact complete-match UTF-8 JSON, keyed by match ID."""
    if (not isinstance(snapshot, dict) or snapshot.get("schema_version") != "1.0"
            or not isinstance(snapshot.get("profile"), dict)
            or not re.fullmatch(r"\d{17}", str(snapshot["profile"].get("steamid64", "")))
            or not isinstance(snapshot.get("matches"), list)
            or len(snapshot["matches"]) > 1000
            or not REVISION.fullmatch(str(source_revision))):
        raise ValueError("invalid_dashboard_shard_source")
    _check_reserved(snapshot)
    shards, references, statistics_refs = {}, {}, {}
    for match in snapshot["matches"]:
        match_id = match.get("match_id") if isinstance(match, dict) else None
        if not MATCH_ID.fullmatch(str(match_id)) or match_id in references:
            raise ValueError("invalid_dashboard_shard_match_id")
        raw = canonical_bytes(match)
        if len(raw) > MAX_MATCH_BYTES:
            raise ValueError("dashboard_match_shard_decoded_limit")
        reference = {"schema_version": "1.0", "match_id": match_id,
                     "content_sha256": hashlib.sha256(raw).hexdigest(), "decoded_bytes": len(raw),
                     "path": f"reports/dashboard.matches/{match_id}.json",
                     "source_revision": source_revision}
        references[match_id], shards[match_id] = reference, raw
    # Copy each match only while projecting it. Avoid a second complete copy of
    # the history before discarding high-rate detail.
    index = {key: copy.deepcopy(value) for key, value in snapshot.items() if key != "matches"}
    projected = []
    for match in snapshot["matches"]:
        match_id = match["match_id"]
        statistics = project_statistics_match(match, references[match_id])
        statistics_raw = canonical_bytes(statistics)
        if len(statistics_raw) > MAX_MATCH_BYTES:
            raise ValueError("dashboard_statistics_shard_decoded_limit")
        reference = {"schema_version": "1.0", "match_id": match_id,
                     "content_sha256": hashlib.sha256(statistics_raw).hexdigest(),
                     "decoded_bytes": len(statistics_raw),
                     "path": f"reports/dashboard.statistics/{match_id}.json",
                     "source_revision": source_revision}
        statistics_refs[match_id] = reference
        if statistics_out is not None:
            statistics_out[match_id] = statistics_raw
        projected.append(project_match(statistics, reference))
    index["matches"] = projected
    index["_cs2_storage"] = {"version": "1.0", "kind": "match_index",
                           "source_revision": source_revision,
                           "source_generated_at": snapshot.get("generated_at"),
                           "match_refs": list(references.values()),
                           "statistics_refs": list(statistics_refs.values())}
    if len(canonical_bytes(index)) > MAX_INDEX_BYTES:
        raise ValueError("dashboard_index_decoded_limit")
    return index, shards


def verify_match(raw: bytes, reference: dict, *, statistics: bool = False) -> dict:
    validate_reference(reference, statistics=statistics)
    if len(raw) != reference["decoded_bytes"]:
        raise ValueError("dashboard_match_shard_length_mismatch")
    if hashlib.sha256(raw).hexdigest() != reference["content_sha256"]:
        raise ValueError("dashboard_match_shard_digest_mismatch")
    match = json.loads(raw)
    if not isinstance(match, dict) or match.get("match_id") != reference["match_id"]:
        raise ValueError("dashboard_match_shard_identity_mismatch")
    if statistics:
        validate_reference(match.get("detail_ref"))
        if match["detail_ref"]["match_id"] != reference["match_id"] or match["detail_ref"]["source_revision"] != reference["source_revision"]:
            raise ValueError("dashboard_statistics_shard_identity_mismatch")
    else:
        _check_reserved(match)
    return match


def validate_index(index: dict) -> dict:
    """Validate references before any declared file path is opened."""
    metadata = index.get("_cs2_storage") or {}
    if (metadata.get("version") != "1.0" or metadata.get("kind") != "match_index"
            or not REVISION.fullmatch(str(metadata.get("source_revision", "")))):
        raise ValueError("invalid_dashboard_shard_index")
    rows, refs = index.get("matches"), metadata.get("match_refs")
    if not isinstance(rows, list) or not isinstance(refs, list) or len(rows) != len(refs):
        raise ValueError("invalid_dashboard_shard_index")
    by_id = {}
    for ref in refs:
        validate_reference(ref)
        if ref["match_id"] in by_id or ref["source_revision"] != metadata.get("source_revision"):
            raise ValueError("invalid_dashboard_shard_index")
        by_id[ref["match_id"]] = ref
    seen = set()
    statistics_refs = metadata.get("statistics_refs")
    stats_by_id = {}
    if statistics_refs is not None:
        if not isinstance(statistics_refs, list) or len(statistics_refs) != len(rows):
            raise ValueError("invalid_dashboard_shard_index")
        for ref in statistics_refs:
            validate_reference(ref, statistics=True)
            if ref["match_id"] in stats_by_id or ref["source_revision"] != metadata["source_revision"]:
                raise ValueError("invalid_dashboard_shard_index")
            stats_by_id[ref["match_id"]] = ref
    for row in rows:
        if not isinstance(row, dict):
            raise ValueError("invalid_dashboard_shard_index")
        match_id = row.get("match_id")
        if match_id in seen or row.get("detail_ref") != by_id.get(match_id):
            raise ValueError("invalid_dashboard_shard_index")
        if statistics_refs is not None and row.get("statistics_ref") != stats_by_id.get(match_id):
            raise ValueError("invalid_dashboard_shard_index")
        seen.add(match_id)
    return by_id


def reassemble(index: dict, load_bytes) -> dict:
    """Restore the complete original snapshot; never treat deferred as empty."""
    by_id = validate_index(index)
    result = {key: copy.deepcopy(value) for key, value in index.items()
              if key not in ("matches", "_cs2_storage")}
    result["matches"] = []
    seen = set()
    for row in index["matches"]:
        match_id = row.get("match_id")
        reference = row.get("detail_ref")
        if match_id in seen or reference != by_id.get(match_id):
            raise ValueError("invalid_dashboard_shard_index")
        seen.add(match_id)
        result["matches"].append(verify_match(load_bytes(reference), reference))
    return result


def _write_bytes(path: Path, raw: bytes):
    if path.is_file() and path.read_bytes() == raw:
        return
    path.parent.mkdir(parents=True, exist_ok=True)
    temporary = path.with_suffix(path.suffix + ".tmp")
    temporary.write_bytes(raw)
    temporary.replace(path)


def export_dashboard_shards(reports_dir: Path, *, snapshot=None, raw_report=None):
    reports_dir = Path(reports_dir)
    if snapshot is None:
        raw_report = raw_report if raw_report is not None else (reports_dir / "dashboard.json").read_bytes()
        snapshot = json.loads(raw_report)
    identity = ({"source_revision": git_blob_sha(raw_report),
                 "report_sha256": hashlib.sha256(raw_report).hexdigest(),
                 "report_bytes": len(raw_report)} if raw_report is not None
                else snapshot_identity(snapshot))
    statistics = {}
    index, shards = project_snapshot(snapshot, identity["source_revision"], statistics_out=statistics)
    index["_cs2_storage"].update({"source_report_sha256": identity["report_sha256"],
                                  "source_report_bytes": identity["report_bytes"]})
    if len(canonical_bytes(index)) > MAX_INDEX_BYTES:
        raise ValueError("dashboard_index_decoded_limit")
    for match_id, raw in shards.items():
        _write_bytes(reports_dir / "dashboard.matches" / f"{match_id}.json", raw)
        _write_bytes(reports_dir / "dashboard.statistics" / f"{match_id}.json", statistics[match_id])
    _write_bytes(reports_dir / "dashboard.index.json", canonical_bytes(index))
    for old in (reports_dir / "dashboard.matches").glob("*.json"):
        if old.stem not in shards:
            old.unlink()
    for old in (reports_dir / "dashboard.statistics").glob("*.json"):
        if old.stem not in statistics:
            old.unlink()
    return index, shards


def load_dashboard(reports_dir: Path) -> dict:
    """Read either current authoritative shards or a legacy complete report."""
    reports_dir = Path(reports_dir)
    index_path = reports_dir / "dashboard.index.json"
    if index_path.is_file():
        if index_path.stat().st_size > MAX_INDEX_BYTES:
            raise ValueError("dashboard_index_decoded_limit")
        index = json.loads(index_path.read_bytes())
        return reassemble(index, lambda ref: (reports_dir / "dashboard.matches" /
                                             f"{ref['match_id']}.json").read_bytes())
    return json.loads((reports_dir / "dashboard.json").read_bytes())


def export_complete_dashboard(reports_dir: Path, destination: Path) -> dict:
    """Create an explicit local full export from independently verified files."""
    reports_dir, destination = Path(reports_dir), Path(destination)
    if (destination.resolve().is_relative_to(reports_dir.resolve())
            and destination.resolve() != (reports_dir / "dashboard.json").resolve()):
        raise ValueError("dashboard_export_would_overwrite_source")
    snapshot = load_dashboard(reports_dir)
    destination.parent.mkdir(parents=True, exist_ok=True)
    temporary = destination.with_suffix(destination.suffix + ".tmp")
    encoder = json.JSONEncoder(ensure_ascii=False, sort_keys=True,
                               separators=(",", ":"), allow_nan=False)
    try:
        with temporary.open("w", encoding="utf-8", newline="\n") as output:
            for part in encoder.iterencode(snapshot):
                output.write(part)
            output.write("\n")
        temporary.replace(destination)
    finally:
        temporary.unlink(missing_ok=True)
    return {"matches": len(snapshot.get("matches", [])), "bytes": destination.stat().st_size}


if __name__ == "__main__":
    import argparse
    parser = argparse.ArgumentParser(description="Export complete JSON from verified private Dashboard shards")
    parser.add_argument("--reports", type=Path, default=Path("reports"))
    parser.add_argument("--export", type=Path, required=True,
                        help="Local output path; keep full exports outside tracked reports")
    args = parser.parse_args()
    print(json.dumps(export_complete_dashboard(args.reports, args.export)))
