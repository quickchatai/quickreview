// Profile overrides of the shipped agents and prompts, and the "customised"
// mark they put on a review.
//
// Two profiles may replace a shipped file, and one set of rules says which:
//
//   * the USER profile — the named profile (`[review] profile`) and the
//     profiles it extends, found in the install's config home. On the user's
//     own install it is the final word: it wins over the repo profile.
//   * the REPO profile — `.qcr/` in the reviewed repo, read from the BASE
//     commit with git, never from the checkout or the PR head: a PR cannot
//     change the profile that reviews it. It is the lowest layer, and it can
//     say less: only the files and keys listed below. Everything else in
//     `.qcr/` is dropped and reported, never applied.
//
// What a layer may carry: `agents/<name>.md` and `prompts/<name>.md`, each
// replacing the shipped file of that name (a file with no shipped namesake
// replaces nothing and is reported); and the profile's own settings,
// `profile.toml`, `heuristics.toml` and `addenda/*.md`, which the profile
// loaders read (src/profiles.ts). A repo's `profile.toml` is cut down to
// `ecosystem`, `[lenses]`, `[scan]`, `[posting]` and `[addenda]`.
//
// What no layer can reach: the bash-guard policy (extensions/), the secret
// dirs, and the posting gate (`dry_run`, the MutationGate). None of them is a
// file this module reads or a key a profile loader knows, so a profile has no
// way to name them; the repo profile's extraction also refuses the keys that
// look like them, so the refusal is visible rather than a silent no-op.
//
// The mark: each replacement is hashed against the shipped file (the seed
// manifest's hash for a seed, the file's own hash otherwise). A replacement
// whose hash differs puts the run in `customised` and lists the file in
// `overrides[]`; a byte-identical copy changes nothing and marks nothing. With
// no replacement at all, nothing here runs a model, reads the manifest or
// hands a callback to anyone, so an uncustomised run is the run it always was.
// Seeds themselves are never written: layers are read-only inputs.
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import {
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  writeFileSync,
} from "node:fs";
import { join, relative, resolve, sep } from "node:path";
import { parse as parseToml, stringify as stringifyToml } from "smol-toml";
import { findProfile } from "./profilelookup.js";
import { REPO_LAYER_NAME, resolveProfileChain, type ProfileLookup } from "./profiles.js";

/** The directory in the repo that holds the repo profile. */
export const REPO_PROFILE_DIR = REPO_LAYER_NAME;

/** Where a replacement came from. */
export type OverrideOrigin = "user" | "repo";

/** One directory of override files, `agents/` and `prompts/` under it. */
export interface OverrideLayer {
  origin: OverrideOrigin;
  /** The profile's name (`.qcr` for the repo profile). */
  name: string;
  dir: string;
}

/** One shipped file a layer replaced with different bytes. */
export interface OverrideRecord {
  /** The shipped file, relative to the app root: `agents/pass-security.md`. */
  path: string;
  origin: OverrideOrigin;
  /** The profile whose file won. */
  layer: string;
  /** sha256 of the replacement. */
  sha256: string;
  /** sha256 of the shipped file. */
  shipped_sha256: string;
  /** Whether the shipped file is one of the frozen seeds (CLAUDE.md rule 6). */
  seed: boolean;
}

export interface Customisation {
  customised: boolean;
  overrides: OverrideRecord[];
}

export interface OverrideSet {
  /** Lowest precedence first: the repo profile, then the user's chain. */
  layers: OverrideLayer[];
  /** What a layer carried that was not applied, one line each. */
  ignored: string[];
  /** The loaders' view of the same layers (src/profiles.ts). */
  lookup: ProfileLookup;
}

const SHIPPED_DIRS = ["agents", "prompts"] as const;
const NAME_RE = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;
/** Per-file and total caps on what is pulled out of a repo's `.qcr/`. */
const MAX_FILE_BYTES = 256 * 1024;
const MAX_TOTAL_BYTES = 2 * 1024 * 1024;
const MAX_IGNORED_LINES = 20;

const sha256 = (data: Buffer | string): string => createHash("sha256").update(data).digest("hex");

// ---- the seed manifest ---------------------------------------------------------

/** Where the runtime reads the seed manifest: baked beside the code in the
 * image (`<root>/seed-manifest.json`), else the checkout's pinned copy. */
const MANIFEST_PLACES = ["seed-manifest.json", join("tests", "fixtures", "seed-manifest.json")];

/** The seed manifest's `path → sha256`, or null when the install ships none
 * (then a shipped file is compared by its own hash). Never throws. */
export function loadSeedManifest(root: string): Record<string, string> | null {
  for (const place of MANIFEST_PLACES) {
    try {
      const doc = JSON.parse(readFileSync(join(root, place), "utf8")) as { files?: unknown };
      if (typeof doc.files !== "object" || doc.files === null) continue;
      const files: Record<string, string> = {};
      for (const [k, v] of Object.entries(doc.files)) if (typeof v === "string") files[k] = v;
      return files;
    } catch {
      // absent or unreadable: try the next place
    }
  }
  return null;
}

// ---- reading a layer -------------------------------------------------------------

/** The override files a layer carries: `<dir>/agents/*.md` and
 * `<dir>/prompts/*.md`, regular files only, keyed by shipped path. */
function layerFiles(layer: OverrideLayer, oversized?: string[]): Map<string, string> {
  const out = new Map<string, string>();
  for (const sub of SHIPPED_DIRS) {
    let names: string[];
    try {
      names = readdirSync(join(layer.dir, sub))
        .filter((f) => f.endsWith(".md") && NAME_RE.test(f))
        .sort();
    } catch {
      continue;
    }
    for (const f of names) {
      const file = join(layer.dir, sub, f);
      try {
        const st = lstatSync(file);
        if (st.isFile() && st.size <= MAX_FILE_BYTES) out.set(`${sub}/${f}`, file);
        else if (st.isFile()) oversized?.push(`${sub}/${f}`);
      } catch {
        // gone between the listing and the stat
      }
    }
  }
  return out;
}

/** Each shipped path's winning file, over the layers (later wins). */
function winners(set: OverrideSet): Map<string, { layer: OverrideLayer; file: string }> {
  const out = new Map<string, { layer: OverrideLayer; file: string }>();
  for (const layer of set.layers)
    for (const [path, file] of layerFiles(layer)) out.set(path, { layer, file });
  return out;
}

/** Whether a shipped file of that path exists to be replaced. */
const shipped = (root: string, path: string): boolean => existsSync(join(root, path));

// ---- the repo profile --------------------------------------------------------------

/** Top-level `profile.toml` keys a repo profile may set. */
const REPO_TOML_KEYS = new Set(["ecosystem", "lenses", "scan", "posting", "addenda"]);
/** Keys named for what they would reach, so the refusal says why. */
const GUARDED_KEY = /^(dry_run|github|secrets?(_dir)?|guard|bash_guard|gate|posting_gate)$/i;

const REPO_FILE_RE =
  /^(?:profile\.toml|heuristics\.toml|(?:addenda|agents|prompts)\/[A-Za-z0-9][A-Za-z0-9._-]*\.md)$/;

const GIT_ENV = {
  ...process.env,
  GIT_CONFIG_NOSYSTEM: "1",
  GIT_CONFIG_GLOBAL: "/dev/null",
  GIT_TERMINAL_PROMPT: "0",
};

function gitOut(gitDir: string, args: string[], maxBuffer = MAX_FILE_BYTES * 2): Buffer {
  return execFileSync("git", ["-C", gitDir, ...args], {
    env: GIT_ENV,
    maxBuffer,
    stdio: ["ignore", "pipe", "pipe"],
  });
}

/** `profile.toml` cut down to what a repo may say; the rest named in `ignored`. */
function sanitizeRepoToml(raw: string, ignored: string[]): string {
  let doc: Record<string, unknown>;
  try {
    doc = parseToml(raw);
  } catch (err) {
    throw new Error(
      `the repo profile ${REPO_PROFILE_DIR}/profile.toml is not valid TOML: ${String(err instanceof Error ? err.message : err)}`,
      { cause: err },
    );
  }
  const kept: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(doc)) {
    if (REPO_TOML_KEYS.has(key)) kept[key] = value;
    else
      ignored.push(
        GUARDED_KEY.test(key)
          ? `${REPO_PROFILE_DIR}/profile.toml: "${key}" is guarded; a repo profile cannot set it`
          : `${REPO_PROFILE_DIR}/profile.toml: "${key}" is not a key a repo profile may set`,
      );
  }
  return stringifyToml(kept);
}

/**
 * Extract the repo profile from `ref` (a commit, the review's BASE) into
 * `destDir`, reading git objects only: the working tree and the PR head are
 * never consulted. Only the files in `REPO_FILE_RE` come out, as regular
 * blobs under the size caps; a symlink, a submodule, an oversized file and
 * anything outside the list is dropped and named in `ignored`. `dir` is null
 * when the base has no `.qcr/` (or nothing in it a repo may carry).
 */
export function extractRepoProfile(o: { gitDir: string; ref: string; destDir: string }): {
  dir: string | null;
  ignored: string[];
} {
  if (!/^[0-9a-f]{7,64}$/i.test(o.ref))
    throw new Error(`the repo profile is read from a commit, not ${JSON.stringify(o.ref)}`);
  const ignored: string[] = [];
  let listing: string;
  try {
    listing = gitOut(
      o.gitDir,
      ["ls-tree", "-r", "-z", "--long", o.ref, "--", REPO_PROFILE_DIR],
      8 * 1024 * 1024,
    ).toString("utf8");
  } catch {
    // an unreadable base is no repo profile; the review's own git use reports it
    return { dir: null, ignored };
  }
  let total = 0;
  let wrote = false;
  for (const entry of listing.split("\0").filter(Boolean)) {
    const tab = entry.indexOf("\t");
    const [mode, type, sha, size] = entry.slice(0, tab).split(/\s+/);
    const path = entry.slice(tab + 1);
    const rel = path.slice(REPO_PROFILE_DIR.length + 1);
    const label = `${REPO_PROFILE_DIR}/${rel}`;
    if (type !== "blob" || (mode !== "100644" && mode !== "100755")) {
      ignored.push(`${label}: not a regular file (mode ${mode})`);
      continue;
    }
    if (!REPO_FILE_RE.test(rel)) {
      ignored.push(`${label}: not a file a repo profile may carry`);
      continue;
    }
    const bytes = Number(size);
    if (!Number.isFinite(bytes) || bytes > MAX_FILE_BYTES || total + bytes > MAX_TOTAL_BYTES) {
      ignored.push(`${label}: over the size cap`);
      continue;
    }
    total += bytes;
    let text = gitOut(o.gitDir, ["cat-file", "blob", sha as string]).toString("utf8");
    if (rel === "profile.toml") text = sanitizeRepoToml(text, ignored);
    const dest = join(o.destDir, rel);
    mkdirSync(join(dest, ".."), { recursive: true, mode: 0o700 });
    writeFileSync(dest, text, { mode: 0o600 });
    wrote = true;
  }
  return { dir: wrote ? o.destDir : null, ignored: capIgnored(ignored) };
}

function capIgnored(lines: string[]): string[] {
  return lines.length <= MAX_IGNORED_LINES
    ? lines
    : [...lines.slice(0, MAX_IGNORED_LINES), `…and ${lines.length - MAX_IGNORED_LINES} more`];
}

// ---- the layers of one run -----------------------------------------------------------

/**
 * The override layers of one run: the repo profile (when `repo` names a git
 * dir and a base commit) under the user's named profile and everything it
 * extends. Files with no shipped namesake apply to nothing and are reported.
 */
export function resolveOverrides(o: {
  root: string;
  /** `[review] profile`; "" is no named profile. */
  profile: string;
  lookup?: ProfileLookup;
  repo?: { gitDir: string; baseRef: string; destDir: string };
}): OverrideSet {
  const layers: OverrideLayer[] = [];
  const ignored: string[] = [];
  const lookup: ProfileLookup = { ...(o.lookup ?? {}) };
  if (o.repo) {
    const r = extractRepoProfile({
      gitDir: o.repo.gitDir,
      ref: o.repo.baseRef,
      destDir: o.repo.destDir,
    });
    ignored.push(...r.ignored);
    if (r.dir !== null) {
      layers.push({ origin: "repo", name: REPO_PROFILE_DIR, dir: r.dir });
      lookup.repoProfile = { dir: r.dir };
    }
  }
  // A profile found nowhere is no named chain, as for the tuning loaders.
  const named =
    o.profile === "" ||
    !findProfile({ root: o.root, profile: o.profile, homes: o.lookup?.homes ?? [] })
      ? []
      : resolveProfileChain(o.root, o.profile, o.lookup ?? {});
  for (const l of named) layers.push({ origin: "user", name: l.name, dir: l.dir });
  const set: OverrideSet = { layers, ignored, lookup };
  for (const layer of layers) {
    const over: string[] = [];
    for (const path of layerFiles(layer, over).keys())
      if (!shipped(o.root, path))
        ignored.push(
          `${layer.name}/${path}: no shipped file of that name to replace, so it applies to nothing`,
        );
    for (const path of over) ignored.push(`${layer.name}/${path}: over the size cap`);
  }
  set.ignored = capIgnored(ignored);
  return set;
}

/** Whether any layer carries a file that replaces a shipped one. */
export function hasOverrideFiles(root: string, set: OverrideSet): boolean {
  for (const path of winners(set).keys()) if (shipped(root, path)) return true;
  return false;
}

/**
 * The `readFile` for `buildAgents` and the prompt renderers: a shipped
 * `agents/` or `prompts/` file under `root` reads from the winning layer when
 * one carries it, and everything else reads as usual. Undefined when no layer
 * replaces anything, so callers that pass it through change nothing.
 */
export function overrideReader(
  root: string,
  set: OverrideSet,
): ((p: string) => string) | undefined {
  const won = new Map<string, string>();
  for (const [path, w] of winners(set)) if (shipped(root, path)) won.set(path, w.file);
  if (won.size === 0) return undefined;
  const base = resolve(root);
  return (p: string): string => {
    const rel = relative(base, resolve(p)).split(sep).join("/");
    const file = won.get(rel);
    return readFileSync(file ?? p, "utf8");
  };
}

/**
 * Which shipped files this run's layers replaced with different bytes. The
 * shipped hash is the seed manifest's for a seed, else the file's own. A
 * run with no replacement returns at once, without reading the manifest.
 */
export function assessOverrides(root: string, set: OverrideSet): Customisation {
  const manifest = loadSeedManifest(root);
  const overrides: OverrideRecord[] = [];
  for (const [path, w] of winners(set)) {
    if (!shipped(root, path)) continue;
    const mine = sha256(readFileSync(w.file));
    const seeded = manifest?.[path];
    const theirs = seeded ?? sha256(readFileSync(join(root, path)));
    if (mine === theirs) continue;
    overrides.push({
      path,
      origin: w.layer.origin,
      layer: w.layer.name,
      sha256: mine,
      shipped_sha256: theirs,
      seed: seeded !== undefined,
    });
  }
  overrides.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
  return { customised: overrides.length > 0, overrides };
}

/** The line a report footer and the terminal carry for a customised run. */
export function customisedNote(c: Customisation): string {
  const files = c.overrides.map((o) => `${o.path} (${o.origin} profile)`).join(", ");
  return `Customised: this review ran with ${c.overrides.length} shipped file${c.overrides.length === 1 ? "" : "s"} replaced by a profile: ${files}.`;
}
