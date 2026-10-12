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
import { join } from "node:path";
import type { PiToolDefinition, PiToolResult } from "@earendil-works/pi-coding-agent";
import { sandboxRoot } from "../src/config.js";
import { stateHome } from "../src/install.js";
import { piCaseRunner } from "../src/setup/caserunner.js";
import type { Refusal, SetupEngine } from "../src/setup/engine.js";
import type {
  FindingsFilter,
  FindingState,
  MatchQuestionView,
  ScanFinding,
  ValidityView,
} from "../src/setup/findings.js";
import { VALIDITY_ORDER, validityOf } from "../src/setup/scanreport.js";
import { FindingsStore, dismissedLookalike, lookalikeRank } from "../src/setup/findings.js";
import { stateHomeFs } from "../src/setup/adapters.js";
import { SEVERITIES, type ScanSeverity } from "../src/setup/scan.js";
import { lensTiers, stage2Lenses, MAX_STAGE2_ROWS } from "../src/setup/stage2.js";
import {
  priceIsMeasured,
  priceLabel,
  type StoredStage2Proposal,
} from "../src/setup/stage2request.js";
import {
  buildScanAgents,
  loadScanConfig,
  scanSettings,
  SCAN_AGENTS_DIR,
} from "../src/setup/scanbuild.js";
import { escapeControls } from "../src/setup/textsniff.js";
import {
  ScanRunner,
  type ScanPreview,
  type ScanSettings,
  type ScanStatus,
  type StoredSuggestion,
} from "../src/setup/scanrun.js";
import { gitScanSource } from "../src/setup/scantree.js";
import { ScanTriage, type CloseFixedResult } from "../src/setup/triage.js";
import type { MemoryStore } from "../src/memory/store.js";
import type { TrackerSink } from "../src/setup/engine.js";

const NO_PARAMS = { type: "object", properties: {} } as const;

function text(t: string, details?: Record<string, unknown>): PiToolResult {
  return details
    ? { content: [{ type: "text", text: t }], details }
    : { content: [{ type: "text", text: t }] };
}

function refused(what: string, r: Refusal): PiToolResult {
  return text(`${what} refused:\n${r.errors.map((e) => `✗ ${e}`).join("\n")}`);
}

const usd = (n: number | null): string => (n === null ? "unknown" : `$${n.toFixed(2)}`);

// ---- rendering ---------------------------------------------------------------

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

export function renderPreview(p: ScanPreview): string {
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
  for (const b of p.blockers) out.push(`✗ ${b}`);
  if (p.blockers.length === 0) {
    out.push(
      `To run it: scan_start with key ${p.key} and sha ${p.sha}${p.mode === "delta" ? " and delta true" : ""} — only after the operator agreed to the cost.`,
    );
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

export function renderStatus(s: ScanStatus): string {
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
        `It was interrupted (the companion restarted). ${again} and start again — the ledger resumes it.`,
      );
    if (r.display === "capped")
      out.push(`It stopped at its hard cap. ${again} for the price of what is left.`);
    if (r.mode === "stage2") {
      for (const c of r.cases.slice(0, 40)) {
        out.push(
          `  - ${c.id} ${c.lens ?? "?"} at ${c.tier ?? "?"} (${(c.units ?? [c.unit]).join(", ")}): ${c.status}, ${c.findings} finding(s), ${usd(c.cost_usd)}`,
        );
      }
    }
    const failed = r.cases.filter((c) => c.status === "failed");
    for (const c of failed.slice(0, 10)) out.push(`  ✗ ${c.id}: ${c.error}`);
    for (const p of r.problems.slice(-5)) out.push(`  ! ${p}`);
    if (r.tickets_closed)
      out.push(`Tickets closed as fixed at ${r.sha.slice(0, 12)}: ${r.tickets_closed}.`);
    if (r.matching && (r.matching.fixed > 0 || r.matching.pending > 0)) {
      out.push(
        `Findings no longer reported: ${r.matching.fixed} fixed` +
          (r.matching.pending > 0
            ? `, ${r.matching.pending} waiting on your match (scan_matches)`
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
      `- [${f.severity}] ${f.path}:${f.start === f.end ? f.start : `${f.start}-${f.end}`} (${f.unit}, ${f.kind}, ${f.state}` +
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

export function renderQuestion(q: MatchQuestionView | null): string {
  if (q === null)
    return "No match question is pending: every finding a re-scan stopped reporting has been settled.";
  const row = (f: ScanFinding): string =>
    `  - ${f.fingerprint} [${f.severity}] ${f.path}:${f.start === f.end ? f.start : `${f.start}-${f.end}`} (${f.unit}, ${f.lens}, ${f.kind}` +
    `${f.state === "new" ? "" : `, ${f.state}`}${lookalikeNote(f)}) ${f.claim}`;
  return [
    `MATCH QUESTION ${q.key} (re-scan ${q.run} at ${q.sha.slice(0, 12)}).`,
    `No longer reported exactly (${q.unreported.length}):`,
    ...q.unreported.map(row),
    `Fresh — first seen by the re-scan, possibly one of the above moved or reworded (${q.fresh.length}):`,
    ...q.fresh.map(row),
    `Answer with scan_match: key ${q.key} and the pairs that are the SAME finding. Every unpaired old one becomes fixed; every unpaired fresh one stays new.`,
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

export function renderProposal(p: StoredStage2Proposal): string {
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
    out.push(
      `To run it: scan_stage2_start with key ${p.key} — only after the operator agreed to the cost ("do it"); the TUI's start click starts the same proposal. ` +
        `To run only some rows: add rows (their ids, e.g. ["row-1"]) — only runnable rows, and the run stops hard at their total.`,
    );
  } else out.push("✗ nothing to run: every row is covered or over the budget.");
  return out.join("\n\n");
}

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
): PiToolDefinition[] {
  const preview: PiToolDefinition = {
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
      return text(renderPreview(r.preview), {
        preview: {
          ...r.preview,
          cases: r.preview.cases.map((c) => ({
            id: c.id,
            files: c.files.length,
            lines: c.lines,
            estimate_usd: c.estimate_usd,
          })),
        },
      });
    },
  };
  const start: PiToolDefinition = {
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
      return text(
        `Scan ${r.run.id} (${r.run.mode}) started at ${r.run.sha.slice(0, 12)}: ${r.run.cases.length} case(s), hard stop ${usd(r.run.cap_usd)}. ` +
          "It runs in the background — scan_status shows progress, scan_stop stops it.",
        {
          run: {
            id: r.run.id,
            mode: r.run.mode,
            sha: r.run.sha,
            cases: r.run.cases.length,
            cap_usd: r.run.cap_usd,
          },
        },
      );
    },
  };
  const status: PiToolDefinition = {
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
  const stop: PiToolDefinition = {
    name: "scan_stop",
    label: "Stop the scan",
    description:
      "Stop the running scan: in-flight cases are aborted, no more start. Finished cases stay in the ledger, so a later start resumes.",
    promptSnippet: "Stop the running scan",
    parameters: NO_PARAMS,
    execute: async () => {
      const r = scan.stop();
      if (!r.ok) return refused("Scan stop", r);
      return text(
        `Stopping scan ${r.id}. What finished is kept; preview and start again to resume.`,
      );
    },
  };
  const list: PiToolDefinition = {
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
      const filter: FindingsFilter = {};
      if (typeof p.state === "string") {
        if (!["new", "promoted", "dismissed", "fixed"].includes(p.state))
          return text(`Unknown state ${JSON.stringify(p.state)}.`);
        filter.state = p.state as FindingState;
      }
      if (typeof p.severity === "string") {
        if (!(SEVERITIES as readonly string[]).includes(p.severity))
          return text(`Unknown severity ${JSON.stringify(p.severity)}.`);
        filter.severity = p.severity as ScanSeverity;
      }
      if (typeof p.lens === "string") filter.lens = p.lens;
      if (typeof p.unit === "string") filter.unit = p.unit;
      if (typeof p.doubted === "boolean") filter.doubted = p.doubted;
      if (typeof p.validity === "string") {
        if (!(VALIDITY_ORDER as readonly string[]).includes(p.validity)) {
          return text(
            `Unknown validity ${JSON.stringify(p.validity)} — confirmed, likely, doubtful or unknown.`,
          );
        }
        filter.validity = p.validity as ValidityView;
      }
      const { findings: listed, error } = findings.list(filter);
      if (error !== null) return text(`✗ ${error}`);
      const fs = byValidity(listed);
      const limit =
        typeof p.limit === "number" && p.limit > 0 ? Math.min(200, Math.floor(p.limit)) : 50;
      const tiers = Object.fromEntries(
        VALIDITY_ORDER.map((v) => [v, fs.filter((f) => validityOf(f) === v).length]),
      );
      return text(renderFindings(fs.slice(0, limit), fs.length), {
        total: fs.length,
        validity: tiers,
      });
    },
  };
  const matches: PiToolDefinition = {
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
  const match: PiToolDefinition = {
    name: "scan_match",
    label: "Answer the match question",
    description:
      "Answer the pending match question WHOLE: its key, and the pairs {old, new} (fingerprints) that are the same finding. A pair keeps " +
      "the old finding's state (dismissed stays dismissed, promoted stays promoted) under the new wording and position. Every unpaired " +
      "old finding becomes fixed; every unpaired fresh one stays new. An empty `pairs` means none are the same. Refused whole on a stale key.",
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
      const r = findings.match({ key: params?.key, pairs: params?.pairs ?? [] });
      if (!r.ok) return refused("Match", r);
      const out = [
        `Settled: ${r.matched} matched (state kept), ${r.fixed} fixed, ${r.new} new` +
          (r.dismissed_unreported > 0
            ? `, ${r.dismissed_unreported} dismissed kept dismissed (stamped no longer reported)`
            : "") +
          ".",
      ];
      let tickets: CloseFixedResult | null = null;
      if (afterMatch && r.fixed > 0) {
        tickets = await afterMatch();
        if (tickets.closed.length > 0)
          out.push(`Closed as fixed: ${tickets.closed.map((c) => c.ref).join(", ")}.`);
        for (const p of tickets.problems) out.push(`! ticket not closed: ${p}`);
      }
      return text(out.join("\n"), { ...r, tickets_closed: tickets?.closed.length ?? 0 });
    },
  };
  const suggestions: PiToolDefinition = {
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
  const propose: PiToolDefinition = {
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
      const floor = r.proposal.rows.filter((x) => x.floor);
      return text(renderProposal(r.proposal), {
        proposal: {
          key: r.proposal.key,
          sha: r.proposal.sha,
          cap_usd: r.proposal.cap_usd,
          runnable: r.proposal.runnable,
          rows: r.proposal.rows.length,
          depth: r.proposal.depth ?? "standard",
          floor_rows: floor.length,
          floor_usd: floor
            .filter((x) => x.status === "run")
            .reduce((n, x) => n + x.estimate_usd, 0),
        },
      });
    },
  };
  const start2: PiToolDefinition = {
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
      const count =
        narrowed && runnable !== null
          ? `${r.run.cases.length} row(s) of ${runnable} (${r.run.cases.map((c) => c.id).join(", ")})`
          : `${r.run.cases.length} row(s)`;
      return text(
        `Stage 2 ${r.run.id} started at ${r.run.sha.slice(0, 12)}: ${count}, hard stop ${usd(r.run.cap_usd)}. ` +
          "It runs in the background — scan_status shows progress, scan_stop stops it.",
        {
          run: {
            id: r.run.id,
            mode: r.run.mode,
            sha: r.run.sha,
            cases: r.run.cases.length,
            cap_usd: r.run.cap_usd,
          },
        },
      );
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
export function watchTuiRequests(scan: ScanRunner, everyMs = STAGE2_POLL_MS): () => void {
  const timer = setInterval(() => {
    try {
      scan.consumeStopRequest();
    } catch (err) {
      console.error(`setup: scan stop request failed: ${String(err)}`);
    }
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

/** The scan runner the companion's belt drives: the reviewed checkout as a
 * source of trees, the state home for every record, the saved unit cut from
 * the setup engine, the live config under the profile, and a case runner
 * over the scan agent build — and the triage over its findings:
 * reviewer memory and the tracker sink are the engine's own, handed in. */
export function buildScan(
  engine: SetupEngine,
  reviewedRepo: string,
  env: NodeJS.ProcessEnv = process.env,
  shared: { memory: MemoryStore | null; tracker: TrackerSink } | null = null,
): {
  scan: ScanRunner;
  findings: FindingsStore;
  settingsOf: () => ScanSettings | null;
  triage: ScanTriage | null;
} {
  const root = env.QCR_ROOT?.trim() || sandboxRoot();
  const home = stateHome(env);
  const state = stateHomeFs(home);
  const agentsDir = join(home, SCAN_AGENTS_DIR);
  const settingsOf = (): ScanSettings | null => {
    const loaded = loadScanConfig(root, env);
    return loaded.ok ? scanSettings(loaded.cfg) : null;
  };
  const findings = new FindingsStore(state);
  // Assigned below: the triage reads the runner's runs, the runner closes
  // the triage's tickets at every run's end.
  let triage: ScanTriage | null = null;
  const scan = new ScanRunner({
    state,
    clock: () => new Date(),
    cases: piCaseRunner({ agentsDir, cwd: root }),
    source: gitScanSource(reviewedRepo, home),
    savedCut: () => {
      const cut = engine.savedCut();
      if (cut) return { ok: true, cut };
      const status = engine.status();
      return {
        ok: false,
        errors: status.cut_file_unreadable
          ? status.problems
          : ["no saved unit cut — a scan reads by unit; propose, adjust and save one first"],
      };
    },
    settings: () => {
      const loaded = loadScanConfig(root, env);
      return loaded.ok ? { ok: true, settings: scanSettings(loaded.cfg) } : loaded;
    },
    // At the depth the runner planned at — a stage-2 proposal's own, which
    // its `deep` may have set apart from `[scan] depth`.
    buildAgents: (settings) => {
      const loaded = loadScanConfig(root, env);
      if (!loaded.ok) return loaded;
      const cfg = { ...loaded.cfg, scan: { ...loaded.cfg.scan, depth: settings.scan.depth } };
      try {
        buildScanAgents(root, agentsDir, cfg, { env });
        return { ok: true };
      } catch (err) {
        return { ok: false, errors: [err instanceof Error ? err.message : String(err)] };
      }
    },
    closeFixedTickets: async () => (triage ? triage.closeFixed() : { closed: [], problems: [] }),
    log: (line) => console.error(line),
  });
  if (shared) {
    triage = new ScanTriage({
      findings,
      state,
      memory: shared.memory,
      tracker: shared.tracker,
      clock: () => new Date(),
      units: () => engine.savedCut()?.units.map((u) => u.name) ?? null,
      runs: () => scanRuns(scan),
    });
  }
  return { scan, findings, settingsOf, triage };
}

/** The runner's runs, newest first, as the triage sees them: a run left
 * `running` by a companion that is gone reads as interrupted. */
export function scanRuns(scan: ScanRunner): Array<{ id: string; sha: string; state: string }> {
  const s = scan.status();
  const out: Array<{ id: string; sha: string; state: string }> = [];
  if (s.run) out.push({ id: s.run.id, sha: s.run.sha, state: s.run.display });
  for (const h of s.history)
    if (!out.some((r) => r.id === h.id)) out.push({ id: h.id, sha: h.sha, state: h.state });
  return out;
}
