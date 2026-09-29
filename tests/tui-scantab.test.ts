// the `[8] scan` tab: the scan report where the prototype
// placed it. Driven through the App like every surface test (keys typed on
// the fake terminal, frames rendered from the tab hook) over a temp state
// home holding the records the companion writes. What is asserted is what the
// operator SEES and what the tab WRITES — the request files the companion's
// scan belt answers, and the asks that reach its column.
import { readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { TUI_DEFAULTS } from "../src/config.js";
import { SCAN_STOP_FILE, SCAN_STOP_RESULT_FILE, type ScanFinding } from "../src/setup/scanreport.js";
import { STAGE2_RESULT_FILE, STAGE2_START_FILE } from "../src/setup/stage2request.js";
import { App } from "../src/tui/app.js";
import { stripAnsi } from "../src/tui/paint.js";
import {
  filterLabel,
  matchesFilter,
  parseScanFilter,
  reportItems,
  styleRule,
  unitRows,
} from "../src/tui/scantab.js";
import { fakeStreams, installScanRig, okSsh, SCAN_FINDINGS, scanFinding, type ScanRig } from "./helpers/tui-rig.js";

const COLS = 150;
const ROWS = 40;

function rig(opts: Parameters<typeof installScanRig>[1] = {}): { app: App; s: ScanRig; type: (k: string) => void; screen: () => string } {
  const streams = fakeStreams(COLS, ROWS);
  const app = new App(TUI_DEFAULTS, okSsh, streams.out, streams.input);
  const s = installScanRig(app, opts);
  app.tab = "scan";
  return {
    app,
    s,
    type: (k) => streams.type(k),
    screen: () => app.hooks.tabs.scan!.screen(app, COLS, ROWS).lines.map(stripAnsi).join("\n"),
  };
}

async function driving<T>(app: App, fn: () => T | Promise<T>): Promise<T> {
  const running = app.run();
  try {
    return await fn();
  } finally {
    app.quit();
    await running;
  }
}

const barLabels = (app: App): string[] => app.liveKeys().bar.map((b) => b.label);

describe("the report", () => {
  it("shows the run on top — sha, stage, state, cases done, spend against the hard stop, finding and doubted counts", () => {
    const { screen } = rig();
    const text = screen();
    expect(text).toMatch(/── scan/);
    expect(text).toMatch(/SCAN @27a8a94 {2}stage 1 ▶ running {2}1\/3 cases \(33%\)/);
    expect(text).toContain("spend $41.20 / $55.00 hard stop");
    expect(text).toContain("7 findings · 1 doubted");
  });

  it("groups by unit — all first, worst unit first, the hotspot marked, the run's mark per unit", () => {
    const { screen } = rig();
    const text = screen();
    const left = text.split("\n").map((l) => l.split("│")[1] ?? "");
    const units = left.map((l) => /^ [✓▶·✗ ] (\w+) +\d+/.exec(l)?.[1]).filter((u) => u !== undefined);
    expect(units).toEqual(["all", "billing", "auth", "widget"]);
    expect(text).toMatch(/✓ billing\s+5 ▲/);
    expect(text).toMatch(/▶ auth\s+3/);
    expect(text).toMatch(/· widget\s+0/);
  });

  it("lists findings most severe first, style grouped PER RULE with a count, a doubted one marked ?", () => {
    const items = reportItems(SCAN_FINDINGS.filter((f) => f.unit === "billing"));
    expect(items.map((i) => (i.t === "finding" ? i.finding.fingerprint.slice(0, 2) : `style:${i.rule}×${i.findings.length}`))).toEqual([
      "f1",
      "f2",
      "style:rule 4.2×3",
    ]);
    const { screen } = rig();
    const text = screen();
    expect(text).toContain("● P1 data-safety  billing/models.py:88");
    expect(text).toMatch(/● P3 placement {2}billing\/tasks\.py:31 {2}\?/);
    expect(text).toContain("● nit style ×3 (rule 4.2)");
  });

  it("the detail pane says what a finding claims, its state and the validator's doubt", async () => {
    const { app, type, screen } = rig();
    await driving(app, () => {
      type("j"); // f6 — the P2 in auth
      type("j"); // f7 — the dismissed P3 (auth/ sorts first)
      type("j"); // f2 — the doubted placement finding
      const text = screen();
      expect(text).toContain("P3 placement · billing/tasks.py:31");
      expect(text).toContain("the retry belongs in the task wrapper");
      expect(text).toContain("? may not be valid — unverifiable: the wrapper is not in the tree");
    });
  });

  it("a style group's detail carries the rule, the count and examples", () => {
    const f = SCAN_FINDINGS[2]!;
    expect(styleRule(f)).toBe("rule 4.2");
    expect(styleRule(scanFinding({ fingerprint: "x", claim: "tabs, not spaces", kind: "indent" }))).toBe("indent");
    expect(styleRule(scanFinding({ fingerprint: "x", claim: "see §3.1.", kind: "style" }))).toBe("rule 3.1");
  });
});

describe("honest unknown — never 'no scan' for a record that was not read", () => {
  it("a run recorded as running while the companion is known down reads interrupted, and offers no stop", () => {
    const { app, screen } = rig({ companionUp: false });
    expect(screen()).toContain("⏸ interrupted — the companion is down; the ledger resumes it");
    expect(barLabels(app)).not.toContain("x stop");
  });

  it("no records: none yet; an unreadable findings store: could not read, with the count unknown", () => {
    const a = rig();
    rmSync(join(a.s.home, "scan"), { recursive: true, force: true });
    a.s.store.reload();
    expect(a.screen()).toContain("none yet — no scan has run — ask the companion to scan");

    const b = rig();
    writeFileSync(join(b.s.home, "scan", "findings.json"), "{ torn");
    b.s.store.reload();
    const text = b.screen();
    expect(text).toContain("findings (—)");
    expect(text).toMatch(/UNITS \(—\)/);
    expect(text).toMatch(/could not read — scan\/findings\.json is not a record this version reads/);
    expect(barLabels(b.app)).not.toContain("f filter");
    expect(barLabels(b.app)).not.toContain("p promote");
  });
});

describe("filters", () => {
  it("parses state, lens, severity and doubted — bare or keyed — and refuses what it does not know", () => {
    expect(parseScanFilter("state=new lens=pass-security sev=p1 doubted")).toEqual({
      ok: true,
      filter: { state: "new", lens: "security", severity: "P1", doubted: true },
    });
    expect(parseScanFilter("dismissed nit valid")).toEqual({ ok: true, filter: { state: "dismissed", severity: "nit", doubted: false } });
    expect(parseScanFilter("colour=red")).toMatchObject({ ok: false, error: expect.stringContaining('"colour=red" is not a filter') });
    expect(filterLabel({ lens: "security", doubted: false })).toBe("lens=security valid");
    const f2 = SCAN_FINDINGS[1]!;
    expect(matchesFilter({ lens: "placement", doubted: true }, f2)).toBe(true);
    expect(matchesFilter({ doubted: false }, f2)).toBe(false);
  });

  it("f sets the filter from the message box, the counts follow it, F clears it", async () => {
    const { app, type, screen } = rig();
    await driving(app, () => {
      type("f");
      expect(app.view.inputBox?.target).toMatch(/^scan filter/);
      type("doubted");
      type("\r");
      const text = screen();
      expect(text).toContain("FINDINGS (all units) (1) · doubted (F clears)");
      expect(text).toMatch(/billing\s+1 ▲/);
      expect(app.liveKeys().inline).toEqual(["F"]);
      type("F");
      expect(screen()).toContain("FINDINGS (all units) (6)"); // 8 findings, 3 of them one style row
      expect(app.liveKeys().inline).toEqual([]);
    });
  });

  it("a filter nothing matches says so, and says how to clear it", async () => {
    const { app, type, screen } = rig();
    await driving(app, () => {
      type("f");
      type("sev=P0");
      type("\r");
      expect(screen()).toContain("none matching — F clears the filter");
    });
  });

  it("[ and ] walk the units; the list follows", async () => {
    const { app, type, screen } = rig();
    await driving(app, () => {
      expect(barLabels(app)).not.toContain("[ prev unit");
      type("]");
      expect(screen()).toContain("FINDINGS (billing) (3)");
      type("]");
      expect(screen()).toContain("FINDINGS (auth) (3)");
      type("[");
      expect(screen()).toContain("FINDINGS (billing) (3)");
    });
  });
});

describe("triage verbs", () => {
  it("p asks the companion to promote — the style group as one ask naming every member", async () => {
    const { app, s, type } = rig();
    await driving(app, () => {
      type("]"); // billing: f1, f2, the style group
      type("j");
      type("j");
      type("p");
      expect(s.asks).toHaveLength(1);
      expect(s.asks[0]!.verb).toBe("promote");
      const text = s.asks[0]!.text;
      expect(text).toMatch(/^The owner PROMOTED these 3 scan findings from the TUI's \[8\] scan tab:/);
      for (const n of [3, 4, 5]) expect(text).toContain(`- ${`f${n}`.padEnd(12, "0")} nit pass-style billing/views${n}.py:${n}`);
      expect(text).toContain("`scan_promote`");
      expect(app.view.noticeLine).toBe("scan promote: asked");
    });
  });

  it("d asks for the reason in the message box, then hands it to the companion verbatim", async () => {
    const { app, s, type } = rig();
    await driving(app, () => {
      type("d");
      expect(app.view.inputBox?.target).toMatch(/^dismiss 1 finding\(s\) — the reason/);
      type("the lock is taken by the caller");
      type("\r");
      expect(s.asks).toHaveLength(1);
      expect(s.asks[0]!.verb).toBe("dismiss");
      expect(s.asks[0]!.text).toContain("> the lock is taken by the caller");
      expect(s.asks[0]!.text).toContain(`- ${"f1".padEnd(12, "0")} P1 pass-data-safety billing/models.py:88`);
      expect(s.asks[0]!.text).toContain("`scan_dismiss`");
    });
  });

  it("a promoted or fixed finding offers neither verb — triage.ts would refuse them", async () => {
    const promoted = scanFinding({ fingerprint: "p1".padEnd(64, "0"), state: "promoted", ticket: { sink: "tracker", ref: "", effort: "x", filed_at: "" } });
    const fixed = scanFinding({ fingerprint: "x1".padEnd(64, "0"), severity: "P2", state: "fixed" });
    const { app, screen } = rig({ findings: [promoted, fixed] });
    expect(barLabels(app)).not.toContain("p promote");
    expect(barLabels(app)).not.toContain("d dismiss");
    expect(screen()).toContain("state: promoted · ticket");
  });

  it("D asks the companion for a delta re-scan (it prices it first) — only when no scan is running", async () => {
    const running = rig();
    expect(barLabels(running.app)).not.toContain("D delta");
    const { app, s, type } = rig({ running: false });
    await driving(app, () => {
      type("D");
      expect(s.asks.map((a) => a.verb)).toEqual(["delta"]);
      expect(s.asks[0]!.text).toContain("`scan_preview` with `delta: true`");
    });
  });
});

describe("the stage 2 plan", () => {
  it("P swaps the right pane to the plan: rows, their cost, the kept total that is the hard stop, the budget", async () => {
    const { app, type, screen } = rig({ running: false });
    await driving(app, () => {
      type("P");
      const text = screen();
      expect(text).toContain("STAGE 2 PLAN");
      expect(text).toMatch(/\[✓\] row-1 security {2}sol-high {2}billing \(1 files\) {2}\$6\.10/);
      expect(text).toMatch(/\[–\] row-3 tests .*over the budget — left out/);
      expect(text).toContain("2/2 row(s) · $10.90 — the hard stop: the run ends there");
      expect(text).toContain("budget $20.00 · $2.40 over it, left out");
      expect(barLabels(app)).toEqual(["⏎ approve", "space toggle", "Esc back"]);
      type("\x1b");
      expect(screen()).toContain("FINDINGS (all units)");
    });
  });

  it("space toggles a row off; ⏎ asks the companion to start exactly the kept rows, at their total", async () => {
    const { app, s, type, screen } = rig({ running: false });
    await driving(app, () => {
      type("P");
      type("j");
      type(" ");
      expect(screen()).toContain("1/2 row(s) · $6.10 — the hard stop");
      type("\r");
      const req = JSON.parse(readFileSync(join(s.home, STAGE2_START_FILE), "utf8"));
      expect(req).toMatchObject({ key: "proposalkey0001", rows: ["row-1"], by: "tui" });
      expect(app.view.noticeLine).toMatch(/stage 2 asked to start — 1 row\(s\), hard stop \$6\.10/);

      // The companion answers; the next poll settles it into the notice.
      writeFileSync(join(s.home, STAGE2_RESULT_FILE), JSON.stringify({ request: req.id, key: req.key, at: "", ok: true, run: "scan-9", errors: [] }));
      app.hooks.onPoll?.(app);
      expect(app.view.noticeLine).toBe("stage 2 started: scan-9");
    });
  });

  it("the full plan is started without a row list; nothing is approvable while a scan runs, and an over-budget row cannot be toggled", async () => {
    const running = rig();
    await driving(running.app, () => {
      running.type("P");
      expect(barLabels(running.app)).toEqual(["space toggle", "x stop", "Esc back"]);
      expect(running.screen()).toContain("a scan is running — approve when it ends");
      running.type("j");
      running.type("j"); // row-3, over the budget
      expect(barLabels(running.app)).not.toContain("space toggle");
    });
    const { app, s, type } = rig({ running: false });
    await driving(app, () => {
      type("P");
      type("\r");
      expect(JSON.parse(readFileSync(join(s.home, STAGE2_START_FILE), "utf8")).rows).toBeUndefined();
    });
  });

  it("no proposal yet: the plan says so and offers nothing to approve", async () => {
    const { app, type, screen } = rig({ running: false, proposal: false });
    await driving(app, () => {
      type("P");
      expect(screen()).toContain("none yet — ask the companion to propose stage 2");
      expect(barLabels(app)).toEqual(["Esc back"]);
    });
  });
});

describe("the stop control", () => {
  it("x names the run it showed running; the companion's answer lands in the notice", async () => {
    const { app, s, type } = rig();
    await driving(app, () => {
      expect(barLabels(app)).toContain("x stop");
      type("x");
      const req = JSON.parse(readFileSync(join(s.home, SCAN_STOP_FILE), "utf8"));
      expect(req).toMatchObject({ run: "scan-2", by: "tui" });
      expect(app.view.noticeLine).toContain("stop asked for scan-2");
      writeFileSync(join(s.home, SCAN_STOP_RESULT_FILE), JSON.stringify({ request: req.id, run: "scan-2", at: "", ok: true, errors: [] }));
      app.hooks.onPoll?.(app);
      expect(app.view.noticeLine).toBe("scan scan-2 stopped — what finished is in the ledger");
    });
  });
});

describe("units", () => {
  it("the hotspot is the unit with the most open P0–P2 findings — none when there are none", () => {
    const rows = unitRows(SCAN_FINDINGS, {}, null);
    expect(rows.filter((r) => r.hotspot).map((r) => r.unit)).toEqual(["billing"]);
    const calm = [scanFinding({ fingerprint: "c", severity: "nit" })] as ScanFinding[];
    expect(unitRows(calm, {}, null).some((r) => r.hotspot)).toBe(false);
  });
});
