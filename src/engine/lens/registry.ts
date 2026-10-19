// The lens agent registry: which lens definitions a session may name, read
// from the `<pass>--<tier>.md` files `buildAgents` (src/include.ts) writes.
// It stands where pi's example subagent extension (examples/extensions/
// subagent/agents.ts) and QCR_SUBAGENT_SCOPE stand on the tmux route: the
// engine hands it the built agents dir (and, later, profile dirs) explicitly,
// so no scope env, no `~/.pi/agent/agents` symlink and no repo `.pi/agents`
// discovery decides what a lens can be.
//
// Parsing is `splitFrontmatter` plus the same field reading the example does
// (name, description, tools, model; the body trimmed), so the registry names
// exactly the agents the example would have found, with the same values. The
// two are compared in tests/lens-registry.test.ts. A file the example would
// skip (no name or no description) is skipped here too, and reported.
//
// Layers: the built dir first, profile dirs after. A later layer's agent of
// the same name replaces the earlier one, and the registry says so — a lens
// whose body came from a profile is "customised" (distribution ruling: a
// profile that overrides a seed marks the output).
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { splitModelSpec } from "../../config.js";
import { splitFrontmatter } from "../../include.js";

/** One source directory of agent `.md` files. */
export interface AgentLayer {
  dir: string;
  /** `"built"`: `buildAgents` output (the seeds composed with addenda).
   * `"profile"`: an operator's or repo's profile agents, which replace a
   * built agent of the same name. */
  origin: "built" | "profile";
}

export interface LensAgent {
  /** The frontmatter `name:` — `<pass>--<tier>` for a built agent. */
  name: string;
  description: string;
  /** The frontmatter `model:` WHOLE, `provider/model[:thinking]` — what the
   * example hands pi's `--model`. Undefined when the file names none. */
  model: string | undefined;
  /** `model` without its `:thinking` suffix. */
  modelId: string | undefined;
  /** The spec's `:thinking` suffix, else the `thinking:` field, else null. */
  thinking: string | null;
  /** The `tools:` allowlist; undefined when the file has none (no allowlist,
   * which is not the same statement as an empty one). */
  tools: string[] | undefined;
  /** The system prompt: everything after the frontmatter, trimmed. */
  body: string;
  filePath: string;
  origin: AgentLayer["origin"];
  /** The file of the same-named agent from an earlier layer that this one
   * replaced (a profile over a built agent). Null when it replaced nothing. */
  overrides: string | null;
}

export interface SkippedAgent {
  filePath: string;
  reason: string;
}

export interface AgentRegistry {
  readonly agents: ReadonlyMap<string, LensAgent>;
  /** Files the registry did not load, and why. */
  readonly skipped: readonly SkippedAgent[];
  get(name: string): LensAgent | undefined;
  names(): string[];
  /** Agents whose body came from a profile layer, in name order. */
  customised(): LensAgent[];
}

/** A scalar frontmatter value: one line, surrounding quotes dropped. */
function scalar(raw: string): string {
  const v = raw.trim();
  const q = v[0];
  if ((q === '"' || q === "'") && v.length >= 2 && v.endsWith(q)) return v.slice(1, -1);
  return v;
}

function field(frontmatter: string, key: string): string | undefined {
  const m = new RegExp(`^${key}:[ \\t]*(.*)$`, "m").exec(frontmatter);
  if (!m) return undefined;
  const v = scalar(m[1] ?? "");
  return v === "" ? undefined : v;
}

/** `tools: read, bash` and `tools: [read, bash]` both name two tools; a line
 * with nothing usable on it yields no allowlist, as in the example. */
function toolList(frontmatter: string): string[] | undefined {
  const raw = field(frontmatter, "tools");
  if (raw === undefined) return undefined;
  const inner = raw.startsWith("[") && raw.endsWith("]") ? raw.slice(1, -1) : raw;
  const tools = inner
    .split(",")
    .map((t) => scalar(t))
    .filter((t) => t.length > 0);
  return tools.length > 0 ? tools : undefined;
}

/** Parse one agent file; a string is the reason it is not an agent. */
export function parseAgentFile(
  text: string,
  filePath: string,
  origin: AgentLayer["origin"],
): LensAgent | string {
  // pi's parser normalises newlines and drops a BOM before looking for the fence.
  const normalised = text.replace(/^\uFEFF/, "").replace(/\r\n?/g, "\n");
  const doc = splitFrontmatter(normalised);
  if (!doc.hasFrontmatter) return "no frontmatter block";
  const name = field(doc.frontmatter, "name");
  if (name === undefined) return "no name in the frontmatter";
  const description = field(doc.frontmatter, "description");
  if (description === undefined) return "no description in the frontmatter";
  const model = field(doc.frontmatter, "model");
  const split = model === undefined ? undefined : splitModelSpec(model);
  return {
    name,
    description,
    model,
    modelId: split?.model,
    thinking: split?.thinking ?? field(doc.frontmatter, "thinking") ?? null,
    tools: toolList(doc.frontmatter),
    body: doc.body.trim(),
    filePath,
    origin,
    overrides: null,
  };
}

function mdFiles(dir: string): string[] {
  try {
    if (!statSync(dir).isDirectory()) return [];
    return readdirSync(dir)
      .filter((f) => f.endsWith(".md"))
      .sort();
  } catch {
    return [];
  }
}

/**
 * Load the registry from `layers`, earlier first. A missing or unreadable
 * dir is an empty layer. Within one layer a second file naming an agent
 * already loaded from it loses (filename order) and is reported; across
 * layers the later one replaces the earlier and records what it replaced.
 */
export function loadAgentRegistry(layers: readonly AgentLayer[]): AgentRegistry {
  const agents = new Map<string, LensAgent>();
  const skipped: SkippedAgent[] = [];
  for (const layer of layers) {
    const fromThisLayer = new Set<string>();
    for (const file of mdFiles(layer.dir)) {
      const filePath = join(layer.dir, file);
      let text: string;
      try {
        text = readFileSync(filePath, "utf8");
      } catch (err) {
        skipped.push({ filePath, reason: `unreadable: ${(err as Error).message}` });
        continue;
      }
      const parsed = parseAgentFile(text, filePath, layer.origin);
      if (typeof parsed === "string") {
        skipped.push({ filePath, reason: parsed });
        continue;
      }
      if (fromThisLayer.has(parsed.name)) {
        skipped.push({ filePath, reason: `duplicate agent name ${parsed.name} in ${layer.dir}` });
        continue;
      }
      fromThisLayer.add(parsed.name);
      const earlier = agents.get(parsed.name);
      agents.set(parsed.name, { ...parsed, overrides: earlier?.filePath ?? null });
    }
  }
  return {
    agents,
    skipped,
    get: (name) => agents.get(name),
    names: () => [...agents.keys()].sort(),
    customised: () =>
      [...agents.values()]
        .filter((a) => a.origin === "profile")
        .sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0)),
  };
}

/** The registry of one `buildAgents` output dir. */
export function loadBuiltAgents(dir: string): AgentRegistry {
  return loadAgentRegistry([{ dir, origin: "built" }]);
}
