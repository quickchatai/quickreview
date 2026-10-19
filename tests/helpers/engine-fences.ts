// The scans behind the engine fences (P2.1). Pure functions over a
// repo root, so tests/fences-engine.test.ts can run them on the real tree AND
// on a planted copy: a fence that cannot be made to fail is not a fence.
import { readFileSync, readdirSync, existsSync } from "node:fs";
import { join, relative } from "node:path";

/** Every .ts under a tree, recursively; [] when the tree does not exist. */
export function tsFilesUnder(dir: string): string[] {
  if (!existsSync(dir)) return [];
  return readdirSync(dir, { withFileTypes: true }).flatMap((e) =>
    e.isDirectory()
      ? tsFilesUnder(join(dir, e.name))
      : e.name.endsWith(".ts")
        ? [join(dir, e.name)]
        : [],
  );
}

/**
 * Comments removed before any scan, so a commented-out import or a prose
 * mention of a path is not read as live code. String literals stay: the
 * packageability fence is about literals.
 */
export function stripComments(text: string): string {
  return text
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .split("\n")
    .filter((l) => !/^\s*(\/\/|\*)/.test(l))
    .map((l) => l.replace(/(^|[^:"'`])\/\/.*$/, "$1"))
    .join("\n");
}

/** The pi SDK package, under both scopes pi has shipped it under. */
const SDK = String.raw`@(?:earendil-works|mariozechner)\/pi-coding-agent`;

/**
 * True when the text imports the pi SDK at RUNTIME: a static import or
 * re-export that is not `import type`/`export type`, a side-effect import, a
 * dynamic `import()` or a `require()`. Type-only imports are erased at build
 * and load nothing, so extensions may keep them.
 */
export function importsSdkAtRuntime(text: string): boolean {
  const code = stripComments(text);
  const statics = new RegExp(
    String.raw`(?:^|[\n;])\s*(import|export)(\s+type)?\b[^;]*?\bfrom\s*["']${SDK}(?:\/[^"']*)?["']`,
    "g",
  );
  for (const m of code.matchAll(statics)) if (!m[2]) return true;
  return new RegExp(
    String.raw`(?:^|[\n;])\s*import\s*["']${SDK}(?:\/[^"']*)?["']|\b(?:import|require)\s*\(\s*["']${SDK}(?:\/[^"']*)?["']\s*\)`,
  ).test(code);
}

/**
 * S2's SDK allowlist: the .ts files under src/ and extensions/ that import the
 * pi SDK at runtime, relative to `root`. Only src/engine/pisdk.ts and the
 * extension factory modules (extensions/) may. runLens and every other engine
 * module reach the SDK through PiHost.makeSession, never by importing it.
 */
export function runtimeSdkImporters(root: string): string[] {
  return [...tsFilesUnder(join(root, "src")), ...tsFilesUnder(join(root, "extensions"))]
    .filter((f) => importsSdkAtRuntime(readFileSync(f, "utf8")))
    .map((f) => relative(root, f))
    .sort();
}

/** Import specifiers (static, re-export, dynamic) that resolve to a .ts under `files`. */
function importsOf(f: string, text: string, files: ReadonlySet<string>): string[] {
  return [...stripComments(text).matchAll(/["'](\.[^"']+)\.js["']/g)]
    .map((m) => join(f, "..", `${m[1]!}.ts`))
    .filter((p) => files.has(p));
}

/**
 * The daemon modules whose import closure must not reach src/engine/. The
 * engine installs a process-global HTTP dispatcher (pi's configureHttpDispatcher)
 * that must never leak into the daemon's own fetches.
 */
export const DAEMON_ROOTS = [
  "src/wire.ts",
  "src/daemon.ts",
  "src/sessions.ts",
  "src/verdicts.ts",
  "src/dispatch.ts",
  "src/posting.ts",
  // The worker supervisor (P8.5) is the daemon's end of the per-round worker. It
  // spawns the worker BY PATH and imports its env allowlist's one shared name from
  // src/envstrip.ts, so the engine's dispatcher and sessions never enter the daemon.
  "src/workersupervisor.ts",
];

/**
 * Edges "daemon root -> ... -> src/engine/**", one chain per offending engine
 * file, as "a.ts > b.ts > src/engine/x.ts". Empty when the fence holds.
 */
export function daemonReachesEngine(root: string): string[] {
  const files = new Set([
    ...tsFilesUnder(join(root, "src")),
    ...tsFilesUnder(join(root, "extensions")),
  ]);
  const engineDir = join(root, "src", "engine") + "/";
  const parent = new Map<string, string | null>();
  const queue: string[] = [];
  for (const r of DAEMON_ROOTS) {
    const p = join(root, r);
    if (files.has(p)) {
      parent.set(p, null);
      queue.push(p);
    }
  }
  const hits: string[] = [];
  while (queue.length > 0) {
    const f = queue.shift()!;
    if (f.startsWith(engineDir)) {
      const chain: string[] = [];
      for (let c: string | null = f; c; c = parent.get(c) ?? null) chain.unshift(relative(root, c));
      hits.push(chain.join(" > "));
      continue; // report the way in, not the engine's own imports
    }
    for (const n of importsOf(f, readFileSync(f, "utf8"), files)) {
      if (parent.has(n)) continue;
      parent.set(n, f);
      queue.push(n);
    }
  }
  return hits.sort();
}

/**
 * The modules that host an SDK session: the builder, the runtime over it, and
 * the scan's leaf runner on it. A pi process (the companion's, the tmux bot's)
 * loads extensions/ and must never carry one of these: the SDK's process-global
 * HTTP dispatcher and its sessions belong to a disposable host (scancli's
 * detached driver, a bench case), not to a long-lived pi.
 */
export const SDK_HOST_MODULES = [
  "src/engine/pisdk.ts",
  "src/engine/sdkruntime.ts",
  "src/engine/caserunner-sdk.ts",
];

/**
 * The extensions that host SDK sessions in a pi process, and the one host
 * module they may reach (P4.5; extensions/debug-round.ts is lens.ts's tools
 * with the command that starts a debug round, P5.9). extensions/lens.ts runs the lens passes of an
 * interactive pi (a debug round, the companion) in-process, on a PiHost built
 * over that pi's own agent dir, with the CLI pi's HTTP dispatcher left alone
 * (PiHostOptions.ownsProcess false). It reaches the builder only: never the
 * runtime over it (sdkruntime.ts) nor the scan's runner (caserunner-sdk.ts),
 * which host a MAIN session. The tmux bot does not load it
 * (tests/lens-tool.test.ts).
 */
export const EXTENSION_SDK_HOST_ALLOWED: Readonly<Record<string, readonly string[]>> = {
  "extensions/lens.ts": ["src/engine/pisdk.ts"],
  // The debug round (P5.9) is lens.ts's tools plus the command that starts the
  // round, so it reaches the builder through lens.ts and nothing else.
  "extensions/debug-round.ts": ["src/engine/pisdk.ts"],
};

/**
 * Chains "extensions/x.ts > ... > host module" from any extension's import
 * closure (static, re-export and dynamic imports alike) to an SDK host module,
 * one per host module reached per extension. Empty when the fence holds. A
 * chain EXTENSION_SDK_HOST_ALLOWED names is not reported.
 */
export function extensionsReachSdkHost(root: string): string[] {
  const files = new Set([
    ...tsFilesUnder(join(root, "src")),
    ...tsFilesUnder(join(root, "extensions")),
  ]);
  const hosts = new Set(SDK_HOST_MODULES.map((m) => join(root, m)));
  const hits: string[] = [];
  for (const entry of tsFilesUnder(join(root, "extensions"))) {
    const parent = new Map<string, string | null>([[entry, null]]);
    const queue = [entry];
    while (queue.length > 0) {
      const f = queue.shift()!;
      if (hosts.has(f)) {
        const chain: string[] = [];
        for (let c: string | null = f; c; c = parent.get(c) ?? null)
          chain.unshift(relative(root, c));
        if (!EXTENSION_SDK_HOST_ALLOWED[chain[0]!]?.includes(chain[chain.length - 1]!))
          hits.push(chain.join(" > "));
        continue;
      }
      for (const n of importsOf(f, readFileSync(f, "utf8"), files)) {
        if (parent.has(n)) continue;
        parent.set(n, f);
        queue.push(n);
      }
    }
  }
  return hits.sort();
}

/**
 * Image-only paths and state-home reads, which src/engine/** must not carry:
 * the engine is what a post-v1 pi package would ship, so every
 * path reaches it through SessionSpec or config. Matched on code with
 * comments removed.
 */
export const IMAGE_ONLY_PATTERNS: ReadonlyArray<{ re: RegExp; what: string }> = [
  { re: /\/opt\/qcr\b/, what: "'/opt/qcr' (the companion image's app dir)" },
  { re: /\/opt\/quickreview\b/, what: "'/opt/quickreview' (the VM's install root)" },
  { re: /\/qcr-(?:state|config)\b/, what: "a companion mount point ('/qcr-state', '/qcr-config')" },
  { re: /\bQCR_STATE_HOME\b/, what: "QCR_STATE_HOME (read the state home through config)" },
  {
    re: /["'`][^"'`\n]*\b(?:pi-sessions|pending_wakes|pr-sessions)\b[^"'`\n]*["'`]/,
    what: "a state-home layout literal (pi-sessions, pr-sessions)",
  },
];

/** "file: what" for every image-only literal under src/engine/. */
export function engineImageOnlyPaths(root: string): string[] {
  const out: string[] = [];
  for (const f of tsFilesUnder(join(root, "src", "engine"))) {
    const code = stripComments(readFileSync(f, "utf8"));
    for (const { re, what } of IMAGE_ONLY_PATTERNS)
      if (re.test(code)) out.push(`${relative(root, f)}: ${what}`);
  }
  return out.sort();
}
