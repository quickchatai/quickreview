// /qcr-review inside a user's pi: the production review (the core's
// `review()`, the same pipeline `qcr review` runs) hosted in this pi process,
// in the background.
//
// - The command returns at once: the review runs in the same process while
//   the person keeps chatting. The status line shows its progress
//   (`reviewStatusLine`), and the result arrives as the plugin's review
//   message. One review runs per session at a time; a second start says which
//   one is running, and `/qcr-review --stop` (or the session ending) stops it.
//   A preview, and pi's print mode, run in the foreground: a preview starts
//   nothing, and print mode ends when the command returns.
// - The repo is pi's cwd. The config is the person's qcr config when one is
//   there (`$QCR_CONFIG`, or the install's config home), else the shipped
//   defaults; it is only read. A preset (args.ts) is the core's own review
//   options, named.
// - The login is the host pi's, borrowed (login.ts): the host refreshes a
//   short one first, and the run reads a refresh-disabled copy.
// - The run's sessions are nested SDK sessions in this process, isolated
//   from the person's own pi setup (their extensions, skills and settings
//   never reach a reviewer session), and the person's own session gets no
//   tool from the review: the lens tools exist only inside the engine's
//   sessions. Nothing here owns the process: a wedged turn ends its own
//   sessions, never pi.
// - The result is shown in the session and kept as files (the markdown report
//   and the result's JSON in the run's directory under the qcr state home, as
//   `qcr review` keeps its runs). After a PR review the posting rule in pi's
//   settings (settings.ts) decides: ask, with "No, keep it here" first; never;
//   or always. A post is one comment-only review through the one
//   MutationGate with the install's dry_run (the core's `offerPost`); nothing
//   here sets dry_run.
import { execFileSync } from "node:child_process";
import { appendFileSync, mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { assetRoot } from "../assetroot.js";
import { PI_REFRESH_MARGIN_MS, type AuthCopyWords } from "../engine/auth.js";
import { contextFrom } from "../engine/context.js";
import { lazyReviewRuntime, type ReviewRuntimeOptions } from "../engine/reviewruntime.js";
import { homeProfilePlaces, loadOneShotConfig, stateHome } from "../homes.js";
import { runningLensLines } from "../live/lensline.js";
import { latestLiveRound, viewRound } from "../live/read.js";
import {
  preview as corePreview,
  review as coreReview,
  type ReviewIo,
  type ReviewOptions,
  type ReviewResult,
  type ReviewRuntime,
  type ReviewTarget,
} from "../reviewapi.js";
import type { CoreConfig } from "../reviewconfig.js";
import type { Destination } from "../reviewdest.js";
import { prepareReviewHost } from "../reviewhost.js";
import { parseReviewCommand, reviewLabel, REVIEW_PRESETS, type ReviewCommand } from "./args.js";
import { borrowLogin, reviewProviders } from "./login.js";
import type { PluginHost, SessionUi } from "./session.js";
import { DEFAULT_SETTINGS, type PostingRule, type QuickReviewSettings } from "./settings.js";

import { KEEP_IT_HERE, postAnswer } from "./messages.js";
export { KEEP_IT_HERE, postAnswer, REVIEW_MESSAGE } from "./messages.js";

/** A review's wall clock, as `qcr review`'s. */
export const REVIEW_TIMEOUT_MS = 60 * 60_000;

/** What a refused login says inside pi: pi's own /login is the fix. */
export const PLUGIN_AUTH_WORDS: AuthCopyWords = {
  missing: (src) => `no pi login at ${src}: run /login in pi, then /qcr-review again`,
  expiring: ({ provider, expiresAt, needMs }) =>
    `your ${provider ?? "pi"} login expires at ${new Date(expiresAt).toISOString()}, inside this review's ${Math.round(needMs / 60_000)}-minute window, and pi did not renew it. Run /login${provider ? ` ${provider}` : ""} in pi, then /qcr-review again.`,
};

/** How long a stopped review (`--stop`, the session ending) gets to wind
 * down before /qcr-review gives up waiting on it. */
export const STOP_GRACE_MS = 30_000;

/** The seams a test replaces. */
export interface ReviewCommandDeps {
  review: typeof coreReview;
  preview: typeof corePreview;
  /** The core's data root. */
  root: () => string;
  /** The run's runtime (one per run, disposed by the run). */
  runtime: (cfg: CoreConfig, o: ReviewRuntimeOptions) => ReviewRuntime;
}

export const REVIEW_DEPS: ReviewCommandDeps = {
  review: coreReview,
  preview: corePreview,
  root: assetRoot,
  runtime: lazyReviewRuntime,
};

const fence = (lang: string, text: string): string => `\`\`\`${lang}\n${text.trimEnd()}\n\`\`\``;

/** What the status line knows of the review in flight. */
export interface ReviewProgress {
  /** What is reviewed ("PR #12 (quick)", args.ts `reviewLabel`). */
  label: string;
  stage: "pricing" | "preparing" | "running" | "asking" | "posting";
  /** When the command started it (ms). */
  startedAt: number;
  /** From the round's start (`ReviewIo.started`). */
  lenses?: number;
  estimateUsd?: number;
  capUsd?: number | null;
  /** What each running lens is doing, from the round's live log
   * (`liveLensLines`); empty until a lens has started. */
  running?: readonly string[];
}

const elapsed = (ms: number): string => {
  const s = Math.max(0, Math.floor(ms / 1000));
  return s >= 60 ? `${Math.floor(s / 60)}m ${String(s % 60).padStart(2, "0")}s` : `${s}s`;
};

/** The status line for the review in flight: what it reviews, its stage, and
 * what the round's start said (lenses, price, hard stop), with the time
 * since it started. Every status line /qcr-review shows is built here. */
export function reviewStatusLine(p: ReviewProgress, now: number): string {
  const since = elapsed(now - p.startedAt);
  switch (p.stage) {
    case "pricing":
      return `QuickReview: pricing ${p.label}…`;
    case "preparing":
      return `QuickReview: preparing the review of ${p.label}… ${since}`;
    case "running": {
      const plan = [
        ...(p.lenses !== undefined ? [`${p.lenses} lens${p.lenses === 1 ? "" : "es"}`] : []),
        ...(p.estimateUsd !== undefined ? [`about $${p.estimateUsd.toFixed(2)}`] : []),
        ...(p.capUsd !== undefined && p.capUsd !== null
          ? [`stops at $${p.capUsd.toFixed(2)}`]
          : []),
      ];
      const now = p.running?.length
        ? ` · ${p.running[0]}${p.running.length > 1 ? ` (+${p.running.length - 1} more)` : ""}`
        : "";
      return `QuickReview: reviewing ${p.label}${plan.length ? ` — ${plan.join(", ")}` : ""} · ${since}${now}`;
    }
    case "asking":
      return `QuickReview: ${p.label} reviewed in ${since} — post it?`;
    case "posting":
      return `QuickReview: posting the review of ${p.label}…`;
  }
}

/** One line per running lens of the review in `runDir`, read from its live
 * log: none when the log is missing or unreadable, which never costs the
 * review its status line. */
export function liveLensLines(runDir: string, now: number): string[] {
  try {
    const ref = latestLiveRound(runDir);
    const agents = ref ? viewRound(ref).snapshot?.agents : undefined;
    return agents ? runningLensLines(agents, { nowMs: now }) : [];
  } catch {
    return [];
  }
}

/** The one review a session runs at a time. */
export class ReviewSlot {
  private current: { label: string; stop: AbortController; done: Promise<void> } | null = null;

  /** What is being reviewed now; null when nothing is. */
  get running(): string | null {
    return this.current?.label ?? null;
  }

  /** Stop the review in flight; what it was reviewing, or null when none runs. */
  stop(): string | null {
    if (this.current === null) return null;
    this.current.stop.abort();
    return this.current.label;
  }

  /** Resolves once no review runs. */
  async idle(): Promise<void> {
    while (this.current !== null) await this.current.done;
  }

  /** Hold `done` as the review in flight until it settles. */
  hold(label: string, stop: AbortController, done: Promise<void>): void {
    const entry = { label, stop, done };
    this.current = entry;
    void done.finally(() => {
      if (this.current === entry) this.current = null;
    });
  }
}

const fail = (ui: SessionUi, message: string): void => {
  if (ui.mode === "print") ui.print(`✗ ${message}`);
  ui.notify(message, "error");
};

/**
 * /qcr-review. Starts the review and returns at once (pi's print mode and a
 * preview wait for it); the review then runs in `slot`, one at a time. Never
 * throws: every refusal reaches the person.
 */
export async function startReviewCommand(
  line: string,
  host: PluginHost,
  ui: SessionUi,
  o: { slot: ReviewSlot; deps?: ReviewCommandDeps; settings?: QuickReviewSettings },
): Promise<void> {
  const settings = o.settings ?? DEFAULT_SETTINGS;
  const cmd = parseReviewCommand(line, settings.preset);
  if ("error" in cmd) return fail(ui, cmd.error);
  if ("stop" in cmd) {
    const stopped = o.slot.stop();
    if (stopped === null) return ui.notify("no QuickReview review is running here", "info");
    return ui.notify(`stopping the review of ${stopped}…`, "warning");
  }
  const running = o.slot.running;
  if (running !== null)
    return ui.notify(
      `QuickReview is already reviewing ${running}: one review runs at a time. Its result arrives here; /qcr-review --stop stops it.`,
      "warning",
    );
  const label = reviewLabel(cmd);
  const stop = new AbortController();
  // A preview starts nothing and print mode ends with the command: both wait.
  const background = !cmd.preview && ui.interactive;
  const done = reviewJob(cmd, label, host, ui, {
    deps: o.deps ?? REVIEW_DEPS,
    settings,
    stop: stop.signal,
  }).catch((err: unknown) => fail(ui, err instanceof Error ? err.message : String(err)));
  o.slot.hold(label, stop, done);
  if (!background) return done;
  ui.notify(
    `QuickReview is reviewing ${label} in the background. Keep chatting: the result arrives here as a message.`,
    "info",
  );
}

/** One /qcr-review, waited for to its end (its result shown, its post asked):
 * the command's work without the background. */
export async function runReviewCommand(
  line: string,
  host: PluginHost,
  ui: SessionUi,
  deps: ReviewCommandDeps = REVIEW_DEPS,
  settings: QuickReviewSettings = DEFAULT_SETTINGS,
): Promise<void> {
  const slot = new ReviewSlot();
  await startReviewCommand(line, host, ui, { slot, deps, settings });
  await slot.idle();
}

/** The review itself, from the config to the result in the session. */
async function reviewJob(
  cmd: ReviewCommand,
  label: string,
  host: PluginHost,
  ui: SessionUi,
  o: { deps: ReviewCommandDeps; settings: QuickReviewSettings; stop: AbortSignal },
): Promise<void> {
  const { deps } = o;
  const env: NodeJS.ProcessEnv = { ...host.env, HOME: host.home };
  const warn = (l: string): void => ui.notify(l, "warning");
  const preset = cmd.preset !== null ? REVIEW_PRESETS[cmd.preset] : null;
  let root: string;
  let cfg: CoreConfig;
  let ecosystem: ReviewOptions["ecosystem"];
  const profileHomes = homeProfilePlaces(env);
  try {
    root = deps.root();
    const loaded = loadOneShotConfig({ root, env, warn });
    ({ cfg, ecosystem } = contextFrom(
      root,
      loaded,
      cmd.profile ?? loaded.cfg.review.profile,
      preset?.levers ?? "",
      { homes: profileHomes },
      warn,
    ));
  } catch (err) {
    return fail(ui, err instanceof Error ? err.message : String(err));
  }

  const state = stateHome(env);
  const storeDir = join(state, "review");
  const target: ReviewTarget = cmd.target;
  if (!cmd.preview && target.kind !== "diff" && target.kind !== "pr" && !isGitWorkTree(host.cwd))
    return fail(
      ui,
      `${host.cwd} is not inside a git repository: /qcr-review reviews a git checkout`,
    );
  // The providers whose logins ride into the run: the config's, routed by
  // borrowLogin to the OpenAI login that exists.
  let runProviders = reviewProviders(cfg);
  const progress: ReviewProgress = {
    label,
    stage: cmd.preview ? "pricing" : "preparing",
    startedAt: Date.now(),
  };
  const showStatus = (): void => ui.status(reviewStatusLine(progress, Date.now()));
  if (!cmd.preview) {
    // The borrowed login first: refreshed by the host when short, refused
    // with a hint when pi has none for a provider the review runs on, before
    // anything is paid for.
    const borrowed = await borrowLogin({
      providers: runProviders,
      host: host.auth,
      needMs: REVIEW_TIMEOUT_MS,
      marginMs: PI_REFRESH_MARGIN_MS,
    });
    if (!borrowed.ok) return fail(ui, borrowed.error);
    runProviders = borrowed.providers;
  }
  // The result is shown here and kept as files; JSON alone with --json. A
  // post is never a destination: the posting rule offers it after the review.
  const destinations: Destination[] = cmd.preview ? [] : cmd.json ? ["json"] : ["terminal", "file"];

  // A turn that ignores its abort and dispose cannot be killed here: the
  // process is the person's pi. The budget's last resort (and a stop that does
  // not end the run within its grace) abandons the run instead, so the
  // command's work ends and pi keeps running.
  let abandon: (why: string) => void = () => {};
  const abandoned = new Promise<never>((_, reject) => {
    abandon = (why) => reject(new Error(why));
  });
  abandoned.catch(() => undefined);
  let graceTimer: ReturnType<typeof setTimeout> | undefined;
  const stop = new AbortController();
  stop.signal.addEventListener(
    "abort",
    () => {
      graceTimer = setTimeout(
        () => abandon("the review did not stop in time: it was abandoned, and pi keeps running"),
        STOP_GRACE_MS,
      );
      graceTimer.unref?.();
    },
    { once: true },
  );
  const onStop = (): void => stop.abort();
  // `/qcr-review --stop` and the session's end both stop it.
  for (const s of [o.stop, host.shutdown]) {
    if (s.aborted) stop.abort();
    else s.addEventListener("abort", onStop, { once: true });
  }
  let runDir: string | null = null;
  const logFile = join(storeDir, "plugin.log");
  const log = (l: string): void => {
    try {
      mkdirSync(storeDir, { recursive: true });
      appendFileSync(logFile, `${new Date().toISOString()} ${l}\n`);
    } catch {
      // a diagnostics line that cannot be kept never costs the review
    }
  };
  // The review as the post question showed it: it is not shown twice.
  let shownInOffer = false;
  const offerPost = postOffer(o.settings.posting, ui, {
    onAsk: () => {
      shownInOffer = true;
      progress.stage = "asking";
      showStatus();
    },
    onPost: () => {
      progress.stage = "posting";
      showStatus();
    },
  });
  const opts: ReviewOptions = {
    repoDir: host.cwd,
    root,
    agentDir: host.agentDir,
    runsDir: join(storeDir, "runs"),
    dryrunDir: join(storeDir, "dryrun"),
    storeDir,
    config: cfg,
    ecosystem,
    profileHomes,
    runtime: (req) => {
      runDir = req.runDir;
      return deps.runtime(cfg, {
        hostPi: true,
        // The host pi renewed the login for this run's whole window just now.
        authMarginMs: 0,
        warn: log,
        homeDir: host.home,
        fenceDirs: [host.agentDir],
        backstop: (reason) => {
          stop.abort();
          abandon(
            `a review session did not stop at its ${reason === "cap" ? "dollar cap" : "time limit"}: the review was abandoned, and pi keeps running`,
          );
        },
      });
    },
    // Only the review's providers ride into the run, as borrowLogin renewed
    // (and, for an OpenAI model, routed) them: a person's pi holds other
    // logins, which neither go along nor refuse the run.
    prepareHost: (req) =>
      prepareReviewHost({
        ...req,
        profile: req.profile,
        authWords: PLUGIN_AUTH_WORDS,
        authProviders: runProviders,
      }),
    memory: null,
    destinations,
    full: preset?.full ?? false,
    limits: {
      route: "laptop",
      ...(cmd.limitUsd !== undefined ? { limitUsd: cmd.limitUsd } : {}),
      timeoutMs: REVIEW_TIMEOUT_MS,
    },
  };
  const io: ReviewIo = {
    confirm: ui.interactive ? (q, a) => ui.confirm("QuickReview", q, a?.signal) : null,
    // the preview's lines and the memory notice: the status line carries the
    // plan and the price, so these go to the run's log
    progress: log,
    started: (s) => {
      progress.stage = "running";
      progress.lenses = s.lenses.length;
      progress.estimateUsd = s.estimateUsd;
      progress.capUsd = s.capUsd;
      showStatus();
    },
    ...(cmd.preview || offerPost === undefined ? {} : { offerPost }),
    warn,
    log,
    signal: stop.signal,
  };
  // Each second: the time, and once the round runs, what its lenses are doing.
  const tick = (): void => {
    if (runDir !== null && progress.stage === "running")
      progress.running = liveLensLines(runDir, Date.now());
    showStatus();
  };
  showStatus();
  const ticker = setInterval(tick, 1000);
  ticker.unref?.();
  let result: ReviewResult;
  try {
    result = await Promise.race([
      cmd.preview ? deps.preview(target, opts, io) : deps.review(target, opts, io),
      abandoned,
    ]);
  } catch (err) {
    return fail(ui, err instanceof Error ? err.message : String(err));
  } finally {
    clearInterval(ticker);
    clearTimeout(graceTimer);
    for (const s of [o.stop, host.shutdown]) s.removeEventListener("abort", onStop);
    ui.status(undefined);
  }
  deliver(result, { cmd, destinations, runDir, ui, shownInOffer });
}

/** The post question the posting rule makes of a finished PR review
 * (`ReviewIo.offerPost`): asked with No first, never asked, or answered yes.
 * Nobody to ask (print mode) is a no. */
function postOffer(
  rule: PostingRule,
  ui: SessionUi,
  on: { onAsk: () => void; onPost: () => void },
): ReviewIo["offerPost"] {
  if (rule === "never") return undefined;
  if (rule === "always")
    return async (offer) => {
      ui.notify(`posting the review to PR #${offer.pr}, as your posting rule says`, "info");
      on.onPost();
      return true;
    };
  if (!ui.interactive) return undefined;
  return async (offer, a) => {
    on.onAsk();
    // the review first, so the question is about something the person has read
    ui.show(offer.markdown, { pr: offer.pr, repo: offer.repo });
    const yes = postAnswer(offer.dryRun);
    const picked = await ui.select(
      `Post this review to PR #${offer.pr} (${offer.repo}) on GitHub as a comment-only review?`,
      [KEEP_IT_HERE, yes],
      a?.signal,
    );
    if (picked !== yes) {
      ui.notify(`the review of PR #${offer.pr} stays here: nothing was posted`, "info");
      return false;
    }
    on.onPost();
    return true;
  };
}

/** Is `dir` inside a git work tree? */
function isGitWorkTree(dir: string): boolean {
  try {
    return (
      execFileSync("git", ["rev-parse", "--is-inside-work-tree"], {
        cwd: dir,
        encoding: "utf8",
        stdio: ["ignore", "pipe", "ignore"],
      }).trim() === "true"
    );
  } catch {
    return false;
  }
}

/** Put a finished run where it goes. */
function deliver(
  r: ReviewResult,
  o: {
    cmd: { preview: boolean; json: boolean };
    destinations: readonly Destination[];
    runDir: string | null;
    ui: SessionUi;
    /** The post question showed the review already. */
    shownInOffer: boolean;
  },
): void {
  const { ui } = o;
  const json = JSON.stringify(r.data, null, 2);
  const saved: string[] = [];
  // The run's JSON beside its other files, under the state home.
  if (o.runDir !== null) {
    try {
      writeFileSync(join(o.runDir, "review.json"), json + "\n");
      saved.push(join(o.runDir, "review.json"));
    } catch {
      // the run left no directory (a refusal): nothing to keep
    }
  }
  const report = typeof r.data["report"] === "string" ? r.data["report"] : null;
  if (report !== null) {
    const beside = join(dirname(report), "review.json");
    if (!saved.includes(beside)) {
      try {
        writeFileSync(beside, json + "\n");
        saved.push(beside);
      } catch {
        // the report's own line says where it is
      }
    }
    saved.unshift(report);
  }
  const human = r.markdown ?? fence("text", r.text);
  if (ui.mode === "print") {
    ui.print(o.cmd.json || o.destinations.includes("json") ? JSON.stringify(r.data) : human);
    return;
  }
  const dests = new Set(o.destinations);
  const savedNote = saved.length > 0 ? `\n\nSaved: ${saved.map((p) => `\`${p}\``).join(", ")}` : "";
  if (dests.has("json")) ui.show(fence("json", json), r.data);
  if (o.shownInOffer) {
    if (saved.length > 0) ui.notify(`review saved: ${saved.join(", ")}`, "info");
  } else if (o.cmd.preview || dests.has("terminal") || (!dests.has("json") && r.markdown === null))
    ui.show(human + savedNote, r.data);
  else if (dests.has("file")) ui.notify(`review saved: ${saved.join(", ")}`, "info");
  // What the post did, the core's own line (sent, recorded in a dry run, or
  // refused): the last line of its text.
  const post = r.data["post"];
  if (typeof post === "object" && post !== null) {
    const line = r.text.trimEnd().split("\n").pop() ?? "";
    const ok = (post as { ok?: unknown }).ok === true;
    ui.notify(line, ok ? "info" : "error");
  } else if (r.exitCode !== 0)
    ui.notify(
      r.text.split("\n").find((l) => l.trim() !== "") ?? "the review did not finish",
      "error",
    );
}
