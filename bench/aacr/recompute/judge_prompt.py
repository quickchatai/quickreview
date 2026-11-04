#!/usr/bin/env python3
"""Print the AACR defect judge's prompt for one arm's review of one PR, from the published tables.

    python3 bench/aacr/recompute/judge_prompt.py --data <hf-dataset> --arm ARM --pr IID [--answer-key DIR]
    python3 bench/aacr/recompute/judge_prompt.py --data <hf-dataset> --arm ARM --all --out-dir DIR [--answer-key DIR]

(`uv run --no-project --with pyarrow python ...` when the tables are parquet.) No model call.

The prompt is what src/bench/defects.ts `judgePrompt()` built from
`reviewForJudge()`'s view of the review, as the code stood from 34164fe0e to
839e26454 (2026-10-15 to 2026-10-18; both commits are on the public main, and
defects.ts is the same file at both, and judgePrompt() is unchanged since):
every published primary-judge verdict of a QuickReview arm was made from this
prompt. Rebuilt from the tables, it equals the prompt the judge received on all
1,674 QuickReview reviews the judge was asked about (the 15 arms; a review with
no comments of a PR with no defects gets no call), byte for byte on 4 and
apart from the release's name rewrite on the other 1,670 (the bot's own name
in a review body reads `<review-bot>`, and the other placeholders the card
lists). Later code renders some reviews differently (c4c07764b drops a
`[check this]` prefix; the deleted-line dedupe of 2026-10-18 and 2026-10-23
needs a file the published runs never wrote), so a judge run from today's main
is not given these prompts; this script is the reference.

Inputs: `prs` (repo, head_commit), `defects` (the key, in the table's order),
`exclusions` (the rejected claims, by `index`), `reviews` (verdict, body,
comments with their ids, tags and text as the judge saw them). The PR's merge
base and title are judge inputs too: `prs.merge_base` and `prs.title` when the
table has them, else the answer-key volume's `<set>-code/<id>/meta.json` under
--answer-key (the directory the run archive was unpacked into). A PR with
neither is refused, never guessed: `prs.base_commit` is not the merge base on
most PRs.

A link-only review (`reviews.source_url` set: a third-party tool's text the
release links instead of copying, such as Copilot 2025's) is refused: its
comments' text is not in the tables, and re-judging it needs the restored run
directories (the card's "What is not here"). `--all` writes no prompt for a
review the judge was never asked about (no comments, and no defect in the PR's
key) and says how many it left out.

`review_hash` (in the frozen and open-model arms' judge files) cannot serve as
a public check: it was taken before the name rewrite. Use this prompt, and
compare yours with it.
"""
from __future__ import annotations

import argparse
import collections
import glob
import json
import os
import sys
from typing import Dict, List, Optional

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from tables import load_table  # noqa: E402

MAX_EXCLUDED_REASON = 600  # defects.ts
MAX_EXCLUDED_TOTAL = 14_000
MAX_BODY = 12_000
DEFECT_VERDICTS = "found|partial|missed"
COMMENT_VERDICTS = "correct-valuable|correct-minor|partly-correct|incorrect|unverifiable"


def site(s: dict) -> str:
    span = f"{s['from_line']}" if s["from_line"] == s["to_line"] else f"{s['from_line']}-{s['to_line']}"
    return f"{s['path']}:{span}" + (f" ({s['role']})" if s.get("role") else "")


def num(x) -> str:
    return "?" if x is None else str(x)


def where(c: dict) -> str:
    """A comment's anchor as reviewForJudge renders it; a deleted-line comment's end is its line."""
    if c.get("path") is None:
        return "(no anchor)"
    path = f"{c['path']} (deleted line)" if c.get("deleted_line") else c["path"]
    end = c["line"] if c.get("deleted_line") else c.get("end_line")
    return f"{path}:{num(c['line'])}" + (f"-{end}" if end and end != c["line"] else "")


def prompt(pr: dict, merge_base: str, title: Optional[str], defects: List[dict], excluded: List[dict],
           review: dict) -> str:
    budget, ex = MAX_EXCLUDED_TOTAL, []
    for e in excluded:
        reason = e["reason"][:MAX_EXCLUDED_REASON] + "…" if len(e["reason"]) > MAX_EXCLUDED_REASON else e["reason"]
        line = f"- {e['source']}: {reason}"
        if len(line) > budget:
            ex.append(f"- ({len(excluded) - len(ex)} more rejected claims not shown)")
            break
        budget -= len(line)
        ex.append(line)
    d = "\n".join(
        f"{x['defect_id']} [{x['severity']}, {x['kind']}] {x['title']}\n   {x['statement']}\n   sites: "
        + "; ".join(site(s) for s in x["sites"]) + (f"\n   counts if: {x['counts_if']}" if x.get("counts_if") else "")
        for x in defects) if defects else "(none — this PR has no real defect in the ground truth)"
    comments = review.get("comments") or []
    c = "\n\n".join(f"{x['id']} " + (f"[{x['tag']}] " if x.get("tag") else "") + f"{where(x)}\n{x['text']}"
                    for x in comments) if comments else "(no comments)"
    body = review.get("body")
    if body and len(body) > MAX_BODY:
        body = body[:MAX_BODY] + "\n[… body truncated]"
    exblock = ("CLAIMS ALREADY CHECKED AGAINST THE CODE AND REJECTED (not defects — each with the reason it failed). "
               "A comment repeating one of these is never a new defect: judge it incorrect, partly-correct or "
               "correct-minor as its reason says, reading the code if the comment adds something the reason does not "
               "cover:\n" + "\n".join(ex) + "\n\n") if ex else ""
    return f"""You are the judge of a code-review benchmark that measures one thing: does a review FIND the real defects in a pull request and point them out, and is what it says true? Wording, tone, tags and exact line numbers do not matter; substance does.

THE PULL REQUEST: {title or "(untitled)"} — {pr['repo']}, head {pr['head_commit']}, merge base {merge_base}. The repository is checked out at the PR head in your working directory. You may read any code (read tool; bash for git diff/show/log/grep, rg, ls, find, sed -n, head, tail, wc). Never run project code.

THE REAL DEFECTS (ground truth — each verified against the code; trust these):
{d}

{exblock}THE REVIEW (what the author received):
Verdict: {review.get('verdict') or '(none)'}
{('Body:' + chr(10) + body + chr(10)) if body else ''}Comments:
{c}

YOUR TASK
1. For EACH defect decide whether the review found it:
   - found: some comment (or the body) identifies THIS defect — the same underlying problem, with its essential point right (see "counts if"), so the author would fix it. It may sit at the cause or the symptom site, or name the site in its text.
   - partial: the review points at this problem or its site, but with a wrong or missing mechanism or consequence, so the author could fix the wrong thing.
   - missed: nothing in the review identifies it.
2. For EACH comment: which defect it finds (its id, or null), and whether it is correct. Check every comment that finds no listed defect against the code:
   - correct-valuable: true at the head and worth raising before merge;
   - correct-minor: true but low value (style, a test request, a nice-to-have, a nit);
   - partly-correct: a real problem, but the mechanism, scope or severity is materially wrong;
   - incorrect: false at the head (the code does not do what it says, or the scenario cannot happen);
   - unverifiable: cannot be decided from the repository.
   A comment that finds a listed defect is correct-valuable, or partly-correct if it found it only partially. Set new_defect true only for a correct-valuable comment that describes a real defect that is neither in the list nor among the rejected claims.
Be strict both ways: do not credit a comment for sounding plausible, and do not dismiss one without reading the code it cites.

Answer with ONE JSON object and nothing after it:
{{"defects":[{{"id":"D1","verdict":"{DEFECT_VERDICTS}","comments":["C2"],"why":"one sentence"}}],"comments":[{{"id":"C1","defect":"D1","verdict":"{COMMENT_VERDICTS}","new_defect":false,"why":"one sentence with file:line"}}]}}
Every defect id and every comment id above must appear exactly once."""


class Prompts:
    """Every published input of the prompt, indexed once."""

    def __init__(self, data: str, answer_key: Optional[str] = None):
        self.prs = {p["instance_id"]: p for p in load_table(data, "prs")}
        self.defects: Dict[str, List[dict]] = collections.defaultdict(list)
        for d in load_table(data, "defects"):
            self.defects[d["instance_id"]].append(d)
        self.excluded: Dict[str, List[dict]] = collections.defaultdict(list)
        for e in sorted(load_table(data, "exclusions"), key=lambda e: e["index"]):
            self.excluded[e["instance_id"]].append(e)
        self.reviews = {(r["arm_id"], r["instance_id"]): r for r in load_table(data, "reviews")}
        self.meta: Dict[str, dict] = {}
        for f in sorted(glob.glob(os.path.join(answer_key, "*-code", "*", "meta.json"))) if answer_key else []:
            with open(f) as fh:
                m = json.load(fh)
            self.meta[m["instance_id"]] = m

    def pr_inputs(self, iid: str):
        p = self.prs.get(iid)
        if p is None:
            raise SystemExit(f"no PR {iid!r} in the prs table")
        m = self.meta.get(iid, {})
        merge_base = p.get("merge_base") or m.get("merge_base")
        if not merge_base:
            raise SystemExit(f"{iid}: no merge base — the prs table has no merge_base column and no meta.json under "
                             "--answer-key holds it (prs.base_commit is not the merge base)")
        title = p["title"] if "title" in p else m.get("title")
        return p, merge_base, title

    def prompt(self, arm: str, iid: str) -> str:
        review = self.reviews.get((arm, iid))
        if review is None:
            raise SystemExit(f"no review of {iid} by arm {arm!r} in the reviews table")
        if review.get("source_url") is not None or any(c.get("text") is None for c in review.get("comments") or []):
            raise SystemExit(f"{arm} on {iid} is link-only: its text is not in the tables ({review.get('source_url')}); "
                             "restore the run directories and judge it from them")
        p, merge_base, title = self.pr_inputs(iid)
        return prompt(p, merge_base, title, self.defects.get(iid, []), self.excluded.get(iid, []), review)


def main() -> None:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--data", required=True, help="the Hugging Face dataset dir (or its data/ dir)")
    ap.add_argument("--arm", required=True, help="an arms.arm_id")
    ap.add_argument("--pr", help="one PR's instance id: print its prompt")
    ap.add_argument("--all", action="store_true", help="every PR the arm reviewed, one file each under --out-dir")
    ap.add_argument("--out-dir", help="with --all: write <out-dir>/<instance id>.txt")
    ap.add_argument("--answer-key", help="the unpacked run archive (its *-code/<id>/meta.json: merge base and "
                                         "title), when the prs table lacks them")
    a = ap.parse_args()
    if bool(a.pr) == bool(a.all):
        sys.exit("give one of --pr IID or --all")
    p = Prompts(a.data, a.answer_key)
    if a.pr:
        sys.stdout.write(p.prompt(a.arm, a.pr) + "\n")
        return
    if not a.out_dir:
        sys.exit("--all writes one file per PR: give --out-dir")
    os.makedirs(a.out_dir, exist_ok=True)
    ids = sorted(i for arm, i in p.reviews if arm == a.arm)
    # the judge was never asked about a review with no comments of a PR with no defects
    asked = [i for i in ids if p.reviews[(a.arm, i)].get("comments") or p.defects.get(i)]
    for iid in asked:
        with open(os.path.join(a.out_dir, f"{iid}.txt"), "w") as f:
            f.write(p.prompt(a.arm, iid))
    print(f"wrote {len(asked)} prompts of {a.arm} to {a.out_dir}; left out {len(ids) - len(asked)} reviews the judge "
          "was never asked about (no comments, no defect in the key)")


if __name__ == "__main__":
    main()
