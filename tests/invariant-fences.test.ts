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
    { slug: "no-exec", ft: "", sha256: "ff6d7f5f6d0ef188ad08c546d51918439e64bba8c3e2fe41a77136d176664ffd" },
    { slug: "ci-gate", ft: "", sha256: "ee91ffaa73580f81b99cadc44fc8739b07afc3c86d685767a437cb411befb4c2" },
    { slug: "verdicts", ft: "", sha256: "ef1e9f0ba376694b2a438bd6c302399efeb6fd3c2c586dd6c2a42b4690190a8f" },
    { slug: "posting-map", ft: "", sha256: "cc384c1650e45820f80db8f90a2f5a74e383baafad5ff29c5c3f518ac27bf66c" },
    { slug: "reachability", ft: "", sha256: "94f36825f50099ee2e3f39b14091e15e694548bb61a6c29e5c7daab30d04683f" },
    { slug: "injection-bright-line", ft: "", sha256: "a05a211517c174831d54ca726d9ef454442792181a54283226101aadfc943a40" },
    { slug: "merge-call", ft: "", sha256: "6043c8a1252d04e9420c9c49b9da47b5df31ff68d74444f8b720a09f22eed54b" },
  ],
  "prompts/round-re-review.md": [
    { slug: "no-exec", ft: "", sha256: "ff6d7f5f6d0ef188ad08c546d51918439e64bba8c3e2fe41a77136d176664ffd" },
    { slug: "ci-gate", ft: "", sha256: "ee91ffaa73580f81b99cadc44fc8739b07afc3c86d685767a437cb411befb4c2" },
    { slug: "verdicts", ft: "", sha256: "675ba40ff990dd987f9ffa03e2381d0b4af526e129aaa7b6d0073aee9b9faef2" },
    { slug: "posting-map", ft: "", sha256: "cc384c1650e45820f80db8f90a2f5a74e383baafad5ff29c5c3f518ac27bf66c" },
    { slug: "never-dismiss", ft: "RULE-2", sha256: "c619376602fc5e032cbf648a135945dd0105cdd8282d1eec122483f8e5ecd84a" },
    { slug: "nit-scope", ft: "", sha256: "6e36bba0ad59c6d927d1e120826e814ba66c0dd25db2b63b14bdfb45356ed16c" },
    { slug: "reachability", ft: "", sha256: "94f36825f50099ee2e3f39b14091e15e694548bb61a6c29e5c7daab30d04683f" },
    { slug: "injection-bright-line", ft: "", sha256: "a05a211517c174831d54ca726d9ef454442792181a54283226101aadfc943a40" },
    { slug: "merge-call", ft: "", sha256: "9c9d036bda7733629c36243a18f4395ac4aab190ffcff4627508a7df064db422" },
  ],
  "prompts/round-staleness.md": [
    { slug: "no-exec", ft: "", sha256: "ff6d7f5f6d0ef188ad08c546d51918439e64bba8c3e2fe41a77136d176664ffd" },
    { slug: "ci-gate", ft: "", sha256: "d83b69bc87451b1f416e64095f5cd7c3d7cd2bb685f9ebdfadafed4f01b21c38" },
    { slug: "verdicts", ft: "", sha256: "c4f1b2e3d65081bcf86f6b15c15fe7ae28bb698094a3e57eab97bb42b20948f0" },
    { slug: "posting-map", ft: "", sha256: "cc384c1650e45820f80db8f90a2f5a74e383baafad5ff29c5c3f518ac27bf66c" },
    { slug: "reachability", ft: "", sha256: "94f36825f50099ee2e3f39b14091e15e694548bb61a6c29e5c7daab30d04683f" },
    { slug: "injection-bright-line", ft: "", sha256: "a05a211517c174831d54ca726d9ef454442792181a54283226101aadfc943a40" },
    { slug: "merge-call", ft: "", sha256: "2f1d371ae741e0aa455703af214648d59f52ada41863676b2d4ff28db51a03e8" },
  ],
  "prompts/round-recheck.md": [
    { slug: "uphold-one-way", ft: "", sha256: "54d7a088eeadd16588e963072d606310513bc953ae3ca042f22d80734a0fd7d1" },
    { slug: "regression-only", ft: "", sha256: "5877ea115f6d0861cb121d88e5132ebfc1e2642554974666ae0b6d33c5df151a" },
    { slug: "nit-scope", ft: "", sha256: "3796cb45a48ef24a197b247b7e976db3eb66fe4e9f44a5f776f82aa211fc1918" },
    { slug: "no-exec", ft: "", sha256: "efba0b28e5a0652b33c805f9cb680590c16b465c2216d378872dfd87b4e4ecda" },
  ],
  // The four FROZEN seeds. Fencing them is itself a reseed under root rule 6,
  // ratified by the owner on 2026-08-24 and recorded in
  // tests/fixtures/ratified-divergence.json.
  "prompts/pass-common.md": [
    { slug: "passes-post-nothing", ft: "RULE-9", sha256: "419335dd2ec6ebcc3c8e30eb05112176fb1a28611ae293ed31982f2e69876699" },
    { slug: "severity-scale", ft: "", sha256: "b1545b8a69b95f7ffa2f87489120e6ff78549865ed73eaa046baf7aa3649873a" },
  ],
  "prompts/conversation-system.md": [
    { slug: "credential", ft: "RULE-3", sha256: "333ab97f9184fb5e92f62135b30f6d002f960acdc6febc5f44397af544706a1f" },
    { slug: "decide-step", ft: "", sha256: "c224d3af7ce323f0c735bc7f530fd64dbc757e1b5f970cd69c45b7a201bffe6e" },
    { slug: "no-human-handoff", ft: "", sha256: "7dab3094e9076bf75925db665126faabe1ad668b8c0cf02e6576043e4de2a28d" },
    { slug: "ping-pong-discipline", ft: "", sha256: "818d6465aa7a0181efae103f3167d264feadc5ef0eb3c552c9e4fbab2e0779dc" },
    { slug: "invariants-absolute", ft: "RULE-2", sha256: "d5976bf31c68d797ed0924c18215fca3d6d6bbcdee9e8f09b4120d0a0ae8d9c8" },
  ],
  "prompts/overseer-system.md": [
    { slug: "action-space", ft: "", sha256: "db1096f9b317f45e5e58eef244dc9c816cd18e1aa9bd5360a3defcc187383585" },
    { slug: "action-space-never", ft: "RULE-2", sha256: "ed7fdd9b08aed50708ce47fc58002cfd7d3099c840ede3ba448dd904a6fb03ed" },
    { slug: "memory-discipline", ft: "", sha256: "c936de7475073b87c5e8572b5d7d7b3a3a99c4c3db9648afd25747f4bdc16dec" },
  ],
  "prompts/eod-sweep.md": [
    { slug: "memory-discipline", ft: "", sha256: "2cb50043a6dfbaa855a4852410039cdf8de44f3d99fb5458e998a071e96ef169" },
    { slug: "improvement-caps", ft: "", sha256: "5c0c653b1ef9c1773f18c55c09c415d72b9988df22cc9fcd19d9fb34cef6bf6f" },
  ],
  "agents/pass-intent.md": [
    { slug: "intent-artifact", ft: "", sha256: "95973aaf17e36d33961432b8440ecd8780760ebd756b7060bf6d2fcfd095f85e" },
    { slug: "thin-bodies-none", ft: "", sha256: "3e8b9f47a39edf5f95d95758edbd03c64b254a19e0d10e80dd2d05e79a22fa19" },
    { slug: "severity-cap", ft: "", sha256: "67f090951ce2f9d5862b73baa15cfedd1715b718870324dc7f227b9b4e0e0541" },
  ],
  "agents/pass-placement.md": [
    { slug: "repo-anchor", ft: "", sha256: "d8e7a1dcfb6de7ba81893950dcb072a9a416031d16efcb94c8cd31aa76732ec4" },
    { slug: "p2-cap", ft: "", sha256: "d133405681219eba3c40643b125a8cc9fd8f3d56c5338612f32d5c9e9e6a4d44" },
  ],
  "agents/pass-simplicity.md": [
    { slug: "beyond-the-diff", ft: "", sha256: "9b6c390e29d4c6b9ce639c2ba046e725939353398c9b788830c9296eff0be65e" },
    { slug: "never-counter-finding", ft: "", sha256: "a6105800effd9c2fefa696543427d9f2561e2057b463bc62225bb7e545867fa4" },
    { slug: "p2-cap", ft: "", sha256: "53feba72604cae68c009680e6aea7b4e507d4999e192e002814bb78f6ede77bd" },
  ],
  "agents/pass-backcompat.md": [
    { slug: "lens-boundaries", ft: "", sha256: "eb0637f3aa52ae27802b03f2bb4f29b2f2dbf85c07cd0728a9bc2b55fb2cdb5b" },
    { slug: "full-severity", ft: "", sha256: "cdb65345b6db3eecf9f89211ac5f2153d7328a622815198670f6ec171728cdea" },
  ],
  // the concurrency lens's two ratified burdens. Both are RAISE-side
  // bars, and both exist because a confidently-wrong race story costs more than
  // a missed one: the four-part shape is what makes a finding falsifiable at
  // all, and the self-falsification duty is the only place in the system where
  // a lens must try to kill its own candidate before the validator sees it.
  // Loosening either is the owner's call, not a prose trim.
  "agents/pass-concurrency.md": [
    { slug: "four-part-finding", ft: "", sha256: "1fdbdec097aaa3bb4b826c22cf304b43d1dd2ec21b906507eab2544ea4b89ec8" },
    { slug: "self-falsification", ft: "", sha256: "914fab18800b9ba3008da2270ef1ecd32491e3f3d38671342dd6e066e30b33b5" },
  ],
  // the ask-your-human lens's named-defect bar (the owner's words on
  // "it can only block if it says what is wrong under the bad answer.
  // Not 'unclear' — an actual described failure."). The blocker bar never
  // moves, and a lens whose whole output is questions is exactly where it would
  // move first: without this passage "I do not understand this" becomes a
  // blocker. `ask-human-named-defect-validate` enforces the same line from the
  // validator's side.
  "agents/pass-ask-human.md": [
    { slug: "named-defect-bar", ft: "", sha256: "1b97b394d8387ba7b000cea7404df7cd29baf5809a6dd955cb117931fc3b0788" },
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

const OPEN = new RegExp(String.raw`^<!-- RATIFIED (${CITATION}) ([a-z0-9-]+) — do not edit; owner only -->$`);
const CLOSE = /^<!-- \/RATIFIED ([a-z0-9-]+) -->$/;

interface ParsedFence {
  ft: string;
  slug: string;
  body: string;
}

/** Parse the fences out of a file. Throws on a malformed / unbalanced marker. */
export function parseFences(text: string, rel: string): ParsedFence[] {
  const lines = text.split("\n");
  const out: ParsedFence[] = [];
  let open: { ft: string; slug: string; from: number } | null = null;
  lines.forEach((line, i) => {
    const o = OPEN.exec(line);
    const c = CLOSE.exec(line);
    if (o) {
      if (open) throw new Error(`${rel}:${i + 1}: fence '${o[2]}' opens inside unclosed fence '${open.slug}'`);
      open = { ft: o[1] as string, slug: o[2] as string, from: i };
      return;
    }
    if (c) {
      if (!open) throw new Error(`${rel}:${i + 1}: closing marker '${c[1]}' with no open fence`);
      if (c[1] !== open.slug) {
        throw new Error(`${rel}:${i + 1}: fence '${open.slug}' closed by '${c[1]}'`);
      }
      out.push({ ft: open.ft, slug: open.slug, body: lines.slice(open.from + 1, i).join("\n") });
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
      expect(fence.ft, `${rel.split("/").pop()}#${pin.slug}: fence says ${fence.ft}, the pin says ${pin.ft}`).toBe(
        pin.ft,
      );
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
    expect(OPEN.exec("<!-- RATIFIED RULE-2 invariants-absolute — do not edit; owner only -->")?.[1]).toBe("RULE-2");
    expect(OPEN.exec("<!-- RATIFIED severity-scale — do not edit; owner only -->")?.[1]).toBe("");
    expect(OPEN.exec("<!-- RATIFIED rule 2 x — do not edit; owner only -->")).toBe(null);
    expect(OPEN.exec("<!-- RATIFIED the owner x — do not edit; owner only -->")).toBe(null);
  });
});
