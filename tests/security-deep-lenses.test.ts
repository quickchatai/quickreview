// What three deep security lenses promise the rest of the system, read off
// the lens files themselves. The chain lens is driven by its task: the row's
// strategy arrives as a `Strategy:` line (absent means `delta`) and its leads
// under `CHAIN LEADS`, so the lens must name both the way the task renders
// them, and its outcome table must keep a chain with two unproven hops out of
// the posted set. The toctou and infra lenses each hold one ownership ruling
// another lens hands them: a race is toctou's only when a security asset is
// at stake, and an automounted service-account token is infra's only with a
// broad role cited. Content shared by the whole family is
// `security-lens-content.test.ts`'s.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { splitFrontmatter } from "@quickchatai/pi-quickreview/src/include.js";
import { CHAIN_PASS, CHAIN_STRATEGIES } from "@quickchatai/pi-quickreview/src/passes.js";

const ROOT = join(import.meta.dirname, "..");

/** A lens file's body, without its frontmatter. */
const body = (lens: string): string =>
  splitFrontmatter(readFileSync(join(ROOT, "agents", `${lens}.md`), "utf8")).body;

/** The lines of a fenced evidence block that follow `heading`. */
function evidenceLines(text: string, heading: string): string[] {
  const from = text.indexOf(heading);
  expect(from, heading).toBeGreaterThanOrEqual(0);
  const open = text.indexOf("```", from);
  const close = text.indexOf("```", open + 3);
  return text.slice(open + 3, close).split("\n");
}

describe("the exploit-chain lens reads its row from the task", () => {
  const text = body(CHAIN_PASS);
  const inputs = text.slice(text.indexOf("## Your task's inputs"), text.indexOf("## Worksheet"));

  // MUTATION: drop "`compose`" from the Strategy bullet of agents/pass-sec-exploit-chain.md — fails.
  it("names every strategy on the `Strategy:` line, and `delta` when there is none", () => {
    const from = inputs.indexOf("- **`Strategy:`**");
    expect(from).toBeGreaterThanOrEqual(0);
    const bullet = inputs.slice(from, inputs.indexOf("\n- ", from + 1));
    for (const s of CHAIN_STRATEGIES) expect(bullet, s).toContain(`\`${s}\``);
    expect(bullet).toContain("No such line means `delta`.");
    // Each strategy has its own way to build chains in step 4.
    for (const s of CHAIN_STRATEGIES) expect(text, s).toMatch(new RegExp(`^\\s+- \`${s}\`:`, "m"));
  });

  // MUTATION: delete `UNCONFIRMED` from the CHAIN LEADS bullet — fails.
  it("takes this round's leads for compose and older partial chains, unconfirmed, for delta", () => {
    expect(inputs).toContain("**`CHAIN LEADS`**");
    expect(inputs).toContain("`UNCONFIRMED`");
    expect(inputs).toContain("A lead is a pointer, never a fact");
  });

  // A chain resting on two unproven hops is a record for later rounds, never
  // a comment, and keeps its severity like any other doubt.
  // MUTATION: change the partial-chain row's outcome to "a question" — fails.
  it("records a chain with two or more plausible hops as a partial chain, never posted", () => {
    const row = text.split("\n").find((l) => l.startsWith("| two or more `plausible`"));
    expect(row).toBeDefined();
    expect(row).toContain("`kind: partial-chain`");
    expect(row).toContain("never posted");
    expect(row).toContain("severity kept");
    const one = text.split("\n").find((l) => l.startsWith("| exactly one `plausible`"));
    expect(one).toContain("a question");
  });

  // MUTATION: rename `pr-hop:` back to `delta:` in the chain block — fails
  // (and the family's retired-field fence fails with it).
  it("states the PR's hop, the glue and the weakest hop in the family's named lines", () => {
    const lines = evidenceLines(text, "## Output");
    for (const name of ["source", "boundary", "sink", "path", "controls", "cwe", "proof-gaps"])
      expect(
        lines.some((l) => new RegExp(`^\\s+${name}:`).test(l)),
        name,
      ).toBe(true);
    for (const name of ["gains", "glue", "weakest", "pr-hop"])
      expect(
        lines.some((l) => new RegExp(`^\\s+${name}:`).test(l)),
        name,
      ).toBe(true);
  });
});

describe("the toctou lens", () => {
  const text = body("pass-sec-toctou");

  // MUTATION: delete the "A security asset gates every shape below" paragraph — fails.
  it("takes a race only when a security asset is at stake, and leaves the rest to pass-concurrency", () => {
    const gate = text.indexOf("**A security asset gates every shape below.**");
    expect(gate).toBeGreaterThanOrEqual(0);
    expect(gate).toBeLessThan(text.indexOf("## Shapes to recognise"));
    expect(text).toContain("`pass-concurrency`'s, however real");
  });

  // MUTATION: rename `between:` to `window:` in agents/pass-sec-toctou.md — fails.
  it("states the gap between check and use as `between:`", () => {
    const lines = evidenceLines(text, "## Evidence");
    expect(lines.some((l) => /^\s+between:/.test(l))).toBe(true);
  });
});

describe("the infra lens", () => {
  const text = body("pass-sec-infra");

  // The tokens lens hands an automounted service-account token to infra;
  // infra excludes automount as hardening, so without this paragraph nobody
  // reports it.
  // MUTATION: delete the "Service-account tokens" paragraph — fails.
  it("owns an automounted service-account token with a cited broad role, and only then", () => {
    const para = text.slice(text.indexOf("**Service-account tokens.**"));
    expect(text).toContain("**Service-account tokens.**");
    expect(para).toContain("**broad role you cite**");
    expect(para).toContain("is yours");
    expect(para).toContain("Without a cited broad role, automount is hardening and excluded.");
  });

  // MUTATION: replace "never that it is running right now" with "and that it is running" — fails.
  it("claims the config the repo ships, never live state, and notes live state for the operator", () => {
    expect(text).toContain(
      "in force in the config this repo ships, never that it is running right\nnow",
    );
    expect(text).toContain("**Live-state note for the operator**");
  });

  // MUTATION: write `delta:` in place of `pr-hop:` in the infra block — fails.
  it("adds only family-named lines to the block", () => {
    const lines = evidenceLines(text, "## Evidence");
    for (const name of ["listener", "gains", "pr-hop"])
      expect(
        lines.some((l) => new RegExp(`^\\s+${name}:`).test(l)),
        name,
      ).toBe(true);
  });
});
