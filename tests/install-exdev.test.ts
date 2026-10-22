// `qcr install migrate` across filesystems: a checkout
// and the config home on different mounts make renameSync throw EXDEV, and the
// profile move falls back to copy-then-remove. A relative symlink INSIDE the
// profile must keep pointing inside the copy — cpSync's default rewrites it to
// an absolute path into the source tree the fallback deletes next. EXDEV is
// forced by a mocked renameSync (one mount in a test tmpdir cannot produce it).
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readlinkSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

const copyFault = vi.hoisted(() => ({ on: false }));
vi.mock("node:fs", async (orig) => {
  const real = await orig<typeof import("node:fs")>();
  return {
    ...real,
    cpSync: (from: string, to: string, opts?: Parameters<typeof real.cpSync>[2]) => {
      real.cpSync(from, to, opts);
      if (copyFault.on) throw new Error("copy interrupted");
    },
    renameSync: (from: string, to: string) => {
      // Only the profile move crosses mounts. Atomic journal/symlink
      // publication renames within the same directory cannot be EXDEV.
      if (dirname(from) !== dirname(to))
        throw Object.assign(new Error("EXDEV: cross-device link not permitted"), { code: "EXDEV" });
      return real.renameSync(from, to);
    },
  };
});

const { configHome, migrateProfiles } = await import("../src/install.js");

let dir = "";
afterEach(() => {
  copyFault.on = false;
  if (dir) rmSync(dir, { recursive: true, force: true });
});

describe("migrateProfiles across filesystems", () => {
  it("keeps a relative symlink inside the profile pointing at the COPY", () => {
    dir = mkdtempSync(join(tmpdir(), "qcr-install-exdev-"));
    const root = join(dir, "checkout");
    const env = { HOME: join(dir, "home"), XDG_CONFIG_HOME: join(dir, "xdg-config") };
    const from = join(root, "profiles", "house");
    mkdirSync(from, { recursive: true });
    writeFileSync(join(from, "settings.toml"), "s = 1\n");
    symlinkSync("settings.toml", join(from, "profile.toml"));

    const to = join(configHome(env), "profiles", "house");
    expect(migrateProfiles({ root, env })).toEqual([{ kind: "moved", name: "house", from, to }]);
    expect(readlinkSync(join(to, "profile.toml"))).toBe("settings.toml");
    expect(readFileSync(join(to, "profile.toml"), "utf8")).toBe("s = 1\n");
  });

  it("re-points an ABSOLUTE link inside the profile at the copy, not the deleted source", () => {
    dir = mkdtempSync(join(tmpdir(), "qcr-install-exdev-"));
    const root = join(dir, "checkout");
    const env = { HOME: join(dir, "home"), XDG_CONFIG_HOME: join(dir, "xdg-config") };
    const from = join(root, "profiles", "house");
    mkdirSync(join(from, "addenda"), { recursive: true });
    writeFileSync(join(from, "rule.md"), "r\n");
    symlinkSync(join(from, "rule.md"), join(from, "addenda", "10-rule.md"));

    const to = join(configHome(env), "profiles", "house");
    expect(migrateProfiles({ root, env })).toEqual([{ kind: "moved", name: "house", from, to }]);
    expect(readlinkSync(join(to, "addenda", "10-rule.md"))).toBe(join(to, "rule.md"));
    expect(readFileSync(join(to, "addenda", "10-rule.md"), "utf8")).toBe("r\n");
  });

  it("an interrupted copy leaves nothing at the destination", () => {
    dir = mkdtempSync(join(tmpdir(), "qcr-install-exdev-"));
    const root = join(dir, "checkout");
    const env = { HOME: join(dir, "home"), XDG_CONFIG_HOME: join(dir, "xdg-config") };
    const from = join(root, "profiles", "house");
    mkdirSync(from, { recursive: true });
    writeFileSync(join(from, "settings.toml"), "s = 1\n");
    const to = join(configHome(env), "profiles", "house");
    copyFault.on = true;
    expect(() => migrateProfiles({ root, env })).toThrow(/copy interrupted/);
    expect(existsSync(to)).toBe(false);
    expect(existsSync(from)).toBe(true);
  });
});
