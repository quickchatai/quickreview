// `host setup` (src/host/setup.ts) and the walk it starts (src/host/walk.ts):
// a host starts the reviewer for its operator. Driven over the step registry
// with fake steps and adapters, as the home's switch-on is
// (tests/home-switchon.test.ts): the config and the host record are real
// files in a scratch directory, GitHub and Docker are fakes, and the detached
// process is the walk run in the test.
import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { parse } from "smol-toml";
import { parseCoreConfig } from "@quickchatai/pi-quickreview/src/reviewconfig.js";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { configFacts } from "../src/boardexport.js";
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
const progress = () => readHostProgress(w.stateDir, w.facts());
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

  // MUTATION: drop the "--auth installation needs --app-slug" check from
  // parseSetupArgs — a config with the mode and no App is written, which no
  // loader takes, and this fails.
  it("--auth installation without --app-slug is a call it cannot read", async () => {
    expect(parseSetupArgs(["--repo", REPO, "--auth", "installation"])).toMatch(
      /--auth installation needs --app-slug/,
    );
    const out = await hostSetup(w.ports, ["--repo", REPO, "--auth", "installation"]);
    expect(out).toMatchObject({ state: "refused", reason: "usage" });
    expect(w.config()).toBeNull();
    expect(w.github).toEqual([]);
    expect(w.launched).toEqual([]);
  });
});

// `--auth installation --app-slug <slug>`: an App installation's token that
// the host supplies, and no App key on the machine.
describe("an installation token", () => {
  const SLUG = "my-reviewer";
  const BOT = `${SLUG}[bot]`;
  const INSTALL = ["--repo", REPO, "--auth", "installation", "--app-slug", SLUG];
  beforeEach(() => {
    w.viewerAnswer = { status: 200, body: { data: { viewer: { login: BOT } } } };
  });
  const refusedWith = async (reason: string, said: RegExp, args = INSTALL): Promise<void> => {
    const before = w.config();
    const out = await hostSetup(w.ports, args);
    expect(out).toMatchObject({ state: "refused", reason });
    expect(out.message).toMatch(said);
    expect(w.config()).toBe(before);
    expect(w.launched).toEqual([]);
    expect(progress()).toEqual({});
  };

  // MUTATION: put the `unsupported_auth` refusal back at the top of hostSetup
  // — nothing is written and no walk starts, and this fails.
  it("records the mode, the App's slug and the login it implies, beside the marker", async () => {
    expect(await hostSetup(w.ports, INSTALL)).toEqual({ state: "started" });
    expect(github()).toMatchObject({
      token_source: "host",
      auth: "installation",
      app_slug: SLUG,
      bot_login: BOT,
      repo: REPO,
      base_branch: "trunk",
    });
    expect((parse(w.config()!) as Record<string, unknown>)["dry_run"]).toBe(true);
    // the template, line for line: every key was a line of it already
    expect(w.config()!.split("\n").length).toBe(TEMPLATE.split("\n").length);
    expect(w.launched).toHaveLength(1);
    expect(progress()).toEqual({ setup: { state: "running", step: "machine_checks" } });
    // the export names the identity a host bound
    expect(configFacts(w.config()!).identity).toEqual({ mode: "installation", login: BOT });
  });

  it("the config it writes loads as the review core reads it", async () => {
    await hostSetup(w.ports, INSTALL);
    expect(parseCoreConfig(w.config()!).github).toMatchObject({
      auth: "installation",
      token_source: "host",
      app_slug: SLUG,
      bot_login: BOT,
    });
  });

  // MUTATION: prove the token with `GET /user` (the person's route) — GitHub
  // refuses an installation token there, and here the call is seen; this fails.
  it("proves the token with the repository read, asks who it is by GraphQL, and never the user endpoint", async () => {
    await hostSetup(w.ports, INSTALL);
    expect(w.github).toEqual([
      {
        method: "GET",
        url: `https://api.github.test/repos/${REPO}`,
        authorization: `Bearer ${TOKEN}`,
      },
      {
        method: "POST",
        url: "https://api.github.test/graphql",
        authorization: `Bearer ${TOKEN}`,
      },
    ]);
    expect(w.github.some((c) => /\/user$/.test(c.url))).toBe(false);
    expect(w.calls).toEqual([]);
  });

  // MUTATION: drop identityRefusal from hostSetup — a slug that names another
  // App is written, the reviewer never recognises its own reviews, and this fails.
  it("refuses a token that is not the App the slug names, naming both, before anything is written", async () => {
    w.viewerAnswer = { status: 200, body: { data: { viewer: { login: "other-app[bot]" } } } };
    await refusedWith(
      "identity_mismatch",
      /acts as other-app\[bot\].*set up to post as my-reviewer\[bot\].*--app-slug my-reviewer/,
    );
    // case is not a difference: GitHub's logins compare without it
    w.viewerAnswer = { status: 200, body: { data: { viewer: { login: "My-Reviewer[bot]" } } } };
    expect(await hostSetup(w.ports, INSTALL)).toEqual({ state: "started" });
  });

  it("a token that cannot say who it is refuses the setup too: unknown is not a match", async () => {
    w.viewerAnswer = { status: 200, body: { data: { viewer: null } } };
    await refusedWith("github_unreachable", /did not say who the token is.*my-reviewer\[bot\]/);
    w.viewerAnswer = { status: 0, body: null };
    await refusedWith("github_unreachable", /could not be reached/);
    w.viewerAnswer = { status: 401, body: { message: "Bad credentials" } };
    await refusedWith("github_token_rejected", /refused the token/);
  });

  it("a person's token needs no such check: the user route asks GraphQL nothing", async () => {
    expect(await hostSetup(w.ports, ARGS)).toEqual({ state: "started" });
    expect(w.github.map((c) => c.url)).toEqual([`https://api.github.test/repos/${REPO}`]);
  });

  it("keeps the identity it was set up with: another mode, or another App, is refused", async () => {
    expect(await hostSetup(w.ports, INSTALL)).toEqual({ state: "started" });
    expect(await runWalk()).toBe(0);
    const asked = w.github.length;
    const written = w.config();
    for (const [args, said] of [
      [ARGS, /set up with auth = "installation", not "user"/],
      [
        ["--repo", REPO, "--auth", "installation", "--app-slug", "other-app"],
        /set up to post as my-reviewer\[bot\], not other-app\[bot\]/,
      ],
    ] as const) {
      const out = await hostSetup(w.ports, args);
      expect(out).toMatchObject({ state: "refused", reason: "auth_mismatch" });
      expect(out.message).toMatch(said);
    }
    // neither refusal asked GitHub anything, wrote anything or started a walk
    expect(w.github).toHaveLength(asked);
    expect(w.config()).toBe(written);
    expect(w.launched).toHaveLength(1);
    // the same call again is the same reviewer
    expect(await hostSetup(w.ports, INSTALL)).toEqual({ state: "started" });
    expect(w.config()).toBe(written);
  });

  it("the checklist's proved App counts where the config says nothing yet", () => {
    const asked = { repo: REPO, auth: "installation" as const, appSlug: SLUG };
    expect(bindingMismatch(asked, null, {})).toBeNull();
    expect(bindingMismatch(asked, MARKER_ONLY, {})).toBeNull();
    // a template's empty login, or a person's, names no App
    expect(bindingMismatch(asked, TEMPLATE, {})).toBeNull();
    expect(bindingMismatch(asked, null, { [CHOICE_KEYS.appSlug]: SLUG })).toBeNull();
    expect(bindingMismatch(asked, null, { [CHOICE_KEYS.appSlug]: "other-app" })).toMatchObject({
      reason: "auth_mismatch",
    });
    expect(bindingMismatch(asked, null, { [CHOICE_KEYS.githubAuth]: "user" })).toMatchObject({
      reason: "auth_mismatch",
    });
  });
});

describe("starting the reviewer", () => {
  it("writes the config from the template and starts the walk, detached", async () => {
    const out = await hostSetup(w.ports, ARGS);
    expect(out).toEqual({ state: "started" });
    // the config: the template, the repository as GitHub spells it, its own branch
    expect(github()).toMatchObject({ repo: REPO, base_branch: "trunk" });
    // and the install is its host's from its first line: the marker, with the mode
    expect(github()).toMatchObject({ token_source: "host", auth: "user" });
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

  // A host verb acts on installs a host manages, and never makes one.
  // MUTATION: drop the marker check from hostSetup — the repository is
  // written into an install that keeps its own credential, a walk starts, and
  // its account step takes the person's own route (`gh`, and its token over
  // the file a host keeps); this fails.
  it("a config that is there and does not carry the host-managed marker", async () => {
    // the refusal comes before the lock: it leaves no file behind
    w.writeConfig(TEMPLATE);
    expect(await hostSetup(w.ports, ARGS)).toMatchObject({ reason: "not_host_managed" });
    expect(existsSync(dirname(checklistLockPath(w.stateDir)))).toBe(false);
    for (const unmarked of [
      TEMPLATE,
      setUpConfig({ hosted: false }),
      '[github]\nauth = "user"\n',
      '[github]\ntoken_source = "self"\nauth = "user"\n',
      "",
    ]) {
      w.writeConfig(unmarked);
      await refusedWith("not_host_managed", /never makes an install host-managed/);
    }
    // nothing was asked of GitHub, and no command was run
    expect(w.github).toEqual([]);
    expect(w.calls).toEqual([]);
    // the same call on the marker is admitted
    w.writeConfig(MARKER_ONLY);
    expect(await hostSetup(w.ports, ARGS)).toEqual({ state: "started" });
  });

  // The marker is asked before the lock, and again under it on the text the
  // config is written from.
  // MUTATION: drop the second check, under the lock — a config whose owner
  // took it back between the two reads has the repository written into it and
  // a walk started on it; this fails.
  it("a config that lost its marker between the first look and the lock", async () => {
    w.writeConfig(MARKER_ONLY);
    const own = setUpConfig({ hosted: false });
    let reads = 0;
    const racing = {
      ...w.ports,
      read: (path: string): string => {
        const text = w.ports.read(path);
        if (path === w.configPath && ++reads === 1) w.writeConfig(own);
        return text;
      },
    };
    const out = await hostSetup(racing, ARGS);
    expect(out).toMatchObject({ state: "refused", reason: "not_host_managed" });
    expect(w.config()).toBe(own);
    expect(w.launched).toEqual([]);
    expect(w.github).toEqual([]);
    expect(progress()).toEqual({});
    // the lock it took is free again
    const free = acquireChecklistLock(w.stateDir, "home", { pid: WALK_PID });
    expect(free.ok).toBe(true);
    if (free.ok) free.lock.release();
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

  // MUTATION: write a new config without the marker (drop `marks` from
  // renderHostConfig) — the walk's account step would run `gh` on a machine
  // its host set up, and this fails.
  it("a machine with no config is made one: the marker, the mode, the filers off, in dry-run", async () => {
    expect(w.config()).toBeNull();
    expect(await hostSetup(w.ports, ARGS)).toEqual({ state: "started" });
    const cfg = parse(w.config()!) as Record<string, Record<string, unknown>>;
    expect(cfg["github"]).toMatchObject({
      token_source: "host",
      auth: "user",
      repo: REPO,
      base_branch: "trunk",
    });
    expect(cfg["caps"]).toMatchObject({
      improvement_pr_per_day: 0,
      improvement_pr_per_week: 0,
      issues_per_day: 0,
    });
    expect((cfg as Record<string, unknown>)["dry_run"]).toBe(true);
    // the template, line for line: the two keys were commented out in it
    expect(w.config()!.split("\n").length).toBe(TEMPLATE.split("\n").length);
    // and a second call finds the install it made, and rewrites nothing
    const first = w.config();
    expect(await runWalk()).toBe(0);
    expect(await hostSetup(w.ports, ARGS)).toEqual({ state: "started" });
    expect(w.config()).toBe(first);
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

  // A machine stopped or restarted mid-walk comes back with the lock file on
  // disk and its pid given to some other process.
  // MUTATION: judge the lock's holder by its pid alone — `host setup` answers
  // `running` for ever and the export says the setup still runs; this fails.
  it("a walk the machine was restarted under is interrupted, and the next call takes its lock over", async () => {
    w.bootId = "boot-1";
    w.startTimes.set(WALK_PID, "5000");
    await started();
    expect(lockOnDisk()).toMatchObject({ pid: WALK_PID, boot_id: "boot-1", start_time: "5000" });
    expect(await hostSetup(w.ports, ARGS)).toEqual({ state: "running" });
    // the restart: another boot, and the walk's pid is a living stranger's
    w.bootId = "boot-2";
    w.startTimes.set(WALK_PID, "17");
    expect(w.alivePids.has(WALK_PID)).toBe(true);
    expect(progress()).toEqual({
      setup: { state: "failed", step: "machine_checks", problem: "interrupted" },
    });
    expect(await hostSetup(w.ports, ARGS)).toEqual({ state: "started" });
    expect(w.launched).toHaveLength(2);
    expect(lockOnDisk()).toMatchObject({ boot_id: "boot-2", token: w.launched[1]!.token });
    expect(await runWalk()).toBe(0);
    expect(progress()).toEqual({ setup: { state: "done" } });
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
