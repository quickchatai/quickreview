# tests/ — conventions

- Run the full suite as `timeout 900 npm test` (4,500+ tests, well under a
  minute); a single file as `timeout 120 npx vitest run tests/<file>.test.ts`.
  Never `--reporter=basic`.
- Everything mocks I/O: fake fetch/adapters, `StateStore(":memory:")`, temp
  dirs. Two exercise git as the THING UNDER TEST: `worktrees.test.ts`
  (scratch git repo subprocesses) and `improvements-e2e.test.ts` (:
  the improvement channel against a scratch clone with a bare "remote" — the
  push, the caps and the dry-run suppression observed on the remote, through
  the production git runner; no network). Five more shell out to git on the
  way to something else: `deploy.test.ts` and `publish-snapshot.test.ts`
  `init` a scratch repo for the script under test, `publishability.test.ts`
  runs `ls-files` on this checkout to enumerate what it lints, and
  `setup-extension.test.ts` inits one scratch repo because the setup
  engine's checkout port lists by `git ls-files`, and
  `scan-tree.test.ts` inits one because the scan's source port reads the tree
  at a sha with `ls-tree`/`archive`, and `setup-interview.test.ts`
  inits a scratch config home because committing setup's profile writes there
  is git as the thing under test, and `setup-replay.test.ts` inits
  one because the replay's source port reads a PR's tree and diff from the
  checkout's own objects. Other tests
  that spawn a real local subprocess do so for a shell script or a CLI of
  this repo, never for a network or a VM —
  `guards-shell.test.ts` (the real scripts against a loopback HTTP stub — the
  shell/gate parity proof, same cases as `guards.test.ts`), `pr-self-shell`,
  `fences-gate`/`fences-cigate`, `shellquote`, `collect-secrets`, `deploy`
  (the preflight, the playbook's rsync filters over temp dirs and
  `config-fingerprint.sh` — never a deploy), `publishability`/`publish-snapshot`, and
  several TUI suites over stub binaries. The list drifts; find the current
  one with `grep -l child_process tests/*.test.ts`.
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
