import {
  appendFileSync,
  closeSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  openSync,
  readFileSync,
  readdirSync,
  rmSync,
  utimesSync,
  writeFileSync,
  writeSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { parseConfig, parseEscalation, type Config } from "../src/config.js";
import type { GateResult } from "../src/gate.js";
import { StateStore, type ReviewedHeadRow } from "../src/state.js";
import { fingerprintRoundIntegrity } from "../src/execboundary.js";
import { githubCloneDir } from "../src/config.js";
import { postingMarker, roundPostingKey } from "../src/posting-receipt.js";
import type { PassPlanEntry, SessionHooks, VerdictFile } from "../src/types.js";
import { AnomalyWakePolicy } from "../src/anomalies.js";
import type { InboxWriter } from "../src/companioninbox.js";
import {
  OWED_MEASUREMENT_RESUME_MAX_MS,
  STAGED_FILE_MAX_AGE_MS,
  sweepStatusOf,
  tailPlannedLenses,
  validateVerdict,
  VerdictWatcher,
  type VerdictAdapter,
} from "../src/verdicts.js";
import { retryWithheldApproval } from "../src/cigate.js";
import { reconcileOrphanedRounds } from "../src/reconcile.js";
import { TranscriptIndex } from "../src/transcriptindex.js";
import { MemoryTranscriptFs } from "./helpers/memory-transcript-fs.js";
import { HEAVY_TIMEOUT_MS } from "./helpers/suite-timeouts.js";
import { waitFor } from "./helpers/wait-for.js";

const cfg: Config = parseConfig(
  readFileSync(resolve(process.cwd(), "tests/fixtures/config.toml"), "utf8"),
);

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
/** The inbox writer each recording hooks object collects into. */
const inboxWriters = new WeakMap<SessionHooks, InboxWriter>();

function wireWake(s: StateStore, hooks: SessionHooks): void {
  const policy = new AnomalyWakePolicy({ writeInbox: inboxWriters.get(hooks) ?? (async () => {}) });
  s.setAnomalySink((sig) => policy.onAnomaly(sig));
}

function recordingHooks(): { hooks: SessionHooks; overseer: string[]; injects: string[] } {
  const overseer: string[] = [];
  const injects: string[] = [];
  const hooks: SessionHooks = {
    async dispatchRound() {},
    async inject(pr, msg) {
      injects.push(`${pr}:${msg}`);
    },
    async archiveAndClose() {},
  };
  inboxWriters.set(hooks, async (msg) => void overseer.push(msg));
  return { overseer, injects, hooks };
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
  return store.startRound(
    pr,
    "first",
    ["pass-baseline", "pass-validate"],
    cfg.daemon.round_deadline_min,
  );
}

function policyRound(pr: number): number {
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
  return store.startRound(
    pr,
    "first",
    ["pass-baseline", "pass-validate"],
    cfg.daemon.round_deadline_min,
    {
      pass_plan: [
        {
          lens: "pass-baseline",
          agent: "pass-baseline--sol-med",
          tier: "sol-med",
          raisable_to: ["pass-baseline--sol-high"],
        },
        {
          lens: "pass-validate",
          agent: "pass-validate--sol-high",
          tier: "sol-high",
          raisable_to: [],
        },
      ],
      addable_passes: [
        { lens: "pass-concurrency", tier: "sol-med" },
        { lens: "pass-security", tier: "sol-high" },
      ],
    },
  );
}

function write(pr: number, round: number, body: unknown): string {
  const name = `pr-${pr}-round-${round}.json`;
  writeFileSync(join(dir, name), typeof body === "string" ? body : JSON.stringify(body));
  return name;
}

function stampPosting(
  pr: number,
  roundNo: number,
  head = "abc123",
): { roundId: number; key: string; receiptDir: string } {
  const round = store.roundsFor(pr).find((row) => row.round_no === roundNo)!;
  const key = roundPostingKey(pr, roundNo, head);
  store.stampPostingKey(round.id, key);
  return { roundId: round.id, key, receiptDir: join(dir, "state", "posting-receipts") };
}

function writePostingReceipt(
  pr: number,
  roundNo: number,
  key: string,
  actualEvent: "APPROVE" | "REQUEST_CHANGES" | "COMMENT",
  over: Record<string, unknown> = {},
): void {
  const receiptDir = join(dir, "state", "posting-receipts");
  mkdirSync(receiptDir, { recursive: true });
  writeFileSync(
    join(receiptDir, `pr-${pr}-round-${roundNo}.json`),
    JSON.stringify({
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
      gh_state:
        actualEvent === "APPROVE"
          ? "APPROVED"
          : actualEvent === "REQUEST_CHANGES"
            ? "CHANGES_REQUESTED"
            : "COMMENTED",
      ...over,
    }),
  );
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

function watcher(
  over: Partial<ConstructorParameters<typeof VerdictWatcher>[0]> = {},
  hooks?: SessionHooks,
): VerdictWatcher {
  const h = hooks ?? recordingHooks().hooks;
  wireWake((over.store as StateStore | undefined) ?? store, h);
  return new VerdictWatcher({
    cfg,
    store,
    adapter,
    hooks: h,
    ...(inboxWriters.has(h) ? { writeInbox: inboxWriters.get(h)! } : {}),
    verdictDir: dir,
    root: dir, // usage measurement stays inside the temp dir…
    usage: {},
    partialWrite: { windowMs: 0 },
    ...over,
  });
}

/**
 * A PR's round-end transcript reads, held at a gate:
 * `reached` resolves once the round end is waiting inside them, `release`
 * lets them finish. The transcript is one in-memory session file of `lines`.
 */
function gatedTranscripts(
  pr: number,
  lines: string[],
): {
  reached: Promise<void>;
  release: () => void;
  usage: NonNullable<ConstructorParameters<typeof VerdictWatcher>[0]["usage"]>;
} {
  let release!: () => void;
  const gate = new Promise<void>((resolveGate) => {
    release = resolveGate;
  });
  let signal!: () => void;
  const reached = new Promise<void>((resolveReached) => {
    signal = resolveReached;
  });
  const fs = new MemoryTranscriptFs(
    { [`/sessions/pr-${pr}/session.jsonl`]: lines.join("\n") },
    {},
    Date.now(),
  );
  fs.beforeStat = async () => {
    signal();
    await gate;
  };
  return {
    reached,
    release,
    usage: {
      sessionDirFor: (n) => `/sessions/pr-${n}`,
      transcripts: new TranscriptIndex({ fs }),
    },
  };
}

const tokensIn = (roundId: number): unknown =>
  (store.db.prepare("SELECT tokens_in FROM rounds WHERE id = ?").get(roundId) as any).tokens_in;

describe("validateVerdict", () => {
  it(
    "accepts and caps an optional summary; rejects non-strings",
    { timeout: HEAVY_TIMEOUT_MS },
    () => {
      const ok = validateVerdict({
        ...verdictFile(),
        summary: "  Adds retry to the CRM send. Round found two nits. Awaiting author. ",
      });
      expect(ok.ok).toBe(true);
      if (ok.ok)
        expect(ok.verdict?.summary).toBe(
          "Adds retry to the CRM send. Round found two nits. Awaiting author.",
        );
      const long = validateVerdict({ ...verdictFile(), summary: "x".repeat(2000) });
      expect(long.ok).toBe(true);
      if (long.ok) expect(long.verdict?.summary?.length).toBe(800);
      expect(validateVerdict({ ...verdictFile(), summary: 42 }).ok).toBe(false);
    },
  );

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

  // These park pins carry `passes` telemetry: a NEEDS_HUMAN
  // with no executed-pass evidence is an unfinished review and is requeued,
  // not parked (see self-requeue.test.ts "NEEDS_HUMAN requires a finished review").
  it("a legacy NEEDS_HUMAN lands the PR tracked (the park is retired), no reviewer touched", async () => {
    reviewingRound(102);
    await watcher().handleFile(
      write(
        102,
        1,
        verdictFile({
          pr: 102,
          verdict: "NEEDS_HUMAN",
          ai_approved: true,
          passes: [{ name: "pass-baseline", tier: "sol-med", findings: 1 }],
        }),
      ),
    );
    expect(store.getPr(102)!.state).toBe("tracked");
    // The whole GitHub surface of a park: labels, nothing else.
    expect(
      adapter.calls.every((c) => c.startsWith("addLabel") || c.startsWith("removeLabel")),
    ).toBe(true);
    const logged = JSON.parse(
      (
        store.db.prepare("SELECT payload FROM events WHERE kind = 'verdict_applied'").get() as {
          payload: string;
        }
      ).payload,
    );
    expect(logged).toMatchObject({ verdict: "NEEDS_HUMAN", ai_approved: true });
    expect(logged).not.toHaveProperty("escalation_skipped");
  });

  it("accepts a legacy ESCALATE verdict as NEEDS_HUMAN (the frozen seed still emits it)", async () => {
    reviewingRound(105);
    await watcher().handleFile(
      write(
        105,
        1,
        verdictFile({
          pr: 105,
          verdict: "ESCALATE",
          passes: [{ name: "pass-baseline", tier: "sol-med", findings: 1 }],
        }),
      ),
    );
    expect(store.getPr(105)!.state).toBe("tracked");
    const logged = JSON.parse(
      (
        store.db.prepare("SELECT payload FROM events WHERE kind = 'verdict_applied'").get() as {
          payload: string;
        }
      ).payload,
    );
    expect(logged.verdict).toBe("NEEDS_HUMAN"); // normalised on the way in
  });

  it("startup sweep consumes every pending file", async () => {
    reviewingRound(103);
    reviewingRound(104);
    write(103, 1, verdictFile({ pr: 103, verdict: "APPROVE" }));
    write(
      104,
      1,
      verdictFile({
        pr: 104,
        verdict: "NEEDS_HUMAN",
        passes: [{ name: "pass-baseline", tier: "sol-med", findings: 1 }],
      }),
    );
    writeFileSync(join(dir, "notes.txt"), "ignore me");
    const done = await watcher().sweep();
    expect(done.sort()).toEqual(["pr-103-round-1.json", "pr-104-round-1.json"]);
    expect(store.getPr(103)!.state).toBe("tracked");
    expect(store.getPr(104)!.state).toBe("tracked");
  });

  it("tolerates a partial write by retrying the parse", async () => {
    reviewingRound(105);
    const name = write(105, 1, '{"pr": 105, "round_no": 1, "verdi');
    const w = watcher({ partialWrite: undefined }); // the production policy
    const pending = w.handleFile(name);
    setTimeout(() => write(105, 1, verdictFile({ pr: 105, verdict: "APPROVE" })), 8);
    await pending;
    expect(store.getPr(105)!.state).toBe("tracked");
    expect(
      store.db.prepare("SELECT COUNT(*) AS c FROM events WHERE kind = 'verdict_malformed'").get(),
    ).toMatchObject({ c: 0 });
  });
});

// ---------------------------------------------------------------------------
// A session may write the verdict in place (open O_TRUNC, then the bytes). On a
// CPU-starved container the gap between the two can outlive a short retry
// tolerance, and a valid APPROVE would read as "Unexpected end of JSON input".
// These write the file the way pi does — one open fd, the bytes in two halves —
// with the production partial-write policy.
// ---------------------------------------------------------------------------
describe("partial writes are waited out, not misread", () => {
  const sleepMs = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));
  const productionWatcher = () => watcher({ partialWrite: undefined });

  async function halvesApart(pr: number, gapMs: number): Promise<boolean> {
    reviewingRound(pr);
    const name = `pr-${pr}-round-1.json`;
    const body = JSON.stringify(verdictFile({ pr, verdict: "APPROVE" }));
    const cut = Math.floor(body.length / 2);
    const fd = openSync(join(dir, name), "w"); // O_TRUNC: fs.watch fires here
    writeSync(fd, body.slice(0, cut));
    const pending = productionWatcher().handleFile(name);
    await sleepMs(gapMs);
    writeSync(fd, body.slice(cut));
    closeSync(fd);
    return pending;
  }

  const malformedCount = () =>
    (
      store.db
        .prepare("SELECT COUNT(*) AS c FROM events WHERE kind = 'verdict_malformed'")
        .get() as {
        c: number;
      }
    ).c;

  it("a verdict written in two halves 200 ms apart is parsed and applied, not malformed", async () => {
    expect(await halvesApart(150, 200)).toBe(true);
    expect(malformedCount()).toBe(0);
    expect(store.roundsFor(150)[0]).toMatchObject({ status: "done", verdict: "APPROVE" });
    expect(store.getPr(150)?.state).toBe("tracked");
    expect(store.openReviewFailure(150)).toBeUndefined();
    const waited = store.db
      .prepare("SELECT payload FROM events WHERE kind = 'verdict_read_waited' AND pr = 150")
      .get() as { payload: string } | undefined;
    expect(JSON.parse(waited!.payload)).toMatchObject({ outcome: "parsed" });
    expect(JSON.parse(waited!.payload).reads).toBeGreaterThan(1);
  });

  it(
    "a verdict written in two halves 2 s apart is parsed and applied, not malformed",
    { timeout: HEAVY_TIMEOUT_MS },
    async () => {
      expect(await halvesApart(151, 2_000)).toBe(true);
      expect(malformedCount()).toBe(0);
      expect(store.roundsFor(151)[0]).toMatchObject({ status: "done", verdict: "APPROVE" });
      expect(store.openReviewFailure(151)).toBeUndefined();
    },
  );

  it(
    "the sweep never holds one PR's verdict behind another PR's file that is still being written",
    { timeout: HEAVY_TIMEOUT_MS },
    async () => {
      reviewingRound(153); // its file is mid-write for 1.5 s
      reviewingRound(154); // its file is complete
      const body = JSON.stringify(verdictFile({ pr: 153, verdict: "APPROVE" }));
      const fd = openSync(join(dir, "pr-153-round-1.json"), "w");
      writeSync(fd, body.slice(0, 10));
      write(154, 1, verdictFile({ pr: 154, verdict: "APPROVE" }));

      const t0 = Date.now();
      const sweeping = productionWatcher().sweep();
      const deadline = t0 + 1_000;
      while (store.roundsFor(154)[0]?.status !== "done" && Date.now() < deadline) await sleepMs(10);
      expect(store.roundsFor(154)[0]?.status).toBe("done");
      expect(store.roundsFor(153)[0]?.status).toBe("running"); // still waiting it out

      await sleepMs(Math.max(0, t0 + 1_500 - Date.now()));
      writeSync(fd, body.slice(10));
      closeSync(fd);
      expect(await sweeping).toEqual(["pr-153-round-1.json", "pr-154-round-1.json"]);
      expect(store.roundsFor(153)[0]?.status).toBe("done");
      expect(malformedCount()).toBe(0);
    },
  );

  it(
    "a truly corrupt file still becomes malformed — after it has sat still, inside the bounded window",
    { timeout: HEAVY_TIMEOUT_MS },
    async () => {
      reviewingRound(152);
      const name = write(152, 1, '{"pr": 152, "round_no": 1, "verdict": "APPRO');
      const started = Date.now();
      expect(await productionWatcher().handleFile(name)).toBe(true);
      const took = Date.now() - started;
      expect(took).toBeGreaterThanOrEqual(3_000); // DEFAULT settleMs
      expect(took).toBeLessThan(30_000); // DEFAULT windowMs
      expect(malformedCount()).toBe(1);
      expect(store.openReviewFailure(152)).toMatchObject({ stage: "malformed_verdict" });
      expect(store.anomalies()[0]!.detail).toContain("the file had stopped changing");
      expect(existsSync(join(dir, name))).toBe(false);
    },
  );
});

describe("measured round usage", () => {
  const jsonlLine = (input: number, output: number): string =>
    JSON.stringify({
      type: "message",
      timestamp: new Date().toISOString(),
      message: { role: "assistant", usage: { input, output } },
    });
  const modelLine = (): string =>
    JSON.stringify({ type: "model_change", provider: "openai-codex", modelId: "gpt-5.6-sol" });
  const bashLine = (command: string): string =>
    JSON.stringify({
      type: "message",
      timestamp: new Date().toISOString(),
      message: {
        role: "assistant",
        content: [{ type: "toolCall", name: "bash", arguments: { command } }],
      },
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
    await watcher({ usage: { pricing: {} } }).handleFile(write(103, 1, verdictFile({ pr: 103 })));
    const round = store.db.prepare("SELECT * FROM rounds WHERE id = ?").get(roundId) as any;
    expect(round.tokens_in).toBe(500);
    expect(round.tokens_out).toBe(75); // output + reasoning
    expect(round.tokens_cache_read).toBe(2000);
    expect(round.est_usd).toBeCloseTo(0.077, 9);
  });

  it("stores measured tokens and a price-table fallback estimate on the round (no cost fields), ignoring self-reported spend", async () => {
    const roundId = reviewingRound(100);
    writeSessionJsonl(100, [
      modelLine(),
      jsonlLine(1_000_000, 500_000),
      jsonlLine(200_000, 100_000),
      "garbage line",
    ]);
    const w = watcher({
      usage: {
        pricing: { "gpt-5.6-sol": { input_per_mtok: 2, output_per_mtok: 8 } },
      },
    });
    await w.handleFile(write(100, 1, verdictFile({ spend_usd: 1.25 })));

    const round = store.db.prepare("SELECT * FROM rounds WHERE id = ?").get(roundId) as any;
    expect(round.tokens_in).toBe(1_200_000);
    expect(round.tokens_out).toBe(600_000);
    expect(round.est_usd).toBeCloseTo(1.2 * 2 + 0.6 * 8, 6);
    expect(round.spend_usd).toBeNull();
  });

  // P8.9: a worker that closed its report is the round's est_usd; the tokens stay
  // the transcripts'. Anything short of one closed, single-worker report falls back.
  describe("the worker's own report", () => {
    const costLine = (total: number): string =>
      JSON.stringify({
        type: "message",
        timestamp: new Date().toISOString(),
        message: { role: "assistant", usage: { input: 500, output: 50, cost: { total } } },
      });
    const command = (pr: number, id: string, claims = 1): void => {
      store.createSessionCommand({
        id,
        pr,
        session: `pr-${pr}`,
        kind: "round",
        round_no: 1,
        payload_sha256: "a".repeat(64),
        payload_path: `/payload/${id}.md`,
        inject_path: `/inject/${id}.md`,
        next_check_at: new Date().toISOString(),
      });
      for (let i = 0; i < claims; i++) {
        if (i > 0)
          store.db.prepare("UPDATE session_commands SET status='pending' WHERE id=?").run(id);
        store.claimSessionCommand(id, "worker", new Date().toISOString());
      }
    };
    const estOf = async (pr: number, roundId: number): Promise<number | null> => {
      writeSessionJsonl(pr, [modelLine(), costLine(0.5)]);
      await watcher({ usage: { pricing: {} } }).handleFile(write(pr, 1, verdictFile({ pr })));
      const round = store.db.prepare("SELECT * FROM rounds WHERE id = ?").get(roundId) as any;
      expect(round.tokens_in).toBe(500); // always the transcripts'
      return round.est_usd as number | null;
    };

    it("is est_usd when the worker closed it, warm-ups and all", async () => {
      const roundId = reviewingRound(110);
      command(110, "cmd-110");
      store.recordCommandUsage("cmd-110", { est_usd: 0.4, lens_usd: 0.1, final: false });
      store.recordCommandUsage("cmd-110", { est_usd: 0.53, lens_usd: 0.2, final: true });
      expect(await estOf(110, roundId)).toBeCloseTo(0.53, 9); // 0.03 of warm-ups over the transcript
    });

    it("falls back to the transcripts for a worker that crashed before closing", async () => {
      const roundId = reviewingRound(111);
      command(111, "cmd-111");
      store.recordCommandUsage("cmd-111", { est_usd: 0.3, lens_usd: 0, final: false });
      expect(await estOf(111, roundId)).toBeCloseTo(0.5, 9);
    });

    it("falls back when the command was claimed again: the last worker did not see the first's spend", async () => {
      const roundId = reviewingRound(112);
      command(112, "cmd-112", 2);
      store.recordCommandUsage("cmd-112", { est_usd: 0.2, lens_usd: 0, final: true });
      expect(await estOf(112, roundId)).toBeCloseTo(0.5, 9);
    });

    it("re-states est_usd when the closing report lands after the round was measured", async () => {
      // The production order: the verdict is applied while the session still runs,
      // and `done` comes last (after the turns, compaction and the warm-up fold).
      const roundId = reviewingRound(114);
      command(114, "cmd-114");
      store.recordCommandUsage("cmd-114", { est_usd: 0.4, lens_usd: 0.1, final: false });
      expect(await estOf(114, roundId)).toBeCloseTo(0.5, 9); // measured first: the transcripts'
      store.recordCommandUsage("cmd-114", { est_usd: 0.53, lens_usd: 0.2, final: true });
      const round = store.db.prepare("SELECT * FROM rounds WHERE id = ?").get(roundId) as any;
      expect(round.est_usd).toBeCloseTo(0.53, 9);
      expect(round.tokens_in).toBe(500); // the tokens stay the transcripts'
    });

    it("falls back on the tmux routes, which report nothing", async () => {
      const roundId = reviewingRound(113);
      command(113, "cmd-113");
      expect(await estOf(113, roundId)).toBeCloseTo(0.5, 9);
    });
  });

  it("records est_usd null when the model has no price entry", async () => {
    const roundId = reviewingRound(101);
    writeSessionJsonl(101, [modelLine(), jsonlLine(1000, 100)]);
    await watcher({ usage: { pricing: {} } }).handleFile(write(101, 1, verdictFile({ pr: 101 })));
    const round = store.db.prepare("SELECT * FROM rounds WHERE id = ?").get(roundId) as any;
    expect(round.tokens_in).toBe(1000);
    expect(round.est_usd).toBeNull();
  });

  // The git-config integrity check, wired.
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

    const ev = store.db
      .prepare("SELECT payload FROM events WHERE kind = 'git_config_modified'")
      .get() as { payload: string } | undefined;
    expect(ev, "the durable record").toBeTruthy();
    expect(JSON.parse(ev!.payload).changes.length).toBeGreaterThan(0);
    expect(rec.overseer.join("\n")).toContain("git's configuration changed DURING a round");
  });

  it("a round with NO baseline is never judged — unknown is not evidence of a change", async () => {
    // The same rule as the receipt scan. A round that
    // predates the check, or whose fingerprint could not be taken, must be
    // silent rather than alarming on every single round.
    const roundId = reviewingRound(109);
    writeSessionJsonl(109, [modelLine(), jsonlLine(10, 1)]);
    expect(store.roundGitConfig(roundId)).toBeUndefined();
    await watcher({}).handleFile(write(109, 1, verdictFile({ pr: 109 })));
    expect(
      store.db.prepare("SELECT COUNT(*) c FROM events WHERE kind = 'git_config_modified'").get(),
    ).toMatchObject({ c: 0 });
  });

  it("…and a MALFORMED baseline is not judged either", async () => {
    // The teeth behind the previous test. `gitConfigChanges` is total over a
    // malformed fingerprint, so the "no baseline ⇒ never judged" guard is
    // load-bearing: without it, this round reports every watched path as
    // changed.
    const roundId = reviewingRound(111);
    writeSessionJsonl(111, [modelLine(), jsonlLine(10, 1)]);
    // A watched file must actually EXIST, or the round-end fingerprint is
    // all-"absent" and matches an empty baseline by accident, passing for the
    // wrong reason.
    mkdirSync(join(dir, "pihome"), { recursive: true });
    writeFileSync(join(dir, "pihome", ".gitconfig"), "[user]\n\tname = qcr\n");
    store.recordRoundGitConfig(roundId, { not: "a fingerprint" });
    await watcher({}).handleFile(write(111, 1, verdictFile({ pr: 111 })));
    expect(
      store.db.prepare("SELECT COUNT(*) c FROM events WHERE kind = 'git_config_modified'").get(),
    ).toMatchObject({ c: 0 });
  });

  it("an UNCHANGED tree is silent — the check must not fire on every round", async () => {
    const roundId = reviewingRound(110);
    writeSessionJsonl(110, [modelLine(), jsonlLine(10, 1)]);
    // The baseline the daemon itself would compute over this very tree.
    store.recordRoundGitConfig(
      roundId,
      await fingerprintRoundIntegrity({
        clonePath: githubCloneDir(cfg.github),
        worktreePath: resolve(dir, "wt/pr-110"),
        piHome: join(dir, "pihome"),
        sandboxRoot: dir,
      }),
    );
    await watcher({}).handleFile(write(110, 1, verdictFile({ pr: 110 })));
    expect(
      store.db.prepare("SELECT COUNT(*) c FROM events WHERE kind = 'git_config_modified'").get(),
    ).toMatchObject({ c: 0 });
    expect(
      store.db
        .prepare("SELECT COUNT(*) c FROM events WHERE kind = 'policy_surface_modified'")
        .get(),
    ).toMatchObject({ c: 0 });
  });

  // The same fingerprint carries this system's OWN policy surface, and
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

    const ev = store.db
      .prepare("SELECT payload FROM events WHERE kind = 'policy_surface_modified'")
      .get() as { payload: string } | undefined;
    expect(ev, "the durable record").toBeTruthy();
    expect(JSON.parse(ev!.payload).changes.map((c: { path: string }) => c.path)).toEqual([
      join(dir, "config.toml"),
    ]);
    expect(rec.overseer.join("\n")).toContain("OWN policy surface changed DURING a round");
    expect(
      store.db.prepare("SELECT COUNT(*) c FROM events WHERE kind = 'git_config_modified'").get(),
    ).toMatchObject({ c: 0 });
  });

  // The live config lives where the install locator says — outside the
  // sandbox root on the VM. The daemon's own baseline,
  // taken over the real disk, must see a rewrite of THAT file.
  // MUTATION: drop `locatedPolicyWatchPaths` from `roundPolicyWatchPaths` in
  // src/execboundary.ts — the first expectation fails.
  it("raises policy_surface_modified when the LOCATED config (QCR_CONFIG, outside the sandbox) changed during the round", async () => {
    const home = mkdtempSync(join(tmpdir(), "qcr-located-"));
    const located = join(home, "acme.toml");
    writeFileSync(located, "dry_run = true\n");
    const prev = process.env.QCR_CONFIG;
    process.env.QCR_CONFIG = located;
    try {
      const roundId = reviewingRound(113);
      writeSessionJsonl(113, [modelLine(), jsonlLine(10, 1)]);
      store.recordRoundGitConfig(
        roundId,
        await fingerprintRoundIntegrity({
          clonePath: githubCloneDir(cfg.github),
          worktreePath: resolve(dir, "wt/pr-113"),
          piHome: join(dir, "pihome"),
          sandboxRoot: dir,
        }),
      );
      writeFileSync(located, "dry_run = false\n"); // the session's write
      await watcher({}).handleFile(write(113, 1, verdictFile({ pr: 113 })));
      const ev = store.db
        .prepare("SELECT payload FROM events WHERE kind = 'policy_surface_modified'")
        .get() as { payload: string } | undefined;
      expect(ev, "the located config is policy surface").toBeTruthy();
      expect(JSON.parse(ev!.payload).changes.map((c: { path: string }) => c.path)).toEqual([
        located,
      ]);
      expect(
        store.db.prepare("SELECT COUNT(*) c FROM events WHERE kind = 'git_config_modified'").get(),
      ).toMatchObject({ c: 0 });
    } finally {
      if (prev === undefined) delete process.env.QCR_CONFIG;
      else process.env.QCR_CONFIG = prev;
      rmSync(home, { recursive: true, force: true });
    }
  });

  it("logs exec-policy violations without inject spam, then piggybacks on an anomaly inject", async () => {
    reviewingRound(100);
    writeSessionJsonl(100, [
      jsonlLine(10, 1),
      bashLine("git diff | head"),
      bashLine("python manage.py test"),
    ]);
    const rec = recordingHooks();
    const w = watcher({}, rec.hooks);
    await w.handleFile(write(100, 1, verdictFile()));

    const ev = store.db
      .prepare("SELECT payload FROM events WHERE kind = 'exec_policy_violation'")
      .get() as { payload: string };
    // The payload carries the class as well as the command, and
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

  // The transcripts are read off the event loop, and what cannot
  // be read is UNKNOWN: never a partial sum posing as a measurement, and never
  // a reason to hold the verdict.
  describe("unknown, never a partial sum — and the verdict still applies", () => {
    const usageUnknown = (pr: number): Record<string, unknown> | undefined => {
      const row = store.db
        .prepare("SELECT payload FROM events WHERE kind = 'round_usage_unknown' AND pr = ?")
        .get(pr) as { payload: string } | undefined;
      return row ? (JSON.parse(row.payload) as Record<string, unknown>) : undefined;
    };

    // MUTATION: in src/transcriptindex.ts return the partial sum when a file
    // was unreadable — the token expectations go red.
    it("an unreadable transcript: tokens NULL, the audit of what was read, the verdict applied", async () => {
      const roundId = reviewingRound(120);
      const fs = new MemoryTranscriptFs(
        {
          "/sessions/pr-120/session.jsonl": [
            modelLine(),
            jsonlLine(10, 1),
            bashLine("python manage.py test"),
          ].join("\n"),
          "/sessions/pr-120/zz-broken.jsonl": jsonlLine(5, 5),
        },
        {},
        Date.now(),
      );
      fs.failOpen("/sessions/pr-120/zz-broken.jsonl", "EACCES"); // there, and unreadable
      await watcher({
        usage: {
          sessionDirFor: (pr) => `/sessions/pr-${pr}`,
          transcripts: new TranscriptIndex({ fs }),
        },
      }).handleFile(write(120, 1, verdictFile({ pr: 120, verdict: "APPROVE" })));

      const round = store.db.prepare("SELECT * FROM rounds WHERE id = ?").get(roundId) as any;
      expect(round.status).toBe("done");
      expect(round.verdict).toBe("APPROVE");
      expect(round.tokens_in).toBeNull();
      expect(round.tokens_out).toBeNull();
      expect(round.est_usd).toBeNull();
      expect(usageUnknown(120)).toMatchObject({
        round_id: roundId,
        reason: "unreadable",
        unreadable_count: 1,
        audit: "incomplete",
      });
      expect(JSON.stringify(usageUnknown(120)!.unreadable)).toContain("zz-broken.jsonl");
      // What WAS read is still audited.
      const ev = store.db
        .prepare("SELECT payload FROM events WHERE kind = 'exec_policy_violation' AND pr = 120")
        .get() as { payload: string } | undefined;
      expect(JSON.parse(ev!.payload).commands).toEqual(["python manage.py test"]);
    });

    it("a transcript read that never answers is cut at the budget — the verdict applies", async () => {
      const roundId = reviewingRound(121);
      const fs = new MemoryTranscriptFs(
        { "/sessions/pr-121/a.jsonl": jsonlLine(10, 1) },
        {},
        Date.now(),
      );
      fs.hangingStats.add("/sessions/pr-121/a.jsonl"); // a hung filesystem
      const w = watcher({
        usage: {
          sessionDirFor: (pr) => `/sessions/pr-${pr}`,
          transcripts: new TranscriptIndex({ fs }),
          budgetMs: 30,
        },
      });
      await w.handleFile(write(121, 1, verdictFile({ pr: 121, verdict: "APPROVE" })));
      const round = store.db.prepare("SELECT * FROM rounds WHERE id = ?").get(roundId) as any;
      expect(round.status).toBe("done");
      expect(round.tokens_in).toBeNull();
      expect(usageUnknown(121)).toMatchObject({ reason: "budget", budget_ms: 30 });
      expect(store.getPr(121)?.state).not.toBe("reviewing");
    });

    it("round after round, the PR's transcript is read on from where the last round end stopped", async () => {
      const transcripts = new TranscriptIndex();
      const w = watcher({ usage: { transcripts } });
      const minutesAgo = (m: number): string => new Date(Date.now() - m * 60_000).toISOString();
      const usageLine = (ts: string, input: number): string =>
        JSON.stringify({
          type: "message",
          timestamp: ts,
          message: { role: "assistant", usage: { input, output: 1 } },
        });
      const r1 = reviewingRound(122);
      store.db.prepare("UPDATE rounds SET started_at = ? WHERE id = ?").run(minutesAgo(10), r1);
      writeSessionJsonl(122, [modelLine(), usageLine(minutesAgo(9), 100), ""]);
      await w.handleFile(write(122, 1, verdictFile({ pr: 122 })));
      expect(
        (store.db.prepare("SELECT tokens_in FROM rounds WHERE id = ?").get(r1) as any).tokens_in,
      ).toBe(100);
      expect(transcripts.stats()).toMatchObject({ full_scans: 1, incremental_scans: 0 });

      store.setPrState(122, "reviewing");
      const r2 = store.startRound(
        122,
        "re_review",
        ["pass-baseline"],
        cfg.daemon.round_deadline_min,
      );
      store.db.prepare("UPDATE rounds SET started_at = ? WHERE id = ?").run(minutesAgo(5), r2);
      appendFileSync(
        join(dir, cfg.pi.session_dir, "pr-122", "session.jsonl"),
        `${usageLine(minutesAgo(4), 7)}\n`,
      );
      await w.handleFile(write(122, 2, verdictFile({ pr: 122, round_no: 2 })));
      expect(
        (store.db.prepare("SELECT tokens_in FROM rounds WHERE id = ?").get(r2) as any).tokens_in,
      ).toBe(7);
      // Round 2 read only what round 1's end had not.
      expect(transcripts.stats()).toMatchObject({ full_scans: 1, incremental_scans: 1 });
    });

    // The reads can take seconds (up to the budget), so WHERE a round end
    // awaits them matters. Each path measures a window that closed at the
    // round's end, and reads it only after its lifecycle rows (and,
    // on a settling path, its held-wake flush) have landed.

    // MUTATION: in apply(), await the measurement before `flushWakes` (and
    // drop the `hasRunningRound` belt in wakes.ts) — the held wake reaches
    // round 2 while it runs; with the belt alone it is never delivered here.
    it("a verdict's reads run after its held-wake flush — a round dispatched meanwhile never receives them (rule 9)", async () => {
      const r1 = reviewingRound(124);
      mkdirSync(join(dir, "state", "ledgers"), { recursive: true });
      writeFileSync(join(dir, "state", "ledgers", "pr-124.md"), "LEDGER PR #124 @ abc123\n");
      store.holdWake(124, "author says: fixed in abc123", "author_reply");
      const gated = gatedTranscripts(124, [modelLine(), jsonlLine(10, 1)]);
      const delivered: Array<{ message: string; roundRunning: boolean }> = [];
      const { hooks } = recordingHooks();
      hooks.inject = async (pr, message) => {
        delivered.push({ message, roundRunning: store.hasRunningRound(pr) });
      };

      const handled = watcher({ usage: gated.usage }, hooks).handleFile(
        write(124, 1, verdictFile({ pr: 124, verdict: "APPROVE" })),
      );
      await gated.reached; // the round end is inside its transcript reads
      // Round 2 is dispatched meanwhile and its order acked: no session
      // command blocks the slot.
      store.setPrState(124, "reviewing");
      const r2 = store.startRound(
        124,
        "re_review",
        ["pass-baseline"],
        cfg.daemon.round_deadline_min,
      );
      expect(store.blockingSessionCommand("pr-124")).toBeFalsy();
      gated.release();
      expect(await handled).toBe(true);

      expect(delivered.map((d) => d.roundRunning)).toEqual([false]);
      expect(delivered[0]!.message).toContain("author says: fixed in abc123");
      expect(store.heldWakes(124)).toHaveLength(0);
      // The window still closed at the verdict: round 1 measured, round 2 untouched.
      expect(tokensIn(r1)).toBe(10);
      expect(store.roundsFor(124).find((r) => r.id === r2)?.status).toBe("running");
    });

    // MUTATION: in handleAnomaly, await the measurement right after
    // markRoundOverdue — the expectations taken while the reads wait go red.
    it("an anomaly round's reads wait behind its transition and FAILED_LOUD incident; its inject still carries their violations", async () => {
      const roundId = reviewingRound(125);
      const gated = gatedTranscripts(125, [
        modelLine(),
        jsonlLine(10, 1),
        bashLine("python manage.py test"),
      ]);
      const rec = recordingHooks();
      const handled = watcher({ usage: gated.usage }, rec.hooks).handleFile(
        write(125, 1, "{broken"),
      );
      await gated.reached;
      // A restart HERE strands nothing: the PR has left `reviewing` and the
      // work is owed as a FAILED_LOUD incident the operator's u clears.
      expect(
        (store.db.prepare("SELECT status FROM rounds WHERE id = ?").get(roundId) as any).status,
      ).toBe("overdue");
      expect(store.getPr(125)?.state).not.toBe("reviewing");
      expect(store.openReviewFailure(125)?.work_owed).toBe(1);
      gated.release();
      expect(await handled).toBe(true);

      // The same round's violations ride its own anomaly.
      expect(rec.overseer).toHaveLength(1);
      expect(rec.overseer[0]).toContain("python manage.py test");
      expect(tokensIn(roundId)).toBe(10);
    });

    // MUTATION: in failPostingProof, await the measurement right after the
    // cancel — the expectations taken while the reads wait go red.
    it("a posting-receipt failure's reads wait behind its FAILED_LOUD incident", async () => {
      const roundId = reviewingRound(126);
      stampPosting(126, 1);
      const gated = gatedTranscripts(126, [modelLine(), jsonlLine(10, 1)]);
      const handled = watcher({ postingReceiptGraceS: 0, usage: gated.usage }).handleFile(
        write(126, 1, verdictFile({ pr: 126 })),
      );
      await gated.reached;
      expect(store.openReviewFailure(126)).toMatchObject({
        stage: "posting_receipt",
        work_owed: 1,
      });
      expect(store.anomalies().map((a) => a.kind)).toContain("review_failed_loud");
      gated.release();
      expect(await handled).toBe(true);
      expect(tokensIn(roundId)).toBe(10);
    });

    // A read that never returns, at the other end of the measurement: the
    // integrity re-hash walks the whole policy surface.
    // MUTATION: await the re-hash without `withinBudget` in
    // checkRoundIntegrity — this test never finishes.
    it("an integrity re-hash that never returns leaves the round UNCHECKED — the verdict applies", async () => {
      const roundId = reviewingRound(127);
      writeSessionJsonl(127, [modelLine(), jsonlLine(10, 1)]);
      store.recordRoundGitConfig(roundId, { digest: "sha256:before", files: {} });
      const hung = {
        readFile: () => new Promise<Buffer>(() => undefined),
        readDir: () => [],
        sha256: (data: string | Uint8Array) => String(data),
      };
      const w = watcher({
        integrityFingerprint: (opts) => fingerprintRoundIntegrity(opts, hung),
        integrityBudgetMs: 20,
      });
      expect(await w.handleFile(write(127, 1, verdictFile({ pr: 127, verdict: "APPROVE" })))).toBe(
        true,
      );

      expect(store.getPr(127)?.state).toBe("tracked");
      expect(tokensIn(roundId)).toBe(10);
      const unchecked = store.db
        .prepare("SELECT payload FROM events WHERE kind = 'round_integrity_unchecked' AND pr = 127")
        .get() as { payload: string } | undefined;
      expect(JSON.parse(unchecked!.payload)).toEqual({
        round_id: roundId,
        stage: "round_end",
        reason: "budget",
        budget_ms: 20,
      });
      // Unchecked is never "changed".
      expect(
        store.db
          .prepare(
            "SELECT COUNT(*) c FROM events WHERE kind IN ('git_config_modified', 'policy_surface_modified')",
          )
          .get(),
      ).toMatchObject({ c: 0 });
    });
  });

  /**
   * Every round end measures usage, not only the verdict path: a round that
   * ends any other way would otherwise carry NULL cost forever.
   * `markRoundOverdue` deliberately does not set status `expired` (that would
   * drop the round from spend and every other aggregate); `totalSpend` is
   * `SUM(est_usd) FROM rounds` with no status filter; and the stranded-round
   * operator message says "Its spend still counts." All three hold only if
   * something puts a number in the column.
   */
  describe("a round that never produced a verdict is measured too", () => {
    const priced = {
      pricing: { "gpt-5.6-sol": { input_per_mtok: 2, output_per_mtok: 8 } },
    };

    it("measures a MALFORMED round's tokens onto the round row", async () => {
      const roundId = reviewingRound(400);
      writeSessionJsonl(400, [modelLine(), jsonlLine(1_000_000, 500_000)]);

      await watcher({ usage: priced }).handleFile(
        write(400, 1, verdictFile({ pr: 400, verdict: "APPROVED" as any })),
      );

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
      // work.
      const roundId = reviewingRound(402);
      stampPosting(402, 1);
      writeSessionJsonl(402, [modelLine(), jsonlLine(750_000, 250_000)]);

      expect(
        await watcher({ postingReceiptGraceS: 0, usage: priced }).handleFile(
          write(402, 1, verdictFile({ pr: 402 })),
        ),
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
        cfg,
        store,
        adapter,
        hooks,
        verdictDir: dir,
        now: () => later,
        root: dir,
        usage: priced,
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

    expect(store.roundsFor(180)[0]).toMatchObject({
      status: "done",
      gh_review_id: 991,
      gh_commit_id: "abc123",
      posted_event: "REQUEST_CHANGES",
    });
    expect(store.getPr(180)?.state).toBe("awaiting_author");
    expect(roundId).toBe(store.roundsFor(180)[0]?.id);
  });

  // A merits verdict for a round that is already done (an archive that failed
  // and left the file in verdict/, or a session re-emitting an old round's
  // file) must not re-apply anything — labels, the lifecycle transition, or the
  // old head stamped over a newer reviewed-head mark.
  it("a replayed verdict for a round already done is inert", async () => {
    reviewingRound(184);
    const { key } = stampPosting(184, 1);
    writePostingReceipt(184, 1, key, "REQUEST_CHANGES");
    const w = watcher();
    expect(await w.handleFile(write(184, 1, verdictFile({ pr: 184 })))).toBe(true);
    // The PR moved on: a newer head was reviewed and a fresh trigger is queued.
    store.recordReviewedHead(184, { head_sha: "def456", verdict: "APPROVE", round_no: 2 });
    store.upsertPr({ ...store.getPr(184)!, state: "queued", head_sha: "def456" });
    const callsBefore = adapter.calls.length;

    expect(await w.handleFile(write(184, 1, verdictFile({ pr: 184 })))).toBe(true);

    expect(store.reviewedHead(184)).toMatchObject({ head_sha: "def456", verdict: "APPROVE" });
    expect(store.getPr(184)).toMatchObject({ state: "queued", head_sha: "def456" });
    expect(adapter.calls.length).toBe(callsBefore);
    const applied = store.db
      .prepare("SELECT COUNT(*) AS c FROM events WHERE pr = ? AND kind = 'verdict_applied'")
      .get(184) as { c: number };
    expect(applied.c).toBe(1);
  });

  // The replay guard must not strand a CRASHED apply: finishRound marks the
  // round done before the transition and the reviewed-head mark land, across
  // awaits. A done round with no `verdict_settled` record is resumed.
  it("a done round whose apply never settled (daemon killed mid-apply) is resumed", async () => {
    reviewingRound(187);
    const { key } = stampPosting(187, 1);
    writePostingReceipt(187, 1, key, "REQUEST_CHANGES");
    // The kill landed right after finishRound: nothing past it happened.
    const round = store.roundsFor(187)[0]!;
    store.finishRound(round.id, "REQUEST_CHANGES", null, null);

    expect(await watcher().handleFile(write(187, 1, verdictFile({ pr: 187 })))).toBe(true);

    expect(store.reviewedHead(187)).toMatchObject({ verdict: "REQUEST_CHANGES" });
    const settled = store.db
      .prepare("SELECT COUNT(*) AS c FROM events WHERE pr = ? AND kind = 'verdict_settled'")
      .get(187) as { c: number };
    expect(settled.c).toBe(1);
  });

  // The payload's identity must match the filename's: pr-185-round-1.json
  // naming PR 186 must never be applied to PR 186.
  it("a verdict whose payload names another PR or round than its filename is not applied", async () => {
    reviewingRound(185);
    reviewingRound(186);
    const name = write(185, 1, verdictFile({ pr: 186, round_no: 1 }));

    expect(await watcher().handleFile(name)).toBe(true);

    expect(store.roundsFor(186)[0]?.status).toBe("running");
    expect(store.getPr(186)?.state).toBe("reviewing");
    expect(store.reviewedHead(186)).toBeUndefined();
    expect(adapter.calls.filter((c) => c.includes(":186:"))).toEqual([]);
    // The filename's own round got a verdict it cannot use: the malformed path.
    expect(store.roundsFor(185)[0]?.status).not.toBe("done");
    expect(existsSync(join(dir, name))).toBe(false);
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

    expect(
      await watcher({ postingReceiptGraceS: 0 }).handleFile(
        write(182, 1, verdictFile({ pr: 182 })),
      ),
    ).toBe(true);

    expect(store.roundsFor(182)[0]).toMatchObject({ status: "cancelled", verdict: null });
    expect(store.openReviewFailure(182)).toMatchObject({ stage: "posting_receipt", work_owed: 1 });
    expect(store.reviewedHead(182)).toBeUndefined();
  });

  it("reconciles the exact bot marker after GitHub acceptance/local crash", async () => {
    reviewingRound(183);
    const { key } = stampPosting(183, 1);
    adapter.listReviewsFull = async () => [
      {
        id: 777,
        user: cfg.github.bot_login,
        user_type: "Bot",
        state: "CHANGES_REQUESTED",
        body: `review body\n\n${postingMarker(key)}`,
        commit_id: "abc123",
        submitted_at: "2026-08-13T11:59:59Z",
      },
    ];

    // The marker reconcile only runs live (dry-run never posted anything to
    // find) — the fixture ships dry_run = true, so flip it here.
    expect(
      await watcher({ cfg: { ...cfg, dry_run: false }, postingReceiptGraceS: 0 }).handleFile(
        write(183, 1, verdictFile({ pr: 183 })),
      ),
    ).toBe(true);

    expect(store.roundsFor(183)[0]).toMatchObject({
      status: "done",
      gh_review_id: 777,
      posted_event: "REQUEST_CHANGES",
    });
    expect(
      store.db
        .prepare("SELECT COUNT(*) c FROM events WHERE kind='posting_receipt_reconciled'")
        .get(),
    ).toMatchObject({ c: 1 });
  });

  // MUTATION: read every state but APPROVED/CHANGES_REQUESTED as COMMENT —
  // a dismissed review proves a withheld approval it may never have been.
  it("a marker review in a state that hides what was posted (DISMISSED) is contradicting evidence, never a COMMENT", async () => {
    reviewingRound(189);
    const { key } = stampPosting(189, 1);
    adapter.listReviewsFull = async () => [
      {
        id: 778,
        user: cfg.github.bot_login,
        user_type: "Bot",
        state: "DISMISSED",
        body: `review body\n\n${postingMarker(key)}`,
        commit_id: "abc123",
        submitted_at: "2026-08-13T11:59:59Z",
      },
    ];

    expect(
      await watcher({ cfg: { ...cfg, dry_run: false }, postingReceiptGraceS: 0 }).handleFile(
        write(189, 1, verdictFile({ pr: 189, verdict: "APPROVE", approval_withheld: true })),
      ),
    ).toBe(true);

    expect(store.roundsFor(189)[0]).toMatchObject({ status: "cancelled", verdict: null });
    expect(store.openReviewFailure(189)).toMatchObject({ stage: "posting_receipt" });
    expect(store.approvalWithheld(189)).toBeUndefined();
  });

  // The posted review is the evidence, so a round whose session stopped
  // without its verdict file is settled from the receipt — never requeued
  // (that would post twice), and never FAILED_LOUD over a review that stands
  // on GitHub.
  it("never requeues a confirmed posted review whose session lost only the verdict — it settles from the receipt", async () => {
    reviewingRound(184);
    const { key } = stampPosting(184, 1);
    writePostingReceipt(184, 1, key, "REQUEST_CHANGES");

    expect(
      await watcher().recoverInfrastructureFailure(
        184,
        1,
        "settled_without_verdict",
        "parent settled",
      ),
    ).toBe("settled");

    expect(store.roundsFor(184)[0]).toMatchObject({
      status: "done",
      verdict: "REQUEST_CHANGES",
      gh_review_id: 991,
      posted_event: "REQUEST_CHANGES",
    });
    expect(store.openReviewFailure(184)).toBeUndefined();
    expect(store.getPr(184)?.state).toBe("awaiting_author");
    expect(
      store.db.prepare("SELECT COUNT(*) c FROM events WHERE kind='round_self_requeued'").get(),
    ).toMatchObject({ c: 0 });
  });
});

// ---------------------------------------------------------------------------
// A malformed or missing verdict whose posting receipt is
// CONFIRMED is settled from the receipt; a missing receipt still fails loud.
// ---------------------------------------------------------------------------
describe("settling from a confirmed posting receipt", () => {
  const TRUNCATED = (pr: number) => `{"pr": ${pr}, "round_no": 1, "verdi`;
  const count = (kind: string, pr?: number) =>
    (
      store.db
        .prepare(
          `SELECT COUNT(*) AS c FROM events WHERE kind = ?${pr === undefined ? "" : " AND pr = ?"}`,
        )
        .get(...(pr === undefined ? [kind] : [kind, pr])) as { c: number }
    ).c;
  const settledEvent = (pr: number) =>
    JSON.parse(
      (
        store.db
          .prepare(
            "SELECT payload FROM events WHERE kind = 'verdict_settled_from_receipt' AND pr = ? ORDER BY id DESC",
          )
          .get(pr) as { payload: string }
      ).payload,
    );

  it("a malformed verdict whose APPROVE was confirmed posted settles as APPROVE — no FAILED_LOUD, no requeue", async () => {
    reviewingRound(5885);
    const { key } = stampPosting(5885, 1);
    writePostingReceipt(5885, 1, key, "APPROVE", { gh_review_id: 5449445735 });
    const { hooks, overseer } = recordingHooks();
    const name = write(5885, 1, TRUNCATED(5885));

    expect(await watcher({}, hooks).handleFile(name)).toBe(true);

    expect(store.roundsFor(5885)[0]).toMatchObject({
      status: "done",
      verdict: "APPROVE",
      gh_review_id: 5449445735,
      posted_event: "APPROVE",
    });
    expect(store.roundsFor(5885)[0]!.summary).toContain("settled from the posted review");
    expect(store.getPr(5885)?.state).toBe("tracked");
    expect(store.reviewedHead(5885)).toMatchObject({ head_sha: "abc123", verdict: "APPROVE" });
    expect(store.openReviewFailure(5885)).toBeUndefined();
    expect(count("verdict_malformed")).toBe(0);
    expect(count("round_self_requeued")).toBe(0);
    expect(store.anomalies().filter((a) => a.kind === "review_failed_loud")).toEqual([]);
    expect(overseer.some((m) => m.includes("No review was produced"))).toBe(false);
    expect(settledEvent(5885)).toMatchObject({
      via: "malformed_verdict",
      decided_verdict: "APPROVE",
      gh_review_id: 5449445735,
    });
    const applied = store.db
      .prepare("SELECT payload FROM events WHERE kind = 'verdict_applied' AND pr = 5885")
      .get() as { payload: string };
    expect(JSON.parse(applied.payload)).toMatchObject({
      source: "posting_receipt",
      via: "malformed_verdict",
    });
    // The in-progress label comes off and the reviewed label goes on — the
    // same handoff a verdict file gets; nothing is posted (no adapter write).
    expect(adapter.calls).toEqual([
      `removeLabel:5885:${cfg.github.in_progress_label}`,
      `addLabel:5885:${cfg.github.reviewed_label}`,
    ]);
    expect(existsSync(join(dir, name))).toBe(false);
  });

  it("a REQUEST_CHANGES softened to COMMENT by guard 1 settles as REQUEST_CHANGES (what the session asked for)", async () => {
    reviewingRound(186);
    const { key } = stampPosting(186, 1);
    writePostingReceipt(186, 1, key, "COMMENT", { intended_event: "REQUEST_CHANGES" });

    expect(await watcher().handleFile(write(186, 1, TRUNCATED(186)))).toBe(true);

    expect(store.roundsFor(186)[0]).toMatchObject({
      status: "done",
      verdict: "REQUEST_CHANGES",
      posted_event: "COMMENT",
    });
    expect(store.getPr(186)?.state).toBe("awaiting_author");
    expect(store.openReviewFailure(186)).toBeUndefined();
  });

  it("a COMMENT the session asked for is the templates' withheld-approval shape: APPROVE, approval withheld, and CI going green re-queues it for the SESSION to decide", async () => {
    reviewingRound(188);
    const { key } = stampPosting(188, 1);
    writePostingReceipt(188, 1, key, "COMMENT");
    adapter.listChecks = async () => [
      { name: "ci", source: "check_run", status: "in_progress", conclusion: null },
    ];

    expect(await watcher().handleFile(write(188, 1, TRUNCATED(188)))).toBe(true);

    expect(store.roundsFor(188)[0]).toMatchObject({
      status: "done",
      verdict: "APPROVE",
      gh_review_id: 991,
      posted_event: "COMMENT",
    });
    expect(store.roundsFor(188)[0]!.summary).toContain("withheld");
    expect(store.getPr(188)?.state).toBe("tracked");
    expect(store.reviewedHead(188)).toMatchObject({ head_sha: "abc123", verdict: "APPROVE" });
    // The mark is what the approval waits on — without it, CI turning green
    // would never bring the PR back.
    expect(store.approvalWithheld(188)).toMatchObject({
      head_sha: "abc123",
      reason: "red-ci",
      ci_state: "pending",
    });
    expect(store.openReviewFailure(188)).toBeUndefined();
    expect(count("round_self_requeued")).toBe(0);
    expect(settledEvent(188)).toMatchObject({
      decided_verdict: "APPROVE",
      approval_withheld: true,
      intended_event: "COMMENT",
      actual_event: "COMMENT",
    });
    // Labels only: nothing was posted and nothing was approved.
    expect(adapter.calls).toEqual([
      `removeLabel:188:${cfg.github.in_progress_label}`,
      `addLabel:188:${cfg.github.reviewed_label}`,
    ]);

    // CI goes green at the head: the ordinary withheld-approval retry
    // re-queues the PR, and the session decides again — the receipt's reading
    // never approves anything by itself.
    adapter.listChecks = async () => [
      { name: "ci", source: "check_run", status: "completed", conclusion: "success" },
    ];
    expect(
      await retryWithheldApproval({ cfg, store, adapter }, { pr: 188, head_sha: "abc123" }),
    ).toMatchObject({ action: "requeued" });
    expect(store.getPr(188)?.state).toBe("queued");
  });

  it("a COMMENT the daemon only RECONCILED from GitHub (no receipt file) is not read as a decision: malformed stays loud", async () => {
    // The shell never persisted its receipt; the marker reconcile finds the
    // bot's COMMENT. What the session ASKED for is unknown — a softened
    // REQUEST_CHANGES looks identical — so nothing is guessed.
    reviewingRound(196);
    const { key } = stampPosting(196, 1);
    adapter.listReviewsFull = async () => [
      {
        id: 778,
        user: cfg.github.bot_login,
        user_type: "Bot",
        state: "COMMENTED",
        body: `review body\n\n${postingMarker(key)}`,
        commit_id: "abc123",
        submitted_at: "2026-08-13T11:59:59Z",
      },
    ];
    const { hooks, overseer } = recordingHooks();

    expect(
      await watcher({ cfg: { ...cfg, dry_run: false } }, hooks).handleFile(
        write(196, 1, TRUNCATED(196)),
      ),
    ).toBe(true);

    expect(overseer[0]).toContain("ANOMALY (malformed)");
    expect(overseer[0]).toContain("does not say what was decided");
    expect(store.openReviewFailure(196)).toMatchObject({ stage: "malformed_verdict" });
    expect(store.reviewedHead(196)).toBeUndefined();
    expect(store.approvalWithheld(196)).toBeUndefined();
    expect(count("verdict_settled_from_receipt")).toBe(0);
  });

  it("a receipt pairing no posting script writes is not read as a decision either: the deadline keeps its loud posted_without_verdict", async () => {
    reviewingRound(197);
    const { key } = stampPosting(197, 1);
    // approve-pr.sh only ever records APPROVE→APPROVE.
    writePostingReceipt(197, 1, key, "COMMENT", { intended_event: "APPROVE" });
    const later = new Date(Date.now() + (cfg.daemon.round_deadline_min + 5) * 60_000);

    await watcher({ now: () => later }).checkDeadlines();

    expect(store.roundsFor(197)[0]).toMatchObject({
      status: "cancelled",
      cancel_cause: "infrastructure_failure",
    });
    expect(store.openReviewFailure(197)).toMatchObject({
      stage: "posted_without_verdict",
      work_owed: 1,
    });
    expect(count("round_self_requeued")).toBe(0);
    expect(count("verdict_settled_from_receipt")).toBe(0);
  });

  it("the COMMENT case settles a successor owed at the SAME head (the posted review covers it) and keeps a newer one", async () => {
    const sameId = reviewingRound(194);
    const { key } = stampPosting(194, 1);
    writePostingReceipt(194, 1, key, "COMMENT");
    store.recordSuccessor({
      pr: 194,
      predecessor_round_id: sameId,
      head_sha: "abc123",
      provenance: "human",
      reason: "trigger-while-reviewing",
    });

    expect(await watcher().handleFile(write(194, 1, TRUNCATED(194)))).toBe(true);
    expect(store.successorFor(194)).toBeUndefined();
    expect(store.getPr(194)?.state).toBe("tracked"); // nothing queued to post again

    const newerId = reviewingRound(195);
    const second = stampPosting(195, 1);
    writePostingReceipt(195, 1, second.key, "COMMENT");
    store.recordSuccessor({
      pr: 195,
      predecessor_round_id: newerId,
      head_sha: "fresh999",
      provenance: "system",
      reason: "push",
    });

    expect(await watcher().handleFile(write(195, 1, TRUNCATED(195)))).toBe(true);
    expect(store.getPr(195)).toMatchObject({ state: "queued", head_sha: "fresh999" });
  });

  it("malformed + NO receipt still fails loud exactly as before", async () => {
    const roundId = reviewingRound(189);
    stampPosting(189, 1);
    const { hooks, overseer } = recordingHooks();

    expect(await watcher({}, hooks).handleFile(write(189, 1, TRUNCATED(189)))).toBe(true);

    expect(overseer[0]).toContain("ANOMALY (malformed)");
    expect(store.getPr(189)!.state).toBe("queued");
    expect(store.openReviewFailure(189)).toMatchObject({
      stage: "malformed_verdict",
      work_owed: 1,
    });
    expect(
      (store.db.prepare("SELECT status FROM rounds WHERE id = ?").get(roundId) as any).status,
    ).toBe("overdue");
    expect(count("verdict_settled_from_receipt")).toBe(0);
  });

  it("malformed + a guard-2 refusal record settles as the guarded no-op", async () => {
    reviewingRound(190);
    const { key } = stampPosting(190, 1);
    store.recordReviewedHead(190, { head_sha: "abc123", verdict: "REQUEST_CHANGES", round_no: 0 });
    const mark = store.reviewedHead(190)!;
    const receiptDir = join(dir, "state", "posting-receipts");
    mkdirSync(receiptDir, { recursive: true });
    writeFileSync(
      join(receiptDir, "pr-190-round-1.json"),
      JSON.stringify({
        version: 1,
        posting_key: key,
        marker: postingMarker(key),
        pr: 190,
        round_no: 1,
        head_sha: "abc123",
        status: "skipped",
        skip_reason: "no-new-evidence",
        intended_event: "REQUEST_CHANGES",
        mode: "dryrun",
        skipped_at: new Date(Date.parse(mark.reviewed_at) + 1000).toISOString(),
        standing_mark: {
          head_sha: mark.head_sha,
          reviewed_at: mark.reviewed_at,
          verdict: mark.verdict,
          posted_event: mark.posted_event,
          round_no: mark.round_no,
          last_author_reply_at: mark.last_author_reply_at,
        },
      }),
    );

    expect(await watcher().handleFile(write(190, 1, TRUNCATED(190)))).toBe(true);

    expect(store.roundsFor(190)[0]).toMatchObject({
      status: "cancelled",
      cancel_cause: "no_new_evidence",
    });
    expect(store.openReviewFailure(190)).toBeUndefined();
    expect(store.getPr(190)?.state).toBe("awaiting_author");
  });

  it("a malformed file arriving AFTER the round settled from its receipt replays inertly — no FAILED_LOUD over a settled round", async () => {
    reviewingRound(191);
    const { key } = stampPosting(191, 1);
    writePostingReceipt(191, 1, key, "REQUEST_CHANGES");
    const w = watcher();
    expect(await w.recoverInfrastructureFailure(191, 1, "settled_without_verdict", "x")).toBe(
      "settled",
    );
    const stateBefore = store.getPr(191)?.state;

    expect(await w.handleFile(write(191, 1, TRUNCATED(191)))).toBe(true);

    expect(store.getPr(191)?.state).toBe(stateBefore);
    expect(store.openReviewFailure(191)).toBeUndefined();
    expect(count("verdict_malformed")).toBe(0);
    expect(count("verdict_replay_ignored", 191)).toBe(1);
    // …and a late VALID file is the same inert replay.
    expect(await w.handleFile(write(191, 1, verdictFile({ pr: 191 })))).toBe(true);
    expect(count("verdict_applied", 191)).toBe(1);
  });

  it("the deadline: a confirmed receipt with no verdict file settles from the receipt (was FAILED_LOUD posted_without_verdict)", async () => {
    reviewingRound(192);
    const { key } = stampPosting(192, 1);
    writePostingReceipt(192, 1, key, "APPROVE");
    const later = new Date(Date.now() + (cfg.daemon.round_deadline_min + 5) * 60_000);

    expect(await watcher({ now: () => later }).checkDeadlines()).toEqual([]);

    expect(store.roundsFor(192)[0]).toMatchObject({ status: "done", verdict: "APPROVE" });
    expect(store.openReviewFailure(192)).toBeUndefined();
    expect(settledEvent(192)).toMatchObject({ via: "deadline", decided_verdict: "APPROVE" });
  });

  it("the deadline with NO receipt still fails loud after grace, exactly as before", async () => {
    reviewingRound(193);
    stampPosting(193, 1);
    const later = new Date(Date.now() + (cfg.daemon.round_deadline_min + 5) * 60_000);

    await watcher({ now: () => later }).checkDeadlines();

    expect(store.roundsFor(193)[0]).toMatchObject({
      status: "cancelled",
      cancel_cause: "infrastructure_failure",
    });
    expect(store.openReviewFailure(193)).toMatchObject({ stage: "posting_receipt", work_owed: 1 });
  });

  it("a VALID verdict landing after a deadline settlement — a newer round already running — replays inertly and touches nothing", async () => {
    const first = reviewingRound(198);
    const { key } = stampPosting(198, 1);
    writePostingReceipt(198, 1, key, "COMMENT");
    const later = new Date(Date.now() + (cfg.daemon.round_deadline_min + 5) * 60_000);
    const w = watcher({ now: () => later });
    await w.checkDeadlines();
    expect(store.roundsFor(198).find((r) => r.id === first)).toMatchObject({
      status: "done",
      verdict: "APPROVE",
    });

    // The PR moves on: round 2 runs at a fresh head.
    store.upsertPr({
      number: 198,
      state: "reviewing",
      head_sha: "fresh999",
      title: "PR 198",
      author: "alice",
      trigger_ts: null,
      stale_recheck: 0,
      migration_gate: 0,
    });
    const second = store.startRound(
      198,
      "re-review",
      ["pass-baseline"],
      cfg.daemon.round_deadline_min,
    );
    adapter.calls.length = 0;
    const mark = store.reviewedHead(198);
    const withheld = store.approvalWithheld(198);
    const successor = store.successorFor(198);

    // The session's own verdict for round 1 finally lands.
    expect(
      await w.handleFile(
        write(198, 1, verdictFile({ pr: 198, verdict: "APPROVE", approval_withheld: true })),
      ),
    ).toBe(true);

    expect(store.roundsFor(198).find((r) => r.id === second)?.status).toBe("running");
    expect(store.getPr(198)).toMatchObject({ state: "reviewing", head_sha: "fresh999" });
    expect(store.reviewedHead(198)).toEqual(mark);
    expect(store.approvalWithheld(198)).toEqual(withheld);
    expect(store.successorFor(198)).toEqual(successor);
    expect(adapter.calls).toEqual([]); // the running round keeps its in-progress label
    expect(count("verdict_replay_ignored", 198)).toBe(1);
    expect(count("verdict_applied", 198)).toBe(1);
  });

  it("a round the operator cancelled while the settlement awaited GitHub is never applied over", async () => {
    const roundId = reviewingRound(199);
    const { key } = stampPosting(199, 1);
    adapter.listReviewsFull = async () => {
      // The operator's `u` lands while the marker reconcile reads GitHub.
      store.markRoundCancelled(roundId, "operator rerun", "operator");
      return [
        {
          id: 779,
          user: cfg.github.bot_login,
          user_type: "Bot",
          state: "APPROVED",
          body: `review body\n\n${postingMarker(key)}`,
          commit_id: "abc123",
          submitted_at: "2026-08-13T11:59:59Z",
        },
      ];
    };

    expect(
      await watcher({ cfg: { ...cfg, dry_run: false } }).handleFile(write(199, 1, TRUNCATED(199))),
    ).toBe(true);

    expect(store.roundsFor(199)[0]).toMatchObject({
      status: "cancelled",
      cancel_cause: "operator",
      verdict: null,
    });
    expect(count("verdict_settled_from_receipt_replayed", 199)).toBe(1);
    expect(count("verdict_settled_from_receipt", 199)).toBe(0);
    expect(count("verdict_applied", 199)).toBe(0);
    expect(store.reviewedHead(199)).toBeUndefined();
  });

  /** A daemon killed inside `apply`: the round row is finished, nothing after
   * it is (the transition, the marks, `verdict_settled`). */
  function crashOnceAfterFinishRound(): void {
    const real = store.finishRound.bind(store);
    let crash = true;
    store.finishRound = ((...args: Parameters<StateStore["finishRound"]>) => {
      const claimed = real(...args);
      if (crash) {
        crash = false;
        throw new Error("daemon killed mid-apply");
      }
      return claimed;
    }) as StateStore["finishRound"];
  }

  it("a receipt settlement a restart cut short is RESUMED — on the malformed path its broken file never turns into FAILED_LOUD", async () => {
    reviewingRound(200);
    const { key } = stampPosting(200, 1);
    writePostingReceipt(200, 1, key, "APPROVE");
    const name = write(200, 1, TRUNCATED(200));
    crashOnceAfterFinishRound();
    const { hooks, overseer } = recordingHooks();

    await expect(watcher({}, hooks).handleFile(name)).rejects.toThrow("daemon killed mid-apply");
    expect(store.roundsFor(200)[0]?.status).toBe("done");
    expect(store.getPr(200)?.state).toBe("reviewing");
    expect(existsSync(join(dir, name))).toBe(true); // the broken file is still there

    // The restarted daemon's sweep meets the same broken file.
    expect(await watcher({}, hooks).handleFile(name)).toBe(true);

    expect(store.openReviewFailure(200)).toBeUndefined();
    expect(overseer.filter((m) => m.includes("ANOMALY"))).toEqual([]);
    expect(store.getPr(200)?.state).toBe("tracked");
    expect(store.reviewedHead(200)).toMatchObject({ head_sha: "abc123", verdict: "APPROVE" });
    expect(count("verdict_settled_from_receipt_resumed", 200)).toBe(1);
    expect(count("verdict_settled", 200)).toBe(1);
    expect(existsSync(join(dir, name))).toBe(false);
    // Settled now: the next replay is inert.
    expect(await watcher().handleFile(write(200, 1, TRUNCATED(200)))).toBe(true);
    expect(count("verdict_applied", 200)).toBe(1);
  });

  it("…and with NO file (the deadline path) the next sweep resumes it, once", async () => {
    reviewingRound(201);
    const { key } = stampPosting(201, 1);
    writePostingReceipt(201, 1, key, "REQUEST_CHANGES");
    const later = new Date(Date.now() + (cfg.daemon.round_deadline_min + 5) * 60_000);
    crashOnceAfterFinishRound();

    await watcher({ now: () => later })
      .checkDeadlines()
      .catch(() => undefined);
    expect(store.roundsFor(201)[0]?.status).toBe("done");
    expect(store.getPr(201)?.state).toBe("reviewing"); // the transition never ran
    expect(count("verdict_settled", 201)).toBe(0);

    await watcher({ now: () => later }).sweep();

    expect(store.getPr(201)?.state).toBe("awaiting_author");
    expect(store.reviewedHead(201)).toMatchObject({ verdict: "REQUEST_CHANGES" });
    expect(store.openReviewFailure(201)).toBeUndefined();
    expect(count("verdict_settled_from_receipt_resumed", 201)).toBe(1);
    expect(count("verdict_settled", 201)).toBe(1);

    await watcher({ now: () => later }).sweep();
    expect(count("verdict_settled_from_receipt_resumed", 201)).toBe(1);
    expect(count("verdict_applied", 201)).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// Every stage limit asks the receipt first.
// ---------------------------------------------------------------------------
describe("receipt-aware stage limits", () => {
  // The receipt helper confirms at 2026-08-13T11:59:59Z.
  const at = (iso: string) => () => new Date(iso);
  const killed: number[] = [];
  const killingHooks = (): SessionHooks => {
    const { hooks } = recordingHooks();
    killed.length = 0;
    hooks.killSession = async (pr) => {
      killed.push(pr);
    };
    return hooks;
  };

  for (const stage of [
    "parent_finalize",
    "passes_incomplete",
    "first_pass_start",
    "running_hard_bound",
  ] as const) {
    it(`${stage} after a CONFIRMED posting waits for the tail: nothing cancelled, killed or requeued`, async () => {
      reviewingRound(300);
      const { key } = stampPosting(300, 1);
      writePostingReceipt(300, 1, key, "REQUEST_CHANGES");
      const hooks = killingHooks();
      const w = watcher({ now: at("2026-08-13T12:01:19Z") }, hooks);

      expect(await w.recoverInfrastructureFailure(300, 1, stage, "limit")).toBe("posted_wait");
      expect(await w.recoverInfrastructureFailure(300, 1, stage, "limit")).toBe("posted_wait");

      expect(store.roundsFor(300)[0]).toMatchObject({ status: "running" });
      expect(killed).toEqual([]);
      expect(store.getPr(300)?.state).toBe("reviewing");
      const waits = store.db
        .prepare("SELECT payload FROM events WHERE kind = 'round_stage_posted_wait'")
        .all() as Array<{ payload: string }>;
      expect(waits).toHaveLength(1); // logged once, not once per scan
      expect(JSON.parse(waits[0]!.payload)).toMatchObject({
        stage,
        wait_until: "2026-08-13T12:14:59.000Z", // confirmed_at + 15 min
      });
      for (const kind of ["round_infrastructure_failure", "round_self_requeued"]) {
        expect(
          (store.db.prepare("SELECT COUNT(*) c FROM events WHERE kind = ?").get(kind) as any).c,
        ).toBe(0);
      }
    });
  }

  it("past the posted-tail grace with still no verdict, the round settles from the receipt — never a second posting", async () => {
    reviewingRound(301);
    const { key } = stampPosting(301, 1);
    writePostingReceipt(301, 1, key, "REQUEST_CHANGES");
    const hooks = killingHooks();

    expect(
      await watcher({ now: at("2026-08-13T12:15:00Z") }, hooks).recoverInfrastructureFailure(
        301,
        1,
        "parent_finalize",
        "all passes terminal for 5 minutes",
      ),
    ).toBe("settled");

    expect(store.roundsFor(301)).toHaveLength(1);
    expect(store.roundsFor(301)[0]).toMatchObject({
      status: "done",
      verdict: "REQUEST_CHANGES",
      gh_review_id: 991,
    });
    expect(store.getPr(301)?.state).toBe("awaiting_author");
    expect(store.openReviewFailure(301)).toBeUndefined();
    expect(killed).toEqual([]); // the supervisor releases the slot, not this callback
  });

  it("a verdict file on disk is the sweep's: the stage limit defers, whatever the receipt says", async () => {
    reviewingRound(302);
    const { key } = stampPosting(302, 1);
    writePostingReceipt(302, 1, key, "REQUEST_CHANGES");
    write(302, 1, '{"pr": 302, "round_no": 1, "verd'); // still being written

    expect(
      await watcher({ now: at("2026-08-13T12:30:00Z") }).recoverInfrastructureFailure(
        302,
        1,
        "parent_finalize",
        "x",
      ),
    ).toBe("retryable");
    expect(store.roundsFor(302)[0]?.status).toBe("running");
  });

  it("a POST still inside its ambiguous window (prepared receipt) is waited out, never killed mid-post", async () => {
    reviewingRound(303);
    const { key } = stampPosting(303, 1);
    writePostingReceipt(303, 1, key, "REQUEST_CHANGES", {
      status: "prepared",
      prepared_at: "2026-08-13T12:00:00Z",
      confirmed_at: undefined,
      gh_review_id: undefined,
      gh_commit_id: undefined,
      gh_state: undefined,
    });
    const hooks = killingHooks();

    expect(
      await watcher({ now: at("2026-08-13T12:01:00Z") }, hooks).recoverInfrastructureFailure(
        303,
        1,
        "parent_finalize",
        "x",
      ),
    ).toBe("retryable");
    expect(killed).toEqual([]);
    expect(store.roundsFor(303)[0]?.status).toBe("running");
  });

  it("NO receipt: the stage limit cancels and self-requeues exactly as before", async () => {
    reviewingRound(304);
    stampPosting(304, 1);
    const hooks = killingHooks();

    expect(
      await watcher({ now: at("2026-08-13T12:30:00Z") }, hooks).recoverInfrastructureFailure(
        304,
        1,
        "parent_finalize",
        "all passes terminal for 5 minutes",
      ),
    ).toBe("requeued");

    expect(store.roundsFor(304)[0]).toMatchObject({
      status: "cancelled",
      cancel_cause: "infrastructure_failure",
    });
    expect(killed).toEqual([304]);
    expect(store.getPr(304)?.state).toBe("queued");
  });

  it("a deferred posting that is exhausted by the time the session is killed is never requeued over", async () => {
    reviewingRound(307);
    const { key } = stampPosting(307, 1);
    const { hooks } = recordingHooks();
    killed.length = 0;
    hooks.killSession = async (pr) => {
      killed.push(pr);
      // The receipt changes while the session is being stopped: a deferred
      // POST whose retry is over (no outbox job on record).
      writePostingReceipt(307, 1, key, "REQUEST_CHANGES", {
        status: "deferred",
        deferred_at: "2026-08-13T12:00:00.000Z",
        gh_review_id: undefined,
        gh_commit_id: undefined,
        gh_state: undefined,
      });
    };

    expect(
      await watcher(
        { cfg: { ...cfg, dry_run: false }, now: at("2026-08-13T12:30:00Z") },
        hooks,
      ).recoverInfrastructureFailure(307, 1, "parent_finalize", "all passes terminal"),
    ).toBe("retryable");

    expect(killed).toEqual([307]);
    expect(store.roundsFor(307)).toHaveLength(1);
    expect(store.roundsFor(307)[0]).toMatchObject({ status: "running" });
    expect(
      (
        store.db
          .prepare("SELECT COUNT(*) c FROM events WHERE kind = 'round_self_requeued'")
          .get() as any
      ).c,
    ).toBe(0);
  });

  it("a posting-proof failure that cannot open its incident leaves the round running, not cancelled", async () => {
    reviewingRound(308);
    stampPosting(308, 1);
    const round = store.roundsFor(308)[0]!;
    const open = store.openReviewFailure.bind(store);
    store.openReviewFailure = () => {
      throw new Error("database is locked");
    };
    await expect(
      (watcher() as any).failPostingProof(round, "receipt contradicted"),
    ).rejects.toThrow("database is locked");
    store.openReviewFailure = open;

    expect(store.roundsFor(308)[0]).toMatchObject({ status: "running" });
    expect(store.openReviewFailure(308)).toBeUndefined();
  });

  it("a self-requeue that cannot record its measurement debt leaves the round running, not cancelled", async () => {
    reviewingRound(309);
    stampPosting(309, 1);
    const hooks = killingHooks();
    const owe = store.oweRoundMeasurement.bind(store);
    store.oweRoundMeasurement = () => {
      throw new Error("database is locked");
    };
    await expect(
      watcher({ now: at("2026-08-13T12:30:00Z") }, hooks).recoverInfrastructureFailure(
        309,
        1,
        "parent_finalize",
        "all passes terminal",
      ),
    ).rejects.toThrow("database is locked");
    store.oweRoundMeasurement = owe;

    expect(store.roundsFor(309)[0]).toMatchObject({ status: "running" });
  });

  it("the posted-tail grace is a config knob", async () => {
    reviewingRound(305);
    const { key } = stampPosting(305, 1);
    writePostingReceipt(305, 1, key, "APPROVE");
    const short = { ...cfg, daemon: { ...cfg.daemon, round_posted_tail_grace_min: 1 } };

    expect(
      await watcher({ cfg: short, now: at("2026-08-13T12:01:00Z") }).recoverInfrastructureFailure(
        305,
        1,
        "parent_finalize",
        "x",
      ),
    ).toBe("settled");
    expect(store.roundsFor(305)[0]).toMatchObject({ status: "done", verdict: "APPROVE" });
  });

  it("past the grace with a receipt that does not say what was decided: loud posted_without_verdict — never a requeue, never a kill", async () => {
    reviewingRound(306);
    const { key } = stampPosting(306, 1);
    // A pairing no posting script writes (approve-pr.sh records APPROVE→APPROVE).
    writePostingReceipt(306, 1, key, "COMMENT", { intended_event: "APPROVE" });
    const hooks = killingHooks();

    expect(
      await watcher({ now: at("2026-08-13T12:01:19Z") }, hooks).recoverInfrastructureFailure(
        306,
        1,
        "parent_finalize",
        "x",
      ),
    ).toBe("posted_wait");
    expect(
      await watcher({ now: at("2026-08-13T12:15:00Z") }, hooks).recoverInfrastructureFailure(
        306,
        1,
        "parent_finalize",
        "x",
      ),
    ).toBe("failed_loud");

    expect(store.roundsFor(306)).toHaveLength(1);
    expect(store.roundsFor(306)[0]).toMatchObject({
      status: "cancelled",
      cancel_cause: "infrastructure_failure",
    });
    expect(store.openReviewFailure(306)).toMatchObject({ stage: "posted_without_verdict" });
    expect(killed).toEqual([]);
    expect(
      (
        store.db
          .prepare("SELECT COUNT(*) c FROM events WHERE kind = 'round_self_requeued'")
          .get() as any
      ).c,
    ).toBe(0);
  });

  it("NO receipt but a verdict file on disk: the limit defers to the sweep — and once the file is gone, the old path runs", async () => {
    // A deliberate widening (docs/health-fixes-2026-10-08.md): the session
    // has finished, and cancelling the round under its own verdict file would
    // only land that verdict on a cancelled round.
    reviewingRound(307);
    stampPosting(307, 1);
    const hooks = killingHooks();
    const name = write(307, 1, verdictFile({ pr: 307 }));
    const w = watcher({ now: at("2026-08-13T12:30:00Z") }, hooks);

    expect(await w.recoverInfrastructureFailure(307, 1, "parent_finalize", "x")).toBe("retryable");
    expect(store.roundsFor(307)[0]?.status).toBe("running");
    expect(killed).toEqual([]);

    rmSync(join(dir, name));
    expect(await w.recoverInfrastructureFailure(307, 1, "parent_finalize", "x")).toBe("requeued");
    expect(store.roundsFor(307)[0]).toMatchObject({
      status: "cancelled",
      cancel_cause: "infrastructure_failure",
    });
    expect(killed).toEqual([307]);
  });

  it("the no-receipt deferral is bounded by the sweep: one sweep consumes the file and the round stops deferring", async () => {
    reviewingRound(308);
    stampPosting(308, 1);
    const name = write(308, 1, '{"pr": 308, "round_no": 1, "verd');
    const w = watcher({ now: at("2026-08-13T12:30:00Z") }, killingHooks());

    expect(await w.recoverInfrastructureFailure(308, 1, "parent_finalize", "x")).toBe("retryable");
    await w.sweep();

    expect(existsSync(join(dir, name))).toBe(false); // consumed (malformed, no receipt: loud)
    expect(store.roundsFor(308)[0]?.status).not.toBe("running");
    expect(store.openReviewFailure(308)).toMatchObject({ stage: "malformed_verdict" });
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
    const round = store.db
      .prepare("SELECT status, verdict FROM rounds WHERE id = ?")
      .get(roundId) as any;
    expect(round.status).toBe("overdue");
    expect(round.verdict).toBeNull();
    expect(
      store.db.prepare("SELECT COUNT(*) AS c FROM events WHERE kind = 'verdict_malformed'").get(),
    ).toMatchObject({ c: 1 });
    // The durable anomaly record rides beside the inject file.
    const anomalies = store.anomalies();
    expect(anomalies).toHaveLength(1);
    expect(anomalies[0]).toMatchObject({ kind: "malformed", pr: 200, round_no: 1 });
    expect(anomalies[0]!.detail).toContain("malformed verdict file");
  });

  it("a malformed old-head round promotes durable fresh-head work instead of erasing it", async () => {
    const roundId = reviewingRound(204);
    store.recordSuccessor({
      pr: 204,
      predecessor_round_id: roundId,
      head_sha: "fresh",
      provenance: "system",
      reason: "push",
    });
    const { hooks } = recordingHooks();

    await watcher({}, hooks).handleFile(write(204, 1, '{"pr":204,"round_no":1,"verdict":"MAYBE"'));

    expect(store.getPr(204)).toMatchObject({
      state: "queued",
      head_sha: "fresh",
      trigger_provenance: "system",
    });
    expect(store.successorFor(204)?.head_sha).toBe("fresh");
  });

  it("a verdict value outside the enum is malformed, never applied", async () => {
    reviewingRound(201);
    const { hooks, overseer } = recordingHooks();
    await watcher({}, hooks).handleFile(
      write(201, 1, verdictFile({ pr: 201, verdict: "APPROVED" as any })),
    );
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
    const roundId = overdueStore.startRound(
      300,
      "first",
      ["pass-baseline"],
      cfg.daemon.round_deadline_min,
    );
    clock = later;
    const { hooks, overseer } = recordingHooks();
    wireWake(overdueStore, hooks);
    const w = new VerdictWatcher({
      cfg,
      store: overdueStore,
      adapter,
      hooks,
      verdictDir: dir,
      now: () => clock,
      root: dir,
      usage: {},
    });

    expect(await w.checkDeadlines()).toEqual([300]);
    expect(overseer[0]).toContain("ANOMALY (overdue)");
    // The durable anomaly record rides beside the inject file.
    expect(overdueStore.anomalies()).toMatchObject([{ kind: "overdue", pr: 300, round_no: 1 }]);
    expect(overdueStore.getPr(300)!.state).toBe("queued");
    expect(overdueStore.openReviewFailure(300)?.stage).toBe("round_deadline");
    expect(
      (overdueStore.db.prepare("SELECT status FROM rounds WHERE id = ?").get(roundId) as any)
        .status,
    ).toBe("overdue");
    // No reviewer nomination anywhere on the anomaly path either.
    expect(
      adapter.calls.every((c) => c.startsWith("addLabel") || c.startsWith("removeLabel")),
    ).toBe(true);
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
    // An expired phantom round must not yank the PR's state while a newer
    // round is actively running.
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
    const w = new VerdictWatcher({
      cfg,
      store: s,
      adapter,
      hooks,
      verdictDir: dir,
      now: () => clock,
      root: dir,
      usage: {},
    });

    expect(await w.checkDeadlines()).toEqual([]);
    expect(
      (s.db.prepare("SELECT status, summary FROM rounds WHERE id = ?").get(oldId) as any).status,
    ).toBe("cancelled");
    expect((s.db.prepare("SELECT status FROM rounds WHERE id = ?").get(newId) as any).status).toBe(
      "running",
    );
    expect(s.getPr(4844)!.state).toBe("reviewing"); // the live round keeps the PR
    expect(overseer).toHaveLength(0); // no anomaly, no escalation
    expect(adapter.calls).toEqual([]); // no label yank, no human request
    s.close();
  });
});

// Single-shepherd wiring (docs/single-shepherd-invariant.md): a wake held
// while the round ran must actually reach the session once the round ends.
// wakes.ts is unit-tested on its own; these prove the WATCHER calls it.
describe("held wakes are flushed at round end", () => {
  it("delivers them after a verdict is applied", async () => {
    const roundId = reviewingRound(100);
    // A fresh ledger keeps the post-round ledger re-nudge out of this test's injects.
    mkdirSync(join(dir, "state", "ledgers"), { recursive: true });
    writeFileSync(join(dir, "state", "ledgers", "pr-100.md"), "LEDGER PR #100 @ abc123\n");
    store.holdWake(100, "author says: fixed in abc123", "author_reply");
    const { hooks, injects } = recordingHooks();

    write(100, 1, verdictFile({ verdict: "APPROVE" }));
    await watcher({}, hooks).sweep();

    expect(
      (
        store.db.prepare("SELECT status FROM rounds WHERE id = ?").get(roundId) as {
          status: string;
        }
      ).status,
    ).toBe("done");
    expect(injects).toEqual(["100:author says: fixed in abc123"]);
    expect(store.heldWakes(100)).toHaveLength(0);
  });

  it("keeps them behind FAILED_LOUD work when the round is abandoned as overdue", async () => {
    const later = new Date(Date.now() + (cfg.daemon.round_deadline_min + 10) * 60_000);
    reviewingRound(101);
    store.holdWake(101, "author says: ping", "author_reply");
    const { hooks, injects } = recordingHooks();
    wireWake(store, hooks);
    const w = new VerdictWatcher({
      cfg,
      store,
      adapter,
      hooks,
      verdictDir: dir,
      now: () => later,
      root: dir,
      usage: {},
    });

    expect(await w.checkDeadlines()).toEqual([101]);
    expect(injects).toEqual([]);
    expect(store.heldWakes(101)).toHaveLength(1);
    expect(store.openReviewFailure(101)?.work_owed).toBe(1);

    // MUTATION: drop the failure check in flushStrandedWakes — the next
    // tick's stranded-wake sweep delivers them over the owed review.
    expect(await w.checkDeadlines()).toEqual([]);
    expect(injects).toEqual([]);
    expect(store.heldWakes(101)).toHaveLength(1);
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
    expect(
      store.db
        .prepare("SELECT COUNT(*) AS c FROM events WHERE kind = 'approval_withheld_red_ci'")
        .get(),
    ).toEqual({ c: 1 });
  });

  it("stamps ci_state on the mark when the adapter can read checks", async () => {
    reviewingRound(100);
    adapter.listChecks = async (ref: string) => {
      expect(ref).toBe("abc123");
      return [{ name: "ci", source: "check_run", status: "completed", conclusion: "failure" }];
    };
    const name = write(100, 1, verdictFile({ verdict: "APPROVE", approval_withheld: true }));

    await watcher().handleFile(name);

    expect(store.approvalWithheld(100)).toMatchObject({
      head_sha: "abc123",
      reason: "red-ci",
      ci_state: "red",
    });
  });

  it("a delayed CI read cannot replace the successor verdict's withheld mark", async () => {
    reviewingRound(750);
    let release!: () => void;
    let reached!: () => void;
    const entered = new Promise<void>((r) => {
      reached = r;
    });
    const held = new Promise<void>((r) => {
      release = r;
    });
    adapter.listChecks = async () => {
      reached();
      await held;
      return [{ name: "old-ci", source: "check_run", status: "completed", conclusion: "failure" }];
    };
    const oldApply = watcher().handleFile(
      write(750, 1, verdictFile({ pr: 750, verdict: "APPROVE", approval_withheld: true })),
    );
    await entered;
    let newer: ReturnType<StateStore["approvalWithheld"]>;
    try {
      store.cancelRunningRounds(750, "rerun-round");
      reviewingRound(750);
      store.upsertPr({ ...store.getPr(750)!, head_sha: "new222" });
      await watcher({ adapter: new FakeAdapter() }).handleFile(
        write(
          750,
          2,
          verdictFile({
            pr: 750,
            round_no: 2,
            head_sha: "new222",
            verdict: "APPROVE",
            approval_withheld: true,
          }),
        ),
      );
      newer = store.approvalWithheld(750);
      expect(newer?.head_sha).toBe("new222");
    } finally {
      release();
      await oldApply;
    }
    expect(store.approvalWithheld(750)).toEqual(newer);
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
    const name = write(
      100,
      1,
      verdictFile({ verdict: "REQUEST_CHANGES", approval_withheld: true }),
    );

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
    for (const f of [
      "verdicts.ts",
      "statemachine.ts",
      "webhook.ts",
      "dispatch.ts",
      "reconcile.ts",
      "daemon.ts",
      "stubs.ts",
    ]) {
      expect(forbidden.test(readFileSync(resolve(process.cwd(), "src", f), "utf8"))).toBe(false);
    }
  });

  // One deliberate hole: feedback.ts names GitHub's own
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
    expect(
      validateVerdict({
        pr: "abc",
        round_no: 1,
        verdict: "APPROVE",
        head_sha: "x",
        finished_at: "y",
      }).ok,
    ).toBe(false);
  });
});

describe("executed-pass telemetry", () => {
  it("validateVerdict normalizes a passes array tolerantly: aliases, digit-strings, dropped junk", () => {
    const parsed = validateVerdict(
      verdictFile({
        passes: [
          { name: "pass-baseline", tier: "sol-med", findings: "3" },
          {
            lens: "pass-validate",
            tier: " sol-high ",
            candidates: 5,
            survived: "2",
            killed: 1,
            downgraded: 0,
          },
          { tier: "sol-med" }, // nameless — dropped, never fatal
          "garbage",
        ] as never,
      }),
    );
    expect(parsed.ok).toBe(true);
    expect(parsed.passes_note).toContain("dropped");
    expect(parsed.verdict?.passes).toEqual([
      {
        name: "pass-baseline",
        tier: "sol-med",
        findings: 3,
        survived: null,
        killed: null,
        downgraded: null,
        merged: null,
        folded: null,
      },
      {
        name: "pass-validate",
        tier: "sol-high",
        findings: 5,
        survived: 2,
        killed: 1,
        downgraded: 0,
        merged: null,
        folded: null,
      },
    ]);
  });

  // Merge-stage dispositions ride the same tolerant normalization —
  // additive fields, digit-strings coerce, absence stays null (unknown).
  it("normalizes merge-stage disposition counts (merged/folded) additively", () => {
    const parsed = validateVerdict(
      verdictFile({
        passes: [
          {
            name: "pass-validate",
            tier: "sol-med",
            findings: 0,
            survived: "2",
            killed: 1,
            downgraded: 0,
            merged: "1",
            folded: 2,
          },
        ] as never,
      }),
    );
    expect(parsed.ok).toBe(true);
    expect(parsed.verdict?.passes).toEqual([
      {
        name: "pass-validate",
        tier: "sol-med",
        findings: 0,
        survived: 2,
        killed: 1,
        downgraded: 0,
        merged: 1,
        folded: 2,
      },
    ]);
    // A verdict without the fields is still clean — no note.
    const old = validateVerdict(
      verdictFile({ passes: [{ name: "pass-validate", killed: 1 }] as never }),
    );
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
      {
        name: "pass-validate",
        tier: "sol-med",
        findings: 0,
        survived: 1,
        killed: 1,
        downgraded: 0,
      },
    ];
    await watcher({}, hooks).handleFile(write(200, 1, verdictFile({ pr: 200, passes })));
    expect(store.executedPasses(roundId)).toMatchObject(passes);
    // The plan column is untouched — executed is a second record, not an edit.
    const round = store.db.prepare("SELECT lenses FROM rounds WHERE id = ?").get(roundId) as {
      lenses: string;
    };
    expect(round.lenses).toBe("pass-baseline,pass-validate");
    expect(
      store.db.prepare("SELECT COUNT(*) AS c FROM events WHERE kind = 'pass_plan_mismatch'").get(),
    ).toMatchObject({ c: 0 });
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
    expect(
      (store.db.prepare("SELECT status, verdict FROM rounds WHERE id = ?").get(roundId) as any)
        .status,
    ).toBe("done");
    const payload = JSON.parse(
      (
        store.db.prepare("SELECT payload FROM events WHERE kind = 'pass_plan_mismatch'").get() as {
          payload: string;
        }
      ).payload,
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
    await watcher({}, hooks).handleFile(
      write(
        204,
        1,
        verdictFile({
          pr: 204,
          passes: [
            { name: "pass-baseline", tier: "sol-high", findings: 0 },
            {
              name: "pass-concurrency",
              tier: "sol-med",
              reason: "added: read-then-write claim race",
              findings: 1,
            },
            { name: "pass-validate", tier: "sol-high", findings: 1 },
          ],
        }),
      ),
    );
    expect(
      store.db.prepare("SELECT COUNT(*) AS c FROM events WHERE kind = 'pass_plan_mismatch'").get(),
    ).toMatchObject({ c: 0 });
    const event = store.db
      .prepare("SELECT payload FROM events WHERE kind = 'pass_plan_conformant_addition'")
      .get() as { payload: string };
    expect(JSON.parse(event.payload).additions).toEqual([
      { name: "pass-concurrency", tier: "sol-med", reason: "added: read-then-write claim race" },
    ]);
    expect(overseer).toEqual([]);
  });

  it("flags unknown, wrong-tier, and unexplained additions under the dispatched policy", async () => {
    const { hooks } = recordingHooks();
    policyRound(205);
    await watcher({}, hooks).handleFile(
      write(
        205,
        1,
        verdictFile({
          pr: 205,
          passes: [
            { name: "pass-baseline", tier: "sol-med", findings: 0 },
            { name: "pass-concurrency", tier: "sol-high", findings: 0 },
            { name: "pass-mystery", tier: "sol-med", reason: "because", findings: 0 },
            { name: "pass-validate", tier: "sol-high", findings: 0 },
          ],
        }),
      ),
    );
    const event = store.db
      .prepare("SELECT payload FROM events WHERE kind = 'pass_plan_mismatch'")
      .get() as { payload: string };
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
      (
        store.db.prepare("SELECT payload FROM events WHERE kind = 'pass_plan_mismatch'").get() as {
          payload: string;
        }
      ).payload,
    );
    expect(payload.missing).toEqual(["pass-baseline", "pass-validate"]);
    expect(overseer[0]).toContain("solo/degraded round");
  });

  it("an old-prompt verdict with no passes stays UNKNOWN: logged, null record, verdict applied", async () => {
    const { hooks, overseer } = recordingHooks();
    const roundId = reviewingRound(203);
    await watcher({}, hooks).handleFile(
      write(203, 1, verdictFile({ pr: 203, verdict: "APPROVE" })),
    );
    expect(store.getPr(203)!.state).toBe("tracked");
    expect(store.executedPasses(roundId)).toBeNull();
    expect(
      store.db
        .prepare("SELECT COUNT(*) AS c FROM events WHERE kind = 'verdict_passes_unknown'")
        .get(),
    ).toMatchObject({ c: 1 });
    expect(
      store.db.prepare("SELECT COUNT(*) AS c FROM events WHERE kind = 'pass_plan_mismatch'").get(),
    ).toMatchObject({ c: 0 });
    expect(overseer).toEqual([]);
  });
});

// Durability: a head that advances while the round runs chains a system
// re-trigger at verdict time — the delta classifier then decides full-round vs
// short-circuit. Never on a park.
describe("mid-round head advance chains a system re-trigger", () => {
  it("head moved while reviewing ⇒ event + queued with system provenance", async () => {
    reviewingRound(400);
    const row = store.getPr(400)!;
    // The author pushes while the round is in flight (reconcile updates head).
    store.upsertPr({ ...row, head_sha: "def456" });
    await watcher().handleFile(
      write(400, 1, verdictFile({ pr: 400, verdict: "REQUEST_CHANGES", head_sha: "abc123" })),
    );

    const after = store.getPr(400)!;
    expect(after.state).toBe("queued");
    expect(after.trigger_provenance).toBe("system");
    const ev = store.db
      .prepare("SELECT payload FROM events WHERE kind = 'mid_round_head_advance'")
      .get() as { payload: string };
    expect(JSON.parse(ev.payload)).toMatchObject({
      reviewed_head: "abc123",
      current_head: "def456",
      verdict: "REQUEST_CHANGES",
    });
    // The reviewed-head mark stays at the reviewed sha — the classifier's
    // comparison base for the chained trigger.
    expect(store.reviewedHead(400)!.head_sha).toBe("abc123");
    expect(store.successorFor(400)?.head_sha).toBe("def456");
  });

  it("a verdict covering the owed successor clears it instead of queueing again", async () => {
    const roundId = reviewingRound(403);
    store.recordSuccessor({
      pr: 403,
      predecessor_round_id: roundId,
      head_sha: "abc123",
      provenance: "system",
      reason: "promoted",
    });

    await watcher().handleFile(
      write(403, 1, verdictFile({ pr: 403, verdict: "APPROVE", head_sha: "abc123" })),
    );

    expect(store.getPr(403)?.state).toBe("tracked");
    expect(store.successorFor(403)).toBeUndefined();
  });

  it("unchanged head ⇒ no chain", async () => {
    reviewingRound(401);
    await watcher().handleFile(
      write(401, 1, verdictFile({ pr: 401, verdict: "APPROVE", head_sha: "abc123" })),
    );
    expect(store.getPr(401)!.state).toBe("tracked");
    expect(
      store.db.prepare("SELECT COUNT(*) c FROM events WHERE kind = 'mid_round_head_advance'").get(),
    ).toMatchObject({ c: 0 });
  });

  it("a legacy NEEDS_HUMAN no longer parks — it chains like any other verdict", async () => {
    reviewingRound(402);
    const row = store.getPr(402)!;
    store.upsertPr({ ...row, head_sha: "def456" });
    await watcher().handleFile(
      write(
        402,
        1,
        verdictFile({
          pr: 402,
          verdict: "NEEDS_HUMAN",
          head_sha: "abc123",
          passes: [{ name: "pass-baseline", tier: "sol-med", findings: 1 }],
        }),
      ),
    );
    expect(store.getPr(402)!.state).toBe("queued");
    expect(
      store.db.prepare("SELECT COUNT(*) c FROM events WHERE kind = 'mid_round_head_advance'").get(),
    ).toMatchObject({ c: 1 });
  });
});

// Compaction race: the post-round ledger check is delayed past the compaction
// window; 0 keeps it inline for tests.
describe("post-round ledger check settle delay", () => {
  it("delay 0 ⇒ inline check fires during apply; default ⇒ deferred (no immediate event)", async () => {
    reviewingRound(500);
    const w = watcher({ ledgerCheckDelayMs: 0 });
    await w.handleFile(
      write(500, 1, verdictFile({ pr: 500, verdict: "APPROVE", head_sha: "abc123" })),
    );
    expect(
      store.db
        .prepare("SELECT COUNT(*) c FROM events WHERE kind = 'ledger_stale_nudged' AND pr = 500")
        .get(),
    ).toMatchObject({ c: 1 });

    reviewingRound(501);
    await watcher().handleFile(
      write(501, 1, verdictFile({ pr: 501, verdict: "APPROVE", head_sha: "abc123" })),
    );
    expect(
      store.db
        .prepare("SELECT COUNT(*) c FROM events WHERE kind = 'ledger_stale_nudged' AND pr = 501")
        .get(),
    ).toMatchObject({ c: 0 });
  });
});

/**
 * A guard-2 refusal is a terminal no-op, not a failure.
 *
 * When post-review.sh refuses a duplicate (same head as a standing review, no
 * author reply since), the shell records the refusal as a `skipped` receipt;
 * without it the watcher would read the round as a `posting_receipt`
 * infrastructure failure while the standing review still stands. These cases
 * pin what the watcher does with that record, and what it must never do.
 */
describe("guarded no-op settlement", () => {
  const HEAD = "abc123";

  /** The standing review from an earlier round, in the shape the shell leaves
   * before the watcher enriches it. */
  function standingMark(
    pr: number,
    posted: "REQUEST_CHANGES" | "APPROVE" | "COMMENT" = "REQUEST_CHANGES",
  ): ReviewedHeadRow {
    store.recordReviewedHead(pr, { head_sha: HEAD, posted_event: posted });
    return store.reviewedHead(pr)!;
  }

  function writeGuardedNoop(
    pr: number,
    roundNo: number,
    key: string,
    mark: ReviewedHeadRow,
    over: Record<string, unknown> = {},
  ): void {
    const receiptDir = join(dir, "state", "posting-receipts");
    mkdirSync(receiptDir, { recursive: true });
    writeFileSync(
      join(receiptDir, `pr-${pr}-round-${roundNo}.json`),
      JSON.stringify({
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
      }),
    );
  }

  /** A running round over a PR that already carries the standing mark. */
  function skippedRound(
    pr: number,
    posted: "REQUEST_CHANGES" | "APPROVE" | "COMMENT" = "REQUEST_CHANGES",
  ): { roundId: number; key: string; mark: ReviewedHeadRow } {
    const mark = standingMark(pr, posted);
    const roundId = reviewingRound(pr);
    const { key } = stampPosting(pr, 1);
    writeGuardedNoop(pr, 1, key, mark);
    return { roundId, key, mark };
  }

  const events = (kind: string, pr: number): Array<Record<string, unknown>> =>
    (
      store.db
        .prepare("SELECT payload FROM events WHERE kind = ? AND pr = ?")
        .all(kind, pr) as Array<{ payload: string }>
    ).map((row) => JSON.parse(row.payload) as Record<string, unknown>);

  it("the guard-2 refusal shape: closes the round as no_new_evidence, restores awaiting_author, applies nothing from the unposted verdict", async () => {
    const { roundId, key, mark } = skippedRound(500);
    store.recordApprovalWithheld(500, {
      head_sha: "older-head",
      ci_state: "red",
      reason: "red-ci",
    });
    const name = write(500, 1, verdictFile({ pr: 500, verdict: "REQUEST_CHANGES" }));

    expect(await watcher().handleFile(name)).toBe(true);

    const round = store.db.prepare("SELECT * FROM rounds WHERE id = ?").get(roundId) as Record<
      string,
      unknown
    >;
    expect(round).toMatchObject({
      status: "cancelled",
      cancel_cause: "no_new_evidence",
      verdict: null,
      gh_review_id: null,
    });
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
    expect(events("posting_guarded_noop", 500)).toEqual([
      expect.objectContaining({
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
      }),
    ]);
  });

  it("rolls back guarded-noop cancellation when its restoration receipt cannot commit", async () => {
    const { roundId } = skippedRound(519);
    store.db.exec(`CREATE TRIGGER reject_noop_receipt BEFORE INSERT ON events
      WHEN NEW.kind='posting_guarded_noop' BEGIN SELECT RAISE(ABORT,'receipt disk full'); END`);
    const name = write(519, 1, verdictFile({ pr: 519 }));
    await expect(watcher().handleFile(name)).rejects.toThrow("receipt disk full");
    expect(store.roundsFor(519)[0]).toMatchObject({ id: roundId, status: "running" });
    expect(store.getPr(519)?.state).toBe("reviewing");
    expect(store.db.prepare("SELECT usage_owed_to FROM rounds WHERE id=?").get(roundId)).toEqual({
      usage_owed_to: null,
    });
    store.db.exec("DROP TRIGGER reject_noop_receipt");
    await watcher().handleFile(name);
    expect(store.getPr(519)?.state).toBe("awaiting_author");
    expect(events("posting_guarded_noop", 519)).toHaveLength(1);
  });

  it("a skipped round's unposted APPROVE can never approve: the standing REQUEST_CHANGES still wins", async () => {
    const { mark } = skippedRound(501);

    await watcher().handleFile(write(501, 1, verdictFile({ pr: 501, verdict: "APPROVE" })));

    expect(store.getPr(501)?.state).toBe("awaiting_author");
    expect(store.reviewedHead(501)).toEqual(mark);
    expect(store.roundsFor(501)[0]).toMatchObject({
      status: "cancelled",
      cancel_cause: "no_new_evidence",
      verdict: null,
    });
    expect(adapter.calls).not.toContain(`addLabel:501:${cfg.github.reviewed_label}`);
    expect(events("posting_guarded_noop", 501)[0]).toMatchObject({
      unposted_verdict: "APPROVE",
      standing_verdict: "REQUEST_CHANGES",
    });
  });

  it("a standing partial APPROVE restores tracked", async () => {
    skippedRound(502, "APPROVE");

    await watcher().handleFile(write(502, 1, verdictFile({ pr: 502, verdict: "REQUEST_CHANGES" })));

    expect(store.getPr(502)?.state).toBe("tracked");
    expect(store.roundsFor(502)[0]).toMatchObject({
      status: "cancelled",
      cancel_cause: "no_new_evidence",
    });
    expect(events("posting_guarded_noop", 502)[0]).toMatchObject({
      standing_verdict: "APPROVE",
      restored_state: "tracked",
    });
  });

  // MUTATION: await the label call before the restoration — a restart inside
  // it strands the PR in `reviewing` behind a cancelled round no replay settles.
  it("restores the standing lifecycle before its first await: a restart inside the label call strands nothing", async () => {
    skippedRound(510);
    let atLabelCall: { state?: string; settled: number } | undefined;
    adapter.removeLabel = async (n, label) => {
      adapter.calls.push(`removeLabel:${n}:${label}`);
      atLabelCall = {
        state: store.getPr(510)?.state,
        settled: events("posting_guarded_noop", 510).length,
      };
      return { executed: false, dryRunFile: "d" };
    };

    await watcher().handleFile(write(510, 1, verdictFile({ pr: 510 })));

    expect(atLabelCall).toEqual({ state: "awaiting_author", settled: 1 });
  });

  // MUTATION: promote the successor before the label call — the old round's
  // removal can then strip the label the successor's dispatch adds.
  it("takes its in-progress label off before it promotes a fresh-head successor", async () => {
    const { roundId } = skippedRound(511);
    store.recordSuccessor({
      pr: 511,
      predecessor_round_id: roundId,
      head_sha: "fresh-head",
      provenance: "system",
      reason: "test",
    });
    let stateAtLabelCall: string | undefined;
    adapter.removeLabel = async (n, label) => {
      adapter.calls.push(`removeLabel:${n}:${label}`);
      stateAtLabelCall = store.getPr(511)?.state;
      return { executed: false, dryRunFile: "d" };
    };

    await watcher().handleFile(write(511, 1, verdictFile({ pr: 511 })));

    expect(stateAtLabelCall).toBe("awaiting_author");
    expect(store.getPr(511)?.state).toBe("queued");
  });

  it("a COMMENT-only standing mark is never guessed: tracked, an anomaly, still no failure and no approve", async () => {
    skippedRound(503, "COMMENT");

    await watcher().handleFile(write(503, 1, verdictFile({ pr: 503, verdict: "APPROVE" })));

    expect(store.getPr(503)?.state).toBe("tracked");
    expect(store.roundsFor(503)[0]).toMatchObject({
      status: "cancelled",
      cancel_cause: "no_new_evidence",
      verdict: null,
    });
    expect(store.openReviewFailure(503)).toBeUndefined();
    expect(store.anomalies().map((a) => a.kind)).toContain("standing_review_unknown");
    expect(adapter.calls).not.toContain(`addLabel:503:${cfg.github.reviewed_label}`);
    expect(events("posting_guarded_noop", 503)[0]).toMatchObject({
      standing_verdict: null,
      standing_source: null,
      restored_state: "tracked",
    });
  });

  it("is consumed ONCE: the deadline sweep settles it, and the verdict file that arrives afterwards replays inertly", async () => {
    const { roundId } = skippedRound(504);
    const later = new Date(Date.now() + (cfg.daemon.round_deadline_min + 10) * 60_000);

    expect(await watcher({ now: () => later }).checkDeadlines()).toEqual([]);

    expect(
      store.db.prepare("SELECT status, cancel_cause FROM rounds WHERE id = ?").get(roundId),
    ).toEqual({ status: "cancelled", cancel_cause: "no_new_evidence" });
    expect(store.getPr(504)?.state).toBe("awaiting_author");
    expect(events("posting_guarded_noop", 504)[0]).toMatchObject({ via: "deadline" });

    // The session finishes writing its verdict a moment later.
    const name = write(504, 1, verdictFile({ pr: 504, verdict: "REQUEST_CHANGES" }));
    expect(await watcher().handleFile(name)).toBe(true);

    expect(existsSync(join(dir, name))).toBe(false);
    expect(
      store.db
        .prepare("SELECT status, cancel_cause, verdict FROM rounds WHERE id = ?")
        .get(roundId),
    ).toEqual({ status: "cancelled", cancel_cause: "no_new_evidence", verdict: null });
    expect(store.getPr(504)?.state).toBe("awaiting_author");
    expect(events("posting_guarded_noop", 504)).toHaveLength(1);
    expect(events("posting_guarded_noop_replayed", 504)).toEqual([
      expect.objectContaining({ via: "verdict", round_status: "cancelled" }),
    ]);
    expect(events("verdict_applied", 504)).toEqual([]);
    expect(store.openReviewFailure(504)).toBeUndefined();
  });

  it("a session that was refused and settled without writing a verdict is 'settled', not failed loud", async () => {
    const { roundId } = skippedRound(505);

    expect(
      await watcher().recoverInfrastructureFailure(
        505,
        1,
        "settled_without_verdict",
        "parent settled",
      ),
    ).toBe("settled");

    expect(
      store.db.prepare("SELECT status, cancel_cause FROM rounds WHERE id = ?").get(roundId),
    ).toEqual({ status: "cancelled", cancel_cause: "no_new_evidence" });
    expect(store.getPr(505)?.state).toBe("awaiting_author");
    expect(store.openReviewFailure(505)).toBeUndefined();
    expect(events("posting_guarded_noop", 505)[0]).toMatchObject({
      via: "settled_without_verdict",
      unposted_verdict: null,
    });
  });

  it("an author reply landing AFTER the refusal is tolerated — the reply belongs to ping-pong, the skip still settles", async () => {
    skippedRound(506);
    store.noteAuthorReply(506, "2099-01-01T00:00:00.000Z");

    await watcher().handleFile(write(506, 1, verdictFile({ pr: 506 })));

    expect(store.roundsFor(506)[0]).toMatchObject({
      status: "cancelled",
      cancel_cause: "no_new_evidence",
    });
    expect(store.getPr(506)?.state).toBe("awaiting_author");
    expect(store.reviewedHead(506)?.last_author_reply_at).toBe("2099-01-01T00:00:00.000Z");
  });

  it("a live author reply BETWEEN the review and the recorded refusal exposes a lookalike: guard 2 would have passed, so it fails loud", async () => {
    const { roundId, mark } = skippedRound(513);
    // The reply follows the review and predates the recorded refusal (review
    // + 60s): at refusal time the live mark said "new evidence".
    store.noteAuthorReply(513, new Date(Date.parse(mark.reviewed_at) + 30_000).toISOString());

    expect(
      await watcher({ postingReceiptGraceS: 0 }).handleFile(
        write(513, 1, verdictFile({ pr: 513 })),
      ),
    ).toBe(true);

    expect(
      store.db.prepare("SELECT status, cancel_cause FROM rounds WHERE id = ?").get(roundId),
    ).toEqual({ status: "cancelled", cancel_cause: "infrastructure_failure" });
    expect(store.openReviewFailure(513)).toMatchObject({ stage: "posting_receipt", work_owed: 1 });
    expect(events("posting_guarded_noop", 513)).toEqual([]);
  });

  it("a record written in the other mode is a config disagreement, not a settlement", async () => {
    const { roundId, key, mark } = skippedRound(514);
    writeGuardedNoop(514, 1, key, mark, { mode: "live" }); // the fixture daemon is dry_run = true

    expect(
      await watcher({ postingReceiptGraceS: 0 }).handleFile(
        write(514, 1, verdictFile({ pr: 514 })),
      ),
    ).toBe(true);

    expect(
      store.db.prepare("SELECT status, cancel_cause FROM rounds WHERE id = ?").get(roundId),
    ).toEqual({ status: "cancelled", cancel_cause: "infrastructure_failure" });
    expect(store.openReviewFailure(514)?.detail).toContain("mode");
  });

  it("a record whose standing mark no longer describes the live one is AMBIGUOUS and stays loud", async () => {
    const { roundId, key, mark } = skippedRound(507);
    // The live mark was re-stamped since the record was written.
    writeGuardedNoop(507, 1, key, { ...mark, reviewed_at: "2020-01-01T00:00:00.000Z" });

    expect(
      await watcher({ postingReceiptGraceS: 0 }).handleFile(
        write(507, 1, verdictFile({ pr: 507 })),
      ),
    ).toBe(true);

    expect(
      store.db.prepare("SELECT status, cancel_cause FROM rounds WHERE id = ?").get(roundId),
    ).toEqual({ status: "cancelled", cancel_cause: "infrastructure_failure" });
    expect(store.openReviewFailure(507)).toMatchObject({ stage: "posting_receipt", work_owed: 1 });
    expect(events("posting_guarded_noop", 507)).toEqual([]);
  });

  it("a record for another identity is ignored, and the ordinary fail-loud path still binds after grace", async () => {
    const { roundId, mark } = skippedRound(508);
    // Same file name, wrong key/head: a session-authored lookalike.
    writeGuardedNoop(
      508,
      1,
      roundPostingKey(508, 1, "0ther"),
      { ...mark, head_sha: "0ther" },
      { head_sha: "0ther" },
    );

    expect(
      await watcher({ postingReceiptGraceS: 0 }).handleFile(
        write(508, 1, verdictFile({ pr: 508 })),
      ),
    ).toBe(true);

    expect(
      store.db.prepare("SELECT status, cancel_cause FROM rounds WHERE id = ?").get(roundId),
    ).toEqual({ status: "cancelled", cancel_cause: "infrastructure_failure" });
    expect(store.openReviewFailure(508)).toMatchObject({ stage: "posting_receipt" });
  });

  it("live mode: a bot review carrying this round's marker contradicts the record — GitHub's truth wins and the review links", async () => {
    const { roundId, key, mark } = skippedRound(509);
    writeGuardedNoop(509, 1, key, mark, { mode: "live" }); // a live daemon, a live record
    adapter.listReviewsFull = async () => [
      {
        id: 778,
        user: cfg.github.bot_login,
        user_type: "Bot",
        state: "CHANGES_REQUESTED",
        body: `review body\n\n${postingMarker(key)}`,
        commit_id: HEAD,
        submitted_at: "2026-08-13T11:59:59Z",
      },
    ];

    expect(
      await watcher({ cfg: { ...cfg, dry_run: false } }).handleFile(
        write(509, 1, verdictFile({ pr: 509 })),
      ),
    ).toBe(true);

    expect(
      store.db
        .prepare("SELECT status, gh_review_id, verdict FROM rounds WHERE id = ?")
        .get(roundId),
    ).toEqual({ status: "done", gh_review_id: 778, verdict: "REQUEST_CHANGES" });
    expect(events("posting_guarded_noop_contradicted", 509)).toEqual([
      expect.objectContaining({ gh_review_id: 778, posting_key: key }),
    ]);
    expect(events("posting_guarded_noop", 509)).toEqual([]);
  });

  // MUTATION: in settleGuardedNoop, await the measurement
  // right after the claim — the restored state is not there while the reads
  // wait, and the held wake is never delivered before them.
  it("a guarded no-op's reads run after the restored lifecycle and its held-wake flush", async () => {
    const { roundId } = skippedRound(520);
    store.holdWake(520, "author says: ping", "author_reply");
    const gated = gatedTranscripts(520, [
      JSON.stringify({
        type: "message",
        timestamp: new Date().toISOString(),
        message: { role: "assistant", usage: { input: 10, output: 1 } },
      }),
    ]);
    const delivered: boolean[] = [];
    const { hooks } = recordingHooks();
    hooks.inject = async (pr) => {
      delivered.push(store.hasRunningRound(pr));
    };
    const handled = watcher({ usage: gated.usage }, hooks).handleFile(
      write(520, 1, verdictFile({ pr: 520 })),
    );
    await gated.reached;
    expect(store.getPr(520)?.state).toBe("awaiting_author");
    expect(events("posting_guarded_noop", 520)).toHaveLength(1);
    expect(delivered).toEqual([false]);
    gated.release();
    expect(await handled).toBe(true);
    expect(tokensIn(roundId)).toBe(10);
  });

  it("a fresh-head successor owed by the skipped round is promoted, never cleared", async () => {
    const { roundId } = skippedRound(510);
    store.recordSuccessor({
      pr: 510,
      predecessor_round_id: roundId,
      head_sha: "def456",
      provenance: "human",
      reason: "trigger-on-new-head",
    });

    await watcher().handleFile(write(510, 1, verdictFile({ pr: 510 })));

    expect(store.roundsFor(510)[0]).toMatchObject({
      status: "cancelled",
      cancel_cause: "no_new_evidence",
    });
    expect(store.getPr(510)).toMatchObject({
      state: "queued",
      head_sha: "def456",
      trigger_provenance: "human",
    });
    expect(store.successorFor(510)?.head_sha).toBe("def456");
  });

  it("a successor owed at the head the skipped round proved reviewed is settled, not promoted", async () => {
    const { roundId } = skippedRound(513);
    store.recordSuccessor({
      pr: 513,
      predecessor_round_id: roundId,
      head_sha: "abc123",
      provenance: "human",
      reason: "trigger-on-new-head",
    });

    await watcher().handleFile(write(513, 1, verdictFile({ pr: 513 })));

    expect(store.successorFor(513)).toBeUndefined();
    expect(store.getPr(513)?.state).not.toBe("queued");
    expect(events("successor_promoted", 513)).toEqual([]);
  });

  it("the ordinary receipt paths are unchanged: confirmed still applies, absent still fails loud after grace", async () => {
    // Confirmed: the verdict applies and the mark is enriched as usual.
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
    expect(
      await watcher({ postingReceiptGraceS: 0 }).handleFile(
        write(512, 1, verdictFile({ pr: 512 })),
      ),
    ).toBe(true);
    expect(store.roundsFor(512)[0]).toMatchObject({
      status: "cancelled",
      cancel_cause: "infrastructure_failure",
    });
    expect(store.openReviewFailure(512)).toMatchObject({ stage: "posting_receipt", work_owed: 1 });
  });
});

// ---------------------------------------------------------------------------
// A round end's measurement is OWED durably and a
// restart resumes it; the round-stage supervisor and the deadline tick never
// wait on it; the deadline honours the posted-tail grace; a POST whose outcome
// is unknown is never requeued; apply's finishRound is a claim; and staging
// files that were never committed do not pile up.
// ---------------------------------------------------------------------------
describe("integration review", () => {
  const usageLine = (input: number, output: number): string =>
    JSON.stringify({
      type: "message",
      timestamp: new Date().toISOString(),
      message: { role: "assistant", usage: { input, output } },
    });
  const modelChange = (): string =>
    JSON.stringify({ type: "model_change", provider: "openai-codex", modelId: "gpt-5.6-sol" });
  const count = (kind: string, pr: number): number =>
    (
      store.db
        .prepare("SELECT COUNT(*) AS c FROM events WHERE kind = ? AND pr = ?")
        .get(kind, pr) as {
        c: number;
      }
    ).c;
  const payloads = (kind: string, pr: number): Array<Record<string, unknown>> =>
    (
      store.db
        .prepare("SELECT payload FROM events WHERE kind = ? AND pr = ? ORDER BY id")
        .all(kind, pr) as Array<{ payload: string }>
    ).map((row) => JSON.parse(row.payload) as Record<string, unknown>);
  const owedTo = (roundId: number): string | null =>
    (
      store.db.prepare("SELECT usage_owed_to FROM rounds WHERE id = ?").get(roundId) as {
        usage_owed_to: string | null;
      }
    ).usage_owed_to;
  /** The same in-memory transcript `gatedTranscripts` serves, with no gate. */
  const memoryUsage = (
    pr: number,
    lines: string[],
  ): NonNullable<ConstructorParameters<typeof VerdictWatcher>[0]["usage"]> => ({
    sessionDirFor: (n) => `/sessions/pr-${n}`,
    transcripts: new TranscriptIndex({
      fs: new MemoryTranscriptFs(
        { [`/sessions/pr-${pr}/session.jsonl`]: lines.join("\n") },
        {},
        Date.now(),
      ),
    }),
  });
  /** `p`'s answer, or "still waiting" if it has none within `ms` — so a
   * mutation that makes a call wait on a gated read fails instead of hanging. */
  const within = <T>(p: Promise<T>, ms = 2_000): Promise<T | "still waiting"> =>
    Promise.race([
      p,
      new Promise<"still waiting">((r) => setTimeout(() => r("still waiting"), ms)),
    ]);
  const killingHooks = (killed: number[]): SessionHooks => {
    const { hooks } = recordingHooks();
    hooks.killSession = async (pr) => {
      killed.push(pr);
    };
    return hooks;
  };

  describe("a round end's measurement is owed, and the next start resumes it", () => {
    // MUTATION: drop `resumeOwedMeasurements()` from the sweep, or the
    // `oweRoundMeasurement` write — the round keeps NULL tokens and no event.
    // MUTATION: re-run the integrity check on a resume — `rehashed` is 1.
    it("a restart while a verdict's transcripts are read leaves the round owed; the next start measures it", async () => {
      const roundId = reviewingRound(600);
      store.recordRoundGitConfig(roundId, { digest: "sha256:before", files: {} });
      const lines = [modelChange(), usageLine(40, 4)];
      const gated = gatedTranscripts(600, lines);
      // The daemon about to die: its round end is inside the transcript reads.
      void watcher({ usage: gated.usage }).handleFile(
        write(600, 1, verdictFile({ pr: 600, verdict: "APPROVE" })),
      );
      await gated.reached;
      expect(store.roundsFor(600)[0]).toMatchObject({
        status: "done",
        verdict: "APPROVE",
        tokens_in: null,
      });
      expect(count("verdict_settled", 600)).toBe(1);
      expect(owedTo(roundId)).not.toBeNull();
      expect(store.runningRounds()).toEqual([]); // what a deploy's drain sees

      // The restarted daemon.
      let rehashed = 0;
      const restarted = watcher({
        usage: memoryUsage(600, lines),
        integrityFingerprint: async () => {
          rehashed++;
          return { digest: "sha256:after", files: {} };
        },
      });
      await restarted.sweep();
      await restarted.idle();

      expect(tokensIn(roundId)).toBe(40);
      expect(owedTo(roundId)).toBeNull();
      expect(payloads("round_usage_resumed", 600)).toEqual([
        expect.objectContaining({ round_id: roundId }),
      ]);
      // A deploy rewrote the policy surface: the round is recorded unchecked,
      // never re-hashed against it.
      expect(rehashed).toBe(0);
      expect(payloads("round_integrity_unchecked", 600)).toEqual([
        expect.objectContaining({ round_id: roundId, stage: "round_end", reason: "interrupted" }),
      ]);
      expect(count("round_usage_unknown", 600)).toBe(0);
      // Once per start, and the leftover verdict file replays inertly.
      await restarted.sweep();
      await restarted.idle();
      expect(count("round_usage_resumed", 600)).toBe(1);
      expect(count("verdict_applied", 600)).toBe(1);
    });

    // MUTATION: re-read an owed window whatever its age — `measured` is 1.
    it("a window too old to re-read is recorded UNKNOWN, never re-read into a partial sum", async () => {
      const lost = reviewingRound(601);
      store.finishRound(lost, "APPROVE", null, null);
      const measuredBefore = reviewingRound(602);
      store.finishRound(measuredBefore, "APPROVE", null, null);
      store.recordRoundUsage(measuredBefore, { tokens_in: 7, tokens_out: 1, est_usd: null });
      const old = new Date(Date.now() - OWED_MEASUREMENT_RESUME_MAX_MS - 60_000).toISOString();
      store.oweRoundMeasurement(lost, old);
      store.oweRoundMeasurement(measuredBefore, old);
      let measured = 0;
      const w = watcher({
        usage: {
          transcripts: {
            measure: () => {
              measured++;
              return Promise.resolve({ usage: null, unreadable: [], violations: [] });
            },
          } as unknown as TranscriptIndex,
        },
      });
      await w.sweep();
      await w.idle();

      expect(measured).toBe(0);
      expect(payloads("round_usage_unknown", 601)).toEqual([
        expect.objectContaining({ round_id: lost, reason: "interrupted", audit: "incomplete" }),
      ]);
      // Usage recorded before the restart stays; only the audit is incomplete.
      expect(count("round_usage_unknown", 602)).toBe(0);
      expect(tokensIn(measuredBefore)).toBe(7);
      expect(owedTo(lost)).toBeNull();
      expect(owedTo(measuredBefore)).toBeNull();
    });
  });

  describe("the round-stage supervisor and the deadline tick never wait on a measurement", () => {
    // MUTATION: make `measureModeFor` always "inline" — the stage limit's
    // answer waits for the gated reads and `within` reports "still waiting".
    it("a stage limit's receipt settlement answers at once; the boot resume never measures it twice", async () => {
      const roundId = reviewingRound(603);
      const { key } = stampPosting(603, 1);
      const posted = new Date(Date.now() - 20 * 60_000).toISOString(); // past the 15-min grace
      writePostingReceipt(603, 1, key, "REQUEST_CHANGES", {
        prepared_at: posted,
        confirmed_at: posted,
      });
      const gated = gatedTranscripts(603, [modelChange(), usageLine(25, 2)]);
      const w = watcher({ usage: gated.usage });

      expect(await within(w.recoverInfrastructureFailure(603, 1, "parent_finalize", "limit"))).toBe(
        "settled",
      );
      await gated.reached; // the reads run in the background…
      expect(store.roundsFor(603)[0]).toMatchObject({ status: "done", tokens_in: null });
      expect(owedTo(roundId)).not.toBeNull(); // …owed while they do
      await w.sweep(); // this process's own measurement is never resumed
      expect(count("round_usage_resumed", 603)).toBe(0);

      gated.release();
      await w.idle();
      expect(tokensIn(roundId)).toBe(25);
      expect(owedTo(roundId)).toBeNull();
    });

    // MUTATION: make `measureModeForRequeue` always "inline" — the requeue's
    // answer waits for the gated reads.
    it("a stage limit's kill-and-requeue answers at once too", async () => {
      const roundId = reviewingRound(606);
      stampPosting(606, 1); // no receipt: nothing was posted
      const gated = gatedTranscripts(606, [modelChange(), usageLine(9, 1)]);
      const killed: number[] = [];
      const w = watcher({ usage: gated.usage }, killingHooks(killed));

      expect(await within(w.recoverInfrastructureFailure(606, 1, "parent_finalize", "limit"))).toBe(
        "requeued",
      );
      expect(killed).toEqual([606]);
      expect(store.roundsFor(606)[0]).toMatchObject({ status: "cancelled", tokens_in: null });
      expect(owedTo(roundId)).not.toBeNull();

      gated.release();
      await w.idle();
      expect(tokensIn(roundId)).toBe(9);
      expect(owedTo(roundId)).toBeNull();
    });

    // MUTATION: drop the `deadlinesInFlight` guard — the second tick reaches
    // the same round and reads GitHub a second time.
    it("a deadline tick still running makes the next one a no-op", async () => {
      reviewingRound(604);
      stampPosting(604, 1); // no receipt: the marker reconcile reads GitHub
      let reads = 0;
      let release!: () => void;
      const gate = new Promise<void>((r) => {
        release = r;
      });
      adapter.listReviewsFull = async () => {
        reads++;
        await gate;
        return [];
      };
      const later = new Date(Date.now() + (cfg.daemon.round_deadline_min + 5) * 60_000);
      const w = watcher({ cfg: { ...cfg, dry_run: false }, now: () => later });

      const first = w.checkDeadlines();
      await waitFor(() => reads > 0, "the first receipt read");
      expect(reads).toBe(1);
      expect(await w.checkDeadlines()).toEqual([]);
      expect(reads).toBe(1);

      release();
      await first;
      await w.idle();
      // Nothing posted and the grace long gone: the loud path, once.
      expect(store.openReviewFailure(604)).toMatchObject({ stage: "posting_receipt" });
    });
  });

  describe("the deadline honours the posted-tail grace", () => {
    // MUTATION: drop the `inPostedTailGrace` check in checkDeadlines — the
    // round settles two minutes after its review was posted, and the
    // supervisor's terminal-round path would then kill the session mid-tail.
    it("a review posted two minutes before the deadline gives the session its tail; past it, the receipt settles the round", async () => {
      const roundId = reviewingRound(605);
      const startedMs = Date.parse(store.roundsFor(605)[0]!.started_at);
      const deadlineMs = startedMs + cfg.daemon.round_deadline_min * 60_000;
      const postedAt = new Date(deadlineMs - 2 * 60_000).toISOString();
      const { key } = stampPosting(605, 1);
      writePostingReceipt(605, 1, key, "REQUEST_CHANGES", {
        prepared_at: postedAt,
        confirmed_at: postedAt,
      });
      const killed: number[] = [];
      let clock = new Date(deadlineMs + 20_000);
      const w = watcher({ now: () => clock }, killingHooks(killed));

      expect(await w.checkDeadlines()).toEqual([]);
      await w.checkDeadlines();
      expect(store.roundsFor(605)[0]).toMatchObject({ id: roundId, status: "running" });
      expect(count("verdict_settled_from_receipt", 605)).toBe(0);
      expect(payloads("round_stage_posted_wait", 605)).toEqual([
        expect.objectContaining({ stage: "round_deadline", posted_at: postedAt }),
      ]);

      clock = new Date(Date.parse(postedAt) + 15 * 60_000 + 1_000);
      await w.checkDeadlines();
      await w.idle();
      expect(store.roundsFor(605)[0]).toMatchObject({
        status: "done",
        verdict: "REQUEST_CHANGES",
        gh_review_id: 991,
      });
      expect(count("verdict_settled_from_receipt", 605)).toBe(1);
      expect(count("round_self_requeued", 605)).toBe(0);
      expect(killed).toEqual([]);
    });
  });

  describe("a POST whose outcome is unknown is never requeued at a stage limit", () => {
    const live = { ...cfg, dry_run: false };
    const at = () => new Date("2026-08-13T12:30:00Z"); // past the 120 s receipt grace
    const prepared = (pr: number, key: string): void =>
      writePostingReceipt(pr, 1, key, "REQUEST_CHANGES", {
        status: "prepared",
        prepared_at: "2026-08-13T12:00:00Z",
        confirmed_at: undefined,
        gh_review_id: undefined,
        gh_commit_id: undefined,
        gh_state: undefined,
      });
    const review = (id: number, key: string) => ({
      id,
      user: cfg.github.bot_login,
      user_type: "Bot",
      state: "CHANGES_REQUESTED",
      body: `review body\n\n${postingMarker(key)}`,
      commit_id: "abc123",
      submitted_at: "2026-08-13T12:29:00Z",
    });

    // MUTATION: drop the stillRunning check on the settled_without_verdict
    // failure — the operator's `u` that won during the read is reopened as debt.
    it("a settled parent's failed proof opens no incident over a round an operator ended during the read", async () => {
      reviewingRound(614);
      const { key } = stampPosting(614, 1);
      prepared(614, key);
      adapter.listReviewsFull = async () => {
        store.cancelRunningRounds(614, "rerun-round");
        return [];
      };
      const w = watcher({ cfg: live, now: at }, killingHooks([]));

      expect(await w.recoverInfrastructureFailure(614, 1, "settled_without_verdict", "x")).toBe(
        "settled",
      );
      expect(store.openReviewFailure(614)).toBeUndefined();
      expect(store.roundsFor(614)[0]).toMatchObject({
        status: "cancelled",
        cancel_cause: "operator",
      });
    });

    // MUTATION: drop the `ambiguous` branch in receiptAwareStage — the limit
    // kills the session and requeues a round that may already have posted.
    it("a prepared receipt past its grace with GitHub unreadable waits for a read that can decide", async () => {
      reviewingRound(610);
      const { key } = stampPosting(610, 1);
      prepared(610, key);
      adapter.listReviewsFull = async () => {
        throw new Error("GitHub 502");
      };
      const killed: number[] = [];
      const w = watcher({ cfg: live, now: at }, killingHooks(killed));

      expect(await w.recoverInfrastructureFailure(610, 1, "parent_finalize", "x")).toBe(
        "retryable",
      );
      expect(await w.recoverInfrastructureFailure(610, 1, "parent_finalize", "x")).toBe(
        "retryable",
      );
      expect(killed).toEqual([]);
      expect(store.roundsFor(610)[0]?.status).toBe("running");
      expect(count("round_stage_posting_ambiguous", 610)).toBe(1); // once, not per scan
      expect(count("round_self_requeued", 610)).toBe(0);

      // The read comes back with the marker: the POST had landed. Linked, and
      // its tail waited for — never a second posting.
      adapter.listReviewsFull = async () => [review(4242, key)];
      expect(await w.recoverInfrastructureFailure(610, 1, "parent_finalize", "x")).toBe(
        "posted_wait",
      );
      expect(store.roundsFor(610)[0]).toMatchObject({ status: "running", gh_review_id: 4242 });
      expect(killed).toEqual([]);
    });

    it("an adapter that cannot read reviews leaves the POST unknown too", async () => {
      reviewingRound(611);
      const { key } = stampPosting(611, 1);
      prepared(611, key);
      const killed: number[] = [];
      expect(
        await watcher({ cfg: live, now: at }, killingHooks(killed)).recoverInfrastructureFailure(
          611,
          1,
          "parent_finalize",
          "x",
        ),
      ).toBe("retryable");
      expect(killed).toEqual([]);
    });

    it("rechecks a posting receipt committed while the old session is being fenced", async () => {
      reviewingRound(614);
      const { key } = stampPosting(614, 1);
      prepared(614, key);
      adapter.listReviewsFull = async () => [];
      const killed: number[] = [];
      const hooks = killingHooks(killed);
      hooks.killSession = async () => {
        killed.push(614);
        writePostingReceipt(614, 1, key, "APPROVE");
      };
      const w = watcher({ cfg: live, now: at }, hooks);
      expect(await w.recoverInfrastructureFailure(614, 1, "parent_finalize", "limit")).toBe(
        "retryable",
      );
      expect(killed).toEqual([614]);
      expect(store.roundsFor(614)[0]?.status).toBe("running");
      expect(count("round_self_requeued", 614)).toBe(0);
      expect(
        await w.recoverInfrastructureFailure(614, 1, "settled_without_verdict", "parent stopped"),
      ).toBe("settled");
      await w.idle();
      expect(store.roundsFor(614)[0]?.status).toBe("done");
      expect(count("round_self_requeued", 614)).toBe(0);
    });

    it("once GitHub is read and holds no marker, the old path requeues", async () => {
      reviewingRound(612);
      const { key } = stampPosting(612, 1);
      prepared(612, key);
      adapter.listReviewsFull = async () => [];
      const killed: number[] = [];
      const w = watcher({ cfg: live, now: at }, killingHooks(killed));

      expect(await w.recoverInfrastructureFailure(612, 1, "parent_finalize", "x")).toBe("requeued");
      await w.idle();
      expect(killed).toEqual([612]);
      expect(store.roundsFor(612)[0]).toMatchObject({
        status: "cancelled",
        cancel_cause: "infrastructure_failure",
      });
    });

    // MUTATION: fail loud on every failed proof of a settled parent — a
    // session that stopped on a failed pass and posted nothing is held for an
    // operator instead of retried.
    it("a settled parent that posted nothing is requeued, not failed loud", async () => {
      reviewingRound(615);
      stampPosting(615, 1);
      adapter.listReviewsFull = async () => [];
      const killed: number[] = [];
      // No receipt: the grace runs from the round's start.
      const pastGrace = () => new Date(Date.now() + 10 * 60_000);
      const w = watcher({ cfg: live, now: pastGrace }, killingHooks(killed));

      expect(
        await w.recoverInfrastructureFailure(615, 1, "settled_without_verdict", "parent stopped"),
      ).toBe("requeued");
      await w.idle();
      expect(killed).toEqual([]);
      expect(store.openReviewFailure(615)).toBeUndefined();
      expect(store.roundsFor(615)[0]).toMatchObject({
        status: "cancelled",
        cancel_cause: "infrastructure_failure",
      });
      expect(count("round_self_requeued", 615)).toBe(1);
    });

    it("a settled parent with a prepared POST GitHub does not show is requeued too", async () => {
      reviewingRound(616);
      const { key } = stampPosting(616, 1);
      prepared(616, key);
      adapter.listReviewsFull = async () => [];
      const w = watcher({ cfg: live, now: at }, killingHooks([]));

      expect(
        await w.recoverInfrastructureFailure(616, 1, "settled_without_verdict", "parent stopped"),
      ).toBe("requeued");
      expect(store.openReviewFailure(616)).toBeUndefined();
    });

    it("a settled parent whose POST outcome is unknown still fails loud — never a requeue", async () => {
      reviewingRound(617);
      const { key } = stampPosting(617, 1);
      prepared(617, key);
      adapter.listReviewsFull = async () => {
        throw new Error("GitHub 502");
      };
      const w = watcher({ cfg: live, now: at }, killingHooks([]));

      expect(
        await w.recoverInfrastructureFailure(617, 1, "settled_without_verdict", "parent stopped"),
      ).toBe("failed_loud");
      expect(count("round_self_requeued", 617)).toBe(0);
      expect(store.openReviewFailure(617)).toMatchObject({ stage: "posting_receipt" });
    });

    // MUTATION: drop the `contradicted` branch — the limit requeues a round
    // GitHub already shows two reviews for.
    it("evidence of a posting that contradicts the round fails loud — never a requeue", async () => {
      reviewingRound(613);
      const { key } = stampPosting(613, 1);
      prepared(613, key);
      adapter.listReviewsFull = async () => [review(1, key), review(2, key)];
      const killed: number[] = [];
      const w = watcher({ cfg: live, now: at }, killingHooks(killed));

      expect(await w.recoverInfrastructureFailure(613, 1, "parent_finalize", "x")).toBe(
        "failed_loud",
      );
      await w.idle();
      expect(killed).toEqual([]);
      expect(count("round_self_requeued", 613)).toBe(0);
      expect(store.openReviewFailure(613)).toMatchObject({ stage: "posting_receipt" });
    });
  });

  describe("apply's finishRound is a claim", () => {
    const cancelOnLabel = (): void => {
      adapter.removeLabel = async (n, label) => {
        adapter.calls.push(`removeLabel:${n}:${label}`);
        // The operator's `u` lands while the label call is in flight.
        store.cancelRunningRounds(n, "rerun-round");
        return { executed: false, dryRunFile: "d" };
      };
    };

    it("finishRound with an expected status is a compare-and-set", () => {
      const id = reviewingRound(620);
      store.markRoundCancelled(id, "x", "operator");
      expect(store.finishRound(id, "APPROVE", null, null, "running")).toBe(false);
      expect(store.roundsFor(620)[0]).toMatchObject({ status: "cancelled", verdict: null });
      expect(store.finishRound(id, "APPROVE", null, null, "cancelled")).toBe(true);
      expect(store.finishRound(id, "APPROVE", null, null)).toBe(true); // unconditional, as before
    });

    // MUTATION: drop `claimedStatus` from apply's finishRound — the verdict
    // lands over the operator's cancel and the PR transitions under it.
    it("an operator's u that lands during a verdict's label calls is never applied over", async () => {
      const roundId = reviewingRound(621);
      cancelOnLabel();

      expect(
        await watcher().handleFile(write(621, 1, verdictFile({ pr: 621, verdict: "APPROVE" }))),
      ).toBe(true);

      expect(store.roundsFor(621)[0]).toMatchObject({
        status: "cancelled",
        cancel_cause: "operator",
        verdict: null,
      });
      expect(payloads("verdict_apply_claim_lost", 621)).toEqual([
        expect.objectContaining({
          round_id: roundId,
          claimed_status: "running",
          round_status: "cancelled",
          verdict: "APPROVE",
        }),
      ]);
      expect(adapter.calls).not.toContain(`addLabel:621:${cfg.github.reviewed_label}`);
      expect(count("verdict_applied", 621)).toBe(0);
      expect(count("verdict_settled", 621)).toBe(0);
      expect(store.reviewedHead(621)).toBeUndefined();
      expect(store.getPr(621)?.state).toBe("reviewing");
      expect(owedTo(roundId)).toBeNull();
    });

    it("…and the same for a receipt settlement from the deadline tick, which a later sweep never resumes", async () => {
      reviewingRound(622);
      const { key } = stampPosting(622, 1);
      writePostingReceipt(622, 1, key, "APPROVE"); // posted long before: no grace left
      cancelOnLabel();
      const later = new Date(Date.now() + (cfg.daemon.round_deadline_min + 5) * 60_000);
      const w = watcher({ now: () => later });

      await w.checkDeadlines();
      await w.idle();
      await w.sweep();
      await w.idle();

      expect(store.roundsFor(622)[0]).toMatchObject({ status: "cancelled", verdict: null });
      expect(payloads("verdict_apply_claim_lost", 622)).toEqual([
        expect.objectContaining({ source: "posting_receipt", via: "deadline" }),
      ]);
      expect(count("verdict_applied", 622)).toBe(0);
      expect(count("verdict_settled_from_receipt_resumed", 622)).toBe(0);
      expect(store.reviewedHead(622)).toBeUndefined();
    });

    // MUTATION: drop the cancelled-round guard at the top of apply — the
    // late verdict finishes the cancelled round and moves the PR out of
    // the replacement's queue.
    it("a verdict reaching a round cancelled BEFORE the apply started is never applied over the cancel", async () => {
      const roundId = reviewingRound(623);
      const { key } = stampPosting(623, 1);
      writePostingReceipt(623, 1, key, "APPROVE");
      // The operator's `u`: the round cancelled, the PR queued for a rerun.
      store.cancelRunningRounds(623, "rerun-round");
      store.setPrState(623, "queued");
      const name = write(623, 1, verdictFile({ pr: 623, verdict: "APPROVE" }));

      expect(await watcher().handleFile(name)).toBe(true);

      expect(existsSync(join(dir, name))).toBe(false);
      expect(store.roundsFor(623)[0]).toMatchObject({
        id: roundId,
        status: "cancelled",
        verdict: null,
      });
      expect(store.getPr(623)?.state).toBe("queued");
      expect(store.reviewedHead(623)).toBeUndefined();
      expect(count("verdict_applied", 623)).toBe(0);
      expect(payloads("verdict_after_cancel_ignored", 623)).toEqual([
        expect.objectContaining({
          round_id: roundId,
          cancel_cause: "operator",
          verdict: "APPROVE",
        }),
      ]);
      expect(adapter.calls.some((c) => c.startsWith("addLabel:623"))).toBe(false);
    });

    // MUTATION: restore runningRound's fallback to the newest running round —
    // the stray file settles round 1 with round 2's verdict.
    it("a verdict file naming a round the PR never had touches no other round", async () => {
      const roundId = reviewingRound(624);
      const name = write(624, 2, verdictFile({ pr: 624, round_no: 2, verdict: "APPROVE" }));

      expect(await watcher().handleFile(name)).toBe(true);

      expect(store.roundsFor(624)[0]).toMatchObject({ id: roundId, status: "running" });
      expect(store.getPr(624)?.state).toBe("reviewing");
      expect(store.reviewedHead(624)).toBeUndefined();
      expect(store.openReviewFailure(624)).toBeUndefined();
      expect(payloads("verdict_round_unknown", 624)).toEqual([
        expect.objectContaining({ round_no: 2, file: name }),
      ]);
    });

    it("…and a malformed one naming such a round opens no failure against the running one", async () => {
      const roundId = reviewingRound(625);
      const name = write(625, 2, "{ not json");

      expect(await watcher().handleFile(name)).toBe(true);

      expect(store.roundsFor(625)[0]).toMatchObject({ id: roundId, status: "running" });
      expect(store.getPr(625)?.state).toBe("reviewing");
      expect(store.openReviewFailure(625)).toBeUndefined();
      expect(count("verdict_round_unknown", 625)).toBe(1);
    });

    // MUTATION: drop the cancelled-round return in handleMalformed — the old
    // round's bad file reopens FAILED_LOUD over the operator's `u`.
    it("a malformed file reaching a round the operator cancelled opens no failure: the `u` stands", async () => {
      const roundId = reviewingRound(626);
      store.cancelRunningRounds(626, "rerun-round");
      store.setPrState(626, "queued");
      const name = write(626, 1, "{ not json");

      expect(await watcher().handleFile(name)).toBe(true);

      expect(store.openReviewFailure(626)).toBeUndefined();
      expect(store.getPr(626)?.state).toBe("queued");
      expect(store.roundsFor(626)[0]).toMatchObject({ id: roundId, status: "cancelled" });
      expect(payloads("verdict_after_cancel_ignored", 626)).toEqual([
        expect.objectContaining({ round_id: roundId, cancel_cause: "operator", file: name }),
      ]);
      expect(count("verdict_malformed", 626)).toBe(0);
    });

    // MUTATION: drop `orphanVerdictOwed` from apply's cancelled guard — the
    // orphan-swept round's posted, withheld review is dropped, the PR reruns
    // at the head and the withheld-approval mark is never recorded.
    it("an orphan-swept round's verdict still applies while no later round has started; once one has, it is inert", async () => {
      const roundId = reviewingRound(627);
      const { key } = stampPosting(627, 1);
      writePostingReceipt(627, 1, key, "COMMENT", { intended_event: "APPROVE" });
      reconcileOrphanedRounds(store, [], {});
      expect(store.roundsFor(627)[0]).toMatchObject({
        status: "cancelled",
        cancel_cause: "orphan_sweep",
      });
      expect(store.getPr(627)?.state).toBe("queued");

      const name = write(
        627,
        1,
        verdictFile({ pr: 627, verdict: "APPROVE", approval_withheld: true }),
      );
      expect(await watcher().handleFile(name)).toBe(true);

      expect(store.roundsFor(627)[0]).toMatchObject({
        id: roundId,
        status: "done",
        verdict: "APPROVE",
      });
      expect(store.approvalWithheld(627)).toMatchObject({ head_sha: "abc123" });
      expect(store.reviewedHead(627)).toMatchObject({ head_sha: "abc123", verdict: "APPROVE" });
      expect(store.getPr(627)?.state).not.toBe("queued");

      // With a later round already started, the same late file is inert.
      reviewingRound(628);
      reconcileOrphanedRounds(store, [], {});
      store.startRound(628, "re-review", ["pass-baseline"], cfg.daemon.round_deadline_min);
      const late = write(628, 1, verdictFile({ pr: 628, verdict: "APPROVE" }));
      expect(await watcher().handleFile(late)).toBe(true);
      expect(store.roundsFor(628)[0]).toMatchObject({ status: "cancelled", verdict: null });
      expect(count("verdict_after_cancel_ignored", 628)).toBe(1);
    });

    // MUTATION: drop the later-round re-check at apply's claim — the orphan
    // round finishes done over the requeued round the pump started meanwhile.
    it("an orphan-swept round's verdict is not applied over the requeued round that started during its apply", async () => {
      reviewingRound(629);
      const { key } = stampPosting(629, 1);
      writePostingReceipt(629, 1, key, "REQUEST_CHANGES");
      reconcileOrphanedRounds(store, [], {});
      adapter.addLabel = async (n, label) => {
        adapter.calls.push(`addLabel:${n}:${label}`);
        // The boot pump dispatches the requeued PR while the label call is out.
        store.startRound(629, "re-review", ["pass-baseline"], cfg.daemon.round_deadline_min);
        store.setPrState(629, "reviewing");
        return { executed: false, dryRunFile: "d" };
      };

      const name = write(629, 1, verdictFile({ pr: 629, verdict: "REQUEST_CHANGES" }));
      expect(await watcher().handleFile(name)).toBe(true);

      expect(store.roundsFor(629).map((r) => [r.round_no, r.status, r.verdict])).toEqual([
        [1, "cancelled", null],
        [2, "running", null],
      ]);
      expect(store.getPr(629)?.state).toBe("reviewing");
      expect(store.reviewedHead(629)).toBeUndefined();
      expect(payloads("verdict_after_cancel_ignored", 629)).toEqual([
        expect.objectContaining({ reason: "a later round started while the verdict was applied" }),
      ]);
    });
  });

  // MUTATION: drop `pruneStaleStaging` from the sweep — the old staging files stay.
  it("staging files never committed are removed once a day old — only the two staging shapes, never a directory", async () => {
    const old = (Date.now() - STAGED_FILE_MAX_AGE_MS - 60_000) / 1000;
    const make = (name: string, aged: boolean): void => {
      writeFileSync(join(dir, name), "{}");
      if (aged) utimesSync(join(dir, name), old, old);
    };
    make("pr-630-round-1.json.tmp", true);
    make("pr-630-recheck-abcdef1.json.tmp", true);
    make("pr-630-round-2.json.tmp", false); // a session publishing it right now
    make("notes.tmp", true);
    make("pr-630-round-1.json.bak", true);
    mkdirSync(join(dir, "pr-630-round-3.json.tmp"));
    utimesSync(join(dir, "pr-630-round-3.json.tmp"), old, old);

    await watcher().sweep();

    expect(readdirSync(dir).sort()).toEqual([
      "notes.tmp",
      "pr-630-round-1.json.bak",
      "pr-630-round-2.json.tmp",
      "pr-630-round-3.json.tmp",
    ]);
    expect(count("verdict_staging_pruned", 630)).toBe(2);
  });
});

// docs/follow-up-rounds.md: a follow-up round's verdict carries the
// pre-approval sweep's claim and per-pass phases. Both are parsed tolerantly,
// the pass plan is compared per stage, and `rounds.sweep_status` records what
// became of the sweep — `ran` only on a claim WITH sweep-phase telemetry.
describe("follow-up rounds: sweep telemetry", () => {
  const DELTA_PLAN: PassPlanEntry[] = [
    { lens: "pass-baseline", agent: "pass-baseline--sol-med", tier: "sol-med", raisable_to: [] },
    { lens: "pass-validate", agent: "pass-validate--sol-high", tier: "sol-high", raisable_to: [] },
  ];
  const SWEEP_PLAN: PassPlanEntry[] = [
    { lens: "pass-baseline", agent: "pass-baseline--sol-med", tier: "sol-med", raisable_to: [] },
    { lens: "pass-security", agent: "pass-security--sol-high", tier: "sol-high", raisable_to: [] },
    { lens: "pass-validate", agent: "pass-validate--sol-high", tier: "sol-high", raisable_to: [] },
  ];
  const DELTA_PASSES = [
    { name: "pass-baseline", tier: "sol-med", phase: "delta", findings: 1 },
    { name: "pass-validate", tier: "sol-high", phase: "delta", findings: 0 },
  ];
  const SWEEP_PASSES = [
    { name: "pass-baseline", tier: "sol-med", phase: "sweep", findings: 0 },
    { name: "pass-security", tier: "sol-high", phase: "sweep", findings: 0 },
    { name: "pass-validate", tier: "sol-high", phase: "sweep", findings: 0 },
  ];

  function followUpRound(pr: number, opts: { sweepOwed: boolean }): number {
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
    return store.startRound(
      pr,
      "re-review",
      ["pass-baseline", "pass-validate"],
      cfg.daemon.round_deadline_min,
      {
        pass_plan: DELTA_PLAN,
        addable_passes: [
          { lens: "pass-concurrency", tier: "sol-med" },
          { lens: "pass-security", tier: "sol-high" },
        ],
        head_sha: "abc123",
        scope: "delta",
        delta_base_sha: "old000",
        delta_lines: 12,
        delta_files: 1,
        sweep_owed: opts.sweepOwed,
        ...(opts.sweepOwed ? { sweep_plan: SWEEP_PLAN } : { sweep_status: "not_owed" as const }),
      },
    );
  }
  const row = (id: number) =>
    store.db.prepare("SELECT * FROM rounds WHERE id = ?").get(id) as {
      sweep_status: string | null;
      status: string;
      verdict: string | null;
    };
  const count = (kind: string) =>
    (
      store.db.prepare("SELECT COUNT(*) AS c FROM events WHERE kind = ?").get(kind) as {
        c: number;
      }
    ).c;
  const anomalyKinds = () => store.anomalies().map((a) => a.kind);
  const mismatch = () =>
    JSON.parse(
      (
        store.db.prepare("SELECT payload FROM events WHERE kind = 'pass_plan_mismatch'").get() as {
          payload: string;
        }
      ).payload,
    );

  it("parses phase and the sweep claim tolerantly: forgiven spellings kept, junk dropped with a note, never a rejection", () => {
    const parsed = validateVerdict(
      verdictFile({
        sweep: " Not-Reached ",
        passes: [
          { name: "pass-baseline", tier: "sol-med", phase: "Sweep" },
          { name: "pass-validate", tier: "sol-med", phase: "later" },
          { name: "pass-security", tier: "sol-med" },
        ] as never,
      }),
    );
    expect(parsed.ok).toBe(true);
    expect(parsed.verdict?.sweep).toBe("not_reached");
    expect(parsed.verdict?.passes?.map((p) => [p.name, p.phase])).toEqual([
      ["pass-baseline", "sweep"],
      ["pass-validate", undefined],
      ["pass-security", undefined],
    ]);
    // Absent phase stays absent — a verdict without phases is unchanged.
    expect("phase" in parsed.verdict!.passes![2]!).toBe(false);
    expect(parsed.passes_note).toContain("1 unusable phase ignored");

    const junk = validateVerdict(verdictFile({ sweep: { ran: true } }));
    expect(junk.ok).toBe(true);
    expect(junk.verdict?.sweep).toBeUndefined();
    expect(junk.passes_note).toContain("sweep claim unusable");
    // Absent is clean: no note.
    expect(validateVerdict(verdictFile()).passes_note).toContain("absent");
    expect(validateVerdict(verdictFile({ passes: [] })).passes_note).toBeUndefined();
  });

  it("sweepStatusOf: ran only on a claim WITH sweep-phase telemetry; every gap or contradiction is unknown", () => {
    const of = (
      owed: boolean,
      claim: "ran" | "not_owed" | "not_reached" | null,
      sweepPasses: number | null,
      receiptSettled = false,
    ) => sweepStatusOf({ owed, claim, sweepPasses, receiptSettled }).status;
    expect(of(true, "ran", 3)).toBe("ran");
    expect(of(true, "ran", 0)).toBe("unknown");
    expect(of(true, "ran", null)).toBe("unknown");
    expect(of(true, "ran", 3, true)).toBe("unknown");
    expect(of(true, "not_reached", 0)).toBe("not_reached");
    expect(of(true, "not_reached", 2)).toBe("unknown");
    expect(of(true, "not_owed", 0)).toBe("not_reached");
    // An APPROVE cannot have decided REQUEST_CHANGES first: a contradiction.
    const approved = (claim: "not_owed" | "not_reached") =>
      sweepStatusOf({
        owed: true,
        claim,
        sweepPasses: 0,
        receiptSettled: false,
        verdict: "APPROVE",
      });
    expect(approved("not_reached").status).toBe("unknown");
    expect(approved("not_owed").status).toBe("unknown");
    expect(approved("not_reached").note).toContain("approved");
    expect(
      sweepStatusOf({
        owed: true,
        claim: "not_reached",
        sweepPasses: 0,
        receiptSettled: false,
        verdict: "REQUEST_CHANGES",
      }).status,
    ).toBe("not_reached");
    expect(of(true, null, 0)).toBe("unknown");
    expect(of(true, null, 3)).toBe("unknown");
    expect(of(false, "ran", 3)).toBe("not_owed");
    expect(of(false, "not_owed", 0)).toBe("not_owed");
    expect(
      sweepStatusOf({ owed: true, claim: "ran", sweepPasses: 0, receiptSettled: false }).note,
    ).toContain("no sweep-phase pass");
  });

  it("a delta round that decided REQUEST_CHANGES before the sweep raises no pass_plan_mismatch and no skip", async () => {
    const { hooks, overseer } = recordingHooks();
    const id = followUpRound(700, { sweepOwed: true });
    await watcher({}, hooks).handleFile(
      write(700, 1, verdictFile({ pr: 700, sweep: "not_reached", passes: DELTA_PASSES })),
    );
    expect(row(id)).toMatchObject({ status: "done", sweep_status: "not_reached" });
    expect(count("pass_plan_mismatch")).toBe(0);
    expect(anomalyKinds()).not.toContain("followup_sweep_skipped");
    expect(overseer).toEqual([]);
    expect(store.fullLookSinceFirst(700)).toBe(false);
  });

  it("an APPROVE whose sweep ran: status ran, both stages conform, and the full look is counted", async () => {
    const { hooks, overseer } = recordingHooks();
    const id = followUpRound(701, { sweepOwed: true });
    await watcher({}, hooks).handleFile(
      write(
        701,
        1,
        verdictFile({
          pr: 701,
          verdict: "APPROVE",
          sweep: "ran",
          passes: [...DELTA_PASSES, ...SWEEP_PASSES],
        }),
      ),
    );
    expect(row(id)).toMatchObject({ verdict: "APPROVE", sweep_status: "ran" });
    expect(count("pass_plan_mismatch")).toBe(0);
    expect(anomalyKinds()).not.toContain("followup_sweep_skipped");
    expect(overseer).toEqual([]);
    expect(store.fullLookSinceFirst(701)).toBe(true);
    // Both stages' passes are kept, phases included.
    expect(store.executedPasses(id)?.filter((p) => p.phase === "sweep")).toHaveLength(3);
  });

  it("a sweep that ran short of its plan is a mismatch on the sweep's lenses alone", async () => {
    const id = followUpRound(702, { sweepOwed: true });
    await watcher().handleFile(
      write(
        702,
        1,
        verdictFile({
          pr: 702,
          verdict: "APPROVE",
          sweep: "ran",
          passes: [...DELTA_PASSES, SWEEP_PASSES[0], SWEEP_PASSES[2]],
        }),
      ),
    );
    expect(row(id).sweep_status).toBe("ran");
    expect(mismatch()).toMatchObject({
      planned: ["pass-baseline", "pass-validate"],
      missing: ["sweep:pass-security"],
      wrong_tier: [],
      sweep_planned: ["pass-baseline", "pass-security", "pass-validate"],
      sweep_status: "ran",
    });
  });

  it("an APPROVE that claims the sweep with no sweep-phase telemetry: unknown, not a full look, the quiet followup_sweep_skipped", async () => {
    const { hooks, overseer } = recordingHooks();
    const id = followUpRound(703, { sweepOwed: true });
    await watcher({}, hooks).handleFile(
      write(
        703,
        1,
        verdictFile({ pr: 703, verdict: "APPROVE", sweep: "ran", passes: DELTA_PASSES }),
      ),
    );
    expect(row(id)).toMatchObject({ verdict: "APPROVE", sweep_status: "unknown" });
    expect(store.getPr(703)!.state).toBe("tracked"); // telemetry, never a veto
    expect(anomalyKinds()).toContain("followup_sweep_skipped");
    // Quiet: no overseer wake for it.
    expect(overseer.some((m) => m.includes("followup_sweep_skipped"))).toBe(false);
    expect(overseer).toEqual([]);
    expect(store.fullLookSinceFirst(703)).toBe(false);
  });

  it("an APPROVE with the sweep owed and reported not reached is a skip too", async () => {
    followUpRound(704, { sweepOwed: true });
    await watcher().handleFile(
      write(
        704,
        1,
        verdictFile({ pr: 704, verdict: "APPROVE", sweep: "not_reached", passes: DELTA_PASSES }),
      ),
    );
    expect(anomalyKinds()).toContain("followup_sweep_skipped");
  });

  it("a withheld approval (APPROVE + approval_withheld) owes the sweep the same way", async () => {
    followUpRound(709, { sweepOwed: true });
    await watcher().handleFile(
      write(
        709,
        1,
        verdictFile({
          pr: 709,
          verdict: "APPROVE",
          approval_withheld: true,
          sweep: "not_reached",
          passes: DELTA_PASSES,
        }),
      ),
    );
    expect(anomalyKinds()).toContain("followup_sweep_skipped");
  });

  it("a round with no sweep owed records not_owed and never raises the skip", async () => {
    const id = followUpRound(705, { sweepOwed: false });
    await watcher().handleFile(
      write(
        705,
        1,
        verdictFile({ pr: 705, verdict: "APPROVE", sweep: "not_owed", passes: DELTA_PASSES }),
      ),
    );
    expect(row(id).sweep_status).toBe("not_owed");
    expect(count("pass_plan_mismatch")).toBe(0);
    expect(anomalyKinds()).not.toContain("followup_sweep_skipped");
  });

  // MUTATION: drop the optional branch from comparePlan — a run optional
  // row (no reason owed) reads as a missing-reason addition.
  it("an offered optional row the session ran is conformant without a reason; at a tier it may not use, it is not", async () => {
    for (const [pr, tier, mismatches] of [
      [208, "terra-med", 0],
      [209, "sol-xhigh", 1],
    ] as const) {
      const id = policyRound(pr);
      store.setRoundMeta(id, {
        addable_passes: [
          { lens: "pass-concurrency", tier: "sol-med" },
          {
            lens: "pass-maintainability",
            tier: "terra-med",
            optional: true,
            raisable_to: ["pass-maintainability--sol-med"],
          } as { lens: string; tier: string },
        ],
      });
      await watcher().handleFile(
        write(
          pr,
          1,
          verdictFile({
            pr,
            passes: [
              { name: "pass-baseline", tier: "sol-med", findings: 0 },
              { name: "pass-maintainability", tier, findings: 0 },
              { name: "pass-validate", tier: "sol-high", findings: 0 },
            ],
          }),
        ),
      );
      const rows = store.db
        .prepare("SELECT payload FROM events WHERE kind = 'pass_plan_mismatch' AND pr = ?")
        .all(pr) as Array<{ payload: string }>;
      expect(rows.length, `${pr}`).toBe(mismatches);
      if (mismatches)
        expect(JSON.parse(rows[0]!.payload)).toMatchObject({
          wrong_tier: ["pass-maintainability"],
          missing_reason: [],
          unknown_additions: [],
        });
    }
  });

  it("a verdict settled from the posting receipt records the sweep UNKNOWN — never a full look", async () => {
    const id = followUpRound(706, { sweepOwed: true });
    const { key } = stampPosting(706, 1);
    writePostingReceipt(706, 1, key, "APPROVE");
    await watcher().handleFile(write(706, 1, `{"pr": 706, "round_no": 1, "verdi`));
    expect(row(id)).toMatchObject({ status: "done", verdict: "APPROVE", sweep_status: "unknown" });
    expect(anomalyKinds()).toContain("followup_sweep_skipped");
    expect(store.fullLookSinceFirst(706)).toBe(false);
  });

  it("a round that is not a follow-up is untouched: no sweep status, phases ignored by the plan check", async () => {
    const id = policyRound(707);
    await watcher().handleFile(
      write(
        707,
        1,
        verdictFile({
          pr: 707,
          verdict: "APPROVE",
          sweep: "ran",
          passes: [
            { name: "pass-baseline", tier: "sol-med", phase: "sweep", findings: 0 },
            { name: "pass-validate", tier: "sol-high", findings: 0 },
          ],
        }),
      ),
    );
    expect(row(id).sweep_status).toBeNull();
    expect(count("followup_sweep_recorded")).toBe(0);
    expect(count("pass_plan_mismatch")).toBe(0);
    expect(anomalyKinds()).not.toContain("followup_sweep_skipped");
  });

  it("tailPlannedLenses: the sweep's lenses join the plan only when the sweep ran", () => {
    const round = { lenses: "pass-baseline,pass-validate", sweep_plan: JSON.stringify(SWEEP_PLAN) };
    expect(tailPlannedLenses(round, "ran")).toBe("pass-baseline,pass-validate,pass-security");
    expect(tailPlannedLenses(round, "unknown")).toBe("pass-baseline,pass-validate");
    expect(tailPlannedLenses(round, null)).toBe("pass-baseline,pass-validate");
    expect(tailPlannedLenses({ ...round, sweep_plan: "{not json" }, "ran")).toBe(
      "pass-baseline,pass-validate",
    );
  });

  it("findings from a sweep that ran are planned work, never stamped unplanned", async () => {
    const findingsDir = join(dir, "state", "findings");
    mkdirSync(findingsDir, { recursive: true });
    writeFileSync(
      join(findingsDir, "pr-708-round-1.json"),
      JSON.stringify({
        pr: 708,
        round_no: 1,
        findings: [
          { id: "a", lens: "pass-baseline", disposition: "posted" },
          { id: "b", lens: "pass-security", disposition: "posted" },
          { id: "c", lens: "pass-concurrency", disposition: "posted" },
        ],
      }),
    );
    followUpRound(708, { sweepOwed: true });
    await watcher({ ledgerCheckDelayMs: 0, findingsDir }).handleFile(
      write(
        708,
        1,
        verdictFile({
          pr: 708,
          verdict: "APPROVE",
          sweep: "ran",
          passes: [...DELTA_PASSES, ...SWEEP_PASSES],
        }),
      ),
    );
    expect(store.findingsForRound(708, 1).map((r) => [r.lens, r.unplanned])).toEqual([
      ["pass-baseline", 0],
      ["pass-security", 0],
      ["pass-concurrency", 1],
    ]);
  });
});

// ---- a failure is opened only by the round's owner, before any await -------

describe("ownership after awaits: a round some other path ended owes nothing", () => {
  const countOf = (kind: string, pr: number): number =>
    (
      store.db
        .prepare("SELECT COUNT(*) AS c FROM events WHERE kind = ? AND pr = ?")
        .get(kind, pr) as { c: number }
    ).c;
  const later = (): Date => new Date(Date.now() + (cfg.daemon.round_deadline_min + 5) * 60_000);

  // MUTATION: in failPostingProof, take the in-progress label off before
  // openReviewFailure — a restart inside that call leaves a cancelled round
  // with no incident, and the label call here sees none.
  it("a posting failure owes its FAILED_LOUD incident before its label call", async () => {
    reviewingRound(700);
    stampPosting(700, 1);
    let owedAtLabel: number | undefined;
    adapter.removeLabel = async (n, label) => {
      adapter.calls.push(`removeLabel:${n}:${label}`);
      owedAtLabel = store.openReviewFailure(700)?.work_owed;
      return { executed: false, dryRunFile: "d" };
    };

    expect(
      await watcher({ postingReceiptGraceS: 0 }).handleFile(
        write(700, 1, verdictFile({ pr: 700 })),
      ),
    ).toBe(true);

    expect(owedAtLabel).toBe(1);
    expect(store.roundsFor(700)[0]).toMatchObject({ cancel_cause: "infrastructure_failure" });
  });

  // MUTATION: in handleAnomaly, take the label off before the transition and
  // the incident — the label call sees the PR still reviewing, nothing owed.
  it("an anomaly owes its incident and leaves reviewing before its label call", async () => {
    reviewingRound(701);
    let atLabel: { owed?: number; state?: string } = {};
    adapter.removeLabel = async (n, label) => {
      adapter.calls.push(`removeLabel:${n}:${label}`);
      atLabel = { owed: store.openReviewFailure(701)?.work_owed, state: store.getPr(701)?.state };
      return { executed: false, dryRunFile: "d" };
    };

    expect(await watcher().handleFile(write(701, 1, "{broken"))).toBe(true);

    expect(atLabel.owed).toBe(1);
    expect(atLabel.state).not.toBe("reviewing");
  });

  // MUTATION: drop the claim at the top of failPostingProof — the operator's
  // `u` landing during the marker read is overwritten by a FAILED_LOUD hold.
  it("an operator's u during the posting proof's GitHub read is not undone by a failure", async () => {
    reviewingRound(702);
    stampPosting(702, 1);
    adapter.listReviewsFull = async () => {
      store.cancelRunningRounds(702, "rerun-round");
      store.setPrState(702, "queued");
      return [];
    };

    expect(
      await watcher({ cfg: { ...cfg, dry_run: false }, postingReceiptGraceS: 0 }).handleFile(
        write(702, 1, verdictFile({ pr: 702 })),
      ),
    ).toBe(true);

    expect(store.openReviewFailure(702)).toBeUndefined();
    expect(store.getPr(702)?.state).toBe("queued");
    expect(store.roundsFor(702)[0]).toMatchObject({ cancel_cause: "operator" });
    expect(countOf("posting_failure_round_ended", 702)).toBe(1);
  });

  // MUTATION: call failPostingProof directly from the deadline's failed-proof
  // branch — the verdict the session committed during the marker read is
  // failed under it.
  it("the deadline leaves a verdict that arrived during its posting proof to the sweep", async () => {
    reviewingRound(703);
    const { key } = stampPosting(703, 1);
    const live = { ...cfg, dry_run: false };
    adapter.listReviewsFull = async () => {
      // The session posts, records its receipt and commits its verdict
      // while the deadline's marker read is out.
      writePostingReceipt(703, 1, key, "REQUEST_CHANGES");
      write(703, 1, verdictFile({ pr: 703 }));
      return [];
    };
    const w = watcher({ cfg: live, now: later, postingReceiptGraceS: 0 });

    await w.checkDeadlines();

    expect(store.openReviewFailure(703)).toBeUndefined();
    expect(store.roundsFor(703)[0]?.status).toBe("running");
    adapter.listReviewsFull = undefined;
    expect(await w.handleFile("pr-703-round-1.json")).toBe(true);
    expect(store.roundsFor(703)[0]).toMatchObject({ status: "done", verdict: "REQUEST_CHANGES" });
    expect(store.openReviewFailure(703)).toBeUndefined();
  });

  // MUTATION: drop the not-running return at the top of handleAnomaly — the
  // round a verdict settled during the liveness probe gets a FAILED_LOUD hold.
  it("the deadline opens no anomaly for a round settled while its liveness probe was out", async () => {
    const roundId = reviewingRound(704);
    const h = recordingHooks();
    h.hooks.sessionAlive = async () => {
      store.finishRound(roundId, "APPROVE", null, null);
      store.setPrState(704, "tracked");
      return false;
    };
    const w = watcher(
      { cfg: { ...cfg, daemon: { ...cfg.daemon, max_self_requeues: 0 } }, now: later },
      h.hooks,
    );

    expect(await w.checkDeadlines()).toEqual([704]);

    expect(store.openReviewFailure(704)).toBeUndefined();
    expect(store.getPr(704)?.state).toBe("tracked");
    expect(store.roundsFor(704)[0]?.status).toBe("done");
    expect(countOf("anomaly_round_ended", 704)).toBe(1);
  });

  // MUTATION: drop the later-round check at the top of apply — the resumed
  // apply of round 1 moves the PR out from under running round 2.
  it("an interrupted apply resumed after a later round started lands nothing over it", async () => {
    reviewingRound(705);
    const { key } = stampPosting(705, 1);
    writePostingReceipt(705, 1, key, "REQUEST_CHANGES");
    const round = store.roundsFor(705)[0]!;
    store.finishRound(round.id, "REQUEST_CHANGES", null, null);
    // Restart: the successor was promoted and its round dispatched first.
    store.startRound(705, "re-review", ["pass-baseline"], cfg.daemon.round_deadline_min);
    store.setPrState(705, "reviewing");

    expect(await watcher().handleFile(write(705, 1, verdictFile({ pr: 705 })))).toBe(true);

    expect(store.getPr(705)?.state).toBe("reviewing");
    expect(store.reviewedHead(705)).toBeUndefined();
    expect(adapter.calls).toEqual([]);
    expect(countOf("verdict_resume_superseded", 705)).toBe(1);
    // Settled: a second sweep does not resume it again.
    expect(await watcher().handleFile(write(705, 1, verdictFile({ pr: 705 })))).toBe(true);
    expect(countOf("verdict_resume_superseded", 705)).toBe(1);
    expect(countOf("verdict_replay_ignored", 705)).toBe(1);
  });

  // MUTATION: restrict the claim's later-round check to `cancelled` claims —
  // the resumed done round reapplies its verdict over the round started
  // during its label calls.
  it("an interrupted apply is not finished over a round that started during its label calls", async () => {
    reviewingRound(706);
    const { key } = stampPosting(706, 1);
    writePostingReceipt(706, 1, key, "REQUEST_CHANGES");
    const round = store.roundsFor(706)[0]!;
    store.finishRound(round.id, "REQUEST_CHANGES", null, null);
    store.setPrState(706, "awaiting_author");
    adapter.addLabel = async (n, label) => {
      adapter.calls.push(`addLabel:${n}:${label}`);
      store.startRound(706, "re-review", ["pass-baseline"], cfg.daemon.round_deadline_min);
      store.setPrState(706, "reviewing");
      return { executed: false, dryRunFile: "d" };
    };

    expect(await watcher().handleFile(write(706, 1, verdictFile({ pr: 706 })))).toBe(true);

    expect(store.getPr(706)?.state).toBe("reviewing");
    expect(store.reviewedHead(706)).toBeUndefined();
    expect(countOf("verdict_resume_superseded", 706)).toBe(1);
    expect(store.roundsFor(706).map((r) => [r.round_no, r.status])).toEqual([
      [1, "done"],
      [2, "running"],
    ]);
  });
});

describe("a verdict's usage window ends at its claim", () => {
  // MUTATION: owe the measurement with `this.now()` at verdict_settled — the
  // CI read's wait lets a successor's transcript into this round's window.
  it("tokens written after the round finished — while the apply awaited GitHub — are not this round's", async () => {
    const roundId = reviewingRound(710);
    const at = (offsetMin: number, input: number): string =>
      JSON.stringify({
        type: "message",
        timestamp: new Date(Date.now() + offsetMin * 60_000).toISOString(),
        message: { role: "assistant", usage: { input, output: 0 } },
      });
    const sessionDir = join(dir, cfg.pi.session_dir, "pr-710");
    mkdirSync(sessionDir, { recursive: true });
    writeFileSync(
      join(sessionDir, "session.jsonl"),
      // The round's own turn, then a successor's half an hour later.
      [at(0, 10), at(30, 1000)].join("\n"),
    );
    let clock = new Date(Date.now() + 1000);
    adapter.listChecks = async () => {
      clock = new Date(Date.now() + 60 * 60_000);
      return [];
    };

    expect(
      await watcher({ now: () => clock }).handleFile(
        write(710, 1, verdictFile({ pr: 710, verdict: "APPROVE", approval_withheld: true })),
      ),
    ).toBe(true);

    expect(store.roundsFor(710)[0]?.status).toBe("done");
    expect(tokensIn(roundId)).toBe(10);
  });
});

describe("review rework: loud where nothing repairs, measured where the window is known", () => {
  const countOf = (kind: string, pr: number): number =>
    (
      store.db
        .prepare("SELECT COUNT(*) AS c FROM events WHERE kind = ? AND pr = ?")
        .get(kind, pr) as { c: number }
    ).c;

  // MUTATION: drop `resumed` from failPostingProof's claim — a done round
  // whose resumed apply cannot prove its posting is archived quietly, its PR
  // left where the interrupted apply stopped.
  it("a done round's resumed apply whose posting proof fails stays loud", async () => {
    reviewingRound(720);
    stampPosting(720, 1);
    const round = store.roundsFor(720)[0]!;
    // Killed right after the claim: done, never settled, no receipt to prove.
    store.finishRound(round.id, "REQUEST_CHANGES", null, null);

    expect(
      await watcher({ postingReceiptGraceS: 0 }).handleFile(
        write(720, 1, verdictFile({ pr: 720 })),
      ),
    ).toBe(true);

    expect(store.openReviewFailure(720)).toMatchObject({
      stage: "posting_receipt",
      work_owed: 1,
    });
    expect(store.roundsFor(720)[0]?.status).toBe("done");
  });

  // MUTATION: leave the superseded resume unmeasured — its tokens read NULL.
  it("a superseded resume measures its own usage, up to its claim", async () => {
    const roundId = reviewingRound(721);
    const { key } = stampPosting(721, 1);
    writePostingReceipt(721, 1, key, "REQUEST_CHANGES");
    const sessionDir = join(dir, cfg.pi.session_dir, "pr-721");
    mkdirSync(sessionDir, { recursive: true });
    const line = (offsetMin: number, input: number): string =>
      JSON.stringify({
        type: "message",
        timestamp: new Date(Date.now() + offsetMin * 60_000).toISOString(),
        message: { role: "assistant", usage: { input, output: 0 } },
      });
    // Round 1's turn, then (after its claim) round 2's.
    writeFileSync(join(sessionDir, "session.jsonl"), [line(-1, 10), line(30, 1000)].join("\n"));
    store.db
      .prepare("UPDATE rounds SET started_at = ? WHERE id = ?")
      .run(new Date(Date.now() - 2 * 60_000).toISOString(), roundId);
    store.finishRound(roundId, "REQUEST_CHANGES", null, null);
    store.startRound(721, "re-review", ["pass-baseline"], cfg.daemon.round_deadline_min);
    store.setPrState(721, "reviewing");

    expect(
      await watcher({ now: () => new Date(Date.now() + 60 * 60_000) }).handleFile(
        write(721, 1, verdictFile({ pr: 721 })),
      ),
    ).toBe(true);

    expect(countOf("verdict_resume_superseded", 721)).toBe(1);
    expect(tokensIn(roundId)).toBe(10);
  });

  // MUTATION: drop the not-running return at the top of handleAnomaly — the
  // old session's late malformed file re-holds the PR the operator released.
  it("a malformed file reaching an overdue round after the operator's u opens nothing", async () => {
    const roundId = reviewingRound(722);
    store.markRoundOverdue(roundId);
    // `u`: the incident resolved, the PR queued again.
    store.setPrState(722, "queued");

    expect(await watcher().handleFile(write(722, 1, "{broken"))).toBe(true);

    expect(store.openReviewFailure(722)).toBeUndefined();
    expect(store.getPr(722)?.state).toBe("queued");
    expect(countOf("anomaly_round_ended", 722)).toBe(1);
  });
});

describe("grouped plan telemetry retains every row policy", () => {
  const row = (tier: string, raises: string[] = []) => ({
    lens: "pass-sweep",
    agent: `pass-sweep--${tier}`,
    tier,
    raisable_to: raises,
  });
  const mismatch = () => {
    const event = store.db
      .prepare(
        "SELECT payload FROM events WHERE kind = 'pass_plan_mismatch' ORDER BY id DESC LIMIT 1",
      )
      .get() as { payload: string } | undefined;
    return event ? JSON.parse(event.payload) : undefined;
  };
  async function run(rows: ReturnType<typeof row>[], tiers: string[], optional = false) {
    const id = policyRound(820);
    store.db.prepare("UPDATE rounds SET pass_plan=?,addable_passes=? WHERE id=?").run(
      JSON.stringify(optional ? [] : rows),
      JSON.stringify(
        optional
          ? rows.map((r) => ({
              lens: r.lens,
              tier: r.tier,
              raisable_to: r.raisable_to,
              optional: true,
            }))
          : [],
      ),
      id,
    );
    const { hooks } = recordingHooks();
    await watcher({}, hooks).handleFile(
      write(
        820,
        1,
        verdictFile({
          pr: 820,
          passes: tiers.map((tier) => ({ name: "pass-sweep", tier, findings: 0 })),
        }),
      ),
    );
  }
  it("does not let the final low-tier row license every production sweep", async () => {
    await run(
      [row("sol-high"), row("sol-high"), row("terra-med")],
      ["terra-med", "terra-med", "terra-med"],
    );
    expect(mismatch()?.wrong_tier).toHaveLength(2);
  });
  it("accepts each row's actual tier regardless of row or execution order", async () => {
    await run(
      [row("sol-high"), row("sol-high"), row("terra-med")],
      ["terra-med", "sol-high", "sol-high"],
    );
    expect(mismatch()).toBeUndefined();
  });
  it("assigns a raise without consuming the only row a lower tier can satisfy", async () => {
    await run(
      [row("terra-med", ["pass-sweep--sol-high"]), row("sol-high")],
      ["sol-high", "terra-med"],
    );
    expect(mismatch()).toBeUndefined();
  });
  it("counts missing executions for repeated rows of the same lens", async () => {
    await run([row("terra-med"), row("terra-med")], ["terra-med"]);
    expect(mismatch()?.missing).toEqual(["pass-sweep"]);
  });
  it("retains all offered optional tiers", async () => {
    await run([row("sol-high"), row("terra-med")], ["sol-high"], true);
    expect(mismatch()).toBeUndefined();
  });
});

describe("settlement preserves earlier durable facts", () => {
  it("publishes measurement debt before settlement makes verdict replay inert", async () => {
    const id = reviewingRound(734);
    const original = store.logEvent.bind(store);
    let owedAtSettlement: string | null | undefined;
    store.logEvent = (kind, pr, payload) => {
      if (kind === "verdict_settled")
        owedAtSettlement = store.roundsFor(734).find((r) => r.id === id)?.usage_owed_to;
      return original(kind, pr, payload);
    };
    await watcher().handleFile(write(734, 1, verdictFile({ pr: 734 })));
    expect(owedAtSettlement).toEqual(expect.any(String));
  });

  it("retains measurement debt when neither usage nor an unknown result can be persisted", async () => {
    const id = reviewingRound(735);
    const recordUsage = store.recordRoundUsage.bind(store);
    const logEvent = store.logEvent.bind(store);
    store.recordRoundUsage = () => {
      throw new Error("database full during usage write");
    };
    store.logEvent = (kind, pr, payload) => {
      if (kind === "round_usage_unknown") throw new Error("database full during unknown write");
      return logEvent(kind, pr, payload);
    };
    await watcher().handleFile(write(735, 1, verdictFile({ pr: 735 })));
    expect(store.roundsFor(735).find((r) => r.id === id)?.usage_owed_to).toEqual(
      expect.any(String),
    );
    store.recordRoundUsage = recordUsage;
    store.logEvent = logEvent;
    const restarted = watcher();
    await restarted.sweep();
    await restarted.idle();
    expect(store.roundsFor(735).find((r) => r.id === id)?.usage_owed_to).toBeNull();
  });

  it("resuming a done apply preserves its first completion and usage window", async () => {
    store.close();
    let clock = new Date("2026-08-13T12:00:00.000Z");
    store = new StateStore(":memory:", () => clock);
    const id = reviewingRound(730);
    const { key } = stampPosting(730, 1);
    writePostingReceipt(730, 1, key, "REQUEST_CHANGES");
    clock = new Date(clock.getTime() + 10_000);
    store.finishRound(id, "REQUEST_CHANGES", null);
    const first = store.roundsFor(730)[0]!;
    clock = new Date(clock.getTime() + 120_000);
    await watcher({ now: () => clock }).handleFile(write(730, 1, verdictFile({ pr: 730 })));
    expect(store.roundsFor(730)[0]).toMatchObject({
      finished_at: first.finished_at,
      duration_s: first.duration_s,
    });
  });

  it("enriching a posted round keeps an author reply that arrived after posting", async () => {
    reviewingRound(731);
    store.recordReviewedHead(731, {
      head_sha: "abc123",
      posted_event: "REQUEST_CHANGES",
      round_no: 1,
    });
    const stamped = store.reviewedHead(731)!;
    const replyAt = new Date(Date.parse(stamped.reviewed_at) + 1000).toISOString();
    adapter.removeLabel = async () => {
      store.noteAuthorReply(731, replyAt);
      return { executed: false, dryRunFile: "d" };
    };
    await watcher().handleFile(write(731, 1, verdictFile({ pr: 731 })));
    expect(store.reviewedHead(731)).toMatchObject({
      reviewed_at: stamped.reviewed_at,
      last_author_reply_at: replyAt,
      verdict: "REQUEST_CHANGES",
    });
  });

  it("does not report ordinary queued wakes as stranded behind a non-round owner", async () => {
    reviewingRound(732);
    store.finishRound(store.roundsFor(732)[0]!.id, "APPROVE", null);
    store.setPrState(732, "tracked");
    store.createSessionCommand({
      id: "owning-wake",
      pr: 732,
      session: "pr-732",
      kind: "wake",
      round_no: null,
      payload_path: join(dir, "owner.md"),
      payload_sha256: "a".repeat(64),
      inject_path: join(dir, "inject.md"),
      next_check_at: "2099-01-01T00:00:00.000Z",
    });
    store.holdWake(732, "later FIFO wake", "ordinary");
    const h = recordingHooks();
    await watcher({}, h.hooks).checkDeadlines();
    expect(
      store.db.prepare("SELECT * FROM events WHERE pr=732 AND kind='wakes_stranded'").all(),
    ).toEqual([]);
    expect(store.heldWakes(732)).toHaveLength(1);
    expect(h.injects).toEqual([]);
  });

  it("reconciles a marker-confirmed COMMENT using the surviving withheld approval intent", async () => {
    const id = reviewingRound(733);
    const { key } = stampPosting(733, 1);
    writePostingReceipt(733, 1, key, "APPROVE", {
      status: "deferred",
      deferred_at: "2026-08-13T12:00:00.000Z",
      gh_review_id: undefined,
      gh_commit_id: undefined,
      gh_state: undefined,
    });
    adapter.listReviewsFull = async () => [
      {
        id: 7331,
        user: cfg.github.bot_login,
        user_type: "Bot",
        state: "COMMENTED",
        body: `review\n\n${postingMarker(key)}`,
        commit_id: "abc123",
        submitted_at: "2026-08-13T12:00:00.000Z",
      },
    ];
    await watcher({ cfg: { ...cfg, dry_run: false } }).handleFile(
      write(
        733,
        1,
        verdictFile({
          pr: 733,
          verdict: "APPROVE",
        }),
      ),
    );
    expect(store.roundsFor(733)[0]).toMatchObject({ id, status: "done", verdict: "APPROVE" });
    expect(store.openReviewFailure(733)).toBeUndefined();
    expect(store.approvalWithheld(733)?.head_sha).toBe("abc123");
  });
});

describe("round tail survives process restart", () => {
  it("resumes an enabled escalation interrupted after the settled marker", async () => {
    reviewingRound(742);
    const escalation = parseEscalation({
      enabled: true,
      targets: ["teammate-one"],
      rules: [{ name: "all", to: "teammate-one", why: "you own this code", paths: ["**"] }],
    });
    let release!: () => void;
    let reached!: () => void;
    const entered = new Promise<void>((r) => {
      reached = r;
    });
    const blocked = new Promise<void>((r) => {
      release = r;
    });
    let comments = 0;
    let firstRead = true;
    const escAdapter: VerdictAdapter = {
      addLabel: adapter.addLabel.bind(adapter),
      removeLabel: adapter.removeLabel.bind(adapter),
      async listPrFiles() {
        if (firstRead) {
          firstRead = false;
          reached();
          await blocked;
        }
        return [{ filename: "a.py" }];
      },
      async getPr() {
        return { labels: [] };
      },
      async createReview() {
        comments++;
        return { executed: true };
      },
    };
    const deps = { cfg: { ...cfg, escalation }, adapter: escAdapter };
    const interrupted = watcher(deps).handleFile(write(742, 1, verdictFile({ pr: 742 })));
    await entered;
    const restarted = watcher(deps);
    let deliveredAfterRestart: number;
    try {
      await restarted.sweep();
      await restarted.idle();
      deliveredAfterRestart = comments;
    } finally {
      release();
      await interrupted;
    }
    expect(deliveredAfterRestart).toBe(1);
    expect(comments).toBe(1);
    await restarted.sweep();
    await restarted.idle();
    expect(comments).toBe(1);
  });

  it("resumes the delayed findings and ledger checks exactly once", async () => {
    let clock = new Date();
    const id = reviewingRound(740);
    const findingsDir = join(dir, "state", "findings");
    mkdirSync(findingsDir, { recursive: true });
    writeFileSync(
      join(findingsDir, "pr-740-round-1.json"),
      JSON.stringify({
        pr: 740,
        round_no: 1,
        findings: [{ id: "a", lens: "pass-baseline", disposition: "posted" }],
      }),
    );
    const first = watcher({ findingsDir, ledgerCheckDelayMs: 90_000, now: () => clock });
    await first.handleFile(write(740, 1, verdictFile({ pr: 740 })));
    expect(store.findingsForRound(740, 1)).toEqual([]);
    clock = new Date(clock.getTime() + 91_000);
    const restarted = watcher({ findingsDir, now: () => clock });
    await restarted.sweep();
    await restarted.idle();
    expect(store.findingsForRound(740, 1)).toHaveLength(1);
    const recorded = () =>
      store.db.prepare("SELECT * FROM events WHERE pr=740 AND kind='findings_recorded'").all();
    expect(recorded()).toHaveLength(1);
    expect(store.roundsFor(740)[0]).toMatchObject({ id, status: "done" });
    await restarted.sweep();
    await restarted.idle();
    expect(recorded()).toHaveLength(1);
  });

  it.each([false, true])(
    "resumes a consumed findings hook after its dependency becomes ready (missing verdict directory: %s)",
    async (missingVerdictDir) => {
      reviewingRound(741);
      const findingsDir = join(dir, "state", "findings");
      mkdirSync(findingsDir, { recursive: true });
      writeFileSync(
        join(findingsDir, "pr-741-round-1.json"),
        JSON.stringify({
          pr: 741,
          round_no: 1,
          findings: [{ id: "a", lens: "pass-baseline", disposition: "posted" }],
        }),
      );
      await watcher({
        findingsDir,
        ledgerCheckDelayMs: 0,
        onFindingsRecorded: () => {
          throw new Error("lesson ledger is not ready during boot");
        },
      }).handleFile(write(741, 1, verdictFile({ pr: 741 })));
      expect(store.findingsForRound(741, 1)).toHaveLength(1);
      let completed = 0;
      const restarted = watcher({
        findingsDir,
        ...(missingVerdictDir ? { verdictDir: join(dir, "absent-verdict-directory") } : {}),
        onFindingsRecorded: () => {
          completed++;
        },
      });
      await restarted.sweep();
      await restarted.idle();
      expect(completed).toBe(1);
      await restarted.sweep();
      await restarted.idle();
      expect(completed).toBe(1);
    },
  );
});

describe("escalation facts from the reasoning record", () => {
  it("a posted finding keeps the title the session wrote, not its reason", () => {
    const findingsDir = join(dir, "findings");
    mkdirSync(findingsDir, { recursive: true });
    writeFileSync(
      join(findingsDir, "pr-61-round-1.json"),
      JSON.stringify({
        pr: 61,
        round_no: 1,
        head_sha: "abc123",
        findings: [
          {
            key: "f1",
            lens: "pass-security",
            severity: "P1",
            disposition: "posted",
            title: "the retry budget is unbounded",
          },
        ],
      }),
    );
    const w = watcher({ findingsDir });
    const facts = (w as any).escalationFindings(61, 1, true) as Array<{ title?: string | null }>;
    expect(facts).toHaveLength(1);
    expect(facts[0]?.title).toBe("the retry budget is unbounded");
  });
});
