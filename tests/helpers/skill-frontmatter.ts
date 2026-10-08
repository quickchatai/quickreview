// Reads a SKILL.md front-matter block the way pi does (H4).
//
// pi 1.0.0 (dist/utils/frontmatter.js, dist/core/skills.js, read from a local
// copy of the pinned package) takes the text between a leading `---` and the
// next `\n---` and gives it to the `yaml` package's `parse`. If that throws,
// pi prints the parser's message as a "[Skill conflicts]" warning and SKIPS
// the skill, so the skill silently disappears. That is how `replay` was lost
// from 2026-10-03 to 2026-10-08: its unquoted description contained ": ".
//
// Neither the `yaml` package nor any other YAML parser is a dependency here.
// prettier is a pinned devDependency, and its YAML plugin parses with the same
// library family, with the same error text and positions pi printed ("Nested
// mappings are not allowed in compact mappings", at 2:14). We use that plugin's
// parser as the oracle, not a regex. A regex over `^description: (.*)$` is
// what let the broken file pass `skill-descriptions.test.ts`.
import { parsers } from "prettier/plugins/yaml";

/** A front-matter block as YAML reads it: each top-level key with its value
 * when that value is a scalar (`null` for an empty value or a collection). */
export interface SkillFrontmatter {
  fields: Map<string, ScalarValue | null>;
  /** How many comments the block carries. In a plain scalar, ` #` starts a
   * comment, so it silently cuts the value short. */
  comments: number;
  body: string;
}

export interface ScalarValue {
  /** The scalar's style: plain, quoteDouble, quoteSingle, blockFolded,
   * blockLiteral. A plain `true` is a YAML boolean; a quoted one is a string. */
  style: string;
  /** The scalar's source text. For a plain scalar this is NOT what pi reads
   * when `resolvesTo` is not "string": `null` is the text of a null. */
  value: string;
  /** What pi's `yaml` hands the loader for this scalar. pi skips a skill
   * whose `description` is not a JS string, so a plain `null`, `~`, `true`
   * or `123` loses the skill as surely as a parse error does. */
  resolvesTo: ScalarResolution;
}

/** "tagged": the scalar carries an explicit tag other than `!!str`; we do not
 * model those, so a caller that needs a string should refuse it. */
export type ScalarResolution = "string" | "null" | "boolean" | "number" | "tagged";

// The plain-scalar resolvers of the YAML 1.2 core schema, which is what pi's
// `yaml` (2.9.0) `parse` uses by default, copied from its
// dist/schema/{common/null,core/bool,core/int,core/float}.js in the schema's
// own order. A plain scalar none of them matches is a string. The core schema
// takes no `_` digit separators and no `0b`, so `1_000` is a string here, as
// it is to pi.
const CORE_SCHEMA_RESOLVERS: readonly [RegExp, ScalarResolution][] = [
  [/^(?:~|[Nn]ull|NULL)?$/, "null"],
  [/^(?:[Tt]rue|TRUE|[Ff]alse|FALSE)$/, "boolean"],
  [/^0o[0-7]+$/, "number"],
  [/^[-+]?[0-9]+$/, "number"],
  [/^0x[0-9a-fA-F]+$/, "number"],
  [/^(?:[-+]?\.(?:inf|Inf|INF)|\.nan|\.NaN|\.NAN)$/, "number"],
  [/^[-+]?(?:\.[0-9]+|[0-9]+(?:\.[0-9]*)?)[eE][-+]?[0-9]+$/, "number"],
  [/^[-+]?(?:\.[0-9]+|[0-9]+\.[0-9]*)$/, "number"],
];

function resolveScalar(node: YNode, value: string): ScalarResolution {
  const tag = (node.tag as { value?: unknown } | null | undefined)?.value;
  if (tag === "tag:yaml.org,2002:str") return "string";
  if (tag !== undefined) return "tagged";
  if (node.type !== "plain") return "string";
  return CORE_SCHEMA_RESOLVERS.find(([re]) => re.test(value))?.[1] ?? "string";
}

interface YNode {
  type: string;
  value?: unknown;
  children?: (YNode | null)[];
  [key: string]: unknown;
}

const SCALAR_STYLES = new Set([
  "plain",
  "quoteDouble",
  "quoteSingle",
  "blockFolded",
  "blockLiteral",
]);

/** pi's own extraction (`extractFrontmatter`), applied to the file's text. */
export function extractFrontmatter(text: string): { yaml: string; body: string } | undefined {
  const unBommed = text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
  const normalized = unBommed.replace(/\r\n/g, "\n").replace(/\r/g, "\n");
  if (!normalized.startsWith("---")) return undefined;
  const end = normalized.indexOf("\n---", 3);
  if (end === -1) return undefined;
  return { yaml: normalized.slice(4, end), body: normalized.slice(end + 4).trim() };
}

function countComments(node: unknown): number {
  if (node === null || typeof node !== "object") return 0;
  if (Array.isArray(node)) return node.reduce((n: number, c) => n + countComments(c), 0);
  let n = (node as YNode).type === "comment" ? 1 : 0;
  for (const [key, v] of Object.entries(node)) {
    if (key === "position") continue;
    if (/comment/i.test(key) && v && (!Array.isArray(v) || v.length > 0))
      n += Array.isArray(v) ? v.length : 1;
    else n += countComments(v);
  }
  return n;
}

/**
 * Parse a SKILL.md file's front-matter. Throws, with the YAML parser's own
 * message, when the block is missing, does not parse, is not a mapping, or
 * repeats a key. pi's `yaml` refuses duplicate keys too, so all of these are
 * files pi would skip.
 */
export function parseSkillFrontmatter(text: string): SkillFrontmatter {
  const fm = extractFrontmatter(text);
  if (!fm) throw new Error("no front-matter block (--- … ---) at the top of the file");
  let root: YNode;
  try {
    root = parsers.yaml.parse(fm.yaml, {} as Parameters<typeof parsers.yaml.parse>[1]) as YNode;
  } catch (err) {
    throw new Error(
      `front-matter is not valid YAML: ${(err instanceof Error ? err.message : String(err)).split("\n")[0]}`,
      { cause: err },
    );
  }
  const docs = (root.children ?? []).filter((c): c is YNode => c !== null);
  if (docs.length !== 1) throw new Error(`front-matter holds ${docs.length} YAML documents, not 1`);
  const body = docs[0]!.children?.find((c) => c?.type === "documentBody");
  const mapping = body?.children?.[0];
  if (!mapping || mapping.type !== "mapping")
    throw new Error(`front-matter is not a mapping (${mapping?.type ?? "empty"})`);
  const fields = new Map<string, ScalarValue | null>();
  for (const item of mapping.children ?? []) {
    const [k, v] = item?.children ?? [];
    const keyNode = k?.children?.[0];
    if (!keyNode || !SCALAR_STYLES.has(keyNode.type) || typeof keyNode.value !== "string")
      throw new Error("front-matter has a key that is not a plain string");
    const key = keyNode.value;
    if (fields.has(key)) throw new Error(`front-matter repeats the key ${JSON.stringify(key)}`);
    const valueNode = v?.children?.[0];
    fields.set(
      key,
      valueNode && SCALAR_STYLES.has(valueNode.type) && typeof valueNode.value === "string"
        ? {
            style: valueNode.type,
            value: valueNode.value,
            resolvesTo: resolveScalar(valueNode, valueNode.value),
          }
        : null,
    );
  }
  return { fields, comments: countComments(root), body: fm.body };
}
