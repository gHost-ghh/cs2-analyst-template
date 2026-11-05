"""Private, byte-verified replay download locations for local native rendering.

This manifest is acquisition metadata in the private repository. It is never a
dashboard field or a download credential, and must not be copied into reports.
"""
from __future__ import annotations

import json
from pathlib import Path
import re
from urllib.parse import urlsplit

from .download import MAGIC

MANIFEST_NAME = "native_render_sources.json"
MAX_MANIFEST_BYTES = 4 * 1024**2
MAX_DEMO_BYTES = 2 * 1024**3
MATCH_ID = re.compile(r"[a-f0-9]{24}\Z")
SHA256 = re.compile(r"[a-f0-9]{64}\Z")
REPLAY_HOST = re.compile(r"replay[0-9]+\.(?:valve\.net|wmsj\.cn|csgo\.com\.cn)\Z", re.I)
REPLAY_PATH = re.compile(r"/730/[A-Za-z0-9_.-]{1,256}\.dem(?:\.bz2)?\Z")


class NativeSourceError(RuntimeError):
    """Only fixed codes, rather than raw locations, leave this boundary."""


def validate_native_source_url(value: str) -> str:
    """Use the GC resolver's CDN allowlist without persisting signed inputs."""
    try:
        if not isinstance(value, str) or not re.fullmatch(r"[\x21-\x7e]{1,2048}", value):
            raise ValueError()
        parts = urlsplit(value)
        host = parts.hostname or ""
        if (parts.scheme not in {"http", "https"} or len(host) > 253
                or not REPLAY_HOST.fullmatch(host) or not REPLAY_PATH.fullmatch(parts.path)
                or parts.username or parts.password or parts.port is not None
                or "?" in value or "#" in value):
            raise ValueError()
        return f"{parts.scheme}://{host.lower()}{parts.path}"
    except (ValueError, AttributeError):
        raise NativeSourceError("native_source_url_not_allowed") from None


def fingerprint(value: dict) -> tuple[str, int] | None:
    """Read a downloader receipt or a parser provenance without guessing."""
    if not isinstance(value, dict):
        return None
    digest = value.get("source_sha256", value.get("sha256"))
    size = value.get("source_bytes", value.get("bytes"))
    if (not isinstance(digest, str) or not SHA256.fullmatch(digest)
            or not isinstance(size, int) or isinstance(size, bool)
            or not len(MAGIC) <= size <= MAX_DEMO_BYTES):
        return None
    # The parser and downloader retain separate hashes. Conflicting copies must
    # never cause a new location to be associated with a prior analysis.
    if value.get("sha256", digest) != digest or value.get("bytes", size) != size:
        return None
    return digest, size


def load_native_sources(data: Path, steamid: str) -> dict:
    path = data / MANIFEST_NAME
    if not path.exists():
        return {"version": "1.0", "owner_steamid": steamid, "matches": {}}
    try:
        if path.stat().st_size > MAX_MANIFEST_BYTES:
            raise ValueError()
        result = json.loads(path.read_text(encoding="utf-8"))
        if (not isinstance(result, dict) or result.get("version") != "1.0"
                or result.get("owner_steamid") != steamid or not isinstance(result.get("matches"), dict)):
            raise ValueError()
        for ident, entry in result["matches"].items():
            if (not isinstance(ident, str) or not MATCH_ID.fullmatch(ident)
                    or fingerprint(entry) is None or set(entry) != {"url", "sha256", "bytes"}
                    or validate_native_source_url(entry["url"]) != entry["url"]):
                raise ValueError()
        return result
    except (ValueError, KeyError, OSError, NativeSourceError, TypeError):
        raise NativeSourceError("native_source_manifest_invalid") from None


def has_native_source(manifest: dict, ident: str, provenance: dict) -> bool:
    expected = fingerprint(provenance)
    entry = manifest["matches"].get(ident)
    return expected is not None and isinstance(entry, dict) and fingerprint(entry) == expected


def record_native_source(manifest: dict, ident: str, url: str, receipt: dict,
                         provenance: dict) -> None:
    """Bind a successfully parsed/downloaded source to the exact original bytes."""
    if not isinstance(ident, str) or not MATCH_ID.fullmatch(ident):
        raise NativeSourceError("native_source_match_invalid")
    expected, actual = fingerprint(provenance), fingerprint(receipt)
    if expected is None or actual is None or expected != actual:
        raise NativeSourceError("native_source_fingerprint_mismatch")
    location = validate_native_source_url(url)
    old = manifest["matches"].get(ident)
    if old is not None and fingerprint(old) != expected:
        raise NativeSourceError("native_source_existing_fingerprint_mismatch")
    manifest["matches"][ident] = {"url": location, "sha256": actual[0], "bytes": actual[1]}
