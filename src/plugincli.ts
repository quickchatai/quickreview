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
// at user scope, or for this repository only with `--project` (Claude
// Code's local scope, the one host that has one the installer can write); a
// host with no such scope is skipped with the reason, never given a user
// install instead. Update
// re-renders and re-points every host it finds QuickReview installed in;
// uninstall removes it through the host's own verb. Both, and install, then
// delete the renders no host references any more. A re-point that removes
// the working install first (Codex and Copilot drop the marketplace, Gemini
// and Antigravity uninstall) and then fails puts the previous install back
// from its render, which nothing has deleted yet; when that cannot be done,
// the failed row says the host is left without QuickReview.
//
// Cursor and opencode have no install verb, so their render is copied where
// the host loads it, and a record of every file and folder the copy wrote
// (`<data home>/plugins/<host>.copy.json`) is what update rewrites and
// uninstall deletes: a path the record does not name is never written over
// or removed, and an install that would land on one fails instead.
//
// A host is found by its executable on PATH; Cursor also by its config
// directory, `~/.cursor`, since an editor install puts no CLI on PATH. A
// copy host whose record is there is found by update and uninstall even once
// the host itself is gone. `--to all` with no host found is an exit 0 that
// says so.
//
// It never prompts (every host child gets /dev/null for stdin), never logs
// in, and writes nothing beyond the render, a copy host's files and record,
// and what the host's own verb writes. Each host's outcome is one row: installed, updated, removed,
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
//   - The marketplace is declared in the installing person's user settings
//     and points at their own data home, so a `-s project` install writes an
//     `enabledPlugins` entry into the checked-in `.claude/settings.json` that
//     no other clone can load (probed with 2.1.316: a second HOME given that
//     file lists no plugin and no marketplace). `--project` is therefore
//     Claude Code's `-s local`: `.claude/settings.local.json`, which git
//     ignores, for this person in this repository only.
//   - The Docker-based plugin of releases up to 1.3.2 is `qcr@quickreview`
//     (marketplace `quickreview`). It is a separate plugin named `qcr`, so
//     both answer `/qcr:review`; install and update say how to remove it.
//   - Every verb takes `--json` and prints one result line (`outcome`,
//     `message`, a `failureCode` on failure) and exits 0 or 1.
//
// Codex (probed with codex-cli 0.162.1, CODEX_HOME in a throwaway HOME):
//   - `codex plugin marketplace add <dir> --json` reads the render's
//     `.claude-plugin/marketplace.json`; re-adding the same dir is an ok
//     no-op (`alreadyAdded`), but a dir other than the one the name points at
//     fails ("already added from a different source; remove it before adding
//     this source"), so a re-point is `marketplace remove <name>`, then add.
//   - `codex plugin add qcr@<mkt> --json` copies the plugin into its cache
//     and enables it in config.toml; run again it installs the folder's
//     release, so it is install and update both.
//   - `codex plugin list --json` is `{installed: [{pluginId, version}]}`;
//     `codex plugin marketplace list --json` is `{marketplaces: [{name,
//     root}]}`. A plugin whose marketplace is gone is not listed; its
//     enablement stays in config.toml, so adding the marketplace back lists
//     it again, enabled.
//   - `codex plugin remove qcr@<mkt> --json`, then `marketplace remove`.
//   - Plugins are enabled in the user's config only: no project scope.
//   - Failures are one `Error: …` line on stderr, exit 1.
//
// Copilot CLI (probed with 1.0.105, COPILOT_HOME in a throwaway HOME):
//   - `copilot plugin marketplace add <dir>` reads the render's
//     `.github/plugin/marketplace.json`; any add of a registered name fails
//     ("already registered"), even the same dir, so the installer adds only
//     when the name is missing and re-points with `marketplace remove`
//     first, which keeps the plugin's enablement.
//   - `copilot plugin install qcr@<mkt>` (the form Copilot keeps; a direct
//     install is deprecated) enables it; a local marketplace loads live from
//     the render, never copied, so the render must outlive the run, and
//     `plugin update` has nothing to do for it. Install again is ok.
//   - `copilot plugin uninstall qcr@<mkt>` disables it; `marketplace remove`
//     drops the marketplace.
//   - `plugin list --json` is `[{name, marketplace, version, enabled}]`;
//     `plugin marketplace list --json` is `[{name, source: "Local: <dir>"}]`.
//   - Its project scope is declarative (the repo's
//     `.github/copilot/settings.json`), with no verb or scope flag.
//   - Success is a line of text on stdout, failure one line on stderr.
//
// Gemini CLI (probed with 0.61.0 in a throwaway HOME):
//   - `gemini extensions install <dir> --consent` copies the folder into
//     its extensions home; with stdin closed it still stops at a
//     folder-trust prompt unless GEMINI_CLI_TRUST_WORKSPACE=true, which the
//     installer sets for that one call only.
//   - Installing an installed extension fails ("already installed. Please
//     uninstall it first"), from any dir, and `extensions update` re-reads
//     only the dir it was installed from, so a re-point is `extensions
//     uninstall qcr`, then install.
//   - `gemini extensions list -o json` is `[{name, version,
//     installMetadata: {source}}]` on stdout, but an empty list is `[]` on
//     stderr.
//   - Install has no scope: extensions are the user's.
//   - Every message, success or failure, is on stderr.
//
// Antigravity (`agy`, not probed: no agy was at hand, so this follows its
// plugin docs for CLI 1.4.x): `agy plugin install <dir>`, `agy
// plugin list --json` and `agy plugin uninstall <name>`; no update verb and
// no scope flag is documented, so a re-point is uninstall, then install,
// and a list entry is read by its `name` alone.
//
// Cursor (from its plugin docs; its CLI offers only marketplace verbs, and
// install is interactive): a local plugin is a folder in
// `~/.cursor/plugins/local/<name>`, loaded after a window reload or in a new
// agent session, which re-indexes the folder; a marketplace plugin of the
// same name wins over it. Local plugins are the user's: no project scope.
//
// opencode (probed with opencode 2.0.18 in a throwaway HOME): no verb
// installs a skill; skills are found in `$XDG_CONFIG_HOME/opencode/skills/
// <name>/SKILL.md` (`opencode debug paths` names that config dir, default
// `~/.config/opencode`), each also a `/<name>` command, read at startup.
import { spawnSync } from "node:child_process";
import {
  accessSync,
  constants,
  copyFileSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  realpathSync,
  renameSync,
  rmdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { delimiter, dirname, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import type * as Renderer from "../plugins/qcr/render.mjs";
import { dataHome, homeOf, xdgBase } from "./homes.js";

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
  /** The folder the host loads QuickReview from, when it loads it: the
   * render it is pointed at, or where a copy host's files were copied. */
  dir: string | null;
  /** What the host said, or why the row was skipped or failed. */
  detail: string;
  /** What the person types in the host, one per command. */
  invoke: string[];
  /** How a running session of the host picks the change up. */
  reload: string | null;
  /** The older renders this run deleted. */
  removed: string[];
  /** What the person should know beyond the outcome, one sentence each. */
  notes: string[];
}

export interface PluginDeps {
  env: Readonly<Record<string, string | undefined>>;
  /** The directory a project scope means. */
  cwd: string;
  /** The App package's root: the skill source is its plugins/qcr/. */
  pkgRoot: string;
  /** Run a host's CLI with no terminal: stdin is /dev/null, output
   * captured; `env` is added to this process's environment for that one
   * call. */
  run: (
    cmd: string,
    args: readonly string[],
    opts: { cwd: string; env?: Readonly<Record<string, string>> },
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
        env: opts.env === undefined ? process.env : { ...process.env, ...opts.env },
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
  /** What finding it looks for: its executables, and any folder. */
  lookFor(ctx: Ctx): string[];
  /** The host here: the executable its verbs run (a copy host: what found
   * it); null when it is not here. */
  locate(ctx: Ctx): string | null;
  /** Why it was not found. */
  notFound(ctx: Ctx): string;
  /** A copy host's record of an install here, which update and uninstall
   * reach even when the host is no longer found; null when there is none. */
  recorded?(ctx: Ctx): string | null;
  reload: string;
  /** Why `--project` skips this host, or null when it has a project scope. */
  noProject: string | null;
  install(ctx: Ctx, exe: string, scope: "user" | "project"): PluginRow;
  update(ctx: Ctx, exe: string): PluginRow;
  uninstall(ctx: Ctx, exe: string): PluginRow;
}

/** The executable `cmd` on `path`, or null: absolute, a relative PATH entry
 * resolved against `cwd`, so a host child run from another directory (a
 * Claude Code project scope's) runs this same executable. */
function which(cmd: string, path: string | undefined, cwd: string): string | null {
  for (const dir of (path ?? "").split(delimiter)) {
    if (dir === "") continue;
    const p = resolve(cwd, dir, cmd);
    try {
      accessSync(p, constants.X_OK);
      if (statSync(p).isFile()) return p;
    } catch {
      // not here
    }
  }
  return null;
}

/** A host found by its executable `exe` on PATH. */
const onPath = (exe: string): Pick<HostInstaller, "lookFor" | "locate" | "notFound"> => ({
  lookFor: () => [exe],
  locate: (ctx) => which(exe, ctx.deps.env["PATH"], ctx.deps.cwd),
  notFound: () => `${exe} is not on PATH`,
});

const real = (p: string): string => {
  try {
    return realpathSync(p);
  } catch {
    return resolve(p);
  }
};

/** A host child's answer: ok, its JSON object (the whole stdout, or its
 * last JSON line), and its message. */
interface HostAnswer {
  ok: boolean;
  json: Record<string, unknown> | null;
  message: string;
}

const isRecord = (v: unknown): v is Record<string, unknown> =>
  typeof v === "object" && v !== null && !Array.isArray(v);

/** The JSON a host printed: its whole stdout, else its last line that
 * starts an object; null when there is none. */
function parseJson(stdout: string): unknown {
  const t = stdout.trim();
  if (t === "") return null;
  try {
    return JSON.parse(t) as unknown;
  } catch {
    const line = t
      .split("\n")
      .reverse()
      .find((l) => l.trim().startsWith("{"));
    try {
      return line === undefined ? null : (JSON.parse(line) as unknown);
    } catch {
      return null;
    }
  }
}

const lastLine = (s: string): string =>
  s
    .split("\n")
    .map((l) => l.trim())
    .filter((l) => l !== "")
    .pop() ?? "";

/** Run one host verb. Its message is the JSON's `message`; else, on
 * success, the last line it printed, and on failure its last line on
 * stderr (hosts print their prompts and notices before the outcome). */
function ask(
  ctx: Ctx,
  exe: string,
  args: readonly string[],
  opts: { cwd?: string; env?: Readonly<Record<string, string>> } = {},
): HostAnswer {
  const r = ctx.deps.run(exe, args, {
    cwd: opts.cwd ?? ctx.deps.cwd,
    ...(opts.env === undefined ? {} : { env: opts.env }),
  });
  const parsed = parseJson(r.stdout);
  const json = isRecord(parsed) ? parsed : null;
  if (r.error) return { ok: false, json, message: r.error.message };
  const ok = r.status === 0 && json?.["outcome"] !== "failed";
  const message = json?.["message"];
  const text = parsed === null ? lastLine(r.stdout) : "";
  const said =
    typeof message === "string"
      ? message
      : ok
        ? text || lastLine(r.stderr)
        : lastLine(r.stderr) || text;
  return {
    ok,
    json,
    message: said !== "" ? said : ok ? "" : `${exe} exited ${r.status ?? "on a signal"}`,
  };
}

/** The JSON a host listed, or null when it could not be read: its stdout,
 * or its stderr when stdout is empty (Gemini prints an empty list there). */
function askJson(ctx: Ctx, exe: string, args: readonly string[]): unknown {
  const r = ctx.deps.run(exe, args, { cwd: ctx.deps.cwd });
  if (r.error || r.status !== 0) return null;
  try {
    return JSON.parse(r.stdout.trim() !== "" ? r.stdout : r.stderr) as unknown;
  } catch {
    return null;
  }
}

/** A JSON array a host listed, or null when it could not be read. */
function askList(ctx: Ctx, exe: string, args: readonly string[]): unknown[] | null {
  const v = askJson(ctx, exe, args);
  return Array.isArray(v) ? v : null;
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
  notes: [],
  ...more,
});

/** The Docker-based Claude Code plugin of releases up to 1.3.2, and its
 * marketplace: never touched, only named when it is still installed. */
const LEGACY_CLAUDE_ID = "qcr@quickreview";
const LEGACY_CLAUDE_MARKETPLACE = "quickreview";

/** What a `--project` install into Claude Code tells the person. */
const LOCAL_NOTE =
  "Installed for you in this repository only (.claude/settings.local.json, which git ignores): the plugin loads from this machine's own render, so a teammate runs the same install in their clone.";

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
  /** The installs of plugin `pluginId`, every scope, in `list` (`claude
   * plugin list --json`). A project install whose project is gone is not
   * one: nothing loads it, and no verb can reach it from outside that
   * project. */
  const entriesOf = (list: readonly unknown[], pluginId: string): Entry[] =>
    list
      .filter((e): e is Record<string, unknown> => typeof e === "object" && e !== null)
      .filter((e) => e["id"] === pluginId)
      .map((e) => ({
        scope: typeof e["scope"] === "string" ? e["scope"] : "user",
        version: typeof e["version"] === "string" ? e["version"] : null,
        projectPath: typeof e["projectPath"] === "string" ? e["projectPath"] : null,
      }))
      .filter((e) => e.scope === "user" || e.projectPath === null || existsSync(e.projectPath));
  /** QuickReview's installs and the Docker-era plugin's; null when the list
   * failed. */
  const installs = (ctx: Ctx, exe: string): { mine: Entry[]; legacy: Entry[] } | null => {
    const list = askList(ctx, exe, ["plugin", "list", "--json"]);
    if (list === null) return null;
    return { mine: entriesOf(list, id(ctx.render)), legacy: entriesOf(list, LEGACY_CLAUDE_ID) };
  };
  /** How to remove the Docker-era plugin, when it is still installed. */
  const legacyNotes = (legacy: readonly Entry[]): string[] => {
    if (legacy.length === 0) return [];
    const un = legacy.map((e) =>
      e.scope === "user"
        ? `\`claude plugin uninstall ${LEGACY_CLAUDE_ID}\``
        : `\`claude plugin uninstall ${LEGACY_CLAUDE_ID} -s ${e.scope}\` (from ${e.projectPath ?? "its project"})`,
    );
    return [
      `The Docker-based plugin of releases up to 1.3.2 (${LEGACY_CLAUDE_ID}) is still installed and answers the same commands: remove it with ${un.join(", ")}, then \`claude plugin marketplace remove ${LEGACY_CLAUDE_MARKETPLACE}\`.`,
    ];
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
    ...onPath("claude"),
    reload,
    noProject: null,
    install(ctx, exe, asked) {
      const listed = installs(ctx, exe);
      if (listed === null) return row(host, "failed", "`claude plugin list --json` did not answer");
      const before = listed.mine;
      const notes = legacyNotes(listed.legacy);
      // `--project` is this person in this repository: see the module header
      const scope = asked === "project" ? "local" : "user";
      if (scope === "local") notes.unshift(LOCAL_NOTE);
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
        notes,
      });
    },
    update(ctx, exe) {
      const listed = installs(ctx, exe);
      if (listed === null) return row(host, "failed", "`claude plugin list --json` did not answer");
      const found = listed.mine;
      const notes = legacyNotes(listed.legacy);
      if (found.length === 0)
        return row(host, "skipped", "QuickReview is not installed here", {
          removed: tidy(ctx, host, referenced(ctx, exe)),
          notes,
        });
      const dir = renderFor(ctx, host);
      const pointed = point(ctx, exe, dir);
      if (!pointed.ok) return row(host, "failed", pointed.message, { dir });
      const said: string[] = [];
      for (const e of found) {
        const up = ask(ctx, exe, ["plugin", "update", id(ctx.render), "-s", e.scope, "--json"], {
          cwd: cwdOf(ctx, e),
        });
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
        notes,
      });
    },
    uninstall(ctx, exe) {
      const listed = installs(ctx, exe);
      if (listed === null) return row(host, "failed", "`claude plugin list --json` did not answer");
      const found = listed.mine;
      const said: string[] = [];
      for (const e of found) {
        const un = ask(ctx, exe, ["plugin", "uninstall", id(ctx.render), "-s", e.scope, "--json"], {
          cwd: cwdOf(ctx, e),
        });
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

/** A row for a host now loading this release from `dir`, at user scope;
 * the renders it no longer references are deleted. */
function landed(
  ctx: Ctx,
  h: { host: string; reload: string },
  outcome: PluginOutcome,
  detail: string,
  dir: string,
): PluginRow {
  return row(h.host, outcome, detail, {
    scopes: ["user"],
    version: ctx.version,
    dir,
    invoke: invokeOf(ctx, h.host),
    reload: h.reload,
    removed: tidy(ctx, h.host, dir),
  });
}

const noAnswer = (exe: string, args: readonly string[]): string =>
  `\`${[exe, ...args].join(" ")}\` did not answer`;

/** What a re-point that failed after its first step removed the working
 * install adds to the host's message. No render has been deleted yet on that
 * path, so the previous install is put back from `prev` while that folder is
 * there; otherwise the row says the host is left without QuickReview, and how
 * to install it again. */
function afterRemoval(
  h: { host: string; label: string },
  prev: string | null,
  restore: (prev: string) => boolean,
): string {
  if (prev !== null && prev !== "" && existsSync(prev) && restore(prev))
    return `; the previous install, from ${prev}, was put back`;
  return `; the previous install was already removed, so ${h.label} has no QuickReview now: \`qcr plugin install --to ${h.host}\` installs it again`;
}

/** `a` with `more` added to its message. */
const withMessage = (a: HostAnswer, more: string): HostAnswer => ({
  ...a,
  message: `${a.message}${more}`,
});

/** A host that installs from a local marketplace the render holds (Codex,
 * Copilot): the marketplace pointed at the render, then the plugin
 * installed from it. */
interface MarketplaceHost {
  host: string;
  label: string;
  exe: string;
  reload: string;
  noProject: string | null;
  /** The argv that lists the installs, and the release of QuickReview's in
   * what it printed: null when it is not installed. */
  list: readonly string[];
  installed(listed: unknown, ctx: Ctx): { version: string | null } | null;
  /** The argv that lists the marketplaces, and the folder QuickReview's
   * points at in what it printed: null when it is not declared. */
  marketplaces: readonly string[];
  declared(listed: unknown, ctx: Ctx): string | null;
  /** Each verb's argv. */
  addMarketplace(ctx: Ctx, dir: string): string[];
  removeMarketplace(ctx: Ctx): string[];
  installPlugin(ctx: Ctx): string[];
  removePlugin(ctx: Ctx): string[];
}

function marketplaceInstaller(m: MarketplaceHost): HostInstaller {
  const { host } = m;
  /** null: not installed; undefined: the list failed. */
  const installs = (ctx: Ctx, exe: string): { version: string | null } | null | undefined => {
    const listed = askJson(ctx, exe, m.list);
    return listed === null ? undefined : m.installed(listed, ctx);
  };
  /** null: not declared; undefined: the list failed. */
  const referenced = (ctx: Ctx, exe: string): string | null | undefined => {
    const listed = askJson(ctx, exe, m.marketplaces);
    return listed === null ? undefined : m.declared(listed, ctx);
  };
  /** The marketplace on `dir`: left alone when it is there already, else
   * added, after removing it from where it pointed. */
  const point = (ctx: Ctx, exe: string, dir: string): HostAnswer => {
    const at = referenced(ctx, exe);
    if (at === undefined)
      return { ok: false, json: null, message: noAnswer(m.exe, m.marketplaces) };
    if (at !== null && real(at) === real(dir)) return { ok: true, json: null, message: "" };
    if (at === null) return ask(ctx, exe, m.addMarketplace(ctx, dir));
    const gone = ask(ctx, exe, m.removeMarketplace(ctx));
    if (!gone.ok) return gone;
    const added = ask(ctx, exe, m.addMarketplace(ctx, dir));
    if (added.ok) return added;
    // the plugin's enablement outlives its marketplace, so adding the old
    // folder back restores the install
    return withMessage(
      added,
      afterRemoval(m, at, (prev) => ask(ctx, exe, m.addMarketplace(ctx, prev)).ok),
    );
  };
  const id = (ctx: Ctx): string => `${ctx.render.PLUGIN_NAME}@${ctx.render.MARKETPLACE_NAME}`;
  /** Point, then install: the row. `before` is what was installed. */
  const land = (
    ctx: Ctx,
    exe: string,
    before: { version: string | null } | null,
    outcome: PluginOutcome,
  ): PluginRow => {
    const dir = renderFor(ctx, host);
    const pointed = point(ctx, exe, dir);
    if (!pointed.ok) return row(host, "failed", pointed.message, { dir });
    const inst = ask(ctx, exe, m.installPlugin(ctx));
    if (!inst.ok) return row(host, "failed", inst.message, { dir, scopes: ["user"] });
    const was =
      before !== null && before.version !== null && before.version !== ctx.version
        ? ` (was ${before.version})`
        : "";
    return landed(
      ctx,
      m,
      outcome,
      inst.message !== "" ? inst.message : `${id(ctx)} at release ${ctx.version}${was}`,
      dir,
    );
  };
  return {
    host,
    label: m.label,
    ...onPath(m.exe),
    reload: m.reload,
    noProject: m.noProject,
    install(ctx, exe) {
      const before = installs(ctx, exe);
      if (before === undefined) return row(host, "failed", noAnswer(m.exe, m.list));
      const updated = before !== null && before.version !== ctx.version;
      return land(ctx, exe, before, updated ? "updated" : "installed");
    },
    update(ctx, exe) {
      const found = installs(ctx, exe);
      if (found === undefined) return row(host, "failed", noAnswer(m.exe, m.list));
      if (found === null)
        return row(host, "skipped", "QuickReview is not installed here", {
          removed: tidy(ctx, host, referenced(ctx, exe)),
        });
      return land(ctx, exe, found, "updated");
    },
    uninstall(ctx, exe) {
      const found = installs(ctx, exe);
      if (found === undefined) return row(host, "failed", noAnswer(m.exe, m.list));
      const declared = referenced(ctx, exe);
      if (declared === undefined) return row(host, "failed", noAnswer(m.exe, m.marketplaces));
      const said: string[] = [];
      const scopes = found === null ? [] : ["user"];
      if (found !== null) {
        const un = ask(ctx, exe, m.removePlugin(ctx));
        if (!un.ok) return row(host, "failed", un.message, { scopes });
        said.push(un.message);
      }
      if (declared !== null) {
        const gone = ask(ctx, exe, m.removeMarketplace(ctx));
        if (!gone.ok) return row(host, "failed", gone.message, { scopes });
        said.push(gone.message);
      }
      const removed = tidy(ctx, host, null);
      rmSync(join(ctx.root, host), { recursive: true, force: true });
      if (found === null && declared === null && removed.length === 0)
        return row(host, "skipped", "QuickReview is not installed here");
      return row(host, "removed", said.filter((s) => s !== "").join(" ") || `${id(ctx)} removed`, {
        scopes,
        reload: m.reload,
        removed,
      });
    },
  };
}

const str = (v: unknown): string | null => (typeof v === "string" ? v : null);

/** Codex: `codex plugin marketplace add`, then `codex plugin add
 * qcr@<mkt>` (the module header has what the probe showed). */
const codexInstaller = (): HostInstaller =>
  marketplaceInstaller({
    host: "codex",
    label: "Codex",
    exe: "codex",
    reload: "start a new Codex session",
    noProject: "Codex enables plugins in the user's config only, so it has no project scope",
    list: ["plugin", "list", "--json"],
    installed(listed, ctx) {
      const all = isRecord(listed) && Array.isArray(listed["installed"]) ? listed["installed"] : [];
      const e = all.find(
        (x): x is Record<string, unknown> =>
          isRecord(x) &&
          x["pluginId"] === `${ctx.render.PLUGIN_NAME}@${ctx.render.MARKETPLACE_NAME}` &&
          x["installed"] !== false,
      );
      return e === undefined ? null : { version: str(e["version"]) };
    },
    marketplaces: ["plugin", "marketplace", "list", "--json"],
    declared(listed, ctx) {
      const all =
        isRecord(listed) && Array.isArray(listed["marketplaces"]) ? listed["marketplaces"] : [];
      const e = all.find(
        (x): x is Record<string, unknown> =>
          isRecord(x) && x["name"] === ctx.render.MARKETPLACE_NAME,
      );
      // a marketplace of that name that is not a folder is never the render
      return e === undefined ? null : (str(e["root"]) ?? "");
    },
    addMarketplace: (_ctx, dir) => ["plugin", "marketplace", "add", dir, "--json"],
    removeMarketplace: (ctx) => [
      "plugin",
      "marketplace",
      "remove",
      ctx.render.MARKETPLACE_NAME,
      "--json",
    ],
    installPlugin: (ctx) => [
      "plugin",
      "add",
      `${ctx.render.PLUGIN_NAME}@${ctx.render.MARKETPLACE_NAME}`,
      "--json",
    ],
    removePlugin: (ctx) => [
      "plugin",
      "remove",
      `${ctx.render.PLUGIN_NAME}@${ctx.render.MARKETPLACE_NAME}`,
      "--json",
    ],
  });

/** Copilot CLI: `copilot plugin marketplace add`, then `copilot plugin
 * install qcr@<mkt>`, the form Copilot keeps supporting (the module header
 * has what the probe showed). */
const copilotInstaller = (): HostInstaller =>
  marketplaceInstaller({
    host: "copilot",
    label: "Copilot CLI",
    exe: "copilot",
    reload: "start a new Copilot CLI session",
    noProject:
      "Copilot CLI's project scope is the repository's .github/copilot/settings.json, which no copilot verb writes",
    list: ["plugin", "list", "--json"],
    installed(listed, ctx) {
      const e = (Array.isArray(listed) ? listed : []).find(
        (x): x is Record<string, unknown> =>
          isRecord(x) &&
          x["name"] === ctx.render.PLUGIN_NAME &&
          x["marketplace"] === ctx.render.MARKETPLACE_NAME &&
          x["enabled"] !== false,
      );
      return e === undefined ? null : { version: str(e["version"]) };
    },
    marketplaces: ["plugin", "marketplace", "list", "--json"],
    declared(listed, ctx) {
      const e = (Array.isArray(listed) ? listed : []).find(
        (x): x is Record<string, unknown> =>
          isRecord(x) && x["name"] === ctx.render.MARKETPLACE_NAME,
      );
      if (e === undefined) return null;
      const source = str(e["source"]) ?? "";
      // a marketplace of that name that is not a folder is never the render
      return source.startsWith("Local: ") ? source.slice("Local: ".length) : "";
    },
    addMarketplace: (_ctx, dir) => ["plugin", "marketplace", "add", dir],
    removeMarketplace: (ctx) => ["plugin", "marketplace", "remove", ctx.render.MARKETPLACE_NAME],
    installPlugin: (ctx) => [
      "plugin",
      "install",
      `${ctx.render.PLUGIN_NAME}@${ctx.render.MARKETPLACE_NAME}`,
    ],
    removePlugin: (ctx) => [
      "plugin",
      "uninstall",
      `${ctx.render.PLUGIN_NAME}@${ctx.render.MARKETPLACE_NAME}`,
    ],
  });

/** A host that installs the rendered folder itself by its path (Gemini CLI,
 * Antigravity): it is re-pointed by an uninstall, then an install. */
interface FolderHost {
  host: string;
  label: string;
  exe: string;
  reload: string;
  noProject: string | null;
  /** The argv that lists the installs, and QuickReview's in what it
   * printed: its release and the folder it was installed from, each null
   * when unknown; null when it is not installed. */
  list: readonly string[];
  installed(listed: unknown, ctx: Ctx): { version: string | null; source: string | null } | null;
  /** Each verb's argv, and the environment the install adds for its call. */
  install(ctx: Ctx, dir: string): { args: string[]; env?: Readonly<Record<string, string>> };
  uninstall(ctx: Ctx): string[];
}

function folderInstaller(f: FolderHost): HostInstaller {
  const { host } = f;
  type Found = { version: string | null; source: string | null };
  const installs = (ctx: Ctx, exe: string): Found | null | undefined => {
    const listed = askJson(ctx, exe, f.list);
    return listed === null ? undefined : f.installed(listed, ctx);
  };
  /** Install the render over `before`: nothing when `before` came from it. */
  const land = (ctx: Ctx, exe: string, before: Found | null, outcome: PluginOutcome): PluginRow => {
    const dir = renderFor(ctx, host);
    if (
      before !== null &&
      before.source !== null &&
      real(before.source) === real(dir) &&
      (before.version === null || before.version === ctx.version)
    )
      return landed(ctx, f, outcome, `already installed from release ${ctx.version}`, dir);
    if (before !== null) {
      const un = ask(ctx, exe, f.uninstall(ctx));
      if (!un.ok) return row(host, "failed", un.message, { dir, scopes: ["user"] });
    }
    const install = (from: string): HostAnswer => {
      const { args, env } = f.install(ctx, from);
      return ask(ctx, exe, args, env === undefined ? {} : { env });
    };
    const inst = install(dir);
    if (!inst.ok) {
      const more =
        before === null ? "" : afterRemoval(f, before.source, (prev) => install(prev).ok);
      return row(host, "failed", `${inst.message}${more}`, { dir, scopes: ["user"] });
    }
    return landed(ctx, f, outcome, inst.message, dir);
  };
  return {
    host,
    label: f.label,
    ...onPath(f.exe),
    reload: f.reload,
    noProject: f.noProject,
    install(ctx, exe) {
      const before = installs(ctx, exe);
      if (before === undefined) return row(host, "failed", noAnswer(f.exe, f.list));
      const updated = before !== null && before.version !== ctx.version;
      return land(ctx, exe, before, updated ? "updated" : "installed");
    },
    update(ctx, exe) {
      const found = installs(ctx, exe);
      if (found === undefined) return row(host, "failed", noAnswer(f.exe, f.list));
      if (found === null)
        return row(host, "skipped", "QuickReview is not installed here", {
          removed: tidy(ctx, host, null),
        });
      return land(ctx, exe, found, "updated");
    },
    uninstall(ctx, exe) {
      const found = installs(ctx, exe);
      if (found === undefined) return row(host, "failed", noAnswer(f.exe, f.list));
      let said = "";
      if (found !== null) {
        const un = ask(ctx, exe, f.uninstall(ctx));
        if (!un.ok) return row(host, "failed", un.message, { scopes: ["user"] });
        said = un.message;
      }
      const removed = tidy(ctx, host, null);
      rmSync(join(ctx.root, host), { recursive: true, force: true });
      if (found === null && removed.length === 0)
        return row(host, "skipped", "QuickReview is not installed here");
      return row(host, "removed", said, {
        scopes: found === null ? [] : ["user"],
        reload: f.reload,
        removed,
      });
    },
  };
}

/** Gemini CLI: `gemini extensions install <dir> --consent`, with the
 * workspace-trust variable set for that one call (the module header has
 * what the probe showed). */
const geminiInstaller = (): HostInstaller =>
  folderInstaller({
    host: "gemini",
    label: "Gemini CLI",
    exe: "gemini",
    reload: "restart Gemini CLI",
    noProject: "Gemini CLI installs extensions for the user only, so it has no project scope",
    list: ["extensions", "list", "-o", "json"],
    installed(listed, ctx) {
      const e = (Array.isArray(listed) ? listed : []).find(
        (x): x is Record<string, unknown> => isRecord(x) && x["name"] === ctx.render.PLUGIN_NAME,
      );
      if (e === undefined) return null;
      const meta = e["installMetadata"];
      return { version: str(e["version"]), source: isRecord(meta) ? str(meta["source"]) : null };
    },
    install: (_ctx, dir) => ({
      args: ["extensions", "install", dir, "--consent"],
      env: { GEMINI_CLI_TRUST_WORKSPACE: "true" },
    }),
    uninstall: (ctx) => ["extensions", "uninstall", ctx.render.PLUGIN_NAME],
  });

/** Antigravity: `agy plugin install <dir>` (from its docs; the module
 * header says what is unprobed). Its manifest carries no version, so the
 * installed release is read from the render folder a list entry names. */
const antigravityInstaller = (): HostInstaller =>
  folderInstaller({
    host: "antigravity",
    label: "Antigravity",
    exe: "agy",
    reload: "start a new Antigravity session",
    noProject: "agy plugin install has no project scope",
    list: ["plugin", "list", "--json"],
    installed(listed, ctx) {
      const all = Array.isArray(listed)
        ? listed
        : isRecord(listed) && Array.isArray(listed["plugins"])
          ? listed["plugins"]
          : [];
      const e = all.find(
        (x): x is Record<string, unknown> => isRecord(x) && x["name"] === ctx.render.PLUGIN_NAME,
      );
      if (e === undefined) return null;
      const base = join(ctx.root, "antigravity");
      const source =
        ["path", "source", "installedFrom"]
          .map((k) => str(e[k]))
          .find((p) => p !== null && resolve(p).startsWith(`${base}/`)) ?? null;
      return {
        version:
          source === null
            ? null
            : (resolve(source)
                .slice(base.length + 1)
                .split("/")[0] ?? null),
        source,
      };
    },
    install: (_ctx, dir) => ({ args: ["plugin", "install", dir] }),
    uninstall: (ctx) => ["plugin", "uninstall", ctx.render.PLUGIN_NAME],
  });

/** A host with no install verb (Cursor, opencode): the render's files
 * copied where the host loads them, with a record of every file and folder
 * the copy wrote, so update and uninstall touch those and nothing else. */
interface CopyHost {
  host: string;
  label: string;
  reload: string;
  noProject: string | null;
  /** The executables, any one of which on PATH means the host is here. */
  exes: readonly string[];
  /** A folder whose presence also means it is here. */
  configDir?(env: PluginDeps["env"]): string;
  /** The render's files under `from` are copied to `<to>/<into><the rest
   * of the path>`. */
  from: string;
  into: string;
  to(env: PluginDeps["env"]): string;
}

/** What a copy wrote, in `<data home>/plugins/<host>.copy.json`. */
interface CopyRecord {
  version: string;
  /** The render the files were copied from. */
  render: string;
  /** Every file the copy wrote, absolute. */
  files: string[];
  /** Every folder it created, absolute. */
  dirs: string[];
}

/** Whether anything, a dangling link included, is at `p`. */
const there = (p: string): boolean => {
  try {
    lstatSync(p);
    return true;
  } catch {
    return false;
  }
};

const isDir = (p: string): boolean => {
  try {
    return statSync(p).isDirectory();
  } catch {
    return false;
  }
};

/** Delete `files` (a folder in their place is left alone), then each of
 * `dirs` that is empty, deepest first: a folder holding anything the copy
 * did not write keeps it. The files deleted. */
function unwrite(files: readonly string[], dirs: readonly string[]): string[] {
  const gone: string[] = [];
  for (const f of files) {
    try {
      if (lstatSync(f).isDirectory()) continue;
    } catch {
      continue; // already gone
    }
    rmSync(f, { force: true });
    gone.push(f);
  }
  for (const d of [...dirs].sort((a, b) => b.length - a.length)) {
    try {
      rmdirSync(d);
    } catch {
      // not empty, or gone
    }
  }
  return gone;
}

function copyInstaller(c: CopyHost): HostInstaller {
  const { host } = c;
  const recordPath = (ctx: Ctx): string => join(ctx.root, `${host}.copy.json`);
  /** The record, or null when there is none; one that cannot be read
   * throws, since without it no file can be told to be the copy's. */
  const readRecord = (ctx: Ctx): CopyRecord | null => {
    const p = recordPath(ctx);
    if (!existsSync(p)) return null;
    let v: unknown;
    try {
      v = JSON.parse(readFileSync(p, "utf8")) as unknown;
    } catch {
      v = null;
    }
    const strs = (x: unknown): x is string[] =>
      Array.isArray(x) && x.every((e) => typeof e === "string");
    if (
      !isRecord(v) ||
      typeof v["version"] !== "string" ||
      typeof v["render"] !== "string" ||
      !strs(v["files"]) ||
      !strs(v["dirs"])
    )
      throw new Error(`${p} is not a record qcr plugin can read; it names the files to remove`);
    return { version: v["version"], render: v["render"], files: v["files"], dirs: v["dirs"] };
  };
  const writeRecord = (ctx: Ctx, r: CopyRecord): void => {
    mkdirSync(ctx.root, { recursive: true });
    writeFileSync(recordPath(ctx), `${JSON.stringify(r, null, 2)}\n`);
  };
  /** Is the copy a record names still there? */
  const live = (r: CopyRecord | null): r is CopyRecord =>
    r !== null && r.files.some((f) => there(f));
  const dest = (ctx: Ctx): string => resolve(c.to(ctx.deps.env), c.into);
  const plural = (n: number): string => `${n} file${n === 1 ? "" : "s"}`;

  /** Copy this release's render over `before`'s copy: the row. */
  const land = (ctx: Ctx, before: CopyRecord | null, outcome: PluginOutcome): PluginRow => {
    const to = c.to(ctx.deps.env);
    const rels = Object.keys(
      ctx.render.render(ctx.source, host, {
        version: ctx.version,
        contract: ctx.render.TEMPLATE_CONTRACT,
      }),
    )
      .filter((p) => p.startsWith(c.from))
      .map((p) => ({ path: p, rel: `${c.into}${p.slice(c.from.length)}` }));
    const ownFiles = new Set(before?.files ?? []);
    const ownDirs = new Set(before?.dirs ?? []);
    // a path already there that the copy did not write is never written
    // over: neither the folder a command lands in nor any file
    for (const { rel } of rels) {
      const top = join(to, rel.split("/")[0]!);
      const at = join(to, rel);
      for (const p of [top, at])
        if (there(p) && !ownDirs.has(p) && !ownFiles.has(p))
          return row(
            host,
            "failed",
            `${p} is already there and qcr plugin did not write it; move it away, then install again`,
            { dir: dest(ctx) },
          );
    }
    const dir = renderFor(ctx, host);
    const next = rels.map((r) => join(to, r.rel));
    const dirs = new Set(ownDirs);
    for (const f of next)
      for (let d = dirname(f); !there(d) && d !== dirname(d); d = dirname(d)) dirs.add(d);
    // recorded before anything is written, so a copy cut short is still
    // the copy's to remove
    writeRecord(ctx, {
      version: ctx.version,
      render: dir,
      files: [...new Set([...ownFiles, ...next])],
      dirs: [...dirs],
    });
    for (const [i, r] of rels.entries()) {
      const f = next[i]!;
      mkdirSync(dirname(f), { recursive: true });
      rmSync(f, { force: true });
      copyFileSync(join(dir, r.path), f);
    }
    // what an older release wrote and this one does not
    unwrite(
      [...ownFiles].filter((f) => !next.includes(f)),
      [...dirs].filter((d) => !next.some((f) => f.startsWith(`${d}/`))),
    );
    writeRecord(ctx, {
      version: ctx.version,
      render: dir,
      files: next,
      dirs: [...dirs].filter((d) => there(d)),
    });
    const was = before !== null && before.version !== ctx.version ? ` (was ${before.version})` : "";
    return row(host, outcome, `copied ${plural(next.length)} into ${dest(ctx)}${was}`, {
      scopes: ["user"],
      version: ctx.version,
      dir: dest(ctx),
      invoke: invokeOf(ctx, host),
      reload: c.reload,
      removed: tidy(ctx, host, dir),
    });
  };
  /** Everything the copy and the installer wrote for this host, gone. */
  const clear = (ctx: Ctx, r: CopyRecord | null): { files: string[]; renders: string[] } => {
    const files = r === null ? [] : unwrite(r.files, r.dirs);
    const renders = tidy(ctx, host, null);
    rmSync(join(ctx.root, host), { recursive: true, force: true });
    rmSync(recordPath(ctx), { force: true });
    return { files, renders };
  };

  return {
    host,
    label: c.label,
    lookFor: (ctx) => [...c.exes, ...(c.configDir ? [c.configDir(ctx.deps.env)] : [])],
    locate(ctx) {
      for (const exe of c.exes) {
        const at = which(exe, ctx.deps.env["PATH"], ctx.deps.cwd);
        if (at !== null) return at;
      }
      const cfg = c.configDir?.(ctx.deps.env);
      return cfg !== undefined && isDir(cfg) ? cfg : null;
    },
    notFound(ctx) {
      const exes = c.exes.length > 1 ? `neither ${c.exes.join(" nor ")} is` : `${c.exes[0]} is not`;
      const cfg = c.configDir?.(ctx.deps.env);
      return cfg === undefined ? `${exes} on PATH` : `${exes} on PATH, and there is no ${cfg}`;
    },
    recorded: (ctx) => (existsSync(recordPath(ctx)) ? recordPath(ctx) : null),
    reload: c.reload,
    noProject: c.noProject,
    install(ctx) {
      const before = readRecord(ctx);
      const updated = live(before) && before.version !== ctx.version;
      return land(ctx, before, updated ? "updated" : "installed");
    },
    update(ctx) {
      const before = readRecord(ctx);
      if (!live(before)) {
        // a record whose copy is gone is no install: it and the renders go
        const { renders } = clear(ctx, before);
        return row(host, "skipped", "QuickReview is not installed here", { removed: renders });
      }
      return land(ctx, before, "updated");
    },
    uninstall(ctx) {
      const before = readRecord(ctx);
      const { files, renders } = clear(ctx, before);
      if (before === null && renders.length === 0)
        return row(host, "skipped", "QuickReview is not installed here");
      return row(host, "removed", `deleted ${plural(files.length)} from ${dest(ctx)}`, {
        scopes: files.length > 0 ? ["user"] : [],
        reload: c.reload,
        removed: renders,
      });
    },
  };
}

/** Cursor: the render copied into its local-plugins folder (the module
 * header has what its docs say). */
const cursorInstaller = (): HostInstaller =>
  copyInstaller({
    host: "cursor",
    label: "Cursor",
    reload:
      "reload the Cursor window, or start a new cursor-agent session, so it re-indexes its local plugins",
    noProject:
      "Cursor loads local plugins from the user's ~/.cursor only, so it has no project scope",
    exes: ["cursor-agent", "cursor"],
    configDir: (env) => join(homeOf(env), ".cursor"),
    from: "",
    into: "qcr/",
    to: (env) => join(homeOf(env), ".cursor", "plugins", "local"),
  });

/** opencode: the rendered skills copied into its global skills folder (the
 * module header has what the probe showed). */
const opencodeInstaller = (): HostInstaller =>
  copyInstaller({
    host: "opencode",
    label: "opencode",
    reload: "restart opencode",
    noProject:
      "qcr plugin puts opencode's skills in its global skills folder only, so it has no project scope",
    exes: ["opencode"],
    from: "skills/",
    into: "",
    to: (env) => join(xdgBase(env["XDG_CONFIG_HOME"], env, ".config"), "opencode", "skills"),
  });

/** Every host the installer can install into, in `--to all` order. */
const INSTALLERS: readonly HostInstaller[] = [
  claudeInstaller(),
  codexInstaller(),
  copilotInstaller(),
  cursorInstaller(),
  opencodeInstaller(),
  geminiInstaller(),
  antigravityInstaller(),
];

/** The hosts `qcr plugin` installs into, by name. */
export const PLUGIN_HOSTS: readonly string[] = INSTALLERS.map((i) => i.host);

// ---- the verb -------------------------------------------------------------------

interface Parsed {
  verb: "install" | "update" | "uninstall";
  hosts: readonly HostInstaller[];
  /** Was one host named (a missing one is its own skipped row) or all (none
   * found prints the one "no coding-agent CLI found" line)? */
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
    for (const n of r.notes) out.push(`  ${n}`);
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
  /** The hosts not found here. */
  const missing = new Set<string>();
  for (const h of p.hosts) {
    const exe = h.locate(ctx) ?? (p.verb === "install" ? null : (h.recorded?.(ctx) ?? null));
    if (exe === null) {
      missing.add(h.host);
      rows.push(row(h.host, "skipped", h.notFound(ctx)));
      continue;
    }
    // a host with no project scope is skipped, never given a user install
    if (p.verb === "install" && p.project && h.noProject !== null) {
      rows.push(row(h.host, "skipped", h.noProject));
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
    if (!p.named && rows.every((r) => missing.has(r.host)))
      deps.out(
        `qcr plugin ${p.verb}: no coding-agent CLI found (looked for ${p.hosts.flatMap((h) => h.lookFor(ctx)).join(", ")}).`,
      );
    else for (const l of summary(rows, label)) deps.out(l);
  }
  return failed ? 1 : 0;
}
