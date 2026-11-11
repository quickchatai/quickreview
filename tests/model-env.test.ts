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
  oneShotModelEnv,
  oneShotSecretsDir,
} from "../src/modelenv.js";
import {
  BEGIN_MARK,
  BLOCK_FILES,
  BLOCK_VARIABLE,
  END_MARK,
  blockOf,
  envNamesOf,
  namesInBlock,
  piModelEnvNames,
  providerEnvNames,
  renderBlock,
  withBlock,
} from "../scripts/model-env-names.mjs";

/** The names the installed pi reads a model credential from, by the
 * generator. Asked once, here, so no test's clock pays for pi's catalog. */
const PI_NAMES: string[] = await piModelEnvNames();

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

// `qcr model`, `qcr review` and `qcr scan` read one model env: the secrets
// dir their config located, by the one loader.
describe("the one-shot verbs' model env", () => {
  it("is the loader's answer for the directory the config located", () => {
    variable("PROV_API_KEY", "value-a");
    expect(oneShotModelEnv(secrets, "/app")).toEqual(modelEnvFrom(secrets));
    expect(oneShotModelEnv(secrets, "/app")).toEqual({ PROV_API_KEY: "value-a" });
  });

  it("no directory is no model env, never the working directory's", () => {
    for (const none of [null, undefined, "", "   "]) {
      expect(oneShotSecretsDir(none, "/app")).toBeNull();
      expect(oneShotModelEnv(none, "/app")).toEqual({});
    }
  });

  // MUTATION: return a relative directory as it is from oneShotSecretsDir —
  // the verb reads under wherever it was typed and this fails.
  it("a relative directory is under the app's root, as the setup wizard's steps resolve it", () => {
    expect(oneShotSecretsDir("keys", "/app")).toBe("/app/keys");
    expect(oneShotSecretsDir("/srv/keys", "/app")).toBe("/srv/keys");
    variable("PROV_API_KEY", "value-a");
    const parent = join(secrets, "..");
    const name = secrets.slice(parent.length + 1);
    expect(oneShotModelEnv(name, parent)).toEqual({ PROV_API_KEY: "value-a" });
  });

  it("says what it left out through the caller's warn, by name", () => {
    variable("GH_TOKEN", "the-secret-value");
    const said: string[] = [];
    expect(oneShotModelEnv(secrets, "/app", { warn: (l) => said.push(l) })).toEqual({});
    expect(said).toHaveLength(1);
    expect(said[0]).toContain("GH_TOKEN");
    expect(said[0]).not.toContain("the-secret-value");
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

// ---------------------------------------------------------------------------
// The names the host wrapper and the Action forward (scripts/model-env-names.mjs)
// ---------------------------------------------------------------------------

const repoRoot = join(import.meta.dirname, "..");
const script = (rel: string): string => readFileSync(join(repoRoot, rel), "utf8");

/** One provider's api-key auth, as pi-ai shapes it, over a made-up rule. */
function auth(
  resolve: (ctx: {
    env: (name: string) => Promise<string | undefined>;
    fileExists: (path: string) => Promise<boolean>;
  }) => Promise<unknown>,
): { name: string; resolve: (input: { ctx: Parameters<typeof resolve>[0] }) => Promise<unknown> } {
  return { name: "made-up key", resolve: ({ ctx }) => resolve(ctx) };
}

describe("the env-name blocks are pi's (fence 10)", () => {
  // The wrapper and the Action cannot ask pi at run time, so each carries the
  // generator's output for the pinned pi, and this holds the two equal to it.
  // MUTATION: delete XAI_API_KEY from the block in scripts/qcr-host.sh - this fails.
  it("both scripts carry exactly the generator's block for the installed pi", () => {
    expect(BLOCK_FILES).toEqual(["scripts/qcr-host.sh", "scripts/action.sh"]);
    const want = renderBlock(PI_NAMES);
    for (const rel of BLOCK_FILES) {
      const block = blockOf(script(rel));
      expect(block, `${rel}: run \`node scripts/model-env-names.mjs --write\``).toBe(want);
      expect(namesInBlock(block!), rel).toEqual(PI_NAMES);
    }
  });

  it("the names are many, sorted, distinct, and each one a shell can hold", () => {
    expect(PI_NAMES.length).toBeGreaterThan(20);
    expect([...PI_NAMES].sort()).toEqual(PI_NAMES);
    expect(new Set(PI_NAMES).size).toBe(PI_NAMES.length);
    for (const name of PI_NAMES) expect(name).toMatch(/^[A-Z][A-Z0-9_]*$/);
    // None is one of this program's own: the model-env rule refuses these
    // prefixes, and the wrapper must never forward one as a model's.
    for (const name of PI_NAMES) expect(modelEnvNameProblem(name), name).toBeNull();
  });

  // A provider stops asking at its first answer, so one run sees only the
  // names before it. The walk answers each question in turn.
  // MUTATION: collect from two runs only (one answering nothing, one
  // answering everything) in providerEnvNames - SECOND_HALF and LAST are
  // never asked for and this fails.
  it("finds the names behind an answer: a pair asked one after the other, a fallback after a miss", async () => {
    const pair = auth(async (ctx) => {
      if (await ctx.env("BEARER")) return { auth: {} };
      // Asked only once the first half was found, and only when BEARER was not.
      if ((await ctx.env("FIRST_HALF")) && (await ctx.env("SECOND_HALF"))) return { auth: {} };
      if (!(await ctx.fileExists("/some/file"))) return undefined;
      return (await ctx.env("LAST")) ? { auth: {} } : undefined;
    });
    expect((await providerEnvNames(pair)).sort()).toEqual([
      "BEARER",
      "FIRST_HALF",
      "LAST",
      "SECOND_HALF",
    ]);
  });

  it("a file question is walked and never listed; a resolve that throws has still asked", async () => {
    const names = await envNamesOf([
      {
        auth: {
          apiKey: auth(async (ctx) => {
            await ctx.fileExists("~/.made-up/credentials.json");
            await ctx.env("B_NAME");
            throw new Error("no such thing");
          }),
        },
      },
      { auth: { apiKey: auth(async (ctx) => ctx.env("A_NAME")) } },
      // A provider with no api-key auth (a login only) asks for nothing.
      { auth: {} },
    ]);
    expect(names).toEqual(["A_NAME", "B_NAME"]);
  });

  it("refuses a name a shell could not hold, instead of writing it into a script", async () => {
    await expect(
      envNamesOf([{ auth: { apiKey: auth(async (ctx) => ctx.env("BAD NAME; rm")) } }]),
    ).rejects.toThrow(/cannot hold/);
  });

  // The generator's whole world is its recording context.
  // MUTATION: answer `process.env[name]` from the recording context's env() -
  // the made-up provider sees this test's variable and this fails.
  it("reads no environment of its own and no file: a provider sees only what the walk answers", async () => {
    const seen: Array<string | undefined> = [];
    process.env["MODEL_ENV_FENCE_PROBE"] = "from-the-process";
    try {
      await providerEnvNames(
        auth(async (ctx) => {
          seen.push(await ctx.env("MODEL_ENV_FENCE_PROBE"));
          return undefined;
        }),
      );
    } finally {
      delete process.env["MODEL_ENV_FENCE_PROBE"];
    }
    expect(seen.length).toBeGreaterThan(0);
    expect(seen).not.toContain("from-the-process");
    const source = script("scripts/model-env-names.mjs");
    expect(source).not.toMatch(/process\.env|\bfetch\(|existsSync|accessSync|homedir/);
  });

  it("the block is found and replaced whole, and a script with none or two is refused", () => {
    const block = renderBlock(["A_KEY", "B_KEY"]);
    expect(block.split("\n")[0]).toBe(BEGIN_MARK);
    expect(block.split("\n").at(-1)).toBe(END_MARK);
    expect(block).toContain(`${BLOCK_VARIABLE}='\nA_KEY\nB_KEY\n'`);
    const text = `#!/bin/sh\nbefore\n${block}\nafter\n`;
    expect(blockOf(text)).toBe(block);
    expect(namesInBlock(block)).toEqual(["A_KEY", "B_KEY"]);
    const next = renderBlock(["C_KEY"]);
    expect(withBlock(text, next)).toBe(`#!/bin/sh\nbefore\n${next}\nafter\n`);
    expect(blockOf("no block here\n")).toBeNull();
    expect(blockOf(`${block}\n${block}\n`)).toBeNull();
    expect(() => withBlock("no block here\n", next)).toThrow(/no single/);
  });

  // The block is the only list: neither script keeps a table of provider
  // names beside it, and both forward the same extras.
  // MUTATION: put `for key in OPENAI_API_KEY ANTHROPIC_API_KEY` back into
  // scripts/action.sh's forward loop - this fails.
  it("both scripts forward the block's names, QCR_MODEL_ENV's, and the two older names, and keep no list of their own", () => {
    for (const rel of BLOCK_FILES) {
      const text = script(rel);
      const outside = text.replace(blockOf(text)!, "");
      const loop = outside
        .split("\n")
        .filter((line) => /^\s*for (name|key) in \$PI_MODEL_ENV_NAMES\b/.test(line));
      expect(loop, rel).toHaveLength(1);
      expect(loop[0], rel).toMatch(/\bDIGITALOCEAN_API_KEY\b/);
      expect(loop[0], rel).toMatch(/\bQCR_DEBUG\b/);
      expect(outside, rel).toMatch(/QCR_MODEL_ENV/);
      // No name of the block is spelled anywhere else in the script's code.
      const code = outside
        .split("\n")
        .filter((line) => !/^\s*#/.test(line))
        .join("\n");
      for (const name of PI_NAMES)
        expect(new RegExp(`\\b${name}\\b`).test(code), `${rel} spells ${name}`).toBe(false);
    }
  });

  // What QCR_MODEL_ENV may not name is what the secrets dir's model-env may
  // not: one rule, spelled in sh in two scripts.
  // MUTATION: drop `GIT_*` from the refused prefixes in scripts/qcr-host.sh -
  // this fails.
  it("both scripts refuse, for QCR_MODEL_ENV, exactly the prefixes the model-env loader refuses", () => {
    const want = MODEL_ENV_REFUSED_PREFIXES.map((p) => `${p}*`).join(" | ");
    for (const rel of BLOCK_FILES) {
      const refusals = script(rel)
        .split("\n")
        .filter((line) => /is not a model setting and is never forwarded/.test(line));
      expect(refusals, rel).toHaveLength(1);
      expect(refusals[0]!.trim().startsWith(`${want})`), rel).toBe(true);
    }
  });
});
