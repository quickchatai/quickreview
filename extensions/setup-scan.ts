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
//   - scan_findings: the stored findings, filterable.
//
// Convention (setup.ts, onboarding.ts): every tool answers a refusal as its
// result, never a throw.
import { join } from "node:path";
import type { PiToolDefinition, PiToolResult } from "@earendil-works/pi-coding-agent";
import { sandboxRoot } from "../src/config.js";
import { stateHome } from "../src/install.js";
import { piCaseRunner } from "../src/setup/caserunner.js";
import type { Refusal, SetupEngine } from "../src/setup/engine.js";
import type { FindingsFilter, FindingState, ScanFinding } from "../src/setup/findings.js";
import { FindingsStore } from "../src/setup/findings.js";
import { stateHomeFs } from "../src/setup/adapters.js";
import { SEVERITIES, type ScanSeverity } from "../src/setup/scan.js";
import { buildScanAgents, loadScanConfig, scanSettings, SCAN_AGENTS_DIR } from "../src/setup/scanbuild.js";
import { ScanRunner, type ScanPreview, type ScanStatus } from "../src/setup/scanrun.js";
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
  if (p.mode === "calibration") {
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
  if (p.blockers.length === 0) out.push(`To run it: scan_start with key ${p.key} and sha ${p.sha} — only after the operator agreed to the cost.`);
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
      `${r.id} (${r.mode}) at ${r.sha.slice(0, 12)}: ${r.display.toUpperCase()} — ${done}/${r.cases.length} cases, ` +
        `${findings} finding(s)${doubted ? ` (${doubted} may not be valid)` : ""}, spent ${usd(r.spent_usd)} of ${usd(r.cap_usd)}` +
        (r.unpriced_cases ? ` (${r.unpriced_cases} unpriced case(s) counted at their estimate)` : ""),
    );
    if (r.display === "interrupted") out.push("It was interrupted (the companion restarted). Preview and start again — the ledger resumes it.");
    if (r.display === "capped") out.push("It stopped at its hard cap. Preview again for the price of what is left.");
    const failed = r.cases.filter((c) => c.status === "failed");
    for (const c of failed.slice(0, 10)) out.push(`  ✗ ${c.id}: ${c.error}`);
    for (const p of r.problems.slice(-5)) out.push(`  ! ${p}`);
  }
  if (s.ledger) out.push(`Ledger: ${s.ledger.files} file(s) read by stage 1, ${usd(s.ledger.cost_usd)} recorded.`);
  return out.join("\n");
}

export function renderFindings(fs: readonly ScanFinding[], total: number): string {
  if (fs.length === 0) return "No stored scan findings match.";
  const rows = fs.map(
    (f) =>
      `- [${f.severity}] ${f.path}:${f.start === f.end ? f.start : `${f.start}-${f.end}`} (${f.unit}, ${f.kind}, ${f.state}` +
      `${f.doubt ? `, MAY NOT BE VALID — ${f.doubt.word}` : f.validated ? "" : ", unvalidated"}) ${f.claim} [${f.fingerprint.slice(0, 12)}]`,
  );
  if (total > fs.length) rows.push(`… ${total - fs.length} more — narrow the filter.`);
  return rows.join("\n");
}

// ---- tool belt ---------------------------------------------------------------

const SHA_PARAM = {
  type: "string",
  description: "The commit to scan: a sha or ref of the reviewed checkout (default HEAD). The tree AT that commit is read.",
} as const;

export function scanToolDefinitions(scan: ScanRunner, findings: FindingsStore): PiToolDefinition[] {
  const preview: PiToolDefinition = {
    name: "scan_preview",
    label: "Scan preview",
    description:
      "What scan stage 1 would read at a commit and what it would cost: pass-scan over every unit of the saved unit cut (tests, migrations, " +
      "excluded globs and files the coverage ledger already holds left out). On a repo never priced at these settings it offers the " +
      "CALIBRATION run instead — a few units, a small hard cap — whose measured cost prices every later preview. Free: it runs nothing. " +
      "Show the operator the cost before starting anything.",
    promptSnippet: "Preview a scan's cases and cost",
    parameters: { type: "object", properties: { sha: SHA_PARAM } },
    execute: async (_id, params) => {
      const r = await scan.preview({ sha: typeof params?.sha === "string" ? params.sha : undefined });
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
    parameters: { type: "object", properties: { key: { type: "string" }, sha: SHA_PARAM }, required: ["key"] },
    execute: async (_id, params) => {
      const r = await scan.start({ key: params?.key, sha: typeof params?.sha === "string" ? params.sha : undefined });
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
  return [preview, start, status, stop, list];
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
): { scan: ScanRunner; findings: FindingsStore } {
  const root = env.QCR_ROOT?.trim() || sandboxRoot();
  const home = stateHome(env);
  const state = stateHomeFs(home);
  const agentsDir = join(home, SCAN_AGENTS_DIR);
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
  return { scan, findings: new FindingsStore(state) };
}
