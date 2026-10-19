// The TUI against a fake state dir fed by a faux one-shot: the real review round
// (src/engine/round.ts) runs on the SDK over pi-ai's faux provider — no network,
// no model — and logs its LiveEvents under <root>/state/live/pr-<n>/r1/. The App
// then reads that directory, as it would a box's state, for a PR whose runtime
// is `worker`, and paints the transcript the one-shot actually produced.
import { EventEmitter } from "node:events";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterAll, describe, expect, it, vi } from "vitest";
import { fauxAssistantMessage } from "@earendil-works/pi-ai";
import { PiHost } from "../src/engine/pisdk.js";
import { runRound } from "../src/engine/round.js";
import { roundSdkExtras } from "../src/engine/roundsdk.js";
import { sdkRuntime } from "../src/engine/sdkruntime.js";
import { TUI_DEFAULTS } from "../src/config.js";
import type { StatusSnapshot } from "../src/state.js";
import { App } from "../src/tui/app.js";
import { renderBoard } from "../src/tui/board.js";
import { stripAnsi } from "../src/tui/paint.js";
import type { SshRunner } from "../src/tui/remote.js";
import { pricedFaux } from "./helpers/priced-faux.js";
import {
  FILES,
  FIXTURE_CONFIG,
  OUTCOME,
  RECORD,
  TARGET,
  mkRoot,
  mkTree,
} from "./helpers/round-rig.js";
import { stateDirRunner } from "./helpers/live-state-runner.js";
import { useOfflineGuard } from "./pi-canary/harness.js";

vi.stubEnv("QCR_CONFIG", FIXTURE_CONFIG);
const { benchConfig } = await import("../src/bench/runner.js");
const { ecosystemFor } = await import("../src/ecosystem.js");

useOfflineGuard();

const tmp = mkdtempSync(join(tmpdir(), "tui-viewer-faux-"));
afterAll(() => {
  rmSync(tmp, { recursive: true, force: true });
  vi.unstubAllEnvs();
});

/** One review round on the faux provider; its live log lands under `stateRoot`. */
async function fauxOneShot(stateRoot: string, key: string): Promise<void> {
  const outDir = join(tmp, "out");
  const faux = pricedFaux(() => 0.25, { provider: "faux", models: [{ id: "m" }] });
  faux.appendResponses([
    async () => {
      for (const [f, text] of Object.entries({
        "findings-record.json": RECORD,
        "outcome.json": OUTCOME,
      })) {
        mkdirSync(dirname(join(outDir, f)), { recursive: true });
        writeFileSync(join(outDir, f), text);
      }
      return fauxAssistantMessage("The one-shot's verdict is in the files.");
    },
  ]);
  const host = await PiHost.create({
    agentDir: join(tmp, "sdk-agent"),
    settings: { compaction: { enabled: false }, retry: { enabled: false } },
    configureModels: (r) => {
      r.registerNativeProvider(faux.provider);
    },
  });
  try {
    const cfg = benchConfig("");
    cfg.models.conversation = "faux/m";
    const result = await runRound(
      {
        root: mkRoot(tmp, "root"),
        agentDir: join(tmp, "agent"),
        tree: mkTree(tmp, "tree"),
        files: FILES,
        target: TARGET,
        outDir,
        cfg,
        ecosystem: ecosystemFor("none"),
        timeoutMs: 10 * 60_000,
        live: { root: stateRoot, key, round: 1 },
      },
      sdkRuntime(host, { extras: roundSdkExtras() }),
    );
    expect(result.error).toBeUndefined();
  } finally {
    host.dispose();
  }
}

function streams() {
  const out = new EventEmitter() as any;
  out.columns = 100;
  out.rows = 30;
  out.write = () => true;
  const input = new EventEmitter() as any;
  input.isTTY = false;
  input.resume = () => {};
  input.pause = () => {};
  input.setRawMode = () => {};
  return { out, input };
}

describe("the board over a faux one-shot's state dir", () => {
  it("paints the transcript the round logged, for a worker PR, next to a tmux PR", async () => {
    const stateRoot = join(tmp, "box");
    await fauxOneShot(stateRoot, `pr-${TARGET.number}`);

    const snapshot: StatusSnapshot = {
      written_at: "2026-10-19T12:00:00Z",
      dry_run: true,
      prs: [
        {
          number: TARGET.number,
          state: "reviewing",
          title: TARGET.title,
          head_sha: "aa",
          stale_recheck: 0,
          runtime: "worker",
        },
        { number: 9, state: "reviewing", title: "legacy", head_sha: "bb", stale_recheck: 0 },
      ],
      running_rounds: 0,
      max_concurrent_rounds: 12,
      total_spend_usd: 0,
      today_spend_usd: 0,
      heartbeat: "2026-10-19T12:00:00Z",
    };
    const captured: string[] = [];
    const fallback: SshRunner = async (_h, argv) => {
      if (argv.includes("capture-pane")) {
        captured.push(argv[argv.indexOf("-t") + 1]!);
        return { ok: true, stdout: "legacy pi pane", stderr: "", code: 0 };
      }
      if (argv[0] === "cat")
        return { ok: true, stdout: JSON.stringify(snapshot), stderr: "", code: 0 };
      return {
        ok: true,
        stdout: argv.includes("events") ? '{"events":[]}' : "{}",
        stderr: "",
        code: 0,
      };
    };
    const s = streams();
    vi.useFakeTimers();
    const app = new App(TUI_DEFAULTS, stateDirRunner(stateRoot, fallback).ssh, s.out, s.input);
    const running = app.run();
    try {
      app.view.snapshot = snapshot;
      await vi.advanceTimersByTimeAsync(400);

      app.selectPr(TARGET.number);
      await vi.advanceTimersByTimeAsync(400);
      const screen = renderBoard(app.view, 100, 30).lines.map(stripAnsi).join("\n");
      expect(screen).toContain(`LIVE pr-${TARGET.number}`);
      expect(screen).toMatch(/r1 · main/);
      // what the faux session said, and the round's own lifecycle
      expect(screen).toContain("The one-shot's verdict is in the files.");
      expect(screen).toMatch(/agent settled/);
      expect(app.view.pi?.viewer).toMatchObject({
        round: 1,
        rounds: 1,
        stream: "main",
        live: false,
      });
      expect(captured).toEqual([]);

      app.selectPr(9);
      await vi.advanceTimersByTimeAsync(400);
      expect(captured).toEqual(["pr-9"]);
      const legacy = renderBoard(app.view, 100, 30).lines.map(stripAnsi).join("\n");
      expect(legacy).toContain("legacy pi pane");
      expect(legacy).not.toContain("LIVE");
    } finally {
      app.quit();
      await running;
      vi.useRealTimers();
    }
  }, 60_000);
});
