# AACR-Bench for quickreviewd

This runs **our production reviewer** — the real `round-first.md` order, the
real `conversation-system.md` persona, the real lens and validator agents built
by `buildAgents` with `PASS_ADDENDA`, the production models and tiers from
`config.toml` — against [AACR-Bench](https://github.com/alibaba/aacr-bench)
(Alibaba's 200-PR, 10-language code-review benchmark), **locally, in a locked-down
Docker sandbox**, and scores the result with Alibaba's own harness, unmodified,
at a pinned commit. Nothing touches the live daemon, GitHub's write API or the
gate, and nothing runs on the VM.

Background and the fairness caveats: `docs/open-code-review-comparison.md`
(idea 3).

## Testing a review change (the defect benchmark loop)

The headline is the defect benchmark (`defects/`, `RESULTS.md`): did the review
find the real bugs, and is what it said true. One experiment = one image and
several ARMS that differ only in config levers:

```sh
export QCR_BENCH_RUNS_DIR=~/qcr-bench-runs/runs   # outside any worktree
QCR_BENCH_IMAGE=qcr-bench:exp bench/aacr/bench.sh build
QCR_BENCH_IMAGE=qcr-bench:exp bench/aacr/arm.sh --prefix low --config review.preset=low --cases fresh10+levers16
QCR_BENCH_IMAGE=qcr-bench:exp bench/aacr/arm.sh --prefix nosweep --config review.sweep=false --cases fresh10
bench/aacr/compare.py --cases fresh10 default=lean-fresh10 low=low-fresh10 nosweep=nosweep-fresh10
```

`arm.sh` reviews and judges (only the arm's own PRs, with one retry) with the
sets in parallel; `compare.py` scores arms on the same PRs from the archived
judge files, never calling a model.

**Comparing against open-code-review, on both metrics.** One command per arm,
the same flags, the same judges:

```sh
export QCR_BENCH_IMAGE=qcr-bench:exp QCR_BENCH_OCR_IMAGE=qcr-bench-ocr:exp   # both built from one commit
bench/aacr/arm.sh --prefix low --config review.preset=low --cases fresh10 --eval 3
bench/aacr/arm.sh --prefix default --cases fresh10 --eval 3
bench/aacr/arm.sh --prefix ocr --arm ocr --cases fresh10 --eval 3
bench/aacr/compare.py --cases fresh10 --aacr low=low-fresh10 default=default-fresh10 ocr=ocr-fresh10
```

What makes the rows comparable, and is enforced rather than assumed:
- **One defect judge.** Every arm, OCR included, is judged in the quickreviewd
  image (`$QCR_BENCH_IMAGE`) with the same model; `compare.py` reads one judge
  label. `--eval R` runs AACR-Bench's own metric with the codex judge
  (`JUDGE_CODEX_MODEL`, default `gpt-6-sol:low`) for every arm, and
  `compare.py --aacr` prints NOT COMPARABLE if the runs' `judge.txt` differ.
- **One denominator.** Every defect of every PR in `--cases` counts; a PR with
  no judgement, or an errored one, scores nothing and the row says
  INCOMPLETE (never a silently smaller denominator). A PR the review never
  reached (the run stopped early) is not judged at all.
- **One currency.** OCR does not run through pi; its bridge tokens are priced
  at pi's gpt-6-sol rates (`src/bench/cost.ts`), in `compare.py` too.
- **One build.** `compare.py` warns when arms carry different `qcr_commit`s;
  `<run>.arm.json` beside each run records the arm, image and image id.
- **What cannot be equal:** OCR gets no PR title/body, comments with line
  ranges, no severity (only the AACR `all` variant), and runs one case at a
  time while ours run `--concurrency` at once — compare minutes with that in
  mind.

`arm.sh` exits non-zero when any review, judge or eval failed; `--resume`
keeps cases already reviewed by the same build and levers; repeats run one
after another. `--cases full` reviews all 196 PRs and judges the 40 that have
ground truth against their own defect sets.

**Before a big run, check the PRs can still be fetched:**
`bench/aacr/check_available.py [--sets full] [--backups]` (anonymous git, no
API quota, about a minute for all 196). On 2026-09-27, 11 of the 196 `full`
PRs had a reviewed head that a force-push took away (the PR ref points
elsewhere now; no fetch can recover it): ComfyUI@4936d01, ComfyUI@cfc3122,
node@b225544, uv@ed57db2 (also a backup in smoke10/holdout10), ClickHouse@fd6ba0c,
ClickHouse@cc96255 and keycloak@1463502/2373a48/460f800/79dbba9/21d4538.
Their prefetch fails, their review is `failed` and their references count as
missed — for every arm alike, so arms stay comparable, but the absolute
recall on `full` is out of 185 runnable PRs' worth of findability. None of
the 40 defect-benchmark PRs is affected. Claim improvements on `fresh10`: the other
30 PRs informed the 2026-09 levers, and in-sample gains shrank by half out of
sample. Differences under ~2 defects per 10 PRs are noise.

## Quick start

```sh
bench/aacr/bench.sh doctor                         # docker, image, volumes
bench/aacr/bench.sh smoke --run first-try          # build → prefetch → review 10 PRs → score (mock judge)
bench/aacr/bench.sh eval --run first-try --judge codex   # re-score with a real LLM judge
less bench/aacr/runs/first-try/report.md
```

`smoke` takes about an hour or two for the 10 PRs (one production round each —
lens fan-out plus validator; measured live rounds run a median ~13 minutes).

## The case sets (`sets/`)

All are generated from the **pinned v1.0 dataset** (git `ab8af8d`, sha256
`d8683cb2…`, the revision every published leaderboard row is denominated in —
x/1505) by `select_cases.py`, which refuses any other revision:

| Set | PRs | References | Rule |
|---|---|---|---|
| `smoke10` | 10 | 62 | 20–160 changed lines, ≥4 references, quota Python 3 / TS 2 / JS 1 / Go 1 / Java 1 / Rust 1 / C 1, smallest first, one PR per repo; 17 backups |
| `holdout10` | 10 | 85 | smoke10's filters, no smoke10 repository, quota Python 1 / TS 2 / JS 2 / Go 1 / Java 2 / Rust 1 / C 1, a short language filled from the smallest remaining PR. The generalisation check: a change is kept only if it holds here too, and nothing is ever tuned on it |
| `dev10` | 10 | 106 | a second development set, so changes are not tuned on smoke10 alone: 20–400 changed lines (the small-PR pool is spent), ≥4 references, no smoke10 or holdout10 repository, quota C++ 2 / TS 1 / JS 1 / Go 1 / Java 1 / Rust 1 / C 1 / C# 1 / PHP 1 |
| `full` | 196 | 1,505 | every PR the harness scores (4 of the 200 have no positive references and are never scored by it) |

`--only id,id` narrows any command to named instances (backups included).

`<set>.labels.json` beside a set holds a hand-checked quality label for every
reference (real defect / real maintainability with a value, trivial, dubious,
duplicate), checked against the code at head. When it exists, `report` adds a
"Recall by reference quality" table: the benchmark's recall counts style and
dubious references the same as real defects, and the real-issue column is the
one that says whether the reviewer got better rather than merely noisier.

## The steps

| Step | Network | Writes | What it does |
|---|---|---|---|
| `build` | npm, github.com (image build) | the `qcr-bench` image | compiles this repo, installs pi 0.84.4, clones the harness at `68a5697`, extracts dataset v1.0 **and verifies its sha256**, converts it with the harness's own converter (196 instances) |
| `prefetch` | github.com, anonymous | volume `qcr-bench-repos` | per instance: a bare store with ONLY the PR's base and reviewed head, shallow, deepened until the merge-base resolves; PR title/body/base branch from the public API (60 req/h anonymous — pass `--wait-rate-limit` for `full`) |
| `review` | the model API | `runs/<id>/` | one production round per PR; `pi -p` exits when the round settles; one continuation if it stopped before writing its files; 45 min timeout per PR |
| `eval` | the judge's endpoint | `runs/<id>/` | the harness's `pipeline run --stage eval` three times — variants `all`, `no-nits`, `blockers` — then `report.md` |
| `results` | none | `runs/<id>/results/` | rebuild the scored files from the case dirs — no model calls; use after a harness change |
| `report` | none | `runs/<id>/report.md` | re-render the report |

Everything is resumable: `prefetch` reuses a verified store, `review --resume`
skips cases already `ok`.

## The safety model

Every container runs with `--read-only` root, `--cap-drop ALL`,
`no-new-privileges`, a non-root uid (yours), pids/memory/CPU caps, and tmpfs
or anonymous volumes for its scratch space. On this PC it can touch exactly:

- `bench/aacr/runs/<id>/` — read-write, the run's own output. `bench.sh` never
  writes inside it or follows anything in it (the docker-command log sits
  next to it, `runs/<id>.sandbox-commands.log`), and refuses a run dir that is
  itself a symlink, so nothing the sandbox plants there can redirect a host
  write;
- the `qcr-bench-repos` docker volume — read-only during review;
- **the pi login, READ-ONLY**: only the `agent/` directory of the companion's
  `companion-pihome` volume (override with `QCR_BENCH_AUTH_VOLUME`), with its
  `sessions/` hidden by an empty tmpfs.

**How the login is used.** Before every case the sandbox copies the current
access token into its own tmpfs agent dir with the **refresh token replaced by
a dummy** (`src/bench/auth.ts`). So it never writes anything the companion
reads (an injected review cannot plant `AGENTS.md`, skills or extensions for
the companion), and it never refreshes — a second refresher would rotate the
grant and log the companion out. The cost: a run cannot outlive the access
token (≈10 days when fresh). Each case checks the remaining life against its
budget first; if it is too short the run stops with an instruction — use the
companion once so it refreshes its own login, then `--resume`.

**Network.** `review` and `eval --judge codex|openai` have ordinary docker
bridge egress — the model and judge APIs need it; `prefetch` talks to
github.com; `eval --judge mock`, `results` and `report` run `--network none`.

What the image does NOT contain: `scripts/` (the posting route and
`mint-token.sh`), the `gh` CLI, any GitHub credential, the OpenViking server,
tmux. The review session is told it is offline and must not post — and the
environment makes posting impossible, not just forbidden. The reviewer can
read the (read-only) login, including its refresh token, exactly as a
production session can read its own pihome; the no-exec policy and
`bash-guard` apply as in production.

## What is production and what is not

| | Production | Here |
|---|---|---|
| Round order | `round-first.md` via `renderRoundPrompt` | same, plus an appended **BENCHMARK MODE** override (below) |
| Persona | `conversation-system.md` | same (identity `repo` = the benchmark repo) |
| Project context | the synced repo root: pi loads `AGENTS.md` | same file (the image ships `AGENTS.md` and `CLAUDE.md`, as the rsync does) |
| Pass plan | `buildRoundOrder` → `buildPassPlan` | same, from a real git file list (status, renames, hunks) |
| Agents | `buildAgents` + `PASS_ADDENDA` + profile addenda + same-day feedback addendum | same minus the feedback addendum; profile `""` (generic) by default, `--profile <name>` (the one `config.toml [review] profile` names) for production-as-deployed |
| Models | `config.toml [models]` | same file |
| Extensions | inject-bridge, ledger-pin, muted-theme, round-progress, subagents, openviking; bash-guard global | ledger-pin, subagents; bash-guard global |
| Memory | OpenViking, recall + turn sync | **off** — foreign repos must not read the reviewed repo's memory, and a session would write its turns into it |
| GitHub, CI, posting, verdict, ledger, deferrals | yes | replaced by the override: no CI gate (decide on the merits), write `comments.json` / `review.md` / `findings-record.json` / `outcome.json` instead of posting |
| Delivery | inject file into a tmux session | the order on `pi -p`'s stdin (no argv size limit); one `--continue` if the session stopped before its files — only when a session exists |
| Posting shape | `post-review.sh` keeps `path, line, side, body` | same four fields; any multi-line span is scored at its single `line` |

The one bias that cannot be removed without a reseed: the frozen
`pass-baseline` seed carries the deployed repo's pytest/Django Ninja conventions.

## Reading the numbers

- **Statuses.** `ok` = the round decided (APPROVE / REQUEST_CHANGES);
  `no-verdict` = it wrote its files but decided nothing (pass infrastructure
  failed); `no-output`, `timeout`, `failed` as named. Only `ok` is skipped by
  `--resume`, and only when the case was reviewed by the same build, profile
  and models (each `case-summary.json` carries that fingerprint).
- **The APPROVE path.** The bench tells the session CI does not apply, so a
  no-blocker round is an APPROVE, and its nits/questions are scored as the
  inline comments it composed. Production's green-CI approve route posts
  those as body bullets instead (its COMMENT path — red or pending CI — posts
  them inline). The report splits verdicts so this is visible.
- **Variants.** `all` = every inline comment that would have been posted;
  `no-nits` drops `[nit]`; `blockers` keeps only `[blocker]`. The references are
  42% maintainability/readability — a class the validator trims on purpose — so
  compare variants, not one headline.
- **Findings posted in the review body count.** Production sends a finding
  with no valid inline anchor (a deletion-only change, a notebook line) into
  the review body — "unanchorable → body". It is still a posted finding with a
  file and a line, so the result file carries it too (`source: body`), taken
  from the session's own findings record (`disposition: posted`) with the text
  the body gives it. The report's "In body" column counts them.
- **LEFT-side comments** are excluded (the harness forces every generated
  comment to the right side, so an old-side anchor could only score wrong);
  the count is in each result file's `qcr.excluded`.
- **A case that failed or timed out still gets a result file with zero
  comments**, so its references count against recall. The harness silently
  drops an instance with no file from both denominators; `eval` also refuses a
  number scored on fewer instances than the set has.
- **The judge.** `mock` is the harness's string similarity — plumbing only,
  the numbers mean nothing. `codex` runs the harness's exact judge prompt on a
  GPT model through the shared pi login (`judge_shim.py`; default
  `openai-codex/gpt-6-sol:low`, override with `JUDGE_CODEX_MODEL`) — a real
  semantic judge, but not the paper's, and noticeably noisy (the same pair
  judged yes/yes/no across three calls in testing), which is why real judges
  default to 3 averaged rounds. A judge call that FAILS is scored by the
  harness as a non-match; `eval` counts those, writes them into the report
  and exits non-zero, and refuses a score built on fewer instances than the
  set in any round. `openai` uses any OpenAI-compatible
  endpoint from `bench/aacr/judge.env` (gitignored):

  ```sh
  JUDGE_BASE_URL=https://openrouter.ai/api/v1
  JUDGE_API_KEY=…
  JUDGE_MODEL=qwen/qwen3-235b-a22b-2507     # the paper's judge
  ```

- **The published leaderboard is not directly comparable.** 13 of its 14 rows
  predate the public harness, and its judge, round count and line tolerance are
  undisclosed. For a like-for-like number, re-run a published baseline (e.g.
  open-code-review v1.3.1 + GPT-5.5: published 234/728 precision, 234/1505
  recall) under the same judge and dataset, next to ours — `--arm ocr` (below)
  does that. The harness's Claude Code arm must never be run from here (root
  rule 5).
- **The ground truth is 74% AI-seeded** (GPT-5.2 alone 25%, our model's family),
  and precision counts every comment the annotators did not record as a false
  positive.

## The open-code-review baseline arm (`--arm ocr`)

A reference point measured the same way as ours: open-code-review on the same
PRs, the same model our conversation runs, the same judge, rounds and
`--line-k`.

```sh
bench/aacr/bench.sh build  --arm ocr                                   # image qcr-bench-ocr
bench/aacr/bench.sh review --arm ocr --run ocr-1                       # one case at a time
bench/aacr/bench.sh eval   --arm ocr --run ocr-1 --judge codex --rounds 3
```

- **OCR runs as the harness runs it.** `src/bench/ocr.ts` mirrors
  `evaluation/reviewers/ocr.py` at the pinned harness commit flag for flag —
  `ocr review --from <base_commit> --to <head_commit> --format json --audience
  agent --concurrency 8 --timeout 30 --max-tools 30`, a process timeout of
  30×60+300 s — and writes that runner's result file, which the harness scores
  with its own OCR reader. OCR diffs merge-base..head itself. The repo is the
  same `prepareTree` checkout the quickreviewd arm gets (OCR reads code only
  through `git show/ls-tree/grep <head>` and that diff).
- **Version**: 1.3.1, the version most leaderboard rows ran, with its binary's
  sha256 pinned in the Dockerfile. It needs git ≥ 2.41, so the `ocr` target is
  the same runtime stage built on `node:22-trixie` (bookworm ships 2.39):
  same harness commit, dataset (its converted file is byte-identical), pi,
  openai client and judge shim — only the OS base and its Python differ.
- **The model** (`codex_bridge.py`): OCR 1.3.x speaks non-streaming Chat
  Completions; the only access to `gpt-6-sol` is the pi login's ChatGPT Codex
  backend, a streaming Responses endpoint. A loopback bridge inside the
  sandbox translates, streams, aggregates to `response.completed` and
  translates back. It forces `gpt-6-sol`, reasoning effort `medium`, text
  verbosity `medium` (the public API's defaults) and strict:false tools (the
  Chat Completions default); drops what the backend refuses (output caps,
  sampling knobs) and logs it; never carries reasoning across turns (neither
  does the public Chat Completions API). It reads the same refresh-disabled
  token copy as the review and the judge and refuses any other auth file.
  `runs/<id>/bridge.jsonl` has one row per model call (status, latency,
  served model, tool-call names, usage — never content).
- **What is not equal, and cannot be made equal by us:** OCR gets no PR title
  or description (the harness passes no `--background`); ours does, as in
  production. OCR's comments carry line RANGES and ours a single line, and the
  harness only asks the judge about a pair whose lines overlap within k — a
  range gets more candidate pairs. OCR comments have no severity, so only the
  `all` variant exists for this arm; compare it with our `all` row.

## The what-if lever scorer (`whatif`)

How would the score move if the reviewer POSTED more of what its lenses found?
`whatif` answers that from a finished run, with the same harness and judge,
without re-running a single review:

```sh
QCR_BENCH_IMAGE=qcr-bench-whatif:latest bench/aacr/bench.sh build        # only when src/bench changed
QCR_BENCH_IMAGE=qcr-bench-whatif:latest bench/aacr/bench.sh whatif \
    --run smoke10-2 --from bench/aacr/runs/smoke10-2 --judge codex --rounds 3
less bench/aacr/whatif/smoke10-2/report.md
```

It copies the run's case files and scored `results/all` into a fresh
`whatif/<id>/source/` (regular files only — nothing the review sandbox wrote is
followed), then, inside the sandbox, reads every lens pass's own findings block
out of `pi-events.jsonl` (the `subagent` tool's results; the validator is not a
lens) and links each `findings-record.json` row back to the lens candidate it
came from (same lens, same file, nearest line; else the same lens's words), so
a dropped row is scored with the LENS'S claim — never with its record
`reason`, which for a killed or merged row says why it was dropped. Four
variants, scored exactly like `eval`:

| Variant | What it scores |
|---|---|
| `posted` | the run's own `results/all`, byte-for-byte — the control; it must land within judge noise of the run's own score |
| `posted+killed` | + every candidate the validator KILLED, as its lens's claim |
| `posted+merged` | + every MERGED / FOLDED candidate, as its own comment |
| `all-candidates` | every raw lens candidate alone, deduplicated only on identical path, line and claim |

The extra comments follow `toOcrResult`'s rules: single-line anchors at the
lens's own line, LEFT side excluded, and no comment without a line (the
harness skips its line gate for one — a free pass against every reference in
the file); a lens that gave no line borrows the line the session's record gave
the same finding. Posted comments stay first and in order in every posted+
variant, so a reference the control matched and a posted+ variant lost is pure
judge noise. `report.md` lists, per variant, every reference matched in more
rounds than by the control — the reference text beside OUR text the judge
matched it to, and where ours came from (killed/merged/candidate, lens,
severity) — and every reference matched in fewer. `extract/<case>.json` holds
every raw candidate, every record link and every extra comment.

## Running the whole benchmark later

```sh
bench/aacr/bench.sh build
bench/aacr/bench.sh prefetch --set full --wait-rate-limit        # ~196 API calls → waits out the anonymous limit
bench/aacr/bench.sh review   --run full-1 --set full --concurrency 2 --resume   # ~45 h serial; resumable
bench/aacr/bench.sh eval     --run full-1 --set full --judge openai --rounds 3
```

Concurrency multiplies model load on the shared ChatGPT login (each round fans
out up to 6 lens children); start at 1–2.

## Files

| Path | What |
|---|---|
| `bench.sh` | host side: builds the image, wires mounts, hardens every container |
| `Dockerfile` | the sandbox image (build context assembled from an explicit allowlist) |
| `in-container.sh` | the image's entrypoint (dispatch + the eval loop) |
| `select_cases.py` | deterministic set selection from the pinned dataset |
| `arm.sh` / `compare.py` | one arm end to end (review → defect judge → optional AACR eval); the comparison table |
| `check_available.py` | can every PR's base and head still be fetched from github.com |
| `sets/*.json` | the committed case sets |
| `judge_shim.py` | OpenAI-compatible judge endpoint over `pi -p` |
| `codex_bridge.py` | the OCR arm's loopback Chat Completions/Responses → Codex backend bridge |
| `src/bench/` | prefetch, review runner, result conversion, report, the OCR arm (`ocr.ts`) (`tests/bench-aacr.test.ts`); the what-if scorer `whatif.ts` + `whatifrun.ts` (`tests/bench-whatif.test.ts`) |
| `whatif/<id>/` | per what-if run: `source/` (the copied run), `results/<variant>/`, `extract/`, `eval/`, `report.md`, `whatif-summary.json` |
| `runs/<id>/` | per run: `run.json`, `cases/<id>/` (system prompt, round order, files, pi event stream, the session's four files, `case-summary.json`), `results/<variant>/` (the harness's input + metrics), `eval/`, `report.md`, `sandbox-commands.log` (every docker invocation, for reproduction) |
