// `qcr plugin`: QuickReview installed into the coding-agent CLIs on this
// machine (the hosts), from the App's one skill source (plugins/qcr/).
//
//   qcr plugin install --to <host|all> [--project] [--json]
//   qcr plugin update [--json]
//   qcr plugin uninstall --from <host|all> [--json]
//
// Install renders the host's plugin folder (plugins/qcr/render.mjs, loaded
// from this package's own plugins/) at the running release into
// `<data home>/plugins/<host>/<version>/` (src/homes.ts `dataHome`), never
// into the package: a host loads the folder in place long after this run,
// and an `npx` cache, the package an update replaces, are both disposable.
// It then points the host there through the host's own non-interactive verb,
// at user scope, or at the host's project scope with `--project`. Update
// re-renders and re-points every host it finds QuickReview installed in;
// uninstall removes it through the host's own verb. Both, and install, then
// delete the renders no host references any more.
//
// It never prompts (every host child gets /dev/null for stdin), never logs
// in, and writes nothing beyond the render and what the host's own verb
// writes. Each host's outcome is one row: installed, updated, removed,
// skipped (not on PATH, not installed) or failed (with the host's own
// message); the summary adds the invoke line and the reload step, and
// `--json` prints the same rows. Exit 0 when no host failed, 1 when one
// did, 2 for usage.
//
// Claude Code (probed with Claude Code 2.1.303 in a throwaway HOME, stdin
// /dev/null, no login):
//   - A local marketplace is a directory source: `claude plugin marketplace
//     add <dir>` declares it in user settings, and the plugin loads in place
//     from `<dir>/qcr` ("readFromFolder"), so the render must outlive the run.
//   - `claude plugin install qcr --marketplace <dir2>` fails with
//     `name_taken` once the marketplace's name points at another dir: a
//     release's dir changes, so that one-step form cannot re-point it.
//     `claude plugin marketplace add <dir2>` can: it re-points the same name
//     ("now points at dir:…"), and re-adding the same dir is an ok no-op.
//   - `claude plugin install qcr@quickreview-local -s <scope>` installs; when
//     the plugin is already there it answers ok with the installed version
//     and changes nothing, so a re-point is followed by `claude plugin update
//     qcr@quickreview-local -s <scope>` ("updated from A to B" or
//     "up_to_date").
//   - `claude plugin list --json` lists every scope's install, a project one
//     with its `projectPath`; a project or local scope's update and
//     uninstall run only from inside that project (`not_installed_at_scope`
//     elsewhere), so they run with that path as their cwd.
//   - `claude plugin uninstall … -s <scope>` leaves the marketplace declared:
//     `claude plugin marketplace remove quickreview-local` drops it.
//   - Every verb takes `--json` and prints one result line (`outcome`,
//     `message`, a `failureCode` on failure) and exits 0 or 1.
import { spawnSync } from "node:child_process";
import {
  accessSync,
  constants,
  existsSync,
  readdirSync,
  realpathSync,
  renameSync,
  rmSync,
  statSync,
} from "node:fs";
import { delimiter, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import type * as Renderer from "../plugins/qcr/render.mjs";
import { dataHome } from "./homes.js";

type Render = typeof Renderer;

export const PLUGIN_USAGE = [
  "usage: qcr plugin install --to <host|all> [--project] [--json]",
  "       qcr plugin update [--json]",
  "       qcr plugin uninstall --from <host|all> [--json]",
].join("\n");

/** What happened to QuickReview in one host. */
export type PluginOutcome = "installed" | "updated" | "removed" | "skipped" | "failed";

/** One host's row of the summary, and of `--json`. */
export interface PluginRow {
  host: string;
  outcome: PluginOutcome;
  /** The scopes the verb acted at (`user`, `project`, `local`). */
  scopes: string[];
  /** The release the host now loads, when it loads one. */
  version: string | null;
  /** The rendered folder the host is pointed at, when it is. */
  dir: string | null;
  /** What the host said, or why the row was skipped or failed. */
  detail: string;
  /** What the person types in the host, one per command. */
  invoke: string[];
  /** How a running session of the host picks the change up. */
  reload: string | null;
  /** The older renders this run deleted. */
  removed: string[];
}

export interface PluginDeps {
  env: Readonly<Record<string, string | undefined>>;
  /** The directory a project scope means. */
  cwd: string;
  /** The App package's root: the skill source is its plugins/qcr/. */
  pkgRoot: string;
  /** Run a host's CLI with no terminal: stdin is /dev/null, output captured. */
  run: (
    cmd: string,
    args: readonly string[],
    opts: { cwd: string },
  ) => { status: number | null; stdout: string; stderr: string; error?: Error };
  out: (line: string) => void;
  err: (line: string) => void;
}

/** A host child that has not answered in this long is a failure. */
const HOST_TIMEOUT_MS = 120_000;

export function pluginDeps(pkgRoot: string): PluginDeps {
  return {
    env: process.env,
    cwd: process.cwd(),
    pkgRoot,
    run: (cmd, args, opts) => {
      const r = spawnSync(cmd, [...args], {
        cwd: opts.cwd,
        env: process.env,
        encoding: "utf8",
        stdio: ["ignore", "pipe", "pipe"],
        timeout: HOST_TIMEOUT_MS,
      });
      return {
        status: r.status,
        stdout: r.stdout ?? "",
        stderr: r.stderr ?? "",
        ...(r.error ? { error: r.error } : {}),
      };
    },
    out: (l) => console.log(l),
    err: (l) => console.error(l),
  };
}

// ---- the hosts ------------------------------------------------------------------

/** What one run knows: the renderer, the release, where renders live. */
interface Ctx {
  deps: PluginDeps;
  render: Render;
  /** The skill source, read once. */
  source: Renderer.Source;
  version: string;
  /** `<data home>/plugins`. */
  root: string;
}

/** One host the installer can point at a render. */
interface HostInstaller {
  /** The render target (plugins/qcr/render.mjs HOSTS). */
  host: string;
  /** The host's name in the summary. */
  label: string;
  /** Its executable, found on PATH. */
  exe: string;
  reload: string;
  install(ctx: Ctx, exe: string, scope: "user" | "project"): PluginRow;
  update(ctx: Ctx, exe: string): PluginRow;
  uninstall(ctx: Ctx, exe: string): PluginRow;
}

/** The executable `cmd` on `path`, or null. */
function which(cmd: string, path: string | undefined): string | null {
  for (const dir of (path ?? "").split(delimiter)) {
    if (dir === "") continue;
    const p = join(dir, cmd);
    try {
      accessSync(p, constants.X_OK);
      if (statSync(p).isFile()) return p;
    } catch {
      // not here
    }
  }
  return null;
}

const real = (p: string): string => {
  try {
    return realpathSync(p);
  } catch {
    return resolve(p);
  }
};

/** A host child's answer: ok, the parsed last JSON line, and its message. */
interface HostAnswer {
  ok: boolean;
  json: Record<string, unknown> | null;
  message: string;
}

function ask(ctx: Ctx, exe: string, args: readonly string[], cwd = ctx.deps.cwd): HostAnswer {
  const r = ctx.deps.run(exe, args, { cwd });
  const line = r.stdout
    .trim()
    .split("\n")
    .reverse()
    .find((l) => l.trim().startsWith("{"));
  let json: Record<string, unknown> | null = null;
  try {
    json = line === undefined ? null : (JSON.parse(line) as Record<string, unknown>);
  } catch {
    json = null;
  }
  const message = json?.["message"];
  const said = typeof message === "string" ? message : (r.stderr.trim().split("\n")[0] ?? "");
  if (r.error) return { ok: false, json, message: r.error.message };
  const ok = r.status === 0 && json?.["outcome"] !== "failed";
  return {
    ok,
    json,
    message: said !== "" ? said : ok ? "" : `${exe} exited ${r.status ?? "on a signal"}`,
  };
}

/** A JSON array a host listed, or null when it could not be read. */
function askList(ctx: Ctx, exe: string, args: readonly string[]): unknown[] | null {
  const r = ctx.deps.run(exe, args, { cwd: ctx.deps.cwd });
  if (r.error || r.status !== 0) return null;
  try {
    const v = JSON.parse(r.stdout) as unknown;
    return Array.isArray(v) ? v : null;
  } catch {
    return null;
  }
}

/** `host`'s render at this release, written when it is missing or differs:
 * the folder's path. A folder that already equals the render is kept, so a
 * host loading it in place never sees it vanish. */
function renderFor(ctx: Ctx, host: string): string {
  const files = ctx.render.render(ctx.source, host, {
    version: ctx.version,
    contract: ctx.render.TEMPLATE_CONTRACT,
  });
  const dir = join(ctx.root, host, ctx.version);
  if (existsSync(dir) && ctx.render.renderedDiff(files, dir).length === 0) return dir;
  const tmp = join(ctx.root, host, `.${ctx.version}.tmp-${process.pid}`);
  rmSync(tmp, { recursive: true, force: true });
  ctx.render.writeRendered(files, tmp);
  rmSync(dir, { recursive: true, force: true });
  renameSync(tmp, dir);
  return dir;
}

/** Delete `host`'s renders other than `keep`, the one the host references
 * (null: none); nothing when the reference is unknown. After a verb pointed
 * the host at a render, that render is the reference: a host is never asked
 * again, so one that cannot list what it was just given keeps it. The
 * deleted paths. */
function tidy(ctx: Ctx, host: string, keep: string | null | undefined): string[] {
  if (keep === undefined) return [];
  const base = join(ctx.root, host);
  if (!existsSync(base)) return [];
  const removed: string[] = [];
  for (const name of readdirSync(base)) {
    const p = join(base, name);
    if (keep !== null && real(p) === real(keep)) continue;
    rmSync(p, { recursive: true, force: true });
    removed.push(p);
  }
  return removed;
}

/** What the person types in `host`, for each command the source holds. */
const invokeOf = (ctx: Ctx, host: string): string[] =>
  ctx.render.COMMANDS.filter((c) => ctx.source.commands[c] !== undefined).map((c) =>
    ctx.render.invokeSpelling(host, c),
  );

const row = (
  host: string,
  outcome: PluginOutcome,
  detail: string,
  more: Partial<PluginRow> = {},
): PluginRow => ({
  host,
  outcome,
  scopes: [],
  version: null,
  dir: null,
  detail,
  invoke: [],
  reload: null,
  removed: [],
  ...more,
});

/** Claude Code: a local marketplace pointed at the render, the plugin
 * installed from it (the module header has what the probe showed). */
function claudeInstaller(): HostInstaller {
  const host = "claude";
  const reload = "restart Claude Code, or run /reload-plugins in a session already open";
  const id = (r: Render): string => `${r.PLUGIN_NAME}@${r.MARKETPLACE_NAME}`;

  interface Entry {
    scope: string;
    version: string | null;
    projectPath: string | null;
  }
  /** QuickReview's installs, every scope; null when the list failed. A
   * project install whose project is gone is not one: nothing loads it, and
   * no verb can reach it from outside that project. */
  const installs = (ctx: Ctx, exe: string): Entry[] | null => {
    const list = askList(ctx, exe, ["plugin", "list", "--json"]);
    if (list === null) return null;
    return list
      .filter((e): e is Record<string, unknown> => typeof e === "object" && e !== null)
      .filter((e) => e["id"] === id(ctx.render))
      .map((e) => ({
        scope: typeof e["scope"] === "string" ? e["scope"] : "user",
        version: typeof e["version"] === "string" ? e["version"] : null,
        projectPath: typeof e["projectPath"] === "string" ? e["projectPath"] : null,
      }))
      .filter((e) => e.scope === "user" || e.projectPath === null || existsSync(e.projectPath));
  };
  /** The folder the marketplace points at: null when it is not declared,
   * undefined when the list failed. */
  const referenced = (ctx: Ctx, exe: string): string | null | undefined => {
    const list = askList(ctx, exe, ["plugin", "marketplace", "list", "--json"]);
    if (list === null) return undefined;
    const m = list.find(
      (e): e is Record<string, unknown> =>
        typeof e === "object" &&
        e !== null &&
        (e as Record<string, unknown>)["name"] === ctx.render.MARKETPLACE_NAME,
    );
    return m === undefined ? null : typeof m["path"] === "string" ? m["path"] : undefined;
  };
  const cwdOf = (ctx: Ctx, e: Entry): string =>
    e.scope === "user" || e.projectPath === null ? ctx.deps.cwd : e.projectPath;
  const point = (ctx: Ctx, exe: string, dir: string): HostAnswer =>
    ask(ctx, exe, ["plugin", "marketplace", "add", dir, "--json"]);

  return {
    host,
    label: "Claude Code",
    exe: "claude",
    reload,
    install(ctx, exe, scope) {
      const before = installs(ctx, exe);
      if (before === null) return row(host, "failed", "`claude plugin list --json` did not answer");
      const here = real(ctx.deps.cwd);
      const prior = before.find(
        (e) =>
          e.scope === scope &&
          (scope === "user" || (e.projectPath !== null && real(e.projectPath) === here)),
      );
      const dir = renderFor(ctx, host);
      const pointed = point(ctx, exe, dir);
      if (!pointed.ok) return row(host, "failed", pointed.message, { dir });
      const inst = ask(ctx, exe, ["plugin", "install", id(ctx.render), "-s", scope, "--json"]);
      if (!inst.ok) return row(host, "failed", inst.message, { dir, scopes: [scope] });
      let detail = inst.message;
      if (prior !== undefined && prior.version !== ctx.version) {
        const up = ask(ctx, exe, ["plugin", "update", id(ctx.render), "-s", scope, "--json"]);
        if (!up.ok) return row(host, "failed", up.message, { dir, scopes: [scope] });
        detail = up.message;
      }
      const updated = prior !== undefined && prior.version !== ctx.version;
      return row(host, updated ? "updated" : "installed", detail, {
        scopes: [scope],
        version: ctx.version,
        dir,
        invoke: invokeOf(ctx, host),
        reload,
        removed: tidy(ctx, host, dir),
      });
    },
    update(ctx, exe) {
      const found = installs(ctx, exe);
      if (found === null) return row(host, "failed", "`claude plugin list --json` did not answer");
      if (found.length === 0)
        return row(host, "skipped", "QuickReview is not installed here", {
          removed: tidy(ctx, host, referenced(ctx, exe)),
        });
      const dir = renderFor(ctx, host);
      const pointed = point(ctx, exe, dir);
      if (!pointed.ok) return row(host, "failed", pointed.message, { dir });
      const said: string[] = [];
      for (const e of found) {
        const up = ask(
          ctx,
          exe,
          ["plugin", "update", id(ctx.render), "-s", e.scope, "--json"],
          cwdOf(ctx, e),
        );
        if (!up.ok) return row(host, "failed", up.message, { dir, scopes: [e.scope] });
        said.push(up.message);
      }
      return row(host, "updated", said.join(" "), {
        scopes: found.map((e) => e.scope),
        version: ctx.version,
        dir,
        invoke: invokeOf(ctx, host),
        reload,
        removed: tidy(ctx, host, dir),
      });
    },
    uninstall(ctx, exe) {
      const found = installs(ctx, exe);
      if (found === null) return row(host, "failed", "`claude plugin list --json` did not answer");
      const said: string[] = [];
      for (const e of found) {
        const un = ask(
          ctx,
          exe,
          ["plugin", "uninstall", id(ctx.render), "-s", e.scope, "--json"],
          cwdOf(ctx, e),
        );
        if (!un.ok) return row(host, "failed", un.message, { scopes: [e.scope] });
        said.push(un.message);
      }
      const declared = referenced(ctx, exe);
      if (declared === undefined)
        return row(host, "failed", "`claude plugin marketplace list --json` did not answer", {
          scopes: found.map((e) => e.scope),
        });
      if (declared !== null) {
        const gone = ask(ctx, exe, [
          "plugin",
          "marketplace",
          "remove",
          ctx.render.MARKETPLACE_NAME,
          "--json",
        ]);
        if (!gone.ok)
          return row(host, "failed", gone.message, { scopes: found.map((e) => e.scope) });
        said.push(gone.message);
      }
      const removed = tidy(ctx, host, null);
      rmSync(join(ctx.root, host), { recursive: true, force: true });
      if (found.length === 0 && declared === null && removed.length === 0)
        return row(host, "skipped", "QuickReview is not installed here");
      return row(host, "removed", said.join(" "), {
        scopes: found.map((e) => e.scope),
        reload,
        removed,
      });
    },
  };
}

/** Every host the installer can install into, in `--to all` order. */
const INSTALLERS: readonly HostInstaller[] = [claudeInstaller()];

/** The hosts `qcr plugin` installs into, by name. */
export const PLUGIN_HOSTS: readonly string[] = INSTALLERS.map((i) => i.host);

// ---- the verb -------------------------------------------------------------------

interface Parsed {
  verb: "install" | "update" | "uninstall";
  hosts: readonly HostInstaller[];
  /** Were the hosts named one by one (a missing one fails) or all? */
  named: boolean;
  project: boolean;
}

function parse(args: readonly string[]): Parsed | string {
  const [verb, ...rest] = args;
  if (verb !== "install" && verb !== "update" && verb !== "uninstall")
    return verb === undefined ? "a verb is needed" : `unknown verb ${JSON.stringify(verb)}`;
  const flag = verb === "install" ? "--to" : verb === "uninstall" ? "--from" : null;
  let target: string | undefined;
  let project = false;
  for (let i = 0; i < rest.length; i++) {
    const a = rest[i]!;
    if (flag !== null && (a === flag || a.startsWith(`${flag}=`))) {
      if (target !== undefined) return `${flag} is given twice`;
      target = a === flag ? rest[++i] : a.slice(flag.length + 1);
      if (target === undefined || target === "") return `${flag} needs a host`;
    } else if (a === "--project" && verb === "install") project = true;
    else return `${verb} does not take ${JSON.stringify(a)}`;
  }
  if (flag !== null && target === undefined)
    return `${verb} needs ${flag} <${[...PLUGIN_HOSTS, "all"].join("|")}>`;
  if (target === undefined || target === "all")
    return { verb, hosts: INSTALLERS, named: false, project };
  const one = INSTALLERS.find((i) => i.host === target);
  if (one === undefined)
    return `${JSON.stringify(target)} is not a host qcr plugin installs into (${[...PLUGIN_HOSTS, "all"].join(", ")})`;
  return { verb, hosts: [one], named: true, project };
}

function summary(rows: readonly PluginRow[], label: (h: string) => string): string[] {
  const out: string[] = [];
  for (const r of rows) {
    const at = r.scopes.length > 0 ? ` at ${r.scopes.join(" and ")} scope` : "";
    const release = r.version !== null ? `, release ${r.version}` : "";
    const head = `${label(r.host)}: ${r.outcome}${r.outcome === "installed" || r.outcome === "updated" || r.outcome === "removed" ? at + release : ""}`;
    out.push(r.outcome === "skipped" || r.outcome === "failed" ? `${head}: ${r.detail}` : head);
    if (r.invoke.length > 0) {
      const names = r.invoke;
      out.push(
        `  Type ${names.length > 1 ? `${names.slice(0, -1).join(", ")} or ${names[names.length - 1]}` : names[0]}.`,
      );
    }
    if (r.reload !== null) out.push(`  To pick it up: ${r.reload}.`);
  }
  return out;
}

/** `qcr plugin …`: the exit code (0 no host failed, 1 one did, 2 usage). */
export async function cmdPlugin(
  args: readonly string[],
  json: boolean,
  deps: PluginDeps,
): Promise<number> {
  if (args.length === 1 && (args[0] === "--help" || args[0] === "-h" || args[0] === "help")) {
    deps.out(PLUGIN_USAGE);
    deps.out(`hosts: ${PLUGIN_HOSTS.join(", ")}`);
    return 0;
  }
  const p = parse(args);
  if (typeof p === "string") {
    if (json) deps.out(JSON.stringify({ error: `qcr plugin: ${p}` }));
    else deps.err(`qcr plugin: ${p}\n${PLUGIN_USAGE}`);
    return 2;
  }
  const render = (await import(
    pathToFileURL(join(deps.pkgRoot, "plugins", "qcr", "render.mjs")).href
  )) as Render;
  const ctx: Ctx = {
    deps,
    render,
    source: render.loadSource(),
    version: render.packageVersion(),
    root: join(dataHome(deps.env), "plugins"),
  };
  const rows: PluginRow[] = [];
  for (const h of p.hosts) {
    const exe = which(h.exe, deps.env["PATH"]);
    if (exe === null) {
      rows.push(row(h.host, "skipped", `${h.exe} is not on PATH`));
      continue;
    }
    try {
      rows.push(
        p.verb === "install"
          ? h.install(ctx, exe, p.project ? "project" : "user")
          : p.verb === "update"
            ? h.update(ctx, exe)
            : h.uninstall(ctx, exe),
      );
    } catch (err) {
      rows.push(row(h.host, "failed", err instanceof Error ? err.message : String(err)));
    }
  }
  const failed = rows.some((r) => r.outcome === "failed");
  if (json) {
    deps.out(JSON.stringify({ verb: p.verb, version: ctx.version, ok: !failed, hosts: rows }));
  } else {
    const label = (host: string): string => p.hosts.find((h) => h.host === host)?.label ?? host;
    if (
      !p.named &&
      rows.every((r) => r.outcome === "skipped" && r.detail.endsWith("is not on PATH"))
    )
      deps.out(
        `qcr plugin ${p.verb}: no coding-agent CLI found on PATH (looked for ${p.hosts.map((h) => h.exe).join(", ")}).`,
      );
    else for (const l of summary(rows, label)) deps.out(l);
  }
  return failed ? 1 : 0;
}
