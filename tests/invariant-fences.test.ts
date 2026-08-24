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
  /** The ticket on which the owner ratified this rule. */
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
};

const FROZEN_SEEDS = [
  "prompts/pass-common.md",
  "prompts/conversation-system.md",
  "prompts/overseer-system.md",
  "prompts/eod-sweep.md",
] as const;

const OPEN = /^<!-- RATIFIED (FT-\d{4}) ([a-z0-9-]+) — do not edit; owner only -->$/;
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

  it("the frozen seeds carry no fence (adding one is a reseed — rule 6)", () => {
    // Fencing the seeds is real work, prepared in FROZEN-SEED-FENCES.md and
    // waiting on the owner: a fence is a byte change, so it needs a ratified
    // reseed recorded in RATIFIED_DIVERGENCE. Until then this stays empty.
    for (const rel of FROZEN_SEEDS) {
      expect(
        read(rel).includes("RATIFIED"),
        `${rel} carries a RATIFIED fence. Adding one to a FROZEN seed is a reseed ` +
          `(root CLAUDE.md rule 6) — it needs the owner's explicit ratification in ` +
          `tests/fixtures/ratified-divergence.json. See FROZEN-SEED-FENCES.md.`,
      ).toBe(false);
    }
  });
});
