// The "a newer qcr exists" notice. At most once a day an installed qcr asks
// the npm registry for its package's latest version, in a detached child that
// nobody waits for, and keeps the answer under the state home. Any later run
// reads that file and, when the registry had a newer version, says so on
// stderr after its own output. Never in CI, never on a machine-readable run
// (`--json`, no terminal), never from the release image or a checkout, and
// never blocking: a slow or failing registry costs nothing but a missed notice.
import { spawn } from "node:child_process";
import { mkdirSync, readFileSync, realpathSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

/** How often the registry is asked: once a day. */
export const UPDATE_CHECK_INTERVAL_MS = 24 * 60 * 60_000;
/** How long the detached check waits for the registry. */
export const UPDATE_FETCH_TIMEOUT_MS = 10_000;
/** The file under the state home that keeps the last answer. */
export const UPDATE_CACHE_FILE = "update-check.json";
export const REGISTRY = "https://registry.npmjs.org";

export interface UpdateCache {
  /** When the registry was last asked (ms since the epoch). */
  checked_at: number;
  /** The registry's latest version then; null when it could not be read. */
  latest: string | null;
}

export function updateCachePath(stateHome: string): string {
  return join(stateHome, UPDATE_CACHE_FILE);
}

export function readUpdateCache(path: string): UpdateCache | null {
  try {
    const raw = JSON.parse(readFileSync(path, "utf8")) as Record<string, unknown>;
    const at = raw["checked_at"];
    const latest = raw["latest"];
    if (typeof at !== "number" || !Number.isFinite(at)) return null;
    return { checked_at: at, latest: typeof latest === "string" ? latest : null };
  } catch {
    return null;
  }
}

function writeUpdateCache(path: string, c: UpdateCache): void {
  mkdirSync(dirname(path), { recursive: true });
  const tmp = `${path}.${process.pid}.tmp`;
  writeFileSync(tmp, JSON.stringify(c) + "\n");
  renameSync(tmp, path);
}

/** `x.y.z` → numbers; null for anything else (a prerelease included: the
 * notice only ever points at a release). */
function release(v: string): [number, number, number] | null {
  const m = /^v?(\d+)\.(\d+)\.(\d+)$/.exec(v.trim());
  return m ? [Number(m[1]), Number(m[2]), Number(m[3])] : null;
}

/** Is `latest` a release newer than `current`? */
export function isNewer(current: string, latest: string): boolean {
  const a = release(current);
  const b = release(latest);
  if (a === null || b === null) return false;
  for (let i = 0; i < 3; i++) if (b[i]! !== a[i]!) return b[i]! > a[i]!;
  return false;
}

/** Is a CI environment's flag set? (`CI=false` and `CI=0` are not CI.) */
export function inCi(env: Readonly<Record<string, string | undefined>>): boolean {
  const ci = (env["CI"] ?? "").trim().toLowerCase();
  return (ci !== "" && ci !== "false" && ci !== "0") || env["GITHUB_ACTIONS"] === "true";
}

export interface NoticeInput {
  current: string;
  cachePath: string;
  env: Readonly<Record<string, string | undefined>>;
  /** stderr is a terminal: somebody reads the notice. */
  tty: boolean;
  /** The run's output is machine-readable (`--json`). */
  json: boolean;
  /** Installed by a package manager (src/npmverbs.ts `detectInstall`). */
  installed: boolean;
  now: number;
  /** Start the registry check without waiting for it. */
  refresh: () => void;
}

/** The notice line to print, or null; starts the day's registry check when
 * it is due. Reads one small file and never waits on the network. */
export function updateNotice(o: NoticeInput): string | null {
  if (!o.installed || !o.tty || o.json || inCi(o.env)) return null;
  if ((o.env["QCR_NO_UPDATE_NOTICE"] ?? "").trim() !== "") return null;
  const cache = readUpdateCache(o.cachePath);
  if (cache === null || o.now - cache.checked_at >= UPDATE_CHECK_INTERVAL_MS) {
    // Stamp the check first, so runs in the next minutes do not start another.
    try {
      writeUpdateCache(o.cachePath, { checked_at: o.now, latest: cache?.latest ?? null });
      o.refresh();
    } catch {
      // a state home that cannot be written means no check today, and no harm
    }
  }
  if (cache?.latest && isNewer(o.current, cache.latest))
    return `qcr ${cache.latest} is available (this is ${o.current}): run \`qcr update\`. (QCR_NO_UPDATE_NOTICE=1 silences this.)`;
  return null;
}

/** The registry URL of `pkg`'s latest version (a scoped name keeps its `@`
 * and escapes its `/`). */
export function latestUrl(pkg: string, registry: string = REGISTRY): string {
  return `${registry.replace(/\/+$/, "")}/${pkg.replace("/", "%2f")}/latest`;
}

/** Ask the registry for `pkg`'s latest version and keep the answer at
 * `cachePath`. A failure keeps the previous answer, stamped now: the next try
 * is tomorrow. */
export async function refreshUpdateCache(o: {
  cachePath: string;
  pkg: string;
  fetchFn: typeof fetch;
  now: () => number;
  timeoutMs?: number;
}): Promise<UpdateCache> {
  const prev = readUpdateCache(o.cachePath);
  let latest: string | null = prev?.latest ?? null;
  try {
    const res = await o.fetchFn(latestUrl(o.pkg), {
      headers: { accept: "application/json" },
      signal: AbortSignal.timeout(o.timeoutMs ?? UPDATE_FETCH_TIMEOUT_MS),
    });
    if (res.ok) {
      const body = (await res.json()) as { version?: unknown };
      if (typeof body.version === "string" && release(body.version) !== null) latest = body.version;
    }
  } catch {
    // offline, slow or refused: the previous answer stands
  }
  const c: UpdateCache = { checked_at: o.now(), latest };
  try {
    writeUpdateCache(o.cachePath, c);
  } catch {
    // nowhere to keep it: the check simply happens again
  }
  return c;
}

const REFRESH_FLAG = "--refresh-update-cache";

/** Start the registry check in a detached child of this very module, which
 * outlives this run and is never waited for. */
export function spawnRefresh(cachePath: string, pkg: string): void {
  const child = spawn(
    process.execPath,
    [fileURLToPath(import.meta.url), REFRESH_FLAG, cachePath, pkg],
    { detached: true, stdio: "ignore" },
  );
  child.on("error", () => {});
  child.unref();
}

function isThisModule(entry: string | undefined): boolean {
  if (!entry) return false;
  try {
    return realpathSync(entry) === realpathSync(fileURLToPath(import.meta.url));
  } catch {
    return false;
  }
}

// The detached child: `node updatenotice.js --refresh-update-cache <cache> <pkg>`.
if (isThisModule(process.argv[1]) && process.argv[2] === REFRESH_FLAG) {
  const [cachePath, pkg] = process.argv.slice(3);
  if (cachePath && pkg)
    void refreshUpdateCache({ cachePath, pkg, fetchFn: fetch, now: Date.now }).then(
      () => process.exit(0),
      () => process.exit(0),
    );
}
