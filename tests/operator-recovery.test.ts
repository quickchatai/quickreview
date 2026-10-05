import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { recoverPrForOperator } from "../src/operator-recovery.js";
import { StateStore } from "../src/state.js";
import { HEAVY_TIMEOUT_MS } from "./helpers/suite-timeouts.js";

const T0 = "2026-08-31T08:00:00.000Z";
const stores: StateStore[] = [];
const dirs: string[] = [];

afterEach(() => {
  for (const store of stores.splice(0)) store.close();
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function setup(pr = 5409) {
  const store = new StateStore(":memory:", () => new Date(T0));
  stores.push(store);
  store.upsertPr({
    number: pr,
    state: "queued",
    head_sha: "a".repeat(40),
    title: `PR ${pr}`,
    author: "alice",
    trigger_ts: T0,
    stale_recheck: 0,
    migration_gate: 0,
  });
  const dir = mkdtempSync(join(tmpdir(), "qcr-operator-recovery-"));
  dirs.push(dir);
  return { store, dir, pr };
}

function postingReceiptFailure(
  store: StateStore,
  dir: string,
  pr: number,
  withAuthorReply = false,
  verdict: "REQUEST_CHANGES" | "APPROVE" = "REQUEST_CHANGES",
  shellOnlyMark = false,
  commandTerminal: "acked" | "failed" = "acked",
) {
  const head = "a".repeat(40);
  store.recordReviewedHead(pr, {
    head_sha: head,
    verdict,
    posted_event: verdict,
    round_no: 8,
  });
  if (shellOnlyMark)
    store.db.prepare("UPDATE reviewed_heads SET verdict=NULL, round_no=NULL WHERE pr=?").run(pr);
  if (withAuthorReply) store.noteAuthorReply(pr, T0);
  store.setPrState(pr, "reviewing");
  const roundId = store.startRound(pr, "re-review", ["pass-baseline"], 75);
  const roundNo = store.roundsFor(pr)[0]!.round_no;
  const payload = "round order\n";
  const payloadPath = join(dir, "posting.payload.md");
  const injectPath = join(dir, "posting.inject.md");
  writeFileSync(payloadPath, payload);
  writeFileSync(injectPath, payload);
  const commandId = "cmd-posting";
  store.createSessionCommand({
    id: commandId,
    pr,
    session: `pr-${pr}`,
    kind: "round",
    round_no: roundNo,
    payload_sha256: createHash("sha256").update(payload).digest("hex"),
    payload_path: payloadPath,
    inject_path: injectPath,
    next_check_at: T0,
  });
  if (commandTerminal === "failed")
    store.failPendingSessionCommand(commandId, "posting receipt absent");
  else {
    expect(store.claimSessionCommand(commandId, "test-owner", T0)).toBeDefined();
    expect(store.markSessionCommandStarted(commandId, "test-owner", T0)).toBe(true);
    expect(store.finishSessionCommand(commandId, "test-owner", "acked")).toBe(true);
  }
  store.markRoundCancelled(roundId, "posting receipt absent", "infrastructure_failure");
  store.setPrState(pr, "queued");
  const failure = store.openReviewFailure({
    pr,
    command_id: commandId,
    round_id: roundId,
    round_no: roundNo,
    head_sha: head,
    stage: "posting_receipt",
    detail: "receipt absent",
    attempts: 1,
    retry_cap: 0,
  });
  return { failure, commandId, roundId, roundNo, head };
}

function command(
  store: StateStore,
  dir: string,
  pr: number,
  kind: "round" | "wake" = "round",
  payload = kind === "round" ? "round order\n" : "author reply\n",
) {
  const payloadPath = join(dir, `${kind}.payload.md`);
  const injectPath = join(dir, `${kind}.inject.md`);
  writeFileSync(payloadPath, payload);
  writeFileSync(injectPath, payload);
  const row = store.createSessionCommand({
    id: `cmd-${kind}`,
    pr,
    session: `pr-${pr}`,
    kind,
    round_no: kind === "round" ? 9 : null,
    payload_sha256: createHash("sha256").update(payload).digest("hex"),
    payload_path: payloadPath,
    inject_path: injectPath,
    next_check_at: T0,
  });
  return { row, payload, payloadPath, injectPath };
}

describe("operator PR recovery", () => {
  it(
    "refuses rerun-round while durable session ownership still blocks dispatch",
    { timeout: HEAVY_TIMEOUT_MS },
    async () => {
      const { store, dir, pr } = setup();
      command(store, dir, pr);
      const pump = vi.fn(async () => {});

      const result = await recoverPrForOperator({ store, pump }, pr, "rerun-round");

      expect(result).toMatchObject({ ok: false, blocking_command: "cmd-round" });
      expect(result.reason).toContain("restart-session");
      expect(pump).not.toHaveBeenCalled();
      expect(store.blockingSessionCommand(`pr-${pr}`)?.id).toBe("cmd-round");
    },
  );

  it("restart-session fences the old consumer, clears its round command, and proves redispatch", async () => {
    const { store, dir, pr } = setup();
    const c = command(store, dir, pr);
    const killSession = vi.fn(async () => {});
    const pump = vi.fn(async () => {
      store.setPrState(pr, "reviewing");
      store.startRound(pr, "re-review", ["pass-baseline"], 75);
      return;
    });

    const result = await recoverPrForOperator({ store, pump, killSession }, pr, "restart-session");

    expect(killSession).toHaveBeenCalledWith(pr);
    expect(readFileSync(c.payloadPath, "utf8")).toBe(c.payload); // immutable evidence stays
    expect(() => readFileSync(c.injectPath)).toThrow(); // stale delivery cannot rebirth
    expect(store.getSessionCommand(c.row.id)?.status).toBe("cancelled");
    expect(store.blockingSessionCommand(`pr-${pr}`)).toBeUndefined();
    expect(result).toMatchObject({
      ok: true,
      redispatched: true,
      cancelled_session_commands: [c.row.id],
    });
  });

  it("restores a cancelled wake ahead of dispatch and reports that no round started", async () => {
    const { store, dir, pr } = setup(5454);
    const c = command(store, dir, pr, "wake", "zażółć 🧭\0\n");
    const pump = vi.fn(async () => {
      expect(store.heldWakes(pr).map((wake) => wake.payload)).toEqual([c.payload]);
      return;
    });

    const result = await recoverPrForOperator(
      { store, pump, killSession: async () => {} },
      pr,
      "restart-session",
    );

    expect(result).toMatchObject({ ok: false, redispatched: false, recovered_wakes: 1 });
    expect(result.reason).toContain("held conversational wake");
    expect(store.heldWakes(pr).map((wake) => wake.payload)).toEqual([c.payload]);
  });

  it("refuses to cancel a successor command that appears while the old session is being fenced", async () => {
    const { store, dir, pr } = setup();
    const old = command(store, dir, pr, "round");
    const successorPayload = "successor round\n";
    const successorPayloadPath = join(dir, "successor.payload.md");
    const successorInjectPath = join(dir, "successor.inject.md");
    writeFileSync(successorPayloadPath, successorPayload);
    writeFileSync(successorInjectPath, successorPayload);
    const pump = vi.fn(async () => {});

    await expect(
      recoverPrForOperator(
        {
          store,
          pump,
          killSession: async () => {
            store.claimSessionCommand(old.row.id, "bridge-old", T0);
            store.markSessionCommandStarted(old.row.id, "bridge-old", T0);
            store.finishSessionCommand(old.row.id, "bridge-old", "acked");
            store.createSessionCommand({
              id: "cmd-successor",
              pr,
              session: `pr-${pr}`,
              kind: "round",
              round_no: 10,
              payload_sha256: createHash("sha256").update(successorPayload).digest("hex"),
              payload_path: successorPayloadPath,
              inject_path: successorInjectPath,
              next_check_at: T0,
            });
          },
        },
        pr,
        "restart-session",
      ),
    ).rejects.toThrow(/blocker set changed/);

    expect(pump).not.toHaveBeenCalled();
    expect(store.getSessionCommand("cmd-successor")?.status).toBe("pending");
    expect(readFileSync(successorInjectPath, "utf8")).toBe(successorPayload);
    expect(() => readFileSync(old.injectPath)).toThrow(); // the acked predecessor must not re-enter *.md delivery
  });

  it("never reopens a PR that closes while its old session is being fenced", async () => {
    const { store, dir, pr } = setup();
    command(store, dir, pr, "round");
    const pump = vi.fn(async () => {});

    const result = await recoverPrForOperator(
      {
        store,
        pump,
        killSession: async () => {
          store.setPrState(pr, "closed");
        },
      },
      pr,
      "restart-session",
    );

    expect(result).toMatchObject({ ok: false, redispatched: false, no_op_state: "closed" });
    expect(store.getPr(pr)?.state).toBe("closed");
  });

  it("changes nothing when the old session cannot be fenced", async () => {
    const { store, dir, pr } = setup();
    const c = command(store, dir, pr, "wake");
    const pump = vi.fn(async () => {});

    await expect(
      recoverPrForOperator(
        {
          store,
          pump,
          killSession: async () => {
            throw new Error("tmux survived");
          },
        },
        pr,
        "restart-session",
      ),
    ).rejects.toThrow(/tmux survived/);

    expect(pump).not.toHaveBeenCalled();
    expect(store.blockingSessionCommand(`pr-${pr}`)?.id).toBe(c.row.id);
    expect(readFileSync(c.injectPath, "utf8")).toBe(c.payload);
    expect(store.heldWakes(pr)).toEqual([]);
  });

  it("changes nothing when immutable payload evidence is corrupt", async () => {
    const { store, dir, pr } = setup();
    const c = command(store, dir, pr);
    writeFileSync(c.payloadPath, "corrupt\n");
    const killSession = vi.fn(async () => {});
    const pump = vi.fn(async () => {});

    const result = await recoverPrForOperator({ store, pump, killSession }, pr, "restart-session");

    expect(result).toMatchObject({ ok: false });
    expect(result.reason).toContain("payload hash");
    expect(killSession).not.toHaveBeenCalled();
    expect(pump).not.toHaveBeenCalled();
    expect(store.blockingSessionCommand(`pr-${pr}`)?.id).toBe(c.row.id);
  });

  it("retires an impossible same-head posting-receipt retry without dispatch", async () => {
    const { store, dir, pr } = setup();
    const fixture = postingReceiptFailure(store, dir, pr);
    const pump = vi.fn(async () => {});

    const result = await recoverPrForOperator({ store, pump }, pr, "rerun-round");

    expect(result).toMatchObject({
      ok: true,
      redispatched: false,
      exact_head_retired: true,
      recovery_hold_cleared: fixture.failure.incident_id,
      restored_state: "awaiting_author",
    });
    expect(pump).not.toHaveBeenCalled();
    expect(store.getPr(pr)?.state).toBe("awaiting_author");
    expect(store.getSessionCommand(fixture.commandId)?.status).toBe("acked");
    expect(store.openReviewFailure(pr)).toBeUndefined();
    expect(store.roundsFor(pr).find((round) => round.id === fixture.roundId)?.status).toBe(
      "cancelled",
    );
    const event = store
      .eventsOn("2026-08-31")
      .find((row) => row.kind === "exact_head_review_failure_retired");
    expect(JSON.parse(event!.payload!)).toMatchObject({
      incident_id: fixture.failure.incident_id,
      command_id: fixture.commandId,
      round_id: fixture.roundId,
      head_sha: fixture.head,
      standing_verdict: "REQUEST_CHANGES",
      restored_state: "awaiting_author",
    });
  });

  it("recognizes a substantive shell-only posting mark before verdict enrichment", async () => {
    const { store, dir, pr } = setup();
    postingReceiptFailure(store, dir, pr, false, "REQUEST_CHANGES", true);
    expect(store.reviewedHead(pr)).toMatchObject({
      verdict: null,
      posted_event: "REQUEST_CHANGES",
      round_no: null,
    });
    const pump = vi.fn(async () => {});

    const result = await recoverPrForOperator({ store, pump }, pr, "rerun-round");

    expect(result).toMatchObject({
      ok: true,
      redispatched: false,
      exact_head_retired: true,
      restored_state: "awaiting_author",
    });
    expect(pump).not.toHaveBeenCalled();
  });

  it("cancels an exact failed command while retiring its receipt debt", async () => {
    const { store, dir, pr } = setup();
    const fixture = postingReceiptFailure(
      store,
      dir,
      pr,
      false,
      "REQUEST_CHANGES",
      false,
      "failed",
    );
    const pump = vi.fn(async () => {});

    const result = await recoverPrForOperator({ store, pump }, pr, "rerun-round");

    expect(result).toMatchObject({
      ok: true,
      exact_head_retired: true,
      restored_state: "awaiting_author",
    });
    expect(store.getSessionCommand(fixture.commandId)?.status).toBe("cancelled");
    expect(pump).not.toHaveBeenCalled();
  });

  it.each([false, true])(
    "restores tracked for an exact-head standing approval (shellOnly=%s)",
    async (shellOnly) => {
      const { store, dir, pr } = setup();
      postingReceiptFailure(store, dir, pr, false, "APPROVE", shellOnly);
      const pump = vi.fn(async () => {});

      const result = await recoverPrForOperator({ store, pump }, pr, "rerun-round");

      expect(result).toMatchObject({
        ok: true,
        exact_head_retired: true,
        restored_state: "tracked",
      });
      expect(store.getPr(pr)?.state).toBe("tracked");
      expect(pump).not.toHaveBeenCalled();
    },
  );

  it.each(["COMMENT", "NEEDS_HUMAN", "request_changes", ""])(
    "does not treat posted event %j as substantive proof",
    (postedEvent) => {
      const { store, dir, pr } = setup();
      const fixture = postingReceiptFailure(store, dir, pr, false, "REQUEST_CHANGES", true);
      store.db.prepare("UPDATE reviewed_heads SET posted_event=? WHERE pr=?").run(postedEvent, pr);

      expect(
        store.resolveExactHeadReviewedFailure({
          pr,
          incident_id: fixture.failure.incident_id,
          command_id: fixture.commandId,
          round_id: fixture.roundId,
          round_no: fixture.roundNo,
          head_sha: fixture.head,
        }),
      ).toEqual({ kind: "not_applicable" });
      expect(store.openReviewFailure(pr)?.work_owed).toBe(1);
    },
  );

  it("refuses mismatched failed-round identity without clearing or dispatching", async () => {
    const { store, dir, pr } = setup();
    const fixture = postingReceiptFailure(store, dir, pr);
    store.db
      .prepare("UPDATE review_failures SET round_id=? WHERE incident_id=?")
      .run(fixture.roundId + 999, fixture.failure.incident_id);
    const pump = vi.fn(async () => {});

    const result = await recoverPrForOperator({ store, pump }, pr, "rerun-round");

    expect(result).toMatchObject({
      ok: false,
      reason: expect.stringContaining("command/round identity"),
    });
    expect(store.openReviewFailure(pr)?.work_owed).toBe(1);
    expect(store.getSessionCommand(fixture.commandId)?.status).toBe("acked");
    expect(pump).not.toHaveBeenCalled();
  });

  it("refuses a second failed owner even under a malformed session name", async () => {
    const { store, dir, pr } = setup();
    const fixture = postingReceiptFailure(store, dir, pr);
    store.createSessionCommand({
      id: "legacy-failed",
      pr,
      session: "overseer",
      kind: "wake",
      round_no: null,
      payload_sha256: "hash",
      payload_path: join(dir, "legacy.payload"),
      inject_path: join(dir, "legacy.inject"),
      next_check_at: T0,
    });
    store.failPendingSessionCommand("legacy-failed", "legacy owner failed");
    const pump = vi.fn(async () => {});

    const result = await recoverPrForOperator({ store, pump }, pr, "rerun-round");

    expect(result).toMatchObject({ ok: false, reason: expect.stringContaining("legacy-failed") });
    expect(store.openReviewFailure(pr)?.incident_id).toBe(fixture.failure.incident_id);
    expect(store.getSessionCommand(fixture.commandId)?.status).toBe("acked");
    expect(pump).not.toHaveBeenCalled();
  });

  it("ignores obsolete failed commands whose rounds are already terminal", async () => {
    const { store, dir, pr } = setup();
    const fixture = postingReceiptFailure(store, dir, pr);
    store.setPrState(pr, "reviewing");
    const obsoleteRoundId = store.startRound(pr, "re-review", [], 75);
    const obsoleteRoundNo = store
      .roundsFor(pr)
      .find((round) => round.id === obsoleteRoundId)!.round_no;
    store.createSessionCommand({
      id: "obsolete-round-command",
      pr,
      session: `pr-${pr}`,
      kind: "round",
      round_no: obsoleteRoundNo,
      payload_sha256: "hash",
      payload_path: join(dir, "obsolete.payload"),
      inject_path: join(dir, "obsolete.inject"),
      next_check_at: T0,
    });
    store.failPendingSessionCommand("obsolete-round-command", "old failed attempt");
    store.markRoundCancelled(obsoleteRoundId, "old terminal attempt", "infrastructure_failure");
    store.setPrState(pr, "queued");
    const pump = vi.fn(async () => {});

    const result = await recoverPrForOperator({ store, pump }, pr, "rerun-round");

    expect(result).toMatchObject({ ok: true, exact_head_retired: true });
    expect(store.getSessionCommand(fixture.commandId)?.status).toBe("acked");
    expect(store.getSessionCommand("obsolete-round-command")?.status).toBe("failed");
  });

  it("is transactionally idempotent for the same captured incident", () => {
    const { store, dir, pr } = setup();
    const fixture = postingReceiptFailure(store, dir, pr);
    const input = {
      pr,
      incident_id: fixture.failure.incident_id,
      command_id: fixture.commandId,
      round_id: fixture.roundId,
      round_no: fixture.roundNo,
      head_sha: fixture.head,
    };

    expect(store.resolveExactHeadReviewedFailure(input)).toMatchObject({
      kind: "resolved",
      already_resolved: false,
    });
    // Idempotence is a historical exact-identity receipt: later evidence does
    // not rewrite the already-committed result or emit a second event.
    store.noteAuthorReply(pr, T0);
    store.upsertPr({
      number: pr,
      state: "queued",
      head_sha: "b".repeat(40),
      title: `PR ${pr}`,
      author: "alice",
      trigger_ts: T0,
      trigger_provenance: "human",
      stale_recheck: 0,
      migration_gate: 0,
    });
    expect(store.resolveExactHeadReviewedFailure(input)).toMatchObject({
      kind: "resolved",
      already_resolved: true,
    });
    expect(store.getPr(pr)).toMatchObject({
      head_sha: "b".repeat(40),
      trigger_provenance: "human",
    });
    expect(
      store
        .eventsOn("2026-08-31")
        .filter((row) => row.kind === "exact_head_review_failure_retired"),
    ).toHaveLength(1);
  });

  it("preserves a fresh human retrigger through ordinary recovery", async () => {
    const { store, dir, pr } = setup();
    postingReceiptFailure(store, dir, pr);
    const humanTs = "2026-08-31T08:05:00.000Z";
    store.db
      .prepare("UPDATE pr_state SET trigger_ts=?, trigger_provenance='human' WHERE number=?")
      .run(humanTs, pr);
    const pump = vi.fn(async () => {});

    const result = await recoverPrForOperator({ store, pump }, pr, "rerun-round");

    expect(result).toMatchObject({ ok: false, redispatched: false });
    expect(result).not.toHaveProperty("exact_head_retired");
    expect(store.getPr(pr)).toMatchObject({
      state: "queued",
      trigger_ts: humanTs,
      trigger_provenance: "human",
    });
    expect(store.openReviewFailure(pr)).toBeUndefined();
    expect(pump).toHaveBeenCalledOnce();
  });

  it("preserves a held wake by falling through to ordinary recovery", async () => {
    const { store, dir, pr } = setup();
    postingReceiptFailure(store, dir, pr);
    store.holdWake(pr, "author reply", "author_reply");
    const pump = vi.fn(async () => {});

    const result = await recoverPrForOperator({ store, pump }, pr, "rerun-round");

    expect(result).toMatchObject({ ok: false, redispatched: false });
    expect(result).not.toHaveProperty("exact_head_retired");
    expect(store.heldWakes(pr).map((wake) => wake.payload)).toEqual(["author reply"]);
    expect(pump).toHaveBeenCalledOnce();
  });

  it("promotes successor work instead of retiring it as already reviewed", async () => {
    const { store, dir, pr } = setup();
    const fixture = postingReceiptFailure(store, dir, pr);
    store.recordSuccessor({
      pr,
      predecessor_round_id: fixture.roundId,
      head_sha: "b".repeat(40),
      provenance: "system",
      reason: "push",
    });
    const pump = vi.fn(async () => {
      expect(store.getPr(pr)?.head_sha).toBe("b".repeat(40));
      store.setPrState(pr, "reviewing");
      store.startRound(pr, "re-review", ["pass-baseline"], 75);
      return;
    });

    const result = await recoverPrForOperator({ store, pump }, pr, "rerun-round");

    expect(result).toMatchObject({ ok: true, redispatched: true });
    expect(result).not.toHaveProperty("exact_head_retired");
    expect(store.successorFor(pr)?.head_sha).toBe("b".repeat(40));
  });

  it("keeps the ordinary recovery path when an author reply is new evidence", async () => {
    const { store, dir, pr } = setup();
    postingReceiptFailure(store, dir, pr, true);
    const pump = vi.fn(async () => {
      store.setPrState(pr, "reviewing");
      store.startRound(pr, "re-review", ["pass-baseline"], 75);
      return;
    });

    const result = await recoverPrForOperator({ store, pump }, pr, "rerun-round");

    expect(result).toMatchObject({ ok: true, redispatched: true });
    expect(result).not.toHaveProperty("exact_head_retired");
    expect(pump).toHaveBeenCalledOnce();
  });

  it("does not call a mere pump invocation success when the PR stays queued", async () => {
    const { store, pr } = setup();

    const result = await recoverPrForOperator({ store, pump: async () => {} }, pr, "rerun-round");

    expect(result).toMatchObject({ ok: false, redispatched: false });
    expect(result.reason).toContain("no running round");
  });

  it("does not infer redispatch from reviewing state without a running round", async () => {
    const { store, pr } = setup();

    const result = await recoverPrForOperator(
      {
        store,
        pump: async () => {
          store.setPrState(pr, "reviewing");
          return;
        },
      },
      pr,
      "rerun-round",
    );

    expect(result).toMatchObject({ ok: false, redispatched: false, no_op_state: "reviewing" });
    expect(result.reason).toContain("no running round");
  });

  it("refuses a non-UTF8 command payload instead of changing its bytes", async () => {
    const { store, dir, pr } = setup();
    const c = command(store, dir, pr, "wake");
    const bytes = Buffer.from([0xff, 0xfe, 0xfd]);
    writeFileSync(c.payloadPath, bytes);
    store.db
      .prepare("UPDATE session_commands SET payload_sha256=? WHERE id=?")
      .run(createHash("sha256").update(bytes).digest("hex"), c.row.id);

    const result = await recoverPrForOperator(
      {
        store,
        pump: async () => {},
        killSession: async () => {},
      },
      pr,
      "restart-session",
    );

    expect(result).toMatchObject({ ok: false });
    expect(result.reason).toContain("not UTF-8");
    expect(store.blockingSessionCommand(`pr-${pr}`)?.id).toBe(c.row.id);
  });
});
