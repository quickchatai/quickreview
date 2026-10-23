// P8.16 (D10): the per-round worker trees in a closed PR's archive, and their
// retention and cap.
//
//   state/live/<pr-n>/r<k>/   LiveEvent logs (main + one per lens)
//   state/lens/<pr-n>/r<k>/   lens JSONLs (real pi sessions on the faux provider) + ledger
//
// Pinned: the archive pass takes both trees, one gzip per file whatever its
// size, and removes each source once verified; `extractPr` writes them back
// byte-equal under `files/state/...`, a layout `qcr open` reads (a pty run of a
// fake pi shows the lens JSONL it was handed is the very session, opened under
// the id in its header); retention removes a quiet file ONLY when the PR's
// manifest records exactly that file; the cap alerts (`archive_live_cap`) once
// per incident and deletes nothing.
import { spawnSync } from "node:child_process";
import {
  appendFileSync,
  chmodSync,
  existsSync,
  linkSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { fauxAssistantMessage } from "@earendil-works/pi-ai";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import { createBashGuard } from "@quickchatai/pi-quickreview/extensions/bash-guard.js";
import { extractPr } from "../src/archive/extract.js";
import { overLiveCap, sweepLiveTrees } from "../src/archive/liveretention.js";
import { archiveRow } from "../src/archive/rows.js";
import { archiveStatusLine, archiveAttention, readArchiveStatus } from "../src/archive/status.js";
import { loadBuiltAgents } from "@quickchatai/pi-quickreview/src/engine/lens/registry.js";
import { createLensRunner } from "@quickchatai/pi-quickreview/src/engine/lens/runlens.js";
import {
  LENS_SESSIONS_DIR,
  lensSessionsOf,
} from "@quickchatai/pi-quickreview/src/engine/openable.js";
import { runOpen, type OpenDeps } from "../src/opencli.js";
import {
  DAY,
  T0,
  filesUnder,
  manifestOf,
  onArchiver,
  prFixture,
  sha,
  bundleRecords,
  put,
  type PrFixture,
} from "./helpers/archive-pr.js";
import { createHostRig, useOfflineGuard, type HostRig } from "./pi-canary/harness.js";
import { HEAVY_TIMEOUT_MS } from "./helpers/suite-timeouts.js";

useOfflineGuard();

// A seam on the retention sweep's archived-check: after the real check passes,
// `afterHeldCheck` may touch the live file, as a writer racing the sweep would.
const raceHook: { afterHeldCheck: ((id: { size: number }) => void) | null } = {
  afterHeldCheck: null,
};
vi.mock("../src/archive/archivewrite.js", async (importOriginal) => {
  const real = await importOriginal<typeof import("../src/archive/archivewrite.js")>();
  return {
    ...real,
    heldAsRecorded: (async (...a: Parameters<typeof real.heldAsRecorded>) => {
      const held = await real.heldAsRecorded(...a);
      if (held && a[2]) raceHook.afterHeldCheck?.(a[2]);
      return held;
    }) as typeof real.heldAsRecorded,
  };
});

const ROOT = join(import.meta.dirname, "..");

let rig: HostRig;
const fixtures: PrFixture[] = [];
const scratch: string[] = [];
beforeEach(async () => {
  rig = await createHostRig();
});
afterEach(() => {
  rig.close();
  for (const f of fixtures.splice(0)) f.close();
  for (const d of scratch.splice(0)) rmSync(d, { recursive: true, force: true });
});

function tmp(): string {
  const d = mkdtempSync(join(tmpdir(), "qcr-worker-rounds-"));
  scratch.push(d);
  return d;
}

interface Worker {
  f: PrFixture;
  /** Live paths relative to the root, with their bytes. */
  files: Map<string, Buffer>;
  /** The lens run ids of round 1, and each one's session id (its JSONL's header). */
  lensIds: string[];
  sessionIdOf: Map<string, string>;
  round: string;
}

/**
 * The fixture PR (closed 15 days ago) with round 1's worker trees: two lens
 * passes run by the real lens runner on pi's faux provider into
 * `state/lens/pr-N/r1/`, and the round's LiveEvent logs. Every file is aged to
 * the PR's close, as a finished round's are.
 */
async function workerPr(over: { pr?: number; bigLog?: boolean } = {}): Promise<Worker> {
  const f = prFixture(over.pr === undefined ? {} : { pr: over.pr });
  fixtures.push(f);
  const round = `pr-${f.pr}/r1`;
  const agents = join(f.root, "lens-agents");
  mkdirSync(agents, { recursive: true });
  for (const a of ["pass-a", "pass-b"])
    writeFileSync(
      join(agents, `${a}.md`),
      `---\nname: ${a}\ndescription: ${a} lens\nmodel: faux/faux-1\ntools: read, bash\n---\nYou are ${a}.\n`,
    );
  const lensDir = join(f.root, "state", "lens", round);
  rig.faux.setResponses([fauxAssistantMessage("a: nothing"), fauxAssistantMessage("b: nothing")]);
  const runner = createLensRunner({
    host: rig.host,
    permits: 4,
    registry: loadBuiltAgents(agents),
    cwd: f.root,
    env: { PATH: process.env["PATH"], HOME: f.root },
    bashGuard: createBashGuard({ sandboxRoot: f.root, replay: false, secretDirs: [] }),
    ledgerPath: join(lensDir, "lens-ledger.jsonl"),
    sessionsDir: join(lensDir, LENS_SESSIONS_DIR),
    sessionGapMs: 0,
  });
  const runs = await Promise.all([
    runner.run({ agent: "pass-a", task: "look at a" }),
    runner.run({ agent: "pass-b", task: "look at b" }),
  ]);
  const lensIds = runs.map((r) => r.result.id!);
  const liveDir = join(f.root, "state", "live", round);
  mkdirSync(liveDir, { recursive: true });
  const event = (seq: number): string =>
    `${JSON.stringify({ v: 1, seq, at: "2026-10-01T10:00:00.000Z", type: "turn" })}\n`;
  writeFileSync(
    join(liveDir, "main.jsonl"),
    over.bigLog ? event(1).repeat(40_000) : event(1) + event(2),
  );
  for (const id of lensIds) writeFileSync(join(liveDir, `lens-${id}.jsonl`), event(1));
  const aged = T0 - 15 * DAY - 3_600_000;
  const files = new Map<string, Buffer>();
  for (const tree of ["live", "lens"])
    for (const rel of filesUnder(f.root, join(f.root, "state", tree))) {
      utimesSync(join(f.root, rel), aged / 1000, aged / 1000);
      files.set(rel, readFileSync(join(f.root, rel)));
    }
  const sessionIdOf = new Map(
    lensSessionsOf(lensDir).map((k) => [
      k.id,
      (JSON.parse(readFileSync(k.file, "utf8").split("\n", 1)[0]!) as { id: string }).id,
    ]),
  );
  return { f, files, lensIds, sessionIdOf, round };
}

async function archive(f: PrFixture, cfg = {}): Promise<void> {
  const a = onArchiver(f, cfg);
  await a.tick();
  a.stop();
  expect(archiveRow(f.store, f.pr)?.state).toBe("archived");
}

describe("[P8.16] the archive pass takes the worker trees", () => {
  it(
    "every round log and lens JSONL is its own verified gzip, the sources are removed, nothing is bundled",
    { timeout: HEAVY_TIMEOUT_MS },
    async () => {
      const w = await workerPr();
      expect(w.files.size).toBeGreaterThanOrEqual(6); // 2 lens JSONLs + ledger, main log + 2 lens logs
      await archive(w.f);
      // Both trees are empty (no file, no directory left behind).
      for (const tree of ["live", "lens"])
        expect(existsSync(join(w.f.root, "state", tree, `pr-${w.f.pr}`)), tree).toBe(false);
      const entries = manifestOf(w.f).entries;
      for (const rel of w.files.keys()) {
        const e = entries.find((x) => x.source === rel);
        expect(e, rel).toMatchObject({
          kind: "file",
          archive: `files/${rel}.gz`,
          class: rel.startsWith("state/live/") ? "live_logs" : "lens_sessions",
        });
        expect(e!.source_removed_at, rel).toBeDefined();
      }
      // None rode a bundle record, however small.
      expect([...bundleRecords(w.f).keys()].filter((p) => /state\/(live|lens)\//.test(p))).toEqual(
        [],
      );
    },
  );

  it(
    "a log past the bundle's record size is the same: one gzip, byte-equal on extraction",
    { timeout: HEAVY_TIMEOUT_MS },
    async () => {
      const w = await workerPr({ bigLog: true });
      const main = `state/live/${w.round}/main.jsonl`;
      expect(statSync(join(w.f.root, main)).size).toBeGreaterThan(1024 * 1024);
      await archive(w.f);
      const to = join(tmp(), "out");
      const r = await extractPr(opts(w.f, to));
      expect(r.ok && r.errors).toEqual([]);
      expect(sha(readFileSync(join(to, "files", main)))).toBe(sha(w.files.get(main)!));
    },
  );
});

const opts = (f: PrFixture, to: string) => ({
  root: f.root,
  sessionsRoot: join(f.root, "state", "pi-sessions"),
  pr: f.pr,
  to,
  bytesPerS: 200 * 1024 * 1024,
});

describe("[P8.16] extraction restores the rounds, and qcr open reads them", () => {
  it(
    "extracts every worker file byte-equal at files/<live path>, mtimes kept",
    { timeout: HEAVY_TIMEOUT_MS },
    async () => {
      const w = await workerPr();
      await archive(w.f);
      const to = join(tmp(), "out");
      const r = await extractPr(opts(w.f, to));
      expect(r.ok).toBe(true);
      if (!r.ok) return;
      expect(r.errors).toEqual([]);
      for (const [rel, bytes] of w.files) {
        const out = join(to, "files", rel);
        expect(sha(readFileSync(out)), rel).toBe(sha(bytes));
        expect(Math.round(statSync(out).mtimeMs / 1000)).toBe(
          Math.round((T0 - 15 * DAY - 3_600_000) / 1000),
        );
      }
      // A re-run changes nothing.
      const again = await extractPr(opts(w.f, to));
      expect(again.ok && again.files.every((x) => x.outcome === "present")).toBe(true);
    },
  );

  it(
    "qcr open on the extraction opens a lens in a pty'd pi: the very session, under its header id",
    { timeout: HEAVY_TIMEOUT_MS },
    async () => {
      const w = await workerPr();
      await archive(w.f);
      const to = join(tmp(), "out");
      expect((await extractPr(opts(w.f, to))).ok).toBe(true);
      const roundDir = join(to, "files", "state", "lens", w.round);
      // The extracted file is a session pi's own SessionManager opens under the same id.
      const kept = lensSessionsOf(roundDir);
      expect(kept.map((k) => k.id).sort()).toEqual([...w.lensIds].sort());
      for (const k of kept) {
        const header = JSON.parse(readFileSync(k.file, "utf8").split("\n", 1)[0]!) as {
          id: string;
        };
        expect(SessionManager.open(k.file).getSessionId()).toBe(header.id);
      }
      // `qcr open <extraction> --lens <id>`: pi (a fake, on a real pty) is handed that file.
      const bin = join(tmp(), "fake-pi");
      const record = join(tmp(), "record");
      writeFileSync(
        bin,
        `#!/bin/sh\n[ -t 0 ] && [ -t 1 ] || { echo "not a tty" > "${record}"; exit 7; }\n` +
          `for a; do f="$a"; done\n{ echo "$f"; head -1 "$f"; } > "${record}"\nexit 0\n`,
      );
      chmodSync(bin, 0o755);
      const out: string[] = [];
      const d: OpenDeps = {
        detachedHome: join(tmp(), "detached"),
        runsDir: join(tmp(), "runs"),
        scanDir: join(tmp(), "scan"),
        root: ROOT,
        cwd: tmp(),
        env: { PATH: "/usr/bin:/bin", TERM: "xterm" },
        out: (l) => out.push(l),
        piBin: bin,
        prepare: () => ({ agentDir: tmp(), cwd: tmp(), cleanup: () => {} }),
        spawn: (cmd) =>
          spawnSync(
            "script",
            ["-qec", [cmd.bin, ...cmd.args].map((a) => `'${a}'`).join(" "), "/dev/null"],
            {
              cwd: cmd.cwd,
              env: cmd.env,
              stdio: ["pipe", "ignore", "ignore"],
            },
          ).status ?? 1,
      };
      expect(await runOpen([to, "--lens", w.lensIds[0]!], false, d)).toBe(0);
      const [file, headerLine] = readFileSync(record, "utf8").split("\n");
      expect(file).toBe(kept.find((k) => k.id === w.lensIds[0])!.file);
      expect(file!.startsWith(join(to, "files", "state", "lens", w.round))).toBe(true);
      expect((JSON.parse(headerLine!) as { id: string }).id).toBe(w.sessionIdOf.get(w.lensIds[0]!));
      // Without --lens the PR's main session opens: its newest archived transcript.
      expect(await runOpen([to], false, d)).toBe(0);
      expect(readFileSync(record, "utf8").split("\n")[0]).toBe(
        join(to, "transcripts", "nested", "2026-10-03T10-00-00_c.jsonl"),
      );
    },
  );
});

describe("[P8.16] retention", () => {
  const retention = 30 * DAY;
  const now = new Date(T0 + 40 * DAY);

  /** Archive the PR, then put every worker file back as the SAME inode (an unlink
   * an interrupted pass never finished): the manifest records exactly these. */
  async function leftover(w: Worker): Promise<void> {
    const hold = join(tmp(), "hold");
    for (const rel of w.files.keys()) {
      mkdirSync(join(hold, rel, ".."), { recursive: true });
      linkSync(join(w.f.root, rel), join(hold, rel));
    }
    await archive(w.f);
    for (const rel of w.files.keys()) {
      mkdirSync(join(w.f.root, rel, ".."), { recursive: true });
      linkSync(join(hold, rel), join(w.f.root, rel));
    }
  }

  it(
    "removes a quiet file the PR's archive holds exactly, and prunes the emptied dirs",
    { timeout: HEAVY_TIMEOUT_MS },
    async () => {
      const w = await workerPr();
      await leftover(w);
      const r = await sweepLiveTrees({ root: w.f.root, now, retentionMs: retention, remove: true });
      expect(r).toMatchObject({
        files: w.files.size,
        removed_files: w.files.size,
        unarchived_files: 0,
        bytes_after: 0,
      });
      expect(r.removed_bytes).toBe([...w.files.values()].reduce((n, b) => n + b.length, 0));
      for (const tree of ["live", "lens"])
        expect(existsSync(join(w.f.root, "state", tree, `pr-${w.f.pr}`))).toBe(false);
    },
  );

  it("a measuring pass removes nothing", { timeout: HEAVY_TIMEOUT_MS }, async () => {
    const w = await workerPr();
    await leftover(w);
    const r = await sweepLiveTrees({ root: w.f.root, now, retentionMs: retention, remove: false });
    expect(r).toMatchObject({ files: w.files.size, removed_files: 0, bytes_after: r.bytes });
    for (const rel of w.files.keys()) expect(existsSync(join(w.f.root, rel)), rel).toBe(true);
  });

  it(
    "a round still inside the retention is kept whole",
    { timeout: HEAVY_TIMEOUT_MS },
    async () => {
      const w = await workerPr();
      await leftover(w);
      const r = await sweepLiveTrees({
        root: w.f.root,
        now: new Date(T0 - 10 * DAY),
        retentionMs: retention,
        remove: true,
      });
      expect(r.removed_files).toBe(0);
      for (const rel of w.files.keys()) expect(existsSync(join(w.f.root, rel)), rel).toBe(true);
    },
  );

  it(
    "a file whose bytes are archived but is not the archived file (another inode) is kept as unarchived",
    { timeout: HEAVY_TIMEOUT_MS },
    async () => {
      const w = await workerPr();
      await archive(w.f);
      // The same bytes, written anew after the pass: not what the manifest recorded.
      for (const [rel, bytes] of w.files) {
        put(w.f.root, rel, bytes, T0 - 15 * DAY);
      }
      const r = await sweepLiveTrees({ root: w.f.root, now, retentionMs: retention, remove: true });
      expect(r).toMatchObject({ removed_files: 0, unarchived_files: w.files.size });
      for (const rel of w.files.keys()) expect(existsSync(join(w.f.root, rel)), rel).toBe(true);
    },
  );

  it(
    "an open PR's old round, and a key that is no PR's, are never removed: unarchived data is kept",
    { timeout: HEAVY_TIMEOUT_MS },
    async () => {
      const f = prFixture();
      fixtures.push(f);
      const old = (T0 - 90 * DAY) / 1000;
      const a = put(f.root, "state/live/pr-777/r1/main.jsonl", "open pr's log\n");
      const b = put(f.root, "state/lens/pr-777/r1/lens-ledger.jsonl", "{}\n");
      const c = put(f.root, "state/live/debug-2026/r1/main.jsonl", "a review run's log\n");
      for (const p of [a, b, c]) utimesSync(p, old, old);
      const r = await sweepLiveTrees({ root: f.root, now, retentionMs: retention, remove: true });
      expect(r).toMatchObject({ files: 3, removed_files: 0, unarchived_files: 3 });
      for (const p of [a, b, c]) expect(existsSync(p), p).toBe(true);
    },
  );

  it(
    "a file written to after the inventory is kept, not removed on its stale identity",
    { timeout: HEAVY_TIMEOUT_MS },
    async () => {
      const w = await workerPr();
      await leftover(w);
      const victim = [...w.files.keys()][0]!;
      raceHook.afterHeldCheck = () => {
        raceHook.afterHeldCheck = null;
        appendFileSync(join(w.f.root, victim), "late bytes\n");
      };
      try {
        const r = await sweepLiveTrees({
          root: w.f.root,
          now,
          retentionMs: retention,
          remove: true,
        });
        expect(r.removed_files).toBe(w.files.size - 1);
      } finally {
        raceHook.afterHeldCheck = null;
      }
      expect(readFileSync(join(w.f.root, victim), "utf8")).toContain("late bytes");
    },
  );

  it(
    "an unreadable manifest keeps its PR's files and says so",
    { timeout: HEAVY_TIMEOUT_MS },
    async () => {
      const w = await workerPr();
      await leftover(w);
      writeFileSync(join(w.f.root, "archive", `pr-${w.f.pr}`, "manifest.json"), "{ not json");
      const r = await sweepLiveTrees({ root: w.f.root, now, retentionMs: retention, remove: true });
      expect(r.removed_files).toBe(0);
      expect(r.manifest_unreadable).toEqual([w.f.pr]);
      expect(r.manifest_errors[String(w.f.pr)]).toMatch(/manifest/);
      for (const rel of w.files.keys()) expect(existsSync(join(w.f.root, rel)), rel).toBe(true);
    },
  );

  it(
    "the archiver sweeps in mode on at the plan's cadence, and plan mode only measures",
    { timeout: HEAVY_TIMEOUT_MS },
    async () => {
      const w = await workerPr();
      await leftover(w);
      w.f.clock.ms = now.getTime();
      // Plan mode: measured, reported, nothing removed.
      const idle = { after_days: 3650 }; // the PR pass leaves the leftovers to the sweep
      const planner = onArchiver(w.f, { mode: "plan", ...idle });
      await planner.tick();
      planner.stop();
      expect(planner.status().live).toMatchObject({ files: w.files.size, removed_files: 0 });
      for (const rel of w.files.keys()) expect(existsSync(join(w.f.root, rel)), rel).toBe(true);
      // Mode on removes, and the status says what it did.
      const a = onArchiver(w.f, idle);
      await a.tick();
      a.stop();
      expect(a.status().live).toMatchObject({
        removed_files: w.files.size,
        files: 0,
        bytes: 0,
        over_cap: false,
      });
      for (const rel of w.files.keys()) expect(existsSync(join(w.f.root, rel)), rel).toBe(false);
    },
  );
});

describe("[P8.16] the cap alerts and never deletes", () => {
  const capAnomalies = (f: PrFixture): Array<{ detail?: unknown }> =>
    f.store.anomalies().filter((x) => x.kind === "archive_live_cap");

  /** An open PR's 20 KB log, against a ~10 KB cap. */
  function overCap(f: PrFixture): string {
    return put(f.root, "state/live/pr-777/r1/main.jsonl", "x".repeat(20_000), T0 - 90 * DAY);
  }
  const tinyCap = { live_cap_gb: 10_000 / 1024 ** 3 };

  it(
    "raises archive_live_cap once per incident and every 6 h, names the unarchived files, keeps them",
    { timeout: HEAVY_TIMEOUT_MS },
    async () => {
      const f = prFixture();
      fixtures.push(f);
      const log = overCap(f);
      f.clock.ms = T0 + 40 * DAY;
      const a = onArchiver(f, tinyCap);
      await a.tick();
      expect(capAnomalies(f)).toHaveLength(1);
      expect(JSON.stringify(capAnomalies(f)[0])).toMatch(/nothing is deleted to get under the cap/);
      const live = a.status().live!;
      expect(live).toMatchObject({ over_cap: true, files: 1, unarchived_files: 1, bytes: 20_000 });
      // Later sweeps inside the 6 h window: no second wake.
      f.clock.ms += 20 * 60_000;
      await a.tick();
      expect(capAnomalies(f)).toHaveLength(1);
      // 6 h on, still over: the reminder.
      f.clock.ms += 7 * 3_600_000;
      await a.tick();
      expect(capAnomalies(f)).toHaveLength(2);
      expect(existsSync(log)).toBe(true);
      // The status line and the attention list say it.
      const read = readArchiveStatus(JSON.parse(JSON.stringify(a.status())));
      expect(read.kind).toBe("read");
      expect(archiveStatusLine(JSON.parse(JSON.stringify(a.status())))).toMatch(
        /WORKER LOGS OVER CAP/,
      );
      expect(archiveAttention(a.status()).join(" ")).toMatch(/worker logs/);
      // Back under the cap: the incident ends, and a new overrun alerts at once.
      rmSync(log);
      f.clock.ms += 20 * 60_000;
      await a.tick();
      expect(a.status().live).toMatchObject({ over_cap: false, bytes: 0 });
      overCap(f);
      f.clock.ms += 20 * 60_000;
      await a.tick();
      a.stop();
      expect(capAnomalies(f)).toHaveLength(3);
    },
  );

  it(
    "a cap of 0 is off, and plan mode alerts too (it measures the same trees)",
    { timeout: HEAVY_TIMEOUT_MS },
    async () => {
      const f = prFixture();
      fixtures.push(f);
      overCap(f);
      f.clock.ms = T0 + 40 * DAY;
      const off = onArchiver(f, { live_cap_gb: 0 });
      await off.tick();
      off.stop();
      expect(capAnomalies(f)).toEqual([]);
      expect(off.status().live).toMatchObject({ cap_bytes: null, over_cap: false });
      expect(overLiveCap(1e12, 0)).toBe(false);
      const plan = onArchiver(f, { mode: "plan", ...tinyCap });
      await plan.tick();
      plan.stop();
      expect(capAnomalies(f)).toHaveLength(1);
      expect(plan.status().live).toMatchObject({ over_cap: true, removed_files: 0 });
    },
  );

  it("the cap counts the live tree after the pass's own removals", () => {
    expect(overLiveCap(10, 10)).toBe(false);
    expect(overLiveCap(11, 10)).toBe(true);
  });
});
