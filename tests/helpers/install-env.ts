// every test file runs with the install locator pointed at an EMPTY
// temp config home and no QCR_CONFIG / QCR_INSTALL from the developer's shell.
// Without this, a suite run on a machine that has already done `qcr install
// migrate` would read the operator's real config wherever a test calls the
// no-argument loader or spawns a script with `...process.env` — and a test
// that writes a config would write it into the operator's real home. With it,
// the locator falls back to this checkout's own config.toml exactly as before
// the locator existed; tests that exercise the homes pass their own env.
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const base = mkdtempSync(join(tmpdir(), "qcr-test-xdg-"));
process.env.XDG_CONFIG_HOME = join(base, "config");
process.env.XDG_STATE_HOME = join(base, "state");
delete process.env.QCR_CONFIG;
delete process.env.QCR_INSTALL;
