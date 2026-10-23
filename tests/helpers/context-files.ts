// Which context file a pi session loads: a model of pi 1.3.0's loader, and the
// reader of the recorded inventory (tests/fixtures/context-files/inventory.json).
//
// pi builds the set in `loadProjectContextFiles` (dist/core/resource-loader.js,
// pinned 1.3.0): the agentDir's context file first, then the context file of
// the cwd and of EVERY ancestor of it, outermost first. Per directory it takes
// the first of CONTEXT_CANDIDATES that is a file (`loadContextFileFromDir`).
// `--no-context-files` / `-nc` skips all of it. (pi also drops an ancestor's
// file that a linked worktree nested inside its main repo shadows; none of our
// routes runs in such a worktree, so the model leaves that out.)
//
// The model works on a VIRTUAL filesystem — a map from absolute path to the
// repo file whose content sits there — so the VM's /opt/quickreview/sandbox and
// the bench image's tree can be reasoned about on any machine, and a
// developer's own ~/AGENTS.md can never leak into a result.
import { readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";

/** pi 1.3.0's candidates, in the order it tries them in one directory. */
export const CONTEXT_CANDIDATES: readonly string[] = [
  "AGENTS.override.md",
  "AGENTS.md",
  "AGENTS.MD",
  "CLAUDE.md",
  "CLAUDE.MD",
];

/** A virtual filesystem: absolute path → the repo file whose content is there. */
export type ContextFs = Map<string, string>;

export interface LoadedContext {
  path: string;
  /** The repo file whose content pi loads from `path`. */
  source: string;
}

/** How a route's context files are chosen: pi's own discovery ("default"), none
 * at all ("disabled"), or handed to an in-process session as data with
 * discovery off ("injected": the SDK host's agentsFilesOverride). */
export type ContextFlag = "default" | "disabled" | "injected";

/** Whether an argv switches context files off (`--no-context-files`, `-nc`). */
export function contextFlagOf(argv: readonly string[]): ContextFlag {
  const end = argv.indexOf("--");
  const flags = end === -1 ? argv : argv.slice(0, end);
  return flags.includes("--no-context-files") || flags.includes("-nc") ? "disabled" : "default";
}

function fromDir(fs: ContextFs, dir: string): LoadedContext | null {
  for (const name of CONTEXT_CANDIDATES) {
    const path = join(dir, name);
    const source = fs.get(path);
    if (source !== undefined) return { path, source };
  }
  return null;
}

/** The effective set for one pi process, in the order pi concatenates it. */
export function effectiveContextFiles(
  fs: ContextFs,
  o: { cwd: string; agentDir: string; contextFiles: ContextFlag },
): LoadedContext[] {
  if (o.contextFiles === "disabled") return [];
  const out: LoadedContext[] = [];
  const global = fromDir(fs, resolve(o.agentDir));
  if (global) out.push(global);
  const ancestors: LoadedContext[] = [];
  let dir = resolve(o.cwd);
  for (;;) {
    const f = fromDir(fs, dir);
    if (f && !out.some((x) => x.path === f.path)) ancestors.unshift(f);
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return [...out, ...ancestors];
}

/** The directory `dir` and every ancestor of it that carries a context file. */
export function ancestorsWithContext(
  has: (path: string) => boolean,
  dir: string,
): { dir: string; file: string }[] {
  const hits: { dir: string; file: string }[] = [];
  let d = resolve(dir);
  for (;;) {
    const file = CONTEXT_CANDIDATES.find((n) => has(join(d, n)));
    if (file) hits.push({ dir: d, file });
    const parent = dirname(d);
    if (parent === d) break;
    d = parent;
  }
  return hits;
}

// ---- the recorded inventory ---------------------------------------------------

export interface InventoryRow {
  /** Where pi starts (a virtual path; `/qcr-checkout` is whichever checkout
   * the route runs from). */
  cwd: string;
  /** The agentDir pi reads its own config and login from. */
  agentDir: string;
  contextFiles: ContextFlag;
  /** What pi loads, in order. Empty for a route that disables context files. */
  effective: LoadedContext[];
  note?: string;
}

export interface Inventory {
  pi: string;
  routes: Record<string, InventoryRow>;
}

export const INVENTORY_PATH = join(
  import.meta.dirname,
  "..",
  "fixtures",
  "context-files",
  "inventory.json",
);

/** The recorded table. The route checks and the canary
 * parity checks assert against it. */
export function readInventory(path: string = INVENTORY_PATH): Inventory {
  return JSON.parse(readFileSync(path, "utf8")) as Inventory;
}

export function inventoryRow(route: string): InventoryRow {
  const row = readInventory().routes[route];
  if (!row) throw new Error(`no route ${JSON.stringify(route)} in the context-file inventory`);
  return row;
}
