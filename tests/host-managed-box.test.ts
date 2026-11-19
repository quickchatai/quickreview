// A host-managed box, from its host's marker to a reviewer in dry-run: the
// three parts of the host contract at the seams between them.
//
//   the setup verb   src/host/setup.ts writes the config beside the marker
//   the walk         src/host/walk.ts runs switch-on's steps, and here the
//                    wizard's REAL account step
//                    (src/onboard/steps/githubaccount.ts) on its host route
//   the export       src/boardexport.ts reads what the two left
//
// Each part has its own suite over fakes of the others (tests/host-setup,
// tests/onboard-githubaccount, tests/board-export). This one holds what only
// shows when they meet: the config the verb writes is one the account step
// takes the host route on, the token file is found in one place by all three,
// the identity the step proves is the one the export prints, and a failure of
// the step reaches a host as a closed word. Every other step is a fake;
// GitHub and Docker are fakes; the files are real, in a scratch directory.
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { parse } from "smol-toml";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { configFacts, githubWord } from "../src/boardexport.js";
import { loadConfig } from "../src/config.js";
import { loadOneShotConfig } from "../src/homes.js";
import { readHostProgress } from "../src/host/record.js";
import { hostSetup } from "../src/host/setup.js";
import { walkSetup } from "../src/host/walk.js";
import { secretsDirAt } from "../src/hostmanaged.js";
import { CHOICE_KEYS } from "../src/onboard/choices.js";
import type { OnboardAdapters } from "../src/onboard/engine.js";
import { GITHUB_ACCOUNT_STEP_ID, githubAccountStep } from "../src/onboard/steps/githubaccount.js";
import { secretsDirFor } from "../src/onboard/steps/ingress.js";
import {
  MARKER_ONLY,
  REPO,
  TEMPLATE,
  TOKEN,
  hostWorld,
  type HostWorld,
} from "./helpers/host-rig.js";

const ROOT = join(import.meta.dirname, "..");
const ARGS = ["--repo", REPO, "--auth", "user"];
/** What a host's installer writes before the home first opens: the marker,
 * and the mode whose credential is the file it keeps. */
const MARKER = '[github]\ntoken_source = "host"\nauth = "user"\n';

let w: HostWorld;
beforeEach(() => {
  w = hostWorld();
  // a new box: no stack runs yet
  w.daemon.running = false;
  w.real = [
    githubAccountStep({ apiBase: "https://api.github.test", env: {}, secretsDir: w.secretsDir }),
  ];
});
afterEach(() => w.close());

const read = (path: string): string => readFileSync(path, "utf8");
const runWalk = (): Promise<number> => walkSetup(w.walker(), w.launched.at(-1)!.token);
const progress = () => readHostProgress(w.stateDir, { alive: (p) => w.alivePids.has(p) });
const tokenWord = () =>
  githubWord({ config: w.config(), secretsDir: w.secretsDir, now: w.now, read });
/** The config as the home's own review loads it. */
const oneShot = () =>
  loadOneShotConfig({ root: ROOT, env: { HOME: w.root, QCR_CONFIG: w.configPath } }).cfg;

describe.each([
  ["the marker and its mode", MARKER],
  ["the marker alone", MARKER_ONLY],
])("a box whose host wrote %s", (_name, marker) => {
  beforeEach(() => w.writeConfig(marker));

  it("says its token has arrived before any setup", () => {
    expect(tokenWord()).toBe("ok");
    expect(configFacts(w.config()!).repo).toBeUndefined();
  });

  // MUTATION: drop the `auth` edit from renderHostConfig — under the marker
  // alone the config the verb leaves does not load, and this fails.
  it("is left, by the verb alone, a config the home's own review loads", async () => {
    expect(await hostSetup(w.ports, ARGS)).toEqual({ state: "started" });
    const github = oneShot().github;
    expect(github).toMatchObject({ token_source: "host", auth: "user", repo: REPO });
    expect(github.secrets_dir).not.toBe("");
  });

  // MUTATION: have `host setup` drop the marker from the config it writes —
  // the account step takes the person's own route and runs `gh`; this fails.
  it("comes up in dry-run on the token its host wrote: no gh, no crontab, no write to GitHub", async () => {
    expect(await hostSetup(w.ports, ARGS)).toEqual({ state: "started" });
    expect(await runWalk(), w.logs.join("\n")).toBe(0);

    // Docker is the only program run; the token file is as the host wrote it
    expect([...new Set(w.calls.map((c) => c[0]))]).toEqual(["docker"]);
    expect(read(join(w.secretsDir, "github_token"))).toBe(`${TOKEN}\n`);
    // GitHub was read, with the file's token, and nothing was written there
    expect(w.github.map((c) => c.method)).toEqual(w.github.map(() => "GET"));
    expect(w.github.every((c) => c.authorization === `Bearer ${TOKEN}`)).toBe(true);
    expect(w.github.map((c) => new URL(c.url).pathname)).toEqual(
      expect.arrayContaining(["/user", `/repos/${REPO}`]),
    );

    // the daemon's own loader takes the config, in dry-run, with the filers off
    const cfg = loadConfig(w.configPath);
    expect(cfg.dry_run).toBe(true);
    expect(cfg.github).toMatchObject({
      token_source: "host",
      auth: "user",
      repo: REPO,
      base_branch: "trunk",
      bot_login: "octo-dev",
    });
    expect(cfg.caps).toMatchObject({
      improvement_pr_per_day: 0,
      improvement_pr_per_week: 0,
      issues_per_day: 0,
    });
    // the template's own flag line, untouched
    expect(/^dry_run\s*=.*$/m.exec(w.config()!)?.[0]).toBe(/^dry_run\s*=.*$/m.exec(TEMPLATE)?.[0]);

    // what a host reads back: the identity the step proved, and a setup that is done
    expect(configFacts(w.config()!)).toMatchObject({
      repo: REPO,
      identity: { mode: "user", login: "octo-dev" },
      dry_run: true,
    });
    expect(tokenWord()).toBe("ok");
    expect(progress()).toEqual({ setup: { state: "done" } });
    expect(w.checklist()!.choices).toMatchObject({
      [CHOICE_KEYS.githubAuth]: "user",
      [CHOICE_KEYS.accountRepo]: REPO,
    });
  });

  it("keeps the repository and the identity it came up with", async () => {
    await hostSetup(w.ports, ARGS);
    expect(await runWalk()).toBe(0);
    const before = w.config();
    expect(await hostSetup(w.ports, ["--repo", "acme/other", "--auth", "user"])).toMatchObject({
      state: "refused",
      reason: "repo_mismatch",
    });
    expect(w.config()).toBe(before);
    // the same call again is the same reviewer: nothing is rewritten
    expect(await hostSetup(w.ports, ARGS)).toEqual({ state: "started" });
    expect(w.config()).toBe(before);
  });

  // MUTATION: map the account step to `step_failed` in setupProblem, or let
  // the walk go on past a step that failed — this fails.
  it("stops at the account step, as `github_failed`, when GitHub refuses the host's token", async () => {
    await hostSetup(w.ports, ARGS);
    w.userAnswer = { status: 401, body: { message: "Bad credentials" } };
    expect(await runWalk()).toBe(1);
    expect(progress()).toEqual({
      setup: { state: "failed", step: GITHUB_ACCOUNT_STEP_ID, problem: "github_failed" },
    });
    // whose it is to fix is the host's: no sign-in is named, and none was tried
    expect(w.logs.join("\n")).toMatch(/managed by its host/);
    expect(w.logs.join("\n")).not.toMatch(/gh auth login|github-token sync/);
    expect(w.calls.filter((c) => c[0] !== "docker")).toEqual([]);
    expect(w.checklist()?.choices[CHOICE_KEYS.githubAuth]).toBeUndefined();
    // the token is still the host's word, not GitHub's: the file is there
    expect(tokenWord()).toBe("ok");
  });
});

describe("where the token file is", () => {
  // The verb and the export locate the secrets as the daemon's loader does
  // (src/hostmanaged.ts); the account step as every wizard step does
  // (src/onboard/steps/ingress.ts). A host writes one file: both must name it.
  // MUTATION: have secretsDirAt ignore `[github] secrets_dir` — this fails.
  it("is one place for the verb, the export and the account step", () => {
    const env = { HOME: w.root, QCR_CONFIG_HOME: join(w.root, "home") };
    const adapters = { paths: { stateDir: w.stateDir, configPath: w.configPath } };
    const both = (): [string, string] => [
      secretsDirAt(() => w.configPath, env)(),
      secretsDirFor(adapters as OnboardAdapters, {}, env),
    ];
    // no config yet, then the marker, then what a setup leaves
    expect(both()[0]).toBe(both()[1]);
    w.writeConfig(MARKER);
    expect(both()).toEqual([join(w.root, "home", "secrets"), join(w.root, "home", "secrets")]);
    // a config that names its own
    mkdirSync(join(w.root, "elsewhere"), { recursive: true });
    writeFileSync(w.configPath, `[github]\nsecrets_dir = "${join(w.root, "elsewhere")}"\n`);
    expect(both()).toEqual([join(w.root, "elsewhere"), join(w.root, "elsewhere")]);
    expect((parse(w.config()!) as Record<string, unknown>)["github"]).toBeDefined();
  });
});
