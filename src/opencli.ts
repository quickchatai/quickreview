// `qcr open [RUN | DIR | FILE.jsonl] [--lens ID] [--write] [--print] [--json]` -
// open a finished review session in pi's own interactive UI (D10).
// `qcr open pr N [--round R] [--lens ID]` opens the bot's session for a PR: pulled
// read-only from the bot's box first (src/openpr.ts), then forked here.
//
// RUN is a detached run id (`qcr review start`), a `qcr review` run directory
// name, a bench case dir, a scan run (`scan` or `scan:<run>`, then `--lens`
// names a case), or a path, or a closed PR's extracted archive
// (`qcr archive extract`: its worker rounds under `files/state/lens/`, the main
// session its newest transcript); with none, the newest run. The main session opens
// by default, `--lens ID` opens one lens pass (its run id, its agent name, or an
// unambiguous prefix of the id).
//
// The session is FORKED (`pi --fork`): pi copies it into a new session of its
// own and the finished one is never touched, so looking is safe. `--write` opens
// the session itself (`pi --session`), and anything typed is appended to it.
//
// Pi starts with the extension set the round had, minus anything that posts:
// the main session gets bash-guard, ledger-pin, our lens tools and
// cluster_findings; a lens pass is a leaf and gets bash-guard alone. It runs on
// a private agent dir holding a refresh-blanked copy of the operator's login
// (src/hostroute.ts prepareHostRun), so the open never rotates the login pi
// itself holds, and with no GitHub token in its environment.
import { copyFileSync, existsSync, readdirSync, rmSync, statSync } from "node:fs";
import { basename, dirname, isAbsolute, join, resolve } from "node:path";
import { GIT_ISOLATION_ENV } from "./bench/exec.js";
import { CONTEXT_PACK_FILE } from "@quickchatai/pi-quickreview/src/contextpack.js";
import { GITHUB_TOKEN_ENVS } from "@quickchatai/pi-quickreview/src/envstrip.js";
import {
  hasSessions,
  lensAgentsOf,
  lensSessionsOf,
  mainSessionOf,
  readOpenMeta,
  type LensSessionRef,
  type OpenMeta,
} from "@quickchatai/pi-quickreview/src/engine/openable.js";
import { openPrOptions, type OpenPrOptions, type PrPull } from "./openpr.js";
import { piCliPath } from "./picli.js";

export const OPEN_USAGE =
  "usage: qcr open [RUN_ID | DIR | FILE.jsonl | scan[:RUN]] [--lens ID] [--write] [--print] [--json]\n" +
  "       qcr open pr <N> [--round R] [--lens ID] [--print] [--json]";

export function openHelp(): string {
  return [
    OPEN_USAGE,
    "",
    "Open a finished review session in pi's interactive UI. The main session opens by",
    "default; --lens ID opens one lens pass (its run id, its agent name or an id prefix;",
    "a scan run is opened by case with --lens CASE).",
    "",
    "  --write   open the session itself, so what you type is appended to it. Without it",
    "            the session is forked and the finished one is never touched.",
    "  --print   show the command and environment, start nothing",
    "",
    "Pi loads the extensions the round had, minus anything that posts, on a private copy of",
    "your login that is never refreshed, with no GitHub token in its environment.",
    "",
    "qcr open pr N opens the bot's session for PR N. It is read from the box that hosts the bot",
    "over the TUI's ssh runner (or, for a PR closed for 14 days, from its archive, verified like",
    "`qcr archive extract`), copied read-only into your state home, and forked here: the box",
    "does no work and nothing on it is written. --round R keeps the session as it stood when",
    "round R finished. --lens ID opens a kept lens pass of the PR (workers keep them, P8.3).",
    'A run dir literally named "pr" is opened as ./pr.',
  ].join("\n");
}

/** The extensions pi loads on the main session of a round: the same set the
 * round had (bash-guard, ledger-pin, the lens tool, cluster_findings). Nothing
 * here posts: the posting path is the gate's, never a session's. */
export const MAIN_OPEN_EXTENSIONS = [
  "extensions/cli/bash-guard.ts",
  "extensions/cli/ledger-pin.ts",
  "extensions/cli/lens.ts",
  "packages/pi-plugin/extensions/finding-clusters.ts",
] as const;

/** A lens pass is a leaf: the guard, and no lens tool. */
export const LENS_OPEN_EXTENSIONS = ["extensions/cli/bash-guard.ts"] as const;

/** The bot's own session (`qcr open pr`): the guard alone. The bot's tools are
 * the tmux era's subagent/launch_plan, which this machine does not run, and the
 * posting path is the daemon's, so there is none to carry. */
export const BOT_OPEN_EXTENSIONS = LENS_OPEN_EXTENSIONS;

export type OpenMode = "fork" | "write";

/** pi's argv for opening `file`. Pure. `extensions` are absolute paths. */
export function openArgv(o: {
  file: string;
  mode: OpenMode;
  extensions: readonly string[];
  name?: string;
}): string[] {
  return [
    // Host isolation as the round has it: pi discovers no extension, skill or
    // package of its own, only the ones named here. `-nc` is absent on purpose:
    // the cwd's context file is the reviewer stub.
    "--approve",
    "-ne",
    "-ns",
    ...o.extensions.flatMap((e) => ["--extension", e]),
    ...(o.name !== undefined ? ["--name", o.name] : []),
    o.mode === "write" ? "--session" : "--fork",
    o.file,
  ];
}

/** The environment pi is started with: the caller's, minus every GitHub token,
 * plus the round's QCR_* names (re-rooted at this checkout) and git isolation. */
export function openEnv(o: {
  base: Readonly<Record<string, string | undefined>>;
  meta: OpenMeta | null;
  root: string;
  /** Where the session's lens ledger, lens sessions and context pack live: the
   * round dir itself when the open writes into the round, else a throwaway dir
   * holding a copy of its ledger, so a forked session leaves the round as it was. */
  ledgerDir: string;
  agentDir: string;
}): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...o.base };
  for (const k of GITHUB_TOKEN_ENVS) delete env[k];
  Object.assign(env, o.meta?.env ?? {}, GIT_ISOLATION_ENV, {
    PI_CODING_AGENT_DIR: o.agentDir,
    QCR_SANDBOX_ROOT: o.root,
    QCR_SUBAGENT_SCOPE: "user",
  });
  env["QCR_LEDGER_FILE"] = join(o.ledgerDir, "ledger.md");
  return env;
}

// ---- finding the session -----------------------------------------------------------

export interface OpenDeps {
  /** The detached-run registry (`<state home>/review/detached`). */
  detachedHome: string;
  /** Where foreground `qcr review` runs live (`<state home>/review/runs`). */
  runsDir: string;
  /** Where a scan keeps its transcripts (`<state home>/scan/transcripts`). */
  scanDir: string;
  /** The production tree (extensions/). */
  root: string;
  cwd: string;
  env: Readonly<Record<string, string | undefined>>;
  out: (line: string) => void;
  /** The pi binary. Omitted: the pinned pi's own CLI (src/picli.ts), never a
   * `pi` on the PATH. */
  piBin?: string;
  /** A tag that makes this invocation's scratch dirs its own (the terminal side
   * passes its pid), so two opens of one round never share or delete each
   * other's. Omitted: the plain names. */
  instance?: string;
  /** Prepares the private agent dir and the cwd pi runs in; `cleanup` removes
   * them (the login copy goes with the open). */
  prepare: (o: { roundDir: string; copyRound: boolean; instance?: string }) => {
    agentDir: string;
    cwd: string;
    cleanup: () => void;
  };
  /** `qcr open pr`: pulls the bot's session for a PR into a local run dir
   * (src/openpr.ts). Omitted: the verb is unavailable. */
  fetchPr?: (o: OpenPrOptions) => Promise<PrPull>;
  /** Runs pi on the terminal; resolves its exit code. */
  spawn: (cmd: {
    bin: string;
    args: string[];
    cwd: string;
    env: NodeJS.ProcessEnv;
  }) => number | Promise<number>;
}

const isDir = (p: string): boolean => {
  try {
    return statSync(p).isDirectory();
  } catch {
    return false;
  }
};

const mtime = (p: string): number => {
  try {
    return statSync(p).mtimeMs;
  } catch {
    return 0;
  }
};

const subdirs = (dir: string): string[] => {
  try {
    return readdirSync(dir)
      .map((n) => join(dir, n))
      .filter(isDir);
  } catch {
    return [];
  }
};

/** Where `qcr archive extract` puts a closed PR's worker rounds (P8.16, D10): the
 * lens passes' trees, `state/lens/<pr-n>/r<k>/`, laid out as the round dir
 * `qcr open` reads. The main session is a transcript, `transcripts/*.jsonl`. */
const EXTRACTED_LENS = join("files", "state", "lens");

/** The worker rounds of an extracted archive at `path`, highest round first;
 * [] when `path` is not one. */
function extractedRoundsOf(path: string): string[] {
  const rounds: Array<{ dir: string; k: number }> = [];
  for (const prDir of subdirs(join(path, EXTRACTED_LENS)))
    for (const dir of subdirs(prDir)) {
      const k = /^r(\d+)$/.exec(basename(dir));
      if (k && hasSessions(dir)) rounds.push({ dir, k: Number(k[1]) });
    }
  return rounds.sort((a, b) => b.k - a.k || a.dir.localeCompare(b.dir)).map((r) => r.dir);
}

/** The newest transcript of an extracted archive (a spawn's file can sit in a
 * subdirectory): the PR's main session. */
function extractedMainOf(path: string): string | null {
  const base = join(path, "transcripts");
  let best: { file: string; m: number } | null = null;
  const walk = (dir: string): void => {
    let names: string[];
    try {
      names = readdirSync(dir);
    } catch {
      return;
    }
    for (const n of names) {
      const p = join(dir, n);
      if (isDir(p)) walk(p);
      else if (n.endsWith(".jsonl")) {
        const m = mtime(p);
        if (!best || m > best.m || (m === best.m && p > best.file)) best = { file: p, m };
      }
    }
  };
  walk(base);
  return (best as { file: string } | null)?.file ?? null;
}

/** The round dirs a run holds, newest first: the dir itself, its `out`, or the
 * `out` of each run root under `work/` (a detached run), or the worker rounds of
 * an extracted archive. */
function roundDirsOf(path: string): string[] {
  const extracted = extractedRoundsOf(path);
  if (extracted.length > 0) return extracted;
  const candidates = [
    path,
    join(path, "out"),
    ...subdirs(join(path, "work")).map((w) => join(w, "out")),
  ];
  return candidates.filter(hasSessions).sort((a, b) => mtime(b) - mtime(a));
}

const NAME = /^[A-Za-z0-9][A-Za-z0-9._:-]*$/;

/** Every run directory a bare name or no name can mean, newest first. */
function knownRuns(deps: OpenDeps, name?: string): string[] {
  const homes = [join(deps.detachedHome, "runs"), deps.runsDir];
  const dirs =
    name !== undefined ? homes.map((h) => join(h, name)) : homes.flatMap((h) => subdirs(h));
  return dirs.filter(isDir).sort((a, b) => mtime(b) - mtime(a));
}

/** The disposable agent dir and cwd an open uses inside `roundDir`; a tagged
 * pair belongs to one invocation. */
export function openScratchDirs(
  roundDir: string,
  instance?: string,
): { agentDir: string; cwd: string } {
  const tag = instance === undefined ? "" : `-${instance}`;
  return { agentDir: join(roundDir, `open-agent${tag}`), cwd: join(roundDir, `open-cwd${tag}`) };
}

export type Found =
  | { ok: true; file: string; kind: "main" | "lens"; id: string | null; roundDir: string }
  | { ok: false; error: string };

const fail = (error: string): Found => ({ ok: false, error });

function pickLens(roundDir: string, lens: string): LensSessionRef | string {
  const all = lensSessionsOf(roundDir);
  if (all.length === 0) return `${roundDir} kept no lens sessions`;
  const agents = lensAgentsOf(roundDir);
  const label = (r: LensSessionRef): string =>
    agents.has(r.id) ? `${r.id} (${agents.get(r.id)})` : r.id;
  const exact = all.find((r) => r.id === lens);
  if (exact) return exact;
  const byAgent = all.filter((r) => agents.get(r.id) === lens);
  if (byAgent.length === 1) return byAgent[0]!;
  if (byAgent.length > 1)
    return `${byAgent.length} lens sessions ran as ${lens}; name one by id: ${byAgent.map((r) => r.id).join(", ")}`;
  const prefixed = all.filter((r) => r.id.startsWith(lens));
  if (prefixed.length === 1) return prefixed[0]!;
  return `no lens session ${lens}${prefixed.length > 1 ? " (more than one id starts with it)" : ""}; this run kept: ${all.map(label).join(", ")}`;
}

/** Which session JSONL `arg` and `lens` name. */
export function findSession(
  arg: string | undefined,
  lens: string | undefined,
  deps: OpenDeps,
): Found {
  if (lens !== undefined && !/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(lens))
    return fail("--lens needs a lens id or an agent name");
  // A session file is opened as it is.
  if (arg !== undefined && arg.endsWith(".jsonl")) {
    const file = resolve(deps.cwd, arg);
    if (!existsSync(file) || isDir(file)) return fail(`no session file ${arg}`);
    if (lens !== undefined) return fail("--lens goes with a run, not with a session file");
    return { ok: true, file, kind: "main", id: null, roundDir: dirname(file) };
  }
  let runs: string[];
  if (arg === undefined) runs = knownRuns(deps);
  else if (arg === "scan" || arg.startsWith("scan:")) {
    const run = arg.slice("scan:".length);
    runs = (arg === "scan" ? subdirs(deps.scanDir) : [join(deps.scanDir, run)])
      .filter(isDir)
      .sort((a, b) => mtime(b) - mtime(a));
  } else if (arg.includes("/") || arg.startsWith(".") || isAbsolute(arg)) {
    runs = isDir(resolve(deps.cwd, arg)) ? [resolve(deps.cwd, arg)] : [];
  } else if (NAME.test(arg)) {
    const bare = knownRuns(deps, arg);
    runs = bare.length > 0 ? bare : isDir(resolve(deps.cwd, arg)) ? [resolve(deps.cwd, arg)] : [];
  } else runs = [];
  let run = runs.find((r) => roundDirsOf(r).length > 0);
  let roundDir = run === undefined ? undefined : roundDirsOf(run)[0];
  // An extracted archive that kept only the main transcript has no worker round.
  if (run === undefined && lens === undefined) {
    run = runs.find((r) => extractedMainOf(r) !== null);
    roundDir = run;
  }
  if (roundDir === undefined || run === undefined)
    return fail(
      arg === undefined
        ? "no run kept a session to open"
        : `no run ${arg} kept a session to open (a run dir holds session/ or lens-sessions/)`,
    );
  if (lens !== undefined) {
    const picked = pickLens(roundDir, lens);
    if (typeof picked === "string") return fail(picked);
    return { ok: true, file: picked.file, kind: "lens", id: picked.id, roundDir };
  }
  // An extracted archive keeps the PR's main session as a transcript, not in the round.
  const main =
    mainSessionOf(roundDir) ??
    (roundDir === run || roundDir.startsWith(join(run, EXTRACTED_LENS))
      ? extractedMainOf(run)
      : null);
  if (main === null) {
    const kept = lensSessionsOf(roundDir);
    return fail(
      `${roundDir} kept no main session; it kept ${kept.length} lens session${kept.length === 1 ? "" : "s"}: ` +
        `open one with --lens ${kept
          .slice(0, 6)
          .map((r) => r.id)
          .join(" | --lens ")}${kept.length > 6 ? " | …" : ""}`,
    );
  }
  return { ok: true, file: main, kind: "main", id: null, roundDir };
}

// ---- the verb ------------------------------------------------------------------------

/** Run `qcr open`; resolves its exit code (pi's, or 1 nothing to open, 2 usage). */
export async function runOpen(
  rest: readonly string[],
  json: boolean,
  deps: OpenDeps,
): Promise<number> {
  const positional: string[] = [];
  let lens: string | undefined;
  let round: string | undefined;
  let mode: OpenMode = "fork";
  let print = false;
  let help = false;
  const usage = (why: string): number => {
    deps.out(`${OPEN_USAGE}\n(${why})`);
    return 2;
  };
  for (let i = 0; i < rest.length; i++) {
    const a = rest[i]!;
    if (a === "--write") mode = "write";
    else if (a === "--print") print = true;
    else if (a === "--json") json = true;
    else if (a === "--help" || a === "-h") help = true;
    else if (a === "--lens") {
      lens = rest[++i];
      if (lens === undefined || lens.startsWith("--")) return usage("--lens needs a value");
    } else if (a === "--round") {
      round = rest[++i];
      if (round === undefined || round.startsWith("--")) return usage("--round needs a value");
    } else if (!a.startsWith("-")) positional.push(a);
    else return usage(`unknown argument ${a}`);
  }
  if (help) {
    deps.out(openHelp());
    return 0;
  }
  const botPr = positional[0] === "pr";
  if (!botPr && (round !== undefined || positional.length > 1))
    return usage(
      round !== undefined ? "--round goes with `pr N`" : `unknown argument ${positional[1]}`,
    );
  let arg: string | undefined = positional[0];
  if (botPr) {
    if (positional.length > 2) return usage(`unknown argument ${positional[2]}`);
    if (mode === "write")
      return usage(
        "a bot session opens as a fork of a local copy; --write has nothing to write to",
      );
    const asked = openPrOptions(positional[1], round, lens);
    if (!asked.ok) return usage(asked.error);
    if (!deps.fetchPr) return usage("qcr open pr is not available here");
    const pulled = await deps.fetchPr(asked.value);
    if (!pulled.ok) {
      deps.out(json ? JSON.stringify({ ok: false, errors: [pulled.error] }) : `✗ ${pulled.error}`);
      return 1;
    }
    if (!json) deps.out(pulled.note);
    arg = pulled.dir;
  }
  const found = findSession(arg, lens, deps);
  if (!found.ok) {
    deps.out(json ? JSON.stringify({ ok: false, errors: [found.error] }) : `✗ ${found.error}`);
    return 1;
  }
  const names = botPr
    ? BOT_OPEN_EXTENSIONS
    : found.kind === "main"
      ? MAIN_OPEN_EXTENSIONS
      : LENS_OPEN_EXTENSIONS;
  const extensions = names.map((n) => join(deps.root, n));
  const meta = readOpenMeta(found.roundDir);
  const bin = deps.piBin ?? piCliPath();
  // Writing into a round that recorded how it ran keeps its ledger and lens
  // sessions where they are; a fork (or a bare file) works on a copy.
  const inPlace = mode === "write" && meta !== null;
  const label = found.kind === "lens" ? `lens ${found.id}` : "the main session";
  if (print) {
    const { agentDir, cwd: scratchCwd } = openScratchDirs(found.roundDir, deps.instance);
    const args = openArgv({ file: found.file, mode, extensions });
    const env = openEnv({
      base: {},
      meta,
      root: deps.root,
      ledgerDir: inPlace ? found.roundDir : scratchCwd,
      agentDir,
    });
    const shown = Object.fromEntries(
      Object.entries(env).filter(([k]) => k.startsWith("QCR_") || k === "PI_CODING_AGENT_DIR"),
    );
    deps.out(
      json
        ? JSON.stringify({
            ok: true,
            session: found.file,
            kind: found.kind,
            mode,
            command: bin,
            args,
            env: shown,
          })
        : [
            `${mode === "write" ? "Open" : "Fork"} ${label}: ${found.file}`,
            `  ${[bin, ...args].join(" ")}`,
            ...Object.entries(shown).map(([k, v]) => `  ${k}=${v}`),
          ].join("\n"),
    );
    return 0;
  }
  let host: ReturnType<OpenDeps["prepare"]>;
  try {
    host = deps.prepare({
      roundDir: found.roundDir,
      copyRound: !inPlace,
      ...(deps.instance !== undefined ? { instance: deps.instance } : {}),
    });
  } catch (err) {
    const why = err instanceof Error ? err.message : String(err);
    deps.out(json ? JSON.stringify({ ok: false, errors: [why] }) : `✗ ${why.slice(0, 600)}`);
    return 1;
  }
  try {
    if (!json)
      deps.out(
        `${mode === "write" ? "Opening" : "Opening a fork of"} ${label} in pi (${basename(found.file)})` +
          (mode === "write"
            ? "; what you type is appended to the session."
            : "; the finished session is not touched."),
      );
    const env = openEnv({
      base: deps.env,
      meta,
      root: deps.root,
      ledgerDir: inPlace ? found.roundDir : host.cwd,
      agentDir: host.agentDir,
    });
    return await deps.spawn({
      bin,
      args: openArgv({ file: found.file, mode, extensions }),
      cwd: host.cwd,
      env,
    });
  } finally {
    host.cleanup();
  }
}

/** The terminal side: the real state home, config, login and pi. */
export async function cmdOpen(rest: string[], json: boolean): Promise<number> {
  const { sandboxRoot, loadConfig } = await import("./config.js");
  const { stateHome } = await import("./install.js");
  const { contextFor } = await import("./reviewcontext.js");
  const { prepareHostRun } = await import("./hostroute.js");
  const { homedir } = await import("node:os");
  const { spawn } = await import("node:child_process");
  const root = sandboxRoot();
  const home = stateHome();
  const srcAgentDir =
    process.env["PI_CODING_AGENT_DIR"]?.trim() ||
    join(process.env["HOME"] || homedir(), ".pi", "agent");
  return runOpen(rest, json, {
    detachedHome: join(home, "review", "detached"),
    runsDir: join(home, "review", "runs"),
    scanDir: join(home, "scan", "transcripts"),
    root,
    cwd: process.cwd(),
    env: process.env,
    out: (l) => console.log(l),
    fetchPr: async (o) => {
      // The bot's box, over the TUI's own runner: `[tui] ssh_host` / `target`.
      const cfg = loadConfig();
      const { runnerFor } = await import("./tui/remote.js");
      const { pullPrSession } = await import("./openpr.js");
      const { extractPr } = await import("./archive/extract.js");
      const { archivePolicy } = await import("./archive/archiver.js");
      const bytesPerS = archivePolicy(cfg.archive).maxBytesPerS;
      return pullPrSession(o, {
        cfg: cfg.tui,
        sessionDir: cfg.pi.session_dir,
        ssh: runnerFor(cfg.tui),
        home,
        extract: (x) => extractPr({ ...x, bytesPerS }),
      });
    },
    instance: String(process.pid),
    prepare: ({ roundDir, copyRound, instance }) => {
      const cfg0 = loadConfig();
      const { cfg } = contextFor(root, cfg0.review.profile);
      const { agentDir, cwd } = openScratchDirs(roundDir, instance);
      // An open lasts as long as someone looks: 30 minutes of login at least.
      prepareHostRun({ root, srcAgentDir, agentDir, cwd, cfg, needMs: 30 * 60_000, checkouts: [] });
      // A fork works on a copy of what the round's tools read from beside its
      // ledger, so what it launches lands in a directory that goes with the open.
      if (copyRound)
        for (const f of ["ledger.md", CONTEXT_PACK_FILE])
          if (existsSync(join(roundDir, f))) copyFileSync(join(roundDir, f), join(cwd, f));
      return {
        agentDir,
        cwd,
        cleanup: () => {
          rmSync(agentDir, { recursive: true, force: true });
          rmSync(cwd, { recursive: true, force: true });
        },
      };
    },
    spawn: (cmd) =>
      new Promise<number>((resolveExit) => {
        const child = spawn(cmd.bin, cmd.args, { cwd: cmd.cwd, env: cmd.env, stdio: "inherit" });
        // The terminal's ^C reaches pi and this process alike: pi decides what
        // it means, and the login copy is removed once pi is gone.
        const ignore = (): void => {};
        process.on("SIGINT", ignore);
        process.on("SIGTERM", ignore);
        const done = (code: number): void => {
          process.off("SIGINT", ignore);
          process.off("SIGTERM", ignore);
          resolveExit(code);
        };
        child.on("error", (e) => {
          console.error(`could not start ${cmd.bin}: ${e.message}`);
          done(1);
        });
        child.on("close", (code) => done(code ?? 1));
      }),
  });
}
