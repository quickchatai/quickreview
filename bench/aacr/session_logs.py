#!/usr/bin/env python3
"""Which files of a benchmark run are raw model-session logs, and the
numbers-only extract that ships in place of each one.

The release ships benchmark data: the reviews, the findings, the judges'
verdicts with their reasoning, the Elo judgments, run configurations and
per-PR summaries. It ships no raw model session log of any kind. A session
log holds the prompt text the session was built from during development, not
benchmark data. The set is defined by file kind, below, and it fails closed:
a `.jsonl`, `.ndjson` or `.log` file inside a run directory that no rule
names, neither as a session log nor as data, is left out too.

    classify(rel) -> (reason, extract) | None

`rel` is a file's archive path (`runs/<run>/cases/<iid>/pi-events.jsonl`,
`open-models/runs/...`, `whatif/<run>/source/...`, `analysis/...`). None means
the file is not a session log and the other rules decide. `reason` is the
README's wording for the kind. `extract` names the extract that ships in the
file's place, at `extract_name(rel)`:

  "pi"       the reviewer's pi event stream -> `pi-events.pruned.jsonl`
             (prune_pi): each assistant message's role, timestamp, usage and
             stop reason; each lens tool call's id and every lens run's id,
             agent, stop reason, error class, usage, and its messages' role,
             timestamp and usage. compare.py prices a case from it to the
             cent, recompute/do_speed.py and openmodels/lensfinal.py read it.
  "metrics"  any other JSONL session log -> `<name>.pruned.jsonl`
             (metrics_only): every number and boolean of every line, and
             string values only under a closed set of keys (type, role,
             timestamp, model, stop reason, agent, tool name ...) and only
             when they are short single tokens. No prompt or model text.
  None       a text log of a session process (stderr, a CLI's own run log,
             a driver log that echoes the prompt in its argv, the sandbox
             command log), or a prompt file: left out, no extract.

Standard library only; bytes in, bytes out.
"""
from __future__ import annotations

import json
import re
from typing import Optional, Tuple

PRUNED_SUFFIX = ".pruned.jsonl"
PI_PRUNED = "pi-events" + PRUNED_SUFFIX

R_PI = "session log: the reviewer's pi event stream (numbers-only extract `pi-events.pruned.jsonl` ships)"
R_SESSION = "session log: a model session transcript (numbers-only extract `*.pruned.jsonl` ships)"
R_JUDGE = "session log: a judge's event stream (numbers-only extract `*.pruned.jsonl` ships)"
R_PROCESS = "session log: a review or judge process's own output log (no extract)"
R_SANDBOX = "session log: the sandbox command log, which echoes the prompts (no extract)"
R_PROMPT = "session log: the prompts a session was given, built from the repository at the run's commit (no extract)"
R_UNKNOWN = "session log rule, fail closed: a log kind inside a run directory that no rule names as data"
R_CODE = "regenerable: reviewed-repo code (refetch repo@commit)"

PI_EVENTS = re.compile(r"^pi-events(?:\.[\w-]+)?\.jsonl$")
TRANSCRIPT_DIRS = ("lens-sessions", "codex-sessions", "claude-transcripts")
PROCESS_LOGS = re.compile(r"^(?:pi-stderr\.log|pireview-stderr\.log|ocr-stderr\.log|opencode\.log|codex-driver\.log"
                          r"|pragent-[\w-]+\.log|.*\.events\.stderr\.log|.*-stderr\.log|.*\.stderr)$")
PROMPT_FILES = ("system-prompt.md", "round-order.md", "context-pack.md")
CASE_CODE = ("head-patches.json", "added-imports.txt")
LOG_EXT = (".jsonl", ".ndjson", ".log")

# Log-shaped files inside a run directory that are data, each written by the
# harness rather than by a model session, and holding no prompt or model text.
DATA_LOGS = [
    (re.compile(r"(?:^|/)bridge\.(?:jsonl|log)$"), "the model bridge's request log: time, status, latency, tokens"),
    (re.compile(r"(?:^|/)judge/judge\.jsonl$"), "the judge proxy's request log: time, status, latency, model"),
    (re.compile(r"(?:^|/)judge/container\.log$"), "the judge container's start-up and proxy log"),
    (re.compile(r"(?:^|/)cases/[^/]+/lens-ledger\.jsonl$"), "the lens ledger: each lens run's agent, usage and cost"),
    (re.compile(r"(?:^|/)cases/[^/]+/driver\.log$"), "the Claude Code harness's parse log: counts and fallbacks"),
    (re.compile(r"(?:^|/)replay\.jsonl$"), "SWE-PRBench's replay log: hashes and cache hits"),
    (re.compile(r"(?:^|/)eval/[^/]+\.(?:jsonl|log)$"), "AACR-Bench's harness input (reference comments) and its run log"),
    (re.compile(r"(?:^|/)judgements\.jsonl$"), "the Qodo judge's verdicts"),
    (re.compile(r"(?:^|/)logs/[^/]+\.log$"), "Martian's pipeline step logs"),
    (re.compile(r"(?:^|/)run_eval\.log$"), "SWE-PRBench's evaluation log"),
    (re.compile(r"(?:^|/)judgments/[^/]+\.jsonl$"), "pairwise judgments"),
    (re.compile(r"^(?:judge|export|replay-container)\.log$"), "a scoring dir's judge, export and replay progress logs"),
    (re.compile(r"^[\w.-]+\.(?:score|rescore|judge|eval|review)\.log$"), "a re-run driver's per-set scoring log"),
    (re.compile(r"^(?:cal\d+|qr\d*)\.log$"), "the Martian calibration driver's posting logs (all50-logs)"),
]


def run_inner(rel: str) -> Optional[str]:
    """The path inside a run directory (`runs/<run>/…`, `open-models/runs/<run>/…`,
    `whatif/<run>/…`), else None (a file beside the run dirs, the driver
    files, the analysis, the Elo runs, the answer key)."""
    parts = rel.split("/")
    if parts[0] == "runs" and len(parts) > 2:
        return "/".join(parts[2:])
    if parts[0] == "open-models" and len(parts) > 3 and parts[1] == "runs":
        return "/".join(parts[3:])
    if parts[0] == "whatif" and len(parts) > 2:
        return "/".join(parts[2:])
    return None


def data_log(inner: str) -> Optional[str]:
    for rx, what in DATA_LOGS:
        if rx.search(inner):
            return what
    return None


def classify(rel: str) -> Optional[Tuple[str, Optional[str]]]:
    parts = rel.split("/")
    name = parts[-1]
    if name.endswith(PRUNED_SUFFIX):
        return None  # an extract itself (never in a source tree; kept for re-runs over a built tree)
    case_at = max((i for i, p in enumerate(parts[:-2]) if p == "cases"), default=-1)
    in_case = case_at >= 0
    if name == "sandbox-commands.log" or name.endswith(".sandbox-commands.log"):
        return R_SANDBOX, None
    if PI_EVENTS.match(name):
        return R_PI, "pi"
    if in_case:
        below = parts[case_at + 2:-1]  # the dirs between cases/<iid>/ and the file
        if below[:1] == ["session"] or any(d in TRANSCRIPT_DIRS for d in below):
            return R_SESSION, ("metrics" if name.endswith(".jsonl") else None)
        if not below and name in PROMPT_FILES or below == ["tasks"] and name.endswith(".md"):
            return R_PROMPT, None
        if not below and name in CASE_CODE:
            return R_CODE, None
    if name == "opencode-events.jsonl":
        return R_SESSION, "metrics"
    if name.endswith(".events.jsonl"):
        return R_JUDGE, "metrics"
    if PROCESS_LOGS.match(name):
        return R_PROCESS, None
    inner = run_inner(rel)
    if inner is not None and name.endswith(LOG_EXT) and data_log(inner) is None:
        return R_UNKNOWN, None
    return None


def extract_name(rel: str) -> str:
    """The archive path of a session log's extract."""
    for suf in (".jsonl", ".ndjson"):
        if rel.endswith(suf):
            return rel[:-len(suf)] + PRUNED_SUFFIX
    return rel + PRUNED_SUFFIX


# ---------------------------------------------------------------- error classes

ERROR_CLASSES = [
    ("timeout", re.compile(r"(?i)time[d ]?\s*out|deadline")),
    ("rate-limit", re.compile(r"(?i)rate.?limit|\b429\b|too many requests|quota")),
    ("overloaded", re.compile(r"(?i)overload|\b529\b|capacity")),
    ("aborted", re.compile(r"(?i)abort|cancel|killed|interrupt")),
    ("context-length", re.compile(r"(?i)context (?:length|window)|too long|maximum context|token limit")),
    ("provider-error", re.compile(r"(?i)\b5\d\d\b|server error|upstream|provider|connection|network|econn|socket")),
]


def error_class(msg) -> Optional[str]:
    """A lens run's error message reduced to one of a closed set of classes
    (no text of the message ships)."""
    if not isinstance(msg, str) or not msg.strip():
        return None
    for name, rx in ERROR_CLASSES:
        if rx.search(msg):
            return name
    return "other"


# ---------------------------------------------------------------- the pi extract

LENS_TOOLS = ("lens", "lens_wave", "subagent", "launch_plan")  # compare.py LENS_TOOLS
MSG_KEYS = ("role", "timestamp", "usage", "stopReason")
SAFE = re.compile(r"^[A-Za-z0-9_.:+\-/@]{1,80}$")


ID = re.compile(r"^[A-Za-z0-9_.:+\-/@#|]{1,200}$")


def _safe(v):
    return v if isinstance(v, str) and SAFE.match(v) else None


def _id(v):
    """An id as compare.py deduplicates by it (a lens run's, a tool call's)."""
    return v if isinstance(v, str) and ID.match(v) else None


def _usage(u):
    """A usage record's numbers (nested cost included), nothing else."""
    if isinstance(u, dict):
        out = {k: _usage(v) for k, v in u.items() if not isinstance(v, str)}
        return {k: v for k, v in out.items() if v is not None}
    if isinstance(u, bool) or isinstance(u, (int, float)):
        return u
    return None


def _msg(m: dict) -> dict:
    out = {}
    for k in MSG_KEYS:
        if k not in m:
            continue
        v = m[k]
        out[k] = _usage(v) if k == "usage" else v if isinstance(v, (int, float)) else _safe(v)
    for k in ("model", "provider", "api"):
        if _safe(m.get(k)):
            out[k] = m[k]
    return out


def _lens_result(r: dict, full: bool) -> dict:
    out = {"id": _id(r.get("id")), "agent": _safe(r.get("agent")), "usage": _usage(r.get("usage"))}
    if full:
        failed = r.get("stopReason") in ("error", "aborted") or bool(r.get("errorMessage"))
        out.update({"stopReason": _safe(r.get("stopReason")),
                    "errorClass": error_class(r.get("errorMessage") or r.get("stderr")) if failed else None,
                    "model": _safe(r.get("model")),
                    "messages": [_msg(m) for m in r.get("messages") or [] if isinstance(m, dict)]})
    return {k: v for k, v in out.items() if v is not None}


def prune_pi(data: bytes) -> bytes:
    """A pi event stream with every text removed (see the module doc). Every
    kept line is marked `"_slim": "pruned"`."""
    out = []
    for line in data.splitlines():
        # speed only: every kept event names its type in the line
        if not line.startswith(b"{") or (b'"message_end"' not in line and b'"tool_execution_' not in line):
            continue
        try:
            e = json.loads(line)
        except ValueError:
            continue
        if not isinstance(e, dict):
            continue
        t = e.get("type")
        if t == "message_end" and isinstance(e.get("message"), dict):
            out.append({"type": t, "_slim": "pruned", "message": _msg(e["message"])})
        elif t in ("tool_execution_update", "tool_execution_end") and e.get("toolName") in LENS_TOOLS:
            # the carrier compare.py prices: `partialResult or result`
            key = "partialResult" if e.get("partialResult") else "result"
            carrier = e.get(key) if isinstance(e.get(key), dict) else {}
            details = carrier.get("details") if isinstance(carrier.get("details"), dict) else {}
            res = [_lens_result(r, t == "tool_execution_end")
                   for r in details.get("results") or [] if isinstance(r, dict)]
            rec = {"type": t, "_slim": "pruned", "toolName": e["toolName"],
                   "toolCallId": _id(e.get("toolCallId")), key: {"details": {"results": res}}}
            out.append({k: v for k, v in rec.items() if v is not None})
    return "".join(json.dumps(x, ensure_ascii=False) + "\n" for x in out).encode()


# ---------------------------------------------------------------- the generic extract

# string values kept, and only when short single tokens (SAFE)
KEEP_STR = frozenset(("type", "role", "timestamp", "ts", "time", "created_at", "started_at", "completed_at",
                      "stopReason", "stop_reason", "model", "provider", "api", "agent", "toolName", "tool",
                      "kind", "status", "subtype", "event", "service_tier", "effort"))
# containers of text: never descended into, whatever they hold
SKIP_TREES = frozenset(("content", "text", "arguments", "input", "output", "prompt", "instructions", "message_text",
                        "thinking", "summary", "title", "body", "result", "error", "errorMessage", "stderr",
                        "stdout", "cwd", "path", "command", "metadata", "user_facing_hint", "delta", "part_text"))


def _metrics(x, key=None):
    if isinstance(x, bool) or isinstance(x, (int, float)):
        return x
    if isinstance(x, str):
        return x if key in KEEP_STR and SAFE.match(x) else None
    if isinstance(x, dict):
        out = {}
        for k, v in x.items():
            if not isinstance(k, str) or (k in SKIP_TREES and not (isinstance(v, (int, float)) and not isinstance(v, bool))):
                continue
            m = _metrics(v, k)
            if m is not None and m != {} and m != []:
                out[k] = m
        return out or None
    if isinstance(x, list):
        out = [m for m in (_metrics(v, key) for v in x) if m is not None and m != {} and m != []]
        return out or None
    return None


_TIMES = frozenset(("timestamp", "ts", "time", "created_at", "started_at", "completed_at"))


def _measures(x, key=None) -> bool:
    """Whether a pruned value carries a number, a boolean or a time."""
    if isinstance(x, bool) or isinstance(x, (int, float)):
        return True
    if isinstance(x, str):
        return key in _TIMES
    if isinstance(x, dict):
        return any(_measures(v, k) for k, v in x.items())
    if isinstance(x, list):
        return any(_measures(v, key) for v in x)
    return False


def metrics_only(data: bytes) -> bytes:
    """Every number and boolean of every JSON line, plus the KEEP_STR string
    fields that are single tokens; a line left with no number, boolean or
    time (labels only) is dropped. Every kept line is marked
    `"_extract": "metrics"`."""
    out = []
    for line in data.splitlines():
        line = line.strip()
        if not line.startswith(b"{"):
            continue
        try:
            e = json.loads(line)
        except ValueError:
            continue
        m = _metrics(e)
        if not isinstance(m, dict) or not _measures(m):
            continue
        out.append({"_extract": "metrics", **m})
    return "".join(json.dumps(x, ensure_ascii=False) + "\n" for x in out).encode()


def extract(kind: str, data: bytes) -> bytes:
    return prune_pi(data) if kind == "pi" else metrics_only(data)
