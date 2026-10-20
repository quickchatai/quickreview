// The container-layout resolver: where the app root lives inside the daemon
// container, for every TUI remote path (inject files, the digest, evidence,
// the operator command channel, the deploy marker, the viewer's reads).
//
// The container says which layout it is: the release image carries the label
// `qcr.layout=release` (app root /opt/qcr); the legacy container carries no
// label (app root /opt/quickreview/sandbox). The cutover recreates the container
// mid-connection, so the answer is tied to the container's ID: the probe reads
// both in one `docker inspect`, and the root is re-resolved whenever the ID
// changes. The owner therefore edits no TUI key at the cutover, and a drain
// sent a moment before the recreate still lands in the legacy container's
// directory.
//
// An explicit `[tui] remote_sandbox_root` wins and is never probed. Until a
// probe has answered, the root is the legacy one: that is the only layout a
// container can have had before this resolver existed, and a probe that fails
// (ssh down, no container) never overwrites an answer already held.
import type { TuiConfig } from "../config.js";
import type { SshRunner } from "./remote.js";

export const LEGACY_LAYOUT_ROOT = "/opt/quickreview/sandbox";
export const RELEASE_LAYOUT_ROOT = "/opt/qcr";
export const LAYOUT_LABEL = "qcr.layout";

export type ContainerLayout = "legacy" | "release";

export interface LayoutProbe {
  /** The container's ID: a recreate changes it. */
  id: string;
  layout: ContainerLayout;
}

/** The root a layout keeps the app at. */
export function rootForLayout(layout: ContainerLayout): string {
  return layout === "release" ? RELEASE_LAYOUT_ROOT : LEGACY_LAYOUT_ROOT;
}

/** `docker inspect` of the daemon container: its ID and its layout label, one
 * line. An absent label prints as the empty string. */
export function layoutProbeArgv(cfg: TuiConfig): string[] {
  return [
    ...(cfg.sudo_docker ? ["sudo"] : []),
    "docker",
    "inspect",
    "-f",
    `{{.Id}} {{index .Config.Labels "${LAYOUT_LABEL}"}}`,
    cfg.container,
  ];
}

/** Total: anything that is not `<hex id> [label]` is no answer. Only the label
 * `release` means release; any other value, or none, is the legacy layout. */
export function parseLayoutProbe(stdout: string): LayoutProbe | undefined {
  const m = /^([0-9a-f]{12,64})(?:[ \t]+(\S+))?\s*$/.exec(stdout.trim());
  if (!m) return undefined;
  return { id: m[1]!, layout: m[2] === "release" ? "release" : "legacy" };
}

interface Held {
  id: string;
  root: string;
}

/** One answer per connection (transport, host, container), shared by every
 * copy of the config object. */
const held = new Map<string, Held>();

const keyOf = (cfg: TuiConfig): string => `${cfg.target}|${cfg.ssh_host}|${cfg.container}`;

/** Forget what was resolved (tests; a new connection). */
export function resetLayoutCache(): void {
  held.clear();
}

/** The app root inside the container, for building a remote path. Pure: it
 * reads what `resolveLayout` last held. */
export function remoteSandboxRoot(
  cfg: Pick<TuiConfig, "remote_sandbox_root"> & Partial<TuiConfig>,
): string {
  if (cfg.remote_sandbox_root) return cfg.remote_sandbox_root;
  return held.get(keyOf(cfg as TuiConfig))?.root ?? LEGACY_LAYOUT_ROOT;
}

/** Whether the root is the operator's explicit choice. */
export function rootIsExplicit(cfg: Pick<TuiConfig, "remote_sandbox_root">): boolean {
  return cfg.remote_sandbox_root !== "";
}

/**
 * Probe the container and update the held root when its ID is new. Returns the
 * root now in force. Never throws and never lowers an answer to "unknown": a
 * failed or unparseable probe leaves the previous one standing.
 */
export async function resolveLayout(cfg: TuiConfig, ssh: SshRunner): Promise<string> {
  if (rootIsExplicit(cfg)) return cfg.remote_sandbox_root;
  const key = keyOf(cfg);
  try {
    const res = await ssh(cfg.ssh_host, layoutProbeArgv(cfg), { timeoutMs: 10_000 });
    const probe = res.ok ? parseLayoutProbe(res.stdout) : undefined;
    if (probe) {
      const prev = held.get(key);
      if (prev?.id !== probe.id) held.set(key, { id: probe.id, root: rootForLayout(probe.layout) });
    }
  } catch {
    /* a runner that throws is a probe that did not answer */
  }
  return remoteSandboxRoot(cfg);
}
