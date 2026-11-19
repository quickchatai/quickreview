// The host verbs' ports: everything a verb (src/host/) touches outside its
// own logic comes through one of these. `realHostPorts` builds them over this
// machine: the compose stack the home's switches drive, the install's config,
// pi's agent dir, and the wizard's own step modules on switch-on's registry.
// A test builds them over a scratch directory, a fake Docker and fake steps.
import { mkdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import {
  writeAtomic,
  type SetupChecklist,
  type StepRegistry,
} from "@quickchatai/pi-quickreview/src/setupchecklist.js";
import { sandboxRoot } from "../config.js";
import { secretsDirAt } from "../hostmanaged.js";
import { locateConfig, stackRoot } from "../homes.js";
import { detectInstall } from "../installkind.js";
import {
  machineBootId,
  processAlive,
  processStartTime,
  type LockOptions,
  type ProcessFacts,
} from "../onboard/checklistlock.js";
import {
  OnboardingEngine,
  readChecklist,
  type OnboardAdapters,
  type ProcessResult,
  type StepContext,
} from "../onboard/engine.js";
import { composeArgs } from "../onboard/steps/compose.js";
import { stackTransportFor, type StackTransport } from "../onboard/steps/transport.js";
import { piAgentDir } from "../piagentdir.js";
import { detachedEntry, launchDetached } from "../reviewdetach.js";
import { appShippedConfigText } from "../shippeddefaults.js";
import { seedStack, stepAdapters } from "../home/adapters.js";
import { stepRunner, switchOnRegistry } from "../home/switchon.js";

/** The long work a verb starts detached. */
export const WALK_KINDS = ["setup", "go-live"] as const;
export type WalkKind = (typeof WALK_KINDS)[number];

export interface HostPorts {
  now(): Date;
  /** The environment the verb was started in. */
  env: Readonly<Record<string, string | undefined>>;
  /** This process, as the checklist lock names it. */
  pid: number;
  /** Is this qcr the release image's own (the daemon's container)? */
  inImage: boolean;
  /** The stack's state directory, where the checklist lives. */
  stateDir: string;
  /** The install's config.toml. */
  configPath: string;
  /** pi's agent dir on this machine: the login the stack reviews on. */
  agentDir: string;
  /** Where the install keeps its secrets (the token file). */
  secretsDir(): string;
  /** The shipped config template's text. */
  template(): string;
  /** A file's text; throws as `readFileSync` does. */
  read(path: string): string;
  /** Write a file whole (tmp+rename). */
  write(path: string, text: string): void;
  fetch: typeof fetch;
  /** GitHub's API. */
  apiBase: string;
  /** The machine's IANA timezone, or null. */
  timezone(): string | null;
  /** Put the stack's files where the compose project is, as the home does on
   * every launch. */
  seedStack(): void;
  /** Switch-on's steps: the wizard's own modules, in the wizard's order. */
  registry(): StepRegistry<OnboardAdapters>;
  /** The wizard's adapters for a step; `log` gets each line it says. */
  adapters(log?: (line: string) => void): OnboardAdapters;
  /** The checklist over `registry`, read from its file now. Built and used
   * under the checklist lock by whoever writes through it. */
  checklist(
    registry: StepRegistry<OnboardAdapters>,
    log?: (line: string) => void,
  ): SetupChecklist<OnboardAdapters>;
  /** `docker compose <args>` on the stack. */
  compose(args: readonly string[]): Promise<ProcessResult>;
  /** Start a walk as a process that outlives this one, with the lock token
   * it adopts the checklist lock by. */
  launch(kind: WalkKind, token: string): { ok: true; pid: number } | { ok: false; error: string };
  /** What was sent on standard input, whole; "" when nothing was. */
  stdin(): Promise<string>;
  /** Does process `pid` exist? */
  alive(pid: number): boolean;
  /** This boot of the machine, as the checklist lock records it; null where
   * it cannot be read. */
  bootId(): string | null;
  /** When process `pid` started, as the checklist lock records it; null
   * where it cannot be read. */
  startTime(pid: number): string | null;
  sleep(ms: number): Promise<void>;
  /** A line for whoever reads the walk's own log. */
  log(line: string): void;
}

/** What these ports say of a process: what the checklist lock is judged by
 * (src/onboard/checklistlock.ts), wherever a verb or a walk reads it. */
export function processFacts(
  ports: Pick<HostPorts, "alive" | "bootId" | "startTime">,
): Required<ProcessFacts> {
  return {
    alive: (pid) => ports.alive(pid),
    bootId: () => ports.bootId(),
    startTime: (pid) => ports.startTime(pid),
  };
}

/** The checklist lock as a verb takes it: as its own process, on its own
 * clock, judged by what its machine says of the holder on record. */
export function lockOptions(
  ports: Pick<HostPorts, "pid" | "now" | "alive" | "bootId" | "startTime">,
): LockOptions {
  return { pid: ports.pid, now: () => ports.now(), ...processFacts(ports) };
}

/** The stack as the steps reach it, decided where every step decides it
 * (`stackTransportFor`), over the checklist's recorded choices. */
export function transportOf(ports: HostPorts): StackTransport {
  const ctx: StepContext = {
    adapters: ports.adapters(),
    input: {},
    choices: readChecklist(ports.stateDir)?.choices ?? {},
    data: {},
    recordChoice: () => {},
  };
  return stackTransportFor(ctx);
}

/** The most a verb reads from standard input: an attestation is a few
 * hundred bytes. */
export const STDIN_LIMIT_BYTES = 64 * 1024;
/** How long a verb waits for standard input to end. */
export const STDIN_TIMEOUT_MS = 5_000;

/** Standard input, whole, read with a size limit and a deadline; "" for a
 * terminal, for nothing, and for more than the limit. */
export function readStdin(
  stream: NodeJS.ReadStream = process.stdin,
  o: { limit?: number; timeoutMs?: number } = {},
): Promise<string> {
  const limit = o.limit ?? STDIN_LIMIT_BYTES;
  if (stream.isTTY) return Promise.resolve("");
  return new Promise((resolve) => {
    const chunks: Buffer[] = [];
    let size = 0;
    let settled = false;
    const finish = (text: string): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      stream.pause();
      resolve(text);
    };
    const timer = setTimeout(() => finish(""), o.timeoutMs ?? STDIN_TIMEOUT_MS);
    stream.on("data", (chunk: Buffer | string) => {
      const buf = typeof chunk === "string" ? Buffer.from(chunk) : chunk;
      size += buf.length;
      if (size > limit) return finish("");
      chunks.push(buf);
    });
    stream.on("end", () => finish(Buffer.concat(chunks).toString("utf8")));
    stream.on("error", () => finish(""));
  });
}

function systemTimezone(): string | null {
  try {
    const tz = Intl.DateTimeFormat().resolvedOptions().timeZone;
    return typeof tz === "string" && tz !== "" ? tz : null;
  } catch {
    return null;
  }
}

/** The ports over this machine. */
export function realHostPorts(
  env: Readonly<Record<string, string | undefined>> = process.env,
): HostPorts {
  const pkgRoot = sandboxRoot();
  const root = stackRoot(env, pkgRoot);
  const stateDir = join(root, "state");
  const configPath = locateConfig({ env }).path;
  const agentDir = piAgentDir(env);
  const adaptersFor = stepAdapters(root, () => configPath);
  return {
    now: () => new Date(),
    env,
    pid: process.pid,
    inImage: detectInstall(pkgRoot, env).kind === "image",
    stateDir,
    configPath,
    agentDir,
    secretsDir: secretsDirAt(() => configPath, env),
    template: () => appShippedConfigText(),
    read: (path) => readFileSync(path, "utf8"),
    write: (path, text) => writeAtomic(path, text),
    fetch: (input, init) => fetch(input, init),
    apiBase: "https://api.github.com",
    timezone: systemTimezone,
    seedStack: () => seedStack(root, pkgRoot),
    // the stack reviews on the login of the pi on this machine, as the home's does
    registry: () => switchOnRegistry({ loginDir: agentDir }),
    adapters: (log) => adaptersFor(log ?? (() => {})),
    checklist: (registry, log) => new OnboardingEngine(registry, adaptersFor(log ?? (() => {}))),
    compose: (args) => stepRunner.run("docker", composeArgs(root, args)),
    launch: (kind, token) => {
      const dir = join(stateDir, "onboarding");
      try {
        mkdirSync(dir, { recursive: true });
      } catch (err) {
        return { ok: false, error: err instanceof Error ? err.message : String(err) };
      }
      return launchDetached({
        command: process.execPath,
        args: [...process.execArgv, detachedEntry(), "host", "walk", kind, token],
        dir,
        env: { ...env },
        log: `host-${kind}.log`,
      });
    },
    stdin: () => readStdin(),
    alive: processAlive,
    bootId: () => machineBootId(),
    startTime: (pid) => processStartTime(pid),
    sleep: (ms) => new Promise((r) => setTimeout(r, ms)),
    log: (line) => console.log(line),
  };
}
