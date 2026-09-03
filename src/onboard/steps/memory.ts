// Memory keys — mint, place, prove.
//
// A new operator gets working, CONFINED memory without ever learning what a
// memory key is. Until this step existed the docs said "mint one, once" and no
// command minted anything: the operator was expected to hand-issue three keys
// and hand-place them, and the one placement mistake that matters (the
// companion key landing where review sessions can read it) was a paragraph of
// prose rather than a check.
//
// THE THREE KEYS AND WHERE EACH ONE MAY LIVE. This is the whole point of the
// step, and it is absolute (root CLAUDE.md rule 8, docs/companion-memory-access.md):
//
//   root      the SERVER's own credential. ONLY <secrets>/openviking_root_key,
//             0600, on the daemon host. Never a client credential, never in the
//             operator key file, never handed to a session or the companion.
//   reviewer  the one USER key the daemon and every review session hold.
//             <secrets>/openviking_reviewer_key AND the operator key file.
//   companion the companion's own USER key. ONLY the operator key file (0600).
//             NEVER on the daemon side: review sessions run in that container,
//             and a companion key they could read would defeat the confinement
//             this whole design exists to enforce.
//
// The compose route mounts the WHOLE secrets dir into the container read-only,
// and the documented key file lives in that same directory by default — so on
// the laptop route the documented layout would hand review sessions the
// companion key. `resolveKeysFile` relocates the key file out of the secrets
// dir rather than writing a key into a mounted directory, and the step reports
// the one env line that keeps the TUI and companion pointed at it.
//
// IDEMPOTENT BY CONSTRUCTION. An existing key is left exactly alone: minting
// asks the server for the key a user ALREADY has instead of issuing a second
// one, and a local file that already holds a value is never overwritten. A
// rotation would orphan every copy already distributed — the daemon's secrets
// mount, the operator's key file — so nothing here rotates, ever. A local value
// that disagrees with the server is reported red, not "fixed".
//
// TWO PHASES, because the two halves need different things:
//   A. the root key is minted and placed OFFLINE — it must be in the secrets
//      dir BEFORE the daemon container boots, since the entrypoint renders it
//      into ov.conf (no root key ⇒ the server degrades to auth_mode=dev and
//      confinement is not enforced);
//   B. the USER keys can only come from a RUNNING server (it mints them), so
//      that half needs the stack up. Running this step before bring-up lands
//      phase A and says plainly that phase B is waiting; re-run it after
//      bring-up and it completes. The engine's resume re-verification is what
//      makes that a normal flow rather than a special case.
//
// VERIFICATION IS THE EXISTING FOUR-CELL CONFINEMENT MATRIX
// (scripts/companion-memory-forward.mjs `runVerify`) — not a second proof.
// A FAILED row fails the step; an INCONCLUSIVE row also fails it. Inconclusive
// means the probe could not tell (a 404, a 5xx, a 200 carrying an error
// envelope), and "could not tell" has never been a pass for this matrix.
//
// DECLINING IS LEGAL AND LOUD. An operator who says no to memory setup gets the
// documented memory-less mode — rounds still run (context assembly resolves
// empty and never blocks or delays a round), the TUI's Memory tab paints its
// store row red, the EOD curator and the [feedback] sink have nowhere to write.
// The step records the choice, writes NOTHING, and stays green so the wizard
// finishes. It never wedges and never crashes.
import {
  chmodSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  renameSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve, sep } from "node:path";
import { pathToFileURL } from "node:url";
import { OPENVIKING_DEFAULTS } from "../../config.js";
import { CHOICE_KEYS, type MemoryChoice } from "../choices.js";
import type { CheckResult, OnboardingStep, StepContext, StepReport } from "../engine.js";

export const MEMORY_STEP_ID = "memory";
/** Recorded choice: "configure" (default) | "declined". */
export const MEMORY_CHOICE_KEY = CHOICE_KEYS.memory;
/** Recorded so later steps / the TUI launch know where the key file went. */
export const KEYS_FILE_CHOICE_KEY = "openviking_keys_file";

export const REVIEWER_USER = "reviewer";
export const COMPANION_USER = "companion";

/** Secret FILE NAMES — taken from the one config authority so this step cannot
 * drift from the entrypoint, ansible and the secrets wizard. */
export const ROOT_KEY_FILE = OPENVIKING_DEFAULTS.root_key_file;
export const REVIEWER_KEY_FILE = OPENVIKING_DEFAULTS.reviewer_key_file;

/** The operator key file's three variables (docs/companion-memory-access.md).
 * `OPENVIKING_API_KEY` is the companion extension's own identity. */
export const COMPANION_VARS = ["OPENVIKING_API_KEY", "OPENVIKING_COMPANION_KEY"] as const;
export const REVIEWER_VAR = "OPENVIKING_REVIEWER_KEY";

// ---- the two script modules this step drives (never reimplemented) ----------

/** The slice of `scripts/openviking-provision.mjs` used here. The script is
 * untyped, build-free ESM (the container entrypoint runs it before any build),
 * so this interface IS the contract — `tests/onboard-memory.test.ts` checks the
 * real module still satisfies it. */
export interface ProvisionModule {
  mintRootKey(): string;
  mintUserKeys(opts: {
    base: string;
    account: string;
    users: string[];
    rootKey: string;
    fetchFn: typeof fetch;
    log?: (line: string) => void;
  }): Promise<{
    keys: Record<string, string>;
    created: string[];
    kept: string[];
    missing: string[];
    ok: boolean;
    detail: string;
  }>;
}

/** The slice of `scripts/companion-memory-forward.mjs` used here: the ONE
 * four-cell confinement matrix in the repo. */
export interface MatrixModule {
  runVerify(opts: {
    base: string;
    keys: { companion?: string; reviewer?: string };
    env?: NodeJS.ProcessEnv;
    fetchFn: typeof fetch;
    write?: boolean;
    log?: (line: string) => void;
  }): Promise<{ rows: MatrixRow[]; failed: number; unclear: number }>;
}

export interface MatrixRow {
  who: string;
  ns: string;
  want: string;
  why: string;
  observed: string;
  verdict: string;
  detail: string;
}

export interface MemoryStepOptions {
  /** Daemon-side secrets dir (default `$QC_SECRETS_DIR` or ~/.config/quickreview-bot). */
  secretsDir?: string;
  /** Operator-side key file (default: resolved, and relocated out of the
   * secrets dir when they would collide). */
  keysFile?: string;
  /** OpenViking endpoint: the memory forward's loopback listener. */
  base?: string;
  account?: string;
  env?: NodeJS.ProcessEnv;
  home?: string;
  loadProvision?: () => Promise<ProvisionModule>;
  loadMatrix?: () => Promise<MatrixModule>;
}

// ---- path rules -------------------------------------------------------------

export function resolveSecretsDir(env: NodeJS.ProcessEnv, home: string): string {
  const override = (env.QC_SECRETS_DIR ?? "").trim();
  return override !== "" ? resolve(override) : join(home, ".config", "quickreview-bot");
}

/** The documented key-file location (mirrors `keysFilePath` in the forward). */
export function documentedKeysFile(env: NodeJS.ProcessEnv, home: string): string {
  const override = (env.QCR_OPENVIKING_KEYS ?? "").trim();
  return override !== ""
    ? resolve(override)
    : join(home, ".config", "quickreview-bot", "openviking-keys.env");
}

/** Is `file` inside `dir`? (A file IN the daemon-side secrets dir is readable by
 * every review session on the compose route — the whole dir is bind-mounted.) */
export function isInside(dir: string, file: string): boolean {
  const d = resolve(dir).replace(new RegExp(`${sep}$`), "");
  const f = resolve(file);
  return f === d || f.startsWith(`${d}${sep}`);
}

export interface KeysFileChoice {
  path: string;
  /** Moved out of the secrets dir because the documented default collided. */
  relocated: boolean;
  /** The operator PINNED a path inside the secrets dir — we refuse it. */
  unsafe: boolean;
  note: string;
}

/**
 * Where the operator key file goes.
 *
 * The companion key lives in that file, so the file must not be inside the
 * daemon-side secrets dir. On the compose route those default to the SAME
 * directory (`docker-compose.yml` mounts `${QCR_SECRETS_DIR:-~/.config/quickreview-bot}`
 * read-only at `/opt/quickreview/secrets`), so the documented layout would put the
 * companion key one `cat` away from every review session. We relocate instead
 * of writing it there — and if the operator explicitly pinned
 * `QCR_OPENVIKING_KEYS` inside the secrets dir, we refuse rather than quietly
 * overriding their choice.
 */
export function resolveKeysFile(
  secretsDir: string,
  env: NodeJS.ProcessEnv,
  home: string,
): KeysFileChoice {
  const pinned = (env.QCR_OPENVIKING_KEYS ?? "").trim() !== "";
  const candidate = documentedKeysFile(env, home);
  if (!isInside(secretsDir, candidate))
    return { path: candidate, relocated: false, unsafe: false, note: "" };
  if (pinned) {
    return {
      path: candidate,
      relocated: false,
      unsafe: true,
      note:
        `QCR_OPENVIKING_KEYS points inside the daemon-side secrets dir (${secretsDir}), which the container mounts read-only — ` +
        "a review session could read the companion key there. Point it at a path outside that directory and run this step again.",
    };
  }
  const relocated = join(home, ".config", "quickreview-keys", "openviking-keys.env");
  return {
    path: relocated,
    relocated: true,
    unsafe: false,
    note:
      `the default key-file location sits inside the secrets dir (${secretsDir}), which the daemon container mounts read-only — ` +
      `using ${relocated} instead so the companion key never reaches the container. Export QCR_OPENVIKING_KEYS=${relocated} ` +
      "(the TUI, the companion and scripts/companion-memory-forward.mjs all read that variable).",
  };
}

// ---- small file helpers (0600 everywhere) -----------------------------------

function writePrivate(path: string, content: string): void {
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  const tmp = join(dirname(path), `.${path.split(sep).at(-1)}.tmp`);
  writeFileSync(tmp, content, { mode: 0o600 });
  chmodSync(tmp, 0o600);
  renameSync(tmp, path);
  chmodSync(path, 0o600);
}

/** A secret file's value, or "" (an unreadable secret is a degraded mode). */
export function readSecretFile(path: string): string {
  try {
    return readFileSync(path, "utf8").trim();
  } catch {
    return "";
  }
}

/** `KEY=value` lines → map. Mirrors `readKeys` in the forward script. */
export function parseKeysFile(text: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const line of text.split("\n")) {
    const m = /^\s*(?:export\s+)?([A-Z0-9_]+)\s*=\s*(.*)$/.exec(line);
    if (!m || m[1] === undefined || m[2] === undefined) continue;
    out[m[1]] = m[2].trim().replace(/^["']|["']$/g, "");
  }
  return out;
}

export function readKeysFile(path: string): Record<string, string> {
  try {
    return parseKeysFile(readFileSync(path, "utf8"));
  } catch {
    return {};
  }
}

/** Render the key file, preserving any variables already in it that we do not
 * own. Values already present are never replaced — that is the no-rotation rule
 * at the file level. */
export function renderKeysFile(
  existing: Record<string, string>,
  next: Record<string, string>,
): string {
  const merged: Record<string, string> = { ...existing };
  for (const [k, v] of Object.entries(next)) {
    if (v && !merged[k]) merged[k] = v;
  }
  const head = [
    "# OpenViking USER keys — the operator's copy (qcr onboard).",
    "# BOTH user keys, and never a root or admin key: an admin key lists every",
    "# user key in plaintext. The companion key must never reach the daemon-side",
    "# secrets dir — review sessions run in that container.",
    "# 0600. Read by the TUI, the companion container (--env-file) and",
    "# scripts/companion-memory-forward.mjs.",
  ];
  const body = Object.entries(merged).map(([k, v]) => `${k}=${v}`);
  return `${[...head, ...body].join("\n")}\n`;
}

/** Every file directly under `dir` whose contents contain `value`. The
 * companion-key negative assertion runs through this. */
export function filesContaining(dir: string, value: string): string[] {
  if (!value || !existsSync(dir)) return [];
  const hits: string[] = [];
  let names: string[];
  try {
    names = readdirSync(dir);
  } catch {
    return [];
  }
  for (const name of names) {
    const path = join(dir, name);
    try {
      if (!statSync(path).isFile()) continue;
      if (readFileSync(path, "utf8").includes(value)) hits.push(path);
    } catch {
      /* unreadable file — cannot leak what we cannot read here either */
    }
  }
  return hits;
}

function modeOk(path: string): boolean {
  try {
    return (statSync(path).mode & 0o077) === 0;
  } catch {
    return false;
  }
}

// ---- choices ----------------------------------------------------------------

export type { MemoryChoice };

export function normalizeMemoryChoice(answer: string | undefined): MemoryChoice {
  return /^\s*(n|no|skip|declin|later|without)/i.test(answer ?? "") ? "declined" : "configure";
}

export const DECLINED_CHECKS: readonly CheckResult[] = [
  {
    name: "memory",
    ok: true,
    detail:
      "memory setup DECLINED — running memory-less, which is a legal mode: rounds still run (context assembly resolves " +
      "empty and never blocks or delays a round), the TUI's Memory tab paints its MEMORY STORE row red, and the EOD " +
      "curator and the [feedback] sink have nowhere to write. Nothing was minted or written. Re-run this step after " +
      "clearing the recorded choice to set memory up later.",
  },
];

// ---- the step ---------------------------------------------------------------

function repoRootFrom(stateDir: string): string {
  return dirname(resolve(stateDir));
}

function defaultLoaders(stateDir: string): {
  provision: () => Promise<ProvisionModule>;
  matrix: () => Promise<MatrixModule>;
} {
  const root = repoRootFrom(stateDir);
  // Dynamic, by file URL, for the same reason src/tui/memforward.ts does it:
  // both scripts are dependency-free ESM outside tsconfig's include, and a
  // static import would either drag them into the build or fork their logic.
  return {
    provision: () =>
      import(
        pathToFileURL(join(root, "scripts", "openviking-provision.mjs")).href
      ) as Promise<ProvisionModule>,
    matrix: () =>
      import(
        pathToFileURL(join(root, "scripts", "companion-memory-forward.mjs")).href
      ) as Promise<MatrixModule>,
  };
}

async function serverReady(
  fetchFn: typeof fetch,
  base: string,
): Promise<{ ok: boolean; detail: string }> {
  try {
    const res = await fetchFn(`${base}/ready`, { signal: AbortSignal.timeout(10_000) });
    return { ok: res.status >= 200 && res.status < 300, detail: `HTTP ${res.status}` };
  } catch (err) {
    return { ok: false, detail: err instanceof Error ? err.message : String(err) };
  }
}

interface Resolved {
  secretsDir: string;
  keys: KeysFileChoice;
  base: string;
  account: string;
  env: NodeJS.ProcessEnv;
}

function resolvePaths(opts: MemoryStepOptions): Resolved {
  const env = opts.env ?? process.env;
  const home = opts.home ?? homedir();
  const secretsDir = opts.secretsDir ? resolve(opts.secretsDir) : resolveSecretsDir(env, home);
  const keys = opts.keysFile
    ? {
        path: resolve(opts.keysFile),
        relocated: false,
        unsafe: isInside(secretsDir, opts.keysFile),
        note: "",
      }
    : resolveKeysFile(secretsDir, env, home);
  // The endpoint is the memory forward's loopback listener (the VM route) or
  // the local server (the laptop route) — same address either way, which is
  // why the forward binds 127.0.0.1 as well as the docker bridge.
  const base =
    opts.base ?? ((env.QCR_OV_BASE ?? "").trim() || `http://127.0.0.1:${OPENVIKING_DEFAULTS.port}`);
  const account = opts.account ?? ((env.QCR_OV_ADMIN_ACCOUNT ?? "").trim() || "default");
  return { secretsDir, keys, base, account, env };
}

/** Placement: root + reviewer daemon-side, both USER keys operator-side, the
 * companion key operator-side ONLY. Returns one check per rule; writes nothing
 * a rule forbids. */
export function placeKeys(args: {
  secretsDir: string;
  keysFile: string;
  rootKey: string;
  reviewerKey: string;
  companionKey: string;
}): CheckResult[] {
  const checks: CheckResult[] = [];
  const { secretsDir, keysFile, rootKey, reviewerKey, companionKey } = args;
  mkdirSync(secretsDir, { recursive: true, mode: 0o700 });

  // --- daemon side: root + reviewer, and NOTHING else ---
  for (const [name, file, value] of [
    ["root", ROOT_KEY_FILE, rootKey],
    ["reviewer", REVIEWER_KEY_FILE, reviewerKey],
  ] as const) {
    if (!value) continue;
    const path = join(secretsDir, file);
    const existing = readSecretFile(path);
    if (existing === "") {
      writePrivate(path, `${value}\n`);
      checks.push({
        name: `${name}-key-placed`,
        ok: true,
        detail: `${file} written 0600 in ${secretsDir}`,
      });
    } else if (existing === value) {
      if (!modeOk(path)) chmodSync(path, 0o600);
      checks.push({
        name: `${name}-key-placed`,
        ok: true,
        detail: `${file} already holds this key — left untouched (keys are never rotated)`,
      });
    } else {
      checks.push({
        name: `${name}-key-placed`,
        ok: false,
        detail:
          `${path} holds a DIFFERENT ${name} key than the server has. Nothing was rotated: a rotation orphans every copy ` +
          "already distributed. Restore the correct value, or remove that file and run this step again to adopt the server's key.",
      });
    }
  }

  // --- operator side: both USER keys, 0600, outside the secrets dir ---
  if (isInside(secretsDir, keysFile)) {
    checks.push({
      name: "companion-key-confinement",
      ok: false,
      detail:
        `refusing to write the key file at ${keysFile}: it is inside the daemon-side secrets dir (${secretsDir}), which the ` +
        "container mounts read-only — a review session could read the companion key. Point QCR_OPENVIKING_KEYS outside it.",
    });
    return checks;
  }
  const existingKeys = readKeysFile(keysFile);
  const next: Record<string, string> = {};
  for (const v of COMPANION_VARS) next[v] = companionKey;
  next[REVIEWER_VAR] = reviewerKey;
  const conflicts = Object.entries(next).filter(
    ([k, v]) => v && existingKeys[k] && existingKeys[k] !== v,
  );
  writePrivate(keysFile, renderKeysFile(existingKeys, next));
  const after = readKeysFile(keysFile);
  const haveBoth = Boolean(after[COMPANION_VARS[0]] && after[REVIEWER_VAR]);
  checks.push({
    name: "key-file",
    ok: haveBoth && conflicts.length === 0,
    detail:
      conflicts.length > 0
        ? `${keysFile} already defines ${conflicts.map(([k]) => k).join(", ")} with a different value — left as it was (never rotated). ` +
          "Remove the stale line and run this step again to adopt the server's key."
        : haveBoth
          ? `${keysFile} holds both USER keys, 0600 (no root or admin key ever goes here)`
          : `${keysFile} is missing ${[...COMPANION_VARS, REVIEWER_VAR].filter((v) => !after[v]).join(", ")}`,
  });

  // --- the negative assertion: the companion key is NOWHERE on the daemon side ---
  const leaked = companionKey ? filesContaining(secretsDir, companionKey) : [];
  checks.push({
    name: "companion-key-confinement",
    ok: leaked.length === 0,
    detail:
      leaked.length === 0
        ? `the companion key is not in any file under ${secretsDir} — review sessions run in that container and must never read it`
        : `THE COMPANION KEY IS IN ${leaked.join(", ")} — remove those files: review sessions can read the secrets mount`,
  });
  return checks;
}

export function memoryStep(opts: MemoryStepOptions = {}): OnboardingStep {
  const askChoice = async (ctx: StepContext): Promise<MemoryChoice> => {
    const recorded = ctx.choices[MEMORY_CHOICE_KEY];
    if (recorded === "declined" || recorded === "configure") return recorded;
    const prompter = ctx.adapters.prompter;
    if (!prompter) return "configure";
    try {
      return normalizeMemoryChoice(
        await prompter(
          "Set up memory now? The reviewer remembers what it learned across PRs. Saying no is fine — it runs memory-less. [Y/n]",
        ),
      );
    } catch {
      return "configure";
    }
  };

  const loaders = (ctx: StepContext) => {
    const fallback = defaultLoaders(ctx.adapters.paths.stateDir);
    return {
      provision: opts.loadProvision ?? fallback.provision,
      matrix: opts.loadMatrix ?? fallback.matrix,
    };
  };

  return {
    id: MEMORY_STEP_ID,
    title: "Memory: mint, place and confine the OpenViking keys",
    explain:
      "Memory is what lets the reviewer remember what it learned about your repo. Three keys make it work, and where each " +
      "one lives is a security boundary: the server's own root key stays on the daemon host, the reviewer key goes to the " +
      "daemon and every review session, and the companion key goes only to your own machine — review sessions must never " +
      "be able to read it. This step mints whatever does not exist yet (never re-issuing a key you already have), puts each " +
      "one where it belongs, and then proves the confinement with the four-cell matrix. The root key is placed first because " +
      "the daemon needs it at boot; the two user keys can only be minted by a running server, so if the stack is not up yet " +
      "this step lands the root key, says so, and finishes when you re-run it after bring-up. Declining memory entirely is a " +
      "supported answer — the reviewer then runs memory-less.",
    order: 60,

    async run(ctx): Promise<StepReport> {
      const choice = await askChoice(ctx);
      ctx.recordChoice(CHOICE_KEYS.memory, choice);
      if (choice === "declined")
        return { ok: true, checks: [...DECLINED_CHECKS], data: { declined: true } };

      const { secretsDir, keys, base, account } = resolvePaths(opts);
      const checks: CheckResult[] = [];
      if (keys.unsafe) {
        checks.push({ name: "key-file-location", ok: false, detail: keys.note });
        return { ok: false, checks };
      }
      if (keys.relocated) checks.push({ name: "key-file-location", ok: true, detail: keys.note });
      ctx.recordChoice(KEYS_FILE_CHOICE_KEY, keys.path);

      // --- phase A: the root key (offline; needed before the daemon boots) ---
      const rootPath = join(secretsDir, ROOT_KEY_FILE);
      let rootKey = readSecretFile(rootPath);
      const { provision, matrix } = loaders(ctx);
      let prov: ProvisionModule;
      try {
        prov = await provision();
      } catch (err) {
        checks.push({
          name: "provisioning-machinery",
          ok: false,
          detail: `could not load scripts/openviking-provision.mjs: ${String(err)}`,
        });
        return { ok: false, checks };
      }
      if (rootKey === "") {
        rootKey = prov.mintRootKey();
        mkdirSync(secretsDir, { recursive: true, mode: 0o700 });
        writePrivate(rootPath, `${rootKey}\n`);
        checks.push({
          name: "root-key",
          ok: true,
          detail: `minted the server root key and wrote ${rootPath} (0600). It is the SERVER's credential: never a client's, never in the key file.`,
        });
      } else {
        checks.push({
          name: "root-key",
          ok: true,
          detail: `${rootPath} already holds a root key — left untouched (nothing is ever rotated)`,
        });
      }

      // --- phase B: the two USER keys (the server mints them) ---
      const ready = await serverReady(ctx.adapters.fetch, base);
      if (!ready.ok) {
        checks.push({
          name: "memory-server",
          ok: false,
          detail:
            `no OpenViking answering at ${base} (${ready.detail}). The root key is in place, which is what the daemon needs at boot — ` +
            "bring the stack up, then run this step again and the two user keys are minted and placed. Nothing is lost by waiting.",
        });
        return { ok: false, checks, data: { root_key_placed: true, keys_file: keys.path } };
      }

      const minted = await prov.mintUserKeys({
        base,
        account,
        users: [REVIEWER_USER, COMPANION_USER],
        rootKey,
        fetchFn: ctx.adapters.fetch,
        log: (line) => ctx.adapters.log?.(line),
      });
      const reviewerKey = minted.keys[REVIEWER_USER] ?? "";
      const companionKey = minted.keys[COMPANION_USER] ?? "";
      checks.push({
        name: "user-keys",
        ok: minted.ok && reviewerKey !== "" && companionKey !== "",
        detail:
          minted.ok && reviewerKey && companionKey
            ? `${minted.created.length > 0 ? `minted ${minted.created.join(", ")}` : "no user needed creating"}` +
              `${minted.kept.length > 0 ? `; kept the existing key for ${minted.kept.join(", ")} (never rotated)` : ""}`
            : `could not obtain a key for ${minted.missing.join(", ") || "every user"}${minted.detail ? ` (${minted.detail})` : ""} — ` +
              "nothing was rotated. Check that the daemon restarted after the root key landed (the server reads it at boot, and " +
              "without it runs auth_mode=dev), then run this step again.",
      });
      if (!reviewerKey || !companionKey)
        return { ok: false, checks, data: { root_key_placed: true, keys_file: keys.path } };

      checks.push(
        ...placeKeys({ secretsDir, keysFile: keys.path, rootKey, reviewerKey, companionKey }),
      );
      if (!checks.every((c) => c.ok))
        return { ok: false, checks, data: { root_key_placed: true, keys_file: keys.path } };

      // --- the proof ---
      checks.push(
        ...(await matrixChecks(
          matrix,
          base,
          { companion: companionKey, reviewer: reviewerKey },
          ctx,
          opts,
        )),
      );
      return {
        ok: checks.every((c) => c.ok),
        checks,
        data: {
          root_key_placed: true,
          keys_file: keys.path,
          users: [REVIEWER_USER, COMPANION_USER],
        },
      };
    },

    async verify(ctx): Promise<StepReport> {
      if (ctx.choices[MEMORY_CHOICE_KEY] === "declined" || ctx.data.declined === true) {
        return { ok: true, checks: [...DECLINED_CHECKS] };
      }
      const { secretsDir, keys, base } = resolvePaths(opts);
      const keysPath = typeof ctx.data.keys_file === "string" ? ctx.data.keys_file : keys.path;
      const checks: CheckResult[] = [];

      const rootPath = join(secretsDir, ROOT_KEY_FILE);
      const reviewerPath = join(secretsDir, REVIEWER_KEY_FILE);
      for (const [name, path] of [
        ["root-key", rootPath],
        ["reviewer-key", reviewerPath],
      ] as const) {
        const value = readSecretFile(path);
        checks.push({
          name,
          ok: value !== "" && modeOk(path),
          detail:
            value === ""
              ? `${path} is missing or empty — run this step to mint and place it`
              : modeOk(path)
                ? `${path} present, 0600`
                : `${path} is readable by others — chmod 600 it`,
        });
      }

      const fileKeys = readKeysFile(keysPath);
      const companionKey = fileKeys[COMPANION_VARS[1]] ?? fileKeys[COMPANION_VARS[0]] ?? "";
      const reviewerKey = fileKeys[REVIEWER_VAR] ?? "";
      checks.push({
        name: "key-file",
        ok: companionKey !== "" && reviewerKey !== "" && modeOk(keysPath),
        detail:
          companionKey === "" || reviewerKey === ""
            ? `${keysPath} must define ${COMPANION_VARS.join("/")} and ${REVIEWER_VAR} — run this step to write them`
            : modeOk(keysPath)
              ? `${keysPath} holds both USER keys, 0600`
              : `${keysPath} is readable by others — chmod 600 it`,
      });

      const leaked = [
        ...(companionKey ? filesContaining(secretsDir, companionKey) : []),
        ...(isInside(secretsDir, keysPath) ? [keysPath] : []),
      ];
      checks.push({
        name: "companion-key-confinement",
        ok: leaked.length === 0,
        detail:
          leaked.length === 0
            ? `no companion key under ${secretsDir} — review sessions cannot reach companion memory through the secrets mount`
            : `the companion key is reachable from the daemon-side secrets dir (${leaked.join(", ")}) — remove it and re-run this step`,
      });

      if (!companionKey || !reviewerKey) {
        checks.push({
          name: "confinement-matrix",
          ok: false,
          detail: "not run: both USER keys are needed to probe the four cells",
        });
        return { ok: false, checks };
      }
      const { matrix } = loaders(ctx);
      checks.push(
        ...(await matrixChecks(
          matrix,
          base,
          { companion: companionKey, reviewer: reviewerKey },
          ctx,
          opts,
        )),
      );
      return { ok: checks.every((c) => c.ok), checks };
    },
  };
}

/**
 * The four-cell confinement matrix as onboarding checks.
 *
 * One check per row plus a summary. A FAILED row is a boundary violation; an
 * INCONCLUSIVE row is NOT a pass — it means the probe could not tell (a 404, a
 * 5xx, a 200 carrying an error envelope), and the guidance says exactly that.
 */
async function matrixChecks(
  load: () => Promise<MatrixModule>,
  base: string,
  keys: { companion: string; reviewer: string },
  ctx: StepContext,
  opts: MemoryStepOptions,
): Promise<CheckResult[]> {
  let mod: MatrixModule;
  try {
    mod = await load();
  } catch (err) {
    return [
      {
        name: "confinement-matrix",
        ok: false,
        detail: `could not load scripts/companion-memory-forward.mjs: ${String(err)}`,
      },
    ];
  }
  let report: { rows: MatrixRow[]; failed: number; unclear: number };
  try {
    report = await mod.runVerify({
      base,
      keys,
      env: opts.env ?? process.env,
      fetchFn: ctx.adapters.fetch,
      write: false,
      log: () => {},
    });
  } catch (err) {
    return [
      {
        name: "confinement-matrix",
        ok: false,
        detail: `the confinement matrix could not run: ${String(err)}`,
      },
    ];
  }
  const checks: CheckResult[] = report.rows.map((row) => ({
    name: `matrix:${row.who}-key→${row.ns}`,
    ok: row.verdict === "PASS",
    detail:
      row.verdict === "PASS"
        ? `${row.want} — ${row.why}`
        : row.verdict === "INCONCLUSIVE"
          ? `INCONCLUSIVE (${row.detail}): the probe could not tell reach from refusal, which is NEVER a pass. ` +
            "Usually the request shape does not match this server — see docs/companion-memory-access.md " +
            "(QCR_OV_READ_PATH / QCR_OV_READ_URI / QCR_OV_WRITE_PATH) — or the memory forward is not up."
          : `FAILED: expected ${row.want}, got ${row.observed} (${row.detail}). ${row.why}`,
  }));
  checks.push({
    name: "confinement-matrix",
    ok: report.failed === 0 && report.unclear === 0 && report.rows.length > 0,
    detail:
      report.rows.length === 0
        ? "the matrix produced no rows — it did not run"
        : `${report.rows.length - report.failed - report.unclear} pass, ${report.failed} fail, ${report.unclear} inconclusive` +
          (report.failed === 0 && report.unclear === 0
            ? " (run `node scripts/companion-memory-forward.mjs verify --write` for the write half)"
            : " — an inconclusive cell is not a pass"),
  });
  return checks;
}
