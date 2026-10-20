# AGENTS.md — working in this repository

## What this is

QuickReview is a 24/7 AI code reviewer for a GitHub repository: a deterministic
TypeScript daemon receives GitHub App webhooks, runs an authoritative reconcile
poll, and drives sticky **pi** coding-agent sessions in tmux — one conversation
per pull request, blank-slate single-concern "lens" passes per review round, and
an adversarial validator before anything is posted. No language model runs in
the daemon's own decision path: the daemon selects lenses, prepares worktrees,
applies posting-time guards, and executes every GitHub write through one gate;
the sessions produce findings and a verdict file the daemon validates. Around
that core sit an operator TUI, a Slack concierge, an OpenViking-backed memory
engine, and a guided onboarding wizard, each of which degrades cleanly when it
is not configured.

Read [`README.md`](README.md) for what the system does for its user, and
[`MANIFESTO.md`](MANIFESTO.md) for the beliefs it implements. This file is the
map for *changing* it.

## Build, test, typecheck

```sh
npm ci
timeout 900 npm test        # vitest; the whole suite, offline, no secrets
npm run build               # tsc -p tsconfig.json, then scripts/verify-dist.mjs
npm run typecheck:tests     # tsc -p tsconfig.tests.json (tests/ is not in the build)
```

All three must be green before you commit. Notes that will bite otherwise:

- Never pass `--reporter=basic`; run a single file as
  `timeout 120 npx vitest run tests/<file>.test.ts`.
- `tests/` is excluded from `tsconfig.json` (it emits nothing), so the build
  does not typecheck it. `tests/fences-gate.test.ts` runs
  `tsc -p tsconfig.tests.json` as part of the suite, which is why a type error
  in a test fails `npm test`.
- `npm run build` chains `scripts/verify-dist.mjs` because `incremental` +
  `noEmitOnError` mean tsc decides what to emit from its build info, not from
  what is on disk — a targeted `rm` inside `dist/` will not be rebuilt. The
  reliable cold build is `rm -rf dist node_modules/.cache && npm run build`.
- `vitest.config.ts` restricts collection to `tests/**` on purpose: the default
  globs also collect agent worktrees under `.claude/worktrees/`, which then
  judge this checkout's seeds against another branch's expectations.

## Conventions

- **TypeScript strict**, plus `noUncheckedIndexedAccess` and
  `noImplicitOverride` (`tsconfig.json`). Node **≥ 22** (`package.json`
  `engines`).
- **ESM, `module: NodeNext`** — local imports carry the **`.js` suffix** even
  from `.ts` files.
- **Minimal dependencies.** Runtime: `better-sqlite3`, `smol-toml`,
  `@xterm/headless`, `node-pty`. Dev: `typescript`, `vitest`, `@types/*`,
  `eslint` + `@eslint/js` + `typescript-eslint`, `prettier`. Adding
  one is a decision, not a convenience.
- **Tests mock all I/O**: fake fetch and adapters, `StateStore(":memory:")`,
  temp directories. The suite must stay green **offline, with no secrets, on a
  fresh clone** — a stranger's first command is the suite. A handful of suites
  spawn real subprocesses because the subprocess *is* the thing under test (the
  worktree manager against a scratch git repo, the shell posting scripts against
  a loopback HTTP stub, the CLI and deploy preflight); the current set is
  `PROCESS_SUITES` in `tests/helpers/suite-timeouts.ts`.
- **Extensions are factories over explicit config.** Nothing under
  `extensions/` reads `process.env`, `process.cwd()`, `process.argv` or
  `os.homedir()` (an ESLint ban, `tests/extension-lint-ban.test.ts`). A pi that
  loads an extension by path loads its env shim, `extensions/cli/<name>.ts`,
  the one place the process becomes config; an SDK session builds the factory
  (`createX(config)`) itself.
- **Every behaviour change needs a test at the seam it changes.** See
  [`tests/AGENTS.md`](tests/AGENTS.md) for the house style.
- **Fences are verified by mutation.** A structural test that cannot be made to
  fail is not a fence, so each one names, in its own comment, the exact mutation
  that proves it bites (`MUTATION: add "retract_review" to MUTATION_KINDS — this
  fails`). Two more rules go with it, both learned from fences that looked right
  and proved nothing: **grep for a reader, never for a name** (a name appears in
  its own declaration), and **a derived set can be satisfied by a self-loop** (so
  reachability fences do a real traversal from the initial state). The rules are
  stated at the top of [`tests/fences.test.ts`](tests/fences.test.ts).
- **Legacy input folds are load-bearing.** Retired spellings stay accepted on
  input forever and are pinned by `tests/legacy-acceptance.test.ts`. Do not
  "clean them up" — a container somewhere is still running the older prompt.

## Invariants an agent must never break

These are structural: each is enforced by code shape or by a pinned test, not by
convention. If your change trips one, the change is wrong — fix the code, never
the fence.

1. **One mutation gate.** Every GitHub write goes through `src/gate.ts`, whose
   `MUTATION_KINDS` is a closed list; an unknown kind throws. Reads go direct
   (`src/github.ts`). The gate reads the caller's intent **once** into a frozen
   snapshot and admits that snapshot; guards receive it and may **soften** a
   mutation (body, note) but can never change which mutation it is, and the
   result is re-admitted in full before anything executes. Never add a write
   path around the gate.
2. **No review dismissal exists.** There is no mutation kind that dismisses,
   retracts, withdraws or revokes a review, and
   [`tests/fences-gate.test.ts`](tests/fences-gate.test.ts) fences the *name
   shape*, not a list of four names people thought of. Guards only refuse or
   soften.
3. **Frozen prompt seeds.** `prompts/` and `agents/` seeded content is canonical
   and byte-pinned against `seeds/` by
   [`tests/seed-integrity.test.ts`](tests/seed-integrity.test.ts) (sha256
   manifest + provenance comparison). A genuine reseed is the owner's to ratify
   and is recorded in `tests/fixtures/ratified-divergence.json`, which stays
   hash-pinned so further drift still fails. Inside the files that *are* ours to
   edit, ratified passages sit between `<!-- RATIFIED … -->` markers whose
   contents are hashed by
   [`tests/invariant-fences.test.ts`](tests/invariant-fences.test.ts) — edit
   around a fence, never inside one, and deleting the marker fails just as
   loudly.
4. **Pass behaviour changes go through the addendum registry.** `PASS_ADDENDA`
   in `src/include.ts` composes binding rules onto the **built** pass bodies in
   `state/agents/`; repo-specific house rules go in a profile pack
   (`profiles/<name>/addenda/`, loaded by `src/profiles.ts`). Both are the same
   mechanism — a pack extends the registry rather than bypassing it. There is no
   third path.
5. **The reviewer reads code; it never executes it.** Five independent layers
   hold that boundary — a git config-scope pin on the session argv
   (`src/sessions.ts`), a command guard (`extensions/bash-guard.ts`), a write
   veto over git's configuration surface *and* this system's own policy surface,
   a round-boundary integrity fingerprint (`src/execboundary.ts`), and an
   ungated-review outcome detector. None may be traded for another; the
   command-string layers are explicitly **not** claimed to be closed. Read
   [`docs/exec-boundary.md`](docs/exec-boundary.md) — including its review
   discipline — before touching any of them, and extend the `CORPUS` in
   `tests/exec-boundary.test.ts`.
6. **`dry_run` is the operator's flag alone.** It ships `true`; in dry-run the
   gate writes each intended call to `state/dryrun/` instead of executing it.
   Nothing in the codebase may move it in either direction. The one class that
   executes anyway is `APP_SELF_CONFIG_KINDS` in `src/gate.ts` — a closed set
   pinned by deep equality, so adding a member fails `tests/gate.test.ts`. See
   [`docs/ownership.md`](docs/ownership.md) for every owner-only surface.
7. **Single shepherd.** Two daemon-owned session kinds exist: one main session
   per PR and one global overseer. The daemon *nudges* (round order, wake file)
   and never schedules an agent; lens passes are leaves, enforced at agent build
   time by `src/include.ts` stripping spawn tools. Anything wanting a session's
   attention mid-round goes through `wakeOrHold` in `src/wakes.ts`. Pinned by
   `tests/single-shepherd.test.ts`; the topology is
   [`docs/single-shepherd-invariant.md`](docs/single-shepherd-invariant.md).
8. **One memory seam, one engine.** Every read and write of reviewer memory goes
   through `MemoryStore` (`src/memory/store.ts`), whose single implementation is
   `src/openviking/store.ts`. Two absolutes at every call site: memory never
   blocks or delays a round (a dead server is a refusal, never a throw), and no
   caller ever holds an admin or root key.
9. **Honest-unknown rendering.** A surface that cannot read its source renders
   *unknown* — never a zero, never a default. It has two halves and fixing only
   the first is the trap: the rendered value **and** every action or published
   fact derived from the same missing data (an unknown container state means no
   click target, and the companion-facing field is `null` rather than absent, so
   a dropped line cannot read as "nothing to report"). The TUI's first frame is
   painted before any network, docker or filesystem call —
   `tests/tui-startup.test.ts` asserts that structurally, with a wall-clock
   budget as a warning only.
10. **The TUI has one layout**: the tab on the left, the companion column on the
    right, on every frame and in every configuration. No full-screen takeover, no
    collapsed spine, no no-column mode; configuration decides what *runs* and
    what the column *says*, never whether it is there. Fenced structurally by
    [`tests/tui-fixed-layout.test.ts`](tests/tui-fixed-layout.test.ts) (a module
    that must not exist, a hook with no name, a state field not on the class).

## Where things live

| Concern | Modules |
|---|---|
| Ingress | `src/webhook.ts` (HMAC, delivery dedupe), `src/reconcile.ts` (the authoritative poll — GitHub always wins) |
| Lifecycle | `src/statemachine.ts` (transition table in the module header), `src/state.ts` (SQLite + `status.json` snapshot) |
| Round planning | `src/dispatch.ts` (FIFO, concurrency cap), `src/heuristics.ts` (lens selection), `src/ecosystem.ts` + `src/migrations.ts` (framework pre-checks), `src/profiles.ts` |
| Prompt assembly | `src/include.ts` (`{{include:}}`, tier rewriting, `PASS_ADDENDA`), `src/templates.ts` (round templates) |
| Sessions | `src/sessions.ts`, `src/tmux.ts`, `src/worktrees.ts`, `src/wakes.ts`, `extensions/inject-bridge.ts` |
| Verdict + posting | `src/verdicts.ts`, `src/gate.ts`, `src/guards.ts`, `src/cigate.ts`, `src/standing-review.ts`, `src/posting.ts`, `src/anchors.ts`, `scripts/post-review.sh` + `scripts/guards.sh` |
| Review judgment | `src/severity.ts` (severity × confidence × reachability → tag), `src/recheck.ts`, `src/pingpong.ts`, `src/escalation.ts` |
| Learning | `src/feedback.ts`, `src/eod.ts`, `src/digest.ts`, `src/findingsrecord.ts`, `src/improvements.ts` |
| Memory | `src/memory/` (the seam), `src/openviking/` (the engine, supervised on loopback) |
| Operator surfaces | `src/tui/` (board, tabs, companion column), `src/cli.ts` (`qcr`), `src/slack/`, `src/commands.ts` + `src/levers.ts` |
| Assembly | `src/daemon.ts` (stub-wired core, test-friendly) vs `src/wire.ts` (production wiring) |
| Onboarding | `src/onboard/`, `extensions/onboarding.ts`, [`docs/onboarding.md`](docs/onboarding.md) |

`agents/`, `prompts/`, `skills/companion/` and `extensions/` are shipped bot
content (what the reviewer and companion sessions load); `.claude/` is
contributor tooling for working on this repo.

Per-concern architecture documents — one mechanism per page, each naming the
modules it describes — live under
[`docs/architecture/`](docs/architecture/).

## How to make the four common changes

**Add or change a lens rule.** Add an entry to `PASS_ADDENDA` in
`src/include.ts` (scope `"all"`, `"lenses"`, or a named lens list; declaration
order is composition order), or, for house rules about one repository, a file
under `profiles/<name>/addenda/`. Do **not** edit a seed under `agents/` or
`prompts/`. Fences that will fail if you do: `tests/seed-integrity.test.ts`
(byte identity), `tests/invariant-fences.test.ts` (a ratified passage), and
`tests/include.test.ts` (the composed result). See
[`docs/profiles.md`](docs/profiles.md).

**Add a config knob.** Parse it in `src/config.ts`, document it in
`config.example.toml`, and **consume it somewhere else**.
[`tests/fences-config.test.ts`](tests/fences-config.test.ts) fails a knob that
is parsed and never read — the check deliberately excludes the parser, because a
name appears in its own declaration. `tests/config.test.ts` and the
publishability lint both parse `config.example.toml`, so it must stay valid.

**Add a TUI surface.** Register its keys in the surface's vocabulary and name
them in the help overlay: `tests/fences-tui.test.ts` asserts both directions,
because a registered key with no reachable effect does not merely do nothing —
`App.handleInput` routes any unregistered printable to the companion column, so
a dead registration *steals* the keystroke. The same file fails an action-union
variant that nothing constructs (a click target that cannot be clicked), and
`tests/tui-fixed-layout.test.ts` fails anything that takes the terminal or folds
the column. Contract: [`docs/tui.md`](docs/tui.md).

**Add a gate kind.** Add it to `MUTATION_KINDS` in `src/gate.ts` and give it a
caller. It must be ordinary: suppressed in dry-run, refused for `forceLive`, and
outside `APP_SELF_CONFIG_KINDS`. `tests/fences-gate.test.ts` rejects any name
suggesting dismissal; `tests/gate.test.ts` pins the two closed sets by deep
equality. If the new kind posts to GitHub from a session, its shell script must
source `scripts/guards.sh` and call the guards its route needs —
`tests/fences-guards.test.ts` derives that coverage from the call sites, and
`tests/guards-shell-*.test.ts` runs the real scripts against a loopback stub over
the same cases the gate suite runs in TypeScript.

## Two more things to know

- **The publishability lint** ([`tests/publishability.test.ts`](tests/publishability.test.ts))
  walks every tracked file except those excluded by `publish-manifest.json` and
  fails on private tokens — personal names, private hosts and org names, absolute
  home paths, internal tracker paths. It carries a negative control that plants a
  token and proves the scanner bites. If your change trips it, fix the content; an
  allowlist entry needs a named file, a named token and a real reason.
- **`FT-####` citations** in comments, tests and commit messages are ids from the
  project's internal design-history tracker, explained in
  [`docs/provenance.md`](docs/provenance.md). They are context, not something you
  need for new work.

Contributor-facing rules — what a pull request needs — are in
[`CONTRIBUTING.md`](CONTRIBUTING.md).
