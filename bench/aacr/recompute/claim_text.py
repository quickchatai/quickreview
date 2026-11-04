"""The text side of the claims manifest (bench/aacr/claims.json): which numbers a
published line carries, where a claim's anchor is, and whether the manifest
accounts for every number of a file. Standard library only, no data needed;
bench/aacr/verify_claims.py --lint and tests/bench-claims.test.ts run it.

A NUMBER TOKEN is a run of digits (with `,` thousands groups and `.` decimals),
an optional leading sign (`+`, `-`, `−`) and an optional trailing `%` or unit
(`k`, `M`, `x`), that is not glued to a word: `S40`, `gpt-6.1`, `e32f0cf`,
`#42`, `v1.0` and `31B` carry none, while "21k" and "0.86x" are tokens. Before tokenizing, a line loses what can never be a claim:
  - URLs, and the `src`, `srcset`, `href`, `width` and `height` attributes;
  - in LaTeX, comments, `\\ref`/`\\label`/`\\cite`-style arguments, and math
    and thousands markup (`$`, `\\%`, `{,}`) is normalised;
  - ISO dates and clock times, and every match of the manifest's
    `version_patterns` (model and tool versions such as "Opus 5.5").
A token is written as printed, `−` read as `-`, `\\%` as `%`: "97%", "+8.3",
"3,093", "0.07".

A claim's ANCHOR is a substring of exactly one line of its file; the claim's
`value` must be a token of that line. Accounting is a multiset: a line that
prints "1.8" twice needs two entries (claims or not-claims) for it.
"""
from __future__ import annotations

import re
from collections import Counter
from typing import Dict, Iterable, List, Optional, Sequence, Tuple

NUM = re.compile(r"(?<![\w.#@^\\])(?<![A-Za-z_]-)(?<![A-Za-z_]-\d-)"
                 r"[-+−]?\d+(?:,\d{3})*(?:\.\d+)?(?:%|k|M|x)?(?![\w])")
_URL = re.compile(r"https?://[^\s)\]}>\"']+")
_ATTR = re.compile(r"\b(?:src|srcset|href|width|height)=\"[^\"]*\"")
_DATE = re.compile(r"\b\d{4}-\d{2}-\d{2}(?:[T ]\d{1,2}:\d{2}(?::\d{2})?Z?)?\b")
_TIME = re.compile(r"(?<![\d.])\d{1,2}:\d{2}(?:[–-]\d{1,2}:\d{2})?(?![\d])")
_TEX_COMMENT = re.compile(r"(?<!\\)%.*$")
_TEX_ARG = re.compile(r"\\(?:ref|label|cite[a-z]*|eqref|autoref|cref|Cref|url|href|includegraphics|chart|input|"
                      r"hyperref|vspace|hspace|resizebox|footnotemark|footnotetext\[|setlength|arraystretch|"
                      r"multicolumn|multirow|cmidrule|addlinespace|rule|scalebox)\*?(?:\[[^\]]*\])?(?:\([^)]*\))?"
                      r"(?:\{[^{}]*\})?")


def normalise(tok: str) -> str:
    return tok.replace("−", "-")


def clean(line: str, tex: bool, version_patterns: Sequence[str] = ()) -> str:
    """The part of a line whose numbers can be claims."""
    if tex:
        line = _TEX_COMMENT.sub("", line)
        line = line.replace("\\%", "%").replace("{,}", ",").replace("\\,", " ").replace("\\$", " ")
        line = _TEX_ARG.sub(" ", line)
        line = line.replace("$", " ")
    line = _URL.sub(" ", line)
    line = _ATTR.sub(" ", line)
    line = _DATE.sub(" ", line)
    line = _TIME.sub(" ", line)
    for p in version_patterns:
        line = re.sub(p, " ", line)
    return line


def tokens(line: str, tex: bool = False, version_patterns: Sequence[str] = ()) -> List[str]:
    s = clean(line, tex, version_patterns)
    out = []
    for m in NUM.finditer(s):
        t = m.group(0)
        # a range's dash ("85--87", "3-5") is not a minus sign
        if t[0] in "-−" and m.start() > 0 and (s[m.start() - 1].isdigit() or s[m.start() - 1] in "-–"):
            t = t[1:]
        out.append(normalise(t))
    return out


def is_tex(path: str) -> bool:
    return path.endswith(".tex")


def locate(lines: Sequence[str], anchor: str, nth: Optional[Sequence[int]] = None) -> Tuple[Optional[int], str]:
    """(0-based line index, "") when `anchor` is in exactly one line, else (None, why).
    `nth` = [k, n] picks the k-th (1-based) of exactly n identical lines, for a line the
    file repeats (a shell snippet shown twice); a line added or removed with that text
    is then caught too."""
    hits = [i for i, ln in enumerate(lines) if anchor in ln]
    if nth is not None:
        k, n = nth
        if len(hits) == n and 1 <= k <= n:
            return hits[k - 1], ""
        return None, f"anchor expected on exactly {n} lines (taking #{k}), found on {len(hits)}"
    if len(hits) == 1:
        return hits[0], ""
    if not hits:
        return None, "anchor not found"
    return None, f"anchor on {len(hits)} lines ({', '.join(str(i + 1) for i in hits[:5])})"


def account(path: str, text: str, claims: Iterable[dict], not_claims: Iterable[dict],
            version_patterns: Sequence[str] = ()) -> dict:
    """Match every claim and not-claim of one file to its line and tokens.

    Returns {"errors": [...], "lines": {claim id -> 1-based line}, "leftover": {1-based line -> [tokens]},
    "tokens": total tokens in the file}. An error is a manifest fault: an anchor not found
    or on several lines, or a value (or not-claim token) the anchored line does not carry
    (or carries fewer times than the manifest spends it)."""
    lines = text.splitlines()
    tex = is_tex(path)
    left: Dict[int, Counter] = {}
    total = 0
    for i, ln in enumerate(lines):
        t = tokens(ln, tex, version_patterns)
        if t:
            left[i] = Counter(t)
            total += len(t)
    errors: List[str] = []
    where: Dict[str, int] = {}

    def spend(i: int, tok: str, who: str) -> None:
        c = left.get(i)
        if not c or c[tok] <= 0:
            have = sorted((left.get(i) or Counter()).elements())
            errors.append(f"{path}:{i + 1}: {who}: value {tok!r} not on the anchored line "
                          f"(or already spent); its unaccounted tokens: {have}")
            return
        c[tok] -= 1

    for c in claims:
        i, why = locate(lines, c["anchor"], c.get("nth"))
        if i is None:
            errors.append(f"{path}: claim {c.get('id')}: {why}: {c['anchor']!r}")
            continue
        where[c["id"]] = i + 1
        spend(i, normalise(c["value"]), f"claim {c.get('id')}")
    for n in not_claims:
        i, why = locate(lines, n["anchor"], n.get("nth"))
        if i is None:
            errors.append(f"{path}: not-claim ({n.get('why')}): {why}: {n['anchor']!r}")
            continue
        for tok in n.get("tokens") or []:
            spend(i, normalise(tok), f"not-claim ({n.get('why')})")
    leftover = {i + 1: sorted(c.elements()) for i, c in left.items() if sum(c.values()) > 0}
    return {"errors": errors, "lines": where, "leftover": leftover, "tokens": total}


def lint(manifest: dict, read_file) -> dict:
    """Every file the manifest lists: errors, and the numbers it does not account for.
    `read_file(path)` returns the file's text (None when absent). A file whose
    `lint` is "complete" must account for every token; one whose `lint` is
    "report" only reports what is left."""
    vp = manifest.get("version_patterns") or []
    out = {"errors": [], "files": {}}
    by_file: Dict[str, Tuple[list, list]] = {f: ([], []) for f in manifest.get("files", {})}
    for c in manifest.get("claims", []):
        by_file.setdefault(c["file"], ([], []))[0].append(c)
    for n in manifest.get("not_claims", []):
        by_file.setdefault(n["file"], ([], []))[1].append(n)
    seen = set()
    for c in manifest.get("claims", []):
        if c["id"] in seen:
            out["errors"].append(f"duplicate claim id {c['id']}")
        seen.add(c["id"])
    for path, (cl, nc) in sorted(by_file.items()):
        spec = (manifest.get("files") or {}).get(path)
        if spec is None:
            out["errors"].append(f"{path}: has entries but is not in `files`")
            continue
        text = read_file(path)
        if text is None:
            out["errors"].append(f"{path}: file not found")
            continue
        r = account(path, text, cl, nc, vp)
        out["errors"] += r["errors"]
        left = sum(len(v) for v in r["leftover"].values())
        out["files"][path] = {"lint": spec.get("lint"), "tokens": r["tokens"], "claims": len(cl),
                              "not_claims": sum(len(n.get("tokens") or []) for n in nc),
                              "unaccounted": left, "leftover": r["leftover"], "lines": r["lines"]}
        if spec.get("lint") == "complete" and left:
            sample = "; ".join(f"line {k}: {v}" for k, v in list(r["leftover"].items())[:8])
            out["errors"].append(f"{path}: {left} number(s) neither a claim nor a listed not-claim ({sample})")
    return out
