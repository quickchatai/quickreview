// Third-party library SOURCES for a review round — read-only, at the PR's
// locked versions.
//
// Why this exists: a PR worktree (`wt/pr-<n>`) is a bare checkout — no
// node_modules, no venv — because the reviewer never installs or runs
// anything (scoping rule 2). Without library sources every pass would guess
// what a library actually does: which encoding names `jschardet` returns,
// which encodings `iconv-lite` accepts, what a default is, when a call throws
// — knowledge a whole class of defects turns on. This module closes the gap
// WITHOUT crossing the no-exec line: the daemon calls it while preparing
// the worktree, it downloads the
// SOURCE of the packages this PR actually touches, at the versions the PR's
// lockfiles pin, and the round prompt lists where they landed so a pass can
// read — and cite — the real code instead of its memory of it.
//
// The boundary, stated once because every choice below serves it:
//
//   * It DOWNLOADS archives over HTTPS from exactly two registries
//     (registry.npmjs.org, pypi.org / files.pythonhosted.org) and UNPACKS
//     them as plain files in Node. It never runs a package manager, an
//     install script, setup.py or a build backend, and it spawns no external
//     tool (no `tar`, no `unzip`) — nothing from an archive ever executes.
//   * Only readable text survives unpacking (source, typings, JSON, docs),
//     and only as REGULAR FILES: symlinks, hardlinks and devices are never
//     created, and every entry path is normalised and confined to the target
//     directory — a registry archive is untrusted input like any other.
//   * It is TOTAL. `prepareDependencySources` never throws: a dead registry,
//     a malformed lockfile, a hostile archive, a blown time budget — each
//     becomes one `skipped` entry with a short reason and the round proceeds.
//     Missing library source costs one finding at worst; a stuck round costs
//     the whole review.
//
// Shape: planning (`planDependencyRequests`) is a pure function of the tree
// and the changed-file list, so which packages matter is unit-testable
// without a network; fetching takes `fetch` by injection; rendering is a
// pure function of the manifest. The lower-level parsers (lockfiles, semver,
// tar, zip) are exported because each is a contract worth pinning on its own.
import { createHash, randomBytes } from "node:crypto";
import {
  lstatSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  realpathSync,
  renameSync,
  rmSync,
  statSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { basename, dirname, join, posix, resolve, sep } from "node:path";
import * as zlib from "node:zlib";

// ---------------------------------------------------------------------------
// Public shapes
// ---------------------------------------------------------------------------

export type DepEcosystem = "npm" | "pypi";

export interface DepRequest {
  ecosystem: DepEcosystem;
  name: string;
  /** The locked version, or null when only a range is known (resolved against the registry at fetch time). */
  version: string | null;
  /** The declared range (package.json / pyproject / requirements), when one is known. */
  range?: string;
  /** Why this package matters to THIS PR, e.g. "added to package.json; imported by src/a.ts". */
  why: string;
}

export interface DepSource {
  ecosystem: DepEcosystem;
  name: string;
  version: string;
  /** Absolute directory holding the unpacked source. */
  path: string;
  why: string;
  files: number;
  bytes: number;
  /**
   * Set ONLY when the version was resolved from a range at fetch time rather
   * than read from a lockfile — the rendered note says so, because "the
   * newest version matching ^1.2" is not necessarily what the PR runs.
   */
  range?: string;
}

export interface DepSkip {
  ecosystem: DepEcosystem;
  name: string;
  reason: string;
}

export interface DepManifest {
  /** The cache root (absolute). */
  dir: string;
  sources: DepSource[];
  skipped: DepSkip[];
}

export interface DepSourcesOptions {
  /** Shared cache root, e.g. `<state>/depcache`. */
  cacheDir: string;
  /** Injected for tests; defaults to the global fetch. */
  fetch?: typeof fetch;
  /** Default 12. */
  maxPackages?: number;
  /** Default 15 MiB, compressed. */
  maxArchiveBytes?: number;
  /** Default 40 MiB per package; only KEPT files count. */
  maxUnpackedBytes?: number;
  /** Default 60 000 — the overall budget; each request is also capped at ~20 s. */
  timeoutMs?: number;
  /** The whole cache's ceiling, default 2 GiB: before each PR the least
   * recently used entries are removed until it fits. */
  maxCacheBytes?: number;
  /** Entries used (prepared or hit) within this window are never evicted,
   * because a round they were advertised to may still be reading them.
   * Default DEFAULT_CACHE_IN_USE_MS; the cap is soft for that long. */
  cacheInUseMs?: number;
  log?: (line: string) => void;
}

/** The files-API shape the daemon already carries (`filename`, `status`, `patch`). */
export interface ChangedFile {
  filename: string;
  status?: string;
  patch?: string;
}

/** Reads a file by ABSOLUTE path; null when it is missing or unreadable. */
export type ReadFileFn = (absPath: string) => string | null;

// ---------------------------------------------------------------------------
// Limits and fixed endpoints
// ---------------------------------------------------------------------------

const MiB = 1024 * 1024;
const DEFAULT_MAX_PACKAGES = 12;
const DEFAULT_MAX_ARCHIVE_BYTES = 15 * MiB;
const DEFAULT_MAX_UNPACKED_BYTES = 40 * MiB;
const DEFAULT_TIMEOUT_MS = 60_000;
const DEFAULT_MAX_CACHE_BYTES = 2048 * MiB;
/** Longer than any round lives (`round_deadline_min`, 75 by default): a
 * source advertised to a running round was touched at its prepare, so it
 * stays readable until that round is over. */
const DEFAULT_CACHE_IN_USE_MS = 2 * 60 * 60 * 1000;
const PER_REQUEST_TIMEOUT_MS = 20_000;
/** Registry JSON is not an archive, but it is still untrusted and unbounded. */
const METADATA_MAX_BYTES = 32 * MiB;
/**
 * The DECOMPRESSED ceiling for one archive. The kept-bytes cap only counts
 * source we keep; this one stops a gzip bomb before it is in memory.
 */
const MAX_EXPANDED_ARCHIVE_BYTES = 256 * MiB;
const MAX_KEPT_FILE_BYTES = 2 * MiB;
/** Kept files per package: bytes alone let an archive of empty files spend
 * inodes without limit. Generous — a real package's sources are far fewer. */
const MAX_KEPT_FILES = 50_000;
/** What the cache cap charges per kept file or created directory on top of
 * its bytes (a block and an inode), so an entry of many tiny files — or of
 * deep directory chains — is sized by what it occupies. */
const CACHE_FILE_OVERHEAD_BYTES = 4096;
const MAX_CHANGED_FILES = 300;
const MAX_SOURCE_FILE_BYTES = 1_000_000;
/** package-lock.json in a large monorepo is routinely several MB. */
const MAX_MANIFEST_BYTES = 64 * MiB;
const CONCURRENCY = 4;
const STALE_TMP_MS = 60 * 60 * 1000;
const MARKER = ".qcr-complete";
const USER_AGENT = "quickreviewd-depsources";

const NPM_REGISTRY = "https://registry.npmjs.org/";
const NPM_ABBREVIATED = "application/vnd.npm.install-v1+json";
const PYPI_ORIGIN = "https://pypi.org/";
const PYPI_API = "https://pypi.org/pypi/";
const PYPI_FILES = "https://files.pythonhosted.org/";

// ---------------------------------------------------------------------------
// Small utilities
// ---------------------------------------------------------------------------

/** A failure that is an ANSWER: it becomes a `skipped` entry with this reason. */
class SkipError extends Error {}

function isObj(x: unknown): x is Record<string, unknown> {
  return typeof x === "object" && x !== null && !Array.isArray(x);
}

function str(x: unknown): string | undefined {
  return typeof x === "string" ? x : undefined;
}

function clip(s: string, n = 48): string {
  return s.length > n ? `${s.slice(0, n - 1)}…` : s;
}

function short(e: unknown): string {
  return clip(e instanceof Error ? e.message : String(e), 120);
}

function fmtBytes(n: number): string {
  return n >= MiB
    ? `${(n / MiB).toFixed(n >= 10 * MiB ? 0 : 1)} MiB`
    : `${Math.ceil(n / 1024)} KiB`;
}

function hostOf(url: string): string {
  try {
    return new URL(url).host;
  } catch {
    return "";
  }
}

/** PEP 503 name normalisation, also applied to import names (`_`/`.` → `-`). */
export function normPy(name: string): string {
  return name.toLowerCase().replace(/[-_.]+/g, "-");
}

/** Repo-relative, forward-slashed, never escaping the tree — or null. */
function normalizeRel(p: string): string | null {
  if (!p || p.includes("\0") || p.includes("\\") || p.startsWith("/")) return null;
  const n = posix.normalize(p);
  if (n === ".." || n.startsWith("../")) return null;
  return n === "." ? "" : n;
}

function relDirOf(relFile: string): string {
  const d = posix.dirname(relFile);
  return d === "." ? "" : d;
}

/** The file's own dir, then each parent up to and including the tree root (""). */
function ancestors(relDir: string): string[] {
  const out: string[] = [];
  let d = relDir;
  for (;;) {
    out.push(d);
    if (!d) break;
    const p = posix.dirname(d);
    d = p === "." ? "" : p;
  }
  return out;
}

// ---------------------------------------------------------------------------
// Import extraction
// ---------------------------------------------------------------------------

const JS_EXTS = new Set([
  ".js",
  ".jsx",
  ".mjs",
  ".cjs",
  ".ts",
  ".tsx",
  ".mts",
  ".cts",
  ".vue",
  ".svelte",
]);
const PY_EXTS = new Set([".py", ".pyi"]);

const NODE_BUILTINS = new Set([
  "assert",
  "async_hooks",
  "buffer",
  "child_process",
  "cluster",
  "console",
  "constants",
  "crypto",
  "dgram",
  "diagnostics_channel",
  "dns",
  "domain",
  "events",
  "fs",
  "http",
  "http2",
  "https",
  "inspector",
  "module",
  "net",
  "os",
  "path",
  "perf_hooks",
  "process",
  "punycode",
  "querystring",
  "readline",
  "repl",
  "stream",
  "string_decoder",
  "sys",
  "timers",
  "tls",
  "trace_events",
  "tty",
  "url",
  "util",
  "v8",
  "vm",
  "wasi",
  "worker_threads",
  "zlib",
]);

// `import … from 'x'` / `export … from 'x'`, `import 'x'`, `require('x')`,
// `import('x')`. Deliberately a regex scan, not a parser: a false positive
// costs nothing (an npm import must still be DECLARED in a manifest or
// lockfile to be requested), a missed import costs one library.
//
// The `… from 'x'` form is NOT one regex: an `import … from` pattern needs an
// unbounded gap, and a lazy gap re-scans the whole suffix at every `import`
// token that no `from` follows — quadratic on a PR author's file, on the
// daemon's event loop, before the preparation deadline exists. Instead each
// `from 'x'` is found once and the text back to the previous `;` or quote is
// checked for an `import`/`export` head: the segments are disjoint, so the
// scan is linear.
// The specifier admits no whitespace (no package name has any), so a quoted
// `'from'` in ordinary code cannot swallow the next real `from '…'` as its spec.
const JS_FROM_RE = /\bfrom\s*(['"`])([^'"`\s]+)\1/g;
const JS_FROM_HEAD_RE = /(?:^|[^\w$.])(?:import|export)\s/;
const JS_IMPORT_RES: readonly RegExp[] = [
  /(?:^|[^\w$.])import\s*(['"`])([^'"`\n]+)\1/g,
  /(?:^|[^\w$.])(?:require|import)\s*\(\s*(['"`])([^'"`\n]+)\1\s*\)/g,
];

/** Raw module specifiers imported by a JS/TS source (order of first appearance). */
export function extractJsImports(src: string): string[] {
  // Whole-line comments only: stripping `/* … */` spans is unsafe without a
  // tokenizer (a glob string like 'src/*' would open a "comment" that eats
  // real imports), and inline comments are harmless here.
  const text = src
    .split("\n")
    .filter((l) => {
      const t = l.trimStart();
      return !(t.startsWith("//") || t.startsWith("*") || t.startsWith("/*"));
    })
    .join("\n");
  const out: string[] = [];
  const seen = new Set<string>();
  const add = (spec: string | undefined): void => {
    if (spec !== undefined && !seen.has(spec)) {
      seen.add(spec);
      out.push(spec);
    }
  };
  for (const m of text.matchAll(JS_FROM_RE)) {
    let start = m.index;
    while (start > 0 && !";'\"`".includes(text[start - 1] ?? "")) start--;
    if (JS_FROM_HEAD_RE.test(text.slice(start, m.index))) add(m[2]);
  }
  for (const re of JS_IMPORT_RES) for (const m of text.matchAll(re)) add(m[2]);
  return out;
}

const NPM_NAME_RE = /^(?:@[a-z0-9~][a-z0-9._~-]*\/)?[a-z0-9~][a-z0-9._~-]*$/i;

/**
 * The npm package a bare specifier names (`@scope/name` or the first path
 * segment), or null for relative/absolute paths, `node:`/URL-ish schemes,
 * Node builtins (incl. `fs/promises`), aliases like `@/x` / `~/x` / `#x`, and
 * anything templated.
 */
export function npmPackageName(spec: string): string | null {
  if (!spec || /[\s{}$]/.test(spec)) return null;
  if (/^[./#~]/.test(spec) || spec.includes(":")) return null;
  const parts = spec.split("/");
  const first = parts[0] ?? "";
  let name: string;
  if (first.startsWith("@")) {
    const second = parts[1];
    if (first === "@" || !second) return null;
    name = `${first}/${second}`;
  } else {
    if (NODE_BUILTINS.has(first)) return null;
    name = first;
  }
  return NPM_NAME_RE.test(name) ? name : null;
}

const PY_STDLIB = new Set([
  "__future__",
  "abc",
  "argparse",
  "array",
  "ast",
  "asyncio",
  "atexit",
  "base64",
  "binascii",
  "bisect",
  "builtins",
  "bz2",
  "calendar",
  "cmath",
  "codecs",
  "collections",
  "colorsys",
  "compileall",
  "concurrent",
  "configparser",
  "contextlib",
  "contextvars",
  "copy",
  "copyreg",
  "cProfile",
  "csv",
  "ctypes",
  "curses",
  "dataclasses",
  "datetime",
  "dbm",
  "decimal",
  "difflib",
  "dis",
  "doctest",
  "email",
  "encodings",
  "enum",
  "errno",
  "faulthandler",
  "fcntl",
  "filecmp",
  "fileinput",
  "fnmatch",
  "fractions",
  "ftplib",
  "functools",
  "gc",
  "getopt",
  "getpass",
  "gettext",
  "glob",
  "graphlib",
  "grp",
  "gzip",
  "hashlib",
  "heapq",
  "hmac",
  "html",
  "http",
  "imaplib",
  "importlib",
  "inspect",
  "io",
  "ipaddress",
  "itertools",
  "json",
  "keyword",
  "linecache",
  "locale",
  "logging",
  "lzma",
  "mailbox",
  "marshal",
  "math",
  "mimetypes",
  "mmap",
  "multiprocessing",
  "numbers",
  "operator",
  "optparse",
  "os",
  "pathlib",
  "pdb",
  "pickle",
  "pkgutil",
  "platform",
  "plistlib",
  "poplib",
  "posix",
  "pprint",
  "profile",
  "pstats",
  "pty",
  "pwd",
  "py_compile",
  "pydoc",
  "queue",
  "quopri",
  "random",
  "re",
  "reprlib",
  "resource",
  "runpy",
  "sched",
  "secrets",
  "select",
  "selectors",
  "shelve",
  "shlex",
  "shutil",
  "signal",
  "site",
  "smtplib",
  "socket",
  "socketserver",
  "sqlite3",
  "ssl",
  "stat",
  "statistics",
  "string",
  "stringprep",
  "struct",
  "subprocess",
  "symtable",
  "sys",
  "sysconfig",
  "syslog",
  "tarfile",
  "tempfile",
  "termios",
  "textwrap",
  "threading",
  "time",
  "timeit",
  "tkinter",
  "token",
  "tokenize",
  "tomllib",
  "trace",
  "traceback",
  "tracemalloc",
  "tty",
  "types",
  "typing",
  "unicodedata",
  "unittest",
  "urllib",
  "uuid",
  "venv",
  "warnings",
  "wave",
  "weakref",
  "webbrowser",
  "wsgiref",
  "xml",
  "xmlrpc",
  "zipapp",
  "zipfile",
  "zipimport",
  "zlib",
  "zoneinfo",
]);

/**
 * Import name → distribution name, for the well-known packages whose import
 * name tells you nothing about what to download. Keys are exact import paths
 * (case matters: `PIL`, `Crypto`).
 */
const PY_ALIASES: Readonly<Record<string, string>> = {
  yaml: "pyyaml",
  bs4: "beautifulsoup4",
  PIL: "pillow",
  cv2: "opencv-python",
  sklearn: "scikit-learn",
  dateutil: "python-dateutil",
  jwt: "pyjwt",
  "google.protobuf": "protobuf",
  attr: "attrs",
  dotenv: "python-dotenv",
  magic: "python-magic",
  docx: "python-docx",
  pptx: "python-pptx",
  Crypto: "pycryptodome",
  OpenSSL: "pyopenssl",
  git: "gitpython",
  jose: "python-jose",
  multipart: "python-multipart",
  slugify: "python-slugify",
};

export interface PyImport {
  /** The dotted module (`a.b` for `import a.b` and `from a.b import c`). */
  module: string;
  /** For `from m import a, b`: the imported names (they may be submodules). */
  names: string[];
}

const PY_MODULE_RE = /^[A-Za-z_]\w*(?:\.[A-Za-z_]\w*)*$/;

function stripPyComment(line: string): string {
  const i = line.indexOf("#");
  return i < 0 ? line : line.slice(0, i);
}

/** Absolute imports of a Python source; relative (`from .`) imports are skipped. */
export function extractPythonImports(src: string): PyImport[] {
  const lines = src.replace(/\\\r?\n/g, " ").split(/\r?\n/);
  const out: PyImport[] = [];
  for (let i = 0; i < lines.length; i++) {
    for (const stmt of stripPyComment(lines[i] ?? "").split(";")) {
      const imp = /^\s*import\s+(.+)$/.exec(stmt);
      if (imp) {
        for (const part of (imp[1] ?? "").split(",")) {
          const mod = (part.trim().split(/\s+as\s+/)[0] ?? "").trim();
          if (PY_MODULE_RE.test(mod)) out.push({ module: mod, names: [] });
        }
        continue;
      }
      const from = /^\s*from\s+([A-Za-z_][\w.]*)\s+import\s+(.*)$/.exec(stmt);
      if (!from) continue;
      let rest = from[2] ?? "";
      // `from x import (\n a,\n b\n)` — gather the parenthesised continuation.
      if (rest.includes("(") && !rest.includes(")")) {
        while (++i < lines.length) {
          const l = stripPyComment(lines[i] ?? "");
          rest += ` ${l}`;
          if (l.includes(")")) break;
        }
      }
      const names = rest
        .replace(/[()]/g, " ")
        .split(",")
        .map((s) => (s.trim().split(/\s+as\s+/)[0] ?? "").trim())
        .filter((n) => /^[A-Za-z_]\w*$/.test(n));
      const module = from[1] ?? "";
      if (PY_MODULE_RE.test(module)) out.push({ module, names });
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// Lockfiles and manifests
// ---------------------------------------------------------------------------

export interface LockEntry {
  version: string;
  /** yarn: the header specs (ranges) this entry satisfies; pnpm: the
   * importer's `specifier`. */
  specs?: string[];
  /** package-lock: a workspace dir whose own node_modules holds this copy;
   * pnpm: the (non-root) importer that pins it. */
  scope?: string;
  /** package-lock: `resolved` names a source other than the public npm
   * registry (a private registry, git, a tarball URL) — the same-named
   * registry.npmjs.org release is not what the PR runs. */
  foreign?: true;
}

export interface NpmLock {
  entries: Map<string, LockEntry[]>;
  /** Workspace / link / file packages — first-party, never downloaded. */
  links: Set<string>;
}

function emptyLock(): NpmLock {
  return { entries: new Map(), links: new Set() };
}

/** Per lock: `(name, version, scope)` → its entry plus the spec set, so each
 * insertion is O(1). A lockfile is PR-controlled and parsed on the event loop
 * before any deadline exists; a linear find per entry made one package with
 * 100k versions a daemon stall. */
const lockIndex = new WeakMap<NpmLock, Map<string, { entry: LockEntry; specs: Set<string> }>>();

function addLock(lock: NpmLock, name: string, entry: LockEntry): void {
  let index = lockIndex.get(lock);
  if (!index) lockIndex.set(lock, (index = new Map()));
  const key = `${name}\0${entry.version}\0${entry.scope ?? ""}\0${entry.scope === undefined ? 0 : 1}`;
  const have = index.get(key);
  if (!have) {
    const list = lock.entries.get(name) ?? [];
    if (entry.specs) entry.specs = [...new Set(entry.specs)];
    list.push(entry);
    lock.entries.set(name, list);
    index.set(key, { entry, specs: new Set(entry.specs ?? []) });
    return;
  }
  for (const s of entry.specs ?? []) {
    if (have.specs.has(s)) continue;
    have.specs.add(s);
    (have.entry.specs ??= []).push(s);
  }
}

const VERSION_LIKE = /^\d+\.\d+\.\d+/;

/** The value the resolver hands on as the range of an npm package locked to a
 * non-npmjs source: spelled like the Python foreign pin, so it is a
 * non-registry range and preparation SKIPS it. */
const NPM_FOREIGN_PIN = "@ non-npmjs source";

/** A package-lock `resolved` that is not the public registry. Absent means
 * the registry (npm omits it in some lock shapes). */
function isForeignResolved(resolved: unknown): boolean {
  if (typeof resolved !== "string" || resolved === "") return false;
  try {
    const u = new URL(resolved);
    return !(
      u.protocol === "https:" &&
      (u.hostname === "registry.npmjs.org" || u.hostname === "registry.yarnpkg.com")
    );
  } catch {
    return true;
  }
}

/** package-lock.json / npm-shrinkwrap.json, lockfileVersion 1, 2 and 3. */
export function parsePackageLock(text: string): NpmLock | null {
  let doc: unknown;
  try {
    doc = JSON.parse(text);
  } catch {
    return null;
  }
  if (!isObj(doc)) return null;
  const lock = emptyLock();
  if (isObj(doc.packages)) {
    for (const [key, val] of Object.entries(doc.packages)) {
      if (!key || !isObj(val)) continue;
      const idx = key.lastIndexOf("node_modules/");
      if (idx < 0) {
        // A workspace package's own entry ("packages/web": {name, version}).
        const n = str(val.name);
        if (n) lock.links.add(n);
        continue;
      }
      const name = key.slice(idx + "node_modules/".length);
      const prefix = key.slice(0, idx);
      if (val.link === true) {
        lock.links.add(name);
        continue;
      }
      const version = str(val.version);
      if (!version || !VERSION_LIKE.test(version)) continue;
      const foreign = isForeignResolved(val.resolved) ? { foreign: true as const } : {};
      if (prefix === "") addLock(lock, name, { version, ...foreign });
      // Nested under a WORKSPACE (not under another package): that
      // workspace's own copy, which beats the hoisted one for its files.
      else if (!prefix.includes("node_modules/"))
        addLock(lock, name, { version, scope: prefix.replace(/\/$/, ""), ...foreign });
    }
  } else if (isObj(doc.dependencies)) {
    for (const [name, val] of Object.entries(doc.dependencies)) {
      if (!isObj(val)) continue;
      const version = str(val.version);
      if (!version) continue;
      if (/^(file|link):/.test(version)) lock.links.add(name);
      else if (VERSION_LIKE.test(version))
        addLock(
          lock,
          name,
          isForeignResolved(val.resolved) ? { version, foreign: true } : { version },
        );
    }
  }
  return lock;
}

/** Split a yarn/berry header spec (`@scope/x@^1`, `x@npm:^1`) into name and range. */
function splitYarnSpec(spec: string): { name: string; range: string } | null {
  const at = spec.indexOf("@", 1);
  if (at <= 0) return null;
  return { name: spec.slice(0, at), range: spec.slice(at + 1) };
}

/** Record one yarn.lock block: its header specs locked at `version`, foreign
 * when its `resolved` URL is off the public registry. */
function addYarnBlock(
  lock: NpmLock,
  specs: string[],
  version: string,
  resolved: string | null,
): void {
  const ranges = new Map<string, string[]>();
  for (const spec of specs) {
    const s = splitYarnSpec(spec);
    if (!s) continue;
    const range = s.range.startsWith("npm:") ? s.range.slice(4) : s.range;
    if (/^(workspace|link|portal|file):/.test(range)) {
      lock.links.add(s.name);
      continue;
    }
    ranges.set(s.name, [...(ranges.get(s.name) ?? []), range]);
  }
  if (!VERSION_LIKE.test(version)) return;
  const foreign = isForeignResolved(resolved) ? { foreign: true as const } : {};
  for (const [name, rs] of ranges) addLock(lock, name, { version, specs: rs, ...foreign });
}

/** yarn.lock — classic v1 (`version "1.2.3"`) and berry (`version: 1.2.3`).
 * A classic entry's `resolved` URL off the public registry marks it foreign
 * (as in package-lock). Berry carries no registry URL — its registry lives in
 * .yarnrc — so a berry entry cannot be judged that way. */
export function parseYarnLock(text: string): NpmLock {
  const lock = emptyLock();
  let specs: string[] | null = null;
  let version: string | null = null;
  let resolved: string | null = null;
  for (const raw of text.split(/\r?\n/)) {
    if (!raw.trim() || raw.trimStart().startsWith("#")) continue;
    if (!/^\s/.test(raw)) {
      if (specs && version !== null) addYarnBlock(lock, specs, version, resolved);
      version = resolved = null;
      specs = raw.endsWith(":")
        ? raw
            .slice(0, -1)
            .replace(/["']/g, "")
            .split(",")
            .map((s) => s.trim())
            .filter(Boolean)
        : null;
      continue;
    }
    if (!specs) continue;
    if (version === null) {
      const m = /^ {2}version:?\s+"?([^"\s]+)"?\s*$/.exec(raw);
      if (m) {
        version = m[1] ?? "";
        continue;
      }
    }
    if (resolved === null) {
      const r = /^ {2}resolved\s+"?([^"\s]+)"?\s*$/.exec(raw);
      if (r) resolved = r[1] ?? "";
    }
  }
  if (specs && version !== null) addYarnBlock(lock, specs, version, resolved);
  return lock;
}

/** One pnpm package key → name + version (v5 `/x/1.2.3_peer`, v6 `/x@1.2.3(peer)`, v9 `x@1.2.3`). */
function splitPnpmKey(key: string): { name: string; version: string } | null {
  const v5 = /^(@[^/]+\/[^/@]+|[^/@]+)\/(\d[^/_(]*)(?:_.*)?$/.exec(key);
  if (v5) return { name: v5[1] ?? "", version: v5[2] ?? "" };
  const at = key.lastIndexOf("@");
  if (at <= 0) return null;
  return { name: key.slice(0, at), version: key.slice(at + 1) };
}

/**
 * pnpm-lock.yaml — the `packages:` (and v9 `snapshots:`) keys are the whole
 * inventory, but the version a DIRECT dependency resolves to is the importer's
 * own pin (`importers:` in v6+/workspaces, the top-level `dependencies:` of a
 * v5 single project). Those pins are recorded with their specifier (and the
 * importer dir as scope), so pickLocked takes the importer's resolution rather
 * than the newest copy some transitive dependency pulled in.
 */
export function parsePnpmLock(text: string): NpmLock {
  const lock = emptyLock();
  let section: "packages" | "importers" | "root" | "other" = "other";
  let rootGroup: "deps" | "specs" = "deps";
  let importer = ".";
  let group: "deps" | "specs" | null = null;
  let dep: string | null = null;
  // importer → name → { spec, version }
  const pins = new Map<string, Map<string, { spec?: string; version?: string }>>();
  const pin = (imp: string, name: string): { spec?: string; version?: string } => {
    const m = pins.get(imp) ?? new Map<string, { spec?: string; version?: string }>();
    pins.set(imp, m);
    const p = m.get(name) ?? {};
    m.set(name, p);
    return p;
  };
  const unquote = (x: string): string => x.trim().replace(/^['"]|['"]$/g, "");
  const DEP_GROUP = /^(dependencies|devDependencies|optionalDependencies|specifiers):\s*$/;
  for (const raw of text.split(/\r?\n/)) {
    if (/^\S/.test(raw)) {
      const g = DEP_GROUP.exec(raw);
      section = /^(packages|snapshots):\s*$/.test(raw)
        ? "packages"
        : /^importers:\s*$/.test(raw)
          ? "importers"
          : g
            ? "root"
            : "other";
      if (g) rootGroup = g[1] === "specifiers" ? "specs" : "deps";
      dep = null;
      continue;
    }
    if (section === "packages") {
      const m = /^ {2}(\S.*?):\s*$/.exec(raw);
      if (!m) continue;
      let key = unquote(m[1] ?? "");
      if (key.startsWith("/")) key = key.slice(1);
      const paren = key.indexOf("(");
      if (paren > 0) key = key.slice(0, paren);
      const nv = splitPnpmKey(key);
      if (nv && nv.name && VERSION_LIKE.test(nv.version))
        addLock(lock, nv.name, { version: nv.version });
    } else if (section === "root") {
      // v5 single project: `  name: value` directly under the section;
      // v6 single project: `  name:` then `    specifier:` / `    version:`.
      const head = /^ {2}(\S.*?):\s*(.*?)\s*$/.exec(raw);
      if (head) {
        const name = unquote(head[1] ?? "");
        const inline = unquote(head[2] ?? "");
        dep = inline ? null : name;
        if (inline) {
          const p = pin(".", name);
          if (rootGroup === "specs") p.spec = inline;
          else p.version = inline;
        }
        continue;
      }
      const kv = /^ {4}(specifier|version):\s*(.*?)\s*$/.exec(raw);
      if (kv && dep && rootGroup === "deps") {
        const p = pin(".", dep);
        if (kv[1] === "specifier") p.spec = unquote(kv[2] ?? "");
        else p.version = unquote(kv[2] ?? "");
      }
    } else if (section === "importers") {
      const imp = /^ {2}(\S.*?):\s*$/.exec(raw);
      if (imp) {
        importer = unquote(imp[1] ?? ".");
        group = null;
        dep = null;
        continue;
      }
      const g = /^ {4}(\S+):\s*$/.exec(raw);
      if (g) {
        const k = DEP_GROUP.exec(g[1] + ":");
        group = k ? (k[1] === "specifiers" ? "specs" : "deps") : null;
        dep = null;
        continue;
      }
      if (!group) continue;
      const d = /^ {6}(\S.*?):\s*(.*?)\s*$/.exec(raw);
      if (d) {
        const name = unquote(d[1] ?? "");
        const inline = unquote(d[2] ?? "");
        dep = inline ? null : name;
        if (inline) {
          // v5 workspace form: `      name: 1.2.3` / specifiers `      name: ^1`.
          const p = pin(importer, name);
          if (group === "specs") p.spec = inline;
          else p.version = inline;
        }
        continue;
      }
      const kv = /^ {8}(specifier|version):\s*(.*?)\s*$/.exec(raw);
      if (kv && dep && group === "deps") {
        const p = pin(importer, dep);
        if (kv[1] === "specifier") p.spec = unquote(kv[2] ?? "");
        else p.version = unquote(kv[2] ?? "");
      }
    }
  }
  for (const [imp, deps] of pins) {
    for (const [name, p] of deps) {
      // `1.2.0(react@18)` (v6+) / `1.2.0_react@18` (v5): the peer suffix is not the version.
      const version = (p.version ?? "").replace(/[(_].*$/, "");
      if (!VERSION_LIKE.test(version)) continue;
      const entry: LockEntry = { version };
      if (p.spec) entry.specs = [p.spec];
      const scope = imp.replace(/^\.\//, "").replace(/\/$/, "");
      if (scope && scope !== ".") entry.scope = scope;
      addLock(lock, name, entry);
    }
  }
  return lock;
}

/** The value parsePythonLock records for a package locked to a source other
 * than public PyPI: `@ <kind> source` — spelled as a PEP 508 direct reference,
 * so the resolver hands it on as a non-registry range and preparation SKIPS
 * it, instead of fetching PyPI's same-named release and calling it the lock. */
const PY_FOREIGN_PIN_PREFIX = "@ ";

/**
 * uv.lock / poetry.lock: `[[package]]` blocks with `name` and `version`. A
 * line scanner, not a TOML parser — only the block's own top-level keys are
 * read, and local (editable / virtual / directory) packages are first-party.
 * A package from git, a URL or a non-PyPI index maps to `@ <kind> source`
 * (PY_FOREIGN_PIN_PREFIX), never to its bare version.
 */
export function parsePythonLock(text: string): Map<string, string> {
  const out = new Map<string, string>();
  let cur: { name?: string; version?: string; local?: boolean; foreign?: string } | null = null;
  let where: "top" | "source" | "other" = "other";
  const flush = (): void => {
    if (cur?.name && cur.version && !cur.local) {
      const n = normPy(cur.name);
      if (!out.has(n))
        out.set(n, cur.foreign ? `${PY_FOREIGN_PIN_PREFIX}${cur.foreign} source` : cur.version);
    }
  };
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (line === "[[package]]") {
      flush();
      cur = {};
      where = "top";
      continue;
    }
    if (line.startsWith("[")) {
      where = line === "[package.source]" ? "source" : "other";
      if (!/^\[\[?package[.\]]/.test(line)) {
        flush();
        cur = null;
      }
      continue;
    }
    if (!cur) continue;
    if (where === "top") {
      const kv = /^(name|version)\s*=\s*"([^"]*)"/.exec(line);
      if (kv) cur[kv[1] as "name" | "version"] = kv[2] ?? "";
      if (/^source\s*=\s*\{[^}]*\b(editable|virtual|directory|path)\s*=/.test(line))
        cur.local = true;
      else {
        // uv: `source = { registry = "…" }` is PyPI only at pypi.org; git /
        // url / any other index is a different artifact under the same name.
        const src = /^source\s*=\s*\{\s*(\w+)\s*=\s*"([^"]*)"/.exec(line);
        if (
          src &&
          !(src[1] === "registry" && /^https:\/\/pypi\.org\/simple\/?$/.test(src[2] ?? ""))
        )
          cur.foreign = src[1] ?? "other";
      }
    } else if (where === "source") {
      // poetry: a `[package.source]` block at all means not-PyPI (PyPI
      // packages carry none); directory/file are local, the rest foreign.
      const t = /^type\s*=\s*"([^"]*)"/.exec(line);
      if (t && /^(directory|file)$/.test(t[1] ?? "")) cur.local = true;
      else if (t) cur.foreign = t[1] || "other";
    }
  }
  flush();
  return out;
}

/**
 * Pipfile.lock: `default`/`develop` → `{ name: { version: "==1.2.3" } }`. An
 * entry's `index` names one of `_meta.sources` (none = the first, pipenv's
 * default); a package from any index other than public PyPI — or from an
 * index the lock does not declare — maps to `@ index source`
 * (PY_FOREIGN_PIN_PREFIX), exactly as parsePythonLock does for uv/poetry.
 */
export function parsePipfileLock(text: string): Map<string, string> {
  const out = new Map<string, string>();
  let doc: unknown;
  try {
    doc = JSON.parse(text);
  } catch {
    return out;
  }
  if (!isObj(doc)) return out;
  const indexUrl = new Map<string, string>();
  let defaultIndex: string | undefined;
  const meta = doc._meta;
  if (isObj(meta) && Array.isArray(meta.sources)) {
    for (const src of meta.sources) {
      const n = isObj(src) ? str(src.name) : undefined;
      if (n === undefined || !isObj(src)) continue;
      defaultIndex ??= n;
      if (!indexUrl.has(n)) indexUrl.set(n, str(src.url) ?? "");
    }
  }
  const isPypi = (index: string | undefined): boolean => {
    // No sources declared: pipenv's default source, named "pypi", is PyPI.
    if (indexUrl.size === 0) return index === undefined || index === "pypi";
    // pypi.python.org is PyPI's legacy host — older Pipfiles still name it.
    return /^https:\/\/pypi\.(?:python\.)?org\/simple\/?$/i.test(
      (index === undefined ? undefined : indexUrl.get(index)) ?? "",
    );
  };
  for (const section of ["default", "develop"]) {
    const sec = doc[section];
    if (!isObj(sec)) continue;
    for (const [name, val] of Object.entries(sec)) {
      if (!isObj(val)) continue;
      const v = str(val.version);
      if (!v?.startsWith("==")) continue;
      const index = str(val.index) ?? defaultIndex;
      out.set(normPy(name), isPypi(index) ? v.slice(2) : `${PY_FOREIGN_PIN_PREFIX}index source`);
    }
  }
  return out;
}

export interface PyReq {
  /** The exact `==` version, when the requirement pins one. */
  pin: string | null;
  /** The specifier as written (`>=2,<3`, `^1.2`, `*` when none, `@ url` for direct references). */
  range: string;
}

/** One PEP 508 requirement string → normalised name + spec. */
function parsePep508(line: string): ({ name: string } & PyReq) | null {
  const s = (line.split(";")[0] ?? "").replace(/\s--hash[=\s]\S+/g, "").trim();
  const m = /^([A-Za-z0-9][A-Za-z0-9._-]*)\s*(?:\[[^\]]*\])?\s*(.*)$/.exec(s);
  if (!m) return null;
  const name = normPy(m[1] ?? "");
  let spec = (m[2] ?? "").trim();
  if (spec.startsWith("@")) return { name, pin: null, range: spec };
  spec = spec.replace(/^\(|\)$/g, "").trim();
  if (!spec) return { name, pin: null, range: "*" };
  const pin = /^===?\s*([0-9][0-9A-Za-z.+!_-]*)$/.exec(spec);
  return { name, pin: pin?.[1] ?? null, range: spec };
}

/** requirements*.txt / *.in: every requirement line (options, `-r`, `-e` and comments skipped). */
export function parseRequirements(text: string): Map<string, PyReq> {
  const out = new Map<string, PyReq>();
  for (const raw of text.replace(/\\\r?\n/g, " ").split(/\r?\n/)) {
    const line = raw.replace(/(^|\s)#.*$/, "").trim();
    if (!line || line.startsWith("-")) continue;
    const r = parsePep508(line);
    if (r && !out.has(r.name)) out.set(r.name, { pin: r.pin, range: r.range });
  }
  return out;
}

function stripTomlStrings(line: string): string {
  return line.replace(/"(?:[^"\\]|\\.)*"|'[^']*'/g, "");
}

function tomlStrings(line: string): string[] {
  return [...line.matchAll(/"((?:[^"\\]|\\.)*)"|'([^']*)'/g)].map((m) => m[1] ?? m[2] ?? "");
}

/**
 * pyproject.toml dependency declarations: PEP 621 `[project] dependencies`
 * and `[project.optional-dependencies]`, PEP 735 `[dependency-groups]`,
 * `[tool.uv] dev-dependencies`, and Poetry's dependency tables. Poetry path
 * dependencies come back as range `file:<path>` (first-party).
 */
export function parsePyprojectDeps(text: string): Map<string, PyReq> {
  const out = new Map<string, PyReq>();
  const add = (s: string): void => {
    const r = parsePep508(s);
    if (r && r.name !== "python" && !out.has(r.name))
      out.set(r.name, { pin: r.pin, range: r.range });
  };
  let table = "";
  let inArray = false;
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith("#")) continue;
    if (inArray) {
      for (const s of tomlStrings(line)) add(s);
      if (stripTomlStrings(line).includes("]")) inArray = false;
      continue;
    }
    const hdr = /^\[\[?([^\]]+)\]\]?\s*(?:#.*)?$/.exec(line);
    if (hdr) {
      table = (hdr[1] ?? "").trim().replace(/\s+/g, "");
      continue;
    }
    const pep621 =
      (table === "project" && /^dependencies\s*=/.test(line)) ||
      ((table === "project.optional-dependencies" || table === "dependency-groups") &&
        /^[\w.-]+\s*=\s*\[/.test(line)) ||
      (table === "tool.uv" && /^dev-dependencies\s*=/.test(line));
    if (pep621) {
      const after = line.slice(line.indexOf("=") + 1);
      for (const s of tomlStrings(after)) add(s);
      if (!stripTomlStrings(after).includes("]")) inArray = true;
      continue;
    }
    const poetry =
      table === "tool.poetry.dependencies" ||
      table === "tool.poetry.dev-dependencies" ||
      /^tool\.poetry\.group\.[^.]+\.dependencies$/.test(table);
    if (!poetry) continue;
    const kv = /^([A-Za-z0-9][A-Za-z0-9._-]*)\s*=\s*(.+)$/.exec(line);
    if (!kv) continue;
    const name = normPy(kv[1] ?? "");
    if (name === "python" || out.has(name)) continue;
    const val = (kv[2] ?? "").trim();
    let range = "*";
    if (val.startsWith('"') || val.startsWith("'")) range = tomlStrings(val)[0] ?? "*";
    else if (val.startsWith("{")) {
      const version = /\bversion\s*=\s*["']([^"']*)["']/.exec(val);
      const path = /\bpath\s*=\s*["']([^"']*)["']/.exec(val);
      const other = /\b(git|url)\s*=\s*["']([^"']*)["']/.exec(val);
      if (path) range = `file:${path[1] ?? ""}`;
      else if (other) range = `@ ${other[2] ?? ""}`;
      else if (version) range = version[1] ?? "*";
    }
    const pin = /^(?:==)?\s*(\d[0-9A-Za-z.+!_-]*)$/.exec(range);
    out.set(name, { pin: pin?.[1] ?? null, range });
  }
  return out;
}

interface PackageJsonInfo {
  name?: string;
  deps: Map<string, string>;
}

const NPM_DEP_SECTIONS = [
  "dependencies",
  "devDependencies",
  "peerDependencies",
  "optionalDependencies",
];

function parsePackageJson(text: string): PackageJsonInfo | null {
  let doc: unknown;
  try {
    doc = JSON.parse(text);
  } catch {
    return null;
  }
  if (!isObj(doc)) return null;
  const deps = new Map<string, string>();
  for (const section of NPM_DEP_SECTIONS) {
    const sec = doc[section];
    if (!isObj(sec)) continue;
    for (const [n, r] of Object.entries(sec))
      if (typeof r === "string" && !deps.has(n)) deps.set(n, r);
  }
  const name = str(doc.name);
  return name ? { name, deps } : { deps };
}

/** A declared range that points INSIDE the repo — first-party, never fetched. */
function isLocalRange(range: string): boolean {
  return /^(workspace|link|file|portal):/.test(range);
}

/**
 * A declared range the registry cannot resolve: git / URL / tarball / GitHub
 * shorthand / npm alias (`npm:x@1`) / a PEP 508 direct reference (`@ url`).
 * No semver range or PEP 440 specifier contains any of these characters.
 */
function isNonRegistryRange(range: string): boolean {
  return /[:/@#]/.test(range);
}

// ---------------------------------------------------------------------------
// Manifest edits in the diff
// ---------------------------------------------------------------------------

export interface ManifestEdit {
  name: string;
  kind: "added" | "bumped";
  range: string | null;
}

const NPM_DEP_LINE = /^\s*"([^"]+)"\s*:\s*"([^"]*)"\s*,?\s*$/;

/**
 * Dependencies a package.json patch adds (or re-ranges). The HEAD file is the
 * authority on which added lines are dependencies; the patch's own section
 * tracking is the fallback when the head file cannot be parsed.
 */
export function npmManifestEdits(patch: string, headText: string | null): ManifestEdit[] {
  const added = new Map<string, string>();
  const addedInDeps = new Set<string>();
  const removed = new Map<string, string>();
  let section: "deps" | "other" | "unknown" = "unknown";
  for (const line of patch.split(/\r?\n/)) {
    if (line.startsWith("@@")) {
      section = "unknown";
      continue;
    }
    const sign = line[0];
    const body = line.slice(1);
    if (sign === "-") {
      const m = NPM_DEP_LINE.exec(body);
      if (m?.[1]) removed.set(m[1], m[2] ?? "");
      continue;
    }
    if (sign !== "+" && sign !== " ") continue;
    if (
      /"(dependencies|devDependencies|peerDependencies|optionalDependencies)"\s*:\s*\{/.test(body)
    ) {
      section = "deps";
      continue;
    }
    if (/"[^"]*"\s*:\s*\{/.test(body)) {
      section = "other";
      continue;
    }
    if (/^\s*\}/.test(body)) {
      section = section === "deps" ? "other" : "unknown";
      continue;
    }
    if (sign !== "+") continue;
    const m = NPM_DEP_LINE.exec(body);
    if (!m?.[1]) continue;
    added.set(m[1], m[2] ?? "");
    if (section === "deps") addedInDeps.add(m[1]);
  }
  const head = headText !== null ? parsePackageJson(headText) : null;
  const out: ManifestEdit[] = [];
  for (const [name, range] of added) {
    const isDep = head ? head.deps.has(name) : addedInDeps.has(name);
    // Same range removed and re-added is a re-flowed line (the previous last
    // entry gaining a trailing comma when a dependency is appended), not an edit.
    if (!isDep || removed.get(name) === range) continue;
    out.push({
      name,
      kind: removed.has(name) ? "bumped" : "added",
      range: head?.deps.get(name) ?? range,
    });
  }
  return out;
}

export function isRequirementsFile(relPath: string): boolean {
  const base = posix.basename(relPath);
  if (/^requirements.*\.(txt|in)$/i.test(base)) return true;
  return /\.(txt|in)$/i.test(base) && posix.basename(posix.dirname(relPath)) === "requirements";
}

/** Requirements added (or re-specified) by a requirements*.txt or pyproject.toml patch. */
export function pythonManifestEdits(
  relPath: string,
  patch: string,
  headText: string | null,
): ManifestEdit[] {
  const isPyproject = posix.basename(relPath) === "pyproject.toml";
  const headDeps = isPyproject && headText !== null ? parsePyprojectDeps(headText) : null;
  // `spec` is what the two sides are compared on; `range` is what is reported.
  // They differ only for a bare `key = value` line (Poetry): its range is `*`
  // (untrusted without a head file), but its spec is the value as written, so a
  // `requests = "^2.31"` → `"^2.32"` bump is not mistaken for a moved line.
  type Candidate = { name: string; range: string; spec: string };
  const added = new Map<string, Candidate>();
  const removed = new Map<string, Candidate>();
  const candidates = (body: string): Candidate[] => {
    if (!isPyproject) {
      const line = body.replace(/(^|\s)#.*$/, "").trim();
      if (!line || line.startsWith("-")) return [];
      const r = parsePep508(line);
      return r ? [{ name: r.name, range: r.range, spec: r.range }] : [];
    }
    const found: Candidate[] = [];
    for (const s of tomlStrings(body)) {
      const r = parsePep508(s);
      if (r) found.push({ name: r.name, range: r.range, spec: r.range });
    }
    const kv = /^\s*([A-Za-z0-9][A-Za-z0-9._-]*)\s*=(.*)$/.exec(body);
    if (kv?.[1])
      found.push({
        name: normPy(kv[1]),
        range: "*",
        // A trailing `# comment` is not part of the spec: editing only the
        // comment is not a bump (a `#` inside a quoted value is kept).
        spec: (kv[2] ?? "").replace(/\s#[^"']*$/, "").trim(),
      });
    return found;
  };
  for (const line of patch.split(/\r?\n/)) {
    if (line.startsWith("@@")) continue;
    if (line.startsWith("-")) {
      for (const c of candidates(line.slice(1))) if (!removed.has(c.name)) removed.set(c.name, c);
    } else if (line.startsWith("+")) {
      for (const c of candidates(line.slice(1))) if (!added.has(c.name)) added.set(c.name, c);
    }
  }
  const out: ManifestEdit[] = [];
  for (const [name, { range, spec }] of added) {
    // Unchanged spec on both sides: the line moved or was re-wrapped.
    if (name === "python" || removed.get(name)?.spec === spec) continue;
    // For pyproject the head file decides what is a dependency (a random
    // `line-length = 100` is a key, not a requirement); without a readable
    // head, a bare key is never trusted.
    if (isPyproject && (headDeps ? !headDeps.has(name) : range === "*")) continue;
    out.push({
      name,
      kind: removed.has(name) ? "bumped" : "added",
      range: headDeps?.get(name)?.range ?? range,
    });
  }
  return out;
}

// ---------------------------------------------------------------------------
// Semver (npm) — the subset lockfile-less resolution needs
// ---------------------------------------------------------------------------

interface SemVer {
  major: number;
  minor: number;
  patch: number;
  pre: Array<string | number>;
}

const SEMVER_RE =
  /^\s*[v=]?\s*(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?\s*$/;

function parsePre(s: string | undefined): Array<string | number> {
  return s ? s.split(".").map((p) => (/^\d+$/.test(p) ? Number(p) : p)) : [];
}

export function parseSemver(v: string): SemVer | null {
  const m = SEMVER_RE.exec(v);
  if (!m) return null;
  return { major: Number(m[1]), minor: Number(m[2]), patch: Number(m[3]), pre: parsePre(m[4]) };
}

export function compareSemver(a: SemVer, b: SemVer): number {
  const d = a.major - b.major || a.minor - b.minor || a.patch - b.patch;
  if (d) return d;
  if (!a.pre.length || !b.pre.length) return (a.pre.length ? -1 : 0) + (b.pre.length ? 1 : 0);
  for (let i = 0; i < Math.max(a.pre.length, b.pre.length); i++) {
    const x = a.pre[i];
    const y = b.pre[i];
    if (x === undefined) return -1;
    if (y === undefined) return 1;
    if (x === y) continue;
    if (typeof x === "number" && typeof y === "number") return x - y;
    if (typeof x === "number") return -1;
    if (typeof y === "number") return 1;
    return x < y ? -1 : 1;
  }
  return 0;
}

interface Comparator {
  op: "<" | "<=" | ">" | ">=" | "=";
  v: SemVer;
}

interface PartialVer {
  M?: number;
  m?: number;
  p?: number;
  pre: Array<string | number>;
}

const PARTIAL_RE =
  /^[v=]?(\d+|[xX*])(?:\.(\d+|[xX*]))?(?:\.(\d+|[xX*]))?(?:-([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?(?:\+[0-9A-Za-z.-]+)?$/;

function parsePartial(s: string): PartialVer | null {
  if (s === "") return { pre: [] };
  const r = PARTIAL_RE.exec(s);
  if (!r) return null;
  const num = (x: string | undefined): number | undefined =>
    x === undefined || /^[xX*]$/.test(x) ? undefined : Number(x);
  const M = num(r[1]);
  const m = M === undefined ? undefined : num(r[2]);
  const p = m === undefined ? undefined : num(r[3]);
  const out: PartialVer = { pre: p === undefined ? [] : parsePre(r[4]) };
  if (M !== undefined) out.M = M;
  if (m !== undefined) out.m = m;
  if (p !== undefined) out.p = p;
  return out;
}

function sv(major: number, minor: number, patch: number, pre: Array<string | number> = []): SemVer {
  return { major, minor, patch, pre };
}

/** One comparator token → primitive comparators (empty = matches everything). */
function desugar(op: string, P: PartialVer): Comparator[] {
  const { M, m, p, pre } = P;
  const NONE: Comparator[] = [{ op: "<", v: sv(0, 0, 0) }];
  const ge = (a: number, b: number, c: number, r: Array<string | number> = []): Comparator => ({
    op: ">=",
    v: sv(a, b, c, r),
  });
  const lt = (a: number, b: number, c: number): Comparator => ({ op: "<", v: sv(a, b, c) });
  switch (op) {
    case "":
    case "=":
      if (M === undefined) return [];
      if (m === undefined) return [ge(M, 0, 0), lt(M + 1, 0, 0)];
      if (p === undefined) return [ge(M, m, 0), lt(M, m + 1, 0)];
      return [{ op: "=", v: sv(M, m, p, pre) }];
    case "^":
      if (M === undefined) return [];
      if (m === undefined) return [ge(M, 0, 0), lt(M + 1, 0, 0)];
      if (p === undefined)
        return M > 0 ? [ge(M, m, 0), lt(M + 1, 0, 0)] : [ge(0, m, 0), lt(0, m + 1, 0)];
      if (M > 0) return [ge(M, m, p, pre), lt(M + 1, 0, 0)];
      if (m > 0) return [ge(0, m, p, pre), lt(0, m + 1, 0)];
      return [ge(0, 0, p, pre), lt(0, 0, p + 1)];
    case "~":
    case "~>":
      if (M === undefined) return [];
      if (m === undefined) return [ge(M, 0, 0), lt(M + 1, 0, 0)];
      return [ge(M, m, p ?? 0, pre), lt(M, m + 1, 0)];
    case ">":
      if (M === undefined) return NONE;
      if (m === undefined) return [ge(M + 1, 0, 0)];
      if (p === undefined) return [ge(M, m + 1, 0)];
      return [{ op: ">", v: sv(M, m, p, pre) }];
    case ">=":
      if (M === undefined) return [];
      return [ge(M, m ?? 0, p ?? 0, pre)];
    case "<":
      if (M === undefined) return NONE;
      return [{ op: "<", v: sv(M, m ?? 0, p ?? 0, pre) }];
    case "<=":
      if (M === undefined) return [];
      if (m === undefined) return [lt(M + 1, 0, 0)];
      if (p === undefined) return [lt(M, m + 1, 0)];
      return [{ op: "<=", v: sv(M, m, p, pre) }];
    default:
      return NONE;
  }
}

/** An npm range → alternatives of comparator sets, or null when unparseable. */
function parseRange(range: string): Comparator[][] | null {
  const out: Comparator[][] = [];
  for (const alt of range.split("||")) {
    const s = alt.trim();
    const hy = /^(\S+)\s+-\s+(\S+)$/.exec(s);
    if (hy) {
      const a = parsePartial(hy[1] ?? "");
      const b = parsePartial(hy[2] ?? "");
      if (!a || !b) return null;
      out.push([...desugar(">=", a), ...desugar("<=", b)]);
      continue;
    }
    const set: Comparator[] = [];
    for (const tok of s
      .replace(/(<=|>=|~>|[<>=~^])\s+/g, "$1")
      .split(/\s+/)
      .filter(Boolean)) {
      const t = /^(<=|>=|~>|[<>=~^])?(.*)$/.exec(tok);
      const P = parsePartial(t?.[2] ?? "");
      if (!P) return null;
      set.push(...desugar(t?.[1] ?? "", P));
    }
    out.push(set);
  }
  return out;
}

function testSet(v: SemVer, set: Comparator[]): boolean {
  for (const c of set) {
    const d = compareSemver(v, c.v);
    const ok =
      c.op === "<"
        ? d < 0
        : c.op === "<="
          ? d <= 0
          : c.op === ">"
            ? d > 0
            : c.op === ">="
              ? d >= 0
              : d === 0;
    if (!ok) return false;
  }
  // node-semver's rule: a prerelease only satisfies a range that itself
  // names a prerelease of the same major.minor.patch.
  if (v.pre.length) {
    return set.some(
      (c) =>
        c.v.pre.length > 0 &&
        c.v.major === v.major &&
        c.v.minor === v.minor &&
        c.v.patch === v.patch,
    );
  }
  return true;
}

export function satisfiesRange(version: string, range: string): boolean {
  const v = parseSemver(version);
  const r = parseRange(range);
  return !!v && !!r && r.some((set) => testSet(v, set));
}

export function maxSatisfying(versions: readonly string[], range: string): string | null {
  const r = parseRange(range);
  if (!r) return null;
  let best: { raw: string; v: SemVer } | null = null;
  for (const raw of versions) {
    const v = parseSemver(raw);
    if (!v || !r.some((set) => testSet(v, set))) continue;
    if (!best || compareSemver(v, best.v) > 0) best = { raw, v };
  }
  return best?.raw ?? null;
}

/**
 * npm's own choice for a range: a dist-tag named outright (`latest`, `next`),
 * else `latest` when it satisfies, else the highest satisfying version.
 */
export function pickNpmVersion(
  versions: readonly string[],
  range: string,
  distTags: Record<string, unknown> = {},
): string | null {
  const r = range.trim() || "*";
  const tagged = str(distTags[r]);
  if (tagged && versions.includes(tagged)) return tagged;
  const latest = str(distTags.latest);
  if (latest && versions.includes(latest) && satisfiesRange(latest, r)) return latest;
  return maxSatisfying(versions, r);
}

/**
 * The locked version a file resolves to, and whether the copy it resolves to
 * — in the same nearest-workspace pool the version came from — is foreign.
 */
function pickLocked(
  entries: LockEntry[],
  range: string | undefined,
  relInLockDir: string,
): { version: string; foreign: boolean } | null {
  const pool = lockPool(entries, relInLockDir);
  const version = pickFromPool(pool, range);
  if (!version) return null;
  return { version, foreign: pool.some((e) => e.version === version && e.foreign) };
}

function lockPool(entries: LockEntry[], relInLockDir: string): LockEntry[] {
  const inScope = entries.filter(
    (e) => e.scope && (relInLockDir === e.scope || relInLockDir.startsWith(`${e.scope}/`)),
  );
  // Node resolves from the NEAREST node_modules: only the deepest enclosing
  // workspace's copies count, never a max across its ancestors.
  const depth = Math.max(0, ...inScope.map((e) => e.scope?.length ?? 0));
  const scoped = inScope.filter((e) => (e.scope?.length ?? 0) === depth);
  const hoisted = entries.filter((e) => !e.scope);
  return scoped.length ? scoped : hoisted.length ? hoisted : entries;
}

function pickFromPool(pool: LockEntry[], range: string | undefined): string | null {
  if (pool.length === 1) return pool[0]?.version ?? null;
  if (range) {
    const exact = pool.find((e) => e.specs?.includes(range));
    if (exact) return exact.version;
    const m = maxSatisfying(
      pool.map((e) => e.version),
      range,
    );
    if (m) return m;
  }
  return (
    maxSatisfying(
      pool.map((e) => e.version),
      "*",
    ) ??
    pool[0]?.version ??
    null
  );
}

// ---------------------------------------------------------------------------
// PEP 440 (enough of it) — dotted numeric releases
// ---------------------------------------------------------------------------

interface PyVersion {
  release: number[];
  final: boolean;
}

const PY_VERSION_RE =
  /^\s*v?(?:\d+!)?(\d+(?:\.\d+)*)((?:[-_.]?(?:a|b|c|rc|alpha|beta|pre|preview)(?:[-_.]?\d+)?)?)((?:-\d+|[-_.]?(?:post|rev|r)(?:[-_.]?\d+)?)?)((?:[-_.]?dev(?:[-_.]?\d+)?)?)(?:\+[a-z0-9]+(?:[-_.][a-z0-9]+)*)?\s*$/i;

function parsePyVersion(v: string): PyVersion | null {
  const m = PY_VERSION_RE.exec(v);
  if (!m) return null;
  return { release: (m[1] ?? "0").split(".").map(Number), final: !m[2] && !m[3] && !m[4] };
}

function cmpRelease(a: readonly number[], b: readonly number[]): number {
  for (let i = 0; i < Math.max(a.length, b.length); i++) {
    const d = (a[i] ?? 0) - (b[i] ?? 0);
    if (d) return d;
  }
  return 0;
}

function pyClause(v: readonly number[], clause: string): boolean | null {
  const m = /^(===|==|!=|~=|>=|<=|>|<|\^|~|=)?\s*(.*)$/.exec(clause.trim());
  const op = m?.[1] ?? "";
  const target = (m?.[2] ?? "").trim();
  if (target === "*" || target === "") return op === "" || op === "==" || op === "=";
  const wildcard = target.endsWith(".*");
  const tv = parsePyVersion(wildcard ? target.slice(0, -2) : target);
  if (!tv) return null;
  const t = tv.release;
  const prefix = (): boolean => t.every((n, i) => (v[i] ?? 0) === n);
  const c = cmpRelease(v, t);
  switch (op) {
    case "":
    case "=":
    case "==":
    case "===":
      return wildcard ? prefix() : c === 0;
    case "!=":
      return wildcard ? !prefix() : c !== 0;
    case ">=":
      return c >= 0;
    case "<=":
      return c <= 0;
    case ">":
      return c > 0;
    case "<":
      return c < 0;
    case "~=": {
      if (t.length < 2) return null;
      const upper = t.slice(0, -1);
      upper[upper.length - 1] = (upper[upper.length - 1] ?? 0) + 1;
      return c >= 0 && cmpRelease(v, upper) < 0;
    }
    case "^": {
      // Poetry caret: bump the first non-zero component.
      let i = t.findIndex((n) => n !== 0);
      if (i < 0) i = t.length - 1;
      const upper = t.slice(0, i + 1);
      upper[i] = (upper[i] ?? 0) + 1;
      return c >= 0 && cmpRelease(v, upper) < 0;
    }
    case "~": {
      const upper = t.length >= 2 ? [t[0] ?? 0, (t[1] ?? 0) + 1] : [(t[0] ?? 0) + 1];
      return c >= 0 && cmpRelease(v, upper) < 0;
    }
    default:
      return null;
  }
}

/**
 * Does a PyPI version satisfy a PEP 440 / Poetry specifier? Pre-, post- and
 * dev-releases never match a range — only an exact pin fetches one, and that
 * path never asks this function.
 */
export function pyVersionMatches(version: string, spec: string): boolean {
  const v = parsePyVersion(version);
  if (!v || !v.final) return false;
  return spec
    .split("||")
    .some((alt) => alt.split(",").every((cl) => pyClause(v.release, cl) === true));
}

function maxPyVersion(versions: readonly string[], spec: string): string | null {
  let best: { raw: string; r: number[] } | null = null;
  for (const raw of versions) {
    if (!pyVersionMatches(raw, spec)) continue;
    const r = parsePyVersion(raw)?.release ?? [];
    if (!best || cmpRelease(r, best.r) > 0) best = { raw, r };
  }
  return best?.raw ?? null;
}

// ---------------------------------------------------------------------------
// Planning
// ---------------------------------------------------------------------------

interface TreeIo {
  read(rel: string, maxBytes: number): string | null;
  exists(rel: string): boolean;
  isDir(rel: string): boolean;
  list(rel: string): string[];
}

function treeIo(root: string, readFile?: ReadFileFn): TreeIo {
  const abs = (rel: string): string => join(root, rel);
  let realRoot: string | null = null;
  // The worktree is the PR author's content: a symlinked `package.json`
  // pointing at a host file must not be read (names from it would reach the
  // prompt), so the default reader refuses anything resolving outside it.
  const inside = (p: string): boolean => {
    try {
      realRoot ??= realpathSync(root);
      const real = realpathSync(p);
      return real === realRoot || real.startsWith(realRoot + sep);
    } catch {
      return false;
    }
  };
  const injected = (rel: string): string | null => {
    try {
      return readFile ? readFile(abs(rel)) : null;
    } catch {
      return null;
    }
  };
  return {
    read(rel, maxBytes) {
      if (readFile) {
        const t = injected(rel);
        return t !== null && t.length <= maxBytes ? t : null;
      }
      try {
        const p = abs(rel);
        const st = lstatSync(p);
        if (!st.isFile() || st.size > maxBytes || !inside(p)) return null;
        return readFileSync(p, "utf8");
      } catch {
        return null;
      }
    },
    exists(rel) {
      try {
        statSync(abs(rel));
        return true;
      } catch {
        return injected(rel) !== null;
      }
    },
    isDir(rel) {
      try {
        return statSync(abs(rel)).isDirectory();
      } catch {
        return false;
      }
    },
    list(rel) {
      try {
        return readdirSync(abs(rel));
      } catch {
        return [];
      }
    },
  };
}

interface DirInfo {
  npmLocks: NpmLock[];
  pkg: PackageJsonInfo | null;
  pyPins: Map<string, string>;
  pyDecl: Map<string, PyReq>;
}

interface Resolved {
  name: string;
  version: string | null;
  range?: string;
}

class Resolver {
  private readonly dirs = new Map<string, DirInfo>();

  constructor(private readonly io: TreeIo) {}

  private dir(rel: string): DirInfo {
    const hit = this.dirs.get(rel);
    if (hit) return hit;
    const read = (name: string): string | null =>
      this.io.read(posix.join(rel, name), MAX_MANIFEST_BYTES);
    const npmLocks: NpmLock[] = [];
    for (const f of ["package-lock.json", "npm-shrinkwrap.json"]) {
      const t = read(f);
      const l = t !== null ? parsePackageLock(t) : null;
      if (l) npmLocks.push(l);
    }
    const yarn = read("yarn.lock");
    if (yarn !== null) npmLocks.push(parseYarnLock(yarn));
    const pnpm = read("pnpm-lock.yaml");
    if (pnpm !== null) npmLocks.push(parsePnpmLock(pnpm));
    const pkgText = read("package.json");
    const pkg = pkgText !== null ? parsePackageJson(pkgText) : null;

    const pyPins = new Map<string, string>();
    const pyDecl = new Map<string, PyReq>();
    const pins = (m: Map<string, string>): void => {
      for (const [k, v] of m) if (!pyPins.has(k)) pyPins.set(k, v);
    };
    for (const f of ["uv.lock", "poetry.lock"]) {
      const t = read(f);
      if (t !== null) pins(parsePythonLock(t));
    }
    const pipfile = read("Pipfile.lock");
    if (pipfile !== null) pins(parsePipfileLock(pipfile));
    const reqFiles = new Set<string>(["requirements.txt"]);
    for (const f of this.io.list(rel)) if (isRequirementsFile(f)) reqFiles.add(f);
    const reqDir = posix.join(rel, "requirements");
    if (this.io.isDir(reqDir))
      for (const f of this.io.list(reqDir))
        if (/\.(txt|in)$/i.test(f)) reqFiles.add(`requirements/${f}`);
    for (const f of [...reqFiles].sort()) {
      const t = read(f);
      if (t === null) continue;
      for (const [k, r] of parseRequirements(t)) {
        if (r.pin && !pyPins.has(k)) pyPins.set(k, r.pin);
        if (!pyDecl.has(k)) pyDecl.set(k, r);
      }
    }
    const pyproject = read("pyproject.toml");
    if (pyproject !== null)
      for (const [k, r] of parsePyprojectDeps(pyproject)) if (!pyDecl.has(k)) pyDecl.set(k, r);

    const info: DirInfo = { npmLocks, pkg, pyPins, pyDecl };
    this.dirs.set(rel, info);
    return info;
  }

  /**
   * An npm package as seen from one file: the nearest lockfile that pins it
   * and the nearest package.json that declares it (monorepos: walk up).
   * "first-party" for workspace / link / the package itself; null for
   * UNDECLARED imports — those are
   * path aliases (`components/x`, `@app/x`) or a missing dependency, and
   * fetching the registry package that happens to share the name would hand
   * the reviewer an unrelated library.
   */
  npm(name: string, relFile: string): Resolved | null | "first-party" {
    let range: string | undefined;
    let locked: { entries: LockEntry[]; dir: string } | undefined;
    let anyManifest = false;
    for (const d of ancestors(relDirOf(relFile))) {
      const info = this.dir(d);
      if (info.pkg) {
        anyManifest = true;
        if (info.pkg.name === name) return "first-party";
        if (range === undefined && info.pkg.deps.has(name)) range = info.pkg.deps.get(name);
      }
      for (const l of info.npmLocks) {
        anyManifest = true;
        if (l.links.has(name)) return "first-party";
        const e = l.entries.get(name);
        if (!locked && e?.length) locked = { entries: e, dir: d };
      }
    }
    if (range !== undefined && isLocalRange(range)) return "first-party";
    if (range !== undefined && isNonRegistryRange(range)) return { name, version: null, range };
    if (locked) {
      const rel = locked.dir ? posix.relative(locked.dir, relFile) : relFile;
      const picked = pickLocked(locked.entries, range, rel);
      // Locked to a private registry / git / URL: skip rather than hand the
      // reviewer npmjs's same-named release as the PR's locked source.
      if (picked?.foreign) return { name, version: null, range: NPM_FOREIGN_PIN };
      const version = picked?.version;
      if (version) return range !== undefined ? { name, version, range } : { name, version };
    }
    if (range !== undefined) return { name, version: null, range };
    // No npm manifest anywhere on the path: nothing could alias the name, so
    // the bare import can only mean the registry package.
    return anyManifest ? null : { name, version: null, range: "*" };
  }

  /** A Python distribution (normalised name) as seen from one file. */
  pyDist(dist: string, relFile: string): Resolved | null | "first-party" {
    let pin: string | undefined;
    let decl: PyReq | undefined;
    for (const d of ancestors(relDirOf(relFile))) {
      const info = this.dir(d);
      pin ??= info.pyPins.get(dist);
      decl ??= info.pyDecl.get(dist);
    }
    if (decl && isLocalRange(decl.range)) return "first-party";
    // Locked to git / a URL / a private index: a non-registry range, so
    // preparation skips it rather than substituting PyPI's release.
    if (pin?.startsWith(PY_FOREIGN_PIN_PREFIX)) return { name: dist, version: null, range: pin };
    if (pin === undefined && !decl) return null;
    const version = pin ?? decl?.pin ?? null;
    return decl ? { name: dist, version, range: decl.range } : { name: dist, version };
  }

  /** Is `top` a module of the repo itself, as seen from this file? */
  pyFirstParty(top: string, relFile: string): boolean {
    const dirs = new Set([...ancestors(relDirOf(relFile)), "src"]);
    for (const d of dirs) {
      const base = posix.join(d, top);
      if (this.io.exists(`${base}.py`) || this.io.exists(`${base}/__init__.py`)) return true;
      // A namespace package (no __init__.py) still counts when it holds Python.
      if (this.io.isDir(base) && this.io.list(base).some((f) => f.endsWith(".py"))) return true;
    }
    return false;
  }

  /** The distributions one Python import statement pulls in (usually 0 or 1). */
  py(imp: PyImport, relFile: string): Resolved[] {
    const parts = imp.module.split(".");
    const top = parts[0] ?? "";
    if (!top || PY_STDLIB.has(top) || this.pyFirstParty(top, relFile)) return [];
    const lookup = (candidate: string): Resolved | null | "first-party" => {
      const alias = PY_ALIASES[candidate];
      const r = this.pyDist(normPy(alias ?? candidate), relFile);
      if (r === null && alias) return { name: normPy(alias), version: null, range: "*" };
      return r;
    };
    const out: Resolved[] = [];
    // `from google.cloud import storage, bigquery` names two distributions;
    // only lowercase names can be submodules, so classes are not tried.
    for (const n of imp.names) {
      if (!/^[a-z_][a-z0-9_]*$/.test(n)) continue;
      const r = lookup(`${imp.module}.${n}`);
      if (r && r !== "first-party") out.push(r);
    }
    if (out.length) return out;
    for (let i = parts.length; i >= 1; i--) {
      const r = lookup(parts.slice(0, i).join("."));
      if (r === "first-party") return [];
      if (r) return [r];
    }
    return [];
  }
}

interface Acc {
  ecosystem: DepEcosystem;
  name: string;
  version: string | null;
  range?: string;
  manifestWhys: string[];
  importers: string[];
  seq: number;
}

function renderWhy(a: Acc): string {
  const parts = a.manifestWhys.slice(0, 3);
  if (a.importers.length) {
    const more = a.importers.length - 3;
    parts.push(
      `imported by ${a.importers.slice(0, 3).join(", ")}${more > 0 ? ` +${more} more` : ""}`,
    );
  }
  return parts.join("; ");
}

/**
 * Which third-party packages matter for THIS PR, most important first:
 * dependencies the diff adds to a manifest, then packages imported by the
 * changed files (by how many import them). Pure over the tree; `readFile`
 * (absolute path → text or null) replaces the filesystem for tests. Not
 * truncated — the per-PR cap is applied at prepare time so the overflow is
 * visible as `skipped`.
 */
export function planDependencyRequests(
  tree: string,
  changedFiles: ChangedFile[],
  readFile?: ReadFileFn,
): DepRequest[] {
  const io = treeIo(resolve(tree), readFile);
  const resolver = new Resolver(io);
  // Keyed by package, one Acc per distinct resolved VERSION: two workspaces can
  // lock one package at different versions, and each importer must be shown the
  // sources it actually runs against. An unresolved (null) sighting joins the
  // package's first entry, and a later resolution fills a null one in.
  const accs = new Map<string, Acc[]>();
  let seq = 0;
  const note = (
    eco: DepEcosystem,
    r: Resolved,
    why: { manifest?: string; importer?: string },
  ): void => {
    const key = `${eco}:${r.name}`;
    const same = accs.get(key) ?? [];
    let a =
      r.version === null
        ? same[0]
        : (same.find((x) => x.version === r.version) ?? same.find((x) => x.version === null));
    if (!a) {
      a = {
        ecosystem: eco,
        name: r.name,
        version: r.version,
        manifestWhys: [],
        importers: [],
        seq: seq++,
      };
      if (r.range !== undefined) a.range = r.range;
      same.push(a);
      accs.set(key, same);
    } else if (a.version === null && r.version !== null) {
      a.version = r.version;
    }
    if (why.manifest && !a.manifestWhys.includes(why.manifest)) a.manifestWhys.push(why.manifest);
    if (why.importer && !a.importers.includes(why.importer)) a.importers.push(why.importer);
  };

  const live: Array<ChangedFile & { rel: string }> = [];
  for (const f of changedFiles) {
    const rel = normalizeRel(f.filename);
    if (rel && f.status !== "removed") live.push({ ...f, rel });
  }

  // 1. Manifest edits — the strongest signal: the PR chose this library.
  for (const f of live) {
    if (!f.patch) continue;
    const base = posix.basename(f.rel);
    if (base === "package.json") {
      for (const e of npmManifestEdits(f.patch, io.read(f.rel, MAX_MANIFEST_BYTES))) {
        const why = `${e.kind === "bumped" ? "bumped in" : "added to"} ${f.rel}`;
        if (e.range !== null && isLocalRange(e.range)) continue;
        const r = resolver.npm(e.name, f.rel);
        if (r === "first-party") continue;
        // The diff itself declares it, so an unresolvable lookup (unreadable
        // head file) still has the patch's range to go on.
        note("npm", r ?? { name: e.name, version: null, range: e.range ?? "*" }, { manifest: why });
      }
    } else if (base === "pyproject.toml" || isRequirementsFile(f.rel)) {
      for (const e of pythonManifestEdits(f.rel, f.patch, io.read(f.rel, MAX_MANIFEST_BYTES))) {
        const why = `${e.kind === "bumped" ? "bumped in" : "added to"} ${f.rel}`;
        const r = resolver.pyDist(e.name, f.rel);
        if (r === "first-party" || (e.range !== null && isLocalRange(e.range))) continue;
        note("pypi", r ?? { name: e.name, version: null, range: e.range ?? "*" }, {
          manifest: why,
        });
      }
    }
  }

  // 2. Imports of the changed files, read whole at head (not just the patch:
  //    a changed line calling `detect()` matters because of an import above it).
  for (const f of live.slice(0, MAX_CHANGED_FILES)) {
    const ext = posix.extname(f.rel).toLowerCase();
    const isJs = JS_EXTS.has(ext);
    if (!isJs && !PY_EXTS.has(ext)) continue;
    const text = io.read(f.rel, MAX_SOURCE_FILE_BYTES);
    if (text === null) continue;
    if (isJs) {
      const names = new Set<string>();
      for (const spec of extractJsImports(text)) {
        const n = npmPackageName(spec);
        if (n) names.add(n);
      }
      for (const n of names) {
        const r = resolver.npm(n, f.rel);
        if (r && r !== "first-party") note("npm", r, { importer: f.rel });
      }
    } else {
      for (const imp of extractPythonImports(text))
        for (const r of resolver.py(imp, f.rel)) note("pypi", r, { importer: f.rel });
    }
  }

  return [...accs.values()]
    .flat()
    .sort((a, b) => {
      const am = a.manifestWhys.length > 0;
      const bm = b.manifestWhys.length > 0;
      if (am !== bm) return am ? -1 : 1;
      if (am) return a.seq - b.seq;
      return (
        b.importers.length - a.importers.length ||
        a.name.localeCompare(b.name) ||
        a.ecosystem.localeCompare(b.ecosystem)
      );
    })
    .map((a) => {
      const req: DepRequest = {
        ecosystem: a.ecosystem,
        name: a.name,
        version: a.version,
        why: renderWhy(a),
      };
      if (a.range !== undefined) req.range = a.range;
      return req;
    });
}

// ---------------------------------------------------------------------------
// Archives — parsed in Node, never by an external tool
// ---------------------------------------------------------------------------

export interface ArchiveEntry {
  /** The raw, UNSANITISED path from the archive. */
  path: string;
  kind: "file" | "dir" | "symlink" | "hardlink" | "other";
  size: number;
  /** The entry's bytes (lazy for zip, so filtered-out entries are never inflated). */
  read: () => Buffer;
}

function cstr(b: Buffer): string {
  const i = b.indexOf(0);
  return b.subarray(0, i < 0 ? b.length : i).toString("utf8");
}

function tarNumber(field: Buffer): number {
  const first = field[0] ?? 0;
  if (first & 0x80) {
    // GNU base-256 for sizes past 8 GiB octal — positive only for sizes.
    let n = first & 0x7f;
    for (let i = 1; i < field.length; i++) n = n * 256 + (field[i] ?? 0);
    return n;
  }
  const s = cstr(field).trim();
  if (!s) return 0;
  if (!/^[0-7]+$/.test(s)) throw new Error("corrupt tar archive (bad numeric field)");
  return parseInt(s, 8);
}

function tarChecksumOk(h: Buffer): boolean {
  const stored = cstr(h.subarray(148, 156)).trim();
  if (!/^[0-7]+$/.test(stored)) return false;
  const want = parseInt(stored, 8);
  let unsigned = 0;
  let signed = 0;
  for (let i = 0; i < 512; i++) {
    const b = i >= 148 && i < 156 ? 32 : (h[i] ?? 0);
    unsigned += b;
    signed += b > 127 ? b - 256 : b;
  }
  return want === unsigned || want === signed;
}

function paxRecords(data: Buffer): Map<string, string> {
  const out = new Map<string, string>();
  let i = 0;
  while (i < data.length) {
    const sp = data.indexOf(0x20, i);
    if (sp < 0) break;
    // `<len> <key>=<value>\n`: the length counts its own digits, the space and
    // the newline, so a shorter one is malformed. Accepting it would let a run
    // of zeroes "advance" one byte per record, re-scanning the rest each time.
    if (sp - i > 20 || !/^\d+$/.test(data.subarray(i, sp).toString("latin1"))) break;
    const len = parseInt(data.subarray(i, sp).toString("latin1"), 10);
    if (!Number.isFinite(len) || len < sp - i + 2 || i + len > data.length) break;
    const rec = data.subarray(sp + 1, i + len - 1).toString("utf8");
    const eq = rec.indexOf("=");
    if (eq > 0) out.set(rec.slice(0, eq), rec.slice(eq + 1));
    i += len;
  }
  return out;
}

/**
 * A (decompressed) tar: ustar + GNU long names (`L`) + pax `path=`. Returns
 * every entry with its RAW path and kind; nothing here touches the disk, so
 * path safety and the regular-files-only rule are `unpackEntries`' job.
 */
export function parseTar(buf: Buffer): ArchiveEntry[] {
  const out: ArchiveEntry[] = [];
  let off = 0;
  let longName: string | null = null;
  let paxPath: string | null = null;
  while (off + 512 <= buf.length) {
    const h = buf.subarray(off, off + 512);
    if (h.every((b) => b === 0)) break;
    if (!tarChecksumOk(h))
      throw new Error(`corrupt tar archive (bad header checksum at byte ${off})`);
    const size = tarNumber(h.subarray(124, 136));
    const type = String.fromCharCode(h[156] ?? 0);
    const start = off + 512;
    const end = start + size;
    if (end > buf.length) throw new Error("corrupt tar archive (entry runs past the end)");
    const data = buf.subarray(start, end);
    off = start + Math.ceil(size / 512) * 512;
    if (type === "L") {
      longName = cstr(data);
      continue;
    }
    if (type === "x") {
      const p = paxRecords(data).get("path");
      if (p !== undefined) paxPath = p;
      continue;
    }
    if (type === "g" || type === "K") continue;
    let name = cstr(h.subarray(0, 100));
    // The prefix field is ustar's; GNU tars put other data at that offset.
    if (h.subarray(257, 263).toString("latin1") === "ustar\0") {
      const prefix = cstr(h.subarray(345, 500));
      if (prefix) name = `${prefix}/${name}`;
    }
    const path = paxPath ?? longName ?? name;
    paxPath = null;
    longName = null;
    const kind: ArchiveEntry["kind"] =
      type === "0" || type === "\0"
        ? path.endsWith("/")
          ? "dir"
          : "file"
        : type === "5"
          ? "dir"
          : type === "2"
            ? "symlink"
            : type === "1"
              ? "hardlink"
              : "other";
    out.push({ path, kind, size, read: () => data });
  }
  return out;
}

function findEocd(buf: Buffer): number {
  const min = Math.max(0, buf.length - 22 - 0xffff);
  for (let i = buf.length - 22; i >= min; i--) if (buf.readUInt32LE(i) === 0x06054b50) return i;
  return -1;
}

function readZipEntry(
  buf: Buffer,
  local: number,
  method: number,
  csize: number,
  usize: number,
  crc: number,
): Buffer {
  if (local + 30 > buf.length || buf.readUInt32LE(local) !== 0x04034b50)
    throw new Error("corrupt zip archive (bad local header)");
  // Only the local header's name/extra LENGTHS are read from it; sizes come
  // from the central directory, which is what every sane reader trusts.
  const start = local + 30 + buf.readUInt16LE(local + 26) + buf.readUInt16LE(local + 28);
  const end = start + csize;
  if (end > buf.length) throw new Error("corrupt zip archive (entry runs past the end)");
  const raw = buf.subarray(start, end);
  let data: Buffer;
  if (method === 0) {
    if (csize !== usize) throw new Error("corrupt zip archive (stored size mismatch)");
    data = Buffer.from(raw);
  } else {
    // maxOutputLength is the zip-bomb stop: inflation halts at the declared size.
    data = usize === 0 ? Buffer.alloc(0) : zlib.inflateRawSync(raw, { maxOutputLength: usize });
  }
  if (data.length !== usize) throw new Error("corrupt zip archive (size mismatch)");
  if (zlib.crc32(data) >>> 0 !== crc >>> 0) throw new Error("corrupt zip archive (CRC mismatch)");
  return data;
}

/** A zip (wheel, zip sdist) via its central directory. zip64 is refused. */
export function parseZip(buf: Buffer): ArchiveEntry[] {
  const eocd = findEocd(buf);
  if (eocd < 0) throw new Error("corrupt zip archive (no end-of-central-directory record)");
  const total = buf.readUInt16LE(eocd + 10);
  const cdSize = buf.readUInt32LE(eocd + 12);
  const cdOff = buf.readUInt32LE(eocd + 16);
  if (total === 0xffff || cdSize === 0xffffffff || cdOff === 0xffffffff)
    throw new Error("zip64 archives are not supported");
  if (cdOff + cdSize > buf.length)
    throw new Error("corrupt zip archive (central directory out of bounds)");
  const out: ArchiveEntry[] = [];
  // Entries of a real zip occupy disjoint ranges, so the compressed bytes read
  // across all of them never exceed the archive. Central-directory entries that
  // point at one shared payload would multiply the inflate work per name —
  // unbounded, synchronous CPU no output cap sees — so that is refused.
  let consumed = 0;
  let p = cdOff;
  for (let i = 0; i < total; i++) {
    if (p + 46 > buf.length || buf.readUInt32LE(p) !== 0x02014b50)
      throw new Error("corrupt zip archive (bad central directory entry)");
    const madeBy = buf.readUInt16LE(p + 4);
    const flags = buf.readUInt16LE(p + 8);
    const method = buf.readUInt16LE(p + 10);
    const crc = buf.readUInt32LE(p + 16);
    const csize = buf.readUInt32LE(p + 20);
    const usize = buf.readUInt32LE(p + 24);
    const n = buf.readUInt16LE(p + 28);
    const e = buf.readUInt16LE(p + 30);
    const c = buf.readUInt16LE(p + 32);
    const ext = buf.readUInt32LE(p + 38);
    const local = buf.readUInt32LE(p + 42);
    if (p + 46 + n > buf.length) throw new Error("corrupt zip archive (name out of bounds)");
    const path = buf.subarray(p + 46, p + 46 + n).toString("utf8");
    p += 46 + n + e + c;
    const mode = madeBy >> 8 === 3 ? (ext >>> 16) & 0o170000 : 0;
    let kind: ArchiveEntry["kind"];
    if (path.endsWith("/") || mode === 0o040000) kind = "dir";
    else if (mode === 0o120000) kind = "symlink";
    else if (mode !== 0 && mode !== 0o100000) kind = "other";
    else if (flags & 1 || (method !== 0 && method !== 8))
      kind = "other"; // encrypted / unsupported method
    else kind = "file";
    out.push({
      path,
      kind,
      size: usize,
      read: () => {
        consumed += csize;
        if (consumed > buf.length)
          throw new Error("corrupt zip archive (entries overlap one another)");
        return readZipEntry(buf, local, method, csize, usize, crc);
      },
    });
  }
  return out;
}

/**
 * An archive entry path → safe relative segments, or null. Rejects absolute
 * paths, drive letters, `..` anywhere, NUL bytes and backslashes outright —
 * rejected, not "fixed", because a registry archive carrying one of them is
 * not an archive whose other paths deserve the benefit of the doubt.
 */
export function safeArchivePath(raw: string): string[] | null {
  if (!raw || raw.includes("\0") || raw.includes("\\")) return null;
  if (raw.startsWith("/") || /^[A-Za-z]:/.test(raw)) return null;
  const segs = raw.split("/").filter((s) => s !== "" && s !== ".");
  if (!segs.length || segs.includes("..")) return null;
  return segs;
}

const KEEP_EXTS = new Set([
  ".js",
  ".mjs",
  ".cjs",
  ".ts",
  ".mts",
  ".cts",
  ".jsx",
  ".tsx",
  ".json",
  ".py",
  ".pyi",
  ".md",
  ".txt",
  ".toml",
  ".cfg",
  ".ini",
  ".yml",
  ".yaml",
]);
const SKIP_DIRS = new Set(["node_modules", "test", "tests", "__tests__", "docs", "examples"]);

/** Is this (post-strip) path readable library source worth keeping? */
export function keepSourceFile(rel: string): boolean {
  const segs = rel.split("/");
  const base = segs[segs.length - 1] ?? "";
  if (segs.slice(0, -1).some((d) => SKIP_DIRS.has(d.toLowerCase()))) return false;
  const lower = base.toLowerCase();
  if (lower.endsWith(".min.js") || lower.endsWith(".map")) return false;
  const dot = lower.lastIndexOf(".");
  if (dot <= 0) return /^(license|licence|readme)$/.test(lower);
  return KEEP_EXTS.has(lower.slice(dot));
}

export interface UnpackOptions {
  /** "first": npm's `package/` (npm strips the first component, whatever its name); "common-top": an sdist's single top dir; "none": wheels. */
  strip: "first" | "common-top" | "none";
  maxUnpackedBytes: number;
  /** Kept-file ceiling (default MAX_KEPT_FILES); past it the unpack throws. */
  maxFiles?: number;
  /** Created-directory ceiling (default MAX_KEPT_FILES); past it the unpack throws. */
  maxDirs?: number;
  /** Aggregate bytes inflated for chosen entries, kept or not (default
   * MAX_EXPANDED_ARCHIVE_BYTES); past it the unpack throws. */
  maxInflatedBytes?: number;
}

export interface UnpackResult {
  files: number;
  bytes: number;
  /** Directories created (implied by the kept files' paths). */
  dirs: number;
  /** Entries refused for an unsafe path. */
  rejected: number;
}

/**
 * Write the kept REGULAR files of an archive under `targetDir`. Symlinks,
 * hardlinks, devices and directories-as-entries are never materialised (dirs
 * are implied by files), so no write can be redirected through a link.
 * Throws past `maxUnpackedBytes` — the caller removes the partial dir.
 */
export function unpackEntries(
  entries: readonly ArchiveEntry[],
  targetDir: string,
  opts: UnpackOptions,
): UnpackResult {
  const target = resolve(targetDir);
  let rejected = 0;
  const candidates: Array<{ segs: string[]; e: ArchiveEntry }> = [];
  for (const e of entries) {
    const segs = safeArchivePath(e.path);
    if (!segs) {
      rejected++;
      continue;
    }
    if (e.kind === "file") candidates.push({ segs, e });
  }
  let strip = 0;
  if (opts.strip === "first") strip = 1;
  else if (opts.strip === "common-top" && candidates.length) {
    const top = candidates[0]?.segs[0];
    if (candidates.every((c) => c.segs.length > 1 && c.segs[0] === top)) strip = 1;
  }
  // Later duplicates win, as with any tar extractor.
  const chosen = new Map<string, ArchiveEntry>();
  for (const { segs, e } of candidates) {
    const rel = segs.slice(strip).join("/");
    if (!rel) continue;
    if (keepSourceFile(rel) && e.size <= MAX_KEPT_FILE_BYTES) chosen.set(rel, e);
    else chosen.delete(rel);
  }
  let files = 0;
  let bytes = 0;
  let inflated = 0;
  const maxFiles = opts.maxFiles ?? MAX_KEPT_FILES;
  const maxDirs = opts.maxDirs ?? MAX_KEPT_FILES;
  const maxInflated = opts.maxInflatedBytes ?? MAX_EXPANDED_ARCHIVE_BYTES;
  // Every directory a kept path implies is an inode too: counted (and capped)
  // so a few files under deep, distinct chains cannot spend them unseen.
  const dirs = new Set<string>();
  for (const [rel, e] of chosen) {
    if (files >= maxFiles) throw new SkipError(`archive holds more than ${maxFiles} files`);
    const dest = resolve(target, rel);
    if (!dest.startsWith(target + sep)) {
      rejected++;
      continue;
    }
    for (let d = posix.dirname(rel); d !== "." && !dirs.has(d); d = posix.dirname(d)) {
      dirs.add(d);
      if (dirs.size > maxDirs)
        throw new SkipError(`archive creates more than ${maxDirs} directories`);
    }
    // The directory first: a path that clashes with a kept file fails here,
    // before its entry is inflated.
    try {
      mkdirSync(dirname(dest), { recursive: true });
    } catch {
      continue; // a file/dir name clash inside the archive: that one entry is lost
    }
    const data = e.read();
    // Charged whether or not the write lands: a failed write must not make
    // the decompression free.
    inflated += data.length;
    if (inflated > maxInflated)
      throw new SkipError(`archive expands past ${fmtBytes(maxInflated)}`);
    if (data.length > MAX_KEPT_FILE_BYTES) continue;
    if (bytes + data.length > opts.maxUnpackedBytes)
      throw new SkipError(`unpacked source exceeds ${fmtBytes(opts.maxUnpackedBytes)}`);
    try {
      writeFileSync(dest, data, { mode: 0o644 });
      files++;
      bytes += data.length;
    } catch {
      // A file/dir name clash inside the archive: that one entry is lost.
    }
  }
  return { files, bytes, dirs: dirs.size, rejected };
}

function gunzipCapped(buf: Buffer): Buffer {
  try {
    return zlib.gunzipSync(buf, { maxOutputLength: MAX_EXPANDED_ARCHIVE_BYTES });
  } catch (e) {
    if (e instanceof RangeError || (e as { code?: string }).code === "ERR_BUFFER_TOO_LARGE") {
      throw new SkipError(`archive expands past ${fmtBytes(MAX_EXPANDED_ARCHIVE_BYTES)}`);
    }
    throw new SkipError("corrupt archive (gzip)");
  }
}

// ---------------------------------------------------------------------------
// Cache
// ---------------------------------------------------------------------------

interface CacheMarker {
  name: string;
  version: string;
  url: string;
  sha256: string;
  files: number;
  bytes: number;
  /** Directories the unpack created; absent on markers written before it was
   * recorded (read as 0). Charged by the cache cap like files. */
  dirs: number;
}

const SAFE_VERSION_RE = /^[0-9A-Za-z][0-9A-Za-z.+_-]*$/;

/** `<root>/<eco>/<name, scope slash → +>@<version>`, or null when either part is unsafe as a path.
 * `+` is in neither npm's nor PyPI's name alphabet, so the mapping is
 * one-to-one (a `__` separator would not be: `@a/b__c` and `@a__b/c` would
 * share a directory). */
function cacheDirFor(
  root: string,
  eco: DepEcosystem,
  name: string,
  version: string,
): string | null {
  if (!SAFE_VERSION_RE.test(version) || version.includes("..")) return null;
  // A literal `+` would let `@a+b` alias `@a/b`; neither registry allows one.
  if (name.includes("+")) return null;
  const flat = name.replace("/", "+");
  if (!/^@?[A-Za-z0-9][A-Za-z0-9._~-]*(?:\+[A-Za-z0-9._~-]+)?$/.test(flat) || flat.includes(".."))
    return null;
  return join(root, eco, `${flat}@${version}`);
}

function readMarker(dir: string): CacheMarker | null {
  try {
    const m: unknown = JSON.parse(readFileSync(join(dir, MARKER), "utf8"));
    if (isObj(m) && typeof m.files === "number" && typeof m.bytes === "number") {
      return {
        name: str(m.name) ?? "",
        version: str(m.version) ?? "",
        url: str(m.url) ?? "",
        sha256: str(m.sha256) ?? "",
        files: m.files,
        bytes: m.bytes,
        dirs: typeof m.dirs === "number" ? m.dirs : 0,
      };
    }
  } catch {
    // missing or torn marker: not complete
  }
  return null;
}

/** Remove this package's tmp dirs left by a crashed run (older than an hour). */
function sweepStaleTmp(final: string): void {
  try {
    const parent = dirname(final);
    const prefix = `${basename(final)}.tmp-`;
    for (const f of readdirSync(parent)) {
      if (!f.startsWith(prefix)) continue;
      const p = join(parent, f);
      if (Date.now() - statSync(p).mtimeMs > STALE_TMP_MS)
        rmSync(p, { recursive: true, force: true });
    }
  } catch {
    // best effort
  }
}

// ---------------------------------------------------------------------------
// Fetching
// ---------------------------------------------------------------------------

type Outcome = { ok: true; source: DepSource } | { ok: false; skip: DepSkip };

interface PrepCtx {
  root: string;
  fetch: typeof fetch;
  deadline: number;
  maxArchiveBytes: number;
  maxUnpackedBytes: number;
  log: (line: string) => void;
}

function allowedUrl(url: string, prefix: string): boolean {
  try {
    const u = new URL(url);
    const p = new URL(prefix);
    return (
      u.protocol === "https:" &&
      u.hostname === p.hostname &&
      !u.port &&
      !u.username &&
      !u.password &&
      u.href.startsWith(prefix)
    );
  } catch {
    return false;
  }
}

async function readCapped(res: Response, max: number, what: string): Promise<Buffer> {
  if (!res.body) {
    const b = Buffer.from(await res.arrayBuffer());
    if (b.length > max) throw new SkipError(`${what} exceeds ${fmtBytes(max)}`);
    return b;
  }
  const reader = res.body.getReader();
  const chunks: Buffer[] = [];
  let n = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    n += value.byteLength;
    if (n > max) {
      await reader.cancel().catch(() => undefined);
      throw new SkipError(`${what} exceeds ${fmtBytes(max)}`);
    }
    chunks.push(Buffer.from(value));
  }
  return Buffer.concat(chunks, n);
}

/**
 * One bounded GET: per-request timeout, the overall deadline, a byte cap
 * enforced on content-length AND on the bytes actually read, and a check that
 * any redirect stayed on the allowed host.
 */
async function httpGet(
  ctx: PrepCtx,
  url: string,
  allowedPrefix: string,
  maxBytes: number,
  what: string,
  accept?: string,
): Promise<Buffer> {
  const remaining = ctx.deadline - Date.now();
  if (remaining <= 0) throw new SkipError("time budget");
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), Math.min(PER_REQUEST_TIMEOUT_MS, remaining));
  try {
    const headers: Record<string, string> = { "user-agent": USER_AGENT };
    if (accept) headers.accept = accept;
    const res = await ctx.fetch(url, { signal: ac.signal, headers, redirect: "follow" });
    if (res.url && !res.url.startsWith(allowedPrefix))
      throw new SkipError(`redirected off ${hostOf(allowedPrefix)}`);
    if (res.status === 404) throw new SkipError(`not found (404 from ${hostOf(url)})`);
    if (!res.ok) throw new SkipError(`HTTP ${res.status} from ${hostOf(url)}`);
    const len = Number(res.headers.get("content-length") ?? Number.NaN);
    if (Number.isFinite(len) && len > maxBytes) {
      await res.body?.cancel().catch(() => undefined);
      throw new SkipError(`${what} too large (${fmtBytes(len)} > ${fmtBytes(maxBytes)})`);
    }
    return await readCapped(res, maxBytes, what);
  } catch (e) {
    if (e instanceof SkipError) throw e;
    if (Date.now() >= ctx.deadline - 5) throw new SkipError("time budget");
    if (ac.signal.aborted) throw new SkipError(`request timed out (${hostOf(url)})`);
    throw new SkipError(`fetch failed: ${short(e)}`);
  } finally {
    clearTimeout(timer);
  }
}

async function getJson(
  ctx: PrepCtx,
  url: string,
  allowedPrefix: string,
  accept?: string,
): Promise<Record<string, unknown>> {
  const buf = await httpGet(ctx, url, allowedPrefix, METADATA_MAX_BYTES, "metadata", accept);
  let doc: unknown;
  try {
    doc = JSON.parse(buf.toString("utf8"));
  } catch {
    throw new SkipError(`unreadable metadata from ${hostOf(url)}`);
  }
  if (!isObj(doc)) throw new SkipError(`unreadable metadata from ${hostOf(url)}`);
  return doc;
}

/** npm `dist.integrity` (SRI, strongest algorithm first) or legacy `dist.shasum`; null = nothing to check. */
function verifyNpmIntegrity(
  buf: Buffer,
  integrity: string | undefined,
  shasum: string | undefined,
): boolean | null {
  if (integrity) {
    const byAlg = new Map<string, string>();
    for (const tok of integrity.trim().split(/\s+/)) {
      const dash = tok.indexOf("-");
      if (dash > 0)
        byAlg.set(
          tok.slice(0, dash).toLowerCase(),
          (tok.slice(dash + 1).split("?")[0] ?? "").trim(),
        );
    }
    for (const alg of ["sha512", "sha384", "sha256", "sha1"]) {
      const want = byAlg.get(alg);
      if (want) return createHash(alg).update(buf).digest("base64") === want;
    }
  }
  if (shasum) return createHash("sha1").update(buf).digest("hex") === shasum.toLowerCase();
  return null;
}

function sha256hex(buf: Buffer): string {
  return createHash("sha256").update(buf).digest("hex");
}

function fromCache(
  ctx: PrepCtx,
  req: DepRequest,
  name: string,
  version: string,
  range?: string,
): Outcome | null {
  const final = cacheDirFor(ctx.root, req.ecosystem, name, version);
  if (!final) return null;
  const marker = readMarker(final);
  if (!marker) return null;
  // A hit refreshes the entry's age, so the size cap evicts least recently USED.
  try {
    const now = new Date();
    utimesSync(join(final, MARKER), now, now);
  } catch {
    // an unwritable marker only makes the entry look older
  }
  if (marker.files === 0) {
    return {
      ok: false,
      skip: {
        ecosystem: req.ecosystem,
        name,
        reason: `no readable source files in ${name}@${version}`,
      },
    };
  }
  const source: DepSource = {
    ecosystem: req.ecosystem,
    name,
    version,
    path: final,
    why: req.why,
    files: marker.files,
    bytes: marker.bytes,
  };
  if (range !== undefined) source.range = range;
  return { ok: true, source };
}

function install(
  ctx: PrepCtx,
  req: DepRequest,
  name: string,
  version: string,
  url: string,
  archive: Buffer,
  entries: readonly ArchiveEntry[],
  strip: UnpackOptions["strip"],
  range?: string,
): Outcome {
  const final = cacheDirFor(ctx.root, req.ecosystem, name, version);
  if (!final) throw new SkipError("unsafe package name or version for a cache path");
  const raced = fromCache(ctx, req, name, version, range);
  if (raced) return raced;
  mkdirSync(dirname(final), { recursive: true });
  sweepStaleTmp(final);
  // Unpack into a private tmp dir and rename it into place: a reader either
  // sees no dir or a complete one, never a half-written package.
  const tmp = `${final}.tmp-${randomBytes(6).toString("hex")}`;
  try {
    mkdirSync(tmp);
    const r = unpackEntries(entries, tmp, { strip, maxUnpackedBytes: ctx.maxUnpackedBytes });
    const marker: CacheMarker = {
      name,
      version,
      url,
      sha256: sha256hex(archive),
      files: r.files,
      bytes: r.bytes,
      dirs: r.dirs,
    };
    // The marker is written LAST: its presence is the completeness proof.
    writeFileSync(join(tmp, MARKER), `${JSON.stringify(marker)}\n`);
    try {
      renameSync(tmp, final);
    } catch {
      if (readMarker(final)) {
        rmSync(tmp, { recursive: true, force: true }); // lost a race to an identical copy
      } else {
        rmSync(final, { recursive: true, force: true }); // an incomplete leftover — replace it
        renameSync(tmp, final);
      }
    }
  } catch (e) {
    rmSync(tmp, { recursive: true, force: true });
    throw e;
  }
  const done = fromCache(ctx, req, name, version, range);
  if (!done) throw new SkipError("cache write did not complete");
  return done;
}

function encodeNpmName(name: string): string {
  return name.startsWith("@") ? `@${encodeURIComponent(name.slice(1))}` : encodeURIComponent(name);
}

async function prepareNpm(req: DepRequest, ctx: PrepCtx): Promise<Outcome> {
  const name = req.name;
  if (!NPM_NAME_RE.test(name)) throw new SkipError("not a valid npm package name");
  if (req.version === null && req.range !== undefined && isNonRegistryRange(req.range)) {
    throw new SkipError(`not a registry version (${clip(req.range, 40)})`);
  }
  let version = req.version;
  let resolvedFrom: string | undefined;
  if (version !== null) {
    const hit = fromCache(ctx, req, name, version);
    if (hit) return hit;
  }
  let vdoc: Record<string, unknown>;
  if (version !== null && !name.startsWith("@")) {
    vdoc = await getJson(
      ctx,
      `${NPM_REGISTRY}${encodeNpmName(name)}/${encodeURIComponent(version)}`,
      NPM_REGISTRY,
    );
  } else {
    // Scoped packages always go through the packument: the per-version
    // endpoint has historically not served scoped names reliably.
    const pack = await getJson(
      ctx,
      `${NPM_REGISTRY}${encodeNpmName(name)}`,
      NPM_REGISTRY,
      NPM_ABBREVIATED,
    );
    const versions = isObj(pack.versions) ? pack.versions : {};
    if (version === null) {
      const range = req.range ?? "*";
      const picked = pickNpmVersion(
        Object.keys(versions),
        range,
        isObj(pack["dist-tags"]) ? pack["dist-tags"] : {},
      );
      if (!picked) throw new SkipError(`no published version matches ${clip(range, 40)}`);
      version = picked;
      resolvedFrom = range;
      const hit = fromCache(ctx, req, name, version, resolvedFrom);
      if (hit) return hit;
    }
    const v = versions[version];
    if (!isObj(v)) throw new SkipError(`version ${version} is not on the registry`);
    vdoc = v;
  }
  const dist = isObj(vdoc.dist) ? vdoc.dist : {};
  const tarball = str(dist.tarball) ?? "";
  if (!allowedUrl(tarball, NPM_REGISTRY))
    throw new SkipError(`tarball host not allowed (${hostOf(tarball) || "no tarball"})`);
  const archive = await httpGet(ctx, tarball, NPM_REGISTRY, ctx.maxArchiveBytes, "archive");
  if (verifyNpmIntegrity(archive, str(dist.integrity), str(dist.shasum)) === false)
    throw new SkipError("integrity mismatch");
  const entries = parseTar(gunzipCapped(archive));
  return install(ctx, req, name, version, tarball, archive, entries, "first", resolvedFrom);
}

interface PyFile {
  filename: string;
  url: string;
  sha256?: string;
  size?: number;
  yanked: boolean;
}

function pyFiles(list: unknown): PyFile[] {
  if (!Array.isArray(list)) return [];
  const out: PyFile[] = [];
  for (const f of list) {
    if (!isObj(f)) continue;
    const filename = str(f.filename);
    const url = str(f.url);
    if (!filename || !url) continue;
    const file: PyFile = { filename, url, yanked: f.yanked === true };
    const sha = isObj(f.digests) ? str(f.digests.sha256) : undefined;
    if (sha) file.sha256 = sha;
    if (typeof f.size === "number") file.size = f.size;
    out.push(file);
  }
  return out;
}

/** A pure-Python wheel beats an sdist (it is the code as installed); nothing else is usable. */
function choosePyFile(files: PyFile[]): PyFile | null {
  const live = files.filter((f) => !f.yanked);
  const pool = live.length ? live : files;
  const wheel = pool.find((f) => /-(?:py2\.)?py3-none-any\.whl$/i.test(f.filename));
  if (wheel) return wheel;
  return (
    pool.find((f) => /\.tar\.gz$/i.test(f.filename)) ??
    pool.find((f) => /\.zip$/i.test(f.filename)) ??
    null
  );
}

async function preparePypi(req: DepRequest, ctx: PrepCtx): Promise<Outcome> {
  const name = normPy(req.name);
  if (!/^[a-z0-9][a-z0-9.-]*$/.test(name)) throw new SkipError("not a valid PyPI project name");
  if (
    req.version === null &&
    req.range !== undefined &&
    (req.range.startsWith("@") || isNonRegistryRange(req.range))
  ) {
    throw new SkipError(`not a registry version (${clip(req.range, 40)})`);
  }
  let version = req.version;
  let resolvedFrom: string | undefined;
  let files: PyFile[];
  if (version !== null) {
    const hit = fromCache(ctx, req, name, version);
    if (hit) return hit;
    const doc = await getJson(
      ctx,
      `${PYPI_API}${encodeURIComponent(name)}/${encodeURIComponent(version)}/json`,
      PYPI_ORIGIN,
    );
    files = pyFiles(doc.urls);
  } else {
    const range = req.range ?? "*";
    const doc = await getJson(ctx, `${PYPI_API}${encodeURIComponent(name)}/json`, PYPI_ORIGIN);
    const latest = isObj(doc.info) ? str(doc.info.version) : undefined;
    const releases = isObj(doc.releases) ? doc.releases : {};
    if (latest && pyVersionMatches(latest, range)) {
      version = latest;
      files = pyFiles(doc.urls);
    } else {
      // A release whose every file is yanked is withdrawn: a range never picks
      // it (only an explicit pin may still fetch a yanked file).
      const usable = Object.keys(releases).filter((k) =>
        pyFiles(releases[k]).some((f) => !f.yanked),
      );
      const picked = maxPyVersion(usable, range);
      if (!picked) throw new SkipError(`no release matches ${clip(range, 40)}`);
      version = picked;
      files = pyFiles(releases[picked]);
    }
    resolvedFrom = range;
    const hit = fromCache(ctx, req, name, version, resolvedFrom);
    if (hit) return hit;
  }
  const file = choosePyFile(files);
  if (!file) throw new SkipError("no pure-Python wheel or sdist");
  if (!allowedUrl(file.url, PYPI_FILES))
    throw new SkipError(`file host not allowed (${hostOf(file.url) || "no url"})`);
  if (file.size !== undefined && file.size > ctx.maxArchiveBytes) {
    throw new SkipError(
      `archive too large (${fmtBytes(file.size)} > ${fmtBytes(ctx.maxArchiveBytes)})`,
    );
  }
  const archive = await httpGet(ctx, file.url, PYPI_FILES, ctx.maxArchiveBytes, "archive");
  if (file.sha256 && sha256hex(archive) !== file.sha256.toLowerCase())
    throw new SkipError("integrity mismatch");
  const lower = file.filename.toLowerCase();
  const isWheel = lower.endsWith(".whl");
  const entries =
    lower.endsWith(".zip") || isWheel ? parseZip(archive) : parseTar(gunzipCapped(archive));
  return install(
    ctx,
    req,
    name,
    version,
    file.url,
    archive,
    entries,
    isWheel ? "none" : "common-top",
    resolvedFrom,
  );
}

async function prepareOne(req: DepRequest, ctx: PrepCtx): Promise<Outcome> {
  try {
    const out = req.ecosystem === "npm" ? await prepareNpm(req, ctx) : await preparePypi(req, ctx);
    if (out.ok)
      ctx.log(
        `depsources: ${req.ecosystem} ${out.source.name}@${out.source.version} ready (${out.source.files} files)`,
      );
    else ctx.log(`depsources: ${req.ecosystem} ${req.name} skipped: ${out.skip.reason}`);
    return out;
  } catch (e) {
    const reason = e instanceof SkipError ? e.message : `unpack failed: ${short(e)}`;
    ctx.log(`depsources: ${req.ecosystem} ${req.name} skipped: ${reason}`);
    return { ok: false, skip: { ecosystem: req.ecosystem, name: req.name, reason } };
  }
}

/**
 * Plan, fetch and unpack the third-party sources this PR's review needs.
 * NEVER throws and never blocks past `timeoutMs` (plus one in-flight request
 * settling): every failure is a `skipped` entry, and a cached package is
 * served without touching the network at all.
 */
export async function prepareDependencySources(
  tree: string,
  changedFiles: ChangedFile[],
  opts: DepSourcesOptions,
): Promise<DepManifest> {
  // A throwing logger must not be the one thing that breaks totality.
  const log = (line: string): void => {
    try {
      opts.log?.(line);
    } catch {
      // ignore
    }
  };
  let root = opts.cacheDir;
  try {
    root = resolve(opts.cacheDir);
  } catch {
    // keep as given
  }
  const manifest: DepManifest = { dir: root, sources: [], skipped: [] };
  try {
    pruneDependencyCache(root, opts.maxCacheBytes ?? DEFAULT_MAX_CACHE_BYTES, log, {
      inUseMs: opts.cacheInUseMs ?? DEFAULT_CACHE_IN_USE_MS,
    });
  } catch (e) {
    log(`depsources: cache prune failed: ${short(e)}`);
  }
  try {
    let requests: DepRequest[];
    try {
      requests = planDependencyRequests(tree, changedFiles);
    } catch (e) {
      log(`depsources: planning failed: ${short(e)}`);
      return manifest;
    }
    const cap = Math.max(0, opts.maxPackages ?? DEFAULT_MAX_PACKAGES);
    const take = requests.slice(0, cap);
    // `globalThis.fetch` is typed as always present; a runtime without it
    // still gets a skip per package rather than a throw.
    const fetchImpl: typeof fetch | undefined =
      opts.fetch ?? (typeof globalThis.fetch === "function" ? globalThis.fetch : undefined);
    const results: Outcome[] = new Array<Outcome>(take.length);
    if (!fetchImpl) {
      take.forEach((r, i) => {
        results[i] = {
          ok: false,
          skip: { ecosystem: r.ecosystem, name: r.name, reason: "no fetch implementation" },
        };
      });
    } else {
      const ctx: PrepCtx = {
        root,
        fetch: fetchImpl,
        deadline: Date.now() + (opts.timeoutMs ?? DEFAULT_TIMEOUT_MS),
        maxArchiveBytes: opts.maxArchiveBytes ?? DEFAULT_MAX_ARCHIVE_BYTES,
        maxUnpackedBytes: opts.maxUnpackedBytes ?? DEFAULT_MAX_UNPACKED_BYTES,
        log,
      };
      let next = 0;
      const worker = async (): Promise<void> => {
        for (;;) {
          const i = next++;
          const req = take[i];
          if (!req) return;
          results[i] = await prepareOne(req, ctx);
        }
      };
      await Promise.all(Array.from({ length: Math.min(CONCURRENCY, take.length) }, worker));
    }
    for (const r of results) {
      if (!r) continue;
      if (r.ok) manifest.sources.push(r.source);
      else manifest.skipped.push(r.skip);
    }
    for (const r of requests.slice(cap))
      manifest.skipped.push({
        ecosystem: r.ecosystem,
        name: r.name,
        reason: "over the per-PR package cap",
      });
    log(`depsources: ${manifest.sources.length} source(s), ${manifest.skipped.length} skipped`);
  } catch (e) {
    log(`depsources: failed: ${short(e)}`);
  }
  return manifest;
}

// ---------------------------------------------------------------------------
// Cache size cap
// ---------------------------------------------------------------------------

/**
 * Keep the cache under `maxBytes`: complete entries are sized from their
 * marker (bytes plus a per-file charge) and aged by its mtime (a hit touches it), and the oldest are removed
 * until the rest fit. Incomplete dirs are the stale-tmp sweep's business, not
 * this one's. Returns the number of entries removed. Never throws on one bad
 * entry.
 */
export function pruneDependencyCache(
  root: string,
  maxBytes: number,
  log: (line: string) => void = () => {},
  opts: { inUseMs?: number } = {},
): number {
  const inUseMs = opts.inUseMs ?? 0;
  const inUseSince = Date.now() - inUseMs;
  const entries: { dir: string; bytes: number; mtimeMs: number }[] = [];
  let ecos: string[] = [];
  try {
    ecos = readdirSync(root);
  } catch {
    return 0;
  }
  for (const eco of ecos) {
    let names: string[] = [];
    try {
      names = readdirSync(join(root, eco));
    } catch {
      continue;
    }
    for (const n of names) {
      const dir = join(root, eco, n);
      const marker = readMarker(dir);
      if (!marker) continue;
      try {
        entries.push({
          dir,
          bytes: marker.bytes + (marker.files + marker.dirs) * CACHE_FILE_OVERHEAD_BYTES,
          mtimeMs: statSync(join(dir, MARKER)).mtimeMs,
        });
      } catch {
        // vanished between the listing and the stat
      }
    }
  }
  let total = entries.reduce((n, e) => n + e.bytes, 0);
  if (total <= maxBytes) return 0;
  entries.sort((a, b) => a.mtimeMs - b.mtimeMs);
  let removed = 0;
  for (const e of entries) {
    if (total <= maxBytes) break;
    // Oldest first, so every entry after this one is in use too.
    if (inUseMs > 0 && e.mtimeMs > inUseSince) break;
    try {
      rmSync(e.dir, { recursive: true, force: true });
      total -= e.bytes;
      removed++;
    } catch {
      // try the next one
    }
  }
  log(
    `depsources: cache over ${Math.round(maxBytes / MiB)} MiB — evicted ${removed} entr${removed === 1 ? "y" : "ies"}`,
  );
  return removed;
}

// ---------------------------------------------------------------------------
// Rendering
// ---------------------------------------------------------------------------

const MAX_RENDERED_SKIPS = 8;

/** Control characters (newlines included) as visible `\uXXXX` escapes — the
 * same rule as templates.ts' `flatControls`. `why` carries the PR's own file
 * paths, and git allows a newline in one: raw, it would open a line of
 * daemon-authored prompt. */
function flatControls(text: string): string {
  return text.replace(
    /[\u0000-\u001f\u007f\u2028\u2029]/g,
    (c) => `\\u${c.charCodeAt(0).toString(16).padStart(4, "0")}`,
  );
}

/** The round prompt's block. "" when there is nothing to say at all. */
export function renderDependencyNote(m: DepManifest): string {
  const f = flatControls;
  if (!m.sources.length && !m.skipped.length) return "";
  const lines: string[] = [];
  if (m.sources.length) {
    lines.push(
      "**Third-party sources (read-only, at the PR's locked versions).** The worktree has no installed dependencies, so these were unpacked for reading. When a finding depends on what a library does — the names it returns, the encodings it supports, its defaults, its error cases — check it in the library's code here and cite `path:line` from it. These are not part of the PR: never review the library itself. Include this whole block in EVERY pass's task string.",
    );
    for (const s of m.sources) {
      const unlocked =
        s.range !== undefined ? ` (no lockfile pin: newest match for \`${f(s.range)}\`)` : "";
      lines.push(
        `- ${s.ecosystem} \`${f(s.name)}@${f(s.version)}\`${unlocked} — ${f(s.why)} → \`${f(s.path)}\``,
      );
    }
  } else {
    lines.push(
      "**Third-party sources: none could be unpacked for this PR.** The worktree has no installed dependencies. A finding that depends on what a library does still stands on well-known, documented behaviour: name the library, the version the PR pins and the behaviour you rely on, so the validator can weigh it. Include this whole block in EVERY pass's task string.",
    );
  }
  if (m.skipped.length) {
    const shown = m.skipped
      .slice(0, MAX_RENDERED_SKIPS)
      .map((s) => `\`${f(s.name)}\` (${f(s.reason)})`);
    const more = m.skipped.length - shown.length;
    lines.push(`Not available: ${shown.join("; ")}${more > 0 ? `; +${more} more` : ""}.`);
  }
  return lines.join("\n");
}
