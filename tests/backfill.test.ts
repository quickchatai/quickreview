// M2 backfill importer. The GitHub side is a fake fetch behind the
// real GitHubAdapter (github.test.ts style), so the GraphQL/search shapes are
// exercised too; the store is an in-memory StateStore.
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseConfig, type Config } from "../src/config.js";
import { MutationGate } from "../src/gate.js";
import { GitHubAdapter } from "../src/github.js";
import type { FetchFn, TokenMinter } from "../src/githubAuth.js";
import { StateStore } from "../src/state.js";
import type { PrReviewHistory, PrTimelineRecord } from "../src/github.js";
import { enumerationQueries, planPr, runBackfill, triggerCandidates, triggerForReview, verdictForReviewState } from "../src/backfill.js";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const cfg: Config = parseConfig(readFileSync(join(root, "config.toml"), "utf8"));

const minter = {
  appJwt: () => "jwt.fake.token",
  installationToken: async () => "ghs_installation",
  invalidate: () => {},
} as unknown as TokenMinter;

// ---- fake GitHub -----------------------------------------------------------

interface FakeReview {
  databaseId: number;
  state: string;
  submittedAt: string | null;
  body?: string;
  commit?: { oid: string } | null;
}

interface FakePr {
  number: number;
  title?: string;
  author?: string;
  createdAt?: string;
  mergedAt?: string | null;
  closedAt?: string | null;
  merged?: boolean;
  reviews?: FakeReview[];
  timeline?: Array<Record<string, unknown>>;
}

function labeled(createdAt: string, name: string, actor = "alice"): Record<string, unknown> {
  return { __typename: "LabeledEvent", createdAt, label: { name }, actor: { login: actor } };
}

function teamRequested(createdAt: string, slug = "review"): Record<string, unknown> {
  return { __typename: "ReviewRequestedEvent", createdAt, requestedReviewer: { slug } };
}

function forcePushed(createdAt: string): Record<string, unknown> {
  return { __typename: "HeadRefForcePushedEvent", createdAt };
}

let dryrunDir: string;

beforeEach(() => {
  dryrunDir = mkdtempSync(join(tmpdir(), "qcr-backfill-"));
});
afterEach(() => {
  rmSync(dryrunDir, { recursive: true, force: true });
});

/** Build the real adapter over a fake fetch serving the two searches and the
 * per-PR GraphQL history. */
function harness(prs: FakePr[], searchByQuery?: Record<string, number[]>) {
  const byNumber = new Map(prs.map((p) => [p.number, p]));
  const calls: Array<{ url: string; body: unknown }> = [];
  const fetchFn = (async (url: string | URL, init: RequestInit = {}) => {
    const u = String(url);
    const body = init.body ? (JSON.parse(String(init.body)) as Record<string, unknown>) : undefined;
    calls.push({ url: u, body });
    let payload: unknown;
    if (u.includes("/search/issues")) {
      const q = decodeURIComponent(new URL(u).searchParams.get("q") ?? "");
      const page = Number(new URL(u).searchParams.get("page") ?? "1");
      const numbers = searchByQuery ? (searchByQuery[q] ?? []) : prs.map((p) => p.number);
      payload = { items: page === 1 ? numbers.map((number) => ({ number })) : [] };
    } else if (u.endsWith("/graphql")) {
      const vars = (body?.variables ?? {}) as { number?: number };
      const pr = byNumber.get(Number(vars.number));
      payload = {
        data: {
          repository: {
            pullRequest: pr
              ? {
                  number: pr.number,
                  title: pr.title ?? `PR ${pr.number}`,
                  createdAt: pr.createdAt ?? "2026-01-01T00:00:00Z",
                  closedAt: pr.closedAt ?? null,
                  mergedAt: pr.mergedAt ?? null,
                  merged: pr.merged ?? false,
                  author: { login: pr.author ?? "alice" },
                  reviews: { nodes: pr.reviews ?? [] },
                  timelineItems: { nodes: pr.timeline ?? [] },
                }
              : null,
          },
        },
      };
    } else {
      payload = {};
    }
    return { ok: true, status: 200, json: async () => payload, text: async () => JSON.stringify(payload) } as unknown as Response;
  }) as unknown as FetchFn;

  let adapter!: GitHubAdapter;
  const gate = new MutationGate(true, dryrunDir, (intent) => adapter.executeMutation(intent));
  adapter = new GitHubAdapter(cfg, minter, gate, fetchFn, "https://api.github.com");
  return { adapter, calls };
}

function store(): StateStore {
  return new StateStore(":memory:");
}

function backfilledRows(s: StateStore): any[] {
  return s.db.prepare("SELECT * FROM rounds WHERE backfilled = 1 ORDER BY pr, round_no").all() as any[];
}

// ---- unit: mapping + trigger reconstruction --------------------------------

describe("verdict mapping", () => {
  it("maps the three review states the daemon vocabulary has room for", () => {
    expect(verdictForReviewState("APPROVED")).toBe("APPROVE");
    expect(verdictForReviewState("CHANGES_REQUESTED")).toBe("REQUEST_CHANGES");
    expect(verdictForReviewState("COMMENTED")).toBe("COMMENT");
  });

  it("refuses non-verdict states", () => {
    expect(verdictForReviewState("DISMISSED")).toBeNull();
    expect(verdictForReviewState("PENDING")).toBeNull();
  });
});

describe("trigger reconstruction", () => {
  // The mapped record shape the adapter hands the importer.
  const rec = (
    type: string,
    created_at: string,
    extra: Partial<PrTimelineRecord> = {},
  ): PrTimelineRecord => ({ type, created_at, label: null, actor: null, requested_team: null, requested_user: null, ...extra });
  const rLabeled = (ts: string, label: string, actor = "alice"): PrTimelineRecord => rec("LabeledEvent", ts, { label, actor });
  const rTeam = (ts: string, requested_team = "review"): PrTimelineRecord => rec("ReviewRequestedEvent", ts, { requested_team });
  const rForce = (ts: string): PrTimelineRecord => rec("HeadRefForcePushedEvent", ts);

  const timeline = [
    rLabeled("2026-05-01T10:00:00Z", "AI review requested"),
    rLabeled("2026-05-01T10:01:00Z", "AI review in progress", "example-review"),
    rForce("2026-05-01T10:02:00Z"),
    rTeam("2026-05-02T09:00:00Z"),
    rLabeled("2026-05-02T09:30:00Z", "needs-qa"),
  ];

  it("picks the latest human ask before the review", () => {
    const c = triggerCandidates(timeline, cfg);
    expect(triggerForReview(c, "2026-05-01T11:00:00Z", null)).toBe("2026-05-01T10:00:00Z");
  });

  it("treats a team review request as a trigger", () => {
    const c = triggerCandidates(timeline, cfg);
    expect(triggerForReview(c, "2026-05-02T10:00:00Z", "2026-05-01T11:00:00Z")).toBe("2026-05-02T09:00:00Z");
  });

  it("ignores force pushes and unrelated labels entirely", () => {
    const c = triggerCandidates([rForce("2026-05-01T10:02:00Z"), rLabeled("2026-05-01T10:03:00Z", "needs-qa")], cfg);
    expect(c).toEqual([]);
    expect(triggerForReview(c, "2026-05-01T11:00:00Z", null)).toBeNull();
  });

  it("falls back to the bot's own in-progress label when no human ask is in range", () => {
    const c = triggerCandidates([rLabeled("2026-05-01T10:01:00Z", "AI review in progress", "example-review")], cfg);
    expect(triggerForReview(c, "2026-05-01T11:00:00Z", null)).toBe("2026-05-01T10:01:00Z");
  });

  it("never reaches back past the previous review on the PR", () => {
    const c = triggerCandidates(timeline, cfg);
    expect(triggerForReview(c, "2026-05-01T11:00:00Z", "2026-05-01T10:30:00Z")).toBeNull();
  });
});

describe("enumeration", () => {
  it("unions the label search and the reviewed-by search", async () => {
    const queries = enumerationQueries(cfg);
    expect(queries[0]).toBe('repo:example-org/example-app is:pr label:"Automatic Review"');
    expect(queries[1]).toBe("repo:example-org/example-app is:pr reviewed-by:example-review[bot]");

    const { adapter } = harness(
      [
        { number: 10, reviews: [] },
        { number: 20, reviews: [] },
        { number: 30, reviews: [] },
      ],
      { [queries[0]!]: [30, 10], [queries[1]!]: [10, 20] },
    );
    const s = store();
    const stats = await runBackfill(s, adapter, cfg, { dryRun: true });
    expect(stats.prs_enumerated).toBe(3);
    s.close();
  });
});

// ---- the import ------------------------------------------------------------

const PR_5000: FakePr = {
  number: 5000,
  title: "old work",
  author: "bob",
  createdAt: "2026-05-01T09:00:00Z",
  mergedAt: "2026-05-03T09:00:00Z",
  closedAt: "2026-05-03T09:00:00Z",
  merged: true,
  timeline: [
    labeled("2026-05-01T10:00:00Z", "AI review requested"),
    teamRequested("2026-05-02T09:00:00Z"),
  ],
  reviews: [
    { databaseId: 111, state: "CHANGES_REQUESTED", submittedAt: "2026-05-01T11:00:00Z", body: "nope", commit: { oid: "aaa" } },
    { databaseId: 222, state: "APPROVED", submittedAt: "2026-05-02T10:00:00Z", body: "lgtm", commit: { oid: "bbb" } },
  ],
};

describe("runBackfill", () => {
  it("imports rounds + meta, mapping verdicts and triggers", async () => {
    const { adapter } = harness([PR_5000]);
    const s = store();
    const stats = await runBackfill(s, adapter, cfg, {});

    expect(stats).toMatchObject({ prs_scanned: 1, reviews_imported: 2, skipped_epoch: 0, skipped_existing: 0, meta_rows: 1 });
    const rows = backfilledRows(s);
    expect(rows).toHaveLength(2);
    expect(rows[0]).toMatchObject({
      pr: 5000,
      round_no: 1,
      round_type: "backfill",
      status: "done",
      backfilled: 1,
      verdict: "REQUEST_CHANGES",
      gh_review_id: 111,
      gh_commit_id: "aaa",
      trigger_ts: "2026-05-01T10:00:00Z",
      started_at: "2026-05-01T10:00:00Z",
      finished_at: "2026-05-01T11:00:00Z",
      deadline_at: "2026-05-01T11:00:00Z",
      lenses: "",
      spend_usd: null,
      duration_s: null,
    });
    expect(rows[1]).toMatchObject({ round_no: 2, verdict: "APPROVE", gh_review_id: 222, trigger_ts: "2026-05-02T09:00:00Z" });

    expect(s.backfillPrMeta(5000)).toMatchObject({
      pr: 5000,
      title: "old work",
      author: "bob",
      created_at: "2026-05-01T09:00:00Z",
      merged_at: "2026-05-03T09:00:00Z",
      closed_at: "2026-05-03T09:00:00Z",
      merged: 1,
    });
    s.close();
  });

  it("writes no pr_state and no events rows", async () => {
    const { adapter } = harness([PR_5000]);
    const s = store();
    await runBackfill(s, adapter, cfg, {});
    expect(s.allPrs()).toEqual([]);
    expect((s.db.prepare("SELECT COUNT(*) AS c FROM events").get() as { c: number }).c).toBe(0);
    s.close();
  });

  it("skips reviews from the daemon era (epoch cut)", async () => {
    const pr: FakePr = {
      ...PR_5000,
      reviews: [
        { databaseId: 111, state: "APPROVED", submittedAt: "2026-05-01T11:00:00Z", commit: { oid: "aaa" } },
        { databaseId: 999, state: "APPROVED", submittedAt: "2026-08-14T09:00:00Z", commit: { oid: "zzz" } },
      ],
    };
    const { adapter } = harness([pr]);
    const s = store();
    // A native round establishes the epoch.
    s.db
      .prepare(
        "INSERT INTO rounds (pr, round_no, round_type, lenses, started_at, deadline_at, status) VALUES (5000, 1, 'first', 'x', '2026-08-13T20:45:29Z', '2026-08-13T22:00:00Z', 'running')",
      )
      .run();

    const stats = await runBackfill(s, adapter, cfg, {});
    expect(stats.skipped_epoch).toBe(1);
    expect(stats.reviews_imported).toBe(1);
    const rows = backfilledRows(s);
    expect(rows.map((r) => r.gh_review_id)).toEqual([111]);
    // Numbered below the live round, so MAX(round_no) is untouched.
    expect(rows[0]!.round_no).toBe(0);
    expect((s.db.prepare("SELECT MAX(round_no) AS m FROM rounds WHERE pr = 5000").get() as { m: number }).m).toBe(1);
    // The live round is still running (no verdict), so it does not age the PR:
    // priorRoundCount counts VERDICTED rounds only (2026-08-18, #5313).
    expect(s.priorRoundCount(5000)).toBe(0);
    s.close();
  });

  it("is idempotent: a second run inserts nothing", async () => {
    const { adapter } = harness([PR_5000]);
    const s = store();
    const first = await runBackfill(s, adapter, cfg, {});
    const snapshot = backfilledRows(s);
    const second = await runBackfill(s, adapter, cfg, {});

    expect(first.reviews_imported).toBe(2);
    expect(second.reviews_imported).toBe(0);
    expect(second.skipped_existing).toBe(2);
    expect(backfilledRows(s)).toEqual(snapshot);
    s.close();
  });

  it("skips DISMISSED/PENDING reviews and reviews without a submit time", async () => {
    const pr: FakePr = {
      ...PR_5000,
      reviews: [
        { databaseId: 111, state: "DISMISSED", submittedAt: "2026-05-01T11:00:00Z" },
        { databaseId: 112, state: "PENDING", submittedAt: null },
        { databaseId: 113, state: "COMMENTED", submittedAt: "2026-05-01T12:00:00Z" },
      ],
    };
    const { adapter } = harness([pr]);
    const s = store();
    const stats = await runBackfill(s, adapter, cfg, {});
    expect(stats.skipped_state).toBe(1);
    expect(backfilledRows(s).map((r) => r.verdict)).toEqual(["COMMENT"]);
    s.close();
  });

  it("--dry-run writes nothing at all", async () => {
    const { adapter } = harness([PR_5000]);
    const s = store();
    const lines: string[] = [];
    const stats = await runBackfill(s, adapter, cfg, { dryRun: true, log: (l) => lines.push(l) });

    expect(stats).toMatchObject({ dry_run: true, reviews_imported: 2, meta_rows: 1 });
    expect(backfilledRows(s)).toEqual([]);
    expect(s.allBackfillPrMeta()).toEqual([]);
    expect(readdirSync(dryrunDir)).toEqual([]); // no gate traffic either
    expect(lines.join("\n")).toContain("would import #5000 round 1 REQUEST_CHANGES");
    s.close();
  });

  it("honors --limit and tolerates a PR GitHub no longer serves", async () => {
    const { adapter } = harness([
      { number: 5000, reviews: [] },
      { number: 5001, reviews: [] },
    ]);
    const s = store();
    const stats = await runBackfill(s, adapter, cfg, { dryRun: true, limit: 1 });
    expect(stats.prs_enumerated).toBe(2);
    expect(stats.prs_scanned).toBe(1);
    s.close();

    const missing = harness([]);
    const s2 = store();
    const stats2 = await runBackfill(s2, missing.adapter, cfg, {});
    expect(stats2.prs_scanned).toBe(0);
    s2.close();
  });

  it("issues exactly one GraphQL read per PR and no mutation", async () => {
    const { adapter, calls } = harness([PR_5000]);
    const s = store();
    await runBackfill(s, adapter, cfg, {});
    const graphql = calls.filter((c) => c.url.endsWith("/graphql"));
    expect(graphql).toHaveLength(1);
    expect((graphql[0]!.body as { query: string }).query).toContain("timelineItems");
    expect((graphql[0]!.body as { query: string }).query).not.toContain("mutation");
    expect((graphql[0]!.body as { variables: { author: string } }).variables.author).toBe("example-review[bot]");
    expect(readdirSync(dryrunDir)).toEqual([]);
    s.close();
  });
});

describe("planPr numbering", () => {
  it("numbers below the PR's lowest existing round when the daemon already ran", () => {
    const history = {
      number: 7,
      title: "t",
      author: "a",
      created_at: "2026-05-01T00:00:00Z",
      closed_at: null,
      merged_at: null,
      merged: false,
      timeline: [],
      reviews: [
        { database_id: 1, state: "APPROVED", submitted_at: "2026-05-01T10:00:00Z", body: "", commit_oid: null },
        { database_id: 2, state: "APPROVED", submitted_at: "2026-05-02T10:00:00Z", body: "", commit_oid: null },
      ],
    };
    const plan = planPr(history, cfg, { epoch: null, imported: new Set(), minRoundNo: 1 });
    expect(plan.rounds.map((r) => r.round_no)).toEqual([-1, 0]);
  });
});
