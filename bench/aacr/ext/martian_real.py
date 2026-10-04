#!/usr/bin/env python3
"""Martian's goldens by the audit's buckets: real goldens found, the share of
credits on not-real goldens, and the "every blocking golden found" counts —
the MARTIAN-CRITIQUE.md / EXTERNAL-BENCHMARKS.md §6 columns — for every tool
in one Martian work dir.

    python3 bench/aacr/ext/martian_real.py WORK.martian [WORK.martian ...]

No model call. Inputs: each work dir's results/<judge>/evaluations.json (its
true positives, by golden text) and published-benchmark_data.json (the golden
lists), and charts/martian-data.json `goldens` — the audit's bucket for every
one of the 173 goldens (ext/martian-tuning/GOLDEN-AUDIT-FULL.md plus the 9 of
GOLDEN-AUDIT.md), in the order of the PR urls sorted, then each PR's golden
list. That order is checked against the published severities before use.
"""
from __future__ import annotations

import json
import sys
from pathlib import Path

AACR = Path(__file__).resolve().parent.parent
CH = {"Critical", "High"}


def buckets(published: dict) -> dict[tuple[str, int], dict]:
    labels = json.loads((AACR / "charts" / "martian-data.json").read_text())["goldens"]
    order = [(u, i, g) for u in sorted(published) for i, g in enumerate(published[u]["golden_comments"])]
    if len(order) != len(labels) or any(g.get("severity") != lab["sev"] for (_, _, g), lab in zip(order, labels)):
        sys.exit("martian-data.json goldens do not line up with the published golden lists")
    return {(u, i): {"text": g["comment"], "sev": g.get("severity"), "bucket": lab["bucket"]}
            for (u, i, g), lab in zip(order, labels)}


def found(evals: dict, tool: str, url: str, goldens: dict) -> set[int]:
    """Indices of the PR's goldens the judge matched for this tool."""
    texts = {v["text"]: i for (u, i), v in goldens.items() if u == url}
    out = set()
    for tp in (evals.get(url, {}).get(tool) or {}).get("true_positives") or []:
        i = texts.get(tp.get("golden_comment"))
        if i is None:
            sys.exit(f"{url}: a true positive of {tool} names no golden of the PR")
        out.add(i)
    return out


def report(work: Path) -> list[dict]:
    published = json.loads((work / "published-benchmark_data.json").read_text())
    goldens = buckets(published)
    (evals_file,) = list((work / "results").glob("*/evaluations.json"))
    evals = json.loads(evals_file.read_text())
    urls = sorted(evals)
    tools = sorted({t for u in urls for t in evals[u]})
    n_real = sum(1 for (u, _), v in goldens.items() if u in evals and v["bucket"] == "real")
    rows = []
    for t in tools:
        cnt = {"real": 0, "notreal": 0, "disputed": 0}
        all_ch = all_real_ch = all_real = 0
        prs_ch = prs_real_ch = prs_real = 0
        for u in urls:
            mine = {i: v for (uu, i), v in goldens.items() if uu == u}
            hit = found(evals, t, u, goldens)
            for i in hit:
                cnt[mine[i]["bucket"]] += 1
            for want, flag in (
                ({i for i, v in mine.items() if v["sev"] in CH}, "ch"),
                ({i for i, v in mine.items() if v["sev"] in CH and v["bucket"] == "real"}, "real_ch"),
                ({i for i, v in mine.items() if v["bucket"] == "real"}, "real"),
            ):
                if not want:
                    continue
                ok = want <= hit
                if flag == "ch":
                    prs_ch += 1; all_ch += ok
                elif flag == "real_ch":
                    prs_real_ch += 1; all_real_ch += ok
                else:
                    prs_real += 1; all_real += ok
        credits = sum(cnt.values())
        rows.append({"tool": t, "real_found": cnt["real"], "real_total": n_real,
                     "notreal_credited": cnt["notreal"], "disputed_credited": cnt["disputed"],
                     "share_notreal": cnt["notreal"] / credits if credits else 0.0,
                     "all_ch_found": all_ch, "prs_ch": prs_ch, "all_real_ch_found": all_real_ch,
                     "prs_real_ch": prs_real_ch, "all_real_found": all_real, "prs_real": prs_real})
    return rows


def main() -> None:
    if len(sys.argv) < 2:
        sys.exit(__doc__)
    print("| work dir | tool | real goldens found | credits on not-real | all C/H found | all real C/H found | all real found |")
    print("|---|---|---|---|---|---|---|")
    for w in sys.argv[1:]:
        for r in report(Path(w)):
            print(f"| {Path(w).name} | {r['tool']} | {r['real_found']} of {r['real_total']} "
                  f"({100 * r['real_found'] / r['real_total']:.1f}%) | {100 * r['share_notreal']:.0f}% "
                  f"| {r['all_ch_found']} of {r['prs_ch']} | {r['all_real_ch_found']} of {r['prs_real_ch']} "
                  f"| {r['all_real_found']} of {r['prs_real']} |")


if __name__ == "__main__":
    main()
