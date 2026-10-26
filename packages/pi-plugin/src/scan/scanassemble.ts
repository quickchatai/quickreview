// The scan engine, assembled over its host's ports: the reviewed checkout as
// a source of trees, the state home for every record, the saved unit cut, the
// config the scan runs with, the agent build, and a case runner over that
// build. Nothing here reads the process (its env, its cwd, its home) or any
// install's config file: a host hands each fact in.
//
// Two hosts build it:
//   - the app (extensions/setup-scan.ts `buildScan`): the companion's pi and
//     the `qcr scan` driver, over the live config.toml and the case runner the
//     scan sandbox or the host process runs (piCaseRunner, the driver's SDK
//     leaves);
//   - the pi plugin's /qcr-scan, over the person's config or the shipped
//     defaults, with its cases on SDK sessions in the person's own pi, each
//     behind the bash guard.
import { join } from "node:path";
import type { CoreConfig } from "../reviewconfig.js";
import type { ProfileLookup } from "../profiles.js";
import { FindingsStore } from "./findings.js";
import { stateHomeFs } from "./scanfs.js";
import type { CaseRunner, Refusal } from "./scanports.js";
import { buildScanAgents, scanSettings, SCAN_AGENTS_DIR } from "./scanagents.js";
import { fileLease, type ScanLease } from "./scanlease.js";
import { SCAN_TRANSCRIPTS_DIR, ScanRunner, type ScanSettings } from "./scanrun.js";
import { gitScanSource } from "./scantree.js";
import type { UnitCutStatusPort } from "./unitcutstore.js";

/** What a scan host hands the engine. */
export interface ScanHostPorts {
  /** The state home: the run record, the ledger, the findings, the trees, the
   * agent build and the transcripts all live under it. */
  home: string;
  /** The reviewed checkout, a git work tree, read-only. */
  reviewedRepo: string;
  /** The core's data root: `agents/` and `agents/scan/` are built from it. */
  root: string;
  /** The config the scan runs with, its profile applied (scanbuild.ts
   * `scanConfigOf`), read again at every call — or why there is none. */
  config: () => { ok: true; cfg: CoreConfig } | Refusal;
  /** Where the repo profile is looked up. */
  profiles: ProfileLookup;
  /** The saved unit cut and why there is none. */
  unitCut: UnitCutStatusPort;
  /** The case runner over the agent build in `agentsDir`, keeping each case's
   * event stream under `transcriptDir`; `stop` stops the run (a login a case
   * would not outlive, say) and says why. */
  cases: (o: {
    agentsDir: string;
    transcriptDir: string;
    stop: (reason: string) => void;
  }) => CaseRunner;
  /** The driver lease. Omitted: the state home's file lease, shared with
   * every other runner over it. */
  lease?: ScanLease | null;
  /** After a run's reconcile: close the tickets of the promoted findings it
   * found fixed. Omitted: nothing closes. */
  closeFixedTickets?: () => Promise<{ closed: readonly unknown[]; problems: readonly string[] }>;
  clock?: () => Date;
  /** One diagnostics line. */
  log: (line: string) => void;
}

/** The engine a host drives: the runner, its findings store and the settings
 * a run would take now (null when the config cannot be read). */
export interface AssembledScan {
  scan: ScanRunner;
  findings: FindingsStore;
  settingsOf: () => ScanSettings | null;
  home: string;
}

/** The scan engine over `p`. */
export function assembleScan(p: ScanHostPorts): AssembledScan {
  const { home, root } = p;
  const clock = p.clock ?? (() => new Date());
  const state = stateHomeFs(home);
  const agentsDir = join(home, SCAN_AGENTS_DIR);
  const settingsOf = (): ScanSettings | null => {
    const loaded = p.config();
    return loaded.ok ? scanSettings(loaded.cfg) : null;
  };
  const findings = new FindingsStore(state);
  const transcriptDir = join(home, SCAN_TRANSCRIPTS_DIR);
  // A token a case would not outlive stops the run, on any host.
  const stop = (reason: string): void => {
    p.log(`scan: stopping — ${reason}`);
    scan.stop();
  };
  const scan: ScanRunner = new ScanRunner({
    state,
    clock,
    cases: p.cases({ agentsDir, transcriptDir, stop }),
    source: gitScanSource(p.reviewedRepo, home),
    savedCut: () => {
      const cut = p.unitCut.savedCut();
      if (cut) return { ok: true, cut };
      const status = p.unitCut.status();
      return {
        ok: false,
        errors: status.cut_file_unreadable
          ? status.problems
          : ["no saved unit cut — a scan reads by unit; propose, adjust and save one first"],
      };
    },
    settings: () => {
      const loaded = p.config();
      return loaded.ok ? { ok: true, settings: scanSettings(loaded.cfg) } : loaded;
    },
    // At the depth the runner planned at — a stage-2 proposal's own, which
    // its `deep` may have set apart from `[scan] depth`.
    buildAgents: (settings) => {
      const loaded = p.config();
      if (!loaded.ok) return loaded;
      const cfg = { ...loaded.cfg, scan: { ...loaded.cfg.scan, depth: settings.scan.depth } };
      try {
        buildScanAgents(root, agentsDir, cfg, p.profiles);
        return { ok: true };
      } catch (err) {
        return { ok: false, errors: [err instanceof Error ? err.message : String(err)] };
      }
    },
    ...(p.closeFixedTickets ? { closeFixedTickets: p.closeFixedTickets } : {}),
    lease: p.lease ?? fileLease(home),
    log: p.log,
  });
  return { scan, findings, settingsOf, home };
}

/** The runner's runs, newest first, as the triage sees them: a run left
 * `running` by a driver that is gone reads as interrupted. */
export function scanRuns(scan: ScanRunner): Array<{ id: string; sha: string; state: string }> {
  const s = scan.status();
  const out: Array<{ id: string; sha: string; state: string }> = [];
  if (s.run) out.push({ id: s.run.id, sha: s.run.sha, state: s.run.display });
  for (const h of s.history)
    if (!out.some((r) => r.id === h.id)) out.push({ id: h.id, sha: h.sha, state: h.state });
  return out;
}
