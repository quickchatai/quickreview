// The production wiring of the memory phase. Every slice
// below degrades SILENTLY and correctly when memory is absent — rounds render
// memory-less, the raw tier is skipped, the watchdog stands down — which is
// the behaviour we want at runtime and exactly what makes an unwired daemon
// invisible to every other test. These assertions are the tripwire: they fail
// if a refactor disconnects memory while leaving the suite green.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { MEMORY_DEFAULTS } from "../src/config.js";
import { DEFAULT_CATEGORY } from "../src/openviking/store.js";

const wire = readFileSync(join(process.cwd(), "src", "wire.ts"), "utf8");

describe("wire.ts: the memory phase is actually connected", () => {
  it("the daemon is handed a round-memory seed built on the assembler", () => {
    expect(wire).toMatch(/memory:\s*\{\s*\n\s*assembler:/);
    expect(wire).toContain("openVikingContextAssembler");
  });

  it("the context search is quota'd to the memory scopes, not left to the server's balance", () => {
    // Unquota'd, the server spreads the block over every scope it holds and a
    // round sees ~one memory entry beside two built-in blurbs — memory is
    // wired but effectively not read. Config-driven so the scopes are a knob.
    expect(wire).toMatch(/quotas:\s*cfg\.memory\.context_quotas/);
    expect(MEMORY_DEFAULTS.context_quotas["experiences"]).toBeGreaterThan(0);
    // Every entry the store writes lands in the default category, so a quota
    // map that omits it would silently starve the round of reviewer memory.
    expect(Object.keys(MEMORY_DEFAULTS.context_quotas)).toContain(DEFAULT_CATEGORY);
  });

  it("the round renderer receives the assembled seed", () => {
    // the owner name rides along so the pinned-head framing renders
    // from config.
    // the profile-selected ecosystem rides along too, so a none
    // profile's prompts really carry no migration-gate prose.
    // the identity variable map rides beside them.
    expect(wire).toMatch(
      /renderRoundPrompt\([\s\S]*?order,\s*memory,\s*cfg\.owner\.name,\s*ecosystem,\s*identity,?\s*\)/,
    );
    expect(wire).toMatch(/renderPrompt = \(order: RoundOrder, memory: RoundMemory\)/);
  });

  it("PR sessions are given the OpenViking session lifecycle (the raw tier)", () => {
    expect(wire).toContain("openVikingSessionLifecycle");
    expect(wire).toMatch(/new PiSessionManager\(\{[^}]*ovSessions/s);
  });

  it("the feedback sink writes through the OpenViking store, not a default", () => {
    expect(wire).toMatch(/new FeedbackEngine\(\{[^}]*memory[,}]/s);
    expect(wire).toContain("openVikingStore(memoryClient");
  });

  it("the EOD inject is wrapped by the pinned-area watchdog", () => {
    expect(wire).toContain("startEodPinWatch");
    expect(wire).toMatch(/injectOverseer:\s*pinWatch \? pinWatch\.wrapInject/);
  });

  it("the daemon materializes the memory root when the server comes up", () => {
    // Without this the daemon's first sweep on a fresh server lists a root
    // that does not exist and leans on how the server spells a missing one.
    expect(wire).toMatch(/new OpenVikingSupervisor\(\{[\s\S]*?onReady:[\s\S]*?ensureWritable\(\)/);
  });

  it("only the reviewer USER key is ever read — never ADMIN or ROOT", () => {
    expect(wire).toContain("OV_REVIEWER_KEY_SECRET");
    expect(wire).not.toMatch(/root_api_key|admin_key|ROOT_KEY/i);
  });
  it("the EOD pin-watch waits for the digest where the sweep WRITES it — the sandbox root's digest/, the same dir the headline reads", () => {
    // prompts/eod-sweep.md has the overseer (cwd = the sandbox root) write
    // `digest/<date>.md`. A readiness probe on state/digest/ never saw it, so
    // the watch never closed early and ran its whole window every night.
    expect(wire).toContain('latestDigestHeadline(join(root, "digest"))');
    expect(wire).toMatch(
      /digestReady:\s*\(date\)\s*=>\s*digestWritten\(date, join\(root, "digest"\)\)/,
    );
    expect(wire).not.toMatch(/"state",\s*"digest"/);
  });
});
