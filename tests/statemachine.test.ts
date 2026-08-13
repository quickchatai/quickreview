import { describe, expect, it } from "vitest";
import { StateStore, type PrLifecycleState } from "../src/state.js";
import { applyEvent, isBotAuthor, transition, type SmEvent } from "../src/statemachine.js";

const STATES: PrLifecycleState[] = ["tracked", "queued", "reviewing", "awaiting_author", "awaiting_human", "closed"];

// The transition table from src/statemachine.ts, transcribed independently:
// rows are events, columns follow STATES order.
const TABLE: Array<[SmEvent, PrLifecycleState[]]> = [
  [{ type: "track" }, ["tracked", "queued", "reviewing", "awaiting_author", "awaiting_human", "closed"]],
  [{ type: "trigger", source: "label" }, ["queued", "queued", "reviewing", "queued", "queued", "closed"]],
  [{ type: "stale_detected" }, ["queued", "queued", "reviewing", "queued", "awaiting_human", "closed"]],
  [{ type: "dispatched" }, ["reviewing", "reviewing", "reviewing", "reviewing", "reviewing", "closed"]],
  [
    { type: "verdict", verdict: "APPROVE" },
    ["tracked", "tracked", "tracked", "tracked", "awaiting_human", "closed"],
  ],
  [
    { type: "verdict", verdict: "REQUEST_CHANGES" },
    ["awaiting_author", "awaiting_author", "awaiting_author", "awaiting_author", "awaiting_human", "closed"],
  ],
  [
    { type: "verdict", verdict: "ESCALATE" },
    ["awaiting_human", "awaiting_human", "awaiting_human", "awaiting_human", "awaiting_human", "closed"],
  ],
  [
    { type: "round_overdue" },
    ["awaiting_human", "awaiting_human", "awaiting_human", "awaiting_human", "awaiting_human", "closed"],
  ],
  [{ type: "author_reply" }, ["tracked", "queued", "reviewing", "awaiting_author", "awaiting_human", "closed"]],
  [{ type: "synchronize" }, ["tracked", "queued", "reviewing", "queued", "awaiting_human", "closed"]],
  [
    { type: "escalation_detected" },
    ["awaiting_human", "queued", "reviewing", "awaiting_human", "awaiting_human", "closed"],
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

  it("awaiting_human is never demoted to tracked by a verdict", () => {
    expect(transition("awaiting_human", { type: "verdict", verdict: "APPROVE" })).toBe("awaiting_human");
    expect(transition("awaiting_human", { type: "verdict", verdict: "REQUEST_CHANGES" })).toBe("awaiting_human");
  });

  it("an overdue round can never land on an approve state", () => {
    for (const state of STATES) {
      const next = transition(state, { type: "round_overdue" });
      expect(["awaiting_human", "closed"]).toContain(next);
    }
  });

  it("a push only re-queues a PR that owes the author work", () => {
    expect(transition("awaiting_author", { type: "synchronize" })).toBe("queued");
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
