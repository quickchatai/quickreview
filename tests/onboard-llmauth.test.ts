// The wizard's model step: a route resolves where the daemon runs.
//
// The step asks `qcr model --json` in two places (this machine, and the
// daemon's container) and decides nothing of its own. Every piece of I/O is
// faked: temp dirs for config, state and secrets, and a ProcessRunner that
// answers for docker, ssh and this machine's `qcr`. No network, no docker, no
// pi, and no real pi home: the step opens no login file at all.
//
// The properties that matter:
//   - the daemon's own answer is the step's, whatever provider it names; this
//     machine's pi stands in only for a daemon on this computer that is not
//     running yet, and for nothing on a server;
//   - a red check names the login the daemon reads (this machine's, where the
//     stack mounts it) and the secrets dir this machine's `qcr model` reads;
//   - an answer that cannot be read is said as that, never as a route;
//   - there is no route question, no key question, no config rewrite and no
//     key file; what an older wizard recorded is not read;
//   - run() and verify() ask the same questions and neither writes a file;
//   - NO credential value ever reaches an argv, the checklist, or a message.
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  refusalText,
  type ModelRoute,
  type RouteRefusal,
} from "@quickchatai/pi-quickreview/src/modelroute.js";
import type { ModelCliJson } from "../src/modelcli.js";
import { CHOICE_KEYS } from "../src/onboard/choices.js";
import {
  OnboardingEngine,
  checklistPath,
  readChecklist,
  type ChecklistFile,
  type OnboardAdapters,
  type ProcessResult,
} from "../src/onboard/engine.js";
import {
  CONTAINER_MODEL_QUERY,
  EMBEDDINGS_NOTE,
  LLM_AUTH_STEP_ID,
  MODEL_QUERY,
  STEP_EXPLAIN,
  configExamplePathFor,
  llmAuthStep,
  parseModelAnswer,
} from "../src/onboard/steps/llmauth.js";

/** The node and cli.js the step is told to ask this machine's pi with. */
const NODE = "/opt/node/bin/node";
const CLI = "/opt/qcr/dist/src/cli.js";
/** The shipped daemon container name on a server (`[tui] container`). */
const CONTAINER = "quickreview-sandbox";
/** A value that must never leave its file. Not shaped like any real key. */
const SECRET = "credential-value-that-stays-in-its-file";

let root: string;
let stateDir: string;
let secretsDir: string;
let configPath: string;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "qcr-llmauth-"));
  stateDir = join(root, "state");
  mkdirSync(stateDir, { recursive: true });
  secretsDir = join(root, "secrets");
  configPath = join(root, "config.toml");
  // A scratch home: a path the step derives from $HOME (the install's secrets
  // dir, when no config names one) is never the one of the person running the
  // suite. The step itself reads no pi home.
  vi.stubEnv("HOME", join(root, "home"));
  vi.stubEnv("QC_SECRETS_DIR", undefined);
});

afterEach(() => {
  vi.unstubAllEnvs();
  rmSync(root, { recursive: true, force: true });
});

// ---- what `qcr model --json` prints ------------------------------------------
//
// Typed as the verb's own output (src/modelcli.ts), so a change of its shape
// fails the typecheck here before it fails a wizard.

function routeJson(over: Partial<ModelRoute> = {}): string {
  const route: ModelRoute = {
    provider: "anthropic",
    modelId: "claude-opus-5-5",
    providerName: "Anthropic",
    spec: "anthropic/claude-opus-5-5",
    thinking: null,
    source: "only-credential",
    pick: "newest",
    piDefaultId: null,
    custom: false,
    movedFrom: null,
    credential: { kind: "oauth", origin: "stored", subscription: true },
    priced: true,
    ask: false,
    alternatives: [],
    notices: [],
    ...over,
  };
  const out: ModelCliJson = { ok: true, route, choice: null, config_pin: null, skipped: [] };
  return JSON.stringify(out);
}

/** Another provider's route: a key in the environment. */
const KEY_ROUTE: Partial<ModelRoute> = {
  provider: "xai",
  modelId: "grok-5",
  providerName: "xAI",
  spec: "xai/grok-5",
  credential: { kind: "api_key", origin: "env-key", label: "XAI_API_KEY", subscription: false },
};

/** A refusal in the verb's own words (packages/pi-plugin/src/modelroute.ts). */
function refusalJson(refusal: RouteRefusal): string {
  const out: ModelCliJson = {
    ok: false,
    route: null,
    refusal: { code: refusal.code, text: refusalText(refusal, "app", { agentDir: "/pi/agent" }) },
    choice: null,
    config_pin: null,
    skipped: [],
  };
  return JSON.stringify(out);
}

const NO_CREDENTIAL = refusalJson({ code: "no-credential" });
const PIN_NO_CREDENTIAL = refusalJson({
  code: "pin-no-credential",
  pin: "mistral/mistral-large-3",
  provider: "mistral",
  from: "config",
  candidates: [],
});
const LOGIN_TOO_SHORT = refusalJson({
  code: "login-too-short",
  logins: [{ provider: "anthropic", name: "Anthropic", expiresAt: 0 }],
});

/** A failure that is not a refusal: the verb ran and could not tell. */
const failedJson = (error: string): string => JSON.stringify({ ok: false, route: null, error });

// ---- the world ----------------------------------------------------------------

/** What a place answers: the JSON line, or a raw process result. */
type Answer = string | ProcessResult;

const result = (a: Answer): ProcessResult =>
  typeof a === "string"
    ? { code: a.includes('"ok":true') ? 0 : 1, stdout: `${a}\n`, stderr: "" }
    : a;

interface World {
  /** This machine's `qcr model --json`. Unset: the command is not found. */
  host?: Answer;
  /** The daemon on this machine, through docker compose. Unset: no stack. */
  daemon?: { running?: boolean; model?: Answer };
  /** The daemon on the server, reachable only through `ssh <alias>`. */
  remote?: { alias: string; container?: string; running?: boolean; model?: Answer };
  /** docker itself unavailable on this machine. */
  noDocker?: boolean;
}

/** Undo `shellQuote` on the ssh remote command string. */
function unquoteRemote(cmd: string): string[] {
  const out: string[] = [];
  const re = /'((?:[^']|'\\'')*)'|(\S+)/g;
  for (let m = re.exec(cmd); m; m = re.exec(cmd)) {
    out.push(m[1] !== undefined ? m[1].replaceAll("'\\''", "'") : m[2]!);
  }
  return out;
}

const NOT_FOUND = (cmd: string): ProcessResult => ({
  code: 127,
  stdout: "",
  stderr: `${cmd}: command not found`,
});

/** The daemon's container, asked the one question the step asks it. Any other
 * exec is a failure of the test, said loudly. */
function containerAnswer(argv: string[], model: Answer | undefined): ProcessResult {
  if (argv.join(" ") !== CONTAINER_MODEL_QUERY.join(" "))
    return { code: 1, stdout: "", stderr: `unexpected exec: ${argv.join(" ")}` };
  return model === undefined
    ? { code: 1, stdout: "", stderr: "no answer scripted" }
    : result(model);
}

function fakeAdapters(world: World = {}, calls: string[][] = []): OnboardAdapters {
  return {
    fetch: (() => {
      throw new Error("no network in tests");
    }) as unknown as typeof fetch,
    runner: {
      run: async (cmd, args): Promise<ProcessResult> => {
        calls.push([cmd, ...args]);
        if (cmd === NODE) {
          if (args.join(" ") !== [CLI, ...MODEL_QUERY].join(" "))
            return { code: 1, stdout: "", stderr: `unexpected qcr call: ${args.join(" ")}` };
          return world.host === undefined ? NOT_FOUND(cmd) : result(world.host);
        }
        if (cmd === "ssh") {
          const remote = world.remote;
          if (!remote || !args.includes(remote.alias))
            return { code: 255, stdout: "", stderr: "ssh: unknown host" };
          const argv = unquoteRemote(args.at(-1) ?? "");
          if (argv[0] === "sudo") argv.shift();
          const container = remote.container ?? CONTAINER;
          if (argv[0] !== "docker") return NOT_FOUND(argv[0] ?? "");
          if (argv[1] === "ps")
            return { code: 0, stdout: remote.running ? `${container}\n` : "", stderr: "" };
          if (argv[1] === "exec" && argv[2] === container)
            return containerAnswer(argv.slice(3), remote.model);
          return { code: 1, stdout: "", stderr: `unexpected remote docker: ${argv.join(" ")}` };
        }
        if (cmd !== "docker" || world.noDocker) return NOT_FOUND(cmd);
        if (args[0] === "compose" && args.includes("ps"))
          return {
            code: 0,
            stdout: JSON.stringify(
              world.daemon
                ? [{ Service: "daemon", State: world.daemon.running ? "running" : "exited" }]
                : [],
            ),
            stderr: "",
          };
        const exec = args.indexOf("exec");
        if (args[0] === "compose" && exec > 0 && args[exec + 2] === "daemon")
          return containerAnswer(args.slice(exec + 3), world.daemon?.model);
        return { code: 1, stdout: "", stderr: `unexpected docker: ${args.join(" ")}` };
      },
    },
    clock: () => new Date("2026-08-30T12:00:00Z"),
    // The step asks nothing: a question from it is a failure.
    prompter: async (question) => {
      throw new Error(`the model step asked a question: ${question.slice(0, 120)}`);
    },
    host: { nodeVersion: "v22.5.1", uid: 1000 },
    paths: { stateDir, configPath },
  };
}

const step = (): ReturnType<typeof llmAuthStep> => llmAuthStep({ nodePath: NODE, cliPath: CLI });

function engine(world: World = {}, calls: string[][] = []): OnboardingEngine {
  return new OnboardingEngine([step()], fakeAdapters(world, calls));
}

/** A checklist as an earlier session left it: these choices, and whatever
 * record of this step it kept. */
function seedChecklist(
  choices: Record<string, unknown>,
  record?: Partial<ChecklistFile["steps"][string]>,
): void {
  const file: ChecklistFile = {
    version: 1,
    created_at: "2026-08-01T00:00:00Z",
    updated_at: "2026-08-01T00:00:00Z",
    completed_at: null,
    choices,
    steps: record
      ? {
          [LLM_AUTH_STEP_ID]: {
            status: "done",
            completed_at: "2026-08-01T00:00:00Z",
            verified_at: null,
            note: null,
            data: {},
            ...record,
          },
        }
      : {},
  };
  mkdirSync(dirname(checklistPath(stateDir)), { recursive: true });
  writeFileSync(checklistPath(stateDir), JSON.stringify(file));
}

const onServer = (alias = "review-vm"): Record<string, unknown> => ({
  [CHOICE_KEYS.topology]: "vm",
  [CHOICE_KEYS.sshAlias]: alias,
});

function writeConfig(text: string): void {
  writeFileSync(configPath, text);
}

function detailOf(checks: Array<{ name: string; detail: string }>, name: string): string {
  return checks.find((c) => c.name === name)?.detail ?? "";
}

function checkOf(
  checks: Array<{ name: string; ok: boolean; detail: string }>,
  name: string,
): { ok: boolean; detail: string } {
  const found = checks.find((c) => c.name === name);
  expect(found, `no "${name}" check`).toBeDefined();
  return found!;
}

// ---- reading the answer -------------------------------------------------------

describe("reading what qcr model --json printed", () => {
  it("a route is the model and its credential, in the route's own words", () => {
    expect(parseModelAnswer(result(routeJson()))).toEqual({
      kind: "route",
      spec: "anthropic/claude-opus-5-5",
      words: "anthropic/claude-opus-5-5 (Anthropic, signed in with pi (subscription))",
    });
    // An environment key is named by pi's own label, never by its value.
    expect(parseModelAnswer(result(routeJson(KEY_ROUTE)))).toMatchObject({
      words: "xai/grok-5 (xAI, XAI_API_KEY)",
    });
  });

  it("a pin that moved to a provider with a credential says where it moved from", () => {
    const answer = parseModelAnswer(
      result(routeJson({ movedFrom: "openai-codex", source: "config", pick: "pinned" })),
    );
    expect(answer).toMatchObject({
      kind: "route",
      words:
        "anthropic/claude-opus-5-5 (Anthropic, signed in with pi (subscription)) " +
        "(moved from openai-codex: no credential for it there)",
    });
  });

  it("a refusal keeps its code and its text; a failure keeps its reason", () => {
    const refused = parseModelAnswer(result(NO_CREDENTIAL));
    expect(refused).toMatchObject({ kind: "refused", code: "no-credential" });
    expect(refused.kind === "refused" && refused.text).toContain("pi has no model credential");
    expect(parseModelAnswer(result(failedJson("cannot read /pi/agent/auth.json")))).toEqual({
      kind: "failed",
      error: "cannot read /pi/agent/auth.json",
    });
  });

  it("reads the JSON line among other lines a wrapper printed", () => {
    const noisy = { code: 0, stdout: `Warning: banner\n${routeJson()}\n`, stderr: "note: x\n" };
    expect(parseModelAnswer(noisy).kind).toBe("route");
  });

  // MUTATION: make routeOf in src/onboard/steps/llmauth.ts accept a route
  // whose credential it cannot read (return the spec with a fixed phrase), or
  // make parseModelAnswer return a route for any `ok: true` — this fails: an
  // answer the step cannot read would be reported as a model that runs.
  it("an answer it cannot read is silent, with the reason: never a route, never a refusal", () => {
    const silent = (r: ProcessResult): string => {
      const answer = parseModelAnswer(r);
      expect(answer.kind, JSON.stringify(r)).toBe("silent");
      return answer.kind === "silent" ? answer.why : "";
    };
    expect(silent({ code: 0, stdout: "", stderr: "" })).toBe("exit 0, no output");
    // An image whose cli has no such verb prints its usage.
    expect(silent({ code: 2, stdout: "", stderr: "usage: qcr <version|status|…>\n" })).toBe(
      "exit 2: usage: qcr <version|status|…>",
    );
    expect(silent(NOT_FOUND("node"))).toContain("command not found");
    // JSON of another family, a broken line, a route with no credential, a
    // credential of an origin this build does not know, ok with no route.
    silent({ code: 0, stdout: '{"version":"1.4.2"}\n', stderr: "" });
    silent({ code: 0, stdout: '{"ok":true,"route":{"spec":"a/b"\n', stderr: "" });
    silent(result(JSON.stringify({ ok: true, route: { spec: "a/b", providerName: "A" } })));
    silent(
      result(
        JSON.stringify({
          ok: true,
          route: { spec: "a/b", credential: { kind: "api_key", origin: "constructor" } },
        }),
      ),
    );
    silent(result(JSON.stringify({ ok: true, route: null })));
    silent({ code: 1, stdout: JSON.stringify({ ok: false, route: null }), stderr: "" });
  });

  it("a long or many-lined text from the other process is one short line", () => {
    const answer = parseModelAnswer(result(failedJson(`first\nsecond ${"x".repeat(2000)}`)));
    expect(answer.kind === "failed" && answer.error.length).toBeLessThanOrEqual(400);
    expect(answer.kind === "failed" && answer.error).not.toContain("\n");
  });
});

// ---- the daemon on this computer ----------------------------------------------

describe("the daemon on this computer", () => {
  it("before the daemon runs, this machine's pi stands in for it: a route is green and its model is recorded", async () => {
    const e = engine({ host: routeJson() });
    const r = await e.runStep(LLM_AUTH_STEP_ID);
    expect(r.ok, r.failures.join("; ")).toBe(true);
    expect(detailOf(r.checks, "host_model")).toBe(
      "this machine's pi runs anthropic/claude-opus-5-5 (Anthropic, signed in with pi (subscription))",
    );
    // The daemon's line says it was not asked, and when it will be.
    const daemon = checkOf(r.checks, "daemon_model");
    expect(daemon.ok).toBe(true);
    expect(daemon.detail).toMatch(/no daemon is running on this machine.* yet/);
    expect(daemon.detail).toMatch(/asks the daemon's own pi then/);
    expect(e.choices()[CHOICE_KEYS.model]).toBe("anthropic/claude-opus-5-5");
    expect(readChecklist(stateDir)?.steps[LLM_AUTH_STEP_ID]?.status).toBe("done");
    expect(readChecklist(stateDir)?.steps[LLM_AUTH_STEP_ID]?.data).toEqual({
      model: "anthropic/claude-opus-5-5",
    });
  });

  it("before the daemon runs, no credential on this machine is red: it names /login, qcr login and the key's place", async () => {
    writeConfig(`[github]\nsecrets_dir = "${secretsDir}"\n`);
    const e = engine({ host: NO_CREDENTIAL });
    const r = await e.runStep(LLM_AUTH_STEP_ID);
    expect(r.ok).toBe(false);
    const host = checkOf(r.checks, "host_model");
    expect(host.ok).toBe(false);
    expect(host.detail).toContain("this machine's pi has no model credential");
    expect(host.detail).toContain("/login in this pi session");
    expect(host.detail).toContain("`qcr login`");
    expect(host.detail).toContain("pi's /login lists every provider");
    expect(host.detail).toContain(join(secretsDir, "model-env", "<ENV_NAME>"));
    // Nothing is recorded and the step stays open.
    expect(e.choices()[CHOICE_KEYS.model]).toBeUndefined();
    expect(readChecklist(stateDir)?.steps[LLM_AUTH_STEP_ID]?.status).toBe("pending");
  });

  it("a pin pi has no credential for is red in the refusal's own words", async () => {
    const r = await engine({ host: PIN_NO_CREDENTIAL }).runStep(LLM_AUTH_STEP_ID);
    expect(r.ok).toBe(false);
    const detail = detailOf(r.checks, "host_model");
    expect(detail).toContain("this review is pinned to mistral/mistral-large-3");
    expect(detail).toContain("pi has no credential for mistral");
    expect(detail).toContain("remove model from [models]");
  });

  it("a login too short to last outside pi is a login: green, and the daemon is asked once it runs", async () => {
    const e = engine({ host: LOGIN_TOO_SHORT });
    const r = await e.runStep(LLM_AUTH_STEP_ID);
    expect(r.ok, r.failures.join("; ")).toBe(true);
    expect(detailOf(r.checks, "host_model")).toMatch(/signed in with a login too short/);
    expect(detailOf(r.checks, "host_model")).toMatch(/asks the daemon's own pi once it runs/);
    // No route was named, so no model is recorded as the one that runs.
    expect(e.choices()[CHOICE_KEYS.model]).toBeUndefined();
  });

  // MUTATION: make hostDecidingCheck in src/onboard/steps/llmauth.ts return
  // ok: true for a silent or a failed answer — this fails: a machine that
  // could not be asked would pass as one with a credential.
  it("a pi that could not be asked is red: unknown is never a credential", async () => {
    const silent = await engine({}).runStep(LLM_AUTH_STEP_ID);
    expect(silent.ok).toBe(false);
    expect(detailOf(silent.checks, "host_model")).toMatch(
      /could not ask this machine's pi which model it runs \(exit 127: .*command not found\)/,
    );
    const failed = await engine({ host: failedJson("cannot read the login file") }).runStep(
      LLM_AUTH_STEP_ID,
    );
    expect(failed.ok).toBe(false);
    expect(detailOf(failed.checks, "host_model")).toContain("cannot read the login file");
  });

  // MUTATION: in modelChecks (src/onboard/steps/llmauth.ts) let this machine's
  // answer decide although the daemon answered (`hostDecides = !place.server`)
  // — the first case goes red on the machine's missing credential and the
  // second goes green on the machine's route: both fail.
  it("once the daemon runs its own answer is the step's, on whatever provider it is signed in to", async () => {
    // The daemon on one provider's key, this machine on another's login.
    const green = engine({
      host: NO_CREDENTIAL,
      daemon: { running: true, model: routeJson(KEY_ROUTE) },
    });
    const r = await green.runStep(LLM_AUTH_STEP_ID);
    expect(r.ok, r.failures.join("; ")).toBe(true);
    expect(detailOf(r.checks, "daemon_model")).toBe(
      "the daemon's pi runs xai/grok-5 (xAI, XAI_API_KEY)",
    );
    // This machine's line is a note, and says so.
    const host = checkOf(r.checks, "host_model");
    expect(host.ok).toBe(true);
    expect(host.detail).toMatch(/no route of its own \(no-credential\)/);
    expect(host.detail).toMatch(/The daemon answered for itself, so this line decides nothing/);
    expect(green.choices()[CHOICE_KEYS.model]).toBe("xai/grok-5");

    // The reverse: this machine is signed in, the daemon has nothing.
    writeConfig(`[github]\nsecrets_dir = '${secretsDir}'\n`);
    const red = await engine({
      host: routeJson(),
      daemon: { running: true, model: NO_CREDENTIAL },
    }).runStep(LLM_AUTH_STEP_ID);
    expect(red.ok).toBe(false);
    expect(detailOf(red.checks, "daemon_model")).toBe(
      "the daemon's pi has no model credential. Sign in there with " +
        "`docker compose exec daemon /opt/qcr/docker/entrypoint.sh login` (pi's /login lists every provider), " +
        `or put a provider key in ${join(secretsDir, "model-env", "<ENV_NAME>")}.`,
    );
    expect(checkOf(red.checks, "host_model").ok).toBe(true);
  });

  it("the daemon is asked in its container, with the image's own cli", async () => {
    const calls: string[][] = [];
    await engine(
      { host: routeJson(), daemon: { running: true, model: routeJson() } },
      calls,
    ).runStep(LLM_AUTH_STEP_ID);
    const exec = calls.find((c) => c[0] === "docker" && c.includes("exec"));
    expect(exec?.slice(-6)).toEqual(["-T", "daemon", ...CONTAINER_MODEL_QUERY]);
    expect(CONTAINER_MODEL_QUERY).toEqual(["node", "dist/src/cli.js", "model", "--json"]);
    // And this machine with the node and cli.js the step was given.
    expect(calls).toContainEqual([NODE, CLI, "model", "--json"]);
  });

  it("a daemon whose pin is unusable, or whose login cannot last, is red with the refusal and the way in", async () => {
    const pinned = await engine({
      host: routeJson(),
      daemon: { running: true, model: PIN_NO_CREDENTIAL },
    }).runStep(LLM_AUTH_STEP_ID);
    expect(pinned.ok).toBe(false);
    expect(detailOf(pinned.checks, "daemon_model")).toMatch(
      /^the daemon's pi cannot run a review: this review is pinned to mistral\/mistral-large-3/,
    );
    const short = await engine({
      host: routeJson(),
      daemon: { running: true, model: LOGIN_TOO_SHORT },
    }).runStep(LLM_AUTH_STEP_ID);
    expect(short.ok).toBe(false);
    expect(detailOf(short.checks, "daemon_model")).toContain("your Anthropic login expired");
    expect(detailOf(short.checks, "daemon_model")).toContain(
      "Sign in again there with `docker compose exec daemon /opt/qcr/docker/entrypoint.sh login`.",
    );
    const failed = await engine({
      host: routeJson(),
      daemon: { running: true, model: failedJson("cannot read the login file") },
    }).runStep(LLM_AUTH_STEP_ID);
    expect(failed.ok).toBe(false);
    expect(detailOf(failed.checks, "daemon_model")).toBe(
      "the daemon's pi could not say which model it runs: cannot read the login file",
    );
  });

  // A stack the home switched on mounts this machine's login for the daemon
  // (steps/loginshare.ts writes QCR_PI_LOGIN_DIR into the project .env), and
  // the daemon reads no other: the container's own login mode would sign in
  // to a pi home it does not review on.
  // MUTATION: make sharedLoginOf in src/onboard/steps/llmauth.ts return null
  // — the red checks name the container's login mode again and this fails.
  it("a daemon that reviews on this machine's login is signed in on this machine, never in its container", async () => {
    const piHome = join(root, "home", ".pi", "agent");
    writeFileSync(join(root, ".env"), `QCR_VERSION=1.0.0\nQCR_PI_LOGIN_DIR=${piHome}\n`);
    writeConfig(`[github]\nsecrets_dir = '${secretsDir}'\n`);
    const none = await engine({
      host: NO_CREDENTIAL,
      daemon: { running: true, model: NO_CREDENTIAL },
    }).runStep(LLM_AUTH_STEP_ID);
    expect(none.ok).toBe(false);
    expect(detailOf(none.checks, "daemon_model")).toBe(
      `the daemon's pi has no model credential. The daemon reviews on this machine's login (${piHome}), ` +
        "not on one of its container's own: sign in here with /login in this pi session, or `qcr login` in a terminal " +
        `(pi's /login lists every provider), or put a provider key in ${join(secretsDir, "model-env", "<ENV_NAME>")}.`,
    );
    const short = await engine({
      host: LOGIN_TOO_SHORT,
      daemon: { running: true, model: LOGIN_TOO_SHORT },
    }).runStep(LLM_AUTH_STEP_ID);
    expect(short.ok).toBe(false);
    const detail = detailOf(short.checks, "daemon_model");
    expect(detail).toContain("your Anthropic login expired");
    expect(detail).toContain(
      `The daemon reviews on this machine's login (${piHome}), not on one of its container's own: ` +
        "sign in again here with /login in this pi session, or `qcr login` in a terminal",
    );
    for (const said of [detailOf(none.checks, "daemon_model"), detail])
      expect(said).not.toContain("entrypoint.sh login");
    // A daemon with a route is green as before: the line names no login.
    const green = await engine({
      host: routeJson(),
      daemon: { running: true, model: routeJson() },
    }).runStep(LLM_AUTH_STEP_ID);
    expect(green.ok, green.failures.join("; ")).toBe(true);
    // An .env that names no login (the compose default) keeps the container's own.
    writeFileSync(join(root, ".env"), "QCR_VERSION=1.0.0\nQCR_PI_LOGIN_DIR=\n");
    const own = await engine({
      host: routeJson(),
      daemon: { running: true, model: NO_CREDENTIAL },
    }).runStep(LLM_AUTH_STEP_ID);
    expect(detailOf(own.checks, "daemon_model")).toContain(
      "Sign in there with `docker compose exec daemon /opt/qcr/docker/entrypoint.sh login`",
    );
  });

  // The place the red check names for a key is the one this machine's
  // `qcr model` reads (tests/model-cli.test.ts pins the verb's half): before
  // any config names a secrets dir, that is `$QC_SECRETS_DIR` when it is set.
  // MUTATION: drop `override: env.QC_SECRETS_DIR` from secretsDirFor
  // (src/onboard/steps/ingress.ts) — the detail names the config home's
  // secrets dir, where the verb asked with that override does not look, and
  // this fails.
  it("with no secrets dir in any config, the key's place is $QC_SECRETS_DIR, as the verb reads it", async () => {
    const override = join(root, "wizard-secrets");
    vi.stubEnv("QC_SECRETS_DIR", override);
    const r = await engine({ host: NO_CREDENTIAL }).runStep(LLM_AUTH_STEP_ID);
    expect(r.ok).toBe(false);
    expect(detailOf(r.checks, "host_model")).toContain(
      `or put a provider key in ${join(override, "model-env", "<ENV_NAME>")}; then run this step again.`,
    );
    // A config that names one wins over it, on both sides.
    writeConfig(`[github]\nsecrets_dir = '${secretsDir}'\n`);
    const named = await engine({ host: NO_CREDENTIAL }).runStep(LLM_AUTH_STEP_ID);
    expect(detailOf(named.checks, "host_model")).toContain(
      join(secretsDir, "model-env", "<ENV_NAME>"),
    );
  });

  // MUTATION: make askDaemon in src/onboard/steps/llmauth.ts report a silent
  // exec as an answer (`asked: true`), or daemonUnaskedCheck claim a route —
  // this fails.
  it("a daemon that cannot be asked is said as that, and this machine's pi stands in", async () => {
    // An image older than the verb: its cli prints a usage and exits 2.
    const usage = { code: 2, stdout: "", stderr: "usage: qcr <version|status>\n" };
    for (const [world, said] of [
      [
        { daemon: { running: true, model: usage } },
        /gave no answer to `qcr model --json` \(exit 2: usage/,
      ],
      [{ noDocker: true }, /could not tell whether the daemon is running on this machine/],
      [{ daemon: { running: false } }, /no daemon is running on this machine/],
    ] as const) {
      const green = await engine({ ...world, host: routeJson() }).runStep(LLM_AUTH_STEP_ID);
      expect(green.ok, green.failures.join("; ")).toBe(true);
      const daemon = checkOf(green.checks, "daemon_model");
      expect(daemon.ok).toBe(true);
      expect(daemon.detail).toMatch(said);
      expect(daemon.detail).not.toMatch(/the daemon's pi runs/);
      expect(detailOf(green.checks, "host_model")).toMatch(/^this machine's pi runs /);
      // …and with nothing on this machine either, the step is red.
      const red = await engine({ ...world, host: NO_CREDENTIAL }).runStep(LLM_AUTH_STEP_ID);
      expect(red.ok).toBe(false);
    }
  });
});

// ---- the daemon on a server ---------------------------------------------------

describe("the daemon on a server", () => {
  // MUTATION: drop the `!place.server` half of hostDecides in modelChecks
  // (src/onboard/steps/llmauth.ts) — this machine's login then passes for the
  // server's, the first case records its model and this fails.
  it("before the deploy nothing stands in: this machine's login is never the server's", async () => {
    seedChecklist(onServer());
    const calls: string[][] = [];
    const e = engine({ host: routeJson(), remote: { alias: "review-vm" } }, calls);
    const r = await e.runStep(LLM_AUTH_STEP_ID);
    expect(r.ok, r.failures.join("; ")).toBe(true);
    const daemon = checkOf(r.checks, "daemon_model");
    expect(daemon.detail).toMatch(/^no daemon is running on review-vm, over ssh yet\./);
    expect(daemon.detail).toContain("never this machine's login");
    expect(daemon.detail).toContain(
      `ssh -t review-vm sudo docker exec -it ${CONTAINER} /opt/qcr/docker/entrypoint.sh login`,
    );
    expect(daemon.detail).toContain("the server's secrets dir, as model-env/<ENV_NAME>");
    expect(detailOf(r.checks, "host_model")).toMatch(
      /keeps its own credential, so this line decides nothing/,
    );
    // This machine's model is not the daemon's: nothing is recorded.
    expect(e.choices()[CHOICE_KEYS.model]).toBeUndefined();
    expect(calls.some((c) => c[0] === "ssh" && c.includes("review-vm"))).toBe(true);
    // …and a machine with no credential at all changes nothing there.
    seedChecklist(onServer());
    const bare = await engine({ host: NO_CREDENTIAL, remote: { alias: "review-vm" } }).runStep(
      LLM_AUTH_STEP_ID,
    );
    expect(bare.ok, bare.failures.join("; ")).toBe(true);
  });

  it("once deployed, the server's daemon is asked over ssh and its answer is the step's", async () => {
    seedChecklist(onServer());
    const calls: string[][] = [];
    const e = engine(
      { host: NO_CREDENTIAL, remote: { alias: "review-vm", running: true, model: routeJson() } },
      calls,
    );
    const r = await e.runStep(LLM_AUTH_STEP_ID);
    expect(r.ok, r.failures.join("; ")).toBe(true);
    expect(detailOf(r.checks, "daemon_model")).toMatch(
      /^the daemon's pi runs anthropic\/claude-opus-5-5 /,
    );
    expect(e.choices()[CHOICE_KEYS.model]).toBe("anthropic/claude-opus-5-5");
    const asked = calls
      .filter((c) => c[0] === "ssh")
      .map((c) => unquoteRemote(c.at(-1) ?? "").join(" "));
    expect(asked).toContain(`sudo docker exec ${CONTAINER} ${CONTAINER_MODEL_QUERY.join(" ")}`);
    // docker on this machine is not where that daemon is.
    expect(calls.some((c) => c[0] === "docker")).toBe(false);
  });

  it("a server daemon with no credential is red, with the command that reaches ITS login", async () => {
    seedChecklist(onServer());
    const r = await engine({
      host: routeJson(),
      remote: { alias: "review-vm", running: true, model: NO_CREDENTIAL },
    }).runStep(LLM_AUTH_STEP_ID);
    expect(r.ok).toBe(false);
    expect(detailOf(r.checks, "daemon_model")).toBe(
      "the daemon's pi has no model credential. Sign in there with " +
        `\`ssh -t review-vm sudo docker exec -it ${CONTAINER} /opt/qcr/docker/entrypoint.sh login\` ` +
        "(pi's /login lists every provider), or put a provider key in the server's secrets dir, as model-env/<ENV_NAME>.",
    );
  });

  // MUTATION: read the project .env's login for a server too (drop
  // `sharedLogin: null` from the vm branch of daemonPlace in
  // src/onboard/steps/llmauth.ts) — the server's daemon is told to sign in on
  // this machine and this fails.
  it("a login this machine's stack once shared is never the server's way in", async () => {
    writeFileSync(join(root, ".env"), `QCR_PI_LOGIN_DIR=${join(root, "home", ".pi", "agent")}\n`);
    seedChecklist(onServer());
    const r = await engine({
      host: routeJson(),
      remote: { alias: "review-vm", running: true, model: NO_CREDENTIAL },
    }).runStep(LLM_AUTH_STEP_ID);
    expect(r.ok).toBe(false);
    const detail = detailOf(r.checks, "daemon_model");
    expect(detail).toContain(
      `Sign in there with \`ssh -t review-vm sudo docker exec -it ${CONTAINER} /opt/qcr/docker/entrypoint.sh login\``,
    );
    expect(detail).not.toContain("this machine's login");
  });

  it("an unreachable server is said as that: not a route, and not a failure of this step", async () => {
    seedChecklist(onServer("gone-vm"));
    const r = await engine({ host: routeJson(), remote: { alias: "review-vm" } }).runStep(
      LLM_AUTH_STEP_ID,
    );
    expect(r.ok, r.failures.join("; ")).toBe(true);
    expect(detailOf(r.checks, "daemon_model")).toMatch(
      /^could not tell whether the daemon is running on gone-vm, over ssh \(ssh: unknown host\)/,
    );
  });
});

// ---- tolerant config reads ----------------------------------------------------

describe("tolerant config reads", () => {
  it("a half-filled config names the container and the docker prefix; one that does not parse falls back to the shipped names", async () => {
    // FILL values and a line the strict loader refuses: the wizard's own key
    // readers still find `[tui]`.
    writeConfig(
      "[github]\nrepo = \"FILL/ME\"\nthis line is not toml\n\n[tui]\ncontainer = 'reviewer-box' # renamed\nsudo_docker = false\n",
    );
    seedChecklist(onServer());
    const renamed = await engine({
      host: routeJson(),
      remote: {
        alias: "review-vm",
        container: "reviewer-box",
        running: true,
        model: NO_CREDENTIAL,
      },
    }).runStep(LLM_AUTH_STEP_ID);
    expect(detailOf(renamed.checks, "daemon_model")).toContain(
      "`ssh -t review-vm docker exec -it reviewer-box /opt/qcr/docker/entrypoint.sh login`",
    );

    writeConfig("\u0000 not a config at all [[[");
    seedChecklist(onServer());
    const shipped = await engine({
      host: routeJson(),
      remote: { alias: "review-vm", running: true, model: routeJson() },
    }).runStep(LLM_AUTH_STEP_ID);
    expect(shipped.ok, shipped.failures.join("; ")).toBe(true);
  });

  it("with no config.toml at all the step still answers, and creates none", async () => {
    expect(existsSync(configPath)).toBe(false);
    const r = await engine({ host: NO_CREDENTIAL }).runStep(LLM_AUTH_STEP_ID);
    expect(detailOf(r.checks, "host_model")).toMatch(/[/\\]model-env[/\\]<ENV_NAME>/);
    expect(existsSync(configPath)).toBe(false);
  });

  it("the shipped template is found beside the state dir, for the steps that read their defaults from it", () => {
    expect(configExamplePathFor(stateDir)).toBe(join(root, "config.example.toml"));
  });
});

// ---- what the step no longer does ---------------------------------------------

describe("no route question, no key question, no config rewrite, no key file", () => {
  it("keeps its id and its order, which persisted checklists name, and says nothing about one provider", () => {
    const s = step();
    expect(s.id).toBe("llm_auth");
    expect(LLM_AUTH_STEP_ID).toBe("llm_auth");
    expect(s.order).toBe(30);
    expect(s.title).toBe("Model credential: a login or key pi can use");
    expect(s.explain).toBe(STEP_EXPLAIN);
    expect(STEP_EXPLAIN).toBe(
      "QuickReview runs on whatever model credential pi has: a subscription login, an API key stored by /login, or a " +
        "provider key in the environment. With several, `qcr model` shows which one runs.",
    );
  });

  // MUTATION: give the step a `parameters` schema with a route again, or call
  // ctx.adapters.prompter in src/onboard/steps/llmauth.ts — this fails (the
  // fake prompter throws on any question).
  it("declares no input, asks nothing, and an answer an older guide still passes changes nothing", async () => {
    expect(step().parameters).toBeUndefined();
    const plain = await engine({ host: routeJson() }).runStep(LLM_AUTH_STEP_ID);
    rmSync(checklistPath(stateDir));
    for (const input of [{ route: "api" }, { route: "oauth" }, { route: 7, key: SECRET }]) {
      const r = await engine({ host: routeJson() }).runStep(LLM_AUTH_STEP_ID, input);
      expect(r.checks).toEqual(plain.checks);
      expect(JSON.stringify(readChecklist(stateDir))).not.toContain(SECRET);
      rmSync(checklistPath(stateDir));
    }
  });

  // MUTATION: write config.toml, or anything under the secrets dir, from
  // run() in src/onboard/steps/llmauth.ts — this fails.
  it("run and verify change no file but the checklist: the config's bytes, the secrets dir, the checkout", async () => {
    const config =
      `[github]\nsecrets_dir = "${secretsDir}"\n\n[models]\n` +
      '# a comment the older rewrite had to preserve\ndefault = "openai-codex/gpt-6.1-sol"\n' +
      'conversation = "openai-codex/gpt-6.1-sol"\n\n[models.tiers]\n"sol-high" = "openai-codex/gpt-6.1-sol:high"\n';
    writeConfig(config);
    mkdirSync(secretsDir);
    writeFileSync(join(secretsDir, "openai_api_key"), SECRET);
    const listing = (): string[] =>
      (readdirSync(root, { recursive: true }) as string[])
        .filter((p) => !p.startsWith(join("state", "onboarding")))
        .sort();
    const before = listing();
    for (const world of [
      { host: routeJson() },
      { host: NO_CREDENTIAL },
      { host: routeJson(), daemon: { running: true, model: NO_CREDENTIAL } },
      { host: NO_CREDENTIAL, daemon: { running: true, model: routeJson(KEY_ROUTE) } },
    ]) {
      const e = engine(world);
      await e.runStep(LLM_AUTH_STEP_ID);
      await e.verifyAll();
      expect(readFileSync(configPath, "utf8")).toBe(config);
      expect(readFileSync(join(secretsDir, "openai_api_key"), "utf8")).toBe(SECRET);
      expect(listing()).toEqual(before);
    }
  });

  // MUTATION: record CHOICE_KEYS.model from verify() in
  // src/onboard/steps/llmauth.ts — this fails.
  it("verify records nothing: the model on record is the one the last run found", async () => {
    await engine({ host: routeJson() }).runStep(LLM_AUTH_STEP_ID);
    const bytes = readFileSync(checklistPath(stateDir), "utf8");
    // The credential changed since: verify sees the new route and writes nothing.
    const report = await step().verify({
      adapters: fakeAdapters({ host: routeJson(KEY_ROUTE) }),
      input: {},
      choices: readChecklist(stateDir)!.choices,
      data: {},
      recordChoice: () => {
        throw new Error("verify recorded a choice");
      },
    });
    expect(report.ok).toBe(true);
    expect(detailOf(report.checks, "host_model")).toContain("xai/grok-5");
    expect(readFileSync(checklistPath(stateDir), "utf8")).toBe(bytes);
    expect(readChecklist(stateDir)!.choices[CHOICE_KEYS.model]).toBe("anthropic/claude-opus-5-5");
  });
});

// ---- what an older wizard left behind -----------------------------------------

describe("an older wizard's record of this step", () => {
  // The older step chose between two routes and recorded the answer, the
  // provider prefix it rewrote the config to, and its own bookkeeping. A
  // checklist that carries any of it is read as one that does not.
  //
  // MUTATION: read `llm_auth_route` in src/onboard/steps/llmauth.ts and go red
  // (or pick a branch) on its value — a value below changes the checks and
  // this fails. Write either key from run() — the "left as it was" assertion
  // fails.
  it("llm_auth_route and llm_model_prefix are read as nothing, whatever their value, and are never written", async () => {
    const baseline = await engine({ host: routeJson() }).runStep(LLM_AUTH_STEP_ID);
    rmSync(checklistPath(stateDir));
    for (const [route, prefix] of [
      ["oauth", "openai-codex/"],
      ["api", "openai/"],
      ["api_key", ""],
      ["banana", "banana/"],
      [7, null],
      [{ nested: true }, ["a"]],
    ] as const) {
      const legacy = { llm_auth_route: route, llm_model_prefix: prefix };
      seedChecklist(legacy, {
        data: {
          route,
          prefix,
          config_path: configPath,
          models: ["models.default", "models.conversation"],
          restart_owed: true,
          credentials_owed: true,
        },
      });
      // A resumed session re-verifies the step it finds done.
      const resumed = engine({ host: routeJson() });
      const report = await resumed.reconcile();
      expect(report.verified, JSON.stringify(legacy)).toEqual([LLM_AUTH_STEP_ID]);
      expect(report.demoted).toEqual([]);
      // …and a run gives the checks of a checklist that never had them.
      const again = await resumed.runStep(LLM_AUTH_STEP_ID);
      expect(again.checks).toEqual(baseline.checks);
      // The older values are left as they were: nothing rewrote or dropped them.
      const choices = readChecklist(stateDir)!.choices;
      expect(choices.llm_auth_route).toEqual(route);
      expect(choices.llm_model_prefix).toEqual(prefix);
      expect(choices[CHOICE_KEYS.model]).toBe("anthropic/claude-opus-5-5");
      rmSync(checklistPath(stateDir));
    }
  });

  it("the older key file is not this step's to judge: any content, or none, and the answer is pi's", async () => {
    writeConfig(`[github]\nsecrets_dir = "${secretsDir}"\n`);
    mkdirSync(secretsDir);
    const baseline = await engine({ host: routeJson() }).runStep(LLM_AUTH_STEP_ID);
    for (const content of ["not shaped like any key", "", SECRET]) {
      writeFileSync(join(secretsDir, "openai_api_key"), content);
      rmSync(checklistPath(stateDir));
      const r = await engine({ host: routeJson() }).runStep(LLM_AUTH_STEP_ID);
      expect(r.checks).toEqual(baseline.checks);
    }
  });
});

// ---- resume -------------------------------------------------------------------

describe("resume and re-verification", () => {
  it("a done step is re-verified by asking again, and a daemon that lost its credential demotes it", async () => {
    await engine({ host: routeJson() }).runStep(LLM_AUTH_STEP_ID);
    // The stack came up since, and the daemon's pi has a credential.
    const held = await engine({
      host: routeJson(),
      daemon: { running: true, model: routeJson() },
    }).reconcile();
    expect(held.verified).toEqual([LLM_AUTH_STEP_ID]);
    // Later it has none, though this machine still does.
    const lost = await engine({
      host: routeJson(),
      daemon: { running: true, model: NO_CREDENTIAL },
    }).reconcile();
    expect(lost.demoted.map((d) => d.id)).toEqual([LLM_AUTH_STEP_ID]);
    expect(lost.demoted[0]?.failures.join(" ")).toContain(
      "daemon_model: the daemon's pi has no model credential",
    );
    expect(readChecklist(stateDir)?.steps[LLM_AUTH_STEP_ID]?.status).toBe("pending");
  });
});

// ---- the house rule -----------------------------------------------------------

describe("no credential ever reaches an argv (or any other record)", () => {
  // The step opens no credential file: it runs fixed commands and reads their
  // JSON. So a value in the secrets dir can reach nothing the step produces.
  //
  // MUTATION: read `<secrets>/openai_api_key` in src/onboard/steps/llmauth.ts
  // and pass it on (an env assignment on the exec argv, a detail) — this fails.
  it("a key in the secrets dir stays in its file: not on a command line, in the checklist, or in a check detail", async () => {
    writeConfig(`[github]\nsecrets_dir = "${secretsDir}"\n`);
    mkdirSync(join(secretsDir, "model-env"), { recursive: true });
    writeFileSync(join(secretsDir, "openai_api_key"), SECRET);
    writeFileSync(join(secretsDir, "model-env", "XAI_API_KEY"), SECRET);

    for (const [choices, world] of [
      [{}, { host: routeJson(KEY_ROUTE), daemon: { running: true, model: routeJson(KEY_ROUTE) } }],
      [{}, { host: NO_CREDENTIAL, daemon: { running: true, model: NO_CREDENTIAL } }],
      [{}, { host: NO_CREDENTIAL }],
      [
        onServer(),
        { host: routeJson(), remote: { alias: "review-vm", running: true, model: NO_CREDENTIAL } },
      ],
    ] as const) {
      seedChecklist({ ...choices });
      const calls: string[][] = [];
      const e = engine(world, calls);
      const ran = await e.runStep(LLM_AUTH_STEP_ID);
      const verified = await e.verifyAll();
      expect(calls.length).toBeGreaterThan(0);
      for (const call of calls) for (const arg of call) expect(arg).not.toContain(SECRET);
      expect(JSON.stringify(ran.checks)).not.toContain(SECRET);
      expect(JSON.stringify(verified.results)).not.toContain(SECRET);
      expect(readFileSync(checklistPath(stateDir), "utf8")).not.toContain(SECRET);
      // Every command is one of the fixed ones: a question, or where to ask it.
      for (const call of calls) {
        const line =
          call[0] === "ssh" ? unquoteRemote(call.at(-1) ?? "").join(" ") : call.join(" ");
        expect(line).toMatch(/ model --json$| ps( |$)/);
      }
    }
  });
});

// ---- the embeddings note ------------------------------------------------------

describe("the embeddings note", () => {
  it("says memory embeddings need nothing from this step, on every outcome, and recommends no key", async () => {
    for (const world of [{ host: routeJson() }, { host: NO_CREDENTIAL }]) {
      const r = await engine(world).runStep(LLM_AUTH_STEP_ID);
      const note = checkOf(r.checks, "embeddings");
      expect(note.ok).toBe(true); // a note, never a blocker
      expect(note.detail).toBe(EMBEDDINGS_NOTE);
      rmSync(checklistPath(stateDir));
    }
    expect(EMBEDDINGS_NOTE).toMatch(/embeds locally by default/);
    expect(EMBEDDINGS_NOTE).toMatch(/No model credential is ever read for embeddings/);
    expect(EMBEDDINGS_NOTE).toMatch(/embeddings step, order 38/);
    expect(EMBEDDINGS_NOTE).toContain("openai_embeddings_api_key");
    expect(EMBEDDINGS_NOTE).not.toMatch(/recommend|worth providing/i);
  });
});
