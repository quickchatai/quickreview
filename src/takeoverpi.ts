// The pane's side of a takeover (P8.13): what runs inside tmux `takeover-pr-<n>`.
//
// The daemon (src/takeover.ts) starts
//
//     node dist/src/ipc/launcher.js <launch-file> -- node dist/src/takeoverpi.js <spec-file>
//
// so this process already holds the takeover's IPC capability on fd 3 (the
// launcher claimed it). It then
//
//   1. reads the spec file the daemon wrote (0600, no secret) and removes it;
//   2. makes the pi its OWN agent dir: the owner's login BORROWED as a
//      refresh-blanked copy (D5; packages/pi-plugin/src/engine/auth.ts), never the refresher's file
//      and never a write to it, plus the model and settings files. The pi cannot
//      refresh, so it can neither rotate the grant nor hold a file the refresher
//      reads; the copy is refused when its token would expire inside the lease's
//      idle window;
//   3. runs interactive pi on the PR's REAL session JSONL (`--session`, which
//      appends: not a fork) in the production tree's root even when the JSONL's
//      header names the legacy tree (src/picwd.ts), with bash-guard (its takeover policy blocks the post
//      scripts), the read tools and bash, and no write tools;
//   4. returns pi's exit code. The tmux session ends with this process, and the
//      daemon's sweep frees the lease.
//
// The pi runs as the separate tool uid where the image has one (D32), as a debug
// round's does. The env it gets is an allowlist: no GitHub token of any name.
import { spawn } from "node:child_process";
import { chmodSync, copyFileSync, existsSync, readFileSync, unlinkSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { GITHUB_TOKEN_ENVS } from "@quickchatai/pi-quickreview/src/envstrip.js";
import { CAP_FD_INDEX } from "./ipc/capability.js";
import {
  PI_REFRESH_MARGIN_MS,
  ENGINE_AUTH_WORDS,
  copyPiAuth,
} from "@quickchatai/pi-quickreview/src/engine/auth.js";
import {
  TOOL_UMASK,
  checkToolUid,
  shareWithToolGroup,
  toolIsolation,
  toolUidEnv,
} from "@quickchatai/pi-quickreview/src/engine/tooluid.js";
import type { TakeoverSpec } from "./takeover.js";

/** The env names the pane's pi may inherit. Everything else is dropped. */
export const TAKEOVER_ENV_ALLOW: readonly string[] = [
  "PATH",
  "HOME",
  "LANG",
  "LC_ALL",
  "LC_CTYPE",
  "TZ",
  "TMPDIR",
  "TERM",
  "COLORTERM",
  "NODE_EXTRA_CA_CERTS",
  "SSL_CERT_FILE",
  "SSL_CERT_DIR",
  "HTTP_PROXY",
  "HTTPS_PROXY",
  "NO_PROXY",
  "http_proxy",
  "https_proxy",
  "no_proxy",
  "QCR_TOOL_UID",
  "QCR_TOOL_GID",
  "QCR_TOOL_UID_REQUIRED",
  "QCR_ALLOW_SHARED_TOOL_UID",
  // The capability fd's index: the launcher sets it, the post shims read it.
  "QCR_IPC_CAP_FD",
];

/** The agent-dir files the pi needs besides the login: copied, not linked. */
const AGENT_FILES = ["models.json", "settings.json"] as const;

/** Read the spec the daemon wrote and remove the file. Throws on anything that is
 * not a v1 takeover spec. */
export function readTakeoverSpec(file: string): TakeoverSpec {
  const raw = JSON.parse(readFileSync(file, "utf8")) as Partial<TakeoverSpec> | null;
  try {
    unlinkSync(file);
  } catch {
    /* removed by someone else */
  }
  if (
    !raw ||
    raw.v !== 1 ||
    typeof raw.pr !== "number" ||
    raw.session !== `takeover-pr-${raw.pr}` ||
    typeof raw.session_file !== "string" ||
    typeof raw.agent_dir !== "string" ||
    typeof raw.borrow_dir !== "string" ||
    typeof raw.model !== "string" ||
    typeof raw.cwd !== "string" ||
    typeof raw.idle_ms !== "number" ||
    !Array.isArray(raw.extensions) ||
    typeof raw.env !== "object" ||
    raw.env === null
  )
    throw new Error("not a takeover spec");
  return raw as TakeoverSpec;
}

/**
 * The pi's own agent dir: the owner's login borrowed as a refresh-blanked copy
 * (0600, refused when its token would expire inside the lease's idle window plus
 * pi's refresh margin), and the model and settings files. Nothing is written to
 * the owner's dir.
 */
export function prepareBorrowedAgent(
  spec: Pick<TakeoverSpec, "agent_dir" | "borrow_dir" | "idle_ms">,
  now?: () => number,
): { expiresAt: number | null } {
  const { expiresAt } = copyPiAuth({
    srcDir: spec.agent_dir,
    dstDir: spec.borrow_dir,
    needMs: spec.idle_ms + PI_REFRESH_MARGIN_MS,
    words: ENGINE_AUTH_WORDS,
    ...(now ? { now } : {}),
  });
  for (const name of AGENT_FILES) {
    const from = join(spec.agent_dir, name);
    if (!existsSync(from)) continue;
    const to = join(spec.borrow_dir, name);
    copyFileSync(from, to);
    chmodSync(to, 0o600);
  }
  return { expiresAt };
}

/** The entry that runs pi's CLI in its own cwd (src/picwd.ts), beside this file. */
export const PICWD_MAIN = fileURLToPath(new URL("./picwd.js", import.meta.url));

/** How a pane starts its pi: pi's own CLI through src/picwd.ts, so a session the
 * legacy bot wrote (its header names the legacy tree) still runs its tools in the
 * pane's cwd, the production tree's root, where bash-guard sanctions the scripts.
 * An explicit `piBin` (a test's or a dev's own pi) is started as given. Pure. */
export function paneLaunch(
  piArgv: string[],
  piBin?: string,
  node: string = process.execPath,
): { bin: string; argv: string[] } {
  return piBin !== undefined
    ? { bin: piBin, argv: piArgv }
    : { bin: node, argv: [PICWD_MAIN, ...piArgv] };
}

/** pi's argv for a takeover. Pure. */
export function takeoverArgv(spec: TakeoverSpec): string[] {
  return [
    // Pre-trust the cwd's project resources: the modal would stall the pane.
    "--approve",
    // pi discovers no extension or skill of its own.
    "-ne",
    "-ns",
    "--model",
    spec.model,
    // The PR's real session, written to (not forked).
    "--session",
    spec.session_file,
    "--tools",
    spec.tools,
    ...(spec.system_prompt_file ? ["--system-prompt", spec.system_prompt_file] : []),
    ...spec.extensions.flatMap((e) => ["--extension", e]),
    "--name",
    spec.session,
  ];
}

/** The env the pi is started with: the allowlisted part of the pane's env, then the
 * daemon's spec env, then the agent dir. No GitHub token of any name. */
export function takeoverEnv(
  base: Readonly<Record<string, string | undefined>>,
  spec: Pick<TakeoverSpec, "env" | "borrow_dir">,
): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  for (const name of TAKEOVER_ENV_ALLOW) if (base[name] !== undefined) env[name] = base[name];
  Object.assign(env, spec.env);
  env["PI_CODING_AGENT_DIR"] = spec.borrow_dir;
  for (const name of GITHUB_TOKEN_ENVS) delete env[name];
  return env;
}

export interface TakeoverRunDeps {
  piBin?: string;
  env?: Readonly<Record<string, string | undefined>>;
  now?: () => number;
  /** Runs pi on the terminal with the capability fd inherited; resolves its exit
   * code. Omitted: a child with the terminal's stdio. */
  run?: (cmd: {
    bin: string;
    args: string[];
    cwd: string;
    env: NodeJS.ProcessEnv;
  }) => Promise<number>;
  log?: (line: string) => void;
}

export function onTerminal(cmd: {
  bin: string;
  args: string[];
  cwd: string;
  env: NodeJS.ProcessEnv;
}): Promise<number> {
  return new Promise((resolve) => {
    // stdio[3] is the capability fd the launcher passed to this process.
    const child = spawn(cmd.bin, cmd.args, {
      cwd: cmd.cwd,
      env: cmd.env,
      stdio: ["inherit", "inherit", "inherit", CAP_FD_INDEX],
    });
    // The terminal's ^C reaches pi and this process alike; pi decides what it means.
    const ignore = (): void => {};
    const forward = (sig: NodeJS.Signals) => () => child.kill(sig);
    const relays: Array<[NodeJS.Signals, () => void]> = [
      ["SIGINT", ignore],
      ["SIGTERM", forward("SIGTERM")],
      ["SIGHUP", forward("SIGHUP")],
    ];
    for (const [sig, fn] of relays) process.on(sig, fn);
    const done = (code: number): void => {
      for (const [sig, fn] of relays) process.off(sig, fn);
      resolve(code);
    };
    child.on("error", (e) => {
      console.error(`could not start ${cmd.bin}: ${e.message}`);
      done(1);
    });
    child.on("close", (code) => done(code ?? 1));
  });
}

/** Run the takeover the spec describes; resolves pi's exit code. A login that
 * cannot be borrowed is a one-line failure and no pi: the pane ends, and the
 * daemon's sweep frees the lease. */
export async function runTakeover(specFile: string, deps: TakeoverRunDeps = {}): Promise<number> {
  const log = deps.log ?? ((line: string) => console.error(line));
  const procEnv = deps.env ?? process.env;
  let spec: TakeoverSpec;
  try {
    spec = readTakeoverSpec(specFile);
  } catch (e) {
    log(`takeover: ${(e as Error).message}`);
    return 2;
  }
  try {
    // The pi's bash runs in pi's uid: where the image asks for a separate tool uid
    // the pi is started as that uid (below); where it asked and could not arrange
    // it, there is no takeover.
    checkToolUid(procEnv, {
      what: "a takeover in pi",
      instead: "none; the image must arrange the tool uid",
      isolated: true,
    });
    prepareBorrowedAgent(spec, deps.now);
  } catch (e) {
    log(`takeover: ${(e as Error).message}`);
    return 3;
  }
  const env = takeoverEnv(procEnv, spec);
  const pi = paneLaunch(takeoverArgv(spec), deps.piBin ?? spec.pi_bin);
  const launch = toolIsolation(pi.bin, pi.argv, procEnv);
  if ("refused" in launch) {
    log(`takeover: ${launch.refused}`);
    return 3;
  }
  // The pi, as the tool uid, reads the agent dir the run uid made private, and
  // appends to the PR's JSONL, which the run uid's worker wrote. What it
  // writes stays group-writable for the worker of the next round.
  const isolated = launch.isolated;
  if (isolated) {
    shareWithToolGroup(spec.borrow_dir);
    shareWithToolGroup(dirname(spec.session_file));
    process.umask(TOOL_UMASK);
  }
  return (deps.run ?? onTerminal)({
    bin: launch.bin,
    args: launch.argv,
    cwd: spec.cwd,
    env: isolated ? toolUidEnv(env) : env,
  });
}

// Run only as the entry point, not when a test imports runTakeover.
if (process.argv[1]?.endsWith("takeoverpi.js")) {
  const file = process.argv[2];
  if (!file) {
    console.error("usage: takeoverpi <spec-file>");
    process.exit(2);
  }
  void runTakeover(file).then((code) => process.exit(code));
}
