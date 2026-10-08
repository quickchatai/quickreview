// A fake pi 1.0.0 session for the inject bridge (H1b): just enough of
// `AgentSession` to reproduce the 2026-10-08 failure and its fix.
//
// Modelled on the pinned dist (`core/agent-session.js`), the parts that matter:
//   - `prompt()` REFUSES while a compaction runs ("Cannot submit a prompt while
//     compaction is in progress"), and the extension-facing `sendUserMessage`
//     swallows that refusal — the bridge never sees it;
//   - a prompt sent while a run is active is queued as a followUp and runs
//     inside that run, before it settles;
//   - manual compaction (`/compact` typed, or `ctx.compact()`) aborts a running
//     turn first, emits `session_before_compact`, and ends with
//     `session_compact` (emitted BEFORE pi clears its compaction state) or, on
//     failure, `session_compact_failed` (after the clear) — and never
//     `agent_settled`;
//   - `ctx.isIdle()` = no run and no compaction; `ctx.hasPendingMessages()` =
//     queued prompts exist;
//   - every prompt past the compaction refusal emits `input` (source
//     "extension") before the rest of its preflight.
import type { Pi } from "@earendil-works/pi-coding-agent";

type Handler = (event: unknown, ctx: unknown) => unknown;

interface CompactOptions {
  onComplete?: (result: unknown) => void;
  onError?: (error: Error) => void;
}

function userMessage(text: string): unknown {
  return { message: { role: "user", content: [{ type: "text", text }] } };
}

export class FakePiSession {
  readonly handlers = new Map<string, Handler[]>();
  /** An agent run is active (pi `_isAgentRunActive`). */
  runActive = false;
  /** pi's compaction state is set (`_compactionAbortController`). */
  compacting = false;
  /** Prompts queued as followUps inside the active run. */
  followUps: string[] = [];
  /** Every `sendUserMessage` the bridge made. */
  sends: string[] = [];
  /** Prompts pi refused and swallowed (compaction, or `refuseNext`). */
  refused: string[] = [];
  /** Prompts that became the user message of a run. */
  accepted: string[] = [];
  /** `ctx.compact()` calls (the bridge's requested compactions). */
  compactCalls = 0;
  /** Refuse this many more prompts BEFORE pi's input stage — where pi 1.0.0
   * refuses a send into a compaction — so no `input` event is emitted for
   * them: a submission pi never took. */
  refuseNext = 0;
  /** Lose this many more prompts AFTER their `input` event (a preflight
   * failure past the input stage — auth, say — that pi swallows the same
   * way): pi took them, the bridge cannot tell they are gone. */
  failAfterInputNext = 0;
  /** Hold the next prompt "in preflight": accepted by pi but its run not yet
   * started — `startHeld()` starts it later. */
  holdNextInPreflight = false;
  held: string | undefined;
  private compactOptions: CompactOptions | undefined;

  readonly ctx = {
    isIdle: (): boolean => !this.runActive && !this.compacting,
    hasPendingMessages: (): boolean => this.followUps.length > 0,
    compact: (options?: CompactOptions): void => {
      this.compactCalls++;
      this.startCompaction(options);
    },
  };

  /** `withContext: false` models a pi that hands handlers no context. */
  constructor(private readonly opts: { withContext?: boolean } = {}) {}

  pi(): Pi {
    return {
      on: (event: string, handler: Handler) => {
        const list = this.handlers.get(event) ?? [];
        list.push(handler);
        this.handlers.set(event, list);
      },
      sendUserMessage: (content: string) => this.prompt(content),
    } as unknown as Pi;
  }

  fire(event: string, payload: unknown = {}): void {
    const ctx = this.opts.withContext === false ? undefined : this.ctx;
    for (const handler of this.handlers.get(event) ?? []) handler(payload, ctx);
  }

  private prompt(content: string): void {
    this.sends.push(content);
    if (this.compacting) {
      // pi 1.0.0 `prompt()`: throws inside the swallowed promise.
      this.refused.push(content);
      return;
    }
    if (this.refuseNext > 0) {
      this.refuseNext--;
      this.refused.push(content);
      return;
    }
    // pi 1.0.0 `prompt()` -> `_runInputHandlers` -> `emitInput`: synchronous
    // up to the first handler, right after the compaction refusal.
    this.fire("input", {
      type: "input",
      text: content,
      source: "extension",
      ...(this.runActive ? { streamingBehavior: "followUp" } : {}),
    });
    if (this.failAfterInputNext > 0) {
      this.failAfterInputNext--;
      this.refused.push(content);
      return;
    }
    if (this.runActive) {
      this.followUps.push(content);
      return;
    }
    if (this.holdNextInPreflight) {
      this.holdNextInPreflight = false;
      this.held = content;
      return;
    }
    this.startRun(content);
  }

  /** Start the prompt held "in preflight". */
  startHeld(): void {
    const content = this.held;
    this.held = undefined;
    if (content !== undefined) this.startRun(content);
  }

  startRun(content: string): void {
    this.runActive = true;
    this.fire("agent_start");
    this.fire("message_start", userMessage(content));
    this.accepted.push(content);
  }

  /** End the active run; queued followUps run inside it first, as pi does. */
  settle(): void {
    while (this.followUps.length > 0) {
      const next = this.followUps.shift()!;
      this.fire("message_start", userMessage(next));
      this.accepted.push(next);
    }
    this.runActive = false;
    this.fire("agent_end");
    this.fire("agent_settled");
  }

  /** Manual compaction begins (`/compact` typed, or `ctx.compact()`): a
   * running turn is aborted first, then the compaction state is set. */
  startCompaction(options?: CompactOptions): void {
    if (this.runActive) this.settle();
    this.compacting = true;
    this.compactOptions = options;
    this.fire("session_before_compact", { reason: "manual" });
  }

  /** pi 1.0.0's end order — success: `session_compact` while the state is
   * still set, then the clear, then `onComplete`; failure: the clear, then
   * `session_compact_failed`, then `onError`. No `agent_settled` either way. */
  finishCompaction(ok = true): void {
    const options = this.compactOptions;
    this.compactOptions = undefined;
    if (ok) {
      this.fire("session_compact", {});
      this.compacting = false;
      options?.onComplete?.({});
    } else {
      this.compacting = false;
      this.fire("session_compact_failed", { aborted: false });
      options?.onError?.(new Error("Compaction failed"));
    }
  }
}
