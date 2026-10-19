# The Claude Code plugin

`plugins/qcr/` is a Claude Code plugin whose skills call the `qcr` host wrapper
([host-wrapper.md](host-wrapper.md)) as a headless black box and read what it
prints. The repository root carries the marketplace file
(`.claude-plugin/marketplace.json`), so `/plugin marketplace add <owner>/<repo>`
then `/plugin install qcr@quickreview` installs it.

| skill        | does                                                                               |
| ------------ | ---------------------------------------------------------------------------------- |
| `qcr-setup`  | Docker, then pull access, then the wrapper, then login. Safe to re-run.            |
| `qcr-review` | reviews a branch, the uncommitted changes, a piped diff or a PR: preview, then run |
| `qcr-scan`   | previews, starts and reads a whole-repository scan                                 |

Claude Code prefixes a plugin's skills with its name, so the setup skill is
`/qcr:qcr-setup`.

## The schema check

Skills never call `qcr review` or `qcr scan` bare. They call
`scripts/qcr-json`, which runs the verb with `--json` and prints the payload
only when every top-level object leads with a `schema_version` the plugin
knows (`KNOWN_*` in the script, one list per schema family: review, scan,
version; the schemas are in `schemas/`). An unknown version exits 3 with nothing
on stdout, so a skill cannot read fields of a payload it was not written for. A
plugin written for version 1 keeps working while qcr adds fields; it stops, and
says to update, when qcr renames or retypes one.

The review skill posts nothing: `qcr-json` always carries `--json`, which makes
the result's destination `json` whatever the repo saved. Posting to a PR needs
an explicit `--to pr`, which the skill passes only when the user asks.

## Setup

`scripts/qcr-setup.sh` runs the four steps in order and skips what is done.
Pull access is `gh auth refresh -s read:packages`, then
`gh auth token | docker login ghcr.io`. The two steps that need a person (the
browser sign-in and pi's `/login`) run only on a terminal; without one the script
prints the command and exits 10. `QCR_IMAGE` names another image (a local tag).
It makes no model call.

## Tests

`tests/plugin-qcr.test.ts` runs both scripts against a fake `qcr`, `docker` and
`gh` on `PATH` and the recorded payloads in `tests/fixtures/json-contract/`.
