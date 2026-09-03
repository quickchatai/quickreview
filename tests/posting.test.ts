import { describe, expect, it, vi } from "vitest";
import {
  approvalActions,
  assembleReview,
  directiveEscalationFiles,
  eventForVerdict,
  INLINE_COMMENT_CAP,
  inlineBody,
  renderDirectiveEscalationComment,
  reviewFooter,
  submitReview,
  type Finding,
} from "../src/posting.js";
import {
  ASK_HUMAN_RE,
  ASK_HUMAN_TAG,
  CHECK_THIS_RE,
  DEFERRED_RE,
  postTag,
} from "../src/severity.js";

const PATCH = `@@ -1,4 +1,8 @@
 ctx
+a
+b
+c
+d
 ctx2`;

const patches = { "app/x.py": PATCH };

function finding(over: Partial<Finding> = {}): Finding {
  return {
    severity: "P1",
    confidence: 0.9,
    path: "app/x.py",
    line: 2,
    side: "RIGHT",
    title: "missing await",
    body: "The coroutine is never awaited.",
    lens: "pass-baseline",
    ...over,
  };
}

describe("severity → tag mapping (spec §5)", () => {
  it("maps P0/P1 to blocker regardless of confidence", () => {
    expect(postTag("P0", 0.1)).toBe("blocker");
    expect(postTag("P1", 0.1)).toBe("blocker");
  });

  it("puts the P2 boundary exactly at confidence 0.8", () => {
    expect(postTag("P2", 0.79)).toBe("question");
    expect(postTag("P2", 0.8)).toBe("blocker");
    expect(postTag("P2", 0.81)).toBe("blocker");
  });

  it("maps P3 to question and nit to nit", () => {
    expect(postTag("P3", 1)).toBe("question");
    expect(postTag("nit", 1)).toBe("nit");
  });

  it("carries reachability through assembly: a contrived P0 posts as a question", () => {
    const review = assembleReview({
      pr: 1,
      head_sha: "sha",
      verdict: "REQUEST_CHANGES",
      lenses: ["pass-baseline"],
      patches,
      findings: [finding({ severity: "P0", reachability: "contrived" })],
    });
    const tag = [...review.tags.values()][0];
    expect(tag).toBe("question");
    const comment = review.payload.comments[0]?.body ?? "";
    expect(comment).toContain("[question]");
    // Non-routine reachability is shown; it is what explains the softer tag.
    expect(comment).toContain("· contrived ·");
    // A routine finding's tail is unchanged.
    expect(inlineBody(finding(), "blocker")).toContain(
      "_P1 · confidence 0.90 · lens pass-baseline_",
    );
  });
});

// an ask-your-human question leads with its own marker, before the
// ordinary posting tag — the first line is what routes the comment to a person
// via the implementer, and the reviewed repo's directives key on it.
describe("the [ask your human] marker on an inline comment", () => {
  it("prefixes the tag, keeps the severity tag, and never emits [check this]", () => {
    const body = inlineBody(
      finding({ lens: "pass-ask-human", title: "why does this file exist?" }),
      "question",
    );
    expect(body.split("\n")[0]).toBe("[ask your human] [question] why does this file exist?");
    expect(ASK_HUMAN_RE.test(body)).toBe(true);
    expect(CHECK_THIS_RE.test(body)).toBe(false);
  });

  it("keeps the blocker visible on a blocking question", () => {
    const body = inlineBody(finding({ kind: "ask-human", lens: "pass-baseline" }), "blocker");
    expect(body.split("\n")[0]).toBe("[ask your human] [blocker] missing await");
  });

  it("leaves every other finding's first line exactly as it was", () => {
    expect(inlineBody(finding(), "blocker").split("\n")[0]).toBe("[blocker] missing await");
    expect(inlineBody(finding({ lens: "pass-intent" }), "question").split("\n")[0]).toBe(
      "[question] missing await",
    );
  });

  it("rides assembly end to end", () => {
    const review = assembleReview({
      pr: 1,
      head_sha: "sha",
      verdict: "APPROVE",
      lenses: ["pass-baseline", "pass-ask-human"],
      patches,
      findings: [
        finding({ severity: "P3", lens: "pass-ask-human", title: "do we want dev tracing here?" }),
      ],
    });
    expect(review.payload.comments[0]?.body ?? "").toContain(
      "[ask your human] [question] do we want dev tracing here?",
    );
  });
});

describe("eventForVerdict", () => {
  it("posts NEEDS_HUMAN as a COMMENT review", () => {
    expect(eventForVerdict("APPROVE")).toBe("APPROVE");
    expect(eventForVerdict("REQUEST_CHANGES")).toBe("REQUEST_CHANGES");
    expect(eventForVerdict("NEEDS_HUMAN")).toBe("COMMENT");
  });
});

describe("assembleReview", () => {
  it("builds the payload with tagged inline comments and the ported body order", () => {
    const review = assembleReview({
      pr: 42,
      head_sha: "deadbeef",
      verdict: "REQUEST_CHANGES",
      lenses: ["pass-baseline", "pass-security"],
      patches,
      findings: [
        finding(),
        finding({ severity: "nit", confidence: 0.5, line: 3, title: "naming", lens: "pass-ui" }),
        finding({
          severity: "P2",
          confidence: 0.5,
          line: 4,
          title: "is this intended?",
          lens: "pass-contracts",
        }),
      ],
    });

    expect(review.payload.commit_id).toBe("deadbeef");
    expect(review.payload.event).toBe("REQUEST_CHANGES");
    expect(review.payload.comments).toHaveLength(3);
    expect(review.payload.comments[0]!.body.startsWith("[blocker] missing await")).toBe(true);
    expect(review.payload.comments[1]!.body.startsWith("[nit] naming")).toBe(true);
    expect(review.payload.comments[2]!.body.startsWith("[question] is this intended?")).toBe(true);

    const body = review.payload.body;
    expect(body.startsWith("**Verdict: Changes requested** — 1 blocker, 1 nit, 1 question.")).toBe(
      true,
    );
    expect(body).toContain("_Lenses applied: pass-baseline, pass-security._");
    expect(body.indexOf("### Blockers")).toBeLessThan(body.indexOf("### Nits"));
    expect(body.indexOf("### Nits")).toBeLessThan(body.indexOf("### Questions"));
    expect(body).toContain("`app/x.py:2`");
    expect(body.trimEnd().endsWith(reviewFooter())).toBe(true);
    // no configured login degrades to the role, never a personal name.
    expect(reviewFooter()).toContain("`the review bot`");
    expect(reviewFooter("example-review[bot]")).toContain("`example-review[bot]`");
    expect(body).not.toContain("owner_legacy");
    expect(body).not.toContain("### Start here");
  });

  it("omits empty sections and reads 'no findings' on a clean approve", () => {
    const review = assembleReview({
      pr: 1,
      head_sha: "sha",
      verdict: "APPROVE",
      lenses: ["pass-baseline"],
      findings: [],
    });
    expect(review.payload.event).toBe("APPROVE");
    expect(review.payload.comments).toHaveLength(0);
    expect(review.payload.body).toContain("**Verdict: Approved** — no findings.");
    expect(review.payload.body).not.toContain("### Blockers");
  });

  it("strips comments that do not anchor into the body overflow", () => {
    const review = assembleReview({
      pr: 7,
      head_sha: "sha",
      verdict: "REQUEST_CHANGES",
      lenses: ["pass-baseline"],
      patches,
      findings: [
        finding({ line: 2, title: "anchored" }),
        finding({ line: 99, title: "way out of the diff" }),
        finding({ path: "other/file.py", line: 1, title: "wrong file" }),
        finding({ line: undefined, side: undefined, title: "unanchorable by nature" }),
      ],
    });

    expect(review.payload.comments.map((c) => c.line)).toEqual([2]);
    expect(review.overflow.map((o) => o.finding.title)).toEqual([
      "unanchorable by nature",
      "way out of the diff",
      "wrong file",
    ]);
    const body = review.payload.body;
    expect(body).toContain("### Additional findings (not posted inline)");
    expect(body).toContain("line is outside any changed-line run on that side");
    expect(body).toContain("path is not in this PR's diff");
    expect(body).toContain("no anchor claimed");
  });

  it("caps inline comments at 50 and overflows the rest to the body", () => {
    const many = Array.from({ length: 60 }, (_, i) =>
      finding({ title: `f${i}`, line: 2 + (i % 4) }),
    );
    const review = assembleReview({
      pr: 9,
      head_sha: "sha",
      verdict: "REQUEST_CHANGES",
      lenses: ["pass-baseline"],
      patches,
      findings: many,
    });

    expect(INLINE_COMMENT_CAP).toBe(50);
    expect(review.payload.comments).toHaveLength(50);
    expect(review.overflow).toHaveLength(10);
    expect(review.overflow[0]!.finding.title).toBe("f50");
    expect(review.payload.body).toContain("over the 50-inline-comment cap");
  });

  it("renders the Start here section on NEEDS_HUMAN with reasons and what to validate", () => {
    const review = assembleReview({
      pr: 3,
      head_sha: "sha",
      verdict: "NEEDS_HUMAN",
      lenses: ["pass-baseline", "pass-data-safety"],
      patches,
      ai_approved: true,
      needs_human_reasons: ["migration gate: backfill not proven", "infra paths: ansible/site.yml"],
      findings: [finding({ severity: "P2", confidence: 0.5, title: "unclear ordering" })],
    });

    const body = review.payload.body;
    expect(review.payload.event).toBe("COMMENT");
    expect(body).toContain("### Start here");
    expect(body).toContain("AI_APPROVED");
    expect(body).toContain("- infra paths: ansible/site.yml");
    expect(body).toContain("**Validate before merging:**");
    expect(body).toContain("unclear ordering");
  });

  // carried-over findings are POINTED AT, never restated. The old
  // "Previously deferred, unchanged" section re-narrated each one into the body
  // where the author pays for it, while the ledger and the finding's own live
  // thread already carry that state — 14.2% of the corpus's findings were this
  // shape. Nothing is dropped: the threads are untouched.
  it("points at carried-over findings in one line, and restates none of them", () => {
    const review = assembleReview({
      pr: 4,
      head_sha: "sha",
      verdict: "REQUEST_CHANGES",
      lenses: ["pass-baseline"],
      patches,
      findings: [finding()],
      carried_over: [
        "F3 `app/y.py:10` — unbounded retry loop (raised round 1, unchanged)",
        "F4 `app/z.py:1` — magic string (raised round 2, unchanged)",
      ],
    });
    const body = review.payload.body;
    expect(body).not.toContain("### Previously deferred, unchanged");
    expect(body).toContain(
      "2 findings from earlier rounds are still open on their existing threads",
    );
    // Not one word of the carried-over findings is repeated into the body.
    expect(body).not.toContain("unbounded retry loop");
    expect(body).not.toContain("magic string");
    expect(body).not.toContain("app/y.py");
  });

  it("uses the singular when exactly one finding is carried over", () => {
    const review = assembleReview({
      pr: 4,
      head_sha: "sha",
      verdict: "REQUEST_CHANGES",
      lenses: ["pass-baseline"],
      patches,
      findings: [finding()],
      carried_over: ["F3 `app/y.py:10` — unbounded retry loop"],
    });
    expect(review.payload.body).toContain("1 finding from earlier rounds is still open");
  });
});

// ----: the deferral marker ------------------------------------------
describe("the [deferred] marker", () => {
  it("leads the comment, before the posting tag", () => {
    const body = inlineBody(
      finding({ kind: "deferred", severity: "P3", confidence: 0.5 }),
      "question",
    );
    expect(body.startsWith("[deferred] [question] missing await")).toBe(true);
  });

  it("is never confused with either other marker", () => {
    const body = inlineBody(finding({ kind: "deferred" }), "question");
    expect(CHECK_THIS_RE.test(body)).toBe(false);
    expect(ASK_HUMAN_RE.test(body)).toBe(false);
    expect(DEFERRED_RE.test(body)).toBe(true);
  });

  it("puts exactly one marker on a comment — a deferred question is deferred", () => {
    // A finding could carry both signals (an ask-human question the review then
    // defers). The deferral is the outer state: it is what happens next.
    const body = inlineBody(finding({ kind: "deferred", lens: "pass-ask-human" }), "question");
    expect(body).not.toContain(ASK_HUMAN_TAG);
    expect(body.startsWith("[deferred] [question]")).toBe(true);
  });

  it("does not change the finding's tag — a deferral never blocks or softens", () => {
    expect(
      inlineBody(finding({ kind: "deferred" }), "blocker").startsWith("[deferred] [blocker]"),
    ).toBe(true);
  });
});

// ----: the closed tag grammar --------------------------------------
//
// An invented tag is not a style problem: the tag is what the posting guards,
// resolveOwnReviewThread's refusals and every downstream consumer key on, so a
// finding wearing one silently escapes its own machinery.
describe("the closed tag grammar", () => {
  const tagged = (title: string): Finding => finding({ title });

  it("strips an invented tag from a title before it reaches the wire", () => {
    const review = assembleReview({
      pr: 9,
      head_sha: "sha",
      verdict: "REQUEST_CHANGES",
      lenses: ["pass-baseline"],
      patches,
      findings: [tagged("[start here 3/5] missing await")],
    });
    const body = review.payload.comments[0]?.body ?? "";
    expect(body.startsWith("[blocker] missing await")).toBe(true);
    expect(body).not.toContain("start here");
    // The escape is reported rather than swallowed.
    expect(review.ungrammatical.map((u) => u.tag)).toEqual(["[start here 3/5]"]);
  });

  it("strips a duplicated posting tag without reporting it as an escape", () => {
    const review = assembleReview({
      pr: 9,
      head_sha: "sha",
      verdict: "REQUEST_CHANGES",
      lenses: ["pass-baseline"],
      patches,
      findings: [tagged("[blocker] missing await")],
    });
    expect(review.payload.comments[0]?.body.startsWith("[blocker] missing await")).toBe(true);
    expect(review.ungrammatical).toEqual([]);
  });

  it("leaves a sanctioned marker prefix alone", () => {
    const review = assembleReview({
      pr: 9,
      head_sha: "sha",
      verdict: "REQUEST_CHANGES",
      lenses: ["pass-baseline"],
      patches,
      findings: [tagged("[check this] missing await")],
    });
    expect(review.payload.comments[0]?.body).toContain("[check this] missing await");
    expect(review.ungrammatical).toEqual([]);
  });

  it("never touches a title that carries no tag — no reasoning is cut", () => {
    const long =
      "the retry wrapper duplicates http_client.py:44 and doubles the backoff [see note]";
    const review = assembleReview({
      pr: 9,
      head_sha: "sha",
      verdict: "REQUEST_CHANGES",
      lenses: ["pass-baseline"],
      patches,
      findings: [tagged(long)],
    });
    expect(review.payload.comments[0]?.body).toContain(long);
    expect(review.ungrammatical).toEqual([]);
  });

  it("logs the escape once per review through submitReview", async () => {
    const events: Array<{ kind: string; payload: unknown }> = [];
    const review = assembleReview({
      pr: 9,
      head_sha: "sha",
      verdict: "REQUEST_CHANGES",
      lenses: ["pass-baseline"],
      patches,
      findings: [tagged("[verified] missing await")],
    });
    await submitReview(
      {
        adapter: {
          createReview: async () => ({ executed: true, response: { id: 1, comments: [] } }),
        } as never,
        store: {
          registerBotComment: () => {},
          logEvent: (kind: string, _pr: number | null, payload: unknown) =>
            events.push({ kind, payload }),
        } as never,
      },
      review,
    );
    const escape = events.find((e) => e.kind === "review_tag_outside_grammar");
    expect(escape).toBeDefined();
    expect((escape!.payload as { tags: string[] }).tags).toEqual(["[verified]"]);
  });
});

describe("first-party directive escalation", () => {
  const directive = (path: string, over: Partial<Finding> = {}): Finding =>
    finding({
      path,
      kind: "injection",
      severity: "P1",
      title: "instruction-shaped content",
      body: "The file body instructs agents.",
      lens: "pass-security",
      ...over,
    });

  it("keeps a surviving malicious first-party injection on the blocker path", () => {
    const review = assembleReview({
      pr: 5306,
      head_sha: "sha",
      verdict: "REQUEST_CHANGES",
      lenses: ["pass-security"],
      findings: [directive(".claude/skills/user-journey-analysis/SKILL.md")],
      escalation_mention: "alex",
    });
    expect([...review.tags.values()]).toEqual(["blocker"]);
    expect(review.payload.event).toBe("REQUEST_CHANGES");
    expect(review.payload.body).toContain("### Blockers");
  });

  it("carries EXACTLY ONE escalation comment, @-mentioning the picked teammate and naming the file", () => {
    const review = assembleReview({
      pr: 5306,
      head_sha: "sha",
      verdict: "NEEDS_HUMAN",
      lenses: ["pass-security"],
      findings: [
        directive(".claude/skills/a/SKILL.md"),
        directive(".claude/skills/b/SKILL.md", { line: 3 }),
      ],
      escalation_mention: "alex",
    });
    const body = review.payload.body;
    const sections = body.split("### Security attention — agent-directive injection").length - 1;
    expect(sections).toBe(1); // one comment total, however many directive files
    expect(body).toContain("@alex");
    expect(body).toContain("`.claude/skills/a/SKILL.md`");
    expect(body).toContain("`.claude/skills/b/SKILL.md`");
  });

  it("the escalation comment stays within three sentences", () => {
    const text = renderDirectiveEscalationComment("alex", [
      ".claude/skills/a/SKILL.md",
      "CLAUDE.md",
    ]);
    expect(text.startsWith("@alex")).toBe(true);
    const sentences = text.match(/[.!?](\s|$)/g) ?? [];
    expect(sentences.length).toBeLessThanOrEqual(3);
    expect(text).toContain("ordinary severity and verdict remain in force");
  });

  it("renders without an @ when no mention could be picked", () => {
    const text = renderDirectiveEscalationComment("", ["CLAUDE.md"]);
    expect(text).not.toContain("@");
    expect(text).toContain("a maintainer");
  });

  it("third-party/vendored directive content keeps the blocker and gets no escalation section", () => {
    const review = assembleReview({
      pr: 7,
      head_sha: "sha",
      verdict: "REQUEST_CHANGES",
      lenses: ["pass-security"],
      findings: [directive("node_modules/pkg/CLAUDE.md")],
      escalation_mention: "alex",
    });
    expect([...review.tags.values()]).toEqual(["blocker"]);
    expect(review.payload.body).not.toContain("Security attention — agent-directive injection");
    expect(review.payload.event).toBe("REQUEST_CHANGES");
  });

  it("directiveEscalationFiles deduplicates and ignores non-injection findings on directive paths", () => {
    expect(
      directiveEscalationFiles([
        directive(".claude/skills/a/SKILL.md"),
        directive(".claude/skills/a/SKILL.md", { line: 9 }),
        finding({ path: ".claude/skills/a/SKILL.md", kind: "security" }),
        finding({ path: "src/app.py", kind: "injection" }),
      ]),
    ).toEqual([".claude/skills/a/SKILL.md"]);
  });
});

describe("submitReview", () => {
  const review = () =>
    assembleReview({
      pr: 11,
      head_sha: "sha",
      verdict: "REQUEST_CHANGES",
      lenses: ["pass-baseline"],
      patches,
      findings: [finding()],
    });

  function fakeStore() {
    return { registerBotComment: vi.fn(), logEvent: vi.fn() };
  }

  it("registers every posted comment id when the call executed", async () => {
    const store = fakeStore();
    const adapter = {
      createReview: vi
        .fn()
        .mockResolvedValue({ executed: true, response: { id: 900, comments: [{ id: 901 }] } }),
    };
    const out = await submitReview({ adapter, store }, review());

    expect(out.registered).toEqual([901]);
    expect(store.registerBotComment).toHaveBeenCalledWith(900, 11, "review", null);
    expect(store.registerBotComment).toHaveBeenCalledWith(901, 11, "review_comment", null);
    expect(out.needs_backfill).toBe(false);
  });

  it("links registered comments to the round that posted them (review depth)", async () => {
    const store = fakeStore();
    const adapter = {
      createReview: vi
        .fn()
        .mockResolvedValue({ executed: true, response: { id: 900, comments: [{ id: 901 }] } }),
    };
    await submitReview({ adapter, store }, review(), 3);

    expect(store.registerBotComment).toHaveBeenCalledWith(900, 11, "review", 3);
    expect(store.registerBotComment).toHaveBeenCalledWith(901, 11, "review_comment", 3);
  });

  it("records the intent only in dry-run and asks for a registry backfill", async () => {
    const store = fakeStore();
    const adapter = {
      createReview: vi.fn().mockResolvedValue({ executed: false, dryRunFile: "/tmp/x.json" }),
    };
    const out = await submitReview({ adapter, store }, review());

    expect(out.registered).toEqual([]);
    expect(out.needs_backfill).toBe(true);
    expect(store.registerBotComment).not.toHaveBeenCalled();
    expect(store.logEvent).toHaveBeenCalledWith(
      "review_post_intent",
      11,
      expect.objectContaining({ inline: 1 }),
    );
  });

  it("flags a backfill when the response carries no comment ids", async () => {
    const store = fakeStore();
    const adapter = {
      createReview: vi.fn().mockResolvedValue({ executed: true, response: { id: 5 } }),
    };
    expect((await submitReview({ adapter, store }, review())).needs_backfill).toBe(true);
  });
});

describe("approvalActions", () => {
  const payload = { commit_id: "sha", event: "APPROVE" as const, body: "b", comments: [] };

  it("returns approve → remove label → clear team request, in that order", async () => {
    const actions = approvalActions({ pr: 5, payload, trigger_label: "AI review requested" });
    expect(actions.map((a) => a.step)).toEqual([
      "create_review",
      "remove_label",
      "delete_team_review_request",
    ]);

    const calls: string[] = [];
    const adapter = {
      createReview: vi.fn(async (n: number) => (calls.push("review:" + n), { executed: false })),
      removeLabel: vi.fn(
        async (_n: number, l: string) => (calls.push(`label:${l}`), { executed: false }),
      ),
      deleteTeamReviewRequest: vi.fn(
        async (n: number) => (calls.push(`team:${n}`), { executed: false }),
      ),
    };
    for (const a of actions) await a.run(adapter as never);
    expect(calls).toEqual(["review:5", "label:AI review requested", "team:5"]);
  });

  it("refuses to build an approval sequence from a non-APPROVE payload", () => {
    expect(() =>
      approvalActions({ pr: 5, payload: { ...payload, event: "COMMENT" }, trigger_label: "x" }),
    ).toThrow(/COMMENT payload/);
  });
});
