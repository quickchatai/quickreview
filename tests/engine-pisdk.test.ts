// PiHost [P2.8]: the model's bash environment, and the host's own contract.
// The isolation canaries (HOME, tools, dispatcher) live in tests/pi-canary/.
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai";
import { DEFAULT_BASH_ENV_ALLOW, PiHost, buildBashEnv } from "../src/engine/pisdk.js";
import { GITHUB_TOKEN_ENVS } from "../src/envstrip.js";
import { type HostRig, createHostRig, useOfflineGuard } from "./pi-canary/harness.js";

useOfflineGuard();

describe("buildBashEnv", () => {
  const piEnv = { PI_SESSION_ID: "s-1", PI_MODEL: "m", PROCESS_ONLY: "no", GH_TOKEN: "pi-leak" };

  it("takes the spec's env through the allowlist, never the process's", () => {
    const env = buildBashEnv(
      { PATH: "/bin", HOME: "/h", LC_ALL: "C", SECRET_THING: "x", QCR_PR: "7" },
      piEnv,
    );
    expect(env).toEqual({
      PATH: "/bin",
      HOME: "/h",
      LC_ALL: "C",
      PI_SESSION_ID: "s-1",
      PI_MODEL: "m",
    });
  });

  it("a route widens the allowlist by name or by prefix, and sets explicit values", () => {
    const env = buildBashEnv(
      { PATH: "/bin", QCR_PR: "7", QCR_ROOT: "/r", OTHER: "1" },
      {},
      {
        allow: ["QCR_*", "OTHER"],
        set: { GIT_CONFIG_COUNT: "1" },
      },
    );
    expect(env).toEqual({
      PATH: "/bin",
      QCR_PR: "7",
      QCR_ROOT: "/r",
      OTHER: "1",
      GIT_CONFIG_COUNT: "1",
    });
  });

  it("the GitHub token names never pass: not allowlisted, not set, not through a prefix", () => {
    const tokens = Object.fromEntries(GITHUB_TOKEN_ENVS.map((n) => [n, "ghs_secret"]));
    const env = buildBashEnv({ PATH: "/bin", ...tokens }, tokens, {
      allow: [...GITHUB_TOKEN_ENVS, "GH*", "GITHUB_*"],
      set: tokens,
    });
    expect(Object.keys(env)).toEqual(["PATH"]);
    expect(DEFAULT_BASH_ENV_ALLOW).not.toContain("GITHUB_TOKEN");
  });
});

describe("the model's bash through a real session", () => {
  let rig: HostRig;
  beforeEach(async () => {
    rig = await createHostRig();
    vi.stubEnv("GITHUB_TOKEN", "ghs_PROCESS_TOKEN");
    vi.stubEnv("GH_TOKEN", "ghs_PROCESS_GH");
    vi.stubEnv("PROCESS_ONLY_VAR", "from-the-process");
  });
  afterEach(() => {
    vi.unstubAllEnvs();
    rig.close();
  });

  async function bashOutput(
    command: string,
    spec: Partial<Parameters<PiHost["makeSession"]>[0]> = {},
  ): Promise<string> {
    const session = await rig.host.makeSession({
      cwd: rig.dir,
      env: { PATH: process.env["PATH"], HOME: join(rig.dir, "home") },
      model: rig.faux.getModel(),
      tools: ["bash"],
      ...spec,
    });
    rig.faux.setResponses([
      fauxAssistantMessage([fauxToolCall("bash", { command })], { stopReason: "toolUse" }),
      fauxAssistantMessage("done"),
    ]);
    await session.prompt("go");
    const result = session.messages.find((m) => m.role === "toolResult") as unknown as {
      isError: boolean;
      content: { text: string }[];
    };
    expect(result.isError).toBe(false);
    return result.content.map((c) => c.text).join("\n");
  }

  it("GITHUB_TOKEN and GH_TOKEN are invisible to bash, from env, printenv and /proc", async () => {
    const out = await bashOutput(
      'env; echo ---; printenv GITHUB_TOKEN GH_TOKEN GH_ENTERPRISE_TOKEN; echo "rc=$?"; echo ---; tr "\\0" "\\n" < /proc/$$/environ',
      {
        // Even a route that hands them over by mistake cannot reach the model.
        env: {
          PATH: process.env["PATH"],
          GITHUB_TOKEN: "ghs_SPEC_TOKEN",
          GH_TOKEN: "ghs_SPEC_GH",
        },
        bashEnv: { allow: ["GITHUB_*", "GH_*"], set: { GH_ENTERPRISE_TOKEN: "ghs_SET" } },
      },
    );
    expect(out).not.toMatch(/ghs_/);
    expect(out).not.toMatch(/GITHUB_TOKEN|GH_TOKEN|GH_ENTERPRISE_TOKEN/);
    expect(out).toContain("rc=1");
  });

  it("the process's own env is not the source: an unlisted variable is absent, a listed one present", async () => {
    const out = await bashOutput("env", {
      env: { PATH: process.env["PATH"], LANG: "C.UTF-8", QCR_PR: "7", HIDDEN: "1" },
      bashEnv: { allow: ["QCR_PR"], set: { GIT_CONFIG_COUNT: "1" } },
    });
    const lines = out.split("\n");
    expect(lines).toContain("LANG=C.UTF-8");
    expect(lines).toContain("QCR_PR=7");
    expect(lines).toContain("GIT_CONFIG_COUNT=1");
    expect(lines.some((l) => l.startsWith("PI_SESSION_ID="))).toBe(true);
    expect(out).not.toContain("PROCESS_ONLY_VAR");
    expect(out).not.toContain("HIDDEN");
  });
});

describe("PiHost.create and makeSession", () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "pisdk-"));
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it("refuses a relative agentDir: nothing may default to the operator's home", async () => {
    await expect(PiHost.create({ agentDir: "relative/agent" })).rejects.toThrow(/absolute/);
  });

  it("looks a `provider/id` model up on its own runtime and refuses an unknown one", async () => {
    const rig = await createHostRig();
    try {
      const m = rig.faux.getModel();
      const session = await rig.host.makeSession({
        cwd: rig.dir,
        env: {},
        model: `${m.provider}/${m.id}`,
      });
      expect(session.model?.id).toBe(m.id);
      await expect(
        rig.host.makeSession({ cwd: rig.dir, env: {}, model: "nope/none" }),
      ).rejects.toThrow(/not known/);
    } finally {
      rig.close();
    }
  });

  it("gives each session a unique id and the spec's system prompt, and disposes them all", async () => {
    const rig = await createHostRig();
    try {
      const make = () =>
        rig.host.makeSession({
          cwd: rig.dir,
          env: {},
          model: rig.faux.getModel(),
          systemPrompt: "SPEC-PROMPT",
          tools: [],
        });
      const [a, b] = [await make(), await make()];
      expect(a.sessionId).not.toBe(b.sessionId);
      expect(a.systemPrompt).toContain("SPEC-PROMPT");
      rig.host.dispose();
      rig.host.dispose();
    } finally {
      rig.close();
    }
  });
});
