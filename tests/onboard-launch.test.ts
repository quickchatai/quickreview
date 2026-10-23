// `qcr onboard` launch mechanics: the npx argv at the pinned
// version, the restricted session shape, and the post-exit handoff (complete ⇒
// TUI; incomplete ⇒ resume instructions). All spawns faked.
import { describe, expect, it } from "vitest";
import {
  onboardingPiArgv,
  onboardingSessionDir,
  piPinFromPackageJson,
  runOnboard,
  type OnboardRunDeps,
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
    const tools = argv.indexOf("--tools");
    expect(argv[tools + 1]).toBe("read,ls,grep");
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

function deps(
  complete: boolean,
  spawns: Array<{ cmd: string; args: string[] }>,
  codes: number[] = [0, 0],
): OnboardRunDeps {
  let call = 0;
  return {
    pin: PIN,
    root: ROOT,
    spawn: async (cmd, args) => {
      spawns.push({ cmd, args });
      return codes[call++] ?? 0;
    },
    isComplete: () => complete,
    log: () => {},
    cliPath: "/clone/dist/src/cli.js",
    nodeBin: "/usr/bin/node",
  };
}

describe("runOnboard", () => {
  it("incomplete checklist: one pi spawn, resume instructions, pi's exit code propagated", async () => {
    const spawns: Array<{ cmd: string; args: string[] }> = [];
    const lines: string[] = [];
    const d = deps(false, spawns, [3]);
    d.log = (l) => lines.push(l);
    const code = await runOnboard(d);
    expect(code).toBe(3);
    expect(spawns).toHaveLength(1);
    expect(spawns[0]?.cmd).toBe("npx");
    expect(lines.join("\n")).toMatch(/qcr onboard` again to resume/);
  });

  it("complete checklist: hands off to the TUI with inherited stdio semantics (second spawn)", async () => {
    const spawns: Array<{ cmd: string; args: string[] }> = [];
    const code = await runOnboard(deps(true, spawns, [0, 7]));
    expect(code).toBe(7); // the TUI's exit code is the wizard's
    expect(spawns).toHaveLength(2);
    expect(spawns[1]).toEqual({ cmd: "/usr/bin/node", args: ["/clone/dist/src/cli.js", "tui"] });
  });
});
