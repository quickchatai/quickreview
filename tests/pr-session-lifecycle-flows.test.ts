// The host-neutral PR session lifecycle's longer flows (src/pr-session-lifecycle.ts)
// over a fake host: the raw-notes tier's create and delete, the stale raw-tier
// sweep, and what a close writes into the archive record. They ran through the
// tmux manager until the workers became the only PR host; nothing here knows
// tmux, a bridge or pi. The shorter cases are in pr-session-lifecycle.test.ts.
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { whyJson } from "../src/cli.js";
import type { Config } from "../src/config.js";
import type { OvSessionLifecycle } from "../src/memory/ovsession.js";
import {
  PrSessionLifecycle,
  prSessionName,
  type PrSessionHost,
} from "../src/pr-session-lifecycle.js";
import { StateStore } from "../src/state.js";
import type { ExecFn } from "../src/tmux.js";
import { WorktreeManager } from "../src/worktrees.js";

let root: string;
let gitCalls: string[];
let live: Set<string>;
/** A kill that does not take. */
let keepKilled: boolean;
/** The host cannot be asked what is live. */
let listingUnknown: boolean;
let ovCalls: string[];

const cfg = (extra: Partial<Config> = {}): Config =>
  ({
    github: { repo: "exampleorg/example-app" },
    pi: { session_dir: "state/pi-sessions" },
    openviking: { host: "127.0.0.1", port: 1933 },
    ...extra,
  }) as unknown as Config;

const exec: ExecFn = async (cmd, args) => {
  if (cmd === "git") gitCalls.push(args.join(" "));
  return { code: 0, stdout: "", stderr: "" };
};

/** Awaited inside the host's start and kill, so a case can hold either open. */
let beforeSpawn: (() => Promise<void>) | undefined;
let beforeKill: (() => Promise<void>) | undefined;

const host: PrSessionHost = {
  liveSessions: async () => (listingUnknown ? null : [...live]),
  provenGone: async (pr) => !listingUnknown && !live.has(prSessionName(pr)),
  killConfirmed: async (pr) => {
    await beforeKill?.();
    if (!keepKilled) live.delete(prSessionName(pr));
    return !live.has(prSessionName(pr));
  },
  stop: async (pr) => {
    await beforeKill?.();
    if (!keepKilled) live.delete(prSessionName(pr));
  },
  reuseLive: async (pr) => (live.has(prSessionName(pr)) ? prSessionName(pr) : undefined),
  spawn: async (pr) => {
    await beforeSpawn?.();
    live.add(prSessionName(pr));
    return prSessionName(pr);
  },
};

function open(
  opts: {
    store?: StateStore;
    ov?: OvSessionLifecycle;
    now?: () => Date;
    config?: Config;
  } = {},
): PrSessionLifecycle {
  return new PrSessionLifecycle({
    cfg: opts.config ?? cfg(),
    root,
    worktrees: new WorktreeManager({
      root,
      repo: "o/n",
      cloneDir: "example-app",
      cloneUrl: "/dev/null",
      run: exec,
    }),
    host,
    ...(opts.ov ? { ovSessions: opts.ov } : {}),
    now: opts.now ?? (() => new Date("2026-08-13T10:00:00Z")),
    ...(opts.store ? { commandStore: opts.store } : {}),
  });
}

const recordingOv: OvSessionLifecycle = {
  create: async (id) => {
    ovCalls.push(`create ${id}`);
    return true;
  },
  remove: async (id) => {
    ovCalls.push(`delete ${id}`);
    return true;
  },
};

const trackedPr = (store: StateStore, number: number, state: "closed" | "tracked"): void =>
  store.upsertPr({
    number,
    state,
    head_sha: "abc",
    title: "t",
    author: "alice",
    trigger_ts: null,
    stale_recheck: 0,
    migration_gate: 0,
  });

const events = (store: StateStore, kind: string) =>
  (
    store.db.prepare("SELECT pr, payload FROM events WHERE kind = ?").all(kind) as Array<{
      pr: number;
      payload: string;
    }>
  ).map((r) => ({ pr: r.pr, ...(JSON.parse(r.payload) as Record<string, unknown>) }));

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "qcr-prlife-flows-"));
  gitCalls = [];
  ovCalls = [];
  live = new Set();
  keepKilled = false;
  listingUnknown = false;
  beforeSpawn = undefined;
  beforeKill = undefined;
  mkdirSync(join(root, "example-app", ".git"), { recursive: true });
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

describe("the PR's raw-notes session", () => {
  it("is created at birth and deleted at close", async () => {
    const lifecycle = open({ ov: recordingOv });
    await lifecycle.ensureSession(42, "T", "wt/pr-42");
    expect(ovCalls).toEqual(["create pr-42"]);

    await lifecycle.archiveAndClose(42);
    expect(ovCalls).toEqual(["create pr-42", "delete pr-42"]);
  });

  it("a memory engine that is down costs the PR its raw tier and nothing else", async () => {
    const down = async (): Promise<boolean> => {
      throw new Error("connection refused");
    };
    const lifecycle = open({ ov: { create: down, remove: down } });
    await expect(lifecycle.ensureSession(42, "T", "wt/pr-42")).resolves.toBe("pr-42");
    expect(live.has("pr-42")).toBe(true);
    await expect(lifecycle.archiveAndClose(42)).resolves.toBeUndefined();
  });

  // A failed raw-tier delete must never be silent: an unexplained pile of
  // closed PRs' sessions on the server is otherwise all that is left.
  it("a raw-tier delete that fails is LOGGED and RECORDED — and the PR still closes", async () => {
    const store = new StateStore(":memory:");
    const lifecycle = open({
      store,
      ov: {
        create: async () => true,
        remove: async () => {
          throw new Error("connect ECONNREFUSED");
        },
      },
    });
    await lifecycle.ensureSession(42, "T", "wt/pr-42");
    await expect(lifecycle.archiveAndClose(42)).resolves.toBeUndefined();
    const rows = events(store, "openviking_session_delete_failed");
    expect(rows).toEqual([{ pr: 42, session: "pr-42", error: "connect ECONNREFUSED" }]);
    store.close();
  });

  it("a successful raw-tier delete records nothing", async () => {
    const store = new StateStore(":memory:");
    const lifecycle = open({ store, ov: recordingOv });
    await lifecycle.ensureSession(42, "T", "wt/pr-42");
    await lifecycle.archiveAndClose(42);
    expect(events(store, "openviking_session_delete_failed")).toEqual([]);
    store.close();
  });

  it("a close kill that does not take keeps the raw tier for the sweep", async () => {
    const store = new StateStore(":memory:");
    try {
      const lifecycle = open({ store, ov: recordingOv });
      await lifecycle.ensureSession(42, "T", "wt/pr-42");
      keepKilled = true;
      await lifecycle.archiveAndClose(42);
      expect(ovCalls).toEqual(["create pr-42"]);
      expect(events(store, "openviking_session_delete_deferred")).toHaveLength(1);
    } finally {
      store.close();
    }
  });

  it("a failed worktree removal still stops the closed PR's session, and is still reported", async () => {
    const lifecycle = open({ ov: recordingOv });
    await lifecycle.ensureSession(42, "T", "wt/pr-42");
    const failing = new WorktreeManager({
      root,
      repo: "o/n",
      cloneDir: "example-app",
      cloneUrl: "/dev/null",
      run: exec,
    });
    failing.remove = async () => {
      throw new Error("EACCES");
    };
    const failed = new PrSessionLifecycle({
      cfg: cfg(),
      root,
      worktrees: failing,
      host,
      ovSessions: recordingOv,
      now: () => new Date("2026-08-13T10:00:00Z"),
    });
    await expect(failed.archiveAndClose(42)).rejects.toThrow(/EACCES/);
    expect(live.has("pr-42")).toBe(false);
    expect(ovCalls).toEqual(["create pr-42", "delete pr-42"]);
  });
});

describe("what a close writes into the archive record", () => {
  function seedSessionArtifacts(lifecycle: PrSessionLifecycle, session: string): void {
    const sdir = join(lifecycle.sessionDir(session), "--home-sandbox--");
    mkdirSync(sdir, { recursive: true });
    writeFileSync(join(sdir, "20260810_old.jsonl"), '{"type":"session","n":1}\n');
    writeFileSync(join(sdir, "20260812_new.jsonl"), '{"type":"session","n":2}\n');
    mkdirSync(join(root, "state", "ledgers"), { recursive: true });
    writeFileSync(lifecycle.ledgerPath(session), "LEDGER PR #42 @ abc123\n");
    mkdirSync(join(root, "verdict"), { recursive: true });
    writeFileSync(join(root, "verdict", "pr-42-round-1.json"), '{"verdict":"APPROVE"}');
    writeFileSync(join(root, "verdict", "pr-99-round-1.json"), '{"verdict":"APPROVE"}');
  }

  it("picks the newest session JSONL", () => {
    const lifecycle = open();
    seedSessionArtifacts(lifecycle, "pr-42");
    expect(lifecycle.newestSessionFile("pr-42")).toContain("20260812_new.jsonl");
    expect(lifecycle.newestSessionFile("pr-1")).toBeUndefined();
  });

  it("records the ledger, this PR's verdicts and meta.json — never the JSONL — and drops the worktree", async () => {
    const lifecycle = open();
    live.add("pr-42");
    seedSessionArtifacts(lifecycle, "pr-42");
    mkdirSync(lifecycle.worktrees.worktreePath(42), { recursive: true });

    await lifecycle.archiveAndClose(42);

    const dest = lifecycle.archiveDir("pr-42");
    // The transcript is the archiver's to keep (every file, verified and
    // compressed, once safe to move) — the close path copies none of it.
    expect(existsSync(join(dest, "session.jsonl"))).toBe(false);
    expect(readFileSync(join(dest, "ledger.md"), "utf8")).toBe("LEDGER PR #42 @ abc123\n");
    expect(readdirSync(join(dest, "verdicts"))).toEqual(["pr-42-round-1.json"]);
    const meta = JSON.parse(readFileSync(join(dest, "meta.json"), "utf8"));
    expect(meta.archived_at).toBe("2026-08-13T10:00:00.000Z");
    // meta.json still names the live source the archiver compares against.
    expect(meta.session_file).toBe(
      join(lifecycle.sessionDir("pr-42"), "--home-sandbox--", "20260812_new.jsonl"),
    );
    expect(meta.files.some((f: string) => f.endsWith(".jsonl"))).toBe(false);
    // The live transcripts are untouched: they leave only through the archiver.
    expect(existsSync(meta.session_file)).toBe(true);
    // `qcr why` still reads the record.
    const store = new StateStore(":memory:");
    try {
      const why = whyJson(store, 42, dest);
      expect(why.ledger).toBe("LEDGER PR #42 @ abc123\n");
      expect(why.archive).toEqual(expect.arrayContaining(["ledger.md", "meta.json"]));
      expect(why.archive).not.toContain("session.jsonl");
    } finally {
      store.close();
    }

    expect(gitCalls.some((a) => a.startsWith("worktree remove --force"))).toBe(true);
    expect(gitCalls).toContain("worktree prune");
    expect(live.has("pr-42")).toBe(false);
  });

  it("archives what exists when the session left no JSONL", async () => {
    const lifecycle = open();
    await lifecycle.archiveAndClose(42);
    const dest = lifecycle.archiveDir("pr-42");
    expect(existsSync(join(dest, "meta.json"))).toBe(true);
    expect(existsSync(join(dest, "session.jsonl"))).toBe(false);
    expect(JSON.parse(readFileSync(join(dest, "meta.json"), "utf8")).session_file).toBe(null);
  });
});

// Closed PRs' sessions can linger on the server (a failed delete, or a close
// the daemon never saw). The reconcile pass sweeps them: closed PRs only,
// bounded, every outcome logged.
describe("the stale raw-tier sweep", () => {
  const sweeper = (
    store: StateStore,
    listed: string[] | Error,
    remove: (id: string) => Promise<boolean> = async () => true,
    now = () => new Date("2026-10-06T12:00:00Z"),
    config: Config = cfg(),
  ) => {
    const removed: string[] = [];
    const listCalls: number[] = [];
    const lifecycle = open({
      store,
      now,
      config,
      ov: {
        create: async () => true,
        remove: async (id: string) => (removed.push(id), remove(id)),
        list: async () => {
          listCalls.push(1);
          return listed instanceof Error
            ? { ok: false as const, reason: listed.message }
            : { ok: true as const, ids: listed };
        },
      },
    });
    return { lifecycle, removed, listCalls };
  };

  it("deletes the sessions of CLOSED PRs only, and records each one", async () => {
    const store = new StateStore(":memory:");
    trackedPr(store, 1, "closed");
    trackedPr(store, 2, "tracked");
    trackedPr(store, 3, "closed");
    const { lifecycle, removed } = sweeper(store, ["pr-1", "pr-2", "pr-3", "pr-404", "overseer"]);
    const report = await lifecycle.sweepStaleOvSessions();
    expect(removed).toEqual(["pr-1", "pr-3"]);
    expect(report).toEqual({
      listed: 5,
      stale: 2,
      deleted: ["pr-1", "pr-3"],
      failed: [],
      deferred: 0,
    });
    expect(events(store, "openviking_session_deleted")).toEqual([
      { pr: 1, session: "pr-1", source: "sweep" },
      { pr: 3, session: "pr-3", source: "sweep" },
    ]);
    store.close();
  });

  it("is bounded per pass — the rest are left for the next", async () => {
    const store = new StateStore(":memory:");
    const ids: string[] = [];
    for (let n = 1; n <= 13; n++) {
      trackedPr(store, n, "closed");
      ids.push(`pr-${n}`);
    }
    const { lifecycle, removed } = sweeper(store, ids);
    const first = await lifecycle.sweepStaleOvSessions();
    expect(removed).toHaveLength(10);
    expect(first).toMatchObject({ stale: 13, deferred: 3 });
  });

  it("a closed PR whose session still runs keeps its raw tier until the session is gone", async () => {
    const store = new StateStore(":memory:");
    trackedPr(store, 7, "closed");
    live.add("pr-7");
    keepKilled = true;
    const { lifecycle, removed } = sweeper(store, ["pr-7"]);
    expect(await lifecycle.sweepStaleOvSessions()).toMatchObject({ deleted: [], deferred: 1 });
    expect(removed).toEqual([]);
    live.delete("pr-7");
    expect(await lifecycle.sweepStaleOvSessions()).toMatchObject({ deleted: ["pr-7"] });
  });

  it("a listing the host could not give holds the raw tier, never reads it as gone", async () => {
    const store = new StateStore(":memory:");
    trackedPr(store, 8, "closed");
    const { lifecycle, removed } = sweeper(store, ["pr-8"]);
    listingUnknown = true;
    expect(await lifecycle.sweepStaleOvSessions()).toMatchObject({ deleted: [], deferred: 1 });
    expect(removed).toEqual([]);
    listingUnknown = false;
    expect(await lifecycle.sweepStaleOvSessions()).toMatchObject({ deleted: ["pr-8"] });
  });

  it("a delete that fails is logged and recorded, and waits an hour before the next try", async () => {
    const store = new StateStore(":memory:");
    trackedPr(store, 9, "closed");
    let clock = new Date("2026-10-06T12:00:00Z");
    let ok = false;
    const { lifecycle, removed } = sweeper(
      store,
      ["pr-9"],
      async () => ok,
      () => clock,
    );
    expect(await lifecycle.sweepStaleOvSessions()).toMatchObject({
      failed: ["pr-9"],
      deleted: [],
    });
    expect(events(store, "openviking_session_delete_failed")).toEqual([
      { pr: 9, session: "pr-9", source: "sweep" },
    ]);
    clock = new Date("2026-10-06T12:30:00Z");
    expect(await lifecycle.sweepStaleOvSessions()).toMatchObject({ failed: [], deferred: 1 });
    expect(removed).toEqual(["pr-9"]);
    clock = new Date("2026-10-06T13:01:00Z");
    ok = true;
    expect(await lifecycle.sweepStaleOvSessions()).toMatchObject({ deleted: ["pr-9"] });
  });

  it("never holds the reconcile poll: a failed delete ends the pass, and so does its time budget", async () => {
    const store = new StateStore(":memory:");
    for (const n of [1, 2, 3]) trackedPr(store, n, "closed");
    const failing = sweeper(store, ["pr-1", "pr-2", "pr-3"], async () => false);
    expect(await failing.lifecycle.sweepStaleOvSessions()).toMatchObject({
      failed: ["pr-1"],
      deferred: 2,
    });
    expect(failing.removed).toEqual(["pr-1"]);
    // A server slow enough that each delete takes 6 s: the second is the last.
    let ms = Date.parse("2026-10-06T12:00:00Z");
    const slow = sweeper(
      store,
      ["pr-1", "pr-2", "pr-3"],
      async () => ((ms += 6_000), true),
      () => new Date(ms),
    );
    expect(await slow.lifecycle.sweepStaleOvSessions()).toMatchObject({
      deleted: ["pr-1", "pr-2"],
      deferred: 1,
    });
  });

  it("a list it cannot read deletes nothing and says why — never a throw", async () => {
    const store = new StateStore(":memory:");
    trackedPr(store, 1, "closed");
    const { lifecycle, removed } = sweeper(store, new Error("401: Invalid API Key"));
    expect(await lifecycle.sweepStaleOvSessions()).toEqual({
      listed: 0,
      stale: 0,
      deleted: [],
      failed: [],
      deferred: 0,
      error: "401: Invalid API Key",
    });
    expect(removed).toEqual([]);
    // No raw tier managed at all ⇒ no sweep.
    expect(await open({ store }).sweepStaleOvSessions()).toBeNull();
  });

  it("memory switched off runs no sweep at all — no list sent to a server that is not running", async () => {
    const store = new StateStore(":memory:");
    trackedPr(store, 1, "closed");
    const off = cfg({ openviking: { enabled: false } } as unknown as Partial<Config>);
    const { lifecycle, removed, listCalls } = sweeper(store, ["pr-1"], undefined, undefined, off);
    expect(await lifecycle.sweepStaleOvSessions()).toBeNull();
    expect(listCalls).toEqual([]);
    expect(removed).toEqual([]);
  });

  it("re-reads the registry right before each delete: a PR reopened after the plan keeps its raw tier", async () => {
    const store = new StateStore(":memory:");
    trackedPr(store, 1, "closed");
    trackedPr(store, 2, "closed");
    // While pr-1's delete is in flight, PR #2 is reopened and re-triggered
    // — dispatch is about to reuse `pr-2`.
    const { lifecycle, removed } = sweeper(store, ["pr-1", "pr-2"], async (id) => {
      if (id === "pr-1") trackedPr(store, 2, "tracked");
      return true;
    });
    expect(await lifecycle.sweepStaleOvSessions()).toMatchObject({
      stale: 2,
      deleted: ["pr-1"],
      deferred: 1,
    });
    expect(removed).toEqual(["pr-1"]);
  });
});

describe("closed PR lifecycle across awaited session work", () => {
  function deferred() {
    let release!: () => void;
    const promise = new Promise<void>((resolve) => {
      release = resolve;
    });
    return { promise, release };
  }
  const tracked = (store: StateStore): void => trackedPr(store, 42, "tracked");

  /** A lifecycle whose raw tier is observable and whose delete can be held. */
  function heldRawTier(store: StateStore, hold: Promise<void>, entered: { release(): void }) {
    const state = { rawExists: false };
    const ov: OvSessionLifecycle = {
      create: async (id) => {
        ovCalls.push(`create ${id}`);
        state.rawExists = true;
        return true;
      },
      remove: async (id) => {
        ovCalls.push(`delete ${id}`);
        entered.release();
        await hold;
        state.rawExists = false;
        return true;
      },
      list: async () => ({ ok: true as const, ids: ["pr-42"] }),
    };
    return { state, lifecycle: open({ store, ov }) };
  }

  it("a close while the birth awaits stops that completed birth before returning", async () => {
    const store = new StateStore(":memory:");
    try {
      tracked(store);
      const lifecycle = open({ store, ov: recordingOv });
      const entered = deferred();
      const finish = deferred();
      beforeSpawn = async () => {
        entered.release();
        await finish.promise;
      };
      const birth = lifecycle.ensureSession(42, "T", "wt/pr-42");
      await entered.promise;
      store.setPrState(42, "closed");
      const close = lifecycle.archiveAndClose(42);
      finish.release();
      await Promise.all([birth, close]);
      expect(live.has("pr-42")).toBe(false);
      expect(ovCalls).toEqual(["create pr-42", "delete pr-42"]);
    } finally {
      store.close();
    }
  });

  it("a reopened PR is spared the old close stop and raw-tier deletion", async () => {
    const store = new StateStore(":memory:");
    try {
      tracked(store);
      const lifecycle = open({ store, ov: recordingOv });
      await lifecycle.ensureSession(42, "T", "wt/pr-42");
      store.setPrState(42, "closed");
      const entered = deferred();
      const finish = deferred();
      lifecycle.worktrees.remove = async () => {
        entered.release();
        await finish.promise;
      };
      const close = lifecycle.archiveAndClose(42);
      await entered.promise;
      store.setPrState(42, "tracked");
      finish.release();
      await close;
      expect(live.has("pr-42")).toBe(true);
      expect(ovCalls).toEqual(["create pr-42"]);
    } finally {
      store.close();
    }
  });

  it.each(["close", "sweep"])(
    "a reopened birth waits for %s raw-tier deletion before recreating memory",
    async (cleanup) => {
      const store = new StateStore(":memory:");
      const finish = deferred();
      try {
        tracked(store);
        const entered = deferred();
        const { state, lifecycle } = heldRawTier(store, finish.promise, entered);
        await lifecycle.ensureSession(42, "T", "wt/pr-42");
        store.setPrState(42, "closed");
        if (cleanup === "sweep") live.delete("pr-42");
        const close =
          cleanup === "close" ? lifecycle.archiveAndClose(42) : lifecycle.sweepStaleOvSessions();
        await entered.promise;
        store.setPrState(42, "tracked");
        const replacement = lifecycle.ensureSession(42, "Reopened", "wt/pr-42");
        const birthStartedDuringClose = lifecycle.birthInFlight(42);
        if (birthStartedDuringClose) await replacement;
        finish.release();
        await Promise.all([close, replacement]);
        expect(state.rawExists).toBe(true);
        expect(live.has("pr-42")).toBe(true);
        expect(birthStartedDuringClose).toBe(false);
        expect(ovCalls).toEqual(["create pr-42", "delete pr-42", "create pr-42"]);
      } finally {
        finish.release();
        store.close();
      }
    },
  );

  it.each(["close", "sweep"])(
    "a reopened birth waits for the %s's awaited stop",
    async (cleanup) => {
      const store = new StateStore(":memory:");
      const finish = deferred();
      try {
        tracked(store);
        const lifecycle = open({
          store,
          ov: { ...recordingOv, list: async () => ({ ok: true as const, ids: [] }) },
        });
        await lifecycle.ensureSession(42, "T", "wt/pr-42");
        const entered = deferred();
        beforeKill = async () => {
          entered.release();
          await finish.promise;
        };
        store.setPrState(42, "closed");
        const close =
          cleanup === "close" ? lifecycle.archiveAndClose(42) : lifecycle.sweepStaleOvSessions();
        await entered.promise;
        store.setPrState(42, "tracked");
        const replacement = lifecycle.ensureSession(42, "Reopened", "wt/pr-42");
        const birthStartedDuringClose = lifecycle.birthInFlight(42);
        if (birthStartedDuringClose) await replacement;
        finish.release();
        await Promise.all([close, replacement]);
        expect(live.has("pr-42")).toBe(true);
        expect(birthStartedDuringClose).toBe(false);
      } finally {
        finish.release();
        store.close();
      }
    },
  );

  it("a close queued behind a sweep stop still performs its archive and raw-tier cleanup", async () => {
    const store = new StateStore(":memory:");
    const finish = deferred();
    try {
      tracked(store);
      const lifecycle = open({
        store,
        ov: { ...recordingOv, list: async () => ({ ok: true as const, ids: [] }) },
      });
      await lifecycle.ensureSession(42, "T", "wt/pr-42");
      store.setPrState(42, "closed");
      const entered = deferred();
      beforeKill = async () => {
        entered.release();
        await finish.promise;
        beforeKill = undefined;
      };
      const removed: number[] = [];
      lifecycle.worktrees.remove = async (pr: number) => void removed.push(pr);
      const sweep = lifecycle.sweepStaleOvSessions();
      await entered.promise;
      const close = lifecycle.archiveAndClose(42);
      finish.release();
      await Promise.all([sweep, close]);
      expect(removed).toEqual([42]);
      expect(ovCalls).toEqual(["create pr-42", "delete pr-42"]);
    } finally {
      finish.release();
      store.close();
    }
  });

  it("the reconcile sweep retries a surviving closed session even with memory disabled", async () => {
    const store = new StateStore(":memory:");
    try {
      tracked(store);
      const off = cfg({ openviking: { enabled: false } } as unknown as Partial<Config>);
      const lifecycle = open({ store, config: off });
      live.add("pr-42");
      store.setPrState(42, "closed");
      keepKilled = true;
      await lifecycle.archiveAndClose(42);
      expect(live.has("pr-42")).toBe(true);
      keepKilled = false;
      await expect(lifecycle.sweepStaleOvSessions()).resolves.toBeNull();
      expect(live.has("pr-42")).toBe(false);
    } finally {
      store.close();
    }
  });

  it("memory off sends no raw-tier birth or death request", async () => {
    const off = cfg({ openviking: { enabled: false } } as unknown as Partial<Config>);
    const lifecycle = open({ ov: recordingOv, config: off });
    await lifecycle.ensureSession(42, "T", "wt/pr-42");
    expect(ovCalls).toEqual([]);
    await lifecycle.archiveAndClose(42);
    expect(ovCalls).toEqual([]);
  });
});
