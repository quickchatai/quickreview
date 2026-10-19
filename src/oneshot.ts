// The one-shot review: one `pi -p --mode json` main session with the
// production round order on stdin, the lens fan-out inside that process, the
// outputs rendered through the production review renderer, and one
// `--continue` when the outputs are missing or unreadable.
//
// Shared by the benchmark (src/bench/runner.ts reviewCase) and `qcr review`.
// It takes a prepared tree, its file list, a target description and an output
// directory; it knows nothing of bench cases, stores or prefetching. No
// daemon, tmux, inject bridge or memory: a process that exits when the round
// settles (CLAUDE.md rule 8's boundary: no GitHub credential reaches it).
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { delimiter, dirname, join } from "node:path";
import { DEFAULT_SUBAGENT_CACHE_STAGGER_MS, type Config } from "./config.js";
import type { Ecosystem } from "./ecosystem.js";
import type { PrFileEntry } from "./github.js";
import { CONTEXT_PACK_FILE } from "./contextpack.js";
import type { RoundMemory } from "./memory/context.js";
import { isDefaultPosting } from "./postingpolicy.js";
import {
  CASE_FILES,
  modelErrorKind,
  modelErrorsFromEvents,
  stagesFromEvents,
  usageFromEvents,
  type ModelErrors,
  type Stages,
} from "./bench/aacr.js";
import { caseCostUsd } from "./bench/cost.js";
import type { Runtime, RuntimeSession } from "./engine/port.js";
import { procRuntime, type PiRun } from "./engine/procruntime.js";
import { GIT_ISOLATION_ENV } from "./bench/exec.js";
import { POLICED_ORIGINALS, type BenchPostingReport } from "./bench/benchposting.js";
import { apiKeyEnv } from "./bench/auth.js";
import { GITHUB_TOKEN_ENVS } from "./envstrip.js";
import { renderOneShotPrompts, type OneShotPrompts, type OneShotTarget } from "./engine/prompts.js";
import { renderBenchOutputs } from "./engine/render.js";

// The pi child process moved to the process runtime; its callers still import
// these from here.
export { haltPi, killPiGroups, onLfLines, runPi } from "./engine/procruntime.js";
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

export interface OneShotInput {
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
  cfg: Config;
  ecosystem: Ecosystem;
  timeoutMs: number;
  piBin?: string;
  /** Hosts the pi session. Omitted: a process runtime over `piBin`. */
  runtime?: Runtime;
  /** pi's spill dir. Omitted: `<outDir>/tmp`, removed when the run ends. A
   * given dir is the caller's to create and remove. */
  tmpDir?: string;
  /** Prompts rendered by the caller (a bench follow-up). Omitted: the first
   * round's, rendered here. */
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
  log?: (line: string) => void;
}

export interface OneShotResult {
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

/** Run the review. A round that fails is a returned outcome (`error`, absent
 * `outcome`), never a throw; only an unwritable output dir throws. */
export async function runOneShot(i: OneShotInput): Promise<OneShotResult> {
  const log = i.log ?? (() => {});
  const label = i.label ?? `${i.target.repo}#${i.target.number}`;
  const started = i.startedAt ?? Date.now();
  const { cfg, outDir, tree, root } = i;
  const ownTmp = i.tmpDir === undefined;
  const tmpDir = i.tmpDir ?? join(outDir, "tmp");
  mkdirSync(outDir, { recursive: true });
  // What an earlier attempt wrote here is not this attempt's review.
  for (const f of [...Object.values(CASE_FILES), ...POLICED_ORIGINALS, ...PI_RUN_FILES])
    rmSync(join(outDir, f), { force: true });
  rmSync(tmpDir, { recursive: true, force: true });
  mkdirSync(tmpDir, { recursive: true });
  let session: RuntimeSession | undefined;
  try {
    const prompts =
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
    for (const f of prompts.extraFiles ?? []) {
      mkdirSync(dirname(f.path), { recursive: true });
      writeFileSync(f.path, f.text);
    }
    if (prompts.contextPack) writeFileSync(prompts.contextPack.path, prompts.contextPack.text);
    if (prompts.taskFiles.length) {
      mkdirSync(join(outDir, "tasks"), { recursive: true });
      for (const t of prompts.taskFiles) writeFileSync(t.path, t.text);
    }
    const sysPath = join(outDir, "system-prompt.md");
    writeFileSync(sysPath, prompts.system);
    writeFileSync(join(outDir, "round-order.md"), prompts.order);
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
      QCR_SUBAGENT_MAX_CONCURRENCY: String(cfg.pi.subagent_max_concurrency),
      QCR_SUBAGENT_WIDE_FANOUT: cfg.review?.wide_lens_fanout === false ? "0" : "1",
      QCR_SUBAGENT_CACHE_GROUP: String(cfg.pi.subagent_cache_group ?? 0),
      QCR_SUBAGENT_CACHE_STAGGER_MS: String(
        cfg.pi.subagent_cache_stagger_ms ?? DEFAULT_SUBAGENT_CACHE_STAGGER_MS,
      ),
      QCR_LEAF_CACHE_EXT: join(root, "extensions", "leaf-cache.ts"),
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
      // The API-key route (src/bench/auth.ts); nothing on the login route.
      ...apiKeyEnv(),
    };
    // No GitHub credential reaches a process whose model runs bash.
    for (const k of GITHUB_TOKEN_ENVS) delete env[k];
    const sessionDir = join(outDir, "session");
    // This attempt's session only: an earlier attempt's JSONL left here would
    // make `resumable` true and `--continue` would resume THAT conversation.
    rmSync(sessionDir, { recursive: true, force: true });
    // Host isolation: pi discovers nothing of its own. `-ne` leaves only the
    // extensions named below (so neither ~/.pi/agent, nor a project's `.pi/`,
    // nor a package can add one to the session) and `-ns` no skill; lens
    // children, which load only the agent dir's GLOBAL settings, get bash-guard
    // from there (the bench's and the host route's settings both register it).
    // `-nc` is deliberately absent: the cwd's context file is the reviewer stub.
    const piBin = i.piBin ?? "pi";
    const events = join(outDir, PI_RUN_FILES[0]);
    const stderr = join(outDir, PI_RUN_FILES[1]);
    log(`review: ${label} — ${i.files.length} files, lenses ${prompts.plannedLenses.join(" ")}`);
    const cwd = i.cwd ?? root;
    session = await (i.runtime ?? procRuntime({ bin: piBin })).create({
      cwd,
      env,
      model: cfg.models.conversation,
      systemPromptFile: sysPath,
      // The extension list is the whole list: the session discovers none.
      extensions: [
        join(root, "extensions", "bash-guard.ts"),
        join(root, "extensions", "ledger-pin.ts"),
        join(root, "extensions", "subagents.ts"),
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
    let r = await session.prompt(prompts.order);
    const result: OneShotResult = {
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
    // stopped short is redelivery, not a fresh review. Same session —
    // and only if there IS one: pi persists a session after its first
    // assistant message, and `--continue` on an empty session dir silently
    // starts a NEW session that would review with no round order at all.
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
      existsSync(sessionDir) && readdirSync(sessionDir).some((f) => f.endsWith(".jsonl"));
    if (!r.timedOut && !r.streamError && !existsSync(outcomePath) && !resumable) {
      result.error = `pi exited ${String(r.code)} before any assistant message — nothing to continue`;
    }
    const stoppedShort = !existsSync(outcomePath) || broken.length > 0 || missing.length > 0;
    if (!r.timedOut && !r.streamError && !result.capped && stoppedShort && resumable) {
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
            ...(i.capUsd !== undefined
              ? { capUsd: Math.max(0, i.capUsd - (r.spentUsd ?? 0)) }
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
    result.warnings = [
      ...new Set(
        readFileSync(stderr, "utf8")
          .split("\n")
          .filter((l) => /warn|error|fatal|failed/i.test(l))
          .map((l) => l.trim().slice(0, 300)),
      ),
    ].slice(0, 20);
    if (r.streamError) result.error = `output stream failed: ${r.streamError}`;
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
    try {
      result.costUsd = caseCostUsd(outDir)?.usd ?? null;
    } catch {
      result.costUsd = null;
    }
    const outcome = readJson(outcomePath) as Record<string, unknown> | undefined;
    if (outcome !== undefined) result.outcome = outcome;
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
  } finally {
    await session?.dispose();
    if (ownTmp) rmSync(tmpDir, { recursive: true, force: true });
  }
}
