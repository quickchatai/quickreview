#!/usr/bin/env node
// The deploy manifest's parser (deploy/manifest.schema.json documents the
// shape). `scripts/deploy.sh release <version>` reads deploy-manifest-<version>.json
// through this; CI emits it. A hand-written validator rather than a
// schema library: the controller needs node and nothing installed.
//
//   node scripts/deploy-manifest.mjs <file> <version>
//
// prints KEY=VALUE lines on stdout (exit 0), or every problem on stderr (exit 1).
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

export const VERSION_RE = /^[0-9]+\.[0-9]+\.[0-9]+(-[0-9A-Za-z.]+)?$/;
const DIGEST_RE = /^sha256:[0-9a-f]{64}$/;
const REPO_RE = /^[a-z0-9.-]+(:[0-9]+)?(\/[a-z0-9._-]+)+$/;
const PLATFORMS = ["linux/amd64", "linux/arm64"];

const isObject = (v) => typeof v === "object" && v !== null && !Array.isArray(v);

function onlyKeys(errors, where, obj, allowed) {
  for (const k of Object.keys(obj))
    if (!allowed.includes(k)) errors.push(`${where}: unknown key "${k}"`);
  for (const k of allowed) if (!(k in obj)) errors.push(`${where}: missing "${k}"`);
}

function checkImage(errors, where, img) {
  if (!isObject(img)) return errors.push(`${where}: not an object`);
  onlyKeys(errors, where, img, ["repository", "index_digest", "platforms"]);
  if (typeof img.repository === "string" && !REPO_RE.test(img.repository))
    errors.push(`${where}.repository: not an image repository`);
  if ("repository" in img && typeof img.repository !== "string")
    errors.push(`${where}.repository: not a string`);
  if (typeof img.index_digest === "string" && !DIGEST_RE.test(img.index_digest))
    errors.push(`${where}.index_digest: not a sha256 digest`);
  if ("index_digest" in img && typeof img.index_digest !== "string")
    errors.push(`${where}.index_digest: not a string`);
  if (isObject(img.platforms)) {
    onlyKeys(errors, `${where}.platforms`, img.platforms, PLATFORMS);
    for (const p of PLATFORMS)
      if (
        p in img.platforms &&
        !(typeof img.platforms[p] === "string" && DIGEST_RE.test(img.platforms[p]))
      )
        errors.push(`${where}.platforms["${p}"]: not a sha256 digest`);
  } else if ("platforms" in img) errors.push(`${where}.platforms: not an object`);
}

/** Every problem in a manifest, or an empty list. */
export function manifestProblems(value) {
  const errors = [];
  if (!isObject(value)) return ["the manifest is not a JSON object"];
  onlyKeys(errors, "manifest", value, ["schema", "version", "revision", "images", "pins"]);
  if ("schema" in value && value.schema !== 1)
    errors.push(`schema: ${JSON.stringify(value.schema)} (this parser reads schema 1)`);
  if ("version" in value && !(typeof value.version === "string" && VERSION_RE.test(value.version)))
    errors.push("version: not X.Y.Z");
  if (
    "revision" in value &&
    !(typeof value.revision === "string" && /^[0-9a-f]{40}$/.test(value.revision))
  )
    errors.push("revision: not a 40-hex commit");
  if (isObject(value.images)) {
    onlyKeys(errors, "images", value.images, ["daemon", "memory"]);
    checkImage(errors, "images.daemon", value.images.daemon);
    checkImage(errors, "images.memory", value.images.memory);
  } else if ("images" in value) errors.push("images: not an object");
  if (isObject(value.pins)) {
    const p = value.pins;
    onlyKeys(errors, "pins", p, [
      "pi",
      "openviking",
      "llama_cpp_python",
      "embedder_file",
      "embedder_sha256",
      "runspec",
    ]);
    for (const k of ["pi", "openviking", "llama_cpp_python", "embedder_file"])
      if (
        k in p &&
        !(typeof p[k] === "string" && p[k] !== "" && /^[A-Za-z0-9_./:@+-]+$/.test(p[k]))
      )
        errors.push(`pins.${k}: not a plain non-empty string`);
    if (
      "embedder_sha256" in p &&
      !(typeof p.embedder_sha256 === "string" && /^[0-9a-f]{64}$/.test(p.embedder_sha256))
    )
      errors.push("pins.embedder_sha256: not 64 hex");
    if ("runspec" in p && !(Number.isInteger(p.runspec) && p.runspec >= 1))
      errors.push("pins.runspec: not a positive integer");
  } else if ("pins" in value) errors.push("pins: not an object");
  return errors;
}

/** Parse manifest text; throws an Error listing every problem. */
export function parseManifest(text) {
  let value;
  try {
    value = JSON.parse(text);
  } catch (err) {
    throw new Error(`the manifest is not JSON: ${err.message}`, { cause: err });
  }
  const problems = manifestProblems(value);
  if (problems.length > 0)
    throw new Error(`malformed deploy manifest:\n  ${problems.join("\n  ")}`);
  return value;
}

/** The KEY=VALUE lines deploy.sh reads. */
export function manifestLines(m) {
  return [
    `VERSION=${m.version}`,
    `REVISION=${m.revision}`,
    `DAEMON_REPOSITORY=${m.images.daemon.repository}`,
    `DAEMON_INDEX_DIGEST=${m.images.daemon.index_digest}`,
    `MEMORY_REPOSITORY=${m.images.memory.repository}`,
    `MEMORY_INDEX_DIGEST=${m.images.memory.index_digest}`,
    `PIN_PI=${m.pins.pi}`,
    `PIN_OPENVIKING=${m.pins.openviking}`,
    `PIN_LLAMA_CPP_PYTHON=${m.pins.llama_cpp_python}`,
    `PIN_EMBEDDER_FILE=${m.pins.embedder_file}`,
    `PIN_EMBEDDER_SHA256=${m.pins.embedder_sha256}`,
    `PIN_RUNSPEC=${m.pins.runspec}`,
  ];
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const [file, version] = process.argv.slice(2);
  if (!file) {
    console.error("usage: deploy-manifest.mjs <file> [<version>]");
    process.exit(2);
  }
  try {
    const m = parseManifest(readFileSync(file, "utf8"));
    if (version !== undefined && m.version !== version)
      throw new Error(`the manifest is for version ${m.version}, not ${version}`);
    console.log(manifestLines(m).join("\n"));
  } catch (err) {
    console.error(err.message);
    process.exit(1);
  }
}
