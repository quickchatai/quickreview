// /review inside a user's pi: the production review (the core's `review()`,
// the same pipeline `qcr review` runs) hosted in this pi process.
//
// - The repo is pi's cwd. The config is the person's qcr config when one is
//   there (`$QCR_CONFIG`, or the install's config home), else the shipped
//   defaults; it is only read.
// - The login is the host pi's, borrowed (login.ts): the host refreshes a
//   short one first, and the run reads a refresh-disabled copy.
// - The run's sessions are nested SDK sessions in this process, isolated
//   from the person's own pi setup (their extensions, skills and settings
//   never reach a reviewer session), and the person's own session gets no
//   tool from the review: the lens tools exist only inside the engine's
//   sessions. Nothing here owns the process: a wedged turn ends its own
//   sessions, never pi.
// - Esc (or the session ending) stops the run.
// - Where the result goes follows the destination rule (reviewdest.ts): flags,
//   else the repo's saved default, else asked each time, else printed. A post
//   goes through the one MutationGate with the install's dry_run; nothing
//   here sets it.
// - The result's JSON is kept in the run's directory under the qcr state
//   home, as `qcr review` keeps its runs.
import { execFileSync } from "node:child_process";
import { appendFileSync, mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { assetRoot } from "../assetroot.js";
import { PI_REFRESH_MARGIN_MS, type AuthCopyWords } from "../engine/auth.js";
import { contextFrom } from "../engine/context.js";
import { lazyReviewRuntime, type ReviewRuntimeOptions } from "../engine/reviewruntime.js";
import { homeProfilePlaces, loadOneShotConfig, stateHome } from "../homes.js";
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
import {
  loadDefaultDestinationsIn,
  planDestinations,
  saveDefaultDestinationsIn,
  type Destination,
} from "../reviewdest.js";
import { prepareReviewHost } from "../reviewhost.js";
import { parseReviewCommand } from "./args.js";
import { borrowLogin, reviewProviders } from "./login.js";
import type { PluginHost, SessionUi } from "./session.js";

/** The custom message type the review is shown as. */
export const REVIEW_MESSAGE = "qcr-review";

/** A review's wall clock, as `qcr review`'s. */
export const REVIEW_TIMEOUT_MS = 60 * 60_000;

/** What a refused login says inside pi: pi's own /login is the fix. */
export const PLUGIN_AUTH_WORDS: AuthCopyWords = {
  missing: (src) => `no pi login at ${src}: run /login in pi, then /review again`,
  expiring: ({ provider, expiresAt, needMs }) =>
    `your ${provider ?? "pi"} login expires at ${new Date(expiresAt).toISOString()}, inside this review's ${Math.round(needMs / 60_000)}-minute window, and pi did not renew it. Run /login${provider ? ` ${provider}` : ""} in pi, then /review again.`,
};

/** How long a stopped review (Esc, the session ending) gets to wind down
 * before /review gives up waiting on it and returns. */
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

/** One run of /review. Never throws: every refusal reaches the person. */
export async function runReviewCommand(
  line: string,
  host: PluginHost,
  ui: SessionUi,
  deps: ReviewCommandDeps = REVIEW_DEPS,
): Promise<void> {
  const fail = (message: string): void => {
    if (ui.mode === "print") ui.print(`✗ ${message}`);
    ui.notify(message, "error");
  };
  const cmd = parseReviewCommand(line);
  if ("error" in cmd) return fail(cmd.error);
  const env: NodeJS.ProcessEnv = { ...host.env, HOME: host.home };
  const warn = (l: string): void => ui.notify(l, "warning");
  let root: string;
  let cfg: CoreConfig;
  let ecosystem: ReviewOptions["ecosystem"];
  let configPath: string | null;
  const profileHomes = homeProfilePlaces(env);
  try {
    root = deps.root();
    const loaded = loadOneShotConfig({ root, env, warn });
    configPath = loaded.path;
    ({ cfg, ecosystem } = contextFrom(
      root,
      loaded,
      cmd.profile ?? loaded.cfg.review.profile,
      "",
      { homes: profileHomes },
      warn,
    ));
  } catch (err) {
    return fail(err instanceof Error ? err.message : String(err));
  }

  const state = stateHome(env);
  const storeDir = join(state, "review");
  const target: ReviewTarget = cmd.target;
  let destinations: Destination[] = [];
  // Posting goes through the one gate with the install's dry_run: a config
  // that keeps dry_run on (the shipped defaults do) would record the post and
  // send nothing, so posting is neither offered nor accepted, and that is said
  // before the review is paid for.
  const postBlocked =
    cfg.dry_run &&
    (configPath === null
      ? "posting needs a qcr config with dry_run = false, and there is none: the shipped defaults keep dry_run on"
      : `posting needs dry_run = false, and ${configPath} keeps dry_run on`);
  if (!cmd.preview && target.kind !== "diff" && target.kind !== "pr" && !isGitWorkTree(host.cwd))
    return fail(`${host.cwd} is not inside a git repository: /review reviews a git checkout`);
  // The providers whose logins ride into the run: the config's, routed by
  // borrowLogin to the OpenAI login that exists.
  let runProviders = reviewProviders(cfg);
  if (!cmd.preview) {
    // The borrowed login first: refreshed by the host when short, refused
    // with a hint when pi has none for a provider the review runs on, before
    // the person is asked anything.
    const borrowed = await borrowLogin({
      providers: runProviders,
      host: host.auth,
      needMs: REVIEW_TIMEOUT_MS,
      marginMs: PI_REFRESH_MARGIN_MS,
    });
    if (!borrowed.ok) return fail(borrowed.error);
    runProviders = borrowed.providers;
    if (postBlocked && cmd.to.includes("pr"))
      return fail(`${postBlocked}; the review was not started.`);
    const plan = planDestinations({
      explicit: cmd.to,
      json: cmd.json,
      interactive: ui.interactive,
      saved: loadDefaultDestinationsIn(storeDir, host.cwd),
      target: { pr: target.kind === "pr" && !postBlocked },
      surface: "session",
    });
    if (plan.kind === "ask" && target.kind === "pr" && postBlocked)
      ui.notify(`${postBlocked}: the review is not offered for posting.`, "info");
    if (plan.kind === "fixed") destinations = plan.destinations;
    else {
      const labels = plan.menu.map((m) => m.label);
      const picked = await ui.select("Where should the review go?", labels, host.shutdown);
      const item = plan.menu.find((m) => m.label === picked);
      if (item === undefined) return ui.notify("review cancelled", "info");
      destinations = item.pick.destinations;
      if (item.pick.remember) {
        const kept = saveDefaultDestinationsIn(storeDir, host.cwd, destinations);
        ui.notify(
          kept
            ? "kept as this repo's default: pass --to to choose otherwise"
            : `this choice could not be kept as a default: ${host.cwd} is not in a git repo`,
          kept ? "info" : "warning",
        );
      }
    }
  }

  // A turn that ignores its abort and dispose cannot be killed here: the
  // process is the person's pi. The budget's last resort (and a stop that does
  // not end the run within its grace) abandons the run instead, so /review
  // returns and pi keeps running.
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
  const onShutdown = (): void => stop.abort();
  host.shutdown.addEventListener("abort", onShutdown, { once: true });
  const offEscape = ui.onEscape(() => {
    if (!stop.signal.aborted) ui.notify("stopping the review…", "warning");
    stop.abort();
  });
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
    full: cmd.full,
    limits: {
      route: "laptop",
      ...(cmd.limitUsd !== undefined ? { limitUsd: cmd.limitUsd } : {}),
      timeoutMs: REVIEW_TIMEOUT_MS,
    },
  };
  const io: ReviewIo = {
    confirm: ui.interactive ? (q, o) => ui.confirm("QuickReview", q, o?.signal) : null,
    progress: (l) => ui.notify(l, "info"),
    started: (s) =>
      ui.status(
        `QuickReview: ${s.lenses.length} lenses, about $${s.estimateUsd.toFixed(2)}` +
          `${s.capUsd !== null ? `, stops at $${s.capUsd.toFixed(2)}` : ""}` +
          `${ui.mode === "tui" ? " — Esc stops it" : ""}`,
      ),
    warn,
    log,
    signal: stop.signal,
  };
  ui.status(cmd.preview ? "QuickReview: pricing…" : "QuickReview: preparing…");
  let result: ReviewResult;
  try {
    result = await Promise.race([
      cmd.preview ? deps.preview(target, opts, io) : deps.review(target, opts, io),
      abandoned,
    ]);
  } catch (err) {
    return fail(err instanceof Error ? err.message : String(err));
  } finally {
    clearTimeout(graceTimer);
    offEscape();
    host.shutdown.removeEventListener("abort", onShutdown);
    ui.status(undefined);
  }
  deliver(result, { cmd, destinations, runDir, ui });
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
  if (o.cmd.preview || dests.has("terminal") || (!dests.has("json") && r.markdown === null))
    ui.show(human + savedNote, r.data);
  else if (dests.has("file")) ui.notify(`review saved: ${saved.join(", ")}`, "info");
  if (r.exitCode !== 0) ui.notify(r.text.split("\n")[0] ?? "the review did not finish", "error");
}
