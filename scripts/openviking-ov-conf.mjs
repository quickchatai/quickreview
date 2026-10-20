#!/usr/bin/env node
// Renders OpenViking's ov.conf for the memory sidecar (docker/memory/).
//
// The memory image is the only place the file is rendered (the daemon
// entrypoints' inline heredocs are gone). tests/memory-image.test.ts runs this
// script over a temp secrets mount and holds the document it writes.
//
// Everything arrives by environment:
//   OPENVIKING_CONF                  where to write ov.conf (0600)
//   QCR_SECRETS                      the read-only secrets mount
//   QCR_OV_PORT, QCR_OV_WORKERS, QCR_OV_QUEUE_CONCURRENCY, QCR_OV_AUTH_MODE
//   QCR_OV_EMBEDDING_PROVIDER / _MODEL / _DIMENSION / _KEY_FILE
//   QCR_OV_LOCAL_EMBEDDER_MODEL / _DIMENSION / _PORT
//   QCR_OV_ROOT_KEY_FILE
// and one more:
//   QCR_OV_HOST                      server.host (default 127.0.0.1; the
//                                    sidecar binds its private network)
//
// The rules: no `vlm` section; api_key mode needs the root
// key from the secrets mount (missing => dev, loudly); the embedder is always
// written explicitly so the migration check can compare it with the store;
// `local` is the pinned model over the loopback service, a hosted provider
// reads ITS OWN key file and is never switched silently.
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

/** The ov.conf document and the warnings the render said aloud. */
export function renderOvConf(env, secretsDir) {
  const warnings = [];
  const home = dirname(env.OPENVIKING_CONF);
  const conf = {
    server: {
      host: env.QCR_OV_HOST || "127.0.0.1",
      port: Number(env.QCR_OV_PORT),
      workers: Number(env.QCR_OV_WORKERS),
      auth_mode: env.QCR_OV_AUTH_MODE,
    },
    storage: { workspace: join(home, "workspace") },
    queue_workers: {
      external_parse: { max_concurrent: Number(env.QCR_OV_QUEUE_CONCURRENCY) },
      add_resource: {
        max_concurrent: Number(env.QCR_OV_QUEUE_CONCURRENCY),
        file_vectorization_concurrency: Number(env.QCR_OV_QUEUE_CONCURRENCY),
      },
      session_commit: { max_concurrent: Number(env.QCR_OV_QUEUE_CONCURRENCY) },
    },
    memory: {
      extraction_enabled: false,
      session_skill_extraction_enabled: false,
      link_enabled: false,
    },
    retrieval: { enable_intent: false },
    log: { level: "INFO", output: "stdout" },
  };
  if (conf.server.auth_mode === "api_key") {
    const rootFile = join(secretsDir, env.QCR_OV_ROOT_KEY_FILE);
    if (existsSync(rootFile)) {
      conf.server.root_api_key = readFileSync(rootFile, "utf8").trim();
    } else {
      conf.server.auth_mode = "dev";
      warnings.push(
        "openviking: NO " +
          env.QCR_OV_ROOT_KEY_FILE +
          " in the secrets mount — falling back to auth_mode=dev. Per-user confinement is NOT enforced in that mode: provision the root key and restart.",
      );
    }
  }
  conf.embedding = {
    max_concurrent: Number(env.QCR_OV_QUEUE_CONCURRENCY),
    dense: {
      provider: env.QCR_OV_EMBEDDING_PROVIDER,
      model: env.QCR_OV_EMBEDDING_MODEL,
      dimension: Number(env.QCR_OV_EMBEDDING_DIMENSION),
      input: "text",
    },
  };
  if (conf.embedding.dense.provider === "local") {
    const pinned = {
      model: env.QCR_OV_LOCAL_EMBEDDER_MODEL,
      dimension: Number(env.QCR_OV_LOCAL_EMBEDDER_DIMENSION),
    };
    if (
      conf.embedding.dense.model !== pinned.model ||
      conf.embedding.dense.dimension !== pinned.dimension
    )
      warnings.push(
        "openviking: QCR_OPENVIKING_EMBEDDING_MODEL/DIMENSION (" +
          conf.embedding.dense.model +
          ", " +
          conf.embedding.dense.dimension +
          ") ignored under provider local — the local embedder runs " +
          pinned.model +
          " at " +
          pinned.dimension +
          " dims",
      );
    conf.embedding.dense = {
      provider: "openai",
      model: pinned.model,
      dimension: pinned.dimension,
      api_base: "http://127.0.0.1:" + Number(env.QCR_OV_LOCAL_EMBEDDER_PORT) + "/v1",
      query_param: "query",
      document_param: "passage",
      input: "text",
    };
  } else {
    const embedKeyFile = join(secretsDir, env.QCR_OV_EMBEDDING_KEY_FILE);
    if (existsSync(embedKeyFile)) {
      conf.embedding.dense.api_key = readFileSync(embedKeyFile, "utf8").trim();
    } else {
      warnings.push(
        "openviking: embedding provider '" +
          conf.embedding.dense.provider +
          "' is configured but " +
          env.QCR_OV_EMBEDDING_KEY_FILE +
          " is NOT in the secrets mount — the server will refuse to start until it is (memory degrades; the embedder is never switched silently)",
      );
    }
  }
  return { conf, warnings };
}

/** Render and write ov.conf (0600), creating the workspace directory. */
export function writeOvConf(env = process.env) {
  const secrets = env.QCR_SECRETS || "/opt/quickreview/secrets";
  const { conf, warnings } = renderOvConf(env, secrets);
  for (const w of warnings) console.warn(w);
  const target = env.OPENVIKING_CONF;
  mkdirSync(join(dirname(target), "workspace"), { recursive: true });
  writeFileSync(target, JSON.stringify(conf, null, 2) + "\n", { mode: 0o600 });
  chmodSync(target, 0o600);
  console.log(
    "openviking: ov.conf rendered at " +
      target +
      " (no vlm section; auth_mode=" +
      conf.server.auth_mode +
      " on " +
      conf.server.host +
      "; embedder " +
      conf.embedding.dense.provider +
      "/" +
      conf.embedding.dense.model +
      " " +
      conf.embedding.dense.dimension +
      " dims" +
      (conf.embedding.dense.api_base ? " at " + conf.embedding.dense.api_base : "") +
      ")",
  );
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  try {
    writeOvConf();
  } catch (err) {
    console.error(
      "openviking: ov.conf render FAILED — " + (err instanceof Error ? err.message : err),
    );
    process.exitCode = 1;
  }
}
