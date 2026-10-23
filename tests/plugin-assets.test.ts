// The review core package's prepack (scripts/plugin-assets.mjs) copies the
// data the core reads into packages/pi-plugin/assets/, byte for byte, and the
// core's asset lookup finds that copy in an installed package.
import { createHash } from "node:crypto";
import {
  appendFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { assetRootFrom } from "@quickchatai/pi-quickreview/src/assetroot.js";
import {
  ASSETS,
  ROOT_FILES,
  cleanAssets,
  copyAssets,
  verifyAssets,
} from "../scripts/plugin-assets.mjs";

const ROOT = resolve(import.meta.dirname, "..");
const sha = (p: string): string => createHash("sha256").update(readFileSync(p)).digest("hex");

describe("the plugin's packed data", () => {
  const plugin = mkdtempSync(join(tmpdir(), "qcr-plugin-assets-"));
  afterAll(() => rmSync(plugin, { recursive: true, force: true }));

  // MUTATION: leave the seed manifest out of ASSETS, or rewrite a file while
  // copying — this fails.
  it("is a byte copy of the root's data, with the seed manifest at its root", () => {
    expect(copyAssets(ROOT, plugin)).toEqual(ASSETS.map(([, to]) => to));
    const assets = join(plugin, "assets");
    expect(sha(join(assets, "seed-manifest.json"))).toBe(
      sha(join(ROOT, "tests", "fixtures", "seed-manifest.json")),
    );
    for (const rel of [
      "agents/pass-baseline.md",
      "deploy/reviewer/AGENTS.override.md",
      "config.example.toml",
    ])
      expect(sha(join(assets, rel)), rel).toBe(sha(join(ROOT, rel)));
    // …and an installed package resolves its data there.
    mkdirSync(join(plugin, "dist", "src"), { recursive: true });
    expect(assetRootFrom(join(plugin, "dist", "src"))).toBe(assets);
  });

  // The copy is for the tarball only. Left in the checkout it is a frozen,
  // gitignored second copy of the data beside the sources.
  // MUTATION: drop the postpack — this fails.
  it("is removed again once the pack is done", () => {
    const pkg = JSON.parse(
      readFileSync(join(ROOT, "packages", "pi-plugin", "package.json"), "utf8"),
    ) as { scripts: Record<string, string> };
    expect(pkg.scripts["prepack"]).toBe("tsc -b && node ../../scripts/plugin-assets.mjs");
    expect(pkg.scripts["postpack"]).toBe("node ../../scripts/plugin-assets.mjs --clean");
    copyAssets(ROOT, plugin);
    expect(ROOT_FILES).toEqual(["LICENSE"]);
    expect(sha(join(plugin, "LICENSE"))).toBe(sha(join(ROOT, "LICENSE")));
    cleanAssets(plugin);
    expect(existsSync(join(plugin, "assets"))).toBe(false);
    expect(existsSync(join(plugin, "LICENSE"))).toBe(false);
  });

  // MUTATION: make verifyAssets compare names only, or skip a directory —
  // this fails.
  it("fails the pack when a copied byte, a file or the LICENSE differs from the root's", () => {
    copyAssets(ROOT, plugin);
    expect(verifyAssets(ROOT, plugin)).toContain("agents/pass-baseline.md");
    appendFileSync(join(plugin, "assets", "agents", "pass-baseline.md"), " ");
    expect(() => verifyAssets(ROOT, plugin)).toThrow(/agents\/pass-baseline\.md differs/);
    copyAssets(ROOT, plugin);
    writeFileSync(join(plugin, "assets", "prompts", "extra.md"), "x");
    expect(() => verifyAssets(ROOT, plugin)).toThrow(/exactly the files of prompts/);
    copyAssets(ROOT, plugin);
    writeFileSync(join(plugin, "LICENSE"), "not it");
    expect(() => verifyAssets(ROOT, plugin)).toThrow(/LICENSE differs/);
    cleanAssets(plugin);
  });
});
