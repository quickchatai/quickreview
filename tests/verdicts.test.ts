import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { parseConfig, type Config } from "../src/config.js";
import type { GateResult } from "../src/gate.js";
import { StateStore, type ReviewedHeadRow } from "../src/state.js";
import { fingerprintRoundIntegrity } from "../src/execboundary.js";
import { githubCloneDir } from "../src/config.js";
import { postingMarker, roundPostingKey } from "../src/posting-receipt.js";
import type { SessionHooks, VerdictFile } from "../src/types.js";
import { AnomalyWakePolicy } from "../src/anomalies.js";
import { validateVerdict, VerdictWatcher, type VerdictAdapter } from "../src/verdicts.js";

const cfg: Config = parseConfig(readFileSync(resolve(process.cwd(), "tests/fixtures/config.toml"), "utf8"));

/** Recording adapter — stands in for GitHubAdapter + MutationGate. */
class FakeAdapter implements VerdictAdapter {
  calls: string[] = [];
  /** Optional checks read (ci_state stamping); absent by default. */
  listChecks?: (ref: string) => Promise<import("../src/cigate.js").CheckSummary[]>;
  listReviewsFull?: VerdictAdapter["listReviewsFull"];
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

function policyRound(pr: number): number {
  store.upsertPr({
    number: pr, state: "reviewing", head_sha: "abc123", title: `PR ${pr}`,
    author: "alice", trigger_ts: null, stale_recheck: 0, migration_gate: 0,
  });
  return store.startRound(pr, "first", ["pass-baseline", "pass-validate"], cfg.daemon.round_deadline_min, {
    pass_plan: [
      { lens: "pass-baseline", agent: "pass-baseline--sol-med", tier: "sol-med", raisable_to: ["pass-baseline--sol-high"] },
      { lens: "pass-validate", agent: "pass-validate--sol-high", tier: "sol-high", raisable_to: [] },
    ],
    addable_passes: [
      { lens: "pass-concurrency", tier: "sol-med" },
      { lens: "pass-security", tier: "sol-high" },
    ],
  });
}

function write(pr: number, round: number, body: unknown): string {
  const name = `pr-${pr}-round-${round}.json`;
  writeFileSync(join(dir, name), typeof body === "string" ? body : JSON.stringify(body));
  return name;
}

function stampPosting(pr: number, roundNo: number, head = "abc123"): { roundId: number; key: string; receiptDir: string } {
  const round = store.roundsFor(pr).find((row) => row.round_no === roundNo)!;
  const key = roundPostingKey(pr, roundNo, head);
  store.stampPostingKey(round.id, key);
  return { roundId: round.id, key, receiptDir: join(dir, "state", "posting-receipts") };
}

function writePostingReceipt(pr: number, roundNo: number, key: string, actualEvent: "APPROVE" | "REQUEST_CHANGES" | "COMMENT", over: Record<string, unknown> = {}): void {
  const receiptDir = join(dir, "state", "posting-receipts");
  mkdirSync(receiptDir, { recursive: true });
  writeFileSync(join(receiptDir, `pr-${pr}-round-${roundNo}.json`), JSON.stringify({
    version: 1,
    posting_key: key,
    marker: postingMarker(key),
    pr,
    round_no: roundNo,
    head_sha: "abc123",
    intended_event: actualEvent,
    actual_event: actualEvent,
    status: "confirmed",
    payload_sha256: "a".repeat(64),
    prepared_at: "2026-08-13T11:59:58Z",
    confirmed_at: "2026-08-13T11:59:59Z",
    gh_review_id: 991,
    gh_commit_id: "abc123",
    gh_state: actualEvent === "APPROVE" ? "APPROVED" : actualEvent === "REQUEST_CHANGES" ? "CHANGES_REQUESTED" : "COMMENTED",
    ...over,
  }));
}

// A verdict file is UNTRUSTED input written by a session, so the builder takes
// the loose shape on purpose: several cases here feed a legacy or malformed
// `verdict` string that `Verdict` deliberately does not name (`ESCALATE`), and
// typing the override as `Partial<VerdictFile>` made those cases uncompilable.
const verdictFile = (over: Partial<Record<keyof VerdictFile, unknown>> = {}): VerdictFile =>
  ({
  pr: 100,
  round_no: 1,
  verdict: "REQUEST_CHANGES",
  head_sha: "abc123",
    spend_usd: 2.25,
    finished_at: "2026-08-13T12:00:00Z",
    ...over,
  }) as VerdictFile;

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
  it("a legacy NEEDS_HUMAN lands the PR tracked (park retired 2026-08-19), no reviewer touched", async () => {
    reviewingRound(102);
    await watcher().handleFile(write(102, 1, verdictFile({ pr: 102, verdict: "NEEDS_HUMAN", ai_approved: true, passes: [{ name: "pass-baseline", tier: "sol-med", findings: 1 }] })));
    expect(store.getPr(102)!.state).toBe("tracked");
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
    expect(store.getPr(105)!.state).toBe("tracked");
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
    expect(store.getPr(104)!.state).toBe("tracked");
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

  // round 2 — the git-config integrity check, WIRED.
  //
  // The pure logic is proven in tests/exec-boundary.test.ts. What matters here
  // is that a round actually runs it: five write primitives on the guard's own
  // allowlist reach `<clone>/.git/config` past every command-string rule, and
  // one of them (`T=.git/config; cat p >> $T`) can never be seen by any of
  // them. This check is what covers that, so a check nobody calls is the whole
  // defence missing.
  it("raises a WAKE anomaly when git's config changed during the round", async () => {
    const roundId = reviewingRound(108);
    writeSessionJsonl(108, [modelLine(), jsonlLine(10, 1)]);
    // The baseline dispatch would have taken. Nothing on disk matches it, so
    // the re-check at round end sees a change — exactly as a session write does.
    store.recordRoundGitConfig(roundId, {
      digest: "baseline-that-no-longer-holds",
      files: { [join(dir, "pihome", ".gitconfig")]: "sha256:deadbeef" },
    });
    const rec = recordingHooks();
    await watcher({}, rec.hooks).handleFile(write(108, 1, verdictFile({ pr: 108 })));

    const ev = store.db.prepare("SELECT payload FROM events WHERE kind = 'git_config_modified'").get() as
      | { payload: string }
      | undefined;
    expect(ev, "the durable record").toBeTruthy();
    expect(JSON.parse(ev!.payload).changes.length).toBeGreaterThan(0);
    expect(rec.overseer.join("\n")).toContain("git's configuration changed DURING a round");
  });

  it("a round with NO baseline is never judged — unknown is not evidence of a change", async () => {
    // The same rule the receipt scan had to learn the hard way. A round that
    // predates the check, or whose fingerprint could not be taken, must be
    // silent rather than alarming on every single round.
    const roundId = reviewingRound(109);
    writeSessionJsonl(109, [modelLine(), jsonlLine(10, 1)]);
    expect(store.roundGitConfig(roundId)).toBeUndefined();
    await watcher({}).handleFile(write(109, 1, verdictFile({ pr: 109 })));
    expect(store.db.prepare("SELECT COUNT(*) c FROM events WHERE kind = 'git_config_modified'").get()).toMatchObject({ c: 0 });
  });

  it("…and a MALFORMED baseline is not judged either", async () => {
    // The teeth behind the previous test. Mutation-verification found that
    // deleting the "no baseline ⇒ never judged" guard changed nothing
    // observable, because the surrounding try/catch swallowed the throw that
    // followed. `gitConfigChanges` is now total over a malformed fingerprint,
    // so the guard is load-bearing: without it, this round reports every
    // watched path as changed.
    const roundId = reviewingRound(111);
    writeSessionJsonl(111, [modelLine(), jsonlLine(10, 1)]);
    // A watched file must actually EXIST, or the round-end fingerprint is
    // all-"absent" and matches an empty baseline by accident — which is how
    // this test passed for the wrong reason on its first cut.
    mkdirSync(join(dir, "pihome"), { recursive: true });
    writeFileSync(join(dir, "pihome", ".gitconfig"), "[user]\n\tname = qcr\n");
    store.recordRoundGitConfig(roundId, { not: "a fingerprint" });
    await watcher({}).handleFile(write(111, 1, verdictFile({ pr: 111 })));
    expect(store.db.prepare("SELECT COUNT(*) c FROM events WHERE kind = 'git_config_modified'").get()).toMatchObject({ c: 0 });
  });

  it("an UNCHANGED tree is silent — the check must not fire on every round", async () => {
    const roundId = reviewingRound(110);
    writeSessionJsonl(110, [modelLine(), jsonlLine(10, 1)]);
    // The baseline the daemon itself would compute over this very tree.
    store.recordRoundGitConfig(
      roundId,
      fingerprintRoundIntegrity({
        clonePath: githubCloneDir(cfg.github),
        worktreePath: resolve(dir, "wt/pr-110"),
        piHome: join(dir, "pihome"),
        sandboxRoot: dir,
      }),
    );
    await watcher({}).handleFile(write(110, 1, verdictFile({ pr: 110 })));
    expect(store.db.prepare("SELECT COUNT(*) c FROM events WHERE kind = 'git_config_modified'").get()).toMatchObject({ c: 0 });
    expect(store.db.prepare("SELECT COUNT(*) c FROM events WHERE kind = 'policy_surface_modified'").get()).toMatchObject({ c: 0 });
  });

  // the same fingerprint carries this system's OWN policy surface, and
  // a change there raises its OWN wake — not git's — because it means something
  // worse: the boundary every later round runs under has been rewritten.
  // MUTATION: in verdicts.ts route the `policy` half into the git event — the
  // first two expectations fail.
  it("raises a policy_surface_modified WAKE — and not git's — when config.toml changed during the round", async () => {
    const roundId = reviewingRound(112);
    writeSessionJsonl(112, [modelLine(), jsonlLine(10, 1)]);
    writeFileSync(join(dir, "config.toml"), "dry_run = false\n"); // what the session left behind
    store.recordRoundGitConfig(roundId, {
      digest: "baseline-taken-before-the-write",
      files: { [join(dir, "config.toml")]: "sha256:what-dispatch-saw" },
    });
    const rec = recordingHooks();
    await watcher({}, rec.hooks).handleFile(write(112, 1, verdictFile({ pr: 112 })));

    const ev = store.db.prepare("SELECT payload FROM events WHERE kind = 'policy_surface_modified'").get() as
      | { payload: string }
      | undefined;
    expect(ev, "the durable record").toBeTruthy();
    expect(JSON.parse(ev!.payload).changes.map((c: { path: string }) => c.path)).toEqual([join(dir, "config.toml")]);
    expect(rec.overseer.join("\n")).toContain("OWN policy surface changed DURING a round");
    expect(store.db.prepare("SELECT COUNT(*) c FROM events WHERE kind = 'git_config_modified'").get()).toMatchObject({ c: 0 });
  });

  it("logs exec-policy violations without inject spam, then piggybacks on an anomaly inject", async () => {
    reviewingRound(100);
    writeSessionJsonl(100, [jsonlLine(10, 1), bashLine("git diff | head"), bashLine("python manage.py test")]);
    const rec = recordingHooks();
    const w = watcher({}, rec.hooks);
    await w.handleFile(write(100, 1, verdictFile()));

    const ev = store.db.prepare("SELECT payload FROM events WHERE kind = 'exec_policy_violation'").get() as { payload: string };
    // the payload now carries the CLASS as well as the command, and
    // `git diff | head` is still a plain read — the widened audit must not turn
    // every round's ordinary git reads into a violation line.
    expect(JSON.parse(ev.payload)).toEqual({
      commands: ["python manage.py test"],
      violations: [{ command: "python manage.py test", kind: "interpreter" }],
    });
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

  /**
   * / MC-03. `measureUsage` had exactly ONE call site — the verdict
   * path — so a round that ended any other way carried NULL cost forever.
   * `markRoundOverdue` deliberately does NOT set status `expired`, with the
   * comment "that would drop the round from spend and every other aggregate,
   * hiding tokens this round really burned"; `totalSpend` is `SUM(est_usd) FROM
   * rounds` with no status filter; and the stranded-round operator message says
   * "Its spend still counts." All three were structurally true and empirically
   * zero, because nothing ever put a number in the column.
   */
  describe("a round that never produced a verdict is measured too", () => {
    const priced = { globalStoreDir: null, pricing: { "gpt-5.6-sol": { input_per_mtok: 2, output_per_mtok: 8 } } };

    it("measures a MALFORMED round's tokens onto the round row", async () => {
      const roundId = reviewingRound(400);
      writeSessionJsonl(400, [modelLine(), jsonlLine(1_000_000, 500_000)]);

      await watcher({ usage: priced }).handleFile(write(400, 1, verdictFile({ pr: 400, verdict: "APPROVED" as any })));

      const round = store.db.prepare("SELECT * FROM rounds WHERE id = ?").get(roundId) as any;
      expect(round.status).toBe("overdue"); // handleAnomaly terminalized it
      expect(round.tokens_in).toBe(1_000_000);
      expect(round.tokens_out).toBe(500_000);
      expect(round.est_usd).toBeCloseTo(1 * 2 + 0.5 * 8, 6);
      // …and therefore it reaches the aggregate the manifesto's belief 8 claims.
      expect(store.totalSpend()).toBeGreaterThan(0);
    });

    it("measures a round buried by a POSTING-RECEIPT failure", async () => {
      // Same class as the two above and in the same file — the round ran a
      // full review and burned its tokens; the receipt is what failed, not the
      // work. Missed by the first pass, found by adversarial review.
      const roundId = reviewingRound(402);
      stampPosting(402, 1);
      writeSessionJsonl(402, [modelLine(), jsonlLine(750_000, 250_000)]);

      expect(
        await watcher({ postingReceiptGraceS: 0, usage: priced }).handleFile(write(402, 1, verdictFile({ pr: 402 }))),
      ).toBe(true);

      const round = store.db.prepare("SELECT * FROM rounds WHERE id = ?").get(roundId) as any;
      expect(round.status).toBe("cancelled");
      expect(round.tokens_in).toBe(750_000);
      expect(round.est_usd).toBeCloseTo(0.75 * 2 + 0.25 * 8, 6);
    });

    it("measures an OVERDUE round's tokens when the deadline sweep buries it", async () => {
      const roundId = reviewingRound(401);
      writeSessionJsonl(401, [modelLine(), jsonlLine(300_000, 100_000)]);
      const later = new Date(Date.now() + (cfg.daemon.round_deadline_min + 10) * 60_000);
      const { hooks } = recordingHooks();
      wireWake(store, hooks);
      const w = new VerdictWatcher({
        cfg, store, adapter, hooks, verdictDir: dir, now: () => later,
        root: dir, usage: priced,
      });

      expect(await w.checkDeadlines()).toEqual([401]);

      const round = store.db.prepare("SELECT * FROM rounds WHERE id = ?").get(roundId) as any;
      expect(round.status).toBe("overdue");
      expect(round.tokens_in).toBe(300_000);
      expect(round.est_usd).toBeCloseTo(0.3 * 2 + 0.1 * 8, 6);
    });
  });
});

describe("confirmed round posting receipts", () => {
  it("applies a merits verdict only after linking GitHub's returned review id", async () => {
    reviewingRound(180);
    const { roundId, key } = stampPosting(180, 1);
    writePostingReceipt(180, 1, key, "REQUEST_CHANGES");

    expect(await watcher().handleFile(write(180, 1, verdictFile({ pr: 180 })))).toBe(true);

    expect(store.roundsFor(180)[0]).toMatchObject({ status: "done", gh_review_id: 991, gh_commit_id: "abc123", posted_event: "REQUEST_CHANGES" });
    expect(store.getPr(180)?.state).toBe("awaiting_author");
    expect(roundId).toBe(store.roundsFor(180)[0]?.id);
  });

  it("holds a verdict file while the post/local-persistence window is still ambiguous", async () => {
    reviewingRound(181);
    stampPosting(181, 1);
    const name = write(181, 1, verdictFile({ pr: 181 }));

    expect(await watcher({ postingReceiptGraceS: 120 }).handleFile(name)).toBe(false);

    expect(store.roundsFor(181)[0]?.status).toBe("running");
    expect(store.getPr(181)?.state).toBe("reviewing");
    expect(existsSync(join(dir, name))).toBe(true);
    expect(adapter.calls).toEqual([]);
  });

  it("fails loud after the finite receipt grace instead of trusting or reposting", async () => {
    reviewingRound(182);
    stampPosting(182, 1);

    expect(await watcher({ postingReceiptGraceS: 0 }).handleFile(write(182, 1, verdictFile({ pr: 182 })))).toBe(true);

    expect(store.roundsFor(182)[0]).toMatchObject({ status: "cancelled", verdict: null });
    expect(store.openReviewFailure(182)).toMatchObject({ stage: "posting_receipt", work_owed: 1 });
    expect(store.reviewedHead(182)).toBeUndefined();
  });

  it("reconciles the exact bot marker after GitHub acceptance/local crash", async () => {
    reviewingRound(183);
    const { key } = stampPosting(183, 1);
    adapter.listReviewsFull = async () => [{
      id: 777,
      user: cfg.github.bot_login,
      user_type: "Bot",
      state: "CHANGES_REQUESTED",
      body: `review body\n\n${postingMarker(key)}`,
      commit_id: "abc123",
      submitted_at: "2026-08-13T11:59:59Z",
    }];

    // The marker reconcile only runs live (dry-run never posted anything to
    // find) — the fixture ships dry_run = true, so flip it here.
    expect(await watcher({ cfg: { ...cfg, dry_run: false }, postingReceiptGraceS: 0 }).handleFile(write(183, 1, verdictFile({ pr: 183 })))).toBe(true);

    expect(store.roundsFor(183)[0]).toMatchObject({ status: "done", gh_review_id: 777, posted_event: "REQUEST_CHANGES" });
    expect(store.db.prepare("SELECT COUNT(*) c FROM events WHERE kind='posting_receipt_reconciled'").get()).toMatchObject({ c: 1 });
  });

  it("never requeues a confirmed posted review whose session lost only the verdict", async () => {
    reviewingRound(184);
    const { key } = stampPosting(184, 1);
    writePostingReceipt(184, 1, key, "REQUEST_CHANGES");

    expect(await watcher().recoverInfrastructureFailure(184, 1, "settled_without_verdict", "parent settled")).toBe("failed_loud");

    expect(store.roundsFor(184)[0]).toMatchObject({ status: "cancelled", verdict: null, gh_review_id: 991 });
    expect(store.openReviewFailure(184)).toMatchObject({ stage: "posted_without_verdict", work_owed: 1 });
    expect(store.db.prepare("SELECT COUNT(*) c FROM events WHERE kind='round_self_requeued'").get()).toMatchObject({ c: 0 });
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
    expect(store.getPr(200)!.state).toBe("queued"); // FAILED_LOUD: review work remains owed
    expect(store.openReviewFailure(200)?.stage).toBe("malformed_verdict");
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

  it("a malformed old-head round promotes durable fresh-head work instead of erasing it", async () => {
    const roundId = reviewingRound(204);
    store.recordSuccessor({ pr: 204, predecessor_round_id: roundId, head_sha: "fresh", provenance: "system", reason: "push" });
    const { hooks } = recordingHooks();

    await watcher({}, hooks).handleFile(write(204, 1, '{"pr":204,"round_no":1,"verdict":"MAYBE"'));

    expect(store.getPr(204)).toMatchObject({ state: "queued", head_sha: "fresh", trigger_provenance: "system" });
    expect(store.successorFor(204)?.head_sha).toBe("fresh");
  });

  it("a verdict value outside the enum is malformed, never applied", async () => {
    reviewingRound(201);
    const { hooks, overseer } = recordingHooks();
    await watcher({}, hooks).handleFile(write(201, 1, verdictFile({ pr: 201, verdict: "APPROVED" as any })));
    expect(overseer[0]).toContain("ANOMALY (malformed)");
    expect(store.getPr(201)!.state).toBe("queued");
    expect(store.openReviewFailure(201)?.work_owed).toBe(1);
  });

  it("an overdue round returns to the standing state, never approved", async () => {
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
    const w = new VerdictWatcher({ cfg, store: overdueStore, adapter, hooks, verdictDir: dir, now: () => clock, root: dir, usage: { globalStoreDir: null } });

    expect(await w.checkDeadlines()).toEqual([300]);
    expect(overseer[0]).toContain("ANOMALY (overdue)");
    // the durable anomaly record rides beside the inject file.
    expect(overdueStore.anomalies()).toMatchObject([{ kind: "overdue", pr: 300, round_no: 1 }]);
    expect(overdueStore.getPr(300)!.state).toBe("queued");
    expect(overdueStore.openReviewFailure(300)?.stage).toBe("round_deadline");
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
    const w = new VerdictWatcher({ cfg, store: s, adapter, hooks, verdictDir: dir, now: () => clock, root: dir, usage: { globalStoreDir: null } });

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

  it("keeps them behind FAILED_LOUD work when the round is abandoned as overdue", async () => {
    const later = new Date(Date.now() + (cfg.daemon.round_deadline_min + 10) * 60_000);
    reviewingRound(101);
    store.holdWake(101, "author says: ping", "author_reply");
    const { hooks, injects } = recordingHooks();
    wireWake(store, hooks);
    const w = new VerdictWatcher({ cfg, store, adapter, hooks, verdictDir: dir, now: () => later, root: dir, usage: { globalStoreDir: null } });

    expect(await w.checkDeadlines()).toEqual([101]);
    expect(injects).toEqual([]);
    expect(store.heldWakes(101)).toHaveLength(1);
    expect(store.openReviewFailure(101)?.work_owed).toBe(1);
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

  // carved one deliberate hole: feedback.ts names GitHub's own
  // review-removal action (it interprets the event as a tuning signal). The
  // hole stays safe only while that module can not reach GitHub at all —
  // pin that structurally, so the vocabulary never rides back into a module
  // with a client or the gate in hand.
  it("feedback.ts (which may name the event) can never touch GitHub", () => {
    const src = readFileSync(resolve(process.cwd(), "src", "feedback.ts"), "utf8");
    expect(src).not.toMatch(/from "\.\/github\.js"/);
    expect(src).not.toMatch(/from "\.\/gate\.js"/);
    expect(src).not.toMatch(/executeMutation|MutationGate|GitHubAdapter/);
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

  it("accepts a reasoned allowlisted addition at its dispatched tier", async () => {
    const { hooks, overseer } = recordingHooks();
    policyRound(204);
    await watcher({}, hooks).handleFile(write(204, 1, verdictFile({
      pr: 204,
      passes: [
        { name: "pass-baseline", tier: "sol-high", findings: 0 },
        { name: "pass-concurrency", tier: "sol-med", reason: "added: read-then-write claim race", findings: 1 },
        { name: "pass-validate", tier: "sol-high", findings: 1 },
      ],
    })));
    expect(store.db.prepare("SELECT COUNT(*) AS c FROM events WHERE kind = 'pass_plan_mismatch'").get()).toMatchObject({ c: 0 });
    const event = store.db.prepare("SELECT payload FROM events WHERE kind = 'pass_plan_conformant_addition'").get() as { payload: string };
    expect(JSON.parse(event.payload).additions).toEqual([
      { name: "pass-concurrency", tier: "sol-med", reason: "added: read-then-write claim race" },
    ]);
    expect(overseer).toEqual([]);
  });

  it("flags unknown, wrong-tier, and unexplained additions under the dispatched policy", async () => {
    const { hooks } = recordingHooks();
    policyRound(205);
    await watcher({}, hooks).handleFile(write(205, 1, verdictFile({
      pr: 205,
      passes: [
        { name: "pass-baseline", tier: "sol-med", findings: 0 },
        { name: "pass-concurrency", tier: "sol-high", findings: 0 },
        { name: "pass-mystery", tier: "sol-med", reason: "because", findings: 0 },
        { name: "pass-validate", tier: "sol-high", findings: 0 },
      ],
    })));
    const event = store.db.prepare("SELECT payload FROM events WHERE kind = 'pass_plan_mismatch'").get() as { payload: string };
    expect(JSON.parse(event.payload)).toMatchObject({
      missing: [],
      unknown_additions: ["pass-mystery"],
      missing_reason: ["pass-concurrency"],
      wrong_tier: ["pass-concurrency"],
    });
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


// Durability (the owner, 2026-08-19, #5314): a head that advances while the
// round runs chains a SYSTEM re-trigger at verdict time — the
// classifier then decides full-round vs short-circuit. Never on a park.
describe("mid-round head advance chains a system re-trigger", () => {
  it("head moved while reviewing ⇒ event + queued with system provenance", async () => {
    reviewingRound(400);
    const row = store.getPr(400)!;
    // The author pushes while the round is in flight (reconcile updates head).
    store.upsertPr({ ...row, head_sha: "def456" });
    await watcher().handleFile(write(400, 1, verdictFile({ pr: 400, verdict: "REQUEST_CHANGES", head_sha: "abc123" })));

    const after = store.getPr(400)!;
    expect(after.state).toBe("queued");
    expect(after.trigger_provenance).toBe("system");
    const ev = store.db.prepare("SELECT payload FROM events WHERE kind = 'mid_round_head_advance'").get() as { payload: string };
    expect(JSON.parse(ev.payload)).toMatchObject({ reviewed_head: "abc123", current_head: "def456", verdict: "REQUEST_CHANGES" });
    // The reviewed-head mark stays at the reviewed sha — the classifier's
    // comparison base for the chained trigger.
    expect(store.reviewedHead(400)!.head_sha).toBe("abc123");
    expect(store.successorFor(400)?.head_sha).toBe("def456");
  });

  it("a verdict covering the owed successor clears it instead of queueing again", async () => {
    const roundId = reviewingRound(403);
    store.recordSuccessor({ pr: 403, predecessor_round_id: roundId, head_sha: "abc123", provenance: "system", reason: "promoted" });

    await watcher().handleFile(write(403, 1, verdictFile({ pr: 403, verdict: "APPROVE", head_sha: "abc123" })));

    expect(store.getPr(403)?.state).toBe("tracked");
    expect(store.successorFor(403)).toBeUndefined();
  });

  it("unchanged head ⇒ no chain", async () => {
    reviewingRound(401);
    await watcher().handleFile(write(401, 1, verdictFile({ pr: 401, verdict: "APPROVE", head_sha: "abc123" })));
    expect(store.getPr(401)!.state).toBe("tracked");
    expect(store.db.prepare("SELECT COUNT(*) c FROM events WHERE kind = 'mid_round_head_advance'").get()).toMatchObject({ c: 0 });
  });

  it("a legacy NEEDS_HUMAN no longer parks — it chains like any other verdict", async () => {
    reviewingRound(402);
    const row = store.getPr(402)!;
    store.upsertPr({ ...row, head_sha: "def456" });
    await watcher().handleFile(
      write(402, 1, verdictFile({ pr: 402, verdict: "NEEDS_HUMAN", head_sha: "abc123", passes: [{ name: "pass-baseline", tier: "sol-med", findings: 1 }] })),
    );
    expect(store.getPr(402)!.state).toBe("queued");
    expect(store.db.prepare("SELECT COUNT(*) c FROM events WHERE kind = 'mid_round_head_advance'").get()).toMatchObject({ c: 1 });
  });
});


// x compaction race (2026-08-19, #5290 r7): the post-round ledger
// check is DELAYED past the compaction window; 0 keeps it inline for tests.
describe("post-round ledger check settle delay", () => {
  it("delay 0 ⇒ inline check fires during apply; default ⇒ deferred (no immediate event)", async () => {
    reviewingRound(500);
    const w = watcher({ ledgerCheckDelayMs: 0 });
    await w.handleFile(write(500, 1, verdictFile({ pr: 500, verdict: "APPROVE", head_sha: "abc123" })));
    expect(store.db.prepare("SELECT COUNT(*) c FROM events WHERE kind = 'ledger_stale_nudged' AND pr = 500").get()).toMatchObject({ c: 1 });

    reviewingRound(501);
    await watcher().handleFile(write(501, 1, verdictFile({ pr: 501, verdict: "APPROVE", head_sha: "abc123" })));
    expect(store.db.prepare("SELECT COUNT(*) c FROM events WHERE kind = 'ledger_stale_nudged' AND pr = 501").get()).toMatchObject({ c: 0 });
  });
});

/**
 * a guard-2 refusal is a terminal NO-OP, not a failure.
 *
 * #5409 round 18 (2026-09-01): a healthy ten-lens round decided REQUEST_CHANGES,
 * post-review.sh correctly refused the duplicate (same head as round 12's
 * review, no author reply since), and because that refusal left no receipt the
 * watcher classified the round as `posting_receipt` infrastructure failure —
 * FAILED_LOUD debt, operator recovery, and the standing review still standing
 * the whole time. Now the shell records the refusal; these cases pin what the
 * watcher does with it, and what it must never do.
 */
describe("guarded no-op settlement", () => {
  const HEAD = "abc123";

  /** The standing review from an earlier round, in the shape the shell leaves
   * before the watcher enriches it (the #5409 mark). */
  function standingMark(pr: number, posted: "REQUEST_CHANGES" | "APPROVE" | "COMMENT" = "REQUEST_CHANGES"): ReviewedHeadRow {
    store.recordReviewedHead(pr, { head_sha: HEAD, posted_event: posted });
    return store.reviewedHead(pr)!;
  }

  function writeGuardedNoop(pr: number, roundNo: number, key: string, mark: ReviewedHeadRow, over: Record<string, unknown> = {}): void {
    const receiptDir = join(dir, "state", "posting-receipts");
    mkdirSync(receiptDir, { recursive: true });
    writeFileSync(join(receiptDir, `pr-${pr}-round-${roundNo}.json`), JSON.stringify({
      version: 1,
      posting_key: key,
      marker: postingMarker(key),
      pr,
      round_no: roundNo,
      head_sha: HEAD,
      status: "skipped",
      skip_reason: "no-new-evidence",
      intended_event: "REQUEST_CHANGES",
      mode: "dryrun",
      // The refusal happened a minute after the standing review was stamped.
      skipped_at: new Date(Date.parse(mark.reviewed_at) + 60_000).toISOString(),
      standing_mark: {
        head_sha: mark.head_sha,
        reviewed_at: mark.reviewed_at,
        verdict: mark.verdict,
        posted_event: mark.posted_event,
        round_no: mark.round_no,
        last_author_reply_at: mark.last_author_reply_at,
      },
      ...over,
    }));
  }

  /** A running round over a PR that already carries the standing mark. */
  function skippedRound(pr: number, posted: "REQUEST_CHANGES" | "APPROVE" | "COMMENT" = "REQUEST_CHANGES"): { roundId: number; key: string; mark: ReviewedHeadRow } {
    const mark = standingMark(pr, posted);
    const roundId = reviewingRound(pr);
    const { key } = stampPosting(pr, 1);
    writeGuardedNoop(pr, 1, key, mark);
    return { roundId, key, mark };
  }

  const events = (kind: string, pr: number): Array<Record<string, unknown>> =>
    (store.db.prepare("SELECT payload FROM events WHERE kind = ? AND pr = ?").all(kind, pr) as Array<{ payload: string }>)
      .map((row) => JSON.parse(row.payload) as Record<string, unknown>);

  it("the #5409 shape: closes the round as no_new_evidence, restores awaiting_author, applies nothing from the unposted verdict", async () => {
    const { roundId, key, mark } = skippedRound(500);
    store.recordApprovalWithheld(500, { head_sha: "older-head", ci_state: "red", reason: "red-ci" });
    const name = write(500, 1, verdictFile({ pr: 500, verdict: "REQUEST_CHANGES" }));

    expect(await watcher().handleFile(name)).toBe(true);

    const round = store.db.prepare("SELECT * FROM rounds WHERE id = ?").get(roundId) as Record<string, unknown>;
    expect(round).toMatchObject({ status: "cancelled", cancel_cause: "no_new_evidence", verdict: null, gh_review_id: null });
    expect(String(round.summary)).toContain("guard 2");
    expect(store.getPr(500)?.state).toBe("awaiting_author");
    // The prior mark is exactly as it was: not re-stamped, not enriched with this round.
    expect(store.reviewedHead(500)).toEqual(mark);
    // No failure, no retry, no successor, no verdict application, no escalation.
    expect(store.openReviewFailure(500)).toBeUndefined();
    expect(events("verdict_applied", 500)).toEqual([]);
    expect(events("round_self_requeued", 500)).toEqual([]);
    expect(events("review_failed_loud", 500)).toEqual([]);
    expect(store.anomalies().map((a) => a.kind)).not.toContain("review_failed_loud");
    expect(adapter.calls).toContain(`removeLabel:500:${cfg.github.in_progress_label}`);
    expect(adapter.calls).not.toContain(`addLabel:500:${cfg.github.reviewed_label}`);
    // Withheld work elsewhere is untouched.
    expect(store.approvalWithheld(500)?.head_sha).toBe("older-head");
    // The verdict file was consumed (archived), and the durable event explains the late race.
    expect(existsSync(join(dir, name))).toBe(false);
    expect(events("posting_guarded_noop", 500)).toEqual([expect.objectContaining({
      stage: "posting",
      via: "verdict",
      round_no: 1,
      posting_key: key,
      head_sha: HEAD,
      guard: "no-new-evidence",
      unposted_verdict: "REQUEST_CHANGES",
      standing_verdict: "REQUEST_CHANGES",
      standing_source: "posted_event",
      restored_state: "awaiting_author",
      mark: expect.objectContaining({ posted_event: "REQUEST_CHANGES", verdict: null }),
    })]);
  });

  it("a skipped round's unposted APPROVE can never approve: the standing REQUEST_CHANGES still wins", async () => {
    const { mark } = skippedRound(501);

    await watcher().handleFile(write(501, 1, verdictFile({ pr: 501, verdict: "APPROVE" })));

    expect(store.getPr(501)?.state).toBe("awaiting_author");
    expect(store.reviewedHead(501)).toEqual(mark);
    expect(store.roundsFor(501)[0]).toMatchObject({ status: "cancelled", cancel_cause: "no_new_evidence", verdict: null });
    expect(adapter.calls).not.toContain(`addLabel:501:${cfg.github.reviewed_label}`);
    expect(events("posting_guarded_noop", 501)[0]).toMatchObject({ unposted_verdict: "APPROVE", standing_verdict: "REQUEST_CHANGES" });
  });

  it("a standing partial APPROVE restores tracked", async () => {
    skippedRound(502, "APPROVE");

    await watcher().handleFile(write(502, 1, verdictFile({ pr: 502, verdict: "REQUEST_CHANGES" })));

    expect(store.getPr(502)?.state).toBe("tracked");
    expect(store.roundsFor(502)[0]).toMatchObject({ status: "cancelled", cancel_cause: "no_new_evidence" });
    expect(events("posting_guarded_noop", 502)[0]).toMatchObject({ standing_verdict: "APPROVE", restored_state: "tracked" });
  });

  it("a COMMENT-only standing mark is never guessed: tracked, an anomaly, still no failure and no approve", async () => {
    skippedRound(503, "COMMENT");

    await watcher().handleFile(write(503, 1, verdictFile({ pr: 503, verdict: "APPROVE" })));

    expect(store.getPr(503)?.state).toBe("tracked");
    expect(store.roundsFor(503)[0]).toMatchObject({ status: "cancelled", cancel_cause: "no_new_evidence", verdict: null });
    expect(store.openReviewFailure(503)).toBeUndefined();
    expect(store.anomalies().map((a) => a.kind)).toContain("standing_review_unknown");
    expect(adapter.calls).not.toContain(`addLabel:503:${cfg.github.reviewed_label}`);
    expect(events("posting_guarded_noop", 503)[0]).toMatchObject({ standing_verdict: null, standing_source: null, restored_state: "tracked" });
  });

  it("is consumed ONCE: the deadline sweep settles it, and the verdict file that arrives afterwards replays inertly", async () => {
    const { roundId } = skippedRound(504);
    const later = new Date(Date.now() + (cfg.daemon.round_deadline_min + 10) * 60_000);

    expect(await watcher({ now: () => later }).checkDeadlines()).toEqual([]);

    expect(store.db.prepare("SELECT status, cancel_cause FROM rounds WHERE id = ?").get(roundId)).toEqual({ status: "cancelled", cancel_cause: "no_new_evidence" });
    expect(store.getPr(504)?.state).toBe("awaiting_author");
    expect(events("posting_guarded_noop", 504)[0]).toMatchObject({ via: "deadline" });

    // The session finishes writing its verdict a moment later.
    const name = write(504, 1, verdictFile({ pr: 504, verdict: "REQUEST_CHANGES" }));
    expect(await watcher().handleFile(name)).toBe(true);

    expect(existsSync(join(dir, name))).toBe(false);
    expect(store.db.prepare("SELECT status, cancel_cause, verdict FROM rounds WHERE id = ?").get(roundId)).toEqual({ status: "cancelled", cancel_cause: "no_new_evidence", verdict: null });
    expect(store.getPr(504)?.state).toBe("awaiting_author");
    expect(events("posting_guarded_noop", 504)).toHaveLength(1);
    expect(events("posting_guarded_noop_replayed", 504)).toEqual([expect.objectContaining({ via: "verdict", round_status: "cancelled" })]);
    expect(events("verdict_applied", 504)).toEqual([]);
    expect(store.openReviewFailure(504)).toBeUndefined();
  });

  it("a session that was refused and settled without writing a verdict is 'settled', not failed loud", async () => {
    const { roundId } = skippedRound(505);

    expect(await watcher().recoverInfrastructureFailure(505, 1, "settled_without_verdict", "parent settled")).toBe("settled");

    expect(store.db.prepare("SELECT status, cancel_cause FROM rounds WHERE id = ?").get(roundId)).toEqual({ status: "cancelled", cancel_cause: "no_new_evidence" });
    expect(store.getPr(505)?.state).toBe("awaiting_author");
    expect(store.openReviewFailure(505)).toBeUndefined();
    expect(events("posting_guarded_noop", 505)[0]).toMatchObject({ via: "settled_without_verdict", unposted_verdict: null });
  });

  it("an author reply landing AFTER the refusal is tolerated — the reply belongs to ping-pong, the skip still settles", async () => {
    skippedRound(506);
    store.noteAuthorReply(506, "2099-01-01T00:00:00.000Z");

    await watcher().handleFile(write(506, 1, verdictFile({ pr: 506 })));

    expect(store.roundsFor(506)[0]).toMatchObject({ status: "cancelled", cancel_cause: "no_new_evidence" });
    expect(store.getPr(506)?.state).toBe("awaiting_author");
    expect(store.reviewedHead(506)?.last_author_reply_at).toBe("2099-01-01T00:00:00.000Z");
  });

  it("a live author reply BETWEEN the review and the recorded refusal exposes a lookalike: guard 2 would have passed, so it fails loud", async () => {
    const { roundId, mark } = skippedRound(513);
    // The reply follows the review and predates the recorded refusal (review
    // + 60s): at refusal time the live mark said "new evidence".
    store.noteAuthorReply(513, new Date(Date.parse(mark.reviewed_at) + 30_000).toISOString());

    expect(await watcher({ postingReceiptGraceS: 0 }).handleFile(write(513, 1, verdictFile({ pr: 513 })))).toBe(true);

    expect(store.db.prepare("SELECT status, cancel_cause FROM rounds WHERE id = ?").get(roundId)).toEqual({ status: "cancelled", cancel_cause: "infrastructure_failure" });
    expect(store.openReviewFailure(513)).toMatchObject({ stage: "posting_receipt", work_owed: 1 });
    expect(events("posting_guarded_noop", 513)).toEqual([]);
  });

  it("a record written in the other mode is a config disagreement, not a settlement", async () => {
    const { roundId, key, mark } = skippedRound(514);
    writeGuardedNoop(514, 1, key, mark, { mode: "live" }); // the fixture daemon is dry_run = true

    expect(await watcher({ postingReceiptGraceS: 0 }).handleFile(write(514, 1, verdictFile({ pr: 514 })))).toBe(true);

    expect(store.db.prepare("SELECT status, cancel_cause FROM rounds WHERE id = ?").get(roundId)).toEqual({ status: "cancelled", cancel_cause: "infrastructure_failure" });
    expect(store.openReviewFailure(514)?.detail).toContain("mode");
  });

  it("a record whose standing mark no longer describes the live one is AMBIGUOUS and stays loud", async () => {
    const { roundId, key, mark } = skippedRound(507);
    // The live mark was re-stamped since the record was written.
    writeGuardedNoop(507, 1, key, { ...mark, reviewed_at: "2020-01-01T00:00:00.000Z" });

    expect(await watcher({ postingReceiptGraceS: 0 }).handleFile(write(507, 1, verdictFile({ pr: 507 })))).toBe(true);

    expect(store.db.prepare("SELECT status, cancel_cause FROM rounds WHERE id = ?").get(roundId)).toEqual({ status: "cancelled", cancel_cause: "infrastructure_failure" });
    expect(store.openReviewFailure(507)).toMatchObject({ stage: "posting_receipt", work_owed: 1 });
    expect(events("posting_guarded_noop", 507)).toEqual([]);
  });

  it("a record for another identity is ignored, and the ordinary fail-loud path still binds after grace", async () => {
    const { roundId, mark } = skippedRound(508);
    // Same file name, wrong key/head: a session-authored lookalike.
    writeGuardedNoop(508, 1, roundPostingKey(508, 1, "0ther"), { ...mark, head_sha: "0ther" }, { head_sha: "0ther" });

    expect(await watcher({ postingReceiptGraceS: 0 }).handleFile(write(508, 1, verdictFile({ pr: 508 })))).toBe(true);

    expect(store.db.prepare("SELECT status, cancel_cause FROM rounds WHERE id = ?").get(roundId)).toEqual({ status: "cancelled", cancel_cause: "infrastructure_failure" });
    expect(store.openReviewFailure(508)).toMatchObject({ stage: "posting_receipt" });
  });

  it("live mode: a bot review carrying this round's marker contradicts the record — GitHub's truth wins and the review links", async () => {
    const { roundId, key, mark } = skippedRound(509);
    writeGuardedNoop(509, 1, key, mark, { mode: "live" }); // a live daemon, a live record
    adapter.listReviewsFull = async () => [{
      id: 778,
      user: cfg.github.bot_login,
      user_type: "Bot",
      state: "CHANGES_REQUESTED",
      body: `review body\n\n${postingMarker(key)}`,
      commit_id: HEAD,
      submitted_at: "2026-08-13T11:59:59Z",
    }];

    expect(await watcher({ cfg: { ...cfg, dry_run: false } }).handleFile(write(509, 1, verdictFile({ pr: 509 })))).toBe(true);

    expect(store.db.prepare("SELECT status, gh_review_id, verdict FROM rounds WHERE id = ?").get(roundId)).toEqual({ status: "done", gh_review_id: 778, verdict: "REQUEST_CHANGES" });
    expect(events("posting_guarded_noop_contradicted", 509)).toEqual([expect.objectContaining({ gh_review_id: 778, posting_key: key })]);
    expect(events("posting_guarded_noop", 509)).toEqual([]);
  });

  it("a fresh-head successor owed by the skipped round is promoted, never cleared", async () => {
    const { roundId } = skippedRound(510);
    store.recordSuccessor({ pr: 510, predecessor_round_id: roundId, head_sha: "def456", provenance: "human", reason: "trigger-on-new-head" });

    await watcher().handleFile(write(510, 1, verdictFile({ pr: 510 })));

    expect(store.roundsFor(510)[0]).toMatchObject({ status: "cancelled", cancel_cause: "no_new_evidence" });
    expect(store.getPr(510)).toMatchObject({ state: "queued", head_sha: "def456", trigger_provenance: "human" });
    expect(store.successorFor(510)?.head_sha).toBe("def456");
  });

  it("the ordinary receipt paths are unchanged: confirmed still applies, absent still fails loud after grace", async () => {
    // Confirmed: the verdict applies and the mark is enriched, exactly as before.
    standingMark(511);
    reviewingRound(511);
    const { key } = stampPosting(511, 1);
    writePostingReceipt(511, 1, key, "REQUEST_CHANGES");
    expect(await watcher().handleFile(write(511, 1, verdictFile({ pr: 511 })))).toBe(true);
    expect(store.roundsFor(511)[0]).toMatchObject({ status: "done", gh_review_id: 991 });
    expect(store.reviewedHead(511)).toMatchObject({ verdict: "REQUEST_CHANGES", round_no: 1 });

    // Absent: still a posting_receipt failure — the new path never widened "missing" into "fine".
    standingMark(512);
    reviewingRound(512);
    stampPosting(512, 1);
    expect(await watcher({ postingReceiptGraceS: 0 }).handleFile(write(512, 1, verdictFile({ pr: 512 })))).toBe(true);
    expect(store.roundsFor(512)[0]).toMatchObject({ status: "cancelled", cancel_cause: "infrastructure_failure" });
    expect(store.openReviewFailure(512)).toMatchObject({ stage: "posting_receipt", work_owed: 1 });
  });
});
