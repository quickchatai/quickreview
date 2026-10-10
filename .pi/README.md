# `.pi/` — pi project configuration for the review sandbox

## How the lens agents reach the subagent tool

Subagents run on **pi's own first-party subagent extension**, shipped inside
the pinned pi npm package (`examples/extensions/subagent/`). No third-party
subagent extension and no vendored copy are involved. The wiring:

| concern | mechanism |
|---|---|
| the extension itself | `extensions/subagents.ts` (per-session `--extension` argv; also the companion's `piArgv`) dynamic-imports the native extension from the INSTALLED pi package (`getExamplesPath()`), so it can never drift from the rule-7 pin |
| lens agent discovery | the native "user" scope reads `~/.pi/agent/agents`, which the container entrypoints symlink at the daemon-built `state/agents/` (VM) / `docker/companion/agents/` (companion); the glue pins `agentScope` so repo-controlled `.pi/agents` dirs are unreachable |
| concurrency cap | process-wide weighted semaphore in the glue — `QCR_SUBAGENT_MAX_CONCURRENCY` per session — from `config.toml [pi] subagent_max_concurrency` on the VM, 8 for the companion (`SUBAGENTS.maxConcurrency`); 4 when unset |
| child confinement | children spawn as `pi --mode json -p --no-session`; they load only the global settings.json extensions (bash-guard — never the subagents glue or the memory extension, which ride argv), so a pass cannot fan out and does no ambient memory work; the glue also strips every task `cwd`, so a child never runs where a reviewed repo's `.pi/` project config could load |
| per-agent model | pinned in each built agent's frontmatter by `src/include.ts` as the FULL `provider/model:thinking` spec — pi's `--model` accepts the thinking suffix (never a default — the container auth is ChatGPT OAuth, provider prefix `openai-codex/`) |

Load order matters: the subagents glue rides per-session argv
only; children see only the global `~/.pi/agent/settings.json` extensions.
Children therefore never get the `subagent` tool — a pass cannot fan out into
another pass, which structurally enforces the passes-are-leaves rule.

## Facts about the native subagent extension (read at the 0.84.4 pin)

- agents are markdown files with YAML frontmatter; the body becomes the
  subagent's system prompt (`--append-system-prompt` via temp file);
- frontmatter fields: `name` + `description` (both required — a file missing
  either is silently skipped by discovery), `tools`, `model`. There is no
  `thinking` field: the thinking level rides the `model:` value's
  `:<level>` suffix;
- each subagent is an **isolated pi process with zero inherited context**, and
  returns **text only**;
- the tool has three modes (single / `tasks` parallel array / `chain`); the
  round templates use one single-mode call per pass, all in one turn, and the
  glue's semaphore bounds however many arrive at once.

## Why `state/agents` and not `agents/`

The subagent extension has **no include mechanism**. The `agents/pass-*.md`
files share `prompts/pass-common.md` via `{{include:…}}`, so definitions are
expanded at **build time** by `src/include.ts`
(`buildAgents("agents", "state/agents")`), which also applies per-pass model
overrides and the `PASS_ADDENDA` registry. `agents/` holds the canonical,
frozen-seed sources; `state/agents/` holds the generated definitions that
agent discovery actually loads. The daemon regenerates the dir on start.
