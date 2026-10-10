// The PR replay's RUN: preview, start, status, stop — the stateful
// half behind the companion's `setup_replay_*` tools. The rules are
// replay.ts's, the sides replaybuild.ts's, the PR's code replaysource.ts's;
// every effect goes through a port.
//
// Three promises, each structural:
//   * THE COST IS STATED FIRST. `preview` is free: it reads the PRs, resolves
//     and builds both sides, plans each side's review of each PR exactly as a
//     round would (`buildPassPlan`), and prices every case. It stores what it
//     showed under a key; `start` re-plans from the stored request and is
//     refused unless the key still matches — so what runs is what the
//     operator saw priced, and a profile, PR or price that moved since sends
//     the operator back to a preview.
//   * HARD STOP. The run's cap is `REPLAY_CAP_FACTOR` × the estimate, stated
//     beside it. A case starts only while what is spent plus what is in
//     flight fits; the moment spending reaches the cap — read live from the
//     runner's running cost — everything in flight is aborted and the run
//     ends `capped`. A failed case counts what it spent (its estimate when
//     the runner cannot say), never nothing.
//   * THE COMPANION STAYS RESPONSIVE. `start` records the run and returns;
//     the cases run in the background as pi subagents (the case runner), at
//     most `concurrency` at once, and `status` reads progress — and, once the
//     cases are in, the two reviews side by side. A background failure is
//     recorded on the run, never thrown.
//
// The order: every lens case first (one per plan row; a case byte-identical
// on both sides runs once), then each side's validator over that side's
// candidates for the PR — once for both when both sides planned the same
// cases and the same validator, since its input is then the same too.
//
// Persistence: `<state home>/setup/replay.json` — the last preview (its key
// and request), the current run, and the rates measured from finished cases
// (what later previews price with).
import { buildPassPlan } from "../dispatch.js";
import { VALIDATE_PASS } from "../include.js";
import { findStyleGuide } from "../styleguide.js";
import { findCiLinters } from "../lintconfig.js";
import type { PassTier } from "../types.js";
import type { CaseOutcome, CaseRunner, Refusal, StateFs } from "./engine.js";
import {
  bySeverity,
  caseEstimate,
  caseKey,
  compareFindings,
  linesRead,
  MAX_REPLAY_PRS,
  measuredRates,
  modelOf,
  rateFor,
  REPLAY_CAP_FACTOR,
  REPLAY_FILE,
  REPLAY_VERSION,
  replayLensPrompt,
  replayReads,
  replayValidatorPrompt,
  SIDES,
  type ComparedPair,
  type ReplayFinding,
  type ReplayPr,
  type ReplayRate,
  type ReplayTree,
  type SideName,
} from "./replay.js";
import type { ReplaySide, SideRequest } from "./replaybuild.js";
import type { ReplaySource } from "./replaysource.js";
import { parseScanAnswer, parseValidatorAnswer, type ScanCandidate } from "./scan.js";

// ---- ports ---------------------------------------------------------------------

export interface ReplayPorts {
  state: StateFs;
  clock: () => Date;
  source: ReplaySource;
  /** Resolve and build both sides (replaybuild.ts `replaySides`). */
  sides: (req: SideRequest) => { ok: true; sides: Record<SideName, ReplaySide> } | Refusal;
  /** The case runner over the agents built into `agentsDir`. */
  cases: (agentsDir: string) => CaseRunner;
  /** The repo's written style guide references in a tree (the style lens's
   * trigger); `findStyleGuide` by default. */
  styleGuide?: (root: string) => string[];
  /** Cases in flight at once (the companion's subagent cap). */
  concurrency?: number;
  log?: (line: string) => void;
}

/** What a replay is asked for: the PRs and the two sides. */
export interface ReplayRequest extends SideRequest {
  prs: number[];
}

// ---- records -------------------------------------------------------------------

export type ReplayCaseStatus = "pending" | "running" | "done" | "failed" | "stopped" | "skipped";
export type ReplayRunState = "running" | "complete" | "partial" | "stopped" | "capped";

export interface ReplayPlanRow {
  lens: string;
  tier: PassTier;
  agent: string;
  /** The case that runs it (a lens row) or the validation (the validator row). */
  case: string;
  why?: string;
  focus?: string[];
}

export interface ReplayCaseState {
  id: string;
  pr: number;
  lens: string;
  tier: PassTier;
  agent: string;
  /** The sides that planned it — both when it is the same case on both. */
  sides: SideName[];
  /** The built agent's model spec (what a measured rate is keyed by). */
  model: string | null;
  lines: number;
  estimate_usd: number;
  rate_basis: string;
  status: ReplayCaseStatus;
  cost_usd: number | null;
  error: string | null;
  /** The lens's findings (null until it answered). */
  findings: ReplayFinding[] | null;
  /** Items it wrote without a path, a claim or a line (unanchored ones too). */
  dropped: number;
  none: boolean;
  started_at: string | null;
  finished_at: string | null;
  kind: "lens" | "validate";
  /** How many of its file reads opened the PR (inside its worktree, or its
   * diff file) and how many opened something else — a relative read resolves
   * against the app root, the wrong repository. Absent when the runner did
   * not report reads. */
  reads?: { pr: number; elsewhere: number };
  /** A validation's findings split: survivors kept, doubted kept and marked,
   * killed dropped. */
  kept?: number;
  doubted?: number;
  killed?: number;
}

export interface ReplayPrState {
  number: number;
  title: string;
  merged: boolean;
  state: string;
  /** The commit whose tree was read and what the diff was taken against. */
  sha: string;
  base: string;
  files: number;
  diff_lines: number;
  plans: Record<SideName, ReplayPlanRow[]>;
}

export interface ReplaySideView {
  profile: string;
  basis: string;
  baseline: string | null;
}

export interface ReplayRun {
  id: string;
  key: string;
  started_at: string;
  finished_at: string | null;
  state: ReplayRunState;
  estimate_usd: number;
  cap_usd: number;
  spent_usd: number;
  /** Cases the runner could not price, counted at their estimate. */
  unpriced_cases: number;
  sides: Record<SideName, ReplaySideView>;
  prs: ReplayPrState[];
  cases: ReplayCaseState[];
  problems: string[];
}

interface StoredPreview {
  key: string;
  at: string;
  request: ReplayRequest;
}

export interface ReplayFile {
  version: number;
  preview: StoredPreview | null;
  current: ReplayRun | null;
  rates: Record<string, ReplayRate>;
}

export interface ReplayPreview {
  key: string;
  request: ReplayRequest;
  sides: Record<SideName, ReplaySideView>;
  prs: ReplayPrState[];
  cases: Array<
    Pick<
      ReplayCaseState,
      "id" | "pr" | "lens" | "tier" | "sides" | "lines" | "estimate_usd" | "rate_basis" | "kind"
    >
  >;
  /** Cases planned on both sides and run once. */
  shared: number;
  estimate_usd: number;
  cap_usd: number;
  /** Every basis a price stands on (reference until a replay measured it). */
  rate_bases: string[];
  concurrency: number;
}

export interface ReplayStatus {
  ok: boolean;
  problems: string[];
  run: (ReplayRun & { display: ReplayRunState | "interrupted" }) | null;
  active: boolean;
}

/** One PR's two reviews, side by side. */
export interface ReplayComparison {
  pr: number;
  title: string;
  findings: Record<SideName, ReplayFinding[]>;
  /** Whether each side's review is whole (every case done). */
  complete: Record<SideName, boolean>;
  both: ComparedPair[];
  old_only: ReplayFinding[];
  new_only: ReplayFinding[];
  cost: Record<SideName, number | null> & { shared: number | null };
}

// ---- the plan ------------------------------------------------------------------

interface CaseJob {
  state: ReplayCaseState;
  agentsDir: string;
  prompt: (candidates: ReplayFinding[]) => string;
  /** For a validation: the lens cases whose findings it reads, per side. */
  reads?: string[];
  root: string;
  diffPath: string;
  /** What the preview's key covers of it: the built agent and its task. */
  fingerprint: string;
}

interface Planned {
  key: string;
  request: ReplayRequest;
  sides: Record<SideName, ReplaySide>;
  prs: ReplayPrState[];
  jobs: CaseJob[];
  estimate: number;
  bases: string[];
}

const EPS = 1e-9;
const clean = (err: unknown): string => (err instanceof Error ? err.message : String(err));
const usd = (n: number): number => Math.round(n * 10000) / 10000;

export function parseReplayRequest(raw: {
  prs?: unknown;
  old?: unknown;
  new_profile?: unknown;
}): { ok: true; request: ReplayRequest } | Refusal {
  const prs = Array.isArray(raw.prs) ? raw.prs : raw.prs === undefined ? [] : [raw.prs];
  const nums = prs.map((p) =>
    typeof p === "string" && /^\d+$/.test(p.trim()) ? Number(p.trim()) : p,
  );
  if (
    nums.length === 0 ||
    nums.length > MAX_REPLAY_PRS ||
    !nums.every((n) => typeof n === "number" && Number.isInteger(n) && n > 0)
  ) {
    return {
      ok: false,
      errors: [
        `\`prs\` must be one or two PR numbers (at most ${MAX_REPLAY_PRS}: a replay reviews each one twice)`,
      ],
    };
  }
  if (new Set(nums).size !== nums.length)
    return { ok: false, errors: ["`prs` names the same PR twice"] };
  const str = (v: unknown): string | null =>
    typeof v === "string" && v.trim() !== "" ? v.trim() : null;
  return {
    ok: true,
    request: { prs: nums as number[], old: str(raw.old), new_profile: str(raw.new_profile) },
  };
}

export class ReplayRunner {
  private active: { id: string; abort: AbortController; done: Promise<void> } | null = null;
  private readonly concurrency: number;

  constructor(private readonly ports: ReplayPorts) {
    this.concurrency = Math.max(1, Math.floor(ports.concurrency ?? 4));
  }

  // -- the file --

  private load(): { file: ReplayFile; error: string | null } {
    const empty: ReplayFile = { version: REPLAY_VERSION, preview: null, current: null, rates: {} };
    let text: string | null;
    try {
      text = this.ports.state.read(REPLAY_FILE);
    } catch (err) {
      return {
        file: empty,
        error: `${REPLAY_FILE} in ${this.ports.state.location} cannot be read: ${clean(err)}`,
      };
    }
    if (text === null) return { file: empty, error: null };
    try {
      const raw = JSON.parse(text) as Partial<ReplayFile> | null;
      if (typeof raw !== "object" || raw === null || raw.version !== REPLAY_VERSION) {
        throw new Error(`unknown version ${JSON.stringify(raw?.version)}`);
      }
      const current = raw.current ?? null;
      if (
        current !== null &&
        (typeof current !== "object" ||
          !Array.isArray(current.cases) ||
          !Array.isArray(current.prs))
      ) {
        throw new Error("`current` is not a replay run");
      }
      return {
        file: {
          version: REPLAY_VERSION,
          preview: raw.preview ?? null,
          current,
          rates: raw.rates ?? {},
        },
        error: null,
      };
    } catch (err) {
      return {
        file: empty,
        error: `${REPLAY_FILE} in ${this.ports.state.location} is not a replay record this version reads (${clean(err)}) — nothing will overwrite it; move it aside to replay again`,
      };
    }
  }

  private store(file: ReplayFile): void {
    this.ports.state.write(REPLAY_FILE, `${JSON.stringify(file, null, 1)}\n`);
  }

  // -- planning --

  /** Both sides' reviews of every PR, as cases, priced. Builds the sides. */
  private async plan(
    request: ReplayRequest,
    rates: Record<string, ReplayRate>,
  ): Promise<{ ok: true; planned: Planned } | Refusal> {
    const built = this.ports.sides(request);
    if (!built.ok) return built;
    const sides = built.sides;

    const pulls: ReplayPr[] = [];
    for (const n of request.prs) {
      const got = await this.ports.source.pr(n);
      if (!got.ok) return { ok: false, errors: [`PR #${n}: ${got.reason}`] };
      pulls.push(got.pr);
    }
    const trees: ReplayTree[] = [];
    for (const pr of pulls) {
      const keep = pulls
        .filter((p) => p !== pr)
        .flatMap((p) => [p.head_sha, ...(p.merge_commit_sha ? [p.merge_commit_sha] : [])]);
      const opened = this.ports.source.open(pr, keep);
      if (!opened.ok) return { ok: false, errors: [`PR #${pr.number}: ${opened.reason}`] };
      trees.push(opened.tree);
    }

    const jobs: CaseJob[] = [];
    const byKey = new Map<string, CaseJob>();
    const bases = new Set<string>();
    const prs: ReplayPrState[] = [];
    let n = 0;
    const errors: string[] = [];
    for (const [i, pr] of pulls.entries()) {
      const tree = trees[i]!;
      const guides = (this.ports.styleGuide ?? findStyleGuide)(tree.root);
      const allFiles = tree.files.filter((f) => f.status !== "removed").map((f) => f.filename);
      const state: ReplayPrState = {
        number: pr.number,
        title: pr.title,
        merged: pr.merged,
        state: pr.state,
        sha: tree.sha,
        base: tree.base,
        files: tree.files.length,
        diff_lines: tree.diffLines,
        plans: { old: [], new: [] },
      };
      // Which lens cases each side reads for this PR, and its validator row.
      const read: Record<SideName, string[]> = { old: [], new: [] };
      const validators: Partial<Record<SideName, { agent: string; tier: PassTier; text: string }>> =
        {};
      for (const side of SIDES) {
        const s = sides[side];
        const { pass_plan } = buildPassPlan(
          s.cfg,
          tree.files,
          { title: pr.title, body: pr.body },
          s.ecosystem,
          s.heuristics,
          guides,
          findCiLinters(tree.root),
        );
        for (const row of pass_plan) {
          const text = s.agentText(row.agent);
          if (text === null) {
            errors.push(`the ${side} side's build has no agent ${row.agent}`);
            continue;
          }
          if (row.lens === VALIDATE_PASS) {
            validators[side] = { agent: row.agent, tier: row.tier, text };
            continue;
          }
          const lensRow = {
            lens: row.lens,
            tier: row.tier,
            ...(row.why ? { why: row.why } : {}),
            ...(row.focus ? { focus: row.focus } : {}),
          };
          const prompt = replayLensPrompt(pr, tree, lensRow);
          const key = caseKey(text, prompt);
          let job = byKey.get(key);
          if (!job) {
            const model = modelOf(text);
            const rate = rateFor(model, row.tier, rates);
            const lines = linesRead(tree, row.focus ?? allFiles);
            bases.add(rate.basis);
            job = {
              state: {
                id: `c${++n}`,
                pr: pr.number,
                lens: row.lens,
                tier: row.tier,
                agent: row.agent,
                sides: [],
                model,
                lines,
                estimate_usd: usd(caseEstimate(lines, rate)),
                rate_basis: rate.basis,
                status: "pending",
                cost_usd: null,
                error: null,
                findings: null,
                dropped: 0,
                none: false,
                started_at: null,
                finished_at: null,
                kind: "lens",
              },
              agentsDir: s.agentsDir,
              prompt: () => prompt,
              root: tree.root,
              diffPath: tree.diffPath,
              fingerprint: key,
            };
            byKey.set(key, job);
            jobs.push(job);
          }
          if (!job.state.sides.includes(side)) job.state.sides.push(side);
          read[side].push(job.state.id);
          state.plans[side].push({
            agent: row.agent,
            lens: row.lens,
            tier: row.tier,
            case: job.state.id,
            ...(row.why ? { why: row.why } : {}),
            ...(row.focus ? { focus: row.focus } : {}),
          });
        }
      }
      // The validators: one per side that keeps one — or one for both when
      // both read the same cases through the same validator.
      const sameInput =
        validators.old !== undefined &&
        validators.new !== undefined &&
        validators.old.text === validators.new.text &&
        read.old.length === read.new.length &&
        read.old.every((id, j) => read.new[j] === id);
      for (const side of SIDES) {
        const v = validators[side];
        if (!v) continue;
        let job =
          sameInput && side === "new"
            ? jobs.find((j) => j.state.kind === "validate" && j.state.pr === pr.number)
            : undefined;
        if (!job) {
          const model = modelOf(v.text);
          const rate = rateFor(model, v.tier, rates);
          const lines = linesRead(tree, allFiles);
          bases.add(rate.basis);
          job = {
            state: {
              id: `v${++n}`,
              pr: pr.number,
              lens: VALIDATE_PASS,
              tier: v.tier,
              agent: v.agent,
              sides: [],
              model,
              lines,
              estimate_usd: usd(caseEstimate(lines, rate)),
              rate_basis: rate.basis,
              status: "pending",
              cost_usd: null,
              error: null,
              findings: null,
              dropped: 0,
              none: false,
              started_at: null,
              finished_at: null,
              kind: "validate",
            },
            agentsDir: sides[side].agentsDir,
            prompt: (candidates) => replayValidatorPrompt(pr, tree, VALIDATE_PASS, candidates),
            reads: read[side],
            root: tree.root,
            diffPath: tree.diffPath,
            fingerprint: caseKey(v.text, read[side].join(",")),
          };
          jobs.push(job);
        }
        job.state.sides.push(side);
        state.plans[side].push({
          agent: v.agent,
          lens: VALIDATE_PASS,
          tier: v.tier,
          case: job.state.id,
        });
      }
      prs.push(state);
    }
    if (errors.length > 0) return { ok: false, errors };
    const estimate = usd(jobs.reduce((t, j) => t + j.state.estimate_usd, 0));
    const key = planKeyOf({
      prs: prs.map((p) => [p.number, p.sha, p.base]),
      sides: SIDES.map((s) => [sides[s].profile, sides[s].basis]),
      jobs: jobs.map((j) => [
        j.state.id,
        j.state.agent,
        j.state.sides,
        j.state.estimate_usd,
        j.fingerprint,
      ]),
    });
    return { ok: true, planned: { key, request, sides, prs, jobs, estimate, bases: [...bases] } };
  }

  // -- the verbs --

  /** What the replay would run and cost now, and the key a start quotes.
   * Free: nothing runs. The preview is stored so a start can re-plan it. */
  async preview(raw: {
    prs?: unknown;
    old?: unknown;
    new_profile?: unknown;
  }): Promise<{ ok: true; preview: ReplayPreview } | Refusal> {
    if (this.active)
      return {
        ok: false,
        errors: [`replay ${this.active.id} is running — wait for it or stop it first`],
      };
    const req = parseReplayRequest(raw);
    if (!req.ok) return req;
    const { file, error } = this.load();
    if (error !== null) return { ok: false, errors: [error] };
    let p;
    try {
      p = await this.plan(req.request, file.rates);
    } catch (err) {
      return { ok: false, errors: [`the replay could not be planned: ${clean(err)}`] };
    }
    if (!p.ok) return p;
    const planned = p.planned;
    file.preview = {
      key: planned.key,
      at: this.ports.clock().toISOString(),
      request: planned.request,
    };
    try {
      this.store(file);
    } catch (err) {
      return {
        ok: false,
        errors: [`could not record the preview in ${this.ports.state.location}: ${clean(err)}`],
      };
    }
    return {
      ok: true,
      preview: {
        key: planned.key,
        request: planned.request,
        sides: sideViews(planned.sides),
        prs: planned.prs,
        cases: planned.jobs.map((j) => ({
          id: j.state.id,
          pr: j.state.pr,
          lens: j.state.lens,
          tier: j.state.tier,
          sides: j.state.sides,
          lines: j.state.lines,
          estimate_usd: j.state.estimate_usd,
          rate_basis: j.state.rate_basis,
          kind: j.state.kind,
        })),
        shared: planned.jobs.filter((j) => j.state.sides.length === 2).length,
        estimate_usd: planned.estimate,
        cap_usd: usd(planned.estimate * REPLAY_CAP_FACTOR),
        rate_bases: planned.bases,
        concurrency: this.concurrency,
      },
    };
  }

  /** Start the replay the last preview showed — its key, and nothing that
   * moved since. Returns as soon as the run is recorded. */
  async start(args: { key?: unknown }): Promise<{ ok: true; run: ReplayRun } | Refusal> {
    if (this.active)
      return {
        ok: false,
        errors: [`replay ${this.active.id} is still running — stop it or wait for it`],
      };
    if (typeof args.key !== "string" || args.key === "") {
      return {
        ok: false,
        errors: [
          "no preview key — preview the replay, tell the operator its cost, then start it with the preview's key",
        ],
      };
    }
    const { file, error } = this.load();
    if (error !== null) return { ok: false, errors: [error] };
    if (file.preview === null || file.preview.key !== args.key) {
      return {
        ok: false,
        errors: [
          `no stored preview has key ${args.key} — preview again and show the operator the cost`,
        ],
      };
    }
    let p;
    try {
      p = await this.plan(file.preview.request, file.rates);
    } catch (err) {
      return { ok: false, errors: [`the replay could not be planned: ${clean(err)}`] };
    }
    if (!p.ok) return p;
    const planned = p.planned;
    if (planned.key !== args.key) {
      return {
        ok: false,
        errors: [
          `the replay changed since that preview (key ${args.key}, now ${planned.key}: a profile, a PR or a price moved) — preview again and show the operator the new cost`,
        ],
      };
    }
    const now = this.ports.clock();
    const run: ReplayRun = {
      id: `replay-${now
        .toISOString()
        .replace(/[-:]/g, "")
        .replace(/\.\d+Z$/, "Z")}`,
      key: planned.key,
      started_at: now.toISOString(),
      finished_at: null,
      state: "running",
      estimate_usd: planned.estimate,
      cap_usd: usd(planned.estimate * REPLAY_CAP_FACTOR),
      spent_usd: 0,
      unpriced_cases: 0,
      sides: sideViews(planned.sides),
      prs: planned.prs,
      cases: planned.jobs.map((j) => j.state),
      problems: [],
    };
    file.current = run;
    try {
      this.store(file);
    } catch (err) {
      return {
        ok: false,
        errors: [
          `could not record the replay in ${this.ports.state.location}: ${clean(err)} — nothing started`,
        ],
      };
    }
    const abort = new AbortController();
    const done = this.drive(file, run, planned.jobs, abort)
      .catch((err: unknown) => {
        // One lane's failure rejects the whole drive while the other lanes'
        // cases are still running: abort them, or they would go on spending
        // past `settle` with no run left to count them against the cap.
        abort.abort();
        run.problems.push(`the replay stopped on an internal error: ${clean(err)}`);
        this.settle(file, run, "partial");
        this.ports.log?.(`setup: replay ${run.id} failed: ${clean(err)}`);
      })
      .finally(() => {
        if (this.active?.id === run.id) this.active = null;
      });
    this.active = { id: run.id, abort, done };
    return { ok: true, run };
  }

  /** The latest run (`interrupted` when no process here is driving it). */
  status(): ReplayStatus {
    const { file, error } = this.load();
    const run = file.current;
    return {
      ok: error === null,
      problems: error === null ? [] : [error],
      run:
        run === null
          ? null
          : {
              ...run,
              display:
                run.state === "running" && this.active?.id !== run.id ? "interrupted" : run.state,
            },
      active: this.active !== null,
    };
  }

  /** Stop the running replay: in-flight cases are aborted, pending ones never start. */
  stop(): { ok: true; id: string } | Refusal {
    if (!this.active) return { ok: false, errors: ["no replay is running in this companion"] };
    this.active.abort.abort();
    return { ok: true, id: this.active.id };
  }

  /** Resolves when no replay is running (tests; a clean shutdown). */
  async idle(): Promise<void> {
    await this.active?.done;
  }

  // -- the background run --

  private async drive(
    file: ReplayFile,
    run: ReplayRun,
    jobs: readonly CaseJob[],
    abort: AbortController,
  ): Promise<void> {
    const signal = abort.signal;
    let capHit = false;
    let reserved = 0;
    const live = new Map<string, number>();
    const liveTotal = (): number => [...live.values()].reduce((t, v) => t + v, 0);
    const onCost = (id: string, spentSoFar: number): void => {
      live.set(id, spentSoFar);
      if (!signal.aborted && run.spent_usd + liveTotal() >= run.cap_usd - EPS) {
        capHit = true;
        abort.abort();
      }
    };
    const within = (est: number): boolean => run.spent_usd + reserved + est <= run.cap_usd + EPS;
    const phase = async (list: readonly CaseJob[]): Promise<void> => {
      let next = 0;
      const lane = async (): Promise<void> => {
        while (next < list.length && !signal.aborted) {
          const job = list[next]!;
          const est = job.state.estimate_usd;
          if (!within(est)) {
            capHit = true;
            return;
          }
          next++;
          reserved += est;
          live.set(job.state.id, 0);
          const spent = await this.runCase(file, run, job, signal, (v) => onCost(job.state.id, v));
          live.delete(job.state.id);
          reserved -= est;
          run.spent_usd = usd(run.spent_usd + spent);
          this.store(file);
          if (
            run.spent_usd >= run.cap_usd - EPS &&
            !signal.aborted &&
            run.cases.some((c) => c.status === "running")
          ) {
            capHit = true;
            abort.abort();
          }
        }
      };
      await Promise.all(
        Array.from({ length: Math.max(1, Math.min(this.concurrency, list.length)) }, lane),
      );
    };
    await phase(jobs.filter((j) => j.state.kind === "lens"));
    if (!signal.aborted && !capHit) await phase(jobs.filter((j) => j.state.kind === "validate"));
    for (const c of run.cases)
      if (c.status === "pending") c.status = capHit ? "skipped" : "stopped";
    const allDone = run.cases.every((c) => c.status === "done");
    this.settle(
      file,
      run,
      allDone ? "complete" : capHit ? "capped" : signal.aborted ? "stopped" : "partial",
    );
  }

  /** One case, start to finish. Resolves with what it cost (its estimate
   * when the runner could not price it), never rejects. */
  private async runCase(
    file: ReplayFile,
    run: ReplayRun,
    job: CaseJob,
    signal: AbortSignal,
    onCost: (spentSoFar: number) => void,
  ): Promise<number> {
    const c = job.state;
    if (signal.aborted) {
      c.status = "stopped";
      return 0;
    }
    // A validation reads what its side's lenses found.
    let candidates: ReplayFinding[] = [];
    if (c.kind === "validate") {
      const read = (job.reads ?? []).map((id) => run.cases.find((x) => x.id === id)!);
      candidates = read.flatMap((x) => x.findings ?? []);
      if (read.some((x) => x.status !== "done")) {
        run.problems.push(
          `${c.id}: the validator reads only what finished — ${read
            .filter((x) => x.status !== "done")
            .map((x) => x.id)
            .join(", ")} did not`,
        );
      }
      if (candidates.length === 0) {
        // Nothing to validate is a finished validation, and free.
        c.status = "done";
        c.cost_usd = 0;
        c.findings = [];
        c.kept = c.doubted = c.killed = 0;
        c.finished_at = this.ports.clock().toISOString();
        return 0;
      }
    }
    c.status = "running";
    c.started_at = this.ports.clock().toISOString();
    this.store(file);
    let seen = 0;
    let outcome: CaseOutcome;
    try {
      outcome = await this.ports.cases(job.agentsDir).run(
        {
          id: `${run.id}/${c.id}`,
          unit: `PR #${c.pr}`,
          agent: c.agent,
          files: [],
          prompt: job.prompt(candidates),
        },
        signal,
        (v) => {
          seen = Math.max(seen, v);
          onCost(seen);
        },
      );
    } catch (err) {
      outcome = { ok: false, reason: `the case runner threw: ${clean(err)}`, cost_usd: null };
    }
    const cost = outcome.cost_usd === undefined ? null : outcome.cost_usd;
    c.cost_usd = cost;
    c.finished_at = this.ports.clock().toISOString();
    if (cost === null) run.unpriced_cases++;
    const spent = cost ?? Math.max(seen, c.estimate_usd);
    if (!outcome.ok) {
      c.status = signal.aborted ? "stopped" : "failed";
      c.error = outcome.reason;
      return spent;
    }
    if (outcome.reads !== undefined) {
      const r = replayReads(outcome.reads, { root: job.root, diffPath: job.diffPath });
      c.reads = { pr: r.pr.length, elsewhere: r.elsewhere.length };
      if (r.elsewhere.length > 0) {
        const n = r.elsewhere.length;
        const shown = r.elsewhere.slice(0, 3).join(", ") + (n > 3 ? ", …" : "");
        run.problems.push(
          `${c.id}: ${c.lens} — ${r.pr.length === 0 ? `read none of PR #${c.pr}'s files: ` : ""}${n} file read${n === 1 ? "" : "s"} opened outside PR #${c.pr}'s worktree (${shown}) — not the PR's code`,
        );
      }
    }
    if (c.kind === "lens") {
      const answer = parseScanAnswer(outcome.output, { root: job.root, deepLenses: [] });
      c.findings = answer.candidates.map((f) => ({
        ...f,
        lens: c.lens,
        doubt: null,
        validated: false,
      }));
      c.dropped = answer.dropped;
      c.none = answer.none;
    } else {
      const v = validated(outcome.output, job.root, candidates);
      c.findings = v.findings;
      c.dropped = v.dropped;
      c.kept = v.kept;
      c.doubted = v.doubted;
      c.killed = v.killed;
    }
    c.status = "done";
    return spent;
  }

  private settle(file: ReplayFile, run: ReplayRun, state: ReplayRunState): void {
    run.state = state;
    run.finished_at = this.ports.clock().toISOString();
    file.rates = { ...file.rates, ...measuredRates(run.cases) };
    try {
      this.store(file);
    } catch (err) {
      this.ports.log?.(`setup: could not record replay ${run.id}: ${clean(err)}`);
    }
  }
}

function sideViews(sides: Record<SideName, ReplaySide>): Record<SideName, ReplaySideView> {
  const v = (s: ReplaySide): ReplaySideView => ({
    profile: s.profile,
    basis: s.basis,
    baseline: s.baseline,
  });
  return { old: v(sides.old), new: v(sides.new) };
}

function planKeyOf(parts: unknown): string {
  // One hash spelling for every setup key.
  return caseKey(JSON.stringify(parts), "");
}

/**
 * A validator's answer over `candidates`: its survivors (attributed back to
 * the lens that raised them), the candidates it DOUBTED (kept, marked "may
 * not be valid"), and the rest killed.
 */
export function validated(
  output: string,
  root: string,
  candidates: readonly ReplayFinding[],
): { findings: ReplayFinding[]; dropped: number; kept: number; doubted: number; killed: number } {
  const answer = parseValidatorAnswer(output, root);
  const near = (
    a: { path: string; start: number; end: number },
    b: ScanCandidate | ReplayFinding,
  ): boolean => a.path === b.path && a.start <= b.end && b.start <= a.end;
  const used = new Set<ReplayFinding>();
  const findings: ReplayFinding[] = [];
  for (const s of answer.survivors) {
    const from =
      candidates.find((c) => !used.has(c) && near(s, c) && c.kind === s.kind) ??
      candidates.find((c) => !used.has(c) && near(s, c));
    if (from) used.add(from);
    findings.push({ ...s, lens: from?.lens ?? VALIDATE_PASS, doubt: null, validated: true });
  }
  const kept = findings.length;
  let doubted = 0;
  for (const d of answer.doubted) {
    const at = { path: d.path, start: d.line ?? 1, end: d.line ?? Number.MAX_SAFE_INTEGER };
    const c = candidates.find((x) => !used.has(x) && near(at, x));
    if (!c) continue;
    used.add(c);
    doubted++;
    findings.push({ ...c, doubt: { word: d.word, reason: d.reason }, validated: true });
  }
  return {
    findings,
    dropped: answer.dropped,
    kept,
    doubted,
    killed: Math.max(0, candidates.length - used.size),
  };
}

/**
 * The two reviews of each PR side by side: each side's findings (its
 * validator's answer when it ran, else its lenses' candidates, unvalidated),
 * paired where both found the same thing, and what each cost — a case both
 * sides share counted once, as `shared`.
 */
export function compareRun(run: Pick<ReplayRun, "prs" | "cases">): ReplayComparison[] {
  return run.prs.map((pr) => {
    const findings = {} as Record<SideName, ReplayFinding[]>;
    const complete = {} as Record<SideName, boolean>;
    for (const side of SIDES) {
      const rows = pr.plans[side];
      const cases = rows
        .map((r) => run.cases.find((c) => c.id === r.case))
        .filter((c): c is ReplayCaseState => c !== undefined);
      const validation = cases.find((c) => c.kind === "validate");
      complete[side] = cases.every((c) => c.status === "done");
      findings[side] = (
        validation && validation.status === "done"
          ? (validation.findings ?? [])
          : cases.filter((c) => c.kind === "lens").flatMap((c) => c.findings ?? [])
      ).sort(bySeverity);
    }
    const mine = run.cases.filter((c) => c.pr === pr.number);
    // A case that never started cost nothing; one that ran unpriced makes
    // its side's cost unknown, never a smaller number.
    const sum = (cs: ReplayCaseState[]): number | null =>
      cs.some((c) => c.cost_usd === null && c.started_at !== null)
        ? null
        : usd(cs.reduce((t, c) => t + (c.cost_usd ?? 0), 0));
    const compared = compareFindings(findings.old, findings.new);
    return {
      pr: pr.number,
      title: pr.title,
      findings,
      complete,
      ...compared,
      cost: {
        old: sum(mine.filter((c) => c.sides.length === 1 && c.sides[0] === "old")),
        new: sum(mine.filter((c) => c.sides.length === 1 && c.sides[0] === "new")),
        shared: sum(mine.filter((c) => c.sides.length === 2)),
      },
    };
  });
}
