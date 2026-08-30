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

  /** VERIFY-ON-PIN: return shape of a session_before_compact handler —
   * findings §6 say a handler may cancel or "supply a custom summary with
   * custom details"; the exact keys are unverified. */
  export interface CompactHandlerResult {
    cancel?: boolean;
    summary?: string;
    instructions?: string;
    retainedTail?: unknown;
    details?: Record<string, unknown>;
    [key: string]: unknown;
  }

  export interface PiEventContext {
    /** VERIFY-ON-PIN: documented extension UI surface in pi 0.84.1. */
    ui?: { setTheme(theme: string | unknown): { success: boolean; error?: string } };
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
      ctx?: unknown,
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
    /** Persists extension state into the session file (findings §5). */
    appendEntry?(entry: unknown): void | Promise<void>;
    /** VERIFY-ON-PIN: accessor for the live session's info. */
    session?: PiSessionInfo;
    events?: { on(name: string, handler: (payload: unknown) => void): void; emit(name: string, payload: unknown): void };
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
