# `.pi/` — pi project configuration for the review sandbox

## How the lens agents reach pi-subagents (verified live, 2026-08-18)

This directory used to ship a `subagents.config.json` (`agentsDir`,
`maxConcurrency`, `defaultModel`). **That file was inert** — the first live
phase-3 deploy proved the pinned pi-subagents commit (`1f54189`) reads:

- agent .md files ONLY from `<its own install dir>/agents/` (the root-owned
  image path holding its stock researcher/scout/worker), and
- config ONLY from `<its own install dir>/config.json` — and the only key it
  honours is `maxConcurrency` (default 4).

The old VERIFY-ON-PIN assumptions in this README anticipated exactly that
outcome; this is their burn-down. The actual wiring is now:

| concern | mechanism |
|---|---|
| lens agent discovery | `extensions/register-lens-agents.ts` (per-session `--extension` argv) reads the daemon-built `state/agents/*.md` and registers each via the `globalThis.__pi_subagents.registerAgent` hook the pinned extension exposes for exactly this purpose |
| `maxConcurrency: 6` | written to `/opt/pi-extensions/pi-subagents/config.json` by an ansible task after every container (re)create — the path is an image layer, so it resets on recreate and must be re-written per deploy |
| per-agent model | pinned in each built agent's frontmatter by `src/include.ts` (never a default — the container auth is ChatGPT OAuth, provider prefix `openai-codex/`) |

Load-order note (load-bearing): pi-subagents rides the global
`~/.pi/agent/settings.json` (every pi process, children included); the
register extension rides per-session argv only. Children therefore never see
the pass agents — a pass cannot fan out into another pass, which structurally
enforces the passes-are-leaves rule.

## Facts about pi-subagents (§1 + live verification)

- subagents are markdown files with YAML frontmatter; the body becomes the
  subagent's system prompt;
- frontmatter fields: `name` (required, the tool-call id), `tools`, `model`,
  `thinking`, `subagent_agents`;
- each subagent is an **isolated pi process with zero inherited context**, and
  returns **text only**;
- parallel `subagent` calls in one turn are bounded by `maxConcurrency`.

## Why `state/agents` and not `agents/`

pi-subagents has **no include mechanism**. The nine `agents/pass-*.md` files
share `prompts/pass-common.md` via `{{include:…}}`, so definitions are
expanded at **build time** by `src/include.ts`
(`buildAgents("agents", "state/agents")`), which also applies per-pass model
overrides and the `PASS_ADDENDA` registry. `agents/` holds the canonical,
frozen-seed sources; `state/agents/` holds the generated definitions the
register extension actually loads. The daemon regenerates the dir on start.
