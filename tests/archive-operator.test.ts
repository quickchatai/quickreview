// The operator's archive verbs (docs/archiving.md §11):
//
//   (1) `archive-run` and `archive-restore` are OPERATOR commands: a file in
//       a session's `commands/` dir (or an unsealed operator dir) is refused;
//       from the root-sealed `commands/operator/` they execute under the
//       archiver's strict mutex and write their result. A restore issued
//       during a pass waits for the file boundary — the pass yields there,
//       starts no next file and unlinks nothing.
//
// Plus: the strict schemas; the belt in `executeCommand`; Slack can never
// authorize them; mode `off` refuses a run, a run forces a fresh plan and
// still obeys every hold; an operator restore works on a closed PR (and in
// plan mode), is idempotent, and is joined — never run twice — when a birth's
// restore is already in flight; an answer that cannot wait says `done:
// false`; the CLI client writes as root and reads the daemon's receipt; and
// wire.ts connects both handlers.
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { archiveRow } from "../src/archive/rows.js";
import { OPERATOR_WAIT_MS } from "../src/archive/status.js";
import { ARCHIVE_USAGE, parseArchiveArgs } from "../src/cli.js";
import {
  COMMAND_WHITELIST,
  CommandWatcher,
  OPERATOR_COMMANDS,
  authorizeCommand,
  executeCommand,
  processOperatorSeal,
  validateCommand,
  type CommandDeps,
  type OperatorSeal,
} from "../src/commands.js";
import type { TuiConfig } from "../src/config.js";
import {
  ArchiveOpSender,
  archiveOpPayload,
  archiveOpTimeoutMs,
  renderArchiveOp,
} from "../src/tui/archiveops.js";
import type { RemoteResult, SshRunner } from "../src/tui/remote.js";
import type { Archiver } from "../src/archive/archiver.js";
import { filesUnder, onArchiver, prFixture, reopen, type PrFixture } from "./helpers/archive-pr.js";
import { HEAVY_TIMEOUT_MS } from "./helpers/suite-timeouts.js";

const open: PrFixture[] = [];
const archivers: Archiver[] = [];
afterEach(() => {
  for (const a of archivers.splice(0)) a.stop();
  for (const f of open.splice(0)) f.close();
});

function fixture(): PrFixture {
  const f = prFixture();
  open.push(f);
  return f;
}

function archiverOn(
  f: PrFixture,
  cfg: Parameters<typeof onArchiver>[1] = {},
  extra: Parameters<typeof onArchiver>[2] = {},
): Archiver {
  const a = onArchiver(f, cfg, extra);
  archivers.push(a);
  return a;
}

/** The daemon's handlers, as wire.ts connects them. */
const depsOf = (a: Archiver): CommandDeps =>
  ({
    archiveRun: () => a.operatorRun(),
    archiveRestore: (pr: number) => a.operatorRestore(pr),
  }) as unknown as CommandDeps;

/** A ROOT-owned 0755 directory and 0644 files, seen by a daemon uid 1001. */
const sealed: OperatorSeal = {
  euid: 1001,
  gids: [1001],
  stat: (p) =>
    p.endsWith(".json")
      ? { uid: 0, gid: 0, mode: 0o644, kind: "file" }
      : { uid: 0, gid: 0, mode: 0o755, kind: "dir" },
};

const resultOf = (commandsDir: string, name: string): Record<string, unknown> =>
  JSON.parse(readFileSync(join(commandsDir, "results", `${name}.result.json`), "utf8")) as Record<
    string,
    unknown
  >;

const turns = async (n: number): Promise<void> => {
  for (let i = 0; i < n; i++) await new Promise((r) => setImmediate(r));
};

describe("archive-run / archive-restore are the operator's alone", () => {
  it("are operator commands, not in the session vocabulary, and a session cannot spell them", () => {
    expect(OPERATOR_COMMANDS).toEqual(expect.arrayContaining(["archive-run", "archive-restore"]));
    for (const c of OPERATOR_COMMANDS) expect(COMMAND_WHITELIST).not.toContain(c);
    for (const raw of [{ command: "archive-run" }, { command: "archive-restore", pr: 5406 }]) {
      for (const v of [validateCommand(raw), validateCommand(raw, { issuer: "session" })]) {
        expect(v.ok, raw.command).toBe(false);
        if (!v.ok) {
          expect(v.reason).toMatch(/OPERATOR's alone/);
          expect(v.reason).toContain("qcr archive run|restore");
        }
      }
      expect(validateCommand(raw, { issuer: "operator" }).ok).toBe(true);
    }
  });

  it("strict schemas from the operator channel", () => {
    const op = { issuer: "operator" as const };
    expect(validateCommand({ command: "archive-run", pr: 1 }, op)).toEqual({
      ok: false,
      reason: "unknown field(s): pr",
    });
    expect(validateCommand({ command: "archive-restore", pr: 7, all: true }, op)).toEqual({
      ok: false,
      reason: "unknown field(s): all",
    });
    for (const pr of [0, -3, 1.5, "7", null, undefined])
      expect(validateCommand({ command: "archive-restore", pr }, op).ok, String(pr)).toBe(false);
    expect(validateCommand({ command: "archive-restore", pr: 7 }, op)).toEqual({
      ok: true,
      command: { command: "archive-restore", pr: 7 },
    });
  });

  it("executeCommand refuses any issuer but the operator, and Slack can never authorize them", async () => {
    const calls: unknown[] = [];
    const deps = {
      archiveRun: (file: string) => (calls.push(["run", file]), { ok: true }),
      archiveRestore: (pr: number, file: string) => (
        calls.push(["restore", pr, file]),
        { ok: true }
      ),
    } as unknown as CommandDeps;
    expect((await executeCommand({ command: "archive-run" }, deps)).ok).toBe(false);
    expect(
      await executeCommand({ command: "archive-restore", pr: 9 }, deps, {
        file: "f",
        issuer: "session",
      }),
    ).toMatchObject({ ok: false, reason: expect.stringMatching(/operator's alone/) });
    expect(calls).toEqual([]);
    const op = { file: "k1", issuer: "operator" as const };
    expect(await executeCommand({ command: "archive-run" }, deps, op)).toEqual({ ok: true });
    expect(await executeCommand({ command: "archive-restore", pr: 9 }, deps, op)).toEqual({
      ok: true,
    });
    expect(calls).toEqual([
      ["run", "k1"],
      ["restore", 9, "k1"],
    ]);
    // A daemon wired without the archiver says so instead of pretending.
    expect(await executeCommand({ command: "archive-run" }, {} as CommandDeps, op)).toEqual({
      ok: false,
      reason: "archive-run is not wired on this daemon",
    });
    const owner = {
      tier: "owner",
      source: "slack",
      slack_user: "U1",
      authorized_prs: [9],
    } as never;
    expect(authorizeCommand({ command: "archive-run" }, owner)).toMatchObject({ ok: false });
    expect(authorizeCommand({ command: "archive-restore", pr: 9 }, null)).toMatchObject({
      ok: false,
    });
  });
});

describe("through the CommandWatcher (acceptance 1)", () => {
  let dirs: string[] = [];
  afterEach(() => {
    for (const d of dirs) rmSync(d, { recursive: true, force: true });
    dirs = [];
  });
  const commandsRoot = (): string => {
    const d = mkdtempSync(join(tmpdir(), "qcr-archive-ops-"));
    dirs.push(d);
    mkdirSync(join(d, "commands"), { recursive: true });
    return join(d, "commands");
  };

  it("a SESSION's commands/ dir cannot run or restore — refused, nothing touched", async () => {
    const f = fixture();
    const a = archiverOn(f);
    let called = 0;
    const deps = {
      archiveRun: () => (called++, a.operatorRun()),
      archiveRestore: (pr: number) => (called++, a.operatorRestore(pr)),
    } as unknown as CommandDeps;
    const dir = commandsRoot();
    writeFileSync(join(dir, "s1.json"), JSON.stringify({ command: "archive-run" }));
    writeFileSync(join(dir, "s2.json"), JSON.stringify({ command: "archive-restore", pr: f.pr }));
    const w = new CommandWatcher({ dir, deps, store: f.store, log: () => {} });
    await w.sweep();
    w.stop();
    for (const name of ["s1", "s2"])
      expect(resultOf(dir, name)).toMatchObject({
        ok: false,
        issuer: "session",
        reason: expect.stringMatching(/OPERATOR's alone/),
      });
    expect(called).toBe(0);
    expect(archiveRow(f.store, f.pr)).toBeNull();
    for (const rel of f.transcripts) expect(existsSync(join(f.root, rel))).toBe(true);
  });

  it("an UNSEALED operator directory is a session's: refused, loudly", async () => {
    const f = fixture();
    const a = archiverOn(f);
    const dir = commandsRoot();
    const op = join(dir, "operator");
    mkdirSync(op);
    writeFileSync(join(op, "u1.json"), JSON.stringify({ command: "archive-run" }));
    const w = new CommandWatcher({
      dir: op,
      operator: processOperatorSeal(),
      deps: depsOf(a),
      store: f.store,
      sweepIntervalMs: 0,
      log: () => {},
    });
    await w.sweep();
    w.stop();
    expect(resultOf(dir, "u1")).toMatchObject({ ok: false, issuer: "session" });
    expect(archiveRow(f.store, f.pr)).toBeNull();
  });

  it(
    "from the SEALED operator dir: archive-run executes under the strict mutex and writes its result",
    { timeout: HEAVY_TIMEOUT_MS },
    async () => {
      const f = fixture();
      const heldDuring: boolean[] = [];
      // `a` is read only when a step runs, long after it is assigned.
      const a: Archiver = archiverOn(
        f,
        {},
        {
          step: (name) => {
            if (name === "renamed") heldDuring.push(a.busy());
          },
        },
      );
      const dir = commandsRoot();
      const op = join(dir, "operator");
      mkdirSync(op);
      writeFileSync(join(op, "k1.json"), JSON.stringify({ command: "archive-run" }));
      const w = new CommandWatcher({
        dir: op,
        operator: sealed,
        deps: depsOf(a),
        store: f.store,
        sweepIntervalMs: 0,
      });
      await w.sweep();
      w.stop();
      const r = resultOf(dir, "k1");
      expect(r).toMatchObject({
        ok: true,
        issuer: "operator",
        command: "archive-run",
        done: true,
        mode: "on",
        state: "idle",
        planned: true,
      });
      expect(r["files"]).toMatchObject({ prs_archived: 1 });
      // Every file protocol step ran while the strict mutex was held.
      expect(heldDuring.length).toBeGreaterThan(0);
      expect(heldDuring.every(Boolean)).toBe(true);
      expect(a.busy()).toBe(false);
      expect(archiveRow(f.store, f.pr)?.state).toBe("archived");
      for (const rel of f.transcripts) expect(existsSync(join(f.root, rel))).toBe(false);
    },
  );

  it(
    "from the SEALED operator dir: archive-restore puts a closed PR's archive back and writes its result",
    { timeout: HEAVY_TIMEOUT_MS },
    async () => {
      const f = fixture();
      const a = archiverOn(f);
      await a.tick();
      expect(archiveRow(f.store, f.pr)?.state).toBe("archived");
      const dir = commandsRoot();
      const op = join(dir, "operator");
      mkdirSync(op);
      writeFileSync(join(op, "k2.json"), JSON.stringify({ command: "archive-restore", pr: f.pr }));
      const w = new CommandWatcher({
        dir: op,
        operator: sealed,
        deps: depsOf(a),
        store: f.store,
        sweepIntervalMs: 0,
      });
      await w.sweep();
      w.stop();
      expect(resultOf(dir, "k2")).toMatchObject({
        ok: true,
        issuer: "operator",
        done: true,
        outcome: "restored",
        restored: f.transcripts.length + 1, // the transcripts and the one payload
      });
      // The PR is still closed; its files are back, and it is re-eligible only
      // `after_days` after the restore.
      expect(f.store.getPr(f.pr)?.state).toBe("closed");
      const row = archiveRow(f.store, f.pr)!;
      expect(row.state).toBe("restored");
      for (const rel of f.transcripts)
        expect(readFileSync(join(f.root, rel)).equals(f.bytes.get(rel)!), rel).toBe(true);
      // A fresh plan counts the window from the restore: inside it, nothing
      // moves again.
      const again = await a.operatorRun();
      expect(again).toMatchObject({ ok: true, planned: true });
      expect(a.lastPlan()?.registry).toMatchObject({ waiting: 1, eligible: 0 });
      for (const rel of f.transcripts) expect(existsSync(join(f.root, rel))).toBe(true);
    },
  );
});

describe("a restore issued during a pass waits for the file boundary (acceptance 1)", () => {
  it(
    "the pass finishes the file in hand, starts no next one, unlinks nothing — then the restore runs",
    { timeout: HEAVY_TIMEOUT_MS },
    async () => {
      const f = fixture();
      const order: string[] = [];
      let release!: () => void;
      const gate = new Promise<void>((r) => (release = r));
      let reached!: () => void;
      const atStep = new Promise<void>((r) => (reached = r));
      let held = false;
      const a = archiverOn(
        f,
        {},
        {
          step: async (name, info) => {
            order.push(`${name}${typeof info.source === "string" ? `:${info.source}` : ""}`);
            if (!held && name === "renamed" && info.src !== undefined) {
              held = true;
              reached();
              await gate;
            }
          },
        },
      );
      const tick = a.tick();
      await atStep;
      // The operator restores the PR whose pass is mid-file.
      let settled = false;
      const restore = a.operatorRestore(f.pr).then((r) => {
        order.push("restore-answered");
        settled = true;
        return r;
      });
      await turns(20);
      expect(settled).toBe(false); // it waits for the mutex…
      expect(a.busy()).toBe(true);
      release();
      expect((await tick).state).toBe("idle"); // …the pass yields to it…
      const r = await restore;
      expect(r).toMatchObject({ ok: true, done: true, outcome: "restored" });
      // …at the FILE BOUNDARY: the file in hand got its manifest entry, no
      // next file was started, nothing was unlinked.
      const cut = order.indexOf("renamed");
      const after = order.slice(cut + 1);
      expect(after[0]).toMatch(/^manifest_appended/);
      expect(after.slice(0, after.indexOf("restore-answered"))).not.toContain("partial_written");
      expect(order.filter((s) => s.startsWith("unlinked"))).toEqual([]);
      for (const rel of [...f.transcripts, ...f.small])
        expect(existsSync(join(f.root, rel)), rel).toBe(true);
      expect(archiveRow(f.store, f.pr)?.state).toBe("restored");
    },
  );
});

describe("a restore issued during the unlinks waits only for the unlink in hand", () => {
  it(
    "the pass stops unlinking at the next file boundary — then the restore runs",
    { timeout: HEAVY_TIMEOUT_MS },
    async () => {
      const f = fixture();
      let release!: () => void;
      const gate = new Promise<void>((r) => (release = r));
      let reached!: () => void;
      const atStep = new Promise<void>((r) => (reached = r));
      let unlinked = 0;
      const a = archiverOn(
        f,
        {},
        {
          step: async (name) => {
            if (name !== "unlinked") return;
            unlinked += 1;
            if (unlinked === 1) {
              reached();
              await gate;
            }
          },
        },
      );
      const tick = a.tick();
      await atStep;
      const restore = a.operatorRestore(f.pr);
      await turns(20);
      release();
      await tick;
      const r = await restore;
      expect(r).toMatchObject({ ok: true, done: true, outcome: "restored" });
      // One unlink, then the restore: the rest of the PR's sources stayed.
      expect(unlinked).toBe(1);
      for (const rel of f.transcripts) expect(existsSync(join(f.root, rel)), rel).toBe(true);
      expect(archiveRow(f.store, f.pr)?.state).toBe("restored");
    },
  );
});

describe("operatorRun", () => {
  it("mode off refuses — nothing runs", async () => {
    const f = fixture();
    const a = archiverOn(f, { mode: "off" });
    expect(await a.operatorRun()).toMatchObject({
      ok: false,
      reason: expect.stringContaining('mode = "off"'),
    });
    expect(a.status().last_tick_at).toBeNull();
  });

  it("forces a fresh plan in plan mode, moves nothing, and every hold still binds", async () => {
    const f = fixture();
    let plans = 0;
    const a = archiverOn(
      f,
      { mode: "plan" },
      {
        plan: async () => {
          plans += 1;
          return {
            computed_at: new Date(f.clock.ms).toISOString(),
            backlog: { prs: 0, bytes: 0, event_rows: 0, delivery_rows: 0 },
            candidates: [],
            empty: [],
            held: [],
            orphans: [],
            max_sync_span_ms: 0,
            took_ms: 0,
          } as never;
        },
      },
    );
    expect(await a.operatorRun()).toMatchObject({
      ok: true,
      done: true,
      state: "plan",
      planned: true,
    });
    // A plan minutes old is recomputed for the operator's run all the same.
    expect(await a.operatorRun()).toMatchObject({ ok: true, state: "plan", planned: true });
    expect(plans).toBe(2);
    // The ordinary tick does not.
    expect((await a.tick()).planned).toBe(false);
    for (const rel of f.transcripts) expect(existsSync(join(f.root, rel))).toBe(true);
    // A drain holds the operator's tick too, and the answer names it.
    f.store.engageDrain({ issuer: "operator", expires_at: null });
    expect(await a.operatorRun()).toMatchObject({
      ok: true,
      state: "held",
      held_reason: "draining",
    });
    expect(plans).toBe(2);
  });

  it("the start delay holds it, and the answer says until when", async () => {
    const f = fixture();
    const a = archiverOn(
      f,
      { start_delay_min: 60 },
      {
        firstHealthyReconcileAt: () => new Date(f.clock.ms - 60_000),
      },
    );
    const r = await a.operatorRun();
    expect(r).toMatchObject({ ok: true, state: "held", held_reason: "start_delay" });
    expect(typeof r["held_until"]).toBe("string");
    expect(archiveRow(f.store, f.pr)).toBeNull();
  });

  it("a tick that outlasts the wait answers done:false — and goes on", async () => {
    const f = fixture();
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const a = archiverOn(
      f,
      { mode: "plan" },
      {
        operatorWaitMs: 5,
        plan: async () => {
          await gate;
          return {
            computed_at: new Date(f.clock.ms).toISOString(),
            backlog: { prs: 0, bytes: 0, event_rows: 0, delivery_rows: 0 },
            candidates: [],
            empty: [],
            held: [],
            orphans: [],
            max_sync_span_ms: 0,
            took_ms: 0,
          } as never;
        },
      },
    );
    expect(await a.operatorRun()).toMatchObject({ ok: true, done: false, state: "running" });
    expect(a.busy()).toBe(true);
    release();
    await a.tick(); // joins the one still running
    expect(a.status().state).toBe("plan");
    expect(OPERATOR_WAIT_MS).toBe(60_000);
  });
});

describe("operatorRestore", () => {
  it("a PR with no archive row, and one restored already, answer outcome none", async () => {
    const f = fixture();
    const a = archiverOn(f);
    expect(await a.operatorRestore(999_999)).toMatchObject({
      ok: true,
      outcome: "none",
      note: expect.stringContaining("no archive row"),
    });
    await a.tick();
    expect((await a.operatorRestore(f.pr)).outcome).toBe("restored");
    expect(await a.operatorRestore(f.pr)).toMatchObject({
      ok: true,
      outcome: "none",
      note: expect.stringContaining("restored already"),
    });
  });

  it(
    "works in plan mode too (the way back), and joins a birth's restore already in flight",
    { timeout: HEAVY_TIMEOUT_MS },
    async () => {
      const f = fixture();
      await onArchiver(f).tick();
      let release!: () => void;
      const gate = new Promise<void>((r) => (release = r));
      let restoredFiles = 0;
      const a = archiverOn(
        f,
        {},
        {
          step: async (name) => {
            if (name === "restored_file") {
              restoredFiles += 1;
              await gate;
            }
          },
        },
      );
      reopen(f);
      const birth = a.beforeBirth(f.pr);
      await turns(20);
      const op = a.operatorRestore(f.pr);
      release();
      await birth;
      expect(await op).toMatchObject({ ok: true, done: true, outcome: "restored" });
      // ONE restore ran: each file restored once.
      expect(restoredFiles).toBe(f.transcripts.length + 1);

      // Plan mode: the operator's restore is the way back even there.
      const g = fixture();
      await onArchiver(g).tick();
      const p = archiverOn(g, { mode: "plan" });
      expect(await p.operatorRestore(g.pr)).toMatchObject({ ok: true, outcome: "restored" });
      for (const rel of g.transcripts) expect(existsSync(join(g.root, rel))).toBe(true);
    },
  );

  it(
    "a failed restore is ok:false with the reason, the wake raised, the row restore_failed",
    { timeout: HEAVY_TIMEOUT_MS },
    async () => {
      const f = fixture();
      await onArchiver(f).tick();
      // Corrupt every transcript gzip: nothing decompresses to its bytes.
      for (const p of filesUnder(f.root, join(f.root, "archive", `pr-${f.pr}`, "transcripts")))
        writeFileSync(join(f.root, p), "not a gzip");
      const a = archiverOn(f);
      const r = await a.operatorRestore(f.pr);
      expect(r).toMatchObject({ ok: false, done: true, outcome: "failed" });
      expect(String(r.reason)).toMatch(/not restored/);
      expect(archiveRow(f.store, f.pr)?.state).toBe("restore_failed");
      const wake = f.store.db
        .prepare(
          "SELECT payload FROM events WHERE kind = 'anomaly' AND json_extract(payload, '$.kind') = 'archive_restore_failed'",
        )
        .all() as Array<{ payload: string }>;
      expect(wake).toHaveLength(1);
      expect(wake[0]!.payload).toContain("The operator's restore");
      // The operator may retry at once (the 6 h spacing binds births, not them).
      expect((await a.operatorRestore(f.pr)).outcome).toBe("failed");
    },
  );
});

describe("an operator verb never holds the daemon's start (S4 review)", () => {
  /** A deadline loop, never a count of turns. */
  const until = async (cond: () => boolean, ms = 4000): Promise<void> => {
    const deadline = Date.now() + ms;
    while (!cond()) {
      if (Date.now() > deadline) throw new Error("condition not met before the deadline");
      await new Promise((r) => setTimeout(r, 5));
    }
  };

  it(
    "files left while the daemon was down, met by the startup sweep before the first healthy reconcile: answered at once, the restore goes on in the background",
    { timeout: HEAVY_TIMEOUT_MS },
    async () => {
      const f = fixture();
      await onArchiver(f).tick();
      expect(archiveRow(f.store, f.pr)?.state).toBe("archived");
      let release!: () => void;
      const gate = new Promise<void>((r) => (release = r));
      let reachedRestore = false;
      const a = archiverOn(
        f,
        {},
        {
          // The boot: no healthy reconcile yet.
          firstHealthyReconcileAt: () => null,
          step: async (name) => {
            if (name === "restored_file") {
              reachedRestore = true;
              await gate; // the restore cannot finish until released
            }
          },
        },
      );
      const root = mkdtempSync(join(tmpdir(), "qcr-archive-boot-"));
      try {
        const op = join(root, "commands", "operator");
        mkdirSync(op, { recursive: true });
        writeFileSync(
          join(op, "k3.json"),
          JSON.stringify({ command: "archive-restore", pr: f.pr }),
        );
        writeFileSync(join(op, "k4.json"), JSON.stringify({ command: "archive-run" }));
        const w = new CommandWatcher({
          dir: op,
          operator: sealed,
          deps: depsOf(a),
          store: f.store,
          sweepIntervalMs: 0,
          log: () => {},
        });
        // The daemon's start awaits this sweep. With the restore held at its
        // first file, it still returns — the default 60 s wait is not spent.
        await w.start();
        w.stop();
        expect(resultOf(join(root, "commands"), "k3")).toMatchObject({
          ok: true,
          issuer: "operator",
          done: false,
          outcome: "restoring",
          note: expect.stringContaining("first healthy reconcile"),
        });
        // The run is not queued behind the restore's mutex: no tick may run
        // before the first healthy reconcile, and the answer says so.
        expect(resultOf(join(root, "commands"), "k4")).toMatchObject({
          ok: true,
          done: true,
          state: "held",
          held_reason: "awaiting_reconcile",
          planned: false,
        });
        await until(() => reachedRestore);
        expect(a.busy()).toBe(true);
        expect(archiveRow(f.store, f.pr)?.state).toBe("restoring");
        release();
        await until(() => archiveRow(f.store, f.pr)?.state === "restored");
        for (const rel of f.transcripts)
          expect(readFileSync(join(f.root, rel)).equals(f.bytes.get(rel)!), rel).toBe(true);
      } finally {
        release();
        rmSync(root, { recursive: true, force: true });
      }
    },
  );
});

describe("the CLI client (`qcr archive run|restore <pr>`)", () => {
  const tui = {
    ssh_host: "my-vm",
    container: "quickreview-sandbox",
    sudo_docker: true,
    remote_sandbox_root: "/opt/quickreview/sandbox",
    remote_state_dir: "/opt/quickreview/state",
    msg_timeout_s: 30,
  } as unknown as TuiConfig;

  function runner(results: string[]): {
    ssh: SshRunner;
    calls: Array<{ argv: string[]; stdin?: string }>;
  } {
    const calls: Array<{ argv: string[]; stdin?: string }> = [];
    const ssh: SshRunner = async (_host, argv, opts) => {
      calls.push({ argv, ...(opts?.stdin !== undefined ? { stdin: opts.stdin } : {}) });
      const probe = argv.some((a) => a.includes("result.json"));
      return {
        ok: true,
        stdout: probe ? (results.shift() ?? "pending") : "",
        stderr: "",
        code: 0,
      } satisfies RemoteResult;
    };
    return { ssh, calls };
  }
  const sender = (ssh: SshRunner, now: () => Date = () => new Date("2026-10-21T12:00:00Z")) =>
    new ArchiveOpSender(tui, ssh, now, async () => {});

  it("parses run, restore <pr> and extract <pr> --to <dir>; refuses anything else", () => {
    expect(parseArchiveArgs(["run"])).toEqual({ verb: "run" });
    expect(parseArchiveArgs(["restore", "5406"])).toEqual({ verb: "restore", pr: 5406 });
    expect(parseArchiveArgs(["extract", "5406", "--to", "/tmp/x"])).toEqual({
      verb: "extract",
      pr: 5406,
      to: "/tmp/x",
    });
    for (const bad of [
      ["restore"],
      ["restore", "0"],
      ["restore", "-1"],
      ["restore", "12a"],
      ["restore", "5", "6"],
      ["extract", "5"],
      ["extract", "5", "/tmp/x"],
      ["extract", "5", "--to"],
      ["extract", "5", "--to", "--plan"],
      ["run", "--plan"],
      ["bogus"],
    ])
      expect(() => parseArchiveArgs(bad), bad.join(" ")).toThrow(ARCHIVE_USAGE);
  });

  it("writes AS ROOT into commands/operator/, the payload on stdin, and reports the daemon's own answer", async () => {
    const answer = {
      ok: true,
      issuer: "operator",
      done: true,
      mode: "on",
      state: "idle",
      held_reason: null,
      planned: true,
      backlog: { prs: 3, bytes: 2048, event_rows: 10, delivery_rows: 4 },
      db: null,
      files: null,
      stores: { overseer: null, pi_global: null },
    };
    const { ssh, calls } = runner(["pending", JSON.stringify(answer)]);
    const cmd = { command: "archive-run" } as const;
    const out = await sender(ssh).send(cmd);
    expect(out).toMatchObject({ ok: true, issuer: "operator", result: answer });
    const write = calls[0]!;
    expect(write.argv.slice(0, 7)).toEqual([
      "sudo",
      "docker",
      "exec",
      "-i",
      "-u",
      "0",
      "quickreview-sandbox",
    ]);
    expect(write.argv.join(" ")).toContain("commands/operator");
    expect(JSON.parse(write.stdin!)).toEqual({ command: "archive-run" });
    // The receipt is read back, never inferred from the write.
    expect(calls.slice(1).every((c) => c.argv.some((a) => a.includes("result.json")))).toBe(true);
    const lines = renderArchiveOp(cmd, out);
    expect(lines[0]).toContain("tick ran (mode on) — idle; plan recomputed");
    expect(lines.join("\n")).toContain("backlog 3 PR(s)");
  });

  // The result dir is one sessions can write: valid JSON that is not an
  // object is an unreadable receipt, never a throw. MUTATION: dereference the
  // parsed value unchecked — red (TypeError on `null`).
  it("a receipt that parses to null, a number or an array is unreadable", async () => {
    for (const body of ["null", "7", "[]"]) {
      const { ssh } = runner([body]);
      expect(await sender(ssh).send({ command: "archive-run" })).toEqual({
        ok: false,
        reason: "unreadable daemon result",
      });
    }
  });

  it("restore: the payload names the PR; outcomes render; an unsealed dir and a refusal are failures", async () => {
    expect(JSON.parse(archiveOpPayload({ command: "archive-restore", pr: 12 }))).toEqual({
      command: "archive-restore",
      pr: 12,
    });
    expect(() => archiveOpPayload({ command: "archive-restore", pr: 0 })).toThrow(/pr/);
    const ok = runner([
      JSON.stringify({
        ok: true,
        issuer: "operator",
        done: true,
        outcome: "restored",
        restored: 4,
        present: 1,
        live_differs: [],
      }),
    ]);
    const cmd = { command: "archive-restore", pr: 12 } as const;
    const out = await sender(ok.ssh).send(cmd);
    expect(renderArchiveOp(cmd, out)).toEqual([
      "✓ pr-12 restored — 4 file(s) back, 1 already present",
    ]);
    const unsealed = runner([
      JSON.stringify({
        ok: false,
        issuer: "session",
        reason: "command 'archive-restore' is the OPERATOR's alone",
      }),
    ]);
    const refused = await sender(unsealed.ssh).send(cmd);
    expect(refused).toMatchObject({ ok: false, issuer: "session" });
    expect(renderArchiveOp(cmd, refused).join("\n")).toContain("UNSEALED");
    const running = runner([
      JSON.stringify({
        ok: true,
        issuer: "operator",
        done: false,
        outcome: "restoring",
        note: "still running after 60 s",
      }),
    ]);
    expect(renderArchiveOp(cmd, await sender(running.ssh).send(cmd))).toEqual([
      "… still running after 60 s",
    ]);
  });

  it("waits the daemon's own bound plus the message timeout — never less", async () => {
    expect(archiveOpTimeoutMs(tui)).toBe(OPERATOR_WAIT_MS + 30_000);
    let t = Date.parse("2026-10-21T12:00:00Z");
    const { ssh, calls } = runner([]);
    const s = new ArchiveOpSender(
      tui,
      ssh,
      () => new Date(t),
      async (ms) => {
        t += ms;
      },
    );
    const out = await s.send({ command: "archive-run" });
    expect(out).toMatchObject({
      ok: false,
      reason: expect.stringContaining("no result before timeout"),
    });
    // One write, then one probe every 2 s for the whole bound.
    expect(calls.length - 1).toBe(Math.ceil(archiveOpTimeoutMs(tui) / 2000));
  });

  it("a figure the daemon's answer cannot carry whole is UNKNOWN, never rendered as a guess", () => {
    const lines = renderArchiveOp(
      { command: "archive-run" },
      {
        ok: true,
        result: { ok: true, done: true, mode: "on", state: "idle", files: { outcome: 3 } },
      },
    );
    expect(lines.join("\n")).toContain("could not be read whole");
    // No control byte from the result reaches the terminal.
    const evil = renderArchiveOp(
      { command: "archive-run" },
      {
        ok: true,
        result: {
          ok: true,
          done: true,
          mode: "on\u001b[2J",
          state: "held",
          held_reason: "x\u0007",
        },
      },
    );
    for (const l of evil) expect(l).not.toMatch(/[\u0000-\u001f\u007f-\u009f]/);
    expect(evil[0]).toContain("HELD");
  });
});

describe("wire.ts connects both verbs to the archiver", () => {
  it("archiveRun → operatorRun, archiveRestore → operatorRestore, read at call time", () => {
    const wire = readFileSync(join(import.meta.dirname, "..", "src", "wire.ts"), "utf8");
    expect(wire).toMatch(
      /archiveRun\(\) \{\s*if \(!archiver\)\s*return \{[^}]*\};\s*return archiver\.operatorRun\(\);/,
    );
    expect(wire).toMatch(
      /archiveRestore\(pr\) \{\s*if \(!archiver\)\s*return \{[^}]*\};\s*return archiver\.operatorRestore\(pr\);/,
    );
    // pi-global is wired; the overseer is deleted, so no birth record is.
    expect(wire).not.toMatch(/overseerBornAt/);
    expect(wire).toMatch(/piGlobalDir: piGlobalSessionsDir\(\),/);
  });
});

describe("the docs (acceptance 7)", () => {
  const repo = join(import.meta.dirname, "..");
  it("docs/archiving.md is the spec, with S4's build notes; the module map and the runbook name the archive", () => {
    const spec = readFileSync(join(repo, "docs", "archiving.md"), "utf8");
    expect(spec).toMatch(/^# Archiving: prune the live tree, keep everything on disk/);
    expect(spec).toContain("## Build notes");
    expect(spec).toMatch(
      /^S4 \(operator verbs, the overseer and pi-global stores, the other readers\)/m,
    );
    const claude = readFileSync(join(repo, "docs", "rulebook", "architecture.md"), "utf8");
    const entry = claude.slice(claude.indexOf("- `archive/` — the closed-PR ARCHIVER"));
    expect(entry.length).toBeGreaterThan(0);
    for (const mod of [
      "storepass.ts",
      "overseer.ts",
      "piglobal.ts",
      "extract.ts",
      "tui/archiveops.ts",
    ])
      expect(entry.slice(0, entry.indexOf("\n- `tui/`")), mod).toContain(mod);
    const runbook = readFileSync(join(repo, ".claude", "skills", "runbook", "SKILL.md"), "utf8");
    expect(runbook).toContain("### Reading the archive offline");
    expect(runbook).toContain("archive extract <pr> --to");
  });
});
