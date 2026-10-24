// `qcr review`'s credential check (src/loginhint.ts): a login, or the
// provider's own API key, for every provider the review runs on. A key for
// another provider never stands in, and the review never switches models: it
// fails with a hint naming `qcr login`. The OpenAI family is one login: an
// `openai-codex` model runs on an `openai` login or OPENAI_API_KEY, the same
// model id (packages/pi-plugin/src/modelroute.ts).
import { describe, expect, it } from "vitest";
import { reviewLoginRefusal } from "../src/loginhint.js";

const AGENT = "/home/u/.pi/agent";

describe("the review's credential check", () => {
  it("a login for the provider passes", () => {
    expect(
      reviewLoginRefusal({
        providers: ["openai-codex"],
        agentDir: AGENT,
        env: {},
        logins: { "openai-codex": { type: "oauth", expires: 1 } },
      }),
    ).toBeNull();
  });

  it("the provider's own API key passes", () => {
    expect(
      reviewLoginRefusal({
        providers: ["anthropic"],
        agentDir: AGENT,
        env: { ANTHROPIC_API_KEY: "k" },
        logins: {},
      }),
    ).toBeNull();
  });

  // MUTATION: drop the routeProvider call from reviewLoginRefusal — the
  // openai-codex review is refused although an OpenAI login exists.
  it.each([
    ["Sign in with ChatGPT", { openai: { type: "oauth", expires: 1 } }, {}],
    ["an OpenAI API key stored by /login", { openai: { type: "api_key", expires: null } }, {}],
    ["OPENAI_API_KEY", {}, { OPENAI_API_KEY: "sk-SECRET" }],
  ] as const)("an openai-codex review runs on any OpenAI login: %s", (_name, logins, env) => {
    expect(
      reviewLoginRefusal({ providers: ["openai-codex"], agentDir: AGENT, env, logins }),
    ).toBeNull();
  });

  it("and back: an openai review runs on the legacy Codex login", () => {
    expect(
      reviewLoginRefusal({
        providers: ["openai"],
        agentDir: AGENT,
        env: {},
        logins: { "openai-codex": { type: "oauth", expires: 1 } },
      }),
    ).toBeNull();
  });

  // MUTATION: let ANTHROPIC_API_KEY satisfy openai-codex — the run would need a
  // model switch, and the review never switches models across providers.
  it("only an API key for another provider: refused, naming qcr login, no model switch", () => {
    const why = reviewLoginRefusal({
      providers: ["openai-codex"],
      agentDir: AGENT,
      env: { ANTHROPIC_API_KEY: "sk-SECRET" },
      logins: {},
    });
    expect(why).not.toBeNull();
    expect(why).toMatch(/runs on openai-codex/);
    expect(why).toMatch(/`qcr login`/);
    expect(why).toMatch(/ANTHROPIC_API_KEY is set, and the review does not switch models/);
    expect(why).not.toContain("sk-SECRET");
    expect(why).toContain(AGENT);
  });

  it("nothing at all: refused, naming qcr login", () => {
    const why = reviewLoginRefusal({
      providers: ["openai-codex"],
      agentDir: AGENT,
      env: {},
      logins: {},
    });
    expect(why).toMatch(/`qcr login`/);
    expect(why).not.toMatch(/switch models/);
  });

  it("every provider is checked, in order", () => {
    const why = reviewLoginRefusal({
      providers: ["openai-codex", "anthropic"],
      agentDir: AGENT,
      env: {},
      logins: { "openai-codex": { type: "oauth", expires: null } },
    });
    expect(why).toMatch(/runs on anthropic/);
  });
});
