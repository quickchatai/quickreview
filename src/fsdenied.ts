// When a verb may not write where it tried. A filesystem refusal (no
// permission, a read-only file system) on a path is the person's to fix, so
// the `qcr` bin says it in one line naming the path and the refusal, never as
// a stack trace. Any other error is not this one and is left to propagate.

const REFUSALS: Readonly<Record<string, string>> = {
  EACCES: "permission denied",
  EPERM: "operation not permitted",
  EROFS: "read-only file system",
};

/** The one line for `err` when it is a filesystem refusal on a named path,
 * else null. */
export function fsDeniedLine(verb: string | undefined, err: unknown): string | null {
  if (!(err instanceof Error)) return null;
  const e = err as { code?: unknown; path?: unknown; syscall?: unknown };
  const code = typeof e.code === "string" ? e.code : "";
  const why = REFUSALS[code];
  if (why === undefined) return null;
  const path = typeof e.path === "string" && e.path !== "" ? e.path : null;
  if (path === null) return null;
  const op = typeof e.syscall === "string" && e.syscall !== "" ? `, ${e.syscall}` : "";
  return `qcr${verb ? ` ${verb}` : ""}: ${path}: ${why} (${code}${op}) — \`qcr install where\` shows where this install keeps its files`;
}
