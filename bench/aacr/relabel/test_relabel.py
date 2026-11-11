"""The two labelling passes' deterministic halves, on hand-made fixtures (no model output, no
network, standard library only):

    python3 -m unittest bench/aacr/relabel/test_relabel.py

  1. martian_tiers: a comment's tier is its own tag and severity (a folded note keeps its own);
     overlap settles a candidate unless a comment of another tier scores within the margin; a
     label overrides the overlap for exactly that candidate; the left block rolls the blind
     classification up per tier (a second candidate naming the same golden is a DUP); the right
     block recounts the stored judgements per subset under the Core profile.
  2. lost_credit: a lost defect is "weaker comments" when a posted comment is about it, "validator
     filtering" when only a dropped finding is, "lens generation" otherwise; proximity counts every
     near item as about it, the labels do not; a unit with no label is an error; the default's
     same-claim kills and the recall bound count only dropped findings labelled "same".
  3. the label files: every committed row records its model and the sha256 of the committed prompt; the
     release carries them byte for byte under analysis/relabel/ with LABELS.json; a compute refuses a
     row whose prompt sha256 is not the prompt shipped beside it.
"""
from __future__ import annotations

import json
import os
import sys
import tempfile
import unittest
from pathlib import Path

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE))
import lost_credit as LC  # noqa: E402
import martian_tiers as MT  # noqa: E402
import relabel_common as RC  # noqa: E402
import release as RL  # noqa: E402

PR = "https://github.com/calcom/cal.com/pull/1"


def jdump(path: Path, obj) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(obj))


def jsonl(path: Path, rows) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text("".join(json.dumps(r) + "\n" for r in rows))


# ---- martian_tiers fixture -------------------------------------------------------------------

COMMENTS = [
    {"path": "slots.ts", "line": 10, "body": "[blocker] Override days ignore bookings\n\nThe override branch returns "
     "early so existing bookings never block overlapping slots.\n\n_P1 · confidence 1.0 · lens pass-baseline_"},
    {"path": "docs.md", "line": 3, "body": "[nit] Document the timezone setting\n\nPlease describe the attendee "
     "timezone conversion in the setup guide.\n\n_P3 · confidence 0.9 · lens pass-maintainability_"},
    {"path": "slots.ts", "line": 40, "body": "[question] Should partial windows pass?\n\nWindow containment accepts "
     "slots starting at the closing boundary.\n\nAlso on these lines: [nit] Rename windowCheck for clarity.\n\n"
     "_P2 · confidence 0.8 · lens pass-bounds; folded nit: P3 · confidence 0.9 · lens pass-simplicity_"},
    {"path": None, "line": None, "body": "Summary of the review.\n\n### Blockers\n- `slots.ts:10` — Override days "
     "ignore bookings _(P1/1.0, baseline)_\n"},
]
CANDS = [
    "Override days return early so existing bookings never block overlapping slots.",
    "The setup guide should describe attendee timezone conversion.",
    "Overlapping bookings are ignored because the override branch returns early.",
    "Overlapping slots boundary.",  # two of its words in c0 (P1), two in c2 (P2): overlap cannot settle it
]
GOLDENS = [{"comment": "Override returns before the busy check, double booking.", "severity": "High"},
           {"comment": "Rename a variable.", "severity": "Low"}]


def martian_fixture(root: Path, data: Path) -> None:
    for scoring in (MT.LEFT,) + MT.RIGHT:
        res = root / "runs" / scoring / "results"
        jdump(res / "benchmark_data.json", {PR: {"golden_comments": GOLDENS, "reviews": [
            {"tool": "quickreview", "review_comments": COMMENTS}]}})
        jdump(res / MT.JUDGE / "candidates.json", {PR: {"quickreview": [{"text": t} for t in CANDS]}})
        jdump(res / MT.JUDGE / "evaluations.json", {PR: {"quickreview": {
            "true_positives": [{"golden_comment": GOLDENS[0]["comment"], "matched_candidate": CANDS[0]}],
            "false_positives": [{"candidate": t} for t in CANDS[1:]]}}})
    an = root / MT_AN
    jdump(an / "fair" / "secret.json", {f"C{i}": {"tool": "quickreview", "pr": PR, "idx": i, "text": t,
                                                  "matched": i == 0} for i, t in enumerate(CANDS)})
    ann = {"C0": "GOLDEN", "C1": "MINOR", "C2": "GOLDEN", "C3": "WRONG"}
    issue = {"C0": "cal1.0", "C1": "cal1.M1", "C2": "cal1.0", "C3": "cal1.W1"}
    jdump(an / "fair" / "out" / "cal1.json", {"candidates": {c: {"class": k, "issue": issue[c], "also": []} for c, k in ann.items()},
                                              "key_entries": {}})
    jdump(an / "gm" / "rows.json", [{"pr": "cal1", "idx": 0, "q": "valid", "D": "P+"},
                                    {"pr": "cal1", "idx": 1, "q": "trivial", "D": "NR"}])
    jsonl(data / "martian_goldens.jsonl", [{"pr_url": PR, "golden_index": 0, "category": "bug"},
                                           {"pr_url": PR, "golden_index": 1, "category": "style"}])


MT_AN = "analysis/external-benchmarks-2026-10-02"


class MartianTiers(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        t = Path(self.tmp.name)
        self.root, self.data = t / "archive", t / "hf"
        martian_fixture(self.root, self.data)
        self.labels = t / "labels.jsonl"

    def tearDown(self):
        self.tmp.cleanup()

    def test_units_and_tiers(self):
        u = {x["id"]: x for x in MT.review_units(COMMENTS)}
        self.assertEqual([MT.tier(u[k]) for k in ("c0", "c1", "c2", "c2f", "b0")], ["P0-P1", "nit", "P2", "nit", "P0-P1"])
        self.assertNotIn("_P1", u["c0"]["text"])  # the labeller never sees the severity line
        self.assertNotIn("[blocker]", u["c0"]["text"])

    def test_overlap_settles_unless_another_tier_is_close(self):
        units = MT.review_units(COMMENTS)
        self.assertFalse(MT.match(CANDS[0], units)["unsettled"])
        self.assertTrue(MT.match(CANDS[3], units)["unsettled"])
        rows = MT.requests(MT.Data(self.root, str(self.data)))
        self.assertEqual(sorted({(r["key"]["scoring"], r["key"]["candidate"]) for r in rows}),
                         sorted((s, 3) for s in (MT.LEFT,) + MT.RIGHT))

    def test_compute_with_a_label(self):
        jsonl(self.labels, [{"key": MT.key(s, PR, 3), "comment": "c2", "confidence": "high", "why": "x"}
                            for s in (MT.LEFT,) + MT.RIGHT])
        res = MT.compute(self.root, str(self.data), self.labels)
        left = res["left"]
        self.assertEqual((left["P0-P1"]["n"], left["P0-P1"]["real"], left["P0-P1"]["dup"]), (2, 1, 1))
        self.assertEqual((left["P2"]["n"], left["P2"]["wrong"]), (1, 1))
        self.assertEqual((left["nit"]["n"], left["nit"]["minor"]), (1, 1))
        right = res["right"]
        self.assertEqual(right["everything"]["per_pr"], 4.0)
        self.assertAlmostEqual(right["everything"]["precision"], 25.0)
        self.assertAlmostEqual(right["everything"]["recall"], 100.0)  # the style golden is outside Core
        self.assertAlmostEqual(right["P0-P1 only"]["precision"], 50.0)
        self.assertAlmostEqual(right["blockers only"]["precision"], 50.0)
        self.assertAlmostEqual(right["P0-P2"]["precision"], 100 / 3)
        self.assertEqual(res["links"][MT.LEFT], {"overlap": 3, "label": 1})

    def test_without_the_label_the_compute_refuses(self):
        d = MT.Data(self.root, str(self.data))
        self.assertEqual(MT.provenance(d, {})[MT.LEFT], {"overlap": 3, "label-missing": 1})
        with self.assertRaises(SystemExit):
            MT.compute(self.root, str(self.data), self.labels)

    def test_a_none_label_is_unmapped(self):
        jsonl(self.labels, [{"key": MT.key(s, PR, 3), "comment": "none", "confidence": "high", "why": "x"}
                            for s in (MT.LEFT,) + MT.RIGHT])
        res = MT.compute(self.root, str(self.data), self.labels)
        self.assertEqual(res["left"]["unmapped"]["n"], 1)
        self.assertEqual(res["right"]["everything"]["candidates"], 8)  # two scorings; kept only in "everything"
        self.assertEqual(res["right"]["P0-P2"]["candidates"], 4)


# ---- the label files as the release carries them ----------------------------------------------

class ReleaseFiles(unittest.TestCase):
    """The committed label files: every row records the model and the sha256 of the committed prompt,
    and the release's copy (analysis/relabel/) is byte-identical with a LABELS.json naming both."""

    def test_committed_rows_carry_model_and_prompt_sha(self):
        for name in RL.PASSES:
            rows = RL.read_rows(HERE / f"{name}.labels.jsonl")
            self.assertTrue(rows, name)
            self.assertEqual(RL.check_rows(rows, (HERE / f"{name}.prompt.md").read_text()), [], name)
            self.assertEqual({r["model"] for r in rows}, {"gpt-6.1-sol"}, name)

    def test_a_row_with_another_prompt_or_no_model_fails(self):
        prompt = (HERE / "lost_credit.prompt.md").read_text()
        row = {"model": "gpt-6.1-sol", "prompt_sha256": RL.sha256(prompt)}
        self.assertEqual(RL.check_rows([row], prompt), [])
        self.assertEqual(len(RL.check_rows([row], prompt + " ")), 1)
        self.assertEqual(len(RL.check_rows([{**row, "model": None}], prompt)), 1)

    def test_release_copy(self):
        f = RL.files()
        prov = json.loads(f[f"{RL.DIR}/LABELS.json"])
        for name in RL.PASSES:
            self.assertEqual(f[f"{RL.DIR}/{name}.labels.jsonl"], (HERE / f"{name}.labels.jsonl").read_bytes())
            p = prov["passes"][name]
            self.assertEqual(p["prompt_sha256"], RL.sha256((HERE / f"{name}.prompt.md").read_text()))
            self.assertEqual((p["model"], p["rows"]), ("gpt-6.1-sol", len(RL.read_rows(HERE / f"{name}.labels.jsonl"))))

    def test_compute_reads_the_release_copy_and_checks_it(self):
        with tempfile.TemporaryDirectory() as t:
            root = Path(t)
            for k, v in RL.files().items():
                (root / k).parent.mkdir(parents=True, exist_ok=True)
                (root / k).write_bytes(v)
            path, summary = RC.compute_labels(None, root, "lost_credit")
            self.assertEqual(path, root / RL.DIR / "lost_credit.labels.jsonl")
            self.assertEqual(summary["model"], ["gpt-6.1-sol"])
            (root / RL.DIR / "lost_credit.prompt.md").write_text("another prompt")
            with self.assertRaises(SystemExit):
                RC.compute_labels(None, root, "lost_credit")


# ---- lost_credit fixture ---------------------------------------------------------------------

IID = "o__r@1"


def lost_fixture(root: Path, data: Path) -> None:
    site = lambda p, f, t: [{"path": p, "from_line": f, "to_line": t, "role": "cause"}]  # noqa: E731
    jsonl(data / "defects.jsonl", [
        {"instance_id": IID, "defect_id": d, "title": f"title {d}", "statement": "s", "counts_if": "c", "sites": s}
        for d, s in (("D1", site("a.py", 10, 12)), ("D2", site("b.py", 50, 50)), ("D3", site("c.py", 5, 5)),
                     ("D4", site("d.py", 100, 100)))])
    jsonl(data / "reviews.jsonl", [
        {"arm_id": LC.DEFAULT, "instance_id": IID, "run": "def-run", "judged": "True",
         "comments": [{"id": "C1", "path": "a.py", "line": 10, "text": "a"}, {"id": "C2", "path": "b.py", "line": 50, "text": "b"}]},
        {"arm_id": LC.LOW, "instance_id": IID, "run": "low-run", "judged": "True",
         "comments": [{"id": "C1", "path": "a.py", "line": 11, "text": "other"}, {"id": "C2", "path": "b.py", "line": 51, "text": "b"}]}])
    v = [(LC.DEFAULT, "D1", "found"), (LC.DEFAULT, "D2", "found"), (LC.DEFAULT, "D3", "missed"), (LC.DEFAULT, "D4", "found"),
         (LC.LOW, "D1", "missed"), (LC.LOW, "D2", "partial"), (LC.LOW, "D3", "missed"), (LC.LOW, "D4", "missed")]
    jsonl(data / "defect_verdicts.jsonl", [{"arm_id": a, "instance_id": IID, "defect_id": d, "judge": LC.JUDGE, "verdict": x}
                                           for a, d, x in v])
    jdump(root / "runs" / "def-run" / "cases" / IID / "findings-record.json", {"findings": [
        {"id": "X", "path": "c.py", "line": 5, "disposition": "killed", "evidence": "x"},
        {"id": "Y", "path": "a.py", "line": 10, "disposition": "posted", "evidence": "y"},
        {"id": "Z", "path": "b.py", "line": 50, "disposition": "posted", "evidence": "z"}]})
    jdump(root / "runs" / "low-run" / "cases" / IID / "findings-record.json", {"findings": [
        {"id": "B", "path": "a.py", "line": 12, "disposition": "killed", "evidence": "the defect"}]})


class LostCredit(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        t = Path(self.tmp.name)
        (t / "archive" / "runs").mkdir(parents=True)
        lost_fixture(t / "archive", t / "hf")
        self.dt = LC.Data(t / "archive", str(t / "hf"))
        self.labels = {(LC.LOW, IID, "D1"): {"p:C1": "different", "f:B": "same"},
                       (LC.LOW, IID, "D2"): {"p:C2": "related"},
                       (LC.DEFAULT, IID, "D3"): {"f:X": "same"}}

    def tearDown(self):
        self.tmp.cleanup()

    def test_units_are_the_three_that_need_a_label(self):
        self.assertEqual(sorted((a, d["defect_id"]) for a, d, _ in LC.units(self.dt)),
                         sorted((a, d) for a, _, d in self.labels))
        rows = LC.requests(self.dt)
        for r in rows:  # blind: the request never says which item was posted
            text = r["params"]["messages"][0]["content"][0]["text"]
            self.assertNotIn("killed", text)
            self.assertNotIn("posted", text.split("Findings at or near this code:")[1])

    def test_labelled_attribution(self):
        res = LC.compute(self.dt, self.labels, proximity=False)
        self.assertEqual(res["lost_credit"], 2.5)
        self.assertEqual(res["attribution_pct"], {"lens generation": 40.0, "validator filtering": 40.0,
                                                  "weaker comments": 20.0})
        self.assertEqual(res["only_killed"], {"low": 1, "default": 1})
        self.assertEqual(res["same_claim_killed"], 1)
        self.assertEqual(res["same_claim_killed_points"], 25.0)
        self.assertEqual(res["at_most_points_same"], 25.0)

    def test_proximity_counts_every_near_item(self):
        res = LC.compute(self.dt, {}, proximity=True)
        self.assertEqual(res["attribution_credit"], {"lens generation": 1.0, "weaker comments": 1.5})
        self.assertEqual(res["only_killed"], {"low": 0, "default": 1})

    def test_a_missing_label_is_an_error(self):
        partial = dict(self.labels)
        partial.pop((LC.DEFAULT, IID, "D3"))
        with self.assertRaises(SystemExit):
            LC.compute(self.dt, partial, proximity=False)

    def test_kills_against_posted_comments(self):
        k = LC.kills(self.dt)
        self.assertEqual((k["posted_comments"], k["kill_pct_of_posted"]), (2, 50.0))


if __name__ == "__main__":
    unittest.main()
