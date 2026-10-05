# tests/ — conventions

## Running

- The whole suite: `timeout 900 npm test`. It is several thousand tests and
  takes one to two minutes on an idle machine, longer under load.
- One file: `timeout 120 npx vitest run tests/<file>.test.ts`.
- Never `--reporter=basic`.

## What a test may touch

- **Unit tests mock all I/O:** fake fetch and adapters,
  `StateStore(":memory:")`, temp dirs.
- **Tests where git is the thing under test** run against scratch repos in a
  temp dir, with no network:
  - `worktrees.test.ts`
  - `improvements-e2e.test.ts`, the improvement channel against a scratch
    clone with a bare "remote"
  - one block of `proposals.test.ts`, the accept path through real
    `git apply`/`commit`
- **Others shell out to git on the way to something else,** each in a scratch
  repo or a scratch config home: `deploy`, `publish-snapshot`,
  `setup-extension`, `scan-tree`, `setup-interview`, `setup-replay`.
  `publishability` runs `ls-files` on the checkout to list what it lints.
- **Other subprocesses** are this repo's own shell scripts and CLIs, never a
  network service or a VM. For example, `guards-shell-*.test.ts` runs the
  real posting scripts against a loopback HTTP stub (see "Shell parity").
- The list drifts. Find the current one with
  `grep -l child_process tests/*.test.ts tests/helpers/*.ts`.

## Shell parity

`guards-shell-*.test.ts` is the proof that the shell posting route and the
TypeScript gate agree. The files run the real scripts against a loopback
stub over the same cases `guards.test.ts` runs against the gate. They are
split by area so they run in parallel, each with its own stub from
`helpers/guards-shell-rig.ts`. Change a guard on one side and you change it
on both, with both tests.

## Timeouts under load

The suite must stay green on a heavily loaded machine without hiding a real
hang. `suite-timeouts.test.ts` pins the rules, and the constants live in
`helpers/suite-timeouts.ts`.

- **A file that spawns real processes** (shell scripts, git, tsc, node
  children, stub binaries) is listed in `PROCESS_SUITES`. It runs in the
  `spawning` vitest project with `PROCESS_TIMEOUT_MS` per test and per hook,
  because a child's wall time belongs to the scheduler.
  - Every file that imports `node:child_process` must be listed, or the
    fence fails.
  - A file that spawns only through the code under test is listed by hand,
    with the reason.
- **Everything else keeps vitest's 5 s default,** so an in-process hang
  still fails fast.
  - Never raise the timeout for a whole file: `vi.setConfig` with a timeout
    is refused in a unit file.
  - A single heavy in-process test carries `{ timeout: HEAVY_TIMEOUT_MS }`
    on the test itself. The bar is a measured 250 ms or more on an ordinary
    run.
  - Every test that calls `dispatchOnce` carries it, by rule.
  - Prefer a static import to `await import()` inside a test: a mid-test
    import puts the module transform on the test's clock.
- **The full-`tsc` fence** (`fences-gate` [T6]) has `TYPECHECK_TIMEOUT_MS`
  and runs tsc incrementally, with its build info under
  `node_modules/.cache/`.
- **The project names are load-bearing.** vitest queues whole projects
  alphabetically, and `spawning` holds the longest files, so it must sort
  first.
- **Leave the worker count at vitest's default.** Capping it lowered the
  suite's share of a loaded CPU and made the wall time worse.
- **Load breaks more than timeouts:**
  - A wait loop is a deadline inside the test's timeout (`pollUntil`), never
    a count of ticks.
  - A wait for a real socket or child effect is a deadline loop, never a
    fixed `setTimeout`.
  - A scratch repo whose `.git` is copied disables auto-maintenance
    (`-c maintenance.auto=false -c gc.auto=0`).
  - A fake binary fed on stdin reads its stdin before exiting, so the
    writer's EPIPE cannot race the case under test.
- **To re-measure,** run the suite with `--reporter=json --outputFile=…`
  beside a CPU burner such as
  `for i in $(seq $(( $(nproc)*2 ))); do timeout 900 sh -c 'while :; do :; done' & done`.
  Run it once with `--testTimeout=600000` to see the true durations.

## Fences that protect rules

Fix the code, not the test.

- **`seed-integrity.test.ts`** keeps the frozen `agents/` and `prompts/`
  seeds byte-identical, via a sha256 manifest:
  - `RATIFIED_DIVERGENCE` lists ratified reseeds;
  - `NON_SEEDED` lists the files that are ours to edit.

  A failure means a seed was edited. Revert it and change pass behaviour
  through the addendum registry (`PASS_ADDENDA` in `src/include.ts`). Never
  re-pin the manifest.

- **`invariant-fences.test.ts`** pins the ratified passages inside the
  editable prompt files.
  - Each `<!-- RATIFIED FT-NNNN <slug> -->` fence is hashed by its contents,
    and a missing marker fails as loudly as changed text.
  - A failure names the ratifying citation. The fix is a ratification, not
    a re-pin.
  - A fenced frozen seed must also carry a `ratified-divergence.json` entry.
- **`single-shepherd.test.ts`** pins the single-shepherd invariant
  (`docs/single-shepherd-invariant.md`) structurally.
