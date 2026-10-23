import { resolve } from "node:path";
import { defineConfig, type Plugin } from "vitest/config";
import { PROCESS_SUITES, PROCESS_TIMEOUT_MS } from "./tests/helpers/suite-timeouts.js";

// Collect ONLY this checkout's suite. Without this, vitest's default globs
// also collect `.claude/worktrees/**` — full working copies of the repo
// (any stale or in-flight agent worktree), which multiplies the run and
// fails spuriously: a held worktree's tests read `prompts/`/`agents/`
// relative to the runner's cwd, so they judge this
// checkout's seeds against another branch's expectations.
const ALL = ["tests/**/*.test.ts"];

// The review core's package specifiers resolve to its .ts sources, so what
// vitest itself loads is the code in packages/pi-plugin, never a stale build
// of it (tsconfig.tests.json maps the same specifiers the same way for tsc).
// A compiled module a test loads on purpose (anything under a dist/) keeps the
// compiled core, the way it runs in production. So does a real pi a suite
// spawns: it loads the app's extension shims through the package's export
// map, i.e. packages/pi-plugin/dist, which this alias cannot reach. Such a
// suite checks the build first (tests/helpers/core-build.ts) and says
// `npm run build` rather than failing far from the cause.
const PLUGIN = resolve(import.meta.dirname, "packages/pi-plugin");
const CORE_NAME = "@quickchatai/pi-quickreview";
const coreSources: Plugin = {
  name: "qcr-core-sources",
  enforce: "pre",
  resolveId(source, importer) {
    if (!source.startsWith(`${CORE_NAME}/`) || !source.endsWith(".js")) return null;
    if (importer !== undefined && /[\\/]dist[\\/]/.test(importer)) return null;
    return `${PLUGIN}/${source.slice(CORE_NAME.length + 1, -3)}.ts`;
  },
};

// Two projects, one run (tests/AGENTS.md "Timeouts under load"): the files
// that spawn real processes get PROCESS_TIMEOUT_MS, because under load a
// child's wall time belongs to the scheduler; everything else keeps vitest's
// 5s default so an in-process hang still fails fast. The names matter: vitest
// queues whole projects alphabetically, and the spawning files are the
// longest in the suite, so they must start first or they set the wall time.
// Pinned by tests/suite-timeouts.test.ts.
export default defineConfig({
  plugins: [coreSources],
  test: {
    // No root `include`: `extends: true` concatenates arrays, so a root glob
    // would be added to the process project's list and pull every file in.
    // The install locator never sees the developer's own homes.
    setupFiles: ["tests/helpers/install-env.ts"],
    // Vitest 5 clears every mock's call history before each test by default.
    // The suite was written to vitest 4's default, where a test that records
    // calls in a beforeAll or at module level still sees them, so it keeps it.
    clearMocks: false,
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
