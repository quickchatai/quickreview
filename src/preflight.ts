// `daemon --preflight`: the cutover and release check, run by the VM's
// updater (deploy/qcr-update.sh) from the NEW image with --network none, after
// the stop, on a scratch copy of the snapshot and before the point of no return.
//
// It reads the live bytes and writes only into a scratch directory of its own:
//   - state.db (+ -wal/-shm) is COPIED there and the copy is migrated forward by
//     the daemon's own StateStore, so a mount of the live state can be read-only;
//   - every open PR's session JSONL is parsed (resumecheck.ts) and, as the worker
//     does as its first act, opened by pi's SessionManager and its context rebuilt.
//     No provider, no model, no round: the same check the rehearsal makes
//     of the library half;
//   - a model route must resolve (`login`): pi is asked, in this process and
//     with no request made, which model a review here would run on, over the
//     credentials a worker will have: the stored logins and keys of the login
//     dir, and the model env of the secrets dir (src/modelenv.ts, the loader
//     the daemon hands its workers' processes). No login file is fine when the
//     credential is a key. A stored login counts only when it has a refresh
//     token or is good for the work window; one that has neither is left out
//     before the route is chosen, as a worker leaves it out. A store or an
//     inventory that cannot be read fails the check: unknown is never ok;
//   - models.json must parse; the IPC socket directory must be creatable at
//     0700 and its socket path must fit sockaddr_un;
//   - the config home is checked with `qcr config check`'s own function.
// It prints one JSON object (never a token, never a key, never transcript
// text) and exits non-zero when any check failed, which is what makes the
// updater rescue.
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
} from "node:fs";
import { homedir, tmpdir } from "node:os";
import { dirname, join } from "node:path";
import Database from "better-sqlite3";
import {
  openSessionContext,
  piSavedProvider,
} from "@quickchatai/pi-quickreview/src/engine/pisdk.js";
import { checkConfigHome } from "./configcheck.js";
import { parseConfig, sandboxRoot } from "./config.js";
import {
  AuthError,
  DISABLED_REFRESH,
  PI_REFRESH_MARGIN_MS,
  borrowedCredentials,
  type BorrowedAuth,
} from "@quickchatai/pi-quickreview/src/engine/auth.js";
import { readModelChoice } from "@quickchatai/pi-quickreview/src/modelchoice.js";
import {
  credentialWords,
  refusalText,
  type RouteRefusal,
  type RouteResult,
  type SkippedLogin,
} from "@quickchatai/pi-quickreview/src/modelroute.js";
import { isPinned } from "@quickchatai/pi-quickreview/src/reviewconfig.js";
import { routeHost } from "@quickchatai/pi-quickreview/src/reviewhost.js";
import { ensurePrivateDir, runDirOf, socketPathOf } from "./ipc/capability.js";
import { locateConfig, locateSecrets } from "./install.js";
import { loginDirOf } from "./loginrefresh/supervisor.js";
import { modelEnvFrom } from "./modelenv.js";
import { inspectSessionJsonl } from "./resumecheck.js";
import { StateStore } from "./state.js";

/** sockaddr_un's sun_path on Linux holds 108 bytes including the NUL. */
const SUN_PATH_MAX = 107;
/** How long the first rounds after the cutover may need the login for. */
export const DEFAULT_WORK_WINDOW_MIN = 120;

export type CheckName = "migrations" | "resume" | "login" | "models" | "socket" | "config";

export interface PreflightCheck {
  name: CheckName;
  ok: boolean;
  /** Counts and names only. */
  detail: string;
  /** Set when !ok: what failed, in a sentence. */
  reason?: string;
}

export interface PreflightReport {
  ok: boolean;
  checks: PreflightCheck[];
}

export interface PreflightOptions {
  /** The app's state dir (state.db, pi-sessions/): read, never written. */
  stateDir: string;
  /** The session store, when not `<stateDir>/pi-sessions`. */
  sessionsDir?: string;
  /** The config home (config.toml + profiles/), read. */
  configHome: string;
  /** pi's agent dir: the catalog (models.json), and the login unless
   * `loginDir` names it; read. */
  agentDir: string;
  /** Where the login, the remembered model choice and pi's saved provider are
   * when that is not `agentDir`: the single box's shared login, as a worker
   * reads them from its spec's `login_dir`. */
  loginDir?: string;
  /** The install's secrets dir: its model env (src/modelenv.ts) is what a
   * worker's process is given beside the login. Omitted: none. */
  secretsDir?: string;
  /** The environment pi's credential lookups read, under the model env.
   * Omitted: an empty one, so only the login and the secrets dir count. */
  env?: Readonly<Record<string, string | undefined>>;
  /** `[models] model` of the config under check: the review's pin when it
   * names a model. */
  model?: string;
  /** The app root `qcr config check` resolves generic profiles from. */
  root?: string;
  workWindowMin?: number;
  now?: () => number;
  /** Where the scratch copy lives (default: a fresh dir under the OS tmp). */
  scratchParent?: string;
}

const msgOf = (e: unknown): string => (e instanceof Error ? e.message : String(e));

function copyIfPresent(from: string, to: string): boolean {
  if (!existsSync(from)) return false;
  copyFileSync(from, to);
  return true;
}

/** Open PRs: every pr_state row that is not closed. */
function openPrs(db: string): number[] {
  const h = new Database(db, { readonly: true });
  try {
    return (
      h.prepare("SELECT number FROM pr_state WHERE state != 'closed' ORDER BY number").all() as {
        number: number;
      }[]
    ).map((r) => r.number);
  } finally {
    h.close();
  }
}

function migrate(
  opts: PreflightOptions,
  scratch: string,
): { check: PreflightCheck; db: string | null } {
  const db = join(scratch, "state.db");
  try {
    if (!copyIfPresent(join(opts.stateDir, "state.db"), db)) {
      return {
        check: {
          name: "migrations",
          ok: false,
          detail: "no state.db",
          reason: `no state.db in ${opts.stateDir}`,
        },
        db: null,
      };
    }
    copyIfPresent(join(opts.stateDir, "state.db-wal"), `${db}-wal`);
    copyIfPresent(join(opts.stateDir, "state.db-shm"), `${db}-shm`);
    const store = new StateStore(db);
    try {
      const rows = store.db.pragma("integrity_check") as { integrity_check: string }[];
      const bad = rows.find((r) => r.integrity_check !== "ok");
      if (bad) throw new Error(`integrity_check: ${bad.integrity_check}`);
    } finally {
      store.db.close();
    }
    return {
      check: { name: "migrations", ok: true, detail: "the scratch copy migrated forward" },
      db,
    };
  } catch (e) {
    return {
      check: {
        name: "migrations",
        ok: false,
        detail: "migration failed",
        reason: `migrating the scratch copy of state.db failed: ${msgOf(e)}`,
      },
      db: null,
    };
  }
}

function resume(opts: PreflightOptions, scratch: string, db: string | null): PreflightCheck {
  if (db === null)
    return {
      name: "resume",
      ok: false,
      detail: "no migrated copy",
      reason: "the open PRs cannot be listed without the migrated state.db",
    };
  let prs: number[];
  try {
    prs = openPrs(db);
  } catch (e) {
    return {
      name: "resume",
      ok: false,
      detail: "cannot list open PRs",
      reason: `listing open PRs failed: ${msgOf(e)}`,
    };
  }
  const sessions = opts.sessionsDir ?? join(opts.stateDir, "pi-sessions");
  const sessionDirOut = join(scratch, "sessions");
  const failures: string[] = [];
  let files = 0;
  let withoutSession = 0;
  for (const pr of prs) {
    const dir = join(sessions, `pr-${pr}`);
    // Every *.jsonl anywhere under the PR's session dir, as runtime discovery
    // does (src/sessionjsonl.ts). Only an absent dir is "no session yet".
    const names: string[] = [];
    let unlisted = false;
    const walk = (sub: string): void => {
      let entries;
      try {
        entries = readdirSync(join(dir, sub), { withFileTypes: true });
      } catch (e) {
        if ((e as NodeJS.ErrnoException).code === "ENOENT") return;
        failures.push(
          `pr-${pr}/${sub}: cannot list the session directory: ${msgOf(e).slice(0, 160)}`,
        );
        unlisted = true;
        return;
      }
      for (const e of entries) {
        const rel = sub === "" ? e.name : join(sub, e.name);
        if (e.isDirectory()) walk(rel);
        else if (e.name.endsWith(".jsonl")) names.push(rel);
      }
    };
    walk("");
    if (names.length === 0) {
      if (!unlisted) withoutSession++;
      continue;
    }
    for (const name of names) {
      files++;
      const src = join(dir, name);
      try {
        const facts = inspectSessionJsonl(src);
        if (facts.header === null) throw new Error("no session header");
        if (facts.badLines > 0) throw new Error(`${facts.badLines} line(s) that are not JSON`);
        // pi's own parse, on a copy: what a worker pays before its first request.
        const out = join(sessionDirOut, `pr-${pr}`);
        const copy = join(out, name);
        mkdirSync(dirname(copy), { recursive: true });
        copyFileSync(src, copy);
        openSessionContext(copy, out, scratch);
      } catch (e) {
        failures.push(`pr-${pr}/${name}: ${msgOf(e).slice(0, 160)}`);
      }
    }
  }
  const detail = `${prs.length} open PR(s), ${files} session file(s) resumed offline, ${withoutSession} without a session`;
  if (failures.length > 0)
    return {
      name: "resume",
      ok: false,
      detail,
      reason: `${failures.length} session file(s) cannot be resumed: ${failures.slice(0, 5).join("; ")}`,
    };
  return { name: "resume", ok: true, detail };
}

/** The login's own store, as the route host takes it. */
type LoginStore = BorrowedAuth["credentials"];

/** `store` without the providers in `hidden`: pi then sees each of them as it
 * would be with no stored login, so a key in the model env for the same
 * provider resolves by pi's own rule. */
function without(store: LoginStore, hidden: ReadonlySet<string>): LoginStore {
  if (hidden.size === 0) return store;
  return {
    read: async (providerId, options) =>
      hidden.has(providerId) ? undefined : store.read(providerId, options),
    list: async (options) =>
      (await store.list(options)).filter((info) => !hidden.has(info.providerId)),
    modify: (providerId, fn, options) => store.modify(providerId, fn, options),
    delete: (providerId, options) => store.delete(providerId, options),
  };
}

/**
 * The stored logins the bot cannot count on after the cutover: an OAuth login
 * with no refresh token of its own (nothing can renew it) that does not last
 * the work window plus pi's refresh margin. A login with a refresh token is
 * the refresher's to renew, whatever its access token's age. No login file is
 * no login. Throws when the file is there and is not the object pi writes.
 */
function shortLogins(file: string, now: number, needMs: number): SkippedLogin[] {
  let raw: string;
  try {
    raw = readFileSync(file, "utf8");
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "ENOENT") return [];
    // A filesystem error names the file itself.
    throw e;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (e) {
    throw new Error(`${file} does not parse: ${msgOf(e)}`);
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed))
    throw new Error(`${file} is not a JSON object`);
  const short: SkippedLogin[] = [];
  for (const [provider, entry] of Object.entries(parsed as Record<string, unknown>)) {
    if (typeof entry !== "object" || entry === null) continue;
    const cred = entry as Record<string, unknown>;
    if (cred["type"] !== "oauth") continue;
    const refresh = cred["refresh"];
    const refreshable =
      typeof refresh === "string" && refresh !== "" && refresh !== DISABLED_REFRESH;
    const expires = cred["expires"];
    // A login with no expiry never runs out.
    const lasts = typeof expires !== "number" || expires >= now + needMs + PI_REFRESH_MARGIN_MS;
    if (!refreshable && !lasts)
      short.push({ provider, name: provider, expiresAt: expires as number });
  }
  return short;
}

/** "a", "a and b", "a, b and c". */
function listed(items: readonly string[]): string {
  if (items.length <= 1) return items[0] ?? "";
  return `${items.slice(0, -1).join(", ")} and ${items[items.length - 1]}`;
}

/**
 * Does a model route resolve for the bot this image will start: the question
 * `qcr model` asks, over what a worker is handed. Nothing is sent and no
 * session is started; the host runs over a private agent dir in the scratch.
 */
async function login(opts: PreflightOptions, scratch: string): Promise<PreflightCheck> {
  const loginDir = opts.loginDir ?? opts.agentDir;
  const now = (opts.now ?? Date.now)();
  const need = (opts.workWindowMin ?? DEFAULT_WORK_WINDOW_MIN) * 60_000;
  const fail = (reason: string): PreflightCheck => ({
    name: "login",
    ok: false,
    detail: "no model route",
    reason,
  });
  // The store's own error already says which file and why.
  const unread = (e: unknown): PreflightCheck =>
    fail(
      e instanceof AuthError && e.code === "unreadable"
        ? msgOf(e)
        : `could not read pi's credentials: ${msgOf(e)}`,
    );

  let skipped: SkippedLogin[];
  let borrowed: BorrowedAuth;
  try {
    const short = shortLogins(join(loginDir, "auth.json"), now, need);
    // Which logins count is this check's own rule (`shortLogins`: a refresh
    // token, or the work window), not a run's: the bot is stopped, and a login
    // whose access token ran out overnight is renewed by the refresher when it
    // starts. So the borrow is asked at time zero, where it leaves nothing
    // out, and the ones that do not count are hidden from the store below.
    borrowed = borrowedCredentials({
      srcDir: loginDir,
      needMs: 0,
      marginMs: 0,
      owner: false,
      now: () => 0,
      // Nothing rewrites the login while the bot is stopped: no wait.
      retry: { tries: 1 },
    });
    const named = new Set(short.map((l) => l.provider));
    skipped = [...short, ...borrowed.skipped.filter((l) => !named.has(l.provider))];
  } catch (e) {
    return unread(e);
  }
  const remembered = readModelChoice(loginDir);
  const saved = piSavedProvider(loginDir);
  const modelEnv = opts.secretsDir !== undefined ? modelEnvFrom(opts.secretsDir) : {};

  /** The route, and pi's display name for a provider id. */
  const resolve = async (): Promise<{
    result: RouteResult;
    nameOf: (provider: string) => string;
  }> => {
    const made = await routeHost({
      // The catalog stays in pi's own agent dir wherever the login is.
      srcAgentDir: opts.agentDir,
      tmpDir: join(scratch, "route"),
      credentials: without(borrowed.credentials, new Set(skipped.map((l) => l.provider))),
      // The model env over the process's own, as a worker's process holds it.
      authEnv: { ...(opts.env ?? {}), ...modelEnv },
      route: {
        skipped,
        ...(opts.model !== undefined && isPinned(opts.model)
          ? { pin: { text: opts.model, from: "config" as const } }
          : {}),
        ...(remembered.choice !== undefined ? { choice: remembered.choice } : {}),
        ...(saved !== undefined
          ? { piProvider: { provider: saved, from: "pi-settings" as const } }
          : {}),
      },
    });
    try {
      const result = await made.host.route();
      const names = new Map(made.host.modelRuntime.getProviders().map((p) => [p.id, p.name]));
      return { result, nameOf: (provider) => names.get(provider) ?? provider };
    } finally {
      made.dispose();
    }
  };
  let resolved: Awaited<ReturnType<typeof resolve>>;
  try {
    resolved = await resolve();
  } catch (e) {
    // The inventory could not be read: unknown is never ok.
    return unread(e);
  }
  const { result, nameOf } = resolved;

  if (!result.ok)
    return fail(
      refusalWords(result.refusal, {
        loginDir,
        need,
        now,
        configPath: join(opts.configHome, "config.toml"),
        nameOf,
      }),
    );
  const route = result.route;
  const left = skipped.map((l) => nameOf(l.provider));
  return {
    name: "login",
    ok: true,
    detail:
      `runs ${route.spec} (${route.providerName}, ${credentialWords(route.credential)})` +
      (route.movedFrom !== null ? `, moved from ${route.movedFrom}` : "") +
      (left.length > 0 ? `; left out: the ${listed(left)} login (no refresh token)` : ""),
  };
}

/** Why there is no route, for the operator who reads the updater's refusal. */
function refusalWords(
  refusal: RouteRefusal,
  o: {
    loginDir: string;
    need: number;
    now: number;
    configPath: string;
    nameOf: (provider: string) => string;
  },
): string {
  if (refusal.code === "login-too-short") {
    const names = refusal.logins.map((l) => o.nameOf(l.provider));
    const many = names.length > 1;
    return (
      `the ${listed(names)} login${many ? "s have" : " has"} no refresh token and ` +
      `expire${many ? "" : "s"} inside the ${Math.round(o.need / 60_000)}-minute work window`
    );
  }
  return refusalText(refusal, "app", {
    agentDir: o.loginDir,
    needMs: o.need,
    configPath: o.configPath,
    nameOf: o.nameOf,
    now: () => o.now,
  });
}

function models(opts: PreflightOptions): PreflightCheck {
  const file = join(opts.agentDir, "models.json");
  if (!existsSync(file)) return { name: "models", ok: true, detail: "no models.json (optional)" };
  try {
    const v = JSON.parse(readFileSync(file, "utf8")) as unknown;
    if (typeof v !== "object" || v === null || Array.isArray(v))
      throw new Error("not a JSON object");
    return { name: "models", ok: true, detail: "models.json parses" };
  } catch (e) {
    return {
      name: "models",
      ok: false,
      detail: "models.json unusable",
      reason: `${file} does not parse: ${msgOf(e)}`,
    };
  }
}

function socket(opts: PreflightOptions, scratch: string): PreflightCheck {
  const fail = (reason: string): PreflightCheck => ({
    name: "socket",
    ok: false,
    detail: "socket dir not usable",
    reason,
  });
  try {
    const dir = runDirOf(join(scratch, "state"));
    ensurePrivateDir(dir);
    const mode = statSync(dir).mode & 0o777;
    if (mode !== 0o700) return fail(`the IPC run dir came out ${mode.toString(8)}, not 700`);
    const real = socketPathOf(opts.stateDir);
    if (Buffer.byteLength(real) > SUN_PATH_MAX)
      return fail(
        `the socket path ${real} is ${Buffer.byteLength(real)} bytes, over the ${SUN_PATH_MAX} a unix socket takes`,
      );
    return { name: "socket", ok: true, detail: "the IPC run dir is creatable at 0700" };
  } catch (e) {
    return fail(`the IPC run dir cannot be created: ${msgOf(e)}`);
  }
}

function config(opts: PreflightOptions): PreflightCheck {
  const res = checkConfigHome({ home: opts.configHome, ...(opts.root ? { root: opts.root } : {}) });
  if (res.ok) return { name: "config", ok: true, detail: `config ok: ${res.config_home}` };
  return {
    name: "config",
    ok: false,
    detail: `${res.errors.length} error(s)`,
    reason: res.errors
      .map((e) => `${e.where}: ${e.message}`)
      .slice(0, 5)
      .join("; "),
  };
}

export async function runPreflight(opts: PreflightOptions): Promise<PreflightReport> {
  const scratch = mkdtempSync(join(opts.scratchParent ?? tmpdir(), "qcr-preflight-"));
  const checks: PreflightCheck[] = [];
  try {
    const m = migrate(opts, scratch);
    checks.push(m.check);
    checks.push(resume(opts, scratch, m.db));
    checks.push(await login(opts, scratch));
    checks.push(models(opts));
    checks.push(socket(opts, scratch));
    checks.push(config(opts));
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
  return { ok: checks.every((c) => c.ok), checks };
}

/** The entry: options from the environment the image runs with. Prints the
 * report, resolves the exit code.
 *
 * The credentials are found where the daemon this image starts will find
 * them: the login where `QCR_LOGIN_DIR` hands it one, else pi's agent dir;
 * the secrets dir by the install locator (`QCR_SECRETS_MOUNT` first, which
 * the entrypoint sets for this check as it does for the daemon), read by the
 * loader the daemon gives its workers' processes. */
export async function preflightMain(
  env: NodeJS.ProcessEnv = process.env,
  out: (s: string) => void = (s) => console.log(s),
): Promise<number> {
  const root = sandboxRoot();
  const located = locateConfig({ env });
  const stateDir = join(root, "state");
  let sessionsDir: string | undefined;
  let model: string | undefined;
  let configuredSecrets: string | null = null;
  try {
    if (existsSync(located.path)) {
      const cfg = parseConfig(readFileSync(located.path, "utf8"));
      sessionsDir = join(root, cfg.pi.session_dir);
      model = cfg.models.model;
      configuredSecrets = cfg.github.secrets_dir;
    }
  } catch {
    /* the config check names it */
  }
  const agentDir =
    env["PI_CODING_AGENT_DIR"]?.trim() || join(env["HOME"]?.trim() || homedir(), ".pi", "agent");
  const report = await runPreflight({
    stateDir,
    ...(sessionsDir ? { sessionsDir } : {}),
    configHome: dirname(located.path),
    agentDir,
    loginDir: loginDirOf(env, agentDir),
    secretsDir: locateSecrets({ configured: configuredSecrets, env }).path,
    env,
    ...(model !== undefined ? { model } : {}),
    root,
  });
  out(JSON.stringify(report));
  return report.ok ? 0 : 1;
}

if (process.argv[1]?.endsWith("preflight.js")) {
  preflightMain().then(
    (code) => process.exit(code),
    (e: unknown) => {
      console.log(JSON.stringify({ ok: false, checks: [], error: msgOf(e) }));
      process.exit(1);
    },
  );
}
