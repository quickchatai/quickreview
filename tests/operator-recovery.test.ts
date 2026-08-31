import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { recoverPrForOperator } from "../src/operator-recovery.js";
import { StateStore } from "../src/state.js";

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
  it("refuses rerun-round while durable session ownership still blocks dispatch", async () => {
    const { store, dir, pr } = setup();
    command(store, dir, pr);
    const pump = vi.fn(async () => []);

    const result = await recoverPrForOperator({ store, pump }, pr, "rerun-round");

    expect(result).toMatchObject({ ok: false, blocking_command: "cmd-round" });
    expect(result.reason).toContain("restart-session");
    expect(pump).not.toHaveBeenCalled();
    expect(store.blockingSessionCommand(`pr-${pr}`)?.id).toBe("cmd-round");
  });

  it("restart-session fences the old consumer, clears its round command, and proves redispatch", async () => {
    const { store, dir, pr } = setup();
    const c = command(store, dir, pr);
    const killSession = vi.fn(async () => {});
    const pump = vi.fn(async () => {
      store.setPrState(pr, "reviewing");
      store.startRound(pr, "re-review", ["pass-baseline"], 75);
      return [];
    });

    const result = await recoverPrForOperator({ store, pump, killSession }, pr, "restart-session");

    expect(killSession).toHaveBeenCalledWith(pr);
    expect(readFileSync(c.payloadPath, "utf8")).toBe(c.payload); // immutable evidence stays
    expect(() => readFileSync(c.injectPath)).toThrow(); // stale delivery cannot rebirth
    expect(store.getSessionCommand(c.row.id)?.status).toBe("cancelled");
    expect(store.blockingSessionCommand(`pr-${pr}`)).toBeUndefined();
    expect(result).toMatchObject({ ok: true, redispatched: true, cancelled_session_commands: [c.row.id] });
  });

  it("restores a cancelled wake ahead of dispatch and reports that no round started", async () => {
    const { store, dir, pr } = setup(5454);
    const c = command(store, dir, pr, "wake", "zażółć 🧭\0\n");
    const pump = vi.fn(async () => {
      expect(store.heldWakes(pr).map((wake) => wake.payload)).toEqual([c.payload]);
      return [];
    });

    const result = await recoverPrForOperator({ store, pump, killSession: async () => {} }, pr, "restart-session");

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
    const pump = vi.fn(async () => []);

    await expect(recoverPrForOperator({
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
    }, pr, "restart-session")).rejects.toThrow(/blocker set changed/);

    expect(pump).not.toHaveBeenCalled();
    expect(store.getSessionCommand("cmd-successor")?.status).toBe("pending");
    expect(readFileSync(successorInjectPath, "utf8")).toBe(successorPayload);
    expect(() => readFileSync(old.injectPath)).toThrow(); // the acked predecessor must not re-enter *.md delivery
  });

  it("never reopens a PR that closes while its old session is being fenced", async () => {
    const { store, dir, pr } = setup();
    command(store, dir, pr, "round");
    const pump = vi.fn(async () => []);

    const result = await recoverPrForOperator({
      store,
      pump,
      killSession: async () => { store.setPrState(pr, "closed"); },
    }, pr, "restart-session");

    expect(result).toMatchObject({ ok: false, redispatched: false, no_op_state: "closed" });
    expect(store.getPr(pr)?.state).toBe("closed");
  });

  it("changes nothing when the old session cannot be fenced", async () => {
    const { store, dir, pr } = setup();
    const c = command(store, dir, pr, "wake");
    const pump = vi.fn(async () => []);

    await expect(recoverPrForOperator({
      store,
      pump,
      killSession: async () => { throw new Error("tmux survived"); },
    }, pr, "restart-session")).rejects.toThrow(/tmux survived/);

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
    const pump = vi.fn(async () => []);

    const result = await recoverPrForOperator({ store, pump, killSession }, pr, "restart-session");

    expect(result).toMatchObject({ ok: false });
    expect(result.reason).toContain("payload hash");
    expect(killSession).not.toHaveBeenCalled();
    expect(pump).not.toHaveBeenCalled();
    expect(store.blockingSessionCommand(`pr-${pr}`)?.id).toBe(c.row.id);
  });

  it("does not call a mere pump invocation success when the PR stays queued", async () => {
    const { store, pr } = setup();

    const result = await recoverPrForOperator({ store, pump: async () => [] }, pr, "rerun-round");

    expect(result).toMatchObject({ ok: false, redispatched: false });
    expect(result.reason).toContain("no running round");
  });

  it("does not infer redispatch from reviewing state without a running round", async () => {
    const { store, pr } = setup();

    const result = await recoverPrForOperator({
      store,
      pump: async () => {
        store.setPrState(pr, "reviewing");
        return [];
      },
    }, pr, "rerun-round");

    expect(result).toMatchObject({ ok: false, redispatched: false, no_op_state: "reviewing" });
    expect(result.reason).toContain("no running round");
  });

  it("refuses a non-UTF8 command payload instead of changing its bytes", async () => {
    const { store, dir, pr } = setup();
    const c = command(store, dir, pr, "wake");
    const bytes = Buffer.from([0xff, 0xfe, 0xfd]);
    writeFileSync(c.payloadPath, bytes);
    store.db.prepare("UPDATE session_commands SET payload_sha256=? WHERE id=?")
      .run(createHash("sha256").update(bytes).digest("hex"), c.row.id);

    const result = await recoverPrForOperator({
      store,
      pump: async () => [],
      killSession: async () => {},
    }, pr, "restart-session");

    expect(result).toMatchObject({ ok: false });
    expect(result.reason).toContain("not UTF-8");
    expect(store.blockingSessionCommand(`pr-${pr}`)?.id).toBe(c.row.id);
  });
});
