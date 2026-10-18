import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { tryDirectoryLock } from "../scripts/directory-lock.mjs";

const faults = vi.hoisted(() => ({
  beforeUnlink: null as ((path: string) => void) | null,
  hideFd: false,
}));
vi.mock("node:fs", async (importOriginal) => {
  const fs = await importOriginal<typeof import("node:fs")>();
  return {
    ...fs,
    unlinkSync(path: string) {
      faults.beforeUnlink?.(path);
      fs.unlinkSync(path);
    },
    statSync(path: string) {
      if (faults.hideFd && (path.startsWith("/proc/self/fd/") || path.startsWith("/dev/fd/")))
        throw new Error("descriptor filesystem unavailable");
      return fs.statSync(path);
    },
  };
});
let home: string;
beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), "qcr-directory-lock-"));
  faults.beforeUnlink = null;
  faults.hideFd = false;
});
afterEach(() => {
  faults.beforeUnlink = null;
  rmSync(home, { recursive: true, force: true });
});
function seedOwner(owner: unknown): void {
  const path = join(home, ".qcr-reembed.lock");
  mkdirSync(path);
  writeFileSync(
    join(path, "owner.json"),
    typeof owner === "string" ? owner : JSON.stringify(owner),
  );
}

describe("bounded process journal exclusion", () => {
  it("refuses an active owner, releases idempotently and permits the next owner", () => {
    const first = tryDirectoryLock(home);
    if (!first.ok) throw new Error(first.detail);
    expect(tryDirectoryLock(home)).toMatchObject({ ok: false });
    first.release();
    first.release();
    const next = tryDirectoryLock(home);
    if (!next.ok) throw new Error(next.detail);
    next.release();
  });
  it("recovers a dead process owner", () => {
    seedOwner({ pid: 2147483647, token: "dead", start: null });
    const lease = tryDirectoryLock(home);
    if (!lease.ok) throw new Error(lease.detail);
    expect(
      JSON.parse(readFileSync(join(home, ".qcr-reembed.lock", "owner.json"), "utf8")).pid,
    ).toBe(process.pid);
    lease.release();
  });
  it("refuses unreadable owner records without deleting them", () => {
    seedOwner("corrupt");
    expect(tryDirectoryLock(home).ok).toBe(false);
    expect(readFileSync(join(home, ".qcr-reembed.lock", "owner.json"), "utf8")).toBe("corrupt");
  });
  it("refuses an unknown live owner rather than guessing from age", () => {
    seedOwner({ pid: process.pid, token: "other", start: null });
    expect(tryDirectoryLock(home).ok).toBe(false);
  });
  it("cannot steal a new owner during stale-owner replacement", () => {
    seedOwner({ pid: 2147483647, token: "dead", start: null });
    const winners: ReturnType<typeof tryDirectoryLock>[] = [];
    faults.beforeUnlink = () => {
      faults.beforeUnlink = null;
      winners.push(tryDirectoryLock(home));
    };
    const loser = tryDirectoryLock(home);
    const winner = winners[0];
    expect(winner).toMatchObject({ ok: true });
    expect(loser.ok).toBe(false);
    expect(tryDirectoryLock(home).ok).toBe(false);
    if (winner?.ok) winner.release();
    const next = tryDirectoryLock(home);
    if (!next.ok) throw new Error(next.detail);
    next.release();
  });
  it("refuses safely when no stable directory descriptor path exists", () => {
    faults.hideFd = true;
    expect(tryDirectoryLock(home)).toMatchObject({ ok: false });
    faults.hideFd = false;
    const next = tryDirectoryLock(home);
    if (!next.ok) throw new Error(next.detail);
    next.release();
  });
});
