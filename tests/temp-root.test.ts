// The per-file temp root (tests/helpers/temp-root.ts, installed for every
// file by tests/helpers/install-env.ts). Tests call mkdtempSync(tmpdir()) in
// hundreds of places, and many never remove what they make — every full run
// used to leave thousands of qcr-precheck-*, qcr-cand-*, qcr-esc-gate-* (and
// two dozen other prefixes) behind in /tmp. Pointing TMPDIR at one root per
// file, removed in afterAll, makes every such dir — and every mktemp a
// spawned script makes — go away with the file, whether or not the test
// cleaned up after itself.
import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { describe, expect, it } from "vitest";
import { openTempRoot } from "./helpers/temp-root.js";

describe("the per-file temp root", () => {
  it("is installed for this file: tmpdir() is the root, and it lives in the real temp dir", () => {
    const root = process.env.QCR_TEST_TEMP_ROOT;
    expect(root).toBeTruthy();
    expect(tmpdir()).toBe(root);
    expect(dirname(root!)).toBe(process.env.QCR_TEST_REAL_TMPDIR);
  });

  it("redirects tmpdir(), and close() removes everything made under it and restores TMPDIR", () => {
    const before = process.env.TMPDIR;
    const real = process.env.QCR_TEST_REAL_TMPDIR!;
    const r = openTempRoot(real, "qcr-test-root-probe-");
    try {
      expect(tmpdir()).toBe(r.root);
      const leaked = mkdtempSync(join(tmpdir(), "qcr-leak-"));
      writeFileSync(join(leaked, "f"), "x");
      // A spawned script inherits it too, so its mktemp lands inside the root.
      const fromShell = execFileSync("mktemp", ["-d"], { encoding: "utf8" }).trim();
      expect(fromShell.startsWith(r.root + "/")).toBe(true);
      r.close();
      expect(existsSync(r.root)).toBe(false);
      expect(existsSync(leaked)).toBe(false);
      expect(process.env.TMPDIR).toBe(before);
    } finally {
      r.close();
    }
  });

  it("restores an UNSET TMPDIR as unset, not as the string 'undefined'", () => {
    const saved = process.env.TMPDIR!;
    delete process.env.TMPDIR;
    try {
      const r = openTempRoot(process.env.QCR_TEST_REAL_TMPDIR!, "qcr-test-root-probe-");
      r.close();
      expect("TMPDIR" in process.env).toBe(false);
    } finally {
      // Restored even on a failed assertion, so the rest of the file keeps
      // its root (a lost TMPDIR would send later temp dirs to the real /tmp).
      process.env.TMPDIR = saved;
    }
  });
});
