// Which JSONL is a PR session's transcript. Neutral: the daemon's lifecycle
// (src/pr-session-lifecycle.ts) and the bot worker (src/botworker.ts) must
// pick the same file, and the worker imports nothing that opens the state
// store.
import { existsSync, readdirSync, renameSync, statSync } from "node:fs";
import { join } from "node:path";

/** Newest *.jsonl anywhere under a session's `--session-dir`. Ties break on the
 * filename: pi names sessions `<timestamp>_<uuid>.jsonl`. Undefined when there
 * is none (a PR never born, or a dir that is gone). */
export function newestSessionFile(root: string): string | undefined {
  let newest: { path: string; mtime: number; name: string } | undefined;
  const walk = (dir: string): void => {
    let entries;
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      const full = join(dir, e.name);
      if (e.isDirectory()) walk(full);
      else if (e.name.endsWith(".jsonl")) {
        const mtime = statSync(full).mtimeMs;
        const better =
          !newest || mtime > newest.mtime || (mtime === newest.mtime && e.name > newest.name);
        if (better) newest = { path: full, mtime, name: e.name };
      }
    }
  };
  walk(root);
  return newest?.path;
}

/** One JSONL moved aside by `rotateSessionFiles`. */
export interface RotatedFile {
  from: string;
  to: string;
}

/**
 * Rotate a PR session's JSONLs (P8.12): every `*.jsonl` under `root` is renamed in
 * place to `<name>.rotated-<stamp>`, so `newestSessionFile` finds none and the next
 * worker BIRTHS a session instead of resuming the old conversation. The rotated file
 * stays beside the others (the archiver moves the whole dir; `pi --session <path>`
 * still opens it). The operator's restart-session does this after it has proven the
 * old worker gone; the new session starts from the round order, which re-hands the
 * review ledger that ledger-pin mirrored to `state/ledgers/pr-<n>.md` (the rotation
 * does not touch it).
 */
export function rotateSessionFiles(root: string, stamp: string): RotatedFile[] {
  const moves: RotatedFile[] = [];
  const walk = (dir: string): void => {
    let entries;
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      const full = join(dir, e.name);
      if (e.isDirectory()) walk(full);
      else if (e.name.endsWith(".jsonl")) {
        let to = `${full}.rotated-${stamp}`;
        for (let k = 2; existsSync(to); k++) to = `${full}.rotated-${stamp}-${k}`;
        renameSync(full, to);
        moves.push({ from: full, to });
      }
    }
  };
  walk(root);
  return moves;
}

/** Undo a rotation: each file back to its own name, unless something took the name. */
export function restoreRotatedFiles(moves: readonly RotatedFile[]): void {
  for (const { from, to } of [...moves].reverse())
    if (existsSync(to) && !existsSync(from)) renameSync(to, from);
}
