// debug-round - a review round inside interactive pi (`qcr review --debug-pi`),
// so the round can be watched, and steered, live.
//
// The route prepares the round exactly as a normal one does (src/engine/round.ts
// prepareRound: the task files, the system prompt, the order, the env) and starts
// pi on it with this extension and the round's others. This file gives pi:
//
//   the lens tools    `lens` and `lens_wave`, from extensions/lens.ts: the lens
//                     passes are SDK sessions of THIS pi process, on its own
//                     dispatcher (D4, PiHost ownsProcess false)
//   /qcr-round        the round's start. It launches the planned discovery wave
//                     (the task files the engine wrote, pass-validate never among
//                     them) and then sends the round order as the first message,
//                     which is what the engine does at round start (rule 9). The
//                     route passes the command as pi's first message, so the round
//                     begins on its own; typing it again does nothing
//
// The main session joins the wave through `lens_wave` as on any engine route; a
// lens pass is a leaf. `debug-round.json` beside the order records when the wave
// and the order went out and how many rows have settled, for anything watching
// from outside.
//
// Not loaded by the tmux bot or by `qcr open`. VERIFY-ON-PIN: registerCommand,
// sendUserMessage and the session_shutdown event, as in extensions/inject-bridge.ts.
import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import type { ExtensionAPI, ExtensionFactory } from "@earendil-works/pi-coding-agent";
import type { DispatcherOutcome } from "../src/engine/pisdk.js";
import { CONTEXT_PACK_FILE } from "../src/contextpack.js";
import { DEBUG_STATUS_FILE } from "../src/engine/openable.js";
import { launchWave, type WaveRow } from "../src/engine/lens/wave.js";
import { planLaunch, type LaunchUnit } from "../src/engine/lens/launch-plan.js";
import { interactiveHostFor, interactiveLensBoard, type InteractiveLens } from "./lens.js";

/** The command that starts the round. */
export const DEBUG_ROUND_COMMAND = "qcr-round";

/** The env the route sets for this extension. */
export const DEBUG_ORDER_ENV = "QCR_DEBUG_ORDER_FILE";
export const DEBUG_TASKS_ENV = "QCR_DEBUG_TASKS_DIR";

/** What the model's bash may draw from the env on a round (the same allowlist
 * as src/engine/roundsdk.ts BASH_ENV_ALLOW; tests/debug-pi.test.ts pins them equal). */
export const DEBUG_BASH_ENV_ALLOW = ["GIT_*", "QCR_*"] as const;

/** The reviewer stub's name in the round's cwd (src/hostroute.ts names it). */
const STUB_NAME = "AGENTS.override.md";

export interface DebugRoundOptions {
  lens: InteractiveLens;
  /** The round order, sent as the first message. */
  order: string;
  /** The planned wave's task dir; null when the round has none. */
  tasksDir: string | null;
  env: Readonly<Record<string, string | undefined>>;
  /** Where the round's progress is recorded. */
  statusFile: string;
  now?: () => Date;
}

export interface DebugStatus {
  version: 1;
  state: "waiting" | "started";
  started_at?: string;
  order_sent_at?: string;
  /** The planned rows the wave launched, in plan order. */
  wave: string[];
  wave_settled: number;
  /** Why the wave was not planned, if it was not. */
  wave_error?: string;
  /** What the lens host did about the HTTP dispatcher (D4): "reused" is the CLI
   * pi's own, left in place; present once the first lens pass built its host. */
  dispatcher?: DispatcherOutcome;
}

/** Merge `patch` into the status file (the host and the round write their own
 * fields to it). A file that cannot be read or written never stops the round. */
export function patchStatus(file: string, patch: Partial<DebugStatus>): void {
  try {
    let kept: Partial<DebugStatus> = {};
    try {
      kept = JSON.parse(readFileSync(file, "utf8")) as Partial<DebugStatus>;
    } catch {
      // first write
    }
    writeFileSync(file, JSON.stringify({ ...kept, ...patch }, null, 2) + "\n");
  } catch {
    // status is evidence, not state
  }
}

/** The factory: the lens tools, the command and the shutdown that ends the wave. */
export function createDebugRound(o: DebugRoundOptions): ExtensionFactory {
  return (pi: ExtensionAPI): void => {
    // the factory registers synchronously; its type allows a promise
    void o.lens.factory(pi);
    const now = o.now ?? ((): Date => new Date());
    const status: DebugStatus = { version: 1, state: "waiting", wave: [], wave_settled: 0 };
    const write = (): void => patchStatus(o.statusFile, status);
    const stop = new AbortController();
    write();
    pi.on("session_shutdown", () => {
      // The pi is going: whatever the wave still runs goes with it.
      stop.abort();
    });
    pi.registerCommand(DEBUG_ROUND_COMMAND, {
      description:
        "Start this debug round: launch the planned lens wave, then send the round order",
      handler: async (_args, ctx) => {
        if (status.state === "started") {
          ctx.ui.notify("The round has already started.", "info");
          return;
        }
        status.state = "started";
        status.started_at = now().toISOString();
        o.lens.wave.clear();
        let rows: WaveRow[] = [];
        if (o.tasksDir !== null) {
          const plan = planLaunch({ dirs: [o.tasksDir] }, { ...o.env });
          if (plan.ok) {
            const units: LaunchUnit[] = plan.units;
            rows = launchWave(o.lens.wave, o.lens.runner, units, stop.signal);
            status.wave = units.map((u) => u.agent);
          } else status.wave_error = plan.error.slice(0, 300);
        }
        for (const row of rows)
          void row.done.then(() => {
            status.wave_settled += 1;
            write();
          });
        status.order_sent_at = now().toISOString();
        write();
        ctx.ui.notify(
          rows.length > 0
            ? `Round started: ${rows.length} lenses launched (${status.wave.join(", ")}).`
            : `Round started${status.wave_error ? ` (wave not planned: ${status.wave_error})` : ""}.`,
          status.wave_error ? "warning" : "info",
        );
        pi.sendUserMessage(o.order);
      },
    });
  };
}

const activate = (pi: ExtensionAPI): void => {
  const env = process.env;
  const orderFile = env[DEBUG_ORDER_ENV];
  if (orderFile === undefined || typeof pi.registerCommand !== "function") {
    console.error(`debug-round: ${DEBUG_ORDER_ENV} is not set - no round to start.`);
    return;
  }
  const cwd = process.cwd();
  const ledger = env["QCR_LEDGER_FILE"];
  const roundDir = ledger ? dirname(ledger) : dirname(orderFile);
  /** What the lens passes carry beyond the shim's defaults: the reviewer stub the
   * cwd holds (D34, as data), the bash env allowlist and the round's context pack. */
  const readOr = (path: string): string | undefined => {
    try {
      return readFileSync(path, "utf8");
    } catch {
      return undefined;
    }
  };
  const stub = readOr(join(cwd, STUB_NAME));
  const pack = readOr(join(roundDir, CONTEXT_PACK_FILE));
  const statusFile = join(roundDir, DEBUG_STATUS_FILE);
  const makeHost = interactiveHostFor(env);
  const lens = interactiveLensBoard(
    env,
    () => cwd,
    async (dir) => {
      const host = await makeHost(dir);
      // Evidence that the lens sessions share this pi's dispatcher (D4).
      patchStatus(statusFile, { dispatcher: host.dispatcher });
      return host;
    },
    (config) => ({
      ...config,
      ...(stub !== undefined
        ? { agentsFiles: [{ path: join(cwd, STUB_NAME), content: stub }] }
        : {}),
      bashEnv: { allow: DEBUG_BASH_ENV_ALLOW },
      ...(config.cache && pack?.trim() ? { cache: { ...config.cache, pack } } : {}),
    }),
  );
  void createDebugRound({
    lens,
    order: readFileSync(orderFile, "utf8"),
    tasksDir: env[DEBUG_TASKS_ENV] ?? null,
    env,
    statusFile,
  })(pi);
};

export default activate;
