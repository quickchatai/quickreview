---
name: qcr-review
description: Review code with qcr — a branch, the uncommitted changes, a piped diff or a GitHub PR — and report the findings. Use when the user asks for a code review, a second opinion on a diff, or to check changes before pushing or merging. Needs qcr set up (qcr-setup).
---

# Reviewing with qcr

qcr is a headless black box. You give it a target; it prints versioned JSON. A review costs real money, so you preview first and run only on the user's say.

## Always call it as `qcr --schema 1`

```sh
qcr --schema 1 review …
```

`--schema 1` asks qcr for contract 1, the JSON this plugin was written for: every payload leads with the `schema_version` the contract names, and the flag implies `--json`. A qcr that does not print contract 1 exits 3 with nothing on stdout and the reason on stderr; a qcr from before the flag exits nonzero with no JSON. Either way stop and tell the user to update the plugin and run `qcr update`. Never read fields from a payload you did not get this way, and never call qcr without it.

If `qcr` is not found, or the call says the image or login is missing, run the **qcr-setup** skill.

## Targets

Run from inside the repository.

| Target                              | Command                                                        |
| ----------------------------------- | -------------------------------------------------------------- |
| the current branch against its base | `qcr --schema 1 review --preview`                              |
| the uncommitted changes             | `qcr --schema 1 review --uncommitted --preview`                |
| a diff on stdin or in a file        | `git diff main... \| qcr --schema 1 review --diff - --preview` |
| a PR                                | `qcr --schema 1 review <number or URL> --preview`              |

Add `--base REF` to name the base and `--repo OWNER/NAME` when the remote is ambiguous.

## Preview, then run

1. Run the target with `--preview`. It starts nothing. `preview.estimate_usd` is the price, `preview.lenses` the plan, `preview.key` the key.
2. Show the user the estimate and what will be reviewed. Wait for a go.
3. Run the same command without `--preview`, adding `--key <preview.key>` to start over the limit and `--limit <USD>` if the user named one. A changed branch or plan makes the key stale: the call is refused (`ok: false`); preview again and show the new price.

A review can take many minutes. For a long one use the detached form: `qcr --schema 1 review start <target flags> --key K` returns a `run_id`; poll `qcr --schema 1 review status <run_id>` (`--wait --timeout S` waits; a wait that times out also exits 3, with the status payload on stdout) and stop one with `qcr --schema 1 review stop <run_id>`.

## Reading the result

- `ok: false` with `errors`: the call failed; report the errors as printed.
- `ok: false` with `partial: true`: the review stopped at its limit. Report the findings it wrote and `coverage.not_reached`, the lenses that never ran. Say the review is incomplete.
- `ok: true`: the findings are under `findings`. Report them by severity, with file and line, as qcr wrote them. Do not add findings of your own to the report, and do not soften or drop one.

If the payload says the output is `customised`, say so: a profile overrode a shipped default.

## Posting

A `--schema 1` run is always `--json`, so it prints the result and posts nothing, whatever destination the repo saved. It posts to the PR only with `--to pr`, and only for a PR target. Never pass `--to pr` unless the user asked for the review to be posted to the PR.
