// OpenViking health probing.
//
// The health gate is `/ready`, never `openviking-server doctor`. `doctor` makes
// live provider calls and exits 1 whenever no `vlm` is configured — which is
// our normal, deliberate state (memories are authored, never extracted). It
// would report a permanently sick server.
//
// `/health` is unauthenticated and carries the server's own version string;
// that is what the pin-drift check in the heartbeat reads. Both probes are
// fail-soft by construction: `probeHealth` resolves an OpenVikingHealth for
// every outcome — connection refused, timeout, 503, garbage body — and never
// rejects. A memory engine must never be able to take a round, or the
// heartbeat, down with it.
import { errText } from "./client.js";
import type { OpenVikingHealth } from "./types.js";

export type FetchLike = (
  url: string,
  init?: { signal?: AbortSignal },
) => Promise<{
  ok: boolean;
  status: number;
  json(): Promise<unknown>;
}>;

export interface ProbeOptions {
  baseUrl: string;
  timeoutMs: number;
  fetchFn?: FetchLike;
  now?: () => Date;
}

/**
 * Probe `/health`, then `/ready` when the server answered at all.
 *
 * `/ready` is skipped when `/health` did not answer: there is nothing to learn
 * from a second connection refusal, and skipping it halves the cost of the
 * common "server is restarting" case.
 */
export async function probeHealth(opts: ProbeOptions): Promise<OpenVikingHealth> {
  const now = opts.now ?? (() => new Date());
  const fetchFn: FetchLike = opts.fetchFn ?? ((url, init) => fetch(url, init));
  const at = now().toISOString();

  let version: string | undefined;
  try {
    const res = await fetchFn(`${opts.baseUrl}/health`, {
      signal: AbortSignal.timeout(opts.timeoutMs),
    });
    if (!res.ok) return { reachable: false, ready: false, error: `health ${res.status}`, at };
    // A body we cannot parse still proves the process is serving: reachable
    // stays true, the version simply stays unknown (and so does drift).
    try {
      const body = (await res.json()) as { version?: unknown };
      if (typeof body?.version === "string") version = body.version;
    } catch {
      version = undefined;
    }
  } catch (err) {
    return { reachable: false, ready: false, error: errText(err), at };
  }

  try {
    const res = await fetchFn(`${opts.baseUrl}/ready`, {
      signal: AbortSignal.timeout(opts.timeoutMs),
    });
    return {
      reachable: true,
      ready: res.ok,
      ...(version ? { version } : {}),
      ...(res.ok ? {} : { error: `ready ${res.status}` }),
      at,
    };
  } catch (err) {
    return {
      reachable: true,
      ready: false,
      ...(version ? { version } : {}),
      error: errText(err),
      at,
    };
  }
}
