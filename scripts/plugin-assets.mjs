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
//
// The copy is checked against the root after it is made: every file's sha256
// must match its source, or the pack fails. The repo's LICENSE is copied to
// the package root the same way (npm ships it from there) and removed with
// assets/.
import { createHash } from "node:crypto";
import {
  copyFileSync,
  cpSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
} from "node:fs";
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

/** Files beside the package's own that the pack copies from the repo root. */
export const ROOT_FILES = ["LICENSE"];

const sha256 = (p) => createHash("sha256").update(readFileSync(p)).digest("hex");

/** Every file under `p` (or `p` itself), relative to `p`, sorted. */
function filesUnder(p, rel = "") {
  if (!statSync(p).isDirectory()) return [rel];
  return readdirSync(p)
    .sort()
    .flatMap((n) => filesUnder(join(p, n), rel ? `${rel}/${n}` : n));
}

/** Throw unless `<plugin>/assets` (and the root files) are byte copies of
 * `root`'s, file for file, with nothing extra. Returns the files checked. */
export function verifyAssets(root = ROOT, plugin = PLUGIN) {
  const out = join(plugin, "assets");
  const checked = [];
  for (const [from, to] of ASSETS) {
    const src = join(root, from);
    const dst = join(out, to);
    const want = filesUnder(src);
    const have = existsSync(dst) ? filesUnder(dst) : [];
    if (want.join("\n") !== have.join("\n"))
      throw new Error(`plugin-assets: assets/${to} does not hold exactly the files of ${from}`);
    for (const f of want) {
      const a = f ? join(src, f) : src;
      const b = f ? join(dst, f) : dst;
      if (sha256(a) !== sha256(b))
        throw new Error(`plugin-assets: assets/${to}${f ? `/${f}` : ""} differs from ${from}`);
      checked.push(f ? `${to}/${f}` : to);
    }
  }
  for (const f of ROOT_FILES)
    if (sha256(join(root, f)) !== sha256(join(plugin, f)))
      throw new Error(`plugin-assets: ${f} differs from the repo's`);
  return checked;
}

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
  for (const f of ROOT_FILES) copyFileSync(join(root, f), join(plugin, f));
  verifyAssets(root, plugin);
  return ASSETS.map(([, to]) => to);
}

/** Remove `<plugin>/assets` and the root files: the postpack, once the
 * tarball has them. */
export function cleanAssets(plugin = PLUGIN) {
  rmSync(join(plugin, "assets"), { recursive: true, force: true });
  for (const f of ROOT_FILES) rmSync(join(plugin, f), { force: true });
}

// `node scripts/plugin-assets.mjs` copies (and checks), `--clean` removes;
// importing it does neither.
if (process.argv[1] && resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url))) {
  if (process.argv[2] === "--clean") cleanAssets();
  else copyAssets();
}
