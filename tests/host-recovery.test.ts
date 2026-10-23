// [P8.6] The verdict processor and the command supervisor, driven by each host.
//
// verdicts.test.ts and session-command-supervisor.test.ts stand in for the host
// with hand-made hooks. What they cannot show is that the REAL hooks of each host
// give the daemon's recovery what it asks of them. These cases run the real
// VerdictWatcher and SessionCommandSupervisor over every host in SESSION_HOSTS
// (the contract's own rigs, tests/helpers/session-hooks-host.ts):
//
//   round end        the wake held during the round reaches the session
//   silent round     an order lost in transit is redelivered by the net, cheaply
//                    (no kill), once the grace has passed and it is seen twice
//   missing start    a worker's ack is the receipt: no start by the lease is
//                    recovered at once
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { parseConfig, type Config } from "../src/config.js";
import type { GateResult } from "@quickchatai/pi-quickreview/src/gate.js";
import { SessionCommandSupervisor } from "../src/session-command-supervisor.js";
import {
  roundPromptMarker,
  type RoundOrder,
  type VerdictFile,
} from "@quickchatai/pi-quickreview/src/types.js";
import { VerdictWatcher, type VerdictAdapter } from "../src/verdicts.js";
import {
  HOST_NOW,
  SESSION_HOSTS,
  trackPr,
  type SessionHooksRig,
} from "./helpers/session-hooks-host.js";
import { HEAVY_TIMEOUT_MS } from "./helpers/suite-timeouts.js";

const cfg: Config = parseConfig(
  readFileSync(resolve(process.cwd(), "tests/fixtures/config.toml"), "utf8"),
);

const PR = 42;
const SESSION = `pr-${PR}`;
const BODY = "ROUND PROMPT BODY";
const STAMPED = `${BODY}\n\n${roundPromptMarker(PR, 1)}\n`;

const order: RoundOrder = {
  pr: PR,
  title: "Add rate limiting",
  round_id: 1,
  round_no: 1,
  round_type: "first",
  lenses: ["pass-baseline"],
  pass_plan: [{ lens: "pass-baseline", agent: "pass-baseline", tier: "sol-med", raisable_to: [] }],
  addable_lenses: [],
  base_ref: "master",
  base_sha: "base123",
  merge_base: "base123",
  migration_gate: false,
  head_sha: "abc123",
  worktree: "wt/pr-42",
  settled_digest: "",
  issued_at: "2026-08-13T10:00:00Z",
};

/** Recording stand-in for GitHubAdapter + MutationGate: nothing here touches GitHub. */
const adapter: VerdictAdapter = {
  async addLabel(): Promise<GateResult> {
    return { executed: false, dryRunFile: "d" };
  },
  async removeLabel(): Promise<GateResult> {
    return { executed: false, dryRunFile: "d" };
  },
};

describe.each(SESSION_HOSTS)("recovery over the $name host", (host) => {
  let rig: SessionHooksRig;
  let dir: string;
  beforeEach(() => {
    rig = host.open();
    dir = mkdtempSync(join(tmpdir(), "qcr-host-recovery-"));
    mkdirSync(join(dir, "verdict"), { recursive: true });
  });
  afterEach(() => {
    rig.dispose();
    rmSync(dir, { recursive: true, force: true });
  });

  const watcher = (now?: Date): VerdictWatcher =>
    new VerdictWatcher({
      cfg,
      store: rig.store,
      adapter,
      hooks: rig.hooks,
      verdictDir: join(dir, "verdict"),
      root: dir,
      usage: {},
      partialWrite: { windowMs: 0 },
      ...(now ? { now: () => now } : {}),
    });

  /** The PR reviewing, its round running and its order handed to the host. */
  async function dispatched(): Promise<number> {
    trackPr(rig.store, PR);
    const roundId = rig.store.startRound(
      PR,
      "first",
      ["pass-baseline"],
      cfg.daemon.round_deadline_min,
    );
    await rig.hooks.dispatchRound(order, BODY);
    rig.store.stampPromptMarker(roundId, roundPromptMarker(PR, 1));
    return roundId;
  }

  describe("round end", () => {
    it(
      "flushes the wake held during the round into the session once the verdict is applied",
      { timeout: HEAVY_TIMEOUT_MS },
      async () => {
        trackPr(rig.store, PR);
        const roundId = rig.store.startRound(PR, "first", ["pass-baseline"], 75);
        rig.store.db.prepare("UPDATE pr_state SET state = 'reviewing' WHERE number = ?").run(PR);
        await rig.seedIdleSession(SESSION);
        // A fresh ledger keeps the post-round ledger re-nudge out of this case.
        mkdirSync(join(dir, "state", "ledgers"), { recursive: true });
        writeFileSync(join(dir, "state", "ledgers", `${SESSION}.md`), "LEDGER PR #42 @ abc123\n");
        rig.store.holdWake(PR, "author says: fixed in abc123", "author_reply");
        const verdict = {
          pr: PR,
          round_no: 1,
          verdict: "APPROVE",
          head_sha: "abc123",
          finished_at: "2026-08-13T12:00:00Z",
        } as VerdictFile;
        writeFileSync(join(dir, "verdict", `${SESSION}-round-1.json`), JSON.stringify(verdict));

        await watcher().sweep();

        expect(
          (
            rig.store.db.prepare("SELECT status FROM rounds WHERE id = ?").get(roundId) as {
              status: string;
            }
          ).status,
        ).toBe("done");
        expect(rig.mailbox(SESSION)).toEqual(["author says: fixed in abc123\n"]);
        expect(rig.store.heldWakes(PR)).toEqual([]);
      },
    );
  });

  describe("the silent-round net", () => {
    it(
      "redelivers an order lost in transit, without a kill, on the second sighting after the grace",
      { timeout: HEAVY_TIMEOUT_MS },
      async () => {
        await dispatched();
        await rig.loseDeliveredOrder(PR);
        const births = () => rig.lifecycle().filter((e) => e.startsWith("birth")).length;
        const bornBefore = births();
        const later = new Date(
          HOST_NOW.getTime() + ((cfg.daemon.round_stall_grace_min ?? 10) + 1) * 60_000,
        );

        // First sighting marks the round; nothing is touched yet.
        await watcher(later).checkDeadlines();
        expect(rig.store.runningRounds()[0]?.silent_since).toBeTruthy();
        expect(rig.mailbox(SESSION)).toEqual([]);

        // The second acts: the same order again, the same round, no session killed.
        await watcher(later).checkDeadlines();

        expect(
          rig.store.db
            .prepare("SELECT COUNT(*) AS c FROM events WHERE kind = 'round_prompt_lost'")
            .get(),
        ).toEqual({ c: 1 });
        expect(rig.mailbox(SESSION)).toEqual([STAMPED]);
        expect(rig.lifecycle().some((e) => e.startsWith("kill"))).toBe(false);
        // A worker is a fresh process.
        expect(births()).toBe(bornBefore + 1);
        expect(rig.store.runningRounds()).toHaveLength(1);
      },
    );

    it(
      "is patient with an order still on its way: nothing is marked while its ack is pending",
      { timeout: HEAVY_TIMEOUT_MS },
      async () => {
        await dispatched();
        const later = new Date(HOST_NOW.getTime() + 20 * 60_000);

        await watcher(later).checkDeadlines();
        await watcher(later).checkDeadlines();

        expect(rig.store.runningRounds()[0]?.silent_since ?? null).toBeNull();
        expect(
          rig.store.db
            .prepare("SELECT COUNT(*) AS c FROM events WHERE kind = 'round_prompt_lost'")
            .get(),
        ).toEqual({ c: 0 });
        expect(rig.mailbox(SESSION)).toEqual([STAMPED]);
      },
    );
  });

  describe("a command that never started", () => {
    const supervisor = (): SessionCommandSupervisor =>
      new SessionCommandSupervisor({
        cfg,
        store: rig.store,
        hooks: rig.hooks,
        verdictDir: join(dir, "verdict"),
        onRoundFailure: async () => "requeued",
      });
    const events = (kind: string): number =>
      (
        rig.store.db.prepare("SELECT COUNT(*) AS c FROM events WHERE kind = ?").get(kind) as {
          c: number;
        }
      ).c;

    it("recovers at once on a worker's definitive ack", { timeout: HEAVY_TIMEOUT_MS }, async () => {
      await dispatched();
      const row = rig.store.activeSessionCommand(SESSION)!;
      rig.store.db
        .prepare("UPDATE session_commands SET next_check_at = ? WHERE id = ?")
        .run("2026-08-13T09:00:00.000Z", row.id);

      await supervisor().scan();

      // No transcript to fail to read: the ack is absent, so the worker is fenced
      // and the same command is replayed under a fresh one.
      expect(events("session_command_evidence_unknown")).toBe(0);
      expect(events("session_command_start_recovery")).toBe(1);
      expect(rig.lifecycle()).toEqual([`birth ${SESSION}`, `kill ${SESSION}`, `birth ${SESSION}`]);
      expect(rig.store.getSessionCommand(row.id)).toMatchObject({
        id: row.id,
        attempt: row.attempt + 1,
        status: "running",
      });
    });

    it("leaves a started command alone", { timeout: HEAVY_TIMEOUT_MS }, async () => {
      await dispatched();
      const row = rig.store.activeSessionCommand(SESSION)!;
      rig.recordAccepted(PR, STAMPED);
      rig.store.db
        .prepare("UPDATE session_commands SET next_check_at = ? WHERE id = ?")
        .run("2026-08-13T09:00:00.000Z", row.id);

      await supervisor().scan();

      expect(events("session_command_start_recovery")).toBe(0);
      expect(rig.lifecycle().some((e) => e.startsWith("kill"))).toBe(false);
      expect(rig.store.getSessionCommand(row.id)?.id).toBe(row.id);
    });
  });
});
