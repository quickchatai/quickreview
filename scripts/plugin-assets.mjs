#!/usr/bin/env node
// The review core package's prepack: copy the data the core reads from the
// repo root into packages/pi-plugin/assets/, byte for byte, so an installed
// package finds it beside its own code (assetRoot in
// packages/pi-plugin/src/assetroot.ts looks for assets/agents/ first).
//
// The repo root stays the one source: assets/ is gitignored, rebuilt whole
// on every pack, never edited, and removed again by the postpack
// (`--clean`), so a checkout never keeps a frozen copy beside its sources. Under assets/ the data keeps its repo
// layout (agents/, prompts/, …, deploy/reviewer/), and the seed manifest the
// core checks sits at its root as seed-manifest.json, the first place the
// core's manifest lookup reads.
//
// Why not ship prompts/ at the package root: pi discovers a package's
// prompts/, skills/ and extensions/ directories by convention, and the frozen
// seeds must never become a pi user's slash commands.
import { cpSync, existsSync, mkdirSync, rmSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
export const PLUGIN = join(ROOT, "packages", "pi-plugin");

/** What the core reads, as [repo path, path under assets/]. */
export const ASSETS = [
  ["agents", "agents"],
  ["prompts", "prompts"],
  ["seeds", "seeds"],
  ["schemas", "schemas"],
  ["profiles", "profiles"],
  ["deploy/reviewer", "deploy/reviewer"],
  ["tests/fixtures/seed-manifest.json", "seed-manifest.json"],
  // the shipped defaults a one-shot review runs on when the install has no
  // config of its own (src/homes.ts loadOneShotConfig)
  ["config.example.toml", "config.example.toml"],
];

/** Rebuild `<plugin>/assets` from `root`. Returns the copied paths. */
export function copyAssets(root = ROOT, plugin = PLUGIN) {
  const out = join(plugin, "assets");
  rmSync(out, { recursive: true, force: true });
  mkdirSync(out, { recursive: true });
  for (const [from, to] of ASSETS) {
    const src = join(root, from);
    if (!existsSync(src)) throw new Error(`plugin-assets: ${from} is missing from the checkout`);
    mkdirSync(dirname(join(out, to)), { recursive: true });
    cpSync(src, join(out, to), { recursive: true, preserveTimestamps: true });
  }
  return ASSETS.map(([, to]) => to);
}

/** Remove `<plugin>/assets`: the postpack, once the tarball has it. */
export function cleanAssets(plugin = PLUGIN) {
  rmSync(join(plugin, "assets"), { recursive: true, force: true });
}

// `node scripts/plugin-assets.mjs` copies, `--clean` removes; importing it
// does neither.
if (process.argv[1] && resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url))) {
  if (process.argv[2] === "--clean") cleanAssets();
  else copyAssets();
}
