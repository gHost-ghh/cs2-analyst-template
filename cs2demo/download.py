"""Bounded replay downloads. Receipts and failure diagnostics exclude URLs."""
from __future__ import annotations

import bz2
import gzip
import hashlib
import ipaddress
import math
import re
import time
from email.utils import parsedate_to_datetime
from http.client import IncompleteRead
from pathlib import Path
from urllib.error import HTTPError, URLError
from urllib.parse import urlsplit
from urllib.request import HTTPRedirectHandler, Request, build_opener

MAGIC = b"PBDEMS2\x00"
REPLAY_HOST = re.compile(r"replay\d+\.(?:valve\.net|wmsj\.cn|csgo\.com\.cn)\Z", re.I)
_CONNECTION_ERRORS = {"download_network_error", "download_socket_timeout", "download_connection_reset"}
_RETRYABLE_ERRORS = _CONNECTION_ERRORS | {"truncated_download", "http_408", "http_500", "http_502", "http_503", "http_504"}


class DownloadError(RuntimeError):
    def __init__(self, code: str, *, details: dict | None = None):
        self.code = code
        self.details = details or {}
        super().__init__(code)


def validate_url(url: str, extra_hosts: tuple[str, ...] = ()) -> str:
    try:
        parts = urlsplit(url)
        host = (parts.hostname or "").lower()
        port = parts.port
        if parts.scheme not in {"http", "https"} or not host or parts.username or parts.password:
            raise ValueError()
        if parts.fragment or port not in (None, 80, 443):
            raise ValueError()
        try:
            ipaddress.ip_address(host)
        except ValueError:
            pass
        else:
            raise ValueError()
        if not REPLAY_HOST.fullmatch(host) and host not in extra_hosts:
            raise ValueError()
        if host in {"localhost", "metadata.google.internal"} or host.endswith((".local", ".internal")):
            raise ValueError()
        # Valve's replay CDN may offer HTTP only; custom hosts require HTTPS.
        if not REPLAY_HOST.fullmatch(host) and parts.scheme != "https":
            raise ValueError()
        return host
    except (ValueError, AttributeError):
        raise DownloadError("url_not_allowed") from None


class SafeRedirects(HTTPRedirectHandler):
    def __init__(self, extra_hosts):
        self.extra_hosts = extra_hosts

    def redirect_request(self, req, fp, code, msg, headers, newurl):
        validate_url(newurl, self.extra_hosts)
        return super().redirect_request(req, fp, code, msg, headers, newurl)


def _observe(callback, phase, **fields):
    if callback is not None:
        try:
            callback(phase, **fields)
        except Exception:
            # Publishing observations is optional and cannot interrupt the replay.
            pass


def _retry_after(value):
    if not isinstance(value, str) or len(value) > 100:
        return 0
    try:
        if value.isascii() and value.isdecimal():
            return min(86_400, int(value))
        seconds = math.ceil(parsedate_to_datetime(value).timestamp() - time.time())
        return max(0, min(86_400, seconds))
    except (ValueError, OverflowError, OSError):
        return 0


def materialize_demo(source: Path, target: Path, *, max_bytes: int = 2 * 1024**3,
                     deadline: float | None = None, on_progress=None) -> dict:
    """Decompress without trusting extensions, and reject HTML/CS:GO/partial bz2 files."""
    magic = source.open("rb")
    with magic:
        prefix = magic.read(8)
    opener = bz2.open if prefix.startswith(b"BZh") else gzip.open if prefix.startswith(b"\x1f\x8b") else open
    digest = hashlib.sha256()
    size = 0
    compressed = opener is not open
    _observe(on_progress, "decompressing" if compressed else "validating")
    try:
        with opener(source, "rb") as src, target.open("wb") as dst:
            while chunk := src.read(1024 * 1024):
                size += len(chunk)
                if size > max_bytes:
                    raise DownloadError("demo_too_large")
                if deadline is not None and time.monotonic() > deadline:
                    raise DownloadError("download_timeout")
                digest.update(chunk)
                dst.write(chunk)
        if deadline is not None and time.monotonic() > deadline:
            raise DownloadError("download_timeout")
        if compressed:
            _observe(on_progress, "validating")
        with target.open("rb") as check:
            if check.read(8) != MAGIC:
                raise DownloadError("not_cs2_demo")
    except (OSError, EOFError, ValueError):
        target.unlink(missing_ok=True)
        raise DownloadError("corrupt_demo") from None
    except DownloadError:
        target.unlink(missing_ok=True)
        raise
    return {"sha256": digest.hexdigest(), "bytes": size}


def _download_once(url: str, directory: Path, *, extra_hosts: tuple[str, ...] = (),
                  max_compressed: int = 512 * 1024**2, max_bytes: int = 2 * 1024**3,
                  timeout_seconds: float = 900, on_progress=None, attempt: int = 1) -> tuple[Path, dict]:
    host = validate_url(url, extra_hosts)
    directory.mkdir(parents=True, exist_ok=True)
    packed, target = directory / "replay.download", directory / "replay.dem"
    started = time.monotonic()
    deadline = started + timeout_seconds
    received, announced, stage = 0, 0, "connect"

    def details():
        return {"host": host, "received_bytes": received, "announced_bytes": announced,
                "elapsed_seconds": round(time.monotonic() - started, 1), "stage": stage}

    def download_progress():
        total = {"total_bytes": announced} if 0 < announced and received <= announced else {}
        _observe(on_progress, "downloading", attempt=attempt, received_bytes=received, **total)

    def materialize_progress(phase):
        nonlocal stage
        stage = "decompress" if phase == "decompressing" else "validate"
        _observe(on_progress, phase, attempt=attempt)

    opener = build_opener(SafeRedirects(extra_hosts))
    try:
        request = Request(url, headers={"User-Agent": "cs2-personal-stats/2.0", "Accept-Encoding": "identity"})
        _observe(on_progress, "downloading", attempt=attempt)
        with opener.open(request, timeout=min(30, timeout_seconds)) as response, packed.open("wb") as dst:
            validate_url(response.geturl(), extra_hosts)
            stage = "download"
            if getattr(response, "status", None) == 206:
                # A full GET never requested a byte range.
                raise DownloadError("truncated_download")
            try:
                announced = max(0, int(response.headers.get("Content-Length", "0")))
            except ValueError:
                announced = 0
            if announced > max_compressed:
                raise DownloadError("download_too_large")
            download_progress()
            last_progress_at, last_progress_bytes = time.monotonic(), 0
            # read1 returns after one underlying read, so a slow trickle cannot
            # reset the socket timeout indefinitely inside a buffered read.
            reader = getattr(response, "read1", response.read)
            while True:
                if time.monotonic() > deadline:
                    raise DownloadError("download_timeout")
                chunk = reader(1024 * 1024)
                now = time.monotonic()
                if now > deadline:
                    raise DownloadError("download_timeout")
                if not chunk:
                    break
                received += len(chunk)
                if received > max_compressed:
                    raise DownloadError("download_too_large")
                dst.write(chunk)
                if on_progress is not None and now - last_progress_at >= 1:
                    download_progress()
                    last_progress_at, last_progress_bytes = now, received
            if received != last_progress_bytes:
                download_progress()
            if announced and announced != received:
                raise DownloadError("truncated_download")
        stage = "validate"
        receipt = materialize_demo(packed, target, max_bytes=max_bytes, deadline=deadline, on_progress=materialize_progress)
        receipt.update({"download_host": host, "compressed_bytes": received, "download_protocol": urlsplit(url).scheme})
        return target, receipt
    except HTTPError as exc:
        error_details = details()
        retry_after = _retry_after(exc.headers.get("Retry-After")) if exc.headers is not None else 0
        if retry_after:
            error_details["retry_after_seconds"] = retry_after
        exc.close()
        raise DownloadError(f"http_{exc.code}", details=error_details) from None
    except IncompleteRead:
        raise DownloadError("truncated_download", details=details()) from None
    except (URLError, TimeoutError, OSError) as exc:
        reason = exc.reason if isinstance(exc, URLError) else exc
        code = "download_socket_timeout" if isinstance(reason, TimeoutError) else "download_connection_reset" if isinstance(reason, ConnectionResetError) else "download_network_error"
        raise DownloadError(code, details=details()) from None
    except DownloadError as exc:
        exc.details = details()
        raise
    finally:
        packed.unlink(missing_ok=True)


def _attempt_record(attempt, url, elapsed, error=None):
    result = {"attempt": attempt, "protocol": urlsplit(url).scheme,
              "elapsed_seconds": round(elapsed, 1), "stage": "validate", "result": "ok"}
    if error is not None:
        for key in ("stage", "received_bytes", "announced_bytes", "retry_after_seconds"):
            if key in error.details:
                result[key] = error.details[key]
        result["result"] = error.code
    return result


def download_demo(url: str, directory: Path, *, extra_hosts: tuple[str, ...] = (),
                  max_compressed: int = 512 * 1024**2, max_bytes: int = 2 * 1024**3,
                  timeout_seconds: int = 900, on_progress=None) -> tuple[Path, dict]:
    host = validate_url(url, extra_hosts)
    parts = urlsplit(url)
    options = {"extra_hosts": extra_hosts, "max_compressed": max_compressed, "max_bytes": max_bytes,
               "on_progress": on_progress}
    deadline = time.monotonic() + timeout_seconds
    attempts = []
    candidate = url
    for attempt in range(1, 4):
        started = time.monotonic()
        remaining = deadline - started
        if remaining <= 0:
            raise DownloadError("download_timeout", details={"attempts": attempts})
        try:
            target, receipt = _download_once(candidate, directory, timeout_seconds=remaining, attempt=attempt, **options)
        except DownloadError as exc:
            now = time.monotonic()
            attempts.append(_attempt_record(attempt, candidate, now - started, exc))
            exc.details["attempts"] = attempts
            if exc.code not in _RETRYABLE_ERRORS or exc.details.get("retry_after_seconds") or deadline - now <= 1:
                raise
            if attempt == 1:
                # Retry the exact approved URL, including HTTP on the CN CDNs.
                continue
            if (attempt == 2 and parts.scheme == "http" and host.endswith(".valve.net")
                    and all(item["result"] in _CONNECTION_ERRORS for item in attempts)):
                candidate = parts._replace(scheme="https", netloc=host).geturl()
                continue
            raise
        if attempts:
            attempts.append(_attempt_record(attempt, candidate, time.monotonic() - started))
            receipt["download_attempts"] = attempts
        if candidate != url:
            receipt["retried_over_https"] = True
        return target, receipt
