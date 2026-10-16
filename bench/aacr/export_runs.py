#!/usr/bin/env python3
"""Assemble the publishable run archive and the slim re-score bundle.

    bench/aacr/export_runs.py plan    --src RUNS_ROOT
    bench/aacr/export_runs.py archive --src RUNS_ROOT --out OUT/archive [--groups a,b] [--jobs 3]
    bench/aacr/export_runs.py slim    --src RUNS_ROOT --out OUT/slim
    bench/aacr/export_runs.py regrep  --out OUT/archive   (or OUT/slim)

RUNS_ROOT is the directory that holds `runs/` (the qcr-bench-runs dir). The
input is read only. Nothing is uploaded and no model is called.

What ships (the run-data policy): every run under `runs/`,
`analysis/`, `whatif/`, `logs/`, `ext-images/`, and the answer key from the
`*-code` dirs. What never ships: `notes/` (private; the walk refuses to enter
it), `ext-cache/`, `ext-data/`, `scratch-archive/` (third-party data,
regenerable clones, scratch), the reviewed repos' code (`repo.git`, `base/`,
`head/`, `pr.diff` — refetch them from repo@commit), Martian's own data, the
byte-identical copies inside the Martian posting-policy variants, and
third-party comment text (vendor review comments, harvested Copilot reviews,
SWE-PRBench's human review comments), which is replaced by a marker with a
hash and a link.

Every shipped text file is rewritten while it streams, in this order, and
nothing else in it changes:

  * `example-review[bot]` (and the bare app slug `example-review`) -> `<review-bot>`,
    then `the owner` (any case) -> `<owner>`;
  * `quickreviewd` -> `quickreview` (the product's internal name);
  * host paths: `$HOME/qcr-bench-runs` -> `<runs>`,
    `$HOME/src/quickreview` -> `<repo>`, any other
    `$HOME` -> `<home>` (the home scrubbed is $QCR_SCRUB_HOME, default `~`), the docker volume `companion-pihome` -> `<pi-login-volume>`
    (the same spellings as the Hugging Face dataset export, hf_export.py);
  * encrypted reasoning blobs are blanked, the record kept: the value of every
    `encrypted_content` (OpenAI), every base64 `thinkingSignature` and
    `signature` (Anthropic) becomes the empty string.

Archive volumes are per-group `.tar.zst` (zstd -19 --long=27: a 128 MiB window,
the largest any stock zstd decoder accepts without flags), each closed before
it passes --cap (default 1.9 GiB; see the archive README for why), with a
manifest (sha256 per volume, per-file counts, per-rule counts).

The slim bundle holds only what compare.py, charts.py,
final/score.sh and the ext scorers read, minus `pi-events.jsonl`: each case's
`case-summary.json` gains `bench_cost_usd` (compare.py's own per-case figure,
computed here from the full case dir) and `bench_cost_source`.
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

GIB = 1 << 30
MIN_FREE = 8 * GIB
SHIPPED_TOPS = ("runs", "analysis", "whatif", "logs", "ext-images", "fresh10-code", "orig40-code", "rest145-code")
NEVER = ("notes", "ext-cache", "ext-data", "scratch-archive")
# runs whose reviewed code is QuickReview's own private repository (the
# self-review set): its source, infrastructure names and handles are not
# public and cannot be refetched from a public repo@commit, so the run is
# withheld
PRIVATE_RUNS = ("pc1-self-review-pc1",)
MARTIAN_SRC = "https://github.com/withmartian/code-review-benchmark/blob/e616e84/offline/results/benchmark_data.json"
QODO_VENDORS = {"qodo-exhaustive", "qodo-precise", "augment", "copilot", "cursor", "greptile", "codex", "coderabbit", "sentry"}

# ---------------------------------------------------------------- the rewrite

# the exporting host's home directory and hostnames, scrubbed from every file
# and re-grepped afterwards: $QCR_SCRUB_HOME (default: this user's home) and
# $QCR_SCRUB_HOSTS (comma-separated, default none)
SCRUB_HOME = os.environ.get("QCR_SCRUB_HOME", os.path.expanduser("~")).rstrip("/")
SCRUB_HOSTS = [h for h in os.environ.get("QCR_SCRUB_HOSTS", "").split(",") if h.strip()]
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


RULES = [
    # (name, compiled regex, replacement, prefilter) — applied in this order. The
    # prefilter is a literal that must be in the data (or, as ("low", x), in its
    # lower-cased copy) before the regex runs: speed only, never a different result.
    ("review-bot", re.compile(rb"example-review" + BOT), b"<review-bot>", b"example-review"),
    ("review-bot-other-case", re.compile(rb"(?i:example-review)" + BOT), b"<review-bot>", ("low", b"example-review")),
    ("owner", re.compile(rb"the owner"), b"<owner>", b"the owner"),
    ("owner-other-case", re.compile(rb"(?i:<owner>)"), b"<owner>", ("low", b"owner_legacy")),
    ("quickreviewd", re.compile(rb"quickreviewd"), b"quickreview", b"quickreviewd"),
    ("runs", re.compile(rb"(?:" + HOME_RX + rb"/src|~/src)/qcr-bench-runs"), b"<runs>", b"qcr-bench-runs"),
    ("repo", re.compile(rb"(?:" + HOME_RX + rb"/src|~/src)/review-sandbox"), b"<repo>", b"src/quickreview"),
    ("scratchpad", re.compile(rb"/tmp/claude-\d+/" + HOME_DASHED_RX + rb"-[A-Za-z0-9\-]*/[0-9a-f\-]{36}(?:/scratchpad)?"), b"<scratchpad>", b"/" + HOME_DASHED + b"-"),
    ("claude-project", re.compile(rb"\.claude/projects/" + HOME_DASHED_RX + rb"-[A-Za-z0-9\-]*"), b".claude/projects/<project>", b"/" + HOME_DASHED + b"-"),
    ("home", re.compile(HOME_RX + rb"(?![A-Za-z0-9_\-])"), b"<home>", HOME_B),
    ("home-dashed", re.compile(HOME_DASHED_RX + rb"(?=[-/])"), b"-<home>", HOME_DASHED),
    ("home-escaped", re.compile(HOME_ESC_RX + rb"(?![A-Za-z0-9_\-])"), b"<home>", HOME_ESC),
    ("pi-login-volume", re.compile(rb"companion-pihome"), b"<pi-login-volume>", b"companion-pihome"),
    ("blob-encrypted_content", re.compile(rb"(encrypted_content" + ESCQ + rb")" + B64 + rb"+"), rb"\1", b"encrypted_content"),
    ("blob-thinkingSignature", re.compile(rb"(thinkingSignature" + ESCQ + rb")" + B64 + rb"{40,}"), rb"\1", b"thinkingSignature"),
    ("blob-signature", re.compile(rb"(signature" + ESCQ + rb")" + B64 + rb"{100,}"), _sig_keep, b"signature"),
]
NAME_RULES = RULES[:13]  # the rules that also apply to member names


def rewrite(data: bytes, counts: collections.Counter, rules=RULES) -> bytes:
    low = None
    for name, rx, rep, pre in rules:
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


def is_text(data: bytes) -> bool:
    return b"\x00" not in data[:65536]


def omitted(text: str, link: str) -> str:
    h = hashlib.sha256(text.encode()).hexdigest()[:16]
    return f"[third-party text omitted, sha256:{h}; see {link}]"


# ---------------------------------------------------------------- groups

def _list(path: Path) -> set[str]:
    out = set()
    if path.exists():
        for line in path.read_text().splitlines():
            if "=" in line:
                for rep in line.split("=", 1)[1].split("+"):
                    out.update(r for r in rep.split(",") if r)
    return out


FINAL_ARMS = _list(HERE / "final" / "arms.txt")
SOL_ARMS = _list(HERE / "final" / "arms-gpt6sol.txt")
GROUPS = {
    "aacr-frozen": "the frozen build (final1), the fast option (fast1), the freeze/decision validations (fv1, dv1, dv1hi, pc2), the dedup run, and the rerun-all driver dirs",
    "aacr-final-arms": "the eight-reviewer final comparison on gpt-6.1-sol (final/arms.txt) and its gpt-6.1 smoke runs",
    "aacr-study": "the earlier gpt-6-sol study (final/arms-gpt6sol.txt), the best-shot configuration search (best-, fair-, fsmoke-), Opus, luna, v2-default, the stability repeats (stab-) and the harvested upstream Copilot reviews",
    "aacr-dev": "development history: scr- ablations, lever and iteration runs, smoke and plumbing runs",
    "martian": "Martian offline benchmark: QuickReview and comparator runs, every Martian scoring dir, the posting-policy variants (new files only)",
    "qodo": "Qodo PR-Review-Bench: QuickReview and comparator runs, every Qodo scoring dir (vendor comment bodies omitted)",
    "sweprbench": "SWE-PRBench: QuickReview runs and the harness's scoring dirs",
    "answer-key": "the AACR-derived defect benchmark's answer key and case metadata (*-code dirs without the reviewed repos' code)",
    "analysis": "analysis/ (the scripts and data behind the reports), whatif/, driver logs, image ids",
}


def run_group(name: str) -> str:
    if re.match(r"(mv|mt|qr)-", name) or "martian" in name or name == "all50-logs":
        return "martian"
    if "qodo" in name:
        return "qodo"
    if "swepr" in name or name.startswith("ext-plumbing"):
        return "sweprbench"
    if re.match(r"(final1|fast1|fv1|dv1|dv1hi|pc2|r7-dedup5)-|rerun-", name):
        return "aacr-frozen"
    if name in FINAL_ARMS or name.startswith(("g61", "pi099-")):
        return "aacr-final-arms"
    if name in SOL_ARMS or re.match(r"(b40|all-|upstream-copilot|opus-|v2-default|stab-|best-|fair-|fsmoke-|astra-)", name):
        return "aacr-study"
    return "aacr-dev"


class Tree:
    """The source tree: which run dir each top-level runs/ file belongs to."""

    def __init__(self, src: Path):
        self.src = src
        runs = src / "runs"
        self.run_dirs = sorted((p.name for p in runs.iterdir() if p.is_dir() and not p.name.startswith(".")), key=len, reverse=True)

    def run_of(self, name: str) -> str:
        for d in self.run_dirs:
            if name == d or name.startswith(d + "."):
                return d
        return re.sub(r"\.[^.]*$", "", name)

    def group(self, rel: str) -> str:
        parts = rel.split("/")
        top = parts[0]
        if top in ("analysis", "whatif", "logs", "ext-images"):
            return "analysis"
        if top.endswith("-code"):
            return "answer-key"
        return run_group(self.run_of(parts[1]))


# ---------------------------------------------------------------- per-file policy

SWEPR_HUMAN = re.compile(r"analysis/sweprbench-[^/]+/(human-all\.txt|joined\.json|misses\.txt|samples\.json|files/)")


def drop_reason(rel: str) -> str | None:
    parts = rel.split("/")
    name = parts[-1]
    if parts[0] in NEVER or "notes" == parts[0]:
        raise SystemExit(f"refusing to read {rel}: {parts[0]}/ never ships")
    if "__pycache__" in parts or name.endswith(".pyc") or name == ".DS_Store":
        return "cache files"
    if parts[0] == "runs" and parts[1].startswith("."):
        return "scheduler state (runs/.slots)"
    if parts[0] == "runs" and any(parts[1] == r or parts[1].startswith(r + ".") for r in PRIVATE_RUNS):
        return "private: QuickReview reviewing its own unpublished repository (the self-review run)"
    if parts[0] == "runs" and ".martian" in parts[1]:
        if name == "published-benchmark_data.json" or "golden_comments" in parts:
            return "third-party: Martian's own data (pin withmartian/code-review-benchmark@e616e84)"
    if parts[0].endswith("-code"):
        if len(parts) > 2 and parts[2] in ("repo.git", "base", "head"):
            return "regenerable: reviewed-repo code (refetch repo@commit)"
        if name in ("pr.diff",):
            return "regenerable: reviewed-repo code (refetch repo@commit)"
    if parts[0] == "analysis":
        if SWEPR_HUMAN.match(rel):
            return "third-party: SWE-PRBench human review comments (see foundry-ai/swe-prbench@b87f579)"
        if name.endswith(".diff"):
            return "regenerable: reviewed-repo code (refetch repo@commit)"
    return None


class ThirdParty:
    """Structural removal of third-party comment text from the files our
    tooling copied it into; everything else of those files is kept."""

    def __init__(self, src: Path):
        self.src = src
        self.qodo_links = {}
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

def walk_files(src: Path, tops=SHIPPED_TOPS):
    for top in tops:
        root = src / top
        if not root.exists():
            continue
        if root.is_file():
            yield top
            continue
        for dp, dns, fns in os.walk(root):
            rel_dp = os.path.relpath(dp, src)
            depth = rel_dp.count("/")
            # never descend into the reviewed repos' code (it is left out anyway)
            dns[:] = sorted(d for d in dns if not (top.endswith("-code") and depth == 1 and d in ("repo.git", "base", "head")))
            for fn in sorted(fns):
                yield f"{rel_dp}/{fn}"


def variant_sources(src: Path, run: str) -> list[str]:
    v = src / "runs" / run / "VARIANT.json"
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


class Processor:
    """Decides and transforms one file; shared by archive and slim."""

    def __init__(self, src: Path):
        self.src = src
        self.tree = Tree(src)
        self.tp = ThirdParty(src)
        self._vsrc = {}

    def identical_source(self, rel: str) -> str | None:
        parts = rel.split("/")
        if parts[0] != "runs" or not re.match(r"(mv|mt|qr)-", parts[1]) or "." in parts[1] or len(parts) < 4:
            return None
        run = parts[1]
        if run not in self._vsrc:
            self._vsrc[run] = variant_sources(self.src, run)
        inner = "/".join(parts[2:])
        mine = self.src / rel
        for s in self._vsrc[run]:
            other = self.src / "runs" / s / inner
            if other.is_file() and other.stat().st_size == mine.stat().st_size and sha256_file(other) == sha256_file(mine):
                return f"runs/{s}/{inner}"
        return None

    def process(self, rel: str, counts: collections.Counter) -> tuple[bytes | None, str | None]:
        """(content, None) to ship, or (None, reason) to leave out."""
        r = drop_reason(rel)
        if r:
            return None, r
        p = self.src / rel
        data = p.read_bytes()
        parts = rel.split("/")
        if parts[0] == "runs" and len(parts) > 2:
            run = parts[1]
            if ".martian" in run and parts[-1] == "benchmark_data.json":
                data = self.tp.martian_benchmark_data(data, counts)
            elif ".qodo" in run and parts[-1] == "judgements.jsonl":
                data = self.tp.qodo_judgements(data, counts)
            elif run.startswith("upstream-copilot"):
                data = self.tp.copilot_file(self.src / "runs" / run, "/".join(parts[2:]), data, counts)
                if data is None:
                    return None, "third-party: the judge transcript quotes harvested Copilot reviews (verdicts kept)"
        if parts[0].endswith("-code") and parts[-1] == "meta.json":
            data = self.tp.pr_body(data, counts)
        if is_text(data):
            data = rewrite(data, counts)
            counts["files-text"] += 1
        else:
            counts["files-binary"] += 1
        return data, None


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
        parts = arcname.split("/")
        v["members"][parts[1] if parts[0] == "runs" and len(parts) > 1 else parts[0]] += 1
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


def build_group(args) -> dict:
    src, out, group, files, level, cap, threads = args
    src, out = Path(src), Path(out)
    proc = Processor(src)
    counts = collections.Counter()
    dropped = collections.Counter()
    identical = {}
    w = VolumeWriter(out, f"quickreview-runs-{group}", level, cap, threads)
    t0 = time.time()
    for rel in files:
        same = proc.identical_source(rel)
        if same:
            identical[rel] = same
            dropped["byte-identical copy of the variant's source run (listed in SOURCE-COPIES.json)"] += 1
            continue
        try:
            data, reason = proc.process(rel, counts)
        except FileNotFoundError:
            dropped["vanished during the walk"] += 1
            continue
        if reason:
            dropped[reason] += 1
            continue
        w.add(rewrite_name(rel, counts), data, (src / rel).stat().st_mtime)
    if identical:
        by_run = collections.defaultdict(dict)
        for rel, s in identical.items():
            run = rel.split("/")[1]
            by_run[run]["/".join(rel.split("/")[2:])] = s
        for run, m in sorted(by_run.items()):
            doc = {"note": "Files of this posting-policy variant that were byte-identical to its source run's "
                           "(same size and sha256) are not repeated in the archive; each maps to the source file.",
                   "files": dict(sorted(m.items()))}
            w.add(f"runs/{run}/SOURCE-COPIES.json", (json.dumps(doc, indent=1) + "\n").encode(), time.time())
    vols = w.finish()
    return {"group": group, "volumes": [{**v, "path": str(v["path"]), "members": dict(v["members"])} for v in vols],
            "counts": dict(counts), "dropped": dict(dropped), "seconds": round(time.time() - t0)}


def cmd_plan(a):
    src = Path(a.src)
    tree = Tree(src)
    size, n, drop = collections.Counter(), collections.Counter(), collections.Counter()
    for rel in walk_files(src):
        try:
            s = (src / rel).stat().st_size
        except OSError:
            continue
        g = tree.group(rel)
        r = drop_reason(rel)
        if r:
            drop[(g, r)] += s
            continue
        size[g] += s
        n[g] += 1
    for g in GROUPS:
        print(f"{g:18} {n[g]:8} files {size[g] / GIB:8.2f} GiB raw (before variant de-duplication)")
    print()
    for (g, r), s in sorted(drop.items()):
        print(f"dropped {g:18} {s / GIB:8.2f} GiB  {r}")


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
    src, out = Path(a.src), Path(a.out)
    out.mkdir(parents=True, exist_ok=True)
    tree = Tree(src)
    groups = [g for g in GROUPS if not a.groups or g in a.groups.split(",")]
    todo = []
    for g in groups:
        if group_done(out, g) and not a.rebuild:
            print(f"  {g}: already complete in MANIFEST.json, skipped (--rebuild to redo)", flush=True)
        else:
            todo.append(g)
    files = collections.defaultdict(list)
    if todo:
        for rel in walk_files(src):
            g = tree.group(rel)
            if g in todo:
                files[g].append(rel)
    for g in todo:
        clear_group(out, g)
    jobs = [(str(src), str(out), g, files[g], a.level, a.cap, a.threads) for g in todo if files[g]]
    jobs.sort(key=lambda j: -len(j[3]))
    if jobs:
        with multiprocessing.Pool(min(a.jobs, len(jobs))) as pool:
            for r in pool.imap_unordered(build_group, jobs):
                for v in r["volumes"]:
                    print(f"  {Path(v['path']).name}: {v['files']} files, {os.path.getsize(v['path']) / (1 << 20):.1f} MiB "
                          f"({r['seconds']} s)", flush=True)
                write_manifest(out, src, [r], a)
    missing = [g for g in GROUPS if not group_done(out, g)]
    if missing:
        print(f"README not written: groups still to build: {', '.join(missing)}")
    else:
        write_readme(out)


def write_manifest(out: Path, src: Path, results: list, a):
    # one invocation per group may run side by side: the manifest's
    # read-modify-write holds an exclusive lock, and lands by rename
    import fcntl
    with open(out / ".MANIFEST.lock", "w") as lock:
        fcntl.flock(lock, fcntl.LOCK_EX)
        _write_manifest(out, src, results, a)


def _write_manifest(out: Path, src: Path, results: list, a):
    man_path = out / "MANIFEST.json"
    prior = json.loads(man_path.read_text()) if man_path.exists() else {"groups": {}}
    for r in results:
        vols = []
        for v in r["volumes"]:
            p = Path(v["path"])
            vols.append({"file": p.name, "bytes": p.stat().st_size, "sha256": sha256_file(p),
                         "files": v["files"], "uncompressed_bytes": v["bytes_in"], "files_by_run_or_dir": v["members"]})
        prior["groups"][r["group"]] = {"what": GROUPS[r["group"]], "volumes": vols, "rewrites": r["counts"],
                                       "left_out": r["dropped"]}
    prior.update({
        "created": datetime.datetime.now(datetime.timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ"),
        "compression": f"zstd -{a.level} --long=27 (window 128 MiB: any zstd >= 1.3.2 decodes it without flags)",
        "volume_cap_bytes": a.cap,
        "rewrites_applied": [r[0] for r in RULES],
        "placeholders": {"the owner": "<owner>", "example-review[bot]": "<review-bot>", "quickreviewd": "quickreview",
                         "<home>/qcr-bench-runs": "<runs>",
                         "<home>/src/quickreview": "<repo>",
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


# ---------------------------------------------------------------- archive README

def write_readme(out: Path):
    man = json.loads((out / "MANIFEST.json").read_text())
    rows, total, nfiles = [], 0, 0
    for g in GROUPS:
        if g not in man["groups"]:
            continue
        for v in man["groups"][g]["volumes"]:
            total += v["bytes"]
            nfiles += v["files"]
            rows.append(f"| `{v['file']}` | {g} | {v['files']:,} | {v['bytes'] / (1 << 20):.1f} MiB | `{v['sha256']}` |")
    groups = "\n".join(f"- **{g}**: {GROUPS[g]}." for g in GROUPS if g in man["groups"])
    counts = collections.Counter()
    left = collections.Counter()
    for g in man["groups"].values():
        counts.update(g["rewrites"])
        left.update(g["left_out"])
    rw = "\n".join(f"| `{k}` | {v:,} |" for k, v in sorted(counts.items()) if not k.startswith("files-"))
    lo = "\n".join(f"| {k} | {v:,} |" for k, v in sorted(left.items()))
    level = man["compression"].split()[1].lstrip("-")
    cap = man["volume_cap_bytes"] / (1 << 30)
    text = f"""---
license: apache-2.0
pretty_name: QuickReview benchmark runs (run archive)
tags:
- code-review
- benchmark
---

# QuickReview benchmark runs — the run archive

Every run behind the QuickReview benchmark papers: each reviewer's full
transcript (`pi-events.jsonl`, sessions, Codex and OpenCode event streams),
its review, the judges' verdicts and transcripts, AACR-Bench's own metric
files, the Martian, Qodo PR-Review-Bench and SWE-PRBench scoring, the answer
key, and the analysis behind the reports. {nfiles:,} files in {len(rows)}
volumes, {total / (1 << 20):.0f} MiB compressed.

DOI: minted by Hugging Face at upload. Code, benchmark definition and papers:
the QuickReview repository, `bench/aacr/`. The slim re-score bundle (no
transcripts, about 13 MiB) is published beside this archive and is enough to
recompute every table without a model call.

## Volumes

| File | Group | Files | Size | sha256 |
|---|---|---|---|---|
{chr(10).join(rows)}

`SHA256SUMS` lists the same hashes. `MANIFEST.json` adds, per volume, the
uncompressed size and the file count per run directory, and, per group, the
count of every rewrite and of every file left out, by reason.

Unpack every volume into one directory to get the original layout
(`runs/`, `analysis/`, `whatif/`, `logs/`, `ext-images/`, `*-code/`):

    mkdir quickreview-runs
    for v in quickreview-runs-*.tar.zst; do tar --zstd -xf "$v" -C quickreview-runs; done
    export QCR_BENCH_RUNS_DIR=$PWD/quickreview-runs/runs

Compression: zstd level {level} with a 128 MiB window (`--long=27`), the
largest window any zstd from 1.3.2 on decodes without extra flags; level 19
because the transcripts repeat themselves across hundreds of megabytes, which
only a long window and a high level reach (gzip's 32 KiB window cannot see
them). Each volume is a complete tar on its own and
stays under {cap:.1f} GiB, so a download resumes per file and every volume
also fits a GitHub release asset (2 GiB) as a mirror; Hugging Face's own
per-file limit is far higher.

## Groups

{groups}

## What was changed, and nothing else

The archive is the run directories as the runs wrote them, with these
mechanical rewrites applied to every text file and file name while it was
packed. Nothing else in the text changed.

- **Names.** `example-review[bot]` (the GitHub App persona, and its bare slug
  `example-review`) became `<review-bot>`; the owner's first name `the owner`
  became `<owner>`. One placeholder per name, everywhere: prompts,
  transcripts, the model's own text, judge inputs, logs.
- **The product's old name.** `quickreviewd` became `quickreview`. It is the
  product's earlier name, not a person, so it gets the public name rather
  than a placeholder.
- **Host paths** in driver logs and analysis: `<home>/qcr-bench-runs`
  became `<runs>`, `<home>/src/quickreview` `<repo>`, any
  other path under the exporting user's home `<home>` (so the Claude Code credential file's path reads
  `<home>/.config/qcr-bench/claude.env`; its value never appeared), and the
  docker volume `companion-pihome` `<pi-login-volume>`. No model saw these.
  An agent's scratch directory (`/tmp/claude-<uid>/-home-…/<session>/scratchpad`)
  became `<scratchpad>` and a Claude Code project dir `.claude/projects/<project>`,
  the spellings of the repository's `docs/PROMPTS.md`. The other spellings are
  the same as in the Hugging Face dataset.
- **Encrypted reasoning blobs are blanked.** The value of every
  `encrypted_content` field (OpenAI reasoning items) and of every base64
  `thinkingSignature` and `signature` (Anthropic thinking blocks) is the empty
  string; the record around it is kept. The blobs are ciphertext under the
  providers' keys, readable by nobody else; the usage records still carry the
  reasoning-token counts.
- **Third-party text is linked, not copied.** Vendor review comments (the
  published tools Martian re-judged, the nine Qodo vendors, the upstream
  GitHub Copilot reviews) and the PR descriptions in the answer key's
  `meta.json` are replaced by
  `[third-party text omitted, sha256:<first 16 hex of the text's sha256>; see <link>]`.
  The hash keeps equal texts equal, so every score recomputes unchanged.
  JSON files whose third-party text was replaced were re-serialised with
  their original indentation.

Rewrite counts over the whole archive:

| Rewrite | Count |
|---|---|
{rw}

## What is not here, and why

| Left out | Files |
|---|---|
{lo}

Also not here: the reviewed repositories' code (`repo.git`, the `base/` and
`head/` file trees and the `pr.diff` of each case; refetch them from the
repository and commits in each case's `meta.json`, as AACR-Bench does),
`ext-cache/` and `ext-data/` (the external benchmarks' own data and
harnesses, pinned: withmartian/code-review-benchmark@e616e84, Hugging Face
Qodo/PR-Review-Bench@a73957c, foundry-ai/swe-prbench@b87f579 and
FoundryHQ-AI/swe-prbench@379f0bf), scratch, and the authors' private notes.
The posting-policy variants of the Martian runs (`mv-*`, `qr-*`,
`mt-test30-frozen`) copied their source runs' transcripts: only their new
files ship, and each variant's `SOURCE-COPIES.json` maps every left-out file
to the identical file of its source run.

The Claude Code arm kept only its final result JSON (cost, usage, result
text) and no transcript. That is what the run wrote, not something removed
here.

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

External benchmarks, under their own licences; their data are referenced,
not redistributed, beyond short quotations inside judge outputs and the
MIT-licensed golden comments inside Martian's scoring files: Martian's
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


ARCHIVE_NOTICE = """This run archive was assembled by Quickchat AI and is distributed under the Apache
License, Version 2.0 (LICENSE).

It contains material derived from AACR-Bench v1.0 (https://github.com/alibaba/aacr-bench,
dataset commit ab8af8d5c74e2a4d1945d247ea4bbc49f93eb33f, harness commit
68a569759289a83654a59d06db2a72910edf0a4a), licensed under the Apache License, Version 2.0.
AACR-Bench ships no NOTICE file of its own. MODIFIED WORK: derived from AACR-Bench v1.0
and modified by Quickchat AI in 2026. The runs re-key AACR-Bench's PRs with a verified
defect key, score new reviews against it, and keep AACR-Bench's reference comments and
labels and its harness's metric files as the harness wrote them (the harness ran
unmodified except for its judge endpoint). Cite: Zhang et al., "AACR-Bench: Evaluating
Automatic Code Review with Holistic Repository-Level Context", arXiv:2601.19494 (2026).

Martian's scoring dirs contain golden comments from Martian's offline code-review
benchmark (https://github.com/withmartian/code-review-benchmark, commit
e616e849755441da38f18bf3adba2c9583b03803), MIT licence, Copyright (c) 2025 Martian.

The Qodo scoring dirs contain issues from Qodo PR-Review-Bench
(https://huggingface.co/datasets/Qodo/PR-Review-Bench, revision
a73957c450a70693a743260e5637fffc44625f16), MIT licence, by the Qodo team.

SWE-PRBench (https://huggingface.co/datasets/foundry-ai/swe-prbench, CC BY 4.0; harness
MIT): its data is not redistributed here; its human review comments are left out.

Code quoted by reviewers and judges comes from the reviewed open-source repositories at
the commits each case names and stays under each project's own licence. Comments written
by third-party review tools and the PR descriptions written by PR authors are not
included: each is replaced by a hash and a link to the original.
"""


def write_licence(out: Path):
    shutil.copyfile(HERE / "hf" / "LICENSE", out / "LICENSE")
    (out / "NOTICE").write_text(ARCHIVE_NOTICE)

# ---------------------------------------------------------------- slim bundle

SLIM_RUN_FILES = re.compile(r"^(run\.json|judge\.txt|judge/[^/]+/([^/]+\.r1\.json|score\.json|report\.md)"
                            r"|results/all/[^/]+\.json|cases/[^/]+/case-summary\.json)$")
SLIM_MARTIAN = re.compile(r"^(martian-scores\.json|martian-report\.md|score_profiles\.txt|judge/JUDGE\.txt"
                          r"|results/ingest-report\.json|results/[^/]+/(evaluations|candidates)\.json)$")
SLIM_QODO = re.compile(r"^(scores\.json|scores\.md|judgements\.jsonl|judge/JUDGE\.txt)$")


def slim_select(rel: str) -> bool:
    parts = rel.split("/")
    if parts[0] != "runs" or len(parts) < 3:
        return False
    run, inner = parts[1], "/".join(parts[2:])
    if "swepr" in run or re.match(r"(mv|mt|qr)-", run) and "." not in run:
        return False  # SWE-PRBench data ships in the archive only; variant reviews are not scored by compare.py
    if ".martian" in run:
        return bool(SLIM_MARTIAN.match(inner))
    if ".qodo" in run:
        return bool(SLIM_QODO.match(inner))
    if "." in run:
        return False
    return bool(SLIM_RUN_FILES.match(inner))


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
    src, out = Path(a.src), Path(a.out)
    out.mkdir(parents=True, exist_ok=True)
    for old in out.glob("quickreview-bench-slim.*"):  # an earlier or interrupted build: rebuilt whole
        old.unlink()
    proc = Processor(src)
    counts, n = collections.Counter(), 0
    w = VolumeWriter(out, "quickreview-bench-slim", a.level, a.cap, a.threads)
    index = []
    for rel in walk_files(src, ("runs",)):
        if not slim_select(rel):
            continue
        data, reason = proc.process(rel, counts)
        if reason:
            continue
        if rel.endswith("/case-summary.json"):
            s = json.loads(data)
            usd, how = slim_cost(src / os.path.dirname(rel))
            s["bench_cost_usd"] = usd
            s["bench_cost_source"] = how
            data = (json.dumps(s, indent=1, ensure_ascii=False) + "\n").encode()
            counts["case-summaries-with-slim-cost"] += 1
        name = rewrite_name(rel, counts)
        w.add(name, data, (src / rel).stat().st_mtime)
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
    write_licence(out)
    (out / "counts.json").write_text(json.dumps(dict(counts), indent=1) + "\n")


def slim_readme(n: int, counts) -> str:
    return f"""# QuickReview benchmark — slim re-score bundle

{n} files. Everything `bench/aacr/final/score.sh`, `compare.py`, `charts.py` and
the external-benchmark scorers read to recompute the papers' tables, with no
model call and no transcript. The full run archive (with every `pi-events.jsonl`)
is the separate run-archive dataset; this bundle is a subset of it, rewritten the
same way (see the archive README: names, placeholders, blanked reasoning blobs).

Unpack it and point the tools at its `runs/`:

    mkdir slim && tar --zstd -xf quickreview-bench-slim.tar.zst -C slim
    export QCR_BENCH_RUNS_DIR=$PWD/slim/runs
    bench/aacr/final/score.sh

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
                        and candidates.json (the judge's step-2 extractions)
    runs/<run>.qodo*/scores.json, scores.md, judgements.jsonl (vendor comment
                        bodies replaced by a hash + link; the scorer reads only
                        their file and lines), judge/JUDGE.txt
    FILES.sha256                                sha256, size and path of every file

compare.py reads `bench_cost_usd` when a case has no `pi-events.jsonl`.
SWE-PRBench run data is in the archive only.

Licence: Apache-2.0, as the run archive (its README carries the AACR notice,
the modified-work statement and the citations).
"""


# ---------------------------------------------------------------- re-grep

REGREP = {
    "the owner": rb"the owner", "owner_legacy (any case)": rb"(?i:<owner>)", "example-review": rb"(?i:example-review)",
    "quickreviewd": rb"quickreviewd", "home directory": HOME_RX, "src": rb"src",
    "companion-pihome": rb"companion-pihome", "claude.env path": rb"[./\w-]*claude\.env",
    "sk- (substring)": rb"sk-", "ghp_ (substring)": rb"ghp_", "ghs_ (substring)": rb"ghs_", "gho_ (substring)": rb"gho_",
    "sk- key-shaped": rb"(?<![A-Za-z0-9])sk-(?:ant-|proj-)?[A-Za-z0-9_\-]{20,}",
    "gh?_ token-shaped": rb"(?<![A-Za-z0-9])gh[pousr]_[A-Za-z0-9]{36}(?![A-Za-z0-9])",
    "Fernet blob (gAAAAA, 100+)": rb"gAAAAA[A-Za-z0-9_\-=]{100,}",
    "home directory (dashed path)": HOME_DASHED_RX.lstrip(b"\\-"), "mhale": rb"(?i:mhale)", "issue-tracker": rb"issue-tracker",
    **{f"host {h}": re.escape(h.strip().encode()) for h in SCRUB_HOSTS},
    "your-dev-project": rb"your-dev-project", "quickchat (any case)": rb"(?i:quickchat)",
}


# one PCRE pass over the decompressed stream (tar headers included, so member
# names are searched too); every match is classified afterwards by REGREP
REGREP_SCAN = (rb"(?<![A-Za-z0-9])sk-(?:ant-|proj-)?[A-Za-z0-9_\-]{20,}|(?<![A-Za-z0-9])gh[pousr]_[A-Za-z0-9]{36}(?![A-Za-z0-9])|gAAAAA[A-Za-z0-9_\-=]{100,}"
               rb"|(?i:<owner>)(?:-review)?|quickreviewd|" + HOME_RX + rb"|src|companion-pihome|[./\w-]*claude\.env"
               rb"|" + HOME_DASHED_RX.lstrip(b"\\-") + rb"|(?i:mhale)|issue-tracker"
               + b"".join(b"|" + re.escape(h.strip().encode()) for h in SCRUB_HOSTS) + rb"|your-dev-project|(?i:quickchat)|sk-|gh[psor]_")


def regrep_stream(cmd: list[str]) -> tuple[collections.Counter, list]:
    """Counts of every REGREP class over one decompressed stream, with
    samples (and their tar member) for the credential-shaped classes."""
    rx = {k: re.compile(v) for k, v in REGREP.items()}
    z = subprocess.Popen(cmd, stdout=subprocess.PIPE)
    g = subprocess.Popen(["grep", "-aoP", REGREP_SCAN.decode()], stdin=z.stdout, stdout=subprocess.PIPE)
    z.stdout.close()
    c, hits = collections.Counter(), []
    for line in g.stdout:
        m = line.rstrip(b"\n")
        for k, r in rx.items():
            n = len(r.findall(m))
            if n:
                c[k] += n
                if k in ("sk- key-shaped", "gh?_ token-shaped", "Fernet blob (gAAAAA, 100+)") and len(hits) < 20:
                    hits.append((k, m[:24].decode(errors="replace") + "..."))
    grc, zrc = g.wait(), z.wait()
    if zrc != 0 or grc not in (0, 1):
        # grep exits 1 for "no match"; anything else, or a decompressor
        # failure, means the stream was not scanned whole.
        raise SystemExit(f"regrep failed for {cmd[-1]}: {cmd[0]} exit {zrc}, grep exit {grc}")
    return c, hits


def cmd_regrep(a):
    out = Path(a.out)
    total = collections.Counter()
    report, samples = {}, {}
    for vol in sorted(out.glob("*.tar.zst")):
        c, hits = regrep_stream(["zstd", "-dc", "--long=27", "-q", str(vol)])
        report[vol.name] = dict(c)
        if hits:
            samples[vol.name] = hits
        total.update(c)
        print(vol.name, dict(c), flush=True)
    print("TOTAL", dict(total))
    (out / "regrep.json").write_text(json.dumps({"volumes": report, "total": dict(total), "samples": samples}, indent=1) + "\n")


def main():
    ap = argparse.ArgumentParser(description=__doc__.split("\n")[0])
    sub = ap.add_subparsers(dest="cmd", required=True)
    for name in ("plan", "archive", "slim", "regrep", "readme"):
        s = sub.add_parser(name)
        if name not in ("regrep", "readme"):
            s.add_argument("--src", default=os.environ.get("QCR_BENCH_ROOT"), required=os.environ.get("QCR_BENCH_ROOT") is None)
        if name != "plan":
            s.add_argument("--out", required=True)
        if name in ("archive", "slim"):
            s.add_argument("--level", type=int, default=19)
            s.add_argument("--cap", type=int, default=int(1.9 * GIB))
            s.add_argument("--threads", type=int, default=4)
        if name == "archive":
            s.add_argument("--groups", default="", help="comma-separated groups to build (default: all); one per invocation keeps a pause cheap")
            s.add_argument("--rebuild", action="store_true", help="rebuild groups the manifest already records")
            s.add_argument("--jobs", type=int, default=3)
    a = ap.parse_args()
    {"plan": cmd_plan, "archive": cmd_archive, "slim": cmd_slim, "regrep": cmd_regrep,
     "readme": lambda a: write_readme(Path(a.out))}[a.cmd](a)


if __name__ == "__main__":
    main()
