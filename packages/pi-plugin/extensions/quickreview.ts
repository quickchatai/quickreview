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
import type { HostAuth } from "../src/plugin/login.js";
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
    configured: (provider) => registry.getProviderAuthStatus(provider).configured,
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
        "QuickReview: review this branch with its uncommitted changes, a PR, a branch or --uncommitted, in the background ([quick|full|security] first; --preview prices it, --stop stops it)",
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
        "QuickReview: scan the whole repo in the background (--delta, --sha REF, --preview; or a scan subcommand: status, stop, findings, units …)",
      handler: async (args, ctx) => {
        await runScanCommand(args.trim(), hostOf(ctx), sessionUi(pi, ctx, config.print), {
          sessions: scans,
        });
      },
    });
    command(
      "qcr-setup",
      "QuickReview: check what the plugin needs (pi, login, git, GitHub); `profile` sets up this repo's profile",
      (args, host, ui) => runSetupCommand(args, host, ui, { range }),
    );
  };
}
