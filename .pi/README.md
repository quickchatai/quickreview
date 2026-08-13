# `.pi/` — pi project configuration for the review sandbox

JSON forbids comments, so the notes for `subagents.config.json` live here.

## `subagents.config.json` — pi-subagents

Facts this file is built on (§1, verified against the
[pi-subagents README](https://github.com/amosblomqvist/pi-subagents)):

- subagents are markdown files with YAML frontmatter in an **`agents/` dir**;
  the markdown body becomes the subagent's system prompt;
- frontmatter fields: `name` (required, the tool-call id), `tools`, `model`,
  `thinking`, `subagent_agents`;
- each subagent is an **isolated pi process with zero inherited context**, and
  returns **text only** — everything it needs must be in the task string;
- multiple `subagent` tool calls emitted in one assistant turn run **in
  parallel**, bounded by a per-process semaphore whose **`maxConcurrency`
  defaults to 4** and is configurable via an **optional `config.json`**.

Settings here:

| key | value | why |
|---|---|---|
| `maxConcurrency` | `6` | spec §5 /: up to six lens passes fan out per round |
| `agentsDir` | `state/agents` | the **generated** agents dir (see below) |
| `defaultModel` | `openai/gpt-5.6-sol` | spec §1; every per-agent frontmatter also pins it explicitly |

### VERIFY-ON-PIN

pi is not installed in this repo — these are the assumptions to check against
the pinned pi-subagents commit at provisioning time (ansible):

1. **Config file name and location.** The README documents "an optional
   `config.json`" without stating where the extension looks for it. This file
   is placed at `.pi/subagents.config.json` (project-scoped, next to
   `.pi/extensions/`). If the pinned version instead reads
   `.pi/subagents/config.json`, `~/.pi/agent/extensions/pi-subagents/config.json`
   or a `subagents` block in `settings.json`, copy/move it — the *values* stay
   the same.
2. **The agents-dir key name.** Assumed `agentsDir`, relative to the session
   cwd (the sandbox root). It may be `agentsPath`, `dir`, or a positional
   default of `agents/`. If the dir is not configurable, point the extension at
   the generated dir by symlinking or by making `agents/` itself the build
   output (the canonical sources would then move to `agents-src/`).
3. **`defaultModel`.** The example subagent extension in pi core inherits the
   session's active model; pi-subagents documents a `model` frontmatter field
   defaulting to `claude-sonnet-4-6`. Every generated agent pins `model:`
   explicitly, so this key is belt-and-braces — drop it if unsupported.

### Why `state/agents` and not `agents/`

pi-subagents has **no include mechanism**. Our nine `agents/pass-*.md` files
share `prompts/pass-common.md` via a `{{include:prompts/pass-common.md}}`
directive, so the definitions are expanded at **build time** by
`src/include.ts` (`buildAgents("agents", "state/agents")`), which also applies
the per-pass `config.models.passes` override to the frontmatter `model:` field.

`agents/` therefore holds the canonical, human-edited sources (verbatim from
`assets/`) and `state/agents/` holds the generated, include-expanded
definitions pi actually loads. `state/` is git-ignored and is the container's
writable volume; the daemon regenerates the dir on start, so a prompt edit never
needs a hand-run build step.
