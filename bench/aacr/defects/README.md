# Defect ground truth — what the defect benchmark scores against

AACR-Bench scores whether a review wrote the SAME COMMENT as a dataset
reference. Checked against the code, about half of its v1.0 references are
wrong and only ~10% name an important defect, so that score says little about
review quality. The defect benchmark asks the question a review is for: **did
it find the real defects in the PR, and is what it says true?**

`<set>.json` (one per case set in `../sets/`) lists, per PR, the real defects
the PR introduces or newly exposes:

```json
{ "set": "smoke10", "version": "1", "method": "…",
  "cases": { "<instance_id>": { "pr_summary": "…", "defects": [
    { "id": "D1", "title": "…", "statement": "mechanism and consequence",
      "sites": [{ "path": "…", "from_line": 10, "to_line": 12, "role": "cause|symptom|other-site" }],
      "kind": "bug|security|data|build|contract|performance|concurrency|resource|compat|incomplete-fix|maintainability",
      "severity": "high|medium|low", "evidence": "file:line + quoted code",
      "notes": "what a finding must say to count; near-misses that must not",
      "provenance": { "dataset_refs": [0, 3], "hunt": true, "reviewer_comments": ["R4"] },
      "benchmark_limitation": "optional, not scored: why a read-only review can only find it by knowing the repo's CI",
      "bot_derived_reference": { "bots": ["GitHub Copilot"], "dataset_refs": [0],
        "references": ["path:from-to:<sha1 of the note, 12 hex>"], "hunt": true, "note": "…" } } ] } } }
```

Two optional fields are annotations and are **never scored**: the judge prompt
is built from the named fields above (`src/bench/defects.ts` `parseDefectSet`
keeps only those, plus `provenance`, which the prompt never shows), so adding
or changing either does not change the truth and does not bump `version`.

- `benchmark_limitation` — a CI-gate defect (`compare.py` reports it on its own
  line as well).
- `bot_derived_reference` — the AACR reference this defect cites is a reworded
  comment an AI review bot wrote on the original PR (2026-09-30).
  AACR labels such references human (`is_ai_comment: false`). 19 of the 520
  defects carry it; 17 of them were also found by the blind hunt, and all were
  checked against the code, so the defect stands. `dataset_refs` is in the
  form the defect's own provenance uses (an index, or `R<n>` in rest145);
  `references` uses the key `reference_index.py` writes, and the full list of the ≥80 bot-derived
  references is `../bot_references.json`.

**How it was built (version 1).** Per PR: a blind expert hunt from the diff and
the code alone; then every candidate — the hunt, the AACR references (agent-produced
reference labels attached, trusted for nothing), and every comment any reviewer posted in
our runs (ours and open-code-review's, anonymised) — checked against the code,
merged where it is one defect, graded, and every exclusion recorded with its
reason; then an adversarial critic per set spot-checked inclusions, exclusions
and merges against the code. Pre-existing problems the PR does not touch,
unreachable scenarios, style, test and doc requests are not defects.

**Severity.** high — would block a merge (user-visible bug on a normal path,
crash, data loss, security hole, broken build/install); medium — should be
fixed before merge; low — real, fine as a follow-up. Recall is also reported
weighted high 3 / medium 2 / low 1.

**Changing it.** A judged comment the judge calls a correct, valuable NEW defect
is only a candidate (listed in each report). Add it after checking it against
the code, bump `version`, and re-judge: verdicts are stored per version, so old
and new truths never mix.

Run it: `bench/aacr/bench.sh judge --run <id> --set <set>` (any run dir, either
arm, archived runs too — `QCR_BENCH_RUNS_DIR`), `judge-report` to re-score.
