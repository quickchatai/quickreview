# Contributing

Thanks for looking at quickreviewd. This project is small, strict, and
test-driven; the rules below are the ones that will actually affect your PR.

## Build and test

```sh
npm ci
npm test          # vitest, 6,500+ tests, about a minute — all I/O mocked, no secrets
npm run build     # tsc, must be clean
```

The suite is required to stay green **offline with no secrets on a fresh
clone** — that property is part of the spec, because a stranger's first
command is the suite. Tests mock all I/O (fake fetch/adapters, in-memory
SQLite, temp dirs); the few tests that touch the real world (scratch git
repos, shell scripts against a loopback HTTP stub, local subprocesses) are
listed in `tests/AGENTS.md`.

Conventions: TypeScript strict, ESM (`"type": "module"`, NodeNext — local
imports use the `.js` suffix), Node ≥ 22, minimal dependencies.

## Running from a clone

Users run QuickReview from the released image (`qcr`, [README](README.md#quickstart)).
A clone is the developer route: it is tested in CI (the `clone` job: a fresh
checkout, `npm ci`, `npm run build`, `scripts/qcr version --json` and
`scripts/qcr review --preview --json` on a fixture, no Docker and no model) but
not promised in the user docs.

```sh
scripts/qcr onboard     # or: npm run onboard — the guided setup, from the checkout
scripts/qcr tui         # the operator board
npm run lint            # ESLint with type-aware rules
npm run format          # Prettier; `npm run format:check` to verify
```

Lint and format are not chained into `npm test` or `npm run build`; CI runs
both. From a clone the wizard drives Docker on your machine directly, the same
as the image's wizard does where it can; to run a locally built image through
`docker-compose.yml`, see the last section of
[docker/README.md](docker/README.md).

## The rules that will surprise you

1. **Frozen prompt seeds.** `prompts/` + `agents/` seeded content is
   canonical and integrity-pinned (`tests/seed-integrity.test.ts`: sha256
   manifest + byte-identity against `seeds/`). Never edit a seed in a PR.
   Pass-behaviour changes go through the **addendum registry**
   (`PASS_ADDENDA` in `packages/pi-plugin/src/include.ts`) or a **profile pack**
   (`profiles/<name>/addenda/` — see [docs/profiles.md](docs/profiles.md)).
   A genuine reseed is the owner's to ratify — see
   [docs/ownership.md](docs/ownership.md), which lists every owner-only
   surface (the dry-run flag, ratification fences, the divergence registry,
   rubric acceptance, the caps).
2. **One mutation gate.** Every GitHub write flows through `packages/pi-plugin/src/gate.ts`
   (shell twin: `scripts/guards.sh`). Never add a write path around it, and
   never add a review-dismissal mutation — that one is structurally absent on
   purpose. `request_reviewer` exists (the optional, off-by-default escalation
   feature) but is an ordinary kind with no special case: suppressed in
   dry-run, never `forceLive`, reachable only from `src/escalation.ts` and
   only towards a configured target.
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
  at the seam it changes (see `tests/AGENTS.md` for the house test style).
- Run `npm test && npm run build` before pushing.
- Reference the issue you're addressing (how decisions are recorded:
  [docs/provenance.md](docs/provenance.md)).

## Reporting bugs / security issues

Bugs: open a GitHub issue with the daemon log excerpt and (if review
behaviour) the round's verdict/ledger context. Security vulnerabilities:
**do not open a public issue** — see [SECURITY.md](SECURITY.md).
