// Metrics tab — chart primitives, the dashboard renderer, window
// switching, the per-PR timeline drill-down and key/zone routing. Fixtures are
// local structural copies of the M1 payload contract, so this file never
// imports src/metrics.ts; nothing sshes, nothing spawns.
import { EventEmitter } from "node:events";
import { describe, expect, it } from "vitest";
import { TUI_DEFAULTS } from "../src/config.js";
import { App } from "../src/tui/app.js";
import {
  ACCENTS,
  activityChartHeight,
  columnChart,
  columnWidths,
  dayAxis,
  distStats,
  fmtDur,
  hbar,
  histogramLines,
  installMetricsHooks,
  kindGlyph,
  metricsCards,
  packColumns,
  renderMetrics,
  sparkline,
  statStrip,
  timelineLines,
  windowSwitcher,
  type MetricsAction,
} from "../src/tui/metricstab.js";
import { displayWidth, stripAnsi } from "../src/tui/paint.js";
import { metricsArgv, metricsPrArgv, type RemoteResult } from "../src/tui/remote.js";

const NOW = new Date("2026-08-14T12:00:00Z");

// ---- fixtures (structural copies of the M1 contract) ------------------------

const dist = (n: number, median: number | null, p90: number | null, histogram: Array<{ label: string; count: number }>) => ({ median, p90, n, histogram });

const emptyDist = dist(0, null, null, [
  { label: "0", count: 0 },
  { label: "1", count: 0 },
]);

const fullWindow = {
  header: { prs_triggered: 12, prs_reviewed: 9, approvals: 5, request_changes: 4, rounds: 21, spend_usd: 31.5, overruns: 2, awaiting_you: 3 },
  ttfv: {
    ...dist(9, 900, 3600, [
      { label: "<5m", count: 2 },
      { label: "<15m", count: 4 },
      { label: "<1h", count: 3 },
      { label: "1h+", count: 0 },
    ]),
    queue_median_s: 120,
    review_median_s: 780,
  },
  time_in_state: [
    { state: "queued", median_s: 120, total_s: 2400 },
    { state: "reviewing", median_s: 780, total_s: 9000 },
    { state: "awaiting_author", median_s: 26_000, total_s: 90_000 },
    { state: "awaiting_human", median_s: null, total_s: 0 },
  ],
  verdict_mix: [
    { verdict: "APPROVE", count: 5 },
    { verdict: "REQUEST_CHANGES", count: 4 },
    { verdict: "COMMENT", count: 1 },
  ],
  spend: { per_pr_median: 2.4, per_pr_p90: 6.1, by_round_type: { full: 22.5, followup: 9 }, by_lens: { security: 12, correctness: 19.5 } },
  rounds_until_resolution: dist(6, 2, 4, [
    { label: "1", count: 2 },
    { label: "2", count: 3 },
    { label: "3+", count: 1 },
  ]),
  duration: { ...dist(21, 540, 1500, [{ label: "<10m", count: 12 }, { label: "<30m", count: 9 }]), overrun_rate: 0.095 },
  author_response: dist(7, 5400, 86_400, [{ label: "<1h", count: 4 }, { label: "<1d", count: 3 }]),
  review_depth: emptyDist,
  size: [
    { bucket: "XS", prs: 4, median_ttfv_s: 600 },
    { bucket: "S", prs: 3, median_ttfv_s: 900 },
    { bucket: "XL", prs: 0, median_ttfv_s: null },
  ],
  pingpong: { ...emptyDist, cap_hits: 0 },
};

const allWindow = { ...fullWindow, header: { ...fullWindow.header, prs_triggered: 140, rounds: 302, spend_usd: 410.25 } };

const daily = [
  { day: "2026-08-11", rounds: 3, prs: 2, spend_usd: 4.5, approvals: 1, request_changes: 1 },
  { day: "2026-08-12", rounds: 0, prs: 0, spend_usd: 0, approvals: 0, request_changes: 0 },
  { day: "2026-08-13", rounds: 9, prs: 5, spend_usd: 13.25, approvals: 3, request_changes: 2 },
  { day: "2026-08-14", rounds: 6, prs: 4, spend_usd: 9, approvals: 1, request_changes: 1 },
];

const payload = {
  generated_at: "2026-08-14T11:48:00Z",
  windows: { d7: fullWindow, d30: fullWindow, all: allWindow },
  daily,
  backfill: { rounds: 302, prs: 140, oldest: "2026-06-01" },
};

const timeline = {
  pr: 5265,
  known: true,
  title: "fix(ui): frame the buttons",
  author: "jbennett",
  items: [
    { ts: "2026-08-14T09:00:00Z", kind: "trigger", label: "triggered by label", detail: "AI review requested" },
    { ts: "2026-08-14T09:01:00Z", kind: "state", label: "queued → reviewing", detail: null },
    { ts: "2026-08-14T09:30:00Z", kind: "round_finish", label: "round 1 finished", detail: "REQUEST_CHANGES · $1.20" },
    { ts: "2026-08-14T11:48:00Z", kind: "push", label: "author pushed 19277cd" },
  ],
  backfilled_rounds: [{ round_no: 1, submitted_at: "2026-08-14T09:30:00Z", verdict: "REQUEST_CHANGES", trigger_ts: "2026-08-14T09:00:00Z" }],
};

const mkView = (over: { payload?: typeof payload; window?: "d7" | "d30" | "all"; error?: string; drill?: unknown; scroll?: number } = {}) => ({
  window: over.window ?? ("d7" as const),
  payload: "payload" in over ? over.payload : payload,
  error: over.error,
  loading: false,
  drill: over.drill as undefined,
  scroll: over.scroll ?? 0,
  dryRun: true,
  now: NOW,
});

const ok = (stdout: string): RemoteResult => ({ ok: true, stdout, stderr: "", code: 0 });

function fakeStreams() {
  const out = new EventEmitter() as any;
  let buf = "";
  out.columns = 140;
  out.rows = 40;
  out.write = (s: string) => ((buf += s), true);
  const input = new EventEmitter() as any;
  input.isTTY = false;
  input.resume = () => {};
  input.pause = () => {};
  input.setRawMode = () => {};
  return { out, input, written: () => buf, type: (s: string | Buffer) => input.emit("data", Buffer.from(s)) };
}

// ---- chart primitives -------------------------------------------------------

describe("chart primitives", () => {
  it("sparkline maps a ramp onto the full glyph scale", () => {
    expect(sparkline([0, 1, 2, 3, 4, 5, 6, 7], 8)).toBe("▁▂▃▄▅▆▇█");
  });

  it("sparkline keeps a flat/empty series honest", () => {
    expect(sparkline([0, 0, 0], 8)).toBe("▁▁▁");
    expect(sparkline([], 8)).toBe("");
    expect(sparkline([1, 2, 3], 0)).toBe("");
  });

  it("sparkline bucket-averages a series longer than the width", () => {
    expect(sparkline([1, 1, 4, 4], 2)).toBe("▂█");
    expect(sparkline(daily.map((d) => d.rounds), 10)).toHaveLength(4);
  });

  it("hbar is a THIN bar on a dim track, value outside the bar", () => {
    const bar = hbar("queued", 5, 10, 30);
    expect(displayWidth(bar)).toBe(30);
    expect(stripAnsi(bar).startsWith("queued")).toBe(true);
    expect(bar).toContain("█");
    expect(bar).toContain("░");
    // the bar never eats more than ~60% of the row, and the value is last
    const plain = stripAnsi(hbar("queued", 5, 10, 60, "5"));
    expect(plain.replace(/[^█░]/g, "").length).toBeLessThanOrEqual(Math.round(60 * 0.6));
    expect(plain.trimEnd().endsWith("5")).toBe(true);
    const full = hbar("queued", 10, 10, 30);
    expect(full).not.toContain("░");
    const zero = hbar("queued", 0, 0, 30);
    expect(zero).not.toContain("█");
    expect(displayWidth(zero)).toBe(30);
  });

  it("hbar renders a custom value label (durations, usd) and a bar color", () => {
    expect(stripAnsi(hbar("reviewing", 780, 780, 40, fmtDur(780)))).toContain("13m");
    expect(hbar("reviewing", 780, 780, 40, fmtDur(780), ACCENTS.blue)).toContain(ACCENTS.blue);
  });

  it("fmtDur speaks the board's age vocabulary", () => {
    expect(fmtDur(45)).toBe("45s");
    expect(fmtDur(780)).toBe("13m");
    expect(fmtDur(5400)).toBe("1.5h");
    expect(fmtDur(172_800)).toBe("2.0d");
    expect(fmtDur(null)).toBe("—");
  });

  it("distStats belongs in the title row, not in the chart", () => {
    expect(distStats(fullWindow.rounds_until_resolution)).toBe("median 2 · p90 4 · n=6");
    expect(distStats(fullWindow.ttfv, fmtDur)).toBe("median 15m · p90 1.0h · n=9");
    expect(distStats(emptyDist)).toBe("no data yet");
  });

  it("histogramLines is ONE chart row plus ONE dim label row", () => {
    const lines = histogramLines(fullWindow.ttfv, 40, ACCENTS.blue);
    expect(lines).toHaveLength(2);
    const chart = stripAnsi(lines[0]!);
    const axis = stripAnsi(lines[1]!);
    // four buckets: 2, 4, 3, 0 → scaled glyph runs, the zero one a single dot
    expect(chart).toBe("▄▄▄ ███ ▆▆▆ ·  ");
    expect(axis).toBe("5m  15m 1h  1h+");
    expect(lines[0]).toContain(ACCENTS.blue); // marks carry the card accent
    expect(chart).not.toContain("median"); // stats moved to the title
  });

  it("histogramLines scales buckets to the max count and says so at n=0", () => {
    const one = stripAnsi(histogramLines(dist(3, 1, 1, [{ label: "a", count: 3 }, { label: "b", count: 0 }]), 20)[0]!);
    expect(one.startsWith("███")).toBe(true);
    expect(one).toContain("·");
    expect(stripAnsi(histogramLines(emptyDist, 40).join("\n"))).toBe("no data yet");
  });

  it("columnChart stacks block glyphs into a multi-row chart", () => {
    const rows = columnChart([0, 4, 8], 3, 4, ACCENTS.blue);
    expect(rows).toHaveLength(4);
    const plain = rows.map(stripAnsi);
    expect(plain[0]).toBe("  █"); // the max column reaches the top row
    expect(plain[3]!.startsWith("·")).toBe(true); // zero day keeps a dim baseline
    expect(plain[0]![1]).toBe(" "); // the half-height column starts lower
    expect(stripAnsi(columnChart([1, 1], 2, 3, ACCENTS.blue)[0]!)).toBe("██");
    expect(columnChart([], 10, 4, ACCENTS.blue)).toEqual([]);
    for (const line of columnChart(daily.map((d) => d.rounds), 12, 6, ACCENTS.blue)) {
      expect(displayWidth(line)).toBeLessThanOrEqual(12);
    }
  });

  it("dayAxis labels first, last and weekly ticks without collisions", () => {
    const days = Array.from({ length: 15 }, (_, i) => `2026-07-${String(i + 1).padStart(2, "0")}`);
    const axis = stripAnsi(dayAxis(days, 40, 2));
    expect(axis.startsWith("07-01")).toBe(true);
    expect(axis).toContain("07-08");
    expect(axis.trimEnd().endsWith("07-15")).toBe(true);
    expect(displayWidth(axis)).toBeLessThanOrEqual(40);
    expect(dayAxis([], 40, 2)).toBe("");
  });

  it("activityChartHeight only grows the card on a tall terminal", () => {
    expect(activityChartHeight(24)).toBe(0);
    expect(activityChartHeight(30)).toBe(0);
    expect(activityChartHeight(40)).toBe(6);
    expect(activityChartHeight(125)).toBe(10);
  });
});

// ---- dashboard --------------------------------------------------------------

describe("metrics dashboard", () => {
  it("stat strip carries the window header with verdict + awaiting-you counts", () => {
    const text = stripAnsi(statStrip(fullWindow, 200));
    expect(text).toContain("triggered 12");
    expect(text).toContain("reviewed 9");
    expect(text).toContain("✓5");
    expect(text).toContain("✗4");
    expect(text).toContain("rounds 21");
    expect(text).toContain("$31.50");
    expect(text).toContain("overruns 2");
    expect(text).toContain("⚑ 3 awaiting you");
  });

  it("renders every chart card in the single-column stack (scrolling the fold into view)", () => {
    const text = [0, 40, 80]
      .map((scroll) => renderMetrics(mkView({ scroll }), 200, 44).lines.map(stripAnsi).join("\n"))
      .join("\n");
    for (const title of [
      "ACTIVITY",
      "TIME TO FIRST VERDICT",
      "TIME IN STATE",
      "VERDICT MIX",
      "SPEND",
      "SPEND BY LENS",
      "ROUNDS UNTIL RESOLUTION",
      "ROUND DURATION",
      "AUTHOR RESPONSE",
      "REVIEW DEPTH",
      "PR SIZE",
      "PING-PONG",
    ]) {
      expect(text).toContain(title);
    }
    expect(text).toContain("queue 2m · review 13m · median 15m");
    expect(text).toContain("overrun 10%");
    expect(text).toContain("median 2 · p90 4 · n=6");
    expect(text).toContain("backfill 302 rounds / 140 PRs since 2026-06-01");
  });

  it("gives every distribution card exactly title + chart + labels", () => {
    const cards = metricsCards(fullWindow as never, daily, 24);
    for (const title of ["TIME TO FIRST VERDICT", "ROUND DURATION", "ROUNDS UNTIL RESOLUTION", "AUTHOR RESPONSE", "PING-PONG"]) {
      const card = cards.find((c) => c.title === title)!;
      expect(card.body(60).length).toBeLessThanOrEqual(2);
    }
    // ...and no card row is a solid block of filled cells with text inside it
    for (const card of cards) {
      for (const line of card.body(60)) {
        const plain = stripAnsi(line);
        expect(/[█▇▆▅▄▃▂▁░]\s*\S*[A-Za-z]/.test(plain.replace(/^[^█▇▆▅▄▃▂▁░]*/, "").replace(/\s+\S+$/, ""))).toBe(false);
      }
    }
  });

  it("assigns a fixed accent per card, never the same hue twice in a row", () => {
    const cards = metricsCards(fullWindow as never, daily, 24);
    const hues = new Set(cards.map((c) => c.accent));
    expect(hues.size).toBe(5);
    for (let i = 1; i < cards.length; i++) expect(cards[i]!.accent).not.toBe(cards[i - 1]!.accent);
    expect(cards[0]!.title).toBe("ACTIVITY");
    expect(cards[0]!.accent).toBe(ACCENTS.cyan);
  });

  it("caps the lens list at six rows plus a dim overflow row", () => {
    const many = { ...fullWindow, spend: { ...fullWindow.spend, by_lens: Object.fromEntries(Array.from({ length: 9 }, (_, i) => [`lens${i}`, 9 - i])) } };
    const card = metricsCards(many as never, daily, 24).find((c) => c.title === "SPEND BY LENS")!;
    const body = card.body(50).map(stripAnsi);
    expect(body).toHaveLength(7);
    expect(body[6]).toBe("…+3 more");
  });

  it("stacks every card into the one column, slack spread over the gaps", () => {
    for (const [cols, rows] of [
      [200, 44],
      [200, 130],
      [120, 40],
    ] as const) {
      const widths = columnWidths(cols);
      expect(widths).toHaveLength(1);
      const cards = metricsCards(fullWindow as never, daily, rows - 5);
      const packed = packColumns(cards, widths);
      expect(packed).toHaveLength(1);
      // every card is present, in order, in the single stack
      const stack = packed[0]!.join("\n");
      for (const c of cards) expect(stack).toContain(c.title.split(" ")[0]!);
      // slack spreading never shrinks the stack
      const spread = packColumns(cards, widths, rows - 5);
      expect(spread[0]!.length).toBeGreaterThanOrEqual(packed[0]!.length);
    }
  });

  it("grows the ACTIVITY card into stacked column charts on a tall terminal", () => {
    const short = renderMetrics(mkView(), 120, 30).lines.map(stripAnsi).join("\n");
    expect(short).toMatch(/rounds\s+[▁▂▃▄▅▆▇█]/); // 1-row sparkline degradation
    expect(short).not.toContain("rounds/day");

    const tall = renderMetrics(mkView(), 120, 130).lines.map(stripAnsi).join("\n");
    expect(tall).toContain("rounds/day · max 9");
    expect(tall).toContain("spend/day · max $13.25"); // two single-hue charts, never one dual axis
    expect(tall).toContain("2026-08-11"); // sparse day axis
    const chartRows = tall.split("\n").filter((l) => /[█▇▆▅▄▃▂▁]/.test(l));
    expect(chartRows.length).toBeGreaterThan(10);
  });

  it("is always a single column at every width", () => {
    for (const cols of [80, 99, 100, 169, 170, 220]) {
      expect(columnWidths(cols)).toEqual([cols - 2]);
    }
  });

  it("caps every card at a readable measure even on an ultrawide terminal", () => {
    const cards = metricsCards(fullWindow as never, daily, 39);
    for (const column of packColumns(cards, columnWidths(220))) {
      for (const line of column) expect(displayWidth(line)).toBeLessThanOrEqual(92);
    }
  });

  it("renders sparse distributions as 'no data yet' rather than empty charts", () => {
    const text = [0, 40, 80]
      .map((scroll) => renderMetrics(mkView({ scroll }), 200, 44).lines.map(stripAnsi).join("\n"))
      .join("\n");
    expect(text).toContain("no data yet"); // review_depth + pingpong are n=0
    expect(text).not.toContain("XL"); // zero-PR size buckets drop out
  });

  it("switches windows: 7d / 30d / all pick different aggregates", () => {
    const week = renderMetrics(mkView({ window: "d7" }), 160, 44).lines.map(stripAnsi).join("\n");
    const all = renderMetrics(mkView({ window: "all" }), 160, 44).lines.map(stripAnsi).join("\n");
    expect(week).toContain("triggered 12");
    expect(all).toContain("triggered 140");
    expect(all).toContain("$410.25");
  });

  it("declares clickable window-switcher zones on the switcher row", () => {
    const frame = renderMetrics(mkView(), 160, 44);
    const actions = frame.zones.map((z) => z.action as MetricsAction);
    expect(actions).toEqual([
      { t: "window", window: "d7" },
      { t: "window", window: "d30" },
      { t: "window", window: "all" },
    ]);
    for (const z of frame.zones) expect(z.y1).toBe(2);
    const sw = windowSwitcher("d7", 3);
    expect(stripAnsi(sw.text)).toBe("[ 7d ] [ 30d ] [ all ]");
    expect(sw.zones[0]).toEqual({ x1: 3, x2: 8, window: "d7" });
  });

  it("shows loading and error states instead of crashing", () => {
    const loading = renderMetrics(mkView({ payload: undefined }), 100, 24).lines.map(stripAnsi).join("\n");
    expect(loading).toContain("loading metrics…");
    const failed = renderMetrics(mkView({ payload: undefined, error: "ssh: connect timed out" }), 100, 24).lines.map(stripAnsi).join("\n");
    expect(failed).toContain("metrics unavailable: ssh: connect timed out");
  });

  it("never overflows the pane at any width or height (the width-30 lesson)", () => {
    for (const cols of [30, 40, 60, 80, 100, 120, 160, 170, 200, 220]) {
      for (const rows of [24, 30, 44, 130]) {
        for (const view of [mkView(), mkView({ payload: undefined }), mkView({ drill: { pr: 5265, payload: timeline, loading: false } as never })]) {
          const frame = renderMetrics(view, cols, rows);
          expect(frame.lines).toHaveLength(rows);
          for (const line of frame.lines) expect(displayWidth(line)).toBeLessThanOrEqual(cols);
        }
      }
    }
  });
});

// ---- timeline drill-down ----------------------------------------------------

describe("per-PR timeline", () => {
  it("renders items in payload order with kind glyphs and dimmed detail", () => {
    const lines = timelineLines(timeline as never, 100, NOW).map(stripAnsi);
    const body = lines.join("\n");
    expect(body).toContain("#5265 fix(ui): frame the buttons jbennett");
    expect(body).toContain("triggered by label");
    expect(body).toContain("REQUEST_CHANGES · $1.20");
    const order = ["triggered by label", "queued → reviewing", "round 1 finished", "author pushed"].map((s) => lines.findIndex((l) => l.includes(s)));
    expect(order).toEqual([...order].sort((a, b) => a - b));
    expect(order[0]).toBeGreaterThan(0);
    expect(lines.some((l) => l.startsWith("3h    ▸"))).toBe(true);
    expect(body).toContain("BACKFILLED ROUNDS");
  });

  it("maps event kinds to glyphs, unknown kinds to a dot", () => {
    expect(kindGlyph("trigger")).toBe("▸");
    expect(kindGlyph("round_start")).toBe("▶");
    expect(kindGlyph("verdict")).toBe("■");
    expect(kindGlyph("head_push")).toBe("↑");
    expect(kindGlyph("pr_closed")).toBe("✖");
    expect(kindGlyph("whatever")).toBe("·");
  });

  it("says so when the daemon has no record of the PR", () => {
    const text = timelineLines({ pr: 42, known: false, items: [], backfilled_rounds: [] } as never, 80, NOW).map(stripAnsi).join("\n");
    expect(text).toContain("no record of this PR");
  });

  it("the drill-down frame offers Esc back to the dashboard", () => {
    const frame = renderMetrics(mkView({ drill: { pr: 5265, payload: timeline, loading: false } as never }), 120, 30);
    const text = frame.lines.map(stripAnsi).join("\n");
    expect(text).toContain("metrics · #5265");
    expect(text).toContain("Esc back to the dashboard");
    expect(text).toContain("round 1 finished");
  });
});

// ---- wiring -----------------------------------------------------------------

describe("metrics tab wiring", () => {
  it("fetches through the container's qcr, read-only", () => {
    expect(metricsArgv(TUI_DEFAULTS).slice(0, 3)).toEqual(["sudo", "docker", "exec"]);
    expect(metricsArgv(TUI_DEFAULTS).slice(-2)).toEqual(["metrics", "--json"]);
    expect(metricsPrArgv(TUI_DEFAULTS, 5265).slice(-4)).toEqual(["metrics", "--pr", "5265", "--json"]);
  });

  it("opens on 5, switches windows on 7/0/a, drills in with # <pr> ⏎ and Esc goes back", async () => {
    const streams = fakeStreams();
    const app = new App(TUI_DEFAULTS, async () => ok(""), streams.out, streams.input);
    let overallCalls = 0;
    const timelineCalls: number[] = [];
    const view = installMetricsHooks(app, {
      overall: async () => (overallCalls++, { payload: payload as never }),
      timeline: async (pr) => (timelineCalls.push(pr), { payload: timeline as never }),
    });
    const run = app.run();
    streams.type("5");
    expect(app.tab).toBe("metrics");
    await new Promise((r) => setTimeout(r, 0)); // lazy load settles
    expect(overallCalls).toBe(1);
    expect(stripAnsi(streams.written())).toContain("triggered 12");

    streams.type("a");
    expect(view.window).toBe("all");
    streams.type("0");
    expect(view.window).toBe("d30");
    streams.type("7");
    expect(view.window).toBe("d7");

    streams.type("j");
    expect(view.scroll).toBe(1);
    streams.type("k");
    expect(view.scroll).toBe(0);

    // PR entry: digits that normally switch tabs are read back as digits.
    streams.type("#");
    streams.type("5");
    streams.type("2");
    streams.type("6");
    streams.type("5");
    expect(view.prEntry).toBe("5265");
    expect(app.tab).toBe("metrics");
    streams.type("\r");
    await new Promise((r) => setTimeout(r, 0));
    expect(timelineCalls).toEqual([5265]);
    expect(stripAnsi(streams.written())).toContain("round 1 finished");

    streams.type("\x1b");
    expect(view.drill).toBeUndefined();
    streams.type("1");
    expect(app.tab).toBe("board");
    app.quit();
    await run;
  });

  it("clicking a window button switches the window", async () => {
    const streams = fakeStreams();
    const app = new App(TUI_DEFAULTS, async () => ok(""), streams.out, streams.input);
    const view = installMetricsHooks(app, {
      overall: async () => ({ payload: payload as never }),
      timeline: async () => ({ payload: timeline as never }),
    });
    const run = app.run();
    streams.type("5");
    await new Promise((r) => setTimeout(r, 0));
    streams.type("\x1b[<0;19;2M"); // left press on `[ all ]`
    expect(view.window).toBe("all");
    app.quit();
    await run;
  });

  it("surfaces a fetch failure as a dim line, never a crash", async () => {
    const streams = fakeStreams();
    const app = new App(TUI_DEFAULTS, async () => ok(""), streams.out, streams.input);
    installMetricsHooks(app, {
      overall: async () => ({ error: "ssh: connect timed out" }),
      timeline: async () => ({ error: "ssh: connect timed out" }),
    });
    const run = app.run();
    streams.type("5");
    await new Promise((r) => setTimeout(r, 0));
    expect(stripAnsi(streams.written())).toContain("metrics unavailable: ssh: connect timed out");
    app.quit();
    await run;
  });
});
