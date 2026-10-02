#!/usr/bin/env python3
"""Posting-policy variants of stored QuickReview runs, for tuning on Martian.

No new review is made. The variant is what QuickReview would have POSTED under
a different posting policy: the same findings, filtered. Each inline comment is
matched to its line in review.md's finding lists ("- `path:line` — title
_(P1/1.0, lens, lens, ...)_"), which carries its severity, confidence and the
lenses that independently raised it.

  martian_variant.py --src RUN [--src RUN ...] --dst NAME [policy flags]

Policy flags (all optional; the default keeps everything):
  --tags blocker,question,nit,check      tags to post ("check" = [check this])
  --max-sev P2                            post only P0..P2
  --min-lenses 2                          post only findings >=2 lenses raised
  --min-conf 0.95                         post only findings at this confidence
  --max-per-pr 5                          keep the top N per PR (severity, then
                                          lenses, then confidence; ties by
                                          posting order)
  --body keep|verdict|none                keep the filtered body, only its verdict
                                          line, or post none
  --one-per-finding                       drop the extra inline comments posted
                                          at a finding's other sites
  --style full|title|title+1              comment text as posted, title only, or
                                          title plus first sentence
  --rule EXPR                             extra keep condition (tag, sev, conf,
                                          lenses, secondary)

Writes $QCR_BENCH_RUNS_DIR/NAME/ (cases copied, comments.json and review.md
rewritten) and NAME/VARIANT.json (the policy and per-case counts).
"""
from __future__ import annotations

import argparse
import json
import os
import re
import shutil
from pathlib import Path

BULLET = re.compile(r"^- `(?P<path>[^`:]+):(?P<line>\d+)` — (?P<title>.*?) _\((?P<meta>[^)]*)\)_\s*$")
SECTION = re.compile(r"^### (.+)$")
TAG = re.compile(r"^\s*\[(blocker|question|nit|check this)\]")
SEV = {"P0": 0, "P1": 1, "P2": 2, "P3": 3}
DEFAULT_SEV = {"blocker": 1, "question": 2, "check": 2, "nit": 3}


def parse_meta(meta: str) -> dict:
    head, _, rest = meta.partition(",")
    m = re.match(r"\s*(P\d)/([\d.]+)", head)
    rest = rest.split(";")[0]
    words = {"two": 2, "three": 3, "four": 4, "five": 5, "six": 6, "seven": 7, "eight": 8, "nine": 9, "ten": 10}
    m2 = re.search(r"and (\w+) corroborating", rest)
    if m2:
        n = 1 + words.get(m2.group(1), int(m2.group(1)) if m2.group(1).isdigit() else 1)
    elif "corroborating" in rest:
        n = 2
    else:
        n = len([x for x in re.split(r"[,/]", rest) if x.strip()])
    return {"sev": SEV.get(m.group(1), 3) if m else None,
            "conf": float(m.group(2)) if m else None,
            "lenses": max(1, n)}


REF = re.compile(r"`([^`:]+):(\d+)`")


def body_index(body: str) -> tuple[dict, list]:
    """(primary sites -> meta, [(path fragment, line, meta)] other sites the
    bullet names: QuickReview also posts those as separate inline comments)."""
    idx, others = {}, []
    for ln in body.splitlines():
        m = BULLET.match(ln)
        if m:
            meta = parse_meta(m.group("meta"))
            idx.setdefault((m.group("path"), int(m.group("line"))), meta)
            for frag, line in REF.findall(m.group("title")):
                others.append((frag, int(line), meta))
    return idx, others


def lookup(idx: dict, others: list, path: str, line: int) -> tuple[dict, bool]:
    if (path, line) in idx:
        return idx[(path, line)], False
    for frag, ln, meta in others:
        if ln == line and (path == frag or path.endswith("/" + frag)):
            return meta, True
    return {}, False


def restyle(body: str, style: str) -> str:
    if style == "full":
        return body
    paras = [p.strip() for p in body.split("\n\n") if p.strip()]
    title = paras[0] if paras else body
    if style == "title" or len(paras) < 2:
        return title
    first = re.split(r"(?<=[.!?])\s", paras[1], maxsplit=1)[0]
    return f"{title}\n\n{first}"


def tag_of(c: dict) -> str:
    m = TAG.match(c.get("body") or "")
    t = m.group(1) if m else "blocker"
    return "check" if t == "check this" else t


def main() -> None:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--src", action="append", required=True)
    ap.add_argument("--dst", required=True)
    ap.add_argument("--tags", default="blocker,question,nit,check")
    ap.add_argument("--max-sev", default="P3")
    ap.add_argument("--min-lenses", type=int, default=1)
    ap.add_argument("--min-conf", type=float, default=0.0)
    ap.add_argument("--max-per-pr", type=int, default=0)
    ap.add_argument("--body", choices=["keep", "verdict", "none"], default="keep")
    ap.add_argument("--one-per-finding", action="store_true")
    ap.add_argument("--style", choices=["full", "title", "title+1"], default="full",
                    help="comment text: as posted, its title line only, or title plus first sentence")
    ap.add_argument("--rule", default="", help="extra keep condition, a Python expression over "
                    "tag, sev (0-3), conf, lenses, secondary — e.g. \"conf>=0.99 and (sev<=1 or lenses>=2)\"")
    a = ap.parse_args()
    root = Path(os.environ["QCR_BENCH_RUNS_DIR"])
    dst = root / a.dst
    if dst.exists():
        raise SystemExit(f"{dst} exists — variants are never overwritten")
    tags = set(a.tags.split(","))
    max_sev = SEV[a.max_sev]
    (dst / "cases").mkdir(parents=True)
    report = {"policy": vars(a), "cases": {}}
    for src in a.src:
        for case in sorted((root / src / "cases").iterdir()):
            out = dst / "cases" / case.name
            shutil.copytree(case, out, symlinks=True)
            cj, rm = out / "comments.json", out / "review.md"
            comments = json.loads(cj.read_text()) if cj.exists() else []
            body = rm.read_text() if rm.exists() else ""
            idx, others = body_index(body)
            scored = []
            for i, c in enumerate(comments):
                t = tag_of(c)
                meta, secondary = lookup(idx, others, c.get("path"), c.get("line"))
                sev = meta.get("sev") if meta.get("sev") is not None else DEFAULT_SEV[t]
                conf = meta.get("conf") if meta.get("conf") is not None else 1.0
                lenses = meta.get("lenses", 1)
                ok = (t in tags and sev <= max_sev and lenses >= a.min_lenses and conf >= a.min_conf
                      and not (a.one_per_finding and secondary)
                      and (not a.rule or eval(a.rule.replace("_", " "), {}, {"tag": t, "sev": sev, "conf": conf,
                                                          "lenses": lenses, "secondary": secondary})))
                scored.append((ok, sev, -lenses, -conf, i, c))
            keep = [x for x in scored if x[0]]
            if a.max_per_pr:
                keep = sorted(keep, key=lambda x: x[1:5])[: a.max_per_pr]
            kept_ids = {x[4] for x in keep}
            new = [dict(c, body=restyle(c.get("body") or "", a.style)) for i, c in enumerate(comments) if i in kept_ids]
            if cj.exists():
                cj.write_text(json.dumps(new, indent=1))
            kept_keys = {(c.get("path"), c.get("line")) for c in new}
            if rm.exists():
                if a.body == "none":
                    rm.write_text("")
                elif a.body == "verdict":
                    v = [ln for ln in body.splitlines() if ln.startswith("**Verdict:")]
                    rm.write_text((v[0].split(" — ")[0] if v else "") + "\n")
                else:
                    lines, sect = [], []
                    for ln in body.splitlines():
                        m = BULLET.match(ln)
                        if m and (m.group("path"), int(m.group("line"))) not in kept_keys:
                            continue
                        lines.append(ln)
                    # drop headed sections left empty
                    txt = "\n".join(lines)
                    txt = re.sub(r"(?m)^### [^\n]*\n(?:\s*\n)*(?=### |\Z)", "", txt)
                    rm.write_text(txt.rstrip() + "\n")
            report["cases"][case.name] = {"comments": len(comments), "kept": len(new),
                                          "secondary": sum(1 for c in comments if lookup(idx, others, c.get("path"), c.get("line"))[1])}
    tot = sum(v["comments"] for v in report["cases"].values())
    kept = sum(v["kept"] for v in report["cases"].values())
    report["totals"] = {"comments": tot, "kept": kept}
    (dst / "VARIANT.json").write_text(json.dumps(report, indent=1))
    print(f"{a.dst}: kept {kept}/{tot}")


if __name__ == "__main__":
    main()
