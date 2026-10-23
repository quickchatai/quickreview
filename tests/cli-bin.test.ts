// The `qcr` bin: a package manager links bin/qcr.js under the name `qcr`, so
// the CLI cannot find itself by its file name. The module runs `main` only when
// it IS the process's entry (links resolved), and the bin calls `main` itself.
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { isEntryModule } from "../src/cli.js";

const ROOT = resolve(import.meta.dirname, "..");
const BUILT = existsSync(join(ROOT, "dist", "src", "cli.js"));
const tmp = mkdtempSync(join(tmpdir(), "qcr-bin-"));
afterAll(() => rmSync(tmp, { recursive: true, force: true }));

describe("the CLI module's entry check", () => {
  // MUTATION: go back to `process.argv[1]?.endsWith("cli.js")` — the other
  // file named cli.js runs main, and the link named qcr does not.
  it("is the module itself, through a link, and never another file of the same name", () => {
    const self = join(tmp, "real-cli.js");
    writeFileSync(self, "");
    const link = join(tmp, "qcr");
    symlinkSync(self, link);
    const other = join(tmp, "cli.js");
    writeFileSync(other, "");
    expect(isEntryModule(self, self)).toBe(true);
    expect(isEntryModule(link, self)).toBe(true);
    expect(isEntryModule(other, self)).toBe(false);
    expect(isEntryModule(undefined, self)).toBe(false);
    expect(isEntryModule(join(tmp, "missing.js"), self)).toBe(false);
  });
});

describe.skipIf(!BUILT)("bin/qcr.js (needs `npm run build`)", () => {
  it("runs the CLI behind a link named qcr, once", () => {
    const link = join(tmp, "bin-qcr");
    symlinkSync(join(ROOT, "bin", "qcr.js"), link);
    const r = spawnSync(process.execPath, [link, "version"], { encoding: "utf8" });
    expect(r.status, r.stderr).toBe(0);
    expect(r.stdout.match(/^qcr \d+\.\d+\.\d+/gm)).toHaveLength(1);
  });

  it("and the image's `node dist/src/cli.js` still runs it", () => {
    const r = spawnSync(process.execPath, [join(ROOT, "dist", "src", "cli.js"), "version"], {
      encoding: "utf8",
    });
    expect(r.status, r.stderr).toBe(0);
    expect(r.stdout.match(/^qcr \d+\.\d+\.\d+/gm)).toHaveLength(1);
  });
});
