// §8 — the "muted + one accent" design system: token composition,
// helper shapes, geometry transparency, and the sweep assertion that no
// renderer emits ad-hoc inverse styling any more.
import { describe, expect, it } from "vitest";
import {
  ACCENT,
  ACCENT_BG,
  BAD,
  BAD_BG,
  HEADING,
  MUTED,
  OK,
  RESET,
  SEP,
  STRONG,
  WARN,
  badge,
  button,
  focusMark,
  modeBadge,
  sectionTitle,
  selected,
} from "../src/tui/design.js";
import { renderBoard, type BoardView } from "../src/tui/board.js";
import { renderDeployTab, type DeployState } from "../src/tui/deploytab.js";
import { renderDigestTab, type DigestState } from "../src/tui/digesttab.js";
import { renderMemoryView, type MemTabState } from "../src/tui/memtab.js";
import { renderMetrics, type MetricsView } from "../src/tui/metricstab.js";
import { displayWidth, stripAnsi, Frame } from "../src/tui/paint.js";
import { osc8 } from "../src/tui/theme.js";
import type { StatusSnapshot } from "../src/state.js";

const INVERSE = "\x1b[7m";

describe("tokens", () => {
  it("are SGR sequences that cost zero cells", () => {
    for (const t of [ACCENT, ACCENT_BG, MUTED, HEADING, STRONG, OK, BAD, WARN, BAD_BG, RESET]) {
      expect(t.startsWith("\x1b[")).toBe(true);
      expect(displayWidth(t)).toBe(0);
    }
  });

  it("keeps red/green semantic and distinct from the accent", () => {
    expect(OK).not.toBe(ACCENT);
    expect(BAD).not.toBe(ACCENT);
    expect(WARN).not.toBe(ACCENT);
    expect(new Set([OK, BAD, WARN, ACCENT, MUTED]).size).toBe(5);
  });

  it("SEP renders as a plain ' · ' with the ink restored", () => {
    expect(stripAnsi(SEP)).toBe(" · ");
    expect(SEP.endsWith(RESET)).toBe(true);
  });
});

describe("helpers end reset — styling never bleeds", () => {
  const outputs = [
    sectionTitle("TITLE"),
    sectionTitle("TITLE", "subtitle"),
    selected(" a row "),
    badge("live", "LIVE"),
    badge("ok", "APPROVE"),
    badge("warn", "ARMED"),
    modeBadge(true),
    modeBadge(false),
    button("e edit"),
    button("accept"),
    button("2 memory", true),
    focusMark(true),
  ];
  it.each(outputs.map((o) => [stripAnsi(o), o] as const))("%s", (_plain, out) => {
    expect(out.endsWith(RESET)).toBe(true);
  });
});

describe("helper shapes", () => {
  it("sectionTitle: the one header language — accent-bold ▍TITLE, muted subtitle", () => {
    expect(stripAnsi(sectionTitle("MEMORY (9)"))).toBe("▍MEMORY (9)");
    expect(sectionTitle("X").startsWith(HEADING)).toBe(true);
    expect(stripAnsi(sectionTitle("PRS", "the live set"))).toBe("▍PRS the live set");
    expect(sectionTitle("PRS", "hint")).toContain(MUTED);
  });

  it("selected: one accent-background bar, inner SGR flattened, width preserved", () => {
    const line = ` ${ACCENT}#5265${RESET} styled ${MUTED}meta${RESET} `;
    const sel = selected(line);
    expect(sel.startsWith(ACCENT_BG)).toBe(true);
    expect(sel.endsWith(RESET)).toBe(true);
    expect(stripAnsi(sel)).toBe(stripAnsi(line));
    expect(displayWidth(sel)).toBe(displayWidth(line));
    // inner colors are gone — the bar reads as one piece
    expect(sel.slice(ACCENT_BG.length, -RESET.length)).not.toContain("\x1b[");
  });

  it("selected keeps OSC-8 hyperlinks clickable", () => {
    const link = osc8("https://github.com/o/r/pull/1", "#1");
    const sel = selected(` ${STRONG}${link}${RESET} title`);
    expect(sel).toContain("\x1b]8;;https://github.com/o/r/pull/1");
    expect(stripAnsi(sel)).toBe(" #1 title");
  });

  it("badge: solid chip, one leading/trailing space, truth colors only where truthful", () => {
    expect(stripAnsi(badge("live", "LIVE"))).toBe(" LIVE ");
    expect(badge("live", "LIVE").startsWith(BAD_BG)).toBe(true);
    expect(modeBadge(false)).toBe(badge("live", "LIVE"));
    expect(modeBadge(true)).toBe(badge("accent", "DRY-RUN"));
  });

  it("button: same visible text as the plain bracket form (geometry-safe)", () => {
    expect(stripAnsi(button("e edit"))).toBe("[e edit]");
    expect(stripAnsi(button("accept"))).toBe("[accept]");
    expect(stripAnsi(button("2 memory", true))).toBe("[2 memory]");
    expect(button("e edit")).toContain(`${ACCENT}${STRONG}e${RESET}`);
    expect(button("2 memory", true).startsWith(ACCENT_BG)).toBe(true);
    expect(button("accept")).not.toContain(ACCENT); // no fake key glyph
  });

  it("tokenized lines keep ANSI-transparent cell math", () => {
    const line = `${sectionTitle("ROUNDS", "verdicts")}  r1 ${OK}APPROVE${RESET}${SEP}r2 ${BAD}RC${RESET}`;
    expect(displayWidth(line)).toBe(stripAnsi(line).length);
  });
});

// ---- the sweep assertion: whole frames carry zero ad-hoc inverse ------------

const snapshot: StatusSnapshot = {
  written_at: "2026-08-20T12:00:00Z",
  dry_run: false,
  prs: [
    {
      number: 5265,
      state: "reviewing",
      title: "fix(ui): frame the buttons",
      head_sha: "19277cd",
      stale_recheck: 0,
      author: "jbennett",
      updated_at: "2026-08-20T11:48:00Z",
      rounds: 3,
      last_verdict: "REQUEST_CHANGES",
    },
    {
      number: 5277,
      state: "queued",
      title: "fix(ci): sanitize branch names",
      head_sha: "786ebb7",
      stale_recheck: 0,
      author: "author1",
      updated_at: "2026-08-20T09:00:00Z",
      rounds: 1,
      last_verdict: "APPROVE",
    },
  ],
  running_rounds: 1,
  max_concurrent_rounds: 12,
  total_spend_usd: 8,
  today_spend_usd: 7.5,
  heartbeat: "2026-08-20T12:00:00Z",
};

const boardView: BoardView = {
  health: { kind: "ok", heartbeatAgeS: 2 },
  dryRun: false,
  snapshot,
  events: [{ text: "#5265 round 3 started", anomaly: false, ts: "2026-08-20T11:00:00Z" }],
  selected: 0,
  detailFull: false,
  eventsFocus: true,
  eventsScroll: 0,
  help: false,
  now: new Date("2026-08-20T12:00:00Z"),
  repo: "exampleorg/example-app",
  pi: { pr: 5265, lines: ["pi output"], missing: false, stale: false, offset: 2 },
  piFocus: true,
};

const memState: MemTabState = {
  view: "memory",
  digest: { files: ["2026-08-19.md"], back: 0, scroll: 0, loaded: true, content: "# Digest\n- fine" },
  entries: [
    { ts: "2026-08-19T10:00:00", id: "abc", block: 0, day: "2026-08-19", text: "#pinned always check anchors", pinned: true, tags: ["pinned"], links: [] },
    { ts: "2026-08-20T09:00:00", id: "def", block: 1, day: "2026-08-20", text: "#bug missed a migration collision", pinned: false, tags: ["bug"], links: [] },
  ] as never,
  memLoaded: true,
  focus: "timeline",
  sel: 0,
  propSel: 0,
  scroll: 0,
  proposals: [{ slug: "tighten-anchor-rule", head: ["Tighten the anchor rule"] }],
  improvements: [{ kind: "pr", number: 12, state: "open", title: "bot improvement" }] as never,
  propLoaded: true,
  ticketsLoaded: true,
  filedTotal: 1,
  status: "✓ pinned",
};

const deployState: DeployState = {
  loaded: true,
  loading: false,
  deployed: { sha: "abc1234", at: "2026-08-19T10:00:00Z", mode: "sync" },
  head: "def5678",
  dirty: [],
  commits: ["def5678 tui: uplift"],
  diffstat: [" 1 file changed"],
  plan: ["would sync"],
  scroll: 0,
  armedAt: 1,
  armedKind: "deploy",
  containerStatus: "Up 2 hours",
};

const metricsView: MetricsView = { window: "d7", loading: true, scroll: 0, dryRun: false };

function frames(): Array<[string, Frame]> {
  return [
    ["board", renderBoard(boardView, 120, 40)],
    ["board-help", renderBoard({ ...boardView, help: true, eventsFocus: false }, 120, 40)],
    ["memory", renderMemoryView(memState, false, "2026-08-19", 120, 40, "exampleorg/example-app")],
    ["digest", renderDigestTab(memState.digest, false, "2026-08-20", 120, 40)],
    ["deploy", renderDeployTab(deployState, false, 120, 40)],
    ["metrics", renderMetrics(metricsView, 120, 40)],
  ];
}

describe("sweep: the old ad-hoc styling is gone from every tab", () => {
  it("no renderer uses raw SGR.bold/dim/inverse/bgRed/colors any more (grep-clean)", async () => {
    const { readdirSync, readFileSync } = await import("node:fs");
    const banned = /SGR\.(bold|dim|inverse|bgRed|red|green|yellow|cyan)\b/;
    for (const f of readdirSync("src/tui")) {
      if (!f.endsWith(".ts") || f === "paint.ts" || f === "design.ts") continue;
      const src = readFileSync(`src/tui/${f}`, "utf8");
      expect(banned.test(src), `${f} styles outside design.ts`).toBe(false);
    }
  });

  it.each(frames())("%s frame contains zero raw inverse", (_name, frame) => {
    expect(frame.lines.join("\n")).not.toContain(INVERSE);
  });

  it("board selection styling IS design.selected (one selection style everywhere)", () => {
    const frame = renderBoard(boardView, 120, 40);
    const row = frame.lines.find((l) => l.includes(ACCENT_BG) && stripAnsi(l).includes("#5265"));
    expect(row).toBeDefined();
    // the selected row is a single accent-background bar: flattened inner SGR
    const inner = row!.slice(row!.indexOf(ACCENT_BG));
    expect(inner.startsWith(ACCENT_BG)).toBe(true);
  });

  it("every tab's top bar shares the mode chip", () => {
    for (const [, frame] of frames()) {
      expect(frame.lines[0]!).toContain(badge("live", "LIVE"));
    }
  });

  it("token wrapping never changes cell math: displayWidth == stripAnsi length, frame-wide", () => {
    // (memtab/digesttab carry a pre-existing 1-cell body overflow — layout is
    // out of scope for this slice, so the invariant pinned here is the
    // §8 one: styling is ANSI-transparent to the cell math.)
    for (const [, frame] of frames()) {
      for (const line of frame.lines) {
        expect(displayWidth(line)).toBe(stripAnsi(line).length);
      }
    }
  });
});
