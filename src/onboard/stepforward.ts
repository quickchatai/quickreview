// The memory forward, held open for ONE onboarding step call.
//
// On the compose route the memory engine listens only on its own container's
// loopback; this machine reaches it through the memory forward, the same relay
// the TUI runs in-process (src/tui/memforward.ts over
// scripts/companion-memory-forward.mjs). The wizard runs before any TUI, so
// without this the memory steps' phase B (minting the user keys, the
// confinement matrix) found nothing listening and sent the operator to a
// second terminal — and a wizard driven in order never got memory working.
//
// A forward that is already listening (`qcr tui`, the systemd unit) is
// adopted and left alone; one this opens is closed when the step ends, so the
// wizard leaves nothing running behind it. The real adapter assembly
// (extensions/onboarding.ts) hands this to the steps; a test's adapters never
// do, so no test binds a port.
import { MemoryForward } from "../tui/memforward.js";

export interface StepForwardRequest {
  /** Where the step reaches memory (the forward's loopback listener). */
  baseUrl: string;
  /** The checkout holding scripts/. */
  repoRoot: string;
  /** The memory sidecar's container. */
  container: string;
  sudoDocker: boolean;
  log?: (line: string) => void;
}

export interface StepForward {
  /** true when this call started the forward (and stop() closes it). */
  started: boolean;
  detail: string;
  stop(): void;
}

/** Open (or adopt) the local memory forward; null when none could be made to
 * answer, with nothing left bound. */
export async function openStepMemoryForward(
  req: StepForwardRequest,
  env: NodeJS.ProcessEnv = process.env,
): Promise<StepForward | null> {
  const forward = new MemoryForward({
    baseUrl: req.baseUrl,
    repoRoot: req.repoRoot,
    env,
    local: true,
    sudoDocker: req.sudoDocker,
    container: req.container,
    ...(req.log ? { log: req.log } : {}),
  });
  const status = await forward.ensure();
  if (status.state === "owned")
    return {
      started: true,
      detail: `opened a memory forward to ${req.container} for this step; it closes when the step ends, and \`qcr tui\` runs its own`,
      stop: () => forward.stop(),
    };
  if (status.state === "adopted") return { started: false, detail: status.detail, stop: () => {} };
  forward.stop();
  return null;
}
