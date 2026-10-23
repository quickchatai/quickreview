// The SessionHooks contract (packages/pi-plugin/src/types.ts), stated once and run against every
// host in tests/helpers/session-hooks-host.ts. The per-round worker host
// (`WorkerSessionHost`) is the only PR host; a worker IS its command, and
// its ack is the receipt. The worker's own recovery cases are in
// tests/worker-session-host.test.ts.
//
// Each group is the host-facing half of an existing suite, lifted so the
// daemon's expectations of a host are written down apart from how a host meets
// them. This file speaks only through the hooks and the rig's world verbs.
//
//   delivery            session-commands, receipt-aware-finalize
//   redelivery          session-commands, session-command-supervisor
//   fence               session-command-supervisor, operator-recovery
//   held wakes          held-wake-cap, pingpong, operator-recovery
//   close               session-commands, operator-recovery
//   orphan              wire-orphans
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { recoverPrForOperator } from "../src/operator-recovery.js";
import { reconcileOrphanedRounds } from "../src/reconcile.js";
import { AUTHOR_REPLY_WAKE_REASON } from "../src/state.js";
import {
  recheckPromptMarker,
  roundPromptMarker,
  stampPrompt,
  type RoundOrder,
} from "@quickchatai/pi-quickreview/src/types.js";
import { flushHeldWakes, wakeOrHold, type WakeDeps } from "../src/wakes.js";
import {
  HOST_NOW,
  SESSION_HOSTS,
  sha256,
  trackPr,
  type SessionHooksRig,
} from "./helpers/session-hooks-host.js";
import { HEAVY_TIMEOUT_MS } from "./helpers/suite-timeouts.js";

const PR = 42;
const SESSION = `pr-${PR}`;

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
const BODY = "ROUND PROMPT BODY";
const stampedBody = `${BODY}\n\n${roundPromptMarker(PR, order.round_no)}\n`;
const STARTED_MS = HOST_NOW.getTime();

describe.each(SESSION_HOSTS)("SessionHooks conformance: $name host", (host) => {
  let rig: SessionHooksRig;
  beforeEach(() => {
    rig = host.open();
  });
  afterEach(() => {
    rig.dispose();
  });

  /** A tracked PR with its round running and its prompt handed over. */
  async function dispatched(): Promise<void> {
    trackPr(rig.store, PR);
    rig.store.startRound(PR, "first", ["pass-baseline"], 75);
    await rig.hooks.dispatchRound(order, BODY);
  }

  const wakeDeps = (): WakeDeps => ({
    store: rig.store,
    inject: (pr, message) => rig.hooks.inject(pr, message),
  });

  describe("delivery", () => {
    it(
      "dispatchRound births the session and delivers the exact stamped prompt as one durable command",
      { timeout: HEAVY_TIMEOUT_MS },
      async () => {
        await dispatched();

        expect(rig.isRunning(SESSION)).toBe(true);
        expect(rig.mailbox(SESSION)).toEqual([stampedBody]);
        const row = rig.store.activeSessionCommand(SESSION)!;
        expect(row).toMatchObject({
          pr: PR,
          session: SESSION,
          kind: "round",
          round_no: 1,
          ...host.dispatchedRow,
        });
        // The row's evidence is the bytes the session was handed.
        expect(row.payload_sha256).toBe(sha256(stampedBody));
      },
    );

    it("never hands a session a round an operator cancelled while dispatch was in flight", async () => {
      trackPr(rig.store, PR);
      rig.store.startRound(PR, "first", ["pass-baseline"], 75);
      rig.store.cancelRunningRounds(PR, "restart-session");

      await expect(rig.hooks.dispatchRound(order, BODY)).rejects.toThrow(/cancelled/);

      expect(rig.mailbox(SESSION)).toEqual([]);
      expect(rig.store.blockingSessionCommand(SESSION)).toBeUndefined();
      expect(rig.store.sessionCommandForRound(PR, 1)).toBeUndefined();
    });

    it("holds one command in flight per session: a second wake is refused until the first settles", async () => {
      trackPr(rig.store, PR);
      await rig.seedIdleSession(SESSION);

      await rig.hooks.inject(PR, "author replied");
      await expect(rig.hooks.inject(PR, "second wake")).rejects.toThrow(
        /session command .* is (pending|running)/,
      );
      expect(rig.mailbox(SESSION)).toEqual(["author replied\n"]);

      await rig.settleDelivered(PR);
      await rig.hooks.inject(PR, "second wake");
      expect(rig.mailbox(SESSION)).toEqual(["second wake\n"]);
    });

    it("wakes an idle PR with the exact bytes", async () => {
      trackPr(rig.store, PR);
      await rig.seedIdleSession(SESSION);
      await rig.hooks.inject(PR, "zażółć 🧭 gęślą jaźń");
      expect(rig.mailbox(SESSION)).toEqual(["zażółć 🧭 gęślą jaźń\n"]);
    });

    it("rebirths a dead session for a wake the registry knows, and refuses a PR it does not", async () => {
      trackPr(rig.store, PR);
      expect(rig.isRunning(SESSION)).toBe(false);

      await rig.hooks.inject(PR, "recheck: head moved");
      expect(rig.isRunning(SESSION)).toBe(true);
      expect(rig.mailbox(SESSION)).toHaveLength(1);

      await expect(rig.hooks.inject(77, "wake")).rejects.toThrow(/no live session pr-77/);
      expect(rig.isRunning("pr-77")).toBe(false);
    });

    it("refuses a closed PR's wake even while its session is alive and ready", async () => {
      trackPr(rig.store, PR, "closed");
      await rig.seedIdleSession(SESSION);

      await expect(rig.hooks.inject(PR, "author reply")).rejects.toThrow(/PR #42 is closed/);

      expect(rig.mailbox(SESSION)).toEqual([]);
      expect(rig.store.activeSessionCommand(SESSION)).toBeUndefined();
    });

    describe("the receipt: present is delivered, absent is lost, unreadable is unknown", () => {
      it("reads a round's receipt out of the transcript", async () => {
        await dispatched();

        // Nothing written since the round started: no evidence either way.
        expect(await rig.hooks.roundPromptAccepted(PR, 1, STARTED_MS)).toBeNull();

        // The session wrote, but this round's order is not among what it took.
        rig.recordAccepted(PR, "wake up finish the review");
        expect(await rig.hooks.roundPromptAccepted(PR, 1, STARTED_MS)).toBeNull();

        // pi accepted it: the token comes back verbatim.
        rig.recordAccepted(PR, stampedBody);
        expect(await rig.hooks.roundPromptAccepted(PR, 1, STARTED_MS)).toBe(true);
        // Another round's token is not this round's receipt.
        expect(await rig.hooks.roundPromptAccepted(PR, 2, STARTED_MS)).toBe(false);
      });

      it("reads a wake's receipt by its marker, without a round row", async () => {
        trackPr(rig.store, PR);
        await rig.seedIdleSession(SESSION);
        const marker = recheckPromptMarker(PR, "fingerprint-1");
        const wake = stampPrompt("recheck: head moved", marker);
        await rig.hooks.inject(PR, wake);

        expect(await rig.hooks.wakeReceiptPresent(PR, marker, STARTED_MS)).toBeNull();
        rig.recordAccepted(PR, "something else entirely");
        expect(await rig.hooks.wakeReceiptPresent(PR, marker, STARTED_MS)).toBeNull();
        rig.recordAccepted(PR, wake);
        expect(await rig.hooks.wakeReceiptPresent(PR, marker, STARTED_MS)).toBe(true);
      });

      it("reports transcript activity as a time, and none as null", async () => {
        trackPr(rig.store, PR);
        expect(await rig.hooks.sessionActivityAt(PR)).toBeNull();
        rig.recordActivity(PR);
        expect(await rig.hooks.sessionActivityAt(PR)).toEqual(expect.any(Number));
      });
    });
  });

  describe("fence", () => {
    it("killSession returns only once the session is proven gone", async () => {
      trackPr(rig.store, PR);
      await rig.seedRunningSession(SESSION);
      expect(await rig.hooks.sessionAlive(PR)).toBe(true);

      await rig.hooks.killSession(PR);

      expect(rig.isRunning(SESSION)).toBe(false);
      expect(await rig.hooks.sessionAlive(PR)).toBe(false);
    });

    it("a session that is already absent needs no kill", async () => {
      await rig.hooks.killSession(PR);
      expect(rig.lifecycle()).toEqual([]);
    });

    it("a session that outlives the kill throws: no one dispatches beside a pi that may still run", async () => {
      await rig.seedRunningSession(SESSION);
      rig.wedgeSession(SESSION);
      await expect(rig.hooks.killSession(PR)).rejects.toThrow(/not proven gone after kill/);
      expect(await rig.hooks.sessionAlive(PR)).toBe(true);
    });

    it("an expected-owner kill fences only the command it names", async () => {
      await dispatched();
      const row = rig.store.activeSessionCommand(SESSION)!;
      const owner = {
        id: row.id,
        status: row.status,
        owner_token: row.owner_token,
        attempt: row.attempt,
        started_at: row.started_at,
      };

      // The row moved since the supervisor read it: nothing is killed.
      expect(await rig.hooks.killSession(PR, { ...owner, attempt: owner.attempt + 1 })).toBe(false);
      expect(rig.isRunning(SESSION)).toBe(true);

      expect(await rig.hooks.killSession(PR, owner)).toBe(true);
      expect(rig.isRunning(SESSION)).toBe(false);
    });

    it("an expected-owner kill declines when another command has taken the session's slot", async () => {
      await dispatched();
      const row = rig.store.activeSessionCommand(SESSION)!;
      const owner = {
        id: "cmd-terminal",
        status: "acked",
        owner_token: null,
        attempt: row.attempt,
        started_at: null,
      };
      expect(await rig.hooks.killSession(PR, owner)).toBe(false);
      expect(rig.isRunning(SESSION)).toBe(true);
    });

    it("reports a session as alive only on the host's affirmative answer", async () => {
      expect(await rig.hooks.sessionAlive(PR)).toBe(false);
      await rig.seedRunningSession(SESSION);
      expect(await rig.hooks.sessionAlive(PR)).toBe(true);
    });
  });

  describe("held wakes", () => {
    it("a wake raised while the PR's round runs is held, not delivered, and flushes at round end", async () => {
      trackPr(rig.store, PR);
      await rig.seedIdleSession(SESSION);
      rig.store.startRound(PR, "first", ["pass-baseline"], 75);

      expect(await wakeOrHold(wakeDeps(), PR, "author replied", "author_reply")).toBe("held");
      expect(rig.mailbox(SESSION)).toEqual([]);
      expect(rig.store.heldWakes(PR).map((w) => w.payload)).toEqual(["author replied"]);

      rig.store.cancelRunningRounds(PR, "round ended");
      expect(await flushHeldWakes(wakeDeps(), PR)).toBe(1);
      expect(rig.mailbox(SESSION)).toEqual(["author replied\n"]);
      expect(rig.store.heldWakes(PR)).toEqual([]);
    });

    it("wakes go out one at a time, oldest first, each behind its predecessor's settlement", async () => {
      trackPr(rig.store, PR);
      await rig.seedIdleSession(SESSION);
      rig.store.startRound(PR, "first", ["pass-baseline"], 75);
      await wakeOrHold(wakeDeps(), PR, "first wake", "recheck:push");
      await wakeOrHold(wakeDeps(), PR, "second wake", "recheck:ci");
      rig.store.cancelRunningRounds(PR, "round ended");

      expect(await flushHeldWakes(wakeDeps(), PR)).toBe(1);
      expect(rig.mailbox(SESSION)).toEqual(["first wake\n"]);
      expect(rig.store.heldWakes(PR).map((w) => w.payload)).toEqual(["second wake"]);

      await rig.settleDelivered(PR);
      expect(await flushHeldWakes(wakeDeps(), PR)).toBe(1);
      expect(rig.mailbox(SESSION)).toEqual(["second wake\n"]);
      expect(rig.store.heldWakes(PR)).toEqual([]);
    });

    it("a burst of author replies is one delivery that carries every reply, in order", async () => {
      trackPr(rig.store, PR);
      await rig.seedIdleSession(SESSION);
      rig.store.startRound(PR, "first", ["pass-baseline"], 75);
      for (const text of ["reply one", "reply two", "reply three"])
        await wakeOrHold(wakeDeps(), PR, text, AUTHOR_REPLY_WAKE_REASON);
      rig.store.cancelRunningRounds(PR, "round ended");

      await flushHeldWakes(wakeDeps(), PR);

      const [delivered, ...rest] = rig.mailbox(SESSION);
      expect(rest).toEqual([]);
      const at = ["reply one", "reply two", "reply three"].map((t) => delivered!.indexOf(t));
      expect(at.every((i) => i >= 0)).toBe(true);
      expect(at).toEqual([...at].sort((a, b) => a - b));
      expect(rig.store.heldWakes(PR)).toEqual([]);
    });

    it("a wake that cannot be delivered stays held for the next flush, never dropped", async () => {
      trackPr(rig.store, PR, "closed");
      rig.store.holdWakeWithIdentity(PR, "late reply", AUTHOR_REPLY_WAKE_REASON);
      await rig.seedIdleSession(SESSION);

      await flushHeldWakes(wakeDeps(), PR).catch(() => 0);

      expect(rig.mailbox(SESSION)).toEqual([]);
      expect(rig.store.heldWakes(PR).map((w) => w.payload)).toEqual(["late reply"]);
    });

    it("operator restart-session fences through the hook and puts a cancelled wake back among the held", async () => {
      trackPr(rig.store, PR);
      await rig.seedIdleSession(SESSION);
      await rig.hooks.inject(PR, "author replied");
      const wake = rig.store.activeSessionCommand(SESSION)!;

      const result = await recoverPrForOperator(
        {
          store: rig.store,
          pump: async () => {},
          killSession: async (pr) => void (await rig.hooks.killSession(pr)),
        },
        PR,
        "restart-session",
      );

      expect(rig.isRunning(SESSION)).toBe(false);
      expect(rig.store.getSessionCommand(wake.id)?.status).toBe("cancelled");
      expect(rig.store.blockingSessionCommand(SESSION)).toBeUndefined();
      expect(result).toMatchObject({ ok: false, redispatched: false, recovered_wakes: 1 });
      expect(rig.store.heldWakes(PR).map((w) => w.payload)).toEqual(["author replied\n"]);
    });

    it("operator restart-session changes nothing when the old session cannot be fenced", async () => {
      trackPr(rig.store, PR);
      await rig.seedIdleSession(SESSION);
      await rig.hooks.inject(PR, "author replied");
      const wake = rig.store.activeSessionCommand(SESSION)!;
      rig.wedgeSession(SESSION);

      await expect(
        recoverPrForOperator(
          {
            store: rig.store,
            pump: async () => {},
            killSession: async (pr) => void (await rig.hooks.killSession(pr)),
          },
          PR,
          "restart-session",
        ),
      ).rejects.toThrow(/not proven gone after kill/);

      expect(rig.store.blockingSessionCommand(SESSION)?.id).toBe(wake.id);
      expect(rig.store.heldWakes(PR)).toEqual([]);
    });
  });

  describe("close", () => {
    it("archiveAndClose takes the session down and refuses every later wake", async () => {
      trackPr(rig.store, PR);
      await rig.seedIdleSession(SESSION);

      rig.store.setPrState(PR, "closed");
      await rig.hooks.archiveAndClose(PR);

      expect(rig.isRunning(SESSION)).toBe(false);
      expect(await rig.hooks.sessionAlive(PR)).toBe(false);
      await expect(rig.hooks.inject(PR, "late reply")).rejects.toThrow(/is closed/);
      expect(rig.isRunning(SESSION)).toBe(false);
    });

    it("closing twice is idempotent: the session stays down and nothing is reborn", async () => {
      trackPr(rig.store, PR);
      await rig.seedIdleSession(SESSION);
      rig.store.setPrState(PR, "closed");

      await rig.hooks.archiveAndClose(PR);
      await rig.hooks.archiveAndClose(PR);

      expect(rig.isRunning(SESSION)).toBe(false);
      expect(rig.lifecycle().filter((e) => e.startsWith("birth"))).toEqual([]);
    });

    it("terminalizes a live ordinary wake, so recovery never reborns a closed PR's session", async () => {
      trackPr(rig.store, PR);
      await rig.seedIdleSession(SESSION);
      await rig.hooks.inject(PR, "author replied");
      const wake = rig.store.activeSessionCommand(SESSION)!;
      rig.store.claimSessionCommand(wake.id, "bridge-old", "2026-08-13T10:02:00Z");
      rig.store.markSessionCommandStarted(wake.id, "bridge-old", "2026-08-13T10:45:00Z");
      // The wake itself may have started a session; what must not happen is a second.
      const births = (): number => rig.lifecycle().filter((e) => e.startsWith("birth")).length;
      const bornForTheWake = births();

      rig.store.setPrState(PR, "closed");
      await rig.hooks.archiveAndClose(PR);

      expect(rig.store.getSessionCommand(wake.id)?.status).toBe("cancelled");
      expect(rig.store.blockingSessionCommand(SESSION)).toBeUndefined();
      expect(rig.store.dueSessionCommands("2099-01-01T00:00:00Z")).toEqual([]);
      expect(await rig.hooks.retrySessionCommand(wake.id, "running bound expired")).not.toBe(
        "retried",
      );
      expect(rig.isRunning(SESSION)).toBe(false);
      expect(births()).toBe(bornForTheWake);
    });

    it("a PR with no session to close still closes", async () => {
      trackPr(rig.store, PR);
      rig.store.setPrState(PR, "closed");
      await rig.hooks.archiveAndClose(PR);
      expect(rig.isRunning(SESSION)).toBe(false);
      expect(rig.lifecycle().filter((e) => e.startsWith("birth"))).toEqual([]);
    });
  });

  describe("orphan", () => {
    const sweep = async (postingOwed?: (round: { pr: number }) => boolean) => {
      const adopted: number[] = [];
      for (const round of rig.store.runningRounds())
        if (await rig.hooks.sessionAlive(round.pr)) adopted.push(round.pr);
      return reconcileOrphanedRounds(rig.store, adopted, {
        now: () => HOST_NOW,
        ...(postingOwed ? { postingOwed } : {}),
      });
    };

    it("keeps the round of a session the host still runs and cancels the round of one it lost", async () => {
      for (const pr of [PR, 43]) {
        trackPr(rig.store, pr);
        rig.store.startRound(pr, "first", ["pass-baseline"], 75);
      }
      await rig.seedRunningSession(SESSION);

      const swept = await sweep();

      expect(swept.cancelled).toEqual([43]);
      expect(rig.store.roundStatus(PR, 1)).toBe("running");
      expect(rig.store.roundStatus(43, 1)).not.toBe("running");
      expect(rig.isRunning(SESSION)).toBe(true);
    });

    it("keeps a sessionless round whose review posting is still owed", async () => {
      trackPr(rig.store, 43);
      rig.store.startRound(43, "first", ["pass-baseline"], 75);

      const swept = await sweep((round) => round.pr === 43);

      expect(swept.cancelled).toEqual([]);
      expect(swept.kept_for_posting).toEqual([43]);
      expect(rig.store.roundStatus(43, 1)).toBe("running");
    });
  });
});
