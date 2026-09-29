import { describe, expect, it } from "vitest";
import {
  ASK_HUMAN_LENS,
  ASK_HUMAN_RE,
  ASK_HUMAN_TAG,
  CHECK_THIS_RE,
  CHECK_THIS_TAG,
  DEFERRED_RE,
  DEFERRED_TAG,
  isDeferredFinding,
  isSanctionedTag,
  POSTING_TAG_WORDS,
  SANCTIONED_TAGS,
  stripUngrammaticalTag,
  deriveVerdict,
  isAskHumanFinding,
  DEFAULT_DIRECTIVE_VOCABULARY,
  directiveVocabulary,
  isFirstPartyDirectiveInjection,
  isFirstPartyDirectivePath,
  normalizeReachability,
  postTag,
  reachabilityCappedSeverity,
  type Reachability,
  type Severity,
} from "../src/severity.js";

describe("postTag", () => {
  it("always blocks on P0/P1 regardless of confidence", () => {
    for (const sev of ["P0", "P1"] as Severity[]) {
      expect(postTag(sev, 0)).toBe("blocker");
      expect(postTag(sev, 1)).toBe("blocker");
    }
  });

  it("blocks on P2 only at confidence >= 0.8", () => {
    expect(postTag("P2", 0.8)).toBe("blocker");
    expect(postTag("P2", 0.95)).toBe("blocker");
    expect(postTag("P2", 0.79)).toBe("question");
    expect(postTag("P2", 0)).toBe("question");
  });

  it("never blocks on P3 or nit", () => {
    expect(postTag("P3", 1)).toBe("question");
    expect(postTag("nit", 1)).toBe("nit");
  });
});

describe("reachability gate", () => {
  it("contrived never blocks, at any severity or confidence", () => {
    for (const sev of ["P0", "P1", "P2", "P3"] as Severity[]) {
      expect(postTag(sev, 1, "contrived")).toBe("question");
      expect(postTag(sev, 0, "contrived")).toBe("question");
    }
    // A nit stays a nit — demoting it to a question would be a promotion.
    expect(postTag("nit", 1, "contrived")).toBe("nit");
  });

  it("plausible blocks on P0/P1 and turns P2 into a question", () => {
    expect(postTag("P0", 0.4, "plausible")).toBe("blocker");
    expect(postTag("P1", 1, "plausible")).toBe("blocker");
    expect(postTag("P2", 0.99, "plausible")).toBe("question");
    expect(postTag("P3", 1, "plausible")).toBe("question");
    expect(postTag("nit", 1, "plausible")).toBe("nit");
  });

  it("routine — and an absent or unknown value — leaves the old mapping untouched", () => {
    for (const sev of ["P0", "P1", "P2", "P3", "nit"] as Severity[]) {
      for (const conf of [0, 0.79, 0.8, 1]) {
        const base = postTag(sev, conf);
        expect(postTag(sev, conf, "routine")).toBe(base);
        expect(postTag(sev, conf, undefined)).toBe(base);
        expect(postTag(sev, conf, null)).toBe(base);
        // A pass that writes garbage must not be able to soften a blocker.
        expect(postTag(sev, conf, "whenever" as Reachability)).toBe(base);
      }
    }
    expect(normalizeReachability("plausible")).toBe("plausible");
    expect(normalizeReachability("")).toBe("routine");
    expect(normalizeReachability(undefined)).toBe("routine");
  });

  it("REGRESSION: the blocker bar did not move — known-good blockers still block", () => {
    // The three cases the retrospective names as must-still-block. All
    // three are `routine`: the triggering state arises in normal operation.
    const knownGood = [
      { name: "cross-tenant IDOR", severity: "P0" as Severity, confidence: 0.9 },
      {
        name: "database alias break under rolling deploy",
        severity: "P0" as Severity,
        confidence: 0.85,
      },
      { name: "PII exposure", severity: "P1" as Severity, confidence: 0.8 },
    ];
    for (const c of knownGood) {
      expect(postTag(c.severity, c.confidence, "routine"), c.name).toBe("blocker");
      expect(deriveVerdict({ hasBlockers: true, needsHuman: false }), c.name).toBe(
        "REQUEST_CHANGES",
      );
    }
    // And a high-confidence routine P2 still blocks exactly as before.
    expect(postTag("P2", 0.9, "routine")).toBe("blocker");
  });
});

describe("first-party directive gate", () => {
  it("recognizes the reviewed repo's own agent-directive paths", () => {
    for (const p of [
      ".claude/skills/user-journey-analysis/SKILL.md", // the #5306 false positive
      ".claude/settings.json",
      "prompts/round-first.md",
      "CLAUDE.md",
      "AGENTS.md",
      "backend/AGENTS.md",
      "src/deep/CLAUDE.md",
      ".cursorrules",
      ".cursor/rules/style.mdc",
      ".github/copilot-instructions.md",
    ]) {
      expect(isFirstPartyDirectivePath(p), p).toBe(true);
    }
  });

  it("does NOT match ordinary code, nested prompts dirs, or vendored trees", () => {
    for (const p of [
      "src/app.py",
      "docs/prompts.md",
      "backend/prompts/system.md", // prompts/** binds at the repo root only
      "README.md",
      "node_modules/pkg/CLAUDE.md",
      "vendor/tool/.claude/skills/x.md",
      "third_party/agents/AGENTS.md",
      "",
    ]) {
      expect(isFirstPartyDirectivePath(p), p || "(empty)").toBe(false);
    }
    expect(isFirstPartyDirectivePath(undefined)).toBe(false);
    expect(isFirstPartyDirectivePath(null)).toBe(false);
  });

  it("gates only injection-kind findings", () => {
    expect(isFirstPartyDirectiveInjection("injection", ".claude/skills/x/SKILL.md")).toBe(true);
    expect(isFirstPartyDirectiveInjection("Injection", "CLAUDE.md")).toBe(true);
    expect(isFirstPartyDirectiveInjection("security", ".claude/skills/x/SKILL.md")).toBe(false);
    expect(isFirstPartyDirectiveInjection(undefined, ".claude/skills/x/SKILL.md")).toBe(false);
    expect(isFirstPartyDirectiveInjection("injection", "src/app.py")).toBe(false);
    expect(isFirstPartyDirectiveInjection("injection", "node_modules/pkg/CLAUDE.md")).toBe(false);
  });

  it("the vocabulary is configurable EXTEND-ONLY — extras add, built-ins never leave", () => {
    // Every extra kind reaches the predicate…
    const vocab = directiveVocabulary({
      extra_basenames: ["COPILOT.md"],
      extra_dir_segments: [".aider"],
      extra_root_dirs: ["agent-docs"],
      extra_files: ["docs/agent-contract.md"],
      extra_vendored_segments: ["Extern"],
    });
    expect(isFirstPartyDirectivePath("backend/COPILOT.md", vocab)).toBe(true);
    expect(isFirstPartyDirectivePath("src/.aider/notes.md", vocab)).toBe(true);
    expect(isFirstPartyDirectivePath("agent-docs/setup.md", vocab)).toBe(true);
    expect(isFirstPartyDirectivePath("nested/agent-docs/setup.md", vocab)).toBe(false); // root-only, like prompts/
    expect(isFirstPartyDirectivePath("docs/agent-contract.md", vocab)).toBe(true);
    expect(isFirstPartyDirectivePath("extern/tool/CLAUDE.md", vocab)).toBe(false); // extra vendored marker, case-insensitive
    // …and the built-ins are still all there with extras configured.
    expect(isFirstPartyDirectivePath("CLAUDE.md", vocab)).toBe(true);
    expect(isFirstPartyDirectivePath("prompts/round-first.md", vocab)).toBe(true);
    expect(isFirstPartyDirectivePath("node_modules/pkg/CLAUDE.md", vocab)).toBe(false);
    // No extras = byte-for-byte the default vocabulary (the escalation-mention
    // pick and the posting gate behave unchanged by default).
    expect(directiveVocabulary()).toEqual(directiveVocabulary({}));
    expect(directiveVocabulary({})).toEqual({
      vendoredSegments: DEFAULT_DIRECTIVE_VOCABULARY.vendoredSegments,
      basenames: DEFAULT_DIRECTIVE_VOCABULARY.basenames,
      dirSegments: DEFAULT_DIRECTIVE_VOCABULARY.dirSegments,
      rootDirs: DEFAULT_DIRECTIVE_VOCABULARY.rootDirs,
      files: DEFAULT_DIRECTIVE_VOCABULARY.files,
    });
    // The injection gate honours the same vocabulary.
    expect(isFirstPartyDirectiveInjection("injection", "backend/COPILOT.md", vocab)).toBe(true);
    expect(isFirstPartyDirectiveInjection("injection", "backend/COPILOT.md")).toBe(false);
  });

  it("does not soften a surviving malicious injection merely because its path is first-party", () => {
    // suppresses routine first-party instructions before posting. A
    // candidate that still reaches the posting map has proved maliciousness or
    // a concrete untrusted-source path, so path alone cannot soften it.
    const ctx = { kind: "injection", path: ".claude/skills/x/SKILL.md" };
    expect(postTag("P0", 1, "routine", ctx)).toBe("blocker");
    expect(postTag("P1", 1, "routine", ctx)).toBe("blocker");
    expect(postTag("P2", 0.9, "routine", ctx)).toBe("blocker");
    expect(postTag("P3", 1, "routine", ctx)).toBe("question");
  });

  it("keeps the P1 bright line for third-party/vendored and non-directive paths", () => {
    expect(postTag("P1", 1, "routine", { kind: "injection", path: "src/app.py" })).toBe("blocker");
    expect(
      postTag("P1", 1, "routine", { kind: "injection", path: "node_modules/pkg/CLAUDE.md" }),
    ).toBe("blocker");
    expect(postTag("P1", 1, "routine", { kind: "injection", path: "vendor/x/.claude/y.md" })).toBe(
      "blocker",
    );
  });

  it("leaves every non-injection finding on a directive path untouched", () => {
    const ctx = { kind: "security", path: ".claude/skills/x/SKILL.md" };
    expect(postTag("P1", 1, "routine", ctx)).toBe("blocker");
    expect(postTag("P2", 0.9, "routine", { path: ".claude/skills/x/SKILL.md" })).toBe("blocker");
  });

  it("does not let directive location change the merits verdict", () => {
    expect(
      deriveVerdict({ hasBlockers: false, needsHuman: false, firstPartyDirectiveInjection: true }),
    ).toBe("APPROVE");
    expect(
      deriveVerdict({ hasBlockers: false, needsHuman: true, firstPartyDirectiveInjection: true }),
    ).toBe("NEEDS_HUMAN");
    expect(
      deriveVerdict({ hasBlockers: true, needsHuman: false, firstPartyDirectiveInjection: true }),
    ).toBe("REQUEST_CHANGES");
    // Absent flag: ordinary behaviour exactly.
    expect(deriveVerdict({ hasBlockers: false, needsHuman: false })).toBe("APPROVE");
  });
});

describe("deriveVerdict", () => {
  it("requests changes whenever a blocker exists, even when the session is unsure", () => {
    expect(deriveVerdict({ hasBlockers: true, needsHuman: false })).toBe("REQUEST_CHANGES");
    expect(deriveVerdict({ hasBlockers: true, needsHuman: true })).toBe("REQUEST_CHANGES");
  });

  it("parks only on the session's own judgment — there are no daemon criteria left", () => {
    expect(deriveVerdict({ hasBlockers: false, needsHuman: true })).toBe("NEEDS_HUMAN");
  });

  it("approves a clean, unremarkable PR", () => {
    expect(deriveVerdict({ hasBlockers: false, needsHuman: false })).toBe("APPROVE");
  });
});

// ----: the "[ask your human]" grammar ------------------------------
//
// A sibling marker to [check this], never a second spelling of it. The whole
// design problem this lens solves is ROUTING (stop the reader answering the
// question themselves), so the two tags must stay mutually unrecognizable.

describe("the [ask your human] tag", () => {
  it("is its own tag, distinct from [check this] in both spellings", () => {
    expect(ASK_HUMAN_TAG).toBe("[ask your human]");
    expect(ASK_HUMAN_TAG).not.toBe(CHECK_THIS_TAG);
    expect(CHECK_THIS_RE.test(ASK_HUMAN_TAG)).toBe(false);
    expect(ASK_HUMAN_RE.test(CHECK_THIS_TAG)).toBe(false);
  });

  it("matches the tag at the head of a body, through the usual markdown dress", () => {
    for (const body of [
      "[ask your human] why does this file exist?",
      "  [Ask Your Human] casing and leading space",
      "**[ask your human]** bolded tag",
      "> [ask your human] quoted",
      "[ask your human] [blocker] if you meant X, writes are dropped",
    ]) {
      expect(ASK_HUMAN_RE.test(body), body).toBe(true);
      // …and never trips the human-only refusal that belongs to [check this].
      expect(CHECK_THIS_RE.test(body), body).toBe(false);
    }
  });

  it("is not the tag when it merely appears in the prose", () => {
    expect(ASK_HUMAN_RE.test("[question] you may want to [ask your human] about this")).toBe(false);
  });

  it("recognizes an ask-human finding by lens or by explicit kind", () => {
    expect(isAskHumanFinding(null, ASK_HUMAN_LENS)).toBe(true);
    expect(isAskHumanFinding("ask-human", "pass-baseline")).toBe(true);
    // The merge step concatenates lens tags — a folded finding still counts.
    expect(isAskHumanFinding(null, "pass-baseline+pass-ask-human")).toBe(true);
    expect(isAskHumanFinding(null, "pass-intent")).toBe(false);
    expect(isAskHumanFinding(undefined, undefined)).toBe(false);
  });

  it("changes nothing about the posting map — the tag is routing, not severity", () => {
    // The named-defect condition is enforced at the validator (an addendum),
    // never by weakening or strengthening the mapping here.
    expect(postTag("P1", 0.9, "routine", { kind: "ask-human", path: "app/x.py" })).toBe("blocker");
    expect(postTag("P3", 0.9, "routine", { kind: "ask-human", path: "app/x.py" })).toBe("question");
  });
});

// ----: the closed tag grammar ---------------------------------------
//
// 14.4% of the corpus's findings wore a tag this system does not define. The
// grammar is what the posting guards, the thread-resolution refusals and every
// downstream consumer key on, so an invented tag is a finding that silently
// escapes its own machinery. It constrains the SPELLING and nothing else.

describe("the closed tag grammar", () => {
  it("is exactly the three posting tags plus the three marker prefixes", () => {
    expect(SANCTIONED_TAGS).toEqual([
      "[blocker]",
      "[question]",
      "[nit]",
      CHECK_THIS_TAG,
      ASK_HUMAN_TAG,
      DEFERRED_TAG,
    ]);
    expect(POSTING_TAG_WORDS).toEqual(["blocker", "question", "nit"]);
  });

  it("recognizes a sanctioned tag through brackets, casing and stray whitespace", () => {
    for (const t of ["[blocker]", "blocker", "[Nit]", " [ Check This ] ", "ask your human"]) {
      expect(isSanctionedTag(t), t).toBe(true);
    }
  });

  it("rejects every tag the corpus invented", () => {
    for (const t of [
      "[start here 3/5]",
      "[verified]",
      "[blocker — now fixed]",
      "[fyi]",
      "[praise]",
      "blocker, now fixed",
    ]) {
      expect(isSanctionedTag(t), t).toBe(false);
    }
    expect(isSanctionedTag("")).toBe(false);
    expect(isSanctionedTag(null)).toBe(false);
  });

  it("strips an invented tag from a title and reports it", () => {
    expect(stripUngrammaticalTag("[start here 3/5] missing await")).toEqual({
      title: "missing await",
      stripped: "[start here 3/5]",
    });
  });

  it("strips a duplicated posting tag silently — the real one is minted downstream", () => {
    expect(stripUngrammaticalTag("[nit] rename this")).toEqual({
      title: "rename this",
      stripped: null,
    });
  });

  it("leaves a sanctioned MARKER prefix in place — it carries meaning", () => {
    for (const tag of [CHECK_THIS_TAG, ASK_HUMAN_TAG]) {
      const title = `${tag} does the deploy assume X?`;
      expect(stripUngrammaticalTag(title)).toEqual({ title, stripped: null });
    }
  });

  it("touches nothing that is not a leading tag — no reasoning is ever cut", () => {
    for (const title of [
      "the retry wrapper duplicates http_client.py:44",
      "see [the note] for why", // bracket, but not leading
      "a title with a very long bracketed aside that is plainly not a tag [because it runs past forty characters]",
    ]) {
      expect(stripUngrammaticalTag(title), title).toEqual({ title, stripped: null });
    }
  });

  it("does not let a stripped title change the finding's tag", () => {
    // The grammar governs spelling only: the posting map is untouched, so the
    // blocker bar cannot move through this path.
    expect(postTag("P1", 0.9, "routine")).toBe("blocker");
    expect(postTag("nit", 0.1, "routine")).toBe("nit");
  });
});

// ----: the "[deferred]" tag -----------------------------------------
//
// The THIRD marker. Its whole job is routing a decision ("this finding is real
// and this PR is not where it gets fixed"), so the three markers must stay
// mutually unrecognizable — a marker that means three things routes nothing.

describe("the [deferred] tag", () => {
  const MARKERS = [CHECK_THIS_TAG, ASK_HUMAN_TAG, DEFERRED_TAG];
  const RES = [CHECK_THIS_RE, ASK_HUMAN_RE, DEFERRED_RE];

  it("is its own spelling, sharing no word with either other marker", () => {
    expect(DEFERRED_TAG).toBe("[deferred]");
    expect(new Set(MARKERS).size).toBe(3);
    // The spelling avoids every word the other two use — no "this", no
    // "human", no imperative — so none of the three can be misread as another.
    const words = (t: string) => new Set(t.replace(/[[\]]/g, "").split(" "));
    for (const [i, a] of MARKERS.entries()) {
      for (const [j, b] of MARKERS.entries()) {
        if (i === j) continue;
        expect(
          [...words(a)].some((w) => words(b).has(w)),
          `${a} vs ${b}`,
        ).toBe(false);
        // …and neither is a substring of the other, in either direction.
        expect(a.includes(b), `${a} contains ${b}`).toBe(false);
      }
    }
  });

  it("no marker's regex ever matches another marker — in any combination", () => {
    for (const [i, re] of RES.entries()) {
      for (const [j, tag] of MARKERS.entries()) {
        expect(re.test(tag), `${re.source} vs ${tag}`).toBe(i === j);
      }
    }
  });

  it("matches at the head of a body through the usual markdown dress", () => {
    for (const body of [
      "[deferred] the retry wrapper duplicates http_client.py:44",
      "  [Deferred] casing and leading space",
      "**[deferred]** bolded tag",
      "> [deferred] quoted",
      "[deferred] [question] too big for this PR — ticket drafted below",
    ]) {
      expect(DEFERRED_RE.test(body), body).toBe(true);
      // …and never trips either other marker's machinery.
      expect(CHECK_THIS_RE.test(body), body).toBe(false);
      expect(ASK_HUMAN_RE.test(body), body).toBe(false);
    }
  });

  it("is not the tag when it merely appears in the prose", () => {
    expect(DEFERRED_RE.test("[nit] this was [deferred] last round")).toBe(false);
  });

  it("recognizes a deferral by its explicit kind only — no lens mints deferrals", () => {
    expect(isDeferredFinding("deferred")).toBe(true);
    expect(isDeferredFinding("Deferral")).toBe(true);
    expect(isDeferredFinding("ask-human")).toBe(false);
    expect(isDeferredFinding(null)).toBe(false);
    expect(isDeferredFinding(undefined)).toBe(false);
  });

  it("is a sanctioned tag, so it never reads as an invented one", () => {
    expect(isSanctionedTag(DEFERRED_TAG)).toBe(true);
    expect(stripUngrammaticalTag(`${DEFERRED_TAG} too big for this PR`)).toEqual({
      title: `${DEFERRED_TAG} too big for this PR`,
      stripped: null,
    });
  });

  it("changes no severity — a deferral never blocks and never softens a blocker", () => {
    expect(postTag("P1", 0.9, "routine", { kind: "deferred", path: "app/x.py" })).toBe("blocker");
    expect(postTag("nit", 0.1, "routine", { kind: "deferred", path: "app/x.py" })).toBe("nit");
  });
});

describe("reachabilityCappedSeverity — the posting map's reachability gate, as a severity (scan-loop)", () => {
  const sevs: Severity[] = ["P0", "P1", "P2", "P3", "nit"];
  const reaches: Reachability[] = ["routine", "plausible", "contrived"];

  it("caps exactly where postTag's reachability gate softens a tag — at any confidence", () => {
    for (const sev of sevs) {
      for (const reach of reaches) {
        for (const conf of [0, 0.5, 0.8, 1]) {
          const capped = reachabilityCappedSeverity(sev, reach);
          // The capped severity, read as routine, posts as the reachability-gated original does.
          expect(postTag(capped, conf, "routine"), `${sev}/${reach}/${conf}`).toBe(postTag(sev, conf, reach));
        }
      }
    }
  });

  it("contrived P0–P2 → P3, plausible P2 → P3, everything else unchanged", () => {
    expect(reachabilityCappedSeverity("P0", "contrived")).toBe("P3");
    expect(reachabilityCappedSeverity("P2", "plausible")).toBe("P3");
    expect(reachabilityCappedSeverity("P1", "plausible")).toBe("P1");
    expect(reachabilityCappedSeverity("nit", "contrived")).toBe("nit");
    expect(reachabilityCappedSeverity("P1", null)).toBe("P1");
  });
});
