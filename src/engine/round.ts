// One review round on an injected runtime: write the round's artifacts, send
// the main session the production round order, send ONE follow-up when the
// outputs are missing or unreadable, then read the files and render them
// through the production review renderer.
//
// The runtime hosts the session. On the process runtime the follow-up is a
// `--continue` respawn of the same pi session; on the SDK runtime it is a
// second turn on the same live session. The round does not know which: it sees
// the port (port.ts) and nothing of pi's command line or SDK.
//
// Shared by the benchmark (src/bench/runner.ts reviewCase) and `qcr review`
// (through src/oneshot.ts). It takes a prepared tree, its file list, a target
// description and an output directory; it knows nothing of bench cases,
// stores or prefetching. No daemon, tmux, inject bridge or memory: a process
// that exits when the round settles (CLAUDE.md rule 8's boundary: no GitHub
// credential reaches it).
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { delimiter, dirname, join } from "node:path";
import type { CoreConfig } from "../reviewconfig.js";
import type { Ecosystem } from "../ecosystem.js";
import type { PrFileEntry } from "../github.js";
import { CONTEXT_PACK_FILE } from "../contextpack.js";
import type { RoundMemory } from "../memoryport.js";
import { isDefaultPosting } from "../postingpolicy.js";
import {
  modelErrorKind,
  modelErrorsFromEvents,
  stagesFromEvents,
  usageFromEvents,
  type ModelErrors,
  type Stages,
} from "./roundevents.js";
import { CASE_FILES, POLICED_ORIGINALS, type BenchPostingReport } from "./caseout.js";
import { caseCostUsd } from "../pricing.js";
import { lineHasAuthError } from "../authwatch.js";
import { checkAuth, classifyAuthFailure, type AuthRejected, type EngineAuth } from "./auth.js";
import type { PiRun, Runtime, RuntimeSession } from "./port.js";
import { apiKeyEnv } from "./keyroute.js";
import { GIT_ISOLATION_ENV, GITHUB_TOKEN_ENVS } from "../envstrip.js";
import { openRoundSink, type RoundLive } from "./livewire.js";
import type { LiveSink } from "../live/writer.js";
import { planLaunch, type LaunchUnit } from "./lens/launch-plan.js";
import {
  launchWave,
  type EngineRoute,
  type EngineRouteRuntime,
  type WaveRow,
} from "./lens/wave.js";
import { LENS_SESSIONS_DIR, MAIN_SESSION_DIR, openEnvOf, writeOpenMeta } from "./openable.js";
import {
  engineLensSection,
  renderOneShotPrompts,
  type OneShotPrompts,
  type OneShotTarget,
} from "./prompts.js";
import { renderBenchOutputs } from "./render.js";

export type { PiRun };

export function readJson(path: string): unknown {
  try {
    return JSON.parse(readFileSync(path, "utf8"));
  } catch {
    return undefined;
  }
}

/** Why a session's JSON output file cannot be used: `undefined` when it parses,
 * `"missing"` when absent, otherwise the parser's message. */
export function jsonProblem(path: string): string | undefined {
  if (!existsSync(path)) return "missing";
  try {
    JSON.parse(readFileSync(path, "utf8"));
    return undefined;
  } catch (err) {
    return String(err instanceof Error ? err.message : err).slice(0, 300);
  }
}

/** The BENCHMARK MODE files a scorer reads as JSON: the outcome always; the
 * findings record when the bench renders the posted review from it, else the
 * session's own comments. */
function scoredOutputs(renderOutputs: boolean): string[] {
  return renderOutputs
    ? [CASE_FILES.findings, CASE_FILES.outcome]
    : [CASE_FILES.comments, CASE_FILES.outcome];
}

/** The scored BENCHMARK MODE files the session wrote that do not parse. A
 * missing file is not listed here (`missingOutputs` lists it). */
export function unparseableOutputs(caseDir: string, renderOutputs: boolean): string[] {
  const names = scoredOutputs(renderOutputs);
  const out: string[] = [];
  for (const n of names) {
    const p = jsonProblem(join(caseDir, n));
    if (p !== undefined && p !== "missing") out.push(`${n} is not valid JSON (${p})`);
  }
  return out;
}

/** The scored BENCHMARK MODE files the session has not written. */
export function missingOutputs(caseDir: string, renderOutputs: boolean): string[] {
  return scoredOutputs(renderOutputs).filter((n) => !existsSync(join(caseDir, n)));
}

/** The session's event stream and stderr in a case dir. */
export const PI_RUN_FILES = ["pi-events.jsonl", "pi-stderr.log"] as const;

// ---- the run ----------------------------------------------------------------

export interface RoundSpec {
  /** The production tree (prompts/, extensions/, agents/). Where the session
   * runs unless `cwd` says otherwise (the bench: its project-scope lens
   * agents live under it). */
  root: string;
  /** Where pi runs, and so which context file, project settings and project
   * agents it discovers. Omitted: `root`. The host route (`qcr review`) passes
   * the run's own dir outside every checkout, holding the reviewer stub, so a
   * checkout never carries a context file of ours (src/hostroute.ts). */
  cwd?: string;
  /** Which lens agents the session resolves: "project" (the nearest
   * `.pi/agents` above the cwd, the bench's) or "user" (`<agentDir>/agents`,
   * the host route's). Omitted: "project". */
  agentScope?: "project" | "user";
  /** pi's agent dir for this run (its login). */
  agentDir: string;
  /** The prepared checkout of the target, at its head. */
  tree: string;
  /** The files the target changes. */
  files: PrFileEntry[];
  target: OneShotTarget;
  /** Where the session's files, the event stream and the rendered review go. */
  outDir: string;
  cfg: CoreConfig;
  ecosystem: Ecosystem;
  timeoutMs: number;
  /** The login the run will use, as the engine's auth module read it
   * (src/engine/auth.ts). Given, the round refuses before it writes anything
   * when the token would expire inside `timeoutMs` (`AuthExpiring`). */
  auth?: Pick<EngineAuth, "expiresAt" | "provider">;
  /** pi's spill dir. Omitted: `<outDir>/tmp`, removed when the run ends. A
   * given dir is emptied here (what an earlier attempt left is not this
   * attempt's) and is the caller's to remove. */
  tmpDir?: string;
  /** Prompts rendered by the caller (a bench follow-up). Omitted: the first
   * round's, rendered here. On an engine lens route the round appends the
   * engine-only section to their order (`result.prompts` carries the sent one). */
  prompts?: OneShotPrompts;
  dependencyNote?: string;
  /** The memory seed for the first round's prompt (ignored with `prompts`). */
  memory?: RoundMemory;
  /** Names the run in log lines (default `repo#number`). */
  label?: string;
  /** The session name pi is given (default `oneshot-<number>`). */
  sessionName?: string;
  /** When the caller's clock started, so the continuation's budget counts
   * work done before the runner (default: now). */
  startedAt?: number;
  /** Hard stop in dollars: the session (lens children with it) is killed once
   * pi's own price for the round reaches this. The result says `capped`. */
  capUsd?: number;
  /** Where the round's LiveEvent log goes (src/live/). Omitted: none is written. */
  live?: RoundLive;
  log?: (line: string) => void;
  /** Stops the round: an abort before the session exists starts none, and one
   * during a turn aborts it (lens children with it) and skips the
   * continuation. The round then settles what was written, as after any stop. */
  signal?: AbortSignal;
}

export interface RoundResult {
  prompts: OneShotPrompts;
  plannedLenses: string[];
  piRun: PiRun;
  /** The one `--continue` ran. */
  continued: boolean;
  /** The round was stopped at `capUsd` before it finished. */
  capped: boolean;
  /** Why the round could not be read: no session to continue, or the output
   * stream failed. */
  error?: string;
  /** Distinct warning lines from pi's stderr, then usage and render problems. */
  warnings: string[];
  /** The provider refused the login mid-round (authwatch's signature in pi's
   * output). The round's own `error` names it too when nothing else does. */
  authError?: AuthRejected;
  /** Absent when the event stream could not be read. */
  usage?: ReturnType<typeof usageFromEvents>;
  modelErrors?: ModelErrors;
  stages?: Stages["phases"];
  /** pi's own price for the whole round (every lens child included). */
  costUsd: number | null;
  /** outcome.json: verdict, passes, summary. */
  outcome?: Record<string, unknown>;
  /** The findings record, after the production post-checks. */
  findings?: unknown;
  /** The rendered review body (review.md); null when nothing was rendered. */
  review: string | null;
  /** The rendered inline comments (comments.json). */
  comments?: unknown[];
  /** `[posting]` policy applied inside the render step (non-default only). */
  renderedPosting?: BenchPostingReport;
}

/** The typed refusal in a round's output, if the provider refused the login. */
function authRefusal(
  stderrLines: readonly string[],
  eventsFile: string,
  streamError: string | null,
): AuthRejected | undefined {
  for (const text of [...stderrLines, streamError ?? ""]) {
    const refused = classifyAuthFailure(text.trim().slice(0, 300));
    if (refused) return refused;
  }
  try {
    for (const line of readFileSync(eventsFile, "utf8").split("\n")) {
      if (!lineHasAuthError(line)) continue;
      // The provider's own text is the record's errorMessage; the line is long.
      const said = /"errorMessage":("(?:[^"\\]|\\.)*")/.exec(line)?.[1];
      const text = said === undefined ? line : (JSON.parse(said) as string);
      return classifyAuthFailure(text.slice(0, 300));
    }
  } catch {
    // An unreadable stream is reported by the usage step.
  }
  return undefined;
}

/** How long a round waits for the engine's wave rows to settle once it has
 * ended them (each ends its session and writes its ledger line). */
const WAVE_SETTLE_MS = 15_000;

/** What a round writes before its session starts, and what the session is
 * started with. `runRound` hosts the session on a runtime; the debug round
 * (src/engine/debugpi.ts) hands the same things to an interactive pi. */
export interface PreparedRound {
  /** The order, the engine-only section included on an engine route. */
  prompts: OneShotPrompts;
  /** The system prompt file the round wrote. */
  sysPath: string;
  /** The environment the session's tools see (no GitHub token). */
  env: NodeJS.ProcessEnv;
  sessionName: string;
  /** Where the main session's JSONL goes (D10: kept per round). */
  sessionDir: string;
  /** The session's event stream and stderr files. */
  events: string;
  stderr: string;
  /** The planned discovery wave (engine route with `plannedWave` only). */
  waveUnits: LaunchUnit[];
  startWarnings: string[];
  tmpDir: string;
  /** `tmpDir` is the round's own: removed when it ends. */
  ownTmp: boolean;
}

/** Write the round's files into `i.outDir` and work out the session's env, order
 * and wave. `route` is the engine route the round runs on, if any. Throws only
 * for an unwritable output dir or a login that cannot cover the run (`auth`). */
export function prepareRound(
  i: RoundSpec,
  route: Pick<EngineRoute, "plannedWave"> | undefined,
): PreparedRound {
  const { cfg, outDir, tree, root } = i;
  // Before a file is written or a session started: a login that cannot cover
  // the run is refused here, typed (AuthExpiring), not found out by pi.
  if (i.auth) checkAuth(i.auth, { needMs: i.timeoutMs });
  const ownTmp = i.tmpDir === undefined;
  const tmpDir = i.tmpDir ?? join(outDir, "tmp");
  mkdirSync(outDir, { recursive: true });
  // What an earlier attempt wrote here is not this attempt's review.
  for (const f of [...Object.values(CASE_FILES), ...POLICED_ORIGINALS, ...PI_RUN_FILES])
    rmSync(join(outDir, f), { force: true });
  rmSync(tmpDir, { recursive: true, force: true });
  mkdirSync(tmpDir, { recursive: true });
  try {
    const rendered =
      i.prompts ??
      renderOneShotPrompts({
        root,
        cfg,
        ecosystem: i.ecosystem,
        target: i.target,
        tree,
        caseDir: outDir,
        files: i.files,
        issuedAt: new Date().toISOString(),
        ...(i.dependencyNote ? { dependencyNote: i.dependencyNote } : {}),
        ...(i.memory ? { memory: i.memory } : {}),
      });
    // An earlier attempt's task files never leak into this one: launch_plan
    // launches every task file the dir holds.
    rmSync(join(outDir, "tasks"), { recursive: true, force: true });
    rmSync(join(outDir, CONTEXT_PACK_FILE), { force: true });
    for (const f of rendered.extraFiles ?? []) {
      mkdirSync(dirname(f.path), { recursive: true });
      writeFileSync(f.path, f.text);
    }
    if (rendered.contextPack) writeFileSync(rendered.contextPack.path, rendered.contextPack.text);
    if (rendered.taskFiles.length) {
      mkdirSync(join(outDir, "tasks"), { recursive: true });
      for (const t of rendered.taskFiles) writeFileSync(t.path, t.text);
    }
    const sysPath = join(outDir, "system-prompt.md");
    writeFileSync(sysPath, rendered.system);
    writeFileSync(
      join(outDir, "files.json"),
      JSON.stringify(
        i.files.map(({ patch: _p, ...f }) => f),
        null,
        2,
      ),
    );
    const sessionName = i.sessionName ?? `oneshot-${i.target.number}`;
    const env: NodeJS.ProcessEnv = {
      PATH: process.env.PATH ?? "/usr/local/bin:/usr/bin:/bin",
      HOME: process.env.HOME ?? "/tmp",
      TMPDIR: tmpDir,
      LANG: "C.UTF-8",
      PI_CODING_AGENT_DIR: i.agentDir,
      QCR_SUBAGENT_SCOPE: i.agentScope ?? "project",
      QCR_SUBAGENT_MAX_CONCURRENCY: String(cfg.engine.lens_max_concurrency),
      QCR_SUBAGENT_CACHE_GROUP: String(cfg.engine.lens_cache_group),
      QCR_SUBAGENT_CACHE_STAGGER_MS: String(cfg.engine.lens_cache_stagger_ms),
      QCR_SUBAGENT_PASS_DEADLINE_MIN: String(cfg.engine.lens_pass_deadline_min),
      // This run's task dirs are its sanctioned launch_plan dirs
      // (production's live under state/pr-<n>-round-<k>-passes/).
      QCR_LAUNCH_PLAN_DIRS: [
        join(outDir, "tasks"),
        join(outDir, "tasks-optional"),
        join(outDir, "tasks-sweep"),
      ].join(delimiter),
      QCR_SANDBOX_ROOT: root,
      QCR_SESSION_NAME: sessionName,
      QCR_PR: String(i.target.number),
      QCR_PR_META: `PR #${i.target.number} — ${i.target.title ?? i.target.repo} (worktree ${tree})`,
      QCR_WORKTREE: tree,
      QCR_LEDGER_FILE: join(outDir, "ledger.md"),
      QCR_PI_VERSION: cfg.pi.version,
      ...GIT_ISOLATION_ENV,
      // An `anthropic/` model arm: pi's anthropic provider reads this key.
      ...(process.env.ANTHROPIC_API_KEY
        ? { ANTHROPIC_API_KEY: process.env.ANTHROPIC_API_KEY }
        : {}),
      // The API-key route (src/engine/keyroute.ts); nothing on the login route.
      ...apiKeyEnv(),
    };
    // No GitHub credential reaches a process whose model runs bash.
    for (const k of GITHUB_TOKEN_ENVS) delete env[k];
    // The engine lens route (wave.ts EngineRoute): the planned wave is what
    // `planLaunch` reads from this run's `tasks/` (pass-validate excluded), the
    // same plan `lens_wave` resolves its dirs to. Nothing is started yet.
    const startWarnings: string[] = [];
    let waveUnits: LaunchUnit[] = [];
    if (route?.plannedWave && rendered.taskFiles.length) {
      const plan = planLaunch({ dirs: [join(outDir, "tasks")] }, env);
      if (plan.ok) waveUnits = plan.units;
      else startWarnings.push(`engine wave not planned: ${plan.error}`.slice(0, 300));
    }
    const prompts: OneShotPrompts = route
      ? {
          ...rendered,
          order: `${rendered.order}\n\n${engineLensSection(
            join(outDir, "tasks"),
            waveUnits.length
              ? { dir: dirname(waveUnits[0]!.path), agents: waveUnits.map((u) => u.agent) }
              : null,
          )}`,
        }
      : rendered;
    writeFileSync(join(outDir, "round-order.md"), prompts.order);
    // What `qcr open` needs to start pi on this run's sessions again (D10).
    writeOpenMeta(outDir, {
      version: 1,
      sessionName,
      cwd: i.cwd ?? root,
      model: cfg.models.conversation,
      env: openEnvOf(env),
    });
    const sessionDir = join(outDir, MAIN_SESSION_DIR);
    // This attempt's session only: an earlier attempt's JSONL left here would
    // make `resumable` true and `--continue` would resume THAT conversation.
    rmSync(sessionDir, { recursive: true, force: true });
    // …and its lens sessions: `qcr open --lens` lists what THIS attempt ran.
    rmSync(join(outDir, LENS_SESSIONS_DIR), { recursive: true, force: true });
    return {
      prompts,
      sysPath,
      env,
      sessionName,
      sessionDir,
      events: join(outDir, PI_RUN_FILES[0]),
      stderr: join(outDir, PI_RUN_FILES[1]),
      waveUnits,
      startWarnings,
      tmpDir,
      ownTmp,
    };
  } catch (err) {
    if (ownTmp) rmSync(tmpDir, { recursive: true, force: true });
    throw err;
  }
}

/** Run one review round on `runtime`. A round that fails is a returned outcome
 * (`error`, absent `outcome`), never a throw; only an unwritable output dir, a
 * login that cannot cover the run (`auth`), or a runtime that cannot create the
 * session (`runtime.create` rejects) throws.
 *
 * A runtime that hosts the engine's lens tools (`runtime.engineLens`, wave.ts)
 * makes this an engine lens route: the order gains the engine-only section
 * (prompts.ts engineLensSection), and with `plannedWave` the round starts the
 * planned discovery wave itself, from the round's `tasks/` (never pass-validate),
 * after the main session exists and before its first prompt; the session joins it
 * through `lens_wave` (rule 9). Everything else stays the session's. */
export async function runRound(i: RoundSpec, runtime: Runtime): Promise<RoundResult> {
  const log = i.log ?? (() => {});
  const label = i.label ?? `${i.target.repo}#${i.target.number}`;
  const started = i.startedAt ?? Date.now();
  const { cfg, outDir, root } = i;
  const route = (runtime as EngineRouteRuntime).engineLens;
  const prep = prepareRound(i, route);
  const { env, prompts, sysPath, sessionName, sessionDir, events, stderr, waveUnits } = prep;
  let session: RuntimeSession | undefined;
  let sink: LiveSink | undefined;
  let unhear: (() => void) | undefined;
  let endWave: () => Promise<void> = async () => {};
  const stopTurn = (): void => void session?.abort();
  try {
    i.signal?.throwIfAborted();
    // Host isolation: pi discovers nothing of its own. `-ne` leaves only the
    // extensions named below (so neither ~/.pi/agent, nor a project's `.pi/`,
    // nor a package can add one to the session) and `-ns` no skill; lens
    // passes get bash-guard from the lens tool's factory, not a global setting.
    // `-nc` is deliberately absent: the cwd's context file is the reviewer stub.
    log(`review: ${label} — ${i.files.length} files, lenses ${prompts.plannedLenses.join(" ")}`);
    const cwd = i.cwd ?? root;
    session = await runtime.create({
      cwd,
      env,
      model: cfg.models.conversation,
      systemPromptFile: sysPath,
      // The extension list is the whole list: the session discovers none.
      extensions: [
        join(root, "extensions", "cli", "bash-guard.ts"),
        join(root, "extensions", "cli", "ledger-pin.ts"),
        // The live PR session's `cluster_findings` tool (src/sessions.ts
        // extensionPaths): the same grouping code on both routes.
        join(root, "extensions", "finding-clusters.ts"),
      ],
      name: sessionName,
      sessionDir,
      eventsFile: events,
      stderrFile: stderr,
      limits: { timeoutMs: i.timeoutMs, ...(i.capUsd !== undefined ? { capUsd: i.capUsd } : {}) },
      cliFlags: ["--approve", "-ne", "-ns"],
    });
    i.signal?.throwIfAborted();
    i.signal?.addEventListener("abort", stopTurn, { once: true });
    // The live log hears every event, the `*_update`s too, from the first
    // prompt on; a log that cannot be opened never costs the review.
    if (i.live) {
      try {
        const heard = openRoundSink(
          i.live,
          { pr: i.target.number, session: sessionName },
          env,
          (m) => log(`review: ${label} — ${m}`),
        );
        sink = heard;
        unhear = session.subscribe((event) => heard.feed(event), { updates: true });
      } catch (err) {
        log(`review: ${label} — live log not started: ${String(err).slice(0, 200)}`);
      }
    }
    // The engine starts the planned wave before the main session's first turn,
    // so the lenses are in flight while it reads. The runner paces the sessions
    // (its cap, its cache groups and its creation stagger, cpu-gate finding 4).
    if (route) {
      route.wave.clear();
      if (waveUnits.length) {
        const stop = new AbortController();
        const rows: WaveRow[] = launchWave(route.wave, route.runner, waveUnits, stop.signal);
        log(`review: ${label} — engine wave: ${rows.length} lenses started`);
        // Ends what the session did not join, and waits for the rows to write
        // their ledger lines (the round's price counts them).
        endWave = async () => {
          stop.abort();
          let timer: NodeJS.Timeout | undefined;
          await Promise.race([
            Promise.allSettled(rows.map((row) => row.done)),
            new Promise((resolve) => (timer = setTimeout(resolve, WAVE_SETTLE_MS))),
          ]);
          clearTimeout(timer);
          endWave = async () => {};
        };
      }
    }
    let r = await session.prompt(prompts.order);
    const result: RoundResult = {
      prompts,
      plannedLenses: prompts.plannedLenses,
      piRun: r,
      continued: false,
      capped: r.capped === true,
      warnings: [],
      costUsd: null,
      review: null,
    };
    const outcomePath = join(outDir, CASE_FILES.outcome);
    // One continuation, never more: the live system's answer to a round that
    // stopped short is redelivery, not a fresh review. Same session — a
    // `--continue` respawn on the process runtime, a second turn on the live
    // session on the SDK runtime — and only if there IS one: pi persists a
    // session after its first assistant message, and `--continue` on an empty
    // session dir silently starts a NEW session that would review with no
    // round order at all.
    // A round whose files are there but do not parse stopped short too (a
    // model that broke its own JSON escaping): the same one continuation,
    // told which file and what the parser said. So did one that wrote its
    // outcome (the file written last) without a file the scorer reads.
    const broken = existsSync(outcomePath)
      ? unparseableOutputs(outDir, cfg.review.render_outputs)
      : [];
    const missing = existsSync(outcomePath)
      ? missingOutputs(outDir, cfg.review.render_outputs)
      : [];
    const resumable =
      (existsSync(sessionDir) && readdirSync(sessionDir).some((f) => f.endsWith(".jsonl"))) ||
      session.sessionFile !== null;
    if (!r.timedOut && !r.streamError && !existsSync(outcomePath) && !resumable) {
      result.error = `pi exited ${String(r.code)} before any assistant message — nothing to continue`;
    }
    const stoppedShort = !existsSync(outcomePath) || broken.length > 0 || missing.length > 0;
    if (
      !r.timedOut &&
      !r.streamError &&
      !result.capped &&
      stoppedShort &&
      resumable &&
      !i.signal?.aborted
    ) {
      const left = i.timeoutMs - (Date.now() - started);
      if (left > 120_000) {
        result.continued = true;
        log(
          broken.length
            ? `review: ${label} — ${broken.join("; ")}, one continuation`
            : missing.length
              ? `review: ${label} — ${missing.join(", ")} not written, one continuation`
              : `review: ${label} — no outcome.json yet, one continuation`,
        );
        const delivery = await session.followUp(
          broken.length
            ? `Your BENCHMARK MODE files in ${outDir} cannot be read: ${broken.join("; ")}. Rewrite ${broken.length > 1 ? "them" : "it"} as valid JSON with the same content — plain double quotes, no escaped quotes around keys or values — and write ${CASE_FILES.outcome} last.`
            : cfg.review.render_outputs
              ? `You stopped before the BENCHMARK MODE files were complete. Finish the round now and write ${CASE_FILES.findings} (with the posting fields) and, last, ${CASE_FILES.outcome} in ${outDir}.`
              : `You stopped before the BENCHMARK MODE files were complete. Finish the round now and write ${CASE_FILES.comments}, ${CASE_FILES.review}, ${CASE_FILES.findings} and, last, ${CASE_FILES.outcome} in ${outDir}.`,
          {
            timeoutMs: left,
            // What is left of the round's cap is what the session's stats say
            // it has spent, whichever runtime metered it.
            ...(i.capUsd !== undefined
              ? { capUsd: Math.max(0, i.capUsd - session.stats().spentUsd) }
              : {}),
          },
        );
        // The session is idle after its first turn, so the follow-up ran now.
        if (delivery.status !== "handled")
          throw new Error(`the continuation was not run: ${delivery.status}`);
        r = delivery.result;
        result.piRun = r;
        result.capped = r.capped === true;
      }
    }
    // The turns are over: a wave row nobody joined is not wanted any more.
    await endWave();
    return settleRound(i, prep, result, r, session.stats().spentUsd);
  } finally {
    i.signal?.removeEventListener("abort", stopTurn);
    unhear?.();
    sink?.close();
    await endWave();
    await session?.dispose();
    if (prep.ownTmp) rmSync(prep.tmpDir, { recursive: true, force: true });
  }
}

/** Read what a finished round left in `outDir`: warnings from pi's stderr, the
 * refused login, usage and stages, the price, and the outcome, findings and
 * rendered review. `r` is the last turn; `metered` is what the session's budget
 * counted, the price when the stream cannot be priced. */
export function settleRound(
  i: RoundSpec,
  prep: Pick<PreparedRound, "events" | "stderr" | "startWarnings">,
  result: RoundResult,
  r: PiRun,
  metered: number,
): RoundResult {
  const { cfg, outDir } = i;
  const { events, stderr, startWarnings } = prep;
  const outcomePath = join(outDir, CASE_FILES.outcome);
  const stderrLines = readFileSync(stderr, "utf8").split("\n");
  result.warnings = [
    ...startWarnings,
    ...new Set(
      stderrLines
        .filter((l) => /warn|error|fatal|failed/i.test(l))
        .map((l) => l.trim().slice(0, 300)),
    ),
  ].slice(0, 20);
  if (r.streamError) result.error = `output stream failed: ${r.streamError}`;
  // A provider that refused the login says so in pi's own output: a line of
  // stderr, or a failed assistant message in the event stream (a record
  // field, never text a tool printed: authwatch's rule). The typed error is
  // what authwatch and a route's exit status branch on.
  const refused = authRefusal(stderrLines, events, r.streamError);
  if (refused) result.authError = refused;
  // Usage is telemetry: a failure to read it must never cost the review.
  try {
    const lines = readFileSync(events, "utf8").split("\n");
    result.usage = usageFromEvents(lines);
    result.modelErrors = modelErrorsFromEvents(lines);
    // Per-stage cost and time (stages.json; the per-phase totals ride along).
    const stages = stagesFromEvents(lines);
    writeFileSync(join(outDir, "stages.json"), JSON.stringify(stages, null, 2) + "\n");
    result.stages = stages.phases;
    // pi's own stderr reports what never reached a message (a refused
    // connection, a 429 before the first token).
    for (const w of result.warnings) {
      const kind = modelErrorKind(w);
      if (kind === "usage_limit")
        result.modelErrors.usage_limit = (result.modelErrors.usage_limit ?? 0) + 1;
      else if (kind === "rate_limited") result.modelErrors.rate_limited++;
      else if (kind === "overloaded") result.modelErrors.overloaded++;
    }
  } catch (err) {
    result.warnings.push(`usage unreadable: ${String(err).slice(0, 200)}`);
  }
  // The price of the whole round, lens children included: the case dir's
  // event stream and lens ledger priced as the bench prices them. A stream
  // that cannot be priced falls back to what the session's budget metered
  // (zero when no cap was set, so unpriced).
  try {
    result.costUsd = caseCostUsd(outDir)?.usd ?? (metered > 0 ? metered : null);
  } catch {
    result.costUsd = metered > 0 ? metered : null;
  }
  const outcome = readJson(outcomePath) as Record<string, unknown> | undefined;
  if (outcome !== undefined) result.outcome = outcome;
  else if (result.authError && result.error === undefined)
    result.error = `the provider refused the login: ${result.authError.message.slice(0, 200)}`;
  // `[review] render_outputs`: comments.json and review.md rendered from the
  // findings record, as production's render-review.sh renders them. A
  // session that wrote its own files anyway is overruled: the record is the
  // source.
  if (cfg.review.render_outputs) {
    const record = readJson(join(outDir, CASE_FILES.findings));
    if (record !== undefined) {
      const out = renderBenchOutputs(record, outcome, cfg);
      writeFileSync(
        join(outDir, CASE_FILES.comments),
        JSON.stringify(out.rendered.comments, null, 2) + "\n",
      );
      writeFileSync(join(outDir, CASE_FILES.review), out.rendered.body);
      // The duplicate-merge post-check's and the posting policy's
      // dispositions, kept in the record (the session's own beside it).
      if (out.record !== record) {
        writeFileSync(join(outDir, POLICED_ORIGINALS[2]), JSON.stringify(record, null, 2) + "\n");
        writeFileSync(
          join(outDir, CASE_FILES.findings),
          JSON.stringify(out.record, null, 2) + "\n",
        );
      }
      // The `[posting]` cut ran inside the render step, as on the live
      // route — so a caller must not cut a second time.
      if (!isDefaultPosting(cfg.posting)) {
        result.renderedPosting = {
          kept: out.rendered.comments.length + out.rendered.in_body,
          withheld: out.withheld.map((w) => ({
            path: w.path ?? "",
            line: w.line ?? 0,
            source: w.inline ? ("inline" as const) : ("body" as const),
            cls: w.cls,
            severity: w.severity,
            word: w.word,
            title: w.title,
          })),
          body: cfg.posting!.body,
        };
        writeFileSync(
          join(outDir, POLICED_ORIGINALS[3]),
          JSON.stringify(result.renderedPosting, null, 2) + "\n",
        );
      }
      if (out.rendered.problems.length)
        result.warnings.push(
          ...out.rendered.problems.slice(0, 10).map((p) => `render: ${p}`.slice(0, 300)),
        );
    }
  }
  const findings = readJson(join(outDir, CASE_FILES.findings));
  if (findings !== undefined) result.findings = findings;
  const comments = readJson(join(outDir, CASE_FILES.comments));
  if (Array.isArray(comments)) result.comments = comments;
  const reviewPath = join(outDir, CASE_FILES.review);
  if (existsSync(reviewPath)) result.review = readFileSync(reviewPath, "utf8");
  return result;
}
