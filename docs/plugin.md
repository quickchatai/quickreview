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

## Setup

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

`tests/plugin-qcr.test.ts` checks the skills and runs the setup script against
a fake `qcr`, `docker` and `gh` on `PATH` and the recorded version payload in
`tests/fixtures/json-contract/`. `tests/schema-flag.test.ts` drives the
contract flag through the bin's front door and the image's entry.
