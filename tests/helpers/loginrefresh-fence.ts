// The scan behind the fence "only src/loginrefresh and the entrypoint's
// login mode (pi's /login) write the pihome's auth.json". Pure over a root, so
// tests/loginrefresh.test.ts runs it on the real tree AND on a planted copy: a
// fence that cannot be made to fail is not a fence.
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { stripComments } from "./engine-fences.js";
import { EXTENSION_DIRS, SRC_DIRS, sourceSpecifiers } from "./source-trees.js";

const WRITE =
  /\b(writeFileSync|writeFile|renameSync|rename|copyFileSync|copyFile|appendFileSync|appendFile|createWriteStream|writeFileAtomic|rsync|cp|install|tee)\b|>>?\s*["']?[^\s"']*auth\.json/;

function sources(dir: string): string[] {
  if (!existsSync(dir)) return [];
  return readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
    const p = join(dir, e.name);
    if (e.isDirectory()) return e.name === "node_modules" || e.name === ".git" ? [] : sources(p);
    return /\.(ts|mjs|sh|py|yml|j2)$/.test(e.name) ? [p] : [];
  });
}

/**
 * The files (relative to `root`) holding a statement that both names an
 * `auth.json` and writes. A statement runs to the next `;` or blank line.
 */
export function authJsonWriters(root: string): string[] {
  const hits: string[] = [];
  for (const f of [...SRC_DIRS, ...EXTENSION_DIRS, "scripts", "docker", "deploy", "bench"].flatMap(
    (d) => sources(join(root, d)),
  )) {
    const raw = readFileSync(f, "utf8");
    const text = f.endsWith(".ts") ? stripComments(raw) : raw.replace(/^\s*#.*$/gm, "");
    if (text.split(/;|\n\s*\n/).some((st) => /auth\.json/.test(st) && WRITE.test(st)))
      hits.push(f.slice(root.length + 1));
  }
  return hits.sort();
}

/**
 * The files writing an auth.json that are NOT the refresher: each one writes
 * a copy into a directory it made for itself (a sandbox's agent dir, the Action's
 * run dir, another host's fresh volume), never the bot's pihome. Anything new that
 * writes an auth.json must be added here with its reason, or be the refresher.
 */
export const SANDBOX_AUTH_WRITERS: Readonly<Record<string, string>> = {
  "packages/pi-plugin/src/engine/auth.ts":
    "copyPiAuth: the refresh-blanked copy in a sandbox's own agent dir",
  "src/bench/auth.ts": "the benchmark sandbox's empty or blanked login in its own tmpfs",
  "src/bench/opencode.ts": "OpenCode's auth.json in the case's own data dir",
  "packages/pi-plugin/src/reviewhost.ts": "a review run's throwaway agent dir (the host isolation)",
  "packages/pi-plugin/src/plugin/scancases.ts":
    "a scan case's throwaway agent dir: an empty store when the host pi keeps none",
  "scripts/action.sh": "the Action's per-run login dir, from its own input",
  "scripts/worker-rehearsal/layout.sh":
    "the worker rehearsal's throwaway host dir: a fake far-future login in the pihome it lays out",
};

/** Provisioning scripts that seed a fresh companion volume on another host. They
 * are matched by shape, not named, so the list never carries a host's name. */
export const PROVISIONING_AUTH_WRITER = /^scripts\/[a-z0-9]+-(provision|setup)\.sh$/;

/** True for a writer that is a named sandbox copy or a provisioning script. */
export function isSandboxAuthWriter(path: string): boolean {
  return path in SANDBOX_AUTH_WRITERS || PROVISIONING_AUTH_WRITER.test(path);
}

/** Every .ts under `src/loginrefresh/` that the daemon's import closure reaches. */
export function daemonReachedLoginRefresh(root: string, daemonRoots: readonly string[]): string[] {
  const all = new Set(
    [...SRC_DIRS, ...EXTENSION_DIRS].flatMap((d) =>
      sources(join(root, d)).filter((f) => f.endsWith(".ts")),
    ),
  );
  const seen = new Set<string>();
  const queue = daemonRoots.map((r) => join(root, r)).filter((f) => all.has(f));
  while (queue.length > 0) {
    const f = queue.shift()!;
    if (seen.has(f)) continue;
    seen.add(f);
    for (const p of sourceSpecifiers(root, f, stripComments(readFileSync(f, "utf8"))))
      if (all.has(p) && !seen.has(p)) queue.push(p);
  }
  return [...seen]
    .map((f) => f.slice(root.length + 1))
    .filter((f) => f.startsWith("src/loginrefresh/"))
    .sort();
}
