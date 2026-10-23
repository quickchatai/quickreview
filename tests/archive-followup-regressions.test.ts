import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { renameNoReplace } from "../src/archive/fsutil.js";
import { extractPr } from "../src/archive/extract.js";
import { archivePiGlobal } from "../src/archive/piglobal.js";
import { ArchiveConn } from "../src/archive/archivedb.js";
import { prFixture, onArchiver, put, reopen, type PrFixture } from "./helpers/archive-pr.js";
import { rig, seedEvents, iso, T0, DAY, type Rig } from "./helpers/archive-rows.js";

const race = vi.hoisted(() => ({
  noLinks: false,
  target: "",
  arrived: false,
  crashUnlink: "",
  tearCopyTo: "",
}));
vi.mock("node:fs/promises", async (original) => {
  const real = await original<typeof import("node:fs/promises")>();
  const arrive = async (path: unknown): Promise<void> => {
    if (path === race.target && !race.arrived) {
      race.arrived = true;
      await real.writeFile(race.target, "operator output");
    }
  };
  return {
    ...real,
    unlink: async (...args: Parameters<typeof real.unlink>) => {
      await real.unlink(...args);
      if (String(args[0]) === race.crashUnlink) {
        race.crashUnlink = "";
        throw new Error("crash after duplicate unlink");
      }
    },
    link: async (...args: Parameters<typeof real.link>) => {
      if (race.noLinks) throw Object.assign(new Error("hard links unsupported"), { code: "EPERM" });
      return real.link(...args);
    },
    lstat: async (...args: Parameters<typeof real.lstat>) => {
      try {
        return await real.lstat(...args);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") await arrive(args[0]);
        throw error;
      }
    },
    copyFile: async (...args: Parameters<typeof real.copyFile>) => {
      await arrive(args[1]);
      if (race.tearCopyTo && String(args[1]).startsWith(race.tearCopyTo)) {
        await real.writeFile(args[1], "torn");
        throw new Error("process died mid-copy");
      }
      return real.copyFile(...args);
    },
  };
});
const roots: string[] = [];
const fixtures: PrFixture[] = [];
const databases: Rig[] = [];
afterEach(() => {
  race.noLinks = false;
  race.target = "";
  race.arrived = false;
  race.tearCopyTo = "";
  vi.restoreAllMocks();
  for (const f of fixtures.splice(0)) f.close();
  for (const r of databases.splice(0)) r.close();
  for (const p of roots.splice(0)) rmSync(p, { recursive: true, force: true });
});
function scratch(): string {
  const dir = mkdtempSync(join(tmpdir(), "qcr-archive-followup-"));
  roots.push(dir);
  return dir;
}

it("keeps output that already sits at the target during no-hard-link placement", async () => {
  const dir = scratch(),
    source = join(dir, "source"),
    target = join(dir, "target");
  writeFileSync(source, "archived bytes");
  writeFileSync(target, "operator output");
  race.noLinks = true;
  expect(await renameNoReplace(source, target)).toBe("exists");
  expect(readFileSync(target, "utf8")).toBe("operator output");
  expect(readFileSync(source, "utf8")).toBe("archived bytes");
  expect(existsSync(`${target}.place-partial`)).toBe(false);
});

it("never shows a torn copy at the final name when the no-hard-link copy dies", async () => {
  const dir = scratch(),
    source = join(dir, "source"),
    target = join(dir, "target");
  writeFileSync(source, "archived bytes");
  race.noLinks = true;
  race.tearCopyTo = target;
  await expect(renameNoReplace(source, target)).rejects.toThrow("mid-copy");
  expect(existsSync(target)).toBe(false);
  expect(readFileSync(source, "utf8")).toBe("archived bytes");
});

it("never removes an operator file at an extraction partial-shaped name", async () => {
  const f = prFixture();
  fixtures.push(f);
  const a = onArchiver(f);
  try {
    await a.tick();
  } finally {
    a.stop();
  }
  const to = scratch();
  const operator = join(to, "manifest.json.extract-partial");
  writeFileSync(operator, "operator output");
  const result = await extractPr({
    root: f.root,
    sessionsRoot: join(f.root, "state/pi-sessions"),
    pr: f.pr,
    to,
    bytesPerS: 1e12,
  });
  expect(result.ok).toBe(true);
  expect(existsSync(operator)).toBe(true);
  expect(readFileSync(operator, "utf8")).toBe("operator output");
});

it("converges empty global-store directories after an interrupted cleanup", async () => {
  const root = scratch(),
    storeDir = join(root, "sessions"),
    empty = join(storeDir, "outer/empty");
  mkdirSync(empty, { recursive: true });
  writeFileSync(join(storeDir, "keep.txt"), "keep");
  await archivePiGlobal({
    root,
    storeDir,
    now: () => new Date(T0),
    level: 6,
    bytesPerS: 1e12,
    signal: new AbortController().signal,
    diskFor: async () => null,
    stopReason: () => null,
    verifyFailed: () => {},
    log: () => {},
    settle: true,
  });
  expect(existsSync(empty)).toBe(false);
  expect(existsSync(join(storeDir, "outer"))).toBe(false);
  expect(existsSync(storeDir)).toBe(true);
  expect(readFileSync(join(storeDir, "keep.txt"), "utf8")).toBe("keep");
});

it("refuses a later archive writer until a failed checkpoint database sync is retried", async () => {
  const r = await rig();
  databases.push(r);
  await r.adb.target("2026-09");
  seedEvents(r.store, [[iso(T0 - 40 * DAY), "webhook_event", null, {}]]);
  const failure = vi
    .spyOn(ArchiveConn.prototype, "syncDb")
    .mockRejectedValue(new Error("disk sync failed"));
  await r.mover({ checkpointWalBytes: 1 }).run();
  expect(failure).toHaveBeenCalled();
  await expect(r.adb.target("2026-09")).rejects.toThrow("disk sync failed");
  failure.mockRestore();
  await expect(r.adb.target("2026-09")).resolves.toBeDefined();
});

it.each([false, true])(
  "reconciles a duplicate removal count after an unlink/checkpoint crash (reopened=%s)",
  async (reopened) => {
    const f = prFixture();
    fixtures.push(f);
    const legacy = put(f.root, `archive/pr-${f.pr}/session.jsonl`, f.bytes.get(f.transcripts[1]!)!);
    race.crashUnlink = legacy;
    const a = onArchiver(f);
    try {
      await a.tick();
    } finally {
      a.stop();
    }
    expect(existsSync(legacy)).toBe(false);
    const total = () =>
      Number(
        (
          f.store.db
            .prepare("SELECT value FROM archive_marks WHERE name='duplicates.removed'")
            .get() as { value?: number } | undefined
        )?.value ?? 0,
      );
    if (reopened) reopen(f);
    const next = onArchiver(f);
    try {
      await next.tick();
      await next.tick();
    } finally {
      next.stop();
    }
    expect(total()).toBe(1);
  },
);

it("preserves transcript mtime when no hard links are available", async () => {
  const dir = scratch(),
    source = join(dir, "source"),
    target = join(dir, "target");
  const old = new Date("2020-01-01T00:00:00.000Z");
  writeFileSync(source, "transcript");
  utimesSync(source, old, old);
  race.noLinks = true;
  expect(await renameNoReplace(source, target)).toBe("placed");
  expect(statSync(target).mtimeMs).toBe(old.getTime());
});
