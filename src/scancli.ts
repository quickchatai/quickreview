// `qcr scan` — the companion's scan tools (extensions/setup-scan.ts) as a
// scriptable CLI verb. Every subcommand calls what its tool calls (the
// ScanRunner, the findings store, the triage, and the shared verbs beside the
// tools) and renders it twice: the human default, worded for the CLI, and a
// `--json` object on one line for scripts.
//
// The promises are the runner's own and hold here unchanged: `start` must
// quote the key `preview` handed out (a plan, sha, price or setting that
// moved since is refused), and a run stops hard at the estimate it showed.
//
// Where a run is driven: `start` (and `stage2 start`) launches a detached
// `qcr scan … --foreground` driver, waits until it has recorded the run (or
// refused), and returns. With `[scan] sandbox = "docker"` (the default) the
// driver runs in a throwaway container from the scan sandbox image
// (src/scanbox.ts); with `"host"` it is a detached process on this machine.
// Either way its records are the state home's, so every other subcommand
// reads them here, on the host. The driver runs the
// cases, answers the stop channel (the TUI's `[8] scan` stop and
// `qcr scan stop` alike), and holds the driver lease (src/setup/scanlease.ts)
// so that the companion and other drivers read its run as running and start
// nothing beside it. `--foreground` drives in the calling process instead,
// to the run's end. `status --wait` blocks until the recorded run is no longer
// driven by anyone.
//
// Host-side beside them: `units` — the setup belt's unit-cut tools
// (extensions/setup.ts) — and the sandbox's `login` and `doctor`.
//
// Exit codes: 0 done; 1 refused (or a waited-for run that did not end
// complete); 2 usage; 3 `status --wait` gave up at its `--timeout`.
import { dismissedLine } from "./setup/presentation.js";
import { spawn, spawnSync, type SpawnOptions } from "node:child_process";
import { closeSync, existsSync, openSync, readFileSync } from "node:fs";
import { join } from "node:path";
import {
  CLI_VERBS,
  FINDINGS_LIMIT,
  startedDetails,
  answerMatch,
  findingsFilter,
  listFindings,
  previewDetails,
  proposalDetails,
  renderFindings,
  renderPreview,
  renderProposal,
  renderQuestion,
  renderStatus,
  renderSuggestions,
  stage2StartedLine,
  startedLine,
  stopScan,
} from "../extensions/setup-scan.js";
import {
  CUT_CLI_VERBS,
  renderCut,
  renderDraft,
  renderStatus as renderCutStatus,
} from "../extensions/setup.js";
import { loadConfig, sandboxRoot, type CompanionConfig } from "./config.js";
import { stateHome } from "./install.js";
import {
  IN_SANDBOX_ENV,
  STARTED_FILE_ENV,
  renderDoctor,
  writeStartedFile,
  type DoctorReport,
} from "./scanbox.js";
import {
  DETACH_TIMEOUT_MS,
  DRIVER_LOG,
  DRIVER_LOG_MAX,
  prepareDriverLog,
} from "./scandriverlog.js";
import type { SetupEngine } from "./setup/engine.js";
import type { FindingsStore, ScanFinding } from "./setup/findings.js";
import { dismissedLookalike, validityOf } from "./setup/scanreport.js";
import type { ScanRunner, ScanRun, ScanSettings, ScanStatus } from "./setup/scanrun.js";
import { lensTiers, stage2Lenses, MAX_STAGE2_ROWS } from "./setup/stage2.js";
import type { StoredStage2Proposal } from "./setup/stage2request.js";
import type { CloseFixedResult, ScanTriage } from "./setup/triage.js";
import { SCAN_SCHEMA_VERSION, withSchemaVersion } from "./contract.js";

export const SCAN_USAGE =
  "usage: qcr scan preview [--sha REF] [--delta] | start --key K [--sha REF] [--delta] [--foreground] | " +
  "status [--wait [--timeout S]] | stop | " +
  "findings [--state S] [--lens L] [--unit U] [--severity P] [--validity V] [--doubted|--not-doubted] [--limit N] | " +
  "matches | match --key K [OLD=NEW…] | suggestions | " +
  "stage2 propose [--rows FILE|-] [--budget USD] [--deep|--standard] [--sha REF] | " +
  "stage2 start --key K [--rows ID,ID…] [--foreground] | dismiss FP… --reason TEXT | " +
  "units show | units propose [--file F|-] | units adjust --file F|- | units save | login [--provider P] | doctor | rebuild   (every subcommand takes --json)";

export { DETACH_TIMEOUT_MS, DRIVER_LOG, DRIVER_LOG_MAX };
/** How often `status --wait` and `stop` look again. */
export const POLL_MS = 2000;

/** The SDK leaf host's private agent dir, under the state home: its own models
 * list lives here, never in the operator's pi home. */
const SCAN_SDK_AGENT_DIR = "scan/sdk-agent";

export interface FindingsQuery {
  state?: string;
  lens?: string;
  unit?: string;
  severity?: string;
  validity?: string;
  doubted?: boolean;
  limit?: number;
}

export type ScanCommand =
  | { verb: "preview"; sha?: string; delta: boolean }
  | { verb: "start"; key: string; sha?: string; delta: boolean; foreground: boolean }
  | { verb: "status"; wait: boolean; timeout?: number }
  | { verb: "stop" }
  | { verb: "findings"; query: FindingsQuery }
  | { verb: "matches" }
  | { verb: "match"; key: string; pairs: Array<{ old: string; new: string }> }
  | { verb: "suggestions" }
  | { verb: "stage2-propose"; rows?: string; budget?: number; deep?: boolean; sha?: string }
  | { verb: "stage2-start"; key: string; rows?: string[]; foreground: boolean }
  | { verb: "dismiss"; fingerprints: string[]; reason: string }
  | { verb: "units-show" }
  | { verb: "units-propose"; file?: string }
  | { verb: "units-adjust"; file: string }
  | { verb: "units-save" }
  | { verb: "login"; provider?: string }
  | { verb: "doctor" }
  | { verb: "rebuild" };

const usage = (why?: string): Error => new Error(why ? `${SCAN_USAGE}\n(${why})` : SCAN_USAGE);

/** `qcr scan`'s arguments (`--json` taken off before). An unknown token is
 * refused, so a mistyped flag never runs something else. */
export function parseScanArgs(rest: readonly string[]): ScanCommand {
  const [first, ...more] = rest;
  let sub = first;
  let args = more;
  if (first === "stage2" || first === "units") {
    sub = `${first}-${more[0] ?? ""}`;
    args = more.slice(1);
  }
  const flags = new Map<string, string | true>();
  const positional: string[] = [];
  const VALUED = new Set([
    "--sha",
    "--key",
    "--timeout",
    "--state",
    "--lens",
    "--unit",
    "--severity",
    "--validity",
    "--limit",
    "--rows",
    "--budget",
    "--reason",
    "--file",
    "--provider",
  ]);
  const BARE = new Set([
    "--delta",
    "--foreground",
    "--wait",
    "--doubted",
    "--not-doubted",
    "--deep",
    "--standard",
  ]);
  for (let i = 0; i < args.length; i++) {
    const a = args[i]!;
    if (VALUED.has(a)) {
      const v = args[++i];
      if (v === undefined || v.startsWith("--")) throw usage();
      flags.set(a, v);
    } else if (BARE.has(a)) flags.set(a, true);
    else if (a.startsWith("--")) throw usage();
    else positional.push(a);
  }
  const allowed = (...names: string[]): void => {
    for (const k of flags.keys()) if (!names.includes(k)) throw usage();
  };
  const noPositional = (): void => {
    if (positional.length > 0) throw usage();
  };
  const str = (k: string): string | undefined => {
    const v = flags.get(k);
    return typeof v === "string" ? v : undefined;
  };
  const num = (k: string, ok: (n: number) => boolean): number | undefined => {
    const v = str(k);
    if (v === undefined) return undefined;
    const n = Number(v);
    if (!Number.isFinite(n) || !ok(n)) throw usage();
    return n;
  };
  const sha = (): { sha?: string } => (str("--sha") !== undefined ? { sha: str("--sha")! } : {});
  switch (sub) {
    case "preview":
      allowed("--sha", "--delta");
      noPositional();
      return { verb: "preview", ...sha(), delta: flags.has("--delta") };
    case "start": {
      allowed("--key", "--sha", "--delta", "--foreground");
      noPositional();
      const key = str("--key");
      if (key === undefined) throw usage("start needs --key — the key a preview showed");
      return {
        verb: "start",
        key,
        ...sha(),
        delta: flags.has("--delta"),
        foreground: flags.has("--foreground"),
      };
    }
    case "status": {
      allowed("--wait", "--timeout");
      noPositional();
      const timeout = num("--timeout", (n) => n > 0);
      if (timeout !== undefined && !flags.has("--wait")) throw usage("--timeout needs --wait");
      return {
        verb: "status",
        wait: flags.has("--wait"),
        ...(timeout !== undefined ? { timeout } : {}),
      };
    }
    case "stop":
      allowed();
      noPositional();
      return { verb: "stop" };
    case "findings": {
      allowed(
        "--state",
        "--lens",
        "--unit",
        "--severity",
        "--validity",
        "--doubted",
        "--not-doubted",
        "--limit",
      );
      noPositional();
      if (flags.has("--doubted") && flags.has("--not-doubted")) throw usage();
      const query: FindingsQuery = {};
      for (const k of ["state", "lens", "unit", "severity", "validity"] as const) {
        const v = str(`--${k}`);
        if (v !== undefined) query[k] = v;
      }
      if (flags.has("--doubted")) query.doubted = true;
      if (flags.has("--not-doubted")) query.doubted = false;
      const limit = num("--limit", (n) => Number.isInteger(n) && n > 0);
      if (limit !== undefined) query.limit = limit;
      return { verb: "findings", query };
    }
    case "matches":
      allowed();
      noPositional();
      return { verb: "matches" };
    case "match": {
      allowed("--key");
      const key = str("--key");
      if (key === undefined) throw usage("match needs --key — the key the match question showed");
      const pairs = positional.map((p) => {
        const m = /^([0-9a-f]+)=([0-9a-f]+)$/i.exec(p);
        if (!m) throw usage(`a pair is OLD=NEW (two fingerprints), not ${JSON.stringify(p)}`);
        return { old: m[1]!, new: m[2]! };
      });
      return { verb: "match", key, pairs };
    }
    case "suggestions":
      allowed();
      noPositional();
      return { verb: "suggestions" };
    case "stage2-propose": {
      allowed("--rows", "--budget", "--deep", "--standard", "--sha");
      noPositional();
      if (flags.has("--deep") && flags.has("--standard")) throw usage();
      const budget = num("--budget", (n) => n > 0);
      return {
        verb: "stage2-propose",
        ...(str("--rows") !== undefined ? { rows: str("--rows")! } : {}),
        ...(budget !== undefined ? { budget } : {}),
        ...(flags.has("--deep") ? { deep: true } : flags.has("--standard") ? { deep: false } : {}),
        ...sha(),
      };
    }
    case "stage2-start": {
      allowed("--key", "--rows", "--foreground");
      noPositional();
      const key = str("--key");
      if (key === undefined)
        throw usage("stage2 start needs --key — the key the stage 2 proposal showed");
      const rows = str("--rows");
      return {
        verb: "stage2-start",
        key,
        ...(rows !== undefined ? { rows: rows.split(",").map((r) => r.trim()) } : {}),
        foreground: flags.has("--foreground"),
      };
    }
    case "dismiss": {
      allowed("--reason");
      const reason = str("--reason");
      if (reason === undefined) throw usage("dismiss needs --reason — it is what PR rounds read");
      if (positional.length === 0) throw usage("dismiss needs at least one fingerprint");
      return { verb: "dismiss", fingerprints: positional, reason };
    }
    case "login": {
      allowed("--provider");
      noPositional();
      const provider = str("--provider");
      return { verb: "login", ...(provider !== undefined ? { provider } : {}) };
    }
    case "units-show":
    case "units-save":
    case "doctor":
    case "rebuild":
      allowed();
      noPositional();
      return { verb: sub };
    case "units-propose": {
      allowed("--file");
      noPositional();
      const file = str("--file");
      return { verb: "units-propose", ...(file !== undefined ? { file } : {}) };
    }
    case "units-adjust": {
      allowed("--file");
      noPositional();
      const file = str("--file");
      if (file === undefined)
        throw usage("units adjust needs --file — a JSON array of adjust ops (or - for stdin)");
      return { verb: "units-adjust", file };
    }
    default:
      throw usage();
  }
}

// ---- the stable JSON shapes ----------------------------------------------------

/** One stored finding as `--json` carries it. */
export interface FindingJson {
  fingerprint: string;
  file: string;
  range: { start: number; end: number };
  lens: string;
  lenses: string[];
  unit: string;
  kind: string;
  severity: string;
  validity: string;
  state: string;
  claim: string;
  /** Marked "may not be valid" by the validator. */
  doubted: boolean;
  doubt: { word: string; reason: string; class: string | null } | null;
  /** A dismissed finding it resembles — flagged, never auto-dismissed. */
  looks_like_dismissed: { fingerprint: string; reason: string } | null;
  dismissal_reason: string | null;
  ticket: string | null;
  first_seen: { run: string; sha: string };
  last_seen: { run: string; sha: string };
}

export function findingJson(f: ScanFinding): FindingJson {
  const look = dismissedLookalike(f);
  return {
    fingerprint: f.fingerprint,
    file: f.path,
    range: { start: f.start, end: f.end },
    lens: f.lens,
    lenses: f.lenses ?? [f.lens],
    unit: f.unit,
    kind: f.kind,
    severity: f.severity,
    validity: validityOf(f),
    state: f.state,
    claim: f.claim,
    doubted: f.doubt !== null,
    doubt: f.doubt
      ? { word: f.doubt.word, reason: f.doubt.reason, class: f.doubt.class ?? null }
      : null,
    looks_like_dismissed: look ? { fingerprint: look.fingerprint, reason: look.reason } : null,
    dismissal_reason: f.dismissal?.reason ?? null,
    ticket: f.ticket?.ref ?? null,
    first_seen: { run: f.first_seen.run, sha: f.first_seen.sha },
    last_seen: { run: f.last_seen.run, sha: f.last_seen.sha },
  };
}

/** A run as `status --json` and a foreground start carry it. */
export function runJson(run: ScanRun & { display?: string }): Record<string, unknown> {
  const n = (k: "findings" | "doubted"): number => run.cases.reduce((t, c) => t + c[k], 0);
  return {
    id: run.id,
    mode: run.mode,
    sha: run.sha,
    state: run.state,
    display: run.display ?? run.state,
    depth: run.settings.depth ?? "standard",
    started_at: run.started_at,
    finished_at: run.finished_at,
    cap_usd: run.cap_usd,
    estimate_usd: run.estimate_usd,
    spent_usd: run.spent_usd,
    unpriced_cases: run.unpriced_cases,
    cases_total: run.cases.length,
    cases_done: run.cases.filter((c) => c.status === "done").length,
    cases_failed: run.cases.filter((c) => c.status === "failed").length,
    findings: n("findings"),
    doubted: n("doubted"),
    matching: run.matching ?? null,
    tickets_closed: run.tickets_closed ?? 0,
    problems: run.problems,
    cases: run.cases.map((c) => ({
      id: c.id,
      unit: c.unit,
      status: c.status,
      findings: c.findings,
      doubted: c.doubted,
      cost_usd: c.cost_usd,
      error: c.error,
      ...(c.lens !== undefined ? { lens: c.lens, tier: c.tier ?? null } : {}),
    })),
  };
}

function proposalJson(p: StoredStage2Proposal): Record<string, unknown> {
  return {
    ...proposalDetails(p),
    budget_usd: p.budget_usd,
    over_budget_usd: p.over_budget_usd,
    validator: p.validator,
    row_list: p.rows.map((r) => ({
      id: r.id,
      lens: r.lens,
      tier: r.tier,
      units: r.units,
      files: r.files.map((f) => f.path),
      tests: r.tests.map((f) => f.path),
      lines: r.lines,
      estimate_usd: r.estimate_usd,
      status: r.status,
      floor: r.floor === true,
      reason: r.reason,
    })),
  };
}

// ---- the verb ------------------------------------------------------------------

/** What a detached driver answers once it has recorded its run (or refused);
 * a sandboxed one names its container. */
export type DetachOutcome =
  { ok: true; run: ScanRun; log: string; container?: string } | { ok: false; errors: string[] };

/** The unit-cut verbs `qcr scan units` calls — the setup engine's. */
export type UnitCutPort = Pick<SetupEngine, "status" | "propose" | "adjust" | "save">;

export interface ScanCliDeps {
  scan: ScanRunner;
  findings: FindingsStore;
  settingsOf: () => ScanSettings | null;
  triage: ScanTriage | null;
  /** After a match answer: close the tickets of the promoted findings it fixed. */
  afterMatch: (() => Promise<CloseFixedResult>) | null;
  /** The state home. */
  home: string;
  out: (line: string) => void;
  /** Launch `qcr scan <argv> --foreground` detached; resolves once it started. */
  detach: (argv: string[]) => Promise<DetachOutcome>;
  sleep: (ms: number) => Promise<void>;
  now: () => number;
  /** While a foreground driver runs: answer the stop channel (and signals).
   * Returns the stop. Absent: nothing is watched. */
  watchStops?: (scan: ScanRunner) => () => void;
  /** A foreground driver's start outcome, for the process that detached it. */
  onStart?: (r: DetachOutcome) => void;
  /** `units`: the setup engine over the reviewed checkout. Absent: refused. */
  units?: UnitCutPort | null;
  /** `doctor`: the sandbox's readiness report. */
  doctor?: () => Promise<DoctorReport>;
  /** `login`: pi, interactive, over the companion's pi home (in the running companion, or a throwaway container); its exit code. */
  login?: (provider?: string) => Promise<number>;
  /** `rebuild`: build `[scan] image` alone, stamped; no container touched. */
  rebuild?: () => Promise<
    { ok: true; image: string; stamp: string } | { ok: false; errors: string[] }
  >;
}

type Emit = (code: number, human: string, data: Record<string, unknown>) => number;

/** Run one `qcr scan` subcommand; resolves its exit code. */
export async function runScanCli(
  rest: readonly string[],
  json: boolean,
  deps: ScanCliDeps,
): Promise<number> {
  const emit: Emit = (code, human, data) => {
    deps.out(json ? JSON.stringify(withSchemaVersion(SCAN_SCHEMA_VERSION, data)) : human);
    return code;
  };
  const refusal = (what: string, errors: readonly string[], code = 1): number =>
    emit(code, `${what} refused:\n${errors.map((e) => `✗ ${e}`).join("\n")}`, {
      ok: false,
      errors,
    });
  let cmd: ScanCommand;
  try {
    cmd = parseScanArgs(rest);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return emit(2, msg, { ok: false, errors: [msg] });
  }
  const { scan } = deps;
  switch (cmd.verb) {
    case "preview": {
      const r = await scan.preview({ ...(cmd.sha ? { sha: cmd.sha } : {}), delta: cmd.delta });
      if (!r.ok) return refusal("Scan preview", r.errors);
      const p = r.preview;
      const start =
        p.blockers.length > 0
          ? null
          : ["--key", p.key, "--sha", p.sha, ...(p.mode === "delta" ? ["--delta"] : [])];
      return emit(0, renderPreview(p, CLI_VERBS), {
        ok: true,
        preview: previewDetails(p),
        start,
      });
    }
    case "start":
    case "stage2-start": {
      const stage2 = cmd.verb === "stage2-start";
      const argv =
        cmd.verb === "start"
          ? [
              "start",
              "--key",
              cmd.key,
              ...(cmd.sha ? ["--sha", cmd.sha] : []),
              ...(cmd.delta ? ["--delta"] : []),
            ]
          : [
              "stage2",
              "start",
              "--key",
              cmd.key,
              ...(cmd.rows ? ["--rows", cmd.rows.join(",")] : []),
            ];
      const what = stage2 ? "Stage 2 start" : "Scan start";
      const line = (run: ScanRun): string =>
        stage2
          ? stage2StartedLine(
              run,
              scan.stage2Proposal().proposal?.runnable ?? null,
              cmd.verb === "stage2-start" && cmd.rows !== undefined,
              CLI_VERBS,
            )
          : startedLine(run, CLI_VERBS);
      if (!cmd.foreground) {
        const d = await deps.detach(argv);
        if (!d.ok) return refusal(what, d.errors);
        return emit(
          0,
          `${line(d.run)}\nDriver output: ${d.log}${d.container ? `\nContainer: ${d.container}` : ""}`,
          {
            ok: true,
            run: startedDetails(d.run),
            log: d.log,
            ...(d.container ? { container: d.container } : {}),
          },
        );
      }
      const r =
        cmd.verb === "start"
          ? await scan.start({
              key: cmd.key,
              ...(cmd.sha ? { sha: cmd.sha } : {}),
              delta: cmd.delta,
            })
          : await scan.startStage2({ key: cmd.key, ...(cmd.rows ? { rows: cmd.rows } : {}) });
      if (!r.ok) {
        deps.onStart?.({ ok: false, errors: r.errors });
        return refusal(what, r.errors);
      }
      deps.onStart?.({ ok: true, run: r.run, log: join(deps.home, DRIVER_LOG) });
      if (!json) deps.out(line(r.run));
      // A pending promise alone keeps no process alive: hold it open until
      // the run ends.
      const keep = setInterval(() => {}, 60_000);
      const unwatch = deps.watchStops?.(scan) ?? null;
      try {
        await scan.idle();
      } finally {
        unwatch?.();
        clearInterval(keep);
      }
      const s = scan.status();
      const complete = s.run?.display === "complete";
      return emit(complete ? 0 : 1, renderStatus(s, CLI_VERBS), {
        ok: complete,
        run: s.run ? runJson(s.run) : null,
      });
    }
    case "status": {
      let s = scan.status();
      const t0 = deps.now();
      while (cmd.wait && s.run?.display === "running") {
        if (cmd.timeout !== undefined && deps.now() - t0 >= cmd.timeout * 1000) {
          return emit(3, `${renderStatus(s, CLI_VERBS)}\nstill running after ${cmd.timeout}s`, {
            ...statusJson(s),
            timed_out: true,
          });
        }
        await deps.sleep(POLL_MS);
        s = scan.status();
      }
      const code = cmd.wait
        ? s.run === null || s.run.display === "complete"
          ? 0
          : 1
        : s.ok
          ? 0
          : 1;
      return emit(code, renderStatus(s, CLI_VERBS), statusJson(s));
    }
    case "stop":
      return stop(deps, emit, refusal);
    case "findings": {
      const f = findingsFilter(cmd.query as Record<string, unknown>);
      if (!f.ok) return emit(2, f.error, { ok: false, errors: [f.error] });
      const listed = listFindings(deps.findings, f.filter);
      if (!listed.ok) return refusal("Findings", [listed.error]);
      const all = listed.findings;
      const shown = all.slice(0, cmd.query.limit ?? (json ? all.length : FINDINGS_LIMIT));
      return emit(0, renderFindings(shown, all.length), {
        ok: true,
        total: all.length,
        validity: listed.validity,
        findings: shown.map(findingJson),
      });
    }
    case "matches": {
      const { question, error } = deps.findings.question();
      if (error !== null) return refusal("Match question", [error]);
      return emit(0, renderQuestion(question, CLI_VERBS), {
        ok: true,
        question: question
          ? {
              key: question.key,
              run: question.run,
              sha: question.sha,
              unreported: question.unreported.map(findingJson),
              fresh: question.fresh.map(findingJson),
            }
          : null,
      });
    }
    case "match": {
      const r = await answerMatch(
        deps.findings,
        { key: cmd.key, pairs: cmd.pairs },
        deps.afterMatch,
      );
      if (!r.ok) return refusal("Match", r.errors);
      const { tickets, lines, ...result } = r;
      return emit(0, lines.join("\n"), {
        ...result,
        tickets_closed: tickets?.closed.length ?? 0,
      });
    }
    case "suggestions": {
      const { suggestions, error } = scan.suggestions();
      if (error !== null) return refusal("Suggestions", [error]);
      const s = deps.settingsOf();
      return emit(0, renderSuggestions(suggestions, s), {
        ok: true,
        suggestions,
        stage2: s
          ? {
              lenses: stage2Lenses(s.lenses).map((lens) => ({
                lens,
                tiers: lensTiers(s.lenses, lens, s.riskPasses ?? []),
              })),
              depth: s.scan.depth,
              deep_lenses: s.scan.deep_lenses,
              case_max_files: s.scan.case_max_files,
              case_max_lines: s.scan.case_max_lines,
              max_rows: MAX_STAGE2_ROWS,
            }
          : null,
      });
    }
    case "stage2-propose": {
      let rows: unknown = [];
      if (cmd.rows !== undefined) {
        try {
          rows = JSON.parse(readFileSync(cmd.rows === "-" ? 0 : cmd.rows, "utf8"));
        } catch (err) {
          return refusal("Stage 2 proposal", [
            `the rows (${cmd.rows}) cannot be read as JSON: ${err instanceof Error ? err.message : String(err)}`,
          ]);
        }
      }
      const r = await scan.proposeStage2({
        rows,
        ...(cmd.budget !== undefined ? { budget_usd: cmd.budget } : {}),
        ...(cmd.sha ? { sha: cmd.sha } : {}),
        ...(cmd.deep !== undefined ? { deep: cmd.deep } : {}),
      });
      if (!r.ok) return refusal("Stage 2 proposal", r.errors);
      return emit(0, renderProposal(r.proposal, CLI_VERBS), {
        ok: true,
        proposal: proposalJson(r.proposal),
      });
    }
    case "dismiss": {
      if (deps.triage === null) return refusal("Dismiss", ["no triage in this assembly"]);
      const dismissed: Array<Record<string, unknown>> = [];
      const errors: string[] = [];
      const lines: string[] = [];
      for (const fp of cmd.fingerprints) {
        const r = await deps.triage.dismiss({ fingerprint: fp, reason: cmd.reason });
        if (!r.ok) {
          errors.push(`${fp}: ${r.errors.join("; ")}`);
          lines.push(`✗ ${fp}: ${r.errors.join("; ")}`);
          continue;
        }
        dismissed.push({
          fingerprint: r.finding.fingerprint,
          again: r.again,
          memory:
            r.memory === "written"
              ? { written: true }
              : { written: false, problem: r.memory.problem },
        });
        lines.push(dismissedLine(r));
      }
      return emit(errors.length === 0 ? 0 : 1, lines.join("\n"), {
        ok: errors.length === 0,
        dismissed,
        errors,
      });
    }
    case "units-show":
    case "units-propose":
    case "units-adjust":
    case "units-save":
      return units(cmd, deps.units ?? null, emit, refusal);
    case "doctor": {
      if (!deps.doctor) return refusal("Doctor", ["no doctor in this assembly"]);
      const r = await deps.doctor();
      return emit(r.ok ? 0 : 1, renderDoctor(r), r as unknown as Record<string, unknown>);
    }
    case "login":
      if (json)
        return refusal("Login", ["login is interactive; run qcr scan login without --json"]);
      if (!deps.login) return refusal("Login", ["no login in this assembly"]);
      return deps.login(cmd.provider);
    case "rebuild": {
      if (!deps.rebuild) return refusal("Scan image rebuild", ["no rebuild in this assembly"]);
      const r = await deps.rebuild();
      if (!r.ok) return refusal("Scan image rebuild", r.errors);
      return emit(
        0,
        `Scan image ${r.image} built (stamp ${r.stamp}); no container was stopped or replaced. ` +
          "A companion on the same image keeps its container until `qcr companion rebuild`.",
        { ok: true, image: r.image, stamp: r.stamp },
      );
    }
  }
}

/** `qcr scan units …`: the setup belt's unit-cut tools, over the same
 * engine and rendering, worded for the CLI. */
function units(
  cmd: Extract<ScanCommand, { verb: `units-${string}` }>,
  engine: UnitCutPort | null,
  emit: Emit,
  refusal: (what: string, errors: readonly string[]) => number,
): number {
  if (engine === null) return refusal("Unit cut", ["no setup engine in this assembly"]);
  const readJson = (file: string): { ok: true; value: unknown } | { ok: false; error: string } => {
    try {
      return { ok: true, value: JSON.parse(readFileSync(file === "-" ? 0 : file, "utf8")) };
    } catch (err) {
      return {
        ok: false,
        error: `${file === "-" ? "stdin" : file} cannot be read as JSON: ${err instanceof Error ? err.message : String(err)}`,
      };
    }
  };
  switch (cmd.verb) {
    case "units-show": {
      const s = engine.status();
      return emit(0, renderCutStatus(s), { ok: true, status: s });
    }
    case "units-propose": {
      let input: unknown;
      if (cmd.file !== undefined) {
        const j = readJson(cmd.file);
        if (!j.ok) return refusal("Proposal", [j.error]);
        input = j.value;
      }
      const r = engine.propose(input);
      if (!r.ok) return refusal("Proposal", r.errors);
      return emit(0, renderDraft("Draft stored", r.draft, CUT_CLI_VERBS), {
        ok: true,
        draft: r.draft,
      });
    }
    case "units-adjust": {
      const j = readJson(cmd.file);
      if (!j.ok) return refusal("Adjustment", [j.error]);
      // The tool's own parameter shape, `{ops: […]}`, or the ops alone.
      const v = j.value;
      const ops =
        typeof v === "object" && v !== null && !Array.isArray(v) && "ops" in v ? v.ops : v;
      const r = engine.adjust(ops);
      if (!r.ok) return refusal("Adjustment", r.errors);
      return emit(0, renderDraft("Draft adjusted", r.draft, CUT_CLI_VERBS), {
        ok: true,
        draft: r.draft,
      });
    }
    case "units-save": {
      const r = engine.save();
      if (!r.ok) return refusal("Save", r.errors);
      return emit(0, renderCut("Unit cut saved", r.saved), { ok: true, saved: r.saved });
    }
  }
}

function statusJson(s: ScanStatus): Record<string, unknown> {
  return {
    ok: s.ok,
    problems: s.problems,
    run: s.run ? runJson(s.run) : null,
    active: s.active,
    history: s.history,
    ledger: s.ledger,
  };
}

/** `qcr scan stop`: the shared stop (`stopScan`), rendered. */
async function stop(
  deps: ScanCliDeps,
  emit: Emit,
  refusal: (what: string, errors: readonly string[]) => number,
): Promise<number> {
  const r = await stopScan(deps.scan, {
    home: deps.home,
    by: "cli",
    sleep: deps.sleep,
    now: deps.now,
  });
  if (!r.ok) return refusal("Scan stop", r.errors);
  return emit(0, r.answer, { ok: true, run: r.run, answer: r.answer });
}

// ---- assembly ------------------------------------------------------------------

/** The env a host-side `qcr scan` assembles under: the reviewed checkout and
 * the tracker from `[companion]` when the env does not name them, so the CLI
 * reads the same repo the companion mounts. Inside a scan sandbox neither is
 * read — they are host paths — and the container's env decides. */
export function scanEnv(
  env: NodeJS.ProcessEnv,
  defaultRepo: string,
  companionOf: () => Pick<CompanionConfig, "reviewed_repo_dir" | "tracker_dir"> = () =>
    loadConfig().companion,
): NodeJS.ProcessEnv {
  let companion: { reviewed_repo_dir: string; tracker_dir: string } | null = null;
  if (!env[IN_SANDBOX_ENV]?.trim()) {
    try {
      companion = companionOf();
    } catch {
      // No readable config: the env and the defaults decide.
    }
  }
  const tracker = env.QCR_TRACKER_DIR?.trim() || companion?.tracker_dir || "";
  return {
    ...env,
    QCR_ROOT: env.QCR_ROOT?.trim() || sandboxRoot(),
    QCR_REVIEWED_REPO: env.QCR_REVIEWED_REPO?.trim() || companion?.reviewed_repo_dir || defaultRepo,
    ...(tracker ? { QCR_TRACKER_DIR: tracker } : {}),
  };
}

/** The child the launch needs — `child_process.spawn`'s, narrowed. */
interface DriverChild {
  on(event: "message", f: (m: unknown) => void): unknown;
  on(event: "error", f: (err: Error) => void): unknown;
  on(event: "exit", f: (code: number | null) => void): unknown;
  disconnect(): void;
  unref(): void;
  kill(signal?: NodeJS.Signals): boolean;
}

/** Launch the foreground driver detached — this CLI again, under the same
 * node flags, from the app root, its output appended to the driver log
 * (rotated past `logMax`) — and resolve once it says it started (or
 * refused). A driver that exits first, or stays silent past `timeoutMs` (it
 * is then stopped), is a refusal. */
export function detachDriver(
  env: NodeJS.ProcessEnv,
  home: string,
  opts: {
    spawn?: (command: string, args: string[], options: SpawnOptions) => DriverChild;
    execPath?: string;
    execArgv?: readonly string[];
    script?: string;
    timeoutMs?: number;
    logMax?: number;
  } = {},
): ScanCliDeps["detach"] {
  const spawnFn = opts.spawn ?? ((c, a, o) => spawn(c, a, o));
  const timeoutMs = opts.timeoutMs ?? DETACH_TIMEOUT_MS;
  const logMax = opts.logMax ?? DRIVER_LOG_MAX;
  return (argv) =>
    new Promise((resolve) => {
      const prepared = prepareDriverLog(home, logMax);
      if (!prepared.ok) {
        resolve({ ok: false, errors: [prepared.error] });
        return;
      }
      const log = prepared.path;
      let fd: number;
      try {
        fd = openSync(log, "a");
      } catch (err) {
        resolve({
          ok: false,
          errors: [
            `the driver log ${log} cannot be opened: ${err instanceof Error ? err.message : String(err)}`,
          ],
        });
        return;
      }
      let child: DriverChild;
      try {
        child = spawnFn(
          opts.execPath ?? process.execPath,
          [
            ...(opts.execArgv ?? process.execArgv),
            opts.script ?? process.argv[1]!,
            "scan",
            ...argv,
            "--foreground",
            "--json",
          ],
          {
            cwd: env.QCR_ROOT?.trim() || sandboxRoot(),
            detached: true,
            stdio: ["ignore", fd, fd, "ipc"],
            env,
          },
        );
      } catch (err) {
        closeSync(fd);
        resolve({
          ok: false,
          errors: [
            `the scan driver could not start: ${err instanceof Error ? err.message : String(err)}`,
          ],
        });
        return;
      }
      closeSync(fd);
      let settled = false;
      const done = (o: DetachOutcome): void => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        try {
          child.disconnect();
        } catch {
          // Already gone.
        }
        child.unref();
        resolve(o);
      };
      const timer = setTimeout(() => {
        child.kill("SIGTERM");
        done({
          ok: false,
          errors: [
            `the scan driver did not say it started within ${Math.round(timeoutMs / 1000)}s — it was stopped; see ${log}`,
          ],
        });
      }, timeoutMs);
      child.on("message", (m: unknown) => {
        const msg = m as { kind?: string; outcome?: DetachOutcome };
        if (msg.kind === "started" && msg.outcome) done(msg.outcome);
      });
      child.on("error", (err: Error) =>
        done({ ok: false, errors: [`the scan driver could not start: ${err.message}`] }),
      );
      child.on("exit", (code: number | null) =>
        done({
          ok: false,
          errors: [`the scan driver exited (code ${code ?? "?"}) before it started — see ${log}`],
        }),
      );
    });
}

/** Tell the launching process what the start did. Never throws, and never
 * leaves an unhandled 'error' behind when that process is gone (a Ctrl-C
 * during planning): the channel is checked, and a send that fails anyway
 * reports to its callback. The run goes on regardless. */
export function sendStarted(
  proc: {
    connected?: boolean;
    send?: (msg: unknown, cb: (err: Error | null) => void) => boolean;
  },
  outcome: DetachOutcome,
): void {
  if (!proc.send || proc.connected === false) return;
  try {
    proc.send({ kind: "started", outcome }, () => {});
  } catch {
    // The channel closed between the check and the send.
  }
}

/** A foreground driver's SIGINT/SIGTERM: the first stops the run (in-flight
 * cases aborted: a pi child is killed by the case runner, an SDK leaf session
 * is aborted and disposed in this process); a second kills the driver's whole
 * process group — any pi children with it — and exits. */
export function foregroundSignals(
  scan: Pick<ScanRunner, "stop">,
  io: { killGroup: () => void; exit: (code: number) => void; log: (line: string) => void },
): () => void {
  let seen = 0;
  return () => {
    seen++;
    if (seen === 1) {
      io.log("scan: stopping — signal again to kill it outright");
      scan.stop();
      return;
    }
    io.log("scan: killed");
    try {
      io.killGroup();
    } finally {
      io.exit(130);
    }
  };
}

/** `qcr scan …`: assemble the companion's scan belt over this machine's
 * state home and run one subcommand. */
export async function cmdScan(rest: string[], json: boolean): Promise<number> {
  const { buildEngine, sharedPorts, DEFAULT_REVIEWED_REPO } =
    await import("../extensions/setup.js");
  const { buildScan, watchTuiRequests, STAGE2_POLL_MS } =
    await import("../extensions/setup-scan.js");
  const env = scanEnv(process.env, DEFAULT_REVIEWED_REPO);
  const inSandbox = Boolean(env[IN_SANDBOX_ENV]?.trim());
  const shared = sharedPorts(env);
  const engine = buildEngine(env, shared, process.cwd());
  const home = stateHome(env);
  const { scan, findings, settingsOf, triage } = buildScan(
    engine,
    env.QCR_REVIEWED_REPO!,
    env,
    shared,
    null,
    // This process is the scan's disposable driver (or a one-shot CLI that
    // never runs a case): the one place scan leaves may be SDK sessions, loaded
    // on first use. The companion's pi builds its scan without this.
    async (o) => {
      const { scanSdkCases } = await import("./engine/caserunner-sdk.js");
      return scanSdkCases({ ...o, agentDir: join(home, SCAN_SDK_AGENT_DIR) });
    },
  );
  return runScanCli(rest, json, {
    scan,
    findings,
    settingsOf,
    triage,
    afterMatch: triage ? () => triage.closeFixed() : null,
    home,
    out: (line) => console.log(line),
    ...(inSandbox
      ? { detach: detachDriver(env, home), units: engine }
      : await sandboxPorts(env, home, engine, settingsOf)),
    sleep: (ms) => new Promise((r) => setTimeout(r, ms)),
    now: () => Date.now(),
    watchStops: (s) => {
      const unwatch = watchTuiRequests(s, STAGE2_POLL_MS, { stage2: false });
      const onSignal = foregroundSignals(s, {
        // A detached driver leads its own process group: the pi children
        // are in it. In a terminal the group is the shell's job, which the
        // terminal's Ctrl-C reaches whole already.
        killGroup: () => {
          try {
            process.kill(-process.pid, "SIGKILL");
          } catch {
            // Not a group leader: exit alone.
          }
        },
        exit: (code) => process.exit(code),
        log: (line) => console.error(line),
      });
      process.on("SIGINT", onSignal);
      process.on("SIGTERM", onSignal);
      return () => {
        unwatch();
        process.off("SIGINT", onSignal);
        process.off("SIGTERM", onSignal);
      };
    },
    onStart: (outcome) => {
      sendStarted(process, outcome);
      // Inside a scan sandbox: the launching host reads it from the state home.
      const file = env[STARTED_FILE_ENV]?.trim();
      if (file) {
        try {
          writeStartedFile(file, outcome);
        } catch (err) {
          console.error(`scan: the start outcome could not be written to ${file}: ${String(err)}`);
        }
      }
    },
  });
}

/** The host side of `[scan] sandbox`: the launch (a container for
 * `"docker"`, a host process for `"host"`), the doctor and the login. */
async function sandboxPorts(
  env: NodeJS.ProcessEnv,
  home: string,
  engine: UnitCutPort,
  settingsOf: () => { scan: { tier: string } } | null,
): Promise<Pick<ScanCliDeps, "detach" | "units" | "doctor" | "login" | "rebuild">> {
  const [
    { buildScanImage, dockerDetach, effectiveSandbox, scanDoctor, scanLoginRoute },
    companion,
    { appStamp },
    install,
    cfgMod,
  ] = await Promise.all([
    import("./scanbox.js"),
    import("./tui/companion.js"),
    import("./appstamp.js"),
    import("./install.js"),
    import("./config.js"),
  ]);
  let cfg: ReturnType<typeof loadConfig> | null = null;
  try {
    cfg = loadConfig();
  } catch {
    // No readable config: the sandbox defaults; a start then refuses for it.
  }
  const configured = cfg?.scan_sandbox ?? {
    ...cfgMod.SCAN_SANDBOX_DEFAULTS,
    pihome_volume: cfgMod.COMPANION_DEFAULTS.pihome_volume,
    image: cfgMod.SCAN_IMAGE_DEFAULT,
  };
  const docker = companion.realDockerRunner;
  // Inside the companion container an unset sandbox is the host: there is
  // no docker there, and the container is the sandbox already.
  const { sandbox, note } = await effectiveSandbox(configured, {
    env,
    exists: (p) => existsSync(p),
    docker,
  });
  const appRoot = env.QCR_ROOT?.trim() || sandboxRoot();
  // The checkout to mount: named by the env or `[companion]`, never the
  // in-container default (a host path is what docker mounts).
  const reviewedRepo =
    process.env.QCR_REVIEWED_REPO?.trim() || cfg?.companion.reviewed_repo_dir || "";
  // The model stage 1 runs on (the profile may move its tier): the login
  // the doctor's probe needs.
  const model = (): string => {
    const tiers: Record<string, string> = cfg?.models.tiers ?? {};
    const tier = settingsOf()?.scan.tier ?? cfg?.scan.tier ?? "";
    return tiers[tier] ?? cfg?.models.default ?? "";
  };
  const detach =
    sandbox.sandbox === "host"
      ? detachDriver(env, home)
      : dockerDetach<ScanRun>({
          docker,
          env,
          sandbox,
          reviewedRepo,
          appRoot,
          configSource: () => {
            const located = install.locateConfig({ env });
            return existsSync(located.path) ? located.path : undefined;
          },
          // The companion's own memory wiring: its network and key file.
          memory: async () =>
            cfg
              ? new companion.CompanionLifecycle(cfg.companion, docker, env).resolveMemoryWiring(
                  (note) => console.error(`scan sandbox: ${note}`),
                )
              : { network: "", endpoint: "", notes: [] },
        });
  return {
    detach,
    units: engine,
    doctor: () =>
      scanDoctor({
        sandbox,
        ...(note ? { note } : {}),
        docker,
        stamp: () => appStamp(appRoot),
        reviewedRepo,
        cut: () => {
          const st = engine.status();
          return { saved: st.saved !== null, problems: st.cut_file_unreadable ? st.problems : [] };
        },
        model: model(),
      }),
    rebuild: () =>
      buildScanImage({
        docker,
        image: sandbox.image,
        buildContext: cfg?.companion.build_context ?? appRoot,
        exists: (p) => existsSync(p),
        stamp: appStamp,
        onProgress: (line) => console.error(line),
      }),
    login: async (asked?: string) => {
      if (sandbox.sandbox === "host") {
        console.log(
          'scan login: [scan] sandbox = "host" — the scan runs this machine\'s `pi`; run `pi` and /login there.',
        );
        return 1;
      }
      const companionCfg = cfg?.companion ?? cfgMod.COMPANION_DEFAULTS;
      let route;
      try {
        route = await scanLoginRoute(docker, sandbox, companionCfg, asked?.trim() || undefined);
      } catch (e) {
        console.log((e as Error).message);
        return 1;
      }
      console.log(route.say);
      const r = spawnSync("docker", route.argv, { stdio: "inherit" });
      if (r.error) {
        console.log(`scan login: docker could not start: ${r.error.message}`);
        return 1;
      }
      return r.status ?? 1;
    },
  };
}
