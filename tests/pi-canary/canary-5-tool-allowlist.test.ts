// Canary 5 : the session's tool list is the allowlist, exactly.
//
// A review session must hold the tools its route named and no others: not pi's
// defaults, not an extension's extra, not an MCP or codemode tool a settings file
// would have switched on. The set is read three ways: what the session says is
// active, what it says is registered, and what the provider is actually told
// (the request's tool declarations), since the last is what the model can call.
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { Type, fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai";
import type { ToolDefinition } from "@earendil-works/pi-coding-agent";
import { DEFAULT_TOOLS } from "@quickchatai/pi-quickreview/src/engine/pisdk.js";
import { type HostRig, createHostRig, useOfflineGuard } from "./harness.js";

useOfflineGuard();

let rig: HostRig;
beforeEach(async () => {
  rig = await createHostRig();
});
afterEach(() => rig.close());

const probe: ToolDefinition = {
  name: "probe",
  label: "probe",
  description: "a custom tool",
  parameters: Type.Object({}),
  execute: async () => ({ content: [{ type: "text", text: "probed" }], details: undefined }),
};

/** The tool names the provider was told about on the session's first request. */
async function declaredTools(session: Awaited<ReturnType<typeof rig.host.makeSession>>) {
  let declared: string[] = [];
  rig.faux.setResponses([
    (context) => {
      const system = context.messages[0] as unknown as { toolsAdded?: { name: string }[] };
      declared = (system.toolsAdded ?? []).map((t) => t.name);
      return fauxAssistantMessage("ok");
    },
  ]);
  await session.prompt("go");
  return declared.sort();
}

const spec = () => ({ cwd: rig.dir, env: {}, model: rig.faux.getModel() });

describe("[canary 5] the tool list is the allowlist", () => {
  it("pi's four defaults when the spec names none, and DEFAULT_TOOLS says so", async () => {
    expect([...DEFAULT_TOOLS].sort()).toEqual(["bash", "edit", "read", "write"]);
    const session = await rig.host.makeSession(spec());
    expect(session.getActiveToolNames().sort()).toEqual(["bash", "edit", "read", "write"]);
    expect(await declaredTools(session)).toEqual(["bash", "edit", "read", "write"]);
  });

  it("a named allowlist is active, registered and declared, and nothing else is", async () => {
    const session = await rig.host.makeSession({ ...spec(), tools: ["read", "grep", "ls"] });
    expect(session.getActiveToolNames().sort()).toEqual(["grep", "ls", "read"]);
    expect(
      session
        .getAllTools()
        .map((t) => t.name)
        .sort(),
    ).toEqual(["grep", "ls", "read"]);
    expect(await declaredTools(session)).toEqual(["grep", "ls", "read"]);
  });

  it("an empty allowlist is no tools at all", async () => {
    const session = await rig.host.makeSession({ ...spec(), tools: [] });
    expect(session.getActiveToolNames()).toEqual([]);
    expect(session.getAllTools()).toEqual([]);
    expect(await declaredTools(session)).toEqual([]);
  });

  it("an extension's or a custom tool is dropped unless the allowlist names it", async () => {
    const withExtra = (tools: string[]) =>
      rig.host.makeSession({
        ...spec(),
        tools,
        customTools: [probe],
        extensions: [
          (pi) => {
            pi.registerTool({ ...probe, name: "from_extension", label: "from_extension" });
          },
        ],
      });
    const closed = await withExtra(["read"]);
    expect(closed.getActiveToolNames()).toEqual(["read"]);
    expect(closed.getAllTools().map((t) => t.name)).toEqual(["read"]);
    const open = await withExtra(["read", "probe", "from_extension"]);
    expect(open.getActiveToolNames().sort()).toEqual(["from_extension", "probe", "read"]);
    expect(await declaredTools(open)).toEqual(["from_extension", "probe", "read"]);
  });

  it("a tool the model calls outside the allowlist does not run", async () => {
    const session = await rig.host.makeSession({
      ...spec(),
      tools: ["read"],
      customTools: [probe],
    });
    rig.faux.setResponses([
      fauxAssistantMessage([fauxToolCall("probe", {})], { stopReason: "toolUse" }),
      fauxAssistantMessage("after"),
    ]);
    await session.prompt("go");
    const result = session.messages.find((m) => m.role === "toolResult") as unknown as
      { isError: boolean; content: { text: string }[] } | undefined;
    expect(result?.isError).toBe(true);
    expect(result?.content[0]?.text).not.toContain("probed");
  });

  it("wildcards, modifiers and odd names are refused, not interpreted", async () => {
    for (const bad of ["*", "re*", "+bash", "-bash", "mcp__*", "read bash", ""]) {
      await expect(rig.host.makeSession({ ...spec(), tools: [bad] }), bad).rejects.toThrow(
        /exact names/,
      );
    }
  });
});
