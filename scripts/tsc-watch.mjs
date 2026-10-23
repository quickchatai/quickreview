#!/usr/bin/env node
// `tsc` in watch mode, plus the build stamp (scripts/build-stamp.mjs) after
// every pass that compiled cleanly. `tsc -b --watch` reports once per pass,
// after the last project: "Found 0 errors. Watching for file changes." is the
// only moment both dists are whole, so it is the only moment the TUI's hot
// reload may hear about a core change. A pass with errors writes no stamp.
//
// Arguments pass through to tsc (`node scripts/tsc-watch.mjs -b --watch
// --preserveWatchOutput`); tsc's output passes through unchanged, so the
// caller decides where it goes (dev-tui.sh sends it to a log, never the
// terminal the TUI owns). A signal to this process stops the compiler too.
import { spawn } from "node:child_process";
import { createRequire } from "node:module";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { ROOT, stampIfNewer } from "./build-stamp.mjs";

/** Is this line tsc's report of a pass that compiled with no errors? */
export function isCleanPass(line) {
  return /\bFound 0 errors\. Watching for file changes\./.test(line);
}

function main() {
  const tsc = createRequire(import.meta.url).resolve("typescript/bin/tsc");
  const child = spawn(process.execPath, [tsc, ...process.argv.slice(2)], {
    cwd: ROOT,
    stdio: ["ignore", "pipe", "inherit"],
  });
  let pending = "";
  child.stdout.on("data", (chunk) => {
    process.stdout.write(chunk);
    pending += chunk.toString("utf8");
    const lines = pending.split("\n");
    pending = lines.pop() ?? "";
    for (const line of lines) if (isCleanPass(line)) stampIfNewer(ROOT);
  });
  for (const sig of ["SIGINT", "SIGTERM", "SIGHUP"])
    process.on(sig, () => {
      child.kill(sig);
    });
  child.on("exit", (code, signal) => process.exit(code ?? (signal ? 1 : 0)));
}

// `node scripts/tsc-watch.mjs …` runs the compiler; importing it does not.
if (process.argv[1] && resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url))) main();
