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

## Results

![Code review benchmark — overview](charts/overview.jpg)

The whole benchmark: 185 runnable PRs, 520 real defects and 1,418 AACR
references, with seven reviewers. The reviewers are:

- quickreviewd `default` and `low`;
- open-code-review;
- Codex CLI;
- OpenCode;
- pi-review;
- Claude Code.

Every review was scored by two defect judges (gpt-6-sol high and Claude
Opus 5.5). The two come from different model families and give the same
verdict on 98.7% of reviewer-defect pairs, so the grading does not depend on
which family judges; the answer key rests on its own verification. Numbers,
method and caveats are in
[`FULL-BENCHMARK.md`](FULL-BENCHMARK.md); how to read the two metrics is in
[`METRICS.md`](METRICS.md). Charts, all in `charts/`:

| Chart | Shows |
|---|---|
| [`overview.jpg`](charts/overview.jpg) | defects found, high-severity caught, AACR recall — the one-image summary |
| [`defects-by-severity.jpg`](charts/defects-by-severity.jpg) | real defects found, split high / medium / low |
| [`high-severity.jpg`](charts/high-severity.jpg) | merge-blocking defects caught, of 90 |
| [`cost-vs-coverage.jpg`](charts/cost-vs-coverage.jpg) | $ per PR against share of defects found |
| [`two-scores.jpg`](charts/two-scores.jpg) | the same reviews on our judge vs AACR's metric |
| [`reference-quality.jpg`](charts/reference-quality.jpg) | what AACR's reference comments are, hand-checked against the code |
| [`tuned-vs-unseen.jpg`](charts/tuned-vs-unseen.jpg) | the 40 tuning PRs vs the 145 never-seen ones |
| [`judge-agreement.jpg`](charts/judge-agreement.jpg) | share of defects found under each of the two judges (gpt-6-sol high, Claude Opus 5.5) |
| [`independent-defects.jpg`](charts/independent-defects.jpg) | share found on all 520 defects vs on the 369 the code hunt or an AACR reference raised (in the key without any reviewer's comment) |

`numbers.json` holds the headline figures behind the charts.

Regenerate after a run. Every number comes from the judge and harness files
through `compare.py`'s scoring, and adding a reviewer is one more
`NAME=runs`. The runs directory is `$QCR_BENCH_RUNS_DIR`, defaulting to
`~/qcr-bench-runs/runs` when it exists.
`--second-judge` adds the agreement chart:

```sh
uv run bench/aacr/charts.py --cases all30+fresh10+rest145 --second-judge claude-opus-5-5 \
  "quickreviewd default=b40-smoke10,b40-dev10,b40-holdout10,b40-fresh10,all-default-rest145" \
  "quickreviewd low=all-low-smoke10,all-low-dev10,all-low-holdout10,all-low-fresh10,all-low-rest145" \
  "open-code-review=b40ocr-smoke10,b40ocr-dev10,b40ocr-holdout10,b40ocr-fresh10,all-ocr-rest145" \
  "Codex CLI=all-codex-smoke10,all-codex-dev10,all-codex-holdout10,all-codex-fresh10,all-codex-rest145,all-codex-c1-rest145,all-codex-c2-rest145,all-codex-c3-rest145,all-codex-c4-rest145" \
  "OpenCode=all-opencode-smoke10,all-opencode-dev10,all-opencode-holdout10,all-opencode-fresh10,all-opencode-rest145,all-opencode-c1-rest145,all-opencode-c2-rest145,all-opencode-c3-rest145,all-opencode-c4-rest145" \
  "pi-review=all-pireview-smoke10,all-pireview-dev10,all-pireview-holdout10,all-pireview-fresh10,all-pireview-c1-rest145,all-pireview-c2-rest145,all-pireview-c3-rest145,all-pireview-c4-rest145" \
  "Claude Code (Opus 5.5)=all-claude-smoke10,all-claude-dev10,all-claude-holdout10,all-claude-fresh10,all-claude-c1-rest145,all-claude-c2-rest145,all-claude-c3-rest145,all-claude-c4-rest145"
```

The same `NAME=runs` arguments work for `compare.py`, which prints both
tables. Add `--judge-model claude-opus-5-5` for the second judge.

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

`arm.sh` reviews and judges (only the arm's own PRs, with one retry) from ONE
machine-wide queue — every case in its own container, `--parallel` at once
(see "Running the whole benchmark" for the scheduler); `compare.py` scores
arms on the same PRs from the archived judge files, never calling a model.

**Comparing against open-code-review, on both metrics.** One command per arm,
the same flags, the same judges:

```sh
export QCR_BENCH_IMAGE=qcr-bench:exp QCR_BENCH_OCR_IMAGE=qcr-bench-ocr:exp   # both built from one commit
bench/aacr/arm.sh --prefix low --config review.preset=low --cases fresh10 --eval 3
bench/aacr/arm.sh --prefix default --cases fresh10 --eval 3
bench/aacr/arm.sh --prefix ocr --arm ocr --cases fresh10 --eval 3
bench/aacr/compare.py --cases fresh10 low=low-fresh10 default=default-fresh10 ocr=ocr-fresh10
```

`compare.py` prints two tables, both led by the number of problems found:
the defect benchmark (found / recall / high / medium / low / weighted /
comments correct / cost / time) and AACR-Bench's own (references found /
recall / precision / F1, then recall by the benchmark's own labels — code
defect, maintainability, performance, security; diff / file / repo level —
from `references.json`, built by `reference_index.py` from the pinned
dataset). The benchmark's references carry no severity, so its table has no
high/medium/low; its categories are the counterpart.

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
  time while ours run `--parallel` at once — compare minutes with that in
  mind (the per-case minutes are each case's own wall clock either way).

`arm.sh` exits non-zero when any review, judge or eval failed; `--resume`
keeps cases already reviewed by the same build and levers and re-runs only the
rest; an arm whose run dirs already exist refuses to start without `--resume`
or `--fresh`, so a relaunch never wipes hours of reviews. Repeats share the
queue with everything else. `--cases full` reviews all 196 PRs and judges the 40 that have
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
| `eval` | the judge's endpoint | `runs/<id>/` | the harness's `pipeline run --stage eval` once per variant — `all`, `no-nits`, `blockers`, side by side (`--variants` narrows them) — and with `--shards N` split by PR into N harness processes each, merged by `eval_shards.py` into the files one process writes; then `report.md` |
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

The seeds carry no reviewed repo's stack since the reseed: the
pytest/Django Ninja, Tailwind and MySQL rules `pass-baseline`, `pass-ui` and
`pass-data-safety` used to carry ride the deployed repo's own profile addenda,
so a bench run picks them up only when its `--config` selects that profile.

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
  does that. The harness's Claude Code arm runs only as `--arm claude`, inside this sandbox (root rule 5's one ratified exception, 2026-09-28).
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

## The Codex CLI arm (`--arm codex`)

Codex CLI on the same PRs, the same model (`gpt-6-sol`) through the same
ChatGPT login, judged by the same judges — run by the AACR harness's OWN
Codex runner.

```sh
export QCR_BENCH_RUNS_DIR=~/qcr-bench-runs/runs
bench/aacr/bench.sh build  --arm codex                                   # image qcr-bench-codex
bench/aacr/bench.sh review --arm codex --run codex-1 --set fresh10      # one case at a time
bench/aacr/bench.sh judge  --run codex-1 --set fresh10                  # the defect benchmark (quickreviewd image)
bench/aacr/bench.sh eval   --arm codex --run codex-1 --set fresh10 --judge codex --rounds 3
bench/aacr/arm.sh --prefix codex --arm codex --cases fresh10 --eval 3   # all of the above, per set
bench/aacr/compare.py --cases fresh10 default=default-fresh10 codex=codex-fresh10
```

- **Codex runs as the harness runs it.** `bench/aacr/codex_arm.py` imports
  `evaluation/reviewers/codex.py` at the pinned harness commit and calls its
  `review_instance`: the prompt (`/review <base>...<head> (<report-tool
  instructions>)`), the argv (`codex --sandbox workspace-write exec review
  --json --skip-git-repo-check <prompt>`), the process timeout (30×60+60 s),
  the temporary CODEX_HOME + `config.toml` with the harness's `findings` MCP
  server (`mcp_codex_finding_server.py`, auto-approved), the two-channel
  finding collection (MCP partial file vs. the final JSONL message, more wins,
  tie → MCP), the token accounting and the result file are the harness's code.
  `case-dir/codex-driver.json` records the argv that actually ran;
  `codex-sessions/` keeps Codex's rollouts; `codex-config.toml` the config.
- **The login cannot refresh.** Codex gets its native ChatGPT `auth.json`
  built from the sandbox's refresh-disabled pi copy (`src/bench/auth.ts`):
  the access token and account id, the refresh token = the disabled sentinel,
  `last_refresh` = now. The real refresh token never reaches Codex; any
  refresh attempt is additionally pointed at a closed loopback port
  (`CODEX_REFRESH_TOKEN_URL_OVERRIDE`); both the TS side and the driver
  refuse a source whose refresh token is not the sentinel, and the driver
  refuses to start with an API key, a gateway or a CODEX_HOME in its
  environment (`tests/bench-codex.test.ts`). The temporary CODEX_HOME,
  auth.json included, is removed after every case.
- **Version**: `@openai/codex` 0.158.0, the linux-x64 binary's sha256 pinned
  (Dockerfile target `codex`, built on the same `runtime` stage — same harness,
  dataset, pi and judge shim). **To bump:** set `CODEX_VERSION` and
  `CODEX_SHA256_LINUX_X64` in the Dockerfile (`sha256sum` of
  `@openai/codex-linux-x64/vendor/x86_64-unknown-linux-musl/bin/codex` after
  `npm install -g @openai/codex@<v>`), `bench.sh build --arm codex`, and run a
  2-PR smoke before a full run; the fingerprint (`codex_version`) keeps
  `--resume` from mixing versions.
- **The result file** is the harness's `save_result` payload, untouched, plus
  `review` (an OCR-shaped view of the same comments: `summary + "\n" +
  description` at `file:start_line-end_line`) and `bench`. The view exists so
  the rest of this bench — the eval (`pipeline --reviewer ocr`), the defect
  judge, compare.py, the what-if tools — reads the file unchanged; every case
  is checked by the harness's own two readers (`build_target_comments_from_codex`
  on `review_output` and `build_target_comments_from_ocr` on `review` must
  agree, or the case fails). Findings carry a severity, which the harness
  ignores, so only the `all` variant exists for this arm.

**What differs from the harness's own run, and why:**
- **The repo** is `prepareTree`'s checkout (objects from the prefetched store,
  detached head, one base ref), not a fresh clone: the sandbox reviews offline.
  Same base, head and merge-base; `git clean -fdx` after, as the harness does.
- **The login** is ChatGPT auth, not `CODEX_API_KEY` / a gateway: the harness
  supports only an API key, and the benchmark's only access to `gpt-6-sol` is
  the shared ChatGPT login. The backend is the ChatGPT Codex endpoint Codex
  itself uses for that login.
- **A config prelude** (top-level keys placed before the harness's lines):
  `model_reasoning_effort = "medium"` (the harness pins none; `medium` is the
  effort every arm uses; `QCR_BENCH_CODEX_EFFORT` overrides), file-only
  credentials, `forced_login_method = "chatgpt"`, no update check, no
  analytics upload, and **`web_search = "disabled"`** — the benchmark's
  references are public PR review comments, so a web search could look the
  answers up; no other arm can search either.
- **The container's seccomp profile.** Codex's `workspace-write` sandbox is
  bubblewrap, which needs user namespaces; docker's default seccomp profile
  refuses them, and Codex's shell commands would then all fail. The codex
  review container therefore runs `--security-opt seccomp=unconfined` — and
  only it: read-only root, `--cap-drop ALL`, `no-new-privileges`, the
  non-root uid, pids/memory/CPU caps, no docker socket and no GitHub
  credential all still apply, and inside it Codex's own sandbox runs exactly
  as the harness asks (workspace writes only, no network for commands).
- **One case at a time**, as the harness's pipeline default
  (`--concurrency 1`); ours run `--parallel` — compare minutes accordingly.
- **What cannot be equal:** Codex gets no PR title or description (the
  harness passes none); its comments carry line ranges (more candidate pairs
  for the AACR judge, as for OCR).

## The OpenCode arm (`--arm opencode`)

[OpenCode](https://opencode.ai) (`opencode-ai` **1.18.33**) as a benchmarked
reviewer. The AACR harness has no OpenCode runner — only `reviewers/ocr.py`,
`claude.py` and `codex.py` — so `src/bench/opencode.ts` is one, built in the
shape of the harness's **codex** runner so the rows compare:

```sh
bench/aacr/bench.sh build  --arm opencode                              # image qcr-bench-opencode
bench/aacr/bench.sh review --arm opencode --run oc-1 --set fresh10     # one case at a time
bench/aacr/bench.sh judge  --run oc-1 --set fresh10                    # the defect benchmark (QCR_BENCH_IMAGE)
bench/aacr/bench.sh eval   --arm opencode --run oc-1 --set fresh10 --judge codex --rounds 3
bench/aacr/arm.sh --prefix opencode --arm opencode --cases fresh10 --eval 3   # all of it, per set
```

| Harness `reviewers/codex.py` | Here |
|---|---|
| `codex exec review "/review <base>...<head> (<fragment>)"` — codex's built-in review | `opencode run --pure --auto --format json --command review "<base>...<head> (<fragment>)"` — OpenCode's **built-in** `review` command template, byte for byte, re-declared in the config with `subtask: false` (below) |
| `INLINE_FINDINGS_PROMPT_FRAGMENT`: call `report` once per finding with file / start_line / end_line / severity / summary / description | the same fragment word for word, naming the tool `findings_report` (OpenCode prefixes MCP tools with the server's name) |
| `mcp_codex_finding_server.py` via `[mcp_servers.findings]` | the SAME script from the pinned harness, run by the harness's venv, as OpenCode's local MCP server `findings` |
| `--sandbox workspace-write` (no network) | `--auto` (every permission not denied is approved); `webfetch`, `websearch` and directories outside the tree denied |
| process timeout 30 × 60 + 60 s | the same (`--timeout-min`, default 30) |
| `save_result`: MCP partial vs JSON parsed from the final text, the larger wins, a tie goes to MCP; raw text scores nothing | the same, the "final text" being the session's last answer |
| result file `{reviewer: "codex", review_output, token_usage, …}` | the same payload with `reviewer: "opencode"`, **plus** `review.comments` — the same notes (summary + "\n" + description), paths and line ranges in the OCR reader's shape, because `eval` scores every arm with the harness's OCR reader and the defect judge reads that key |

**Why `subtask: false`.** The built-in `review` runs as a subtask; when it
returns, OpenCode tells the parent session to "continue with your task",
and the parent — which holds the same prompt, fragment and findings tool —
reviewed the PR again and re-reported the same findings (first smoke test:
3 + 2 and 1 + 1 reports of the same issues, a pure precision penalty codex's
relay-only main thread does not pay). `REVIEW_COMMAND_TEMPLATE` is the
built-in's text verbatim (checked: the rendered prompt and system prompt are
identical to the built-in's), so the one session gets exactly the built-in
prompt and reports once. The difference that remains: as a primary session
it also has OpenCode's `task` and `todowrite` tools. Re-check the template on
every version bump.

No PR title or description reaches OpenCode (the codex runner passes none).
Its findings carry the harness's codex severities, not our tags, so only the
`all` variant exists — compare it with the other arms' `all` rows.

- **The model**: `gpt-6-sol`, reasoning effort `medium` (`--variant medium`,
  and the bridge forces it whatever arrives; `QCR_BENCH_OPENCODE_EFFORT`
  changes both), through the same loopback `codex_bridge.py` as the OCR arm,
  configured as a custom OpenAI-compatible provider (`@ai-sdk/openai-compatible`,
  bundled in the binary). That client always streams, so the bridge replays
  its aggregated answer as `chat.completion.chunk` SSE events (it still
  aggregates upstream first, so an upstream 429 stays an HTTP status the
  client retries). Reasoning is not carried across turns, as for OCR.
- **The credential**: OpenCode never holds one. Its API key is a dummy for the
  loopback; the token lives only in the bridge, which reads the sandbox's
  refresh-disabled copy (`src/bench/auth.ts`, re-taken before every case) and
  refuses any auth file whose refresh token is not the disabled sentinel — so
  nothing in the container can refresh, rotate or write the companion's login.
  OpenCode's own `auth.json`, sessions DB, config and caches live in a fresh
  per-case HOME/XDG tree that is deleted with the case (tested:
  `tests/bench-opencode.test.ts`).
- **No phone-home, no repo-controlled config**: `--pure` (no external
  plugins), `autoupdate: false`, `share: "disabled"`,
  `OPENCODE_DISABLE_{PROJECT_CONFIG,AUTOUPDATE,SHARE,MODELS_FETCH,LSP_DOWNLOAD,DEFAULT_PLUGINS}`
  — the reviewed repo's `opencode.json`/`.opencode/` cannot add providers,
  plugins, MCP servers or permissions. Its `AGENTS.md` is still read, as
  OpenCode (and codex) always do. Two performance-only settings: `snapshot:
  false` (OpenCode's undo tracking hashes the whole tree every step) and no
  file watcher.
- **Pin and bump**: `ARG OPENCODE_VERSION` + `OPENCODE_SHA256_LINUX_X64` in the
  Dockerfile's `opencode` stage (the platform package's binary, checked by
  sha256). To bump: `npm pack opencode-linux-x64@<v>`, `sha256sum
  package/bin/opencode`, set both (or pass `QCR_BENCH_OPENCODE_VERSION` and
  `QCR_BENCH_OPENCODE_SHA256` to `bench.sh build --arm opencode`), then re-run
  the smoke test: the `--format json` event stream and the built-in `review`
  command are not stable contracts.
- **Per case**: `cases/<id>/` holds `opencode-argv.json`, `opencode-config.json`,
  `opencode-events.jsonl` (the event stream), `opencode-result.txt` (the
  session's final text), `opencode.log`, `case-summary.json` (status, comment
  source, MCP vs text counts, the bridge's tokens, the parent session's tool
  calls); `bridge.jsonl` one row per model call, including the effort OpenCode
  asked for.

## The pi-review arm (`--arm pireview`)

[`@zephyrdeng/pi-review`](https://github.com/ZephyrDeng/pi-review) (npm,
**0.18.0**) — "isolated AI-powered code and plan reviews from the command
line", the most-downloaded dedicated code-review package for the pi coding
agent — as a benchmarked reviewer, on the SAME pi (**0.87.1**, the runtime
image's pin) and the same ChatGPT login our own sessions use. The harness has
no pi-review runner, so `src/bench/pireview.ts` is one:

```sh
bench/aacr/bench.sh build  --arm pireview                              # image qcr-bench-pireview
bench/aacr/bench.sh review --arm pireview --run pr-1 --set fresh10     # one case at a time
bench/aacr/bench.sh judge  --run pr-1 --set fresh10                    # the defect benchmark (QCR_BENCH_IMAGE)
bench/aacr/bench.sh eval   --arm pireview --run pr-1 --set fresh10 --judge codex --rounds 3
bench/aacr/arm.sh --prefix pireview --arm pireview --cases fresh10 --eval 3   # all of it, per set
```

**What pi-review is (from its source).** A node CLI (`dist/cli.js`, node
builtins only) that hands the review to ONE fresh child `pi -p --mode json
--no-session --no-extensions` session with a hard read-only tool allowlist
(`read,grep,find,ls` — no shell), its own `--append-system-prompt`
(`resources/system-prompt.md`), its `.claude/rules` loader
(`--extension dist/rules-extension.js`), and a review contract in the user
message (`dist/prompt.js`, mode `code`: correctness, regressions, security,
concurrency, API contracts, edge cases, maintainability, missing tests) that
fixes the answer's Markdown: `## Verdict` / `## Summary` / `## Findings` with
one `### F<n>: <summary>` block per finding (`Severity`, `Path`, `Lines`,
`Side: base|working`, `Actionable`, `Evidence`, `Impact`, `Recommendation`) /
`## Risks and Blind Spots` / `## Open Questions`. pi-review parses that itself
(`dist/review-result.js`) and prints ONE `PI_REVIEW_META_JSON:` line — its
documented, versioned machine contract (`metaVersion: 1`; findings with
`path`, `location.{startLine,endLine,side}`, `details` = Evidence + Impact,
`recommendation`). Panels (`--reviewers`/`--panel`), `loop` and the Jev
`screen`/adjudicator (a hosted service, only with `TYPESAFE_API_KEY`) are
opt-in features; the CLI default is the single reviewer, and that is what runs.

**How it is invoked.** Per case, in the tree checked out at head:

```sh
git diff <base>...<head> > /work/<id>.pireview/pr.diff        # outside the tree
cd /work/wt/<id>
timeout -k 30s 1860s pi-review --model openai-codex/gpt-6-sol --thinking medium \
  --progress-log <case>/pi-events.jsonl \
  -- @/work/<id>.pireview/pr.diff \
  "Review the code changes in the attached diff (git diff <base>...<head>). The working directory is the repository checked out at <head>."
```

- **The diff rides a documented `@file` attachment** (pi inlines it into the
  first message): the reviewer has no shell, so it cannot compute a diff
  itself. Piping it on stdin also works in pi-review's code, but that text is
  appended to the child's ARGV, and Linux caps one argument at 128 KiB — a
  large PR would fail to spawn. The one target sentence says what the
  attachment is and nothing about how to review ("pass the review request as
  natural language after `--`" is pi-review's own contract). No PR title or
  description (the harness's CLI runners pass none).
- **Its defaults**, with ONE departure: `--thinking medium` (its `code`
  preset says `high`) so gpt-6-sol runs at the same effort in every arm
  (`QCR_BENCH_PIREVIEW_THINKING` changes it). No findings tool or instruction
  of ours is added: the output is already structured.
- **`timeout`** (coreutils) signals its own process GROUP, so the child pi
  dies with pi-review; the budget is the harness's 30 min + 60 s.
- **The tree is on `/work`** (a disk-backed volume), NOT under
  `/opt/quickreview/sandbox`: pi loads `AGENTS.md`/`CLAUDE.md` from every
  ancestor of its cwd, and the sandbox root carries OUR production reviewer's
  context files. The reviewed repo's own `AGENTS.md`/`CLAUDE.md` are still
  read, as pi always does.

**Output → findings.** The last `PI_REVIEW_META_JSON:` line (stdout, via
`PI_REVIEW_META_STDOUT=1`) is parsed; every finding it reports becomes one
comment, actionable or not (the review shows them all): `path` =
`Path` (the tree's absolute prefix, `./` and git's `a/`/`b/` stripped; a
`:42`/`:42-58` the model wrote into `Path` becomes the line range only when
pi-review parsed no `Lines`), `start_line`/`end_line` = `location` (a single
line ends where it starts; no `Lines` → null, scored as it is, like the codex
and opencode arms' line-less findings), text = summary, then `details`, then
`Recommendation: …`. A finding with `Side: base` (a deleted/old line) is NOT
put in the scored file — AACR reads the new side — but in
`cases/<id>/comments.json` as a LEFT row, which the defect judge shows as
`path (deleted line)`, exactly as it does for the quickreviewd arm. The result
file is the harness CLI-runner shape (`reviewer: "pireview"`, `review_output`
= pi-review's findings verbatim, `token_usage`) plus `review.comments` in the
OCR reader's shape, so `eval` (`--reviewer ocr`), the defect judge and
`compare.py` read it unchanged; `review.md` is pi-review's Markdown (the
defect judge reads it as the review body, as for the Claude Code arm). Tested
on stub and on real output: `tests/bench-pireview.test.ts`.

- **The model and the credential**: pi's built-in `openai-codex` provider
  (`gpt-6-sol`), on the benchmark's one ChatGPT login through the
  refresh-disabled copy `src/bench/auth.ts` takes before EVERY case (the
  companion's volume is read-only; the copy's refresh token is a sentinel no
  OAuth server accepts; a token that would expire inside a case's budget
  stops the run instead). The child's agent dir (`/tmp/pi-agent-pireview`)
  holds that token and pi's DEFAULT settings (`defaultProjectTrust` only —
  not the bash-guard the quickreviewd sessions register). HOME is a fresh
  per-case dir (so `~/.pi/pi-review/config.json` and `~/.claude/rules` are
  absent: its defaults), deleted with the case.
- **No phone-home**: `PI_OFFLINE=1`, `PI_SKIP_VERSION_CHECK=1`,
  `PI_TELEMETRY=0`; pi-review itself has no update check on the review path,
  and Jev stays off (no `TYPESAFE_API_KEY`). Container hardening is
  `bench.sh`'s, unchanged: read-only root, all capabilities dropped,
  no-new-privileges, non-root, no GitHub credential, no docker socket.
- **Pin and bump**: `ARG PIREVIEW_VERSION` + `PIREVIEW_SHA512` in the
  Dockerfile's `pireview` stage. The npm tarball is fetched with `npm pack`,
  checked against that sha512 (= the registry's `dist.integrity`), and
  UNPACKED — never `npm install`ed, so no install script runs and its one
  floating dependency (typebox, used only by the pi-extension half) is not
  pulled. To bump: `npm view @zephyrdeng/pi-review@<v> dist.integrity`,
  decode it (`echo <b64> | base64 -d | xxd -p -c 100`), set both (or pass
  `QCR_BENCH_PIREVIEW_VERSION` + `QCR_BENCH_PIREVIEW_SHA512` to `bench.sh build
  --arm pireview`), re-read `dist/prompt.js`, `resources/system-prompt.md` and
  the `PI_REVIEW_META_JSON` shape, and re-run the smoke test. pi itself is the
  runtime's pin (rule 7) — bump it there, for every arm at once.
- **Per case**: `cases/<id>/` holds `pireview-argv.json`, `pi-events.jsonl`
  (the child's pi event stream — `compare.py` prices it like our own
  sessions'), `pireview-stdout.txt`, `pireview-stderr.log`,
  `pireview-meta.json`, `review.md`, `comments.json` (base-side findings) and
  `case-summary.json` (status, verdict, findings/actionable, pi's tokens and
  cost, tool calls).

**Smoke test (2026-09-28, 2 PRs of `fresh10`)**: `arm.sh --prefix sm-pireview
--arm pireview --cases fresh10:immich-app__immich@966c3f2,google-gemini__gemini-cli@4c150ab
--eval 1` — both `ok`, 2 comments each (all actionable, verdict
`request_changes`), 0.9 / 0.8 min, ~105k tokens in (65k cached) / 1.5k out,
$0.11 per PR; every comment carries a repo-relative path and a line range
(3 of 4 inside the diff's hunks, the 4th on an existing test the change
breaks); defect judge 4/6 found (67%, 3/5 high, 1/1 medium), 100% of comments
correct; AACR `all` 0/5 references matched (4 comments, line precision 0.5).
One pi-review session, no subagents, 14–22 read/grep/find calls per PR.

## The Claude Code arm (`--arm claude`)

Claude Code as a BENCHMARKED REVIEWER — root CLAUDE.md rule 5's one ratified
exception: `claude` exists only in image `qcr-bench-claude` and runs only inside
its hardened review container, never on the host (`tests/bench-claude.test.ts`
fences it).

```sh
# once: its OWN credential (never the host's login), gitignored, chmod 600
#   CLAUDE_CODE_OAUTH_TOKEN=…   (run `claude setup-token` yourself)  or  ANTHROPIC_API_KEY=…
$EDITOR bench/aacr/claude.env                 # or QCR_BENCH_CLAUDE_ENV=/path/to/file
bench/aacr/bench.sh build  --arm claude                                 # image qcr-bench-claude
bench/aacr/bench.sh review --arm claude --run claude-1 --set fresh10    # one case at a time
bench/aacr/bench.sh judge  --arm claude --run claude-1 --set fresh10
bench/aacr/bench.sh eval   --arm claude --run claude-1 --set fresh10 --judge codex --rounds 3
bench/aacr/arm.sh --prefix claude --arm claude --cases fresh10 --eval 3  # all of it
# a run reviewed before the view below existed: add it (no model call, --network none)
bench/aacr/bench.sh claude-rebuild --arm claude --run claude-1 --set fresh10
```

- **The harness runs it.** `claude_driver.py` imports the pinned harness's own
  `evaluation/reviewers/claude.py` and calls `run_claude_review` +
  `save_result`: `claude -p '/code-review <base>...<head> ' --add-dir <repo>
  --permission-mode acceptEdits --output-format json --mcp-config <findings
  server> --allowed-tools mcp__findings__report --append-system-prompt
  <findings requirement> --settings <StopFailure hook>`, 30 min (+60 s). The
  argv it ran is checked against that shape per case (`claude-argv.json`,
  `argv_ok`). `/code-review` is Claude Code's built-in skill.
- **Why a prose parser, and what the eval scores.** In 2.1.283 `/code-review`
  is a built-in LOCAL command (`"local_command": "code_review"`,
  `num_turns: 0`): it runs its own review and never sees the harness's
  `--append-system-prompt` findings requirement or its findings MCP tool. So
  `save_result` finds no MCP partial and no structured stdout and stores the
  answer as raw text ("Fallback level 2 (WORST CASE)") — which the harness's
  Claude reader scores as ZERO comments, however good the review. Every
  result file therefore also carries an OCR-shaped `review.comments` view
  (`path`, `start_line`, `end_line`, `content`), exactly as the Codex and
  OpenCode arms' do, and `eval` scores the arm with the harness's OCR reader
  (`--reviewer ocr`) — the defect judge reads the same view. The harness's
  payload, `review_output` included, is never touched; `bench.claude_view`
  says where the view came from, `bench.claude_prose_parsed` counts what the
  parser did.
  - **Structured findings** (the few cases where the model called the
    findings tool anyway): the view is the harness's own Claude reading of
    them; `claude_driver.py --check-results` proves, with the harness's two
    readers, that the OCR reader sees exactly the same comments.
  - **Raw text:** `src/bench/claudeprose.ts` reads the markdown,
    deterministically. A finding is a top-level list item (`- `, `1. `) whose
    FIRST line carries a `path:LINE` / `path:A-B` location — in a code span,
    in bold, after a bold title, or bare — or a paragraph that opens with one
    (then the un-located bullets right under it are its body), or an item
    starting `Line N` under a lead-in that names exactly one file. The item's
    first location is its location (later `(and line 352)` references are
    body text); its text is the whole item, markdown kept. Paths lose the
    sandbox's `/work/repo/<owner>__<name>/` prefix and `./`, and resolve to
    the PR's changed files (exact, `a/`/`b/`, or a unique suffix — `mongo.go`
    → `pkg/…/mongo.go`); an unmatched path is kept as written and counted.
  - **Not counted:** items that name a file but no line; items in a list the
    review itself calls not-findings ("What I checked:", "chose not to
    report:", "neither is a bug:", "To fix it:", "they are fine:", or any
    un-labelled list in a review that opens "I found no bugs" — a lead-in
    that counts issues wins); a recap list whose every location repeats an
    earlier finding ("Summary:"). Two findings on the same line in one list
    both count. Twelve real outputs are its golden tests
    (`tests/fixtures/claude-prose/`, `tests/bench-claude-prose.test.ts`).
  - **What it does not do:** judge, merge or rewrite a finding — it only reads
    where the review put it. A finding written with no line at all scores
    nothing, as it would through the harness. The view is built at review
    time; `claude-rebuild` rebuilds it for a finished run, and `eval` refuses
    a Claude Code run whose result files have no view.
- **What differs:** the repo is the `prepareTree` checkout at
  `/work/repo/<owner>__<name>` (no CLAUDE.md above it); the credential is
  Claude Code's own and the model its default for it (the harness pins one
  through a gateway's `ANTHROPIC_MODEL`) — each case records the model that
  ran (`model` in `case-summary.json`); every case gets a fresh HOME. Version
  2.1.283, binary sha256 pinned; auto-update, telemetry and non-essential
  traffic off.
- **An auth failure exits 0** in Claude Code; the arm reads it from the output
  (`auth-failed`), and stops the run rather than scoring empty reviews.

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

## Running the whole benchmark (throughput)

```sh
export QCR_BENCH_RUNS_DIR=~/qcr-bench-runs/runs QCR_BENCH_IMAGE=qcr-bench:full1
bench/aacr/bench.sh build                                    # the scheduler needs an image with eval_shards.py
bench/aacr/bench.sh prefetch --set full --wait-rate-limit    # once; ~196 API calls, waits out the anonymous limit
bench/aacr/arm.sh --prefix full1 --cases full --eval 3       # review 185 runnable PRs, judge the 40, score AACR
bench/aacr/arm.sh --prefix full1 --cases full --eval 3 --resume   # after an interruption: only what is not ok
```

**Where the time went** (measured 2026-09-27 over the 513 reviewed cases in
the runs dir): a review is a median 5.2 min, mean 7.5, p90 10.8, p95 13.5.
The defect judge is ~1–2 min per 10 PRs. The AACR harness judges ONE PR at a
time, ~47 s per PR per round per variant with the codex judge — 3 rounds × 3
variants of `full` is ~22 hours in one process, more than the reviews. The
old `arm.sh --cases full` ran the whole set in one container at
`--concurrency 2` (~11.5 h of reviews), then the judge, then that eval:
**~33 hours**.

**What the scheduler does now** (`arm.sh`, quickreviewd arm):
- **One queue, one container per case.** Every case of every set and repeat,
  longest PR first (`change_line_count`, so the slow ones do not form the
  tail). A container per case costs ~1 s (agents build in under a second) and
  caps each review on its own (`QCR_BENCH_REVIEW_MEMORY=3g`), so one runaway
  cannot starve the others. `bench.sh review --phase init|case|finish` splits
  the run so that only `init` writes `run.json`.
- **Machine-wide slots.** `--parallel N|auto` (default auto) slots are lock
  files in `$QCR_BENCH_RUNS_DIR/.slots/`, shared by every `arm.sh` on the
  machine: two arms started side by side split the slots rather than
  doubling the load on the one login. `auto` = (MemAvailable −
  `QCR_BENCH_RESERVE_MB` 3072) / `QCR_BENCH_REVIEW_MB` 1024, capped at
  `QCR_BENCH_MAX_PARALLEL` 10. A new review also waits while MemAvailable is
  short, counting reviews started in the last 5 minutes as still growing.
- **Overlap.** A run is closed, defect-judged (one slot) and AACR-evaluated
  (one machine-wide eval lock) the moment its last case finishes, while the
  queue keeps reviewing other runs.
- **Sharded eval.** The three variants run side by side, and each is split by
  PR into up to `--eval-shards` (default 6, at least ~4 PRs a shard) harness
  processes. The harness's metrics are micro sums, so `eval_shards.py` merges
  the shards with the harness's own `_compute_summary` and
  `_average_summaries` into exactly the files one process writes (checked
  against an unsharded mock eval: identical rounds, average and per-PR
  matches). `--eval-variants all` scores only what `compare.py` reads.
- **Failures.** Every case ends with a `result:` line (status, retryable,
  rate-limit count from pi's event stream, also in `case-summary.json`
  `model_errors`). A failed case is queued once more at the end
  (`--retries 1`); an unfetchable one never is. A failure under rate limiting
  or overload pauses new launches for `QCR_BENCH_RATE_LIMIT_PAUSE` (300 s).
  Whatever is still not ok after that is what `--resume` re-runs.

**Expected on this PC** (16 cores, 31 GB, no swap): memory is not what binds.
A review measured ~250 MB anonymous plus ~200 MB page cache, up to ~1 GB with
six lens children at once; `auto` gives 10 slots with 14+ GB available. At 10
slots `full` reviews in ~2.3 h (185 × 7.5 min / 10) plus a short tail, the
defect judge ~10 min, and the 3-round eval ~1.2 h (≈18 judge processes) —
**~4 hours** instead of ~33. `--eval 1` brings the eval to ~25 min.

**Risks.** The ONE ChatGPT login is the real limit: earlier arms ran 8–10
reviews at once (each fanning out to up to 6 lens children) with no
rate-limit failure, so 10 is the default cap and not a measured ceiling. If
`RATE-LIMITED` lines appear, lower `QCR_BENCH_MAX_PARALLEL` or `--parallel`
and re-run with `--resume`. The eval adds ~18 low-effort judge calls at once
while it runs.

**Keep the desktop indexer out of the runs dir.** KDE's `baloo_file_extractor`
was seen at 8 GB RSS indexing the multi-megabyte `pi-events.jsonl` files
under `~/qcr-bench-runs`. That is memory the reviews could
use, on a machine without swap. Exclude the directory: System Settings →
Search → File Search → add it to the excluded folders, or
`balooctl6 config add excludeFolders ~/qcr-bench-runs`
(then `balooctl6 purge` to drop what is already indexed).

## Files

| Path | What |
|---|---|
| `bench.sh` | host side: builds the image, wires mounts, hardens every container |
| `Dockerfile` | the sandbox image (build context assembled from an explicit allowlist) |
| `in-container.sh` | the image's entrypoint (dispatch + the eval loop) |
| `select_cases.py` | deterministic set selection from the pinned dataset |
| `arm.sh` / `compare.py` | one arm end to end (review → defect judge → optional AACR eval); the comparison table |
| `check_available.py` | can every PR's base and head still be fetched from github.com |
| `references.json` / `reference_index.py` | each AACR reference's own category and context, for the benchmark table's breakdown |
| `sets/*.json` | the committed case sets |
| `judge_shim.py` | OpenAI-compatible judge endpoint over `pi -p` |
| `eval_shards.py` | splits one eval by PR across harness processes and merges them with the harness's own summary functions |
| `codex_bridge.py` | the OCR and OpenCode arms' loopback Chat Completions/Responses → Codex backend bridge |
| `src/bench/pireview.ts` | the pi-review arm (`tests/bench-pireview.test.ts`, real-output fixture `tests/fixtures/pireview-stdout-immich.txt`) |
| `codex_arm.py` | the Codex CLI arm's driver: the harness's own `reviewers/codex.py` on one prepared case (`src/bench/codex.ts`, `codexcli.ts`, `codexreport.ts`; `tests/bench-codex.test.ts`) |
| `src/bench/` | prefetch, review runner, result conversion, report, the OCR arm (`ocr.ts`) (`tests/bench-aacr.test.ts`); the OpenCode arm (`opencode.ts`, `tests/bench-opencode.test.ts`); the what-if scorer `whatif.ts` + `whatifrun.ts` (`tests/bench-whatif.test.ts`); the Codex CLI arm (`codex.ts`, `codexcli.ts`, `codexreport.ts`, `tests/bench-codex.test.ts`) |
| `whatif/<id>/` | per what-if run: `source/` (the copied run), `results/<variant>/`, `extract/`, `eval/`, `report.md`, `whatif-summary.json` |
| `runs/<id>/` | per run: `run.json`, `cases/<id>/` (system prompt, round order, files, pi event stream, the session's four files, `case-summary.json`), `results/<variant>/` (the harness's input + metrics), `eval/`, `report.md`, `sandbox-commands.log` (every docker invocation, for reproduction) |
