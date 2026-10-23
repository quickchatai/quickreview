// The central lens permit broker (D25): the daemon's one count of lens sessions
// alive across every worker, and the worker's end of it.
//
// A worker's lens runner asks `permits.acquire{lens_id, weight}` before it
// creates a pass's session and answers `permits.release{lens_id}` once the
// session is read and disposed. The broker
//   - never holds more than `ceiling` permits at once, over all workers;
//   - grants in arrival order (FIFO across workers): a large head blocks the
//     ones behind it rather than being starved by them;
//   - spaces consecutive grants at least `staggerMs` apart, so a full wave of
//     20 never creates its sessions in one burst (docs/cpu-gate.md, finding 4:
//     8 to 20 simultaneous creations stalled the loop for 0.7 to 2.5 s);
//   - takes a worker's permits back when the worker's command ends or its
//     generation goes stale: the capability's revocation (`attach`) and a
//     periodic look at the daemon's own view of the command (`reap`).
// The command and its generation come from the authenticated connection, never
// from the request body: a worker cannot spend another command's permits. Warm-
// ups take no permit (D7).
//
// Neutral, like the rest of src/ipc/: no engine, no pi, no state store. The
// engine's lens runner reaches the broker through its `Permits` port
// (packages/pi-plugin/src/engine/lens/permits.ts); `brokerPermits` below is the adapter the worker
// builds over its IPC client.
import { type CommandLookup, IpcError, type IpcRole } from "./protocol.js";

export const PERMITS_ACQUIRE_OP = "permits.acquire";
export const PERMITS_RELEASE_OP = "permits.release";

/** `[daemon] lens_permits`: ruled 20 for the VM (the CPU gate measured 20
 * sessions fine on 2 cores). */
export const DEFAULT_LENS_PERMITS = 20;
/** `[daemon] lens_grant_stagger_ms`. */
export const DEFAULT_LENS_GRANT_STAGGER_MS = 250;
/** How often the daemon checks held permits against its view of the commands. */
export const DEFAULT_PERMIT_REAP_MS = 5_000;

const LENS_ID_RE = /^[A-Za-z0-9_.:-]{1,128}$/;

/** What status.json carries under `permits`. */
export interface PermitStatus {
  ceiling: number;
  stagger_ms: number;
  /** Permits held now (the sum of the granted weights). */
  in_use: number;
  /** Acquires waiting for a grant. */
  queued: number;
  /** Per command, only those holding or waiting. */
  commands: Array<{ command_id: string; in_use: number; queued: number }>;
}

export interface PermitBrokerOptions {
  /** The global ceiling. Default DEFAULT_LENS_PERMITS. */
  ceiling?: number;
  /** The least gap between two grants, in ms; 0 turns the stagger off. */
  staggerMs?: number;
  /** Diagnostics only. */
  log?: (msg: string) => void;
}

/** Who asks: the authenticated command and the generation its worker runs. */
export interface PermitHolder {
  commandId: string;
  generation: number;
}

interface Entry extends PermitHolder {
  lensId: string;
  weight: number;
}

interface Waiter extends Entry {
  resolve(): void;
  reject(e: unknown): void;
}

const keyOf = (commandId: string, lensId: string): string => `${commandId}\u0000${lensId}`;

export class PermitBroker {
  readonly ceiling: number;
  readonly staggerMs: number;
  private available: number;
  private readonly held = new Map<string, Entry>();
  private queue: Waiter[] = [];
  private lastGrantAt = Number.NEGATIVE_INFINITY;
  private timer: NodeJS.Timeout | null = null;
  private reaper: NodeJS.Timeout | null = null;
  private unsubscribe: (() => void) | null = null;
  private readonly log: (msg: string) => void;

  constructor(opts: PermitBrokerOptions = {}) {
    const ceiling = opts.ceiling ?? DEFAULT_LENS_PERMITS;
    const stagger = opts.staggerMs ?? DEFAULT_LENS_GRANT_STAGGER_MS;
    if (!Number.isSafeInteger(ceiling) || ceiling < 1)
      throw new Error(`the permit ceiling must be a positive integer (got ${String(ceiling)})`);
    if (!Number.isFinite(stagger) || stagger < 0)
      throw new Error(`the grant stagger must be a number of ms >= 0 (got ${String(stagger)})`);
    this.ceiling = ceiling;
    this.staggerMs = stagger;
    this.available = ceiling;
    this.log = opts.log ?? ((): void => {});
  }

  /** Resolves when `weight` permits are granted to `lensId` of the holder's
   * command; rejects `cancelled` if the wait is ended by a release or by the
   * command ending. A weight is clamped to 1..ceiling, as the local semaphore does. */
  acquire(who: PermitHolder, lensId: string, weight = 1): Promise<void> {
    const key = keyOf(who.commandId, lensId);
    if (this.held.has(key) || this.queue.some((w) => keyOf(w.commandId, w.lensId) === key))
      return Promise.reject(new IpcError("bad_request", `lens ${lensId} already has a permit`));
    // A newer generation of the command means the older worker is gone.
    this.dropWhere((e) => e.commandId === who.commandId && e.generation < who.generation, "stale");
    const w = Math.max(1, Math.min(Math.trunc(weight) || 1, this.ceiling));
    return new Promise<void>((resolve, reject) => {
      this.queue.push({ ...who, lensId, weight: w, resolve, reject });
      this.pump();
    });
  }

  /** Give one lens's permits back, or cancel its wait. Idempotent. */
  release(commandId: string, lensId: string): "released" | "cancelled" | "none" {
    const key = keyOf(commandId, lensId);
    const held = this.held.get(key);
    if (held !== undefined) {
      this.held.delete(key);
      this.available += held.weight;
      this.pump();
      return "released";
    }
    const at = this.queue.findIndex((w) => keyOf(w.commandId, w.lensId) === key);
    if (at >= 0) {
      const [gone] = this.queue.splice(at, 1);
      gone!.reject(new IpcError("cancelled", "the permit wait was ended"));
      this.pump();
      return "cancelled";
    }
    return "none";
  }

  /** Everything a command holds or waits for, back: its worker exited. Returns
   * the number of entries dropped. */
  releaseCommand(commandId: string): number {
    return this.dropWhere((e) => e.commandId === commandId, "ended");
  }

  /** Drop what the daemon no longer stands behind: a command with no live
   * worker, or a worker of an earlier generation. Returns the entries dropped. */
  reap(lookup: CommandLookup): number {
    const verdicts = new Map<string, number | null>();
    const live = (commandId: string): number | null => {
      if (!verdicts.has(commandId)) {
        const s = lookup(commandId);
        verdicts.set(commandId, s !== null && s.active ? s.generation : null);
      }
      return verdicts.get(commandId) ?? null;
    };
    return this.dropWhere((e) => live(e.commandId) !== e.generation, "no live worker");
  }

  /** Take permits back as soon as a command's capability is revoked (the
   * supervisor revokes it when the worker's process has exited). */
  attach(capabilities: { onRevoke(fn: (commandId: string) => void): () => void }): void {
    this.unsubscribe?.();
    this.unsubscribe = capabilities.onRevoke((id) => void this.releaseCommand(id));
  }

  /** Begin the periodic `reap`. */
  start(lookup: CommandLookup, intervalMs = DEFAULT_PERMIT_REAP_MS): void {
    if (this.reaper) return;
    this.reaper = setInterval(() => {
      try {
        this.reap(lookup);
      } catch (e) {
        this.log(`permit reap failed: ${String(e)}`);
      }
    }, intervalMs);
    this.reaper.unref();
  }

  /** The daemon is going down: end every wait and forget every permit. */
  stop(): void {
    this.unsubscribe?.();
    this.unsubscribe = null;
    if (this.reaper) clearInterval(this.reaper);
    this.reaper = null;
    this.dropWhere(() => true, "the daemon is stopping");
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
  }

  status(): PermitStatus {
    const per = new Map<string, { in_use: number; queued: number }>();
    const slot = (id: string): { in_use: number; queued: number } => {
      let s = per.get(id);
      if (s === undefined) per.set(id, (s = { in_use: 0, queued: 0 }));
      return s;
    };
    for (const e of this.held.values()) slot(e.commandId).in_use += e.weight;
    for (const w of this.queue) slot(w.commandId).queued += 1;
    return {
      ceiling: this.ceiling,
      stagger_ms: this.staggerMs,
      in_use: this.ceiling - this.available,
      queued: this.queue.length,
      commands: [...per].map(([command_id, s]) => ({ command_id, ...s })),
    };
  }

  private dropWhere(pick: (e: Entry) => boolean, why: string): number {
    let n = 0;
    for (const [key, e] of [...this.held]) {
      if (!pick(e)) continue;
      this.held.delete(key);
      this.available += e.weight;
      n++;
      this.log(`permits of ${e.commandId} (lens ${e.lensId}) came back: ${why}`);
    }
    const keep: Waiter[] = [];
    for (const w of this.queue) {
      if (pick(w)) {
        w.reject(new IpcError("cancelled", `the permit wait was ended: ${why}`));
        n++;
      } else keep.push(w);
    }
    this.queue = keep;
    if (n > 0) this.pump();
    return n;
  }

  /** Grant the head of the line while it fits and the stagger allows. */
  private pump(): void {
    while (this.queue.length > 0) {
      const head = this.queue[0]!;
      if (head.weight > this.available) return; // FIFO: the head waits for room
      const wait = this.lastGrantAt + this.staggerMs - Date.now();
      if (wait > 0) {
        this.timer ??= setTimeout(() => {
          this.timer = null;
          this.pump();
        }, wait);
        this.timer.unref();
        return;
      }
      this.queue.shift();
      this.available -= head.weight;
      this.lastGrantAt = Date.now();
      this.held.set(keyOf(head.commandId, head.lensId), {
        commandId: head.commandId,
        generation: head.generation,
        lensId: head.lensId,
        weight: head.weight,
      });
      head.resolve();
    }
  }
}

function lensIdOf(body: unknown): string {
  const id = (body as { lens_id?: unknown } | null | undefined)?.lens_id;
  if (typeof id !== "string" || !LENS_ID_RE.test(id))
    throw new IpcError("bad_request", "`lens_id` must be a short plain id");
  return id;
}

/** An op for `IpcServer.register`: the shape of the server's `OpHandler`, kept
 * here so this module stays out of the socket server's import closure (the
 * config reads the defaults above). */
export interface PermitOp {
  roles: readonly IpcRole[];
  handle(ctx: { commandId: string; generation: number }, body: unknown): Promise<unknown> | unknown;
}

/** The two ops, for `IpcServer.register`. A worker's, not a shim's: only the
 * round's host runs lens sessions. */
export function permitOps(broker: PermitBroker): Record<string, PermitOp> {
  return {
    [PERMITS_ACQUIRE_OP]: {
      roles: ["worker"],
      handle: async (ctx, body) => {
        const lensId = lensIdOf(body);
        const raw = (body as { weight?: unknown }).weight;
        if (raw !== undefined && (typeof raw !== "number" || !Number.isFinite(raw)))
          throw new IpcError("bad_request", "`weight` must be a number");
        await broker.acquire(
          { commandId: ctx.commandId, generation: ctx.generation },
          lensId,
          raw ?? 1,
        );
        return { granted: true };
      },
    },
    [PERMITS_RELEASE_OP]: {
      roles: ["worker"],
      handle: (ctx, body) => ({ result: broker.release(ctx.commandId, lensIdOf(body)) }),
    },
  };
}

// ---- the worker's end -------------------------------------------------------

/** The slice of IpcClient the adapter uses. `timeoutMs: 0` means no timer: a
 * grant may wait behind every other worker's lenses. */
export interface PermitRequester {
  request<T = unknown>(op: string, body?: unknown, opts?: { timeoutMs?: number }): Promise<T>;
}

function abortReason(signal: AbortSignal): Error {
  const r: unknown = signal.reason;
  return r instanceof Error ? r : new Error("aborted");
}

/** The engine's `Permits` port (packages/pi-plugin/src/engine/lens/permits.ts) over the broker. */
export function brokerPermits(
  client: PermitRequester,
  warn: (message: string) => void = () => {},
): {
  acquire(lensId: string, weight: number, signal?: AbortSignal): Promise<{ release(): void }>;
} {
  const give = (lensId: string): void => {
    // A release that cannot be sent is not lost: the permit returns when the
    // worker exits.
    client.request(PERMITS_RELEASE_OP, { lens_id: lensId }).catch((e: unknown) => {
      warn(`permit release for ${lensId} failed: ${String(e)}`);
    });
  };
  return {
    async acquire(lensId, weight, signal) {
      signal?.throwIfAborted();
      const call = client.request(
        PERMITS_ACQUIRE_OP,
        { lens_id: lensId, weight },
        { timeoutMs: 0 },
      );
      // If the wait is abandoned the call still settles (cancelled): no unhandled rejection.
      call.catch(() => {});
      let onAbort: (() => void) | undefined;
      try {
        if (signal === undefined) await call;
        else
          await Promise.race([
            call,
            new Promise<never>((_, reject) => {
              onAbort = () => {
                give(lensId); // ends the wait, or returns a grant already on its way
                reject(abortReason(signal));
              };
              signal.addEventListener("abort", onAbort, { once: true });
            }),
          ]);
      } finally {
        if (onAbort) signal?.removeEventListener("abort", onAbort);
      }
      let given = false;
      return {
        release: () => {
          if (given) return;
          given = true;
          give(lensId);
        },
      };
    },
  };
}
