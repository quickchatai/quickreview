// Ledger freshness enforcement: after each verdicted round the
// daemon requires `state/ledgers/pr-<n>.md` to be headed
// `LEDGER PR #<n> @ <round head>`. Stale/missing ⇒ queryable anomaly + exactly
// one re-nudge per round through wakeOrHold — never a loop.
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { parseConfig, type Config } from "../src/config.js";
import type { GateResult } from "@quickchatai/pi-quickreview/src/gate.js";
import {
  classifyLedger,
  enforceLedgerFreshness,
  ledgerRewriteWake,
  type LedgerCheckDeps,
} from "../src/ledgercheck.js";
import { RecheckWatcher } from "../src/recheck.js";
import { StateStore } from "../src/state.js";
import type { SessionHooks } from "@quickchatai/pi-quickreview/src/types.js";
import { VerdictWatcher, type VerdictAdapter } from "../src/verdicts.js";
import { HEAVY_TIMEOUT_MS } from "./helpers/suite-timeouts.js";

const cfg: Config = parseConfig(
  readFileSync(resolve(process.cwd(), "tests/fixtures/config.toml"), "utf8"),
);

const HEAD = "abcdef1234567890abcdef1234567890abcdef12";

let dir: string;
let store: StateStore;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "qcr-ledger-"));
  store = new StateStore(":memory:");
});

afterEach(() => {
  store.close();
  rmSync(dir, { recursive: true, force: true });
});

function writeLedger(pr: number, body: string): string {
  const ledgerDir = join(dir, "state", "ledgers");
  mkdirSync(ledgerDir, { recursive: true });
  const path = join(ledgerDir, `pr-${pr}.md`);
  writeFileSync(path, body);
  return path;
}

function deps(injects: string[]): LedgerCheckDeps {
  return {
    store,
    ledgerPathFor: (pr) => join(dir, "state", "ledgers", `pr-${pr}.md`),
    inject: async (pr, message) => {
      injects.push(`${pr}:${message}`);
    },
  };
}

function anomalyKinds(): string[] {
  return store.anomalies().map((a) => a.kind);
}

describe("classifyLedger", () => {
  it(
    "accepts a full-sha header and an abbreviated (≥7) prefix",
    { timeout: HEAVY_TIMEOUT_MS },
    () => {
      expect(classifyLedger(`LEDGER PR #7 @ ${HEAD}\n- state`, 7, HEAD)).toBe("fresh");
      expect(classifyLedger(`LEDGER PR #7 @ ${HEAD.slice(0, 12)}\n- state`, 7, HEAD)).toBe("fresh");
      expect(classifyLedger(`LEDGER PR #7 @ ${HEAD.slice(0, 7).toUpperCase()}`, 7, HEAD)).toBe(
        "fresh",
      );
    },
  );

  it("flags missing / unparseable / wrong PR / stale sha", () => {
    expect(classifyLedger(null, 7, HEAD)).toBe("missing");
    expect(classifyLedger("just prose, no header", 7, HEAD)).toBe("unparseable");
    expect(classifyLedger(`LEDGER PR #8 @ ${HEAD}`, 7, HEAD)).toBe("wrong_pr");
    expect(classifyLedger("LEDGER PR #7 @ 1111111111111111", 7, HEAD)).toBe("stale_sha");
    // A too-short abbreviation is never trusted as a prefix match.
    expect(classifyLedger(`LEDGER PR #7 @ ${HEAD.slice(0, 6)}`, 7, HEAD)).toBe("stale_sha");
  });
});

describe("enforceLedgerFreshness", () => {
  it("fresh ledger → no anomaly, no nudge", async () => {
    writeLedger(7, `LEDGER PR #7 @ ${HEAD}\n- reviewed`);
    const injects: string[] = [];
    expect(await enforceLedgerFreshness(deps(injects), { pr: 7, roundNo: 2, headSha: HEAD })).toBe(
      "fresh",
    );
    expect(injects).toEqual([]);
    expect(anomalyKinds()).toEqual([]);
  });

  it("missing ledger → anomaly + exactly one nudge; repeat only logs", async () => {
    const injects: string[] = [];
    const d = deps(injects);
    expect(await enforceLedgerFreshness(d, { pr: 7, roundNo: 2, headSha: HEAD })).toBe("nudged");
    expect(injects).toHaveLength(1);
    expect(injects[0]).toContain("LEDGER REFRESH");
    expect(injects[0]).toContain(HEAD);
    expect(anomalyKinds()).toEqual(["ledger_stale"]);

    // Second stale detection, same round: anomaly recorded again, no nudge.
    expect(await enforceLedgerFreshness(d, { pr: 7, roundNo: 2, headSha: HEAD })).toBe(
      "already_nudged",
    );
    expect(injects).toHaveLength(1);
    expect(anomalyKinds()).toEqual(["ledger_stale", "ledger_stale_unresolved"]);

    // A different round nudges afresh (the cap is per round, not per PR).
    expect(await enforceLedgerFreshness(d, { pr: 7, roundNo: 3, headSha: HEAD })).toBe("nudged");
    expect(injects).toHaveLength(2);
  });

  it("stale sha and wrong-PR ledgers are enforced like missing ones", async () => {
    writeLedger(7, "LEDGER PR #7 @ 9999999999999999");
    const injects: string[] = [];
    expect(await enforceLedgerFreshness(deps(injects), { pr: 7, roundNo: 1, headSha: HEAD })).toBe(
      "nudged",
    );
    writeLedger(8, `LEDGER PR #5288 @ ${HEAD}`);
    expect(await enforceLedgerFreshness(deps(injects), { pr: 8, roundNo: 1, headSha: HEAD })).toBe(
      "nudged",
    );
    expect(injects).toHaveLength(2);
  });

  it("the wake rides wakeOrHold: held while a round runs, flushed at round end", async () => {
    store.upsertPr({
      number: 7,
      state: "reviewing",
      head_sha: HEAD,
      title: "t",
      author: "alice",
      trigger_ts: null,
      stale_recheck: 0,
      migration_gate: 0,
    });
    store.startRound(7, "first", ["pass-baseline"], 60);
    const injects: string[] = [];
    expect(await enforceLedgerFreshness(deps(injects), { pr: 7, roundNo: 1, headSha: HEAD })).toBe(
      "nudged",
    );
    expect(injects).toEqual([]); // held, not delivered mid-round
    const held = store.heldWakes(7);
    expect(held).toHaveLength(1);
    expect(held[0]?.reason).toBe("ledger_stale");
    expect(held[0]?.payload).toBe(ledgerRewriteWake(7, HEAD));
  });

  it("a delayed check for round N never queues a rewrite once round N+1 has started", async () => {
    // The tail timer fires ~90s after round 1's verdict; by then the
    // fresh-head successor (round 2, head B) is already running. A wake held
    // now would be flushed after round 2 and demand the old head's header over
    // the ledger round 2 just wrote — so the superseded check records the miss
    // and nudges nothing; round 2's own check owns the ledger now.
    store.upsertPr({
      number: 7,
      state: "reviewing",
      head_sha: "b".repeat(40),
      title: "t",
      author: "alice",
      trigger_ts: null,
      stale_recheck: 0,
      migration_gate: 0,
    });
    store.startRound(7, "first", ["pass-baseline"], 60);
    store.startRound(7, "re-review", ["pass-baseline"], 60);
    const injects: string[] = [];
    expect(await enforceLedgerFreshness(deps(injects), { pr: 7, roundNo: 1, headSha: HEAD })).toBe(
      "superseded",
    );
    expect(injects).toEqual([]);
    expect(store.heldWakes(7)).toEqual([]);
    expect(store.ledgerNudgeSent(7, "round-1")).toBe(false);
    // The miss itself stays on the durable anomaly record.
    expect(anomalyKinds()).toEqual(["ledger_stale"]);
    // Round 2's own check is untouched by the superseded one.
    expect(
      await enforceLedgerFreshness(deps(injects), { pr: 7, roundNo: 2, headSha: "b".repeat(40) }),
    ).toBe("nudged");
    expect(store.heldWakes(7).map((w) => w.payload)).toEqual([
      ledgerRewriteWake(7, "b".repeat(40)),
    ]);
  });

  it("a round-less (recheck) check for a head the PR has moved past never queues a rewrite", async () => {
    store.upsertPr({
      number: 7,
      state: "reviewing",
      head_sha: "b".repeat(40),
      title: "t",
      author: "alice",
      trigger_ts: null,
      stale_recheck: 0,
      migration_gate: 0,
    });
    store.startRound(7, "re-review", ["pass-baseline"], 60);
    const injects: string[] = [];
    expect(
      await enforceLedgerFreshness(deps(injects), { pr: 7, roundNo: null, headSha: HEAD }),
    ).toBe("superseded");
    expect(injects).toEqual([]);
    expect(store.heldWakes(7)).toEqual([]);
    expect(anomalyKinds()).toEqual(["ledger_stale"]);
  });

  it("round-less (recheck) checks key the once-cap by head", async () => {
    const injects: string[] = [];
    const d = deps(injects);
    expect(await enforceLedgerFreshness(d, { pr: 7, roundNo: null, headSha: HEAD })).toBe("nudged");
    expect(await enforceLedgerFreshness(d, { pr: 7, roundNo: null, headSha: HEAD })).toBe(
      "already_nudged",
    );
    expect(await enforceLedgerFreshness(d, { pr: 7, roundNo: null, headSha: "f".repeat(40) })).toBe(
      "nudged",
    );
    expect(injects).toHaveLength(2);
  });

  // prompts/round-recheck.md: an uphold updates the ledger only "if the delta
  // settled or re-opened a finding". A plain uphold leaves the header naming
  // the head the PR was last reviewed at (or a head an earlier recheck upheld).
  // MUTATION: drop the recheck-path accepted heads in enforceLedgerFreshness — this fails.
  it("a recheck uphold accepts the ledger of the last reviewed head or an upheld head", async () => {
    const OLD = "0".repeat(40);
    const MID = "1".repeat(40);
    store.upsertPr({
      number: 7,
      state: "tracked",
      head_sha: HEAD,
      title: "t",
      author: "alice",
      trigger_ts: null,
      stale_recheck: 0,
      migration_gate: 0,
    });
    const id = store.startRound(7, "first", ["pass-baseline"], 60, { head_sha: OLD });
    store.finishRound(id, "APPROVE", null);
    const injects: string[] = [];
    const d = deps(injects);

    writeLedger(7, `LEDGER PR #7 @ ${OLD.slice(0, 12)}\n- reviewed`);
    expect(await enforceLedgerFreshness(d, { pr: 7, roundNo: null, headSha: HEAD })).toBe("fresh");

    store.logEvent("recheck_upheld", 7, { file: "f", head_sha: MID, reason: null });
    writeLedger(7, `LEDGER PR #7 @ ${MID}\n- reviewed`);
    expect(await enforceLedgerFreshness(d, { pr: 7, roundNo: null, headSha: HEAD })).toBe("fresh");
    expect(injects).toEqual([]);
    expect(anomalyKinds()).toEqual([]);

    // A head nobody reviewed or upheld is still stale on the recheck path…
    writeLedger(7, "LEDGER PR #7 @ 9999999999999999");
    expect(await enforceLedgerFreshness(d, { pr: 7, roundNo: null, headSha: HEAD })).toBe("nudged");
    // …and the round-end check still wants the round's own head.
    writeLedger(7, `LEDGER PR #7 @ ${OLD}`);
    expect(await enforceLedgerFreshness(d, { pr: 7, roundNo: 2, headSha: HEAD })).toBe("nudged");
  });

  // MUTATION: log ledger_stale_unresolved on every already_nudged check — this fails.
  it("an ignored nudge raises ledger_stale_unresolved once per key; later repeats stay quiet", async () => {
    const injects: string[] = [];
    const d = deps(injects);
    expect(await enforceLedgerFreshness(d, { pr: 7, roundNo: null, headSha: HEAD })).toBe("nudged");
    for (let i = 0; i < 3; i++)
      expect(await enforceLedgerFreshness(d, { pr: 7, roundNo: null, headSha: HEAD })).toBe(
        "already_nudged",
      );
    expect(anomalyKinds()).toEqual(["ledger_stale", "ledger_stale_unresolved"]);
    const repeats = store.db
      .prepare("SELECT COUNT(*) AS c FROM events WHERE kind = 'ledger_stale_repeat'")
      .get() as { c: number };
    expect(repeats.c).toBe(3);
    // Another key is its own: round 2's ignored nudge is raised once too.
    await enforceLedgerFreshness(d, { pr: 7, roundNo: 2, headSha: HEAD });
    await enforceLedgerFreshness(d, { pr: 7, roundNo: 2, headSha: HEAD });
    expect(anomalyKinds().filter((k) => k === "ledger_stale_unresolved")).toHaveLength(2);
  });

  it("the wake text is bookkeeping-only: rewrite the ledger, nothing else", () => {
    const wake = ledgerRewriteWake(7, HEAD);
    expect(wake).toContain(`LEDGER PR #7 @ ${HEAD}`);
    expect(wake).toContain("Do NOT do any review work");
    expect(wake).toContain("do NOT post anything to GitHub");
    expect(wake).toContain("do NOT write a verdict file");
  });
});

// ---- round-end integration (VerdictWatcher.apply tail) ---------------------

class FakeAdapter implements VerdictAdapter {
  async addLabel(): Promise<GateResult> {
    return { executed: false, dryRunFile: "d" };
  }
  async removeLabel(): Promise<GateResult> {
    return { executed: false, dryRunFile: "d" };
  }
}

function recordingHooks(): { hooks: SessionHooks; injects: string[] } {
  const injects: string[] = [];
  return {
    injects,
    hooks: {
      async dispatchRound() {},
      async inject(pr, msg) {
        injects.push(`${pr}:${msg}`);
      },
      async archiveAndClose() {},
    },
  };
}

describe("VerdictWatcher round-end ledger check", () => {
  function setup(): { watcher: VerdictWatcher; injects: string[] } {
    const { hooks, injects } = recordingHooks();
    const watcher = new VerdictWatcher({
      cfg,
      store,
      adapter: new FakeAdapter(),
      hooks,
      verdictDir: join(dir, "verdict"),
      root: dir,
      usage: {},
      partialWrite: { windowMs: 0 },
      // Inline: the production settle delay (it avoids a compaction race) is
      // covered in verdicts.test.ts; these tests pin the check itself.
      ledgerCheckDelayMs: 0,
    });
    return { watcher, injects };
  }

  function verdicted(pr: number): void {
    store.upsertPr({
      number: pr,
      state: "reviewing",
      head_sha: HEAD,
      title: "t",
      author: "alice",
      trigger_ts: null,
      stale_recheck: 0,
      migration_gate: 0,
    });
    store.startRound(pr, "first", ["pass-baseline"], cfg.daemon.round_deadline_min);
    mkdirSync(join(dir, "verdict"), { recursive: true });
    writeFileSync(
      join(dir, "verdict", `pr-${pr}-round-1.json`),
      JSON.stringify({
        pr,
        round_no: 1,
        verdict: "REQUEST_CHANGES",
        head_sha: HEAD,
        finished_at: "2026-08-19T12:00:00Z",
      }),
    );
  }

  it("fresh ledger at the verdict head → verdict applies, no nudge", async () => {
    verdicted(100);
    writeLedger(100, `LEDGER PR #100 @ ${HEAD}\n- all settled`);
    const { watcher, injects } = setup();
    await watcher.sweep();
    expect(injects).toEqual([]);
    expect(anomalyKinds()).toEqual([]);
  });

  it("missing ledger → anomaly + one nudge", async () => {
    verdicted(100);
    const { watcher, injects } = setup();
    await watcher.sweep();
    expect(injects).toHaveLength(1);
    expect(injects[0]).toContain("100:LEDGER REFRESH — PR #100");
    expect(anomalyKinds()).toEqual(["ledger_stale"]);
    // Re-running the enforcement for the same round never nudges again.
    await enforceLedgerFreshness(
      {
        store,
        ledgerPathFor: (n) => join(dir, "state", "ledgers", `pr-${n}.md`),
        inject: async (pr, msg) => {
          injects.push(`${pr}:${msg}`);
        },
      },
      { pr: 100, roundNo: 1, headSha: HEAD },
    );
    expect(injects).toHaveLength(1);
  });

  it("a stale-PR ledger (sibling leak shape) is caught", async () => {
    verdicted(101);
    writeLedger(101, `LEDGER PR #5288 @ ${HEAD}`); // a sibling PR's ledger header
    const { watcher, injects } = setup();
    await watcher.sweep();
    expect(injects).toHaveLength(1);
    const anomalies = store.anomalies();
    expect(anomalies[0]?.kind).toBe("ledger_stale");
    expect(anomalies[0]?.detail).toContain("wrong_pr");
  });
});

// ---- recheck-uphold wiring -------------------------------------------------

describe("RecheckWatcher ledger check on uphold", () => {
  it("calls checkLedger on uphold, not on request_changes; survives a throwing check", async () => {
    const calls: string[] = [];
    const verdictDir = join(dir, "verdict");
    mkdirSync(verdictDir, { recursive: true });
    const watcher = new RecheckWatcher({
      cfg,
      store,
      verdictDir,
      partialWrite: { windowMs: 0 },
      checkLedger: async (pr, head) => {
        calls.push(`${pr}:${head}`);
        throw new Error("boom"); // must never disturb the decision path
      },
    });
    const head12 = HEAD.slice(0, 12);
    writeFileSync(
      join(verdictDir, `pr-100-recheck-${head12}.json`),
      JSON.stringify({ pr: 100, head_sha: HEAD, outcome: "uphold" }),
    );
    expect(await watcher.sweep()).toHaveLength(1);
    expect(calls).toEqual([`100:${HEAD}`]);

    store.upsertPr({
      number: 101,
      state: "awaiting_author",
      head_sha: HEAD,
      title: "t",
      author: "alice",
      trigger_ts: null,
      stale_recheck: 0,
      migration_gate: 0,
    });
    writeFileSync(
      join(verdictDir, `pr-101-recheck-${head12}.json`),
      JSON.stringify({ pr: 101, head_sha: HEAD, outcome: "request_changes" }),
    );
    await watcher.sweep();
    expect(calls).toHaveLength(1); // request_changes path never checks
  });
});

describe("RecheckWatcher ledger check on a closed PR", () => {
  it("does not run the ledger check for an uphold decision of a closed PR", async () => {
    const calls: string[] = [];
    const verdictDir = join(dir, "verdict");
    mkdirSync(verdictDir, { recursive: true });
    store.upsertPr({
      number: 102,
      state: "closed",
      head_sha: HEAD,
      title: "t",
      author: "alice",
      trigger_ts: null,
      stale_recheck: 0,
      migration_gate: 0,
    });
    const watcher = new RecheckWatcher({
      cfg,
      store,
      verdictDir,
      partialWrite: { windowMs: 0 },
      checkLedger: async (pr, head) => {
        calls.push(`${pr}:${head}`);
      },
    });
    writeFileSync(
      join(verdictDir, `pr-102-recheck-${HEAD.slice(0, 12)}.json`),
      JSON.stringify({ pr: 102, head_sha: HEAD, outcome: "uphold" }),
    );
    expect(await watcher.sweep()).toHaveLength(1);
    expect(calls).toEqual([]);
  });
});

describe("StateStore ledger nudge mark", () => {
  it("is keyed per (pr, key) and scans without a recency window", () => {
    expect(store.ledgerNudgeSent(7, "round-1")).toBe(false);
    store.recordLedgerNudge(7, "round-1", { head_sha: HEAD });
    expect(store.ledgerNudgeSent(7, "round-1")).toBe(true);
    expect(store.ledgerNudgeSent(7, "round-2")).toBe(false);
    expect(store.ledgerNudgeSent(8, "round-1")).toBe(false);
    // Bury the mark under other events — no recency window may lose it.
    for (let i = 0; i < 150; i++) store.logEvent("noise", 7, { i });
    expect(store.ledgerNudgeSent(7, "round-1")).toBe(true);
  });
});
