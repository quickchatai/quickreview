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
import { spawn, spawnSync, type SpawnOptions } from "node:child_process";
import { closeSync, existsSync, openSync } from "node:fs";
import { join } from "node:path";
import { loadConfig, sandboxRoot, type CompanionConfig } from "./config.js";
import { stateHome } from "./install.js";
import {
  IN_SANDBOX_ENV,
  STARTED_FILE_ENV,
  renderDoctor,
  writeStartedFile,
  type DoctorReport,
} from "./scanbox.js";
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

/** The env a host-side `qcr scan` assembles under: the reviewed checkout and
 * the tracker from `[companion]` when the env does not name them, so the CLI
 * reads the same repo the companion mounts. Inside a scan sandbox neither is
 * read — they are host paths — and the container's env decides. */
export function scanEnv(
  env: NodeJS.ProcessEnv,
  defaultRepo: string,
  companionOf: () => Pick<CompanionConfig, "reviewed_repo_dir" | "tracker_dir"> = () =>
    loadConfig().companion,
): NodeJS.ProcessEnv {
  let companion: { reviewed_repo_dir: string; tracker_dir: string } | null = null;
  if (!env[IN_SANDBOX_ENV]?.trim()) {
    try {
      companion = companionOf();
    } catch {
      // No readable config: the env and the defaults decide.
    }
  }
  const tracker = env.QCR_TRACKER_DIR?.trim() || companion?.tracker_dir || "";
  return {
    ...env,
    QCR_ROOT: env.QCR_ROOT?.trim() || sandboxRoot(),
    QCR_REVIEWED_REPO: env.QCR_REVIEWED_REPO?.trim() || companion?.reviewed_repo_dir || defaultRepo,
    ...(tracker ? { QCR_TRACKER_DIR: tracker } : {}),
  };
}

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
  const inSandbox = Boolean(env[IN_SANDBOX_ENV]?.trim());
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
      return scanSdkCases({ ...o, agentDir: join(home, SCAN_SDK_AGENT_DIR) });
    },
  );
  return runScanCli(rest, json, {
    scan,
    findings,
    settingsOf,
    triage,
    afterMatch: triage ? () => triage.closeFixed() : null,
    home,
    out: (line) => console.log(line),
    ...(inSandbox
      ? { detach: detachDriver(env, home), units: engine }
      : await sandboxPorts(env, home, engine, settingsOf, picked.sandbox)),
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

/** The host side of `[scan] sandbox`: the launch (a container for
 * `"docker"`, a host process for `"host"`), the doctor and the login. */
async function sandboxPorts(
  env: NodeJS.ProcessEnv,
  home: string,
  engine: UnitCutPort,
  settingsOf: () => { scan: { tier: string } } | null,
  sandboxOverride?: "host" | "docker",
): Promise<Pick<ScanCliDeps, "detach" | "units" | "doctor" | "login" | "rebuild">> {
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
  // The checkout to mount: named by the env or `[companion]`, never the
  // in-container default (a host path is what docker mounts).
  const reviewedRepo =
    process.env.QCR_REVIEWED_REPO?.trim() || cfg?.companion.reviewed_repo_dir || "";
  // The model stage 1 runs on (the profile may move its tier): the login
  // the doctor's probe needs.
  const model = (): string => {
    const tiers: Record<string, string> = cfg?.models.tiers ?? {};
    const tier = settingsOf()?.scan.tier ?? cfg?.scan.tier ?? "";
    return tiers[tier] ?? cfg?.models.default ?? "";
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
        model: model(),
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
