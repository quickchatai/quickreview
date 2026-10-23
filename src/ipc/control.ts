// The operator's controls over a running worker: steer, followUp and abort.
// Neutral, like the rest of src/ipc/: shapes and validators, no engine, no pi, no
// state store.
//
// The daemon validates a control (src/commands.ts has already validated the
// operator's file) and pushes it down the worker's own connection as a `control`
// message; the worker answers with ONE `control.ack` request naming the control's
// id. The ack says what became of it, never that the model acted on it:
//
//   queued   the session has it and acts when its turn allows (a steer lands after
//            the tool calls of the turn in flight, a follow-up after the run);
//   handled  the session acted now (an idle session started the turn; an abort has
//            stopped the turn and everything it started);
//   refused  the worker did not take it, with a reason (the round is ending, the
//            session is not open yet, the text is unusable).
//
// An abort the worker never acks is not trusted: the supervisor ends the group
// after a grace period (src/workersupervisor.ts).
import { IpcError } from "./protocol.js";

export const CONTROL_KINDS = ["steer", "follow_up", "abort"] as const;
export type ControlKind = (typeof CONTROL_KINDS)[number];

export const CONTROL_ACK_OP = "control.ack";

export const CONTROL_ACKS = ["queued", "handled", "refused"] as const;
export type ControlAckState = (typeof CONTROL_ACKS)[number];

/** The longest `text` a steer or follow-up carries, in characters: the same bound
 * the operator's command carries (tests/worker-control.test.ts holds them equal). */
export const CONTROL_TEXT_MAX = 8000;

/** The id every control carries and its ack names back. */
export const CONTROL_ID_RE = /^[A-Za-z0-9_.:-]{1,128}$/;

/** What a control message's body holds. */
export interface ControlOrder {
  id: string;
  text?: string;
}

export interface ControlAck {
  id: string;
  ack: ControlAckState;
  reason?: string;
}

export const isControlKind = (x: unknown): x is ControlKind =>
  typeof x === "string" && (CONTROL_KINDS as readonly string[]).includes(x);

function isRecord(x: unknown): x is Record<string, unknown> {
  return typeof x === "object" && x !== null && !Array.isArray(x);
}

/** The text of a steer or follow-up: non-empty after trimming, within the bound. */
export function controlText(text: unknown): string {
  if (typeof text !== "string" || text.trim() === "")
    throw new IpcError("bad_request", "a steer or follow-up needs a non-empty `text`");
  if (text.length > CONTROL_TEXT_MAX)
    throw new IpcError("bad_request", `\`text\` is over ${CONTROL_TEXT_MAX} characters`);
  return text;
}

/** A control message, read by the worker. Throws `bad_request`. */
export function parseControl(kind: string, body: unknown): { kind: ControlKind } & ControlOrder {
  if (!isControlKind(kind)) throw new IpcError("bad_request", `unknown control kind: ${kind}`);
  if (!isRecord(body)) throw new IpcError("bad_request", "a control's body must be an object");
  const id = body["id"];
  if (typeof id !== "string" || !CONTROL_ID_RE.test(id))
    throw new IpcError("bad_request", "a control's `id` has an invalid shape");
  if (kind === "abort") return { kind, id };
  return { kind, id, text: controlText(body["text"]) };
}

/** The worker's ack, read by the daemon. Throws `bad_request`. */
export function parseControlAck(body: unknown): ControlAck {
  if (!isRecord(body)) throw new IpcError("bad_request", "control.ack: the body must be an object");
  const id = body["id"];
  if (typeof id !== "string" || !CONTROL_ID_RE.test(id))
    throw new IpcError("bad_request", "control.ack: `id` has an invalid shape");
  const ack = body["ack"];
  if (!(CONTROL_ACKS as readonly string[]).includes(ack as string))
    throw new IpcError("bad_request", "control.ack: `ack` must be queued, handled or refused");
  const reason = body["reason"];
  return {
    id,
    ack: ack as ControlAckState,
    ...(typeof reason === "string" && reason !== "" ? { reason: reason.slice(0, 300) } : {}),
  };
}
