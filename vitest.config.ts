import { defineConfig } from "vitest/config";

// Collect ONLY this checkout's suite. Without this, vitest's default globs
// also collect `.claude/worktrees/**` — full working copies of the repo
// (the companion-era stale worktrees, and any in-flight agent worktree),
// which triples the run and fails spuriously: a held worktree's tests read
// `prompts/`/`agents/` relative to the RUNNER's cwd, so they judge this
// checkout's seeds against another branch's expectations.
export default defineConfig({
  test: {
    include: ["tests/**/*.test.ts"],
    // the install locator never sees the developer's own homes.
    setupFiles: ["tests/helpers/install-env.ts"],
  },
});
