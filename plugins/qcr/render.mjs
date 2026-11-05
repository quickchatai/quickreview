#!/usr/bin/env node
// The one skill source (plugins/qcr/templates/), rendered for every host and
// for the pi Plugin.
//
// A template holds one command: a shared description, a pi body (it hands
// the person the `/qcr-…` line to type) and a host body (it runs `qcr`). A
// render fills in, per target, the command's name (namespaced `review` or
// bare `qcr-review`), the invoke spelling, the package version (the pinned
// `npx` line and every manifest's version), the contract number and the
// host's own note, and lays the files out the way that host reads them.
//
// `render` is pure and dependency-free, so the Plugin's prepack runs it with
// no build of the App, and the App's installer imports it from the installed
// package (plugins/ ships in the App's `files`). `loadSource` is the one
// reader of the templates; `writeRendered` and `renderedDiff` are the one
// writer and checker of a rendered tree.
//
// `node plugins/qcr/render.mjs pi` renders the Plugin's skills/ into
// packages/pi-plugin and checks the copy against the render; `--check` only
// checks. `node plugins/qcr/render.mjs <host> --out DIR` renders a host's
// folder into an empty DIR.
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));

/** The plugin's name: the namespace on every namespaced host. */
export const PLUGIN_NAME = "qcr";

/** The local marketplace's name, the `@…` in `qcr@quickreview-local`. */
export const MARKETPLACE_NAME = "quickreview-local";

/** The package a host body falls back to through `npx`. */
export const APP_PACKAGE = "@quickchatai/quickreview";

/** The host-plugin contract the templates are written for: the N of
 * `qcr --schema N`. */
export const TEMPLATE_CONTRACT = 1;

/** Every command a host plugin or the Plugin may carry, in render order.
 * Only those with a template are rendered. */
export const COMMANDS = Object.freeze(["review", "scan", "setup", "selfimprove"]);

/** The coding-agent CLIs other than pi. */
export const HOSTS = Object.freeze([
  "claude",
  "codex",
  "copilot",
  "cursor",
  "opencode",
  "gemini",
  "antigravity",
]);

/** Everything a render can target: every host, and pi. */
export const TARGETS = Object.freeze([...HOSTS, "pi"]);

// Namespaced targets show a command under the plugin's name (`qcr:review`);
// bare ones show its own name, so the name carries the prefix (`qcr-review`).
const NAMESPACED = new Set(["claude", "codex", "gemini", "antigravity"]);
// Codex runs a skill by mention, never by slash.
const SIGIL = { codex: "$" };

/** The name `target` shows `command` under. */
export function commandName(target, command) {
  checkTarget(target);
  if (!COMMANDS.includes(command)) throw new Error(`render: unknown command ${command}`);
  return NAMESPACED.has(target) ? command : `${PLUGIN_NAME}-${command}`;
}

/** What the person types in `target` to run `command`. */
export function invokeSpelling(target, command) {
  const name = commandName(target, command);
  const sigil = SIGIL[target] ?? "/";
  return NAMESPACED.has(target) ? `${sigil}${PLUGIN_NAME}:${name}` : `${sigil}${name}`;
}

/** The names table: per target, per command, its name and invoke spelling. */
export const NAMES = Object.freeze(
  Object.fromEntries(
    TARGETS.map((t) => [
      t,
      Object.freeze(
        Object.fromEntries(
          COMMANDS.map((c) => [
            c,
            Object.freeze({ name: commandName(t, c), invoke: invokeSpelling(t, c) }),
          ]),
        ),
      ),
    ]),
  ),
);

function checkTarget(target) {
  if (!TARGETS.includes(target)) throw new Error(`render: unknown target ${target}`);
}

// ---- the source -----------------------------------------------------------------

const TEMPLATE_RE =
  /^---\ndescription: ([^\n]+)\n---\n\n<!-- pi -->\n\n([\s\S]+?)\n<!-- host -->\n\n([\s\S]+)$/;

/** One template file's text as its description and its two bodies. */
export function parseTemplate(text, label = "template") {
  const m = TEMPLATE_RE.exec(text);
  if (!m)
    throw new Error(
      `render: ${label} is not "---\\ndescription: …\\n---", then <!-- pi --> and <!-- host --> bodies`,
    );
  const description = m[1].trim();
  // a plain YAML scalar, as a skill's front matter carries it: ": " or " #"
  // would end it early, and a leading indicator would change its type
  if (/: | #|^[-?:,[\]{}#&*!|>'"%@`]/.test(description))
    throw new Error(`render: ${label}'s description is not a plain YAML scalar`);
  return { description, pi: m[2].trimEnd() + "\n", host: m[3].trimEnd() + "\n" };
}

const mdFiles = (dir) =>
  existsSync(dir)
    ? readdirSync(dir)
        .filter((f) => f.endsWith(".md"))
        .sort()
    : [];

/** The skill source under `dir` (default: beside this module): each
 * command's template, the partials and the host notes. */
export function loadSource(dir = join(HERE, "templates")) {
  const commands = {};
  for (const f of readdirSync(dir).sort()) {
    if (f === "partials" || f === "notes" || f === "plugin.txt") continue;
    const command = f.replace(/\.md$/, "");
    if (!f.endsWith(".md") || !COMMANDS.includes(command))
      throw new Error(`render: ${f} in the templates names no command`);
    commands[command] = parseTemplate(readFileSync(join(dir, f), "utf8"), f);
  }
  const partials = {};
  for (const f of mdFiles(join(dir, "partials")))
    partials[f.slice(0, -3)] = readFileSync(join(dir, "partials", f), "utf8").trimEnd() + "\n";
  const notes = {};
  for (const f of mdFiles(join(dir, "notes"))) {
    const host = f.slice(0, -3);
    if (!HOSTS.includes(host)) throw new Error(`render: notes/${f} names no host`);
    notes[host] = readFileSync(join(dir, "notes", f), "utf8").trimEnd() + "\n";
  }
  const description = readFileSync(join(dir, "plugin.txt"), "utf8").trim();
  return { description, commands, partials, notes };
}

// ---- the render -----------------------------------------------------------------

const VERSION_RE = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/;

/** `text` with every placeholder filled for `target`. A placeholder this
 * renderer does not know, or one left over, throws. */
function expand(source, text, target, ctx) {
  let out = text.replace(/\{\{include:([a-z0-9-]+)\}\}/g, (_, name) => {
    const partial = source.partials[name];
    if (partial === undefined) throw new Error(`render: no partial ${name}`);
    if (partial.includes("{{include:")) throw new Error(`render: partial ${name} includes`);
    return partial.trimEnd();
  });
  const note = target === "pi" ? undefined : source.notes[target];
  if (out.split("{{host-note}}").length - 1 !== (out.includes("{{host-note}}\n\n") ? 1 : 0))
    throw new Error("render: {{host-note}} stands on a line of its own, once, before a blank line");
  out = out.replace("{{host-note}}\n\n", note === undefined ? "" : `${note.trimEnd()}\n\n`);
  out = out.replace(/\{\{([a-z]+)(?::([a-z]+))?\}\}/g, (all, key, arg) => {
    if (key === "version" && arg === undefined) return ctx.version;
    if (key === "schema" && arg === undefined) return String(ctx.contract);
    if (key === "npx" && arg === undefined) return `npx -y ${APP_PACKAGE}@${ctx.version}`;
    if (key === "invoke" && COMMANDS.includes(arg)) return invokeSpelling(target, arg);
    if (key === "name" && COMMANDS.includes(arg)) return commandName(target, arg);
    throw new Error(`render: unknown placeholder ${all}`);
  });
  if (out.includes("{{"))
    throw new Error(
      `render: a placeholder is left in ${JSON.stringify(out.slice(out.indexOf("{{"), out.indexOf("{{") + 40))}`,
    );
  return out;
}

const json = (value) => `${JSON.stringify(value, null, 2)}\n`;

const skillFile = (name, description, body) =>
  `---\nname: ${name}\ndescription: ${description}\n---\n\n${body}`;

/** A Gemini command: TOML with the body as a literal string, which Gemini
 * reads as the prompt (the typed arguments are appended to it). */
function geminiCommand(description, body, label) {
  if (body.includes("'''"))
    throw new Error(`render: ${label} holds ''' and cannot be a TOML literal`);
  // Gemini expands these in a command's prompt; a body must not trip them
  if (/\{\{|!\{|@\{/.test(body)) throw new Error(`render: ${label} holds a Gemini prompt marker`);
  return `description = ${JSON.stringify(description)}\nprompt = '''\n${body}'''\n`;
}

/**
 * The files `target` reads, as `{ relative path: content }`, rendered from
 * `source` (see `loadSource`) at `version` for contract `contract`.
 *
 * - claude, codex, copilot: a local marketplace at the root naming the plugin
 *   in `qcr/`, which holds the host's manifest and `skills/<name>/SKILL.md`;
 * - cursor: `.cursor-plugin/plugin.json` and the skills, the folder itself;
 * - opencode: the skills alone (it has no plugin manifest);
 * - gemini: `gemini-extension.json` and `commands/qcr/<command>.toml`;
 * - antigravity: `plugin.json` and the skills;
 * - pi: the Plugin's `skills/qcr-<command>/SKILL.md`, from the pi bodies.
 */
export function render(source, target, { version, contract }) {
  checkTarget(target);
  if (typeof version !== "string" || !VERSION_RE.test(version))
    throw new Error(`render: ${JSON.stringify(version)} is not a package version`);
  if (!Number.isInteger(contract) || contract < 1)
    throw new Error(`render: ${JSON.stringify(contract)} is not a contract number`);
  const ctx = { version, contract };
  const commands = COMMANDS.filter((c) => source.commands[c] !== undefined);
  const files = {};
  const plugin = { name: PLUGIN_NAME, version, description: source.description };
  const marketplace = {
    name: MARKETPLACE_NAME,
    owner: { name: "QuickReview" },
    plugins: [
      { name: PLUGIN_NAME, source: `./${PLUGIN_NAME}`, description: source.description, version },
    ],
  };
  const body = (c) =>
    expand(source, source.commands[c][target === "pi" ? "pi" : "host"], target, ctx);
  const skills = (prefix) => {
    for (const c of commands) {
      const name = commandName(target, c);
      files[`${prefix}skills/${name}/SKILL.md`] = skillFile(
        name,
        source.commands[c].description,
        body(c),
      );
    }
  };
  switch (target) {
    case "claude":
      files[".claude-plugin/marketplace.json"] = json(marketplace);
      files["qcr/.claude-plugin/plugin.json"] = json(plugin);
      skills("qcr/");
      break;
    case "codex":
      // Codex reads a Claude-format marketplace file beside its own manifest
      files[".claude-plugin/marketplace.json"] = json(marketplace);
      files["qcr/.codex-plugin/plugin.json"] = json(plugin);
      skills("qcr/");
      break;
    case "copilot":
      files[".github/plugin/marketplace.json"] = json(marketplace);
      files["qcr/.github/plugin/plugin.json"] = json(plugin);
      skills("qcr/");
      break;
    case "cursor":
      files[".cursor-plugin/plugin.json"] = json(plugin);
      skills("");
      break;
    case "opencode":
      skills("");
      break;
    case "gemini":
      files["gemini-extension.json"] = json(plugin);
      for (const c of commands)
        files[`commands/${PLUGIN_NAME}/${commandName(target, c)}.toml`] = geminiCommand(
          source.commands[c].description,
          body(c),
          c,
        );
      break;
    case "antigravity":
      // its manifest admits no key beyond name, description and $schema, so
      // the version rides in the description
      files["plugin.json"] = json({
        name: PLUGIN_NAME,
        description: `${source.description} Release ${version}.`,
      });
      skills("");
      break;
    case "pi":
      skills("");
      break;
  }
  return Object.fromEntries(Object.entries(files).sort(([a], [b]) => (a < b ? -1 : 1)));
}

// ---- writing and checking a rendered tree ------------------------------------------

/** Every file under `dir`, relative to it, sorted; empty when it is missing. */
function filesUnder(dir, rel = "") {
  const at = rel ? join(dir, rel) : dir;
  if (!existsSync(at)) return [];
  return readdirSync(at, { withFileTypes: true })
    .sort((a, b) => (a.name < b.name ? -1 : 1))
    .flatMap((e) => {
      const r = rel ? `${rel}/${e.name}` : e.name;
      return e.isDirectory() ? filesUnder(dir, r) : [r];
    });
}

/** How the tree under `dir` (only the files under `within`, when given)
 * differs from `files`: the paths missing, changed or extra. Empty when the
 * tree is exactly the render. */
export function renderedDiff(files, dir, within = "") {
  const want = Object.keys(files).filter((p) => p.startsWith(within));
  const have = filesUnder(dir, within.replace(/\/$/, "")).filter((p) => p.startsWith(within));
  const problems = [];
  for (const p of want) {
    if (!existsSync(join(dir, p))) problems.push(`missing ${p}`);
    else if (readFileSync(join(dir, p), "utf8") !== files[p]) problems.push(`changed ${p}`);
  }
  for (const p of have) if (!(p in files)) problems.push(`extra ${p}`);
  return problems;
}

/** Write `files` under `dir`, replacing `within` (a directory of the
 * render, such as `skills/`) whole when given, then check the tree against
 * the render. */
export function writeRendered(files, dir, within = "") {
  if (within) rmSync(join(dir, within), { recursive: true, force: true });
  for (const [p, content] of Object.entries(files)) {
    mkdirSync(dirname(join(dir, p)), { recursive: true });
    writeFileSync(join(dir, p), content);
  }
  const problems = renderedDiff(files, dir, within);
  if (problems.length > 0)
    throw new Error(`render: the written tree differs: ${problems.join(", ")}`);
}

/** The package version beside this module: the App's in an install and in
 * the checkout (the Plugin's equals it). */
export function packageVersion() {
  return JSON.parse(readFileSync(join(HERE, "..", "..", "package.json"), "utf8")).version;
}

// `node plugins/qcr/render.mjs <target> [--out DIR] [--check]`; importing
// this module does nothing.
if (process.argv[1] && resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url))) {
  const args = process.argv.slice(2);
  const target = args[0];
  const check = args.includes("--check");
  const outAt = args.indexOf("--out");
  const out =
    outAt >= 0
      ? resolve(args[outAt + 1] ?? "")
      : target === "pi"
        ? join(HERE, "..", "..", "packages", "pi-plugin")
        : "";
  try {
    if (!TARGETS.includes(target ?? ""))
      throw new Error(`usage: render.mjs <${TARGETS.join("|")}> [--out DIR] [--check]`);
    if (out === "" || (outAt >= 0 && args[outAt + 1] === undefined))
      throw new Error("render: a host needs --out DIR");
    const files = render(loadSource(), target, {
      version: packageVersion(),
      contract: TEMPLATE_CONTRACT,
    });
    // the Plugin's skills/ is the render's alone; a host's folder must start empty
    const within = target === "pi" ? "skills/" : "";
    if (check) {
      const problems = renderedDiff(files, out, within);
      if (problems.length > 0)
        throw new Error(
          `render: ${out} is stale (${problems.join(", ")}); run render.mjs ${target}`,
        );
    } else {
      if (within === "" && filesUnder(out).length > 0)
        throw new Error(`render: ${out} is not empty`);
      writeRendered(files, out, within);
    }
  } catch (err) {
    process.stderr.write(`${err instanceof Error ? err.message : String(err)}\n`);
    process.exit(1);
  }
}
