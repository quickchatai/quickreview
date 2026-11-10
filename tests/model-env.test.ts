// The model environment of a secrets dir (src/modelenv.ts): one file per
// variable under `model-env/`, the older `openai_api_key` file read as
// OPENAI_API_KEY, the name rule, and the promise that no value is ever put
// in a message. Every dir here is a temp dir; no value is a real key.
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  LEGACY_MODEL_KEY_ENV,
  LEGACY_MODEL_KEY_FILE,
  MODEL_ENV_DIR,
  MODEL_ENV_REFUSED_PREFIXES,
  modelEnvFrom,
  modelEnvNameProblem,
} from "../src/modelenv.js";

let secrets: string;

beforeEach(() => {
  secrets = mkdtempSync(join(tmpdir(), "model-env-"));
});

afterEach(() => {
  rmSync(secrets, { recursive: true, force: true });
});

/** Write `model-env/<name>` with `value`. */
function variable(name: string, value: string): string {
  mkdirSync(join(secrets, MODEL_ENV_DIR), { recursive: true });
  const file = join(secrets, MODEL_ENV_DIR, name);
  writeFileSync(file, value);
  return file;
}

/** The loader's answer and everything it said. */
function load(): { env: Record<string, string>; said: string[] } {
  const said: string[] = [];
  return { env: modelEnvFrom(secrets, { warn: (l) => said.push(l) }), said };
}

describe("modelEnvFrom: the secrets dir's model environment", () => {
  it("a file's name is the variable and its content the value, for any provider", () => {
    variable("ANTHROPIC_API_KEY", "value-a\n");
    variable("AWS_REGION", "  eu-north-1  \n");
    variable("AZURE_OPENAI_RESOURCE_NAME", "my-resource");
    const { env, said } = load();
    expect(env).toEqual({
      ANTHROPIC_API_KEY: "value-a",
      AWS_REGION: "eu-north-1",
      AZURE_OPENAI_RESOURCE_NAME: "my-resource",
    });
    expect(said).toEqual([]);
  });

  it("a secrets dir with neither, or none at all, is an empty map and says nothing", () => {
    expect(load()).toEqual({ env: {}, said: [] });
    rmSync(secrets, { recursive: true, force: true });
    expect(load()).toEqual({ env: {}, said: [] });
  });

  // MUTATION: drop the legacy read from modelEnvFrom — an install whose only
  // model credential is the older key file has none, and this fails.
  it("the older key file is read as OPENAI_API_KEY for as long as it exists", () => {
    writeFileSync(join(secrets, LEGACY_MODEL_KEY_FILE), "legacy-value\n");
    expect(LEGACY_MODEL_KEY_FILE).toBe("openai_api_key");
    expect(load()).toEqual({ env: { [LEGACY_MODEL_KEY_ENV]: "legacy-value" }, said: [] });
    // Beside other variables it is one more of them.
    variable("GEMINI_API_KEY", "value-g");
    expect(load().env).toEqual({ OPENAI_API_KEY: "legacy-value", GEMINI_API_KEY: "value-g" });
  });

  it("the newer spelling of the same variable wins over the older file", () => {
    writeFileSync(join(secrets, LEGACY_MODEL_KEY_FILE), "legacy-value");
    variable(LEGACY_MODEL_KEY_ENV, "newer-value");
    expect(load().env).toEqual({ OPENAI_API_KEY: "newer-value" });
  });

  it("leaves out an empty file, a directory and a file too large to be a key, and says which", () => {
    variable("EMPTY_API_KEY", " \n");
    mkdirSync(join(secrets, MODEL_ENV_DIR, "NESTED_API_KEY"));
    variable("HUGE_API_KEY", "x".repeat(64 * 1024 + 1));
    variable("GOOD_API_KEY", "value-ok");
    const { env, said } = load();
    expect(env).toEqual({ GOOD_API_KEY: "value-ok" });
    expect(said).toHaveLength(3);
    expect(said.join("\n")).toMatch(/EMPTY_API_KEY was left out: it is empty/);
    expect(said.join("\n")).toMatch(/NESTED_API_KEY was left out: it is not a file/);
    expect(said.join("\n")).toMatch(/HUGE_API_KEY was left out: it is too large/);
  });

  it("skips a dotfile without a word", () => {
    variable(".gitkeep", "");
    variable(".XAI_API_KEY.swp", "leftover");
    expect(load()).toEqual({ env: {}, said: [] });
  });

  it.skipIf(process.getuid?.() === 0)("a file it cannot read is left out by name", () => {
    const file = variable("LOCKED_API_KEY", "value-locked");
    chmodSync(file, 0o000);
    try {
      const { env, said } = load();
      expect(env).toEqual({});
      expect(said).toEqual([`model env: ${file} was left out: it cannot be read (EACCES)`]);
    } finally {
      chmodSync(file, 0o600);
    }
  });
});

describe("the name rule", () => {
  it("a name is capital letters, digits and underscores, starting with a letter", () => {
    for (const ok of [
      "OPENAI_API_KEY",
      "HF_TOKEN",
      "AWS_PROFILE",
      "X",
      "A1_B2",
      "COPILOT_GITHUB_TOKEN",
    ])
      expect(modelEnvNameProblem(ok), ok).toBeNull();
    for (const bad of [
      "openai_api_key",
      "Api_Key",
      "1KEY",
      "_KEY",
      "MY-KEY",
      "MY KEY",
      "KEY.txt",
      "",
    ])
      expect(modelEnvNameProblem(bad), bad).toMatch(/not an environment variable's name/);
  });

  // Each prefix is a family this system or its tools read for themselves: a
  // file under one would hand a session a GitHub token, or repoint a home, pi,
  // the memory engine or git.
  // MUTATION: delete "GIT_" from MODEL_ENV_REFUSED_PREFIXES — this fails.
  it("refuses the names this system and its tools read for themselves", () => {
    expect([...MODEL_ENV_REFUSED_PREFIXES].sort()).toEqual(
      ["GH_", "GITHUB_", "GIT_", "OPENVIKING_", "PI_", "QCR_"].sort(),
    );
    for (const name of [
      "GH_TOKEN",
      "GITHUB_TOKEN",
      "QCR_CONFIG",
      "PI_CODING_AGENT_DIR",
      "OPENVIKING_API_KEY",
      "GIT_CONFIG_GLOBAL",
      "GIT_SSH_COMMAND",
    ]) {
      expect(modelEnvNameProblem(name), name).toMatch(/are not model variables/);
      variable(name, "value-refused");
    }
    variable("MISTRAL_API_KEY", "value-m");
    const { env, said } = load();
    expect(env).toEqual({ MISTRAL_API_KEY: "value-m" });
    expect(said).toHaveLength(7);
    // A prefix is refused, a name that merely contains one is not.
    expect(modelEnvNameProblem("GITLAB_TOKEN")).toBeNull();
    expect(modelEnvNameProblem("OPENAI_GH_KEY")).toBeNull();
  });

  it("a name that is not a variable's is left out and said, not exported under another name", () => {
    variable("readme.txt", "notes");
    variable("lower_case_key", "value-l");
    const { env, said } = load();
    expect(env).toEqual({});
    expect(said).toHaveLength(2);
  });
});

describe("no value is ever said", () => {
  // MUTATION: put the file's content into a `warn` line of modelEnvFrom — this fails.
  it("a message names the file and the reason, never what the file holds", () => {
    const SECRET = "the-secret-value-0123456789";
    variable("GH_TOKEN", SECRET);
    variable("bad name", SECRET);
    variable("HUGE_API_KEY", SECRET.repeat(4000));
    variable("FINE_API_KEY", SECRET);
    writeFileSync(join(secrets, LEGACY_MODEL_KEY_FILE), SECRET);
    const { env, said } = load();
    expect(Object.keys(env).sort()).toEqual(["FINE_API_KEY", "OPENAI_API_KEY"]);
    expect(said.length).toBeGreaterThan(0);
    expect(said.join("\n")).not.toContain(SECRET);
    expect(said.join("\n")).not.toContain(SECRET.slice(0, 12));
  });

  it("the module writes to no log of its own", () => {
    const source = readFileSync(join(import.meta.dirname, "..", "src", "modelenv.ts"), "utf8");
    expect(source).not.toMatch(/console\.|process\.std(out|err)/);
    // A leaf: the daemon reads it without reaching anything else.
    const imports = [...source.matchAll(/from "([^"]+)"/g)].map((m) => m[1]);
    expect(imports.sort()).toEqual(["node:fs", "node:path"]);
  });
});
