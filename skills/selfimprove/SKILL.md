---
name: selfimprove
description: Scan the whole repo with the review tool, fix the findings, re-scan and repeat for a set number of fix rounds (default 2). Run as /selfimprove [rounds].
license: MIT
compatibility: Any coding CLI that reads SKILL.md (Claude Code, Codex, opencode, pi). Needs git, a shell, and the `qcr scan` command on PATH.
disable-model-invocation: true
metadata:
  argument-hint: "[rounds=2]"
---

# Self-improve

This skill runs a loop. Scan the repo, sort the findings, fix them, then re-scan the files the fixes changed. Repeat for **N fix rounds**. N is the number the user gave with the command (Claude Code substitutes it here: `$ARGUMENTS`; elsewhere read it from the user's message). If it is missing or not a positive integer, N is `2`. The loop does: scan → fix → re-scan, until round N's fixes have been re-scanned.

The scan tells you what is wrong, and the re-scan tells you whether a fix worked. Your own sense that something is fixed does not count.

Run this skill only when the user invoked it by name. It spends money; never start it because a request merely sounds related.

Two terms are used throughout:

- **Settings**: `.selfimprove/settings.json` at the repo root, gitignored.
- **Ledger**: the directory chosen at setup.

## 1. Setup

If the settings file exists, read it. Show the user a one-screen summary and go on. Don't ask the questions again. They can say "redo setup" to change anything.

If there is no settings file, ask the questions in [references/setup.md](references/setup.md). Use the client's structured question tool when it has one, otherwise numbered options in chat. Ask every question even when one seems to have an obvious answer. Write the answers to the settings file, add `.selfimprove/` to `.gitignore`, and create the ledger from [references/ledger.md](references/ledger.md).

Then check the environment:

- `qcr scan status --json` answers.
- `pi` is on PATH and logged in (the scan's case runner uses it): a one-shot `pi -p "say ok"` answers.
- The repo `qcr scan` reads (`[companion] reviewed_repo_dir` in the qcr config, or `QCR_REVIEWED_REPO`) is this repository, so commits made here are visible to the scan.
- The working tree is clean.
- The baseline build and test commands pass. Record failures that already exist so they aren't blamed on fixes.

**Done when:** the settings file exists and the user has seen it, the ledger directory exists, and the baseline is recorded in `LEDGER.md`.

## 2. Price and approve

Run `qcr scan preview --json`. On rounds after the first, add `--delta --sha <round integration commit>` (see step 6). On a repo that has never been priced, the preview offers a calibration run instead, capped by the tool's `calibration_max_usd`. Show the user that cap and run it only after their yes, then preview again.

On the first round, show the user three things: the price of this scan, an estimate for all N rounds, and the budget set at setup. Get one explicit yes. That yes covers the later rounds as long as each one's preview costs less than the first round's and the running total stays inside the budget. If a later preview is more expensive, or would go over the budget, stop and ask again.

**Done when:** you have the preview's `start` arguments (`null` means something blocks the start; report the errors), and the user's approval covers them. Record the price in the ledger.

## 3. Scan

Run `qcr scan start <the preview's start arguments> --json`, then `qcr scan status --wait --json`. Exit 0 means the run completed, 1 means it ended incomplete or was refused, and 3 means the wait timed out (wait again).

If settings say `depth: deep` and this is round 1, run `qcr scan stage2 propose --deep --json` next. Approve its price the same way as step 2, then run `qcr scan stage2 start --key <the proposal's key> --json` and `qcr scan status --wait --json`. A delta re-scan never runs a deep pass.

If the scan hits its hard stop before covering the plan, report how much coverage it got. Don't restart it at a higher price without asking.

After a delta re-scan, answer any pending match question (`qcr scan matches --json`, then `qcr scan match --key <K> OLD=NEW…`; passing no pairs means none of them match). Pair an old finding with a new one only when they describe the same defect at the same code.

**Done when:** the run's status is finished or hard-stopped, there are no unanswered match questions, and the ledger has the run's cost, coverage, and counts of new, fixed and still-open findings.

## 4. Triage

Pull the open findings with `qcr scan findings --state new --json` and keep the ones inside the settings' `scope`. Give every finding exactly one verdict:

- `real`
- `not-real`
- `by-design`
- `duplicate`
- `needs-owner`
- `out-of-scope`

Settings `no_touch` globs mark paths that are off limits. Any finding inside them gets `out-of-scope`. `needs-owner` means the right answer is a policy decision or a trade-off. Those findings are written to `NEEDS-OWNER.md` and never fixed.

Write `not-real`, `by-design` and `duplicate` verdicts back to the store with `qcr scan dismiss <fingerprint> --reason "<verdict>: <why>"` (reason at most 500 characters). Dismissals are sticky, and they also teach PR reviews to stay quiet about the finding. So never dismiss `needs-owner` or `out-of-scope` findings, because they are real. Keep those in the ledger only.

Group the `real` findings into **packets**. A packet is the files one fixer can own without overlapping another packet. Put findings that touch the same helper in the same packet, because separate branches editing the same helper produce silent duplicates.

**Done when:** every finding in scope has a verdict in `dispositions/r<round>.md`, and every `real` finding belongs to exactly one packet.

## 5. Fix and review

For each packet, follow [references/fix-loop.md](references/fix-loop.md). The short version:

- Each packet gets its own branch, and its own worktree when parallel is on.
- Write the test first, as the settings' `tdd` says.
- The fix is done when the build and tests pass.
- Then a reviewer who did not write the fix approves it, as the settings' `review` says.
- The result lands as the settings' `land` says.

When the client can delegate, hand each packet to a fixer subagent and each review to a separate reviewer subagent. Run up to `parallel` at once. When it cannot delegate, work through the packets one at a time and do the review as a separate pass: start from a fresh read of the diff, not from what you remember writing.

After every packet lands, update `LEDGER.md` and `fixes-explained.md`.

Then build the **round integration commit**: branch `selfimprove/r<round>` from the previous round's integration commit (round 1: the starting HEAD) and merge every approved packet into it, running `build` and `test` after each merge. With `land: merge` the target branch already is this commit. The re-scan reads that commit, and the next round's packets branch from it, so each round builds on the fixes before it even when nothing lands on the user's branch.

**Done when:** every packet is landed, or parked with a reason in the ledger, and no fixer or reviewer is still running.

## 6. Next round or stop

Stop the loop when any of these is true:

- N fix rounds are done.
- The delta re-scan finds no new finding in scope.
- Everything that is left is `needs-owner`.
- The next round's price would go over the budget.

If none is true, go back to step 2 for round + 1. The re-scan is `--delta --sha <round integration commit>`, so it covers only the files this round's fixes changed, as they stand with the fixes in. Re-scan after the last fix round as well, so that round's fixes are checked.

**Done when:** the ledger records why the loop stopped. Then give the user the final report:

- rounds run
- money spent
- findings per round (new, fixed, still open)
- what landed and where (branches, PRs or merges)
- regressions the reviewers caught
- the `NEEDS-OWNER.md` list

## Guardrails

- Worktrees and branches the loop creates for itself are fine. Stop and ask the user before anything that reaches outside the repo:
  - pushing
  - force-pushing
  - opening PRs (unless `land` says PRs)
  - deploying
  - copying credentials
- Commits carry plain messages and the user's git identity. Add co-author trailers only if settings say to.
- Wait for the user's go before any scan they haven't approved, including after the loop has stopped.
- If the user says pause, wrap up or stop, finish only the in-flight packets. Land them the normal way, which includes review unless the user waives it. Then stop every subagent and write the ledger's "Where it stopped" section.
