// The bot's posted findings on a PR, read through the resolved credential and
// skipped (src/reviewbotfindings.ts). GitHub is a stub; no network.

import { describe, expect, it } from "vitest";
import { findingMarker } from "../src/findingkey.js";
import { fetchBotFindings, skipPosted, type PostedFinding } from "../src/reviewbotfindings.js";

const comment = (o: { path: string; line: number | null; body: string }) => ({
  path: o.path,
  line: o.line,
  body: o.body,
});

const stub = (pages: unknown[][], status = 200, calls: string[] = []): typeof fetch =>
  (async (url: string | URL | Request, init?: RequestInit) => {
    calls.push(`${String(url)}|${new Headers(init?.headers).get("authorization")}`);
    const page = Number(new URL(String(url)).searchParams.get("page") ?? "1");
    return new Response(JSON.stringify(pages[page - 1] ?? []), { status });
  }) as typeof fetch;

describe("fetchBotFindings", () => {
  it("reads the markers off the PR's review comments through the credential", async () => {
    const calls: string[] = [];
    const r = await fetchBotFindings({
      repo: "o/r",
      number: 7,
      token: "tok",
      fetchFn: stub(
        [
          [
            comment({
              path: "src/a.ts",
              line: 2,
              body: `**b is a magic number**\n\n${findingMarker(1, "f1")}`,
            }),
            comment({ path: "src/a.ts", line: 9, body: "a human remark, no marker" }),
          ],
        ],
        200,
        calls,
      ),
    });
    expect(r.warning).toBeUndefined();
    expect(r.findings).toEqual([
      { key: "f1", round_no: 1, path: "src/a.ts", line: 2, text: "**b is a magic number**" },
    ]);
    expect(calls[0]).toMatch(/\/repos\/o\/r\/pulls\/7\/comments/);
    expect(calls[0]).toMatch(/\|Bearer tok$/);
  });

  it("a PR with no bot comments yields nothing and no warning", async () => {
    const r = await fetchBotFindings({ repo: "o/r", number: 7, token: "t", fetchFn: stub([[]]) });
    expect(r).toEqual({ findings: [] });
  });

  it("a failure to read warns and yields nothing", async () => {
    const bad = await fetchBotFindings({
      repo: "o/r",
      number: 7,
      token: "t",
      fetchFn: stub([[]], 403),
    });
    expect(bad.findings).toEqual([]);
    expect(bad.warning).toMatch(/403/);
    const thrown = await fetchBotFindings({
      repo: "o/r",
      number: 7,
      token: "t",
      fetchFn: (async () => {
        throw new Error("offline");
      }) as typeof fetch,
    });
    expect(thrown.warning).toMatch(/offline/);
    const odd = await fetchBotFindings({
      repo: "o/r",
      number: 7,
      token: "t",
      fetchFn: (async () => new Response('{"title":"x"}', { status: 200 })) as typeof fetch,
    });
    expect(odd.warning).toBeDefined();
  });
});

describe("skipPosted", () => {
  const posted: PostedFinding[] = [
    { key: "f1", round_no: 1, path: "src/a.ts", line: 2, text: "**B is a magic number!**" },
  ];
  it("drops a finding the bot already posted, by title on the same file", () => {
    const r = skipPosted(
      [
        { key: "x9", path: "src/a.ts", line: 40, title: "b is a magic number" },
        { key: "x10", path: "src/a.ts", line: 3, title: "c breaks the build" },
      ],
      posted,
    );
    expect(r.fresh.map((f) => f.key)).toEqual(["x10"]);
    expect(r.skipped).toBe(1);
  });
  it("drops the same key on the same file, and keeps the same title on another file", () => {
    expect(
      skipPosted([{ key: "f1", path: "src/a.ts", line: 2, title: "renamed" }], posted).skipped,
    ).toBe(1);
    expect(
      skipPosted(
        [{ key: "z", path: "src/other.ts", line: 2, title: "b is a magic number" }],
        posted,
      ).skipped,
    ).toBe(0);
  });
  it("keeps a finding that reuses a posted key on another line of the same file", () => {
    const r = skipPosted([{ key: "f1", path: "src/a.ts", line: 40, title: "unrelated" }], posted);
    expect(r.skipped).toBe(0);
  });
  it("with nothing posted, returns the findings untouched", () => {
    const f = [{ key: "a", path: "p", line: 1, title: "t" }];
    expect(skipPosted(f, [])).toEqual({ fresh: f, skipped: 0 });
  });
});
