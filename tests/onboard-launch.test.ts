// The onboarding wizard's pi session: the npx argv at the pinned version and
// the restricted session shape. `qcr onboard`, the door that ran it, is gone
// (a bare `qcr` opens the home); the wizard's steps stay for the home's
// Advanced route.
import { describe, expect, it } from "vitest";
import {
  onboardingPiArgv,
  onboardingSessionDir,
  piPinFromPackageJson,
} from "../src/onboard/launch.js";

const PIN = { package: "@earendil-works/pi-coding-agent", version: "0.84.4" };
const ROOT = "/clone";

describe("onboardingPiArgv", () => {
  const argv = onboardingPiArgv(PIN, ROOT);

  it("launches pi via npx at the exact pinned version — pi stays a non-dependency", () => {
    expect(argv.slice(0, 3)).toEqual(["npx", "-y", "@earendil-works/pi-coding-agent@0.84.4"]);
  });

  it("never blocks on pi's trust modal (--approve, the rule-7 discipline)", () => {
    expect(argv).toContain("--approve");
  });

  it("loads NO ambient extensions/skills/context and exactly one onboarding extension", () => {
    expect(argv).toContain("--no-extensions");
    expect(argv).toContain("--no-skills");
    expect(argv).toContain("--no-context-files");
    const e = argv.indexOf("-e");
    expect(argv[e + 1]).toBe("/clone/extensions/cli/onboarding.ts");
    // exactly one extension flag
    expect(argv.filter((a) => a === "-e" || a === "--extension")).toHaveLength(1);
  });

  it("carries the onboarding system prompt and the restricted read-only tool belt", () => {
    const sp = argv.indexOf("--system-prompt");
    expect(argv[sp + 1]).toBe("/clone/prompts/onboarding.md");
    const tools = argv[argv.indexOf("--tools") + 1]!.split(",");
    // pi's --tools allowlist covers extension tools too: the read-only belt,
    // then every wizard tool (tests/onboard-tools-sdk.test.ts on the real SDK).
    expect(tools.slice(0, 3)).toEqual(["read", "ls", "grep"]);
    expect(tools).toContain("onboard_status");
    expect(tools).toContain("finish_and_exit");
    expect(tools).toContain("onboard_llm_auth");
    for (const t of ["bash", "write", "edit"]) expect(tools).not.toContain(t);
    expect(onboardingPiArgv(PIN, ROOT, ["a", "b"])[argv.indexOf("--tools") + 1]).toBe(
      "read,ls,grep,onboard_a,onboard_b,onboard_status,finish_and_exit",
    );
  });

  it("uses a dedicated session dir under state/ so onboarding never pollutes other session stores", () => {
    const sd = argv.indexOf("--session-dir");
    expect(argv[sd + 1]).toBe("/clone/state/onboarding/pi-sessions");
    expect(onboardingSessionDir(ROOT)).toBe("/clone/state/onboarding/pi-sessions");
  });
});

describe("piPinFromPackageJson", () => {
  it("reads the pin mirror from the package.json qcrPi block", () => {
    const pin = piPinFromPackageJson(ROOT, () =>
      JSON.stringify({ qcrPi: { package: "p", version: "1.2.3" } }),
    );
    expect(pin).toEqual({ package: "p", version: "1.2.3" });
  });

  it("returns null (never throws) on garbage or a missing block", () => {
    expect(piPinFromPackageJson(ROOT, () => "not json")).toBeNull();
    expect(piPinFromPackageJson(ROOT, () => JSON.stringify({}))).toBeNull();
    expect(
      piPinFromPackageJson(ROOT, () => JSON.stringify({ qcrPi: { package: "p" } })),
    ).toBeNull();
  });
});
