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
 *   bench-defects, bench-live-cap, bench-runpi-flush — the bench's runPi over a
 *     fake `pi`;
 *   post-shim — the posting shims over a stub client;
 *   companion-memory — the forward's ssh probe (fails fast, no VM);
 *   onboard-streamrunner — a node child under the wizard's streaming runner;
 *   tui-deploy-process — a node child under the deploy tab's runner;
 *   tui-openurl — a launcher that does not exist;
 *   tui-sshtriage-probe — the triage's probe runner over `sh` and a program
 *     that does not exist.
 */
export const PROCESS_SUITES: readonly string[] = [
  "tests/action.test.ts",
  "tests/archive-evidence-shell.test.ts",
  "tests/archive-worker-rounds.test.ts", // a fake pi on a pty (script) for qcr open
  "tests/bash-guard-sed-differential.test.ts",
  "tests/bash-inherit-fds.test.ts", // the model's bash commands under the host's spawn, with descriptors handed over
  "tests/bench-apikey.test.ts",
  "tests/bench-arm-compare.test.ts",
  "tests/bench-armrun.test.ts",
  "tests/bench-case-identity.test.ts",
  "tests/bench-claude.test.ts",
  "tests/bench-codex.test.ts",
  "tests/bench-defects.test.ts",
  "tests/bench-elo.test.ts",
  "tests/bench-ext-arms.test.ts",
  "tests/bench-ext-prefetch.test.ts",
  "tests/bench-fairness.test.ts",
  "tests/bench-followup.test.ts",
  "tests/bench-g61.test.ts",
  "tests/bench-harvest-upstream.test.ts",
  "tests/bench-image-default.test.ts",
  "tests/bench-live-cap.test.ts",
  "tests/bench-opencode.test.ts",
  "tests/bench-pireview.test.ts",
  "tests/bench-pragent.test.ts",
  "tests/bench-published-argv.test.ts",
  "tests/bench-rerun-all.test.ts",
  "tests/bench-runpi-flush.test.ts",
  "tests/bench-whatif.test.ts",
  "tests/botworker-process.test.ts", // the built worker as a child, with the capability on an inherited fd
  "tests/botworker.test.ts", // the model's bash runs the real verdict and post scripts, through the worker
  "tests/ci-changes.test.ts", // git ls-files, to find the docs readers and the Dockerfile's sources
  "tests/ci-clone-smoke.test.ts",
  "tests/ci-image-smoke.test.ts",
  "tests/cli-bin.test.ts",
  "tests/cli-install-smoke.test.ts", // npm pack of both packages, an offline npm install and the installed qcr
  "tests/collect-secrets.test.ts",
  "tests/commit-verdict-shell.test.ts",
  "tests/companion-github.test.ts",
  "tests/companion-memory.test.ts",
  "tests/compose-stack.test.ts",
  "tests/context-files.test.ts",
  "tests/cpu-gate.test.ts",
  "tests/cutover-rehearsal-script.test.ts", // two helpers of the rehearsal script, extracted and run in bash
  "tests/cutover-wizard.test.ts", // the cutover wizard as a child process against stubbed ssh, deploy.sh and qcr
  "tests/daemon-git-pins.test.ts",
  "tests/debug-pi.test.ts",
  "tests/debug-round-bot-smoke.test.ts", // the real pane chain and the real pi CLI in a pty, on a loopback endpoint
  "tests/deploy-manifest.test.ts",
  "tests/deploy.test.ts",
  "tests/docker-daemon.test.ts",
  "tests/emit-deploy-manifest.test.ts",
  "tests/entrypoint.test.ts",
  "tests/exec-boundary.test.ts",
  "tests/fences-cigate.test.ts",
  "tests/fences-gate.test.ts",
  "tests/fences-provenance.test.ts",
  "tests/gh-read.test.ts", // the helper scripts read through the built shim and a real socket
  "tests/ghcred-handoff.test.ts",
  "tests/golden-prompts.test.ts",
  "tests/guards.test.ts", // the guard cases drive the real gate over a loopback GitHub stub
  "tests/hf-export.test.ts",
  "tests/host-isolation.test.ts",
  "tests/host-wrapper.test.ts",
  "tests/improvements-e2e.test.ts",
  "tests/install-shell.test.ts",
  "tests/install.test.ts", // reads the tracked profiles/ through git
  "tests/ipc.test.ts",
  "tests/json-contract.test.ts",
  "tests/lens-prompt-parity.test.ts", // a real pi child per agent, against a loopback endpoint
  "tests/lens-yield.test.ts",
  "tests/levers.test.ts",
  "tests/live-control.test.ts", // the TUI's real write and probe scripts under sh
  "tests/localreview-paths.test.ts",
  "tests/localreview-readonly.test.ts",
  "tests/loginrefresh.test.ts", // flock helper processes and a racing writer process
  "tests/memory-image.test.ts",
  "tests/onboard-llmauth.test.ts",
  "tests/onboard-streamrunner.test.ts",
  "tests/open-pr.test.ts", // sh -c against a fixture root, a real pi child in a pty
  "tests/openviking-embedder.test.ts",
  "tests/openviking-reembed-lock.test.ts",
  "tests/openviking.test.ts",
  "tests/pi-canary/canary-10-bot-request.test.ts", // a real pi child per PR session, against a loopback endpoint
  "tests/pi-canary/canary-10-oneshot-request.test.ts", // a real pi child per round, against a loopback endpoint
  "tests/pi-canary/canary-3-abort-cpu-load.test.ts", // bash children spawned by pi's own bash tool
  "tests/pi-plugin-install.test.ts", // npm pack, an offline npm install and a real pi child in rpc mode
  "tests/pi-plugin-round.test.ts", // git for the scratch repo the faux round reviews
  "tests/pi-plugin.test.ts", // git for each fake host's scratch repo
  "tests/pi-resolution.test.ts",
  "tests/pibuiltins.test.ts",
  "tests/pilogin.test.ts",
  "tests/pin-evidence.test.ts", // the evidence script run under node against the map
  "tests/plugin-qcr.test.ts", // the plugin's shell scripts against a fake docker, gh and qcr
  "tests/post-payload-parity.test.ts", // the Node post route, compared with recorded dry-run payloads
  "tests/post-shim.test.ts", // the post scripts handing over to the client under bash
  "tests/posting-journal.test.ts", // the Python receipt helper beside the TypeScript journal
  "tests/pr-checks-why.test.ts",
  "tests/pr-context-shell.test.ts",
  "tests/pr-intake.test.ts", // the intake step under bash against a fake gh
  "tests/pr-self-shell.test.ts",
  "tests/pr-threads-shell.test.ts",
  "tests/profile-overrides-review.test.ts",
  "tests/profile-overrides.test.ts",
  "tests/proposals.test.ts",
  "tests/publishability.test.ts",
  "tests/qcr-update.test.ts", // the updater against a fake docker and a fake daemon
  "tests/release-image.test.ts",
  "tests/release-workflow.test.ts",
  "tests/required-passes.test.ts",
  "tests/review-api.test.ts",
  "tests/review-cli.test.ts",
  "tests/review-container.test.ts",
  "tests/review-core-defects.test.ts",
  "tests/review-delta.test.ts",
  "tests/review-destinations.test.ts",
  "tests/review-detached.test.ts",
  "tests/review-post-cli.test.ts",
  "tests/review-pr-target.test.ts",
  "tests/review-watchdog.test.ts",
  "tests/reviewrender.test.ts",
  "tests/reviewstore.test.ts",
  "tests/scan-auth.test.ts",
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
  "tests/tool-fence.test.ts",
  "tests/tool-uid-container.test.ts",
  "tests/tool-uid-daemon-container.test.ts", // the bot's run shape in docker: the daemon mode, the setid helper, the model's bash
  "tests/tool-uid.test.ts",
  "tests/tui-deploy-process.test.ts",
  "tests/tui-inboxpull.test.ts",
  "tests/tui-openurl.test.ts",
  "tests/tui-rollover.test.ts",
  "tests/tui-socket-mode.test.ts",
  "tests/tui-sshtriage-probe.test.ts",
  "tests/tui-startup.test.ts",
  "tests/tui-tmux-socket.test.ts",
  "tests/vm-postcutover-cleanup.test.ts", // the cleanup and the real updater's status against a fake docker
  "tests/worker-rehearsal-tooling.test.ts", // the rehearsal's node scripts (report, patch-toml) as children
  "tests/worker-supervisor.test.ts", // the fake worker as a real process group: kills, leases, restarts
  "tests/worker-world-e2e.test.ts", // the production daemon spawns the built botworker as a process
  "tests/worktrees.test.ts",
];
