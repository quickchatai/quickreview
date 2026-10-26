// /selfimprove in the app's own pi (`qcr pi`, src/npmverbs.ts): scan this
// repo, then have this session's agent fix the findings (src/selfimprove.ts).
// The plugin, loaded beside it, carries /qcr-review, /qcr-scan and /qcr-setup;
// this command is the app's (ADR 0001). A factory over its config: the env
// shim extensions/cli/selfimprove.ts reads the process.
import {
  getAgentDir,
  type ExtensionAPI,
  type ExtensionCommandContext,
} from "@earendil-works/pi-coding-agent";
import { hostAuth, sessionUi } from "@quickchatai/pi-quickreview/extensions/quickreview.js";
import type { PluginHost, Runner } from "@quickchatai/pi-quickreview/src/plugin/session.js";
import { runSelfImproveCommand } from "../src/selfimprove.js";

export interface SelfImproveConfig {
  /** The process environment, read once by the shim. */
  env: NodeJS.ProcessEnv;
  /** The user's home. */
  home: string;
  runner: Runner;
  /** Standard output (pi's print mode shows a command's result there). */
  print: (text: string) => void;
  /** Test seams: the running pi's version and its agent dir. */
  piVersion?: string;
  agentDir?: string;
}

/** The extension factory: registers /selfimprove, one run at a time. */
export function createSelfImprove(config: SelfImproveConfig): (pi: ExtensionAPI) => void {
  return (pi) => {
    // The current session's end: a scan in flight stops with it.
    let shutdown = new AbortController();
    pi.on("session_start", () => {
      if (shutdown.signal.aborted) shutdown = new AbortController();
    });
    pi.on("session_shutdown", () => shutdown.abort());
    let busy = false;
    pi.registerCommand("selfimprove", {
      description: "QuickReview: scan this repo, then have this session's agent fix the findings",
      handler: async (args: string, ctx: ExtensionCommandContext) => {
        if (busy) {
          ctx.ui.notify("/selfimprove is already running in this session", "warning");
          return;
        }
        busy = true;
        try {
          const agentDir = config.agentDir ?? getAgentDir();
          const host: PluginHost = {
            cwd: ctx.cwd,
            env: config.env,
            home: config.home,
            piVersion: config.piVersion ?? "",
            agentDir,
            auth: hostAuth(ctx, agentDir),
            runner: config.runner,
            shutdown: shutdown.signal,
          };
          await runSelfImproveCommand(args.trim(), host, sessionUi(pi, ctx, config.print));
        } finally {
          busy = false;
        }
      },
    });
  };
}
