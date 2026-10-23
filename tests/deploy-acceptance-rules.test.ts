// The release version and image digest acceptance rules are spelled in four
// consumers (the updater, the controller, the manifest checker and its JSON
// schema). They must stay one rule: each spelling is read out of its file and
// held to the same table of accepted and refused inputs.
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const read = (p: string): string => readFileSync(join(root, p), "utf8");

const shellVar = (file: string, name: string): RegExp => {
  const m = new RegExp(`^${name}='([^']+)'`, "m").exec(read(file));
  if (!m) throw new Error(`${name} not found in ${file}`);
  return new RegExp(m[1]!);
};
const jsRegex = (file: string, name: string): RegExp => {
  const m = new RegExp(`${name} = /(.+)/;`).exec(read(file));
  if (!m) throw new Error(`${name} not found in ${file}`);
  return new RegExp(m[1]!);
};
const schema = JSON.parse(read("deploy/manifest.schema.json")) as {
  properties: { version: { pattern: string } };
  $defs: { digest: { pattern: string } };
};

const VERSIONS: Array<[string, boolean]> = [
  ["1.2.3", true],
  ["10.20.30", true],
  ["1.2.3-rc.1", true],
  ["1.2", false],
  ["v1.2.3", false],
  ["1.2.3-", false],
  ["1.2.3-rc_1", false],
  ["latest", false],
];
const DIGESTS: Array<[string, boolean]> = [
  [`sha256:${"a".repeat(64)}`, true],
  [`sha256:${"A".repeat(64)}`, false],
  [`sha256:${"a".repeat(63)}`, false],
  [`sha256:${"a".repeat(65)}`, false],
  [`sha512:${"a".repeat(64)}`, false],
  [`sha256:${"g".repeat(64)}`, false],
];

describe("release version and digest acceptance rules agree across consumers", () => {
  const versionRules: Record<string, RegExp> = {
    "deploy/qcr-update.sh": shellVar("deploy/qcr-update.sh", "VERSION_RE"),
    "scripts/deploy.sh": shellVar("scripts/deploy.sh", "RELEASE_VERSION_RE"),
    "scripts/deploy-manifest.mjs": jsRegex("scripts/deploy-manifest.mjs", "VERSION_RE"),
    "deploy/manifest.schema.json": new RegExp(schema.properties.version.pattern),
  };
  const digestRules: Record<string, RegExp> = {
    "deploy/qcr-update.sh": shellVar("deploy/qcr-update.sh", "DIGEST_RE"),
    "scripts/deploy-manifest.mjs": jsRegex("scripts/deploy-manifest.mjs", "DIGEST_RE"),
    "deploy/manifest.schema.json": new RegExp(schema.$defs.digest.pattern),
  };
  for (const [name, re] of Object.entries(versionRules)) {
    it(`${name} accepts and refuses the same versions`, () => {
      for (const [v, ok] of VERSIONS) expect(re.test(v), v).toBe(ok);
    });
  }
  for (const [name, re] of Object.entries(digestRules)) {
    it(`${name} accepts and refuses the same digests`, () => {
      for (const [d, ok] of DIGESTS) expect(re.test(d), d).toBe(ok);
    });
  }
});
