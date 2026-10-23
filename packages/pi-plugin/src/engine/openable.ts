// What makes a finished round openable in pi: where its session JSONLs
// live under the run dir, and the small record `qcr open` needs to start pi on
// them again. Pure: no pi SDK, no engine, so the CLI, the scan runner and the
// extensions can all import it.
//
//   <round dir>/session/<time>_<id>.jsonl            the main session
//   <round dir>/lens-sessions/<lens run id>/*.jsonl  one lens pass (a retried
//                                                    pass leaves a file per attempt)
//   <round dir>/open-meta.json                       how to start pi on them
//
// A scan keeps its leaves the same way, one directory per case under the
// run's transcript dir (`scan/transcripts/<run>/lens-sessions/<case>/`).
import { mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";

/** Under a round's dir: the main session's JSONL. */
export const MAIN_SESSION_DIR = "session";
/** Under a round's dir: one directory per lens pass, holding its session JSONL. */
export const LENS_SESSIONS_DIR = "lens-sessions";
/** A round's lens ledger, in the dir that keeps its lens sessions. */
export const LENS_LEDGER_FILE = "lens-ledger.jsonl";
export const OPEN_META_FILE = "open-meta.json";
/** What a debug round (`qcr review --debug-pi`) records of itself in the round dir. */
export const DEBUG_STATUS_FILE = "debug-round.json";

/** The names of a round's env that are kept for `qcr open`: the QCR_* names the
 * round's extensions read. A name that smells of a secret is never kept. */
const SECRETISH = /KEY|TOKEN|SECRET|PASSWORD|CREDENTIAL/i;

export function openEnvOf(
  env: Readonly<Record<string, string | undefined>>,
): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(env))
    if (k.startsWith("QCR_") && v !== undefined && !SECRETISH.test(k)) out[k] = v;
  return out;
}

export interface OpenMeta {
  version: 1;
  sessionName: string;
  /** Where the round's pi ran (the run's out dir, holding the reviewer stub). */
  cwd: string;
  model: string;
  /** The round's QCR_* env, without anything secret-looking. */
  env: Record<string, string>;
}

export function writeOpenMeta(roundDir: string, meta: OpenMeta): void {
  try {
    mkdirSync(roundDir, { recursive: true });
    writeFileSync(join(roundDir, OPEN_META_FILE), JSON.stringify(meta, null, 2) + "\n");
  } catch {
    // Openability is evidence: a failure to record it never costs the round.
  }
}

export function readOpenMeta(roundDir: string): OpenMeta | null {
  try {
    const m = JSON.parse(readFileSync(join(roundDir, OPEN_META_FILE), "utf8")) as OpenMeta;
    return m.version === 1 && typeof m.cwd === "string" && typeof m.env === "object" ? m : null;
  } catch {
    return null;
  }
}

const mtime = (path: string): number => {
  try {
    return statSync(path).mtimeMs;
  } catch {
    return 0;
  }
};

/** The newest session JSONL directly in `dir`; null when there is none. */
export function newestJsonl(dir: string): string | null {
  let names: string[];
  try {
    names = readdirSync(dir);
  } catch {
    return null;
  }
  const files = names
    .filter((n) => n.endsWith(".jsonl"))
    .map((n) => join(dir, n))
    .sort((a, b) => mtime(b) - mtime(a) || b.localeCompare(a));
  return files[0] ?? null;
}

/** The round's main session JSONL. */
export function mainSessionOf(roundDir: string): string | null {
  return newestJsonl(join(roundDir, MAIN_SESSION_DIR));
}

export interface LensSessionRef {
  /** The lens run id (a scan: the case's file stem). */
  id: string;
  file: string;
}

/** The lens sessions a round kept, oldest first, each with its last attempt's file. */
export function lensSessionsOf(roundDir: string): LensSessionRef[] {
  const base = join(roundDir, LENS_SESSIONS_DIR);
  let ids: string[];
  try {
    ids = readdirSync(base);
  } catch {
    return [];
  }
  return ids
    .map((id) => ({ id, file: newestJsonl(join(base, id)) }))
    .filter((r): r is LensSessionRef => r.file !== null)
    .sort((a, b) => mtime(a.file) - mtime(b.file) || a.id.localeCompare(b.id));
}

/** Agent name by lens run id, from the round's lens ledger. */
export function lensAgentsOf(roundDir: string): Map<string, string> {
  const out = new Map<string, string>();
  try {
    for (const line of readFileSync(join(roundDir, LENS_LEDGER_FILE), "utf8").split("\n")) {
      if (!line.trim()) continue;
      try {
        const row = JSON.parse(line) as { id?: unknown; agent?: unknown };
        if (typeof row.id === "string" && typeof row.agent === "string") out.set(row.id, row.agent);
      } catch {
        // a torn line
      }
    }
  } catch {
    // no ledger: ids only
  }
  return out;
}

/** Whether `dir` is a round dir that kept at least one session. */
export function hasSessions(dir: string): boolean {
  return mainSessionOf(dir) !== null || lensSessionsOf(dir).length > 0;
}
