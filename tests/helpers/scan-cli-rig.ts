// A scan runner over faked ports and a temp state home, for the `qcr scan`
// CLI and the driver lease: two units (app, lib), one finding per case, the
// first preview a calibration run. `hang` makes the named units' cases wait
// for their abort, so a run stays in flight while a test looks at it.
import { join } from "node:path";
import { SCAN_DEFAULTS } from "../../src/config.js";
import { stateHomeFs } from "../../src/setup/adapters.js";
import type { CaseOutcome, CaseSpec } from "../../src/setup/engine.js";
import { FindingsStore } from "../../src/setup/findings.js";
import { fileLease, type ScanLease } from "../../src/setup/scanlease.js";
import { ScanRunner, type ScanSettings } from "../../src/setup/scanrun.js";

export const SHA = "a".repeat(40);
export const SHA2 = "b".repeat(40);
export const FILES: Record<string, string> = {
  "app/a.py": "one\ntwo\nthree\n",
  "lib/b.py": "x\ny\n",
  "lib/tests/test_b.py": "t\n",
};

export interface Rig {
  scan: ScanRunner;
  findings: FindingsStore;
  settingsOf: () => ScanSettings;
  lease: ScanLease;
  home: string;
  /** Move this rig's clock forward. */
  advance(ms: number): void;
  /** What the runner logged. */
  logs: string[];
  /** How often the run's end asked to close fixed tickets. */
  closeFixedCalls(): number;
}

export function scanRig(opts: {
  dir: string;
  trees?: Record<string, Record<string, string>>;
  head?: string;
  hang?: (spec: CaseSpec) => boolean;
  /** A lease port; omitted, the rig holds its own file lease. */
  lease?: ScanLease | null;
  holder?: string;
  /** Shared across rigs over one state home, so two runners agree on time. */
  clock?: { t: number };
  /** Called while a start plans (from the saved-cut port). */
  duringPlan?: () => void;
}): Rig {
  const trees = opts.trees ?? { [SHA]: FILES };
  const head = opts.head ?? SHA;
  const home = join(opts.dir, "state");
  const state = stateHomeFs(home);
  const time = opts.clock ?? { t: Date.parse("2026-09-29T10:00:00Z") };
  // Advancing: a run's id is its start second, and two runs must differ.
  const clock = (): Date => {
    time.t += 1000;
    return new Date(time.t);
  };
  const listOf = (sha: string) =>
    Object.keys(trees[sha] ?? {}).map((path) => ({
      path,
      blob: `b-${path}-${JSON.stringify(trees[sha]![path])}`,
    }));
  const lease =
    opts.lease === undefined
      ? fileLease(home, {
          clock: () => new Date(time.t),
          ...(opts.holder ? { holder: opts.holder } : {}),
        })
      : opts.lease;
  const logs: string[] = [];
  let closeFixed = 0;
  const settings: ScanSettings = {
    scan: { ...SCAN_DEFAULTS, validator: false },
    riskPasses: ["pass-data-safety"],
  };
  const scan = new ScanRunner({
    state,
    clock,
    cases: {
      run: (spec: CaseSpec, signal: AbortSignal): Promise<CaseOutcome> => {
        if (opts.hang?.(spec))
          return new Promise((res) =>
            signal.addEventListener("abort", () => res({ ok: false, reason: "stopped" }), {
              once: true,
            }),
          );
        return Promise.resolve({
          ok: true,
          cost_usd: 0.02,
          output: `FINDINGS pass-scan SCAN ${spec.id} @${SHA}\n- path: ${spec.files[0]}\n  line: 1-2\n  kind: bug\n  severity: P2\n  claim: it breaks\n\nSUGGEST\n- lens: pass-security\n  files: ${spec.files[0]}\n  reason: auth lives here\n`,
        });
      },
    },
    source: {
      location: "/reviewed-repo",
      resolve: (ref) => (ref === "HEAD" ? head : ref in trees ? ref : null),
      open: (sha) => ({
        ok: true,
        tree: {
          sha,
          root: "/tree",
          files: listOf(sha),
          read: (p) => trees[sha]?.[p] ?? null,
          lines: (p) =>
            trees[sha]?.[p] === undefined ? null : trees[sha]![p]!.split("\n").length - 1,
        },
      }),
      list: (sha) => (trees[sha] ? listOf(sha) : null),
    },
    savedCut: () => {
      opts.duringPlan?.();
      return {
        ok: true,
        cut: {
          units: ["app", "lib"].map((u) => ({ name: u, roots: [u], kind: "directory", note: "" })),
          ignored: [],
        },
      };
    },
    settings: () => ({ ok: true, settings }),
    buildAgents: () => ({ ok: true }),
    ...(lease ? { lease } : {}),
    closeFixedTickets: async () => {
      closeFixed++;
      return { closed: [], problems: [] };
    },
    log: (line) => logs.push(line),
  });
  return {
    scan,
    findings: new FindingsStore(state),
    settingsOf: () => settings,
    lease: lease ?? fileLease(home),
    logs,
    closeFixedCalls: () => closeFixed,
    home,
    advance: (ms) => {
      time.t += ms;
    },
  };
}
