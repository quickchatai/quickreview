// `[github] trigger` as the running daemon follows it (src/livetrigger.ts):
// the one key read again at every poll, so a change to it needs no restart
// and costs no round in flight. The reader is driven over fake file reads;
// the daemon is driven with a fake GitHub and a real in-memory store, and
// never restarted.
import { mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { GateResult } from "@quickchatai/pi-quickreview/src/gate.js";
import {
  GITHUB_TRIGGERS,
  githubTriggerOf,
  type GithubTrigger,
} from "@quickchatai/pi-quickreview/src/reviewconfig.js";
import { loadConfig } from "../src/config.js";
import { createDaemon, type DaemonAdapter } from "../src/daemon.js";
import type { PrRef } from "../src/github.js";
import { liveTrigger, triggerOfToml } from "../src/livetrigger.js";
import { StateStore } from "../src/state.js";
import { HEAVY_TIMEOUT_MS } from "./helpers/suite-timeouts.js";

const ROOT = join(import.meta.dirname, "..");

describe("what a config's text says of the trigger", () => {
  it("the value it states, and label where it states none", () => {
    expect([...GITHUB_TRIGGERS]).toEqual(["label", "all"]);
    expect(triggerOfToml('[github]\ntrigger = "all"\n')).toBe("all");
    expect(triggerOfToml('[github]\ntrigger = "label"\n')).toBe("label");
    expect(triggerOfToml('[github]\nrepo = "acme/widgets"\n')).toBe("label");
    expect(triggerOfToml("dry_run = true\n")).toBe("label");
    // the trigger label's name is another key
    expect(triggerOfToml('[github]\ntrigger_label = "all"\n')).toBe("label");
    // the shipped template documents the key and leaves it out
    expect(triggerOfToml(readFileSync(join(ROOT, "config.example.toml"), "utf8"))).toBe("label");
  });

  // MUTATION: fall back to "label" for any value that is not "all" — a
  // config that says something else would move a daemon running on `all`
  // back, and this fails.
  it("nothing, for a text that is not TOML or a value that is neither", () => {
    for (const text of [
      "= not toml",
      '[github]\ntrigger = "every"\n',
      '[github]\ntrigger = "ALL"\n',
      "[github]\ntrigger = true\n",
      '[github]\ntrigger = ["all"]\n',
      'github = "a string"\n',
    ])
      expect(triggerOfToml(text), text).toBeUndefined();
    expect(githubTriggerOf(undefined)).toBe("label");
    expect(githubTriggerOf(null)).toBeUndefined();
    expect(githubTriggerOf("")).toBeUndefined();
  });
});

describe("the live reader", () => {
  const at = "/install/config.toml";
  const says = (trigger: string): string => `[github]\ntrigger = "${trigger}"\n`;

  it("asks the file at every call, and follows a change in either direction", () => {
    let text = says("label");
    const logs: string[] = [];
    const paths: string[] = [];
    const read = liveTrigger({
      path: at,
      initial: "label",
      read: (p) => {
        paths.push(p);
        return text;
      },
      log: (m) => logs.push(m),
    });
    expect(read()).toBe("label");
    expect(logs).toEqual([]);
    text = says("all");
    expect(read()).toBe("all");
    expect(read()).toBe("all");
    text = says("label");
    expect(read()).toBe("label");
    expect(paths).toEqual([at, at, at, at]);
    // said once per change, never once per poll
    expect(logs).toHaveLength(2);
    expect(logs[0]).toContain('now "all"');
    expect(logs[1]).toContain('now "label"');
  });

  it("starts from the trigger the config was loaded with, and follows the file from the first call", () => {
    expect(liveTrigger({ path: at, initial: "all", read: () => says("all") })()).toBe("all");
    expect(liveTrigger({ path: at, initial: "all", read: () => says("label") })()).toBe("label");
    expect(liveTrigger({ path: at, initial: "label", read: () => says("all") })()).toBe("all");
  });

  // MUTATION: answer "label" (or undefined) for a read that says nothing —
  // a file that cannot be read for one poll would move a daemon running on
  // `all`, and this fails.
  it("a file that says nothing never moves it: the last word read stands", () => {
    let text: string | Error = says("all");
    const logs: string[] = [];
    const read = liveTrigger({
      path: at,
      initial: "label",
      read: () => {
        if (text instanceof Error) throw text;
        return text;
      },
      log: (m) => logs.push(m),
    });
    expect(read()).toBe("all");
    for (const broken of [
      Object.assign(new Error("ENOENT"), { code: "ENOENT" }),
      "= not toml",
      says("sometimes"),
    ]) {
      text = broken;
      expect(read()).toBe("all");
    }
    // one line for the change, one for the whole run of reads that said nothing
    expect(logs).toHaveLength(2);
    expect(logs[1]).toContain('stays "all"');
    text = says("label");
    expect(read()).toBe("label");
    // and the other way round
    text = "= not toml";
    expect(read()).toBe("label");
  });
});

// ---- the daemon ---------------------------------------------------------------

const pr = (number: number, over: Partial<PrRef> = {}): PrRef => ({
  number,
  title: `PR ${number}`,
  author: "someone",
  head_sha: `head${number}`,
  base_ref: "main",
  body: "",
  updated_at: "2026-11-19T09:00:00Z",
  state: "open",
  draft: false,
  merged: false,
  labels: [],
  ...over,
});

/** GitHub as the daemon reads it: the open list, and no label on anything.
 * Every write answers as the dry-run gate does. */
function fakeAdapter(open: () => PrRef[]): DaemonAdapter {
  const dry = async (): Promise<GateResult> => ({ executed: false });
  return {
    searchLabelTriggered: async () => [],
    searchTeamTriggered: async () => [],
    searchAwaitingEscalationReviewer: async () => [],
    listOpenPrs: async () => open(),
    getPr: async (n: number) => {
      const found = open().find((p) => p.number === n);
      if (!found) throw new Error(`no such PR ${n}`);
      return found;
    },
    stalenessScan: async () => [],
    listBotReviewComments: async () => [],
    getRequestedReviewers: async () => ({ users: [], teams: [] }),
    listPrFiles: async () => [
      { filename: "src/app.ts", additions: 5, deletions: 1, status: "modified" },
    ],
    addLabel: dry,
    removeLabel: dry,
    deleteTeamReviewRequest: dry,
    requestEscalationReview: async () => ({ skipped: null, result: await dry() }),
    createReview: dry,
  } as unknown as DaemonAdapter;
}

describe("a running daemon follows the config's trigger", () => {
  let root: string;
  let store: StateStore;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "qcr-live-trigger-"));
    for (const d of ["state", "state/dryrun", "verdict", "inject"])
      mkdirSync(join(root, d), { recursive: true });
    store = new StateStore(":memory:");
  });
  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  const taken = (): number[] =>
    (
      store.db
        .prepare("SELECT pr FROM events WHERE kind = 'trigger_all_taken' ORDER BY id")
        .all() as Array<{ pr: number }>
    ).map((r) => r.pr);

  // MUTATION: drop the `trigger: deps.liveTrigger` line from the daemon's
  // reconcile pass — the daemon keeps the trigger it was loaded with until
  // it is restarted, and this fails.
  it(
    "from one poll to the next, with no restart and the same state",
    { timeout: HEAVY_TIMEOUT_MS },
    async () => {
      const cfg = {
        ...loadConfig(join(process.cwd(), "tests/fixtures/config.toml")),
        dry_run: true,
      };
      expect(cfg.github.trigger).toBe("label");
      let open = [pr(101)];
      let now: GithubTrigger = "label";
      const daemon = createDaemon({
        cfg,
        root,
        store,
        adapter: fakeAdapter(() => open),
        listen: false,
        log: () => {},
        liveTrigger: () => now,
        hooks: { async inject() {}, async dispatchRound() {}, async archiveAndClose() {} },
      });

      // loaded as label: an unlabelled pull request is not the daemon's to take
      await daemon.reconcile();
      expect(store.getPr(101)).toBeUndefined();
      expect(taken()).toEqual([]);

      // the config now says all: the very next pass takes it
      now = "all";
      await daemon.reconcile();
      expect(taken()).toEqual([101]);
      expect(["queued", "reviewing"]).toContain(store.getPr(101)?.state);
      expect(store.triggerLevel(101, "all")).toBe(true);

      // and back to label: a new pull request is left alone, and what the
      // daemon holds of the first is still there
      now = "label";
      open = [pr(101), pr(102)];
      await daemon.reconcile();
      expect(store.getPr(102)).toBeUndefined();
      expect(store.getPr(101)).toBeDefined();
      expect(store.triggerLevel(101, "all")).toBe(true);
      expect(taken()).toEqual([101]);

      // all again: the new one is taken, the first never twice
      now = "all";
      await daemon.reconcile();
      expect(taken()).toEqual([101, 102]);
    },
  );

  it(
    "without a reader it runs on the trigger its config was loaded with",
    { timeout: HEAVY_TIMEOUT_MS },
    async () => {
      const loaded = loadConfig(join(process.cwd(), "tests/fixtures/config.toml"));
      const cfg = {
        ...loaded,
        dry_run: true,
        github: { ...loaded.github, trigger: "all" as const },
      };
      const daemon = createDaemon({
        cfg,
        root,
        store,
        adapter: fakeAdapter(() => [pr(101, { draft: true }), pr(102)]),
        listen: false,
        log: () => {},
        hooks: { async inject() {}, async dispatchRound() {}, async archiveAndClose() {} },
      });
      await daemon.reconcile();
      expect(taken()).toEqual([102]);
    },
  );
});
