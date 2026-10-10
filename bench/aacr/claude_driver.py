#!/usr/bin/env python3
"""The Claude Code arm's one call into the AACR harness — INSIDE the sandbox only.

The project's single sanctioned place to run Claude Code (CLAUDE.md rule 5):
Claude Code runs as a benchmarked reviewer inside the locked-down bench/aacr
image, never on the host. This file is the only thing in this repo that reaches the
harness's Claude runner, and it is run only by src/bench/claudecode.ts, which
only `in-container.sh claude-review` reaches (tests/bench-claude.test.ts fences
all three).

Nothing here re-implements the runner. It imports the harness's own
`evaluation/reviewers/claude.py` (pinned in the image) and calls:

  run_claude_review(...)  — builds and runs, flag for flag, the harness's
      claude -p '/code-review <base>...<head> ' --add-dir <repo>
        --permission-mode acceptEdits --output-format json
        --mcp-config <findings server> --allowed-tools mcp__findings__report
        --append-system-prompt <findings prompt> --settings <StopFailure hook>
      with its process timeout (timeout×60+60 s), cwd = the repo;
  save_result(...)        — writes <results>/<safe_id>.json exactly as the
      harness does (MCP partial vs stdout, the larger wins), which the
      harness's `build_target_comments_from_claude` then scores untouched.

What is ours, all mechanical:
  - the repo is prepared by claudecode.ts (`prepareTree`: the prefetched
    objects, head detached) instead of the harness's clone — `prepare_repo`
    is not called, so there is no network clone and no fetch;
  - `claude_env` is {CLAUDE_CODE_MAX_RETRIES} only. The harness's
    `resolve_claude_env` demands a gateway triple (ANTHROPIC_BASE_URL /
    ANTHROPIC_AUTH_TOKEN / ANTHROPIC_MODEL); this arm runs on Claude Code's
    own credential (CLAUDE_CODE_OAUTH_TOKEN or ANTHROPIC_API_KEY, from
    bench/aacr/claude.env) and Claude Code's default model, which the case
    summary records from the JSON output;
  - the argv the harness ran (CompletedProcess.args) is written to --argv-out
    so claudecode.ts can check it against the pinned shape.

  --self-test   run the same two harness calls against a stub `claude` that
                records its argv (the image build runs this; no model call)
  --check-results DIR [--require-view]
                check every result file's OCR-shaped `review` view (written by
                src/bench/claudecode.ts `withClaudeView`) with the harness's
                OWN readers: where the harness got structured findings, its
                Claude reader and its OCR reader must see the same comments;
                where it stored raw text, the OCR reader must see exactly the
                comments the prose parser recorded. --require-view: a result
                file with no view fails (the eval refuses such a run).
"""
from __future__ import annotations

import argparse
import json
import os
import stat
import sys
import tempfile
import time
from datetime import datetime, timezone
from pathlib import Path
from types import SimpleNamespace

HARNESS = Path(os.environ.get("AACR_HARNESS_EVAL_DIR", "/opt/aacr-bench/evaluation"))
sys.path.insert(0, str(HARNESS))


def _harness():
    import config  # noqa: E402  (the harness's own)
    from reviewers import claude as runner  # noqa: E402

    return config, runner


def review(a: argparse.Namespace) -> int:
    config, runner = _harness()
    results_dir = Path(a.results_dir)
    results_dir.mkdir(parents=True, exist_ok=True)
    # review_instance's own pre-run cleanup of a stale partial.
    stale = config.partial_path(results_dir, a.instance_id).resolve()
    if stale.exists():
        stale.unlink()
    claude_env = {
        config.CLAUDE_MAX_RETRIES_VAR: os.environ.get(
            config.CLAUDE_MAX_RETRIES_VAR, str(config.CLAUDE_MAX_RETRIES_DEFAULT)
        )
    }
    started_at = datetime.now(timezone.utc).isoformat()
    t0 = time.monotonic()
    proc = runner.run_claude_review(
        repo_path=Path(a.repo),
        base_commit=a.base,
        head_commit=a.head,
        instance_id=a.instance_id,
        results_dir=results_dir,
        claude_env=claude_env,
        timeout_minutes=a.timeout_min,
    )
    duration = time.monotonic() - t0
    if a.argv_out:
        Path(a.argv_out).write_text(json.dumps(list(proc.args), indent=2) + "\n")
    if a.stdout_out:
        Path(a.stdout_out).write_text(proc.stdout or "")
    instance = SimpleNamespace(
        instance_id=a.instance_id, repo=a.repo_name, base_commit=a.base, head_commit=a.head
    )
    out = runner.save_result(results_dir, instance, proc, started_at, duration)
    runner._check_and_log_retry_exhausted(out, results_dir)
    print(f"claude-driver: exit={proc.returncode} result={out}", flush=True)
    return 0


def _readers():
    os.environ.setdefault("JUDGE_USE_MOCK", "true")
    import evaluate  # noqa: E402  (the harness's own)

    return evaluate.build_target_comments_from_claude, evaluate.build_target_comments_from_ocr


def check_result(result: dict) -> tuple:
    """One result file: (kind, comments) — kind "harness" | "prose" | "no-view".
    Raises SystemExit when the view disagrees with the harness's readers."""
    from_claude, from_ocr = _readers()
    if not isinstance(result.get("review"), dict):
        return "no-view", 0
    ocr = from_ocr(result)
    if isinstance(result.get("review_output"), list):
        claude = from_claude(result)
        if claude != ocr:
            raise SystemExit(
                f"{result.get('instance_id')}: the view disagrees with the harness's Claude reader: "
                f"{len(claude)} vs {len(ocr)} comment(s)"
            )
        return "harness", len(ocr)
    want = ((result.get("bench") or {}).get("claude_prose_parsed") or {}).get("findings")
    if want is not None and want != len(ocr):
        raise SystemExit(
            f"{result.get('instance_id')}: the OCR reader sees {len(ocr)} comment(s), the prose parser recorded {want}"
        )
    return "prose", len(ocr)


def check_results(results_dir: Path, require_view: bool) -> int:
    counts = {"harness": 0, "prose": 0, "no-view": 0}
    comments = 0
    for f in sorted(results_dir.glob("*.json")):
        if f.name.startswith("metrics_"):
            continue
        kind, n = check_result(json.loads(f.read_text(encoding="utf-8")))
        counts[kind] += 1
        comments += n
    print(
        f"claude-driver: {sum(counts.values())} result file(s) — {counts['harness']} from the harness's findings "
        f"(Claude reader == OCR reader), {counts['prose']} from the prose parser, {counts['no-view']} with no view; "
        f"{comments} comment(s) for the OCR reader",
        flush=True,
    )
    if require_view and counts["no-view"]:
        print(f"claude-driver: {counts['no-view']} result file(s) have no review view", file=sys.stderr)
        return 1
    return 0


def self_test() -> int:
    """The two harness calls against a stub `claude` — proves, at image build,
    that the pinned runner still builds the argv claudecode.ts checks and
    still writes the result shape it reads. No network, no credential."""
    tmp = Path(tempfile.mkdtemp(prefix="claude-driver-selftest-"))
    bin_dir, repo, results = tmp / "bin", tmp / "repo", tmp / "results"
    for d in (bin_dir, repo, results):
        d.mkdir()
    stub = bin_dir / "claude"
    stub.write_text(
        "#!/usr/bin/env python3\n"
        "import json, sys\n"
        "json.dump(sys.argv[1:], open(sys.argv[0] + '.argv', 'w'))\n"
        "print(json.dumps({'type': 'result', 'result': '[]', 'num_turns': 1,"
        " 'modelUsage': {'stub-model': {'inputTokens': 1, 'outputTokens': 2}}}))\n"
    )
    stub.chmod(stub.stat().st_mode | stat.S_IEXEC)
    os.environ["PATH"] = f"{bin_dir}:{os.environ.get('PATH', '')}"
    ns = argparse.Namespace(
        repo=str(repo), base="a" * 40, head="b" * 40, instance_id="o__r@1234567",
        repo_name="o/r", results_dir=str(results), timeout_min=1,
        argv_out=str(tmp / "argv.json"), stdout_out=None,
    )
    review(ns)
    argv = json.loads((tmp / "argv.json").read_text())
    seen = json.loads(Path(str(stub) + ".argv").read_text())
    assert argv[0] == "claude" and argv[1:] == seen, (argv, seen)
    flags = [x for x in argv if x.startswith("--")]
    assert flags == [
        "--add-dir", "--permission-mode", "--output-format", "--mcp-config",
        "--allowed-tools", "--append-system-prompt", "--settings",
    ], flags
    assert argv[1:3] == ["-p", f"/code-review {'a' * 40}...{'b' * 40} "], argv[1:3]
    result = json.loads((results / "o__r@1234567.json").read_text())
    assert result["reviewer"] == "claude-code/code-review", result
    assert result["review_output"] == [] and result["token_usage"]["output_tokens"] == 2, result
    # The view check, against the harness's own two readers.
    finding = {"file": "a.py", "line": 3, "summary": " S ", "failure_scenario": "F"}
    ok = {"review_output": [finding, "not a dict"],
          "review": {"comments": [{"path": "a.py", "start_line": 3, "end_line": 3, "content": "S\nF"}]}}
    assert check_result(ok) == ("harness", 1), check_result(ok)
    bad = json.loads(json.dumps(ok))
    bad["review"]["comments"][0]["end_line"] = 4
    try:
        check_result(bad)
    except SystemExit:
        pass
    else:
        raise AssertionError("a view that disagrees with the Claude reader must be refused")
    prose = {"review_output": "- `a.py:3` — wrong", "bench": {"claude_prose_parsed": {"findings": 1}},
             "review": {"comments": [{"path": "a.py", "start_line": 3, "end_line": 3, "content": "`a.py:3` — wrong"}]}}
    assert check_result(prose) == ("prose", 1), check_result(prose)
    assert check_result({"review_output": "text"}) == ("no-view", 0)
    print("claude-driver self-test: ok")
    return 0


def main() -> int:
    p = argparse.ArgumentParser()
    p.add_argument("--self-test", action="store_true")
    p.add_argument("--repo")
    p.add_argument("--repo-name")
    p.add_argument("--base")
    p.add_argument("--head")
    p.add_argument("--instance-id")
    p.add_argument("--results-dir")
    p.add_argument("--timeout-min", type=int, default=30)
    p.add_argument("--argv-out")
    p.add_argument("--stdout-out")
    p.add_argument("--check-results")
    p.add_argument("--require-view", action="store_true")
    a = p.parse_args()
    if a.self_test:
        return self_test()
    if a.check_results:
        return check_results(Path(a.check_results), a.require_view)
    for k in ("repo", "repo_name", "base", "head", "instance_id", "results_dir"):
        if not getattr(a, k):
            p.error(f"--{k.replace('_', '-')} is required")
    return review(a)


if __name__ == "__main__":
    sys.exit(main())
