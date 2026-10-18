import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { readJournal, resume, settle, writeJournal } from "../scripts/openviking-reembed.mjs";
import { tryDirectoryLock } from "../scripts/directory-lock.mjs";

const race = vi.hoisted(() => ({
  home: "",
  armed: false,
  reply: null as { ok: boolean; detail?: string } | null,
}));
vi.mock("node:fs", async (importOriginal) => {
  const fs = await importOriginal<typeof import("node:fs")>();
  return {
    ...fs,
    renameSync(from: string, to: string) {
      if (race.armed && to === join(race.home, "reembed.json")) {
        race.armed = false;
        const child = spawnSync(
          process.execPath,
          [
            "--input-type=module",
            "-e",
            `const {settle}=await import(process.argv[1]); console.log(JSON.stringify(settle({home:process.argv[2],user:"companion"})));`,
            pathToFileURL(join(process.cwd(), "scripts", "openviking-reembed.mjs")).href,
            race.home,
          ],
          { encoding: "utf8", timeout: 20_000 },
        );
        expect(child.status, child.stderr).toBe(0);
        race.reply = JSON.parse(child.stdout.trim());
      }
      fs.renameSync(from, to);
    },
  };
});

beforeEach(() => {
  race.home = mkdtempSync(join(tmpdir(), "qcr-journal-race-"));
  race.armed = false;
  race.reply = null;
});
afterEach(() => rmSync(race.home, { recursive: true, force: true }));

it("never acknowledges a concurrent operator receipt that a resume then erases", async () => {
  writeJournal(race.home, {
    version: 1,
    reset_at: "2026-10-18T00:00:00Z",
    namespaces: { reviewer: { state: "pending" }, companion: { state: "operator" } },
  });
  race.armed = true;
  await resume({
    home: race.home,
    base: "http://127.0.0.1:19333",
    key: "reviewer-key",
    user: "reviewer",
    fetchFn: async () => ({
      status: 200,
      json: async () => ({
        status: "ok",
        result: {
          status: "completed",
          scanned_records: 1,
          rebuilt_records: 1,
          failed_records: 0,
          unsupported_records: 0,
        },
      }),
    }),
  });
  expect(race.reply).not.toBeNull();
  if (race.reply!.ok)
    expect(readJournal(race.home).journal.namespaces.companion.state).toBe("completed");
  else expect(race.reply!.detail).toMatch(/busy|locked/i);
  expect(settle({ home: race.home, user: "companion" }).ok).toBe(true);
  expect(readJournal(race.home).journal.namespaces).toMatchObject({
    reviewer: { state: "completed" },
    companion: { state: "completed" },
  });
});

it("recovers a lease left by a process which exited without releasing it", () => {
  const child = spawnSync(
    process.execPath,
    [
      "--input-type=module",
      "-e",
      `const {tryDirectoryLock}=await import(process.argv[1]);const lease=tryDirectoryLock(process.argv[2]);console.log(JSON.stringify({ok:lease.ok}));`,
      pathToFileURL(join(process.cwd(), "scripts", "directory-lock.mjs")).href,
      race.home,
    ],
    { encoding: "utf8", timeout: 20_000 },
  );
  expect(child.status, child.stderr).toBe(0);
  expect(JSON.parse(child.stdout.trim())).toEqual({ ok: true });
  const recovered = tryDirectoryLock(race.home);
  if (!recovered.ok) throw new Error(recovered.detail);
  recovered.release();
});
