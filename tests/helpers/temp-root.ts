// One temp root per test file, with TMPDIR pointed at it, so `os.tmpdir()`
// — and `mktemp` in any script the file spawns — lands inside it, and the
// whole root goes when the file finishes. Installed for every file by
// tests/helpers/install-env.ts. Tests still clean up after themselves where
// they can; this is the backstop that makes a forgotten rmSync cost nothing
// rather than a dir left behind in /tmp.
//
// Removal is the caller's afterAll, never a process 'exit' hook: those never
// fire in a vitest worker.
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";

export interface TempRoot {
  readonly root: string;
  /** Remove the root and restore TMPDIR as it was. Idempotent. */
  close(): void;
}

export function openTempRoot(realTmp: string, prefix: string): TempRoot {
  const root = mkdtempSync(join(realTmp, prefix));
  const had = "TMPDIR" in process.env;
  const prev = process.env.TMPDIR;
  process.env.TMPDIR = root;
  let open = true;
  return {
    root,
    close() {
      if (!open) return;
      open = false;
      if (process.env.TMPDIR === root) {
        if (had) process.env.TMPDIR = prev;
        else delete process.env.TMPDIR;
      }
      rmSync(root, { recursive: true, force: true });
    },
  };
}
