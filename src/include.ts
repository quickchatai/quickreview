// Build-time `{{include:path}}` preprocessing for agent/prompt markdown.
//
// pi-subagents has no native include mechanism (§1: an agent is a
// markdown file with YAML frontmatter whose body becomes the subagent system
// prompt — nothing more). So the shared `prompts/pass-common.md` contract is
// expanded here, at build time, into a generated agents directory that the
// extension is pointed at. The seeded `agents/pass-*.md` sources stay
// canonical and unedited.
//
// Rules:
//  - `{{include:<path>}}` — path is relative to the sandbox root.
//  - includes may nest; a cycle throws.
//  - a missing include throws (never silently emits the literal directive).
//  - frontmatter passes through byte-for-byte, except the `name:`/`model:`/
//    `thinking:` fields the tier fan-out rewrites (knob, tiered).
//
// Tier fan-out: each seeded pass builds into per-tier variant files
// `<pass>--<tier>.md`. Risk passes (config models.risk_passes) build only the
// sol-high variant; pass-validate builds only its fixed tier
// (models.validate_tier); every other pass builds all three tiers. The tier's
// model spec ("provider/model:thinking") is split into the SEPARATE
// pi-subagents `model` and `thinking` frontmatter fields. The read-only
// execution-policy addendum is appended to every BUILT body — seeds untouched.
import { mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { isAbsolute, resolve, join } from "node:path";
import { MODELS_TIER_DEFAULTS } from "./config.js";
import type { PassTier } from "./types.js";

const INCLUDE_RE = /\{\{include:([^}\r\n]+)\}\}/g;

export interface IncludeOptions {
  /** Sandbox root every include path is resolved against. */
  root: string;
  /** Injected for tests; defaults to the real fs. */
  readFile?: (path: string) => string;
  /** Max nesting depth — a runaway include chain fails loudly. */
  maxDepth?: number;
}

function readOr(opts: IncludeOptions, path: string, directive: string): string {
  const read = opts.readFile ?? ((p: string) => readFileSync(p, "utf8"));
  try {
    return read(path);
  } catch (err) {
    throw new Error(`include not found: {{include:${directive}}} → ${path} (${(err as Error).message})`);
  }
}

/** Expand every `{{include:…}}` directive in `text`, recursively. */
export function expandIncludes(text: string, opts: IncludeOptions): string {
  return expand(text, opts, [], 0);
}

function expand(text: string, opts: IncludeOptions, stack: string[], depth: number): string {
  const maxDepth = opts.maxDepth ?? 16;
  if (depth > maxDepth) throw new Error(`include nesting exceeded ${maxDepth} levels: ${stack.join(" → ")}`);
  return text.replace(INCLUDE_RE, (_match, rawPath: string) => {
    const directive = rawPath.trim();
    if (!directive) throw new Error("empty include directive: {{include:}}");
    if (isAbsolute(directive)) throw new Error(`include path must be relative to the sandbox root: ${directive}`);
    const abs = resolve(opts.root, directive);
    if (stack.includes(abs)) throw new Error(`include cycle: ${[...stack, abs].join(" → ")}`);
    const body = readOr(opts, abs, directive);
    return expand(body, opts, [...stack, abs], depth + 1);
  });
}

// ---- frontmatter ---------------------------------------------------------

export interface AgentDoc {
  /** Raw frontmatter block *without* the `---` fences (may be ""). */
  frontmatter: string;
  /** Everything after the closing fence. */
  body: string;
  /** True when the source actually carried a frontmatter block. */
  hasFrontmatter: boolean;
}

export function splitFrontmatter(text: string): AgentDoc {
  if (!text.startsWith("---\n")) return { frontmatter: "", body: text, hasFrontmatter: false };
  const end = text.indexOf("\n---\n", 3);
  if (end === -1) return { frontmatter: "", body: text, hasFrontmatter: false };
  return {
    frontmatter: text.slice(4, end + 1),
    body: text.slice(end + 5),
    hasFrontmatter: true,
  };
}

export function joinFrontmatter(doc: AgentDoc): string {
  return doc.hasFrontmatter ? `---\n${doc.frontmatter}---\n${doc.body}` : doc.body;
}

/** Read the `name:` field of an agent's frontmatter (falls back to null). */
export function frontmatterName(frontmatter: string): string | null {
  const m = /^name:[ \t]*(.+?)[ \t]*$/m.exec(frontmatter);
  return m ? (m[1] ?? null) : null;
}

/** Rewrite a scalar frontmatter field in place; append it when absent. */
function applyField(frontmatter: string, field: string, value: string): string {
  const re = new RegExp(`^${field}:[ \\t]*.*$`, "m");
  if (re.test(frontmatter)) return frontmatter.replace(re, `${field}: ${value}`);
  return `${frontmatter}${field}: ${value}\n`;
}

/** Rewrite the `model:` frontmatter field. Adds it when absent. */
export function applyModelOverride(frontmatter: string, model: string): string {
  return applyField(frontmatter, "model", model);
}

/** Rewrite the `name:` frontmatter field. Adds it when absent. */
export function applyNameOverride(frontmatter: string, name: string): string {
  return applyField(frontmatter, "name", name);
}

/** Rewrite the `thinking:` frontmatter field. Adds it when absent. */
export function applyThinkingOverride(frontmatter: string, thinking: string): string {
  return applyField(frontmatter, "thinking", thinking);
}

/** Split a "provider/model:thinking" spec into pi-subagents' SEPARATE
 * `model` and `thinking` frontmatter fields. Only a recognized thinking
 * level after the last colon is treated as a suffix. */
export function splitModelSpec(spec: string): { model: string; thinking: string | null } {
  const m = /^(.+):(off|minimal|low|medium|high)$/.exec(spec);
  return m ? { model: m[1] as string, thinking: m[2] as string } : { model: spec, thinking: null };
}

// ---- the build step ------------------------------------------------------

/** All pass tiers, ascending. */
export const PASS_TIERS: readonly PassTier[] = ["terra-med", "sol-med", "sol-high"];

/** Appended to every BUILT agent body (never to the seeds). */
export const EXECUTION_POLICY_ADDENDUM =
  "\n\n## Execution policy (sandbox rule, enforced)\nYou are a read-only reviewer. Never execute project code, tests, builds, scripts, or package managers (no python/pytest/uv/npm/node/make or similar). Allowed commands: git, rg, grep, cat, ls, find, head, tail, wc, jq, sed, awk, sort, uniq, diff, and read-only gh. CI results are READ via `gh pr checks` / `gh api` — never re-run or trigger anything.\n";

export interface BuildAgentsOptions {
  /** Sandbox root for include resolution. Defaults to `srcDir`'s parent. */
  root?: string;
  /** config.models.tiers — PassTier → model spec ("provider/model:thinking"). */
  tiers?: Record<PassTier, string>;
  /** config.models.risk_passes — build only the sol-high variant. */
  riskPasses?: string[];
  /** config.models.validate_tier — pass-validate's single fixed tier. */
  validateTier?: PassTier;
  /** Per-VARIANT model-spec overrides, keyed by variant name
   * (`<pass>--<tier>`) — wins over the tier's spec; same splitting rules. */
  models?: Record<string, string>;
  readFile?: (path: string) => string;
}

export interface BuiltAgent {
  /** Variant agent name: `<pass>--<tier>`. */
  name: string;
  /** The seeded pass this variant was built from. */
  pass: string;
  tier: PassTier;
  source: string;
  output: string;
  /** Model id written to frontmatter (thinking suffix already split off). */
  model: string | null;
  /** Thinking level written to frontmatter, when the spec carried one. */
  thinking: string | null;
}

/** The tiers a given pass fans out into. */
export function tiersForPass(pass: string, riskPasses: string[], validateTier: PassTier): PassTier[] {
  if (riskPasses.includes(pass)) return ["sol-high"];
  if (pass === "pass-validate") return [validateTier];
  return [...PASS_TIERS];
}

/**
 * Preprocess every `agents/pass-*.md` in `srcDir` into per-tier variant files
 * `<pass>--<tier>.md` in `outDir` — the directory the pi-subagents extension
 * is configured to read (see `.pi/subagents.config.json`; the exact config
 * key/location is VERIFY-ON-PIN).
 */
export function buildAgents(srcDir: string, outDir: string, opts: BuildAgentsOptions = {}): BuiltAgent[] {
  const root = opts.root ?? resolve(srcDir, "..");
  const read = opts.readFile ?? ((p: string) => readFileSync(p, "utf8"));
  const tiers = opts.tiers ?? MODELS_TIER_DEFAULTS.tiers;
  const riskPasses = opts.riskPasses ?? MODELS_TIER_DEFAULTS.risk_passes;
  const validateTier = opts.validateTier ?? MODELS_TIER_DEFAULTS.validate_tier;
  const sources = readdirSync(srcDir)
    .filter((f) => f.startsWith("pass-") && f.endsWith(".md"))
    .sort();
  mkdirSync(outDir, { recursive: true });
  const built: BuiltAgent[] = [];
  for (const file of sources) {
    const src = join(srcDir, file);
    const doc = splitFrontmatter(read(src));
    const pass = frontmatterName(doc.frontmatter) ?? file.replace(/\.md$/, "");
    const body = expandIncludes(doc.body, { root, readFile: opts.readFile }) + EXECUTION_POLICY_ADDENDUM;
    for (const tier of tiersForPass(pass, riskPasses, validateTier)) {
      const name = `${pass}--${tier}`;
      const spec = opts.models?.[name] ?? tiers[tier];
      const { model, thinking } = splitModelSpec(spec);
      let frontmatter = applyNameOverride(doc.frontmatter, name);
      frontmatter = applyModelOverride(frontmatter, model);
      if (thinking !== null) frontmatter = applyThinkingOverride(frontmatter, thinking);
      const out = join(outDir, `${name}.md`);
      writeFileSync(out, joinFrontmatter({ ...doc, frontmatter, body }));
      built.push({ name, pass, tier, source: src, output: out, model, thinking });
    }
  }
  return built;
}
