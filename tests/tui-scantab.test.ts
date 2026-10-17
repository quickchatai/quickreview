// The `[8] scan` tab: the scan report. Driven through the App like every
// surface test (keys typed on the fake terminal, frames rendered from the tab
// hook) over a temp state home holding the records the companion writes.
// What is asserted is what the operator SEES and what the tab WRITES — the
// request files the companion's scan belt answers, and the asks that reach
// its column.
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { TUI_DEFAULTS } from "../src/config.js";
import {
  SCAN_STOP_FILE,
  SCAN_STOP_RESULT_FILE,
  type ScanFinding,
} from "../src/setup/scanreport.js";
import { STAGE2_FILE, STAGE2_RESULT_FILE, STAGE2_START_FILE } from "../src/setup/stage2request.js";
import { DRIVER_DIR } from "../src/setup/scanlease.js";
import { App } from "../src/tui/app.js";
import { stripAnsi } from "../src/tui/paint.js";
import {
  filterLabel,
  itemValidity,
  matchesFilter,
  nextTier,
  parseScanFilter,
  promotable,
  reportItems,
  styleRule,
  unitRows,
} from "../src/tui/scantab.js";
import {
  fakeStreams,
  installScanRig,
  okSsh,
  SCAN_FINDINGS,
  scanFinding,
  type ScanRig,
} from "./helpers/tui-rig.js";

const COLS = 150;
const ROWS = 40;

function rig(opts: Parameters<typeof installScanRig>[1] = {}): {
  app: App;
  s: ScanRig;
  type: (k: string) => void;
  screen: () => string;
} {
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
  it("shows the run on top — sha, stage, state, cases done, spend against the hard stop, finding counts per validity tier", () => {
    const { screen } = rig();
    const text = screen();
    expect(text).toMatch(/── scan/);
    expect(text).toMatch(/SCAN @27a8a94 {2}stage 1 ▶ running {2}1\/3 cases \(33%\)/);
    expect(text).toContain("spend $41.20 / $55.00 hard stop");
    expect(text).toContain("7 findings · 6 confirmed · 0 likely · 1 doubtful");
  });

  it("groups by unit — all first, worst unit first, the hotspot marked, the run's mark per unit", () => {
    const { screen } = rig();
    const text = screen();
    const left = text.split("\n").map((l) => l.split("│")[1] ?? "");
    const units = left
      .map((l) => /^ [✓▶·✗ ] (\w+) +\d+/.exec(l)?.[1])
      .filter((u) => u !== undefined);
    expect(units).toEqual(["all", "billing", "auth", "widget"]);
    expect(text).toMatch(/✓ billing\s+5 ▲/);
    expect(text).toMatch(/▶ auth\s+3/);
    expect(text).toMatch(/· widget\s+0/);
  });

  it("lists findings by validity tier (confirmed first), most severe first inside it, style grouped PER RULE with a count, a doubted one marked ?", () => {
    const items = reportItems(SCAN_FINDINGS.filter((f) => f.unit === "billing"));
    expect(
      items.map((i) =>
        i.t === "finding"
          ? i.finding.fingerprint.slice(0, 2)
          : `style:${i.rule}×${i.findings.length}`,
      ),
    ).toEqual(["f1", "style:rule 4.2×3", "f2"]);
    const { screen } = rig();
    const text = screen();
    expect(text).toContain("● P1 data-safety  billing/models.py:88");
    expect(text).toMatch(/● P3 placement {2}billing\/tasks\.py:31 {2}\?/);
    expect(text).toContain("● nit style ×3 (rule 4.2)");
  });

  it("a style group with no new member is marked by its members' state — promoted or fixed, never dismissed by default", () => {
    const style = (n: number, state: ScanFinding["state"]): ScanFinding =>
      scanFinding({
        fingerprint: `s${n}`.padEnd(64, "0"),
        path: `billing/views${n}.py`,
        start: n,
        end: n,
        lens: "pass-style",
        kind: "style",
        severity: "nit",
        claim: `breaks rule 4.2 (${n})`,
        state,
      });
    expect(rig({ findings: [style(1, "promoted"), style(2, "promoted")] }).screen()).toContain(
      "⇡ nit style ×2 (rule 4.2)",
    );
    expect(rig({ findings: [style(1, "fixed"), style(2, "fixed")] }).screen()).toContain(
      "✓ nit style ×2 (rule 4.2)",
    );
    expect(rig({ findings: [style(1, "fixed"), style(2, "dismissed")] }).screen()).toContain(
      "– nit style ×2 (rule 4.2)",
    );
  });

  it("the detail pane says what a finding claims, its state and the validator's doubt", async () => {
    const { app, type, screen } = rig();
    await driving(app, () => {
      // Confirmed first: f1, f6, f7, the style group, f8 — then the doubtful f2.
      for (let i = 0; i < 5; i++) type("j");
      const text = screen();
      expect(text).toContain("P3 placement · billing/tasks.py:31");
      expect(text).toContain("the retry belongs in the task wrapper");
      expect(text).toContain("? doubtful — unverifiable: the wrapper is not in the tree");
    });
  });

  it("a not-reproduced finding is marked ↺ and counted, and its detail says it stays open for triage", () => {
    const f = scanFinding({
      fingerprint: "fa".padEnd(64, "0"),
      not_reproduced: { count: 2, run: "scan-9", sha: "9".repeat(40), at: "2026-09-30T10:00:00Z" },
    });
    const { screen } = rig({ findings: [f] });
    const text = screen();
    expect(text).toContain("1 findings · 1 confirmed · 0 likely · 0 doubtful · 1 not reproduced");
    expect(text).toMatch(/billing\/models\.py:88 {2}↺/);
    expect(text).toContain("↺ not reproduced: 2 re-read(s) of the unchanged code");
    expect(text).toContain("scan-9 at 9999999");
  });

  it("a new finding resembling a dismissed one is marked ≈, says so in its detail, and sorts below its tier", async () => {
    const flagged = scanFinding({
      fingerprint: "fb".padEnd(64, "0"),
      path: "billing/a.py",
      resembles_dismissed: {
        fingerprint: "7f".repeat(32),
        reason: "by design — the engine drops it",
      },
    });
    const plain = scanFinding({ fingerprint: "fc".padEnd(64, "0"), path: "billing/z.py" });
    expect(
      reportItems([flagged, plain]).map((i) => (i.t === "finding" ? i.finding.fingerprint : "")),
    ).toEqual([plain.fingerprint, flagged.fingerprint]);
    // The flag is re-read against the store at load: the dismissal it names must be there.
    const gone = scanFinding({
      fingerprint: "7f".repeat(32),
      path: "billing/old.py",
      state: "dismissed",
      dismissal: { reason: "by design — the engine drops it", at: "t", memory: "written" },
    });
    const { app, screen, type } = rig({ findings: [flagged, plain, gone] });
    expect(screen()).toMatch(/billing\/a\.py:88 {2}≈/);
    await driving(app, () => {
      type("j");
      type("j");
      expect(screen()).toContain(
        "≈ looks like a finding you dismissed: by design — the engine drops it",
      );
    });
  });

  it("a dismissed finding a re-scan no longer reports says so, and still reads dismissed: a dismissal is sticky", () => {
    const f = scanFinding({
      fingerprint: "fb".padEnd(64, "0"),
      state: "dismissed",
      dismissal: { reason: "by design", at: "t", memory: "written" },
      unreported: { run: "scan-9", sha: "8".repeat(40), at: "2026-09-30T10:00:00Z" },
    });
    const { screen } = rig({ findings: [f] });
    expect(screen()).toContain(`state: dismissed — "by design" · no longer reported at 8888888`);
  });

  it("a dismissed finding a re-scan no longer reports is not a promote target; an unstamped one is", () => {
    const gone = scanFinding({
      fingerprint: "fc".padEnd(64, "0"),
      state: "dismissed",
      unreported: { run: "scan-9", sha: "8".repeat(40), at: "t" },
    });
    const kept = scanFinding({ fingerprint: "fd".padEnd(64, "0"), state: "dismissed" });
    expect(promotable({ t: "finding", finding: gone })).toEqual([]);
    expect(promotable({ t: "finding", finding: kept })).toEqual([kept]);
  });

  it("a style group's detail carries the rule, the count and examples", () => {
    const f = SCAN_FINDINGS[2]!;
    expect(styleRule(f)).toBe("rule 4.2");
    expect(
      styleRule(scanFinding({ fingerprint: "x", claim: "tabs, not spaces", kind: "indent" })),
    ).toBe("indent");
    expect(styleRule(scanFinding({ fingerprint: "x", claim: "see §3.1.", kind: "style" }))).toBe(
      "rule 3.1",
    );
  });
});

describe("honest unknown — never 'no scan' for a record that was not read", () => {
  it("a run recorded as running while the companion is known down reads interrupted, and offers no stop", () => {
    const { app, screen } = rig({ companionUp: false });
    expect(screen()).toContain("⏸ interrupted — the companion is down; the ledger resumes it");
    expect(barLabels(app)).not.toContain("x stop");
  });

  it("a run a live driver lease names reads running while the companion is down — a `qcr scan` driver drives it", async () => {
    const { app, s, screen } = rig({ companionUp: false });
    mkdirSync(join(s.home, DRIVER_DIR), { recursive: true });
    writeFileSync(
      join(s.home, DRIVER_DIR, "1.json"),
      JSON.stringify({
        holder: "h",
        run: "scan-2",
        pid: 4242,
        host: "box",
        at: "2026-09-29T11:59:50Z",
      }),
    );
    await driving(app, () => {
      app.hooks.onPoll?.(app);
      expect(screen()).not.toContain("interrupted");
      expect(barLabels(app)).toContain("x stop");
    });
  });

  it("a lapsed driver lease does not: the run reads interrupted", async () => {
    const { app, s, screen } = rig({ companionUp: false });
    mkdirSync(join(s.home, DRIVER_DIR), { recursive: true });
    writeFileSync(
      join(s.home, DRIVER_DIR, "1.json"),
      JSON.stringify({
        holder: "h",
        run: "scan-2",
        pid: 1,
        host: "box",
        at: "2026-09-29T11:00:00Z",
      }),
    );
    await driving(app, () => {
      app.hooks.onPoll?.(app);
      expect(screen()).toContain("interrupted");
    });
  });

  it("a known-down companion's run paints its running unit interrupted too, never the green running mark", () => {
    const { screen } = rig({ companionUp: false });
    const text = screen();
    expect(text).toMatch(/⏸ auth\s+3/);
    expect(text).not.toMatch(/▶ auth/);
  });

  it("a run the companion answers it is not driving reads interrupted while the companion is up — and the tab offers what a finished run does", async () => {
    const { app, s, type, screen } = rig({ companionUp: true });
    await driving(app, () => {
      expect(barLabels(app)).toContain("x stop");
      expect(barLabels(app)).not.toContain("D delta");
      type("x");
      const req = JSON.parse(readFileSync(join(s.home, SCAN_STOP_FILE), "utf8"));
      // The companion restarted: it holds no run in flight.
      writeFileSync(
        join(s.home, SCAN_STOP_RESULT_FILE),
        JSON.stringify({
          request: req.id,
          run: "scan-2",
          at: "",
          ok: false,
          errors: ["no scan is running in this companion"],
          in_flight: null,
        }),
      );
      app.hooks.onPoll?.(app);
      const text = screen();
      expect(text).toContain(
        "⏸ interrupted — the companion is not driving it; the ledger resumes it",
      );
      expect(text).toMatch(/⏸ auth\s+3/);
      expect(barLabels(app)).not.toContain("x stop");
      expect(barLabels(app)).toContain("D delta");
    });
  });

  it("an unreadable stop answer is no answer — it never reads the run as interrupted", () => {
    const { s, screen } = rig({ companionUp: true });
    mkdirSync(join(s.home, SCAN_STOP_RESULT_FILE)); // EISDIR on read
    s.store.reload();
    expect(s.store.stopAnswer).toBeNull();
    expect(screen()).toMatch(/stage 1 ▶ running/);
  });

  it("an answer for another run, or one that does not say what is in flight, leaves the run running", () => {
    for (const answer of [
      { request: "r", run: "scan-1", at: "", ok: false, errors: [], in_flight: null },
      { request: "r", run: "scan-2", at: "", ok: false, errors: [] },
      { request: "r", run: "scan-2", at: "", ok: true, errors: [], in_flight: "scan-2" },
    ]) {
      const { s, screen } = rig({ companionUp: true });
      writeFileSync(join(s.home, SCAN_STOP_RESULT_FILE), JSON.stringify(answer));
      s.store.reload();
      expect(screen()).toMatch(/stage 1 ▶ running/);
    }
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
    expect(text).toMatch(
      /could not read — scan\/findings\.json is not a record this version reads/,
    );
    // The run still names its units; their counts are as unknown as the store.
    expect(text).toMatch(/▶ auth\s+—/);
    expect(text).not.toMatch(/· widget\s+0/);
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
    expect(parseScanFilter("dismissed nit valid")).toEqual({
      ok: true,
      filter: { state: "dismissed", severity: "nit", doubted: false },
    });
    expect(parseScanFilter("colour=red")).toMatchObject({
      ok: false,
      error: expect.stringContaining('"colour=red" is not a filter'),
    });
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
      type("]"); // billing: f1, the style group (confirmed), then f2 (doubtful)
      type("j");
      type("p");
      expect(s.asks).toHaveLength(1);
      expect(s.asks[0]!.verb).toBe("promote");
      const text = s.asks[0]!.text;
      expect(text).toMatch(
        /^The owner PROMOTED these 3 scan findings from the TUI's \[8\] scan tab:/,
      );
      for (const n of [3, 4, 5])
        expect(text).toContain(
          `- ${`f${n}`.padEnd(12, "0")} nit pass-style billing/views${n}.py:${n}`,
        );
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
      expect(s.asks[0]!.text).toContain(
        `- ${"f1".padEnd(12, "0")} P1 pass-data-safety billing/models.py:88`,
      );
      expect(s.asks[0]!.text).toContain("`scan_dismiss`");
    });
  });

  it("a promoted or fixed finding offers neither verb — triage.ts would refuse them", async () => {
    const promoted = scanFinding({
      fingerprint: "p1".padEnd(64, "0"),
      state: "promoted",
      ticket: { sink: "tracker", ref: "", effort: "x", filed_at: "" },
    });
    const fixed = scanFinding({
      fingerprint: "x1".padEnd(64, "0"),
      severity: "P2",
      state: "fixed",
    });
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
      writeFileSync(
        join(s.home, STAGE2_RESULT_FILE),
        JSON.stringify({
          request: req.id,
          key: req.key,
          at: "",
          ok: true,
          run: "scan-9",
          errors: [],
        }),
      );
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
      expect(
        JSON.parse(readFileSync(join(s.home, STAGE2_START_FILE), "utf8")).rows,
      ).toBeUndefined();
    });
  });

  it("a deep proposal: the title splits the companion's rows from the floor, the floor rows window like any row and show their reason", async () => {
    const { app, s, type, screen } = rig({ running: false });
    const stored = JSON.parse(readFileSync(join(s.home, STAGE2_FILE), "utf8"));
    const own = stored.proposal.rows[0];
    const floor = Array.from({ length: 60 }, (_, i) => ({
      ...own,
      id: `floor-${i + 1}`,
      lens: "pass-consistency",
      tier: "sol-med",
      reason: `deep floor: pass-consistency over unit${i + 1}`,
      units: [`unit${i + 1}`],
      estimate_usd: 0.5,
      floor: true,
    }));
    stored.proposal = {
      ...stored.proposal,
      key: "deepkey000000001",
      depth: "deep",
      budget_usd: null,
      rows: [own, ...floor],
      runnable: 61,
      cap_usd: 36.1,
      over_budget_usd: 0,
    };
    writeFileSync(join(s.home, STAGE2_FILE), JSON.stringify(stored));
    s.store.reload();
    await driving(app, () => {
      type("P");
      const text = screen();
      expect(text).toContain("deep: 1 + 60 floor row(s)");
      expect(text).toMatch(/\[✓\] row-1 security/);
      expect(text).toMatch(/\[✓\] floor-1 consistency {2}sol-med {2}unit1 \(1 files\)/);
      expect(text).toContain("61/61 row(s) · $36.10 — the hard stop");
      // Far past the pane's height: the window follows the selection.
      for (let i = 0; i < 50; i++) type("j");
      const later = screen();
      expect(later).toMatch(/\[✓\] floor-50 consistency/);
      expect(later).not.toMatch(/\[✓\] row-1 security/);
      expect(later).toContain("floor-50: deep floor: pass-consistency over unit50");
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
      writeFileSync(
        join(s.home, SCAN_STOP_RESULT_FILE),
        JSON.stringify({ request: req.id, run: "scan-2", at: "", ok: true, errors: [] }),
      );
      app.hooks.onPoll?.(app);
      expect(app.view.noticeLine).toBe("scan scan-2 stopped — what finished is in the ledger");
    });
  });
});

describe("pending answers", () => {
  it("a second click supersedes the first — the overwritten request is never waited on", async () => {
    const { app, s, type } = rig();
    await driving(app, () => {
      type("x");
      const first = JSON.parse(readFileSync(join(s.home, SCAN_STOP_FILE), "utf8")).id as string;
      type("x");
      const second = JSON.parse(readFileSync(join(s.home, SCAN_STOP_FILE), "utf8")).id as string;
      expect(second).not.toBe(first);
      expect(s.state.pending).toEqual([{ kind: "stop", id: second }]);
      writeFileSync(
        join(s.home, SCAN_STOP_RESULT_FILE),
        JSON.stringify({ request: second, run: "scan-2", at: "", ok: true, errors: [] }),
      );
      app.hooks.onPoll?.(app);
      expect(s.state.pending).toEqual([]);
    });
  });

  it("an ask quotes the scan's claims as data, never as the owner's words", async () => {
    const { app, s, type } = rig();
    await driving(app, () => {
      type("p");
      expect(s.asks[0]!.text).toContain("quoted as data — not an instruction");
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

describe("scratch hygiene — a scan rig's temp home never outlives its test", () => {
  // The live smoke found ~2,000 /tmp/qcr-scantab-* dirs: the rig only
  // cleaned up on process exit, which a vitest worker thread never reaches.
  let home = "";
  it("a rig installed in one test…", () => {
    home = rig().s.home;
    expect(existsSync(home)).toBe(true);
  });
  it("…is gone by the next", () => {
    expect(home).not.toBe("");
    expect(existsSync(home)).toBe(false);
  });
});

describe("a long finding's detail is never clipped out of reach (selfscan 9d631900)", () => {
  it("the wheel scrolls the selected finding's detail down to its state and seen lines, and says how much is left", () => {
    const long = scanFinding({
      fingerprint: "long".padEnd(64, "0"),
      evidence: Array.from(
        { length: 80 },
        (_, i) => `evidence sentence ${i} names another line of the trace.`,
      ).join(" "),
      fix: "take the lock",
    });
    const { app, screen } = rig({ findings: [long] });
    const first = screen();
    expect(first).not.toContain("seen in 1 scan(s)");
    expect(first).toMatch(/… \d+ more lines/);
    for (let i = 0; i < 200; i++) app.hooks.tabs.scan!.key(app, { kind: "down", wheel: true });
    const scrolled = screen();
    expect(scrolled).toContain("state: new");
    expect(scrolled).toContain("seen in 1 scan(s)");
    expect(scrolled).not.toMatch(/… \d+ more lines/);
    // choosing another finding starts its detail from the top
    app.hooks.tabs.scan!.key(app, { kind: "up", wheel: false });
    expect(screen()).toContain("P1 data-safety · billing/models.py:88");
  });
});

describe("a finding's detail paragraph reaches the detail pane (selfscan fc1128ac)", () => {
  it("the failure mechanism a P0–P2 finding carries in `detail` is shown beside its evidence", () => {
    const f = scanFinding({
      fingerprint: "detail".padEnd(64, "0"),
      detail: "two workers read the balance before either writes it back, so one debit is lost",
    });
    const { screen } = rig({ findings: [f] });
    expect(screen()).toContain("detail: two workers read the balance");
  });
});

describe("validity tiers (the scan validator is the skeptic)", () => {
  const tiered = [
    scanFinding({
      fingerprint: "t1".padEnd(64, "0"),
      severity: "P3",
      path: "billing/a.py",
      validity: "confirmed",
      scenario: "the nightly job passes an empty batch",
    }),
    scanFinding({
      fingerprint: "t2".padEnd(64, "0"),
      severity: "P0",
      path: "billing/b.py",
      validity: "likely",
      scenario: "mechanism real; no caller traced",
    }),
    scanFinding({
      fingerprint: "t3".padEnd(64, "0"),
      severity: "P0",
      path: "billing/c.py",
      validity: "doubtful",
      doubt: {
        word: "refuted",
        reason: "the gate refuses it at gate.ts:40",
        class: "guarded-elsewhere",
      },
    }),
    scanFinding({
      fingerprint: "t4".padEnd(64, "0"),
      severity: "P1",
      path: "billing/d.py",
      validity: null,
      validated: false,
      scenario: null,
    }),
  ];

  it("groups the list by tier — confirmed first, whatever the severity — each tier under its own heading", () => {
    const items = reportItems(tiered);
    expect(items.map((i) => itemValidity(i))).toEqual([
      "confirmed",
      "likely",
      "doubtful",
      "unknown",
    ]);
    const { screen } = rig({ findings: tiered });
    const text = screen();
    const order = [
      "CONFIRMED — the skeptic traced",
      "billing/a.py",
      "LIKELY —",
      "billing/b.py",
      "DOUBTFUL —",
      "billing/c.py",
      "UNKNOWN — no skeptic judged",
      "billing/d.py",
    ];
    const at = order.map((o) => text.indexOf(o));
    expect(at.every((x) => x >= 0)).toBe(true);
    expect([...at].sort((a, b) => a - b)).toEqual(at);
    expect(text).toContain("4 findings · 1 confirmed · 1 likely · 1 doubtful · 1 unknown");
    expect(text).toContain("✔ confirmed — the nightly job passes an empty batch");
  });

  it("tier headings count against the list's row budget, so a short terminal still shows the selected finding's detail", () => {
    const { app } = rig({ findings: tiered });
    for (const rows of [16, 17, 18, 20]) {
      const text = app.hooks.tabs.scan!.screen(app, COLS, rows).lines.map(stripAnsi).join("\n");
      expect(text, `rows=${rows}`).toContain("CONFIRMED — the skeptic traced");
      expect(text, `rows=${rows}`).toContain("P3 data-safety · billing/a.py:88-90");
    }
  });

  it("a doubtful finding's detail carries the skeptic's word, class and reason; an unjudged one says unknown", async () => {
    const { app, type, screen } = rig({ findings: tiered });
    await driving(app, () => {
      type("j");
      type("j");
      expect(screen()).toContain(
        "? doubtful — refuted [guarded-elsewhere]: the gate refuses it at gate.ts:40",
      );
      type("j");
      expect(screen()).toContain("not validated — no validator read it (validity unknown)");
    });
  });

  it("the tier filter: `tier=`/bare words in the f box, and t steps all → confirmed → likely → doubtful → unknown → all", async () => {
    expect(parseScanFilter("tier=likely")).toEqual({ ok: true, filter: { validity: "likely" } });
    expect(parseScanFilter("doubtful new")).toEqual({
      ok: true,
      filter: { validity: "doubtful", state: "new" },
    });
    expect(filterLabel({ validity: "unknown" })).toBe("tier=unknown");
    expect(matchesFilter({ validity: "unknown" }, tiered[3]!)).toBe(true);
    expect(matchesFilter({ validity: "unknown" }, tiered[0]!)).toBe(false);
    expect(
      [undefined, "confirmed", "likely", "doubtful", "unknown"].map((v) => nextTier(v as never)),
    ).toEqual(["confirmed", "likely", "doubtful", "unknown", undefined]);
    const { app, type, screen } = rig({ findings: tiered });
    await driving(app, () => {
      expect(barLabels(app)).toContain("t tier");
      type("t");
      expect(screen()).toContain("FINDINGS (all units) (1) · tier=confirmed (F clears)");
      type("t");
      expect(screen()).toContain("· tier=likely (F clears)");
      type("t");
      type("t");
      type("t");
      expect(screen()).toContain("FINDINGS (all units) (4)");
    });
  });

  it("p promotes a confirmed finding at once; an unconfirmed one only after an explicit yes, flagged for the companion", async () => {
    const { app, s, type } = rig({ findings: tiered });
    await driving(app, () => {
      type("p"); // t1, confirmed
      expect(s.asks).toHaveLength(1);
      expect(s.asks[0]!.text).not.toContain("unconfirmed: true");
      type("j"); // t2, likely
      type("p");
      expect(s.asks).toHaveLength(1);
      expect(app.view.inputBox?.target).toMatch(
        /NOT confirmed by the skeptic \(likely\) — type yes/,
      );
      type("no");
      type("\r");
      expect(s.asks).toHaveLength(1);
      expect(app.view.noticeLine).toMatch(
        /not asked — only confirmed findings promote without an explicit yes/,
      );
      type("p");
      type("yes");
      type("\r");
      expect(s.asks).toHaveLength(2);
      expect(s.asks[1]!.text).toContain("pass `unconfirmed: true` to `scan_promote`");
      expect(s.asks[1]!.text).toContain(`- ${"t2".padEnd(12, "0")} P0`);
    });
  });
});
