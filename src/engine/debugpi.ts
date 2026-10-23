// The debug round: `qcr review --debug-pi` runs a review round inside pi's own
// interactive UI, so the person can watch it live (and steer it).
//
// It is the engine's round with a different host for the main session. The round
// is prepared as any round is (round.ts prepareRound: task files, system prompt,
// order, env, session dir), then pi is started on the terminal with
//
//   - the extensions of a round, our lens tools included, through
//     extensions/debug-round.ts: lens passes are SDK sessions of that pi process,
//     which reuse pi's own HTTP dispatcher and never install a second
//   - `/qcr-round` as its first message, a command of that extension: it launches
//     the planned discovery wave and then sends the order, which is what the
//     engine does at round start (rule 9, the engine launches the planned wave)
//   - the main session persisted under the round's `session/`, and the lens
//     passes under `lens-sessions/`, so the round opens again later (`qcr open`)
//
// When pi exits the round is read as any round is (round.ts settleRound). Pi in
// interactive mode prints no event stream, so the usage and stage files are
// rebuilt from the session JSONL it wrote; lens spend comes from the lens ledger.
//
// The model still has no GitHub credential and no posting tool: pi gets the round's
// env, which carries no token, and the extension set below.
import { spawn } from "node:child_process";
import { readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { GITHUB_TOKEN_ENVS } from "@quickchatai/pi-quickreview/src/envstrip.js";
import { piCliPath } from "../picli.js";
import {
  DEBUG_STATUS_FILE,
  mainSessionOf,
} from "@quickchatai/pi-quickreview/src/engine/openable.js";
import {
  checkToolUid,
  shareWithToolGroup,
  toolIsolation,
  toolUidEnv,
} from "@quickchatai/pi-quickreview/src/engine/tooluid.js";
import {
  prepareRound,
  settleRound,
  type PreparedRound,
  type RoundResult,
  type RoundSpec,
} from "@quickchatai/pi-quickreview/src/engine/round.js";
import type { PiRun } from "@quickchatai/pi-quickreview/src/engine/port.js";

/** The extensions of a debug round, by path under the production tree: the
 * round's own set with the debug extension (which carries the lens tools) in
 * the lens tool's place. The env shims are the app's (`extensions/cli/`);
 * `cluster_findings` is the review core's own extension. Nothing here posts. */
export const DEBUG_ROUND_EXTENSIONS = [
  "extensions/cli/bash-guard.ts",
  "extensions/cli/ledger-pin.ts",
  "extensions/cli/debug-round.ts",
  "packages/pi-plugin/extensions/finding-clusters.ts",
] as const;

/** pi's first message: the extension command that starts the round. */
export const DEBUG_START_MESSAGE = "/qcr-round";

/** pi's argv for a debug round. Pure. */
export function debugArgv(o: {
  root: string;
  model: string;
  sysPath: string;
  sessionDir: string;
  sessionName: string;
}): string[] {
  return [
    // Host isolation as the round has it: pi discovers no extension or skill of its
    // own. `-nc` is absent: the cwd's context file is the reviewer stub.
    "--approve",
    "-ne",
    "-ns",
    "--model",
    o.model,
    "--system-prompt",
    o.sysPath,
    "--session-dir",
    o.sessionDir,
    ...DEBUG_ROUND_EXTENSIONS.flatMap((e) => ["--extension", join(o.root, e)]),
    "--name",
    o.sessionName,
    DEBUG_START_MESSAGE,
  ];
}

/** The env a debug round's pi is started with: the person's terminal env without
 * any GitHub token, then the round's env, then the names the debug extension reads. */
export function debugEnv(
  base: Readonly<Record<string, string | undefined>>,
  prep: Pick<PreparedRound, "env">,
  files: { order: string; tasksDir: string },
): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...base };
  for (const k of GITHUB_TOKEN_ENVS) delete env[k];
  return {
    ...env,
    ...prep.env,
    QCR_DEBUG_ORDER_FILE: files.order,
    QCR_DEBUG_TASKS_DIR: files.tasksDir,
  };
}

/** The event stream a `pi --mode json` run would have written, rebuilt from the
 * session JSONL: its header, then a `message_end` per message. That is what
 * usage, stages and the price are read from. */
export function eventsFromSession(file: string): string[] {
  const out: string[] = [];
  for (const line of readFileSync(file, "utf8").split("\n")) {
    if (!line.trim()) continue;
    let entry: { type?: unknown; message?: unknown };
    try {
      entry = JSON.parse(line) as typeof entry;
    } catch {
      continue;
    }
    if (entry.type === "session") out.push(line);
    else if (entry.type === "message" && entry.message !== undefined)
      out.push(JSON.stringify({ type: "message_end", message: entry.message }));
  }
  return out;
}

export interface DebugRoundDeps {
  /** The pi binary. Omitted: the pinned pi's own CLI (src/picli.ts); the
   * release image has no `pi` on the PATH. */
  piBin?: string;
  /** The environment pi inherits. Omitted: `process.env`. */
  env?: Readonly<Record<string, string | undefined>>;
  /** Runs pi on the terminal; resolves its exit code. Omitted: a child with
   * the terminal's stdio. */
  run?: (cmd: {
    bin: string;
    args: string[];
    cwd: string;
    env: NodeJS.ProcessEnv;
  }) => Promise<number>;
}

function onTerminal(cmd: {
  bin: string;
  args: string[];
  cwd: string;
  env: NodeJS.ProcessEnv;
}): Promise<number> {
  return new Promise((resolve) => {
    const child = spawn(cmd.bin, cmd.args, { cwd: cmd.cwd, env: cmd.env, stdio: "inherit" });
    // The terminal's ^C reaches pi and this process alike; pi decides what it means.
    const ignore = (): void => {};
    process.on("SIGINT", ignore);
    process.on("SIGTERM", ignore);
    const done = (code: number): void => {
      process.off("SIGINT", ignore);
      process.off("SIGTERM", ignore);
      resolve(code);
    };
    child.on("error", (e) => {
      console.error(`could not start ${cmd.bin}: ${e.message}`);
      done(1);
    });
    child.on("close", (code) => done(code ?? 1));
  });
}

/** Run one review round inside interactive pi. Resolves when pi exits, with the
 * round read from what it left in `outDir`. A round the person left early has no
 * outcome (`error` says what was missing); it is not a failure of the route. */
export async function runDebugRound(i: RoundSpec, deps: DebugRoundDeps = {}): Promise<RoundResult> {
  const log = i.log ?? (() => {});
  const label = i.label ?? `${i.target.repo}#${i.target.number}`;
  // pi's own bash runs in pi's uid: where the image asks for a separate tool uid
  // pi is started as that uid (below), and where it asked and could not arrange
  // it, there is no round.
  const procEnv = deps.env ?? process.env;
  checkToolUid(procEnv, {
    what: "a debug round in pi",
    instead: "run the review without --debug-pi",
    isolated: true,
  });
  const prep = prepareRound(i, { plannedWave: true });
  try {
    for (const f of [prep.events, prep.stderr]) writeFileSync(f, "");
    // an earlier attempt's progress record is not this round's
    rmSync(join(i.outDir, DEBUG_STATUS_FILE), { force: true });
    log(`review: ${label} - debug round in pi, lenses ${prep.prompts.plannedLenses.join(" ")}`);
    const args = debugArgv({
      root: i.root,
      model: i.cfg.models.conversation,
      sysPath: prep.sysPath,
      sessionDir: prep.sessionDir,
      sessionName: prep.sessionName,
    });
    const env = debugEnv(deps.env ?? process.env, prep, {
      order: join(i.outDir, "round-order.md"),
      tasksDir: join(i.outDir, "tasks"),
    });
    // The whole pi runs as the tool uid, as the process route's did: its bash,
    // and the lens sessions of its extension, get no capability and cannot read
    // this process.
    const launch = toolIsolation(deps.piBin ?? piCliPath(), args, procEnv);
    if ("refused" in launch) throw new Error(`a debug round in pi: ${launch.refused}`);
    // That pi reads the run's agent dir (its login copy, models, lens agents),
    // which the run uid made private.
    if (launch.isolated) shareWithToolGroup(i.agentDir);
    const code = await (deps.run ?? onTerminal)({
      bin: launch.bin,
      args: launch.argv,
      cwd: i.cwd ?? i.root,
      // as the tool uid, git needs the run uid's repositories named safe
      env: launch.isolated ? toolUidEnv(env) : env,
    });
    // Interactive pi prints no event stream: usage, stages and the price are read
    // from the session it kept.
    const kept = mainSessionOf(i.outDir);
    if (kept !== null) writeFileSync(prep.events, eventsFromSession(kept).join("\n") + "\n");
    const piRun: PiRun = { code, timedOut: false, streamError: null };
    const result: RoundResult = {
      prompts: prep.prompts,
      plannedLenses: prep.prompts.plannedLenses,
      piRun,
      continued: false,
      capped: false,
      warnings: [],
      costUsd: null,
      review: null,
    };
    if (kept === null) result.error = "pi ended before the round's session wrote anything";
    return settleRound(i, prep, result, piRun, 0);
  } finally {
    if (prep.ownTmp) rmSync(prep.tmpDir, { recursive: true, force: true });
  }
}
