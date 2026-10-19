// Memory when set up (src/reviewmemory.ts): `qcr review` seeds the prompt from
// OpenViking when it is configured and reachable; otherwise it reviews without
// memory and says so once. The assembler is a stub — no server, no network.
import { describe, expect, it, vi } from "vitest";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { ContextAssembler, MemoryRead } from "../src/memory/context.js";

vi.stubEnv(
  "QCR_CONFIG",
  resolve(dirname(fileURLToPath(import.meta.url)), "fixtures", "config.toml"),
);

const { openReviewMemory, seedReviewMemory } = await import("../src/reviewmemory.js");
const { loadConfig } = await import("../src/config.js");

const input = { title: "feature against main", files: [{ filename: "src/a.ts" }] };

const stub = (head: MemoryRead, ctx: MemoryRead): ContextAssembler => ({
  pinnedHead: async () => head,
  contextBlock: async () => ctx,
});

describe("seedReviewMemory", () => {
  it("carries the pinned head and the context block when memory answers", async () => {
    const r = await seedReviewMemory(
      {
        assembler: stub(
          { status: "read", text: "ALWAYS-CHECK-MIGRATIONS" },
          { status: "read", text: "LESSON-ABOUT-RETRIES" },
        ),
      },
      input,
    );
    expect(r.used).toBe(true);
    expect(r.notice).toBeNull();
    expect(r.memory.head).toContain("ALWAYS-CHECK-MIGRATIONS");
    expect(r.memory.block).toContain("LESSON-ABOUT-RETRIES");
  });

  it("goes memory-less with one notice when nothing is set up", async () => {
    const r = await seedReviewMemory({ assembler: null }, input);
    expect(r.used).toBe(false);
    expect(r.memory.head).toBe("");
    expect(r.notice).toMatch(/memory/i);
    const none = await seedReviewMemory(undefined, input);
    expect(none.used).toBe(false);
    expect(none.notice).toMatch(/memory/i);
  });

  it("does not fail or wait past the short timeout when memory hangs", async () => {
    const hang = new Promise<MemoryRead>(() => {});
    const t0 = Date.now();
    const r = await seedReviewMemory(
      { assembler: { pinnedHead: () => hang, contextBlock: () => hang }, timeoutMs: 100 },
      input,
    );
    expect(Date.now() - t0).toBeLessThan(2000);
    expect(r.used).toBe(false);
    expect(r.notice).toMatch(/unreachable|unavailable/i);
  });

  it("survives an assembler that throws, and one that reports unreadable", async () => {
    const boom: ContextAssembler = {
      pinnedHead: async () => {
        throw new Error("econnrefused");
      },
      contextBlock: async () => {
        throw new Error("econnrefused");
      },
    };
    const a = await seedReviewMemory({ assembler: boom }, input);
    expect(a.used).toBe(false);
    expect(a.notice).not.toBeNull();
    const down: MemoryRead = { status: "unreadable", reason: "connection refused" };
    const b = await seedReviewMemory({ assembler: stub(down, down) }, input);
    expect(b.used).toBe(false);
    expect(b.notice).toMatch(/connection refused/);
  });
});

describe("openReviewMemory", () => {
  it("is null when memory is switched off or has no key on this install", () => {
    const cfg = loadConfig();
    const secrets = mkdtempSync(join(tmpdir(), "rm-secrets-"));
    const base = { ...cfg, github: { ...cfg.github, secrets_dir: secrets } };
    expect(
      openReviewMemory({ ...base, openviking: { ...cfg.openviking, enabled: false } }),
    ).toBeNull();
    expect(openReviewMemory(base)).toBeNull(); // no key file
    writeFileSync(join(secrets, "openviking_reviewer_key"), "k\n");
    expect(openReviewMemory(base)?.assembler).not.toBeNull();
  });
});
