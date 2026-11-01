#!/usr/bin/env python3
"""QuickReview on Martian by its own severity (benchmark.tex tab:martiantiers and the paragraph
"Where QuickReview is strong: its own severity"), rebuilt from the release.

    uv run --no-project --with pyarrow python3 bench/aacr/relabel/martian_tiers.py \\
        --archive <release>/archive --data <hf-dataset> --work <scratch> --dry-run
    uv run --no-project --with anthropic==1.15.0 --with pyarrow python3 bench/aacr/relabel/martian_tiers.py \\
        --archive <release>/archive --data <hf-dataset> --work <scratch> --run
    uv run --no-project --with pyarrow python3 bench/aacr/relabel/martian_tiers.py \\
        --archive <release>/archive --data <hf-dataset> --work <scratch> --compute [--json OUT]

What the table needs, and where each part comes from:
  candidate  Martian's step 2 extracts QuickReview's posted review (every inline comment and the
             review body, joined) into issue statements (`results/gpt-6.1-sol/candidates.json` of a
             scoring dir). Its output carries no link back to the comment it came from.
  tier       the comment's own severity: its `[tag]` and its `_Pn · confidence ..._` footer (a body
             bullet's `(Pn/...)` under its `### Blockers|Nits|Questions` heading). nit = a `[nit]`
             comment; otherwise P0-P1, P2 or P3 by the footer.
  class      left block: the blind tune20 classification the archive's analysis volume ships
             (fair/secret.json, fair/out/*.json), rolled up as martian_ext.py does; a candidate is
             "real" when its class is GOLDEN (a golden of any audited quality: the table's note) or
             REAL, "minor" when MINOR, "dup" when the rollup makes it a DUP, "wrong" when WRONG.
  credit     right block: the stored Martian judgements (`evaluations.json`: each credited golden's
             matched candidate, each false positive), recounted for the candidates whose comment is
             in the subset, under Martian's Core profile (goldens of category style or speculative
             left out; martian_goldens.category).
The candidate -> comment link is the one missing fact. It is computed by word overlap between the
statement and each comment (words of 4+ characters; score = shared / the statement's words). A
model label is asked for only when overlap cannot settle the TIER: the best comment is the review
summary, or its score is below FLOOR, or a comment of a different tier scores within MARGIN of it.
The labels (martian_tiers.labels.jsonl, shipped in the archive's analysis volume under
analysis/relabel/ with the prompt; `--compute` reads that copy and checks every row's model and
prompt sha256) override the overlap for exactly those candidates; a candidate a label answers
"none" for is counted as "unmapped".

Runs: the left block is the blind classification's run, tune20 as posted (mv-r1-asposted); the
right block is the 50-PR "everything" row claims.json already checks, ext-default3-martian-tune20 +
ext-r4-martian-test30.
"""
from __future__ import annotations

import argparse
import collections
import json
import re
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
import relabel_common as RC  # noqa: E402
from archive import open_archive, read_json  # noqa: E402
from tables import load_table  # noqa: E402

NAME = "martian_tiers"
PROMPT = RC.HERE / f"{NAME}.prompt.md"
LABELS = RC.HERE / f"{NAME}.labels.jsonl"
VOLUMES = ["analysis", "martian-posting-variants", "martian-tuning-rounds"]
JUDGE = "gpt-6.1-sol"
TOOL = "quickreview"
LEFT = "mv-r1-asposted.martian"
RIGHT = ("ext-default3-martian-tune20.martian", "ext-r4-martian-test30.martian")
CORE_EXCLUDED = frozenset({"style", "speculative"})
TIERS = ("P0-P1", "P2", "P3", "nit")
SUBSETS = ("P0-P1 only", "blockers only", "P0-P2", "everything")
MARGIN = 0.15
FLOOR = 0.2
OUT_TOKENS = 2500  # per request: a short JSON answer plus adaptive thinking at effort high

SCHEMA = {"type": "object", "additionalProperties": False, "required": ["comment", "confidence", "why"],
          "properties": {"comment": {"type": "string"}, "confidence": {"type": "string", "enum": ["high", "medium", "low"]},
                         "why": {"type": "string"}}}

FOOT = re.compile(r"\n*_(P\d)\s*·[^\n]*_\s*$")
TAG = re.compile(r"^\s*\[([a-z]+)\]\s*")
BULLET = re.compile(r"^-\s+(.*?)\s*_?\((P\d)/[^)]*\)_?\s*$")
FOLDED = "Also on these lines:"
FOLD_TAG = re.compile(r"\[([a-z]+)\]")
FOLD_SEV = re.compile(r"folded \w+: (P\d)")
SECTION = {"blockers": "blocker", "nits": "nit", "questions": "question", "checks": "check"}
WORD = re.compile(r"[a-z_][a-z0-9_]{3,}")


def toks(s: str) -> set:
    return set(WORD.findall((s or "").lower()))


def review_units(review_comments) -> list:
    """The comments of one posted review as Martian saw them: inline comments (c<i>, i = index in
    review_comments), a note folded into one ("Also on these lines: [nit] ...", c<i>f, with the
    folded note's own tag and severity), the body's bullets (b<k>) and the body's summary (s). Each
    with its tag and severity, and its text with the tag and the severity line stripped (what the
    labeller sees)."""
    out = []
    for i, c in enumerate(review_comments):
        body = c.get("body") or ""
        if c.get("path") is not None:
            t, f = TAG.match(body), FOOT.search(body)
            text = FOOT.sub("", TAG.sub("", body, count=1))
            main, _, folded = text.partition(FOLDED)
            where = f"{c['path']}:{c.get('line')}"
            out.append({"id": f"c{i}", "kind": "inline", "tag": t.group(1) if t else None, "sev": f.group(1) if f else None,
                        "text": main.strip(), "where": where, "match": main})
            if folded.strip():  # a lower-severity note folded into this comment: its own tag and severity
                ft, fs = FOLD_TAG.search(folded), re.search(r"\b(P\d)\b", folded) or FOLD_SEV.search(body)
                out.append({"id": f"c{i}f", "kind": "folded", "tag": ft.group(1) if ft else "nit",
                            "sev": fs.group(1) if fs else "P3", "text": FOLD_TAG.sub("", folded).strip(),
                            "where": where, "match": folded})
            continue
        sec, k = None, 0
        for ln in body.splitlines():
            h = re.match(r"^###\s+(\w+)", ln)
            if h:
                sec = SECTION.get(h.group(1).lower(), h.group(1).lower())
                continue
            m = BULLET.match(ln)
            if m and sec:
                out.append({"id": f"b{k}", "kind": "body", "tag": sec, "sev": m.group(2), "text": m.group(1),
                            "where": "review body", "match": ln})
                k += 1
        summary = body.split("###")[0].strip()
        out.append({"id": "s", "kind": "summary", "tag": None, "sev": None, "text": summary, "where": "review body", "match": summary})
    return out


def tier(u: dict) -> str:
    if u is None:
        return "unmapped"
    if u["tag"] == "nit":
        return "nit"
    return {"P0": "P0-P1", "P1": "P0-P1", "P2": "P2", "P3": "P3"}.get(u["sev"] or "", "unknown")


def match(text: str, units: list) -> dict:
    """Word-overlap link of one statement to a comment, and whether it settles the tier."""
    t = toks(text)
    scored = sorted(((len(t & toks(u["match"])) / max(1, len(t)), -j) for j, u in enumerate(units)), reverse=True)
    best_s, best_j = scored[0][0], -scored[0][1]
    best = units[best_j]
    other = [s for s, j in scored[1:] if tier(units[-j]) != tier(best)]
    margin = best_s - (other[0] if other else 0.0)
    unsettled = best["kind"] == "summary" or best_s < FLOOR or margin < MARGIN
    return {"unit": best["id"], "score": round(best_s, 3), "margin": round(margin, 3), "unsettled": unsettled}


class Data:
    def __init__(self, root: Path, data: str):
        self.root = root
        self.cat = {(g["pr_url"], g["golden_index"]): g["category"] for g in load_table(data, "martian_goldens")}
        self.scorings = {}

    def scoring(self, name: str) -> dict:
        """{pr: {"cands": [text], "units": [...], "tps": [(golden_index, cand_index)], "fps": set(cand_index)}}."""
        if name in self.scorings:
            return self.scorings[name]
        res = self.root / "runs" / name / "results"
        bd, cj = read_json(res / "benchmark_data.json"), read_json(res / JUDGE / "candidates.json")
        ev = read_json(res / JUDGE / "evaluations.json")
        out = {}
        for pr in sorted(cj):
            texts = [c["text"] for c in cj[pr].get(TOOL) or []]
            rv = [r for r in bd[pr]["reviews"] if r["tool"] == TOOL]
            e = (ev.get(pr) or {}).get(TOOL) or {}
            gidx = {g["comment"]: i for i, g in enumerate(bd[pr]["golden_comments"])}
            tps = [(gidx[x["golden_comment"]], texts.index(x["matched_candidate"]) if x["matched_candidate"] in texts else None)
                   for x in e.get("true_positives") or []]
            fpt = {x["candidate"] for x in e.get("false_positives") or []}
            out[pr] = {"cands": texts, "units": review_units(rv[0]["review_comments"]) if rv else [],
                       "tps": tps, "fps": {i for i, t in enumerate(texts) if t in fpt},
                       "core_goldens": sum(1 for i, _ in enumerate(bd[pr]["golden_comments"])
                                           if self.cat[(pr, i)] not in CORE_EXCLUDED)}
        self.scorings[name] = out
        return out


def key(scoring: str, pr: str, i: int) -> dict:
    return {"scoring": scoring, "pr_url": pr, "candidate": i}


def links(d: Data, scoring: str, labels: dict) -> dict:
    """{(pr, i): {"unit", "tier", "source"}} for every QuickReview candidate of a scoring dir."""
    out = {}
    for pr, s in d.scoring(scoring).items():
        by = {u["id"]: u for u in s["units"]}
        for i, text in enumerate(s["cands"]):
            m = match(text, s["units"])
            lab = labels.get(json.dumps(key(scoring, pr, i), sort_keys=True))
            if lab is not None:
                uid = lab["comment"] if lab["comment"] in by else None
                out[(pr, i)] = {"unit": uid, "tier": tier(by.get(uid)), "unit_obj": by.get(uid), "source": "label", **m}
            else:
                out[(pr, i)] = {"unit": m["unit"], "tier": tier(by[m["unit"]]), "unit_obj": by[m["unit"]],
                                "source": "label-missing" if m["unsettled"] else "overlap", **m}
    return out


# ---- requests -------------------------------------------------------------------------------

def requests(d: Data, scope: str = "unsettled") -> list:
    """One request per candidate whose tier the overlap cannot settle (scope "unsettled", the
    labels the compute uses), or per candidate (scope "all", a check of the overlap links)."""
    system = RC.load_prompt(PROMPT)
    psha = RC.sha256(system)
    rows = []
    for scoring in (LEFT,) + RIGHT:
        for pr, s in d.scoring(scoring).items():
            for i, text in enumerate(s["cands"]):
                m = match(text, s["units"])
                if scope == "unsettled" and not m["unsettled"]:
                    continue
                listing = "\n\n".join(f"[{u['id']}] ({u['kind']}, {u['where']})\n{u['text']}" for u in s["units"])
                user = f"Issue statement:\n{text}\n\nThe review's comments:\n\n{listing}\n"
                k = key(scoring, pr, i)
                rows.append({"custom_id": RC.custom_id("mt", json.dumps(k, sort_keys=True)), "key": k,
                             "prompt_sha256": psha, "overlap": m, "params": RC.params(system, user, SCHEMA)})
    return rows


# ---- compute --------------------------------------------------------------------------------

def read_labels(path: Path) -> dict:
    if not path.exists():
        return {}
    return {json.dumps(r["key"], sort_keys=True): r for r in RC.read_jsonl(path)}


def left_block(root: Path, d: Data, labels: dict) -> dict:
    sys.path.insert(0, str(RC.AACR / "recompute"))
    import martian_ext  # the blind classification, rolled up (DUP, golden quality)
    e = martian_ext.Ext(root)
    ln = links(d, LEFT, labels)
    rows = {t: collections.Counter() for t in TIERS + ("unknown", "unmapped")}
    for cid, s in e.S.items():
        if s["tool"] != TOOL:
            continue
        t = ln[(s["pr"], s["idx"])]["tier"]
        fin, base = e.FINAL[cid], e.ANN[cid]["class"]
        cls = "dup" if fin == "DUP" else "real" if base in ("GOLDEN", "REAL") else "minor" if base == "MINOR" else "wrong"
        rows[t]["n"] += 1
        rows[t][cls] += 1
    out = {}
    for t, c in rows.items():
        if c["n"] or t in TIERS:
            out[t] = {"n": c["n"], "real": c["real"], "minor": c["minor"], "dup": c["dup"], "wrong": c["wrong"],
                      "real_pct": 100.0 * c["real"] / c["n"] if c["n"] else None}
    return out


def keep(subset: str, link: dict) -> bool:
    u, t = link["unit_obj"], link["tier"]
    if subset == "everything":
        return True
    if subset == "P0-P1 only":
        return t == "P0-P1"
    if subset == "P0-P2":
        return t in ("P0-P1", "P2")
    if subset == "blockers only":
        return bool(u) and u["tag"] == "blocker"
    raise KeyError(subset)


def right_block(d: Data, labels: dict) -> dict:
    tot = {s: collections.Counter() for s in SUBSETS}
    prs = 0
    for scoring in RIGHT:
        ln = links(d, scoring, labels)
        for pr, s in d.scoring(scoring).items():
            prs += 1
            for sub in SUBSETS:
                kept = {i for i in range(len(s["cands"])) if keep(sub, ln[(pr, i)])}
                tot[sub]["candidates"] += len(kept)
                tot[sub]["tp"] += sum(1 for g, i in s["tps"] if i in kept and d.cat[(pr, g)] not in CORE_EXCLUDED)
                tot[sub]["fp"] += len(kept & s["fps"])
                tot[sub]["goldens"] += s["core_goldens"]
    out = {}
    for sub, c in tot.items():
        p = c["tp"] / (c["tp"] + c["fp"]) if c["tp"] + c["fp"] else 0.0
        r = c["tp"] / c["goldens"] if c["goldens"] else 0.0
        out[sub] = {"per_pr": c["candidates"] / prs, "precision": 100 * p, "recall": 100 * r, "f2": 100 * RC.f2(p, r),
                    "tp": c["tp"], "fp": c["fp"], "candidates": c["candidates"], "core_goldens": c["goldens"], "prs": prs}
    return out


def provenance(d: Data, labels: dict) -> dict:
    out = {}
    for scoring in (LEFT,) + RIGHT:
        out[scoring] = dict(collections.Counter(v["source"] for v in links(d, scoring, labels).values()))
    return out


def compute(root: Path, data: str, labels_path: Path) -> dict:
    """The table, from the labels plus the data. A candidate overlap cannot settle and the label file
    does not cover is an error, never a silent overlap fallback."""
    d = Data(root, data)
    labels = read_labels(labels_path)
    links_by = provenance(d, labels)
    missing = {s: c["label-missing"] for s, c in links_by.items() if c.get("label-missing")}
    if missing:
        raise SystemExit(f"candidates overlap cannot settle have no label: {missing}; run --run")
    return {"left": left_block(root, d, labels), "right": right_block(d, labels), "links": links_by,
            "labels": len(labels)}


def main() -> None:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--archive", required=True)
    ap.add_argument("--data", required=True)
    ap.add_argument("--work")
    ap.add_argument("--labels", help="the label file: --run writes it (default: the committed "
                    f"{LABELS.name}); --compute reads it (default: the release's, in the archive's {RC.RL.DIR}/)")
    ap.add_argument("--env-file", default=str(RC.ENV_FILE))
    ap.add_argument("--labeller", choices=("gpt", "opus"), default="gpt",
                    help="gpt: gpt-6.1-sol through judge-gpt.sh's bridge; opus: the Batch API")
    ap.add_argument("--gpt-url", default=RC.GPT_URL)
    ap.add_argument("--json")
    ap.add_argument("--scope", choices=("unsettled", "all"), default="unsettled",
                    help="unsettled (default): label only what overlap cannot settle; all: every candidate, "
                         "to check the overlap links (write them with --labels elsewhere)")
    mode = ap.add_mutually_exclusive_group(required=True)
    mode.add_argument("--dry-run", action="store_true")
    mode.add_argument("--run", action="store_true")
    mode.add_argument("--compute", action="store_true")
    a = ap.parse_args()
    work = RC.work_dir(a.work, NAME)
    root = open_archive(a.archive, str(work), VOLUMES)
    d = Data(root, a.data)
    if a.compute:
        path, summary = RC.compute_labels(a.labels, root, NAME)
        res = {**compute(root, a.data, path), "label_file": summary}
        print(json.dumps(res, indent=1))
        if a.json:
            Path(a.json).write_text(json.dumps(res, indent=1) + "\n")
        return
    rows = requests(d, a.scope)
    req = work / f"{NAME}.requests.jsonl"
    RC.write_requests(req, rows)
    RC.print_estimate(NAME, req, RC.estimate(rows, lambda r: OUT_TOKENS))
    if a.dry_run:
        return
    if a.labeller == "gpt":
        res = RC.run_gpt(rows, work / f"{NAME}.gpt-answers.jsonl", a.gpt_url)
    else:
        res = RC.run_batch(rows, work / f"{NAME}.batch.json", Path(a.env_file))
    out, bad = [], []
    for r in rows:
        x = res.get(r["custom_id"]) or {"status": "error", "error": "missing from the batch results"}
        if x["status"] != "ok":
            bad.append((r["key"], x.get("error")))
            continue
        out.append({"key": r["key"], **x["answer"], **RC.labeller(a.labeller), "prompt_sha256": r["prompt_sha256"]})
    a.labels = a.labels or str(LABELS)
    n = RC.write_labels(Path(a.labels), out)
    print(f"{n} labels written to {a.labels}; {len(bad)} failed" + (f": {bad[:5]}" if bad else ""))
    if bad:
        sys.exit(1)


if __name__ == "__main__":
    main()
