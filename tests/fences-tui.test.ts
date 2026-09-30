// the TUI half of the structural fences. See tests/fences.test.ts
// for the three rules this file is written under; the second one bites hardest
// here.
//
// [T1] is the single highest-value check the dead-surface inventory proposed,
// and the reason is the failure MODE, not the count: a registered key with no
// reachable effect does not merely do nothing — `App.handleInput` routes any
// printable that is NOT in `app.registeredKeys()` to the companion column, so a
// dead registration STEALS the keystroke. The operator types a character
// meant for pi and it vanishes. Six such registrations were shipped
// ([C1]-[C6]) and nothing could see them. Since the set is
// derived from what each surface is painting, so the recorded exceptions
// below collapsed to the one genuine self-loop.
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import type { StatusSnapshot } from "../src/state.js";
import type { MemoryEntry, MemoryStore } from "../src/memory/store.js";
import type { App, Tab } from "../src/tui/app.js";
import { HELP_LINES, renderBoard } from "../src/tui/board.js";
import { GLOBAL_KEYS, TAB_INLINE_KEYS, TAB_VOCABULARY } from "../src/tui/cmdbar.js";
import { installDeployHooks } from "../src/tui/deploytab.js";
import { installMetricsHooks } from "../src/tui/metricstab.js";
import { installMessageHooks } from "../src/tui/msg.js";
import { TABS, tabDigit } from "../src/tui/tabs.js";
import { FakeChanges, changeEntry, installScanRig, learningRig } from "./helpers/tui-rig.js";
import { HEAVY_TIMEOUT_MS } from "./helpers/suite-timeouts.js";

const ROOT = join(import.meta.dirname, "..");

const SNAPSHOT: StatusSnapshot = {
  written_at: "2026-08-20T12:00:00Z",
  dry_run: true,
  prs: [
    {
      number: 5012,
      state: "reviewing",
      title: "fix(crm): retry",
      head_sha: "aa11",
      stale_recheck: 0,
      author: "alice",
    },
    {
      number: 5049,
      state: "awaiting_author",
      title: "feat: dispatch",
      head_sha: "bb22",
      stale_recheck: 0,
      author: "bob",
    },
  ],
  running_rounds: 0,
  total_spend_usd: 0,
  heartbeat: "2026-08-20T12:00:00Z",
};

const PRINTABLE = (k: string): boolean => k.length === 1 && k >= " " && k <= "~";

/** Every printable a tab can ever claim — its bar vocabulary plus its inline keys. */
function universe(tab: Tab): Set<string> {
  return new Set([
    ...TAB_VOCABULARY[tab].map((b) => b.key).filter(PRINTABLE),
    ...TAB_INLINE_KEYS[tab],
  ]);
}

// ---------------------------------------------------------------------------
// [T9] The help overlay and the key vocabulary must agree
// ---------------------------------------------------------------------------

describe("[T9] HELP_LINES and the key vocabulary agree", () => {
  /**
   * The direction that misleads an operator: a key the help NAMES must be a
   * key some surface can claim — `u unwedge`, `\`, `W` and `F` were once live
   * keys the help never mentioned ([C14]) and the help promised a
   * full-screen attach that ⏎/`a` no longer did ([H4]).
   *
   * MUTATION: add `"Z            does something"` to HELP_LINES — this fails
   * naming Z.
   */
  it("every key the help overlay names is in some surface's vocabulary or a global", () => {
    const claimable = new Set([...GLOBAL_KEYS, ...TABS.flatMap((t) => [...universe(t)])]);
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
        if (PRINTABLE(tok)) named.add(tok);
      }
    }
    expect(
      named.size,
      "no key was extracted from HELP_LINES — the parse broke and this asserts nothing",
    ).toBeGreaterThan(5);
    const unclaimable = [...named].filter((k) => !claimable.has(k)).sort();
    expect(
      unclaimable,
      "the help overlay names a key no surface can claim — the operator is told to press something that goes to the companion column",
    ).toEqual([]);
  });

  /**
   * The reverse, made exact by the vocabulary: every bar button a
   * surface can paint is named in the help. Inline keys are exempt — `a` is
   * ⏎'s twin, the metrics digits type into a box — but the bar is the
   * contract the operator reads.
   *
   * MUTATION: add `{ key: "Z", label: "Z zap" }` to `TAB_VOCABULARY.deploy` —
   * this fails naming Z.
   */
  it("every bar key in every surface's vocabulary is named somewhere in the help", () => {
    const helpText = HELP_LINES.join("\n");
    const missing: string[] = [];
    for (const tab of TABS) {
      for (const b of TAB_VOCABULARY[tab]) {
        if (!PRINTABLE(b.key)) continue;
        const re = new RegExp(
          `(^|[\\s/(\\[])${b.key.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}([\\s/)\\]]|$)`,
          "m",
        );
        if (!re.test(helpText)) missing.push(`${tab}:${b.key}`);
      }
    }
    expect(missing).toEqual([]);
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
   * app asked the outside world for something (an ssh call, a fetch).
   *
   * MUTATION: delete the `case "unwedge":` arm from the board key handler in
   * src/tui/app.ts — this fails naming `u` on board. Make `memoryKeys` push
   * `{ key: "Z", label: "Z zap" }` — this fails naming Z on memory.
   */
  /**
   * A rig with EVERY surface's hooks really installed, against fakes.
   *
   * This matters more than it looks. A bare `new App(...)` has no tab
   * handlers at all, so almost every key on the six installed surfaces looks
   * dead — and a fence that reports twenty dead keys because the harness is
   * under-wired teaches a reader to ignore it, which is worse than no fence.
   * The rig has to be the app the operator runs.
   */
  const rig = () => {
    const fetched: string[] = [];
    const entries: MemoryEntry[] = [
      {
        id: "e1",
        ts: "2026-08-20 09:00:00",
        day: "2026-08-20",
        block: 0,
        text: "#bug a thing broke",
        tags: ["bug"],
        links: [],
        pinned: false,
        hash: "h1",
      },
      {
        id: "e2",
        ts: "2026-08-20 10:00:00",
        day: "2026-08-20",
        block: 1,
        text: "#pinned a standing rule",
        tags: ["pinned"],
        links: [],
        pinned: true,
        hash: "h2",
      },
      {
        id: "e3",
        ts: "2026-08-19 10:00:00",
        day: "2026-08-19",
        block: 0,
        text: '#feedback pr=1 signal=feedback_comment human [feedback] by a on PR #1 (comment 1): "one" — x',
        tags: ["feedback"],
        links: [],
        pinned: false,
        hash: "h3",
      },
      {
        id: "e4",
        ts: "2026-08-18 10:00:00",
        day: "2026-08-18",
        block: 0,
        text: '#feedback pr=2 signal=feedback_comment human [feedback] by a on PR #2 (comment 2): "two" — x',
        tags: ["feedback"],
        links: [],
        pinned: false,
        hash: "h4",
      },
      {
        id: "e5",
        ts: "2026-08-17 10:00:00",
        day: "2026-08-17",
        block: 0,
        text: '#feedback pr=3 signal=feedback_comment human [feedback] by a on PR #3 (comment 3): "three" — x',
        tags: ["feedback"],
        links: [],
        pinned: false,
        hash: "h5",
      },
    ];
    const memory: MemoryStore = {
      read: async () => (fetched.push("memory:read"), entries),
      search: async () => entries,
      apply: async () => ({ ok: true, message: "fence rig" }),
    };
    const ticket = (id: string) => ({
      id,
      title: `t ${id}`,
      status: "open",
      role: "—",
      category: "—",
      updated: "2026-08-25T18:00:00Z",
      path: "/t",
      body: `# t ${id}\n\nbody`,
    });
    const changes = new FakeChanges([
      changeEntry("aaa1111".padEnd(40, "0"), "first"),
      changeEntry("bbb2222".padEnd(40, "0"), "second"),
      changeEntry("ccc3333".padEnd(40, "0"), "third"),
    ]);
    const r = learningRig({
      cols: 140,
      rows: 40,
      memory,
      digestFetcher: {
        list: async () => (
          fetched.push("digest:list"),
          ["2026-08-18.md", "2026-08-19.md", "2026-08-20.md"]
        ),
        read: async (f: string) => (fetched.push(`digest:read:${f}`), `# digest ${f}\nline\n`),
      },
      fetchProposals: async () => (
        fetched.push("proposals"),
        {
          proposals: [
            { slug: "p1", head: ["h"] },
            { slug: "p2", head: ["h"] },
          ],
          improvements: [],
        }
      ),
      readTickets: () => (
        fetched.push("tickets"),
        [ticket(""), ticket(""), ticket("")]
      ),
      changes,
    });
    const { app } = r;
    const ssh: string[] = [];
    // The rig's ssh runner answers everything identically; count the asks.
    const realSsh = app.ssh;
    (app as unknown as { ssh: typeof realSsh }).ssh = (h, argv, o) => {
      ssh.push(argv.join(" "));
      return realSsh(h, argv, o);
    };
    app.view.snapshot = SNAPSHOT;
    // `g` opens a PR on GitHub and needs a repo slug to build the URL from —
    // without it the handler returns early and the most obviously working key
    // on the board reads as dead.
    app.view.repo = "exampleorg/example-app";
    r.learning.store.reloadTickets();

    // These fetchers are wide interfaces with narrow use here — this fence
    // only needs the tab to be LOADED so its keys have something to act on,
    // never the contents. `as never` is honest about that.
    const metricsState = installMetricsHooks(app, {
      overall: async () => (fetched.push("metrics:overall"), { ok: false, error: "fence rig" }),
      timeline: async () => (fetched.push("metrics:timeline"), { ok: false, error: "fence rig" }),
    } as never);
    const deployState = installDeployHooks(app, {
      load: async () => (
        fetched.push("deploy:load"),
        {
          dirty: ["src/a.ts", "src/b.ts"],
          plan: [
            { step: "preflight", state: "pending" },
            { step: "sync", state: "pending" },
            { step: "verify", state: "pending" },
          ],
        }
      ),
    } as never);
    installMessageHooks(app, { send: async () => {} });
    const scan = installScanRig(app);

    // An effect that leaves the process entirely — `g` hands a URL to the
    // operator's browser and changes nothing on screen. Not recording it
    // would report the most obviously working key on the board as dead.
    const opened: string[] = [];
    app.hooks.openUrl = (url) => opened.push(url);

    /**
     * The tabs' OWN view models, beside `app.view`.
     *
     * Selection indexes, scroll offsets, the metrics window and the loading
     * flags live here, not on `app.view` — so with an empty fixture list
     * `j`, `k`, `[`, `]`, `r` and `7` moved something real while changing no
     * pixel, and were reported dead. Including this state is NOT the
     * `consumed` clause coming back: a handler that returns `true` and does
     * nothing still moves none of it.
     */
    const store = r.learning.store;
    const tabState = (): string =>
      JSON.stringify({
        memory: r.learning.memory,
        tickets: r.learning.tickets,
        feedback: r.learning.feedback,
        store: {
          digest: store.digest,
          status: store.status,
          memLoaded: store.memLoaded,
          propLoaded: store.propLoaded,
          tickets: store.tickets.kind,
          entries: store.entries.length,
        },
        metrics: metricsState,
        deploy: deployState,
        changes: changes.refreshes,
        scan: { state: scan.state, asks: scan.asks.length },
      });

    return { app, ssh, opened, fetched, tabState };
  };

  /**
   * The keys that are registered and do nothing in this state ON PURPOSE.
   *
   * With the bar state-derived this is the one genuine self-loop:
   * a tab's own digit while that tab is showing. Every other registration
   * is a button the surface is painting right now, and a painted button that
   * does nothing is a lie. There is no second list any more — the old
   * `DEAD_PENDING_TICKET` was seven buttons the old tab [2] painted for a
   * view that was not up, and that tab no longer exists.
   *
   * Checked by SET EQUALITY below, so an entry that stops being needed fails
   * as loudly as a key that stops working.
   */
  const NO_OP_BY_DESIGN: ReadonlyArray<{ tab: Tab; key: string; why: string }> = TABS.map(
    (tab) => ({
      tab,
      key: tabDigit(tab),
      why: "a tab's own digit while that tab is showing — a genuine self-loop; the key is asserted live on every other tab.",
    }),
  );

  /** The SCREEN this tab paints, rendered from app state. Hermetic, no timers. */
  const screenOf = (app: App, tab: Tab): string => {
    if (tab === "board") return renderBoard(app.view, 140, 40).render();
    return app.hooks.tabs[tab]!.screen(app, 140, 40).render();
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
    throw new Error(
      `the '${tab}' screen never settled — every key would look alive against a moving frame`,
    );
  };

  for (const tab of TABS) {
    it(`${tab}: no registered key is swallowed`, { timeout: HEAVY_TIMEOUT_MS }, async () => {
      const dead: string[] = [];
      // The registered set is a function of the settled state, so it is read
      // from a settled rig — the same one every key below is pressed on.
      const probe = rig();
      probe.app.tab = tab;
      probe.app.view.boardFilter = { author: "alice" };
      probe.app.view.now = new Date("2026-08-20T12:00:00Z");
      await settle(probe.app, tab);
      const registered = [...probe.app.registeredKeys()].filter(PRINTABLE);
      expect(
        registered.length,
        `${tab} registers nothing but globals — the rig is under-wired`,
      ).toBeGreaterThan(GLOBAL_KEYS.length - 1);
      for (const key of registered) {
        const { app, ssh, opened, fetched, tabState } = rig();
        app.tab = tab;
        // Give every key something to act on: a selected row, a filter to
        // clear, a loaded tab. A "clear the filter" key with no filter set is
        // a legitimate no-op, and would not be registered in the first place.
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
          `the '${tab}' screen is not deterministic under no input — this fence would pass every key. ` +
            "Pin whatever moves (a clock, a spinner) before trusting a single result here.",
        ).toBe(before.screen);

        app.pressKey(key);
        await new Promise((r) => setTimeout(r, 10));

        // NOTE what is NOT here: "the tab's key hook returned true". That was
        // in the disjunction, and it is precisely the degenerate handler the
        // header of this describe says the fence rejects — a `return true`
        // with no body satisfies it. The bar is EFFECT: a different screen, a
        // different tab, changed state, a remote call, or an opened URL.
        const changed =
          screenOf(app, tab) !== before.screen ||
          app.tab !== before.tab ||
          JSON.stringify(app.view) !== before.view ||
          tabState() !== before.tabState ||
          ssh.length !== before.ssh ||
          opened.length !== before.opened ||
          fetched.length !== before.fetched;
        if (!changed) dead.push(key);
      }
      const allowed = NO_OP_BY_DESIGN.filter((e) => e.tab === tab)
        .map((e) => e.key)
        .sort();
      expect(
        dead.sort(),
        `keys registered on tab '${tab}' that changed no pixel, no state, and asked the outside world for nothing. ` +
          "A dead registration is not inert — it steals the keystroke from the companion column. " +
          "Give it an effect, stop offering it in this state, or add it to NO_OP_BY_DESIGN with the reason.",
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
   * `MetricsAction`'s `back` were exactly that ([C9]-[C11]); all
   * three are deleted, so nothing is recorded as pending any more
   * and the fence is a plain equality with the empty list.
   *
   * Some push sites build into a LOCAL array that is re-based onto
   * `frame.zones` later, so this scans for the tag anywhere in the tab's own
   * module rather than for a literal `zones.push` — narrower than the module
   * set, broader than one call shape.
   *
   * MUTATION: add `| { t: "rogue" }` to `BoardAction` — this fails naming it.
   */
  const UNIONS: ReadonlyArray<{ file: string; type: string }> = [
    { file: "src/tui/board.ts", type: "BoardAction" },
    { file: "src/tui/metricstab.ts", type: "MetricsAction" },
    { file: "src/tui/memtab.ts", type: "MemAction" },
    { file: "src/tui/ticketstab.ts", type: "TicketsAction" },
    { file: "src/tui/feedbacktab.ts", type: "FeedbackAction" },
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
      expect(
        unbuilt.sort(),
        `${u.type} declares a variant nothing constructs — a click target that cannot be clicked. Delete the variant and its handler.`,
      ).toEqual([]);
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
          if (
            /\b(deleted|removed|retired|no longer|used to|gone|gitignored|never existed)\b/i.test(
              line,
            )
          )
            continue;
          for (const m of line.matchAll(
            /(?<![\w./-])(?:dist|src|extensions|prompts|agents|deploy|docker)\/[A-Za-z0-9._/-]+\.(?:ts|js|mjs|md|sh|json|yml|j2|toml)\b/g,
          )) {
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
