# tests/ — conventions

- Run the full suite as `timeout 900 npm test` (~1600 tests, seconds); a
  single file as `timeout 120 npx vitest run tests/<file>.test.ts`. Never
  `--reporter=basic`.
- Everything mocks I/O: fake fetch/adapters, `StateStore(":memory:")`, temp
  dirs. Exceptions that touch the real world: `worktrees.test.ts` (scratch git
  repo subprocesses) and `guards-shell.test.ts` (runs the real scripts against
  a loopback HTTP stub — the shell/gate parity proof, same cases as
  `guards.test.ts`).
- `seed-integrity.test.ts` enforces root rule 6 (sha256 manifest over the
  frozen `agents/`+`prompts/` seeds, `RATIFIED_DIVERGENCE` for ratified
  reseeds, `NON_SEEDED` for ours-to-edit files). A failure here means you
  edited a seed — revert the seed and use the addendum registry
  (`PASS_ADDENDA` in `src/include.ts`); do not "fix" the manifest.
- `invariant-fences.test.ts` pins the ratified passages INSIDE the
  ours-to-edit prompt files: each `<!-- RATIFIED FT-NNNN <slug> -->` fence is
  hashed by contents, and a missing marker fails as loudly as changed text.
  A failure names the ratifying citation — `FT-NNNN`, or `RULE-N` for an
  invariant that predates the numbering — and the fix is a
  ratification, not a re-pin. Since the four FROZEN seeds are fenced
  too; the test requires each fenced seed to carry a
  `ratified-divergence.json` entry, because fencing a seed is a reseed.
- `single-shepherd.test.ts` pins root rule 9 structurally — same discipline:
  fix the code, not the test.
