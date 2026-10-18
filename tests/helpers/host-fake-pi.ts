// A fake `pi` that models what pi 1.3.0 would DISCOVER, and records it.
//
// No network, no model: a node script behind a shell wrapper. Given pi's argv,
// cwd and environment it works out, the way pi's resource loader does
// (dist/core/resource-loader.js, package-manager.js, the subagent example's
// agents.ts — pinned 1.3.0):
//  - extensions: the explicit `-e`/`--extension` paths; unless `-ne`, also the
//    global settings' `extensions` (minus the `-`-prefixed disables), the
//    agentDir's `extensions/` and the cwd's `.pi/extensions/` (every project
//    is trusted: `defaultProjectTrust = "always"`);
//  - context files: the agentDir's, the cwd's and every ancestor's first of
//    AGENTS.override.md / AGENTS.md / AGENTS.MD / CLAUDE.md / CLAUDE.MD,
//    unless `-nc` (only ancestors under `floor`, so a developer's own ~/AGENTS.md
//    never leaks into a result);
//  - skills: the agentDir's, the cwd's `.pi/skills`, every ancestor's
//    `.agents/skills` and `$HOME/.agents/skills`, unless `-ns`;
//  - settings: the global settings.json merged under the cwd's `.pi/settings.json`;
//  - lens agents: `<agentDir>/agents` for QCR_SUBAGENT_SCOPE=user, the nearest
//    `.pi/agents` above the cwd for "project".
// Then, like extensions/subagents.ts does, it spawns a lens CHILD of itself
// (`--mode json -p --no-session`, no `-ne`, the parent's cwd and environment)
// that records the same. The main run leaves the files a review round must.
import { chmodSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

export interface HostPiRecord {
  argv: string[];
  cwd: string;
  /** PI_CODING_AGENT_DIR as pi saw it. */
  agentDir: string;
  env: Record<string, string>;
  extensions: string[];
  contextFiles: Array<{ path: string; text: string }>;
  skills: string[];
  settings: Record<string, unknown>;
  /** QCR_SUBAGENT_SCOPE as pi saw it. */
  scope: string;
  /** Each lens name → the agent file it resolves to, or null (`Unknown agent`). */
  agents: Record<string, string | null>;
  /** The agentDir's auth.json, as pi saw it. */
  auth: string | null;
}

const SCRIPT = String.raw`
import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
const CFG = __CFG__;
const argv = process.argv.slice(2);
const isChild = argv.includes("--no-session") && !argv.includes("--session-dir");
const cwd = fs.realpathSync(process.cwd());
const agentDir = process.env.PI_CODING_AGENT_DIR ?? "";
const readJson = (p) => { try { return JSON.parse(fs.readFileSync(p, "utf8")); } catch { return null; } };
const isFile = (p) => { try { return fs.statSync(p).isFile(); } catch { return false; } };
const isDir = (p) => { try { return fs.statSync(p).isDirectory(); } catch { return false; } };
const list = (d) => { try { return fs.readdirSync(d).sort().map((n) => path.join(d, n)); } catch { return []; } };
const values = (flags) => argv.flatMap((a, i) => (flags.includes(a) && argv[i + 1] ? [argv[i + 1]] : []));
const has = (...f) => f.some((x) => argv.includes(x));

const settings = readJson(path.join(agentDir, "settings.json")) ?? {};
const project = readJson(path.join(cwd, ".pi", "settings.json")) ?? {};

const extensions = [...values(["--extension", "-e"])];
if (!has("-ne", "--no-extensions")) {
  for (const e of settings.extensions ?? []) if (!String(e).startsWith("-")) extensions.push(e);
  for (const d of [path.join(agentDir, "extensions"), path.join(cwd, ".pi", "extensions")])
    extensions.push(...list(d));
}

const CANDIDATES = ["AGENTS.override.md", "AGENTS.md", "AGENTS.MD", "CLAUDE.md", "CLAUDE.MD"];
const fromDir = (d) => { const n = CANDIDATES.find((c) => isFile(path.join(d, c))); return n ? path.join(d, n) : null; };
const contextFiles = [];
if (!has("-nc", "--no-context-files")) {
  const g = fromDir(agentDir);
  if (g) contextFiles.push(g);
  const anc = [];
  for (let d = cwd; ; d = path.dirname(d)) {
    const f = fromDir(d);
    if (f && !contextFiles.includes(f)) anc.unshift(f);
    if (d === CFG.floor || path.dirname(d) === d) break;
  }
  contextFiles.push(...anc);
}

const skills = [];
if (!has("-ns", "--no-skills")) {
  const dirs = [path.join(agentDir, "skills"), path.join(cwd, ".pi", "skills"), path.join(process.env.HOME ?? "", ".agents", "skills")];
  for (let d = cwd; ; d = path.dirname(d)) {
    dirs.push(path.join(d, ".agents", "skills"));
    if (d === CFG.floor || path.dirname(d) === d) break;
  }
  for (const d of new Set(dirs)) skills.push(...list(d).filter(isDir));
}

const scope = process.env.QCR_SUBAGENT_SCOPE ?? "user";
let agentsDir = null;
if (scope === "user") agentsDir = path.join(agentDir, "agents");
else for (let d = cwd; ; d = path.dirname(d)) {
  if (isDir(path.join(d, ".pi", "agents"))) { agentsDir = path.join(d, ".pi", "agents"); break; }
  if (path.dirname(d) === d) break;
}
const agents = {};
for (const n of CFG.lenses) {
  const f = agentsDir ? path.join(agentsDir, n + ".md") : null;
  agents[n] = f && isFile(f) ? f : null;
}

const rec = {
  argv, cwd, agentDir, env: process.env, scope, agents,
  extensions: extensions.map((e) => path.resolve(e)),
  contextFiles: contextFiles.map((p) => ({ path: p, text: fs.readFileSync(p, "utf8") })),
  skills, settings: { ...settings, ...project },
  auth: isFile(path.join(agentDir, "auth.json")) ? fs.readFileSync(path.join(agentDir, "auth.json"), "utf8") : null,
};
fs.writeFileSync(CFG.rec + (isChild ? ".child.json" : ".json"), JSON.stringify(rec));
if (isChild) process.exit(0);

fs.readFileSync(0);
if (CFG.child) spawnSync(process.execPath, [process.argv[1], "--mode", "json", "-p", "--no-session"], { env: process.env, cwd: process.cwd(), stdio: "ignore" });
let sd = "";
argv.forEach((a, i) => { if (a === "--session-dir") sd = argv[i + 1]; });
fs.mkdirSync(sd, { recursive: true });
fs.writeFileSync(path.join(sd, "s.jsonl"), '{"type":"session"}\n');
const out = path.dirname(sd);
console.log('{"type":"message_end","message":{"role":"assistant","usage":{"input":1,"output":1,"cost":{"total":0.01}}}}');
fs.writeFileSync(path.join(out, "findings-record.json"), JSON.stringify({ findings: [], verdict: "APPROVE" }));
fs.writeFileSync(path.join(out, "outcome.json"), JSON.stringify({ verdict: "APPROVE", passes: [] }));
`;

/** Write the fake into `dir`; `read()` gives what the main run and its lens
 * child recorded. `floor` is the highest directory whose context files and
 * `.agents/skills` count; `lenses` the planned lens names to resolve. */
export function hostFakePi(
  dir: string,
  name: string,
  o: { floor: string; lenses: readonly string[]; child?: boolean },
): { bin: string; read: () => { main: HostPiRecord; child: HostPiRecord | null } } {
  const rec = join(dir, `${name}.rec`);
  const script = join(dir, `${name}-pi.mjs`);
  const bin = join(dir, `${name}-pi`);
  const cfg = JSON.stringify({ rec, floor: o.floor, lenses: o.lenses, child: o.child !== false });
  writeFileSync(
    script,
    SCRIPT.replace("__CFG__", () => cfg),
  );
  writeFileSync(
    bin,
    `#!/bin/sh\nexec ${JSON.stringify(process.execPath)} ${JSON.stringify(script)} "$@"\n`,
  );
  chmodSync(bin, 0o755);
  return {
    bin,
    read: () => {
      const load = (p: string): HostPiRecord => JSON.parse(readFileSync(p, "utf8")) as HostPiRecord;
      return {
        main: load(`${rec}.json`),
        child: existsSync(`${rec}.child.json`) ? load(`${rec}.child.json`) : null,
      };
    },
  };
}
