// The host route's isolation: what `qcr review` gives pi so that nothing of
// the operator's own pi home, the qcr checkout or the reviewed repo reaches
// the review session or its lens children.
//
// A run gets
//  - a private agent dir (`<run>/agent`, replacing ~/.pi/agent): a
//    refresh-disabled copy of the operator's login (src/engine/auth.ts), a
//    settings.json in the bench's style without an `extensions` entry (the SDK
//    host discovers none; every lens session gets bash-guard as a factory,
//    src/engine/lens/runlens.ts) that carries the project settings the clone
//    used to inherit from `<root>/.pi/settings.json`, and
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
import { dirname, join, relative, resolve } from "node:path";
import { isInside } from "./pathinside.js";
import type { Config } from "./config.js";
import type { CoreConfig } from "./reviewconfig.js";
import { buildBenchAgents } from "./bench/runner.js";
import { benchSettings } from "./bench/auth.js";
import { copyPiAuth } from "./engine/auth.js";
import type { ProfileLookup } from "./profiles.js";
import { HOST_CONTEXT_STUB, REVIEWER_STUB, reviewerStubSource } from "./reviewerstub.js";

// The two names live in a neutral module (the bot worker imports them without this file's closure).
export { HOST_CONTEXT_STUB, REVIEWER_STUB };

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

/** The private agent dir's settings.json: what the SDK host reads from it (the
 * durable retry, the idle timeout) and the trust default. No `extensions`
 * entry: the SDK host discovers none (src/engine/pisdk.ts), so neither the
 * guard nor pi's built-ins (src/pibuiltins.ts) are loaded from settings. Every
 * lens session gets the guard as a factory (src/engine/lens/runlens.ts). */
export function hostSettings(root: string): string {
  const { extensions: _discovered, ...base } = JSON.parse(benchSettings(root).settings) as Record<
    string,
    unknown
  >;
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
 * (src/engine/auth.ts) when the operator's login would expire inside `needMs`,
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
  cfg: CoreConfig;
  needMs: number;
  /** Checkouts the cwd must stay out of: the qcr tree, the reviewed repo. */
  checkouts: readonly string[];
  /** A profile's replacements for the lens agents (src/profileoverrides.ts). */
  profile?: { readFile?: (path: string) => string; lookup?: ProfileLookup };
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
  // The lens agents, for the user scope (QCR_SUBAGENT_SCOPE=user): the lens
  // tool reads them from the agent dir's `agents`.
  // The agents build types the app's whole Config; it reads only the review sections.
  buildBenchAgents(o.root, o.cfg as Config, join(o.agentDir, "agents"), o.profile);
  mkdirSync(cwd, { recursive: true });
  copyFileSync(reviewerStubSource(o.root), join(cwd, HOST_CONTEXT_STUB));
  return { agentDir: o.agentDir, cwd, strayContext: ancestorContextFiles(cwd) };
}
