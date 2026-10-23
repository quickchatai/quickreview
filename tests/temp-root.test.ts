// The per-file temp root (tests/helpers/temp-root.ts, installed for every
// file by tests/helpers/install-env.ts). Tests call mkdtempSync(tmpdir()) in
// hundreds of places, and many never remove what they make, which would leave
// thousands of qcr-precheck-*, qcr-cand-*, qcr-esc-gate-* (and two dozen other
// prefixes) behind in /tmp on every full run. Pointing TMPDIR at one root per
// file, removed in afterAll, makes every such dir — and every mktemp a
// spawned script makes — go away with the file, whether or not the test
// cleaned up after itself.
import { execFileSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { describe, expect, it } from "vitest";
import { openTempRoot, sweepStaleRoots } from "./helpers/temp-root.js";

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

  it("sweeps the roots of dead pids and old pid-less ones, never a live pid's or a fresh one", () => {
    const real = process.env.QCR_TEST_REAL_TMPDIR!;
    const host = openTempRoot(real, "qcr-test-sweep-host-");
    try {
      const mk = (n: string) => {
        mkdirSync(join(host.root, n));
        return join(host.root, n);
      };
      // pid 2**22 + 1 exceeds Linux's default pid_max, so it is never alive.
      const dead = mk("p-4194305-aaaaaa");
      const mine = mk(`p-${process.pid}-bbbbbb`);
      const parent = mk(`p-${process.ppid}-cccccc`);
      const fresh = mk("p-dddddd");
      const old = mk("p-eeeeee");
      mk("other-4194305-ffffff");
      const hours = (h: number) => Date.now() - h * 3_600_000;
      utimesSync(old, new Date(hours(7)), new Date(hours(7)));
      const removed = sweepStaleRoots(host.root, "p-");
      expect(removed.sort()).toEqual([dead, old].sort());
      for (const keep of [mine, parent, fresh, join(host.root, "other-4194305-ffffff")]) {
        expect(existsSync(keep)).toBe(true);
      }
    } finally {
      host.close();
    }
  });

  // pi's extension loader compiles .ts through jiti. jiti sends its on-disk
  // cache to the machine's real temp dir (ignoring TMPDIR) whenever the
  // process's cwd IS tmpdir(), which is exactly where a test-spawned child
  // that runs in its temp dir sits. Every run then left thousands of compiled
  // modules in the RAM-backed /tmp/jiti.
  it("a child running in the temp root keeps jiti's compile cache inside it", () => {
    // Where jiti falls back to when it ignores TMPDIR: tmpdir() with TMPDIR unset.
    const { TMPDIR: _drop, ...noTmpdir } = process.env;
    const real = execFileSync(process.execPath, ["-p", "require('os').tmpdir()"], {
      env: noTmpdir,
      encoding: "utf8",
    }).trim();
    const name = `jiti-probe-${process.pid}-${Date.now()}`;
    const file = join(tmpdir(), `${name}.ts`);
    writeFileSync(file, "export const probe: number = 42;\n");
    const script =
      `import { createJiti } from ${JSON.stringify(import.meta.resolve("jiti"))};` +
      `await createJiti(import.meta.url, { moduleCache: false }).import(${JSON.stringify(file)});`;
    execFileSync(process.execPath, ["--input-type=module", "-e", script], {
      cwd: tmpdir(),
      env: process.env,
    });
    const leaked = existsSync(join(real, "jiti"))
      ? readdirSync(join(real, "jiti")).filter((f) => f.startsWith(name))
      : [];
    expect(leaked).toEqual([]);
    expect(readdirSync(join(tmpdir(), "jiti")).some((f) => f.includes("jiti-probe"))).toBe(true);
  });
});
