// The bot's main session on the SDK: what the tmux `pi` of a PR gets as files,
// an env and a command line, handed to an isolated PiHost session as data. This
// is the factory a per-round bot worker (botworker.ts, P8.3) builds its session
// with; it is the bot's twin of roundsdk.ts (the one-shot's) and its request is
// held byte-equal to the interactive build's by canary 10, bot shape
// (tests/pi-canary/canary-10-bot-request.test.ts).
//
//   extension files          the factories the files' own shims call, in the tmux
//                            bot's load order (src/sessions.ts extensionPaths):
//                            bash-guard, ledger-pin, the lens slot,
//                            finding-clusters, OpenViking (last, the only one
//                            we did not write). Not carried: inject-bridge (the
//                            worker's round order and wakes arrive as prompts),
//                            muted-theme (a TUI skin) and round-progress (the
//                            LiveEvent projection below replaces it).
//   customTools              the engine's lens tools (`lens`, `lens_wave`) and the
//                            post tools of the route (P8.7), as definitions
//   the model's bash env     an allowlist over the spec's env: the QCR_* routing,
//                            the OPENVIKING_* identity, and the GIT_CONFIG_*
//                            pin, which is also set explicitly so no allowlist
//                            edit can drop it (the pin and the guard together
//                            are the exec boundary, src/sessions.ts
//                            sessionGitConfigPins)
//   the IPC capability fd    named by QCR_IPC_CAP_FD in the session's env (a bot
//                            worker's, src/botworker.ts): every bash command
//                            inherits it at the same number, because the post
//                            scripts under it read the capability from that fd.
//                            Node closes any descriptor a child is not listed
//                            with, so it is handed over explicitly
//   the D34 reviewer stub    handed to the resource loader as data (its
//                            agentsFilesOverride), never read from or written
//                            into a checkout. A resumed PR JSONL does not store
//                            the system prompt, pi rebuilds it from what the
//                            loader holds, so the same stub and the same prompt
//                            file at a resume give the session its old prompt
//   the live log             the main session's events go to the LiveEvent log
//                            (src/live/), and its round-progress v2 projection
//                            is published beside it for the supervisor
//
// Bot mode refuses a GitHub token in the session's env or in the host's own
// (rule 3): the bot mints per command from the App credential, so a token in an
// env is a leak waiting for the model's bash.
import { fstatSync } from "node:fs";
import { join } from "node:path";
import type { ExtensionFactory, ToolDefinition } from "@earendil-works/pi-coding-agent";
import { createBashGuard, bashGuardConfigFromEnv } from "../../extensions/bash-guard.js";
import {
  FINDING_CLUSTERS_TOOLS,
  createFindingClusters,
} from "../../extensions/finding-clusters.js";
import { createLedgerPin, ledgerPinConfigFromEnv } from "../../extensions/ledger-pin.js";
import { createOpenViking } from "../../extensions/vendor/openviking-pi/index.js";
import {
  openVikingConfigFromEnv,
  type OpenVikingConfig,
} from "../../extensions/vendor/openviking-pi/qcr-shim.js";
import { GITHUB_TOKEN_ENVS } from "../envstrip.js";
import { LIVE_COALESCE_MS, type LiveSink } from "../live/writer.js";
import { RoundProgressPublisher, roundProgressPath } from "../live/publish.js";
import { openRoundSink, type RoundLive } from "./livewire.js";
import { DEFAULT_TOOLS } from "./pisdk.js";
import type { PiHost } from "./pisdk.js";
import type { Runtime, RuntimeSession, SessionSpec } from "./port.js";
import { BASH_ENV_ALLOW, reviewerStub, type RoundLensTools } from "./roundsdk.js";
import { sdkRuntime, type SessionExtras } from "./sdkruntime.js";
import { releasing } from "./sessionwrap.js";

/** What the model's bash draws from the spec's env on the bot: a round's names
 * and the session's memory identity (OPENVIKING_*, none of it a secret: the key
 * rides a 0600 file). */
export const BOT_BASH_ENV_ALLOW = [...BASH_ENV_ALLOW, "OPENVIKING_*"] as const;

/** The three names of the config-scope pin (`sessionGitConfigPins`). A bot
 * session is refused without them. */
export const GIT_CONFIG_PIN_NAMES = [
  "GIT_CONFIG_GLOBAL",
  "GIT_CONFIG_SYSTEM",
  "GIT_CONFIG_NOSYSTEM",
] as const;

/** The memory tools the OpenViking extension registers (tools.ts), which join the
 * tool allowlist. A tool the session does not register is simply not there. */
export const OPENVIKING_TOOL_NAMES = [
  "viking_search",
  "viking_read",
  "viking_browse",
  "viking_write",
  "viking_archive_expand",
] as const;

type Env = Readonly<Record<string, string | undefined>>;

export interface BotSdkOptions {
  /** The round's lens tools: the engine's (`engineLensTools`), or, until the bot
   * moves off them, the native pair as a factory. */
  lens: RoundLensTools;
  /** The post tools of the route (P8.7), as definitions. They join `customTools`
   * and the allowlist. */
  postTools?: readonly ToolDefinition[];
  /** The host's own env, checked for a GitHub token. Omitted: `process.env`. */
  processEnv?: NodeJS.ProcessEnv;
  /** Where the round's LiveEvent log goes. Omitted: none is written, and no
   * round-progress is published. */
  live?: RoundLive;
  /** Warnings from the live log and the publisher. */
  warn?: (message: string) => void;
  /** Test seam: the OpenViking config as the shim builds it, adjusted. */
  openViking?: (config: OpenVikingConfig) => OpenVikingConfig;
}

/** Rule 3: a bot session holds no GitHub token, in its own env or its host's. A
 * blank value is no token. The error names the variable and never its value. */
export function refuseGithubToken(where: string, env: Env): void {
  const held = GITHUB_TOKEN_ENVS.filter((name) => (env[name] ?? "").trim() !== "");
  if (held.length > 0)
    throw new Error(
      `bot mode: ${where} carries ${held.join(", ")}; the bot's GitHub credential is the App, minted per command (CLAUDE.md rule 3)`,
    );
}

/** The descriptor the model's bash commands inherit: the IPC capability the
 * session's env names, which must be open in this process. */
function capabilityFds(env: Env): number[] {
  const named = env["QCR_IPC_CAP_FD"];
  if (named === undefined || named === "") return [];
  const fd = /^\d{1,4}$/.test(named) ? Number(named) : 0;
  if (fd < 3) throw new Error(`QCR_IPC_CAP_FD is not an fd number (${JSON.stringify(named)})`);
  try {
    fstatSync(fd);
  } catch {
    throw new Error(`QCR_IPC_CAP_FD names fd ${fd}, which is not open in this process`);
  }
  return [fd];
}

/** The PR a bot session serves, from its name. */
function prOf(env: Env): { session: string; pr: number } {
  const session = env["QCR_SESSION_NAME"]?.trim() ?? "";
  const m = /^pr-(\d+)$/.exec(session);
  if (!m) throw new Error(`a bot session is named pr-<n>, got ${JSON.stringify(session)}`);
  return { session, pr: Number(m[1]) };
}

/** The pin values a spec carries, each required. */
function gitPin(env: Env): Record<string, string> {
  const pin: Record<string, string> = {};
  for (const name of GIT_CONFIG_PIN_NAMES) {
    const value = env[name];
    if (value === undefined || value === "")
      throw new Error(
        `a bot session's env lacks ${name}: the git config-scope pin is not optional`,
      );
    pin[name] = value;
  }
  return pin;
}

/** The per-session pieces of a bot's main session on the SDK runtime. */
export function botSdkExtras(options: BotSdkOptions): (spec: SessionSpec) => SessionExtras {
  return (spec) => {
    refuseGithubToken("the session env", spec.env);
    refuseGithubToken("the host env", options.processEnv ?? process.env);
    prOf(spec.env);
    const root = spec.env["QCR_SANDBOX_ROOT"];
    if (root === undefined)
      throw new Error("a bot session's spec names its production tree (QCR_SANDBOX_ROOT)");
    if (spec.systemPromptFile === undefined)
      throw new Error("a bot session carries the PR's system prompt file (systemPromptFile)");
    const home = spec.env["HOME"];
    if (home === undefined) throw new Error("a bot session's env names its pi HOME (HOME)");
    const pin = gitPin(spec.env);
    const inheritFds = capabilityFds(spec.env);
    const memory = openVikingConfigFromEnv({
      env: spec.env,
      argv: ["--approve"],
      cwd: spec.cwd,
      home,
      extensionDir: join(root, "extensions", "vendor", "openviking-pi"),
    });
    const lens = options.lens;
    const customTools = [...(lens.customTools ?? []), ...(options.postTools ?? [])];
    const extensions: ExtensionFactory[] = [
      // The tmux bot's `--extension` order, bash-guard first (it rides pi's
      // global settings there).
      createBashGuard(bashGuardConfigFromEnv(spec.env, spec.cwd)),
      createLedgerPin(ledgerPinConfigFromEnv(spec.env)),
      ...lens.factories,
      createFindingClusters(),
      createOpenViking((options.openViking ?? ((c) => c))(memory)),
    ];
    return {
      extensions,
      tools: [
        ...DEFAULT_TOOLS,
        ...lens.toolNames,
        ...(options.postTools ?? []).map((t) => t.name),
        ...FINDING_CLUSTERS_TOOLS.map((t) => t.name),
        ...OPENVIKING_TOOL_NAMES,
      ],
      ...(customTools.length > 0 ? { customTools } : {}),
      agentsFiles: [reviewerStub(root, spec.cwd)],
      bashEnv: { allow: BOT_BASH_ENV_ALLOW, set: pin },
      ...(inheritFds.length > 0 ? { inheritFds } : {}),
    };
  };
}

/** Feeds the session's events to the round's LiveEvent log and publishes the
 * round-progress projection of it, until the returned session is disposed. */
function withLiveLog(
  session: RuntimeSession,
  spec: SessionSpec,
  live: RoundLive,
  warn: ((message: string) => void) | undefined,
): RuntimeSession {
  const { pr, session: name } = prOf(spec.env);
  const root = live.root;
  let sink: LiveSink;
  try {
    sink = openRoundSink(live, { pr, session: name }, spec.env, warn);
  } catch (err) {
    // A log that cannot be opened never costs the round.
    warn?.(`live log not started: ${String(err).slice(0, 200)}`);
    return session;
  }
  const publisher = new RoundProgressPublisher({
    logPath: sink.path,
    snapshotPath: roundProgressPath(root, pr),
    who: { pr, session: name },
    ...(warn ? { warn } : {}),
  });
  let timer: ReturnType<typeof setTimeout> | undefined;
  const publish = (): void => {
    if (timer !== undefined) clearTimeout(timer);
    timer = undefined;
    sink.flush();
    publisher.catchUp();
  };
  const unhear = session.subscribe(
    (event) => {
      sink.feed(event);
      if (event["type"] === "agent_settled" || event["type"] === "agent_end") publish();
      else if (timer === undefined) {
        timer = setTimeout(publish, LIVE_COALESCE_MS + 50);
        timer.unref?.();
      }
    },
    { updates: true },
  );
  return releasing(session, () => {
    unhear();
    publish();
    sink.close();
    publisher.catchUp();
  });
}

/** The bot's runtime on `host`: a session is the PR's main session, new or
 * resumed from its JSONL under the same id. */
export function botSdkRuntime(host: PiHost, options: BotSdkOptions): Runtime {
  const inner = sdkRuntime(host, { extras: botSdkExtras(options) });
  const live = options.live;
  const attach = (session: RuntimeSession, spec: SessionSpec): RuntimeSession =>
    live === undefined ? session : withLiveLog(session, spec, live, options.warn);
  return {
    create: async (spec) => attach(await inner.create(spec), spec),
    resume: async (file, spec) => attach(await inner.resume(file, spec), spec),
  };
}
