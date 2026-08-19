import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { parseConfig, type Config } from "../src/config.js";
import type { GateResult } from "../src/gate.js";
import { StateStore } from "../src/state.js";
import type { SessionHooks, VerdictFile } from "../src/types.js";
import { AnomalyWakePolicy } from "../src/anomalies.js";
import { validateVerdict, VerdictWatcher, type VerdictAdapter } from "../src/verdicts.js";

const cfg: Config = parseConfig(readFileSync(resolve(process.cwd(), "config.toml"), "utf8"));

/** Recording adapter — stands in for GitHubAdapter + MutationGate. */
class FakeAdapter implements VerdictAdapter {
  calls: string[] = [];
  /** Optional checks read (ci_state stamping); absent by default. */
  listChecks?: (ref: string) => Promise<import("../src/cigate.js").CheckSummary[]>;
  async addLabel(n: number, label: string): Promise<GateResult> {
    this.calls.push(`addLabel:${n}:${label}`);
    return { executed: false, dryRunFile: "d" };
  }
  async removeLabel(n: number, label: string): Promise<GateResult> {
    this.calls.push(`removeLabel:${n}:${label}`);
    return { executed: false, dryRunFile: "d" };
  }
}

/** Mirror daemon.ts's wiring: anomaly wakes flow store → sink → hooks. */
function wireWake(s: StateStore, hooks: SessionHooks): void {
  const policy = new AnomalyWakePolicy({ injectOverseer: (m) => hooks.injectOverseer(m) });
  s.setAnomalySink((sig) => policy.onAnomaly(sig));
}

function recordingHooks(): { hooks: SessionHooks; overseer: string[]; injects: string[] } {
  const overseer: string[] = [];
  const injects: string[] = [];
  return {
    overseer,
    injects,
    hooks: {
      async dispatchRound() {},
      async inject(pr, msg) {
        injects.push(`${pr}:${msg}`);
      },
      async injectOverseer(msg) {
        overseer.push(msg);
      },
      async archiveAndClose() {},
    },
  };
}

let dir: string;
let store: StateStore;
let adapter: FakeAdapter;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "qcr-verdict-"));
  store = new StateStore(":memory:");
  adapter = new FakeAdapter();
});

afterEach(() => {
  store.close();
  rmSync(dir, { recursive: true, force: true });
});

function reviewingRound(pr: number): number {
  store.upsertPr({
    number: pr,
    state: "reviewing",
    head_sha: "abc123",
    title: `PR ${pr}`,
    author: "alice",
    trigger_ts: null,
    stale_recheck: 0,
    migration_gate: 0,
  });
  return store.startRound(pr, "first", ["pass-baseline", "pass-validate"], cfg.daemon.round_deadline_min);
}

function write(pr: number, round: number, body: unknown): string {
  const name = `pr-${pr}-round-${round}.json`;
  writeFileSync(join(dir, name), typeof body === "string" ? body : JSON.stringify(body));
  return name;
}

const verdictFile = (over: Partial<VerdictFile> = {}): VerdictFile => ({
  pr: 100,
  round_no: 1,
  verdict: "REQUEST_CHANGES",
  head_sha: "abc123",
  spend_usd: 2.25,
  finished_at: "2026-08-13T12:00:00Z",
  ...over,
});

function watcher(over: Partial<ConstructorParameters<typeof VerdictWatcher>[0]> = {}, hooks?: SessionHooks): VerdictWatcher {
  const h = hooks ?? recordingHooks().hooks;
  wireWake((over.store as StateStore | undefined) ?? store, h);
  return new VerdictWatcher({
    cfg,
    store,
    adapter,
    hooks: h,
    verdictDir: dir,
    root: dir, // usage measurement stays inside the temp dir…
    usage: { globalStoreDir: null }, // …and never scans the real ~/.pi store
    parseRetries: 0,
    retryDelayMs: 1,
    ...over,
  });
}

describe("validateVerdict", () => {
  it("accepts and caps an optional summary; rejects non-strings", () => {
    const ok = validateVerdict({ ...verdictFile(), summary: "  Adds retry to the CRM send. Round found two nits. Awaiting author. " });
    expect(ok.ok).toBe(true);
    if (ok.ok) expect(ok.verdict?.summary).toBe("Adds retry to the CRM send. Round found two nits. Awaiting author.");
    const long = validateVerdict({ ...verdictFile(), summary: "x".repeat(2000) });
    expect(long.ok).toBe(true);
    if (long.ok) expect(long.verdict?.summary?.length).toBe(800);
    expect(validateVerdict({ ...verdictFile(), summary: 42 }).ok).toBe(false);
  });

  it("accepts a well-formed verdict", () => {
    expect(validateVerdict(verdictFile()).ok).toBe(true);
    expect(validateVerdict(verdictFile({ verdict: "ESCALATE", ai_approved: true })).ok).toBe(true);
  });

  it("rejects bad shapes", () => {
    expect(validateVerdict(null).ok).toBe(false);
    expect(validateVerdict({ ...verdictFile(), verdict: "APPROVE_ANYWAY" }).ok).toBe(false);
    expect(validateVerdict({ ...verdictFile(), pr: "100" }).ok).toBe(true); // digit-strings coerce (live-round regression)
    expect(validateVerdict({ ...verdictFile(), pr: "100x" }).ok).toBe(false);
    expect(validateVerdict({ ...verdictFile(), head_sha: "" }).ok).toBe(false);
    // spend_usd is legacy: accepted in ANY shape and stripped, never stored.
    const legacy = validateVerdict({ ...verdictFile(), spend_usd: "2.25" });
    expect(legacy.ok).toBe(true);
    if (legacy.ok) expect(legacy.verdict?.spend_usd).toBeUndefined();
    const { finished_at, ...missing } = verdictFile();
    expect(validateVerdict(missing).ok).toBe(false);
  });
});

describe("valid verdicts", () => {
  it("applies the REQUEST_CHANGES handoff: labels, round, transition", async () => {
    const roundId = reviewingRound(100);
    const name = write(100, 1, verdictFile());
    await watcher().handleFile(name);

    expect(adapter.calls).toEqual([
      `removeLabel:100:${cfg.github.in_progress_label}`,
      `addLabel:100:${cfg.github.reviewed_label}`,
    ]);
    const round = store.db.prepare("SELECT * FROM rounds WHERE id = ?").get(roundId) as any;
    expect(round.status).toBe("done");
    expect(round.verdict).toBe("REQUEST_CHANGES");
    expect(round.spend_usd).toBeNull(); // self-reported spend is fiction — ignored
    expect(store.getPr(100)!.state).toBe("awaiting_author");
    expect(readdirSync(dir).filter((f) => f.endsWith(".json"))).toEqual([]); // consumed
    expect(readdirSync(join(dir, "processed")).length).toBe(1);
  });

  it("stamps the reviewed-head mark with the head and the verdict", async () => {
    reviewingRound(106);
    await watcher().handleFile(write(106, 1, verdictFile({ pr: 106, head_sha: "abc123" })));
    expect(store.reviewedHead(106)).toMatchObject({
      head_sha: "abc123",
      verdict: "REQUEST_CHANGES",
      round_no: 1,
    });
  });

  it("APPROVE lands the PR back on tracked", async () => {
    reviewingRound(101);
    await watcher().handleFile(write(101, 1, verdictFile({ pr: 101, verdict: "APPROVE" })));
    expect(store.getPr(101)!.state).toBe("tracked");
  });

  // These park pins carry `passes` telemetry: since 2026-08-19 a NEEDS_HUMAN
  // with no executed-pass evidence is an unfinished review and is requeued,
  // not parked (see self-requeue.test.ts "NEEDS_HUMAN requires a finished review").
  it("NEEDS_HUMAN parks the PR locally and touches no reviewer on GitHub", async () => {
    reviewingRound(102);
    await watcher().handleFile(write(102, 1, verdictFile({ pr: 102, verdict: "NEEDS_HUMAN", ai_approved: true, passes: [{ name: "pass-baseline", tier: "sol-med", findings: 1 }] })));
    expect(store.getPr(102)!.state).toBe("awaiting_human");
    // The whole GitHub surface of a park: labels, nothing else.
    expect(adapter.calls.every((c) => c.startsWith("addLabel") || c.startsWith("removeLabel"))).toBe(true);
    const logged = JSON.parse(
      (store.db.prepare("SELECT payload FROM events WHERE kind = 'verdict_applied'").get() as { payload: string }).payload,
    );
    expect(logged).toMatchObject({ verdict: "NEEDS_HUMAN", ai_approved: true });
    expect(logged).not.toHaveProperty("escalation_skipped");
  });

  it("accepts a legacy ESCALATE verdict as NEEDS_HUMAN (the frozen seed still emits it)", async () => {
    reviewingRound(105);
    await watcher().handleFile(write(105, 1, verdictFile({ pr: 105, verdict: "ESCALATE", passes: [{ name: "pass-baseline", tier: "sol-med", findings: 1 }] })));
    expect(store.getPr(105)!.state).toBe("awaiting_human");
    const logged = JSON.parse(
      (store.db.prepare("SELECT payload FROM events WHERE kind = 'verdict_applied'").get() as { payload: string }).payload,
    );
    expect(logged.verdict).toBe("NEEDS_HUMAN"); // normalised on the way in
  });

  it("startup sweep consumes every pending file", async () => {
    reviewingRound(103);
    reviewingRound(104);
    write(103, 1, verdictFile({ pr: 103, verdict: "APPROVE" }));
    write(104, 1, verdictFile({ pr: 104, verdict: "NEEDS_HUMAN", passes: [{ name: "pass-baseline", tier: "sol-med", findings: 1 }] }));
    writeFileSync(join(dir, "notes.txt"), "ignore me");
    const done = await watcher().sweep();
    expect(done.sort()).toEqual(["pr-103-round-1.json", "pr-104-round-1.json"]);
    expect(store.getPr(103)!.state).toBe("tracked");
    expect(store.getPr(104)!.state).toBe("awaiting_human");
  });

  it("tolerates a partial write by retrying the parse", async () => {
    reviewingRound(105);
    const name = write(105, 1, '{"pr": 105, "round_no": 1, "verdi');
    const w = watcher({ parseRetries: 3, retryDelayMs: 5 });
    const pending = w.handleFile(name);
    setTimeout(() => write(105, 1, verdictFile({ pr: 105, verdict: "APPROVE" })), 8);
    await pending;
    expect(store.getPr(105)!.state).toBe("tracked");
    expect(store.db.prepare("SELECT COUNT(*) AS c FROM events WHERE kind = 'verdict_malformed'").get()).toMatchObject({ c: 0 });
  });
});

describe("measured round usage", () => {
  const jsonlLine = (input: number, output: number): string =>
    JSON.stringify({ type: "message", timestamp: new Date().toISOString(), message: { role: "assistant", usage: { input, output } } });
  const modelLine = (): string => JSON.stringify({ type: "model_change", provider: "openai-codex", modelId: "gpt-5.6-sol" });
  const bashLine = (command: string): string =>
    JSON.stringify({
      type: "message",
      timestamp: new Date().toISOString(),
      message: { role: "assistant", content: [{ type: "toolCall", name: "bash", arguments: { command } }] },
    });

  function writeSessionJsonl(pr: number, lines: string[]): void {
    const sessionDir = join(dir, cfg.pi.session_dir, `pr-${pr}`);
    mkdirSync(sessionDir, { recursive: true });
    writeFileSync(join(sessionDir, "session.jsonl"), lines.join("\n"));
  }

  it("prefers pi's own usage.cost.total when records carry it", async () => {
    const roundId = reviewingRound(103);
    const costLine = JSON.stringify({
      type: "message",
      timestamp: new Date().toISOString(),
      message: {
        role: "assistant",
        usage: { input: 500, output: 50, cacheRead: 2000, reasoning: 25, cost: { total: 0.077 } },
      },
    });
    writeSessionJsonl(103, [modelLine(), costLine]);
    // No pricing configured — cost.total alone must carry the estimate.
    await watcher({ usage: { globalStoreDir: null, pricing: {} } }).handleFile(write(103, 1, verdictFile({ pr: 103 })));
    const round = store.db.prepare("SELECT * FROM rounds WHERE id = ?").get(roundId) as any;
    expect(round.tokens_in).toBe(500);
    expect(round.tokens_out).toBe(75); // output + reasoning
    expect(round.tokens_cache_read).toBe(2000);
    expect(round.est_usd).toBeCloseTo(0.077, 9);
  });

  it("stores measured tokens and a price-table fallback estimate on the round (no cost fields), ignoring self-reported spend", async () => {
    const roundId = reviewingRound(100);
    writeSessionJsonl(100, [modelLine(), jsonlLine(1_000_000, 500_000), jsonlLine(200_000, 100_000), "garbage line"]);
    const w = watcher({
      usage: { globalStoreDir: null, pricing: { "gpt-5.6-sol": { input_per_mtok: 2, output_per_mtok: 8 } } },
    });
    await w.handleFile(write(100, 1, verdictFile({ spend_usd: 1.25 })));

    const round = store.db.prepare("SELECT * FROM rounds WHERE id = ?").get(roundId) as any;
    expect(round.tokens_in).toBe(1_200_000);
    expect(round.tokens_out).toBe(600_000);
    expect(round.est_usd).toBeCloseTo(1.2 * 2 + 0.6 * 8, 6);
    expect(round.spend_usd).toBeNull();
  });

  it("records est_usd null when the model has no price entry", async () => {
    const roundId = reviewingRound(101);
    writeSessionJsonl(101, [modelLine(), jsonlLine(1000, 100)]);
    await watcher({ usage: { globalStoreDir: null, pricing: {} } }).handleFile(write(101, 1, verdictFile({ pr: 101 })));
    const round = store.db.prepare("SELECT * FROM rounds WHERE id = ?").get(roundId) as any;
    expect(round.tokens_in).toBe(1000);
    expect(round.est_usd).toBeNull();
  });

  it("logs exec-policy violations without inject spam, then piggybacks on an anomaly inject", async () => {
    reviewingRound(100);
    writeSessionJsonl(100, [jsonlLine(10, 1), bashLine("git diff | head"), bashLine("python manage.py test")]);
    const rec = recordingHooks();
    const w = watcher({}, rec.hooks);
    await w.handleFile(write(100, 1, verdictFile()));

    const ev = store.db.prepare("SELECT payload FROM events WHERE kind = 'exec_policy_violation'").get() as { payload: string };
    expect(JSON.parse(ev.payload)).toEqual({ commands: ["python manage.py test"] });
    expect(rec.overseer).toHaveLength(0); // violations alone never inject

    // A later anomaly on the same PR carries the pending violations line.
    store.setPrState(100, "reviewing");
    store.startRound(100, "re_review", ["pass-baseline"], cfg.daemon.round_deadline_min);
    await w.handleFile(write(100, 2, "{broken"));
    expect(rec.overseer).toHaveLength(1);
    expect(rec.overseer[0]).toContain("exec-policy violations");
    expect(rec.overseer[0]).toContain("python manage.py test");
  });

  it("survives a missing session dir (zero usage, verdict still applied)", async () => {
    const roundId = reviewingRound(102);
    await watcher().handleFile(write(102, 1, verdictFile({ pr: 102, verdict: "APPROVE" })));
    const round = store.db.prepare("SELECT * FROM rounds WHERE id = ?").get(roundId) as any;
    expect(round.status).toBe("done");
    expect(round.tokens_in).toBe(0);
    expect(round.tokens_out).toBe(0);
  });
});

describe("anomaly paths", () => {
  it("malformed verdict → overseer anomaly, no approve, no reviewed label", async () => {
    const roundId = reviewingRound(200);
    const { hooks, overseer } = recordingHooks();
    await watcher({}, hooks).handleFile(write(200, 1, '{"pr": 200, "verdict": "MAYBE"'));

    expect(overseer).toHaveLength(1);
    expect(overseer[0]).toContain("ANOMALY (malformed)");
    expect(adapter.calls).toEqual([`removeLabel:200:${cfg.github.in_progress_label}`]);
    expect(adapter.calls.some((c) => c.includes(cfg.github.reviewed_label))).toBe(false);
    expect(store.getPr(200)!.state).toBe("awaiting_human");
    const round = store.db.prepare("SELECT status, verdict FROM rounds WHERE id = ?").get(roundId) as any;
    expect(round.status).toBe("overdue");
    expect(round.verdict).toBeNull();
    expect(store.db.prepare("SELECT COUNT(*) AS c FROM events WHERE kind = 'verdict_malformed'").get()).toMatchObject({ c: 1 });
    // the durable anomaly record rides beside the inject file.
    const anomalies = store.anomalies();
    expect(anomalies).toHaveLength(1);
    expect(anomalies[0]).toMatchObject({ kind: "malformed", pr: 200, round_no: 1 });
    expect(anomalies[0]!.detail).toContain("malformed verdict file");
  });

  it("a verdict value outside the enum is malformed, never applied", async () => {
    reviewingRound(201);
    const { hooks, overseer } = recordingHooks();
    await watcher({}, hooks).handleFile(write(201, 1, verdictFile({ pr: 201, verdict: "APPROVED" as any })));
    expect(overseer[0]).toContain("ANOMALY (malformed)");
    expect(store.getPr(201)!.state).toBe("awaiting_human");
  });

  it("an overdue round is parked, never approved", async () => {
    const past = new Date("2026-08-13T10:00:00Z");
    const later = new Date("2026-08-13T12:00:00Z");
    let clock = past;
    const overdueStore = new StateStore(":memory:", () => clock);
    overdueStore.upsertPr({
      number: 300,
      state: "reviewing",
      head_sha: "abc",
      title: "PR 300",
      author: "alice",
      trigger_ts: null,
      stale_recheck: 0,
      migration_gate: 0,
    });
    const roundId = overdueStore.startRound(300, "first", ["pass-baseline"], cfg.daemon.round_deadline_min);
    clock = later;
    const { hooks, overseer } = recordingHooks();
    wireWake(overdueStore, hooks);
    const w = new VerdictWatcher({ cfg, store: overdueStore, adapter, hooks, verdictDir: dir, now: () => clock });

    expect(await w.checkDeadlines()).toEqual([300]);
    expect(overseer[0]).toContain("ANOMALY (overdue)");
    // the durable anomaly record rides beside the inject file.
    expect(overdueStore.anomalies()).toMatchObject([{ kind: "overdue", pr: 300, round_no: 1 }]);
    expect(overdueStore.getPr(300)!.state).toBe("awaiting_human");
    expect((overdueStore.db.prepare("SELECT status FROM rounds WHERE id = ?").get(roundId) as any).status).toBe("overdue");
    // No reviewer nomination anywhere on the anomaly path either.
    expect(adapter.calls.every((c) => c.startsWith("addLabel") || c.startsWith("removeLabel"))).toBe(true);
    expect(adapter.calls.some((c) => c.includes(cfg.github.reviewed_label))).toBe(false);
    // Idempotent: the round is no longer running, so a second sweep is a no-op.
    expect(await w.checkDeadlines()).toEqual([]);
    overdueStore.close();
  });

  it("a round inside its deadline is left alone", async () => {
    reviewingRound(301);
    const { hooks, overseer } = recordingHooks();
    expect(await watcher({}, hooks).checkDeadlines()).toEqual([]);
    expect(overseer).toHaveLength(0);
  });

  it("an overdue round superseded by a newer round is cancelled silently", async () => {
    // Live incident (overseer report 2026-08-14): old phantom round 2 expired
    // and yanked #4844 to awaiting_human while round 7 was actively running.
    let clock = new Date("2026-08-14T12:00:00Z");
    const s = new StateStore(":memory:", () => clock);
    s.upsertPr({
      number: 4844,
      state: "reviewing",
      head_sha: "abc",
      title: "PR 4844",
      author: "alice",
      trigger_ts: null,
      stale_recheck: 0,
      migration_gate: 0,
    });
    const oldId = s.startRound(4844, "first", ["pass-baseline"], cfg.daemon.round_deadline_min);
    clock = new Date("2026-08-14T13:50:00Z");
    const newId = s.startRound(4844, "re-review", ["pass-baseline"], cfg.daemon.round_deadline_min);
    clock = new Date("2026-08-14T14:03:00Z"); // old round overdue, new one inside its deadline
    const { hooks, overseer } = recordingHooks();
    wireWake(s, hooks);
    const w = new VerdictWatcher({ cfg, store: s, adapter, hooks, verdictDir: dir, now: () => clock });

    expect(await w.checkDeadlines()).toEqual([]);
    expect((s.db.prepare("SELECT status, summary FROM rounds WHERE id = ?").get(oldId) as any).status).toBe("cancelled");
    expect((s.db.prepare("SELECT status FROM rounds WHERE id = ?").get(newId) as any).status).toBe("running");
    expect(s.getPr(4844)!.state).toBe("reviewing"); // the live round keeps the PR
    expect(overseer).toHaveLength(0); // no anomaly, no escalation
    expect(adapter.calls).toEqual([]); // no label yank, no human request
    s.close();
  });
});

// Single-shepherd S4 wiring (docs/single-shepherd-invariant.md): a wake held
// while the round ran must actually reach the session once the round ends.
// wakes.ts is unit-tested on its own; these prove the WATCHER calls it.
describe("held wakes are flushed at round end", () => {
  it("delivers them after a verdict is applied", async () => {
    const roundId = reviewingRound(100);
    // A fresh ledger keeps's re-nudge out of this test's injects.
    mkdirSync(join(dir, "state", "ledgers"), { recursive: true });
    writeFileSync(join(dir, "state", "ledgers", "pr-100.md"), "LEDGER PR #100 @ abc123\n");
    store.holdWake(100, "author says: fixed in abc123", "author_reply");
    const { hooks, injects } = recordingHooks();

    write(100, 1, verdictFile({ verdict: "APPROVE" }));
    await watcher({}, hooks).sweep();

    expect((store.db.prepare("SELECT status FROM rounds WHERE id = ?").get(roundId) as { status: string }).status).toBe("done");
    expect(injects).toEqual(["100:author says: fixed in abc123"]);
    expect(store.heldWakes(100)).toHaveLength(0);
  });

  it("delivers them when the round is abandoned as overdue", async () => {
    const later = new Date(Date.now() + (cfg.daemon.round_deadline_min + 10) * 60_000);
    reviewingRound(101);
    store.holdWake(101, "author says: ping", "author_reply");
    const { hooks, injects } = recordingHooks();
    wireWake(store, hooks);
    const w = new VerdictWatcher({ cfg, store, adapter, hooks, verdictDir: dir, now: () => later });

    expect(await w.checkDeadlines()).toEqual([101]);
    expect(injects).toEqual(["101:author says: ping"]);
    expect(store.heldWakes(101)).toHaveLength(0);
  });

  it("leaves a wake held while the round is still running", async () => {
    reviewingRound(102);
    store.holdWake(102, "author says: ping", "author_reply");
    const { hooks, injects } = recordingHooks();
    expect(await watcher({}, hooks).checkDeadlines()).toEqual([]);
    expect(injects).toHaveLength(0);
    expect(store.heldWakes(102)).toHaveLength(1);
  });
});

describe("approval withheld for red CI, session route", () => {
  it("records the mark from an APPROVE verdict that says the approval was withheld", async () => {
    reviewingRound(100);
    const name = write(100, 1, verdictFile({ verdict: "APPROVE", approval_withheld: true }));

    await watcher().handleFile(name);

    expect(store.approvalWithheld(100)).toMatchObject({ head_sha: "abc123", reason: "red-ci" });
    expect(store.db.prepare("SELECT COUNT(*) AS c FROM events WHERE kind = 'approval_withheld_red_ci'").get()).toEqual({ c: 1 });
  });

  it("stamps ci_state on the mark when the adapter can read checks", async () => {
    reviewingRound(100);
    adapter.listChecks = async (ref: string) => {
      expect(ref).toBe("abc123");
      return [{ name: "ci", status: "completed", conclusion: "failure" }];
    };
    const name = write(100, 1, verdictFile({ verdict: "APPROVE", approval_withheld: true }));

    await watcher().handleFile(name);

    expect(store.approvalWithheld(100)).toMatchObject({ head_sha: "abc123", reason: "red-ci", ci_state: "red" });
  });

  it("a failed checks read stores a null ci_state, exactly as before", async () => {
    reviewingRound(100);
    adapter.listChecks = async () => {
      throw new Error("boom");
    };
    const name = write(100, 1, verdictFile({ verdict: "APPROVE", approval_withheld: true }));

    await watcher().handleFile(name);

    expect(store.approvalWithheld(100)).toMatchObject({ head_sha: "abc123", ci_state: null });
  });

  it("clears an older mark when the next verdict does not withhold anything", async () => {
    store.recordApprovalWithheld(100, { head_sha: "old111", ci_state: "red" });
    reviewingRound(100);
    const name = write(100, 1, verdictFile({ verdict: "APPROVE" }));

    await watcher().handleFile(name);

    expect(store.approvalWithheld(100)).toBeUndefined();
  });

  it("ignores the flag on a verdict that is not an approval — nothing is being withheld", async () => {
    reviewingRound(100);
    const name = write(100, 1, verdictFile({ verdict: "REQUEST_CHANGES", approval_withheld: true }));

    await watcher().handleFile(name);

    expect(store.approvalWithheld(100)).toBeUndefined();
    expect(store.getPr(100)?.state).toBe("awaiting_author");
  });

  it("validates the flag: booleans and the two digit-string spellings only", () => {
    expect(validateVerdict({ ...verdictFile(), approval_withheld: true }).ok).toBe(true);
    const coerced = validateVerdict({ ...verdictFile(), approval_withheld: "true" });
    expect(coerced.ok).toBe(true);
    expect(coerced.verdict?.approval_withheld).toBe(true);
    expect(validateVerdict({ ...verdictFile(), approval_withheld: "maybe" }).ok).toBe(false);
  });
});

describe("structural invariant: no review-retraction path", () => {
  // The forbidden token is assembled at runtime so this guard test does not
  // itself contain the string it forbids.
  const forbidden = new RegExp(["dis", "miss"].join(""), "i");

  it("never appears in the B2 daemon modules", () => {
    for (const f of ["verdicts.ts", "statemachine.ts", "webhook.ts", "dispatch.ts", "reconcile.ts", "daemon.ts", "stubs.ts"]) {
      expect(forbidden.test(readFileSync(resolve(process.cwd(), "src", f), "utf8"))).toBe(false);
    }
  });
});

describe("digit-string coercion (live-round regression)", () => {
  it("accepts pr and round_no as digit-strings", async () => {
    const { validateVerdict } = await import("../src/verdicts.js");
    const parsed = validateVerdict({
      pr: "5263",
      round_no: "1",
      verdict: "APPROVE",
      head_sha: "abc123",
      finished_at: "2026-08-13T21:00:00Z",
    });
    expect(parsed.ok).toBe(true);
    expect(parsed.verdict?.pr).toBe(5263);
    expect(parsed.verdict?.round_no).toBe(1);
  });

  it("still rejects non-numeric strings", async () => {
    const { validateVerdict } = await import("../src/verdicts.js");
    expect(validateVerdict({ pr: "abc", round_no: 1, verdict: "APPROVE", head_sha: "x", finished_at: "y" }).ok).toBe(false);
  });
});

describe("executed-pass telemetry", () => {
  it("validateVerdict normalizes a passes array tolerantly: aliases, digit-strings, dropped junk", () => {
    const parsed = validateVerdict(
      verdictFile({
        passes: [
          { name: "pass-baseline", tier: "sol-med", findings: "3" },
          { lens: "pass-validate", tier: " sol-high ", candidates: 5, survived: "2", killed: 1, downgraded: 0 },
          { tier: "sol-med" }, // nameless — dropped, never fatal
          "garbage",
        ] as never,
      }),
    );
    expect(parsed.ok).toBe(true);
    expect(parsed.passes_note).toContain("dropped");
    expect(parsed.verdict?.passes).toEqual([
      { name: "pass-baseline", tier: "sol-med", findings: 3, survived: null, killed: null, downgraded: null, merged: null, folded: null },
      { name: "pass-validate", tier: "sol-high", findings: 5, survived: 2, killed: 1, downgraded: 0, merged: null, folded: null },
    ]);
  });

  // merge-stage dispositions ride the same tolerant normalization —
  // additive fields, digit-strings coerce, absence stays null (unknown).
  it("normalizes merge-stage disposition counts (merged/folded) additively", () => {
    const parsed = validateVerdict(
      verdictFile({
        passes: [{ name: "pass-validate", tier: "sol-med", findings: 0, survived: "2", killed: 1, downgraded: 0, merged: "1", folded: 2 }] as never,
      }),
    );
    expect(parsed.ok).toBe(true);
    expect(parsed.verdict?.passes).toEqual([
      { name: "pass-validate", tier: "sol-med", findings: 0, survived: 2, killed: 1, downgraded: 0, merged: 1, folded: 2 },
    ]);
    // A legacy verdict without the fields is still clean — no note.
    const old = validateVerdict(verdictFile({ passes: [{ name: "pass-validate", killed: 1 }] as never }));
    expect(old.ok).toBe(true);
    expect(old.passes_note).toBeUndefined();
    expect(old.verdict?.passes?.[0]?.merged).toBeNull();
    expect(old.verdict?.passes?.[0]?.folded).toBeNull();
  });

  it("missing or malformed passes NEVER rejects the verdict — unknown, not error", () => {
    const absent = validateVerdict(verdictFile());
    expect(absent.ok).toBe(true);
    expect(absent.verdict?.passes).toBeUndefined();
    const junk = validateVerdict(verdictFile({ passes: "pass-baseline" as never }));
    expect(junk.ok).toBe(true);
    expect(junk.verdict?.passes).toBeUndefined();
    expect(junk.passes_note).toContain("not an array");
  });

  it("persists executed passes on the round, distinct from the planned lenses; no anomaly when they match", async () => {
    const { hooks, overseer } = recordingHooks();
    const roundId = reviewingRound(200);
    const passes = [
      { name: "pass-baseline", tier: "sol-med", findings: 2 },
      { name: "pass-validate", tier: "sol-med", findings: 0, survived: 1, killed: 1, downgraded: 0 },
    ];
    await watcher({}, hooks).handleFile(write(200, 1, verdictFile({ pr: 200, passes })));
    expect(store.executedPasses(roundId)).toMatchObject(passes);
    // The plan column is untouched — executed is a second record, not an edit.
    const round = store.db.prepare("SELECT lenses FROM rounds WHERE id = ?").get(roundId) as { lenses: string };
    expect(round.lenses).toBe("pass-baseline,pass-validate");
    expect(store.db.prepare("SELECT COUNT(*) AS c FROM events WHERE kind = 'pass_plan_mismatch'").get()).toMatchObject({ c: 0 });
    expect(overseer).toEqual([]);
  });

  it("plan≠executed logs an anomaly and injects the overseer — the verdict is never blocked", async () => {
    const { hooks, overseer } = recordingHooks();
    const roundId = reviewingRound(201);
    await watcher({}, hooks).handleFile(
      write(
        201,
        1,
        verdictFile({
          pr: 201,
          verdict: "APPROVE",
          passes: [
            { name: "pass-baseline", tier: "sol-med", findings: 1 },
            { name: "pass-extra", tier: "sol-med", findings: 0 },
          ],
        }),
      ),
    );
    // Verdict applied normally despite the mismatch.
    expect(store.getPr(201)!.state).toBe("tracked");
    expect((store.db.prepare("SELECT status, verdict FROM rounds WHERE id = ?").get(roundId) as any).status).toBe("done");
    const payload = JSON.parse(
      (store.db.prepare("SELECT payload FROM events WHERE kind = 'pass_plan_mismatch'").get() as { payload: string }).payload,
    );
    expect(payload).toMatchObject({
      round_id: roundId,
      planned: ["pass-baseline", "pass-validate"],
      missing: ["pass-validate"],
      added: ["pass-extra"],
    });
    expect(overseer.length).toBe(1);
    expect(overseer[0]).toContain("PASS-PLAN MISMATCH — PR #201 round 1");
    expect(overseer[0]).toContain("pass-validate");
    expect(overseer[0]).toContain("The verdict stands");
  });

  it("an empty passes array is a solo round: persisted as [], every planned lens reported missing", async () => {
    const { hooks, overseer } = recordingHooks();
    const roundId = reviewingRound(202);
    await watcher({}, hooks).handleFile(write(202, 1, verdictFile({ pr: 202, passes: [] })));
    expect(store.executedPasses(roundId)).toEqual([]);
    const payload = JSON.parse(
      (store.db.prepare("SELECT payload FROM events WHERE kind = 'pass_plan_mismatch'").get() as { payload: string }).payload,
    );
    expect(payload.missing).toEqual(["pass-baseline", "pass-validate"]);
    expect(overseer[0]).toContain("solo/degraded round");
  });

  it("an old-prompt verdict with no passes stays UNKNOWN: logged, null record, verdict applied", async () => {
    const { hooks, overseer } = recordingHooks();
    const roundId = reviewingRound(203);
    await watcher({}, hooks).handleFile(write(203, 1, verdictFile({ pr: 203, verdict: "APPROVE" })));
    expect(store.getPr(203)!.state).toBe("tracked");
    expect(store.executedPasses(roundId)).toBeNull();
    expect(store.db.prepare("SELECT COUNT(*) AS c FROM events WHERE kind = 'verdict_passes_unknown'").get()).toMatchObject({ c: 1 });
    expect(store.db.prepare("SELECT COUNT(*) AS c FROM events WHERE kind = 'pass_plan_mismatch'").get()).toMatchObject({ c: 0 });
    expect(overseer).toEqual([]);
  });
});
