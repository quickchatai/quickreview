import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { parseConfig, type Config } from "../src/config.js";
import type { GateResult } from "../src/gate.js";
import { StateStore } from "../src/state.js";
import type { SessionHooks, VerdictFile } from "../src/types.js";
import { validateVerdict, VerdictWatcher, type VerdictAdapter } from "../src/verdicts.js";

const cfg: Config = parseConfig(readFileSync(resolve(process.cwd(), "config.toml"), "utf8"));

/** Recording adapter — stands in for GitHubAdapter + MutationGate. */
class FakeAdapter implements VerdictAdapter {
  calls: string[] = [];
  escalationSkip: string | null = null;
  async addLabel(n: number, label: string): Promise<GateResult> {
    this.calls.push(`addLabel:${n}:${label}`);
    return { executed: false, dryRunFile: "d" };
  }
  async removeLabel(n: number, label: string): Promise<GateResult> {
    this.calls.push(`removeLabel:${n}:${label}`);
    return { executed: false, dryRunFile: "d" };
  }
  async requestEscalationReview(n: number): Promise<{ skipped: string | null }> {
    this.calls.push(`requestEscalationReview:${n}`);
    return { skipped: this.escalationSkip };
  }
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
    escalation_worthy: 0,
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
  return new VerdictWatcher({
    cfg,
    store,
    adapter,
    hooks: hooks ?? recordingHooks().hooks,
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

  it("APPROVE lands the PR back on tracked and never requests the human", async () => {
    reviewingRound(101);
    await watcher().handleFile(write(101, 1, verdictFile({ pr: 101, verdict: "APPROVE" })));
    expect(store.getPr(101)!.state).toBe("tracked");
    expect(adapter.calls.some((c) => c.startsWith("requestEscalationReview"))).toBe(false);
  });

  it("ESCALATE requests the human reviewer and records the redundancy skip", async () => {
    reviewingRound(102);
    adapter.escalationSkip = "already-requested";
    await watcher().handleFile(write(102, 1, verdictFile({ pr: 102, verdict: "ESCALATE", ai_approved: true })));
    expect(adapter.calls).toContain("requestEscalationReview:102");
    expect(store.getPr(102)!.state).toBe("awaiting_human");
    const logged = JSON.parse(
      (store.db.prepare("SELECT payload FROM events WHERE kind = 'verdict_applied'").get() as { payload: string }).payload,
    );
    expect(logged).toMatchObject({ verdict: "ESCALATE", ai_approved: true, escalation_skipped: "already-requested" });
  });

  it("startup sweep consumes every pending file", async () => {
    reviewingRound(103);
    reviewingRound(104);
    write(103, 1, verdictFile({ pr: 103, verdict: "APPROVE" }));
    write(104, 1, verdictFile({ pr: 104, verdict: "ESCALATE" }));
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
    expect(adapter.calls).toEqual([`removeLabel:200:${cfg.github.in_progress_label}`, "requestEscalationReview:200"]);
    expect(adapter.calls.some((c) => c.includes(cfg.github.reviewed_label))).toBe(false);
    expect(store.getPr(200)!.state).toBe("awaiting_human");
    const round = store.db.prepare("SELECT status, verdict FROM rounds WHERE id = ?").get(roundId) as any;
    expect(round.status).toBe("overdue");
    expect(round.verdict).toBeNull();
    expect(store.db.prepare("SELECT COUNT(*) AS c FROM events WHERE kind = 'verdict_malformed'").get()).toMatchObject({ c: 1 });
  });

  it("a verdict value outside the enum is malformed, never applied", async () => {
    reviewingRound(201);
    const { hooks, overseer } = recordingHooks();
    await watcher({}, hooks).handleFile(write(201, 1, verdictFile({ pr: 201, verdict: "APPROVED" as any })));
    expect(overseer[0]).toContain("ANOMALY (malformed)");
    expect(store.getPr(201)!.state).toBe("awaiting_human");
  });

  it("an overdue round is escalated, never approved", async () => {
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
      escalation_worthy: 0,
      migration_gate: 0,
    });
    const roundId = overdueStore.startRound(300, "first", ["pass-baseline"], cfg.daemon.round_deadline_min);
    clock = later;
    const { hooks, overseer } = recordingHooks();
    const w = new VerdictWatcher({ cfg, store: overdueStore, adapter, hooks, verdictDir: dir, now: () => clock });

    expect(await w.checkDeadlines()).toEqual([300]);
    expect(overseer[0]).toContain("ANOMALY (overdue)");
    expect(overdueStore.getPr(300)!.state).toBe("awaiting_human");
    expect((overdueStore.db.prepare("SELECT status FROM rounds WHERE id = ?").get(roundId) as any).status).toBe("overdue");
    expect(adapter.calls).toContain("requestEscalationReview:300");
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
      escalation_worthy: 0,
      migration_gate: 0,
    });
    const oldId = s.startRound(4844, "first", ["pass-baseline"], cfg.daemon.round_deadline_min);
    clock = new Date("2026-08-14T13:50:00Z");
    const newId = s.startRound(4844, "re-review", ["pass-baseline"], cfg.daemon.round_deadline_min);
    clock = new Date("2026-08-14T14:03:00Z"); // old round overdue, new one inside its deadline
    const { hooks, overseer } = recordingHooks();
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
