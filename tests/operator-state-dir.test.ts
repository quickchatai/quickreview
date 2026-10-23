// Where the operator verbs keep the state database. An app installed by a
// package manager keeps it in the state home, never inside the package (a
// root-owned global prefix refuses the write; an update replaces the package
// directory); a checkout and the release image keep `<root>/state`, where
// their daemon writes it. A filesystem refusal is read into one line naming
// the path (the bin's use of it: tests/qcrbin-fs-denied.test.ts).
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { cmdInstall } from "../src/cli.js";
import { fsDeniedLine } from "../src/fsdenied.js";
import { operatorStateDir, stateHome } from "../src/homes.js";

const tmp = mkdtempSync(join(tmpdir(), "qcr-opstate-"));
afterAll(() => rmSync(tmp, { recursive: true, force: true }));

const env = { HOME: join(tmp, "home"), XDG_STATE_HOME: join(tmp, "xdg-state") };

describe("operatorStateDir", () => {
  // MUTATION: return `join(root, "state")` for every kind — the global and
  // local installs below fail.
  it("is the state home for a global or local package-manager install", () => {
    const global = join(tmp, "prefix", "lib", "node_modules", "@quickchatai", "quickreview");
    const local = join(tmp, "proj", "node_modules", "@quickchatai", "quickreview");
    expect(operatorStateDir(global, env)).toBe(stateHome(env));
    expect(operatorStateDir(local, env)).toBe(stateHome(env));
    expect(stateHome(env).startsWith(join(tmp, "xdg-state"))).toBe(true);
  });

  it("follows QCR_STATE_HOME, as `qcr install where` does", () => {
    const global = join(tmp, "prefix", "lib", "node_modules", "@quickchatai", "quickreview");
    const set = { ...env, QCR_STATE_HOME: join(tmp, "elsewhere") };
    expect(operatorStateDir(global, set)).toBe(join(tmp, "elsewhere"));
  });

  // MUTATION: return `stateHome(env)` for every kind — the checkout and the
  // image below fail.
  it("is `<root>/state` for a checkout and for the image", () => {
    const checkout = join(tmp, "checkout");
    expect(operatorStateDir(checkout, env)).toBe(join(checkout, "state"));
    expect(operatorStateDir("/opt/qcr", env)).toBe(join("/opt/qcr", "state"));
    // the image's entrypoint marker wins over a node_modules path
    const nm = join(tmp, "x", "node_modules", "@quickchatai", "quickreview");
    expect(operatorStateDir(nm, { ...env, QCR_IMAGE_TOOL_UID: "1001" })).toBe(join(nm, "state"));
  });

  it("`qcr install where` names the state database the operator verbs open", () => {
    const global = join(tmp, "prefix", "lib", "node_modules", "@quickchatai", "quickreview");
    const out: string[] = [];
    expect(cmdInstall(["where"], { root: global, env, log: (l) => out.push(l) })).toBe(0);
    expect(out.join("\n")).toContain(`state db    ${join(stateHome(env), "state.db")}`);
    out.length = 0;
    const checkout = join(tmp, "checkout");
    cmdInstall(["where"], { root: checkout, env, log: (l) => out.push(l) });
    expect(out.join("\n")).toContain(`state db    ${join(checkout, "state", "state.db")}`);
  });

  // MUTATION: put `return join(sandboxRoot(), "state");` back in cli.ts's
  // stateDir — this fails.
  it("is the one place the CLI's state directory comes from", () => {
    const src = readFileSync(resolve(import.meta.dirname, "..", "src", "cli.ts"), "utf8");
    expect(src).toMatch(
      /function stateDir\(\): string \{\s*return operatorStateDir\(sandboxRoot\(\)\);/,
    );
    expect(src).not.toMatch(/join\(sandboxRoot\(\), "state"/);
  });
});

describe("fsDeniedLine", () => {
  const refusal = (code: string, path?: string, syscall = "mkdir") =>
    Object.assign(new Error(`${code}: refused, ${syscall} '${path}'`), { code, path, syscall });

  it("is one line naming the path for EACCES, EPERM and EROFS", () => {
    const p = "/usr/lib/node_modules/@quickchatai/quickreview/state";
    for (const code of ["EACCES", "EPERM", "EROFS"]) {
      const line = fsDeniedLine("today", refusal(code, p));
      expect(line).not.toBeNull();
      expect(line).toContain(`qcr today: ${p}:`);
      expect(line).toContain(code);
      expect(line!.split("\n")).toHaveLength(1);
    }
    expect(fsDeniedLine("today", refusal("EROFS", p))).toContain("read-only file system");
  });

  it("is null for any other error, and for a refusal with no path", () => {
    expect(fsDeniedLine("today", refusal("ENOENT", "/x"))).toBeNull();
    expect(fsDeniedLine("today", refusal("EACCES"))).toBeNull();
    expect(fsDeniedLine("today", new Error("boom"))).toBeNull();
    expect(fsDeniedLine("today", "EACCES")).toBeNull();
  });

  it.skipIf(process.getuid?.() === 0)("reads the real error a read-only directory raises", () => {
    const ro = join(tmp, "ro");
    mkdirSync(ro);
    chmodSync(ro, 0o500);
    try {
      let err: unknown = null;
      try {
        mkdirSync(join(ro, "state"), { recursive: true });
      } catch (e) {
        err = e;
      }
      expect(fsDeniedLine("spend", err)).toContain(
        `qcr spend: ${join(ro, "state")}: permission denied`,
      );
    } finally {
      chmodSync(ro, 0o700);
    }
  });
});
