#!/usr/bin/env node
// Emits deploy-manifest-<version>.json (deploy/manifest.schema.json) from what
// the release workflow's publish legs recorded, and validates it with the
// controller's own parser before writing, so CI never ships a manifest
// `scripts/deploy.sh release` would refuse.
//
//   node scripts/emit-deploy-manifest.mjs --version X.Y.Z --revision <sha> \
//        --digests <dir> --out <file>
//
// <dir> holds digests-release.json and digests-memory.json, each
// {"repository", "index", "amd64", "arm64"}. The pins are read from the
// checkout the images were built from (package.json's pi block, the memory
// Dockerfile's ARGs, the daemon Dockerfile's qcr.runspec label).
import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { manifestProblems } from "./deploy-manifest.mjs";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");

function dockerfileArg(text, name) {
  const m = new RegExp(`^ARG ${name}=(.+)$`, "m").exec(text);
  if (!m) throw new Error(`docker/memory/Dockerfile has no ARG ${name}`);
  return m[1].trim();
}

/** The pins the images were built with, read from the checkout at `dir`. */
export function readPins(dir = root) {
  const pkg = JSON.parse(readFileSync(join(dir, "package.json"), "utf8"));
  const mem = readFileSync(join(dir, "docker", "memory", "Dockerfile"), "utf8");
  const daemon = readFileSync(join(dir, "docker", "Dockerfile"), "utf8");
  const rs = /qcr\.runspec="(\d+)"/.exec(daemon);
  if (!rs) throw new Error("docker/Dockerfile has no qcr.runspec label");
  return {
    pi: pkg.pi.version,
    openviking: dockerfileArg(mem, "OPENVIKING_VERSION"),
    llama_cpp_python: dockerfileArg(mem, "LLAMA_CPP_PYTHON_VERSION"),
    embedder_file: `${dockerfileArg(mem, "LOCAL_EMBEDDER_DIR")}/${dockerfileArg(mem, "LOCAL_EMBEDDER_MODEL")}.gguf`,
    embedder_sha256: dockerfileArg(mem, "LOCAL_EMBEDDER_SHA256"),
    runspec: Number(rs[1]),
  };
}

const image = (d) => ({
  repository: d.repository,
  index_digest: d.index,
  platforms: { "linux/amd64": d.amd64, "linux/arm64": d.arm64 },
});

/** The manifest, or a thrown error naming every problem. */
export function buildManifest({ version, revision, release, memory, pins }) {
  const m = {
    schema: 1,
    version,
    revision,
    images: { daemon: image(release), memory: image(memory) },
    pins,
  };
  const problems = manifestProblems(m);
  if (problems.length)
    throw new Error(`the manifest would be invalid:\n  ${problems.join("\n  ")}`);
  return m;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const a = process.argv.slice(2);
  const opt = (n) => {
    const i = a.indexOf(`--${n}`);
    return i >= 0 ? a[i + 1] : undefined;
  };
  const [version, revision, digests, out] = ["version", "revision", "digests", "out"].map(opt);
  if (!version || !revision || !digests || !out) {
    console.error(
      "usage: emit-deploy-manifest.mjs --version V --revision SHA --digests DIR --out FILE",
    );
    process.exit(2);
  }
  try {
    const read = (n) => JSON.parse(readFileSync(join(digests, `digests-${n}.json`), "utf8"));
    const m = buildManifest({
      version,
      revision,
      release: read("release"),
      memory: read("memory"),
      pins: readPins(),
    });
    writeFileSync(out, `${JSON.stringify(m, null, 2)}\n`);
  } catch (err) {
    console.error(err.message);
    process.exit(1);
  }
}
