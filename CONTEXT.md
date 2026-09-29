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

**Repo profile**:
The per-repo tuning of the reviewer, extending a base profile.
_Avoid_: config (that is the install's), portrait

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
The scan's deep, targeted plan — rows of file set × lens × tier with a cost — proposed by the companion and approved by the operator.

**Delta re-scan**:
Stage 1 over only the files whose content changed since the last scan.

**Coverage ledger**:
What a scan has read — file, content hash and lens (with tier, sha, cost); the resume grain and the source of cost previews.

**Scan finding**:
A candidate defect from a scan, new, promoted, dismissed or fixed, and possibly marked "may not be valid".
_Avoid_: issue, ticket (a promoted finding becomes one)
