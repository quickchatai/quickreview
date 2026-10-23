// `qcr version`: what this install is, for a plugin that has to decide whether
// it can talk to it — the image's version, the JSON schema versions it prints
// (packages/pi-plugin/src/contract.ts) and the pi pin it runs.
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import {
  REVIEW_SCHEMA_VERSION,
  SCAN_SCHEMA_VERSION,
  VERSION_SCHEMA_VERSION,
} from "@quickchatai/pi-quickreview/src/contract.js";
import { piPinFromPackageJson } from "./onboard/launch.js";

export interface VersionInfo {
  schema_version: number;
  image: {
    /** package.json's version. */
    version: string;
    /** The stamp `qcr companion rebuild` bakes into the image (BUILD_SHA), null on a bare checkout. */
    build_sha: string | null;
  };
  schemas: { review: number; scan: number };
  pi: { package: string; version: string } | null;
}

/** Read the install's identity from `root` (the app dir: package.json, and
 * BUILD_SHA when the image was stamped). `pin` is the config's pi pin when
 * config.toml loads; package.json's "qcrPi" block answers on a bare clone. */
export function versionInfo(
  root: string,
  pin?: { package: string; version: string } | null,
): VersionInfo {
  let version = "unknown";
  try {
    const pkg = JSON.parse(readFileSync(join(root, "package.json"), "utf8")) as {
      version?: unknown;
    };
    if (typeof pkg.version === "string") version = pkg.version;
  } catch {
    // an unreadable package.json is "unknown", not a crash
  }
  let buildSha: string | null = null;
  const shaFile = join(root, "BUILD_SHA");
  if (existsSync(shaFile)) {
    const s = readFileSync(shaFile, "utf8").trim();
    if (s !== "" && s !== "unstamped") buildSha = s;
  }
  return {
    schema_version: VERSION_SCHEMA_VERSION,
    image: { version, build_sha: buildSha },
    schemas: { review: REVIEW_SCHEMA_VERSION, scan: SCAN_SCHEMA_VERSION },
    pi: pin ?? piPinFromPackageJson(root),
  };
}

export function renderVersion(v: VersionInfo): string {
  return [
    `qcr ${v.image.version}${v.image.build_sha ? ` (build ${v.image.build_sha})` : ""}`,
    `JSON schemas: review v${v.schemas.review}, scan v${v.schemas.scan}`,
    v.pi ? `pi: ${v.pi.package}@${v.pi.version}` : "pi: no pin found",
  ].join("\n");
}

/** The `qcr version` verb: the config's pi pin when config.toml loads, else
 * package.json's mirror. Needs no state and no SQLite, so the npm bin
 * (src/qcrbin.ts) and the image's entry (src/cli.ts) run the same code. */
export async function cmdVersion(
  json: boolean,
  out: (line: string) => void = (l) => console.log(l),
): Promise<void> {
  const { loadConfig, sandboxRoot } = await import("./config.js");
  let pin: { package: string; version: string } | null = null;
  try {
    const { package: pkg, version } = loadConfig().pi;
    pin = { package: pkg, version };
  } catch {
    // a bare clone or a fresh npm install has no config.toml: package.json's qcrPi block answers
  }
  const info = versionInfo(sandboxRoot(), pin);
  out(json ? JSON.stringify(info) : renderVersion(info));
}
