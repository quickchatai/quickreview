// `[github] trigger`, at the reconcile seam (src/reconcile.ts), over a fake
// GitHub and a real in-memory store.
//
//   label   the default, and every install's behaviour until now: only a
//           pull request somebody asked about is picked up.
//   all     every open pull request that is not a draft and not the
//           reviewer's own is picked up as if it carried the trigger label,
//           once. There is no label to remove, so "once" is the store's own
//           mark (`trigger_levels`, kind `all`).
//
// Under either, a push to a pull request that is already reviewed queues
// nothing by itself.
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { beforeEach, describe, expect, it } from "vitest";
import type { SessionHooks } from "@quickchatai/pi-quickreview/src/types.js";
import { parseConfig, type Config } from "../src/config.js";
import type { PrRef } from "../src/github.js";
import {
  reconcileOnce,
  type ReconcileAdapter,
  type ReconcileDeps,
  type ReconcileSearchItem,
} from "../src/reconcile.js";
import { applyEvent } from "../src/statemachine.js";
import { StateStore } from "../src/state.js";

const base: Config = parseConfig(
  readFileSync(resolve(process.cwd(), "tests/fixtures/config.toml"), "utf8"),
);
const withGithub = (over: Partial<Config["github"]>): Config => ({
  ...base,
  github: { ...base.github, ...over },
});
/** The fixture's App identity, picking up every pull request. */
const all = withGithub({ trigger: "all" });

function ref(number: number, over: Partial<PrRef> = {}): PrRef {
  return {
    number,
    title: `PR ${number}`,
    author: "alice",
    head_sha: `sha${number}`,
    base_ref: "main",
    body: "",
    updated_at: "2026-11-19T09:00:00Z",
    state: "open",
    draft: false,
    merged: false,
    labels: [],
    ...over,
  };
}

function item(number: number, login = "alice"): ReconcileSearchItem {
  return {
    number,
    title: `PR ${number}`,
    user: { login, type: login.endsWith("[bot]") ? "Bot" : "User" },
    updated_at: "2026-11-19T09:05:00Z",
  };
}

/** GitHub's truth, as a fake. */
class FakeGitHub implements ReconcileAdapter {
  open: PrRef[] = [];
  labelled: ReconcileSearchItem[] = [];
  closed = new Map<number, PrRef>();
  /** The open-PR list fails with this. */
  listFails: string | null = null;

  async searchLabelTriggered() {
    return this.labelled;
  }
  async searchTeamTriggered() {
    return [];
  }
  async listOpenPrs() {
    if (this.listFails !== null) throw new Error(this.listFails);
    return this.open;
  }
  async getPr(n: number): Promise<PrRef> {
    const found = this.closed.get(n) ?? this.open.find((p) => p.number === n);
    if (!found) throw new Error(`no such PR ${n}`);
    return found;
  }
  async listBotReviewComments() {
    return [];
  }
}

const hooks: SessionHooks = {
  async dispatchRound() {},
  async inject() {},
  async archiveAndClose() {},
};

let store: StateStore;
let gh: FakeGitHub;

beforeEach(() => {
  store = new StateStore(":memory:");
  gh = new FakeGitHub();
});

const pass = (cfg: Config, over: Partial<ReconcileDeps> = {}) =>
  reconcileOnce({ cfg, store, adapter: gh, hooks, ...over });

interface Transition {
  from: string | null;
  to: string;
  event: string;
  reason: string | null;
  source?: string;
}

/** Every trigger the lifecycle log holds for a pull request, oldest first. */
const triggersOf = (pr: number): Transition[] =>
  (
    store.db
      .prepare("SELECT payload FROM events WHERE kind = 'pr_transition' AND pr = ? ORDER BY id")
      .all(pr) as Array<{ payload: string }>
  )
    .map((r) => JSON.parse(r.payload) as Transition)
    .filter((t) => t.event === "trigger");

/** The record of the every-pull-request trigger taking a pull request. */
const takenOf = (pr: number): Array<{ head_sha: string; queued: boolean; covered?: string }> =>
  (
    store.db
      .prepare("SELECT payload FROM events WHERE kind = 'trigger_all_taken' AND pr = ? ORDER BY id")
      .all(pr) as Array<{ payload: string }>
  ).map((r) => JSON.parse(r.payload) as { head_sha: string; queued: boolean; covered?: string });

/** The queued round runs and ends with a verdict: the pull request is reviewed. */
function review(pr: number, verdict: "APPROVE" | "REQUEST_CHANGES" = "APPROVE"): void {
  applyEvent(store, pr, { type: "dispatched" });
  const id = store.startRound(pr, "first", ["pass-baseline"], 45, {
    head_sha: store.getPr(pr)!.head_sha,
  });
  store.finishRound(id, verdict, 0.25);
  applyEvent(store, pr, { type: "verdict", verdict });
}

/** The queued round runs and dies without a verdict. */
function failRound(pr: number): void {
  applyEvent(store, pr, { type: "dispatched" });
  const id = store.startRound(pr, "first", ["pass-baseline"], 45, {
    head_sha: store.getPr(pr)!.head_sha,
  });
  store.markRoundCancelled(id, "the provider failed", "infrastructure_failure");
  applyEvent(store, pr, { type: "round_overdue", standing: null });
}

describe("trigger = label (the default)", () => {
  it("is what a config without the key runs on, and an unlabelled pull request is left alone", async () => {
    expect(base.github.trigger).toBe("label");
    gh.open = [ref(5), ref(6)];
    const report = await pass(base);
    expect(report.errors).toEqual([]);
    expect(report.triggered).toEqual([]);
    expect(store.getPr(5)).toBeUndefined();
    expect(store.getPr(6)).toBeUndefined();
    expect(store.triggerLevel(5, "all")).toBeUndefined();
  });

  it("still picks up the labelled one, as a person's request", async () => {
    gh.open = [ref(5), ref(6)];
    gh.labelled = [item(5)];
    const report = await pass(base);
    expect(report.triggered).toEqual([5]);
    expect(store.getPr(5)).toMatchObject({ state: "queued", trigger_provenance: "human" });
    expect(store.getPr(6)).toBeUndefined();
  });
});

describe("trigger = all", () => {
  // MUTATION: drop the `trigger-all` step from reconcileOnce — nothing is
  // queued without a label, and this fails.
  it("picks up an open pull request that carries no label", async () => {
    gh.open = [ref(5), ref(6, { author: "bo" })];
    const report = await pass(all);
    expect(report.errors).toEqual([]);
    expect(report.triggered).toEqual([5, 6]);
    expect(store.getPr(5)).toMatchObject({
      state: "queued",
      head_sha: "sha5",
      title: "PR 5",
      author: "alice",
      // the poll's own derivation, never a person's request
      trigger_provenance: "system",
    });
    expect(store.getPr(5)!.trigger_ts).not.toBeNull();
    expect(triggersOf(5)).toEqual([
      { from: null, to: "queued", event: "trigger", reason: "reconcile:all", source: "reconcile" },
    ]);
    expect(takenOf(5)).toEqual([{ head_sha: "sha5", queued: true }]);
    expect(store.getPr(6)?.state).toBe("queued");
    // the normal route of this trigger is not a webhook the daemon missed
    expect(report.corrections).toBe(0);
  });

  // MUTATION: drop the `store.triggerLevel(n, "all") === true` skip, or the
  // `observeTriggerLevel(n, "all", true)` write beside the trigger — the
  // second pass queues the reviewed pull request again, and this fails.
  it("picks it up once: a reviewed pull request is not queued again, pass after pass", async () => {
    gh.open = [ref(5)];
    await pass(all);
    review(5);
    expect(store.getPr(5)?.state).toBe("tracked");
    for (let i = 0; i < 3; i++) {
      const report = await pass(all);
      expect(report.triggered).toEqual([]);
      expect(report.errors).toEqual([]);
    }
    expect(store.getPr(5)?.state).toBe("tracked");
    expect(triggersOf(5)).toHaveLength(1);
    expect(takenOf(5)).toHaveLength(1);
  });

  // MUTATION: mark the pull request only once it has a verdict (move the
  // `observeTriggerLevel` write out of the pickup) — a round that fails is
  // asked for again at every poll, and this fails.
  it("a round that failed is not asked for again by the trigger", async () => {
    gh.open = [ref(5)];
    await pass(all);
    failRound(5);
    expect(store.getPr(5)?.state).toBe("tracked");
    expect(store.roundsFor(5).some((r) => r.verdict !== null)).toBe(false);
    await pass(all);
    await pass(all);
    expect(store.getPr(5)?.state).toBe("tracked");
    expect(triggersOf(5)).toHaveLength(1);
  });

  // MUTATION: drop `if (pr.draft) continue` — the draft is queued, and this
  // fails.
  it("leaves a draft alone, and picks it up when it becomes ready", async () => {
    gh.open = [ref(7, { draft: true })];
    expect((await pass(all)).triggered).toEqual([]);
    expect(store.getPr(7)).toBeUndefined();
    // a draft is not marked: nothing says it was taken
    expect(store.triggerLevel(7, "all")).toBeUndefined();
    expect(takenOf(7)).toEqual([]);

    gh.open = [ref(7, { draft: false })];
    expect((await pass(all)).triggered).toEqual([7]);
    expect(store.getPr(7)?.state).toBe("queued");
  });

  it("never picks up a closed pull request", async () => {
    // closed on GitHub before any pass saw it: it is in no list
    gh.open = [];
    gh.closed.set(8, ref(8, { state: "closed" }));
    expect((await pass(all)).triggered).toEqual([]);
    expect(store.getPr(8)).toBeUndefined();

    // tracked here and closed on GitHub since: closed by this pass, never queued
    store.upsertPr({
      number: 9,
      state: "tracked",
      head_sha: "sha9",
      title: "PR 9",
      author: "alice",
      trigger_ts: null,
      stale_recheck: 0,
      migration_gate: 0,
    });
    gh.closed.set(9, ref(9, { state: "closed", merged: true }));
    const report = await pass(all);
    expect(report.closed).toEqual([9]);
    expect(report.triggered).toEqual([]);
    expect(store.getPr(9)?.state).toBe("closed");
    expect(triggersOf(9)).toEqual([]);
    await pass(all);
    expect(triggersOf(9)).toEqual([]);
  });

  it("a pull request reviewed before the trigger changed is marked, and not reviewed again", async () => {
    // reviewed under the label, some time ago
    gh.open = [ref(5)];
    gh.labelled = [item(5)];
    await pass(base);
    review(5, "REQUEST_CHANGES");
    gh.labelled = [];
    expect(store.getPr(5)?.state).toBe("awaiting_author");

    const report = await pass(all);
    expect(report.triggered).toEqual([]);
    expect(store.getPr(5)?.state).toBe("awaiting_author");
    expect(store.triggerLevel(5, "all")).toBe(true);
    expect(takenOf(5)).toEqual([{ head_sha: "sha5", queued: false, covered: "reviewed" }]);
    expect(triggersOf(5)).toHaveLength(1);
  });

  it("a labelled pull request is still the person's request, and is queued once", async () => {
    gh.open = [ref(5)];
    gh.labelled = [item(5)];
    const report = await pass(all);
    expect(report.triggered).toEqual([5]);
    expect(store.getPr(5)).toMatchObject({ state: "queued", trigger_provenance: "human" });
    expect(triggersOf(5).map((t) => t.source)).toEqual(["label"]);
    // its queued round is the one review this trigger owes it
    expect(takenOf(5)).toEqual([{ head_sha: "sha5", queued: false, covered: "in-flight" }]);
  });

  it("a paused pull request waits: it is picked up once the pause is lifted", async () => {
    store.upsertPr({
      number: 5,
      state: "tracked",
      head_sha: "sha5",
      title: "PR 5",
      author: "alice",
      trigger_ts: null,
      stale_recheck: 0,
      migration_gate: 0,
    });
    store.pausePr(5, { issuer: "operator", expires_at: null }, "hold this one");
    gh.open = [ref(5)];
    expect((await pass(all)).triggered).toEqual([]);
    expect(store.getPr(5)?.state).toBe("tracked");
    expect(store.triggerLevel(5, "all")).toBeUndefined();

    store.resumePr(5, "operator");
    expect((await pass(all)).triggered).toEqual([5]);
    expect(store.getPr(5)?.state).toBe("queued");
  });

  // Nothing is known to be open when the list was not read.
  it("takes nothing on a pass whose open list failed, and catches up on the next", async () => {
    gh.open = [ref(5)];
    gh.listFails = "GitHub answered 502";
    const failed = await pass(all);
    expect(failed.errors.join(" ")).toContain("listOpenPrs");
    expect(failed.triggered).toEqual([]);
    expect(store.getPr(5)).toBeUndefined();

    gh.listFails = null;
    expect((await pass(all)).triggered).toEqual([5]);
  });
});

describe("trigger = all: not the reviewer's own, whichever identity it posts under", () => {
  const filed = "An improvement.\n\n<!-- qcr-filing:improvement-2026-11-19 -->";

  // MUTATION: drop the `isBotAuthor` skip from the trigger-all step — the
  // marker is written for the App's own pull request, and this fails.
  it("an App (its own key on the machine): its bot's pull requests are skipped, a person's are not", async () => {
    expect(all.github.auth).toBe("app");
    gh.open = [
      ref(1, { author: all.github.bot_login }),
      ref(2, { author: "dependabot[bot]" }),
      ref(3, { author: "alice" }),
    ];
    expect((await pass(all)).triggered).toEqual([3]);
    for (const own of [1, 2]) {
      expect(store.getPr(own)).toBeUndefined();
      expect(store.triggerLevel(own, "all")).toBeUndefined();
    }
  });

  it("an App installation a host supplies the token of: the same rule, by the same login", async () => {
    const installation = withGithub({
      trigger: "all",
      auth: "installation",
      token_source: "host",
      app_slug: "acme-review",
      bot_login: "acme-review[bot]",
    });
    gh.open = [ref(1, { author: "acme-review[bot]" }), ref(3, { author: "alice" })];
    expect((await pass(installation)).triggered).toEqual([3]);
    expect(store.getPr(1)).toBeUndefined();
  });

  // MUTATION: drop the `isOwnContent` skip from the trigger-all step — the
  // pull request the reviewer filed under the person's login is queued for
  // its own review, and this fails.
  it("a person's account: their own pull requests are reviewed, the ones the reviewer filed are not", async () => {
    const person = withGithub({
      trigger: "all",
      auth: "user",
      app_slug: "",
      bot_login: "octo-dev",
    });
    gh.open = [
      // the person's own work: the main target under their credential
      ref(1, { author: "octo-dev", body: "My change." }),
      // filed by the reviewer under the same login: it carries the reviewer's marker
      ref(2, { author: "octo-dev", body: filed }),
      // a marker in somebody else's pull request proves nothing
      ref(3, { author: "alice", body: filed }),
      ref(4, { author: "renovate[bot]" }),
    ];
    expect((await pass(person)).triggered).toEqual([1, 3]);
    expect(store.getPr(2)).toBeUndefined();
    expect(store.getPr(4)).toBeUndefined();
  });
});

describe("a push to a pull request that is already reviewed queues nothing by itself", () => {
  // MUTATION: treat a moved head as a fresh pickup in the trigger-all step
  // (clear the mark when `local.head_sha !== pr.head_sha`) — the push queues
  // a round, and this fails for `all`.
  const both: Array<[string, Config]> = [
    ["label", base],
    ["all", all],
  ];
  it.each(both)("under trigger = %s", async (_name, cfg) => {
    gh.open = [ref(5)];
    gh.labelled = cfg === base ? [item(5)] : [];
    await pass(cfg);
    expect(store.getPr(5)?.state).toBe("queued");
    review(5, "REQUEST_CHANGES");
    // the label was consumed when the round was dispatched
    gh.labelled = [];
    const before = triggersOf(5).length;

    const pushes: string[] = [];
    for (const head of ["sha5-b", "sha5-c"]) {
      gh.open = [ref(5, { head_sha: head })];
      const report = await pass(cfg, {
        onHeadPush: async (_pr, sha) => void pushes.push(sha),
      });
      expect(report.triggered).toEqual([]);
      expect(store.getPr(5)).toMatchObject({ state: "awaiting_author", head_sha: head });
    }
    // the push was seen, and went to the recheck path, not to the queue
    expect(pushes).toEqual(["sha5-b", "sha5-c"]);
    expect(triggersOf(5)).toHaveLength(before);
    expect(store.roundsFor(5)).toHaveLength(1);
  });
});

describe("the trigger a running daemon follows", () => {
  // MUTATION: read `cfg.github.trigger` alone in reconcileOnce (ignore
  // `deps.trigger`) — the pass keeps the trigger the config was loaded with,
  // and this fails.
  it("is the config's word at this pass, over the one it was loaded with", async () => {
    gh.open = [ref(5)];
    let now: "label" | "all" = "label";
    const trigger = () => now;

    // loaded as label, and the file still says label
    expect((await pass(base, { trigger })).triggered).toEqual([]);
    // the file now says all: followed at the next pass, with the same store
    now = "all";
    expect((await pass(base, { trigger })).triggered).toEqual([5]);
    review(5);
    // and back: nothing new is taken, and what was reviewed stays reviewed
    now = "label";
    gh.open = [ref(5), ref(6)];
    expect((await pass(base, { trigger })).triggered).toEqual([]);
    expect(store.getPr(6)).toBeUndefined();
    expect(store.getPr(5)?.state).toBe("tracked");
    expect(store.roundsFor(5)).toHaveLength(1);

    // loaded as all, and the file says label: label
    expect((await pass(all, { trigger })).triggered).toEqual([]);
    expect(store.getPr(6)).toBeUndefined();
  });

  it("a reader that says nothing, or throws, leaves the loaded trigger standing", async () => {
    gh.open = [ref(5), ref(6)];
    expect((await pass(base, { trigger: () => undefined })).triggered).toEqual([]);
    const thrown = await pass(base, {
      trigger: () => {
        throw new Error("EIO");
      },
    });
    expect(thrown.triggered).toEqual([]);
    // never an error of the pass: the trigger it was loaded with is an answer
    expect(thrown.errors).toEqual([]);
    expect((await pass(all, { trigger: () => undefined })).triggered).toEqual([5, 6]);
  });
});
