"""Private bounded subprocess entry point. Never outputs parsed input or errors."""
import json
from pathlib import Path
import sys


def main():
    output = Path(sys.argv[3])
    progress_path = output.with_name("parse_progress.json")
    stage = "start"
    def progress(value):
        nonlocal stage
        stage = value
        progress_path.write_text(json.dumps({"stage": value}), encoding="utf-8")
    try:
        # Ubuntu GitHub runners have 7 GB RAM. Keep native parse failure inside
        # the child so the parent can persist progress and generate reports.
        if sys.platform == "linux":
            import resource
            resource.setrlimit(resource.RLIMIT_AS, (6656 * 1024**2, 6656 * 1024**2))
            resource.setrlimit(resource.RLIMIT_CPU, (220, 220))
        from .parser import parse_demo, RoundMetadataError
        result = parse_demo(Path(sys.argv[1]), sys.argv[2], progress=progress)
        output.write_text(json.dumps(result, ensure_ascii=False, allow_nan=False), encoding="utf-8")
        return 0
    except BaseException as exc:
        message = str(exc)
        code = "parser_memory_limit" if isinstance(exc, MemoryError) else "parser_player_absent" if message.startswith("Configured SteamID64") else "parser_event_schema" if message.startswith("Demo event ") else "parser_no_live_rounds" if message.startswith("No complete live rounds") else "parser_python_error"
        detail = {"error_code": code, "error_stage": stage}
        if isinstance(exc, RoundMetadataError):
            detail["error_details"] = exc.diagnostics
        output.write_text(json.dumps(detail, allow_nan=False), encoding="utf-8")
        return 1


if __name__ == "__main__":
    sys.exit(main())
