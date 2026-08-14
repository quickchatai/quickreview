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

  export type PiEventHandler = (
    event: PiEventPayload,
    context?: PiEventContext,
  ) => void | CompactHandlerResult | Promise<void | CompactHandlerResult>;

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

  export interface Pi {
    on(event: PiEvent, handler: PiEventHandler): void;
    /** Injects a real user message and always triggers a turn (findings §3). */
    sendUserMessage(content: string, options?: SendMessageOptions): void | Promise<void>;
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
}
