// the COMPOSED onboarding flow: the REAL registered steps, driven
// through the REAL engine in registered order, with every side effect faked.
//
// This is the test that was missing. Twelve slices each green in isolation
// composed into a wizard that stopped at step five of sixteen, because every
// per-step suite injected the choices its step read instead of letting an
// earlier step record them. So nothing here seeds a choice: each handoff is
// asserted on the value the PREVIOUS step actually wrote.
//
// The five handoffs it pins, one assertion each:
//   * the reviewed repo the interview records reaches the GitHub App step
//     (the defect: it read a key nothing wrote);
//   * the App slug GitHub itself reports reaches the slug reconciliation;
//   * the topology reaches the transport selection (compose here, ssh there);
//   * the ingress choice reaches the config fill AND the tunnel profile;
//   * the LLM auth route reaches the config rewrite and the fill's shape line.
//
// Faked: a routed fake ProcessRunner (docker), a fake fetch (GitHub), a
// scripted prompter (the operator), temp dirs for the checkout. No network, no
// docker, no ssh, no pi.
//
// The tail after the slug reconcile (memory, bring-up, verification, the proof
// round, the flip) is deliberately NOT driven here: those steps need a running
// stack and are covered by onboard-memory / onboard-verifystack / onboard-proof
// / onboard-golive / onboard-vmroute. This file owns the HANDOFFS.
import { generateKeyPairSync } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { loadConfig } from "../src/config.js";
import { CHOICE_KEYS } from "../src/onboard/choices.js";
import { OnboardingEngine, type OnboardAdapters, type ProcessResult, type StepContext } from "../src/onboard/engine.js";
import { QUESTIONS, questionAsked, type AnswerKey } from "../src/onboard/steps/configfill.js";
import { ESCALATION_STEP_ID } from "../src/onboard/steps/escalation.js";
import { GITHUB_APP_STEP_ID, SECRET_FILES } from "../src/onboard/steps/githubapp.js";
import { optionFor, setTomlKey } from "../src/onboard/steps/ingress.js";
import { defaultSteps } from "../src/onboard/steps/index.js";
import { githubAppStep } from "../src/onboard/steps/githubapp.js";
import { stackTransportFor } from "../src/onboard/steps/transport.js";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const exampleConfig = readFileSync(join(repoRoot, "config.example.toml"), "utf8");
const { privateKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
const PEM = privateKey.export({ type: "pkcs8", format: "pem" }).toString();

/** What the App is really called on GitHub — deliberately NOT what the
 * operator typed in the interview, so the reconcile handoff is visible. */
const REAL_SLUG = "quick-review-abc123";
const TYPED_SLUG = "acme-reviewer";
const REPO = "acme/widgets";
const HOSTNAME = "review.example.com";
/** A customised trigger label: the App step must create THIS, not the default. */
const TRIGGER_LABEL = "please review";

let root: string;
let secretsDir: string;
let checkout: string;
let calls: string[];
let labels: Set<string>;
let prompts: string[];

/** The operator's answers to the interview, by question id. */
function answers(): Record<AnswerKey, string> {
  return {
    repo: REPO,
    reviewed_repo_dir: checkout,
    app_slug: TYPED_SLUG,
    timezone: "Europe/Warsaw",
    base_branch: "main",
    owner_name: "Dana Operator",
    owner_github_login: "dana-op",
    owner_slack_id: "U01ABCD2EFG",
    escalation_mention: "",
    ssh_host: "review-vm",
    webhook_hostname: HOSTNAME,
  };
}

/** A scripted operator: answers whichever question the wizard actually asks,
 * matched on the step's OWN prompt text so a reworded prompt does not silently
 * become an unanswered question. */
function prompter(): (q: string) => Promise<string> {
  return async (question: string) => {
    prompts.push(question);
    if (/ChatGPT|OAuth|API key/i.test(question) && /1|2/.test(question)) return "2"; // the LLM route
    for (const q of QUESTIONS) {
      if (question.includes(q.prompt)) return answers()[q.id];
    }
    throw new Error(`the scripted operator has no answer for: ${question.slice(0, 200)}`);
  };
}

/** docker, faked: nothing is running yet, and every probe answers cleanly. */
function runner(): OnboardAdapters["runner"] {
  return {
    async run(cmd: string, args: string[]): Promise<ProcessResult> {
      const line = [cmd, ...args].join(" ");
      calls.push(line);
      if (/docker --version/.test(line)) return { code: 0, stdout: "Docker version 27.0.0", stderr: "" };
      if (/docker compose version/.test(line)) return { code: 0, stdout: "Docker Compose version v2.29.0", stderr: "" };
      if (/compose .*ps/.test(line)) return { code: 0, stdout: "", stderr: "" }; // nothing up yet
      return { code: 0, stdout: "", stderr: "" };
    },
  };
}

/** GitHub, faked: the App exists, is installed on the repo owner, and the
 * labels are created on demand. Routed on the PATH, so the real api.github.com
 * base the registered step carries never leaves this process. */
function ghFetch(): typeof fetch {
  return (async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const url = new URL(String(input));
    const path = `${url.pathname}${url.search}`;
    const method = (init?.method ?? "GET").toUpperCase();
    calls.push(`${method} ${path}`);
    const json = (status: number, body: unknown): Response =>
      new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

    if (method === "GET" && url.pathname === "/app") return json(200, { id: 4242, slug: REAL_SLUG });
    if (method === "GET" && url.pathname === "/app/installations") return json(200, [{ id: 77, account: { login: "acme" } }]);
    if (method === "POST" && /^\/app\/installations\/\d+\/access_tokens$/.test(url.pathname)) {
      return json(201, { token: "ghs_installation", expires_at: "2026-08-31T13:00:00Z" });
    }
    const labelGet = /^\/repos\/([^/]+)\/([^/]+)\/labels\/(.+)$/.exec(url.pathname);
    if (method === "GET" && labelGet) {
      const name = decodeURIComponent(labelGet[3]!);
      return labels.has(name) ? json(200, { name }) : json(404, { message: "Not Found" });
    }
    if (method === "POST" && /^\/repos\/[^/]+\/[^/]+\/labels$/.test(url.pathname)) {
      const body = JSON.parse(String(init?.body ?? "{}")) as { name: string };
      labels.add(body.name);
      return json(201, { name: body.name });
    }
    if (method === "GET" && /^\/repos\/[^/]+\/[^/]+$/.test(url.pathname)) return json(200, { full_name: url.pathname.slice(7) });
    if (method === "GET" && url.pathname.startsWith("/users/")) return json(200, { login: url.pathname.slice(7), type: "Organization" });
    return json(500, { message: `unrouted ${method} ${path}` });
  }) as unknown as typeof fetch;
}

function adapters(over: Partial<OnboardAdapters> = {}): OnboardAdapters {
  return {
    fetch: ghFetch(),
    runner: runner(),
    clock: () => new Date("2026-08-31T12:00:00Z"),
    prompter: prompter(),
    host: { nodeVersion: "v22.5.1", uid: 1000 },
    paths: { stateDir: join(root, "state") },
    log: () => undefined,
    ...over,
  };
}

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "qcr-flow-"));
  checkout = join(root, "checkout");
  secretsDir = join(root, "secrets");
  mkdirSync(join(root, "state"), { recursive: true });
  mkdirSync(checkout, { recursive: true });
  mkdirSync(secretsDir, { recursive: true });
  calls = [];
  prompts = [];
  labels = new Set<string>();

  // A checkout-shaped root: the template the interview patches, plus an
  // existing config.toml (the LLM step would otherwise seed one) pointed at
  // this test's secrets dir and carrying a CUSTOMISED trigger label.
  writeFileSync(join(root, "config.example.toml"), exampleConfig);
  let cfg = setTomlKey(exampleConfig, "github", "secrets_dir", secretsDir)!;
  cfg = setTomlKey(cfg, "github", "trigger_label", TRIGGER_LABEL)!;
  writeFileSync(join(root, "config.toml"), cfg);

  // The App credentials the manifest exchange would have written: with these
  // in place the App step VERIFIES rather than creating, so no loopback
  // listener is ever bound.
  writeFileSync(join(secretsDir, SECRET_FILES.appId), "4242\n");
  writeFileSync(join(secretsDir, SECRET_FILES.pem), PEM);
  writeFileSync(join(secretsDir, SECRET_FILES.webhookSecret), "s".repeat(40));
  writeFileSync(join(secretsDir, "openai_api_key"), "sk-testkeytestkeytestkeytestkey");
  writeFileSync(join(secretsDir, "tunnel_token"), "cf-tunnel-token");
});

afterEach(() => rmSync(root, { recursive: true, force: true }));

/** The step inputs a guided session would supply, by step id. */
type Inputs = Record<string, Record<string, unknown>>;

interface Drive {
  engine: OnboardingEngine;
  results: Map<string, { ok: boolean; failures: string[]; checks: Array<{ name: string; ok: boolean; detail: string }> }>;
}

/**
 * Run the REGISTERED steps, in the engine's own order, up to and including
 * `lastId`. Nothing is seeded: every choice a later step reads was recorded by
 * an earlier one in this same drive.
 */
async function drive(engine: OnboardingEngine, inputs: Inputs, lastId: string, skip: string[] = []): Promise<Drive> {
  const results: Drive["results"] = new Map();
  for (const step of engine.stepDefs()) {
    // A step the recorded choices disable is not part of this route — the
    // engine refuses it, exactly as a guided session would skip it.
    const disabled = step.enabled ? !step.enabled(engine.choices()) : false;
    if (!skip.includes(step.id) && !disabled) {
      const r = await engine.runStep(step.id, inputs[step.id] ?? {});
      results.set(step.id, { ok: r.ok, failures: r.failures, checks: r.checks });
    }
    if (step.id === lastId) break;
  }
  return { engine, results };
}

function detail(d: Drive, stepId: string, checkName: string): string {
  const found = d.results.get(stepId)?.checks.find((c) => c.name === checkName);
  expect(found, `step ${stepId} has no "${checkName}" check`).toBeDefined();
  return found!.detail;
}

function producedConfig(): ReturnType<typeof loadConfig> {
  return loadConfig(join(root, "config.toml"));
}

/** A context over the engine's REAL recorded choices — what a later step sees. */
function ctxOverChoices(engine: OnboardingEngine): StepContext {
  return { adapters: adapters(), input: {}, choices: engine.choices(), data: {}, recordChoice: () => undefined };
}

const LAPTOP_INPUTS: Inputs = {
  topology: { choice: "local" },
  ingress: { choice: "named", hostname: HOSTNAME },
  // the escalation step ASKS, and refuses to guess — with no answer
  // it returns its teach-and-offer refusal and the composed flow goes red.
  // "no" is the answer most teams give and the shipped default.
  escalation: { enable: "no" },
};

/** The same flow with escalation switched ON — the "and to whom" half. */
const LAPTOP_INPUTS_ESCALATION: Inputs = {
  ...LAPTOP_INPUTS,
  escalation: {
    enable: "yes",
    targets: "example-teammate",
    why: "you own this repo's migration policy",
    paths: "**/migrations/*.py",
  },
};

// The memory step needs a running OpenViking server; it carries no handoff this
// file asserts and has its own suite (onboard-memory.test.ts).
const SKIP = ["memory"];

describe("the registered steps hand their choices to each other", () => {
  it("drives preflight → topology → LLM → interview → App → ingress → slug, in order", async () => {
    const engine = new OnboardingEngine(defaultSteps(), adapters());
    const d = await drive(engine, LAPTOP_INPUTS, "app_slug_reconcile", SKIP);
    const failed = [...d.results].filter(([, r]) => !r.ok).map(([id, r]) => `${id}: ${r.failures.join("; ")}`);
    expect(failed, "a step in the composed flow went red").toEqual([]);
  });

  // ---, and it is the lesson applied: the escalation step
  // reads `CHOICE_KEYS.configPath`, which only `config_fill` writes. A
  // per-step suite with a seeded choice would pass either way; this drives the
  // real registry with NOTHING seeded, so a key nobody writes is a red step.
  it("HANDOFF 6 — the config path the interview records reaches the escalation step", async () => {
    const engine = new OnboardingEngine(defaultSteps(), adapters());
    const d = await drive(engine, LAPTOP_INPUTS_ESCALATION, ESCALATION_STEP_ID, SKIP);

    expect(String(engine.choices()[CHOICE_KEYS.configPath])).toBe(join(root, "config.toml"));
    const step = d.results.get(ESCALATION_STEP_ID)!;
    expect(step.ok, step.failures.join("; ")).toBe(true);
    // It patched THAT file, and the result loads.
    const cfg = producedConfig();
    expect(cfg.escalation.enabled).toBe(true);
    expect(cfg.escalation.targets).toEqual(["example-teammate"]);
    expect(cfg.escalation.shape).toBe("comment");
    expect(cfg.escalation.rules.map((r) => r.name)).toEqual(["onboarding"]);
    expect(cfg.escalation.rules[0]!.paths).toEqual(["**/migrations/*.py"]);
    expect(cfg.escalation.rules[0]!.to).toBe("example-teammate");
  });

  it("HANDOFF 6b — declining leaves the feature off, and the config still loads", async () => {
    const engine = new OnboardingEngine(defaultSteps(), adapters());
    const d = await drive(engine, LAPTOP_INPUTS, ESCALATION_STEP_ID, SKIP);
    expect(d.results.get(ESCALATION_STEP_ID)!.ok).toBe(true);
    const cfg = producedConfig();
    expect(cfg.escalation.enabled).toBe(false);
    expect(cfg.escalation.targets).toEqual([]);
    expect(cfg.escalation.rules).toEqual([]);
  });

  it("HANDOFF 6c — a half answer never reaches disk", async () => {
    // On, but with nobody to escalate to: the step goes red, and the config it
    // would have written is not written. The loader enforces the same rule, so
    // there is no order of operations that produces a bootable half-config.
    const engine = new OnboardingEngine(defaultSteps(), adapters());
    const inputs: Inputs = { ...LAPTOP_INPUTS, escalation: { enable: "yes", paths: "src/**" } };
    const d = await drive(engine, inputs, ESCALATION_STEP_ID, SKIP);
    const step = d.results.get(ESCALATION_STEP_ID)!;
    expect(step.ok).toBe(false);
    expect(step.failures.join(" ")).toMatch(/targets/);
    expect(producedConfig().escalation.enabled).toBe(false);
  });

  it("HANDOFF 1 — the repo the interview records reaches the App step", async () => {
    const engine = new OnboardingEngine(defaultSteps(), adapters());
    const d = await drive(engine, LAPTOP_INPUTS, GITHUB_APP_STEP_ID, SKIP);

    // Written by the interview…
    expect(engine.choices()[CHOICE_KEYS.repo]).toBe(REPO);
    // …and READ by the App step: it verified the installation on that owner
    // and created the labels on that repository. Before this step
    // refused here, because it read a key nothing wrote.
    expect(d.results.get(GITHUB_APP_STEP_ID)!.ok).toBe(true);
    expect(detail(d, GITHUB_APP_STEP_ID, "installation")).toContain("acme");
    expect(calls).toContain(`POST /repos/${REPO}/labels`);
  });

  it("HANDOFF 1b — the label NAMES the config carries reach the App step", async () => {
    const engine = new OnboardingEngine(defaultSteps(), adapters());
    await drive(engine, LAPTOP_INPUTS, GITHUB_APP_STEP_ID, SKIP);
    // The customised trigger label, not the shipped default: the interview
    // records what the config says and the App step creates exactly that.
    expect([...labels]).toContain(TRIGGER_LABEL);
    expect([...labels]).not.toContain("AI review requested");
  });

  it("HANDOFF 2 — the slug the App reports reaches the reconcile step", async () => {
    const engine = new OnboardingEngine(defaultSteps(), adapters());
    const d = await drive(engine, LAPTOP_INPUTS, "app_slug_reconcile", SKIP);

    // The operator typed one slug; GitHub says another. The App step records
    // GitHub's, and the reconcile step writes it into the config with the
    // derived bot login — the value a wrong one breaks silently.
    expect(engine.choices()[CHOICE_KEYS.appSlug]).toBe(REAL_SLUG);
    expect(engine.choices()[CHOICE_KEYS.botLogin]).toBe(`${REAL_SLUG}[bot]`);
    expect(detail(d, "app_slug_reconcile", "app-identity")).toContain(REAL_SLUG);
    const cfg = producedConfig();
    expect(cfg.github.app_slug).toBe(REAL_SLUG);
    expect(cfg.github.bot_login).toBe(`${REAL_SLUG}[bot]`);
  });

  it("HANDOFF 3 — the topology reaches the transport selection", async () => {
    const engine = new OnboardingEngine(defaultSteps(), adapters());
    await drive(engine, LAPTOP_INPUTS, "topology", SKIP);
    expect(engine.choices()[CHOICE_KEYS.topology]).toBe("local");
    expect(stackTransportFor(ctxOverChoices(engine)).kind).toBe("compose");
  });

  it("HANDOFF 3b — the VM answer, with its alias, selects the ssh transport", async () => {
    const engine = new OnboardingEngine(defaultSteps(), adapters());
    await drive(engine, { topology: { choice: "vm", ssh_host: "review-vm" } }, "topology", SKIP);
    expect(engine.choices()[CHOICE_KEYS.topology]).toBe("vm");
    expect(engine.choices()[CHOICE_KEYS.sshAlias]).toBe("review-vm");
    const transport = stackTransportFor(ctxOverChoices(engine));
    expect(transport.kind).toBe("ssh");
    expect(transport.logsCommand(10)).toContain("review-vm");
  });

  it("HANDOFF 4 — the ingress choice reaches the tunnel profile and the config fill", async () => {
    const engine = new OnboardingEngine(defaultSteps(), adapters());
    await drive(engine, LAPTOP_INPUTS, "app_slug_reconcile", SKIP);

    expect(engine.choices()[CHOICE_KEYS.ingress]).toBe("named");
    // The compose profile that brings the right sidecar up.
    const envText = readFileSync(join(root, ".env"), "utf8");
    expect(envText).toContain(`COMPOSE_PROFILES=${optionFor("named")!.profile}`);
    // And the public endpoint the App step reads when it creates the App.
    expect(engine.choices()[CHOICE_KEYS.webhookUrl]).toBe(`https://${HOSTNAME}/webhook`);

    // The interview's conditional question follows the SAME vocabulary: before
    // the ingress step it does not apply; after it, it does. It used to test
    // for "named-tunnel", a value nothing could ever record, so the question
    // never fired at all.
    const webhookQuestion = QUESTIONS.find((q) => q.id === "webhook_hostname")!;
    expect(questionAsked(webhookQuestion, {})).toBe(false);
    expect(questionAsked(webhookQuestion, engine.choices())).toBe(true);

    // The interview runs at order 35 and the ingress step at 50, so the ingress
    // choice reaches the fill on its RE-RUN — the same second pass that picks
    // up the App slug. Its shape line is where the value lands.
    const rerun = await engine.runStep("config_fill");
    expect(rerun.ok, rerun.failures.join("; ")).toBe(true);
    expect(rerun.checks.find((c) => c.name === "shape")!.detail).toContain("ingress named");
  });

  it("HANDOFF 4b — a re-run of the interview takes the hostname from the ingress step, not the operator", async () => {
    const engine = new OnboardingEngine(defaultSteps(), adapters());
    await drive(engine, LAPTOP_INPUTS, "ingress", SKIP);
    const before = prompts.length;
    const rerun = await engine.runStep("config_fill");
    expect(rerun.ok, rerun.failures.join("; ")).toBe(true);
    // The question now applies — and is answered from the recorded choice, so
    // the operator is never asked for the same hostname twice.
    const asked = prompts.slice(before);
    expect(asked.some((q) => q.includes(QUESTIONS.find((x) => x.id === "webhook_hostname")!.prompt))).toBe(false);
    expect(producedConfig().server.hostname).toBe(HOSTNAME);
  });

  it("HANDOFF 5 — the auth route reaches the config rewrite and the fill's shape line", async () => {
    const engine = new OnboardingEngine(defaultSteps(), adapters());
    const d = await drive(engine, LAPTOP_INPUTS, "config_fill", SKIP);

    expect(engine.choices()[CHOICE_KEYS.authRoute]).toBe("api");
    // The rewrite the route drives: pi's direct-API provider prefix.
    expect(readFileSync(join(root, "config.toml"), "utf8")).toContain('"openai/');
    // And the reader that used to test for "auth_route" / "api_key" and so
    // never said anything at all.
    expect(detail(d, "config_fill", "shape")).toContain("auth route api");
  });
});

describe("the App step's refusal is reachable for the case it describes", () => {
  it("refuses — naming the interview — when the operator skipped it", async () => {
    // Not a construction: the App step is order 40 and the interview 35, and
    // nothing stops a guided session (or a resumed checklist) from calling
    // this tool first. The refusal must name the step that fixes it.
    const engine = new OnboardingEngine(defaultSteps(), adapters());
    const report = await engine.runStep(GITHUB_APP_STEP_ID);
    expect(report.ok).toBe(false);
    expect(report.failures.join(" ")).toContain(CHOICE_KEYS.repo);
    expect(report.failures.join(" ")).toContain("config_fill");
    // It refuses BEFORE any credential is read or any call is made.
    expect(calls.filter((c) => c.startsWith("GET /app"))).toEqual([]);
  });

  it("stops refusing the moment the interview has run — and only then", async () => {
    const engine = new OnboardingEngine(defaultSteps(), adapters());
    const first = await engine.runStep(GITHUB_APP_STEP_ID);
    expect(first.ok).toBe(false);
    await drive(engine, LAPTOP_INPUTS, "config_fill", SKIP);
    const second = await engine.runStep(GITHUB_APP_STEP_ID);
    expect(second.ok, second.failures.join("; ")).toBe(true);
  });

  it("the step declares an app_name parameter and NOT the repo — the repo is the interview's answer", async () => {
    const params = githubAppStep().parameters as { properties?: Record<string, unknown> } | undefined;
    expect(params?.properties).toBeDefined();
    expect(Object.keys(params!.properties!)).toEqual(["app_name"]);
  });
});

describe("the checklist the flow leaves behind", () => {
  it("persists every recorded choice for a resume", async () => {
    const engine = new OnboardingEngine(defaultSteps(), adapters());
    await drive(engine, LAPTOP_INPUTS, "ingress", SKIP);
    const path = join(root, "state", "onboarding", "checklist.json");
    expect(existsSync(path)).toBe(true);
    const file = JSON.parse(readFileSync(path, "utf8")) as { choices: Record<string, unknown> };
    // A second session reads these from disk — the same keys, one declaration.
    for (const key of [CHOICE_KEYS.repo, CHOICE_KEYS.topology, CHOICE_KEYS.authRoute, CHOICE_KEYS.ingress, CHOICE_KEYS.appSlug]) {
      expect(Object.keys(file.choices), `${key} did not survive to the checklist file`).toContain(key);
    }
  });
});
