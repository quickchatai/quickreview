# Run GLM with DigitalOcean Gradient

Use DigitalOcean's model access key and `glm-5.3-flash` through
`https://inference.do-ai.run/v1`. A hello request through pi 1.0.0 succeeded
on 2026-10-12 and returned `Hello! 👋`. This proves authentication and basic
streaming chat. A read-tool round trip at high reasoning also succeeded. Complete benchmark
reviews and child lens sessions are checked by the three-PR smoke run below.

**Current status:** both the hello check and QuickReview benchmark support
Gradient. Set `QCR_BENCH_PROVIDER=digitalocean` for review commands. The host
passes `digitalocean.env` without mounting a login, and each private pi directory
gets the provider configuration. Judge commands use their separate existing
login or OpenAI API-key route.

## The models

`MODEL=<id>` picks the model that runs every reviewer call; the default is
`glm-5.3-flash`. Each id is registered with the provider in `src/bench/auth.ts`
and priced in `bench/aacr/openmodels/models.py` (DigitalOcean list prices, $ per
1M tokens, 2026-10-13):

| Model id | Runs named | Input | Output | Cache read | Context | Output budget |
|---|---|---|---|---|---|---|
| `glm-5.3-flash` | `glm53-…` | 0.15 | 0.50 | 0.03 | 1M | 65,536 |
| `gemma-4-31B-it` | `gemma4-…` | 0.18 | 0.50 | 0.036 | 256k | 8,192 (the model's maximum) |
| `deepseek-v4.1-flash` | `dsv41f-…` | 0.30 | 1.20 | 0.006 | 1M | 65,536 |

All three answered a tool call with reasoning on 2026-10-13. DeepSeek V4.1 Flash
accepts only the reasoning levels low, high, xhigh and max (DigitalOcean answers
400 to `medium`), so its registry entry maps `medium` → `high` and `minimal` →
`low`: the sol-med and terra-med lenses run at high on DeepSeek. Qwen3.8-Max
(`qwen3.8-max`, $2.00 / $6.00 / $0.20) also passed that probe but is left out
for now: at GLM's token profile it would cost about $3.09 a PR, ~$1,030 a full
run, more than GPT-6.1 Sol's ~$770 API-equivalent for the same 335 PRs. Adding a model means
one entry in each of those two places and an image rebuild.

Gemma 4's smoke (2026-10-13 19:57) reviewed 9 of 10 PRs cleanly; the tenth
wrote its findings record with escaped quotes around a key, so the record did
not parse and the bench silently ended the case as no-output. The bench now
gives such a round its one continuation, naming the file and the parser's
message, and a file still unreadable after it is the case's recorded error.

## The driver

`bench/aacr/openmodels/openbench.sh` runs everything below as fixed steps; the
sections after it explain what each step does. Logs and results land in the
main checkout's Git-ignored `bench/aacr/artifacts/open-models/`.

```bash
bench/aacr/openmodels/openbench.sh build              # review + judge image from master HEAD (clean worktree)
bench/aacr/openmodels/openbench.sh preflight          # checks only
bench/aacr/openmodels/openbench.sh smoke --go         # 10-PR smoke on that image: reviews, concurrency report, GPT-6.1 judging
bench/aacr/openmodels/openbench.sh full --go          # 335 PRs, 10 at once, then gate + judge
bench/aacr/openmodels/openbench.sh score-full --go    # re-gate and re-judge a reviewed full run
```

`bench/aacr/openmodels/openbench.sh watch` is the live view: per PR its state, minutes,
lenses running now, GLM replies, provider errors in the last five minutes, idle
time and cost; a PR whose review lost lenses shows as `degraded -N`.

The image bakes the operator's config, whose `[models.pass_models]` pins some
lenses to another model (the `gpt-6-luna` quality and design lenses). The driver
re-points every pin at GLM with that pin's own effort, and `preflight` refuses a
config where any reviewer model spec would still name another model. The
2026-10-13 17:23 smoke ran before this fix: those six lenses failed for lack of an
OpenAI key, on top of a DigitalOcean overload window (17:28–17:35) that timed out
38 lenses.

Without `--go`, a step that spends model money prints its plan and exits. A
benchmark run needs the owner's approval. `bench/aacr/openmodels/gate.py` refuses
scoring when any reviewer call used a model other than GLM, lists every failed
PR (never shrinking a set to what passed), and prints cost and time at
DigitalOcean list prices. It counts a lens launched with a doubled tier suffix
(`pass-x--sol-high--sol-high`, a GLM quirk seen once in the smoke) as executed,
and says so.

The smoke (2026-10-13): 10/10 reviews ok, zero model errors, every recorded
reviewer reply from `digitalocean/glm-5.3-flash`, $3.31 in total at list price,
median about 28 minutes per PR, slowest 54 minutes.

## Store the key

From the repository root, create the gitignored key file in your own terminal:

```bash
(
  set +x
  umask 077
  IFS= read -r -s -p 'DigitalOcean model access key: ' DO_BENCH_KEY
  printf '\n'
  printf 'DIGITALOCEAN_API_KEY=%s\n' "$DO_BENCH_KEY" > bench/aacr/digitalocean.env
)
```

This overwrites an existing file. For an existing file, ensure its permissions
are restricted with `chmod 600 bench/aacr/digitalocean.env`.
Verify without displaying the contents:

```bash
stat -c '%a' bench/aacr/digitalocean.env   # expected: 600
git check-ignore bench/aacr/digitalocean.env
```

Pass the file to Docker with `--env-file`. Keep the key out of command arguments,
run logs, model configuration, and image builds. DigitalOcean and Anthropic use
separate keys; the storage mechanism is the same.

## Run the pi hello check

Use an existing benchmark image containing pi 1.0.0, or build one:

```bash
bench/aacr/bench.sh build
export QCR_BENCH_IMAGE=qcr-bench:latest
```

If using an existing image instead, set `QCR_BENCH_IMAGE` to its tag and skip
the build. The successful check used the local `qcr-bench:ft0554` image.
Run the following from the repository root in Bash. The temporary file contains
an environment-variable reference, never the key itself.

```bash
(
  glm_tmp=$(mktemp -d)
  trap 'rm -rf "$glm_tmp"' EXIT
  cat > "$glm_tmp/models.json" <<'JSON'
{
  "providers": {
    "digitalocean": {
      "baseUrl": "https://inference.do-ai.run/v1",
      "api": "openai-completions",
      "apiKey": "${DIGITALOCEAN_API_KEY}",
      "models": [{
        "id": "glm-5.3-flash",
        "name": "GLM-5.3 Flash (DigitalOcean)",
        "reasoning": true,
        "input": ["text"],
        "contextWindow": 1048576,
        "maxTokens": 4096,
        "cost": {"input": 0.15, "output": 0.50, "cacheRead": 0.03, "cacheWrite": 0}
      }]
    }
  }
}
JSON
  docker run --rm --read-only --cap-drop ALL \
    --security-opt no-new-privileges \
    --tmpfs /tmp:rw,nosuid,nodev,size=128m \
    --env-file bench/aacr/digitalocean.env \
    -e PI_CODING_AGENT_DIR=/tmp/pi -e PI_OFFLINE=1 \
    --mount "type=bind,src=$glm_tmp/models.json,dst=/models.json,readonly" \
    --workdir /tmp --entrypoint sh "${QCR_BENCH_IMAGE:-qcr-bench:latest}" -c '
      mkdir -p /tmp/pi && cp /models.json /tmp/pi/models.json &&
      timeout 90 pi --offline --no-extensions --no-skills \
        --no-prompt-templates --no-themes --no-context-files \
        --no-tools --no-session --provider digitalocean \
        --model glm-5.3-flash --thinking low \
        --system-prompt "Reply briefly to the user." \
        --print "Hello! Reply with one short greeting."
    '
)
```

Success means exit status zero and a short greeting. This invocation loads no
repository context or tools and saves no pi conversation. `--offline` disables
pi's startup network operations; the requested inference call still uses the
network. The 4096-token limit is for this hello check, not a validated review
budget.

## Provider configuration for reviews

`QCR_BENCH_PROVIDER=digitalocean` selects the QuickReview review route.
`QCR_BENCH_DIGITALOCEAN_ENV` overrides the default key-file path.
The built provider in `src/bench/auth.ts` registers GLM-5.3 Flash with a
65536-token output budget, medium/high reasoning through the model tiers,
and DigitalOcean token prices. Both parent and child sessions inherit the
credential. The run fingerprint includes a hash of the provider configuration,
excluding the key; changing credentials alone does not invalidate a resume.

The provider selector applies to review commands only. Keep
`QCR_BENCH_AUTH=login` for GPT judging with the existing login volume, or use
`QCR_BENCH_AUTH=api-key` with a separate `openai.env`. Neither route uses the
DigitalOcean key to authenticate to OpenAI. Other reviewer arms retain their
existing provider requirements.

## Configure all reviewer calls

Build the updated image and assign GLM to every role and tier, including the
validator tier. Run up to ten PR reviews at a time (`PARALLEL=N` raises it for a full run) with twelve concurrent lens calls per PR.

```bash
export QCR_BENCH_IMAGE=qcr-bench:glm-flash
bench/aacr/bench.sh build
bench/aacr/bench.sh doctor

glm_model=digitalocean/glm-5.3-flash
glm_config="models.default=$glm_model,models.conversation=$glm_model,models.overseer=$glm_model,models.tiers.terra-med=$glm_model:medium,models.tiers.sol-med=$glm_model:medium,models.tiers.sol-high=$glm_model:high,pi.subagent_max_concurrency=12,pi.subagent_cache_group=0"
```

The smoke review containers receive the DigitalOcean credential alone, with
empty pi login credentials. Their built lens files and `pass-validate` model
must all name `digitalocean/glm-5.3-flash:medium` or `:high`. Check the actual
assistant message `provider` and `model` fields in `pi-events.jsonl`, including
messages nested in `launch_plan` and `subagent` results: they must be
`digitalocean` and `glm-5.3-flash`. Reject a smoke result with another reviewer
model. GPT-6.1 Sol belongs only to the subsequent judge stage.

Keep prompts, review levers, cases, and the external judge fixed when comparing
models. Cache warmups are disabled in this conservative smoke configuration.

## Run a ten-PR smoke across the benchmarks

The original `glm-aacr1`, `glm-martian1`, and `glm-qodo1` sets contain one
PR each. Add `glm-aacr-extra3`, `glm-martian-extra2`, and `glm-qodo-extra2`
to exercise all ten PR slots: four AACR, three Martian, and three Qodo PRs.
These are the first four AACR cases and first three cases of each external
benchmark, without duplicates or changes to upstream dataset pins. Both AACR
subsets derive their defect keys from `rest145`.

Store logs and results in the Git-ignored `bench/aacr/artifacts/` directory
of the base checkout, outside the reviewer worktrees. `EXT_CACHE` points to the existing
external dataset cache; it must contain the Qodo data and repository mirrors.

```bash
export QCR_BENCH_RUNS_DIR="$PWD/bench/aacr/artifacts/open-models/runs"
mkdir -p "$QCR_BENCH_RUNS_DIR"
# Set EXT_CACHE to your local external dataset cache.
export EXT_CACHE=/path/to/ext-cache
# Make the additional sets available to an existing reviewer image.
export QCR_BENCH_PRIVATE_SETS="$PWD/bench/aacr/sets"
export QCR_EXT_BASE=qcr-bench:glm-flash
export QCR_EXT_IMAGE=qcr-bench:glm-flash-ext
export QCR_EXT_JUDGE_IMAGE="$QCR_EXT_IMAGE"

# Add the fixed GPT judge bridge to the reviewer image and prepare scorers.
bench/aacr/ext/ext.sh build
export QCR_BENCH_IMAGE="$QCR_EXT_IMAGE"
bench/aacr/bench.sh prefetch --set glm-aacr1
bench/aacr/ext/ext.sh prefetch glm-martian1
bench/aacr/ext/ext.sh prefetch glm-qodo1
bench/aacr/bench.sh prefetch --set glm-aacr-extra3
bench/aacr/ext/ext.sh prefetch glm-martian-extra2
bench/aacr/ext/ext.sh prefetch glm-qodo-extra2

QCR_BENCH_PROVIDER=digitalocean bench/aacr/arm.sh \
  --prefix glm53-smoke-p10-l12 --config "$glm_config" \
  --cases glm-aacr1+glm-martian1+glm-qodo1+glm-aacr-extra3+glm-martian-extra2+glm-qodo-extra2 \
  --parallel 10 --no-judge --retries 0 --resume

# External scoring always uses GPT-6.1 Sol; AACR names it explicitly.
QCR_BENCH_AUTH=login bench/aacr/bench.sh judge \
  --run glm53-smoke-p10-l12-glm-aacr1 --set glm-aacr1 \
  --judge-model openai-codex/gpt-6.1-sol:high --concurrency 1
EXT_MARTIAN_REJUDGE= QCR_BENCH_AUTH=login bench/aacr/ext/ext.sh martian \
  glm53-smoke-p10-l12-glm-martian1 glm-martian1
QCR_BENCH_AUTH=login bench/aacr/ext/ext.sh qodo \
  glm53-smoke-p10-l12-glm-qodo1 glm-qodo1 --only-tools quickreview
QCR_BENCH_AUTH=login bench/aacr/bench.sh judge \
  --run glm53-smoke-p10-l12-glm-aacr-extra3 --set glm-aacr-extra3 \
  --judge-model openai-codex/gpt-6.1-sol:high --concurrency 1
EXT_MARTIAN_REJUDGE= QCR_BENCH_AUTH=login bench/aacr/ext/ext.sh martian \
  glm53-smoke-p10-l12-glm-martian-extra2 glm-martian-extra2
QCR_BENCH_AUTH=login bench/aacr/ext/ext.sh qodo \
  glm53-smoke-p10-l12-glm-qodo-extra2 glm-qodo-extra2 --only-tools quickreview
```

`ext.sh build` rebuilds the external overlay and uses the cached upstream
scorer images when available. Martian's scorer refuses to overwrite an existing
score directory. Qodo caches its judgements. AACR supports `--resume`.
The AACR judge uses high reasoning; the external judges use their existing
low default. Their model is GPT-6.1 Sol in every suite.

Outputs live under `$QCR_BENCH_RUNS_DIR/glm53-smoke-p10-l12-<subset>/`.
`run.json` records the model settings; `cases/<instance>/case-summary.json`
records completion and errors; `pi-events.jsonl` records actual reviewer model
identities. AACR scores are in `judge/<label>/report.md`; Martian and Qodo scores
are in their companion `.martian` and `.qodo` directories.

## Check provider errors before scoring

The initial run at three concurrent reviews and up to twelve lens calls per
review hit DigitalOcean's `EngineCore encountered an issue` response. Eight
Qodo lens results reported `stopReason: "error"` even though their subprocess
`exitCode` was zero. A successful hello check proves connectivity but does not
prove the inference service can sustain a review's load.

The retry with two concurrent lenses exceeded the 75-minute review limit on
AACR. The current configuration restores twelve concurrent lenses and ten PR slots.
The ten-PR smoke exercises all ten PR slots. The new smoke prefix preserves the earlier results.
Inspect
`case-summary.json` for `status: "ok"`, zero `model_errors`, and completed
planned passes. Inspect nested `launch_plan` and `subagent` results for
`stopReason` and `errorMessage`; a zero subprocess exit code is insufficient.
Only score successful complete reviews. Keep failed attempts as diagnostics,
and require all ten selected PRs to pass before launching the full runs.

## Expand to the full benchmark sets

After the ten smoke reviews and scoring pass, use the same reviewer image,
model configuration, and fixed judge. The published AACR defect comparison
covers 185 PRs across `smoke10+dev10+holdout10+fresh10+rest145`; the upstream
`full` set has 196 cases, including cases outside that published comparison.
Martian has 50 PRs, and Qodo has 100 PRs.

```bash
# Prefetch each of these sets with the appropriate preparation command first.
QCR_BENCH_PROVIDER=digitalocean bench/aacr/arm.sh \
  --prefix glm53-full --config "$glm_config" \
  --cases smoke10+dev10+holdout10+fresh10+rest145+martian50+qodo-pr100 \
  --parallel 10 --no-judge --retries 0 --resume
```

Judge each AACR run with `--judge-model openai-codex/gpt-6.1-sol:high`;
score `glm53-full-martian50` with `ext.sh martian` and
`glm53-full-qodo-pr100` with `ext.sh qodo --only-tools quickreview`, following
the same credential separation as the smoke commands. Keep failed cases visible;
do not silently shrink a set to completed PRs.

## References

- [DigitalOcean model IDs and capabilities](https://docs.digitalocean.com/products/inference/details/models/)
- [DigitalOcean inference pricing](https://docs.digitalocean.com/products/inference/details/pricing/)
- [pi 1.0.0 custom model configuration](https://github.com/badlogic/pi-mono/blob/v1.0.0/packages/coding-agent/docs/models.md)
- [Benchmark credentials, scoring, and reproduction](../README.md)
