// `qcr scan` — the scan's verbs (src/setup/scanverbs.ts, the same ones the
// companion's scan tools in extensions/setup-scan.ts call) as a scriptable
// CLI verb, assembled over this machine's state home and config. Every
// subcommand renders twice: the human default, worded for the CLI, and a
// `--json` object on one line for scripts.
//
// What is the app's here, around the verbs: where a run is driven. `start`
// (and `stage2 start`) launches a detached `qcr scan … --foreground` driver,
// waits until it has recorded the run (or refused), and returns. With
// `[scan] sandbox = "docker"` (the default) the driver runs in a throwaway
// container from the scan sandbox image (src/scanbox.ts); with `"host"` it is
// a detached process on this machine. Either way its records are the state
// home's, so every other subcommand reads them here, on the host. The driver
// runs the cases, answers the stop channel (the TUI's `[8] scan` stop and
// `qcr scan stop` alike), and holds the driver lease (src/setup/scanlease.ts)
// so that the companion and other drivers read its run as running and start
// nothing beside it. `--foreground` drives in the calling process instead,
// to the run's end. `status --wait` blocks until the recorded run is no longer
// driven by anyone.
//
// Host-side beside them: `units` — the setup belt's unit-cut tools
// (extensions/setup.ts) — and the sandbox's `login`, `doctor` and `rebuild`.
//
// The model. A scan runs on one model, the route (`scanRoutePort`): what pi
// has a credential for, under `--model`, the config's `[models] model` and a
// remembered choice, resolved the way `qcr review` resolves its own
// (src/engine/caserunner-sdk.ts `scanRoute`). It is resolved where the login
// is:
//   - a driver (a foreground start: here, in the detached host process, or in
//     the scan container) resolves it in its own process, once, before the
//     run is recorded, and hands it to every case's host as fixed;
//   - a plan (`preview`, the two proposals) for a host scan resolves it here;
//   - a plan for a sandboxed scan asks the scan image, over the companion's
//     login read-only (src/scanbox.ts `askOnLogin`, running that same
//     function there): the host cannot read that login.
// The driver's route and its cases are joined in one place (`scanRouteJoin`):
// the port writes what a driver resolved, and the cases' getter reads it.
// The plan's key covers the route, so a start whose driver resolves another
// model than the plan showed is refused there. One such start is foreseen: a
// `--foreground` start typed on the host while `[scan] sandbox = "docker"`
// drives the scan here, on this machine's login, though its plan was read off
// the companion's. The port asks the sandbox too and, when the two models
// differ, says so and names the two ways out (`foregroundMismatch`), where
// the runner could only have said that the plan changed. `--model` is also the whole
// scan's model: the config the run reads keeps no tier or lens on a model of
// its own (src/setup/scanbuild.ts `SCAN_MODEL_ENV`).
import { spawn, spawnSync, type SpawnOptions } from "node:child_process";
import { closeSync, existsSync, openSync } from "node:fs";
import { join } from "node:path";
import { loadConfig, sandboxRoot, type ScanSandboxConfig } from "./config.js";
import { stateHome } from "./install.js";
import { oneShotConfigFile } from "./homes.js";
import { mountedCheckout, scanEnv } from "./scanenv.js";
import {
  IN_SANDBOX_ENV,
  SCANBOX,
  SCANBOX_SCRATCH,
  STARTED_FILE_ENV,
  askOnLogin,
  renderDoctor,
  writeStartedFile,
  type DoctorReport,
  type DoctorRoute,
} from "./scanbox.js";
import { SCAN_MODEL_ENV, loadScanConfig } from "./setup/scanbuild.js";
import type { DockerRunner } from "./tui/companion.js";
import type { ScanRouteAnswer } from "./engine/caserunner-sdk.js";
import { SCAN_AUTH_SRC_ENV, scanProviders } from "@quickchatai/pi-quickreview/src/engine/auth.js";
import {
  credentialWords,
  type ModelRoute,
  type RouteInput,
} from "@quickchatai/pi-quickreview/src/modelroute.js";
import {
  isPinned,
  splitModelSpec,
  tierSpec,
} from "@quickchatai/pi-quickreview/src/reviewconfig.js";
import { PASS_TIER_ORDER, type PassTier } from "@quickchatai/pi-quickreview/src/types.js";
import type { ScanRouted } from "@quickchatai/pi-quickreview/src/scan/scanrun.js";
import {
  DETACH_TIMEOUT_MS,
  DRIVER_LOG,
  DRIVER_LOG_MAX,
  prepareDriverLog,
} from "./scandriverlog.js";
import type { CloseFixedResult, ScanTriage } from "./setup/triage.js";
import type { ScanRunner, ScanRun } from "./setup/scanrun.js";
import type { UnitCutPort } from "@quickchatai/pi-quickreview/src/scan/unitcutstore.js";
import {
  runScanVerb,
  usage,
  type DetachOutcome,
  type ScanVerbDeps,
} from "@quickchatai/pi-quickreview/src/scan/scanverbs.js";
import {
  SCAN_SCHEMA_VERSION,
  withSchemaVersion,
} from "@quickchatai/pi-quickreview/src/contract.js";

// The verbs themselves, and their JSON shapes, are src/setup/scanverbs.ts's.
export {
  POLL_MS,
  SCAN_USAGE,
  findingJson,
  parseScanArgs,
  runJson,
  type DetachOutcome,
  type FindingJson,
  type FindingsQuery,
  type ScanCommand,
} from "@quickchatai/pi-quickreview/src/scan/scanverbs.js";
export type { UnitCutPort };

/** What `qcr scan` runs over: the verbs' ports, with the app's triage, its
 * tickets and the scan sandbox's doctor report. */
export interface ScanCliDeps extends Omit<
  ScanVerbDeps,
  "triage" | "afterMatch" | "doctor" | "driverLog"
> {
  triage: ScanTriage | null;
  /** After a match answer: close the tickets of the promoted findings it fixed. */
  afterMatch: (() => Promise<CloseFixedResult>) | null;
  /** `doctor`: the sandbox's readiness report. */
  doctor?: () => Promise<DoctorReport>;
}

/** Run one `qcr scan` subcommand; resolves its exit code. */
export function runScanCli(
  rest: readonly string[],
  json: boolean,
  deps: ScanCliDeps,
): Promise<number> {
  const { doctor, ...rest2 } = deps;
  return runScanVerb(rest, json, {
    ...rest2,
    driverLog: join(deps.home, DRIVER_LOG),
    ...(doctor
      ? {
          doctor: async () => {
            const r = await doctor();
            return {
              ok: r.ok,
              human: renderDoctor(r),
              data: r as unknown as Record<string, unknown>,
            };
          },
        }
      : {}),
  });
}

export { DETACH_TIMEOUT_MS, DRIVER_LOG, DRIVER_LOG_MAX };

/** The SDK leaf host's private agent dir, under the state home: its own models
 * list lives here, never in the operator's pi home. */
const SCAN_SDK_AGENT_DIR = "scan/sdk-agent";

/** `--model`'s value among a subcommand's arguments, as written, or
 * undefined. The verbs parse the flag themselves and refuse a misuse of it;
 * this only reads it early, for the config the scan is assembled over. */
export function modelFlagOf(rest: readonly string[]): string | undefined {
  const at = rest.lastIndexOf("--model");
  const v = at < 0 ? undefined : rest[at + 1]?.trim();
  return v === undefined || v === "" || v.startsWith("--") ? undefined : v;
}

// ---- the scan's route ------------------------------------------------------------

/**
 * Run in the scan image by `askOnLogin`: the scan's route over the login the
 * container is given, by the function the driver inside resolves it with.
 * Its arguments: the scratch dir, then the pin's text and where it is from
 * (both empty with no pin), then the config that holds the pin. Prints one
 * JSON line: a `ScanRouteAnswer`, or `{ error }` when the login cannot be read.
 */
export const SCAN_ROUTE_SCRIPT =
  `const [tmpDir, text, from, configPath] = process.argv.slice(1);` +
  `let answer;` +
  `try {` +
  `const { scanRoute } = await import("${SCANBOX.app}/dist/src/engine/caserunner-sdk.js");` +
  `answer = await scanRoute({ env: process.env, tmpDir,` +
  ` ...(text ? { pin: { text, from: from === "config" ? "config" : "flag" } } : {}),` +
  ` configPath: configPath || null });` +
  `} catch (e) { answer = { error: e instanceof Error ? e.message : String(e) }; }` +
  `console.log(JSON.stringify(answer));`;

/** The image's answer read as a route answer, or why it is not one. */
export function readRouteAnswer(
  answer: unknown,
): { ok: true; answer: ScanRouteAnswer } | { ok: false; error: string } {
  const a = answer as { error?: unknown; result?: { ok?: unknown } & Record<string, unknown> };
  if (typeof a !== "object" || a === null)
    return { ok: false, error: "the scan image did not answer with a route" };
  if (typeof a.error === "string") return { ok: false, error: a.error };
  const r = a.result;
  const route = r?.["route"] as Partial<ModelRoute> | undefined;
  const refusal = r?.["refusal"] as { code?: unknown } | undefined;
  const known =
    r?.ok === true
      ? typeof route?.spec === "string" &&
        typeof route.provider === "string" &&
        Array.isArray(route.alternatives) &&
        Array.isArray(route.notices)
      : r?.ok === false && typeof refusal?.code === "string";
  return known
    ? { ok: true, answer: answer as ScanRouteAnswer }
    : { ok: false, error: "the scan image did not answer with a route" };
}

/** What the scan's route is resolved over in one `qcr scan` process. */
export interface ScanRouteWorld {
  /** The env the scan is assembled under: its login source, and its `--model`. */
  env: NodeJS.ProcessEnv;
  /** Where pi looks for a provider's key when the route is resolved in this
   * process: `env` under the model env of the install's secrets dir.
   * Omitted: `env`. */
  authEnv?: NodeJS.ProcessEnv;
  root: string;
  /** The state home: the route host's scratch dir is under it. */
  home: string;
  /** Where a run this process plans would be driven when not here: the scan
   * sandbox, asked through its image. Null: this process's own login decides
   * (a host scan, or the driver inside a sandbox). */
  sandbox: {
    docker: DockerRunner;
    config: Pick<ScanSandboxConfig, "image" | "pihome_volume">;
    stamp: () => string;
  } | null;
  /** Ask the person at the terminal which provider. Null: nobody to ask. */
  choose: ((question: string, rows: readonly string[]) => Promise<number | null>) | null;
  /** The route a driver resolved, kept for the cases it then runs. */
  resolved: { route?: ModelRoute };
  /** The route in this process (default `scanRoute`, loaded on first use). */
  resolveHere?: (o: {
    env: NodeJS.ProcessEnv;
    authEnv?: NodeJS.ProcessEnv;
    tmpDir: string;
    pin?: RouteInput["pin"];
    configPath: string | null;
    choose: ScanRouteWorld["choose"];
    say: (line: string) => void;
  }) => Promise<ScanRouteAnswer>;
  say?: (line: string) => void;
}

/** How a sandboxed scan's login is signed in: the companion's pi, which is
 * the only login the scan sandbox reads. */
const SANDBOX_LOGIN = "qcr scan login";

/**
 * The verbs' route port over `w` (the header's rules): the pin is `--model`,
 * else the config's own; a driver's route is resolved here and kept for its
 * cases; a plan's is resolved where the run would be driven. Beside the route
 * it answers with each tier's spec as it will run, and says what `--model`
 * replaced and when stage 1's tier is not on the route at all. An answer read
 * from the companion's login (the scan image's, or a driver's inside the
 * sandbox) names that login's own way in.
 */
export function scanRoutePort(w: ScanRouteWorld): NonNullable<ScanCliDeps["route"]> {
  const say = w.say ?? ((l: string) => console.error(l));
  return async (ask) => {
    // The config the run reads: under `--model`, with no pin below it. One
    // that cannot be read names no pin; the plan refuses for it on its own.
    const loaded = loadScanConfig(w.root, w.env);
    const cfg = loaded.ok ? loaded.cfg : null;
    let configPath: string | null = null;
    try {
      configPath = oneShotConfigFile({ root: w.root, env: w.env }).path;
    } catch {
      // No config to name.
    }
    const pin: RouteInput["pin"] | undefined =
      ask.pin !== undefined
        ? { text: ask.pin, from: "flag" }
        : cfg !== null && isPinned(cfg.models.model)
          ? { text: cfg.models.model, from: "config" }
          : undefined;
    const notes: string[] = [];
    if (ask.pin !== undefined && loaded.ok && (loaded.replaced ?? 0) > 0)
      notes.push(
        `--model replaces ${loaded.replaced} pinned tier and lens model${loaded.replaced === 1 ? "" : "s"} for this run`,
      );
    const routed = (answer: ScanRouteAnswer, sandboxed: boolean): ScanRouted => {
      if (!answer.result.ok)
        return {
          result: answer.result,
          surface: "app",
          ...(answer.refusal !== undefined ? { refusal: answer.refusal } : {}),
          // `qcr login` signs this machine's pi in, which a sandboxed scan
          // never reads.
          ...(sandboxed ? { login: SANDBOX_LOGIN } : {}),
          notes,
        };
      const route = answer.result.route;
      if (cfg === null) return { result: answer.result, surface: "app", notes };
      const tiers = Object.fromEntries(
        PASS_TIER_ORDER.map((tier) => [tier, tierSpec(route, cfg, tier)]),
      ) as Record<PassTier, string>;
      // A tier the config pins to a model of its own does not run on the
      // route: said where stage 1's does, since the model line names another.
      const own = cfg.models.tiers[cfg.scan.tier];
      if (isPinned(own) && splitModelSpec(own).model !== route.spec)
        notes.push(
          `stage 1 runs on ${own}: [models.tiers] ${cfg.scan.tier} pins it (--model puts the whole scan on one model)`,
        );
      return { result: answer.result, surface: "app", tiers, notes };
    };
    const box = ask.run ? null : w.sandbox;
    if (box !== null) {
      const asked = await askOnLogin(box.docker, {
        sandbox: box.config,
        stamp: box.stamp,
        script: SCAN_ROUTE_SCRIPT,
        args: [SCANBOX_SCRATCH, pin?.text ?? "", pin?.from ?? "", configPath ?? ""],
      });
      const read = asked.ok ? readRouteAnswer(asked.answer) : asked;
      // The sandbox did not say: the plan is shown with its model unknown.
      if (!read.ok)
        return {
          result: null,
          surface: "app",
          refusal: `the scan sandbox could not be asked: ${read.error}`,
          notes,
        };
      return routed(read.answer, true);
    }
    const resolveHere =
      w.resolveHere ?? (async (o) => (await import("./engine/caserunner-sdk.js")).scanRoute(o));
    const answer = await resolveHere({
      env: w.env,
      ...(w.authEnv !== undefined ? { authEnv: w.authEnv } : {}),
      tmpDir: join(w.home, "tmp"),
      ...(pin !== undefined ? { pin } : {}),
      configPath,
      choose: ask.ask ? w.choose : null,
      say,
    });
    // A driver here, though a plan of this scan is read off the sandbox's
    // login: the two may run on different models, and the key covers the
    // plan's. Said before anything is recorded, with what to do.
    if (ask.run && w.sandbox !== null && answer.result.ok) {
      const here = answer.result.route;
      const asked = await askOnLogin(w.sandbox.docker, {
        sandbox: w.sandbox.config,
        stamp: w.sandbox.stamp,
        script: SCAN_ROUTE_SCRIPT,
        args: [SCANBOX_SCRATCH, pin?.text ?? "", pin?.from ?? "", configPath ?? ""],
      });
      const read = asked.ok ? readRouteAnswer(asked.answer) : asked;
      if (read.ok && read.answer.result.ok) {
        const there = read.answer.result.route;
        if (there.spec !== here.spec) throw new Error(foregroundMismatch(here, there));
      } else {
        // The sandbox did not say: the start goes on, and a refusal for a
        // changed plan, if one follows, has its reason on the line above it.
        say(
          `note: this start drives the scan here, on this machine's pi login (${here.spec}). ` +
            "A plan of a sandboxed scan is keyed on the companion's login: if the start is " +
            "refused as a changed plan, preview and start with --sandbox host.",
        );
      }
    }
    // A driver's route is the one its cases are handed.
    if (ask.run && answer.result.ok) w.resolved.route = answer.result.route;
    return routed(answer, Boolean(w.env[SCAN_AUTH_SRC_ENV]?.trim()));
  };
}

/**
 * Why a `--foreground` start on the host is not the scan its plan showed, and
 * what to do: the plan of a sandboxed scan is made over the companion's
 * login, a start driven here runs on this machine's, and the two resolve to
 * different models. Thrown by the port, so the verb refuses before a run is
 * recorded.
 */
export function foregroundMismatch(
  here: Pick<ModelRoute, "spec" | "providerName" | "credential">,
  there: Pick<ModelRoute, "spec" | "providerName" | "credential">,
): string {
  const words = (r: Pick<ModelRoute, "spec" | "providerName" | "credential">): string =>
    `${r.spec} (${r.providerName}, ${credentialWords(r.credential)})`;
  return (
    `--foreground drives the scan in this process, on this machine's pi login, where it runs on ${words(here)}. ` +
    `The plan was made for the scan sandbox, which reads the companion's login and runs on ${words(there)}, ` +
    "and its key covers that model, so this start is not the plan you were shown. " +
    "Either start it without --foreground (it then runs in the sandbox, as planned), " +
    "or run it here from the beginning: preview with --sandbox host and start that key with --sandbox host --foreground."
  );
}

/**
 * The route as the scan doctor needs it: the model stage 1 runs on (`tier`'s
 * spec as it will run, else the route's own), and the providers the scan's
 * models are on. An unknown route, or none, is its refusal in the host's
 * words: never a model guessed from the config.
 */
export function doctorRouteOf(
  routed: ScanRouted,
  tier: string,
  models?: Parameters<typeof scanProviders>[1],
): DoctorRoute {
  const r = routed.result;
  if (r === null)
    return { ok: false, error: routed.refusal ?? "the scan's model could not be read" };
  if (!r.ok) return { ok: false, error: routed.refusal ?? `no model route (${r.refusal.code})` };
  const tiers: Readonly<Record<string, string>> = routed.tiers ?? {};
  return {
    ok: true,
    model: tiers[tier] ?? r.route.spec,
    provider: r.route.provider,
    providerName: r.route.providerName,
    credential: credentialWords(r.route.credential),
    providers: scanProviders(r.route, models),
  };
}

/** What the sandbox's ports ask of the scan's route. The port is made after
 * them (it needs their sandbox), so they read it through this record. */
interface ScanRouting {
  port?: NonNullable<ScanCliDeps["route"]>;
}

/**
 * One scan process's route, joined: the verbs' port, which writes the route a
 * driver resolved, and the getter its cases read it through (`scanSdkCases`'
 * `route`). Both sides are made here, over one record, so a driver's cases
 * cannot be handed anything but the route its start resolved. The getter
 * comes first: the cases are assembled before the port's world is known.
 */
export function scanRouteJoin(): {
  /** The route the driver resolved; nothing before it did, and for a plan. */
  route: () => ModelRoute | undefined;
  port: (w: Omit<ScanRouteWorld, "resolved">) => NonNullable<ScanCliDeps["route"]>;
} {
  const resolved: ScanRouteWorld["resolved"] = {};
  return {
    route: () => resolved.route,
    port: (w) => scanRoutePort({ ...w, resolved }),
  };
}

/** `--sandbox host|docker`, taken off any subcommand's arguments: where this
 * call runs a scan, over `[scan] sandbox`. The pi plugin's /qcr-scan never
 * comes here: it runs the plugin's own engine in its pi. */
export function takeSandboxFlag(rest: readonly string[]): {
  rest: string[];
  sandbox?: "host" | "docker";
} {
  const out: string[] = [];
  let sandbox: "host" | "docker" | undefined;
  for (let i = 0; i < rest.length; i++) {
    if (rest[i] !== "--sandbox") {
      out.push(rest[i]!);
      continue;
    }
    const v = rest[++i];
    if (v !== "host" && v !== "docker") throw usage("--sandbox is host or docker");
    if (sandbox !== undefined && sandbox !== v) throw usage("--sandbox given twice");
    sandbox = v;
  }
  return sandbox ? { rest: out, sandbox } : { rest: out };
}

// ---- assembly ------------------------------------------------------------------

// Which checkout a host-side scan reads and where its state lives: src/scanenv.ts.
export { checkoutOf, mountedCheckout, scanEnv, scanTranscriptsDir, toplevelOf } from "./scanenv.js";

/** The child the launch needs — `child_process.spawn`'s, narrowed. */
interface DriverChild {
  on(event: "message", f: (m: unknown) => void): unknown;
  on(event: "error", f: (err: Error) => void): unknown;
  on(event: "exit", f: (code: number | null) => void): unknown;
  disconnect(): void;
  unref(): void;
  kill(signal?: NodeJS.Signals): boolean;
}

/** Launch the foreground driver detached — this CLI again, under the same
 * node flags, from the app root, its output appended to the driver log
 * (rotated past `logMax`) — and resolve once it says it started (or
 * refused). A driver that exits first, or stays silent past `timeoutMs` (it
 * is then stopped), is a refusal. */
export function detachDriver(
  env: NodeJS.ProcessEnv,
  home: string,
  opts: {
    spawn?: (command: string, args: string[], options: SpawnOptions) => DriverChild;
    execPath?: string;
    execArgv?: readonly string[];
    script?: string;
    timeoutMs?: number;
    logMax?: number;
  } = {},
): ScanCliDeps["detach"] {
  const spawnFn = opts.spawn ?? ((c, a, o) => spawn(c, a, o));
  const timeoutMs = opts.timeoutMs ?? DETACH_TIMEOUT_MS;
  const logMax = opts.logMax ?? DRIVER_LOG_MAX;
  return (argv) =>
    new Promise((resolve) => {
      const prepared = prepareDriverLog(home, logMax);
      if (!prepared.ok) {
        resolve({ ok: false, errors: [prepared.error] });
        return;
      }
      const log = prepared.path;
      let fd: number;
      try {
        fd = openSync(log, "a");
      } catch (err) {
        resolve({
          ok: false,
          errors: [
            `the driver log ${log} cannot be opened: ${err instanceof Error ? err.message : String(err)}`,
          ],
        });
        return;
      }
      let child: DriverChild;
      try {
        child = spawnFn(
          opts.execPath ?? process.execPath,
          [
            ...(opts.execArgv ?? process.execArgv),
            opts.script ?? process.argv[1]!,
            "scan",
            ...argv,
            "--foreground",
            "--json",
          ],
          {
            cwd: env.QCR_ROOT?.trim() || sandboxRoot(),
            detached: true,
            stdio: ["ignore", fd, fd, "ipc"],
            env,
          },
        );
      } catch (err) {
        closeSync(fd);
        resolve({
          ok: false,
          errors: [
            `the scan driver could not start: ${err instanceof Error ? err.message : String(err)}`,
          ],
        });
        return;
      }
      closeSync(fd);
      let settled = false;
      const done = (o: DetachOutcome): void => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        try {
          child.disconnect();
        } catch {
          // Already gone.
        }
        child.unref();
        resolve(o);
      };
      const timer = setTimeout(() => {
        child.kill("SIGTERM");
        done({
          ok: false,
          errors: [
            `the scan driver did not say it started within ${Math.round(timeoutMs / 1000)}s — it was stopped; see ${log}`,
          ],
        });
      }, timeoutMs);
      child.on("message", (m: unknown) => {
        const msg = m as { kind?: string; outcome?: DetachOutcome };
        if (msg.kind === "started" && msg.outcome) done(msg.outcome);
      });
      child.on("error", (err: Error) =>
        done({ ok: false, errors: [`the scan driver could not start: ${err.message}`] }),
      );
      child.on("exit", (code: number | null) =>
        done({
          ok: false,
          errors: [`the scan driver exited (code ${code ?? "?"}) before it started — see ${log}`],
        }),
      );
    });
}

/** Tell the launching process what the start did. Never throws, and never
 * leaves an unhandled 'error' behind when that process is gone (a Ctrl-C
 * during planning): the channel is checked, and a send that fails anyway
 * reports to its callback. The run goes on regardless. */
export function sendStarted(
  proc: {
    connected?: boolean;
    send?: (msg: unknown, cb: (err: Error | null) => void) => boolean;
  },
  outcome: DetachOutcome,
): void {
  if (!proc.send || proc.connected === false) return;
  try {
    proc.send({ kind: "started", outcome }, () => {});
  } catch {
    // The channel closed between the check and the send.
  }
}

/** A foreground driver's SIGINT/SIGTERM: the first stops the run (in-flight
 * cases aborted: a pi child is killed by the case runner, an SDK leaf session
 * is aborted and disposed in this process); a second kills the driver's whole
 * process group — any pi children with it — and exits. */
export function foregroundSignals(
  scan: Pick<ScanRunner, "stop">,
  io: { killGroup: () => void; exit: (code: number) => void; log: (line: string) => void },
): () => void {
  let seen = 0;
  return () => {
    seen++;
    if (seen === 1) {
      io.log("scan: stopping — signal again to kill it outright");
      scan.stop();
      return;
    }
    io.log("scan: killed");
    try {
      io.killGroup();
    } finally {
      io.exit(130);
    }
  };
}

/** `qcr scan …`: assemble the companion's scan belt over this machine's
 * state home and run one subcommand. */
export async function cmdScan(argv: string[], json: boolean): Promise<number> {
  let picked: ReturnType<typeof takeSandboxFlag>;
  try {
    picked = takeSandboxFlag(argv);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.log(
      json
        ? JSON.stringify(withSchemaVersion(SCAN_SCHEMA_VERSION, { ok: false, errors: [msg] }))
        : msg,
    );
    return 2;
  }
  const rest = picked.rest;
  const { buildEngine, sharedPorts, DEFAULT_REVIEWED_REPO } =
    await import("../extensions/setup.js");
  const { buildScan, watchTuiRequests, STAGE2_POLL_MS } =
    await import("../extensions/setup-scan.js");
  const env = scanEnv(process.env, DEFAULT_REVIEWED_REPO);
  // `--model` is this run's alone: the config the scan reads is told of it
  // here, and a value a shell happens to carry is never read.
  const model = modelFlagOf(rest);
  if (model !== undefined) env[SCAN_MODEL_ENV] = model;
  else delete env[SCAN_MODEL_ENV];
  const inSandbox = Boolean(env[IN_SANDBOX_ENV]?.trim());
  // The model env of the install's secrets dir, where pi looks for a
  // provider's key beside this process's own environment: the route
  // `qcr model` names is the one a scan driven here runs on. It is handed to
  // pi's credential lookup alone; a case's own env is still filtered from `env`.
  const authEnv: NodeJS.ProcessEnv = { ...env, ...(await scanModelEnv(env)) };
  // The route a driver resolves, for the cases it runs.
  const routes = scanRouteJoin();
  const shared = sharedPorts(env);
  const engine = buildEngine(env, shared, process.cwd());
  const home = stateHome(env);
  const { scan, findings, settingsOf, triage } = buildScan(
    engine,
    env.QCR_REVIEWED_REPO!,
    env,
    shared,
    null,
    // This process is the scan's disposable driver (or a one-shot CLI that
    // never runs a case): the one place scan leaves may be SDK sessions, loaded
    // on first use. The companion's pi builds its scan without this.
    async (o) => {
      const { scanSdkCases } = await import("./engine/caserunner-sdk.js");
      return scanSdkCases({
        ...o,
        agentDir: join(home, SCAN_SDK_AGENT_DIR),
        authEnv,
        // One route per scan: every case's host is handed the driver's.
        route: routes.route,
      });
    },
    // The child-pi leg (a config the SDK leg cannot read) is handed the same.
    routes.route,
  );
  const routing: ScanRouting = {};
  const ports = inSandbox
    ? { detach: detachDriver(env, home), units: engine, sandbox: null }
    : await sandboxPorts(env, home, engine, settingsOf, picked.sandbox, routing);
  const { sandbox: routeSandbox, ...sandboxDeps } = ports;
  const interactive = Boolean(process.stdin.isTTY && process.stderr.isTTY);
  const routePort = routes.port({
    env,
    authEnv,
    root: env.QCR_ROOT?.trim() || sandboxRoot(),
    home,
    sandbox: routeSandbox,
    // The choice is remembered beside the login: only where this process
    // reads the login itself is there anyone to ask.
    choose: interactive && routeSandbox === null ? chooseOnTerminal : null,
  });
  routing.port = routePort;
  return runScanCli(rest, json, {
    scan,
    findings,
    settingsOf,
    triage,
    afterMatch: triage ? () => triage.closeFixed() : null,
    home,
    repo: env.QCR_REVIEWED_REPO!,
    out: (line) => console.log(line),
    ...sandboxDeps,
    route: routePort,
    sleep: (ms) => new Promise((r) => setTimeout(r, ms)),
    now: () => Date.now(),
    watchStops: (s) => {
      const unwatch = watchTuiRequests(s, STAGE2_POLL_MS, { stage2: false });
      const onSignal = foregroundSignals(s, {
        // A detached driver leads its own process group: the pi children
        // are in it. In a terminal the group is the shell's job, which the
        // terminal's Ctrl-C reaches whole already.
        killGroup: () => {
          try {
            process.kill(-process.pid, "SIGKILL");
          } catch {
            // Not a group leader: exit alone.
          }
        },
        exit: (code) => process.exit(code),
        log: (line) => console.error(line),
      });
      process.on("SIGINT", onSignal);
      process.on("SIGTERM", onSignal);
      return () => {
        unwatch();
        process.off("SIGINT", onSignal);
        process.off("SIGTERM", onSignal);
      };
    },
    onStart: (outcome) => {
      sendStarted(process, outcome);
      // Inside a scan sandbox: the launching host reads it from the state home.
      const file = env[STARTED_FILE_ENV]?.trim();
      if (file) {
        try {
          writeStartedFile(file, outcome);
        } catch (err) {
          console.error(`scan: the start outcome could not be written to ${file}: ${String(err)}`);
        }
      }
    },
  });
}

/** The model env `qcr scan` reads: the secrets dir of the config a one-shot
 * run reads, with the wizards' override below a configured one, by the loader
 * `qcr model` and `qcr review` use. No config to read: none (the plan refuses
 * for the config on its own). */
async function scanModelEnv(env: NodeJS.ProcessEnv): Promise<Record<string, string>> {
  try {
    const [{ loadOneShotConfig }, { oneShotModelEnv }] = await Promise.all([
      import("./homes.js"),
      import("./modelenv.js"),
    ]);
    const loaded = loadOneShotConfig({
      root: env.QCR_ROOT?.trim() || sandboxRoot(),
      env,
      secretsOverride: env["QC_SECRETS_DIR"],
    });
    return oneShotModelEnv(loaded.cfg.github.secrets_dir, sandboxRoot(), {
      warn: (line) => console.error(line),
    });
  } catch {
    return {};
  }
}

/** The provider question at a terminal: the rows numbered, the first the
 * default. Null when the terminal went away: the order's own pick then runs,
 * unremembered. */
async function chooseOnTerminal(question: string, rows: readonly string[]): Promise<number | null> {
  const { createInterface } = await import("node:readline/promises");
  const rl = createInterface({ input: process.stdin, output: process.stderr });
  try {
    const list = rows.map((r, i) => `  ${i + 1}) ${r}`).join("\n");
    for (;;) {
      const a = (await rl.question(`${question}\n${list}\nWhich one? [1] `)).trim();
      if (a === "") return 0;
      if (/^\d+$/.test(a) && Number(a) >= 1 && Number(a) <= rows.length) return Number(a) - 1;
    }
  } catch {
    return null;
  } finally {
    rl.close();
  }
}

/** The host side of `[scan] sandbox`: the launch (a container for
 * `"docker"`, a host process for `"host"`), the doctor and the login, and
 * where a plan's route is asked (`sandbox`: the scan image for `"docker"`,
 * null for `"host"`). */
async function sandboxPorts(
  env: NodeJS.ProcessEnv,
  home: string,
  engine: UnitCutPort,
  settingsOf: () => { scan: { tier: string } } | null,
  sandboxOverride?: "host" | "docker",
  /** The scan's route port, once the caller has made it. */
  routing: ScanRouting = {},
): Promise<
  Pick<ScanCliDeps, "detach" | "units" | "doctor" | "login" | "rebuild"> & {
    sandbox: ScanRouteWorld["sandbox"];
  }
> {
  const [
    { buildScanImage, dockerDetach, effectiveSandbox, scanDoctor, scanLoginRoute },
    companion,
    { appStamp },
    install,
    cfgMod,
  ] = await Promise.all([
    import("./scanbox.js"),
    import("./tui/companion.js"),
    import("./appstamp.js"),
    import("./install.js"),
    import("./config.js"),
  ]);
  let cfg: ReturnType<typeof loadConfig> | null = null;
  try {
    cfg = loadConfig();
  } catch {
    // No readable config: the sandbox defaults; a start then refuses for it.
  }
  const base = cfg?.scan_sandbox ?? {
    ...cfgMod.SCAN_SANDBOX_DEFAULTS,
    pihome_volume: cfgMod.COMPANION_DEFAULTS.pihome_volume,
    image: cfgMod.SCAN_IMAGE_DEFAULT,
  };
  // `--sandbox` on the command line is a set value: it wins over the config
  // and over the companion's unset-means-host reading.
  const configured = sandboxOverride
    ? { ...base, sandbox: sandboxOverride, sandbox_set: true }
    : base;
  const docker = companion.realDockerRunner;
  // Inside the companion container an unset sandbox is the host: there is
  // no docker there, and the container is the sandbox already.
  const { sandbox, note } = await effectiveSandbox(configured, {
    env,
    exists: (p) => existsSync(p),
    docker,
  });
  const appRoot = env.QCR_ROOT?.trim() || sandboxRoot();
  const reviewedRepo = mountedCheckout(env);
  // The route a scan here would run on, as a plan asks it: nobody is asked
  // anything, and nothing is remembered. Unknown when it cannot be asked.
  const planned = async (pin?: string): Promise<ScanRouted | undefined> => {
    if (routing.port === undefined) return undefined;
    try {
      return await routing.port({ ...(pin !== undefined ? { pin } : {}), run: false, ask: false });
    } catch {
      return undefined;
    }
  };
  // The models the scan's config leaves pinned, under `--model` when the env
  // carries one: the providers beside the route's whose logins a scan needs.
  const pinnedModels = (): Parameters<typeof scanProviders>[1] => {
    const loaded = loadScanConfig(appRoot, env);
    return loaded.ok ? loaded.cfg.models : undefined;
  };
  const detach =
    sandbox.sandbox === "host"
      ? detachDriver(env, home)
      : dockerDetach<ScanRun>({
          docker,
          env,
          sandbox,
          reviewedRepo,
          appRoot,
          configSource: () => {
            const located = install.locateConfig({ env });
            return existsSync(located.path) ? located.path : undefined;
          },
          // The logins the launch judges: those of the route the driver
          // inside will resolve (under the same `--model`), asked of the scan
          // image. Unknown: the whole login is judged.
          providers: async (argv) => {
            const result = (await planned(modelFlagOf(argv)))?.result;
            return result !== undefined && result !== null && result.ok
              ? scanProviders(result.route, pinnedModels())
              : undefined;
          },
          // The companion's own memory wiring: its network and key file.
          memory: async () =>
            cfg
              ? new companion.CompanionLifecycle(cfg.companion, docker, env).resolveMemoryWiring(
                  (note) => console.error(`scan sandbox: ${note}`),
                )
              : { network: "", endpoint: "", notes: [] },
        });
  return {
    detach,
    units: engine,
    sandbox:
      sandbox.sandbox === "host"
        ? null
        : { docker, config: sandbox, stamp: () => appStamp(appRoot) },
    doctor: () =>
      scanDoctor({
        sandbox,
        ...(note ? { note } : {}),
        docker,
        stamp: () => appStamp(appRoot),
        reviewedRepo,
        cut: () => {
          const st = engine.status();
          return { saved: st.saved !== null, problems: st.cut_file_unreadable ? st.problems : [] };
        },
        // The model the probe asks is the route's, at stage 1's tier (the
        // profile may move it), read where the scan would run.
        route: async () => {
          const routed = await planned();
          if (routed === undefined)
            return { ok: false, error: "the scan's model could not be resolved here" };
          return doctorRouteOf(
            routed,
            settingsOf()?.scan.tier ?? cfg?.scan.tier ?? "",
            pinnedModels(),
          );
        },
      }),
    rebuild: () =>
      buildScanImage({
        docker,
        image: sandbox.image,
        buildContext: cfg?.companion.build_context ?? appRoot,
        exists: (p) => existsSync(p),
        stamp: appStamp,
        onProgress: (line) => console.error(line),
      }),
    login: async (asked?: string) => {
      if (sandbox.sandbox === "host") {
        console.log(
          'scan login: [scan] sandbox = "host" — the scan runs this machine\'s `pi`; run `pi` and /login there.',
        );
        return 1;
      }
      const companionCfg = cfg?.companion ?? cfgMod.COMPANION_DEFAULTS;
      let route;
      try {
        route = await scanLoginRoute(docker, sandbox, companionCfg, asked?.trim() || undefined);
      } catch (e) {
        console.log((e as Error).message);
        return 1;
      }
      console.log(route.say);
      const r = spawnSync("docker", route.argv, { stdio: "inherit" });
      if (r.error) {
        console.log(`scan login: docker could not start: ${r.error.message}`);
        return 1;
      }
      return r.status ?? 1;
    },
  };
}
