// The daemon's end of the worker socket (D23).
//
// Listens on <state>/run/qcr.sock: socket 0600, directory 0700, daemon uid. A
// connection opens with a hello that names a command and presents its
// capability; every later message is checked again against the daemon's own
// view of the command, because a capability alone authenticates only WHO is
// asking. A request is served only when
//   - the capability is still live (a revoked one closed the connection),
//   - the command has an active session_commands row,
//   - the request's generation is the session's CURRENT generation, and
//   - the PR it names, if any, is the command's PR.
// The generation is a fence and nothing more: guessing or replaying one
// authenticates nothing. Handlers get the command's PR, lease and may_post
// and decide the rest (P7.2's post ops check them).
import { chmodSync, lstatSync, unlinkSync } from "node:fs";
import net from "node:net";
import { dirname } from "node:path";
import { type CapabilityStore, ensurePrivateDir } from "./capability.js";
import {
  type CommandLookup,
  type CommandState,
  type HelloMessage,
  type IpcEventKind,
  type IpcMessage,
  type IpcRole,
  type RequestMessage,
  type WireError,
  IPC_VERSION,
  IpcError,
  LineDecoder,
  MAX_LINE_BYTES,
  decodeMessage,
  encodeMessage,
} from "./protocol.js";

/** What a handler is told about the caller. */
export interface RequestContext {
  commandId: string;
  role: IpcRole;
  pr: number;
  generation: number;
  mayPost: boolean;
  lease: CommandState["lease"];
  /** Throws `wrong_pr` unless `pr` is the command's PR: for ops whose body names one. */
  requirePr(pr: unknown): void;
}

export interface OpHandler {
  /** Roles allowed to call it; any other role gets `forbidden`. */
  roles: readonly IpcRole[];
  handle(ctx: RequestContext, body: unknown): unknown | Promise<unknown>;
}

export type EventHandler = (ctx: RequestContext, kind: IpcEventKind, body: unknown) => void;

export interface IpcServerOptions {
  /** `<state>/run/qcr.sock` */
  socketPath: string;
  capabilities: CapabilityStore;
  commands: CommandLookup;
  ops?: Readonly<Record<string, OpHandler>>;
  onEvent?: EventHandler;
  maxLineBytes?: number;
  /** A connection that has not said hello in this long is closed. */
  helloTimeoutMs?: number;
  /** Diagnostics only; never receives a capability. */
  log?: (msg: string) => void;
}

interface Conn {
  socket: net.Socket;
  decoder: LineDecoder;
  hello: { commandId: string; role: IpcRole; capability: string } | null;
  closed: boolean;
}

export class IpcServer {
  private server: net.Server | null = null;
  private readonly conns = new Set<Conn>();
  private unsubscribe: (() => void) | null = null;
  private ops: Record<string, OpHandler>;

  constructor(private readonly opts: IpcServerOptions) {
    this.ops = { ...opts.ops };
  }

  /** Register an op; P7.2 adds `post.review` and friends this way. */
  register(op: string, handler: OpHandler): void {
    this.ops[op] = handler;
  }

  async start(): Promise<void> {
    const { socketPath } = this.opts;
    if (Buffer.byteLength(socketPath) > 100)
      throw new Error(`socket path is too long for a unix socket: ${socketPath}`);
    ensurePrivateDir(dirname(socketPath));
    await clearStaleSocket(socketPath);
    const server = net.createServer((s) => this.accept(s));
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(socketPath, () => {
        server.off("error", reject);
        resolve();
      });
    });
    chmodSync(socketPath, 0o600);
    this.server = server;
    this.unsubscribe = this.opts.capabilities.onRevoke((id) => this.dropCommand(id));
  }

  async stop(): Promise<void> {
    this.unsubscribe?.();
    this.unsubscribe = null;
    for (const c of [...this.conns]) this.close(c);
    const server = this.server;
    this.server = null;
    if (server) await new Promise<void>((resolve) => server.close(() => resolve()));
    try {
      unlinkSync(this.opts.socketPath);
    } catch {
      /* already gone */
    }
  }

  /** Send a control message (steer, followUp, abort) to a command's host(s). */
  push(commandId: string, kind: string, body?: unknown): number {
    let n = 0;
    for (const c of this.conns) {
      if (c.hello?.commandId !== commandId || c.hello.role !== "worker") continue;
      this.send(c, { v: IPC_VERSION, type: "control", kind, body });
      n++;
    }
    return n;
  }

  connections(): number {
    return this.conns.size;
  }

  private accept(socket: net.Socket): void {
    const conn: Conn = {
      socket,
      decoder: new LineDecoder(this.opts.maxLineBytes ?? MAX_LINE_BYTES),
      hello: null,
      closed: false,
    };
    this.conns.add(conn);
    const timer = setTimeout(() => {
      if (conn.hello === null) this.refuse(conn, new IpcError("no_hello", "no hello in time"));
    }, this.opts.helloTimeoutMs ?? 5_000);
    timer.unref();
    socket.on("data", (chunk) => {
      let lines: string[];
      try {
        lines = conn.decoder.push(chunk);
      } catch (e) {
        this.refuse(conn, e);
        return;
      }
      for (const line of lines) {
        if (conn.closed) return;
        this.onLine(conn, line);
      }
    });
    socket.on("error", () => this.close(conn));
    socket.on("close", () => {
      clearTimeout(timer);
      this.close(conn);
    });
  }

  private onLine(conn: Conn, line: string): void {
    let msg: IpcMessage;
    try {
      msg = decodeMessage(line);
    } catch (e) {
      this.refuse(conn, e);
      return;
    }
    if (conn.hello === null) {
      if (msg.type !== "hello") {
        this.refuse(conn, new IpcError("no_hello", "the first message must be a hello"));
        return;
      }
      this.onHello(conn, msg);
      return;
    }
    if (msg.type === "request") {
      void this.onRequest(conn, msg);
    } else if (msg.type === "event") {
      this.onEvent(conn, msg.kind, msg.generation, msg.body);
    } else {
      this.refuse(conn, new IpcError("bad_request", `a client may not send ${msg.type}`));
    }
  }

  private onHello(conn: Conn, hello: HelloMessage): void {
    // Unknown command and wrong capability read the same: no oracle.
    if (!this.opts.capabilities.verify(hello.command_id, hello.capability)) {
      this.refuse(conn, new IpcError("unauthorized", "the capability is not accepted"));
      return;
    }
    const state = this.opts.commands(hello.command_id);
    if (state === null || !state.active) {
      this.refuse(conn, new IpcError("command_inactive", "the command is not active"));
      return;
    }
    conn.hello = { commandId: hello.command_id, role: hello.role, capability: hello.capability };
    this.send(conn, {
      v: IPC_VERSION,
      type: "hello_ok",
      command_id: hello.command_id,
      pr: state.pr,
      generation: state.generation,
    });
  }

  /** The checks every request and event pass; throws a typed error. */
  private authorize(conn: Conn, generation: number, pr?: number): RequestContext {
    const hello = conn.hello!;
    if (!this.opts.capabilities.verify(hello.commandId, hello.capability))
      throw new IpcError("unauthorized", "the capability is no longer live");
    const state = this.opts.commands(hello.commandId);
    if (state === null || !state.active)
      throw new IpcError("command_inactive", "the command is not active");
    if (generation !== state.generation)
      throw new IpcError("stale_generation", "the request is for a past generation");
    const ctx: RequestContext = {
      commandId: hello.commandId,
      role: hello.role,
      pr: state.pr,
      generation: state.generation,
      mayPost: state.may_post,
      lease: state.lease,
      requirePr(n: unknown) {
        if (n !== state.pr) throw new IpcError("wrong_pr", "the request names another PR");
      },
    };
    if (pr !== undefined) ctx.requirePr(pr);
    return ctx;
  }

  private async onRequest(conn: Conn, req: RequestMessage): Promise<void> {
    try {
      const ctx = this.authorize(conn, req.generation, req.pr);
      const op = Object.hasOwn(this.ops, req.op) ? this.ops[req.op] : undefined;
      if (op === undefined) throw new IpcError("unknown_op", `no such op: ${req.op}`);
      if (!op.roles.includes(ctx.role))
        throw new IpcError("forbidden", `role ${ctx.role} may not call ${req.op}`);
      const body = await op.handle(ctx, req.body);
      this.send(conn, { v: IPC_VERSION, type: "response", id: req.id, ok: true, body });
    } catch (e) {
      this.send(conn, {
        v: IPC_VERSION,
        type: "response",
        id: req.id,
        ok: false,
        error: toWireError(e, this.opts.log),
      });
    }
  }

  private onEvent(conn: Conn, kind: IpcEventKind, generation: number, body: unknown): void {
    try {
      const ctx = this.authorize(conn, generation);
      if (ctx.role !== "worker") throw new IpcError("forbidden", "only a worker reports events");
      this.opts.onEvent?.(ctx, kind, body);
    } catch (e) {
      // An event has no id to answer: say so unsolicited, and drop it.
      this.send(conn, { v: IPC_VERSION, type: "error", error: toWireError(e, this.opts.log) });
    }
  }

  private send(conn: Conn, msg: IpcMessage): void {
    if (conn.closed) return;
    try {
      conn.socket.write(encodeMessage(msg, this.opts.maxLineBytes));
    } catch (e) {
      // A response too large to send: the caller gets a typed error instead.
      if (msg.type === "response" && e instanceof IpcError)
        conn.socket.write(
          encodeMessage({
            v: IPC_VERSION,
            type: "response",
            id: msg.id,
            ok: false,
            error: { code: e.code, message: e.message },
          }),
        );
    }
  }

  /** A protocol-level failure: say what went wrong, then hang up. */
  private refuse(conn: Conn, e: unknown): void {
    if (conn.closed) return;
    try {
      conn.socket.write(
        encodeMessage({ v: IPC_VERSION, type: "error", error: toWireError(e, this.opts.log) }),
        () => conn.socket.destroy(),
      );
    } catch {
      conn.socket.destroy();
    }
    this.close(conn);
  }

  private close(conn: Conn): void {
    if (conn.closed) return;
    conn.closed = true;
    this.conns.delete(conn);
    conn.socket.destroy();
  }

  private dropCommand(commandId: string): void {
    for (const c of [...this.conns]) if (c.hello?.commandId === commandId) this.close(c);
  }
}

function toWireError(e: unknown, log?: (msg: string) => void): WireError {
  if (e instanceof IpcError) return { code: e.code, message: e.message };
  // Anything else is a bug in a handler: log it, tell the caller nothing more.
  log?.(`ipc handler failed: ${e instanceof Error ? (e.stack ?? e.message) : String(e)}`);
  return { code: "internal", message: "internal error" };
}

/** A leftover socket from a daemon that died is removed; one that answers is a
 * live daemon, and starting a second would steal its callers. */
async function clearStaleSocket(path: string): Promise<void> {
  let st;
  try {
    st = lstatSync(path);
  } catch {
    return; // nothing there
  }
  if (!st.isSocket()) throw new Error(`${path} exists and is not a socket`);
  const live = await new Promise<boolean>((resolve) => {
    const probe = net.connect(path);
    probe.once("connect", () => {
      probe.destroy();
      resolve(true);
    });
    probe.once("error", () => resolve(false));
  });
  if (live) throw new Error(`another daemon is already listening on ${path}`);
  unlinkSync(path);
}
