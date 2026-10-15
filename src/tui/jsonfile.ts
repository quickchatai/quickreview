// A JSON state file the TUI keeps on the operator's machine: read with its
// three answers kept apart, written whole. Shared by the stores whose history
// a merge-then-save could otherwise destroy (the survey candidates, the change
// register); each keeps its own schema check and its own recovery policy.
import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

export function errText(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/**
 * `absent` (no file yet) and `unreadable` (a file that exists and could not be
 * read or parsed — a torn write, EACCES, EISDIR) are different facts: the
 * first means there is no history, the second that there is one nobody can
 * see. `parsed` is JSON, not yet the caller's schema.
 */
export type JsonFileRead =
  | { state: "parsed"; value: unknown }
  | { state: "absent" }
  | { state: "unreadable"; reason: string };

export function readJsonFile(path: string): JsonFileRead {
  let raw: string;
  try {
    raw = readFileSync(path, "utf8");
  } catch (err) {
    const code = (err as NodeJS.ErrnoException | undefined)?.code;
    if (code === "ENOENT") return { state: "absent" };
    return { state: "unreadable", reason: code ?? errText(err) };
  }
  try {
    return { state: "parsed", value: JSON.parse(raw) as unknown };
  } catch (err) {
    return { state: "unreadable", reason: errText(err) };
  }
}

/** `value` as pretty JSON, written beside `path` and renamed over it, so a
 * reader never sees half a file. */
export function writeJsonFile(path: string, value: unknown): void {
  mkdirSync(dirname(path), { recursive: true });
  const tmp = `${path}.tmp`;
  writeFileSync(tmp, `${JSON.stringify(value, null, 2)}\n`);
  renameSync(tmp, path);
}
