"""Audit native Source 2 animation streams and prepare engine capture jobs.

DEM_AnimationData carries an opaque engine animation bitstream. This module
preserves that data; it does not pretend that it is an evaluated bone matrix.
The separate CS2/HLAE capture runner evaluates the original demo in the client.
"""
from __future__ import annotations

import argparse
from collections import Counter
import hashlib
import io
import json
import math
from pathlib import Path
import re
from typing import BinaryIO

VERSION = "1.0"
MAX_RECORD_BYTES = 64 * 1024 * 1024
MAX_ANIMATION_BYTES = 512 * 1024 * 1024
MAX_ANIMATION_RECORDS = 100_000
MAX_DEMO_BYTES = 8 * 1024 * 1024 * 1024
BONE_NAME = re.compile(rb"(?<![a-zA-Z0-9_])(?:pelvis|spine_[0-9]+|neck_[0-9]+|head_[0-9]+|clavicle_[lr]|(?:arm|leg)_(?:upper|lower)_[lr]|(?:hand|foot|ball)_[lr]|finger_[a-z]+_[0-9]+_[lr]|weapon_hand_[lr])(?=\x00|[^a-zA-Z0-9_])")
MATCH_ID = re.compile(r"[0-9a-f]{24}\Z")
STEAM_ID = re.compile(r"[0-9]{17}\Z")
SHA256 = re.compile(r"[0-9a-f]{64}\Z")


class NativeAnimationError(ValueError):
    pass


def _varint(stream: BinaryIO, *, eof: bool = False, bits: int = 64) -> int | None:
    value = 0
    for index in range((bits + 6) // 7):
        byte = stream.read(1)
        if not byte:
            if eof and index == 0:
                return None
            raise NativeAnimationError("truncated varint")
        value |= (byte[0] & 127) << (7 * index)
        if not byte[0] & 128:
            if value >= 1 << bits:
                raise NativeAnimationError("varint exceeds integer width")
            return value
    raise NativeAnimationError("overlong varint")


def _read(stream: BinaryIO, count: int) -> bytes:
    value = stream.read(count)
    if len(value) != count:
        raise NativeAnimationError("truncated record")
    return value


def decode_snappy(data: bytes, *, max_bytes: int = MAX_RECORD_BYTES) -> bytes:
    """Bounded raw Snappy block decoder; Source 2 packets are not framed Snappy."""
    stream = io.BytesIO(data)
    expected = _varint(stream, bits=32)
    if expected > max_bytes:
        raise NativeAnimationError("decoded animation record exceeds limit")
    output = bytearray()
    while stream.tell() < len(data):
        tag = _read(stream, 1)[0]
        kind = tag & 3
        if kind == 0:
            length = tag >> 2
            if length >= 60:
                length = int.from_bytes(_read(stream, length - 59), "little")
            length += 1
            if len(output) + length > expected:
                raise NativeAnimationError("Snappy literal exceeds declared size")
            output.extend(_read(stream, length))
            continue
        if kind == 1:
            length = 4 + ((tag >> 2) & 7)
            offset = ((tag & 224) << 3) | _read(stream, 1)[0]
        else:
            length = 1 + (tag >> 2)
            offset = int.from_bytes(_read(stream, 2 if kind == 2 else 4), "little")
        if offset == 0 or offset > len(output) or len(output) + length > expected:
            raise NativeAnimationError("invalid Snappy back reference")
        # Repeat the prefix when offset < length; Source 2 uses overlapping copies.
        prefix = output[-offset:]
        output.extend((prefix * ((length + offset - 1) // offset))[:length])
    if len(output) != expected:
        raise NativeAnimationError("Snappy decoded size mismatch")
    return bytes(output)


def _protobuf(data: bytes) -> dict[int, int | bytes]:
    stream = io.BytesIO(data)
    result = {}
    while stream.tell() < len(data):
        tag = _varint(stream)
        field, wire = tag >> 3, tag & 7
        if not field:
            raise NativeAnimationError("invalid protobuf field")
        if wire == 0:
            result[field] = _varint(stream)
        elif wire == 2:
            count = _varint(stream, bits=32)
            if count > MAX_RECORD_BYTES:
                raise NativeAnimationError("protobuf field exceeds limit")
            result[field] = _read(stream, count)
        elif wire in (1, 5):
            _read(stream, 8 if wire == 1 else 4)
        else:
            raise NativeAnimationError("unsupported protobuf wire type")
    return result


def _bone_name_hints(data: bytes) -> list[str]:
    """Find names in the bounded dictionary prefix at each bit alignment.

    These are inspectable hints, never a claimed decoded skeleton/hierarchy.
    """
    prefix = data[:4096]
    names = set()
    for shift in range(8):
        shifted = prefix if shift == 0 else bytes(
            (prefix[index] >> shift) | ((prefix[index + 1] << (8 - shift)) & 255)
            for index in range(len(prefix) - 1))
        names.update(match.group().decode("ascii") for match in BONE_NAME.finditer(shifted))
    return sorted(names)


def recording_bounds(path: Path) -> dict:
    """Read outer playback bounds without parsing/decompressing packet payloads.

    Signon often uses tick -1 (uint32 0xffffffff). Only actual packet/fullpacket
    and stop commands establish playback bounds; file-info/footer metadata do
    not extend a round. This is also useful when replaying round-end aftermath.
    """
    path = Path(path)
    size = path.stat().st_size
    if size > MAX_DEMO_BYTES:
        raise NativeAnimationError("demo exceeds inspection limit")
    lower = upper = None
    with path.open("rb") as stream:
        if _read(stream, 16)[:8] != b"PBDEMS2\x00":
            raise NativeAnimationError("not a Source 2 demo")
        while stream.tell() < size:
            command = _varint(stream, bits=32)
            tick = _varint(stream, bits=32)
            length = _varint(stream, bits=32)
            if stream.tell() + length > size:
                raise NativeAnimationError("truncated command payload")
            stream.seek(length, 1)
            signed_tick = tick - (1 << 32) if tick >= 1 << 31 else tick
            if command & ~64 in (0, 7, 8, 13) and signed_tick >= 0:
                lower = signed_tick if lower is None else min(lower, signed_tick)
                upper = signed_tick if upper is None else max(upper, signed_tick)
    return {"recording_start_tick": lower, "recording_end_tick": upper}


def inspect_demo(path: Path, *, extract_dir: Path | None = None,
                 max_animation_bytes: int = MAX_ANIMATION_BYTES) -> dict:
    """Stream every command, including footer animation packets after gameplay."""
    path = Path(path)
    size = path.stat().st_size
    if size > MAX_DEMO_BYTES:
        raise NativeAnimationError("demo exceeds inspection limit")
    if extract_dir:
        extract_dir = Path(extract_dir)
        # Existing content is never overwritten by an inspection command.
        extract_dir.mkdir(parents=True, exist_ok=False)
    with path.open("rb") as stream:
        digest = hashlib.file_digest(stream, "sha256").hexdigest()
        stream.seek(0)
        header = _read(stream, 16)
        if header[:8] != b"PBDEMS2\x00":
            raise NativeAnimationError("not a Source 2 demo")
        commands, entities = Counter(), {}
        records, total = [], 0
        file_header = {}
        while stream.tell() < size:
            offset = stream.tell()
            command = _varint(stream, bits=32)
            tick = _varint(stream, bits=32)
            length = _varint(stream, bits=32)
            if length > MAX_RECORD_BYTES or stream.tell() + length > size:
                raise NativeAnimationError("invalid command length")
            kind = command & ~64
            commands[kind] += 1
            if kind not in (1, 16, 17):
                stream.seek(length, 1)
                continue
            raw = _read(stream, length)
            decoded = decode_snappy(raw) if command & 64 else raw
            fields = _protobuf(decoded)
            if kind == 1:
                for key, field in (("map_name", 5), ("demo_version_name", 11), ("game", 14)):
                    value = fields.get(field)
                    if isinstance(value, bytes):
                        file_header[key] = value.decode("utf-8", errors="replace")[:512]
                for key, field in (("network_protocol", 2), ("build_num", 13)):
                    if isinstance(fields.get(field), int):
                        file_header[key] = fields[field]
                continue
            if len(records) >= MAX_ANIMATION_RECORDS:
                raise NativeAnimationError("animation record count exceeds limit")
            entity = fields.get(1)
            payload = fields.get(4 if kind == 16 else 3, b"")
            if not isinstance(entity, int) or not isinstance(payload, bytes):
                raise NativeAnimationError("invalid animation protobuf")
            entity = (entity >> 1) ^ -(entity & 1)
            start, end = fields.get(2, 0), fields.get(3 if kind == 16 else 2, 0)
            if not isinstance(start, int) or not isinstance(end, int) or end < start:
                raise NativeAnimationError("invalid animation tick range")
            total += len(payload)
            if total > max_animation_bytes:
                raise NativeAnimationError("total native animation data exceeds limit")
            record = {"kind": "animation_data" if kind == 16 else "animation_header",
                      "entity_id": entity, "command_tick": tick, "start_tick": start,
                      "end_tick": end, "file_offset": offset, "compressed": bool(command & 64),
                      "message_bytes": len(decoded), "message_sha256": hashlib.sha256(decoded).hexdigest(),
                      "payload_bytes": len(payload), "payload_sha256": hashlib.sha256(payload).hexdigest()}
            if kind == 16 and isinstance(fields.get(5), int):
                # Protobuf signed int64, not a validated payload SHA/checksum scheme.
                checksum = fields[5]
                record["engine_checksum_int64"] = checksum - (1 << 64) if checksum >= 1 << 63 else checksum
            if extract_dir:
                stem = f"{len(records):06d}-entity-{entity}"
                (extract_dir / f"{stem}.pb").write_bytes(decoded)
                (extract_dir / f"{stem}.bin").write_bytes(payload)
                record.update(message_path=f"{stem}.pb", payload_path=f"{stem}.bin")
            records.append(record)
            summary = entities.setdefault(str(entity), {"records": 0, "payload_bytes": 0,
                                                        "first_tick": start, "last_tick": end,
                                                        "bone_name_hints": []})
            summary["records"] += 1
            summary["payload_bytes"] += len(payload)
            summary["first_tick"] = min(start, summary["first_tick"])
            summary["last_tick"] = max(end, summary["last_tick"])
            if not summary["bone_name_hints"]:
                summary["bone_name_hints"] = _bone_name_hints(payload)
    return {"version": VERSION, "status": "native_bitstreams_present" if records else "not_observed",
            "source_sha256": digest, "source_bytes": size, "file_header": file_header,
            "animation_records": len(records), "animation_payload_bytes": total,
            "commands": {str(key): value for key, value in sorted(commands.items())},
            "entities": entities, "records": records, "evaluated_bone_matrices": False,
            "exact_animation_rendered": False}


def plan_capture(analysis: dict, *, demo_sha256: str, fps: int = 120,
                 max_clips: int = 16, max_seconds: int = 180) -> dict:
    """Bind bounded engine captures to one exact demo and parsed aim windows."""
    match_id = analysis.get("match_id", "")
    owner = analysis.get("player", {}).get("steamid", "")
    if not MATCH_ID.fullmatch(match_id) or not STEAM_ID.fullmatch(str(owner)):
        raise NativeAnimationError("valid match id and owner Steam ID required")
    if not SHA256.fullmatch(demo_sha256):
        raise NativeAnimationError("demo SHA-256 required")
    expected = analysis.get("provenance", {}).get("source_sha256")
    if not expected or expected != demo_sha256:
        raise NativeAnimationError("capture demo does not match parsed source SHA-256")
    if type(fps) is not int or not 30 <= fps <= 240:
        raise NativeAnimationError("capture fps must be 30–240")
    if type(max_clips) is not int or not 1 <= max_clips <= 64:
        raise NativeAnimationError("max_clips must be 1–64")
    if type(max_seconds) is not int or not 1 <= max_seconds <= 600:
        raise NativeAnimationError("capture duration budget must be 1–600 seconds")
    tickrate = analysis.get("provenance", {}).get("tickrate")
    if not isinstance(tickrate, (int, float)) or isinstance(tickrate, bool) or not math.isfinite(tickrate) or not 16 <= tickrate <= 256:
        raise NativeAnimationError("observed tickrate required")
    candidates = []
    for round_ in analysis.get("rounds", []):
        playback = round_.get("analysis", {}).get("level3", {}).get("mechanics", {}).get("aim_playback", {})
        for clip in playback.get("windows", []):
            start, end = clip.get("start_tick"), clip.get("finish_tick")
            if type(start) is not int or type(end) is not int or start < 0 or end <= start or (end - start) / tickrate > 20:
                continue
            if not clip.get("targets"):
                continue
            markers = clip.get("shot_markers", [])
            shot_ticks = sorted({row[0] for row in markers if isinstance(row, list) and row
                                 and type(row[0]) is int and start <= row[0] <= end})
            if not shot_ticks:
                continue
            candidates.append({"burst_id": str(clip.get("burst_id", ""))[:128],
                               "round_number": round_.get("round_number"),
                               "start_tick": start, "finish_tick": end,
                               "shot_ticks": shot_ticks,
                               "target_steamids": sorted({str(t.get("steamid")) for t in clip.get("targets", [])
                                                           if STEAM_ID.fullmatch(str(t.get("steamid", "")))})})
    candidates.sort(key=lambda clip: (clip["start_tick"], clip["finish_tick"], clip["burst_id"]))
    selected, seconds = [], 0
    for clip in candidates:
        duration = (clip["finish_tick"] - clip["start_tick"]) / tickrate
        if seconds + duration > max_seconds or len(selected) >= max_clips:
            break
        selected.append({"clip_id": f"{len(selected):03d}", **clip,
                         "preroll_tick": max(0, clip["start_tick"] - round(tickrate * 3)),
                         "duration_seconds": round(duration, 6)})
        seconds += duration
    return {"version": VERSION, "kind": "cs2_engine_capture_plan", "status": "awaiting_render_node",
            "match_id": match_id, "owner_steamid": str(owner), "source_sha256": demo_sha256,
            "map_name": analysis.get("map_name"), "tickrate": tickrate, "fps": fps,
            "expected_demo_build": analysis.get("provenance", {}).get("demo_build"),
            "clips": selected, "capture_seconds": round(seconds, 6),
            "available_clips": len(candidates), "truncated": len(selected) < len(candidates),
            "outputs": ["native_pov_video", "native_player_alpha_matte", "frame_alignment_evidence"],
            "evaluated_bone_matrices": False, "exact_animation_rendered": False}


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    sub = parser.add_subparsers(dest="command", required=True)
    inspect = sub.add_parser("inspect")
    inspect.add_argument("demo", type=Path)
    inspect.add_argument("--extract-dir", type=Path)
    inspect.add_argument("--output", type=Path, required=True)
    plan = sub.add_parser("plan")
    plan.add_argument("--analysis", type=Path, required=True)
    plan.add_argument("--demo", type=Path, required=True)
    plan.add_argument("--fps", type=int, default=120)
    plan.add_argument("--max-clips", type=int, default=16)
    plan.add_argument("--output", type=Path, required=True)
    args = parser.parse_args()
    if args.command == "inspect":
        result = inspect_demo(args.demo, extract_dir=args.extract_dir)
    else:
        with args.demo.open("rb") as stream:
            digest = hashlib.file_digest(stream, "sha256").hexdigest()
        result = plan_capture(json.loads(args.analysis.read_text()), demo_sha256=digest,
                              fps=args.fps, max_clips=args.max_clips)
    args.output.parent.mkdir(parents=True, exist_ok=True)
    args.output.write_text(json.dumps(result, ensure_ascii=False, separators=(",", ":")))
    print(json.dumps({"output": str(args.output), "status": result["status"],
                      "records": result.get("animation_records"), "clips": len(result.get("clips", []))}))


if __name__ == "__main__":
    main()
