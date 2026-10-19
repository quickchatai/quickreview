// The worker's and the shims' end of the socket (D23).
//
// A host process or a post shim reads its capability from the inherited fd
// (QCR_IPC_CAP_FD) with pread each time it connects, says hello, then sends
// requests and events. Nothing here touches the engine or pi.
import net from "node:net";
import { readCapabilityFd } from "./capability.js";
import {
  type IpcEventKind,
  type IpcMessage,
  type IpcRole,
  type ResponseMessage,
  IPC_VERSION,
  IpcError,
  LineDecoder,
  MAX_LINE_BYTES,
  decodeMessage,
  encodeMessage,
} from "./protocol.js";

export interface IpcClientOptions {
  socketPath: string;
  role: IpcRole;
  commandId: string;
  capability: string;
  /** The generation this process was started with. */
  generation: number;
  timeoutMs?: number;
  maxLineBytes?: number;
}

interface Waiting {
  resolve(r: ResponseMessage): void;
  reject(e: unknown): void;
  timer: NodeJS.Timeout;
}

export class IpcClient {
  private nextId = 1;
  private readonly waiting = new Map<string, Waiting>();
  private controlHandler: ((kind: string, body: unknown) => void) | null = null;
  private errorHandler: ((e: IpcError) => void) | null = null;
  private closeHandler: ((e: IpcError) => void) | null = null;
  private closedBySelf = false;
  private ended: IpcError | null = null;

  private constructor(
    private readonly socket: net.Socket,
    private readonly opts: IpcClientOptions,
    /** What the daemon said in its hello_ok. */
    readonly pr: number,
    readonly serverGeneration: number,
    decoder: LineDecoder,
  ) {
    socket.removeAllListeners("data");
    socket.on("data", (chunk) => this.onData(chunk, decoder));
    socket.on("close", () => this.end(new IpcError("closed", "the connection closed")));
    socket.on("error", () => this.end(new IpcError("closed", "the connection failed")));
  }

  static async connect(opts: IpcClientOptions): Promise<IpcClient> {
    const timeoutMs = opts.timeoutMs ?? 10_000;
    const decoder = new LineDecoder(opts.maxLineBytes ?? MAX_LINE_BYTES);
    const socket = net.connect(opts.socketPath);
    const hello = await new Promise<IpcMessage>((resolve, reject) => {
      const timer = setTimeout(() => {
        socket.destroy();
        reject(new IpcError("timeout", "no hello answer"));
      }, timeoutMs);
      const fail = (e: unknown) => {
        clearTimeout(timer);
        socket.destroy();
        reject(e instanceof IpcError ? e : new IpcError("closed", "could not connect"));
      };
      socket.once("error", fail);
      socket.once("close", () => fail(new IpcError("closed", "closed before hello_ok")));
      socket.on("data", (chunk) => {
        try {
          const [line] = decoder.push(chunk);
          if (line === undefined) return;
          clearTimeout(timer);
          socket.off("error", fail);
          resolve(decodeMessage(line));
        } catch (e) {
          fail(e);
        }
      });
      socket.once("connect", () => {
        socket.write(
          encodeMessage({
            v: IPC_VERSION,
            type: "hello",
            role: opts.role,
            command_id: opts.commandId,
            capability: opts.capability,
          }),
        );
      });
    });
    if (hello.type === "error") {
      socket.destroy();
      throw new IpcError(hello.error.code, hello.error.message);
    }
    if (hello.type !== "hello_ok") {
      socket.destroy();
      throw new IpcError("bad_request", "expected hello_ok");
    }
    return new IpcClient(socket, opts, hello.pr, hello.generation, decoder);
  }

  /** Call an op and wait for its answer; a refusal rejects with the typed error. */
  async request<T = unknown>(op: string, body?: unknown, opts: { pr?: number } = {}): Promise<T> {
    if (this.ended) throw this.ended;
    const id = String(this.nextId++);
    const msg: IpcMessage = {
      v: IPC_VERSION,
      type: "request",
      id,
      op,
      generation: this.opts.generation,
      ...(opts.pr !== undefined ? { pr: opts.pr } : {}),
      ...(body !== undefined ? { body } : {}),
    };
    const line = encodeMessage(msg, this.opts.maxLineBytes);
    const res = await new Promise<ResponseMessage>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.waiting.delete(id);
        reject(new IpcError("timeout", `no answer to ${op}`));
      }, this.opts.timeoutMs ?? 10_000);
      this.waiting.set(id, { resolve, reject, timer });
      this.socket.write(line);
    });
    if (!res.ok) throw new IpcError(res.error!.code, res.error!.message);
    return res.body as T;
  }

  /** Report an event. Fire and forget: a refusal arrives through `onError`. */
  event(kind: IpcEventKind, body?: unknown): void {
    if (this.ended) throw this.ended;
    this.socket.write(
      encodeMessage(
        {
          v: IPC_VERSION,
          type: "event",
          kind,
          generation: this.opts.generation,
          ...(body !== undefined ? { body } : {}),
        },
        this.opts.maxLineBytes,
      ),
    );
  }

  /** Resolves once everything written so far has left this process: a worker
   * that sends its last event and exits calls it first. */
  drain(): Promise<void> {
    if (this.ended) return Promise.resolve();
    return new Promise((resolve) => this.socket.write("", () => resolve()));
  }

  onControl(fn: (kind: string, body: unknown) => void): void {
    this.controlHandler = fn;
  }

  onError(fn: (e: IpcError) => void): void {
    this.errorHandler = fn;
  }

  /** The daemon's end of the connection went away (it restarted, or revoked the
   * capability). Not called for a `close()` of this side. */
  onClose(fn: (e: IpcError) => void): void {
    this.closeHandler = fn;
  }

  close(): void {
    this.closedBySelf = true;
    this.socket.end();
    this.end(new IpcError("closed", "closed by this side"));
  }

  private onData(chunk: Buffer, decoder: LineDecoder): void {
    let lines: string[];
    try {
      lines = decoder.push(chunk);
    } catch (e) {
      this.end(e as IpcError);
      this.socket.destroy();
      return;
    }
    for (const line of lines) {
      let msg: IpcMessage;
      try {
        msg = decodeMessage(line);
      } catch {
        continue; // a message this build cannot read; the next may be fine
      }
      if (msg.type === "response") {
        const w = this.waiting.get(msg.id);
        if (w === undefined) continue;
        clearTimeout(w.timer);
        this.waiting.delete(msg.id);
        w.resolve(msg);
      } else if (msg.type === "control") {
        this.controlHandler?.(msg.kind, msg.body);
      } else if (msg.type === "error") {
        this.errorHandler?.(new IpcError(msg.error.code, msg.error.message));
      }
    }
  }

  private end(e: IpcError): void {
    if (this.ended) return;
    this.ended = e;
    for (const w of this.waiting.values()) {
      clearTimeout(w.timer);
      w.reject(e);
    }
    this.waiting.clear();
    if (!this.closedBySelf) this.closeHandler?.(e);
  }
}

export type IpcEnv = Readonly<Record<string, string | undefined>>;

/** Is the env one of a host or a shim of a worker-hosted command? */
export function hasIpcEnv(env: IpcEnv = process.env): boolean {
  return !!env.QCR_IPC_SOCKET && !!env.QCR_IPC_CAP_FD;
}

/**
 * Connect the way a worker or a shim does: the socket, command and generation
 * from env, the capability from the inherited fd, read afresh with pread.
 */
export async function connectFromEnv(
  role: IpcRole,
  env: IpcEnv = process.env,
  extra: Partial<Pick<IpcClientOptions, "timeoutMs" | "maxLineBytes">> = {},
): Promise<IpcClient> {
  const socketPath = env.QCR_IPC_SOCKET;
  const fdText = env.QCR_IPC_CAP_FD;
  const commandId = env.QCR_IPC_COMMAND_ID;
  const generation = Number(env.QCR_IPC_GENERATION);
  if (!socketPath || !fdText || !commandId || !Number.isSafeInteger(generation) || generation < 0)
    throw new IpcError("bad_request", "the IPC env is incomplete");
  if (!/^\d{1,4}$/.test(fdText))
    throw new IpcError("bad_request", "QCR_IPC_CAP_FD is not an fd number");
  const capability = readCapabilityFd(Number(fdText));
  return IpcClient.connect({ socketPath, role, commandId, capability, generation, ...extra });
}
