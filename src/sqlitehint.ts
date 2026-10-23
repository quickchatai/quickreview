// When the SQLite driver cannot load. The state database (src/state.ts) runs
// on better-sqlite3, a native module: an install whose package manager
// skipped its files, or a platform it ships no prebuilt driver for, has the
// JavaScript but no driver. The verbs a person runs from an npm install
// (`qcr version`, `qcr review`, `qcr login`, `qcr pi`, `qcr update`) never
// open the database, so they keep working; every other verb fails with this
// hint instead of a stack trace.

/** Is `err` the SQLite driver failing to load (the package missing, or its
 * native file missing or built for another Node)? */
export function isSqliteUnavailable(err: unknown): boolean {
  const code = err instanceof Error ? String((err as { code?: unknown }).code ?? "") : "";
  const msg = err instanceof Error ? `${err.message} ${code}` : String(err);
  const missing = /cannot find (module|package)|ERR_MODULE_NOT_FOUND/i.test(msg);
  if (/better[-_]sqlite3/i.test(msg) && missing) return true;
  return (
    /Could not locate the bindings file/i.test(msg) ||
    /better_sqlite3\.node/i.test(msg) ||
    (/NODE_MODULE_VERSION/.test(msg) && /sqlite/i.test(msg))
  );
}

/** The hint for a verb that needs the state database when the driver cannot load. */
export function sqliteHint(verb: string | undefined, err: unknown): string {
  const why = (err instanceof Error ? err.message : String(err)).split("\n")[0]!.slice(0, 200);
  return [
    `qcr${verb ? ` ${verb}` : ""}: this needs the state database, and its SQLite driver (better-sqlite3) cannot load here: ${why}`,
    "`qcr review`, `qcr login`, `qcr pi`, `qcr version` and `qcr update` work without it.",
    "For the rest, reinstall qcr where the driver can load: Linux, macOS or Windows on x64 or arm64 (the driver ships prebuilt for those),",
    "on the same Node major the install ran under, with the package manager allowed to install better-sqlite3's files.",
  ].join("\n");
}
