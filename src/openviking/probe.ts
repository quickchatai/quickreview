// The authenticated memory probe.
//
// `health.ts` beside this file asks `/health` and `/ready`, and both are
// unauthenticated: they say "ready" while a refused key fails every read and
// every write. A server that is up is not a memory that works. This probe asks
// the question that matters — "does THIS key list THIS user's memories root?" —
// and answers it for one credential at a time, so the daemon's key and the
// `ovcli.conf` the sessions are handed are judged separately (either can fail
// while the other works).
//
// Total by construction, like every call in this directory: a dead server, a
// missing key or a garbage body is a classified answer, never a throw.
import type { ProbeAnswer, ProbeResult } from "../memory/health.js";
import {
  OpenVikingClient,
  isAuthFailure,
  isNotFound,
  type HttpFetch,
  type KeySource,
} from "./client.js";

/** Where a probe's key comes from. `absent` (no credential file at all — e.g.
 * no session has been born yet to need one) is reported as such and is never
 * a failure; `unreadable` is (a session handed a torn file runs keyless). */
export type ProbeKey =
  { state: "key"; key: string } | { state: "absent" } | { state: "unreadable"; detail: string };

export interface CredentialProbeOptions {
  baseUrl: string;
  /** The OpenViking user whose memories root is listed. */
  user: string;
  account?: string;
  /** Read on EVERY probe — the daemon's `keyFromFile` source, or a fresh read
   * of the sessions' `ovcli.conf`. */
  key: () => ProbeKey;
  timeoutMs: number;
  fetchFn?: HttpFetch;
  clock?: () => number;
}

/** A plain key source as a probe key: `null`/empty is "no key", never absent. */
export function probeKeyFrom(source: KeySource): () => ProbeKey {
  return () => {
    const value = typeof source === "function" ? source() : source;
    return { state: "key", key: value ?? "" };
  };
}

/**
 * Classify one listing answer. Exported so the classification is testable
 * without a fetch:
 *
 *   * 2xx → `ok`;
 *   * `NOT_FOUND` with a key → `ok` too: the server authenticates before it
 *     resolves a path, so a 404 proves the key works and only says nothing has
 *     created the root yet (a fresh server: empty is not degraded);
 *   * 401/403, an auth code or "Invalid API Key" → `auth_failed`;
 *   * `no_key` (nothing to send) → `no_key`;
 *   * no answer at all → `unreachable`;
 *   * anything else (5xx, 422, a body that is not an envelope) → `error`.
 */
export function classifyProbe(
  ok: boolean,
  status: number,
  code: string,
  message: string,
): ProbeResult {
  if (ok) return "ok";
  if (code === "no_key") return "no_key";
  if (isAuthFailure(status, code, message)) return "auth_failed";
  if (isNotFound(status, code)) return "ok";
  if (status === 0) return "unreachable";
  return "error";
}

/**
 * One credential's probe: `fs/ls` of `viking://user/<user>/memories` with that
 * credential's key, classified. The client is built per call on purpose — a
 * probe must not share a key cache, a gap sink or a request counter with the
 * code it is checking (its own requests are counted by the monitor as `probe`).
 */
export function credentialProbe(opts: CredentialProbeOptions): () => Promise<ProbeAnswer> {
  const clock = opts.clock ?? Date.now;
  return async () => {
    const k = opts.key();
    if (k.state === "absent") {
      return { result: "absent", status: 0, code: "absent", ms: 0, detail: "no credential file" };
    }
    if (k.state === "unreadable") {
      return { result: "no_key", status: 0, code: "unreadable", ms: 0, detail: k.detail };
    }
    if (k.key.trim() === "") {
      return { result: "no_key", status: 0, code: "no_key", ms: 0, detail: "no key in it" };
    }
    const client = new OpenVikingClient({
      baseUrl: opts.baseUrl,
      apiKey: k.key,
      user: opts.user,
      ...(opts.account ? { account: opts.account } : {}),
      timeoutMs: opts.timeoutMs,
      ...(opts.fetchFn ? { fetchFn: opts.fetchFn } : {}),
    });
    const started = clock();
    let res: Awaited<ReturnType<OpenVikingClient["ls"]>>;
    try {
      res = await client.ls(client.memoriesRoot());
    } catch (err) {
      // `ls` is total; a caller-supplied fetch seam need not be.
      return {
        result: "unreachable",
        status: 0,
        code: "transport",
        ms: clock() - started,
        detail: err instanceof Error ? err.message : String(err),
      };
    }
    const ms = clock() - started;
    if (res.ok) return { result: "ok", status: res.status, code: "", ms };
    return {
      result: classifyProbe(false, res.status, res.code, res.message),
      status: res.status,
      code: res.code,
      ms,
      detail: res.message,
    };
  };
}
