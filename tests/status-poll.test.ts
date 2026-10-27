// status.json's `poll` record: the daemon's authoritative reconcile poll,
// written by the daemon itself — when its last pass ran, whether it was
// clean, the first error when it was not, and the poll interval it runs on.
// It is what "auto-review is working" is judged on beside the heartbeat (the
// home's label, src/home/autoreview.ts); a snapshot from an older daemon has
// no `poll`, and readers say unknown.
import { mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { GateResult } from "@quickchatai/pi-quickreview/src/gate.js";
import { loadConfig, type Config } from "../src/config.js";
import { createDaemon, type DaemonAdapter } from "../src/daemon.js";
import type { PrRef } from "../src/github.js";
import { StateStore, type StatusSnapshot } from "../src/state.js";
import { HEAVY_TIMEOUT_MS } from "./helpers/suite-timeouts.js";

const cfg: Config = loadConfig(resolve(process.cwd(), "tests/fixtures/config.toml"));

function adapter(listOpenPrs: () => Promise<PrRef[]>): DaemonAdapter {
  const gate = async (): Promise<GateResult> => ({ executed: false });
  return {
    searchLabelTriggered: async () => [],
    searchTeamTriggered: async () => [],
    listOpenPrs,
    getPr: async () => {
      throw new Error("no PR");
    },
    stalenessScan: async () => [],
    listBotReviewComments: async () => [],
    getRequestedReviewers: async () => ({ users: [], teams: [] }),
    listPrFiles: async () => [],
    addLabel: gate,
    removeLabel: gate,
    deleteTeamReviewRequest: gate,
    createReview: gate,
  } as unknown as DaemonAdapter;
}

describe("the daemon writes the poll record", () => {
  let root: string;
  let store: StateStore;
  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "qcr-status-poll-"));
    for (const d of ["state", "state/dryrun", "verdict", "inject"])
      mkdirSync(join(root, d), { recursive: true });
    store = new StateStore(":memory:");
  });
  afterEach(() => {
    store.close();
    rmSync(root, { recursive: true, force: true });
  });

  const status = (): StatusSnapshot =>
    JSON.parse(readFileSync(join(root, "state", "status.json"), "utf8")) as StatusSnapshot;

  const daemonOver = (a: DaemonAdapter) =>
    createDaemon({
      cfg: { ...cfg, dry_run: true },
      root,
      store,
      adapter: a,
      listen: false,
      log: () => {},
    });

  // MUTATION: drop `snapshot.poll = …` from the heartbeat in src/daemon.ts — this fails.
  it(
    "a clean pass: its time, ok, and the daemon's own poll interval",
    { timeout: HEAVY_TIMEOUT_MS },
    async () => {
      const daemon = daemonOver(adapter(async () => []));
      await daemon.start();
      try {
        const poll = status().poll!;
        expect(poll.ok).toBe(true);
        expect(poll.error).toBeUndefined();
        expect(poll.interval_s).toBe(cfg.daemon.poll_interval_s);
        expect(Number.isFinite(Date.parse(poll.last_at!))).toBe(true);
      } finally {
        await daemon.stop();
      }
    },
  );

  // MUTATION: record every pass as ok in reconcilePass — this fails.
  it(
    "a pass with a step error: not ok, with the error",
    { timeout: HEAVY_TIMEOUT_MS },
    async () => {
      const daemon = daemonOver(
        adapter(async () => {
          throw new Error("GitHub 502");
        }),
      );
      await daemon.start();
      try {
        expect(status().poll).toMatchObject({
          ok: false,
          error: expect.stringMatching(/^listOpenPrs: .*GitHub 502/),
          interval_s: cfg.daemon.poll_interval_s,
        });
      } finally {
        await daemon.stop();
      }
    },
  );

  it(
    "before the boot's first pass has ended: no time and no verdict, never ok",
    { timeout: HEAVY_TIMEOUT_MS },
    async () => {
      let release: (prs: PrRef[]) => void = () => {};
      const held = new Promise<PrRef[]>((r) => (release = r));
      const daemon = daemonOver(adapter(() => held));
      const started = daemon.start();
      const deadline = Date.now() + 10_000;
      let first: StatusSnapshot | undefined;
      while (Date.now() < deadline) {
        try {
          first = status();
          break;
        } catch {
          await new Promise((r) => setTimeout(r, 10));
        }
      }
      expect(first?.poll).toEqual({
        last_at: null,
        ok: null,
        interval_s: cfg.daemon.poll_interval_s,
      });
      release([]);
      await started;
      try {
        // the pass's outcome reaches status.json when it ends, not a heartbeat later
        expect(status().poll?.ok).toBe(true);
      } finally {
        await daemon.stop();
      }
    },
  );
});
