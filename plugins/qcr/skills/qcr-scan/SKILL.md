---
name: qcr-scan
description: Scan a whole repository for bugs with qcr, check on a running scan, and list its findings. Use when the user asks to scan or audit the repo (not a diff), or asks how a qcr scan is going or what it found. Needs qcr set up (qcr-setup).
---

# Scanning with qcr

A scan reads the whole repository at one commit, not a diff. It is long and costs real money: preview first and start only on the user's say.

## Always call it as `qcr --schema 1`

```sh
qcr --schema 1 scan …
```

`--schema 1` asks qcr for contract 1, the JSON this plugin was written for: every payload leads with the `schema_version` the contract names, and the flag implies `--json`. A qcr that does not print contract 1 exits 3 with nothing on stdout and the reason on stderr; a qcr from before the flag exits nonzero with no JSON. Either way stop and tell the user to update the plugin and run `qcr update`. Never call qcr without it. If `qcr` or its login is missing, run the **qcr-setup** skill.

## Steps

1. `qcr --schema 1 scan preview` (add `--sha REF` for another commit, `--delta` for only what changed since the last scan). Nothing starts. Show the user `preview.estimate_usd`, `preview.cap_usd` and the case list, and wait for a go.
2. `qcr --schema 1 scan start --key <preview.key>`. A stale key is refused (`ok: false`); preview again and show the new price.
3. `qcr --schema 1 scan status` shows progress; `status --wait --timeout S` waits. `qcr --schema 1 scan stop` ends it.
4. `qcr --schema 1 scan findings` lists what was found; narrow with `--severity`, `--validity`, `--lens`, `--limit N`.

## Reading the result

- `ok: false` with `errors`: report them as printed.
- `status.problems` non-empty: say so before the findings.
- Report findings with their `validity` as given (`confirmed`, `likely`, `doubtful`, `unknown`). Do not upgrade a doubtful or unknown finding to a confirmed one.
