---
name: scan
description: Scan the whole repository, or one folder of it, for defects with QuickReview, priced before it starts. Use when the person asks to audit or scan the codebase rather than one change, or asks how a scan is going or what it found.
---

# Scanning with qcr

A scan reads the whole repository at one commit, or one folder of it, not a diff. It is long and costs real money: preview first and start only on the user's say.

## Network access, asked once

qcr needs the network (GitHub and the model provider) and writes its own state outside this workspace, and `npx` writes its cache under `~/.npm`. Codex's default sandbox blocks both. Before the first qcr call, ask the user once to run qcr's commands with escalated permissions (`sandbox_permissions: "require_escalated"`), saying why in one line, and run every qcr call in this skill that way. Do not ask again at each step.

## Which qcr to run

Every call here is written `qcr --schema 1 …`. `--schema 1` asks qcr for contract 1, the JSON this skill was written for: every payload leads with the `schema_version` the contract names, and the flag implies `--json`. Never call qcr without it, and never read fields from a payload you did not get this way.

Before the first call, check the qcr on this machine:

```sh
qcr --schema 1 version
```

If it exits 0 and prints JSON, run `qcr` as written. If `qcr` is not found, exits nonzero or prints anything but JSON, it is missing or does not speak this contract (a qcr that does not print the contract exits 3 with nothing on stdout; one from before the flag exits nonzero with no JSON). Then run the release this skill came from in its place, with the same arguments after it:

```sh
npx -y @quickchatai/quickreview@0.0.0-golden --schema 1 version
```

If that fails too, report its error as printed, stop, and use the setup skill ($qcr:setup).

Every scan call here also carries `--sandbox host`: the scan runs on this machine, behind qcr's read-only guard, with no Docker.

## Steps

1. `qcr --schema 1 scan preview --sandbox host` (add `--path DIR` for one folder, a path relative to the repo root; `--sha REF` for another commit; `--delta` for only what changed since the last scan). Nothing starts. Show the user `preview.estimate_usd`, `preview.cap_usd` and the case list, and wait for a go. If the preview stops because the repo has no saved unit cut, report its message as printed: it names the step.
2. `qcr --schema 1 scan start --key <preview.key> --sandbox host`, with the same `--path`, `--sha` and `--delta` as the preview. A stale key is refused (`ok: false`); preview again and show the new price.
3. `qcr --schema 1 scan status --sandbox host` shows progress; `status --wait --timeout S` waits. `qcr --schema 1 scan stop --sandbox host` ends it.
4. `qcr --schema 1 scan findings --sandbox host` lists what was found; narrow with `--severity`, `--validity`, `--lens`, `--limit N`.

## Reading the result

- `ok: false` with `errors`: report them as printed. An error that names `qcr login` means there is no model login: use the setup skill ($qcr:setup).
- `status.problems` non-empty: say so before the findings.
- Report findings with their `validity` as given (`confirmed`, `likely`, `doubtful`, `unknown`). Do not upgrade a doubtful or unknown finding to a confirmed one.
