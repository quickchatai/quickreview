// The daemon's status snapshot on this machine's compose stack, as the home
// reads it. The daemon writes status.json inside its state volume
// (docker-compose.yml `qcr-state`), never on a host path, so the home reads
// it through `docker compose exec` while the daemon runs. The spend line
// (src/home/spend.ts) and the Reviewed list's auto-review half
// (src/home/reviews.ts `autoRounds`) both read it here.
//
// A stack that can hold no snapshot recorded nothing: no Docker at all, a
// stack never brought up (no state volume), or a daemon that has not written
// one yet. A daemon that is off keeps its snapshot in its volume, where the
// home cannot read it: that is its own answer, never "nothing".
import type { ProcessRunner } from "../onboard/engine.js";
import {
  COMPOSE_PROJECT,
  CONTAINER_STATE_DIR,
  DAEMON_SERVICE,
  daemonExec,
} from "../onboard/steps/compose.js";
import { serviceState } from "./autoreview.js";

export type DaemonSnapshot =
  | { kind: "text"; text: string }
  /** Auto-review recorded nothing on this machine. */
  | { kind: "none" }
  /** The daemon is off; its snapshot is in its state volume. */
  | { kind: "off" }
  | { kind: "unknown"; why: string };

const firstLine = (s: string): string => s.trim().split("\n")[0]?.trim() || "no output";

/** The daemon's status.json on the compose stack at `root`. */
export async function daemonSnapshot(runner: ProcessRunner, root: string): Promise<DaemonSnapshot> {
  const container = await serviceState(runner, root, DAEMON_SERVICE);
  if (container.kind === "unknown") {
    // no Docker at all: auto-review never ran on this machine
    const v = await runner.run("docker", ["--version"]);
    if (v.code !== 0 && /ENOENT|not found/i.test(`${v.stderr}${v.stdout}`)) return { kind: "none" };
    return { kind: "unknown", why: `can't ask Docker about auto-review: ${container.why}` };
  }
  if (container.value === "running") {
    const r = await daemonExec(runner, root, ["cat", `${CONTAINER_STATE_DIR}/status.json`]);
    if (r.code === 0) return { kind: "text", text: r.stdout };
    if (/no such file/i.test(r.stderr)) return { kind: "none" };
    return { kind: "unknown", why: `can't read its status: ${firstLine(r.stderr || r.stdout)}` };
  }
  // off: did it ever run here? Its state volume is where its snapshot is.
  const volume = `${COMPOSE_PROJECT}_qcr-state`;
  const vol = await runner.run("docker", ["volume", "ls", "-q", "--filter", `name=^${volume}$`]);
  if (vol.code !== 0)
    return {
      kind: "unknown",
      why: `can't ask Docker for its state volume: ${firstLine(vol.stderr)}`,
    };
  return vol.stdout.trim() === "" ? { kind: "none" } : { kind: "off" };
}
