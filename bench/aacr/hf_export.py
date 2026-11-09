#!/usr/bin/env python3
"""Export the benchmark's tables to a Hugging Face dataset directory.

    uv run --no-project --with pyarrow --with datasets python bench/aacr/hf_export.py \\
        --runs-dir <runs dir>/runs \\
        --aacr-dataset <AACR-Bench v1.0 dataset/positive_samples.json> \\
        --out <runs dir>/release/hf-dataset \\
        --repo-id <org>/<name> [--archive-url URL] [--archive DIR] [--generated DIR] [--no-figures]
        [--no-load-check]

What it writes (no model call, nothing uploaded; the run dirs are only read):

  data/<config>.parquet  one file per config, one `test` split each (README.md
                         YAML maps them): the AACR-derived key (prs, defects,
                         exclusions), AACR's own references and our labels of
                         them, every reviewer arm the papers report (arms,
                         reviews, defect_verdicts, comment_verdicts,
                         aacr_matches), and the Martian and Qodo benchmarks'
                         goldens, reviews and verdicts.
  figures/, keys/ [reports/]  the generated artefacts kept out of git:
                         the charts (the earlier study's re-drawn under the
                         public name), the rendered keys, and with
                         --with-report the superseded FULL-BENCHMARK report.
                         The public tree carries only some of them; --generated
                         names a bench/aacr-shaped dir (charts/, defects/*.md,
                         FULL-BENCHMARK.md) that supplies the rest, the tree's
                         own copy winning where both have a file.
  README.md (the card, from hf/card.md), LICENSE (Apache-2.0), NOTICE,
  LICENSES/MIT-*.txt     Martian's and Qodo's MIT licence texts (notices.py),
  validation.json        every count and headline number recomputed FROM THE
                         WRITTEN TABLES, against the papers' values.
  second_judges/         with --second-judges: another judge's verdicts on reviews
                         the tables hold (recompute/second_judges.py), copied as is
                         after every file is checked against the committed manifest
                         bench/aacr/hf/second-judges.sha256 (a missing, extra or
                         differing file refuses the export); no config reads it.
                         validation.json checks it (the manifest, its judge column,
                         its coverage of the published judge's rows, the scorers
                         reproducing its scores/, its columns) and fails without it.

With --archive (the run archive folder, after `export_runs.py readme` wrote it) it
also writes the runs table's derived fields (each Martian scoring dir's judge
settings, the claim groups) into that folder's RUNS-INDEX.json, with a description
of each claim group from bench/aacr/claims.json's `groups`, which the validation
then checks row for row against the runs table.

Third-party text: AACR reference comments (Apache-2.0), Martian golden
comments (MIT) and Qodo's issues (MIT) are copied; vendor bot comments (the
Copilot 2025 harvest, the Martian vendors re-judged, Qodo's nine vendors) are
LINKS ONLY — a review row carries the source URL and the comment locations,
never their text. Every exported string goes through `scrub` (SCRUB_RULES), and
the card states the rewrite.

Scoring is compare.py's own (imported): an arm is a list of run dirs, a PR is
scored from the FIRST run that has a usable judgement for it, a partial find
counts 1/2, and the $ and minutes are compare.usd_and_minutes. The pure helpers
(scrub, review_for_judge, the arm registry, the metric functions) need only the
standard library, so tests import them without pyarrow.
"""
from __future__ import annotations

import argparse
import collections
import glob
import hashlib
import json
import os
import re
import shutil
import statistics
import subprocess
import sys
import tempfile

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
sys.path.insert(0, os.path.join(HERE, "ext"))
import compare  # noqa: E402
import key_data as KD  # noqa: E402
import martian_ingest as MI  # noqa: E402
import notices as NT  # noqa: E402
import release_catalogue as RC  # noqa: E402
import scrub_extra as SX  # noqa: E402

sys.path.insert(0, os.path.join(HERE, "recompute"))
import second_judges as SJ  # noqa: E402

SETS = ("smoke10", "dev10", "holdout10", "fresh10", "rest145")
AACR_V1_SHA256 = "d8683cb240249bc4e0aff6428802bdffa7b7573ace600552cab1cd0cb7e905c9"
QODO_GT_SHA256 = "2f0448ed1f9a55bea14039961d8d9e610ee8885b37559b80f5821f3f70cfe64d"
PRIMARY = "gpt-6-sol-high"
SECOND = "claude-opus-5-5"
SELFCONS = "wpself-gpt-6-sol-high"  # the primary judge re-run (no key-version prefix)
JUDGE_LABELS = {PRIMARY: "gpt-6-sol-high", SECOND: "claude-opus-5-5", SELFCONS: "gpt-6-sol-high-repeat"}

# ---------------------------------------------------------------------------
# The scrub (spellings shared with the run archive, export_runs.py). Order
# matters: the longer spellings first. One name, one placeholder, everywhere.
# ---------------------------------------------------------------------------

# the exporting host's home directory: $QCR_SCRUB_HOME, default this user's home
_HOME_RX = re.escape(os.environ.get("QCR_SCRUB_HOME", os.path.expanduser("~")).rstrip("/"))
# the repo checkout and the bench runs dir: $QCR_SCRUB_REPO_DIR (default: this
# checkout, a worktree resolved to its main checkout) and $QCR_SCRUB_RUNS_DIR
# (default: `qcr-bench-runs` beside that checkout)
_REPO_DIR = os.environ.get(
    "QCR_SCRUB_REPO_DIR",
    os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__)))).split("/.claude/worktrees/")[0],
).rstrip("/")
_RUNS_DIR = os.environ.get("QCR_SCRUB_RUNS_DIR", os.path.join(os.path.dirname(_REPO_DIR), "qcr-bench-runs")).rstrip("/")

# the identities, each comma-separated and set by the exporter (never spelled
# in this file): $QCR_SCRUB_BOT (the review bot's app slugs; `<slug>[bot]` is
# its login), $QCR_SCRUB_OWNER (the owner's name spellings) and
# $QCR_SCRUB_OLD_NAME (the product's earlier names)
def _env_list(key: str) -> list[str]:
    return [t.strip() for t in os.environ.get(key, "").split(",") if t.strip()]
SCRUB_BOTS = _env_list("QCR_SCRUB_BOT")
SCRUB_OWNERS = _env_list("QCR_SCRUB_OWNER")
SCRUB_OLD_NAMES = _env_list("QCR_SCRUB_OLD_NAME")
# the private product repository's name (comma-separated spellings):
# $QCR_SCRUB_PRIVATE_REPO -> `<private-repo>`, any case
SCRUB_PRIVATE_REPOS = _env_list("QCR_SCRUB_PRIVATE_REPO")

# credential values ($QCR_SCRUB_SECRET_FILES), private tokens
# ($QCR_SCRUB_PRIVATE_WORDS), private hosts ($QCR_SCRUB_HOSTS) and the content
# rules ($QCR_SCRUB_CONTENT_RULES): scrub_extra.py, shared with the run archive
SCRUB_SECRETS = [v.decode() for v in SX.secret_values()]
SCRUB_PRIVATE_WORDS = SX.env_list("QCR_SCRUB_PRIVATE_WORDS")
SCRUB_HOSTS = SX.env_list("QCR_SCRUB_HOSTS")
CONTENT_RULES = SX.ContentRules.from_env()

_HOME = os.environ.get("QCR_SCRUB_HOME", os.path.expanduser("~")).rstrip("/")
_HOME_DASHED = re.escape(_HOME.replace("/", "-"))  # Claude Code's project-dir spelling


def _path_rx(path: str) -> str:
    """A path's regex: absolute, or `~/`-, `$HOME/`- or `${HOME}/`-relative when under the home
    (export_runs._path_rx's spellings)."""
    if path.startswith(_HOME + "/"):
        return r"(?:" + re.escape(path) + r"|(?:~|\$HOME|\$\{HOME\})/" + re.escape(path[len(_HOME) + 1:]) + r")"
    return re.escape(path)


# the same order as the run archive's rules (export_runs.NAME_RULES): credential values, the
# product's earlier name, the bot, the owner, the private repo, then host paths, private tokens
# and hosts, then the tracker
SCRUB_RULES: list[tuple[str, str, str]] = [
    # (label, regex, replacement)
    *[("credential value", re.escape(v), "<redacted-secret>") for v in SCRUB_SECRETS],
    # the earlier product name first: it may contain the bot's slug
    *[("old product name", re.escape(n), "quickreview") for n in SCRUB_OLD_NAMES],
    *[("old product name (other case)", r"(?i)" + re.escape(n), "quickreview") for n in SCRUB_OLD_NAMES],
    *[("review bot", re.escape(b) + r"\[bot\]", "<review-bot>") for b in SCRUB_BOTS],
    *[("review bot (bare)", re.escape(b) + r"\b", "<review-bot>") for b in SCRUB_BOTS],
    *[("owner", re.escape(o), "<owner>") for o in SCRUB_OWNERS],
    *[("owner (other case)", r"(?i)" + re.escape(o), "<owner>") for o in SCRUB_OWNERS],
    *[("private repo", r"(?i)" + re.escape(r), "<private-repo>") for r in SCRUB_PRIVATE_REPOS],
    ("host path: runs dir", _path_rx(_RUNS_DIR), "<runs>"),
    ("host path: repo checkout", _path_rx(_REPO_DIR), "<repo>"),
    ("host path: scratchpad", r"/tmp/claude-\d+/" + _HOME_DASHED + r"-[A-Za-z0-9\-]*/[0-9a-f\-]{36}(?:/scratchpad)?",
     "<scratchpad>"),
    ("host path: Claude Code project", r"\.claude/projects/" + _HOME_DASHED + r"-[A-Za-z0-9\-]*", ".claude/projects/<project>"),
    ("host path: home", _HOME_RX + r"\b", "<home>"),
    ("host path: home (dashed)", _HOME_DASHED + r"(?=[-/])", "-<home>"),
    ("host path: home (JSON-escaped)", re.escape(_HOME.replace("/", "\\/")) + r"(?![A-Za-z0-9_\-])", "<home>"),
    ("host volume: pi login", r"companion-pihome", "<pi-login-volume>"),
    *[("private token", r"(?i)(?<![A-Za-z0-9_])" + re.escape(w) + r"(?![A-Za-z0-9_])", "<private>") for w in SCRUB_PRIVATE_WORDS],
    *[("private host", r"(?i)" + re.escape(h), "<private-host>") for h in SCRUB_HOSTS],
    # study renames ($QCR_SCRUB_RENAMES), before the tracker's rules would make a ticket of them
    *SX.rename_rules_str(),
    # the authors' tracker: ticket ids and paths into it (scrub_extra.TICKET_RULES)
    *SX.ticket_rules_str(),
]
_SCRUB = [(label, re.compile(rx), rep) for label, rx, rep in SCRUB_RULES]
_TICKET = [(label, re.compile(rx), rep) for label, rx, rep in SX.ticket_rules_str()]
CONTENT_LABEL = "public-repository stand-ins (content rules)"


def scrub(text, counts: collections.Counter | None = None):
    """Apply SCRUB_RULES, then the content rules, to one string (anything
    else is returned as is)."""
    if not isinstance(text, str):
        return text
    for label, rx, rep in _SCRUB:
        text, n = rx.subn(rep, text)
        if n and counts is not None:
            counts[label] += n
    if CONTENT_RULES is not None and len(text) > 3:
        c = collections.Counter()
        b = text.encode()
        out = CONTENT_RULES.apply(b, c)
        if out != b:
            text = out.decode(errors="replace")
            if counts is not None:
                counts[CONTENT_LABEL] += sum(c.values())
            for label, rx, rep in _TICKET:  # a stand-in may spell a tracker id of its own
                text, n = rx.subn(rep, text)
                if n and counts is not None:
                    counts[label] += n
    return text


def scrub_obj(obj, counts: collections.Counter | None = None):
    """scrub() over every string in a JSON-shaped value (keys included)."""
    if isinstance(obj, str):
        return scrub(obj, counts)
    if isinstance(obj, list):
        return [scrub_obj(x, counts) for x in obj]
    if isinstance(obj, dict):
        return {scrub(k, counts): scrub_obj(v, counts) for k, v in obj.items()}
    return obj


# ---------------------------------------------------------------------------
# The review the defect judge read — a port of src/bench/defects.ts
# `reviewForJudge`, so comment ids C1..Cn line up with the verdict files.
# ---------------------------------------------------------------------------

TAG_RE = re.compile(r"^\s*\[([a-z][a-z ]*)\]\s*", re.I)
FOOTER_RE = re.compile(r"\n*_P\d[^\n]*_\s*$")
# QuickReview's own priority and confidence, as its comment footer prints them (src/posting.ts:
# `_<severity> · confidence 0.99 · lens …_`, the severity P0..P4 or `nit`, and one build's bare
# `_confidence 0.85 · …_` and unitalicised `P3 · confidence 0.99 · lens …`), and the older
# `_(P1/0.99, pass-…)_`; an entry starts a line or follows `_`, so prose ("with confidence 1") is
# never one, and a third-party tool's comment has none. FOOTER_RE strips only the `_P<n>…_` form
# from the judge's text: the others stayed in what the judge read
PRIORITY_RE = re.compile(r"(?m)(?:^|_)\(?(?:(P\d)/(\d+(?:\.\d+)?)|(?:(P\d|nit) · )?confidence (\d+(?:\.\d+)?))")


def priority_confidence(raw: str) -> tuple[str | None, float | None]:
    """A comment's QuickReview priority ("P0".."P4", "nit", or None for a footer that prints none)
    and confidence from its footer: the first footer entry on the last line that has one (a merged
    comment's footer can name two)."""
    hits = list(PRIORITY_RE.finditer(raw or ""))
    if not hits:
        return None, None
    last_line = raw.count("\n", 0, hits[-1].start())
    m = next(h for h in hits if raw.count("\n", 0, h.start()) == last_line)
    return m.group(1) or m.group(3), float(m.group(2) or m.group(4))


def _read_json(path):
    try:
        with open(path) as f:
            return json.load(f)
    except (OSError, ValueError):
        return None


def _claude_rows(result):
    """src/bench/claudeshape.ts claudeRowsForJudge."""
    if not isinstance(result, dict) or "review_output" not in result:
        return None
    rows = []
    out = result.get("review_output")
    for f in out if isinstance(out, list) else []:
        if not isinstance(f, dict):
            continue
        s = f["summary"].strip() if isinstance(f.get("summary"), str) else ""
        fs = f["failure_scenario"].strip() if isinstance(f.get("failure_scenario"), str) else ""
        note = "\n".join(x for x in (s, fs) if x).strip()
        if not note:
            continue
        line = f["line"] if isinstance(f.get("line"), (int, float)) and not isinstance(f.get("line"), bool) else None
        rows.append({"path": f["file"] if isinstance(f.get("file"), str) else "", "start_line": line,
                     "end_line": line, "content": note})
    return rows


def _num(v):
    return v if isinstance(v, (int, float)) and not isinstance(v, bool) else None


def judge_view(raw: str) -> tuple[str | None, str]:
    """(tag, text) of a comment as the judge read it: the `[tag]` moved out, the footer stripped."""
    m = TAG_RE.match(raw)
    return (m.group(1).lower() if m else None), FOOTER_RE.sub("", TAG_RE.sub("", raw, count=1)).strip()


def _comment(cid: str, path, line, end, deleted: bool, raw: str) -> dict:
    tag, text = judge_view(raw)
    prio, conf = priority_confidence(raw)
    return {"id": cid, "path": path if isinstance(path, str) else None, "line": line,
            "end_line": end if end is not None else line, "deleted_line": deleted, "tag": tag, "text": text,
            "raw_text": raw, "priority": prio, "confidence": conf}


def review_for_judge(run_dir: str, iid: str) -> list[dict]:
    """The comments as the judge numbered them: the scored result file's rows,
    then the posted comments on DELETED lines (side LEFT) appended last. Each
    carries the judge's view (`tag`, `text`) and the comment as the run's
    files hold it (`raw_text`: the result row's `content`, the deleted-line
    comment's posted `body`), with QuickReview's `priority` and `confidence`
    read from its footer."""
    scored = _read_json(os.path.join(run_dir, "results", "all", f"{iid}.json"))
    rows = None
    if isinstance(scored, dict):
        rows = (scored.get("review") or {}).get("comments") if isinstance(scored.get("review"), dict) else None
    if rows is None:
        rows = _claude_rows(scored) or []
    out = []
    for r in rows:
        r = r if isinstance(r, dict) else {}
        raw = r.get("content") if isinstance(r.get("content"), str) else ""
        if not raw.strip():
            continue
        out.append(_comment(f"C{len(out) + 1}", r.get("path"), _num(r.get("start_line")), _num(r.get("end_line")),
                            False, raw))
    for r in _left_comments(run_dir, iid):
        out.append(_comment(f"C{len(out) + 1}", r.get("path"), _num(r.get("line")), None, True, r["body"]))
    return out


def _left_comments(run_dir: str, iid: str) -> list[dict]:
    """The posted comments on DELETED lines (side LEFT) with a body, in the order posted."""
    posted = _read_json(os.path.join(run_dir, "cases", iid, "comments.json"))
    return [r for r in (posted if isinstance(posted, list) else []) if isinstance(r, dict)
            and isinstance(r.get("side"), str) and r["side"].upper() == "LEFT"
            and isinstance(r.get("body"), str) and r["body"].strip()]


def archive_texts(run_dir: str, iid: str) -> list[str]:
    """Every comment's text as the run's files hold it, in the judge's numbering, read straight from
    the files (the result file's `review.comments[].content`, else a Claude Code result's
    summary and failure scenario, then the deleted-line comments' `body`): what `raw_text` must equal."""
    scored = _read_json(os.path.join(run_dir, "results", "all", f"{iid}.json"))
    review = scored.get("review") if isinstance(scored, dict) else None
    rows = review.get("comments") if isinstance(review, dict) else None
    if rows is None:
        texts = [r["content"] for r in _claude_rows(scored) or []]
    else:
        texts = [r["content"] for r in rows if isinstance(r, dict) and isinstance(r.get("content"), str)
                 and r["content"].strip()]
    return texts + [r["body"] for r in _left_comments(run_dir, iid)]


def pr_meta(src: str) -> dict[str, dict]:
    """Each key PR's title and merge base, from the answer key's case dirs beside the runs
    (`<code dir>/<instance id>/meta.json`, shipped in the answer-key volume). The merge base is the
    commit the reviewer and the defect judge diffed the head against (GitHub's compare
    `merge_base_commit`); `base_commit`, the base branch's tip when the PR was taken, differs from
    it on most PRs."""
    out: dict[str, dict] = {}
    for code in KD.CODE_DIRS:
        for f in sorted(glob.glob(os.path.join(src, code, "*", "meta.json"))):
            m = _read_json(f)
            if isinstance(m, dict) and m.get("instance_id"):
                out[m["instance_id"]] = {"title": m.get("title"), "merge_base": m.get("merge_base")}
    return out


CREDIT = {"found": 1.0, "partial": 0.5}


def credit(verdict: str | None) -> float:
    return CREDIT.get(verdict or "missed", 0.0)


# ---------------------------------------------------------------------------
# The arms the papers report. Display names are the papers'; `runs` is
# compare.py's NAME=run,run,... (first judged run per PR wins).
# ---------------------------------------------------------------------------

def _sets(prefix: str, sets=SETS) -> list[str]:
    return [f"{prefix}-{s}" for s in sets]


FINAL_IDS = {  # bench/aacr/final/arms.txt name -> arm id
    "QuickReview default": "quickreview-default-g61",
    "QuickReview low": "quickreview-low-g61",
    "pi-review panel (high)": "pireview-panel-high-g61",
    "Claude Code (Opus 5.5)": "claude-code-opus55",
    "open-code-review high": "ocr-high-g61",
    "Codex CLI high": "codex-high-g61",
    "OpenCode native + PR text": "opencode-native-pr-g61",
    "PR-Agent": "pragent-g61",
}
SOL_IDS = {  # bench/aacr/final/arms-gpt6sol.txt name -> arm id
    "QuickReview default": "quickreview-default-sol",
    "QuickReview low": "quickreview-low-sol",
    "open-code-review": "ocr-medium-sol",
    "Codex CLI": "codex-medium-sol",
    "OpenCode": "opencode-bridge-sol",
    "pi-review": "pireview-medium-sol",
    "Claude Code (Opus 5.5)": "claude-code-opus55",
}


# the papers' third-party AACR arms (their tools' own comments, never QuickReview's)
THIRD_PARTY_ARMS = {a for a in (*FINAL_IDS.values(), *SOL_IDS.values()) if not a.startswith("quickreview")}

OPEN_IDS = {  # bench/aacr/final/arms-open-models.txt name -> arm id
    "DeepSeek V4.1 Flash (mostly low effort)": "quickreview-deepseek-v41-flash",
    "GLM-5.3 Flash": "quickreview-glm-53-flash",
}
OPEN_JUDGE = "gpt-6.1-sol-high"  # the open-model runs' defect judge (judge/v<key>-gpt-6.1-sol-high/)
PAPER_JUDGES = (PRIMARY, SECOND, SELFCONS)
JUDGE_ORDER = [PRIMARY, OPEN_JUDGE, SECOND, SELFCONS]
AACR_TABLES = ("reviews", "defect_verdicts", "comment_verdicts", "aacr_matches")
SET_SUFFIX = re.compile(r"^(.+?)-(?:smoke10|dev10|holdout10|fresh10|rest145)(?:-low)?$")


def jlabel(label: str) -> str:
    """The `judge` column's name of a judge dir label."""
    return JUDGE_LABELS.get(label, label)


def judges_that_scored(arm_id: str, looked_for: list[str], *verdict_tables: list[dict]) -> list[str]:
    """`arms.judges`: the judges (column names, in `looked_for`'s order) with at
    least one verdict row for this arm. `looked_for` is every judge the export
    searched the arm's runs for; a judge that left no verdict is not listed, so
    the column never claims a judge that did not score the arm (the second judge
    scored the earlier study's seven arms only)."""
    seen = {r["judge"] for rows in verdict_tables for r in rows if r["arm_id"] == arm_id}
    return [jlabel(x) for x in looked_for if jlabel(x) in seen]


def read_arms_file(path: str) -> list[tuple[str, list[str]]]:
    out = []
    for line in open(path):
        line = line.strip()
        if line and "=" in line and not line.startswith("#"):
            name, _, runs = line.partition("=")
            out.append((name, runs.split(",")))
    return out


def aacr_arms() -> list[dict]:
    """Every AACR arm, in the order the card lists them."""
    arms: dict[str, dict] = {}

    def add(aid, name, runs, study, scope="all185", **kw):
        # no paper labels here: `paper_tables` and `in_paper` come from the claims manifest alone (link_claims)
        if aid in arms:
            arms[aid]["studies"].append(study)
            if arms[aid]["runs"] != runs:
                raise SystemExit(f"arm {aid}: two run lists")
            return
        arms[aid] = {"arm_id": aid, "benchmark": "aacr", "display_name": name, "runs": runs,
                     "studies": [study], "paper_tables": [], "scope": scope,
                     "link_only": kw.get("link_only", False), "note": kw.get("note", ""),
                     "judges": list(kw.get("judges", PAPER_JUDGES))}

    add("quickreview-frozen", "QuickReview frozen build (e32f0cf, gpt-6.1-sol)", _sets("final1"),
        "frozen build")
    for name, runs in read_arms_file(os.path.join(HERE, "final", "arms.txt")):
        add(FINAL_IDS[name], name, runs, "final comparison (best-shot, gpt-6.1-sol)")
    for name, runs in read_arms_file(os.path.join(HERE, "final", "arms-gpt6sol.txt")):
        add(SOL_IDS[name], name, runs, "earlier study (as shipped, gpt-6-sol; two judges)")
    add("quickreview-default-sol-rerun", "QuickReview default, gpt-6-sol, current build (9106a64)", _sets("v2-default"),
        "stability: full reproduction")
    add("quickreview-luna", "QuickReview default on gpt-6-luna", _sets("all-luna"),
        "base models")
    add("quickreview-opus55", "QuickReview default on Claude Opus 5.5 (40 PRs)", _sets("opus", SETS[:4]),
        "base models", scope="runs")
    add("quickreview-max-g61", "QuickReview max preset, gpt-6.1-sol (smoke10 only)", ["g61max-smoke-smoke10"],
        "base models", scope="runs")
    for k in range(1, 5):
        add(f"quickreview-stab-r{k}", f"QuickReview default, gpt-6-sol, stability run {k}",
            [f"stab-r{k}-{s}" for s in ("dev10", "fresh10", "rest145")], "stability: repeat runs", scope="runs")
    add("copilot-2025-upstream", "Copilot 2025 (upstream, harvested)", _sets("upstream-copilot2025"),
        "upstream Copilot reviews (not a controlled arm)", scope="runs",
        link_only=True, note="Vendor bot comments: text not redistributed; each review row links the original review.")
    fair = [
        ("pireview-high-sol-s40", "pi-review high (S40)", "fair-pireview-high-rest145"),
        ("pireview-prtext-sol-s40", "pi-review high + PR text (S40)", "fair-pireview-prtext-rest145"),
        ("pireview-panel-sol-s40", "pi-review 3-reviewer panel, high (S40)", "fair-pireview-panel-rest145"),
        ("ocr-high-sol-s40", "open-code-review high (S40)", "fair-ocr-high-rest145"),
        ("ocr-prtext-sol-s40", "open-code-review medium + PR text (S40)", "fair-ocr-prtext-rest145"),
        ("opencode-native-sol-s40", "OpenCode native provider (S40)", "fair-opencode-native-rest145"),
        ("opencode-native-pr-sol-s40", "OpenCode native + PR text (S40)", "fair-opencode-prtext-rest145"),
        ("codex-high-sol-s40", "Codex CLI high (S40)", "fair-codex-high-rest145"),
        ("codex-prtext-sol-s40", "Codex CLI medium + PR text (S40)", "fair-codex-prtext-rest145"),
        ("pragent-sol-s40", "PR-Agent on gpt-6-sol (S40)", "fair-pragent-sol-rest145"),
        ("pragent-g61-s40", "PR-Agent on gpt-6.1-sol (S40)", "fair-pragent-g61-rest145"),
    ]
    for aid, name, run in fair:
        add(aid, name, [run], "best-shot selection on S40 (gpt-6-sol unless named)", scope="runs")
    for name, runs in read_arms_file(os.path.join(HERE, "final", "arms-open-models.txt")):
        add(OPEN_IDS[name], name, runs, "other models (open-weight, DigitalOcean)", judges=(OPEN_JUDGE,))
    return list(arms.values())


def qodo_effective(lines) -> list[dict]:
    """The pass-1 judgement per (PR, tool) that qodo_judge.py scores from its
    append-only judgements.jsonl (qodo_judge.effective, which
    recompute/qodo_scores.py --from-judgements reads too)."""
    import qodo_judge
    return qodo_judge.effective(lines)


# ---------------------------------------------------------------------------
# Metrics over the exported rows (the validation recomputes from the tables).
# ---------------------------------------------------------------------------

def defect_summary(verdict_rows: list[dict], defects: dict[tuple[str, str], str], prs: set[str] | None = None) -> dict:
    """Found / by severity / weighted over every key defect of `prs` (all key
    PRs when None); a defect with no verdict row counts as missed."""
    found, total = collections.Counter(), collections.Counter()
    got = {(r["instance_id"], r["defect_id"]): credit(r["verdict"]) for r in verdict_rows}
    for (iid, did), sev in defects.items():
        if prs is not None and iid not in prs:
            continue
        total[sev] += 1
        found[sev] += got.get((iid, did), 0.0)
    W = compare.W
    f, n = sum(found.values()), sum(total.values())
    wt = sum(W[s] * found[s] for s in W) / max(sum(W[s] * total[s] for s in W), 1)
    return {"found": f, "total": n, "recall": f / n if n else 0.0, "high": found["high"], "medium": found["medium"],
            "low": found["low"], "weighted": wt}


def correct_share(comment_rows: list[dict]) -> float:
    c = collections.Counter(r["grade"] for r in comment_rows)
    return (c["correct-valuable"] + c["correct-minor"]) / max(sum(c.values()), 1)


def rpf(found: float, total: float, generated: float) -> tuple[float, float, float]:
    r = found / total if total else 0.0
    p = found / generated if generated else 0.0
    return r, p, (2 * p * r / (p + r) if p + r else 0.0)


# ---------------------------------------------------------------------------
# Martian: the tool a scoring dir's reviews are labelled with, its scores, the posted page
# ---------------------------------------------------------------------------

def ingest_relabels(bench: dict, run: str, arm_tool: str | None) -> dict[str, str]:
    """{recorded tool: the run's own tool} for a Martian scoring dir whose ingest recorded a bench
    run's reviews under another name: every review of the tool carries martian_ingest's note "bench
    run <run>; not posted" in its pr_url, so it is the review `run` wrote, and `arm_tool` (the run's
    `<run>.arm.json` arm through martian_ingest.ARM_TOOLS) is its tool. A re-judged vendor review
    (`rejudged-*`, Martian's published text) is never relabelled."""
    if not arm_tool:
        return {}
    seen: dict[str, bool] = {}
    for v in bench.values():
        for r in (v or {}).get("reviews") or []:
            t = r.get("tool")
            if not t or t == arm_tool or t.startswith("rejudged-"):
                continue
            seen[t] = seen.get(t, True) and f"bench run {run};" in (r.get("pr_url") or "")
    return {t: arm_tool for t, ours in seen.items() if ours}


SCORE_KEYS = ("precision", "recall", "f1", "f2", "tp", "fp", "fn")


def merge_scores(a: dict, b: dict) -> dict:
    """Two of Martian's score records ({profile: {tp, fp, fn, precision, ...}}) over disjoint PRs as
    one: the counts summed, the rates recomputed as its scorer does (micro-averaged, F-beta)."""
    out = {}
    for prof in sorted(set(a) | set(b)):
        x, y = a.get(prof) or {}, b.get(prof) or {}
        tp, fp, fn = (int(x.get(k) or 0) + int(y.get(k) or 0) for k in ("tp", "fp", "fn"))
        p = tp / (tp + fp) if tp + fp else 0.0
        r = tp / (tp + fn) if tp + fn else 0.0
        out[prof] = {"precision": p, "recall": r, "f1": 2 * p * r / (p + r) if p + r else 0.0,
                     "f2": 5 * p * r / (4 * p + r) if p + r else 0.0, "tp": tp, "fp": fp, "fn": fn,
                     "prs": int(x.get("prs") or 0) + int(y.get("prs") or 0)}
    return out


def posted_beyond_page(run_dir: str, iid: str, arm: str | None) -> list[dict]:
    """The inline comments a review had beyond the first page Martian's step 1 reads
    (martian_ingest.GITHUB_PAGE): QuickReview's posted ones (`cases/<id>/comments.json`, in the order
    posted), a third-party arm's located findings (`results/all/<id>.json`); the same fields as the
    page's items."""
    if arm in (None, "qcr"):
        inline = _read_json(os.path.join(run_dir, "cases", iid, "comments.json"))
        rows = inline[MI.GITHUB_PAGE:] if isinstance(inline, list) else []
        return [{"path": c.get("path"), "line": c.get("line"), "body": c.get("body")}
                for c in rows if isinstance(c, dict) and c.get("body")]
    res = _read_json(os.path.join(run_dir, "results", "all", f"{iid}.json"))
    rows = [c for c in (((res or {}).get("review") or {}).get("comments") or [])
            if isinstance(c, dict) and str(c.get("content") or "").strip()] if isinstance(res, dict) else []
    return [{"path": c.get("path"), "line": c.get("end_line") or c.get("start_line"), "body": str(c["content"]).strip()}
            for c in rows[MI.GITHUB_PAGE:]]


# ---------------------------------------------------------------------------
# Which rows each published number reads: the claims manifest's q keys
# ---------------------------------------------------------------------------

CLAIMS_MANIFEST = os.path.join(HERE, "claims.json")
_QREF = re.compile(r"\{([a-z_]+):([^{}]+)\}")  # verify_claims.refs_of's grammar


def q_refs(q: str) -> list[tuple[str, str]]:
    """(check, key) of every reference in a claim's q: `{check:key}` in an expression, else the whole q."""
    found = _QREF.findall(q or "")
    if found:
        return found
    check, _, key = (q or "").partition(":")
    return [(check, key)] if key else []


def _dirs_of(work: str, suffix: str, units: set) -> set:
    """The run index units of a Martian or Qodo `work_dir`: the review run and its scoring dir(s)."""
    base = work.split(suffix)[0]
    return {u for u in (work, base, base + suffix) if u in units}


# the severity, effort and tier words a script's JSON key uses as path segments
LEVEL_WORDS = {"nit", "low", "medium", "high", "xhigh", "max", "critical", "minimal"}


def key_build_arms() -> dict:
    """recompute/key_build.py STUDY: its candidate-key reviewer names and the study arm each stands for."""
    sys.path.insert(0, os.path.join(HERE, "recompute"))
    import key_build
    return key_build.STUDY


def cited(check: str, key: str, arm_ids: set, units: set, martian_dirs: set) -> tuple[set, set]:
    """(arm ids, run index units) one q-key reference reads (recompute/claim_metrics.py's key
    grammar for the table checks; for a script's JSON key, every path segment that is an arm id or a
    run index unit, never a level word, key_build's reviewer aliases read as their arms)."""
    head = key.rpartition(":")[0]
    arms, runs = set(), set()
    if check == "aacr":
        names, _, sel = head.partition("~")
        arms |= set(names.partition("@")[0].split("+"))
        for part in sel.split("&"):
            k, _, v = part.partition("=")
            (arms if k in ("arm", "done") else runs if k == "run" else set()).add(v)
    elif check == "judges":
        parts = head.split("|")
        arms |= set(parts[2].split("+")) if len(parts) > 2 else set()
    elif check == "martian":
        if head == "dirs" or head.startswith("dirsmax:"):
            pre = key.rpartition(":")[2] if head == "dirs" else head[len("dirsmax:"):]
            works = {w for w in martian_dirs if w.startswith(pre)}
        else:
            works = set() if head.startswith("goldens") else set(head.partition("~")[0].partition("|")[0].split("+")) - {"-"}
        for w in works:
            runs |= _dirs_of(w, ".martian", units)
    elif check == "qodo":
        if head != "issues":
            runs |= _dirs_of(head.partition("|")[0], ".qodo", units)
    elif check == "second_judge":
        # a second judge's numbers are read from second_judges/, which neither `arms` nor the run index
        # describes: they link no arm and no unit, so the tables its verdicts were made against keep their rows
        pass
    elif check == "key":  # claim_metrics.Key: only its `arm=` selector reads an arm's reviews
        for part in key.partition("~")[2].split("&"):
            k, _, v = part.partition("=")
            if k == "arm":
                arms.add(v)
    elif check != "sets":
        segs = [x.strip() for x in re.split(r"[|/]", key)] + [x for x in re.split(r"[|:]", key)]
        if check == "elo" and "elo" in units:
            runs.add("elo")
        # a script's level words are never an arm (the development arm `low` is also a severity and an
        # effort), and key_build names the earlier study's reviewers by alias (`low` is quickreview-low-sol,
        # except under a `…_by_severity` segment)
        alias = key_build_arms() if check == "key_build" else {}
        parts = key.split("/")
        arms |= {alias[x] for i, x in enumerate(parts) if x in alias and not (i and "severity" in parts[i - 1])}
        arms |= {x for x in segs if x in arm_ids and x not in LEVEL_WORDS and x not in alias}
        runs |= {x for x in segs if x in units}
    return arms & arm_ids, runs & units


def reads_of(checks: dict | None, runs: list[dict]) -> dict:
    """{(check, q key): run index units}: a script check's `reads` in claims.json, {unit path: [the q keys
    whose number is computed from that unit's files]}, by unit name (the runs table's `unit` of each path)."""
    name = {r["path"]: r["unit"] for r in runs if r.get("path")}
    out = collections.defaultdict(set)
    for check, spec in (checks or {}).items():
        for path, keys in (spec.get("reads") or {}).items():
            for k in keys:
                if path in name:
                    out[(check, k)].add(name[path])
    return out


def reads_problems(checks: dict, claims: list[dict], runs: list[dict]) -> list[str]:
    """Each check's `reads` against the run index and the claims: a unit path no runs row has, or a key no
    claim of that check reads."""
    paths = {r["path"] for r in runs}
    used = {(ch, k) for c in claims for ch, k in q_refs(c.get("q") or "")}
    out = []
    for check, spec in checks.items():
        for path, keys in (spec.get("reads") or {}).items():
            out += [f"{check}: {path} is not a run index unit"] if path not in paths else []
            out += [f"{check}: {path}: {k} is read by no claim" for k in keys if (check, k) not in used]
    return out


def family_link_problems(t: dict[str, list[dict]], manifest: dict) -> list[str]:
    """Every family claims.json's `groups` name as backing a published number, against the derived links:
    a family none of whose units carries any claim group."""
    linked = {r["family"] for r in t["runs"] if r.get("claims")}
    named = {f for spec in (manifest.get("groups") or {}).values() for f in spec.get("families") or []}
    return sorted(f for f in named if f not in linked)


def claim_links(claims: list[dict], arms: list[dict], runs: list[dict], martian_dirs: set,
                checks: dict | None = None) -> tuple[dict, dict]:
    """({arm id: claim groups}, {run index unit: claim groups}): the groups of the claims whose q keys
    read the arm or the unit, an arm's runs included, and the units a script check's `reads` names for
    the key (reads_of). A claim with no group links nothing."""
    arm_ids, units = {a["arm_id"] for a in arms}, {r["unit"] for r in runs}
    arm_runs = {a["arm_id"]: set(a.get("runs") or []) for a in arms}
    reads = reads_of(checks, runs)
    by_arm, by_unit = collections.defaultdict(set), collections.defaultdict(set)
    for c in claims:
        g = c.get("group")
        if not g:
            continue
        for check, key in q_refs(c.get("q") or ""):
            a, u = cited(check, key, arm_ids, units, martian_dirs)
            u |= reads.get((check, key), set())
            for x in a:
                by_arm[x].add(g)
                u |= arm_runs[x] & units
            for x in u:
                by_unit[x].add(g)
    return dict(by_arm), dict(by_unit)


def claim_link_problems(t: dict[str, list[dict]], claims: list[dict], checks: dict | None = None) -> dict[str, list[str]]:
    """The tables against the manifest's q keys, both ways: `arms`, every arm whose `paper_tables` is not
    exactly the groups of the claims that read it (a group missing, or a label no claim reads it under)
    or whose `in_paper` is not whether any claim reads it; `runs`, every run index unit whose `claims` is
    not exactly the groups of the claims that read it."""
    martian = {s["work_dir"] for s in t.get("martian_scores") or [] if s.get("work_dir")}
    by_arm, by_unit = claim_links(claims, t["arms"], t["runs"], martian, checks)

    def diff(name, have, want):
        have, want = set(have or []), set(want)
        return [f"{name}: {g}" for g in sorted(want - have)] + [f"{name}: {g} (no claim reads it)" for g in sorted(have - want)]
    arms = [x for a in t["arms"] for x in diff(a["arm_id"], a["paper_tables"], by_arm.get(a["arm_id"], ()))
            + ([f"{a['arm_id']}: in_paper"] if bool(a["in_paper"]) != bool(by_arm.get(a["arm_id"])) else [])]
    runs = [x for r in t["runs"] for x in diff(r["unit"], r["claims"], by_unit.get(r["unit"], ()))]
    return {"arms": sorted(arms), "runs": sorted(runs)}


def claim_groups(t: dict[str, list[dict]], claims: list[dict], checks: dict | None = None) -> dict[str, dict]:
    """{claim group: its families and archive volumes}, from the units its claims' q keys read."""
    martian = {s["work_dir"] for s in t.get("martian_scores") or [] if s.get("work_dir")}
    _, by_unit = claim_links(claims, t["arms"], t["runs"], martian, checks)
    fam = {r["unit"]: (r["family"], r.get("archive_volumes") or []) for r in t["runs"]}
    out = collections.defaultdict(lambda: {"families": set(), "volumes": set()})
    for u, gs in by_unit.items():
        for g in gs:
            out[g]["families"].add(fam[u][0])
            out[g]["volumes"].update(fam[u][1])
    return {g: {k: sorted(v) for k, v in d.items()} for g, d in sorted(out.items())}


# the run index fields this export derives (build_runs: a Martian scoring dir's judge settings;
# link_claims: the claim groups), which export_runs.py's RUNS-INDEX.json does not hold (it writes the
# catalogue's family judges and no claims)
RUN_INDEX_DERIVED = ("judges", "claims")


def claims_described(runs: list[dict], groups: dict) -> dict[str, str | None]:
    """RUNS-INDEX.json's top-level `claims`: every claim group a run carries, with the manifest's
    description of it (`groups.<id>.what`; None for a group the manifest does not declare)."""
    return {g: (groups.get(g) or {}).get("what") for g in sorted({g for r in runs for g in r.get("claims") or []})}


def sync_run_index(path: str, runs: list[dict], groups: dict) -> None:
    """Write the runs table's derived fields into the archive's RUNS-INDEX.json units, so the index
    holds the same rows as the table (run_index_problems checks every field), and describe each claim
    group the units carry from the manifest's `groups` (claims_described). A row is its `path`: two
    units can share a name (`ext-images` and `open-models/ext-images`)."""
    with open(path) as f:
        doc = json.load(f)
    by = {r["path"]: r for r in runs}
    for u in doc["units"]:
        if u["path"] in by:
            u.update({k: by[u["path"]][k] for k in RUN_INDEX_DERIVED})
    doc["claims"] = claims_described(runs, groups)
    with open(path, "w") as f:
        f.write(json.dumps(doc, indent=1, ensure_ascii=False) + "\n")


def run_index_problems(index: dict, runs: list[dict], groups: dict) -> list[str]:
    """The archive's RUNS-INDEX.json units against the runs table, row by `path`: a row on one side only,
    a path on two rows, or a field whose value differs; and its top-level `claims` against the groups
    the rows carry: a group carried and not described, described and not carried, or with no
    description in the manifest."""
    rows, idx = list(runs), list(index.get("units") or [])
    by = {r["path"]: r for r in rows}
    units = {u["path"]: u for u in idx}
    out = [f"{p}: on two rows" for p, n in collections.Counter([r["path"] for r in rows] + [u["path"] for u in idx]).items()
           if n > 2 or (n == 2 and (p not in by or p not in units))]
    out += [f"{u}: only in RUNS-INDEX.json" for u in sorted(set(units) - set(by))]
    out += [f"{u}: only in runs" for u in sorted(set(by) - set(units))]
    for u in sorted(set(units) & set(by)):
        out += [f"{u}: {k}" for k in sorted(set(units[u]) | set(by[u])) if units[u].get(k) != by[u].get(k)]
    want, have = claims_described(rows, groups), index.get("claims") or {}
    out += [f"claims: {g} not described" for g in sorted(set(want) - set(have))]
    out += [f"claims: {g} described, carried by no unit" for g in sorted(set(have) - set(want))]
    out += [f"claims: {g} has no description in the manifest's groups" for g, w in want.items() if not w]
    out += [f"claims: {g} is not the manifest's description" for g in sorted(set(want) & set(have)) if have[g] != want[g]]
    return out


# ext_judge.py's verbosity: its log does not record it, and ext.sh starts it without --verbosity
EXT_JUDGE_VERBOSITY = "medium"
_UPSTREAM = re.compile(r"ext-judge on \S+ → (\S+) \(")


def martian_judge_settings(scoring_dir: str) -> str | None:
    """A Martian scoring dir's judge as its own files record it (`judge/JUDGE.txt`, the bridge's
    per-request log `judge/judge.jsonl`, `judge/container.log`): the model that served every call of
    Martian's steps 2, 2.5 and 3, the reasoning effort, the verbosity, the backend, and every request
    key the bridge dropped with how often. None when the dir holds no judge record."""
    d = os.path.join(scoring_dir, "judge")
    try:
        head = open(os.path.join(d, "JUDGE.txt")).read().strip()
    except OSError:
        return None
    calls, served, effort, dropped, probe = 0, collections.Counter(), collections.Counter(), collections.Counter(), None
    try:
        lines = open(os.path.join(d, "judge.jsonl")).read().splitlines()
    except OSError:
        lines = []
    for line in lines:
        try:
            r = json.loads(line)
        except ValueError:
            continue
        if r.get("probe") == "temperature":
            probe = r
            continue
        calls += 1
        served[r.get("served_model") or r.get("model")] += 1
        effort[r.get("effort")] += 1
        dropped.update(r.get("dropped") or [])
    try:
        m = _UPSTREAM.search(open(os.path.join(d, "container.log")).read())
    except OSError:
        m = None
    if not calls:
        return f"{head}; no request log in this dir (judge.jsonl holds no call)"
    out = [f"{' / '.join(sorted(map(str, served)))} served all {calls:,} calls of Martian's steps 2, 2.5 and 3 "
           "(extraction, de-duplication, judging)",
           f"reasoning effort {' / '.join(sorted(map(str, effort)))}",
           f"verbosity {EXT_JUDGE_VERBOSITY} (ext_judge.py's default; the judge was started without --verbosity)",
           f"backend {m.group(1) if m else 'not recorded'} ({head.rpartition('(')[2].rstrip(')') or 'login not recorded'})"]
    why = (f"; the upstream rejects temperature: the start probe got HTTP {probe.get('status')}"
           if probe and probe.get("accepted") is False else "")
    out.append("dropped by the bridge before the upstream: "
               + ", ".join(f"{k} ({n:,} of {calls:,} requests)" for k, n in sorted(dropped.items())) + why
               if dropped else "no request key dropped")
    return "; ".join(out)


# ---------------------------------------------------------------------------
# Reading the runs (only under main; needs the runs dir).
# ---------------------------------------------------------------------------

class Exporter:
    def __init__(self, a):
        self.a = a
        self.runs_dir = os.path.abspath(os.path.expanduser(a.runs_dir))
        om = getattr(a, "open_models", None)
        self.om_runs = os.path.join(os.path.abspath(os.path.expanduser(om)), "runs") if om else None
        catp = getattr(a, "catalogue", None)
        self.cat = RC.Catalogue.load(catp) if catp else None
        self.counts = collections.Counter()
        self.notes: list[str] = []
        self.tables: dict[str, list[dict]] = {}
        self.commits: tuple[dict, dict, dict] | None = None
        self.review_src: dict[tuple[str, str], str] = {}  # (published arm id, PR) -> the run dir its review was read from
        self.aacr_judges: dict[str, str] = {}
        self.key = {}  # iid -> {"set", "version", "case"}
        for s in SETS:
            d = json.load(open(os.path.join(HERE, "defects", f"{s}.json")))
            for iid, c in d["cases"].items():
                self.key[iid] = {"set": s, "version": d["version"], "case": c}

    def S(self, v):
        return scrub_obj(v, self.counts)

    # --- where a run lives, and its family ---------------------------------
    def rd(self, run: str) -> str:
        """A run (or scoring) dir: the bench runs dir's, else the open-model runs'."""
        p = os.path.join(self.runs_dir, run)
        if self.om_runs and not os.path.exists(p) and os.path.exists(os.path.join(self.om_runs, run)):
            return os.path.join(self.om_runs, run)
        return p

    @staticmethod
    def unit_dir(path: str, roots: dict) -> str:
        """A run index row's source dir, from its archive path (release_catalogue.archive_prefix)."""
        for kind, pre in (("om-runs", "open-models/runs/"), ("om-top", "open-models/"), ("runs", "runs/")):
            if path.startswith(pre):
                return os.path.join(roots.get(kind) or "", path[len(pre):])
        return os.path.join(roots.get("top") or "", path)

    def family(self, run: str) -> dict | None:
        if self.cat is None:
            return None
        kind = "om-runs" if self.om_runs and self.rd(run).startswith(self.om_runs + os.sep) else "runs"
        return self.cat.family_of(kind, run)

    def family_id(self, run: str | None) -> str | None:
        f = self.family(run) if run else None
        return f["id"] if f else None

    def all_runs(self) -> list[str]:
        """Every run and scoring dir of both roots that a shipped family with HF
        tables holds."""
        out = []
        for root in [self.runs_dir] + ([self.om_runs] if self.om_runs else []):
            for n in sorted(os.listdir(root)):
                if n.startswith(".") or not os.path.isdir(os.path.join(root, n)) or self.rd(n) != os.path.join(root, n):
                    continue
                if RC.Catalogue.hf_tables(self.family(n)):
                    out.append(n)
        return out

    def judge_labels(self, run: str) -> list[str]:
        """The defect judges of a run: judge/v<key>-<label>/ and judge/wpself-<label>/."""
        d = os.path.join(self.rd(run), "judge")
        out = set()
        for n in os.listdir(d) if os.path.isdir(d) else []:
            m = re.match(r"^v\d+-(.+)$", n)
            if m and os.path.isdir(os.path.join(d, n)):
                out.add(m.group(1))
            elif n.startswith("wpself-") and os.path.isdir(os.path.join(d, n)):
                out.add(n)
        return sorted(out, key=lambda x: (x not in JUDGE_ORDER, JUDGE_ORDER.index(x) if x in JUDGE_ORDER else 0, x))

    def generic_aacr_arms(self, paper: list[dict]) -> list[dict]:
        """An arm for every other shipped AACR review run: the runs of one
        family that differ only in their set suffix form one arm when their PRs
        do not overlap, else each run is its own arm. Scored like the paper's
        arms: per PR the first run with a usable judgement of the arm's primary
        judge."""
        if self.cat is None:
            return []
        taken = {r for a in paper for r in a["runs"]}
        groups: dict[tuple[str, str], list[str]] = collections.defaultdict(list)
        for run in self.all_runs():
            if "." in run or run in taken or not set(AACR_TABLES) & set(RC.Catalogue.hf_tables(self.family(run))):
                continue
            d = os.path.join(self.rd(run), "cases")
            if not os.path.isdir(d) or not any(i in self.key for i in os.listdir(d)):
                continue
            m = SET_SUFFIX.match(run)
            groups[(self.family_id(run), m.group(1) if m else run)].append(run)
        ids = {a["arm_id"] for a in paper}
        out = []
        for (fid, prefix), runs in sorted(groups.items()):
            cases = [set(i for i in os.listdir(os.path.join(self.rd(r), "cases")) if i in self.key) for r in runs]
            disjoint = sum(len(c) for c in cases) == len(set().union(*cases))
            for arm_runs in ([sorted(runs)] if disjoint else [[r] for r in sorted(runs)]):
                aid = prefix if disjoint else arm_runs[0]
                while aid in ids:
                    aid += "+"
                ids.add(aid)
                labels = []
                for r in arm_runs:
                    labels += [x for x in self.judge_labels(r) if x not in labels]
                labels.sort(key=lambda x: (x not in JUDGE_ORDER, JUDGE_ORDER.index(x) if x in JUDGE_ORDER else 0, x))
                fam = self.cat.families.get(fid) or {}
                out.append({"arm_id": aid, "benchmark": "aacr",
                            "display_name": f"{fam.get('title') or fid}: {aid}", "runs": arm_runs,
                            "studies": [fam.get("title") or fid], "paper_tables": [], "scope": "runs",
                            "link_only": False, "note": "", "judges": labels or [PRIMARY]})
        return out

    # --- the key -----------------------------------------------------------
    def build_key(self):
        sel40 = set(open(os.path.join(HERE, "final", "select40.txt")).read().strip().split(":", 1)[1].split(","))
        meta = {}
        for s in SETS:
            for c in json.load(open(os.path.join(HERE, "sets", f"{s}.json")))["cases"]:
                meta[c["instance_id"]] = c
        prs, defects, excl = [], [], []
        judged = pr_meta(os.path.dirname(self.runs_dir))
        for iid, k in self.key.items():
            m, c = meta[iid], k["case"]
            j = judged.get(iid) or {}
            sev = collections.Counter(x["severity"] for x in c["defects"])
            prs.append({
                "instance_id": iid, "set": k["set"], "key_version": str(k["version"]), "repo": m["repo"],
                "pr_number": m["pr"], "pr_url": m["pr_url"], "title": self.S(j.get("title")),
                "base_commit": m["base_commit"], "merge_base": j.get("merge_base"),
                "head_commit": m["head_commit"], "language": m["language"], "pr_category": m["pr_category"],
                "change_line_count": m["change_line_count"], "aacr_references": m["references"],
                "in_s40": iid in sel40, "pr_summary": self.S(c.get("pr_summary")),
                "defects": len(c["defects"]), "defects_high": sev["high"], "defects_medium": sev["medium"],
                "defects_low": sev["low"], "exclusions": len(c["excluded"]),
                "repo_license": REPO_LICENSES[m["repo"]][0], "repo_license_note": REPO_LICENSES[m["repo"]][1],
            })
            for x in c["defects"]:
                # the key file's provenance, as the papers read it; on T40 it records the older runs
                # only, and the case's truth-ext.json (the answer-key volume) adds the extension
                # reviewers' matches (N-ids)
                p = x.get("provenance") or {}
                hunt = p.get("hunt")
                bdr = x.get("bot_derived_reference")
                defects.append(self.S({
                    "instance_id": iid, "set": k["set"], "key_version": str(k["version"]), "defect_id": x["id"],
                    "title": x["title"], "statement": x["statement"], "kind": x["kind"], "severity": x["severity"],
                    "sites": [{"path": st["path"], "from_line": st["from_line"], "to_line": st["to_line"],
                               "role": st.get("role")} for st in x["sites"]],
                    "evidence": x["evidence"], "counts_if": x.get("notes"),
                    "provenance_hunt": bool(hunt), "provenance_hunt_refs": [str(h) for h in hunt] if isinstance(hunt, list) else [],
                    "provenance_dataset_refs": [str(r) for r in p.get("dataset_refs") or []],
                    "provenance_reviewer_comments": [str(r) for r in p.get("reviewer_comments") or []],
                    "provenance_added_in": p.get("added_in"),
                    "benchmark_limitation": x.get("benchmark_limitation"),
                    "bot_derived_reference": json.dumps(bdr, ensure_ascii=False) if bdr else None,
                    "repo": m["repo"], "head_commit": m["head_commit"],
                }))
            for j, e in enumerate(c["excluded"]):
                excl.append(self.S({"instance_id": iid, "set": k["set"], "key_version": str(k["version"]),
                                    "index": j, "source": e["source"], "reason": e["reason"]}))
        self.tables["prs"], self.tables["defects"], self.tables["exclusions"] = prs, defects, excl

    def build_references(self):
        raw = open(self.a.aacr_dataset, "rb").read()
        if hashlib.sha256(raw).hexdigest() != AACR_V1_SHA256:
            raise SystemExit("--aacr-dataset is not AACR-Bench v1.0 (sha256 mismatch)")
        from select_cases import case_of
        bots = json.load(open(os.path.join(HERE, "bot_references.json")))["references"]
        refs = []
        for rec in json.loads(raw):
            iid = case_of(rec)["instance_id"]
            if iid not in self.key:
                continue
            for j, c in enumerate(rec.get("comments") or []):
                key = compare.note_key(c["path"], c["from_line"], c["to_line"], c["note"])
                b = (bots.get(iid) or {}).get(key)
                refs.append(self.S({
                    "instance_id": iid, "set": self.key[iid]["set"], "ref_index": j, "ref_key": key,
                    "path": c["path"], "from_line": c["from_line"], "to_line": c["to_line"], "side": c.get("side"),
                    "note": c["note"], "category": c.get("category"), "context": c.get("context"),
                    "is_ai_comment": c.get("is_ai_comment"), "source_model": c.get("source_model"),
                    "bot_derived": b is not None, "bot": (b or {}).get("bot"), "bot_overlap": (b or {}).get("overlap"),
                }))
        self.tables["aacr_references"] = refs
        labels = []
        for s in ("smoke10", "dev10", "holdout10"):
            lab = json.load(open(os.path.join(HERE, "sets", f"{s}.labels.json")))
            for iid, rows in lab["labels"].items():
                for j, r in enumerate(rows):
                    cand = [x["ref_key"] for x in refs if x["instance_id"] == iid and x["path"] == r["path"]
                            and x["from_line"] == r["from_line"]]
                    labels.append(self.S({
                        "instance_id": iid, "set": s, "index": j, "path": r["path"], "from_line": r["from_line"],
                        "ref_key": cand[0] if len(set(cand)) == 1 else None, "reality": r["reality"],
                        "value": r.get("value"), "reason": r.get("reason"), "miss_reason": r.get("miss_reason"),
                        "label_source": lab.get("source"),
                    }))
        self.tables["aacr_reference_labels"] = labels

    # --- reviews and verdicts ---------------------------------------------
    def arm_cases(self, arm) -> list[str]:
        if arm["scope"] == "all185":
            return list(self.key)
        seen = []
        for run in arm["runs"]:
            d = os.path.join(self.rd(run), "cases")
            for iid in sorted(os.listdir(d)) if os.path.isdir(d) else []:
                if iid in self.key and iid not in seen:
                    seen.append(iid)
        return seen

    def judgement(self, run, iid, label):
        v = self.key[iid]["version"]
        sub = label if label.startswith("wpself-") else f"v{v}-{label}"
        f = os.path.join(self.rd(run), "judge", sub, f"{iid}.r1.json")
        j = _read_json(f)
        if not isinstance(j, dict) or j.get("error"):
            return None
        return j

    def build_aacr_reviews(self):
        paper = aacr_arms()
        arms = paper + self.generic_aacr_arms(paper)
        reviews, dv, cv, matches = [], [], [], []
        mismatched = []
        for arm in arms:
            aacr_rows = self.aacr_metric(arm)
            first = arm["judges"][0]
            for iid in self.arm_cases(arm):
                src = next((r for r in arm["runs"] if self.judgement(r, iid, first)), None)
                if src is None:
                    src = next((r for r in arm["runs"] if os.path.isdir(os.path.join(self.rd(r), "cases", iid))), None)
                    judged = False
                else:
                    judged = True
                case_dir = os.path.join(self.rd(src), "cases", iid) if src else None
                summary = _read_json(os.path.join(case_dir, "case-summary.json")) if case_dir else None
                summary = summary if isinstance(summary, dict) else {}
                comments = review_for_judge(self.rd(src), iid) if src else []
                body = None
                if case_dir and os.path.exists(os.path.join(case_dir, "review.md")):
                    body = open(os.path.join(case_dir, "review.md")).read().strip() or None
                usd, mins = compare.usd_and_minutes(case_dir) if case_dir else (None, None)
                source_url = None
                if arm["link_only"]:
                    body = None
                    m = self.key[iid]
                    pr_url = next(c["pr_url"] for c in json.load(open(os.path.join(HERE, "sets", f"{m['set']}.json")))["cases"]
                                  if c["instance_id"] == iid)
                    ids = [r.get("id") for r in summary.get("reviews") or [] if r.get("id")]
                    source_url = " ".join(f"{pr_url}#pullrequestreview-{i}" for i in ids) or pr_url
                    for c in comments:
                        c["text"] = c["raw_text"] = None
                a_ref = aacr_rows.get(iid)
                judged_by = [jlabel(lb) for lb in arm["judges"] if src and self.judgement(src, iid, lb)]
                fid = self.family_id(src)
                if src:  # by the published arm id: a generic arm's id is its run's name, which the rewrite may change
                    self.review_src[(scrub(arm["arm_id"]), iid)] = src
                reviews.append(self.S({
                    "arm_id": arm["arm_id"], "instance_id": iid, "set": self.key[iid]["set"], "run": src,
                    "judged": judged, "status": summary.get("status"), "verdict": summary.get("verdict"),
                    "body": body, "comments": comments, "n_comments": len(comments),
                    "cost_usd": usd, "minutes": mins, "source_url": source_url,
                    "aacr_scored_comments": a_ref["generated"] if a_ref else None,
                    "judged_by": judged_by, "run_family": fid,
                }))
                if a_ref:
                    for key, share in sorted(a_ref["refs"].items()):
                        matches.append(self.S({"arm_id": arm["arm_id"], "instance_id": iid, "ref_key": key,
                                               "match_share": share, "run_family": fid}))
                if not src:
                    continue
                for label in arm["judges"]:
                    j = self.judgement(src, iid, label)
                    if j is None:
                        continue
                    if label == first and len(j.get("comments") or []) != len(comments):
                        mismatched.append(f"{arm['arm_id']}/{iid}: judge {len(j.get('comments') or [])} vs export {len(comments)}")
                    jl = jlabel(label)
                    for d in j.get("defects") or []:
                        dv.append(self.S({"arm_id": arm["arm_id"], "instance_id": iid, "judge": jl,
                                          "key_version": str(self.key[iid]["version"]), "defect_id": d["id"],
                                          "verdict": d.get("verdict"), "credit": credit(d.get("verdict")),
                                          "comment_ids": [str(x) for x in d.get("comments") or []], "why": d.get("why"),
                                          "run_family": fid}))
                    for c in j.get("comments") or []:
                        cv.append(self.S({"arm_id": arm["arm_id"], "instance_id": iid, "judge": jl, "comment_id": c["id"],
                                          "grade": c.get("verdict"), "defect_id": c.get("defect"),
                                          "new_defect": c.get("new_defect"), "why": c.get("why"), "run_family": fid}))
        if mismatched:
            self.notes.append(f"{len(mismatched)} reviews whose exported comment count differs from the primary judge's: "
                              + "; ".join(mismatched[:20]))
        arm_rows = []
        for arm in arms:
            fams = sorted({self.family_id(r) or "" for r in arm["runs"]} - {""})
            billed = sorted({(self.family(r) or {}).get("model_billed") or "" for r in arm["runs"]} - {""})
            arm_rows.append(self.S({k: arm[k] for k in ("arm_id", "benchmark", "display_name", "runs", "studies",
                                                        "paper_tables", "scope", "link_only", "note")}
                                   | {"aacr_judge": self.aacr_judges.get(arm["arm_id"]),
                                      "judge": jlabel(arm["judges"][0]),
                                      "judges": judges_that_scored(arm["arm_id"], arm["judges"], dv, cv),
                                      "run_family": fams[0] if len(fams) == 1 else (", ".join(fams) or None),
                                      "model_billed": " / ".join(billed) or None,
                                      "in_paper": bool(arm["paper_tables"])}))
        self.tables["arms"] = arm_rows
        self.tables["reviews"], self.tables["defect_verdicts"] = reviews, dv
        self.tables["comment_verdicts"], self.tables["aacr_matches"] = cv, matches

    def aacr_metric(self, arm) -> dict:
        """compare.aacr per PR: {iid: {"refs": {key: share}, "generated": n}}."""
        out, scored, judges = {}, set(), set()
        for run in arm["runs"]:
            d = os.path.join(self.rd(run), "results", "all")
            rounds = [f for f in sorted(glob.glob(os.path.join(d, "metrics_*_*.json"))) if "average" not in f]
            per = collections.defaultdict(list)
            for f in rounds:
                for inst in (json.load(open(f)).get("eval_res") or []):
                    iid = inst["instance_id"]
                    if iid not in self.key or iid in scored:
                        continue
                    for c in inst.get("comments") or []:
                        key = compare.note_key(c["path"], c["from_line"], c["to_line"], c["note"])
                        per[(iid, key)].append(1 if c.get("semantic_match") else 0)
            got = {k[0] for k in per}
            for (iid, key), v in per.items():
                out.setdefault(iid, {"refs": {}, "generated": 0})["refs"][key] = sum(v) / len(v)
            for iid in got:
                r = _read_json(os.path.join(d, f"{iid}.json")) or {}
                rows = (r.get("review") or {}).get("comments") or r.get("comments") or []
                if not rows and isinstance(r.get("review_output"), list):
                    rows = [x for x in r["review_output"] if isinstance(x, dict) and "\n".join(
                        p for p in [(x.get("summary") or "").strip(), (x.get("failure_scenario") or "").strip()] if p)]
                out[iid]["generated"] = len(rows)
            if got and rounds:
                j = os.path.join(self.rd(run), "judge.txt")
                judges.add(open(j).readline().strip() if os.path.exists(j) else "(no judge.txt)")
            scored |= got
        if judges:
            self.aacr_judges[arm["arm_id"]] = scrub(" / ".join(sorted(judges)))
        return out

    # --- Martian --------------------------------------------------------------
    def build_martian(self):
        import martian_real
        main = os.path.join(self.runs_dir, "final1-martian50.martian")
        published = json.load(open(os.path.join(main, "published-benchmark_data.json")))
        goldens = martian_real.buckets(published)
        audit = {}
        for x in json.load(open(os.path.join(HERE, "ext", "martian-tuning", "golden-audit-full.json"))):
            audit[(x["url"], x["idx"])] = x
        mset = {c["martian"]["golden_url"]: c for c in json.load(open(os.path.join(HERE, "sets", "martian50.json")))["cases"]}
        # each PR's half, from the set files (the audit file leaves the split empty for the goldens
        # its first round labelled)
        half = {c["martian"]["golden_url"]: name for name in ("test30", "tune20")
                for c in json.load(open(os.path.join(HERE, "sets", f"martian-{name}.json")))["cases"]}
        prs, gold = [], []
        for u in sorted(published):
            p = published[u]
            c = mset.get(u, {})
            prs.append(self.S({"pr_url": u, "instance_id": c.get("instance_id"), "repo": c.get("repo"),
                               "source_repo": p.get("source_repo"), "title": p.get("pr_title"),
                               "base_commit": c.get("base_commit"), "head_commit": c.get("head_commit"),
                               "language": c.get("language"), "goldens": len(p["golden_comments"]),
                               **bench_repo_license(c.get("repo"), c.get("pr"))}))
            for i, g in enumerate(p["golden_comments"]):
                au = audit.get((u, i)) or {}
                gold.append(self.S({
                    "pr_url": u, "golden_index": i, "comment": g["comment"], "severity": g.get("severity"),
                    "category": g.get("category"), "audit_bucket": goldens[(u, i)]["bucket"],
                    "audit_split": au.get("split") or half.get(u),
                    "audit_first_verdict": (au.get("first") or {}).get("verdict"),
                    "audit_second_verdict": (au.get("second") or {}).get("verdict"),
                    "audit_evidence": (au.get("first") or {}).get("evidence"),
                    "audit_strongest_case": (au.get("first") or {}).get("strongest_case_for_golden"),
                }))
        set_by_url = {c["martian"]["golden_url"]: c["instance_id"] for c in mset.values()}
        reviews, verdicts, scores = [], [], []
        for work, rename in MARTIAN_PAPER:
            self._martian_dir(work + ".martian", rename, goldens, set_by_url, reviews, verdicts, scores, paper=True)
        done = {w + ".martian" for w, _ in MARTIAN_PAPER}
        for wd in self.all_runs():
            if ".martian" in wd and wd not in done:
                self._martian_dir(wd, {}, goldens, set_by_url, reviews, verdicts, scores, paper=False)
        self.tables["martian_prs"], self.tables["martian_goldens"] = prs, gold
        self.tables["martian_reviews"], self.tables["martian_verdicts"] = reviews, verdicts
        self.tables["martian_scores"] = [self.S(s) for s in scores]

    def _martian_dir(self, wd: str, rename: dict, goldens: dict, set_by_url: dict, reviews: list, verdicts: list,
                     scores: list, paper: bool):
        """One Martian scoring dir: its reviews (as ingested), the judge's
        verdict on every golden of every PR it scored, and its scores. A
        paper dir keeps the 10-05 rows exactly (its `published` scores carry
        no work dir; only the paper's judge, gpt-6.1-sol); any other dir
        exports every judge it holds and names itself in every row."""
        path = self.rd(wd)
        work = work_dir_name(wd, ".martian")
        fid = self.family_id(wd)
        ms = _read_json(os.path.join(path, "martian-scores.json")) or {}
        this_judge = (ms.get("this_run") or {}).get("judge")
        judges = sorted(d for d in os.listdir(os.path.join(path, "results"))
                        if os.path.isfile(os.path.join(path, "results", d, "evaluations.json"))) \
            if os.path.isdir(os.path.join(path, "results")) else []
        if paper:
            judges = ["gpt-6.1-sol"]
        if not judges:
            self.notes.append(f"martian {wd}: no results/<judge>/evaluations.json")
            return
        primary = this_judge if this_judge in judges else judges[0]
        bench = _read_json(os.path.join(path, "results", "benchmark_data.json")) or {}
        run = wd.split(".martian")[0]
        run_dir = self.rd(run)
        arm = (_read_json(run_dir + ".arm.json") or {}).get("arm")
        relabel = ingest_relabels(bench, run, MI.ARM_TOOLS.get(arm))
        for t, to in sorted(relabel.items()):
            self.notes.append(f"martian {wd}: tool {t!r} relabelled {to!r} (its reviews are run {run}'s, arm {arm})")

        def label(tool):
            tool = relabel.get(tool, tool)
            return rename.get(tool, tool)
        this = {}
        for tool, sc in ((ms.get("this_run") or {}).get("scores") or {}).items():
            # a relabelled tool's scores join its run's own tool's: one row per tool, as Martian scores one tool
            this[label(tool)] = merge_scores(this[label(tool)], sc) if label(tool) in this else sc
        for name, sc in this.items():
            scores.append({"tool": name, "judge": this_judge or primary, "work_dir": work,
                           "run_family": fid,
                           **{f"{prof}_{k}": v.get(k) for prof, v in sc.items() for k in SCORE_KEYS}})
        for judge, by in (ms.get("published") or {}).items():
            if paper and work != "final1-martian50":
                continue
            for tool, sc in by["scores"].items():
                scores.append({"tool": tool, "judge": f"published: {judge}", "work_dir": None if paper else work,
                               "run_family": fid,
                               **{f"{prof}_{k}": v.get(k) for prof, v in sc.items() for k in SCORE_KEYS}})
        report = {r.get("pr"): r for r in _read_json(os.path.join(path, "results", "ingest-report.json")) or []
                  if isinstance(r, dict)}
        tools_here = set()
        for judge in judges:
            evals = json.load(open(os.path.join(path, "results", judge, "evaluations.json")))
            for u in sorted(evals):
                for tool, e in evals[u].items():
                    tools_here.add(tool)
                    vendor = tool.startswith("rejudged-")
                    name = label(tool)
                    if judge == primary:
                        rv = next((r for r in (bench.get(u) or {}).get("reviews") or [] if r["tool"] == tool), {})
                        iid = set_by_url.get(u)
                        usd = mins = None
                        own = not vendor and (paper or relabel.get(tool, tool) == "quickreview"
                                              or len([t for t in evals[u] if not t.startswith("rejudged-")]) == 1)
                        if own and iid and os.path.isdir(os.path.join(run_dir, "cases", iid)):
                            usd, mins = compare.usd_and_minutes(os.path.join(run_dir, "cases", iid))
                        comments = [] if vendor else [{"path": c.get("path"), "line": c.get("line"), "body": c.get("body")}
                                                      for c in rv.get("review_comments") or []]
                        # the inline comments the review had (QuickReview: posted), of which Martian's step 1
                        # read the first page; the rest, from the run's own files
                        posted = None if vendor else (report.get(u) or {}).get("inline_total")
                        beyond = (posted_beyond_page(run_dir, iid, arm if arm else None)
                                  if posted is not None and posted > MI.GITHUB_PAGE and iid else [])
                        reviews.append(self.S({
                            "tool": name, "pr_url": u, "work_dir": work, "vendor_link_only": vendor,
                            "source_url": rv.get("pr_url") if vendor else None, "comments": comments,
                            "n_comments": len(rv.get("review_comments") or []),
                            "n_posted_inline": posted, "comments_beyond_first_page": beyond,
                            "extracted_candidates": e.get("total_candidates"),
                            "unmatched_candidates": None if vendor else [fp.get("candidate") for fp in e.get("false_positives") or []],
                            "tp": e.get("tp"), "fp": e.get("fp"), "fn": e.get("fn"), "skipped": e.get("skipped"),
                            "cost_usd": usd, "minutes": mins, "judge": judge, "run_family": fid,
                        }))
                    texts = {v["text"]: i for (uu, i), v in goldens.items() if uu == u}
                    hit, unknown = {}, 0
                    for tp in e.get("true_positives") or []:
                        idx = texts.get(tp["golden_comment"])
                        if idx is None:
                            unknown += 1
                            continue
                        hit[idx] = tp
                    if unknown:
                        self.notes.append(f"martian {wd} {judge} {tool} {u}: {unknown} matched golden(s) not in the published goldens")
                    for (uu, i), v in goldens.items():
                        if uu != u:
                            continue
                        tp = hit.get(i)
                        verdicts.append(self.S({
                            "tool": name, "pr_url": u, "judge": judge, "golden_index": i, "matched": tp is not None,
                            "confidence": (tp or {}).get("confidence"),
                            "matched_candidate": None if vendor else (tp or {}).get("matched_candidate"),
                            "reasoning": (tp or {}).get("reasoning"), "work_dir": work, "run_family": fid,
                        }))

    # --- Qodo -----------------------------------------------------------------
    def build_qodo(self):
        raw = open(self.a.qodo_gt, "rb").read()
        if hashlib.sha256(raw).hexdigest() != QODO_GT_SHA256:
            raise SystemExit("--qodo-gt is not the pinned Qodo PR-Review-Bench file (sha256 mismatch)")
        gt = {r["pr_url_to_review"]: r for r in map(json.loads, raw.decode().splitlines()) if r}
        qset = json.load(open(os.path.join(HERE, "sets", "qodo-pr100.json")))["cases"]
        forks = {r["pr_url"]: r["tools"] for r in json.load(open(self.a.qodo_tools))}
        prs, issues = [], []
        for c in qset:
            g = gt[c["pr_url"]]
            prs.append(self.S({"pr_url": c["pr_url"], "instance_id": c["instance_id"], "repo": c["repo"],
                               "title": c.get("title"), **qodo_pr_commits(c),
                               "language": c.get("language"), "issues": len(g["issues"]),
                               **bench_repo_license(c["repo"], c.get("pr"))}))
            for i, x in enumerate(g["issues"]):
                issues.append(self.S({"pr_url": c["pr_url"], "issue_index": i, "title": x.get("title"),
                                      "description": x.get("description"), "file_path": x.get("file_path"),
                                      "start_line": x.get("start_line"), "end_line": x.get("end_line"),
                                      "problematic_code_snippet": x.get("problematic_code_snippet"),
                                      "rule_name": x.get("rule_name"), "functional": not x.get("rule_name")}))
        by_url = {c["pr_url"]: c for c in qset}
        reviews, verdicts = [], []
        for wdname, rename, run in QODO_PAPER:
            self._qodo_dir(self.rd(wdname + ".qodo"), wdname, rename, run, gt, by_url, forks, reviews, verdicts, True)
        done = {w + ".qodo" for w, _, _ in QODO_PAPER}
        for wd in self.all_runs():
            if ".qodo" in wd and wd not in done:
                self._qodo_dir(self.rd(wd), work_dir_name(wd, ".qodo"), {}, wd.split(".qodo")[0], gt, by_url, forks,
                               reviews, verdicts, False)
        self.tables["qodo_prs"], self.tables["qodo_issues"] = prs, issues
        self.tables["qodo_reviews"], self.tables["qodo_verdicts"] = reviews, verdicts

    def _qodo_dir(self, qdir: str, wd: str, rename: dict, run: str, gt: dict, by_url: dict, forks: dict,
                  reviews: list, verdicts: list, paper: bool):
        import qodo_judge
        jf = os.path.join(qdir, "judgements.jsonl")
        if not os.path.exists(jf):
            self.notes.append(f"qodo {wd}: no judgements.jsonl")
            return
        judge = "gpt-6.1-sol"
        jt = os.path.join(qdir, "judge", "JUDGE.txt")
        if not paper and os.path.exists(jt):
            judge = open(jt).read().split(",")[0].strip() or judge
        fid = self.family_id(os.path.basename(qdir))
        run_dir = self.rd(run)
        for j in qodo_effective(open(jf)):
            tool = j["tool"]
            vendor = tool in qodo_judge.VENDORS
            name = rename.get(tool, tool)
            url = j["pr"]
            if url not in gt:
                continue
            usd = mins = None
            iid = by_url[url]["instance_id"]
            if not vendor and os.path.isdir(os.path.join(run_dir, "cases", iid)):
                usd, mins = compare.usd_and_minutes(os.path.join(run_dir, "cases", iid))
            f = (forks.get(url) or {}).get(tool)
            cms = j.get("comments") or []
            reviews.append(self.S({
                "tool": name, "pr_url": url, "work_dir": wd, "vendor_link_only": vendor,
                "source_url": f"https://github.com/agentic-review-benchmarks/{f['fork']}/pull/{f['pr']}" if vendor and f else None,
                "comments": [{"index": k, "path": c.get("path"), "start": c.get("start"), "end": c.get("end"),
                              "body": None if vendor else c.get("body")} for k, c in enumerate(cms)],
                "n_comments": j["n_comments"], "cost_usd": usd, "minutes": mins, "judge": judge, "run_family": fid,
            }))
            iss = gt[url]["issues"]
            by_issue = {m["issue"]: m for m in j["matches"]}
            for i, x in enumerate(iss):
                m = by_issue.get(i)
                cm = cms[m["comment"]] if m and m["comment"] < len(cms) else None
                verdicts.append(self.S({
                    "tool": name, "pr_url": url, "work_dir": wd, "judge": judge, "issue_index": i,
                    "matched": m is not None, "comment_index": m["comment"] if m else None,
                    "located_n5": bool(cm) and qodo_judge.located(cm, x, 5),
                    "located_same_file": bool(cm) and qodo_judge.located(cm, x, float("inf")),
                    "why": m.get("why") if m else None, "run_family": fid,
                }))

    # --- pairwise Elo -----------------------------------------------------------
    def build_elo(self):
        """elo_judgments: every judgment line of every plan; elo_ratings: the
        ratings refit from the judgments (recompute/elo_ratings.py), per plan,
        table (each judge, and both pooled) and category."""
        sys.path.insert(0, os.path.join(HERE, "recompute"))
        import elo_ratings as ER
        rows, rats = [], []
        base = self.a.elo_dir
        self.elo_refits = {}
        for plan_name in sorted(os.listdir(base)) if base and os.path.isdir(base) else []:
            d = os.path.join(base, plan_name)
            pj = os.path.join(d, "plan.json")
            jd = os.path.join(d, "judgments")
            if not (os.path.isfile(pj) and os.path.isdir(jd)):
                continue
            plan = json.load(open(pj))
            labels = plan.get("labels") or {}
            judges = ER.R.rated_judges(plan)  # the plan's own rated judges (elo_rating.rated_judges)
            judgments = {j: ER.read_jsonl(os.path.join(jd, f"{j}.jsonl")) for j in judges}
            fin = ER.finals(judgments)
            used = {(j, r["id"], r["at"]) for j, by in fin.items() for r in by.values()}
            for f in sorted(os.listdir(jd)):
                if not f.endswith(".jsonl"):
                    continue
                stem = f[:-len(".jsonl")]
                for r in ER.read_jsonl(os.path.join(jd, f)):
                    v = r.get("verdict") or {}
                    cats = v.get("categories") or {}
                    row = {"plan": plan_name, "judgment_file": stem, "unit_id": r.get("id"), "round": r.get("round"),
                           "pr": r.get("pr"), "a": r.get("a"), "b": r.get("b"),
                           "a_label": labels.get(r.get("a")), "b_label": labels.get(r.get("b")),
                           "judge": r.get("judge") or stem, "judge_model": r.get("model"), "effort": r.get("effort"),
                           "at": r.get("at"), "status": r.get("status"), "prompt_sha256": r.get("prompt_sha256"),
                           "used_in_ratings": (stem, r.get("id"), r.get("at")) in used,
                           "overall_winner": (v.get("overall") or {}).get("winner"),
                           "overall_reasoning": (v.get("overall") or {}).get("reasoning"),
                           "error": r.get("error")}
                    for c in ER.CATEGORIES:
                        row[f"{c}_winner"] = (cats.get(c) or {}).get("winner")
                        row[f"{c}_reasoning"] = (cats.get(c) or {}).get("reasoning")
                    rows.append(self.S(row))
            if not any(judgments.values()):
                continue
            rat = ER.ratings(plan, judgments)
            self.elo_refits[plan_name] = rat
            for table in [j for j in judges if j in rat] + (["combined"] if "combined" in rat else []):
                for cat_name, t in [("overall", rat[table]["overall"])] + list(rat[table]["categories"].items()):
                    for r in t["rows"]:
                        rats.append(self.S({"plan": plan_name, "table": table, "category": cat_name,
                                            "run": r["player"], "label": labels.get(r["player"], r["player"]),
                                            "elo": r["elo"], "lo": r["lo"], "hi": r["hi"],
                                            "w": r["w"], "t": r["t"], "l": r["l"],
                                            "games": t["games"], "prs": t["prs"]}))
        self.tables["elo_judgments"], self.tables["elo_ratings"] = rows, rats

    # --- the answer key's build: candidate maps and PR sizes ---------------------
    def build_key_data(self):
        """aacr_candidates and pr_diffstats (key_data.py), from the `*-code`
        case dirs beside runs/; the run archive's key-data/ holds the same rows."""
        src = os.path.dirname(self.runs_dir)
        cands = [r for r in KD.candidate_rows(src) if r["instance_id"] in self.key]
        stats = [r for r in KD.diffstat_rows(src) if r["instance_id"] in self.key]
        for r in cands + stats:
            r["set"] = self.key[r["instance_id"]]["set"]
        self.tables["aacr_candidates"] = [self.S(r) for r in cands]
        self.tables["pr_diffstats"] = [self.S(r) for r in stats]

    # --- the run index -----------------------------------------------------------
    def build_runs(self):
        if self.cat is None:
            self.tables["runs"] = []
            return
        remap, evidence = RC.load_remap(getattr(self.a, "commit_remap", None))
        roots = {"runs": self.runs_dir, "top": os.path.dirname(self.runs_dir)}
        if self.om_runs:
            roots.update({"om-runs": self.om_runs, "om-top": os.path.dirname(self.om_runs)})
        recorded: dict = {}
        rows = RC.index_rows(self.cat, roots, remap, lambda fid: [f"quickreview-runs-{fid}.tar.zst"], recorded,
                             evidence)
        for r in rows:
            # a Martian scoring dir's judge, from its own record (the family's `judges` names it only)
            if ".martian" in r["unit"]:
                got = martian_judge_settings(self.unit_dir(r["path"], roots))
                if got:
                    r["judges"] = f"{r['judges']}. This scoring dir: {got}" if r.get("judges") else got
        self.tables["runs"] = [self.S({k: v for k, v in r.items()}) for r in rows]
        # the recorded build ids, never published, by the row's published path: the validation
        # checks every published commit and its flags against them (RC.commit_problems)
        self.commits = ({scrub(k): v for k, v in recorded.items()}, remap, evidence)

    # --- checks that need the run dirs ---------------------------------------------
    def raw_text_checks(self, t: dict[str, list[dict]]) -> list[dict]:
        """Every written review's `raw_text`, in order, against the comments read again from the run's
        files (archive_texts) through the same scrub; a link-only arm's is withheld (null)."""
        bad = []
        for r in t["reviews"]:
            src = self.review_src.get((r["arm_id"], r["instance_id"]))
            got = [c["raw_text"] for c in r["comments"] or []]
            if r["source_url"] is not None:  # link-only: the vendor's text is not redistributed
                want = [None] * len(got)
            else:
                want = [scrub(x) for x in archive_texts(self.rd(src), r["instance_id"])] if src else []
            if got != want:
                bad.append(f"{r['arm_id']}/{r['instance_id']}")
        # MUTATION: write the judge's `text` (or raw.strip()) as raw_text in _comment — this fails
        return [{"check": "reviews: every comment's raw_text is the run's text (result row content, deleted-line "
                          "body) as the archive holds it, after the release's rewrite", "got": bad[:20],
                 "want": [], "ok": not bad}]

    # --- the claims each arm and run backs, from the manifest's q keys ------------
    def link_claims(self):
        """`arms.paper_tables` and `runs.claims` are the claim groups whose q keys read the arm or the
        run (claim_links), and nothing else: no hand-written label is a source. `arms.in_paper` is true
        for any arm a claim reads."""
        manifest = json.load(open(CLAIMS_MANIFEST))
        martian = {s["work_dir"] for s in self.tables.get("martian_scores") or [] if s.get("work_dir")}
        by_arm, by_unit = claim_links(manifest["claims"], self.tables["arms"], self.tables.get("runs") or [], martian,
                                      manifest.get("checks"))
        for a in self.tables["arms"]:
            a["paper_tables"] = sorted(by_arm.get(a["arm_id"], set()))
            a["in_paper"] = bool(a["paper_tables"])
        for r in self.tables.get("runs") or []:
            r["claims"] = sorted(by_unit.get(r["unit"], set()))

    # --- every table holds only the families the catalogue gives it --------------
    def filter_by_family(self):
        """Drop rows of a run family whose catalogue entry does not list the
        table (e.g. a family whose reviews are a copy of another run's);
        rows with no family (the key, the goldens, published scores) stay."""
        if self.cat is None:
            return
        dropped = collections.Counter()
        for name in ("reviews", "defect_verdicts", "comment_verdicts", "aacr_matches", "martian_reviews",
                     "martian_verdicts", "martian_scores", "qodo_reviews", "qodo_verdicts"):
            keep = []
            for r in self.tables.get(name, []):
                fid = r.get("run_family")
                if fid and name not in RC.Catalogue.hf_tables(self.cat.families.get(fid)):
                    dropped[(name, fid)] += 1
                    continue
                keep.append(r)
            self.tables[name] = keep
        for (name, fid), n in sorted(dropped.items()):
            self.notes.append(f"{name}: {n} rows of {fid} left out (the catalogue gives that family no {name} rows)")


MARTIAN_PAPER = [("final1-martian50", {"quickreview": "quickreview-frozen"}),
                 ("final1-ocr-martian50", {}), ("final1-pragent-martian50", {}), ("final1-opencode-martian50", {})]
QODO_PAPER = [("ext-r6-qodo-pr100", {"quickreview": "quickreview-2026-10-02"}, "ext-r6-qodo-pr100"),
              ("final1-qodo-pr100", {"quickreview": "quickreview-frozen"}, "final1-qodo-pr100"),
              ("final1-ocr-qodo-pr100", {}, "final1-ocr-qodo-pr100"),
              ("final1-opencode-qodo-pr100", {}, "final1-opencode-qodo-pr100"),
              ("final1-pragent-qodo-pr100", {}, "final1-pragent-qodo-pr100")]
MARTIAN_PAPER_DIRS = {w for w, _ in MARTIAN_PAPER}


def work_dir_name(scoring_dir: str, suffix: str) -> str:
    """A scoring dir's `work_dir`: the review run's name for `<run><suffix>`
    (the 10-05 spelling), the whole dir name for a variant such as
    `<run><suffix>-rescore`, so two scorings of one run never share a name."""
    base, _, rest = scoring_dir.partition(suffix)
    return base if rest == "" else scoring_dir
QODO_PAPER_DIRS = {w for w, _, _ in QODO_PAPER}


# SPDX per reviewed repo. Code excerpts in `defects`
# (evidence, sites) stay under these licences.
_L = {
    "Apache-2.0": "ClickHouse/ClickHouse alibaba/spring-ai-alibaba cline/cline dbeaver/dbeaver gofr-dev/gofr "
                  "google-gemini/gemini-cli infiniflow/ragflow juspay/hyperswitch kestra-io/kestra keycloak/keycloak "
                  "linera-io/linera-protocol microsoft/typescript-go openai/codex opencv/opencv vllm-project/vllm "
                  "wavetermdev/waveterm",
    "MIT": "PowerShell/PowerShell bitcoin/bitcoin browser-use/browser-use dotnet/aspnetcore electron/electron "
           "facebook/react filamentphp/filament langflow-ai/langflow laravel/framework lvgl/lvgl microsoft/PowerToys "
           "microsoft/semantic-kernel mrdoob/three.js mudler/LocalAI nodejs/node ollama/ollama ppy/osu "
           "sveltejs/svelte symfony/symfony",
    "MIT OR Apache-2.0": "astral-sh/uv unionlabs/union",
    "BSD-3-Clause": "appwrite/appwrite valkey-io/valkey",
    "Zlib": "libsdl-org/SDL",
    "LGPL-2.0-or-later": "FreeCAD/FreeCAD",
    "GPL-2.0-or-later": "mpv-player/mpv",
    "GPL-3.0": "comfyanonymous/ComfyUI",
    "AGPL-3.0-or-later": "bluewave-labs/Checkmate immich-app/immich nextcloud/server",
}
REPO_LICENSES = {r: (lic, "") for lic, rs in _L.items() for r in rs.split()}
REPO_LICENSES.update({
    "mpv-player/mpv": ("GPL-2.0-or-later", "LGPL-2.1-or-later build option; both texts shipped"),
    "CherryHQ/cherry-studio": ("LicenseRef-cherry-studio", "source-available: user-segmented AGPL-3.0 / commercial dual licence"),
    "n8n-io/n8n": ("LicenseRef-Sustainable-Use-1.0", "source-available: Sustainable Use License 1.0"),
    "elastic/elasticsearch": ("AGPL-3.0-only OR SSPL-1.0 OR Elastic-2.0", "source-available: x-pack/ is Elastic-2.0 only"),
    "timescale/timescaledb": ("Apache-2.0 AND LicenseRef-Timescale", "source-available: tsl/ is under the Timescale License"),
})


# The Martian and Qodo PRs' repositories (forks keep their upstream's licence): the upstream
# project's declared licence, SPDX where one exists. Recorded from each upstream project's own
# licence statement, not re-read at each PR's commit, except where BENCH_PR_LICENSES gives the PR's
# own; `*_license_note` says what to check.
BENCH_REPO_LICENSES = {
    "ai-code-review-evaluation/discourse-graphite": ("GPL-2.0-or-later", "fork of discourse/discourse"),
    "calcom/cal.com": ("AGPL-3.0-only", "source-available parts: the `ee` directories are under cal.com's commercial licence"),
    "grafana/grafana": ("AGPL-3.0-only", ""),
    "keycloak/keycloak": ("Apache-2.0", ""),
    "ai-code-review-evaluation/keycloak-greptile": ("Apache-2.0", "fork of keycloak/keycloak"),
    "getsentry/sentry": ("LicenseRef-FSL-1.1-Apache-2.0", "source-available: Functional Source License 1.1, Apache-2.0 future licence"),
    "ai-code-review-evaluation/sentry-greptile": ("LicenseRef-FSL-1.1-Apache-2.0", "fork of getsentry/sentry; source-available"),
    "agentic-review-benchmarks/Ghost": ("MIT", "fork of TryGhost/Ghost"),
    "agentic-review-benchmarks/aspnetcore": ("MIT", "fork of dotnet/aspnetcore"),
    "agentic-review-benchmarks/cal.com": ("AGPL-3.0-only", "fork of calcom/cal.com; the `ee` directories are under cal.com's commercial licence"),
    "agentic-review-benchmarks/dify": ("LicenseRef-Dify-Open-Source", "fork of langgenius/dify: Apache-2.0 with additional conditions"),
    "agentic-review-benchmarks/firefox-ios": ("MPL-2.0", "fork of mozilla-mobile/firefox-ios"),
    "agentic-review-benchmarks/prefect": ("Apache-2.0", "fork of PrefectHQ/prefect"),
    # the fork's licence changed between its PRs: no repository-wide licence, each PR's is in
    # BENCH_PR_LICENSES (a PR missing there gets none, and the validation's licence check fails)
    "agentic-review-benchmarks/redis": (None, "fork of redis/redis; the licence differs by PR"),
    "agentic-review-benchmarks/tauri": ("Apache-2.0 OR MIT", "fork of tauri-apps/tauri"),
}

# Per-PR licences, read from the repository's LICENSE file at each PR's head commit
# (`qodo_prs.head_commit`); they override BENCH_REPO_LICENSES. RSALv2 has no SPDX id.
_REDIS = "agentic-review-benchmarks/redis"
_REDIS8 = ("LicenseRef-RSALv2 OR SSPL-1.0 OR AGPL-3.0-only",
           "fork of redis/redis; read from LICENSE.txt at the PR's head commit: the Redis 8 tri-licence "
           "(RSALv2, SSPLv1 or AGPLv3; code from 7.2 and earlier stays BSD-3-Clause)")
_REDIS74 = ("LicenseRef-RSALv2 OR SSPL-1.0",
            "fork of redis/redis; read from LICENSE.txt at the PR's head commit: the 7.4 dual licence "
            "(RSALv2 or SSPLv1)")
BENCH_PR_LICENSES = {**{(_REDIS, n): _REDIS8 for n in (1, 2, 3, 4, 5, 6, 7, 9)}, (_REDIS, 8): _REDIS74}


def bench_repo_license(repo: str | None, pr: int | None = None) -> dict:
    lic, note = BENCH_PR_LICENSES.get((repo or "", pr)) or BENCH_REPO_LICENSES.get(repo or "", (None, "not recorded"))
    return {"repo_license": lic, "repo_license_note": note}


def qodo_pr_commits(case: dict) -> dict:
    """A Qodo case's commits as published: the real GitHub commits whose trees the run reviewed
    (the head, and the merge-base the PR's change is taken against), and the harness's replay ids.

    The case set's `base_commit` / `head_commit` are leak-proof replay commits (ext/gitmeta.py
    leakproof_ids: the same trees under a synthetic author, date and message, so the reviewer could
    not read the PR's history). They never existed on GitHub; the run files and case dir names
    (`<repo>@<short replay head>`) carry them, so they stay, as `replay_*`, for the join."""
    lp = case.get("leakproof") or {}
    return {"base_commit": lp.get("source_merge_base"), "head_commit": lp.get("source_head"),
            "replay_base_commit": case.get("base_commit"), "replay_head_commit": case.get("head_commit")}


def replay_commit_problems(rows: list[dict], replay_ids: set[str]) -> int:
    """Rows that publish a replay id as `base_commit` or `head_commit`, or miss a real or a replay
    commit. `replay_ids` are every case set's replay ids (and each row's own replay columns count)."""
    bad = 0
    for r in rows:
        real = (r.get("base_commit"), r.get("head_commit"))
        replay = (r.get("replay_base_commit"), r.get("replay_head_commit"))
        if not all(real) or not all(replay) or any(x in replay_ids or x in replay for x in real):
            bad += 1
    return bad


def set_replay_ids() -> set[str]:
    """The replay ids of every case set built leak-proof (a `leakproof` block)."""
    out = set()
    for f in glob.glob(os.path.join(HERE, "sets", "*.json")):
        d = json.load(open(f))
        for c in (d.get("cases") or []) if isinstance(d, dict) else []:
            if isinstance(c, dict) and c.get("leakproof"):
                out.update(x for x in (c.get("base_commit"), c.get("head_commit")) if x)
    return out


# ---------------------------------------------------------------------------
# Writing, validation, card
# ---------------------------------------------------------------------------

CONFIGS = ["defects", "exclusions", "prs", "aacr_references", "aacr_reference_labels", "arms", "reviews",
           "defect_verdicts", "comment_verdicts", "aacr_matches", "martian_prs", "martian_goldens",
           "martian_reviews", "martian_verdicts", "martian_scores", "qodo_prs", "qodo_issues", "qodo_reviews",
           "qodo_verdicts", "elo_judgments", "elo_ratings", "runs", "aacr_candidates", "pr_diffstats"]


def load_counts(out: str, configs: list[str] | None = None) -> dict[str, int]:
    """Each config's rows as `datasets.load_dataset` reads the folder, through a cache made for this call:
    the loader's default cache is keyed by the folder's name and the card's file patterns, not the files,
    so an earlier export to the same path would answer with its own rows (and its own columns)."""
    import datasets
    with tempfile.TemporaryDirectory(prefix="hf-load-") as cache:
        return {n: datasets.load_dataset(out, n, split="test", cache_dir=cache).num_rows for n in configs or CONFIGS}


def write_parquet(tables: dict[str, list[dict]], out: str) -> dict[str, int]:
    import pyarrow as pa
    import pyarrow.parquet as pq
    os.makedirs(os.path.join(out, "data"), exist_ok=True)
    sizes = {}
    for name in CONFIGS:
        rows = tables[name]
        # every key of every row, in first-seen order (from_pylist would take
        # the first row's keys only), each column's type inferred over all rows
        keys = list(dict.fromkeys(k for r in rows for k in r))
        t = pa.table({k: pa.array([r.get(k) for r in rows]) for k in keys})
        # A column every row leaves null has no type; make it a string column.
        for i, f in enumerate(t.schema):
            if pa.types.is_null(f.type):
                t = t.set_column(i, f.name, pa.array([None] * len(t), pa.string()))
        p = os.path.join(out, "data", f"{name}.parquet")
        pq.write_table(t, p, compression="zstd")
        sizes[name] = len(rows)
    return sizes


def read_parquet(out: str) -> dict[str, list[dict]]:
    import pyarrow.parquet as pq
    return {n: pq.read_table(os.path.join(out, "data", f"{n}.parquet")).to_pylist() for n in CONFIGS}


def approx(a, b, tol):
    return a is not None and abs(a - b) <= tol


def validate(t: dict[str, list[dict]]) -> list[dict]:
    """Recompute the papers' counts and headline numbers from the written tables."""
    checks = []

    def check(what, got, want, tol=0.0):
        ok = approx(got, want, tol) if tol else got == want
        checks.append({"check": what, "got": got, "want": want, "ok": bool(ok)})

    defects = {(d["instance_id"], d["defect_id"]): d["severity"] for d in t["defects"]}
    sev = collections.Counter(defects.values())
    check("defects", len(t["defects"]), 520)
    check("defects high/medium/low", f"{sev['high']}/{sev['medium']}/{sev['low']}", "90/145/285")
    check("exclusions", len(t["exclusions"]), 3093)
    check("PRs", len(t["prs"]), 185)
    check("AACR references on the 185 PRs", len(t["aacr_references"]), 1418)
    check("bot-derived references", sum(r["bot_derived"] for r in t["aacr_references"]), 80)
    check("labelled references (30 PRs)", len(t["aacr_reference_labels"]), 253)
    indep = sum(1 for d in t["defects"] if d["provenance_hunt"] or d["provenance_dataset_refs"])
    check("defects raised by the hunt or an AACR reference", indep, 369)
    s40 = {p["instance_id"] for p in t["prs"] if p["in_s40"]}
    check("S40 PRs", len(s40), 40)
    check("S40 defects", sum(1 for k in defects if k[0] in s40), 115)

    by_arm = collections.defaultdict(list)
    for r in t["reviews"]:
        by_arm[r["arm_id"]].append(r)
    dv = collections.defaultdict(list)
    for r in t["defect_verdicts"]:
        dv[(r["arm_id"], r["judge"])].append(r)
    cvs = collections.defaultdict(list)
    for r in t["comment_verdicts"]:
        cvs[(r["arm_id"], r["judge"])].append(r)

    def arm(aid, judge="gpt-6-sol-high", prs=None):
        return defect_summary(dv[(aid, judge)], defects, prs)

    def corr(aid, judge="gpt-6-sol-high", prs=None):
        return correct_share([c for c in cvs[(aid, judge)] if prs is None or c["instance_id"] in prs])

    def money(aid, prs=None):
        rs = [r for r in by_arm[aid] if prs is None or r["instance_id"] in prs]
        c = [r["cost_usd"] for r in rs if r["judged"] and r["cost_usd"] is not None]
        m = [r["minutes"] for r in rs if r["judged"] and r["minutes"]]
        return (statistics.mean(c) if c else 0.0), (statistics.median(m) if m else 0.0)

    # benchmark.tex tab:final + tab:finalbuild (found, high, medium, low, correct, $/PR, median min)
    final = {
        "quickreview-frozen": (461, 87.5, 134.5, 239, 0.92, 2.06, 17.5),
        "quickreview-default-g61": (409, 83.5, 121, 204.5, 0.95, 1.36, 9.5),
        "quickreview-low-g61": (365.5, 79.5, 104.5, 181.5, 0.94, 0.88, 6.7),
        "pireview-panel-high-g61": (347.5, 80, 119, 148.5, 0.89, 0.27, 1.8),
        "claude-code-opus55": (324.5, 72.5, 105, 147, 0.81, 0.20, 0.7),
        "ocr-high-g61": (298.5, 63.5, 102, 133, 0.86, 0.53, 1.8),
        "codex-high-g61": (287, 81, 101.5, 104.5, 0.93, 0.14, 2.1),
        "opencode-native-pr-g61": (263.5, 76, 99, 88.5, 0.93, 0.17, 2.3),
        "pragent-g61": (194, 55.5, 70, 68.5, 0.76, 0.07, 1.9),
    }
    for aid, (f, h, m, lo, c, usd, mins) in final.items():
        s = arm(aid)
        check(f"{aid}: reviews", len(by_arm[aid]), 185)
        check(f"{aid}: judged", sum(r["judged"] for r in by_arm[aid]), 185)
        check(f"{aid}: found/520", s["found"], f, 0.001)
        check(f"{aid}: high/medium/low", f"{s['high']:g}/{s['medium']:g}/{s['low']:g}", f"{h:g}/{m:g}/{lo:g}")
        check(f"{aid}: comments correct", round(corr(aid), 2), c, 0.005)
        mu, md = money(aid)
        check(f"{aid}: $/PR", round(mu, 2), usd, 0.006)
        check(f"{aid}: median min/PR", round(md, 1), mins, 0.06)
    # tab:finalbuild by set
    by_set = collections.defaultdict(set)
    for p in t["prs"]:
        by_set[p["set"]].add(p["instance_id"])
    for aid, (r145, val, out) in {"quickreview-frozen": (356, 59.5, 45.5), "quickreview-default-g61": (321, 49.5, 38.5),
                                  "pireview-panel-high-g61": (270, 38, 39.5)}.items():
        check(f"{aid}: rest145 found/394", arm(aid, prs=by_set["rest145"])["found"], r145, 0.001)
        check(f"{aid}: smoke10+dev10 found/71", arm(aid, prs=by_set["smoke10"] | by_set["dev10"])["found"], val, 0.001)
        check(f"{aid}: holdout10+fresh10 found/55", arm(aid, prs=by_set["holdout10"] | by_set["fresh10"])["found"], out, 0.001)
    # tab:sol-summary — primary and second judge
    sol = {
        "quickreview-default-sol-rerun": (436, 85, 0.88, None, None),
        "quickreview-default-sol": (437.5, 86, 0.86, 439, 0.86),
        "quickreview-low-sol": (345, 75, 0.80, 345.5, 0.82),
        "claude-code-opus55": (324.5, 72.5, 0.81, 321.5, 0.86),
        "pireview-medium-sol": (292.5, 71.5, 0.79, 289.5, 0.79),
        "ocr-medium-sol": (291.5, 64.5, 0.73, 291, 0.77),
        "opencode-bridge-sol": (250, 64.5, 0.55, 249.5, 0.55),
        "codex-medium-sol": (248.5, 70, 0.69, 247, 0.69),
    }
    for aid, (f, h, c, f2, c2) in sol.items():
        s = arm(aid)
        check(f"{aid}: found/520 (primary)", s["found"], f, 0.001)
        check(f"{aid}: high (primary)", s["high"], h, 0.001)
        check(f"{aid}: comments correct (primary)", round(corr(aid), 2), c, 0.005)
        if f2 is not None:
            check(f"{aid}: found/520 (second judge)", arm(aid, "claude-opus-5-5")["found"], f2, 0.001)
            check(f"{aid}: comments correct (second judge)", round(corr(aid, "claude-opus-5-5"), 2), c2, 0.005)
    # judge agreement over the 7 earlier-study arms (benchmark.tex §judge)
    seven = ["quickreview-default-sol", "quickreview-low-sol", "claude-code-opus55", "pireview-medium-sol",
             "ocr-medium-sol", "opencode-bridge-sol", "codex-medium-sol"]
    same = n = 0
    for aid in seven:
        p = {(r["instance_id"], r["defect_id"]): r["verdict"] for r in dv[(aid, "gpt-6-sol-high")]}
        q = {(r["instance_id"], r["defect_id"]): r["verdict"] for r in dv[(aid, "claude-opus-5-5")]}
        for k in defects:
            n += 1
            same += p.get(k, "missed") == q.get(k, "missed")
    check("two judges: same verdict (7 reviewers x 520)", f"{same}/{n}", "3593/3640")
    sc_reviews = {(r["arm_id"], r["instance_id"]) for r in t["reviews"] if "gpt-6-sol-high-repeat" in r["judged_by"]}
    check("self-consistency re-judge: reviews", len({k for k in sc_reviews if k[0] in seven}), 210)
    check("self-consistency re-judge: defect pairs",
          sum(1 for aid in seven for _ in dv[(aid, "gpt-6-sol-high-repeat")]), 637)
    # base models (quickreview.tex tab:bm185 / tab:bm40) and stability
    check("quickreview-luna: found/520", arm("quickreview-luna")["found"], 147, 0.001)
    forty = {r["instance_id"] for r in by_arm["quickreview-opus55"]}
    check("quickreview-opus55: PRs", len(forty), 40)
    check("quickreview-opus55: found/126", arm("quickreview-opus55", prs=forty)["found"], 119.5, 0.001)
    eight = {r["instance_id"] for r in by_arm["quickreview-stab-r1"]}
    for k, f in zip(range(1, 5), (11, 14, 12.5, 11.5)):
        check(f"quickreview-stab-r{k}: found/17", arm(f"quickreview-stab-r{k}", prs=eight)["found"], f, 0.001)
    check("stability: defects on the 8 PRs", sum(1 for d in defects if d[0] in eight), 17)
    # Copilot 2025 (tab:copilot2025)
    cp = {r["instance_id"] for r in by_arm["copilot-2025-upstream"]}
    check("copilot-2025-upstream: PRs", len(cp), 19)
    check("copilot-2025-upstream: found/59", arm("copilot-2025-upstream", prs=cp)["found"], 6.5, 0.001)
    check("copilot-2025-upstream: comment text withheld",
          all(c["text"] is None for r in by_arm["copilot-2025-upstream"] for c in r["comments"]), True)
    # best-shot S40 (tab:bestshot, tab:transfer)
    for aid, f in {"pireview-high-sol-s40": 71, "pireview-prtext-sol-s40": 72.5, "pireview-panel-sol-s40": 78,
                   "ocr-high-sol-s40": 78, "ocr-prtext-sol-s40": 78, "opencode-native-sol-s40": 57,
                   "opencode-native-pr-sol-s40": 69.5, "codex-high-sol-s40": 64, "codex-prtext-sol-s40": 62.5,
                   "pragent-sol-s40": 34.5, "pragent-g61-s40": 39.5}.items():
        check(f"{aid}: found/115", arm(aid, prs=s40)["found"], f, 0.001)
    for aid, f in {"quickreview-default-sol": 98.5, "quickreview-default-sol-rerun": 103, "quickreview-default-g61": 98,
                   "quickreview-low-sol": 77.5, "claude-code-opus55": 68.5, "pireview-medium-sol": 59.5,
                   "ocr-medium-sol": 76, "opencode-bridge-sol": 49, "codex-medium-sol": 51,
                   "pireview-panel-high-g61": 80, "ocr-high-g61": 75.5, "opencode-native-pr-g61": 57.5,
                   "codex-high-g61": 64.5, "quickreview-low-g61": 86.5}.items():
        check(f"{aid}: found on S40/115", arm(aid, prs=s40)["found"], f, 0.001)
    # AACR-Bench's own metric (tab:aacr): references found, comments, F1
    refs_by_pr = collections.Counter(r["instance_id"] for r in t["aacr_references"])
    total_refs = sum(refs_by_pr.values())
    for aid, (fnd, comments, f1) in {"quickreview-default-g61": (151.7, 999, 0.125),
                                     "quickreview-low-g61": (127.3, 801, 0.115),
                                     "pireview-panel-high-g61": (84.7, 583, 0.085),
                                     "claude-code-opus55": (81.0, 407, 0.089),
                                     "ocr-high-g61": (115.3, 570, 0.116), "codex-high-g61": (68.7, 343, 0.078),
                                     "opencode-native-pr-g61": (61.3, 354, 0.069), "pragent-g61": (86.0, 404, 0.094)}.items():
        found = sum(m["match_share"] for m in t["aacr_matches"] if m["arm_id"] == aid)
        gen = sum(r["aacr_scored_comments"] or 0 for r in by_arm[aid])
        check(f"{aid}: AACR references found/1418", round(found, 1), fnd, 0.051)
        check(f"{aid}: AACR scored comments", gen, comments)
        check(f"{aid}: AACR F1", round(rpf(found, total_refs, gen)[2], 3), f1, 0.0006)
    # Martian (tab:martianfinal, tab:martianaudit)
    gold = {(g["pr_url"], g["golden_index"]): g for g in t["martian_goldens"]}
    b = collections.Counter(g["audit_bucket"] for g in gold.values())
    check("martian goldens", len(gold), 173)
    check("martian audit real/notreal/disputed", f"{b['real']}/{b['notreal']}/{b['disputed']}", "86/77/10")
    for tool, real in {"quickreview-frozen": 75, "open-code-review": 67, "pr-agent": 46, "opencode": 48}.items():
        got = sum(1 for v in t["martian_verdicts"] if v["tool"] == tool and v["matched"]
                  and v["work_dir"] in MARTIAN_PAPER_DIRS
                  and gold[(v["pr_url"], v["golden_index"])]["audit_bucket"] == "real")
        check(f"martian {tool}: real goldens found/86", got, real)
    for tool, (matched, p, r) in {"quickreview-frozen": (104, 0.162, 0.658), "open-code-review": (93, 0.267, 0.589)}.items():
        s = next(x for x in t["martian_scores"] if x["tool"] == tool and x["judge"] == "gpt-6.1-sol"
                 and x["work_dir"] in MARTIAN_PAPER_DIRS)
        check(f"martian {tool}: Core matched/158", s["core_tp"], matched)
        check(f"martian {tool}: Core P", s["core_precision"], p, 0.0006)
        check(f"martian {tool}: Core R", s["core_recall"], r, 0.0006)
    for tool, (usd, mins) in {"quickreview-frozen": (2.84, 26.1), "open-code-review": (0.86, 3.3),
                              "pr-agent": (0.09, 1.4), "opencode": (0.19, 2.4)}.items():
        rs = [x for x in t["martian_reviews"] if x["tool"] == tool and x["work_dir"] in MARTIAN_PAPER_DIRS]
        check(f"martian {tool}: $/PR", round(statistics.mean(x["cost_usd"] for x in rs if x["cost_usd"] is not None), 2), usd, 0.006)
        check(f"martian {tool}: mean min/PR", round(statistics.mean(x["minutes"] for x in rs if x["minutes"]), 1), mins, 0.06)
    check("martian vendor comment text withheld",
          all(not r["comments"] and r["unmatched_candidates"] is None for r in t["martian_reviews"] if r["vendor_link_only"]), True)
    # Qodo (tab:qodo)
    issues = {(x["pr_url"], x["issue_index"]): x for x in t["qodo_issues"]}
    check("qodo issues", len(issues), 580)
    check("qodo functional / rule", f"{sum(x['functional'] for x in issues.values())}/{sum(not x['functional'] for x in issues.values())}", "309/271")
    qrev = collections.defaultdict(int)
    for r in t["qodo_reviews"]:
        if r["work_dir"] in QODO_PAPER_DIRS:
            qrev[r["tool"]] += r["n_comments"]
    want = {"qodo-exhaustive": 51.5, "qodo-precise": 47.0, "augment": 41.2, "quickreview-frozen": 40.9,
            "opencode": 40.0, "copilot": 39.1, "greptile": 37.7, "cursor": 36.6, "open-code-review": 35.2,
            "quickreview-2026-10-02": 34.9, "codex": 34.6, "pr-agent": 34.5, "sentry": 21.6, "coderabbit": 21.6}
    for tool, f1 in want.items():
        vs = [v for v in t["qodo_verdicts"] if v["tool"] == tool and v["work_dir"] in QODO_PAPER_DIRS]
        tp = sum(v["located_n5"] for v in vs)
        func = sum(v["located_n5"] for v in vs if issues[(v["pr_url"], v["issue_index"])]["functional"])
        r, p, f = rpf(tp, len(issues), qrev[tool])
        check(f"qodo {tool}: F1 (N=5)", round(100 * f, 1), f1, 0.051)
        if tool == "quickreview-frozen":
            check("qodo quickreview-frozen: functional recall", round(100 * func / 309, 1), 52.1, 0.051)
    for tool, (usd, mins) in {"quickreview-frozen": (2.48, 19.6), "open-code-review": (0.46, 1.9),
                              "opencode": (0.20, 2.3), "pr-agent": (0.10, 1.2)}.items():
        rs = [x for x in t["qodo_reviews"] if x["tool"] == tool and x["work_dir"] in QODO_PAPER_DIRS]
        check(f"qodo {tool}: $/PR", round(statistics.mean(x["cost_usd"] for x in rs if x["cost_usd"] is not None), 2), usd, 0.006)
        check(f"qodo {tool}: mean min/PR", round(statistics.mean(x["minutes"] for x in rs if x["minutes"]), 1), mins, 0.06)
    check("qodo vendor comment text withheld",
          all(c["body"] is None for r in t["qodo_reviews"] if r["vendor_link_only"] for c in r["comments"]), True)
    return checks


# README "Other models" (judge gpt-6.1-sol-high): found of 520, $ per PR
OPEN_MODEL_ROWS = {"quickreview-glm-53-flash": (435, 0.52), "quickreview-deepseek-v41-flash": (451.5, 0.74)}
# README "Judged side by side": the pooled Elo of three configurations, games, judges' agreement
ELO_PLAN = "martian-hard20-all-gpt"
ELO_README = {"ccvq-hard20-qr-opus55": 1628, "ccvq-hard20-cc-high-opus55": 1518, "ccvq-hard20-sonnet": 1666}
ELO_JUDGES = ("claude-opus-5-5", "gpt-6.1-sol")  # the two judges the README's Elo pools (elo_judgments.judge_model)
EXT_JUDGE = "gpt-6.1-sol"  # the one judge of every Martian and Qodo verdict row


# tables a family may list in the catalogue yet hold no rows of, for a reason
# the data shows: AACR-Bench's own metric exists only for runs the AACR harness
# scored; a Martian or Qodo review row exists only for a run that has a scoring
# dir. Their per-family counts are reported in `coverage`, not checked.
COVERAGE_REPORT_ONLY = ("aacr_matches", "martian_reviews", "qodo_reviews")


def coverage(t: dict[str, list[dict]], cat) -> dict:
    """family -> table -> rows, for every table the catalogue gives the family."""
    out = {}
    if cat is None:
        return out
    for f in cat.shipped_families():
        for table in RC.Catalogue.hf_tables(f):
            rows = t.get(table) or []
            if table == "runs":
                n = sum(1 for r in rows if r["family"] == f["id"])
            elif table == "arms":
                n = sum(1 for r in rows if f["id"] in (r.get("run_family") or "").split(", "))
            elif table.startswith("elo_") or not rows or "run_family" not in rows[0]:
                n = len(rows)  # a table no run family owns (the key, the Elo runs)
            else:
                n = sum(1 for r in rows if r.get("run_family") == f["id"])
            out.setdefault(f["id"], {})[table] = n
    return out


def judge_coverage_checks(t: dict[str, list[dict]]) -> list[dict]:
    """The card's "Judges" section, checked against the tables: the second
    judge and the primary judge's re-run scored the earlier gpt-6-sol study's
    seven arms and nothing else; every Martian and Qodo verdict has the one
    judge; the Elo ratings pool exactly the two named judges; and `arms.judges`
    names exactly the judges with verdict rows for the arm."""
    checks = []

    def check(what, got, want):
        checks.append({"check": what, "got": got, "want": want, "ok": got == want})

    seven = sorted(SOL_IDS.values())
    scored = collections.defaultdict(set)
    for name in ("defect_verdicts", "comment_verdicts"):
        for r in t.get(name) or []:
            scored[r["judge"]].add(r["arm_id"])
    check("judges: arms the second judge (claude-opus-5-5) scored", sorted(scored[jlabel(SECOND)]), seven)
    check("judges: arms the primary judge's re-run scored", sorted(scored[jlabel(SELFCONS)]), seven)
    for name in ("martian_verdicts", "qodo_verdicts"):
        check(f"judges: {name} judges", sorted({r["judge"] for r in t.get(name) or []}), [EXT_JUDGE])
    used = {(r["plan"], r["judge_model"]) for r in t.get("elo_judgments") or [] if r["used_in_ratings"]}
    check(f"judges: elo {ELO_PLAN} judges in the ratings", sorted(m for p, m in used if p == ELO_PLAN), list(ELO_JUDGES))
    wrong = [a["arm_id"] for a in t.get("arms") or []
             if sorted(a["judges"] or []) != sorted(j for j, arms in scored.items() if a["arm_id"] in arms)]
    check("judges: arms.judges == the judges with verdict rows for the arm", wrong, [])
    return checks


# what the answer key's case dirs record of the PRs: the merge base differs from `base_commit` on 150
MERGE_BASE_DIFFERS = 150
SHA1 = re.compile(r"^[0-9a-f]{40}$")
# a review that prints QuickReview's own footer (`_P1 · confidence …_`, `_(P1/0.99, …)_`)
QR_STYLED = re.compile(r"_\(?P\d(?: · confidence |/)\d")
# Martian's profiles: the golden categories each leaves out (claim_metrics.PROFILES, its scorer's Core and Strict)
MARTIAN_PROFILES = {"all": frozenset(), "core": frozenset({"style", "speculative"}),
                    "strict": frozenset({"style", "speculative", "doc_defect", "test_gap", "perf"})}


def martian_score_problems(t: dict[str, list[dict]]) -> list[str]:
    """Every scoring dir's own score row (not Martian's published ones) whose tp/fp/fn under each
    profile differ from the counts of its per-golden verdicts and its reviews' false positives."""
    cat = {(g["pr_url"], g["golden_index"]): g["category"] for g in t["martian_goldens"]}
    hit, prs, fp = collections.defaultdict(set), collections.defaultdict(set), collections.Counter()
    for v in t["martian_verdicts"]:
        if v["matched"]:
            hit[(v["work_dir"], v["tool"], v["judge"])].add((v["pr_url"], v["golden_index"]))
    for r in t["martian_reviews"]:
        k = (r["work_dir"], r["tool"], r["judge"])
        prs[k].add(r["pr_url"])
        fp[k] += r["fp"] or 0
    bad = []
    for s in t["martian_scores"]:
        k = (s["work_dir"], s["tool"], s["judge"])
        if k not in prs:
            continue  # no review rows (Martian's published scores; a family whose reviews do not ship)
        for p, out in MARTIAN_PROFILES.items():
            tp = sum(1 for h in hit[k] if cat[h] not in out)
            fn = sum(1 for (u, _), c in cat.items() if u in prs[k] and c not in out) - tp
            if (tp, fp[k], fn) != (s[f"{p}_tp"], s[f"{p}_fp"], s[f"{p}_fn"]):
                bad.append(f"{k[0]}|{k[1]}@{k[2]} {p}")
    return bad


def _footer_conf(line: str) -> bool:
    return bool(re.search(r"confidence \d", line)) and ("·" in line or line.startswith("_"))


def rejudge_column_checks(t: dict[str, list[dict]]) -> list[dict]:
    """The columns a re-judge needs, checked from the tables: every PR's merge base and title; every
    review comment's raw text, priority and confidence agreeing with the judge's view of it; the
    Martian reviews' inline comments beyond the page Martian read; no QuickReview review under a
    third-party tool's name; Martian scores that recount from their verdicts; the Martian scoring dirs'
    judge settings; every claim's arms and runs linked to its group; no Qodo verdict without its review."""
    checks = []

    def check(what, got, want):
        checks.append({"check": what, "got": got, "want": want, "ok": got == want})

    prs = t["prs"]
    # MUTATION: drop "merge_base" (or "title") from build_key's prs row — this fails
    check("prs: every PR has its merge base (40 hex) and its title",
          sum(1 for p in prs if not SHA1.match(p.get("merge_base") or "") or not (p.get("title") or "").strip()), 0)
    check("prs: PRs whose merge base is not base_commit", sum(1 for p in prs if p.get("merge_base") != p["base_commit"]),
          MERGE_BASE_DIFFERS)
    bad, link = [], []
    for r in t["reviews"]:
        for c in r["comments"] or []:
            raw = c.get("raw_text")
            if r["source_url"] is not None:
                if raw is not None:
                    link.append(f"{r['arm_id']}/{r['instance_id']}/{c['id']}")
                continue
            # MUTATION: in _comment, take priority_confidence(text) instead of the raw text — this fails
            if raw is None or judge_view(raw) != (c["tag"], c["text"]) or priority_confidence(raw) != (c["priority"], c["confidence"]):
                bad.append(f"{r['arm_id']}/{r['instance_id']}/{c['id']}")
    check("reviews: every comment's raw_text strips to its tag and text, and its priority and confidence are its footer's",
          bad[:20], [])
    check("reviews: a link-only arm's comment raw_text is withheld", link[:20], [])
    # read apart from PRIORITY_RE: a last line printing `· confidence N` (or `_confidence N`) is a footer,
    # whatever severity word it carries
    unread = [f"{r['arm_id']}/{r['instance_id']}/{c['id']}" for r in t["reviews"] for c in r["comments"] or []
              if c.get("confidence") is None and _footer_conf((c.get("raw_text") or "").rstrip().rpartition("\n")[2])]
    # MUTATION: revert PRIORITY_RE to the `_P<n> · confidence` and `_(P<n>/…)` forms alone — this fails (the nit footers)
    check("reviews: every comment whose last line is a footer printing a confidence has that confidence", unread[:20], [])
    beyond = []
    for r in t["martian_reviews"]:
        n, more = r.get("n_posted_inline"), r.get("comments_beyond_first_page") or []
        page = sum(1 for c in r["comments"] or [] if c.get("path") is not None)
        if r["vendor_link_only"] and (n is not None or more):
            beyond.append(f"{r['work_dir']}|{r['tool']} {r['pr_url']}: vendor")
        elif n is not None and (page != min(n, MI.GITHUB_PAGE) or len(more) != max(n - MI.GITHUB_PAGE, 0)):
            beyond.append(f"{r['work_dir']}|{r['tool']} {r['pr_url']}: {page}+{len(more)} of {n}")
    # MUTATION: in posted_beyond_page, slice from 0 instead of MI.GITHUB_PAGE — this fails
    check("martian_reviews: the first page holds min(n_posted_inline, 30) inline comments and "
          "comments_beyond_first_page the rest", beyond[:20], [])
    styled = sorted({f"martian_reviews {r['work_dir']}|{r['tool']}" for r in t["martian_reviews"]
                     if not r["tool"].startswith("quickreview") and any(QR_STYLED.search(c.get("body") or "") for c in r["comments"] or [])}
                    | {f"qodo_reviews {r['work_dir']}|{r['tool']}" for r in t["qodo_reviews"]
                       if not r["tool"].startswith("quickreview") and any(QR_STYLED.search(c.get("body") or "") for c in r["comments"] or [])}
                    | {f"reviews {r['arm_id']}" for r in t["reviews"] if r["arm_id"] in THIRD_PARTY_ARMS
                       and any(c.get("priority") for c in r["comments"] or [])})
    # MUTATION: return {} from ingest_relabels — fast1-martian50's 49 reviews keep tool claude-code and this fails
    check("no QuickReview-styled review carries a third-party tool's label (martian_reviews, qodo_reviews, the "
          "papers' third-party AACR arms)", styled, [])
    # MUTATION: in _martian_dir, keep a relabelled tool's scores as a second row instead of merge_scores — this fails
    check("martian_scores: every scoring dir's own score recounts from its verdicts and its reviews' false positives",
          martian_score_problems(t)[:20], [])
    keys = ("reasoning effort", "verbosity", "backend", "dropped")
    unstated = [r["unit"] for r in t["runs"] if ".martian" in r["unit"] and "no request log" not in (r["judges"] or "")
                and not all(k in (r["judges"] or "") for k in keys)]
    # MUTATION: skip the martian_judge_settings pass in build_runs — this fails
    check("runs: every Martian scoring dir's judges states the effort, verbosity, backend and dropped request keys",
          unstated[:20], [])
    if t.get("arms") and t.get("runs"):
        manifest = json.load(open(CLAIMS_MANIFEST))
        links = claim_link_problems(t, manifest["claims"], manifest.get("checks"))
        # MUTATION: drop ex.link_claims() from main — both fail
        # MUTATION: in link_claims, keep a row's earlier labels beside the derived groups — both fail
        check("arms: every arm's paper_tables is exactly the groups of the claims whose q keys read it, and it is "
              "in_paper exactly when one does", links["arms"][:20], [])
        check("runs: every run's claims is exactly the groups of the claims whose q keys read it",
              links["runs"][:20], [])
    have = {(r["work_dir"], r["tool"]) for r in t["qodo_reviews"]}
    # MUTATION: drop the VERDICTS_NEED filter from release_catalogue.Catalogue.hf_tables — this fails
    check("qodo_verdicts: every (work_dir, tool) has its reviews",
          sorted({f"{v['work_dir']}|{v['tool']}" for v in t["qodo_verdicts"] if (v["work_dir"], v["tool"]) not in have}), [])
    return checks


# the answer key's build, as the `*-code` dirs record it (key_data.py)
KEY_BUILD = {"first_prs": 141, "first_rows": 2221, "extended_rows": 1527}


def key_data_checks(t: dict[str, list[dict]]) -> list[dict]:
    """The answer key's build data covers the key: every key PR has its size,
    every R145 PR its first candidate map, every key PR its extended map, and
    every candidate names who raised it."""
    checks = []

    def check(what, got, want):
        checks.append({"check": what, "got": got, "want": want, "ok": got == want})

    key = {r["instance_id"] for r in t["prs"]}
    r145 = {r["instance_id"] for r in t["prs"] if r["set"] == "rest145"}
    sizes = {r["instance_id"] for r in t.get("pr_diffstats") or []}
    check("pr_diffstats: key PRs with a size", len(sizes & key), len(key))
    check("pr_diffstats: changed_lines == insertions + deletions",
          sum(r["changed_lines"] != r["insertions"] + r["deletions"] for r in t.get("pr_diffstats") or []), 0)
    by_round, rows = collections.defaultdict(set), collections.Counter()
    for r in t.get("aacr_candidates") or []:
        by_round[r["round"]].add(r["instance_id"])
        rows[r["round"]] += 1
    # the source maps: 145 R145 PRs have a first-key map, 4 of them empty (no
    # earlier run commented on the PR); every key PR has an extended-key map
    check("aacr_candidates: R145 PRs with a first-key candidate", len(by_round["candidates"] & r145), KEY_BUILD["first_prs"])
    check("aacr_candidates: first-key candidates", rows["candidates"], KEY_BUILD["first_rows"])
    check("aacr_candidates: first-key rows outside R145", len(by_round["candidates"] - r145), 0)
    check("aacr_candidates: key PRs with an extended-key candidate map", len(by_round["new-candidates"] & key), len(key))
    check("aacr_candidates: extended-key candidates", rows["new-candidates"], KEY_BUILD["extended_rows"])
    check("aacr_candidates: candidates with no raiser", sum(not r["raised_by"] for r in t.get("aacr_candidates") or []), 0)
    return checks


def validate_release(t: dict[str, list[dict]], cat: "RC.Catalogue | None", elo_refits: dict, elo_dir: str | None,
                     commits: "tuple[dict, dict, dict] | None" = None) -> list[dict]:
    """The checks of what this release adds: the open-model rows, the Elo
    ratings (refit from the published judgments, equal to the run's own
    ratings.json, and the README's numbers), that every family the
    catalogue gives a table has rows in it, and (`commits`: the recorded
    build ids by published path, the remap and its evidence) that `runs`
    states every build commit as recorded: a dirty build flagged, a public
    main commit only where the remap gives it, with the evidence's match
    kind, and an "ancestor" one only where the evidence proves it."""
    checks = []

    def check(what, got, want, tol=0.0):
        ok = approx(got, want, tol) if tol else got == want
        checks.append({"check": what, "got": got, "want": want, "ok": bool(ok)})

    defects = {(d["instance_id"], d["defect_id"]): d["severity"] for d in t["defects"]}
    for aid, (found, usd) in OPEN_MODEL_ROWS.items():
        dv = [r for r in t["defect_verdicts"] if r["arm_id"] == aid and r["judge"] == OPEN_JUDGE]
        rs = [r for r in t["reviews"] if r["arm_id"] == aid]
        check(f"{aid}: judged PRs", sum(r["judged"] for r in rs), 185)
        check(f"{aid}: found/520 ({OPEN_JUDGE})", defect_summary(dv, defects)["found"], found, 0.001)
        c = [r["cost_usd"] for r in rs if r["judged"] and r["cost_usd"] is not None]
        check(f"{aid}: $/PR", round(statistics.mean(c), 2) if c else None, usd, 0.006)
    checks += judge_coverage_checks(t)
    checks += key_data_checks(t)
    checks += rejudge_column_checks(t)
    # the card's statements about these columns: every Martian and Qodo PR names its repository's
    # licence, and every Martian golden its half (the set files fill the audit's gaps)
    for n in ("martian_prs", "qodo_prs"):
        check(f"{n}: every row names its repository's licence", sum(1 for r in t[n] if not r.get("repo_license")), 0)
    # the card's statement: qodo_prs publishes the real GitHub commits, never a harness replay id
    check("qodo_prs: base and head are real commits, none a replay id, none missing",
          replay_commit_problems(t["qodo_prs"], set_replay_ids()), 0)
    check("martian_goldens: every golden has its half (audit_split)",
          sum(1 for r in t["martian_goldens"] if r.get("audit_split") not in ("test30", "tune20")), 0)
    used = collections.Counter(r["judgment_file"] for r in t["elo_judgments"] if r["plan"] == ELO_PLAN and r["used_in_ratings"])
    check(f"elo {ELO_PLAN}: judgments in the ratings (gpt + opus)", used["gpt"] + used["opus"], 596)
    comb = {r["run"]: r for r in t["elo_ratings"] if r["plan"] == ELO_PLAN and r["table"] == "combined" and r["category"] == "overall"}
    for run, elo in ELO_README.items():
        check(f"elo {ELO_PLAN}: {run} pooled Elo", round(comb[run]["elo"]) if run in comb else None, elo)
    check(f"elo {ELO_PLAN}: pooled games", next(iter(comb.values()))["games"] if comb else None, 596)
    rat = elo_refits.get(ELO_PLAN)
    if rat is not None:
        check(f"elo {ELO_PLAN}: judges agree on the overall winner", round(100 * rat["agreement"]["overall"]["same_rate"]), 56)
    if elo_dir:
        sys.path.insert(0, os.path.join(HERE, "recompute"))
        import elo_ratings as ER
        for plan, r in sorted(elo_refits.items()):
            f = os.path.join(elo_dir, plan, "ratings.json")
            if os.path.exists(f):
                # an older elo.py wrote no `pairs`: compare every key the file has
                diffs = [x for x in ER._same(json.loads(json.dumps(r)), json.load(open(f))) if not x.endswith("only in refit")]
                check(f"elo {plan}: refit from the judgments == its ratings.json (every key it holds)", len(diffs), 0)
    if cat is not None:
        for f in cat.shipped_families():
            for table in RC.Catalogue.hf_tables(f):
                if table in COVERAGE_REPORT_ONLY:
                    continue
                if table == "runs":
                    got = sum(1 for r in t["runs"] if r["family"] == f["id"])
                elif table == "arms":
                    got = sum(1 for r in t["arms"] if f["id"] in (r.get("run_family") or "").split(", "))
                elif table in ("elo_judgments", "elo_ratings"):
                    got = len(t[table]) if t[table] else 0
                elif table in t and t[table] and "run_family" in t[table][0]:
                    got = sum(1 for r in t[table] if r.get("run_family") == f["id"])
                else:
                    continue
                check(f"family {f['id']}: has rows in {table}", got > 0, True)
        check("runs: every row is a shipped family",
              all(RC.Catalogue.ships(cat.families.get(r["family"])) for r in t["runs"]), True)
    if commits is not None:
        recorded, remap, evidence = commits
        bad = RC.commit_problems(t["runs"], recorded, remap, evidence)
        check("runs: every row's recorded build id was read", sum(1 for r in t["runs"] if r["path"] not in recorded), 0)
        # the card's statement: a dirty build is flagged, never published as the clean commit
        check("runs: a run built with uncommitted changes has qcr_commit_dirty true, a clean one false",
              bad["dirty_unflagged"], 0)
        check("runs: every qcr_commit on public main is the remap's public main commit for the recorded id",
              bad["off_main"], 0)
        # the card's statement: every on-main commit says how it was matched (same or ancestor)
        check("runs: every row on public main has the evidence's qcr_commit_match, and no row off it has one",
              bad["unmatched"], 0)
        check("runs: every \"ancestor\" row's commit is the remap's, an ancestor of main whose dropped "
              "descendants touched only files never on main (per the evidence)", bad["ancestor_unproven"], 0)
    return checks


BIBTEX_AUTHOR = re.compile(r"^\s*author\s*=\s*\{")


def leak_scan(out: str) -> dict:
    """Every scrubbed spelling must be gone from every text file written."""
    bad = collections.Counter()
    pats = [re.compile(rx) for _, rx, _ in SCRUB_RULES]
    for n in CONFIGS:
        import pyarrow.parquet as pq
        t = pq.read_table(os.path.join(out, "data", f"{n}.parquet"))
        blob = json.dumps(t.to_pylist(), ensure_ascii=False, default=str)
        for p in pats:
            bad[(n, p.pattern)] += len(p.findall(blob))
    for rel, _ in SJ.file_rows(out):  # the second judges' verdict tables, read as the configs are
        from tables import load_table
        blob = json.dumps(load_table(os.path.dirname(os.path.join(out, rel)), os.path.basename(rel).split(".")[0]),
                          ensure_ascii=False, default=str)
        for p in pats:
            bad[(rel, p.pattern)] += len(p.findall(blob))
    for root, _, files in os.walk(out):
        for f in files:
            if f.endswith((".md", ".json", ".svg", ".txt")) or f == "NOTICE":
                txt = open(os.path.join(root, f), errors="replace").read()
                if f == "README.md" and root == out:
                    # the card: the citations name the papers' author in full, as the papers do (ruled);
                    # every other line is scanned like any file
                    txt = "\n".join(ln for ln in txt.splitlines() if not BIBTEX_AUTHOR.match(ln))
                for p in pats:
                    bad[(os.path.relpath(os.path.join(root, f), out), p.pattern)] += len(p.findall(txt))
    return {f"{k[0]} :: {k[1]}": v for k, v in bad.items() if v}


def generated_files(a, sub: str) -> dict[str, str]:
    """name -> path of every file in bench/aacr/<sub>, with --generated's
    <sub> filling in what the tree lacks (the tree's copy wins)."""
    found: dict[str, str] = {}
    for root in [HERE] + ([a.generated] if getattr(a, "generated", None) else []):
        d = os.path.join(root, sub)
        for f in sorted(os.listdir(d)) if os.path.isdir(d) else []:
            if os.path.isfile(os.path.join(d, f)):
                found.setdefault(f, os.path.join(d, f))
    return found


# charts.py draws these from the AACR reference labels alone, the same for any arm set: the
# export writes the redraw's -gpt6sol drawing under the plain name too, never a staged copy
ARM_FREE_CHARTS = ("reference-quality.jpg",)
# what the papers include: \chart{name} (charts/<name>.jpg) and ../charts/<file>; "#" skips the macro's own body
PAPER_CHART_RX = (re.compile(r"\\chart\{([^}#]+)\}"), re.compile(r"\{\.\./charts/([^}#]+)\}"))


def paper_charts(paper_dir: str) -> list[str]:
    """Every file under charts/ that a paper in paper_dir includes."""
    names: set[str] = set()
    for tex in sorted(glob.glob(os.path.join(paper_dir, "*.tex"))):
        src = open(tex).read()
        names |= {m + ".jpg" for m in PAPER_CHART_RX[0].findall(src)}
        names |= set(PAPER_CHART_RX[1].findall(src))
    return sorted(names)


def _sha256(path: str) -> str | None:
    return hashlib.sha256(open(path, "rb").read()).hexdigest() if os.path.isfile(path) else None


def figure_problems(paper_dir: str, charts_dir: str, fig_dir: str) -> dict[str, list[str]]:
    """The figures against the papers: `paper_differs`, every chart a paper includes whose
    repository copy is missing or not byte-identical to the exported figure (the repository
    copy must be the drawing the export publishes, so a chart drawn from older names cannot
    reach a paper), "(no chart in the papers)" when none is found; `arm_free_differs`, every
    ARM_FREE_CHARTS figure missing or not byte-identical to its -gpt6sol twin."""
    names = paper_charts(paper_dir)
    paper = [n for n in names if _sha256(os.path.join(charts_dir, n)) is None
             or _sha256(os.path.join(charts_dir, n)) != _sha256(os.path.join(fig_dir, n))]
    twin = []
    for f in ARM_FREE_CHARTS:
        stem, ext = os.path.splitext(f)
        got = _sha256(os.path.join(fig_dir, f))
        if got is None or got != _sha256(os.path.join(fig_dir, f"{stem}-gpt6sol{ext}")):
            twin.append(f)
    return {"paper_differs": paper if names else ["(no chart in the papers)"], "arm_free_differs": twin}


def figure_checks(out: str) -> list[dict]:
    # MUTATION: restore bench/aacr/charts/independent-defects-gpt6sol.jpg from 1a27e542 (drawn from the
    # older arm names) — the first check fails; put the staged October reference-quality.jpg in figures/
    # — the second fails
    p = figure_problems(os.path.join(HERE, "paper"), os.path.join(HERE, "charts"), os.path.join(out, "figures"))
    return [{"check": "figures: every chart the papers include is byte-identical in the repository and in figures/",
             "got": p["paper_differs"], "want": [], "ok": p["paper_differs"] == []},
            {"check": "figures: a chart that no arm set changes is the same drawing under its plain and -gpt6sol names",
             "got": p["arm_free_differs"], "want": [], "ok": p["arm_free_differs"] == []}]


def figures(a, out: str, counts: collections.Counter, notes: list[str]):
    """Charts, rendered keys, FULL-BENCHMARK. The earlier study's
    charts are re-drawn with the public name; everything textual is scrubbed."""
    fig = os.path.join(out, "figures")
    keys = os.path.join(out, "keys")
    rep = os.path.join(out, "reports")
    for d in (fig, keys) + ((rep,) if getattr(a, "with_report", False) else ()):
        os.makedirs(d, exist_ok=True)
    charts = generated_files(a, "charts")
    redraw = {f for f in charts if "-gpt6sol" in f} | {"judge-agreement.jpg"} | set(ARM_FREE_CHARTS)
    for f, p in sorted(charts.items()):
        if f in redraw:
            continue
        if f.endswith((".json", ".svg")):
            open(os.path.join(fig, f), "w").write(scrub(open(p).read(), counts))
        else:
            shutil.copy2(p, os.path.join(fig, f))
    sol = []
    for name, runs in read_arms_file(os.path.join(HERE, "final", "arms-gpt6sol.txt")):
        sol.append(f"{scrub(name).replace('quickreview', 'QuickReview')}={','.join(runs)}")
    with tempfile.TemporaryDirectory() as tmp:
        env = dict(os.environ, QCR_BENCH_RUNS_DIR=a.runs_dir)
        base = ["uv", "run", "--quiet", os.path.join(HERE, "charts.py"), "--cases", "all30+fresh10+rest145", "--runs-dir", a.runs_dir]
        subprocess.run(base + ["--out", tmp, "--suffix=-gpt6sol", "--note",
                               "earlier study: tools as shipped or as the AACR harness runs them · gpt-6-sol except Claude Code (Opus 5.5)"]
                       + sol, check=True, env=env, stdout=subprocess.DEVNULL)
        agree = os.path.join(tmp, "agree")
        subprocess.run(base + ["--out", agree, "--second-judge", SECOND] + sol, check=True, env=env, stdout=subprocess.DEVNULL)
        for f in os.listdir(tmp):
            if "-gpt6sol" in f:
                p = os.path.join(tmp, f)
                if f.endswith(".json"):
                    open(os.path.join(fig, f), "w").write(scrub(open(p).read(), counts))
                else:
                    shutil.copy2(p, os.path.join(fig, f))
        shutil.copy2(os.path.join(agree, "judge-agreement.jpg"), os.path.join(fig, "judge-agreement.jpg"))
        for f in ARM_FREE_CHARTS:
            stem, ext = os.path.splitext(f)
            shutil.copy2(os.path.join(tmp, f"{stem}-gpt6sol{ext}"), os.path.join(fig, f))
    for f, p in sorted(generated_files(a, "defects").items()):
        if f.endswith(".md"):
            open(os.path.join(keys, f), "w").write(scrub(open(p).read(), counts))
    if not getattr(a, "with_report", False):
        # the working report of 2026-10-01: its numbers are not in the claims manifest and the papers,
        # corrected to the data, supersede it, so the release leaves it out unless asked
        notes.append("reports/ not written (FULL-BENCHMARK.md is a superseded working report; --with-report writes it)")
        return
    full = generated_files(a, "").get("FULL-BENCHMARK.md")
    if full is None:
        notes.append("FULL-BENCHMARK.md is in neither the tree nor --generated: reports/ not written")
        return
    md = scrub(open(full).read(), counts)
    md = md.replace("](charts/", "](../figures/")
    open(os.path.join(rep, "FULL-BENCHMARK.md"), "w").write(md)
    if shutil.which("chromium"):
        html = os.path.join(rep, ".full.html")
        subprocess.run(["uv", "run", "--quiet", "--no-project", "--with", "markdown", "python3", "-c",
                        "import sys, markdown; body = markdown.markdown(open(sys.argv[1]).read(), extensions=['tables']); "
                        "css = \"@page { size: A4; margin: 14mm; } body { font-family: 'DejaVu Sans', sans-serif; font-size: 9pt; } "
                        "img { max-width: 100%; } table { border-collapse: collapse; font-size: 8pt; } th, td { border: 1px solid #ccc; padding: 2px 4px; }\"; "
                        "open(sys.argv[2], 'w').write(f\"<!doctype html><html><head><meta charset='utf-8'><style>{css}</style></head><body>{body}</body></html>\")",
                        os.path.join(rep, "FULL-BENCHMARK.md"), html], check=True)
        subprocess.run(["chromium", "--headless", "--disable-gpu", "--no-sandbox", "--no-pdf-header-footer",
                        f"--print-to-pdf={os.path.join(rep, 'FULL-BENCHMARK.pdf')}", f"file://{html}"],
                       check=True, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
        os.remove(html)
    else:
        notes.append("chromium not found: reports/FULL-BENCHMARK.pdf not rendered (the .md is there)")


DOI_PENDING = "<DOI pending>"
ARXIV_PENDING = "<arXiv pending>"


def dataset_url(repo_id: str) -> str:
    return f"https://huggingface.co/datasets/{repo_id}"


def groups_on_no_run(runs: list[dict], groups: dict | None = None) -> str:
    """The card's list of the claims manifest's groups that no runs row carries, in code font ("none")."""
    groups = json.load(open(CLAIMS_MANIFEST))["groups"] if groups is None else groups
    carried = {g for r in runs for g in r.get("claims") or []}
    return ", ".join(f"`{g}`" for g in sorted(set(groups) - carried)) or "none"


# The card's comment inventory: per reviewer and benchmark, the comment rows the tables carry with their
# text and those that carry only a location or a link (third-party text, linked and not copied).
# AACR arms carry no tool column: an arm counts under the first tool its id names, word by word
# (`cc303` is Claude Code 2.1.303 in the one-PR probes), and an arm that names none is QuickReview's.
INVENTORY_AACR_TOKENS = (("quickreview", "QuickReview"), ("claude", "Claude Code"), ("cc303", "Claude Code"),
                         ("codex", "Codex CLI"), ("ocr", "open-code-review"), ("opencode", "OpenCode"),
                         ("pireview", "pi-review"), ("pragent", "PR-Agent"), ("copilot", "Copilot 2025 (upstream)"))
# Martian's and Qodo's `tool` column, every value it takes; an unknown one stops the card (fail closed).
INVENTORY_MARTIAN_TOOLS = {"quickreview": "QuickReview", "quickreview-frozen": "QuickReview",
                           "claude-code-bench": "Claude Code", "open-code-review": "open-code-review",
                           "opencode": "OpenCode", "pr-agent": "PR-Agent",
                           "rejudged-claude-code": "Claude Code (Martian's published review)",
                           "rejudged-cubic-v2": "cubic-v2 (Martian's published review)",
                           "rejudged-qodo-extended-v2": "qodo-extended-v2 (Martian's published review)"}
INVENTORY_QODO_TOOLS = {"quickreview": "QuickReview", "quickreview-frozen": "QuickReview",
                        "quickreview-2026-10-02": "QuickReview", "open-code-review": "open-code-review",
                        "opencode": "OpenCode", "pr-agent": "PR-Agent",
                        **{t: f"{t} (Qodo's published run)" for t in
                           ("augment", "coderabbit", "codex", "copilot", "cursor", "greptile", "qodo-exhaustive",
                            "qodo-precise", "sentry")}}
INVENTORY_PENDING = "`<comment inventory pending>`"


def inventory_tool(arm_id: str) -> str:
    """The reviewer an AACR arm's comments count under in the card's inventory."""
    words = arm_id.split("-")
    return next((name for tok, name in INVENTORY_AACR_TOKENS if tok in words), "QuickReview")


def comment_inventory(t: dict[str, list[dict]]) -> dict[str, dict[str, list[int]]]:
    """{reviewer: {benchmark: [comments with text, comments with a location or link only, reviews]}}
    from the tables' rows: `reviews` (text or raw_text), `martian_reviews` (body, the comments past
    Martian's first page included) and `qodo_reviews` (body). Every row of every run counts."""
    inv: dict[str, dict[str, list[int]]] = {}

    def add(tool: str, bench: str, comments: list[dict], field) -> None:
        c = inv.setdefault(tool, {}).setdefault(bench, [0, 0, 0])
        c[2] += 1
        for x in comments:
            c[0 if field(x) else 1] += 1

    for r in t["reviews"]:
        add(inventory_tool(r["arm_id"]), "AACR-Bench", r["comments"] or [],
            lambda x: (x.get("text") or "").strip() or (x.get("raw_text") or "").strip())
    for name, table, tools, extra in (("Martian", "martian_reviews", INVENTORY_MARTIAN_TOOLS, "comments_beyond_first_page"),
                                      ("Qodo", "qodo_reviews", INVENTORY_QODO_TOOLS, None)):
        for r in t[table]:
            if r["tool"] not in tools:
                raise SystemExit(f"card comment inventory: {table} tool {r['tool']!r} has no reviewer name "
                                 f"(INVENTORY_{name.upper()}_TOOLS)")
            add(tools[r["tool"]], name, (r["comments"] or []) + ((r.get(extra) or []) if extra else []),
                lambda x: (x.get("body") or "").strip())
    return inv


def render_inventory(inv: dict[str, dict[str, list[int]]] | None) -> str:
    """The card's table: one row per reviewer, most comments with text first; a cell gives the comments
    with text, then those with a location or a link only, or says the reviews carry no comment rows."""
    if inv is None:
        return INVENTORY_PENDING
    benches = ("AACR-Bench", "Martian", "Qodo")

    def both(text: int, bare: int) -> str:
        if not bare:
            return f"{text:,}"
        return (f"{text:,} + " if text else "") + f"{bare:,} location or link only"

    def cell(c: list[int] | None) -> str:
        if not c:
            return "–"
        if c[0] + c[1] == 0:
            return f"no comment rows ({c[2]:,} reviews)"
        return both(c[0], c[1])

    order = sorted(inv, key=lambda k: (-sum(c[0] for c in inv[k].values()), -sum(c[1] for c in inv[k].values()), k))
    rows = [f"| {k} | " + " | ".join(cell(inv[k].get(b)) for b in benches) + " |" for k in order]
    tot = [sum((inv[k].get(b) or [0, 0, 0])[i] for k in inv) for b in benches for i in (0, 1)]
    rows.append("| **All** | " + " | ".join(both(tot[2 * j], tot[2 * j + 1]) for j in range(3)) + " |")
    return "\n".join(["| Reviewer | AACR-Bench | Martian | Qodo |", "|---|---|---|---|"] + rows)


SECOND_JUDGES_PENDING = "`<second_judges/ not in this build>`"


def render_second_judge_files(rows: list[tuple] | None) -> str:
    """The card's table of the second judges' verdict tables (second_judges.file_rows): path and rows."""
    if not rows:
        return SECOND_JUDGES_PENDING
    return "\n".join(["| File | Rows |", "|---|---:|"] + [f"| `{p}` | {n:,} |" for p, n in rows])


def card_values(a, sizes: dict, checks: list[dict], counts: collections.Counter, runs: list[dict] | None = None,
                inventory: dict | None = None, second_judges: list[tuple] | None = None) -> dict:
    """Every {{NAME}} the card template holds, from the export's own facts. What
    is not known at export time (the DOI, the papers' arXiv ids) renders as an
    explicit pending marker, never as an empty string or a guess."""
    rows = "\n".join(f"| `{n}` | {sizes[n]:,} |" for n in CONFIGS)
    configs_yaml = "\n".join(
        f"- config_name: {n}\n  data_files:\n  - split: test\n    path: data/{n}.parquet" + ("\n  default: true" if n == "defects" else "")
        for n in CONFIGS)
    # one row per kind of name, never the spelling itself: the patterns carry
    # the exporter's own paths and identities
    kinds = dict.fromkeys([(label, rep) for label, _, rep in SCRUB_RULES]
                          + ([(CONTENT_LABEL, "the public repository's stand-in")] if CONTENT_RULES is not None else []))
    scrub_tbl = "\n".join(f"| {label} | `{rep}` | {counts.get(label, 0):,} |" for label, rep in kinds)
    ok = sum(c["ok"] for c in checks)
    runs = runs or []
    url = dataset_url(a.repo_id)
    return {"REPO_ID": a.repo_id, "DATASET_URL": url, "REPO_REF": getattr(a, "repo_ref", None) or "main",
            "VERIFY_RESULT": verify_result(getattr(a, "verify_report", None)),
            "CLAIMS_LEAD": claims_lead(getattr(a, "verify_report", None)),
            # whole links, so the template holds no link target a Markdown
            # link check would read as a path in this repository
            "ARCHIVE_MD": f"[`archive/`]({getattr(a, 'archive_url', None) or url + '/tree/main/archive'})",
            "SLIM_MD": f"[`slim/`]({getattr(a, 'slim_url', None) or url + '/tree/main/slim'})",
            "DOI": getattr(a, "doi", None) or DOI_PENDING,
            "ARXIV_BENCHMARK": getattr(a, "arxiv_benchmark", None) or ARXIV_PENDING,
            "ARXIV_QUICKREVIEW": getattr(a, "arxiv_quickreview", None) or ARXIV_PENDING,
            # prose forms: a pending marker in code font (bare <...> is an HTML
            # tag to a Markdown renderer and would vanish), a known id as a link
            "DOI_MD": md_link(getattr(a, "doi", None), DOI_PENDING, "https://doi.org/"),
            "ARXIV_BENCHMARK_MD": md_link(getattr(a, "arxiv_benchmark", None), ARXIV_PENDING, "https://arxiv.org/abs/"),
            "ARXIV_QUICKREVIEW_MD": md_link(getattr(a, "arxiv_quickreview", None), ARXIV_PENDING, "https://arxiv.org/abs/"),
            "CONFIGS_YAML": configs_yaml, "CONFIG_ROWS": rows, "SCRUB_TABLE": scrub_tbl,
            "CHECKS": f"{ok} of {len(checks)}",
            "RUN_UNITS": f"{len(runs):,}", "RUN_FAMILIES": f"{len({r['family'] for r in runs}):,}",
            "GROUPS_ON_NO_RUN": groups_on_no_run(runs),
            "COMMENT_INVENTORY": render_inventory(inventory),
            "SECOND_JUDGE_FILES": render_second_judge_files(second_judges),
            "SIZE_CATEGORY": size_category(sum(sizes.values()))}


VERIFY_PENDING = "`<verifier result pending>`"


GAP_STATUSES = ("no-script", "not-published", "needs-input")


def claims_lead(path: str | None) -> str:
    """The card's lead sentence on the verifier: every number checked only when the report says so."""
    if not path:
        return VERIFY_PENDING
    c = collections.Counter(x["status"] for x in json.load(open(path))["results"])
    if c.get("pass", 0) == sum(c.values()):
        return ("Every one of them passes: a number the release could not check was cut from the pages or "
                "reworded to the number the data gives.")
    return (f"{c.get('pass', 0):,} of {sum(c.values()):,} pass; the rest are listed in the verifier's "
            "report with the reason each could not be checked.")


def verify_result(path: str | None) -> str:
    """The card's one-paragraph statement of the claims verifier's result on this release, from its
    --report-json; a pending marker until it has run (PUBLISH.md re-renders the card with it)."""
    if not path:
        return VERIFY_PENDING
    r = json.load(open(path))
    c = collections.Counter(x["status"] for x in r["results"])
    cons = r.get("consistency") or []
    ok = sum(1 for x in cons if x["ok"])
    fails = sum(c.get(k, 0) for k in ("mismatch", "error", "no-source"))
    checks = f"The release's own checks (the tables' validation and the slim bundle's) pass {ok} of {len(cons)}."
    if cons and all(isinstance(x.get("needs"), list) for x in cons):
        # the split, from what each check needs: a --partial run without the third-party inputs, and the
        # tables alone, re-run fewer of them
        tables = sum(1 for x in cons if not x["needs"])
        # validation.json's checks of the second judges' folder: they need that folder beside the tables
        folder = sum(1 for x in cons if x["needs"] == ["second_judges"])
        third = sum(1 for x in cons if {"--martian", "--qodo-gt"} & set(x["needs"]))
        rerun = (f"re-run on the dataset ({tables} on the tables and {folder} on its `second_judges/` folder)"
                 if folder else "re-run on the tables")
        checks = (f"The release's own checks pass {ok} of {len(cons)}: {tables + folder} from `validation.json`, "
                  f"{rerun}, and {len(cons) - tables - folder} the slim bundle's. `--partial` without `--martian` "
                  f"and `--qodo-gt` re-runs {len(cons) - third} of them (the slim bundle's Martian and Qodo "
                  f"re-scores need those inputs), and with the tables alone the {tables} from `validation.json`.")
    if c.get("pass", 0) == sum(c.values()):
        return (f"all {c.get('pass', 0):,} claims pass, with 0 mismatch, 0 error, 0 missing source and no "
                f"claim left unchecked. " + checks)
    return (f"{c.get('pass', 0):,} of {sum(c.values()):,} claims pass; {c.get('mismatch', 0)} mismatch, "
            f"{c.get('error', 0)} error and {c.get('no-source', 0)} missing source"
            + ("" if not fails else " (this release is not ready)")
            + f"; the documented gaps are {c.get('no-script', 0)} claims with no recompute script yet and "
              f"{c.get('not-published', 0)} whose data the release does not hold"
            + (f", and {c['needs-input']} that need a third-party input" if c.get("needs-input") else "")
            + ". " + checks)


def md_link(value: str | None, pending: str, base: str) -> str:
    return f"[{value}]({base}{value})" if value else f"`{pending}`"


def size_category(rows: int) -> str:
    """The card's `size_categories` tag (Hugging Face's buckets) for the total row count."""
    for top, tag in ((1_000, "n<1K"), (10_000, "1K<n<10K"), (100_000, "10K<n<100K"), (1_000_000, "100K<n<1M")):
        if rows < top:
            return tag
    return "1M<n<10M"


def fill_card(tmpl: str, vals: dict) -> str:
    """Substitute every {{NAME}}; a name the template holds and `vals` lacks is
    an error, so a card never ships with a raw {{...}} in it."""
    for k, v in vals.items():
        tmpl = tmpl.replace("{{" + k + "}}", v)
    left = sorted(set(re.findall(r"\{\{([A-Z_]+)\}\}", tmpl)))
    if left:
        raise SystemExit(f"card template: no value for {', '.join(left)}")
    return tmpl


def render_card(a, out: str, sizes: dict, checks: list[dict], counts: collections.Counter, runs: list[dict] | None = None):
    import pyarrow.parquet as pq
    tmpl = open(os.path.join(HERE, "hf", "card.md")).read()
    # the inventory from the tables as written, so the card counts exactly what ships
    inv = comment_inventory({n: pq.read_table(os.path.join(out, "data", f"{n}.parquet")).to_pylist()
                             for n in ("reviews", "martian_reviews", "qodo_reviews")})
    card = fill_card(tmpl, card_values(a, sizes, checks, counts, runs, inv, SJ.file_rows(out)))
    open(os.path.join(out, "README.md"), "w").write(card)


def rerender_card(a, out: str) -> None:
    """--card-only: the card from a built dataset dir, its tables and validation.json unchanged."""
    import pyarrow.parquet as pq
    v = json.load(open(os.path.join(out, "validation.json")))
    sizes = {n: pq.ParquetFile(os.path.join(out, "data", f"{n}.parquet")).metadata.num_rows for n in CONFIGS}
    if sizes != v["rows"]:
        raise SystemExit("--card-only: the tables' row counts differ from validation.json; rebuild the dataset")
    runs = pq.read_table(os.path.join(out, "data", "runs.parquet"), columns=["family", "claims"]).to_pylist()
    NT.write_licences(out)
    open(os.path.join(out, "NOTICE"), "w").write(dataset_notice())
    render_card(a, out, sizes, v["checks"], collections.Counter(v.get("scrub_counts") or {}), runs)
    leaks = leak_scan(out)
    if leaks:
        raise SystemExit(f"--card-only: the re-rendered card leaks: {leaks}")
    print(f"re-rendered {os.path.join(out, 'README.md')} (DOI {getattr(a, 'doi', None) or DOI_PENDING}, "
          f"repository ref {a.repo_ref})")


def dataset_notice() -> str:
    return NT.notice(
        "This dataset was assembled by Quickchat AI and is distributed under the Apache License,\n"
        "Version 2.0 (LICENSE). Its `archive/` and `slim/` folders carry their own NOTICE.",
        modified="MODIFIED WORK: the `aacr_references` config reproduces AACR-Bench's reference comments for "
                 "the 185 runnable PRs with our derived keys, bot-derived flags and labels added; `prs`, `defects` "
                 "and `exclusions` are a new answer key built on AACR-Bench's PR selection; nothing in AACR-Bench "
                 "itself was changed.",
        martian_where="The `martian_*` configs",
        qodo_where="The `qodo_*` configs",
        swepr=False) + ("\nThe licence of each reviewed repository is in `prs.repo_license`, "
                        "`martian_prs.repo_license` and `qodo_prs.repo_license` (SPDX ids).\n")


def refuse_second_judges(src: str, manifest: str = SJ.MANIFEST) -> None:
    """--second-judges: every file of the folder must be the committed manifest's, none missing, extra or
    differing, before anything is written (SystemExit naming them otherwise)."""
    src = os.path.abspath(os.path.expanduser(src))
    if os.path.basename(src.rstrip("/")) != SJ.FOLDER:
        raise SystemExit(f"--second-judges: give the `{SJ.FOLDER}` folder itself, not {src}")
    bad = SJ.manifest_problems(src, SJ.read_manifest(manifest))
    if any(bad.values()):
        raise SystemExit("--second-judges: the folder is not the committed manifest's "
                         f"({os.path.relpath(manifest, os.path.dirname(os.path.dirname(HERE)))}): "
                         + "; ".join(f"{k} {v}" for k, v in bad.items() if v))


def copy_second_judges(src: str, out: str, manifest: str = SJ.MANIFEST) -> None:
    """The folder into the dataset at second_judges/, as is, only when it is the manifest's."""
    refuse_second_judges(src, manifest)
    shutil.copytree(os.path.abspath(os.path.expanduser(src)), os.path.join(out, SJ.FOLDER))


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--runs-dir", required=True)
    ap.add_argument("--aacr-dataset", required=True, help="AACR-Bench v1.0 dataset/positive_samples.json (sha256-pinned)")
    ap.add_argument("--qodo-gt", help="Qodo git_code_review_bench_100_w_open_prs.jsonl (default: <runs>/../ext-cache/qodo/)")
    ap.add_argument("--qodo-tools", help="tool-comments.json from qodo_scrape.py build (default: <runs>/../ext-cache/qodo/)")
    ap.add_argument("--out", required=True)
    ap.add_argument("--repo-id", required=True, help="the Hugging Face dataset id the card names")
    ap.add_argument("--archive-url", help="where the run archive volumes are published "
                    "(default: the archive/ folder of the --repo-id dataset)")
    ap.add_argument("--slim-url", help="where the slim re-score bundle is published (default: its slim/ folder)")
    ap.add_argument("--doi", help=f"the dataset's DOI, once Hugging Face has minted it (default: {DOI_PENDING!r})")
    ap.add_argument("--arxiv-benchmark", help=f"the benchmark paper's arXiv id (default: {ARXIV_PENDING!r})")
    ap.add_argument("--arxiv-quickreview", help=f"the QuickReview paper's arXiv id (default: {ARXIV_PENDING!r})")
    ap.add_argument("--generated", help="a bench/aacr-shaped dir with the generated artefacts the public tree leaves out "
                    "(charts/, defects/*.md, FULL-BENCHMARK.md); the tree's own files win")
    ap.add_argument("--open-models", help="the open-model benchmark dir (its runs/ hold the open-model runs)")
    ap.add_argument("--catalogue", help="the run catalogue (release_catalogue.py): which families ship and which "
                    "tables each has rows in; without it only the 10-05 arms and scoring dirs are exported")
    ap.add_argument("--archive", help="the run archive folder (export_runs.py's --out): its RUNS-INDEX.json units "
                    "get the runs table's derived judges and claims, and the validation checks the two agree")
    ap.add_argument("--commit-remap", help="JSON {recorded qcr_commit: public main commit or null}, for the runs table")
    ap.add_argument("--elo-dir", help="the Elo runs (one dir per plan: plan.json, judgments/); default <runs>/../elo")
    ap.add_argument("--repo-ref", default="main",
                    help="the QuickReview repository's tag or commit the card's verify steps clone (the one the release "
                         "was verified against)")
    ap.add_argument("--verify-report", help="verify_claims.py --report-json over this release: the card states its result")
    ap.add_argument("--card-only", action="store_true",
                    help="re-render README.md, LICENSE, LICENSES/ and NOTICE in an existing --out from its own tables "
                         "and validation.json (to fill the DOI or the repository tag after upload); nothing else changes")
    ap.add_argument("--no-figures", action="store_true")
    ap.add_argument("--with-report", action="store_true",
                    help="also write reports/FULL-BENCHMARK.md and .pdf, the superseded working report (off by default)")
    ap.add_argument("--no-load-check", action="store_true")
    ap.add_argument("--second-judges", help="the second judges' folder (a `second_judges` dir): copied to the "
                    "dataset's second_judges/ when every file matches bench/aacr/hf/second-judges.sha256 (refused "
                    "otherwise); validation.json's second-judge checks fail without it")
    a = ap.parse_args()
    if not (SCRUB_BOTS and SCRUB_OWNERS):
        sys.exit("set QCR_SCRUB_BOT and QCR_SCRUB_OWNER: the identities this export scrubs come from the exporter")
    a.runs_dir = os.path.abspath(os.path.expanduser(a.runs_dir))
    cache = os.path.join(os.path.dirname(a.runs_dir), "ext-cache", "qodo")
    a.qodo_gt = a.qodo_gt or os.path.join(cache, "git_code_review_bench_100_w_open_prs.jsonl")
    a.qodo_tools = a.qodo_tools or os.path.join(cache, "tool-comments.json")
    a.elo_dir = a.elo_dir or os.path.join(os.path.dirname(a.runs_dir), "elo")
    out = os.path.abspath(os.path.expanduser(a.out))
    if a.card_only:
        rerender_card(a, out)
        return
    if a.second_judges:
        refuse_second_judges(a.second_judges)
    if os.path.exists(out):
        shutil.rmtree(out)
    os.makedirs(out)

    ex = Exporter(a)
    print("key …", flush=True); ex.build_key(); ex.build_references()
    print("AACR reviews and verdicts …", flush=True); ex.build_aacr_reviews()
    print("Martian …", flush=True); ex.build_martian()
    print("Qodo …", flush=True); ex.build_qodo()
    print("Elo, run index, key data …", flush=True); ex.build_elo(); ex.build_runs(); ex.build_key_data()
    ex.filter_by_family()
    ex.link_claims()
    sizes = write_parquet(ex.tables, out)
    if a.second_judges:
        copy_second_judges(a.second_judges, out)
    if not a.no_figures:
        print("figures, keys, reports …", flush=True)
        figures(a, out, ex.counts, ex.notes)
    tables = read_parquet(out)
    checks = (validate(tables) + validate_release(tables, ex.cat, ex.elo_refits, a.elo_dir, ex.commits)
              + ex.raw_text_checks(tables))
    checks += SJ.checks(out)  # fails closed: without --second-judges the folder's checks fail
    if not a.no_figures:
        checks += figure_checks(out)
    manifest = json.load(open(CLAIMS_MANIFEST))
    # MUTATION: drop the `reads` of key_build from claims.json — this fails (answer-key carries no claim group)
    fam = family_link_problems(tables, manifest)
    checks.append({"check": "runs: every family claims.json's groups name as backing a number carries a claim group "
                            "on one of its units", "got": fam[:20], "want": [], "ok": not fam})
    # MUTATION: name a unit path the run index lacks in a check's `reads` — this fails
    bad = reads_problems(manifest["checks"], manifest["claims"], tables["runs"])
    checks.append({"check": "claims.json: every script check's `reads` names a run index unit and keys its claims "
                            "read", "got": bad[:20], "want": [], "ok": not bad})
    if a.archive:
        idx = os.path.join(os.path.abspath(os.path.expanduser(a.archive)), "RUNS-INDEX.json")
        groups = json.load(open(CLAIMS_MANIFEST))["groups"]
        sync_run_index(idx, tables["runs"], groups)
        bad = run_index_problems(json.load(open(idx)), tables["runs"], groups)
        # MUTATION: drop the sync_run_index call — this fails (the index keeps no claims and the catalogue's judges)
        checks.append({"check": "archive RUNS-INDEX.json: every unit equals its runs row, field for field, and its "
                                "claims describe exactly the groups the units carry",
                       "got": bad[:20], "want": [], "ok": not bad})
    NT.write_licences(out)
    open(os.path.join(out, "NOTICE"), "w").write(dataset_notice())
    render_card(a, out, sizes, checks, ex.counts, tables.get("runs"))
    leaks = leak_scan(out)
    load = {} if a.no_load_check else load_counts(out)
    report = {"rows": sizes, "checks": checks, "failed": [c for c in checks if not c["ok"]],
              "coverage": coverage(tables, ex.cat),
              "claim_groups": claim_groups(tables, *(lambda m: (m["claims"], m["checks"]))(json.load(open(CLAIMS_MANIFEST)))),
              "scrub_counts": dict(ex.counts), "leaks": leaks, "load_dataset": load, "notes": ex.notes}
    json.dump(report, open(os.path.join(out, "validation.json"), "w"), indent=1, default=str)
    print(json.dumps({k: v for k, v in report.items() if k != "checks"}, indent=1, default=str))
    print(f"checks: {sum(c['ok'] for c in checks)}/{len(checks)} ok")
    if report["failed"] or leaks or (load and any(load[n] != sizes[n] for n in CONFIGS)):
        sys.exit(1)


if __name__ == "__main__":
    main()
