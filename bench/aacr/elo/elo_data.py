"""Cases, reviews and the judge's shared context for the pairwise Elo judge.

A CASE is one benchmark PR: its title and description, the git objects that
hold its base and head, the benchmark's golden comments, and one REVIEW per
configuration (run) in the pool. A review is CANONICAL: the findings and the
summary body as the benchmark scored them, with every arm-identifying marker
stripped (QuickReview's lens footers and bot signature, the Claude arm's raw
JSON dump of its own findings), so the judge reads content, not provenance.

A review that produced nothing (no findings and no body) is None: that PR
drops out of that configuration's pairs.

Only the Martian adapter exists today. Another benchmark is one more
`load_<name>` returning the same shape.
"""
from __future__ import annotations

import json
import os
import re
import subprocess
from dataclasses import dataclass, field
from pathlib import Path
from typing import Dict, List, Optional

HERE = Path(__file__).resolve().parent
AACR = HERE.parent


def runs_dir() -> Path:
    """The bench runs directory (QCR_BENCH_RUNS_DIR, outside any worktree)."""
    d = os.environ.get("QCR_BENCH_RUNS_DIR", "").strip()
    if not d:
        raise SystemExit("set QCR_BENCH_RUNS_DIR (the bench runs directory, outside any worktree)")
    return Path(d)


# One token per this many characters: deliberately pessimistic for code (the
# Claude tokenizer runs up to ~1.35x older ones), so a 400k estimate fits both
# judges' windows (gpt-6.1-sol 500k on the Codex route, Opus 5.5 1M).
CHARS_PER_TOKEN = 3.0


@dataclass
class Finding:
    path: str
    line: Optional[int]
    text: str
    severity: Optional[str] = None  # only when the review stated one


@dataclass
class Review:
    findings: List[Finding]
    body: str

    def empty(self) -> bool:
        return not self.findings and not self.body.strip()


@dataclass
class Golden:
    text: str
    severity: Optional[str] = None
    category: Optional[str] = None
    path: Optional[str] = None
    lines: Optional[str] = None


@dataclass
class Case:
    iid: str
    title: str
    body: str
    git_dir: str
    base: str
    head: str
    goldens: List[Golden]
    reviews: Dict[str, Optional[Review]] = field(default_factory=dict)


# ---- canonicalisation ------------------------------------------------------------

_TAG = re.compile(r"^\s*\[(blocker|question|nit|suggestion|check this)\]\s*", re.I)
_TAG_WORD = {"blocker": "blocking", "question": "question", "nit": "nit",
             "suggestion": "suggestion", "check this": "for a human to double-check"}
_LEVEL = r"(P\d|blocker|question|nit|suggestion)"
_QR_FOOTER = re.compile(r"^\s*_" + _LEVEL + r"\s*·\s*confidence[^\n]*_\s*$", re.M | re.I)
# Inline forms: `_(P3/0.80, pass-a,pass-b)_`, `_(nit · confidence 0.9 · pass-a)_`,
# and the same without underscores or with commas: `(P3, confidence 0.55, pass-a)`.
_QR_INLINE = re.compile(r"_?\(" + _LEVEL + r"(?:/[0-9.]+|\s*[·,]\s*confidence)[^)]*\)_?", re.I)
_SIGNATURES = [
    re.compile(r"<details>\s*<summary>\s*Lenses\b.*?</details>", re.S | re.I),
    re.compile(r"^\s*_Lenses applied:.*?_\s*$", re.M | re.S),
    re.compile(r"^\s*_Automated review by .*?_\s*$", re.M | re.S),
]
_HTML_COMMENT = re.compile(r"<!--.*?-->", re.S)
_JSON_BLOCK = re.compile(r"```(?:json)?[ \t]*\n(\[.*?\n\])[ \t]*\n```", re.S)


def _clean(text: str) -> str:
    text = _HTML_COMMENT.sub("", text or "")
    for sig in _SIGNATURES:
        text = sig.sub("", text)
    text = _QR_INLINE.sub(r"(\1)", text)
    return re.sub(r"\n{3,}", "\n\n", text).strip()


def canon_finding(path: str, line: Optional[int], raw: str) -> Finding:
    text = raw or ""
    sev: List[str] = []
    m = _TAG.match(text)
    if m:
        sev.append(_TAG_WORD[m.group(1).lower()])
        text = text[m.end():]
    m = _QR_FOOTER.search(text)
    if m:
        level = m.group(1)
        word = level.upper() if level[0] in "Pp" else _TAG_WORD[level.lower()]
        if word not in sev:
            sev.append(word)
        text = _QR_FOOTER.sub("", text)
    return Finding(path=path, line=line, text=_clean(text), severity=", ".join(sev) or None)


def strip_findings_dump(body: str, inline: set) -> str:
    """The Claude arm's review body carries its raw JSON list of the same
    findings it posted inline — a machine dump, not prose a person reads.
    A fenced JSON list whose every item sits at an inline finding's
    (path, line) is removed; the prose around it stays. A list with any item
    the inline findings do not hold is kept whole."""
    def repl(m: "re.Match[str]") -> str:
        try:
            items = json.loads(m.group(1))
        except ValueError:
            return m.group(0)
        if not isinstance(items, list) or not all(isinstance(i, dict) for i in items):
            return m.group(0)
        locs = {(i.get("file") or i.get("path"), i.get("line")) for i in items}
        return "" if locs <= inline else m.group(0)
    return _JSON_BLOCK.sub(repl, body or "")


def canon_review(items: List[dict]) -> Optional[Review]:
    """Martian-shaped items ({path, line, body}; path None = the review body)."""
    findings: List[Finding] = []
    bodies: List[str] = []
    inline = {(it["path"], it.get("line")) for it in items or [] if it.get("path")}
    for it in items or []:
        if it.get("path"):
            findings.append(canon_finding(it["path"], it.get("line"), it.get("body") or ""))
        elif (it.get("body") or "").strip():
            bodies.append(_clean(strip_findings_dump(it["body"], inline)))
    review = Review(findings=findings, body="\n\n".join(b for b in bodies if b))
    return None if review.empty() else review


# ---- benchmarks ------------------------------------------------------------------

def load_martian(plan: dict) -> Dict[str, Case]:
    """Plan keys beyond the basics: `run_dirs` (run → the directory holding
    `<run>.martian`, relative to the repo root; default the bench runs dir),
    `tools` (run → the review's tool, for a run whose PRs carry several, such
    as one with re-judged vendor reviews beside its own) and `prs` (the PRs to
    judge, so a 50-PR run can join a 20-PR pool)."""
    runs = Path(plan.get("runs_dir") or runs_dir())
    cache = Path(plan.get("git_cache") or runs.parent / "ext-cache" / "martian")
    cases_meta = {c["instance_id"]: c for c in json.loads((AACR / plan["set"]).read_text())["cases"]}
    run_dirs = plan.get("run_dirs") or {}
    tools = plan.get("tools") or {}
    only = set(plan["prs"]) if plan.get("prs") else None
    cases: Dict[str, Case] = {}
    for run in plan["runs"]:
        where = Path(run_dirs[run]) if run in run_dirs else runs
        if not where.is_absolute():
            where = AACR.parent.parent / where
        data = json.loads((where / f"{run}.martian" / "results" / "benchmark_data.json").read_text())
        for entry in data.values():
            reviews = entry.get("reviews") or []
            if run in tools:
                reviews = [r for r in reviews if r.get("tool") == tools[run]]
            if len(reviews) != 1:
                raise SystemExit(f"{run}: expected one review per PR{' from ' + tools[run] if run in tools else ''}, "
                                 f"got {len(reviews)}")
            iid = reviews[0]["repo_name"]
            if only is not None and iid not in only:
                continue
            meta = cases_meta.get(iid)
            if meta is None:
                raise SystemExit(f"{run}: {iid} is not in {plan['set']}")
            goldens = [Golden(text=g.get("comment", ""), severity=g.get("severity"), category=g.get("category"))
                       for g in entry.get("golden_comments") or []]
            case = cases.get(iid)
            if case is None:
                case = cases[iid] = Case(
                    iid=iid, title=meta.get("title") or entry.get("pr_title") or "", body=meta.get("body") or "",
                    git_dir=str(cache / f"{meta['martian']['project']}.git"),
                    base=meta.get("expect_merge_base") or meta["base_commit"], head=meta["head_commit"],
                    goldens=goldens)
            elif [g.text for g in case.goldens] != [g.text for g in goldens]:
                raise SystemExit(f"{run}: golden comments for {iid} differ from another run's")
            case.reviews[run] = canon_review(reviews[0].get("review_comments") or [])
    if only is not None and only - set(cases):
        raise SystemExit(f"no run holds these planned PRs: {', '.join(sorted(only - set(cases)))}")
    for case in cases.values():
        for run in plan["runs"]:
            case.reviews.setdefault(run, None)  # a run with no entry for this PR produced nothing
    return cases


LOADERS = {"martian": load_martian}


def load_cases(plan: dict) -> Dict[str, Case]:
    loader = LOADERS.get(plan["benchmark"])
    if loader is None:
        raise SystemExit(f"no case loader for benchmark {plan['benchmark']!r} (have: {', '.join(LOADERS)})")
    return loader(plan)


# ---- packing ---------------------------------------------------------------------

def tokens(text: str) -> int:
    return int(len(text) / CHARS_PER_TOKEN) + 1


def fence(text: str, lang: str = "") -> str:
    """A code fence longer than any backtick run inside the text."""
    longest = max((len(m) for m in re.findall(r"`+", text)), default=0)
    tick = "`" * max(3, longest + 1)
    return f"{tick}{lang}\n{text}\n{tick}"


def _git(git_dir: str, *args: str) -> str:
    out = subprocess.run(["git", "--git-dir", git_dir, *args], capture_output=True, check=True)
    return out.stdout.decode("utf-8", errors="replace")


def numbered(text: str) -> str:
    lines = text.split("\n")
    width = len(str(len(lines)))
    return "\n".join(f"{i:>{width}}| {l}" for i, l in enumerate(lines, 1))


def touched_files(case: Case) -> List[dict]:
    """Every file the PR changes, with its post-change size; deleted and
    binary files carry no head contents."""
    fields = _git(case.git_dir, "diff", "--name-status", "-z", "-M", case.base, case.head).split("\0")
    out = []
    i = 0
    while i < len(fields) and fields[i]:
        st = fields[i][0]
        if st in "RC":  # a rename or copy: status, old path, new path
            path = fields[i + 2]
            i += 3
        else:
            path = fields[i + 1]
            i += 2
        content = None
        binary = False
        if st != "D":
            raw = subprocess.run(["git", "--git-dir", case.git_dir, "show", f"{case.head}:{path}"],
                                 capture_output=True).stdout
            binary = b"\0" in raw[:8000]
            if not binary:
                content = raw.decode("utf-8", errors="replace")
        out.append({"path": path, "status": st, "binary": binary, "content": content})
    return out


def render_goldens(goldens: List[Golden]) -> str:
    if not goldens:
        return "(The benchmark lists no golden comments for this PR.)"
    lines = []
    for i, g in enumerate(goldens, 1):
        tags = " · ".join(x for x in (g.severity, g.category) if x)
        where = f" — {g.path}{':' + g.lines if g.lines else ''}" if g.path else ""
        lines.append(f"G{i}. [{tags or 'untagged'}]{where}\n{g.text.strip()}")
    return "\n\n".join(lines)


def pack_context(case: Case, budget_tokens: int, wide_context: int = 60) -> dict:
    """The part of the judge prompt every pair on this PR shares: description,
    diff, touched files at head, golden comments. Whole files first; past the
    budget the largest files fall back to hunks with `wide_context` lines of
    context, then to the diff alone. Returns {text, tokens, files: [...]}"""
    diff = _git(case.git_dir, "diff", "-M", case.base, case.head)
    files = touched_files(case)
    head = (f"# Pull request\n\nTitle: {case.title.strip()}\n\nDescription:\n"
            f"{fence(case.body.strip() or '(no description)')}\n\n"
            f"# Diff (base {case.base[:12]} → head {case.head[:12]})\n\n{fence(diff, 'diff')}\n")
    tail = f"\n# Golden comments (the benchmark's reference set)\n\n{render_goldens(case.goldens)}\n"
    shapes: Dict[str, str] = {}
    for f in files:
        shapes[f["path"]] = "full" if f["content"] is not None else "absent"
    hunks: Dict[str, str] = {}

    def section(f: dict) -> str:
        shape = shapes[f["path"]]
        if shape == "full":
            return f"## {f['path']} (whole file at head, line-numbered)\n\n{fence(numbered(f['content']))}\n"
        if shape == "hunks":
            if f["path"] not in hunks:
                hunks[f["path"]] = _git(case.git_dir, "diff", f"-U{wide_context}", "-M", case.base, case.head, "--", f["path"])
            return (f"## {f['path']} (too large for the budget: the diff with {wide_context} lines of context)\n\n"
                    f"{fence(hunks[f['path']], 'diff')}\n")
        why = "deleted" if f["status"] == "D" else ("binary" if f["binary"] else "left out to fit the budget")
        return f"## {f['path']} ({why}; see the diff)\n"

    def render() -> str:
        body = "".join(section(f) for f in files)
        return head + "\n# Files the PR touches, at the head commit\n\n" + (body or "(none)\n") + tail

    text = render()
    largest_first = sorted(files, key=lambda f: -len(f["content"] or ""))
    for before, after in (("full", "hunks"), ("hunks", "absent")):
        for f in largest_first:
            if tokens(text) <= budget_tokens:
                break
            if shapes[f["path"]] == before:
                shapes[f["path"]] = after
                text = render()
    return {"text": text, "tokens": tokens(text), "over_budget": tokens(text) > budget_tokens,
            "files": [{"path": f["path"], "shape": shapes[f["path"]]} for f in files]}


def render_review(label: str, review: Review) -> str:
    parts = [f"# Review {label}\n"]
    parts.append("## Summary body\n\n" + (fence(review.body) if review.body.strip() else "(this review has no summary body)") + "\n")
    parts.append(f"## Findings ({len(review.findings)})\n")
    for i, f in enumerate(review.findings, 1):
        where = f"{f.path}:{f.line}" if f.line else f.path
        sev = f" (stated severity: {f.severity})" if f.severity else ""
        parts.append(f"### {label}{i} — {where}{sev}\n\n{fence(f.text)}\n")
    if not review.findings:
        parts.append("(no inline findings)\n")
    return "\n".join(parts)
