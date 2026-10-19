// The worker-daemon wire protocol (D23): one JSON object per line over a Unix
// socket, a `v` field on every message, typed errors.
//
// This directory is NEUTRAL by fence (tests/fences-ipc.test.ts): it imports
// nothing from src/engine/ or pi, so the daemon can serve it and a worker, a
// post shim or a debug pi can speak it without either side dragging the
// other's closure in. The daemon-side facts the server needs (which PR a
// command belongs to, its live generation, its lease) arrive through the
// `CommandLookup` port, never by importing the state store.

/** `<major>.<minor>`. A different MAJOR is refused; a newer minor is accepted
 * (it may only add fields and kinds, which a reader ignores). */
export const IPC_PROTOCOL_MAJOR = 1;
export const IPC_PROTOCOL_MINOR = 0;
export const IPC_VERSION = `${IPC_PROTOCOL_MAJOR}.${IPC_PROTOCOL_MINOR}`;

/** The longest line, in bytes without the newline. A result file travels by
 * PATH, never inline, so nothing legitimate comes near this. */
export const MAX_LINE_BYTES = 1024 * 1024;

/** `worker` is the round's host process; `shim` is a post shim run from the
 * model's bash, which inherits the capability fd. */
export const IPC_ROLES = ["worker", "shim"] as const;
export type IpcRole = (typeof IPC_ROLES)[number];

/** What the worker reports, in the order a round normally emits them (P8.3). */
export const IPC_EVENT_KINDS = [
  "ready",
  "accepted",
  "progress",
  "usage",
  "posted",
  "verdict_written",
  "compacted",
  "done",
  "failed",
] as const;
export type IpcEventKind = (typeof IPC_EVENT_KINDS)[number];

export const IPC_ERROR_CODES = [
  "bad_frame", // not a JSON object line
  "bad_request", // a field is missing or has the wrong shape
  "line_too_long",
  "unsupported_version", // a major this build does not speak
  "unauthorized", // unknown command or wrong capability (never says which)
  "no_hello", // a request before the connection said who it is
  "stale_generation",
  "command_inactive", // the command has no active session_commands row
  "wrong_pr", // the request names another PR than the command's
  "unknown_op",
  "forbidden", // the role may not call this op
  "lease_takeover", // the PR is under a takeover lease: it can post nothing
  "may_post_required", // an answer worker whose message did not carry may_post
  "bad_path", // a result file outside the PR's own dir, or not a plain readable file
  "cancelled", // a permit wait ended by a release or by the command ending (P8.10)
  "blocked", // the gate or a guard refused the mutation: nothing was posted
  "post_failed", // GitHub answered the post with a refusal
  "internal",
  "closed", // client side: the connection ended
  "timeout", // client side
] as const;
export type IpcErrorCode = (typeof IPC_ERROR_CODES)[number];

export class IpcError extends Error {
  constructor(
    readonly code: IpcErrorCode,
    message: string,
  ) {
    super(message);
    this.name = "IpcError";
  }
}

export interface WireError {
  code: IpcErrorCode;
  message: string;
}

export interface HelloMessage {
  v: string;
  type: "hello";
  role: IpcRole;
  command_id: string;
  capability: string;
}

export interface HelloOkMessage {
  v: string;
  type: "hello_ok";
  command_id: string;
  pr: number;
  generation: number;
}

export interface RequestMessage {
  v: string;
  type: "request";
  id: string;
  op: string;
  /** The generation the caller was started with. */
  generation: number;
  /** Optional: the PR the caller believes it is acting on. The server refuses
   * a mismatch, so a request cannot be aimed at another PR. */
  pr?: number;
  body?: unknown;
}

export interface ResponseMessage {
  v: string;
  type: "response";
  id: string;
  ok: boolean;
  body?: unknown;
  error?: WireError;
}

export interface EventMessage {
  v: string;
  type: "event";
  kind: IpcEventKind;
  generation: number;
  body?: unknown;
}

/** Daemon to worker: steer, followUp, abort (P8.12). */
export interface ControlMessage {
  v: string;
  type: "control";
  kind: string;
  body?: unknown;
}

/** Unsolicited refusal: before the hello, or for an event (which has no id). */
export interface ErrorMessage {
  v: string;
  type: "error";
  error: WireError;
}

export type IpcMessage =
  | HelloMessage
  | HelloOkMessage
  | RequestMessage
  | ResponseMessage
  | EventMessage
  | ControlMessage
  | ErrorMessage;

const VERSION_RE = /^(\d{1,4})\.(\d{1,4})$/;
export const COMMAND_ID_RE = /^[A-Za-z0-9_.:-]{1,128}$/;
export const CAPABILITY_RE = /^[0-9a-f]{32}$/;

export function parseVersion(v: unknown): { major: number; minor: number } | null {
  if (typeof v !== "string") return null;
  const m = VERSION_RE.exec(v);
  return m ? { major: Number(m[1]), minor: Number(m[2]) } : null;
}

function isRecord(x: unknown): x is Record<string, unknown> {
  return typeof x === "object" && x !== null && !Array.isArray(x);
}

function str(o: Record<string, unknown>, key: string, max = 256): string {
  const x = o[key];
  if (typeof x !== "string" || x === "" || x.length > max)
    throw new IpcError("bad_request", `\`${key}\` must be a non-empty string`);
  return x;
}

function nat(o: Record<string, unknown>, key: string): number {
  const x = o[key];
  if (typeof x !== "number" || !Number.isSafeInteger(x) || x < 0)
    throw new IpcError("bad_request", `\`${key}\` must be a non-negative integer`);
  return x;
}

function wireError(x: unknown): WireError {
  if (!isRecord(x)) throw new IpcError("bad_request", "`error` must be an object");
  const code = x.code;
  if (!IPC_ERROR_CODES.includes(code as IpcErrorCode))
    throw new IpcError("bad_request", "`error.code` is not a known code");
  return { code: code as IpcErrorCode, message: typeof x.message === "string" ? x.message : "" };
}

/**
 * One line to one message. The version is judged FIRST, before any other field
 * is read, so a future major whose shapes differ is refused as such rather than
 * as a malformed request.
 */
export function decodeMessage(line: string): IpcMessage {
  let raw: unknown;
  try {
    raw = JSON.parse(line);
  } catch {
    throw new IpcError("bad_frame", "the line is not JSON");
  }
  if (!isRecord(raw)) throw new IpcError("bad_frame", "the line is not a JSON object");
  const ver = parseVersion(raw.v);
  if (ver === null) throw new IpcError("bad_request", '`v` must be "<major>.<minor>"');
  if (ver.major !== IPC_PROTOCOL_MAJOR)
    throw new IpcError(
      "unsupported_version",
      `protocol major ${ver.major} is not supported (this build speaks ${IPC_PROTOCOL_MAJOR})`,
    );
  const v = raw.v as string;
  switch (raw.type) {
    case "hello": {
      const role = raw.role;
      if (!IPC_ROLES.includes(role as IpcRole))
        throw new IpcError("bad_request", "`role` must be worker or shim");
      const command_id = str(raw, "command_id", 128);
      if (!COMMAND_ID_RE.test(command_id))
        throw new IpcError("bad_request", "`command_id` has an invalid shape");
      const capability = str(raw, "capability", 64);
      if (!CAPABILITY_RE.test(capability))
        throw new IpcError("unauthorized", "the capability is not accepted");
      return { v, type: "hello", role: role as IpcRole, command_id, capability };
    }
    case "hello_ok":
      return {
        v,
        type: "hello_ok",
        command_id: str(raw, "command_id", 128),
        pr: nat(raw, "pr"),
        generation: nat(raw, "generation"),
      };
    case "request": {
      const msg: RequestMessage = {
        v,
        type: "request",
        id: str(raw, "id", 128),
        op: str(raw, "op", 128),
        generation: nat(raw, "generation"),
      };
      if (raw.pr !== undefined) msg.pr = nat(raw, "pr");
      if (raw.body !== undefined) msg.body = raw.body;
      return msg;
    }
    case "response": {
      const id = str(raw, "id", 128);
      if (typeof raw.ok !== "boolean") throw new IpcError("bad_request", "`ok` must be a boolean");
      const msg: ResponseMessage = { v, type: "response", id, ok: raw.ok };
      if (raw.ok) msg.body = raw.body;
      else msg.error = wireError(raw.error);
      return msg;
    }
    case "event": {
      const kind = raw.kind;
      if (!IPC_EVENT_KINDS.includes(kind as IpcEventKind))
        throw new IpcError("bad_request", "`kind` is not a known event kind");
      return {
        v,
        type: "event",
        kind: kind as IpcEventKind,
        generation: nat(raw, "generation"),
        body: raw.body,
      };
    }
    case "control":
      return { v, type: "control", kind: str(raw, "kind", 64), body: raw.body };
    case "error":
      return { v, type: "error", error: wireError(raw.error) };
    default:
      throw new IpcError("bad_request", "`type` is not a known message type");
  }
}

/** One message to one line, newline included. Refuses to SEND an oversize line,
 * so the sender learns of it instead of the peer dropping the connection. */
export function encodeMessage(msg: IpcMessage, maxBytes = MAX_LINE_BYTES): string {
  const line = JSON.stringify(msg);
  if (Buffer.byteLength(line) > maxBytes)
    throw new IpcError("line_too_long", `the message is over ${maxBytes} bytes`);
  return `${line}\n`;
}

/**
 * Splits a byte stream into lines, bounded. A line over `maxBytes` throws
 * `line_too_long` as soon as the bound is crossed, even before its newline
 * arrives, so a peer that never sends one cannot grow the buffer.
 */
export class LineDecoder {
  private pending: Buffer[] = [];
  private pendingBytes = 0;

  constructor(private readonly maxBytes = MAX_LINE_BYTES) {}

  push(chunk: Buffer): string[] {
    const lines: string[] = [];
    let start = 0;
    for (let nl = chunk.indexOf(0x0a, start); nl >= 0; nl = chunk.indexOf(0x0a, start)) {
      const piece = chunk.subarray(start, nl);
      if (this.pendingBytes + piece.length > this.maxBytes) this.tooLong();
      const line = Buffer.concat([...this.pending, piece]).toString("utf8");
      this.pending = [];
      this.pendingBytes = 0;
      if (line.trim() !== "") lines.push(line);
      start = nl + 1;
    }
    const rest = chunk.subarray(start);
    if (rest.length > 0) {
      if (this.pendingBytes + rest.length > this.maxBytes) this.tooLong();
      this.pending.push(Buffer.from(rest));
      this.pendingBytes += rest.length;
    }
    return lines;
  }

  private tooLong(): never {
    this.pending = [];
    this.pendingBytes = 0;
    throw new IpcError("line_too_long", `a line is over ${this.maxBytes} bytes`);
  }
}

/** What the daemon knows about a command, read fresh for every request. */
export interface CommandState {
  pr: number;
  /** The live generation of the command's session. */
  generation: number;
  /** True while the command has an active (pending or running) row. */
  active: boolean;
  /** Set only by the operator's message; the post ops of an ANSWER worker need it. */
  may_post: boolean;
  /** True for an idle-PR answer worker's command (P8.17): its posts are refused
   * unless `may_post`. Absent for a round, takeover or debug command. */
  answer?: boolean;
  /** A takeover refuses every post; a debug round may post (D38). */
  lease: "none" | "takeover" | "debug";
}

/** The daemon's answer to "what is this command right now": null when unknown. */
export type CommandLookup = (commandId: string) => CommandState | null;
