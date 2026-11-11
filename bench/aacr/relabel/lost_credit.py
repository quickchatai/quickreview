#!/usr/bin/env python3
"""Where the low preset's lost credit went, and what the default's validator removed, on the
gpt-6-sol AACR runs (quickreview.tex §"The validator removes little" and §"With the design fixed,
less compute finds less"), rebuilt from the release.

    uv run --no-project --with pyarrow python3 bench/aacr/relabel/lost_credit.py \\
        --archive <release>/archive --data <hf-dataset> --work <scratch> --dry-run
    uv run --no-project --with pyarrow python3 bench/aacr/relabel/lost_credit.py \\
        --archive <release>/archive --data <hf-dataset> --work <scratch> --run
        # gpt-6.1-sol through judge-gpt.sh's bridge, as the shipped labels were made;
        # --labeller opus uses the Batch API instead and needs --with anthropic==1.15.0
    uv run --no-project --with pyarrow python3 bench/aacr/relabel/lost_credit.py \\
        --archive <release>/archive --data <hf-dataset> --work <scratch> --compute [--json OUT]

Arms: quickreview-default-sol (every role on gpt-6-sol at its default effort, the validator high)
and quickreview-low-sol (the same plan, every role at low), 185 PRs each, credit from the primary
judge (`defect_verdicts`, judge gpt-6-sol-high: found 1, partial 1/2).

Deterministic, from the published data:
  credit     each defect's credit on each arm;
  lost       the defects the default credits more than low (weight: the credit difference);
  near       what each arm's review had at a defect: the posted comments (HF `reviews.comments`)
             whose line is within K=5 lines of one of the defect's sites, and the findings the
             validator dropped there (archive `cases/<id>/findings-record.json`, disposition killed
             or withheld; their one-line `evidence` is the claim);
  kills      the default's killed + withheld findings against its posted comments ("posting every
             kill would add N% more comments").
Labelled (one request per arm and defect, every near item at once, shuffled with a fixed seed and
stripped of whether it was posted): whether each near item states the defect ("same"), touches it
without meeting its counting condition ("related"), or is about something else ("different").
Proximity alone counts every nearby comment as "about" the defect; the label is what separates a
weaker comment on the defect from a comment on something else at the same lines.

The compute, labels plus data:
  attribution  each lost defect, at low: "weaker comments" when a posted comment is about it
               (same or related), else "validator filtering" when a dropped finding is about it,
               else "lens generation"; shares of the lost credit;
  only_killed  per arm, the defects with no credit whose only findings about them were dropped;
  same_claim   the default's defects with no credit and a dropped finding stating them ("killed as
               the same claim"), and that count in points of recall (/ the key's 520 defects);
  at_most      the recall the default would gain if every dropped finding about a defect it did not
               fully credit earned full credit, in points (same; and same or related, the bound).
`--compute` prints the proximity-only figures (every near item "about") under "proximity" and the
labelled ones under "labelled", from the label file the release carries (the archive's analysis
volume, analysis/relabel/, beside its prompt; every row's model and prompt sha256 are checked).
"""
from __future__ import annotations

import argparse
import ast
import collections
import json
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
import relabel_common as RC  # noqa: E402
from archive import open_archive, read_json  # noqa: E402
from tables import load_table  # noqa: E402

NAME = "lost_credit"
PROMPT = RC.HERE / f"{NAME}.prompt.md"
LABELS = RC.HERE / f"{NAME}.labels.jsonl"
VOLUMES = ["aacr-gpt6sol-study", "analysis"]  # analysis: the label file (analysis/relabel/)
DEFAULT, LOW = "quickreview-default-sol", "quickreview-low-sol"
JUDGE = "gpt-6-sol-high"
CREDIT = {"found": 1.0, "partial": 0.5}
K = 5
DROPPED = ("killed", "withheld")
LABEL_SET = ("same", "related", "different")
OUT_TOKENS_BASE, OUT_TOKENS_ITEM = 1500, 250  # per request: adaptive thinking at effort high + the JSON

SCHEMA = {"type": "object", "additionalProperties": False, "required": ["items"],
          "properties": {"items": {"type": "array", "items": {
              "type": "object", "additionalProperties": False, "required": ["id", "label", "why"],
              "properties": {"id": {"type": "string"}, "label": {"type": "string", "enum": list(LABEL_SET)},
                             "why": {"type": "string"}}}}}}


def _list(v):
    if isinstance(v, str):
        try:
            return ast.literal_eval(v) if v.strip() else []
        except (ValueError, SyntaxError):
            return json.loads(v)
    return list(v or [])


def _line(v):
    try:
        return int(str(v).split("-")[0])
    except (TypeError, ValueError):
        return None


class Data:
    def __init__(self, root: Path, data: str):
        self.root = root
        self.defects = sorted(load_table(data, "defects"), key=lambda d: (d["instance_id"], d["defect_id"]))
        self.n_key = len(self.defects)
        self.reviews, self.credit = {}, {}
        for arm in (DEFAULT, LOW):
            self.reviews[arm] = {r["instance_id"]: r for r in load_table(data, "reviews")
                                 if r["arm_id"] == arm and str(r["judged"]) in ("True", "true", "1")}
            self.credit[arm] = {(v["instance_id"], v["defect_id"]): CREDIT.get(v["verdict"], 0.0)
                                for v in load_table(data, "defect_verdicts") if v["arm_id"] == arm and v["judge"] == JUDGE}
        self._rec = {}

    def findings(self, arm: str, iid: str) -> list:
        k = (arm, iid)
        if k not in self._rec:
            run = self.reviews[arm][iid]["run"]
            p = self.root / "runs" / run / "cases" / iid / "findings-record.json"
            self._rec[k] = (read_json(p).get("findings") or []) if p.exists() else []
        return self._rec[k]

    def near(self, arm: str, d: dict) -> list:
        """The items an arm's review had at the defect: posted comments within K lines of a site,
        and dropped findings there. [{ref, kind: posted|dropped, disposition, path, line, text}]."""
        sites = [(s["path"], s.get("from_line") or 0, s.get("to_line") or s.get("from_line") or 0) for s in _list(d["sites"])]

        def at(path, line):
            return line is not None and any(path == p and f - K <= line <= t + K for p, f, t in sites)

        out = []
        for c in _list(self.reviews[arm][d["instance_id"]]["comments"]):
            if at(c.get("path"), _line(c.get("line"))):
                out.append({"ref": f"p:{c['id']}", "kind": "posted", "disposition": "posted", "path": c["path"],
                            "line": _line(c["line"]), "text": c.get("text") or ""})
        for f in self.findings(arm, d["instance_id"]):
            if f.get("disposition") in DROPPED and at(f.get("path"), _line(f.get("line"))):
                out.append({"ref": f"f:{f.get('id')}", "kind": "dropped", "disposition": f["disposition"],
                            "path": f.get("path"), "line": _line(f.get("line")), "text": f.get("evidence") or ""})
        return out

    def key(self, d):
        return (d["instance_id"], d["defect_id"])

    def in_both(self, d):
        return d["instance_id"] in self.reviews[DEFAULT] and d["instance_id"] in self.reviews[LOW]


def units(dt: Data) -> list:
    """(arm, defect, items) needing a label: low's lost defects; each arm's uncredited defects with a
    dropped finding near; the default's not-fully-credited defects with a dropped finding near."""
    out = []
    for d in dt.defects:
        if not dt.in_both(d):
            continue
        k = dt.key(d)
        cd, cl = dt.credit[DEFAULT].get(k, 0.0), dt.credit[LOW].get(k, 0.0)
        for arm, c in ((DEFAULT, cd), (LOW, cl)):
            items = dt.near(arm, d)
            if not items:
                continue
            dropped = any(i["kind"] == "dropped" for i in items)
            if (arm == LOW and cd > cl) or (dropped and c < 1.0):
                out.append((arm, d, items))
    return out


def requests(dt: Data) -> list:
    system = RC.load_prompt(PROMPT)
    psha = RC.sha256(system)
    rows = []
    for arm, d, items in units(dt):
        order = list(items)
        RC.rng(arm, d["instance_id"], d["defect_id"]).shuffle(order)
        ids = {f"i{n + 1}": it["ref"] for n, it in enumerate(order)}
        sites = "; ".join(f"{s['path']}:{s.get('from_line')}-{s.get('to_line')}" for s in _list(d["sites"]))
        listing = "\n\n".join(f"[{iid}] {it['path']}:{it['line']}\n{it['text'].strip()}"
                              for iid, it in zip(ids, order))
        user = (f"Defect: {d['title']}\n\nStatement: {d['statement']}\n\nCounts if: {d['counts_if']}\n\n"
                f"Where: {sites}\n\nFindings at or near this code:\n\n{listing}\n")
        k = {"arm": arm, "instance_id": d["instance_id"], "defect_id": d["defect_id"]}
        rows.append({"custom_id": RC.custom_id("lc", json.dumps(k, sort_keys=True)), "key": k, "ids": ids,
                     "prompt_sha256": psha, "params": RC.params(system, user, SCHEMA)})
    return rows


# ---- compute --------------------------------------------------------------------------------

def read_labels(path: Path) -> dict:
    """{(arm, instance_id, defect_id): {item ref: label}}."""
    if not path.exists():
        return {}
    return {(r["key"]["arm"], r["key"]["instance_id"], r["key"]["defect_id"]): r["labels"] for r in RC.read_jsonl(path)}


def compute(dt: Data, labels: dict, proximity: bool) -> dict:
    """The figures, with every near item "about" its defect (proximity) or as labelled. A unit the
    label file lacks is an error, never a silent proximity fallback."""
    need = {(arm, d["instance_id"], d["defect_id"]) for arm, d, _ in units(dt)}
    if not proximity:
        missing = sorted(need - set(labels))
        if missing:
            raise SystemExit(f"{len(missing)} units have no label (first: {missing[0]}); run --run, or read 'proximity'")

    def about(arm, d, items, strict=False):
        if proximity:
            return items
        lab = labels.get((arm, d["instance_id"], d["defect_id"]), {})
        ok = ("same",) if strict else ("same", "related")
        return [i for i in items if lab.get(i["ref"]) in ok]

    shares = collections.Counter()
    lost_defects = collections.Counter()
    only_killed = {DEFAULT: 0, LOW: 0}
    same_claim, at_most_same, at_most_any = 0, 0.0, 0.0
    for d in dt.defects:
        if not dt.in_both(d):
            continue
        k = dt.key(d)
        cd, cl = dt.credit[DEFAULT].get(k, 0.0), dt.credit[LOW].get(k, 0.0)
        near = {arm: dt.near(arm, d) for arm in (DEFAULT, LOW)}
        if cd > cl:
            a = about(LOW, d, near[LOW])
            cls = ("weaker comments" if any(i["kind"] == "posted" for i in a)
                   else "validator filtering" if any(i["kind"] == "dropped" for i in a) else "lens generation")
            shares[cls] += cd - cl
            lost_defects[cls] += 1
        for arm, c in ((DEFAULT, cd), (LOW, cl)):
            if c > 0 or not any(i["kind"] == "dropped" for i in near[arm]):
                continue
            a = about(arm, d, near[arm])
            if a and all(i["kind"] == "dropped" for i in a):
                only_killed[arm] += 1
        if cd < 1 and any(i["kind"] == "dropped" for i in near[DEFAULT]):
            s = [i for i in about(DEFAULT, d, near[DEFAULT], strict=True) if i["kind"] == "dropped"]
            r = [i for i in about(DEFAULT, d, near[DEFAULT]) if i["kind"] == "dropped"]
            if s:
                at_most_same += 1 - cd
                same_claim += cd == 0
            if r:
                at_most_any += 1 - cd
    total = sum(shares.values())
    return {"lost_credit": total, "lost_defects": sum(lost_defects.values()),
            "attribution_pct": {c: 100 * v / total if total else None for c, v in sorted(shares.items())},
            "attribution_credit": dict(sorted(shares.items())), "attribution_defects": dict(sorted(lost_defects.items())),
            "only_killed": {"low": only_killed[LOW], "default": only_killed[DEFAULT]},
            "same_claim_killed": same_claim, "same_claim_killed_points": 100 * same_claim / dt.n_key,
            "at_most_points_same": 100 * at_most_same / dt.n_key, "at_most_points_same_or_related": 100 * at_most_any / dt.n_key}


def kills(dt: Data) -> dict:
    disp = collections.Counter()
    for iid in dt.reviews[DEFAULT]:
        for f in dt.findings(DEFAULT, iid):
            disp[f.get("disposition") or "none"] += 1
    posted = sum(len(_list(r["comments"])) for r in dt.reviews[DEFAULT].values())
    return {"posted_comments": posted, "dispositions": dict(disp),
            "kill_pct_of_posted": 100 * disp["killed"] / posted,
            "dropped_pct_of_posted": 100 * sum(disp[x] for x in DROPPED) / posted}


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
    mode = ap.add_mutually_exclusive_group(required=True)
    mode.add_argument("--dry-run", action="store_true")
    mode.add_argument("--run", action="store_true")
    mode.add_argument("--compute", action="store_true")
    a = ap.parse_args()
    work = RC.work_dir(a.work, NAME)
    root = open_archive(a.archive, str(work), VOLUMES)
    dt = Data(root, a.data)
    if a.compute:
        path, summary = RC.compute_labels(a.labels, root, NAME)
        labels = read_labels(path)
        res = {"credit": {"default": sum(dt.credit[DEFAULT].values()), "low": sum(dt.credit[LOW].values()),
                          "key": dt.n_key},
               "kills": kills(dt), "proximity": compute(dt, labels, True),
               "labelled": compute(dt, labels, False), "label_file": summary}
        print(json.dumps(res, indent=1))
        if a.json:
            Path(a.json).write_text(json.dumps(res, indent=1) + "\n")
        return
    rows = requests(dt)
    req = work / f"{NAME}.requests.jsonl"
    RC.write_requests(req, rows)
    RC.print_estimate(NAME, req, RC.estimate(rows, lambda r: OUT_TOKENS_BASE + OUT_TOKENS_ITEM * len(r["ids"])))
    print(f"  items to label: {sum(len(r['ids']) for r in rows)}")
    if a.dry_run:
        return
    if a.labeller == "gpt":
        res = RC.run_gpt(rows, work / f"{NAME}.gpt-answers.jsonl", a.gpt_url)
    else:
        res = RC.run_batch(rows, work / f"{NAME}.batch.json", Path(a.env_file))
    out, bad = [], []
    for r in rows:
        x = res.get(r["custom_id"]) or {"status": "error", "error": "missing from the batch results"}
        got = {i["id"]: i["label"] for i in (x.get("answer") or {}).get("items") or []} if x["status"] == "ok" else {}
        if x["status"] != "ok" or set(got) != set(r["ids"]):
            bad.append((r["key"], x.get("error") or f"answered {sorted(got)} for {sorted(r['ids'])}"))
            continue
        out.append({"key": r["key"], "labels": {r["ids"][i]: lab for i, lab in sorted(got.items())},
                    "why": {r["ids"][i["id"]]: i["why"] for i in x["answer"]["items"]},
                    **RC.labeller(a.labeller), "prompt_sha256": r["prompt_sha256"]})
    a.labels = a.labels or str(LABELS)
    n = RC.write_labels(Path(a.labels), out)
    print(f"{n} labels written to {a.labels}; {len(bad)} failed" + (f": {bad[:5]}" if bad else ""))
    if bad:
        sys.exit(1)


if __name__ == "__main__":
    main()
