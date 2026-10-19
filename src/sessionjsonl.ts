// Which JSONL is a PR session's transcript. Neutral: the daemon's lifecycle
// (src/pr-session-lifecycle.ts) and the bot worker (src/botworker.ts) must
// pick the same file, and the worker imports nothing that opens the state
// store.
import { readdirSync, statSync } from "node:fs";
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
