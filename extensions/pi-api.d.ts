// Minimal ambient declarations for the slice of the pi extension API the two
// sandbox extensions use. pi is NOT installed in this repo (it lives only in
// the VM container), so nothing here is checked against the real package:
// EVERY declaration below is // VERIFY-ON-PIN against
// assets/findings.md §5 and pi.dev/docs/latest/extensions.
//
// VERIFY-ON-PIN: module name — findings §4 name the package
// "@earendil-works/pi-coding-agent" (legacy scope "@mariozechner/pi-coding-agent").
// VERIFY-ON-PIN: whether extensions import types from the package at all, or
// are plain untyped default-export functions loaded through jiti.

declare module "@earendil-works/pi-coding-agent" {
  /** VERIFY-ON-PIN: documented event names (findings §5). Only the ones the
   * sandbox extensions hook are enumerated; the string index keeps unknown
   * events usable without a declaration change. */
  export type PiEvent =
    | "session_start"
    | "session_shutdown"
    | "session_before_compact"
    | "session_compact"
    | "turn_end"
    | "agent_settled"
    | "tool_call"
    | (string & {});

  /** VERIFY-ON-PIN: the event payload shape is undocumented in the findings.
   * Handlers must treat every field as optional and degrade gracefully. */
  export interface PiEventPayload {
    [key: string]: unknown;
  }

  /** The compaction a `session_before_compact` handler may supply.
   * VERIFIED against pi 1.0.0's shipped dist (read out of the bench image,
   * `qcr-bench:fast1`, @earendil-works/pi-coding-agent 1.0.0):
   * `dist/core/compaction/compaction.d.ts` `CompactionResult`. pi reads
   * exactly these five fields off it (`dist/core/agent-session.js`,
   * `compact()` and `_runAutoCompaction()`, the `extensionCompaction` branch)
   * and hands them to `sessionManager.appendCompaction`. */
  export interface PiCompactionResult {
    summary: string;
    firstKeptEntryId: string;
    tokensBefore: number;
    estimatedTokensAfter?: number;
    usage?: unknown;
    details?: unknown;
  }

  /** Return shape of a session_before_compact handler. VERIFIED
   * against pi 1.0.0: `dist/core/extensions/types.d.ts`
   * `SessionBeforeCompactResult` is `{ cancel?, compaction? }`, and
   * `dist/core/agent-session.js` reads only `result.cancel` and
   * `result.compaction` — any other key is silently ignored (the legacy
   * `instructions`/`summary`/`retainedTail`/`details` carriers were inert,
   * MC-64). Only the LAST non-undefined handler result counts
   * (`dist/core/extensions/runner.js` `emit`). */
  export interface CompactHandlerResult {
    cancel?: boolean;
    compaction?: PiCompactionResult;
  }

  /** `event.preparation` of session_before_compact. VERIFIED against pi 1.0.0
   * `dist/core/compaction/compaction.d.ts` `CompactionPreparation` (the fields
   * ledger-pin touches; the object is passed through to `compact()` whole). */
  export interface PiCompactionPreparation {
    firstKeptEntryId: string;
    tokensBefore: number;
    previousSummary?: string;
    [key: string]: unknown;
  }

  /** pi's own default summariser, a public export of the package root in
   * 1.0.0 (`dist/index.js` re-exports `compact` from
   * `dist/core/compaction/index.js`). Positional signature VERIFIED against
   * `dist/core/compaction/compaction.d.ts`:
   * `compact(preparation, model, apiKey, headers?, customInstructions?,
   * signal?, thinkingLevel?, streamFn?, env?, retry?, callbacks?, sessionId?)`. */
  export function compact(
    preparation: PiCompactionPreparation,
    model: unknown,
    apiKey: string | undefined,
    headers?: Record<string, string>,
    customInstructions?: string,
    signal?: AbortSignal,
    thinkingLevel?: string,
    streamFn?: (model: unknown, context: unknown, options: unknown) => unknown,
    env?: Record<string, string>,
  ): Promise<PiCompactionResult>;

  /** Request-time auth for a model. VERIFIED against pi 1.0.0
   * `dist/core/model-registry.d.ts` `ResolvedRequestAuth`. */
  export type PiResolvedRequestAuth =
    | {
        ok: true;
        apiKey?: string;
        headers?: Record<string, string>;
        baseUrl?: string;
        env?: Record<string, string>;
      }
    | { ok: false; error: string };

  /** The slice of pi 1.0.0's `ModelRegistry` ledger-pin uses
   * (`dist/core/model-registry.d.ts`). */
  export interface PiModelRegistry {
    getApiKeyAndHeaders(model: unknown): Promise<PiResolvedRequestAuth>;
    streamSimple(model: unknown, context: unknown, options?: unknown): unknown;
  }

  export interface PiEventContext {
    /** VERIFY-ON-PIN: documented extension UI surface in pi 0.84.1. */
    ui?: { setTheme(theme: string | unknown): { success: boolean; error?: string } };
    /** VERIFIED against pi 1.0.0 `dist/core/extensions/types.d.ts`
     * `ExtensionContext` (getters in `dist/core/extensions/runner.js`
     * `createContext`): the model registry, the current model (may be
     * undefined) and the current thinking level. */
    modelRegistry?: PiModelRegistry;
    model?: unknown;
    thinkingLevel?: string;
    [key: string]: unknown;
  }

  /** tool_call event payload. VERIFIED capability (findings §5 lines
   * 132-141): handlers see the tool name + input and `event.input` is mutable.
   * VERIFY-ON-PIN: the exact field names (`toolName` vs `name`, `input` vs
   * `arguments`) — consumers must probe both and degrade gracefully. */
  export interface ToolCallEvent extends PiEventPayload {
    toolName?: string;
    /** Mutable per §5 lines 132-141 (handlers may rewrite tool input). */
    input?: Record<string, unknown>;
    arguments?: Record<string, unknown>;
  }

  /** Return shape a tool_call handler uses to veto the call. VERIFIED
   * (findings §5 lines 132-141): `{ block: true, reason }` blocks the
   * tool call and surfaces `reason` to the model. VERIFY-ON-PIN: additional
   * keys, and whether `reason` is required when blocking. */
  export interface ToolCallBlockResult {
    block?: boolean;
    reason?: string;
    [key: string]: unknown;
  }

  export type PiEventHandler = (
    event: PiEventPayload,
    context?: PiEventContext,
  ) =>
    | void
    | CompactHandlerResult
    | ToolCallBlockResult
    | Promise<void | CompactHandlerResult | ToolCallBlockResult>;

  /** VERIFY-ON-PIN: message-delivery options (findings §3 option 2). */
  export interface SendMessageOptions {
    deliverAs?: "steer" | "followUp" | "nextTurn";
    triggerTurn?: boolean;
    expandPromptTemplates?: boolean;
  }

  export interface PiSessionInfo {
    /** VERIFY-ON-PIN: display name set by --name / /name. */
    name?: string;
    id?: string;
    cwd?: string;
    path?: string;
  }

  /** What a registered tool hands back to the model. VERIFY-ON-PIN: the
   * `content` array shape is copied from the vendored OpenViking extension
   * (`extensions/vendor/openviking-pi/tools.ts`), which is live against
   * 0.84.1 — the only evidence we have for it here. */
  export interface PiToolResult {
    content: Array<{ type: "text"; text: string }>;
    details?: Record<string, unknown>;
  }

  /** Context handed to a registered tool's `execute` (5th positional arg).
   *
   * VERIFY-ON-PIN, whole interface: nothing here is declared in the findings.
   * `shutdown` is the deferred session shutdown the onboarding finish tool
   * calls — assumed to end the pi session cleanly AFTER the current
   * tool result is delivered (idle-deferral) with exit code 0; both halves of
   * that assumption are unverified against the pinned version and belong to
   * the named onboarding smoke step. Callers must probe for it and degrade
   * (tell the operator to /exit) when absent. */
  export interface PiToolContext {
    shutdown?(): void | Promise<void>;
    [key: string]: unknown;
  }

  /** A tool definition passed to `pi.registerTool`.
   *
   * VERIFY-ON-PIN, every field: modelled on the five `registerTool` calls in
   * the vendored fork. `parameters` is a TypeBox schema there; TypeBox schemas
   * ARE plain JSON Schema objects at runtime, so a literal
   * `{ type: "object", properties: {} }` is assumed equivalent — that
   * assumption is why `tui-view.ts` needs no TypeBox import, and it is the one
   * to check first if the tools do not appear in pi.
   *
   * VERIFY-ON-PIN: `execute`'s positional signature
   * `(id, params, signal, onUpdate, ctx)`. */
  export interface PiToolDefinition {
    name: string;
    label?: string;
    description: string;
    promptSnippet?: string;
    promptGuidelines?: string[];
    parameters: unknown;
    execute(
      id: string,
      params: Record<string, unknown>,
      signal?: AbortSignal,
      onUpdate?: unknown,
      ctx?: PiToolContext,
    ): PiToolResult | Promise<PiToolResult>;
  }

  export interface Pi {
    on(event: PiEvent, handler: PiEventHandler): void;
    /** VERIFY-ON-PIN: tool registration. Present in 0.84.1 per the vendored
     * fork's own usage; OPTIONAL here on purpose — an extension that finds it
     * missing must degrade to registering nothing, never to a pi that will not
     * start (the companion never wedges). */
    registerTool?(definition: PiToolDefinition): void;
    /** Injects a real user message. Pinned Pi 0.84.1 exposes this to extensions
     * as fire-and-forget `void`; its internal Promise and rejection are not
     * observable at this interface (verified against extensions/types.d.ts
     * and agent-session.js while diagnosing PR #5408). */
    sendUserMessage(content: string, options?: SendMessageOptions): void;
    sendMessage?(message: unknown, options?: SendMessageOptions): void | Promise<void>;
    /** Persists extension state into the session file as a `custom` entry
     * (not sent to the LLM). VERIFIED against pi 1.0.0
     * `dist/core/extensions/types.d.ts` `ExtensionAPI.appendEntry<T>(customType:
     * string, data?: T): void` → `dist/core/agent-session.js`
     * `sessionManager.appendCustomEntry(customType, data)` (it took
     * one object before, which 1.0.0 would store as the customType). */
    appendEntry?(customType: string, data?: unknown): void;
    /** VERIFY-ON-PIN: accessor for the live session's info. */
    session?: PiSessionInfo;
    events?: {
      on(name: string, handler: (payload: unknown) => void): void;
      emit(name: string, payload: unknown): void;
    };
    exec?: (cmd: string, args?: string[]) => Promise<unknown>;
    [key: string]: unknown;
  }

  /** VERIFY-ON-PIN: extensions are default-exported activation functions. */
  export type Extension = (pi: Pi) => void | Promise<void>;

  // ---- package-root helpers ------------------------------------
  // VERIFIED statically against the published 0.84.4 tarball: both are public
  // exports of the package root (dist/index.js re-exports them from
  // dist/config.js). Used by extensions/subagents.ts to import the native
  // subagent example from the INSTALLED (= pinned) package.
  /** Absolute path of the installed package's `examples/` directory. */
  export function getExamplesPath(): string;
  /** The installed pi package version. */
  export const VERSION: string;
}
