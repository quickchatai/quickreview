# pi-memory wiring — the sandbox's learning substrate

Pinned: **`jayzeng/pi-memory` v0.4.2** (pi.dev registry package), per §2
(`~/src/tracker/efforts/review-sandbox/assets/findings.md`).
The name is heavily collided on the registry (unrelated `pi-memory` packages by
josephkern, catlain, @chendpoc) — **pin by author/repo, never by bare name**.
The pin is mirrored in `package.json` (`pi.extensions.pi-memory =
"github:jayzeng/pi-memory#v0.4.2"`) and must stay in lockstep with the
ansible `group_vars`. The image never floats.

Why this package and not `pi-hermes-memory`: pi-memory keeps plain markdown +
**deterministic** priority injection at session start; hermes's default
`policy-only` mode makes recall probabilistic and its search is FTS5 keyword-only.
Hermes's auto-consolidation and failure-log patterns are worth stealing as
patterns, not as a dependency.

## Who gets memory, and why (the cwd mechanism)

pi-memory is an in-process pi extension whose store is bound to the session's
**working directory**: it auto-creates its collection/path context from the cwd
at session start, and injects from that context before the model answers. So
"who gets memory" is decided purely by **where the session is started** — no
per-session flag, no prompt instruction:

| Session | cwd | Memory |
|---|---|---|
| Overseer | the sandbox root (`/opt/quickreview/sandbox`) | **yes** |
| Per-PR conversation sessions | the sandbox root | **yes** |
| Lens passes (blank-slate) | the PR's worktree (`wt/pr-<n>/`) | **no** |

Passes are deliberately blank-slate (spec §6): they must judge the diff on the
rubric alone, and are started with the worktree as cwd, which is a different
path context — so no memory is injected into them. What passes get instead is
**curated rubric updates**: the EOD sweep proposes `rubric/<lens>-<topic>-<date>`
branches that the owner merges into the pass agent files. That is the only channel
by which learnings reach a pass.

Corollary to protect: never start a pass with the sandbox root as cwd, and never
point a pass at this directory — that would silently give passes memory and
break the blank-slate property.

## Entry conventions (per `prompts/eod-sweep.md` §1)

One fact per entry, evidence-linked, written by the EOD sweep:

- `type`: `missed-finding` | `false-positive` | `refuted` | `wontfix-pattern` |
  `repo-gotcha` (plus `rejected-proposal` for a rubric proposal the owner
  rejected, with the reason — never re-propose it).
- the one-sentence lesson;
- the lens it belongs to;
- evidence PR link(s);
- the date.

No entry without evidence. Duplicates get consolidated; entries older than 90
days that never recurred are retired. The overseer additionally writes
*operational* lessons (pipeline quirks, recurring anomaly causes, the owner's
standing preferences); the EOD sweep owns review-content lessons.

## Storage layout (as documented upstream)

`~/.pi/agent/memory/` — `MEMORY.md` (long-term facts), `SCRATCHPAD.md` (open
actionables), `daily/` append-only logs, `recovery/` JSON records behind
`memory_restore`. Injection is priority-ordered and capped: open scratchpad
items (2K chars) → today's daily log (3K, tail) → `MEMORY.md` (4K,
middle-truncated) → yesterday's log (3K), 16K total. Optional semantic search
via `qmd` (keyword ≈30ms / semantic ≈2s / deep ≈10s). In the container this
lives under the mounted `pihome` (`/opt/quickreview/pihome`) so memory survives
image rebuilds.

## VERIFY-ON-PIN

Everything below was read from docs, not from a running install — confirm at
provisioning time, before the first live sweep:

- `VERIFY-ON-PIN` — exact registry/package coordinates and that `v0.4.2` still
  resolves to **jayzeng's** repo (name collision).
- `VERIFY-ON-PIN` — the install command and where an extension must be declared
  for pi to load it (config file vs. CLI flag), container-side only; pi is not
  installed in this build tree.
- `VERIFY-ON-PIN` — that the memory root honours `HOME=/opt/quickreview/pihome`
  (i.e. `~/.pi/agent/memory/` resolves inside the mount) and is writable by the
  container user.
- `VERIFY-ON-PIN` — that the store is really keyed by **cwd** (path context) in
  v0.4.2, so a worktree-cwd pass gets no injection. This is the load-bearing
  assumption of the whole passes-get-no-memory invariant: verify with one
  sandbox-cwd session and one worktree-cwd session before trusting it, and if it
  turns out to be host-global, disable the extension for pass sessions
  explicitly.
- `VERIFY-ON-PIN` — whether `qmd` is present in the image and whether the
  background embed at session start is acceptable latency for a pass-heavy day.
- `VERIFY-ON-PIN` — the exact entry-write tool/format (`memory_write`?) that the
  sweep prompt's conventions map onto.
