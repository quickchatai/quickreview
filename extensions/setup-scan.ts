// setup-scan — the SCAN half of the companion's setup tool belt.
// Not an extension of its own: extensions/setup.ts (the ONE setup & scan
// extension) registers these beside the setup_* tools. The companion judges
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
//     budget when given one — stored, so the TUI can show it;
//   - scan_stage2_start: start the stored proposal by its key, on the
//     operator's word. The TUI's click reaches the same start through
//     `watchStage2Requests` (the start channel, src/setup/stage2request.ts).
//
// A DELTA re-scan is scan_preview / scan_start with `delta: true`: stage 1
// over only the files whose content changed since the last scan.
//
// Convention (setup.ts, onboarding.ts): every tool answers a refusal as its
// result, never a throw.
import { join } from "node:path";
import type { PiToolDefinition, PiToolResult } from "@earendil-works/pi-coding-agent";
import { sandboxRoot } from "../src/config.js";
import { stateHome } from "../src/install.js";
import { piCaseRunner } from "../src/setup/caserunner.js";
import type { Refusal, SetupEngine } from "../src/setup/engine.js";
import type { FindingsFilter, FindingState, MatchQuestionView, ScanFinding } from "../src/setup/findings.js";
import { FindingsStore } from "../src/setup/findings.js";
import { stateHomeFs } from "../src/setup/adapters.js";
import { SEVERITIES, type ScanSeverity } from "../src/setup/scan.js";
import { lensTiers, stage2Lenses, MAX_STAGE2_ROWS } from "../src/setup/stage2.js";
import type { StoredStage2Proposal } from "../src/setup/stage2request.js";
import { buildScanAgents, loadScanConfig, scanSettings, SCAN_AGENTS_DIR } from "../src/setup/scanbuild.js";
import { ScanRunner, type ScanPreview, type ScanSettings, type ScanStatus, type StoredSuggestion } from "../src/setup/scanrun.js";
import { gitScanSource } from "../src/setup/scantree.js";

const NO_PARAMS = { type: "object", properties: {} } as const;

function text(t: string, details?: Record<string, unknown>): PiToolResult {
  return details ? { content: [{ type: "text", text: t }], details } : { content: [{ type: "text", text: t }] };
}

function refused(what: string, r: Refusal): PiToolResult {
  return text(`${what} refused:\n${r.errors.map((e) => `✗ ${e}`).join("\n")}`);
}

const usd = (n: number | null): string => (n === null ? "unknown" : `$${n.toFixed(2)}`);

// ---- rendering ---------------------------------------------------------------

export function renderPreview(p: ScanPreview): string {
  const out: string[] = [];
  const head = `at ${p.sha.slice(0, 12)} — ${p.settings.tier} at ${p.settings.effort} effort, validator ${p.settings.validator ? `on (${p.settings.validate_tier})` : "off"}`;
  if (p.mode === "delta") {
    out.push(
      `DELTA re-scan ${head}, against the last scan at ${p.delta?.since.slice(0, 12) ?? "?"}.`,
      `Only files whose content changed since: ${p.files} files, ${p.lines} lines in ${p.cases.length} case(s) — ` +
        `${p.covered} already read at this content` +
        (p.delta && p.delta.unchanged > 0 ? `; ${p.delta.unchanged} unchanged file(s) no scan has reached yet are left for an ordinary preview` : "") +
        `. Estimate ${usd(p.estimate_usd)}, measured at ` +
        `${usd(p.rate?.usd_per_kline ?? null)}/kline over ${p.rate?.cases ?? 0} finished case(s). The run stops hard at the estimate. ` +
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
        `${usd(p.rate?.usd_per_kline ?? null)}/kline over ${p.rate?.cases ?? 0} finished case(s). The run stops hard at the estimate.`,
    );
  }
  const rows = p.cases.slice(0, 40).map((c) => `  - ${c.id}: ${c.files.length} files, ${c.lines} lines${c.estimate_usd !== null ? `, ~${usd(c.estimate_usd)}` : ""}`);
  if (p.cases.length > 40) rows.push(`  … and ${p.cases.length - 40} more`);
  out.push(rows.join("\n"));
  const skipped = Object.entries(p.excluded)
    .filter(([, n]) => n > 0)
    .map(([why, n]) => `${n} ${why}`);
  out.push(
    `Not read: ${skipped.length ? skipped.join(", ") : "nothing excluded"}; ${p.covered} already in the ledger at this content; ` +
      `${p.unreadable} unreadable${p.settings.exclude.length ? `; exclude globs ${p.settings.exclude.join(", ")}` : ""}.`,
  );
  if (p.unassigned.length > 0) {
    out.push(`! ${p.unassigned.length} file(s) no unit owns at this sha (e.g. ${p.unassigned.slice(0, 3).join(", ")}) — the unit cut may need adjusting; they are not read.`);
  }
  for (const b of p.blockers) out.push(`✗ ${b}`);
  if (p.blockers.length === 0) {
    out.push(`To run it: scan_start with key ${p.key} and sha ${p.sha}${p.mode === "delta" ? " and delta true" : ""} — only after the operator agreed to the cost.`);
  }
  return out.join("\n\n");
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
      `${r.id} (${r.mode === "stage2" ? "stage 2" : r.mode}) at ${r.sha.slice(0, 12)}: ${r.display.toUpperCase()} — ${done}/${r.cases.length} cases, ` +
        `${findings} finding(s)${doubted ? ` (${doubted} may not be valid)` : ""}, spent ${usd(r.spent_usd)} of ${usd(r.cap_usd)}` +
        (r.unpriced_cases ? ` (${r.unpriced_cases} unpriced case(s) counted at their estimate)` : ""),
    );
    // Stage 2 is re-entered by a new proposal (the rows already read are
    // covered, free); stage 1 by a new preview.
    const again = r.mode === "stage2" ? "Propose stage 2 again" : "Preview";
    if (r.display === "interrupted") out.push(`It was interrupted (the companion restarted). ${again} and start again — the ledger resumes it.`);
    if (r.display === "capped") out.push(`It stopped at its hard cap. ${again} for the price of what is left.`);
    if (r.mode === "stage2") {
      for (const c of r.cases.slice(0, 40)) {
        out.push(`  - ${c.id} ${c.lens ?? "?"} at ${c.tier ?? "?"} (${(c.units ?? [c.unit]).join(", ")}): ${c.status}, ${c.findings} finding(s), ${usd(c.cost_usd)}`);
      }
    }
    const failed = r.cases.filter((c) => c.status === "failed");
    for (const c of failed.slice(0, 10)) out.push(`  ✗ ${c.id}: ${c.error}`);
    for (const p of r.problems.slice(-5)) out.push(`  ! ${p}`);
    if (r.matching && (r.matching.fixed > 0 || r.matching.pending > 0)) {
      out.push(
        `Findings no longer reported: ${r.matching.fixed} fixed` +
          (r.matching.pending > 0 ? `, ${r.matching.pending} waiting on your match (scan_matches)` : ""),
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

export function renderFindings(fs: readonly ScanFinding[], total: number): string {
  if (fs.length === 0) return "No stored scan findings match.";
  const rows = fs.map(
    (f) =>
      `- [${f.severity}] ${f.path}:${f.start === f.end ? f.start : `${f.start}-${f.end}`} (${f.unit}, ${f.kind}, ${f.state}` +
      `${f.doubt ? `, MAY NOT BE VALID — ${f.doubt.word}` : f.validated ? "" : ", unvalidated"}` +
      `${f.fixed ? ` at ${f.fixed.sha.slice(0, 12)}, was ${f.fixed.from}` : ""}) ${f.claim} [${f.fingerprint.slice(0, 12)}]`,
  );
  if (total > fs.length) rows.push(`… ${total - fs.length} more — narrow the filter.`);
  return rows.join("\n");
}

export function renderQuestion(q: MatchQuestionView | null): string {
  if (q === null) return "No match question is pending: every finding a re-scan stopped reporting has been settled.";
  const row = (f: ScanFinding): string =>
    `  - ${f.fingerprint} [${f.severity}] ${f.path}:${f.start === f.end ? f.start : `${f.start}-${f.end}`} (${f.unit}, ${f.lens}, ${f.kind}` +
    `${f.state === "new" ? "" : `, ${f.state}`}) ${f.claim}`;
  return [
    `MATCH QUESTION ${q.key} (re-scan ${q.run} at ${q.sha.slice(0, 12)}).`,
    `No longer reported exactly (${q.unreported.length}):`,
    ...q.unreported.map(row),
    `Fresh — first seen by the re-scan, possibly one of the above moved or reworded (${q.fresh.length}):`,
    ...q.fresh.map(row),
    `Answer with scan_match: key ${q.key} and the pairs that are the SAME finding. Every unpaired old one becomes fixed; every unpaired fresh one stays new.`,
  ].join("\n");
}

export function renderSuggestions(sugs: readonly StoredSuggestion[], settings: ScanSettings | null): string {
  const out: string[] = [];
  if (sugs.length === 0) out.push("No deep-lens suggestions stored — stage 1 has not suggested any yet.");
  else {
    const byLens = new Map<string, StoredSuggestion[]>();
    for (const s of sugs) byLens.set(s.lens, [...(byLens.get(s.lens) ?? []), s]);
    for (const [lens, ss] of [...byLens.entries()].sort((a, b) => b[1].length - a[1].length || (a[0] < b[0] ? -1 : 1))) {
      out.push(`${lens} (${ss.length}):`);
      for (const s of ss.slice(0, 30)) out.push(`  - [${s.unit}] ${s.files.join(", ")} — ${s.reason} (at ${s.sha.slice(0, 12)})`);
      if (ss.length > 30) out.push(`  … and ${ss.length - 30} more`);
    }
  }
  if (settings) {
    const lenses = stage2Lenses(settings.lenses);
    out.push(
      "",
      `Stage 2 may run: ${lenses.map((l) => `${l} (${lensTiers(settings.lenses, l, settings.riskPasses ?? []).join("|")})`).join(", ")}.`,
      `One row reads at most ${settings.scan.case_max_files} files / ${settings.scan.case_max_lines} lines, paired tests included; at most ${MAX_STAGE2_ROWS} rows.`,
    );
  }
  return out.join("\n");
}

export function renderProposal(p: StoredStage2Proposal): string {
  const out: string[] = [];
  const run = p.rows.filter((r) => r.status === "run");
  out.push(
    `STAGE 2 proposal at ${p.sha.slice(0, 12)} — ${run.length} row(s) to run, estimate ${usd(p.cap_usd)} (the run stops hard there)` +
      (p.budget_usd !== null ? `, fitted to a ${usd(p.budget_usd)} budget` : "") +
      `; validator ${p.validator ? "on" : "off"}.`,
  );
  const rows = p.rows.map((r) => {
    const mark = r.status === "run" ? "" : r.status === "covered" ? " — COVERED (already read at this content, free)" : ` — OVER BUDGET (${usd(r.estimate_usd)}, left out)`;
    const price = r.price.basis === "measured" ? "measured" : r.price.basis === "borrowed" ? `borrowed from ${r.price.from}` : `extrapolated from ${r.price.from}`;
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
  out.push(rows.join("\n"));
  if (p.over_budget_usd > 0) out.push(`Left out by the budget: ${usd(p.over_budget_usd)} of rows.`);
  if (p.runnable > 0) {
    out.push(
      `To run it: scan_stage2_start with key ${p.key} — only after the operator agreed to the cost ("do it"); the TUI's start click starts the same proposal.`,
    );
  } else out.push("✗ nothing to run: every row is covered or over the budget.");
  return out.join("\n\n");
}

// ---- tool belt ---------------------------------------------------------------

const DELTA_PARAM = {
  type: "boolean",
  description: "A DELTA re-scan: only the files whose content changed since the last scan (priced from the ledger; never before calibration).",
} as const;

const SHA_PARAM = {
  type: "string",
  description: "The commit to scan: a sha or ref of the reviewed checkout (default HEAD). The tree AT that commit is read.",
} as const;

export function scanToolDefinitions(
  scan: ScanRunner,
  findings: FindingsStore,
  settingsOf: () => ScanSettings | null = () => null,
): PiToolDefinition[] {
  const preview: PiToolDefinition = {
    name: "scan_preview",
    label: "Scan preview",
    description:
      "What scan stage 1 would read at a commit and what it would cost: pass-scan over every unit of the saved unit cut (tests, migrations, " +
      "excluded globs and files the coverage ledger already holds left out). On a repo never priced at these settings it offers the " +
      "CALIBRATION run instead — a few units, a small hard cap — whose measured cost prices every later preview. Free: it runs nothing. " +
      "Show the operator the cost before starting anything.",
    promptSnippet: "Preview a scan's cases and cost",
    parameters: { type: "object", properties: { sha: SHA_PARAM, delta: DELTA_PARAM } },
    execute: async (_id, params) => {
      const r = await scan.preview({ sha: typeof params?.sha === "string" ? params.sha : undefined, delta: params?.delta === true });
      if (!r.ok) return refused("Scan preview", r);
      return text(renderPreview(r.preview), { preview: { ...r.preview, cases: r.preview.cases.map((c) => ({ id: c.id, files: c.files.length, lines: c.lines, estimate_usd: c.estimate_usd })) } });
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
    parameters: { type: "object", properties: { key: { type: "string" }, sha: SHA_PARAM, delta: DELTA_PARAM }, required: ["key"] },
    execute: async (_id, params) => {
      const r = await scan.start({ key: params?.key, sha: typeof params?.sha === "string" ? params.sha : undefined, delta: params?.delta === true });
      if (!r.ok) return refused("Scan start", r);
      return text(
        `Scan ${r.run.id} (${r.run.mode}) started at ${r.run.sha.slice(0, 12)}: ${r.run.cases.length} case(s), hard stop ${usd(r.run.cap_usd)}. ` +
          "It runs in the background — scan_status shows progress, scan_stop stops it.",
        { run: { id: r.run.id, mode: r.run.mode, sha: r.run.sha, cases: r.run.cases.length, cap_usd: r.run.cap_usd } },
      );
    },
  };
  const status: PiToolDefinition = {
    name: "scan_status",
    label: "Scan status",
    description: "The latest scan run — cases done, findings, spend against its hard cap — and the coverage ledger's totals.",
    promptSnippet: "Show the scan's progress",
    parameters: NO_PARAMS,
    execute: async () => {
      const s = scan.status();
      return text(renderStatus(s), { status: { ...s, run: s.run ? { ...s.run, cases: undefined } : null } });
    },
  };
  const stop: PiToolDefinition = {
    name: "scan_stop",
    label: "Stop the scan",
    description: "Stop the running scan: in-flight cases are aborted, no more start. Finished cases stay in the ledger, so a later start resumes.",
    promptSnippet: "Stop the running scan",
    parameters: NO_PARAMS,
    execute: async () => {
      const r = scan.stop();
      if (!r.ok) return refused("Scan stop", r);
      return text(`Stopping scan ${r.id}. What finished is kept; preview and start again to resume.`);
    },
  };
  const list: PiToolDefinition = {
    name: "scan_findings",
    label: "Scan findings",
    description:
      "The stored scan findings, most severe first, each with its fingerprint. Filter by state (new/promoted/dismissed/fixed), lens, " +
      "unit, severity, or doubted (true: only those the validator marked 'may not be valid').",
    promptSnippet: "List stored scan findings",
    parameters: {
      type: "object",
      properties: {
        state: { type: "string" },
        lens: { type: "string" },
        unit: { type: "string" },
        severity: { type: "string" },
        doubted: { type: "boolean" },
        limit: { type: "number" },
      },
    },
    execute: async (_id, params) => {
      const p = params ?? {};
      const filter: FindingsFilter = {};
      if (typeof p.state === "string") {
        if (!["new", "promoted", "dismissed", "fixed"].includes(p.state)) return text(`Unknown state ${JSON.stringify(p.state)}.`);
        filter.state = p.state as FindingState;
      }
      if (typeof p.severity === "string") {
        if (!(SEVERITIES as readonly string[]).includes(p.severity)) return text(`Unknown severity ${JSON.stringify(p.severity)}.`);
        filter.severity = p.severity as ScanSeverity;
      }
      if (typeof p.lens === "string") filter.lens = p.lens;
      if (typeof p.unit === "string") filter.unit = p.unit;
      if (typeof p.doubted === "boolean") filter.doubted = p.doubted;
      const { findings: fs, error } = findings.list(filter);
      if (error !== null) return text(`✗ ${error}`);
      const limit = typeof p.limit === "number" && p.limit > 0 ? Math.min(200, Math.floor(p.limit)) : 50;
      return text(renderFindings(fs.slice(0, limit), fs.length), { total: fs.length });
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
          items: { type: "object", properties: { old: { type: "string" }, new: { type: "string" } }, required: ["old", "new"] },
        },
      },
      required: ["key"],
    },
    execute: async (_id, params) => {
      const r = findings.match({ key: params?.key, pairs: params?.pairs ?? [] });
      if (!r.ok) return refused("Match", r);
      return text(`Settled: ${r.matched} matched (state kept), ${r.fixed} fixed, ${r.new} new.`, { ...r });
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
      "priced from the coverage ledger; the proposal is stored (the TUI shows it) and runs nothing. Refused as a whole if any row is bad.",
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
      },
      required: ["rows"],
    },
    execute: async (_id, params) => {
      const r = await scan.proposeStage2({
        rows: params?.rows,
        budget_usd: params?.budget_usd,
        sha: typeof params?.sha === "string" ? params.sha : undefined,
      });
      if (!r.ok) return refused("Stage 2 proposal", r);
      return text(renderProposal(r.proposal), {
        proposal: { key: r.proposal.key, sha: r.proposal.sha, cap_usd: r.proposal.cap_usd, runnable: r.proposal.runnable, rows: r.proposal.rows.length },
      });
    },
  };
  const start2: PiToolDefinition = {
    name: "scan_stage2_start",
    label: "Start scan stage 2",
    description:
      "Start the stored stage-2 proposal by its key — only after the operator agreed to its cost ('do it'). It runs in the background, " +
      "one case per row, and stops HARD at the proposal's estimate. Refused if the proposal moved since it was shown.",
    promptSnippet: "Start the proposed stage 2",
    parameters: { type: "object", properties: { key: { type: "string" } }, required: ["key"] },
    execute: async (_id, params) => {
      const r = await scan.startStage2({ key: params?.key });
      if (!r.ok) return refused("Stage 2 start", r);
      return text(
        `Stage 2 ${r.run.id} started at ${r.run.sha.slice(0, 12)}: ${r.run.cases.length} row(s), hard stop ${usd(r.run.cap_usd)}. ` +
          "It runs in the background — scan_status shows progress, scan_stop stops it.",
        { run: { id: r.run.id, mode: r.run.mode, sha: r.run.sha, cases: r.run.cases.length, cap_usd: r.run.cap_usd } },
      );
    },
  };
  return [preview, start, status, stop, list, matches, match, suggestions, propose, start2];
}

/** How often the belt looks for the TUI's stage-2 start click. */
export const STAGE2_POLL_MS = 2000;

/** Answer the TUI's stage-2 start requests while the companion runs: the
 * click starts the stored proposal it showed, exactly as the operator's word
 * would. Returns the stop. */
export function watchStage2Requests(scan: ScanRunner, everyMs = STAGE2_POLL_MS): () => void {
  const timer = setInterval(() => {
    scan.consumeStage2Request().catch((err: unknown) => console.error(`setup: stage 2 start request failed: ${String(err)}`));
  }, everyMs);
  timer.unref?.();
  return () => clearInterval(timer);
}

// ---- assembly ------------------------------------------------------------------

/** The scan runner the companion's belt drives: the reviewed checkout as a
 * source of trees, the state home for every record, the saved unit cut from
 * the setup engine, the live config under the profile, and a case runner
 * over the scan agent build. */
export function buildScan(
  engine: SetupEngine,
  reviewedRepo: string,
  env: NodeJS.ProcessEnv = process.env,
): { scan: ScanRunner; findings: FindingsStore; settingsOf: () => ScanSettings | null } {
  const root = env.QCR_ROOT?.trim() || sandboxRoot();
  const home = stateHome(env);
  const state = stateHomeFs(home);
  const agentsDir = join(home, SCAN_AGENTS_DIR);
  const settingsOf = (): ScanSettings | null => {
    const loaded = loadScanConfig(root, env);
    return loaded.ok ? scanSettings(loaded.cfg) : null;
  };
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
        errors: status.cut_file_unreadable ? status.problems : ["no saved unit cut — a scan reads by unit; propose, adjust and save one first"],
      };
    },
    settings: () => {
      const loaded = loadScanConfig(root, env);
      return loaded.ok ? { ok: true, settings: scanSettings(loaded.cfg) } : loaded;
    },
    buildAgents: () => {
      const loaded = loadScanConfig(root, env);
      if (!loaded.ok) return loaded;
      try {
        buildScanAgents(root, agentsDir, loaded.cfg, { env });
        return { ok: true };
      } catch (err) {
        return { ok: false, errors: [err instanceof Error ? err.message : String(err)] };
      }
    },
    log: (line) => console.error(line),
  });
  return { scan, findings: new FindingsStore(state), settingsOf };
}
