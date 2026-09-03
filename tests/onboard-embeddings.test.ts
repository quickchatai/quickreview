// the embedder step (src/onboard/steps/embeddings.ts) and the two
// route-specific writers that carry its answer to the boot.
//
// What is pinned: (1) calling the step with nothing confirms the LOCAL default
// and writes nothing new; (2) the hosted opt-in writes config.toml, refuses to
// go green without ITS OWN key file — pi's openai_api_key is explicitly not
// it — and never accepts the value through the session; (3) the bring-up step
// mirrors config.toml's embedder into the project .env, the compose file's
// contract; (4) verify() re-reads reality and prompts nothing; (5) a config
// the loader would refuse is refused BEFORE it is written.
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { parseConfig } from "../src/config.js";
import { CHOICE_KEYS } from "../src/onboard/choices.js";
import type { OnboardAdapters, StepContext } from "../src/onboard/engine.js";
import {
  EMBEDDINGS_STEP_ID,
  declaredEmbedderOf,
  embedderEnvEntries,
  embedderHostVars,
  embeddingsStep,
  keyFileCheck,
} from "../src/onboard/steps/embeddings.js";
import { readEnvKey } from "../src/onboard/steps/ingress.js";
import { defaultSteps } from "../src/onboard/steps/index.js";

let root: string;
let secretsDir: string;
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "qcr-onboard-embed-"));
  secretsDir = join(root, "secrets");
  mkdirSync(join(root, "state"), { recursive: true });
  mkdirSync(secretsDir, { recursive: true });
  // The interview's output: the example config with the secrets dir pointed
  // at our temp dir — the shipped [openviking] block says local.
  const example = readFileSync(join(import.meta.dirname, "..", "config.example.toml"), "utf8");
  writeFileSync(
    join(root, "config.toml"),
    example.replace(/^secrets_dir = .*$/m, `secrets_dir = "${secretsDir}"`),
  );
});
afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

function adapters(): OnboardAdapters {
  return {
    fetch: (() => {
      throw new Error("no network in tests");
    }) as unknown as typeof fetch,
    runner: { run: async () => ({ code: 127, stdout: "", stderr: "no subprocesses in tests" }) },
    clock: () => new Date("2026-09-02T12:00:00Z"),
    host: { nodeVersion: "v22.5.1", uid: 1000 },
    paths: { stateDir: join(root, "state") },
  };
}

function ctx(
  input: Record<string, unknown> = {},
  choices: Record<string, unknown> = {},
): StepContext {
  return {
    adapters: adapters(),
    input,
    choices: { [CHOICE_KEYS.secretsDir]: secretsDir, ...choices },
    data: {},
    recordChoice: () => {},
  };
}

const config = () => readFileSync(join(root, "config.toml"), "utf8");
const detailOf = (checks: { name: string; detail: string }[], name: string) =>
  checks.find((c) => c.name === name)?.detail ?? "";

describe("registration", () => {
  it("is registered at order 38, on both routes, after the interview that writes the config it edits", () => {
    const steps = defaultSteps();
    const step = steps.find((s) => s.id === EMBEDDINGS_STEP_ID)!;
    expect(step.order).toBe(38);
    expect(step.enabled).toBeUndefined();
    expect(steps.find((s) => s.id === "config_fill")!.order).toBeLessThan(step.order);
    expect(step.explain).toMatch(/LOCAL/);
    expect(step.explain).toMatch(/nothing but the model call/);
  });
});

describe("the local default", () => {
  it("called with nothing: confirms local, writes nothing, needs no key — even with pi's key in the secrets dir", async () => {
    writeFileSync(join(secretsDir, "openai_api_key"), "sk-pi-only");
    const before = config();
    const r = await embeddingsStep().run(ctx());
    expect(r.ok).toBe(true);
    expect(config()).toBe(before);
    expect(detailOf(r.checks, "embedder")).toMatch(
      /^local\/bge-small-zh-v1\.5-f16 \(512 dims\) — memory embeds LOCALLY/,
    );
    expect(detailOf(r.checks, "embedder")).toMatch(/nothing but the model call/);
    expect(detailOf(r.checks, "config.toml")).toMatch(/already said this/);
    expect(r.checks.find((c) => c.name === "embeddings-key")).toBeUndefined();
    expect(r.data).toMatchObject({
      provider: "local",
      model: "bge-small-zh-v1.5-f16",
      dimension: 512,
    });
    expect(detailOf(r.checks, "propagation")).toMatch(
      /bring-up step \(70\) writes these into the project \.env/,
    );
  });

  it("verify: green on the shipped config, and it never writes", async () => {
    const before = config();
    const r = await embeddingsStep().verify(ctx());
    expect(r.ok).toBe(true);
    expect(config()).toBe(before);
  });

  it("no config.toml yet ⇒ red, pointing at the interview", async () => {
    rmSync(join(root, "config.toml"));
    const r = await embeddingsStep().run(ctx({ provider: "local" }));
    expect(r.ok).toBe(false);
    expect(detailOf(r.checks, "config.toml")).toMatch(/config_fill/);
  });
});

describe("the hosted opt-in", () => {
  it("writes config.toml (openai / text-embedding-3-small / 1536) and is RED until its own key file exists — pi's key does not count", async () => {
    writeFileSync(join(secretsDir, "openai_api_key"), "sk-pi-model-credential");
    const r = await embeddingsStep().run(ctx({ provider: "openai" }));
    expect(r.ok).toBe(false);
    const ov = parseConfig(config()).openviking;
    expect(ov).toMatchObject({
      embedding_provider: "openai",
      embedding_model: "text-embedding-3-small",
      embedding_dimension: 1536,
      embedding_key_file: "openai_embeddings_api_key",
    });
    expect(detailOf(r.checks, "embedder")).toMatch(/EVERY memory entry's text.*is sent there/);
    const key = detailOf(r.checks, "embeddings-key");
    expect(key).toMatch(/no openai_embeddings_api_key in/);
    expect(key).toMatch(
      /pi's openai_api_key is there, but it is pi's model credential and is deliberately NOT used/,
    );
    expect(key).toMatch(/collect-secrets\.sh/);
    expect(key).toMatch(/never through this session/);
    expect(key).toMatch(/never switched silently/);
    // The key value is nowhere in the report.
    expect(JSON.stringify(r)).not.toContain("sk-pi-model-credential");

    // The key lands (by the shell wizard); a re-run and verify both go green.
    writeFileSync(join(secretsDir, "openai_embeddings_api_key"), "sk-embeddings-credential\n");
    const again = await embeddingsStep().run(ctx({ provider: "openai" }));
    expect(again.ok).toBe(true);
    expect(detailOf(again.checks, "config.toml")).toMatch(/already said this/);
    expect(JSON.stringify(again)).not.toContain("sk-embeddings-credential");
    expect((await embeddingsStep().verify(ctx())).ok).toBe(true);
  });

  it("a custom hosted model and dimension are written as given; a bad dimension or provider is refused before any write", async () => {
    const before = config();
    expect((await embeddingsStep().run(ctx({ provider: "openai", dimension: "big" }))).ok).toBe(
      false,
    );
    expect((await embeddingsStep().run(ctx({ provider: "cohere" }))).ok).toBe(false);
    expect(config()).toBe(before);
    writeFileSync(join(secretsDir, "openai_embeddings_api_key"), "sk-x");
    const r = await embeddingsStep().run(
      ctx({ provider: "openai", model: "text-embedding-3-large", dimension: "3072" }),
    );
    expect(r.ok).toBe(true);
    expect(parseConfig(config()).openviking).toMatchObject({
      embedding_model: "text-embedding-3-large",
      embedding_dimension: 3072,
    });
  });

  it("switching back to local rewrites model and dimension to the one local spec", async () => {
    writeFileSync(join(secretsDir, "openai_embeddings_api_key"), "sk-x");
    await embeddingsStep().run(ctx({ provider: "openai" }));
    const r = await embeddingsStep().run(ctx({ provider: "local" }));
    expect(r.ok).toBe(true);
    expect(parseConfig(config()).openviking).toMatchObject({
      embedding_provider: "local",
      embedding_model: "bge-small-zh-v1.5-f16",
      embedding_dimension: 512,
    });
    expect(detailOf(r.checks, "existing-store")).toMatch(/moves the old vectors aside/);
    expect(detailOf(r.checks, "existing-store")).toMatch(/qcr memory reembed/);
  });

  it("on the server route the propagation note names the inventory host vars and the deploy refusal", async () => {
    writeFileSync(join(secretsDir, "openai_embeddings_api_key"), "sk-x");
    const r = await embeddingsStep().run(
      ctx({ provider: "openai" }, { [CHOICE_KEYS.topology]: "vm" }),
    );
    expect(detailOf(r.checks, "propagation")).toMatch(
      /inventory step \(68\) writes these as HOST VARS/,
    );
    expect(detailOf(r.checks, "propagation")).toMatch(/deploy\.sh refuses/);
  });

  it("verify goes red when the key file disappears after the opt-in", async () => {
    writeFileSync(join(secretsDir, "openai_embeddings_api_key"), "sk-x");
    await embeddingsStep().run(ctx({ provider: "openai" }));
    rmSync(join(secretsDir, "openai_embeddings_api_key"));
    const r = await embeddingsStep().verify(ctx());
    expect(r.ok).toBe(false);
    expect(detailOf(r.checks, "embeddings-key")).toMatch(/no openai_embeddings_api_key/);
  });
});

describe("the writers that carry the answer to the boot", () => {
  it("declaredEmbedderOf reads the block and fills the loader's defaults for a config without one", () => {
    expect(declaredEmbedderOf("")).toEqual({
      provider: "local",
      model: "bge-small-zh-v1.5-f16",
      dimension: 512,
      keyFile: "openai_embeddings_api_key",
    });
    expect(
      declaredEmbedderOf(
        '[openviking]\nembedding_provider = "openai"\nembedding_model = "m"\nembedding_dimension = 42\n',
      ),
    ).toEqual({
      provider: "openai",
      model: "m",
      dimension: 42,
      keyFile: "openai_embeddings_api_key",
    });
  });

  it("the .env entries are the four keys docker-compose.yml passes through, and host vars exist only for an opt-in", () => {
    const compose = readFileSync(join(import.meta.dirname, "..", "docker-compose.yml"), "utf8");
    const local = declaredEmbedderOf("");
    for (const [key] of embedderEnvEntries(local))
      expect(compose, `${key} is not passed through by docker-compose.yml`).toContain(
        `${key}: \${${key}:-`,
      );
    expect(embedderHostVars(local)).toEqual([]);
    expect(embedderHostVars({ ...local, provider: "openai" }).map(([k]) => k)).toEqual([
      "openviking_embedding_provider",
      "openviking_embedding_model",
      "openviking_embedding_dimension",
      "openviking_embedding_key_file",
    ]);
  });

  it("the bring-up step mirrors config.toml's embedder into .env on every bring-up", async () => {
    const { bringUpStep } = await import("../src/onboard/steps/bringup.js");
    const { UID_CHOICE_KEY } = await import("../src/onboard/steps/preflight.js");
    writeFileSync(join(root, "docker-compose.yml"), "services: {}\n");
    const stream = { run: async () => ({ code: 0, stdout: "", stderr: "" }) };
    const psRunner = {
      run: async () => ({
        code: 0,
        stdout: JSON.stringify({ Service: "daemon", State: "running" }),
        stderr: "",
      }),
    };
    const a = { ...adapters(), runner: psRunner };
    const c: StepContext = {
      adapters: a,
      input: {},
      choices: { [UID_CHOICE_KEY]: 1000 },
      data: {},
      recordChoice: () => {},
    };
    await bringUpStep({ stream }).run(c);
    const env = readFileSync(join(root, ".env"), "utf8");
    expect(readEnvKey(env, "QCR_OPENVIKING_EMBEDDING_PROVIDER")).toBe("local");
    expect(readEnvKey(env, "QCR_OPENVIKING_EMBEDDING_MODEL")).toBe("bge-small-zh-v1.5-f16");
    expect(readEnvKey(env, "QCR_OPENVIKING_EMBEDDING_DIMENSION")).toBe("512");
    expect(readEnvKey(env, "QCR_OPENVIKING_EMBEDDING_KEY_FILE")).toBe("openai_embeddings_api_key");
    // The opt-in flows through the same path on the next bring-up.
    writeFileSync(join(secretsDir, "openai_embeddings_api_key"), "sk-x");
    await embeddingsStep().run(ctx({ provider: "openai" }));
    await bringUpStep({ stream }).run(c);
    expect(
      readEnvKey(readFileSync(join(root, ".env"), "utf8"), "QCR_OPENVIKING_EMBEDDING_PROVIDER"),
    ).toBe("openai");
    expect(
      readEnvKey(readFileSync(join(root, ".env"), "utf8"), "QCR_OPENVIKING_EMBEDDING_DIMENSION"),
    ).toBe("1536");
  });
});

describe("keyFileCheck", () => {
  it("green only on a file that looks like an OpenAI key; a junk file is named as such", () => {
    expect(keyFileCheck(secretsDir, "openai_embeddings_api_key").ok).toBe(false);
    writeFileSync(join(secretsDir, "openai_embeddings_api_key"), "not a key");
    const junk = keyFileCheck(secretsDir, "openai_embeddings_api_key");
    expect(junk.ok).toBe(false);
    expect(junk.detail).toMatch(/does not look like an OpenAI key/);
    writeFileSync(join(secretsDir, "openai_embeddings_api_key"), "sk-real\n");
    expect(keyFileCheck(secretsDir, "openai_embeddings_api_key").ok).toBe(true);
    expect(existsSync(join(secretsDir, "openai_api_key"))).toBe(false);
  });
});
