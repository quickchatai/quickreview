# Setup & scan

How quickreviewd learns a repo it has just been installed on, tunes its reviewer
to it, and reviews the whole codebase without a pull request. Driven by the
operator's companion; the deterministic half is `src/setup/`.

## Language

### Learning a repo

**Setup**:
Survey + review history + interview, producing the repo profile, the repo portrait and seeded memory.
_Avoid_: onboarding (that is installing quickreviewd itself), calibration

**Survey**:
Setup's read of the repo — agent-directive files and design docs in full, then a sample of each unit's code; it hunts no bugs.
_Avoid_: scan, audit, crawl

**Survey note**:
One convention or architecture note the survey's lens writes about the repo or one unit — an unpinned `#survey` entry in the reviewer's memory; a re-survey supersedes the previous run's notes.
_Avoid_: finding (a survey finds nothing wrong), learning

**Repo facts**:
What a repo says about itself in files, read without a model: stack, frameworks, CI, linters, design docs, style guides, agent-directive files — each with the file that shows it.
_Avoid_: metadata, detection results

**Review history**:
The human review comments on the repo's recently merged PRs plus the daemon's own rounds and `[feedback]`, condensed into themes; only the themes reach memory and the portrait.

**Review history digest**:
The raw review history as the VM reads it through the App and the operator pulls it into the state home (`qcr history pull`); it never leaves the state home.
_Avoid_: export, dump

**History theme**:
One recurring thing reviews of the repo ask for, in the companion's own words — never a quote, never a name; what the digest becomes.
_Avoid_: finding, insight

**Repo portrait**:
The repo facts plus the companion's stored narrative of them — what the interview starts from.
_Avoid_: profile (that is the tuning), summary

**Portrait facts**:
The portrait's deterministic half — stack and units, the conventions the repo writes down and what its tooling enforces, the history themes and, after a scan, what the scans found (findings by unit and state, the per-unit hotspots) — assembled into the state home under a key that moves only when their shape does. The version it replaced is kept.

**Portrait narrative**:
The companion's reading of the portrait facts, stored in the config home against the facts' key; stale once the facts move past it. The one it replaced is kept for a diff.
_Avoid_: summary, report

**Repo profile**:
The per-repo tuning of the reviewer, extending a base profile.
_Avoid_: config (that is the install's), portrait

**Re-tune**:
A change to the repo profile the companion makes itself after a scan, each change with its reason from what the scan found; logged in the state home, and live only once the operator deploys.
_Avoid_: re-interview, retrain

**Interview**:
Setup's conversation with the operator — adaptive, driven by the portrait, always covering four fixed points (goals, merge-blocking concerns, risk areas, style & tests) — whose answers become the repo profile.
_Avoid_: questionnaire, form

**Concern**:
One thing the interview asks the operator to weigh (security, data, money, tests…); it names the lenses its priority decides.
_Avoid_: category, area

**Priority**:
How much one concern matters to the repo — critical, important, normal or ignore — turned into lens settings by one table in code; normal is the reviewer as shipped.
_Avoid_: weight, score

**Pin proposal**:
A memory entry the companion proposes to pin, with one line of why; the operator pins it (or not) in the TUI.
_Avoid_: pin (a proposal is not one)

**Profile baseline**:
The repo profile as it stood before one of setup's writes — the files that write replaced and what the live config named then, kept in the state home under the write's id; what a replay's old side is put back together from.
_Avoid_: backup, snapshot (nothing is restored to the config home)

**Replay**:
One or two recent PRs reviewed twice as background subagents — once under the old profile, once under the new — priced before anything runs and shown side by side; nothing is posted. A lens case the two profiles build identically runs once and counts for both.
_Avoid_: re-review (that is a PR round), regression replay (that is the daemon-side benchmark over closed PRs)

### Cutting a repo up

**Unit**:
A stack-aware part of the repo — a Django app, a package, a workspace — owning one or more path prefixes; the grain every survey, scan and report works in.
_Avoid_: module, component, area

**Unit cut**:
The partition of the repo into units: proposed by the companion, adjusted by the operator, saved in the state home and reused until the operator asks for a new one.
_Avoid_: split, layout, grouping

**Unit candidate**:
The deterministic first guess at a unit, from a marker file (`apps.py`, a nested `package.json`, `go.mod`…); evidence for the companion's proposal, never the cut itself.

**Case**:
One unit, or one part of an oversized unit, handed to background subagents as a single piece of work; a part always carries its unit's name.
_Avoid_: job, chunk, batch

### Reviewing the whole repo

**Scan**:
A whole-repo bug, design and nit review of a set-up repo with no pull request, in two stages.
_Avoid_: audit, sweep (that is a PR lens), survey

**Stage 1**:
The scan's cheap wide pass — one case per unit, tests and migrations excluded — producing findings and deep-lens suggestions.

**Stage 2**:
The scan's deep, targeted plan — rows of file set × lens × tier with a cost — proposed by the companion (a deep proposal adds the deep floor after the companion's rows), optionally fitted to a budget, and started by the operator's word to the companion or a click in the TUI (no approval record; the start quotes the proposal's key).

**Row**:
One case of stage 2: a set of files, which may span units, read by one deep lens at one tier, with the reason it deserves the look and the tests paired with its code.
_Avoid_: job, task

**Paired test**:
A test file stage 2 reads beside the code a row names, found by subject and directory; tests enter a scan only this way.

**Delta re-scan**:
Stage 1 over only the files whose content changed since the last scan — read by the ledger at other content, or new or different against the tree the last scan read. A file the last scan never reached is not a change.

**Match question**:
The findings a re-scan stopped reporting exactly, held beside the fresh findings of the same lens that might be them moved or reworded; the companion answers it whole, and every old finding it pairs with nothing is fixed.
_Avoid_: dedup, merge queue

**Coverage ledger**:
What a scan has read — file, content hash, lens and depth (with tier, sha, cost); the resume grain and the source of cost previews. A reading with no depth is standard; a standard reading never covers a deep plan, and a deep reading covers both.

**Deep scan**:
A scan at `[scan] depth = "deep"`: stage 1 names a deep lens for every file, every lens digs past its row's files (callers, siblings, the contract), and only a deep reading covers a file.
_Avoid_: full scan, thorough scan

**Deep floor**:
The rows a deep stage-2 proposal adds after the companion's: each `deep_lenses` lens the profile leaves on over every file stage 1 reads, a unit's chunk a row, no tests paired; the lenses' order is the priority under a budget.
_Avoid_: baseline (that is a PR lens), sweep

**Calibration run**:
The first stage-1 run at given settings: one case from each of a few units spread across the size range, under its own small hard cap, whose measured cost prices every later preview.
_Avoid_: dry run, trial

**Scan driver**:
The process that drives a scan run's cases — the companion, or a `qcr scan` driver — holding the driver lease while it does; a run recorded as running that no live lease names was interrupted.
_Avoid_: scan owner, scan host

**Scan sandbox**:
Where a `qcr scan start` driver runs by default: a throwaway container from the companion image, mounting only the reviewed repo (read-only), the state home, the scan's own pi home and the config, and refused when the image was built from other code than the checkout's.
_Avoid_: scan container (it is one, but the term names the boundary), companion (the companion is the long-lived session)

**Hard stop**:
The cap a scan run never spends past — the estimate the operator approved (the calibration cap for a calibration run); reaching it aborts what is in flight, and the ledger holds only what finished.
_Avoid_: budget (that is what the operator gives stage 2's proposal)

**Deep-lens suggestion**:
Stage 1's pointer for stage 2: a lens, the files it should read, and one line on why.

**Scan finding**:
A candidate defect from a scan, new, promoted, dismissed or fixed, and possibly marked "may not be valid".
_Avoid_: issue, ticket (a promoted finding becomes one)

**Dismissal**:
The operator's word that a scan finding is not a problem, with a reason; it holds across re-scans and leaves an unpinned memory note so PR rounds stop raising it.

**Promotion**:
Filing one ticket for a scan finding — in the issue tracker effort its work belongs in, or as a markdown file without a tracker — stamped with the fingerprint so it is never filed twice, and closed with the scan's sha when a re-scan finds it fixed.
_Avoid_: export, escalation

**Scan memory**:
What a scan teaches about the repo — recurring patterns and one hotspot per unit — written to reviewer memory as unpinned `#scan` entries, capped per scan; never an individual finding.
_Avoid_: findings memory
