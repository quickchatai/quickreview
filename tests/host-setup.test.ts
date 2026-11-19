// `host setup` (src/host/setup.ts) and the walk it starts (src/host/walk.ts):
// a host starts the reviewer for its operator. Driven over the step registry
// with fake steps and adapters, as the home's switch-on is
// (tests/home-switchon.test.ts): the config and the host record are real
// files in a scratch directory, GitHub and Docker are fakes, and the detached
// process is the walk run in the test.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { parse } from "smol-toml";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { SWITCH_ON_ORDER, runSwitchOn } from "../src/home/switchon.js";
import { SETUP_STEPS } from "../src/host/outcomes.js";
import { readHostProgress, readHostRecord } from "../src/host/record.js";
import { bindingMismatch, hostSetup, parseSetupArgs } from "../src/host/setup.js";
import { setupProblem, walkSetup } from "../src/host/walk.js";
import { acquireChecklistLock, checklistLockPath } from "../src/onboard/checklistlock.js";
import { CHOICE_KEYS } from "../src/onboard/choices.js";
import { GO_LIVE_CONFIRMATION, GO_LIVE_STEP_ID } from "../src/onboard/steps/golive.js";
import { PROOF_STEP_ID } from "../src/onboard/steps/proof.js";
import {
  MARKER_ONLY,
  REPO,
  TEMPLATE,
  TOKEN,
  WALK_PID,
  hostWorld,
  setUpConfig,
  type HostWorld,
} from "./helpers/host-rig.js";

const ARGS = ["--repo", REPO, "--auth", "user"];

let w: HostWorld;
beforeEach(() => {
  w = hostWorld();
});
afterEach(() => w.close());

const github = (): Record<string, unknown> =>
  (parse(w.config() ?? "") as Record<string, Record<string, unknown>>)["github"] ?? {};
const progress = () => readHostProgress(w.stateDir, { alive: (p) => w.alivePids.has(p) });
const lockOnDisk = (): Record<string, unknown> =>
  JSON.parse(readFileSync(checklistLockPath(w.stateDir), "utf8")) as Record<string, unknown>;
/** Run the walk the verb started, as the detached process would. */
const runWalk = (): Promise<number> => walkSetup(w.walker(), w.launched.at(-1)!.token);

describe("the arguments", () => {
  it("reads --repo, --auth and --app-slug, in either spelling", () => {
    expect(parseSetupArgs(ARGS)).toEqual({ repo: REPO, auth: "user" });
    expect(parseSetupArgs([`--repo=${REPO}`, "--auth=user"])).toEqual({ repo: REPO, auth: "user" });
    expect(
      parseSetupArgs(["--auth", "installation", "--repo", REPO, "--app-slug", "my-reviewer"]),
    ).toEqual({ repo: REPO, auth: "installation", appSlug: "my-reviewer" });
  });

  it("says what is wrong with a call it cannot read", () => {
    for (const [args, said] of [
      [[], /--repo is missing/],
      [["--repo", REPO], /--auth is missing/],
      [["--repo", "not a repo", "--auth", "user"], /is not owner\/name/],
      [["--repo", `https://github.com/${REPO}`, "--auth", "user"], /is not owner\/name/],
      [["--repo", REPO, "--auth", "app"], /neither user nor installation/],
      [["--repo", REPO, "--auth"], /--auth names nothing/],
      [[...ARGS, "--repo", REPO], /--repo is given twice/],
      [[...ARGS, "--confirm", "GO LIVE"], /is not an argument of host setup/],
      [[...ARGS, "--app-slug", "x"], /goes with --auth installation/],
      [["--repo", REPO, "--auth", "installation", "--app-slug", "a b"], /not a GitHub App slug/],
    ] as const)
      expect(parseSetupArgs(args), args.join(" ")).toMatch(said);
  });

  it("a call it cannot read is refused as usage, and nothing is touched", async () => {
    const out = await hostSetup(w.ports, ["--repo", REPO]);
    expect(out).toMatchObject({ state: "refused", reason: "usage" });
    expect(out.message).toMatch(/usage: qcr --schema 3 host setup/);
    expect(w.config()).toBeNull();
    expect(w.github).toEqual([]);
    expect(w.launched).toEqual([]);
  });

  // MUTATION: let `--auth installation` through to the walk — this fails.
  it("--auth installation is read, and refused as not in this release yet", async () => {
    const out = await hostSetup(w.ports, [
      "--repo",
      REPO,
      "--auth",
      "installation",
      "--app-slug",
      "my-reviewer",
    ]);
    expect(out).toMatchObject({ state: "refused", reason: "unsupported_auth" });
    expect(out.message).toMatch(/not supported by this release yet/);
    expect(w.config()).toBeNull();
    expect(w.launched).toEqual([]);
  });
});

describe("starting the reviewer", () => {
  it("writes the config from the template and starts the walk, detached", async () => {
    const out = await hostSetup(w.ports, ARGS);
    expect(out).toEqual({ state: "started" });
    // the config: the template, the repository as GitHub spells it, its own branch
    expect(github()).toMatchObject({ repo: REPO, base_branch: "trunk" });
    expect((parse(w.config()!) as Record<string, unknown>)["dry_run"]).toBe(true);
    // one walk, told the lock's token
    expect(w.launched).toHaveLength(1);
    expect(w.launched[0]!.kind).toBe("setup");
    expect(w.seeded).toBe(1);
    // the board export already says it runs
    expect(progress()).toEqual({ setup: { state: "running", step: "machine_checks" } });
  });

  // MUTATION: read the base branch with `gh repo view` (the home's port)
  // instead of the token file — no Docker or gh call may precede the walk,
  // and this fails.
  it("reads the repository with the token file's token, and runs no command", async () => {
    await hostSetup(w.ports, ARGS);
    expect(w.github).toEqual([
      {
        method: "GET",
        url: `https://api.github.test/repos/${REPO}`,
        authorization: `Bearer ${TOKEN}`,
      },
    ]);
    expect(w.calls).toEqual([]);
  });

  // MUTATION: release the lock when the verb returns `started` — the second
  // call starts a second walk, and this fails.
  it("is single-flight: the lock goes to the walk, and a second call answers `running`", async () => {
    expect(await hostSetup(w.ports, ARGS)).toEqual({ state: "started" });
    expect(lockOnDisk()).toMatchObject({
      holder: "setup",
      pid: WALK_PID,
      token: w.launched[0]!.token,
    });
    expect(await hostSetup(w.ports, ARGS)).toEqual({ state: "running" });
    expect(w.launched).toHaveLength(1);
    // once the walk has ended a new one may start
    expect(await runWalk()).toBe(0);
    expect(await hostSetup(w.ports, ARGS)).toEqual({ state: "started" });
    expect(w.launched).toHaveLength(2);
  });

  it("answers `busy`, with the holder, while the home or another verb holds the lock", async () => {
    const home = acquireChecklistLock(w.stateDir, "home", {
      pid: WALK_PID,
      alive: (p) => w.alivePids.has(p),
    });
    expect(home.ok).toBe(true);
    expect(await hostSetup(w.ports, ARGS)).toEqual({ state: "busy", holder: "home" });
    expect(w.config()).toBeNull();
    expect(w.launched).toEqual([]);
  });

  it("a walk that cannot be started is refused, and the lock is free again", async () => {
    w.launchError = "spawn EAGAIN";
    const out = await hostSetup(w.ports, ARGS);
    expect(out).toMatchObject({ state: "refused", reason: "launch_failed" });
    expect(progress()).toEqual({ setup: { state: "failed", problem: "internal_error" } });
    w.launchError = null;
    expect(await hostSetup(w.ports, ARGS)).toEqual({ state: "started" });
  });
});

describe("what it refuses, in words, before anything is written", () => {
  const refusedWith = async (reason: string, said: RegExp, args = ARGS): Promise<void> => {
    const before = w.config();
    const out = await hostSetup(w.ports, args);
    expect(out).toMatchObject({ state: "refused", reason });
    expect(out.message).toMatch(said);
    expect(w.config()).toBe(before);
    expect(w.launched).toEqual([]);
    expect(progress()).toEqual({});
    // and the lock is free for the next call
    const free = acquireChecklistLock(w.stateDir, "home", { pid: WALK_PID });
    expect(free.ok).toBe(true);
    if (free.ok) free.lock.release();
  };

  // MUTATION: drop the model-login check — the walk starts and fails minutes
  // later at the login step, and this fails.
  it("a missing model login", async () => {
    w.ports.write(join(w.agentDir, "auth.json"), "{}");
    await refusedWith("model_login_missing", /no model login in .* sign in to a model provider/);
  });

  it("a model login it cannot read", async () => {
    w.ports.write(join(w.agentDir, "auth.json"), "{ not json");
    await refusedWith("model_login_unreadable", /cannot be read/);
  });

  it("no token file, or one that holds no single token", async () => {
    w.ports.write(join(w.secretsDir, "github_token"), "");
    await refusedWith("github_token_missing", /managed by its host/);
    w.ports.write(join(w.secretsDir, "github_token"), "one two");
    await refusedWith("github_token_unreadable", /more than one token-shaped word/);
    // never a word that sends the person to sign in on this machine
    const out = await hostSetup(w.ports, ARGS);
    expect(out.message).not.toMatch(/gh auth login|github-token sync/);
  });

  it("a token GitHub refuses, a repository it cannot read, GitHub out of reach", async () => {
    w.repoAnswer = { status: 401, body: { message: "Bad credentials" } };
    await refusedWith("github_token_rejected", /refused the token/);
    w.repoAnswer = { status: 404, body: { message: "Not Found" } };
    await refusedWith("repo_unreachable", /cannot read acme\/widgets/);
    w.repoAnswer = { status: 0, body: null };
    await refusedWith("github_unreachable", /could not be reached/);
    w.repoAnswer = { status: 200, body: { full_name: "acme/renamed", default_branch: "main" } };
    await refusedWith("repo_unreachable", /renamed or moved/);
    w.repoAnswer = { status: 200, body: { full_name: REPO, archived: true } };
    await refusedWith("repo_unreachable", /archived/);
  });

  // MUTATION: drop bindingMismatch from hostSetup — a second repository is
  // written over the first, and this fails.
  it("a repository other than the one the config records", async () => {
    w.writeConfig(setUpConfig());
    await refusedWith(
      "repo_mismatch",
      /set up for acme\/widgets, not acme\/other.*keeps the repository/,
      ["--repo", "acme/other", "--auth", "user"],
    );
    // nothing was asked of GitHub about the other repository
    expect(w.github).toEqual([]);
  });

  it("an auth mode other than the one the config records", async () => {
    w.writeConfig(setUpConfig().replace('auth = "user"', 'auth = "app"'));
    await refusedWith("auth_mismatch", /set up with auth = "app", not "user"/);
  });

  it("the checklist's record counts too, where the config says nothing yet", () => {
    const asked = { repo: REPO, auth: "user" as const };
    expect(bindingMismatch(asked, null, {})).toBeNull();
    expect(bindingMismatch(asked, TEMPLATE, {})).toBeNull();
    expect(bindingMismatch(asked, MARKER_ONLY, {})).toBeNull();
    // the same repository in another case is the same repository
    expect(bindingMismatch(asked, null, { [CHOICE_KEYS.accountRepo]: "Acme/Widgets" })).toBeNull();
    expect(bindingMismatch(asked, null, { [CHOICE_KEYS.accountRepo]: "acme/other" })).toMatchObject(
      { reason: "repo_mismatch" },
    );
    expect(bindingMismatch(asked, null, { [CHOICE_KEYS.githubAuth]: "app" })).toMatchObject({
      reason: "auth_mismatch",
    });
    expect(bindingMismatch(asked, null, { [CHOICE_KEYS.githubAuth]: "user" })).toBeNull();
  });

  it("a config that is not TOML", async () => {
    w.writeConfig("[github\nrepo = ");
    await refusedWith("config_invalid", /not valid TOML/);
  });
});

describe("a host-managed install", () => {
  // MUTATION: drop the host-managed caps from renderHostConfig — this fails.
  it("gets its improvement-PR filer and its bot-filed issues turned off", async () => {
    w.writeConfig(MARKER_ONLY);
    expect(await hostSetup(w.ports, ARGS)).toEqual({ state: "started" });
    const cfg = parse(w.config()!) as Record<string, Record<string, unknown>>;
    expect(cfg["github"]).toMatchObject({ token_source: "host", repo: REPO, base_branch: "trunk" });
    expect(cfg["caps"]).toMatchObject({
      improvement_pr_per_day: 0,
      improvement_pr_per_week: 0,
      issues_per_day: 0,
    });
    // it comes up in dry-run: the completed config states the template's flag
    expect((cfg as Record<string, unknown>)["dry_run"]).toBe(true);
  });

  it("an install that keeps its own credential keeps its filers", async () => {
    await hostSetup(w.ports, ARGS);
    const cfg = parse(w.config()!) as Record<string, Record<string, unknown>>;
    expect(cfg["caps"]).toEqual((parse(TEMPLATE) as typeof cfg)["caps"]);
  });

  it("a second setup of the same repository rewrites nothing", async () => {
    w.writeConfig(MARKER_ONLY);
    await hostSetup(w.ports, ARGS);
    const first = w.config();
    expect(await runWalk()).toBe(0);
    expect(await hostSetup(w.ports, ARGS)).toEqual({ state: "started" });
    expect(w.config()).toBe(first);
  });
});

describe("the walk", () => {
  const started = async (): Promise<void> => {
    w.writeConfig(MARKER_ONLY);
    expect(await hostSetup(w.ports, ARGS)).toEqual({ state: "started" });
  };

  it("runs the machine checks, then switch-on's steps in order with the silent defaults", async () => {
    await started();
    expect(await runWalk()).toBe(0);
    expect(w.ran.map((r) => r.id)).toEqual(
      SWITCH_ON_ORDER.slice(0, SWITCH_ON_ORDER.indexOf(PROOF_STEP_ID)),
    );
    const input = (id: string) => w.ran.find((r) => r.id === id)!.input;
    expect(input("machine_checks")).toEqual({});
    expect(input("topology")).toEqual({ choice: "local" });
    expect(input("github_account")).toEqual({ github_auth: "user", repo: REPO });
    expect(input("escalation")).toEqual({ enable: "no" });
    expect(input("embeddings")).toEqual({});
    expect(input("ingress")).toEqual({ choice: "polling" });
    // memory is left as the steps leave it
    expect(input("memory")).toEqual({});
    expect(progress()).toEqual({ setup: { state: "done" } });
    expect(w.logs.join("\n")).toMatch(/on in dry-run/);
  });

  // MUTATION: walk the proof round or the go-live at the end of the setup, or
  // hand any step the go-live confirm — this fails.
  it("comes up in dry-run: it never runs the practice review or the go-live", async () => {
    await started();
    await runWalk();
    expect(w.ran.map((r) => r.id)).not.toContain(PROOF_STEP_ID);
    expect(w.ran.map((r) => r.id)).not.toContain(GO_LIVE_STEP_ID);
    expect(JSON.stringify(w.ran)).not.toContain(GO_LIVE_CONFIRMATION);
    expect((parse(w.config()!) as Record<string, unknown>)["dry_run"]).toBe(true);
  });

  it("holds the lock while it runs, and frees it when it ends", async () => {
    await started();
    const walk = runWalk();
    const during = await hostSetup(w.ports, ARGS);
    expect(await walk).toBe(0);
    expect(during).toEqual({ state: "running" });
    expect(acquireChecklistLock(w.stateDir, "home", { pid: WALK_PID }).ok).toBe(true);
  });

  // MUTATION: record the failure without its step or its problem — this fails.
  it("stops at the first step that fails, with the step and a closed problem", async () => {
    await started();
    w.fail = { id: "bringup", check: "compose-up" };
    expect(await runWalk()).toBe(1);
    expect(w.ran.at(-1)!.id).toBe("bringup");
    expect(progress()).toEqual({
      setup: { state: "failed", step: "bringup", problem: "start_failed" },
    });
    // the step's own words go to the walk's log, never to the record
    expect(w.logs.join("\n")).toMatch(/it broke/);
    expect(JSON.stringify(readHostRecord(w.stateDir))).not.toMatch(/it broke/);
  });

  it("a machine that cannot run it fails at the machine checks, by its failed check", async () => {
    for (const [check, problem] of [
      ["docker", "docker_unavailable"],
      ["disk", "disk_low"],
      ["ports", "port_in_use"],
      ["uid", "machine_check_failed"],
    ] as const) {
      w.close();
      w = hostWorld();
      await started();
      w.fail = { id: "machine_checks", check };
      expect(await runWalk()).toBe(1);
      expect(w.ran.map((r) => r.id)).toEqual(["machine_checks"]);
      expect(progress()).toEqual({
        setup: { state: "failed", step: "machine_checks", problem },
      });
    }
  });

  it("a second walk after a failure keeps the steps that were done", async () => {
    await started();
    w.fail = { id: "bringup", check: "compose-up" };
    await runWalk();
    w.fail = null;
    w.ran.length = 0;
    expect(await hostSetup(w.ports, ARGS)).toEqual({ state: "started" });
    expect(await runWalk()).toBe(0);
    // the two that act on the running machine, and everything from the failure on
    expect(w.ran.map((r) => r.id)).toEqual([
      "machine_checks",
      "daemon_start",
      "bringup",
      "memory_user_keys",
      "verify_stack",
    ]);
    expect(progress()).toEqual({ setup: { state: "done" } });
  });

  // What the walk reads off switch-on (src/home/switchon.ts): the step about
  // to run, and where a failed walk stopped.
  // MUTATION: drop the `onStep` call in runSteps, or the `failed` field of a
  // failed outcome — this fails.
  it("switch-on names each step as it starts, and the step and checks it failed at", async () => {
    const walk = (onStep: (id: string) => void) =>
      runSwitchOn({
        checklist: w.ports.checklist(w.ports.registry()),
        answers: { memory: null, confirmed: true },
        repo: null,
        dryRun: () => true,
        stopMemory: async () => ({ ok: true, detail: "" }),
        onStep,
      });
    const seen: string[] = [];
    const out = await walk((id) => void seen.push(id));
    expect(out.ok).toBe(true);
    expect(out).not.toHaveProperty("failed");
    expect(seen).toEqual(SWITCH_ON_ORDER.slice(1, SWITCH_ON_ORDER.indexOf(PROOF_STEP_ID)));
    w.fail = { id: "daemon_start", check: "daemon" };
    const again: string[] = [];
    const stopped = await walk((id) => void again.push(id));
    expect(stopped.failed).toEqual({ step: "daemon_start", checks: ["daemon"] });
    // only the step that runs every time was reached again
    expect(again).toEqual(["daemon_start"]);
  });

  // MUTATION: let walkSetup run without adopting the lock — this fails.
  it("a walk nobody handed the lock to runs nothing", async () => {
    await started();
    expect(await walkSetup(w.walker(), "not-the-token")).toBe(1);
    expect(w.ran).toEqual([]);
    expect(progress()).toEqual({ setup: { state: "running", step: "machine_checks" } });
    // nor one started from a session, with the right token
    w.env = { QCR_SESSION_NAME: "pr-7" };
    expect(await runWalk()).toBe(1);
    expect(w.ran).toEqual([]);
  });

  it("a walk whose process dies is said as interrupted", async () => {
    await started();
    w.alivePids.delete(WALK_PID);
    expect(progress()).toEqual({
      setup: { state: "failed", step: "machine_checks", problem: "interrupted" },
    });
  });
});

describe("the closed words", () => {
  // MUTATION: add a step to switch-on's order without the host's closed set
  // (and the board schema) — this fails.
  it("the steps a setup can be at are switch-on's, without the two it never walks", () => {
    expect([...SETUP_STEPS]).toEqual(
      SWITCH_ON_ORDER.filter((id) => id !== PROOF_STEP_ID && id !== GO_LIVE_STEP_ID),
    );
  });

  it("every step has a problem word, and an unknown one is `step_failed`", () => {
    expect(setupProblem("github_account", ["token"])).toBe("github_failed");
    expect(setupProblem("login_share", ["login"])).toBe("model_login_missing");
    expect(setupProblem("login_share", ["daemon"])).toBe("start_failed");
    expect(setupProblem("memory", ["user-keys"])).toBe("memory_failed");
    expect(setupProblem("memory_user_keys", [])).toBe("memory_failed");
    expect(setupProblem("daemon_start", ["daemon"])).toBe("start_failed");
    expect(setupProblem("verify_stack", ["health"])).toBe("verify_failed");
    expect(setupProblem("ingress", ["choice"])).toBe("step_failed");
    expect(setupProblem("a step from the future", [])).toBe("step_failed");
  });
});
