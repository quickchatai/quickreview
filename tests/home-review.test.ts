// The home's review button through its factory, on a fake pi with
// a fake reviewer that scripts preview, start, status and the result: the
// price on rest, the review's progress in the details area, its findings,
// the post ask the posting rule makes, failed and stopped runs, and
// re-attaching after a restart. Each case drives the home as a person or the
// model would (keys, tools, timers) and asserts the panel's lines, the chat
// and what was asked of the reviewer.
import { describe, expect, it } from "vitest";
import { createHome } from "../extensions/home.js";
import { KEEP_IT_HERE } from "@quickchatai/pi-quickreview/src/plugin/review.js";
import {
  known,
  unknown,
  type HomeAdapters,
  type Known,
  type LiveLens,
  type OpenPull,
  type Outcome,
  type PrReview,
  type ReviewQuote,
  type ReviewRunStatus,
  type ReviewsPort,
} from "../src/home/ports.js";
import { PRICE_REST_MS, STATUS_POLL_MS } from "../src/home/model.js";
import { fakePi, settle, type FakePi } from "./helpers/fake-pi.js";

const NOW = Date.parse("2026-10-26T12:00:00Z");

function pull(n: number, over: Partial<OpenPull> = {}): OpenPull {
  return {
    number: n,
    title: `Change number ${n}`,
    author: `dev${n}`,
    updatedAt: new Date(NOW - n * 3_600_000).toISOString(),
    isDraft: false,
    additions: 10 * n,
    deletions: n,
    changedFiles: n,
    headRefName: `branch-${n}`,
    headSha: `sha${n}`,
    ...over,
  };
}

const quote = (pr: number, over: Partial<ReviewQuote> = {}): ReviewQuote => ({
  estimateUsd: 1.33,
  capUsd: 2.66,
  key: `key-${pr}`,
  lenses: [
    "pass-security--sol-high",
    "pass-tests--sol-high",
    "pass-data-safety--terra-med",
    "pass-validate--sol-high",
  ],
  files: 4,
  headSha: `sha${pr}`,
  ...over,
});

const lens = (agent: string, status: string, over: Partial<LiveLens> = {}): LiveLens => ({
  agent,
  status,
  toolCount: 0,
  durationMs: 0,
  line: `${agent.replace(/^pass-/, "").replace(/--.*$/, "")} · ${status}`,
  ...over,
});

const running = (runId: string, pr: number, lenses: LiveLens[] = []): ReviewRunStatus => ({
  runId,
  state: "running",
  repo: "acme/widgets",
  pr,
  startedAt: NOW,
  report: `/state/home/reviews/acme-widgets/pr-${pr}.md`,
  ...(lenses.length ? { live: { lastActivity: "the lenses are running", lenses } } : {}),
  errors: [],
});

const FINDINGS = {
  findings: [
    {
      severity: "P1",
      path: "src/deep/auth/token.ts",
      line: 12,
      title: "the token is logged",
      lens: "pass-security--sol-high",
    },
    {
      severity: "P2",
      path: "src/db.ts",
      line: 40,
      title: "a migration drops a column",
      lens: "pass-data-safety--terra-med",
    },
    { severity: "nit", path: null, line: null, title: "naming", lens: "pass-tests--sol-high" },
  ],
  costUsd: 1.11,
  postFile: "/state/review/detached/runs/r1/work/x/out/post.json",
};

const done = (
  runId: string,
  pr: number,
  result: ReviewRunStatus["result"] = FINDINGS,
): ReviewRunStatus => ({
  ...running(runId, pr),
  state: "done",
  endedAt: NOW + 199_000,
  result,
});

/** A scripted reviewer. Previews wait for `answer` unless `instant`. */
function fakeReviewer(o: { instant?: boolean; dryRun?: Known<boolean> } = {}) {
  const previews: Array<{
    pr: number;
    signal?: AbortSignal;
    answer: (r: Outcome<{ quote: ReviewQuote }>) => void;
  }> = [];
  const starts: Array<{ repo: string; pr: number; key: string }> = [];
  const stops: string[] = [];
  const posts: string[] = [];
  /** Per run id: the statuses to answer in turn; the last one repeats. */
  const statuses = new Map<string, ReviewRunStatus[]>();
  const r = {
    previews,
    starts,
    stops,
    posts,
    statuses,
    registry: [] as ReviewRunStatus[],
    latest: known(new Map<number, PrReview>()) as Known<ReadonlyMap<number, PrReview>>,
    startAnswer: null as Outcome<{ runId: string; report: string }> | null,
    postAnswer: { ok: true, line: "Dry run: the review was recorded, not posted." } as Outcome<{
      line: string;
    }>,
    previewAnswer: (pr: number): Outcome<{ quote: ReviewQuote }> => ({
      ok: true,
      quote: quote(pr),
    }),
    /** Answer the oldest preview still waiting for `pr`. */
    answer(pr: number, a?: Outcome<{ quote: ReviewQuote }>): void {
      const i = previews.findIndex((p) => p.pr === pr);
      if (i < 0) throw new Error(`no preview of #${pr} is waiting`);
      const p = previews.splice(i, 1)[0]!;
      p.answer(a ?? r.previewAnswer(pr));
    },
    port: undefined as unknown as ReviewsPort,
  };
  const asked: number[] = [];
  r.port = {
    latest: async () => r.latest,
    autoRounds: async () => known(new Map()),
    preview: (_repo, pr, opts = {}) =>
      new Promise((answer) => {
        asked.push(pr);
        if (o.instant) return answer(r.previewAnswer(pr));
        previews.push({ pr, ...(opts.signal ? { signal: opts.signal } : {}), answer });
      }),
    start: async (repo, pr, key) => {
      starts.push({ repo, pr, key });
      return (
        r.startAnswer ?? {
          ok: true,
          runId: `r${starts.length}`,
          report: `/state/home/reviews/acme-widgets/pr-${pr}.md`,
        }
      );
    },
    status: async (id) => {
      const q = statuses.get(id);
      if (!q || q.length === 0) return unknown(`no review run ${id}`);
      return known(q.length > 1 ? q.shift()! : q[0]!);
    },
    stop: async (id) => {
      stops.push(id);
      return { ok: true };
    },
    runs: async () => known(r.registry),
    post: async (file) => {
      posts.push(file);
      return r.postAnswer;
    },
    dryRun: async () => o.dryRun ?? known(true),
  };
  return Object.assign(r, { asked });
}

type Reviewer = ReturnType<typeof fakeReviewer>;

interface Timer {
  ms: number;
  fn: () => void;
  cancelled: boolean;
}

interface Home {
  pi: FakePi;
  rv: Reviewer;
  timers: Timer[];
  /** Fire every pending one-shot timer of `ms`, then let it settle. */
  fire(ms: number): Promise<void>;
  lines(height?: number): string[];
}

async function openHome(
  rv: Reviewer = fakeReviewer(),
  o: {
    pulls?: OpenPull[];
    posting?: string;
    select?: (title: string, options: string[]) => string | undefined;
  } = {},
): Promise<Home> {
  const timers: Timer[] = [];
  const pulls = o.pulls ?? [pull(1), pull(2), pull(3)];
  const pi = fakePi({
    ...(o.posting !== undefined ? { settings: { quickreview: { posting: o.posting } } } : {}),
    ...(o.select ? { select: o.select } : {}),
  });
  const adapters: HomeAdapters = {
    login: { providers: async () => known(["openai-codex"]) },
    github: {
      user: async () => known("octo"),
      openPulls: async () => known(pulls),
      openInBrowser: async () => ({ ok: true }),
    },
    repo: { repo: async () => known("acme/widgets") },
    clock: { now: () => NOW },
    reviews: rv.port,
    autoReview: { status: async () => unknown("not in this test") },
    memory: { status: async () => unknown("not in this test") },
    spend: { totals: async () => unknown("not in this test") },
  };
  await createHome({
    adapters,
    model: "openai-codex/gpt-6.1-sol",
    tools: "reviewer",
    every: () => () => {},
    after: (ms, fn) => {
      const t = { ms, fn, cancelled: false };
      timers.push(t);
      return () => {
        t.cancelled = true;
      };
    },
  })(pi.api);
  await pi.start();
  return {
    pi,
    rv,
    timers,
    fire: async (ms) => {
      const due = timers.filter((t) => t.ms === ms && !t.cancelled);
      for (const t of due) {
        t.cancelled = true;
        t.fn();
      }
      await settle();
    },
    lines: (height = 60) => pi.render(100, height).lines,
  };
}

const text = (lines: string[]): string => lines.join("\n");
/** The details area: from the selected PR's rule to the footer's. */
const details = (lines: string[]): string => {
  const at = lines.findIndex((l) => /^├─ #\d+/.test(l));
  const end = lines.findIndex((l, i) => i > at && /^├─+┤$/.test(l));
  return at < 0 ? "" : lines.slice(at, end < 0 ? undefined : end).join("\n");
};
const rowOf = (lines: string[], n: number): string | undefined =>
  lines.find((l) => new RegExp(`^│.{2}\\S #${n} {2}`).test(l));
const flat = (lines: string[]): string =>
  lines
    .map((l) => l.replace(/^[│├╭╰]─*|[│┤╮╯]$/g, "").trim())
    .join(" ")
    .replace(/\s+/g, " ");

/** Start a review of the selected PR (#3) with an instant preview. */
async function reviewing(
  o: Parameters<typeof openHome>[1] = {},
  rv = fakeReviewer({ instant: true }),
) {
  const h = await openHome(rv, o);
  await h.pi.key("alt+r");
  return h;
}

describe("the price, on rest", () => {
  // MUTATION: show the estimate from the PR's size before the preview answers — this fails.
  it("shows only once the reviewer's preview quotes it", async () => {
    const h = await openHome();
    expect(details(h.lines())).toMatch(/Not reviewed yet\. {2}alt\+r reviews it now/);
    expect(text(h.lines())).not.toMatch(/~\$|price unknown|pricing/);
    expect(h.rv.previews).toEqual([]);
    await h.fire(PRICE_REST_MS);
    expect(h.rv.previews.map((p) => p.pr)).toEqual([3]);
    expect(details(h.lines())).toMatch(/pricing/);
    expect(text(h.lines())).not.toMatch(/~\$/);
    h.rv.answer(3);
    await settle();
    expect(details(h.lines())).toMatch(/~\$1\.33 · stops at \$2\.66 │/);
    expect(rowOf(h.lines(), 3)).toMatch(/@dev3 · 3h · ~\$1\.33/);
    const s = JSON.parse(await h.pi.tool("home_status")) as {
      to_review: Array<{ number: number; price: unknown }>;
    };
    expect(s.to_review.find((r) => r.number === 3)!.price).toEqual({
      estimate_usd: 1.33,
      cap_usd: 2.66,
    });
    expect(s.to_review.find((r) => r.number === 2)!.price).toBeNull();
  });

  it("a preview that fails reads price unknown", async () => {
    const h = await openHome();
    await h.fire(PRICE_REST_MS);
    h.rv.answer(3, { ok: false, why: "gh: HTTP 502" });
    await settle();
    expect(details(h.lines())).toMatch(/price unknown │/);
    expect(rowOf(h.lines(), 3)).not.toMatch(/\$/);
  });

  // The prototype's bug: a pricer still pending for a PR the cursor had left
  // held the next PR's price back. MUTATION: skip pricing while another
  // preview is in flight — this fails.
  it("a pending pricer for a PR the cursor has left never blocks the next one", async () => {
    const h = await openHome();
    // the cursor leaves #3 before its rest is up: #3 is never priced
    await h.pi.key("alt+j");
    await h.fire(PRICE_REST_MS);
    expect(h.rv.previews.map((p) => p.pr)).toEqual([2]);
    // #2's preview is still out when the cursor rests on #1
    await h.pi.key("alt+j");
    await h.fire(PRICE_REST_MS);
    expect(h.rv.asked).toEqual([2, 1]);
    expect(h.rv.previews.find((p) => p.pr === 2)!.signal!.aborted).toBe(true);
    h.rv.answer(1);
    await settle();
    expect(details(h.lines())).toMatch(/~\$1\.33/);
    // the left PR's late answer is dropped, and it is priced again on its next rest
    h.rv.answer(2);
    await settle();
    await h.pi.key("alt+k");
    expect(details(h.lines())).not.toMatch(/~\$/);
    await h.fire(PRICE_REST_MS);
    expect(h.rv.asked).toEqual([2, 1, 2]);
  });

  it("is cached by the PR's head: a new head is priced again", async () => {
    const rv = fakeReviewer({ instant: true });
    const pulls = [pull(1), pull(2), pull(3)];
    const h = await openHome(rv, { pulls });
    await h.fire(PRICE_REST_MS);
    await h.pi.key("alt+j");
    await h.pi.key("alt+k");
    await h.fire(PRICE_REST_MS);
    expect(rv.asked).toEqual([3]);
    pulls[2] = pull(3, { headSha: "sha3-pushed" });
    await h.pi.tool("home_refresh");
    expect(details(h.lines())).not.toMatch(/~\$/);
    await h.fire(PRICE_REST_MS);
    expect(rv.asked).toEqual([3, 3]);
  });
});

describe("the review button", () => {
  // MUTATION: start without the preview's key, or with a destination that posts — this fails.
  it("previews, then starts a detached run with the preview's key, and posts nothing by itself", async () => {
    const rv = fakeReviewer({ instant: true });
    rv.previewAnswer = (pr) => ({ ok: true, quote: quote(pr, { key: "over-the-limit-key" }) });
    const h = await openHome(rv, { posting: "never" });
    expect(await h.pi.tool("home_review_pr", { pr: 2 })).toMatch(
      /the review of #2 started \(run r1, about \$1\.33, stops at \$2\.66\); it writes its report to \/state\/home\/reviews\/acme-widgets\/pr-2\.md and posts nothing by itself/,
    );
    expect(rv.asked).toEqual([2]);
    expect(rv.starts).toEqual([{ repo: "acme/widgets", pr: 2, key: "over-the-limit-key" }]);
    expect(flat(h.lines())).toMatch(
      /Reviewing #2 in the background — about \$1\.33, stops at \$2\.66\. Keep chatting\./,
    );
    expect(rv.posts).toEqual([]);
    // a second start of the same PR while it runs is refused
    expect(await h.pi.tool("home_review_pr", { pr: 2 })).toBe(
      "#2 is already being reviewed (run r1)",
    );
    expect(rv.starts).toHaveLength(1);
  });

  it("⏎ on the focused panel and alt+r while typing both review the selected PR", async () => {
    const rv = fakeReviewer({ instant: true });
    const h = await openHome(rv);
    await h.pi.key("f2");
    await h.pi.input("\r");
    expect(rv.starts.map((s) => s.pr)).toEqual([3]);
    await h.pi.input("\x1b");
    await h.pi.key("alt+j");
    await h.pi.key("alt+r");
    expect(rv.starts.map((s) => s.pr)).toEqual([3, 2]);
  });

  it("status progress fills the details area: the plan, the lens bar and chips, validate, write-up and a now line per running lens", async () => {
    const h = await reviewing();
    h.rv.statuses.set("r1", [
      running("r1", 3, [
        lens("pass-security--sol-high", "running", {
          toolCount: 3,
          durationMs: 5_000,
          currentTool: "read",
          currentTarget: "src/x.ts",
          line: "security · read src/x.ts · 3 tools · 0:05",
        }),
        lens("pass-tests--sol-high", "completed", { toolCount: 7 }),
        lens("pass-data-safety--terra-med", "failed", { toolCount: 1 }),
      ]),
      running("r1", 3, [
        lens("pass-security--sol-high", "completed", { toolCount: 9 }),
        lens("pass-tests--sol-high", "completed", { toolCount: 7 }),
        lens("pass-data-safety--terra-med", "failed", { toolCount: 1 }),
        lens("pass-validate--sol-high", "running"),
      ]),
    ]);
    let d = details(h.lines());
    expect(d).toMatch(/Plan {7}4 files → 3 lenses\s+0:00 · ~\$1\.33, stops at \$2\.66/);
    expect(d).toMatch(/now {2}fetching the pull request/);
    await h.fire(STATUS_POLL_MS);
    d = details(h.lines());
    expect(d).toMatch(/├─ #3 ─+ run r1 ─┤/);
    expect(d).toMatch(/✓ Plan/);
    expect(d).toMatch(/Lenses {5}▰+▱+ 2\/3/);
    expect(d).toMatch(/security 0:05/);
    expect(d).toMatch(/✓ tests 7t/);
    expect(d).toMatch(/✗ data-safety/);
    expect(d).toMatch(/○ Validate {3}checks every finding against the code/);
    expect(d).toMatch(/○ Write-up {3}the review, ready to read or post/);
    expect(d).toMatch(/now {2}security {2}read src\/x\.ts · 3 tools · 0:05/);
    // the row shows the run's progress, and the model sees it too
    expect(rowOf(h.lines(), 3)).toMatch(/▰+▱+ 2\/3 │$/);
    const s = JSON.parse(await h.pi.tool("home_status")) as { reviewing: unknown[] };
    expect(s.reviewing).toEqual([
      expect.objectContaining({ number: 3, run_id: "r1", stage: "lenses", estimate_usd: 1.33 }),
    ]);
    await h.fire(STATUS_POLL_MS);
    d = details(h.lines());
    expect(d).toMatch(/✓ Lenses {5}▰+ 3\/3/);
    expect(d).not.toMatch(/○ Validate/);
    expect(d).toMatch(/✓ security 9t/);
    expect(d).toMatch(/now {2}the lenses are running/);
  });

  // MUTATION: map P1 to medium, or show the estimate as the cost — this fails.
  it("at the end shows the time taken, the real cost and one line per finding", async () => {
    const h = await reviewing({ posting: "never" });
    h.rv.statuses.set("r1", [done("r1", 3)]);
    await h.fire(STATUS_POLL_MS);
    const lines = h.lines();
    const d = details(lines);
    expect(d).toMatch(/✓ Reviewed by you · 3 findings\s+took 3:19 · \$1\.11 │/);
    expect(d).toMatch(/high {3}auth\/token\.ts:12 {2}the token is logged/);
    expect(d).toMatch(/medium src\/db\.ts:40 {2}a migration drops a column/);
    expect(d).toMatch(/low {4}\(whole change\) {2}naming/);
    expect(d).toMatch(/alt\+r shows the review in the chat/);
    // the PR moves to Reviewed
    expect(text(lines)).toMatch(/To review ─+ 2 ─┤/);
    expect(rowOf(lines, 3)).toMatch(/● #3 {2}.*3 findings · you · 0m │$/);
    expect(flat(lines)).toMatch(/#3 reviewed — 3 findings, 1 high\. ⏎ shows them\./);
  });

  it("a result that does not say what it cost reads cost unknown", async () => {
    const h = await reviewing({ posting: "never" });
    h.rv.statuses.set("r1", [done("r1", 3, { ...FINDINGS, costUsd: null })]);
    await h.fire(STATUS_POLL_MS);
    expect(details(h.lines())).toMatch(/took 3:19 · cost unknown │/);
  });
});

describe("a failed or stopped run", () => {
  // MUTATION: leave a failed run's row as reviewing — this fails.
  it("a failed run says why, and the PR can be reviewed again", async () => {
    const h = await reviewing();
    h.rv.statuses.set("r1", [
      { ...running("r1", 3), state: "failed", errors: ["the review crashed: boom"] },
    ]);
    await h.fire(STATUS_POLL_MS);
    const lines = h.lines();
    expect(flat(lines)).toMatch(
      /#3 was not reviewed: the review crashed: boom\. It can be reviewed again\./,
    );
    expect(details(lines)).toMatch(/✗ The last review stopped: the review crashed: boom/);
    expect(details(lines)).toMatch(/Not reviewed yet\. {2}alt\+r reviews it now/);
    expect(rowOf(lines, 3)).toMatch(/○ #3/);
    expect(await h.pi.tool("home_review_pr")).toMatch(/started \(run r2/);
  });

  it("alt+s stops the running review; the stopped run says so and resets the row", async () => {
    const h = await reviewing();
    h.rv.statuses.set("r1", [running("r1", 3)]);
    expect(text(h.lines())).toMatch(/alt\+s stop/);
    await h.pi.key("alt+s");
    expect(h.rv.stops).toEqual(["r1"]);
    expect(flat(h.lines())).toMatch(/Stopping the review of #3…/);
    h.rv.statuses.set("r1", [{ ...running("r1", 3), state: "stopped" }]);
    await h.fire(STATUS_POLL_MS);
    expect(flat(h.lines())).toMatch(/#3 was not reviewed: it was stopped\./);
    expect(rowOf(h.lines(), 3)).toMatch(/○ #3/);
    expect(await h.pi.tool("home_stop_review", { pr: 3 })).toBe("no review of #3 is running");
  });

  it("a preview or a start the reviewer refuses says why and starts nothing", async () => {
    const rv = fakeReviewer({ instant: true });
    rv.previewAnswer = () => ({ ok: false, why: "no GitHub credential found" });
    const h = await openHome(rv);
    expect(await h.pi.tool("home_review_pr")).toBe(
      "the review of #3 did not start: the preview failed: no GitHub credential found",
    );
    expect(rv.starts).toEqual([]);
    expect(rowOf(h.lines(), 3)).toMatch(/○ #3/);
    rv.previewAnswer = (pr) => ({ ok: true, quote: quote(pr) });
    rv.startAnswer = { ok: false, why: "a review of PR acme/widgets#3 is already running" };
    expect(await h.pi.tool("home_review_pr")).toMatch(/did not start: a review of PR/);
    expect(details(h.lines())).toMatch(/The last review stopped: a review of PR/);
  });
});

describe("runs survive the home", () => {
  it("a new home re-attaches to a running run and shows a finished one", async () => {
    const rv = fakeReviewer({ instant: true });
    const first = await reviewing({ posting: "ask" }, rv);
    rv.statuses.set("r1", [running("r1", 3)]);
    await first.pi.emit("session_shutdown");
    // the session's end never stops a review
    expect(rv.stops).toEqual([]);
    expect(first.timers.every((t) => t.cancelled)).toBe(true);

    rv.registry = [done("r0", 2), running("r1", 3)];
    rv.statuses.set("r1", [
      running("r1", 3, [
        lens("pass-tests--sol-high", "running", { line: "tests · grep · 1 tool · 0:02" }),
      ]),
    ]);
    const asked: string[] = [];
    const second = await openHome(rv, {
      posting: "ask",
      select: (t) => (asked.push(t), undefined),
    });
    let lines = second.lines();
    expect(rowOf(lines, 2)).toMatch(/3 findings · you/);
    expect(rowOf(lines, 3)).toMatch(/▱+ 0\/\?/);
    await second.fire(STATUS_POLL_MS);
    lines = second.lines();
    expect(details(lines)).toMatch(/├─ #3 ─+ run r1 ─┤/);
    expect(details(lines)).toMatch(/now {2}tests {2}grep · 1 tool · 0:02/);
    // a run re-attached after the restart shows what it can, and no price it did not see
    expect(details(lines)).toMatch(/price unknown/);
    // the run that finished while the home was closed is shown, never asked about
    await second.pi.tool("home_select", { pr: 2 });
    expect(details(second.lines())).toMatch(/Reviewed by you · 3 findings\s+took 3:19 · \$1\.11/);
    expect(asked).toEqual([]);
    expect(rv.starts).toHaveLength(1);
  });
});

describe("a reviewed PR's findings in the chat", () => {
  // MUTATION: ⏎ on a reviewed PR starts another review — this fails.
  it("⏎ on a reviewed PR sends its findings as a chat message", async () => {
    const rv = fakeReviewer({ instant: true });
    rv.registry = [done("r0", 2)];
    const h = await openHome(rv);
    await h.pi.tool("home_select", { pr: 2 });
    await h.pi.key("f2");
    expect(text(h.lines())).toMatch(/⏎ show review/);
    await h.pi.input("\r");
    expect(rv.starts).toEqual([]);
    expect(h.pi.sent).toHaveLength(1);
    const m = h.pi.sent[0] as { customType: string; content: string; display: boolean };
    expect(m.customType).toBe("qcr-review");
    expect(m.display).toBe(true);
    expect(m.content).toMatch(/\*\*#2 Change number 2\*\* — reviewed by you: 3 findings, 1 high/);
    expect(m.content).toMatch(
      /1\. \*\*high\*\* `src\/deep\/auth\/token\.ts:12` — the token is logged _\(security\)_/,
    );
    expect(m.content).toMatch(/3\. \*\*low\*\* `\(whole change\)` — naming/);
    expect(m.content).toMatch(/Full report: `\/state\/home\/reviews\/acme-widgets\/pr-2\.md`/);
    expect(await h.pi.tool("home_show_review", { pr: 2 })).toBe("the review of #2 is in the chat");
    expect(await h.pi.tool("home_show_review", { pr: 1 })).toBe("#1 has no review yet");
  });
});

describe("the posting rule after a review", () => {
  const finish = async (o: Parameters<typeof openHome>[1]): Promise<Home> => {
    const h = await reviewing(o);
    h.rv.statuses.set("r1", [done("r1", 3)]);
    await h.fire(STATUS_POLL_MS);
    return h;
  };

  // MUTATION: offer Yes first, or post on no answer — this fails.
  it("ask: the question offers No first, and no answer posts nothing", async () => {
    const h = await finish({ posting: "ask" });
    expect(h.pi.selects).toHaveLength(1);
    expect(h.pi.selects[0]!.title).toBe(
      "Post the review of #3 (acme/widgets) on GitHub as a comment-only review?",
    );
    expect(h.pi.selects[0]!.options[0]).toBe(KEEP_IT_HERE);
    expect(h.pi.selects[0]!.options[1]).toMatch(/^Yes, post it \(dry run/);
    // the review is in the chat before the question
    expect((h.pi.sent[0] as { content: string }).content).toMatch(/the token is logged/);
    expect(h.rv.posts).toEqual([]);
    expect(flat(h.lines())).toMatch(/The review of #3 stays here: nothing was posted\./);
  });

  it("ask: a yes posts the finished review through the gate (recorded on a dry-run install)", async () => {
    const h = await finish({ posting: "ask", select: (_t, options) => options[1] });
    expect(h.rv.posts).toEqual([FINDINGS.postFile]);
    expect(flat(h.lines())).toMatch(/Dry run: the review was recorded, not posted\./);
  });

  it("ask: No keeps it here", async () => {
    const h = await finish({ posting: "ask", select: (_t, options) => options[0] });
    expect(h.rv.posts).toEqual([]);
  });

  it("never: nothing is asked and nothing posted", async () => {
    const h = await finish({ posting: "never" });
    expect(h.pi.selects).toEqual([]);
    expect(h.rv.posts).toEqual([]);
  });

  it("always: it posts without asking, and says so", async () => {
    const h = await finish({ posting: "always" });
    expect(h.pi.selects).toEqual([]);
    expect(h.rv.posts).toEqual([FINDINGS.postFile]);
  });

  // MUTATION: drop the settings' warnings in postingRule — this fails.
  it("a misspelt rule is ask, never a post, and the person is told why", async () => {
    const h = await finish({ posting: "yes-please" });
    expect(h.pi.selects).toHaveLength(1);
    expect(h.rv.posts).toEqual([]);
    expect(h.pi.notes).toContain(
      'pi settings: quickreview.posting is "yes-please", not one of ask, never, always; it stays "ask"',
    );
  });

  // MUTATION: send the review message without `triggerTurn: false` — this fails.
  it("the findings are shown in the chat, never a turn that steers the agent", async () => {
    const h = await finish({ posting: "ask" });
    expect(h.pi.sent).toHaveLength(1);
    expect(h.pi.sentOptions).toEqual([{ triggerTurn: false }]);
  });

  it("a review with nothing kept to post asks nothing", async () => {
    const h = await reviewing({ posting: "always" });
    const { postFile: _none, ...rest } = FINDINGS;
    h.rv.statuses.set("r1", [done("r1", 3, rest)]);
    await h.fire(STATUS_POLL_MS);
    expect(h.rv.posts).toEqual([]);
  });

  it("a post that fails says why", async () => {
    const rv = fakeReviewer({ instant: true });
    rv.postAnswer = { ok: false, why: "GitHub refused the review on acme/widgets#3 (422)" };
    const h = await reviewing({ posting: "always" }, rv);
    rv.statuses.set("r1", [done("r1", 3)]);
    await h.fire(STATUS_POLL_MS);
    expect(flat(h.lines())).toMatch(/The review of #3 was not posted: GitHub refused/);
  });
});
