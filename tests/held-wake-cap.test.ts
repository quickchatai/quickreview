// The held-wake cap (`MAX_HELD_WAKES`, 5) never evicts an author reply.
//
// An author reply's comment is claimed before its wake is held
// (`claimAuthorMessage`), and nothing raises a claimed comment again — the
// webhook is one-shot and the reconcile comment sweep only captures — so an
// evicted reply would never be answered.
//
// The policy pinned here:
//   - author replies are outside the cap: never evicted, never counted;
//   - what the cap evicts goes PUSH recheck nudges first (oldest first) — the
//     one class a sweep re-raises — then every other ordinary wake, oldest
//     first, a ci or base-advance recheck among them (only the push recheck
//     has a reconcile backstop);
//   - every evicted recheck nudge releases its claim (an eviction is a
//     provable non-delivery): the reconcile backstop asks a push question again; a ci
//     or base-advance one waits for an identical webhook, and its eviction
//     records the quiet `recheck_wake_dropped`;
//   - a backlog of author replies is delivered in chunks, never one unbounded
//     prompt;
//   - a dropped author reply, should the store ever produce one, is loud.
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { anomalySeverity } from "../src/anomalies.js";
import { parseConfig, type Config } from "../src/config.js";
import type { PrRef } from "../src/github.js";
import { recheckFingerprint } from "../src/recheck.js";
import { reconcileOnce, type ReconcileAdapter } from "../src/reconcile.js";
import { MAX_HELD_WAKES, StateStore } from "../src/state.js";
import { recheckPromptMarker, stampPrompt, type SessionHooks } from "../src/types.js";
import {
  AUTHOR_REPLY_DROPPED_KIND,
  MAX_AUTHOR_REPLIES_PER_DELIVERY,
  RECHECK_WAKE_DROPPED_KIND,
  flushHeldWakes,
  wakeOrHold,
} from "../src/wakes.js";

const cfg: Config = parseConfig(
  readFileSync(resolve(process.cwd(), "tests/fixtures/config.toml"), "utf8"),
);

const PR = 5849;
let store: StateStore;
let injected: string[];

const deps = () => ({
  store,
  inject: async (_pr: number, message: string) => {
    injected.push(message);
  },
});

function authorReply(comment: number): string {
  return `# Author reply — PR #${PR}\n\nWrite exactly one response file at \`verdict/pr-${PR}-thread-1-comment-${comment}.json\``;
}

/** A recheck nudge the way runRecheck sends one: claim first, then the
 * stamped wake. */
async function recheckNudge(trigger: "push" | "ci", head: string, ci?: string): Promise<string> {
  const req = { trigger, head_sha: head, ...(ci ? { ci: { conclusion: ci } } : {}) };
  const fingerprint = recheckFingerprint(req, head);
  expect(store.claimRecheck(PR, fingerprint, { head_sha: head, trigger })).toBe(true);
  await wakeOrHold(
    deps(),
    PR,
    stampPrompt(`recheck ${trigger} at ${head}`, recheckPromptMarker(PR, fingerprint)),
    `recheck:${trigger}`,
  );
  return fingerprint;
}

const heldReasons = (): string[] => store.heldWakes(PR).map((w) => w.reason);
const anomaliesOf = (kind: string) =>
  store
    .recentEvents(500)
    .filter((e) => e.kind === "anomaly")
    .map((e) => ({ pr: e.pr, ...JSON.parse(e.payload ?? "{}") }))
    .filter((a) => a.kind === kind);
const eventsOf = (kind: string) =>
  store
    .recentEvents(500)
    .filter((e) => e.kind === kind)
    .map((e) => JSON.parse(e.payload ?? "{}"));

beforeEach(() => {
  store = new StateStore(":memory:");
  injected = [];
  store.upsertPr({
    number: PR,
    state: "tracked",
    head_sha: "1111111111111111111111111111111111111111",
    title: "Message queue",
    author: "pr-author",
    trigger_ts: null,
    stale_recheck: 0,
    migration_gate: 0,
  });
  store.startRound(PR, "re-review", ["pass-baseline"], 75); // wakes hold
});

afterEach(() => {
  store.close();
  vi.restoreAllMocks();
});

describe("the held-wake cap", () => {
  it("never evicts an author reply, evicts push recheck nudges first, then the oldest other wake", async () => {
    for (let c = 1; c <= 6; c++) await wakeOrHold(deps(), PR, authorReply(c), "author_reply");
    expect(heldReasons()).toEqual(Array(6).fill("author_reply"));
    expect(eventsOf("wake_dropped")).toEqual([]); // six replies exceed MAX_HELD_WAKES; none dropped

    // Four nudges first, THEN the recheck: by age alone the oldest nudge would
    // be the one to go.
    for (let i = 1; i <= 4; i++) await wakeOrHold(deps(), PR, `ledger nudge ${i}`, "ledger_stale");
    const push = await recheckNudge("push", "1348bfa");
    // Ordinary wakes: four nudges + the recheck = the cap. Nothing went yet.
    expect(heldReasons().filter((r) => r !== "author_reply")).toHaveLength(MAX_HELD_WAKES);
    expect(eventsOf("wake_dropped")).toEqual([]);

    // One more ordinary wake: the RECHECK goes, though every nudge is older.
    await wakeOrHold(deps(), PR, "findings nudge", "findings_record_missing");
    expect(heldReasons()).not.toContain("recheck:push");
    expect(store.heldWakes(PR).map((w) => w.payload)).toContain("ledger nudge 1");
    expect(store.hasRecheck(PR, push)).toBe(false); // its claim released with it
    expect(eventsOf("recheck_claim_released_evicted")).toMatchObject([
      { reason: "recheck:push", fingerprint: push, re_raised_by: "reconcile_backstop" },
    ]);
    expect(anomaliesOf(RECHECK_WAKE_DROPPED_KIND)).toEqual([]); // the backstop has it
    expect(eventsOf("wake_dropped")).toMatchObject([
      { reason: "findings_record_missing", dropped_reasons: ["recheck:push"] },
    ]);

    // With no recheck left to give, the oldest other ordinary wake goes.
    await wakeOrHold(deps(), PR, "ledger nudge 5", "ledger_stale");
    const payloads = store.heldWakes(PR).map((w) => w.payload);
    expect(payloads).not.toContain("ledger nudge 1");
    expect(payloads).toContain("ledger nudge 2");

    // Every author reply is still there, in arrival order.
    expect(
      store
        .heldWakes(PR)
        .filter((w) => w.reason === "author_reply")
        .map((w) => w.payload),
    ).toEqual([1, 2, 3, 4, 5, 6].map(authorReply));
    for (const dropped of eventsOf("wake_dropped"))
      expect(dropped.dropped_reasons).not.toContain("author_reply");
  });

  it("a ci recheck has no backstop, so it gets no priority to go: the push recheck goes, then the oldest wake", async () => {
    for (let i = 1; i <= 3; i++) await wakeOrHold(deps(), PR, `nudge ${i}`, "ledger_stale");
    const ci = await recheckNudge("ci", "aaaaaaa", "failure");
    const push = await recheckNudge("push", "aaaaaaa");
    await wakeOrHold(deps(), PR, "nudge 4", "ledger_stale");
    // The push recheck goes first though the ci one is older.
    expect(store.hasRecheck(PR, push)).toBe(false);
    expect(store.hasRecheck(PR, ci)).toBe(true);
    expect(heldReasons().filter((r) => r.startsWith("recheck:"))).toEqual(["recheck:ci"]);

    // Then age order: the oldest ordinary wake goes, never the younger ci one.
    await wakeOrHold(deps(), PR, "nudge 5", "ledger_stale");
    const payloads = store.heldWakes(PR).map((w) => w.payload);
    expect(payloads).not.toContain("nudge 1");
    expect(heldReasons()).toContain("recheck:ci");
    expect(store.hasRecheck(PR, ci)).toBe(true);
  });

  it("an evicted ci recheck releases its claim and is recorded: nothing but an identical webhook asks it again", async () => {
    const ci = await recheckNudge("ci", "aaaaaaa", "failure"); // the oldest ordinary wake
    for (let i = 1; i <= MAX_HELD_WAKES; i++)
      await wakeOrHold(deps(), PR, `nudge ${i}`, "ledger_stale");

    expect(heldReasons()).not.toContain("recheck:ci");
    expect(store.hasRecheck(PR, ci)).toBe(false); // released: the same trigger may ask again
    expect(eventsOf("recheck_claim_released_evicted")).toMatchObject([
      { reason: "recheck:ci", fingerprint: ci, re_raised_by: null },
    ]);
    const [dropped] = anomaliesOf(RECHECK_WAKE_DROPPED_KIND);
    expect(dropped).toMatchObject({ pr: PR });
    expect(dropped.detail).toContain("recheck:ci");
    expect(dropped.detail).toContain("only an identical webhook");
    // Quiet grade: the daily heartbeat reads it; it wakes nobody.
    expect(anomalySeverity(RECHECK_WAKE_DROPPED_KIND)).toBe("quiet");
  });

  it("a backlog of author replies goes out in chunks, oldest first — never one unbounded prompt", async () => {
    const total = MAX_AUTHOR_REPLIES_PER_DELIVERY + 2;
    for (let c = 1; c <= total; c++) await wakeOrHold(deps(), PR, authorReply(c), "author_reply");
    store.db.prepare("UPDATE rounds SET status='done' WHERE pr=?").run(PR);

    expect(await flushHeldWakes(deps(), PR)).toBe(total);
    expect(injected).toHaveLength(2);
    expect(injected[0]).toContain(`(${MAX_AUTHOR_REPLIES_PER_DELIVERY} total)`);
    for (let c = 1; c <= MAX_AUTHOR_REPLIES_PER_DELIVERY; c++)
      expect(injected[0]).toContain(`comment-${c}.json`);
    expect(injected[1]).toContain(`comment-${total}.json`);
    expect(injected[1]).not.toContain(`comment-1.json`);
  });

  it("an author reply dropped by the store would be loud — a WAKE anomaly, never a silent row", async () => {
    // The store never selects one; this is the belt over that guarantee.
    vi.spyOn(store, "holdWakeEvicting").mockReturnValue([
      { id: 2472, reason: "author_reply", released_recheck: null, re_raised_by_reconcile: false },
    ]);
    await wakeOrHold(deps(), PR, "recheck", "recheck:push");
    const anomaly = store
      .recentEvents(50)
      .find(
        (e) =>
          e.kind === "anomaly" && JSON.parse(e.payload ?? "{}").kind === AUTHOR_REPLY_DROPPED_KIND,
      );
    expect(anomaly).toBeDefined();
    expect(JSON.parse(anomaly!.payload!).detail).toContain("2472:author_reply");
    expect(anomalySeverity(AUTHOR_REPLY_DROPPED_KIND)).toBe("wake");
  });
});

describe("an evicted recheck is asked again by the reconcile backstop (#5362 ④)", () => {
  const OLD = "2222222222222222222222222222222222222222";
  const NEW = "1111111111111111111111111111111111111111";

  const adapter = (): ReconcileAdapter => {
    const open: PrRef = {
      number: PR,
      title: "Message queue",
      author: "pr-author",
      head_sha: NEW,
      base_ref: "master",
      updated_at: "2026-10-08T08:05:52Z",
      state: "open",
      draft: false,
      merged: false,
      labels: [],
    };
    return {
      searchLabelTriggered: async () => [],
      searchTeamTriggered: async () => [],
      listOpenPrs: async () => [open],
      getPr: async () => open,
      listChecks: async () => [],
      listBotReviewComments: async () => [],
      getRequestedReviewers: async () => ({ users: [], teams: [] }),
    };
  };
  const hooks: SessionHooks = {
    async dispatchRound() {},
    async inject() {},
    async injectOverseer() {},
    async archiveAndClose() {},
  };

  it("claimed and held: silent; evicted: the claim is released and the next pass re-raises it", async () => {
    // The standing APPROVE at the old head; the author pushed.
    store.recordReviewedHead(PR, { head_sha: OLD, verdict: "APPROVE", round_no: 4 });
    store.upsertPr({ ...store.getPr(PR)!, head_sha: NEW });
    const push = await recheckNudge("push", NEW);
    expect(push).toBe(recheckFingerprint({ trigger: "push" }, NEW));

    const pushes: number[] = [];
    const pass = () =>
      reconcileOnce({
        cfg,
        store,
        adapter: adapter(),
        hooks,
        onHeadPush: async (pr) => {
          pushes.push(pr);
        },
      });
    await pass();
    expect(pushes).toEqual([]); // claimed: the held nudge owns the question

    // The cap evicts it (five ordinary wakes arrive behind it).
    for (let i = 1; i <= MAX_HELD_WAKES; i++)
      await wakeOrHold(deps(), PR, `nudge ${i}`, "ledger_stale");
    expect(heldReasons()).not.toContain("recheck:push");
    expect(store.hasRecheck(PR, push)).toBe(false);

    await pass();
    expect(pushes).toEqual([PR]); // asked again — never silently dropped
  });
});
