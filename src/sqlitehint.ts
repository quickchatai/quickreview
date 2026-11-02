// When the SQLite driver cannot load. The state database (src/state.ts) runs
// on better-sqlite3, a native module and an optional dependency: an install
// whose package manager skipped it, could not build it, or has no prebuilt
// driver for the platform has the JavaScript but no driver. The bin routes the
// verbs in SQLITE_FREE_VERBS, and the home (a bare `qcr`), to modules that
// never load the store (src/qcrbin.ts, pinned by tests/sqlite-free-routes.test.ts),
// so they keep working; every other verb fails with this hint instead of a
// stack trace.

/** The verbs that run without the state database, each on its own route in
 * the bin's front door. The hint names them, and the routes fence walks them. */
export const SQLITE_FREE_VERBS = [
  "review",
  "scan",
  "login",
  "pi",
  "version",
  "update",
  "plugin",
] as const;

/** Is `err` the SQLite driver failing to load (the package missing, or its
 * native file missing or built for another Node)? A loader that wraps the
 * failure keeps it as the error's `cause`, which is read too. */
export function isSqliteUnavailable(err: unknown): boolean {
  return driverError(err) !== null;
}

/** The driver's own failure in `err`'s cause chain, or null. */
function driverError(err: unknown): unknown {
  let e = err;
  for (let depth = 0; e !== undefined && e !== null && depth < 5; depth++) {
    if (driverFailure(e)) return e;
    e = e instanceof Error ? e.cause : undefined;
  }
  return null;
}

function driverFailure(err: unknown): boolean {
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

/** "`qcr`, `qcr review`, … and `qcr update`": every command that works without the driver. */
function freeVerbs(): string {
  const all = ["`qcr`", ...SQLITE_FREE_VERBS.map((v) => `\`qcr ${v}\``)];
  return `${all.slice(0, -1).join(", ")} and ${all[all.length - 1]}`;
}

/** The hint for a verb that needs the state database when the driver cannot load. */
export function sqliteHint(verb: string | undefined, err: unknown): string {
  const first = driverError(err) ?? err;
  const why = (first instanceof Error ? first.message : String(first))
    .split("\n")[0]!
    .slice(0, 200);
  return [
    `qcr${verb ? ` ${verb}` : ""}: this needs the state database, and its SQLite driver (better-sqlite3) cannot load here: ${why}`,
    `${freeVerbs()} work without it.`,
    "For the rest, reinstall qcr where the driver can load: Linux, macOS or Windows on x64 or arm64 (the driver ships prebuilt for those),",
    "on the same Node major the install ran under, with the package manager allowed to install better-sqlite3's files.",
  ].join("\n");
}
