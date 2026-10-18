import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import diagnosticsChannel from "node:diagnostics_channel";
import {
  SlackSocketClient,
  bridgeNativeWebSocketPings,
  bridgedSocketCount,
  trackBridgedSocket,
  type SlackWebSocketLike,
} from "../src/slack/socket.js";
import type { SlackFetchFn, SlackInboundEvent } from "../src/slack/types.js";

/** A scriptable WebSocket: the test pushes frames, the client pushes acks. */
class FakeWs implements SlackWebSocketLike {
  onopen: ((ev: unknown) => void) | null = null;
  onmessage: ((ev: { data: unknown }) => void) | null = null;
  onclose: ((ev: unknown) => void) | null = null;
  onerror: ((ev: unknown) => void) | null = null;
  onping: (() => void) | null = null;
  readonly sent: string[] = [];
  closed = false;

  constructor(readonly url: string) {}

  send(data: string): void {
    this.sent.push(data);
  }
  close(): void {
    this.closed = true;
    this.onclose?.({});
  }
  /** Deliver a server frame. */
  push(frame: unknown): void {
    this.onmessage?.({ data: JSON.stringify(frame) });
  }
  /** A WebSocket-level ping frame: never reaches onmessage. */
  ping(): void {
    this.onping?.();
  }
  acks(): string[] {
    return this.sent.map((s) => (JSON.parse(s) as { envelope_id?: string }).envelope_id ?? "");
  }
}

function harness(opts: { pingTimeoutMs?: number; onSocket?: (ws: FakeWs) => void } = {}) {
  const sockets: FakeWs[] = [];
  const openCalls: string[] = [];
  const fetchFn = (async (url: string | URL) => {
    openCalls.push(String(url));
    return {
      ok: true,
      status: 200,
      json: async () => ({ ok: true, url: `wss://fake/${openCalls.length}` }),
    } as unknown as Response;
  }) as unknown as SlackFetchFn;

  const events: SlackInboundEvent[] = [];
  const client = new SlackSocketClient({
    appToken: "xapp-test",
    fetchFn,
    apiBase: "https://slack.test/api",
    webSocketFactory: (url) => {
      const ws = new FakeWs(url);
      sockets.push(ws);
      opts.onSocket?.(ws);
      return ws;
    },
    backoffMs: [1000, 2000],
    serverPingTimeoutMs: opts.pingTimeoutMs ?? 30_000,
    random: () => 1, // full-jitter upper bound: delay === the ladder rung
  });
  return { client, sockets, openCalls, events };
}

function messageEnvelope(envelopeId: string, over: Record<string, unknown> = {}) {
  return {
    type: "events_api",
    envelope_id: envelopeId,
    payload: {
      event_id: `Ev${envelopeId}`,
      event: {
        type: "message",
        channel: "C123",
        ts: "1712345678.123456",
        user: "U1",
        text: "hello there",
        event_ts: "1712345678.123456",
        ...over,
      },
    },
  };
}

beforeEach(() => vi.useFakeTimers());
afterEach(() => vi.useRealTimers());

describe("Socket Mode envelopes", () => {
  it("ignores a JSON null frame and still processes the next envelope", async () => {
    const h = harness();
    const events: SlackInboundEvent[] = [];
    await h.client.startSocket((event) => { events.push(event); });
    const ws = h.sockets[0]!;
    expect(() => ws.push(null)).not.toThrow();
    ws.push(messageEnvelope("after-null"));
    await vi.advanceTimersByTimeAsync(1);
    expect(events).toHaveLength(1);
    await h.client.stopSocket();
  });

  it("acks an envelope with its envelope_id, before processing it", async () => {
    const h = harness();
    const order: string[] = [];
    await h.client.startSocket((ev) => {
      order.push(`handled:${ev.event_id}`);
    });
    const ws = h.sockets[0]!;
    ws.push(messageEnvelope("env-1"));

    // The ack is synchronous with frame receipt; processing runs async after —
    // so at this point the ack is already on the wire and nothing was handled.
    expect(ws.acks()).toEqual(["env-1"]);
    expect(order).toEqual([]);

    await vi.advanceTimersByTimeAsync(1);
    expect(order).toEqual(["handled:Evenv-1"]);
  });

  it("normalizes a message event, keeping every ts a string", async () => {
    const h = harness();
    const seen: SlackInboundEvent[] = [];
    await h.client.startSocket((ev) => void seen.push(ev));
    h.sockets[0]!.push(
      messageEnvelope("env-2", {
        thread_ts: "1712345600.000100",
        subtype: "bot_message",
        bot_id: "B9",
      }),
    );
    await vi.advanceTimersByTimeAsync(1);

    expect(seen).toHaveLength(1);
    const ev = seen[0]!;
    expect(ev).toMatchObject({
      event_id: "Evenv-2",
      type: "message",
      channel: "C123",
      user: "U1",
      text: "hello there",
      subtype: "bot_message",
      bot_id: "B9",
    });
    expect(typeof ev.ts).toBe("string");
    expect(ev.ts).toBe("1712345678.123456");
    expect(ev.thread_ts).toBe("1712345600.000100");
    expect(typeof ev.event_ts).toBe("string");
  });

  it("ignores non-message events and non-events_api envelopes, but still acks them", async () => {
    const h = harness();
    const seen: SlackInboundEvent[] = [];
    await h.client.startSocket((ev) => void seen.push(ev));
    const ws = h.sockets[0]!;
    ws.push({
      type: "events_api",
      envelope_id: "env-a",
      payload: { event_id: "Eva", event: { type: "reaction_added" } },
    });
    ws.push({ type: "slash_commands", envelope_id: "env-b", payload: { command: "/qcr" } });
    ws.push({ type: "interactive", envelope_id: "env-c", payload: {} });
    await vi.advanceTimersByTimeAsync(1);

    expect(seen).toEqual([]);
    expect(ws.acks()).toEqual(["env-a", "env-b", "env-c"]);
  });

  it("does not ack frames that carry no envelope_id", async () => {
    const h = harness();
    await h.client.startSocket(() => {});
    const ws = h.sockets[0]!;
    ws.push({ type: "hello", num_connections: 1 });
    expect(ws.sent).toEqual([]);
  });
});

describe("hello frame", () => {
  it("exposes num_connections from the last hello", async () => {
    const h = harness();
    await h.client.startSocket(() => {});
    expect(h.client.numConnections).toBe(0);
    h.sockets[0]!.push({ type: "hello", num_connections: 1 });
    expect(h.client.numConnections).toBe(1);
    h.sockets[0]!.push({ type: "hello", num_connections: 3 });
    expect(h.client.numConnections).toBe(3);
  });
});

describe("reconnect", () => {
  it("reconnects on a `disconnect: refresh` frame, reopening a fresh socket url", async () => {
    const h = harness();
    await h.client.startSocket(() => {});
    expect(h.openCalls).toHaveLength(1);
    expect(h.openCalls[0]).toBe("https://slack.test/api/apps.connections.open");

    h.sockets[0]!.push({ type: "disconnect", reason: "refresh" });
    expect(h.sockets[0]!.closed).toBe(true);

    await vi.advanceTimersByTimeAsync(1000); // first ladder rung, jitter pinned to max
    expect(h.openCalls).toHaveLength(2);
    expect(h.sockets).toHaveLength(2);
    await h.client.stopSocket();
  });

  it("reconnects on `disconnect: link_disabled` too", async () => {
    const h = harness();
    await h.client.startSocket(() => {});
    h.sockets[0]!.push({ type: "disconnect", reason: "link_disabled" });
    await vi.advanceTimersByTimeAsync(1000);
    expect(h.openCalls).toHaveLength(2);
    await h.client.stopSocket();
  });

  it("walks the backoff ladder when apps.connections.open keeps failing", async () => {
    const openCalls: string[] = [];
    const fetchFn = (async (url: string | URL) => {
      openCalls.push(String(url));
      return {
        ok: true,
        status: 200,
        json: async () => ({ ok: false, error: "invalid_auth" }),
      } as unknown as Response;
    }) as unknown as SlackFetchFn;
    const client = new SlackSocketClient({
      appToken: "xapp-test",
      fetchFn,
      apiBase: "https://slack.test/api",
      webSocketFactory: () => new FakeWs("wss://never"),
      backoffMs: [1000, 2000],
      random: () => 1,
    });
    await client.startSocket(() => {});
    expect(openCalls).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(1000);
    expect(openCalls).toHaveLength(2);
    await vi.advanceTimersByTimeAsync(1000);
    expect(openCalls).toHaveLength(2); // second rung is 2000ms
    await vi.advanceTimersByTimeAsync(1000);
    expect(openCalls).toHaveLength(3);
    await client.stopSocket();
  });

  it("a stalled apps.connections.open is abandoned at its deadline and the ladder reconnects", async () => {
    let n = 0;
    const sockets: FakeWs[] = [];
    const fetchFn = (async (_url: string | URL, init: RequestInit = {}) => {
      n += 1;
      if (n === 1) {
        // Headers arrive; the body never does.
        return {
          ok: true,
          status: 200,
          json: () =>
            new Promise((_resolve, reject) =>
              init.signal?.addEventListener("abort", () => reject(new Error("aborted"))),
            ),
        } as unknown as Response;
      }
      return {
        ok: true,
        status: 200,
        json: async () => ({ ok: true, url: "wss://fake/2" }),
      } as unknown as Response;
    }) as unknown as SlackFetchFn;
    const logs: string[] = [];
    const client = new SlackSocketClient({
      appToken: "xapp-test",
      fetchFn,
      apiBase: "https://slack.test/api",
      webSocketFactory: (url) => {
        const ws = new FakeWs(url);
        sockets.push(ws);
        return ws;
      },
      backoffMs: [1000],
      random: () => 1,
      openTimeoutMs: 5_000,
      log: (m) => void logs.push(m),
    });
    const started = client.startSocket(() => {});
    await vi.advanceTimersByTimeAsync(5_000);
    await started; // startup is not held by the stalled open
    expect(logs).toContain("slack.socket.open_threw");
    await vi.advanceTimersByTimeAsync(1_000);
    expect(n).toBe(2);
    expect(sockets.map((w) => w.url)).toEqual(["wss://fake/2"]);
    await client.stopSocket();
  });

  it("stopSocket halts reconnection", async () => {
    const h = harness();
    await h.client.startSocket(() => {});
    await h.client.stopSocket();
    await vi.advanceTimersByTimeAsync(60_000);
    expect(h.openCalls).toHaveLength(1);
  });
});

describe("server-ping watchdog", () => {
  it("tears down and reconnects when no frame arrives within the timeout", async () => {
    const h = harness({ pingTimeoutMs: 5000 });
    await h.client.startSocket(() => {});
    expect(h.openCalls).toHaveLength(1);

    await vi.advanceTimersByTimeAsync(4999);
    expect(h.sockets[0]!.closed).toBe(false);

    await vi.advanceTimersByTimeAsync(1); // watchdog fires
    expect(h.sockets[0]!.closed).toBe(true);

    await vi.advanceTimersByTimeAsync(1000); // reconnect delay
    expect(h.openCalls).toHaveLength(2);
    await h.client.stopSocket();
  });

  it("each frame from the server rearms the watchdog", async () => {
    const h = harness({ pingTimeoutMs: 5000 });
    await h.client.startSocket(() => {});
    for (let i = 0; i < 4; i += 1) {
      await vi.advanceTimersByTimeAsync(4000);
      h.sockets[0]!.push({ type: "hello", num_connections: 1 });
    }
    expect(h.sockets[0]!.closed).toBe(false);
    expect(h.openCalls).toHaveLength(1);
    await h.client.stopSocket();
  });
});

describe("server-ping watchdog — protocol-level pings (selfscan 3dc7955f)", () => {
  it("WebSocket ping frames alone keep a quiet connection alive", async () => {
    const h = harness({ pingTimeoutMs: 5000 });
    await h.client.startSocket(() => {});
    h.sockets[0]!.onopen?.({});
    for (let i = 0; i < 6; i += 1) {
      await vi.advanceTimersByTimeAsync(4000);
      h.sockets[0]!.ping(); // no JSON frame at all — a quiet channel
    }
    expect(h.sockets[0]!.closed).toBe(false);
    expect(h.openCalls).toHaveLength(1);
    await h.client.stopSocket();
  });

  it("the native bridge routes undici's ping channel to that socket's onping", () => {
    bridgeNativeWebSocketPings();
    bridgeNativeWebSocketPings(); // idempotent: one subscription
    let a = 0;
    const wsA = { onping: () => void (a += 1) };
    const ch = diagnosticsChannel.channel("undici:websocket:ping");
    ch.publish({ websocket: wsA, payload: Buffer.alloc(0) });
    ch.publish({ websocket: {}, payload: Buffer.alloc(0) }); // no hook: ignored
    expect(a).toBe(1);
  });

  it("a ping naming no socket (undici 6 / Node 22) reaches every live bridged socket", () => {
    bridgeNativeWebSocketPings();
    let b = 0;
    const wsB = new FakeWs("wss://fake/b");
    wsB.onping = () => void (b += 1);
    trackBridgedSocket(wsB);
    const ch = diagnosticsChannel.channel("undici:websocket:ping");
    ch.publish({ payload: Buffer.alloc(0) }); // Node 22's message shape
    expect(b).toBe(1);
    wsB.onping = null; // torn down
    ch.publish({ payload: Buffer.alloc(0) });
    expect(b).toBe(1);
  });

  it("a socket leaves the bridge when torn down or closed, with no ping needed", async () => {
    const before = bridgedSocketCount();
    const h = harness({
      pingTimeoutMs: 5000,
      onSocket: (ws: FakeWs) => trackBridgedSocket(ws),
    });
    await h.client.startSocket(() => {});
    h.sockets[0]!.onopen?.({});
    expect(bridgedSocketCount()).toBe(before + 1);
    await vi.advanceTimersByTimeAsync(5001); // the watchdog tears it down
    expect(bridgedSocketCount()).toBe(before);
    await vi.advanceTimersByTimeAsync(2000); // the reconnect builds the next
    expect(h.sockets).toHaveLength(2);
    expect(bridgedSocketCount()).toBe(before + 1);
    h.sockets[1]!.onclose?.({}); // the server closes it
    expect(bridgedSocketCount()).toBe(before);
    await h.client.stopSocket();
  });
});

describe("stop during apps.connections.open (selfscan bd41fe9a)", () => {
  it("a socket whose open resolves after stopSocket is never built", async () => {
    let release: (() => void) | null = null;
    const sockets: FakeWs[] = [];
    const fetchFn = (async () => {
      await new Promise<void>((r) => (release = r));
      return {
        ok: true,
        status: 200,
        json: async () => ({ ok: true, url: "wss://fake/late" }),
      } as unknown as Response;
    }) as unknown as SlackFetchFn;
    const client = new SlackSocketClient({
      appToken: "xapp-test",
      fetchFn,
      apiBase: "https://slack.test/api",
      webSocketFactory: (url) => {
        const ws = new FakeWs(url);
        sockets.push(ws);
        return ws;
      },
      backoffMs: [1000],
      random: () => 1,
    });
    const started = client.startSocket(() => {});
    await vi.advanceTimersByTimeAsync(1);
    await client.stopSocket();
    release!();
    await started;
    await vi.advanceTimersByTimeAsync(60_000);
    expect(sockets).toHaveLength(0);
  });
});
