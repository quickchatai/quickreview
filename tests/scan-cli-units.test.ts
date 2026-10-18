// `qcr scan units …`, `login` and `doctor` (src/scancli.ts): the unit-cut
// tools of the setup belt (setup_unit_cut / _propose / _adjust / _save) as CLI
// verbs over a real SetupEngine on a scratch checkout and a temp state home,
// and the sandbox's two host-side verbs over their ports.
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { buildEngine, toolDefinitions } from "../extensions/setup.js";
import { parseScanArgs, runScanCli, type ScanCliDeps } from "../src/scancli.js";
import type { SetupEngine } from "../src/setup/engine.js";
import type { DoctorReport } from "../src/scanbox.js";
import { scanRig } from "./helpers/scan-cli-rig.js";

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "qcr-scan-units-"));
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

function engine(): SetupEngine {
  const repo = join(dir, "repo");
  for (const [p, t] of Object.entries({
    "README.md": "# x\n",
    "api/views.py": "a\nb\n",
    "web/package.json": JSON.stringify({ dependencies: { react: "18" } }),
    "web/src/a.tsx": "x\n",
  })) {
    mkdirSync(dirname(join(repo, p)), { recursive: true });
    writeFileSync(join(repo, p), t);
  }
  return buildEngine({
    QCR_REVIEWED_REPO: repo,
    QCR_STATE_HOME: join(dir, "state"),
    QCR_CONFIG_HOME: join(dir, "config"),
  } as NodeJS.ProcessEnv);
}

function harness(over: Partial<ScanCliDeps> = {}) {
  const rig = scanRig({ dir });
  const lines: string[] = [];
  const deps: ScanCliDeps = {
    scan: rig.scan,
    findings: rig.findings,
    settingsOf: rig.settingsOf,
    triage: null,
    afterMatch: null,
    home: rig.home,
    out: (l) => lines.push(l),
    detach: async () => ({ ok: false, errors: ["not here"] }),
    sleep: async () => {},
    now: () => 0,
    ...over,
  };
  // The parsed `--json` object, read field by field.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  type Json = any;
  return {
    run: async (
      args: string[],
      json = false,
    ): Promise<{ code: number; text: string; json: Json }> => {
      lines.length = 0;
      const code = await runScanCli(args, json, deps);
      const text = lines.join("\n");
      return { code, text, json: json ? JSON.parse(text) : null };
    },
  };
}

describe("parsing the new verbs", () => {
  it("reads units show|propose|adjust|save, login and doctor", () => {
    expect(parseScanArgs(["units", "show"])).toEqual({ verb: "units-show" });
    expect(parseScanArgs(["units", "propose"])).toEqual({ verb: "units-propose" });
    expect(parseScanArgs(["units", "propose", "--file", "-"])).toEqual({
      verb: "units-propose",
      file: "-",
    });
    expect(parseScanArgs(["units", "adjust", "--file", "ops.json"])).toEqual({
      verb: "units-adjust",
      file: "ops.json",
    });
    expect(parseScanArgs(["units", "save"])).toEqual({ verb: "units-save" });
    expect(parseScanArgs(["login"])).toEqual({ verb: "login" });
    expect(parseScanArgs(["doctor"])).toEqual({ verb: "doctor" });
    expect(parseScanArgs(["rebuild"])).toEqual({ verb: "rebuild" });
  });

  it("refuses adjust without a file, a bare `units`, and stray flags", () => {
    expect(() => parseScanArgs(["units", "adjust"])).toThrow(/adjust needs --file/);
    expect(() => parseScanArgs(["units"])).toThrow(/usage: qcr scan/);
    expect(() => parseScanArgs(["units", "save", "--file", "x"])).toThrow(/usage/);
    expect(() => parseScanArgs(["doctor", "--wait"])).toThrow(/usage/);
  });
});

describe("qcr scan units", () => {
  it("show: no cut yet, in words and as JSON", async () => {
    const h = harness({ units: engine() });
    const r = await h.run(["units", "show"]);
    expect(r.code).toBe(0);
    expect(r.text).toMatch(/No saved unit cut yet/);
    const j = await h.run(["units", "show"], true);
    expect(j.json).toMatchObject({ ok: true, status: { saved: null } });
  });

  it("propose with no file is the engine's default proposal, worded for the CLI", async () => {
    const e = engine();
    const h = harness({ units: e });
    const r = await h.run(["units", "propose"]);
    expect(r.code).toBe(0);
    expect(r.text).toMatch(/^Draft stored:/);
    expect(r.text).toMatch(/Not in use until qcr scan units save\.$/);
    expect(r.text).not.toMatch(/setup_unit_cut_save/);
    expect(e.status().draft).not.toBeNull();
  });

  it("propose --file reads the units, adjust --file the ops; save makes it the cut", async () => {
    const e = engine();
    const h = harness({ units: e });
    const units = join(dir, "units.json");
    writeFileSync(
      units,
      JSON.stringify({
        units: [
          { name: "api", roots: ["api"] },
          { name: "web", roots: ["web"] },
          { name: "rest", roots: [""] },
        ],
      }),
    );
    const p = await h.run(["units", "propose", "--file", units], true);
    expect(p.code).toBe(0);
    expect(p.json.draft.units.map((u: { name: string }) => u.name)).toEqual(["api", "web", "rest"]);
    const ops = join(dir, "ops.json");
    writeFileSync(ops, JSON.stringify([{ op: "rename", unit: "web", to: "frontend" }]));
    const a = await h.run(["units", "adjust", "--file", ops], true);
    expect(a.code).toBe(0);
    expect(a.json.draft.units.map((u: { name: string }) => u.name)).toContain("frontend");
    // `{ops: […]}` — the tool's own parameter shape — is read too.
    writeFileSync(ops, JSON.stringify({ ops: [{ op: "note", unit: "api", note: "the API" }] }));
    expect((await h.run(["units", "adjust", "--file", ops])).code).toBe(0);
    const s = await h.run(["units", "save"], true);
    expect(s.code).toBe(0);
    expect(s.json.ok).toBe(true);
    expect(e.savedCut()?.units.map((u) => u.name)).toContain("frontend");
    expect((await h.run(["units", "show"])).text).toMatch(/^Saved unit cut/m);
  });

  it("says what the tools say: the same rendering, with the CLI's verb", async () => {
    const e = engine();
    const tool = toolDefinitions(e).find((d) => d.name === "setup_unit_cut_propose")!;
    const viaTool = (await tool.execute("id", {})).content.map((c) => c.text).join("\n");
    const viaCli = (await harness({ units: e }).run(["units", "propose"])).text;
    expect(viaCli).toBe(viaTool.replace("setup_unit_cut_save", "qcr scan units save"));
  });

  it("refusals: an unreadable file, a bad op, a save with no draft", async () => {
    const h = harness({ units: engine() });
    const r = await h.run(["units", "propose", "--file", join(dir, "nope.json")], true);
    expect(r.code).toBe(1);
    expect(r.json.errors[0]).toMatch(/cannot be read as JSON/);
    const ops = join(dir, "ops.json");
    writeFileSync(ops, JSON.stringify([{ op: "explode" }]));
    const a = await h.run(["units", "adjust", "--file", ops]);
    expect(a.code).toBe(1);
    expect(a.text).toMatch(/^Adjustment refused:/);
    const s = await h.run(["units", "save"], true);
    expect(s.code).toBe(1);
    expect(s.json.ok).toBe(false);
  });

  it("no engine in this assembly is a refusal, not a crash", async () => {
    const r = await harness().run(["units", "show"], true);
    expect(r).toMatchObject({ code: 1, json: { ok: false } });
  });
});

describe("qcr scan doctor and login", () => {
  const report: DoctorReport = {
    ok: false,
    sandbox: "docker",
    reviewed_repo: "/host/app",
    checks: [
      { check: "docker", ok: true, detail: "docker 27.1.0" },
      { check: "image", ok: false, detail: "stamp differs", fix: "qcr scan rebuild" },
    ],
  };

  it("doctor prints its report and exits 1 while a check fails, 0 when all pass", async () => {
    const h = harness({ doctor: async () => report });
    const j = await h.run(["doctor"], true);
    expect(j.code).toBe(1);
    expect(j.json).toEqual(report);
    const t = await h.run(["doctor"]);
    expect(t.text).toMatch(/✗ image — stamp differs\n {2}fix: qcr scan rebuild/);
    const ok = harness({
      doctor: async () => ({ ...report, ok: true, checks: [report.checks[0]!] }),
    });
    expect((await ok.run(["doctor"])).code).toBe(0);
  });

  it("rebuild builds the scan image and says no container was touched", async () => {
    const h = harness({
      rebuild: async () => ({ ok: true, image: "qcr-companion", stamp: "abcd" }),
    });
    const t = await h.run(["rebuild"]);
    expect(t.code).toBe(0);
    expect(t.text).toMatch(/^Scan image qcr-companion built \(stamp abcd\)/);
    expect(t.text).toMatch(/no container was stopped or replaced/);
    expect((await h.run(["rebuild"], true)).json).toEqual({
      ok: true,
      image: "qcr-companion",
      stamp: "abcd",
    });
    const no = harness({
      rebuild: async () => ({ ok: false, errors: ["docker build x failed: y"] }),
    });
    expect(await no.run(["rebuild"], true)).toMatchObject({
      code: 1,
      json: { ok: false, errors: ["docker build x failed: y"] },
    });
  });

  it("login hands the terminal over and returns its exit code", async () => {
    let called = 0;
    const h = harness({
      login: async () => {
        called++;
        return 0;
      },
    });
    expect((await h.run(["login"])).code).toBe(0);
    expect(called).toBe(1);
  });

  it("a sandboxed start names its container beside the driver log", async () => {
    const run = { id: "scan-1", mode: "stage1", sha: "a".repeat(40), cases: [], cap_usd: 1 };
    const h = harness({
      detach: async () => ({
        ok: true,
        run: run as never,
        log: "/state/scan/driver.log",
        container: "qcr-scan-default-tok1",
      }),
    });
    const t = await h.run(["start", "--key", "K"]);
    expect(t.code).toBe(0);
    expect(t.text).toMatch(
      /Driver output: \/state\/scan\/driver\.log\nContainer: qcr-scan-default-tok1/,
    );
    const j = await h.run(["start", "--key", "K"], true);
    expect(j.json.container).toBe("qcr-scan-default-tok1");
  });
});
