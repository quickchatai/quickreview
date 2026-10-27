// The pi plugin as a user gets it: `npm pack` of packages/pi-plugin (its real
// prepack: the build, the byte copy of the data, the sha256 check), installed
// the way pi installs an npm package (no peers: pi supplies its own), added
// to a throwaway pi home with the pinned pi's `pi install`, and loaded by a
// real pi in rpc mode. Offline: the one dependency comes from this checkout's
// node_modules as a tarball, and pi runs with PI_OFFLINE. No model is called.
//
// What it holds (the nesting fence: the plugin alone, with no app):
//   - the tarball has no prompts/, themes/ or extensions/ at its root, so
//     pi's conventional discovery finds nothing but the manifest's one
//     extension and its skills/; the seeds ship under assets/ only;
//   - pi loads exactly the three qcr- commands and a skill of each name, from
//     the installed package, and no prompt template at all;
//   - the installed package carries no pi of its own, and the core finds its
//     data and its extensions inside itself (never a checkout);
//   - /qcr-review --preview runs end to end and answers in the session;
//   - /qcr-scan runs on the plugin's own scan engine with no `qcr` anywhere on
//     PATH: it cuts a fixture repo into units, saves the cut, and prices the
//     scan, each answer in the session.
import { execFileSync, spawn } from "node:child_process";
import { existsSync, mkdirSync, readdirSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { delimiter, join, resolve } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

const ROOT = resolve(import.meta.dirname, "..");
const PLUGIN = join(ROOT, "packages", "pi-plugin");
const PI = join(
  ROOT,
  "node_modules",
  "@earendil-works",
  "pi-coding-agent",
  "dist",
  "bundle",
  "cli.js",
);
const SCRATCH = join(ROOT, "node_modules", ".cache", `pi-plugin-install-${process.pid}`);
const COMMANDS = ["qcr-review", "qcr-scan", "qcr-setup"];
const SKILLS = COMMANDS.map((c) => `skill:${c}`);

let tarball = "";
let installed = "";
const home = join(SCRATCH, "home");
const agentDir = join(home, ".pi", "agent");

const run = (cmd: string, args: string[], cwd: string, env?: NodeJS.ProcessEnv): string =>
  execFileSync(cmd, args, { cwd, encoding: "utf8", env: env ?? process.env, stdio: "pipe" });

/** PATH with every directory that holds a `qcr` dropped: the plugin alone. */
const PATH_WITHOUT_QCR = (process.env.PATH ?? "")
  .split(delimiter)
  .filter((d) => d !== "" && !existsSync(join(d, "qcr")))
  .join(delimiter);

/** The env every pi child gets: a throwaway home, offline, no telemetry, and
 * no QuickReview app on PATH. */
const piEnv = (): NodeJS.ProcessEnv => ({
  PATH: PATH_WITHOUT_QCR,
  HOME: home,
  PI_CODING_AGENT_DIR: agentDir,
  XDG_STATE_HOME: join(home, "state"),
  XDG_CONFIG_HOME: join(home, "config"),
  PI_OFFLINE: "1",
  PI_SKIP_VERSION_CHECK: "1",
  PI_TELEMETRY: "0",
});

/** One pi in rpc mode in `cwd`: send `requests`, collect every line until
 * `done` says so (or the deadline passes). */
async function rpc(
  cwd: string,
  requests: object[],
  done: (lines: Array<Record<string, unknown>>) => boolean,
): Promise<{ lines: Array<Record<string, unknown>>; stderr: string }> {
  const child = spawn(process.execPath, [PI, "--mode", "rpc", "--no-session"], {
    cwd,
    env: piEnv(),
    stdio: ["pipe", "pipe", "pipe"],
  });
  const lines: Array<Record<string, unknown>> = [];
  let stderr = "";
  let buf = "";
  child.stderr.on("data", (d: Buffer) => (stderr += d.toString()));
  child.stdout.on("data", (d: Buffer) => {
    buf += d.toString();
    for (let i = buf.indexOf("\n"); i >= 0; i = buf.indexOf("\n")) {
      const line = buf.slice(0, i).trim();
      buf = buf.slice(i + 1);
      if (line.startsWith("{")) lines.push(JSON.parse(line) as Record<string, unknown>);
    }
  });
  for (const r of requests) child.stdin.write(JSON.stringify(r) + "\n");
  const deadline = Date.now() + 45_000;
  while (!done(lines) && Date.now() < deadline && child.exitCode === null)
    await new Promise((r) => setTimeout(r, 100));
  child.stdin.end();
  child.kill("SIGTERM");
  return { lines, stderr };
}

beforeAll(() => {
  rmSync(SCRATCH, { recursive: true, force: true });
  mkdirSync(join(SCRATCH, "inst"), { recursive: true });
  // the real pack: prepack builds, copies the data and checks it; postpack cleans
  const name = run("npm", ["pack", "--pack-destination", SCRATCH, "--silent"], PLUGIN).trim();
  tarball = join(SCRATCH, name.split("\n").pop()!);
  const toml = run(
    "npm",
    ["pack", join(ROOT, "node_modules", "smol-toml"), "--pack-destination", SCRATCH, "--silent"],
    SCRATCH,
  ).trim();
  writeFileSync(join(SCRATCH, "inst", "package.json"), '{"name":"inst","private":true}\n');
  // as pi installs an npm package: peers left to the host
  run(
    "npm",
    [
      "install",
      join(SCRATCH, toml.split("\n").pop()!),
      tarball,
      "--offline",
      "--legacy-peer-deps",
      "--ignore-scripts",
      "--no-audit",
      "--no-fund",
    ],
    join(SCRATCH, "inst"),
  );
  installed = join(SCRATCH, "inst", "node_modules", "@quickchatai/pi-quickreview");
  mkdirSync(agentDir, { recursive: true });
  run(process.execPath, [PI, "install", installed], SCRATCH, piEnv());
});

afterAll(() => rmSync(SCRATCH, { recursive: true, force: true }));

describe("the packed plugin, installed into a fresh pi", () => {
  // MUTATION: ship prompts/ at the package root — this fails.
  it("carries nothing pi would discover by convention but its skills, and its data under assets/", () => {
    const entries = run("tar", ["tzf", tarball], SCRATCH).trim().split("\n");
    const top = new Set(entries.map((e) => e.split("/")[1]));
    expect([...top].sort()).toEqual([
      "LICENSE",
      "README.md",
      "assets",
      "dist",
      "package.json",
      "skills",
    ]);
    for (const c of COMMANDS) expect(entries).toContain(`package/skills/${c}/SKILL.md`);
    expect(entries).toContain("package/assets/agents/pass-baseline.md");
    expect(entries).toContain("package/assets/seed-manifest.json");
    expect(entries).toContain("package/dist/src/plugin/index.js");
    // the checkout is left as it was: postpack removed the copies
    expect(existsSync(join(PLUGIN, "assets"))).toBe(false);
    expect(existsSync(join(PLUGIN, "LICENSE"))).toBe(false);
  });

  it("brings no pi of its own; the host's is the one it runs on", () => {
    expect(existsSync(join(SCRATCH, "inst", "node_modules", "@earendil-works"))).toBe(false);
    expect(existsSync(join(installed, "node_modules", "@earendil-works"))).toBe(false);
  });

  // The core resolves its data and its extensions inside the installed
  // package, never under a checkout. MUTATION: point extfiles at the repo
  // root's extensions/cli — this fails.
  it("finds its data, its extensions and its pi range inside itself", () => {
    const probe = [
      `import { assetRoot } from ${JSON.stringify(join(installed, "dist/src/assetroot.js"))};`,
      `import { coreExtensionFile, CORE_EXTENSIONS } from ${JSON.stringify(join(installed, "dist/src/engine/extfiles.js"))};`,
      `import { declaredPiRange } from ${JSON.stringify(join(installed, "dist/src/plugin/versiongate.js"))};`,
      `console.log(JSON.stringify({ assets: assetRoot(), range: declaredPiRange(),`,
      `  ext: CORE_EXTENSIONS.map((n) => coreExtensionFile(n)) }));`,
    ].join("\n");
    const out = JSON.parse(
      run(process.execPath, ["--input-type=module", "-e", probe], SCRATCH),
    ) as { assets: string; range: string; ext: string[] };
    const pkg = realpathSync(installed);
    expect(realpathSync(out.assets)).toBe(join(pkg, "assets"));
    expect(out.range).toBe("^1.4.0");
    for (const f of out.ext) {
      expect(realpathSync(f).startsWith(join(pkg, "dist", "extensions") + "/"), f).toBe(true);
    }
  });

  // MUTATION: register "review" beside "qcr-review", or drop a skill from
  // the manifest — this fails.
  it("loads exactly the three commands and a skill of each name from the package, and no prompt", async () => {
    const { lines, stderr } = await rpc(SCRATCH, [{ id: "c", type: "get_commands" }], (l) =>
      l.some((x) => x["id"] === "c"),
    );
    const answer = lines.find((x) => x["id"] === "c") as
      | {
          data: { commands: Array<{ name: string; source: string; sourceInfo: { path: string } }> };
        }
      | undefined;
    expect(answer, stderr).toBeDefined();
    const commands = answer!.data.commands;
    const ours = commands.filter(
      (c) =>
        c.sourceInfo.path.startsWith(realpathSync(installed)) ||
        c.sourceInfo.path.startsWith(installed),
    );
    expect(
      ours
        .filter((c) => c.source === "extension")
        .map((c) => c.name)
        .sort(),
    ).toEqual(COMMANDS);
    expect(
      ours
        .filter((c) => c.source === "skill")
        .map((c) => c.name)
        .sort(),
    ).toEqual(SKILLS);
    expect(commands.filter((c) => c.source !== "extension" && c.source !== "skill")).toEqual([]);
    expect(commands.filter((c) => c.source === "skill" && !ours.includes(c))).toEqual([]);
    expect(
      commands
        .filter((c) => c.source === "extension" && !ours.includes(c))
        .map((c) => c.sourceInfo.path),
    ).toEqual(
      commands
        .filter((c) => c.sourceInfo.path.startsWith("builtin:"))
        .map((c) => c.sourceInfo.path),
    );
  });

  it("answers /qcr-review --preview in the session, offline", async () => {
    const repo = join(SCRATCH, "repo");
    mkdirSync(repo, { recursive: true });
    const git = (...a: string[]): string =>
      run(
        "git",
        ["-c", "user.name=T", "-c", "user.email=t@example.com", "-c", "commit.gpgsign=false", ...a],
        repo,
      );
    git("init", "-q", "-b", "main");
    git("commit", "-q", "--allow-empty", "-m", "root");
    git("checkout", "-q", "-b", "feature");
    writeFileSync(join(repo, "add.ts"), "export const add = (a: number, b: number) => a - b;\n");
    git("add", "-A");
    git("commit", "-q", "-m", "add");
    const { lines, stderr } = await rpc(
      repo,
      [{ id: "p", type: "prompt", message: "/qcr-review --preview" }],
      (l) => l.some((x) => x["id"] === "p"),
    );
    const shown = lines.filter(
      (x) =>
        x["type"] === "message_end" &&
        (x["message"] as { customType?: string }).customType === "qcr-review",
    );
    expect(shown, `${stderr}\n${JSON.stringify(lines).slice(0, 2000)}`).toHaveLength(1);
    const content = (shown[0]!["message"] as { content: string }).content;
    expect(content).toMatch(/Review feature against main/);
    expect(content).toMatch(/price: \$\d+\.\d\d/);
    expect(lines.find((x) => x["id"] === "p")).toMatchObject({ success: true });
    // a preview starts nothing: no run is left under the state home
    const runs = join(home, "state", "qcr", "default", "review", "runs");
    expect(existsSync(runs) ? readdirSync(runs) : []).toEqual([]);
  });

  // The scan is the plugin's own: no `qcr` on PATH, and the cut, the save and
  // the price all answer in the session. MUTATION: send /qcr-scan back to the
  // `qcr scan` subprocess (the plugin before the scan moved into it) — every answer here is
  // then a "needs qcr" refusal, and this fails.
  it("runs /qcr-scan on its own engine, with no qcr on PATH", async () => {
    expect(() => run("sh", ["-c", "command -v qcr"], SCRATCH, piEnv())).toThrow();
    const repo = join(SCRATCH, "scanrepo");
    mkdirSync(join(repo, "app"), { recursive: true });
    mkdirSync(join(repo, "lib"), { recursive: true });
    writeFileSync(join(repo, "app", "a.py"), "def add(a, b):\n    return a - b\n");
    writeFileSync(join(repo, "lib", "b.py"), "X = 1\n");
    writeFileSync(join(repo, "main.py"), "import app\n");
    const git = (...a: string[]): string =>
      run(
        "git",
        ["-c", "user.name=T", "-c", "user.email=t@example.com", "-c", "commit.gpgsign=false", ...a],
        repo,
      );
    git("init", "-q", "-b", "main");
    git("add", "-A");
    git("commit", "-q", "-m", "code");
    const answer = async (line: string): Promise<string> => {
      const { lines, stderr } = await rpc(repo, [{ id: "s", type: "prompt", message: line }], (l) =>
        l.some((x) => x["id"] === "s"),
      );
      const shown = lines.filter(
        (x) =>
          x["type"] === "message_end" &&
          (x["message"] as { customType?: string }).customType === "qcr-review",
      );
      expect(shown, `${line}\n${stderr}\n${JSON.stringify(lines).slice(0, 2000)}`).toHaveLength(1);
      expect(lines.find((x) => x["id"] === "s")).toMatchObject({ success: true });
      return (shown[0]!["message"] as { content: string }).content;
    };
    const proposed = await answer("/qcr-scan units propose");
    expect(proposed).toMatch(/Draft stored:/);
    expect(proposed).toMatch(/- app \[directory\]/);
    expect(proposed).toMatch(/- lib \[directory\]/);
    expect(await answer("/qcr-scan units save")).toMatch(/Unit cut saved:/);
    const priced = await answer("/qcr-scan --preview");
    expect(priced).toMatch(/Scan 3 files/);
    expect(priced).toMatch(/\/qcr-scan start --key/);
    // the cut is saved under this repo's own scan home, and a preview starts nothing
    const repos = join(home, "state", "qcr", "default", "repos");
    const homes = readdirSync(repos);
    expect(homes).toHaveLength(1);
    expect(existsSync(join(repos, homes[0]!, "setup", "unit-cut.json"))).toBe(true);
    expect(existsSync(join(repos, homes[0]!, "scan", "run.json"))).toBe(false);
  });
});
