# Contributing

Thanks for looking at quickreviewd. This project is small, strict, and
test-driven; the rules below are the ones that will actually affect your PR.

## Build and test

```sh
npm ci
npm test          # vitest, ~1600 tests, seconds — all I/O mocked, no secrets
npm run build     # tsc, must be clean
```

The suite is required to stay green **offline with no secrets on a fresh
clone** — that property is part of the spec, because a stranger's first
command is the suite. Tests mock all I/O (fake fetch/adapters, in-memory
SQLite, temp dirs); the only real-subprocess tests are the worktree suite
(scratch git repo) and the shell-guard parity suite (loopback HTTP stub).

Conventions: TypeScript strict, ESM (`"type": "module"`, NodeNext — local
imports use the `.js` suffix), Node ≥ 22, minimal dependencies.

## The rules that will surprise you

1. **Frozen prompt seeds.** `prompts/` + `agents/` seeded content is
   canonical and integrity-pinned (`tests/seed-integrity.test.ts`: sha256
   manifest + byte-identity against `seeds/`). Never edit a seed in a PR.
   Pass-behaviour changes go through the **addendum registry**
   (`PASS_ADDENDA` in `src/include.ts`) or a **profile pack**
   (`profiles/<name>/addenda/` — see [docs/profiles.md](docs/profiles.md)).
   A genuine reseed is the owner's to ratify — see
   [docs/ownership.md](docs/ownership.md), which lists every owner-only
   surface (the dry-run flag, ratification fences, the divergence registry,
   rubric acceptance, the caps).
2. **One mutation gate.** Every GitHub write flows through `src/gate.ts`
   (shell twin: `scripts/guards.sh`). Never add a write path around it, and
   never add a review-dismissal or reviewer-nomination mutation — those are
   structurally absent on purpose.
3. **Legacy folds are load-bearing.** Retired spellings (old tier strings,
   old command names, `ESCALATE`) stay accepted on input forever and are
   pinned by `tests/legacy-acceptance.test.ts`. Don't "clean them up".
4. **The publishability lint** (`tests/publishability.test.ts`) fails on
   private tokens in tracked files. If your change trips it, fix the content
   — an allowlist entry needs a named file, a named token, and a real reason.
5. **Profile packs are the extension surface.** House rules, lens-selection
   predicates, and ecosystem pre-check selection belong in a profile
   directory, not in core code. If you want the reviewer to know something
   about *your* repo, write a pack (start from `profiles/example-django/`).

## Submitting changes

- Keep PRs small and behaviour-focused; every behaviour change needs a test
  at the seam it changes (see `tests/CLAUDE.md` for the house test style).
- Run `npm test && npm run build` before pushing.
- Reference the issue you're addressing. FT-#### ids you'll find in comments
  are the project's internal design-history citations
  ([docs/provenance.md](docs/provenance.md)) — you don't need them for new
  work.

## Reporting bugs / security issues

Bugs: open a GitHub issue with the daemon log excerpt and (if review
behaviour) the round's verdict/ledger context. Security vulnerabilities:
**do not open a public issue** — see [SECURITY.md](SECURITY.md).
