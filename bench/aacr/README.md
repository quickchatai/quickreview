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

The whole benchmark (185 runnable PRs, 505 real defects, 1,418 AACR
references) with quickreviewd `default`, `low` and open-code-review — numbers,
method and caveats in [`FULL-BENCHMARK.md`](FULL-BENCHMARK.md); how to read
the two metrics in [`METRICS.md`](METRICS.md). Charts, all in `charts/`:

| Chart | Shows |
|---|---|
| [`overview.jpg`](charts/overview.jpg) | defects found, high-severity caught, AACR recall — the one-image summary |
| [`defects-by-severity.jpg`](charts/defects-by-severity.jpg) | real defects found, split high / medium / low |
| [`high-severity.jpg`](charts/high-severity.jpg) | merge-blocking defects caught, of 89 |
| [`cost-vs-coverage.jpg`](charts/cost-vs-coverage.jpg) | $ per PR against share of defects found |
| [`two-scores.jpg`](charts/two-scores.jpg) | the same reviews on our judge vs AACR's metric |
| [`reference-quality.jpg`](charts/reference-quality.jpg) | what AACR's reference comments are, hand-checked against the code |
| [`tuned-vs-unseen.jpg`](charts/tuned-vs-unseen.jpg) | the 40 tuning PRs vs the 145 never-seen ones |

Regenerate after a run (every number comes from the judge and harness files
through `compare.py`'s scoring; adding a reviewer is one more `NAME=runs`):

```sh
uv run bench/aacr/charts.py --cases all30+fresh10+rest145 \
  "quickreviewd default=b40-smoke10,b40-dev10,b40-holdout10,b40-fresh10,all-default-rest145" \
  "quickreviewd low=all-low-smoke10,all-low-dev10,all-low-holdout10,all-low-fresh10,all-low-rest145" \
  "open-code-review=b40ocr-smoke10,b40ocr-dev10,b40ocr-holdout10,b40ocr-fresh10,all-ocr-rest145"
```

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
| `codex_arm.py` | the Codex CLI arm's driver: the harness's own `reviewers/codex.py` on one prepared case (`src/bench/codex.ts`, `codexcli.ts`, `codexreport.ts`; `tests/bench-codex.test.ts`) |
| `src/bench/` | prefetch, review runner, result conversion, report, the OCR arm (`ocr.ts`) (`tests/bench-aacr.test.ts`); the OpenCode arm (`opencode.ts`, `tests/bench-opencode.test.ts`); the what-if scorer `whatif.ts` + `whatifrun.ts` (`tests/bench-whatif.test.ts`); the Codex CLI arm (`codex.ts`, `codexcli.ts`, `codexreport.ts`, `tests/bench-codex.test.ts`) |
| `whatif/<id>/` | per what-if run: `source/` (the copied run), `results/<variant>/`, `extract/`, `eval/`, `report.md`, `whatif-summary.json` |
| `runs/<id>/` | per run: `run.json`, `cases/<id>/` (system prompt, round order, files, pi event stream, the session's four files, `case-summary.json`), `results/<variant>/` (the harness's input + metrics), `eval/`, `report.md`, `sandbox-commands.log` (every docker invocation, for reproduction) |
