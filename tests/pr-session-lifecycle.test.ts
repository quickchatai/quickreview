// The host-neutral PR session lifecycle (src/pr-session-lifecycle.ts) against
// a fake host: no tmux, no bridge, no pi. The tmux host's behaviour is covered
// by sessions.test.ts and the SessionHooks conformance suite; this file pins
// what the lifecycle itself decides, whoever runs the session.
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { Config } from "../src/config.js";
import type { OvSessionLifecycle } from "../src/memory/ovsession.js";
import { PrSessionLifecycle, type PrSessionHost } from "../src/pr-session-lifecycle.js";
import { StateStore } from "../src/state.js";
import type { WorktreeManager } from "../src/worktrees.js";
import { trackPr } from "./helpers/session-hooks-host.js";

const PR = 7;
const SESSION = `pr-${PR}`;

let root: string;
let store: StateStore;
let calls: string[];
let live: boolean;
let goneProof: boolean;
let rawCreates: boolean;

const host: PrSessionHost = {
  liveSessions: async () => (live ? [SESSION] : []),
  provenGone: async () => !live && goneProof,
  killConfirmed: async () => {
    calls.push("killConfirmed");
    live = false;
    return true;
  },
  stop: async () => {
    calls.push("stop");
    live = false;
  },
  reuseLive: async () => (live ? SESSION : undefined),
  spawn: async (_pr, _title, _worktree, { rawReady }) => {
    calls.push(`spawn raw=${rawReady}`);
    live = true;
    return SESSION;
  },
};

const ovSessions: OvSessionLifecycle = {
  create: async (id) => {
    calls.push(`ov.create ${id}`);
    return rawCreates;
  },
  remove: async (id) => {
    calls.push(`ov.remove ${id}`);
    return true;
  },
};

const worktrees = {
  remove: async (pr: number) => void calls.push(`worktree.remove ${pr}`),
} as unknown as WorktreeManager;

function open(): PrSessionLifecycle {
  return new PrSessionLifecycle({
    cfg: { pi: { session_dir: "state/pi-sessions" }, github: {} } as unknown as Config,
    root,
    worktrees,
    host,
    ovSessions,
    now: () => new Date("2026-08-13T10:00:00Z"),
    commandStore: store,
  });
}

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "qcr-prlife-"));
  store = new StateStore(":memory:");
  calls = [];
  live = false;
  goneProof = true;
  rawCreates = true;
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

describe("PrSessionLifecycle birth", () => {
  it("creates the raw tier before the host starts the session", async () => {
    trackPr(store, PR);
    expect(await open().ensureSession(PR, "t", "wt")).toBe(SESSION);
    expect(calls).toEqual([`ov.create ${SESSION}`, "spawn raw=true"]);
  });

  it("starts the session memory-less when the raw tier could not be created", async () => {
    trackPr(store, PR);
    rawCreates = false;
    await open().ensureSession(PR, "t", "wt");
    expect(calls).toEqual([`ov.create ${SESSION}`, "spawn raw=false"]);
  });

  it("adopts a session the host already runs, touching nothing", async () => {
    trackPr(store, PR);
    live = true;
    expect(await open().ensureSession(PR, "t", "wt")).toBe(SESSION);
    expect(calls).toEqual([]);
  });

  it("refuses a closed PR", async () => {
    trackPr(store, PR, "closed");
    await expect(open().ensureSession(PR, "t", "wt")).rejects.toThrow(/closed/);
    expect(calls).toEqual([]);
  });

  it("shares one flight between concurrent births of a PR", async () => {
    trackPr(store, PR);
    const l = open();
    const births = [l.ensureSession(PR, "t", "wt"), l.ensureSession(PR, "t", "wt")];
    expect(l.birthInFlight(PR)).toBe(true);
    await Promise.all(births);
    expect(calls.filter((c) => c.startsWith("spawn"))).toHaveLength(1);
    expect(l.birthInFlight(PR)).toBe(false);
  });

  it("awaits the archiver's restore before the host is asked anything", async () => {
    trackPr(store, PR);
    const l = open();
    l.setBeforeBirth(async () => void calls.push("restore"));
    await l.ensureSession(PR, "t", "wt");
    expect(calls[0]).toBe("restore");
  });
});

describe("PrSessionLifecycle close", () => {
  it("archives, drops the worktree, stops the session, then deletes the raw tier", async () => {
    trackPr(store, PR, "closed");
    mkdirSync(join(root, "state", "ledgers"), { recursive: true });
    writeFileSync(join(root, "state", "ledgers", `${SESSION}.md`), "ledger\n");
    live = true;
    await open().archiveAndClose(PR);
    expect(calls).toEqual([`worktree.remove ${PR}`, "stop", `ov.remove ${SESSION}`]);
    expect(readFileSync(join(root, "archive", SESSION, "ledger.md"), "utf8")).toBe("ledger\n");
    const meta = JSON.parse(readFileSync(join(root, "archive", SESSION, "meta.json"), "utf8"));
    expect(meta).toMatchObject({ session: SESSION, archived_at: "2026-08-13T10:00:00.000Z" });
  });

  it("leaves the raw tier to the sweep when the host cannot prove the session gone", async () => {
    trackPr(store, PR, "closed");
    goneProof = false;
    await open().archiveAndClose(PR);
    expect(calls).toEqual([`worktree.remove ${PR}`, "stop"]);
    expect(
      store.db
        .prepare(
          "SELECT COUNT(*) AS c FROM events WHERE kind = 'openviking_session_delete_deferred'",
        )
        .get(),
    ).toEqual({ c: 1 });
  });

  it("does nothing for a PR the registry still holds open", async () => {
    trackPr(store, PR);
    await open().archiveAndClose(PR);
    expect(calls).toEqual([]);
  });

  it("makes a birth wait the close that is running", async () => {
    trackPr(store, PR, "closed");
    const l = open();
    const closing = l.archiveAndClose(PR);
    expect(l.cleanupInFlight(PR)).toBeDefined();
    store.setPrState(PR, "tracked");
    const born = l.ensureSession(PR, "t", "wt");
    await Promise.all([closing, born]);
    expect(calls.indexOf("stop")).toBeLessThan(calls.indexOf("spawn raw=true"));
  });
});

describe("PrSessionLifecycle stays host-neutral", () => {
  it("imports nothing of the tmux host", () => {
    const src = readFileSync(
      join(import.meta.dirname, "..", "src", "pr-session-lifecycle.ts"),
      "utf8",
    );
    expect(src).not.toMatch(/from "\.\/(tmux|session-bridge|session-command)\.js"/);
    expect(src).not.toMatch(/from "\.\/sessions\.js"/);
  });
});
