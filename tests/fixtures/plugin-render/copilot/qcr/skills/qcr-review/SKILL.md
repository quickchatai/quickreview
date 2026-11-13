---
name: qcr-review
description: Review code changes with QuickReview, the multi-lens AI code reviewer, of a branch, the uncommitted changes or a pull request. Use when the person asks for a code review, a second opinion on their changes, or a check before pushing or merging.
---

# Reviewing with qcr

qcr is QuickReview's command-line tool, and here it is a headless black box. You give it a target; it prints versioned JSON. A review costs real money, so you preview first and run only on the user's say.

## Which qcr to run

Every call here is written `qcr --schema 2 …`. `--schema 2` asks qcr for contract 2, the JSON this skill was written for: every payload leads with the `schema_version` the contract names, and the flag implies `--json`. Never call qcr without it, and never read fields from a payload you did not get this way.

Before the first call, check the qcr on this machine:

```sh
qcr --schema 2 version
```

If it exits 0 and prints JSON, run `qcr` as written. If `qcr` is not found, exits nonzero or prints anything but JSON, it is missing or does not speak this contract (a qcr that does not print the contract exits 3 with nothing on stdout; one from before the flag exits nonzero with no JSON). Then run the release this skill came from in its place, with the same arguments after it:

```sh
npx -y @quickchatai/quickreview@0.0.0-golden --schema 2 version
```

If that fails too, report its error as printed, stop, and use the setup skill (/qcr-setup).

## Targets

Run from inside the repository.

| Target | Command |
| --- | --- |
| the current branch against its base | `qcr --schema 2 review --preview` |
| the uncommitted changes | `qcr --schema 2 review --uncommitted --preview` |
| a diff on stdin or in a file | `git diff main... \| qcr --schema 2 review --diff - --preview` |
| a PR | `qcr --schema 2 review <number or URL> --preview` |

Add `--base REF` to name the base and `--repo OWNER/NAME` when the remote is ambiguous. When the user asks for a security review, add `--security`: the usual plan plus all fourteen `pass-sec-*` security lenses, which a change with no strong security signal would otherwise not plan. When the user asks for a review of state handling, state machines or lifecycle bugs, add `--state-machines`: the usual plan plus all eight `pass-sm-*` lenses.

## Preview, then run

1. Run the target with `--preview`. It starts nothing. `preview.lenses` is the plan, `preview.key` the key, `preview.model` the model the review runs on (`preview.model.spec`) and `preview.price_basis` what its price is known from.
2. Show the user the model, what will be reviewed and the price, as `preview.price_basis` says it:
   - `measured` or `repo`: `preview.estimate_usd` is the estimate, and the review stops hard at `preview.cap_usd`. When `preview.cap_usd` is `null`, pi has no list price for the model, so there is no dollar stop: show the estimate, and say that only the review's time limit holds. Never name a stop that is not there.
   - `unmeasured`: `preview.estimate_usd` is `null`. There is no estimate for this model. Say so, and show `preview.cap_usd` as the spend at which the review stops. Never show a price you worked out yourself.
   - `unpriced`: `preview.estimate_usd` and `preview.cap_usd` are `null`. There is no price for this model and no dollar stop; only the review's time limit holds. Say exactly that.
   - `unknown` (`preview.model` is `null`): no model resolves, and a start would be refused. `preview.refusal` says why. When `preview.refusal.code` is `no-credential`, or there is no `preview.refusal`, there is no model login: use the setup skill (/qcr-setup) and stop. On any other code a credential exists and signing in is not the cure: show the user `preview.refusal.text` as printed (it names what to do) and stop.

   If `preview.model.ask` is `true`, several providers could run the review and nothing has decided between them. Show the user `preview.model.spec` (the one that would run) and each `preview.alternatives[].spec` with its `provider_name`, and ask which they want. Run `qcr model use <provider>` with the chosen entry's `provider` (for the first one too: that keeps the answer, so the question is not asked again), then preview again. That one call takes no `--schema`: it prints a line for the user, not versioned JSON. Do not pass `--model` for this: it holds for one run and the question comes back.

   Wait for a go.
3. Run the same command without `--preview`, adding `--key <preview.key>` and `--limit <USD>` if the user named one. The key starts a review over the limit, and one with no estimate: it is the user's go, so pass it only after they gave one. A changed branch, plan or model makes the key stale: the call is refused (`ok: false`); preview again and show the new price.

A review can take many minutes. For a long one use the detached form: `qcr --schema 2 review start <target flags> --key K` returns a `run_id`; poll `qcr --schema 2 review status <run_id>` (`--wait --timeout S` waits; a wait that times out also exits 3, with the status payload on stdout) and stop one with `qcr --schema 2 review stop <run_id>`.

## Reading the result

- `ok: false` with `errors`: the call failed; report the errors as printed. An error that names `qcr login` means there is no model login: use the setup skill (/qcr-setup).
- `ok: false` with `partial: true`: the review stopped at its limit. Report the findings it wrote and `coverage.not_reached`, the lenses that never ran. Say the review is incomplete.
- `ok: true`: the findings are under `findings`. Report them by severity, with file and line, as qcr wrote them. Do not add findings of your own to the report, and do not soften or drop one.

If the payload says the output is `customised`, say so: a profile overrode a shipped default.

## Posting

A `--schema 2` run is always `--json`, so it prints the result and posts nothing, whatever destination the repo saved. It posts to the PR only with `--to pr`, and only for a PR target. Never pass `--to pr` unless the user asked for the review to be posted to the PR.
