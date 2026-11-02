// The security family's posting rules, at their seams:
//
//   * the security fold on the render route (reviewrender.ts
//     `applySecurityFoldToRecord`): with `[security] fold` on, a security
//     candidate the validator doubted as `unverifiable` posts as a
//     `security-demoted` question rather than vanishing as a doubt;
//   * the findings record (findingsrecord.ts): the security fields, and the
//     counters that measure the fold and the chain table;
//   * the posting policy (postingpolicy.ts `selectPosted`): `scope =
//     "security"`, the security channel `security_max`, its exemption from
//     the questions rules — and a partial chain, never posted under any
//     policy or none;
//   * the render CLI's config, which carries the fold to the shell route.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { parseFindingsRecord } from "@quickchatai/pi-quickreview/src/findingsrecord.js";
import {
  DEFAULT_POSTING_POLICY,
  postingPolicyAddenda,
  renderPostingPolicyNote,
  selectPosted,
  type PolicyView,
  type PostingPolicy,
} from "@quickchatai/pi-quickreview/src/postingpolicy.js";
import {
  applyPostingPolicyToRecord,
  applySecurityFoldToRecord,
  postedRenderOptions,
  renderPostedReview,
} from "@quickchatai/pi-quickreview/src/reviewrender.js";
import { policeBenchOutput } from "../src/bench/benchposting.js";
import { parseConfig } from "../src/config.js";
import { renderConfig } from "../src/reviewrendercli.js";

const ROOT = join(import.meta.dirname, "..");

function entry(over: Record<string, unknown>): Record<string, unknown> {
  return {
    id: "s1",
    path: "src/api/invoices.ts",
    line: 57,
    lens: "pass-sec-access",
    kind: "security:idor",
    severity: "P1",
    confidence: 0.5,
    reachability: "routine",
    title: "Invoices are read without the tenant key",
    body: "Is org_id always set before this handler? If not, any user reads another org's invoices.",
    reason: "No read settles whether the middleware sets org_id first.",
    ...over,
  };
}

const record = (findings: Array<Record<string, unknown>>) => ({
  pr: 7,
  round_no: 1,
  head_sha: "abc",
  comments_posted: 0,
  verdict: "APPROVE",
  summary: "One security question.",
  lenses_applied: "pass-sec-access",
  findings,
});

const doubted = { disposition: "doubted", word: "unverifiable" };

const findingsOf = (rec: unknown) => (rec as { findings: Array<Record<string, unknown>> }).findings;

describe("the security fold on the render route", () => {
  // MUTATION: drop `securityFold` from renderPostedReview's fold step (always
  // `{ record: shaped, folded: [] }`) — the doubt renders nothing; fails.
  it("posts a doubted, unverifiable security candidate as a question", () => {
    const out = renderPostedReview(record([entry(doubted)]), { securityFold: true });
    expect(out.folded).toEqual(["s1"]);
    expect(out.rendered.comments).toHaveLength(1);
    expect(out.rendered.comments[0]!.body).toMatch(
      /^\[question\] Invoices are read without the tenant key/,
    );
    const f = findingsOf(out.record)[0]!;
    expect(f).toMatchObject({
      disposition: "downgraded",
      word: "security-demoted",
      axis: "confidence",
      posted_as: "question",
      severity: "P1",
      confidence: 0.5,
    });
    // …and the record now counts it as posted, the way the session records it.
    const parsed = parseFindingsRecord(out.record, 7, 1, { fold: true });
    expect(parsed.record!.findings[0]!.disposition).toBe("posted");
    expect(parsed.conformance!.security_doubted).toEqual([]);
  });

  it("does nothing without the fold: the doubt stays a doubt and the record is untouched", () => {
    const rec = record([entry(doubted)]);
    const out = renderPostedReview(rec, {});
    expect(out.folded).toEqual([]);
    expect(out.rendered.comments).toHaveLength(0);
    expect(out.record).toBe(rec);
    expect(findingsOf(rec)[0]!.disposition).toBe("doubted");
    const untouched = record([entry({ ...doubted, lens: "pass-baseline", kind: null })]);
    expect(applySecurityFoldToRecord(untouched).record).toBe(untouched);
  });

  it("folds a killed unverifiable security candidate too — the parser reads it as doubted", () => {
    const out = applySecurityFoldToRecord(
      record([entry({ disposition: "killed", word: "unverifiable" })]),
    );
    expect(out.folded).toEqual(["s1"]);
  });

  // A session that follows the validator's fold but forgets the tag records
  // `downgraded`/`security-demoted` with no `posted_as` — which the record
  // counts as never posted. MUTATION: drop the downgraded branch from
  // applySecurityFoldToRecord — the question renders nothing; this fails.
  const untagged = {
    disposition: "downgraded",
    word: "security-demoted",
    axis: "confidence",
  };

  it("gives a security-demoted downgrade recorded without its tag the question tag", () => {
    const out = renderPostedReview(record([entry(untagged)]), { securityFold: true });
    expect(out.folded).toEqual(["s1"]);
    expect(out.rendered.comments).toHaveLength(1);
    expect(out.rendered.comments[0]!.body).toMatch(
      /^\[question\] Invoices are read without the tenant key/,
    );
    expect(out.rendered.problems.join("\n")).not.toContain("downgraded with no posted_as");
    expect(findingsOf(out.record)[0]).toMatchObject({
      disposition: "downgraded",
      word: "security-demoted",
      posted_as: "question",
      reason: "No read settles whether the middleware sets org_id first.",
    });
    expect(
      parseFindingsRecord(out.record, 7, 1, { fold: true }).record!.findings[0]!.disposition,
    ).toBe("posted");
  });

  it("without the fold, an untagged security-demoted downgrade stays unposted and is named", () => {
    const rec = record([entry(untagged)]);
    const out = renderPostedReview(rec, {});
    expect(out.folded).toEqual([]);
    expect(out.rendered.comments).toHaveLength(0);
    expect(out.rendered.problems.join("\n")).toContain("downgraded with no posted_as");
  });

  it.each([
    [
      "an untagged security-demoted partial chain",
      { ...untagged, lens: "pass-sec-exploit-chain:delta", kind: "partial-chain" },
    ],
    [
      "an untagged security-demoted non-security entry",
      { ...untagged, lens: "pass-baseline", kind: "logic" },
    ],
    ["a security-demoted entry already tagged", { ...untagged, posted_as: "question" }],
    ["a non-security candidate", { ...doubted, lens: "pass-baseline", kind: "logic" }],
    ["a refuted security candidate", { disposition: "doubted", word: "refuted" }],
    ["a bad anchor", { disposition: "doubted", word: "bad-anchor" }],
    [
      "an unverifiable partial chain",
      { ...doubted, lens: "pass-sec-exploit-chain:delta", kind: "partial-chain" },
    ],
    ["a duplicate kill", { disposition: "killed", word: "duplicate" }],
  ])("leaves %s alone", (_what, over) => {
    const rec = record([entry(over)]);
    expect(applySecurityFoldToRecord(rec)).toEqual({ record: rec, folded: [] });
  });

  it("takes the lever from the install's config, and adds no option without it", () => {
    expect(
      postedRenderOptions({ review: { dedup_merge: false }, security: { fold: true } }),
    ).toMatchObject({ securityFold: true });
    expect(postedRenderOptions({ review: { dedup_merge: false } })).not.toHaveProperty(
      "securityFold",
    );
    expect(
      postedRenderOptions({ review: { dedup_merge: false }, security: { fold: false } }),
    ).not.toHaveProperty("securityFold");
  });

  it("the shell route's config carries the profile's fold, and only-mode scopes posting", () => {
    const cfg = parseConfig(readFileSync(join(ROOT, "tests/fixtures/config.toml"), "utf8"));
    const folded = renderConfig("/sandbox", undefined, {
      config: () => cfg,
      profilePosting: () => ({}),
      profileSecurity: () => ({ fold: true, only: true }),
    });
    expect(folded.unread).toBeUndefined();
    expect(folded.cfg.security).toEqual({ fold: true });
    expect(folded.cfg.posting?.scope).toBe("security");
    const plain = renderConfig("/sandbox", undefined, {
      config: () => cfg,
      profilePosting: () => ({}),
      profileSecurity: () => ({}),
    });
    expect(plain.cfg).not.toHaveProperty("security");
    expect(plain.cfg).not.toHaveProperty("posting");
  });
});

describe("the findings record's security fields and counters", () => {
  it("keeps security_outcome and hop_labels when written, and adds no key when not", () => {
    const parsed = parseFindingsRecord(
      record([
        entry({
          id: "c1",
          lens: "pass-sec-exploit-chain:delta",
          kind: "exploit-chain",
          disposition: "posted",
          posted_as: "blocker",
          security_outcome: "Confirmed",
          hop_labels: ["valid", "Valid"],
        }),
        entry({
          id: "p1",
          lens: "pass-baseline",
          kind: null,
          disposition: "posted",
          posted_as: "question",
        }),
      ]),
      7,
      1,
    );
    const [chain, plain] = parsed.record!.findings;
    // Telemetry keeps the chain row's strategy in the lens, verbatim.
    expect(chain!.lens).toBe("pass-sec-exploit-chain:delta");
    expect(chain!.security_outcome).toBe("confirmed");
    expect(chain!.hop_labels).toEqual(["valid", "valid"]);
    expect(plain).not.toHaveProperty("security_outcome");
    expect(plain).not.toHaveProperty("hop_labels");
    expect(parsed.conformance!.security_outcome_mismatch).toEqual([]);
  });

  // MUTATION: drop the `computed !== outcome` comparison — fails (on m3: m1 is
  // a downgraded entry with a posted_as, so it reads as posted, and its
  // partial-chain labels are caught by the partial-chain check on their own).
  it("counts an outcome its hop labels do not compute, and a partial chain marked posted", () => {
    const c = parseFindingsRecord(
      record([
        entry({
          id: "m3",
          kind: "exploit-chain",
          disposition: "posted",
          posted_as: "blocker",
          security_outcome: "question",
          hop_labels: ["valid", "valid"],
        }),
        entry({
          id: "m1",
          kind: "exploit-chain",
          disposition: "downgraded",
          word: "security-demoted",
          posted_as: "question",
          security_outcome: "question",
          hop_labels: ["valid", "plausible", "plausible"],
        }),
        entry({ id: "m2", kind: "partial-chain", disposition: "posted", posted_as: "question" }),
        entry({
          id: "ok",
          kind: "exploit-chain",
          disposition: "doubted",
          word: "partial-chain",
          security_outcome: "partial-chain",
          hop_labels: ["plausible", "plausible"],
        }),
        // Not a security entry: its labels are nobody's business here.
        entry({
          id: "n1",
          lens: "pass-tests",
          kind: "test-gap",
          disposition: "posted",
          posted_as: "question",
          security_outcome: "confirmed",
          hop_labels: ["plausible"],
        }),
      ]),
      7,
      1,
    ).conformance!;
    expect(c.security_outcome_mismatch).toEqual(["m3", "m1", "m2"]);
  });

  // MUTATION: count security_doubted regardless of `opts.fold` — fails.
  it("counts an unverifiable security doubt only while the fold is on", () => {
    const rec = record([
      entry({ id: "d1", ...doubted }),
      entry({ id: "d2", disposition: "doubted", word: "refuted" }),
      entry({ id: "d3", ...doubted, lens: "pass-baseline", kind: null }),
    ]);
    expect(parseFindingsRecord(rec, 7, 1, { fold: true }).conformance!.security_doubted).toEqual([
      "d1",
    ]);
    expect(parseFindingsRecord(rec, 7, 1).conformance!.security_doubted).toEqual([]);
  });

  it("a killed partial chain is kept as a doubt", () => {
    const parsed = parseFindingsRecord(
      record([entry({ kind: "partial-chain", disposition: "killed", word: "partial-chain" })]),
      7,
      1,
    );
    expect(parsed.record!.findings[0]!.disposition).toBe("doubted");
  });
});

type Item = PolicyView & { id: string };
const item = (id: string, over: Partial<PolicyView> = {}): Item => ({
  id,
  cls: "question",
  severity: "P2",
  key: id,
  ...over,
});
const sec = (id: string, over: Partial<PolicyView> = {}): Item =>
  item(id, { security: true, ...over });
const select = (items: Item[], p: PostingPolicy | undefined) => {
  const out = selectPosted(items, (i) => i, p);
  return {
    kept: out.kept.map((i) => i.id),
    withheld: Object.fromEntries(out.withheld.map((w) => [w.item.id, w.word])),
  };
};
const policy = (over: Partial<PostingPolicy>): PostingPolicy => ({
  ...DEFAULT_POSTING_POLICY,
  ...over,
});

describe("the posting policy's security rules", () => {
  // MUTATION: drop the partialChain check at the top of selectPosted — fails.
  it("never posts a partial chain — under no policy, under any, even as a blocker", () => {
    const items = [item("a"), sec("chain", { partialChain: true, cls: "blocker", severity: "P0" })];
    for (const p of [undefined, DEFAULT_POSTING_POLICY, policy({ max_comments: 5 })])
      expect(select(items, p)).toEqual({ kept: ["a"], withheld: { chain: "partial-chain" } });
  });

  it("changes nothing at the defaults when no partial chain is posted", () => {
    const items = [item("a"), sec("b"), item("c", { cls: "nit", severity: "nit" })];
    const out = selectPosted(items, (i) => i, undefined);
    expect(out.kept).toEqual(items);
    expect(out.withheld).toEqual([]);
    expect(renderPostingPolicyNote(DEFAULT_POSTING_POLICY)).toBe("");
    expect(postingPolicyAddenda(DEFAULT_POSTING_POLICY)).toEqual([]);
    expect(
      postingPolicyAddenda(policy({ security_max: 0, scope: "all" })),
      "security keys at their defaults",
    ).toEqual([]);
  });

  // Owner rule: the security profile posts nothing that is not security.
  // Out of scope is not over budget, so a non-security blocker is withheld
  // too; a security blocker posts.
  // MUTATION: restore `&& v.cls !== "blocker"` in selectPosted's scope check
  // (packages/pi-plugin/src/postingpolicy.ts) — `b` is kept, and this fails.
  it("scope = security withholds every non-security finding, a blocker included", () => {
    const out = select(
      [
        item("q"),
        item("n", { cls: "nit", severity: "nit" }),
        item("b", { cls: "blocker", severity: "P1" }),
        sec("sb", { cls: "blocker", severity: "P1" }),
        sec("s"),
      ],
      policy({ scope: "security" }),
    );
    expect(out).toEqual({
      kept: ["sb", "s"],
      withheld: { q: "security-scope", n: "security-scope", b: "security-scope" },
    });
    // Without the scope the same blocker posts whatever the budget.
    const unscoped = select(
      [item("q"), item("b", { cls: "blocker", severity: "P1" })],
      policy({ max_comments: 1 }),
    );
    expect(unscoped.kept).toContain("b");
  });

  // The words the session and the validator read say what the code does: no
  // blocker exemption, so the validator is never told a non-security blocker
  // posts while the profile's addendum tells it to kill one.
  // MUTATION: restore "except a `[blocker]`, which posts whatever its lens"
  // in policyLines — this fails.
  it("the scope's prompt text grants a non-security blocker no exemption", () => {
    const p = policy({ scope: "security" });
    const [addendum] = postingPolicyAddenda(p);
    for (const text of [renderPostingPolicyNote(p), addendum!.text]) {
      expect(text).not.toMatch(/except a `\[blocker\]`/);
      expect(text).not.toContain("whatever its lens");
      expect(text).toContain("a `[blocker]` included");
    }
    expect(addendum!.text).toContain("never withhold a `[blocker]` but a non-security one");
  });

  // The profile's own words state what the code does.
  // MUTATION: restore "nothing else posts but a surviving [blocker]" in
  // profile.toml — this fails.
  it("the security profile's README and profile.toml state that no blocker is exempt", () => {
    const readme = readFileSync(join(ROOT, "profiles", "security", "README.md"), "utf8");
    expect(readme).toMatch(/Only security findings post[^\n]*\n[^\n]*a `\[blocker\]` included/);
    expect(readme).not.toMatch(/exception: a surviving\s+`\[blocker\]`/);
    const toml = readFileSync(join(ROOT, "profiles", "security", "profile.toml"), "utf8");
    expect(toml).toMatch(/nothing else posts, a\n#\s+\[blocker\] included/);
    expect(toml).not.toMatch(/but a\n#\s+surviving \[blocker\]/);
  });

  // MUTATION: let security items count toward max_comments (budget them with
  // the rest) — the non-security question loses its slot; fails.
  it("security_max is the security findings' own budget, apart from max_comments", () => {
    const out = select(
      [
        sec("s1"),
        sec("s2"),
        sec("s3", { severity: "P3" }),
        item("q1"),
        item("q2", { severity: "P3" }),
      ],
      policy({ max_comments: 1, security_max: 2 }),
    );
    expect(out.kept).toEqual(["s1", "s2", "q1"]);
    expect(out.withheld).toEqual({ s3: "over-budget", q2: "over-budget" });
  });

  it("fills the security channel blockers first, then by severity", () => {
    const out = select(
      [
        sec("q", { severity: "P1" }),
        sec("b", { cls: "blocker", severity: "P2" }),
        sec("p0", { severity: "P0" }),
      ],
      policy({ security_max: 2 }),
    );
    expect(out.kept).toEqual(["b", "p0"]);
    expect(out.withheld).toEqual({ q: "over-budget" });
  });

  it("a security channel never competes with the rest: a P3 security question keeps its slot", () => {
    const out = select(
      [item("p1", { severity: "P1" }), sec("p3", { severity: "P3" })],
      policy({ max_comments: 1, security_max: 1 }),
    );
    expect(out.kept).toEqual(["p1", "p3"]);
  });

  // MUTATION: drop `!ownChannel(v)` from the question-not-blocking rule — fails.
  it("exempts security questions from the questions rules while they have a channel", () => {
    const items = [sec("s", { severity: "P3" }), item("q", { severity: "P3" })];
    expect(select(items, policy({ questions: "blocking", security_max: 3 }))).toEqual({
      kept: ["s"],
      withheld: { q: "question-not-blocking" },
    });
    expect(select(items, policy({ questions: "off", security_max: 3 }))).toEqual({
      kept: ["s"],
      withheld: { q: "questions-off" },
    });
    // Without a channel a security question is a question like any other.
    expect(select(items, policy({ questions: "blocking" }))).toEqual({
      kept: [],
      withheld: { s: "question-not-blocking", q: "question-not-blocking" },
    });
  });

  it("states the same rules to the session and the validator", () => {
    const p = policy({ scope: "security", security_max: 4 });
    const note = renderPostingPolicyNote(p);
    expect(note).toContain("Security findings only.");
    expect(note).toContain("`security-scope`");
    expect(note).toContain("their own 4 slots");
    const [addendum] = postingPolicyAddenda(p);
    expect(addendum!.text).toContain("`security-scope`");
    expect(addendum!.text).not.toContain("`partial-chain`");
    // A policy with no security keys lists only the five words it always did.
    const [plain] = postingPolicyAddenda(policy({ max_comments: 3 }));
    expect(plain!.text).not.toContain("security-scope");
    expect(plain!.text).not.toContain("Security findings");
  });
});

describe("both posting routes read security from the record or the comment", () => {
  it("the render route withholds a posted partial chain with no policy at all", () => {
    const rec = record([
      entry({ id: "ok", disposition: "posted", posted_as: "question" }),
      entry({
        id: "pc",
        lens: "pass-sec-exploit-chain:delta",
        kind: "partial-chain",
        disposition: "posted",
        posted_as: "question",
      }),
    ]);
    const out = applyPostingPolicyToRecord(rec, undefined);
    expect(out.withheld.map((w) => [w.id, w.word])).toEqual([["pc", "partial-chain"]]);
    expect(findingsOf(out.record).find((f) => f.id === "pc")!.disposition).toBe("withheld");
    const clean = record([entry({ disposition: "posted", posted_as: "question" })]);
    expect(applyPostingPolicyToRecord(clean, undefined).record).toBe(clean);
  });

  it("the render route scopes by the entry's lens and kind", () => {
    const out = applyPostingPolicyToRecord(
      record([
        entry({ id: "s", disposition: "posted", posted_as: "question" }),
        entry({
          id: "k",
          lens: "pass-baseline",
          kind: "security:ssrf",
          disposition: "posted",
          posted_as: "question",
        }),
        entry({
          id: "n",
          lens: "pass-baseline",
          kind: "logic",
          disposition: "posted",
          posted_as: "question",
        }),
      ]),
      policy({ scope: "security" }),
    );
    expect(out.withheld.map((w) => [w.id, w.word])).toEqual([["n", "security-scope"]]);
  });

  it("the bench export reads a comment's lens from its trailer when the record has no entry", () => {
    const tail = (lens: string) => `\n\n_P3 · confidence 0.50 · lens ${lens}_`;
    const out = policeBenchOutput({
      comments: [
        {
          path: "src/a.ts",
          line: 3,
          side: "RIGHT",
          body: `[question] Tenant key?\n\nAsk.${tail("pass-sec-access")}`,
        },
        {
          path: "src/a.ts",
          line: 9,
          side: "RIGHT",
          body: `[question] Name?\n\nHm.${tail("pass-baseline")}`,
        },
      ],
      reviewMd: "",
      record: { findings: [] },
      outcome: { verdict: "APPROVE", summary: "s" },
      policy: policy({ scope: "security" }),
    });
    expect(out.report.withheld.map((w) => [`${w.path}:${w.line}`, w.word])).toEqual([
      ["src/a.ts:9", "security-scope"],
    ]);
    expect(out.report.kept).toBe(1);
  });
});
