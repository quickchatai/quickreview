// the ratified invariants inside the prompt files we OWN are fenced,
// and the fences are pinned here.
//
// Root CLAUDE.md rule 6 freezes the SEEDS; it says nothing about the round
// templates and the post-seed lens agents, which are "ours to edit". But
// "ours to edit" is a freeze exemption, not a DECISION exemption: those files
// carry ratified rules (the CI gate, the reachability gate, the nit cap, the
// recheck's one-way contract, the pass severity caps). opens every
// prompt file to the companion while keeping the ratified invariants
// propose-only — so each such passage is wrapped in
//
//     <!-- RATIFIED FT-NNNN <slug> — do not edit; owner only -->
//     …the ratified text, byte for byte…
//     <!-- /RATIFIED <slug> -->
//
// and pinned below by the sha256 of its CONTENTS. Two failure modes, both
// loud: the text inside a fence changed, or the fence itself went missing
// (deleting the marker must not be the way around the pin).
//
// Changing any fenced passage is the owner's call, recorded on the tracker. If
// he ratifies a change, update the hash here IN THE SAME COMMIT and say which
// ticket ratified it.
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");

interface PinnedFence {
  /** Stable id inside the file: `<file>#<slug>` is how a failure is named. */
  slug: string;
  /**
   * The citation: the ticket on which the owner ratified this rule (`FT-NNNN`),
   * or — for the invariants that predate the FT numbering and live in root
   * CLAUDE.md's hard rules — the rule number (`RULE-N`).
   */
  ft: string;
  /**
   * A ratified RESEED of the fenced words, when the marker records one (
   * R8): `<!-- RATIFIED memory-discipline (reseeded,
   * 2026-10-07) — … -->`. The citation stays the rule's own ticket (the rule is
   * the same decision); the annotation names the reseed that changed its words,
   * and must match the pin exactly, both ways.
   */
  reseeded?: { ft: string; date: string };
  /** sha256 of the fence CONTENTS (the lines between the two markers). */
  sha256: string;
}

/**
 * The pin. One entry per fenced passage, in file order.
 *
 * Every hash here was taken from the text as ratified; regenerate one only
 * alongside a ratification.
 */
const PINNED: Record<string, PinnedFence[]> = {
  "prompts/round-first.md": [
    {
      slug: "no-exec",
      ft: "",
      sha256: "ff6d7f5f6d0ef188ad08c546d51918439e64bba8c3e2fe41a77136d176664ffd",
    },
    {
      slug: "ci-gate",
      ft: "",
      // Re-pinned 2026-10-03 (owner ratified in-session): prompt cleanup — the dated owner aside / FT id removed from the fenced text; the rule is unchanged
      sha256: "104d79df41ab434adba45578463e225631d1543309b015818274a5093b80a74b",
    },
    {
      slug: "verdicts",
      ft: "",
      // Re-pinned 2026-10-03 (owner ratified in-session): prompt cleanup — the dated owner aside / FT id removed from the fenced text; the rule is unchanged
      sha256: "5c0678e3dadc9de828794542797bfa0e2e03996252871d4874370e891caa7d35",
    },
    {
      slug: "posting-map",
      ft: "",
      sha256: "cc384c1650e45820f80db8f90a2f5a74e383baafad5ff29c5c3f518ac27bf66c",
    },
    {
      slug: "reachability",
      ft: "",
      sha256: "94f36825f50099ee2e3f39b14091e15e694548bb61a6c29e5c7daab30d04683f",
    },
    {
      slug: "injection-bright-line",
      ft: "",
      // Re-pinned 2026-10-03 (owner ratified in-session): prompt cleanup — the dated owner aside / FT id removed from the fenced text; the rule is unchanged
      sha256: "9f96c237378849a92fecb86e830d06f5b922acefd0f397ab7399a1bc96883b67",
    },
    {
      slug: "merge-call",
      ft: "",
      // Re-pinned 2026-10-03 (owner ratified in-session): prompt cleanup — the dated owner aside / FT id removed from the fenced text; the rule is unchanged
      sha256: "84f6d74be948d4415181a0b745d3be4ffdbe81c607a6befe8579d415d64611d0",
    },
  ],
  "prompts/round-re-review.md": [
    {
      slug: "no-exec",
      ft: "",
      sha256: "ff6d7f5f6d0ef188ad08c546d51918439e64bba8c3e2fe41a77136d176664ffd",
    },
    {
      slug: "ci-gate",
      ft: "",
      // Re-pinned 2026-10-03 (owner ratified in-session): prompt cleanup — the dated owner aside / FT id removed from the fenced text; the rule is unchanged
      sha256: "104d79df41ab434adba45578463e225631d1543309b015818274a5093b80a74b",
    },
    {
      slug: "verdicts",
      ft: "",
      // Re-pinned 2026-10-03 (owner ratified in-session): prompt cleanup — the dated owner aside / FT id removed from the fenced text; the rule is unchanged
      sha256: "2ade641b3e3754a4834721e42dd8d43196ff321cdb8a647198b258dac6407e36",
    },
    {
      slug: "posting-map",
      ft: "",
      sha256: "cc384c1650e45820f80db8f90a2f5a74e383baafad5ff29c5c3f518ac27bf66c",
    },
    {
      slug: "never-dismiss",
      ft: "RULE-2",
      sha256: "c619376602fc5e032cbf648a135945dd0105cdd8282d1eec122483f8e5ecd84a",
    },
    {
      slug: "nit-scope",
      ft: "",
      sha256: "6e36bba0ad59c6d927d1e120826e814ba66c0dd25db2b63b14bdfb45356ed16c",
    },
    {
      slug: "reachability",
      ft: "",
      sha256: "94f36825f50099ee2e3f39b14091e15e694548bb61a6c29e5c7daab30d04683f",
    },
    {
      slug: "injection-bright-line",
      ft: "",
      // Re-pinned 2026-10-03 (owner ratified in-session): prompt cleanup — the dated owner aside / FT id removed from the fenced text; the rule is unchanged
      sha256: "9f96c237378849a92fecb86e830d06f5b922acefd0f397ab7399a1bc96883b67",
    },
    {
      slug: "merge-call",
      ft: "",
      // Re-pinned 2026-10-03 (owner ratified in-session): prompt cleanup — the dated owner aside / FT id removed from the fenced text; the rule is unchanged
      sha256: "5916f6d0d863579e83467924d6920be53aff3ebe9a9ce7d3bcb12ac806192303",
    },
  ],
  "prompts/round-staleness.md": [
    {
      slug: "no-exec",
      ft: "",
      sha256: "ff6d7f5f6d0ef188ad08c546d51918439e64bba8c3e2fe41a77136d176664ffd",
    },
    {
      slug: "ci-gate",
      ft: "",
      // Re-pinned 2026-10-03 (owner ratified in-session): prompt cleanup — the dated owner aside / FT id removed from the fenced text; the rule is unchanged
      sha256: "2a22664b85e435f0f3a8b6954d315be455397053dc4aaded72454097595f947d",
    },
    {
      slug: "verdicts",
      ft: "",
      // Re-pinned 2026-10-03 (owner ratified in-session): prompt cleanup — the dated owner aside / FT id removed from the fenced text; the rule is unchanged
      sha256: "9151774037ac9b64b078f20c74c73fd62dbf384682a4717d0dd556426e0a5dae",
    },
    {
      slug: "posting-map",
      ft: "",
      sha256: "cc384c1650e45820f80db8f90a2f5a74e383baafad5ff29c5c3f518ac27bf66c",
    },
    {
      slug: "reachability",
      ft: "",
      sha256: "94f36825f50099ee2e3f39b14091e15e694548bb61a6c29e5c7daab30d04683f",
    },
    {
      slug: "injection-bright-line",
      ft: "",
      // Re-pinned 2026-10-03 (owner ratified in-session): prompt cleanup — the dated owner aside / FT id removed from the fenced text; the rule is unchanged
      sha256: "9f96c237378849a92fecb86e830d06f5b922acefd0f397ab7399a1bc96883b67",
    },
    {
      slug: "merge-call",
      ft: "",
      // Re-pinned 2026-10-03 (owner ratified in-session): prompt cleanup — the dated owner aside / FT id removed from the fenced text; the rule is unchanged
      sha256: "1eff370952c6fbc4ecc43beb893967578a73852e828947546a5f285a3bc9f904",
    },
  ],
  "prompts/round-recheck.md": [
    {
      slug: "uphold-one-way",
      ft: "",
      sha256: "d6a6ce50ccae1b5ef6e37c6cac607a15222d875a485a1b1c8269c53ebd189c51",
    },
    {
      slug: "regression-only",
      ft: "",
      sha256: "5877ea115f6d0861cb121d88e5132ebfc1e2642554974666ae0b6d33c5df151a",
    },
    {
      slug: "nit-scope",
      ft: "",
      sha256: "3796cb45a48ef24a197b247b7e976db3eb66fe4e9f44a5f776f82aa211fc1918",
    },
    {
      slug: "no-exec",
      ft: "",
      sha256: "efba0b28e5a0652b33c805f9cb680590c16b465c2216d378872dfd87b4e4ecda",
    },
  ],
  // The four FROZEN seeds. Fencing them is itself a reseed under root rule 6,
  // ratified by the owner on 2026-08-24 and recorded in
  // tests/fixtures/ratified-divergence.json.
  "prompts/pass-common.md": [
    {
      slug: "passes-post-nothing",
      ft: "RULE-9",
      sha256: "419335dd2ec6ebcc3c8e30eb05112176fb1a28611ae293ed31982f2e69876699",
    },
    {
      slug: "severity-scale",
      ft: "",
      sha256: "b1545b8a69b95f7ffa2f87489120e6ff78549865ed73eaa046baf7aa3649873a",
    },
  ],
  "prompts/conversation-system.md": [
    {
      slug: "credential",
      ft: "RULE-3",
      sha256: "7ae180d03c9e4b4ace8857a490e6e138416232705c2d02c0a2ca93f44d9242b0",
    },
    {
      slug: "decide-step",
      ft: "",
      // Re-pinned 2026-10-03 (owner ratified in-session): prompt cleanup — the dated owner aside / FT id removed from the fenced text; the rule is unchanged
      sha256: "fcfdceba94b75096c5e59491d8abacbe4fa1f481e3f8d683c415a5fea4fd1b34",
    },
    {
      slug: "no-human-handoff",
      ft: "",
      sha256: "7dab3094e9076bf75925db665126faabe1ad668b8c0cf02e6576043e4de2a28d",
    },
    {
      slug: "ping-pong-discipline",
      ft: "",
      sha256: "818d6465aa7a0181efae103f3167d264feadc5ef0eb3c552c9e4fbab2e0779dc",
    },
    {
      slug: "invariants-absolute",
      ft: "RULE-2",
      sha256: "d5976bf31c68d797ed0924c18215fca3d6d6bbcdee9e8f09b4120d0a0ae8d9c8",
    },
  ],
  "prompts/overseer-system.md": [
    {
      slug: "action-space",
      ft: "",
      // Re-pinned 2026-10-03 (owner ratified in-session): prompt cleanup — the action-space command schemas corrected to what the daemon accepts (flag-owner {message}, file-improvement-pr {branch, title, body, slug})
      sha256: "6e8ea028dec90920b7b9d9ccec544c835de35195b3426d0b213533e4ccee7192",
    },
    {
      slug: "action-space-never",
      ft: "RULE-2",
      sha256: "136820d54aed82fcb5d9579c452791ab233f93b9b9034ee6dd86e0e43bf248ec",
    },
    {
      slug: "memory-discipline",
      ft: "",
      sha256: "08a56035ebf0f5254c7710bd5d33ee40984ac6a53940c373f76aeb441f852c51",
    },
  ],
  "prompts/eod-sweep.md": [
    {
      slug: "memory-discipline",
      ft: "",
      // Re-pinned 2026-10-07 (owner ratified in-session, R8): the
      // eod-sweep reseed — the fence names the pinned area
      // (preferences/pinned/), #manual in preferences/, and kind=bug
      // area=operations in an events/ entry's header; an outage still writes
      // the curation receipt. The rule is unchanged; its marker records the
      // reseed.
      reseeded: { ft: "", date: "2026-10-07" },
      sha256: "d53aafba4f9d2326fe316ce6735b81d38a9600b4aa40594f340af0de151cb420",
    },
    {
      slug: "improvement-caps",
      ft: "",
      sha256: "5c0c653b1ef9c1773f18c55c09c415d72b9988df22cc9fcd19d9fb34cef6bf6f",
    },
  ],
  "agents/pass-intent.md": [
    {
      slug: "intent-artifact",
      ft: "",
      // Re-pinned 2026-10-03 (owner ratified in-session): prompt cleanup — the dated owner aside / FT id removed from the fenced text; the rule is unchanged
      sha256: "8d1559e24bf9eb36176b515d5caa58e78f8984fad45f3ee79a56373d128ce8a6",
    },
    {
      slug: "thin-bodies-none",
      ft: "",
      sha256: "3e8b9f47a39edf5f95d95758edbd03c64b254a19e0d10e80dd2d05e79a22fa19",
    },
    {
      slug: "severity-cap",
      ft: "",
      sha256: "67f090951ce2f9d5862b73baa15cfedd1715b718870324dc7f227b9b4e0e0541",
    },
  ],
  "agents/pass-placement.md": [
    {
      slug: "repo-anchor",
      ft: "",
      // Re-pinned 2026-10-03 (owner ratified in-session): prompt cleanup — the dated owner aside / FT id removed from the fenced text; the rule is unchanged
      sha256: "ad35fc4537f743de86f178271bd25d4a3e3b4f0fd1cc5da2bcdae69ad204b3a9",
    },
    {
      slug: "p2-cap",
      ft: "",
      sha256: "d133405681219eba3c40643b125a8cc9fd8f3d56c5338612f32d5c9e9e6a4d44",
    },
  ],
  "agents/pass-simplicity.md": [
    {
      slug: "beyond-the-diff",
      ft: "",
      // Re-pinned 2026-10-03 (owner ratified in-session): prompt cleanup — the dated owner aside / FT id removed from the fenced text; the rule is unchanged
      sha256: "fde21c9fc81ecbb31a885df0c2b59bc50ebab09cabf0a88978f30afad14a99da",
    },
    {
      slug: "never-counter-finding",
      ft: "",
      sha256: "a6105800effd9c2fefa696543427d9f2561e2057b463bc62225bb7e545867fa4",
    },
    {
      slug: "p2-cap",
      ft: "",
      sha256: "53feba72604cae68c009680e6aea7b4e507d4999e192e002814bb78f6ede77bd",
    },
  ],
  "agents/pass-backcompat.md": [
    {
      slug: "lens-boundaries",
      ft: "",
      // Re-pinned 2026-10-03 (owner ratified in-session): prompt cleanup — the dated owner aside / FT id removed from the fenced text; the rule is unchanged
      sha256: "b2c91de07ce4d73ccae6a239c61b73f175843976e13831c9d07be92ba0a22113",
    },
    {
      slug: "full-severity",
      ft: "",
      sha256: "cdb65345b6db3eecf9f89211ac5f2153d7328a622815198670f6ec171728cdea",
    },
  ],
  // the concurrency lens's two ratified burdens. Both are RAISE-side
  // bars, and both exist because a confidently-wrong race story costs more than
  // a missed one: the four-part shape is what makes a finding falsifiable at
  // all, and the self-falsification duty is the only place in the system where
  // a lens must try to kill its own candidate before the validator sees it.
  // Loosening either is the owner's call, not a prose trim.
  "agents/pass-concurrency.md": [
    {
      slug: "four-part-finding",
      ft: "",
      sha256: "1fdbdec097aaa3bb4b826c22cf304b43d1dd2ec21b906507eab2544ea4b89ec8",
    },
    {
      slug: "self-falsification",
      ft: "",
      sha256: "914fab18800b9ba3008da2270ef1ecd32491e3f3d38671342dd6e066e30b33b5",
    },
  ],
  // the ask-your-human lens's named-defect bar (the owner's words on
  // "it can only block if it says what is wrong under the bad answer.
  // Not 'unclear' — an actual described failure."). The blocker bar never
  // moves, and a lens whose whole output is questions is exactly where it would
  // move first: without this passage "I do not understand this" becomes a
  // blocker. `ask-human-named-defect-validate` enforces the same line from the
  // validator's side.
  "agents/pass-ask-human.md": [
    {
      slug: "named-defect-bar",
      ft: "",
      sha256: "1b97b394d8387ba7b000cea7404df7cd29baf5809a6dd955cb117931fc3b0788",
    },
  ],
};

/** The seeds frozen by root rule 6 — fencing one is itself a reseed. */
const FROZEN_SEEDS = [
  "prompts/pass-common.md",
  "prompts/conversation-system.md",
  "prompts/overseer-system.md",
  "prompts/eod-sweep.md",
] as const;

/**
 * The citation half of the marker grammar.
 *
 * `FT-NNNN` is the normal case: the ticket on which the owner ratified the rule.
 * `RULE-N` is for the invariants that have no ticket to cite because they
 * predate the numbering and live as hard rules in root CLAUDE.md — never
 * dismiss a review (rule 2), the credential rule (rule 3), passes post nothing
 * (rule 9). the owner's call, 2026-08-24: cite the rule number, not a made-up
 * ticket.
 */
const CITATION = String.raw`FT-\d{4}|RULE-\d{1,2}`;

/**
 * The role half of the marker grammar: new fences say `owner only`
 * — the role, so the machinery reads for any installation's owner. The
 * personal spelling `the owner only` is GRANDFATHERED: existing fences keep
 * their ratified bytes (rewriting a fence marker just to rename it would
 * itself be a fence edit — rule 6 territory), so both spellings parse.
 *
 * The reseed half (R8): a fence whose WORDS a ratified reseed changed
 * may record it after the slug — ` (reseeded FT-NNNN, YYYY-MM-DD)`, exactly
 * that, a ticket and a date and nothing else. The citation before it stays the
 * rule's own ticket. Optional, and narrow for the same reason as the citation:
 * a free-text parenthetical would let a marker carry any claim at all.
 */
const RESEEDED = String.raw`(?: \(reseeded (FT-\d{4}), (\d{4}-\d{2}-\d{2})\))?`;
const OPEN = new RegExp(
  String.raw`^<!-- RATIFIED (${CITATION}) ([a-z0-9-]+)${RESEEDED} — do not edit; (?:the owner|owner) only -->$`,
);
const CLOSE = /^<!-- \/RATIFIED ([a-z0-9-]+) -->$/;

interface ParsedFence {
  ft: string;
  slug: string;
  /** The marker's reseed annotation, or null when it carries none. */
  reseeded: { ft: string; date: string } | null;
  body: string;
}

/** Parse the fences out of a file. Throws on a malformed / unbalanced marker. */
export function parseFences(text: string, rel: string): ParsedFence[] {
  const lines = text.split("\n");
  const out: ParsedFence[] = [];
  let open: {
    ft: string;
    slug: string;
    reseeded: { ft: string; date: string } | null;
    from: number;
  } | null = null;
  lines.forEach((line, i) => {
    const o = OPEN.exec(line);
    const c = CLOSE.exec(line);
    if (o) {
      if (open)
        throw new Error(
          `${rel}:${i + 1}: fence '${o[2]}' opens inside unclosed fence '${open.slug}'`,
        );
      open = {
        ft: o[1] as string,
        slug: o[2] as string,
        reseeded: o[3] ? { ft: o[3], date: o[4] as string } : null,
        from: i,
      };
      return;
    }
    if (c) {
      if (!open) throw new Error(`${rel}:${i + 1}: closing marker '${c[1]}' with no open fence`);
      if (c[1] !== open.slug) {
        throw new Error(`${rel}:${i + 1}: fence '${open.slug}' closed by '${c[1]}'`);
      }
      out.push({
        ft: open.ft,
        slug: open.slug,
        reseeded: open.reseeded,
        body: lines.slice(open.from + 1, i).join("\n"),
      });
      open = null;
      return;
    }
    if (line.includes("RATIFIED")) {
      throw new Error(`${rel}:${i + 1}: malformed RATIFIED marker — ${line}`);
    }
  });
  if (open) throw new Error(`${rel}: fence '${(open as { slug: string }).slug}' is never closed`);
  return out;
}

const sha256 = (s: string): string => createHash("sha256").update(s, "utf8").digest("hex");

const read = (rel: string): string => readFileSync(join(repoRoot, rel), "utf8");

const files = Object.keys(PINNED);

describe("ratified invariant fences", () => {
  it.each(files)("%s: every pinned fence is still present", (rel) => {
    const found = new Set(parseFences(read(rel), rel).map((f) => f.slug));
    for (const { slug, ft } of PINNED[rel] as PinnedFence[]) {
      expect(
        found.has(slug),
        `${rel.split("/").pop()}#${slug} is MISSING — ratified ${ft}, the owner only. ` +
          `Deleting the fence markers is not a way around the pin: restore ` +
          `<!-- RATIFIED ${ft} ${slug} — do not edit; owner only --> … <!-- /RATIFIED ${slug} -->.`,
      ).toBe(true);
    }
  });

  it.each(files)("%s: no fenced passage has changed", (rel) => {
    const bySlug = new Map(parseFences(read(rel), rel).map((f) => [f.slug, f]));
    for (const pin of PINNED[rel] as PinnedFence[]) {
      const fence = bySlug.get(pin.slug);
      if (!fence) continue; // the presence test above owns this failure
      expect(
        sha256(fence.body),
        `${rel.split("/").pop()}#${pin.slug} changed — ratified ${pin.ft}, the owner only. ` +
          `The text inside a RATIFIED fence is a decision, not prose: propose the ` +
          `change on the tracker and let the owner ratify it. If he did, re-pin the ` +
          `hash in tests/invariant-fences.test.ts in the same commit.`,
      ).toBe(pin.sha256);
    }
  });

  it.each(files)("%s: the fence names the ratifying ticket the pin expects", (rel) => {
    const bySlug = new Map(parseFences(read(rel), rel).map((f) => [f.slug, f]));
    for (const pin of PINNED[rel] as PinnedFence[]) {
      const fence = bySlug.get(pin.slug);
      if (!fence) continue;
      expect(
        fence.ft,
        `${rel.split("/").pop()}#${pin.slug}: fence says ${fence.ft}, the pin says ${pin.ft}`,
      ).toBe(pin.ft);
    }
  });

  it.each(files)("%s: the fence's reseed annotation is exactly the pin's (R8)", (rel) => {
    // Both ways: a marker may not claim a reseed the pin never recorded, and a
    // pinned reseed may not lose its annotation from the marker.
    const bySlug = new Map(parseFences(read(rel), rel).map((f) => [f.slug, f]));
    for (const pin of PINNED[rel] as PinnedFence[]) {
      const fence = bySlug.get(pin.slug);
      if (!fence) continue;
      expect(
        fence.reseeded,
        `${rel.split("/").pop()}#${pin.slug}: the marker's reseed annotation does not match the pin`,
      ).toEqual(pin.reseeded ?? null);
    }
  });

  it.each(files)("%s: carries no UNPINNED fence", (rel) => {
    const pinned = new Set((PINNED[rel] as PinnedFence[]).map((f) => f.slug));
    for (const fence of parseFences(read(rel), rel)) {
      expect(
        pinned.has(fence.slug),
        `${rel.split("/").pop()}#${fence.slug} is fenced but not pinned — an unpinned fence ` +
          `protects nothing. Add it to PINNED in tests/invariant-fences.test.ts.`,
      ).toBe(true);
    }
  });

  it("every fenced frozen seed is a ratified divergence (rule 6)", () => {
    // The four seeds are FROZEN (root CLAUDE.md rule 6): a fence is a byte
    // change, so it is a reseed and needs the owner's explicit ratification.
    // He gave it on 2026-08-24 — and the entry in
    // ratified-divergence.json is what makes these fences legitimate rather
    // than a unilateral seed edit. Losing that entry must fail here too.
    const divergence = JSON.parse(read("tests/fixtures/ratified-divergence.json")) as {
      files: Record<string, string[]>;
    };
    for (const rel of FROZEN_SEEDS) {
      if (!read(rel).includes("RATIFIED")) continue;
      expect(
        Object.keys(divergence.files),
        `${rel} carries a RATIFIED fence but has no entry in ` +
          `tests/fixtures/ratified-divergence.json. Fencing a FROZEN seed is a ` +
          `reseed (root CLAUDE.md rule 6) and needs the owner's ratification recorded there.`,
      ).toContain(rel);
    }
  });

  it("a rule citation is accepted, and only in the sanctioned spelling", () => {
    // widened the grammar. Keep it narrow: RULE-N, nothing else — a
    // free-text citation would let anyone mint their own authority.
    expect(
      OPEN.exec("<!-- RATIFIED RULE-2 invariants-absolute — do not edit; owner only -->")?.[1],
    ).toBe("RULE-2");
    expect(
      OPEN.exec("<!-- RATIFIED severity-scale — do not edit; owner only -->")?.[1],
    ).toBe("");
    expect(OPEN.exec("<!-- RATIFIED rule 2 x — do not edit; owner only -->")).toBe(null);
    expect(OPEN.exec("<!-- RATIFIED the owner x — do not edit; owner only -->")).toBe(null);
  });

  it("the role half accepts both spellings — 'owner only' for new fences, 'the owner only' grandfathered", () => {
    expect(OPEN.exec("<!-- RATIFIED role-worded — do not edit; owner only -->")?.[2]).toBe(
      "role-worded",
    );
    expect(
      OPEN.exec("<!-- RATIFIED RULE-2 invariants-absolute — do not edit; owner only -->")?.[1],
    ).toBe("RULE-2");
    // Existing fences keep their ratified bytes — the personal spelling parses.
    expect(OPEN.exec("<!-- RATIFIED ci-gate — do not edit; owner only -->")?.[2]).toBe(
      "ci-gate",
    );
    // But only those two: a free-text role would dilute the marker.
    expect(OPEN.exec("<!-- RATIFIED x — do not edit; the owner only -->")).toBe(null);
    expect(OPEN.exec("<!-- RATIFIED x — do not edit; anyone only -->")).toBe(null);
  });

  it("the reseed annotation parses in exactly one spelling: a ticket and a date (R8)", () => {
    const m = OPEN.exec(
      "<!-- RATIFIED memory-discipline (reseeded 2026-10-07) — do not edit; owner only -->",
    );
    expect(m?.slice(1, 5)).toEqual(["", "memory-discipline", "", "2026-10-07"]);
    // Without one, the groups are empty — every older marker parses as before.
    expect(
      OPEN.exec("<!-- RATIFIED improvement-caps — do not edit; owner only -->")?.[3],
    ).toBeUndefined();
    // Anything else in the parenthesis is not a marker — and parseFences
    // throws on it rather than reading the line as prose.
    for (const bad of [
      "<!-- RATIFIED x (reseeded by the owner) — do not edit; owner only -->",
      "<!-- RATIFIED x (reseeded) — do not edit; owner only -->",
      "<!-- RATIFIED x (reseeded RULE-2, 2026-10-07) — do not edit; owner only -->",
      "<!-- RATIFIED x (reseeded 7 Oct) — do not edit; owner only -->",
      "<!-- RATIFIED x (note: softer now) — do not edit; owner only -->",
      "<!-- RATIFIED x (reseeded 2026-10-07)— do not edit; owner only -->",
    ]) {
      expect(OPEN.exec(bad), bad).toBe(null);
      expect(() => parseFences(`${bad}\nbody\n<!-- /RATIFIED x -->`, "t.md"), bad).toThrow(
        /malformed RATIFIED marker/,
      );
    }
    const [fence] = parseFences(
      "<!-- RATIFIED x (reseeded 2026-10-07) — do not edit; owner only -->\nbody\n<!-- /RATIFIED x -->",
      "t.md",
    );
    expect(fence).toEqual({
      ft: "",
      slug: "x",
      reseeded: { ft: "", date: "2026-10-07" },
      body: "body",
    });
  });
});
