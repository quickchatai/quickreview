# tests/ — conventions

- Run the full suite as `timeout 900 npm test` (6,500+ tests, ~100s on the
  dev PC, the length of `guards-shell`; several minutes under heavy load —
  see "Timeouts under load"); a single file as `timeout 120 npx vitest run tests/<file>.test.ts`.
  Never `--reporter=basic`.
- Everything mocks I/O: fake fetch/adapters, `StateStore(":memory:")`, temp
  dirs. Two exercise git as the THING UNDER TEST: `worktrees.test.ts`
  (scratch git repo subprocesses) and `improvements-e2e.test.ts` (:
  the improvement channel against a scratch clone with a bare "remote" — the
  push, the caps and the dry-run suppression observed on the remote, through
  the production git runner; no network). `proposals.test.ts` has one
  scratch-repo block too: the rubric/config accept path against real `git
  apply`/`commit` (selfscan2 — hunk relocation, binary sections, the `--only`
  commit are only observable there). Five more shell out to git on the
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
  `guards-shell-*.test.ts` (the real scripts against a loopback HTTP stub — the
  shell/gate parity proof, same cases as `guards.test.ts`; seven files by area —
  `closed`, `cigate`, `post`, `parity`, `drift`, `receipts`, `noop` — so they run in
  parallel instead of one file setting the suite's wall time, each with its
  own stub from `helpers/guards-shell-rig.ts`), `pr-self-shell`,
  `fences-gate`/`fences-cigate`, `shellquote`, `collect-secrets`, `deploy`
  (the preflight, the playbook's rsync filters over temp dirs and
  `config-fingerprint.sh` — never a deploy), `publishability`/`publish-snapshot`, and
  several TUI suites over stub binaries. The list drifts; find the current
  one with `grep -l child_process tests/*.test.ts tests/helpers/*.ts` (the
  guards-shell files spawn through their rig, not by importing it).
- **Timeouts under load.** The dev PC runs benchmark containers, so the suite
  has to stay green at a load average of 15-45 without hiding a real hang.
  The rule, pinned by `suite-timeouts.test.ts` (constants in
  `helpers/suite-timeouts.ts`):
  - A file that **spawns real processes** (shell scripts, git, tsc, node
    children, stub binaries) is listed in `PROCESS_SUITES` and runs in the
    `spawning` vitest project with `PROCESS_TIMEOUT_MS` (60s) per test and
    per hook: a child's wall time belongs to the scheduler. Every file that
    imports `node:child_process` must be listed (the fence fails otherwise);
    the few that spawn only through the code under test are listed by hand,
    with the reason, in the helper. Measured 2026-09-30 with the benchmark
    running plus a 2x-cores CPU burner: the slowest such test took 22s, the
    guards-shell cases 5-18s each.
  - **Everything else keeps vitest's 5s default**, so an in-process hang still
    fails in five seconds. Never raise it for a whole file (`vi.setConfig`
    with a timeout is refused in a unit file). The handful of in-process
    tests that do a lot of work in one test — a sweep over every key or width,
    a mid-test import of a large module graph (`tui-surfaces`, `cmdbar`,
    `checklist`, `tui-metrics`, `tui-companion`'s args, `fences`' compiled
    checks, `fences-tui`, `fences-config`, `daemon`, …) — carry
    `{ timeout: HEAVY_TIMEOUT_MS }` (60s) on the test itself; the bar for
    adding one is a measured duration of 250ms+ on an ordinary run, or 2.5s+
    under the burner: there a 250ms test was seen at 6s (a ~20x stall), and
    the worst, a 5.8s key sweep, took 30s. The list was cut from two ordinary
    runs on 2026-09-30; a new test past the bar needs the option added. Prefer a
    static import to `await import()` inside a test: a mid-test import puts
    the module transform on the test's clock. **Every test that calls `dispatchOnce`** carries it too,
    by rule rather than by measurement (the fence checks it): the pump builds
    a whole round order, and with every other class covered it was the one
    that still crossed 5s under the burner — a different pump test each run.
    Scaling tests keep their own `LINEAR_HANG_GUARD_MS`.
  - The one full-`tsc` test (`fences-gate` [T6]) has `TYPECHECK_TIMEOUT_MS`
    and runs tsc incrementally, its build info per checkout in
    `node_modules/.cache/` (87s cold beside the suite, a few seconds warm).
  - The project NAMES are load-bearing: vitest queues whole projects
    alphabetically, and `spawning` holds the longest files, so it must sort
    first or those files start last and set the wall time.
  - Worker count stays vitest's default: capping it (tried `--maxWorkers=8`)
    only cut the suite's share of a loaded CPU, from 378s to 535s of wall time
    under the burner, and the timeouts stayed.
  - Load also breaks tests that are not timeouts. A wait loop is a DEADLINE
    inside the test's timeout (`pollUntil` in `tui-startup`), never a count of
    ticks — 100 x 20ms is a hidden 2s budget — and a wait for a real socket
    or child effect is a deadline loop, never a fixed `setTimeout(r, 20)`.
    A scratch repo whose `.git` is copied disables auto-maintenance (`-c maintenance.auto=false -c
    gc.auto=0`): a detached `git maintenance run --auto` was still writing
    into it when `cp -r` walked it. A fake binary fed on stdin reads its stdin
    before exiting, or the writer's EPIPE races the case under test.
  - To re-measure: run the suite with `--reporter=json --outputFile=…` beside
    `for i in $(seq $(( $(nproc)*2 ))); do timeout 900 sh -c 'while :; do :; done' & done`,
    once with `--testTimeout=600000` to see true durations.
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
