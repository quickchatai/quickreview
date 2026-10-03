# Duplicate merge: one comment per root cause

Ratified by the owner on 2026-10-03, after a design grilling session. Built behind
`[review] dedup_merge` (on by default).

## Why

The 2026-10-03 mining of two external runs (`bench/aacr/ext/REVIEW-MINING.md`)
found two separate costs that both get called "duplicates":

1. **Duplicates that get posted.** About 10–11% of what we post repeats an issue
   already posted: Martian 11% of candidates, a SWE-PRBench redundancy of 0.11,
   10% of our unmatched Qodo comments. One root cause is posted at several sites,
   or two lenses' versions of one issue survive the merge. A reader pays for each.
2. **Rediscovery inside a round.** The lenses raise 666 findings that the session
   merges into 456 posted ones, so about 59% of all lens output re-finds something
   another lens already found. That is compute and wall time, not visible noise.
   It is also where our unique catches come from: lenses re-reading the same code
   from different angles.

## Decisions

| # | Question | Decision |
|---|---|---|
| 1 | Goal | Both: posted duplicates first (quality), then rediscovery cost (without losing unique catches) |
| 2 | One root cause at several sites | One comment, anchored at the cause line, the other sites listed in its body; no repeat inline copies |
| 3 | Who decides two findings are the same | Deterministic code forms candidate groups; the model (the validator) decides merge or split with the code in view; a deterministic post-check catches leftovers |
| 4 | Lens cost | Prune by unique yield, measured; overlap stays as corroboration |
| 5 | Where the merge runs | Before the validator |
| 6 | Grouping signals | Same file and close lines; shared named identifiers; same consequence; same fix target |
| 7 | "Same consequence" | Judged by the model, inside the validator (no extra call) |
| 8 | How many signals form a group | Any one signal; the validator splits what is not one root cause |
| 9 | What a merged comment keeps | Max severity of the group, the best-evidenced body, all sites listed, the lens count (corroboration) |
| 10 | Unique yield | Unique (raised by no other lens in the case) AND real (matches the benchmark's key / golden / ground truth) |
| 11 | Measurement | One approved run of 20 PRs, 5 from each benchmark (AACR, Martian tune20, Qodo, SWE-PRBench), picked where our stored runs had the most duplicates; it also validates the round-5/6 fixes |
| 12 | Scope | Live and bench, through the same code path; the knob defaults on |

## Mechanism

**The bench must match a live round 1 exactly.** So every deterministic step
lives where both routes run the same code:

- **The clustering** is a pi tool, `cluster_findings`, registered by
  `extensions/finding-clusters.ts`. Both the daemon's PR sessions
  (`SessionManager.extensionPaths`) and the bench session (`src/bench/runner.ts`)
  load it, and it calls `clusterFindings` in `src/dedup.ts`.
- **The round templates** (rendered by both routes) carry `{{dedup_note}}` in step
  3 when the knob is on. The session calls the tool once with every candidate
  from every lens, and hands the returned groups to `pass-validate`.
- **The validator rule** `dedup-group-validate` is a `PASS_ADDENDA` entry on
  `pass-validate`, composed only when the knob is on. It judges each group as one
  unit:
  - one root cause (one fix removes all of it): merge into ONE finding with the
    group's max severity, the best-evidenced body, every site listed, and the
    lens count;
  - otherwise split, each part judged alone;
  - merged-away members are recorded `merged` with `group` and `merged_into`.
- **The post-check** lives in `renderReviewFromRecord` (`src/reviewrender.ts`).
  That is the one function both routes render the posted review through: the live
  route via `scripts/render-review.sh` → `src/reviewrendercli.ts`, the bench via
  `src/bench/runner.ts`. Two posted findings in the same file whose anchors
  overlap (±3 lines) and that share a named identifier are merged by rule:
  - the higher severity leads;
  - the follower is listed as an extra site;
  - the record marks it `merged` with `word: post-check`.

  `tests/dedup-parity.test.ts` pins that both routes produce the same posted set
  from the same findings record.
- **Posting.** The default profile sets `[posting] repeat_sites = false`, so
  follower rows of one root cause are withheld (`repeat-site`) wherever the
  policy is applied.

### The grouping rule (`src/dedup.ts`)

Union-find over the candidates. Two candidates join a group when ANY of these holds:

- **Same file and close lines.** The same path, with anchors within 10 lines.
- **Shared identifier.** Both name the same code identifier in a code span
  (backticks): at least 3 characters, not a common word, not a file path.
- **Same fix target.** Both name the same `fix_target` (`path:line` or a symbol).

"Same consequence" has no deterministic signal. The validator judges it inside a
group, and two findings that share no signal are never shown to it as one group.
Group ids are stable, so a re-run gives the same groups.

## Knobs

- `[review] dedup_merge = true` (default). With it `false`:
  - no tool note in the round order;
  - no validator rule;
  - no post-check.

  The round order, the built agents and the rendered review are then
  byte-identical to before (pinned by a test).
- `[posting] repeat_sites` in the profile, now `false` in the default profile.

## Lens pruning (measured, not yet decided)

`bench/aacr/lens_yield.py` measures each lens over stored run dirs:

- raw findings;
- posted findings;
- unique findings (no other lens in the case raised the same root cause);
- unique AND real;
- the cost per unique real finding.

The baseline from the stored runs is in `bench/aacr/LENS-YIELD.md`. A lens is
narrowed (brief) before it is dropped, and dropping one needs the owner's
sign-off per lens.

## How it is measured

There is one run, approved by the owner, of 20 PRs. The selection and the
commands are in `bench/aacr/ext/DEDUP-RUN.md`. Compared against the stored
baseline runs on the same PRs:

- duplicates posted;
- comments per PR;
- each benchmark's own score on those PRs;
- per-lens yield;
- time and cost.
