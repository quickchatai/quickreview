// How our extensions write pi tools. pi's `ToolDefinition` types `params` from
// a TypeBox schema and demands a Promise from `execute`; ours declare plain
// JSON-Schema literals (TypeBox schemas ARE plain JSON Schema at runtime), read
// `params` as a loose record, and many answer synchronously. `QcrTool` is that
// shape, and `registerQcrTool` is the one place it meets pi's.
import type {
  AgentToolResult,
  ExtensionAPI,
  ExtensionToolContext,
  ToolDefinition,
} from "@earendil-works/pi-coding-agent";

/** What a tool hands back to the model: text only, which is all ours emit. */
export type QcrToolResult = Omit<
  AgentToolResult<Record<string, unknown> | undefined>,
  "content"
> & {
  content: Array<{ type: "text"; text: string }>;
};

export type QcrTool = Omit<ToolDefinition, "execute"> & {
  execute(
    id: string,
    params: Record<string, unknown>,
    signal?: AbortSignal,
    onUpdate?: unknown,
    ctx?: ExtensionToolContext,
  ): QcrToolResult | Promise<QcrToolResult>;
};

/** A text-only tool result; `details` rides along only when given. */
export function textResult(text: string, details?: Record<string, unknown>): QcrToolResult {
  return { content: [{ type: "text", text }], details };
}

/** `tool` as pi's contract has it: a synchronous `execute` awaited into the
 * Promise pi asks for. */
export function toPiTool(tool: QcrTool): ToolDefinition {
  return {
    ...tool,
    execute: async (id, params, signal, onUpdate, ctx) =>
      tool.execute(id, params as Record<string, unknown>, signal, onUpdate, ctx),
  };
}

export function registerQcrTool(pi: ExtensionAPI, tool: QcrTool): void {
  pi.registerTool(toPiTool(tool));
}
