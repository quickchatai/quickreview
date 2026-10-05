// the seven surfaces (ratified layout; the eighth,
// `scan`), and the fences that keep them honest:
//
//   * eight named tabs, one vocabulary, each reachable by its digit — and the
//     retired names (`changes`, the `digest` tab id for tab [2]) refused;
//   * no hidden mode: the `v` toggle, the full-screen detail page and the
//     `changes` tab are GONE from the source, not merely unreachable;
//   * the key law — what a surface paints is what it registers, and every
//     printable it does not register reaches the companion column untouched;
//   * the board's verbs are the board's: off it they do nothing, and with a
//     column present they are plain text for pi;
//   * docs/tui.md and the code vocabulary agree, table for table;
//   * the three-way empty grammar has one spelling.
//
// Each fence names its mutation: apply it, watch this go red, revert.
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { parseTuiAction } from "../src/tui/actions.js";
import type { Tab } from "../src/tui/app.js";
import {
  barHeight,
  GLOBAL_KEYS,
  registeredKeys,
  TAB_INLINE_KEYS,
  TAB_VOCABULARY,
  type BarButton,
} from "../src/tui/cmdbar.js";
import { countLabel, emptyLine } from "../src/tui/emptystate.js";
import { decodeKey, keyChar } from "../src/tui/keys.js";
import { stripAnsi } from "../src/tui/paint.js";
import { CompanionSidebar } from "../src/tui/sidebar.js";
import { isTab, TABS, tabDigit, tabForDigit } from "../src/tui/tabs.js";
import { installDeployHooks } from "../src/tui/deploytab.js";
import { installMetricsHooks } from "../src/tui/metricstab.js";
import { installMessageHooks } from "../src/tui/msg.js";
import {
  FakeChanges,
  changeEntry,
  installScanRig,
  learningRig,
  settle,
  type Rig,
} from "./helpers/tui-rig.js";
import { HEAVY_TIMEOUT_MS } from "./helpers/suite-timeouts.js";

const ROOT = join(import.meta.dirname, "..");
const TUI = join(ROOT, "src", "tui");
const PRINTABLE_ASCII = Array.from({ length: 95 }, (_, i) => String.fromCharCode(32 + i));
const printable = (k: string): boolean => k.length === 1 && k >= " " && k <= "~";

function tuiSources(): Array<[string, string]> {
  return readdirSync(TUI)
    .filter((n) => n.endsWith(".ts"))
    .map((n) => [n, readFileSync(join(TUI, n), "utf8")] as [string, string]);
}

/** Every surface installed over fakes, with data under every pane. */
function fullRig(): Rig & { docker: string[][] } {
  const rig = learningRig({
    cols: 160,
    rows: 40,
    readTickets: () => [
      {
        id: "",
        title: "t",
        status: "open",
        role: "—",
        category: "—",
        updated: "2026-08-25T18:00:00Z",
        path: "/t",
        body: "# t\n\nbody",
      },
    ],
    changes: new FakeChanges([changeEntry("a".repeat(40), "c")]),
  });
  rig.learning.store.reloadTickets();
  rig.app.view.snapshot = {
    written_at: "",
    dry_run: false,
    prs: [
      {
        number: 5012,
        state: "reviewing",
        title: "t",
        head_sha: "x",
        stale_recheck: 0,
        author: "alice",
      },
    ],
    running_rounds: 0,
    total_spend_usd: 0,
    heartbeat: "",
  };
  rig.app.view.repo = "exampleorg/example-app";
  installMetricsHooks(rig.app, {
    overall: async () => ({ error: "rig" }),
    timeline: async () => ({ error: "rig" }),
  } as never);
  installDeployHooks(rig.app, {
    load: async () => ({ dirty: [], plan: [], containerStatus: "Up 2 hours" }),
  } as never);
  installMessageHooks(rig.app, { send: async () => {} });
  installScanRig(rig.app);
  const docker: string[][] = [];
  rig.app.sidebar = new CompanionSidebar(
    { container_name: "c", session: "s" },
    async (argv) => {
      docker.push(argv);
      return { ok: true, stdout: "", stderr: "", code: 0 };
    },
    { available: () => true },
  );
  return { ...rig, docker };
}

async function settled(rig: Rig, tab: Tab): Promise<void> {
  rig.app.tab = tab;
  if (tab !== "board") rig.app.hooks.tabs[tab]!.screen(rig.app, 160, 40);
  await settle(20);
}

describe("eight surfaces, one vocabulary", () => {
  it("the eight, in digit order, each reachable by its digit and by name", () => {
    expect([...TABS]).toEqual([
      "board",
      "memory",
      "digest",
      "tickets",
      "deploy",
      "metrics",
      "feedback",
      "scan",
    ]);
    for (const tab of TABS) {
      expect(tabForDigit(tabDigit(tab))).toBe(tab);
      expect(decodeKey(Buffer.from(tabDigit(tab)))).toEqual({ kind: "tab", tab });
      expect(keyChar({ kind: "tab", tab })).toBe(tabDigit(tab));
      expect(isTab(tab)).toBe(true);
      const parsed = parseTuiAction(JSON.stringify({ verb: "switch_tab", params: { tab } }));
      expect(parsed).toEqual({ ok: true, action: { verb: "switch_tab", tab } });
    }
    expect(tabForDigit("9")).toBeUndefined();
    expect(decodeKey(Buffer.from("9"))).toEqual({ kind: "char", ch: "9" });
  });

  it("the retired names are refused everywhere, not aliased (hard cut)", () => {
    for (const old of ["changes", "learning", "companion"]) {
      expect(isTab(old)).toBe(false);
      expect(
        parseTuiAction(JSON.stringify({ verb: "switch_tab", params: { tab: old } })),
      ).toMatchObject({ ok: false });
    }
  });

  it(
    "every installed surface paints its own name in the title bar and lights its own nav slot",
    { timeout: HEAVY_TIMEOUT_MS },
    async () => {
      const rig = fullRig();
      for (const tab of TABS) {
        await settled(rig, tab);
        const frame =
          tab === "board" ? undefined : rig.app.hooks.tabs[tab]!.screen(rig.app, 160, 40);
        if (!frame) continue;
        const plain = frame.lines.map(stripAnsi);
        expect(plain[0], tab).toMatch(new RegExp(`── ${tab}\\b`));
        expect(plain.join("\n")).toContain(`[${tabDigit(tab)} ${tab}]`);
      }
    },
  );
});

describe("no hidden mode survives", () => {
  it("the `v` toggle, the full-screen detail page and the changes tab are gone from the source", () => {
    expect(existsSync(join(TUI, "changestab.ts"))).toBe(false);
    for (const [name, text] of tuiSources()) {
      expect(text, `${name} still carries the detail page`).not.toMatch(/detailFull/);
      expect(text, `${name} still branches on a \`v\` key`).not.toMatch(/ch === "v"|"v", label/);
      // A tab-shaped use of the retired name: a comparison, a union member, a
      // switch case or a record key. (`state/changes` — the register's DIR —
      // is a path segment, not a tab, and stays.)
      expect(text, `${name} still knows a "changes" tab`).not.toMatch(
        /tab\s*[!=]==?\s*"changes"|"changes"\s*\|\s*"|\|\s*"changes"|case "changes"|"changes"\s*:/,
      );
    }
    // `w` and `v` decode as plain text — the companion's, like any other letter.
    expect(decodeKey(Buffer.from("w"))).toEqual({ kind: "char", ch: "w" });
    expect(decodeKey(Buffer.from("v"))).toEqual({ kind: "char", ch: "v" });
  });

  it("App has one hook surface per tab and no per-tab hook names left over", () => {
    const rig = fullRig();
    const hooks = rig.app.hooks as unknown as Record<string, unknown>;
    for (const stale of [
      "digestScreen",
      "digestKey",
      "digestClick",
      "deployScreen",
      "deployKey",
      "deployClick",
      "metricsScreen",
      "metricsKey",
      "metricsClick",
      "changesScreen",
      "changesKey",
      "changesClick",
    ]) {
      expect(stale in hooks, stale).toBe(false);
    }
    expect(Object.keys(rig.app.hooks.tabs).sort()).toEqual([
      "deploy",
      "digest",
      "feedback",
      "memory",
      "metrics",
      "scan",
      "tickets",
    ]);
  });

  it("the full-screen page's remembered route — a second click on the selected PR — focuses the embedded pane instead", async () => {
    const rig = fullRig();
    const running = rig.app.run();
    rig.app.repaint();
    // Nothing is selected yet: the first click selects the row, the second
    // is the remembered route.
    const frame = (
      rig.app as unknown as {
        lastFrame: { zones: Array<{ x1: number; y1: number; action: { t: string; pr?: number } }> };
      }
    ).lastFrame;
    const row = frame.zones.find((z) => z.action.t === "select-pr" && z.action.pr === 5012)!;
    rig.streams.type(`\x1b[<0;${row.x1};${row.y1}M`);
    rig.streams.type(`\x1b[<0;${row.x1};${row.y1}M`);
    expect(rig.app.piFocused()).toBe(true);
    expect(rig.app.tab).toBe("board");
    rig.app.quit();
    await running;
  });
});

describe("the key law: painted ⇔ registered ⇔ answers", () => {
  /** The `[label]`s on the bar rows, minus the nav slots and globals. */
  function paintedCommands(
    lines: string[],
    tab: Tab,
    cols: number,
    barKeys: readonly BarButton[],
  ): string[] {
    const h = barHeight(tab, cols, barKeys);
    const rows = lines.slice(lines.length - 1 - h, lines.length - 1).map(stripAnsi);
    const chrome = new Set([
      ...TABS.map((t) => `${tabDigit(t)} ${t}`),
      "r refresh",
      "s ssh",
      "? help",
      "q quit",
    ]);
    // A label may START with `]` (`] scroll down`), so the first cell of the
    // label is allowed to be the closing glyph.
    return rows
      .flatMap((r) => [...r.matchAll(/\[(\]?[^\]]*)\]/g)].map((m) => m[1]!))
      .filter((l) => !chrome.has(l));
  }

  /**
   * MUTATION: in `feedbackKeys` drop `{ key: "t", label: "t focus" }` while
   * `renderFeedbackTab` keeps painting it — impossible by construction (both
   * read the same function), which is the point; instead paint an extra
   * `[Z zap]` on any tab's bar and this fails for that tab.
   */
  it(
    "every surface paints exactly the bar its live keys declare, drawn from its vocabulary",
    { timeout: HEAVY_TIMEOUT_MS },
    async () => {
      const rig = fullRig();
      for (const tab of TABS) {
        await settled(rig, tab);
        const live = rig.app.liveKeys();
        const frame =
          tab === "board"
            ? (await import("../src/tui/board.js")).renderBoard(rig.app.view, 160, 40)
            : rig.app.hooks.tabs[tab]!.screen(rig.app, 160, 40);
        expect(paintedCommands(frame.lines, tab, 160, live.bar), tab).toEqual(
          live.bar.map((b) => b.label),
        );
        const vocab = new Set(TAB_VOCABULARY[tab].map((b) => b.key));
        for (const b of live.bar)
          expect(
            vocab.has(b.key),
            `${tab} paints ${JSON.stringify(b.key)} outside its vocabulary`,
          ).toBe(true);
        for (const k of live.inline) expect(TAB_INLINE_KEYS[tab]).toContain(k);
        expect(rig.app.registeredKeys()).toEqual(registeredKeys(live));
        expect(live.bar.length, `${tab} paints nothing — the rig is under-wired`).toBeGreaterThan(
          0,
        );
      }
    },
  );

  /**
   * The reverse of [T1], and what makes state-derivation worth having: a key
   * the surface does NOT register must reach the companion column — a tab
   * handler that consumes a key it never claimed steals it just as a dead
   * registration does.
   *
   * MUTATION: make the memory tab's key handler `return true` for
   * `key.kind === "char" && key.ch === "z"` — this fails naming `z` on memory.
   */
  it(
    "every printable a surface does not register focuses the companion column, seeded, and moves nothing else",
    { timeout: HEAVY_TIMEOUT_MS },
    async () => {
      for (const tab of TABS) {
        const rig = fullRig();
        await settled(rig, tab);
        const running = rig.app.run();
        const registered = rig.app.registeredKeys();
        const stolen: string[] = [];
        // `view.now` is the board's paint clock and moves on every repaint —
        // the sidebar focus repaints — so it is not state a key could steal.
        const viewSnapshot = (): string => JSON.stringify({ ...rig.app.view, now: undefined });
        for (const ch of PRINTABLE_ASCII) {
          if (registered.has(ch)) continue;
          rig.app.sidebar!.blur();
          const before = { tab: rig.app.tab, view: viewSnapshot() };
          rig.streams.type(ch);
          if (
            !rig.app.sidebar!.focused ||
            rig.app.tab !== before.tab ||
            viewSnapshot() !== before.view
          )
            stolen.push(ch);
        }
        expect(stolen, `printables tab '${tab}' swallowed without registering them`).toEqual([]);
        rig.app.sidebar!.blur();
        rig.app.quit();
        await running;
      }
    },
  );

  it("with no PR selected the board offers no PR verb — an unwedge with nothing under it is an action from no data", () => {
    const rig = fullRig();
    rig.app.view.snapshot = undefined;
    const live = rig.app.liveKeys();
    // `e` (events) and `I` (setup) are about the repo, not a PR.
    expect(live.bar.map((b) => b.key)).toEqual(["e", "I"]);
    expect(live.inline).toEqual([]);
    for (const k of ["u", "m", "g", "a"]) expect(rig.app.registeredKeys().has(k)).toBe(false);
  });
});

describe("the board's verbs are the board's", () => {
  /**
   * The board's verb letters, pressed on every other surface with no column
   * to hand them to. Where a surface registers the letter for ITS OWN verb
   * (`e` edits on memory, `a` toggles the archive on feedback, `m` is the
   * 30-day window on metrics) the key is that surface's and is fenced by
   * [T1]; everywhere else the letter must move nothing at all — never the
   * board's verb behind the operator's back, never the selection.
   */
  it(
    "u, e, m, g and a do nothing off the board with no column to hand them to",
    { timeout: HEAVY_TIMEOUT_MS },
    async () => {
      const rig = fullRig();
      rig.app.sidebar = undefined;
      let unwedged = 0;
      rig.app.hooks.unwedge = () => void (unwedged += 1);
      rig.app.selectPr(5012);
      const running = rig.app.run();
      let checked = 0;
      for (const tab of TABS.filter((t) => t !== "board")) {
        await settled(rig, tab);
        const registered = rig.app.registeredKeys();
        for (const k of ["u", "e", "m", "g", "a"].filter((k) => !registered.has(k))) {
          const before = JSON.stringify(rig.app.view);
          rig.streams.type(k);
          checked += 1;
          expect(unwedged, `${tab}:${k}`).toBe(0);
          expect(rig.app.piFocused(), `${tab}:${k}`).toBe(false);
          expect(JSON.stringify(rig.app.view), `${tab}:${k}`).toBe(before);
          expect(rig.app.tab, `${tab}:${k}`).toBe(tab);
        }
      }
      expect(checked).toBeGreaterThan(20); // the rig is wired: most letters are unregistered off the board
      rig.app.quit();
      await running;
    },
  );

  it("…and on the board they work", async () => {
    const rig = fullRig();
    rig.app.sidebar = undefined;
    let unwedged = 0;
    rig.app.hooks.unwedge = () => void (unwedged += 1);
    const opened: string[] = [];
    rig.app.hooks.openUrl = (u) => opened.push(u);
    rig.app.selectPr(5012);
    const running = rig.app.run();
    rig.streams.type("u");
    expect(unwedged).toBe(1);
    rig.streams.type("e");
    expect(rig.app.view.eventsFocus).toBe(true);
    rig.streams.type("e");
    rig.streams.type("g");
    expect(opened).toEqual(["https://github.com/exampleorg/example-app/pull/5012"]);
    rig.app.quit();
    await running;
  });
});

describe("docs/tui.md is the contract the code is pinned to", () => {
  const doc = readFileSync(join(ROOT, "docs", "tui.md"), "utf8");

  /** The single-character keys named in the first column of a `### <tab>` table. */
  function documented(tab: string): Set<string> {
    const section = new RegExp(`### ${tab}\\n([\\s\\S]*?)(?=\\n### |\\n## |$)`).exec(doc)?.[1];
    expect(section, `docs/tui.md has no "### ${tab}" key table`).toBeTruthy();
    const keys = new Set<string>();
    for (const line of section!.split("\n")) {
      const cell = /^\|\s*([^|]+?)\s*\|/.exec(line)?.[1];
      if (!cell || cell === "key" || /^-+$/.test(cell)) continue;
      for (const m of cell.matchAll(/`([^`]+)`/g)) if (printable(m[1]!)) keys.add(m[1]!);
    }
    return keys;
  }

  /**
   * MUTATION: delete the `| \`u\` |` row from the board table in docs/tui.md —
   * this fails naming board:u. Add `{ key: "Z", label: "Z zap" }` to
   * `TAB_VOCABULARY.memory` — this fails naming memory:Z.
   */
  it("each surface's table names every bar key in its vocabulary, and nothing outside its universe", () => {
    for (const tab of TABS) {
      const docKeys = documented(tab);
      const bar = TAB_VOCABULARY[tab].map((b) => b.key).filter(printable);
      const universe = new Set([...bar, ...TAB_INLINE_KEYS[tab], ...GLOBAL_KEYS]);
      for (const k of bar)
        expect(docKeys.has(k), `${tab}:${k} is on the bar but not in docs/tui.md`).toBe(true);
      for (const k of docKeys)
        expect(universe.has(k), `${tab}:${k} is documented but no code offers it`).toBe(true);
    }
  });

  it("the surfaces table lists exactly the eight, in digit order, and the globals table names the global keys", () => {
    const rows = [...doc.matchAll(/^\| (\d) \| \*\*(\w+)\*\* \|/gm)].map((m) => [m[1], m[2]]);
    expect(rows).toEqual(TABS.map((t) => [tabDigit(t), t]));
    const globals = documented("everywhere");
    for (const k of ["r", "s", "?", "q", "j", "k", "/"]) expect(globals.has(k), k).toBe(true);
  });
});

describe("the three-way empty grammar has one spelling", () => {
  it("a count is a claim: unknown renders as (—), never as (0)", () => {
    expect(countLabel(undefined)).toBe("(—)");
    expect(countLabel(0)).toBe("(0)");
    expect(countLabel(12)).toBe("(12)");
  });

  it("the four lines are told apart by their opening words", () => {
    expect(stripAnsi(emptyLine({ kind: "none", what: "the sweep writes it" }))).toBe(
      "none yet — the sweep writes it",
    );
    expect(stripAnsi(emptyLine({ kind: "filtered", what: "F clears" }))).toBe(
      "none matching — F clears",
    );
    expect(
      stripAnsi(emptyLine({ kind: "unread", how: "the scan runs behind the first frame" })),
    ).toBe("not read yet — the scan runs behind the first frame");
    expect(stripAnsi(emptyLine({ kind: "unreadable", why: "ENOENT" }))).toBe(
      "could not read — ENOENT",
    );
  });

  it("no surface renders a bare 'none' or a '(0)' it has not read — checked on the unloaded frames", () => {
    // Nothing has loaded: every list is unknown, so no zero may appear.
    const rig = learningRig({
      cols: 160,
      rows: 40,
      readTickets: () => [],
      changes: new FakeChanges(),
    });
    for (const tab of ["memory", "digest", "tickets", "feedback"] as const) {
      const plain = stripAnsi(rig.app.hooks.tabs[tab]!.screen(rig.app, 160, 40).render());
      expect(plain, tab).not.toMatch(/\(0\)|\(0 /);
      expect(plain, tab).not.toMatch(/\bnone yet\b/);
    }
  });
});
