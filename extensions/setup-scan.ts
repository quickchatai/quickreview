// setup-scan — the scan half of the companion's setup tool belt. Not an
// extension of its own: extensions/setup.ts (the one setup & scan extension)
// registers these beside the setup_* tools. The companion judges
// — when to scan, what to tell the operator about the price — and these
// tools act: every number, refusal and record is ScanRunner's.
//
//   - scan_preview: what stage 1 would read at a sha and what it costs — or,
//     on a repo never priced at these settings, the calibration run;
//   - scan_start: start exactly what a preview showed (its key), in the
//     background; hard stop at the estimate;
//   - scan_status / scan_stop: progress, and the stop (the ledger resumes);
//   - scan_findings: the stored findings, filterable;
//   - scan_matches / scan_match: the pending match question — the
//     findings a re-scan stopped reporting exactly, beside the fresh ones
//     that might be them — and the companion's whole answer to it.
//   - scan_suggestions: stage 1's deep-lens suggestions and the
//     lenses and tiers stage 2 may use — the companion's input;
//   - scan_stage2_propose: the companion's rows (file set × deep lens × tier,
//     reason) checked, tests paired, priced from the ledger and fitted to a
//     budget when given one — stored, so the TUI can show it. A DEEP proposal
//     (`[scan] depth = "deep"`, or `deep: true`; `deep: false` makes it
//     standard) adds the floor after them — every `[scan] deep_lenses` lens
//     over every file stage 1 reads — and the companion's rows may be none;
//   - scan_stage2_start: start the stored proposal by its key — or only the
//     runnable rows named in `rows`, stopped hard at their total — on the
//     operator's word. The TUI's click reaches the same start through
//     `watchTuiRequests` (the start channel, src/setup/stage2request.ts —
//     and the [8] scan tab's stop, src/setup/scanreport.ts).
//
// A delta re-scan is scan_preview / scan_start with `delta: true`: stage 1
// over the files whose content changed since the last scan, plus any file
// no complete reading covers yet (never read, cut short, unreadable before).
//
// Convention (setup.ts, onboarding.ts): every tool answers a refusal as its
// result, never a throw.
import {
  textResult as text,
  refusedResult as refused,
  type QcrTool,
} from "@quickchatai/pi-quickreview/extensions/pi-tool.js";
import { sandboxRoot } from "../src/config.js";
import { homeProfileLookup, stateHome } from "../src/install.js";
import { scanCasesForEnv } from "@quickchatai/pi-quickreview/src/engine/auth.js";
import { piCaseRunner } from "../src/setup/caserunner.js";
import type { CaseRunner, SetupEngine } from "../src/setup/engine.js";
import type { FindingsStore } from "../src/setup/findings.js";
import { stateHomeFs } from "../src/setup/adapters.js";
import { loadScanConfig } from "../src/setup/scanbuild.js";
import { assembleScan, scanRuns } from "../src/setup/scanassemble.js";
import {
  FINDINGS_LIMIT,
  FINDINGS_LIMIT_MAX,
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
  startedDetails,
  startedLine,
  stopScan,
  type StopChannel,
} from "../src/setup/scanrender.js";
import type { ScanRunner, ScanSettings } from "../src/setup/scanrun.js";
import { ScanTriage, type CloseFixedResult } from "../src/setup/triage.js";
import type { MemoryStore } from "../src/memory/store.js";
import type { TrackerSink } from "../src/setup/engine.js";
import type { ScanLease } from "../src/setup/scanlease.js";

const NO_PARAMS = { type: "object", properties: {} } as const;

// The rendering and the shared verbs are src/setup/scanrender.ts's, shared
// with `qcr scan` and the pi plugin's /qcr-scan.
export {
  CLI_VERBS,
  FINDINGS_LIMIT,
  FINDINGS_LIMIT_MAX,
  FINDING_STATES,
  STOP_POLL_MS,
  STOP_WAIT_MS,
  TOOL_VERBS,
  answerMatch,
  byValidity,
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
  startedDetails,
  startedLine,
  stopScan,
  type ScanVerbs,
  type StopChannel,
  type TicketsClosed,
} from "../src/setup/scanrender.js";

// ---- tool belt ---------------------------------------------------------------

const DELTA_PARAM = {
  type: "boolean",
  description:
    "A DELTA re-scan: the files whose content changed since the last scan, plus any not yet read whole (priced from the ledger; never before calibration).",
} as const;

const SHA_PARAM = {
  type: "string",
  description:
    "The commit to scan: a sha or ref of the reviewed checkout (default HEAD). The tree AT that commit is read.",
} as const;

export function scanToolDefinitions(
  scan: ScanRunner,
  findings: FindingsStore,
  settingsOf: () => ScanSettings | null = () => null,
  /** After a match answer: close the tickets of the promoted findings it
   * fixed (`ScanTriage.closeFixed`). */
  afterMatch: (() => Promise<CloseFixedResult>) | null = null,
  /** Where a stop of a run another process drives goes; null: only a run
   * this companion drives can be stopped. */
  stopChannel: StopChannel | null = null,
): QcrTool[] {
  const preview: QcrTool = {
    name: "scan_preview",
    label: "Scan preview",
    description:
      "What scan stage 1 would read at a commit and what it would cost: pass-scan over every unit of the saved unit cut (tests, migrations, " +
      "excluded globs and files the coverage ledger already holds left out). On a repo never priced at these settings it offers the " +
      "CALIBRATION run instead — a few units, a small hard cap — whose measured cost prices every later preview. Free: it runs nothing. " +
      'Under [scan] depth = "deep" it plans a DEEP stage 1: pass-scan names a deep lens for every file, and a file only a standard ' +
      "reading covers is read again. Show the operator the cost before starting anything.",
    promptSnippet: "Preview a scan's cases and cost",
    parameters: { type: "object", properties: { sha: SHA_PARAM, delta: DELTA_PARAM } },
    execute: async (_id, params) => {
      const r = await scan.preview({
        sha: typeof params?.sha === "string" ? params.sha : undefined,
        delta: params?.delta === true,
      });
      if (!r.ok) return refused("Scan preview", r);
      return text(renderPreview(r.preview), { preview: previewDetails(r.preview) });
    },
  };
  const start: QcrTool = {
    name: "scan_start",
    label: "Start a scan",
    description:
      "Start exactly the run a scan_preview showed — pass its key (and the same sha). It runs in the background as subagents and stops " +
      "HARD at the previewed estimate (the calibration cap for a calibration run). Refused if anything moved since the preview. Only after " +
      "the operator agreed to the cost ('do it').",
    promptSnippet: "Start the previewed scan",
    parameters: {
      type: "object",
      properties: { key: { type: "string" }, sha: SHA_PARAM, delta: DELTA_PARAM },
      required: ["key"],
    },
    execute: async (_id, params) => {
      const r = await scan.start({
        key: params?.key,
        sha: typeof params?.sha === "string" ? params.sha : undefined,
        delta: params?.delta === true,
      });
      if (!r.ok) return refused("Scan start", r);
      return text(startedLine(r.run), { run: startedDetails(r.run) });
    },
  };
  const status: QcrTool = {
    name: "scan_status",
    label: "Scan status",
    description:
      "The latest scan run — cases done, findings, spend against its hard cap — and the coverage ledger's totals.",
    promptSnippet: "Show the scan's progress",
    parameters: NO_PARAMS,
    execute: async () => {
      const s = scan.status();
      return text(renderStatus(s), {
        status: { ...s, run: s.run ? { ...s.run, cases: undefined } : null },
      });
    },
  };
  const stop: QcrTool = {
    name: "scan_stop",
    label: "Stop the scan",
    description:
      "Stop the running scan: in-flight cases are aborted, no more start. Finished cases stay in the ledger, so a later start resumes.",
    promptSnippet: "Stop the running scan",
    parameters: NO_PARAMS,
    execute: async () => {
      if (stopChannel !== null && !scan.status().active) {
        const via = await stopScan(scan, stopChannel);
        return via.ok ? text(via.answer) : refused("Scan stop", via);
      }
      const r = scan.stop();
      if (!r.ok) return refused("Scan stop", r);
      return text(
        `Stopping scan ${r.id}. What finished is kept; preview and start again to resume.`,
      );
    },
  };
  const list: QcrTool = {
    name: "scan_findings",
    label: "Scan findings",
    description:
      "The stored scan findings, grouped by the skeptic's validity tier — confirmed, then likely, then doubtful, then unknown (never " +
      "judged) — most severe first inside each, each with its fingerprint. A new finding marked LOOKS LIKE DISMISSED resembles one the " +
      "operator dismissed (named, with the reason) and sorts below its tier: it is NOT dismissed — put the resemblance to him, never " +
      "dismiss it on his behalf. Filter by validity (confirmed/likely/doubtful/unknown), state " +
      "(new/promoted/dismissed/fixed), lens, unit, severity, or doubted (true: only those marked 'may not be valid').",
    promptSnippet: "List stored scan findings",
    parameters: {
      type: "object",
      properties: {
        state: { type: "string" },
        lens: { type: "string" },
        unit: { type: "string" },
        severity: { type: "string" },
        doubted: { type: "boolean" },
        validity: { type: "string", description: "confirmed | likely | doubtful | unknown" },
        limit: { type: "number" },
      },
    },
    execute: async (_id, params) => {
      const p = params ?? {};
      const f = findingsFilter(p);
      if (!f.ok) return text(f.error);
      const listed = listFindings(findings, f.filter);
      if (!listed.ok) return text(`✗ ${listed.error}`);
      const fs = listed.findings;
      const limit =
        typeof p.limit === "number" && p.limit > 0
          ? Math.min(FINDINGS_LIMIT_MAX, Math.floor(p.limit))
          : FINDINGS_LIMIT;
      return text(renderFindings(fs.slice(0, limit), fs.length), {
        total: fs.length,
        validity: listed.validity,
      });
    },
  };
  const matches: QcrTool = {
    name: "scan_matches",
    label: "Scan match question",
    description:
      "The pending match question: findings a re-scan no longer reports exactly (their file changed or went away), beside the fresh " +
      "findings of the same lens that might be them moved or reworded. Exact fingerprints were matched already and anything no fresh " +
      "finding could be is fixed already — only these need your judgement.",
    promptSnippet: "Show findings waiting on a sameness call",
    parameters: NO_PARAMS,
    execute: async () => {
      const { question, error } = findings.question();
      if (error !== null) return text(`✗ ${error}`);
      return text(renderQuestion(question), { key: question?.key ?? null });
    },
  };
  const match: QcrTool = {
    name: "scan_match",
    label: "Answer the match question",
    description:
      "Answer the pending match question WHOLE: its key, and the pairs {old, new} (fingerprints) that are the same finding. A pair keeps " +
      "the old finding's state (dismissed stays dismissed, promoted stays promoted) under the new wording and position. Every unpaired " +
      "old finding becomes fixed (an unpaired dismissed finding stays dismissed); every unpaired fresh one stays new. An empty `pairs` means none are the same. Refused whole on a stale key.",
    promptSnippet: "Settle which re-scan findings are the same as old ones",
    parameters: {
      type: "object",
      properties: {
        key: { type: "string" },
        pairs: {
          type: "array",
          items: {
            type: "object",
            properties: { old: { type: "string" }, new: { type: "string" } },
            required: ["old", "new"],
          },
        },
      },
      required: ["key"],
    },
    execute: async (_id, params) => {
      const r = await answerMatch(
        findings,
        { key: params?.key, pairs: params?.pairs ?? [] },
        afterMatch,
      );
      if (!r.ok) return refused("Match", r);
      const { tickets, lines, ...result } = r;
      return text(lines.join("\n"), { ...result, tickets_closed: tickets?.closed.length ?? 0 });
    },
  };
  const suggestions: QcrTool = {
    name: "scan_suggestions",
    label: "Scan stage 2 suggestions",
    description:
      "Stage 1's stored deep-lens suggestions (lens, files, why) grouped by lens, and the deep lenses and tiers stage 2 may use on this " +
      "repo. Read them before proposing stage 2.",
    promptSnippet: "List stage 1's deep-lens suggestions",
    parameters: NO_PARAMS,
    execute: async () => {
      const { suggestions: sugs, error } = scan.suggestions();
      if (error !== null) return text(`✗ ${error}`);
      const s = settingsOf();
      return text(renderSuggestions(sugs, s), { suggestions: sugs.length });
    },
  };
  const propose: QcrTool = {
    name: "scan_stage2_propose",
    label: "Propose scan stage 2",
    description:
      "Propose stage 2 — the scan's deep, targeted plan — as rows: each a set of files, ONE deep lens, a tier (optional) and a one-line " +
      "reason, most valuable first. A row may span units (cross-cutting problems live between them). Name code only: each code file's " +
      "tests are paired in automatically. Give budget_usd to fit the plan to a budget (rows that do not fit are left out). Every row is " +
      "priced from the coverage ledger; the proposal is stored (the TUI shows it) and runs nothing. Refused as a whole if any row is bad. " +
      'A DEEP proposal ([scan] depth = "deep", or deep: true; deep: false makes it standard) adds the floor after your rows — every ' +
      "[scan] deep_lenses lens over every file stage 1 reads, priced and fitted like any row — so your rows may be none; every lens digs " +
      "past its row's files, and only a deep reading covers a file.",
    promptSnippet: "Propose a priced stage-2 plan",
    parameters: {
      type: "object",
      properties: {
        rows: {
          type: "array",
          items: {
            type: "object",
            properties: {
              lens: { type: "string" },
              files: { type: "array", items: { type: "string" } },
              tier: { type: "string" },
              reason: { type: "string" },
            },
            required: ["lens", "files", "reason"],
          },
        },
        budget_usd: { type: "number" },
        sha: SHA_PARAM,
        deep: {
          type: "boolean",
          description:
            "true: a DEEP proposal (the floor after your rows, every lens told to dig, coverage only from deep readings); false: a " +
            "standard one, no floor. Left out: [scan] depth decides.",
        },
      },
      required: ["rows"],
    },
    execute: async (_id, params) => {
      const r = await scan.proposeStage2({
        rows: params?.rows,
        budget_usd: params?.budget_usd,
        sha: typeof params?.sha === "string" ? params.sha : undefined,
        ...(params?.deep !== undefined ? { deep: params.deep } : {}),
      });
      if (!r.ok) return refused("Stage 2 proposal", r);
      return text(renderProposal(r.proposal), { proposal: proposalDetails(r.proposal) });
    },
  };
  const start2: QcrTool = {
    name: "scan_stage2_start",
    label: "Start scan stage 2",
    description:
      "Start the stored stage-2 proposal by its key — only after the operator agreed to its cost ('do it'). It runs in the background, " +
      "one case per row, and stops HARD at the proposal's estimate. Give rows (row ids from the proposal) to run only those — the " +
      "operator's narrowed 'do it' ('only the security rows'): each must be a runnable row, and the hard stop is their total. " +
      "Refused if the proposal moved since it was shown.",
    promptSnippet: "Start the proposed stage 2",
    parameters: {
      type: "object",
      properties: { key: { type: "string" }, rows: { type: "array", items: { type: "string" } } },
      required: ["key"],
    },
    execute: async (_id, params) => {
      // The engine validates `rows` (a list of runnable row ids, not empty —
      // `keptRows`, the TUI click's own rule) and re-plans before it starts.
      const r = await scan.startStage2({
        key: params?.key,
        ...(params?.rows !== undefined ? { rows: params.rows } : {}),
      });
      if (!r.ok) return refused("Stage 2 start", r);
      const runnable = scan.stage2Proposal().proposal?.runnable ?? null;
      const narrowed = params?.rows !== undefined && params?.rows !== null;
      return text(stage2StartedLine(r.run, runnable, narrowed), {
        run: startedDetails(r.run),
      });
    },
  };
  return [preview, start, status, stop, list, matches, match, suggestions, propose, start2];
}

/** How often the belt looks for the TUI's requests (a stage-2 start click,
 * a stop). */
export const STAGE2_POLL_MS = 2000;

/** Answer the TUI's requests while the companion runs: the stage-2 start
 * click starts the stored proposal it showed, exactly as the operator's word
 * would, and the `[8] scan` tab's stop stops the run it showed running,
 * exactly as scan_stop would. Returns the stop. */
export function watchTuiRequests(
  scan: ScanRunner,
  everyMs = STAGE2_POLL_MS,
  /** false: answer only the stop — a `qcr scan` driver leaves the stage-2
   * start click to the companion. */
  opts: { stage2?: boolean } = {},
): () => void {
  const timer = setInterval(() => {
    try {
      scan.consumeStopRequest();
    } catch (err) {
      console.error(`setup: scan stop request failed: ${String(err)}`);
    }
    if (opts.stage2 === false) return;
    scan
      .consumeStage2Request()
      .catch((err: unknown) =>
        console.error(`setup: stage 2 start request failed: ${String(err)}`),
      );
  }, everyMs);
  timer.unref?.();
  return () => clearInterval(timer);
}

// ---- assembly ------------------------------------------------------------------

/** Where the scan driver's SDK leaves come from: built on first use, by
 * whoever owns the process they run in (scancli's detached driver). */
export type SdkLeaves = (o: {
  agentsDir: string;
  cwd: string;
  transcriptDir: string;
  env: NodeJS.ProcessEnv;
  onExpired: (reason: string) => void;
}) => CaseRunner | Promise<CaseRunner>;

/** The scan leaf runner: the driver's SDK runner (`sdkLeaves`, built on first
 * use). A process that has none — the companion's own pi, which must never host
 * SDK sessions — refuses every case instead. The config is read per case, as
 * `settingsOf` reads the live config; an unreadable config runs the process
 * runner (`piCaseRunner`), the runner's behaviour before the key existed. */
export function scanLeafRunner(
  proc: CaseRunner,
  root: string,
  env: NodeJS.ProcessEnv,
  sdkLeaves?: () => CaseRunner | Promise<CaseRunner>,
): CaseRunner {
  let sdk: Promise<CaseRunner> | undefined;
  return {
    async run(spec, signal, onCost) {
      const loaded = loadScanConfig(root, env);
      // `[pi] lens_runtime` is not read here: a scan leaf is a leaf and never
      // gets a lens tool, so the key (engine by default) changes nothing.
      if (!loaded.ok) return proc.run(spec, signal, onCost);
      if (sdkLeaves === undefined)
        return {
          ok: false,
          reason:
            "[engine] runtime = sdk is not available on the scan route in this process: scan leaves run on the SDK only in the `qcr scan` driver",
          cost_usd: 0,
        };
      try {
        sdk ??= Promise.resolve(sdkLeaves());
        return (await sdk).run(spec, signal, onCost);
      } catch (err) {
        sdk = undefined;
        return {
          ok: false,
          reason: `the SDK leaf runner could not be built: ${err instanceof Error ? err.message : String(err)}`,
          cost_usd: 0,
        };
      }
    },
  };
}

/** The scan runner the companion's belt drives (src/setup/scanassemble.ts):
 * the reviewed checkout as a source of trees, the state home for every
 * record, the saved unit cut from the setup engine, the live config under the
 * profile, and a case runner over the scan agent build — and the triage over
 * its findings: reviewer memory and the tracker sink are the engine's own,
 * handed in. */
export function buildScan(
  engine: SetupEngine,
  reviewedRepo: string,
  env: NodeJS.ProcessEnv,
  shared: { memory: MemoryStore | null; tracker: TrackerSink } | null = null,
  /** The driver lease; default the state home's file lease, shared with every
   * other runner over it. */
  lease: ScanLease | null = null,
  /** The SDK leaf runner, in a process that may host one (scancli's detached
   * driver). Omitted — the companion's pi — a scan on `[engine] runtime = sdk`
   * refuses its cases. */
  sdkLeaves?: SdkLeaves,
): {
  scan: ScanRunner;
  findings: FindingsStore;
  settingsOf: () => ScanSettings | null;
  triage: ScanTriage | null;
  home: string;
} {
  const root = env.QCR_ROOT?.trim() || sandboxRoot();
  const home = stateHome(env);
  // Assigned below: the triage reads the runner's runs, the runner closes
  // the triage's tickets at every run's end.
  let triage: ScanTriage | null = null;
  const { scan, findings, settingsOf } = assembleScan({
    home,
    reviewedRepo,
    root,
    config: () => loadScanConfig(root, env),
    profiles: homeProfileLookup(env),
    unitCut: engine,
    // In the scan container: each case on a fresh refresh-disabled copy of
    // the companion's login; a token a case would not outlive stops the run.
    cases: ({ agentsDir, transcriptDir, stop }) =>
      scanCasesForEnv(
        scanLeafRunner(
          piCaseRunner({ agentsDir, cwd: root, transcriptDir }),
          root,
          env,
          sdkLeaves &&
            (() => sdkLeaves({ agentsDir, cwd: root, transcriptDir, env, onExpired: stop })),
        ),
        env,
        stop,
      ),
    closeFixedTickets: async () => (triage ? triage.closeFixed() : { closed: [], problems: [] }),
    lease,
    log: (line) => console.error(line),
  });
  if (shared) {
    triage = new ScanTriage({
      findings,
      state: stateHomeFs(home),
      memory: shared.memory,
      tracker: shared.tracker,
      clock: () => new Date(),
      units: () => engine.savedCut()?.units.map((u) => u.name) ?? null,
      runs: () => scanRuns(scan),
    });
  }
  return { scan, findings, settingsOf, triage, home };
}

export { scanRuns };
