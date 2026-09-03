// The companion's skills are selected from their `description:` line ALONE
// (§4). pi puts all of them in the prompt permanently and picks one; no
// name is typed, no router is consulted. So the descriptions are the routing
// table, and a wrong-skill misfire is the likeliest first failure of the whole
// set — the thing this file exists to catch.
//
// WHAT THIS TEST IS. Not an LLM harness: it cannot know what pi will pick. It
// pins the property that makes a correct pick POSSIBLE — that each description
// carries vocabulary the prompts it should serve actually use, and does NOT
// carry the vocabulary of the prompts its neighbours serve. A purely lexical
// scorer stands in for the model deliberately: it is dumber than pi, so a
// description that survives it has margin, and it is deterministic, so a
// regression is a red test rather than a bad afternoon in the column.
//
// THE DELIBERATE MISFIRE CASE (the one this file was written around):
//
//   "he approved it — go ahead and commit the rubric change we just agreed"
//
// `adjudicate`'s description ends "...and land any change it justifies", which
// is honest — adjudication does end in a landing — but it means the words
// "land" and "change" both live in the judging skill. A sloppy `land`
// description (say, "land a change the companion decided on") would lose this
// prompt to `adjudicate`, and the companion would re-litigate a verdict the owner
// has already approved instead of committing it. `land` therefore has to own
// the MECHANICS vocabulary — commit, surface, ticket, trailers, agreed — rather
// than the judging vocabulary. The negative half of that case is pinned too:
// the same prompt must not reach `adjudicate`.
//
// If you change a description, expect to change a case here. That is the point:
// the descriptions are load-bearing, and they should be hard to move quietly.
import { describe, expect, it } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

const SKILLS_DIR = join(process.cwd(), "skills/companion");

/** The five skills that must exist, and the promise each one makes. */
const EXPECTED_SKILLS = ["adjudicate", "evidence", "land", "replay", "survey"] as const;
type SkillName = (typeof EXPECTED_SKILLS)[number];

interface Skill {
  name: string;
  description: string;
  body: string;
}

function parseSkill(dir: string): Skill {
  const raw = readFileSync(join(SKILLS_DIR, dir, "SKILL.md"), "utf8");
  const m = /^---\n([\s\S]*?)\n---\n([\s\S]*)$/.exec(raw);
  if (!m) throw new Error(`${dir}/SKILL.md has no frontmatter block`);
  const front = m[1]!;
  const name = /^name:[ \t]*(.+)$/m.exec(front)?.[1]?.trim();
  const description = /^description:[ \t]*(.+)$/m.exec(front)?.[1]?.trim();
  if (!name || !description)
    throw new Error(`${dir}/SKILL.md frontmatter needs both name: and description:`);
  return { name, description, body: m[2]! };
}

const skills = new Map<string, Skill>(
  readdirSync(SKILLS_DIR, { withFileTypes: true })
    .filter((e) => e.isDirectory())
    .map((e) => [e.name, parseSkill(e.name)]),
);

// ---- the stand-in scorer -----------------------------------------------------

/** True function words only. Anything that could carry routing signal stays. */
const STOPWORDS = new Set([
  "the",
  "a",
  "an",
  "and",
  "or",
  "of",
  "to",
  "on",
  "in",
  "it",
  "is",
  "are",
  "was",
  "were",
  "be",
  "been",
  "for",
  "with",
  "that",
  "this",
  "these",
  "those",
  "what",
  "when",
  "why",
  "how",
  "do",
  "does",
  "did",
  "done",
  "you",
  "your",
  "we",
  "our",
  "us",
  "me",
  "my",
  "i",
  "at",
  "by",
  "from",
  "as",
  "its",
  "has",
  "have",
  "had",
  "not",
  "no",
  "never",
  "ever",
  "any",
  "all",
  "one",
  "out",
  "up",
  "so",
  "if",
  "then",
  "than",
  "about",
  "into",
  "just",
  "only",
  "very",
  "also",
  "can",
  "could",
  "would",
  "should",
  "must",
  "may",
  "might",
  "still",
  "more",
  "most",
  "some",
  "such",
  "like",
  "they",
  "them",
  "their",
  "there",
  "here",
  "before",
  "after",
  "once",
  "get",
  "got",
  "go",
  "going",
  "gone",
  "right",
  "now",
  "again",
  "today",
  "please",
  "ok",
  "okay",
  "really",
  "much",
  "many",
  "been",
  "am",
  "but",
  "yet",
  "own",
  "per",
  "via",
  "both",
  "each",
  "other",
  "another",
  "same",
  "thing",
  "things",
  "anything",
  "something",
  "give",
  "take",
  "want",
  "need",
  "let",
  "lets",
  "make",
  "made",
  "see",
  "look",
  "looks",
  "looking",
  "tell",
  "say",
  "says",
  "said",
  "think",
  "know",
  "he",
  "she",
  "his",
  "her",
  "him",
  "hers",
  "them",
  "who",
  "which",
  "whose",
  "while",
  "because",
  "since",
  "yes",
  "yeah",
  "hey",
  "well",
  "actually",
  "maybe",
  "kind",
  "sort",
  "bit",
  "up",
  "off",
  "over",
  "under",
  "down",
  "back",
  "out",
  "again",
]);

/** Crude, deliberate: less clever than any real matcher, so margin is real. */
export function normalize(word: string): string {
  let w = word.toLowerCase().replace(/[^a-z0-9]/g, "");
  if (w.length > 5 && w.endsWith("ing")) w = w.slice(0, -3);
  else if (w.length > 5 && w.endsWith("ed")) w = w.slice(0, -2);
  if (w.length > 3 && w.endsWith("s") && !w.endsWith("ss")) w = w.slice(0, -1);
  return w;
}

export function tokens(text: string): string[] {
  return text
    .split(/[^A-Za-z0-9]+/)
    .map(normalize)
    .filter((w) => w.length >= 3 && !STOPWORDS.has(w));
}

export interface Score {
  /** Distinct prompt tokens the description carries. */
  matches: number;
  /** Share of the prompt's content words the description carries. */
  share: number;
}

export function score(prompt: string, description: string): Score {
  const want = [...new Set(tokens(prompt))];
  const have = new Set(tokens(description));
  const matches = want.filter((w) => have.has(w)).length;
  return { matches, share: want.length === 0 ? 0 : matches / want.length };
}

/** A description "fires" when it carries a quarter of the prompt's content
 * words AND either two of them or half of them. One shared word out of five is
 * a coincidence — "review" and "PR" appear in nearly every description and must
 * never be enough — but "what happened on 5249?" has only two content words to
 * give, and a router that needs three would answer nothing the owner ever types. */
const FIRE_MATCHES = 2;
const FIRE_SHARE = 0.25;
const FIRE_SHARE_ALONE = 0.5;

export function fires(s: Score): boolean {
  return s.share >= FIRE_SHARE && (s.matches >= FIRE_MATCHES || s.share >= FIRE_SHARE_ALONE);
}

function scoreAll(prompt: string): Array<{ name: string; s: Score }> {
  return [...skills.values()]
    .map((sk) => ({ name: sk.name, s: score(prompt, sk.description) }))
    .sort((a, b) => b.s.share - a.s.share || b.s.matches - a.s.matches);
}

// ---- the cases ---------------------------------------------------------------

/** Prompts that must reach exactly one skill, and must NOT reach the others. */
const ROUTES: Array<{ prompt: string; expect: SkillName; note?: string }> = [
  // evidence — understanding, with no intention of judging.
  { prompt: "what happened on 5249?", expect: "evidence" },
  {
    prompt:
      "walk me through the rounds on 5306 — which lens raised the blocker and what did the verdict say",
    expect: "evidence",
  },
  {
    prompt: "pull up the transcript and the ledger for that round, I want the record",
    expect: "evidence",
  },

  // adjudicate — judging a complaint about the review.
  { prompt: "work the feedback on 5312", expect: "adjudicate" },
  {
    prompt:
      "Priya says we are too noisy — was the review wrong on that finding or was the complaint unfair?",
    expect: "adjudicate",
  },

  // land — a decided change becoming a commit, a ticket, or a proposal.
  {
    prompt: "he approved it — go ahead and commit the rubric change we just agreed",
    expect: "land",
    note: "THE MISFIRE CASE: adjudicate's description ends 'land any change it justifies', so a sloppy land description loses this to the judging skill.",
  },
  {
    prompt:
      "which surface does that belong on — is it a commit here or a tracker ticket for the owner?",
    expect: "land",
  },

  // survey — the entry point: is there anything worth working at all?
  {
    prompt: "anything worth looking at?",
    expect: "survey",
    note: "THE ENTRY PROMPT: two content words, and it must not reach adjudicate — surveying is not judging.",
  },
  { prompt: "what is on the backlog — where should I start today?", expect: "survey" },

  // replay — trying a change against the past, offline.
  {
    prompt: "would that change still catch what the humans caught on the old PRs?",
    expect: "replay",
  },
  {
    prompt:
      "run the regression case set against the new severity rule and show me the offline result",
    expect: "replay",
  },
];

/** Ordinary companion conversation. No skill may fire on these. */
const SILENCE: string[] = [
  "how many are waiting on me right now?",
  "is the daemon healthy? the heartbeat looks stale",
  "spend is up again — anything odd in the numbers?",
  "message that session and tell it to hurry up",
  "good morning, what is the shape of the day",
];

describe("companion skill descriptions", () => {
  it("every expected skill exists, with a name matching its directory", () => {
    for (const name of EXPECTED_SKILLS) {
      const sk = skills.get(name);
      expect(sk, `skills/companion/${name}/SKILL.md is missing`).toBeDefined();
      expect(sk!.name).toBe(name);
    }
  });

  it("descriptions are single-line, substantial, and say when to use the skill", () => {
    for (const name of EXPECTED_SKILLS) {
      const d = skills.get(name)!.description;
      expect(d).not.toContain("\n");
      expect(d.length, `${name}: description too short to disambiguate`).toBeGreaterThan(120);
      expect(
        d.length,
        `${name}: description too long — pi reads all of these on every turn`,
      ).toBeLessThan(520);
      expect(d.toLowerCase(), `${name}: say when to use it, not only what it is`).toContain(
        "use when",
      );
    }
  });

  it("no two descriptions are near-duplicates of each other", () => {
    for (const a of EXPECTED_SKILLS) {
      for (const b of EXPECTED_SKILLS) {
        if (a >= b) continue;
        const s = score(skills.get(a)!.description, skills.get(b)!.description);
        expect(
          s.share,
          `${a} and ${b} share ${(s.share * 100).toFixed(0)}% of their vocabulary`,
        ).toBeLessThan(0.4);
      }
    }
  });

  for (const { prompt, expect: want, note } of ROUTES) {
    it(`"${prompt}" reaches ${want}${note ? " — misfire case" : ""}`, () => {
      const ranked = scoreAll(prompt);
      const winner = ranked[0]!;
      expect(
        fires(winner.s),
        `nothing fires on "${prompt}" (best: ${winner.name} ${JSON.stringify(winner.s)})`,
      ).toBe(true);
      expect(winner.name, `${note ?? ""}\nranking: ${JSON.stringify(ranked)}`).toBe(want);
      // And it must WIN, not tie: a tie is a coin flip in pi's hands.
      for (const other of ranked.slice(1)) {
        expect(other.s.share, `${other.name} ties or beats ${want} on "${prompt}"`).toBeLessThan(
          winner.s.share,
        );
      }
    });
  }

  it("the misfire prompt does not reach adjudicate at all", () => {
    const misfire = ROUTES.find((r) => r.expect === "land" && r.note)!;
    const adjudicate = score(misfire.prompt, skills.get("adjudicate")!.description);
    expect(
      fires(adjudicate),
      `adjudicate fires on a prompt that is pure landing: ${JSON.stringify(adjudicate)}`,
    ).toBe(false);
  });

  // survey vs adjudicate is the second misfire axis. Both talk about
  // feedback and about reviews that went wrong, and blurring them costs both
  // ways: a survey that judges hands the owner a verdict nobody earned, and an
  // adjudication that surveys re-lists the backlog instead of settling the item
  // he named. Pinned in both directions.
  it("the survey entry prompt does not reach adjudicate", () => {
    const s = score("anything worth looking at?", skills.get("adjudicate")!.description);
    expect(fires(s), `adjudicate fires on the survey entry prompt: ${JSON.stringify(s)}`).toBe(
      false,
    );
  });

  it("a named-item judging prompt does not reach survey", () => {
    const s = score("work the feedback on 5312", skills.get("survey")!.description);
    expect(
      fires(s),
      `survey fires on a prompt that names one item to judge: ${JSON.stringify(s)}`,
    ).toBe(false);
  });

  it("survey says it does not judge, and names the durable list", () => {
    const body = skills.get("survey")!.body;
    // The two things that cannot be left implicit: it surveys and does not
    // judge (the blur `adjudicate` would inherit), and the list does not expire
    // (the reason it exists rather than reading the event feed).
    expect(body).toMatch(/survey; you do not judge/i);
    expect(body).toMatch(/adjudicate/);
    expect(body).toMatch(/\/evidence\/candidates\.json/);
    expect(body).toMatch(/does not expire/i);
    expect(body).toMatch(/accepted and fixed/i);
  });

  for (const prompt of SILENCE) {
    it(`"${prompt}" reaches no skill`, () => {
      for (const { name, s } of scoreAll(prompt)) {
        expect(fires(s), `${name} fires on ordinary conversation: ${JSON.stringify(s)}`).toBe(
          false,
        );
      }
    });
  }

  it("each skill's body carries the boundary it must never cross", () => {
    for (const name of EXPECTED_SKILLS) {
      const body = skills.get(name)!.body;
      expect(body, `${name}: rule 8's boundary is not restated in the body`).toMatch(/deploy\.sh/);
      expect(body).toMatch(/## Never/);
    }
  });

  it("replay says out loud that the label-and-dispatch route is forbidden", () => {
    const body = skills.get("replay")!.body;
    // The one safety point that cannot be left implicit: labelling a PR and
    // letting the live daemon dispatch is a POSTING path, and `src/regression.ts`
    // says the same thing in code (`assertReplaySafe`, the `replay` seam's
    // contract). If this ever stops matching, read that module first.
    expect(body).toMatch(/never become a posting path/i);
    expect(body).toMatch(/label/i);
    expect(body).toMatch(/assertReplaySafe/);
    expect(body).toMatch(/dry.run/i);
  });

  it("land encodes the ratifying turn, its per-session death, and the propose-only fence", () => {
    const body = skills.get("land")!.body;
    expect(body).toMatch(/ratifying turn/i);
    expect(body).toMatch(/void at session end/i);
    expect(body).toMatch(/one purpose per commit/i);
    expect(body).toMatch(/Ratified-in-session:/);
    expect(body).toMatch(/RATIFIED/);
  });

  it("land carries the rubric-proposal mechanics — the companion is the producer, the TUI accept is the ratification", () => {
    const body = skills.get("land")!.body;
    // Where: the LOCAL repo's state dir (the companion's /workspace), which is
    // where src/tui/proposals.ts lists from — never a VM path.
    expect(body).toMatch(/state\/rubric\/<lens>-<topic>-<YYYY-MM-DD>\//);
    expect(body).toMatch(/\/workspace/);
    // What: exactly the two files the TUI reads.
    expect(body).toMatch(/PROPOSAL\.md/);
    expect(body).toMatch(/changes\.patch/);
    expect(body).toMatch(/`a\/` `b\/` prefixes/);
    // The walls, spelled out: targets and the fence refusal.
    expect(body).toMatch(/`agents\/` and `prompts\/` only/i);
    expect(body).toMatch(/refuses/i);
    // The boundary: the companion never applies; the accept click ratifies.
    expect(body).toMatch(/NEVER apply the patch yourself/i);
    expect(body).toMatch(/accept click in the TUI\s+IS the ratification/i);
  });

  it("evidence names the two read-only mounts and what a missing leg costs", () => {
    const body = skills.get("evidence")!.body;
    expect(body).toMatch(/\/evidence\//);
    expect(body).toMatch(/\/example-app/);
    expect(body).toMatch(/manifest\.json/);
    expect(body).toMatch(/missing/i);
  });

  it("the companion prompt names every skill in the set", () => {
    const prompt = readFileSync(join(process.cwd(), "prompts/companion.md"), "utf8");
    for (const name of EXPECTED_SKILLS) {
      expect(prompt, `prompts/companion.md never mentions \`${name}\``).toContain(`\`${name}\``);
    }
  });
});
