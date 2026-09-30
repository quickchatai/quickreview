// Raw Socket Mode client (S1) — no @slack/socket-mode dependency: this
// is a few hundred lines over Node >=22's global WebSocket + fetch, both
// injected so tests script frames deterministically.
//
// This file is PURE TRANSPORT. It acks, it reconnects, it normalizes — it does
// not filter, dedupe or tier. That is the router's job (S3).
import diagnosticsChannel from "node:diagnostics_channel";
import type { SlackFetchFn, SlackInboundEvent, SlackInboundHandler, SlackSocket } from "./types.js";

/** The slice of the WebSocket API we use — global WebSocket satisfies it. */
export interface SlackWebSocketLike {
  send(data: string): void;
  close(code?: number, reason?: string): void;
  onopen: ((ev: unknown) => void) | null;
  onmessage: ((ev: { data: unknown }) => void) | null;
  onclose: ((ev: unknown) => void) | null;
  onerror: ((ev: unknown) => void) | null;
  /** A WebSocket-level ping frame arrived. Slack keeps a quiet connection
   * alive with these, and they never reach `onmessage` — the global WebSocket
   * answers them internally; `bridgeNativeWebSocketPings` surfaces them. */
  onping?: (() => void) | null;
}

let pingBridgeInstalled = false;
/** Sockets built by the native factory, for undici builds whose ping message
 * does not say which socket it came from. */
const bridgedSockets = new Set<SlackWebSocketLike>();

/**
 * Node's global WebSocket (undici) answers server pings itself and exposes
 * them only on the `undici:websocket:ping` diagnostics channel. Newer undici
 * (7+, Node 24+) carries the socket object; undici 6 — Node 22, the daemon's
 * runtime — carries ONLY the payload. So: a ping naming its socket reaches
 * that socket's `onping`; a ping naming none reaches every live bridged
 * socket (the Slack client is the process's only WebSocket user, so in
 * practice that is exactly one). Idempotent.
 */
export function bridgeNativeWebSocketPings(): void {
  if (pingBridgeInstalled) return;
  pingBridgeInstalled = true;
  diagnosticsChannel.subscribe("undici:websocket:ping", (msg) => {
    const named = (msg as { websocket?: SlackWebSocketLike } | null)?.websocket;
    const targets = named ? [named] : [...bridgedSockets];
    for (const ws of targets) {
      if (!ws.onping) {
        bridgedSockets.delete(ws); // torn down: onping is nulled on close
        continue;
      }
      try {
        ws.onping();
      } catch {
        /* never let a hook throw into undici */
      }
    }
  });
}

/** Register a natively-built socket with the ping bridge (see above). */
export function trackBridgedSocket(ws: SlackWebSocketLike): void {
  bridgedSockets.add(ws);
}

export type SlackWebSocketFactory = (url: string) => SlackWebSocketLike;

export interface SlackSocketOptions {
  /** The app-level token (`xapp-…`) — apps.connections.open takes this one. */
  appToken: string;
  /** Injected fetch (default: global fetch). */
  fetchFn?: SlackFetchFn;
  /** Injected WebSocket constructor (default: global WebSocket). */
  webSocketFactory?: SlackWebSocketFactory;
  /** Jittered reconnect ladder in ms. */
  backoffMs?: number[];
  /** Tear down + reconnect when neither a frame nor a ping arrives for this long. */
  serverPingTimeoutMs?: number;
  /** Web API base (override in tests). */
  apiBase?: string;
  /** Jitter source, [0,1). */
  random?: () => number;
  /** Timer seam. */
  setTimeoutFn?: (fn: () => void, ms: number) => unknown;
  clearTimeoutFn?: (handle: unknown) => void;
  /** Structured log sink. */
  log?: (message: string, meta?: Record<string, unknown>) => void;
}

const DEFAULT_BACKOFF_MS = [1000, 2000, 5000, 15000, 30000];
const DEFAULT_SERVER_PING_TIMEOUT_MS = 30_000;

export class SlackSocketClient implements SlackSocket {
  private readonly appToken: string;
  private readonly fetchFn: SlackFetchFn;
  private readonly wsFactory: SlackWebSocketFactory;
  private readonly backoff: number[];
  private readonly pingTimeoutMs: number;
  private readonly apiBase: string;
  private readonly random: () => number;
  private readonly setTimeoutFn: (fn: () => void, ms: number) => unknown;
  private readonly clearTimeoutFn: (handle: unknown) => void;
  private readonly log: (message: string, meta?: Record<string, unknown>) => void;

  private handler: SlackInboundHandler | null = null;
  private ws: SlackWebSocketLike | null = null;
  private running = false;
  private attempt = 0;
  private reconnectTimer: unknown = null;
  private watchdogTimer: unknown = null;
  private connections = 0;

  constructor(opts: SlackSocketOptions) {
    this.appToken = opts.appToken;
    this.fetchFn = opts.fetchFn ?? fetch;
    this.wsFactory =
      opts.webSocketFactory ??
      ((url: string) => {
        bridgeNativeWebSocketPings();
        const ws = new WebSocket(url) as unknown as SlackWebSocketLike;
        trackBridgedSocket(ws);
        return ws;
      });
    this.backoff = opts.backoffMs?.length ? [...opts.backoffMs] : [...DEFAULT_BACKOFF_MS];
    this.pingTimeoutMs = opts.serverPingTimeoutMs ?? DEFAULT_SERVER_PING_TIMEOUT_MS;
    this.apiBase = opts.apiBase ?? "https://slack.com/api";
    this.random = opts.random ?? Math.random;
    this.setTimeoutFn = opts.setTimeoutFn ?? ((fn, ms) => setTimeout(fn, ms));
    this.clearTimeoutFn =
      opts.clearTimeoutFn ?? ((h) => clearTimeout(h as ReturnType<typeof setTimeout>));
    this.log = opts.log ?? (() => {});
  }

  /** `num_connections` from the last `hello` frame. */
  get numConnections(): number {
    return this.connections;
  }

  async startSocket(handler: SlackInboundHandler): Promise<void> {
    this.handler = handler;
    this.running = true;
    this.attempt = 0;
    await this.connect();
  }

  async stopSocket(): Promise<void> {
    this.running = false;
    this.clearTimer("reconnectTimer");
    this.clearTimer("watchdogTimer");
    this.closeSocket();
    this.handler = null;
  }

  // ---- connection lifecycle -------------------------------------------------

  private async connect(): Promise<void> {
    if (!this.running) return;
    let url: string | undefined;
    try {
      const res = await this.fetchFn(`${this.apiBase}/apps.connections.open`, {
        method: "POST",
        headers: {
          authorization: `Bearer ${this.appToken}`,
          "content-type": "application/x-www-form-urlencoded",
        },
      });
      const body = (await res.json()) as { ok?: boolean; url?: string; error?: string };
      if (body?.ok && typeof body.url === "string") url = body.url;
      else this.log("slack.socket.open_failed", { error: body?.error ?? "no_url" });
    } catch (err) {
      this.log("slack.socket.open_threw", { error: String(err) });
    }
    // stopSocket may have run while the open was in flight: it found no socket
    // to close, so building one now would leak it onto a stopped client.
    if (!this.running) return;
    if (!url) {
      this.scheduleReconnect();
      return;
    }

    let ws: SlackWebSocketLike;
    try {
      ws = this.wsFactory(url);
    } catch (err) {
      this.log("slack.socket.ws_construct_failed", { error: String(err) });
      this.scheduleReconnect();
      return;
    }
    this.ws = ws;
    ws.onopen = () => {
      this.attempt = 0;
      this.log("slack.socket.open");
      this.armWatchdog();
    };
    ws.onmessage = (ev) => this.onFrame(ev?.data);
    ws.onping = () => {
      if (this.ws === ws) this.armWatchdog(); // a server ping is liveness too
    };
    ws.onerror = (err) => this.log("slack.socket.error", { error: String(err) });
    ws.onclose = () => {
      ws.onping = null; // closed: no ping may count as liveness any more
      if (this.ws !== ws) return; // a stale socket we already replaced
      this.ws = null;
      this.clearTimer("watchdogTimer");
      if (this.running) this.scheduleReconnect();
    };
    this.armWatchdog();
  }

  private closeSocket(): void {
    const ws = this.ws;
    this.ws = null;
    if (!ws) return;
    ws.onopen = null;
    ws.onmessage = null;
    ws.onclose = null;
    ws.onerror = null;
    ws.onping = null;
    try {
      ws.close();
    } catch {
      /* already gone */
    }
  }

  /** Reconnect now-ish (fresh ladder) — used for `disconnect` frames. */
  private reconnectNow(reason: string): void {
    this.log("slack.socket.reconnect", { reason });
    this.clearTimer("watchdogTimer");
    this.closeSocket();
    this.attempt = 0;
    this.scheduleReconnect();
  }

  private scheduleReconnect(): void {
    if (!this.running || this.reconnectTimer !== null) return;
    const idx = Math.min(this.attempt, this.backoff.length - 1);
    const base = this.backoff[idx] ?? DEFAULT_BACKOFF_MS[0]!;
    this.attempt += 1;
    // Full jitter over the upper half of the rung: [base/2, base].
    const delay = Math.round(base / 2 + this.random() * (base / 2));
    this.log("slack.socket.reconnect_scheduled", { delay, attempt: this.attempt });
    this.reconnectTimer = this.setTimeoutFn(() => {
      this.reconnectTimer = null;
      void this.connect();
    }, delay);
  }

  private armWatchdog(): void {
    this.clearTimer("watchdogTimer");
    if (!this.running) return;
    this.watchdogTimer = this.setTimeoutFn(() => {
      this.watchdogTimer = null;
      this.log("slack.socket.ping_timeout", { timeout_ms: this.pingTimeoutMs });
      this.closeSocket();
      this.scheduleReconnect();
    }, this.pingTimeoutMs);
  }

  private clearTimer(which: "reconnectTimer" | "watchdogTimer"): void {
    const handle = this[which];
    if (handle !== null) {
      this.clearTimeoutFn(handle);
      this[which] = null;
    }
  }

  // ---- frames ---------------------------------------------------------------

  private onFrame(raw: unknown): void {
    this.armWatchdog(); // any frame from the server counts as liveness
    let frame: SocketFrame;
    try {
      frame = JSON.parse(typeof raw === "string" ? raw : String(raw)) as SocketFrame;
    } catch {
      this.log("slack.socket.bad_frame");
      return;
    }

    // ACK FIRST — within 3s, before any processing. The ack means "received",
    // never "handled"; processing is async and may still fail.
    if (typeof frame.envelope_id === "string" && frame.envelope_id) {
      try {
        this.ws?.send(JSON.stringify({ envelope_id: frame.envelope_id }));
      } catch (err) {
        this.log("slack.socket.ack_failed", { error: String(err) });
      }
    }

    switch (frame.type) {
      case "hello":
        this.connections = typeof frame.num_connections === "number" ? frame.num_connections : 0;
        this.log("slack.socket.hello", { num_connections: this.connections });
        return;
      case "disconnect":
        this.reconnectNow(frame.reason ?? "unknown");
        return;
      case "events_api":
        this.onEventsApi(frame);
        return;
      default:
        return; // slash_commands, interactive, anything else: not ours
    }
  }

  private onEventsApi(frame: SocketFrame): void {
    const payload = frame.payload;
    const event = payload?.event;
    if (!event || event.type !== "message") return;
    const normalized: SlackInboundEvent = {
      event_id: String(payload?.event_id ?? frame.envelope_id ?? ""),
      type: "message",
      channel: String(event.channel ?? ""),
      ts: String(event.ts ?? ""),
      ...(event.thread_ts !== undefined ? { thread_ts: String(event.thread_ts) } : {}),
      ...(event.user !== undefined ? { user: String(event.user) } : {}),
      text: typeof event.text === "string" ? event.text : "",
      ...(event.subtype !== undefined ? { subtype: String(event.subtype) } : {}),
      ...(event.bot_id !== undefined ? { bot_id: String(event.bot_id) } : {}),
      event_ts: String(event.event_ts ?? payload?.event_time ?? event.ts ?? ""),
    };
    const handler = this.handler;
    if (!handler) return;
    // Deferred to a microtask: the ack is already on the wire, and nothing the
    // handler does (however slow, however throwing) can delay or undo it.
    void Promise.resolve()
      .then(() => handler(normalized))
      .catch((err: unknown) => {
        this.log("slack.socket.handler_failed", {
          error: String(err),
          event_id: normalized.event_id,
        });
      });
  }
}

interface SocketFrame {
  type?: string;
  envelope_id?: string;
  reason?: string;
  num_connections?: number;
  payload?: {
    event_id?: string;
    event_time?: number;
    event?: Record<string, unknown> & { type?: string };
  };
}
