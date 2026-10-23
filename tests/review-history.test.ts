// The review history digest, VM half (src/reviewhistory.ts). The
// GitHub side is a fake fetch behind the REAL GitHubAdapter (backfill.test.ts
// style), so the search and GraphQL shapes are exercised too, and the gate it
// is handed records every mutation it is asked for — there must be none. The
// store is a real in-memory StateStore.
import { mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { parseConfig, type Config } from "../src/config.js";
import { MutationGate } from "@quickchatai/pi-quickreview/src/gate.js";
import { GitHubAdapter, type SearchIssueItem } from "../src/github.js";
import type { FetchFn, TokenMinter } from "@quickchatai/pi-quickreview/src/githubAuth.js";
import {
  COMMENT_BODY_MAX,
  collectReviewHistory,
  humanCommentsOf,
  mergedPrsQueries,
  mergedPrsQuery,
  parseDigest,
  windowStart,
  type PrReviews,
  type ReviewHistorySource,
} from "../src/reviewhistory.js";
import { StateStore } from "../src/state.js";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const cfg: Config = parseConfig(readFileSync(join(root, "tests/fixtures/config.toml"), "utf8"));
const BOT = cfg.github.bot_login;

const minter = {
  appJwt: () => "jwt.fake.token",
  installationToken: async () => "ghs_installation",
  invalidate: () => {},
} as unknown as TokenMinter;

const NOW = new Date("2026-09-29T12:00:00Z");

const user = (login: string) => ({ __typename: "User", login });
const bot = (login: string) => ({ __typename: "Bot", login });

interface FakePr {
  number: number;
  author?: string;
  mergedAt?: string;
  reviews?: Array<Record<string, unknown>>;
}

let dryrunDir: string;
beforeEach(() => {
  dryrunDir = mkdtempSync(join(tmpdir(), "qcr-history-"));
});
afterEach(() => {
  rmSync(dryrunDir, { recursive: true, force: true });
});

function harness(prs: FakePr[], opts: { failGraphql?: number[]; searchFails?: boolean } = {}) {
  const byNumber = new Map(prs.map((p) => [p.number, p]));
  const calls: Array<{ method: string; url: string; body: Record<string, unknown> | undefined }> =
    [];
  const fetchFn = (async (url: string | URL, init: RequestInit = {}) => {
    const u = String(url);
    const body = init.body ? (JSON.parse(String(init.body)) as Record<string, unknown>) : undefined;
    calls.push({ method: init.method ?? "GET", url: u, body });
    let payload: unknown = {};
    if (u.includes("/search/issues")) {
      if (opts.searchFails)
        return {
          ok: false,
          status: 502,
          json: async () => ({}),
          text: async () => "bad gateway",
        } as unknown as Response;
      const page = Number(new URL(u).searchParams.get("page") ?? "1");
      payload = { items: page === 1 ? prs.map((p) => ({ number: p.number })) : [] };
    } else if (u.endsWith("/graphql")) {
      const n = Number((body?.variables as { number?: number } | undefined)?.number);
      if (opts.failGraphql?.includes(n))
        return { ok: false, status: 500, json: async () => ({}) } as unknown as Response;
      const pr = byNumber.get(n);
      payload = {
        data: {
          repository: {
            pullRequest: pr
              ? {
                  number: pr.number,
                  title: `PR ${pr.number}`,
                  mergedAt: pr.mergedAt ?? "2026-09-01T00:00:00Z",
                  author: { login: pr.author ?? "alice" },
                  reviews: { nodes: pr.reviews ?? [] },
                }
              : null,
          },
        },
      };
    }
    return {
      ok: true,
      status: 200,
      json: async () => payload,
      text: async () => JSON.stringify(payload),
    } as unknown as Response;
  }) as unknown as FetchFn;
  const mutations: unknown[] = [];
  const gate = new MutationGate(true, dryrunDir, async (intent) => {
    mutations.push(intent);
    throw new Error("no mutation expected");
  });
  const adapter = new GitHubAdapter(cfg, minter, gate, fetchFn, "https://api.github.com");
  return { adapter, calls, mutations };
}

const PRS: FakePr[] = [
  {
    number: 10,
    author: "alice",
    reviews: [
      {
        author: user("bob"),
        state: "CHANGES_REQUESTED",
        body: "Please wrap the payment write in a transaction.",
        comments: {
          nodes: [
            { author: user("bob"), path: "pay/models.py", body: "This query runs per row." },
            { author: user("alice"), path: "pay/models.py", body: "fixed" }, // the PR author replying
            { author: bot("dependabot"), path: "pay/models.py", body: "bump" },
          ],
        },
      },
      {
        author: bot(cfg.github.app_slug),
        state: "COMMENTED",
        body: "bot review",
        comments: { nodes: [] },
      },
      { author: user("carol"), state: "APPROVED", body: "", comments: { nodes: [] } }, // empty body
      {
        author: user("carol"),
        state: "COMMENTED",
        body: "[feedback] the bot was wrong here",
        comments: { nodes: [] },
      },
    ],
  },
  {
    number: 11,
    author: "dave",
    reviews: [
      {
        author: user("erin"),
        state: "COMMENTED",
        body: "x".repeat(COMMENT_BODY_MAX + 50),
        comments: { nodes: [] },
      },
    ],
  },
];

describe("collectReviewHistory", () => {
  it("keeps human reviewers' comments only, read-only through the App — no gate involvement", async () => {
    const h = harness(PRS);
    const s = new StateStore(":memory:", () => NOW);
    const d = await collectReviewHistory(h.adapter, s, cfg, { now: () => NOW });
    const kept = d.human.comments.map(
      (c) => `${c.pr}:${c.kind}:${c.author}:${c.body.slice(0, 20)}`,
    );
    expect(kept).toEqual([
      `11:review:erin:${"x".repeat(20)}`,
      "10:review:bob:Please wrap the paym",
      "10:inline:bob:This query runs per ",
    ]);
    expect(d.human.comments.find((c) => c.pr === 11)!.body.length).toBe(COMMENT_BODY_MAX + 1); // clipped + ellipsis
    expect(d.human).toMatchObject({
      prs_enumerated: 2,
      prs_scanned: 2,
      prs_missing: 0,
      truncated: false,
    });
    // Only reads: a search GET and one GraphQL query per PR, and no gate call.
    expect(h.mutations).toEqual([]);
    expect(readdirSync(dryrunDir)).toEqual([]);
    for (const c of h.calls) {
      if (c.method !== "GET") {
        expect(c.url).toMatch(/\/graphql$/);
        expect(String(c.body?.query)).not.toMatch(/\bmutation\b/);
      }
    }
    expect(h.calls.filter((c) => c.url.endsWith("/graphql"))).toHaveLength(2);
    s.close();
  });

  it("clamps calendar-month boundaries to shorter months without losing the time", () => {
    expect(windowStart(new Date("2026-03-31T12:34:56.789Z"), 1)).toBe("2026-02-28T12:34:56.789Z");
    expect(windowStart(new Date("2024-03-31T12:34:56.789Z"), 1)).toBe("2024-02-29T12:34:56.789Z");
    expect(windowStart(new Date("2026-01-31T00:00:00Z"), 2)).toBe("2025-11-30T00:00:00.000Z");
  });

  it("enumerates merged PRs in the window with the App's own excluded", async () => {
    const h = harness([]);
    const s = new StateStore(":memory:", () => NOW);
    const d = await collectReviewHistory(h.adapter, s, cfg, { now: () => NOW });
    expect(d.window.since).toBe(windowStart(NOW, 6));
    expect(d.window.since.slice(0, 10)).toBe("2026-03-29");
    // One query per month — GitHub's search stops at 1000 results a query,
    // which six months of a busy repo passes. The last slice is open-ended.
    const qs = h.calls
      .filter((c) => c.url.includes("/search/issues"))
      .map((c) => new URL(c.url).searchParams.get("q") ?? "");
    const base = `repo:${cfg.github.repo} is:pr is:merged`;
    const tail = `-author:app/${cfg.github.app_slug}`;
    expect(qs).toEqual([
      `${base} merged:2026-03-29..2026-04-29 ${tail}`,
      `${base} merged:2026-04-29..2026-05-29 ${tail}`,
      `${base} merged:2026-05-29..2026-06-29 ${tail}`,
      `${base} merged:2026-06-29..2026-07-29 ${tail}`,
      `${base} merged:2026-07-29..2026-08-29 ${tail}`,
      `${base} merged:>=2026-08-29 ${tail}`,
    ]);
    expect(qs[0]).toBe(mergedPrsQuery(cfg, d.window.since, windowStart(NOW, 5)));
    expect(mergedPrsQueries(cfg, NOW, 1)).toEqual([`${base} merged:>=2026-08-29 ${tail}`]);
    s.close();
  });

  it("a PR found by two month slices is read once, and a slice at the search cap is a problem", async () => {
    const h = harness(PRS); // the fake answers every slice with both PRs
    const s = new StateStore(":memory:", () => NOW);
    const d = await collectReviewHistory(h.adapter, s, cfg, { now: () => NOW });
    expect(d.human.prs_enumerated).toBe(2);
    expect(h.calls.filter((c) => c.url.endsWith("/graphql"))).toHaveLength(2);
    expect(d.problems).toEqual([]);

    const capped: ReviewHistorySource = {
      searchIssuesPaged: async (q) =>
        q.includes(">=")
          ? Array.from({ length: 1000 }, (_, i) => ({ number: i + 1 }) as SearchIssueItem)
          : [],
      prReviews: async () => null,
    };
    const c = await collectReviewHistory(capped, s, cfg, { now: () => NOW, limit: 0 });
    expect(c.human.prs_enumerated).toBe(1000);
    expect(c.problems).toEqual([
      expect.stringMatching(/returned its cap \(1000 PRs\) for .*merged:>=2026-08-29/),
    ]);
    s.close();
  });

  it("works for a repo with no history at all: an empty digest, not an error", async () => {
    const h = harness([]);
    const s = new StateStore(":memory:", () => NOW);
    const d = await collectReviewHistory(h.adapter, s, cfg, { now: () => NOW });
    expect(d.human.comments).toEqual([]);
    expect(d.rounds).toEqual([]);
    expect(d.feedback).toEqual([]);
    expect(d.problems).toEqual([]);
    const back = parseDigest(JSON.stringify(d));
    expect(back.ok).toBe(true);
    s.close();
  });

  it("adds the daemon's own finished rounds and the [feedback] ledger inside the window", async () => {
    let clock = new Date("2026-01-01T00:00:00Z"); // before the window
    const s = new StateStore(":memory:", () => clock);
    const old = s.startRound(5, "full", ["pass-baseline"], 60);
    s.finishRound(old, "APPROVE", null, "old round");
    s.recordFeedbackSignal({
      kind: "feedback_comment",
      pr: 5,
      comment_id: 1,
      author: "bob",
      body: "[feedback] old",
      day: "2026-01-01",
    });
    clock = new Date("2026-09-20T00:00:00Z");
    const id = s.startRound(7, "full", ["pass-baseline"], 60);
    s.finishRound(id, "REQUEST_CHANGES", null, "Blocked on a missing index.");
    s.startRound(8, "full", ["pass-baseline"], 60); // still running: no verdict, not history
    s.recordFeedbackSignal({
      kind: "feedback_comment",
      pr: 7,
      comment_id: 2,
      author: "bob",
      body: "[feedback] too picky",
      day: "2026-09-20",
    });
    const d = await collectReviewHistory(harness([]).adapter, s, cfg, { now: () => NOW });
    expect(d.rounds).toEqual([
      {
        pr: 7,
        round_no: 1,
        verdict: "REQUEST_CHANGES",
        finished_at: "2026-09-20T00:00:00.000Z",
        backfilled: false,
        summary: "Blocked on a missing index.",
      },
    ]);
    expect(d.feedback).toEqual([
      {
        pr: 7,
        kind: "feedback_comment",
        created_at: "2026-09-20T00:00:00.000Z",
        author: "bob",
        body: "[feedback] too picky",
      },
    ]);
    s.close();
  });

  it("a PR it cannot read, or a failed search, is a problem on the digest — never fatal", async () => {
    const h = harness(PRS, { failGraphql: [11] });
    const s = new StateStore(":memory:", () => NOW);
    const d = await collectReviewHistory(h.adapter, s, cfg, { now: () => NOW });
    expect(d.human.prs_scanned).toBe(1);
    expect(d.human.prs_missing).toBe(1);
    expect(d.problems.join("\n")).toMatch(/#11: .*graphql → 500/);

    // A read that answers with no pull request is a problem too, not a quiet count.
    const absent = await collectReviewHistory(
      {
        searchIssuesPaged: h.adapter.searchIssuesPaged.bind(h.adapter),
        prReviews: async () => null,
      },
      s,
      cfg,
      { now: () => NOW },
    );
    expect(absent.human.prs_missing).toBe(absent.human.prs_enumerated);
    expect(absent.problems.join("\n")).toMatch(/#11: GitHub returned no pull request/);

    const failed = await collectReviewHistory(harness(PRS, { searchFails: true }).adapter, s, cfg, {
      now: () => NOW,
    });
    expect(failed.human.prs_enumerated).toBe(0);
    expect(failed.problems.join("\n")).toMatch(/merged-PR search failed/);
    expect(parseDigest(JSON.stringify(failed)).ok).toBe(true);
    s.close();
  });

  it("--limit caps the PRs read", async () => {
    const s = new StateStore(":memory:", () => NOW);
    const d = await collectReviewHistory(harness(PRS).adapter, s, cfg, {
      now: () => NOW,
      limit: 1,
    });
    expect(d.human).toMatchObject({ prs_enumerated: 2, prs_scanned: 1 });
    // The newest PR is the one kept — it describes the team as it is now.
    expect(d.human.comments.map((c) => c.pr)).toEqual([11]);
    s.close();
  });
});

describe("humanCommentsOf", () => {
  const pr = (reviews: PrReviews["reviews"]): PrReviews => ({
    number: 1,
    title: "t",
    author: "alice",
    merged_at: null,
    reviews,
  });
  it("drops the App under both of its spellings, bots, the PR author and blank bodies", () => {
    const r = (login: string, type = "User", body = "look here") => ({
      author: { login, type },
      state: "COMMENTED",
      submitted_at: null,
      body,
      comments: [],
    });
    const out = humanCommentsOf(
      pr([
        r(BOT),
        r(cfg.github.app_slug),
        r("renovate", "Bot"),
        r("alice"),
        r("zed", "User", "   "),
        r("yan"),
      ]),
      cfg,
    );
    expect(out.map((c) => c.author)).toEqual(["yan"]);
  });

  it("person mode (auth = user) keeps the person's own review words and drops only the reviewer's", () => {
    const person: Config = {
      ...cfg,
      github: { ...cfg.github, auth: "user", app_slug: "", bot_login: "pat" },
      backfill: { ...cfg.backfill, bot_login: "pat", bot_actor: "" },
    };
    const r = (body: string) => ({
      author: { login: "pat", type: "User" },
      state: "COMMENTED",
      submitted_at: null,
      body,
      comments: [],
    });
    const out = humanCommentsOf(
      pr([r("a review pat typed"), r("Findings\n\n<!-- qcr-post:v1:1:1:abc -->")]),
      person,
    );
    expect(out.map((c) => c.body)).toEqual(["a review pat typed"]);
  });

  it("omits -author:app/<slug> from the merged-PR query when there is no App", () => {
    const person: Config = { ...cfg, github: { ...cfg.github, auth: "user", app_slug: "" } };
    expect(mergedPrsQuery(person, "2026-09-01")).not.toContain("-author:");
    expect(mergedPrsQuery(cfg, "2026-09-01")).toContain(`-author:app/${cfg.github.app_slug}`);
  });
});

describe("parseDigest", () => {
  it("refuses anything that is not a digest this version reads", () => {
    expect(parseDigest("nope")).toEqual({ ok: false, error: "not JSON" });
    expect(parseDigest(JSON.stringify({ kind: "other" })).ok).toBe(false);
    expect(parseDigest(JSON.stringify({ kind: "qcr-review-history", version: 99 })).ok).toBe(false);
    // A field the companion's pages render is checked too, never printed as "undefined".
    const empty = {
      kind: "qcr-review-history",
      version: 1,
      repo: "o/r",
      generated_at: "t",
      window: { since: "a", until: "b", months: 6 },
      human: { prs_enumerated: 0, prs_scanned: 0, prs_missing: 0, truncated: false, comments: [] },
      rounds: [],
      problems: [],
    };
    expect(parseDigest(JSON.stringify({ ...empty, feedback: [] })).ok).toBe(true);
    expect(
      parseDigest(
        JSON.stringify({ ...empty, feedback: [{ pr: 1, kind: "k", body: null, author: null }] }),
      ),
    ).toEqual({
      ok: false,
      error: "feedback[0] is not a feedback signal",
    });
  });
});

describe("structure", () => {
  it("the digest module cannot reach the gate: it imports neither the gate nor the adapter's write side", () => {
    const src = readFileSync(join(root, "src/reviewhistory.ts"), "utf8");
    const imports = [...src.matchAll(/^import[^;]*from "([^"]+)";/gm)].map((m) => m[1]);
    const IDENTITY = "@quickchatai/pi-quickreview/src/identity.js";
    expect(imports.sort()).toEqual(["./config.js", "./github.js", "./state.js", IDENTITY].sort());
    // Every import is type-only, except the pure identity rules (whose own
    // imports are type-only in turn, so the gate stays out of reach).
    // MUTATION: import a value from the gate or the adapter here, or give
    // identity.ts a runtime import — this fails.
    for (const m of src.matchAll(/^import[^;]*from "([^"]+)";/gm))
      if (m[1] !== IDENTITY) expect(m[0]).toMatch(/^import type /);
    const identity = readFileSync(join(root, "packages/pi-plugin/src/identity.ts"), "utf8");
    for (const m of identity.matchAll(/^import[^;]*;/gm)) expect(m[0]).toMatch(/^import type /);
    // The source interface is read-shaped: a search and a per-PR read.
    expect(src).toMatch(
      /interface ReviewHistorySource \{\n {2}searchIssuesPaged\([^)]*\): Promise<SearchIssueItem\[\]>;\n {2}prReviews\(n: number\): Promise<PrReviews \| null>;\n\}/,
    );
  });

  it("`qcr history digest` builds the same record-only gate `qcr backfill` does", () => {
    const cli = readFileSync(join(root, "src/cli.ts"), "utf8");
    const body = cli.slice(
      cli.indexOf("export async function cmdHistory"),
      cli.indexOf("export async function cmdRegression"),
    );
    expect(body).toMatch(/recordOnlyGate\(join\(stateDir\(\), "dryrun"\), "qcr history"\)/);
    expect(body).not.toMatch(/new MutationGate/);
    // …and that helper is a dry-run gate whose executor refuses
    // (tests/outcomes.test.ts drives it); here its shape is pinned too.
    const helper = cli.slice(
      cli.indexOf("export function recordOnlyGate"),
      cli.indexOf("export async function captureOutcomesWindow"),
    );
    expect(helper).toMatch(
      /new MutationGate\(true, dryrunDir, async \(\) => \{\n\s+throw new Error\(`\$\{command\} performs no mutations`\);/,
    );
    expect(body).not.toMatch(/writeFileSync|stateHome\(\)[^;]*digest/);
  });
});
