// The embedder step — where memory's vectors are computed, and the only
// place a new operator is asked about it.
//
// Why it is a step: the shipped default is the local embedder — a small
// English model served on loopback inside the daemon container — so nothing
// but the model call leaves the machine, memory text included. That default
// needs no answer and no key, which is exactly why the step exists: an
// operator who WANTS hosted embeddings must say so, in one place, and the
// whole installation then moves together — config.toml, the credential file, and (through the bring-up or
// inventory step) the environment the boot actually renders. Half of that is
// the failure this step makes impossible: a config that says "openai" over a
// boot that renders "local" is a vector-store reset on the next start.
//
// The credential is its own file: `openai_api_key` is pi's model credential
// and is never read for embeddings; the hosted opt-in reads
// `<secrets>/<embedding_key_file>` (default `openai_embeddings_api_key`).
// Either can be set without the other. The wizard never accepts the value
// through the pi session (it would land in a transcript) — it points at
// `deploy/collect-secrets.sh`, which reads it hidden and writes it 0600.
//
// Deterministic by construction: config and secrets are plain files under
// paths derived from the injected state dir; verify() neither prompts nor
// writes.
import { existsSync } from "node:fs";
import { join } from "node:path";
import { parse as parseToml } from "smol-toml";
import {
  EMBEDDING_PROVIDERS,
  HOSTED_EMBEDDING,
  LOCAL_EMBEDDING,
  OPENVIKING_DEFAULTS,
  parseConfig,
  parseOpenViking,
  type EmbeddingProvider,
  type OpenVikingConfig,
} from "../../config.js";
import type { CheckResult, OnboardingStep, StepContext, StepReport } from "../engine.js";
import { interviewConfigPath, readTextOrNull, secretsDirFor, writeAtomic } from "./compose.js";
import { assertNoDryRunEdit, patchToml, tomlString, type TomlEdit } from "./configfill.js";
import { readTomlKey } from "./ingress.js";
import { topologyOf } from "./topology.js";

export const EMBEDDINGS_STEP_ID = "embeddings";

/** The embedder config.toml declares — what the bring-up step writes into the
 * project `.env` and the inventory step writes as host vars. */
export interface DeclaredEmbedder {
  provider: string;
  model: string;
  dimension: number;
  keyFile: string;
}

/** The loader's own reading of a config text's `[openviking]` block —
 * defaults filled, `1_536` read as 1536, a hosted opt-in that omits its
 * model/dimension given the HOSTED defaults — or null when the text does not
 * parse or the loader refuses the block. */
function loaderOpenViking(configText: string): OpenVikingConfig | null {
  try {
    const doc = parseToml(configText) as Record<string, unknown>;
    const block = doc.openviking;
    return parseOpenViking(
      typeof block === "object" && block !== null && !Array.isArray(block)
        ? (block as Record<string, unknown>)
        : {},
    );
  } catch {
    return null;
  }
}

/** The embedder an `[openviking]` block declares. */
export function embedderOf(ov: OpenVikingConfig): DeclaredEmbedder {
  return {
    provider: ov.embedding_provider,
    model: ov.embedding_model,
    dimension: ov.embedding_dimension,
    keyFile: ov.embedding_key_file,
  };
}

/**
 * Read `[openviking] embedding_*` out of a config.toml text, defaults filled
 * exactly as the loader fills them — so a config that omits the block (an
 * older one, or a hand-trimmed one) is read as the shipped local default and
 * not as "unknown".
 */
export function declaredEmbedderOf(configText: string): DeclaredEmbedder {
  // The loader's own reading first, which is exactly what the daemon will
  // run. Only a text that does not parse (or a block the loader refuses)
  // falls back to the tolerant line reader below.
  const ov = loaderOpenViking(configText);
  if (ov !== null) return embedderOf(ov);
  const get = (key: string): string | null =>
    readTomlKey(configText, "openviking", key)?.trim() ?? null;
  const dimensionRaw = get("embedding_dimension");
  return {
    provider: get("embedding_provider") ?? OPENVIKING_DEFAULTS.embedding_provider,
    model: get("embedding_model") ?? OPENVIKING_DEFAULTS.embedding_model,
    dimension:
      dimensionRaw !== null && /^[0-9]+$/.test(dimensionRaw)
        ? Number(dimensionRaw)
        : OPENVIKING_DEFAULTS.embedding_dimension,
    keyFile: get("embedding_key_file") ?? OPENVIKING_DEFAULTS.embedding_key_file,
  };
}

/** The four `.env` keys docker-compose.yml passes into the daemon container. */
export function embedderEnvEntries(e: DeclaredEmbedder): Array<[string, string]> {
  return [
    ["QCR_OPENVIKING_EMBEDDING_PROVIDER", e.provider],
    ["QCR_OPENVIKING_EMBEDDING_MODEL", e.model],
    ["QCR_OPENVIKING_EMBEDDING_DIMENSION", String(e.dimension)],
    ["QCR_OPENVIKING_EMBEDDING_KEY_FILE", e.keyFile],
  ];
}

/**
 * The local embedder's two runtime knobs as `.env` keys:
 * docker-compose.yml passes them to the entrypoint, which renders ov.conf's
 * `api_base` and runs the provisioning embedder on that port — while the
 * daemon reads the same two from config.toml. Mirrored on every bring-up so
 * they cannot disagree: a port the two disagree on is a search nothing serves.
 * The loader's own reading of the block; a config it cannot read gives the
 * shipped defaults, exactly as the daemon would refuse to start on it.
 */
export function localEmbedderEnvEntries(configText: string): Array<[string, string]> {
  const { port, threads } = localEmbedderRuntimeOf(configText);
  return [
    ["QCR_OPENVIKING_LOCAL_EMBEDDER_PORT", String(port)],
    ["QCR_OPENVIKING_LOCAL_EMBEDDER_THREADS", String(threads)],
  ];
}

/** The local embedder's two runtime knobs. */
export interface LocalEmbedderRuntime {
  port: number;
  threads: number;
}

/** The loader's own reading of the local embedder's port and threads; a
 * config it cannot read gives the shipped defaults, exactly as the daemon
 * would refuse to start on it. */
export function localEmbedderRuntimeOf(configText: string): LocalEmbedderRuntime {
  const ov = loaderOpenViking(configText);
  return {
    port: ov?.local_embedder_port ?? OPENVIKING_DEFAULTS.local_embedder_port,
    threads: ov?.local_embedder_threads ?? OPENVIKING_DEFAULTS.local_embedder_threads,
  };
}

/** The inventory HOST VARS for local embedder knobs that differ from the
 * shipped defaults (which the tracked group_vars carry) — scripts/deploy.sh
 * refuses a config.toml whose port or threads the deploy would not render. */
export function localEmbedderHostVars(rt: LocalEmbedderRuntime): Array<[string, string]> {
  const out: Array<[string, string]> = [];
  if (rt.port !== OPENVIKING_DEFAULTS.local_embedder_port)
    out.push(["openviking_local_embedder_port", String(rt.port)]);
  if (rt.threads !== OPENVIKING_DEFAULTS.local_embedder_threads)
    out.push(["openviking_local_embedder_threads", String(rt.threads)]);
  return out;
}

/** The inventory HOST VARS for a hosted opt-in — nothing for the local
 * default, which the tracked group_vars already carry. */
export function embedderHostVars(e: DeclaredEmbedder): Array<[string, string]> {
  if (e.provider === "local") return [];
  return [
    ["openviking_embedding_provider", e.provider],
    ["openviking_embedding_model", e.model],
    ["openviking_embedding_dimension", String(e.dimension)],
    ["openviking_embedding_key_file", e.keyFile],
  ];
}

export function describeEmbedder(e: {
  provider: string;
  model: string;
  dimension: number;
}): string {
  return `${e.provider}/${e.model} (${e.dimension} dims)`;
}

const LOCAL_SENTENCE =
  "memory embeds LOCALLY, inside the daemon container — no memory text leaves the machine, and nothing but the model call does. " +
  "No key is needed and none is read";
const HOSTED_SENTENCE =
  "memory embeds through OpenAI's hosted embeddings endpoint: EVERY memory entry's text, and every search query, is sent there. " +
  "You chose this; the shipped default is local";

/** The credential check for the hosted opt-in — pi's key never counts. */
export function keyFileCheck(secretsDir: string, keyFile: string): CheckResult {
  const path = join(secretsDir, keyFile);
  const value = readTextOrNull(path)?.trim() ?? "";
  if (value.startsWith("sk-")) {
    return {
      name: "embeddings-key",
      ok: true,
      detail: `${path} is present (0600 by the wizard) — the memory engine reads it, and only it, for embeddings`,
    };
  }
  const pi = existsSync(join(secretsDir, "openai_api_key"))
    ? " pi's openai_api_key is there, but it is pi's model credential and is deliberately NOT used for embeddings."
    : "";
  return {
    name: "embeddings-key",
    ok: false,
    detail:
      (value === ""
        ? `no ${keyFile} in ${secretsDir}.`
        : `${path} exists but does not look like an OpenAI key.`) +
      pi +
      ` Without it the memory engine refuses to start (memory degrades; the embedder is never switched silently). Fix: in another terminal, ` +
      `\`bash deploy/collect-secrets.sh\` and paste the key at the ${keyFile} prompt (never through this session — it would land in a transcript), then run this step again`,
  };
}

function propagationNote(ctx: StepContext, e: DeclaredEmbedder): CheckResult {
  const vm = topologyOf(ctx.choices) === "vm";
  return {
    name: "propagation",
    ok: true,
    detail: vm
      ? e.provider === "local"
        ? "the deploy renders the tracked group_vars, which already say local — nothing else to write"
        : "the inventory step (68) writes these as HOST VARS on your inventory line, which is what the deploy renders; scripts/deploy.sh refuses to deploy if config.toml and that value ever disagree"
      : "the bring-up step (70) writes these into the project .env, which docker-compose.yml passes into the container",
  };
}

const MIGRATION_NOTE: CheckResult = {
  name: "existing-store",
  ok: true,
  detail:
    "if this installation already holds memory embedded under a DIFFERENT embedder, the next boot moves the old vectors aside " +
    "(kept, never deleted) and the daemon re-embeds reviewer memory through the server once it is ready; the companion's namespace " +
    "is yours to rebuild from this machine with `qcr memory reembed`. The memory TEXT is never touched. docs/memory-embeddings.md has the whole shape",
};

export function embeddingsStep(): OnboardingStep {
  return {
    id: EMBEDDINGS_STEP_ID,
    title: "Memory embeddings: local by default",
    explain:
      "Decides where the memory engine computes its vectors. The shipped default is LOCAL: a small English embedding model " +
      `(${LOCAL_EMBEDDING.model}, pinned in the image) served on loopback inside the daemon ` +
      "container, so nothing but the model call ever leaves the machine — memory text included — and no key is needed. Calling this " +
      "step with no arguments keeps whatever the config already declares (the local default on a fresh install); moving an " +
      'installation back to local takes an explicit `provider: "local"`. The alternative is OpenAI\'s hosted embeddings (`provider: "openai"`): every memory ' +
      "entry's text is then sent to OpenAI, and the credential is its OWN secrets file (openai_embeddings_api_key, via " +
      "deploy/collect-secrets.sh) — pi's openai_api_key is never used for it. Do not offer the hosted option as an upgrade; offer it " +
      "only if the operator asks, and say plainly what leaves the machine.",
    order: 38,
    parameters: {
      type: "object",
      properties: {
        provider: {
          type: "string",
          enum: [...EMBEDDING_PROVIDERS],
          description:
            '"local" (the shipped default) or "openai" (hosted; sends memory text to OpenAI). Omit to keep what config.toml declares.',
        },
        model: {
          type: "string",
          description:
            "Hosted only: the embedding model (default text-embedding-3-small). Ignored for local, which has one model.",
        },
        dimension: {
          type: "string",
          description:
            "Hosted only: the vector dimension of that model (default 1536). Ignored for local.",
        },
      },
    },

    async run(ctx): Promise<StepReport> {
      const path = interviewConfigPath(ctx);
      const text = readTextOrNull(path);
      if (text === null) {
        return {
          ok: false,
          checks: [
            {
              name: "config.toml",
              ok: false,
              detail: `${path} does not exist yet — run the config_fill step first; this step then writes the embedder into it`,
            },
          ],
        };
      }
      const current = declaredEmbedderOf(text);
      const rawProvider = String(ctx.input.provider ?? current.provider)
        .trim()
        .toLowerCase();
      if (!(EMBEDDING_PROVIDERS as readonly string[]).includes(rawProvider)) {
        return {
          ok: false,
          checks: [
            {
              name: "provider",
              ok: false,
              detail: `"${rawProvider}" is not an embedder — the choices are ${EMBEDDING_PROVIDERS.map((p) => `"${p}"`).join(" and ")}`,
            },
          ],
        };
      }
      const provider = rawProvider as EmbeddingProvider;
      const model =
        provider === "local"
          ? LOCAL_EMBEDDING.model
          : String(
              ctx.input.model ??
                (current.provider === "openai" ? current.model : HOSTED_EMBEDDING.model),
            ).trim() || HOSTED_EMBEDDING.model;
      const dimensionRaw =
        provider === "local"
          ? String(LOCAL_EMBEDDING.dimension)
          : String(
              ctx.input.dimension ??
                (current.provider === "openai" ? current.dimension : HOSTED_EMBEDDING.dimension),
            ).trim();
      if (!/^[1-9][0-9]*$/.test(dimensionRaw)) {
        return {
          ok: false,
          checks: [
            {
              name: "dimension",
              ok: false,
              detail: `"${dimensionRaw}" is not a vector dimension — a positive integer, e.g. 1536 for text-embedding-3-small`,
            },
          ],
        };
      }
      const edits: TomlEdit[] = [
        { section: "openviking", key: "embedding_provider", value: tomlString(provider) },
        { section: "openviking", key: "embedding_model", value: tomlString(model) },
        { section: "openviking", key: "embedding_dimension", value: dimensionRaw },
      ];
      // Rule 1, structurally: the only wizard file that may write `dry_run`
      // is golive.ts; every other edit list is asserted clean first.
      assertNoDryRunEdit(edits);
      const patched = patchToml(text, edits);
      // Parse BEFORE writing — the loader's own validation is the lock, so a
      // config this step writes can always be booted.
      try {
        parseConfig(patched);
      } catch (err) {
        return {
          ok: false,
          checks: [
            {
              name: "config validation",
              ok: false,
              detail: `the embedder this step would write does not load: ${String(err)} — nothing was written`,
            },
          ],
        };
      }
      if (patched !== text) writeAtomic(path, patched);
      const declared = declaredEmbedderOf(patched);

      const checks: CheckResult[] = [
        {
          name: "embedder",
          ok: true,
          detail: `${describeEmbedder(declared)} — ${provider === "local" ? LOCAL_SENTENCE : HOSTED_SENTENCE}`,
        },
        {
          name: "config.toml",
          ok: true,
          detail: `[openviking] embedding_provider/model/dimension ${patched === text ? "already said this" : `written to ${path}`}, and it parses`,
        },
      ];
      if (provider !== "local")
        checks.push(keyFileCheck(secretsDirFor(ctx.adapters, ctx.choices), declared.keyFile));
      checks.push(propagationNote(ctx, declared), MIGRATION_NOTE);
      return {
        ok: checks.every((c) => c.ok),
        checks,
        data: { provider, model: declared.model, dimension: declared.dimension, config_path: path },
      };
    },

    async verify(ctx): Promise<StepReport> {
      const path = interviewConfigPath(ctx);
      const text = readTextOrNull(path);
      if (text === null)
        return {
          ok: false,
          checks: [{ name: "config.toml", ok: false, detail: `${path} does not exist` }],
        };
      let declared: DeclaredEmbedder;
      try {
        declared = embedderOf(parseConfig(text).openviking);
      } catch (err) {
        return {
          ok: false,
          checks: [
            { name: "config.toml", ok: false, detail: `${path} does not load: ${String(err)}` },
          ],
        };
      }
      const checks: CheckResult[] = [
        {
          name: "embedder",
          ok: true,
          detail: `${describeEmbedder(declared)} — ${declared.provider === "local" ? LOCAL_SENTENCE : HOSTED_SENTENCE}`,
        },
      ];
      if (declared.provider !== "local")
        checks.push(keyFileCheck(secretsDirFor(ctx.adapters, ctx.choices), declared.keyFile));
      return { ok: checks.every((c) => c.ok), checks };
    },
  };
}
