#!/usr/bin/env node
// The pi canaries (tests/pi-canary/) on every pi version the plugin's range
// should hold: `npm run canary:pi:range [-- [--install] VERSION…]`.
//
// The range is the plugin's own (packages/pi-plugin/package.json
// peerDependencies, the version gate's); a version outside it is refused, so
// a widened range is a deliberate act with a canary result beside it. With
// no version given, the pi this checkout has installed is the one run.
// A version that is not installed needs `--install`, which puts pi and its
// sibling packages at that version into node_modules without saving (it
// reaches the registry, so run it in a fresh checkout). CI runs only the
// installed pi's canaries; a version joins the range after this ran by hand.
import { execFileSync, spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const PI = "@earendil-works/pi-coding-agent";
const SIBLINGS = [
  PI,
  "@earendil-works/pi-ai",
  "@earendil-works/pi-agent-core",
  "@earendil-works/pi-tui",
];

const read = (p) => JSON.parse(readFileSync(p, "utf8"));
const range = read(join(ROOT, "packages", "pi-plugin", "package.json")).peerDependencies[PI];
const installed = () => read(join(ROOT, "node_modules", PI, "package.json")).version;
const { satisfiesRange } = await import(
  pathToFileURL(join(ROOT, "packages", "pi-plugin", "dist", "src", "plugin", "versiongate.js")).href
);

const args = process.argv.slice(2);
const install = args.includes("--install");
const versions = args.filter((a) => a !== "--install");
if (versions.length === 0) versions.push(installed());

let failed = 0;
for (const v of versions) {
  if (!satisfiesRange(v, range)) {
    console.error(`pi ${v} is outside the plugin's range ${range}: refused`);
    process.exit(2);
  }
  if (installed() !== v) {
    if (!install) {
      console.error(
        `pi ${v} is not installed here (${installed()} is): pass --install to fetch it`,
      );
      process.exit(2);
    }
    execFileSync(
      "npm",
      ["install", "--no-save", "--no-audit", "--no-fund", ...SIBLINGS.map((p) => `${p}@${v}`)],
      { cwd: ROOT, stdio: "inherit" },
    );
  }
  console.log(`== pi ${installed()} (range ${range}) ==`);
  // The canaries' pin check reads the version this run installed from here.
  const r = spawnSync("npx", ["vitest", "run", "tests/pi-canary"], {
    cwd: ROOT,
    stdio: "inherit",
    env: { ...process.env, QCR_CANARY_PI_VERSION: installed() },
  });
  if (r.status !== 0) {
    console.error(`the canaries failed on pi ${v}`);
    failed++;
  }
}
process.exit(failed === 0 ? 0 : 1);
