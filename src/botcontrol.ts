// The worker's end of the operator's controls (P8.12): what a round's worker does
// when the daemon pushes it a steer, a follow-up or an abort (src/ipc/control.ts).
//
//   steer      goes straight to the running session (rule 9's one exception): the
//              model's next request carries it, after the tool calls of the turn in
//              flight. On a session that is idle it starts a turn instead.
//   follow_up  waits behind the work in flight: after the turn, after the run.
//   abort      stops the turn and everything it started (the lens passes too), and
//              the round ends with the aborted exit code.
//
// Every control is acked ONCE (`control.ack`) as queued, handled or refused. A
// steer or follow-up the session took while busy is `queued`; one that started a
// turn now (an idle session) is `handled`; an abort is `handled` once the turn has
// stopped. A control the worker cannot take is `refused` with the reason: the
// session is not open yet, or the round has begun to end (wakes delivered, the
// compaction under way), when there is nothing left to steer.
//
// The turns an operator's message starts are the round's: the worker waits for
// them (`drain`) before it delivers wakes, and again before it compacts and closes.
import type { ControlAck, ControlKind } from "./ipc/control.js";
import { CONTROL_ACK_OP, parseControl } from "./ipc/control.js";
import { IpcError } from "./ipc/protocol.js";
import type { Delivery, RuntimeSession, TurnOptions } from "./engine/port.js";

/** How long the ack waits for the session to say what it did with a message before
 * it reports the turn as running ("handled"): an idle session runs the whole turn
 * inside the call. */
const DEFAULT_ACK_WAIT_MS = 500;
const IDLE_POLL_MS = 20;

export interface WorkerControlsDeps {
  /** The round's session; undefined until it is open. */
  session(): RuntimeSession | undefined;
  /** The limits a turn started by a control runs under (what is left of the round's). */
  limits(): TurnOptions;
  /** Stop the whole worker (the session and the lens passes it started) and
   * resolve once they have stopped. The caller records why and with which exit. */
  abort(): Promise<void>;
  /** Send the ack to the daemon. */
  ack(ack: ControlAck): Promise<void>;
  log(line: string): void;
  ackWaitMs?: number;
}

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));
const errText = (e: unknown): string => (e instanceof Error ? e.message : String(e)).slice(0, 300);

export class WorkerControls {
  /** Turns a control started, until they settle. */
  private readonly inflight = new Set<Promise<unknown>>();
  /** Controls being acted on, until their ack has been sent. */
  private readonly acting = new Set<Promise<void>>();
  private accepting = true;
  /** Controls acted on (queued or handled), by kind. */
  readonly counts: Record<ControlKind, number> = { steer: 0, follow_up: 0, abort: 0 };

  constructor(private readonly deps: WorkerControlsDeps) {}

  /** The IpcClient's control handler. Never throws: a control that cannot be read
   * has no id to ack, and is logged. */
  receive(kind: string, body: unknown): void {
    let order;
    try {
      order = parseControl(kind, body);
    } catch (e) {
      this.deps.log(`botworker: unreadable ${kind} control: ${errText(e)}`);
      const id = (body as { id?: unknown } | null)?.id;
      if (typeof id === "string" && e instanceof IpcError)
        void this.say({ id, ack: "refused", reason: e.message });
      return;
    }
    const acting = this.handle(order)
      .catch((e) => {
        this.deps.log(`botworker: control ${order.id} failed: ${errText(e)}`);
        return this.say({ id: order.id, ack: "refused", reason: errText(e) });
      })
      .finally(() => this.acting.delete(acting));
    this.acting.add(acting);
  }

  /** Resolve once every control received so far has been acked: the worker calls it
   * before it closes the connection, so an abort's `handled` is not lost to the exit
   * the abort itself causes. */
  async flush(): Promise<void> {
    while (this.acting.size > 0) await Promise.allSettled([...this.acting]);
  }

  private async handle(order: ReturnType<typeof parseControl>): Promise<void> {
    if (order.kind === "abort") {
      this.counts.abort++;
      await this.deps.abort();
      return this.say({ id: order.id, ack: "handled" });
    }
    const live = this.deps.session();
    if (!live)
      return this.say({ id: order.id, ack: "refused", reason: "the session is not open yet" });
    if (!this.accepting)
      return this.say({ id: order.id, ack: "refused", reason: "the round is ending" });
    const text = order.text!;
    const sent: Promise<Delivery> =
      order.kind === "steer" ? live.steer(text) : live.followUp(text, this.deps.limits());
    // Whatever the session does with it, the worker waits for the turn it starts.
    const tracked = sent.then(
      (d) => d,
      (e): Delivery => ({ status: "unsupported", reason: errText(e) }),
    );
    this.inflight.add(tracked);
    void tracked.finally(() => this.inflight.delete(tracked));
    const first = await Promise.race([
      tracked,
      sleep(this.deps.ackWaitMs ?? DEFAULT_ACK_WAIT_MS).then(() => undefined),
    ]);
    if (first === undefined) {
      // Still inside the call: an idle session is running the turn this message started.
      this.counts[order.kind]++;
      return this.say({ id: order.id, ack: "handled" });
    }
    if (first.status === "unsupported")
      return this.say({ id: order.id, ack: "refused", reason: first.reason });
    this.counts[order.kind]++;
    return this.say({ id: order.id, ack: first.status === "queued" ? "queued" : "handled" });
  }

  private async say(ack: ControlAck): Promise<void> {
    try {
      await this.deps.ack(ack);
    } catch (e) {
      // A daemon that went away fences the worker through its own handlers.
      this.deps.log(`botworker: control.ack ${ack.id} not sent: ${errText(e)}`);
    }
  }

  /** Resolve once the session has nothing in flight or queued: the turns a control
   * started have settled. A control that arrives meanwhile is waited for too. */
  async drain(): Promise<void> {
    await this.settled(false);
  }

  /** `drain`, and in the same synchronous step that finds the session idle, stop
   * accepting steers and follow-ups: nothing lands between the last check and the
   * close. An abort is still taken. */
  async drainAndClose(): Promise<void> {
    await this.settled(true);
  }

  private async settled(close: boolean): Promise<void> {
    for (;;) {
      if (this.inflight.size > 0) {
        await Promise.allSettled([...this.inflight]);
        continue;
      }
      const live = this.deps.session();
      if (live && live.stats().busy) {
        await sleep(IDLE_POLL_MS);
        continue;
      }
      if (close) this.accepting = false;
      return;
    }
  }
}

/** The ack the worker sends: one request, named by the control's id. */
export function ackSender(
  request: (op: string, body: unknown) => Promise<unknown>,
): (ack: ControlAck) => Promise<void> {
  return async (ack) => {
    await request(CONTROL_ACK_OP, ack);
  };
}
