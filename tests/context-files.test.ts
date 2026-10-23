// Context-file inventory: which context file each pi session loads TODAY, per
// route, recorded in tests/fixtures/context-files/inventory.json.
//
// pi loads the first of AGENTS.override.md / AGENTS.md / CLAUDE.md from its
// agentDir and from its cwd and every ancestor of the cwd, into every session
// and every lens pass (helpers/context-files.ts models pi 1.3.0's loader). So
// the route's argv (`--no-context-files`), cwd, ancestors and agentDir decide
// what rides each turn. The routes differ on purpose: the VM bot, the bench
// image, the clone route (from the run's own dir outside the checkout, D34)
// and their lenses load the reviewer stub; the companion loads the full
// AGENTS.md; the bench judge, the onboarding session and the scan leaves
// (-nc, on the host and in the container alike) load nothing.
//
// Each row is OBSERVED, not copied: the cwd, the argv and the agentDir come
// from a fake-pi run of the route's own code (or, where the route is a deploy
// artifact — the VM entrypoint, the bench Dockerfile — from that artifact's
// text), and the effective set is computed from them. The table is then
// compared with the committed fixture, so a change to any route's argv, cwd,
// ancestors or agentDir that moves its context file fails here. P0.4, P1.1,
// P2.8, P4.3, P6.4/P6.5 and the canary parity checks (P5.2, P8.2) assert
// against the same table (`inventoryRow`).
//
// No route may write a context file into a repo checkout. The VM's synced
// deploy tree is the one install site; after a fake-pi run of each route the
// qcr checkout and the reviewed repo are byte-unchanged.
//
// A deliberate change updates the fixture in the same commit:
// `UPDATE_CONTEXT_FILES=1 npx vitest run tests/context-files.test.ts`, then
// review the diff.
import { piCliRuntime } from "./helpers/pi-cli-runtime.js";
import { judgePiArgv } from "./helpers/judge-argv.js";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { execFileSync } from "node:child_process";
import { EventEmitter } from "node:events";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  realpathSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, isAbsolute, join, resolve } from "node:path";
import { PassThrough } from "node:stream";
import { fauxProvider } from "@earendil-works/pi-ai";
import { COMPANION_AGENTS_DIR } from "../extensions/setup.js";
import { COMPANION_DEFAULTS, resolveCompanionPaths, sandboxRoot } from "../src/config.js";
import { PiHost } from "../src/engine/pisdk.js";
import { stateHome } from "../src/install.js";
import { onboardingPiArgv } from "../src/onboard/launch.js";
import { SCANBOX, scanRunArgv, type ScanBoxPlan } from "../src/scanbox.js";
import { PiSessionManager } from "../src/sessions.js";
import { piCaseRunner, type SpawnFn } from "../src/setup/caserunner.js";
import type { ExecFn } from "../src/tmux.js";
import { Tmux } from "../src/tmux.js";
import { CompanionLifecycle, CONTAINER } from "../src/tui/companion.js";
import {
  CONTEXT_CANDIDATES,
  INVENTORY_PATH,
  ancestorsWithContext,
  contextFlagOf,
  effectiveContextFiles,
  readInventory,
  type ContextFlag,
  type ContextFs,
  type Inventory,
  type InventoryRow,
} from "./helpers/context-files.js";

vi.stubEnv("QCR_CONFIG", join(import.meta.dirname, "fixtures", "config.toml"));

const { runReviewCli } = await import("../src/reviewcli.js");
const { runOneShot } = await import("../src/oneshot.js");
const { benchConfig, buildBenchAgents, contextFor } = await import("../src/bench/runner.js");
const { ecosystemFor } = await import("../src/ecosystem.js");

const ROOT = realpathSync(resolve(import.meta.dirname, ".."));
const UPDATE = process.env.UPDATE_CONTEXT_FILES === "1";
const STUB = "deploy/reviewer/AGENTS.override.md";
/** The virtual directory standing for "whichever qcr checkout the route runs from". */
const CHECKOUT = "/qcr-checkout";

const tmp = mkdtempSync(join(tmpdir(), "context-files-"));
afterAll(() => {
  rmSync(tmp, { recursive: true, force: true });
  vi.unstubAllEnvs();
});

const read = (p: string): string => readFileSync(join(ROOT, p), "utf8");
const isFile = (p: string): boolean => existsSync(p) && statSync(p).isFile();

// ---- virtual trees, derived from the artifacts that build them ------------------

/** The context files the qcr checkout carries, placed at `dir`. */
function checkoutFs(dir: string, exclude: readonly string[] = []): ContextFs {
  const fs: ContextFs = new Map();
  for (const name of CONTEXT_CANDIDATES)
    if (isFile(join(ROOT, name)) && !exclude.includes(name)) fs.set(join(dir, name), name);
  return fs;
}

/**
 * What an entrypoint installs into the sandbox root: the `install` lines that
 * copy a file named AGENTS.override.md (or any context file) out of the deploy
 * tree. Returns [source, destination relative to $SANDBOX] pairs.
 */
function entrypointInstalls(entrypoint: string): Array<[string, string]> {
  const out: Array<[string, string]> = [];
  for (const m of entrypoint.matchAll(
    /^\s*install\b[^\n"]*"\$SANDBOX\/([^"]+)"\s+"\$SANDBOX\/([^"]+)"/gm,
  )) {
    if (CONTEXT_CANDIDATES.includes(basename(m[2]!))) out.push([m[1]!, m[2]!]);
  }
  return out;
}

/** The context files a Dockerfile's COPY lines place, as absolute path → source. */
function dockerfileContext(dockerfile: string): ContextFs {
  const fs: ContextFs = new Map();
  let workdir = "/";
  for (const line of dockerfile.split("\n")) {
    const w = /^WORKDIR\s+(\S+)/.exec(line);
    if (w) {
      workdir = isAbsolute(w[1]!) ? w[1]! : join(workdir, w[1]!);
      continue;
    }
    const c = /^COPY\s+(?:--\S+\s+)*(.+)$/.exec(line);
    if (!c) continue;
    const parts = c[1]!.trim().split(/\s+/);
    const dest = parts.pop()!;
    const absDest = isAbsolute(dest) ? dest : join(workdir, dest);
    for (const src of parts) {
      if (!CONTEXT_CANDIDATES.includes(basename(src))) continue;
      const at = dest.endsWith("/") ? join(absDest, basename(src)) : absDest;
      fs.set(at, src);
    }
  }
  return fs;
}

function mustMatch(text: string, re: RegExp, what: string): string {
  const m = re.exec(text);
  if (!m) throw new Error(`${what}: not found`);
  return m[1]!;
}

// ---- observation: one fake-pi run per route ------------------------------------

interface Probe {
  cwd: string;
  agentDir: string;
  argv: string[];
  /** The entries of the agentDir while pi ran. */
  agentEntries: string[];
}

/** A fake pi that records its cwd, its agentDir env and its argv, then writes
 * the files a review round must leave so the run completes. */
function recordingPi(name: string, outputs: boolean): { bin: string; probe: () => Probe } {
  const rec = join(tmp, `${name}.rec`);
  const bin = join(tmp, `${name}-pi`);
  const record = JSON.stringify({ findings: [], verdict: "APPROVE" });
  const outcome = JSON.stringify({ verdict: "APPROVE", passes: [] });
  writeFileSync(
    bin,
    [
      "#!/bin/sh",
      "cat > /dev/null",
      `pwd -P > ${JSON.stringify(rec + ".cwd")}`,
      `printf '%s' "$PI_CODING_AGENT_DIR" > ${JSON.stringify(rec + ".agent")}`,
      `ls -A "$PI_CODING_AGENT_DIR" > ${JSON.stringify(rec + ".agentls")} 2>/dev/null || :`,
      `: > ${JSON.stringify(rec + ".argv")}`,
      `for a in "$@"; do printf '%s\\n' "$a" >> ${JSON.stringify(rec + ".argv")}; done`,
      'sd=""; prev=""; for a in "$@"; do [ "$prev" = "--session-dir" ] && sd="$a"; prev="$a"; done',
      'mkdir -p "$sd"; echo \'{"type":"session"}\' > "$sd/s.jsonl"; cd="$(dirname "$sd")"',
      `echo '{"type":"message_end","message":{"role":"assistant","usage":{"input":1,"output":1,"cost":{"total":0.01}}}}'`,
      ...(outputs
        ? [
            `printf '%s' ${JSON.stringify(record)} > "$cd/findings-record.json"`,
            `printf '%s' ${JSON.stringify(outcome)} > "$cd/outcome.json"`,
          ]
        : []),
      "",
    ].join("\n"),
  );
  chmodSync(bin, 0o755);
  return {
    bin,
    probe: () => ({
      cwd: readFileSync(rec + ".cwd", "utf8").trim(),
      agentDir: readFileSync(rec + ".agent", "utf8"),
      argv: readFileSync(rec + ".argv", "utf8")
        .split("\n")
        .filter(Boolean),
      agentEntries: existsSync(rec + ".agentls")
        ? readFileSync(rec + ".agentls", "utf8")
            .split("\n")
            .filter(Boolean)
        : [],
    }),
  };
}

const git = (cwd: string, ...args: string[]): string =>
  execFileSync(
    "git",
    ["-c", "user.name=T", "-c", "user.email=t@example.com", "-c", "commit.gpgsign=false", ...args],
    { cwd, encoding: "utf8" },
  ).trim();

/** A scratch repo under review: main with one file, `feature` adding two lines. */
function mkReviewedRepo(): string {
  const repo = join(tmp, "reviewed-repo");
  mkdirSync(join(repo, "src"), { recursive: true });
  git(repo, "init", "-q", "-b", "main");
  writeFileSync(join(repo, "src", "a.ts"), "export const a = 1;\n");
  git(repo, "add", "-A");
  git(repo, "commit", "-q", "-m", "base");
  git(repo, "checkout", "-q", "-b", "feature");
  writeFileSync(
    join(repo, "src", "a.ts"),
    "export const a = 1;\nexport const b = 2;\nexport const c = 3;\n",
  );
  git(repo, "commit", "-q", "-am", "add b and c");
  writeFileSync(join(repo, ".git", "qcr-review.json"), JSON.stringify({ auto_limit_usd: 1000 }));
  return repo;
}

/** A production-shaped root for runs that must not touch the checkout: every
 * top-level entry symlinked except the ones a run writes. */
function mkScratchRoot(name: string): string {
  const root = join(tmp, name);
  mkdirSync(root);
  for (const e of readdirSync(ROOT))
    if (![".git", "wt", "state", ".pi"].includes(e)) symlinkSync(join(ROOT, e), join(root, e));
  return root;
}

/** The tmux half of the VM bot and the docker daemon: PiSessionManager.spawnSession
 * through a fake exec. Both deploy shapes run this one code. */
async function captureTmuxSession(): Promise<{
  cwd: string;
  root: string;
  paneEnv: string[];
  argv: string[];
}> {
  const root = join(tmp, "daemon-root");
  mkdirSync(root);
  let newSession: string[] = [];
  const exec: ExecFn = async (cmd, args) => {
    if (cmd === "tmux" && args[0] === "new-session") newSession = args;
    return { code: 0, stdout: "", stderr: "" };
  };
  const manager = new PiSessionManager({
    cfg: {
      models: { default: "m", conversation: "m", overseer: "m", passes: {} },
      pi: {
        package: "@earendil-works/pi-coding-agent",
        version: "1.3.0",
        session_dir: "state/pi-sessions",
      },
      engine: {
        runtime: "sdk",
        lens_max_concurrency: 6,
        lens_cache_group: 5,
        lens_cache_stagger_ms: 2500,
        lens_pass_deadline_min: 8,
      },
      github: { repo: "o/n", secrets_dir: join(root, "secrets") },
      openviking: { host: "127.0.0.1", port: 1933, config_file: join(root, "ov.conf") },
    } as never,
    root,
    tmux: new Tmux({ exec }),
    piHome: join(root, "pihome"),
  });
  // A session name outside the daemon's two kinds: no readiness wait, same spawn.
  await manager.spawnSession("context-probe", "system prompt", "m");
  const at = newSession.indexOf("-c");
  const command = newSession.slice(at + 2);
  const bin = command.indexOf("pi");
  return {
    cwd: newSession[at + 1]!,
    root,
    paneEnv: command.slice(1, bin),
    argv: command.slice(bin),
  };
}

async function runOneShotProbe(root: string, agentDir: string): Promise<Probe> {
  const pi = recordingPi(`oneshot-${basename(root)}`, true);
  const tree = join(tmp, `tree-${basename(root)}`);
  mkdirSync(join(tree, "src"), { recursive: true });
  writeFileSync(join(tree, "src", "a.ts"), "export const a = 1;\nexport const b = 2;\n");
  await runOneShot({
    root,
    agentDir,
    tree,
    files: [{ filename: "src/a.ts", additions: 1, deletions: 0, status: "modified" }] as never,
    target: {
      repo: "example-org/example-app",
      number: 7,
      title: "Add b",
      body: null,
      headSha: "a".repeat(40),
      baseRef: "main",
      baseSha: "b".repeat(40),
      mergeBase: "b".repeat(40),
    },
    outDir: join(tmp, `out-${basename(root)}`),
    cfg: benchConfig(""),
    ecosystem: ecosystemFor("none"),
    timeoutMs: 60_000,
    runtime: piCliRuntime({ bin: pi.bin }),
  });
  return pi.probe();
}

async function captureReviewCli(
  repo: string,
): Promise<Probe & { root: string; runsDir: string; operatorAgent: string }> {
  const pi = recordingPi("review-cli", true);
  const ctx = contextFor(sandboxRoot(), "");
  // The operator's own pi home: a login, its context file and an extension,
  // none of which may reach the run.
  const agentDir = join(tmp, "operator-agent");
  mkdirSync(join(agentDir, "extensions"), { recursive: true });
  writeFileSync(
    join(agentDir, "auth.json"),
    JSON.stringify({ openai: { type: "api_key", key: "k" } }),
  );
  writeFileSync(join(agentDir, "AGENTS.md"), "the operator's own guide\n");
  writeFileSync(join(agentDir, "extensions", "own.ts"), "export default () => {};\n");
  const runsDir = join(tmp, "review-runs");
  const lines: string[] = [];
  const code = await runReviewCli([], true, {
    cwd: repo,
    out: (l: string) => lines.push(l),
    confirm: null,
    root: sandboxRoot(),
    agentDir,
    cfg: ctx.cfg,
    ecosystem: ctx.ecosystem,
    runtime: piCliRuntime({ bin: pi.bin }),
    runsDir,
    dryrunDir: join(tmp, "review-dryrun"),
    timeoutMs: 60_000,
  });
  if (code !== 0) throw new Error(`the fake-pi review failed (exit ${code}): ${lines.join(" ")}`);
  return { ...pi.probe(), root: sandboxRoot(), runsDir, operatorAgent: agentDir };
}

/** The context files an SDK session's system prompt carries, as pi renders them. */
function projectInstructions(systemPrompt: string): Array<{ path: string; content: string }> {
  return [
    ...systemPrompt.matchAll(
      /<project_instructions path="([^"]*)">\n([\s\S]*?)\n?<\/project_instructions>/g,
    ),
  ].map((m) => ({ path: m[1]!, content: m[2]! }));
}

/** The SDK host as `qcr review` builds it (P2.8, D34): a run dir outside every
 * checkout, the stub handed over as data at <out>/AGENTS.override.md and never
 * written, and every lookalike a discovery would find planted around it. */
async function captureSdkSessions(): Promise<{
  out: string;
  agent: string;
  main: Array<{ path: string; content: string }>;
  lens: Array<{ path: string; content: string }>;
  outEntries: string[];
}> {
  const run = join(tmp, "sdk-run");
  const out = join(run, "out");
  const agent = join(run, "agent");
  mkdirSync(out, { recursive: true });
  mkdirSync(agent, { recursive: true });
  for (const dir of [run, out, agent]) writeFileSync(join(dir, "AGENTS.md"), `DECOY in ${dir}\n`);
  const faux = fauxProvider();
  const host = await PiHost.create({
    agentDir: agent,
    agentsFiles: [{ path: join(out, "AGENTS.override.md"), content: read(STUB) }],
    configureModels: (rt) => rt.registerNativeProvider(faux.provider),
  });
  try {
    const make = () =>
      host.makeSession({ cwd: out, env: {}, model: faux.getModel(), tools: [], systemPrompt: "S" });
    const main = projectInstructions((await make()).systemPrompt);
    const lens = projectInstructions((await make()).systemPrompt);
    return { out, agent, main, lens, outEntries: readdirSync(out).sort() };
  } finally {
    host.dispose();
  }
}

async function captureScanLeaf(cwd: string): Promise<{ cwd: string; argv: string[] }> {
  let seen: { cwd: string; argv: string[] } | undefined;
  const spawn: SpawnFn = (_command, args, opts) => {
    seen = { cwd: opts.cwd, argv: args };
    const child = new EventEmitter() as EventEmitter & ReturnType<SpawnFn>;
    Object.assign(child, {
      stdout: new PassThrough(),
      stderr: new PassThrough(),
      kill: () => true,
    });
    setTimeout(() => child.emit("close", 1), 0);
    return child;
  };
  await piCaseRunner({
    agentsDir: COMPANION_AGENTS_DIR,
    cwd,
    spawn,
    invocation: { command: "pi", prefix: [] },
  }).run(
    { id: "c", unit: "u", agent: "pass-survey", files: [], prompt: "p" },
    new AbortController().signal,
  );
  if (!seen) throw new Error("the case runner never spawned pi");
  return seen;
}

/** A virtual path for a captured real one: the route's deploy artifact says
 * where that real directory sits in production. */
function at(real: string, realBase: string, virtualBase: string): string {
  if (real !== realBase) throw new Error(`cwd ${real} is not the route's root ${realBase}`);
  return virtualBase;
}

const row = (
  fs: ContextFs,
  o: { cwd: string; agentDir: string; argv: readonly string[]; note?: string },
): InventoryRow => {
  const contextFiles: ContextFlag = contextFlagOf(o.argv);
  return {
    cwd: o.cwd,
    agentDir: o.agentDir,
    contextFiles,
    effective: effectiveContextFiles(fs, { cwd: o.cwd, agentDir: o.agentDir, contextFiles }),
    ...(o.note ? { note: o.note } : {}),
  };
};

const LENS_NOTE =
  "A lens session runs in its parent's cwd with the parent's environment, so it loads what the parent loads.";

/** Every route's observed row, filled in beforeAll. */
const observed: Inventory = { pi: "1.3.0", routes: {} };
/** Every fake-pi run, so the no-writes test knows what ran. */
const ran: string[] = [];
let reviewedRepo: string;
let before: { root: string; repo: string };

/** `git status --porcelain` of a checkout, minus what a clone-route bench writes
 * on purpose and the build ignores. */
function snapshot(dir: string): string {
  const status = git(dir, "status", "--porcelain")
    .split("\n")
    .filter((l) => !l.endsWith(".pi/agents/"));
  const named = CONTEXT_CANDIDATES.filter((n) => existsSync(join(dir, n)));
  return JSON.stringify({ status, named });
}

beforeAll(async () => {
  reviewedRepo = mkReviewedRepo();
  before = { root: snapshot(ROOT), repo: snapshot(reviewedRepo) };

  const updater = read("deploy/qcr-update.sh");
  const benchDockerfile = read("bench/aacr/Dockerfile");
  const companionDockerfile = read("docker/companion/Dockerfile");
  const releaseDockerfile = read("docker/Dockerfile");

  // -- the tmux-hosted bot: the VM (the release image in daemon mode)
  const tmuxRun = await captureTmuxSession();
  ran.push("vm-bot");
  const vmRoot = [...releaseDockerfile.matchAll(/^WORKDIR\s+(\S+)/gm)].pop()![1]!;
  expect(vmRoot).toBe("/opt/qcr");
  // tmux panes inherit the tmux server's environment, so what the pane's pi
  // sees as HOME / agentDir is the container's, unless the spawn pushes one.
  expect(tmuxRun.paneEnv.filter((e) => /^(HOME|PI_CODING_AGENT_DIR)=/.test(e))).toEqual([]);
  // The VM container runs as any uid under the image's fixed HOME; the pihome
  // volume is mounted over its .pi (qcr-update.sh: …/pihome:/home/qcr/.pi).
  const vmHome = mustMatch(releaseDockerfile, /^ENV HOME=(\S+)/m, "release HOME");
  const vmAgentDir = join(vmHome, ".pi", "agent");
  expect(updater).toContain(`:${vmHome}/.pi"`);
  // The playbook's app root is the image's: the cwd the engine and the tmux
  // panes start from.
  expect(
    mustMatch(read("deploy/ansible/group_vars/all.yml"), /^app_root:\s*(\S+)/m, "app_root"),
  ).toBe(vmRoot);

  // The VM tree is the release image (the stub COPY'd into the app dir, which
  // the daemon mode only re-installs if it is missing).
  const vmFs = dockerfileContext(releaseDockerfile);

  observed.routes["vm-bot"] = row(vmFs, {
    cwd: at(tmuxRun.cwd, tmuxRun.root, vmRoot),
    agentDir: vmAgentDir,
    argv: tmuxRun.argv,
    note: "The reviewer stub, baked into the release image's app dir (docker/Dockerfile) and re-installed 0444 by the daemon mode if missing; the dev build's rsync keeps its own anchored exclude.",
  });
  observed.routes["vm-lens"] = { ...observed.routes["vm-bot"], note: LENS_NOTE };

  // -- bench: the same one-shot runner, in the image's tree -----------------------
  const benchRoot = mustMatch(
    benchDockerfile,
    /^WORKDIR\s+(\/opt\/quickreview\/sandbox)$/m,
    "bench WORKDIR",
  );
  const benchAgentDir = mustMatch(benchDockerfile, /PI_CODING_AGENT_DIR=(\S+)/, "bench agentDir");
  const scratch = mkScratchRoot("bench-root");
  expect(buildBenchAgents(scratch, benchConfig(""))).toBeGreaterThan(0);
  const benchRun = await runOneShotProbe(scratch, benchAgentDir);
  ran.push("bench");
  expect(benchRun.agentDir).toBe(benchAgentDir);
  observed.routes["bench"] = row(dockerfileContext(benchDockerfile), {
    cwd: at(benchRun.cwd, realpathSync(scratch), benchRoot),
    agentDir: benchRun.agentDir,
    argv: benchRun.argv,
    note: "The same stub as production, copied into the image's cwd (bench/aacr/Dockerfile).",
  });
  observed.routes["bench-lens"] = { ...observed.routes["bench"], note: LENS_NOTE };

  // -- the release image: the stub baked into the app dir that is the cwd -------
  const releaseRoot = [...releaseDockerfile.matchAll(/^WORKDIR\s+(\S+)/gm)].pop()![1]!;
  const releaseHome = mustMatch(releaseDockerfile, /^ENV HOME=(\S+)/m, "release HOME");
  expect(releaseRoot).toBe("/opt/qcr");
  observed.routes["release-image"] = row(dockerfileContext(releaseDockerfile), {
    cwd: releaseRoot,
    agentDir: join(releaseHome, ".pi", "agent"),
    argv: ["pi"],
    note: "The reviewer stub baked at the image's app dir (docker/Dockerfile), root-owned and read-only; the agentDir sits under the fixed HOME and holds no context file. A route that gives pi its own cwd (the clone route's out dir) gets its own copy of the stub.",
  });
  observed.routes["release-image-lens"] = {
    ...observed.routes["release-image"],
    note: LENS_NOTE,
  };

  // -- the bench judge and the onboarding session: nothing -----------------------
  const judgeArgv = judgePiArgv(ROOT, "m");
  observed.routes["bench-judge"] = row(checkoutFs("/case-tree"), {
    cwd: "/case-tree",
    agentDir: "/tmp/pi-agent",
    argv: judgeArgv,
    note: "Runs in the PR's own checkout, whose AGENTS.md must not reach the judge.",
  });
  observed.routes["onboard"] = row(checkoutFs(CHECKOUT), {
    cwd: CHECKOUT,
    agentDir: "/operator-pi-agent",
    argv: onboardingPiArgv({ package: "@earendil-works/pi-coding-agent", version: "1.3.0" }, ROOT),
  });

  // -- the clone route: `qcr review` from the qcr checkout (D34) -------------------
  // pi runs in the run's own out dir, outside every checkout, holding a copy of
  // the reviewer stub; its agentDir is a private one with no context file.
  const clone = await captureReviewCli(reviewedRepo);
  ran.push("clone-review");
  expect(clone.root).toBe(ROOT);
  expect(read("src/reviewcli.ts")).toMatch(
    /const agentDir =\s*process\.env\["PI_CODING_AGENT_DIR"\]\?\.trim\(\) \|\|\s*join\(process\.env\["HOME"\] \|\| homedir\(\), "\.pi", "agent"\)/,
  );
  expect(read("src/reviewcli.ts")).toMatch(
    /runsDir: io\.runsDir \?\? join\(stateHome\(\), "review", "runs"\)/,
  );
  const cloneOut = realpathSync(clone.cwd);
  const cloneRun = dirname(cloneOut);
  expect(basename(cloneOut)).toBe("out");
  expect(dirname(cloneRun)).toBe(realpathSync(clone.runsDir));
  expect(clone.agentDir).toBe(join(cloneRun, "agent"));
  expect(clone.agentDir).not.toBe(clone.operatorAgent);
  // Nothing of the checkout's tree, the reviewed repo or the operator's pi home
  // is the cwd or the agentDir, or sits above either.
  for (const outside of [ROOT, reviewedRepo, clone.operatorAgent]) {
    expect(cloneOut.startsWith(realpathSync(outside) + "/"), outside).toBe(false);
    expect(cloneOut, outside).not.toBe(realpathSync(outside));
  }
  expect(clone.agentEntries.filter((n) => CONTEXT_CANDIDATES.includes(n))).toEqual([]);
  // The state home's default layout, on a virtual disk: the run dir under it.
  const virtualRun = join(stateHome({ HOME: "/home/op" }), "review", "runs", "RUN");
  const cloneFs: ContextFs = new Map();
  for (const name of CONTEXT_CANDIDATES) {
    const f = join(cloneOut, name);
    if (!isFile(f)) continue;
    const text = readFileSync(f, "utf8");
    const src = [STUB, ...CONTEXT_CANDIDATES].find(
      (c) => isFile(join(ROOT, c)) && read(c) === text,
    );
    cloneFs.set(join(virtualRun, "out", name), src ?? `unknown:${name}`);
  }
  observed.routes["clone-review"] = row(cloneFs, {
    cwd: join(virtualRun, "out"),
    agentDir: join(virtualRun, "agent"),
    argv: clone.argv,
    note: "cwd is the run's own out dir under the state home, outside every checkout, holding a copy of the reviewer stub (src/hostroute.ts); the agentDir is a private one with no context file.",
  });
  observed.routes["clone-review-lens"] = { ...observed.routes["clone-review"], note: LENS_NOTE };

  // -- the SDK host: `qcr review` on the engine runtime (P2.8, D34) ---------------
  // Discovery is off and the stub is injected as data. The path it carries is
  // <out>/AGENTS.override.md, the same file the clone route's CLI pi loads, but
  // nothing is written there; the planted AGENTS.md files around it never load.
  const sdk = await captureSdkSessions();
  expect(sdk.outEntries).toEqual(["AGENTS.md"]);
  const sdkRow = (
    loaded: Array<{ path: string; content: string }>,
    note: string,
  ): InventoryRow => ({
    cwd: join(virtualRun, "out"),
    agentDir: join(virtualRun, "agent"),
    contextFiles: "injected",
    effective: loaded.map((f) => ({
      path: f.path.replace(sdk.out, join(virtualRun, "out")),
      source:
        [STUB, ...CONTEXT_CANDIDATES].find(
          (c) => isFile(join(ROOT, c)) && read(c).trim() === f.content.trim(),
        ) ?? `unknown:${f.path}`,
    })),
    note,
  });
  observed.routes["sdk"] = sdkRow(
    sdk.main,
    "PiHost.makeSession (src/engine/pisdk.ts): the ResourceLoader discovers nothing and agentsFilesOverride hands over the reviewer stub at the run's out dir; the file is never written, and the planted AGENTS.md in the cwd, its ancestor and the agentDir do not load.",
  );
  observed.routes["sdk-lens"] = sdkRow(
    sdk.lens,
    "An SDK lens session comes from the same makeSession with the same context files (D34: the stub on every route).",
  );

  // -- scan leaves ---------------------------------------------------------------
  expect(read("extensions/setup-scan.ts")).toMatch(
    /const root = env\.QCR_ROOT\?\.trim\(\) \|\| sandboxRoot\(\);[\s\S]*?piCaseRunner\(\{ agentsDir, cwd: root,/,
  );
  const plan = {
    name: "n",
    install: "default",
    image: "img",
    token: "t",
    reviewedRepo: "/r",
    gitDirs: [],
    stateHome: "/s",
    pihomeVolume: "v",
    configMirror: "/c",
    profiles: "/p",
    memory: { network: "" },
  } as unknown as ScanBoxPlan;
  const driverEnv = scanRunArgv(plan, ["x"]).filter((a) => a.startsWith("QCR_ROOT="));
  expect(driverEnv).toEqual([`QCR_ROOT=${SCANBOX.app}`]);
  const leafInBox = await captureScanLeaf(SCANBOX.app);
  ran.push("scan-leaf-container");
  observed.routes["scan-leaf-container"] = row(dockerfileContext(companionDockerfile), {
    cwd: leafInBox.cwd,
    agentDir: SCANBOX.agentDir,
    argv: leafInBox.argv,
    note: "cwd is the app root in the scan container (QCR_ROOT=/opt/qcr), which the companion image fills with an explicit COPY list that has no context file. The leaf passes -nc besides: it loads none whatever the root holds.",
  });
  const leafOnHost = await captureScanLeaf(ROOT);
  ran.push("scan-leaf-host");
  observed.routes["scan-leaf-host"] = row(checkoutFs(CHECKOUT), {
    cwd: at(leafOnHost.cwd, ROOT, CHECKOUT),
    agentDir: "/operator-pi-agent",
    argv: leafOnHost.argv,
    note: '[scan] sandbox = "host": cwd is sandboxRoot(), the qcr checkout, whose AGENTS.md the leaf does not load (-nc, P1.1); nothing is written there or into the scanned tree.',
  });

  // -- the companion -------------------------------------------------------------
  const companionCfg = resolveCompanionPaths(
    { ...COMPANION_DEFAULTS, repo_dir: "/host/qcr", reviewed_repo_dir: "" },
    ROOT,
  );
  const lifecycle = new CompanionLifecycle(
    companionCfg,
    async () => ({ ok: true, stdout: "", stderr: "", code: 0 }),
    { HOME: "/host/home" },
    () => {},
    { exists: () => false, read: () => undefined, mode: () => undefined },
  );
  const spawn = lifecycle.spawnArgv();
  // `docker exec` without -w: pi starts in the container's working directory,
  // which the run sets to the checkout (the image's own WORKDIR is its app
  // root, where the reviewer stub sits).
  expect(spawn.filter((a) => a === "-w" || a === "--workdir")).toEqual([]);
  expect(lifecycle.expectedMounts().get(CONTAINER.workspace)).toBe("/host/qcr");
  const run = lifecycle.runArgv();
  const companionWorkdir = run[run.indexOf("--workdir") + 1]!;
  expect(companionWorkdir).toBe(CONTAINER.workspace);
  expect(vmRoot).toBe(CONTAINER.app);
  expect(mustMatch(releaseDockerfile, /^ENV HOME=(\S+)/m, "companion HOME")).toBe(CONTAINER.home);
  observed.routes["companion"] = row(checkoutFs(CONTAINER.workspace), {
    cwd: companionWorkdir,
    agentDir: join(CONTAINER.piHome, "agent"),
    argv: spawn.slice(spawn.indexOf("pi")),
    note: "/workspace is the qcr checkout, bind-mounted; no stub. The release image in companion mode: its WORKDIR (/opt/qcr, where the stub sits) is overridden by the run.",
  });
}, 120_000);

// ---- the model ------------------------------------------------------------------

describe("pi's context-file loader, modelled", () => {
  const fs: ContextFs = new Map([
    ["/a/AGENTS.md", "outer"],
    ["/a/b/AGENTS.override.md", "override"],
    ["/a/b/AGENTS.md", "shadowed"],
    ["/a/b/c/CLAUDE.md", "inner"],
    ["/agent/AGENTS.md", "global"],
  ]);
  const o = { cwd: "/a/b/c", agentDir: "/agent", contextFiles: "default" as const };

  it("takes the agentDir's file first, then every ancestor's outermost first", () => {
    expect(effectiveContextFiles(fs, o).map((f) => f.path)).toEqual([
      "/agent/AGENTS.md",
      "/a/AGENTS.md",
      "/a/b/AGENTS.override.md",
      "/a/b/c/CLAUDE.md",
    ]);
  });

  it("takes only the first candidate of a directory: the override shadows AGENTS.md", () => {
    expect(effectiveContextFiles(fs, o).map((f) => f.source)).not.toContain("shadowed");
  });

  it("loads nothing under --no-context-files or -nc", () => {
    for (const flag of ["--no-context-files", "-nc"]) {
      const argv = ["pi", "-p", flag, "--model", "m"];
      expect(contextFlagOf(argv)).toBe("disabled");
      expect(effectiveContextFiles(fs, { ...o, contextFiles: contextFlagOf(argv) })).toEqual([]);
    }
    expect(contextFlagOf(["pi", "--", "--no-context-files"])).toBe("default");
  });

  it("moves when the cwd, an ancestor or the agentDir moves", () => {
    const base = effectiveContextFiles(fs, o);
    expect(effectiveContextFiles(fs, { ...o, cwd: "/a/b" })).not.toEqual(base);
    expect(effectiveContextFiles(fs, { ...o, agentDir: "/elsewhere" })).not.toEqual(base);
    const withAncestor = new Map(fs).set("/AGENTS.md", "root");
    expect(effectiveContextFiles(withAncestor, o)).not.toEqual(base);
  });
});

// ---- the recorded table ---------------------------------------------------------

describe("the context-file inventory", () => {
  it("matches the fixture, route by route (UPDATE_CONTEXT_FILES=1 rewrites it)", () => {
    if (UPDATE) writeFileSync(INVENTORY_PATH, JSON.stringify(observed, null, 2) + "\n");
    const recorded = readInventory();
    expect(recorded.pi).toBe(observed.pi);
    expect(Object.keys(recorded.routes).sort()).toEqual(Object.keys(observed.routes).sort());
    for (const [name, got] of Object.entries(observed.routes))
      expect(got, `route ${name}`).toEqual(recorded.routes[name]);
  });

  it("records the routes the plan names, with the files the plan says they load", () => {
    const { routes } = readInventory();
    const files = (r: string): string[] => routes[r]!.effective.map((f) => f.source);
    // The reviewer stub: the VM bot, the bench image, the clone route (from the
    // run's own dir, D34) and their lenses.
    for (const r of [
      "vm-bot",
      "vm-lens",
      "bench",
      "bench-lens",
      "release-image",
      "release-image-lens",
      "clone-review",
      "clone-review-lens",
      "sdk",
      "sdk-lens",
    ]) {
      expect(files(r), r).toEqual([STUB]);
      expect(routes[r]!.effective[0]!.path.endsWith("/AGENTS.override.md"), r).toBe(true);
    }
    // The SDK host hands the stub over as data, with discovery off.
    for (const r of ["sdk", "sdk-lens"]) expect(routes[r]!.contextFiles, r).toBe("injected");
    // The full guide: the companion.
    expect(files("companion")).toEqual(["AGENTS.md"]);
    // Nothing: the judge, the onboarding session, the scan leaves.
    for (const r of ["bench-judge", "onboard", "scan-leaf-container", "scan-leaf-host"])
      expect(files(r), r).toEqual([]);
    for (const r of ["bench-judge", "onboard", "scan-leaf-container", "scan-leaf-host"])
      expect(routes[r]!.contextFiles, r).toBe("disabled");
  });

  it("fails when a route's argv, cwd, ancestors or agentDir change its context file", () => {
    const rec = readInventory().routes["vm-bot"]!;
    const fs: ContextFs = new Map(rec.effective.map((f) => [f.path, f.source]));
    const same = (r: Partial<{ cwd: string; agentDir: string; fs: ContextFs; argv: string[] }>) =>
      row(r.fs ?? fs, {
        cwd: r.cwd ?? rec.cwd,
        agentDir: r.agentDir ?? rec.agentDir,
        argv: r.argv ?? ["pi"],
      }).effective;
    expect(same({})).toEqual(rec.effective);
    expect(same({ argv: ["pi", "-nc"] })).not.toEqual(rec.effective);
    expect(same({ cwd: dirname(rec.cwd) })).not.toEqual(rec.effective);
    const withOther = new Map(fs).set("/other-agent/AGENTS.md", "AGENTS.md");
    expect(same({ fs: withOther })).toEqual(rec.effective);
    expect(same({ fs: withOther, agentDir: "/other-agent" })).not.toEqual(rec.effective);
    expect(same({ fs: new Map(fs).set(join(rec.agentDir, "AGENTS.md"), "AGENTS.md") })).not.toEqual(
      rec.effective,
    );
    expect(same({ fs: new Map(fs).set("/opt/AGENTS.md", "AGENTS.md") })).not.toEqual(rec.effective);
  });

  it("the clone route runs outside the qcr checkout, so the checkout's guide is never shadowed", () => {
    const { routes } = readInventory();
    for (const r of ["clone-review", "clone-review-lens"]) {
      expect(routes[r]!.cwd, r).not.toBe(CHECKOUT);
      expect(routes[r]!.cwd.startsWith(CHECKOUT + "/"), r).toBe(false);
      expect(routes[r]!.contextFiles, r).toBe("default");
    }
  });

  it("no route carries a context file in an ancestor of its cwd", () => {
    for (const [name, r] of Object.entries(readInventory().routes)) {
      const outside = r.effective.filter(
        (f) => dirname(f.path) !== r.cwd && dirname(f.path) !== r.agentDir,
      );
      expect(outside, name).toEqual([]);
    }
  });
});

// ---- where a context file may be written ----------------------------------------

describe("the one install site", () => {
  /** Every tracked file outside the tests and the docs that spells AGENTS.override.md. */
  function mentions(): string[] {
    return git(
      ROOT,
      "ls-files",
      "-z",
      "--",
      "src",
      "extensions",
      "scripts",
      "docker",
      "deploy",
      "bench",
      "commands",
      "skills",
    )
      .split("\0")
      .filter((f) => f && /\.(ts|sh|j2|yml|yaml|json|py|mjs|js)$|Dockerfile/.test(f))
      .filter((f) => read(f).includes("AGENTS.override.md"))
      .sort();
  }

  it("only the release image's daemon mode installs a context file, and only into its own baked app root", () => {
    // No entrypoint installs into a synced sandbox root any more (the VM's
    // used to, into the rsynced deploy tree): the stub is in the image.
    expect(mentions().filter((f) => entrypointInstalls(read(f)).length > 0)).toEqual([]);
    const ep = read("docker/entrypoint.sh");
    expect(ep.match(/^\s*install\b[^\n]*"\$stub"/gm)).toHaveLength(1);
    expect(ep).toContain(
      'stub_src="$APP/deploy/reviewer/AGENTS.override.md" stub="$APP/AGENTS.override.md"',
    );
    // Nothing is rsynced onto the VM any more, so the playbook names the stub nowhere.
    expect(read("deploy/ansible/playbook.yml")).not.toContain("AGENTS.override.md");
  });

  it("every other file naming it copies it into an image, excludes it, reserves it or guards it", () => {
    expect(mentions()).toEqual([
      "bench/aacr/Dockerfile", // COPY into the image's cwd
      "bench/aacr/bench.sh", // the build's allowlist
      "docker/Dockerfile", // COPY into the release image's cwd
      "docker/Dockerfile.dockerignore", // the build's allowlist
      "docker/entrypoint.sh", // the release image's daemon mode: keeps the baked 0444 stub, in its own /opt/qcr
      "extensions/bash-guard.ts", // a policy surface no session may write
      "extensions/debug-round.ts", // a debug round's lens passes carry the stub the cwd holds, as data; it writes none
      "scripts/deploy.sh", // a name the base clone may not take
      "scripts/vm-postcutover-cleanup.sh", // the legacy sandbox's stub, kept and reported as legacy runtime data; it writes none
      "src/engine/roundsdk.ts", // the SDK round's stub as in-memory data for the session, never written to a checkout
      "src/resumecheck.ts", // the offline resume check compares a session's context file with the stub text; reads, never writes
      "src/reviewerstub.ts", // the neutral home of the stub's two names and the one resolver of its source (a checkout's or an image's); reads, never writes
      "src/reviewhost.ts", // the host isolation's per-run copy, into the run's own out dir
      "src/usage.ts", // the cost split counts it as a context file
    ]);
  });

  it("no source file writes a context file by name", () => {
    const writers = git(ROOT, "ls-files", "-z", "--", "src", "extensions", "scripts")
      .split("\0")
      .filter((f) => /\.(ts|sh|mjs|js)$/.test(f))
      .filter((f) =>
        /(writeFile\w*|copyFile\w*|cpSync|renameSync|symlinkSync|\bcp\b|\btee\b|\binstall\b|\bln\b)[^\n]*['"`/ ](AGENTS(\.override)?\.(md|MD)|CLAUDE\.(md|MD))['"`\s]/.test(
          read(f),
        ),
      );
    expect(writers).toEqual([]);
  });

  it("the clone route's copy is the only source-side write, and it refuses a checkout", () => {
    const users = git(ROOT, "ls-files", "-z", "--", "src", "extensions", "scripts")
      .split("\0")
      .filter((f) => /\.(ts|sh|mjs|js)$/.test(f))
      .filter((f) => read(f).includes("HOST_CONTEXT_STUB"))
      .sort();
    // roundsdk.ts only hands the stub to the SDK session as data; it writes nothing.
    // reviewerstub.ts is the neutral home of the two names and finds the stub; it writes nothing.
    // hostroute.ts re-exports the names for `qcr review`'s callers; it writes nothing.
    expect(users).toEqual([
      "src/engine/roundsdk.ts",
      "src/hostroute.ts",
      "src/reviewerstub.ts",
      "src/reviewhost.ts",
    ]);
    expect(read("src/hostroute.ts")).not.toMatch(
      /(writeFile|copyFile|cpSync|renameSync|symlinkSync)\w*\(/,
    );
    expect(read("src/engine/roundsdk.ts")).not.toMatch(
      /(writeFile|copyFile|cpSync|renameSync|symlinkSync)\w*\(/,
    );
    expect(read("src/reviewerstub.ts")).not.toMatch(
      /(writeFile|copyFile|cpSync|renameSync|symlinkSync)\w*\(/,
    );
    const text = read("src/reviewhost.ts");
    expect(text.match(/copyFileSync\([^\n]*HOST_CONTEXT_STUB\)/g)).toHaveLength(1);
    // …into the run's cwd only, after the guard that keeps it out of a checkout.
    expect(text).toMatch(
      /is inside the checkout[\s\S]*copyFileSync\(reviewerStubSource\(o\.root\), join\(cwd, HOST_CONTEXT_STUB\)\)/,
    );
  });

  it("the stub's source is never at a checkout's root", () => {
    expect(existsSync(join(ROOT, "AGENTS.override.md"))).toBe(false);
    expect(isFile(join(ROOT, STUB))).toBe(true);
  });

  it(".pi/agents, which a clone-route bench writes, is gitignored", () => {
    expect(() => git(ROOT, "check-ignore", "-q", ".pi/agents/pass-x.md")).not.toThrow();
    expect(() => git(ROOT, "check-ignore", "-q", ".pi/settings.json")).toThrow();
  });
});

describe("after a fake-pi run of each route", () => {
  it("ran every captured route", () => {
    expect(ran.sort()).toEqual(
      ["bench", "clone-review", "scan-leaf-container", "scan-leaf-host", "vm-bot"].sort(),
    );
  });

  it("the qcr checkout and the reviewed repo are byte-unchanged, with no AGENTS.override.md", () => {
    expect(snapshot(ROOT)).toBe(before.root);
    expect(snapshot(reviewedRepo)).toBe(before.repo);
    expect(existsSync(join(ROOT, "AGENTS.override.md"))).toBe(false);
    expect(existsSync(join(reviewedRepo, "AGENTS.override.md"))).toBe(false);
    for (const dir of [reviewedRepo, join(tmp, "daemon-root"), join(tmp, "bench-root")])
      for (const name of CONTEXT_CANDIDATES) {
        // The scratch root symlinks the checkout's own files; nothing else may appear.
        if (dir === join(tmp, "bench-root") && existsSync(join(ROOT, name))) continue;
        expect(existsSync(join(dir, name)), `${dir}/${name}`).toBe(false);
      }
  });
});

// ---- the state home -------------------------------------------------------------

describe("no ancestor of the state home carries a context file", () => {
  it("holds under a QCR_STATE_HOME override, and fails when an ancestor does", () => {
    const parent = join(tmp, "operator", "qcr-state-parent");
    const home = stateHome({ QCR_STATE_HOME: join(parent, "state") });
    expect(home).toBe(join(parent, "state"));
    mkdirSync(home, { recursive: true });
    // Only the part of the chain under the scratch dir is ours to inspect.
    const hereAndAbove = (p: string): boolean => p.startsWith(tmp) && existsSync(p);
    expect(ancestorsWithContext(hereAndAbove, home)).toEqual([]);
    writeFileSync(join(parent, "AGENTS.md"), "x");
    expect(ancestorsWithContext(hereAndAbove, home)).toEqual([{ dir: parent, file: "AGENTS.md" }]);
  });

  it("holds for the resolved default state home on a virtual disk", () => {
    const home = stateHome({ HOME: "/home/op" });
    expect(home).toBe("/home/op/.local/state/qcr/default");
    expect(ancestorsWithContext(() => false, home)).toEqual([]);
    expect(ancestorsWithContext((p) => p === "/home/op/AGENTS.md", home)).toEqual([
      { dir: "/home/op", file: "AGENTS.md" },
    ]);
  });
});
