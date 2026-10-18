// The host route's isolation: what `qcr review` gives pi so that nothing of
// the operator's own pi home, the qcr checkout or the reviewed repo reaches
// the review session or its lens children.
//
// A run gets
//  - a private agent dir (`<run>/agent`, replacing ~/.pi/agent): a
//    refresh-disabled copy of the operator's login (src/piauthcopy.ts), a
//    settings.json in the bench's style that registers bash-guard GLOBALLY
//    (lens children load only global extensions) and carries the project
//    settings the clone used to inherit from `<root>/.pi/settings.json`, and
//    the lens agents built into `<agent>/agents` (the user scope). It holds no
//    context file, no extension and no skill;
//  - a cwd of its own: the run's `out` dir, outside every checkout, holding a
//    copy of the reviewer stub as AGENTS.override.md. pi loads the first
//    context file of the cwd and of every ancestor, so the stub is the only
//    one, and the full AGENTS.md the qcr checkout carries (the companion's
//    guide) is never shadowed by a file written there.
//
// The stub is written nowhere else: never into the qcr checkout, never into
// the reviewed repo (the D34 ruling; asserted by
// tests/context-files.test.ts and tests/host-isolation.test.ts).
import {
  chmodSync,
  copyFileSync,
  existsSync,
  mkdirSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { dirname, join, relative, resolve, isAbsolute } from "node:path";
import type { Config } from "./config.js";
import { buildBenchAgents } from "./bench/runner.js";
import { benchSettings } from "./bench/auth.js";
import { copyPiAuth } from "./piauthcopy.js";

/** The reviewer stub, relative to the production tree. */
export const REVIEWER_STUB = join("deploy", "reviewer", "AGENTS.override.md");

/** The name pi loads it under from the cwd (first of its candidates). */
export const HOST_CONTEXT_STUB = "AGENTS.override.md";

/** pi's candidates in one directory, in the order it tries them. */
const CONTEXT_CANDIDATES = [
  "AGENTS.override.md",
  "AGENTS.md",
  "AGENTS.MD",
  "CLAUDE.md",
  "CLAUDE.MD",
] as const;

/** pi's idle timeout for a model stream: the production project setting
 * (`.pi/settings.json`), which the host route's cwd no longer carries.
 * tests/host-isolation.test.ts pins it to that file. */
export const HOST_HTTP_IDLE_TIMEOUT_MS = 120_000;

/** The private agent dir's settings.json. */
export function hostSettings(root: string): string {
  const base = JSON.parse(benchSettings(root).settings) as Record<string, unknown>;
  return JSON.stringify({ ...base, httpIdleTimeoutMs: HOST_HTTP_IDLE_TIMEOUT_MS }, null, 2) + "\n";
}

export interface HostRun {
  /** pi's agent dir for the run: the private one. */
  agentDir: string;
  /** Where pi runs: the run's out dir, holding the stub. */
  cwd: string;
  /** Context files in an ancestor of `cwd`: pi would load them too. */
  strayContext: string[];
}

const isInside = (child: string, parent: string): boolean => {
  const rel = relative(parent, child);
  return rel === "" || (!rel.startsWith("..") && !isAbsolute(rel));
};

/** The path with symlinks resolved as far as it exists. */
const real = (p: string): string => {
  const abs = resolve(p);
  try {
    return realpathSync(abs);
  } catch {
    const parent = dirname(abs);
    return parent === abs ? abs : join(real(parent), relative(parent, abs));
  }
};

/** Every ancestor of `dir` that carries a context file. */
export function ancestorContextFiles(dir: string): string[] {
  const hits: string[] = [];
  let d = resolve(dir);
  for (;;) {
    const parent = dirname(d);
    if (parent === d) break;
    d = parent;
    const file = CONTEXT_CANDIDATES.find((n) => existsSync(join(d, n)));
    if (file) hits.push(join(d, file));
  }
  return hits;
}

/** The working tree `dir` stands in: its nearest ancestor with a `.git`. */
function checkoutOf(dir: string): string {
  let d = real(dir);
  for (;;) {
    if (existsSync(join(d, ".git"))) return d;
    const parent = dirname(d);
    if (parent === d) return real(dir);
    d = parent;
  }
}

/**
 * Prepare one run's private agent dir and cwd. Throws `AuthExpiring`
 * (src/piauthcopy.ts) when the operator's login would expire inside `needMs`,
 * and a plain Error when the cwd would sit inside a checkout. `srcAgentDir` is
 * only read.
 */
export function prepareHostRun(o: {
  root: string;
  /** The operator's pi agent dir (its login). Read, never written. */
  srcAgentDir: string;
  /** Where the private agent dir goes: `<runDir>/agent`. */
  agentDir: string;
  /** The run's out dir: pi's cwd. */
  cwd: string;
  cfg: Config;
  needMs: number;
  /** Checkouts the cwd must stay out of: the qcr tree, the reviewed repo. */
  checkouts: readonly string[];
  now?: () => number;
}): HostRun {
  const cwd = resolve(o.cwd);
  for (const c of [o.root, ...o.checkouts])
    if (isInside(real(cwd), checkoutOf(c)))
      throw new Error(`the run directory ${cwd} is inside the checkout ${c}`);
  rmSync(o.agentDir, { recursive: true, force: true });
  mkdirSync(o.agentDir, { recursive: true, mode: 0o700 });
  const auth = join(o.srcAgentDir, "auth.json");
  if (existsSync(auth)) {
    copyPiAuth({
      srcDir: o.srcAgentDir,
      dstDir: o.agentDir,
      needMs: o.needMs,
      ...(o.now ? { now: o.now } : {}),
      words: {
        missing: (src) => `no pi login at ${src} — run \`qcr scan login\` first`,
        expiring: ({ expiresAt, needMs }) =>
          `your pi login expires at ${new Date(expiresAt).toISOString()}, inside this review's ${Math.round(needMs / 60_000)}-minute budget. ` +
          "A review never refreshes it (that would rotate the login pi itself holds). Use pi once (`qcr scan login`) so it refreshes its own login, then run again.",
      },
    });
  } else {
    // No login: an API key in the environment is the route (as the bench's).
    writeFileSync(join(o.agentDir, "auth.json"), "{}\n", { mode: 0o600 });
    chmodSync(join(o.agentDir, "auth.json"), 0o600);
  }
  // Custom providers the operator configured stay usable; nothing else of the
  // operator's pi home (extensions, skills, prompts, settings) is carried.
  const models = join(o.srcAgentDir, "models.json");
  if (existsSync(models)) {
    copyFileSync(models, join(o.agentDir, "models.json"));
    chmodSync(join(o.agentDir, "models.json"), 0o600);
  }
  writeFileSync(join(o.agentDir, "settings.json"), hostSettings(o.root));
  // The lens agents, for the user scope (QCR_SUBAGENT_SCOPE=user): lens
  // children run in the parent's cwd and resolve them through the inherited
  // agent dir.
  buildBenchAgents(o.root, o.cfg, join(o.agentDir, "agents"));
  mkdirSync(cwd, { recursive: true });
  copyFileSync(join(o.root, REVIEWER_STUB), join(cwd, HOST_CONTEXT_STUB));
  return { agentDir: o.agentDir, cwd, strayContext: ancestorContextFiles(cwd) };
}
