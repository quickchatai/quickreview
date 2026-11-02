# The host plugins and their one skill source

`plugins/qcr/templates/` is the one skill source for QuickReview's commands,
in the pi Plugin and in every host plugin (Claude Code, Codex, Copilot,
Cursor, opencode, Gemini CLI, Antigravity). Each command has one template: a
shared description, a **pi body**, which hands the person the `/qcr-…` line
to type, and a **host body**, which runs `qcr` itself.

`plugins/qcr/render.mjs` renders it: one pure function from the source, a
host, the package version and the contract number to the files that host
reads. It fills in the command's name (`review` on a namespaced host,
`qcr-review` on a bare one), the invoke spelling, the version (every
manifest's, and the pinned `npx` fallback's) and the host's own note, such as
Codex's request for network access.

| host        | the person types | rendered layout                                                    |
| ----------- | ---------------- | ------------------------------------------------------------------ |
| Claude Code | `/qcr:review`    | `.claude-plugin/marketplace.json`, plugin in `qcr/`                |
| Codex       | `$qcr:review`    | `.claude-plugin/marketplace.json`, `qcr/.codex-plugin/plugin.json` |
| Copilot CLI | `/qcr-review`    | `.github/plugin/marketplace.json`, plugin in `qcr/`                |
| Cursor      | `/qcr-review`    | `.cursor-plugin/plugin.json` and `skills/`                         |
| opencode    | `/qcr-review`    | `skills/` alone                                                    |
| Gemini CLI  | `/qcr:review`    | `gemini-extension.json` and `commands/qcr/*.toml`                  |
| Antigravity | `/qcr:review`    | `plugin.json` and `skills/`                                        |
| pi          | `/qcr-review`    | the Plugin's `skills/`                                             |

The pi Plugin's `packages/pi-plugin/skills/` is that render, made by
`npm run build` and by the Plugin's prepack (`node plugins/qcr/render.mjs pi`,
which checks the copy it wrote; `--check` only checks). It is gitignored and
never edited. `tests/plugin-render.test.ts` holds one golden per host and pi:
a template edited without `UPDATE_GOLDEN=1` fails it.

A host body probes the installed `qcr` first (`qcr --schema 1 version`) and,
on any nonzero exit or output that is not JSON, runs the exact release it was
rendered from through `npx -y @quickchatai/quickreview@<version>`. A host scan
runs with `--sandbox host`.

The root `.claude-plugin/marketplace.json` and `plugins/qcr/.claude-plugin/`
still list the Docker-era Claude Code plugin, and its setup script
(`plugins/qcr/scripts/qcr-setup.sh`) stays until the installer replaces it.

## The schema check

Skills never call `qcr review` or `qcr scan` bare. They call
`qcr --schema 1 <verb> …`, which names host-plugin contract 1: one version per
payload family (review, scan, version), held in `CONTRACTS` beside the family
constants in `packages/pi-plugin/src/contract.ts` and read by
`src/schemaflag.ts`. The flag goes before the verb, implies `--json`, and
prints no update notice. A qcr that does not print the contract exits 3 with
one line on stderr and nothing on stdout, and a qcr from before the flag
exits nonzero without JSON, so a skill cannot read fields of a payload it was
not written for. `qcr --schema 1 version` is the probe: its `contracts` field
lists every contract this qcr prints. Adding a field keeps a family's version;
renaming, removing or retyping one bumps it, and a bumped family version is a
new contract number, so a plugin written for contract 1 keeps working while
qcr adds fields. The schemas are in `schemas/`.

The review skill posts nothing: a `--schema` run is always `--json`, which makes
the result's destination `json` whatever the repo saved. Posting to a PR needs
an explicit `--to pr`, which the skill passes only when the user asks.

## The Docker-era setup script

`scripts/qcr-setup.sh` runs the four steps in order and skips what is done.
The image is public, so pull access needs nothing; only a private mirror
needs `gh auth refresh -s read:packages`, then
`gh auth token | docker login ghcr.io`. The two steps that need a person (the
browser sign-in and pi's `/login`) run only on a terminal; without one the script
prints the command and exits 10. The image defaults to
`ghcr.io/<owner>/quickreview:<version>` (the publishing org's namespace, set in the script), the release the plugin ships with
(the registry has no `latest` tag); `QCR_IMAGE` names another image, and a tag
already on the machine skips the pull check. It makes no model call.

## Tests

`tests/plugin-render.test.ts` holds the goldens and every host's bodies.
`tests/plugin-qcr.test.ts` checks the Claude Code render and runs the setup script against
a fake `qcr`, `docker` and `gh` on `PATH` and the recorded version payload in
`tests/fixtures/json-contract/`. `tests/schema-flag.test.ts` drives the
contract flag through the bin's front door and the image's entry.
