# QuickReview in your coding-agent CLI

QuickReview is an open-source AI code reviewer. `qcr plugin` adds its review,
scan and setup commands to the coding agents on this machine: Claude Code,
Codex, Copilot CLI, Cursor, opencode, Gemini CLI and Antigravity (the
**hosts**). Each command runs `qcr` on this machine, and `qcr` needs Node
22.19 or later. There is no Docker, no image and no GitHub package token.

A review signs in to a model provider of its own and never uses the host's
login. Run `qcr login` once (`npx @quickchatai/quickreview login` without a
global install), or keep a provider's API key in the environment
([llm-setup.md](llm-setup.md)).

pi has its own plugin, `pi install npm:@quickchatai/pi-quickreview`
([packages/pi-plugin/README.md](../packages/pi-plugin/README.md)).

## Install

With nothing installed yet, `npx` runs the installer straight from npm:

```sh
npx @quickchatai/quickreview plugin install --to claude
```

With `qcr` installed (`npm i -g @quickchatai/quickreview`), it is the same verb:

```sh
qcr plugin install --to <host>      # one host
qcr plugin install --to all         # every host found on this machine
qcr plugin install --to claude --project   # you, in this repository only (Claude Code)
```

| Host        | Install                               | Then type                                | To pick it up                                                           |
| ----------- | ------------------------------------- | ---------------------------------------- | ----------------------------------------------------------------------- |
| Claude Code | `qcr plugin install --to claude`      | `/qcr:review`, `/qcr:scan`, `/qcr:setup` | restart Claude Code, or run `/reload-plugins` in a session already open |
| Codex       | `qcr plugin install --to codex`       | `$qcr:review`, `$qcr:scan`, `$qcr:setup` | start a new Codex session                                               |
| Copilot CLI | `qcr plugin install --to copilot`     | `/qcr-review`, `/qcr-scan`, `/qcr-setup` | start a new Copilot CLI session                                         |
| Cursor      | `qcr plugin install --to cursor`      | `/qcr-review`, `/qcr-scan`, `/qcr-setup` | reload the Cursor window, or start a new `cursor-agent` session         |
| opencode    | `qcr plugin install --to opencode`    | `/qcr-review`, `/qcr-scan`, `/qcr-setup` | restart opencode                                                        |
| Gemini CLI  | `qcr plugin install --to gemini`      | `/qcr:review`, `/qcr:scan`, `/qcr:setup` | restart Gemini CLI                                                      |
| Antigravity | `qcr plugin install --to antigravity` | `/qcr:review`, `/qcr:scan`, `/qcr:setup` | start a new Antigravity session                                         |

The installer prints the same two lines for each host it installed into: what
to type, and how to pick it up. A plugin is installed at user scope. Only
Claude Code has a narrower scope the installer writes, so `--project` installs
there and skips every other host with the reason. It is Claude Code's local
scope, `.claude/settings.local.json`, which git ignores: the plugin loads from
the render in your own data home, so a setting checked in for the team would
load in no other clone. Each teammate runs the same install in their clone.

`--to all` finds a host by its executable on `PATH`, and Cursor also by
`~/.cursor`. With no host found it exits 0 and says so. Every run prints one
row per host, installed, updated, removed, skipped or failed (with the host's
own message), and `--json` prints the same rows. The exit code is 0 when no
host failed, 1 when one did, and 2 for a usage error.

## Update and uninstall

```sh
qcr plugin update                    # every host QuickReview is installed in, to this release
qcr plugin uninstall --from <host>   # one host
qcr plugin uninstall --from all      # every host
```

`qcr update` updates `qcr` itself; `qcr plugin update` then brings every host
plugin up to that release. Install, update and uninstall each end by
deleting the rendered releases no host uses any more. Moving Codex, Copilot
CLI, Gemini CLI or Antigravity to a new release removes the old install
first; if the new one then fails, the old release is put back, and when it
cannot be, the failed row says so and `qcr plugin install --to <host>`
installs it again.

## Moving from the Docker-based Claude Code plugin

Releases up to 1.3.2 shipped a Claude Code plugin from this repository's own
marketplace, which installed the image's `qcr` wrapper through Docker. It is
gone. If you installed it, remove it, then install the new one:

```sh
claude plugin uninstall qcr@quickreview
claude plugin marketplace remove quickreview
npx @quickchatai/quickreview plugin install --to claude
```

The old plugin is `qcr@quickreview` and the new one `qcr@quickreview-local`.
Both are named `qcr` and both answer `/qcr:review`, so name the old one in
full: a bare `claude plugin uninstall qcr` may pick either. While the old one
is still installed, `qcr plugin install` and `qcr plugin update` say so and
print these commands; they never remove it themselves. The release image's own `qcr` wrapper, which runs the bot and the home in
Docker, is unchanged ([host-wrapper.md](host-wrapper.md)).

## How a host plugin is made

`plugins/qcr/templates/` is the one skill source for QuickReview's commands,
in the pi Plugin and in every host plugin. Each command has one template: a
shared description, a **pi body**, which hands the person the `/qcr-…` line
to type, and a **host body**, which runs `qcr` itself.

`plugins/qcr/render.mjs` renders it: one pure function from the source, a
host, the package version and the contract number to the files that host
reads. It fills in the command's name (`review` on a namespaced host,
`qcr-review` on a bare one), the invoke spelling, the version (every
manifest's, and the pinned `npx` fallback's) and the host's own note, such as
Codex's request for network access. Its `NAMES` table is where the "Then
type" column above comes from.

| Host        | Rendered layout                                                    |
| ----------- | ------------------------------------------------------------------ |
| Claude Code | `.claude-plugin/marketplace.json`, plugin in `qcr/`                |
| Codex       | `.claude-plugin/marketplace.json`, `qcr/.codex-plugin/plugin.json` |
| Copilot CLI | `.github/plugin/marketplace.json`, plugin in `qcr/`                |
| Cursor      | `.cursor-plugin/plugin.json` and `skills/`                         |
| opencode    | `skills/` alone                                                    |
| Gemini CLI  | `gemini-extension.json` and `commands/qcr/*.toml`                  |
| Antigravity | `plugin.json` and `skills/`                                        |
| pi          | the Plugin's `skills/`                                             |

`plugins/qcr/` is a source, never an installable plugin: it holds the
renderer and the templates, and the repository root carries no plugin
manifest or marketplace. `qcr plugin install --to <host>` renders a host's
folder into the data home (`$XDG_DATA_HOME/qcr/plugins/<host>/<version>/`)
and points the host at it through the host's own install verb. Cursor and
opencode have none, so their render is copied where they load it: Cursor's
folder into `~/.cursor/plugins/local/qcr`, opencode's skills into
`$XDG_CONFIG_HOME/opencode/skills`. A record beside the render,
`<host>.copy.json`, names every file and folder the copy wrote; update
rewrites those, uninstall deletes them, and an install that would land on a
path the record does not name fails instead. A host's own config-home variable
(`CLAUDE_CONFIG_DIR`, `CODEX_HOME`, `COPILOT_HOME`, and opencode's
`XDG_CONFIG_HOME`) set to anything but its default names a profile of that
host, whose renders and record sit in their own folder under
`$XDG_DATA_HOME/qcr/plugins/host-profiles/`, so a verb run for one profile never
deletes what another loads.

The pi Plugin's `packages/pi-plugin/skills/` is that render, made by
`npm run build` and by the Plugin's prepack (`node plugins/qcr/render.mjs pi`,
which checks the copy it wrote; `--check` only checks). It is gitignored and
never edited.

A host body probes the installed `qcr` first (`qcr --schema 2 version`) and,
on any nonzero exit or output that is not JSON, runs the exact release it was
rendered from through `npx -y @quickchatai/quickreview@<version>`. A host scan
runs with `--sandbox host`: in `qcr`'s own process, behind its read-only
guard. It scans the checkout the host runs in (git's toplevel of its
directory) and keeps that repo's scan state in its own folder under the state
home. `QCR_REVIEWED_REPO` in the env names another checkout;
`[companion] reviewed_repo_dir` does only outside any checkout, and from inside
that repo (or a worktree of it) the scan keeps the companion's shared state.
A preview and a start name the checkout they scan (`repo`), and the skill
shows it beside the price.

## The schema check

Skills never call `qcr review` or `qcr scan` bare. They call
`qcr --schema 2 <verb> …`, which names host-plugin contract 2: one version per
payload family (review, scan, version), held in `CONTRACTS` beside the family
constants in `packages/pi-plugin/src/contract.ts` and read by
`src/schemaflag.ts`. The flag goes before the verb, implies `--json`, and
prints no update notice. A qcr that does not print the contract exits 3 with
one line on stderr and nothing on stdout, and a qcr from before the flag
exits nonzero without JSON, so a skill cannot read fields of a payload it was
not written for. `qcr --schema 2 version` is the probe: its `contracts` field
lists every contract this qcr prints. Adding a field keeps a family's version;
renaming, removing or retyping one bumps it, and a bumped family version is a
new contract number, so a plugin written for contract 2 keeps working while
qcr adds fields. The schemas are in `schemas/`.

Contract 1 is still printed, for skills rendered by an older release. Its
review payload is a projection of the version-2 one (`toReviewV1`): the same
object under `schema_version: 1`, legal while every estimate in it is a
number. A review on a model with no measured price has a null estimate, which
contract 1 cannot carry, so it is refused in words instead (`ok: false` with
the reason, exit 1): the reason says to update the skills, or, with no model
route at all, it is the no-credential refusal.

The review skill posts nothing: a `--schema` run is always `--json`, which makes
the result's destination `json` whatever the repo saved. Posting to a PR needs
an explicit `--to pr`, which the skill passes only when the user asks.

## Tests

`tests/plugin-render.test.ts` holds one golden per host and pi (a template
edited without `UPDATE_GOLDEN=1` fails it), every host's bodies, and the
fences that keep `plugins/qcr/` a source with no Docker in it.
`tests/plugin-docs.test.ts` checks that this page's install table and the
README's install lines name every host with the invoke spellings of the
renderer's `NAMES`. `tests/plugin-install-claude.test.ts`,
`tests/plugin-install-hosts.test.ts` and `tests/plugin-install-copy.test.ts`
drive `qcr plugin` against fake hosts on `PATH`.
`tests/schema-flag.test.ts` drives the contract flag through the bin's front
door and the image's entry.
