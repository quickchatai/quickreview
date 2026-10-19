// `qcr review start | status | stop` as a container (P6.8). The host wrapper makes
// a detached run a container of its own; this file pins the image's half and the
// way the two meet. In three layers, none of which reaches a model:
//   - src/reviewdetach.ts with the container deps: the claim records a run with a
//     container and no pid, a run is alive while its container is listed, a target
//     held by a live container is refused, `stop` marks the run and kills nothing;
//   - the built cli, over a real repo and a state home: the claim, status and stop
//     in the env the wrapper hands a container, and the driver (`--container-run`)
//     ending a run it was given;
//   - real containers (skipped where docker or the node image is absent): the
//     claim over a read-only /repo with --uncommitted, the wrapper's stop against a
//     frozen driver (the container is gone within the grace), and the model's bash
//     after the handoff inside a container started as the wrapper starts one.
import { afterAll, describe, expect, it } from "vitest";
import { execFileSync, spawnSync } from "node:child_process";
import {
  chmodSync,
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  CONTAINER_START_GRACE_MS,
  liveContainersFromEnv,
  readContainerRun,
  runDetachedVerb,
  type DetachDeps,
} from "../src/reviewdetach.js";
import { containerRunEnv } from "../src/reviewcli.js";
import { runLive, type LiveCliDeps } from "../src/livecli.js";
import { writeSdkDriverStub } from "./helpers/sdk-driver-stub.js";
import { parseConfig } from "../src/config.js";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const TOKEN = "ghs_INIMAGE_SECRET_0123456789";
const tmp = mkdtempSync(join(tmpdir(), "review-container-"));
afterAll(() => rmSync(tmp, { recursive: true, force: true }));

// ---- the deps, in container mode ------------------------------------------------------

interface Harness {
  deps: DetachDeps;
  lines: string[];
  clock: { t: number };
  live: Set<string>;
  killed: number[];
  home: string;
}

let n = 0;
function harness(known = true): Harness {
  const home = join(tmp, `home${n++}`);
  const lines: string[] = [];
  const clock = { t: 1_000_000 };
  const live = new Set<string>();
  const killed: number[] = [];
  let ids = 0;
  const deps: DetachDeps = {
    home,
    out: (l) => lines.push(l),
    now: () => clock.t,
    sleep: async (ms) => {
      clock.t += ms;
    },
    newId: () => `run${++ids}`,
    alive: () => {
      throw new Error("a container run has no pid to ask after");
    },
    kill: (pid) => {
      killed.push(pid);
    },
    identify: (rest) => ({
      ok: true,
      key: `uncommitted:o/r@${rest.includes("other") ? "other" : "feature"}`,
      label: "uncommitted changes on feature",
    }),
    launch: (l) => ({ ok: true, pid: null, container: `qcr-review-${l.runId}` }),
    liveContainers: known ? () => live : () => null,
  };
  return { deps, lines, clock, live, killed, home };
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const json = (h: Harness): Record<string, any> => JSON.parse(h.lines[h.lines.length - 1]!);

describe("a run that is a container", () => {
  it("start records the container and no pid, starts no watchdog, and is running while it is listed", async () => {
    const h = harness();
    let watched = 0;
    h.deps.watch = () => void watched++;
    expect(await runDetachedVerb("start", ["--uncommitted"], true, h.deps)).toBe(0);
    expect(json(h)).toMatchObject({ ok: true, run_id: "run1", state: "running" });
    const run = JSON.parse(readFileSync(join(h.home, "runs", "run1", "run.json"), "utf8"));
    expect(run).toMatchObject({ pid: null, container: "qcr-review-run1", argv: ["--uncommitted"] });
    expect(watched).toBe(0);

    h.live.add("qcr-review-run1");
    h.lines.length = 0;
    expect(await runDetachedVerb("status", [], true, h.deps)).toBe(0);
    expect(json(h)).toMatchObject({ state: "running", run_id: "run1" });
  });

  it("a container that is gone without a result is a failed run, once the wrapper has had time to start it", async () => {
    const h = harness();
    await runDetachedVerb("start", [], true, h.deps);
    // just claimed: the wrapper has not started the container yet
    h.lines.length = 0;
    await runDetachedVerb("status", [], true, h.deps);
    expect(json(h).state).toBe("running");
    h.clock.t += CONTAINER_START_GRACE_MS + 1;
    h.lines.length = 0;
    expect(await runDetachedVerb("status", [], true, h.deps)).toBe(1);
    expect(json(h)).toMatchObject({ ok: false, state: "failed", exit_code: null });
    expect(json(h).errors[0]).toContain("driver.log");
  });

  it("a finished run keeps its result whether or not the container is still listed", async () => {
    const h = harness();
    await runDetachedVerb("start", [], true, h.deps);
    const dir = join(h.home, "runs", "run1");
    writeFileSync(join(dir, "output.jsonl"), `${JSON.stringify({ ok: true, findings: [] })}\n`);
    writeFileSync(join(dir, "exit.json"), JSON.stringify({ code: 0 }));
    h.clock.t += CONTAINER_START_GRACE_MS + 1;
    h.lines.length = 0;
    expect(await runDetachedVerb("status", [], true, h.deps)).toBe(0);
    expect(json(h)).toMatchObject({ state: "done", result: { ok: true } });
  });

  it("a target held by a live container is refused; a dead one's lock is replaced", async () => {
    const h = harness();
    await runDetachedVerb("start", [], true, h.deps);
    h.live.add("qcr-review-run1");
    h.lines.length = 0;
    expect(await runDetachedVerb("start", [], true, h.deps)).toBe(1);
    expect(json(h).errors[0]).toMatch(/already running.*run1/);

    h.live.clear();
    h.clock.t += CONTAINER_START_GRACE_MS + 1;
    h.lines.length = 0;
    expect(await runDetachedVerb("start", [], true, h.deps)).toBe(0);
    // run2 was the refused one
    expect(json(h).run_id).toBe("run3");
  });

  it("without the wrapper's list a container run is taken to be alive, never failed by guess", async () => {
    const h = harness(false);
    await runDetachedVerb("start", [], true, h.deps);
    h.clock.t += 10 * CONTAINER_START_GRACE_MS;
    h.lines.length = 0;
    expect(await runDetachedVerb("status", [], true, h.deps)).toBe(0);
    expect(json(h).state).toBe("running");
  });

  it("stop marks the run stopped and frees its target, and signals no pid: the wrapper ends the container", async () => {
    const h = harness();
    await runDetachedVerb("start", [], true, h.deps);
    h.live.add("qcr-review-run1");
    h.lines.length = 0;
    expect(await runDetachedVerb("stop", ["run1"], true, h.deps)).toBe(0);
    expect(json(h)).toMatchObject({ ok: true, run_id: "run1", state: "stopped" });
    expect(h.killed).toEqual([]);
    expect(existsSync(join(h.home, "runs", "run1", "stopped.json"))).toBe(true);
    expect(readdirSync(join(h.home, "locks"))).toEqual([]);
    // the container dies a moment later without a result: still the stop that ended it
    h.live.clear();
    h.lines.length = 0;
    await runDetachedVerb("status", ["run1"], true, h.deps);
    expect(json(h).state).toBe("stopped");
  });

  it("stop of a run whose container is gone is refused: there is nothing to stop", async () => {
    const h = harness();
    await runDetachedVerb("start", [], true, h.deps);
    h.clock.t += CONTAINER_START_GRACE_MS + 1;
    h.lines.length = 0;
    expect(await runDetachedVerb("stop", ["run1"], true, h.deps)).toBe(1);
    expect(json(h).errors[0]).toMatch(/not running \(failed\)/);
  });

  it("a run id already used is not claimed again", async () => {
    const h = harness();
    h.deps.newId = () => "same";
    await runDetachedVerb("start", [], true, h.deps);
    h.deps.identify = () => ({ ok: true, key: "uncommitted:o/r@other", label: "other" });
    h.lines.length = 0;
    expect(await runDetachedVerb("start", [], true, h.deps)).toBe(1);
    expect(json(h).errors[0]).toMatch(/already used/);
  });

  it("a pid run is as it was: the container fields change nothing for it", async () => {
    const h = harness();
    h.deps.launch = () => ({ ok: true, pid: 4321 });
    h.deps.alive = (p) => p === 4321;
    await runDetachedVerb("start", [], true, h.deps);
    h.lines.length = 0;
    expect(await runDetachedVerb("status", [], true, h.deps)).toBe(0);
    expect(json(h).state).toBe("running");
    const run = JSON.parse(readFileSync(join(h.home, "runs", "run1", "run.json"), "utf8"));
    expect(run.pid).toBe(4321);
    expect(run).not.toHaveProperty("container");
  });
});

describe("the wrapper's names", () => {
  it("QCR_LIVE_REVIEWS is the set of container names, and absent means unknown", () => {
    expect(liveContainersFromEnv({})).toBeNull();
    expect(liveContainersFromEnv({ QCR_LIVE_REVIEWS: "" })).toEqual(new Set());
    expect(liveContainersFromEnv({ QCR_LIVE_REVIEWS: "qcr-review-a qcr-review-b " })).toEqual(
      new Set(["qcr-review-a", "qcr-review-b"]),
    );
  });

  it("QCR_RUN_ID and QCR_REVIEW_CONTAINER are taken together and only when well-formed", () => {
    expect(containerRunEnv({ QCR_RUN_ID: "r1", QCR_REVIEW_CONTAINER: "qcr-review-r1" })).toEqual({
      id: "r1",
      name: "qcr-review-r1",
    });
    expect(containerRunEnv({ QCR_RUN_ID: "r1" })).toBeUndefined();
    expect(containerRunEnv({ QCR_REVIEW_CONTAINER: "qcr-review-r1" })).toBeUndefined();
    for (const bad of ["../x", "-x", "a b", "a/b", ""])
      expect(containerRunEnv({ QCR_RUN_ID: bad, QCR_REVIEW_CONTAINER: "c" })).toBeUndefined();
    expect(containerRunEnv({ QCR_RUN_ID: "r", QCR_REVIEW_CONTAINER: "a;b" })).toBeUndefined();
  });

  it("the driver runs only a run claimed for its own container that has not ended", () => {
    const h = harness();
    const dir = join(h.home, "runs", "r1");
    mkdirSync(dir, { recursive: true });
    writeFileSync(
      join(dir, "run.json"),
      JSON.stringify({ run_id: "r1", key: "k", argv: ["--base", "main"], container: "c1" }),
    );
    expect(readContainerRun(h.home, "r1", "c1")).toEqual({
      dir,
      key: "k",
      argv: ["--base", "main"],
    });
    expect(readContainerRun(h.home, "r1", "c2")).toBeNull();
    expect(readContainerRun(h.home, "../r1", "c1")).toBeNull();
    expect(readContainerRun(h.home, "nope", "c1")).toBeNull();
    writeFileSync(join(dir, "stopped.json"), "{}");
    expect(readContainerRun(h.home, "r1", "c1")).toBeNull();
  });

  it("qcr live stops following a container run whose container is not listed", async () => {
    const h = harness();
    await runDetachedVerb("start", [], true, h.deps);
    const out: string[] = [];
    const deps = (live: ReadonlySet<string> | null): LiveCliDeps => ({
      home: h.home,
      out: (l) => out.push(l),
      sleep: async () => {},
      alive: () => {
        throw new Error("no pid");
      },
      liveContainers: () => live,
    });
    // no live log yet: that is its own answer, whatever the container does
    expect(await runLive(["run1"], false, deps(new Set()))).toBe(1);
  });
});

// ---- the built cli, as a container runs it ---------------------------------------------

const cli = join(root, "dist", "src", "cli.js");
const hasDist = existsSync(cli);
const git = (cwd: string, ...args: string[]): string =>
  execFileSync(
    "git",
    ["-c", "user.name=T", "-c", "user.email=t@example.com", "-c", "commit.gpgsign=false", ...args],
    { cwd, encoding: "utf8" },
  ).trim();

/** A repo with a commit and an uncommitted change. */
function fixtureRepo(name: string): string {
  const repo = join(tmp, name);
  mkdirSync(repo, { recursive: true });
  git(repo, "init", "-q", "-b", "main");
  writeFileSync(join(repo, "a.txt"), "a\n");
  git(repo, "add", "-A");
  git(repo, "commit", "-q", "-m", "base");
  git(repo, "remote", "add", "origin", "https://github.com/acme/widgets.git");
  writeFileSync(join(repo, "a.txt"), "a\nb\n");
  return repo;
}

function cliEnv(stateHome: string, extra: Record<string, string> = {}): NodeJS.ProcessEnv {
  return {
    PATH: process.env["PATH"],
    HOME: join(tmp, "cli-home"),
    QCR_APP_ROOT: root,
    QCR_CONFIG: join(root, "config.example.toml"),
    QCR_STATE_HOME: stateHome,
    ...extra,
  };
}

describe.skipIf(!hasDist)("the built cli in the env the wrapper gives a container", () => {
  it("claims the target, answers as start does, and is stopped by the wrapper's half of stop", () => {
    const repo = fixtureRepo("cli-repo");
    const state = join(tmp, "cli-state");
    const id = "20261019090000-abc123";
    const env = cliEnv(state, {
      QCR_RUN_ID: id,
      QCR_REVIEW_CONTAINER: `qcr-review-${id}`,
      QCR_LIVE_REVIEWS: "",
    });
    const start = spawnSync("node", [cli, "review", "start", "--uncommitted", "--json"], {
      cwd: repo,
      env,
      encoding: "utf8",
      timeout: 60_000,
    });
    expect(start.status, start.stderr).toBe(0);
    expect(JSON.parse(start.stdout)).toMatchObject({ ok: true, run_id: id, state: "running" });
    const dir = join(state, "review", "detached", "runs", id);
    const run = JSON.parse(readFileSync(join(dir, "run.json"), "utf8"));
    expect(run).toMatchObject({
      pid: null,
      container: `qcr-review-${id}`,
      argv: ["--uncommitted"],
    });
    expect(run.key).toBe("uncommitted:acme/widgets@main");

    // a second start of the same target, while its container is listed, is refused
    const live = { ...env, QCR_LIVE_REVIEWS: `qcr-review-${id} ` };
    const again = spawnSync("node", [cli, "review", "start", "--uncommitted", "--json"], {
      cwd: repo,
      env: { ...live, QCR_RUN_ID: "20261019090001-def456", QCR_REVIEW_CONTAINER: "qcr-review-x" },
      encoding: "utf8",
      timeout: 60_000,
    });
    expect(again.status).toBe(1);
    expect(JSON.parse(again.stdout).errors[0]).toMatch(/already running/);

    const status = spawnSync("node", [cli, "review", "status", id, "--json"], {
      cwd: repo,
      env: live,
      encoding: "utf8",
      timeout: 60_000,
    });
    expect(status.status, status.stderr).toBe(0);
    expect(JSON.parse(status.stdout)).toMatchObject({ state: "running", run_id: id });

    const stop = spawnSync("node", [cli, "review", "stop", id, "--json"], {
      cwd: repo,
      env: live,
      encoding: "utf8",
      timeout: 60_000,
    });
    expect(stop.status, stop.stderr).toBe(0);
    expect(JSON.parse(stop.stdout)).toMatchObject({ ok: true, state: "stopped" });
    expect(existsSync(join(dir, "stopped.json"))).toBe(true);
  }, 120_000);

  it("the driver refuses a container that was not claimed for it, and ends the run it was given", () => {
    const repo = fixtureRepo("cli-driver-repo");
    const state = join(tmp, "cli-driver-state");
    const id = "20261019090002-aaa111";
    const env = cliEnv(state, { QCR_RUN_ID: id, QCR_REVIEW_CONTAINER: `qcr-review-${id}` });
    const refused = spawnSync("node", [cli, "review", "--container-run", id], {
      cwd: repo,
      env,
      encoding: "utf8",
      timeout: 60_000,
    });
    expect(refused.status).toBe(1);
    expect(refused.stderr).toContain("no claimed review run");

    // the driver of the wrong id for this container is a usage error
    const wrong = spawnSync("node", [cli, "review", "--container-run", "other"], {
      cwd: repo,
      env,
      encoding: "utf8",
      timeout: 60_000,
    });
    expect(wrong.status).toBe(2);

    const start = spawnSync("node", [cli, "review", "start", "--uncommitted", "--json"], {
      cwd: repo,
      env,
      encoding: "utf8",
      timeout: 60_000,
    });
    expect(start.status, start.stderr).toBe(0);
    // The env is built from nothing: no login and no model key anywhere. Whatever the review does, it reaches no
    // model, and the driver records how it ended and frees the target.
    const noModel = { ...env, PI_CODING_AGENT_DIR: join(tmp, "no-login") };
    const driver = spawnSync("node", [cli, "review", "--container-run", id], {
      cwd: repo,
      env: { ...noModel, QCR_LIVE_REVIEWS: `qcr-review-${id}` },
      encoding: "utf8",
      timeout: 90_000,
    });
    const dir = join(state, "review", "detached", "runs", id);
    expect(existsSync(join(dir, "exit.json")), driver.stderr).toBe(true);
    expect(existsSync(join(dir, "output.jsonl"))).toBe(true);
    // what a container's stdout would have lost is in the run
    expect(existsSync(join(dir, "driver.log"))).toBe(true);
    expect(driver.stdout).toBe("");
    expect(readdirSync(join(state, "review", "detached", "locks"))).toEqual([]);
    // an ended run is not run twice
    const twice = spawnSync("node", [cli, "review", "--container-run", id], {
      cwd: repo,
      env,
      encoding: "utf8",
      timeout: 60_000,
    });
    expect(twice.status).toBe(1);
  }, 240_000);
});

// ---- real containers -------------------------------------------------------------------

// The release image is not built here (building is the release job's). These run
// the repo's own entrypoint and built code in a stock node image, started with the
// flags the wrapper gives a call, so the kernel is the one the image will meet.
const NODE_IMAGE = "node:22-bookworm";
const hasDocker = ((): boolean => {
  if (spawnSync("docker", ["image", "inspect", NODE_IMAGE], { stdio: "ignore" }).status !== 0)
    return false;
  const probe = spawnSync(
    "docker",
    ["run", "--rm", "--network", "none", NODE_IMAGE, "git", "--version"],
    { stdio: "ignore", timeout: 60_000 },
  );
  return probe.status === 0;
})();
const uid = process.getuid?.() ?? 1000;
const gid = process.getgid?.() ?? 1000;
const docker = (args: string[], timeout = 60_000): ReturnType<typeof spawnSync> =>
  spawnSync("docker", args, { encoding: "utf8", timeout });
const nodeModules = (): string => {
  // a worktree links node_modules to the main one: both must exist at their own path
  const p = join(root, "node_modules");
  return execFileSync("readlink", ["-f", p], { encoding: "utf8" }).trim();
};

describe.skipIf(!hasDocker || !hasDist)("in a container (docker, no network, no model)", () => {
  it("the claim works over a read-only /repo with --uncommitted, and status sees it", () => {
    const repo = fixtureRepo("ro-repo");
    const state = mkdtempSync(join(tmp, "ro-state-"));
    chmodSync(state, 0o777);
    const id = "20261019090003-bbb222";
    const base = [
      "run",
      "--rm",
      "--network",
      "none",
      "--init",
      "--user",
      `${uid}:${gid}`,
      "--cap-drop",
      "ALL",
      "--security-opt",
      "no-new-privileges",
      "--mount",
      `type=bind,src=${repo},dst=/repo,readonly`,
      "-w",
      "/repo",
      "--mount",
      `type=bind,src=${root},dst=${root},readonly`,
      "--mount",
      `type=bind,src=${nodeModules()},dst=${nodeModules()},readonly`,
      "--mount",
      `type=bind,src=${state},dst=/state`,
      "-e",
      "HOME=/tmp",
      "-e",
      "QCR_STATE_HOME=/state",
      "-e",
      `QCR_CONFIG=${join(root, "config.example.toml")}`,
      "-e",
      `QCR_APP_ROOT=${root}`,
      "-e",
      `QCR_RUN_ID=${id}`,
      "-e",
      `QCR_REVIEW_CONTAINER=qcr-review-${id}`,
      "-e",
      "QCR_LIVE_REVIEWS=",
      NODE_IMAGE,
      "node",
      join(root, "dist/src/cli.js"),
      "review",
    ];
    // the repo really is read-only to this container
    const touch = docker([
      "run",
      "--rm",
      "--network",
      "none",
      "--user",
      `${uid}:${gid}`,
      "--mount",
      `type=bind,src=${repo},dst=/repo,readonly`,
      NODE_IMAGE,
      "sh",
      "-c",
      "touch /repo/x 2>&1",
    ]);
    expect(touch.status).not.toBe(0);
    expect(String(touch.stdout) + String(touch.stderr)).toMatch(/read-only/i);

    const start = docker([...base, "start", "--uncommitted", "--json"]);
    expect(start.status, String(start.stderr)).toBe(0);
    expect(JSON.parse(String(start.stdout))).toMatchObject({ ok: true, run_id: id });
    const run = JSON.parse(
      readFileSync(join(state, "review", "detached", "runs", id, "run.json"), "utf8"),
    );
    expect(run.key).toBe("uncommitted:acme/widgets@main");

    const status = docker([...base, "status", id, "--json"]);
    expect(status.status, String(status.stderr)).toBe(0);
    expect(JSON.parse(String(status.stdout))).toMatchObject({ state: "running" });
    // the repo is as it was: nothing was written to it, git's index included
    expect(git(repo, "status", "--porcelain")).toBe("M a.txt");
  }, 180_000);

  it("the wrapper's stop leaves no container behind a frozen driver, within the grace", async () => {
    // A faux SDK session spinning in a synchronous loop mid-turn: no timer and no
    // signal handler of the process runs again, so only the container can end it.
    const dir = mkdtempSync(join(tmp, "freeze-"));
    chmodSync(dir, 0o777);
    const stub = writeSdkDriverStub(dir);
    const id = `20261019090004-${process.pid}`.slice(0, 40);
    const name = `qcr-review-${id}`;
    const started = docker([
      "run",
      "-d",
      "--rm",
      "--network",
      "none",
      "--init",
      "--name",
      name,
      "--label",
      "qcr.role=review",
      "--label",
      `qcr.review.run=${id}`,
      "--user",
      `${uid}:${gid}`,
      "--cap-drop",
      "ALL",
      "--security-opt",
      "no-new-privileges",
      "--mount",
      `type=bind,src=${root},dst=${root},readonly`,
      "--mount",
      `type=bind,src=${nodeModules()},dst=${nodeModules()},readonly`,
      "--mount",
      `type=bind,src=${dir},dst=${dir}`,
      "-e",
      "HOME=/tmp",
      NODE_IMAGE,
      "node",
      stub,
      dir,
      "branch:o/r@freeze",
      "freeze",
      root,
      "600000",
    ]);
    expect(started.status, String(started.stderr)).toBe(0);
    try {
      const isUp = (): boolean =>
        String(docker(["ps", "-q", "--filter", `name=^${name}$`]).stdout).trim() !== "";
      // the loop has begun when the model's turn was reached: the faux response is the loop
      await new Promise((r) => setTimeout(r, 4000));
      expect(isUp()).toBe(true);

      // the real wrapper, over the real docker for ps, stop and kill; only the call
      // into the image (which would mark the run) is a stand-in that says it did
      const bin = join(dir, "bin");
      mkdirSync(bin);
      const real = execFileSync("which", ["docker"], { encoding: "utf8" }).trim();
      writeFileSync(
        join(bin, "docker"),
        `#!/bin/sh\nif [ "$1" = run ]; then echo "$@" >> ${dir}/image-calls; exit 0; fi\nexec ${real} "$@"\n`,
        { mode: 0o755 },
      );
      const repo = fixtureRepo("freeze-repo");
      const t0 = Date.now();
      const wrapper = spawnSync(
        "sh",
        [join(root, "scripts", "qcr-host.sh"), "review", "stop", id],
        {
          cwd: repo,
          encoding: "utf8",
          timeout: 60_000,
          env: {
            PATH: `${bin}:/usr/bin:/bin`,
            HOME: join(tmp, "wrapper-home"),
            QCR_IMAGE: NODE_IMAGE,
            QCR_STOP_GRACE: "2",
            QCR_NO_UPDATE_NOTICE: "1",
          },
        },
      );
      const took = Date.now() - t0;
      expect(wrapper.status, wrapper.stderr).toBe(0);
      expect(readFileSync(join(dir, "image-calls"), "utf8")).toContain(`review stop ${id}`);
      expect(isUp()).toBe(false);
      // SIGTERM is ignored by a process stuck in a loop: the kill came at the grace's end
      expect(took).toBeGreaterThanOrEqual(1500);
      expect(took).toBeLessThan(2000 + 8000);
    } finally {
      docker(["rm", "-f", name]);
    }
  }, 120_000);

  it("the model's bash, started as the wrapper starts a call, sees no token and cannot read the token holder", () => {
    // The repo's own entrypoint (D32's uid split, D39's handoff) around a stand-in
    // cli: it takes the token with the real ghcred, then runs a probe the way the
    // engine runs pi (toolIsolation: setpriv to the tool uid), as the model's bash.
    const dir = mkdtempSync(join(tmpdir(), "qcr-inimage-"));
    chmodSync(dir, 0o755);
    try {
      const app = join(dir, "app");
      const cfg = parseConfig(readFileSync(join(root, "config.example.toml"), "utf8"));
      const put = (rel: string, text: string, mode = 0o644): void => {
        mkdirSync(dirname(join(app, rel)), { recursive: true });
        writeFileSync(join(app, rel), text, { mode });
      };
      for (const f of [
        "docker/entrypoint.sh",
        "scripts/install-locator.sh",
        "scripts/install-wrapper.sh",
        "scripts/qcr-host.sh",
        "config.example.toml",
        "docker/vm/tmux.conf",
      ]) {
        mkdirSync(dirname(join(app, f)), { recursive: true });
        copyFileSync(join(root, f), join(app, f));
      }
      chmodSync(join(app, "docker/entrypoint.sh"), 0o755);
      put(
        join("node_modules", cfg.pi.package, "package.json"),
        JSON.stringify({ version: cfg.pi.version }),
      );
      mkdirSync(join(app, "state"), { mode: 0o777 });
      chmodSync(join(app, "state"), 0o777);
      const out = join(dir, "out");
      mkdirSync(out, { mode: 0o777 });
      chmodSync(out, 0o777);
      put(
        "dist/src/cli.js",
        `import { spawnSync } from "node:child_process";
import { readdirSync, writeFileSync } from "node:fs";
const dist = ${JSON.stringify(join(root, "dist", "src"))};
const { takeHandoffToken, handedToken } = await import(dist + "/ghcred.js");
takeHandoffToken();
const iso = (await import(dist + "/engine/procruntime.js")).toolIsolation;
const probe =
  'echo "uid=$(id -u)"; env; echo "--mount"; ls -A /run/qcr-in; echo "--environ"; ' +
  'cat "/proc/$HOLDER/environ" 2>&1 | head -c 300; echo; echo "--mem"; head -c 4 "/proc/$HOLDER/mem" 2>&1 | head -c 200; echo; ' +
  'echo "--cmdline"; tr "\\\\0" " " < "/proc/$HOLDER/cmdline" 2>&1 | head -c 300';
const launch = iso("sh", ["-c", probe], process.env);
if ("refused" in launch) { console.error(launch.refused); process.exit(3); }
const r = spawnSync(launch.bin, launch.argv, {
  env: { PATH: process.env.PATH, HOME: "/tmp", HOLDER: String(process.pid) },
  encoding: "utf8",
});
writeFileSync("/out/probe.txt", (r.stdout ?? "") + (r.stderr ?? ""));
writeFileSync("/out/holder.txt", String(handedToken() === ${JSON.stringify(TOKEN)}));
`,
      );
      writeFileSync(
        join(app, "package.json"),
        JSON.stringify({ type: "module", version: "1.0.0" }),
      );
      const tokdir = join(dir, "tok");
      mkdirSync(tokdir, { mode: 0o700 });
      writeFileSync(join(tokdir, "gh-token"), TOKEN, { mode: 0o600 });
      // the user whose files the root start must read, as the wrapper's uid
      chmodSync(tokdir, 0o777);
      chmodSync(join(tokdir, "gh-token"), 0o666);
      const r = docker([
        "run",
        "--rm",
        "--network",
        "none",
        "--init",
        "--user",
        "0:0",
        "--cap-drop",
        "ALL",
        "--cap-add",
        "SETUID",
        "--cap-add",
        "SETGID",
        "--security-opt",
        "no-new-privileges",
        "--group-add",
        "4747",
        "-e",
        "QCR_RUN_UID=1000",
        "-e",
        "QCR_RUN_GID=1000",
        "-e",
        "QCR_LOGIN_GID=4747",
        "-e",
        "HOME=/tmp/qcr-home",
        "-e",
        `QCR_APP_ROOT=/opt/qcr`,
        "-e",
        `QCR_GH_TOKEN_FILE=/run/qcr-in/gh-token`,
        "-e",
        `QCR_CONFIG=/opt/qcr/config.example.toml`,
        "--tmpfs",
        "/tmp:mode=1777",
        "--mount",
        `type=bind,src=${app},dst=/opt/qcr`,
        "--mount",
        `type=bind,src=${root},dst=${root},readonly`,
        "--mount",
        `type=bind,src=${nodeModules()},dst=${nodeModules()},readonly`,
        "--mount",
        `type=bind,src=${tokdir},dst=/run/qcr-in`,
        "--mount",
        `type=bind,src=${out},dst=/out`,
        "--entrypoint",
        "/opt/qcr/docker/entrypoint.sh",
        NODE_IMAGE,
        "review",
      ]);
      expect(r.status, String(r.stderr)).toBe(0);
      const probe = readFileSync(join(out, "probe.txt"), "utf8");
      // the token holder did hold it, and then it was gone from the disk
      expect(readFileSync(join(out, "holder.txt"), "utf8")).toBe("true");
      expect(existsSync(join(tokdir, "gh-token"))).toBe(false);
      // the model's bash: another uid, no token in its env, nothing in the handoff dir,
      // and the kernel refuses the holder's environ, memory and cmdline
      expect(probe).toMatch(/uid=65534/);
      expect(probe).not.toContain(TOKEN);
      expect(probe).not.toMatch(/QCR_GH_TOKEN_FILE|GITHUB_TOKEN|GH_TOKEN/);
      const section = (name: string): string =>
        new RegExp(`--${name}\\n([\\s\\S]*?)(?=--[a-z]+\\n|$)`).exec(probe)![1]!;
      expect(section("mount").trim()).toBe("");
      expect(section("environ")).toMatch(/Permission denied/);
      expect(section("mem")).toMatch(/Permission denied/);
    } finally {
      // the container's uids created some of these
      docker([
        "run",
        "--rm",
        "--mount",
        `type=bind,src=${dir},dst=/d`,
        NODE_IMAGE,
        "sh",
        "-c",
        "rm -rf /d/* /d/.[!.]* 2>/dev/null; true",
      ]);
      rmSync(dir, { recursive: true, force: true });
    }
  }, 180_000);
});
