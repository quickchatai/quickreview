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

The repository publishes two npm packages. The root is
`@quickchatai/quickreview`, the whole app with the `qcr` bin (TUI, daemon,
companion, every verb); the release image runs this same package.
`packages/pi-plugin` is `@quickchatai/pi-quickreview`, the review core and
the pi plugin over it (`/qcr-review`, `/qcr-scan`, `/qcr-setup`, each also a
skill), installable on its own with `pi install npm:@quickchatai/pi-quickreview`.
The app depends on the core at its exact version, and its own pi (`qcr pi`)
adds `/selfimprove`.

Read [`README.md`](README.md) for what the system does for its user, and
[`MANIFESTO.md`](MANIFESTO.md) for the beliefs it implements. This file is the
map for *changing* it.

## Architecture decisions

The decisions that shape the repository, each with its reasons and the
options it rejected, are recorded in [`docs/adr/`](docs/adr/README.md). Read
the index before a change that moves code between packages or adds a surface.

- [ADR 0001](docs/adr/0001-plugin-and-app-nest.md): **the plugin and the app
  nest.** The plugin (`packages/pi-plugin`) is what plain pi needs to review.
  The app is the managed product around it: the home, setup, auto-review and
  the TUI. Each works without the one outside it.

## Build, test, typecheck

```sh
npm ci
timeout 900 npm test        # vitest; the whole suite, offline, no secrets
npm run build               # tsc -b (packages/pi-plugin, then the app), verify-dist, the build stamp
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
  reliable cold build is
  `rm -rf dist packages/*/dist node_modules/.cache && npm run build`.
- `tsc -b` builds two projects in order: the core into
  `packages/pi-plugin/dist/`, then the app into `dist/`. `noEmitOnError` holds
  per project, so a core edit that breaks the app still rewrites the core's
  `dist/`. That is why "a whole build finished" is its own signal: every build
  route (`npm run build`, `scripts/tsc-watch.mjs` after each clean pass,
  `scripts/dev-tui.sh`) runs `scripts/build-stamp.mjs`, which touches
  `state/build-complete` only after a whole pass succeeded. The TUI's hot
  reload (`src/tui/reload.ts`) watches the app's `dist/` and that stamp, never
  the core's `dist/`.
- `vitest.config.ts` restricts collection to `tests/**` on purpose: the default
  globs also collect agent worktrees under `.claude/worktrees/`, which then
  judge this checkout's seeds against another branch's expectations.

## Conventions

- **TypeScript strict**, plus `noUncheckedIndexedAccess` and
  `noImplicitOverride` (`tsconfig.json`). Node **≥ 26** (`package.json`
  `engines`).
- **ESM, `module: NodeNext`** — local imports carry the **`.js` suffix** even
  from `.ts` files.
- **Two layers, fenced.** The review core is its own package, the npm
  workspace `packages/pi-plugin` (`@quickchatai/pi-quickreview`), with its own
  `src/` and `extensions/`. **Core** is everything under `packages/pi-plugin/`;
  **app** is the rest of the repo. The app imports the core by package
  specifier, `@quickchatai/pi-quickreview/src/<file>.js`; the core imports
  only itself, pi's root specifiers, `smol-toml` and `node:*`, never the app.
  The core never owns the process either: no `process.exit`, `process.cwd`,
  `console`, `homedir` or `node:readline` (a host passes those facts in),
  except the plugin's entry, `src/plugin/index.ts`, which may read the home.
  Which package a responsibility belongs in is
  [ADR 0001](docs/adr/0001-plugin-and-app-nest.md).
  `tests/layers.test.ts` holds both rules on the real tree
  (`tests/helpers/layers.ts`), and its ratchet,
  `tests/helpers/layer-allowlist.ts`, is empty and stays empty: a violation is
  fixed by moving code, never by an allowlist entry. A test resolves the
  specifier to the core's sources (`vitest.config.ts`,
  `tsconfig.tests.json`), and a fence that walks the source walks both trees
  (`tests/helpers/source-trees.ts`).
- **The core's data stays at the root.** `prompts/`, `agents/`, `seeds/`,
  `schemas/`, `profiles/`, `deploy/reviewer/`, the seed manifest and
  `config.example.toml` have one source, the repo root. The plugin's
  `prepack` copies them into `packages/pi-plugin/assets/`
  (`scripts/plugin-assets.mjs`), checks every copy's sha256 against its
  source, and its `postpack` removes the copy again; `assets/` is gitignored
  and never edited. The core finds its data through `assetRoot`
  (`packages/pi-plugin/src/assetroot.ts`): `assets/` in an installed package,
  the repo root in a checkout or the image. The seeds sit under `assets/`,
  not at the package root, because pi turns a package's `prompts/` into slash
  commands.
- **Minimal dependencies.** Runtime: `better-sqlite3`, `smol-toml`. Dev: `typescript`, `vitest`, `@types/*`,
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
  The one exception is a record under `docs/adr/` that rules otherwise:
  [ADR 0001](docs/adr/0001-plugin-and-app-nest.md) drops the plugin's
  unprefixed pi commands.

## Invariants an agent must never break

These are structural: each is enforced by code shape or by a pinned test, not by
convention. If your change trips one, the change is wrong — fix the code, never
the fence.

1. **One mutation gate.** Every GitHub write goes through `packages/pi-plugin/src/gate.ts`, whose
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
   in `packages/pi-plugin/src/include.ts` composes binding rules onto the **built** pass bodies in
   `state/agents/`; repo-specific house rules go in a profile pack
   (`profiles/<name>/addenda/`, loaded by `packages/pi-plugin/src/profiles.ts`). Both are the same
   mechanism — a pack extends the registry rather than bypassing it. There is no
   third path.
5. **The reviewer reads code; it never executes it.** Five independent layers
   hold that boundary — a git config-scope pin on the session argv
   (`src/sessions.ts`), a command guard (`packages/pi-plugin/extensions/bash-guard.ts`), a write
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
   executes anyway is `APP_SELF_CONFIG_KINDS` in `packages/pi-plugin/src/gate.ts` — a closed set
   pinned by deep equality, so adding a member fails `tests/gate.test.ts`. See
   [`docs/ownership.md`](docs/ownership.md) for every owner-only surface.
7. **Single shepherd.** Two daemon-owned session kinds exist: one main session
   per PR and one global overseer. The daemon *nudges* (round order, wake file)
   and never schedules an agent; lens passes are leaves, enforced at agent build
   time by `packages/pi-plugin/src/include.ts` stripping spawn tools. Anything wanting a session's
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
| Round planning | `src/dispatch.ts` (FIFO, concurrency cap), `packages/pi-plugin/src/planner.ts` (the lens plan, follow-up rounds, the round order), `packages/pi-plugin/src/heuristics.ts` (lens selection), `packages/pi-plugin/src/ecosystem.ts` + `packages/pi-plugin/src/migrations.ts` (framework pre-checks), `packages/pi-plugin/src/profiles.ts` |
| Prompt assembly | `packages/pi-plugin/src/include.ts` (`{{include:}}`, tier rewriting, `PASS_ADDENDA`), `packages/pi-plugin/src/templates.ts` (round templates) |
| Sessions | `src/sessions.ts`, `src/tmux.ts`, `src/worktrees.ts`, `src/wakes.ts`, `extensions/inject-bridge.ts` |
| Verdict + posting | `src/verdicts.ts`, `packages/pi-plugin/src/gate.ts`, `packages/pi-plugin/src/guards.ts`, `packages/pi-plugin/src/cigate.ts`, `packages/pi-plugin/src/standing-review.ts`, `src/posting.ts`, `packages/pi-plugin/src/anchors.ts`, `src/postops.ts`, the session shims `scripts/post-review.sh`, `approve-pr.sh`, `reply-thread.sh` |
| Review judgment | `packages/pi-plugin/src/severity.ts` (severity × confidence × reachability → tag), `src/recheck.ts`, `src/pingpong.ts`, `src/escalation.ts` |
| Learning | `src/feedback.ts`, `src/eod.ts`, `src/digest.ts`, `packages/pi-plugin/src/findingsrecord.ts`, `src/improvements.ts` |
| Memory | `src/memory/` (the seam), `src/openviking/` (the engine, supervised on loopback) |
| Operator surfaces | `src/tui/` (board, tabs, companion column), `src/cli.ts` (`qcr`), `src/slack/`, `src/commands.ts` + `src/levers.ts` |
| Assembly | `src/daemon.ts` (stub-wired core, test-friendly) vs `src/wire.ts` (production wiring) |
| Onboarding | `src/onboard/`, `extensions/onboarding.ts`, [`docs/onboarding.md`](docs/onboarding.md) |
| The home (a bare `qcr`) | `src/home/launch.ts` (the pinned pi, quiet, on the person's own pi home), `extensions/home.ts` (`createHome` over the ports; every action a key and a `home_*` tool), `src/home/model.ts` (state and actions), `src/home/panel.ts` (the overlay), `src/home/ports.ts` + `src/home/adapters.ts` |
| The pi plugin | `packages/pi-plugin/src/plugin/` (the entry `index.ts`, the commands, `versiongate.ts` for the `^1.4.0` pi range, `login.ts` for the borrowed host login), `packages/pi-plugin/src/reviewapi.ts`, [`packages/pi-plugin/README.md`](packages/pi-plugin/README.md) |
| The npm CLI | `bin/qcr.js` → `src/qcrbin.ts` (the bin's front door: bare `qcr`, `review`, `login`, `pi`, `update`, `version`), `src/npmverbs.ts`, `src/updatenotice.ts`; every other verb goes to `src/cli.ts` |

`agents/`, `prompts/`, `skills/companion/` and `extensions/` are shipped bot
content (what the reviewer and companion sessions load); `.claude/` is
contributor tooling for working on this repo.

Per-concern architecture documents — one mechanism per page, each naming the
modules it describes — live under
[`docs/architecture/`](docs/architecture/).

## How to make the four common changes

**Add or change a lens rule.** Add an entry to `PASS_ADDENDA` in
`packages/pi-plugin/src/include.ts` (scope `"all"`, `"lenses"`, or a named lens list; declaration
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

**Add a gate kind.** Add it to `MUTATION_KINDS` in `packages/pi-plugin/src/gate.ts` and give it a
caller. It must be ordinary: suppressed in dry-run, refused for `forceLive`, and
outside `APP_SELF_CONFIG_KINDS`. `tests/fences-gate.test.ts` rejects any name
suggesting dismissal; `tests/gate.test.ts` pins the two closed sets by deep
equality. If the new kind posts to GitHub from a session, it is a new op on
the daemon (`src/postops.ts`), never a shell route: the session shims only
hand the daemon their result files ([`scripts/AGENTS.md`](scripts/AGENTS.md)),
and the guard cases for it go in `tests/guards.test.ts`, which runs them
through the real gate.

## Two more things to know

- **The publishability lint** ([`tests/publishability.test.ts`](tests/publishability.test.ts))
  walks every tracked file — the repository is public in full — and fails on
  private tokens: personal names, private hosts, absolute home paths, internal
  tracker paths. The tokens come from a denylist kept outside the repository
  (see `tests/AGENTS.md`), so the lint names none of them, and without it
  those checks skip; credential shapes are checked always. It carries a negative control that plants a canary and proves the
  scanner bites. If your change trips it, fix the content; an allowlist entry
  needs a named file, the kind of token and a real reason.
- **Decisions** are recorded before they are built; comments state the rule, not
  who decided it ([`docs/provenance.md`](docs/provenance.md)).

Contributor-facing rules — what a pull request needs — are in
[`CONTRIBUTING.md`](CONTRIBUTING.md).
