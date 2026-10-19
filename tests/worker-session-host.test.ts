// [P8.6] The worker host's own cases: what the shared conformance suite
// (session-hooks-conformance.test.ts) leaves to a host whose command IS its
// delivery. The rig is the conformance one: the real WorkerSessionHost over a real
// WorkerSupervisor whose spawn, process table and signals are fakes.
//
//   what it offers   no compaction hook of its own; the ack is the receipt
//   receipts         the command's ack, read by the silent-round net, the recheck
//                    sweep and the patience signal
//   redelivery       the cheap recovery: a worker for a pending command, a replay
//                    of a failed one, nothing written into a live worker
//   retry            fence first, then the same id and bytes under a fresh worker
//   launch refused   a refusal is not a dispatch failure; the row stays the one
//                    obligation and the daemon's timer starts it
//   held wakes       the round's own worker takes them (src/wakes.ts)
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { AUTHOR_REPLY_WAKE_REASON, StateStore } from "../src/state.js";
import {
  recheckPromptMarker,
  roundPromptMarker,
  stampPrompt,
  type RoundOrder,
  type SessionHooks,
} from "../src/types.js";
import { sessionCommandMarker } from "../src/session-command.js";
import { HeldWakeHandoff, flushHeldWakes, wakeOrHold, type WakeDeps } from "../src/wakes.js";
import {
  HOST_NOW,
  openWorkerRig,
  sha256,
  trackPr,
  type WorkerHostRig,
} from "./helpers/session-hooks-host.js";

const PR = 42;
const SESSION = `pr-${PR}`;
const BODY = "ROUND PROMPT BODY";
const STAMPED = `${BODY}\n\n${roundPromptMarker(PR, 1)}\n`;
const STARTED_MS = HOST_NOW.getTime();

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

let rig: WorkerHostRig;
beforeEach(() => {
  rig = openWorkerRig();
});
afterEach(() => {
  rig.dispose();
});

/** A tracked PR whose round is running and handed to a worker. */
async function dispatched() {
  trackPr(rig.store, PR);
  rig.store.startRound(PR, "first", ["pass-baseline"], 75);
  await rig.hooks.dispatchRound(order, BODY);
  return rig.store.activeSessionCommand(SESSION)!;
}

const births = (): number => rig.lifecycle().filter((e) => e.startsWith("birth")).length;
const events = (kind: string): unknown[] =>
  rig.store.db.prepare("SELECT payload FROM events WHERE kind = ?").all(kind);

describe("[P8.6] what the worker host offers", () => {
  it("compacts nothing itself: its worker does, before it exits", () => {
    const hooks = rig.host as SessionHooks;
    expect(hooks.compactSession).toBeUndefined();
    expect(hooks.sessionCompaction).toBeUndefined();
    expect(hooks.ackIsReceipt).toBe(true);
  });

  it("hands a round to one worker as one claimed command, bytes saved before the row exists", async () => {
    const row = await dispatched();
    expect(row).toMatchObject({ kind: "round", status: "running", attempt: 1, started_at: null });
    expect(row.owner_token).not.toBeNull();
    expect(row.payload_sha256).toBe(sha256(STAMPED));
    expect(rig.mailbox(SESSION)).toEqual([STAMPED]);
    expect(rig.workers()).toEqual([SESSION]);
    // The slot is taken: a second instruction waits for the first, not beside it.
    await expect(rig.hooks.inject(PR, "author replied")).rejects.toThrow(/is running/);
    expect(rig.workers()).toEqual([SESSION]);
  });

  it("answers liveness from the worker, and a worker that exits is not alive", async () => {
    await dispatched();
    expect(await rig.hooks.sessionAlive(PR)).toBe(true);
    await rig.exit(SESSION, 0);
    expect(await rig.hooks.sessionAlive(PR)).toBe(false);
  });
});

describe("[P8.6] the ack is the receipt", () => {
  it("reads null while the worker is starting, true once it accepted the order", async () => {
    await dispatched();
    expect(await rig.hooks.roundPromptAccepted(PR, 1, STARTED_MS)).toBeNull();
    expect(await rig.hooks.injectPending(PR)).toBe(true);

    rig.recordAccepted(PR, STAMPED);

    expect(await rig.hooks.roundPromptAccepted(PR, 1, STARTED_MS)).toBe(true);
    // Nothing is retrying delivery any more: the net has no patience left to give.
    expect(await rig.hooks.injectPending(PR)).toBe(false);
  });

  it("reads false for an order its worker never accepted, and for a round with no command", async () => {
    await dispatched();
    await rig.loseDeliveredOrder(PR);

    expect(rig.store.sessionCommandForRound(PR, 1)?.status).toBe("failed");
    expect(await rig.hooks.roundPromptAccepted(PR, 1, STARTED_MS)).toBe(false);
    expect(await rig.hooks.injectPending(PR)).toBe(false);
    // Nothing was ever handed to a worker for round 2.
    expect(await rig.hooks.roundPromptAccepted(PR, 2, STARTED_MS)).toBe(false);
  });

  it("counts a served worker (exit 0) as having taken the order, even if its accepted was lost", async () => {
    await dispatched();
    await rig.settleDelivered(PR);
    expect(await rig.hooks.roundPromptAccepted(PR, 1, STARTED_MS)).toBe(true);
  });

  it("finds a wake's fate by the marker it carries, and a command's by its own", async () => {
    trackPr(rig.store, PR);
    const marker = recheckPromptMarker(PR, "fingerprint-1");
    const wake = stampPrompt("recheck: head moved", marker);
    await rig.hooks.inject(PR, wake);
    const row = rig.store.activeSessionCommand(SESSION)!;
    const own = sessionCommandMarker(row.id, row.payload_sha256);

    expect(await rig.hooks.wakeReceiptPresent(PR, marker, STARTED_MS)).toBeNull();
    expect(await rig.hooks.wakeReceiptPresent(PR, own, STARTED_MS)).toBeNull();
    rig.recordAccepted(PR, wake);
    expect(await rig.hooks.wakeReceiptPresent(PR, marker, STARTED_MS)).toBe(true);
    expect(await rig.hooks.wakeReceiptPresent(PR, own, STARTED_MS)).toBe(true);
    // No command carries this one: it was never handed over.
    expect(
      await rig.hooks.wakeReceiptPresent(PR, recheckPromptMarker(PR, "other"), STARTED_MS),
    ).toBe(false);
  });

  it("reads a round's command by its own marker too: the one the command supervisor asks with", async () => {
    const row = await dispatched();
    const own = sessionCommandMarker(row.id, row.payload_sha256);

    expect(await rig.hooks.wakeReceiptPresent(PR, own, STARTED_MS)).toBeNull();
    rig.recordAccepted(PR, STAMPED);
    expect(await rig.hooks.wakeReceiptPresent(PR, own, STARTED_MS)).toBe(true);
  });

  it("reads a round's marker off its command, and a wake whose worker ended unaccepted as false", async () => {
    await dispatched();
    expect(await rig.hooks.wakeReceiptPresent(PR, roundPromptMarker(PR, 1), STARTED_MS)).toBeNull();
    await rig.loseDeliveredOrder(PR);
    expect(await rig.hooks.wakeReceiptPresent(PR, roundPromptMarker(PR, 1), STARTED_MS)).toBe(
      false,
    );
  });

  it("does not call a wake absent when a payload could not be read: archived proves nothing", async () => {
    trackPr(rig.store, PR);
    await rig.hooks.inject(PR, "author replied");
    const row = rig.store.activeSessionCommand(SESSION)!;
    await rig.settleDelivered(PR);
    rmSync(row.payload_path);

    expect(
      await rig.hooks.wakeReceiptPresent(PR, recheckPromptMarker(PR, "gone"), STARTED_MS),
    ).toBeNull();
  });

  it("reads transcript activity from the PR's JSONL, and none as null", async () => {
    trackPr(rig.store, PR);
    expect(await rig.hooks.sessionActivityAt(PR)).toBeNull();
    rig.recordActivity(PR);
    expect(await rig.hooks.sessionActivityAt(PR)).toEqual(expect.any(Number));
  });
});

describe("[P8.6] a refused launch is not a failed dispatch", () => {
  it("leaves the pending command as the one obligation, and the daemon's timer starts it", async () => {
    trackPr(rig.store, PR);
    rig.store.startRound(PR, "first", ["pass-baseline"], 75);
    rig.holdLogin(true);

    await rig.hooks.dispatchRound(order, BODY);

    const row = rig.store.activeSessionCommand(SESSION)!;
    expect(row).toMatchObject({ status: "pending", attempt: 0 });
    expect(rig.workers()).toEqual([]);
    expect(events("worker_launch_deferred")).toHaveLength(1);
    // Still on its way: not lost, not delivered.
    expect(await rig.hooks.injectPending(PR)).toBe(true);
    expect(await rig.hooks.sessionAlive(PR)).toBe(false);

    rig.holdLogin(false);
    await rig.host.launchPending();

    expect(rig.store.getSessionCommand(row.id)).toMatchObject({ status: "running", attempt: 1 });
    expect(rig.workers()).toEqual([SESSION]);
  });

  it("starts a worker for a command a crashed worker handed back", async () => {
    const row = await dispatched();
    await rig.exit(SESSION, 143); // killed from outside: the supervisor requeues the round
    expect(rig.store.getSessionCommand(row.id)).toMatchObject({
      status: "pending",
      started_at: null,
    });

    await rig.host.launchPending();

    expect(rig.store.getSessionCommand(row.id)).toMatchObject({ status: "running", attempt: 2 });
    expect(births()).toBe(2);
  });
});

describe("[P8.6] redelivery is the cheap recovery", () => {
  it("redeliverRound is a no-op while a worker holds the order, and says so", async () => {
    await dispatched();
    expect(await rig.hooks.redeliverRound(PR, 1)).toBe(false);
    rig.recordAccepted(PR, STAMPED);
    expect(await rig.hooks.redeliverRound(PR, 1)).toBe(true);
    expect(births()).toBe(1);
  });

  it("redeliverRound gives a pending command its worker", async () => {
    trackPr(rig.store, PR);
    rig.store.startRound(PR, "first", ["pass-baseline"], 75);
    rig.holdLogin(true);
    await rig.hooks.dispatchRound(order, BODY);
    rig.holdLogin(false);

    expect(await rig.hooks.redeliverRound(PR, 1)).toBe(true);

    expect(rig.workers()).toEqual([SESSION]);
    expect(rig.store.activeSessionCommand(SESSION)).toMatchObject({ status: "running" });
  });

  it("redeliverRound replays a failed command under its own id, with the same bytes", async () => {
    const original = await dispatched();
    await rig.loseDeliveredOrder(PR);

    expect(await rig.hooks.redeliverRound(PR, 1)).toBe(true);

    const replayed = rig.store.activeSessionCommand(SESSION)!;
    expect(replayed.id).toBe(original.id);
    expect(replayed.attempt).toBe(2);
    expect(replayed.payload_sha256).toBe(original.payload_sha256);
    expect(rig.mailbox(SESSION)).toEqual([STAMPED]);
    expect(rig.store.db.prepare("SELECT COUNT(*) AS c FROM session_commands").get()).toEqual({
      c: 1,
    });
  });

  it("redeliverRound says false when nothing was saved, when the bytes no longer verify, and when the round ended", async () => {
    await dispatched();
    expect(await rig.hooks.redeliverRound(PR, 99)).toBe(false);

    await rig.loseDeliveredOrder(PR);
    const row = rig.store.sessionCommandForRound(PR, 1)!;
    writeFileSync(row.payload_path, "tampered\n");
    expect(await rig.hooks.redeliverRound(PR, 1)).toBe(false);

    writeFileSync(row.payload_path, STAMPED);
    rig.store.cancelRunningRounds(PR, "ended");
    expect(await rig.hooks.redeliverRound(PR, 1)).toBe(false);
    expect(births()).toBe(1);
  });

  describe("redeliverSessionCommand", () => {
    const observed = (row: { attempt: number; redeliveries: number; next_check_at: string }) => ({
      attempt: row.attempt,
      redeliveries: row.redeliveries,
      next_check_at: row.next_check_at,
    });

    it("leaves a live worker that has not accepted to the kill-and-replay recovery", async () => {
      const row = await dispatched();
      expect(await rig.hooks.redeliverSessionCommand(row.id, observed(row))).toBe("not_live");
      expect(births()).toBe(1);
    });

    it("never touches a row that moved, started or settled since the supervisor saw it", async () => {
      const row = await dispatched();
      expect(
        await rig.hooks.redeliverSessionCommand(row.id, {
          ...observed(row),
          attempt: row.attempt + 1,
        }),
      ).toBe("raced");

      rig.recordAccepted(PR, STAMPED);
      expect(await rig.hooks.redeliverSessionCommand(row.id, observed(row))).toBe("started");

      await rig.settleDelivered(PR);
      expect(await rig.hooks.redeliverSessionCommand(row.id, observed(row))).toBe("settled");
      expect(await rig.hooks.redeliverSessionCommand("no-such-command", observed(row))).toBe(
        "redelivery_failed",
      );
    });

    it("starts the worker a pending command never got", async () => {
      trackPr(rig.store, PR);
      rig.store.startRound(PR, "first", ["pass-baseline"], 75);
      rig.holdLogin(true);
      await rig.hooks.dispatchRound(order, BODY);
      const row = rig.store.activeSessionCommand(SESSION)!;
      rig.holdLogin(false);

      expect(await rig.hooks.redeliverSessionCommand(row.id, observed(row))).toBe("redelivered");
      expect(rig.workers()).toEqual([SESSION]);
    });
  });
});

describe("[P8.6] retry fences the old worker first", () => {
  it("ends the worker, then replays the same id and bytes under a fresh one", async () => {
    const original = await dispatched();

    expect(await rig.hooks.retrySessionCommand(original.id, "start lease expired")).toBe("retried");

    expect(rig.lifecycle()).toEqual([`birth ${SESSION}`, `kill ${SESSION}`, `birth ${SESSION}`]);
    const retried = rig.store.activeSessionCommand(SESSION)!;
    expect(retried).toMatchObject({ id: original.id, attempt: 2, status: "running" });
    expect(rig.mailbox(SESSION)).toEqual([STAMPED]);
    expect(rig.workers()).toEqual([SESSION]);
  });

  it("refuses a round that already started: its merits lifecycle owns that", async () => {
    const row = await dispatched();
    rig.recordAccepted(PR, STAMPED);

    expect(await rig.hooks.retrySessionCommand(row.id, "expired")).toBe("retry_failed");
    expect(rig.lifecycle()).toEqual([`birth ${SESSION}`]);
  });

  it("leaves a round whose verdict is already on disk, after the fence", async () => {
    const row = await dispatched();
    mkdirSync(join(rig.root, "verdict"), { recursive: true });
    writeFileSync(join(rig.root, "verdict", `pr-${PR}-round-1.json`), "{}");

    expect(await rig.hooks.retrySessionCommand(row.id, "expired")).toBe("round_finished");
    // The old worker is fenced all the same: nothing runs beside a decided round.
    expect(rig.isRunning(SESSION)).toBe(false);
    expect(births()).toBe(1);
  });

  it("will not replay bytes that no longer verify, and records why on the row", async () => {
    const row = await dispatched();
    writeFileSync(row.payload_path, "tampered\n");

    expect(await rig.hooks.retrySessionCommand(row.id, "expired")).toBe("retry_failed");

    expect(rig.isRunning(SESSION)).toBe(true);
    expect(rig.store.getSessionCommand(row.id)?.failure).toMatch(/hash/);
  });

  it("settles a closed PR's wake instead of starting a worker for it", async () => {
    trackPr(rig.store, PR);
    await rig.hooks.inject(PR, "author replied");
    const row = rig.store.activeSessionCommand(SESSION)!;
    rig.store.setPrState(PR, "closed");

    expect(await rig.hooks.retrySessionCommand(row.id, "expired")).toBe("settled");

    expect(rig.store.getSessionCommand(row.id)?.status).toBe("cancelled");
    expect(births()).toBe(1);
  });

  it("reports a replay it could not start as failed, and keeps the pending row", async () => {
    const row = await dispatched();
    rig.holdLogin(true);

    expect(await rig.hooks.retrySessionCommand(row.id, "expired")).toBe("retry_failed");

    // Fenced and handed back, but no worker could be started for it: still the one
    // obligation, due again for the supervisor's next finite check.
    expect(rig.isRunning(SESSION)).toBe(false);
    expect(rig.store.getSessionCommand(row.id)).toMatchObject({ status: "pending" });
    expect(events("session_command_rebirth_failed")).toHaveLength(1);
  });
});

describe("[P8.6] the fence leaves the row to the caller", () => {
  it("ends the worker and does not settle its command", async () => {
    const row = await dispatched();

    await rig.hooks.killSession(PR);

    expect(rig.isRunning(SESSION)).toBe(false);
    expect(rig.store.getSessionCommand(row.id)).toMatchObject({
      status: "running",
      owner_token: row.owner_token,
    });
    expect(events("worker_exited")).toHaveLength(1);
  });
});

describe("[P8.6] held wakes ride the round's own worker", () => {
  const wakeDeps = (): WakeDeps => ({
    store: rig.store,
    inject: (pr, message) => rig.hooks.inject(pr, message),
  });

  it("holds a wake while the round runs, and the daemon's flush finds the worker's slot taken", async () => {
    await dispatched();

    expect(await wakeOrHold(wakeDeps(), PR, "author replied", "author_reply")).toBe("held");
    expect(await flushHeldWakes(wakeDeps(), PR)).toBe(0);

    expect(rig.store.heldWakes(PR).map((w) => w.payload)).toEqual(["author replied"]);
    expect(births()).toBe(1);
  });

  it("flushes what the worker did not take once it is gone, to a worker of its own", async () => {
    const round = await dispatched();
    await wakeOrHold(wakeDeps(), PR, "late reply", "author_reply");
    // The round's worker exits without taking it (it arrived after the last pass).
    await rig.settleDelivered(PR);
    rig.store.cancelRunningRounds(PR, "round ended");
    expect(rig.store.getSessionCommand(round.id)?.status).toBe("acked");

    expect(await flushHeldWakes(wakeDeps(), PR)).toBe(1);

    expect(rig.store.heldWakes(PR)).toEqual([]);
    expect(rig.mailbox(SESSION)).toEqual(["late reply\n"]);
    expect(rig.store.activeSessionCommand(SESSION)?.kind).toBe("wake");
    expect(births()).toBe(2);
  });

  describe("the handoff the worker takes them through", () => {
    // A store on the real clock: a delivery's lease is read against it.
    let store: StateStore;
    beforeEach(() => {
      store = new StateStore(":memory:");
      trackPr(store, PR);
    });
    afterEach(() => {
      store.close();
    });
    const hold = (text: string, reason = "author_reply"): number =>
      store.holdWakeWithIdentity(PR, text, reason).id;

    it("gives the worker a wake once, leased until it acks", () => {
      hold("author replied");
      const handoff = new HeldWakeHandoff(store);

      const [batch, ...rest] = handoff.take(PR);
      expect(rest).toEqual([]);
      expect(batch!.message).toBe("author replied");
      // Leased to this delivery: nobody else takes it, the daemon's flush included.
      expect(handoff.take(PR)).toEqual([]);

      handoff.ack(PR, batch!.id);

      expect(store.heldWakes(PR)).toEqual([]);
      expect(handoff.take(PR)).toEqual([]);
    });

    it("serves the supervisor's wakes dependency: take and ack by the request's PR", () => {
      hold("author replied");
      const wakes = new HeldWakeHandoff(store).forWorker();

      const [batch] = wakes.take({ pr: PR });
      expect(batch!.message).toBe("author replied");
      wakes.ack({ pr: PR }, batch!.id);

      expect(store.heldWakes(PR)).toEqual([]);
    });

    it("names a delivery by its wakes, so a worker that died before acking is not sent it twice", () => {
      const id = hold("author replied");
      const [batch] = new HeldWakeHandoff(store).take(PR);
      expect(batch!.id).toBe(`held.${id}`);
    });

    it("delivers a burst of author replies as one unit, in order", () => {
      for (const text of ["reply one", "reply two", "reply three"])
        hold(text, AUTHOR_REPLY_WAKE_REASON);
      const handoff = new HeldWakeHandoff(store);

      const [batch] = handoff.take(PR);

      const at = ["reply one", "reply two", "reply three"].map((t) => batch!.message.indexOf(t));
      expect(at.every((i) => i >= 0)).toBe(true);
      expect(at).toEqual([...at].sort((a, b) => a - b));
      handoff.ack(PR, batch!.id);
      expect(store.heldWakes(PR)).toEqual([]);
      expect(
        store.db.prepare("SELECT COUNT(*) AS c FROM events WHERE kind = 'wakes_coalesced'").get(),
      ).toEqual({ c: 1 });
    });

    it("serves one unit at a time, oldest first: the next only after the last was acked", () => {
      hold("first wake", "recheck:push");
      hold("second wake", "recheck:ci");
      const handoff = new HeldWakeHandoff(store);

      const [one] = handoff.take(PR);
      expect(one!.message).toBe("first wake");
      expect(handoff.take(PR)).toEqual([]);
      handoff.ack(PR, one!.id);
      const [two] = handoff.take(PR);
      expect(two!.message).toBe("second wake");
    });

    it("refuses an ack for a delivery it did not hand out, or for another PR", () => {
      hold("author replied");
      const handoff = new HeldWakeHandoff(store);
      const [batch] = handoff.take(PR);

      expect(() => handoff.ack(PR, "held.999")).toThrow(/no wake delivery/);
      expect(() => handoff.ack(43, batch!.id)).toThrow(/no wake delivery/);
      expect(store.heldWakes(PR)).toHaveLength(1);
    });

    it("leaves a paused PR's recheck nudges held, as the injecting flush does", () => {
      hold("recheck: ci", "recheck:ci");
      store.db.prepare("UPDATE pr_state SET paused = 1 WHERE number = ?").run(PR);

      expect(new HeldWakeHandoff(store).take(PR)).toEqual([]);
      expect(store.heldWakes(PR)).toHaveLength(1);
    });

    it("releases nothing on its own: an unacked delivery waits out its lease", () => {
      hold("author replied");
      new HeldWakeHandoff(store).take(PR);

      // A second handoff (another daemon life) cannot take what is leased.
      expect(new HeldWakeHandoff(store).take(PR)).toEqual([]);
      expect(store.heldWakes(PR)).toHaveLength(1);
    });
  });
});

describe("[P8.6] closing a PR ends its worker", () => {
  it("fences the worker, cancels a wake's command and refuses every later wake", async () => {
    trackPr(rig.store, PR);
    await rig.hooks.inject(PR, "author replied");
    const row = rig.store.activeSessionCommand(SESSION)!;
    rig.store.setPrState(PR, "closed");

    await rig.hooks.archiveAndClose(PR);

    expect(rig.isRunning(SESSION)).toBe(false);
    expect(rig.store.getSessionCommand(row.id)?.status).toBe("cancelled");
    await expect(rig.hooks.inject(PR, "late reply")).rejects.toThrow(/is closed/);
    expect(births()).toBe(1);
  });

  it("ends a round's worker too, and leaves the round's own command to its merits lifecycle", async () => {
    const row = await dispatched();
    rig.store.setPrState(PR, "closed");

    await rig.hooks.archiveAndClose(PR);

    expect(rig.isRunning(SESSION)).toBe(false);
    expect(rig.store.getSessionCommand(row.id)?.status).toBe("running");
  });
});
