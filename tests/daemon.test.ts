// End-to-end daemon wiring: reconcile → queue → dispatch (trigger consumption
// through the dry-run gate) → stub round order on disk → verdict file picked
// up by the watcher → labels intents recorded → state machine lands. No
// network, no tmux: fake adapter + stub hooks + temp root.
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { loadConfig } from "../src/config.js";
import { createDaemon, type DaemonAdapter } from "../src/daemon.js";
import type { GateResult } from "../src/gate.js";
import type { PrRef } from "../src/github.js";
import { StateStore } from "../src/state.js";
import { postingMarker } from "../src/posting-receipt.js";

const PR = 101;

function fakeAdapter(recorded: string[], dryrunDir: string): DaemonAdapter {
  const gateResult = (kind: string): GateResult => {
    recorded.push(kind);
    writeFileSync(join(dryrunDir, `${Date.now()}-${recorded.length}-${kind}.json`), JSON.stringify({ kind }));
    return { executed: false };
  };
  const pr: PrRef = {
    number: PR,
    title: "test PR",
    author: "someone",
    head_sha: "headsha1",
    updated_at: "2026-08-13T00:00:00Z",
    state: "open",
    draft: false,
    merged: false,
    labels: ["AI review requested"],
  };
  return {
    searchLabelTriggered: async () => [{ number: PR, title: pr.title, user: { login: pr.author, type: "User" }, updated_at: pr.updated_at, created_at: pr.updated_at }],
    searchTeamTriggered: async () => [],
    searchAwaitingEscalationReviewer: async () => [],
    listOpenPrs: async () => [pr],
    getPr: async () => pr,
    stalenessScan: async () => [],
    listBotReviewComments: async () => [],
    getRequestedReviewers: async () => ({ users: [], teams: [] }),
    listPrFiles: async () => [{ filename: "src/app.ts", additions: 5, deletions: 1, status: "modified" }],
    addLabel: async () => gateResult("add_label"),
    removeLabel: async () => gateResult("remove_label"),
    deleteTeamReviewRequest: async () => gateResult("delete_team_review_request"),
    requestEscalationReview: async () => ({ skipped: null, result: gateResult("request_reviewer") }),
    createReview: async () => gateResult("create_review"),
  } as unknown as DaemonAdapter;
}

describe("daemon wiring", () => {
  let root: string;
  let store: StateStore;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "qcr-daemon-"));
    for (const d of ["state", "state/dryrun", "verdict", "inject"]) {
      mkdirSync(join(root, d), { recursive: true });
    }
    store = new StateStore(":memory:");
  });

  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  // Boot-order regression (live, #5290 2026-08-19): the first reconcile can
  // nudge a recheck at a dead session immediately; the respawn path needs the
  // title resolver wired by onStart, so onStart must run BEFORE the sweep.
  it("runs onStart before the first reconcile", async () => {
    const order: string[] = [];
    const recorded: string[] = [];
    const adapter = fakeAdapter(recorded, join(root, "state", "dryrun"));
    const listPrs = adapter.listOpenPrs.bind(adapter);
    adapter.listOpenPrs = async (...a: Parameters<typeof listPrs>) => {
      order.push("reconcile");
      return listPrs(...a);
    };
    const daemon = createDaemon({
      cfg: { ...loadConfig(join(process.cwd(), "tests/fixtures/config.toml")), dry_run: true },
      root,
      store,
      adapter,
      listen: false,
      log: () => {},
      onStart: () => {
        order.push("onStart");
      },
    });
    await daemon.start();
    try {
      expect(order[0]).toBe("onStart");
      expect(order).toContain("reconcile");
    } finally {
      await daemon.stop();
    }
  });

  it("runs reconcile → dispatch → verdict apply end to end in dry-run", async () => {
    const recorded: string[] = [];
    const daemon = createDaemon({
      cfg: { ...loadConfig(join(process.cwd(), "tests/fixtures/config.toml")), dry_run: true }, // the test exercises dry-run machinery regardless of the shipped flag
      root,
      store,
      adapter: fakeAdapter(recorded, join(root, "state", "dryrun")),
      listen: false,
      log: () => {},
    });

    await daemon.start();
    try {
      // Reconcile (run by start) queued the triggered PR; dispatch consumed
      // the triggers and moved it to reviewing.
      expect(store.getPr(PR)?.state).toBe("reviewing");
      expect(recorded).toContain("remove_label");
      expect(recorded).toContain("delete_team_review_request");
      expect(recorded).toContain("add_label"); // AI review in progress on

      // Stub hooks wrote the round order to disk.
      const orders = readdirSync(join(root, "state", "round-orders"));
      expect(orders.length).toBe(1);

      // Session posts through the guarded dry-run route, whose receipt is the
      // prerequisite for accepting the verdict.
      const running = store.roundsFor(PR)[0]!;
      const receiptDir = join(root, "state", "posting-receipts");
      mkdirSync(receiptDir, { recursive: true });
      writeFileSync(join(receiptDir, `pr-${PR}-round-1.json`), JSON.stringify({
        version: 1,
        posting_key: running.posting_key,
        marker: postingMarker(running.posting_key!),
        pr: PR,
        round_no: 1,
        head_sha: "headsha1",
        intended_event: "APPROVE",
        actual_event: "APPROVE",
        status: "dryrun",
        payload_sha256: "a".repeat(64),
        prepared_at: new Date().toISOString(),
        confirmed_at: new Date().toISOString(),
      }));

      // Session finishes: verdict file appears; the watcher applies it.
      writeFileSync(
        join(root, "verdict", `pr-${PR}-round-1.json`),
        JSON.stringify({ pr: PR, round_no: 1, verdict: "APPROVE", head_sha: "headsha1", spend_usd: 1.25, finished_at: new Date().toISOString() }),
      );
      await vi.waitFor(() => expect(store.getPr(PR)?.state).toBe("tracked"), { timeout: 5000, interval: 50 });

      const round = store.db.prepare("SELECT verdict, spend_usd, status FROM rounds WHERE pr = ?").get(PR) as any;
      expect(round.verdict).toBe("APPROVE");
      expect(round.spend_usd).toBeNull(); // self-reported spend is fiction — never stored
      expect(round.status).toBe("done");

      // status.json exists and reports dry-run.
      const status = JSON.parse(readFileSync(join(root, "state", "status.json"), "utf8"));
      expect(status.dry_run).toBe(true);
    } finally {
      await daemon.stop();
    }
  });
});
