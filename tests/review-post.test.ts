// `qcr review` posting to a PR (src/reviewpost.ts): one COMMENT review, marked,
// deduplicated. GitHub is a stub fetch; nothing is sent anywhere.

import { afterAll, describe, expect, it } from "vitest";
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { MutationGate, type MutationIntent } from "../src/gate.js";
import {
  QCR_VISIBLE_MARKER,
  assemblePostReview,
  localPostGate,
  postReviewToPr,
  type PostRequest,
} from "../src/reviewpost.js";
import { parseFindingMarker } from "../src/findingkey.js";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");

const cfg = { review: {}, github: { bot_login: "quickreview-bot" } };
const record = (verdict: string) => ({
  verdict,
  summary: "s",
  findings: [
    {
      id: "f1",
      path: "src/a.ts",
      line: 2,
      severity: "P1",
      title: "b is wrong",
      body: "b should not be 2.",
      lens: "correctness",
      disposition: "posted",
      posted_as: "[blocker]",
    },
    {
      id: "f2",
      path: "src/a.ts",
      line: 3,
      severity: "P3",
      title: "c naming",
      body: "rename c.",
      lens: "style",
      disposition: "posted",
      posted_as: "[nit]",
    },
  ],
});

describe("assemblePostReview", () => {
  it("is always a COMMENT review, whatever the verdict says", () => {
    for (const v of ["APPROVE", "REQUEST_CHANGES", "COMMENT"]) {
      const r = assemblePostReview(record(v), { cfg, roundNo: 1, lenses: ["correctness"] });
      expect(r.event).toBe("COMMENT");
    }
  });

  it("marks every comment and the body as qcr's, with the hidden finding marker last", () => {
    const r = assemblePostReview(record("REQUEST_CHANGES"), { cfg, roundNo: 3, lenses: [] });
    expect(r.comments).toHaveLength(2);
    for (const c of r.comments) {
      expect(c.body).toContain(QCR_VISIBLE_MARKER);
      expect(c.body.trimEnd().endsWith("-->")).toBe(true);
      expect(parseFindingMarker(c.body)?.round_no).toBe(3);
    }
    expect(parseFindingMarker(r.comments[0]!.body)?.key).toBe("f1");
    expect(r.body).toContain(QCR_VISIBLE_MARKER);
  });
});

function stubGitHub(
  existing: Array<{ path: string; line: number; body: string }> = [],
  reviews: Array<{ body: string }> = [],
) {
  const calls: Array<{ method: string; url: string; body?: any; auth: string | null }> = [];
  const fetchFn = (async (u: string | URL | Request, init?: RequestInit) => {
    const url = String(u);
    const method = init?.method ?? "GET";
    calls.push({
      method,
      url,
      auth: new Headers(init?.headers).get("authorization"),
      ...(init?.body ? { body: JSON.parse(String(init.body)) } : {}),
    });
    if (method === "GET" && url.includes("/pulls/7/comments"))
      return new Response(JSON.stringify(url.includes("page=2") ? [] : existing), { status: 200 });
    if (method === "GET" && url.includes("/pulls/7/reviews"))
      return new Response(JSON.stringify(url.includes("page=2") ? [] : reviews), { status: 200 });
    if (method === "POST" && url.endsWith("/pulls/7/reviews"))
      return new Response(JSON.stringify({ id: 99, html_url: "https://x/review/99" }), {
        status: 200,
      });
    return new Response("{}", { status: 404 });
  }) as typeof fetch;
  return { calls, fetchFn };
}

const tmp = mkdtempSync(join(tmpdir(), "review-post-"));
afterAll(() => rmSync(tmp, { recursive: true, force: true }));

const req = (
  fetchFn: typeof fetch,
  record_ = record("REQUEST_CHANGES"),
  gate?: MutationGate,
  dryRun = false,
): PostRequest => ({
  repo: "o/r",
  number: 7,
  headSha: "abc",
  token: "tok",
  review: assemblePostReview(record_, { cfg, roundNo: 1, lenses: [] }),
  gate:
    gate ??
    localPostGate({
      dryRun,
      dryrunDir: join(tmp, "dryrun"),
      token: "tok",
      fetchFn,
      apiBase: "https://api.test",
    }),
  fetchFn,
  apiBase: "https://api.test",
});

/** A gate that records what it is asked and executes nothing. */
function fakeGate() {
  const intents: MutationIntent[] = [];
  const gate = new MutationGate(false, join(tmp, "unused"), async (i) => {
    intents.push(i);
    return { html_url: "https://x/review/1" };
  });
  return { gate, intents };
}

describe("postReviewToPr", () => {
  it("sends one COMMENT review with the head commit, as the given token", async () => {
    const gh = stubGitHub();
    const res = await postReviewToPr(req(gh.fetchFn));
    expect(res).toMatchObject({ ok: true, posted: 2, skipped: 0 });
    const posts = gh.calls.filter((c) => c.method === "POST");
    expect(posts).toHaveLength(1);
    expect(posts[0]!.body.event).toBe("COMMENT");
    expect(posts[0]!.body.commit_id).toBe("abc");
    expect(posts[0]!.body.comments).toHaveLength(2);
    expect(posts[0]!.auth).toBe("Bearer tok");
  });

  it("never sends APPROVE or REQUEST_CHANGES, even for those verdicts", async () => {
    for (const v of ["APPROVE", "REQUEST_CHANGES"]) {
      const gh = stubGitHub();
      await postReviewToPr(req(gh.fetchFn, record(v)));
      for (const c of gh.calls.filter((x) => x.method === "POST"))
        expect(c.body.event).toBe("COMMENT");
    }
  });

  it("refuses a hand-built payload whose event is not COMMENT", async () => {
    const gh = stubGitHub();
    const r = req(gh.fetchFn);
    (r.review as { event: string }).event = "APPROVE";
    const res = await postReviewToPr(r);
    expect(res.ok).toBe(false);
    expect(gh.calls.filter((c) => c.method === "POST")).toHaveLength(0);
  });

  it("deduplicates a re-post against comments already on the PR", async () => {
    const first = assemblePostReview(record("COMMENT"), { cfg, roundNo: 1, lenses: [] });
    const gh = stubGitHub(
      first.comments.map((c) => ({ path: c.path, line: c.line, body: c.body })),
    );
    const res = await postReviewToPr(req(gh.fetchFn, record("COMMENT")));
    expect(res).toMatchObject({ ok: true, posted: 0, skipped: 2 });
    expect(gh.calls.filter((c) => c.method === "POST")).toHaveLength(0);
  });

  it("posts a finding that reuses an earlier round's key on the same line", async () => {
    const first = assemblePostReview(record("COMMENT"), { cfg, roundNo: 1, lenses: [] });
    const gh = stubGitHub(
      first.comments.map((c) => ({ path: c.path, line: c.line, body: c.body })),
    );
    const changed = record("COMMENT");
    changed.findings[0]!.title = "an unrelated defect";
    changed.findings[0]!.body = "something else entirely.";
    const r = req(gh.fetchFn, changed);
    r.review = assemblePostReview(changed, { cfg, roundNo: 2, lenses: [] });
    const res = await postReviewToPr(r);
    expect(res).toMatchObject({ ok: true, posted: 1, skipped: 1 });
  });

  it("posts a new body-only finding although every inline comment is already there", async () => {
    const first = assemblePostReview(record("COMMENT"), { cfg, roundNo: 1, lenses: [] });
    const gh = stubGitHub(
      first.comments.map((c) => ({ path: c.path, line: c.line, body: c.body })),
    );
    const withBody = record("COMMENT");
    withBody.findings.push({
      id: "f3",
      path: null as unknown as string,
      line: null as unknown as number,
      severity: "P2",
      title: "a body-only finding",
      body: "applies to the whole change.",
      lens: "correctness",
      disposition: "posted",
      posted_as: "[question]",
    });
    const res = await postReviewToPr(req(gh.fetchFn, withBody));
    expect(res).toMatchObject({ ok: true, posted: 0, skipped: 2 });
    const posts = gh.calls.filter((c) => c.method === "POST");
    expect(posts).toHaveLength(1);
    expect(posts[0]!.body.body).toContain("a body-only finding");
    expect(posts[0]!.body.comments).toHaveLength(0);
  });

  it("does not repost a review body already on the PR when it has no inline comment", async () => {
    const bodyOnly = record("COMMENT");
    for (const f of bodyOnly.findings) (f as { inline?: boolean }).inline = false;
    const review = assemblePostReview(bodyOnly, { cfg, roundNo: 1, lenses: [] });
    expect(review.comments).toHaveLength(0);
    const gh = stubGitHub([], [{ body: review.body }]);
    const res = await postReviewToPr(req(gh.fetchFn, bodyOnly));
    expect(res).toMatchObject({ ok: true, posted: 0, url: null });
    expect(gh.calls.filter((c) => c.method === "POST")).toHaveLength(0);
  });

  it("posts only the findings not already there", async () => {
    const first = assemblePostReview(record("COMMENT"), { cfg, roundNo: 1, lenses: [] });
    const c0 = first.comments[0]!;
    const gh = stubGitHub([{ path: c0.path, line: c0.line, body: c0.body }]);
    const res = await postReviewToPr(req(gh.fetchFn, record("COMMENT")));
    expect(res).toMatchObject({ ok: true, posted: 1, skipped: 1 });
    expect(gh.calls.find((c) => c.method === "POST")!.body.comments).toHaveLength(1);
  });

  it("posts through the gate as one create_review intent, not around it", async () => {
    const gh = stubGitHub();
    const g = fakeGate();
    const res = await postReviewToPr(req(gh.fetchFn, record("APPROVE"), g.gate));
    expect(res).toMatchObject({ ok: true, posted: 2, url: "https://x/review/1" });
    // The fake gate's executor took the write; the route sent no POST itself.
    expect(gh.calls.filter((c) => c.method === "POST")).toHaveLength(0);
    expect(g.intents).toHaveLength(1);
    expect(g.intents[0]).toMatchObject({
      kind: "create_review",
      method: "POST",
      path: "/repos/o/r/pulls/7/reviews",
      pr: 7,
    });
    expect((g.intents[0]!.body as { event: string }).event).toBe("COMMENT");
  });

  it("in dry-run the gate records the review under the dryrun dir and sends nothing", async () => {
    const gh = stubGitHub();
    const res = await postReviewToPr(req(gh.fetchFn, record("COMMENT"), undefined, true));
    expect(res).toMatchObject({ ok: true, posted: 0, wouldPost: 2, url: null });
    expect(gh.calls.filter((c) => c.method === "POST")).toHaveLength(0);
    const recorded = (res as { recorded: string }).recorded;
    expect(recorded.startsWith(join(tmp, "dryrun"))).toBe(true);
    expect(existsSync(recorded)).toBe(true);
    const rec = JSON.parse(readFileSync(recorded, "utf8"));
    expect(rec).toMatchObject({ kind: "create_review", pr: 7, body: { event: "COMMENT" } });
    expect(rec.body.comments).toHaveLength(2);
  });

  it("reports a GitHub refusal without throwing", async () => {
    const fetchFn = (async (_u: unknown, init?: RequestInit) =>
      (init?.method ?? "GET") === "POST"
        ? new Response("nope", { status: 422 })
        : new Response("[]", { status: 200 })) as typeof fetch;
    const res = await postReviewToPr(req(fetchFn));
    expect(res.ok).toBe(false);
    expect(!res.ok && res.error).toMatch(/422/);
  });
});

describe("the posting module stays out of the daemon", () => {
  it("has no fetch write of its own: the review POST is a gate intent", () => {
    const text = readFileSync(join(ROOT, "src", "reviewpost.ts"), "utf8");
    // The one fetch with a method is the gate executor's; the reads carry none.
    expect(text.match(/method:/g)?.length).toBe(2); // the intent's and the executor's
    expect(text).toMatch(/req\.gate\.execute\(/);
    expect(text).not.toMatch(/\/reviews`,\s*\{\s*method/);
  });

  it("only the review CLI imports it", () => {
    const importers = readdirSync(join(ROOT, "src"))
      .filter((f) => f.endsWith(".ts") && f !== "reviewpost.ts")
      .filter((f) => /from "\.\/reviewpost\.js"/.test(readFileSync(join(ROOT, "src", f), "utf8")));
    expect(importers).toEqual(["reviewcli.ts"]);
  });

  it("is not reachable from the daemon's files", () => {
    for (const f of ["github.ts", "daemon.ts", "wire.ts", "sessions.ts", "posting.ts"])
      expect(readFileSync(join(ROOT, "src", f), "utf8"), f).not.toMatch(/reviewpost/);
  });
});
