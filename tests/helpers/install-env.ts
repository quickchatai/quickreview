// Every test file runs with the install locator pointed at an EMPTY
// temp config home and no QCR_CONFIG / QCR_INSTALL from the developer's shell.
// Without this, a suite run on a machine that has already done `qcr install
// migrate` would read the operator's real config wherever a test calls the
// no-argument loader or spawns a script with `...process.env` — and a test
// that writes a config would write it into the operator's real home. With it,
// a no-argument loader finds no config (the checkout's config.toml is never a
// fallback) — a test that needs one names it by path or QCR_CONFIG,
// and tests that exercise the homes pass their own env.
//
// The same per-file root is also the file's TMPDIR (tests/helpers/
// temp-root.ts): every `mkdtempSync(tmpdir())` a test makes, and every
// `mktemp` a spawned script makes, lands under it — so nothing a test forgets
// to remove outlives the file.
//
// The root is removed when the file finishes (afterAll): setup files run
// once per test file, and a process 'exit' hook never fires in a vitest worker
// thread — without this every run would leak one dir per file, plus every
// temp dir a test did not clean up itself.
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll } from "vitest";
import { openTempRoot } from "./temp-root.js";

// The machine's real temp dir, captured before the redirect and inherited by
// any later file in the same worker, so a root is never nested in another.
const realTmp = (process.env.QCR_TEST_REAL_TMPDIR ??= tmpdir());
const temp = openTempRoot(realTmp, "qcr-test-xdg-");
process.env.QCR_TEST_TEMP_ROOT = temp.root;
process.env.XDG_CONFIG_HOME = join(temp.root, "config");
process.env.XDG_STATE_HOME = join(temp.root, "state");
delete process.env.QCR_CONFIG;
delete process.env.QCR_INSTALL;
delete process.env.QCR_CONFIG_HOME;
delete process.env.QCR_STATE_HOME;

afterAll(() => {
  temp.close();
});
