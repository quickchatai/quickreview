// pi and pi-ai are exact dependencies of this repo (rule 7), so a VM's plain
// `npm ci` puts a second copy of pi into node_modules beside the global CLI
// the image installs. A live extension imports the package at runtime:
// ledger-pin (`compact`, for the pinned compaction). An
// extension is loaded through jiti with pi's aliases, which map the package
// name to the RUNNING pi's entry point; this file holds that to be true, by
// running a real pi CLI (rpc mode, no session, offline, no model call) with
// the extension loaded and asking where its dynamic import landed.
//
// The mirror tests for the pin itself (lockfile = config.toml = group_vars =
// Dockerfile ARG) are in tests/fences.test.ts [T12] and
// tests/docker-daemon.test.ts; this file adds the two installed copies.
import { spawn } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, dirname, join, sep } from "node:path";
import { afterAll, describe, expect, it } from "vitest";

const ROOT = join(import.meta.dirname, "..");
const PKG = "@earendil-works/pi-coding-agent";
const PKG_AI = "@earendil-works/pi-ai";
const PIN = (
  JSON.parse(readFileSync(join(ROOT, "package.json"), "utf8")) as { pi: { version: string } }
).pi.version;

interface InstalledPi {
  /** The package directory, symlinks resolved. */
  dir: string;
  version: string;
  /** The CLI entry point the package's `bin` names. */
  cli: string;
}

/** The pi package that owns `file`, found by walking up to its package.json. */
function owningPackage(file: string): InstalledPi | undefined {
  for (let dir = dirname(realpathSync(file)); dirname(dir) !== dir; dir = dirname(dir)) {
    const manifest = join(dir, "package.json");
    if (!existsSync(manifest)) continue;
    const pkg = JSON.parse(readFileSync(manifest, "utf8")) as {
      name?: string;
      version?: string;
      bin?: Record<string, string>;
    };
    if (pkg.name !== PKG) return undefined;
    return { dir, version: pkg.version ?? "", cli: join(dir, pkg.bin?.pi ?? "dist/bundle/cli.js") };
  }
  return undefined;
}

const nodeModulesPi = ((): InstalledPi | undefined => {
  const manifest = join(ROOT, "node_modules", PKG, "package.json");
  return existsSync(manifest) ? owningPackage(manifest) : undefined;
})();

/** The pi on PATH, when there is one (the VM image installs it globally). */
const globalPi = ((): InstalledPi | undefined => {
  for (const dir of (process.env.PATH ?? "").split(delimiter)) {
    // npx puts this repo's node_modules/.bin first; that is not a global.
    if (!dir || dir.startsWith(join(ROOT, "node_modules"))) continue;
    const bin = join(dir, "pi");
    if (existsSync(bin)) return owningPackage(bin);
  }
  return undefined;
})();

describe("the declarations are gone and the installed pi is the pinned one", () => {
  it("extensions/pi-api.d.ts and vendor-pi-types.d.ts are deleted", () => {
    expect(existsSync(join(ROOT, "extensions", "pi-api.d.ts"))).toBe(false);
    expect(
      existsSync(join(ROOT, "extensions", "vendor", "openviking-pi", "vendor-pi-types.d.ts")),
    ).toBe(false);
  });

  it("node_modules holds exactly the pinned pi and pi-ai, and one copy of pi-ai", () => {
    expect(nodeModulesPi, "run npm ci").toBeDefined();
    expect(nodeModulesPi?.version).toBe(PIN);
    const ai = JSON.parse(
      readFileSync(join(ROOT, "node_modules", PKG_AI, "package.json"), "utf8"),
    ) as { version: string };
    expect(ai.version).toBe(PIN);
    const lock = JSON.parse(readFileSync(join(ROOT, "package-lock.json"), "utf8")) as {
      packages: Record<string, unknown>;
    };
    const aiCopies = Object.keys(lock.packages).filter((k) => k.endsWith(`node_modules/${PKG_AI}`));
    expect(aiCopies, "a nested pi-ai would be a second instance of pi's provider layer").toEqual([
      `node_modules/${PKG_AI}`,
    ]);
  });

  it.skipIf(!globalPi)("the global pi CLI is the same version as node_modules' pi", () => {
    expect(globalPi?.version).toBe(nodeModulesPi?.version);
  });
});

interface Probe {
  version: string;
  examples: string;
  compactIsPi: boolean;
  stderr: string;
}

const scratch = mkdtempSync(join(tmpdir(), "qcr-pi-resolution-"));
afterAll(() => rmSync(scratch, { recursive: true, force: true }));

/**
 * Start `pi` (rpc mode: a session starts, extensions load, nothing is sent to
 * a model) with ledger-pin and a probe loaded, and read what the
 * probe saw. The probe is a pi extension of its own: at session_start it
 * imports the package the way ledger-pin does, and asks
 * ledger-pin's own `loadPiCompact()` whether it got that same `compact`.
 */
async function runProbe(pi: InstalledPi, name: string): Promise<Probe> {
  const dir = join(scratch, name);
  const agentDir = join(dir, "agent");
  mkdirSync(agentDir, { recursive: true });
  const out = join(dir, "probe.json");
  const probe = join(dir, "probe.ts");
  writeFileSync(
    probe,
    [
      `import { writeFileSync } from "node:fs";`,
      `import { loadPiCompact } from ${JSON.stringify(join(ROOT, "extensions", "ledger-pin.ts"))};`,
      `export default async function (pi: { on(e: string, h: () => Promise<void>): void }) {`,
      `  pi.on("session_start", async () => {`,
      `    const m = (await import(${JSON.stringify(PKG)})) as {`,
      `      VERSION: string; getExamplesPath(): string; compact: unknown };`,
      `    const compact = await loadPiCompact();`,
      `    writeFileSync(${JSON.stringify(out)}, JSON.stringify({`,
      `      version: m.VERSION, examples: m.getExamplesPath(), compactIsPi: compact === m.compact }));`,
      `  });`,
      `}`,
    ].join("\n"),
  );
  const child = spawn(
    process.execPath,
    [
      pi.cli,
      "--mode",
      "rpc",
      "--no-session",
      "--no-extensions",
      "--no-mcp",
      "--no-context-files",
      "-e",
      join(ROOT, "extensions", "cli", "ledger-pin.ts"),
      "-e",
      probe,
    ],
    {
      cwd: dir,
      env: {
        PATH: process.env.PATH,
        HOME: dir,
        PI_CODING_AGENT_DIR: agentDir,
        PI_OFFLINE: "1",
        PI_SKIP_VERSION_CHECK: "1",
        PI_TELEMETRY: "0",
        // The probe loads ledger-pin from this checkout; its session name and
        // PR are the daemon's, and a bare value keeps the snapshot dir inside
        // the scratch dir.
        QCR_SANDBOX_ROOT: dir,
        QCR_LEDGER_FILE: join(dir, "ledger.md"),
      },
      stdio: ["pipe", "pipe", "pipe"],
    },
  );
  let stderr = "";
  child.stderr.on("data", (d: Buffer) => (stderr += d.toString()));
  child.stdout.on("data", () => {});
  child.stdin.write('{"type":"get_state"}\n');
  const deadline = Date.now() + 45_000;
  while (!existsSync(out) && Date.now() < deadline && child.exitCode === null) {
    await new Promise((r) => setTimeout(r, 100));
  }
  child.stdin.end();
  child.kill("SIGTERM");
  expect(existsSync(out), `the probe never ran under ${pi.cli}\n${stderr}`).toBe(true);
  const seen = JSON.parse(readFileSync(out, "utf8")) as Omit<Probe, "stderr">;
  return { ...seen, stderr };
}

/** True when `file` is `dir` or lies inside it. */
const inside = (file: string, dir: string): boolean =>
  realpathSync(file) === dir || realpathSync(file).startsWith(dir + sep);

describe("the dynamic import of pi resolves pi's own running instance", () => {
  // Under the repo's own copy: the extensions must see that copy, and
  // ledger-pin's compact() must be the very function the package exports.
  it.skipIf(!nodeModulesPi)(
    "under node_modules' pi CLI, ledger-pin sees that pi",
    async () => {
      const seen = await runProbe(nodeModulesPi!, "node-modules");
      expect(seen.version).toBe(PIN);
      expect(inside(seen.examples, nodeModulesPi!.dir)).toBe(true);
      expect(seen.compactIsPi).toBe(true);
    },
    90_000,
  );

  // The VM: the global CLI is the running pi, node_modules holds a second
  // copy, and the extensions must still land on the running one — or on an
  // identical-version copy, which the version check above makes the same pin.
  it.skipIf(!globalPi || globalPi.dir === nodeModulesPi?.dir)(
    "under the global pi CLI with node_modules' pi present, they see the global one",
    async () => {
      const seen = await runProbe(globalPi!, "global");
      expect(seen.version).toBe(PIN);
      expect(
        inside(seen.examples, globalPi!.dir),
        `getExamplesPath() resolved to ${seen.examples}, not the running pi at ${globalPi!.dir}`,
      ).toBe(true);
      expect(seen.compactIsPi).toBe(true);
    },
    90_000,
  );
});
