// Advanced: what the simple path leaves out, behind one button (x, alt+x,
// `home_advanced`). Each choice runs the wizard's own step modules
// (src/onboard/steps/), registered on the plugin's step registry beside
// switch-on's (ADR 0001) and kept in the same checklist file, so an answer
// given here, in switch-on or in the wizard is one answer:
//
//   A GitHub App          github_account (the App route) → github_app (the
//                         manifest flow, with its loopback or hosted
//                         callback relay) → app_slug_reconcile
//   Webhooks              ingress: a tunnel, so a review starts at once
//                         instead of on the next poll
//   Another server        topology (the server's ssh alias) → ssh_preflight
//                         → vm_inventory → vm_deploy (a release)
//   Slack                 the concierge's own guided tool sets it up; the
//                         step here says what is set up and what is not
//   Dry-run or live       "Stay in dry-run" first, then "Go live": the
//                         go-live step switch-on runs (invariant 6: no other
//                         path moves dry_run, and nothing here moves it back)
//
// Every question is the person's, asked in the home: a tool can open a choice
// but cannot answer it. A step that fails ends the walk with what it said.
import { existsSync, readFileSync } from "node:fs";
import { isAbsolute, join } from "node:path";
import { parse } from "smol-toml";
import {
  type StepRegistry,
  type StepRunResult,
  type StepStatusLine,
} from "@quickchatai/pi-quickreview/src/setupchecklist.js";
import {
  OnboardingEngine,
  type OnboardAdapters,
  type OnboardingStep,
  type StepContext,
  type StepReport,
} from "../onboard/engine.js";
import { userAuthRecorded } from "../onboard/choices.js";
import { APP_SLUG_STEP_ID, appSlugStep } from "../onboard/steps/appslug.js";
import { releaseVersion } from "../onboard/steps/compose.js";
import { GITHUB_ACCOUNT_STEP_ID } from "../onboard/steps/githubaccount.js";
import { GITHUB_APP_STEP_ID, githubAppStep } from "../onboard/steps/githubapp.js";
import { INGRESS_OPTIONS, INGRESS_STEP_ID, secretsDirFor } from "../onboard/steps/ingress.js";
import { VM_INVENTORY_STEP_ID, vmInventoryStep } from "../onboard/steps/inventory.js";
import { SSH_PREFLIGHT_STEP_ID, sshPreflightStep } from "../onboard/steps/ssh.js";
import {
  TOPOLOGY_STEP_ID,
  TOPOLOGY_SWITCH_CONFIRMATION,
  topologyRecorded,
} from "../onboard/steps/topology.js";
import { VM_DEPLOY_STEP_ID, vmDeployStep } from "../onboard/steps/vmdeploy.js";
import type { AutoReviewControl } from "./ports.js";
import { switchOnRegistry, type SwitchOnStepOptions } from "./switchon.js";
import type { Ask } from "./switches.js";

/** The choices, in the person's words. */
export const ADVANCED = {
  close: "Close",
  identity: "A GitHub App: reviews post as a bot, not as you",
  webhooks: "Webhooks: a review starts at once, not on the next poll",
  remote: "Auto-review on another server, over ssh",
  slack: "Slack",
  posting: "Dry-run or live",
} as const;

/** The routes a tool may open by name. */
export const ADVANCED_ROUTES = ["identity", "webhooks", "remote", "slack", "posting"] as const;
export type AdvancedRoute = (typeof ADVANCED_ROUTES)[number];

export const STAY_DRY = "Stay in dry-run";
export const GO_LIVE = "Go live";
export const CANCEL = "Cancel";

/** The app's own step for Slack (src/home/advanced.ts `slackStep`). */
export const SLACK_STEP_ID = "slack";

/** The steps each route runs, in order. */
export const ROUTE_STEPS: Record<Exclude<AdvancedRoute, "posting">, readonly string[]> = {
  identity: [GITHUB_ACCOUNT_STEP_ID, GITHUB_APP_STEP_ID, APP_SLUG_STEP_ID],
  webhooks: [INGRESS_STEP_ID],
  remote: [TOPOLOGY_STEP_ID, SSH_PREFLIGHT_STEP_ID, VM_INVENTORY_STEP_ID, VM_DEPLOY_STEP_ID],
  slack: [SLACK_STEP_ID],
};

/** The slice of a SetupChecklist a route walks. */
export interface AdvancedChecklist {
  runStep(id: string, input?: Record<string, unknown>): Promise<StepRunResult>;
  list(): StepStatusLine[];
  choices(): Readonly<Record<string, unknown>>;
}

export interface AdvancedPort {
  /** The checklist the advanced steps are on; `log` gets each line a step
   * says while it runs. */
  checklist(log: (line: string) => void): AdvancedChecklist;
  /** The release a server deploys when the person names none: this app's. */
  release(): string;
}

/** How Advanced asks: pi's select, and its input for a name or a hostname. */
export interface AdvancedAsk extends Ask {
  input?(title: string, placeholder: string): Promise<string | undefined>;
}

export interface HomeAdvancedOptions {
  port?: AdvancedPort;
  /** Auto-review's switch: its go-live is the posting choice's. */
  autoReview?: AutoReviewControl;
  say: (text: string, kind?: "info" | "ok" | "warn") => void;
  refresh: () => Promise<string>;
}

const NEEDS_PERSON =
  "Advanced asks the person in the home, and no one can answer here; nothing changed";

const line = (id: string, what: string): string => `${id}: ${what}`;

/** Run `plan` on `checklist` in order. A step the recorded choices disable is
 * passed over; the first that fails ends the walk with what it said. */
export async function runRoute(
  checklist: AdvancedChecklist,
  plan: ReadonlyArray<{ id: string; input: Record<string, unknown> }>,
  progress?: (line: string) => void,
): Promise<{ ok: boolean; detail: string; steps: string[] }> {
  const steps: string[] = [];
  let last = "";
  for (const { id, input } of plan) {
    const status = checklist.list().find((s) => s.id === id);
    if (status === undefined) {
      steps.push(line(id, "not on this checklist"));
      return { ok: false, detail: `${id} is not a step here`, steps };
    }
    if (status.status === "disabled") {
      steps.push(line(id, "not on this route"));
      continue;
    }
    progress?.(`${status.title}…`);
    const r = await checklist.runStep(id, input);
    if (!r.ok) {
      const why = r.failures.join("; ") || "it did not finish";
      steps.push(line(id, `failed: ${why}`));
      return { ok: false, detail: `${status.title}: ${why}`, steps };
    }
    last = r.checks.map((c) => c.detail).join("; ") || "done";
    steps.push(line(id, last));
    progress?.(line(id, last));
  }
  return { ok: true, detail: last, steps };
}

const routeOf = (pick: string | undefined): AdvancedRoute | null => {
  for (const r of ADVANCED_ROUTES) if (ADVANCED[r] === pick) return r;
  return null;
};

/** Advanced, as the person meets it: the choice, its questions, its steps. */
export class HomeAdvanced {
  constructor(private readonly o: HomeAdvancedOptions) {}

  /** Open Advanced: the person picks a choice (or the tool named one). */
  async open(ask: AdvancedAsk | undefined, route?: AdvancedRoute): Promise<string> {
    if (!ask) return NEEDS_PERSON;
    let r = route ?? null;
    if (r === null) {
      const pick = await ask.select("Advanced", [
        ...ADVANCED_ROUTES.map((x) => ADVANCED[x]),
        ADVANCED.close,
      ]);
      r = routeOf(pick);
      if (r === null) return "closed: nothing changed";
    }
    if (r === "posting") return this.posting(ask);
    const port = this.o.port;
    if (!port) return `${ADVANCED[r]} can't be set up from this home`;
    const plan = await this.plan(r, port, ask);
    if (plan === null) {
      this.o.say("Nothing changed.");
      return "cancelled: nothing changed";
    }
    if (typeof plan === "string") {
      this.o.say(`${ADVANCED[r]}: ${plan}.`, "warn");
      return plan;
    }
    this.o.say(`${ADVANCED[r]}…`);
    // A line with a link (the App's page to open) stays in the notice while
    // the steps go on: the lines after it would push it out unread.
    let link = false;
    const progress = (l: string): void => {
      if (/https?:\/\//.test(l)) link = true;
      else if (link) return;
      this.o.say(l);
    };
    let out;
    try {
      out = await runRoute(port.checklist(progress), plan, progress);
    } catch (err) {
      out = { ok: false, detail: String(err), steps: [] as string[] };
    }
    await this.o.refresh();
    this.o.say(
      out.ok ? `${ADVANCED[r]}: done. ${out.detail}` : `${ADVANCED[r]}: not done. ${out.detail}`,
      out.ok ? "ok" : "warn",
    );
    return `${out.ok ? "done" : "not done"}: ${out.detail}\n${out.steps.join("\n")}`;
  }

  /** The steps of a route with the person's answers; why it stops here; or
   * null when the person cancelled. */
  private async plan(
    r: Exclude<AdvancedRoute, "posting">,
    port: AdvancedPort,
    ask: AdvancedAsk,
  ): Promise<Array<{ id: string; input: Record<string, unknown> }> | string | null> {
    switch (r) {
      case "identity": {
        const go = await ask.select(
          "Use a GitHub App? It is created from your browser (one click on GitHub's page), installed on your repository, and auto-review then posts as its bot.",
          [CANCEL, "Create the App"],
        );
        if (go !== "Create the App") return null;
        return [
          { id: GITHUB_ACCOUNT_STEP_ID, input: { github_auth: "app" } },
          { id: GITHUB_APP_STEP_ID, input: {} },
          { id: APP_SLUG_STEP_ID, input: {} },
        ];
      }
      case "webhooks": {
        const options = INGRESS_OPTIONS.map((x) => x.headline);
        const pick = await ask.select(
          "How should GitHub reach auto-review? Polling needs nothing; a tunnel delivers webhooks.",
          [CANCEL, ...options],
        );
        const choice = INGRESS_OPTIONS.find((x) => x.headline === pick);
        if (!choice) return null;
        // the own-account route polls: GitHub delivers webhooks to an App
        if (choice.id !== "polling" && userAuthRecorded(port.checklist(() => {}).choices()))
          return `webhooks are delivered to a GitHub App, and auto-review runs on your own account. Set up "${ADVANCED.identity}" first`;
        const input: Record<string, unknown> = { choice: choice.id };
        if (choice.id === "named" || choice.id === "ngrok") {
          if (!ask.input) return "this home can't ask for the tunnel's hostname";
          const host = (
            await ask.input(
              choice.id === "named"
                ? "The tunnel's public hostname, on your domain"
                : "Your ngrok reserved domain (empty: none)",
              "reviews.example.com",
            )
          )?.trim();
          if (host === undefined) return null;
          if (host !== "") input["hostname"] = host;
          else if (choice.id === "named") return "the named tunnel needs its hostname";
        }
        return [{ id: INGRESS_STEP_ID, input }];
      }
      case "remote": {
        if (!ask.input) return "this home can't ask for the server's name";
        const alias = (
          await ask.input("The server's ssh alias, as you type it after `ssh`", "review-box")
        )?.trim();
        if (!alias) return null;
        const topology: Record<string, unknown> = { choice: "vm", ssh_host: alias };
        const recorded = topologyRecorded(port.checklist(() => {}).choices());
        if (recorded === "local") {
          const move = `Move it to ${alias}`;
          const go = await ask.select(
            `Auto-review is set up to run on this machine. Move it to ${alias}? This machine's stack is left as it is; switch it off here once the server runs.`,
            [CANCEL, move],
          );
          if (go !== move) return null;
          topology["confirm"] = TOPOLOGY_SWITCH_CONFIRMATION;
        }
        const release = port.release();
        const named = (
          await ask.input(
            `The release to deploy${release ? ` (empty: ${release}, this app's)` : ""}`,
            release || "1.2.3",
          )
        )?.trim();
        if (named === undefined) return null;
        const version = named || release;
        if (!version) return "a release to deploy is needed";
        return [
          { id: TOPOLOGY_STEP_ID, input: topology },
          { id: SSH_PREFLIGHT_STEP_ID, input: {} },
          { id: VM_INVENTORY_STEP_ID, input: {} },
          { id: VM_DEPLOY_STEP_ID, input: { version } },
        ];
      }
      case "slack":
        return [{ id: SLACK_STEP_ID, input: {} }];
    }
  }

  /** Dry-run or live: staying in dry-run comes first. */
  private async posting(ask: AdvancedAsk): Promise<string> {
    const control = this.o.autoReview;
    if (!control) return "auto-review can't be switched from this home";
    const dry = await control.dryRun();
    if (dry.kind === "unknown") {
      this.o.say(`Whether auto-review posts live is unknown: ${dry.why}.`, "warn");
      return `dry-run unknown: ${dry.why}`;
    }
    if (!dry.value) {
      const said =
        "Auto-review posts live. Going back to dry-run is your own edit: set dry_run = true in your qcr config. Nothing here moves it.";
      this.o.say(said);
      return said;
    }
    const pick = await ask.select(
      "Auto-review is in dry-run: it reviews, and records what it would post instead of posting it. Going live posts each review to GitHub under your name.",
      [STAY_DRY, GO_LIVE],
    );
    if (pick !== GO_LIVE) {
      this.o.say("Auto-review stays in dry-run.");
      return "stays in dry-run: nothing changed";
    }
    const r = await control.goLive({ confirmed: true });
    await this.o.refresh();
    this.o.say(r.ok ? r.detail : `Not live: ${r.detail}`, r.ok ? "ok" : "warn");
    return r.ok ? r.detail : `not live: ${r.detail}`;
  }
}

// ---- Slack: the app's own step ------------------------------------------

type Obj = Record<string, unknown>;
const isObj = (v: unknown): v is Obj => typeof v === "object" && v !== null && !Array.isArray(v);

/** What the config and the secrets dir say of the Slack concierge. */
function slackFacts(ctx: StepContext): { found: string } | { missing: string } {
  let cfg: Obj;
  try {
    const v = parse(readFileSync(ctx.adapters.paths.configPath, "utf8")) as unknown;
    cfg = isObj(v) ? v : {};
  } catch (err) {
    return { missing: `can't read ${ctx.adapters.paths.configPath}: ${String(err)}` };
  }
  const slack = isObj(cfg["slack"]) ? cfg["slack"] : {};
  const howTo =
    "the Slack concierge has its own guided setup, run in a shell from a clone of QuickReview: npm run slack:setup. It creates the Slack app, collects its two tokens, picks the channel and turns it on";
  if (slack["enabled"] !== true) return { missing: `Slack is off: ${howTo}` };
  const channel = typeof slack["channel"] === "string" ? slack["channel"].trim() : "";
  if (channel === "") return { missing: `Slack is on but names no channel: ${howTo}` };
  const secrets = secretsDirFor(ctx.adapters, ctx.choices);
  const missingTokens = (
    [
      ["bot_token_file", "slack_bot_token"],
      ["app_token_file", "slack_app_token"],
    ] as const
  ).flatMap(([key, fallback]) => {
    const name = typeof slack[key] === "string" && slack[key] !== "" ? slack[key] : fallback;
    const path = isAbsolute(name) ? name : join(secrets, name);
    return existsSync(path) ? [] : [path];
  });
  if (missingTokens.length > 0)
    return { missing: `Slack is on, but ${missingTokens.join(" and ")} is missing: ${howTo}` };
  return { found: `Slack is on, in channel ${channel}` };
}

/** Slack, as a registry step: what is set up, and how to set up the rest. */
export function slackStep(): OnboardingStep {
  const report = async (ctx: StepContext): Promise<StepReport> => {
    const f = slackFacts(ctx);
    return "found" in f
      ? { ok: true, checks: [{ name: "slack", ok: true, detail: f.found }] }
      : { ok: false, checks: [{ name: "slack", ok: false, detail: f.missing }] };
  };
  return {
    id: SLACK_STEP_ID,
    title: "Slack",
    explain: "The Slack concierge: one channel, one thread per pull request.",
    order: 95,
    optional: true,
    detect: async (ctx) => slackFacts(ctx),
    run: report,
    verify: report,
  };
}

// ---- the real port --------------------------------------------------------

export interface AdvancedRegistryOptions extends SwitchOnStepOptions {
  /** The env for the App step's hosted callback relay
   * (QCR_ONBOARD_PUBLIC_ORIGIN, QCR_ONBOARD_SETUP_URL). */
  env?: NodeJS.ProcessEnv;
}

/** Switch-on's registry with the advanced steps registered onto it. */
export function advancedRegistry(o: AdvancedRegistryOptions = {}): StepRegistry<OnboardAdapters> {
  return switchOnRegistry(o).register(
    sshPreflightStep(),
    githubAppStep(o.env ? { env: o.env } : {}),
    appSlugStep(),
    vmInventoryStep(),
    vmDeployStep(),
    slackStep(),
  );
}

/** Advanced over the wizard's checklist file and adapters at `root`. */
export function composeAdvanced(o: {
  root: string;
  env: NodeJS.ProcessEnv;
  stepAdapters: (log: (line: string) => void) => OnboardAdapters;
}): AdvancedPort {
  return {
    checklist: (log) => new OnboardingEngine(advancedRegistry({ env: o.env }), o.stepAdapters(log)),
    release: () => releaseVersion(o.root),
  };
}
