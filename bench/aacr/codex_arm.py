#!/usr/bin/env python3
"""The Codex CLI arm: one case through the AACR harness's OWN Codex runner.

`src/bench/codex.ts` (the `codex-review` command) prepares the case — the same
`prepareTree` checkout every arm gets, the refresh-disabled token copy turned
into a Codex `auth.json` — and then runs this file with the harness venv's
Python. Nothing about HOW Codex reviews is re-implemented here: this imports
`evaluation/reviewers/codex.py` at the pinned harness commit and calls its
`review_instance`, so the prompt (`build_findings_prompt`), the argv
(`codex --sandbox workspace-write exec review --json --skip-git-repo-check
"/review <base>...<head> (<MCP instructions>)"`), the process timeout
(timeout×60+60 s), the temporary CODEX_HOME + config.toml
(`write_codex_config`: model + the `findings` MCP server
`mcp_codex_finding_server.py`), the two-channel finding collection (MCP
partial file vs. the JSONL `agent_message`, more wins, tie → MCP), the token
usage (turn.completed, else the review sub-agent's session rollout) and the
result file (`save_result`) are all the harness's code, untouched.

What this driver changes, and nothing else:
  - `prepare_repo` is replaced by the already-prepared tree (the harness would
    clone from github.com; the sandbox reviews offline from the prefetched
    store — same base, same head, same merge-base);
  - codex_env carries only CODEX_MODEL: no CODEX_API_KEY and no gateway, so
    Codex uses its native ChatGPT login — the `auth.json` placed into the
    temporary CODEX_HOME, whose refresh token is the disabled sentinel;
  - config.toml gets a short PRELUDE of top-level keys before the harness's
    own lines (see CONFIG_PRELUDE): reasoning effort, file-only credentials,
    no update check, no web search (the benchmark's answers are public PR
    review comments on github.com), no analytics upload.

Afterwards the Codex session rollouts are copied into the case dir (for the
record and token accounting) and the temporary CODEX_HOME, auth.json
included, is removed by the harness's own `cleanup_codex_home`.

`--check-result FILE` verifies a converted result file with the harness's own
readers: the Codex reader (`build_target_comments_from_codex`, over
`review_output`) and the OCR reader (`build_target_comments_from_ocr`, over
the `review` view src/bench/codex.ts adds so the rest of this bench — the
`--reviewer ocr` eval, the defect judge, compare.py — reads it unchanged)
must produce the SAME comments. `--self-test` runs both checks on fixtures
at image build.
"""
from __future__ import annotations

import argparse
import json
import os
import shutil
import sys
from pathlib import Path
from typing import Any, Dict, List

EVAL_DIR = Path(os.environ.get("AACR_EVAL_DIR", "/opt/aacr-bench/evaluation"))
DISABLED_REFRESH = "bench-refresh-disabled"  # = src/bench/auth.ts DISABLED_REFRESH


def _harness():
    sys.path.insert(0, str(EVAL_DIR))
    import config  # noqa: E402
    import schema  # noqa: E402
    from reviewers import codex as cx  # noqa: E402

    return config, schema, cx


def config_prelude(effort: str) -> str:
    """Top-level keys placed BEFORE the harness's config.toml lines (a TOML
    top-level key after a table header would land inside that table)."""
    return (
        "# qcr-bench prelude (bench/aacr/codex_arm.py); the harness's own lines follow\n"
        f'model_reasoning_effort = "{effort}"\n'
        'cli_auth_credentials_store = "file"\n'
        'forced_login_method = "chatgpt"\n'
        "check_for_update_on_startup = false\n"
        'web_search = "disabled"\n'
        "\n"
    )


ANALYTICS_OFF = "\n[analytics]\nenabled = false\n"


def check_auth(path: Path) -> None:
    """Refuse any auth.json that could refresh: the ChatGPT tokens must carry
    the disabled sentinel as their refresh token, and no API key."""
    data = json.loads(path.read_text(encoding="utf-8"))
    tokens = data.get("tokens") or {}
    if data.get("auth_mode") != "chatgpt" or tokens.get("refresh_token") != DISABLED_REFRESH:
        raise SystemExit(f"{path}: not a refresh-disabled ChatGPT auth.json — refusing it")
    if data.get("OPENAI_API_KEY"):
        raise SystemExit(f"{path}: carries an API key — refusing it")


def with_pr_text(build, pr_text: str):
    """The harness's prompt builder with the PR text appended after it."""
    text = pr_text.strip()

    def build_with_pr_text(base_commit: str, head_commit: str) -> str:
        return f"{build(base_commit, head_commit)}\n\n{text}"

    return build_with_pr_text


def load_instance(schema, dataset: Path, instance_id: str):
    for inst in schema.load_instances(dataset):
        if inst.instance_id == instance_id:
            return inst
    raise SystemExit(f"{instance_id}: not in {dataset}")


def review(a: argparse.Namespace) -> int:
    for k in ("CODEX_API_KEY", "OPENAI_API_KEY", "CODEX_GATEWAY_URL", "CODEX_HOME"):
        if os.environ.get(k):
            raise SystemExit(f"{k} is set — this arm uses only the refresh-disabled ChatGPT login")
    auth_src = Path(a.auth_json)
    check_auth(auth_src)
    config, schema, cx = _harness()
    instance = load_instance(schema, Path(a.dataset), a.instance_id)
    tree = Path(a.tree)
    results = Path(a.results)
    case_dir = Path(a.case_dir)
    case_dir.mkdir(parents=True, exist_ok=True)
    os.environ["CODEX_HOME_BASE"] = a.home_base  # the harness's own knob (not /tmp)
    os.environ.pop("CODEX_HOME_BACKUP", None)
    Path(a.home_base).mkdir(parents=True, exist_ok=True)

    codex_env: Dict[str, str] = {config.CODEX_MODEL_VAR: a.model}
    cx.ensure_codex_installed()
    codex_home = cx.write_codex_config(codex_env)
    try:
        cfg = codex_home / "config.toml"
        harness_cfg = cfg.read_text(encoding="utf-8")
        cfg.write_text(config_prelude(a.effort) + harness_cfg + ANALYTICS_OFF, encoding="utf-8")
        (case_dir / "codex-config.toml").write_text(cfg.read_text(encoding="utf-8"), encoding="utf-8")
        dst = codex_home / "auth.json"
        shutil.copyfile(auth_src, dst)
        os.chmod(dst, 0o600)
        # The harness clones from github.com; this sandbox reviews offline from
        # the prefetched store, prepared by src/bench/runner.ts prepareTree.
        cx.prepare_repo = lambda **_kw: tree
        captured: Dict[str, Any] = {}
        real_run = cx.run_codex_review

        def run_and_capture(**kw):
            proc = real_run(**kw)
            captured["argv"] = list(proc.args) if isinstance(proc.args, (list, tuple)) else proc.args
            captured["exit_code"] = proc.returncode
            return proc

        cx.run_codex_review = run_and_capture
        if a.pr_text:
            # The equal-inputs switch (src/bench/prtext.ts): the PR's title and
            # body appended to the harness's own /review instructions — Codex's
            # custom-review-instructions channel. Without --pr-text the prompt
            # is the harness's, untouched.
            cx.build_findings_prompt = with_pr_text(cx.build_findings_prompt, Path(a.pr_text).read_text(encoding="utf-8"))
        summary = cx.review_instance(
            instance=instance,
            repo_dir=tree.parent,
            results_dir=results,
            codex_env=codex_env,
            codex_home=codex_home,
            timeout_minutes=a.timeout_min,
        )
        sessions = codex_home / "sessions"
        if sessions.is_dir():
            out = case_dir / "codex-sessions"
            out.mkdir(exist_ok=True)
            for f in sorted(sessions.rglob("*.jsonl")):
                shutil.copyfile(f, out / f.name)
        record = {"summary": summary, **captured}
        (case_dir / "codex-driver.json").write_text(json.dumps(record, indent=2) + "\n", encoding="utf-8")
        print(json.dumps(record))
    finally:
        cx.cleanup_codex_home(codex_home)
    return 0


def _builders():
    os.environ.setdefault("JUDGE_USE_MOCK", "true")
    sys.path.insert(0, str(EVAL_DIR))
    import evaluate  # noqa: E402

    return evaluate.build_target_comments_from_codex, evaluate.build_target_comments_from_ocr


def check_result(result: Dict[str, Any]) -> int:
    """Both harness readers must see the same comments; returns the count."""
    from_codex, from_ocr = _builders()
    a, b = from_codex(result), from_ocr(result)
    if a != b:
        raise SystemExit(
            f"the OCR-shaped view disagrees with the harness's Codex reader: {len(a)} vs {len(b)} comment(s)"
        )
    return len(a)


def self_test() -> None:
    finding = {"file": "a.py", "start_line": 3, "end_line": 5, "severity": "Major",
               "summary": "  S  ", "description": "D"}
    ok = {
        "reviewer": "codex",
        "review_output": [finding, {"file": "b.py", "start_line": None, "end_line": 7, "summary": "", "description": ""},
                          "not a dict", {"file": "c.py", "start_line": 9, "summary": "only summary"}],
        "review": {"comments": [
            {"path": "a.py", "start_line": 3, "end_line": 5, "content": "S\nD"},
            {"path": "c.py", "start_line": 9, "end_line": None, "content": "only summary"},
        ]},
    }
    assert check_result(ok) == 2
    bad = json.loads(json.dumps(ok))
    bad["review"]["comments"][0]["end_line"] = 6
    try:
        check_result(bad)
    except SystemExit:
        pass
    else:
        raise AssertionError("a disagreeing view must be refused")
    raw = {"reviewer": "codex", "review_output": "free text", "review": {"comments": []}}
    assert check_result(raw) == 0
    # The harness's argv and prompt, as run_codex_review builds them.
    _, _, cx = _harness()
    import subprocess

    seen: Dict[str, Any] = {}
    real = subprocess.run
    try:
        subprocess.run = lambda cmd, **kw: (seen.update(cmd=cmd, kw=kw), subprocess.CompletedProcess(cmd, 0, "", ""))[1]
        cx.subprocess.run = subprocess.run
        cx.run_codex_review(repo_path=Path("/tmp"), base_commit="b" * 40, head_commit="h" * 40,
                            instance_id="o__r@1", results_dir=Path("/tmp/r"), codex_env={},
                            codex_home=Path("/tmp/ch"), timeout_minutes=30)
    finally:
        subprocess.run = real
        cx.subprocess.run = real
    cmd = seen["cmd"]
    assert cmd[:7] == ["codex", "--sandbox", "workspace-write", "exec", "review", "--json", "--skip-git-repo-check"], cmd
    assert cmd[7].startswith(f"/review {'b' * 40}...{'h' * 40} (You have an MCP tool named `report`."), cmd[7][:120]
    assert seen["kw"]["timeout"] == 30 * 60 + 60
    wrapped = with_pr_text(cx.build_findings_prompt, "  Title: T\n\nbody  ")("b" * 40, "h" * 40)
    assert wrapped.startswith(f"/review {'b' * 40}...{'h' * 40} (You have an MCP tool named `report`."), wrapped[:80]
    assert wrapped.endswith(")\n\nTitle: T\n\nbody"), wrapped[-40:]
    prelude = config_prelude("medium")
    assert "[" not in prelude, "the prelude must hold top-level keys only"
    print("codex_arm self-test ok")


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--self-test", action="store_true")
    ap.add_argument("--check-result")
    ap.add_argument("--instance-id")
    ap.add_argument("--dataset", default="/opt/aacr-data/aacr_bench_v1.jsonl")
    ap.add_argument("--tree")
    ap.add_argument("--results")
    ap.add_argument("--case-dir")
    ap.add_argument("--home-base")
    ap.add_argument("--auth-json")
    ap.add_argument("--timeout-min", type=int, default=30)
    ap.add_argument("--model", default="gpt-6-sol")
    ap.add_argument("--effort", default="medium")
    ap.add_argument("--pr-text", help="a file whose text is appended to the /review instructions")
    a = ap.parse_args()
    if a.self_test:
        self_test()
        return 0
    if a.check_result:
        n = check_result(json.loads(Path(a.check_result).read_text(encoding="utf-8")))
        print(json.dumps({"comments": n}))
        return 0
    for k in ("instance_id", "tree", "results", "case_dir", "home_base", "auth_json"):
        if not getattr(a, k):
            ap.error(f"--{k.replace('_', '-')} is required")
    return review(a)


if __name__ == "__main__":
    sys.exit(main())
