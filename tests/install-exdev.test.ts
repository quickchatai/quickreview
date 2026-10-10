// `qcr install migrate` across filesystems: a checkout
// and the config home on different mounts make renameSync throw EXDEV, and the
// profile move falls back to copy-then-remove. A relative symlink INSIDE the
// profile must keep pointing inside the copy — cpSync's default rewrites it to
// an absolute path into the source tree the fallback deletes next. EXDEV is
// forced by a mocked renameSync (one mount in a test tmpdir cannot produce it).
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readlinkSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("node:fs", async (orig) => {
  const real = await orig<typeof import("node:fs")>();
  return {
    ...real,
    renameSync: () => {
      throw Object.assign(new Error("EXDEV: cross-device link not permitted"), { code: "EXDEV" });
    },
  };
});

const { configHome, migrateProfiles } = await import("../src/install.js");

let dir = "";
afterEach(() => {
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
});
