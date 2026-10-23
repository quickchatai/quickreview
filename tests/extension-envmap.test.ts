// Every QCR_* and OPENVIKING_* name that appears under extensions/ (the
// app's and the review core's) is classified in the core's packages/pi-plugin/src/engine/envmap.ts. The scan is the source of truth: a name
// added to an extension without a row fails here, so the SDK session builder
// can never miss one when it turns pi's env into factory config.
import { describe, expect, it } from "vitest";
import { readdirSync, readFileSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import {
  EXTENSION_ENV,
  EXTENSION_NON_ENV_NAMES,
  extensionEnvNames,
} from "@quickchatai/pi-quickreview/src/engine/envmap.js";
import { EXTENSION_DIRS } from "./helpers/source-trees.js";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const EXTS = EXTENSION_DIRS.map((d) => join(ROOT, d));
const NAME = /\b(?:QCR|OPENVIKING)_[A-Z0-9_]*[A-Z0-9]/g;
const CODE = /\.(?:ts|mts|mjs|js)$/;

function walk(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
    const p = join(dir, e.name);
    if (e.isDirectory()) return e.name === "node_modules" ? [] : walk(p);
    return CODE.test(e.name) ? [p] : [];
  });
}

/** name -> sorted files (relative to their extensions/) whose text carries it. */
function scan(): Map<string, string[]> {
  const found = new Map<string, Set<string>>();
  for (const [ext, file] of EXTS.flatMap((e) => walk(e).map((f) => [e, f] as const))) {
    const rel = relative(ext, file);
    for (const name of new Set(readFileSync(file, "utf8").match(NAME) ?? [])) {
      if (!found.has(name)) found.set(name, new Set());
      found.get(name)!.add(rel);
    }
  }
  return new Map([...found].map(([n, f]) => [n, [...f].sort()]));
}

describe("extension env inventory", () => {
  const found = scan();
  const envFound = [...found.keys()].filter((n) => !(n in EXTENSION_NON_ENV_NAMES));

  it("classifies every name the extensions carry", () => {
    const unclassified = envFound.filter((n) => !(n in EXTENSION_ENV)).sort();
    expect(unclassified, "add a row to src/engine/envmap.ts").toEqual([]);
  });

  it("holds no stale row", () => {
    const stale = Object.keys(EXTENSION_ENV).filter((n) => !found.has(n));
    expect(stale, "no extension carries this name any more").toEqual([]);
    const staleNonEnv = Object.keys(EXTENSION_NON_ENV_NAMES).filter((n) => !found.has(n));
    expect(staleNonEnv).toEqual([]);
  });

  it("keeps a name out of both tables", () => {
    expect(Object.keys(EXTENSION_NON_ENV_NAMES).filter((n) => n in EXTENSION_ENV)).toEqual([]);
  });

  it("lists exactly the files that carry each name", () => {
    for (const [name, entry] of Object.entries(EXTENSION_ENV)) {
      expect([...entry.readers].sort(), name).toEqual(found.get(name) ?? []);
    }
  });

  it("gives every row a kind and a note", () => {
    for (const [name, entry] of Object.entries(EXTENSION_ENV)) {
      expect(["extension-config", "bash-child-env", "companion-only"], name).toContain(entry.kind);
      expect(entry.note.length, name).toBeGreaterThan(0);
    }
  });

  it("partitions the table by kind", () => {
    const kinds = ["extension-config", "bash-child-env", "companion-only"] as const;
    expect(kinds.flatMap((k) => extensionEnvNames(k)).sort()).toEqual(
      Object.keys(EXTENSION_ENV).sort(),
    );
  });

  it("never classifies a name the model's bash sets per call as extension config", () => {
    // These ride a command's own prefix; bash-guard parses them, no extension reads a value.
    for (const n of ["QCR_EXPECTED_HEAD", "QCR_ROUND_NO", "QCR_POSTING_KEY", "QCR_POST_RESPONSE"]) {
      expect(EXTENSION_ENV[n]?.kind, n).toBe("bash-child-env");
    }
  });
});
