"""Deterministic bounded transport for private, unattended Dashboard updates.

Each GitHub-readable chunk remains below the Contents API's inline size bound.
The authoritative index and complete-match files are also the bounded wire
representation. No growing full-history repository file is required.
"""
from __future__ import annotations

import base64
import gzip
import hashlib
import json
from pathlib import Path

from .shards import (MAX_INDEX_BYTES, canonical_bytes, export_dashboard_shards, git_blob_sha,
                     load_dashboard, snapshot_identity, validate_index, verify_match)

CHUNK_BYTES = 384 * 1024
MAX_DECODED_BYTES = 32 * 1024 * 1024
MAX_COMPRESSED_BYTES = 16 * 1024 * 1024


def _write(path: Path, value: dict) -> None:
    content = json.dumps(value, ensure_ascii=False, separators=(",", ":"), allow_nan=False) + "\n"
    if path.is_file() and path.read_text(encoding="utf-8") == content:
        return
    path.parent.mkdir(parents=True, exist_ok=True)
    temporary = path.with_suffix(path.suffix + ".tmp")
    temporary.write_text(content, encoding="utf-8")
    temporary.replace(path)


def _transport_unit(reports_dir: Path, decoded: bytes, prefix: str) -> dict:
    """Write one independently bounded update operation, never a whole history."""
    if len(decoded) > MAX_DECODED_BYTES:
        raise ValueError("dashboard_transport_decoded_limit")
    compressed = gzip.compress(decoded, compresslevel=6, mtime=0)
    if len(compressed) > MAX_COMPRESSED_BYTES:
        raise ValueError("dashboard_transport_compressed_limit")
    chunks = []
    for index, offset in enumerate(range(0, len(compressed), CHUNK_BYTES)):
        part = compressed[offset:offset + CHUNK_BYTES]
        relative = f"dashboard.transport/{prefix}part-{index:03d}.json"
        sha = hashlib.sha256(part).hexdigest()
        _write(reports_dir / relative, {"index": index, "sha256": sha,
                                       "data": base64.b64encode(part).decode("ascii")})
        chunks.append({"path": "reports/" + relative, "index": index,
                       "compressed_bytes": len(part), "sha256": sha})
    return {"decoded_sha256": hashlib.sha256(decoded).hexdigest(),
            "compressed_sha256": hashlib.sha256(compressed).hexdigest(),
            "decoded_bytes": len(decoded), "compressed_bytes": len(compressed),
            "chunks": chunks}


def export_dashboard_transport(reports_dir: Path, *, version: str = "2.0", snapshot=None) -> dict:
    """Export match-first/index-last updates; retain explicit legacy v1 export.

    Exact JSON strings cross the Python/JavaScript boundary. Re-serializing a
    parsed match there can change float spellings and invalidate its byte hash.
    """
    reports_dir = Path(reports_dir)
    if version not in ("1.0", "2.0"):
        raise ValueError("unsupported_dashboard_transport_version")
    raw = None
    index_path = reports_dir / "dashboard.index.json"
    if snapshot is not None and version == "2.0":
        index, shards = export_dashboard_shards(reports_dir, snapshot=snapshot)
    elif snapshot is not None:
        raw = canonical_bytes(snapshot) + b"\n"
    elif version == "2.0" and index_path.is_file():
        if index_path.stat().st_size > MAX_INDEX_BYTES:
            raise ValueError("dashboard_index_decoded_limit")
        index = json.loads(index_path.read_bytes())
        validate_index(index)
        metadata = index.get("_cs2_storage") or {}
        if metadata.get("version") != "1.0" or metadata.get("kind") != "match_index":
            raise ValueError("invalid_dashboard_shard_index")
        shards = {}
        for reference in metadata.get("match_refs", []):
            match_id = reference["match_id"]
            match_raw = (reports_dir / "dashboard.matches" / f"{match_id}.json").read_bytes()
            verify_match(match_raw, reference)
            if match_id in shards or reference["source_revision"] != metadata["source_revision"]:
                raise ValueError("invalid_dashboard_shard_index")
            shards[match_id] = match_raw
        for reference in metadata.get("statistics_refs", []):
            statistics_raw = (reports_dir / "dashboard.statistics" / f"{reference['match_id']}.json").read_bytes()
            verify_match(statistics_raw, reference, statistics=True)
        # Legacy v2 indexes lacked conceptual report digests. Their canonical
        # reconstruction is needed only once during migration.
        if "source_report_sha256" not in metadata:
            legacy = reports_dir / "dashboard.json"
            if legacy.is_file():
                raw = legacy.read_bytes()
                identity = {"source_revision": git_blob_sha(raw),
                            "report_sha256": hashlib.sha256(raw).hexdigest(), "report_bytes": len(raw)}
            else:
                identity = snapshot_identity(load_dashboard(reports_dir))
            if identity["source_revision"] != metadata.get("source_revision"):
                raise ValueError("dashboard_legacy_source_revision_mismatch")
            metadata.update({"source_report_sha256": identity["report_sha256"],
                             "source_report_bytes": identity["report_bytes"]})
            temporary = index_path.with_suffix(".json.tmp")
            temporary.write_bytes(canonical_bytes(index))
            temporary.replace(index_path)
    else:
        if version == "1.0" and index_path.is_file():
            metadata = json.loads(index_path.read_bytes()).get("_cs2_storage") or {}
            if metadata.get("source_report_bytes", 0) > MAX_DECODED_BYTES:
                raise ValueError("dashboard_transport_decoded_limit")
            snapshot = load_dashboard(reports_dir)
            raw = canonical_bytes(snapshot) + b"\n"
        else:
            raw = (reports_dir / "dashboard.json").read_bytes()
            snapshot = json.loads(raw)
        if version == "2.0":
            index, shards = export_dashboard_shards(reports_dir, snapshot=snapshot, raw_report=raw)
    if version == "2.0":
        metadata = index["_cs2_storage"]
        source = index
        revision, report_digest = metadata["source_revision"], metadata["source_report_sha256"]
    else:
        source = snapshot
        revision, report_digest = git_blob_sha(raw), hashlib.sha256(raw).hexdigest()
    manifest = {
        "schema_version": version, "encoding": "gzip-base64-json-chunks",
        "report_path": "reports/dashboard.index.json" if version == "2.0" else "reports/dashboard.json",
        "source_revision": revision, "report_sha256": report_digest,
        "generated_at": source.get("generated_at"),
        "match_count": len(source.get("matches", [])),
        "rounds": sum(len(match.get("rounds", [])) for match in source.get("matches", [])),
    }
    if version == "1.0":
        decoded = json.dumps(snapshot, ensure_ascii=False, separators=(",", ":"), allow_nan=False).encode("utf-8")
        manifest.update(_transport_unit(reports_dir, decoded, ""))
        operations = [manifest]
    else:
        operations = []
        for reference in index["_cs2_storage"]["match_refs"]:
            match_id = reference["match_id"]
            envelope = {"_cs2_storage": {"version": "1.0", "kind": "match_upload",
                        "source_revision": manifest["source_revision"],
                        "profile": {"steamid64": source["profile"]["steamid64"]},
                        "reference": reference}, "match_json": shards[match_id].decode("utf-8")}
            operation = {"kind": "match_upload", "match_id": match_id,
                         "content_sha256": reference["content_sha256"],
                         **_transport_unit(reports_dir, canonical_bytes(envelope), f"match-{match_id}/")}
            operations.append(operation)
        statistics_refs = index["_cs2_storage"].get("statistics_refs")
        if statistics_refs is not None:
            for reference in statistics_refs:
                match_id = reference["match_id"]
                statistics_raw = (reports_dir / "dashboard.statistics" / f"{match_id}.json").read_bytes()
                verify_match(statistics_raw, reference, statistics=True)
                envelope = {"_cs2_storage": {"version": "1.0", "kind": "statistics_upload",
                            "source_revision": manifest["source_revision"],
                            "profile": {"steamid64": source["profile"]["steamid64"]},
                            "reference": reference}, "statistics_json": statistics_raw.decode("utf-8")}
                operations.append({"kind": "statistics_upload", "match_id": match_id,
                                   "content_sha256": reference["content_sha256"],
                                   **_transport_unit(reports_dir, canonical_bytes(envelope), f"statistics-{match_id}/")})
        index_raw = canonical_bytes(index)
        envelope = {"_cs2_storage": {"version": "1.0", "kind": "index_commit",
                    "source_revision": manifest["source_revision"]},
                    "index_json": index_raw.decode("utf-8")}
        operations.append({"kind": "index_commit",
                           **_transport_unit(reports_dir, canonical_bytes(envelope), "index/")})
        manifest.update({"storage": "match_index", "index_path": "reports/dashboard.index.json",
                         "source_storage": "match_index", "source_report_bytes": metadata["source_report_bytes"],
                         **({"statistics_count": len(statistics_refs)} if statistics_refs is not None else {}),
                         "index_sha256": hashlib.sha256(index_raw).hexdigest(),
                         "operations": operations,
                         "decoded_bytes": sum(row["decoded_bytes"] for row in operations),
                         "compressed_bytes": sum(row["compressed_bytes"] for row in operations)})
    keep = {row["path"].removeprefix("reports/") for operation in operations for row in operation["chunks"]}
    for old in (reports_dir / "dashboard.transport").rglob("part-*.json"):
        if old.relative_to(reports_dir).as_posix() not in keep:
            old.unlink()
    _write(reports_dir / "dashboard.transport.json", manifest)
    return manifest


if __name__ == "__main__":
    import argparse
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("reports", type=Path)
    args = parser.parse_args()
    result = export_dashboard_transport(args.reports)
    print(json.dumps({key: result[key] for key in ("source_revision", "decoded_bytes", "compressed_bytes", "match_count")}))
