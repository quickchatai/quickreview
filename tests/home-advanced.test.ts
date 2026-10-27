// Advanced (src/home/advanced.ts) through the home's factory, on a fake pi:
// the key or `home_advanced` opens the choices, the person answers each
// question (pi's select and input, scripted here), and each choice runs the
// wizard's step modules as registry steps on a SetupChecklist. First over
// steps that record what they were handed (switch-on's own test pattern),
// then over the wizard's real modules with their step tests' fakes: a
// scratch root with the shipped config, a fake process runner, no network.
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  SetupChecklist,
  StepRegistry,
  type ChecklistAdapters,
  type SetupStep,
} from "@quickchatai/pi-quickreview/src/setupchecklist.js";
import { createHome } from "../extensions/home.js";
import {
  ADVANCED,
  GO_LIVE,
  ROUTE_STEPS,
  SLACK_STEP_ID,
  STAY_DRY,
  advancedRegistry,
  slackStep,
  type AdvancedChecklist,
  type AdvancedPort,
} from "../src/home/advanced.js";
import { known, type AutoReviewControl, type HomeAdapters, type Known } from "../src/home/ports.js";
import { switchOnRegistry, SWITCH_ON_ORDER } from "../src/home/switchon.js";
import {
  OnboardingEngine,
  type OnboardAdapters,
  type ProcessResult,
} from "../src/onboard/engine.js";
import { CHOICE_KEYS } from "../src/onboard/choices.js";
import { APP_SLUG_STEP_ID, appSlugStep } from "../src/onboard/steps/appslug.js";
import { GITHUB_ACCOUNT_STEP_ID, githubAccountStep } from "../src/onboard/steps/githubaccount.js";
import { GITHUB_APP_STEP_ID, githubAppStep } from "../src/onboard/steps/githubapp.js";
import {
  INGRESS_CHOICE_KEY,
  INGRESS_OPTIONS,
  INGRESS_STEP_ID,
  ingressStep,
  readEnvKey,
  readTomlKey,
  setTomlKey,
} from "../src/onboard/steps/ingress.js";
import { VM_INVENTORY_STEP_ID, vmInventoryStep } from "../src/onboard/steps/inventory.js";
import { SSH_PREFLIGHT_STEP_ID, sshPreflightStep } from "../src/onboard/steps/ssh.js";
import {
  TOPOLOGY_CHOICE_KEY,
  TOPOLOGY_STEP_ID,
  TOPOLOGY_SWITCH_CONFIRMATION,
} from "../src/onboard/steps/topology.js";
import { VM_DEPLOY_STEP_ID, vmDeployStep } from "../src/onboard/steps/vmdeploy.js";
import { fakePi, settle, type FakePi } from "./helpers/fake-pi.js";
import { idleReviews } from "./helpers/fake-reviews.js";

const NOW = Date.parse("2026-10-27T12:00:00Z");
const CLOCK = (): Date => new Date(NOW);

/** A key's walk runs on past the key's own settle: let it finish. */
async function drain(): Promise<void> {
  for (let i = 0; i < 10; i++) await settle();
}

interface Ran {
  id: string;
  input: Record<string, unknown>;
}

/** Steps with the advanced routes' ids that record what they were handed. */
function recordingSteps(
  ran: Ran[],
  o: { fail?: string; disabled?: string[] } = {},
): SetupStep<ChecklistAdapters>[] {
  const ids = [...new Set(Object.values(ROUTE_STEPS).flat())];
  return ids.map((id, i) => ({
    id,
    title: `step ${id}`,
    explain: "",
    order: (i + 1) * 10,
    ...(o.disabled?.includes(id) ? { enabled: () => false } : {}),
    run: async (ctx) => {
      ran.push({ id, input: { ...ctx.input } });
      return id === o.fail
        ? { ok: false, checks: [{ name: id, ok: false, detail: "it broke" }] }
        : { ok: true, checks: [{ name: id, ok: true, detail: `${id} ok` }] };
    },
    verify: async () => ({ ok: true, checks: [] }),
  }));
}

/** An advanced port over one in-memory checklist, with recorded choices. */
function recordingPort(
  ran: Ran[],
  o: { fail?: string; disabled?: string[]; choices?: Record<string, unknown> } = {},
): AdvancedPort {
  const c = new SetupChecklist(
    new StepRegistry(recordingSteps(ran, o)),
    { clock: CLOCK },
    {
      file: null,
    },
  );
  const list: AdvancedChecklist = {
    runStep: (id, input) => c.runStep(id, input),
    list: () => c.list(),
    choices: () => o.choices ?? c.choices(),
  };
  return { checklist: () => list, release: () => "1.2.0" };
}

interface Control {
  dryRun: Known<boolean>;
  goLive: number;
  /** The proof round on record (none: undefined). */
  proof?: { pr: number; verdict: string };
}

function control(c: Control): AutoReviewControl {
  return {
    machineChecks: async () => ({ ok: true, detail: "ok" }),
    dryRun: async () => c.dryRun,
    switchOn: async () => ({ ok: true, live: false, detail: "on", steps: [] }),
    proof: async () => c.proof ?? null,
    proofRound: async () => ({ ok: false, detail: "no daemon here" }),
    goLive: async () => {
      c.goLive++;
      return { ok: true, detail: "Auto-review posts live now." };
    },
    running: async () => known([]),
    switchOff: async () => ({ ok: true, detail: "off" }),
  };
}

function adapters(ctl?: AutoReviewControl): HomeAdapters {
  return {
    login: { providers: async () => known(["openai-codex"]) },
    github: {
      user: async () => known("octo"),
      openPulls: async () => known([]),
      openInBrowser: async () => ({ ok: true }),
    },
    repo: { repo: async () => known("acme/widgets") },
    clock: { now: () => NOW },
    reviews: idleReviews(),
    autoReview: {
      status: async () => known({ state: "on-dry" as const }),
      ...(ctl ? { control: ctl } : {}),
    },
    memory: { status: async () => known("off" as const) },
    spend: { totals: async () => known({ today: 0, month: 0 }) },
  };
}

/** The person's answers: to each select by its title, and to each input. */
interface Person {
  select: (title: string, options: string[]) => string | undefined;
  inputs?: string[];
}

interface Home {
  pi: FakePi;
  inputs: string[];
  text(): string;
}

async function openHome(
  advanced: AdvancedPort | undefined,
  person: Person,
  ctl?: AutoReviewControl,
): Promise<Home> {
  const pi = fakePi({ select: person.select });
  const answers = [...(person.inputs ?? [])];
  const asked: string[] = [];
  // pi's input dialog, answered by the person in order
  Object.assign(pi.ctx.ui, {
    input: async (title: string) => {
      asked.push(title);
      return answers.shift();
    },
  });
  await createHome({
    adapters: adapters(ctl),
    model: "openai-codex/gpt-6.1-sol",
    tools: "reviewer",
    every: () => () => {},
    after: () => () => {},
    ...(advanced ? { advanced } : {}),
  })(pi.api);
  await pi.start();
  return {
    pi,
    inputs: asked,
    text: () =>
      pi
        .render(100, 40)
        .lines.map((l) => l.replace(/^[│├╭╰]─*|[│┤╮╯]$/g, "").trim())
        .join(" ")
        .replace(/\s+/g, " "),
  };
}

/** Pick `choice` from Advanced, then answer the rest with `then`. */
const picking =
  (
    choice: string,
    then: (title: string, options: string[]) => string | undefined = () => undefined,
  ) =>
  (title: string, options: string[]): string | undefined =>
    title === "Advanced" ? choice : then(title, options);

describe("Advanced opens from the home", () => {
  it("home_advanced offers the four advanced setups and dry-run or live, and Close", async () => {
    const h = await openHome(recordingPort([]), { select: () => ADVANCED.close });
    expect(await h.pi.tool("home_advanced")).toMatch(/closed/);
    expect(h.pi.selects[0]).toEqual({
      title: "Advanced",
      options: [
        ADVANCED.identity,
        ADVANCED.webhooks,
        ADVANCED.remote,
        ADVANCED.slack,
        ADVANCED.posting,
        ADVANCED.close,
      ],
    });
  });

  it("alt+x opens the same choices", async () => {
    const h = await openHome(recordingPort([]), { select: () => undefined });
    await h.pi.key("alt+x");
    expect(h.pi.selects[0]?.title).toBe("Advanced");
  });

  it("with nobody to answer, nothing runs", async () => {
    const ran: Ran[] = [];
    const pi = fakePi();
    (pi.ctx as { hasUI: boolean }).hasUI = false;
    await createHome({
      adapters: adapters(),
      model: "openai-codex/gpt-6.1-sol",
      tools: "reviewer",
      every: () => () => {},
      after: () => () => {},
      advanced: recordingPort(ran),
    })(pi.api);
    expect(await pi.tool("home_advanced", { choice: "identity" })).toMatch(/no one can answer/);
    expect(ran).toEqual([]);
  });
});

describe("each choice runs its steps on the checklist, in order", () => {
  // MUTATION: drop app_slug_reconcile from the identity plan — this fails.
  it("A GitHub App: the App route, the App's manifest flow, then its slug", async () => {
    const ran: Ran[] = [];
    const h = await openHome(recordingPort(ran), {
      select: picking(ADVANCED.identity, () => "Create the App"),
    });
    const said = await h.pi.tool("home_advanced");
    expect(ran).toEqual([
      { id: GITHUB_ACCOUNT_STEP_ID, input: { github_auth: "app" } },
      { id: GITHUB_APP_STEP_ID, input: {} },
      { id: APP_SLUG_STEP_ID, input: {} },
    ]);
    expect(said).toMatch(/^done/);
    expect(h.text()).toMatch(/A GitHub App: reviews post as a bot, not as you: done/);
  });

  it("cancelled at its question, nothing runs", async () => {
    const ran: Ran[] = [];
    const h = await openHome(recordingPort(ran), {
      select: picking(ADVANCED.identity, () => "Cancel"),
    });
    expect(await h.pi.tool("home_advanced")).toMatch(/cancelled/);
    expect(ran).toEqual([]);
  });

  it("a step the recorded choices disable is passed over", async () => {
    const ran: Ran[] = [];
    const h = await openHome(recordingPort(ran, { disabled: [GITHUB_ACCOUNT_STEP_ID] }), {
      select: picking(ADVANCED.identity, () => "Create the App"),
    });
    const said = await h.pi.tool("home_advanced");
    expect(ran.map((r) => r.id)).toEqual([GITHUB_APP_STEP_ID, APP_SLUG_STEP_ID]);
    expect(said).toContain(`${GITHUB_ACCOUNT_STEP_ID}: not on this route`);
  });

  it("a step that fails ends the walk with what it said", async () => {
    const ran: Ran[] = [];
    const h = await openHome(recordingPort(ran, { fail: GITHUB_APP_STEP_ID }), {
      select: picking(ADVANCED.identity, () => "Create the App"),
    });
    expect(await h.pi.tool("home_advanced")).toMatch(/^not done: step github_app: .*it broke/);
    expect(ran.map((r) => r.id)).toEqual([GITHUB_ACCOUNT_STEP_ID, GITHUB_APP_STEP_ID]);
    expect(h.text()).toMatch(/not done/);
  });

  it("Webhooks: the tunnel the person picks, with its hostname", async () => {
    const ran: Ran[] = [];
    const ngrok = INGRESS_OPTIONS.find((x) => x.id === "ngrok")!;
    const h = await openHome(recordingPort(ran), {
      select: picking(ADVANCED.webhooks, (_t, options) => {
        expect(options[0]).toBe("Cancel");
        return ngrok.headline;
      }),
      inputs: ["reviews.example.org"],
    });
    await h.pi.tool("home_advanced");
    expect(ran).toEqual([
      { id: INGRESS_STEP_ID, input: { choice: "ngrok", hostname: "reviews.example.org" } },
    ]);
  });

  it("Webhooks on the own-account route say the App comes first, and run nothing", async () => {
    const ran: Ran[] = [];
    const quick = INGRESS_OPTIONS.find((x) => x.id === "quick")!;
    const h = await openHome(
      recordingPort(ran, { choices: { [CHOICE_KEYS.githubAuth]: "user" } }),
      {
        select: picking(ADVANCED.webhooks, () => quick.headline),
      },
    );
    expect(await h.pi.tool("home_advanced")).toMatch(/delivered to a GitHub App/);
    expect(ran).toEqual([]);
  });

  // MUTATION: hand the topology step the switch confirmation without asking — the Cancel case fails.
  it("Another server: its ssh alias, the move asked for, the preflight, the inventory and the deploy", async () => {
    const ran: Ran[] = [];
    const h = await openHome(recordingPort(ran, { choices: { [TOPOLOGY_CHOICE_KEY]: "local" } }), {
      select: picking(ADVANCED.remote, (title, options) =>
        title.startsWith("Auto-review is set up to run on this machine") ? options[1] : undefined,
      ),
      inputs: ["review-box", ""],
    });
    await h.pi.tool("home_advanced");
    expect(ran).toEqual([
      {
        id: TOPOLOGY_STEP_ID,
        input: { choice: "vm", ssh_host: "review-box", confirm: TOPOLOGY_SWITCH_CONFIRMATION },
      },
      { id: SSH_PREFLIGHT_STEP_ID, input: {} },
      { id: VM_INVENTORY_STEP_ID, input: {} },
      // no release named: this app's own
      { id: VM_DEPLOY_STEP_ID, input: { version: "1.2.0" } },
    ]);
    expect(h.inputs[0]).toMatch(/ssh alias/);
  });

  it("Another server, the move cancelled: nothing runs", async () => {
    const ran: Ran[] = [];
    const h = await openHome(recordingPort(ran, { choices: { [TOPOLOGY_CHOICE_KEY]: "local" } }), {
      select: picking(ADVANCED.remote, () => "Cancel"),
      inputs: ["review-box"],
    });
    expect(await h.pi.tool("home_advanced")).toMatch(/cancelled/);
    expect(ran).toEqual([]);
  });

  it("Slack: its step says what is set up", async () => {
    const ran: Ran[] = [];
    const h = await openHome(recordingPort(ran), { select: picking(ADVANCED.slack) });
    await h.pi.tool("home_advanced");
    expect(ran).toEqual([{ id: SLACK_STEP_ID, input: {} }]);
  });

  // MUTATION: say every step line in progress, the link line included — this fails.
  it("the App's page to open stays in the notice while the step goes on", async () => {
    let seen = "";
    let h: Home | undefined;
    const app: SetupStep<ChecklistAdapters> = {
      id: GITHUB_APP_STEP_ID,
      title: "The GitHub App",
      explain: "",
      order: 40,
      run: async (ctx) => {
        ctx.adapters.log?.('github_app: open http://127.0.0.1:8788/ and click "Create the App"');
        ctx.adapters.log?.("github_app: it creates qcr-widgets under your account");
        seen = h!.text();
        return { ok: true, checks: [{ name: "app", ok: true, detail: "created and installed" }] };
      },
      verify: async () => ({ ok: true, checks: [] }),
    };
    const port: AdvancedPort = {
      checklist: (log) =>
        new SetupChecklist(
          new StepRegistry(recordingSteps([]).map((x) => (x.id === app.id ? app : x))),
          { clock: CLOCK, log },
          { file: null },
        ),
      release: () => "1.2.0",
    };
    h = await openHome(port, { select: () => "Create the App" });
    await h.pi.tool("home_advanced", { choice: "identity" });
    expect(seen).toMatch(/open http:\/\/127\.0\.0\.1:8788\//);
    expect(seen).not.toMatch(/it creates qcr-widgets/);
  });

  it("a tool may open one choice by name", async () => {
    const ran: Ran[] = [];
    const h = await openHome(recordingPort(ran), { select: () => "Create the App" });
    await h.pi.tool("home_advanced", { choice: "identity" });
    expect(h.pi.selects.map((s) => s.title)).not.toContain("Advanced");
    expect(ran.map((r) => r.id)).toEqual(ROUTE_STEPS.identity);
  });
});

describe("dry-run or live", () => {
  // MUTATION: put "Go live" before "Stay in dry-run" — this fails.
  it("offers staying in dry-run first, and staying moves nothing", async () => {
    const c: Control = { dryRun: known(true), goLive: 0 };
    const h = await openHome(
      recordingPort([]),
      { select: picking(ADVANCED.posting, () => STAY_DRY) },
      control(c),
    );
    expect(await h.pi.tool("home_advanced")).toMatch(/stays in dry-run/);
    expect(h.pi.selects[1]?.options).toEqual([STAY_DRY, GO_LIVE]);
    expect(c.goLive).toBe(0);
  });

  it("Go live runs switch-on's go-live, after the proof round and one more confirm", async () => {
    const c: Control = { dryRun: known(true), goLive: 0, proof: { pr: 7, verdict: "COMMENT" } };
    const h = await openHome(
      recordingPort([]),
      { select: picking(ADVANCED.posting, () => GO_LIVE) },
      control(c),
    );
    await h.pi.tool("home_advanced");
    expect(h.pi.selects[2]?.title).toMatch(/^Go live\? You have read the review of #7\./);
    expect(c.goLive).toBe(1);
    expect(h.text()).toMatch(/Auto-review posts live now/);
  });

  // MUTATION: run control.goLive from the posting choice without the proof flow — this fails.
  it("Go live with no proof round and no pull request to prove it on moves nothing", async () => {
    const c: Control = { dryRun: known(true), goLive: 0 };
    const h = await openHome(
      recordingPort([]),
      { select: picking(ADVANCED.posting, () => GO_LIVE) },
      control(c),
    );
    expect(await h.pi.tool("home_advanced")).toMatch(/no proof round yet/);
    expect(c.goLive).toBe(0);
  });

  // MUTATION: offer a "back to dry-run" that writes the config — this fails (nothing is asked).
  it("live already: says so, asks nothing, and moves nothing back", async () => {
    const c: Control = { dryRun: known(false), goLive: 0 };
    const h = await openHome(recordingPort([]), { select: picking(ADVANCED.posting) }, control(c));
    expect(await h.pi.tool("home_advanced")).toMatch(/posts live.*Nothing here moves it/);
    expect(h.pi.selects).toHaveLength(1);
  });

  it("an unreadable dry_run is unknown, and nothing is offered", async () => {
    const c: Control = { dryRun: { kind: "unknown", why: "no config" }, goLive: 0 };
    const h = await openHome(recordingPort([]), { select: picking(ADVANCED.posting) }, control(c));
    expect(await h.pi.tool("home_advanced")).toMatch(/unknown/);
    expect(c.goLive).toBe(0);
  });
});

// ---- the wizard's real step modules -------------------------------------

describe("the advanced registry", () => {
  // MUTATION: register a copy of a wizard step instead of its own module — this fails.
  it("is switch-on's registry with the wizard's own advanced steps registered onto it", () => {
    const ids = advancedRegistry()
      .steps()
      .map((s) => s.id);
    for (const id of SWITCH_ON_ORDER) expect(ids).toContain(id);
    for (const id of Object.values(ROUTE_STEPS).flat()) expect(ids).toContain(id);
    const byId = new Map(
      advancedRegistry()
        .steps()
        .map((s) => [s.id, s]),
    );
    for (const wizard of [
      githubAppStep(),
      appSlugStep(),
      sshPreflightStep(),
      vmInventoryStep(),
      vmDeployStep(),
    ]) {
      const s = byId.get(wizard.id)!;
      expect([s.title, s.explain, s.order]).toEqual([wizard.title, wizard.explain, wizard.order]);
    }
    expect(
      switchOnRegistry()
        .steps()
        .map((s) => s.id),
    ).not.toContain(GITHUB_APP_STEP_ID);
  });
});

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const exampleConfig = readFileSync(join(repoRoot, "config.example.toml"), "utf8");

let root: string;
let secretsDir: string;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "qcr-advanced-"));
  secretsDir = join(root, "secrets");
  mkdirSync(secretsDir, { recursive: true });
  mkdirSync(join(root, "state"), { recursive: true });
  // the ingress step test's world: the shipped config, its secrets dir here
  writeFileSync(
    join(root, "config.toml"),
    setTomlKey(exampleConfig, "github", "secrets_dir", secretsDir)!,
  );
});
afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

/** The wizard's adapters over the scratch root, with a quiet Docker. */
function stepAdapters(log: (line: string) => void): OnboardAdapters {
  return {
    fetch: (() => {
      throw new Error("no network in tests");
    }) as unknown as typeof fetch,
    runner: { run: async (): Promise<ProcessResult> => ({ code: 0, stdout: "[]", stderr: "" }) },
    clock: CLOCK,
    host: { nodeVersion: "v26.0.0", uid: 1000 },
    paths: { stateDir: join(root, "state"), configPath: join(root, "config.toml") },
    log,
  };
}

/** Advanced over real wizard modules (and stand-ins for those that would
 * open a browser or a server), on the wizard's checklist file. */
function realPort(steps: () => ConstructorParameters<typeof OnboardingEngine>[0]): AdvancedPort {
  return {
    checklist: (log) => new OnboardingEngine(steps(), stepAdapters(log)),
    release: () => "1.2.0",
  };
}

const configText = (): string => readFileSync(join(root, "config.toml"), "utf8");

describe("Advanced over the wizard's own step modules", () => {
  it("Webhooks runs the wizard's ingress step: the quick tunnel is configured", async () => {
    const quick = INGRESS_OPTIONS.find((x) => x.id === "quick")!;
    const port = realPort(() => [
      ingressStep({ stream: { run: async () => ({ code: 0, stdout: "", stderr: "" }) } }),
    ]);
    const h = await openHome(port, { select: picking(ADVANCED.webhooks, () => quick.headline) });
    expect(await h.pi.tool("home_advanced")).toMatch(/^done/);
    expect(readTomlKey(configText(), "ingress", "shape")).toBe("tunnel-file");
    expect(readEnvKey(readFileSync(join(root, ".env"), "utf8"), "COMPOSE_PROFILES")).toBe(
      "quick-tunnel",
    );
    // the answer is the wizard's: recorded in its checklist file
    const file = JSON.parse(
      readFileSync(join(root, "state", "onboarding", "checklist.json"), "utf8"),
    ) as { choices: Record<string, unknown> };
    expect(file.choices[INGRESS_CHOICE_KEY]).toBe("quick");
  });

  it("A GitHub App records the App route with the wizard's own account step", async () => {
    writeFileSync(
      join(root, "config.toml"),
      setTomlKey(configText(), "github", "auth", "user") ?? configText(),
    );
    const stand = (id: string): SetupStep<OnboardAdapters> => ({
      id,
      title: id,
      explain: "",
      order: id === GITHUB_APP_STEP_ID ? 40 : 65,
      run: async () => ({ ok: true, checks: [{ name: id, ok: true, detail: `${id} stand-in` }] }),
      verify: async () => ({ ok: true, checks: [] }),
    });
    const port = realPort(() => [
      githubAccountStep({ env: {} }),
      stand(GITHUB_APP_STEP_ID),
      stand(APP_SLUG_STEP_ID),
    ]);
    const h = await openHome(port, { select: picking(ADVANCED.identity, () => "Create the App") });
    expect(await h.pi.tool("home_advanced")).toMatch(/^done/);
    const file = JSON.parse(
      readFileSync(join(root, "state", "onboarding", "checklist.json"), "utf8"),
    ) as { choices: Record<string, unknown> };
    expect(file.choices[CHOICE_KEYS.githubAuth]).toBe("app");
  });

  it("Slack's step: off says how to set it up; on, with its tokens, is done", async () => {
    const off = await openHome(
      realPort(() => [slackStep()]),
      { select: picking(ADVANCED.slack) },
    );
    expect(await off.pi.tool("home_advanced")).toMatch(/Slack is off: .*npm run slack:setup/);
    const withChannel = setTomlKey(configText(), "slack", "channel", "C0123456")!;
    const at = withChannel.indexOf("\n[slack]\n");
    writeFileSync(
      join(root, "config.toml"),
      withChannel.slice(0, at) +
        withChannel.slice(at).replace(/^enabled = false$/m, "enabled = true"),
    );
    writeFileSync(join(secretsDir, "slack_bot_token"), "x");
    writeFileSync(join(secretsDir, "slack_app_token"), "x");
    const on = await openHome(
      realPort(() => [slackStep()]),
      { select: picking(ADVANCED.slack) },
    );
    expect(await on.pi.tool("home_advanced")).toMatch(/^done: Slack is on, in channel C0123456/);
  });
});

// ---- the home never names the admin TUI ----------------------------------

describe("no home surface names `qcr tui`", () => {
  // MUTATION: add "open `qcr tui` for more" to any notice in src/home/advanced.ts — this fails.
  it("the home's own modules, its extension and its shim never say it", () => {
    const home = join(repoRoot, "src", "home");
    const files = [
      ...readdirSync(home)
        .filter((f) => f.endsWith(".ts"))
        .map((f) => join(home, f)),
      join(repoRoot, "extensions", "home.ts"),
      join(repoRoot, "extensions", "cli", "home.ts"),
    ];
    expect(files.some((f) => f.endsWith("advanced.ts"))).toBe(true);
    for (const f of files) expect(readFileSync(f, "utf8"), f).not.toMatch(/qcr\s+tui|admin TUI/i);
  });

  it("nor does any line the panel draws or any tool's answer while it is driven", async () => {
    const ran: Ran[] = [];
    const h = await openHome(recordingPort(ran), { select: () => undefined });
    const answers = [
      await h.pi.tool("home_status"),
      await h.pi.tool("home_advanced"),
      await h.pi.tool("home_tune"),
    ];
    await drain();
    for (const t of [...answers, h.text()]) expect(t).not.toMatch(/qcr\s+tui/i);
  });
});
