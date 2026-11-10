// One review run's isolation from everything of the caller's: what a host
// gives pi so that nothing of the operator's own pi home, the asset tree or
// the reviewed repo reaches the review session or its lens children. The
// review API's `prepareHost` port (packages/pi-plugin/src/reviewapi.ts) is this, with the host's
// own words for a refused login (`qcr review`'s: src/hostroute.ts).
//
// A run gets
//  - a private agent dir (`<run>/agent`, replacing ~/.pi/agent): a
//    refresh-disabled copy of the operator's login (packages/pi-plugin/src/engine/auth.ts),
//    or no login file at all when the host hands its sessions the borrowed
//    login in memory (`auth: "injected"`), a
//    settings.json in the bench's style without an `extensions` entry (the SDK
//    host discovers none; every lens session gets bash-guard as a factory,
//    packages/pi-plugin/src/engine/lens/runlens.ts) that carries the project settings the clone
//    used to inherit from `<root>/.pi/settings.json`, and
//    the lens agents built into `<agent>/agents` (the user scope). It holds no
//    context file, no extension and no skill;
//    Beside them sit the two catalog files of the operator's pi (below);
//  - a cwd of its own: the run's `out` dir, outside every checkout, holding a
//    copy of the reviewer stub as AGENTS.override.md. pi loads the first
//    context file of the cwd and of every ancestor, so the stub is the only
//    one, and the full AGENTS.md the asset tree carries is never shadowed by a
//    file written there.
//
// The stub is written nowhere else: never into the asset tree, never into
// the reviewed repo (the reviewer-stub ruling; asserted by
// tests/context-files.test.ts and tests/host-isolation.test.ts).
//
// One catalog. A host over a private agent dir gets the two catalog files of
// the pi home it borrows from: `models.json` (the providers the person
// configured) and `models-store.json` (the models pi learned since its build,
// which the host restores offline). With both, the host names the same models
// the person's own pi names, so a route resolved in one is known to the other.
// `routeHost` is that and nothing else: a host to ask for the route, with no
// session and no run directory.
import {
  chmodSync,
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { isInside } from "./pathinside.js";
import type { CoreConfig } from "./reviewconfig.js";
import { buildBenchAgents } from "./engine/roundagents.js";
import { benchSettings } from "./pibuiltins.js";
import { copyPiAuth, ENGINE_AUTH_WORDS, type AuthCopyWords } from "./engine/auth.js";
import type { ProfileLookup } from "./profiles.js";
import { HOST_CONTEXT_STUB, reviewerStubSource } from "./reviewerstub.js";
import type { PiHost, PiHostOptions } from "./engine/pisdk.js";

/** pi's catalog files in an agent dir: the person's own providers, and the
 * overlay pi stored of the models it learned since its build. */
export const CATALOG_FILES = ["models.json", "models-store.json"] as const;

/** Copy pi's catalog files from `srcAgentDir` into `dstAgentDir` (0600). A file
 * the source does not have is removed from the destination, so a reused
 * directory never keeps a catalog its source dropped. Nothing else of the
 * source is read. */
export function copyCatalogFiles(srcAgentDir: string, dstAgentDir: string): void {
  for (const name of CATALOG_FILES) {
    const src = join(srcAgentDir, name);
    const dst = join(dstAgentDir, name);
    if (!existsSync(src)) {
      rmSync(dst, { force: true });
      continue;
    }
    copyFileSync(src, dst);
    chmodSync(dst, 0o600);
  }
}

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
 * entry: the SDK host discovers none (packages/pi-plugin/src/engine/pisdk.ts), so neither the
 * guard nor pi's built-ins (packages/pi-plugin/src/pibuiltins.ts) are loaded from settings. Every
 * lens session gets the guard as a factory (packages/pi-plugin/src/engine/lens/runlens.ts). */
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
 * (packages/pi-plugin/src/engine/auth.ts) when the operator's login is copied and would expire
 * inside `needMs`, and a plain Error when the cwd would sit inside a checkout.
 * `srcAgentDir` is only read.
 */
export function prepareReviewHost(o: {
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
  /** A profile's replacements for the lens agents (packages/pi-plugin/src/profileoverrides.ts),
   * and where its profile is looked up. */
  profile: { readFile?: (path: string) => string; lookup: ProfileLookup };
  /** What a refused login says: each host names its own fix. Default: the
   * engine's words. */
  authWords?: AuthCopyWords;
  /** Carry (and check) only these providers' logins into the run: a host
   * whose login holds other providers' tokens (a person's own pi) gives the
   * review's providers here, so an unrelated short-lived login neither rides
   * along nor refuses the run. Omitted: the whole login. */
  authProviders?: readonly string[];
  /** How the run's sessions get the login. `copy` (the default): the
   * refresh-disabled copy is written into the private agent dir, and checked
   * against `needMs`. `injected`: the host borrowed the login itself
   * (`borrowedCredentials`) and hands it to its pi host in memory, so no
   * `auth.json` is written and nothing of the login is read or checked here. */
  auth?: "copy" | "injected";
  now?: () => number;
}): HostRun {
  const cwd = resolve(o.cwd);
  for (const c of [o.root, ...o.checkouts])
    if (isInside(real(cwd), checkoutOf(c)))
      throw new Error(`the run directory ${cwd} is inside the checkout ${c}`);
  rmSync(o.agentDir, { recursive: true, force: true });
  mkdirSync(o.agentDir, { recursive: true, mode: 0o700 });
  const auth = join(o.srcAgentDir, "auth.json");
  // `injected`: the login lives in the host's memory, and the agent dir holds none.
  if (o.auth !== "injected") {
    if (existsSync(auth)) {
      copyPiAuth({
        srcDir: o.srcAgentDir,
        dstDir: o.agentDir,
        needMs: o.needMs,
        ...(o.now ? { now: o.now } : {}),
        words: o.authWords ?? ENGINE_AUTH_WORDS,
        ...(o.authProviders ? { providers: o.authProviders } : {}),
      });
    } else {
      // No login: an API key in the environment is the route (as the bench's).
      writeFileSync(join(o.agentDir, "auth.json"), "{}\n", { mode: 0o600 });
      chmodSync(join(o.agentDir, "auth.json"), 0o600);
    }
  }
  // Custom providers the operator configured stay usable, and the host knows
  // the models the operator's pi knows; nothing else of the operator's pi home
  // (extensions, skills, prompts, settings) is carried.
  copyCatalogFiles(o.srcAgentDir, o.agentDir);
  writeFileSync(join(o.agentDir, "settings.json"), hostSettings(o.root));
  // The lens agents, for the user scope (QCR_SUBAGENT_SCOPE=user): the lens
  // tool reads them from the agent dir's `agents`.
  buildBenchAgents(o.root, o.cfg, join(o.agentDir, "agents"), o.profile);
  mkdirSync(cwd, { recursive: true });
  copyFileSync(reviewerStubSource(o.root), join(cwd, HOST_CONTEXT_STUB));
  return { agentDir: o.agentDir, cwd, strayContext: ancestorContextFiles(cwd) };
}

/** A host that exists to name the route: no session, no run directory. */
export interface RouteHost {
  host: PiHost;
  /** The private agent dir the host runs over. */
  agentDir: string;
  /** Dispose the host and remove the private agent dir. Idempotent. */
  dispose(): void;
}

/**
 * A host for the route alone: what a preview, a preflight or a "which model
 * would run" verb needs. It makes a private agent dir under `tmpDir`, gives it
 * the catalog files of `srcAgentDir` (read, never written) and builds a host
 * over it with the credentials and route inputs it is handed. Creating it
 * makes no request and starts no session; `host.route()` is the answer.
 */
export async function routeHost(o: {
  /** The pi agent dir whose catalog the route is resolved over. */
  srcAgentDir: string;
  /** Where the private agent dir is made: a directory of the caller's own
   * (its state home's tmp). Created 0700 when missing. */
  tmpDir: string;
  /** The credentials the host may use. Omitted: none but the environment's. */
  credentials?: PiHostOptions["credentials"];
  route?: PiHostOptions["route"];
  authEnv?: PiHostOptions["authEnv"];
  configureModels?: PiHostOptions["configureModels"];
  /** The host is asked for inside a running pi (the plugin). */
  hostPi?: boolean;
}): Promise<RouteHost> {
  mkdirSync(o.tmpDir, { recursive: true, mode: 0o700 });
  const agentDir = mkdtempSync(join(o.tmpDir, "route-"));
  const remove = (): void => rmSync(agentDir, { recursive: true, force: true });
  try {
    chmodSync(agentDir, 0o700);
    copyCatalogFiles(o.srcAgentDir, agentDir);
    // Loaded here, not at the top: the pi SDK is only needed once a route is asked for.
    const { PiHost: Host } = await import("./engine/pisdk.js");
    const host = await Host.create({
      agentDir,
      ownsProcess: false,
      ...(o.hostPi === true ? { hostPi: true } : {}),
      ...(o.credentials ? { credentials: o.credentials } : {}),
      ...(o.route ? { route: o.route } : {}),
      ...(o.authEnv ? { authEnv: o.authEnv } : {}),
      ...(o.configureModels ? { configureModels: o.configureModels } : {}),
    });
    let disposed = false;
    return {
      host,
      agentDir,
      dispose() {
        if (disposed) return;
        disposed = true;
        host.dispose();
        remove();
      },
    };
  } catch (e) {
    remove();
    throw e;
  }
}
