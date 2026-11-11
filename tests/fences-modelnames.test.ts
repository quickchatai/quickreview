// No model or provider name decides anything.
//
// A review runs on whatever provider pi has a credential for, on a model the
// pick rule reads off catalog metadata. A provider id in a comparison, or a
// model id written as a literal, is a rule about one vendor: it is wrong for
// every other one, and wrong for that one the day it ships its next model.
// This fence walks the shipped source and fails on
//
//   (a) a built-in provider id in a comparison, a `case` or a map key
//       (`=== "<id>"`, `case "<id>":`, `{ "<id>": ... }`, `{ <id>: "..." }`);
//   (b) a string literal that starts with `<built-in provider id>/`;
//   (c) a string literal equal to the leaf of a catalog model id that carries
//       a version and is six characters or longer.
//
// (c) is narrow on purpose: the catalog also holds ids whose leaf is an
// ordinary word or a short token (`auto`, `free`, `balanced`, `o3`), and
// those are settings and words all over the tree.
//
// The provider ids and the model ids are pi's own, read from the installed
// catalog: the fence names none.
//
// The allowlist is the files that keep a name, each with why, held by SET
// EQUALITY: a file that starts to fail is not on it, and a file that was
// cleaned is still on it; either fails. It is final: the measured model's id
// (data, in the one file that holds it) and the memory embedder's own vendor
// name. The embedder's config and engine (src/config.ts, src/openviking/)
// name that vendor too, in shapes this fence does not match; the day one of
// them does, it joins the list with that reason and nothing else does.
//
// Comments are not code, and what is one is TypeScript's own answer: a `//`
// that ends a regex (`/^prefix\//`) or sits in a string starts none, so a
// name written after it on the line is still read.
//
// Verified by mutation, in this file: the scan runs on the real tree and on a
// planted tree that must fail.
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, relative } from "node:path";
import { getBuiltinModels, getBuiltinProviders } from "@earendil-works/pi-ai/providers/all";
import ts from "typescript";
import { describe, expect, it } from "vitest";
import { leafOf, versionOf } from "@quickchatai/pi-quickreview/src/modelpick.js";
import { escapeRe } from "./helpers/source-trees.js";
import { HEAVY_TIMEOUT_MS } from "./helpers/suite-timeouts.js";

const ROOT = join(import.meta.dirname, "..");

/** pi's built-in provider ids, longest first so an id is matched whole. */
const PROVIDERS: readonly string[] = [...getBuiltinProviders()].sort(
  (a, b) => b.length - a.length || a.localeCompare(b),
);

/** The shortest leaf (c) looks at. */
const LEAF_MIN = 6;

/** The leaves of pi's catalog model ids that carry a version, lowercased. */
const MODEL_LEAVES: ReadonlySet<string> = new Set(
  PROVIDERS.flatMap((p) => getBuiltinModels(p as Parameters<typeof getBuiltinModels>[0]))
    .map((m) => leafOf(m.id))
    .filter((leaf) => leaf.length >= LEAF_MIN && versionOf(leaf) !== null),
);

const PROVIDER_RE = `(?:${PROVIDERS.map(escapeRe).join("|")})`;
const QUOTE = "[\"'`]";

/** A provider id or a model leaf, anywhere in a text. */
const MENTIONS = new RegExp(`${PROVIDER_RE}|${[...MODEL_LEAVES].map(escapeRe).join("|")}`, "i");

/** (a) and (b) for TypeScript, as `[what, pattern]`. */
const TS_PATTERNS: ReadonlyArray<[string, RegExp]> = [
  ["a provider id in a comparison", new RegExp(`[=!]==?\\s*${QUOTE}${PROVIDER_RE}${QUOTE}`, "g")],
  ["a provider id in a comparison", new RegExp(`${QUOTE}${PROVIDER_RE}${QUOTE}\\s*[=!]==?`, "g")],
  ["a provider id in a case", new RegExp(`\\bcase\\s+${QUOTE}${PROVIDER_RE}${QUOTE}\\s*:`, "g")],
  ["a provider id as a map key", new RegExp(`${QUOTE}${PROVIDER_RE}${QUOTE}\\s*:`, "g")],
  // Unquoted, as the formatter leaves a key that is an identifier: only where
  // the value is a literal, so a field that happens to share a provider's
  // name (`meta: {...}`, a type annotation) is not read as one.
  [
    "a provider id as a map key",
    new RegExp(`(?:^|[{,])\\s*${PROVIDER_RE}\\s*:\\s*(?:${QUOTE}|\\[)`, "gm"),
  ],
  ["a literal that starts with a provider id", new RegExp(`${QUOTE}${PROVIDER_RE}/`, "g")],
];

/** The same for a shell script: its comparisons, its case arms, its literals
 * and its assignments. */
const SH_PATTERNS: ReadonlyArray<[string, RegExp]> = [
  [
    "a provider id in a comparison",
    new RegExp(`!?==?\\s*["']?${PROVIDER_RE}["']?(?=\\s|\\]|$)`, "gm"),
  ],
  // A case arm starts its line: `id)`, `a|id|b)`. Prose that ends in a
  // parenthesis is not one.
  [
    "a provider id in a case",
    new RegExp(
      `^\\s*(?:["']?[\\w.*-]+["']?\\s*\\|\\s*)*["']?${PROVIDER_RE}["']?(?:\\s*\\|\\s*["']?[\\w.*-]+["']?)*\\s*\\)`,
      "gm",
    ),
  ],
  [
    "a literal that starts with a provider id",
    new RegExp(`["'=:\\s]${PROVIDER_RE}/[A-Za-z0-9@]`, "g"),
  ],
];

/**
 * TypeScript with its comments blanked, by TypeScript's own parse. A comment
 * sits in the trivia before a token, so the trivia before every token is read
 * for them; nothing inside a string, a template or a regex is looked at. Each
 * comment becomes spaces, so the lines and the columns stay where they were.
 */
function stripTsComments(text: string): string {
  const source = ts.createSourceFile("f.ts", text, ts.ScriptTarget.Latest, false, ts.ScriptKind.TS);
  const comments: ts.CommentRange[] = [];
  const walk = (node: ts.Node): void => {
    // A JSDoc node lies inside a comment: its positions are not code.
    if (node.kind >= ts.SyntaxKind.FirstJSDocNode && node.kind <= ts.SyntaxKind.LastJSDocNode)
      return;
    const children = node.getChildren(source);
    if (children.length === 0) {
      // TypeScript files the trivia's comments under two readers: those on
      // the line the trivia starts on, and those on the lines after it.
      const at = node.getFullStart();
      comments.push(...(ts.getTrailingCommentRanges(text, at) ?? []));
      comments.push(...(ts.getLeadingCommentRanges(text, at) ?? []));
    } else children.forEach(walk);
  };
  walk(source);
  let out = text;
  for (const { pos, end } of comments)
    out = out.slice(0, pos) + out.slice(pos, end).replace(/[^\n]/g, " ") + out.slice(end);
  return out;
}

/**
 * The text of every string in a TypeScript source, by TypeScript's own parse:
 * a quoted string, a template with no substitution, and each piece of a
 * template that has them. Pairing quotes by pattern is no reader: a short
 * string earlier on the line (`id === "" || id === "<leaf>"`) makes the pairs
 * fall between the strings, and the one after it is never seen.
 */
function tsLiteralTexts(text: string): string[] {
  const source = ts.createSourceFile("f.ts", text, ts.ScriptTarget.Latest, false, ts.ScriptKind.TS);
  const out: string[] = [];
  const walk = (node: ts.Node): void => {
    if (
      ts.isStringLiteralLike(node) ||
      ts.isTemplateHead(node) ||
      ts.isTemplateMiddleOrTemplateTail(node)
    )
      out.push(node.text);
    ts.forEachChild(node, walk);
  };
  walk(source);
  return out;
}

/** A shell script with its comment lines removed. */
function stripShellComments(text: string): string {
  return text
    .split("\n")
    .filter((l) => !/^\s*#/.test(l))
    .join("\n");
}

/** What the fence finds in one file's text: `what: the text that matched`. */
function modelNameHits(text: string, kind: "ts" | "sh"): string[] {
  // Every hit is a provider id or a model leaf in the code, so a text that
  // spells none anywhere has none, and is not parsed.
  if (!MENTIONS.test(text)) return [];
  const code = kind === "ts" ? stripTsComments(text) : stripShellComments(text);
  const hits = new Set<string>();
  for (const [what, re] of kind === "ts" ? TS_PATTERNS : SH_PATTERNS)
    for (const m of code.matchAll(re)) hits.add(`${what}: ${m[0].trim()}`);
  const literals =
    kind === "ts"
      ? tsLiteralTexts(text)
      : [...code.matchAll(/(["'=\s])([A-Za-z0-9@._-]{6,80})(?=["'\s]|$)/gm)].map((m) => m[2]!);
  for (const literal of literals)
    if (MODEL_LEAVES.has(literal.toLowerCase())) hits.add(`a model id as a literal: ${literal}`);
  return [...hits].sort();
}

/** Every file under `dir` with the extension, recursively, skipping `skip`. */
function filesUnder(
  dir: string,
  ext: string,
  skip: (rel: string) => boolean,
  root: string,
): string[] {
  if (!existsSync(dir)) return [];
  return readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
    const p = join(dir, e.name);
    const rel = relative(root, p);
    if (skip(rel)) return [];
    if (e.isDirectory()) return filesUnder(p, ext, skip, root);
    return e.name.endsWith(ext) && !e.name.endsWith(".d.ts") ? [p] : [];
  });
}

/** What the fence does not walk: the bench harness (its plans keep explicit
 * pins), the worker rehearsal (a recorded run), vendored code and build output. */
const SKIPPED = [
  "src/bench",
  "scripts/worker-rehearsal",
  "extensions/vendor",
  "packages/pi-plugin/dist",
  "packages/pi-plugin/assets",
  "packages/pi-plugin/node_modules",
];
const skipped = (rel: string): boolean =>
  SKIPPED.some((s) => rel === s || rel.startsWith(`${s}/`)) || rel.split("/").includes("vendor");

/** `file -> hits` for every walked file that has one, repo-relative. */
function modelNameOffenders(root: string): Record<string, string[]> {
  const out: Record<string, string[]> = {};
  const walk = (dir: string, ext: string, kind: "ts" | "sh"): void => {
    for (const f of filesUnder(join(root, dir), ext, skipped, root)) {
      const hits = modelNameHits(readFileSync(f, "utf8"), kind);
      if (hits.length > 0) out[relative(root, f)] = hits;
    }
  };
  for (const dir of [
    "src",
    "extensions",
    "packages/pi-plugin/src",
    "packages/pi-plugin/extensions",
  ])
    walk(dir, ".ts", "ts");
  for (const dir of ["docker", "scripts"]) walk(dir, ".sh", "sh");
  return out;
}

/** The files that carry a name and keep it, each with why. A name anywhere
 * else in the walked code is fixed there, never added here. */
const ALLOWLIST: Readonly<Record<string, string>> = {
  "packages/pi-plugin/src/measured.ts":
    "the measured model's id: the estimate was fitted on one model, and that fact is data. Nothing compares against it outside this file's own reader.",
  "src/onboard/steps/embeddings.ts":
    "the hosted embedder is one vendor's: the name is the embedder's own wire value, not a review model. It stays.",
};

describe("no model or provider name decides anything", () => {
  it("reads pi's own catalog: providers, and versioned model leaves", () => {
    expect(PROVIDERS.length).toBeGreaterThan(20);
    expect(MODEL_LEAVES.size).toBeGreaterThan(100);
    for (const leaf of MODEL_LEAVES) expect(leaf.length).toBeGreaterThanOrEqual(LEAF_MIN);
  });

  it("classifies the shapes", () => {
    const provider = PROVIDERS.find((p) => p.includes("-"))!;
    const leaf = [...MODEL_LEAVES][0]!;
    for (const yes of [
      `if (provider === "${provider}") return other;`,
      `if ("${provider}" !== provider) return;`,
      `if (p == '${provider}') x();`,
      `switch (p) { case "${provider}": return 1; }`,
      `const ENVS = { "${provider}": "SOME_KEY" };`,
      `const ENVS = {\n  ${PROVIDERS.find((p) => /^[a-z]+$/.test(p))!}: "SOME_KEY",\n};`,
      `const spec = "${provider}/some-model:medium";`,
      `const spec = \`${provider}/\${id}\`;`,
      `const model = "${leaf}";`,
      // MUTATION: find the TypeScript literals by pairing quotes with a
      // pattern (/(["'\`])([^"'\`\n]{6,80})\1/g over the comment-stripped text)
      // instead of tsLiteralTexts - the short string earlier on each of these
      // lines throws the pairing off and the model id is never seen; this fails.
      `if (id === "" || id === "${leaf}") return 1;`,
      `if (a === "x") return "${leaf}";`,
      `const m = ok ? "a" : fallbackTo("${leaf}");`,
      `const m = cond ? '' : pick(\`${leaf}\`);`,
      `const m = \`\${prefix}${leaf}\`;`,
      // A `//` that ends a regex, or sits in a string, starts no comment.
      `return spec.replace(/^some-prefix\\//, "${provider}/");`,
      `const url = "see // here"; const spec = "${provider}/some-model";`,
      `const n = a /* a comment */ / b; const spec = "${provider}/some-model";`,
    ])
      expect(modelNameHits(yes, "ts"), yes).not.toEqual([]);
    for (const no of [
      `// if (provider === "${provider}") return other;`,
      `/* const spec = "${provider}/some-model"; */`,
      `/**\n * The default is "${provider}/some-model".\n */\nexport const x = 1;`,
      `const x = f(1, /* "${provider}/some-model" */ 2); // "${leaf}"`,
      `const re = /^some-prefix\\//; // then "${provider}/some-model"`,
      `const label = "sign in to ${provider} first";`,
      `const providers = route.provider === other.provider;`,
      `const path = "docs/${provider}.md";`,
      `const mode = "auto";`,
      `const row = { ${PROVIDERS.find((p) => /^[a-z]+$/.test(p))!}: { tokens: 1 } };`,
      `function f(${PROVIDERS.find((p) => /^[a-z]+$/.test(p))!}: string): void {}`,
      `const text = "runs ${leaf} today";`,
    ])
      expect(modelNameHits(no, "ts"), no).toEqual([]);
    for (const yes of [
      `if [ "$provider" = "${provider}" ]; then`,
      `  ${provider}) twin=other ;;`,
      `  other|${provider}) twin=other ;;`,
      `MODEL="${provider}/some-model"`,
      `MODEL=${provider}/some-model`,
      `MODEL="${leaf}"`,
    ])
      expect(modelNameHits(yes, "sh"), yes).not.toEqual([]);
    for (const no of [
      `# if [ "$provider" = "${provider}" ]; then`,
      `echo "no model credential"`,
      `  die "bump both (the config and the image ${provider})"`,
    ])
      expect(modelNameHits(no, "sh"), no).toEqual([]);
  });

  it("fails on a planted provider comparison, a planted spec and a planted model id", () => {
    const provider = PROVIDERS.find((p) => p.includes("-"))!;
    const leaf = [...MODEL_LEAVES][0]!;
    const root = mkdtempSync(join(tmpdir(), "modelnames-fence-"));
    const plant = (rel: string, text: string): void => {
      mkdirSync(dirname(join(root, rel)), { recursive: true });
      writeFileSync(join(root, rel), text);
    };
    try {
      plant("extensions/login-route.ts", `if (provider === "${provider}") return "other";\n`);
      plant("packages/pi-plugin/src/defaults.ts", `export const M = "${provider}/x:medium";\n`);
      plant("src/price.ts", `export const MEASURED = "${leaf}";\n`);
      plant("docker/entrypoint.sh", `case "$p" in\n  ${provider}) twin=x ;;\nesac\n`);
      plant("src/clean.ts", `export const provider = route.provider;\n`);
      // Not walked: the bench harness, vendored code, a rehearsal.
      plant("src/bench/plan.ts", `export const M = "${provider}/x";\n`);
      plant("extensions/vendor/x/index.ts", `export const M = "${provider}/x";\n`);
      plant("scripts/worker-rehearsal/run.sh", `MODEL="${provider}/x"\n`);
      expect(Object.keys(modelNameOffenders(root)).sort()).toEqual([
        "docker/entrypoint.sh",
        "extensions/login-route.ts",
        "packages/pi-plugin/src/defaults.ts",
        "src/price.ts",
      ]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  // MUTATION: add `if (provider === "openai-codex") return "openai";` to
  // extensions/login-route.ts — this fails. Remove the last name from a file
  // that is on the allowlist and leave its entry — this fails too. Strip
  // comments by pattern again (a line comment at any `//` not after a quote or
  // a colon) — a literal after a regex that ends in `\//` reads clean, and the
  // shapes case above (the `replace` row) fails.
  it(
    "holds on the tree: exactly the allowlisted files carry a name",
    { timeout: HEAVY_TIMEOUT_MS },
    () => {
      const offenders = modelNameOffenders(ROOT);
      expect(Object.keys(offenders).sort(), JSON.stringify(offenders, null, 2)).toEqual(
        Object.keys(ALLOWLIST).sort(),
      );
      for (const [file, reason] of Object.entries(ALLOWLIST))
        expect(reason.trim().length, `${file} needs a reason`).toBeGreaterThan(20);
    },
  );
});
