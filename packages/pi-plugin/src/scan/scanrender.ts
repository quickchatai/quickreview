// The scan, rendered, and the verbs its surfaces share: what a companion tool
// (extensions/setup-scan.ts), its `qcr scan` subcommand and the pi plugin's
// /qcr-scan all answer — the checks, the orders and the structured results.
// Each surface names its own next step (`ScanVerbs`); none carries a rule of
// its own.
import { usd, findingLocation } from "./presentation.js";
import { FINDING_STATES } from "./findings.js";
import type {
  FindingsFilter,
  FindingState,
  MatchQuestionView,
  MatchResult,
  ScanFinding,
  ValidityView,
} from "./findings.js";
import {
  VALIDITY_ORDER,
  clickStopScan,
  readStopResult,
  scanStopOutcome,
  validityOf,
  type ScanStopRequest,
} from "./scanreport.js";
import { type FindingsStore, dismissedLookalike, lookalikeRank } from "./findings.js";
import { SEVERITIES, type ScanSeverity } from "./scan.js";
import { lensTiers, stage2Lenses, MAX_STAGE2_ROWS } from "./stage2.js";
import { priceIsMeasured, priceLabel, type StoredStage2Proposal } from "./stage2request.js";
import { escapeControls } from "./textsniff.js";
import {
  SCAN_TRANSCRIPTS_DIR,
  type ScanRunner,
  type ScanPreview,
  type ScanRun,
  type ScanSettings,
  type ScanStatus,
  type StoredSuggestion,
} from "./scanrun.js";

/** What closing the tickets of the findings a match fixed did: the tickets
 * closed, and the closes the tracker refused. A host with no tracker has no
 * such step. */
export interface TicketsClosed {
  closed: ReadonlyArray<{ ref: string }>;
  problems: readonly string[];
}

// ---- rendering ---------------------------------------------------------------

/** How a rendering names the next step: the companion's tools, or the
 * `qcr scan` CLI's subcommands — the same words around either. */
export interface ScanVerbs {
  /** How to start the previewed run. */
  start(p: Pick<ScanPreview, "key" | "sha" | "mode">): string;
  /** Where the pending match question is shown. */
  matches: string;
  /** How to answer the match question `key`: what precedes "that are the
   * SAME finding". */
  match(key: string): string;
  /** How to start the stored stage-2 proposal `key`, and only some of its rows. */
  stage2Start(key: string): string;
  /** The progress and stop verbs a start names. */
  status: string;
  stop: string;
}

export const TOOL_VERBS: ScanVerbs = {
  start: (p) =>
    `scan_start with key ${p.key} and sha ${p.sha}${p.mode === "delta" ? " and delta true" : ""}`,
  matches: "scan_matches",
  match: (key) => `scan_match: key ${key} and the pairs`,
  stage2Start: (key) =>
    `scan_stage2_start with key ${key} — only after the operator agreed to the cost ("do it"); the TUI's start click starts the same proposal. ` +
    `To run only some rows: add rows (their ids, e.g. ["row-1"]) — only runnable rows, and the run stops hard at their total.`,
  status: "scan_status",
  stop: "scan_stop",
};

export const CLI_VERBS: ScanVerbs = {
  start: (p) =>
    `qcr scan start --key ${p.key} --sha ${p.sha}${p.mode === "delta" ? " --delta" : ""}`,
  matches: "qcr scan matches",
  match: (key) => `qcr scan match --key ${key} OLD=NEW… — the pairs`,
  stage2Start: (key) =>
    `qcr scan stage2 start --key ${key} — only after the operator agreed to the cost; the TUI's start click starts the same proposal. ` +
    "To run only some rows: add --rows with their ids (e.g. --rows row-1,row-3) — only runnable rows, and the run stops hard at their total.",
  status: "qcr scan status",
  stop: "qcr scan stop",
};

/** A delta's unchanged-but-owed files: those no reading covers, and — on a
 * deep delta — those a standard reading covers but no deep one does yet. */
function owedClause(d: ScanPreview["delta"]): string {
  if (d === null || d.owed <= 0) return "";
  const shallow = Math.min(d.owed_shallow ?? 0, d.owed);
  const unread = d.owed - shallow;
  const parts: string[] = [];
  if (unread > 0)
    parts.push(
      `${unread} of the files are unchanged but no reading covers them yet (never read, cut short or unreadable before)`,
    );
  if (shallow > 0)
    parts.push(`${shallow} of the files are unchanged but not yet read at deep depth`);
  return `; ${parts.join("; ")} — read first`;
}

export function renderPreview(p: ScanPreview, verbs: ScanVerbs = TOOL_VERBS): string {
  const out: string[] = [];
  const deep = p.depth === "deep";
  const head = `${deep ? "(deep) " : ""}at ${p.sha.slice(0, 12)} — ${p.settings.tier} at ${p.settings.effort} effort, skeptic ${p.settings.validator ? `on (at the lens's tier, ${p.settings.validate_tier}; its cost is in the price)` : "off (findings stay unjudged — validity unknown)"}`;
  // A rate measured at the other depth stands in until this depth is priced.
  const across = p.rate_across_depth
    ? ` — from readings at the other depth: nothing at ${p.depth} depth is priced at these settings yet`
    : "";
  if (p.mode === "delta") {
    out.push(
      `DELTA re-scan ${head}, against the last scan at ${p.delta?.since.slice(0, 12) ?? "?"}.`,
      `Files whose content changed since, and any not yet read whole: ${p.files} files, ${p.lines} lines in ${p.cases.length} case(s) — ` +
        `${p.covered} already read at this content` +
        owedClause(p.delta) +
        `. Estimate ${usd(p.estimate_usd)}, measured at ` +
        `${usd(p.rate?.usd_per_kline ?? null)}/kline over ${p.rate?.cases ?? 0} finished case(s)${across}. The run stops hard at the estimate. ` +
        "No deep pass runs on a delta.",
    );
  } else if (p.mode === "calibration") {
    out.push(
      `CALIBRATION run ${head}.`,
      `No measured price for stage 1 at these settings yet (${p.calibration.measured} of ${p.calibration.wanted} priced cases). ` +
        `This run reads ${p.cases.length} case(s) from units spread across the size range and measures what they cost; ` +
        `it stops hard at ${usd(p.cap_usd)}. Its findings are real stage-1 findings. Preview again afterwards for the full estimate` +
        (p.remaining_cases > 0 ? ` (${p.remaining_cases} more case(s) after it).` : "."),
    );
  } else {
    out.push(
      `STAGE 1 ${head}.`,
      `Estimate ${usd(p.estimate_usd)} for ${p.cases.length} case(s), ${p.files} files, ${p.lines} lines — measured at ` +
        `${usd(p.rate?.usd_per_kline ?? null)}/kline over ${p.rate?.cases ?? 0} finished case(s)${across}. The run stops hard at the estimate.`,
    );
  }
  if (deep) {
    out.push(
      "DEEP: pass-scan names a deep lens for every focus file, and a file the ledger holds only a standard reading of is read again. " +
        "A deep stage 2 proposal then adds the floor — the [scan] deep_lenses over every file this stage reads.",
    );
  }
  const rows = p.cases
    .slice(0, 40)
    .map(
      (c) =>
        `  - ${c.id}: ${c.files.length} files, ${c.lines} lines${c.estimate_usd !== null ? `, ~${usd(c.estimate_usd)}` : ""}`,
    );
  if (p.cases.length > 40) rows.push(`  … and ${p.cases.length - 40} more`);
  out.push(rows.join("\n"));
  const skipped = Object.entries(p.excluded)
    .filter(([, n]) => n > 0)
    .map(([why, n]) => `${n} ${why}`);
  out.push(
    `Not read: ${skipped.length ? skipped.join(", ") : "nothing excluded"}; ${p.covered} already in the ledger at this content; ` +
      `${p.unreadable} unreadable${p.settings.exclude.length ? `; exclude globs ${p.settings.exclude.join(", ")}` : ""}.`,
  );
  // What the tree lists but no lens can read, by reason and by name — a
  // binary is REPORTED as skipped, never silently absent from coverage.
  const skippedBy = new Map<string, string[]>();
  for (const f of p.skipped ?? []) skippedBy.set(f.why, [...(skippedBy.get(f.why) ?? []), f.path]);
  for (const [why, paths] of skippedBy) {
    const label =
      why === "binary" ? "binary" : why === "too-big" ? "over the size cap" : "unreadable";
    out.push(
      `skipped: ${label} — ${paths.length} file(s): ${paths.slice(0, 5).map(escapeControls).join(", ")}${paths.length > 5 ? ", …" : ""}; not read by any lens.`,
    );
  }
  if (p.unassigned.length > 0) {
    out.push(
      `! ${p.unassigned.length} file(s) no unit owns at this sha (e.g. ${p.unassigned.slice(0, 3).join(", ")}) — the unit cut may need adjusting; they are not read.`,
    );
  }
  if (p.reconcile_only) {
    out.push(
      `Nothing to read, but ${p.reconcile_only}: the run reads no case and only reconciles the findings (no cost).`,
    );
  }
  for (const b of p.blockers) out.push(`✗ ${b}`);
  if (p.blockers.length === 0) {
    out.push(`To run it: ${verbs.start(p)} — only after the operator agreed to the cost.`);
  }
  return out.join("\n\n");
}

/** A run's findings by validity tier — `(2 confirmed, 1 likely, 3 doubtful)`
 * — from the per-case counts; `unknown` for what no skeptic judged (the
 * validator off or failed, or a case recorded before the tiers). */
function tierCounts(r: NonNullable<ScanStatus["run"]>, findings: number, doubted: number): string {
  if (!r.settings.validator)
    return doubted ? ` (${doubted} may not be valid)` : " (skeptic off — validity unknown)";
  const confirmed = r.cases.reduce((n, c) => n + (c.confirmed ?? 0), 0);
  const likely = r.cases.reduce((n, c) => n + (c.likely ?? 0), 0);
  const unknown = findings - confirmed - likely - doubted;
  if (findings === 0) return "";
  return ` (${confirmed} confirmed, ${likely} likely, ${doubted} doubtful${unknown > 0 ? `, ${unknown} unknown` : ""})`;
}

export function renderStatus(s: ScanStatus, verbs: ScanVerbs = TOOL_VERBS): string {
  const out: string[] = [];
  for (const p of s.problems) out.push(`✗ ${p}`);
  const r = s.run;
  if (r === null) {
    out.push(s.problems.length > 0 ? "Latest scan: UNKNOWN — see above." : "No scan has run yet.");
  } else {
    const done = r.cases.filter((c) => c.status === "done").length;
    const findings = r.cases.reduce((n, c) => n + c.findings, 0);
    const doubted = r.cases.reduce((n, c) => n + c.doubted, 0);
    out.push(
      `${r.id} (${r.mode === "stage2" ? "stage 2" : r.mode}${r.settings.depth === "deep" ? ", deep" : ""}) at ${r.sha.slice(0, 12)}: ${r.display.toUpperCase()} — ${done}/${r.cases.length} cases, ` +
        `${findings} finding(s)${tierCounts(r, findings, doubted)}, spent ${usd(r.spent_usd)} of ${usd(r.cap_usd)}` +
        (r.unpriced_cases
          ? ` (${r.unpriced_cases} unpriced case(s) counted at their estimate)`
          : ""),
    );
    // Stage 2 is re-entered by a new proposal (the rows already read are
    // covered, free); stage 1 by a new preview.
    const again = r.mode === "stage2" ? "Propose stage 2 again" : "Preview";
    if (r.display === "interrupted")
      out.push(
        `It was interrupted (the process driving it went away — the companion restarted, or a \`qcr scan\` driver died). ${again} and start again — the ledger resumes it.`,
      );
    if (r.display === "capped")
      out.push(`It stopped at its hard cap. ${again} for the price of what is left.`);
    if (r.mode === "stage2") {
      for (const c of r.cases.slice(0, 40)) {
        out.push(
          `  - ${c.id} ${c.lens ?? "?"} at ${c.tier ?? "?"} (${(c.units ?? [c.unit]).join(", ")}): ${c.status}, ${c.findings} finding(s), ${usd(c.cost_usd)}` +
            (c.reads !== undefined ? `, ${c.reads} read(s)` : "") +
            (c.unopened?.length ? `, ${c.unopened.length} focus file(s) not opened` : ""),
        );
      }
    }
    // Where to read back what a lens did, when the runner kept it.
    if (r.cases.some((c) => c.transcript !== undefined))
      out.push(
        `Transcripts: ${SCAN_TRANSCRIPTS_DIR}/${r.id}/ under the state home (one .jsonl per case, .validate.jsonl for its skeptic).`,
      );
    const failed = r.cases.filter((c) => c.status === "failed");
    for (const c of failed.slice(0, 10)) out.push(`  ✗ ${c.id}: ${c.error}`);
    for (const p of r.problems.slice(-5)) out.push(`  ! ${p}`);
    if (r.tickets_closed)
      out.push(`Tickets closed as fixed at ${r.sha.slice(0, 12)}: ${r.tickets_closed}.`);
    if (r.matching && (r.matching.fixed > 0 || r.matching.pending > 0)) {
      out.push(
        `Findings no longer reported: ${r.matching.fixed} fixed` +
          (r.matching.pending > 0
            ? `, ${r.matching.pending} waiting on your match (${verbs.matches})`
            : ""),
      );
    }
    // A dismissal is sticky: what would have been fixed is only stamped.
    const dismissedGone = r.matching?.dismissed_unreported ?? 0;
    if (dismissedGone > 0) {
      out.push(
        `Dismissed and no longer reported: ${dismissedGone} — kept dismissed (a scan never overwrites the operator's triage), stamped for audit.`,
      );
    }
    // A record written before the stamp existed has no count: nothing to say.
    const notReproduced = r.matching?.not_reproduced ?? 0;
    if (notReproduced > 0) {
      out.push(
        `Not reproduced: ${notReproduced} open finding(s) re-read at UNCHANGED content without being reported again — ` +
          "kept open (only changed code is fixed); dismiss any that were noise.",
      );
    }
  }
  if (s.ledger) {
    out.push(
      `Ledger: ${s.ledger.files} file(s) read by stage 1` +
        (s.ledger.deep_files ? `, ${s.ledger.deep_files} file × lens read by stage 2` : "") +
        `, ${usd(s.ledger.cost_usd)} recorded.`,
    );
  }
  return out.join("\n");
}

/** Findings in validity order — confirmed, likely, doubtful, unknown — the
 * store's order (most severe first) kept inside each tier, a finding that
 * looks like a dismissed one below the rest of its tier. */
export function byValidity(fs: readonly ScanFinding[]): ScanFinding[] {
  return VALIDITY_ORDER.flatMap((v) => {
    const tier = fs.filter((f) => validityOf(f) === v);
    return [
      ...tier.filter((f) => lookalikeRank(f) === 0),
      ...tier.filter((f) => lookalikeRank(f) === 1),
    ];
  });
}

/** A new finding that resembles one the operator dismissed: which, and why
 * — flagged for triage, never dismissed by the scan. */
function lookalikeNote(f: ScanFinding): string {
  const d = dismissedLookalike(f);
  return d
    ? `, LOOKS LIKE DISMISSED ${d.fingerprint.slice(0, 12)}: ${d.reason} — not auto-dismissed`
    : "";
}

function validityNote(f: ScanFinding): string {
  const v = validityOf(f);
  if (v === "doubtful")
    return `, DOUBTFUL — ${f.doubt?.word ?? "?"}${f.doubt?.class ? ` [${f.doubt.class}]` : ""}`;
  if (v === "unknown")
    return f.doubt
      ? `, MAY NOT BE VALID — ${f.doubt.word}`
      : f.validated
        ? ", validity unknown"
        : ", unvalidated";
  return `, ${v.toUpperCase()}`;
}

export function renderFindings(fs: readonly ScanFinding[], total: number): string {
  if (fs.length === 0) return "No stored scan findings match.";
  const rows = fs.map(
    (f) =>
      `- [${f.severity}] ${findingLocation(f)} (${f.unit}, ${f.kind}, ${f.state}` +
      validityNote(f) +
      `${f.capped_from ? `, ${f.capped_from}→${f.severity}: ${f.reachability}` : ""}` +
      `${f.anchor_quoted === false ? ", ANCHOR NOT QUOTED — the lines may not be the defect's" : ""}` +
      `${f.fixed ? ` at ${f.fixed.sha.slice(0, 12)}, was ${f.fixed.from}` : ""}` +
      `${f.state === "dismissed" && f.unreported ? `, no longer reported at ${f.unreported.sha.slice(0, 12)} — kept dismissed` : ""}` +
      `${f.not_reproduced ? `, NOT REPRODUCED by ${f.not_reproduced.count} re-read(s) of unchanged code, latest ${f.not_reproduced.run}` : ""}` +
      `${lookalikeNote(f)}) ` +
      `${f.claim} [${f.fingerprint.slice(0, 12)}]`,
  );
  if (total > fs.length) rows.push(`… ${total - fs.length} more — narrow the filter.`);
  return rows.join("\n");
}

export function renderQuestion(q: MatchQuestionView | null, verbs: ScanVerbs = TOOL_VERBS): string {
  if (q === null)
    return "No match question is pending: every finding a re-scan stopped reporting has been settled.";
  const row = (f: ScanFinding): string =>
    `  - ${f.fingerprint} [${f.severity}] ${findingLocation(f)} (${f.unit}, ${f.lens}, ${f.kind}` +
    `${f.state === "new" ? "" : `, ${f.state}`}${lookalikeNote(f)}) ${f.claim}`;
  return [
    `MATCH QUESTION ${q.key} (re-scan ${q.run} at ${q.sha.slice(0, 12)}).`,
    `No longer reported exactly (${q.unreported.length}):`,
    ...q.unreported.map(row),
    `Fresh — first seen by the re-scan, possibly one of the above moved or reworded (${q.fresh.length}):`,
    ...q.fresh.map(row),
    `Answer with ${verbs.match(q.key)} that are the SAME finding. Every unpaired old one becomes fixed (a dismissed one stays dismissed); every unpaired fresh one stays new.`,
  ].join("\n");
}

export function renderSuggestions(
  sugs: readonly StoredSuggestion[],
  settings: ScanSettings | null,
): string {
  const out: string[] = [];
  if (sugs.length === 0)
    out.push("No deep-lens suggestions stored — stage 1 has not suggested any yet.");
  else {
    const byLens = new Map<string, StoredSuggestion[]>();
    for (const s of sugs) byLens.set(s.lens, [...(byLens.get(s.lens) ?? []), s]);
    for (const [lens, ss] of [...byLens.entries()].sort(
      (a, b) => b[1].length - a[1].length || (a[0] < b[0] ? -1 : 1),
    )) {
      out.push(`${lens} (${ss.length}):`);
      for (const s of ss.slice(0, 30))
        out.push(`  - [${s.unit}] ${s.files.join(", ")} — ${s.reason} (at ${s.sha.slice(0, 12)})`);
      if (ss.length > 30) out.push(`  … and ${ss.length - 30} more`);
    }
  }
  if (settings) {
    const lenses = stage2Lenses(settings.lenses);
    out.push(
      "",
      `Stage 2 may run: ${lenses.map((l) => `${l} (${lensTiers(settings.lenses, l, settings.riskPasses ?? []).join("|")})`).join(", ")}.`,
      `One row reads at most ${settings.scan.case_max_files} files / ${settings.scan.case_max_lines} lines, paired tests included; at most ${MAX_STAGE2_ROWS} rows.`,
      settings.scan.depth === "deep"
        ? `Depth: deep — a proposal adds the floor after your rows (${settings.scan.deep_lenses.filter((l) => lenses.includes(l)).join(", ") || "no lens: every deep_lenses lens is switched off"} over every file stage 1 reads; not counted in the ${MAX_STAGE2_ROWS}), so your rows may be none. deep: false proposes a standard plan.`
        : "Depth: standard — deep: true on a proposal makes it deep (the floor, every lens told to dig).",
    );
  }
  return out.join("\n");
}

/** The floor's rows, one line per lens: its row ids, files, cost and what
 * the budget left out — the floor is bounded by the tree, so its rows are
 * summed, never listed one by one. */
function renderFloor(p: StoredStage2Proposal): string[] {
  const floor = p.rows.filter((r) => r.floor);
  const out: string[] = [];
  const lenses = [...new Set(floor.map((r) => r.lens))];
  for (const lens of lenses) {
    const rows = floor.filter((r) => r.lens === lens);
    const run = rows.filter((r) => r.status === "run");
    const over = rows.filter((r) => r.status === "over-budget");
    const covered = rows.filter((r) => r.status === "covered");
    const ids = rows.length === 1 ? rows[0]!.id : `${rows[0]!.id}…${rows[rows.length - 1]!.id}`;
    out.push(
      `  ${lens} (floor ${ids}) at ${rows[0]!.tier}: ${rows.length} row(s) over ${[...new Set(rows.flatMap((r) => r.units))].length} unit(s), ` +
        `${rows.reduce((n, r) => n + r.files.length, 0)} file(s), ${rows.reduce((n, r) => n + r.lines, 0)} lines — ` +
        `${run.length} to run, ~${usd(run.reduce((n, r) => n + r.estimate_usd, 0))} (${priceLabel(rows[0]!.price)})` +
        (covered.length ? `; ${covered.length} covered (free)` : "") +
        (over.length
          ? `; OVER BUDGET, left out: ${over.map((r) => r.id).join(", ")} (${usd(over.reduce((n, r) => n + r.estimate_usd, 0))})`
          : ""),
    );
  }
  const f = p.floor;
  if (f) {
    if (f.lenses.length === 0)
      out.push("  The floor has no lens: every [scan] deep_lenses lens is switched off.");
    if (f.skipped.length > 0)
      out.push(`  Switched off by the profile, no floor rows: ${f.skipped.join(", ")}.`);
    if (f.covered > 0 || f.named > 0)
      out.push(
        `  Left out of the floor: ${f.covered} file × lens already read deep at this content` +
          (f.named > 0 ? `, ${f.named} named by your rows for the same lens` : "") +
          ".",
      );
  }
  return out;
}

export function renderProposal(p: StoredStage2Proposal, verbs: ScanVerbs = TOOL_VERBS): string {
  const out: string[] = [];
  const run = p.rows.filter((r) => r.status === "run");
  const deep = p.depth === "deep";
  out.push(
    `STAGE 2 proposal ${deep ? "(deep) " : ""}at ${p.sha.slice(0, 12)} — ${run.length} row(s) to run, estimate ${usd(p.cap_usd)} (the run stops hard there)` +
      (p.budget_usd !== null ? `, fitted to a ${usd(p.budget_usd)} budget` : "") +
      `; validator ${p.validator ? "on" : "off"}.`,
  );
  if (deep) {
    const own = run.filter((r) => !r.floor);
    const floor = run.filter((r) => r.floor);
    const sum = (rs: readonly { estimate_usd: number }[]): number =>
      rs.reduce((n, r) => n + r.estimate_usd, 0);
    out.push(
      `DEEP: your rows ${own.length} to run, ~${usd(sum(own))}; the floor ${floor.length} to run, ~${usd(sum(floor))}. ` +
        "Every lens is told to dig past its row's files; a standard reading covers nothing here, and the floor runs after your rows (the budget fits them first).",
    );
  }
  const rows = p.rows
    .filter((r) => !r.floor)
    .map((r) => {
      const mark =
        r.status === "run"
          ? ""
          : r.status === "covered"
            ? " — COVERED (already read at this content, free)"
            : ` — OVER BUDGET (${usd(r.estimate_usd)}, left out)`;
      const price = priceLabel(r.price);
      return [
        `  ${r.id}: ${r.lens} at ${r.tier} over ${r.units.join(" + ")}${r.units.length > 1 ? " (cross-module)" : ""} — ${r.files.length} file(s)` +
          (r.tests.length ? ` + ${r.tests.length} paired test(s)` : "") +
          `, ${r.lines} lines, ~${usd(r.estimate_usd)} (${price})${mark}`,
        `      ${r.reason}`,
        `      files: ${r.files.map((f) => f.path).join(", ")}`,
        ...(r.tests.length ? [`      tests: ${r.tests.map((f) => f.path).join(", ")}`] : []),
        ...(r.unpaired.length ? [`      not paired (row full): ${r.unpaired.join(", ")}`] : []),
      ].join("\n");
    });
  if (rows.length > 0) out.push(rows.join("\n"));
  if (deep) out.push(["The deep floor:", ...renderFloor(p)].join("\n"));
  const priced = p.rows.filter((r) => r.status !== "covered");
  const measured = priced.filter((r) => priceIsMeasured(r.price)).length;
  if (priced.length > 0) {
    out.push(
      `Priced by measurement: ${measured} row(s); by estimate: ${priced.length - measured} row(s).` +
        (measured < priced.length
          ? " An estimate stands for this run once approved; the next proposal is priced from what the run measures."
          : ""),
    );
  }
  if (p.over_budget_usd > 0) out.push(`Left out by the budget: ${usd(p.over_budget_usd)} of rows.`);
  if (p.runnable > 0) {
    out.push(`To run it: ${verbs.stage2Start(p.key)}`);
  } else out.push("✗ nothing to run: every row is covered or over the budget.");
  return out.join("\n\n");
}

// ---- shared verbs ------------------------------------------------------------
//
// What a tool and its `qcr scan` subcommand (src/scancli.ts) both answer:
// the checks, the orders and the structured results. Each surface renders
// them its own way; neither carries a rule of its own.

/** A preview's structured result: its cases summarised (counts, not files). */
export function previewDetails(p: ScanPreview): Record<string, unknown> {
  return {
    ...p,
    cases: p.cases.map((c) => ({
      id: c.id,
      files: c.files.length,
      lines: c.lines,
      estimate_usd: c.estimate_usd,
    })),
  };
}

/** A started run, as a start answers it. */
export function startedDetails(run: ScanRun): {
  id: string;
  mode: ScanRun["mode"];
  sha: string;
  cases: number;
  cap_usd: number;
} {
  return {
    id: run.id,
    mode: run.mode,
    sha: run.sha,
    cases: run.cases.length,
    cap_usd: run.cap_usd,
  };
}

export { FINDING_STATES } from "./findings.js";
/** How many findings a listing shows unless told otherwise, and at most. */
export const FINDINGS_LIMIT = 50;
export const FINDINGS_LIMIT_MAX = 200;

/** A findings filter from loose parameters (a tool call's, the CLI's flags),
 * or what is wrong with one. */
export function findingsFilter(
  p: Record<string, unknown>,
): { ok: true; filter: FindingsFilter } | { ok: false; error: string } {
  const filter: FindingsFilter = {};
  if (typeof p.state === "string") {
    if (!(FINDING_STATES as readonly string[]).includes(p.state))
      return { ok: false, error: `Unknown state ${JSON.stringify(p.state)}.` };
    filter.state = p.state as FindingState;
  }
  if (typeof p.severity === "string") {
    if (!(SEVERITIES as readonly string[]).includes(p.severity))
      return { ok: false, error: `Unknown severity ${JSON.stringify(p.severity)}.` };
    filter.severity = p.severity as ScanSeverity;
  }
  if (typeof p.lens === "string") filter.lens = p.lens;
  if (typeof p.unit === "string") filter.unit = p.unit;
  if (typeof p.doubted === "boolean") filter.doubted = p.doubted;
  if (typeof p.validity === "string") {
    if (!(VALIDITY_ORDER as readonly string[]).includes(p.validity))
      return {
        ok: false,
        error: `Unknown validity ${JSON.stringify(p.validity)} — confirmed, likely, doubtful or unknown.`,
      };
    filter.validity = p.validity as ValidityView;
  }
  return { ok: true, filter };
}

/** The stored findings a filter keeps, in validity order (`byValidity`),
 * with the count in each tier — or why the store cannot be read. */
export function listFindings(
  findings: FindingsStore,
  filter: FindingsFilter,
):
  | { ok: true; findings: ScanFinding[]; validity: Record<ValidityView, number> }
  | { ok: false; error: string } {
  const { findings: listed, error } = findings.list(filter);
  if (error !== null) return { ok: false, error };
  const fs = byValidity(listed);
  const validity = Object.fromEntries(
    VALIDITY_ORDER.map((v) => [v, fs.filter((f) => validityOf(f) === v).length]),
  ) as Record<ValidityView, number>;
  return { ok: true, findings: fs, validity };
}

/** Answer the match question whole, then close the tickets of the promoted
 * findings it fixed — and the lines that say what was settled. */
export async function answerMatch(
  findings: FindingsStore,
  args: { key?: unknown; pairs?: unknown },
  afterMatch: (() => Promise<TicketsClosed>) | null,
): Promise<
  | Extract<MatchResult, { ok: false }>
  | (Extract<MatchResult, { ok: true }> & { tickets: TicketsClosed | null; lines: string[] })
> {
  const r = findings.match({ key: args.key, pairs: args.pairs ?? [] });
  if (!r.ok) return r;
  const lines = [
    `Settled: ${r.matched} matched (state kept), ${r.fixed} fixed, ${r.new} new` +
      (r.dismissed_unreported > 0
        ? `, ${r.dismissed_unreported} dismissed kept dismissed (stamped no longer reported)`
        : "") +
      ".",
  ];
  let tickets: TicketsClosed | null = null;
  if (afterMatch && r.fixed > 0) {
    tickets = await afterMatch();
    if (tickets.closed.length > 0)
      lines.push(`Closed as fixed: ${tickets.closed.map((c) => c.ref).join(", ")}.`);
    for (const p of tickets.problems) lines.push(`! ticket not closed: ${p}`);
  }
  return { ...r, tickets, lines };
}

/** A stored proposal's summary, as a propose answers it. */
export function proposalDetails(p: StoredStage2Proposal): {
  key: string;
  sha: string;
  cap_usd: number;
  runnable: number;
  rows: number;
  depth: "standard" | "deep";
  floor_rows: number;
  floor_usd: number;
} {
  const floor = p.rows.filter((x) => x.floor);
  return {
    key: p.key,
    sha: p.sha,
    cap_usd: p.cap_usd,
    runnable: p.runnable,
    rows: p.rows.length,
    depth: p.depth ?? "standard",
    floor_rows: floor.length,
    floor_usd: floor.filter((x) => x.status === "run").reduce((n, x) => n + x.estimate_usd, 0),
  };
}

/** The line a stage-2 start answers: how many rows run (of how many, when
 * narrowed), and the hard stop. */
export function stage2StartedLine(
  run: ScanRun,
  runnable: number | null,
  narrowed: boolean,
  verbs: ScanVerbs = TOOL_VERBS,
): string {
  const count =
    narrowed && runnable !== null
      ? `${run.cases.length} row(s) of ${runnable} (${run.cases.map((c) => c.id).join(", ")})`
      : `${run.cases.length} row(s)`;
  return (
    `Stage 2 ${run.id} started at ${run.sha.slice(0, 12)}: ${count}, hard stop ${usd(run.cap_usd)}. ` +
    `It runs in the background — ${verbs.status} shows progress, ${verbs.stop} stops it.`
  );
}

/** The line a stage-1 start answers. */
export function startedLine(run: ScanRun, verbs: ScanVerbs = TOOL_VERBS): string {
  return (
    `Scan ${run.id} (${run.mode}) started at ${run.sha.slice(0, 12)}: ${run.cases.length} case(s), hard stop ${usd(run.cap_usd)}. ` +
    `It runs in the background — ${verbs.status} shows progress, ${verbs.stop} stops it.`
  );
}

/** How often a stop through the channel looks for its answer, and how long
 * it waits for one. */
export const STOP_POLL_MS = 2000;
export const STOP_WAIT_MS = 15_000;

/** Where a stop of a run another process drives goes: the stop channel
 * under the state home, answered by whichever process holds the run. */
export interface StopChannel {
  home: string;
  by?: ScanStopRequest["by"];
  sleep?: (ms: number) => Promise<void>;
  now?: () => number;
}

/** Stop the recorded run: here when this runner drives it, else through the
 * stop channel the driving process answers — the companion, or a
 * `qcr scan` driver. No answer within STOP_WAIT_MS: nothing drives it. */
export async function stopScan(
  scan: ScanRunner,
  ch: StopChannel,
): Promise<{ ok: true; run: string; answer: string } | { ok: false; errors: string[] }> {
  const sleep = ch.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const now = ch.now ?? (() => Date.now());
  const s = scan.status();
  const run = s.run;
  if (run === null || run.state !== "running")
    return { ok: false, errors: ["no scan is recorded as running"] };
  if (s.active) {
    const r = scan.stop();
    if (!r.ok) return r;
    return { ok: true, run: r.id, answer: `scan ${r.id} stopped — what finished is in the ledger` };
  }
  const asked = clickStopScan(ch.home, run.id, new Date(now()), ch.by ?? "companion");
  if (!asked.ok) return { ok: false, errors: [asked.line] };
  const t0 = now();
  for (;;) {
    const answer = scanStopOutcome(ch.home, asked.request);
    if (answer !== null) {
      const read = readStopResult(ch.home);
      const ok =
        read.kind === "read" && read.result.request === asked.request && read.result.ok === true;
      return ok ? { ok: true, run: run.id, answer } : { ok: false, errors: [answer] };
    }
    if (now() - t0 >= STOP_WAIT_MS)
      return {
        ok: false,
        errors: [
          `no process answered the stop of ${run.id} within ${STOP_WAIT_MS / 1000}s — nothing is driving it ` +
            "(it reads as interrupted); preview and start again to resume",
        ],
      };
    await sleep(STOP_POLL_MS);
  }
}
