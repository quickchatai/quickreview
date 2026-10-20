# `.pi/` — pi project configuration for the review sandbox

## How the lens agents reach the lens tool

Lenses run through **our own lens tool** (`lens` / `lens_wave`,
`src/engine/lens/`; the companion loads it as `extensions/lens.ts`), each lens an
in-process pi SDK session of the host that runs the round. pi's own subagent
example and the glue that wrapped it are gone. The wiring:

| concern | mechanism |
|---|---|
| lens agent discovery | the lens runner reads the agent dir's `agents` (`~/.pi/agent/agents`, which the container entrypoints symlink at the daemon-built `state/agents/` (VM) / `docker/companion/agents/` (companion)); a repo-controlled `.pi/agents` dir is reachable only on the bench's `project` scope (`QCR_SUBAGENT_SCOPE`) |
| concurrency cap | the lens runner's weighted semaphore — `QCR_SUBAGENT_MAX_CONCURRENCY` per session — from `config.toml [engine] lens_max_concurrency`, 8 for the companion (`SUBAGENTS.maxConcurrency`); 4 when unset |
| lens confinement | a lens is a leaf: it is given the bash guard as an extension factory (`runlens.ts` requires it) and never a lens tool or the memory extension, so a pass cannot fan out and does no ambient memory work; it runs in the session's own cwd, so no reviewed repo's `.pi/` project config loads |
| per-agent model | pinned in each built agent's frontmatter by `src/include.ts` as the FULL `provider/model:thinking` spec (never a default — the container auth is ChatGPT OAuth, provider prefix `openai-codex/`) |

## Why `state/agents` and not `agents/`

Agent files have **no include mechanism**. The `agents/pass-*.md`
files share `prompts/pass-common.md` via `{{include:…}}`, so definitions are
expanded at **build time** by `src/include.ts`
(`buildAgents("agents", "state/agents")`), which also applies per-pass model
overrides and the `PASS_ADDENDA` registry. `agents/` holds the canonical,
frozen-seed sources; `state/agents/` holds the generated definitions that
agent discovery actually loads. The daemon regenerates the dir on start.
