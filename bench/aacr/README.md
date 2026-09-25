# AACR-Bench for quickreviewd

This runs **our production reviewer** — the real `round-first.md` order, the
real `conversation-system.md` persona, the real lens and validator agents built
by `buildAgents` with `PASS_ADDENDA`, the production models and tiers from
`config.toml` — against [AACR-Bench](https://github.com/alibaba/aacr-bench)
(Alibaba's 200-PR, 10-language code-review benchmark), **locally, in a locked-down
Docker sandbox**, and scores the result with Alibaba's own harness, unmodified,
at a pinned commit. Nothing touches the VM, the live daemon, GitHub's write API
or the gate.

Background and the fairness caveats: `docs/open-code-review-comparison.md`
(idea 3).

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

Both are generated from the **pinned v1.0 dataset** (git `ab8af8d`, sha256
`d8683cb2…`, the revision every published leaderboard row is denominated in —
x/1505) by `select_cases.py`, which refuses any other revision:

| Set | PRs | References | Rule |
|---|---|---|---|
| `smoke10` | 10 | 62 | 20–160 changed lines, ≥4 references, quota Python 3 / TS 2 / JS 1 / Go 1 / Java 1 / Rust 1 / C 1, smallest first, one PR per repo; 17 backups |
| `full` | 196 | 1,505 | every PR the harness scores (4 of the 200 have no positive references and are never scored by it) |

`--only id,id` narrows any command to named instances (backups included).

## The steps

| Step | Network | Writes | What it does |
|---|---|---|---|
| `build` | npm, github.com (image build) | the `qcr-bench` image | compiles this repo, installs pi 0.84.4, clones the harness at `68a5697`, extracts dataset v1.0 **and verifies its sha256**, converts it with the harness's own converter (196 instances) |
| `prefetch` | github.com, anonymous | volume `qcr-bench-repos` | per instance: a bare store with ONLY the PR's base and reviewed head, shallow, deepened until the merge-base resolves; PR title/body/base branch from the public API (60 req/h anonymous — pass `--wait-rate-limit` for `full`) |
| `review` | the model API | `runs/<id>/` | one production round per PR; `pi -p` exits when the round settles; one continuation if it stopped before writing its files; 45 min timeout per PR |
| `eval` | the judge's endpoint | `runs/<id>/` | the harness's `pipeline run --stage eval` three times — variants `all`, `no-nits`, `blockers` — then `report.md` |
| `report` | none | `runs/<id>/report.md` | re-render the report |

Everything is resumable: `prefetch` reuses a verified store, `review --resume`
skips cases already `ok`.

## The safety model

Every container runs with `--read-only` root, `--cap-drop ALL`,
`no-new-privileges`, a non-root uid (yours), pids/memory/CPU caps, and tmpfs
or anonymous volumes for its scratch space. On this PC it can touch exactly:

- `bench/aacr/runs/<id>/` — read-write, the run's own output;
- the `qcr-bench-repos` docker volume — read-only during review;
- **the pi login**: only the `agent/` directory of the companion's
  `companion-pihome` volume (override with `QCR_BENCH_AUTH_VOLUME`).

The login is shared, not copied, on purpose. pi refreshes its OAuth token in
place under a lock at `<agentDir>/auth.json.lock`; two copies would each
refresh on their own and the second refresh would invalidate the first — the
companion would lose its login. Mounting the SAME directory makes the lock
shared. Everything else in that directory is kept out of the benchmark's way:
`settings.json` and `trust.json` are shadowed by run-owned copies (what the VM
entrypoint provisions: `bash-guard` registered globally, every project
trusted), and `sessions/` by an empty tmpfs, so the sandbox cannot see or
change the companion's conversations.

What the image does NOT contain: `scripts/` (the posting route and
`mint-token.sh`), the `gh` CLI, any GitHub credential, the OpenViking server,
tmux. The review session is told it is offline and must not post — and the
environment makes posting impossible, not just forbidden. The reviewer can
still read the shared `auth.json`, exactly as a production session can read its
pihome; the no-exec policy and `bash-guard` apply as in production.

## What is production and what is not

| | Production | Here |
|---|---|---|
| Round order | `round-first.md` via `renderRoundPrompt` | same, plus an appended **BENCHMARK MODE** override (below) |
| Persona | `conversation-system.md` | same (identity `repo` = the benchmark repo) |
| Pass plan | `buildRoundOrder` → `buildPassPlan` | same, from a real git file list (status, renames, hunks) |
| Agents | `buildAgents` + `PASS_ADDENDA` + profile addenda + same-day feedback addendum | same minus the feedback addendum; profile `""` (generic) by default, `--profile quickchat` for production-as-deployed |
| Models | `config.toml [models]` | same file |
| Extensions | inject-bridge, ledger-pin, muted-theme, round-progress, subagents, openviking; bash-guard global | ledger-pin, subagents; bash-guard global |
| Memory | OpenViking, recall + turn sync | **off** — foreign repos must not read the deployed repo's memory, and a session would write its turns into it |
| GitHub, CI, posting, verdict, ledger, deferrals | yes | replaced by the override: no CI gate (decide on the merits), write `comments.json` / `review.md` / `findings-record.json` / `outcome.json` instead of posting |

The one bias that cannot be removed without a reseed: the frozen
`pass-baseline` seed carries the deployed repo's pytest/Django Ninja conventions.

## Reading the numbers

- **Variants.** `all` = every inline comment that would have been posted;
  `no-nits` drops `[nit]`; `blockers` keeps only `[blocker]`. The references are
  42% maintainability/readability — a class the validator trims on purpose — so
  compare variants, not one headline.
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
  `openai-codex/gpt-5.6-terra:low`, override with `JUDGE_CODEX_MODEL`) — a real
  semantic judge, but not the paper's. `openai` uses any OpenAI-compatible
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
  recall) under the same judge and dataset, next to ours. The harness's
  `reviewers/ocr.py` does that; its Claude Code arm must never be run from here
  (root rule 5).
- **The ground truth is 74% AI-seeded** (GPT-5.2 alone 25%, our model's family),
  and precision counts every comment the annotators did not record as a false
  positive.

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
| `sets/*.json` | the committed case sets |
| `judge_shim.py` | OpenAI-compatible judge endpoint over `pi -p` |
| `src/bench/` | prefetch, review runner, result conversion, report (`tests/bench-aacr.test.ts`) |
| `runs/<id>/` | per run: `run.json`, `cases/<id>/` (system prompt, round order, files, pi event stream, the session's four files, `case-summary.json`), `results/<variant>/` (the harness's input + metrics), `eval/`, `report.md`, `sandbox-commands.log` (every docker invocation, for reproduction) |
