#!/usr/bin/env python3
"""Assemble the publishable run archive and the slim re-score bundle.

    bench/aacr/export_runs.py plan    --src RUNS_ROOT [--open-models OM] --catalogue CAT
    bench/aacr/export_runs.py archive --src RUNS_ROOT [--open-models OM] --catalogue CAT \\
        [--commit-remap REMAP] --out OUT/archive [--groups a,b] [--jobs 2]
    bench/aacr/export_runs.py slim    --src RUNS_ROOT [--open-models OM] --catalogue CAT --out OUT/slim
    bench/aacr/export_runs.py regrep  --out OUT/archive   (or OUT/slim)

RUNS_ROOT is the directory that holds `runs/` (the qcr-bench-runs dir); OM is
the open-model benchmark's directory (its `runs/` plus the driver scripts and
logs beside it). CAT is the run catalogue (release_catalogue.py): it names the
run family of every unit and whether that family ships; a unit it does not list
is withheld. The input is read only. Nothing is uploaded and no model is called.

What ships: every unit of every family the catalogue ships, from `runs/`,
`analysis/`, `whatif/`, `logs/`, `ext-images/`, `elo/` (without `packs/`), the
answer key in the `*-code` dirs, and the open-model runs and their driver
files (under `open-models/`). What never ships: `notes/` (private; the walk
refuses to enter it), `ext-cache/`, `ext-data/`, `scratch-archive/`
(third-party data, regenerable clones, scratch), the reviewed repos' code
(`repo.git`, `base/`, `head/`, `pr.diff` — refetch them from repo@commit), the
Elo packs (whole files of the reviewed repos; `elo.py pack` regenerates them),
Martian's own data, every withheld family (own-repo reviews, aborted runs,
the `pc2-*` check the authors withheld), raw model session logs of every kind
(session_logs.py: transcripts, event streams, session process logs, the
sandbox command logs and the prompt files; each JSONL one ships as its
numbers-only extract `*.pruned.jsonl` instead, priced against the full
stream while it is written), and third-party comment text (vendor review
comments, harvested Copilot reviews, SWE-PRBench's human review comments),
which is replaced by a marker with a hash and a link. Two copies of vendor
text ship verbatim, as third-party text: the Martian judge's extractions of
the re-judged vendors' comments (`results/<judge>/candidates.json` and
`evaluations.json`) and the blind annotation's vendor candidates
(`analysis/…/fair/secret.json`). A file that is a copy
of another shipped file (a hardlink, a posting-policy variant's or an
assembled run's copy of its source run) ships once; its run's
`SOURCE-COPIES.json` maps it to the copy that ships. The answer key's volume
also carries `key-data/candidate-maps.json` and `key-data/pr-diffstats.json`
(key_data.py).

Every shipped text file is rewritten while it streams, in this order, and
nothing else in it changes:

  * credential values ($QCR_SCRUB_SECRET_FILES, scrub_extra.py) ->
    `<redacted-secret>`;
  * the product's earlier name ($QCR_SCRUB_OLD_NAME) -> `quickreview`;
  * the review bot's login and bare app slug ($QCR_SCRUB_BOT) -> `<review-bot>`,
    then the owner's name ($QCR_SCRUB_OWNER, any case) -> `<owner>`;
  * the private product repository's name ($QCR_SCRUB_PRIVATE_REPO, any case)
    -> `<private-repo>`;
  * host paths: the bench runs dir ($QCR_SCRUB_RUNS_DIR) -> `<runs>`,
    the repo checkout ($QCR_SCRUB_REPO_DIR) -> `<repo>`, any other
    `$HOME` -> `<home>` (the home scrubbed is $QCR_SCRUB_HOME, default `~`;
    spelled absolute, `~/`, `$HOME/` or `${HOME}/`), the docker volume
    `companion-pihome` -> `<pi-login-volume>`
    (the same spellings as the Hugging Face dataset export, hf_export.py);
  * private tokens ($QCR_SCRUB_PRIVATE_WORDS, any case, whole words) ->
    `<private>`, private host names ($QCR_SCRUB_HOSTS) -> `<private-host>`;
  * study renames ($QCR_SCRUB_RENAMES, scrub_extra.py): a run-name prefix
    the run dirs spell with a ticket number -> the study name the release
    uses (`ccvq-…`, Claude Code vs QuickReview), in member names and volume
    names too;
  * the content rules ($QCR_SCRUB_CONTENT_RULES, scrub_extra.py): the
    stand-ins the public repository's history carries;
  * the authors' tracker (scrub_extra.TICKET_RULES): ticket ids and paths
    into it -> `<ticket>`;
  * in JSON files, every `"qcr_commit"` -> the public main commit
    (--commit-remap; remap_commits), with `"qcr_commit_on_public_main"`,
    `"qcr_commit_match"` and `"qcr_commit_dirty"`;
  * encrypted reasoning blobs are blanked, the record kept: the value of every
    `encrypted_content` (OpenAI), every base64 `thinkingSignature` and
    `signature` (Anthropic) becomes the empty string.

Archive volumes are one `.tar.zst` per run family (zstd -19 --long=27: a 128
MiB window, the largest any stock zstd decoder accepts without flags), each
closed before it passes --cap (default 1.9 GiB; see the archive README for
why), with a manifest (sha256 per volume, per-file counts, per-rule counts),
the run index (RUNS-INDEX.json) and a README naming every withheld family.

The slim bundle holds only what compare.py, charts.py, final/score.sh, the ext
scorers and bench/aacr/recompute/ read, minus `pi-events.jsonl`: each case's
`case-summary.json` gains `bench_cost_usd` (compare.py's own per-case figure,
computed here from the full case dir) and `bench_cost_source`; the open-model
cases (and the frozen build's cases of the open-model smoke PRs) keep a pruned
transcript, `pi-events.pruned.jsonl` (timestamps, usage and lens outcomes, no
text), which recompute/do_speed.py and openmodels/lensfinal.py read; the Elo
runs keep their plans, units, judgments and ratings.
"""
from __future__ import annotations

import argparse
import collections
import datetime
import hashlib
import io
import json
import multiprocessing
import os
import re
import shutil
import subprocess
import sys
import tarfile
import time
from pathlib import Path

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE))
import key_data as KD  # noqa: E402
import notices as NT  # noqa: E402
import release_catalogue as RC  # noqa: E402
import scrub_extra as SX  # noqa: E402
import session_logs as SL  # noqa: E402

sys.path.insert(0, str(HERE / "relabel"))
import release as RL  # noqa: E402  (the labelling passes' files: analysis/relabel/)

GIB = 1 << 30
MIN_FREE = 8 * GIB
SHIPPED_TOPS = ("runs", "analysis", "whatif", "logs", "ext-images", "elo", "fresh10-code", "orig40-code", "rest145-code")
NEVER = ("notes", "ext-cache", "ext-data", "scratch-archive")
OM = "open-models"
# runs whose reviewed code is QuickReview's own private repository (the
# self-review set): withheld whatever the catalogue says (fail closed)
PRIVATE_RUNS = ("pc1-self-review-pc1",)
# run families the authors withheld although they review public PRs: the
# post-cleanup regression check of a development build (`pc2-*`, its AACR and
# SWE-PRBench parts alike), withheld whatever the catalogue says (fail closed)
OWNER_WITHHELD_PREFIXES = ("pc2-",)
OWNER_WITHHELD = "withheld by the authors: a regression check of a development build (backs no published number)"
MARTIAN_SRC = "https://github.com/withmartian/code-review-benchmark/blob/e616e84/offline/results/benchmark_data.json"
QODO_VENDORS = {"qodo-exhaustive", "qodo-precise", "augment", "copilot", "cursor", "greptile", "codex", "coderabbit", "sentry"}

# ---------------------------------------------------------------- the rewrite

# the exporting host's home directory and hostnames, scrubbed from every file
# and re-grepped afterwards: $QCR_SCRUB_HOME (default: this user's home) and
# $QCR_SCRUB_HOSTS (comma-separated, default none)
SCRUB_HOME = os.environ.get("QCR_SCRUB_HOME", os.path.expanduser("~")).rstrip("/")
SCRUB_HOSTS = [h for h in os.environ.get("QCR_SCRUB_HOSTS", "").split(",") if h.strip()]
# further private strings the re-grep hunts (case-insensitive) but no rule
# rewrites — org handles, project ids, tracker names: $QCR_SCRUB_EXTRA_TOKENS
# (comma-separated, default none)
SCRUB_EXTRA = [t.strip() for t in os.environ.get("QCR_SCRUB_EXTRA_TOKENS", "").split(",") if t.strip()]
# the identities rewritten to placeholders, each comma-separated and set by the
# exporter (never spelled in this file): $QCR_SCRUB_BOT (the review bot's app
# slugs; `<slug>[bot]` is its login), $QCR_SCRUB_OWNER (the owner's name
# spellings) and $QCR_SCRUB_OLD_NAME (the product's earlier names)
_env_list = SX.env_list
SCRUB_BOTS = _env_list("QCR_SCRUB_BOT")
SCRUB_OWNERS = _env_list("QCR_SCRUB_OWNER")
SCRUB_OLD_NAMES = _env_list("QCR_SCRUB_OLD_NAME")
# the private product repository's name (comma-separated spellings), named in
# a few model texts: $QCR_SCRUB_PRIVATE_REPO -> `<private-repo>`, any case
SCRUB_PRIVATE_REPOS = _env_list("QCR_SCRUB_PRIVATE_REPO")
# credential values, private tokens and the content rules (scrub_extra.py)
SCRUB_SECRETS = SX.secret_values()
SCRUB_PRIVATE_WORDS = _env_list("QCR_SCRUB_PRIVATE_WORDS")
CONTENT_RULES = SX.ContentRules.from_env()
# the repo checkout and the bench runs dir: $QCR_SCRUB_REPO_DIR (default: this
# checkout, a worktree resolved to its main checkout) and $QCR_SCRUB_RUNS_DIR
# (default: `qcr-bench-runs` beside that checkout)
SCRUB_REPO = os.environ.get(
    "QCR_SCRUB_REPO_DIR",
    os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__)))).split("/.claude/worktrees/")[0],
).rstrip("/")
SCRUB_RUNS = os.environ.get("QCR_SCRUB_RUNS_DIR", os.path.join(os.path.dirname(SCRUB_REPO), "qcr-bench-runs")).rstrip("/")


def _path_rx(path: str) -> tuple[bytes, bytes]:
    """A path's regex (absolute, or `~/`-, `$HOME/`- or `${HOME}/`-relative
    when under SCRUB_HOME) and a literal prefilter every spelling contains."""
    b = path.encode()
    rx = re.escape(b)
    tail = b
    if path.startswith(SCRUB_HOME + "/"):
        tail = path[len(SCRUB_HOME) + 1:].encode()
        rx = rb"(?:" + rx + rb"|(?:~|\$HOME|\$\{HOME\})/" + re.escape(tail) + rb")"
    return rx, tail
HOME_B = SCRUB_HOME.encode()
HOME_RX = re.escape(HOME_B)
HOME_DASHED = HOME_B.replace(b"/", b"-")  # Claude Code's project-dir spelling
HOME_DASHED_RX = re.escape(HOME_DASHED)
HOME_ESC = HOME_B.replace(b"/", b"\\/")  # JSON-escaped slashes
HOME_ESC_RX = re.escape(HOME_ESC)

B64 = rb"[A-Za-z0-9+/=_\-]"
ESCQ = rb'\\*"\s*:\s*\\*"'  # `":"` at any JSON escaping depth
BOT = rb"(?:\[bot\]|\\\[bot\\\]|\\\\\[bot\\\\\]|%5Bbot%5D)?"  # [bot], escaped once or twice, or URL-encoded


def _sig_keep(m):  # a base64 `signature` value right after a JSON quote: keep the key, blank the value
    return m.group(1) if m.string[m.start() - 1:m.start()] in (b'"', b"\\") else m.group(0)


def _identity_rules() -> list:
    # credential values first: nothing else may cut one in two
    out = [("secret", re.compile(re.escape(v)), SX.SECRET, v) for v in SCRUB_SECRETS]
    # the earlier product name next: it may contain the bot's slug
    for n in SCRUB_OLD_NAMES:
        b = n.encode()
        out += [("old-product-name", re.compile(re.escape(b)), b"quickreview", b),
                # a model's own capitalisation of it ("QC-…")
                ("old-product-name-other-case", re.compile(rb"(?i:" + re.escape(b) + rb")"), b"quickreview", ("low", b.lower()))]
    for bot in SCRUB_BOTS:
        b = bot.encode()
        out += [("review-bot", re.compile(re.escape(b) + BOT), b"<review-bot>", b),
                ("review-bot-other-case", re.compile(rb"(?i:" + re.escape(b) + rb")" + BOT), b"<review-bot>", ("low", b.lower()))]
    for owner in SCRUB_OWNERS:
        o = owner.encode()
        out += [("owner", re.compile(re.escape(o)), b"<owner>", o),
                ("owner-other-case", re.compile(rb"(?i:" + re.escape(o) + rb")"), b"<owner>", ("low", o.lower()))]
    for repo in SCRUB_PRIVATE_REPOS:
        r = repo.encode()
        out.append(("private-repo", re.compile(rb"(?i:" + re.escape(r) + rb")"), b"<private-repo>", ("low", r.lower())))
    return out


def _private_token_rules() -> list:
    # after the path rules, so a private token that is also a path component
    # leaves the path to its placeholder first
    out = [("private-word", SX.word_rx(w), SX.PRIVATE, ("low", w.lower().encode())) for w in SCRUB_PRIVATE_WORDS]
    for h in SCRUB_HOSTS:
        hb = h.strip().encode()
        out.append(("private-host", re.compile(rb"(?i:" + re.escape(hb) + rb")"), SX.PRIVATE_HOST, ("low", hb.lower())))
    return out


CONTENT = ("content-rules", None, None, None)  # the $QCR_SCRUB_CONTENT_RULES pass, at this point of the order
NAME_RULES = _identity_rules() + [
    # (name, compiled regex, replacement, prefilter) — applied in this order. The
    # prefilter is a literal that must be in the data (or, as ("low", x), in its
    # lower-cased copy) before the regex runs: speed only, never a different result.
    ("runs", re.compile(_path_rx(SCRUB_RUNS)[0]), b"<runs>", _path_rx(SCRUB_RUNS)[1]),
    ("repo", re.compile(_path_rx(SCRUB_REPO)[0]), b"<repo>", _path_rx(SCRUB_REPO)[1]),
    ("scratchpad", re.compile(rb"/tmp/claude-\d+/" + HOME_DASHED_RX + rb"-[A-Za-z0-9\-]*/[0-9a-f\-]{36}(?:/scratchpad)?"), b"<scratchpad>", b"/" + HOME_DASHED + b"-"),
    ("claude-project", re.compile(rb"\.claude/projects/" + HOME_DASHED_RX + rb"-[A-Za-z0-9\-]*"), b".claude/projects/<project>", b"/" + HOME_DASHED + b"-"),
    ("home", re.compile(HOME_RX + rb"(?![A-Za-z0-9_\-])"), b"<home>", HOME_B),
    ("home-dashed", re.compile(HOME_DASHED_RX + rb"(?=[-/])"), b"-<home>", HOME_DASHED),
    ("home-escaped", re.compile(HOME_ESC_RX + rb"(?![A-Za-z0-9_\-])"), b"<home>", HOME_ESC),
    ("pi-login-volume", re.compile(rb"companion-pihome"), b"<pi-login-volume>", b"companion-pihome"),
    *_private_token_rules(),
    # study renames (scrub_extra.rename_rules): before the tracker's rules, which would make a ticket of them
    *SX.rename_rules(),
    CONTENT,
    # the authors' tracker (scrub_extra.TICKET_RULES): after the content rules,
    # which may spell a tracker id of their own
    *SX.ticket_rules(),
]  # the rules that also apply to member names
RULES = NAME_RULES + [
    ("blob-encrypted_content", re.compile(rb"(encrypted_content" + ESCQ + rb")" + B64 + rb"+"), rb"\1", b"encrypted_content"),
    ("blob-thinkingSignature", re.compile(rb"(thinkingSignature" + ESCQ + rb")" + B64 + rb"{40,}"), rb"\1", b"thinkingSignature"),
    ("blob-signature", re.compile(rb"(signature" + ESCQ + rb")" + B64 + rb"{100,}"), _sig_keep, b"signature"),
]


def rewrite(data: bytes, counts: collections.Counter, rules=RULES) -> bytes:
    low = None
    for name, rx, rep, pre in rules:
        if name == "content-rules":
            if CONTENT_RULES is not None:
                data = CONTENT_RULES.apply(data, counts)
                low = None
            continue
        if isinstance(pre, tuple):
            if low is None:
                low = data.lower()
            if pre[1] not in low:
                continue
        elif pre not in data:
            continue
        if callable(rep):
            n = sum(1 for m in rx.finditer(data) if rep(m) != m.group(0))
            data = rx.sub(rep, data)
        else:
            data, n = rx.subn(rep, data)
        if n:
            counts[name] += n
            low = None
    return data


def rewrite_name(name: str, counts: collections.Counter) -> str:
    return rewrite(name.encode(), counts, NAME_RULES).decode()


TEXT_EXT = (".log", ".txt", ".json", ".jsonl", ".md", ".sh", ".py", ".toml", ".yml", ".yaml", ".csv", ".diff", ".patch",
            ".html", ".tex", ".env", ".cfg", ".ini")


def is_text(data: bytes, name: str = "") -> bool:
    """Text unless a NUL shows in its first 64 KiB; a file with a text
    extension is text whatever it holds (a driver log can carry a stray NUL
    and still quote a host path)."""
    return b"\x00" not in data[:65536] or name.lower().endswith(TEXT_EXT)


def omitted(text: str, link: str) -> str:
    h = hashlib.sha256(text.encode()).hexdigest()[:16]
    return f"[third-party text omitted, sha256:{h}; see {link}]"


# ---------------------------------------------------------------- paths and units

def run_parts(rel: str) -> tuple[str, list[str]] | None:
    """(run entry, the path parts inside it) for a file under a runs/ dir
    (`runs/<x>/...` or `open-models/runs/<x>/...`), else None."""
    parts = rel.split("/")
    if parts[0] == "runs" and len(parts) > 1:
        return parts[1], parts[2:]
    if parts[0] == OM and len(parts) > 2 and parts[1] == "runs":
        return parts[2], parts[3:]
    return None


def case_of(rel: str) -> tuple[str, str] | None:
    """(the case dir's archive path, the instance id) for a file directly in
    a run's `cases/<iid>/`, else None."""
    parts = rel.split("/")
    if len(parts) >= 3 and parts[-3] == "cases":
        return "/".join(parts[:-1]), parts[-2]
    return None


# the AACR re-scoring shim's error lines quote the judge's argv, prompt included: only the error class ships
SHIM_LOG = re.compile(r"(?:^|/)(?:shim-[\w.+-]+|judge-shim)\.log$")
SHIM_ERROR = re.compile(rb"^(judge error: )(.*)$", re.M)


def unit_prefix(rel: str) -> str:
    """The archive path of the unit (run dir, top-level tree) a file is in."""
    parts = rel.split("/")
    if parts[0] == "runs":
        return "/".join(parts[:2])
    if parts[0] == OM:
        return "/".join(parts[:3]) if parts[1] == "runs" and len(parts) > 2 else "/".join(parts[:2])
    return parts[0]


# the suffixes a run's scoring dirs and logs beside it carry (`<run>.martian`, `<run>.review.log`, ...)
RUN_SUFFIX = re.compile(r"^\.(?:log|launch\.log|resume\.log|prefetch\.log|sandbox-commands\.log|review(?:\.first)?\.log"
                        r"|arm\.(?:json|log)|judge(?:-opus|-gpt)?\.log"
                        r"|eval2?\.log|rebuild\.log|rejudge\.log|(?:interim1\.)?score\.log"
                        r"|martian(?:-rescore|-alone|-interim1)?|qodo(?:-rescore|-full|-interim1)?|sweprbench(?:-MOCK)?)$")


def strip_run_suffix(name: str) -> str:
    """`name` without a known run suffix (RUN_SUFFIX); unchanged when it has none."""
    for i in range(1, len(name)):
        if name[i] == "." and RUN_SUFFIX.match(name[i:]):
            return name[:i]
    return name


class Tree:
    """The source trees: which unit (run dir, top-level entry) every file
    belongs to, and where a file's bytes are."""

    def __init__(self, src: Path, om: Path | None = None):
        self.src, self.om = src, om
        self.run_dirs = {"runs": self._dirs(src / "runs"), "om-runs": self._dirs(om / "runs") if om else []}

    @staticmethod
    def _dirs(d: Path) -> list[str]:
        if not d.is_dir():
            return []
        return sorted((p.name for p in d.iterdir() if p.is_dir() and not p.name.startswith(".")), key=len, reverse=True)

    def fs(self, rel: str) -> Path:
        if rel.split("/", 1)[0] == OM:
            if self.om is None:
                raise SystemExit(f"{rel}: no --open-models dir")
            return self.om / rel.split("/", 1)[1]
        return self.src / rel

    def run_of(self, name: str, kind: str = "runs") -> str:
        """The run a `runs/` entry belongs to: the run dir itself, or a run
        dir plus one of the known scoring and log suffixes. Any other suffix
        is its own (uncatalogued, so withheld) unit."""
        for d in self.run_dirs[kind]:
            if name == d or (name.startswith(d + ".") and RUN_SUFFIX.match(name[len(d):])):
                return d
        return strip_run_suffix(name)

    def unit(self, rel: str) -> tuple[str, str]:
        parts = rel.split("/")
        if parts[0] == "runs":
            return "runs", (parts[1] if parts[1].startswith(".") else self.run_of(parts[1], "runs"))
        if parts[0] == OM:
            if parts[1] == "runs" and len(parts) > 2:
                return "om-runs", (parts[2] if parts[2].startswith(".") else self.run_of(parts[2], "om-runs"))
            return "om-top", parts[1]
        return "top", parts[0]


# ---------------------------------------------------------------- per-file policy

# the blind annotation's prompts (they quote PR bodies and every tool's candidates, vendors' included)
# and the analysis agents' working notes; the scripts and data outputs beside them ship
ANALYSIS_PROMPTS = re.compile(r"analysis/[^/]+/fair/(?:INSTRUCTIONS\.md|packets/|appendix\.md)")
ANALYSIS_NOTES = re.compile(r"analysis/[^/]+/(?:ext-bench/DECISIONS-PENDING\.md|paper-research/[^/]+\.md"
                            r"|paper-data/factcheck(?:/[^/]+|-analyses)\.md|paper-examples/examples-notes\.md)$")
SWEPR_HUMAN = re.compile(r"analysis/sweprbench-[^/]+/(human-all\.txt|joined\.json|misses\.txt|samples\.json|files/)")
ELO_PACKS = "regenerable: Elo packs (whole files of the reviewed repositories; `elo.py pack` rebuilds them from the public repos)"


def drop_reason(rel: str) -> str | None:
    """The path rules every export applies, whatever the catalogue says."""
    parts = rel.split("/")
    name = parts[-1]
    if parts[0] in NEVER or "notes" == parts[0]:
        raise SystemExit(f"refusing to read {rel}: {parts[0]}/ never ships")
    if "__pycache__" in parts or name.endswith(".pyc") or name == ".DS_Store":
        return "cache files"
    rp = run_parts(rel)
    if rp:
        run, inner = rp
        if run.startswith("."):
            return "scheduler state (runs/.slots)"
        if any(run == r or run.startswith(r + ".") for r in PRIVATE_RUNS):
            return "withheld: QuickReview reviewing our own repositories (not a benchmark run)"
        if run.startswith(OWNER_WITHHELD_PREFIXES):
            return OWNER_WITHHELD
        if ".martian" in run and (name == "published-benchmark_data.json" or "golden_comments" in inner):
            return "third-party: Martian's own data (pin withmartian/code-review-benchmark@e616e84)"
    if parts[0] == "elo" and len(parts) > 2 and parts[2] == "packs":
        return ELO_PACKS
    sl = SL.classify(rel)
    if sl is not None and sl[1] is None:
        return sl[0]  # a session log with no extract (prompts, process logs, unknown log kinds)
    if parts[0].endswith("-code"):
        if len(parts) > 2 and parts[2] in ("repo.git", "base", "head"):
            return "regenerable: reviewed-repo code (refetch repo@commit)"
        if name in ("pr.diff",):
            return "regenerable: reviewed-repo code (refetch repo@commit)"
    if parts[0] == "analysis":
        if ANALYSIS_PROMPTS.match(rel):
            return "session log: an annotator's or agent's prompt (the instructions and per-PR packets; no extract)"
        if ANALYSIS_NOTES.match(rel):
            return "working notes: the analysis agents' planning and fact-check notes (no published number rests on them)"
        if SWEPR_HUMAN.match(rel):
            return "third-party: SWE-PRBench human review comments (see foundry-ai/swe-prbench@b87f579)"
        if name.endswith(".diff"):
            return "regenerable: reviewed-repo code (refetch repo@commit)"
    return None


class ThirdParty:
    """Structural removal of third-party comment text from the files our
    tooling copied it into; everything else of those files is kept."""

    def __init__(self, src: Path, om: Path | None = None):
        self.src = src
        self.qodo_links = {}
        self.pr_urls = {}  # instance id -> its upstream PR (the open-model case sets list every Martian and Qodo PR)
        for sets in (sorted(om.glob("sets*/*.json")) if om is not None else []):
            try:
                for c in json.loads(sets.read_text()).get("cases") or []:
                    if isinstance(c, dict) and c.get("instance_id") and c.get("pr_url"):
                        self.pr_urls[c["instance_id"]] = c["pr_url"]
            except (ValueError, AttributeError):
                pass
        tc = src / "ext-cache" / "qodo" / "tool-comments.json"
        if tc.exists():  # only to build links; the file itself never ships
            for row in json.loads(tc.read_text()):
                for tool, v in (row.get("tools") or {}).items():
                    if v.get("fork") and v.get("pr"):
                        self.qodo_links[(row["pr_url"], tool)] = f"https://github.com/agentic-review-benchmarks/{v['fork']}/pull/{v['pr']}"
        self.meta = {}
        for code in ("orig40-code", "rest145-code", "fresh10-code"):
            d = src / code
            if d.is_dir():
                for m in d.glob("*/meta.json"):
                    try:
                        self.meta[m.parent.name] = json.loads(m.read_text())
                    except ValueError:
                        pass
        self._copilot = {}

    # ---- a case's PR description: the PR author's text, linked
    def pr_body(self, data: bytes, counts) -> bytes:
        m = json.loads(data)
        if isinstance(m.get("body"), str) and m["body"].strip():
            m["body"] = omitted(m["body"], f"https://github.com/{m.get('repo')}/pull/{m.get('pr')}")
            counts["third-party-omitted:pr-description"] += 1
        return (json.dumps(m, indent=2, ensure_ascii=False) + ("\n" if data.endswith(b"\n") else "")).encode()

    def pr_link(self, iid: str) -> str:
        m = self.meta.get(iid) or {}
        num = m.get("pr") or m.get("pr_number")
        if m.get("repo") and num:
            return f"https://github.com/{m['repo']}/pull/{num}"
        return self.pr_urls.get(iid) or f"the upstream PR of {iid}"

    # ---- PR-Agent's describe output: its first section is the PR author's own description
    USER_DESC = re.compile(r"### \*\*User description\*\*\n.*?(?=\n### \*\*|\Z)", re.S)

    def _user_description(self, text: str, link: str, counts) -> str:
        def sub(m):
            counts["third-party-omitted:pr-description (PR-Agent)"] += 1
            return "The PR author's description: " + omitted(m.group(0), link) + "\n"
        return self.USER_DESC.sub(sub, text)

    def pragent_describe(self, data: bytes, iid: str, counts) -> bytes:
        d = json.loads(data)
        link = self.pr_link(iid)
        if isinstance(d.get("pr_text"), str) and d["pr_text"].strip():
            d["pr_text"] = omitted(d["pr_text"], link)
            counts["third-party-omitted:pr-description (PR-Agent)"] += 1
        pub = d.get("published_description")
        if isinstance(pub, dict) and isinstance(pub.get("body"), str):
            pub["body"] = self._user_description(pub["body"], link, counts)
        return (json.dumps(d, indent=2, ensure_ascii=False) + ("\n" if data.endswith(b"\n") else "")).encode()

    def pragent_description_md(self, data: bytes, iid: str, counts) -> bytes:
        return self._user_description(data.decode(errors="replace"), self.pr_link(iid), counts).encode()

    # ---- the open-model case sets: each case's PR description, linked
    def set_bodies(self, data: bytes, counts) -> bytes:
        d = json.loads(data)
        for c in d.get("cases") or [] if isinstance(d, dict) else []:
            if isinstance(c, dict) and isinstance(c.get("body"), str) and c["body"].strip():
                c["body"] = omitted(c["body"], c.get("pr_url") or self.pr_link(c.get("instance_id") or ""))
                counts["third-party-omitted:pr-description"] += 1
        return (json.dumps(d, indent=2, ensure_ascii=False) + ("\n" if data.endswith(b"\n") else "")).encode()

    # ---- Martian: the re-judged published tools' review bodies
    def martian_benchmark_data(self, data: bytes, counts) -> bytes:
        d = json.loads(data)
        n = 0
        for url, v in d.items():
            for r in v.get("reviews") or []:
                if not str(r.get("tool", "")).startswith("rejudged-"):
                    continue
                for c in r.get("review_comments") or []:
                    if c.get("body"):
                        c["body"] = omitted(c["body"], f"{MARTIAN_SRC} ({url}, {r['tool'][9:]})")
                        n += 1
        counts["third-party-omitted:martian-vendor-comment"] += n
        return (json.dumps(d, indent=2) + "\n").encode()

    # ---- Qodo: the nine vendors' inline comments, as judged
    def qodo_judgements(self, data: bytes, counts) -> bytes:
        out = []
        for line in data.decode().splitlines():
            if not line.strip():
                out.append(line)
                continue
            j = json.loads(line)
            if j.get("tool") in QODO_VENDORS:
                link = self.qodo_links.get((j.get("pr"), j["tool"]), f"the {j['tool']} fork PR of {j.get('pr')}")
                for c in j.get("comments") or []:
                    if c.get("body"):
                        c["body"] = omitted(c["body"], link)
                        counts["third-party-omitted:qodo-vendor-comment"] += 1
            out.append(json.dumps(j, ensure_ascii=False))
        return ("\n".join(out) + ("\n" if data.endswith(b"\n") else "")).encode()

    # ---- the harvested upstream Copilot reviews (arm upstream-copilot2025)
    def copilot_texts(self, run_dir: Path) -> dict:
        key = str(run_dir)
        if key not in self._copilot:
            texts = {}
            for f in sorted((run_dir / "results" / "all").glob("*@*.json")):
                r = json.loads(f.read_text())
                repo, iid = r.get("repo"), r.get("instance_id")
                num = (self.meta.get(iid) or {}).get("pr") or (self.meta.get(iid) or {}).get("pr_number")
                rev = [x.get("id") for x in ((r.get("bench") or {}).get("harvest") or {}).get("reviews") or []]
                link = f"https://github.com/{repo}/pull/{num}" + (f"#pullrequestreview-{rev[0]}" if rev else "") if num else f"the Copilot review of {repo} at {r.get('head_commit')}"
                texts[("link", iid)] = link
                for c in (r.get("review") or {}).get("comments") or []:
                    t = c.get("content")
                    if isinstance(t, str) and t.strip():
                        texts[t] = link
                        texts.setdefault(t.strip(), link)
            self._copilot[key] = texts
        return self._copilot[key]

    def copilot_file(self, run_dir: Path, rel_in_run: str, data: bytes, counts) -> bytes | None:
        """None = drop the file (the judge's own transcript quotes the
        reviews inside its prompt); else the file with every harvested comment
        replaced by its marker."""
        if rel_in_run.endswith(".events.jsonl") or rel_in_run.endswith(".events.stderr.log"):
            return None
        texts = {k: v for k, v in self.copilot_texts(run_dir).items() if isinstance(k, str)}
        for t in sorted(texts, key=len, reverse=True):
            mark = omitted(t.strip(), texts[t])
            for enc_t, enc_m in ((t, mark), (json.dumps(t)[1:-1], json.dumps(mark)[1:-1]),
                                 (json.dumps(t, ensure_ascii=False)[1:-1], json.dumps(mark, ensure_ascii=False)[1:-1])):
                b = enc_t.encode()
                if b and b in data:
                    k = data.count(b)
                    data = data.replace(b, enc_m.encode())
                    counts["third-party-omitted:copilot-upstream-comment"] += k
        if rel_in_run.endswith("review.md") and rel_in_run.startswith("cases/"):
            # the harvested review as markdown: keep the header lines, links only
            keep = [ln for ln in data.decode(errors="replace").splitlines() if ln.startswith("<!--")]
            iid = rel_in_run.split("/")[1]
            link = self.copilot_texts(run_dir).get(("link", iid), f"the upstream PR of {iid}")
            data = ("\n".join(keep + ["", "Harvested upstream review; its text is third-party and is not copied here.",
                                      f"Instance {iid}. Read it on GitHub: {link}", ""])).encode()
            counts["third-party-omitted:copilot-review-md"] += 1
        return data


# ---------------------------------------------------------------- walking

def walk_files(src: Path, om: Path | None = None, tops=SHIPPED_TOPS, om_too: bool = True):
    """Every file of the shipped top-level trees, as archive paths; the
    open-model dir's files under `open-models/`."""
    roots = [(src / top, top) for top in tops]
    if om is not None and om_too:
        roots.append((om, OM))
    for root, label in roots:
        if not root.exists():
            continue
        if root.is_file():
            yield label
            continue
        for dp, dns, fns in os.walk(root):
            rel_dp = label + ("" if Path(dp) == root else "/" + os.path.relpath(dp, root))
            depth = rel_dp.count("/")
            # never descend into the reviewed repos' code (it is left out anyway)
            dns[:] = sorted(d for d in dns if not (label.endswith("-code") and depth == 1 and d in ("repo.git", "base", "head")))
            for fn in sorted(fns):
                yield f"{rel_dp}/{fn}"


def variant_sources(tree: Tree, run: str) -> list[str]:
    v = tree.src / "runs" / run / "VARIANT.json"
    if not v.exists():
        return []
    s = json.loads(v.read_text()).get("policy", {}).get("src") or []
    return [s] if isinstance(s, str) else list(s)


def sha256_file(p: Path) -> str:
    h = hashlib.sha256()
    with open(p, "rb") as fh:
        for chunk in iter(lambda: fh.read(1 << 20), b""):
            h.update(chunk)
    return h.hexdigest()


# Runs that copy another run's files (posting-policy variants, assembled
# multi-lane runs, the DeepSeek mix, the 40-PR comparison re-judges, a copied
# smoke, whatif): when a file is in one of these and in a source run, the
# source's copy is the one that ships.
# Read against the release's names (scrub_extra.renamed), so an assembled ccvq run matches
# whatever its source dir is called.
COPY_RUN = re.compile(r"^(?:runs/(?:mv|mt|qr|t30)-|whatif$|open-models/runs/(?:dsv41f-mix-|s40cmp-|glm53-smoke-7879ddc5-glm-|argon4-smoke-)"
                      r"|runs/ccvq-(?:hard20|m50)-(?!.*(?:-L\d+|__|-interim|-probe)$)[^/]*$)")
ASSEMBLED = re.compile(r"^ccvq-(?:hard20|m50)-")


def copy_rank(rel: str) -> int:
    return 1 if COPY_RUN.match(SX.renamed(unit_prefix(rel))) else 0


def designated_sources(tree: Tree, prefix: str) -> list[str]:
    """The unit prefixes whose same-path files this unit's files may copy
    byte for byte (not by hardlink): a posting-policy variant's sources, an
    assembled ccvq run's lanes, the copied GLM smoke's original."""
    parts = prefix.split("/")
    if parts[0] == "runs":
        run = parts[1]
        out = [f"runs/{s}" for s in variant_sources(tree, run)]
        if ASSEMBLED.match(SX.renamed(run)) and not re.search(r"(?:-L\d+|__|-interim|-probe)", run):
            out += [f"runs/{d}" for d in sorted(tree.run_dirs["runs"]) if d.startswith(run + "-")]
        return out
    if parts[0] == OM and len(parts) > 2:
        m = re.match(r"^glm53-smoke-7879ddc5-glm-(.+)$", parts[2])
        if m:
            return [f"{OM}/runs/glm53-smoke-7879ddc5-1013-1822-glm-{m.group(1)}"]
    return []


def plan_copies(tree: Tree, shipped: list[str], only: set[str] | None = None) -> dict[str, str]:
    """rel -> the rel of the identical file that ships in its place. A
    hardlinked file ships once, at its least copy-like path; a file of a
    designated copy run that is byte-identical to the same path in one of its
    sources ships as the source's. `only`: the rels whose byte copies to look
    for (default all; hardlinks are always resolved over every shipped file)."""
    ship = set(shipped)
    by_inode: dict[tuple[int, int], list[str]] = collections.defaultdict(list)
    for rel in shipped:
        try:
            st = os.stat(tree.fs(rel))
        except OSError:
            continue
        if st.st_nlink > 1:
            by_inode[(st.st_dev, st.st_ino)].append(rel)
    out: dict[str, str] = {}
    for rels in by_inode.values():
        if len(rels) < 2:
            continue
        canon = min(rels, key=lambda r: (copy_rank(r), r))
        for r in rels:
            if r != canon:
                out[r] = canon
    srcs_cache: dict[str, list[str]] = {}
    hashes: dict[str, str] = {}

    def h(rel):
        if rel not in hashes:
            hashes[rel] = sha256_file(tree.fs(rel))
        return hashes[rel]
    for rel in shipped:
        if rel in out or (only is not None and rel not in only):
            continue
        pre = unit_prefix(rel)
        if pre not in srcs_cache:
            srcs_cache[pre] = designated_sources(tree, pre)
        inner = rel[len(pre) + 1:]
        if not inner:
            continue
        for s in srcs_cache[pre]:
            other = f"{s}/{inner}"
            if other not in ship:
                continue
            try:
                if os.path.getsize(tree.fs(other)) != os.path.getsize(tree.fs(rel)) or h(other) != h(rel):
                    continue
            except OSError:
                continue
            out[rel] = out.get(other, other)
            break
    # resolve chains (a copy of a copy ships as the first one)
    for k in list(out):
        seen = {k}
        while out[k] in out and out[k] not in seen:
            seen.add(out[k])
            out[k] = out[out[k]]
    return out


QCR_COMMIT = re.compile(rb'("qcr_commit"\s*:\s*)"([0-9a-f]{7,40})(-dirty)?"')


def remap_commits(data: bytes, remap: dict, counts, evidence: dict | None = None) -> bytes:
    """Every `"qcr_commit": "<sha>"` of a JSON text, remapped to the public
    main commit the history rewrite made of it (release_catalogue.remap_commit),
    with a `qcr_commit_on_public_main` beside it: true when remapped, false
    when the commit has no public equivalent (the recorded id is kept), null
    when the remap does not know the commit; a `qcr_commit_match`: how the
    public main commit was matched (the remap's `evidence`, RC.MATCH_KINDS;
    null when not remapped); and a `qcr_commit_dirty`: true when the recorded
    id carries `-dirty` (built with uncommitted changes; the suffix stays on
    the published id), false otherwise. The text around it is untouched."""
    if b'"qcr_commit"' not in data:
        return data

    def sub(m):
        f = RC.commit_fields((m.group(2) + (m.group(3) or b"")).decode(), remap, evidence)
        on = f["qcr_commit_on_public_main"]
        counts[{True: "qcr_commit remapped to public main", False: "qcr_commit not on public main",
                None: "qcr_commit unknown to the remap"}[on]] += 1
        if f["qcr_commit_match"]:
            counts[f"qcr_commit matched: {f['qcr_commit_match']}"] += 1
        if f["qcr_commit_dirty"]:
            counts["qcr_commit dirty build (flagged)"] += 1
        return (m.group(1) + json.dumps(f["qcr_commit"]).encode()
                + b', "qcr_commit_on_public_main": ' + json.dumps(on).encode()
                + b', "qcr_commit_match": ' + json.dumps(f["qcr_commit_match"]).encode()
                + b', "qcr_commit_dirty": ' + json.dumps(f["qcr_commit_dirty"]).encode())
    return QCR_COMMIT.sub(sub, data)


class Processor:
    """Decides and transforms one file; shared by archive and slim."""

    def __init__(self, src: Path, om: Path | None, cat: RC.Catalogue, remap: dict | None = None,
                 evidence: dict | None = None):
        self.src, self.om, self.cat = src, om, cat
        self.tree = Tree(src, om)
        self.tp = ThirdParty(src, om)
        self.remap = remap or {}
        self.evidence = evidence or {}

    def family(self, rel: str) -> dict | None:
        """The run family of a file's unit. A file beside the run dirs
        (`<run>.review.log`, `<run>.arm.json`) whose run dir is gone is matched
        by stripping its suffixes; no match is no family (withheld)."""
        kind, name = self.tree.unit(rel)
        f = self.cat.family_of(kind, name)
        if f is None and kind in ("runs", "om-runs") and strip_run_suffix(name) != name:
            f = self.cat.family_of(kind, strip_run_suffix(name))
        return f

    def group(self, rel: str) -> str | None:
        f = self.family(rel)
        return f["id"] if f else None

    def drop(self, rel: str) -> str | None:
        f = self.family(rel)
        if not RC.Catalogue.ships(f):
            return RC.Catalogue.withheld_reason(f)
        return drop_reason(rel)

    @staticmethod
    def arc_rel(rel: str) -> str:
        """Where a shipped file lands: a session log's extract at its own name,
        anything else at its path."""
        sl = SL.classify(rel)
        return SL.extract_name(rel) if sl is not None and sl[1] else rel

    def process(self, rel: str, counts: collections.Counter) -> tuple[bytes | None, str | None]:
        """(content, None) to ship, or (None, reason) to leave out. A session
        log ships as its numbers-only extract (session_logs.py); ship it at
        arc_rel(rel)."""
        r = self.drop(rel)
        if r:
            return None, r
        p = self.tree.fs(rel)
        data = p.read_bytes()
        sl = SL.classify(rel)
        if sl is not None and sl[1]:
            out = SL.extract(sl[1], data)
            if sl[1] == "pi":
                check_pi_cost(data, out, counts)
            counts[f"session-log extracts ({sl[1]})"] += 1
            counts["session-log bytes left out"] += len(data)
            data = rewrite(out, counts)
            counts["files-text"] += 1
            return data, None
        parts = rel.split("/")
        name = parts[-1]
        rp = run_parts(rel)
        if rp and rp[1]:
            run, inner = rp
            if ".martian" in run and inner[-1] == "benchmark_data.json":
                data = self.tp.martian_benchmark_data(data, counts)
            elif ".qodo" in run and inner[-1] == "judgements.jsonl":
                data = self.tp.qodo_judgements(data, counts)
            elif parts[0] == "runs" and run.startswith("upstream-copilot"):
                data = self.tp.copilot_file(self.src / "runs" / run, "/".join(inner), data, counts)
                if data is None:
                    return None, "third-party: the judge transcript quotes harvested Copilot reviews (verdicts kept)"
        if parts[0].endswith("-code") and parts[-1] == "meta.json":
            data = self.tp.pr_body(data, counts)
        case = case_of(rel)
        if name == "pragent-describe.json" and case:
            data = self.tp.pragent_describe(data, case[1], counts)
        elif name == "pragent-description.md" and case:
            data = self.tp.pragent_description_md(data, case[1], counts)
        elif parts[0] == OM and len(parts) == 3 and parts[1].startswith("sets") and name.endswith(".json"):
            data = self.tp.set_bodies(data, counts)
        if rel.endswith(".json"):
            data = self.session_fields(rel, data, counts)
            data = remap_commits(data, self.remap, counts, self.evidence)
        elif case and name.lower() == "ledger.md":
            # the session's working ledger, seeded from its prompt; a review.md is the posted review and stays whole
            data = self.prompt_lines(case[0], data, counts)
        elif SHIM_LOG.search(rel):
            data = SHIM_ERROR.sub(lambda m: m.group(1) + b"[omitted: " + (SL.error_class(m.group(2).decode(errors="replace"))
                                                                          or "other").encode() + b"]", data)
        if is_text(data, rel):
            data = rewrite(data, counts)
            counts["files-text"] += 1
            bad = SL.content_markers(rel, data)
            if bad:
                # fail closed: a data file that still carries session or prompt text is left out
                for b in bad:
                    counts[f"left out, session text in a data file: {b}"] += 1
                return None, SL.R_CONTENT
        else:
            counts["files-binary"] += 1
        return data, None

    @staticmethod
    def session_fields(rel: str, data: bytes, counts) -> bytes:
        """A JSON file with its session-text fields rewritten (session_logs.strip_session_fields);
        unchanged bytes when no field needed it."""
        if not any(k in data for k in (b'"stdout"', b'"stderr"', b'"argv"', b'"template"', b'"permission_denials"', b'"prompt"')) \
                and not rel.endswith("-argv.json"):
            return data
        try:
            obj = json.loads(data)
        except ValueError:
            return data
        before = collections.Counter(counts)
        obj = SL.strip_session_fields(rel, obj, counts)
        if counts == before:
            return data
        return (json.dumps(obj, indent=1, ensure_ascii=False) + "\n").encode()

    def prompt_lines(self, case_rel: str, data: bytes, counts) -> bytes:
        """A case's markdown (its ledger) without the lines it copied from the case's own prompt files."""
        d = self.tree.fs(case_rel)
        prompts = []
        for f in [d / n for n in SL.PROMPT_FILES] + sorted(d.glob("*-task.md")) + sorted((d / "tasks").glob("*.md")):
            try:
                prompts.append(f.read_text(errors="replace"))
            except OSError:
                pass
        text = data.decode(errors="replace")
        if not prompts and SL.ROUNDORDER not in text:
            return data
        out, n = SL.strip_prompt_lines(text, prompts)
        if n:
            counts["session text: prompt lines copied into a case file"] += n
            return out.encode()
        return data


def check_pi_cost(full: bytes, pruned: bytes, counts) -> None:
    """compare.py prices a case from its extract exactly as from its full
    event stream (the lens ledger, a separate file, adds the same to both):
    every extract is priced both ways while it is written, and a difference
    is counted, never hidden."""
    import compare
    # speed only: every line pi_cost reads names one of these
    keep = (b'"message_end"', b'"tool_execution_', b'"kind"')
    a = compare.pi_cost_lines([ln for ln in full.splitlines() if any(k in ln for k in keep)])
    b = compare.pi_cost_lines(pruned.splitlines())
    counts["pi-cost checked"] += 1
    if abs(a - b) > 1e-9:
        counts["pi-cost differs (extract vs full)"] += 1


# ---------------------------------------------------------------- volumes

class VolumeWriter:
    def __init__(self, out: Path, stem: str, level: int, cap: int, threads: int):
        self.out, self.stem, self.level, self.cap, self.threads = out, stem, level, cap, threads
        self.volumes: list[dict] = []
        self.tar = self.proc = self.fh = None

    def _check_space(self):
        free = shutil.disk_usage(self.out).free
        if free < MIN_FREE:
            raise SystemExit(f"stopping: {free / GIB:.1f} GiB free on {self.out}, below the 8 GiB floor")

    def _open(self):
        self._check_space()
        n = len(self.volumes) + 1
        # written under a `.partial` name and renamed only in finish(), so an
        # interrupted run never leaves a file that looks complete
        path = self.out / f"{self.stem}.part{n:02d}.tar.zst.partial"
        self.fh = open(path, "wb")
        self.proc = subprocess.Popen(["zstd", f"-{self.level}", "--long=27", f"-T{self.threads}", "-B64MiB", "-q", "-c"],
                                     stdin=subprocess.PIPE, stdout=self.fh)
        self.tar = tarfile.open(fileobj=self.proc.stdin, mode="w|", format=tarfile.PAX_FORMAT)
        self.volumes.append({"path": path, "files": 0, "bytes_in": 0, "members": collections.Counter()})
        self._since_check = 0

    def _close(self):
        if self.tar is None:
            return
        self.tar.close()
        self.proc.stdin.close()
        if self.proc.wait() != 0:
            raise SystemExit(f"zstd failed for {self.volumes[-1]['path']}")
        self.fh.close()
        self.tar = self.proc = self.fh = None

    def add(self, arcname: str, data: bytes, mtime: float):
        if self.tar is None:
            self._open()
        elif os.fstat(self.fh.fileno()).st_size > self.cap - 256 * (1 << 20):
            self._close()
            self._open()
        ti = tarfile.TarInfo(arcname)
        ti.size, ti.mtime, ti.mode = len(data), int(mtime), 0o644
        ti.uid = ti.gid = 0
        ti.uname = ti.gname = ""
        self.tar.addfile(ti, io.BytesIO(data))
        v = self.volumes[-1]
        v["files"] += 1
        v["bytes_in"] += len(data)
        v["members"][unit_prefix(arcname)] += 1
        self._since_check += 1
        if self._since_check >= 2000:
            self._since_check = 0
            self._check_space()

    def finish(self) -> list[dict]:
        self._close()
        for v in self.volumes:
            p = v["path"]
            final = f"{self.stem}.tar.zst" if len(self.volumes) == 1 else p.name[:-len(".partial")]
            q = p.with_name(final)
            p.rename(q)
            v["path"] = q
        return self.volumes


def load_remap(path: str | None) -> tuple[dict, dict]:
    """The remap and its evidence by recorded id (release_catalogue.load_remap)."""
    return RC.load_remap(path)


def build_group(args) -> dict:
    src, om, catp, out, group, files, copies, level, cap, threads, remap = args
    src, out = Path(src), Path(out)
    proc = Processor(src, Path(om) if om else None, RC.Catalogue.load(catp), *load_remap(remap))
    counts = collections.Counter()
    dropped = collections.Counter()
    w = VolumeWriter(out, f"quickreview-runs-{group}", level, cap, threads)
    t0 = time.time()
    by_unit = collections.defaultdict(dict)
    names: dict[str, str] = {}

    def add(name: str, data: bytes, mtime: float, src: str = ""):
        # two files whose names differ only in a rewritten token would collide on extraction
        if name in names:
            raise SystemExit(f"{group}: two files pack to the same member name {name!r}")
        names[name] = src
        w.add(name, data, mtime)
    for rel in files:
        if rel in copies:
            # a session log's copy maps to its source's extract, by the same rule
            a, c = proc.arc_rel(rel), proc.arc_rel(copies[rel])
            by_unit[unit_prefix(a)][a[len(unit_prefix(a)) + 1:]] = c
            dropped["a copy of another shipped file (listed in its run's SOURCE-COPIES.json)"] += 1
            continue
        try:
            data, reason = proc.process(rel, counts)
        except FileNotFoundError:
            dropped["vanished during the walk"] += 1
            continue
        if reason:
            dropped[reason] += 1
            continue
        sl = SL.classify(rel)
        if sl is not None:
            dropped[sl[0]] += 1  # the session log itself; its extract ships in its place
        add(rewrite_name(proc.arc_rel(rel), counts), data, proc.tree.fs(rel).stat().st_mtime)
    for unit, m in sorted(by_unit.items()):
        doc = {"note": "Files of this run that are identical to another shipped file (a hardlink of it, or a "
                       "byte-identical copy of the same path in the run it was derived from) are not repeated in "
                       "the archive; each maps to the archive path of the copy that ships, which may be in another "
                       "volume.",
               "files": {rewrite_name(k, counts): rewrite_name(v, counts) for k, v in sorted(m.items())}}
        add(rewrite_name(f"{unit}/SOURCE-COPIES.json", counts), (json.dumps(doc, indent=1) + "\n").encode(), 0)
    if group == KEY_GROUP:
        for name, data in key_data_files(src, counts).items():
            add(name, data, time.time())
    if group == RELABEL_GROUP:
        for name, data in relabel_files(counts).items():
            add(name, data, time.time())
    vols = w.finish()
    return {"group": group, "volumes": [{**v, "path": str(v["path"]), "members": dict(v["members"])} for v in vols],
            "counts": dict(counts), "dropped": dict(dropped), "seconds": round(time.time() - t0)}


KEY_GROUP = "answer-key"  # the family whose volume carries key-data/
RELABEL_GROUP = "analysis"  # the family whose volume carries analysis/relabel/ (the slim bundle carries it too)


def relabel_files(counts) -> dict[str, bytes]:
    """analysis/relabel/: the two labelling passes' label files, their prompts and LABELS.json
    (bench/aacr/relabel/release.py, which refuses a label row without its model and its prompt's
    sha256), rewritten like every other text."""
    return {k: rewrite(v, counts) for k, v in RL.files().items()}


def key_data_files(src: Path, counts) -> dict[str, bytes]:
    """key-data/candidate-maps.json and key-data/pr-diffstats.json
    (key_data.py): which reviewer raised each key-building candidate, and each
    PR's diff.stat size, as data, rewritten like every other text."""
    docs = {
        "key-data/candidate-maps.json": {
            "note": "Which earlier run or reviewer raised each candidate the answer key was built from "
                    "(candidates-key.json: rest145's first key, C1..Cn -> run; new-candidates-key.json: the "
                    "extended key, N1..Nn -> reviewer), with the candidate's file, lines and text. One row per "
                    "candidate; the same rows as the Hugging Face config `aacr_candidates`.",
            "rows": KD.candidate_rows(str(src))},
        "key-data/pr-diffstats.json": {
            "note": "Each PR's size as the papers bucket it: files changed, insertions and deletions from the "
                    "summary line of its `git diff --stat base head` (diff.stat in the case dir). The same rows "
                    "as the Hugging Face config `pr_diffstats`.",
            "rows": KD.diffstat_rows(str(src))},
    }
    return {k: rewrite((json.dumps(v, indent=1, ensure_ascii=False) + "\n").encode(), counts) for k, v in docs.items()}


def _proc(a) -> Processor:
    if not a.catalogue:
        sys.exit("--catalogue is required: the run catalogue decides what ships")
    return Processor(Path(a.src), Path(a.open_models) if a.open_models else None, RC.Catalogue.load(a.catalogue),
                     *load_remap(getattr(a, "commit_remap", None)))


def classify(proc: Processor) -> tuple[dict, collections.Counter]:
    """group -> [shipped rel]; and (group, reason) -> files left out by the walk."""
    files = collections.defaultdict(list)
    left = collections.Counter()
    for rel in walk_files(proc.src, proc.om):
        r = proc.drop(rel)
        g = proc.group(rel)
        if r:
            left[(g or "(uncatalogued)", r)] += 1
            continue
        files[g].append(rel)
    return files, left


def cmd_plan(a):
    proc = _proc(a)
    size, n = collections.Counter(), collections.Counter()
    files, left = classify(proc)
    for g, rels in files.items():
        for rel in rels:
            try:
                size[g] += proc.tree.fs(rel).stat().st_size
            except OSError:
                continue
            n[g] += 1
    for g in sorted(files):
        print(f"{g:40} {n[g]:8} files {size[g] / GIB:8.2f} GiB raw (before de-duplication)")
    print()
    for (g, r), k in sorted(left.items()):
        print(f"left out {g:40} {k:8}  {r}")
    # the file names behind the fail-closed rule, so each can be named as data or as a session log
    shapes = collections.Counter()
    for rel in walk_files(proc.src, proc.om):
        sl = SL.classify(rel)
        if sl is not None and sl[0] == SL.R_UNKNOWN and RC.Catalogue.ships(proc.family(rel)):
            shapes[re.sub(r"\d+", "N", SL.run_inner(rel) or rel)] += 1
    for k, n in shapes.most_common(60):
        print(f"unknown log kind {n:8}  {k}")


def group_done(out: Path, group: str) -> bool:
    """A group is done when MANIFEST.json lists it and every volume it lists
    exists at the recorded size (the manifest is written only after the
    volumes were renamed from `.partial`)."""
    man = out / "MANIFEST.json"
    if not man.exists():
        return False
    g = json.loads(man.read_text()).get("groups", {}).get(group)
    return bool(g) and all((out / v["file"]).is_file() and (out / v["file"]).stat().st_size == v["bytes"] for v in g["volumes"])


def clear_group(out: Path, group: str):
    """Remove whatever an earlier, interrupted or superseded build of this
    group left (partials and finished volumes alike) before rebuilding it."""
    for p in out.glob(f"quickreview-runs-{group}.*"):
        print(f"  removing {p.name} (rebuilding {group})", flush=True)
        p.unlink()


def cmd_archive(a):
    """Resumable: a group whose volumes the manifest already records is
    skipped (unless --rebuild); each finished group is written to the
    manifest the moment it completes, so a kill loses only the groups in
    flight, which leave nothing but `.partial` files."""
    proc = _proc(a)
    out = Path(a.out)
    out.mkdir(parents=True, exist_ok=True)
    print("walking and classifying …", flush=True)
    files, left = classify(proc)
    shipped = [r for rels in files.values() for r in rels]
    groups = sorted(g for g in files if not a.groups or g in a.groups.split(","))
    print(f"  {len(shipped):,} files ship in {len(files)} families; planning copies …", flush=True)
    copies = plan_copies(proc.tree, shipped, None if not a.groups else {r for g in groups for r in files[g]})
    print(f"  {len(copies):,} are copies of another shipped file", flush=True)
    (out / "LEFT-OUT.json").write_text(json.dumps({"note": "Files the walk left out, per run family and reason "
                                                          "(withheld families, path rules); the copies and third-party "
                                                          "drops made while packing are in MANIFEST.json.",
                                                  "files": {f"{g} :: {r}": k for (g, r), k in sorted(left.items())}},
                                                 indent=1) + "\n")
    todo = []
    for g in groups:
        if group_done(out, g) and not a.rebuild:
            print(f"  {g}: already complete in MANIFEST.json, skipped (--rebuild to redo)", flush=True)
        else:
            todo.append(g)
    for g in todo:
        clear_group(out, g)
    jobs = [(str(proc.src), str(proc.om) if proc.om else None, a.catalogue, str(out), g, files[g],
             {r: copies[r] for r in files[g] if r in copies}, a.level, a.cap, a.threads,
             getattr(a, "commit_remap", None)) for g in todo if files[g]]
    jobs.sort(key=lambda j: -sum(1 for r in j[5] if r not in j[6]))
    if jobs:
        with multiprocessing.Pool(min(a.jobs, len(jobs)), maxtasksperchild=1) as pool:
            for r in pool.imap_unordered(build_group, jobs):
                for v in r["volumes"]:
                    print(f"  {Path(v['path']).name}: {v['files']} files, {os.path.getsize(v['path']) / (1 << 20):.1f} MiB "
                          f"({r['seconds']} s)", flush=True)
                write_manifest(out, proc, [r], a)
    write_index(out, proc, a)
    missing = [g for g in files if not group_done(out, g)]
    if missing:
        print(f"README not written: groups still to build: {', '.join(missing)}")
    else:
        write_readme(out, proc)


def write_manifest(out: Path, proc: Processor, results: list, a):
    # one invocation per group may run side by side: the manifest's
    # read-modify-write holds an exclusive lock, and lands by rename
    import fcntl
    # the lock sits beside the folder, never in it (the folder is uploaded as it is)
    with open(out.parent / f".{out.name}-MANIFEST.lock", "w") as lock:
        fcntl.flock(lock, fcntl.LOCK_EX)
        _write_manifest(out, proc, results, a)


def _write_manifest(out: Path, proc: Processor, results: list, a):
    man_path = out / "MANIFEST.json"
    prior = json.loads(man_path.read_text()) if man_path.exists() else {"groups": {}}
    for r in results:
        vols = []
        for v in r["volumes"]:
            p = Path(v["path"])
            vols.append({"file": p.name, "bytes": p.stat().st_size, "sha256": sha256_file(p),
                         "files": v["files"], "uncompressed_bytes": v["bytes_in"], "files_by_unit": v["members"]})
        fam = proc.cat.families.get(r["group"], {})
        prior["groups"][r["group"]] = {"what": rewrite(str(fam.get("title") or r["group"]).encode(), collections.Counter()).decode(),
                                       "ship": fam.get("ship"), "volumes": vols, "rewrites": r["counts"],
                                       "left_out": r["dropped"]}
    prior.update({
        "created": datetime.datetime.now(datetime.timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ"),
        "compression": f"zstd -{a.level} --long=27 (window 128 MiB: any zstd >= 1.3.2 decodes it without flags)",
        "volume_cap_bytes": a.cap,
        "rewrites_applied": list(dict.fromkeys(r[0] for r in RULES)),
        "content_rules": len(CONTENT_RULES) if CONTENT_RULES is not None else 0,
        "placeholders": {"credential values": "<redacted-secret>",
                         "the owner's name": "<owner>", "the review bot's login and slug": "<review-bot>",
                         "the product's earlier name": "quickreview",
                         "the private product repository's name": "<private-repo>",
                         "private tokens (a personal handle, a private commit id, an account id)": "<private>",
                         "private host names": "<private-host>",
                         "the authors' tracker: ticket ids (FT-NNNN) and paths into it": "<ticket>",
                         "the bench runs dir": "<runs>",
                         "the repo checkout": "<repo>",
                         "the exporting user's home directory": "<home>", "companion-pihome": "<pi-login-volume>",
                         "/tmp/claude-<uid>/-<home>-<project>/<session>/scratchpad": "<scratchpad>",
                         ".claude/projects/-<home>-<project>": ".claude/projects/<project>"},
    })
    tmp = man_path.with_suffix(".json.partial")
    tmp.write_text(json.dumps(prior, indent=1, sort_keys=False) + "\n")
    tmp.rename(man_path)
    lines = []
    for g in prior["groups"].values():
        for v in g["volumes"]:
            lines.append(f"{v['sha256']}  {v['file']}")
    (out / "SHA256SUMS.partial").write_text("\n".join(sorted(lines, key=lambda x: x.split()[1])) + "\n")
    (out / "SHA256SUMS.partial").rename(out / "SHA256SUMS")
    print(f"wrote {man_path} and SHA256SUMS")


# ---------------------------------------------------------------- the run index

def scrub_json(obj):
    """rewrite() over a JSON value's text (identities, paths, content rules)."""
    return json.loads(rewrite(json.dumps(obj, ensure_ascii=False).encode(), collections.Counter()).decode())


def write_index(out: Path, proc: Processor, a):
    """RUNS-INDEX.json: every shipped unit with its family's facts, its
    run.json facts and the volume it is in; every withheld family and why."""
    remap, evidence = load_remap(getattr(a, "commit_remap", None))
    man = json.loads((out / "MANIFEST.json").read_text()) if (out / "MANIFEST.json").exists() else {"groups": {}}
    vols = {g: [v["file"] for v in d["volumes"]] for g, d in man["groups"].items()}
    roots = {"runs": str(proc.src / "runs"), "top": str(proc.src)}
    if proc.om:
        roots.update({"om-runs": str(proc.om / "runs"), "om-top": str(proc.om)})
    rows = RC.index_rows(proc.cat, roots, remap, lambda fid: vols.get(fid, []), evidence=evidence)
    claim_ids = {c for r in rows for c in r["claims"]}
    doc = {"note": "One row per shipped unit (a run dir, a scoring dir, or a top-level tree) of the QuickReview "
                   "benchmark runs: its run family, what the family was for, the model it billed, its judges, the "
                   "public claims it backs, its build commit (`qcr_commit`: the public main commit the "
                   "recorded one became after the repository's history rewrite, `qcr_commit_on_public_main` true, "
                   "and `qcr_commit_match` how it was matched: `same` by the rewrite's commit maps, `date+subject` "
                   "by author date and subject alone (no unit in this release), `ancestor` the nearest kept "
                   "ancestor of a commit the rewrite dropped because it changed only unpublished files; a commit "
                   "with no public equivalent (a side branch never merged, or another clone's commit that no "
                   "rewrite map holds) keeps its recorded id with false and a null match; separately, "
                   "`qcr_commit_dirty` true for a build from a checkout with uncommitted or untracked files, which "
                   "maps to the commit it was built on and keeps the `-dirty` suffix: that commit plus whatever was "
                   "not committed, not necessarily the commit itself; a unit that recorded no commit has all four "
                   "fields null) and the archive volume(s) holding it. `withheld` lists every family left out "
                   "and why.",
           "units": rows, "withheld": RC.withheld_rows(proc.cat), "claims": RC.claims_index(proc.cat, claim_ids)}
    (out / "RUNS-INDEX.json").write_text(json.dumps(scrub_json(doc), indent=1, ensure_ascii=False) + "\n")
    print(f"wrote {out / 'RUNS-INDEX.json'}: {len(rows)} units")


# ---------------------------------------------------------------- archive README

def write_readme(out: Path, proc: Processor):
    man = json.loads((out / "MANIFEST.json").read_text())
    idx = json.loads((out / "RUNS-INDEX.json").read_text())
    rows, total, nfiles = [], 0, 0
    for g in sorted(man["groups"]):
        for v in man["groups"][g]["volumes"]:
            total += v["bytes"]
            nfiles += v["files"]
            rows.append(f"| `{v['file']}` | {v['files']:,} | {v['bytes'] / (1 << 20):.1f} MiB | `{v['sha256'][:16]}…` |")
    fams = "\n".join(f"- **{g}** — {man['groups'][g]['what']}" + (" (SWE-PRBench: here only, not in the tables)"
                                                                   if man["groups"][g].get("ship") == "archive-only" else "")
                     for g in sorted(man["groups"]))
    counts = collections.Counter()
    left = collections.Counter()
    for g in man["groups"].values():
        counts.update(g["rewrites"])
        left.update(g["left_out"])
    walk = json.loads((out / "LEFT-OUT.json").read_text())["files"] if (out / "LEFT-OUT.json").exists() else {}
    withheld_n = collections.Counter()
    for k, n in walk.items():
        fam, reason = k.split(" :: ", 1)
        if RC.Catalogue.ships(proc.cat.families.get(fam)):
            left[reason] += n
        else:
            withheld_n[fam] += n
    content_n = sum(v for k, v in counts.items() if k.startswith("content-rule "))
    rw = "\n".join(f"| `{k}` | {v:,} |" for k, v in sorted(counts.items())
                   if not k.startswith(("files-", "content-rule ", "session-log", "pi-cost", "case-summaries")))
    if content_n:
        rw += f"\n| `content-rules` (all {man.get('content_rules', 0)} rules) | {content_n:,} |"
    lo = "\n".join(f"| {k} | {v:,} |" for k, v in sorted(left.items()))
    wh_rows = []
    for w in idx["withheld"]:
        members = ", ".join(f"`{m}`" for m in w["members"][:12]) + (" …" if len(w["members"]) > 12 else "")
        walked = withheld_n.get(w["family"])
        n = len(w["members"])
        size = f"{n} unit{'s' if n != 1 else ''}" + (f", {walked:,} files" if walked else "")
        wh_rows.append(f"| `{w['family']}` | {w['title']} | {w['reason']} | {members} ({size}) |")
    wh = "\n".join(wh_rows)
    level = man["compression"].split()[1].lstrip("-")
    cap = man["volume_cap_bytes"] / (1 << 30)
    sess = collections.Counter({k: v for k, v in left.items() if k.startswith("session log")})
    session_kinds = "\n".join(f"- {k[0].upper() + k[1:]}: {v:,} files" for k, v in sorted(sess.items())) or "- (none found)"
    session_kinds += ("\n\nBy name: `pi-events.jsonl` and `pi-events.r<lens>.jsonl`; `cases/<iid>/session/*.jsonl`; "
                      "everything under `lens-sessions/`, `codex-sessions/` and `claude-transcripts/`; "
                      "`opencode-events.jsonl`; every `*.events.jsonl` (judge event streams); the process logs "
                      "`pi-stderr.log`, `pireview-stderr.log`, `ocr-stderr.log`, `opencode.log`, `codex-driver.log` "
                      "(it echoes the prompt in its argv), `pragent-*.log`, `*.events.stderr.log`; every "
                      "`*.sandbox-commands.log` and `sandbox-commands.log`; the prompt files `system-prompt.md`, `round-order.md`, "
                      "`context-pack.md` and `tasks/*.md`; and the reviewed code a case dir copied "
                      "(`head-patches.json`, `added-imports.txt`).")
    pi_checked, pi_diff = counts.get("pi-cost checked", 0), counts.get("pi-cost differs (extract vs full)", 0)
    text = f"""# QuickReview benchmark runs — the run archive

Every benchmark run behind QuickReview's published numbers, and every other
benchmark run we hold except those listed under "What is not here": each review and its findings, the judges' verdicts
with their reasoning, AACR-Bench's own metric files, the Martian, Qodo
PR-Review-Bench and SWE-PRBench scoring, the pairwise Elo judgments, the run
configurations and per-PR summaries (cost, time, tokens), the open-model
runs, the answer key, and the analysis behind the reports. Raw model session
logs are not here: each JSONL one ships as a numbers-only extract (see
"Session logs" below).
{nfiles:,} files in {len(rows)} volumes, one per run family, {total / (1 << 20):.0f} MiB compressed.

`RUNS-INDEX.json` is the run index: one row per run directory with its family,
what it was for, the model it billed, its judges, the public claims it backs,
its build commit (on public main where the history rewrite maps it) and its
volume.

DOI: minted by Hugging Face at upload. Code, benchmark definition and papers:
the QuickReview repository, `bench/aacr/`. The slim re-score bundle, in this
dataset's `slim/` folder, is a subset of this archive and is enough to
recompute every table with no model call.

## Volumes

| File | Files | Size | sha256 |
|---|---|---|---|
{chr(10).join(rows)}

`SHA256SUMS` lists the full hashes. `MANIFEST.json` adds, per volume, the
uncompressed size and the file count per run directory, and, per family, the
count of every rewrite and of every file left out, by reason.

Unpack every volume into one directory to get the original layout
(`runs/`, `open-models/`, `elo/`, `analysis/`, `whatif/`, `logs/`,
`ext-images/`, `*-code/`):

    mkdir quickreview-runs
    for v in quickreview-runs-*.tar.zst; do tar --zstd -xf "$v" -C quickreview-runs; done
    export QCR_BENCH_RUNS_DIR=$PWD/quickreview-runs/runs

A file that is a copy of another shipped file is stored once: a run whose
files were hardlinked or copied from another run (the posting-policy variants
of the Martian runs, the assembled multi-lane Claude runs, the DeepSeek mix,
the 40-PR comparison re-judges, a copied smoke, `whatif/`) carries a
`SOURCE-COPIES.json` that maps each such file to the archive path of the copy
that ships, possibly in another volume. Unpacking every volume and copying
each listed file back restores the runs exactly.

Compression: zstd level {level} with a 128 MiB window (`--long=27`), the
largest window any zstd from 1.3.2 on decodes without extra flags. Each
volume is a complete tar on its own and stays under {cap:.1f} GiB, so a
download resumes per file.

## Families

{fams}

## What was changed, and nothing else

The archive is the run directories as the runs wrote them, with these
mechanical rewrites applied to every text file and file name while it was
packed. Nothing else in the text changed.

- **Credentials.** A reviewer could read its container's environment, so a
  provider API key sat verbatim in a few open-model transcripts. Those
  transcripts are not published (see "Session logs"), and every value of our
  credential files is replaced by `<redacted-secret>` wherever else it occurs.
- **Names.** The GitHub App persona's login (and its bare slug) became
  `<review-bot>`; the owner's first name became `<owner>`. One placeholder per
  name, everywhere: reviews, findings, the model's own text, verdicts, logs. A personal handle, a private commit id and an account id became
  `<private>`, private host names `<private-host>`.
- **The private product repository.** Its name, which a few model texts
  mention, became `<private-repo>`, in any case.
- **The product's old name.** The product's earlier name became `quickreview`. It is the
  product's earlier name, not a person, so it gets the public name rather
  than a placeholder.
- **The authors' tracker.** The tracker is not public, so its ticket ids
  (`FT-` and three or four digits, in any case, with or without the hyphen,
  as in an image tag `qcr-bench:<ticket>`) and any path into it became
  `<ticket>`. No ticket number is kept. The runs of the Claude Code vs
  QuickReview study, whose directory names began with one, are named
  `ccvq-…` here (`ccvq-hard20-…`, the Elo plan `martian-hard20-ccvq`), the
  names the public repository's Elo plans use.
- **Build commits.** Each `"qcr_commit"` (in `run.json` and every
  `case-summary.json`) is the public main commit the recorded one became
  after the repository's history rewrite, with
  `"qcr_commit_on_public_main": true` beside it and `"qcr_commit_match"`
  saying how it was matched: `"same"`, the rewrite's commit maps carry the
  recorded commit to it; `"date+subject"`, matched by author date and
  subject alone (none in this release); `"ancestor"`, the rewrite dropped
  the recorded commit because it changed only files that were never
  published, so it maps to the nearest ancestor the rewrite kept, whose
  published files are the same. A commit with no public equivalent (a side
  branch never merged, or another clone's commit that no rewrite map holds)
  keeps its recorded id with `false` and a `null` match; a commit the remap
  does not list would get `null` (none in this release). The dirty flag is
  separate: a dirty build (the recorded id ends in `-dirty`: built from a
  checkout with uncommitted or untracked files) maps to the commit it was
  built on, keeps the `-dirty` suffix and is flagged
  `"qcr_commit_dirty": true` (`false` for every other build): it is that
  commit plus whatever was not committed, which was not saved, so not
  necessarily the commit itself. A `"qcr_commit": null` (no commit was
  recorded) carries none of these fields.
- **Host paths** in driver logs, scripts and analysis: the bench runs directory
  became `<runs>`, the repository checkout `<repo>`, any
  other path under the exporting user's home `<home>` (so the Claude Code credential file's path reads
  `<home>/.config/qcr-bench/claude.env`; its value never appeared), and the
  docker volume `companion-pihome` `<pi-login-volume>`.
  An agent's scratch directory (`/tmp/claude-<uid>/-home-…/<session>/scratchpad`)
  became `<scratchpad>` and a Claude Code project dir `.claude/projects/<project>`,
  the spellings of the repository's `docs/PROMPTS.md`.
- **The public repository's stand-ins.** Some kept files (run
  configurations, analysis notes, the model's own text) quote QuickReview's
  prompts as they were built at run time. Where those prompts carried
  examples drawn from private work (support guidelines, hosts, pull request
  numbers, internal tool names), the same stand-ins the public repository's
  history carries replace them, by the same rules. A few of the rules also
  match public text quoted by a reviewer (a first name, a cloud zone in a
  test fixture), which therefore reads with the stand-in.
- **Encrypted reasoning blobs are blanked.** The value of every
  `encrypted_content` field (OpenAI reasoning items) and of every base64
  `thinkingSignature` and `signature` (Anthropic thinking blocks) becomes the
  empty string, the record around it kept. The blobs were in the session
  logs, which are not published, so the rule finds none in what ships; the
  extracts still carry the reasoning-token counts.
- **Third-party text is linked, not copied, with two exceptions.** These
  are replaced by
  `[third-party text omitted, sha256:<first 16 hex of the text's sha256>; see <link>]`:
  vendor review comments (the published tools Martian re-judged, the nine
  Qodo vendors, the upstream GitHub Copilot reviews), and PR authors'
  descriptions, wherever a file copied one (the answer key's `meta.json`,
  PR-Agent's `pragent-describe.json` and `pragent-description.md`, the
  open-model case sets). The hash keeps equal texts equal, so every score
  recomputes unchanged. JSON files whose third-party text was replaced were
  re-serialised. The exceptions ship verbatim, as third-party text: the
  Martian judge's extractions of the re-judged vendors' comments (each
  candidate's `text` in `results/<judge>/candidates.json`, and
  `matched_candidate` and `candidate` in `evaluations.json`) and the vendor
  candidates of the blind annotation (`analysis/…/fair/secret.json`). That
  text belongs to its authors, the vendors' review bots that posted it on
  public PRs, and is not covered by this archive's licence. What else stays
  third-party inside the files: Martian's golden comments (MIT) in Martian's
  scoring files, Qodo's issues (MIT) in the Qodo scoring files and
  `analysis/qodo-2026-10-03/`, AACR-Bench's reference comments
  (Apache-2.0), and code quoted by reviewers and judges (each project's own
  licence).

Rewrite counts over the whole archive:

| Rewrite | Count |
|---|---|
{rw}

## Session logs

The archive holds benchmark data only. Raw model session logs of every kind
are left out: they hold the prompt text the sessions were built from during
development, not benchmark data. The set is defined by file kind and fails
closed: a log-shaped file anywhere in the archive (a `.log`, `.jsonl` or
`.ndjson` anywhere in its name, `x.log.1` included) that no rule names as
data is left out too, and so is every log of an aborted run. Left out:

{session_kinds}

Each JSONL session log ships as a numbers-only extract beside where it was,
named `<name>.pruned.jsonl`, so the speed, cost, token and lens claims stay
verifiable:

- `pi-events.pruned.jsonl`, from the reviewer's pi event stream: each
  assistant message's role, timestamp, usage (tokens and cost) and stop
  reason; each lens tool call's id and, for every lens run, its id, agent,
  stop reason, error class (one of timeout, rate-limit, overloaded, aborted,
  context-length, provider-error, other; never the message), usage, and its
  messages' role, timestamp and usage. `bench/aacr/compare.py` prices a case
  from it to the cent (the export priced every extract both ways: {pi_checked:,}
  checked, {pi_diff:,} differing), `recompute/do_speed.py` and
  `openmodels/lensfinal.py` read it in place of `pi-events.jsonl`.
- every other `*.pruned.jsonl` (lens and session transcripts, Codex rollouts,
  Claude Code and OpenCode transcripts, judge event streams): every number and
  boolean of every line, and string values only under a closed set of keys
  (type, role, timestamp, model, provider, stop reason, agent, tool name,
  status, effort) and only when they are single short tokens. Each line is
  marked `"_extract": "metrics"`.

Session text inside the files that are kept is rewritten field by field,
and the export fails closed on any left:

- a harness result's `stdout` (the CLI's whole event stream: Codex's shell
  commands, their output and its messages) and `stderr` (the process log),
  in `results/**/<iid>.json`, become `stdout_extract` (line count, the count
  of each event and item type, and every usage record) and `stderr_extract`
  (its size and error class);
- a prompt in a driver's recorded argv (`codex-driver.json`, `*-argv.json`)
  and OpenCode's review template (`opencode-config.json`) become
  `[prompt omitted: sha256:<16 hex>, <n> chars]` (the harness prompts are in
  the repository's `bench/aacr/docs/PROMPTS.md`);
- Claude Code's `permission_denials` (the model's denied commands) in
  `claude-stdout.json` become `permission_denials_count`;
- the lines a case's ledger copied from that case's own prompt files are
  removed, and the AACR re-scoring shim's error lines keep only the error
  class;
- a task one session wrote for another (`*-task.md`) is a prompt file, and
  the blind annotation's instructions and per-PR packets are prompts:
  left out.

After those rules, a data file that still holds an event stream, the
round-order prompt or a PR author's description is left out whole
(`session_logs.CONTENT_MARKERS`).

Kept, because they are data the harness wrote and hold no prompt: the run
drivers' logs beside each run (`<run>.review.log`, `.judge.log`, `.score.log`
and the like), the model bridge's and judge proxy's request logs
(`bridge.jsonl`, `judge/judge.jsonl`), the lens ledger, AACR-Bench's harness
input and run log (`eval/`), Martian's step logs, the Claude Code harness's
parse log (`driver.log`), and each review tool's final output (the review
itself: `review.md`, `comments.json`, `findings-record.json`,
`pireview-stdout.txt`, `opencode-result.txt`, `ocr-stdout.json`,
`pragent-*.json`, `claude-stdout.json`).

## What is not here, and why

Withheld whole, by family (every unit of these families is left out; the run
index lists them too):

| Family | What | Why | Units |
|---|---|---|---|
{wh}

Files left out of the shipped families:

| Left out | Files |
|---|---|
{lo}

Also not here: the reviewed repositories' code (`repo.git`, the `base/` and
`head/` file trees and the `pr.diff` of each case; refetch them from the
repository and commits in each case's `meta.json`, as AACR-Bench does, and
for Martian from the dataset's `martian_prs` table). For Qodo and SWE-PRBench
cases the run files carry the harness's replay commit ids (`head_sha` in
`outcome.json`, and the short replay head in each case directory's name):
the same trees under a synthetic author, date and message, made so the
reviewer could not read the PR's history, and never on GitHub. The real
commits are in the case set's `leakproof` block (`source_head`,
`source_merge_base` in `bench/aacr/sets/<set>.json` of the repository) and in
the dataset's `qodo_prs` table, and the replayed trees equal those commits'
trees. Also not here:
`ext-cache/` and `ext-data/` (the external benchmarks' own data and
harnesses, pinned: withmartian/code-review-benchmark@e616e84, Hugging Face
Qodo/PR-Review-Bench@a73957c, foundry-ai/swe-prbench@b87f579 and
FoundryHQ-AI/swe-prbench@379f0bf), scratch, and the authors' private notes.
Martian's own `published-benchmark_data.json` (the vendors' review comments
and Martian's golden comments) sits in no scoring directory here: read it at
{MARTIAN_SRC.replace('/blob/e616e84/offline/results/benchmark_data.json', '')} @ e616e84
(`offline/results/benchmark_data.json`).

The Elo runs (`elo/`) ship their plans, units, judgments, ratings, reports
and logs, but not `packs/`: the packs are whole files of the reviewed
repositories (some under AGPL or source-available licences), cut to each
pull request. `bench/aacr/elo/elo.py pack` rebuilds them from the public
repositories at the commits in `units.jsonl`; `packs.jsonl` lists the files
each pack held. `bench/aacr/recompute/elo_ratings.py` refits the ratings from
the judgments alone, with no pack.

The answer key's build is in the `answer-key` volume twice over: the case
files themselves (`*-code/<iid>/`, without the reviewed code), and two
derived data files, `key-data/candidate-maps.json` (which earlier run or
reviewer raised each key-building candidate) and `key-data/pr-diffstats.json`
(each PR's files changed, insertions and deletions from its `diff.stat`),
the same rows as the dataset's `aacr_candidates` and `pr_diffstats` configs.

The `analysis` volume also carries `analysis/relabel/`: the label files of
the two labelling passes behind the benchmark paper's severity table
(`tab:martiantiers`) and the QuickReview paper's lost-credit figures, each
row with the model that wrote it (gpt-6.1-sol) and the sha256 of the prompt
file shipped beside it, and `LABELS.json` naming the script, model, effort,
prompt hash and row count of each pass. `bench/aacr/relabel/<pass>.py
--compute` turns them and this archive into the published numbers with no
model call.

## Licence and attribution

Apache License 2.0 (https://www.apache.org/licenses/LICENSE-2.0), the same
licence as the QuickReview benchmark dataset.

This archive contains material derived from **AACR-Bench v1.0** (Alibaba,
`alibaba/aacr-bench`, Apache-2.0; dataset `ab8af8d`, harness `68a5697`): its
reference comments, labels and the harness's metric files. **Modified work:**
derived from AACR-Bench v1.0 and modified by Quickchat AI in 2026: the PRs
were re-keyed with a verified defect key and used to score new reviews; the
harness ran unmodified except for its judge endpoint. Cite AACR-Bench as:

    L. Zhang, Y. Yu, M. Yu, X. Guo, Z. Zhuang, G. Rong, D. Shao, H. Shen,
    H. Kuang, Z. Li, B. Wang, G. Zhang, B. Xiang and X. Xu.
    AACR-Bench: Evaluating automatic code review with holistic repository-level
    context. arXiv:2601.19494 [cs.SE], 2026. https://arxiv.org/abs/2601.19494

External benchmarks, under their own licences. Martian's golden comments and
Qodo's issues (both MIT) are inside their scoring files; SWE-PRBench's data is
referenced, not redistributed, beyond short quotations inside judge outputs.
Martian's
offline code-review benchmark (MIT, (c) 2025 Martian,
github.com/withmartian/code-review-benchmark @ e616e84); Qodo
PR-Review-Bench (MIT, the Qodo team,
huggingface.co/datasets/Qodo/PR-Review-Bench @ a73957c); SWE-PRBench (dataset
CC BY 4.0, harness MIT; Kumar 2026, arXiv:2603.26130,
huggingface.co/datasets/foundry-ai/swe-prbench @ b87f579; our changes: none
to its data, which is not redistributed). Code quoted by reviewers and judges
stays under its own project's licence.

Cite this archive with the QuickReview benchmark paper and this dataset's
DOI (minted by Hugging Face at upload).
"""
    (out / "README.md").write_text(text)
    write_licence(out)
    print(f"wrote {out / 'README.md'}, LICENSE and NOTICE")


def archive_notice(lead: str) -> str:
    return NT.notice(
        lead,
        modified="MODIFIED WORK: derived from AACR-Bench v1.0 and modified by Quickchat AI in 2026. The runs "
                 "re-key AACR-Bench's PRs with a verified defect key, score new reviews against it, and keep "
                 "AACR-Bench's reference comments and labels and its harness's metric files as the harness wrote "
                 "them (the harness ran unmodified except for its judge endpoint).",
        martian_where="Martian's scoring dirs (`runs/*.martian*/`)",
        qodo_where="The Qodo scoring dirs (`runs/*.qodo*/`) and `analysis/qodo-2026-10-03/`")


ARCHIVE_LEAD = """This run archive was assembled by Quickchat AI and is distributed under the Apache
License, Version 2.0 (LICENSE)."""
SLIM_LEAD = """This slim re-score bundle, a subset of the run archive in this dataset's `archive/`
folder, was assembled by Quickchat AI and is distributed under the Apache License, Version 2.0
(LICENSE)."""


def write_licence(out: Path, lead: str = ARCHIVE_LEAD):
    NT.write_licences(out)
    text = archive_notice(lead)
    if lead == SLIM_LEAD:  # the bundle holds no SWE-PRBench data and no analysis tree
        text = text.replace(NT.SWEPR.strip() + "\n\n", "").replace(" and `analysis/qodo-2026-10-03/`", "")
    (out / "NOTICE").write_text(text)

# ---------------------------------------------------------------- slim bundle

SLIM_RUN_FILES = re.compile(r"^(run\.json|judge\.txt|judge/[^/]+/([^/]+\.r1\.json|score\.json|report\.md)"
                            r"|results/all/[^/]+\.json|cases/[^/]+/case-summary\.json)$")
SLIM_MARTIAN = re.compile(r"^(martian-scores\.json|martian-report\.md|score_profiles\.txt|judge/JUDGE\.txt"
                          r"|results/ingest-report\.json|results/[^/]+/(evaluations|candidates)\.json)$")
SLIM_QODO = re.compile(r"^(scores\.json|scores\.md|judgements\.jsonl|judge/JUDGE\.txt)$")
SLIM_ELO = re.compile(r"^elo/[^/]+/(plan\.json|units\.jsonl|ratings\.json|REPORT\.md|judgments/[^/]+\.jsonl)$")
PRUNED_EVENTS = SL.PI_PRUNED


def slim_select(rel: str) -> bool:
    if SLIM_ELO.match(rel):
        return True
    rp = run_parts(rel)
    if not rp or not rp[1]:
        return False
    run, inner = rp[0], "/".join(rp[1])
    if "swepr" in run or re.match(r"(mv|mt|qr)-", run) and "." not in run:
        return False  # SWE-PRBench data ships in the archive only; variant reviews are not scored by compare.py
    if ".martian" in run:
        return bool(SLIM_MARTIAN.match(inner))
    if ".qodo" in run:
        return bool(SLIM_QODO.match(inner))
    if "." in run:
        return False
    return bool(SLIM_RUN_FILES.match(inner))


def _glm_set_ids() -> set[str]:
    out = set()
    for f in sorted((HERE / "sets").glob("glm-*.json")):
        out.update(c["instance_id"] for c in json.loads(f.read_text())["cases"])
    return out


GPT_SMOKE_PARENTS = ("final1-rest145", "final1-martian50", "final1-qodo-pr100")


def slim_events(rel: str, glm_ids: set[str]) -> bool:
    """The transcripts the slim bundle keeps, pruned: every open-model case's,
    and the frozen build's cases of the open-model smoke PRs (the speed
    table's GPT-6.1 Sol row)."""
    rp = run_parts(rel)
    if not rp or len(rp[1]) != 3 or rp[1][0] != "cases" or rp[1][2] != "pi-events.jsonl" or "." in rp[0]:
        return False
    if rel.startswith(OM + "/"):
        return True
    return rp[0] in GPT_SMOKE_PARENTS and rp[1][1] in glm_ids


prune_events = SL.prune_pi  # the slim bundle's and the archive's pruned transcript, one function


def slim_cost(case_dir: Path) -> tuple[float | None, str]:
    import compare  # bench/aacr/compare.py: its own per-case figure, so the bundle can never disagree with it
    usd, _ = compare.usd_and_minutes(str(case_dir))
    if (case_dir / "pi-events.jsonl").exists():
        src = "pi-events.jsonl: assistant message_end usage cost + subagent results' usage cost"
    else:
        s = json.loads((case_dir / "case-summary.json").read_text())
        src = ("case-summary.json cost_usd (Claude Code's total_cost_usd)" if s.get("arm") == "claude" and s.get("cost_usd") is not None
               else "case-summary.json bridge tokens at pi's per-model rates" if s.get("bridge")
               else "no cost record (0)")
    return usd, src


def cmd_slim(a):
    proc = _proc(a)
    out = Path(a.out)
    out.mkdir(parents=True, exist_ok=True)
    for old in out.glob("quickreview-bench-slim.*"):  # an earlier or interrupted build: rebuilt whole
        old.unlink()
    counts, n = collections.Counter(), 0
    w = VolumeWriter(out, "quickreview-bench-slim", a.level, a.cap, a.threads)
    index = []
    glm_ids = _glm_set_ids()
    tops = ("runs", "elo")
    for rel in walk_files(proc.src, proc.om, tops):
        if rel.startswith(OM + "/") and not rel.startswith(OM + "/runs/"):
            continue
        events = slim_events(rel, glm_ids)
        if not (events or slim_select(rel)):
            continue
        f = proc.family(rel)
        if not RC.Catalogue.hf_ships(f):
            continue  # withheld, or the archive only (SWE-PRBench)
        if events:
            if proc.drop(rel):
                continue
            data = rewrite(prune_events(proc.tree.fs(rel).read_bytes()), counts)
            counts["pruned-transcripts"] += 1
            rel_out = rel[:-len("pi-events.jsonl")] + PRUNED_EVENTS
        else:
            data, reason = proc.process(rel, counts)
            if reason:
                continue
            rel_out = rel
        if rel.endswith("/case-summary.json"):
            s = json.loads(data)
            usd, how = slim_cost(proc.tree.fs(os.path.dirname(rel)))
            s["bench_cost_usd"] = usd
            s["bench_cost_source"] = how
            data = (json.dumps(s, indent=1, ensure_ascii=False) + "\n").encode()
            counts["case-summaries-with-slim-cost"] += 1
        name = rewrite_name(rel_out, counts)
        w.add(name, data, proc.tree.fs(rel).stat().st_mtime)
        index.append((name, len(data), hashlib.sha256(data).hexdigest()))
        n += 1
    for name, data in relabel_files(counts).items():
        w.add(name, data, time.time())
        index.append((name, len(data), hashlib.sha256(data).hexdigest()))
        n += 1
    readme = slim_readme(n, counts)
    w.add("README.md", readme.encode(), time.time())
    idx = "".join(f"{h}  {s}  {p}\n" for p, s, h in index)
    w.add("FILES.sha256", idx.encode(), time.time())
    vols = w.finish()
    for v in vols:
        p = Path(v["path"])
        print(f"{p.name}: {v['files']} files, {v['bytes_in'] / (1 << 20):.1f} MiB raw, {p.stat().st_size / (1 << 20):.1f} MiB")
        (out / (p.name + ".sha256")).write_text(f"{sha256_file(p)}  {p.name}\n")
    (out / "README.md").write_text(readme)
    write_licence(out, SLIM_LEAD)
    # the rewrite counts are the build's record, not part of the upload: beside the folder, not in it
    (out.parent / f"{out.name}-counts.json").write_text(json.dumps(dict(counts), indent=1) + "\n")


def slim_readme(n: int, counts) -> str:
    return f"""# QuickReview benchmark — slim re-score bundle

{n} files, plus this README and `FILES.sha256`. Everything `bench/aacr/final/score.sh`, `compare.py`, `charts.py`,
the external-benchmark scorers and `bench/aacr/recompute/` read to recompute
the published tables (the papers, the README's Elo chart and "Other models"
rows, `docs/DIGITALOCEAN.md`), with no model call and no session log (a
harness result's `stdout` and `stderr` are numbers-only extracts here too).
The run archive, in this dataset's `archive/` folder, holds every run; this
bundle is a subset of it, rewritten the same way (see the archive README:
names, placeholders, blanked reasoning blobs, and why no raw session log is
published in either).

Unpack it and point the tools at its `runs/`:

    mkdir slim && tar --zstd -xf quickreview-bench-slim.tar.zst -C slim
    export QCR_BENCH_RUNS_DIR=$PWD/slim/runs
    bench/aacr/final/score.sh
    python3 bench/aacr/recompute/open_models.py --runs-dir slim/open-models/runs
    python3 bench/aacr/recompute/do_speed.py --runs-dir slim/open-models/runs --gpt-runs-dir slim/runs
    python3 bench/aacr/recompute/elo_ratings.py slim/elo/martian-hard20-all-gpt --check-ratings \\
        --runs-dir slim/runs --runs-dir slim/open-models/runs

## Layout

    runs/<run>/run.json                         the run's build and configuration
    runs/<run>/judge.txt                        the AACR-metric judge line
    runs/<run>/judge/<label>/<iid>.r1.json      the defect judge's verdict per PR
    runs/<run>/judge/<label>/score.json, report.md
    runs/<run>/results/all/<iid>.json           the review in AACR-harness form
    runs/<run>/results/all/metrics_*.json       AACR-Bench's per-round metric files
    runs/<run>/cases/<iid>/case-summary.json    the case summary, plus:
        bench_cost_usd     compare.py's per-case $ (usd_and_minutes), computed from
                          the full case dir before pi-events.jsonl was left out
        bench_cost_source  where that figure came from
    runs/<run>.martian*/martian-scores.json, martian-report.md, score_profiles.txt,
                        results/ingest-report.json, results/<judge>/evaluations.json
                        and candidates.json (the judge's step-2 extractions; a
                        re-judged vendor tool's candidate text ships verbatim as
                        third-party text, its vendor's, not under this licence)
    runs/<run>.qodo*/scores.json, scores.md, judgements.jsonl (vendor comment
                        bodies replaced by a hash + link; the scorer reads only
                        their file and lines), judge/JUDGE.txt
    open-models/runs/...                        the open-model runs, the same files
    open-models/runs/<run>/cases/<iid>/{PRUNED_EVENTS}
                        the transcript's numbers-only extract (the archive's
                        format): each assistant message's timestamp and usage,
                        each lens run's id, agent, outcome and error class, and
                        its messages' timestamps and usage (every line marked
                        "_slim": "pruned"); also kept for the frozen
                        build's cases of the open-model smoke PRs in
                        runs/final1-{{rest145,martian50,qodo-pr100}}
    elo/<plan>/plan.json, units.jsonl, judgments/*.jsonl, ratings.json, REPORT.md
    analysis/relabel/   the two labelling passes' label files, their prompts and
                        LABELS.json (model, effort, prompt sha256, rows), the same
                        files the archive's analysis volume carries
    FILES.sha256                                sha256, size and path of every file

compare.py reads `bench_cost_usd` when a case has no `pi-events.jsonl`;
recompute/do_speed.py and openmodels/lensfinal.py read `{PRUNED_EVENTS}`
when a case has no `pi-events.jsonl`. SWE-PRBench run data is in the archive
only.

Licence: Apache-2.0, as the run archive (its README carries the AACR notice,
the modified-work statement and the citations).
"""


# ---------------------------------------------------------------- re-grep

def _denylist_words() -> list[str]:
    return [t for k, t in SX.denylist() if k == "word"]


REGREP = {
    **{f"owner name {i} (any case)": rb"(?i:" + re.escape(o.encode()) + rb")" for i, o in enumerate(SCRUB_OWNERS)},
    **{f"review bot {i} (any case)": rb"(?i:" + re.escape(b.encode()) + rb")" for i, b in enumerate(SCRUB_BOTS)},
    **{f"old product name {i}": re.escape(n.encode()) for i, n in enumerate(SCRUB_OLD_NAMES)},
    **{f"private repo {i} (any case)": rb"(?i:" + re.escape(r.encode()) + rb")" for i, r in enumerate(SCRUB_PRIVATE_REPOS)},
    **{f"secret value {i}": re.escape(v) for i, v in enumerate(SCRUB_SECRETS)},
    **{f"private word {i}": SX.word_rx(w).pattern for i, w in enumerate(SCRUB_PRIVATE_WORDS)},
    **{f"denylist word {i}": SX.word_rx(w).pattern for i, w in enumerate(_denylist_words())},
    "home directory": HOME_RX,
    "companion-pihome": rb"companion-pihome", "claude.env path": rb"[./\w-]*claude\.env",
    "sk- (substring)": rb"sk-", "ghp_ (substring)": rb"ghp_", "ghs_ (substring)": rb"ghs_", "gho_ (substring)": rb"gho_",
    "sk- key-shaped": rb"(?<![A-Za-z0-9])sk-(?:ant-|proj-)?[A-Za-z0-9_\-]{20,}",
    "gh?_ token-shaped": rb"(?<![A-Za-z0-9])gh[pousr]_[A-Za-z0-9]{36}(?![A-Za-z0-9])",
    "Fernet blob (gAAAAA, 100+)": rb"gAAAAA[A-Za-z0-9_\-=]{100,}",
    "home directory (dashed path)": HOME_DASHED_RX.lstrip(b"\\-"),
    **{f"token {i}": rb"(?i:" + re.escape(t.encode()) + rb")" for i, t in enumerate(SCRUB_EXTRA)},
    **{f"host {i}": rb"(?i:" + re.escape(h.strip().encode()) + rb")" for i, h in enumerate(SCRUB_HOSTS)},
    "quickchat (any case)": rb"(?i:quickchat)",
    "JWT-shaped (eyJ..eyJ..)": rb"eyJ[A-Za-z0-9_\-]{8,}\.eyJ[A-Za-z0-9_\-]{8,}\.[A-Za-z0-9_\-]{8,}",
    "Google API key-shaped (AIza)": rb"AIza[0-9A-Za-z_\-]{35}",
    "AWS access key-shaped (AKIA)": rb"AKIA[0-9A-Z]{16}",
    "Slack token-shaped (xox?-)": rb"xox[abprs]-[A-Za-z0-9\-]{10,}",
    "PEM private key": rb"-----BEGIN [A-Z ]*PRIVATE KEY-----",
    "GitHub fine-grained token-shaped (github_pat_)": rb"github_pat_[A-Za-z0-9_]{40,}",
    **{f"session text: {n}": rx.pattern for n, rx in SL.CONTENT_MARKERS},
    "ticket id (FT-NNNN)": SX.TICKET_RULES[1][1],
    "ticket id (ftNNNN)": SX.TICKET_RULES[2][1],
    "tracker path": rb"(?<![A-Za-z0-9_])tracker/(?:efforts|tickets|maps)/",
}


# one PCRE pass over the decompressed stream (tar headers included, so member
# names are searched too); every match is classified afterwards by REGREP
REGREP_SCAN = (rb"(?<![A-Za-z0-9])sk-(?:ant-|proj-)?[A-Za-z0-9_\-]{20,}|(?<![A-Za-z0-9])gh[pousr]_[A-Za-z0-9]{36}(?![A-Za-z0-9])|gAAAAA[A-Za-z0-9_\-=]{100,}"
               + b"".join(rb"|(?i:" + re.escape(t.encode()) + rb")" for t in SCRUB_OWNERS + SCRUB_BOTS + SCRUB_PRIVATE_REPOS)
               + b"".join(b"|" + re.escape(n.encode()) for n in SCRUB_OLD_NAMES)
               + b"".join(b"|" + re.escape(v) for v in SCRUB_SECRETS)
               + b"".join(b"|" + SX.word_rx(w).pattern for w in SCRUB_PRIVATE_WORDS + _denylist_words())
               + rb"|" + HOME_RX + rb"|companion-pihome|[./\w-]*claude\.env"
               rb"|" + HOME_DASHED_RX.lstrip(b"\\-")
               + b"".join(rb"|(?i:" + re.escape(t.encode()) + rb")" for t in SCRUB_EXTRA)
               + b"".join(rb"|(?i:" + re.escape(h.strip().encode()) + rb")" for h in SCRUB_HOSTS) + rb"|(?i:quickchat)|sk-|gh[psor]_")


# the same hunt for ripgrep's engine, which finds a long list of literals at
# disk speed where one PCRE alternation crawls: every name, token and value as
# a case-insensitive literal (a whole-word rule then counts every substring
# hit, which can only over-count), the credential shapes with the char before
# them inside the match in place of their look-behind
REGREP_RG = [
    rb"(?i:" + b"|".join(re.escape(t) for t in sorted(
        {x.encode() for x in SCRUB_OWNERS + SCRUB_BOTS + SCRUB_PRIVATE_REPOS + SCRUB_OLD_NAMES + SCRUB_PRIVATE_WORDS
         + _denylist_words() + SCRUB_EXTRA + [h.strip() for h in SCRUB_HOSTS]} | set(SCRUB_SECRETS)
        | {HOME_B, HOME_DASHED.lstrip(b"-"), b"companion-pihome", b"quickchat"}, key=len, reverse=True)) + rb")",
    rb"(?:^|[^A-Za-z0-9])sk-(?:ant-|proj-)?[A-Za-z0-9_\-]{20,}", rb"(?:^|[^A-Za-z0-9])gh[pousr]_[A-Za-z0-9]{36}",
    rb"gAAAAA[A-Za-z0-9_\-=]{100,}",
    rb"[./\w-]*claude\.env", rb"sk-", rb"gh[psor]_",
    rb"(?:^|[^A-Za-z0-9])(?:[Ff][Tt]-[0-9]{3,4}|FT[0-9]{3,4})", rb"(?:^|[^A-Za-z0-9_])tracker/(?:efforts|tickets|maps)/",
    rb"(?:^|[^A-Za-z0-9])ft0[0-9]{3}",
    rb"eyJ[A-Za-z0-9_\-]{8,}\.eyJ[A-Za-z0-9_\-]{8,}\.[A-Za-z0-9_\-]{8,}", rb"AIza[0-9A-Za-z_\-]{35}", rb"AKIA[0-9A-Z]{16}",
    rb"xox[abprs]-[A-Za-z0-9\-]{10,}", rb"-----BEGIN [A-Z ]*PRIVATE KEY-----", rb"github_pat_[A-Za-z0-9_]{40,}",
    rb"type\\*\"\s*:\s*\\*\"(?:thread\.started|item\.completed|command_execution)", rb"aggregated_output",
    rb"===ROUNDORDER===|You are this PR's only shepherd", rb"### \*\*User description\*\*", rb"as its author described it",
]


SAMPLED = ("sk- key-shaped", "gh?_ token-shaped", "Fernet blob (gAAAAA, 100+)", "JWT-shaped (eyJ..eyJ..)",
           "Google API key-shaped (AIza)", "AWS access key-shaped (AKIA)", "Slack token-shaped (xox?-)",
           "PEM private key", "GitHub fine-grained token-shaped (github_pat_)")
# The gate: a class that names us (an identity, a credential value, a private word, a host path, a
# ticket) or session text must count 0, or the re-grep fails. The credential-shaped classes count
# third-party fixtures quoted from the reviewed repositories (test keys, sample tokens, a public
# Firebase config): they are reported, with samples, and fail only above REGREP_FIXTURE_CEILING,
# the counts the final build was read against by hand.
REGREP_ZERO = ("owner name", "review bot", "old product name", "private repo", "secret value", "private word",
               "denylist word", "home directory", "token ", "host ", "ticket id", "tracker path", "session text",
               "member is a session log", "companion-pihome")
REGREP_FIXTURE_CEILING: dict[str, int] = {}


def regrep_failures(total: collections.Counter, ceiling: dict | None = None) -> list[str]:
    """The classes over their allowance: every REGREP_ZERO class above 0, and every
    credential-shaped class above its ceiling (`ceiling`, default REGREP_FIXTURE_CEILING)."""
    ceiling = REGREP_FIXTURE_CEILING if ceiling is None else ceiling
    bad = []
    for k, n in sorted(total.items()):
        if not n:
            continue
        if k.startswith(REGREP_ZERO) and not (k == "companion-pihome" and n <= 2):
            bad.append(f"{k}: {n}")
        elif k in SAMPLED and k in ceiling and n > ceiling[k]:
            bad.append(f"{k}: {n} (allowed {ceiling[k]})")
    return bad


def regrep_stream(cmd: list[str]) -> tuple[collections.Counter, list]:
    """Counts of every REGREP class over one decompressed stream, with
    samples (and their tar member) for the credential-shaped classes."""
    rx = {k: re.compile(v) for k, v in REGREP.items()}
    z = subprocess.Popen(cmd, stdout=subprocess.PIPE)
    if shutil.which("rg"):
        argv = ["rg", "-a", "-o", "--no-filename", "--no-line-number"]
        for pat in REGREP_RG:
            argv += ["-e", pat.decode()]
    else:
        argv = ["grep", "-aoP", REGREP_SCAN.decode()]
    g = subprocess.Popen(argv, stdin=z.stdout, stdout=subprocess.PIPE)
    z.stdout.close()
    c, hits = collections.Counter(), []
    for line in g.stdout:
        m = line.rstrip(b"\n")
        for k, r in rx.items():
            n = len(r.findall(m))
            if n:
                c[k] += n
                if k in SAMPLED and len(hits) < 20:
                    hits.append((k, m[:24].decode(errors="replace") + "..."))
    grc, zrc = g.wait(), z.wait()
    if zrc != 0 or grc not in (0, 1):
        # grep exits 1 for "no match"; anything else, or a decompressor
        # failure, means the stream was not scanned whole.
        raise SystemExit(f"regrep failed for {cmd[-1]}: {cmd[0]} exit {zrc}, grep exit {grc}")
    return c, hits


def session_members(names) -> collections.Counter:
    """Member names that are session logs (session_logs.classify drops or
    extracts them): every count must be 0 in a built volume, whose session
    logs ship only as `*.pruned.jsonl` extracts."""
    c = collections.Counter()
    for n in names:
        sl = SL.classify(n)
        if sl is not None:
            c[f"member is a session log: {sl[0]}"] += 1
    return c


def volume_members(vol: str) -> list[str]:
    z = subprocess.Popen(["zstd", "-dc", "--long=27", "-q", vol], stdout=subprocess.PIPE)
    t = subprocess.run(["tar", "-t"], stdin=z.stdout, capture_output=True)
    z.stdout.close()
    if z.wait() != 0 or t.returncode != 0:
        raise SystemExit(f"listing failed for {vol}")
    return t.stdout.decode(errors="replace").splitlines()


def _regrep_volume(vol: str):
    c, hits = regrep_stream(["zstd", "-dc", "--long=27", "-q", vol])
    names = volume_members(vol)
    c.update(session_members(names))
    c["members listed"] += len(names)
    c["members that are extracts (*.pruned.jsonl)"] += sum(1 for n in names if n.endswith(SL.PRUNED_SUFFIX))
    return Path(vol).name, c, hits


def cmd_regrep(a):
    out = Path(a.out)
    total = collections.Counter()
    report, samples = {}, {}
    vols = [str(v) for v in sorted(out.glob("*.tar.zst"), key=lambda p: -p.stat().st_size)]
    with multiprocessing.Pool(max(1, min(a.jobs, len(vols) or 1))) as pool:
        for name, c, hits in pool.imap_unordered(_regrep_volume, vols):
            report[name] = dict(c)
            if hits:
                samples[name] = hits
            total.update(c)
            print(name, dict(c), flush=True)
    report = dict(sorted(report.items()))
    for side in sorted(p for p in out.rglob("*") if p.is_file() and p.name != "regrep.json"
                       and (p.suffix in (".json", ".md", ".txt") or p.name in ("SHA256SUMS", "NOTICE"))):
        c, _ = regrep_stream(["cat", str(side)])
        if c:
            report[side.name] = dict(c)
            total.update(c)
    print("TOTAL", dict(total))
    ceiling = json.loads(Path(a.fixtures).read_text()) if getattr(a, "fixtures", None) else None
    bad = regrep_failures(total, ceiling)
    # the report is the build's record, beside the folder: nothing in the folder is uploaded unread
    rep = Path(a.report) if getattr(a, "report", None) else out.parent / f"regrep-{out.name}.json"
    rep.write_text(json.dumps({"volumes": report, "total": dict(total), "samples": samples, "failures": bad},
                              indent=1) + "\n")
    if bad:
        print("RE-GREP FAILED:", *bad, sep="\n  ")
        sys.exit(1)
    print("re-grep clean: every identity, credential value, private word, ticket and session-text class is 0")


def main():
    ap = argparse.ArgumentParser(description=__doc__.split("\n")[0])
    sub = ap.add_subparsers(dest="cmd", required=True)
    for name in ("plan", "archive", "slim", "regrep", "readme"):
        s = sub.add_parser(name)
        if name not in ("regrep",):
            s.add_argument("--src", default=os.environ.get("QCR_BENCH_ROOT"), required=os.environ.get("QCR_BENCH_ROOT") is None)
            s.add_argument("--open-models", help="the open-model benchmark dir (its runs/ and driver files), shipped under open-models/")
            s.add_argument("--catalogue", required=True, help="the run catalogue (release_catalogue.py)")
        if name != "plan":
            s.add_argument("--out", required=True)
        if name in ("archive", "readme", "slim"):
            s.add_argument("--commit-remap", help="JSON {recorded qcr_commit: public main commit or null}")
        if name == "regrep":
            s.add_argument("--jobs", type=int, default=2, help="volumes scanned side by side")
            s.add_argument("--report", help="where the counts go (default: regrep-<folder>.json beside the folder)")
            s.add_argument("--fixtures", help="JSON {credential-shaped class: ceiling} of third-party fixture counts "
                                              "read by hand; a class over it fails")
        if name in ("archive", "slim"):
            s.add_argument("--level", type=int, default=19)
            s.add_argument("--cap", type=int, default=int(1.9 * GIB))
            s.add_argument("--threads", type=int, default=3)
        if name == "archive":
            s.add_argument("--groups", default="", help="comma-separated families to build (default: all)")
            s.add_argument("--rebuild", action="store_true", help="rebuild groups the manifest already records")
            s.add_argument("--jobs", type=int, default=2)
    a = ap.parse_args()
    if a.cmd in ("archive", "slim", "regrep") and not (SCRUB_BOTS and SCRUB_OWNERS):
        sys.exit("set QCR_SCRUB_BOT and QCR_SCRUB_OWNER: the identities this export scrubs come from the exporter")
    if a.cmd == "readme":
        proc = _proc(a)
        write_index(Path(a.out), proc, a)
        write_readme(Path(a.out), proc)
        return
    {"plan": cmd_plan, "archive": cmd_archive, "slim": cmd_slim, "regrep": cmd_regrep}[a.cmd](a)


if __name__ == "__main__":
    main()
