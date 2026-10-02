// tests/posting-policy.test.ts — the profile's `[posting]` policy
// (src/postingpolicy.ts; bench/aacr/ext/SNAPPY-PLAN.md): parse, validation,
// inheritance, the shipped `snappy` profile, and the mechanical enforcement on
// both routes — production assembly (src/posting.ts) and the benchmark export
// (src/bench/benchposting.ts). The default's byte-identity is pinned in
// tests/posting-default-identity.test.ts.
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { parseConfig, type Config } from "../src/config.js";
import { buildRoundOrder } from "../src/dispatch.js";
import { NONE_ECOSYSTEM } from "../src/ecosystem.js";
import { isKnownVocabularyWord, parseFindingsRecord } from "../src/findingsrecord.js";
import type { PrFileEntry } from "../src/github.js";
import { configHome, EXAMPLE_PROFILES, type InstallEnv } from "../src/install.js";
import { applyProfileTuning } from "../src/lenstuning.js";
import { assembleReview, type Finding } from "../src/posting.js";
import {
  applyProfilePosting,
  DEFAULT_POSTING_POLICY,
  parsePostingTable,
  postingPolicyAddenda,
  renderPostingPolicyNote,
  resolvePostingPolicy,
  selectPosted,
  type PolicyView,
  type PostingPolicy,
} from "../src/postingpolicy.js";
import {
  loadProfileAddenda,
  loadProfileLensTuning,
  loadProfilePosting,
  reservedAddendumIds,
} from "../src/profiles.js";
import { enforceBenchPosting, policeBenchOutput } from "../src/bench/benchposting.js";
import { collectComments, runFingerprint } from "../src/bench/runner.js";
import type { PrStateRow } from "../src/state.js";
import { renderRoundPrompt } from "../src/templates.js";

const sandbox = join(import.meta.dirname, "..");
const fixture: Config = parseConfig(
  readFileSync(resolve(sandbox, "tests/fixtures/config.toml"), "utf8"),
);

let dir: string;
let env: InstallEnv;
const lookup = () => ({ env });

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "qcr-posting-"));
  env = { HOME: join(dir, "home"), XDG_CONFIG_HOME: join(dir, "xdg-config") };
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

function profile(name: string, toml: string): void {
  const p = join(configHome(env), "profiles", name);
  mkdirSync(join(p, "addenda"), { recursive: true });
  writeFileSync(join(p, "profile.toml"), toml);
}

const SNAPPY: PostingPolicy = {
  max_comments: 4,
  nits: "off",
  questions: "blocking",
  repeat_sites: false,
  body: "verdict",
  comment_style: "concise",
};

describe("[posting] — parse and validation", () => {
  it("accepts every key and value", () => {
    expect(
      parsePostingTable("w", {
        max_comments: 4,
        nits: "off",
        questions: "blocking",
        repeat_sites: false,
        body: "verdict",
        comment_style: "concise",
      }),
    ).toEqual(SNAPPY);
    expect(parsePostingTable("w", {})).toEqual({});
  });

  it.each([
    [{ max_comments: -1 }, /max_comments must be a whole number/],
    [{ max_comments: 2.5 }, /max_comments must be a whole number/],
    [{ max_comments: 51 }, /max_comments must be a whole number/],
    [{ max_comments: "4" }, /max_comments must be a whole number/],
    [{ nits: "some" }, /nits must be one of "post", "off"/],
    [{ questions: "yes" }, /questions must be one of "post", "blocking", "off"/],
    [{ repeat_sites: "no" }, /repeat_sites must be true or false/],
    [{ body: "short" }, /body must be one of "full", "verdict"/],
    [{ comment_style: "terse" }, /comment_style must be one of "full", "concise"/],
    [{ max_comment: 4 }, /unknown key "max_comment"/],
  ])("refuses %j with a clear error", (raw, re) => {
    expect(() => parsePostingTable("profile.toml", raw)).toThrow(re);
  });

  it("refuses a non-table", () => {
    expect(() => parsePostingTable("p", 4)).toThrow(/\[posting\] must be a table/);
  });

  it("an all-default policy is not attached; a real one is", () => {
    expect(applyProfilePosting({ ...fixture }, {}).posting).toBeUndefined();
    expect(applyProfilePosting({ ...fixture }, { nits: "post" }).posting).toBeUndefined();
    expect(applyProfilePosting({ ...fixture }, { nits: "off" }).posting).toEqual({
      ...DEFAULT_POSTING_POLICY,
      nits: "off",
    });
  });

  it("the posting addendum id is reserved against profile packs", () => {
    expect(reservedAddendumIds().has("posting-policy-validate")).toBe(true);
  });

  it("the withhold words are in the findings-record vocabulary", () => {
    for (const w of ["over-budget", "nits-off", "questions-off", "question-not-blocking", "repeat-site"])
      expect(isKnownVocabularyWord(w)).toBe(true);
  });
});

describe("[posting] — inheritance through extends", () => {
  it("child wins per key; the base's other keys are inherited", () => {
    profile("base", '[posting]\nmax_comments = 6\nnits = "off"\nbody = "verdict"\n');
    profile("child", 'extends = "base"\n[posting]\nmax_comments = 3\n');
    expect(loadProfilePosting(sandbox, "child", lookup())).toEqual({
      max_comments: 3,
      nits: "off",
      body: "verdict",
    });
  });

  it("a malformed base fails the child loudly, naming the file", () => {
    profile("base", '[posting]\nnits = "maybe"\n');
    profile("child", 'extends = "base"\n[posting]\nnits = "off"\n');
    expect(() => loadProfilePosting(sandbox, "child", lookup())).toThrow(/profile "base".*nits/);
  });

  it("no profile, an unknown profile and a chain without [posting] are today's posting", () => {
    expect(loadProfilePosting(sandbox, "", lookup())).toEqual({});
    expect(loadProfilePosting(sandbox, "nope", lookup())).toEqual({});
    expect(loadProfilePosting(sandbox, "default", lookup())).toEqual({});
  });
});

describe("the shipped snappy profile", () => {
  it("is a generic example the locator finds, and loads", () => {
    expect(EXAMPLE_PROFILES).toContain("snappy");
    expect(resolvePostingPolicy(loadProfilePosting(sandbox, "snappy", lookup()))).toEqual(SNAPPY);
    const lenses = loadProfileLensTuning(sandbox, "snappy", lookup());
    for (const l of [
      "pass-maintainability",
      "pass-duplication",
      "pass-abstraction",
      "pass-consistency",
      "pass-style",
      "pass-ui",
      "pass-placement",
      "pass-intent",
    ])
      expect(lenses[l]?.enabled, l).toBe(false);
    const pack = loadProfileAddenda(sandbox, "snappy", lookup());
    expect(pack.map((a) => a.id)).toEqual(["snappy-race-as-question"]);
    expect(pack[0]?.scope).toEqual(["pass-validate"]);
  });

  it("its round order carries the POSTING POLICY note, and its validator the selection addendum", () => {
    const cfg = applyProfilePosting(
      applyProfileTuning(
        { ...structuredClone(fixture), review: { ...fixture.review, profile: "snappy" } },
        loadProfileLensTuning(sandbox, "snappy", lookup()),
      ),
      loadProfilePosting(sandbox, "snappy", lookup()),
    );
    const order = buildRoundOrder({
      cfg,
      row: { number: 7, title: "t", head_sha: "abc" } as unknown as PrStateRow,
      files: [
        { filename: "src/a.ts", status: "modified", additions: 300, deletions: 0, changes: 300, patch: "@@ -1 +1 @@\n+x\n" },
      ] as unknown as PrFileEntry[],
      roundId: 1,
      roundNo: 1,
      roundType: "first",
      worktree: "/wt",
      settledDigest: "",
      issuedAt: "2026-10-02T00:00:00Z",
      ecosystem: NONE_ECOSYSTEM,
    });
    expect(order.posting_policy).toEqual(SNAPPY);
    const lenses = order.pass_plan.map((p) => p.lens);
    for (const off of ["pass-maintainability", "pass-duplication", "pass-abstraction", "pass-consistency"])
      expect(lenses).not.toContain(off);
    const text = renderRoundPrompt(
      readFileSync(join(sandbox, "prompts", "round-first.md"), "utf8"),
      order,
      undefined,
      undefined,
      NONE_ECOSYSTEM,
    );
    expect(text).toContain("POSTING POLICY");
    expect(text).toContain("at most 4 posted findings");
    expect(text.indexOf("POSTING POLICY")).toBeLessThan(text.indexOf("## 6. Post"));
    const add = postingPolicyAddenda(cfg.posting);
    expect(add).toHaveLength(1);
    expect(add[0]?.scope).toEqual(["pass-validate"]);
    expect(add[0]?.text).toMatch(/SELECTED[\s\S]*WITHHELD/);
    expect(add[0]?.text).toContain("never withhold a `[blocker]`");
    expect(add[0]?.text).toContain("at most three sentences");
  });

  it("a policy only renders the lines it sets", () => {
    const note = renderPostingPolicyNote({ ...DEFAULT_POSTING_POLICY, nits: "off" });
    expect(note).toContain("Nits: off");
    expect(note).not.toContain("Budget");
    expect(note).not.toContain("Body: verdict only");
    expect(renderPostingPolicyNote(undefined)).toBe("");
    expect(renderPostingPolicyNote({ ...DEFAULT_POSTING_POLICY })).toBe("");
    expect(postingPolicyAddenda({ ...DEFAULT_POSTING_POLICY })).toEqual([]);
  });

  it("the bench fingerprint records the policy (and nothing without one)", () => {
    expect(runFingerprint(fixture, "").posting).toBeUndefined();
    expect(runFingerprint({ ...fixture, posting: SNAPPY }, "snappy").posting).toEqual(SNAPPY);
  });
});

describe("selectPosted — the deterministic cut", () => {
  const v = (cls: PolicyView["cls"], severity: string | null, key: string) => ({ cls, severity, key });
  const items = [
    v("nit", "nit", "n1"),
    v("question", "P3", "q-minor"),
    v("question", "P2", "q-race"),
    v("blocker", "P1", "b1"),
    v("blocker", "P1", "b1"), // the same finding at a second site
    v("check", null, "c1"),
    v("question", null, "q-unknown"),
    v("blocker", "P0", "b2"),
  ];

  it("no policy is the identity", () => {
    expect(selectPosted(items, (x) => x, undefined).kept).toEqual(items);
    expect(selectPosted(items, (x) => x, { ...DEFAULT_POSTING_POLICY }).withheld).toEqual([]);
  });

  it("snappy: tag rules, one site, then the budget — blockers first and never withheld", () => {
    const s = selectPosted(items, (x) => x, SNAPPY);
    // kept in the session's order
    expect(s.kept.map((x) => x.key)).toEqual(["q-race", "b1", "q-unknown", "b2"]);
    expect(s.withheld.map((w) => [w.item.key, w.word])).toEqual([
      ["n1", "nits-off"],
      ["q-minor", "question-not-blocking"],
      ["b1", "repeat-site"],
      ["c1", "over-budget"],
    ]);
  });

  it("more blockers than the budget: every blocker still posts", () => {
    const many = [1, 2, 3, 4, 5, 6].map((i) => v("blocker", "P1", `b${i}`));
    const s = selectPosted([...many, v("question", "P2", "q")], (x) => x, SNAPPY);
    expect(s.kept).toHaveLength(6);
    expect(s.withheld.map((w) => w.word)).toEqual(["over-budget"]);
  });
});

const PATCH = "@@ -1,3 +1,30 @@\n" + Array.from({ length: 30 }, (_, i) => `+line ${i + 1}`).join("\n") + "\n";

function finding(title: string, severity: Finding["severity"], line: number, extra: Partial<Finding> = {}): Finding {
  return { severity, confidence: 0.9, path: "src/a.ts", line, side: "RIGHT", title, body: `${title} body.`, lens: "pass-baseline", ...extra };
}

describe("production posting (src/posting.ts) enforces the policy", () => {
  const findings: Finding[] = [
    finding("Null deref on empty list", "P1", 3),
    finding("Rename x to count", "nit", 4),
    finding("Is the retry idempotent?", "P2", 5, { reachability: "plausible" }),
    finding("Consider a helper", "P3", 6),
    finding("Off by one in loop", "P2", 7),
    finding("Off by one in loop", "P2", 9),
    finding("Missing timeout on fetch", "P2", 10, { reachability: "plausible" }),
    finding("Unchecked error from write", "P2", 11, { reachability: "plausible" }),
    finding("Leaks file handle", "P2", 12, { reachability: "plausible" }),
  ];
  const base = {
    pr: 1,
    head_sha: "abc",
    verdict: "REQUEST_CHANGES" as const,
    findings,
    lenses: ["pass-baseline"],
    patches: { "src/a.ts": PATCH },
    summary: "This PR adds a loader. It has a crash on empty input.",
  };

  it("without a policy the payload is unchanged and nothing is withheld", () => {
    const r = assembleReview(base);
    expect(r.payload.comments).toHaveLength(findings.length);
    expect(r.withheld).toEqual([]);
  });

  it("caps an over-posting round, keeps the blockers, records the rest", () => {
    const r = assembleReview({ ...base, policy: SNAPPY });
    expect(r.payload.comments.length).toBeLessThanOrEqual(4);
    const posted = r.payload.comments.map((c) => c.body.split("\n")[0]);
    for (const t of ["Null deref on empty list", "Off by one in loop", "Is the retry idempotent?", "Missing timeout on fetch"])
      expect(posted.some((p) => p?.includes(t)), t).toBe(true);
    const words = r.withheld.map((w) => [w.finding.title, w.word]);
    expect(words).toContainEqual(["Rename x to count", "nits-off"]);
    expect(words).toContainEqual(["Consider a helper", "question-not-blocking"]);
    expect(words).toContainEqual(["Off by one in loop", "repeat-site"]);
    expect(words).toContainEqual(["Unchecked error from write", "over-budget"]);
    expect(words).toContainEqual(["Leaks file handle", "over-budget"]);
    expect(r.withheld.length + r.payload.comments.length).toBe(findings.length);
  });

  it("body = verdict: the verdict line over what posts, one sentence, the footer", () => {
    const r = assembleReview({ ...base, policy: SNAPPY });
    const lines = r.payload.body.split("\n").filter((l) => l.trim() !== "");
    expect(lines[0]).toMatch(/^\*\*Verdict: Changes requested\*\* — 2 blockers, 2 questions\.$/);
    expect(lines[1]).toBe("This PR adds a loader.");
    expect(lines[2]).toMatch(/^_Automated review by/);
    expect(lines).toHaveLength(3);
  });
});

function caseDir(files: { comments: unknown; review: string; record: unknown; outcome?: unknown }): string {
  const d = join(dir, "case");
  mkdirSync(d, { recursive: true });
  writeFileSync(join(d, "comments.json"), JSON.stringify(files.comments));
  writeFileSync(join(d, "review.md"), files.review);
  writeFileSync(join(d, "findings-record.json"), JSON.stringify(files.record));
  writeFileSync(
    join(d, "outcome.json"),
    JSON.stringify(files.outcome ?? { verdict: "REQUEST_CHANGES", summary: "A summary." }),
  );
  return d;
}

const tail = (sev: string) => `\n\n_${sev} · confidence 0.90 · lens pass-baseline_`;
const SESSION = {
  comments: [
    { path: "src/a.ts", line: 3, side: "RIGHT", body: `[blocker] Null deref\n\nCrashes.${tail("P1")}` },
    { path: "src/a.ts", line: 4, side: "RIGHT", body: `[nit] Rename x\n\nRename.${tail("nit")}` },
    { path: "src/a.ts", line: 5, side: "RIGHT", body: `[question] Retry idempotent?\n\nMaybe.${tail("P2")}` },
    { path: "src/a.ts", line: 6, side: "RIGHT", body: `[question] Name it better?\n\nHm.${tail("P3")}` },
    { path: "src/a.ts", line: 20, side: "RIGHT", body: `[blocker] Off by one\n\nLoop.${tail("P2")}` },
    { path: "src/b.ts", line: 9, side: "RIGHT", body: `[blocker] Off by one\n\nLoop again.${tail("P2")}` },
    { path: "src/a.ts", line: 30, side: "RIGHT", body: `[question] Timeout?\n\nNo timeout.${tail("P2")}` },
    { path: "src/a.ts", line: 40, side: "RIGHT", body: `[question] Error unchecked?\n\nWrite.${tail("P1")}` },
  ],
  review: [
    "This PR adds a loader that reads files. It crashes on empty input.",
    "",
    "**Verdict: Changes requested** — 3 blockers, 1 nit, 4 questions.",
    "",
    "_Lenses applied: pass-baseline._",
    "",
    "### Blockers",
    "",
    "- `src/a.ts:3` — Null deref _(P1/0.90, pass-baseline)_",
    "- `src/a.ts:20` — Off by one _(P2/0.90, pass-baseline)_",
    "- `src/b.ts:9` — Off by one _(P2/0.90, pass-baseline)_",
    "",
    "### Nits",
    "",
    "- `src/a.ts:4` — Rename x _(nit/0.90, pass-baseline)_",
    "",
    "### Additional findings (not posted inline)",
    "",
    "- `src/c.ts:7` — Body-only race _(P2/0.80, pass-concurrency)_",
    "",
    "  Two writers to one key.",
    "",
    "_Automated review by `bot` (quickreview sandbox)._",
  ].join("\n"),
  record: {
    pr: 1,
    round_no: 1,
    comments_posted: 8,
    findings: [
      { id: "f1", path: "src/a.ts", line: 3, lens: "pass-baseline", severity: "P1", disposition: "posted", posted_as: "blocker" },
      { id: "f2", path: "src/a.ts", line: 4, lens: "pass-style", severity: "nit", disposition: "posted", posted_as: "nit", request: "rename" },
      { id: "f3", path: "src/c.ts", line: 7, lens: "pass-concurrency", severity: "P2", disposition: "posted", posted_as: "question", title: "Body-only race" },
      { id: "f4", path: "src/a.ts", line: 40, lens: "pass-baseline", severity: "P1", disposition: "posted", posted_as: "question" },
    ],
  },
};

describe("benchmark export (src/bench/benchposting.ts) enforces the policy", () => {
  it("cuts comments.json to the budget, blockers kept, body findings counted", () => {
    const out = policeBenchOutput({
      comments: SESSION.comments,
      reviewMd: SESSION.review,
      record: SESSION.record,
      outcome: { verdict: "REQUEST_CHANGES", summary: "s" },
      policy: SNAPPY,
    });
    const kept = (out.comments as Array<{ path: string; line: number }>).map((c) => `${c.path}:${c.line}`);
    // blockers a:3 and a:20 (b:9 is a repeat site of a:20), then the strongest questions
    expect(kept).toContain("src/a.ts:3");
    expect(kept).toContain("src/a.ts:20");
    expect(kept).not.toContain("src/b.ts:9");
    expect(kept).not.toContain("src/a.ts:4");
    expect(kept).not.toContain("src/a.ts:6");
    expect(out.report.kept).toBe(4);
    const words = Object.fromEntries(out.report.withheld.map((w) => [`${w.path}:${w.line}`, w.word]));
    expect(words["src/a.ts:4"]).toBe("nits-off");
    expect(words["src/a.ts:6"]).toBe("question-not-blocking");
    expect(words["src/b.ts:9"]).toBe("repeat-site");
    expect(Object.values(words).filter((w) => w === "over-budget").length).toBeGreaterThan(0);
    // Every session item is either kept or withheld — nothing vanishes.
    expect(out.report.kept + out.report.withheld.length).toBe(SESSION.comments.length + 1);
  });

  it("marks the record: withheld with a word, synthesised when unrecorded, still parseable", () => {
    const out = policeBenchOutput({
      comments: SESSION.comments,
      reviewMd: SESSION.review,
      record: SESSION.record,
      outcome: { verdict: "REQUEST_CHANGES", summary: "s" },
      policy: SNAPPY,
    });
    const parsed = parseFindingsRecord(out.record, 1, 1);
    expect(parsed.status).toBe("ok");
    const f2 = parsed.record!.findings.find((f) => f.key === "f2");
    expect(f2?.disposition).toBe("withheld");
    expect(f2?.word).toBe("nits-off");
    expect(f2?.posted_as).toBeNull();
    const withheld = parsed.record!.findings.filter((f) => f.disposition === "withheld");
    expect(withheld.length).toBe(out.report.withheld.length);
    expect(parsed.note ?? "").not.toMatch(/outside the closed vocabulary/);
  });

  it("body = verdict: the verdict line recounted, one sentence, kept body findings as one line", () => {
    const out = policeBenchOutput({
      comments: SESSION.comments,
      reviewMd: SESSION.review,
      record: SESSION.record,
      outcome: { verdict: "REQUEST_CHANGES", summary: "s" },
      policy: SNAPPY,
    });
    const lines = out.reviewMd.split("\n").filter((l) => l.trim());
    expect(lines[0]).toMatch(/^\*\*Verdict: Changes requested\*\* — 2 blockers, \d questions?\.$/);
    expect(lines[1]).toBe("This PR adds a loader that reads files.");
    expect(out.reviewMd).not.toContain("Lenses applied");
    expect(out.reviewMd).not.toContain("Rename x");
  });

  it("body = full: withheld findings' bullets are removed, the rest of the body kept", () => {
    const out = policeBenchOutput({
      comments: SESSION.comments,
      reviewMd: SESSION.review,
      record: SESSION.record,
      outcome: { verdict: "REQUEST_CHANGES", summary: "s" },
      policy: { ...SNAPPY, body: "full" },
    });
    expect(out.reviewMd).toContain("Lenses applied");
    expect(out.reviewMd).toContain("`src/a.ts:3`");
    expect(out.reviewMd).not.toContain("`src/a.ts:4`");
    expect(out.reviewMd).not.toContain("`src/b.ts:9`");
    expect(out.reviewMd).not.toContain("### Nits");
  });

  it("in place on a case dir: originals kept beside, the scorer reads the policed files", () => {
    const d = caseDir(SESSION);
    const report = enforceBenchPosting(d, SNAPPY);
    expect(report?.kept).toBe(4);
    for (const f of ["comments.session.json", "review.session.md", "findings-record.session.json", "posting-policy.json"])
      expect(existsSync(join(d, f)), f).toBe(true);
    expect(JSON.parse(readFileSync(join(d, "comments.session.json"), "utf8"))).toEqual(SESSION.comments);
    const scored = collectComments(d).comments;
    expect(scored.length).toBe(4);
  });
});
