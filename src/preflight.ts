// `daemon --preflight` (P8.4b): the cutover and release check, run by the VM's
// updater (deploy/qcr-update.sh) from the NEW image with --network none, after
// the stop, on a scratch copy of the snapshot and before the point of no return.
//
// It reads the live bytes and writes only into a scratch directory of its own:
//   - state.db (+ -wal/-shm) is COPIED there and the copy is migrated forward by
//     the daemon's own StateStore, so a mount of the live state can be read-only;
//   - every open PR's session JSONL is parsed (resumecheck.ts) and, as the worker
//     does as its first act, opened by pi's SessionManager and its context rebuilt.
//     No provider, no model, no round: the same check the P8.4 rehearsal makes
//     of the library half;
//   - the login (auth.json) must be there, readable and either refreshable or
//     good for the work window; models.json must parse; the IPC socket directory
//     must be creatable at 0700 and its socket path must fit sockaddr_un;
//   - the config home is checked with `qcr config check`'s own function.
// It prints one JSON object (never a token, never transcript text) and exits
// non-zero when any check failed, which is what makes the updater rescue.
import {
  accessSync,
  constants,
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
import { openSessionContext } from "@quickchatai/pi-quickreview/src/engine/pisdk.js";
import { checkConfigHome } from "./configcheck.js";
import { parseConfig, sandboxRoot } from "./config.js";
import {
  DISABLED_REFRESH,
  PI_REFRESH_MARGIN_MS,
  loginSummary,
} from "@quickchatai/pi-quickreview/src/engine/auth.js";
import { ensurePrivateDir, runDirOf, socketPathOf } from "./ipc/capability.js";
import { locateConfig } from "./install.js";
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
  /** pi's agent dir: auth.json and models.json, read. */
  agentDir: string;
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

function login(opts: PreflightOptions): PreflightCheck {
  const file = join(opts.agentDir, "auth.json");
  const fail = (reason: string): PreflightCheck => ({
    name: "login",
    ok: false,
    detail: "login not usable",
    reason,
  });
  if (!existsSync(file)) return fail(`no pi login at ${file}`);
  try {
    accessSync(file, constants.R_OK);
  } catch {
    return fail(`${file} is not readable by this user (the refresher shares its group)`);
  }
  let raw: string;
  try {
    raw = readFileSync(file, "utf8");
    JSON.parse(raw);
  } catch (e) {
    return fail(`${file} does not parse: ${msgOf(e)}`);
  }
  const summary = loginSummary(raw);
  const providers = Object.keys(summary);
  if (providers.length === 0) return fail(`${file} holds no provider login`);
  const parsed = JSON.parse(raw) as Record<string, Record<string, unknown>>;
  const now = (opts.now ?? Date.now)();
  const need = (opts.workWindowMin ?? DEFAULT_WORK_WINDOW_MIN) * 60_000;
  const lacking: string[] = [];
  for (const p of providers) {
    const s = summary[p]!;
    if (s.type !== "oauth") continue;
    const refresh = parsed[p]?.["refresh"];
    const refreshable =
      typeof refresh === "string" && refresh !== "" && refresh !== DISABLED_REFRESH;
    const lasts = s.expires !== null && s.expires >= now + need + PI_REFRESH_MARGIN_MS;
    if (!refreshable && !lasts) lacking.push(p);
  }
  if (lacking.length > 0)
    return fail(
      `the ${lacking.join(", ")} login has no refresh token and expires inside the ${Math.round(need / 60_000)}-minute work window`,
    );
  return {
    name: "login",
    ok: true,
    detail: `${providers.length} provider(s): ${providers.join(", ")}`,
  };
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

export function runPreflight(opts: PreflightOptions): PreflightReport {
  const scratch = mkdtempSync(join(opts.scratchParent ?? tmpdir(), "qcr-preflight-"));
  const checks: PreflightCheck[] = [];
  try {
    const m = migrate(opts, scratch);
    checks.push(m.check);
    checks.push(resume(opts, scratch, m.db));
    checks.push(login(opts));
    checks.push(models(opts));
    checks.push(socket(opts, scratch));
    checks.push(config(opts));
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
  return { ok: checks.every((c) => c.ok), checks };
}

/** The entry: options from the environment the image runs with. Prints the
 * report, returns the exit code. */
export function preflightMain(
  env: NodeJS.ProcessEnv = process.env,
  out: (s: string) => void = (s) => console.log(s),
): number {
  const root = sandboxRoot();
  const located = locateConfig({ env });
  const stateDir = join(root, "state");
  let sessionsDir: string | undefined;
  try {
    if (existsSync(located.path)) {
      const cfg = parseConfig(readFileSync(located.path, "utf8"));
      sessionsDir = join(root, cfg.pi.session_dir);
    }
  } catch {
    /* the config check names it */
  }
  const agentDir =
    env["PI_CODING_AGENT_DIR"]?.trim() || join(env["HOME"]?.trim() || homedir(), ".pi", "agent");
  const report = runPreflight({
    stateDir,
    ...(sessionsDir ? { sessionsDir } : {}),
    configHome: dirname(located.path),
    agentDir,
    root,
  });
  out(JSON.stringify(report));
  return report.ok ? 0 : 1;
}

if (process.argv[1]?.endsWith("preflight.js")) {
  let code = 1;
  try {
    code = preflightMain();
  } catch (e) {
    console.log(JSON.stringify({ ok: false, checks: [], error: msgOf(e) }));
  }
  process.exit(code);
}
