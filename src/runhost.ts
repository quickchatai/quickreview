// Where the daemon runs, and what that costs it.
//
// The release image is the bot's home: the VM runs it, and the image carries
// the walls the daemon leans on (its own container, the tool-uid split its
// entrypoint arranges, the memory engine beside it). The same app can also be
// started from an npm install or a checkout. That is allowed, and it is said
// out loud: a daemon outside the image starts with a warning in its log and
// a `run_host` block in status.json, so nobody mistakes it for the image.
//
// Two facts follow from it here:
//   - the tool uid. The image's entrypoint names it (QCR_TOOL_UID). Outside
//     the image nothing does, so it stays opt-in: set QCR_TOOL_UID yourself,
//     or the session tools run as the daemon's own user;
//   - memory. Outside the image the memory engine is the Docker sidecar, so a
//     host without Docker runs with memory OFF — switched off cleanly at boot,
//     never configured-on and failing forever.
//
// No daemon or store import, so the entry point can ask it before anything is
// assembled.
import { spawnSync } from "node:child_process";
import { toolUidSplit } from "./ipc/capability.js";
import { MEMORY_OFF_NO_DOCKER } from "./memory/health.js";
import { detectInstall } from "./installkind.js";

/** status.json `run_host`: where this daemon runs. */
export interface RunHostStatus {
  /** Started inside the release image. */
  in_image: boolean;
  /** How the app was installed (src/installkind.ts `detectInstall`). */
  install: "image" | "checkout" | "global" | "local";
  /** The tool-uid split: `image` (the entrypoint arranged it), `opt-in`
   * (QCR_TOOL_UID set outside the image), `off` (the tools run as the
   * daemon's user). */
  tool_uid: "image" | "opt-in" | "off";
  /** Present outside the image: the one line the log and the readers say. */
  warning?: string;
}

export { MEMORY_OFF_NO_DOCKER };

/** Where the daemon at `pkgRoot` runs, from its path and env. */
export function runHostStatus(
  pkgRoot: string,
  env: Readonly<Record<string, string | undefined>> = process.env,
): RunHostStatus {
  const install = detectInstall(pkgRoot, env).kind;
  const inImage = install === "image";
  const split = toolUidSplit(env);
  const tool_uid: RunHostStatus["tool_uid"] = inImage ? "image" : split ? "opt-in" : "off";
  if (inImage) return { in_image: true, install, tool_uid };
  const tools = split
    ? `session tools run as the tool uid QCR_TOOL_UID=${env["QCR_TOOL_UID"]}`
    : "session tools run as this user (set QCR_TOOL_UID to split them onto another uid)";
  return {
    in_image: false,
    install,
    tool_uid,
    warning: `running outside the release image (${install} install) — no container walls this daemon in; ${tools}. The VM runs the release image.`,
  };
}

/** Is a Docker daemon answering here? Synchronous and bounded: asked once,
 * at boot, before anything is assembled. Any failure (no CLI, daemon down,
 * no permission, the timeout) is "no". */
export function dockerAvailableSync(
  run: (bin: string, argv: string[]) => { status: number | null; stdout: string } = (bin, argv) => {
    const res = spawnSync(bin, argv, { encoding: "utf8", timeout: 5_000, stdio: "pipe" });
    return { status: res.error ? null : res.status, stdout: res.stdout ?? "" };
  },
): boolean {
  try {
    const res = run("docker", ["info", "--format", "{{.ServerVersion}}"]);
    return res.status === 0 && res.stdout.trim() !== "";
  } catch {
    return false;
  }
}

/** Why memory is switched off on this host, or undefined when it is not:
 * only outside the image, only when memory is configured on, and only when
 * no Docker answers (the sidecar has nowhere to run). `dockerUp` is asked
 * only when it decides. */
export function memoryOffOnHost(
  host: Pick<RunHostStatus, "in_image">,
  memoryEnabled: boolean,
  dockerUp: () => boolean,
): string | undefined {
  if (host.in_image || !memoryEnabled) return undefined;
  return dockerUp() ? undefined : MEMORY_OFF_NO_DOCKER;
}

/** What the daemon's entry point learns about its host before assembling. */
export interface HostFacts {
  runHost: RunHostStatus;
  /** Set when memory is switched off for this host (`memoryOffOnHost`). */
  memoryOff?: string;
}

export function hostFacts(
  pkgRoot: string,
  memoryEnabled: boolean,
  env: Readonly<Record<string, string | undefined>> = process.env,
  dockerUp: () => boolean = () => dockerAvailableSync(),
): HostFacts {
  const runHost = runHostStatus(pkgRoot, env);
  const memoryOff = memoryOffOnHost(runHost, memoryEnabled, dockerUp);
  return { runHost, ...(memoryOff ? { memoryOff } : {}) };
}
