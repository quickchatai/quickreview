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
  SCAN_ROUTE_SCRIPT,
  detachDriver,
  foregroundSignals,
  modelFlagOf,
  parseScanArgs,
  runScanCli,
  scanRouteJoin,
  scanRoutePort,
  sendStarted,
  type ScanCliDeps,
  type ScanRouteWorld,
} from "../src/scancli.js";
import { parseConfig } from "../src/config.js";
import { configHome } from "../src/install.js";
import { SCANBOX_SCRATCH } from "../src/scanbox.js";
import { SCAN_MODEL_ENV } from "../src/setup/scanbuild.js";
import type { ScanRouteAnswer } from "../src/engine/caserunner-sdk.js";
import type { ModelRoute } from "@quickchatai/pi-quickreview/src/modelroute.js";
import type { ScanRouteAsk } from "@quickchatai/pi-quickreview/src/scan/scanverbs.js";
import { renderProposal } from "@quickchatai/pi-quickreview/src/scan/scanrender.js";
import type { DockerResult } from "../src/tui/companion.js";
import { scanToolDefinitions } from "../extensions/setup-scan.js";
import { SCAN_USAGE } from "@quickchatai/pi-quickreview/src/scan/scanverbs.js";
import type { ScanRouted, ScanRunner } from "../src/setup/scanrun.js";
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
      schema_version: 1,
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

  // Whoever approves a price must see which repository it is for: a host
  // agent shows `repo` beside the estimate (plugins/qcr/templates/scan.md).
  // MUTATION: drop `...repoField` from the preview answer, or from the
  // foreground start's final answer, in packages/pi-plugin/src/scan/scanverbs.ts
  // — this fails.
  it("a preview and a start name the checkout they scan", async () => {
    const h = harness();
    h.deps.repo = "/work/repo-b";
    const human = await h.run(["preview"]);
    expect(human.text).toMatch(/^Repository: \/work\/repo-b\n\nCALIBRATION run at/);
    const p = await h.run(["preview"], true);
    expect(p.json).toMatchObject({ ok: true, repo: "/work/repo-b" });
    const started = await h.run(["start", "--key", p.json.preview.key], true);
    expect(started.json).toMatchObject({ ok: true, repo: "/work/repo-b" });
    // a foreground start (the image wrapper's) names it the same way
    const fg = harness(scanRig({ dir: mkdtempSync(join(dir, "fg-")) }));
    fg.deps.repo = "/work/repo-b";
    const key = (await fg.run(["preview"], true)).json.preview.key;
    const ran = await fg.run(["start", "--key", key, "--foreground"], true);
    expect(ran.json).toMatchObject({ ok: true, repo: "/work/repo-b", run: { state: "complete" } });
    const fgHuman = harness(scanRig({ dir: mkdtempSync(join(dir, "fg-")) }));
    fgHuman.deps.repo = "/work/repo-b";
    const key2 = (await fgHuman.run(["preview"], true)).json.preview.key;
    const said = await fgHuman.run(["start", "--key", key2, "--foreground"]);
    expect(said.text).toMatch(/^Repository: \/work\/repo-b\n\n/);
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
    expect(r.json).toEqual({
      schema_version: 1,
      ok: false,
      errors: ["no scan is recorded as running"],
    });
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
      schema_version: 1,
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
    expect(bad.json).toEqual({ schema_version: 1, ok: false, errors: ['Unknown state "bogus".'] });
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
      schema_version: 1,
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
      schema_version: 1,
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
    expect((await h.run(["matches"], true)).json).toEqual({
      schema_version: 1,
      ok: true,
      question: null,
    });
  });
});

describe("suggestions and stage 2", () => {
  // MUTATION: call stage2Lenses without `s.scan.lenses` in the suggestions
  // verb (packages/pi-plugin/src/scan/scanverbs.ts) — the JSON offers lenses
  // the `[scan] lenses` allowlist leaves out, and this fails.
  it("the suggestions' stage-2 lenses stay inside [scan] lenses", async () => {
    const rig = scanRig({ dir });
    const allowed = ["pass-data-safety", "pass-security"];
    const h = harness({
      ...rig,
      settingsOf: () => {
        const s = rig.settingsOf()!;
        return { ...s, scan: { ...s.scan, lenses: allowed } };
      },
    });
    await calibrate(h);
    const sugs = await h.run(["suggestions"], true);
    const offered = (sugs.json.stage2.lenses as Array<{ lens: string }>).map((l) => l.lens);
    expect(offered.sort()).toEqual([...allowed].sort());
  });

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
      tiers: ["deep"],
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

it("refuses interactive login as structured JSON without invoking the adapter", async () => {
  const h = harness();
  h.deps.login = vi.fn(async () => 0);
  const code = await runScanCli(["login"], true, h.deps);
  expect(code).toBe(1);
  expect(JSON.parse(h.lines.join("\n"))).toMatchObject({
    ok: false,
    errors: [expect.stringMatching(/interactive|json/i)],
  });
  expect(h.deps.login).not.toHaveBeenCalled();
});

// MUTATION: drop `threat-model propose|threat-model start` from the `scan <…>`
// list in src/cli.ts's top-level usage — this fails.
it("qcr's top-level usage names every scan subcommand SCAN_USAGE documents", () => {
  const cli = readFileSync(join(import.meta.dirname, "../src/cli.ts"), "utf8");
  const listed = /\|scan <([^>]+)>\|/.exec(cli)?.[1]?.split("|") ?? [];
  expect(listed.length).toBeGreaterThan(0);
  const documented = SCAN_USAGE.replace(/^usage: qcr scan /, "")
    .split(" | ")
    .map((part) => {
      const words: string[] = [];
      for (const w of part.trim().split(/\s+/)) {
        if (/^[[(A-Z-]/.test(w)) break;
        words.push(w);
      }
      return words.join(" ");
    });
  expect(documented).toContain("threat-model propose");
  for (const verb of documented) expect(listed, verb).toContain(verb);
});

// ---- the scan's model ------------------------------------------------------------

/** A route on `spec` (`provider/id`), as a host resolved it. */
function routeOn(spec: string, over: Partial<ModelRoute> = {}): ModelRoute {
  const [provider, id] = spec.split("/") as [string, string];
  return {
    provider,
    modelId: id,
    providerName: provider.toUpperCase(),
    spec,
    thinking: null,
    source: "only-credential",
    pick: "newest",
    piDefaultId: null,
    custom: false,
    movedFrom: null,
    credential: { kind: "api_key", origin: "stored", subscription: false },
    priced: true,
    ask: false,
    alternatives: [],
    notices: [],
    ...over,
  };
}

describe("--model and the scan's route on the verbs", () => {
  /** A harness whose host resolves a route: the pin's model when `--model`
   * names one, else `auto/one`. Every ask is recorded. */
  function routedHarness(): Harness & { asks: ScanRouteAsk[] } {
    const h = harness();
    const asks: ScanRouteAsk[] = [];
    h.deps.route = async (ask): Promise<ScanRouted> => {
      asks.push(ask);
      return {
        result: {
          ok: true,
          route:
            ask.pin !== undefined
              ? routeOn(ask.pin, { source: "flag", pick: "pinned" })
              : routeOn("auto/one"),
        },
        surface: "app",
      };
    };
    return Object.assign(h, { asks });
  }

  it("every verb that plans or starts reads --model; no other verb takes it", () => {
    expect(parseScanArgs(["preview", "--model", "p/m:high"])).toEqual({
      verb: "preview",
      delta: false,
      model: "p/m:high",
    });
    for (const argv of [
      ["start", "--key", "k"],
      ["stage2", "propose"],
      ["stage2", "start", "--key", "k"],
      ["threat-model", "propose"],
      ["threat-model", "start", "--key", "k"],
    ])
      expect(parseScanArgs([...argv, "--model", "p/m"]), argv.join(" ")).toMatchObject({
        model: "p/m",
      });
    expect(parseScanArgs(["preview"])).not.toHaveProperty("model");
    expect(() => parseScanArgs(["status", "--model", "p/m"])).toThrow(/usage: qcr scan/);
    expect(() => parseScanArgs(["preview", "--model"])).toThrow(/usage: qcr scan/);
    expect(() => parseScanArgs(["preview", "--model", " "])).toThrow(/--model needs a model/);
    expect(SCAN_USAGE).toMatch(/preview \[--sha REF\] \[--delta\] \[--path DIR\] \[--model M\]/);
  });

  // MUTATION: drop the `deps.route === undefined` refusal in runScanVerb — a
  // surface with no route port reads the flag and changes nothing; this fails.
  it("a surface that resolves no model refuses --model, and runs as before without it", async () => {
    const h = harness();
    const r = await h.run(["preview", "--model", "p/m"], true);
    expect(r.code).toBe(2);
    expect(r.json.errors[0]).toMatch(/--model is not available here/);
    const plain = await h.run(["preview"], true);
    expect(plain.json.preview).not.toHaveProperty("model");
    expect(plain.json.start).toEqual(["--key", plain.json.preview.key, "--sha", SHA]);
  });

  // MUTATION: drop `...m.model` from the preview's call in runScanVerb — the
  // plan says nothing of the model, and this fails.
  it("a preview asks the host once, shows the model, and names the start under the same --model", async () => {
    const h = routedHarness();
    const human = await h.run(["preview"]);
    expect(h.asks).toEqual([{ run: false, ask: true }]);
    expect(human.text).toMatch(/^model: auto\/one \(the provider pi has a credential for\)$/m);
    expect(human.text).toMatch(/To run it: qcr scan start --key \w+ --sha a{40} — only after/);

    const p = await h.run(["preview", "--model", "p/m"], true);
    // A structured answer never asks a person.
    expect(h.asks[1]).toEqual({ pin: "p/m", run: false, ask: false });
    expect(p.json.preview.model).toMatchObject({ spec: "p/m", source: "flag", pick: "pinned" });
    expect(p.json.preview.settings.model).toBe("p/m");
    expect(p.json.preview).not.toHaveProperty("model_lines");
    expect(p.json.start).toEqual(["--key", p.json.preview.key, "--sha", SHA, "--model", "p/m"]);
    const said = await h.run(["preview", "--model", "p/m"]);
    expect(said.text).toMatch(/^model: p\/m \(pinned by --model\)$/m);
    expect(said.text).toMatch(
      /To run it: qcr scan start --key \w+ --sha a{40} --model p\/m — only/,
    );
  });

  // MUTATION: drop `...modelArgv` from the detached start's argv — the
  // driver resolves the route with no pin, its key is another, and this fails.
  it("a start hands its driver the same --model, which resolves the route for the run it drives", async () => {
    const h = routedHarness();
    const p = await h.run(["preview", "--model", "p/m"], true);
    h.asks.length = 0;
    // Without the flag the driver's route is another model: not the plan shown.
    const other = await h.run(["start", "--key", p.json.preview.key], true);
    expect(other.code).toBe(1);
    expect(other.json.errors[0]).toMatch(/^the plan changed since that preview/);
    const started = await h.run(["start", ...(p.json.start as string[])], true);
    expect(started.code).toBe(0);
    expect(h.detached.at(-1)).toEqual([
      "start",
      "--key",
      p.json.preview.key,
      "--sha",
      SHA,
      "--model",
      "p/m",
    ]);
    // The launcher asks nothing; each driver asks once, for its own process.
    expect(h.asks).toEqual([
      { run: true, ask: false },
      { pin: "p/m", run: true, ask: false },
    ]);
    await h.rig.scan.idle();
    expect(h.rig.scan.status().run?.settings.model).toBe("p/m");
    expect((await h.run(["status"])).text).toMatch(/^Model: p\/m$/m);
  });

  it("a host that cannot resolve the model at all refuses the verb, and tells a waiting launcher", async () => {
    const h = harness();
    h.deps.route = async () => {
      throw new Error("the login file cannot be read");
    };
    const p = await h.run(["preview"], true);
    expect(p.code).toBe(1);
    expect(p.json.errors).toEqual([
      "the scan's model could not be resolved: the login file cannot be read",
    ]);
    const told: unknown[] = [];
    h.deps.onStart = (o) => told.push(o);
    const s = await h.run(["start", "--key", "k", "--foreground"], true);
    expect(s.code).toBe(1);
    expect(told).toEqual([
      {
        ok: false,
        errors: ["the scan's model could not be resolved: the login file cannot be read"],
      },
    ]);
    expect(h.rig.scan.status().run).toBeNull();
  });

  // What `qcr scan preview --json` prints: a script tells a sandbox that did
  // not answer from a pi with no credential by the fields, not by the prose.
  // MUTATION: drop `model_unknown` from modelDetails / the preview's details
  // — the two answers differ only in their blocker's text, and this fails.
  it("a structured preview tells an unknown model from no credential", async () => {
    const h = harness();
    h.deps.route = async () => ({
      result: null,
      surface: "app",
      refusal: "the scan sandbox could not be asked: docker is not reachable",
    });
    const unknown = await h.run(["preview"], true);
    expect(unknown.json.preview).toMatchObject({ model: null, model_unknown: true });
    expect(unknown.json.preview).not.toHaveProperty("alternatives");
    expect(unknown.json.start).toBeNull();
    const tm = await h.run(["threat-model", "propose"], true);
    expect(tm.json.preview).toMatchObject({ model: null, model_unknown: true });
    expect(tm.json.preview).not.toHaveProperty("alternatives");

    h.deps.route = async () => ({
      result: { ok: false, refusal: { code: "no-credential" } },
      surface: "app",
    });
    const none = await h.run(["preview"], true);
    expect(none.json.preview).toMatchObject({ model: null, alternatives: [] });
    expect(none.json.preview).not.toHaveProperty("model_unknown");
  });

  it("stage 2 is proposed and started under one model, and says which", async () => {
    const h = routedHarness();
    await calibrate(h);
    const rowsFile = join(dir, "rows.json");
    writeFileSync(
      rowsFile,
      JSON.stringify([{ lens: "pass-security", files: ["app/a.py"], reason: "auth" }]),
    );
    const human = await h.run(["stage2", "propose", "--rows", rowsFile, "--model", "p/m"]);
    expect(human.text).toMatch(/^model: p\/m \(pinned by --model\)$/m);
    expect(human.text).toMatch(/To run it: qcr scan stage2 start --key \w+ --model p\/m — only/);
    const p = await h.run(["stage2", "propose", "--rows", rowsFile, "--model", "p/m"], true);
    expect(p.json.model).toMatchObject({ spec: "p/m" });
    expect(p.json).not.toHaveProperty("model_lines");
    // Another model than the proposal's is another plan.
    const other = await h.run(
      ["stage2", "start", "--key", p.json.proposal.key, "--foreground"],
      true,
    );
    expect(other.code).toBe(1);
    expect(other.json.errors[0]).toMatch(/the plan changed since the proposal/);
    const s = await h.run(
      ["stage2", "start", "--key", p.json.proposal.key, "--model", "p/m", "--foreground"],
      true,
    );
    expect(s.code).toBe(0);
    expect(h.rig.scan.status().run?.settings).toMatchObject({ model: "p/m" });
  });

  it("a threat-model proposal carries the model where a scan preview does", async () => {
    const h = routedHarness();
    const p = await h.run(["threat-model", "propose", "--model", "p/m"], true);
    expect(p.json.preview.model).toMatchObject({ spec: "p/m" });
    expect(p.json.preview).not.toHaveProperty("model_lines");
    const human = await h.run(["threat-model", "propose", "--model", "p/m"]);
    expect(human.text).toMatch(/^model: p\/m \(pinned by --model\)$/m);
  });

  it("a proposal written under the older tier names shows the ladder's", async () => {
    const h = harness();
    await calibrate(h);
    const rowsFile = join(dir, "rows.json");
    writeFileSync(
      rowsFile,
      JSON.stringify([{ lens: "pass-security", files: ["app/a.py"], reason: "auth" }]),
    );
    await h.run(["stage2", "propose", "--rows", rowsFile]);
    // The stored proposal, as a build before the rename wrote it.
    const file = join(h.rig.home, "scan/stage2.json");
    const stored = JSON.parse(readFileSync(file, "utf8")) as {
      proposal: { rows: Array<{ tier: string }> };
    };
    expect(stored.proposal.rows[0]!.tier).toBe("standard");
    stored.proposal.rows[0]!.tier = "sol-med";
    writeFileSync(file, JSON.stringify(stored));
    const text = renderProposal(h.rig.scan.stage2Proposal().proposal!);
    // MUTATION: print `r.tier` unfolded in renderProposal — this fails.
    expect(text).toMatch(/row-1: pass-security at standard over/);
    expect(text).not.toMatch(/sol-med/);
  });
});

describe("the scan's route, resolved where the login is (scanRoutePort)", () => {
  const sandboxRoot = join(import.meta.dirname, "..");
  const fixtureToml = readFileSync(join(sandboxRoot, "tests/fixtures/config.toml"), "utf8");

  interface World {
    port: ReturnType<typeof scanRoutePort>;
    world: ScanRouteWorld;
    /** What the in-process resolver was asked. */
    here: Array<Parameters<NonNullable<ScanRouteWorld["resolveHere"]>>[0]>;
    /** Every docker call. */
    docker: string[][];
    said: string[];
  }

  /** A `qcr scan` process over an install whose config is the shipped
   * defaults (nothing pinned), or the fixture's (every tier pinned). */
  function world(o: {
    pinned?: boolean;
    model?: string;
    /** The scan image's answer; with it the world has a sandbox to ask. */
    image?: (argv: string[]) => DockerResult;
    answer?: ScanRouteAnswer;
  }): World {
    const root = join(dir, "root");
    mkdirSync(root, { recursive: true });
    writeFileSync(
      join(root, "config.example.toml"),
      readFileSync(join(sandboxRoot, "config.example.toml")),
    );
    const env: NodeJS.ProcessEnv = {
      HOME: join(dir, "home"),
      XDG_CONFIG_HOME: join(dir, "xdg-config"),
      ...(o.model !== undefined ? { [SCAN_MODEL_ENV]: o.model } : {}),
    };
    if (o.pinned) {
      mkdirSync(configHome(env), { recursive: true });
      writeFileSync(join(configHome(env), "config.toml"), fixtureToml);
    }
    const here: World["here"] = [];
    const docker: string[][] = [];
    const said: string[] = [];
    const image = o.image;
    const w: ScanRouteWorld = {
      env,
      root,
      home: join(dir, "state"),
      sandbox: image
        ? {
            docker: async (argv) => {
              docker.push(argv);
              if (argv[0] === "image") return { ok: true, stdout: "s1\n", stderr: "", code: 0 };
              if (argv[0] === "volume") return { ok: true, stdout: "", stderr: "", code: 0 };
              return image(argv);
            },
            config: { image: "img", pihome_volume: "vol" },
            stamp: () => "s1",
          }
        : null,
      choose: async () => 0,
      resolved: {},
      resolveHere: async (q) => {
        here.push(q);
        return o.answer ?? { result: { ok: true, route: routeOn("auto/one") } };
      },
      say: (l) => said.push(l),
    };
    return { port: scanRoutePort(w), world: w, here, docker, said };
  }

  it("reads --model early, for the config the scan is assembled over", () => {
    expect(modelFlagOf(["preview", "--model", "p/m", "--sha", "x"])).toBe("p/m");
    expect(modelFlagOf(["preview"])).toBeUndefined();
    expect(modelFlagOf(["preview", "--model"])).toBeUndefined();
    expect(modelFlagOf(["preview", "--model", "--delta"])).toBeUndefined();
  });

  it("with nothing pinned: no pin, each tier on the route at its level, nothing said", async () => {
    const w = world({});
    const r = await w.port({ run: false, ask: false });
    expect(w.here).toHaveLength(1);
    expect(w.here[0]).toMatchObject({ tmpDir: join(dir, "state", "tmp"), configPath: null });
    expect(w.here[0]).not.toHaveProperty("pin");
    // Nobody is asked unless the verb says a person may be.
    expect(w.here[0]!.choose).toBeNull();
    expect(r).toEqual({
      result: { ok: true, route: routeOn("auto/one") },
      surface: "app",
      tiers: { light: "auto/one:medium", standard: "auto/one:medium", deep: "auto/one:high" },
      notes: [],
    });
    await w.port({ run: false, ask: true });
    expect(w.here[1]!.choose).toBe(w.world.choose);
  });

  // MUTATION: keep a plan's route in `resolved` — a preview in a process that
  // then drives nothing would look like a driver's; and drop the driver's
  // write — its cases resolve a route each, and this fails.
  it("a driver's route is kept for the cases it runs; a plan's is not", async () => {
    const w = world({});
    await w.port({ run: false, ask: false });
    expect(w.world.resolved.route).toBeUndefined();
    await w.port({ run: true, ask: false });
    expect(w.world.resolved.route).toEqual(routeOn("auto/one"));
  });

  it("the pin is --model, else the config's own model; --model says what it replaced", async () => {
    const pinned = parseConfig(fixtureToml);
    const config = world({ pinned: true });
    const r = await config.port({ run: false, ask: false });
    expect(config.here[0]!.pin).toEqual({ text: pinned.models.model, from: "config" });
    expect(config.here[0]!.configPath).toBe(join(configHome(config.world.env), "config.toml"));
    // The file's tiers stand, each on its own model: said where stage 1's is.
    expect(r.tiers).toEqual(pinned.models.tiers);
    expect(r.notes).toEqual([
      `stage 1 runs on ${pinned.models.tiers[pinned.scan.tier]}: [models.tiers] ${pinned.scan.tier} pins it (--model puts the whole scan on one model)`,
    ]);

    const flag = world({ pinned: true, model: "p/m" });
    const f = await flag.port({ pin: "p/m", run: false, ask: false });
    expect(flag.here[0]!.pin).toEqual({ text: "p/m", from: "flag" });
    expect(f.tiers).toEqual({
      light: "auto/one:medium",
      standard: "auto/one:medium",
      deep: "auto/one:high",
    });
    expect(f.notes).toEqual(["--model replaces 3 pinned tier and lens models for this run"]);
  });

  // The driver's cases read the route through the join's getter: the one
  // place the two sides meet, so it is held here and not in `cmdScan`.
  // MUTATION: give the port a record of its own in scanRouteJoin
  // (`scanRoutePort({ ...w, resolved: {} })`) — the getter answers nothing
  // after a driver's start, every case's host resolves a route of its own,
  // and this fails.
  it("the join hands a driver's cases the route its start resolved, and a plan's to nobody", async () => {
    const { resolved: _own, ...w } = world({}).world;
    const routes = scanRouteJoin();
    // The getter is made before the port's world is known (the cases are
    // assembled first), and answers nothing until a driver resolved a route.
    expect(routes.route()).toBeUndefined();
    const port = routes.port(w);
    await port({ run: false, ask: false });
    expect(routes.route()).toBeUndefined();
    await port({ run: true, ask: false });
    expect(routes.route()).toEqual(routeOn("auto/one"));
    // Two scans of one process (a test's) never share a route.
    expect(scanRouteJoin().route()).toBeUndefined();
  });

  it("no route: the host's words go with the refusal, and no tier is named", async () => {
    const w = world({
      answer: {
        result: { ok: false, refusal: { code: "no-credential" } },
        refusal: "pi has no model credential. Run `qcr login`.",
      },
    });
    expect(await w.port({ run: true, ask: false })).toEqual({
      result: { ok: false, refusal: { code: "no-credential" } },
      surface: "app",
      refusal: "pi has no model credential. Run `qcr login`.",
      notes: [],
    });
    expect(w.world.resolved.route).toBeUndefined();
  });

  // MUTATION: resolve a sandboxed plan's route in this process — the host's
  // own login answers for the companion's, and this fails.
  it("a plan for a sandboxed scan asks the scan image; a driver asks its own process", async () => {
    const answer: ScanRouteAnswer = { result: { ok: true, route: routeOn("box/model") } };
    const w = world({
      image: () => ({ ok: true, stdout: `${JSON.stringify(answer)}\n`, stderr: "", code: 0 }),
    });
    const r = await w.port({ pin: "box/model", run: false, ask: true });
    expect(w.here).toEqual([]);
    expect(r.result).toEqual(answer.result);
    const run = w.docker.find((c) => c[0] === "run")!;
    expect(run.slice(run.indexOf("-e") + 1)).toEqual([
      SCAN_ROUTE_SCRIPT,
      SCANBOX_SCRATCH,
      "box/model",
      "flag",
      "",
    ]);
    expect(w.world.resolved.route).toBeUndefined();
    // A driver resolves its route in its own process, on its own login (the
    // world's resolver answers auto/one, the image box/model).
    await expect(w.port({ run: true, ask: false })).rejects.toThrow(/on this machine's pi login/);
    expect(w.here).toHaveLength(1);
  });

  // `start --foreground` typed on the host under [scan] sandbox = "docker":
  // the plan was read off the companion's login, the driver runs on this
  // machine's. The runner could only say "the plan changed".
  // MUTATION: drop the sandbox ask from a driver's route in scanRoutePort —
  // the start goes on to the runner's bare "the plan changed" and this fails.
  it("a driver here on another model than the sandbox's plan is refused with the reason and the two ways out", async () => {
    const there: ScanRouteAnswer = { result: { ok: true, route: routeOn("box/model") } };
    const w = world({
      image: () => ({ ok: true, stdout: `${JSON.stringify(there)}\n`, stderr: "", code: 0 }),
    });
    const refused = w.port({ run: true, ask: false });
    await expect(refused).rejects.toThrow(/runs on auto\/one \(AUTO, /);
    await expect(refused).rejects.toThrow(/companion's login and runs on box\/model \(BOX, /);
    await expect(refused).rejects.toThrow(/without --foreground/);
    await expect(refused).rejects.toThrow(/--sandbox host/);
    // Nothing is kept for cases that will not run.
    expect(w.world.resolved.route).toBeUndefined();
  });

  it("a driver here on the model the sandbox would run goes on, and its route is kept", async () => {
    const same: ScanRouteAnswer = { result: { ok: true, route: routeOn("auto/one") } };
    const w = world({
      image: () => ({ ok: true, stdout: `${JSON.stringify(same)}\n`, stderr: "", code: 0 }),
    });
    const r = await w.port({ run: true, ask: false });
    expect(r.result).toEqual(same.result);
    expect(w.world.resolved.route).toEqual(routeOn("auto/one"));
    expect(w.said).toEqual([]);
  });

  it("a sandbox that cannot be asked does not stop a driver here: it says what a refusal would mean", async () => {
    const w = world({ image: () => ({ ok: false, stdout: "", stderr: "boom", code: 1 }) });
    const r = await w.port({ run: true, ask: false });
    expect(r.result).toEqual({ ok: true, route: routeOn("auto/one") });
    expect(w.world.resolved.route).toEqual(routeOn("auto/one"));
    expect(w.said).toHaveLength(1);
    expect(w.said[0]).toMatch(/this machine's pi login \(auto\/one\)/);
    expect(w.said[0]).toMatch(/--sandbox host/);
  });

  it("a driver with no sandbox to plan in (a host scan, or inside the container) asks nobody else", async () => {
    const w = world({});
    await w.port({ run: true, ask: false });
    expect(w.docker).toEqual([]);
    expect(w.said).toEqual([]);
  });

  // `qcr login` signs this machine's pi in, which a sandboxed scan never
  // reads: an answer read from the companion's login names its own way in.
  // MUTATION: drop `login: SANDBOX_LOGIN` from the port's refusal — the plan's
  // model line says `qcr login` over a blocker that says `qcr scan login`,
  // and this fails.
  it("a refusal read from the companion's login names `qcr scan login`; this machine's own names none", async () => {
    const refused: ScanRouteAnswer = {
      result: { ok: false, refusal: { code: "no-credential" } },
      refusal: "no pi login in the companion's pi home — run `qcr scan login`",
    };
    const boxed = world({
      image: () => ({ ok: true, stdout: `${JSON.stringify(refused)}\n`, stderr: "", code: 0 }),
      answer: refused,
    });
    // A plan, asked of the scan image.
    expect(await boxed.port({ run: false, ask: false })).toEqual({
      result: refused.result,
      surface: "app",
      refusal: refused.refusal,
      login: "qcr scan login",
      notes: [],
    });
    // A host scan's plan, and a driver on the host: this machine's pi.
    const host = world({ answer: refused });
    expect(await host.port({ run: false, ask: false })).not.toHaveProperty("login");
    expect(await host.port({ run: true, ask: false })).not.toHaveProperty("login");
    // A driver inside the sandbox reads the mounted login in its own process.
    host.world.env["QCR_SCAN_AUTH_SRC"] = "/mnt/pi";
    expect(await host.port({ run: true, ask: false })).toMatchObject({ login: "qcr scan login" });
  });

  // Honest-unknown: a sandbox that does not answer is no route and no "no
  // credential" either.
  // MUTATION: answer `{ ok: false, refusal: { code: "no-credential" } }` when
  // the image cannot be asked — a person is told to log in over a docker
  // failure, and this fails.
  it("a sandbox that cannot be asked, or does not answer with a route, leaves the model unknown", async () => {
    const down = world({ image: () => ({ ok: false, stdout: "", stderr: "boom", code: 1 }) });
    expect(await down.port({ run: false, ask: false })).toEqual({
      result: null,
      surface: "app",
      refusal: "the scan sandbox could not be asked: boom",
      notes: [],
    });
    const said = (stdout: string) =>
      world({ image: () => ({ ok: true, stdout, stderr: "", code: 0 }) }).port({
        run: false,
        ask: false,
      });
    expect(await said('{"error":"auth.json cannot be read"}\n')).toMatchObject({
      result: null,
      refusal: "the scan sandbox could not be asked: auth.json cannot be read",
    });
    for (const junk of ['{"result":{"ok":true}}\n', '{"result":{"ok":false}}\n', "[1]\n", "7\n"])
      expect(await said(junk), junk).toMatchObject({
        result: null,
        refusal: "the scan sandbox could not be asked: the scan image did not answer with a route",
      });
  });
});
