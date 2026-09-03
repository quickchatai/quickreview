// The durable candidate list (deciding).
//
// Four properties are pinned here because each one is a decision the owner made
// against a rejected alternative, not an accident of implementation:
//
//   1. the list DOES NOT EXPIRE — no TTL, no rolling window, no cap;
//   2. it is grouped by family, rarest first, worst-first inside a group;
//   3. a block the author accepted and fixed is never a candidate;
//   4. an empty survey reports the families it checked.
//
// If one of these tests goes red, the fix is almost certainly in the code.
import { describe, expect, it } from "vitest";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { CapturedComment } from "../src/capture.js";
import type { StatusSnapshot } from "../src/state.js";
import {
  CandidateStore,
  CandidateSweeper,
  FAMILY_ORDER,
  LONG_REVIEW_ROUNDS,
  adjudicationsFrom,
  candidateKey,
  detectCandidates,
  groupCandidates,
  isPerfectPath,
  mergeCandidates,
  openCandidates,
  renderSurvey,
  roundFactsFromEvidence,
  type Candidate,
  type CandidateList,
  type PrFacts,
  type RoundFact,
} from "../src/tui/candidates.js";

/** Test-side read-back. Deliberately NOT a `load()` on the store: production
 * has no collapsing accessor any more, and reviving one for convenience is
 * how the merge-then-save reached for it in the first place. */
function listIn(store: CandidateStore): CandidateList | undefined {
  const r = store.read();
  return r.state === "list" ? r.list : undefined;
}

function facts(over: Partial<PrFacts> & { pr: number }): PrFacts {
  return {
    state: "closed",
    signature: `sig-${over.pr}`,
    rounds: [],
    comments: [],
    signals: [],
    ...over,
  };
}

function round(round_no: number, verdict: string | null, status = "done"): RoundFact {
  return { round_no, status, verdict };
}

function comment(over: Partial<CapturedComment> = {}): CapturedComment {
  return {
    pr: 5312,
    source: "issue_comment",
    comment_id: 1,
    in_reply_to_id: null,
    thread_id: null,
    review_id: null,
    author: "pmercier",
    author_type: "User",
    tagged: true,
    path: null,
    line: null,
    body: "[feedback] this blocker was noise",
    created_at: "2026-08-20T10:00:00Z",
    ...over,
  };
}

describe("the good path and its one carve-out", () => {
  it("triggered → approve in one round → merged is not a candidate", () => {
    const f = facts({ pr: 5000, rounds: [round(1, "APPROVE")], rounds_reported: 1 });
    expect(isPerfectPath(f)).toBe(true);
    expect(detectCandidates(f)).toEqual([]);
  });

  it("a block the author ACCEPTED AND FIXED never appears as a candidate", () => {
    // The owner was explicit: this is the review working, not a deviation.
    // Block → fix → approve must produce nothing in ANY family.
    const f = facts({
      pr: 5001,
      rounds: [round(1, "REQUEST_CHANGES"), round(2, "APPROVE")],
      rounds_reported: 2,
    });
    expect(isPerfectPath(f)).toBe(false);
    expect(detectCandidates(f)).toEqual([]);
  });

  it("one fix cycle — block, fix, block, approve — is still not a candidate", () => {
    const f = facts({
      pr: 5002,
      rounds: [round(1, "REQUEST_CHANGES"), round(2, "REQUEST_CHANGES"), round(3, "APPROVE")],
      rounds_reported: 3,
    });
    expect(detectCandidates(f).map((d) => d.family)).toEqual([]);
  });

  it("three blocking rounds in a row IS the treadmill", () => {
    const f = facts({
      pr: 5249,
      rounds: [1, 2, 3, 4].map((n) => round(n, "REQUEST_CHANGES")),
      rounds_reported: 4,
    });
    const d = detectCandidates(f).find((x) => x.family === "repeat-blocks");
    expect(d?.severity).toBe(4);
  });
});

describe("the seven families", () => {
  it("detects explicit [feedback], and only on tagged comments", () => {
    const f = facts({
      pr: 5312,
      rounds: [round(1, "APPROVE")],
      comments: [comment(), comment({ comment_id: 2, tagged: false })],
    });
    const d = detectCandidates(f).find((x) => x.family === "feedback-tag");
    expect(d?.severity).toBe(1);
    expect(d?.detail[0]).toContain("pmercier");
  });

  it("detects disagreement and dismissal from behavioural signals", () => {
    const f = facts({
      pr: 5270,
      rounds: [round(1, "APPROVE")],
      signals: [{ kind: "posting_guard_downgraded" }, { kind: "review_dismissed" }],
    });
    const fams = detectCandidates(f).map((d) => d.family);
    expect(fams).toContain("disagreement");
    expect(fams).toContain("dismissed");
  });

  it("counts rounds that produced no verdict, however they died", () => {
    const f = facts({
      pr: 5180,
      rounds: [
        round(1, "REQUEST_CHANGES"),
        round(2, null, "overdue"),
        round(3, null, "done"),
        round(4, null, "cancelled"),
      ],
    });
    const d = detectCandidates(f).find((x) => x.family === "no-verdict");
    expect(d?.severity).toBe(3);
  });

  it("detects repeat approvals — the family that should shrink to nothing", () => {
    const f = facts({
      pr: 5266,
      rounds: [round(1, "APPROVE"), round(2, "APPROVE"), round(3, "APPROVE")],
    });
    const d = detectCandidates(f).find((x) => x.family === "repeat-approvals");
    expect(d?.severity).toBe(3);
  });

  it("detects sheer length from the daemon's count even when the local record is short", () => {
    const f = facts({
      pr: 5306,
      rounds: [round(1, "REQUEST_CHANGES")],
      rounds_reported: LONG_REVIEW_ROUNDS + 2,
    });
    const d = detectCandidates(f).find((x) => x.family === "long-review");
    expect(d?.severity).toBe(LONG_REVIEW_ROUNDS + 2);
    expect(d?.detail[0]).toContain(`1 of ${LONG_REVIEW_ROUNDS + 2}`);
  });
});

describe("grouping and ordering", () => {
  const now = "2026-08-25T09:00:00Z";
  const row = (family: Candidate["family"], pr: number, severity: number): Candidate => ({
    key: candidateKey(family, pr),
    pr,
    family,
    severity,
    headline: `${family} ${severity}`,
    detail: [],
    first_seen: now,
    last_seen: now,
    signature: `sig-${pr}`,
    judged: null,
    returned: false,
  });

  it("groups come out rarest-first, so one disagreement is never buried", () => {
    const rows = [
      row("long-review", 1, 14),
      row("repeat-blocks", 2, 9),
      row("repeat-blocks", 3, 10),
      row("disagreement", 4, 1),
    ];
    const groups = groupCandidates(rows);
    expect(groups.map((g) => g.family)).toEqual(["disagreement", "repeat-blocks", "long-review"]);
    // …and worst-first inside a group.
    expect(groups[1]!.candidates.map((c) => c.pr)).toEqual([3, 2]);
  });

  it("family order puts explicit feedback first and sheer length last", () => {
    expect(FAMILY_ORDER[0]).toBe("feedback-tag");
    expect(FAMILY_ORDER[FAMILY_ORDER.length - 1]).toBe("long-review");
  });
});

describe("durability — the list does not expire", () => {
  const f = (pr: number, signature: string) => facts({ pr, signature });

  it("a candidate not re-derived for a month keeps its row and its first_seen", () => {
    const old: Candidate = {
      key: candidateKey("repeat-blocks", 5249),
      pr: 5249,
      family: "repeat-blocks",
      severity: 10,
      headline: "10 blocking rounds in a row",
      detail: [],
      first_seen: "2026-07-01T00:00:00Z",
      last_seen: "2026-07-01T00:00:00Z",
      signature: "sig-5249",
      judged: null,
      returned: false,
    };
    // A sweep a month later that detects NOTHING at all.
    const merged = mergeCandidates([old], [], {
      now: "2026-08-25T09:00:00Z",
      facts: new Map(),
      adjudications: new Map(),
    });
    expect(merged).toHaveLength(1);
    expect(merged[0]!.first_seen).toBe("2026-07-01T00:00:00Z");
    expect(openCandidates(merged)).toHaveLength(1);
  });

  it("re-detecting updates in place rather than piling up duplicates", () => {
    const ctx = {
      now: "2026-08-25T09:00:00Z",
      facts: new Map([[7, f(7, "sig-b")]]),
      adjudications: new Map<number, string>(),
    };
    const first = mergeCandidates(
      [],
      [{ family: "long-review", pr: 7, severity: 10, headline: "10 rounds", detail: [] }],
      {
        ...ctx,
        now: "2026-08-01T09:00:00Z",
        facts: new Map([[7, f(7, "sig-a")]]),
      },
    );
    const second = mergeCandidates(
      first,
      [{ family: "long-review", pr: 7, severity: 12, headline: "12 rounds", detail: [] }],
      ctx,
    );
    expect(second).toHaveLength(1);
    expect(second[0]!.severity).toBe(12);
    expect(second[0]!.first_seen).toBe("2026-08-01T09:00:00Z");
    expect(second[0]!.last_seen).toBe("2026-08-25T09:00:00Z");
  });

  it("survives a TUI restart: the store is re-read from disk, not from memory", () => {
    const dir = mkdtempSync(join(tmpdir(), "qcr-cand-"));
    const store = new CandidateStore(dir);
    const rows = mergeCandidates(
      [],
      [{ family: "no-verdict", pr: 42, severity: 3, headline: "3 dead rounds", detail: [] }],
      {
        now: "2026-08-25T09:00:00Z",
        facts: new Map([[42, f(42, "sig-42")]]),
        adjudications: new Map(),
      },
    );
    store.save({
      version: 1,
      updated_at: "2026-08-25T09:00:00Z",
      families: [],
      candidates: rows,
      coverage: { prs_scanned: 1, rounds_with_local_record: 3, rounds_reported: 3 },
    });
    // A brand new store object over the same dir — the restart.
    expect(listIn(new CandidateStore(dir))?.candidates[0]!.pr).toBe(42);
  });

  it("a corrupt list is undefined, never a crash and never 'no candidates'", () => {
    const dir = mkdtempSync(join(tmpdir(), "qcr-cand-"));
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "candidates.json"), "{ not json");
    expect(listIn(new CandidateStore(dir))).toBeUndefined();
  });

  // `load()` collapses two facts into one `undefined`, which is why
  // anything that MERGES or SAVES must go through `read()` instead.
  it("read() keeps 'no file yet' and 'exists but unreadable' apart", () => {
    const dir = mkdtempSync(join(tmpdir(), "qcr-cand-"));
    mkdirSync(dir, { recursive: true });
    expect(new CandidateStore(dir).read()).toEqual({ state: "absent" });

    writeFileSync(join(dir, "candidates.json"), '{"version":1,"candidates":[');
    const torn = new CandidateStore(dir).read();
    expect(torn.state).toBe("unreadable");

    // Valid JSON that is not a list is unreadable too, not empty.
    writeFileSync(join(dir, "candidates.json"), '{"version":1}');
    expect(new CandidateStore(dir).read()).toEqual({
      state: "unreadable",
      reason: "no candidates array",
    });

    writeFileSync(join(dir, "candidates.json"), JSON.stringify({ version: 1, candidates: [] }));
    expect(new CandidateStore(dir).read().state).toBe("list");
  });
});

describe("judged items return only if the PR moved", () => {
  const base = {
    now: "2026-08-25T09:00:00Z",
    facts: new Map([[9, facts({ pr: 9, signature: "sig-1" })]]),
  };
  const detected = [
    { family: "repeat-blocks" as const, pr: 9, severity: 5, headline: "5 blocks", detail: [] },
  ];

  it("an adjudication takes it off the open list", () => {
    const first = mergeCandidates([], detected, { ...base, adjudications: new Map() });
    expect(openCandidates(first)).toHaveLength(1);
    const judged = mergeCandidates(first, detected, {
      ...base,
      adjudications: new Map([[9, "2026-08-25 10:00:00"]]),
    });
    expect(judged[0]!.judged?.signature).toBe("sig-1");
    expect(openCandidates(judged)).toHaveLength(0);
  });

  it("it stays off while the PR is unchanged, however many sweeps run", () => {
    let rows = mergeCandidates([], detected, {
      ...base,
      adjudications: new Map([[9, "2026-08-25 10:00:00"]]),
    });
    for (let i = 0; i < 5; i++)
      rows = mergeCandidates(rows, detected, {
        ...base,
        adjudications: new Map([[9, "2026-08-25 10:00:00"]]),
      });
    expect(openCandidates(rows)).toHaveLength(0);
  });

  it("it comes back, marked returned, once the PR moves", () => {
    const judged = mergeCandidates(
      mergeCandidates([], detected, { ...base, adjudications: new Map() }),
      detected,
      {
        ...base,
        adjudications: new Map([[9, "2026-08-25 10:00:00"]]),
      },
    );
    const moved = mergeCandidates(judged, detected, {
      now: base.now,
      facts: new Map([[9, facts({ pr: 9, signature: "sig-2" })]]),
      adjudications: new Map([[9, "2026-08-25 10:00:00"]]),
    });
    expect(openCandidates(moved)).toHaveLength(1);
    expect(moved[0]!.returned).toBe(true);
  });

  it("reads #adjudication entries header-only, so quoted prose cannot mint one", () => {
    const map = adjudicationsFrom([
      {
        ts: "2026-08-25 10:00:00",
        text: "#adjudication #feedback pr=5270 attribution=review-defect\nComplaint: pr=9999 he said",
        tags: ["#adjudication", "#feedback"],
      },
      {
        ts: "2026-08-24 10:00:00",
        text: "#feedback pr=5271 no adjudication tag",
        tags: ["#feedback"],
      },
      { ts: "2026-08-26 10:00:00", text: "#adjudication pr=5270 later", tags: ["#adjudication"] },
    ]);
    expect(map.get(5270)).toBe("2026-08-26 10:00:00"); // newest wins
    expect(map.has(9999)).toBe(false); // body text is not a header
    expect(map.has(5271)).toBe(false); // no #adjudication tag
  });
});

describe("the sweep and the empty answer", () => {
  function snapshot(prs: StatusSnapshot["prs"]): StatusSnapshot {
    return {
      written_at: "2026-08-25T09:00:00Z",
      dry_run: false,
      prs,
      running_rounds: 0,
      total_spend_usd: 0,
      heartbeat: "2026-08-25T09:00:00Z",
    };
  }

  function writeManifest(
    dir: string,
    pr: number,
    round_no: number,
    status: string,
    verdict: string | null,
  ): void {
    const d = join(dir, `pr-${pr}`, `round-${round_no}`);
    mkdirSync(d, { recursive: true });
    writeFileSync(
      join(d, "manifest.json"),
      JSON.stringify({ pr, round_no, round: { round_no, status, verdict } }),
    );
  }

  it("reads round facts out of's manifests, ignoring half-copies", () => {
    const dir = mkdtempSync(join(tmpdir(), "qcr-ev-"));
    writeManifest(dir, 5249, 2, "done", "REQUEST_CHANGES");
    writeManifest(dir, 5249, 1, "done", "REQUEST_CHANGES");
    mkdirSync(join(dir, "pr-5249", "round-3"), { recursive: true }); // no manifest = half-copy
    const rounds = roundFactsFromEvidence(dir, 5249);
    expect(rounds.map((r) => r.round_no)).toEqual([1, 2]);
  });

  it("a sweep with nothing to find still reports every family", async () => {
    const dir = mkdtempSync(join(tmpdir(), "qcr-cand-"));
    writeManifest(dir, 5000, 1, "done", "APPROVE");
    const store = new CandidateStore(dir);
    const sweeper = new CandidateSweeper(store, {
      evidenceDir: dir,
      now: () => new Date("2026-08-25T09:00:00Z"),
    });
    const list = await sweeper.sweep(
      snapshot([
        {
          number: 5000,
          state: "closed",
          title: "t",
          head_sha: "abc",
          stale_recheck: 0,
          rounds: 1,
        } as never,
      ]),
    );
    expect(list!.candidates).toEqual([]);
    expect(list!.families.map((f) => f.family)).toEqual([...FAMILY_ORDER]);
    for (const f of list!.families) expect(f.scanned).toBe(1);
    // The three comment/signal families must name their gap rather than read
    // as checked-clean — a false negative we would have authored.
    expect(list!.families.find((f) => f.family === "feedback-tag")!.gap).toMatch(/pr_comments/);
    expect(list!.families.find((f) => f.family === "dismissed")!.gap).toMatch(/feedback_signals/);
    expect(list!.families.find((f) => f.family === "no-verdict")!.gap).toBeUndefined();
  });

  it("the empty render says what it checked, never nothing", () => {
    const text = renderSurvey({
      version: 1,
      updated_at: "2026-08-25T09:00:00Z",
      families: FAMILY_ORDER.map((family) => ({
        family,
        title: `T-${family}`,
        why: "w",
        scanned: 14,
        found: 0,
      })),
      candidates: [],
      coverage: { prs_scanned: 14, rounds_with_local_record: 30, rounds_reported: 30 },
    });
    expect(text).toContain("Nothing worth adjudicating");
    for (const family of FAMILY_ORDER) expect(text).toContain(`T-${family}`);
  });

  it("an unchanged snapshot costs the poll nothing: no per-round reads, no rewrite", async () => {
    // Adversarial finding (P2): the sweep re-read every manifest for every PR
    // and rewrote candidates.json on every 3-second poll, unconditionally —
    // unbounded sync fs work on the paint process.
    const dir = mkdtempSync(join(tmpdir(), "qcr-cand-"));
    writeManifest(dir, 5249, 1, "done", "REQUEST_CHANGES");
    const store = new CandidateStore(dir);
    const sweeper = new CandidateSweeper(store, {
      evidenceDir: dir,
      now: () => new Date("2026-08-25T09:00:00Z"),
    });
    const snap = snapshot([
      {
        number: 5249,
        state: "reviewing",
        title: "t",
        head_sha: "abc",
        stale_recheck: 0,
        rounds: 1,
      } as never,
    ]);

    const first = await sweeper.sweep(snap);
    expect(first!.coverage.rounds_with_local_record).toBe(1);
    expect(listIn(store)).toBeDefined();

    // Remove BOTH files from under it: an unchanged snapshot must re-read
    // neither — the round facts come from the signature-keyed cache and the
    // save is skipped because nothing material changed.
    rmSync(join(dir, "pr-5249"), { recursive: true, force: true });
    rmSync(store.path, { force: true });
    const second = await sweeper.sweep(snap);
    expect(second!.coverage.rounds_with_local_record).toBe(1); // cache, not fs
    expect(existsSync(store.path)).toBe(false); // no write happened

    // A moved PR is re-read (the manifest is gone, so its local record drops)
    // and the changed result IS saved.
    const moved = snapshot([
      {
        number: 5249,
        state: "reviewing",
        title: "t",
        head_sha: "def",
        stale_recheck: 0,
        rounds: 1,
      } as never,
    ]);
    const third = await sweeper.sweep(moved);
    expect(third!.coverage.rounds_with_local_record).toBe(0);
    expect(existsSync(store.path)).toBe(true);
  });

  it("a backlog draining without a signature move is still picked up", async () => {
    // The copier lands ROUNDS_PER_SWEEP rounds per tick with no
    // snapshot change — a signature-only cache would freeze the shortfall.
    const dir = mkdtempSync(join(tmpdir(), "qcr-cand-"));
    writeManifest(dir, 5180, 1, "done", "REQUEST_CHANGES");
    const store = new CandidateStore(dir);
    const sweeper = new CandidateSweeper(store, {
      evidenceDir: dir,
      now: () => new Date("2026-08-25T09:00:00Z"),
    });
    const snap = snapshot([
      {
        number: 5180,
        state: "reviewing",
        title: "t",
        head_sha: "abc",
        stale_recheck: 0,
        rounds: 3,
      } as never,
    ]);

    const first = await sweeper.sweep(snap);
    expect(first!.coverage.rounds_with_local_record).toBe(1);
    writeManifest(dir, 5180, 2, "done", "REQUEST_CHANGES");
    writeManifest(dir, 5180, 3, "done", "REQUEST_CHANGES");
    const second = await sweeper.sweep(snap); // same signature, more manifests
    expect(second!.coverage.rounds_with_local_record).toBe(3);
  });

  it("a sweep is re-entrant-safe and never throws on a bad snapshot", async () => {
    const dir = mkdtempSync(join(tmpdir(), "qcr-cand-"));
    const sweeper = new CandidateSweeper(new CandidateStore(dir), { evidenceDir: dir });
    expect(await sweeper.sweep(undefined)).toBeUndefined();
    expect(sweeper.running).toBe(false);
  });

  // the data-loss defect. `(lastList ?? store.load())?.candidates ?? []`
  // read a torn file as "no candidates", merged from that empty baseline (so
  // every candidate whose PR has left the snapshot was dropped) and then SAVED
  // the truncation over the history the feature IS.
  describe("an unreadable candidates.json is never read as an empty one", () => {
    const TORN =
      '{\n  "version": 1,\n  "updated_at": "2026-08-25T09:00:00Z",\n  "candidates": [\n    { "key": "no-verdict:pr-42"';

    it("the sweep stands down: it neither merges from empty nor writes over the file", async () => {
      const dir = mkdtempSync(join(tmpdir(), "qcr-cand-"));
      writeManifest(dir, 5000, 1, "done", "APPROVE");
      const store = new CandidateStore(dir);
      writeFileSync(store.path, TORN); // a crash between the tmp write and the rename
      const notices: string[] = [];
      const sweeper = new CandidateSweeper(store, {
        evidenceDir: dir,
        now: () => new Date("2026-08-25T09:00:00Z"),
        onNotice: (t) => notices.push(t),
      });

      const list = await sweeper.sweep(
        snapshot([
          {
            number: 5000,
            state: "closed",
            title: "t",
            head_sha: "abc",
            stale_recheck: 0,
            rounds: 1,
          } as never,
        ]),
      );

      expect(list).toBeUndefined(); // no list built from an unread baseline
      expect(readFileSync(store.path, "utf8")).toBe(TORN); // and nothing written over it
      expect(notices).toHaveLength(1);
      expect(notices[0]).toMatch(/cannot be read/);
      expect(notices[0]).toMatch(/standing down/);
    });

    it("the notice is said once per cause, not once per 3-second poll", async () => {
      const dir = mkdtempSync(join(tmpdir(), "qcr-cand-"));
      const store = new CandidateStore(dir);
      mkdirSync(dir, { recursive: true });
      writeFileSync(store.path, TORN);
      const notices: string[] = [];
      const sweeper = new CandidateSweeper(store, {
        evidenceDir: dir,
        onNotice: (t) => notices.push(t),
      });
      const snap = snapshot([]);
      for (let i = 0; i < 5; i++) await sweeper.sweep(snap);
      expect(notices).toHaveLength(1);
      expect(readFileSync(store.path, "utf8")).toBe(TORN);

      // Repaired: the sweep resumes and saves normally.
      writeFileSync(
        store.path,
        JSON.stringify({ version: 1, updated_at: "", families: [], candidates: [], coverage: {} }),
      );
      expect(await sweeper.sweep(snap)).toBeDefined();
      expect(listIn(store)?.version).toBe(1);
    });

    it("a genuinely absent file is still an empty baseline, not a stand-down", async () => {
      const dir = mkdtempSync(join(tmpdir(), "qcr-cand-"));
      const store = new CandidateStore(dir);
      const notices: string[] = [];
      const sweeper = new CandidateSweeper(store, {
        evidenceDir: dir,
        onNotice: (t) => notices.push(t),
      });
      expect(await sweeper.sweep(snapshot([]))).toBeDefined();
      expect(notices).toEqual([]);
      expect(existsSync(store.path)).toBe(true);
    });
  });

  it("the list lands in the evidence dir, so it rides /evidence:ro", async () => {
    const dir = mkdtempSync(join(tmpdir(), "qcr-cand-"));
    const store = new CandidateStore(dir);
    expect(store.path).toBe(join(dir, "candidates.json"));
    const sweeper = new CandidateSweeper(store, { evidenceDir: dir });
    await sweeper.sweep(snapshot([]));
    expect(listIn(store)?.version).toBe(1);
  });
});
