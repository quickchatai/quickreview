// Test budgets under machine load — the rule is in tests/AGENTS.md
// ("Timeouts under load") and pinned by tests/suite-timeouts.test.ts.
//
// Measured on a 16-core dev PC with the AACR benchmark running
// and a CPU burner at 2x cores: the slowest single test in a process-spawning
// file took 22s (tui-startup), the guards-shell cases 5-18s each, against
// 0.8-7s on the same machine with only the benchmark load. The in-process
// outliers — exhaustive key/width sweeps, mid-test imports of a large module
// graph, whole-src scans, the dispatch pump — reached 30s (a sweep that takes
// 5.8s on an idle-ish machine), and a 250ms test stalled to 6s.

/** Per-test (and per-hook) budget for every file in PROCESS_SUITES: ~3x the
 * slowest measured process-spawning test under 2x-cores load. A child that
 * really hangs still fails, in a minute instead of five seconds. */
export const PROCESS_TIMEOUT_MS = 60_000;

/** Per-test budget for the IN-PROCESS tests that do a lot of work in one test
 * (a sweep over every key or width, a dynamic import of a large module graph,
 * a scan of every src file, a pass of the dispatch pump) — every one measured
 * at 250ms+ on an ordinary run: ~2x the slowest measured under 2x-cores load. Set on the test itself —
 * `it(name, { timeout: HEAVY_TIMEOUT_MS }, fn)`, the form prettier leaves alone —
 * never file-wide, so the rest of that file keeps the 5s default. */
export const HEAVY_TIMEOUT_MS = 60_000;

/** The one test that runs a whole `tsc` over the suite (fences-gate [T6]):
 * measured 87s cold beside the suite and 317s cold under 2x-cores load. */
export const TYPECHECK_TIMEOUT_MS = 600_000;

/**
 * Test files that spawn real processes, sorted. Every file that imports
 * node:child_process is here (the fence checks it); the rest spawn through the
 * code under test and were found by tracing ChildProcess.prototype.spawn and
 * the *Sync variants across a full run:
 *   bench-defects, bench-runpi-flush — the bench's runPi over a fake `pi`;
 *   guards-shell-* — the real posting scripts, spawned by their shared rig
 *     (tests/helpers/guards-shell-rig.ts);
 *   companion-memory — the forward's ssh probe (fails fast, no VM);
 *   onboard-streamrunner — a node child under the wizard's streaming runner;
 *   tui-deploy-process — a node child under the deploy tab's runner;
 *   tui-openurl — a launcher that does not exist;
 *   tui-sshtriage-probe — the triage's probe runner over `sh` and a program
 *     that does not exist.
 */
export const PROCESS_SUITES: readonly string[] = [
  "tests/archive-evidence-shell.test.ts",
  "tests/bash-guard-sed-differential.test.ts",
  "tests/bench-apikey.test.ts",
  "tests/bench-arm-compare.test.ts",
  "tests/bench-armrun.test.ts",
  "tests/bench-case-identity.test.ts",
  "tests/bench-claude.test.ts",
  "tests/bench-codex.test.ts",
  "tests/bench-defects.test.ts",
  "tests/bench-ext-arms.test.ts",
  "tests/bench-ext-prefetch.test.ts",
  "tests/bench-fairness.test.ts",
  "tests/bench-followup.test.ts",
  "tests/bench-g61.test.ts",
  "tests/bench-harvest-upstream.test.ts",
  "tests/bench-image-default.test.ts",
  "tests/bench-opencode.test.ts",
  "tests/bench-pireview.test.ts",
  "tests/bench-pragent.test.ts",
  "tests/bench-published-argv.test.ts",
  "tests/bench-rerun-all.test.ts",
  "tests/bench-runpi-flush.test.ts",
  "tests/bench-whatif.test.ts",
  "tests/collect-secrets.test.ts",
  "tests/commit-verdict-shell.test.ts",
  "tests/companion-github.test.ts",
  "tests/companion-memory.test.ts",
  "tests/deploy.test.ts",
  "tests/docker-daemon.test.ts",
  "tests/fences-cigate.test.ts",
  "tests/fences-gate.test.ts",
  "tests/fences-provenance.test.ts",
  "tests/guards-shell-cigate.test.ts",
  "tests/guards-shell-closed.test.ts",
  "tests/guards-shell-deferred.test.ts",
  "tests/guards-shell-drift.test.ts",
  "tests/guards-shell-noop.test.ts",
  "tests/guards-shell-parity.test.ts",
  "tests/guards-shell-post.test.ts",
  "tests/guards-shell-receipts.test.ts",
  "tests/hf-export.test.ts",
  "tests/improvements-e2e.test.ts",
  "tests/install-shell.test.ts",
  "tests/lens-yield.test.ts",
  "tests/levers.test.ts",
  "tests/onboard-llmauth.test.ts",
  "tests/onboard-streamrunner.test.ts",
  "tests/openviking-embedder.test.ts",
  "tests/openviking.test.ts",
  "tests/pibuiltins.test.ts",
  "tests/pr-checks-why.test.ts",
  "tests/pr-self-shell.test.ts",
  "tests/pr-threads-shell.test.ts",
  "tests/proposals.test.ts",
  "tests/publish-snapshot.test.ts",
  "tests/publishability.test.ts",
  "tests/required-passes.test.ts",
  "tests/reviewrender.test.ts",
  "tests/scan-run.test.ts",
  "tests/scan-sandbox.test.ts",
  "tests/scan-tree.test.ts",
  "tests/setup-extension.test.ts",
  "tests/setup-interview.test.ts",
  "tests/setup-replay.test.ts",
  "tests/shellquote.test.ts",
  "tests/slack-setup-wizard-run.test.ts",
  "tests/sweprbench-export.test.ts",
  "tests/temp-root.test.ts",
  "tests/tui-deploy-process.test.ts",
  "tests/tui-openurl.test.ts",
  "tests/tui-rollover.test.ts",
  "tests/tui-sshtriage-probe.test.ts",
  "tests/tui-startup.test.ts",
  "tests/worktrees.test.ts",
];
