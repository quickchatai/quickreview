// The install locator — the ONE module that decides where an
// install's own data lives. Every reader of the live config goes through it:
// the config loader, the onboarding wizard (via its adapters), the bench, the
// TUI, the daemon's session env, and — through `scripts/install-locator.sh`,
// its shell mirror, pinned by a differential test — the posting scripts,
// mint-token and deploy.sh's pin/drift preflight.
//
// Two homes, split by kind:
//   config home  $XDG_CONFIG_HOME/qcr/<install>/  config.toml, profiles/, secrets/
//   state home   $XDG_STATE_HOME/qcr/<install>/   scan ledger, findings, portrait facts
//
// `<install>` is `$QCR_INSTALL`, default `default` — one name per install, so
// one PC can hold more than one. `$QCR_CONFIG` overrides the config FILE
// outright (not the home). The checkout's own `config.toml` is the EXPAND
// step's fallback: still read, never silently — every process that falls back
// to it says so once, naming `qcr install migrate`. contracts it away.
//
// A session must never move any of this: `QCR_CONFIG=` and `QCR_INSTALL=` are
// both in the bash guard's POLICY_RELOCATING_ENV, and `HOME=` /
// `XDG_CONFIG_HOME=` were already refused there. The daemon hands each session
// the path IT resolved as `QCR_CONFIG` (sessions.ts), so the posting scripts
// read exactly the daemon's config rather than re-deriving one.
//
// Pure where it can be: `locateConfig` takes the env and an `exists` probe, so
// the tests drive it with temp XDG homes and never touch the operator's own.
import { copyFileSync, existsSync, mkdirSync, readFileSync, renameSync, unlinkSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, isAbsolute, join, resolve } from "node:path";

/** The slice of the environment the locator reads — nothing else. */
export interface InstallEnv {
  QCR_CONFIG?: string;
  QCR_INSTALL?: string;
  XDG_CONFIG_HOME?: string;
  XDG_STATE_HOME?: string;
  HOME?: string;
}

export const DEFAULT_INSTALL = "default";
export const CONFIG_FILE = "config.toml";

/** A single path segment an install (or, later, a profile) may be named by.
 * No separators, no leading dot, so `..` and `a/../../b` are unspellable. */
const SEGMENT_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;

/** Refuse a name that could escape its parent directory. `kind` names what the
 * segment is for, so the error says which knob is wrong. */
export function assertPathSegment(kind: string, name: string): string {
  if (!SEGMENT_RE.test(name) || name.includes("..")) {
    throw new Error(
      `${kind} ${JSON.stringify(name)} is not a plain name — letters, digits, '.', '_' and '-' only, no path separators or '..'`,
    );
  }
  return name;
}

export function installName(env: InstallEnv = process.env): string {
  const raw = (env.QCR_INSTALL ?? "").trim();
  return raw === "" ? DEFAULT_INSTALL : assertPathSegment("QCR_INSTALL", raw);
}

/** An XDG base dir: the variable when it is set AND absolute (the spec says a
 * relative value is invalid and must be ignored), else `$HOME/<fallback>`. */
function xdgBase(value: string | undefined, env: InstallEnv, fallback: string): string {
  const v = (value ?? "").trim();
  if (v !== "" && isAbsolute(v)) return v;
  const home = (env.HOME ?? "").trim() || homedir();
  return join(home, fallback);
}

/** `$XDG_CONFIG_HOME/qcr/<install>` — config.toml, profiles/, secrets/. */
export function configHome(env: InstallEnv = process.env): string {
  return join(xdgBase(env.XDG_CONFIG_HOME, env, ".config"), "qcr", installName(env));
}

/** `$XDG_STATE_HOME/qcr/<install>` — PC-only scan state, never shipped. */
export function stateHome(env: InstallEnv = process.env): string {
  return join(xdgBase(env.XDG_STATE_HOME, env, join(".local", "state")), "qcr", installName(env));
}

/**
 * Where the live config came from:
 *   override — `$QCR_CONFIG`, taken as given (a missing file is the READER's
 *              error, never a reason to look elsewhere)
 *   home     — the install's config home (also the answer when nothing exists
 *              yet: that is where a new config is written)
 *   checkout — the legacy `<root>/config.toml`, the expand step's fallback
 */
export type ConfigSource = "override" | "home" | "checkout";

export interface LocatedConfig {
  path: string;
  source: ConfigSource;
  /** The install's config home, whichever source won — where migrate moves to. */
  home: string;
}

export interface LocateOptions {
  /** The app checkout (the sandbox root) — only for the legacy fallback. */
  root: string;
  env?: InstallEnv;
  exists?: (path: string) => boolean;
}

export function locateConfig(opts: LocateOptions): LocatedConfig {
  const env = opts.env ?? process.env;
  const exists = opts.exists ?? existsSync;
  const home = configHome(env);
  const override = (env.QCR_CONFIG ?? "").trim();
  if (override !== "") return { path: resolve(override), source: "override", home };
  const inHome = join(home, CONFIG_FILE);
  if (exists(inHome)) return { path: inHome, source: "home", home };
  const legacy = join(opts.root, CONFIG_FILE);
  if (exists(legacy)) return { path: legacy, source: "checkout", home };
  return { path: inHome, source: "home", home };
}

/** The legacy-fallback notice, one wording for every surface. */
export function checkoutFallbackNotice(located: LocatedConfig): string {
  return (
    `qcr: reading the LEGACY checkout config ${located.path} — the install's config home is ` +
    `${located.home}; move it there with \`qcr install migrate\``
  );
}

const announced = new Set<string>();

/**
 * `locateConfig` for a real process: the same answer, plus the checkout
 * fallback LOGGED — once per path per process, so a loader called on every
 * tick does not repeat itself, and never silently.
 */
export function resolveConfigPath(
  opts: LocateOptions & { log?: (line: string) => void },
): LocatedConfig {
  const located = locateConfig(opts);
  if (located.source === "checkout" && !announced.has(located.path)) {
    announced.add(located.path);
    (opts.log ?? ((line: string) => console.error(line)))(checkoutFallbackNotice(located));
  }
  return located;
}

// ---- qcr install migrate ----------------------------------------------------

export type MigrateOutcome =
  /** The checkout's config.toml is now in the config home. */
  | { kind: "moved"; from: string; to: string }
  /** Nothing in the checkout, the home already holds the config: done before. */
  | { kind: "already"; to: string }
  /** Both hold one and they are byte-identical: the checkout copy is removed. */
  | { kind: "deduplicated"; from: string; to: string }
  /** Both hold one and they DIFFER: nothing is touched, the operator decides. */
  | { kind: "conflict"; from: string; to: string }
  /** Neither exists: there is nothing to move (run the onboarding wizard). */
  | { kind: "nothing"; to: string }
  /** `$QCR_CONFIG` is set: the operator named the file; migrate would be a guess. */
  | { kind: "override"; path: string };

/**
 * Move `<root>/config.toml` into the install's config home. Idempotent: a
 * second run finds the home populated and the checkout empty and says so. It
 * never overwrites a config it did not move — a differing pair is a conflict
 * the operator resolves by hand.
 */
export function migrateConfig(opts: { root: string; env?: InstallEnv }): MigrateOutcome {
  const env = opts.env ?? process.env;
  const override = (env.QCR_CONFIG ?? "").trim();
  if (override !== "") return { kind: "override", path: resolve(override) };
  const from = join(opts.root, CONFIG_FILE);
  const to = join(configHome(env), CONFIG_FILE);
  const inCheckout = existsSync(from);
  const inHome = existsSync(to);
  if (!inCheckout) return inHome ? { kind: "already", to } : { kind: "nothing", to };
  if (inHome) {
    if (!readFileSync(from).equals(readFileSync(to))) return { kind: "conflict", from, to };
    unlinkSync(from);
    return { kind: "deduplicated", from, to };
  }
  mkdirSync(dirname(to), { recursive: true, mode: 0o700 });
  try {
    renameSync(from, to);
  } catch (err) {
    // A checkout and ~/.config on different filesystems: copy, then remove.
    if ((err as NodeJS.ErrnoException).code !== "EXDEV") throw err;
    copyFileSync(from, to);
    unlinkSync(from);
  }
  return { kind: "moved", from, to };
}

/** What `qcr install migrate` prints, and its exit code. Only a conflict fails:
 * every other outcome leaves the install in a state the locator reads. */
export function migrateReport(outcome: MigrateOutcome): { code: number; lines: string[] } {
  switch (outcome.kind) {
    case "moved":
      return {
        code: 0,
        lines: [
          `moved ${outcome.from} → ${outcome.to}`,
          "every reader now finds it there (restart a running daemon or TUI to pick it up).",
          "If this checkout tracked config.toml in git, the move shows as a deletion — the snapshot manifests already exclude the path.",
          "A machine that deploys with scripts/deploy.sh sync|rebuild must keep its config in the checkout until ships the config home — that route refuses a config found anywhere else; move it back to deploy.",
        ],
      };
    case "already":
      return {
        code: 0,
        lines: [`already migrated: the config is ${outcome.to}; nothing in the checkout`],
      };
    case "deduplicated":
      return {
        code: 0,
        lines: [
          `${outcome.to} already held the same bytes — removed the checkout copy ${outcome.from}`,
        ],
      };
    case "conflict":
      return {
        code: 1,
        lines: [
          `refused: ${outcome.from} and ${outcome.to} both exist and differ — nothing was touched.`,
          `Keep the one you want at ${outcome.to}, delete the checkout copy, and re-run.`,
        ],
      };
    case "nothing":
      return {
        code: 0,
        lines: [
          `no config.toml in the checkout or at ${outcome.to} — nothing to move (\`qcr onboard\` writes a new one there)`,
        ],
      };
    case "override":
      return {
        code: 0,
        lines: [
          `QCR_CONFIG names ${outcome.path} — that file is the config; migrate moves nothing while it is set`,
        ],
      };
  }
}
