// The LLM auth onboarding step — both routes end to end, with every
// piece of I/O faked: temp dirs for config/state/secrets/pi-home, a fake
// ProcessRunner for every docker probe, a scripted prompter. No network, no
// docker, no pi.
//
// The properties that matter:
//   - the six-string rewrite is comment-preserving, IDEMPOTENT and REVERSIBLE
//     (oauth → api → oauth restores the original bytes);
//   - a bad key is refused and nothing is written;
//   - switching routes re-runs cleanly in either direction;
//   - verify() re-verifies without asking anything (and without writing);
//   - OAuth verification proves the token landed on the container's persistent
//     pi home, not merely that a login happened;
//   - NO credential value ever reaches an argv, the checklist, or a message.
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { OnboardingEngine, readChecklist, type OnboardAdapters, type ProcessResult } from "../src/onboard/engine.js";
import {
  API_PREFIX,
  AUTH_ROUTE_CHOICE_KEY,
  LLM_AUTH_STEP_ID,
  MODEL_LOCATIONS,
  MODEL_PREFIX_CHOICE_KEY,
  OAUTH_PREFIX,
  OPENAI_KEY_FILE,
  auditModelStrings,
  companionContainerName,
  configPathFor,
  daemonContainerName,
  expandHomePath,
  hostAuthJsonPath,
  llmAuthStep,
  modelLabels,
  parseRouteAnswer,
  probeContainerLogin,
  readTomlString,
  resolveSecretsDir,
  rewriteModelPrefixes,
  validateOpenAiKey,
} from "../src/onboard/steps/llmauth.js";

const KEY = "sk-proj-onboardingtestkey000000000000";

let root: string;
let stateDir: string;
let secretsDir: string;
let home: string;
let savedHome: string | undefined;
let savedSecretsEnv: string | undefined;

/** A config.example.toml with the real shape: the six model strings, comments
 * between them, and other `openai-codex/` mentions that must NOT be touched. */
const EXAMPLE_CONFIG = `# QuickReview config
[github]
repo = "acme/widgets"
secrets_dir = "SECRETS_DIR"

[models]
# Provider prefix is \`openai-codex/\` — the ChatGPT-OAuth route's provider key
# in pi's auth.json (direct \`openai/\` needs an API key we don't ship).
default = "openai-codex/gpt-5.6-sol"
conversation = "openai-codex/gpt-5.6-sol"   # sticky per-PR session
overseer = "openai-codex/gpt-5.6-sol"
risk_passes = ["pass-security"]
validate_tier = "sol-high"

[models.tiers]
"terra-med" = "openai-codex/gpt-5.6-terra:medium"
"sol-med" = "openai-codex/gpt-5.6-sol:medium"
"sol-high" = "openai-codex/gpt-5.6-sol:high"

[tui]
container = "quickreview-sandbox"

[companion]
# model = "openai-codex/gpt-5.6-sol"
`;

function writeExample(text = EXAMPLE_CONFIG): void {
  writeFileSync(join(root, "config.example.toml"), text.replace("SECRETS_DIR", secretsDir));
}

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "qcr-llmauth-"));
  stateDir = join(root, "state");
  mkdirSync(stateDir, { recursive: true });
  secretsDir = join(root, "secrets");
  home = join(root, "home");
  mkdirSync(home, { recursive: true });
  savedHome = process.env.HOME;
  savedSecretsEnv = process.env.QC_SECRETS_DIR;
  process.env.HOME = home;
  delete process.env.QC_SECRETS_DIR;
  writeExample();
});

afterEach(() => {
  if (savedHome === undefined) delete process.env.HOME;
  else process.env.HOME = savedHome;
  if (savedSecretsEnv === undefined) delete process.env.QC_SECRETS_DIR;
  else process.env.QC_SECRETS_DIR = savedSecretsEnv;
  rmSync(root, { recursive: true, force: true });
});

// ---- fakes ------------------------------------------------------------------

interface FakeContainer {
  /** Destination of the pi-home mount; omit for "no volume on the pi home". */
  piHome?: string;
  mountType?: string;
  mountName?: string;
  running?: boolean;
  auth?: boolean;
}

interface World {
  containers?: Record<string, FakeContainer>;
  /** docker itself unavailable. */
  noDocker?: boolean;
}

function fakeAdapters(world: World = {}, calls: string[][] = [], answers: string[] = []): OnboardAdapters {
  const containers = world.containers ?? {};
  const adapters: OnboardAdapters = {
    fetch: (() => {
      throw new Error("no network in tests");
    }) as unknown as typeof fetch,
    runner: {
      run: async (cmd, args): Promise<ProcessResult> => {
        calls.push([cmd, ...args]);
        if (world.noDocker) return { code: 127, stdout: "", stderr: "docker: command not found" };
        if (cmd !== "docker") return { code: 127, stdout: "", stderr: `${cmd}: not found` };
        const name = args[args.length - 1] ?? "";
        if (args[0] === "inspect" && args[1] === "--format" && args[2] === "{{json .Mounts}}") {
          const c = containers[name];
          if (!c) return { code: 1, stdout: "", stderr: `Error: No such object: ${name}` };
          const mounts = c.piHome
            ? [{ Type: c.mountType ?? "volume", Name: c.mountName ?? "some-pihome", Destination: c.piHome }]
            : [{ Type: "bind", Source: "/repo", Destination: "/opt/quickreview/sandbox" }];
          return { code: 0, stdout: JSON.stringify(mounts), stderr: "" };
        }
        if (args[0] === "inspect" && args[2] === "{{.State.Running}}") {
          const c = containers[name];
          if (!c) return { code: 1, stdout: "", stderr: "No such object" };
          return { code: 0, stdout: `${c.running ?? true}\n`, stderr: "" };
        }
        if (args[0] === "exec") {
          const c = containers[args[1] ?? ""];
          return c?.auth ? { code: 0, stdout: "", stderr: "" } : { code: 1, stdout: "", stderr: "" };
        }
        return { code: 1, stdout: "", stderr: "unexpected docker args" };
      },
    },
    clock: () => new Date("2026-08-30T12:00:00Z"),
    host: { nodeVersion: "v22.5.1", uid: 1000 },
    paths: { stateDir },
  };
  if (answers.length) {
    adapters.prompter = async () => answers.shift() ?? "";
  }
  return adapters;
}

function engine(world: World = {}, calls: string[][] = [], answers: string[] = []): OnboardingEngine {
  return new OnboardingEngine([llmAuthStep()], fakeAdapters(world, calls, answers));
}

function configText(): string {
  return readFileSync(configPathFor(stateDir), "utf8");
}

function hostLogin(): void {
  const p = hostAuthJsonPath(home);
  mkdirSync(dirname(p), { recursive: true });
  writeFileSync(p, '{"token":"redacted"}');
}

function keyFileOnDisk(value = KEY): void {
  mkdirSync(secretsDir, { recursive: true });
  writeFileSync(join(secretsDir, OPENAI_KEY_FILE), value);
}

function detailOf(checks: Array<{ name: string; detail: string }>, name: string): string {
  return checks.find((c) => c.name === name)?.detail ?? "";
}

// ---- the pure rewrite -------------------------------------------------------

describe("model-string rewrite", () => {
  it("names exactly six locations, all under [models]/[models.tiers]", () => {
    expect(modelLabels()).toEqual([
      "models.default",
      "models.conversation",
      "models.overseer",
      "models.tiers.terra-med",
      "models.tiers.sol-med",
      "models.tiers.sol-high",
    ]);
    expect(MODEL_LOCATIONS).toHaveLength(6);
  });

  it("rewrites all six to the API prefix and touches nothing else (comments, other keys, commented-out models)", () => {
    const before = EXAMPLE_CONFIG;
    const { text, rewritten, custom, missing } = rewriteModelPrefixes(before, "api");
    expect(rewritten).toEqual(modelLabels());
    expect(custom).toEqual([]);
    expect(missing).toEqual([]);
    for (const a of auditModelStrings(text)) expect(a.kind).toBe("api");
    expect(text).toContain('default = "openai/gpt-5.6-sol"');
    expect(text).toContain('"sol-high" = "openai/gpt-5.6-sol:high"');
    // Comments, trailing comments, unrelated keys and the commented-out
    // [companion] model line all survive byte-for-byte.
    expect(text).toContain("# Provider prefix is `openai-codex/` — the ChatGPT-OAuth route's provider key");
    expect(text).toContain('conversation = "openai/gpt-5.6-sol"   # sticky per-PR session');
    expect(text).toContain('# model = "openai-codex/gpt-5.6-sol"');
    expect(text).toContain('risk_passes = ["pass-security"]');
    // Same number of lines: a line-oriented edit, never a TOML round-trip.
    expect(text.split("\n")).toHaveLength(before.split("\n").length);
  });

  it("is idempotent: a second pass rewrites nothing and changes no byte", () => {
    const once = rewriteModelPrefixes(EXAMPLE_CONFIG, "api");
    const twice = rewriteModelPrefixes(once.text, "api");
    expect(twice.text).toBe(once.text);
    expect(twice.rewritten).toEqual([]);
    expect(twice.unchanged).toEqual(modelLabels());
  });

  it("is reversible: oauth → api → oauth restores the original bytes", () => {
    const api = rewriteModelPrefixes(EXAMPLE_CONFIG, "api");
    const back = rewriteModelPrefixes(api.text, "oauth");
    expect(back.text).toBe(EXAMPLE_CONFIG);
    expect(back.rewritten).toEqual(modelLabels());
  });

  it("leaves a deliberately custom provider alone and reports it", () => {
    const custom = EXAMPLE_CONFIG.replace('overseer = "openai-codex/gpt-5.6-sol"', 'overseer = "anthropic/some-model"');
    const out = rewriteModelPrefixes(custom, "api");
    expect(out.custom).toEqual(["models.overseer"]);
    expect(out.text).toContain('overseer = "anthropic/some-model"');
  });

  it("reports a location that is missing from the file rather than inventing it", () => {
    const trimmed = EXAMPLE_CONFIG.replace('"sol-med" = "openai-codex/gpt-5.6-sol:medium"\n', "");
    const out = rewriteModelPrefixes(trimmed, "api");
    expect(out.missing).toEqual(["models.tiers.sol-med"]);
  });

  it("never rewrites a same-named key in another section", () => {
    const withOther = `${EXAMPLE_CONFIG}\n[somewhere]\ndefault = "openai-codex/other"\n`;
    const out = rewriteModelPrefixes(withOther, "api");
    expect(out.text).toContain('[somewhere]\ndefault = "openai-codex/other"');
  });
});

describe("tolerant config reads", () => {
  it("reads a string key from its own section only, ignoring comments", () => {
    expect(readTomlString(EXAMPLE_CONFIG, "tui", "container")).toBe("quickreview-sandbox");
    expect(readTomlString(EXAMPLE_CONFIG, "companion", "model")).toBeNull(); // commented out
    expect(readTomlString(EXAMPLE_CONFIG, "models", "nope")).toBeNull();
  });

  it("resolves the secrets dir: config first, then $QC_SECRETS_DIR, then the shipped default", () => {
    expect(resolveSecretsDir('[github]\nsecrets_dir = "~/keys"\n', "/h")).toBe("/h/keys");
    expect(resolveSecretsDir("[github]\n", "/h", "/env/keys")).toBe("/env/keys");
    expect(resolveSecretsDir("", "/h")).toBe("/h/.config/quickreview-bot");
    expect(expandHomePath("~", "/h")).toBe("/h");
    expect(expandHomePath("/abs", "/h")).toBe("/abs");
  });

  it("falls back to the shipped container names when config does not override them", () => {
    expect(daemonContainerName(EXAMPLE_CONFIG)).toBe("quickreview-sandbox");
    expect(companionContainerName(EXAMPLE_CONFIG)).toBe("qcr-companion");
    expect(daemonContainerName("")).toBe("quickreview-sandbox");
    expect(companionContainerName("")).toBe("qcr-companion");
  });
});

// ---- key validation ---------------------------------------------------------

describe("API key validation", () => {
  it("accepts sk- keys, refuses everything else", () => {
    expect(validateOpenAiKey(KEY)).toBe(true);
    expect(validateOpenAiKey(`  ${KEY}\n`)).toBe(true);
    expect(validateOpenAiKey("nope")).toBe(false);
    expect(validateOpenAiKey("")).toBe(false);
    expect(validateOpenAiKey("sk-")).toBe(false);
    expect(validateOpenAiKey("sk- with space")).toBe(false);
  });

  it("mirrors deploy/collect-secrets.sh's validator and file name — the two must not drift", () => {
    const shell = readFileSync(join(process.cwd(), "deploy", "collect-secrets.sh"), "utf8");
    expect(shell).toContain("v_openai()");
    expect(shell).toContain("'^sk-'");
    expect(shell).toContain(OPENAI_KEY_FILE);
  });
});

describe("parseRouteAnswer", () => {
  it("understands both spellings of both routes and nothing else", () => {
    expect(parseRouteAnswer("1")).toBe("oauth");
    expect(parseRouteAnswer("OAuth")).toBe("oauth");
    expect(parseRouteAnswer("2")).toBe("api");
    expect(parseRouteAnswer(" api ")).toBe("api");
    expect(parseRouteAnswer("maybe")).toBeNull();
  });
});

// ---- the OAuth route --------------------------------------------------------

describe("OAuth route", () => {
  it("run: records the route, keeps the openai-codex prefix, and states the three-login cost per surface", async () => {
    hostLogin();
    const e = engine({}, [], ["oauth"]);
    const result = await e.runStep(LLM_AUTH_STEP_ID);
    expect(result.ok).toBe(true);
    expect(e.choices()[AUTH_ROUTE_CHOICE_KEY]).toBe("oauth");
    expect(e.choices()[MODEL_PREFIX_CHOICE_KEY]).toBe(OAUTH_PREFIX);
    for (const a of auditModelStrings(configText())) expect(a.kind).toBe("oauth");
    expect(detailOf(result.checks, "wizard_login")).toMatch(/login 1 of 3/);
    // The containers do not exist yet: guided later, never a blocker now.
    expect(detailOf(result.checks, "daemon_login")).toMatch(/no container yet/);
    expect(detailOf(result.checks, "companion_login")).toMatch(/no container yet/);
  });

  it("run: with no host login the step is red and tells you to /login in this session", async () => {
    const e = engine({}, [], ["oauth"]);
    const result = await e.runStep(LLM_AUTH_STEP_ID);
    expect(result.ok).toBe(false);
    expect(detailOf(result.checks, "wizard_login")).toMatch(/\/login/);
    expect(readChecklist(stateDir)?.steps[LLM_AUTH_STEP_ID]?.status).toBe("pending");
  });

  it("says memory embeddings need nothing from this route — local by default, pi's key never read for them", async () => {
    hostLogin();
    const result = await engine({}, [], ["oauth"]).runStep(LLM_AUTH_STEP_ID);
    const embeddings = result.checks.find((c) => c.name === "embeddings");
    expect(embeddings?.ok).toBe(true); // a note, never a blocker
    expect(embeddings?.detail).toMatch(/embeds LOCALLY by default/);
    expect(embeddings?.detail).toMatch(/never read for embeddings/);
    expect(embeddings?.detail).toMatch(/embeddings step, order 38/);
    // The retired advice is gone: no route recommends an embeddings key.
    expect(embeddings?.detail).not.toMatch(/recommend|worth providing/i);
  });

  it("verify: a container login on its pi-home volume is green; one in the writable layer is not", async () => {
    hostLogin();
    await engine({}, [], ["oauth"]).runStep(LLM_AUTH_STEP_ID);

    const good = engine({
      containers: {
        "quickreview-sandbox": { piHome: "/home/review/.pi", mountName: "qcr-pihome", auth: true },
        "qcr-companion": { piHome: "/home/companion/.pi", mountName: "companion-pihome", auth: true },
      },
    });
    const greenAll = await good.verifyAll();
    expect(greenAll.ok).toBe(true);

    // Logged in, but the pi home is NOT a mount: a recreate would eat it.
    const unmounted = engine({ containers: { "quickreview-sandbox": { auth: true } } });
    const report = await unmounted.verifyAll();
    expect(report.ok).toBe(false);
    expect(report.results[0]?.failures.join(" ")).toMatch(/no volume mounted on its pi home/);
  });

  it("verify: a running container with no auth.json is red with the attach-and-login instruction", async () => {
    hostLogin();
    await engine({}, [], ["oauth"]).runStep(LLM_AUTH_STEP_ID);
    const e = engine({ containers: { "quickreview-sandbox": { piHome: "/home/review/.pi", auth: false } } });
    const report = await e.verifyAll();
    expect(report.ok).toBe(false);
    expect(report.results[0]?.failures.join(" ")).toMatch(/no auth\.json on the pi home/);
    expect(report.results[0]?.failures.join(" ")).toMatch(/tmux attach/);
  });

  it("verify: a stopped container and an undetectable docker are notes, not failures", async () => {
    hostLogin();
    await engine({}, [], ["oauth"]).runStep(LLM_AUTH_STEP_ID);
    const stopped = await engine({ containers: { "quickreview-sandbox": { piHome: "/home/review/.pi", running: false } } }).verifyAll();
    expect(stopped.ok).toBe(true);
    const noDocker = await engine({ noDocker: true }).verifyAll();
    expect(noDocker.ok).toBe(true);
  });

  it("probeContainerLogin asks about the MOUNT, not $HOME — the hazard", async () => {
    const calls: string[][] = [];
    const adapters = fakeAdapters({ containers: { c1: { piHome: "/home/review/.pi", auth: true } } }, calls);
    const probe = await probeContainerLogin(adapters.runner, "c1");
    expect(probe.state).toBe("ok");
    const exec = calls.find((c) => c[1] === "exec");
    expect(exec?.join(" ")).toContain("test -s '/home/review/.pi/agent/auth.json'");
    expect(exec?.join(" ")).not.toContain("$HOME");
  });
});

// ---- the API-key route ------------------------------------------------------

describe("API-key route", () => {
  it("run: one paste stores the key 0600 and rewrites all six model strings", async () => {
    const calls: string[][] = [];
    const e = engine({}, calls, ["api", KEY]);
    const result = await e.runStep(LLM_AUTH_STEP_ID);
    expect(result.ok).toBe(true);
    expect(e.choices()[AUTH_ROUTE_CHOICE_KEY]).toBe("api");
    expect(e.choices()[MODEL_PREFIX_CHOICE_KEY]).toBe(API_PREFIX);

    const keyPath = join(secretsDir, OPENAI_KEY_FILE);
    expect(readFileSync(keyPath, "utf8")).toBe(KEY);
    expect(statSync(keyPath).mode & 0o777).toBe(0o600);
    expect(statSync(secretsDir).mode & 0o777).toBe(0o700);

    for (const a of auditModelStrings(configText())) expect(a.kind).toBe("api");
    expect(detailOf(result.checks, "models")).toMatch(/rewrote 6/);
    expect(detailOf(result.checks, "credential")).toMatch(/covered|OPENAI_API_KEY/);
    // No container logins are asked for on this route.
    expect(result.checks.map((c) => c.name)).not.toContain("wizard_login");
  });

  it("run: a malformed key is refused, nothing is written, and the value is never echoed", async () => {
    const e = engine({}, [], ["api", "not-a-key"]);
    const result = await e.runStep(LLM_AUTH_STEP_ID);
    expect(result.ok).toBe(false);
    expect(existsSync(join(secretsDir, OPENAI_KEY_FILE))).toBe(false);
    const rendered = JSON.stringify(result.checks);
    expect(rendered).toMatch(/does not look like an OpenAI API key/);
    expect(rendered).not.toContain("not-a-key");
  });

  it("run: with no prompter (the pi-driven flow) the key is never handled here — it points at the secrets wizard", async () => {
    const e = engine();
    // No prompter and no credential on disk ⇒ no route can be inferred yet.
    const undecided = await e.runStep(LLM_AUTH_STEP_ID);
    expect(undecided.ok).toBe(false);
    expect(detailOf(undecided.checks, "route")).toMatch(/1\) oauth/);
    expect(detailOf(undecided.checks, "route")).toMatch(/three separate browser logins/);

    // The operator runs the shell wizard; the step then finds and adopts it.
    keyFileOnDisk();
    const decided = await e.runStep(LLM_AUTH_STEP_ID);
    expect(decided.ok).toBe(true);
    expect(detailOf(decided.checks, "route")).toMatch(/api route/);
    for (const a of auditModelStrings(configText())) expect(a.kind).toBe("api");
  });

  it("run: an invalid key file on disk sends you to collect-secrets.sh rather than the LLM", async () => {
    // Record the route first, then corrupt the file: the pi-driven flow (no
    // prompter) must never ask for the value itself.
    keyFileOnDisk();
    await engine().runStep(LLM_AUTH_STEP_ID);
    keyFileOnDisk("garbage");
    const result = await engine().runStep(LLM_AUTH_STEP_ID);
    expect(result.ok).toBe(false);
    expect(detailOf(result.checks, "credential")).toMatch(/collect-secrets\.sh/);
    expect(detailOf(result.checks, "credential")).toMatch(/never passes through this session/);
  });

  it("verify: the recorded route must be coherent with disk — a deleted key file goes red", async () => {
    await engine({}, [], ["api", KEY]).runStep(LLM_AUTH_STEP_ID);
    rmSync(join(secretsDir, OPENAI_KEY_FILE));
    const report = await engine().verifyAll();
    expect(report.ok).toBe(false);
    expect(report.results[0]?.failures.join(" ")).toMatch(/the api route needs openai_api_key/);
  });

  it("verify: hand-edited model strings that contradict the recorded route go red", async () => {
    await engine({}, [], ["api", KEY]).runStep(LLM_AUTH_STEP_ID);
    writeFileSync(configPathFor(stateDir), configText().replace('default = "openai/', 'default = "openai-codex/'));
    const report = await engine().verifyAll();
    expect(report.ok).toBe(false);
    expect(report.results[0]?.failures.join(" ")).toMatch(/models\.default/);
  });
});

// ---- route switching, resume, config seeding --------------------------------

describe("switching routes", () => {
  it("oauth → api → oauth: each re-run rewrites cleanly and the config returns to its original bytes", async () => {
    hostLogin();
    const original = readFileSync(join(root, "config.example.toml"), "utf8");

    await engine({}, [], ["oauth"]).runStep(LLM_AUTH_STEP_ID);
    expect(configText()).toBe(original);

    const toApi = await engine({}, [], ["api", KEY]).runStep(LLM_AUTH_STEP_ID);
    expect(toApi.ok).toBe(true);
    for (const a of auditModelStrings(configText())) expect(a.kind).toBe("api");

    const back = await engine({}, [], ["oauth"]).runStep(LLM_AUTH_STEP_ID);
    expect(back.ok).toBe(true);
    expect(configText()).toBe(original);
    expect(readChecklist(stateDir)?.choices[AUTH_ROUTE_CHOICE_KEY]).toBe("oauth");
  });

  it("an unrecognised answer refuses without touching the config or the recorded route", async () => {
    hostLogin();
    await engine({}, [], ["oauth"]).runStep(LLM_AUTH_STEP_ID);
    const before = configText();
    const confused = await engine({}, [], ["banana"]).runStep(LLM_AUTH_STEP_ID);
    expect(confused.ok).toBe(false);
    expect(detailOf(confused.checks, "route")).toMatch(/did not understand/);
    expect(configText()).toBe(before);
    expect(readChecklist(stateDir)?.choices[AUTH_ROUTE_CHOICE_KEY]).toBe("oauth");
  });

  it("an empty answer keeps the recorded route instead of re-asking", async () => {
    keyFileOnDisk();
    await engine({}, [], ["api"]).runStep(LLM_AUTH_STEP_ID);
    const again = await engine({}, [], [""]).runStep(LLM_AUTH_STEP_ID);
    expect(again.ok).toBe(true);
    expect(detailOf(again.checks, "route")).toMatch(/kept the recorded route/);
  });
});

describe("resume and re-run", () => {
  it("a re-run over a finished installation VERIFIES: no prompt, no write, still done", async () => {
    keyFileOnDisk();
    await engine({}, [], ["api"]).runStep(LLM_AUTH_STEP_ID);
    const bytes = configText();

    // No prompter at all on the resumed engine: reconcile must not need one.
    const resumed = engine();
    const report = await resumed.reconcile();
    expect(report.verified).toEqual([LLM_AUTH_STEP_ID]);
    expect(report.demoted).toEqual([]);
    expect(configText()).toBe(bytes);
    expect(readChecklist(stateDir)?.steps[LLM_AUTH_STEP_ID]?.status).toBe("done");
  });

  it("a checklist that claims done with no recorded route is demoted, not trusted", async () => {
    keyFileOnDisk();
    const e = engine({}, [], ["api"]);
    await e.runStep(LLM_AUTH_STEP_ID);
    const file = readChecklist(stateDir)!;
    delete file.choices[AUTH_ROUTE_CHOICE_KEY];
    file.steps[LLM_AUTH_STEP_ID]!.data = {};
    writeFileSync(join(stateDir, "onboarding", "checklist.json"), JSON.stringify(file));
    const report = await engine().reconcile();
    expect(report.demoted[0]?.failures.join(" ")).toMatch(/no LLM auth route recorded/);
  });

  it("seeds config.toml from config.example.toml when the wizard runs before any config exists", async () => {
    hostLogin();
    expect(existsSync(configPathFor(stateDir))).toBe(false);
    const result = await engine({}, [], ["oauth"]).runStep(LLM_AUTH_STEP_ID);
    expect(result.ok).toBe(true);
    expect(detailOf(result.checks, "config")).toMatch(/created .*config\.toml from config\.example\.toml/);
    // FILL values are left for the config step — the wizard only touched models.
    expect(configText()).toContain('repo = "acme/widgets"');
  });

  it("verify never seeds: a missing config.toml is reported, not created", async () => {
    keyFileOnDisk();
    await engine({}, [], ["api"]).runStep(LLM_AUTH_STEP_ID);
    rmSync(configPathFor(stateDir));
    const report = await engine().verifyAll();
    expect(report.ok).toBe(false);
    expect(report.results[0]?.failures.join(" ")).toMatch(/does not exist yet/);
    expect(existsSync(configPathFor(stateDir))).toBe(false);
  });

  it("an unreadable config.toml is a plain red check, never a throw", async () => {
    writeFileSync(configPathFor(stateDir), EXAMPLE_CONFIG);
    chmodSync(configPathFor(stateDir), 0o000);
    const result = await engine({}, [], ["oauth"]).runStep(LLM_AUTH_STEP_ID);
    chmodSync(configPathFor(stateDir), 0o600);
    // Root can read anything; only assert the no-throw contract in both worlds.
    expect(typeof result.ok).toBe("boolean");
  });
});

// ---- the house rule ---------------------------------------------------------

describe("no credential ever reaches an argv (or any other record)", () => {
  it("the key stays in the file: not in a command line, the checklist, or a check detail", async () => {
    const calls: string[][] = [];
    const e = engine(
      { containers: { "quickreview-sandbox": { piHome: "/home/review/.pi", auth: true } } },
      calls,
      ["api", KEY],
    );
    const result = await e.runStep(LLM_AUTH_STEP_ID);
    expect(result.ok).toBe(true);

    for (const call of calls) for (const arg of call) expect(arg).not.toContain(KEY);
    expect(JSON.stringify(result.checks)).not.toContain(KEY);
    expect(readFileSync(join(stateDir, "onboarding", "checklist.json"), "utf8")).not.toContain(KEY);
    expect(configText()).not.toContain(KEY);

    // …and the same for the verify pass, which probes docker.
    calls.length = 0;
    const verified = await engine({ containers: { "quickreview-sandbox": { piHome: "/home/review/.pi", auth: true } } }, calls).verifyAll();
    expect(verified.ok).toBe(true);
    for (const call of calls) for (const arg of call) expect(arg).not.toContain(KEY);
    expect(JSON.stringify(verified.results)).not.toContain(KEY);
  });
});
