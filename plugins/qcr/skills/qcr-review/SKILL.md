---
name: qcr-review
description: Review code with qcr — a branch, the uncommitted changes, a piped diff or a GitHub PR — and report the findings. Use when the user asks for a code review, a second opinion on a diff, or to check changes before pushing or merging. Needs qcr set up (qcr-setup).
---

# Reviewing with qcr

qcr is a headless black box. You give it a target; it prints versioned JSON. A review costs real money, so you preview first and run only on the user's say.

## Always call it through `qcr-json`

```sh
QCRJ="${CLAUDE_PLUGIN_ROOT}/scripts/qcr-json"
"$QCRJ" review …
```

`qcr-json` runs `qcr review … --json` and prints the payload only when its `schema_version` is one this plugin knows. On an unknown version it exits 3 and prints nothing on stdout: stop and tell the user to update the plugin and run `qcr update`. Never read fields from a payload you did not get through it, and never call `qcr review` bare.

If `qcr` is not found, or the call says the image or login is missing, run the **qcr-setup** skill.

## Targets

Run from inside the repository.

| Target                              | Command                                                 |
| ----------------------------------- | ------------------------------------------------------- |
| the current branch against its base | `"$QCRJ" review --preview`                              |
| the uncommitted changes             | `"$QCRJ" review --uncommitted --preview`                |
| a diff on stdin or in a file        | `git diff main... \| "$QCRJ" review --diff - --preview` |
| a PR                                | `"$QCRJ" review <number or URL> --preview`              |

Add `--base REF` to name the base and `--repo OWNER/NAME` when the remote is ambiguous.

## Preview, then run

1. Run the target with `--preview`. It starts nothing. `preview.estimate_usd` is the price, `preview.lenses` the plan, `preview.key` the key.
2. Show the user the estimate and what will be reviewed. Wait for a go.
3. Run the same command without `--preview`, adding `--key <preview.key>` to start over the limit and `--limit <USD>` if the user named one. A changed branch or plan makes the key stale: the call is refused (`ok: false`); preview again and show the new price.

A review can take many minutes. For a long one use the detached form: `"$QCRJ" review start <target flags> --key K` returns a `run_id`; poll `"$QCRJ" review status <run_id>` (`--wait --timeout S` waits) and stop one with `"$QCRJ" review stop <run_id>`.

## Reading the result

- `ok: false` with `errors`: the call failed; report the errors as printed.
- `ok: false` with `partial: true`: the review stopped at its limit. Report the findings it wrote and `coverage.not_reached`, the lenses that never ran. Say the review is incomplete.
- `ok: true`: the findings are under `findings`. Report them by severity, with file and line, as qcr wrote them. Do not add findings of your own to the report, and do not soften or drop one.

If the payload says the output is `customised`, say so: a profile overrode a shipped default.

## Posting

A run through `qcr-json` always carries `--json`, so it prints the result and posts nothing, whatever destination the repo saved. It posts to the PR only with `--to pr`, and only for a PR target. Never pass `--to pr` unless the user asked for the review to be posted to the PR.
