// The QuickReview pi plugin: /qcr-review, /qcr-scan and /qcr-setup in a
// user's own pi, each also shipped as a skill of the same name (the
// package's skills/). A factory over its config (the host entry,
// src/plugin/index.ts, reads the process's env and home once and hands them
// in); the commands themselves are src/plugin/.
//
// The names are namespaced because pi's command namespace is shared with
// every other extension: the unprefixed /review, /scan and /selfimprove are
// gone (ADR 0001), and /selfimprove is the app's (its own pi, `qcr pi`).
//
// /qcr-review and /qcr-scan run in the background: the command returns at
// once, one review and one scan run per session, and the session's end stops
// them. /qcr-setup runs in the foreground: the plugin's setup checklist
// (src/setupchecklist.ts), the plugin's own steps only.
//
// At load the running pi's VERSION is checked against the range the package
// declares (src/plugin/versiongate.ts). Outside it the plugin registers no
// command and says so once, at the session's start.
//
// The person's own session gets commands and messages from the plugin, never
// a tool: the review's lens tools exist only inside the engine's own nested
// sessions (passes are leaves: the single-shepherd invariant in AGENTS.md).
//
// The model a run is on is resolved here, over the running pi's own model
// registry (`routeInRunningPi`): the inventory and pi's own reading of a
// model text are the ones every other route uses (./route-registry.ts), and
// the rule is the one every other route uses (../src/modelroute.ts), so
// /qcr-review names the model `qcr review` names on the same machine. Two
// kinds of provider are left out, since the run's own nested host cannot use
// them: one an extension of this pi registered (the nested host loads no
// extension), and one keyed for this process alone (it holds no such key).
import type { Api, Model } from "@earendil-works/pi-ai";
import {
  VERSION,
  getAgentDir,
  getPackageDir,
  type ExtensionAPI,
  type ExtensionCommandContext,
} from "@earendil-works/pi-coding-agent";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { loginSummary, type LoginSummary } from "../src/engine/auth.js";
import { resolveRoute, type RouteInput } from "../src/modelroute.js";
import type { HostAuth, HostRouteAsk, HostRouted } from "../src/plugin/login.js";
import {
  REVIEW_DEPS,
  REVIEW_MESSAGE,
  ReviewSlot,
  startReviewCommand,
  type ReviewCommandDeps,
} from "../src/plugin/review.js";
import { runScanCommand, ScanSessions } from "../src/plugin/scan.js";
import type { PluginHost, Runner, SessionUi } from "../src/plugin/session.js";
import { readQuickReviewSettings, type QuickReviewSettings } from "../src/plugin/settings.js";
import { runSetupCommand } from "../src/plugin/setup.js";
import { declaredPiRange, piGate } from "../src/plugin/versiongate.js";
import { registryInventory, textResolver, type RouteRegistry } from "./route-registry.js";

/** What the host entry hands the plugin. */
export interface QuickReviewConfig {
  /** The process environment, read once by the host entry. */
  env: NodeJS.ProcessEnv;
  /** The user's home. */
  home: string;
  runner: Runner;
  /** Standard output (pi's print mode shows a command's result there). */
  print: (text: string) => void;
  /** Resolve pi's own packages from the running pi's package dir for what the
   * plugin imports later with Node's import() (src/plugin/peers.ts). */
  peers?: (piDir: string) => void;
  /** Test seams: the running pi's version and package dir, its agent dir, the
   * range, the review's core. */
  piVersion?: string;
  piDir?: string;
  agentDir?: string;
  range?: string;
  review?: ReviewCommandDeps;
}

/** The commands, each also a skill of the same name (skills/<name>/SKILL.md). */
export const QUICKREVIEW_COMMANDS = ["qcr-review", "qcr-scan", "qcr-setup"] as const;

/** What the route reads of a running pi: the model its session is on, and
 * its model registry by its public methods. A command's context is one. */
export interface RunningPi {
  model: Model<Api> | undefined;
  modelRegistry: RouteRegistry & {
    find(provider: string, modelId: string): Model<Api> | undefined;
    getRegisteredProviderIds(): readonly string[];
  };
}

/**
 * The providers of the running pi that a run cannot borrow: the run's
 * sessions are on a nested host of their own, which loads no extension and
 * holds no key of this process.
 *
 * VERIFY-ON-PIN (pi 1.4.0): `getRegisteredProviderIds()` lists the providers
 * an extension registered (never a built-in one, never one the person's
 * `models.json` declares), and a provider keyed for this process only
 * (`pi --api-key`) has the auth status source `runtime`.
 */
export function unborrowable(registry: RunningPi["modelRegistry"]): Set<string> {
  const out = new Set<string>(registry.getRegisteredProviderIds());
  for (const provider of new Set(registry.getAvailable().map((m) => m.provider)))
    if (registry.getProviderAuthStatus(provider).source === "runtime") out.add(provider);
  return out;
}

/**
 * One run's route inside a running pi: the inventory and pi's own reading
 * of a model text over its registry, less what a run cannot borrow, then the
 * rule (modelroute.ts `resolveRoute`). The provider the session is on goes
 * first when it is usable. Nothing is skipped here: this pi renews its own
 * logins, and the borrow that follows says when it could not.
 */
export function routeInRunningPi(pi: RunningPi, ask: HostRouteAsk = {}): HostRouted {
  const registry = pi.modelRegistry;
  const exclude = unborrowable(registry);
  const inventory = registryInventory(registry, { exclude });
  // The route carries ids, not models: pi's object for an id its catalog
  // does not hold (a custom pin) is kept for the run's host.
  const custom = new Map<string, Model<Api>>();
  const parse = textResolver({
    getAll: () => registry.getAll(),
    getAvailable: () => registry.getAvailable().filter((m) => !exclude.has(m.provider)),
  });
  const resolveText: RouteInput["resolveText"] = (text) => {
    const r = parse(text);
    if (r.model !== undefined && r.custom === true)
      custom.set(`${r.model.provider}/${r.model.id}`, r.model as Model<Api>);
    return r;
  };
  const session = pi.model;
  const result = resolveRoute({
    inventory,
    skipped: [],
    resolveText,
    ...(ask.pin !== undefined ? { pin: ask.pin } : {}),
    ...(ask.choice !== undefined ? { choice: ask.choice } : {}),
    ...(session !== undefined
      ? { piProvider: { provider: session.provider, from: "pi-session" as const } }
      : {}),
  });
  const nameOf = (provider: string): string => registry.getProviderDisplayName(provider);
  const notes =
    session !== undefined && exclude.has(session.provider)
      ? [
          `${nameOf(session.provider)} is registered by a pi extension (or keyed with --api-key): the review cannot borrow it`,
        ]
      : [];
  if (!result.ok) return { result, inventory, nameOf, notes };
  const route = { ...result.route, notices: [...result.route.notices, ...notes] };
  const model = registry.find(route.provider, route.modelId) ?? custom.get(route.spec);
  return {
    result: { ok: true, route },
    inventory,
    ...(model !== undefined ? { model } : {}),
    nameOf,
    notes,
  };
}

/** The host pi's auth, by the shape the plugin asks of it. */
export function hostAuth(ctx: ExtensionCommandContext, agentDir: string): HostAuth {
  const registry = ctx.modelRegistry;
  return {
    logins(): LoginSummary {
      const file = join(agentDir, "auth.json");
      if (!existsSync(file)) return {};
      try {
        return loginSummary(readFileSync(file, "utf8"));
      } catch {
        return {};
      }
    },
    refresh: async (provider, minValidityMs) => {
      // VERIFY-ON-PIN: the registry facade asks for pi's own five minutes of
      // validity only; its model runtime takes a longer minimum and refreshes
      // under the host's own lock when the token is shorter than that. Absent
      // that runtime, the facade's refresh is the most this pi offers.
      const runtime = (
        registry as unknown as {
          runtime?: {
            getAuth?: (p: string, o: { minOAuthValidityMs: number }) => Promise<unknown>;
          };
        }
      ).runtime;
      if (typeof runtime?.getAuth === "function")
        await runtime.getAuth(provider, { minOAuthValidityMs: minValidityMs });
      else await registry.getProviderAuth(provider);
    },
    // The session's model is read when the route is asked for, not when the
    // command began.
    route: (ask) => routeInRunningPi({ model: ctx.model, modelRegistry: registry }, ask),
  };
}

/** Is `data` the Esc key, as the terminal sends it? */
const isEscape = (data: string): boolean => data === "\x1b" || data === "\x1b[27u";

/** The session's ways to reach the person, from a command's context. */
export function sessionUi(
  pi: ExtensionAPI,
  ctx: ExtensionCommandContext,
  print: (t: string) => void,
): SessionUi {
  return {
    mode: ctx.mode,
    interactive: ctx.hasUI,
    select: (title, options, signal) =>
      ctx.ui.select(title, options, signal ? { signal } : undefined),
    confirm: (title, message, signal) =>
      ctx.ui.confirm(title, message, signal ? { signal } : undefined),
    notify: (message, level) => ctx.ui.notify(message, level),
    status: (text) => ctx.ui.setStatus("quickreview", text),
    onEscape: (handler) =>
      ctx.mode === "tui"
        ? ctx.ui.onTerminalInput((data) => {
            if (!isEscape(data)) return undefined;
            handler();
            return { consume: true };
          })
        : () => {},
    // Shown, never a turn of its own: while the agent streams, the message
    // waits for the turn to end instead of steering it.
    show: (markdown, details) =>
      pi.sendMessage(
        { customType: REVIEW_MESSAGE, content: markdown, display: true, details },
        { triggerTurn: false },
      ),
    tellAgent: (text) =>
      ctx.isIdle() ? pi.sendUserMessage(text) : pi.sendUserMessage(text, { deliverAs: "followUp" }),
    print,
  };
}

/** The plugin's extension factory over `config`. */
export function createQuickReview(config: QuickReviewConfig): (pi: ExtensionAPI) => void {
  return (pi) => {
    const version = config.piVersion ?? VERSION;
    const range = config.range ?? declaredPiRange();
    const refused = piGate(version, range);
    if (refused !== null) {
      let told = false;
      pi.on("session_start", (_event, ctx) => {
        if (told) return;
        told = true;
        ctx.ui.notify(refused, "error");
      });
      return;
    }
    config.peers?.(config.piDir ?? getPackageDir());
    // The current session's end: a run in flight stops with it.
    let shutdown = new AbortController();
    pi.on("session_start", () => {
      if (shutdown.signal.aborted) shutdown = new AbortController();
    });
    pi.on("session_shutdown", () => shutdown.abort());
    const hostOf = (ctx: ExtensionCommandContext): PluginHost => {
      const agentDir = config.agentDir ?? getAgentDir();
      return {
        cwd: ctx.cwd,
        env: config.env,
        home: config.home,
        piVersion: version,
        agentDir,
        auth: hostAuth(ctx, agentDir),
        runner: config.runner,
        shutdown: shutdown.signal,
      };
    };
    // The person's own defaults, as pi's settings hold them now.
    const settings = (ui: SessionUi): QuickReviewSettings => {
      let all: unknown;
      try {
        all = pi.getSettings();
      } catch {
        all = undefined;
      }
      const read = readQuickReviewSettings(all);
      for (const w of read.warnings) ui.notify(w, "warning");
      return read.settings;
    };
    // /qcr-setup: in the foreground, one at a time.
    let busy = false;
    const command = (
      name: Exclude<(typeof QUICKREVIEW_COMMANDS)[number], "qcr-review" | "qcr-scan">,
      description: string,
      run: (args: string, host: PluginHost, ui: SessionUi) => Promise<void>,
    ): void =>
      pi.registerCommand(name, {
        description,
        handler: async (args, ctx) => {
          if (busy) {
            ctx.ui.notify("QuickReview is already running a command in this session", "warning");
            return;
          }
          busy = true;
          try {
            await run(args.trim(), hostOf(ctx), sessionUi(pi, ctx, config.print));
          } finally {
            busy = false;
          }
        },
      });
    // /qcr-review: in the background, one review at a time in this session.
    const reviews = new ReviewSlot();
    pi.registerCommand("qcr-review", {
      description:
        "QuickReview: review this branch with its uncommitted changes, a PR, a branch or --uncommitted, in the background ([quick|full|security] first; --preview prices it, --model names the model for one run, --stop stops it)",
      handler: async (args, ctx) => {
        const ui = sessionUi(pi, ctx, config.print);
        await startReviewCommand(args.trim(), hostOf(ctx), ui, {
          slot: reviews,
          deps: config.review ?? REVIEW_DEPS,
          settings: settings(ui),
        });
      },
    });
    // /qcr-scan: the plugin's own scan engine, in the background, one scan at
    // a time in this session; a subcommand is answered in the foreground.
    const scans = new ScanSessions();
    pi.registerCommand("qcr-scan", {
      description:
        "QuickReview: scan the whole repo in the background (--delta, --sha REF, --model M, --preview; or a scan subcommand: status, stop, findings, units …)",
      handler: async (args, ctx) => {
        await runScanCommand(args.trim(), hostOf(ctx), sessionUi(pi, ctx, config.print), {
          sessions: scans,
        });
      },
    });
    command(
      "qcr-setup",
      "QuickReview: check what the plugin needs (pi, login, git, GitHub); `model` picks the provider reviews run on, `profile` sets up this repo's profile",
      (args, host, ui) => runSetupCommand(args, host, ui, { range }),
    );
  };
}
