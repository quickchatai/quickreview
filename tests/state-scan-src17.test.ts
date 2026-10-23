// State-store defects found by the self-scan (unit src-17): each test pins one
// durable-state contract.
import Database from "better-sqlite3";
import { createHash } from "node:crypto";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { applyEvent } from "../src/statemachine.js";
import { StateStore } from "../src/state.js";
import {
  parseRecheckPromptMarker,
  recheckPromptMarker,
} from "@quickchatai/pi-quickreview/src/types.js";

const T0 = "2026-10-22T08:00:00.000Z";
const stores: StateStore[] = [];
const dirs: string[] = [];

afterEach(() => {
  for (const s of stores.splice(0)) s.close();
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

function memStore(): StateStore {
  const s = new StateStore(":memory:", () => new Date(T0));
  stores.push(s);
  return s;
}

const prRow = (number: number, over: Partial<Parameters<StateStore["upsertPr"]>[0]> = {}) => ({
  number,
  state: "tracked" as const,
  head_sha: "a".repeat(40),
  title: `PR ${number}`,
  author: "alice",
  trigger_ts: null,
  stale_recheck: 0,
  migration_gate: 0,
  ...over,
});

function makeCommand(
  store: StateStore,
  dir: string,
  pr: number,
  id: string,
  kind: "round" | "wake",
  payload: string,
) {
  const payloadPath = join(dir, `${id}.payload.md`);
  const injectPath = join(dir, `${id}.inject.md`);
  writeFileSync(payloadPath, payload);
  writeFileSync(injectPath, payload);
  return store.createSessionCommand({
    id,
    pr,
    session: `pr-${pr}`,
    kind,
    round_no: kind === "round" ? 1 : null,
    payload_sha256: createHash("sha256").update(payload).digest("hex"),
    payload_path: payloadPath,
    inject_path: injectPath,
    next_check_at: T0,
  });
}

describe("session_commands cancelled-status rebuild", () => {
  it("keeps the worker's usage report when it rebuilds a table with the old CHECK", () => {
    const dir = mkdtempSync(join(tmpdir(), "qcr-src17-"));
    dirs.push(dir);
    const path = join(dir, "state.db");
    const first = new StateStore(path, () => new Date(T0));
    first.upsertPr(prRow(7, { state: "reviewing" }));
    makeCommand(first, dir, 7, "cmd-u", "wake", "hello");
    first.recordCommandUsage("cmd-u", { est_usd: 0.7, lens_usd: 0.3, final: true });
    first.close();

    // Put the table back into its pre-cancellation shape (CHECK without 'cancelled').
    const raw = new Database(path);
    const sql = (
      raw.prepare("SELECT sql FROM sqlite_master WHERE name='session_commands'").get() as {
        sql: string;
      }
    ).sql;
    expect(sql).toContain("'cancelled'");
    raw.exec("ALTER TABLE session_commands RENAME TO sc_new");
    raw.exec(sql.replace(", 'cancelled'", ""));
    raw.exec("INSERT INTO session_commands SELECT * FROM sc_new");
    raw.exec("DROP TABLE sc_new");
    raw.close();

    const second = new StateStore(path, () => new Date(T0));
    stores.push(second);
    expect(second.getSessionCommand("cmd-u")).toMatchObject({
      est_usd: 0.7,
      lens_usd: 0.3,
      usage_final: 1,
    });
  });
});

describe("botCommentIds", () => {
  it("answers review-comment ids only, never an issue comment that shares the number", () => {
    const store = memStore();
    store.registerBotComment(9100, 5, "issue_comment");
    store.registerBotComment(9200, 5, "review_comment");
    expect([...store.botCommentIds(5)]).toEqual([9200]);
  });
});

describe("recordCommandUsage", () => {
  it("does not close the report when the round re-statement fails", () => {
    const store = memStore();
    const dir = mkdtempSync(join(tmpdir(), "qcr-src17-"));
    dirs.push(dir);
    store.upsertPr(prRow(8, { state: "reviewing" }));
    makeCommand(store, dir, 8, "cmd-r", "round", "order");
    const spy = vi
      .spyOn(store as unknown as { restateMeasuredRoundUsd: () => void }, "restateMeasuredRoundUsd")
      .mockImplementation(() => {
        throw new Error("crash between the two writes");
      });
    expect(() =>
      store.recordCommandUsage("cmd-r", { est_usd: 1, lens_usd: 0, final: true }),
    ).toThrow();
    spy.mockRestore();
    // Both writes or neither: the report stays open so its replay can finish the job.
    expect(store.getSessionCommand("cmd-r")?.usage_final).toBe(0);
  });
});

describe("openReviewFailure and a queued human request", () => {
  it("keeps a queued human trigger's timestamp and provenance", () => {
    const store = memStore();
    const dir = mkdtempSync(join(tmpdir(), "qcr-src17-"));
    dirs.push(dir);
    const asked = "2026-10-22T07:00:00.000Z";
    store.upsertPr(prRow(9, { state: "queued", trigger_ts: asked, trigger_provenance: "human" }));
    makeCommand(store, dir, 9, "cmd-w", "wake", "reply");
    store.failPendingSessionCommand("cmd-w", "boom");
    store.openReviewFailure({
      pr: 9,
      command_id: "cmd-w",
      round_id: null,
      round_no: null,
      head_sha: "a".repeat(40),
      stage: "session_command",
      detail: "boom",
      attempts: 1,
      retry_cap: 1,
    });
    expect(store.getPr(9)).toMatchObject({
      state: "queued",
      trigger_ts: asked,
      trigger_provenance: "human",
    });
  });
});

describe("operator recovery of a recheck wake", () => {
  it("keeps the recheck's classification so a pause still defers it", () => {
    const store = memStore();
    const dir = mkdtempSync(join(tmpdir(), "qcr-src17-"));
    dirs.push(dir);
    store.upsertPr(prRow(10, { state: "tracked" }));
    const payload = `Re-check the delta.\n\n${recheckPromptMarker(10, "fp1")}\n`;
    expect(parseRecheckPromptMarker(payload)).not.toBeNull();
    makeCommand(store, dir, 10, "cmd-rc", "wake", payload);
    store.cancelBlockingSessionCommandsForOperator(
      10,
      [{ id: "cmd-rc", payload }],
      "restart-session",
      ["cmd-rc"],
    );
    expect(store.heldWakes(10)).toHaveLength(1);
    // The paused PR's flush passes over recheck nudges.
    expect(store.heldWakes(10, "recheck:")).toHaveLength(0);
  });
});

describe("closing a queued PR", () => {
  it("retires its trigger so a reopened PR is not queued on the old timestamp", () => {
    const store = memStore();
    store.upsertPr(
      prRow(11, {
        state: "queued",
        trigger_ts: "2026-10-01T00:00:00.000Z",
        trigger_provenance: "human",
      }),
    );
    applyEvent(store, 11, { type: "closed" });
    expect(store.getPr(11)).toMatchObject({
      state: "closed",
      trigger_ts: null,
      trigger_provenance: null,
    });
  });
});
