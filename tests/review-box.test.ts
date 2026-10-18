// The review sandbox (src/reviewbox.ts): docker is a fake that records its
// argv and plays the container; pi, GitHub and the network are never touched.
import { afterAll, describe, expect, it } from "vitest";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const box = await import("../src/reviewbox.js");
const { SCANBOX } = await import("../src/scanbox.js");

const tmp = mkdtempSync(join(tmpdir(), "review-box-"));
afterAll(() => rmSync(tmp, { recursive: true, force: true }));

const plan = {
  name: "qcr-review-x-ab12",
  image: "qcr-companion:latest",
  pihomeVolume: "pihome",
  tree: "/runs/r1/tree",
  gitDirs: ["/home/u/repo/.git"],
  stateHome: "/state/qcr/x",
  runDir: "/state/qcr/x/review/runs/r1",
  configMirror: "/state/op/scan-config",
  profiles: "/cfg/x/profiles",
  install: "x",
};

/** The `--mount` specs of an argv. */
const mountsOf = (argv: string[]): string[] =>
  argv.flatMap((a, i) => (argv[i - 1] === "--mount" ? [a] : []));

describe("review container argv", () => {
  const argv = box.reviewRunArgv(plan);

  it("is a foreground throwaway container: --rm, no --detach", () => {
    expect(argv.slice(0, 2)).toEqual(["run", "--rm"]);
    expect(argv).not.toContain("--detach");
  });

  it("mounts the tree and the git dirs read-only, the state home read-write", () => {
    const m = mountsOf(argv);
    expect(m).toContain("type=bind,src=/runs/r1/tree,dst=/reviewed-repo,readonly");
    expect(m).toContain("type=bind,src=/home/u/repo/.git,dst=/home/u/repo/.git,readonly");
    expect(m).toContain("type=bind,src=/state/qcr/x,dst=/qcr-state");
    const rw = m.filter((x) => !x.includes("readonly") && x.startsWith("type=bind"));
    expect(rw).toEqual(["type=bind,src=/state/qcr/x,dst=/qcr-state"]);
  });

  it("hides the tree inside the read-write state home under an empty tmpfs", () => {
    expect(mountsOf(argv)).toContain("type=tmpfs,dst=/qcr-state/review/runs/r1/tree");
  });

  it("gives the login read-only with a private tmpfs pi home and refresh copy env", () => {
    const m = mountsOf(argv);
    expect(m).toContain(
      `type=volume,src=pihome,dst=${SCANBOX.authSrc},volume-subpath=agent,readonly`,
    );
    expect(m.some((x) => x.startsWith(`type=tmpfs,dst=${SCANBOX.piHome}`))).toBe(true);
    expect(argv).toContain(`QCR_SCAN_AUTH_SRC=${SCANBOX.authSrc}`);
    expect(argv).toContain(`PI_CODING_AGENT_DIR=${SCANBOX.agentDir}`);
  });

  it("carries no GitHub credential and runs the spec", () => {
    expect(argv.join(" ")).not.toMatch(/GITHUB_TOKEN|GH_TOKEN|GH_ENTERPRISE/);
    expect(argv.slice(-3)).toEqual([
      "review",
      "--run-spec",
      "/qcr-state/review/runs/r1/review-spec.json",
    ]);
  });

  it("mounts a run dir outside the state home on its own", () => {
    const a = box.reviewRunArgv({ ...plan, runDir: "/elsewhere/r1" });
    expect(mountsOf(a)).toContain("type=bind,src=/elsewhere/r1,dst=/qcr-run");
    expect(a.slice(-1)).toEqual(["/qcr-run/review-spec.json"]);
  });
});

const sandbox = {
  sandbox: "docker" as const,
  sandbox_set: true,
  pihome_volume: "pihome",
  image: "img",
};
const farFuture = Date.now() + 10 * 3600_000;

/** A docker that plays the container: `run` writes the result the inside would. */
function fakeDocker(o: { login?: boolean; result?: boolean; exit?: boolean } = {}) {
  const calls: string[][] = [];
  const docker = async (argv: string[]) => {
    calls.push(argv);
    const ok = { ok: true, stdout: "", stderr: "", code: 0 };
    if (argv[0] === "run" && argv.includes("loginsummary")) return ok;
    if (argv[0] === "run" && argv.includes("--rm") && argv.includes("--run-spec")) {
      if (o.result !== false) {
        const spec = JSON.parse(readFileSync(join(runDirOf(argv), "review-spec.json"), "utf8")) as {
          outDir: string;
        };
        const host = join(runDirOf(argv), "out");
        expect(spec.outDir.endsWith("/out")).toBe(true);
        writeFileSync(
          join(host, "oneshot-result.json"),
          JSON.stringify({ capped: false, warnings: [], costUsd: 0.1, review: null }),
        );
      }
      return o.exit ? { ok: false, stdout: "", stderr: "boom", code: 1 } : ok;
    }
    if (argv[0] === "run")
      return {
        ok: true,
        stdout: JSON.stringify({ openai: { type: "oauth", expires: farFuture } }),
        stderr: "",
        code: 0,
      };
    return ok;
  };
  return { docker, calls };
}
let runDirForFake = "";
const runDirOf = (_a: string[]): string => runDirForFake;

function deps(docker: ReturnType<typeof fakeDocker>["docker"], name: string) {
  const home = join(tmp, name, "state");
  mkdirSync(home, { recursive: true });
  return {
    docker,
    env: {
      QCR_STATE_HOME: home,
      QCR_CONFIG_HOME: join(tmp, name, "cfg"),
      QCR_INSTALL: "t",
    } as never,
    sandbox,
    configSource: () => join(tmp, "config.toml"),
    stamp: () => "s1",
    gitDirs: () => ({ ok: true as const, mounts: ["/host/.git"] }),
    mirror: () => "copied" as never,
    token: () => "tok",
  };
}

function input(name: string) {
  const runDir = join(tmp, name, "state", "review", "runs", "r1");
  mkdirSync(join(runDir, "out"), { recursive: true });
  runDirForFake = runDir;
  return {
    root: "/root",
    agentDir: "/agent",
    tree: join(runDir, "tree"),
    files: [],
    target: {
      repo: "o/r",
      number: 0,
      title: "t",
      body: null,
      headSha: "h",
      baseRef: "main",
      baseSha: "b",
      mergeBase: "m",
    },
    outDir: join(runDir, "out"),
    cfg: { review: { profile: "p" } },
    ecosystem: {},
    timeoutMs: 1000,
    capUsd: 2,
  } as never;
}

describe("dockerReviewRunner", () => {
  it("runs in a container that is removed afterwards, and returns the result", async () => {
    const f = fakeDocker();
    const run = box.dockerReviewRunner(deps(f.docker, "ok"));
    const res = await run(input("ok"));
    expect(res.costUsd).toBe(0.1);
    const runs = f.calls.filter((c) => c.includes("--run-spec"));
    expect(runs).toHaveLength(1);
    expect(runs[0]).toContain("--rm");
    expect(f.calls.at(-1)).toEqual(["rm", "-f", "qcr-review-t-tok"]);
    const spec = JSON.parse(readFileSync(join(runDirForFake, "review-spec.json"), "utf8"));
    expect(spec.profile).toBe("p");
    expect(spec.tree).toBe("/reviewed-repo");
    expect(spec.capUsd).toBe(2);
  });

  it("never hands the process's GitHub token to the container", async () => {
    process.env["GH_TOKEN"] = "ghp_secret";
    process.env["GITHUB_TOKEN"] = "ghp_secret2";
    try {
      const f = fakeDocker();
      await box.dockerReviewRunner(deps(f.docker, "tok"))(input("tok"));
      expect(JSON.stringify(f.calls)).not.toMatch(/ghp_secret/);
    } finally {
      delete process.env["GH_TOKEN"];
      delete process.env["GITHUB_TOKEN"];
    }
  });

  it("removes the container and throws when it ends without a result", async () => {
    const f = fakeDocker({ result: false, exit: true });
    await expect(box.dockerReviewRunner(deps(f.docker, "bad"))(input("bad"))).rejects.toThrow(
      /without a result.*boom/,
    );
    expect(f.calls.at(-1)).toEqual(["rm", "-f", "qcr-review-t-tok"]);
  });

  it("refuses an expiring login before any container starts", async () => {
    const f = fakeDocker();
    const d = deps(async (a) => {
      f.calls.push(a);
      return {
        ok: true,
        stdout: JSON.stringify({ x: { type: "oauth", expires: Date.now() + 1000 } }),
        stderr: "",
        code: 0,
      };
    }, "exp");
    await expect(box.dockerReviewRunner(d)(input("exp"))).rejects.toThrow(/expires/);
    expect(f.calls.some((c) => c.includes("--run-spec"))).toBe(false);
  });
});

describe("chooseReviewSandbox", () => {
  const base = (
    docker: (
      a: string[],
    ) => Promise<{ ok: boolean; stdout: string; stderr: string; code: number | null }>,
  ) => ({
    ...deps(docker as never, "choose"),
    appRoot: "/app",
    exists: () => false,
  });

  it("warns and runs on the host when docker is absent", async () => {
    const c = await box.chooseReviewSandbox(
      base(async () => ({ ok: false, stdout: "", stderr: "docker: command not found", code: 127 })),
    );
    expect(c.runner).toBeUndefined();
    expect(c.warning).toMatch(/Docker is not available.*host/);
  });

  it("uses the sandbox when docker and the image are there", async () => {
    const c = await box.chooseReviewSandbox(
      base(async (a) => ({
        ok: true,
        stdout: a[0] === "image" ? "s1" : "27.0",
        stderr: "",
        code: 0,
      })),
    );
    expect(c.runner).toBeTypeOf("function");
    expect(c.warning).toBeUndefined();
  });

  it("warns, naming the cause, when the image is stale", async () => {
    const c = await box.chooseReviewSandbox(
      base(async (a) => ({
        ok: true,
        stdout: a[0] === "image" ? "other" : "27.0",
        stderr: "",
        code: 0,
      })),
    );
    expect(c.runner).toBeUndefined();
    expect(c.warning).toMatch(/other code/);
  });

  it("host by configuration is quiet", async () => {
    const c = await box.chooseReviewSandbox({
      ...base(async () => ({ ok: true, stdout: "", stderr: "", code: 0 })),
      sandbox: { ...sandbox, sandbox: "host" as const },
    });
    expect(c).toEqual({});
  });
});

describe("runReviewSpec (the inside)", () => {
  it("copies the login refresh-disabled, runs on the tree and writes the result", async () => {
    const d = join(tmp, "inside");
    const src = join(d, "src");
    const agent = join(d, "agent");
    const out = join(d, "out");
    mkdirSync(src, { recursive: true });
    mkdirSync(out, { recursive: true });
    writeFileSync(
      join(src, "auth.json"),
      JSON.stringify({ p: { type: "oauth", refresh: "REAL", expires: farFuture } }),
    );
    const specPath = join(d, "spec.json");
    writeFileSync(
      specPath,
      JSON.stringify({
        profile: "p",
        tree: "/reviewed-repo",
        outDir: out,
        files: [],
        target: {},
        timeoutMs: 1000,
        capUsd: 1,
      }),
    );
    let seen: { tree?: string; agentDir?: string; capUsd?: number } = {};
    const code = await box.runReviewSpec(specPath, {
      env: { QCR_SCAN_AUTH_SRC: src, PI_CODING_AGENT_DIR: agent, QCR_ROOT: "/app" },
      context: () => ({ cfg: {} as never, ecosystem: {} as never }),
      run: async (i) => {
        seen = i;
        return { capped: false, warnings: [], costUsd: 0.5 } as never;
      },
    });
    expect(code).toBe(0);
    expect(seen.tree).toBe("/reviewed-repo");
    expect(seen.capUsd).toBe(1);
    expect(JSON.parse(readFileSync(join(agent, "auth.json"), "utf8")).p.refresh).not.toBe("REAL");
    expect(JSON.parse(readFileSync(join(out, "oneshot-result.json"), "utf8")).costUsd).toBe(0.5);
    expect(existsSync(join(src, "auth.json"))).toBe(true);
  });
});
