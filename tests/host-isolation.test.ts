// Host-route isolation: `qcr review` runs pi with nothing of the
// operator's pi home, the qcr checkout or the reviewed repo reaching the
// session or its lens children, and the bench keeps its own placement.
//
// pi is a fake that MODELS what pi 1.3.0 discovers from its argv, cwd and
// environment, and spawns a lens child of itself the way the retired native glue
// did (tests/helpers/host-fake-pi.ts). No network, no model.
import { piCliRuntime } from "./helpers/pi-cli-runtime.js";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { execFileSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, isAbsolute, join, resolve } from "node:path";
import { hostFakePi, type HostPiRecord } from "./helpers/host-fake-pi.js";
import { inventoryRow } from "./helpers/context-files.js";

vi.stubEnv("QCR_CONFIG", join(import.meta.dirname, "fixtures", "config.toml"));

const { runReviewCli } = await import("../src/reviewcli.js");
const { runOneShot } = await import("@quickchatai/pi-quickreview/src/oneshot.js");
const { HOST_HTTP_IDLE_TIMEOUT_MS, REVIEWER_STUB, hostSettings } =
  await import("../src/hostroute.js");
const { benchConfig, buildBenchAgents, contextFor } = await import("../src/bench/runner.js");
const { benchSettings } = await import("../src/bench/auth.js");
const { DISABLED_REFRESH } = await import("@quickchatai/pi-quickreview/src/engine/auth.js");
const { ecosystemFor } = await import("@quickchatai/pi-quickreview/src/ecosystem.js");

const ROOT = realpathSync(resolve(import.meta.dirname, ".."));
const tmp = realpathSync(mkdtempSync(join(tmpdir(), "host-isolation-")));
const TOKEN_ENVS = ["GITHUB_TOKEN", "GH_TOKEN", "GH_ENTERPRISE_TOKEN"];

afterAll(() => {
  rmSync(tmp, { recursive: true, force: true });
  vi.unstubAllEnvs();
});

const read = (p: string): string => readFileSync(join(ROOT, p), "utf8");
const git = (cwd: string, ...args: string[]): string =>
  execFileSync(
    "git",
    ["-c", "user.name=T", "-c", "user.email=t@example.com", "-c", "commit.gpgsign=false", ...args],
    { cwd, encoding: "utf8" },
  ).trim();

/** A production-shaped root: the checkout's top-level entries, symlinked. */
function mkRoot(name: string): string {
  const root = join(tmp, name);
  mkdirSync(root);
  for (const e of readdirSync(ROOT))
    if (![".git", "wt", "state"].includes(e)) symlinkSync(join(ROOT, e), join(root, e));
  return root;
}

/** A reviewed repo that carries everything a hostile checkout could: a root
 * context file, `.pi/` extensions, settings and agents. */
function mkReviewedRepo(): string {
  const repo = join(tmp, "reviewed-repo");
  mkdirSync(join(repo, "src"), { recursive: true });
  git(repo, "init", "-q", "-b", "main");
  writeFileSync(join(repo, "src", "a.ts"), "export const a = 1;\n");
  git(repo, "add", "-A");
  git(repo, "commit", "-q", "-m", "base");
  git(repo, "checkout", "-q", "-b", "feature");
  writeFileSync(join(repo, "src", "a.ts"), "export const a = 1;\nexport const b = 2;\n");
  mkdirSync(join(repo, ".pi", "extensions"), { recursive: true });
  mkdirSync(join(repo, ".pi", "agents"), { recursive: true });
  writeFileSync(join(repo, ".pi", "extensions", "repo-evil.ts"), "export default () => {};\n");
  writeFileSync(join(repo, ".pi", "settings.json"), '{"extensions":["./repo-evil.ts"]}\n');
  writeFileSync(join(repo, "AGENTS.md"), "the reviewed repo's own guide\n");
  git(repo, "add", "-A");
  git(repo, "commit", "-q", "-m", "add b, with a hostile .pi");
  writeFileSync(join(repo, ".git", "qcr-review.json"), JSON.stringify({ auto_limit_usd: 1000 }));
  return repo;
}

/** `git status` plus the context files present: what a run must not change. */
function snapshot(dir: string): string {
  const status = git(dir, "status", "--porcelain").split("\n");
  const named = ["AGENTS.override.md", "AGENTS.md", "CLAUDE.md"].filter((n) =>
    existsSync(join(dir, n)),
  );
  return JSON.stringify({ status, named });
}

interface Ran {
  main: HostPiRecord;
  child: HostPiRecord;
  lenses: string[];
  lines: string[];
  code: number;
  runsDir: string;
  piCalls: boolean;
}

let root: string;
let repo: string;
let home: string;
let operatorAgent: string;
let before: { root: string; repo: string };

beforeAll(() => {
  root = mkRoot("root");
  repo = mkReviewedRepo();
  // The operator's own pi home and $HOME, each planted with what must not load.
  home = join(tmp, "home");
  operatorAgent = join(tmp, "operator-agent");
  for (const d of [join(operatorAgent, "extensions"), join(home, ".pi", "agent", "extensions")])
    mkdirSync(d, { recursive: true });
  mkdirSync(join(operatorAgent, "skills", "own"), { recursive: true });
  writeFileSync(join(operatorAgent, "extensions", "own-evil.ts"), "export default () => {};\n");
  writeFileSync(
    join(home, ".pi", "agent", "extensions", "home-evil.ts"),
    "export default () => {};\n",
  );
  writeFileSync(join(operatorAgent, "AGENTS.md"), "the operator's own guide\n");
  writeFileSync(
    join(operatorAgent, "settings.json"),
    JSON.stringify({ extensions: [join(operatorAgent, "extensions", "own-evil.ts")] }),
  );
  writeFileSync(
    join(operatorAgent, "auth.json"),
    JSON.stringify({
      "openai-codex": {
        type: "oauth",
        access: "A",
        refresh: "REAL-REFRESH",
        expires: Date.now() + 24 * 3_600_000,
      },
    }),
  );
  // A GitHub credential in the parent's environment, and a $HOME of its own.
  vi.stubEnv("HOME", home);
  for (const k of TOKEN_ENVS) vi.stubEnv(k, `secret-${k}`);
  before = { root: snapshot(ROOT), repo: snapshot(repo) };
});

async function review(
  name: string,
  o: { runsDir?: string; agentDir?: string; args?: string[] } = {},
): Promise<Ran & { fake: ReturnType<typeof hostFakePi> }> {
  const ctx = contextFor(root, "");
  const runsDir = o.runsDir ?? join(tmp, `runs-${name}`);
  const lines: string[] = [];
  const deps = (piBin: string) => ({
    cwd: repo,
    out: (l: string) => lines.push(l),
    confirm: null,
    root,
    agentDir: o.agentDir ?? operatorAgent,
    cfg: ctx.cfg,
    ecosystem: ctx.ecosystem,
    runtime: piCliRuntime({ bin: piBin }),
    runsDir,
    dryrunDir: join(tmp, `dryrun-${name}`),
    timeoutMs: 60_000,
    warn: () => {},
  });
  // The plan first (free): the lens names the round order will carry.
  await runReviewCli(["--preview", "--full"], true, deps("false"));
  const last = lines.pop()!;
  const preview = JSON.parse(last) as { preview?: { lenses: string[] } };
  if (!preview.preview) throw new Error(`no preview: ${last}`);
  const lenses = preview.preview.lenses;
  expect(lenses.length).toBeGreaterThan(0);
  const fake = hostFakePi(tmp, name, { floor: tmp, lenses });
  const code = await runReviewCli(["--full", ...(o.args ?? [])], true, deps(fake.bin));
  const piCalls = existsSync(`${join(tmp, name)}.rec.json`);
  const rec = piCalls ? fake.read() : { main: undefined as never, child: undefined as never };
  return { ...rec, lenses, lines, code, runsDir, piCalls, fake } as never;
}

let ran: Ran;
beforeAll(async () => {
  ran = await review("clone");
}, 60_000);

describe("the argv", () => {
  it("disables discovery and names the guard and the session's two other extensions explicitly", () => {
    const { argv } = ran.main;
    expect(argv).toContain("-ne");
    expect(argv).toContain("-ns");
    expect(argv).not.toContain("-nc");
    expect(argv).not.toContain("--no-context-files");
    const exts = argv.flatMap((a, i) => (a === "--extension" ? [argv[i + 1]!] : []));
    expect(exts.map((e) => basename(e)).sort()).toEqual([
      "bash-guard.ts",
      "finding-clusters.ts",
      "ledger-pin.ts",
    ]);
  });

  it("names every extension, prompt, skill and agent path absolutely", () => {
    const { argv } = ran.main;
    const pathFlags = [
      "--extension",
      "-e",
      "--prompt-template",
      "--skill",
      "--theme",
      "--system-prompt",
      "--session-dir",
    ];
    const paths = argv.flatMap((a, i) => (pathFlags.includes(a) ? [argv[i + 1]!] : []));
    expect(paths.length).toBeGreaterThanOrEqual(5);
    for (const p of paths) expect(isAbsolute(p), p).toBe(true);
    expect(ran.main.extensions.every(isAbsolute)).toBe(true);
  });
});

describe("pi's cwd and context", () => {
  it("is the run's out dir, outside the qcr checkout, the root and the reviewed repo", () => {
    const sessionDir = ran.main.argv[ran.main.argv.indexOf("--session-dir") + 1]!;
    expect(ran.main.cwd).toBe(dirname(sessionDir));
    expect(basename(ran.main.cwd)).toBe("out");
    expect(dirname(dirname(ran.main.cwd))).toBe(ran.runsDir);
    for (const outside of [ROOT, realpathSync(root), repo]) {
      expect(ran.main.cwd.startsWith(outside + "/"), outside).toBe(false);
      expect(ran.main.cwd).not.toBe(outside);
    }
    expect(ran.main.cwd).not.toBe(realpathSync(root));
  });

  it("loads the reviewer stub as its only context file, agentDir and ancestors included", () => {
    const stub = read(REVIEWER_STUB);
    for (const r of [ran.main, ran.child]) {
      expect(r.contextFiles).toEqual([{ path: join(r.cwd, "AGENTS.override.md"), text: stub }]);
    }
    // the planted ones exist and are what would have loaded
    expect(existsSync(join(operatorAgent, "AGENTS.md"))).toBe(true);
    expect(existsSync(join(repo, "AGENTS.md"))).toBe(true);
    expect(existsSync(join(ROOT, "AGENTS.md"))).toBe(true);
  });

  it("agrees with the inventory's context-files row", () => {
    const row = inventoryRow("clone-review");
    expect(row.contextFiles).toBe("default");
    expect(row.effective.map((f) => f.source)).toEqual([REVIEWER_STUB.replaceAll("\\", "/")]);
    expect(inventoryRow("clone-review-lens")).toMatchObject({
      cwd: row.cwd,
      agentDir: row.agentDir,
    });
    expect(ran.main.contextFiles.map((f) => f.text)).toEqual([read(REVIEWER_STUB)]);
  });

  it("leaves the qcr checkout and the reviewed repo as they were", () => {
    expect(snapshot(ROOT)).toBe(before.root);
    expect(snapshot(repo)).toBe(before.repo);
    for (const dir of [ROOT, repo, root]) {
      expect(existsSync(join(dir, "AGENTS.override.md")), dir).toBe(false);
    }
  });
});

describe("what loads", () => {
  it("the session loads the three named extensions and nothing planted in the pi home, $HOME or the repo", () => {
    expect(ran.main.extensions.map((e) => basename(e)).sort()).toEqual([
      "bash-guard.ts",
      "finding-clusters.ts",
      "ledger-pin.ts",
    ]);
    for (const evil of ["own-evil.ts", "home-evil.ts", "repo-evil.ts"])
      expect(ran.main.extensions.map((e) => basename(e))).not.toContain(evil);
    expect(ran.main.skills).toEqual([]);
  });

  it("the private settings register no extension: a lens carries the guard as a factory, not from settings", () => {
    expect(ran.child.extensions).toEqual([]);
    expect(ran.child.agentDir).toBe(ran.main.agentDir);
    expect(ran.child.cwd).toBe(ran.main.cwd);
  });

  it("the private agent dir replaces the operator's pi home", () => {
    expect(ran.main.agentDir).toBe(join(dirname(ran.main.cwd), "agent"));
    expect(ran.main.agentDir).not.toBe(operatorAgent);
    // the login is a refresh-disabled copy
    const auth = JSON.parse(ran.main.auth!) as Record<string, { refresh: string; access: string }>;
    expect(auth["openai-codex"]!.access).toBe("A");
    expect(auth["openai-codex"]!.refresh).toBe(DISABLED_REFRESH);
    // …and the operator's own file is untouched
    expect(readFileSync(join(operatorAgent, "auth.json"), "utf8")).toContain("REAL-REFRESH");
    // the copy goes with the run
    expect(existsSync(ran.main.agentDir)).toBe(false);
  });

  it("the effective settings carry httpIdleTimeoutMs from the private settings.json", () => {
    for (const r of [ran.main, ran.child])
      expect(r.settings["httpIdleTimeoutMs"], "httpIdleTimeoutMs").toBe(120_000);
    expect(HOST_HTTP_IDLE_TIMEOUT_MS).toBe(
      (JSON.parse(read(".pi/settings.json")) as { httpIdleTimeoutMs: number }).httpIdleTimeoutMs,
    );
    const s = JSON.parse(hostSettings(root)) as Record<string, unknown>;
    expect(s).not.toHaveProperty("extensions");
    expect(s["httpIdleTimeoutMs"]).toBe(120_000);
    // the bench's settings are unchanged by it
    expect(JSON.parse(benchSettings(root).settings)).not.toHaveProperty("httpIdleTimeoutMs");
  });

  it("no GitHub credential is in the environment of the session or its lens child", () => {
    for (const r of [ran.main, ran.child]) {
      for (const k of TOKEN_ENVS) expect(r.env, k).not.toHaveProperty(k);
      expect(JSON.stringify(r.env)).not.toContain("secret-");
    }
    expect(Object.keys(ran.main.env)).toContain("PI_CODING_AGENT_DIR");
  });
});

describe("lens names", () => {
  it("resolve in the session and in a lens child (no 'Unknown agent')", () => {
    expect(ran.main.scope).toBe("user");
    for (const r of [ran.main, ran.child]) {
      for (const lens of ran.lenses) {
        expect(r.agents[lens], lens).toBe(join(r.agentDir, "agents", `${lens}.md`));
      }
    }
  });
});

describe("refusals", () => {
  it("refuses a login that expires inside the review's budget, and starts nothing", async () => {
    const soon = join(tmp, "soon-agent");
    mkdirSync(soon, { recursive: true });
    writeFileSync(
      join(soon, "auth.json"),
      JSON.stringify({
        p: { type: "oauth", access: "A", refresh: "R", expires: Date.now() + 60_000 },
      }),
    );
    const r = await review("soon", { agentDir: soon });
    expect(r.code).toBe(1);
    expect(r.lines.join("\n")).toMatch(/pi login expires at/);
    expect(r.piCalls).toBe(false);
  });

  it("runs on an API key when there is no login file", async () => {
    const r = await review("nologin", { agentDir: join(tmp, "no-such-agent") });
    expect(r.code).toBe(0);
    expect(r.main.auth!.trim()).toBe("{}");
  });

  it("says so when a context file sits above the run directory", async () => {
    const runsDir = join(tmp, "guided", "runs");
    mkdirSync(dirname(runsDir), { recursive: true });
    writeFileSync(join(dirname(runsDir), "AGENTS.md"), "above\n");
    const r = await review("stray", { runsDir, args: [] });
    const out = JSON.parse(r.lines[r.lines.length - 1]!) as { warnings: string[] };
    expect(out.warnings.join("\n")).toContain(join(dirname(runsDir), "AGENTS.md"));
    expect(r.main.contextFiles.map((f) => basename(f.path))).toEqual([
      "AGENTS.md",
      "AGENTS.override.md",
    ]);
  });
});

describe("the bench keeps its placement", () => {
  const ctx = (): ReturnType<typeof contextFor> => contextFor(root, "");

  async function benchRun(
    name: string,
  ): Promise<{ main: HostPiRecord; child: HostPiRecord | null; lenses: string[]; root: string }> {
    const bRoot = join(tmp, `${name}-root`);
    mkdirSync(bRoot);
    for (const e of readdirSync(ROOT))
      if (![".git", "wt", "state", ".pi"].includes(e)) symlinkSync(join(ROOT, e), join(bRoot, e));
    const agentDir = join(tmp, `${name}-agent`);
    mkdirSync(agentDir, { recursive: true });
    writeFileSync(join(agentDir, "settings.json"), benchSettings(bRoot).settings);
    writeFileSync(join(agentDir, "auth.json"), "{}\n");
    expect(buildBenchAgents(bRoot, benchConfig(""))).toBeGreaterThan(0);
    const tree = join(tmp, `${name}-tree`);
    mkdirSync(join(tree, "src"), { recursive: true });
    writeFileSync(join(tree, "src", "a.ts"), "export const a = 1;\nexport const b = 2;\n");
    // the lens names this root plans, from the same renderer the bench uses
    const probe = hostFakePi(tmp, `${name}-probe`, { floor: tmp, lenses: [] });
    const first = await runOneShot({
      root: bRoot,
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
      outDir: join(tmp, `${name}-out0`),
      cfg: ctx().cfg,
      ecosystem: ecosystemFor("none"),
      timeoutMs: 60_000,
      runtime: piCliRuntime({ bin: probe.bin }),
    });
    const lenses = first.plannedLenses;
    const fake = hostFakePi(tmp, name, { floor: tmp, lenses });
    await runOneShot({
      root: bRoot,
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
      outDir: join(tmp, `${name}-out`),
      cfg: ctx().cfg,
      ecosystem: ecosystemFor("none"),
      timeoutMs: 60_000,
      runtime: piCliRuntime({ bin: fake.bin }),
    });
    return { ...fake.read(), lenses, root: bRoot };
  }

  it("runs with cwd = root and the project-scope agents under it", async () => {
    const b = await benchRun("bench");
    expect(b.main.cwd).toBe(realpathSync(b.root));
    expect(b.main.scope).toBe("project");
    expect(b.main.argv).toContain("-ne");
    for (const lens of b.lenses) {
      expect(b.main.agents[lens], lens).toBe(
        join(realpathSync(b.root), ".pi", "agents", `${lens}.md`),
      );
      expect(b.child!.agents[lens], lens).toBe(
        join(realpathSync(b.root), ".pi", "agents", `${lens}.md`),
      );
    }
    // the guard is loaded by the session explicitly; the sandbox's global
    // settings register none, so a settings-only child loads nothing
    // (lens passes get the guard from the lens tool's factory)
    expect(b.main.extensions.map((e) => basename(e))).toContain("bash-guard.ts");
    expect(b.child!.extensions.map((e) => basename(e))).toEqual([]);
    expect(b.main.env["QCR_SUBAGENT_SCOPE"]).toBe("project");
  }, 60_000);

  it("-ns is neutral there: the image places no skill anywhere pi looks", () => {
    const dockerfile = read("bench/aacr/Dockerfile");
    // every COPY source and destination
    const copies = [...dockerfile.matchAll(/^COPY\s+(?:--\S+\s+)*(.+)$/gm)].flatMap((m) =>
      m[1]!.trim().split(/\s+/),
    );
    expect(copies.filter((c) => /(^|\/)(\.agents|skills)(\/|$)/.test(c))).toEqual([]);
    // the project .pi/ is baked outside the tree and carries settings only
    expect(dockerfile).toMatch(/COPY \.pi \/opt\/quickreview\/bench\/pi-project/);
    const tracked = git(ROOT, "ls-files", ".pi").split("\n").sort();
    expect(tracked).toEqual([".pi/README.md", ".pi/settings.json"]);
    // $HOME is a scratch dir the image creates empty
    expect(dockerfile).toMatch(/HOME=\/tmp\/home/);
    expect(dockerfile).not.toMatch(/\/tmp\/home\/\.agents/);
  });
});
