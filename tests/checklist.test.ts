// qcr checklist — every automated probe against local fixtures. All I/O is
// injected (no sockets, no processes, no GitHub); the filesystem probes run in
// throwaway temp dirs.
import { afterEach, describe, expect, it } from "vitest";
import { createHmac } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  manualItems,
  diffQueues,
  exitCodeFor,
  probeDigest,
  probePingPong,
  probeQueueDiff,
  probeRestartRecovery,
  probeStalenessWake,
  probeTmux,
  probeTunnelHmac,
  renderManualItems,
  renderTable,
  runChecklist,
  safeProbe,
  signBody,
  type ChecklistDeps,
  type HttpPost,
  type ProbeResult,
} from "../src/checklist.js";
// Static, not `await import()` inside the tests: cliops pulls in a large
// graph, and a mid-test import puts its transform on the test's clock — the
// one step that stretches without bound when the machine is loaded.
import { derivedQueueOf, manualQueueOf, stalenessSimulation } from "../src/cliops.js";
import { parseConfig } from "../src/config.js";
import type { PrRef } from "../src/github.js";
import { reconcileOnce, type ReconcileAdapter } from "../src/reconcile.js";
import { StateStore, type PrLifecycleState } from "../src/state.js";
import type { SessionHooks } from "../src/types.js";
import { HEAVY_TIMEOUT_MS } from "./helpers/suite-timeouts.js";

const tmpDirs: string[] = [];
function scratch(): string {
  const d = mkdtempSync(join(tmpdir(), "qcr-checklist-"));
  tmpDirs.push(d);
  return d;
}
afterEach(() => {
  while (tmpDirs.length) rmSync(tmpDirs.pop()!, { recursive: true, force: true });
});

const SECRET = "s3cret-webhook";

/** A fixture receiver: verifies the HMAC exactly as the daemon must. */
const fakeReceiver: HttpPost = async (_url, headers, body) => {
  const sig = headers["x-hub-signature-256"] ?? "";
  const want = `sha256=${createHmac("sha256", SECRET).update(body).digest("hex")}`;
  return { status: sig === want ? 200 : 403 };
};

describe("① tunnel + HMAC probe", () => {
  it("passes when a signed delivery is accepted and a forged one rejected", async () => {
    const seen: Array<Record<string, string>> = [];
    const post: HttpPost = async (u, h, b) => {
      seen.push(h);
      return fakeReceiver(u, h, b);
    };
    const r = await probeTunnelHmac({
      url: "http://127.0.0.1:8787/webhook",
      webhookSecret: SECRET,
      post,
      hostname: "review.example.dev",
    });
    expect(r.pass).toBe(true);
    expect(r.detail).toContain("signed -> 200");
    expect(r.detail).toContain("forged -> 403");
    expect(seen).toHaveLength(2);
    expect(seen[0]!["x-github-event"]).toBe("ping");
    expect(seen[0]!["x-github-delivery"]).not.toBe(seen[1]!["x-github-delivery"]);
  });

  it("fails when a forged signature is accepted", async () => {
    const r = await probeTunnelHmac({
      url: "u",
      webhookSecret: SECRET,
      post: async () => ({ status: 200 }),
    });
    expect(r.pass).toBe(false);
    expect(r.detail).toContain("forged -> 200");
  });

  it("fails when the signed delivery does not reach the daemon (502 through the tunnel)", async () => {
    const r = await probeTunnelHmac({
      url: "u",
      webhookSecret: SECRET,
      post: async (_u, h) => ({
        status: h["x-hub-signature-256"]!.endsWith("0".repeat(8)) ? 403 : 502,
      }),
    });
    expect(r.pass).toBe(false);
    expect(r.detail).toContain("signed -> 502");
  });

  it("signBody matches GitHub's sha256= scheme", () => {
    expect(signBody("k", "body")).toBe(
      `sha256=${createHmac("sha256", "k").update("body").digest("hex")}`,
    );
  });
});

describe("② reconcile queue diff", () => {
  it("diffs the union of both trigger searches against the derived queue", () => {
    const d = diffQueues([1, 2, 2, 3], [3, 1, 4]);
    expect(d.manual).toEqual([1, 2, 3]);
    expect(d.derived).toEqual([1, 3, 4]);
    expect(d.missing).toEqual([2]);
    expect(d.extra).toEqual([4]);
  });

  it("passes on an exact match", async () => {
    const r = await probeQueueDiff({
      labelTriggered: async () => [11, 12],
      teamTriggered: async () => [13],
      derivedQueue: () => [13, 12, 11],
    });
    expect(r.pass).toBe(true);
  });

  it("fails and names the divergence", async () => {
    const r = await probeQueueDiff({
      labelTriggered: async () => [11],
      teamTriggered: async () => [12],
      derivedQueue: () => [11, 99],
    });
    expect(r.pass).toBe(false);
    expect(r.detail).toContain("missing=[12]");
    expect(r.detail).toContain("extra=[99]");
  });
});

describe("④ push does not review", () => {
  const fixture = { number: 4242, head_sha: "beef0000", approved_sha: "cafe1111" };

  it("fails when reconcile issues an unsolicited staleness round", async () => {
    const injected: unknown[] = [];
    const orders: Array<{ pr: number; round_type: string }> = [];
    const r = await probeStalenessWake({
      fixture,
      injectStalePr: (p) => void injected.push(p),
      runStalenessReconcile: async () =>
        void orders.push({ pr: fixture.number, round_type: "staleness" }),
      issuedOrders: () => orders,
    });
    expect(injected).toHaveLength(1);
    expect(r.pass).toBe(false);
    expect(r.detail).toContain("unsolicited staleness round");
  });

  it("passes when a pushed approved PR produces no staleness round", async () => {
    const r = await probeStalenessWake({
      fixture,
      injectStalePr: () => {},
      runStalenessReconcile: async () => {},
      issuedOrders: () => [{ pr: 9999, round_type: "first" }],
    });
    expect(r.pass).toBe(true);
    expect(r.detail).toContain("push stayed quiet");
  });
});

describe("④ push does not review — any unsolicited round, and a REAL fixture (selfscan)", () => {
  const fixture = { number: 4242, head_sha: "beef0000", approved_sha: "cafe1111" };

  it("fails on an unsolicited first or re-review round too, not only one spelled staleness", async () => {
    for (const round_type of ["first", "re-review"]) {
      const r = await probeStalenessWake({
        fixture,
        injectStalePr: () => {},
        runStalenessReconcile: async () => {},
        issuedOrders: () => [{ pr: fixture.number, round_type }],
      });
      expect(r.pass, round_type).toBe(false);
      expect(r.detail).toContain(round_type);
    }
  });

  it(
    "the offline simulation tracks an APPROVED PR at the old head, so reconcile really sees a push",
    { timeout: HEAVY_TIMEOUT_MS },
    async () => {
      const cfg = parseConfig(
        readFileSync(join(process.cwd(), "tests/fixtures/config.toml"), "utf8"),
      );
      const sim = stalenessSimulation(cfg, scratch());
      const r = await probeStalenessWake(sim);
      expect(r.pass).toBe(true);
      const row = sim.store.getPr(sim.fixture.number);
      expect(row).toMatchObject({ head_sha: sim.fixture.head_sha });
      expect(sim.store.reviewedHead(sim.fixture.number)).toMatchObject({
        head_sha: sim.fixture.approved_sha,
        verdict: "APPROVE",
      });
      expect(sim.store.priorRoundCount(sim.fixture.number)).toBe(1);
    },
  );
});

describe("② derived queue (selfscan)", () => {
  it("live: a reviewing PR already had its trigger consumed, so it is not owed; dry-run keeps it", async () => {
    const rows = [
      { number: 1, state: "queued" },
      { number: 2, state: "reviewing" },
      { number: 3, state: "tracked" },
    ] as const;
    expect(derivedQueueOf(rows, false)).toEqual([1]);
    expect(derivedQueueOf(rows, true)).toEqual([1, 2]);
  });

  it("dry-run: a PR reviewed at its current head keeps a trigger reconcile suppresses — dropped from the manual side; a withdrawn trigger counts nowhere", async () => {
    const store = new StateStore(":memory:");
    const heads: Record<number, [PrLifecycleState, string]> = {
      1: ["queued", "h1"],
      2: ["reviewing", "h2"],
      3: ["tracked", "h3"], // reviewed at head, label still on
      4: ["awaiting_author", "h4"], // reviewed at head, label removed
      5: ["tracked", "h5-new"], // pushed since its review
    };
    for (const [n, [state, head]] of Object.entries(heads)) seedPr(store, Number(n), state, head);
    const verdictHeads: Record<number, string> = { 2: "h2", 3: "h3", 4: "h4", 5: "h5-old" };
    for (const [n, head] of Object.entries(verdictHeads))
      store.logEvent("verdict_applied", Number(n), { head_sha: head, verdict: "COMMENT" });
    const derived = derivedQueueOf(store.allPrs(), true);
    expect(derived).toEqual([1, 2]);
    const manual = (found: number[], dryRun = true) =>
      manualQueueOf(
        found.map((n) => hit(n)),
        "label",
        dryRun,
        BOT,
        store,
      );
    // 3 is suppressed; 2 is reviewing (reconcile never reaches the check), so it stays.
    expect(manual([1, 2, 3])).toEqual([1, 2]);
    const probe = (found: number[]) =>
      probeQueueDiff({
        labelTriggered: async () => manual(found),
        teamTriggered: async () => [],
        derivedQueue: () => derived,
      });
    expect((await probe([1, 2, 3])).pass).toBe(true);
    // 4's label was withdrawn: no search finds it and nothing derives it.
    expect((await probe([1, 2])).pass).toBe(true);
    // 5 was pushed after its review: reconcile would re-queue it, so a 5
    // still unqueued is a real disagreement.
    expect((await probe([1, 2, 5])).pass).toBe(false);
    // Live, a reviewed head is not suppressed: the trigger was consumed.
    expect(manual([1, 2, 3], false)).toEqual([1, 2, 3]);
  });

  // The manual side is reconcile's own skip set: after a reconcile pass over
  // the same searches, every hit is either queued by it or skipped by both.
  for (const dryRun of [true, false]) {
    it(`agrees with a reconcile pass over the same searches (${dryRun ? "dry-run" : "live"})`, async () => {
      const store = new StateStore(":memory:");
      const runCfg = { ...checklistCfg, dry_run: dryRun };
      seedPr(store, 11, "closed", "h11"); // a lagging search still lists it
      seedPr(store, 12, "tracked", "h12");
      store.pausePr(12, { issuer: "operator", expires_at: null }, "test");
      for (const n of [13, 14]) {
        // Approved at an older head; the push recheck claimed the current one.
        seedPr(store, n, "tracked", "layout");
        store.recordReviewedHead(n, { head_sha: "approved", verdict: "APPROVE", round_no: 1 });
        store.claimRecheck(n, "push:layout::", { head_sha: "layout", trigger: "push" });
      }
      store.observeTriggerLevel(14, "label", false); // 14's label is a fresh edge
      seedPr(store, 15, "tracked", "h15");
      store.logEvent("verdict_applied", 15, { head_sha: "h15", verdict: "COMMENT" });
      const label = [10, 11, 12, 13, 14, 15, 16].map((n) =>
        hit(n, n === 16 ? "dependabot[bot]" : "alice"),
      );
      const open = [10, 12, 13, 14, 15, 16].map((n) =>
        openRef(n, store.getPr(n)?.head_sha ?? `h${n}`),
      );
      const adapter: ReconcileAdapter = {
        searchLabelTriggered: async () => label,
        searchTeamTriggered: async () => [],
        listOpenPrs: async () => open,
        getPr: async (n) => open.find((r) => r.number === n) ?? openRef(n, `h${n}`, "closed"),
        listBotReviewComments: async () => [],
      };
      const hooks: SessionHooks = {
        async dispatchRound() {},
        async inject() {},
        async injectOverseer() {},
        async archiveAndClose() {},
      };
      // The checklist reads the store BEFORE the pass that acts on 14's edge,
      // so 14 is owed and the pass then queues it.
      const before = manualQueueOf(label, "label", dryRun, BOT, store);
      await reconcileOnce({ cfg: runCfg, store, adapter, hooks });
      const derived = derivedQueueOf(store.allPrs(), dryRun);
      expect(before.sort((a, b) => a - b)).toEqual(derived);
      const after = manualQueueOf(label, "label", dryRun, BOT, store);
      expect(after.sort((a, b) => a - b)).toEqual(derived);
      expect(derived).toEqual(dryRun ? [10, 14] : [10, 14, 15]);
    });
  }
});

const BOT = "example-review[bot]";
const checklistCfg = parseConfig(
  readFileSync(join(process.cwd(), "tests/fixtures/config.toml"), "utf8"),
);

function hit(number: number, login = "alice") {
  return { number, user: { login, type: login.endsWith("[bot]") ? "Bot" : "User" } };
}

function openRef(number: number, head_sha: string, state: "open" | "closed" = "open"): PrRef {
  return {
    number,
    title: `PR ${number}`,
    author: number === 16 ? "dependabot[bot]" : "alice",
    head_sha,
    base_ref: "master",
    updated_at: "2026-08-13T09:00:00Z",
    state,
    draft: false,
    merged: false,
    labels: [],
  };
}

function seedPr(store: StateStore, number: number, state: PrLifecycleState, head: string): void {
  store.upsertPr({
    number,
    state,
    head_sha: head,
    title: `PR ${number}`,
    author: "alice",
    trigger_ts: null,
    stale_recheck: 0,
    migration_gate: 0,
  });
}

describe("⑤ ping-pong", () => {
  it("passes when the interpreter drops an inject file", async () => {
    const dir = scratch();
    const r = await probePingPong({
      injectDir: dir,
      event: { action: "created", comment: { in_reply_to_id: 7, user: { login: "author" } } },
      interpret: async () => writeFileSync(join(dir, "pr-77-reply.md"), "wake up"),
    });
    expect(r.pass).toBe(true);
    expect(r.detail).toContain("pr-77-reply.md");
  });

  it("fails when nothing is injected", async () => {
    const dir = scratch();
    writeFileSync(join(dir, "pre-existing.md"), "old");
    const r = await probePingPong({ injectDir: dir, event: {}, interpret: async () => {} });
    expect(r.pass).toBe(false);
    expect(r.detail).toContain("no new inject file");
  });
});

describe("⑦ digest presence", () => {
  function digestFixture(opts: { digest?: string; headline?: string | null }): {
    digestDir: string;
    statusPath: string;
    today: string;
  } {
    const dir = scratch();
    const digestDir = join(dir, "digest");
    mkdirSync(digestDir);
    const today = "2026-08-13";
    if (opts.digest !== undefined) writeFileSync(join(digestDir, `${today}.md`), opts.digest);
    const statusPath = join(dir, "status.json");
    writeFileSync(
      statusPath,
      JSON.stringify({
        heartbeat: new Date().toISOString(),
        ...(opts.headline ? { digest_headline: opts.headline } : {}),
      }),
    );
    return { digestDir, statusPath, today };
  }

  it("passes with the file and a headline in status.json", () => {
    const r = probeDigest(
      digestFixture({ digest: "# EOD\n\n3 rounds, $1.20", headline: "3 rounds, $1.20" }),
    );
    expect(r.pass).toBe(true);
    expect(r.detail).toContain("3 rounds");
  });

  it("fails without today's digest", () => {
    const r = probeDigest(digestFixture({ headline: "x" }));
    expect(r.pass).toBe(false);
    expect(r.detail).toContain("missing");
  });

  it("fails when the digest exists but the headline never reached status.json", () => {
    const r = probeDigest(digestFixture({ digest: "# EOD", headline: null }));
    expect(r.pass).toBe(false);
    expect(r.detail).toContain("no digest_headline");
  });

  it("fails on an empty digest", () => {
    const r = probeDigest(digestFixture({ digest: "   \n", headline: "x" }));
    expect(r.pass).toBe(false);
    expect(r.detail).toContain("empty");
  });
});

describe("⑧ tmux attach", () => {
  it("passes with an overseer and at least one pr- session", async () => {
    const r = await probeTmux({ listSessions: () => ["overseer", "pr-123", "main"] });
    expect(r.pass).toBe(true);
  });

  it("fails when the overseer is missing", async () => {
    const r = await probeTmux({ listSessions: () => ["pr-123"] });
    expect(r.pass).toBe(false);
    expect(r.detail).toContain("overseer=NO");
  });

  it("reports a missing tmux server as a failure (the correct result off-VM)", async () => {
    const r = await probeTmux({
      listSessions: () => {
        throw new Error("no server running on /tmp/tmux-1000/default");
      },
    });
    expect(r.pass).toBe(false);
    expect(r.detail).toContain("no tmux server");
  });
});

describe("⑨ restart recovery", () => {
  function statusFixture(heartbeatIso: string | null): string {
    const dir = scratch();
    const p = join(dir, "status.json");
    writeFileSync(p, JSON.stringify(heartbeatIso === null ? {} : { heartbeat: heartbeatIso }));
    return p;
  }
  const now = () => new Date("2026-08-13T18:00:00Z");

  it("passes on a fresh heartbeat and a clean adopt pass", async () => {
    const r = await probeRestartRecovery({
      statusPath: statusFixture("2026-08-13T17:59:00Z"),
      adoptExistingSessions: () => ["pr-123", "overseer"],
      now,
    });
    expect(r.pass).toBe(true);
    expect(r.detail).toContain("pr-123");
  });

  it("fails on a stale heartbeat", async () => {
    const r = await probeRestartRecovery({
      statusPath: statusFixture("2026-08-13T17:00:00Z"),
      adoptExistingSessions: () => [],
      now,
    });
    expect(r.pass).toBe(false);
    expect(r.detail).toContain("3600s old");
  });

  it("fails when the adopt pass throws", async () => {
    const r = await probeRestartRecovery({
      statusPath: statusFixture("2026-08-13T17:59:30Z"),
      adoptExistingSessions: () => {
        throw new Error("session pr-9 has no worktree");
      },
      now,
    });
    expect(r.pass).toBe(false);
    expect(r.detail).toContain("adopt pass threw");
  });

  it("fails when there is no status.json at all", async () => {
    const r = await probeRestartRecovery({
      statusPath: join(scratch(), "nope.json"),
      adoptExistingSessions: () => [],
      now,
    });
    expect(r.pass).toBe(false);
    expect(r.detail).toContain("never wrote a heartbeat");
  });
});

describe("table + exit code + manual items", () => {
  const results: ProbeResult[] = [
    { item: "①", name: "tunnel + HMAC", pass: true, detail: "ok" },
    { item: "⑧", name: "tmux attach", pass: false, detail: "no tmux server" },
  ];

  it("renders an aligned pass/fail table with a summary line", () => {
    const t = renderTable(results);
    expect(t).toContain("PASS");
    expect(t).toContain("FAIL");
    expect(t).toContain("1/2 automated items FAILED: ⑧");
  });

  it("exit code is 0 only when every automated item passes", () => {
    expect(exitCodeFor(results)).toBe(1);
    expect(exitCodeFor([results[0]!])).toBe(0);
    expect(
      exitCodeFor([
        { item: "③", name: "live test PR", pass: false, detail: "manual", manual: true },
      ]),
    ).toBe(0);
  });

  it("guided-manual items are text only — ③ and ⑥, never automated", () => {
    expect(manualItems().map((m) => m.item)).toEqual(["③", "⑥"]);
    const text = renderManualItems();
    expect(text).toContain("never automated");
    expect(text).toContain("Restore dry_run = true afterwards");
  });

  it("renders the configured bot login into the manual prose", () => {
    expect(renderManualItems("example-review[bot]")).toContain(
      "the review is posted as example-review[bot]",
    );
    // No configured login degrades to the role, never to a personal name.
    expect(renderManualItems()).toContain("the review is posted as the review App bot");
    expect(renderManualItems()).not.toContain("owner_legacy");
  });

  it("renders the configured labels, and has the operator close the PR before the worktree goes", () => {
    const text = renderManualItems("example-review[bot]", {
      trigger: "please-review",
      in_progress: "reviewing",
      reviewed: "reviewed",
    });
    expect(text).toContain('"please-review" label');
    expect(text).toContain('"reviewing" cycles, then "reviewed" lands');
    expect(text).not.toContain("AI review requested");
    expect(renderManualItems()).toContain('"AI review requested" label');
    expect(text).not.toContain("created and removed again");
    expect(text).toContain("close the test PR: its worktree is removed");
  });

  it("safeProbe turns a throwing probe into a failed item", async () => {
    const r = await safeProbe("②", "x", async () => {
      throw new Error("boom");
    });
    expect(r).toMatchObject({ item: "②", pass: false });
    expect(r.detail).toContain("boom");
  });
});

describe("runChecklist", () => {
  function deps(overrides: Partial<ChecklistDeps> = {}): ChecklistDeps {
    const dir = scratch();
    const digestDir = join(dir, "digest");
    const injectDir = join(dir, "inject");
    mkdirSync(digestDir);
    mkdirSync(injectDir);
    const today = "2026-08-13";
    writeFileSync(join(digestDir, `${today}.md`), "# EOD\n2 rounds");
    const statusPath = join(dir, "status.json");
    writeFileSync(
      statusPath,
      JSON.stringify({ heartbeat: "2026-08-13T17:59:00Z", digest_headline: "2 rounds, $0.80" }),
    );
    return {
      tunnel: { url: "http://127.0.0.1:8787/webhook", webhookSecret: SECRET, post: fakeReceiver },
      queue: {
        labelTriggered: async () => [1],
        teamTriggered: async () => [2],
        derivedQueue: () => [1, 2],
      },
      staleness: {
        fixture: { number: 5, head_sha: "aaa", approved_sha: "bbb" },
        injectStalePr: () => {},
        runStalenessReconcile: async () => {},
        issuedOrders: () => [],
      },
      pingPong: {
        injectDir,
        event: {},
        interpret: async () => writeFileSync(join(injectDir, "pr-5.md"), "x"),
      },
      digest: { digestDir, statusPath, today },
      tmux: { listSessions: () => ["overseer", "pr-5"] },
      restart: {
        statusPath,
        adoptExistingSessions: () => ["pr-5"],
        now: () => new Date("2026-08-13T18:00:00Z"),
      },
      ...overrides,
    };
  }

  it("runs the seven automated items in checklist order and exits 0 when all pass", async () => {
    const out: string[] = [];
    const run = await runChecklist(deps(), (s) => out.push(s));
    expect(run.results.map((r) => r.item)).toEqual(["①", "②", "④", "⑤", "⑦", "⑧", "⑨"]);
    expect(run.results.every((r) => r.pass)).toBe(true);
    expect(run.exitCode).toBe(0);
    expect(out.join("\n")).toContain("all 7 automated items PASS");
    expect(out.join("\n")).toContain("Guided-manual items");
  });

  it("exits 1 when any automated item fails, and keeps running the rest", async () => {
    const run = await runChecklist(
      deps({
        tmux: {
          listSessions: () => {
            throw new Error("no server running");
          },
        },
      }),
      () => {},
    );
    expect(run.exitCode).toBe(1);
    expect(run.results).toHaveLength(7);
    expect(run.results.find((r) => r.item === "⑧")!.pass).toBe(false);
    expect(run.results.find((r) => r.item === "⑨")!.pass).toBe(true);
  });
});
