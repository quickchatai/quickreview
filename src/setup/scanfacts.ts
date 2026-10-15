// What the scan adds to the repo portrait: after a scan, the portrait's facts carry
// what it FOUND — the last finished scan, the findings by unit and state, and
// the per-unit hotspots the companion wrote to scan memory — so a later
// re-tune (retune.ts) and the narrative both read the scan, not only the repo.
//
// Read from the state home's own scan records, never recomputed: the run
// record (scanrun.ts), the findings store (findings.ts) and the scan memory
// ledger (triage.ts). Counts only — no claim, no line, no fingerprint: the
// portrait is a summary, and individual findings stay in the findings store.
// A record that cannot be read makes the section UNKNOWN (and says why in the
// facts' problems), never "no findings".
import type { StateFs } from "./engine.js";
import { FindingsStore } from "./findings.js";
import type { PortraitScan, ScanUnitFacts } from "./portrait.js";
import { SEVERITIES } from "./scan.js";
import { isOpenFinding } from "./scanreport.js";
import { finishedRuns } from "./scanrun.js";
import { readScanMemory } from "./triage.js";

/**
 * The portrait's scan section, or null when nothing was ever scanned (no
 * finished run, no stored finding) — a portrait from before the first scan
 * is exactly what it was. `problems` lists the records that could not be read.
 */
export function scanFacts(state: StateFs): { scan: PortraitScan | null; problems: string[] } {
  const problems: string[] = [];
  const runs = finishedRuns(state);
  if (runs.error !== null) problems.push(runs.error);
  const stored = new FindingsStore(state).load();
  if (stored.error !== null) problems.push(stored.error);
  const memory = readScanMemory(state);
  if (memory.error !== null) problems.push(memory.error);
  const last = runs.runs[0] ?? null;
  if (problems.length === 0 && last === null && stored.findings.length === 0)
    return { scan: null, problems };

  const bySeverity: Record<string, number> = {};
  const units = new Map<string, ScanUnitFacts & { by: Set<string> }>();
  const totals = { open: 0, promoted: 0, dismissed: 0, fixed: 0, doubted: 0 };
  for (const f of stored.findings) {
    const u = units.get(f.unit) ?? {
      unit: f.unit,
      open: 0,
      promoted: 0,
      dismissed: 0,
      fixed: 0,
      doubted: 0,
      open_by: [],
      by: new Set<string>(),
    };
    units.set(f.unit, u);
    const open = isOpenFinding(f);
    if (open) {
      u.open++;
      totals.open++;
      bySeverity[f.severity] = (bySeverity[f.severity] ?? 0) + 1;
      u.by.add(`${f.severity} ${f.lens}`);
      if (f.doubt) {
        u.doubted++;
        totals.doubted++;
      }
    }
    if (f.state === "promoted" || f.state === "dismissed" || f.state === "fixed") {
      u[f.state]++;
      totals[f.state]++;
    }
  }
  const rank = (s: string): number => {
    const i = (SEVERITIES as readonly string[]).indexOf(s.split(" ")[0]!);
    return i < 0 ? SEVERITIES.length : i;
  };
  const unitFacts: ScanUnitFacts[] = [...units.values()]
    .sort((a, b) => a.unit.localeCompare(b.unit))
    .map(({ by, ...u }) => ({
      ...u,
      open_by: [...by].sort((a, b) => rank(a) - rank(b) || a.localeCompare(b)),
    }));

  // The latest hotspot per unit, across every scan that wrote one.
  const hot = new Map<string, { unit: string; text: string; sha: string; at: string }>();
  for (const [sha, rec] of Object.entries(memory.file.scans)) {
    for (const [unit, h] of Object.entries(rec?.hotspots ?? {})) {
      if (typeof h?.text !== "string") continue;
      const at = typeof h.at === "string" ? h.at : "";
      const cur = hot.get(unit);
      if (!cur || at > cur.at) hot.set(unit, { unit, text: h.text, sha, at });
    }
  }

  return {
    scan: {
      state: problems.length === 0 ? "ok" : "unreadable",
      last: last
        ? {
            id: last.id,
            mode: last.mode,
            sha: last.sha,
            state: last.state,
            finished_at: last.finished_at,
          }
        : null,
      findings: { ...totals, by_severity: bySeverity, units: unitFacts },
      hotspots: [...hot.values()].sort((a, b) => a.unit.localeCompare(b.unit)),
    },
    problems,
  };
}
