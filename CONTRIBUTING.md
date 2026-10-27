# Contributing

Thanks for looking at QuickReview. The project is small, strict and
test-driven, and every pull request costs CI time and a maintainer's
reading time. The process below keeps both well spent. A PR that skips it
fails the intake check and may be closed without review.

Everyone taking part, in issues, pull requests and reviews, follows the
[Code of Conduct](CODE_OF_CONDUCT.md).

## How a change gets in

1. **Start from an issue.** Open one, or pick an open one, before you write
   code: a bug with what you saw and how to reproduce it, or a proposal with
   the problem it solves. Every PR links an open issue in this repository.
   Changes that add a dependency, a config knob or a new surface need the
   issue discussed before the PR.
2. **Fork and branch.** Work on a branch in your own fork. Branches in this
   repository are for maintainers; every outside PR comes from a fork.
3. **Build and test** (below). Keep the change small and about one thing.
4. **Review it with QuickReview** on the default profile (below), and deal
   with what it finds.
5. **Open the PR from your fork.** Fill in the template: `Closes #<issue>`,
   what changed and why, how you tested it, and the review report. Open it
   as a draft until the template is complete.
6. **Mark it ready for review** when the template is complete. A PR asking
   for review without an open issue linked or without the review report
   fails the intake check, with a comment that says what is missing; edit
   the description and the check runs again.
7. **A maintainer reads it and approves the CI run.** CI does not start on
   an outside contributor's PR until a maintainer approves it, and it runs
   on GitHub's hosted runners, so a full run takes up to half an hour.
   Maintainers may also run their own QuickReview round on the PR; that is
   theirs to decide, and it does not replace yours.

There is a limit on how many PRs one contributor can have open at a time.
Finish or close one before you start the next.

## Reviewing your change with QuickReview

Every PR carries a QuickReview report of its own diff, run by you, on the
shipped review settings: the `default` profile and the `default` preset.
No custom profile, no other preset.

```sh
npm i -g @quickchatai/quickreview    # or scripts/qcr from your clone, after npm ci && npm run build
qcr login                            # your own model login; the run is billed to it

git remote add upstream https://github.com/quickchatai/quickreview.git
git fetch upstream
qcr review --base upstream/main --preview                 # the plan and the price; nothing starts
qcr review --base upstream/main --out qcr-review.md       # the review, saved as markdown
```

The settings live in your install's `config.toml` (`qcr install where`
prints where):

```toml
[review]
preset = "default"
profile = "default"
```

Paste `qcr-review.md` into the PR's "QuickReview self-review" section, and
under it say what you did with each finding: fixed, or not fixed and why. A
finding you think is wrong is fine to leave; say why in one line. If you push
changes after the review, run it again before you mark the PR ready: a second
run reviews only what changed since the last one. Don't post the review to
the PR (`--to pr`); paste it.

## Build and test

```sh
npm ci
npm run build             # tsc -b, must be clean
npm run typecheck:tests   # the tests are not in the build
npm test                  # vitest, 13,000+ tests, all I/O mocked, no secrets
npm run lint              # ESLint with type-aware rules
npm run format:check      # Prettier; `npm run format` to fix
```

The whole suite takes several minutes. While you work, run the files you
touch: `timeout 120 npx vitest run tests/<file>.test.ts`.

The suite is required to stay green **offline with no secrets on a fresh
clone**. That property is part of the spec, because a stranger's first
command is the suite. Tests mock all I/O (fake fetch/adapters, in-memory
SQLite, temp dirs); the few tests that touch the real world (scratch git
repos, shell scripts against a loopback HTTP stub, local subprocesses) are
listed in `tests/AGENTS.md`.

Conventions: TypeScript strict, ESM (`"type": "module"`, NodeNext; local
imports use the `.js` suffix), Node ≥ 26, minimal dependencies. The map for
changing the code is [AGENTS.md](AGENTS.md).

## Running from a clone

Users run QuickReview from the released image or the npm package
([README](README.md#quickstart)). A clone is the developer route: it is
tested in CI (the `clone` job: a fresh checkout, `npm ci`, `npm run build`,
`scripts/qcr version --json` and `scripts/qcr review --preview --json` on a
fixture, no Docker and no model) but not promised in the user docs.

```sh
scripts/qcr home        # the home (a bare `qcr`), from the checkout
scripts/qcr tui         # the operator board
```

From a clone the home loads the checkout's own plugin and home extension; to
run a locally built image through `docker-compose.yml`, see the last section
of [docker/README.md](docker/README.md).

## The rules that will surprise you

1. **Frozen prompt seeds.** `prompts/` + `agents/` seeded content is
   canonical and integrity-pinned (`tests/seed-integrity.test.ts`: sha256
   manifest + byte-identity against `seeds/`). Never edit a seed in a PR.
   Pass-behaviour changes go through the **addendum registry**
   (`PASS_ADDENDA` in `packages/pi-plugin/src/include.ts`) or a **profile pack**
   (`profiles/<name>/addenda/`; see [docs/profiles.md](docs/profiles.md)).
   A genuine reseed is the owner's to ratify; see
   [docs/ownership.md](docs/ownership.md), which lists every owner-only
   surface (the dry-run flag, ratification fences, the divergence registry,
   rubric acceptance, the caps).
2. **One mutation gate.** Every GitHub write flows through
   `packages/pi-plugin/src/gate.ts`. Never add a write path around it, and
   never add a review-dismissal mutation: that one is structurally absent on
   purpose. `request_reviewer` exists (the optional, off-by-default escalation
   feature) but is an ordinary kind with no special case: suppressed in
   dry-run, never `forceLive`, reachable only from `src/escalation.ts` and
   only towards a configured target.
3. **Legacy folds are load-bearing.** Retired spellings (old tier strings,
   old command names, `ESCALATE`) stay accepted on input forever and are
   pinned by `tests/legacy-acceptance.test.ts`. Don't "clean them up".
4. **The publishability lint** (`tests/publishability.test.ts`) fails on
   private tokens in tracked files. If your change trips it, fix the content;
   an allowlist entry needs a named file, a named token, and a real reason.
5. **Profile packs are the extension surface.** House rules, lens-selection
   predicates, and ecosystem pre-check selection belong in a profile
   directory, not in core code. If you want the reviewer to know something
   about *your* repo, write a pack (start from `profiles/example-django/`).

## What makes a PR easy to merge

- One concern per PR. No drive-by reformatting or renames outside it.
- Every behaviour change has a test at the seam it changes (see
  `tests/AGENTS.md` for the house test style). A structural fence names the
  mutation that proves it bites ([AGENTS.md](AGENTS.md#conventions)).
- Code written with an AI assistant is welcome. You own it all the same: you
  have read every line, run it, and can answer for it in review.
- Commit messages say what changed and why, in plain sentences.

## Reporting bugs and security issues

Bugs: open a GitHub issue with the daemon log excerpt and, if it is about
review behaviour, the round's verdict and ledger context. Security
vulnerabilities: **do not open a public issue**; see [SECURITY.md](SECURITY.md).

## License

By contributing you agree that your contribution is licensed under the
project's [MIT License](LICENSE).
