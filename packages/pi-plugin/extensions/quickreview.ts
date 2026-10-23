// The QuickReview pi plugin: /review, /scan, /qcr-setup and /selfimprove in a
// user's own pi. A factory over its config (the host entry,
// src/plugin/index.ts, reads the process's env and home once and hands them
// in); the commands themselves are src/plugin/.
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
  type ExtensionAPI,
  type ExtensionCommandContext,
} from "@earendil-works/pi-coding-agent";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { loginSummary, type LoginSummary } from "../src/engine/auth.js";
import type { HostAuth } from "../src/plugin/login.js";
import { REVIEW_MESSAGE, runReviewCommand } from "../src/plugin/review.js";
import { runScanCommand, runSelfImproveCommand } from "../src/plugin/scan.js";
import type { PluginHost, Runner, SessionUi } from "../src/plugin/session.js";
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
  /** Test seams: the running pi's version, its agent dir, the range. */
  piVersion?: string;
  agentDir?: string;
  range?: string;
}

/** The commands, in the order /qcr-setup names them. */
export const QUICKREVIEW_COMMANDS = ["review", "scan", "qcr-setup", "selfimprove"] as const;

/** The host pi's auth, by the shape the plugin asks of it. */
function hostAuth(ctx: ExtensionCommandContext, agentDir: string): HostAuth {
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

function sessionUi(
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
    show: (markdown, details) =>
      pi.sendMessage({ customType: REVIEW_MESSAGE, content: markdown, display: true, details }),
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
    // The current session's end: a run in flight stops with it.
    let shutdown = new AbortController();
    pi.on("session_start", () => {
      if (shutdown.signal.aborted) shutdown = new AbortController();
    });
    pi.on("session_shutdown", () => shutdown.abort());
    let busy = false;
    const command = (
      name: (typeof QUICKREVIEW_COMMANDS)[number],
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
            const agentDir = config.agentDir ?? getAgentDir();
            const host: PluginHost = {
              cwd: ctx.cwd,
              env: config.env,
              home: config.home,
              piVersion: version,
              agentDir,
              auth: hostAuth(ctx, agentDir),
              runner: config.runner,
              shutdown: shutdown.signal,
            };
            await run(args.trim(), host, sessionUi(pi, ctx, config.print));
          } finally {
            busy = false;
          }
        },
      });
    command(
      "review",
      "QuickReview: review a PR, this branch or the uncommitted tree (--preview prices it)",
      runReviewCommand,
    );
    command(
      "scan",
      "QuickReview: scan the whole repo (needs the qcr CLI; --sandbox docker to sandbox it)",
      runScanCommand,
    );
    command("qcr-setup", "QuickReview: check what the plugin needs, install qcr", (_a, host, ui) =>
      runSetupCommand(host, ui, { range }),
    );
    command(
      "selfimprove",
      "QuickReview: scan this repo, then have this session's agent fix the findings",
      runSelfImproveCommand,
    );
  };
}
