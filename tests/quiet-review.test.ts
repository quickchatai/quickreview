// tests/quiet-review.test.ts — `[review] quiet`, the default: a PR review
// raises and posts no `nit` and nothing below `P2`. Each seam it changes is
// driven here through the real code: the config knob
// (packages/pi-plugin/src/reviewconfig.ts), the composed addenda
// (include.ts `configAddenda`), the plan (planner.ts — pass-intent), the round
// order's QUIET note (templates.ts `renderNitPolicyNote`) and the posting
// backstop (postingpolicy.ts `quietWithholdWord`, through
// reviewrender.ts `postedRenderOptions` → `renderPostedReview`, the step both
// render routes run). `quiet = false` is the review as it was before quiet
// became the default; the byte-level proof of that is the quiet=false pins of
// tests/posting-default-identity.test.ts.
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { parseConfig, type Config } from "../src/config.js";
import { buildPassPlan, buildRoundOrder } from "../src/dispatch.js";
import type { PrFileEntry } from "../src/github.js";
import type { PrStateRow } from "../src/state.js";
import { assembleReview, type Finding } from "../src/posting.js";
import { policeBenchOutput } from "../src/bench/benchposting.js";
import { benchQuiet, runFingerprint } from "../src/bench/runner.js";
import { renderConfig } from "../src/reviewrendercli.js";
import { REVIEW_DEFAULTS } from "@quickchatai/pi-quickreview/src/reviewconfig.js";
import {
  PASS_ADDENDA,
  VALIDATE_PASS,
  addendaForPass,
  composeAddendum,
  configAddenda,
} from "@quickchatai/pi-quickreview/src/include.js";
import { INTENT_PASS, STYLE_PASS } from "@quickchatai/pi-quickreview/src/heuristics.js";
import { NONE_ECOSYSTEM } from "@quickchatai/pi-quickreview/src/ecosystem.js";
import {
  renderNitPolicyNote,
  renderRoundPrompt,
  ROUND_TEMPLATE_FILES,
} from "@quickchatai/pi-quickreview/src/templates.js";
import type { RoundOrder, RoundType } from "@quickchatai/pi-quickreview/src/types.js";
import {
  DEFAULT_POSTING_POLICY,
  quietWithholdWord,
  selectPosted,
  type PolicyView,
} from "@quickchatai/pi-quickreview/src/postingpolicy.js";
import {
  postedRenderOptions,
  renderPostedReview,
} from "@quickchatai/pi-quickreview/src/reviewrender.js";

const root = resolve(import.meta.dirname, "..");
const FIXTURE_TOML = readFileSync(resolve(root, "tests/fixtures/config.toml"), "utf8");
// The fixture pins `quiet = false` (it reviews as before quiet); without that
// line it is a config that leaves quiet to the shipped default.
const DEFAULT_TOML = FIXTURE_TOML.replace(/^quiet = false\n/m, "");
const withQuiet = (v: string): string =>
  DEFAULT_TOML.replace(/^\[review\]$/m, `[review]\nquiet = ${v}`);

const quietCfg: Config = parseConfig(DEFAULT_TOML);
const loudCfg: Config = parseConfig(withQuiet("false"));

describe("[review] quiet — the knob", () => {
  it("is on by default: in the code, in a config that leaves it out, and in config.example.toml", () => {
    // MUTATION: set REVIEW_DEFAULTS.quiet to false (reviewconfig.ts) — this fails
    expect(REVIEW_DEFAULTS.quiet).toBe(true);
    expect(DEFAULT_TOML).not.toMatch(/^quiet\s*=/m);
    expect(quietCfg.review.quiet).toBe(true);
    const example = readFileSync(resolve(root, "config.example.toml"), "utf8");
    expect(parseConfig(example).review.quiet).toBe(true);
    // The example documents the opt-out, commented, so it ships the default.
    expect(example).toMatch(/^# quiet = false$/m);
  });

  it("quiet = false is read; a non-boolean is refused naming the key and the values", () => {
    expect(loudCfg.review.quiet).toBe(false);
    expect(parseConfig(withQuiet("true")).review.quiet).toBe(true);
    // MUTATION: delete the `typeof cfg.review.quiet !== "boolean"` check in
    // validateReviewSection — these fail
    expect(() => parseConfig(withQuiet('"yes"'))).toThrow(
      /\[review\]: quiet must be true or false \(got "yes"\)/,
    );
    expect(() => parseConfig(withQuiet("1"))).toThrow(/quiet must be true or false/);
  });
});

describe("[review] quiet — the composed addenda", () => {
  const ids = (review: Parameters<typeof configAddenda>[0], mode: "pr" | "scan" = "pr") =>
    configAddenda(review)
      .filter((a) => a.mode === undefined || a.mode === mode)
      .map((a) => a.id);

  it("a quiet PR build carries the three quiet entries and neither nit-minting entry", () => {
    // MUTATION: drop the `if (quiet)` push in configAddenda — this fails
    expect(ids(quietCfg.review)).toEqual([
      "quiet-lenses",
      "quiet-style",
      "quiet-validate",
      "dedup-group-validate",
      "validate-compact-output",
    ]);
    // MUTATION: spread `{}` instead of `unlessQuiet` into validate-demote-not-kill — this fails
    expect(ids(quietCfg.review)).not.toContain("validate-demote-not-kill");
    expect(ids({ ...quietCfg.review, nits: "open" })).not.toContain("nits-open");
    expect(ids({ ...quietCfg.review, nits: "open" })).not.toContain("nits-open-validate");
  });

  it("with quiet = false the list is the one from before quiet existed, nits policy included", () => {
    expect(ids(loudCfg.review)).toEqual([
      "validate-demote-not-kill",
      "dedup-group-validate",
      "validate-compact-output",
    ]);
    expect(ids({ ...loudCfg.review, nits: "open" })).toEqual([
      "validate-demote-not-kill",
      "nits-open",
      "nits-open-validate",
      "dedup-group-validate",
      "validate-compact-output",
    ]);
    // No entry carries a mode it did not carry before: the quiet=false list is
    // the old one object for object.
    // MUTATION: make unlessQuiet `{ mode: "pr" }` when quiet is false — this fails
    expect(configAddenda(loudCfg.review)[0]).toEqual({
      id: "validate-demote-not-kill",
      scope: [VALIDATE_PASS],
      text: expect.any(String),
    });
  });

  it("a scan build is never quieted: its composed bytes are the same under either value", () => {
    for (const pass of [VALIDATE_PASS, "pass-scan", "pass-baseline", STYLE_PASS]) {
      const quiet = composeAddendum(
        pass,
        [...PASS_ADDENDA, ...configAddenda({ ...quietCfg.review, nits: "open" })],
        "django",
        "scan",
      );
      const loud = composeAddendum(
        pass,
        [...PASS_ADDENDA, ...configAddenda({ ...loudCfg.review, nits: "open" })],
        "django",
        "scan",
      );
      // MUTATION: drop `mode: "pr"` from the quiet-lenses entry — this fails
      expect(quiet, pass).toBe(loud);
      expect(quiet, pass).not.toContain("Quiet review");
    }
    expect(ids(quietCfg.review, "scan")).toContain("validate-demote-not-kill");
  });

  it("each quiet entry binds the passes it names, and says what it supersedes", () => {
    const registry = [...PASS_ADDENDA, ...configAddenda(quietCfg.review)];
    const of = (pass: string) => addendaForPass(pass, registry).map((a) => a.id);
    expect(of("pass-placement")).toContain("quiet-lenses");
    expect(of("pass-placement")).not.toContain("quiet-validate");
    expect(of(STYLE_PASS)).toEqual(expect.arrayContaining(["quiet-lenses", "quiet-style"]));
    expect(of(VALIDATE_PASS)).toContain("quiet-validate");
    expect(of(VALIDATE_PASS)).not.toContain("quiet-lenses");
    // The quiet entries compose after every registry rule they supersede.
    const v = of(VALIDATE_PASS);
    expect(v.indexOf("quiet-validate")).toBeGreaterThan(v.indexOf("validate-convention-rule"));
    expect(v.indexOf("quiet-validate")).toBeGreaterThan(v.indexOf("validate-restate-not-kill"));
    const lens = registry.find((a) => a.id === "quiet-lenses")!.text;
    // The ratified out-of-lane amendment: honest severity, never a P3 question.
    expect(lens).toContain("A defect outside your lane");
    expect(lens).toContain("ONE `P3` question");
    expect(lens).toContain("if that is below `P2` it is not raised");
    expect(lens).toContain("Never lower a severity to stay quiet, and never raise one");
    const validate = registry.find((a) => a.id === "quiet-validate")!.text;
    expect(validate).toContain("kill it with the existing word `below-bar`");
    // The security demotion and fold are exempted by name.
    expect(validate).toContain("`security-demoted`");
    expect(validate).toContain("`validate-security-fold`");
    expect(validate).toContain("DOUBTED");
  });
});

const FILES: PrFileEntry[] = [
  {
    filename: "src/orders.ts",
    status: "modified",
    additions: 40,
    deletions: 2,
    changes: 42,
    patch: "@@ -1 +1,2 @@\n+export const a = 1;\n",
  },
] as unknown as PrFileEntry[];
// Well over the intent lens's substance bar (60 words of prose).
const BODY = Array.from(
  { length: 12 },
  (_, i) => `Sentence ${i} explains that orders are routed by region from now on.`,
).join(" ");

describe("[review] quiet — the plan", () => {
  it("pass-intent is not planned under quiet, and planned exactly as before with quiet = false", () => {
    const plan = (cfg: Config) =>
      buildPassPlan(cfg, FILES, { title: "Route orders", body: BODY }, NONE_ECOSYSTEM);
    const loud = plan(loudCfg);
    const quiet = plan(quietCfg);
    expect(loud.pass_plan.map((p) => p.lens)).toContain(INTENT_PASS);
    // MUTATION: remove the `.filter(… l === INTENT_PASS)` after selectLenses
    // in buildPassPlan — this fails
    expect(quiet.pass_plan.map((p) => p.lens)).not.toContain(INTENT_PASS);
    // Every other row is the same.
    expect(quiet.pass_plan).toEqual(loud.pass_plan.filter((p) => p.lens !== INTENT_PASS));
    // It stays addable.
    expect(quiet.addable_lenses).toContain(INTENT_PASS);
  });
});

function order(cfg: Config, rt: RoundType) {
  return buildRoundOrder({
    cfg,
    row: { number: 7, title: "Route orders", head_sha: "abc" } as unknown as PrStateRow,
    files: FILES,
    roundId: 1,
    roundNo: rt === "first" ? 1 : 3,
    reviewNo: rt === "first" ? 1 : 3,
    roundType: rt,
    worktree: "/wt",
    settledDigest: "",
    issuedAt: "2026-11-18T00:00:00Z",
    ecosystem: NONE_ECOSYSTEM,
    prBody: BODY,
  });
}

const RATIFIED_BLOCK = /<!-- RATIFIED[^\n]*-->[\s\S]*?<!-- \/RATIFIED[^\n]*-->/g;

describe("[review] quiet — the round order's QUIET note", () => {
  it("the order carries nit_policy quiet; quiet = false carries the nits policy as before", () => {
    // MUTATION: drop the `quiet === true` branch where buildRoundOrder sets nit_policy — this fails
    expect(order(quietCfg, "first").nit_policy).toBe("quiet");
    // quiet wins over an open nits policy
    expect(
      order({ ...quietCfg, review: { ...quietCfg.review, nits: "open" } }, "first").nit_policy,
    ).toBe("quiet");
    expect(order(loudCfg, "first").nit_policy).toBeUndefined();
    expect(
      order({ ...loudCfg, review: { ...loudCfg.review, nits: "open" } }, "first").nit_policy,
    ).toBe("open");
  });

  it("renders in every round template, outside every RATIFIED fence, and is absent with quiet = false", () => {
    expect(renderNitPolicyNote("quiet")).toContain("QUIET REVIEW");
    expect(renderNitPolicyNote(undefined)).toBe("");
    for (const [rt, file] of Object.entries(ROUND_TEMPLATE_FILES)) {
      const tpl = readFileSync(resolve(root, "prompts", file), "utf8");
      const { nit_policy, ...withoutNote } = order(quietCfg, rt as RoundType);
      expect(nit_policy).toBe("quiet");
      const render = (o: RoundOrder) =>
        renderRoundPrompt(tpl, o, undefined, undefined, NONE_ECOSYSTEM);
      const quiet = render({ ...withoutNote, nit_policy });
      const loud = render(withoutNote);
      expect(quiet, rt).toContain("**QUIET REVIEW (`[review] quiet = true`).**");
      expect(loud, rt).not.toContain("QUIET REVIEW");
      // The note's placeholder sits between fences, never inside one. The
      // rendered prompt has its RATIFIED markers stripped, so this reads the
      // template source, where the markers are.
      // MUTATION: move `{{nit_policy_note}}` inside the posting-map fence of a
      // round template — this fails
      const blocks = tpl.match(RATIFIED_BLOCK) ?? [];
      expect(blocks.length, rt).toBeGreaterThan(0);
      expect(tpl, rt).toContain("{{nit_policy_note}}");
      for (const block of blocks) expect(block, rt).not.toContain("{{nit_policy_note}}");
    }
  });
});

// One posted entry per class the backstop distinguishes.
const entry = (
  id: string,
  postedAs: string,
  severity: string,
  extra: Record<string, unknown> = {},
): Record<string, unknown> => ({
  id,
  path: "src/orders.ts",
  line: 1,
  side: "RIGHT",
  lens: "pass-baseline",
  severity,
  confidence: 0.6,
  disposition: "posted",
  posted_as: postedAs,
  title: `Finding ${id}`,
  body: `Body of ${id}.`,
  ...extra,
});
const RECORD = {
  pr: 7,
  round_no: 1,
  verdict: "REQUEST_CHANGES",
  summary: "One blocker.",
  findings: [
    entry("blocker", "blocker", "P1", { confidence: 0.9 }),
    entry("nit", "nit", "nit", { request: "rename it" }),
    entry("p3q", "question", "P3"),
    entry("p2q", "question", "P2", { reachability: "plausible" }),
    entry("check", "check this", "P3"),
    // A security question at P3 — the seed's security demotion posts it.
    entry("secq", "question", "P3", { lens: "pass-sec-access" }),
    // The security fold's own route: an unproven security candidate the
    // validator downgraded, folded into a question at render time.
    {
      ...entry("fold", "", "P3", { lens: "pass-sec-injection" }),
      disposition: "downgraded",
      word: "security-demoted",
      posted_as: null,
    },
  ],
};

describe("[review] quiet — the posting backstop, through the render step", () => {
  const render = (quiet: boolean) =>
    renderPostedReview(
      structuredClone(RECORD),
      postedRenderOptions({
        review: { dedup_merge: false, quiet },
        security: { fold: true },
      }),
    );

  it("withholds a [nit] and a P3 question; keeps a blocker, a P2 question, [check this] and security questions", () => {
    const out = render(true);
    // MUTATION: in quietWithholdWord, withhold `v.cls === "check"` as well
    // (let the backstop withhold class check) — this fails
    expect(Object.fromEntries(out.withheld.map((w) => [w.id, w.word]))).toEqual({
      nit: "nits-off",
      p3q: "question-not-blocking",
    });
    expect(out.folded).toEqual(["fold"]);
    const posted = out.rendered.comments.map((c) => c.body.split("\n")[0] ?? "");
    for (const id of ["blocker", "p2q", "check", "secq", "fold"])
      expect(
        posted.some((l) => l.includes(`Finding ${id}`)),
        id,
      ).toBe(true);
    for (const id of ["nit", "p3q"])
      expect(
        posted.some((l) => l.includes(`Finding ${id}`)),
        id,
      ).toBe(false);
    // Withheld is recorded, never deleted.
    const findings = (out.record as { findings: Array<Record<string, unknown>> }).findings;
    expect(findings.find((f) => f.id === "nit")?.disposition).toBe("withheld");
    expect(findings).toHaveLength(RECORD.findings.length);
  });

  it("quiet = false withholds nothing, and quiet never touches the posting policy", () => {
    expect(render(false).withheld).toEqual([]);
    // MUTATION: put `nits: "off"` into the policy postedRenderOptions returns — this fails
    expect(postedRenderOptions({ review: { quiet: true } })).toEqual({
      dedupMerge: false,
      quiet: true,
    });
  });

  it("the live route's render config carries quiet, from the config or the shipped default", () => {
    const load = (cfg: Config) => ({ config: () => cfg, profilePosting: () => ({}) });
    // MUTATION: in renderConfig, build `review` from dedup_merge alone — this fails
    const live = renderConfig("/sandbox", undefined, load(quietCfg)).cfg;
    expect(live.review.quiet).toBe(true);
    expect(
      renderPostedReview(structuredClone(RECORD), postedRenderOptions(live)).withheld.map(
        (w) => w.id,
      ),
    ).toEqual(["nit", "p3q"]);
    expect(renderConfig("/sandbox", undefined, load(loudCfg)).cfg.review.quiet).toBe(false);
    const unread = renderConfig("/sandbox", undefined, {
      config: () => {
        throw new Error("config.toml: unreadable");
      },
      profilePosting: () => ({}),
    });
    expect(unread.unread).toBeDefined();
    expect(unread.cfg.review.quiet).toBe(REVIEW_DEFAULTS.quiet);
  });

  it("the word for each class, as every route reads it", () => {
    const v = (over: Partial<PolicyView>): PolicyView => ({
      cls: "question",
      severity: "P3",
      key: "k",
      ...over,
    });
    expect(quietWithholdWord(v({ cls: "nit", severity: "nit" }))).toBe("nits-off");
    expect(quietWithholdWord(v({}))).toBe("question-not-blocking");
    expect(quietWithholdWord(v({ severity: "P2" }))).toBeNull();
    // An unknown severity cannot be shown below the bar.
    expect(quietWithholdWord(v({ severity: null }))).toBeNull();
    // MUTATION: rank with sevRank (an unreadable severity ranks 5) — this fails.
    expect(quietWithholdWord(v({ severity: "high" }))).toBeNull();
    expect(quietWithholdWord(v({ severity: "P1 (capped)" }))).toBeNull();
    expect(quietWithholdWord(v({ security: true }))).toBeNull();
    expect(quietWithholdWord(v({ cls: "check" }))).toBeNull();
    expect(quietWithholdWord(v({ cls: "blocker", severity: "P3" }))).toBeNull();
    // Under any policy or none, the default included.
    const items = [v({ cls: "nit", severity: "nit" }), v({ cls: "blocker", severity: "P1" })];
    for (const p of [undefined, DEFAULT_POSTING_POLICY])
      expect(selectPosted(items, (x) => x, p, { quiet: true }).kept).toEqual([items[1]]);
    expect(selectPosted(items, (x) => x, undefined).kept).toEqual(items);
  });

  it("the legacy assembly (src/posting.ts) applies the same backstop", () => {
    const f = (title: string, severity: Finding["severity"], confidence: number): Finding =>
      ({
        path: "src/orders.ts",
        line: 1,
        side: "RIGHT",
        severity,
        confidence,
        lens: "pass-baseline",
        title,
        body: `${title}.`,
      }) as Finding;
    const findings = [
      f("Blocker", "P1", 0.9),
      f("Nit", "nit", 0.9),
      f("Minor", "P3", 0.6),
      f("Likely", "P2", 0.6),
    ];
    const base = {
      pr: 7,
      head_sha: "abc",
      verdict: "REQUEST_CHANGES" as const,
      findings,
      lenses: ["pass-baseline"],
    };
    const quiet = assembleReview({ ...base, quiet: true });
    expect(quiet.withheld.map((w) => [w.finding.title, w.word])).toEqual([
      ["Nit", "nits-off"],
      ["Minor", "question-not-blocking"],
    ]);
    expect(assembleReview(base).withheld).toEqual([]);
  });

  it("the benchmark's hand-written-case policing applies it too", () => {
    const tail = (sev: string) => `\n\n_${sev} · confidence 0.60 · lens pass-baseline_`;
    const row = (line: number, tag: string, sev: string) => ({
      path: "src/orders.ts",
      line,
      side: "RIGHT",
      body: `[${tag}] Finding at ${line}\n\nx.${tail(sev)}`,
    });
    const police = (quiet: boolean) =>
      policeBenchOutput({
        comments: [
          row(10, "blocker", "P1"),
          row(20, "nit", "nit"),
          row(30, "question", "P3"),
          row(40, "question", "P2"),
        ],
        reviewMd: "",
        record: { findings: [] },
        outcome: { verdict: "REQUEST_CHANGES", summary: "One blocker." },
        policy: { ...DEFAULT_POSTING_POLICY },
        quiet,
      });
    expect(police(true).report.withheld.map((w) => [w.line, w.word])).toEqual([
      [20, "nits-off"],
      [30, "question-not-blocking"],
    ]);
    expect(police(false).report.withheld).toEqual([]);
  });
});

describe("[review] quiet — the benchmark reproduces the published review", () => {
  it("reviews with quiet off unless an arm's --config names review.quiet", () => {
    // MUTATION: return `cfg` unchanged from benchQuiet — this fails
    expect(benchQuiet(quietCfg, "").review.quiet).toBe(false);
    expect(benchQuiet(quietCfg, "review.preset=low").review.quiet).toBe(false);
    expect(benchQuiet(quietCfg, "review.preset=low, review.quiet=true").review.quiet).toBe(true);
  });

  it("the run fingerprint records quiet only when on, so a reproducing run keeps its fingerprint", () => {
    const fp = (cfg: Config) => runFingerprint(cfg, "").levers as Record<string, unknown>;
    expect(fp(loudCfg)).not.toHaveProperty("quiet");
    expect(fp(quietCfg)).toHaveProperty("quiet", true);
  });
});
