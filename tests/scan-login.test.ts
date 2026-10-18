// `qcr scan login`'s in-container login (src/scanlogin.ts): straight into
// pi's own OAuth flow for one provider — the same `modelRuntime.login` the
// interactive /login runs — with its URL / device code printed, its prompts
// answered from the terminal, the credential written by pi's runtime, and the
// login then verified with `pi auth check`. The runtime and the terminal are
// injected here; no real login is made.
import { describe, expect, it } from "vitest";
import {
  loginProvider,
  parseLoginArgs,
  piLogin,
  type LoginInteraction,
  type LoginRuntime,
} from "../src/scanlogin.js";

const HOUR = 3_600_000;

function io(answers: string[] = []) {
  const lines: string[] = [];
  const asked: Array<{ question: string; secret: boolean }> = [];
  return {
    lines,
    asked,
    io: {
      out: (l: string) => lines.push(l),
      ask: async (question: string, o: { secret: boolean }) => {
        asked.push({ question, secret: o.secret });
        return answers.shift() ?? "";
      },
    },
  };
}

function runtime(flow: (i: LoginInteraction) => Promise<unknown>) {
  const calls: Array<{ provider: string; type: string; deviceId?: string }> = [];
  const r: LoginRuntime = {
    login: async (provider, type, interaction, options) => {
      calls.push({ provider, type, deviceId: options?.getDeviceId?.() });
      return flow(interaction);
    },
  };
  return { r, calls };
}

const ready = async () => ({ status: "ready", provider: "openai-codex", authType: "oauth" });

describe("the in-container login", () => {
  it("runs pi's OAuth login for the provider, prints the URL, takes the pasted code, and reports the token life", async () => {
    const t = io(["http://localhost:1455/auth/callback?code=abc"]);
    const { r, calls } = runtime(async (i) => {
      i.notify({
        type: "auth_url",
        url: "https://auth.example/authorize?x=1",
        instructions: "Open it",
      });
      const code = await i.prompt({ type: "manual_code", message: "Paste the redirect URL" });
      expect(code).toBe("http://localhost:1455/auth/callback?code=abc");
      return { type: "oauth", access: "SECRET", refresh: "R", expires: 5 * HOUR };
    });
    const exit = await piLogin({
      runtime: r,
      provider: "openai-codex",
      io: t.io,
      getDeviceId: () => "dev-1",
      check: ready,
      now: () => 0,
    });
    expect(exit).toBe(0);
    expect(calls).toEqual([{ provider: "openai-codex", type: "oauth", deviceId: "dev-1" }]);
    const text = t.lines.join("\n");
    expect(text).toContain("https://auth.example/authorize?x=1");
    expect(text).toContain("Open it");
    expect(text).toMatch(/5h 0m/);
    expect(text).toMatch(/ready/);
    expect(text).not.toMatch(/SECRET|"R"/);
    expect(t.asked).toEqual([{ question: "Paste the redirect URL", secret: false }]);
  });

  it("prints a device code with its verification address", async () => {
    const t = io();
    const { r } = runtime(async (i) => {
      i.notify({ type: "device_code", userCode: "ABCD-1234", verificationUri: "https://x/device" });
      return { type: "oauth", expires: HOUR };
    });
    await piLogin({
      runtime: r,
      provider: "p",
      io: t.io,
      getDeviceId: () => "d",
      check: ready,
      now: () => 0,
    });
    const text = t.lines.join("\n");
    expect(text).toContain("ABCD-1234");
    expect(text).toContain("https://x/device");
  });

  it("a select prompt lists its options and answers with the chosen one's id; a secret is asked as secret", async () => {
    const t = io(["2", "hunter2"]);
    let picked = "";
    let secret = "";
    const { r } = runtime(async (i) => {
      picked = await i.prompt({
        type: "select",
        message: "How?",
        options: [
          { id: "browser", label: "Browser" },
          { id: "device", label: "Device code" },
        ],
      });
      secret = await i.prompt({ type: "secret", message: "Key" });
      return { type: "oauth", expires: HOUR };
    });
    await piLogin({
      runtime: r,
      provider: "p",
      io: t.io,
      getDeviceId: () => "d",
      check: ready,
      now: () => 0,
    });
    expect(picked).toBe("device");
    expect(secret).toBe("hunter2");
    expect(t.lines.join("\n")).toMatch(/1\. Browser[\s\S]*2\. Device code/);
    expect(t.asked[1]).toMatchObject({ secret: true });
  });

  it("a failed login, or a check that is not ready, exits non-zero with the reason", async () => {
    const t1 = io();
    const failed = runtime(async () => {
      throw new Error("Login cancelled");
    });
    expect(
      await piLogin({
        runtime: failed.r,
        provider: "p",
        io: t1.io,
        getDeviceId: () => "d",
        check: ready,
      }),
    ).toBe(1);
    expect(t1.lines.join("\n")).toMatch(/Login cancelled/);

    const t2 = io();
    const ok = runtime(async () => ({ type: "oauth", expires: HOUR }));
    expect(
      await piLogin({
        runtime: ok.r,
        provider: "p",
        io: t2.io,
        getDeviceId: () => "d",
        check: async () => ({
          status: "not_ready",
          provider: "p",
          reason: "credentials_not_configured",
        }),
      }),
    ).toBe(1);
    expect(t2.lines.join("\n")).toMatch(/credentials_not_configured/);
  });
});

describe("the login's provider", () => {
  it("is the model's provider, openai-codex when none is named", () => {
    expect(loginProvider("openai-codex/gpt-6.1-sol:medium")).toBe("openai-codex");
    expect(loginProvider("anthropic/claude-x")).toBe("anthropic");
    expect(loginProvider("")).toBe("openai-codex");
  });

  it("is required on the script's command line", () => {
    expect(parseLoginArgs(["--provider", "openai-codex"])).toEqual({ provider: "openai-codex" });
    expect(() => parseLoginArgs([])).toThrow(/--provider/);
  });
});
