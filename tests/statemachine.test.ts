import { describe, expect, it } from "vitest";
import { StateStore, type PrLifecycleState } from "../src/state.js";
import { applyEvent, isBotAuthor, transition, type SmEvent } from "../src/statemachine.js";

// `awaiting_human` is no longer a member of the union, so the table
// below is five columns wide, not six. The rows it used to carry were an
// exact copy of the awaiting_author/idempotent column and pinned nothing the
// rest of the table did not already say.
const STATES: PrLifecycleState[] = ["tracked", "queued", "reviewing", "awaiting_author", "closed"];

// The transition table from src/statemachine.ts, transcribed independently:
// rows are events, columns follow STATES order.
const TABLE: Array<[SmEvent, PrLifecycleState[]]> = [
  [{ type: "track" }, ["tracked", "queued", "reviewing", "awaiting_author", "closed"]],
  [{ type: "trigger", source: "label" }, ["queued", "queued", "reviewing", "queued", "closed"]],
  [{ type: "stale_detected" }, ["queued", "queued", "reviewing", "queued", "closed"]],
  [{ type: "dispatched" }, ["reviewing", "reviewing", "reviewing", "reviewing", "closed"]],
  [
    { type: "verdict", verdict: "APPROVE" },
    ["tracked", "tracked", "tracked", "tracked", "closed"],
  ],
  [
    { type: "verdict", verdict: "REQUEST_CHANGES" },
    ["awaiting_author", "awaiting_author", "awaiting_author", "awaiting_author", "closed"],
  ],
  [
    { type: "verdict", verdict: "NEEDS_HUMAN" },
    // Legacy input only (retired 2026-08-19): review posted, no approval, no park.
    ["tracked", "tracked", "tracked", "tracked", "closed"],
  ],
  [
    { type: "round_overdue" },
    // No standing verdict on the event ⇒ tracked everywhere (no park, never an approve).
    ["tracked", "tracked", "tracked", "tracked", "closed"],
  ],
  [{ type: "author_reply" }, ["tracked", "queued", "reviewing", "awaiting_author", "closed"]],
  [{ type: "synchronize" }, ["tracked", "queued", "reviewing", "awaiting_author", "closed"]],
  [
    { type: "human_requested" },
    // Noted, never a handover (2026-08-19): the AI keeps working.
    ["tracked", "queued", "reviewing", "awaiting_author", "closed"],
  ],
  [{ type: "closed" }, ["closed", "closed", "closed", "closed", "closed"]],
  [{ type: "reopened" }, ["tracked", "queued", "reviewing", "awaiting_author", "tracked"]],
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

  // THE ONE RESIDUAL SCENARIO LEAVES OPEN, named so it is not a
  // surprise. The park's rows were drained on the live install on
  // 2026-08-19T17:04Z and the reconcile migration that drained them is gone,
  // so the only way a `pr_state` row can hold the string again is a RESTORE
  // from a backup older than that date. `state` is a TEXT column — SQLite does
  // not know about the union — so the cast below is not a trick, it is what a
  // restored row would really look like coming out of the store.
  //
  // Why it is BENIGN, stated precisely: the VERDICT branch ignores `current`
  // entirely and maps the verdict straight to a state, so a restored row
  // rejoins normal flow on its first verdict with no migration and no special
  // case. That is the narrow claim, and it is the one the migration's deletion
  // rests on. `transition` does read `current` elsewhere — the `closed` early
  // return, `trigger`, `stale_detected` and `reopened` all branch on it — so
  // "it never looks at the current state" would be false, and false in the
  // half that licenses the deletion.
  //
  // The honest caveat, which the runbook also carries: a restored row that is
  // only ever hit by `track`/`author_reply`/`synchronize`/`human_requested`
  // STAYS in the retired state, because those return `current` unchanged. It
  // is inert while it sits there (the board paints glyph `?`, `sortPrs` ranks
  // it last, no live surface names it), and the next verdict moves it.
  it("a restored pre-2026-08-19 row rejoins normal flow on its first verdict, with no migration", () => {
    const restored = "awaiting_human" as unknown as PrLifecycleState;
    expect(transition(restored, { type: "verdict", verdict: "APPROVE" })).toBe("tracked");
    expect(transition(restored, { type: "verdict", verdict: "REQUEST_CHANGES" })).toBe("awaiting_author");
    // …and the caveat above is a real property, not a hedge: these leave it be.
    for (const ev of [{ type: "track" }, { type: "author_reply" }, { type: "synchronize" }, { type: "human_requested" }] as const) {
      expect([ev.type, transition(restored, ev)]).toEqual([ev.type, "awaiting_human"]);
    }
  });

  // The old "nothing transitions INTO awaiting_human any more" test is DELETED
  //, not narrowed. It became structurally vacuous the moment the
  // union lost the member — `transition` returns `PrLifecycleState`, so the
  // comparison had no type overlap and could not fail. The stronger successor
  // is `tests/park-retired.test.ts`, which asserts the general property the
  // old test was one instance of: every member of the union is REACHABLE from
  // the initial state, so a writerless member fails rather than hiding.

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

  it("records fresh-head work owed while preserving the reviewing lifecycle", () => {
    const store = open();
    applyEvent(store, 5408, { type: "trigger", source: "label" }, { author: "alice", head_sha: "old" }, {});
    const roundId = store.startRound(5408, "re-review", ["pass-baseline"], 75);
    applyEvent(store, 5408, { type: "dispatched" }, {}, {});

    applyEvent(store, 5408, { type: "synchronize" }, { head_sha: "new" }, {});
    expect(store.getPr(5408)).toMatchObject({ state: "reviewing", head_sha: "new" });
    expect(store.successorFor(5408)).toMatchObject({ predecessor_round_id: roundId, head_sha: "new", provenance: "system" });

    applyEvent(store, 5408, { type: "trigger", source: "team_request" }, {}, {});
    expect(store.successorFor(5408)?.provenance).toBe("human");
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
