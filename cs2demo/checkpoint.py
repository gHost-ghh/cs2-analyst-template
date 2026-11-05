"""Publish generated progress from the trusted main-branch Actions worker."""
from __future__ import annotations

import argparse
import os
from pathlib import Path
import re
import subprocess
import sys


# Leave headroom below GitHub's 100 MiB per-file rejection limit.
MAX_FILE_BYTES = 95 * 1024 * 1024


class CheckpointError(RuntimeError):
    """Only a bounded error code may leave the Git subprocess boundary."""


def write_workflow_output(name: str, value: str, path: str | None = None) -> None:
    target = path or os.getenv("GITHUB_OUTPUT")
    if os.getenv("GITHUB_ACTIONS") == "true" and target:
        with open(target, "a", encoding="utf-8") as output:
            output.write(f"{name}={value}\n")


class GitCheckpointPublisher:
    def __init__(self, root: Path, *, verify_actions: bool = True):
        self.root = Path(root).resolve()
        self.published = False
        if verify_actions and (os.getenv("GITHUB_ACTIONS") != "true" or
                               os.getenv("GITHUB_REF") != "refs/heads/main"):
            raise CheckpointError("checkpoint_requires_actions_main")
        if Path(self._git("rev-parse", "--show-toplevel").strip()).resolve() != self.root:
            raise CheckpointError("checkpoint_repository_mismatch")
        if self._git("symbolic-ref", "--quiet", "--short", "HEAD").strip() != "main":
            raise CheckpointError("checkpoint_requires_main_branch")
        remote = self._git("remote", "get-url", "origin").strip()
        if not remote:
            raise CheckpointError("checkpoint_origin_missing")
        if verify_actions:
            repository = os.getenv("GITHUB_REPOSITORY", "")
            server = os.getenv("GITHUB_SERVER_URL", "https://github.com").rstrip("/")
            expected = f"{server}/{repository}"
            if not re.fullmatch(r"[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+", repository) or remote.rstrip("/").removesuffix(".git") != expected:
                raise CheckpointError("checkpoint_origin_mismatch")
        git_dir = Path(self._git("rev-parse", "--absolute-git-dir").strip())
        self.report_error_path = git_dir / "cs2-checkpoint-report-error"
        self._git("config", "user.name", "cs2-sync-bot")
        self._git("config", "user.email", "cs2-sync-bot@users.noreply.github.com")

    def _git(self, *args: str, timeout: int = 90, allow_failure: bool = False):
        environment = dict(os.environ, GIT_TERMINAL_PROMPT="0", GIT_EDITOR="true", GIT_SEQUENCE_EDITOR="true")
        try:
            result = subprocess.run(["git", *args], cwd=self.root, env=environment,
                                    capture_output=True, text=True, timeout=timeout, check=False)
        except (OSError, subprocess.TimeoutExpired):
            raise CheckpointError("checkpoint_git_unavailable") from None
        if allow_failure:
            return result
        if result.returncode:
            raise CheckpointError("checkpoint_git_" + args[0].replace("-", "_"))
        return result.stdout

    def mark_reports_ready(self, ready: bool, code: str = "checkpoint_report_generation_failed") -> None:
        if ready:
            self.report_error_path.unlink(missing_ok=True)
        else:
            self.report_error_path.write_text(code + "\n", encoding="utf-8")

    def _oversized(self, scope: str) -> bool:
        names = self._git("ls-files", "--cached", "--others", "--exclude-standard", "-z", "--", scope)
        return any((self.root / name).is_file() and (self.root / name).stat().st_size > MAX_FILE_BYTES
                   for name in names.split("\0") if name)

    def publish(self, *, include_reports: bool | None = None) -> bool:
        """Commit settled data, then push it without discarding concurrent changes.

        A failed report export leaves reports unstaged. Its local marker also
        protects the workflow's final retry from publishing partial report files.
        """
        if include_reports is None:
            include_reports = not self.report_error_path.exists()
        staged = self._git("diff", "--cached", "--name-only", "-z")
        if any(not name.startswith(("data/", "reports/")) for name in staged.split("\0") if name):
            raise CheckpointError("checkpoint_unrelated_staged_changes")
        if self._oversized("data/"):
            raise CheckpointError("checkpoint_data_file_too_large")
        report_error = None
        if include_reports and self._oversized("reports/"):
            report_error = "checkpoint_report_file_too_large"
            self.mark_reports_ready(False, report_error)
            include_reports = False
        if not include_reports:
            # A previous failed attempt may already have staged a partial report.
            self._git("reset", "--quiet", "HEAD", "--", "reports/")
        scopes = ["data/"] + (["reports/"] if include_reports else [])
        self._git("add", "--", *scopes)
        changes = self._git("diff", "--cached", "--quiet", allow_failure=True)
        if changes.returncode not in (0, 1):
            raise CheckpointError("checkpoint_git_diff")
        if changes.returncode == 1:
            self._git("commit", "-m", "chore: checkpoint CS2 match progress")
        self._git("fetch", "--no-tags", "origin", "main", timeout=90)
        # Autostash preserves incomplete report edits during a data-only retry.
        rebased = self._git("rebase", "--autostash", "origin/main", allow_failure=True)
        if rebased.returncode:
            self._git("rebase", "--abort", allow_failure=True)
            raise CheckpointError("checkpoint_rebase_conflict")
        restore_conflict = bool(self._git("diff", "--name-only", "--diff-filter=U").strip())
        if restore_conflict:
            self.mark_reports_ready(False, "checkpoint_autostash_conflict")
        ahead = self._git("rev-list", "--count", "origin/main..HEAD").strip()
        pushed = ahead != "0"
        if pushed:
            self._git("push", "origin", "HEAD:refs/heads/main", timeout=120)
            self.published = True
        if restore_conflict:
            raise CheckpointError("checkpoint_autostash_conflict")
        if report_error:
            raise CheckpointError(report_error)
        return pushed


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--root", type=Path, default=Path.cwd())
    parser.add_argument("--github-output")
    args = parser.parse_args()
    publisher = None
    try:
        publisher = GitCheckpointPublisher(args.root)
        publisher.publish()
        if publisher.report_error_path.exists():
            raise CheckpointError("checkpoint_reports_incomplete")
        return 0
    except CheckpointError as exc:
        print(str(exc), file=sys.stderr)
        return 1
    except Exception:
        print("checkpoint_unexpected_failure", file=sys.stderr)
        return 1
    finally:
        if publisher and publisher.published:
            write_workflow_output("changed", "true", args.github_output)


if __name__ == "__main__":
    sys.exit(main())
