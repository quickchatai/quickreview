---
name: qcr-scan
description: Scan a whole repository for bugs with qcr, check on a running scan, and list its findings. Use when the user asks to scan or audit the repo (not a diff), or asks how a qcr scan is going or what it found. Needs qcr set up (qcr-setup).
---

# Scanning with qcr

A scan reads the whole repository at one commit, not a diff. It is long and costs real money: preview first and start only on the user's say.

## Always call it through `qcr-json`

```sh
QCRJ="${CLAUDE_PLUGIN_ROOT}/scripts/qcr-json"
"$QCRJ" scan …
```

`qcr-json` prints a payload only when its `schema_version` is one this plugin knows. On an unknown version it exits 3 and prints nothing on stdout: stop and tell the user to update the plugin and run `qcr update`. Never call `qcr scan` bare. If `qcr` or its login is missing, run the **qcr-setup** skill.

## Steps

1. `"$QCRJ" scan preview` (add `--sha REF` for another commit, `--delta` for only what changed since the last scan). Nothing starts. Show the user `preview.estimate_usd`, `preview.cap_usd` and the case list, and wait for a go.
2. `"$QCRJ" scan start --key <preview.key>`. A stale key is refused (`ok: false`); preview again and show the new price.
3. `"$QCRJ" scan status` shows progress; `status --wait --timeout S` waits. `"$QCRJ" scan stop` ends it.
4. `"$QCRJ" scan findings` lists what was found; narrow with `--severity`, `--validity`, `--lens`, `--limit N`.

## Reading the result

- `ok: false` with `errors`: report them as printed.
- `status.problems` non-empty: say so before the findings.
- Report findings with their `validity` as given (`confirmed`, `likely`, `doubtful`, `unknown`). Do not upgrade a doubtful or unknown finding to a confirmed one.
