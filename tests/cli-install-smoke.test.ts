// The `qcr` CLI as a user gets it from npm: both packages packed (the plugin
// with its data copied in, as its prepack does; the CLI with the build this
// checkout already has), installed offline into a scratch prefix the way npm
// installs a package and its dependencies, and the installed `qcr` run with a
// clean environment: node and git on the PATH, a throwaway HOME, no config.
//
// What it holds:
//   - the CLI tarball carries what the app reads at runtime and nothing of the
//     repo's tests, bench, docs, state or rulebook files: of src/bench only the
//     three modules the app imports, and none of the operator-only scripts;
//   - `qcr version --json` and `qcr review --preview --json` work on the
//     shipped defaults, with no config and no login;
//   - nothing is written inside the install: every file the runs keep lands
//     under the throwaway HOME.
//
// Offline: every dependency comes from the local npm cache (the one this
// checkout's own install filled). A cache that lacks them skips the install
// cases with the reason, as do pnpm and bun when they are not on this machine.
// Needs `npm run build` (the CLI is packed from dist/ as it is).
import { execFileSync, spawnSync } from "node:child_process";
import {
  cpSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { dirname, join, resolve } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  REVIEW_SCHEMA_VERSION,
  VERSION_SCHEMA_VERSION,
} from "@quickchatai/pi-quickreview/src/contract.js";
import { copyAssets } from "../scripts/plugin-assets.mjs";

const ROOT = resolve(import.meta.dirname, "..");
const PLUGIN = join(ROOT, "packages", "pi-plugin");
const BUILT =
  existsSync(join(ROOT, "dist", "src", "qcrbin.js")) &&
  existsSync(join(PLUGIN, "dist", "src", "plugin", "index.js"));
const SCRATCH = join(ROOT, "node_modules", ".cache", `cli-install-smoke-${process.pid}`);
const ROOT_PKG = JSON.parse(readFileSync(join(ROOT, "package.json"), "utf8")) as {
  version: string;
  files: string[];
  dependencies: Record<string, string>;
  qcrPi: { package: string; version: string };
};

const run = (cmd: string, args: string[], cwd: string, env?: NodeJS.ProcessEnv): string =>
  execFileSync(cmd, args, { cwd, encoding: "utf8", env: env ?? process.env, stdio: "pipe" });

const has = (cmd: string): boolean =>
  spawnSync("sh", ["-c", `command -v ${cmd}`], { stdio: "ignore" }).status === 0;

let cliTarball = "";
let pluginTarball = "";
let entries: string[] = [];
let prefix = "";
let installError: string | null = null;
const home = join(SCRATCH, "home");

/** Every path under `dir` with its kind, size and mtime: what "nothing was
 * written" is checked against. */
function snapshot(dir: string): Map<string, string> {
  const out = new Map<string, string>();
  const walk = (d: string): void => {
    for (const name of readdirSync(d)) {
      const p = join(d, name);
      const st = lstatSync(p);
      out.set(
        p,
        `${st.isDirectory() ? "d" : st.isSymbolicLink() ? "l" : "f"}:${st.size}:${st.mtimeMs}`,
      );
      if (st.isDirectory()) walk(p);
    }
  };
  walk(dir);
  return out;
}

/** The clean environment the installed qcr runs in. */
function cleanEnv(): NodeJS.ProcessEnv {
  const git = run("sh", ["-c", "command -v git"], ROOT).trim();
  return {
    PATH: [dirname(process.execPath), dirname(git), "/usr/bin", "/bin"].join(":"),
    HOME: home,
  };
}

function fixtureRepo(): string {
  const repo = join(SCRATCH, "repo");
  mkdirSync(join(repo, "src"), { recursive: true });
  const git = (...a: string[]): string =>
    run(
      "git",
      ["-c", "user.name=T", "-c", "user.email=t@example.com", "-c", "commit.gpgsign=false", ...a],
      repo,
    );
  git("init", "-q", "-b", "main");
  writeFileSync(join(repo, "src", "a.ts"), "export const a = 1;\n");
  git("add", "-A");
  git("commit", "-q", "-m", "base");
  git("checkout", "-q", "-b", "feature");
  writeFileSync(join(repo, "src", "a.ts"), "export const a = 1;\nexport const b = 2;\n");
  git("commit", "-q", "-am", "add b");
  return repo;
}

/** The last JSON object a run printed. */
const lastJson = (stdout: string): Record<string, unknown> =>
  JSON.parse(
    stdout
      .trim()
      .split("\n")
      .filter((l) => l.startsWith("{"))
      .at(-1) ?? "null",
  ) as Record<string, unknown>;

beforeAll(() => {
  if (!BUILT) return;
  rmSync(SCRATCH, { recursive: true, force: true });
  mkdirSync(home, { recursive: true });
  // The plugin, packed from a scratch copy with its data copied in (what its
  // prepack does), so a pack running beside this one never shares its assets/.
  const plugin = join(SCRATCH, "plugin");
  mkdirSync(plugin, { recursive: true });
  for (const f of ["package.json", "README.md", "dist"])
    cpSync(join(PLUGIN, f), join(plugin, f), { recursive: true });
  copyAssets(ROOT, plugin);
  pluginTarball = join(
    SCRATCH,
    run("npm", ["pack", "--ignore-scripts", "--pack-destination", SCRATCH, "--silent"], plugin)
      .trim()
      .split("\n")
      .pop()!,
  );
  // The CLI, from this checkout's build as it stands.
  cliTarball = join(
    SCRATCH,
    run("npm", ["pack", "--ignore-scripts", "--pack-destination", SCRATCH, "--silent"], ROOT)
      .trim()
      .split("\n")
      .pop()!,
  );
  entries = run("tar", ["tzf", cliTarball], SCRATCH).trim().split("\n");
  // The install: the CLI and the plugin it depends on, every other dependency
  // from the local npm cache, no network, no install scripts. In a global
  // install the CLI is the root of its own tree, so its exact pi pins are what
  // the plugin's pi peers resolve to; a scratch project holding both tarballs
  // side by side has no such root, and npm would resolve those peers to the
  // newest pi in range. The project therefore names pi at the CLI's own pins.
  const piPins = Object.entries(ROOT_PKG.dependencies)
    .filter(([name]) => name.startsWith("@earendil-works/"))
    .map(([name, version]) => `${name}@${version}`);
  for (const peer of ["@earendil-works/pi-agent-core", "@earendil-works/pi-tui"])
    if (!piPins.some((p) => p.startsWith(`${peer}@`)))
      piPins.push(`${peer}@${ROOT_PKG.qcrPi.version}`);
  prefix = join(SCRATCH, "prefix");
  mkdirSync(prefix, { recursive: true });
  writeFileSync(join(prefix, "package.json"), '{"name":"prefix","private":true}\n');
  const cache = run("npm", ["config", "get", "cache"], ROOT).trim();
  try {
    run(
      "npm",
      [
        "install",
        cliTarball,
        pluginTarball,
        ...piPins,
        "--offline",
        "--cache",
        cache,
        "--ignore-scripts",
        "--no-audit",
        "--no-fund",
      ],
      prefix,
    );
  } catch (err) {
    const e = err as { stderr?: string; message?: string };
    installError = (e.stderr || e.message || String(err)).slice(0, 600);
  }
});

afterAll(() => rmSync(SCRATCH, { recursive: true, force: true }));

describe.skipIf(!BUILT)("the packed CLI (needs `npm run build`)", () => {
  // Every directory the `files` list negates (the private profile, the
  // operator-only rehearsals) stays out of the tarball.
  const EXCLUDED_DIRS = ROOT_PKG.files
    .filter((f) => f.startsWith("!") && f.endsWith("/"))
    .map((f) => f.slice(1));
  // The bench modules the app itself imports; the rest of the bench stays home.
  const BENCH_KEPT = ["cost", "exec", "values"];
  const benchKept = (e: string): boolean =>
    BENCH_KEPT.some(
      (m) => e === `package/src/bench/${m}.ts` || e === `package/dist/src/bench/${m}.js`,
    );
  // Operator-only scripts, named here rather than read off `files`, so dropping
  // a negation there fails this test.
  const OPERATOR_SCRIPTS = [
    "cutover.sh",
    "cutover-rehearsal.sh",
    "worker-rehearsal.sh",
    "worker-resume-rehearsal.sh",
    "vm-postcutover-cleanup.sh",
  ];
  const SHIPPED_FIXTURES = [
    "package/tests/fixtures/seed-manifest.json",
    "package/tests/fixtures/regression-cases.json",
  ];
  // MUTATION: drop the `files` allowlist — tests/, bench/ and docs/ ship.
  it("carries what the app reads at runtime, and none of the repo's tests, bench, docs or state", () => {
    for (const want of [
      "package/package.json",
      "package/bin/qcr.js",
      "package/dist/src/qcrbin.js",
      "package/dist/src/cli.js",
      "package/extensions/cli/bash-guard.ts",
      "package/config.example.toml",
      ...SHIPPED_FIXTURES,
      ...BENCH_KEPT.map((m) => `package/dist/src/bench/${m}.js`),
    ])
      expect(entries, want).toContain(want);
    const bad = entries.filter(
      (e) =>
        (e.startsWith("package/tests/") && !SHIPPED_FIXTURES.includes(e)) ||
        // MUTATION: drop "!src/bench/**" from `files` — the bench sources ship and this fails.
        (/^package\/(dist\/)?src\/bench\//.test(e) && !benchKept(e)) ||
        OPERATOR_SCRIPTS.some((f) => e === `package/scripts/${f}`) ||
        /^package\/(bench|docs|state|wt|verdict|inject|digest|archive|commands|packages)\//.test(
          e,
        ) ||
        EXCLUDED_DIRS.some((d) => e.startsWith(`package/${d}`)) ||
        /(^|\/)(CLAUDE|AGENTS)\.md$/.test(e) ||
        e.endsWith(".tsbuildinfo") ||
        /(^|\/)config\.toml$/.test(e) ||
        /(^|\/)secrets\//.test(e),
    );
    expect(bad).toEqual([]);
  });

  it("depends on the plugin at its own version and on pi at the exact pins", () => {
    const pkg = JSON.parse(run("tar", ["xzOf", cliTarball, "package/package.json"], SCRATCH)) as {
      private: boolean;
      bin: Record<string, string>;
      dependencies: Record<string, string>;
    };
    expect(pkg.private).toBe(false);
    expect(pkg.bin).toEqual({ qcr: "bin/qcr.js" });
    expect(pkg.dependencies["@quickchatai/pi-quickreview"]).toBe(ROOT_PKG.version);
    expect(pkg.dependencies[ROOT_PKG.qcrPi.package]).toBe(ROOT_PKG.qcrPi.version);
  });
});

describe.skipIf(!BUILT)("the installed qcr, offline, with no config", () => {
  it("answers qcr version --json and qcr review --preview --json, and writes nothing in the install", (ctx) => {
    if (installError !== null)
      ctx.skip(`the offline install could not complete from the local npm cache: ${installError}`);
    const qcr = join(prefix, "node_modules", ".bin", "qcr");
    const before = snapshot(prefix);
    const env = cleanEnv();

    const v = spawnSync(qcr, ["version", "--json"], { cwd: home, env, encoding: "utf8" });
    expect(v.status, v.stderr).toBe(0);
    const info = lastJson(v.stdout) as {
      schema_version: number;
      image: { version: string };
      pi: { package: string; version: string } | null;
    };
    expect(info.schema_version).toBe(VERSION_SCHEMA_VERSION);
    expect(info.image.version).toBe(ROOT_PKG.version);
    expect(info.pi).toEqual(ROOT_PKG.qcrPi);

    const repo = fixtureRepo();
    const r = spawnSync(qcr, ["review", "--preview", "--json", "--base", "main"], {
      cwd: repo,
      env,
      encoding: "utf8",
    });
    expect(r.status, `${r.stdout}\n${r.stderr}`).toBe(0);
    const data = lastJson(r.stdout);
    expect(data["schema_version"]).toBe(REVIEW_SCHEMA_VERSION);
    expect(data["ok"], r.stdout).toBe(true);

    // MUTATION: keep the review's runs under the package root — this fails.
    expect([...snapshot(prefix).entries()].filter(([p, s]) => before.get(p) !== s)).toEqual([]);
    expect([...before.keys()].filter((p) => !existsSync(p))).toEqual([]);
  });
});

for (const pm of ["pnpm", "bun"] as const) {
  describe.skipIf(!BUILT)(`the CLI installed with ${pm}`, () => {
    it(`installs offline and answers qcr version --json`, (ctx) => {
      if (!has(pm)) ctx.skip(`${pm} is not on this machine`);
      // bun has no install that refuses the network: run it only where asked to
      if (pm === "bun" && process.env["QCR_SMOKE_BUN"] !== "1")
        ctx.skip("bun cannot install strictly offline; QCR_SMOKE_BUN=1 runs it anyway");
      const dir = join(SCRATCH, `prefix-${pm}`);
      mkdirSync(dir, { recursive: true });
      writeFileSync(join(dir, "package.json"), `{"name":"prefix-${pm}","private":true}\n`);
      const args =
        pm === "pnpm"
          ? ["add", cliTarball, pluginTarball, "--offline", "--ignore-scripts"]
          : ["add", cliTarball, pluginTarball, "--prefer-offline", "--ignore-scripts"];
      const inst = spawnSync(pm, args, { cwd: dir, encoding: "utf8" });
      if (inst.status !== 0)
        ctx.skip(
          `${pm} could not install offline here: ${(inst.stderr || inst.stdout).slice(0, 400)}`,
        );
      const before = snapshot(dir);
      const v = spawnSync(join(dir, "node_modules", ".bin", "qcr"), ["version", "--json"], {
        cwd: home,
        env: cleanEnv(),
        encoding: "utf8",
      });
      expect(v.status, v.stderr).toBe(0);
      expect((lastJson(v.stdout) as { image: { version: string } }).image.version).toBe(
        ROOT_PKG.version,
      );
      expect([...snapshot(dir).entries()].filter(([p, s]) => before.get(p) !== s)).toEqual([]);
    });
  });
}
