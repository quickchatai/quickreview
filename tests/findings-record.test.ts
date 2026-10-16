// The durable reasoning record: every verdicted
// round leaves `state/findings/pr-<n>-round-<k>.json` saying which lens raised
// each candidate, what severity/confidence/reachability it carried, whether the
// validator killed it and why — and whether a finding was refuted-and-conceded.
//
// The half these tests exist for is the FAILURE path, because getting it wrong
// wedges live reviews: a record that NEVER arrives must leave the round fully
// completed (verdict applied, round row done, PR transitioned, labels moved)
// and must earn exactly ONE re-nudge, never two, never a loop.
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { parseConfig, type Config } from "../src/config.js";
import {
  enforceFindingsRecord,
  findingsRecordWake,
  isConformant,
  isKnownVocabularyWord,
  normalizeDisposition,
  normalizePriorStatus,
  parseFindingsRecord,
  parsePriorRef,
  readFindingsRecord,
  type FindingsCheckDeps,
} from "../src/findingsrecord.js";
import type { GateResult } from "../src/gate.js";
import { RecheckWatcher } from "../src/recheck.js";
import { StateStore } from "../src/state.js";
import type { SessionHooks } from "../src/types.js";
import { VerdictWatcher, type VerdictAdapter, type VerdictDeps } from "../src/verdicts.js";
import { HEAVY_TIMEOUT_MS } from "./helpers/suite-timeouts.js";

const cfg: Config = parseConfig(
  readFileSync(resolve(process.cwd(), "tests/fixtures/config.toml"), "utf8"),
);
const HEAD = "abcdef1234567890abcdef1234567890abcdef12";

let dir: string;
let store: StateStore;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "qcr-findings-"));
  store = new StateStore(":memory:");
});

afterEach(() => {
  store.close();
  rmSync(dir, { recursive: true, force: true });
});

function findingsDir(): string {
  return join(dir, "state", "findings");
}

function writeRecord(name: string, body: unknown): void {
  mkdirSync(findingsDir(), { recursive: true });
  writeFileSync(join(findingsDir(), name), typeof body === "string" ? body : JSON.stringify(body));
}

function deps(injects: string[]): FindingsCheckDeps {
  return {
    store,
    findingsDir: findingsDir(),
    inject: async (pr, message) => {
      injects.push(`${pr}:${message}`);
    },
  };
}

function anomalyKinds(): string[] {
  return store.anomalies().map((a) => a.kind);
}

const RECORD = {
  pr: 7,
  round_no: 2,
  head_sha: HEAD,
  comments_posted: 3,
  findings: [
    {
      id: "f1",
      path: "src/api/orders.py",
      line: 212,
      lens: "pass-security",
      tier: "sol-high",
      severity: "P1",
      confidence: 0.9,
      reachability: "routine",
      kind: "authz",
      evidence: "orders.py:212 reads order_id and never checks tenant",
      disposition: "posted",
      posted_as: "blocker",
      reason: "Cross-tenant read.",
    },
    {
      id: "f2",
      path: "src/api/orders.py",
      line: 88,
      lens: "pass-simplicity",
      severity: "P2",
      confidence: 0.6,
      reachability: "contrived",
      disposition: "killed",
      word: "duplicate",
      reason: "Same defect as f5, differently phrased.",
    },
  ],
};

// ---- schema + parser -------------------------------------------------------

describe("parseFindingsRecord", () => {
  it(
    "parses the documented shape, keeping lens, axes, word and reason",
    { timeout: HEAVY_TIMEOUT_MS },
    () => {
      const parsed = parseFindingsRecord(RECORD, 7, 2);
      expect(parsed.status).toBe("ok");
      const findings = parsed.record?.findings ?? [];
      expect(findings).toHaveLength(2);
      expect(findings[0]).toMatchObject({
        key: "f1",
        lens: "pass-security",
        severity: "P1",
        confidence: 0.9,
        reachability: "routine",
        disposition: "posted",
        posted_as: "blocker",
      });
      expect(findings[1]).toMatchObject({
        lens: "pass-simplicity",
        disposition: "killed",
        word: "duplicate",
      });
      expect(parsed.record?.comments_posted).toBe(3);
    },
  );

  it("is tolerant of model output: digit-strings, aliases, partial entries", () => {
    const parsed = parseFindingsRecord(
      {
        pr: "7",
        round_no: "2",
        posted_comments: "4",
        candidates: [
          { name: "pass-baseline", disposition: "survived", line: "12", path: "a.ts" },
          { lens: "pass-tests", disposition: "concede", raised_in_round: "1" },
          { disposition: "kill" },
        ],
      },
      7,
      2,
    );
    expect(parsed.status).toBe("ok");
    expect(parsed.record?.comments_posted).toBe(4);
    const f = parsed.record?.findings ?? [];
    expect(f[0]).toMatchObject({ lens: "pass-baseline", disposition: "posted", line: 12 });
    expect(f[1]).toMatchObject({ lens: "pass-tests", disposition: "conceded", raised_in_round: 1 });
    // An entry with no lens is KEPT (dropping it would lose the record) and noted.
    expect(f[2]?.lens).toBe("");
    expect(parsed.note).toContain("without a lens");
  });

  it("an empty findings array is a valid, honest record — not a miss", () => {
    const parsed = parseFindingsRecord({ pr: 7, round_no: 2, findings: [] }, 7, 2);
    expect(parsed.status).toBe("ok");
    expect(parsed.record?.findings).toEqual([]);
  });

  it("rejects only structural failures: not an object, wrong round, no findings array", () => {
    expect(parseFindingsRecord("nope", 7, 2).status).toBe("unparseable");
    expect(parseFindingsRecord([1, 2], 7, 2).status).toBe("unparseable");
    expect(parseFindingsRecord({ pr: 7, round_no: 3, findings: [] }, 7, 2).status).toBe(
      "wrong_round",
    );
    expect(parseFindingsRecord({ pr: 8, round_no: 2, findings: [] }, 7, 2).status).toBe(
      "wrong_round",
    );
    expect(parseFindingsRecord({ pr: 7, round_no: 2 }, 7, 2).status).toBe("no_findings_array");
  });

  it("a word outside the closed vocabulary is noted, kept verbatim, never a rejection", () => {
    // The vocabulary grows (feedback-shape was added later), so unknown words must parse.
    const parsed = parseFindingsRecord(
      {
        pr: 7,
        round_no: 2,
        findings: [{ lens: "pass-x", disposition: "killed", word: "brand-new-word" }],
      },
      7,
      2,
    );
    expect(parsed.status).toBe("ok");
    expect(parsed.record?.findings[0]?.word).toBe("brand-new-word");
    expect(parsed.note).toContain("closed vocabulary");
    expect(isKnownVocabularyWord("settled:12345")).toBe(true);
    expect(isKnownVocabularyWord("design-over-cap")).toBe(true);
    // The ask-human addendum licenses this downgrade word in the validator prompt.
    expect(isKnownVocabularyWord("ask-human-unnamed-defect")).toBe(true);
    expect(isKnownVocabularyWord("brand-new-word")).toBe(false);
  });

  it("normalizeDisposition folds plausible spellings onto the closed set", () => {
    expect(normalizeDisposition("Killed")).toBe("killed");
    expect(normalizeDisposition("refuted-and-conceded")).toBe("conceded");
    expect(normalizeDisposition("SURVIVED")).toBe("posted");
    expect(normalizeDisposition("who knows")).toBe("unknown");
    expect(normalizeDisposition(undefined)).toBe("unknown");
  });

  // The title is kept (the outcome linker matches a hand-written comment's
  // title line against it), and every entry's
  // key follows the one rule the live render route stamps into its marker.
  it("keeps a posted entry's title, on one line and capped, and never invents one", () => {
    const parsed = parseFindingsRecord(
      {
        findings: [
          { id: "F1", lens: "pass-ui", disposition: "posted", title: "  Two\n  lines  " },
          { id: "F2", lens: "pass-ui", disposition: "posted", reason: "No title here. More." },
          { id: "F3", lens: "pass-ui", disposition: "posted", title: "x".repeat(500) },
        ],
      },
      7,
      1,
    );
    const f = parsed.record!.findings;
    expect(f.map((e) => e.title?.length ?? null)).toEqual([9, null, 300]);
    expect(f[0]!.title).toBe("Two lines");
  });

  it("a key-less entry is keyed `<lens>@<path>:<line>#<index>` over the whole array", () => {
    const parsed = parseFindingsRecord(
      {
        findings: [
          { lens: "pass-ui", disposition: "killed", path: "a.ts", line: 1 },
          { name: "pass-tests", disposition: "posted", path: "b.ts", line: "7" },
          { key: "K", lens: "pass-ui", disposition: "posted" },
        ],
      },
      7,
      1,
    );
    expect(parsed.record!.findings.map((e) => e.key)).toEqual([
      "pass-ui@a.ts:1#0",
      "pass-tests@b.ts:7#1",
      "K",
    ]);
  });

  it("overflowing decimal strings never become infinite record fields", () => {
    const overflow = "9".repeat(400);
    const parsed = parseFindingsRecord(
      {
        findings: [
          {
            lens: "pass-ui",
            disposition: "posted",
            path: "a.ts",
            line: overflow,
            confidence: `-${overflow}`,
          },
        ],
      },
      7,
      1,
    );
    expect(parsed.record?.findings[0]).toMatchObject({ line: null, confidence: null });
  });

  it("readFindingsRecord distinguishes missing from unparseable", () => {
    expect(readFindingsRecord(join(findingsDir(), "nope.json"), 7, 2).status).toBe("missing");
    writeRecord("pr-7-round-2.json", "{ not json");
    expect(readFindingsRecord(join(findingsDir(), "pr-7-round-2.json"), 7, 2).status).toBe(
      "unparseable",
    );
  });
});

// ---- enforcement -----------------------------------------------------------

describe("enforceFindingsRecord", () => {
  const target = {
    pr: 7,
    roundNo: 2,
    roundId: null,
    headSha: HEAD,
    planned: ["pass-security", "pass-simplicity"],
  };

  it("a good record → rows, no anomaly, no nudge", async () => {
    writeRecord("pr-7-round-2.json", RECORD);
    const injects: string[] = [];
    expect(await enforceFindingsRecord(deps(injects), target)).toBe("recorded");
    expect(injects).toEqual([]);
    expect(anomalyKinds()).toEqual([]);
    const rows = store.roundFindings(7);
    expect(rows).toHaveLength(2);
    expect(rows[0]).toMatchObject({
      lens: "pass-security",
      disposition: "posted",
      severity: "P1",
      unplanned: 0,
    });
    expect(rows[1]).toMatchObject({
      lens: "pass-simplicity",
      disposition: "killed",
      word: "duplicate",
    });
  });

  it("a MISSING record → one anomaly + exactly ONE nudge; a second check never nudges again", async () => {
    const injects: string[] = [];
    const d = deps(injects);
    expect(await enforceFindingsRecord(d, target)).toBe("nudged");
    expect(injects).toHaveLength(1);
    expect(injects[0]).toContain("FINDINGS RECORD MISSING — PR #7 round 2");
    expect(anomalyKinds()).toEqual(["findings_record_missing"]);

    // Same round again: the durable anomaly row is written every time, the
    // wake is not. This is the "never a loop" direction.
    expect(await enforceFindingsRecord(d, target)).toBe("already_nudged");
    expect(await enforceFindingsRecord(d, target)).toBe("already_nudged");
    expect(injects).toHaveLength(1);
    expect(anomalyKinds()).toEqual([
      "findings_record_missing",
      "findings_record_unresolved",
      "findings_record_unresolved",
    ]);

    // The cap is per ROUND, not per PR: the next round gets its own one nudge.
    expect(await enforceFindingsRecord(d, { ...target, roundNo: 3 })).toBe("nudged");
    expect(injects).toHaveLength(2);
  });

  it("the once-mark survives a THROWING inject — a crashed nudge never becomes a loop", async () => {
    const d: FindingsCheckDeps = {
      store,
      findingsDir: findingsDir(),
      inject: async () => {
        throw new Error("tmux is gone");
      },
    };
    await expect(enforceFindingsRecord(d, target)).rejects.toThrow("tmux is gone");
    // The mark was stamped BEFORE the inject, so the failed delivery is not
    // retried — the durable anomaly row is the record, the wake is best-effort.
    const injects: string[] = [];
    expect(await enforceFindingsRecord(deps(injects), target)).toBe("already_nudged");
    expect(injects).toEqual([]);
  });

  it("unparseable / wrong-round / findings-less records are enforced like missing ones", async () => {
    const injects: string[] = [];
    writeRecord("pr-7-round-2.json", "}}}");
    expect(await enforceFindingsRecord(deps(injects), target)).toBe("nudged");
    writeRecord("pr-8-round-2.json", { pr: 8, round_no: 9, findings: [] });
    expect(await enforceFindingsRecord(deps(injects), { ...target, pr: 8 })).toBe("nudged");
    writeRecord("pr-9-round-2.json", { pr: 9, round_no: 2 });
    expect(await enforceFindingsRecord(deps(injects), { ...target, pr: 9 })).toBe("nudged");
    expect(injects).toHaveLength(3);
  });

  it("an UNPLANNED lens (the add protocol) is recorded, never dropped or refused", async () => {
    writeRecord("pr-7-round-2.json", {
      pr: 7,
      round_no: 2,
      findings: [
        { id: "a", lens: "pass-security", disposition: "posted" },
        // Never in the plan: the main pi added it mid-round under the add protocol.
        {
          id: "b",
          lens: "pass-backcompat",
          disposition: "killed",
          word: "below-bar",
          reason: "true but beneath posting",
        },
      ],
    });
    const injects: string[] = [];
    expect(
      await enforceFindingsRecord(deps(injects), { ...target, planned: ["pass-security"] }),
    ).toBe("recorded");
    const rows = store.findingsForRound(7, 2);
    expect(rows.map((r) => [r.lens, r.unplanned])).toEqual([
      ["pass-security", 0],
      ["pass-backcompat", 1],
    ]);
    // No anomaly: the record's job is to say what ran, and the daemon marks the
    // difference from the plan itself.
    expect(anomalyKinds()).toEqual([]);
  });

  it("a composite or annotated spelling of planned lenses is planned; one naming an unplanned lens is not", async () => {
    writeRecord("pr-7-round-2.json", {
      pr: 7,
      round_no: 2,
      findings: [
        { id: "a", lens: "pass-baseline + pass-sweep (2 lenses)", disposition: "posted" },
        { id: "b", lens: "pass-sweep:G1", disposition: "posted" },
        { id: "c", lens: "pass-baseline, pass-backcompat", disposition: "posted" },
        { id: "d", lens: "pass-x", disposition: "posted" },
      ],
    });
    await enforceFindingsRecord(deps([]), { ...target, planned: ["pass-baseline", "pass-sweep"] });
    expect(store.findingsForRound(7, 2).map((r) => [r.finding_key, r.unplanned])).toEqual([
      ["a", 0],
      ["b", 0],
      ["c", 1],
      ["d", 1],
    ]);
  });

  it("with no plan on the round nothing is called unplanned (absence of a plan is not evidence)", async () => {
    writeRecord("pr-7-round-2.json", {
      pr: 7,
      round_no: 2,
      findings: [{ id: "a", lens: "pass-x", disposition: "posted" }],
    });
    await enforceFindingsRecord(deps([]), { ...target, planned: [] });
    expect(store.findingsForRound(7, 2)[0]?.unplanned).toBe(0);
  });

  it("refuted-and-conceded is queryable, and separates settled findings from open ones", async () => {
    writeRecord("pr-7-round-2.json", {
      pr: 7,
      round_no: 2,
      findings: [
        {
          id: "old-1",
          lens: "pass-tests",
          disposition: "conceded",
          raised_in_round: 1,
          thread_id: 991,
          reason: "The author showed the fixture already covers it.",
        },
        { id: "new-1", lens: "pass-security", disposition: "posted", severity: "P1" },
      ],
    });
    await enforceFindingsRecord(deps([]), target);
    const conceded = store.concededFindings(7);
    expect(conceded).toHaveLength(1);
    expect(conceded[0]).toMatchObject({ finding_key: "old-1", raised_in_round: 1, thread_id: 991 });
    expect(conceded[0]?.reason).toContain("fixture already covers it");
    // The open finding is NOT in the settled set — escalating it in a later
    // round stays legitimate; resurrecting the conceded one does not.
    expect(store.concededFindings(7).map((r) => r.finding_key)).not.toContain("new-1");
  });

  it("re-recording the same round replaces its rows instead of doubling them", async () => {
    writeRecord("pr-7-round-2.json", RECORD);
    await enforceFindingsRecord(deps([]), target);
    await enforceFindingsRecord(deps([]), target);
    expect(store.findingsForRound(7, 2)).toHaveLength(2);
  });

  it("the wake is bookkeeping-only and points at artifacts that survive compaction", () => {
    const wake = findingsRecordWake(7, 2, "state/findings/pr-7-round-2.json");
    expect(wake).toContain("state/findings/pr-7-round-2.json");
    expect(wake).toContain("state/pr-7-round-2-passes/");
    expect(wake).toContain("Do NOT do any review work");
    expect(wake).toContain("do NOT post anything to GitHub");
    expect(wake).toContain("do NOT write a verdict file");
  });

  it("the wake rides wakeOrHold — a check landing mid-round holds (rule 9 S4)", async () => {
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
    expect(await enforceFindingsRecord(deps(injects), target)).toBe("nudged");
    expect(injects).toEqual([]);
    expect(store.heldWakes(7)[0]?.reason).toBe("findings_record_missing");
  });
});

// ---- round-end integration: the round completes REGARDLESS -----------------

class FakeAdapter implements VerdictAdapter {
  readonly labels: string[] = [];
  async addLabel(n: number, label: string): Promise<GateResult> {
    this.labels.push(`+${n}:${label}`);
    return { executed: false, dryRunFile: "d" };
  }
  async removeLabel(n: number, label: string): Promise<GateResult> {
    this.labels.push(`-${n}:${label}`);
    return { executed: false, dryRunFile: "d" };
  }
}

function hooksOf(injects: string[]): SessionHooks {
  return {
    async dispatchRound() {},
    async inject(pr, msg) {
      injects.push(`${pr}:${msg}`);
    },
    async injectOverseer() {},
    async archiveAndClose() {},
    async compactSession() {},
  };
}

describe("VerdictWatcher round-end findings check", () => {
  function setup(over: Partial<VerdictDeps> = {}): {
    watcher: VerdictWatcher;
    injects: string[];
    adapter: FakeAdapter;
  } {
    const injects: string[] = [];
    const adapter = new FakeAdapter();
    const watcher = new VerdictWatcher({
      cfg,
      store,
      adapter,
      hooks: hooksOf(injects),
      verdictDir: join(dir, "verdict"),
      root: dir,
      findingsDir: findingsDir(),
      usage: { globalStoreDir: null },
      partialWrite: { windowMs: 0 },
      ledgerCheckDelayMs: 0, // inline; the settle delay is pinned in verdicts.test.ts
      ...over,
    });
    return { watcher, injects, adapter };
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
    store.startRound(
      pr,
      "first",
      ["pass-security", "pass-simplicity"],
      cfg.daemon.round_deadline_min,
    );
    // The ledger is fresh so only the findings check can speak in these tests.
    mkdirSync(join(dir, "state", "ledgers"), { recursive: true });
    writeFileSync(
      join(dir, "state", "ledgers", `pr-${pr}.md`),
      `LEDGER PR #${pr} @ ${HEAD}\n- settled`,
    );
    mkdirSync(join(dir, "verdict"), { recursive: true });
    writeFileSync(
      join(dir, "verdict", `pr-${pr}-round-1.json`),
      JSON.stringify({
        pr,
        round_no: 1,
        verdict: "REQUEST_CHANGES",
        head_sha: HEAD,
        finished_at: "2026-08-25T12:00:00Z",
        passes: [
          { name: "pass-security", tier: "sol-high", findings: 1 },
          { name: "pass-simplicity", tier: "sol-med", findings: 1 },
        ],
      }),
    );
  }

  it("a present record lands as rows and fills in the per-round comment count", async () => {
    verdicted(100);
    writeRecord("pr-100-round-1.json", { ...RECORD, pr: 100, round_no: 1, comments_posted: 5 });
    const { watcher, injects } = setup();
    await watcher.sweep();
    expect(injects).toEqual([]);
    expect(store.findingsForRound(100, 1)).toHaveLength(2);
    const round = store.roundsFor(100)[0];
    expect(round?.comments_posted).toBe(5);
    expect(round?.verdict).toBe("REQUEST_CHANGES");
  });

  it("tells onFindingsRecorded (the lesson shadow ledger's matcher) once the round's record landed", async () => {
    verdicted(100);
    writeRecord("pr-100-round-1.json", { ...RECORD, pr: 100, round_no: 1 });
    const told: Array<{ pr: number; roundNo: number; roundId: number | null; rows: number }> = [];
    const { watcher } = setup({
      onFindingsRecorded: (t) => told.push({ ...t, rows: store.findingsForRound(100, 1).length }),
    });
    await watcher.sweep();
    const round = store.roundsFor(100)[0]!;
    expect(told).toEqual([{ pr: 100, roundNo: 1, roundId: round.id, rows: 2 }]);
  });

  it("a record that never arrives tells onFindingsRecorded nothing", async () => {
    verdicted(100);
    const told: unknown[] = [];
    const { watcher } = setup({ onFindingsRecorded: (t) => told.push(t) });
    await watcher.sweep();
    expect(told).toEqual([]);
  });

  it("A RECORD THAT NEVER ARRIVES DOES NOT WEDGE THE ROUND", async () => {
    verdicted(100);
    const { watcher, injects, adapter } = setup();
    await watcher.sweep();

    // The round is fully over, exactly as if the record had arrived:
    const round = store.roundsFor(100)[0];
    expect(round?.status).toBe("done");
    expect(round?.verdict).toBe("REQUEST_CHANGES");
    expect(round?.finished_at).not.toBeNull();
    expect(store.runningRounds()).toEqual([]);
    // ...the PR transitioned, and its labels moved.
    expect(store.getPr(100)?.state).toBe("awaiting_author");
    expect(adapter.labels).toContain(`-100:${cfg.github.in_progress_label}`);
    expect(adapter.labels).toContain(`+100:${cfg.github.reviewed_label}`);
    // ...the reviewed-head mark was stamped, so nothing re-reviews this head.
    expect(store.reviewedHead(100)?.head_sha).toBe(HEAD);
    // ...and the only cost was one anomaly plus one bookkeeping nudge.
    expect(anomalyKinds()).toEqual(["findings_record_missing"]);
    expect(injects).toHaveLength(1);
    expect(injects[0]).toContain("FINDINGS RECORD MISSING");
  });

  it("a record written AFTER its nudge is stored by a later sweep — once, with no second nudge", async () => {
    verdicted(100);
    const told: Array<{ pr: number; roundNo: number; roundId: number | null }> = [];
    const { watcher, injects } = setup({ onFindingsRecorded: (t) => told.push(t) });
    await watcher.sweep();
    expect(injects).toHaveLength(1);
    expect(store.findingsForRound(100, 1)).toHaveLength(0);

    // A sweep before the session answered: nothing to store, nothing said.
    await watcher.sweep();
    expect(anomalyKinds()).toEqual(["findings_record_missing"]);

    // The session reconstructs the record the nudge asked for.
    writeRecord("pr-100-round-1.json", { ...RECORD, pr: 100, round_no: 1, comments_posted: 4 });
    await watcher.sweep();
    const round = store.roundsFor(100)[0]!;
    expect(store.findingsForRound(100, 1)).toHaveLength(2);
    expect(store.findingsForRound(100, 1)[0]).toMatchObject({ unplanned: 0 });
    expect(round.comments_posted).toBe(4);
    expect(told).toEqual([{ pr: 100, roundNo: 1, roundId: round.id }]);

    // Stored once: a later sweep finds the round recorded and leaves it.
    await watcher.sweep();
    expect(told).toHaveLength(1);
    expect(store.prEvents(100, ["findings_recorded"])).toHaveLength(1);
    expect(injects).toHaveLength(1);
    expect(anomalyKinds()).toEqual(["findings_record_missing"]);
  });

  it("a second sweep of the same round never sends a second nudge", async () => {
    verdicted(100);
    const { watcher, injects } = setup();
    await watcher.sweep();
    expect(injects).toHaveLength(1);
    // Same round, re-checked (a replayed sweep, a re-delivered verdict).
    await enforceFindingsRecord(deps(injects), {
      pr: 100,
      roundNo: 1,
      roundId: null,
      headSha: HEAD,
      planned: [],
    });
    expect(injects).toHaveLength(1);
  });

  it("without a findingsDir the check does not exist at all", async () => {
    verdicted(100);
    const injects: string[] = [];
    const watcher = new VerdictWatcher({
      cfg,
      store,
      adapter: new FakeAdapter(),
      hooks: hooksOf(injects),
      verdictDir: join(dir, "verdict"),
      root: dir,
      usage: { globalStoreDir: null },
      partialWrite: { windowMs: 0 },
      ledgerCheckDelayMs: 0,
    });
    await watcher.sweep();
    expect(injects).toEqual([]);
    expect(anomalyKinds()).toEqual([]);
  });
});

// ---- the recheck side: read-if-present, never a nudge ----------------------

describe("RecheckWatcher findings record", () => {
  function decision(pr: number, outcome: "uphold" | "request_changes"): string {
    const name = `pr-${pr}-recheck-${HEAD.slice(0, 12)}.json`;
    mkdirSync(join(dir, "verdict"), { recursive: true });
    writeFileSync(
      join(dir, "verdict", name),
      JSON.stringify({ pr, head_sha: HEAD, outcome, reason: "r" }),
    );
    return name;
  }

  function watcher(): RecheckWatcher {
    return new RecheckWatcher({
      cfg,
      store,
      verdictDir: join(dir, "verdict"),
      findingsDir: findingsDir(),
      partialWrite: { windowMs: 0 },
    });
  }

  it("a recheck that moves the verdict records its findings against the standing round", async () => {
    store.upsertPr({
      number: 55,
      state: "awaiting_author",
      head_sha: HEAD,
      title: "t",
      author: "a",
      trigger_ts: null,
      stale_recheck: 0,
      migration_gate: 0,
    });
    store.recordReviewedHead(55, { head_sha: HEAD, verdict: "APPROVE", round_no: 4 });
    writeRecord(`pr-55-recheck-${HEAD.slice(0, 12)}.json`, {
      pr: 55,
      head_sha: HEAD,
      findings: [
        {
          id: "r1",
          lens: "recheck",
          severity: "P1",
          disposition: "posted",
          reason: "regression the delta introduced",
        },
      ],
    });
    await watcher().handleFile(decision(55, "request_changes"));
    const rows = store.findingsForRound(55, 4);
    expect(rows).toHaveLength(1);
    // Prefixed so a recheck's rows can never collide with the round's own.
    expect(rows[0]?.finding_key).toBe(`recheck:${HEAD.slice(0, 12)}:r1`);
    expect(rows[0]?.round_id).toBeNull();
  });

  it("an absent recheck record is logged and nothing else — no anomaly, no nudge", async () => {
    store.upsertPr({
      number: 56,
      state: "awaiting_author",
      head_sha: HEAD,
      title: "t",
      author: "a",
      trigger_ts: null,
      stale_recheck: 0,
      migration_gate: 0,
    });
    await watcher().handleFile(decision(56, "request_changes"));
    expect(anomalyKinds()).toEqual([]);
    expect(store.roundFindings(56)).toEqual([]);
    // The decision itself still applied.
    expect(store.getPr(56)?.state).toBe("awaiting_author");
  });
});

// ---- the per-round comment count (bot_comments.round_no) -------------------

describe("per-round comment attribution", () => {
  it("a comment registered during a round is attributed to THAT round", () => {
    store.upsertPr({
      number: 42,
      state: "reviewing",
      head_sha: HEAD,
      title: "t",
      author: "a",
      trigger_ts: null,
      stale_recheck: 0,
      migration_gate: 0,
    });
    store.startRound(42, "first", ["pass-baseline"], 60);
    store.registerBotComment(9001, 42);
    const row = store.db
      .prepare("SELECT round_no FROM bot_comments WHERE comment_id = 9001")
      .get() as { round_no: number | null };
    expect(row.round_no).toBe(1);
  });

  it("a PR whose only rounds are BACKFILLED history still gets an attribution", () => {
    // Backfilled rounds count too: looking only at `backfilled = 0` rounds
    // would leave most historical PRs unattributed.
    store.insertBackfilledRound({
      pr: 43,
      round_no: 1,
      verdict: "APPROVE",
      started_at: "2026-07-01T00:00:00Z",
      finished_at: "2026-07-01T01:00:00Z",
      gh_review_id: 5,
      gh_commit_id: null,
      trigger_ts: null,
    });
    store.registerBotComment(9002, 43);
    const row = store.db
      .prepare("SELECT round_no FROM bot_comments WHERE comment_id = 9002")
      .get() as { round_no: number | null };
    expect(row.round_no).toBe(1);
  });

  it("an explicit round always wins over every fallback", () => {
    store.upsertPr({
      number: 44,
      state: "reviewing",
      head_sha: HEAD,
      title: "t",
      author: "a",
      trigger_ts: null,
      stale_recheck: 0,
      migration_gate: 0,
    });
    store.startRound(44, "first", ["pass-baseline"], 60);
    store.registerBotComment(9003, 44, "review", 7);
    const row = store.db
      .prepare("SELECT round_no FROM bot_comments WHERE comment_id = 9003")
      .get() as { round_no: number | null };
    expect(row.round_no).toBe(7);
  });
});

// ---- the conformance audit -------------------------------------------------
//
// Two of the three unreasoned shapes are cheaply detectable from the record
// itself — no second table, and one field (`request`) on
// nit entries. The audit is measurement, never a gate: the round is finished by
// the time it runs, and nothing here can hold a PR open.

describe("the conformance audit", () => {
  const entry = (over: Record<string, unknown>) => ({
    id: "f1",
    lens: "pass-baseline",
    path: "a.py",
    line: 1,
    disposition: "posted",
    ...over,
  });

  const parse = (findings: unknown[]) =>
    parseFindingsRecord({ pr: 7, round_no: 2, findings }, 7, 2).conformance!;

  it("counts a posted finding whose tag is outside the closed grammar", () => {
    const c = parse([
      entry({ id: "f1", posted_as: "start here 3/5" }),
      entry({ id: "f2", posted_as: "blocker" }),
      entry({ id: "f3", posted_as: "[check this]" }),
    ]);
    expect(c.ungrammatical_tags).toEqual(["f1"]);
  });

  it("counts a posted nit that asks for nothing, and clears one that asks", () => {
    const c = parse([
      entry({ id: "f1", posted_as: "nit" }),
      entry({ id: "f2", posted_as: "nit", request: "rename `tmp` to `pending_rows`" }),
      // Alternate spellings are accepted, like everywhere else in this parser.
      entry({ id: "f3", posted_as: "nit", ask: "drop the commented-out block" }),
    ]);
    expect(c.nits_without_request).toEqual(["f1"]);
  });

  it("never asks a blocker or a question for a request", () => {
    const c = parse([
      entry({ id: "f1", posted_as: "blocker" }),
      entry({ id: "f2", posted_as: "question" }),
    ]);
    expect(c.nits_without_request).toEqual([]);
    expect(c.ungrammatical_tags).toEqual([]);
  });

  it("ignores candidates that never reached the author", () => {
    const c = parse([
      entry({ id: "f1", disposition: "killed", word: "below-bar", posted_as: "nit" }),
      entry({ id: "f2", disposition: "withheld", posted_as: "[verified]" }),
    ]);
    expect(c.ungrammatical_tags).toEqual([]);
    expect(c.nits_without_request).toEqual([]);
  });

  it("counts restatements without judging them — escalation across rounds is legitimate", () => {
    const c = parse([
      entry({ id: "f1", posted_as: "blocker", raised_in_round: 1 }),
      entry({ id: "f2", posted_as: "blocker" }),
    ]);
    expect(c.restated).toEqual(["f1"]);
    // …and it is NOT a conformance failure: a later round may legitimately
    // raise an OPEN finding's severity.
    expect(isConformant(c)).toBe(true);
  });

  it("the new words are in the closed vocabulary", () => {
    for (const w of ["nit-no-request", "self-narration", "tag-outside-grammar"]) {
      expect(isKnownVocabularyWord(w), w).toBe(true);
    }
  });

  it("enforceFindingsRecord logs a quiet anomaly, records the rows anyway, and never nudges", async () => {
    writeRecord("pr-7-round-2.json", {
      pr: 7,
      round_no: 2,
      findings: [
        entry({ id: "f1", posted_as: "nit" }),
        entry({ id: "f2", posted_as: "[verified]" }),
      ],
    });
    const injects: string[] = [];
    expect(
      await enforceFindingsRecord(deps(injects), {
        pr: 7,
        roundNo: 2,
        roundId: null,
        headSha: HEAD,
        planned: ["pass-baseline"],
      }),
    ).toBe("recorded");
    // A record is a record: the rows land whatever the audit says.
    expect(store.roundFindings(7)).toHaveLength(2);
    // The session is never re-nudged for this — the enforcement lives in the
    // lens addendum and the validator, where a finding is still preventable.
    expect(injects).toEqual([]);
    expect(anomalyKinds()).toEqual(["review_output_unreasoned"]);
  });

  it("a clean round logs no conformance anomaly", async () => {
    writeRecord("pr-7-round-2.json", RECORD);
    expect(
      await enforceFindingsRecord(deps([]), {
        pr: 7,
        roundNo: 2,
        roundId: null,
        headSha: HEAD,
        planned: ["pass-security", "pass-simplicity"],
      }),
    ).toBe("recorded");
    expect(anomalyKinds()).toEqual([]);
  });
});

// ---- the top-level `prior` array -------------------------------------------

describe("the prior-finding statuses", () => {
  it("an absent `prior` is an empty list, not a note", () => {
    const parsed = parseFindingsRecord(RECORD, 7, 2);
    expect(parsed.record?.prior).toEqual([]);
    expect(parsed.note).toBeUndefined();
  });

  it("parses refs and statuses, folding aliases; fixed@<sha> keeps the sha as evidence", () => {
    const parsed = parseFindingsRecord(
      {
        ...RECORD,
        round_no: 4,
        prior: [
          { ref: "3:f2", status: "fixed", evidence: "orders.py:212 now checks tenant" },
          { ref: "3:f4", status: "still-open", evidence: "still unchecked at :215" },
          { ref: "2:recheck:ab12cd34ef56:r1", status: "conceded", evidence: "accepted" },
          { ref: "1:f1", status: "fixed@abc1234" },
          { ref: "r2:f9", status: "Obsolete" },
        ],
      },
      7,
      4,
    );
    expect(parsed.status).toBe("ok");
    expect(parsed.record?.prior).toEqual([
      {
        ref: "3:f2",
        round_no: 3,
        finding_key: "f2",
        status: "fixed",
        evidence: "orders.py:212 now checks tenant",
      },
      {
        ref: "3:f4",
        round_no: 3,
        finding_key: "f4",
        status: "open",
        evidence: "still unchecked at :215",
      },
      {
        ref: "2:recheck:ab12cd34ef56:r1",
        round_no: 2,
        finding_key: "recheck:ab12cd34ef56:r1",
        status: "conceded",
        evidence: "accepted",
      },
      { ref: "1:f1", round_no: 1, finding_key: "f1", status: "fixed", evidence: "fixed@abc1234" },
      { ref: "2:f9", round_no: 2, finding_key: "f9", status: "obsolete", evidence: null },
    ]);
    expect(parsed.note).toBeUndefined();
  });

  it("unusable entries are noted, never a rejection; a ref reported twice keeps the last", () => {
    const parsed = parseFindingsRecord(
      {
        ...RECORD,
        round_no: 4,
        prior: [
          "3:f1",
          { ref: "f1", status: "fixed" }, // no round
          { ref: "3:f1", status: "maybe" }, // unknown status
          { ref: "4:f1", status: "fixed" }, // not an earlier round
          { ref: "3:f2", status: "open" },
          { ref: "3:f2", status: "fixed", evidence: "later word" },
        ],
      },
      7,
      4,
    );
    expect(parsed.status).toBe("ok");
    expect(parsed.record?.findings).toHaveLength(2);
    expect(parsed.record?.prior).toEqual([
      { ref: "3:f2", round_no: 3, finding_key: "f2", status: "fixed", evidence: "later word" },
    ]);
    expect(parsed.note).toContain("4 prior-finding status entries unusable");
    const notArray = parseFindingsRecord({ ...RECORD, prior: { a: 1 } }, 7, 2);
    expect(notArray.status).toBe("ok");
    expect(notArray.note).toContain("`prior` is not an array");
  });

  it("normalizePriorStatus and parsePriorRef", () => {
    expect(normalizePriorStatus("still_open")).toEqual({ status: "open", sha: null });
    expect(normalizePriorStatus("FIXED@DEADBEEF")).toEqual({ status: "fixed", sha: "deadbeef" });
    expect(normalizePriorStatus("resolved-ish")).toBeNull();
    expect(normalizePriorStatus(3)).toBeNull();
    expect(parsePriorRef("12:recheck:aa:b")).toEqual({ round_no: 12, finding_key: "recheck:aa:b" });
    expect(parsePriorRef(":f1")).toBeNull();
    expect(parsePriorRef("x:f1")).toBeNull();
    expect(parsePriorRef("3:")).toBeNull();
  });

  it("enforceFindingsRecord stores the reports against the record's round", async () => {
    store.recordPriorListing(7, 2, HEAD, [
      { round_no: 1, finding_key: "f1", blocking: true },
      { round_no: 1, finding_key: "f2", blocking: false },
    ]);
    writeRecord("pr-7-round-2.json", {
      ...RECORD,
      prior: [
        { ref: "1:f1", status: "fixed", evidence: "checked" },
        { ref: "1:f7", status: "open", evidence: "from the ledger" },
      ],
    });
    expect(
      await enforceFindingsRecord(deps([]), {
        pr: 7,
        roundNo: 2,
        roundId: null,
        headSha: HEAD,
        planned: [],
      }),
    ).toBe("recorded");
    const checks = store.priorFindingChecks(7);
    expect(checks.map((c) => [c.finding_key, c.blocking, c.status, c.listed_at !== null])).toEqual([
      ["f1", 1, "fixed", true],
      ["f2", 0, null, true],
      // Reported without having been listed: kept, never dropped.
      ["f7", 0, "open", false],
    ]);
    const ev = store.prEvents(7, ["findings_recorded"]).at(-1)!;
    expect(ev.payload.prior_reported).toBe(2);
  });
});
