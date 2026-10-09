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

Every later re-review round is a **follow-up round** (a staleness round never is: it keeps `round-staleness.md` and no scope) (`order.scope = "delta"`, template `prompts/round-follow-up.md`):

1. **Verify prior findings.** The daemon renders the open findings posted in earlier rounds (`{{prior_findings_note}}`, `src/priorfindings.ts`).
   - Each one is verified mechanically at the new head: `fixed`, `open`, `conceded`, `settled`, `obsolete` or `unverifiable` (which keeps it open).
   - The list covers every verdicted earlier round, and every unverdicted one that may have posted (a posting outcome or review id on its row, or the reviewed-head mark at its head with no verdicted round there). A round whose record cannot be read makes the list INCOMPLETE, never shorter.
   - The statuses go back in the findings record's top-level `prior` array, so the next round's list shrinks.
2. **Review the delta.** The PR-owned change since the last reviewed head (`{{delta_note}}`).
   - It is computed by `WorktreeManager.prOwnedDelta`: the old head is replayed onto the new merge base with `git merge-tree`, so base merges cancel out and rebases work.
   - The plan is built from the delta's files, with intent text arms off. The tier is still chosen from the whole PR, so a small fix push keeps the PR's tier.
   - `pass-baseline` is always planned. It carries every prior finding no other planned lens owns.
   - When the whole PR trips the migration gate, the full plan's `pass-data-safety` row rides the delta plan even if no migration is in the delta: the gate note and a degraded pre-check name that lens. It takes its launch-order place, as every row does (slowest first, `slowestFirst` in dispatch.ts).
   - A delta of at most `follow_up_small_delta_lines` (150) lines gets the **lean plan** (`leanFollowUpPlan`): no per-file `pass-sweep` rows, because pass-baseline reads a small change whole, and the quality and style lenses moved to the addable list instead of planned. They judged the PR in round 1, and on a fix push they mostly re-raise nits. No lens leaves the round: the session adds one when the change shows its shape. In the 2026-10-09 replays, a follow-up round's time tracked its agent count, and 138-line deltas were fanning out to 15–20 agents.
   - Each delta-plan task file (`[review] task_files`) carries the change since the last review as the lens's review scope — its files, ranges and patch — with the whole PR as context; the session hands each lens its assigned prior findings through `launch_plan`'s `extra`, keyed by row, and an early sweep's task dir rides the same `launch_plan` call.
3. **Validate new candidates only.** When there are none, the validator is not run (the summary says so); prior-finding statuses never go to it.
4. **Pre-approval sweep.** The order carries a sweep plan (`{{sweep_note}}`) when the sweep is owed, and says when it starts (`sweep_start`, `sweepStartOf`):
   - **Early**: the prior-findings list is complete and every open prior blocker sits in a file the change touched, so the round will likely approve. The sweep's rows launch in the same turn as the delta's, and ONE validator takes both candidate sets. Its survivors post whatever the decision, and it counts as a full look. This replaces the serial chain of delta review, validator, sweep, validator.
   - **Late** (otherwise; unknown is late): as before. The sweep runs only when steps 1–4 lead to APPROVE (approval withheld for CI counts): the full round-1-style plan over the whole PR, then one validator over its candidates, then the decision.
   - The sweep is owed when the standing verdict is not APPROVE (an approval withheld for CI does not count as one: GitHub never saw it) and no full look has happened since the first round. A full look is a legacy full re-review, a full-scope re-review round, or a round whose sweep ran — never a staleness round.
   - The sweep note lists the full plan's files left over the per-round sweep cap, as round 1 does.
   - After a posted approval it is owed only when the PR-owned change since then reaches `follow_up_post_approval_sweep_lines` (500), whatever full looks came before. A smaller push after an approval is delta-only. In the live data, the blockers that post-approval re-reviews found outside the change sat behind 618–1204-line pushes; 47 of the 69 post-approval rounds changed fewer than 500 lines. Three tiny pushes (19–36 lines) on large PRs also drew such blockers; the floor deliberately does not chase those.
5. **Decide, post, verdict.** Unchanged fences. The verdict carries `"sweep": "ran" | "not_owed" | "not_reached"`, and each pass entry carries `"phase": "delta" | "sweep"`. An APPROVE claiming `not_reached` or `not_owed` beside an owed sweep is a contradiction, recorded `unknown`.

## Fallback to a full round (today's re-review, unchanged template)

The round falls back on every uncertainty. Each fallback logs `followup_full_round {reason}`:
- `[review] follow_up = "full"`.
- No reviewed-head mark.
- The old head is missing (after a re-fetch).
- The base was rewound — the base tip check, and the merge base the reviewed head's round recorded (`rounds.merge_base`) no longer under this round's.
- merge-tree or diff failed.
- The delta is above `follow_up_max_delta_ratio` (default 0.6) of the PR's diff lines.
- No adapter support (stub wiring, bench without a case).
- `prOwnedDelta` threw (`delta-threw`).
- A profile switched `pass-baseline` off, so no lens could carry the prior findings (`baseline-unplanned`).
- The delta patch file could not be written (`patch-write-failed`).

A full round counts as a full look.

## Knobs (`[review]`)

| Knob | Default | Effect |
|---|---|---|
| `follow_up` | `"delta"` | `"full"` restores the old behaviour byte-for-byte |
| `follow_up_max_delta_ratio` | 0.6 | Above this share of the PR's diff lines, the round falls back to a full re-review |
| `follow_up_sweep` | true | false never plans the pre-approval sweep |
| `follow_up_small_delta_lines` | 150 | A delta of at most this many lines gets the lean plan; 0 never |
| `follow_up_post_approval_sweep_lines` | 500 | After a posted approval, the sweep is owed only from this many changed lines; 0 never owes it |

## State

`rounds` gains these columns:
- `head_sha`, `merge_base`, `scope` (`full|delta`) and `delta_base_sha`;
- `delta_lines`, `delta_files` and `sweep_owed` (0/1);
- `sweep_plan` (JSON) and `sweep_status` (`ran|not_owed|not_reached|unknown`).

A new table, `prior_finding_checks`, holds the daemon's listings (each prior finding a round was handed: status NULL, `listed_at`) and the session-reported statuses.

The stage supervisor gives a sweep-owed round `[daemon] follow_up_sweep_extra_min` (20) more for passes and for the hard cap. Sweep lenses count as planned only when the sweep ran.

An APPROVE with the sweep owed but not run is the quiet `followup_sweep_skipped` anomaly.

## Validation

The bench gets a follow-up replay case kind (`src/bench/followup.ts`). It replays real round pairs of the reviewed repo from a local mirror of the VM's base clone, and the live full re-review of the same pair is the baseline. See for the 40-run validation (2026-10-09). Delta-only rounds were about 40% cheaper and 1.5–3× faster than a full re-review; rounds that ran the sweep cost about the same as one and took a little longer.
- A case carries `followup`: the previous head, the round and review numbers, whether the sweep was owed, the open prior findings and the ledger. A case whose previous round was a posted approval may say `prev_approved: true`; the replay then decides the sweep by production's size rule instead of the recorded answer. Its id names the round (`<owner>__<name>-<pr>-r<k>@<head7>`).
- Prefetch stores base, previous head and head, deepened until every merge-base the replay needs is verified; `QCR_BENCH_MIRROR_ONLY=1` (or `QCR_BENCH_PREFETCH_OFFLINE=1`, no network at all) never asks the network for anything.
- The delta is production's `prOwnedDelta` over the replay tree, and the order is built by dispatch's own `planFollowUp`, `renderDeltaPatch`, `roundDeltaOf` and `sweepOrderOf`, with the prior findings through `computePriorFindings`. Every doubt runs the full re-review, and the case summary says why. `[review] follow_up = "full"` is the baseline arm on the same cases.
- Private sets live outside the image: `QCR_BENCH_PRIVATE_SETS` is mounted read-only for the containers, under the explicitly unpinned `private-unpinned` pin, which scores nothing. A set carries a round's inputs only, never its outcome.
- Every case writes `stages.json` (each subagent call, its phase guessed from launch order around the first validator, its window, usage and cost), with the per-phase totals in `case-summary.json`. A follow-up case's summary also keeps each executed pass's reported `phase` and the sweep claim, read through production's `sweepStatusOf` (`follow_up.sweep.skipped` is production's `followup_sweep_skipped`).
