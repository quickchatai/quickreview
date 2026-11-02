// The security family's lens files and the contract they share
// (`prompts/pass-sec-common.md`). Every `agents/pass-sec-*.md` is checked by
// glob, so a lens added later is held to the same rules without an edit
// here: it composes the generic pass contract and then the family's, it is a
// leaf named after its file, its built body names no stack and no daemon
// check, and its evidence lines use the family's field names (the retired
// `delta:` and `window:` meant different things in different lenses).
import { copyFileSync, mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  buildAgents,
  frontmatterName,
  PASS_ADDENDA,
  splitFrontmatter,
  stripAgentSpawnTools,
  type BuildAgentsOptions,
} from "@quickchatai/pi-quickreview/src/include.js";
import { SECURITY_FAMILY } from "@quickchatai/pi-quickreview/src/passes.js";
import { HEAVY_TIMEOUT_MS } from "./helpers/suite-timeouts.js";

const ROOT = join(import.meta.dirname, "..");
const AGENTS = join(ROOT, "agents");
const COMMON = "prompts/pass-sec-common.md";
const PASS_COMMON_INCLUDE = "{{include:prompts/pass-common.md}}";
const SEC_COMMON_INCLUDE = `{{include:${COMMON}}}`;

/** Every family lens file on disk, by stem. */
const lensFiles = (): string[] =>
  readdirSync(AGENTS)
    .filter((f) => f.startsWith("pass-sec-") && f.endsWith(".md"))
    .map((f) => f.replace(/\.md$/, ""))
    .sort();

const source = (lens: string): string => readFileSync(join(AGENTS, `${lens}.md`), "utf8");

/** The tools a leaf lens may list: reading only, never a launcher. */
const LEAF_TOOLS = ["read", "bash", "grep"];

/** An evidence line under a retired field name. */
const RETIRED_FIELD = /^\s*(delta|window):/m;

/** The named lines a lens may add to the base block, each defined once in the common text. */
const EXTRA_FIELDS = [
  "gains",
  "pr-hop",
  "between",
  "lifetime",
  "listener",
  "siblings",
  "bypass",
  "glue",
  "weakest",
  "seed",
  "unrecorded",
];

/** Build only the family's files (the includes still resolve against the
 * repo root), and return pass → the body of one built variant. */
function buildFamily(opts: BuildAgentsOptions): Map<string, string> {
  const src = mkdtempSync(join(tmpdir(), "qcr-seclens-src-"));
  const out = mkdtempSync(join(tmpdir(), "qcr-seclens-out-"));
  try {
    for (const lens of lensFiles())
      copyFileSync(join(AGENTS, `${lens}.md`), join(src, `${lens}.md`));
    const bodies = new Map<string, string>();
    for (const b of buildAgents(src, out, { root: ROOT, addenda: PASS_ADDENDA, ...opts }))
      if (!bodies.has(b.pass)) bodies.set(b.pass, readFileSync(b.output, "utf8"));
    return bodies;
  } finally {
    rmSync(src, { recursive: true, force: true });
    rmSync(out, { recursive: true, force: true });
  }
}

describe("the family's lens files", () => {
  // The glob is held to the registry, so neither half can be vacuous: an
  // empty glob would pass every per-file case below.
  // MUTATION: delete agents/pass-sec-variant.md — fails.
  it("are exactly SECURITY_FAMILY", () => {
    expect(lensFiles()).toEqual([...SECURITY_FAMILY].sort());
  });

  // MUTATION: drop the pass-sec-common include from agents/pass-sec-llm.md — fails.
  it("compose the generic pass contract, then the family's, before the lens's own text", () => {
    for (const lens of lensFiles()) {
      const body = splitFrontmatter(source(lens)).body;
      const generic = body.indexOf(PASS_COMMON_INCLUDE);
      const family = body.indexOf(SEC_COMMON_INCLUDE);
      expect(generic, `${lens}: ${PASS_COMMON_INCLUDE}`).toBeGreaterThanOrEqual(0);
      expect(family, `${lens}: ${SEC_COMMON_INCLUDE}`).toBeGreaterThan(generic);
      const heading = body.indexOf("# Lens:");
      expect(heading, `${lens}: "# Lens:" heading`).toBeGreaterThan(family);
      // No other `{{…}}`: a build-time variable in lens text fails the build,
      // and a brace pair in an example would read as one.
      const rest = body.replace(PASS_COMMON_INCLUDE, "").replace(SEC_COMMON_INCLUDE, "");
      expect(rest, `${lens}: stray {{`).not.toContain("{{");
    }
  });

  // MUTATION: add `subagent` to the tools line of agents/pass-sec-variant.md — fails.
  it("are leaves named after their files", () => {
    for (const lens of lensFiles()) {
      const doc = splitFrontmatter(source(lens));
      expect(doc.hasFrontmatter, lens).toBe(true);
      expect(frontmatterName(doc.frontmatter), lens).toBe(lens);
      // The build strips a launcher; a lens that lists none has nothing stripped.
      expect(stripAgentSpawnTools(doc.frontmatter), lens).toBe(doc.frontmatter);
      const tools = /^tools:[ \t]*(.*)$/m.exec(doc.frontmatter)?.[1];
      expect(tools, `${lens}: tools line`).toBeDefined();
      for (const t of tools!.split(",").map((s) => s.trim()))
        expect(LEAF_TOOLS, `${lens}: tool ${t}`).toContain(t);
    }
  });

  // MUTATION: write `delta:` in place of `gains:` in agents/pass-sec-privesc.md — fails.
  it("use the family's field names, never the retired delta: or window:", () => {
    for (const lens of lensFiles()) expect(source(lens), lens).not.toMatch(RETIRED_FIELD);
    expect(readFileSync(join(ROOT, COMMON), "utf8")).not.toMatch(RETIRED_FIELD);
  });

  // MUTATION: put "Django admin" back into agents/pass-sec-authn-coverage.md — fails.
  it(
    "build to bodies that carry both contracts and name no stack or daemon check, in review and in scan",
    { timeout: HEAVY_TIMEOUT_MS },
    () => {
      const builds: Array<[string, BuildAgentsOptions]> = [
        ["pr", {}],
        ["pr, ecosystem none", { ecosystem: "none" }],
        ["scan, deep", { mode: "scan", scanDepth: "deep" }],
      ];
      for (const [label, opts] of builds) {
        const bodies = buildFamily(opts);
        expect([...bodies.keys()].sort(), label).toEqual(lensFiles());
        for (const [lens, body] of bodies) {
          const where = `${label}/${lens}`;
          expect(body, where).toContain("blank-slate review pass");
          expect(body, where).toContain("# Security lenses — shared contract");
          expect(body, where).not.toContain("{{");
          expect(body, where).not.toContain("Django");
          expect(body, where).not.toMatch(/pre-check/i);
        }
      }
    },
  );
});

describe("the family's shared contract", () => {
  const text = readFileSync(join(ROOT, COMMON), "utf8");

  // An owner line per member keeps the routing total: a lens with no line is
  // one whose defects every other lens is told are not theirs.
  // MUTATION: delete the pass-sec-iam bullet from prompts/pass-sec-common.md — fails.
  it("names an owner line for every member, and for nothing else", () => {
    const section = text.slice(text.indexOf("## Who owns what"));
    const owners = [...section.matchAll(/^- `(pass-sec-[a-z-]+)`:/gm)].map((m) => m[1]);
    expect(owners.sort()).toEqual([...SECURITY_FAMILY].sort());
  });

  // MUTATION: drop the `glue:` definition from prompts/pass-sec-common.md — fails.
  it("defines the base evidence block and every named line a lens may add", () => {
    for (const line of ["source", "boundary", "sink", "path", "controls", "cwe", "proof-gaps"])
      expect(text, line).toMatch(new RegExp(`^\\s+${line}:`, "m"));
    for (const name of EXTRA_FIELDS) expect(text, name).toContain(`\`${name}:\``);
  });

  // An env var or CLI flag as the attacker's input is excluded; the config
  // the repo ships is the infra, iam and supply-chain lenses' whole remit.
  // MUTATION: restore "environment, command-line or operator config treated
  // as trusted;" in prompts/pass-sec-common.md — fails.
  it("excludes the operator as an attacker source, never the config the repo ships", () => {
    const flat = text.replace(/\s+/g, " ");
    expect(flat).toContain(
      "an environment variable, command-line flag or operator-written runtime setting treated as attacker input (the operator is trusted)",
    );
    expect(flat).toContain("This never excludes the config the repository ships");
    expect(flat).not.toContain("environment, command-line or operator config treated as trusted");
  });

  // MUTATION: change "set `confidence` to 0.6 or less, and keep the severity"
  // to "lower the severity" — fails.
  it("keeps doubt in confidence, never in severity, and excludes rather than asks", () => {
    expect(text).toContain("set `confidence` to 0.6 or less, and\n  keep the severity");
    expect(text).toContain("**Confidence carries\ndoubt; severity never does.**");
    expect(text).toContain("**Excluded**: never a finding and never a question.");
    expect(text).toContain("literal credential in any file is never excluded");
    expect(text).toContain("are **claims to check, never proof**");
  });
});
