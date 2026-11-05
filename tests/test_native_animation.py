"""Native packets stay opaque and intact; an audit is never claimed as rendering."""
import hashlib
from pathlib import Path
import tempfile
import unittest

from cs2demo.native_animation import (
    NativeAnimationError, decode_snappy, inspect_demo, plan_capture, recording_bounds,
)


def vi(value):
    output = bytearray()
    while value > 127:
        output.append((value & 127) | 128)
        value >>= 7
    output.append(value)
    return bytes(output)


def field(number, value):
    return vi(number << 3) + vi(value) if isinstance(value, int) else vi((number << 3) | 2) + vi(len(value)) + value


def raw_snappy(value):
    if len(value) <= 60:
        return vi(len(value)) + bytes([(len(value) - 1) << 2]) + value
    length = len(value) - 1
    count = max(1, (length.bit_length() + 7) // 8)
    return vi(len(value)) + bytes([(59 + count) << 2]) + length.to_bytes(count, "little") + value


def command(kind, tick, value):
    return vi(kind) + vi(tick & 0xFFFFFFFF) + vi(len(value)) + value


class NativePacketTests(unittest.TestCase):
    def test_raw_snappy_literals_and_all_copy_modes(self):
        self.assertEqual(decode_snappy(raw_snappy(b"x" * 400)), b"x" * 400)
        # One literal plus overlapping copy: 'a' then six more a's.
        self.assertEqual(decode_snappy(b"\x07\x00a\x09\x01"), b"a" * 7)
        self.assertEqual(decode_snappy(b"\x07\x00a\x16\x01\x00"), b"a" * 7)
        self.assertEqual(decode_snappy(b"\x07\x00a\x17\x01\x00\x00\x00"), b"a" * 7)

    def test_snappy_invalid_offsets_lengths_and_bombs(self):
        for data in (b"", b"\x80", b"\x07\x09\x00", b"\x07\x09\x02", b"\x01\x04aa", b"\x02\x00a"):
            with self.subTest(data=data), self.assertRaises(NativeAnimationError):
                decode_snappy(data)
        with self.assertRaises(NativeAnimationError):
            decode_snappy(vi(65 * 1024 * 1024))

    def test_footer_animation_packet_is_preserved_with_exact_hashes(self):
        payload = b"\0pelvis\0spine_0\0head_0\0leg_lower_l\0" + bytes(range(255))
        message = b"".join((field(1, 404), field(2, 0), field(3, 60022), field(4, payload), field(5, 2**64 - 7)))
        header = field(5, b"de_mirage") + field(13, 9842)
        demo = b"PBDEMS2\0" + b"\0" * 8 + command(1, -1, header) + command(0, 60000, b"") + command(80, 60022, raw_snappy(message))
        with tempfile.TemporaryDirectory() as directory:
            source = Path(directory) / "source.dem"
            source.write_bytes(demo)
            target = Path(directory) / "extracted"
            audit = inspect_demo(source, extract_dir=target)
            self.assertEqual(audit["source_sha256"], hashlib.sha256(demo).hexdigest())
            self.assertEqual(audit["animation_records"], 1)
            self.assertFalse(audit["evaluated_bone_matrices"])
            self.assertFalse(audit["exact_animation_rendered"])
            record = audit["records"][0]
            self.assertEqual(record["engine_checksum_int64"], -7)
            self.assertEqual((target / record["message_path"]).read_bytes(), message)
            self.assertEqual((target / record["payload_path"]).read_bytes(), payload)
            self.assertIn("head_0", audit["entities"]["202"]["bone_name_hints"])
            self.assertEqual(audit["file_header"], {"map_name": "de_mirage", "build_num": 9842})
            with self.assertRaises(FileExistsError):
                inspect_demo(source, extract_dir=target)

    def test_truncated_commands_and_total_animation_bound_reject(self):
        with tempfile.TemporaryDirectory() as directory:
            source = Path(directory) / "source.dem"
            for value in (b"wrong", b"PBDEMS2\0" + b"\0" * 8 + b"\x50", b"PBDEMS2\0" + b"\0" * 8 + command(16, 1, b"\x22\x7f")):
                source.write_bytes(value)
                with self.subTest(value=value), self.assertRaises(NativeAnimationError):
                    inspect_demo(source)
            message = field(1, 2) + field(2, 0) + field(3, 1) + field(4, b"large")
            source.write_bytes(b"PBDEMS2\0" + b"\0" * 8 + command(16, 1, message))
            with self.assertRaises(NativeAnimationError):
                inspect_demo(source, max_animation_bytes=2)

    def test_recording_bounds_ignore_negative_signon_and_metadata_footer_ticks(self):
        with tempfile.TemporaryDirectory() as directory:
            source = Path(directory) / "source.dem"
            source.write_bytes(b"PBDEMS2\0" + b"\0" * 8 + command(8, -1, b"signon")
                               + command(71, 10, b"not decompressed") + command(13, 500, b"packet")
                               + command(7, 580, b"after round_end") + command(0, 600, b"")
                               + command(2, 600000, b"metadata"))
            self.assertEqual(recording_bounds(source), {"recording_start_tick": 10, "recording_end_tick": 600})
            source.write_bytes(b"PBDEMS2\0" + b"\0" * 8 + b"\x07\x01\xff\x7f")
            with self.assertRaises(NativeAnimationError):
                recording_bounds(source)


class NativeCapturePlanTests(unittest.TestCase):
    def analysis(self):
        return {"match_id": "a" * 24, "map_name": "de_mirage", "player": {"steamid": "76561198000000000"},
                "provenance": {"source_sha256": "b" * 64, "tickrate": 64},
                "rounds": [{"round_number": 1, "analysis": {"level3": {"mechanics": {"aim_playback": {"windows": [
                    {"burst_id": "r1-b1", "start_tick": 1000, "finish_tick": 1128, "shot_markers": [[1050, 1]],
                     "targets": [{"steamid": "76561197964020430"}]}]}}}}}]}

    def test_capture_is_exact_source_bound_bounded_and_explicitly_pending(self):
        data = self.analysis()
        clips = data["rounds"][0]["analysis"]["level3"]["mechanics"]["aim_playback"]["windows"]
        clips.append({**clips[0], "burst_id": "r1-b2", "start_tick": 2000, "finish_tick": 2200,
                      "shot_markers": [[2100, 1]]})
        result = plan_capture(data, demo_sha256="b" * 64, max_clips=1)
        self.assertEqual(result["status"], "awaiting_render_node")
        self.assertFalse(result["exact_animation_rendered"])
        self.assertEqual(result["fps"], 120)
        self.assertEqual(len(result["clips"]), 1)
        self.assertEqual(result["clips"][0]["preroll_tick"], 808)
        self.assertEqual(result["clips"][0]["shot_ticks"], [1050])
        self.assertTrue(result["truncated"])
        self.assertEqual(result["capture_seconds"], 2)
        self.assertEqual(plan_capture(data, demo_sha256="b" * 64, max_seconds=1)["clips"], [])

    def test_reject_mismatched_source_or_capture_parameters(self):
        for changes in ({"demo_sha256": "c" * 64}, {"fps": 1000}, {"fps": True}, {"max_clips": 0}, {"max_seconds": 10000}):
            options = {"demo_sha256": "b" * 64, **changes}
            with self.subTest(changes=changes), self.assertRaises(NativeAnimationError):
                plan_capture(self.analysis(), **options)
        data = self.analysis()
        data["provenance"]["tickrate"] = float("nan")
        with self.assertRaises(NativeAnimationError):
            plan_capture(data, demo_sha256="b" * 64)


if __name__ == "__main__":
    unittest.main()
