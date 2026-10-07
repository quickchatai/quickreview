// F1 — the memory forward caps its concurrent relays under the ssh
// session limit.
//
// The defect (2026-10-07): every accepted connection spawned its own relay —
// one ssh SESSION on the forward's one shared connection — and the VM's
// sshd refuses sessions past `MaxSessions` (10). The store's 8-way read sweep
// beside the TUI's polls went over it, the extra sessions were refused, and
// `qcr memory relayout` saw `fetch failed`. Pinned here, all on fake relays
// (no ssh, no docker — PassThrough streams standing in for a child's stdio):
//
//   * never more than `maxRelays` relays open at once, every request answered
//     with its OWN response;
//   * waiting requests served first come, first served;
//   * a request that waits too long — or finds the queue full — gets a clean
//     503 (an answer, then a FIN), never a hang or a reset;
//   * a relay yields only BETWEEN requests (idle keep-alive, or a busy
//     connection at a boundary), never mid-exchange and never when its bytes
//     are not plain request/response HTTP;
//   * the TUI-owned forward is the same forward with the same cap;
//   * the cap and the queue are reported (log, stats, `status`, the TUI row).
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { connect, type Socket } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough, Writable } from "node:stream";
import { afterEach, describe, expect, it } from "vitest";
import { MemoryForward, relaySummary, type ForwardModule } from "../src/tui/memforward.js";

const forward = await import("../scripts/companion-memory-forward.mjs");

// ---- fakes --------------------------------------------------------------------

type Handler = (...args: unknown[]) => void;

interface FakeRelay {
  id: number;
  stdin: Writable | PassThrough;
  stdout: PassThrough;
  stderr: PassThrough;
  /** Everything the forward wrote into this relay. */
  text: string;
  killed: boolean;
  exited: boolean;
  on(ev: string, cb: Handler): void;
  kill(sig?: string): void;
  respond(body: string): void;
  /** The relay ends on its own (the server closed its side): `exit`, then its
   * last stdout bytes (`tail`), then `close` — a child's exit can come before
   * the pipe has delivered everything it wrote. */
  die(code: number, tail?: string): void;
}

const httpRequest = (path: string): string =>
  `GET ${path} HTTP/1.1\r\nhost: 127.0.0.1:1933\r\n\r\n`;
const httpResponse = (body: string): string =>
  `HTTP/1.1 200 OK\r\ncontent-type: text/plain\r\ncontent-length: ${Buffer.byteLength(body)}\r\n\r\n${body}`;

/** A relay factory that counts how many fakes are alive at once — spawned and
 * not yet exited, exactly what an ssh session on the master is. With
 * `autoRespond`, each relay answers every request it is sent with that
 * request's path as the body (so a response can never be mistaken for another
 * connection's). With `stuckStdin`, a relay's stdin takes the first chunk and
 * never drains — a full pipe, so every write to it returns false. */
function relays(opts: { autoRespond?: boolean; delayMs?: number; stuckStdin?: boolean } = {}) {
  const all: FakeRelay[] = [];
  let alive = 0;
  let peakAlive = 0;
  const spawnRelay = (): FakeRelay => {
    const handlers = new Map<string, Handler[]>();
    const emit = (ev: string, ...args: unknown[]): void => {
      for (const cb of handlers.get(ev) ?? []) cb(...args);
    };
    let answered = 0;
    const pass = new PassThrough();
    const stuck = new Writable({
      highWaterMark: 1,
      write(chunk: Buffer) {
        r.text += chunk.toString("latin1"); // and never calls back
      },
    });
    const r: FakeRelay = {
      id: all.length,
      stdin: opts.stuckStdin ? stuck : pass,
      stdout: new PassThrough(),
      stderr: new PassThrough(),
      text: "",
      killed: false,
      exited: false,
      on(ev, cb) {
        handlers.set(ev, [...(handlers.get(ev) ?? []), cb]);
      },
      kill() {
        if (r.exited) return;
        r.killed = true;
        // A real child exits a moment AFTER the signal: the slot must not be
        // counted free until then. And ssh catches SIGTERM and exits 255 —
        // the same code a relay that never connected exits with.
        setImmediate(() => {
          if (r.exited) return;
          r.exited = true;
          alive -= 1;
          emit("exit", 255, null);
          emit("close", 255, null);
        });
      },
      respond(body) {
        r.stdout.write(httpResponse(body));
      },
      die(code, tail) {
        if (r.exited) return;
        r.exited = true;
        alive -= 1;
        emit("exit", code, null);
        if (tail === undefined) r.stdout.end();
        else r.stdout.end(tail);
        setImmediate(() => emit("close", code, null));
      },
    };
    pass.on("data", (d: Buffer) => {
      r.text += d.toString("latin1");
      if (!opts.autoRespond) return;
      const paths = [...r.text.matchAll(/GET (\S+) HTTP\/1\.1\r\n/g)].map((m) => m[1]!);
      while (answered < paths.length) {
        const p = paths[answered++]!;
        setTimeout(() => {
          if (!r.exited) r.respond(p);
        }, opts.delayMs ?? 0);
      }
    });
    alive += 1;
    peakAlive = Math.max(peakAlive, alive);
    all.push(r);
    return r;
  };
  return { spawnRelay, all, alive: () => alive, peakAlive: () => peakAlive };
}

/** A keep-alive HTTP/1.1 client on a raw socket, reading responses framed by
 * Content-Length — the shape every real client of the forward has. */
class Client {
  readonly socket: Socket;
  buf = "";
  ended = false;
  errored = false;
  closed = false;
  private waiters: Array<() => void> = [];
  constructor(port: number) {
    this.socket = connect(port, "127.0.0.1");
    this.socket.on("data", (d: Buffer) => {
      this.buf += d.toString("latin1");
      this.wake();
    });
    this.socket.on("end", () => {
      this.ended = true;
      this.wake();
    });
    this.socket.on("error", () => {
      this.errored = true;
      this.wake();
    });
    this.socket.on("close", () => {
      this.closed = true;
      this.wake();
    });
  }
  connected(): Promise<unknown> {
    return new Promise((r) => this.socket.once("connect", r));
  }
  send(path: string): void {
    this.socket.write(httpRequest(path));
  }
  async response(timeoutMs = 4_000): Promise<{ status: number; head: string; body: string }> {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      const r = this.take();
      if (r) return r;
      if (this.ended || this.errored || Date.now() > deadline)
        throw new Error(
          `no response (ended=${this.ended}, errored=${this.errored}, buf=${JSON.stringify(this.buf)})`,
        );
      await new Promise<void>((res) => {
        this.waiters.push(res);
        setTimeout(res, 20);
      });
    }
  }
  async request(path: string): Promise<string> {
    this.send(path);
    return (await this.response()).body;
  }
  close(): void {
    this.socket.destroy();
  }
  private take(): { status: number; head: string; body: string } | null {
    const end = this.buf.indexOf("\r\n\r\n");
    if (end === -1) return null;
    const head = this.buf.slice(0, end);
    const len = Number(/content-length: (\d+)/i.exec(head)?.[1] ?? 0);
    if (this.buf.length < end + 4 + len) return null;
    const body = this.buf.slice(end + 4, end + 4 + len);
    this.buf = this.buf.slice(end + 4 + len);
    return { status: Number(head.slice(9, 12)), head, body };
  }
  private wake(): void {
    const w = this.waiters;
    this.waiters = [];
    for (const f of w) f();
  }
}

async function until(pred: () => boolean, ms = 4_000): Promise<void> {
  const deadline = Date.now() + ms;
  while (!pred()) {
    if (Date.now() > deadline) throw new Error("condition not met in time");
    await new Promise((r) => setTimeout(r, 5));
  }
}

const BASE_CFG = {
  ...forward.DEFAULTS,
  binds: ["127.0.0.1"],
  port: 0,
  controlPath: "/home/x/.ssh/qcr-memfwd-%C",
  local: false,
};

type Forwarder = ReturnType<typeof forward.createForwarder>;
const opened: Forwarder[] = [];
afterEach(() => {
  for (const f of opened.splice(0)) f.close();
});

async function start(
  cfg: Record<string, unknown>,
  r: ReturnType<typeof relays>,
  extra: { timings?: Record<string, number>; log?: (l: string) => void } = {},
): Promise<{ fwd: Forwarder; port: number; lines: string[] }> {
  const lines: string[] = [];
  const fwd = forward.createForwarder(
    { ...BASE_CFG, ...cfg },
    {
      spawnRelay: r.spawnRelay,
      log: extra.log ?? ((l: string) => lines.push(l)),
      ...(extra.timings ? { timings: extra.timings } : {}),
    },
  );
  opened.push(fwd);
  await fwd.listen();
  const port = (fwd.addresses() as Array<{ port: number }>)[0]!.port;
  return { fwd, port, lines };
}

// ---- the cap -------------------------------------------------------------------

describe("the relay cap (F1)", () => {
  it("defaults under sshd's MaxSessions, with room to spare", () => {
    expect(forward.SSHD_DEFAULT_MAX_SESSIONS).toBe(10);
    expect(forward.DEFAULTS.maxRelays).toBe(6);
    expect(forward.DEFAULTS.maxRelays).toBeLessThan(forward.SSHD_DEFAULT_MAX_SESSIONS);
    expect(forward.forwardLimits({})).toEqual({
      maxRelays: 6,
      queueMax: 64,
      queueTimeoutMs: 15_000,
    });
  });

  it("never opens more than maxRelays relays at once, and answers every request with its own response", async () => {
    const r = relays({ autoRespond: true, delayMs: 15 });
    const { fwd, port, lines } = await start({ maxRelays: 3 }, r);
    const results = await Promise.all(
      Array.from({ length: 10 }, async (_, i) => {
        const c = new Client(port);
        await c.connected();
        const body = await c.request(`/r${i}`);
        c.close();
        return body;
      }),
    );
    expect(results).toEqual(Array.from({ length: 10 }, (_, i) => `/r${i}`));
    // The fakes' own count (spawned, not yet exited) and the forward's agree.
    expect(r.peakAlive()).toBeLessThanOrEqual(3);
    expect(fwd.stats().peakOpen).toBeLessThanOrEqual(3);
    expect(r.all.length).toBeGreaterThanOrEqual(10);
    // Queueing happened, was said once, and its drain was summarised.
    expect(fwd.stats().servedFromQueue).toBeGreaterThan(0);
    await until(() => lines.some((l) => l.startsWith("relay queue drained")));
    expect(lines.filter((l) => l.startsWith("relay cap reached"))).toHaveLength(1);
    expect(lines.some((l) => l.includes("at most 3 relays at once"))).toBe(true);
    // No relay ever carried a second connection's request.
    for (const relay of r.all)
      expect([...relay.text.matchAll(/GET (\S+)/g)].length).toBeLessThanOrEqual(1);
  });

  it("serves waiting requests first come, first served", async () => {
    const r = relays();
    const { fwd, port } = await start({ maxRelays: 1 }, r);
    const names = ["a", "b", "c", "d"];
    const clients: Client[] = [];
    for (const name of names) {
      const c = new Client(port);
      await c.connected();
      c.send(`/${name}`);
      clients.push(c);
      if (name === "a") await until(() => r.all[0]?.text.includes("/a") === true);
      else await until(() => fwd.stats().queued === clients.length - 1);
    }
    for (let i = 0; i < names.length; i++) {
      await until(() => r.all.length === i + 1 && r.all[i]!.text.includes(`/${names[i]}`));
      r.all[i]!.respond(names[i]!);
      expect((await clients[i]!.response()).body).toBe(names[i]);
      clients[i]!.close();
    }
    expect(r.all.map((x) => /GET (\S+)/.exec(x.text)?.[1])).toEqual(["/a", "/b", "/c", "/d"]);
    expect(r.peakAlive()).toBe(1);
    expect(fwd.stats().servedFromQueue).toBe(3);
  });

  it("refuses a request that waited past the queue timeout with a clean 503 — an answer, then a FIN", async () => {
    const r = relays();
    const { fwd, port, lines } = await start({ maxRelays: 1, queueTimeoutMs: 80 }, r);
    const a = new Client(port);
    await a.connected();
    a.send("/a"); // never answered while B waits
    await until(() => r.all[0]?.text.includes("/a") === true);
    const b = new Client(port);
    await b.connected();
    b.send("/b");
    const started = Date.now();
    const res = await b.response();
    expect(Date.now() - started).toBeGreaterThanOrEqual(60);
    expect(res.status).toBe(503);
    expect(res.head.toLowerCase()).toContain("connection: close");
    const envelope = JSON.parse(res.body) as {
      status: string;
      error: { code: string; message: string };
    };
    expect(envelope.status).toBe("error");
    expect(envelope.error.code).toBe("FORWARD_BUSY");
    expect(envelope.error.message).toContain("waited");
    // A FIN, not a reset: the client read its answer and then saw the end.
    await until(() => b.ended);
    expect(b.errored).toBe(false);
    // B never got a relay, and A's — mid-exchange — was never touched.
    expect(r.all).toHaveLength(1);
    expect(r.all[0]!.killed).toBe(false);
    expect(fwd.stats()).toMatchObject({ refusedTimeout: 1, queued: 0 });
    expect(lines.some((l) => l.startsWith("refused a request"))).toBe(true);
    // A's answer still arrives on its relay.
    r.all[0]!.respond("a");
    expect((await a.response()).body).toBe("a");
  });

  it("refuses at once when the wait queue is full — and logs one refusal line a minute, counting the rest", async () => {
    const r = relays();
    const { fwd, port, lines } = await start(
      { maxRelays: 1, queueMax: 1, queueTimeoutMs: 10_000 },
      r,
    );
    const a = new Client(port);
    await a.connected();
    a.send("/a");
    await until(() => r.all[0]?.text.includes("/a") === true);
    const b = new Client(port);
    await b.connected();
    b.send("/b");
    await until(() => fwd.stats().queued === 1);
    const c = new Client(port);
    await c.connected();
    c.send("/c");
    const res = await c.response(2_000); // long before the 10 s timeout
    expect(res.status).toBe(503);
    expect(res.body).toContain("full");
    expect(fwd.stats()).toMatchObject({ refusedFull: 1, queued: 1 });
    // A second refusal inside the minute is counted, not logged.
    const d = new Client(port);
    await d.connected();
    d.send("/d");
    expect((await d.response(2_000)).status).toBe(503);
    expect(fwd.stats()).toMatchObject({ refusedFull: 2, queued: 1 });
    expect(lines.filter((l) => l.startsWith("refused a request"))).toHaveLength(1);
  });

  it("refuses a request whose body is still arriving with a 503 and a clean close — never a reset — at the timeout and at a full queue", async () => {
    // The shape of a refused memory batch-write: a multi-MiB POST, far past the
    // hold limit, still being written when the answer goes out. The forward
    // must read and drop the rest before it closes, or the close resets the
    // 503 away.
    const body = "x".repeat(4 * 1024 * 1024);
    const post = `POST /api/v1/content/batch-write HTTP/1.1\r\ncontent-length: ${body.length}\r\n\r\n${body}`;
    for (const shape of ["timeout", "full"] as const) {
      const r = relays();
      const { fwd, port } = await start(
        shape === "timeout"
          ? { maxRelays: 1, queueTimeoutMs: 80 }
          : { maxRelays: 1, queueMax: 1, queueTimeoutMs: 10_000 },
        r,
        { timings: { holdLimitBytes: 64 } },
      );
      const a = new Client(port);
      await a.connected();
      a.send("/a"); // holds the only relay, never answered
      await until(() => r.all[0]?.text.includes("/a") === true);
      if (shape === "full") {
        const b = new Client(port);
        await b.connected();
        b.send("/b");
        await until(() => fwd.stats().queued === 1);
      }
      const c = new Client(port);
      await c.connected();
      c.socket.write(post);
      expect((await c.response()).status, shape).toBe(503);
      await until(() => c.ended);
      // Both sides closed with a FIN once the rest was read and dropped: no
      // reset, and no error on the client's half still writing.
      await until(() => c.closed);
      expect(c.errored, shape).toBe(false);
      expect(fwd.stats()[shape === "full" ? "refusedFull" : "refusedTimeout"], shape).toBe(1);
      expect(r.all, shape).toHaveLength(1);
    }
  });

  it("an idle keep-alive connection hands its relay over; its next request gets a fresh one on the same connection", async () => {
    const r = relays({ autoRespond: true });
    // minLeaseMs far past the client's wait: only the IDLE yield can let B in.
    const { fwd, port } = await start({ maxRelays: 1 }, r, {
      timings: { idleYieldMs: 10, rebalanceMs: 10, minLeaseMs: 60_000 },
    });
    const a = new Client(port);
    await a.connected();
    expect(await a.request("/a1")).toBe("/a1");
    // A stays connected and idle — the browser/undici keep-alive shape that
    // would otherwise sit on the slot for seconds or minutes.
    const b = new Client(port);
    await b.connected();
    expect(await b.request("/b")).toBe("/b");
    expect(r.all[0]!.killed).toBe(true);
    expect(r.all[1]!.text).toContain("/b");
    // A's connection survived: its next request rides a NEW relay, which
    // never saw A's first request.
    expect(await a.request("/a2")).toBe("/a2");
    const third = r.all[2]!;
    expect(third.text).toContain("/a2");
    expect(third.text).not.toContain("/a1");
    expect(a.ended || a.errored).toBe(false);
    expect(r.peakAlive()).toBe(1);
    expect(fwd.stats().yielded).toBeGreaterThanOrEqual(2);
  });

  it("a busy keep-alive connection yields at a request boundary, so a waiter is never starved", async () => {
    // The relayout shape: a client looping on one kept-alive connection. A
    // queue that advanced only when a connection CLOSED would hold B until A
    // stopped; the yield at A's boundary lets B in while A keeps going.
    const r = relays({ autoRespond: true });
    const { port } = await start({ maxRelays: 1 }, r, { timings: { minLeaseMs: 30 } });
    const a = new Client(port);
    await a.connected();
    let bAnswered = false;
    let aRequests = 0;
    const loop = (async () => {
      while (!bAnswered && aRequests < 2_000) {
        const path = `/a${aRequests++}`;
        expect(await a.request(path)).toBe(path); // always its own answer
      }
    })();
    await until(() => aRequests > 3);
    const b = new Client(port);
    await b.connected();
    expect(await b.request("/b")).toBe("/b");
    bAnswered = true;
    await loop;
    expect(aRequests).toBeLessThan(2_000); // B got in while A was still looping
    // No relay ever carried both connections' bytes.
    for (const relay of r.all) {
      const sawA = relay.text.includes("GET /a");
      const sawB = relay.text.includes("GET /b");
      expect(sawA && sawB).toBe(false);
    }
    expect(r.peakAlive()).toBe(1);
  });

  it("one waiter takes ONE idle relay — the longest-quiet — not every idle one", async () => {
    const r = relays({ autoRespond: true });
    const { fwd, port } = await start({ maxRelays: 3 }, r, {
      timings: { idleYieldMs: 10, rebalanceMs: 10, minLeaseMs: 60_000 },
    });
    for (const name of ["a", "b", "c"]) {
      const c = new Client(port);
      await c.connected();
      expect(await c.request(`/${name}`)).toBe(`/${name}`); // then stays open, idle
    }
    expect(r.all).toHaveLength(3);
    await new Promise((res) => setTimeout(res, 30)); // all three idle past idleYieldMs
    const d = new Client(port);
    await d.connected();
    expect(await d.request("/d")).toBe("/d");
    expect(r.all.slice(0, 3).map((x) => x.killed)).toEqual([true, false, false]);
    expect(fwd.stats().yielded).toBe(1);
  });

  it("a relay the forward stops itself is never reported as failing — even one that never moved a byte", async () => {
    // ssh exits 255 on SIGTERM, as a relay that never connected does. A
    // connection takes its relay at accept; one that never sends leaves that
    // relay with no byte moved — and handing it over must not read as a broken
    // chain in the journal.
    const r = relays({ autoRespond: true });
    const { fwd, port, lines } = await start({ maxRelays: 1 }, r, {
      timings: { idleYieldMs: 10, rebalanceMs: 10, minLeaseMs: 60_000 },
    });
    const a = new Client(port);
    await a.connected();
    await until(() => r.all.length === 1); // granted at accept, never used
    const b = new Client(port);
    await b.connected();
    expect(await b.request("/b")).toBe("/b");
    expect(r.all[0]!.killed).toBe(true);
    expect(r.all[0]!.text).toBe("");
    expect(fwd.stats().yielded).toBe(1);
    expect(lines.filter((l) => l.startsWith("relay failing"))).toEqual([]);
    expect(a.ended || a.errored).toBe(false);
  });

  it("a relay that ends between requests with its stdin full leaves the connection READING — its next request gets a new relay", async () => {
    // A full relay stdin pauses the client's socket until that relay drains,
    // and a relay that answered and exited never drains. Without a resume the
    // connection's next request would be neither read nor queued: a silent
    // hang where, before F1, the client at least saw a close.
    const r = relays({ stuckStdin: true });
    const { port } = await start({ maxRelays: 2 }, r);
    const a = new Client(port);
    await a.connected();
    a.send("/a");
    await until(() => r.all[0]?.text.includes("/a") === true);
    r.all[0]!.respond("a");
    expect((await a.response()).body).toBe("a");
    r.all[0]!.die(0);
    a.send("/b");
    await until(() => r.all[1]?.text.includes("/b") === true);
    r.all[1]!.respond("b");
    expect((await a.response()).body).toBe("b");
    expect(a.ended || a.errored).toBe(false);
  });

  it("never takes a relay away in the middle of an exchange — only at its boundary", async () => {
    const r = relays();
    const { port } = await start({ maxRelays: 1 }, r, {
      timings: { minLeaseMs: 0, idleYieldMs: 0, rebalanceMs: 10 },
    });
    const a = new Client(port);
    await a.connected();
    a.send("/a");
    await until(() => r.all[0]?.text.includes("/a") === true);
    const b = new Client(port);
    await b.connected();
    b.send("/b");
    // Many rebalance ticks pass while A's response is owed: A keeps its relay.
    await new Promise((res) => setTimeout(res, 150));
    expect(r.all[0]!.killed).toBe(false);
    expect(r.all).toHaveLength(1);
    // A's response completes → A is between requests → B gets the slot.
    r.all[0]!.respond("a");
    expect((await a.response()).body).toBe("a");
    await until(() => r.all.length === 2);
    expect(r.all[0]!.killed).toBe(true);
    r.all[1]!.respond("b");
    expect((await b.response()).body).toBe("b");
  });

  it("a connection that is not plain request/response HTTP keeps its relay to the end", async () => {
    const r = relays();
    const { fwd, port } = await start({ maxRelays: 1, queueTimeoutMs: 100 }, r, {
      timings: { minLeaseMs: 0, idleYieldMs: 0, rebalanceMs: 10 },
    });
    const a = new Client(port);
    await a.connected();
    a.socket.write("hello\n"); // no request line: opaque from the first byte
    await until(() => r.all[0]?.text === "hello\n");
    r.all[0]!.stdout.write("hi\n");
    await until(() => a.buf === "hi\n");
    const b = new Client(port);
    await b.connected();
    b.send("/b");
    expect((await b.response()).status).toBe(503);
    expect(r.all[0]!.killed).toBe(false);
    expect(fwd.stats()).toMatchObject({ unyielding: 1, refusedTimeout: 1 });
  });

  it("a waiting request's bytes reach its relay whole and in order, past the hold limit", async () => {
    const r = relays();
    const { port } = await start({ maxRelays: 1 }, r, { timings: { holdLimitBytes: 64 } });
    const a = new Client(port);
    await a.connected();
    a.send("/a");
    await until(() => r.all[0]?.text.includes("/a") === true);
    // B's request is far bigger than the hold limit: its socket is paused
    // while it waits, and resumed when its relay arrives.
    const body = Array.from({ length: 20_000 }, (_, i) => String.fromCharCode(97 + (i % 26))).join(
      "",
    );
    const request = `POST /big HTTP/1.1\r\ncontent-length: ${body.length}\r\n\r\n${body}`;
    const b = new Client(port);
    await b.connected();
    b.socket.write(request);
    await new Promise((res) => setTimeout(res, 30));
    r.all[0]!.respond("a");
    expect((await a.response()).body).toBe("a");
    a.close();
    await until(() => r.all[1]?.text.length === request.length);
    expect(r.all[1]!.text).toBe(request);
  });

  it("a relay that ends between requests leaves its connection open; one that ends mid-exchange ends it after its last bytes", async () => {
    const r = relays();
    const { port } = await start({ maxRelays: 2 }, r);
    const a = new Client(port);
    await a.connected();
    a.send("/a1");
    await until(() => r.all[0]?.text.includes("/a1") === true);
    r.all[0]!.respond("a1");
    expect((await a.response()).body).toBe("a1");
    // The server closes the idle keep-alive connection: the CLIENT's
    // connection is not cut — its next request simply gets a new relay.
    r.all[0]!.die(0);
    await new Promise((res) => setTimeout(res, 20));
    expect(a.ended || a.errored).toBe(false);
    a.send("/a2");
    await until(() => r.all[1]?.text.includes("/a2") === true);
    r.all[1]!.respond("a2");
    expect((await a.response()).body).toBe("a2");
    // Mid-exchange the loss must show — but only after the relay's last
    // bytes reached the client, and as a FIN, not a reset.
    // The partial response is the relay's TAIL: it reaches the forward after
    // the child's exit, before its close — the forward must still pass it on.
    r.all[1]!.text = "";
    a.send("/a3");
    await until(() => r.all[1]!.text.includes("/a3"));
    r.all[1]!.die(0, "HTTP/1.1 200 OK\r\ncontent-length: 10\r\n\r\nabc");
    await until(() => a.ended);
    expect(a.buf).toContain("abc");
    expect(a.errored).toBe(false);
  });

  it("warns when the cap is not under sshd's default MaxSessions — ssh mode only", async () => {
    const r = relays();
    const ssh = await start({ maxRelays: 10 }, r);
    expect(ssh.lines.some((l) => l.startsWith("WARNING: --max-relays 10"))).toBe(true);
    const local = await start({ maxRelays: 10, local: true }, r);
    expect(local.lines.some((l) => l.startsWith("WARNING"))).toBe(false);
  });

  it("close() tears down waiting connections and live relays alike", async () => {
    const r = relays();
    const { fwd, port } = await start({ maxRelays: 1 }, r);
    const a = new Client(port);
    await a.connected();
    a.send("/a");
    await until(() => r.all[0]?.text.includes("/a") === true);
    const b = new Client(port);
    await b.connected();
    b.send("/b");
    await until(() => fwd.stats().queued === 1);
    fwd.close();
    expect(r.all[0]!.killed).toBe(true);
    expect(fwd.liveRelays()).toBe(0);
    expect(fwd.stats().queued).toBe(0);
    await until(
      () =>
        (a.ended || a.errored || a.socket.destroyed) &&
        (b.ended || b.errored || b.socket.destroyed),
    );
  });
});

// ---- the exchange tracker ----------------------------------------------------

describe("createExchangeTracker — when a relay is BETWEEN requests", () => {
  const buf = (s: string): Buffer => Buffer.from(s, "latin1");

  it("is at rest after a whole request and a whole Content-Length response", () => {
    const t = forward.createExchangeTracker();
    expect(t.atRest()).toBe(true); // nothing begun
    t.client(buf(httpRequest("/x")));
    expect(t.phase()).toBe("response-wait");
    t.server(buf(httpResponse("hello")));
    expect(t.atRest()).toBe(true);
    expect(t.exchanges()).toBe(1);
  });

  it("frames heads and bodies split anywhere across chunks", () => {
    const t = forward.createExchangeTracker();
    const req = `POST /w HTTP/1.1\r\ncontent-length: 4\r\n\r\nbody`;
    for (const ch of req) t.client(buf(ch));
    expect(t.phase()).toBe("response-wait");
    const res = httpResponse("0123456789");
    t.server(buf(res.slice(0, 7)));
    t.server(buf(res.slice(7, res.length - 3)));
    expect(t.atRest()).toBe(false);
    t.server(buf(res.slice(res.length - 3)));
    expect(t.atRest()).toBe(true);
  });

  it("knows a HEAD response, a 204 and a 304 carry no body", () => {
    for (const [method, status] of [
      ["HEAD", "200 OK"],
      ["GET", "204 No Content"],
      ["GET", "304 Not Modified"],
    ] as const) {
      const t = forward.createExchangeTracker();
      t.client(buf(`${method} /x HTTP/1.1\r\nhost: h\r\n\r\n`));
      t.server(buf(`HTTP/1.1 ${status}\r\ncontent-length: 99\r\n\r\n`));
      expect(t.atRest(), `${method} ${status}`).toBe(true);
    }
  });

  it("goes opaque — never at rest again — on anything it cannot frame exactly", () => {
    const cases: Array<[string, (t: ReturnType<typeof forward.createExchangeTracker>) => void]> = [
      ["not HTTP", (t) => t.client(buf("hello\n\r\n\r\n"))],
      [
        "chunked response",
        (t) => {
          t.client(buf(httpRequest("/x")));
          t.server(
            buf("HTTP/1.1 200 OK\r\ntransfer-encoding: chunked\r\n\r\n5\r\nhello\r\n0\r\n\r\n"),
          );
        },
      ],
      [
        "close-delimited response",
        (t) => {
          t.client(buf(httpRequest("/x")));
          t.server(buf("HTTP/1.1 200 OK\r\ncontent-type: text/plain\r\n\r\nbody"));
        },
      ],
      [
        "websocket upgrade",
        (t) => {
          t.client(buf("GET /ws HTTP/1.1\r\nupgrade: websocket\r\nconnection: upgrade\r\n\r\n"));
        },
      ],
      [
        "101 switching protocols",
        (t) => {
          t.client(buf(httpRequest("/x")));
          t.server(buf("HTTP/1.1 101 Switching Protocols\r\n\r\n"));
        },
      ],
      ["pipelined second request", (t) => t.client(buf(httpRequest("/1") + httpRequest("/2")))],
      ["server speaks unasked", (t) => t.server(buf(httpResponse("x")))],
      [
        "contradictory content-length",
        (t) => t.client(buf("POST /x HTTP/1.1\r\ncontent-length: 3\r\ncontent-length: 4\r\n\r\n")),
      ],
      ["oversized head", (t) => t.client(buf(`GET /${"x".repeat(70 * 1024)}`))],
    ];
    for (const [name, drive] of cases) {
      const t = forward.createExchangeTracker();
      drive(t);
      expect(t.opaque(), name).toBe(true);
      t.client(buf(httpRequest("/again")));
      t.server(buf(httpResponse("again")));
      expect(t.atRest(), `${name}: opaque is for good`).toBe(false);
    }
  });

  it("never changes a byte — it only watches (the 503 is the forward's only answer of its own)", () => {
    const res = forward.busyResponse("busy") as string;
    const t = forward.createExchangeTracker();
    t.client(buf(httpRequest("/x")));
    t.server(buf(res));
    expect(t.atRest()).toBe(true); // a well-framed response a client can read
    expect(res).toMatch(/^HTTP\/1\.1 503 /);
    expect(res.toLowerCase()).toContain("connection: close");
  });
});

// ---- config: one parser for both entrypoints -----------------------------------

describe("parseArgs carries the cap — flags, env, and refusal of a bad value", () => {
  it("defaults, flags and env", () => {
    const d = forward.parseArgs(["run"], {} as NodeJS.ProcessEnv).cfg;
    expect(d).toMatchObject({ maxRelays: 6, queueMax: 64, queueTimeoutMs: 15_000 });
    const f = forward.parseArgs(
      ["run", "--max-relays", "4", "--queue-max", "8", "--queue-timeout", "3"],
      {} as NodeJS.ProcessEnv,
    ).cfg;
    expect(f).toMatchObject({ maxRelays: 4, queueMax: 8, queueTimeoutMs: 3_000 });
    const e = forward.parseArgs(["run"], {
      QCR_MEMORY_MAX_RELAYS: "3",
      QCR_MEMORY_QUEUE_MAX: "5",
      QCR_MEMORY_QUEUE_TIMEOUT_S: "7",
    } as NodeJS.ProcessEnv).cfg;
    expect(e).toMatchObject({ maxRelays: 3, queueMax: 5, queueTimeoutMs: 7_000 });
    // A flag beats the env.
    expect(
      forward.parseArgs(["run", "--max-relays=2"], {
        QCR_MEMORY_MAX_RELAYS: "3",
      } as NodeJS.ProcessEnv).cfg.maxRelays,
    ).toBe(2);
  });

  it("refuses a cap that is not a whole number of at least 1 — never a silent fallback", () => {
    for (const bad of ["0", "-1", "2.5", "six", "true"]) {
      expect(() =>
        forward.parseArgs(["run", "--max-relays", bad], {} as NodeJS.ProcessEnv),
      ).toThrow(/at least 1/);
    }
    expect(() =>
      forward.parseArgs(["run"], { QCR_MEMORY_QUEUE_MAX: "0" } as NodeJS.ProcessEnv),
    ).toThrow(/QCR_MEMORY_QUEUE_MAX/);
    expect(() => forward.parseArgs(["run", "--max-relays"], {} as NodeJS.ProcessEnv)).toThrow();
  });

  it("gives the forward its OWN ControlPath, never the operator's ssh-config one", () => {
    const { cfg } = forward.parseArgs(["run"], {} as NodeJS.ProcessEnv);
    expect(cfg.controlPath).toBe(forward.defaultControlPath());
    expect(cfg.controlPath).toMatch(/\/\.ssh\/qcr-memfwd-%C$/);
    expect(forward.relayArgv(cfg)).toContain(`ControlPath=${cfg.controlPath}`);
    // Short enough for a unix socket path on a long home: `%C` expands to 40
    // hex, and ssh binds the master at the path plus a 17-byte temp suffix
    // first; sun_path is 104 bytes on macOS, 108 on Linux.
    const expanded = forward.defaultControlPath("/home/a-rather-long-user-name").length - 2 + 40;
    expect(expanded + 17).toBeLessThan(104);
  });

  it("writes only non-default relay settings into the systemd unit, with systemd's % escaped", () => {
    const { cfg } = forward.parseArgs(["run"], {} as NodeJS.ProcessEnv);
    const unit = { ...cfg, unit: "qcr-memory-forward" };
    expect(forward.unitText(unit, {}) as string).not.toMatch(/--max-relays|--queue|--control-path/);
    const custom = forward.unitText(
      { ...unit, maxRelays: 4, queueMax: 10, queueTimeoutMs: 5_000, controlPath: "/s/fwd-%C" },
      {},
    ) as string;
    expect(custom).toContain("--max-relays 4");
    expect(custom).toContain("--queue-max 10");
    expect(custom).toContain("--queue-timeout 5");
    expect(custom).toContain("--control-path /s/fwd-%%C");
  });

  it("the stats file lives in the runtime dir the unit's %t names, or nowhere", () => {
    expect(
      forward.statsFilePath({ XDG_RUNTIME_DIR: "/run/user/1000" } as NodeJS.ProcessEnv, 1933),
    ).toBe("/run/user/1000/qcr-memory-forward-1933.json");
    expect(forward.statsFilePath({} as NodeJS.ProcessEnv, 1933)).toBeNull();
    expect(forward.parseArgs(["run"], {} as NodeJS.ProcessEnv).cfg.statsFile).toBeNull();
  });
});

// ---- reported: the stats file and `status` -------------------------------------

describe("the cap and the queue are reported", () => {
  it("the running forward writes its live counts, `status` reads them, and close() removes the file", async () => {
    const dir = mkdtempSync(join(tmpdir(), "qcr-fwd-stats-"));
    try {
      const statsFile = join(dir, "stats.json");
      const r = relays({ autoRespond: true });
      const { fwd, port } = await start({ maxRelays: 2, statsFile }, r, {
        timings: { statsEveryMs: 5 },
      });
      expect(existsSync(statsFile)).toBe(true); // written at listen
      const c = new Client(port);
      await c.connected();
      expect(await c.request("/s")).toBe("/s");
      await until(() => {
        const s = JSON.parse(readFileSync(statsFile, "utf8")) as { accepted: number };
        return s.accepted === 1;
      });
      const read = forward.readForwardStats(statsFile);
      expect(read.state).toBe("live");
      const lines = forward.describeForwardStats({ ...BASE_CFG, statsFile }, read) as string[];
      expect(lines[0]).toContain("relay cap: 2 at once");
      expect(lines[1]).toMatch(/live relays \(pid \d+, as of .+\): 1\/2 open, 0 waiting/);
      // The running forward's own cap, named when it differs from this command's.
      expect(lines.some((l) => l.includes("this command would use 6"))).toBe(true);
      c.close();
      fwd.close();
      expect(existsSync(statsFile)).toBe(false);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("close() removes only its OWN stats file — another forward may have taken the port since", async () => {
    const dir = mkdtempSync(join(tmpdir(), "qcr-fwd-stats-"));
    try {
      const statsFile = join(dir, "stats.json");
      const { fwd } = await start({ statsFile }, relays());
      expect(existsSync(statsFile)).toBe(true);
      // Another (live) forward's snapshot, written over ours. No event-loop
      // turn passes before close(), so no stats timer of ours can rewrite it.
      const other = { pid: process.ppid, maxRelays: 6 };
      writeFileSync(statsFile, JSON.stringify(other));
      fwd.close();
      expect(JSON.parse(readFileSync(statsFile, "utf8"))).toEqual(other);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("says the live counts are UNKNOWN — never zero — when it cannot read them", () => {
    const cfg = { ...BASE_CFG, statsFile: "/nowhere/stats.json" };
    const absent = forward.describeForwardStats(
      cfg,
      forward.readForwardStats("/nowhere/stats.json"),
    ) as string[];
    expect(absent[0]).toContain("this command's settings");
    expect(absent[1]).toMatch(/^live relays: unknown — no forward has written/);
    const stale = forward.readForwardStats("/x", {
      read: () => JSON.stringify({ pid: 4242, maxRelays: 6 }),
      alive: () => false,
    });
    expect(stale.state).toBe("stale");
    expect((forward.describeForwardStats(cfg, stale) as string[])[1]).toContain(
      "4242, which is not running",
    );
    expect(
      (forward.describeForwardStats(cfg, forward.readForwardStats(null)) as string[])[1],
    ).toContain("XDG_RUNTIME_DIR is not set");
    expect(
      (
        forward.describeForwardStats(
          cfg,
          forward.readForwardStats("/x", { read: () => "{nope" }),
        ) as string[]
      )[1],
    ).toContain("unreadable");
  });

  it("relaySummary is the TUI row's wording", () => {
    expect(
      relaySummary({
        maxRelays: 6,
        queueMax: 64,
        open: 6,
        queued: 3,
        refusedTimeout: 1,
        refusedFull: 1,
      }),
    ).toBe("relays 6/6 open, 3 waiting, 2 refused since start");
    expect(
      relaySummary({
        maxRelays: 6,
        queueMax: 64,
        open: 0,
        queued: 0,
        refusedTimeout: 0,
        refusedFull: 0,
      }),
    ).toBe("relays 0/6 open, 0 waiting");
  });
});

// ---- the TUI-imported path -------------------------------------------------------

describe("the TUI-owned forward is the same forward with the same cap", () => {
  /** The REAL script, loaded the way MemoryForward loads it; only the bind
   * (an ephemeral loopback port) and the relay spawner are swapped. */
  function realModule(r: ReturnType<typeof relays>) {
    const seen: { cfg?: Record<string, unknown>; handle?: Forwarder } = {};
    const real = forward as unknown as ForwardModule;
    const mod: ForwardModule = {
      parseArgs: (argv, env) => real.parseArgs(argv, env),
      createForwarder: (cfg, opts) => {
        seen.cfg = cfg;
        const handle = forward.createForwarder(
          { ...cfg, binds: ["127.0.0.1"], port: 0 },
          { ...opts, spawnRelay: r.spawnRelay },
        );
        seen.handle = handle;
        opened.push(handle);
        return handle;
      },
    };
    return { mod, seen };
  }

  const tui = (mod: ForwardModule, env: NodeJS.ProcessEnv, local = false): MemoryForward => {
    let probes = 0;
    return new MemoryForward({
      baseUrl: "http://127.0.0.1:1",
      repoRoot: "/does/not/matter",
      env,
      local,
      // Nothing listening at first (so the TUI binds), then it answers.
      probe: () => Promise.resolve(probes++ > 0),
      load: () => Promise.resolve(mod),
    });
  };

  it("caps the relays a TUI-owned forward opens at the script's own default", async () => {
    const r = relays({ autoRespond: true, delayMs: 15 });
    const { mod, seen } = realModule(r);
    const mf = tui(mod, {} as NodeJS.ProcessEnv);
    expect((await mf.ensure()).state).toBe("owned");
    expect(seen.cfg?.maxRelays).toBe(forward.DEFAULTS.maxRelays);
    const port = (seen.handle!.addresses() as Array<{ port: number }>)[0]!.port;
    const bodies = await Promise.all(
      Array.from({ length: 12 }, async (_, i) => {
        const c = new Client(port);
        await c.connected();
        const body = await c.request(`/t${i}`);
        c.close();
        return body;
      }),
    );
    expect(bodies).toEqual(Array.from({ length: 12 }, (_, i) => `/t${i}`));
    expect(r.peakAlive()).toBeLessThanOrEqual(forward.DEFAULTS.maxRelays);
    expect(seen.handle!.stats().peakOpen).toBeLessThanOrEqual(forward.DEFAULTS.maxRelays);
    // The MEMORY STORE row carries the cap while the forward is ours.
    expect(mf.view().detail).toMatch(/started by this TUI .* · relays \d+\/6 open, \d+ waiting/);
    mf.stop();
  });

  it("honours the same QCR_MEMORY_* env as the unit, in ssh and local mode alike", async () => {
    for (const local of [false, true]) {
      const r = relays();
      const { mod, seen } = realModule(r);
      const mf = tui(mod, { QCR_MEMORY_MAX_RELAYS: "3" } as NodeJS.ProcessEnv, local);
      await mf.ensure();
      expect(seen.cfg).toMatchObject({ maxRelays: 3, local });
      expect(seen.handle!.stats().maxRelays).toBe(3);
      mf.stop();
    }
  });

  it("an adopted forward's counts are not the TUI's to paint — no row of made-up zeros", async () => {
    const mf = new MemoryForward({
      baseUrl: "http://127.0.0.1:1",
      repoRoot: "/x",
      probe: () => Promise.resolve(true),
      load: () => Promise.reject(new Error("never loaded")),
    });
    const st = await mf.ensure();
    expect(st.state).toBe("adopted");
    expect(st.detail).not.toMatch(/relays/);
  });

  it("a bad cap in the env fails the TUI's forward loudly, naming it", async () => {
    const r = relays();
    const { mod } = realModule(r);
    const mf = tui(mod, { QCR_MEMORY_MAX_RELAYS: "0" } as NodeJS.ProcessEnv);
    const st = await mf.ensure();
    expect(st.state).toBe("failed");
    expect(st.detail).toContain("QCR_MEMORY_MAX_RELAYS");
  });

  it("the real script exports what the TUI and status rely on", () => {
    const { cfg } = forward.parseArgs(["run"], {} as NodeJS.ProcessEnv);
    const handle = forward.createForwarder(cfg, { log: () => {} });
    expect(typeof handle.stats).toBe("function");
    expect(handle.stats()).toMatchObject({ maxRelays: 6, open: 0, queued: 0 });
    handle.close();
  });
});
