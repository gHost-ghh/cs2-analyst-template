"""Bounded replay downloads. Receipts and failure diagnostics exclude URLs."""
from __future__ import annotations

import bz2
import gzip
import hashlib
import ipaddress
import re
import time
from pathlib import Path
from urllib.error import HTTPError, URLError
from urllib.parse import urlsplit
from urllib.request import HTTPRedirectHandler, Request, build_opener

MAGIC = b"PBDEMS2\x00"
REPLAY_HOST = re.compile(r"replay\d+\.(?:valve\.net|wmsj\.cn|csgo\.com\.cn)\Z", re.I)


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


def materialize_demo(source: Path, target: Path, *, max_bytes: int = 2 * 1024**3,
                     deadline: float | None = None) -> dict:
    """Decompress without trusting extensions, and reject HTML/CS:GO/partial bz2 files."""
    magic = source.open("rb")
    with magic:
        prefix = magic.read(8)
    opener = bz2.open if prefix.startswith(b"BZh") else gzip.open if prefix.startswith(b"\x1f\x8b") else open
    digest = hashlib.sha256()
    size = 0
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
                  timeout_seconds: int = 900) -> tuple[Path, dict]:
    host = validate_url(url, extra_hosts)
    directory.mkdir(parents=True, exist_ok=True)
    packed, target = directory / "replay.download", directory / "replay.dem"
    deadline = time.monotonic() + timeout_seconds
    started = time.monotonic()
    received, announced, stage = 0, 0, "download"
    def details():
        return {"host": host, "received_bytes": received, "announced_bytes": announced,
                "elapsed_seconds": round(time.monotonic() - started, 1), "stage": stage}
    opener = build_opener(SafeRedirects(extra_hosts))
    try:
        request = Request(url, headers={"User-Agent": "cs2-personal-stats/2.0", "Accept-Encoding": "identity"})
        with opener.open(request, timeout=min(30, max(1, timeout_seconds))) as response, packed.open("wb") as dst:
            validate_url(response.geturl(), extra_hosts)
            try:
                announced = int(response.headers.get("Content-Length", "0"))
            except ValueError:
                announced = 0
            if announced > max_compressed:
                raise DownloadError("download_too_large")
            received = 0
            # read1 returns after one underlying read, so a slow trickle cannot
            # reset the socket timeout indefinitely inside a buffered read.
            reader = getattr(response, "read1", response.read)
            while chunk := reader(1024 * 1024):
                received += len(chunk)
                if received > max_compressed:
                    raise DownloadError("download_too_large")
                if time.monotonic() > deadline:
                    raise DownloadError("download_timeout")
                dst.write(chunk)
            if announced and announced != received:
                raise DownloadError("truncated_download")
        stage = "decompress"
        receipt = materialize_demo(packed, target, max_bytes=max_bytes, deadline=deadline)
        receipt.update({"download_host": host, "compressed_bytes": received, "download_protocol": urlsplit(url).scheme})
        return target, receipt
    except HTTPError as exc:
        raise DownloadError(f"http_{exc.code}", details=details()) from None
    except (URLError, TimeoutError, OSError) as exc:
        reason = exc.reason if isinstance(exc, URLError) else exc
        code = "download_socket_timeout" if isinstance(reason, TimeoutError) else "download_connection_reset" if isinstance(reason, ConnectionResetError) else "download_network_error"
        raise DownloadError(code, details=details()) from None
    except DownloadError as exc:
        exc.details = details()
        raise
    finally:
        packed.unlink(missing_ok=True)


def download_demo(url: str, directory: Path, *, extra_hosts: tuple[str, ...] = (),
                  max_compressed: int = 512 * 1024**2, max_bytes: int = 2 * 1024**3,
                  timeout_seconds: int = 900) -> tuple[Path, dict]:
    validate_url(url, extra_hosts)
    options = {"extra_hosts": extra_hosts, "max_compressed": max_compressed, "max_bytes": max_bytes}
    started = time.monotonic()
    try:
        return _download_once(url, directory, timeout_seconds=timeout_seconds, **options)
    except DownloadError as exc:
        remaining = timeout_seconds - (time.monotonic() - started)
        if exc.code not in {"download_network_error", "download_socket_timeout", "download_connection_reset"} or urlsplit(url).scheme != "http" or remaining <= 1:
            raise
        # Retry the same approved host/path with TLS; preserve the total deadline.
        upgraded = urlsplit(url)._replace(scheme="https", netloc=urlsplit(url).hostname).geturl()
        target, receipt = _download_once(upgraded, directory, timeout_seconds=remaining, **options)
        receipt["retried_over_https"] = True
        return target, receipt
