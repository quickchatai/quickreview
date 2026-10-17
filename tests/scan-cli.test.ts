// `qcr scan` (src/scancli.ts) driven over a ScanRunner with faked ports and
// a temp state home (tests/helpers/scan-cli-rig.ts): what each subcommand
// prints — human and `--json` — what it refuses, and its exit code. The
// detached driver is a port here; the run itself is tests/scan-run.test.ts's.
import { EventEmitter } from "node:events";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ScanTriage } from "../src/setup/triage.js";
import { stateHomeFs } from "../src/setup/adapters.js";
import { SCAN_STOP_FILE } from "../src/setup/scanreport.js";
import {
  detachDriver,
  foregroundSignals,
  parseScanArgs,
  runScanCli,
  sendStarted,
  type ScanCliDeps,
} from "../src/scancli.js";
import { scanToolDefinitions } from "../extensions/setup-scan.js";
import type { ScanRunner } from "../src/setup/scanrun.js";
import { SHA, SHA2, FILES, scanRig, type Rig } from "./helpers/scan-cli-rig.js";

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "qcr-scan-cli-"));
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

interface Harness {
  rig: Rig;
  deps: ScanCliDeps;
  lines: string[];
  detached: string[][];
  /** Run one subcommand; its printed output and exit code — and, with
   * `--json`, the parsed object, read field by field. */
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  run(args: string[], json?: boolean): Promise<{ code: number; text: string; json: any }>;
}

function harness(rig: Rig = scanRig({ dir })): Harness {
  const lines: string[] = [];
  const detached: string[][] = [];
  const triage = new ScanTriage({
    findings: rig.findings,
    state: stateHomeFs(rig.home),
    memory: null,
    tracker: { kind: "markdown" } as never,
    clock: () => new Date("2026-09-29T12:00:00Z"),
    units: () => ["app", "lib"],
    runs: () => [],
  });
  const deps: ScanCliDeps = {
    scan: rig.scan,
    findings: rig.findings,
    settingsOf: rig.settingsOf,
    triage,
    afterMatch: null,
    home: rig.home,
    out: (l) => lines.push(l),
    // The detached driver, faked: it starts the run in this process exactly
    // as the foreground driver would, and answers what it started.
    detach: async (argv) => {
      detached.push(argv);
      const said: string[] = [];
      const r = await runScanCli([...argv, "--foreground"], true, {
        ...deps,
        out: (l) => said.push(l),
      });
      return r === 0
        ? { ok: true, run: rig.scan.status().run!, log: "/state/scan/driver.log" }
        : { ok: false, errors: (JSON.parse(said.join("")) as { errors: string[] }).errors };
    },
    sleep: async () => {
      await rig.scan.idle();
    },
    now: () => Date.parse("2026-09-29T12:00:00Z"),
  };
  return {
    rig,
    deps,
    lines,
    detached,
    run: async (args, json = false) => {
      lines.length = 0;
      const code = await runScanCli(args, json, deps);
      const text = lines.join("\n");
      return { code, text, json: json ? JSON.parse(text) : null };
    },
  };
}

async function calibrate(h: Harness): Promise<string> {
  const p = await h.run(["preview"], true);
  const key = p.json.preview.key as string;
  const s = await h.run(["start", "--key", key, "--foreground"]);
  expect(s.code).toBe(0);
  return key;
}

describe("argument parsing", () => {
  it("refuses an unknown subcommand, an unknown flag and a flag missing its value", () => {
    expect(() => parseScanArgs(["bogus"])).toThrow(/usage: qcr scan/);
    expect(() => parseScanArgs(["preview", "--nope"])).toThrow(/usage: qcr scan/);
    expect(() => parseScanArgs(["start", "--key"])).toThrow(/usage: qcr scan/);
    expect(() => parseScanArgs(["start"])).toThrow(/start needs --key/);
    expect(() => parseScanArgs(["stage2", "start"])).toThrow(/stage2 start needs --key/);
    expect(() => parseScanArgs(["stage2", "propose", "--budget", "x"])).toThrow(/usage/);
    expect(() => parseScanArgs(["dismiss", "abc"])).toThrow(/dismiss needs --reason/);
    expect(() => parseScanArgs(["match", "--key", "k", "notapair"])).toThrow(/OLD=NEW/);
  });

  it("reads every documented flag", () => {
    expect(parseScanArgs(["preview", "--sha", "HEAD~1", "--delta"])).toEqual({
      verb: "preview",
      sha: "HEAD~1",
      delta: true,
    });
    expect(parseScanArgs(["findings", "--state", "new", "--doubted", "--limit", "5"])).toEqual({
      verb: "findings",
      query: { state: "new", doubted: true, limit: 5 },
    });
    expect(parseScanArgs(["stage2", "start", "--key", "k", "--rows", "row-1,row-3"])).toEqual({
      verb: "stage2-start",
      key: "k",
      rows: ["row-1", "row-3"],
      foreground: false,
    });
    expect(parseScanArgs(["match", "--key", "k", "a=b", "c=d"])).toEqual({
      verb: "match",
      key: "k",
      pairs: [
        { old: "a", new: "b" },
        { old: "c", new: "d" },
      ],
    });
  });
});

describe("preview and start", () => {
  it("preview names the CLI start; start without the preview's key is refused, with it the run starts", async () => {
    const h = harness();
    const human = await h.run(["preview"]);
    expect(human.code).toBe(0);
    expect(human.text).toMatch(/^CALIBRATION run at aaaaaaaaaaaa/);
    expect(human.text).toMatch(/To run it: qcr scan start --key \w+ --sha a{40} — only after/);
    expect(human.text).not.toMatch(/scan_start/);

    const p = await h.run(["preview"], true);
    expect(p.json).toMatchObject({
      ok: true,
      preview: { mode: "calibration", sha: SHA, cap_usd: 3 },
      start: ["--key", p.json.preview.key, "--sha", SHA],
    });
    expect(p.json.preview.cases[0]).toEqual({
      id: expect.any(String),
      files: expect.any(Number),
      lines: expect.any(Number),
      estimate_usd: null,
    });

    const stale = await h.run(["start", "--key", "stale"], true);
    expect(stale.code).toBe(1);
    expect(stale.json).toEqual({
      ok: false,
      errors: [expect.stringMatching(/^the plan changed since that preview \(key stale/)],
    });
    expect(h.rig.scan.status().run).toBeNull();

    const started = await h.run(["start", "--key", p.json.preview.key], true);
    expect(started.code).toBe(0);
    expect(h.detached).toEqual([
      ["start", "--key", "stale"],
      ["start", "--key", p.json.preview.key],
    ]);
    expect(started.json).toMatchObject({
      ok: true,
      run: { mode: "calibration", sha: SHA, cases: 2, cap_usd: 3 },
      log: "/state/scan/driver.log",
    });
  });

  it("a delta start passes --delta through, and is refused without it", async () => {
    const trees = { [SHA]: FILES, [SHA2]: { ...FILES, "app/a.py": "ONE\nTWO\nthree\n" } };
    const h = harness(scanRig({ dir, trees }));
    await calibrate(h);
    const d = await h.run(["preview", "--sha", SHA2, "--delta"], true);
    expect(d.json.preview.mode).toBe("delta");
    expect(d.json.start).toEqual(["--key", d.json.preview.key, "--sha", SHA2, "--delta"]);
    expect((await h.run(["start", "--key", d.json.preview.key, "--sha", SHA2])).code).toBe(1);
    const ok = await h.run(["start", ...d.json.start, "--foreground"], true);
    expect(ok.code).toBe(0);
    expect(ok.json.run).toMatchObject({ mode: "delta", state: "complete" });
  });

  it("the foreground start drives the run to its end and reports it", async () => {
    const h = harness();
    const p = await h.run(["preview"], true);
    const r = await h.run(["start", "--key", p.json.preview.key, "--foreground"], true);
    expect(r.code).toBe(0);
    expect(r.json).toMatchObject({
      ok: true,
      run: { mode: "calibration", state: "complete", display: "complete", findings: 2 },
    });
  });
});

describe("status", () => {
  it("before any scan, and after one — human and json", async () => {
    const h = harness();
    expect((await h.run(["status"])).text).toMatch(/^No scan has run yet\./);
    expect((await h.run(["status"], true)).json).toMatchObject({ ok: true, run: null });
    await calibrate(h);
    const s = await h.run(["status"], true);
    expect(s.json).toMatchObject({
      ok: true,
      run: {
        mode: "calibration",
        state: "complete",
        display: "complete",
        cases_total: 2,
        cases_done: 2,
        findings: 2,
        spent_usd: 0.04,
        cap_usd: 3,
      },
      ledger: { files: 2 },
    });
    expect((await h.run(["status"])).text).toMatch(/COMPLETE — 2\/2 cases, 2 finding\(s\)/);
  });

  it("--wait blocks while another process drives the run, and returns its end", async () => {
    const clock = { t: Date.parse("2026-09-29T10:00:00Z") };
    const driver = scanRig({ dir, hang: (s) => s.unit === "lib", holder: "driver", clock });
    const h = harness(scanRig({ dir, holder: "cli", clock }));
    const p = await driver.scan.preview();
    if (!p.ok) throw new Error("preview");
    const started = await driver.scan.start({ key: p.preview.key });
    if (!started.ok) throw new Error("start");
    let polls = 0;
    h.deps.sleep = async () => {
      polls++;
      if (polls === 2) {
        driver.scan.stop();
        await driver.scan.idle();
      }
    };
    const w = await h.run(["status", "--wait"], true);
    expect(polls).toBe(2);
    expect(w.code).toBe(1);
    expect(w.json.run).toMatchObject({ id: started.run.id, display: "stopped" });
  });

  it("--wait gives up at --timeout with exit 3", async () => {
    const clock = { t: Date.parse("2026-09-29T10:00:00Z") };
    const driver = scanRig({ dir, hang: () => true, holder: "driver", clock });
    const h = harness(scanRig({ dir, holder: "cli", clock }));
    const p = await driver.scan.preview();
    if (!p.ok) throw new Error("preview");
    await driver.scan.start({ key: p.preview.key });
    let t = 0;
    h.deps.now = () => t;
    h.deps.sleep = async (ms) => {
      t += ms;
    };
    const w = await h.run(["status", "--wait", "--timeout", "5"]);
    expect(w.code).toBe(3);
    expect(w.text).toMatch(/still running after 5s/);
    driver.scan.stop();
    await driver.scan.idle();
  });
});

describe("stop", () => {
  it("nothing recorded as running: refused", async () => {
    const h = harness();
    const r = await h.run(["stop"], true);
    expect(r.code).toBe(1);
    expect(r.json).toEqual({ ok: false, errors: ["no scan is recorded as running"] });
  });

  it("asks the driving process through the stop channel and reports its answer", async () => {
    const clock = { t: Date.parse("2026-09-29T10:00:00Z") };
    const driver = scanRig({ dir, hang: (s) => s.unit === "lib", holder: "driver", clock });
    const h = harness(scanRig({ dir, holder: "cli", clock }));
    const p = await driver.scan.preview();
    if (!p.ok) throw new Error("preview");
    const started = await driver.scan.start({ key: p.preview.key });
    if (!started.ok) throw new Error("start");
    // The driver answers the request at its next poll.
    h.deps.sleep = async () => {
      driver.scan.consumeStopRequest();
      await driver.scan.idle();
    };
    const r = await h.run(["stop"], true);
    expect(r.code).toBe(0);
    expect(r.json).toEqual({
      ok: true,
      run: started.run.id,
      answer: `scan ${started.run.id} stopped — what finished is in the ledger`,
    });
    expect(driver.scan.status().run!.state).toBe("stopped");
  });

  it("no answer from anyone: the run is not being driven", async () => {
    const clock = { t: Date.parse("2026-09-29T10:00:00Z") };
    const driver = scanRig({ dir, hang: () => true, holder: "driver", clock, lease: null });
    const h = harness(scanRig({ dir, holder: "cli", clock }));
    const p = await driver.scan.preview();
    if (!p.ok) throw new Error("preview");
    await driver.scan.start({ key: p.preview.key });
    let t = 0;
    h.deps.now = () => t;
    h.deps.sleep = async (ms) => {
      t += ms;
    };
    const r = await h.run(["stop"]);
    expect(r.code).toBe(1);
    expect(r.text).toMatch(/no process answered the stop/);
    // The request went out on the stop channel, named as the CLI's.
    expect(JSON.parse(readFileSync(join(h.rig.home, SCAN_STOP_FILE), "utf8"))).toMatchObject({
      by: "cli",
    });
    driver.scan.stop();
    await driver.scan.idle();
  });
});

describe("findings", () => {
  it("--json is the stable shape, filtered; a bad filter is a usage error", async () => {
    const h = harness();
    await calibrate(h);
    const all = await h.run(["findings"], true);
    expect(all.code).toBe(0);
    expect(all.json).toMatchObject({
      ok: true,
      total: 2,
      validity: { confirmed: 0, likely: 0, doubtful: 0, unknown: 2 },
    });
    const app = await h.run(["findings", "--unit", "app"], true);
    expect(app.json.findings).toEqual([
      {
        fingerprint: expect.stringMatching(/^[0-9a-f]{64}$/),
        file: "app/a.py",
        range: { start: 1, end: 2 },
        lens: "pass-scan",
        lenses: ["pass-scan"],
        unit: "app",
        kind: "bug",
        severity: "P2",
        validity: "unknown",
        state: "new",
        claim: "it breaks",
        doubted: false,
        doubt: null,
        looks_like_dismissed: null,
        dismissal_reason: null,
        ticket: null,
        first_seen: { run: expect.any(String), sha: SHA },
        last_seen: { run: expect.any(String), sha: SHA },
      },
    ]);
    expect((await h.run(["findings", "--severity", "P0"], true)).json.findings).toEqual([]);
    expect((await h.run(["findings", "--state", "fixed"], true)).json.total).toBe(0);
    expect((await h.run(["findings", "--doubted"], true)).json.total).toBe(0);
    expect((await h.run(["findings", "--limit", "1"], true)).json).toMatchObject({ total: 2 });
    expect((await h.run(["findings", "--limit", "1"], true)).json.findings).toHaveLength(1);
    const bad = await h.run(["findings", "--state", "bogus"], true);
    expect(bad.code).toBe(2);
    expect(bad.json).toEqual({ ok: false, errors: ['Unknown state "bogus".'] });
    expect((await h.run(["findings", "--lens", "pass-scan"])).text).toMatch(
      /^- \[P2\] app\/a\.py:1-2 \(app, bug, new, unvalidated\) it breaks \[[0-9a-f]{12}\]$/m,
    );
  });
});

describe("dismiss", () => {
  it("dismisses through the triage path with the reason, sticky; a refusal is reported per fingerprint", async () => {
    const h = harness();
    await calibrate(h);
    const fs = (await h.run(["findings"], true)).json.findings as Array<{ fingerprint: string }>;
    const [a, b] = fs.map((f) => f.fingerprint);
    const r = await h.run(["dismiss", a!.slice(0, 12), b!, "--reason", "test fixture"], true);
    expect(r.code).toBe(0);
    expect(r.json).toEqual({
      ok: true,
      dismissed: [
        {
          fingerprint: a,
          again: false,
          memory: { written: false, problem: "no reviewer memory in this assembly" },
        },
        {
          fingerprint: b,
          again: false,
          memory: { written: false, problem: "no reviewer memory in this assembly" },
        },
      ],
      errors: [],
    });
    const listed = (await h.run(["findings", "--state", "dismissed"], true)).json;
    expect(listed.total).toBe(2);
    expect(listed.findings[0].dismissal_reason).toBe("test fixture");

    const miss = await h.run(["dismiss", "0".repeat(12), "--reason", "x"], true);
    expect(miss.code).toBe(1);
    expect(miss.json).toEqual({
      ok: false,
      dismissed: [],
      errors: [`${"0".repeat(12)}: no stored finding has fingerprint ${"0".repeat(12)}`],
    });
  });
});

describe("matches and match", () => {
  it("the pending question is shown, and answered by --key with OLD=NEW pairs", async () => {
    const trees = { [SHA]: FILES, [SHA2]: { ...FILES, "app/a.py": "ONE\nTWO\nthree\n" } };
    const h = harness(scanRig({ dir, trees }));
    await calibrate(h);
    const d = await h.run(["preview", "--sha", SHA2, "--delta"], true);
    await h.run(["start", ...d.json.start, "--foreground"]);

    const human = await h.run(["matches"]);
    expect(human.text).toMatch(/^MATCH QUESTION \w+/);
    expect(human.text).toMatch(/Answer with qcr scan match --key \w+ OLD=NEW/);
    const q = (await h.run(["matches"], true)).json;
    expect(q.question).toMatchObject({ key: expect.any(String), run: expect.any(String) });
    expect(q.question.unreported).toHaveLength(1);
    expect(q.question.fresh).toHaveLength(1);
    const pair = `${q.question.unreported[0].fingerprint}=${q.question.fresh[0].fingerprint}`;

    const stale = await h.run(["match", "--key", "stale", pair], true);
    expect(stale.code).toBe(1);
    const ok = await h.run(["match", "--key", q.question.key, pair], true);
    expect(ok.code).toBe(0);
    expect(ok.json).toMatchObject({ ok: true, matched: 1, fixed: 0, new: 0, tickets_closed: 0 });
    expect((await h.run(["matches"], true)).json).toEqual({ ok: true, question: null });
  });
});

describe("suggestions and stage 2", () => {
  it("suggestions list stage 1's leads; a proposal is priced and started by its key", async () => {
    const h = harness();
    await calibrate(h);
    const sugs = await h.run(["suggestions"], true);
    expect(sugs.json).toMatchObject({
      ok: true,
      suggestions: [
        { lens: "pass-security", unit: expect.any(String), reason: "auth lives here" },
        { lens: "pass-security" },
      ],
      stage2: { depth: "standard" },
    });
    expect(sugs.json.stage2.lenses).toContainEqual({
      lens: "pass-data-safety",
      tiers: ["sol-high"],
    });
    expect((await h.run(["suggestions"])).text).toMatch(/^pass-security \(2\):/);

    const rowsFile = join(dir, "rows.json");
    writeFileSync(
      rowsFile,
      JSON.stringify([{ lens: "pass-security", files: ["app/a.py"], reason: "auth" }]),
    );
    const human = await h.run(["stage2", "propose", "--rows", rowsFile]);
    expect(human.code).toBe(0);
    expect(human.text).toMatch(/To run it: qcr scan stage2 start --key \w+/);
    expect(human.text).not.toMatch(/scan_stage2_start/);
    const p = await h.run(["stage2", "propose", "--rows", rowsFile, "--budget", "50"], true);
    expect(p.json).toMatchObject({
      ok: true,
      proposal: { runnable: 1, rows: 1, depth: "standard", floor_rows: 0, budget_usd: 50 },
    });
    expect(p.json.proposal.row_list[0]).toMatchObject({
      id: "row-1",
      lens: "pass-security",
      status: "run",
      files: ["app/a.py"],
    });
    const bad = await h.run(["stage2", "start", "--key", "stale"], true);
    expect(bad.code).toBe(1);
    const s = await h.run(
      ["stage2", "start", "--key", p.json.proposal.key, "--rows", "row-1", "--foreground"],
      true,
    );
    expect(s.code).toBe(0);
    expect(s.json.run).toMatchObject({ mode: "stage2", state: "complete", cases_total: 1 });
  });

  it("a proposal with no rows file proposes no rows of its own — refused on a standard depth", async () => {
    const h = harness();
    await calibrate(h);
    const r = await h.run(["stage2", "propose"], true);
    expect(r.code).toBe(1);
    expect(r.json.ok).toBe(false);
  });
});

describe("stopping a run another process drives", () => {
  it("the scan_stop tool goes through the stop channel, as qcr scan stop does", async () => {
    const clock = { t: Date.parse("2026-09-29T10:00:00Z") };
    const driver = scanRig({ dir, hang: (s) => s.unit === "lib", holder: "driver", clock });
    const rig = scanRig({ dir, holder: "companion", clock });
    const p = await driver.scan.preview();
    if (!p.ok) throw new Error("preview");
    const started = await driver.scan.start({ key: p.preview.key });
    if (!started.ok) throw new Error("start");
    const defs = scanToolDefinitions(rig.scan, rig.findings, rig.settingsOf, null, {
      home: rig.home,
      sleep: async () => {
        driver.scan.consumeStopRequest();
        await driver.scan.idle();
      },
      now: () => 0,
    });
    const res = await defs.find((d) => d.name === "scan_stop")!.execute("id", {});
    expect(res.content.map((c) => c.text).join("\n")).toBe(
      `scan ${started.run.id} stopped — what finished is in the ledger`,
    );
    expect(driver.scan.status().run!.state).toBe("stopped");
  });

  it("an interrupted run's status names whichever driver went away", async () => {
    const clock = { t: Date.parse("2026-09-29T10:00:00Z") };
    const driver = scanRig({ dir, hang: () => true, holder: "driver", clock, lease: null });
    const h = harness(scanRig({ dir, holder: "cli", clock }));
    const p = await driver.scan.preview();
    if (!p.ok) throw new Error("preview");
    await driver.scan.start({ key: p.preview.key });
    const s = await h.run(["status"]);
    expect(s.text).toMatch(
      /It was interrupted \(the process driving it went away — the companion restarted, or a `qcr scan` driver died\)/,
    );
    driver.scan.stop();
    await driver.scan.idle();
  });
});

describe("the foreground driver", () => {
  it("--json says ok only when the run ended complete, matching the exit code", async () => {
    const h = harness(scanRig({ dir, hang: () => true }));
    h.deps.watchStops = (scan) => {
      scan.stop();
      return () => {};
    };
    const p = await h.run(["preview"], true);
    const r = await h.run(["start", "--key", p.json.preview.key, "--foreground"], true);
    expect(r.code).toBe(1);
    expect(r.json).toMatchObject({ ok: false, run: { state: "stopped" } });
  });

  it("tells the launching process it started — and survives that process being gone", () => {
    const outcome = { ok: false as const, errors: ["x"] };
    const closed = { connected: false, send: vi.fn() };
    sendStarted(closed, outcome);
    expect(closed.send).not.toHaveBeenCalled();
    // The channel closes between the check and the send: the error reaches
    // the callback, never an unhandled 'error' event.
    const racing = {
      connected: true,
      send: vi.fn((_m: unknown, cb?: (err: Error | null) => void) => {
        cb?.(new Error("ERR_IPC_CHANNEL_CLOSED"));
        return false;
      }),
    };
    expect(() => sendStarted(racing, outcome)).not.toThrow();
    expect(racing.send).toHaveBeenCalledWith({ kind: "started", outcome }, expect.any(Function));
    const throwing = {
      connected: true,
      send: () => {
        throw new Error("channel closed");
      },
    };
    expect(() => sendStarted(throwing, outcome)).not.toThrow();
    expect(() => sendStarted({}, outcome)).not.toThrow();
  });

  it("a first signal stops the run; a second kills the driver's process group and exits", () => {
    const stop = vi.fn(() => ({ ok: true as const, id: "r" }));
    const killGroup = vi.fn();
    const exit = vi.fn();
    const onSignal = foregroundSignals({ stop } as unknown as ScanRunner, {
      killGroup,
      exit,
      log: () => {},
    });
    onSignal();
    expect(stop).toHaveBeenCalledTimes(1);
    expect(killGroup).not.toHaveBeenCalled();
    onSignal();
    expect(killGroup).toHaveBeenCalledTimes(1);
    expect(exit).toHaveBeenCalledWith(130);
  });
});

describe("the detached driver launch", () => {
  class FakeChild extends EventEmitter {
    disconnect = vi.fn();
    unref = vi.fn();
    kill = vi.fn(() => true);
  }

  function launch(opts: { timeoutMs?: number; logMax?: number } = {}) {
    const home = join(dir, "state");
    const child = new FakeChild();
    const calls: Array<{ command: string; args: string[]; options: Record<string, unknown> }> = [];
    const detach = detachDriver({ QCR_ROOT: "/app/root" }, home, {
      spawn: (command, args, options) => {
        calls.push({ command, args, options: options as Record<string, unknown> });
        return child as never;
      },
      execPath: "/usr/bin/node",
      execArgv: ["--enable-source-maps"],
      script: "/app/root/dist/src/cli.js",
      timeoutMs: opts.timeoutMs ?? 60_000,
      ...(opts.logMax !== undefined ? { logMax: opts.logMax } : {}),
    });
    return { home, child, calls, detach };
  }

  it("runs this CLI again under the same node flags, from the app root, detached with IPC", async () => {
    const { child, calls, detach } = launch();
    const pending = detach(["start", "--key", "k"]);
    const run = { id: "scan-1", mode: "stage1", sha: SHA, cases: [], cap_usd: 1 };
    child.emit("message", { kind: "started", outcome: { ok: true, run, log: "L" } });
    expect(await pending).toEqual({ ok: true, run, log: "L" });
    expect(calls).toHaveLength(1);
    expect(calls[0]!.command).toBe("/usr/bin/node");
    expect(calls[0]!.args).toEqual([
      "--enable-source-maps",
      "/app/root/dist/src/cli.js",
      "scan",
      "start",
      "--key",
      "k",
      "--foreground",
      "--json",
    ]);
    expect(calls[0]!.options).toMatchObject({ cwd: "/app/root", detached: true });
    expect((calls[0]!.options.stdio as unknown[])[3]).toBe("ipc");
    expect(child.disconnect).toHaveBeenCalled();
    expect(child.unref).toHaveBeenCalled();
  });

  it("a driver that exits before it started is a refusal naming its log", async () => {
    const { home, child, detach } = launch();
    const pending = detach(["start", "--key", "k"]);
    child.emit("exit", 1);
    expect(await pending).toEqual({
      ok: false,
      errors: [
        `the scan driver exited (code 1) before it started — see ${join(home, "scan/driver.log")}`,
      ],
    });
  });

  it("a driver silent past the timeout is stopped and refused", async () => {
    const { child, detach } = launch({ timeoutMs: 5 });
    const r = await detach(["start", "--key", "k"]);
    expect(child.kill).toHaveBeenCalledWith("SIGTERM");
    expect(r).toMatchObject({
      ok: false,
      errors: [expect.stringMatching(/did not say it started within/)],
    });
  });

  it("a driver log past its bound is rotated before the next driver appends", async () => {
    const { home, child, detach } = launch({ logMax: 10 });
    mkdirSync(join(home, "scan"), { recursive: true });
    writeFileSync(join(home, "scan/driver.log"), "x".repeat(20));
    const pending = detach(["start", "--key", "k"]);
    child.emit("exit", 1);
    await pending;
    expect(readFileSync(join(home, "scan/driver.log.1"), "utf8")).toBe("x".repeat(20));
    expect(readFileSync(join(home, "scan/driver.log"), "utf8")).toBe("");
  });
});
