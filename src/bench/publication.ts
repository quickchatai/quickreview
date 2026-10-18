import { randomUUID } from "node:crypto";
import { readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { basename, dirname, join } from "node:path";

/** Publish a complete artifact with a same-directory atomic replacement. */
export function publishText(file: string, text: string): void {
  const temporary = join(dirname(file), `.${basename(file)}.${randomUUID()}.tmp`);
  try {
    writeFileSync(temporary, text, { flag: "wx" });
    renameSync(temporary, file);
  } finally {
    rmSync(temporary, { force: true });
  }
}

/** An unreadable checkpoint proves no completed work. Callers apply their
 * own fingerprint and schema checks before retaining the parsed object. */
export function readJsonValue(file: string): unknown {
  try {
    return JSON.parse(readFileSync(file, "utf8")) as unknown;
  } catch {
    return undefined;
  }
}

export function readJsonObject(file: string): Record<string, unknown> | undefined {
  const value = readJsonValue(file);
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

/** Changed result bytes invalidate old scores before atomic replacement. */
export function publishChangedResult(file: string, text: string, invalidate: () => void): boolean {
  let before: string | null = null;
  try {
    before = readFileSync(file, "utf8");
  } catch {
    // No readable earlier result.
  }
  if (before === text) return false;
  invalidate();
  publishText(file, text);
  return true;
}
