import { describe, expect, it } from "vitest";
import { awaitingRows, formatEvent, glyphFor, moveSelection, reselect, sortPrs } from "../src/tui/model.js";

const pr = (number: number, state: string, extra: Record<string, unknown> = {}) =>
  ({ number, state, title: `t${number}`, head_sha: "abc123", stale_recheck: 0, ...extra }) as any;

describe("glyphFor", () => {
  it("maps every lifecycle state to its glyph", () => {
    expect(glyphFor(pr(1, "queued"))).toBe("●");
    expect(glyphFor(pr(1, "reviewing"))).toBe("▶");
    expect(glyphFor(pr(1, "awaiting_author"))).toBe("✎");
    expect(glyphFor(pr(1, "awaiting_human"))).toBe("⚑");
    expect(glyphFor(pr(1, "tracked"))).toBe("·");
  });

  it("prefixes ↻ on stale recheck", () => {
    expect(glyphFor(pr(1, "reviewing", { stale_recheck: 1 }))).toBe("↻▶");
  });

  it("renders unknown states as ? instead of crashing", () => {
    expect(glyphFor(pr(1, "surprise"))).toBe("?");
  });
});

describe("sortPrs", () => {
  it("orders by lifecycle group then PR number, dropping closed", () => {
    const input = [
      pr(9, "tracked"),
      pr(4, "closed"),
      pr(7, "queued"),
      pr(2, "awaiting_author"),
      pr(8, "reviewing"),
      pr(1, "awaiting_human"),
      pr(3, "reviewing"),
    ];
    expect(sortPrs(input).map((p) => p.number)).toEqual([3, 8, 7, 1, 2, 9]);
  });

  it("does not mutate its input", () => {
    const input = [pr(2, "queued"), pr(1, "reviewing")];
    sortPrs(input);
    expect(input.map((p) => p.number)).toEqual([2, 1]);
  });
});

describe("formatEvent", () => {
  it("renders time, kind, pr and payload facts", () => {
    const line = formatEvent({ ts: "2026-08-13T21:24:11.000Z", kind: "verdict_applied", pr: 5049, payload: JSON.stringify({ verdict: "APPROVE" }) });
    expect(line.text).toBe("21:24:11 verdict_applied #5049 (APPROVE)");
    expect(line.anomaly).toBe(false);
  });

  it("flags anomalies and uppercases the kind", () => {
    const line = formatEvent({ ts: "2026-08-13T21:15:02.000Z", kind: "verdict_rejected", pr: 5076, payload: null });
    expect(line.anomaly).toBe(true);
    expect(line.text).toContain("VERDICT_REJECTED #5076");
  });

  it("survives non-JSON payloads", () => {
    const line = formatEvent({ ts: "2026-08-13T10:00:00.000Z", kind: "note", pr: null, payload: "not json" });
    expect(line.text).toBe("10:00:00 note");
  });
});

describe("awaitingRows", () => {
  it("lists awaiting_human oldest-first with ages in days", () => {
    const now = new Date("2026-08-13T12:00:00Z");
    const rows = awaitingRows(
      [
        pr(4820, "awaiting_human", { trigger_ts: "2026-08-01T12:00:00Z" }),
        pr(4993, "awaiting_human", { trigger_ts: "2026-08-10T12:00:00Z" }),
        pr(5012, "reviewing"),
      ],
      now,
    );
    expect(rows.map((r) => [r.pr.number, r.ageDays])).toEqual([
      [4820, 12],
      [4993, 3],
    ]);
  });

  it("falls back to updated_at when trigger_ts is absent", () => {
    const now = new Date("2026-08-13T12:00:00Z");
    const rows = awaitingRows([pr(1, "awaiting_human", { trigger_ts: null, updated_at: "2026-08-12T11:00:00Z" })], now);
    expect(rows[0]?.ageDays).toBe(1);
  });
});

describe("selection", () => {
  it("clamps movement to list bounds", () => {
    expect(moveSelection(0, -1, 5)).toBe(0);
    expect(moveSelection(4, 1, 5)).toBe(4);
    expect(moveSelection(2, 1, 5)).toBe(3);
    expect(moveSelection(0, 1, 0)).toBe(0);
  });

  it("keeps the selection on the same PR across refresh reorders", () => {
    const sorted = [pr(3, "reviewing"), pr(7, "queued"), pr(9, "tracked")];
    expect(reselect(sorted, 7, 0)).toBe(1);
    expect(reselect(sorted, 999, 2)).toBe(2); // vanished PR → clamp old index
    expect(reselect(sorted, undefined, 5)).toBe(2);
  });
});
