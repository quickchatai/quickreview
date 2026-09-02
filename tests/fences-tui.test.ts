// the TUI half of the structural fences. See tests/fences.test.ts
// for the three rules this file is written under; the second one bites hardest
// here.
//
// [T1] is the single highest-value check the dead-surface inventory proposed,
// and the reason is the failure MODE, not the count: a registered key with no
// reachable effect does not merely do nothing — `App.handleInput` routes any
// printable that is NOT in `registeredKeys(this.tab)` to the companion column,
// so a dead registration STEALS the keystroke. The operator types a character
// meant for pi and it vanishes. Six such registrations were shipped
// ([C1]-[C6]) and nothing could see them.
import { EventEmitter } from "node:events";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { TUI_DEFAULTS } from "../src/config.js";
import type { StatusSnapshot } from "../src/state.js";
import type { MemoryEntry, MemoryStore } from "../src/memory/store.js";
import { App, type Tab } from "../src/tui/app.js";
import { HELP_LINES, renderBoard } from "../src/tui/board.js";
import { installChangesHooks } from "../src/tui/changestab.js";
import { registeredKeys } from "../src/tui/cmdbar.js";
import { installDeployHooks } from "../src/tui/deploytab.js";
import { installMemoryLearningHooks } from "../src/tui/memtab.js";
import { installMetricsHooks } from "../src/tui/metricstab.js";
import { installMessageHooks } from "../src/tui/msg.js";
import type { RemoteResult } from "../src/tui/remote.js";

const ROOT = join(import.meta.dirname, "..");
const TABS: Tab[] = ["board", "digest", "deploy", "metrics", "changes"];

const SNAPSHOT: StatusSnapshot = {
  written_at: "2026-08-20T12:00:00Z",
  dry_run: true,
  prs: [
    { number: 5012, state: "reviewing", title: "fix(crm): retry", head_sha: "aa11", stale_recheck: 0, author: "alice" },
    { number: 5049, state: "awaiting_author", title: "feat: dispatch", head_sha: "bb22", stale_recheck: 0, author: "bob" },
  ],
  running_rounds: 0,
  total_spend_usd: 0,
  heartbeat: "2026-08-20T12:00:00Z",
};

function fakeStreams() {
  const out = new EventEmitter() as unknown as NodeJS.WriteStream;
  let buf = "";
  (out as unknown as { columns: number }).columns = 140;
  (out as unknown as { rows: number }).rows = 40;
  out.write = ((s: string) => ((buf += s), true)) as never;
  const input = new EventEmitter() as unknown as NodeJS.ReadStream;
  (input as unknown as { isTTY: boolean }).isTTY = false;
  input.resume = (() => input) as never;
  input.pause = (() => input) as never;
  return { out, input, written: () => buf, clear: () => (buf = "") };
}

// ---------------------------------------------------------------------------
// [T9] The bar, the help overlay and the registration table must agree
// ---------------------------------------------------------------------------

describe("[T9] HELP_LINES and the registered keys agree", () => {
  /**
   * Three tables describe the same key surface — `TAB_COMMANDS` (what the bar
   * paints), `TAB_EXTRA_KEYS` (what a tab consumes beyond its buttons, reached
   * only through `registeredKeys`) and `HELP_LINES` (what `?` tells the
   * operator). Nothing checked them against each other, so `u unwedge`, `\`,
   * `W` and `F` were live keys the help never mentioned ([C14]), and
   * the help promised a full-screen attach that ⏎/`a` no longer do ([H4]).
   *
   * The direction asserted here is the one that misleads an operator: a key
   * the help NAMES must be registered on some tab. The reverse (every
   * registered key is documented) is deliberately NOT asserted — see the
   * second test.
   *
   * MUTATION: add `"Z            does something"` to HELP_LINES — this fails
   * naming Z.
   */
  it("every key the help overlay names is registered on at least one tab", () => {
    const registeredAnywhere = new Set(TABS.flatMap((t) => [...registeredKeys(t)]));

    // The key column: text before a run of 2+ spaces. Continuation lines start
    // with the body indent and declare no key of their own.
    const named = new Set<string>();
    for (const line of HELP_LINES) {
      if (/^\s/.test(line) || line.trim() === "" || line.trim().endsWith(":")) continue;
      const col = /^(\S(?:.*?\S)?)\s{2,}/.exec(line)?.[1];
      if (!col) continue;
      for (const tok of col.split(/\s*\/\s*/)) {
        // Single printable characters only — the column also carries glyphs
        // and chords (`⏎`, `↓/↑`, `Ctrl-c ×3`) that are not registered keys.
        if (tok.length === 1 && tok >= " " && tok <= "~") named.add(tok);
      }
    }
    expect(named.size, "no key was extracted from HELP_LINES — the parse broke and this asserts nothing").toBeGreaterThan(5);

    const undocumented = [...named].filter((k) => !registeredAnywhere.has(k)).sort();
    expect(
      undocumented,
      "the help overlay names a key no tab registers — the operator is told to press something that goes to the companion column",
    ).toEqual([]);
  });

  /**
   * The reverse direction, as a RECORD rather than an assertion.
   *
   * Requiring every registered key to appear in the help would be the obvious
   * mirror, and it is the wrong bar: the help is a curated overlay, not a
   * dump, and `j`/`k`/digits do not need a line each. What is worth pinning is
   * that the undocumented set does not grow silently — so it is enumerated,
   * and a new undocumented key fails here and must be either documented or
   * added to the list on purpose.
   *
   * MUTATION: add a key to `TAB_COMMANDS.deploy` — this fails naming it.
   */
  it("the set of registered-but-undocumented keys is exactly the one recorded", () => {
    const helpText = HELP_LINES.join("\n");
    const undocumented = [...new Set(TABS.flatMap((t) => [...registeredKeys(t)]))]
      .filter((k) => k.length === 1 && k >= " " && k <= "~")
      .filter((k) => !new RegExp(`(^|[\\s/(])${k.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}([\\s/)]|$)`, "m").test(helpText))
      .sort();

    // Each of these is a key the overlay never mentions. Recorded, not
    // excused: if this list grows, the change either documents the key or
    // states here why it needs no line.
    //
    // HONEST LIMIT, stated because it changes what a pass means here: the
    // test for "documented" is that the key CHARACTER appears somewhere in
    // the overlay's text, so a key named only in passing prose ("R arms a
    // revert", "7 / 0 / a switch the window") counts as documented. That is
    // weak, and deliberately so — this fence detects DRIFT in the key surface,
    // it does not grade the help.
    expect(undocumented).toEqual(
      [
        "?", // opens this very overlay, and the overlay never names it
        "A", // digest: accept a rubric proposal
        "F", // clear the active filter — [C14]
        "W", // memory: open the OpenViking studio — [C14]
        "Y", // changes: confirm-all a revert
        "n", // digest/memory: new entry
        "p", // memory: pin
        "t", // memory: focus
        "u", // board: unwedge — [C14], and the one lever that matters when things are stuck
        "x", // memory: retire / deploy: abort
      ].sort(),
    );
  });
});

// ---------------------------------------------------------------------------
// [T1] Every registered key must be answerable
// ---------------------------------------------------------------------------

describe("[T1] every registered key is answerable", () => {
  /**
   * The bar is EFFECT, not handler-existence.
   *
   * "A handler exists for this key" is the vacuous version of this fence — the
   * same self-loop shape that let a dead lifecycle state produce itself. A
   * handler that returns `true` and does nothing, or that re-dispatches to the
   * key it was called for, satisfies "has a handler" and still steals the
   * keystroke. So what is observed here is what an operator or the outside
   * world could observe: the painted bytes changed, the tab changed, or the
   * app asked the outside world for something (an ssh call).
   *
   * MUTATION: delete the `case "u":` arm from the board key handler in
   * src/tui/app.ts — this fails naming `u` on board. Add `"Z"` to
   * `TAB_EXTRA_KEYS.deploy` — this fails naming Z on deploy.
   */
  /**
   * A rig with EVERY tab's hooks really installed, against fakes.
   *
   * This matters more than it looks. A bare `new App(...)` has no tab
   * handlers at all, so almost every key on `digest`, `deploy`, `metrics` and
   * `changes` looks dead — and a fence that reports twenty dead keys because
   * the harness is under-wired teaches a reader to ignore it, which is worse
   * than no fence. The rig has to be the app the operator runs.
   */
  const rig = () => {
    const { out, input } = fakeStreams();
    const ssh: string[] = [];
    const app = new App(
      TUI_DEFAULTS,
      (_h: string, argv: string[]): Promise<RemoteResult> => {
        ssh.push(argv.join(" "));
        return Promise.resolve({ ok: true, stdout: "", stderr: "", code: 0 });
      },
      out,
      input,
    );
    app.view.snapshot = SNAPSHOT;
    // `g` opens a PR on GitHub and needs a repo slug to build the URL from —
    // without it the handler returns early and the most obviously working key
    // on the board reads as dead.
    app.view.repo = "exampleorg/example-app";

    // ASKS OF THE OUTSIDE WORLD. `r` (refresh) reloads through a tab's
    // fetcher; against a fake that answers identically it changes no pixel and
    // no state, and was reported dead. Making a fetch IS the effect — the same
    // class as an ssh call or an opened URL.
    const fetched: string[] = [];
    const entries: MemoryEntry[] = [
      { id: "e1", ts: "2026-08-20 09:00:00", day: "2026-08-20", block: 0, text: "#bug a thing broke", tags: ["bug"], links: [], pinned: false, hash: "h1" },
      { id: "e2", ts: "2026-08-20 10:00:00", day: "2026-08-20", block: 1, text: "#pinned a standing rule", tags: ["pinned"], links: [], pinned: true, hash: "h2" },
      { id: "e3", ts: "2026-08-19 10:00:00", day: "2026-08-19", block: 0, text: "#feedback an older note", tags: ["feedback"], links: [], pinned: false, hash: "h3" },
    ];
    const memory: MemoryStore = {
      read: async () => entries,
      search: async () => entries,
      apply: async () => ({ ok: true, message: "fence rig" }),
    };
    const memState = installMemoryLearningHooks(app, {
      memory,
      digestFetcher: {
        list: async () => (fetched.push("digest:list"), ["2026-08-20.md", "2026-08-19.md", "2026-08-18.md"]),
        read: async (f: string) => (fetched.push(`digest:read:${f}`), `# digest ${f}\nline\n`),
      },
      fetchProposals: async () => ({ proposals: [], improvements: [] }),
    });
    // These three fetchers are wide interfaces with narrow use here — this
    // fence only needs the tab to be LOADED so its keys have something to act
    // on, never the contents. `as never` is honest about that: a real fake
    // would be forty lines asserting nothing this test reads. Behaviour of
    // each tab is pinned by its own suite.
    const metricsState = installMetricsHooks(app, {
      overall: async () => (fetched.push("metrics:overall"), { ok: false, error: "fence rig" }),
      timeline: async () => (fetched.push("metrics:timeline"), { ok: false, error: "fence rig" }),
    } as never);
    const deployState = installDeployHooks(app, {
      load: async () => (fetched.push("deploy:load"), {
        dirty: ["src/a.ts", "src/b.ts"],
        plan: [
          { step: "preflight", state: "pending" },
          { step: "sync", state: "pending" },
          { step: "verify", state: "pending" },
        ],
      }),
    } as never);
    const change = (sha: string, subject: string) => ({
      sha,
      short: sha.slice(0, 7),
      at: "2026-08-20T09:00:00Z",
      author: "alice",
      subject,
      ratified: "",
      first_seen: "2026-08-20T09:00:00Z",
    });
    const CHANGES = {
      version: 1 as const,
      updated_at: "2026-08-20T12:00:00Z",
      entries: [change("aaa1111", "first"), change("bbb2222", "second"), change("ccc3333", "third")],
      scanned: 3,
    };
    const changesState = installChangesHooks(app, {
      register: CHANGES,
      refresh: async () => (fetched.push("changes:refresh"), CHANGES),
      scan: async () => (fetched.push("changes:scan"), CHANGES),
      revert: async () => ({ ok: false, message: "fence rig" }),
    } as never);
    installMessageHooks(app, { send: async () => {} });

    // An effect that leaves the process entirely — `g` hands a URL to the
    // operator's browser and changes nothing on screen. Not recording it
    // would report the most obviously working key on the board as dead.
    const opened: string[] = [];
    app.hooks.openUrl = (url) => opened.push(url);

    /**
     * The tab's OWN view model, beside `app.view`.
     *
     * Selection indexes, scroll offsets, the metrics window and the loading
     * flags live here, not on `app.view` — so with an empty fixture list
     * `j`, `k`, `[`, `]`, `r` and `7` moved something real while changing no
     * pixel, and were reported dead. That is the false-positive direction,
     * and a fence that cries wolf gets skimmed. Including this state is NOT
     * the `consumed` clause coming back: a handler that returns `true` and
     * does nothing still moves none of it.
     */
    const tabState = (): string =>
      JSON.stringify({ mem: memState, metrics: metricsState, deploy: deployState, changes: changesState });

    return { app, ssh, opened, fetched, tabState };
  };

  /**
   * TWO lists, and the distinction between them is the point of the ticket:
   * a reader must be able to tell PROTECTED from OVERLOOKED.
   *
   * `NO_OP_BY_DESIGN` — the key works; in this state there is simply nothing
   * for it to do, and doing nothing is correct. These are not defects and
   * never will be.
   *
   * `DEAD_PENDING_TICKET` — the key really is swallowed. Each entry names the
   * inventory finding and the ticket that removes or relocates it. These ARE
   * defects, recorded because their fix is another slice's cut, and they are
   * exactly the class this fence exists to find: the fence rediscovered
   * [C3] independently, from the running app, having been written
   * without reference to it.
   *
   * Both are checked by SET EQUALITY below, so an entry that stops being
   * needed fails as loudly as a key that stops working — including when
   * lands and these registrations go away.
   */
  const NO_OP_BY_DESIGN: ReadonlyArray<{ tab: Tab; key: string; why: string }> = [
    // A tab's OWN digit while that tab is showing: switching to where you
    // already are is a genuine self-loop, and the key is live on every other
    // tab, which is where it is asserted. `changes` is absent deliberately —
    // entering it triggers a register refresh, so its digit really does
    // something even from itself.
    ...(["board", "digest", "deploy", "metrics"] as const).map((tab, i) => ({
      tab: tab as Tab,
      key: String(i + 1),
      why: "a tab's own digit while that tab is showing — a genuine self-loop; the key is asserted live on every other tab.",
    })),
    {
      tab: "deploy",
      key: "x",
      why:
        "abort, with no deploy run in flight — [C8], classified KEEP. A verb whose precondition is "
        + "absent is not a dead registration; the same key aborts a real run.",
    },
    {
      tab: "digest",
      key: "]",
      why:
        "newer digest day, standing on the newest one. `[` moves older and is asserted live beside it; there is "
        + "nothing newer than newest. A boundary is not a dead key.",
    },
  ];

  const DEAD_PENDING_TICKET: ReadonlyArray<{ tab: Tab; key: string; why: string }> = [
    ...(["A", "R", "e", "n", "p", "t", "x"] as const).map((key) => ({
      tab: "digest" as Tab,
      key,
      why:
        "[C3]: on tab [2]'s DIGEST view these are painted buttons that do nothing — they belong to the "
        + "MEMORY view, and tab [2] holds two unrelated views behind one keystroke. Relocation is's tab-[2] "
        + "surgery (the inventory's Batch 7, explicitly 'do not cut before it lands'). Genuinely swallowed today: "
        + "each steals the keystroke from the companion column. This is now the inventory's EXACT list, "
        + "`t e p x n A R` — `e` joined it when the effect bar stopped accepting a bare hook return.",
    })),
    // [C4]'s `m` and `w` were here — registered on tab [2] and
    // silently swallowed, the memory-view half of the same tab-[2] confusion.
    // UNREGISTERED them (with `a g o M`) along with the AWAITING YOU
    // list whose ⏎/w/m verbs they served: an unregistered printable reaches
    // the companion column instead of vanishing. They are no longer registered
    // on this tab, so they cannot be swallowed by it, and set equality here
    // refuses an entry for a key that is no longer registered at all.
  ];

  const NOT_OBSERVABLE_HEADLESS = [...NO_OP_BY_DESIGN, ...DEAD_PENDING_TICKET];

  /**
   * The SCREEN this tab paints, rendered from app state.
   *
   * `App.repaint()` returns early unless `started` is set, so the rig's
   * `written()` byte-count was INERT — it never grew for any key, and the
   * disjunction was carrying nothing. (Proven by gutting `case "unwedge"` to a
   * bare `break;` and still having it reported dead: the fence was right by
   * luck, on the other clauses.) Rendering the tab directly is hermetic, needs
   * no timers or ssh, and gives the one signal that actually matters — what
   * the operator would see.
   */
  const screenOf = (app: App, tab: Tab): string => {
    const hook = { digest: "digestScreen", deploy: "deployScreen", metrics: "metricsScreen", changes: "changesScreen" }[
      tab as Exclude<Tab, "board">
    ];
    if (tab === "board") return renderBoard(app.view, 140, 40).render();
    const fn = app.hooks[hook as keyof typeof app.hooks] as
      | ((a: App, cols: number, rows: number) => string | { render(): string })
      | undefined;
    if (!fn) return "";
    const out = fn(app, 140, 40);
    return typeof out === "string" ? out : out.render();
  };

  /** Render until two consecutive frames agree, or give up loudly. */
  const settle = async (app: App, tab: Tab): Promise<void> => {
    let last = screenOf(app, tab);
    for (let i = 0; i < 60; i++) {
      await new Promise((r) => setTimeout(r, 5));
      const next = screenOf(app, tab);
      if (next === last) return;
      last = next;
    }
    throw new Error(`the '${tab}' screen never settled — every key would look alive against a moving frame`);
  };

  for (const tab of TABS) {
    it(`${tab}: no registered key is swallowed`, async () => {
      const dead: string[] = [];
      for (const key of registeredKeys(tab)) {
        const { app, ssh, opened, fetched, tabState } = rig();
        app.tab = tab;
        // Give every key something to act on: a selected row, a filter to
        // clear, a loaded tab. A "clear the filter" key with no filter set is
        // a legitimate no-op, and reporting it would be a false positive that
        // teaches the reader to skim.
        app.view.boardFilter = { author: "alice" };
        // A FIXED clock. `renderBoard` falls back to `new Date()`, and the tab
        // screens carry ages and timestamps, so without this every render
        // differs from the last and EVERY key looks alive — the signal would
        // be a false-negative machine, strictly worse than the inert one it
        // replaced. The self-check below is what caught it.
        app.view.now = new Date("2026-08-20T12:00:00Z");

        // WAIT FOR THE TAB TO SETTLE. Every tab hook kicks off an async load
        // on install, and a fixed sleep raced it: the first key of each tab
        // was pressed while the pane still said "loading…", so the load
        // resolving between the two renders looked like that key's effect.
        // Digest `A` passed for exactly that reason and nothing else.
        await settle(app, tab);
        // Off the list boundary: `k` at index 0 correctly moves nothing, and
        // reporting it would be a rig artefact rather than a dead key.
        app.pressKey("j");
        await settle(app, tab);
        const before = {
          tab: app.tab,
          view: JSON.stringify(app.view),
          tabState: tabState(),
          screen: screenOf(app, tab),
          ssh: ssh.length,
          opened: opened.length,
          fetched: fetched.length,
        };
        // THE SIGNAL MUST BE STABLE UNDER NO INPUT, or "changed" means
        // "rendered twice" and every key passes. Asserted per key rather than
        // once, because a tab can become non-deterministic only after some
        // other key has loaded it.
        expect(
          screenOf(app, tab),
          `the '${tab}' screen is not deterministic under no input — this fence would pass every key. `
            + "Pin whatever moves (a clock, a spinner) before trusting a single result here.",
        ).toBe(before.screen);

        app.pressKey(key);
        await new Promise((r) => setTimeout(r, 10));

        // NOTE what is NOT here: "the tab's key hook returned true". That was
        // in the disjunction, and it is precisely the degenerate handler the
        // header of this describe says the fence rejects — a `return true`
        // with no body satisfies it. An adversarial reviewer registered `w` on
        // the deploy tab, made `deployKey` return true for it as its first
        // line, and all thirteen tests here stayed green while `w` silently
        // ate the keystroke. The bar is EFFECT: a different screen, a
        // different tab, changed state, a remote call, or an opened URL.
        const changed =
          screenOf(app, tab) !== before.screen
          || app.tab !== before.tab
          || JSON.stringify(app.view) !== before.view
          || tabState() !== before.tabState
          || ssh.length !== before.ssh
          || opened.length !== before.opened
          || fetched.length !== before.fetched;
        if (!changed) dead.push(key);
      }
      const allowed = NOT_OBSERVABLE_HEADLESS.filter((e) => e.tab === tab).map((e) => e.key).sort();
      expect(
        dead.sort(),
        `keys registered on tab '${tab}' that changed no pixel, no state, and asked the outside world for nothing. `
          + "A dead registration is not inert — it steals the keystroke from the companion column. "
          + "Give it an effect, unregister it, or add it to NOT_OBSERVABLE_HEADLESS with the test that covers it.",
      ).toEqual(allowed);
    });
  }
});

// ---------------------------------------------------------------------------
// [T2] Every action-union variant must be constructed somewhere
// ---------------------------------------------------------------------------

describe("[T2] every click-zone action variant is constructed", () => {
  /**
   * A `{ t: "..." }` member no `zones.push` ever builds is a click target that
   * cannot be clicked — `BoardAction`'s `tab` and `key` arms and
   * `MetricsAction`'s `back` were exactly that ([C9]-[C11]).
   *
   * Two of the eleven push sites build into a LOCAL array that is re-based
   * onto `frame.zones` later, so this scans for the tag anywhere in the tab's
   * own module rather than for a literal `zones.push` — narrower than the
   * module set, broader than one call shape.
   *
   * MUTATION: add `| { t: "rogue" }` to `BoardAction` — this fails naming it.
   */
  /**
   * Variants with no producer, each a ticketed delete.
   *
   * These are NOT tolerated shapes — they are the inventory's own
   * [C9]/[C10]/[C11], classified DELETE in its Batch 1. Recorded rather than
   * cut here for one reason worth stating: `BoardAction`'s `tab` and `key`
   * arms still have LIVE HANDLERS (`src/tui/app.ts`, `case "tab":` /
   * `case "key":`), so removing them is a two-sided edit in a file
   * tab-[2] surgery also opens. A fence that names them is the smaller change
   * and loses nothing: the moment a producer appears, or the variant goes,
   * this fails.
   */
  const UNBUILT_PENDING_TICKET: Readonly<Record<string, string[]>> = {
    // [C9] / [C10]: click zones that were never pushed. Their handlers
    // in app.ts are the other half of the same dead pair.
    BoardAction: ["tab", "key"],
    // [C11]: the metrics drill-down's "back" target, replaced by a key.
    MetricsAction: ["back"],
    // The digest tab's generic key-zone action; the tab pushes only `await`.
    DigestAction: ["key"],
  };

  const UNIONS: ReadonlyArray<{ file: string; type: string }> = [
    { file: "src/tui/board.ts", type: "BoardAction" },
    { file: "src/tui/metricstab.ts", type: "MetricsAction" },
    { file: "src/tui/digesttab.ts", type: "DigestAction" },
    { file: "src/tui/memtab.ts", type: "MemAction" },
    { file: "src/tui/changestab.ts", type: "ChangesAction" },
  ];

  for (const u of UNIONS) {
    it(`${u.type}: every variant is built by its module`, () => {
      const text = readFileSync(join(ROOT, u.file), "utf8");
      const decl = new RegExp(`export type ${u.type}\\s*=([\\s\\S]*?);\\s*\\n`).exec(text)?.[1];
      expect(decl, `${u.type} not found in ${u.file} — this fence is now vacuous`).toBeTruthy();

      const tags = [...decl!.matchAll(/t:\s*"([^"]+)"/g)].map((m) => m[1]!);
      expect(tags.length, `${u.type} parsed to zero variants`).toBeGreaterThan(0);

      // Constructions, not the declaration: strip the declaration itself first,
      // or every variant "appears" in its own type and the check is a tautology
      // — the name-not-reader trap in its purest form.
      const body = text.replace(decl!, "");
      const unbuilt = tags.filter((t) => !body.includes(`t: "${t}"`));
      const recorded = (UNBUILT_PENDING_TICKET[u.type] ?? []).sort();
      expect(
        unbuilt.sort(),
        `${u.type} declares a variant nothing constructs — a click target that cannot be clicked. `
          + "Delete the variant and its handler, or record it with its ticket.",
      ).toEqual(recorded);
    });
  }
});

// ---------------------------------------------------------------------------
// [T7] Referenced files must exist
// ---------------------------------------------------------------------------

describe("[T7] every repo path a script or doc points at exists", () => {
  /**
   * `npm run e2e:companion` imported a module that had been deleted
   * ([F8]) and nothing noticed, because a path in a shell script is
   * just a string until someone runs it.
   *
   * MUTATION: add `node dist/src/does-not-exist.js` to any scripts/*.sh —
   * this fails naming it.
   */
  it("scripts/ and docs/ name no path that is missing", () => {
    const roots = ["scripts", "docs"];
    const missing: string[] = [];
    for (const dir of roots) {
      for (const f of readdirSync(join(ROOT, dir), { withFileTypes: true })) {
        if (!f.isFile()) continue;
        const text = readFileSync(join(ROOT, dir, f.name), "utf8");
        for (const line of text.split("\n")) {
          // A doc that RECORDS a deletion names the path it deleted, and that
          // is the documentation working, not a broken pointer. Narrow, and
          // per-line so it cannot mute a whole file.
          if (/\b(deleted|removed|retired|no longer|used to|gone|gitignored|never existed)\b/i.test(line)) continue;
          for (const m of line.matchAll(/(?<![\w./-])(?:dist|src|extensions|prompts|agents|deploy|docker)\/[A-Za-z0-9._/-]+\.(?:ts|js|mjs|md|sh|json|yml|j2|toml)\b/g)) {
            const rel = m[0];
            // dist/ is a build product: absent on a clean checkout, and its
            // presence is `scripts/verify-dist.mjs`'s job, not this fence's.
            if (rel.startsWith("dist/")) continue;
            if (!existsSyncSafe(join(ROOT, rel))) missing.push(`${dir}/${f.name} → ${rel}`);
          }
        }
      }
    }
    expect(missing.sort(), "a script or doc points at a repo path that does not exist").toEqual([]);
  });
});

function existsSyncSafe(p: string): boolean {
  try {
    readdirSync(p);
    return true;
  } catch (e) {
    return (e as NodeJS.ErrnoException).code === "ENOTDIR";
  }
}
