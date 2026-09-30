#!/usr/bin/env python3
"""The PR-Agent arm's driver: ONE PR-Agent CLI command on one prepared case
(describe, review or improve — the GitHub App's default pr_commands).

PR-Agent (qodo-ai/pr-agent, MIT) reviews a PR from a local checkout through
its documented LOCAL git provider (`CONFIG__GIT_PROVIDER=local python -m
pr_agent.cli --pr_url <target branch> review|improve`, usage-guide
local_git_provider.md): HEAD is the proposed change, the diff is HEAD against
merge-base(HEAD, <target branch>) — exactly `git diff base...head` — and the
full base/head file contents give the model its extended context. This driver
runs that CLI entry point (`pr_agent.cli.run`) unchanged, with ONE provider
swapped in: `bench-local`, a LocalGitProvider subclass registered through
PR-Agent's own `register_git_provider` hook. Where it differs from `local`, it
does what PR-Agent's GitHub provider does on a real PR:

  1. the PR TITLE and DESCRIPTION are the PR's own (from the prefetched public
     API) — the stock local provider substitutes the branch name and 200
     characters of commit messages. `--no-pr-text` keeps the stock values;
  2. repository context (`config.repo_context_files`, default ["AGENTS.md"],
     read from the default branch) is served from the target branch's commit —
     the stock local provider has no file fetching and skips it;
  3. the head branch is a string (the stock provider hands the prompt a
     GitPython `HEAD` object, which also breaks its ticket extraction);
  4. the structured review (PR-Agent's own `publish_structured_review` hook,
     the one its plain-diff provider uses for `--json-output`) and the
     rendered /improve suggestions (`publish_code_suggestions_artifact`, which
     the local provider renders into improve.md) are ALSO written as JSON, so
     findings keep their file and line range instead of being re-parsed out of
     Markdown; its output files live outside the tree.

Everything else is PR-Agent's defaults (configuration.toml of the pinned
release): prompts, `num_max_findings = 3`, `max_model_tokens = 32000`,
patch-extension, /improve's self-reflection scoring, `reasoning_effort =
"medium"`. The model is set the way PR-Agent documents an OpenAI-compatible
endpoint — LiteLLM `openai/<model>` with `openai.api_base` — pointed at the
sandbox's loopback Codex bridge (codex_bridge.py), which holds the only
credential; PR-Agent gets a dummy key. Settings the bench must fix, and why:

  config.model / fallback_models   openai/<model>; no fallback (the bridge forces
                                   one model, so a fallback retry would only
                                   repeat the call at double cost)
  config.custom_model_max_tokens   the model's context window (272k, pi's catalog)
                                   — PR-Agent refuses a model not in its table
                                   without it; max_model_tokens still clamps
  config.additional_reasoning_effort_models   so PR-Agent's own reasoning_effort
                                   reaches the endpoint as it would for a model
                                   LiteLLM knows (the bridge forces the effort
                                   anyway and logs what was asked)
  litellm.drop_params              true (PR-Agent's documented [litellm] knob):
                                   PR-Agent sends temperature 0.2 to a model it does
                                   not know as a GPT-5/6 reasoning model, and
                                   LiteLLM refuses a temperature beside a
                                   reasoning_effort; dropped, as PR-Agent itself
                                   drops it for the GPT-5 family
  config.git_provider              bench-local (above)
  config.publish_output_progress   false (no "Preparing…" placeholders)
  config.use_repo_settings_file / use_global_settings_file / extra_config_url
                                   nothing but this config: the reviewed repo's
                                   .pr_agent.toml is never fetched by the local
                                   provider; `[tool.pr-agent]` in its
                                   pyproject.toml is loaded by PR-Agent at import
                                   and overridden here key by key (and recorded)

Stdlib + the pinned pr-agent install only. `--self-test` runs both commands
end to end against an in-process stub OpenAI endpoint on a scratch repo.
"""
from __future__ import annotations

import argparse
import json
import os
import subprocess
import sys
import tempfile
import threading
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from typing import Any, Dict, List, Optional

PROVIDER_ID = "bench-local"
CONTEXT_WINDOW = 272_000  # pi 0.99.1's catalog: openai-codex/gpt-6.1-sol contextWindow


def configure(settings: Any, a: argparse.Namespace) -> Dict[str, Any]:
    """The bench's settings on top of PR-Agent's defaults. Returns what was set."""
    fixed: Dict[str, Any] = {
        "CONFIG.MODEL": f"openai/{a.model}",
        "CONFIG.FALLBACK_MODELS": [],
        "CONFIG.CUSTOM_MODEL_MAX_TOKENS": CONTEXT_WINDOW,
        "CONFIG.ADDITIONAL_REASONING_EFFORT_MODELS": [a.model],
        "LITELLM.DROP_PARAMS": True,
        "CONFIG.GIT_PROVIDER": PROVIDER_ID,
        "CONFIG.PUBLISH_OUTPUT": True,
        "CONFIG.PUBLISH_OUTPUT_PROGRESS": False,
        "CONFIG.USE_REPO_SETTINGS_FILE": False,
        "CONFIG.USE_GLOBAL_SETTINGS_FILE": False,
        "CONFIG.EXTRA_CONFIG_URL": "",
        "OPENAI.KEY": "loopback-bridge",
        "OPENAI.API_BASE": a.api_base,
        "LOCAL.REVIEW_PATH": os.path.join(a.out, f"{a.command}-comment.md"),
        "LOCAL.IMPROVE_PATH": os.path.join(a.out, "improve.md"),
        "LOCAL.DESCRIPTION_PATH": os.path.join(a.out, "description.md"),
    }
    if a.command == "review":
        fixed["LOCAL.REVIEW_PATH"] = os.path.join(a.out, "review.md")
    for key, value in fixed.items():
        settings.set(key, value)
    return fixed


EFFECTIVE_SECTIONS = ("CONFIG", "PR_REVIEWER", "PR_CODE_SUGGESTIONS", "PR_DESCRIPTION", "LITELLM", "OPENAI",
                      "LOCAL", "GITHUB_APP")


def effective_settings(settings: Any, model: str) -> Dict[str, Any]:
    """PR-Agent's FULLY RESOLVED settings for the sections that shape a review,
    read back from its settings object after the command ran (defaults + the
    bench's keys + anything a repo file loaded), and the token budget it
    resolves for the model."""
    out: Dict[str, Any] = {}
    for section in EFFECTIVE_SECTIONS:
        try:
            out[section.lower()] = _plain(dict(settings.get(section) or {}))
        except Exception as e:  # noqa: BLE001
            out[section.lower()] = f"unreadable: {e}"
    if isinstance(out.get("openai"), dict) and out["openai"].get("key"):
        out["openai"]["key"] = "<dummy loopback key>"
    try:
        from pr_agent.algo.token_budget import get_max_tokens
        out["resolved_max_tokens"] = get_max_tokens(f"openai/{model}")
        out["resolved_context_window"] = get_max_tokens(f"openai/{model}", ignore_max_model_tokens=True)
    except Exception as e:  # noqa: BLE001
        out["resolved_max_tokens"] = f"unresolved: {e}"
    return out


def repo_pyproject_section(tree: str) -> Optional[str]:
    """Whether the reviewed repo's pyproject.toml carries a [tool.pr-agent]
    section PR-Agent loaded at import (the bench's keys override it)."""
    p = os.path.join(tree, "pyproject.toml")
    try:
        with open(p, encoding="utf-8", errors="replace") as fh:
            text = fh.read()
    except OSError:
        return None
    return "tool.pr-agent" if "[tool.pr-agent" in text or "[tool.pr_agent" in text else None


def make_provider(capture: Dict[str, Any], title: Optional[str], body: Optional[str]):
    from pr_agent.git_providers.local_git_provider import LocalGitProvider

    class BenchLocalGitProvider(LocalGitProvider):
        """PR-Agent's local provider + the PR's own title/body + JSON capture."""

        def __init__(self, target_branch_name, incremental=False):
            # get_pr_title() runs inside LocalGitProvider.__init__.
            self._bench_title = title
            self._bench_body = body
            super().__init__(target_branch_name, incremental)
            capture["pr_title"] = self.pr.title
            capture["diff_files"] = [f.filename for f in self.get_diff_files()]

        def get_pr_title(self):
            return self._bench_title if self._bench_title is not None else super().get_pr_title()

        def get_pr_description_full(self):
            return self._bench_body if self._bench_body is not None else super().get_pr_description_full()

        def get_pr_branch(self):
            return self.head_branch_name

        def get_repo_context_ref(self, from_default_branch: bool = False):
            ref = self.repo.branches[self.target_branch_name] if from_default_branch else self.repo.head
            return ref.commit.hexsha

        def get_repo_file_content(self, file_path: str, from_default_branch: bool = False) -> str:
            try:
                return self.repo.git.show(f"{self.get_repo_context_ref(from_default_branch)}:{file_path}")
            except Exception:  # noqa: BLE001 - absent file: no context, as on GitHub
                return ""

        def publish_description(self, pr_title: str, pr_body: str):
            # /describe's output — on GitHub it REPLACES the PR body the later
            # /review and /improve read (the TS side hands it to them).
            capture["published_description"] = {"title": pr_title, "body": pr_body}
            return super().publish_description(pr_title, pr_body)

        def publish_structured_review(self, review: dict):
            capture["structured_review"] = review

        def publish_comment(self, pr_comment: str, is_temporary: bool = False):
            if not is_temporary:
                capture.setdefault("comments", []).append(pr_comment)
            return super().publish_comment(pr_comment, is_temporary)

        def publish_code_suggestions_artifact(self, code_suggestions: list, artifact_footer: str = "",
                                              no_suggestions_message: str = "No code suggestions found for the PR."):
            capture.setdefault("suggestions", []).extend(_plain(s) for s in code_suggestions)
            return super().publish_code_suggestions_artifact(code_suggestions, artifact_footer, no_suggestions_message)

    return BenchLocalGitProvider


def _plain(v: Any) -> Any:
    """JSON-safe copy (suggestion dicts may carry non-JSON leaves)."""
    try:
        return json.loads(json.dumps(v, default=str))
    except (TypeError, ValueError):
        return str(v)


def run_command(a: argparse.Namespace) -> int:
    a.out, a.tree = os.path.abspath(a.out), os.path.abspath(a.tree)
    os.makedirs(a.out, exist_ok=True)
    title = body = None
    if not a.no_pr_text:
        title = _read(a.title_file)
        body = _read(a.body_file)
    os.chdir(a.tree)  # PR-Agent finds the repository root from the cwd
    from pr_agent import cli as pr_cli
    from pr_agent.config_loader import get_settings
    from pr_agent.git_providers import register_git_provider

    capture: Dict[str, Any] = {"command": a.command, "target_branch": a.target_branch}
    settings = get_settings()
    capture["settings"] = configure(settings, a)
    capture["repo_pyproject_section"] = repo_pyproject_section(a.tree)
    capture["reasoning_effort"] = settings.config.get("reasoning_effort")
    capture["max_model_tokens"] = settings.config.get("max_model_tokens")
    capture["pr_text"] = "none" if a.no_pr_text else ("pr" if title is not None else "missing")
    register_git_provider(PROVIDER_ID, make_provider(capture, title, body))
    started = time.time()
    rc: Any = 1
    try:
        rc = pr_cli.run(inargs=["--pr_url", a.target_branch, a.command])
        rc = 0 if rc in (None, 0) else int(rc)
    except SystemExit as e:  # argparse / explicit exits
        rc = e.code if isinstance(e.code, int) else 1
    except Exception as e:  # noqa: BLE001 - recorded, never raised past the case
        capture["error"] = f"{type(e).__name__}: {e}"[:2000]
        rc = 1
    capture["exit"] = rc
    capture["seconds"] = round(time.time() - started, 2)
    capture["effective"] = effective_settings(settings, a.model)
    with open(os.path.join(a.out, f"{a.command}.json"), "w", encoding="utf-8") as fh:
        json.dump(capture, fh, indent=2, default=str)
        fh.write("\n")
    return int(rc)


def _read(path: Optional[str]) -> Optional[str]:
    if not path:
        return None
    try:
        with open(path, encoding="utf-8") as fh:
            return fh.read()
    except OSError:
        return None


# ---- self-test: both commands against a stub OpenAI endpoint ------------------------

STUB_REVIEW = """```yaml
review:
  estimated_effort_to_review_[1-5]: |
    2
  relevant_tests: |
    No
  key_issues_to_review:
    - relevant_file: |
        calc.py
      issue_header: |
        Possible Bug
      issue_content: |
        Division by zero when b is 0.
      start_line: 2
      end_line: 3
  security_concerns: |
    No
```"""

STUB_IMPROVE = """```yaml
code_suggestions:
- relevant_file: |
    calc.py
  language: |
    python
  existing_code: |
    return a / b
  suggestion_content: |
    Guard against a zero divisor.
  improved_code: |
    return a / b if b else 0
  one_sentence_summary: |
    Guard zero divisor
  label: |
    possible bug
```"""

STUB_DESCRIBE = """```yaml
type:
- Bug fix
description: |
  Adds a division helper.
title: |
  Add division
changes_diagram: |
  ""
pr_files:
- filename: |
    calc.py
  changes_title: |
    Divide a by b
  label: |
    enhancement
```"""

STUB_REFLECT = """```yaml
code_suggestions:
- suggestion_summary: |
    Guard zero divisor
  relevant_file: |
    calc.py
  relevant_lines_start: 3
  relevant_lines_end: 3
  suggestion_score: 8
  why: |
    Real crash.
```"""


def _stub_server(seen: List[Dict[str, Any]]) -> ThreadingHTTPServer:
    class H(BaseHTTPRequestHandler):
        def log_message(self, *args):  # noqa: D401
            pass

        def do_POST(self):
            req = json.loads(self.rfile.read(int(self.headers.get("content-length") or 0)) or b"{}")
            seen.append({"path": self.path, "model": req.get("model"), "stream": req.get("stream"),
                         "keys": sorted(req)})
            text = json.dumps(req.get("messages") or req.get("input") or "")
            if "suggestion_score" in text:
                answer = STUB_REFLECT
            elif "PRDescription" in text:
                answer = STUB_DESCRIBE
            elif "PRCodeSuggestions" in text:
                answer = STUB_IMPROVE
            else:
                answer = STUB_REVIEW
            body = {"id": "x", "object": "chat.completion", "created": 0, "model": req.get("model"),
                    "choices": [{"index": 0, "finish_reason": "stop",
                                 "message": {"role": "assistant", "content": answer}}],
                    "usage": {"prompt_tokens": 10, "completion_tokens": 5, "total_tokens": 15}}
            raw = json.dumps(body).encode()
            self.send_response(200)
            self.send_header("content-type", "application/json")
            self.send_header("content-length", str(len(raw)))
            self.end_headers()
            self.wfile.write(raw)

    srv = ThreadingHTTPServer(("127.0.0.1", 0), H)
    threading.Thread(target=srv.serve_forever, daemon=True).start()
    return srv


def self_test() -> None:
    seen: List[Dict[str, Any]] = []
    srv = _stub_server(seen)
    with tempfile.TemporaryDirectory(prefix="pragent-selftest-") as tmp:
        tree, out = os.path.join(tmp, "tree"), os.path.join(tmp, "out")
        env = {**os.environ, "GIT_CONFIG_GLOBAL": "/dev/null", "GIT_CONFIG_NOSYSTEM": "1",
               "GIT_AUTHOR_NAME": "t", "GIT_AUTHOR_EMAIL": "t@t", "GIT_COMMITTER_NAME": "t",
               "GIT_COMMITTER_EMAIL": "t@t"}
        git = lambda *args: subprocess.run(["git", "-C", tree, *args], check=True, env=env,  # noqa: E731
                                           capture_output=True)
        os.makedirs(tree)
        git("init", "-q", "-b", "main")
        with open(os.path.join(tree, "calc.py"), "w") as fh:
            fh.write("def div(a, b):\n    return a\n")
        git("add", "."); git("commit", "-qm", "base")
        git("checkout", "-q", "--detach")
        with open(os.path.join(tree, "calc.py"), "w") as fh:
            fh.write("def div(a, b):\n    # divide\n    return a / b\n")
        git("commit", "-qam", "head")
        for f, t in (("title.txt", "Add division"), ("body.txt", "Divides a by b.")):
            with open(os.path.join(tmp, f), "w") as fh:
                fh.write(t)
        for command in ("describe", "review", "improve"):
            r = subprocess.run([sys.executable, os.path.abspath(__file__), "--tree", tree, "--target-branch", "main",
                                "--out", out, "--command", command, "--model", "gpt-6.1-sol",
                                "--api-base", f"http://127.0.0.1:{srv.server_address[1]}/v1",
                                "--title-file", os.path.join(tmp, "title.txt"),
                                "--body-file", os.path.join(tmp, "body.txt")],
                               env={**env, "LITELLM_LOCAL_MODEL_COST_MAP": "True"}, capture_output=True, text=True,
                               timeout=300)
            assert r.returncode == 0, (command, r.returncode, r.stdout[-3000:], r.stderr[-3000:])
        described = json.load(open(os.path.join(out, "describe.json")))
        assert "Adds a division helper" in described["published_description"]["body"], described
        review = json.load(open(os.path.join(out, "review.json")))
        assert review["effective"]["resolved_max_tokens"] == 32000, review["effective"]
        assert review["effective"]["pr_reviewer"]["num_max_findings"] == 3, review["effective"]
        issues = review["structured_review"]["review"]["key_issues_to_review"]
        assert review["pr_title"] == "Add division" and review["diff_files"] == ["calc.py"], review
        assert issues[0]["relevant_file"].strip() == "calc.py" and int(issues[0]["start_line"]) == 2, issues
        improve = json.load(open(os.path.join(out, "improve.json")))
        sug = improve["suggestions"]
        assert len(sug) == 1 and sug[0]["relevant_file"] == "calc.py" and sug[0]["relevant_lines_start"] == 3, improve
        assert os.path.exists(os.path.join(out, "review.md")) and os.path.exists(os.path.join(out, "improve.md"))
        assert seen and all(s["model"] == "gpt-6.1-sol" for s in seen), seen
    srv.shutdown()
    print(f"pragent_driver self-test ok ({len(seen)} model calls: {sorted({s['path'] for s in seen})})")


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--self-test", action="store_true")
    ap.add_argument("--tree")
    ap.add_argument("--target-branch")
    ap.add_argument("--out")
    ap.add_argument("--command", choices=("describe", "review", "improve"))
    ap.add_argument("--model", default="gpt-6.1-sol")
    ap.add_argument("--api-base", default="http://127.0.0.1:8766/v1")
    ap.add_argument("--title-file")
    ap.add_argument("--body-file")
    ap.add_argument("--no-pr-text", action="store_true")
    a = ap.parse_args()
    if a.self_test:
        self_test()
        return
    if not (a.tree and a.target_branch and a.out and a.command):
        ap.error("--tree, --target-branch, --out and --command are required")
    raise SystemExit(run_command(a))


if __name__ == "__main__":
    main()
