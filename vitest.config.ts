import { defineConfig } from "vitest/config";
import { PROCESS_SUITES, PROCESS_TIMEOUT_MS } from "./tests/helpers/suite-timeouts.js";

// Collect ONLY this checkout's suite. Without this, vitest's default globs
// also collect `.claude/worktrees/**` — full working copies of the repo
// (any stale or in-flight agent worktree), which multiplies the run and
// fails spuriously: a held worktree's tests read `prompts/`/`agents/`
// relative to the runner's cwd, so they judge this
// checkout's seeds against another branch's expectations.
const ALL = ["tests/**/*.test.ts"];

// Two projects, one run (tests/CLAUDE.md "Timeouts under load"): the files
// that spawn real processes get PROCESS_TIMEOUT_MS, because under load a
// child's wall time belongs to the scheduler; everything else keeps vitest's
// 5s default so an in-process hang still fails fast. The names matter: vitest
// queues whole projects alphabetically, and the spawning files are the
// longest in the suite, so they must start first or they set the wall time.
// Pinned by tests/suite-timeouts.test.ts.
export default defineConfig({
  test: {
    // No root `include`: `extends: true` concatenates arrays, so a root glob
    // would be added to the process project's list and pull every file in.
    // The install locator never sees the developer's own homes.
    setupFiles: ["tests/helpers/install-env.ts"],
    projects: [
      {
        extends: true,
        test: {
          name: "spawning",
          include: [...PROCESS_SUITES],
          testTimeout: PROCESS_TIMEOUT_MS,
          hookTimeout: PROCESS_TIMEOUT_MS,
        },
      },
      {
        extends: true,
        test: {
          name: "unit",
          include: ALL,
          exclude: [...PROCESS_SUITES],
        },
      },
    ],
  },
});
