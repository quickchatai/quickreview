# Repo profiles — house-rule addenda packs + lens heuristics

A repo profile matches the reviewer's house-rule knowledge to the repo it
reviews. Generic review behaviour lives in the compiled-in addendum registry
(`PASS_ADDENDA`, `packages/pi-plugin/src/include.ts`); a team's house rules — "we always make new
columns nullable for the deploy window", "global mocks are our style, do not
campaign against them" — live in a profile: a directory of addenda files an
operator can edit without touching this codebase. A profile also carries
the repo-shaped half of LENS SELECTION (`heuristics.toml`, below)
— the file-shape knowledge that decides which passes a round dispatches.

## Selecting a profile

```toml
[review]
profile = "my-repo"   # a directory name under profiles/; "" = no profile
```

Where a profile lives: an install's own profile belongs in its
config home, `$XDG_CONFIG_HOME/qcr/<install>/profiles/<name>/`, next to its
`config.toml` — nothing about a reviewed repo lives in the app's checkout. The
install locator (`src/install.ts locateProfile`) looks in that home first,
then in `profiles/` beside `$QCR_CONFIG` when it is set (the compose route's
mounted config home), then in the checkout's `profiles/` — for the generic
examples (`EXAMPLE_PROFILES`) ONLY. A profile name is one plain path
segment; anything that could escape `profiles/` (`..`, a `/`) is refused.
`qcr install where` prints the search order.

An install profile still in the checkout is not read: a not-found
names it as stranded, `qcr install where` lists it, and `qcr install migrate`
moves it (with the config) into the config home: every checkout profile that
is not a generic example moves,
idempotently, and a differing copy already in the home is a conflict that
touches nothing. `scripts/deploy.sh sync|rebuild` ships the config home's
`profiles/` to the VM with the config, and refuses a named profile
found neither there nor among the checkout's generic examples. The deploy tab says
"profile changed, not deployed" until the next sync.

Unset (`""`) means the generic registry alone, which is what the shipped
`profiles/minimal/` also yields. `profiles/default/` yields the same plan and
agents, with one difference: it turns on the duplicate merge (`[posting]
repeat_sites = false`, `docs/duplicate-merge.md`), so a finding found at several
sites posts once, where an unset profile keeps the code default
(`repeat_sites = true`). The profile is loaded ONCE, at daemon
assembly (`src/wire.ts`): a malformed pack fails the boot loudly, and editing
a pack file requires a daemon restart to take effect — the same discipline as
a compiled-in addendum requiring a redeploy.

Shipped profiles:

- `default/` — the shipped behaviour as a profile: an empty pack,
  no `heuristics.toml`, `ecosystem = "none"`, and the duplicate merge on
  (`[posting] repeat_sites = false`). It is the base a repo's own
  profile extends (`extends = "default"`, below); an empty child of it
  plans and builds its agents exactly as no profile does
  (`tests/profile-inheritance.test.ts` holds the plan and the built agents to
  it) and inherits the duplicate merge. Keep house rules out of it —
  every child inherits what it says.
- `example-django/` — a sanitized worked example for a Django + pytest
  codebase; a template to edit, not a rubric to adopt. Includes an example
  `heuristics.toml`.
- `snappy/` — a handful of comments per PR, bugs first: extends `default`,
  sets `[posting]` (below) and switches the non-bug lenses off.
- `minimal/` — empty; a self-contained skeleton (it extends nothing). No
  `heuristics.toml`: absent is legal and means "the generic selection core
  alone". A new profile is better written as a child of `default/` — only
  what differs.

## Inheritance — `extends`

A profile may extend another, and the base may extend a third, in chains:

```toml
# <config home>/profiles/<name>/profile.toml
extends = "default"          # any profile name the locator can find

[addenda]
drop = ["some-inherited-id"] # optional: inherited addenda to remove
```

Every loader resolves the WHOLE chain (`packages/pi-plugin/src/profiles.ts`), each name through
the install locator exactly like the selected profile — so a base can live in
the config home or be one of the checkout's generic profiles. The chain is
merged base first, the selected profile last, one rule per kind:

- **addenda** — the base's pack first, in its own order. A child file whose
  `id` an ancestor already defines **replaces that entry in place** (same
  position, the child's scope and text), so a child rewords a base rule
  without reordering the pack; a new `id` **appends**. `[addenda] drop =
  [ids]` removes inherited entries before the child's own files merge — so
  dropping an id and defining it again moves it to the tail. A drop naming
  an id nothing inherited defines is refused (a typo must not read as a
  removal), and so is one naming a built-in `PASS_ADDENDA` entry: a profile
  composes onto the registry, it never subtracts from it. Ids still may not
  collide with the built-in registry or repeat inside one pack.
- **heuristics** — unioned per lens, the base's predicates first. ADD-only
  down the chain as against the core: a child can neither drop nor narrow an
  inherited predicate.
- **scalars** (`ecosystem`) — child wins: the nearest profile in the chain
  that sets the key decides; none setting it means `"none"`. Every layer's
  value is still validated, an overridden one too.

A profile that extends another may omit `addenda/` (it inherits its pack);
one that extends nothing must still have it. Refused, loudly, at daemon
assembly like any malformed pack: a cycle (a self-extend included — the
message names the loop), a base found nowhere (the message names who extends
it and every place it looked), an `extends` that is not a plain profile name,
and anything in `[addenda]` but `drop`.

`scripts/deploy.sh sync|rebuild` refuses a chain it cannot ship: every
profile the named one extends must be in the config home's `profiles/` or
the checkout's (where the generic examples, `default` among them, ride the
code rsync) — the two places the VM's daemon looks.

## Authoring a pack

A profile is:

```
profiles/<name>/
  README.md            # optional, but say what the pack is
  heuristics.toml      # optional: lens-selection extensions (below)
  addenda/
    10-<rule-id>.md
    20-<rule-id>.md
    …
```

Each `addenda/*.md` file is ONE pass addendum — the same shape as a
`PASS_ADDENDA` entry, authored as a file:

```markdown
---
id: migration-discipline
scope: pass-data-safety
---
## Migration discipline — four standing rules (house rule)
…the body, appended verbatim to the built pass bodies…
```

- **`id`** — stable kebab-case id (`[a-z0-9-]`). It is what tests, commit
  messages and telemetry cite. It may not collide with another file in the
  pack, with any built-in registry id, or with the reserved
  `feedback-day-validate`.
- **`scope`** — who the addendum binds:
  - `all` — every built pass, `pass-validate` included;
  - `lenses` — every pass that produces findings (all but `pass-validate`);
  - a comma-separated list of pass names (`pass-baseline, pass-data-safety`)
    — exactly those passes.
- **body** — everything after the closing `---` fence, composed verbatim with
  a single `"\n"` separator prepended by the loader. Only `id:` and `scope:`
  are legal in the frontmatter; anything else — a missing fence, an unknown
  key, an empty body, a bad scope — is a build failure with the file named.
  Never a silent skip.

Non-`.md` files in `addenda/` (README, `.gitkeep`) are ignored.

## Ordering — deterministic, documented

Composition order onto a built pass body is fixed:

1. the built-in generic registry, in its declaration order (`PASS_ADDENDA`);
2. the profile pack, in **ascending filename order** (plain byte-wise sort —
   use numeric prefixes `10-`, `20-`, … to state intent); for a profile that
   `extends` another, the chain's merged pack (base first — see
   Inheritance above);
3. the dynamic same-day `[feedback]` addendum (`feedback-day-validate`),
   composed last by `wire.ts` when today carries feedback items.

The order is deterministic by construction, so a rebuild of an unchanged tree
produces byte-identical bodies — the same contract the registry always had.
Renaming a file reorders it; that is the feature, not a hazard, but remember
that later text wins arguments ("supersedes the rule above" style), so order
your files the way you order your reasoning.

One consequence worth knowing when extracting a compiled-in entry into a
profile: the pack composes after every generic entry, so an entry extracted
from mid-registry moves to the tail of its pass's body. The rule texts here are
order-independent in meaning, and `tests/profiles.test.ts` pins the exact
composed bytes for the shipped packs.

## The ecosystem (`profile.toml`)

Framework-specific review machinery is selected per profile, in the profile's
settings file:

```toml
# profiles/<name>/profile.toml
ecosystem = "django"   # or "none"
```

The selection is loaded once at daemon assembly (`loadProfileEcosystem`,
`packages/pi-plugin/src/profiles.ts`) and picks the implementation of the ONE ecosystem seam
(`packages/pi-plugin/src/ecosystem.ts` — one interface, total methods, the same discipline as the
memory seam). It governs four things:

- **the round pre-check** — for `django`, the migration-number
  collision check: the daemon reads the base branch's migrations at the
  round's pinned base sha, detects a number the PR claims that the base
  already occupies, and posts the exact renumber remedy itself as a gated
  **COMMENT** — never a blocker, never a verdict. A *degraded* check (the
  check exists but could not run while the PR touches migrations) is never
  quieter than no check: the round prompt tells the session to check
  collisions itself (which un-muzzles pass-data-safety's withdrawn collision
  class for that round) and the overseer gets an anomaly.
- **the tier-forcing migration gate** — a `django` round touching
  `migrations/` starts its raisable passes at sol-med;
- **the round prompt's migration-gate prose** — the MIGRATION GATE paragraph
  and the GATE NOTES render from the ecosystem (`tests/ecosystem.test.ts`
  holds the `django` text to the bytes);
- **the Django-only review text** — the round templates'
  "add on a missing migration" rule (`{{missing_migration_note}}`) and the
  two compiled-in addenda that name Django or lean on its pre-check
  (`migration-numbering`, `django-migration-orm`, gated by the entry's
  `ecosystem` field in `PASS_ADDENDA`, keeping their registry position in a
  `django` build).

`"none"` is a first-class **configured-off**, deliberately distinct from a
degraded Django check: no pre-check runs, nothing is read or logged, no
COMMENT is posted, no anomaly is raised, the data-safety lens is NOT
un-muzzled, the tier gate never fires, and neither the round prompt nor any
built pass carries migration-gate prose, a pre-check claim or a Django rule —
the data-safety lens simply keeps its own base-branch ordering rule. An absent `profile.toml`, an absent `ecosystem`
key, or no profile selected (`[review] profile = ""`) all mean `"none"`; an
unknown value fails the boot loudly.

Shipped selections: `example-django/` says `django`;
`default/` and `minimal/` say `none` (spelled out, though absence would mean
the same). A child inherits its base's selection unless it sets its own.

`profile.toml` is the profile's settings file: each loader owns its own key,
so other profile-scoped settings may ride the same file without this section
owning them.

## Per-lens tuning — `[lenses.<pass>]`

One table per lens in `profile.toml`, five optional keys (and `guide`, for
`pass-style` alone):

```toml
# <config home>/profiles/<name>/profile.toml
[lenses.pass-security]
min_tier = "sol-high"   # terra-med | sol-med | sol-high — a floor, never a pin
effort = "high"         # low | medium | high (high = [models] effort_max)
max_severity = "P0"     # P0 | P1 | P2 | P3 | nit — the lens's ceiling
emphasis = "Auth is the product here: treat every token path as hostile input."

[lenses.pass-ui]
enabled = false         # this repo does not want the lens at all

[lenses.pass-style]
guide = "style-guide.md"  # a guide in THIS profile's directory
```

**The profile wins** over `config.toml`, its `[review] preset` and the code
defaults: the resolved tuning (`loadProfileLensTuning`, the whole `extends`
chain merged — per lens, per key, the nearest profile that sets it wins) is
overlaid on the parsed config at assembly (`applyProfileTuning` in
`buildParts`, and last of all in the bench's `contextFor`), and every
consumer reads that one `cfg.lenses`. What each key moves
(`packages/pi-plugin/src/lenstuning.ts`):

- **`min_tier`** — plan time (`buildPassPlan`): a floor under the tier the
  plan would pick, so the lens's row, its `raisable_to`, the sweep's rows
  (`[lenses.pass-sweep]`) and the add rule's variant all move with it; the
  prompt names a floored addable lens with its variant. It never lowers — a
  risk pass stays at `sol-high`, the validator at or above `validate_tier`.
  A floored lens never raises the validator (below); only
  `[lenses.pass-validate] min_tier` moves it.
- **`effort`** — build time, through the per-variant model hook: only that
  lens's `<pass>--<tier>` files get the new thinking suffix; every other
  built file is byte-identical. It beats the global `[models] effort`.
- **`enabled = false`** — removes the lens from the plan AND from the
  addable list, whatever selected it: the path core, a heuristic, a sub-lens
  trigger, a `[review]` lever. Any lens — the baseline and the risk passes
  included (a settled design decision: the blocker bar never moves, but a
  profile may switch a lens off). Heuristics stay ADD-only; this is a separate, profile-level
  subtraction. **`enabled = true`** only matters for a lens a `[review]`
  lever gates (sub-lenses, `pass-sweep`, `pass-tests`, the quality lenses,
  `pass-style`): it switches that one lens on whatever the lever says. It
  never plans a lens the selector did not choose, so `pass-ask-human`
  stays addable-only and `pass-concurrency` is planned
  only by its content trigger (below). `[lenses.pass-validate] enabled = false`
  switches the validator off (below).
- **`emphasis`** — compiled into a `lens-emphasis-<pass>` addendum scoped to
  that lens, composed after the profile's own pack, so the addendum registry
  stays the only route into a pass body (AGENTS.md invariant 4). ≤ 2000 characters.
- **`max_severity`** — compiled into a `lens-ceiling-<pass>` addendum scoped
  to the lens and the validator. It REPLACES every other cap on that lens,
  higher or lower: `pass-placement` at `P1` lifts its built-in `P2` cap,
  `pass-ui` at `P3` caps an uncapped lens (downgrade word
  `profile-over-cap`), `P0` lifts every cap.

- **`guide`** (`pass-style` only) — a style guide drafted into the
  profile for a repo that writes none: a path relative to the profile's own
  directory (so it lives in the config home and ships with it), read at load —
  absolute, `..`, a link leaving the directory, a missing or empty file, or
  one over 32,000 characters fails the boot. **A guide the repo writes wins**:
  the style lens is planned on the profile's guide only when
  `packages/pi-plugin/src/styleguide.ts` finds none in the repo (a guide file, a CONTRIBUTING
  style section, or the style sections of AGENTS.md / CLAUDE.md /
  `.github/copilot-instructions.md` / `.github/instructions/`), and the plan
  row says which it is. The text is compiled into a `lens-guide-pass-style`
  addendum scoped to the lens and the validator, so it reaches the session
  wherever it runs. Style findings stay `nit` against either guide unless
  `max_severity` raises the lens's ceiling. A child inherits its base's guide
  (resolved in the base's directory) and may replace it with its own.

The `lens-emphasis-`, `lens-ceiling-` and `lens-guide-` id prefixes are reserved: a pack
file may not claim them. An unknown lens or key, a bad value, the validator
given a ceiling — in any layer of the chain, an overridden one too — fails
the boot loudly. The bench fingerprint records the resolved
tuning (`lenses`, absent when untuned; a guide by file name and sha256).
Pinned by `tests/profile-lens-tuning.test.ts` and
`tests/style-guide-sources.test.ts`.

### The validator is optional, and its veto is a mark

`pass-validate` is on for every PR round unless a profile says
`[lenses.pass-validate] enabled = false`. Off, the plan has no validator row,
it is not addable, the round order tells the session so (`{{validator_note}}`
in step 4), the round records a null `validate_tier`, and the merged
candidates post under the ordinary posting map. The note hands the
validator's belts to the session — drop re-raised SETTLED threads and
out-of-delta nits under NIT SCOPE, hold each lens to its own cap and any
profile ceiling — but no adversary re-derives a claim any more, and the
validator-only addenda (the reachability audit, the `[feedback]` day
demotions) bind nothing: that is the price of switching it off.

On, it runs at its own tier — `[models] validate_tier` under the profile's
`min_tier` for it — and is **not** raised to match any lens's tier or effort.
No raise is needed because a validity veto (`refuted`, `unverifiable`,
`bad-anchor`) does not delete a finding, so a cheaper validator cannot make a
stronger lens's finding vanish. The validator lists it under DOUBTED
(`validate-doubt-not-kill` addendum), the session records it with disposition
`doubted` (`packages/pi-plugin/src/findingsrecord.ts` also folds a `killed` entry carrying one of
those words onto `doubted`), it is never posted on the PR (a doubted entry
with a `posted_as` is a `review_output_unreasoned` anomaly), and the TUI's
detail pane lists it under DOUBTED — "may not be valid". Every other kill (a
repeat, scope, the bar, shape) stays a kill. Pinned by
`tests/optional-validator.test.ts`.

## The whole-repo scan — `[scan]`

The companion's scan reads `config.toml [scan]` (every key; see
`config.example.toml`) and lets a profile override the six keys that are
about THIS repo:

```toml
# <config home>/profiles/<name>/profile.toml
[scan]
effort = "medium"          # stage 1's pass-scan reasoning: low | medium | high
tier = "sol-med"           # whose model pass-scan runs on
validator = false          # the skeptic (ON by default) — false switches it off
exclude = ["generated/"]   # repo-relative globs never scanned
depth = "deep"             # standard (the default) | deep — see "The deep scan" below
deep_lenses = ["pass-consistency", "pass-delivery"]  # the deep floor's lenses, in priority order
```

**The profile wins**, per key, along the `extends` chain (nearest profile
that sets it); `exclude` is replaced whole, never appended. The install's
operating limits — `concurrency`, `case_max_files`/`case_max_lines`,
`calibration_units`, `calibration_max_usd`, `unmeasured_rate_factor` — are
config.toml's alone, and a profile naming one refuses to load. So are the
three that say where `qcr scan start` drives a run — `sandbox`,
`pihome_volume`, `image` (see "The scan sandbox" below); they are not scan
settings at all, and a preview's key never moves with them.

Stage 2 takes the rest of its tuning from the profile's
`[lenses.<pass>]`: a lens with `enabled = false` cannot be named in a row,
`min_tier` is the lowest tier a row may give it (and its default), and its
`effort` is part of the price key the ledger measures it at. A
`deep_lenses` lens the profile switched off gets no floor rows; an entry that
is not a lens a scan can run refuses to load, naming it.

The scan's agents come from the ONE agent build in `"scan"` mode
(`src/setup/scanbuild.ts`): the profile's pack and per-lens tuning compose
exactly as in a PR round, plus the `scan-mode-anchor` addendum (anchors are
lines of the file at the scan sha, not a changed-line run — composed in no PR
build) and `agents/scan/pass-scan.md`; every scan leaf gets read-only tools
only. Pinned by `tests/scan-build.test.ts`.

### The deep scan

`depth = "deep"` makes the scan look harder, in five ways; a standard scan's
builds and plans are exactly what they are without it.

- **Stage 1 points a deep lens at every file.** The scan build composes
  `scan-deep-suggest` on `pass-scan`: every focus file is named in a SUGGEST
  row (up to `SCAN_DEEP_MAX_SUGGESTIONS` a case), and the quality,
  consistency and delivery lenses are named wherever the code shows sibling
  branches, a rule written twice, a dispatch over a state or kind, or a poll
  that recovers dropped events.
- **Every lens digs.** `scan-deep-dig` on every lens a scan runs: follow
  callers, callees and siblings across files; for code that branches on a
  state, kind or source, the state × obligation table (terminal states too),
  with two kinds of finding cell — the one that differs from its siblings
  for no stated reason, and the one treated the same when its state means it
  should differ (a closed item that still logs a correction); a reason
  covers the outcome it states, never the side effects written on the way;
  every early `continue`/`return` named with what it drops and whether the
  edge that triggered it was recorded before the skip, and every state
  without one named with the work it falls through to; two sources of truth
  feeding one loop (a search index lagging the list it indexes among them);
  every callback or deps argument compared with the value the caller holds.
- **Every lens reads to the end and reports what is small.**
  `scan-deep-recall` and `scan-deep-no-budget` (the PR rounds' `no-budget`
  words) on every lens a scan runs: the first turn opens every focus file
  (there is no diff to fetch); every function of every focus file gets the
  lens's questions, however many findings came first; a real defect whose
  cost is small today (noise, drift, a type that lies) is reported at `P3`
  or `nit` with that cost named; a defect another lens owns is still
  reported, because the owner may not run on these files. The three quality
  lenses get scan recasts of their change-shaped wording:
  `scan-deep-consistency` (every set of alike members in the focus files,
  compared both ways), `scan-deep-duplication` (an inventory of every
  derivation, condition and literal, each grepped across the tree, one
  finding per duplicated one, three or more copies one finding naming every
  site) and `scan-deep-maintainability` (every declared field's writers and
  readers, every callback argument against the value in hand).
- **Stage 2 adds the floor.** A deep proposal puts every `deep_lenses` lens
  (default consistency, delivery, duplication, maintainability) over every
  file stage 1 reads — grouped by unit, a case's worth a row, reason `deep
  floor: <lens> over <unit>`, no tests paired (the dig already sends the lens
  to callers, siblings and the contract) — after the companion's rows, priced
  and fitted like any row. Floor rows run lens-first, so the order of
  `deep_lenses` is the priority: under a budget the first-listed lens covers
  the whole tree before the next one starts. A file the companion's rows name for a lens, or that lens
  already read deep at this content, is left out of its floor. The
  companion's `scan_stage2_propose` takes `deep: true` / `false` to set one
  proposal's depth whatever the profile says; a start re-plans at the depth
  the proposal was made at.

At either depth, a stage-2 case carries the stage-1 suggestions that named
its lens and its files (newest first, at most `STAGE2_MAX_LEADS`), as leads
to check first; and every case's event stream is kept under the state home's
`scan/transcripts/<run>/` (the newest 20 runs), with the number of file
reads and any focus file the lens never opened on the case record. A focus
file the lens never opened gets no ledger row: it is read again, and the
run's reconcile never settles its findings fixed from it.
- **Only a deep reading covers a file.** Ledger rows record their depth; a
  deep run reads again what only a standard reading covers (a deep reading
  covers both). Its price comes from deep readings, else from standard ones,
  and the preview says which.

`pass-delivery` is a scan lens at either depth: its scan build composes the
`scan-delivery` recast, which reads its drop-path, redelivery and
fetch-window checks against the code as it stands rather than a change.

### The scan's validator is the skeptic

In a scan, `pass-validate` is the SKEPTIC, and it is **on by default** — a
profile's `[scan] validator = false` switches it off. It runs over each case's
candidates at the **same tier as the lens it judges** (stage 1's `[scan]
tier`, a stage-2 row's own tier — never `validate_tier`, never raised), and
its cost is part of every case's measured price, so a preview always includes
it (a first scan with it on calibrates at that setting). The scan build
composes the `scan-skeptic-validate` addendum (scan mode only — a PR build is
byte-identical without it): for every candidate it reads the code, its
callers, the guards on the path, the tests and the repo's recorded decisions
(`CLAUDE.md`/`AGENTS.md`, docstrings, pinning tests), tries to refute it,
demands a concrete triggering path from an entry point, and names the
matching false-positive class (the same ten classes the lenses' `scan-precision`
checklist names — one list, `SCAN_FALSE_POSITIVE_CLASSES`).

Every stored scan finding it judged carries a **validity tier**:
`confirmed` (a traced scenario, kept on the finding), `likely` (a real
mechanism, reachability not fully traced) or `doubtful` (refuted,
class-matched, or anything it would have killed — below the bar, a
duplicate, a restatement, a confidence under 0.5 — with its word, reason and
class). **Nothing is killed**: the engine stores a KILLED line and a
candidate the answer never mentions as doubtful too, so no kill path of the
frozen validator can make a finding vanish. A finding no skeptic judged (the
validator off or failed, or stored before the tiers) reads as `unknown`,
never a guessed tier. The TUI's `[8] scan` tab groups by tier with confirmed
first (`t` steps the tier filter), and promotion — from the tab or the
companion — defaults to confirmed findings; the rest need an explicit word.
Pinned by `tests/scan-skeptic.test.ts`.

### Scanning from a script — `qcr scan`

The companion's scan tools have `qcr scan` subcommands that call the same
runner, store and triage: every `scan_*` tool of the scan belt, and of the
triage tools `scan_dismiss`. The other triage tools — `scan_promote`,
`scan_close_fixed` and `scan_memory` — have none: they file tickets and write
reviewer memory, and stay with the companion. Each subcommand prints a human answer by default and, with `--json`, one JSON object on one
line (`ok: false` with `errors` on a refusal). Exit codes: 0 done, 1 refused,
2 usage, 3 `status --wait` timed out.

```sh
qcr scan preview [--sha REF] [--delta]           # cases and price; prints the start key
qcr scan start --key K [--sha REF] [--delta]     # starts EXACTLY that preview
qcr scan status [--wait [--timeout S]]           # --wait blocks until the run ends
qcr scan stop
qcr scan findings [--state S] [--lens L] [--unit U] [--severity P] [--validity V] [--doubted|--not-doubted] [--limit N]
qcr scan matches                                 # the pending match question
qcr scan match --key K OLD=NEW…                  # its whole answer; unpaired old ones become fixed
qcr scan suggestions
qcr scan stage2 propose [--rows FILE|-] [--budget USD] [--deep|--standard] [--sha REF]
qcr scan stage2 start --key K [--rows row-1,row-3]
qcr scan dismiss FP… --reason TEXT               # the triage dismissal: sticky, with its memory note
qcr scan units show                              # the saved unit cut and the draft (setup_unit_cut)
qcr scan units propose [--file F|-]              # store a draft: {units, ignored} from F, or the default proposal
qcr scan units adjust --file F|-                 # apply adjust ops (a JSON array, or {ops: […]}) to the draft
qcr scan units save                              # make the draft THE unit cut (refused unless it partitions the repo)
qcr scan login [--provider P]                    # log the companion's pi in — the one login scans read
qcr scan doctor                                  # is this machine ready to scan? (see below)
qcr scan rebuild                                 # build [scan] image, stamped — no container touched
```

The approval rules are the tools': `start` takes only the key a `preview`
printed (`preview --json` gives it as `start`, the arguments to pass on), and
anything that moved since — the plan, the sha, the price, a setting — is
refused; the run stops hard at the estimate it showed. `stage2 start` takes
only the key of the stored proposal, and `--rows` narrows it to runnable rows,
the hard stop their total. `stage2 propose` reads the companion's rows (the
`scan_stage2_propose` shape: `[{lens, files, tier?, reason}]`) from a JSON
file, or none — which only a deep proposal accepts. `units` is the setup
belt's unit-cut tools over the same engine and rendering (`propose` takes the
`setup_unit_cut_propose` shape, `adjust` its ops); a scan reads by unit, so a
repo needs a saved cut before its first preview.

`start` and `stage2 start` launch a detached `qcr scan … --foreground`
driver — in the scan sandbox by default (below), or as a host process with
`[scan] sandbox = "host"` — return once it has recorded the run, and leave its
output in
`scan/driver.log` under the state home (rotated to `driver.log.1` past 5 MB);
a driver that does not say it started within two minutes is stopped and the
start refused. `--foreground` drives the run in the calling process to its
end; a first Ctrl-C (or SIGTERM) stops the run, a second kills the driver and
its pi children outright. The driver holds the **scan driver lease**
(generation files under `scan/driver/`, each claimed by an exclusive create —
a hard link, or an O_EXCL create where links are refused —
and renewed every few seconds), so the companion, the TUI and other drivers
read its run as running, start nothing beside it, and leave its stop to it;
`qcr scan stop`, the TUI's stop and the companion's `scan_stop` reach it
through the same stop channel. A driver that dies stops renewing: within half
a minute its run reads as interrupted, and the ledger resumes it. A driver
that finds its lease lost (suspended past its life while another took over)
stops its run and writes the run record no more. The lease does not
serialise `scan/findings.json`: a `match` or `dismiss` written while a driver
reconciles can lose one of the two writes. On the host the CLI reads the
`[companion] reviewed_repo_dir` checkout (or `QCR_REVIEWED_REPO`); with
`sandbox = "host"` the case runner's `pi` is the one on the PATH.

#### The scan sandbox

With `[scan] sandbox = "docker"` (the default) the driver runs in a throwaway
container (`docker run --rm`) from `[scan] image` — by default the companion
image, which carries the built app at `/opt/qcr` — and its pi runs on the
companion's login. The container mounts exactly, each as a
`--mount` (a missing bind source fails instead of being created; a host path
holding a comma is refused):

| in the container | from the host | |
|---|---|---|
| `/reviewed-repo` | the reviewed checkout | read-only |
| (a worktree's git dir, at its host path) | the repository's common git dir | read-only |
| `/qcr-state` | the install's state home | read-write |
| `/pi-agent-src` | the `agent/` dir of the `[scan] pihome_volume` volume (default `[companion] pihome_volume`) | read-only |
| `/pi-agent-src/sessions` | an empty tmpfs, hiding the companion's conversations | |
| `/home/companion/.pi` | a tmpfs, private to the run | |
| `/qcr-config/live` | a copy of the live config | read-only |
| `/qcr-config/profiles` | the config home's `profiles/` | read-only |

— no `/workspace`, no ssh, no tracker, no GitHub token, no evidence.

**One login.** A scan has no pi login of its own: it borrows the companion's.
Log the companion's pi in once — `qcr scan login` opens pi with `/login`
already typed and sent, so pi's own login menu comes up with every provider
and subscription it offers (`--provider P` sends `/login P`). Quit pi when
you are logged in. It runs inside the running companion container
(`docker exec -it`), or, with the companion stopped, in a throwaway container
over its pi home volume, and
says which. The companion alone keeps refreshing the login. The scan reads that login read-only and,
before every case, re-takes a private copy of its `auth.json` into the tmpfs
pi home with every refresh token replaced by a value no OAuth server accepts
(the copy the benchmark takes, `packages/pi-plugin/src/engine/auth.ts`). So a scan never refreshes
— a second refresher would rotate, and so invalidate, the companion's grant —
never writes a file the companion reads, and picks up a token the companion
refreshed at its next case. The price: a scan case cannot outlive the access
token. A start reads the login first and refuses when there is none or when
its token expires inside a case's 30-minute budget; a case that would start
past that point is refused and the run stopped, its reason the fix — open the
companion so its pi refreshes the login (or run `qcr scan login`), then start
the scan again; the ledger resumes it. A start refuses while the volume does
not exist, rather than letting docker make it empty. `[scan] pihome_volume`
names another pi home to read instead (another install's companion, say);
`sandbox = "host"` runs on the host `pi`'s own login, unchanged. The
network is unrestricted; the memory wiring is the companion's docker network
and endpoint, and of its OpenViking key file only the reviewer key — the one
a scan writes memory with — reaches the container, copied to a 0600 file of
its own (`scan-memory-keys.env` under the operator state home). The run record, findings, ledger, transcripts, lease,
stop channel and driver log are the state home's, so `status`, `findings`,
`matches`, `match`, `dismiss`, `stop` and `suggestions` run on the host
against them, no container involved; a container that dies stops renewing the
lease like a host driver. The container's driver writes its start outcome to
`scan/started/<token>.json` in the state home, which the launch waits for —
the same two minutes, `docker run` included; a silent driver's container is
removed (an answer written as it goes still counts), and handshake files
older than that bound are swept at the next launch. Without a
tracker inside, a run's end cannot close a ticket filed in the issue tracker:
it records that as a problem, and the companion's `scan_close_fixed` (or the close a host `qcr scan match` makes) closes it.

The image is stamped with a hash of the app files it copies
(`src/appstamp.ts`, the `qcr.build-sha` label); `start` refuses an image whose
stamp is not the checkout's — run `qcr scan rebuild` after building
(`npm run build`). It builds `[scan] image` and touches no container, so a
running companion keeps running (`qcr companion rebuild` builds the
companion's own image, the release image, and replaces its container). The image is built from the app root with
`docker/companion/Dockerfile`, the root `.dockerignore` admitting only
what it copies. It is the scan sandbox's own image (default `qcr-scan`): the
companion is the release image in `companion` mode and runs the code it was
built with.

`qcr scan doctor [--json]` checks, each failure with its fix: docker answers;
the image is present and its stamp matches; the companion's pi home volume
exists, holds a login for the stage-1 model's provider, and its access token's
remaining life is reported (a life shorter than a case fails, with the fix);
and a one-shot `pi -p` on that model answers in a throwaway container on the
scan's own route — the refresh-disabled copy of the read-only login, never the
volume mounted writable;
a reviewed repo is set and git can read it; a unit cut is saved. With
`sandbox = "host"` it probes the PATH's `pi` instead of docker.

Inside the companion container an unset `sandbox` is `host` — the companion
sets `QCR_IN_COMPANION=1` on its pi, and a `/workspace` mount with no docker
reachable says the same — so the companion's own `qcr scan` drives on its
container's `pi`; an explicit `[scan] sandbox` is never overridden. The
doctor then says so (`"note"`). `--json`:

```json
{"ok": false, "sandbox": "docker", "reviewed_repo": "/path/to/checkout",
 "checks": [{"check": "docker", "ok": true, "detail": "docker 27.1.0"},
   {"check": "image", "ok": false, "detail": "…", "fix": "qcr scan rebuild"},
   {"check": "pihome", "ok": true, "detail": "…"},
   {"check": "reviewed_repo", "ok": true, "detail": "…"},
   {"check": "unit_cut", "ok": true, "detail": "a unit cut is saved"}]}
```

Exit 0 when every check passes, else 1. Pinned by
`tests/scan-sandbox.test.ts` and `tests/scan-cli-units.test.ts`.

`findings --json` carries every matching finding (`--limit` caps it):

```json
{"ok": true, "total": 2,
 "validity": {"confirmed": 0, "likely": 0, "doubtful": 0, "unknown": 2},
 "findings": [{"fingerprint": "<64 hex>", "file": "app/a.py",
   "range": {"start": 1, "end": 2}, "lens": "pass-scan", "lenses": ["pass-scan"],
   "unit": "app", "kind": "bug", "severity": "P2",
   "validity": "confirmed|likely|doubtful|unknown",
   "state": "new|promoted|dismissed|fixed", "claim": "…",
   "doubted": false, "doubt": null,
   "looks_like_dismissed": null, "dismissal_reason": null, "ticket": null,
   "first_seen": {"run": "scan-…", "sha": "…"},
   "last_seen": {"run": "scan-…", "sha": "…"}}]}
```

`doubt` is `{word, reason, class}` when the validator marked the finding "may
not be valid"; `looks_like_dismissed` is `{fingerprint, reason}` when it
resembles a dismissed one (flagged, never dismissed by the scan). The order
is the tools': validity tier first, most severe first inside it. Pinned by
`tests/scan-cli.test.ts` and `tests/scan-cli-lease.test.ts`.

## The posting policy — `[posting]`

What a review FINDS and what it POSTS are separate questions. Everything
above decides what is true and how severe — and none of it moves here: the
blocker bar, the reachability gate, red CI, NIT SCOPE and the validator's
doubt-not-kill mark are untouched. `[posting]` decides only how much of the
survivors reaches the PR, for a repo (or a benchmark) that wants a handful of
comments per PR rather than every true one.

```toml
# <config home>/profiles/<name>/profile.toml
[posting]
max_comments = 4          # findings posted per round, inline + body; 0 = no cap (default)
nits = "off"              # post (default) | off
questions = "blocking"    # post (default) | blocking (only P0–P2 questions) | off
repeat_sites = false      # true (default): a finding may post at each of its sites
body = "verdict"          # full (default) | verdict (the verdict line + one sentence)
comment_style = "concise" # full (default) | concise (one claim, ≤3 sentences)
```

Inherited through `extends` like every scalar: per key, the nearest profile
that sets it wins. Anything malformed — an unknown key, a wrong type,
`max_comments` outside 0–50 — fails the boot with the file named. A profile
that sets nothing (or only default values) changes nothing: no round-order
note, no addendum, no enforcement, pinned byte for byte by
`tests/posting-default-identity.test.ts`.

Three places carry a non-default policy (`packages/pi-plugin/src/postingpolicy.ts`):

1. **The round order** — a POSTING POLICY note before step 6
   (`{{posting_policy_note}}`), telling the session what posts and that every
   survivor it does not post is recorded `"disposition": "withheld"` with its
   word (`over-budget`, `nits-off`, `questions-off`, `question-not-blocking`,
   `repeat-site`).
2. **The validator** — a generated addendum (`posting-policy-validate`,
   composed after the profile's pack and its lens-ceiling addenda; the id is
   reserved) that, after the ordinary audit, SELECTS what posts by what a
   senior reviewer would insist on before merge — bugs first — and lists the
   rest under WITHHELD. With `comment_style = "concise"` it writes the selected
   findings as single claims.
3. **Mechanically, in the render step both routes run** —
   `selectPosted` over the findings record's posted entries
   (`applyPostingPolicyToRecord` in `packages/pi-plugin/src/reviewrender.ts renderPostedReview`),
   which the live route runs through `scripts/render-review.sh`
   (`src/reviewrendercli.ts`, overlaying the profile's policy exactly as
   `wire.ts` does) and the benchmark runs in `src/bench/runner.ts
   renderBenchOutputs` — pinned equal by `tests/dedup-parity.test.ts`. Cut
   entries are recorded `withheld` with their word. Order: the tag rules,
   then one site per finding (same title, or a `same_as` follower row ⇒ same
   finding), then the budget — ranked by class (question, marker items, nit),
   then severity, then the session's own order (neither render step holds the
   diff, so neither ranks by changed line). `src/posting.ts assembleReview`
   applies the same function off the live path, and with `render_outputs`
   off the benchmark still cuts through `src/bench/benchposting.ts`, which
   does rank by changed line. With a budget, the note and the validator
   addendum also ask that findings sharing one root cause across sites be
   MERGED before counting — one comment at the clearest site naming the
   others, counted once — and that, within one severity, a defect on a
   changed line rank above a consequence in code the PR did not touch.

Two invariants no value moves: **a `[blocker]` is never withheld** — a budget
is filled around the blockers, so a round with more blockers than
`max_comments` posts them all — and **nothing withheld is deleted**: it stays
in the findings record and shows in the TUI detail pane under WITHHELD,
beside DOUBTED.

**The default profile sets `repeat_sites = false`**
(`docs/duplicate-merge.md`): one comment per root cause, the other
sites named in its body. Every profile that extends `default` inherits it; an
install with `[review] profile = ""` keeps the code default.

The shipped `profiles/snappy/` (a generic example) is this section in use:
`max_comments = 4`, no nits, blocking questions only, one site per finding, a
verdict-only body and concise comments, with the non-bug lenses
(maintainability, duplication, abstraction, consistency, style, ui,
placement, intent) switched off and one validator addendum that keeps a
confirmed-but-unprovable race as a `plausible` question. On the benchmark it
is chosen with `--config review.profile=snappy` (or `--profile snappy`).

## Lens planning — when each lens runs, and why the plan chose it

No lens is removed or disabled for being expensive — abstraction, placement
and backcompat included. A profile's `[lenses.<pass>] enabled` stays the ONLY off switch.
Instead each lens is planned where its concern is actually present, and every
planned row of the pass plan says WHY it was chosen (`PassPlanEntry.why`,
`src/dispatch.ts` — the path-shaped lenses, the sub-lenses, the tests and
quality lenses, the sweep rows). A trigger is narrowed only where stored runs
show the lens planned with nothing to do, and never below a case behind one
of its unique real findings.

`packages/pi-plugin/src/lensplanning.ts` `LENS_PLANNING` is the one table of every lens's
**when** and **priority**, held equal to `ALL_PASSES` by a test, so a new lens
cannot ship without documenting its planning:

| Priority | Meaning |
|---|---|
| `core` | every round (baseline, sweep, validator) |
| `risk` | planned on its signal; never skipped or tiered down once planned (data-safety, security, prod-risk) |
| `signal` | planned when the diff or the PR text shows its concern (most lenses) |
| `breadth` | planned on size or novelty (placement, simplicity, the quality lenses) — the design and maintainability questions defect lenses skip, at more cost per unique real finding |
| `on-demand` | addable only (ask-human) |

Some planning signals worth knowing: `pass-backcompat` is also planned on a
changed public signature or wire serialization anywhere (not only API paths);
`pass-claims` also on a stated behaviour in a one-line body (below the intent
bar); the quality lenses on a test-only change with enough test code; the
sweep reads changed prose when code changes and fills its groups source
first.

**The narrowing check (`bench/aacr/trigger_check.py`, 395 stored PR reviews:
AACR rest145, Martian tune20 + test30, Qodo pr100, SWE-PRBench eval100;
unique real findings from `bench/aacr/lens_yield.py --cases-json`):**

| Lens | Planned | NONE now | Candidate narrowing | NONE after | Unique-real cases kept |
|---|---|---|---|---|---|
| pass-tests | 384 | 222 (58%) | only when the PR touches a test or modifies existing code | 204 of 365 (56%) | 9/9 |
| pass-backcompat | 77 | 47 (61%) | API/job path arms only when existing code is modified | 41 of 68 (60%) | 1/1 |
| pass-concurrency | 31 | 20 (65%) | — (content trigger, needs the patch; planned by content only) | — | 0 unique real |
| pass-rollout | 61 | 30 (49%) | — (text/content trigger, not replayable from stored cases) | — | 0 unique real |

Both file-shape narrowings keep every unique-real case but barely move the
NONE rate (58→56%, 61→60%): a NONE here is mostly "nothing to find in this PR",
not a trigger firing on the wrong shape. **No trigger was narrowed.** The
remaining lever is content, not paths, and it needs stored patches to check —
revisit with the next run's data.

### The per-file coverage check — `[review] coverage_check`

After the planned lenses return, the round calls the `coverage_gaps` tool
(`packages/pi-plugin/src/coverage.ts`, loaded on both routes with `cluster_findings`) with the
order's coverage-eligible files — changed, non-test source code, not
generated, lock, vendored, binary or prose — and every file path a lens raised
a finding on. A file no lens raised anything on gets a targeted `pass-sweep`
row: at most two rows per round, packed by the sweep's 500-line budget, each
carrying the reason `coverage: no lens addressed <files>` and logged
`COVERAGE <files>`; files past the cap are listed as unchecked in the
summary. It is a second, focused read of files that drew nothing — not a
claim that they hold a defect. A file a RETURNED `pass-sweep` row had in
its `focus` list counts as read, NONE included (a `pass-behaviour-delta` row
does not: it skips pure additions) (the tool's `swept` argument): that row
already read its changed lines at the sweep's tier, and on studied live rounds
a second read of them mostly answered NONE. A row that failed, errored or was cut short counts
for nothing, so the coverage row fires only for files past the per-round
sweep cap and those of a failed row. Default on; off ⇒ the round order
carries no coverage step (pinned). On the stored round-1 data it would fire on
63% of PRs, about 0.65 rows per PR.

### The lenses that read every changed line run at high effort

`pass-baseline`, `pass-sweep` and `pass-behaviour-delta` run at the
`sol-high` tier — gpt-6.1-sol at high effort — on every PR, by default
(`DEFAULT_PASS_TIERS` in `src/config.ts`, the code default of
`[models.pass_tiers]`; every other lens keeps its planned tier and its raise
ladder). The reason is measured: the same 30 PRs at
default effort and at high effort for these three lenses gave +6 AACR defects
(51 → 57 on 18 PRs, +3 medium on the miss set, no high-severity loss) and
2 more Qodo issues, for +18% cost per PR and +31% time; Martian's unmatched
comments rose with it (68 → 92), the accepted price (runs `dv1-*` vs
`dv1hi-*` in the published run archive).

Because the default is a `[models.pass_tiers]` pin, it reaches every install
whatever its profile (a profile that does not extend `default` included) and
the bench without any `--config`. The three lenses are therefore pinned: their
plan rows name `sol-high` and are not raisable. To lower it:

- **per install** — a `[models.pass_tiers]` entry in `config.toml` replaces
  that lens's default pin (`"pass-baseline" = "sol-med"`);
- **per repo profile** — `[lenses.<pass>] effort = "medium"` keeps the pin's
  tier name but gives that lens's variants the lower thinking level (every
  tier runs the same model, so effort is the lever that matters).

The validator is unaffected: it runs at its own `validate_tier` and never
follows a pinned lens.

## Lens-selection heuristics — `heuristics.toml`

Lens selection (`packages/pi-plugin/src/heuristics.ts selectLenses`) is split in two:

- **The generic core stays compiled in**: frontend extensions, wire-format
  files (`.proto`/`.graphql`), `migrations//backfills/` and raw SQL, auth and
  secret-shaped names, dependency manifests, infra/CI paths, queue and worker
  dirs, the placement/simplicity/backcompat structural signals, the
  pass-intent substance bar. These describe repos in general.
- **The repo-shaped predicates ride the profile**: framework settings-file
  globs (`settings*.py`), framework command dirs (`management/commands/`),
  product-local markers (`@background_decorator`), framework filename
  vocabulary (DRF's `serializers.py`/`views.py`/`urls.py`), and
  framework-specific flag-library names (`waffle`).

The file is one table per lens, with up to two keys:

```toml
[pass-security]
paths = ['(^|/)settings[^/]*\.py$']      # RegExp sources over changed filenames

[pass-delivery]
added_lines = ['@background_decorator']  # probes over ADDED diff lines
```

- **`paths`** — compiled verbatim, case-sensitive, matched against every
  changed filename; any match selects the lens (identical contract to the
  compiled-in path predicates).
- **`added_lines`** — each probe is wrapped as `^\+.*(?:…)` with the `im`
  flags: it matches an ADDED unified-diff line containing the pattern,
  case-insensitively, and only when the file's patch is available.
- **Extendable lenses only**: `pass-ui`, `pass-contracts`,
  `pass-data-safety`, `pass-security`, `pass-statelessness`,
  `pass-prod-risk`, `pass-delivery`, `pass-backcompat`. Not extendable:
  `pass-intent` (body-keyed, never file-shaped),
  `pass-placement`/`pass-simplicity` (computed from code-file status/size,
  not path membership), and `pass-concurrency`/`pass-ask-human`
  (deliberately no path predicate: one is planned by content, the other
  only on demand, never by file shape).
  `pass-concurrency` is planned by content alone, by the compiled sub-lens
  trigger in `packages/pi-plugin/src/heuristics.ts`: a changed line of a non-test code file that touches
  synchronisation in its own language — Go `sync.Mutex`/`RWMutex`/atomics/
  goroutines/channels, Java/Kotlin `synchronized`/`volatile`/`Lock`/
  `Concurrent*`/`Atomic*`, Rust `Mutex`/`RwLock`/`Arc`/atomics, C/C++
  `std::mutex`/`std::atomic`/pthreads, C# `lock`/`Interlocked`, Python
  `threading`/`asyncio` locks/`select_for_update`, Ruby/Swift locks, JS/TS
  workers, `Atomics` and a shared member written after an `await` — or a PR
  title/body that says race, data race, concurrent, thread-safe, lock or
  deadlock. A planned row's reason is the lens's anchor (the
  `concurrency-planned` addendum); on every other PR it stays addable.
- **ADD-only**: an extension can only add predicates. It cannot remove or
  weaken a compiled-in one, and cannot suppress a lens. If a core predicate
  is wrong for your repo, that is a code conversation, not a config knob.
  (Switching a whole lens off is a different, profile-level knob:
  `[lenses.<pass>] enabled = false` in `profile.toml`, above.)
- **Loud failure**: an unknown lens, unknown key, non-string entry or
  invalid regex throws at daemon assembly (`wire.ts`), exactly like a
  malformed addenda pack. An ABSENT `heuristics.toml` is fine — addenda-only
  profiles extend selection with nothing.

### Recorded split decisions

Two calls were judgment, so they are written down:

- **The `pass-statelessness` content probes stay compiled in** even though
  their spellings are Python (`@lru_cache`, `threading.Lock(`, module-level
  `= {}` / `= []` / `set()` / `defaultdict(`). They detect real
  cross-language smells — memoization over mutable state, in-process locks,
  module-level mutable collections — and Python is merely the spelling the
  corpus provided. They are multi-language-INTENT: a profile may ADD probes
  for other languages' spellings, never remove these. (The alternative —
  profile-only — would have made the minimal profile blind to a genuinely
  generic defect class.)
- **The flag probe split**: `feature.?flag`, `launch.?darkly` and `unleash`
  stay core (a generic phrase and two cross-language flag services);
  `waffle` moved to the Django profiles (`example-django/`) — it is a
  Django-specific library AND an ordinary English word, so in a generic core
  it would select `pass-backcompat` in any repo that mentions breakfast.

The equivalence proof lives in `tests/heuristics.test.ts`: a frozen verbatim
copy of the selection before the split, run against a corpus built from every
predicate's trigger and non-trigger cases — with a Django profile's
`heuristics.toml`, selection must match it EXACTLY (same lenses, same
order); with no extension, only the generic core may fire.

## Compiled review calibrations — round 4

General review rules the shipped behaviour carries for every profile, added
after a gap analysis (a benchmark working note, not in the public repo; its runs are in the published run archive) classified what the
default still missed on its tuning PRs. Each is a `PASS_ADDENDA` entry (rule
6: no seed is edited), composes into PR builds only, and is keyed to a bug
CLASS, never to a project or a benchmark comment. A profile cannot remove a
compiled addendum; `[lenses.<pass>] enabled = false` still switches the whole
lens off. Pinned by `tests/review-calibration-r4.test.ts`.

| id | binds | rule |
|---|---|---|
| `concurrency-duplicate-init` | pass-concurrency | a lazily filled value checked and then filled without a second check under the exclusive lock (or a once-only primitive) is falsified on its own terms, not as a lost update: pure cheap equal values are safe; repeated I/O is `P3`, side effects or diverging values `P2` |
| `write-predicate-scope` | pass-baseline, pass-data-safety | every OR branch of a DELETE/UPDATE filter (and every precedence group) must carry the scoping conditions — tenant, owner, type/method, status, parent; a branch without one rewrites or deletes other rows |
| `persistence-bypasses-callbacks` | pass-baseline, pass-data-safety | a new direct write (`delete_all`, `update_all`, through-association `delete`, queryset `update()`/`delete()`, bulk ops, bulk JPQL, raw SQL) is checked against what the model's lifecycle maintains — counter caches, dependent fields, cascades, audit/index hooks, validations |
| `removed-rule-other-consumers` | pass-ui, pass-sweep, pass-widened | a removed or changed style rule, selector, class, partial or key is grepped across every consumer — other pages, server-rendered/`noscript`/fallback templates, email/print, embeds, themes, snapshots — not just the component the PR targeted |
| `contract-values-renumbered` | pass-baseline, pass-backcompat, pass-contracts | exit codes, status/error codes, persisted or wire enum values, event/message ids, CLI flag, env and config names are contracts: a changed, renumbered, reused or renamed value is reported unless the PR keeps the old one working or declares the break; reuse is the worst case |
| `validate-external-semantics` | pass-validate | (absorbed the former `validate-documented-semantics`) a source the validator cannot open lowers `confidence` only, never `reachability`; documented core semantics (language/runtime, standard library, SQL engine limits and locking, datastore command types, HTTP, OS) are judged from their documentation, not turned into an external-assumption question |

## Replacing a shipped agent or prompt — the "customised" mark

A profile can do more than add rules: it can replace a shipped lens agent or
prompt outright. Two profiles may, and they are not equal.

- **Your profile** (the one `[review] profile` names, and the profiles it
  `extends`, in `<config home>/profiles/`) may carry `agents/<name>.md` and
  `prompts/<name>.md`. Each replaces the shipped file of that name for your
  reviews. On your own install it has the last word.
- **The repo's profile** is `.qcr/` in the reviewed repo, read from the
  **base commit** with git — never from the checkout or the PR head, so a PR
  cannot change the profile that reviews it. It sits under yours and can say
  less: `agents/`, `prompts/`, `addenda/`, `heuristics.toml` and a
  `profile.toml` cut down to `ecosystem`, `[lenses]`, `[scan]` and `[posting]`.
  Anything else in `.qcr/` (an extension, a config file, a symlink, a key such
  as `dry_run` or `[github]`) is dropped, and the review's `warnings` name each
  one.

Neither can reach the bash guard, the secret directories or the posting gate
(`dry_run`): they are not files a profile is read for. A replaced agent is
still built through the same pipeline, so it cannot launch other agents.

A file that has no shipped namesake replaces nothing and is reported. A copy of
a shipped file with identical bytes changes nothing and marks nothing. When a
replacement differs from the shipped file (the seed manifest's hash for a
seed, the file's own hash otherwise), the review is **customised**:

- `qcr review --json` carries `"customised": true` and `"overrides"`, one entry
  per replaced file (`path`, `origin`, `layer`, `sha256`, `shipped_sha256`,
  `seed`). Without a replacement it carries `"customised": false` and `[]`.
- the terminal summary and the markdown report close with a `Customised:` line;
- a posted review is signed `Posted by qcr (local review, customised profile)`.

The bench measures the shipped files, so it refuses a profile that replaces any
(`bench: profile "x" replaces shipped files …`). `--allow-customised` runs it
anyway, serves the replacements, and records `customised` and the replaced files
in the run's fingerprint.

The shipped seeds are never written. `seed-manifest.json` beside the code (the
image bakes it; a checkout reads `tests/fixtures/seed-manifest.json`) is what the
hashes are compared with.

## Experimental knobs (not for a profile)

`[review] validator_shards` (config.toml, default 1) is EXPERIMENTAL and
unvalidated. It splits the validator's candidates over N pass-validate children
and merges their verdicts. It was measured once, on a 19-lens PR
(a benchmark working note): the validator got slower (101 → 225 s), and the
merged record dropped every `doubted` and `downgraded` mark. It never earned the
default and is kept only as a switch for a future measured design. Leave it
at 1.

