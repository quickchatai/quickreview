import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { resolveTerminalFailure } from "../src/terminal-failure.js";
import { StateStore } from "../src/state.js";

const NOW = new Date("2026-09-01T13:40:00.000Z");
let store: StateStore;

beforeEach(() => {
  store = new StateStore(":memory:", () => NOW);
});
afterEach(() => store.close());

function seed(pr: number, head: string, local: "closed" | "absent" = "closed") {
  if (local === "closed") {
    store.upsertPr({
      number: pr,
      state: "closed",
      head_sha: head,
      title: `PR ${pr}`,
      author: "alice",
      trigger_ts: null,
      stale_recheck: 0,
      migration_gate: 0,
    });
  }
  const commandId = `cmd-${pr}`;
  store.createSessionCommand({
    id: commandId,
    pr,
    session: `pr-${pr}`,
    kind: "wake",
    round_no: null,
    payload_sha256: "hash",
    payload_path: `/payload/${commandId}.md`,
    inject_path: `/inject/${commandId}.md`,
    next_check_at: NOW.toISOString(),
  });
  store.failPendingSessionCommand(commandId, "exhausted");
  store.openReviewFailure({
    pr,
    command_id: commandId,
    head_sha: head,
    stage: "session_command",
    detail: "exhausted",
    attempts: 2,
    retry_cap: 2,
  });
  return { pr, incident_id: `review-failure:${commandId}`, command_id: commandId, head_sha: head };
}

describe("resolveTerminalFailure — authoritative terminal debt cleanup", () => {
  it("resolves exact closed and absent debt without a GitHub mutation surface", async () => {
    const closed = seed(5408, "closed-head");
    const absent = seed(999902, "", "absent");
    const getPrDisposition = vi.fn(async (pr: number) =>
      pr === 5408
        ? { kind: "closed" as const, head_sha: "closed-head" }
        : { kind: "absent" as const },
    );

    expect(await resolveTerminalFailure({ store, getPrDisposition }, closed)).toMatchObject({
      ok: true,
      disposition: "closed",
      command_id: "cmd-5408",
    });
    expect(await resolveTerminalFailure({ store, getPrDisposition }, absent)).toMatchObject({
      ok: true,
      disposition: "absent",
      command_id: "cmd-999902",
    });
    expect(getPrDisposition).toHaveBeenCalledTimes(2);
  });

  it("refuses open PRs, head drift and ambiguous read failures without changing debt", async () => {
    const input = seed(5408, "expected-head");

    expect(
      await resolveTerminalFailure(
        {
          store,
          getPrDisposition: async () => ({ kind: "open", head_sha: "expected-head" }),
        },
        input,
      ),
    ).toMatchObject({ ok: false, reason: expect.stringContaining("still open") });
    expect(
      await resolveTerminalFailure(
        {
          store,
          getPrDisposition: async () => ({ kind: "closed", head_sha: "different-head" }),
        },
        input,
      ),
    ).toMatchObject({ ok: false, reason: expect.stringContaining("head") });
    expect(
      await resolveTerminalFailure(
        {
          store,
          getPrDisposition: async () => {
            throw new Error("GET pull → 403");
          },
        },
        input,
      ),
    ).toMatchObject({ ok: false, reason: expect.stringContaining("403") });

    expect(store.openReviewFailure(5408)?.work_owed).toBe(1);
    expect(store.getSessionCommand("cmd-5408")?.status).toBe("failed");
  });
});
