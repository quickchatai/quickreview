import { describe, expect, it } from "vitest";
import { StateStore, type PrLifecycleState } from "../src/state.js";
import { applyEvent, isBotAuthor, transition, type SmEvent } from "../src/statemachine.js";

const STATES: PrLifecycleState[] = ["tracked", "queued", "reviewing", "awaiting_author", "awaiting_human", "closed"];

// The transition table from src/statemachine.ts, transcribed independently:
// rows are events, columns follow STATES order.
const TABLE: Array<[SmEvent, PrLifecycleState[]]> = [
  [{ type: "track" }, ["tracked", "queued", "reviewing", "awaiting_author", "awaiting_human", "closed"]],
  [{ type: "trigger", source: "label" }, ["queued", "queued", "reviewing", "queued", "queued", "closed"]],
  [{ type: "stale_detected" }, ["queued", "queued", "reviewing", "queued", "queued", "closed"]],
  [{ type: "dispatched" }, ["reviewing", "reviewing", "reviewing", "reviewing", "reviewing", "closed"]],
  [
    { type: "verdict", verdict: "APPROVE" },
    ["tracked", "tracked", "tracked", "tracked", "tracked", "closed"],
  ],
  [
    { type: "verdict", verdict: "REQUEST_CHANGES" },
    ["awaiting_author", "awaiting_author", "awaiting_author", "awaiting_author", "awaiting_author", "closed"],
  ],
  [
    { type: "verdict", verdict: "NEEDS_HUMAN" },
    // Legacy input only (retired 2026-08-19): review posted, no approval, no park.
    ["tracked", "tracked", "tracked", "tracked", "tracked", "closed"],
  ],
  [
    { type: "round_overdue" },
    // No standing verdict on the event ⇒ tracked everywhere (no park, never an approve).
    ["tracked", "tracked", "tracked", "tracked", "tracked", "closed"],
  ],
  [{ type: "author_reply" }, ["tracked", "queued", "reviewing", "awaiting_author", "awaiting_human", "closed"]],
  [{ type: "synchronize" }, ["tracked", "queued", "reviewing", "awaiting_author", "awaiting_human", "closed"]],
  [
    { type: "human_requested" },
    // Noted, never a handover (2026-08-19): the AI keeps working.
    ["tracked", "queued", "reviewing", "awaiting_author", "awaiting_human", "closed"],
  ],
  [{ type: "closed" }, ["closed", "closed", "closed", "closed", "closed", "closed"]],
  [{ type: "reopened" }, ["tracked", "queued", "reviewing", "awaiting_author", "awaiting_human", "tracked"]],
];

describe("transition table", () => {
  for (const [event, expected] of TABLE) {
    const label = event.type === "verdict" ? `verdict:${event.verdict}` : event.type;
    STATES.forEach((state, i) => {
      it(`${state} + ${label} → ${expected[i]}`, () => {
        expect(transition(state, event)).toBe(expected[i]);
      });
    });
  }
});

describe("invariants", () => {
  it("closed is terminal except for reopened", () => {
    for (const [event] of TABLE) {
      if (event.type === "reopened") continue;
      expect(transition("closed", event)).toBe("closed");
    }
  });

  it("a verdict drains a legacy awaiting_human row into normal flow (park retired 2026-08-19)", () => {
    expect(transition("awaiting_human", { type: "verdict", verdict: "APPROVE" })).toBe("tracked");
    expect(transition("awaiting_human", { type: "verdict", verdict: "REQUEST_CHANGES" })).toBe("awaiting_author");
  });

  it("nothing transitions INTO awaiting_human any more", () => {
    const events: SmEvent[] = [
      { type: "track" },
      { type: "trigger", source: "label" },
      { type: "stale_detected" },
      { type: "dispatched" },
      { type: "verdict", verdict: "APPROVE" },
      { type: "verdict", verdict: "REQUEST_CHANGES" },
      { type: "verdict", verdict: "NEEDS_HUMAN" },
      { type: "round_overdue" },
      { type: "round_overdue", standing: "REQUEST_CHANGES" },
      { type: "author_reply" },
      { type: "synchronize" },
      { type: "human_requested" },
      { type: "closed" },
      { type: "reopened" },
    ];
    for (const state of STATES.filter((st) => st !== "awaiting_human")) {
      for (const event of events) {
        expect(transition(state, event), `${state} + ${event.type}`).not.toBe("awaiting_human");
      }
    }
  });

  it("an overdue round returns to the standing-verdict state and can never land on an approve state", () => {
    for (const state of STATES) {
      expect(["tracked", "closed"]).toContain(transition(state, { type: "round_overdue" }));
      expect(["awaiting_author", "closed"]).toContain(transition(state, { type: "round_overdue", standing: "REQUEST_CHANGES" }));
    }
    // "tracked" after APPROVE-standing means "no work owed" — the approval was
    // already posted by the earlier round, never by this event.
    expect(transition("reviewing", { type: "round_overdue", standing: "APPROVE" })).toBe("tracked");
  });

  it("a push never queues a review, even when changes were previously requested", () => {
    expect(transition("awaiting_author", { type: "synchronize" })).toBe("awaiting_author");
    expect(transition("tracked", { type: "synchronize" })).toBe("tracked");
  });
});

describe("isBotAuthor", () => {
  it("matches the configured bot and any [bot] suffix", () => {
    expect(isBotAuthor("example-review[bot]", "example-review[bot]")).toBe(true);
    expect(isBotAuthor("dependabot[bot]", "example-review[bot]")).toBe(true);
    expect(isBotAuthor("mhale", "example-review[bot]")).toBe(false);
  });
});

describe("applyEvent", () => {
  const open = () => new StateStore(":memory:");

  it("adopts an unknown PR at the first trigger and stamps trigger_ts", () => {
    const store = open();
    const res = applyEvent(store, 7, { type: "trigger", source: "label" }, { title: "t", head_sha: "abc", author: "alice" }, {
      botLogin: "example-review[bot]",
    });
    expect(res.to).toBe("queued");
    const row = store.getPr(7)!;
    expect(row.state).toBe("queued");
    expect(row.trigger_ts).toBeTruthy();
    expect(row.author).toBe("alice");
    store.close();
  });

  it("never tracks a bot-authored PR", () => {
    const store = open();
    const res = applyEvent(store, 8, { type: "trigger", source: "label" }, { author: "example-review[bot]" }, {
      botLogin: "example-review[bot]",
    });
    expect(res.skipped).toBe("bot-author");
    expect(store.getPr(8)).toBeUndefined();
    store.close();
  });

  it("sets stale_recheck on staleness and clears it at dispatch", () => {
    const store = open();
    applyEvent(store, 9, { type: "trigger", source: "label" }, { author: "alice" }, {});
    applyEvent(store, 9, { type: "stale_detected" }, {}, {});
    expect(store.getPr(9)!.stale_recheck).toBe(1);
    applyEvent(store, 9, { type: "dispatched" }, {}, {});
    const row = store.getPr(9)!;
    expect(row.stale_recheck).toBe(0);
    expect(row.state).toBe("reviewing");
    expect(row.trigger_ts).toBeNull();
    store.close();
  });

  it("clears stale_recheck and trigger_ts when a round settles — no residue", () => {
    const store = open();
    // A staleness trigger that never dispatched (the round it queued for was
    // settled by another path) must not survive as residue on tracked.
    applyEvent(store, 11, { type: "trigger", source: "label" }, { author: "alice" }, {});
    applyEvent(store, 11, { type: "stale_detected" }, {}, {});
    expect(store.getPr(11)!.stale_recheck).toBe(1);
    applyEvent(store, 11, { type: "verdict", verdict: "APPROVE" }, {}, {});
    let row = store.getPr(11)!;
    expect(row.state).toBe("tracked");
    expect(row.stale_recheck).toBe(0);
    expect(row.trigger_ts).toBeNull();

    applyEvent(store, 11, { type: "stale_detected" }, {}, {});
    applyEvent(store, 11, { type: "round_overdue", standing: "REQUEST_CHANGES" }, {}, {});
    row = store.getPr(11)!;
    expect(row.state).toBe("awaiting_author");
    expect(row.stale_recheck).toBe(0);
    expect(row.trigger_ts).toBeNull();
    store.close();
  });

  it("logs every state change as pr_transition", () => {
    const store = open();
    applyEvent(store, 10, { type: "trigger", source: "label" }, { author: "alice" }, {});
    applyEvent(store, 10, { type: "dispatched" }, {}, {});
    applyEvent(store, 10, { type: "verdict", verdict: "REQUEST_CHANGES" }, {}, {});
    const kinds = (store.db.prepare("SELECT kind FROM events WHERE pr = 10").all() as Array<{ kind: string }>).map((e) => e.kind);
    expect(kinds.filter((k) => k === "pr_transition").length).toBe(3);
    expect(store.getPr(10)!.state).toBe("awaiting_author");
    store.close();
  });
});

describe("trigger provenance", () => {
  const open = () => new StateStore(":memory:");

  it.each([
    [{ type: "trigger", source: "label" } as SmEvent, "human"],
    [{ type: "trigger", source: "team_request" } as SmEvent, "human"],
    [{ type: "trigger", source: "manual" } as SmEvent, "human"],
    [{ type: "trigger", source: "reconcile" } as SmEvent, "system"],
    [{ type: "stale_detected" } as SmEvent, "system"],
  ])("%o queues with provenance %s", (event, provenance) => {
    const store = open();
    applyEvent(store, 20, event, { author: "alice" }, {});
    const row = store.getPr(20)!;
    expect(row.state).toBe("queued");
    expect(row.trigger_provenance).toBe(provenance);
    store.close();
  });

  it("a system re-trigger never downgrades a queued human ask", () => {
    const store = open();
    applyEvent(store, 21, { type: "trigger", source: "label" }, { author: "alice" }, {});
    applyEvent(store, 21, { type: "trigger", source: "reconcile" }, {}, {});
    expect(store.getPr(21)!.trigger_provenance).toBe("human");
    store.close();
  });

  it("a fresh human ask upgrades a system-queued PR", () => {
    const store = open();
    applyEvent(store, 22, { type: "trigger", source: "reconcile" }, { author: "alice" }, {});
    expect(store.getPr(22)!.trigger_provenance).toBe("system");
    applyEvent(store, 22, { type: "trigger", source: "team_request" }, {}, {});
    expect(store.getPr(22)!.trigger_provenance).toBe("human");
    store.close();
  });

  it("an author reply while queued makes the pending round a human ask", () => {
    const store = open();
    applyEvent(store, 23, { type: "trigger", source: "reconcile" }, { author: "alice" }, {});
    applyEvent(store, 23, { type: "author_reply" }, {}, {});
    expect(store.getPr(23)!.trigger_provenance).toBe("human");
    store.close();
  });

  it("dispatch clears provenance with the trigger", () => {
    const store = open();
    applyEvent(store, 24, { type: "trigger", source: "label" }, { author: "alice" }, {});
    applyEvent(store, 24, { type: "dispatched" }, {}, {});
    expect(store.getPr(24)!.trigger_provenance).toBeNull();
    store.close();
  });

  it("a fresh system trigger after the queue drained is system again — human never lingers", () => {
    const store = open();
    applyEvent(store, 25, { type: "trigger", source: "label" }, { author: "alice" }, {});
    applyEvent(store, 25, { type: "dispatched" }, {}, {});
    applyEvent(store, 25, { type: "verdict", verdict: "APPROVE" }, {}, {});
    applyEvent(store, 25, { type: "trigger", source: "reconcile" }, {}, {});
    expect(store.getPr(25)!.trigger_provenance).toBe("system");
    store.close();
  });
});
