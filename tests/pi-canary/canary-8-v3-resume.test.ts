// Canary 8 [P2.7]: resuming a v3 session JSONL keeps the session id.
//
// The bot worker resumes a PR's session from its JSONL every round, and the
// provider's prompt-cache key is the session id: a resume that mints a new id
// is a silent cache miss on every round, and one that rewrites the file loses
// the history other tools read. Two shapes are held here: a file written by an
// SDK session of this pin, and a committed fixture shaped like a file written
// by interactive pi (a different provider and model, a custom ledger entry, a
// leading system message).
import { copyFileSync, mkdirSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { fauxAssistantMessage } from "@earendil-works/pi-ai";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import { PiHost } from "@quickchatai/pi-quickreview/src/engine/pisdk.js";
import { type Rig, createRig, useOfflineGuard } from "./harness.js";

useOfflineGuard();

const FIXTURE = join(import.meta.dirname, "fixtures", "interactive-v3.jsonl");
const FIXTURE_ID = "0192a3c4-5d6e-7f80-9a1b-2c3d4e5f6a7b";

let rig: Rig;
let sessionDir: string;
const hosts: PiHost[] = [];

beforeEach(async () => {
  rig = await createRig();
  sessionDir = join(rig.dir, "sessions");
  mkdirSync(sessionDir, { recursive: true });
});

afterEach(() => {
  for (const h of hosts.splice(0)) h.dispose();
  rig.close();
});

/** A PiHost whose provider is the rig's faux one. */
const hostOnRig = async (): Promise<PiHost> => {
  const host = await PiHost.create({
    agentDir: join(rig.dir, "host-agent"),
    settings: { compaction: { enabled: false }, retry: { enabled: false } },
    configureModels: (r) => {
      r.registerNativeProvider(rig.faux.provider);
    },
  });
  hosts.push(host);
  return host;
};

const lines = (file: string): Record<string, unknown>[] =>
  readFileSync(file, "utf8")
    .split("\n")
    .filter(Boolean)
    .map((l) => JSON.parse(l) as Record<string, unknown>);

describe("[canary 8] resume of a v3 JSONL", () => {
  it("an SDK-written file reopens with the same id and appends to the same file", async () => {
    const first = await rig.open({ sessionManager: SessionManager.create(rig.dir, sessionDir) });
    rig.faux.setResponses([fauxAssistantMessage("round one")]);
    await first.prompt("round one please");
    const id = first.sessionId;
    const file = first.sessionFile;
    expect(file).toBeTruthy();
    first.dispose();
    const before = lines(file as string);
    expect(before[0]).toMatchObject({ type: "session", version: 3, id });

    // The request that follows the resume must carry the old history and the old id.
    let seen: { sessionId?: string; roles: string[] } | undefined;
    rig.faux.setResponses([
      (ctx, options) => {
        seen = { sessionId: options?.sessionId, roles: ctx.messages.map((m) => m.role) };
        return fauxAssistantMessage("round two");
      },
    ]);
    const resumed = await rig.open({
      sessionManager: SessionManager.open(file as string, sessionDir),
    });
    expect(resumed.sessionId).toBe(id);
    expect(resumed.sessionFile).toBe(file);
    await resumed.prompt("round two please");

    expect(seen?.sessionId, "the provider's cache key is the original id").toBe(id);
    expect(seen?.roles).toContain("assistant");
    const after = lines(file as string);
    expect(after[0]).toEqual(before[0]);
    // Append-only: every earlier line is untouched, new turns follow.
    expect(after.slice(0, before.length)).toEqual(before);
    expect(after.length).toBeGreaterThan(before.length);
    expect(readdirSync(sessionDir).filter((f) => f.endsWith(".jsonl"))).toHaveLength(1);
  });

  it("an interactive-pi-shaped fixture resumes under its own id on another model", async () => {
    const file = join(sessionDir, `2026-10-12T09-00-00-000Z_${FIXTURE_ID}.jsonl`);
    copyFileSync(FIXTURE, file);
    const original = lines(file);
    expect(original[0]).toMatchObject({ type: "session", version: 3, id: FIXTURE_ID });

    let seen: { sessionId?: string; texts: string } | undefined;
    rig.faux.setResponses([
      (ctx, options) => {
        seen = { sessionId: options?.sessionId, texts: JSON.stringify(ctx.messages) };
        return fauxAssistantMessage("round 3 ok");
      },
    ]);
    // The header's cwd belongs to the machine that wrote it; the rig's dir stands in.
    const resumed = await rig.open({
      sessionManager: SessionManager.open(file, sessionDir, rig.dir),
    });
    expect(resumed.sessionId).toBe(FIXTURE_ID);

    await resumed.prompt("Round 3.");

    expect(seen?.sessionId).toBe(FIXTURE_ID);
    expect(seen?.texts).toContain("Review PR #42 round 1.");
    expect(seen?.texts).toContain("Round 2 done.");
    const after = lines(file);
    expect(after.slice(0, original.length)).toEqual(original);
    expect(after.some((e) => e.type === "custom" && e.customType === "qcr-review-ledger")).toBe(
      true,
    );
    expect(JSON.stringify(after.slice(original.length))).toContain("round 3 ok");
    expect(readdirSync(sessionDir).filter((f) => f.endsWith(".jsonl"))).toHaveLength(1);
  });

  it("PiHost's resumeFile route does the same: the fixture's id, history and file", async () => {
    const file = join(sessionDir, `2026-10-12T09-00-00-000Z_${FIXTURE_ID}.jsonl`);
    copyFileSync(FIXTURE, file);
    const original = lines(file);
    let seen: { sessionId?: string; texts: string } | undefined;
    rig.faux.setResponses([
      (ctx, options) => {
        seen = { sessionId: options?.sessionId, texts: JSON.stringify(ctx.messages) };
        return fauxAssistantMessage("round 3 ok");
      },
    ]);
    const host = await hostOnRig();
    const resumed = await host.makeSession({
      cwd: rig.dir,
      env: {},
      model: rig.model,
      persist: { resumeFile: file },
    });
    expect(resumed.sessionId).toBe(FIXTURE_ID);
    expect(resumed.sessionFile).toBe(file);
    await resumed.prompt("Round 3.");
    expect(seen?.sessionId).toBe(FIXTURE_ID);
    expect(seen?.texts).toContain("Round 2 done.");
    const after = lines(file);
    expect(after.slice(0, original.length)).toEqual(original);
    expect(JSON.stringify(after.slice(original.length))).toContain("round 3 ok");
    expect(readdirSync(sessionDir).filter((f) => f.endsWith(".jsonl"))).toHaveLength(1);
  });

  it("PiHost never opens a missing or headerless file as a fresh session", async () => {
    const missing = join(sessionDir, "gone.jsonl");
    const host = await hostOnRig();
    await expect(
      host.makeSession({
        cwd: rig.dir,
        env: {},
        model: rig.model,
        persist: { resumeFile: missing },
      }),
    ).rejects.toThrow(/not a session/);
    expect(readdirSync(sessionDir)).toEqual([]);
  });
});
