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
//  - frontmatter passes through byte-for-byte, except the `model:` field when
//    a per-pass override exists in config.models.passes (knob).
import { mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { isAbsolute, resolve, join } from "node:path";

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

/** Rewrite the `model:` frontmatter field. Adds it when absent. */
export function applyModelOverride(frontmatter: string, model: string): string {
  if (/^model:[ \t]*.*$/m.test(frontmatter)) {
    return frontmatter.replace(/^model:[ \t]*.*$/m, `model: ${model}`);
  }
  return `${frontmatter}model: ${model}\n`;
}

// ---- the build step ------------------------------------------------------

export interface BuildAgentsOptions {
  /** Sandbox root for include resolution. Defaults to `srcDir`'s parent. */
  root?: string;
  /** config.models.passes — per-agent model overrides, keyed by agent name. */
  models?: Record<string, string>;
  readFile?: (path: string) => string;
}

export interface BuiltAgent {
  name: string;
  source: string;
  output: string;
  model: string | null;
}

/**
 * Preprocess every `agents/pass-*.md` in `srcDir` into `outDir` — the
 * directory the pi-subagents extension is configured to read (see
 * `.pi/subagents.config.json`; the exact config key/location is
 * VERIFY-ON-PIN).
 */
export function buildAgents(srcDir: string, outDir: string, opts: BuildAgentsOptions = {}): BuiltAgent[] {
  const root = opts.root ?? resolve(srcDir, "..");
  const read = opts.readFile ?? ((p: string) => readFileSync(p, "utf8"));
  const sources = readdirSync(srcDir)
    .filter((f) => f.startsWith("pass-") && f.endsWith(".md"))
    .sort();
  mkdirSync(outDir, { recursive: true });
  const built: BuiltAgent[] = [];
  for (const file of sources) {
    const src = join(srcDir, file);
    const doc = splitFrontmatter(read(src));
    const name = frontmatterName(doc.frontmatter) ?? file.replace(/\.md$/, "");
    const override = opts.models?.[name];
    const frontmatter = override ? applyModelOverride(doc.frontmatter, override) : doc.frontmatter;
    const body = expandIncludes(doc.body, { root, readFile: opts.readFile });
    const out = join(outDir, file);
    writeFileSync(out, joinFrontmatter({ ...doc, frontmatter, body }));
    built.push({ name, source: src, output: out, model: override ?? modelOf(doc.frontmatter) });
  }
  return built;
}

function modelOf(frontmatter: string): string | null {
  const m = /^model:[ \t]*(.+?)[ \t]*$/m.exec(frontmatter);
  return m ? (m[1] ?? null) : null;
}
