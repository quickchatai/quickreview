// What a PR's session JSONL looks like before a worker resumes it: the static half
// of the resume rehearsal (P8.4), shared with the cutover preflight (P8.4b). Pure
// reading, nothing here opens a session, a provider or the state store, and no
// file is written. The JSONL is the live bot's own transcript (private): only
// counts, names and shapes leave this module, never text.
//
// The tmux bot's `pi` wrote these files; the first per-round worker resumes them
// under the SAME id (the provider's cache key). Three things can break that, and
// each has a field here:
//   - a line that is not JSON, or a header that is not a v3 session: `badLines`,
//     `header`;
//   - an entry type or custom entry the worker's pi does not know, which it must
//     tolerate: `entryTypes`, `customTypes`, `markers` (the writers of the
//     session-command ledger and the inject bridge go with P9.1, their entries
//     stay in old files for ever);
//   - a header cwd that the release image does not have: `legacyCwdResolution`.
import { readFileSync, statSync } from "node:fs";
import { performance } from "node:perf_hooks";

/** The path the legacy container mounted the sandbox root at; every PR JSONL
 * written before the cutover names it (or a worktree under it) as its cwd. */
export const LEGACY_SANDBOX_ROOT = "/opt/quickreview/sandbox";

/** The comment markers the daemon and the inject bridge put in a user turn, which
 * the resumed history keeps: `<!-- qcr-<name>:`. Counted by name. */
const MARKER_RE = /<!-- (qcr-[a-z-]+):/g;
/** A path under the legacy sandbox root, to its first component. */
const LEGACY_PATH_RE = new RegExp(
  `${LEGACY_SANDBOX_ROOT.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}/([A-Za-z0-9._-]+)`,
  "g",
);

export interface SessionHeader {
  id: string;
  version: unknown;
  cwd: string | null;
}

/** The system message pi 1.3 stores first in the file. */
export interface StoredSystem {
  /** Names of its prompt sections (preamble, project_context, cwd, ...). */
  sections: string[];
  /** Names of the tools it recorded. */
  tools: string[];
  /** The recorded tools whose name its preamble (the standing instructions) starts
   * a word with (`subagent` matches "subagents"). A resumed
   * session keeps the preamble it was born with, so these are what the model is
   * still told to use. */
  preambleTools: string[];
  /** The directory its `cwd` section tells the model it works in. */
  cwd: string | null;
  /** The D34 reviewer stub against the context file the old session was shown:
   * `current` holds the stub's text whole, `drifted` has a context file that is
   * not it, `absent` has none. `unchecked` when no stub was given. */
  stub: "current" | "drifted" | "absent" | "unchecked";
}

export interface InspectOptions {
  /** The text of the reviewer stub (deploy/reviewer/AGENTS.override.md) the
   * release image carries. */
  stub?: string;
}

export interface JsonlFacts {
  file: string;
  bytes: number;
  lines: number;
  /** Lines that are not a JSON object. */
  badLines: number;
  /** null when the first line is not a session header with an id. */
  header: SessionHeader | null;
  entryTypes: Record<string, number>;
  /** `custom` entries by their customType (or legacy `subtype`). */
  customTypes: Record<string, number>;
  /** Message roles. */
  roles: Record<string, number>;
  system: StoredSystem | null;
  /** `<!-- qcr-...:` markers inside messages, by name. */
  markers: Record<string, number>;
  /** Paths under the legacy sandbox root mentioned in messages, by first component. */
  legacyPaths: Record<string, number>;
  /** Wall time to read the file and JSON-parse every line. */
  parseMs: number;
}

const bump = (into: Record<string, number>, key: string, by = 1): void => {
  into[key] = (into[key] ?? 0) + by;
};

const isObject = (v: unknown): v is Record<string, unknown> =>
  typeof v === "object" && v !== null && !Array.isArray(v);

/** Read one session JSONL and describe it. Never throws on content: a bad line is
 * counted. An unreadable file throws (the caller names it). */
export function inspectSessionJsonl(file: string, options: InspectOptions = {}): JsonlFacts {
  const t0 = performance.now();
  const text = readFileSync(file, "utf8");
  const facts: JsonlFacts = {
    file,
    bytes: statSync(file).size,
    lines: 0,
    badLines: 0,
    header: null,
    entryTypes: {},
    customTypes: {},
    roles: {},
    system: null,
    markers: {},
    legacyPaths: {},
    parseMs: 0,
  };
  let first = true;
  for (const line of text.split("\n")) {
    if (line === "") continue;
    facts.lines++;
    let entry: unknown;
    try {
      entry = JSON.parse(line);
    } catch {
      facts.badLines++;
      first = false;
      continue;
    }
    if (!isObject(entry)) {
      facts.badLines++;
      first = false;
      continue;
    }
    const type = typeof entry["type"] === "string" ? entry["type"] : "(none)";
    bump(facts.entryTypes, type);
    if (first) {
      first = false;
      if (type === "session" && typeof entry["id"] === "string" && entry["id"] !== "")
        facts.header = {
          id: entry["id"],
          version: entry["version"],
          cwd: typeof entry["cwd"] === "string" ? entry["cwd"] : null,
        };
    }
    if (type === "custom") {
      // An older pi wrote the whole entry object as the type: its `subtype` names it.
      const raw = entry["customType"];
      const name = isObject(raw)
        ? (raw["subtype"] ?? raw["customType"])
        : (raw ?? entry["subtype"]);
      bump(facts.customTypes, typeof name === "string" ? name : "(unnamed)");
    }
    const message = entry["message"];
    if (type === "message" && isObject(message)) {
      const role = typeof message["role"] === "string" ? message["role"] : "(none)";
      bump(facts.roles, role);
      if (role === "system" && facts.system === null && isObject(message["sections"])) {
        const added = message["toolsAdded"];
        const sections = message["sections"];
        const context =
          typeof sections["project_context"] === "string" ? sections["project_context"] : "";
        const cwd =
          typeof sections["cwd"] === "string"
            ? /<cwd>\s*(\S+)\s*<\/cwd>/.exec(sections["cwd"])
            : null;
        const preamble = typeof sections["preamble"] === "string" ? sections["preamble"] : "";
        const tools = Array.isArray(added)
          ? added.flatMap((t) => (isObject(t) && typeof t["name"] === "string" ? [t["name"]] : []))
          : [];
        facts.system = {
          sections: Object.keys(sections),
          preambleTools: tools.filter((t) =>
            new RegExp(`\\b${t.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}`).test(preamble),
          ),
          cwd: cwd?.[1] ?? null,
          stub:
            options.stub === undefined
              ? "unchecked"
              : context.includes(options.stub.trim())
                ? "current"
                : context.includes("<project_instructions")
                  ? "drifted"
                  : "absent",
          tools,
        };
      }
      // Markers and legacy paths live in the message body; the line is the
      // cheapest place to find them without walking every content shape.
      for (const m of line.matchAll(MARKER_RE)) bump(facts.markers, m[1] as string);
      for (const m of line.matchAll(LEGACY_PATH_RE)) bump(facts.legacyPaths, m[1] as string);
    }
  }
  facts.parseMs = performance.now() - t0;
  return facts;
}

/** How a header cwd fares in the release image. */
export type CwdResolution =
  /** a directory the updater mounts at its legacy path (`wt`, the base clone) */
  | "mount"
  /** beneath such a mount (`wt/pr-N`) */
  | "under-mount"
  /** the legacy sandbox root itself: the container has it as the parent of the
   * mounts, but none of the old tree (scripts/, extensions/, state/) is in it */
  | "mount-parent"
  | "unmounted";

/** The directories the release image's container mounts at the legacy path, under
 * `LEGACY_SANDBOX_ROOT` (deploy/qcr-update.sh builds the daemon container: the
 * worktree directory and the base clone, each mounted a second time there). */
export function legacyMountDirs(updaterText: string, cloneDir: string): string[] {
  const dirs = new Set<string>();
  const re = /:\$\{C\[LEGACY_SANDBOX_ROOT\]\}\/([^"]+?)"/g;
  for (const m of updaterText.matchAll(re)) {
    const dir = (m[1] as string).replace(/\$\{C\[BASE_CLONE_DIR\]\}/, cloneDir);
    if (!dir.includes("${")) dirs.add(dir);
  }
  return [...dirs].sort();
}

/** Does a header cwd resolve inside a container that mounts `mountDirs` under the
 * legacy sandbox root? */
export function legacyCwdResolution(
  cwd: string,
  mountDirs: readonly string[],
  root: string = LEGACY_SANDBOX_ROOT,
): CwdResolution {
  const norm = cwd.replace(/\/+$/, "");
  if (norm === root) return "mount-parent";
  if (!norm.startsWith(`${root}/`)) return "unmounted";
  const rel = norm.slice(root.length + 1);
  for (const dir of mountDirs) {
    if (rel === dir) return "mount";
    if (rel.startsWith(`${dir}/`)) return "under-mount";
  }
  return "unmounted";
}

/** Which of a file's legacy path references the release image can still open: the
 * first component is a mounted directory. The rest name the old production tree,
 * which the release image keeps at its app root instead. */
export function legacyPathsResolving(
  paths: Readonly<Record<string, number>>,
  mountDirs: readonly string[],
): { resolving: Record<string, number>; gone: Record<string, number> } {
  const resolving: Record<string, number> = {};
  const gone: Record<string, number> = {};
  for (const [first, n] of Object.entries(paths))
    (mountDirs.includes(first) ? resolving : gone)[first] = n;
  return { resolving, gone };
}
