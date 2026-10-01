"""Commit-graph facts the external-benchmark set builders need: the VERIFIED
merge-base of a PR's base and head, and the tree ids of commits.

Read from a local bare cache with full history when it holds both commits
(bench/aacr/EXTERNAL-BENCHMARKS.md, "Caches"), else from the public repo,
anonymously, as a COMMITS-ONLY partial fetch (`--filter=tree:0`, shallow,
deepened until the merge-base is verified against the shallow boundary — the
same rule as src/bench/prefetch.ts mergeBase). These repos are the builder's
own scratch; no reviewer ever sees them.

Also the synthetic-commit id of src/bench/aacr.ts leakproofCommitText, computed
by hand (sha1 over "commit <len>\\0<text>"), so a set names commits that the
prefetch then creates and verifies.
"""
from __future__ import annotations

import hashlib
import os
import subprocess
from pathlib import Path

GIT_ENV = {
    **os.environ,
    "GIT_TERMINAL_PROMPT": "0",
    "GIT_CONFIG_NOSYSTEM": "1",
    "GIT_CONFIG_GLOBAL": "/dev/null",
}


def git(repo: Path, *args: str, check: bool = True) -> subprocess.CompletedProcess:
    r = subprocess.run(["git", "-C", str(repo), *args], capture_output=True, text=True, env=GIT_ENV)
    if check and r.returncode != 0:
        raise RuntimeError(f"git {' '.join(args)} in {repo}: {r.stderr.strip()[:400]}")
    return r


def has_commit(repo: Path, sha: str) -> bool:
    return repo.is_dir() and git(repo, "cat-file", "-e", f"{sha}^{{commit}}", check=False).returncode == 0


def verified_merge_base(repo: Path, base: str, head: str) -> str | None:
    r = git(repo, "merge-base", base, head, check=False)
    mb = r.stdout.strip()
    if r.returncode != 0 or len(mb) != 40:
        return None
    shallow_file = repo / "shallow"
    if not shallow_file.exists():
        return mb
    shallow = {l.strip() for l in shallow_file.read_text().splitlines() if l.strip()}
    if not shallow:
        return mb
    above = git(repo, "rev-list", base, head, f"^{mb}", check=False)
    if above.returncode != 0:
        return None
    return None if any(l.strip() in shallow for l in above.stdout.splitlines()) else mb


def tree_of(repo: Path, commit: str) -> str:
    return git(repo, "rev-parse", f"{commit}^{{tree}}").stdout.strip()


def resolve(
    fetch_repo: str,
    base: str,
    head: str,
    cache: Path | None,
    scratch: Path,
    log=print,
) -> dict:
    """{merge_base, base_tree (of the merge-base), head_tree, source} for one PR."""
    if cache is not None and has_commit(cache, base) and has_commit(cache, head):
        mb = verified_merge_base(cache, base, head)
        if mb:
            return {"merge_base": mb, "base_tree": tree_of(cache, mb), "head_tree": tree_of(cache, head),
                    "source": "cache"}
    repo = scratch / (fetch_repo.replace("/", "__") + ".git")
    if not repo.exists():
        repo.parent.mkdir(parents=True, exist_ok=True)
        subprocess.run(["git", "init", "--quiet", "--bare", str(repo)], check=True, env=GIT_ENV)
    url = f"https://github.com/{fetch_repo}.git"
    depth, step, limit = 50, 200, 5000
    git(repo, "fetch", "--quiet", "--no-tags", "--filter=tree:0", f"--depth={depth}", url, base, head)
    mb = verified_merge_base(repo, base, head)
    while mb is None:
        if depth >= limit:
            raise RuntimeError(f"{fetch_repo}: no merge-base of {base[:10]}..{head[:10]} within depth {limit}")
        depth += step
        log(f"  {fetch_repo}: deepening to {depth}")
        git(repo, "fetch", "--quiet", "--no-tags", "--filter=tree:0", f"--deepen={step}", url, base, head)
        mb = verified_merge_base(repo, base, head)
    return {"merge_base": mb, "base_tree": tree_of(repo, mb), "head_tree": tree_of(repo, head),
            "source": "network"}


def diff_lines(repo: Path, mb: str, head: str) -> int | None:
    """Changed lines mb..head, or None when the repo lacks the blobs (a
    commits-only scratch repo)."""
    r = git(repo, "diff", "--shortstat", mb, head, check=False)
    if r.returncode != 0:
        return None
    import re
    n = lambda pat: int(m.group(1)) if (m := re.search(pat, r.stdout)) else 0  # noqa: E731
    return n(r"(\d+) insertions?") + n(r"(\d+) deletions?")


# ---- src/bench/aacr.ts leakproofCommitText, byte for byte ---------------------

WHO = "Benchmark replay <replay@bench.invalid> 0 +0000"


def leakproof_commit_text(tree: str, parent: str | None) -> str:
    lines = [f"tree {tree}"]
    if parent:
        lines.append(f"parent {parent}")
    lines += [f"author {WHO}", f"committer {WHO}", ""]
    lines.append(
        "Pull request head (history and messages withheld by the benchmark)"
        if parent
        else "Pull request merge-base (history withheld by the benchmark)"
    )
    lines.append("")
    return "\n".join(lines)


def commit_id(text: str) -> str:
    raw = text.encode()
    return hashlib.sha1(b"commit %d\0" % len(raw) + raw).hexdigest()


def leakproof_ids(base_tree: str, head_tree: str) -> tuple[str, str]:
    base = commit_id(leakproof_commit_text(base_tree, None))
    head = commit_id(leakproof_commit_text(head_tree, base))
    return base, head


def sha256_file(p: Path) -> str:
    h = hashlib.sha256()
    with open(p, "rb") as f:
        for chunk in iter(lambda: f.read(1 << 20), b""):
            h.update(chunk)
    return h.hexdigest()
