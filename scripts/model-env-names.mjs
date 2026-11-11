#!/usr/bin/env node
// The environment names pi reads a model credential from, as a block in the
// two scripts that start a review container from outside the image:
// scripts/qcr-host.sh (the host wrapper) and scripts/action.sh (the Action).
//
//   node scripts/model-env-names.mjs            print the names, one a line
//   node scripts/model-env-names.mjs --write    rewrite the block in both scripts
//   node scripts/model-env-names.mjs --check    exit 1 when a block is not this output
//
// Neither script can ask pi at run time (there is no Node on the host, and the
// Action runs before the image does), so the names are generated here from the
// installed pi and held equal to it by tests/model-env.test.ts. Run `--write`
// after a pi upgrade.
//
// Where the names come from: every built-in provider's own `auth.apiKey`
// (`check` when it has one, and `resolve`) is run under a recording auth
// context, and every name it asks the context for is collected. A provider
// stops asking at its first answer, so one run does not see every name: the
// walk starts with a context that answers nothing and then, for each name or
// file a run asked about, runs again with that one answered and the ones
// before it not, until no run asks anything new. There is no table of names
// here and no provider id.
//
// The context is the whole world the providers see: it answers from a map and
// never reads this process's environment or a file, so the generator reads no
// credential, and nothing in a provider's check or resolve reaches the network.
import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");

export const BEGIN_MARK = "# BEGIN pi model env names";
export const END_MARK = "# END pi model env names";
/** The shell variable the block assigns, read by both scripts. */
export const BLOCK_VARIABLE = "PI_MODEL_ENV_NAMES";
/** The scripts that carry the block, relative to the repo root. */
export const BLOCK_FILES = ["scripts/qcr-host.sh", "scripts/action.sh"];

/** What a context answers for a name it was told to answer. No real value. */
const ANSWER = "x";
/** A runaway guard: no provider asks this many distinct questions. */
const MAX_RUNS_PER_PROVIDER = 4096;
const NAME_RE = /^[A-Za-z_][A-Za-z0-9_]*$/;

/** A context that answers from `answers` alone and records what was asked.
 * A question's key is the env name, or `file:<path>` for a file. */
function recordingContext(answers, asked) {
  const note = (key) => {
    if (!asked.includes(key)) asked.push(key);
    return answers.get(key) === true;
  };
  return {
    async env(name) {
      return note(String(name)) ? ANSWER : undefined;
    },
    async fileExists(path) {
      return note(`file:${String(path)}`);
    },
  };
}

/** One run of a provider's api-key auth under `answers`: the questions it
 * asked, in order. A check or resolve that throws has still asked. */
async function ask(apiKey, answers) {
  const asked = [];
  const input = () => ({
    ctx: recordingContext(answers, asked),
    credential: undefined,
    signal: new AbortController().signal,
  });
  for (const fn of [apiKey.check, apiKey.resolve]) {
    if (typeof fn !== "function") continue;
    try {
      await fn.call(apiKey, input());
    } catch {
      // What it asked before it threw is recorded.
    }
  }
  return asked;
}

/** Every env name one provider's api-key auth can ask for. */
export async function providerEnvNames(apiKey) {
  const names = new Set();
  let runs = 0;
  const walk = async (answers) => {
    runs += 1;
    if (runs > MAX_RUNS_PER_PROVIDER) {
      throw new Error("a provider's auth asks too many questions to walk");
    }
    const asked = await ask(apiKey, answers);
    for (const key of asked) if (!key.startsWith("file:")) names.add(key);
    const fresh = asked.filter((key) => !answers.has(key));
    for (let i = 0; i < fresh.length; i += 1) {
      const next = new Map(answers);
      for (const before of fresh.slice(0, i)) next.set(before, false);
      next.set(fresh[i], true);
      await walk(next);
    }
  };
  await walk(new Map());
  return [...names];
}

/** The names over a list of providers (pi-ai's `Provider[]`), sorted. */
export async function envNamesOf(providers) {
  const names = new Set();
  for (const provider of providers) {
    const apiKey = provider?.auth?.apiKey;
    if (!apiKey) continue;
    for (const name of await providerEnvNames(apiKey)) {
      if (!NAME_RE.test(name)) {
        throw new Error(`a provider asked for an environment name a shell cannot hold: ${name}`);
      }
      names.add(name);
    }
  }
  return [...names].sort();
}

/** The names the installed pi asks for. */
export async function piModelEnvNames() {
  const { builtinProviders } = await import("@earendil-works/pi-ai/providers/all");
  return envNamesOf(builtinProviders());
}

/** The block, markers included, without a trailing newline. */
export function renderBlock(names) {
  return [
    BEGIN_MARK,
    "# Generated by scripts/model-env-names.mjs from the pinned pi: the names pi",
    "# reads a model credential from. Do not edit; run it with --write.",
    `${BLOCK_VARIABLE}='`,
    ...names,
    "'",
    END_MARK,
  ].join("\n");
}

/** The block a script carries, markers included, or null when it has none
 * (or more than one). */
export function blockOf(text) {
  const begin = text.indexOf(BEGIN_MARK);
  if (begin < 0 || text.indexOf(BEGIN_MARK, begin + 1) >= 0) return null;
  const end = text.indexOf(END_MARK, begin);
  if (end < 0 || text.indexOf(END_MARK, end + 1) >= 0) return null;
  return text.slice(begin, end + END_MARK.length);
}

/** The names a block assigns, in the block's order. */
export function namesInBlock(block) {
  return block
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => NAME_RE.test(line));
}

/** `text` with its block replaced. Throws when it has no single block. */
export function withBlock(text, block) {
  const old = blockOf(text);
  if (old === null) {
    throw new Error(`no single "${BEGIN_MARK}" … "${END_MARK}" block to rewrite`);
  }
  return text.replace(old, () => block);
}

async function main(argv) {
  const names = await piModelEnvNames();
  if (argv.length === 0) {
    process.stdout.write(`${names.join("\n")}\n`);
    return 0;
  }
  const mode = argv[0];
  if (argv.length !== 1 || (mode !== "--write" && mode !== "--check")) {
    process.stderr.write("usage: model-env-names.mjs [--write | --check]\n");
    return 2;
  }
  const block = renderBlock(names);
  let stale = 0;
  for (const rel of BLOCK_FILES) {
    const path = join(ROOT, rel);
    const text = readFileSync(path, "utf8");
    if (blockOf(text) === block) continue;
    if (mode === "--check") {
      process.stderr.write(`${rel}: the block is not pi's names (run with --write)\n`);
      stale += 1;
      continue;
    }
    writeFileSync(path, withBlock(text, block));
    process.stdout.write(`${rel}: ${names.length} names written\n`);
  }
  return stale > 0 ? 1 : 0;
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  process.exitCode = await main(process.argv.slice(2));
}
