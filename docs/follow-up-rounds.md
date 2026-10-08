# Follow-up rounds: delta review, prior-finding verification, one pre-approval sweep

## Why

Every round after round 1 used to be a full re-review of the whole PR diff (`prompts/round-re-review.md`).
Live data (2026-09-15 → 2026-10-08) shows the cost of that:
- Re-reviews were 69% of spend.
- They ran 25 plan rows at the median, against 15 for first rounds.
- They took 12.5–15.5 min at p50, so a nit fix cost a 20-minute round.

At the same time, the PR-owned change between rounds is a median of 138 lines, 10% of the PR. 73% of the new findings raised in later rounds sit inside that change. The rest sit outside it, and they are real: authors fixed most of them. That is the case for one whole-PR sweep before an approval, instead of a whole-PR review every round.

## Shape

Round 1 is unchanged and byte-identical.

Every later round is a **follow-up round** (`order.scope = "delta"`, template `prompts/round-follow-up.md`):

1. **Verify prior findings.** The daemon renders the open findings posted in earlier rounds (`{{prior_findings_note}}`, `src/priorfindings.ts`).
   - Each one is verified mechanically at the new head: `fixed`, `open`, `conceded`, `settled` or `obsolete`.
   - The statuses go back in the findings record's top-level `prior` array, so the next round's list shrinks.
2. **Review the delta.** The PR-owned change since the last reviewed head (`{{delta_note}}`).
   - It is computed by `WorktreeManager.prOwnedDelta`: the old head is replayed onto the new merge base with `git merge-tree`, so base merges cancel out and rebases work.
   - The plan is built from the delta's files, with intent text arms off. The tier is still chosen from the whole PR, so a small fix push keeps the PR's tier.
   - `pass-baseline` is always planned. It carries every prior finding no other planned lens owns.
3. **Validate new candidates only.**
4. **Pre-approval sweep.** It runs only when the round would APPROVE (approval withheld for CI counts) AND the order carries a sweep plan (`{{sweep_note}}`). The full round-1-style plan runs over the whole PR, then one validator over its candidates, then the decision.
   - The sweep is owed when the standing verdict is not APPROVE and no full look has happened since the first round. A full look is a legacy full re-review, a full-scope round, or a round whose sweep ran.
   - It is never owed after an approval: a re-request after an approval is delta-only.
5. **Decide, post, verdict.** Unchanged fences. The verdict carries `"sweep": "ran" | "not_owed" | "not_reached"`, and each pass entry carries `"phase": "delta" | "sweep"`.

## Fallback to a full round (today's re-review, unchanged template)

The round falls back on every uncertainty. Each fallback logs `followup_full_round {reason}`:
- `[review] follow_up = "full"`.
- No reviewed-head mark.
- The old head is missing (after a re-fetch).
- The base was rewound.
- merge-tree or diff failed.
- The delta is above `follow_up_max_delta_ratio` (default 0.6) of the PR's diff lines.
- No adapter support (stub wiring, bench without a case).

A full round counts as a full look.

## Knobs (`[review]`)

| Knob | Default | Effect |
|---|---|---|
| `follow_up` | `"delta"` | `"full"` restores the old behaviour byte-for-byte |
| `follow_up_max_delta_ratio` | 0.6 | Above this share of the PR's diff lines, the round falls back to a full re-review |
| `follow_up_sweep` | true | false never plans the pre-approval sweep |

## State

`rounds` gains these columns:
- `head_sha`, `scope` (`full|delta`) and `delta_base_sha`;
- `delta_lines`, `delta_files` and `sweep_owed` (0/1);
- `sweep_plan` (JSON) and `sweep_status` (`ran|not_owed|not_reached|unknown`).

A new table, `prior_finding_checks`, holds the session-reported statuses.

The stage supervisor gives a sweep-owed round `[daemon] follow_up_sweep_extra_min` (20) more for passes and for the hard cap. Sweep lenses count as planned only when the sweep ran.

An APPROVE with the sweep owed but not run is the quiet `followup_sweep_skipped` anomaly.

## Validation

The bench gets a follow-up replay case kind (`src/bench/followup.ts`). It replays real round pairs of the reviewed repo from a local mirror of the VM's base clone, and the live full re-review of the same pair is the baseline. See.
- A case carries `followup`: the previous head, the round and review numbers, whether the sweep was owed, the open prior findings and the ledger. Its id names the round (`<owner>__<name>-<pr>-r<k>@<head7>`).
- Prefetch stores base, previous head and head, deepened until every merge-base the replay needs is verified; `QCR_BENCH_MIRROR_ONLY=1` (or `QCR_BENCH_PREFETCH_OFFLINE=1`, no network at all) never asks the network for anything.
- The delta is production's `prOwnedDelta` over the replay tree, and the order is built by dispatch's own `planFollowUp`, `renderDeltaPatch`, `roundDeltaOf` and `sweepOrderOf`, with the prior findings through `computePriorFindings`. Every doubt runs the full re-review, and the case summary says why. `[review] follow_up = "full"` is the baseline arm on the same cases.
- Private sets live outside the image: `QCR_BENCH_PRIVATE_SETS` is mounted read-only for the containers, under the explicitly unpinned `private-unpinned` pin, which scores nothing. A set carries a round's inputs only, never its outcome.
- Every case writes `stages.json` (each subagent call, its phase guessed from launch order around the first validator, its window, usage and cost), with the per-phase totals in `case-summary.json`.
