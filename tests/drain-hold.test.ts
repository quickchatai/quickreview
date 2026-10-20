// The operator's no-auto-lift drain HOLD.
//
// At the cutover the drain must hold until the owner has triggered and checked
// one worker round. A plain operator drain is lifted by the new boot's first
// healthy reconcile pass; the HOLD is not — only an explicit operator
// `qcr drain off` lifts it.
//
//   * Only the operator sets one. Who is asking is decided by the CHANNEL (the
//     root-sealed `commands/operator/`), never by the `hold` field: a session's
//     ask — including a file in an unsealed operator directory — is refused,
//     and nothing drains.
//   * It is persisted like the drain, so it survives the restart the cutover
//     performs: drain on --hold, restart, first healthy reconcile → still
//     draining (`drain_hold_kept`); drain off lifts it.
//   * The boot that adds the column carries a standing operator drain over as a
//     hold: the cutover's drain is set on the legacy daemon, which cannot spell
//     a hold, and the release's first boot is that boot.
//   * Visible in status.json (`draining_hold`), `qcr status` and the board's
//     drain bar; an older daemon's snapshot without the marker reads unknown.
import Database from "better-sqlite3";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { drainManualCommand, drainPayload, renderStatus, runDrain } from "../src/cli.js";
import {
  CommandWatcher,
  executeCommand,
  processOperatorSeal,
  validateCommand,
  type CommandDeps,
  type OperatorSeal,
} from "../src/commands.js";
import { loadConfig, type Config } from "../src/config.js";
import { createDaemon, type DaemonAdapter } from "../src/daemon.js";
import type { GateResult } from "../src/gate.js";
import type { PrRef } from "../src/github.js";
import { drainLever, mergeHold, minutesFromNow, type LeverDeps } from "../src/levers.js";
import { buildStatusSnapshot, StateStore } from "../src/state.js";
import { drainHoldLabel, topBar, type BoardView } from "../src/tui/board.js";
import { stripAnsi } from "../src/tui/paint.js";
import type { RemoteResult } from "../src/tui/remote.js";
import { HEAVY_TIMEOUT_MS } from "./helpers/suite-timeouts.js";

const cfg: Config = loadConfig(resolve(process.cwd(), "tests/fixtures/config.toml"));
const T0 = new Date("2026-10-20T10:00:00.000Z");
const HOLD = { issuer: "operator", expires_at: null, hold: true } as const;
const OPERATOR = { issuer: "operator", expires_at: null } as const;

function eventsOf(store: StateStore, kind: string): Array<Record<string, unknown>> {
  return (
    store.db.prepare("SELECT payload FROM events WHERE kind = ? ORDER BY id").all(kind) as Array<{
      payload: string;
    }>
  ).map((e) => JSON.parse(e.payload) as Record<string, unknown>);
}

function deps(store: StateStore): LeverDeps {
  return { store, levers: cfg.levers, timezone: cfg.ops.timezone, now: () => T0 };
}

function bootAdapter(): DaemonAdapter {
  const pr = {
    number: 101,
    title: "test PR",
    author: "someone",
    head_sha: "headsha1",
    base_ref: "master",
    updated_at: "2026-08-25T00:00:00Z",
    state: "open",
    draft: false,
    merged: false,
    labels: [],
  } as unknown as PrRef;
  const gate = async (): Promise<GateResult> => ({ executed: false });
  return {
    searchLabelTriggered: async () => [],
    searchTeamTriggered: async () => [],
    listOpenPrs: async () => [pr],
    getPr: async () => pr,
    stalenessScan: async () => [],
    listBotReviewComments: async () => [],
    getRequestedReviewers: async () => ({ users: [], teams: [] }),
    listPrFiles: async () => [],
    addLabel: gate,
    removeLabel: gate,
    deleteTeamReviewRequest: gate,
    createReview: gate,
  } as unknown as DaemonAdapter;
}

// ---- the pure precedence ----------------------------------------------------

describe("mergeHold with the operator's hold", () => {
  it("engages as a hold; a hold upgrades a plain operator drain and a session's", () => {
    expect(mergeHold(null, HOLD)).toEqual({
      hold: { issuer: "operator", expires_at: null, hold: true },
      outcome: "engaged",
    });
    expect(mergeHold({ issuer: "operator", expires_at: "2026-10-20T11:00:00Z" }, HOLD)).toEqual({
      hold: { issuer: "operator", expires_at: null, hold: true },
      outcome: "upgraded",
    });
    expect(mergeHold({ issuer: "session", expires_at: "2026-10-20T11:00:00Z" }, HOLD)).toEqual({
      hold: { issuer: "operator", expires_at: null, hold: true },
      outcome: "upgraded",
    });
  });

  it("nothing narrows a hold: a plain operator drain, a bounded one and a session's leave it as it stands", () => {
    const held = { issuer: "operator", expires_at: null, hold: true } as const;
    for (const grant of [
      OPERATOR,
      { issuer: "operator", expires_at: "2026-10-20T11:00:00Z" } as const,
      { issuer: "session", expires_at: "2026-10-20T11:00:00Z" } as const,
      HOLD,
    ])
      expect(mergeHold(held, grant)).toEqual({ hold: held, outcome: "unchanged" });
  });

  it("a plain grant never carries a hold", () => {
    expect(mergeHold(null, OPERATOR).hold).toEqual({ issuer: "operator", expires_at: null });
  });
});

// ---- the lever: only the operator holds -------------------------------------

describe("drainLever with hold", () => {
  let store: StateStore;
  beforeEach(() => {
    store = new StateStore(":memory:", () => T0);
  });
  afterEach(() => store.close());

  it("the operator's hold engages with no expiry, is reported as a hold, and a session cannot lift it", async () => {
    expect(
      await drainLever(deps(store), true, "operator", undefined, async () => {}, true),
    ).toMatchObject({
      ok: true,
      draining: true,
      issuer: "operator",
      expires_at: null,
      hold: true,
      outcome: "engaged",
    });
    expect(store.drainState()).toMatchObject({ draining: true, hold: true, issued_by: "operator" });
    expect(eventsOf(store, "drain_on")).toEqual([
      { by: "operator", outcome: "engaged", expires_at: null, hold: true },
    ]);
    const refused = await drainLever(deps(store), false, "session", undefined, async () => {});
    expect(refused).toMatchObject({
      ok: false,
      reason: expect.stringContaining("HELD by the operator"),
    });
    expect(store.drainState()).toMatchObject({ draining: true, hold: true });
    expect(
      await drainLever(deps(store), false, "operator", undefined, async () => {}),
    ).toMatchObject({
      ok: true,
      draining: false,
    });
    expect(store.drainState().draining).toBe(false);
  });

  it("a SESSION's ask for a hold is refused outright — nothing drains, nothing is charged", async () => {
    // MUTATION: drop the issuer check in grantFor's hold branch — this fails.
    const res = await drainLever(deps(store), true, "session", undefined, async () => {}, true);
    expect(res).toMatchObject({ ok: false, reason: expect.stringContaining("operator's alone") });
    expect(store.drainState().draining).toBe(false);
    expect(store.leverMinutesUsed("drain", "2026-10-20", null)).toBe(0);
  });

  it("an operator's hold with an expiry is refused (a hold never lapses)", async () => {
    const res = await drainLever(deps(store), true, "operator", 30, async () => {}, true);
    expect(res).toMatchObject({ ok: false, reason: expect.stringContaining("no expiry") });
    expect(store.drainState().draining).toBe(false);
  });

  it("a plain drain on over a hold keeps the hold; a hold over a plain drain makes it one, keeping its drop window", async () => {
    await drainLever(deps(store), true, "operator", undefined, async () => {}, true);
    expect(
      await drainLever(deps(store), true, "operator", undefined, async () => {}),
    ).toMatchObject({ ok: true, outcome: "unchanged", hold: true });
    await drainLever(deps(store), false, "operator", undefined, async () => {});

    await drainLever(deps(store), true, "operator", undefined, async () => {});
    store.countDrainedDelivery();
    expect(store.drainState()).toMatchObject({ draining: true, hold: false });
    expect(
      await drainLever(deps(store), true, "operator", undefined, async () => {}, true),
    ).toMatchObject({ ok: true, outcome: "upgraded", hold: true });
    expect(store.drainState()).toMatchObject({ draining: true, hold: true, drained_deliveries: 1 });
  });

  it("a session's own drain is upgraded to the operator's hold", async () => {
    await drainLever(deps(store), true, "session", 10, async () => {});
    expect(
      await drainLever(deps(store), true, "operator", undefined, async () => {}, true),
    ).toMatchObject({
      ok: true,
      outcome: "upgraded",
      issuer: "operator",
      expires_at: null,
      hold: true,
    });
  });
});

// ---- the command schema and the channel ------------------------------------

describe("the drain command's hold field", () => {
  it("is accepted with on = true only, as a boolean, never beside for_min", () => {
    expect(validateCommand({ command: "drain", on: true, hold: true })).toEqual({
      ok: true,
      command: { command: "drain", on: true, hold: true },
    });
    // A false hold is a plain drain, spelled as before.
    expect(validateCommand({ command: "drain", on: true, hold: false })).toEqual({
      ok: true,
      command: { command: "drain", on: true },
    });
    expect(validateCommand({ command: "drain", on: false, hold: true }).ok).toBe(false);
    expect(validateCommand({ command: "drain", on: true, hold: "yes" }).ok).toBe(false);
    expect(validateCommand({ command: "drain", on: true, hold: true, for_min: 5 }).ok).toBe(false);
  });

  it("executeCommand hands the hold to the drain dep with the context's issuer", async () => {
    const calls: unknown[][] = [];
    const d = { drain: (...a: unknown[]) => void calls.push(a) } as unknown as CommandDeps;
    await executeCommand({ command: "drain", on: true, hold: true }, d, {
      file: "f",
      issuer: "operator",
    });
    await executeCommand({ command: "drain", on: true, hold: true }, d);
    await executeCommand({ command: "drain", on: true }, d, { file: "f", issuer: "operator" });
    expect(calls).toEqual([
      [true, "operator", undefined, undefined, true],
      [true, "session", undefined, undefined, true],
      [true, "operator", undefined],
    ]);
  });
});

describe("a hold through commands/operator/", () => {
  let root: string;
  let store: StateStore;
  const sealed: OperatorSeal = {
    euid: 1001,
    gids: [1001],
    stat: (p) =>
      p.endsWith(".json")
        ? { uid: 0, gid: 0, mode: 0o644, kind: "file" }
        : { uid: 0, gid: 0, mode: 0o755, kind: "dir" },
  };
  const opDir = () => join(root, "commands", "operator");
  const result = (name: string) =>
    JSON.parse(
      readFileSync(join(root, "commands", "results", `${name}.result.json`), "utf8"),
    ) as Record<string, unknown>;
  const leverDeps = (): CommandDeps =>
    ({
      drain: (
        on: boolean,
        issuer: "operator" | "session",
        forMin: number | undefined,
        deliveryKey?: string,
        hold?: boolean,
      ) =>
        drainLever(
          { ...deps(store), deliveryKey },
          on,
          issuer,
          forMin,
          async () => {},
          hold === true,
        ),
    }) as unknown as CommandDeps;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "qcr-drainhold-"));
    mkdirSync(opDir(), { recursive: true });
    store = new StateStore(":memory:", () => T0);
  });
  afterEach(() => {
    store.close();
    rmSync(root, { recursive: true, force: true });
  });

  it("SEALED: the operator's hold engages", async () => {
    writeFileSync(
      join(opDir(), "h1.json"),
      JSON.stringify({ command: "drain", on: true, hold: true }),
    );
    const w = new CommandWatcher({
      dir: opDir(),
      operator: sealed,
      deps: leverDeps(),
      store,
      sweepIntervalMs: 0,
    });
    await w.sweep();
    w.stop();
    expect(result("h1")).toMatchObject({ ok: true, issuer: "operator", hold: true });
    expect(store.drainState()).toMatchObject({ draining: true, hold: true });
  });

  it("UNSEALED: served as a session's, so the hold is refused and nothing drains", async () => {
    writeFileSync(
      join(opDir(), "h2.json"),
      JSON.stringify({ command: "drain", on: true, hold: true }),
    );
    const w = new CommandWatcher({
      dir: opDir(),
      operator: processOperatorSeal(),
      deps: leverDeps(),
      store,
      sweepIntervalMs: 0,
      log: () => {},
    });
    await w.sweep();
    w.stop();
    expect(result("h2")).toMatchObject({
      ok: false,
      reason: expect.stringContaining("operator's alone"),
    });
    expect(store.drainState().draining).toBe(false);
    expect(eventsOf(store, "operator_channel_unsealed")).toHaveLength(1);
  });
});

// ---- the restart the cutover performs ----------------------------------------

describe("the hold across a restart and the boot's first healthy reconcile", () => {
  let root: string;
  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "qcr-drainhold-boot-"));
    for (const d of ["state", "state/dryrun", "verdict", "inject"])
      mkdirSync(join(root, d), { recursive: true });
  });
  afterEach(() => rmSync(root, { recursive: true, force: true }));

  async function boot(store: StateStore): Promise<void> {
    const daemon = createDaemon({
      cfg: { ...cfg, dry_run: true },
      root,
      store,
      adapter: bootAdapter(),
      listen: false,
      log: () => {},
    });
    await daemon.start();
    await daemon.stop();
  }

  it(
    "drain on --hold, restart, first healthy reconcile: still draining (drain_hold_kept); drain off lifts it",
    { timeout: HEAVY_TIMEOUT_MS },
    async () => {
      const dbPath = join(root, "state", "state.db");
      const before = new StateStore(dbPath);
      expect(
        await drainLever(deps(before), true, "operator", undefined, async () => {}, true),
      ).toMatchObject({
        ok: true,
        hold: true,
      });
      before.countDrainedDelivery();
      before.close();

      const after = new StateStore(dbPath);
      try {
        await boot(after);
        // MUTATION: drop the hold branch in daemon.ts reconcilePass — these fail.
        expect(after.drainState()).toMatchObject({
          draining: true,
          hold: true,
          issued_by: "operator",
        });
        expect(eventsOf(after, "drain_lifted")).toEqual([]);
        expect(eventsOf(after, "drain_hold_kept")).toEqual([{ dropped_deliveries: 1 }]);
        // A plain operator drain over the same restart is lifted, as before.
        expect(
          await drainLever(deps(after), false, "operator", undefined, async () => {}),
        ).toMatchObject({
          ok: true,
          draining: false,
        });
        expect(after.drainState().draining).toBe(false);
        expect(eventsOf(after, "drain_off")).toEqual([{ by: "operator", dropped_deliveries: 1 }]);
      } finally {
        after.close();
      }
    },
  );

  it("a plain operator drain is still lifted by the same boot", async () => {
    const store = new StateStore(":memory:");
    try {
      store.engageDrain(OPERATOR);
      await boot(store);
      expect(store.drainState().draining).toBe(false);
      expect(eventsOf(store, "drain_lifted")).toHaveLength(1);
      expect(eventsOf(store, "drain_hold_kept")).toEqual([]);
    } finally {
      store.close();
    }
  });
});

// ---- the carry: the cutover's drain was set by a daemon without holds --------

describe("the boot that adds the hold column carries a standing operator drain over as a hold", () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "qcr-drainhold-carry-"));
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  /** A state.db as a daemon without holds left it: the drain row as given,
   * and no `hold` column. */
  function legacyDb(engage: (s: StateStore) => void): string {
    const path = join(dir, "state.db");
    const s = new StateStore(path);
    engage(s);
    s.close();
    const raw = new Database(path);
    raw.exec("ALTER TABLE drain_state DROP COLUMN hold");
    raw.close();
    return path;
  }

  it("an operator drain with no expiry becomes a hold, once, and survives the boot", async () => {
    const path = legacyDb((s) => s.engageDrain(OPERATOR));
    const store = new StateStore(path);
    try {
      expect(store.drainState()).toMatchObject({
        draining: true,
        issued_by: "operator",
        hold: true,
      });
      expect(eventsOf(store, "drain_hold_carried")).toHaveLength(1);
      // Lifted, then re-opened: the column is there now, nothing is carried again.
      store.liftDrain("operator");
      store.engageDrain(OPERATOR);
    } finally {
      store.close();
    }
    const again = new StateStore(path);
    try {
      expect(again.drainState()).toMatchObject({ draining: true, hold: false });
      expect(eventsOf(again, "drain_hold_carried")).toHaveLength(1);
    } finally {
      again.close();
    }
  });

  it("a session's bounded drain, an operator's bounded drain and a system's drain are not carried", () => {
    for (const engage of [
      (s: StateStore) =>
        s.engageDrain({ issuer: "session", expires_at: minutesFromNow(new Date(), 30) }),
      (s: StateStore) =>
        s.engageDrain({ issuer: "operator", expires_at: minutesFromNow(new Date(), 30) }),
      (s: StateStore) => s.engageDrain(OPERATOR, "worker_failures"),
    ]) {
      const path = legacyDb(engage);
      const store = new StateStore(path);
      try {
        expect(store.drainState()).toMatchObject({ draining: true, hold: false });
        expect(eventsOf(store, "drain_hold_carried")).toEqual([]);
      } finally {
        store.close();
        rmSync(path, { force: true });
      }
    }
  });

  it("nothing draining, nothing carried", () => {
    const path = legacyDb(() => {});
    const store = new StateStore(path);
    try {
      expect(store.drainState().draining).toBe(false);
      expect(eventsOf(store, "drain_hold_carried")).toEqual([]);
    } finally {
      store.close();
    }
  });
});

// ---- visibility -------------------------------------------------------------

describe("the hold is visible", () => {
  const base = {
    written_at: "x",
    dry_run: false,
    running_rounds: 0,
    total_spend_usd: 0,
    heartbeat: "x",
  } as const;

  it("status.json writes draining_hold on every draining snapshot, true or false", () => {
    const store = new StateStore(":memory:");
    try {
      expect(buildStatusSnapshot(store, false)).not.toHaveProperty("draining_hold");
      store.engageDrain(OPERATOR);
      expect(buildStatusSnapshot(store, false)).toMatchObject({
        draining: true,
        draining_by: "operator",
        draining_hold: false,
      });
      store.engageDrain(HOLD);
      expect(buildStatusSnapshot(store, false)).toMatchObject({
        draining: true,
        draining_by: "operator",
        draining_hold: true,
      });
    } finally {
      store.close();
    }
  });

  it("qcr status names the hold, and an older daemon's missing marker as unknown", () => {
    const held = renderStatus({
      ...base,
      prs: [],
      draining: true,
      draining_by: "operator",
      draining_hold: true,
    });
    expect(held).toContain("HELD by the operator (hold: no boot lifts it)");
    expect(held).toContain("only qcr drain off lifts it");
    const plain = renderStatus({
      ...base,
      prs: [],
      draining: true,
      draining_by: "operator",
      draining_hold: false,
    });
    expect(plain).toContain("held by the operator until lifted");
    expect(plain).toContain("auto-lifts on the next boot's first healthy reconcile");
    const old = renderStatus({ ...base, prs: [], draining: true, draining_by: "operator" });
    expect(old).toContain("hold not reported (older daemon)");
  });

  it("the board's drain bar says HOLD, says 'hold ?' for an older daemon, and nothing for a session", () => {
    expect(drainHoldLabel({ draining_by: "operator", draining_hold: true })).toContain("HOLD");
    expect(drainHoldLabel({ draining_by: "operator", draining_hold: false })).toBe("");
    expect(drainHoldLabel({ draining_by: "operator" })).toBe(" · hold ?");
    expect(drainHoldLabel({ draining_by: "session" })).toBe("");
    const view: BoardView = {
      health: { kind: "ok", heartbeatAgeS: 5 },
      dryRun: false,
      snapshot: { ...base, prs: [], draining: true, draining_by: "operator", draining_hold: true },
      events: [],
      selected: 0,
      eventsFocus: false,
      eventsScroll: 0,
      help: false,
    };
    expect(stripAnsi(topBar(view, 220))).toContain(
      "held by the operator until lifted · HOLD: no boot lifts it, drain off does",
    );
  });
});

// ---- qcr drain on --hold -----------------------------------------------------

describe("qcr drain on --hold", () => {
  const ok = (stdout = ""): RemoteResult => ({ ok: true, stdout, stderr: "", code: 0 });

  it("sends the hold, and says no boot lifts it when the daemon confirms", async () => {
    const stdins: string[] = [];
    const lines: string[] = [];
    const ssh = async (
      _h: string,
      _a: string[],
      opts?: { stdin?: string },
    ): Promise<RemoteResult> => {
      if (opts?.stdin !== undefined) {
        stdins.push(opts.stdin);
        return ok();
      }
      return ok(
        JSON.stringify({
          ok: true,
          draining: true,
          running_rounds: 0,
          issuer: "operator",
          hold: true,
        }),
      );
    };
    expect(
      await runDrain(true, { cfg, ssh, log: (l) => lines.push(l), sleep: async () => {} }, true),
    ).toBe(0);
    expect(JSON.parse(stdins[0]!)).toEqual({ command: "drain", on: true, hold: true });
    expect(lines.join("\n")).toContain("HOLD: no boot lifts it");
  });

  it("fails when the daemon took a drain but did not confirm the hold", async () => {
    const lines: string[] = [];
    const ssh = async (
      _h: string,
      _a: string[],
      opts?: { stdin?: string },
    ): Promise<RemoteResult> =>
      opts?.stdin !== undefined
        ? ok()
        : ok(JSON.stringify({ ok: true, draining: true, running_rounds: 0, issuer: "operator" }));
    expect(
      await runDrain(true, { cfg, ssh, log: (l) => lines.push(l), sleep: async () => {} }, true),
    ).toBe(1);
    expect(lines.join("\n")).toContain("did not confirm the HOLD");
  });

  it("a plain payload is byte-identical to before; the hold payload validates; the fallback carries it", () => {
    expect(drainPayload(true)).toBe(`${JSON.stringify({ command: "drain", on: true }, null, 2)}\n`);
    expect(JSON.parse(drainPayload(false, true))).toEqual({ command: "drain", on: false });
    expect(validateCommand(JSON.parse(drainPayload(true, true)))).toMatchObject({
      ok: true,
      command: { hold: true },
    });
    expect(drainManualCommand(cfg.tui, true, T0, true)).toContain(
      '{"command":"drain","on":true,"hold":true}',
    );
  });
});

describe("the ratified levers text", () => {
  const claude = readFileSync(resolve(__dirname, "..", "CLAUDE.md"), "utf8").replace(/\s+/g, " ");

  it("CLAUDE.md carries the drain hold word for word, as ratified", () => {
    for (const ratified of [
      "[private rule text removed]",
      "[private rule text removed]",
      "The boot that adds the hold to state.db carries a standing operator drain over as one (`drain_hold_carried`); that is how the legacy daemon's cutover drain holds.",
      "[private rule text removed]",
      "[private rule text removed]",
    ])
      expect(claude).toContain(ratified);
    expect(claude).not.toContain("lifts whatever stands");
  });
});
