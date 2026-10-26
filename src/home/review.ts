// A review the home runs, as the details area draws it (FT-0665's progress
// model): the plan the preview quoted, then what `qcr review status` says
// as the detached run goes, then its findings and its real cost. Pure: the
// model (src/home/model.ts) folds each status into a Run, the panel draws it.
//
//   plan      previewed and started; no lens has reported yet
//   lenses    the lenses run (each waiting, running, done or failed)
//   validate  the validator checks every finding against the code
//   write     the write-up, once the validator is done
//   done      the result is in: time, cost, one line per finding
//   failed    failed or stopped, with why; the PR is reviewable again
//
// A lens's name is its agent name without the `pass-` prefix and the tier
// suffix (the core's `lensShortName`). Severity maps P0 and P1 to high, P2
// to medium, and anything else to low.
import { lensShortName } from "@quickchatai/pi-quickreview/src/live/lensline.js";
import type { PrReview, ReviewFinding, ReviewQuote, ReviewRunStatus } from "./ports.js";

export type Severity = "high" | "medium" | "low";

export interface Lens {
  name: string;
  state: "wait" | "run" | "done" | "failed";
  findings: number;
  tools: number;
  tool?: string;
  /** When it started running, ms since the epoch. */
  since?: number;
  /** What it is doing now, as one line (the live log's own line). */
  line?: string;
}

export interface Run {
  pr: number;
  stage: "plan" | "lenses" | "validate" | "write" | "done" | "failed";
  lenses: Lens[];
  started: number;
  ended?: number;
  /** The quoted estimate and hard stop; null when this home did not see the
   * quote (a run re-attached after a restart). */
  est: number | null;
  cap: number | null;
  /** What it cost: null until the result says. */
  spent: number | null;
  /** Files in the plan, from the quote. */
  files?: number;
  runId?: string;
  /** What the round is doing, when no lens is running. */
  now?: string;
  error?: string;
  report?: string;
  findings: { sev: Severity; where: string; text: string }[];
  /** The findings as the result gave them, for the chat message. */
  raw?: readonly ReviewFinding[];
  /** The finished review kept for a post. */
  postFile?: string;
}

export const sevOf = (severity: string): Severity =>
  /^P[01]$/i.test(severity.trim()) ? "high" : /^P2$/i.test(severity.trim()) ? "medium" : "low";

export const lensName = (agent: string): string => lensShortName(agent);

const isValidator = (agent: string): boolean => lensName(agent).startsWith("validate");

/** Where a finding is: path:line, or the whole change. */
export function whereOf(f: Pick<ReviewFinding, "path" | "line">): string {
  return f.path ? `${f.path}${f.line ? `:${f.line}` : ""}` : "(whole change)";
}

/** A path's last two parts: enough to know the file in a narrow column. */
export function shortWhere(where: string): string {
  return where.startsWith("(") ? where : where.split("/").slice(-2).join("/");
}

/** A run that has its quote and is about to start. */
export function plannedRun(pr: number, now: number): Run {
  return {
    pr,
    stage: "plan",
    lenses: [],
    started: now,
    est: null,
    cap: null,
    spent: null,
    now: "pricing the review",
    findings: [],
  };
}

/** The quote's plan on the run: the lenses (the validator aside), the price. */
export function quoteRun(run: Run, q: ReviewQuote): void {
  run.est = q.estimateUsd;
  run.cap = q.capUsd;
  run.files = q.files;
  run.lenses = q.lenses
    .filter((l) => !isValidator(l))
    .map((l) => ({ name: lensName(l), state: "wait", findings: 0, tools: 0 }));
}

/** A run the home finds already going (or over) when it opens. */
export function attachedRun(s: ReviewRunStatus): Run {
  return {
    pr: s.pr ?? 0,
    stage: "plan",
    lenses: [],
    started: s.startedAt,
    est: null,
    cap: null,
    spent: null,
    runId: s.runId,
    ...(s.report !== undefined ? { report: s.report } : {}),
    findings: [],
  };
}

const LENS_STATE: Record<string, Lens["state"]> = {
  running: "run",
  completed: "done",
  failed: "failed",
};

/** Fold one status into the run. Returns true once the run is over. */
export function foldStatus(run: Run, s: ReviewRunStatus, now: number): boolean {
  if (s.live) {
    run.now = s.live.lastActivity;
    for (const a of s.live.lenses) {
      if (isValidator(a.agent)) {
        if (a.status === "running") run.stage = "validate";
        else if (a.status === "completed" || a.status === "failed") run.stage = "write";
        continue;
      }
      const name = lensName(a.agent);
      let lens = run.lenses.find((l) => l.name === name);
      if (!lens) run.lenses.push((lens = { name, state: "wait", findings: 0, tools: 0 }));
      lens.state = LENS_STATE[a.status] ?? "wait";
      lens.tools = a.toolCount;
      lens.line = a.line;
      if (a.currentTool !== undefined) lens.tool = a.currentTool;
      else delete lens.tool;
      if (lens.state === "run") lens.since ??= now - Math.max(0, a.durationMs);
      if (run.stage === "plan") run.stage = "lenses";
    }
  }
  if (s.state === "running") return false;
  run.ended = s.endedAt ?? now;
  if (s.state !== "done") {
    run.stage = "failed";
    run.error =
      s.errors.length > 0
        ? s.errors.join("; ")
        : s.state === "stopped"
          ? "it was stopped"
          : "it ended without a result";
    return true;
  }
  const all = s.result?.findings ?? [];
  run.findings = all.map((f) => ({ sev: sevOf(f.severity), where: whereOf(f), text: f.title }));
  run.raw = all;
  for (const l of run.lenses) l.findings = 0;
  for (const f of all) {
    const lens = f.lens ? run.lenses.find((l) => l.name === lensName(f.lens!)) : undefined;
    if (lens) lens.findings++;
  }
  for (const l of run.lenses) if (l.state === "run" || l.state === "wait") l.state = "done";
  run.spent = s.result?.costUsd ?? null;
  if (s.result?.postFile !== undefined) run.postFile = s.result.postFile;
  run.stage = "done";
  return true;
}

/** A finished run as the Reviewed list holds it. */
export function runReview(run: Run): PrReview {
  return {
    findings: run.findings.length,
    high: run.findings.filter((f) => f.sev === "high").length,
    by: "you",
    at: run.ended ?? run.started,
    list: run.raw ?? [],
    tookMs: (run.ended ?? run.started) - run.started,
    costUsd: run.spent,
    ...(run.report !== undefined ? { report: run.report } : {}),
  };
}

/** A finished review's findings as the chat message ⏎ sends. */
export function reviewMessage(o: { pr: number; title: string; review: PrReview }): string {
  const r = o.review;
  const who = r.by === "auto" ? "auto-review" : "you";
  if (r.list === undefined) {
    const n = r.findings === null ? "its findings are on the pull request" : plural(r.findings);
    return `**#${o.pr} ${o.title}** — reviewed by ${who}; ${n}.`;
  }
  if (r.list.length === 0) return `**#${o.pr} ${o.title}** — reviewed by ${who}, no findings.`;
  const high = r.list.filter((f) => sevOf(f.severity) === "high").length;
  return [
    `**#${o.pr} ${o.title}** — reviewed by ${who}: ${plural(r.list.length)}${high ? `, ${high} high` : ""}`,
    "",
    ...r.list.map(
      (f, i) =>
        `${i + 1}. **${sevOf(f.severity)}** \`${whereOf(f)}\` — ${f.title}${f.lens ? ` _(${lensName(f.lens)})_` : ""}`,
    ),
    ...(r.report ? ["", `Full report: \`${r.report}\``] : []),
  ].join("\n");
}

const plural = (n: number): string => `${n} finding${n === 1 ? "" : "s"}`;
