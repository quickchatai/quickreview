import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { prepare, writeJournal } from "../scripts/openviking-reembed.mjs";

const syncProbe = vi.hoisted(() => ({ events: [] as string[], failDirectory: false }));
vi.mock("node:fs", async (importOriginal) => {
  const fs = await importOriginal<typeof import("node:fs")>();
  return {
    ...fs,
    fsyncSync(fd: number) {
      const kind = fs.fstatSync(fd).isDirectory() ? "directory" : "file";
      syncProbe.events.push(`fsync:${kind}`);
      if (kind === "directory" && syncProbe.failDirectory) throw new Error("directory sync failed");
      fs.fsyncSync(fd);
    },
    renameSync(from: string, to: string) {
      syncProbe.events.push("rename");
      fs.renameSync(from, to);
    },
  };
});

let home: string;
beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), "qcr-reembed-durability-"));
  syncProbe.events.length = 0;
  syncProbe.failDirectory = false;
});
afterEach(() => rmSync(home, { recursive: true, force: true }));

describe("durable migration intent before moving live vectors", () => {
  it("syncs the journal bytes before rename and the directory entry before returning", () => {
    writeJournal(home, { namespaces: { reviewer: { state: "pending" } } });
    expect(syncProbe.events).toEqual(["fsync:file", "rename", "fsync:directory"]);
  });

  it("refuses to move a collection when the journal directory cannot become durable", async () => {
    const workspace = join(home, "workspace");
    const collection = join(workspace, "vectordb", "context");
    mkdirSync(collection, { recursive: true });
    writeFileSync(
      join(collection, "collection_meta.json"),
      JSON.stringify({
        Description: `store\n\n[openviking.embedding]\n${JSON.stringify({ provider: "openai", model: "old", dimension: 1536 })}`,
      }),
    );
    syncProbe.failDirectory = true;
    const result = await prepare({
      home,
      conf: {
        storage: { workspace },
        embedding: { dense: { provider: "local", model: "new", dimension: 512 } },
      },
      users: ["reviewer"],
      base: "http://127.0.0.1:19333",
      fetchFn: async () => {
        throw new Error("ECONNREFUSED");
      },
    });
    expect(result.action).toBe("refuse");
    expect(result.reason).toContain("directory sync failed");
    expect(existsSync(collection)).toBe(true);
    expect(syncProbe.events.filter((event) => event === "rename")).toHaveLength(1);
  });
});
