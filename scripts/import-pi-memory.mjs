#!/usr/bin/env node
// runner for the curated-memory import (src/memory/import.ts).
//
// Thin on purpose: everything that decides what crosses lives in the import
// module; this file only wires the two ends of the seam and prints the log.
//
//   source — the retired engine's MEMORY.md through the read-only
//            `legacy-file.ts` reader (the file this process can see;
//            --memory overrides the path).
//   dest   — ANY MemoryStore, loaded dynamically from `--dest <module>#<export>`
//            so the runner never names a particular engine. The export may be
//            a store or a zero-arg factory returning one (sync or async).
//
// With no --dest it is a DRY RUN against an in-memory store: nothing is
// written anywhere, and the log tells you exactly what a real run would
// import and what it would leave behind.
//
// Usage:
//   node scripts/import-pi-memory.mjs [--memory PATH] [--dest MODULE#EXPORT]
//                                     [--batch-size N] [--archive] [--log FILE]
//
// The import is BEST EFFORT with no gate (the owner, 2026-08-20): it always
// exits 0 unless it could not even start. Read the log.
import { existsSync } from "node:fs";
import { writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const DIST = join(ROOT, "dist", "src", "memory");

function die(msg) {
  process.stderr.write(`import-pi-memory: ${msg}\n`);
  process.exit(2);
}

function parseArgs(argv) {
  const args = {
    batchSize: undefined,
    memory: undefined,
    dest: undefined,
    archive: false,
    log: undefined,
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const next = () => {
      const v = argv[++i];
      if (v === undefined) die(`${a} needs a value`);
      return v;
    };
    if (a === "--memory") args.memory = next();
    else if (a === "--dest") args.dest = next();
    else if (a === "--batch-size") args.batchSize = Number(next());
    else if (a === "--log") args.log = next();
    else if (a === "--archive") args.archive = true;
    else if (a === "-h" || a === "--help") {
      process.stdout.write(
        "usage: import-pi-memory.mjs [--memory PATH] [--dest MODULE#EXPORT] [--batch-size N] [--archive] [--log FILE]\n",
      );
      process.exit(0);
    } else die(`unknown argument '${a}'`);
  }
  if (args.batchSize !== undefined && !Number.isInteger(args.batchSize))
    die("--batch-size must be an integer");
  return args;
}

/** `<module>#<export>` → the MemoryStore it names. Relative paths resolve
 * against the sandbox root; a factory export is called with no arguments. */
async function loadDest(spec) {
  const hash = spec.lastIndexOf("#");
  if (hash <= 0) die("--dest must be '<module>#<export>'");
  const modSpec = spec.slice(0, hash);
  const exportName = spec.slice(hash + 1);
  const target =
    modSpec.startsWith(".") || modSpec.startsWith("/")
      ? pathToFileURL(resolve(ROOT, modSpec)).href
      : modSpec;
  const mod = await import(target);
  const found = mod[exportName];
  if (found === undefined) die(`module '${modSpec}' has no export '${exportName}'`);
  const store = typeof found === "function" ? await found() : found;
  if (typeof store?.read !== "function" || typeof store?.apply !== "function")
    die(`'${exportName}' is not a MemoryStore`);
  return store;
}

const args = parseArgs(process.argv.slice(2));

if (!existsSync(join(DIST, "import.js"))) die("dist missing — run `npm run build` first");

const { importMemory, recordingMemoryStore, archiveReadOnly, formatImportLog } = await import(
  pathToFileURL(join(DIST, "import.js")).href
);
const { legacyMemoryFileSource, legacyMemoryPath } = await import(
  pathToFileURL(join(DIST, "legacy-file.js")).href
);

const memoryPath = args.memory ? resolve(args.memory) : legacyMemoryPath();
const source = legacyMemoryFileSource(memoryPath);
const dryRun = args.dest === undefined;
const dest = dryRun ? recordingMemoryStore() : await loadDest(args.dest);

if (dryRun) process.stdout.write("DRY RUN — no destination given, nothing will be written\n");
process.stdout.write(`source: ${memoryPath}\n`);

const archive = args.archive && !dryRun ? () => archiveReadOnly(memoryPath) : undefined;
if (args.archive && dryRun)
  process.stdout.write("--archive ignored in a dry run (the source file is left untouched)\n");

const report = await importMemory({
  source,
  dest,
  log: (line) => process.stdout.write(`${line}\n`),
  ...(args.batchSize !== undefined ? { batchSize: args.batchSize } : {}),
  ...(archive ? { archive } : {}),
});

if (args.log) {
  await writeFile(resolve(args.log), formatImportLog(report), "utf8");
  process.stdout.write(`log written to ${resolve(args.log)}\n`);
}
