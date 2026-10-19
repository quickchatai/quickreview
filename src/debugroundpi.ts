// The pane's side of a bot debug round (P8.13b): what runs inside tmux `debug-pr-<n>`.
//
// The daemon (src/debuground.ts) starts
//
//     node dist/src/ipc/launcher.js <launch-file> -- node dist/src/debugroundpi.js <spec-file>
//
// so this process already holds the round command's IPC capability on fd 3 (the
// launcher claimed the launch file and unlinked it). It then
//
//   1. reads the spec file the daemon wrote (0600, no secret) and removes it;
//   2. makes the pi its OWN agent dir: the owner's login BORROWED as a
//      refresh-blanked copy (D5; src/engine/auth.ts, the takeover's copy), never the
//      refresher's file and never a write to it, plus the model and settings files
//      and a link to the built lens agents. The pi cannot refresh;
//   3. writes the round order the extension sends as the first message: the round's
//      saved order (verified against the sha256 recorded at dispatch), the engine's
//      lens section, and the command's marker, exactly as a worker builds it;
//   4. runs interactive pi on the PR's REAL session JSONL (`--session`, which
//      appends: not a fork) with the round's extensions, `/qcr-round` as its first
//      message, and the capability fd inherited. The cwd's own context files are off
//      and the reviewer stub (D34) is appended, so the dev instructions of the
//      production tree never reach a reviewer;
//   5. returns pi's exit code. The tmux session ends with this process, and the
//      daemon's sweep settles the round and frees the lease.
//
// The pi's bash hands the capability fd to each command it runs (the extension's
// bash tool), so the post shims read it for every post and send the daemon the
// P8.7 request: the pi holds no GitHub credential and the post goes through the
// one gate. The env it gets is an allowlist plus the round's own: no GitHub token of
// any name. The pi runs as the separate tool uid where the image has one (D32).
import { spawn } from "node:child_process";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  readFileSync,
  symlinkSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { CAP_FD_INDEX } from "./ipc/capability.js";
import { checkToolUid, shareWithToolGroup, toolIsolation } from "./engine/tooluid.js";
import { planLaunch } from "./engine/lens/launch-plan.js";
import { engineLensSection } from "./engine/lens/section.js";
import { CONTEXT_PACK_FILE } from "./contextpack.js";
import { verifiedPayload } from "./session-command-payload.js";
import { DEBUG_STATUS_NAME, type DebugRoundSpec } from "./debuground.js";
import { prepareBorrowedAgent, takeoverEnv } from "./takeoverpi.js";

/** pi's first message: the extension command that starts the round. */
export const DEBUG_START_MESSAGE = "/qcr-round";

/** The order file's name inside the borrowed agent dir. */
export const DEBUG_ORDER_NAME = "round-order.md";

/** Read the spec the daemon wrote and remove the file. Throws on anything that is
 * not a v1 debug-round spec. */
export function readDebugSpec(file: string): DebugRoundSpec {
  const raw = JSON.parse(readFileSync(file, "utf8")) as Partial<DebugRoundSpec> | null;
  try {
    unlinkSync(file);
  } catch {
    /* removed by someone else */
  }
  if (
    !raw ||
    raw.v !== 1 ||
    typeof raw.pr !== "number" ||
    raw.session !== `debug-pr-${raw.pr}` ||
    typeof raw.command_id !== "string" ||
    typeof raw.agent_dir !== "string" ||
    typeof raw.borrow_dir !== "string" ||
    typeof raw.session_dir !== "string" ||
    typeof raw.model !== "string" ||
    typeof raw.cwd !== "string" ||
    typeof raw.system_prompt_file !== "string" ||
    typeof raw.payload_path !== "string" ||
    typeof raw.payload_sha256 !== "string" ||
    typeof raw.marker !== "string" ||
    typeof raw.passes_dir !== "string" ||
    typeof raw.lens_dir !== "string" ||
    typeof raw.idle_ms !== "number" ||
    !Array.isArray(raw.extensions) ||
    typeof raw.env !== "object" ||
    raw.env === null
  )
    throw new Error("not a debug-round spec");
  return raw as DebugRoundSpec;
}

/** The round order as a worker sends it: the saved order, the engine lens section
 * (the wave the extension's command starts is named in it), and the marker. */
export function debugRoundOrder(spec: DebugRoundSpec, path = process.env["PATH"]): string {
  const payload = verifiedPayload(
    { payload_path: spec.payload_path, payload_sha256: spec.payload_sha256 },
    "the round's saved order",
  );
  if (!payload.ok) throw new Error(payload.why);
  const tasks = join(spec.passes_dir, "tasks");
  let wave: { dir: string; agents: string[] } | null = null;
  if (spec.planned_wave && existsSync(tasks)) {
    const plan = planLaunch(
      { dirs: [spec.passes_dir] },
      { QCR_SANDBOX_ROOT: spec.root, QCR_PR: String(spec.pr), PATH: path },
    );
    if (plan.ok && plan.units.length > 0)
      wave = { dir: tasks, agents: plan.units.map((u) => u.agent) };
  }
  const section = engineLensSection(tasks, wave);
  const order = `${payload.payload.toString("utf8").trimEnd()}\n\n${section}`;
  return `${order}${order.endsWith("\n") ? "" : "\n"}\n${spec.marker}\n`;
}

/** Prepare the pi's own agent dir: the blanked login copy and models/settings (the
 * takeover's borrow), the built lens agents linked, the order file, and the lens
 * dir. Returns the order file. Nothing is written to the owner's dir. */
export function prepareDebugAgent(spec: DebugRoundSpec, now?: () => number): { orderFile: string } {
  prepareBorrowedAgent(spec, now);
  // The lens passes read the built agents from the pi's agent dir.
  const agents = join(spec.agent_dir, "agents");
  const link = join(spec.borrow_dir, "agents");
  if (existsSync(agents) && !existsSync(link)) symlinkSync(agents, link);
  const orderFile = join(spec.borrow_dir, DEBUG_ORDER_NAME);
  writeFileSync(orderFile, debugRoundOrder(spec), { mode: 0o600 });
  chmodSync(orderFile, 0o600);
  mkdirSync(spec.lens_dir, { recursive: true });
  return { orderFile };
}

/** pi's argv for a bot debug round. Pure. */
export function debugRoundArgv(spec: DebugRoundSpec): string[] {
  return [
    // Pre-trust the cwd's project resources: the modal would stall the pane.
    "--approve",
    // pi discovers no extension or skill of its own, and reads none of the production
    // tree's context files: the reviewer stub (D34) takes their place.
    "-ne",
    "-ns",
    "-nc",
    "--model",
    spec.model,
    "--system-prompt",
    spec.system_prompt_file,
    ...(spec.stub_file ? ["--append-system-prompt", spec.stub_file] : []),
    // The PR's real session, written to (not forked); a PR with none gets one born.
    ...(spec.session_file ? ["--session", spec.session_file] : ["--session-dir", spec.session_dir]),
    ...spec.extensions.flatMap((e) => ["--extension", e]),
    "--name",
    spec.session,
    DEBUG_START_MESSAGE,
  ];
}

/** The env the pi is started with: the takeover's (the allowlisted part of the
 * pane's env, the daemon's spec env, the agent dir, no GitHub token), then the names
 * the debug extension reads. */
export function debugRoundEnv(
  base: Readonly<Record<string, string | undefined>>,
  spec: DebugRoundSpec,
): NodeJS.ProcessEnv {
  const env = takeoverEnv(base, spec);
  env["QCR_DEBUG_ORDER_FILE"] = join(spec.borrow_dir, DEBUG_ORDER_NAME);
  env["QCR_DEBUG_STATUS_FILE"] = join(spec.borrow_dir, DEBUG_STATUS_NAME);
  env["QCR_DEBUG_LENS_DIR"] = spec.lens_dir;
  env["QCR_DEBUG_PACK_FILE"] = join(spec.passes_dir, CONTEXT_PACK_FILE);
  if (spec.stub_file) env["QCR_DEBUG_STUB_FILE"] = spec.stub_file;
  if (spec.planned_wave) env["QCR_DEBUG_TASKS_DIR"] = spec.passes_dir;
  else delete env["QCR_DEBUG_TASKS_DIR"];
  return env;
}

export interface DebugPaneDeps {
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

function onTerminal(cmd: {
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

/** Run the debug round the spec describes; resolves pi's exit code. A login that
 * cannot be borrowed, or an order that does not verify, is a one-line failure and
 * no pi: the pane ends, and the daemon's sweep hands the round to a worker. */
export async function runDebugRoundPane(
  specFile: string,
  deps: DebugPaneDeps = {},
): Promise<number> {
  const log = deps.log ?? ((line: string) => console.error(line));
  const procEnv = deps.env ?? process.env;
  let spec: DebugRoundSpec;
  try {
    spec = readDebugSpec(specFile);
  } catch (e) {
    log(`debug round: ${(e as Error).message}`);
    return 2;
  }
  try {
    // The pi's bash runs in pi's uid: where the image asks for a separate tool uid
    // the pi is started as that uid (below); where it asked and could not arrange it,
    // there is no debug round.
    checkToolUid(procEnv, {
      what: "a debug round in pi",
      instead: "none; the image must arrange the tool uid",
      isolated: true,
    });
    prepareDebugAgent(spec, deps.now);
  } catch (e) {
    log(`debug round: ${(e as Error).message}`);
    return 3;
  }
  const env = debugRoundEnv(procEnv, spec);
  const launch = toolIsolation(deps.piBin ?? spec.pi_bin ?? "pi", debugRoundArgv(spec), procEnv);
  if ("refused" in launch) {
    log(`debug round: ${launch.refused}`);
    return 3;
  }
  // The pi, as the tool uid, reads the agent dir the run uid made private, and writes
  // the round's lens files.
  if (launch.bin === "setpriv") {
    shareWithToolGroup(spec.borrow_dir);
    shareWithToolGroup(spec.lens_dir);
  }
  return (deps.run ?? onTerminal)({
    bin: launch.bin,
    args: launch.argv,
    cwd: spec.cwd,
    env,
  });
}

// Run only as the entry point, not when a test imports runDebugRoundPane.
if (process.argv[1]?.endsWith("debugroundpi.js")) {
  const file = process.argv[2];
  if (!file) {
    console.error("usage: debugroundpi <spec-file>");
    process.exit(2);
  }
  void runDebugRoundPane(file).then((code) => process.exit(code));
}
