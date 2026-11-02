// A folder scan (`--path DIR`) at the core's scan-argument seam
// (`parseScanArgs` / `runScanVerb`, driven through `qcr scan`'s runScanCli
// over a ScanRunner with faked ports, tests/helpers/scan-cli-rig.ts) and at
// stage 1's and stage 2's planning: the cases narrowed to the folder with
// their unit names kept, a delta inside it, stage 2's rows and floor inside
// it, the refusals (exit 2, nothing planned, priced or run), the no-cut stop
// and the payload's `path`.
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { parseScanArgs, runScanCli, type ScanCliDeps } from "../src/scancli.js";
import type { CaseSpec } from "../src/setup/engine.js";
import { planStage1, scanPath } from "@quickchatai/pi-quickreview/src/scan/scan.js";
import { planStage2 } from "@quickchatai/pi-quickreview/src/scan/stage2.js";
import type { UnitCut } from "../src/setup/unitcut.js";
import { SHA, SHA2, scanRig, type Rig } from "./helpers/scan-cli-rig.js";

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "qcr-scan-path-"));
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

const TREE: Record<string, string> = {
  "app/a.py": "a1\na2\na3\n",
  "app/web/v.py": "v1\nv2\n",
  "app/web/w.py": "w1\nw2\n",
  "app/web/tests/test_v.py": "t\n",
  "tests/app/web/test_v.py": "t\n",
  "lib/b.py": "x\ny\n",
  "lib/tests/test_b.py": "t\n",
};

interface Harness {
  rig: Rig;
  ran: CaseSpec[];
  detached: string[][];
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  run(args: string[], json?: boolean): Promise<{ code: number; text: string; json: any }>;
}

function harness(
  o: { trees?: Record<string, Record<string, string>>; cut?: UnitCut | null } = {},
): Harness {
  const ran: CaseSpec[] = [];
  const rig = scanRig({
    dir,
    trees: o.trees ?? { [SHA]: TREE },
    ran,
    ...(o.cut !== undefined ? { cut: o.cut } : {}),
  });
  const lines: string[] = [];
  const detached: string[][] = [];
  const deps: ScanCliDeps = {
    scan: rig.scan,
    findings: rig.findings,
    settingsOf: rig.settingsOf,
    triage: null,
    afterMatch: null,
    home: rig.home,
    out: (l) => lines.push(l),
    // The detached driver, faked: the foreground driver in this process,
    // its start outcome passed back as the real one is.
    detach: async (argv) => {
      detached.push(argv);
      const said: string[] = [];
      const r = await runScanCli([...argv, "--foreground"], true, {
        ...deps,
        out: (l) => said.push(l),
      });
      if (r === 0) return { ok: true, run: rig.scan.status().run!, log: "/state/scan/driver.log" };
      const errors = (JSON.parse(said.join("")) as { errors: string[] }).errors;
      return r === 2 ? { ok: false, errors, usage: true } : { ok: false, errors };
    },
    sleep: async () => {
      await rig.scan.idle();
    },
    now: () => Date.parse("2026-09-29T12:00:00Z"),
  };
  return {
    rig,
    ran,
    detached,
    run: async (args, json = false) => {
      lines.length = 0;
      const code = await runScanCli(args, json, deps);
      const text = lines.join("\n");
      return { code, text, json: json ? JSON.parse(text) : null };
    },
  };
}

/** The files a preview's cases read, by case, as the runner would hand them. */
async function previewOf(h: Harness, args: string[]) {
  const r = await h.run(["preview", ...args], true);
  expect(r.code, r.text).toBe(0);
  return r.json.preview as {
    key: string;
    mode: string;
    path: string | null;
    cases: Array<{ id: string; files: number }>;
    files: number;
    excluded: Record<string, number>;
  };
}

/** Run the whole repo once, so stage 1 is priced and every file read. */
async function scanWhole(h: Harness): Promise<void> {
  const p = await h.run(["preview"], true);
  const s = await h.run(["start", ...p.json.start, "--foreground"], true);
  expect(s.code, s.text).toBe(0);
}

describe("--path at the argument seam", () => {
  it("is one folder inside the repo, normalised; `.` is the whole repo", () => {
    expect(parseScanArgs(["preview", "--path", "./app/web/"])).toEqual({
      verb: "preview",
      delta: false,
      path: "app/web",
    });
    expect(parseScanArgs(["preview", "--path", "."])).toEqual({ verb: "preview", delta: false });
    expect(parseScanArgs(["start", "--key", "k", "--path", "app//web", "--delta"])).toEqual({
      verb: "start",
      key: "k",
      delta: true,
      path: "app/web",
      foreground: false,
    });
    expect(parseScanArgs(["stage2", "propose", "--path", "app"])).toMatchObject({
      verb: "stage2-propose",
      path: "app",
    });
    expect(scanPath("a/b/../c")).toEqual({ ok: true, path: "a/c" });
  });

  it("refuses an absolute path, one that leaves the repo, and --path on a verb that has none", () => {
    expect(() => parseScanArgs(["preview", "--path", "/etc"])).toThrow(/absolute/);
    expect(() => parseScanArgs(["preview", "--path", "C:/repo"])).toThrow(/absolute/);
    expect(() => parseScanArgs(["preview", "--path", "../other"])).toThrow(/leaves the repo/);
    expect(() => parseScanArgs(["start", "--key", "k", "--path", "app/../../x"])).toThrow(
      /leaves the repo/,
    );
    expect(() => parseScanArgs(["preview", "--path"])).toThrow(/usage/);
    expect(() => parseScanArgs(["status", "--path", "app"])).toThrow(/usage/);
  });
});

describe("a folder scan's stage 1", () => {
  // MUTATION: drop the `underPath` filter at the top of planStage1 — the
  // folder's preview plans lib/b.py and app/a.py too, and this fails.
  it("narrows the cases to the folder, keeps the unit's name, and applies exclusions inside it", async () => {
    const h = harness();
    const whole = await previewOf(h, []);
    const web = await previewOf(h, ["--path", "app/web"]);
    expect(whole.path).toBeNull();
    expect(web.path).toBe("app/web");
    // unit `app` is only partly inside: it keeps its name and brings the
    // two files it has there
    expect(web.cases).toEqual([expect.objectContaining({ id: "app", files: 2 })]);
    expect(web.files).toBe(2);
    expect(whole.files).toBe(4);
    // the tests are left out as always, counted only inside the folder
    expect(web.excluded.test).toBe(1);
    expect(whole.excluded.test).toBe(3);
    const human = await h.run(["preview", "--path", "app/web"]);
    expect(human.text).toMatch(/of app\/web\/ at aaaaaaaaaaaa/);
    expect(human.text).toMatch(/qcr scan start --key \w+ --sha a{40} --path app\/web/);
  });

  // MUTATION: leave `path` out of the preview's planKey — the second tree's
  // two folders plan the same cases and then share a key, and this fails.
  it("puts the path in the key: a preview of one folder never starts a run over another", async () => {
    const h = harness();
    const web = await previewOf(h, ["--path", "app/web"]);
    const app = await previewOf(h, ["--path", "app"]);
    const whole = await previewOf(h, []);
    expect(new Set([web.key, app.key, whole.key]).size).toBe(3);
    // a tree where `app` holds only what `app/web` holds: the same cases,
    // still another key
    const same = harness({
      trees: { [SHA]: { "app/web/v.py": "v\n", "lib/b.py": "x\n" } },
    });
    const a = await previewOf(same, ["--path", "app"]);
    const b = await previewOf(same, ["--path", "app/web"]);
    expect(a.cases).toEqual(b.cases);
    expect(a.key).not.toBe(b.key);

    for (const other of [["--path", "app"], []]) {
      const r = await h.run(["start", "--key", web.key, ...other, "--foreground"], true);
      expect(r.code).toBe(1);
      expect(r.json.errors.join("\n")).toMatch(/plan changed since that preview/);
    }
    expect(h.ran).toEqual([]);
  });

  it("starts exactly the folder's run, and the run and its payload name the folder", async () => {
    const h = harness();
    const p = await h.run(["preview", "--path", "app/web"], true);
    expect(p.json.start).toEqual(["--key", p.json.preview.key, "--sha", SHA, "--path", "app/web"]);
    // a detached start carries --path to the driver (a host process or the
    // scan sandbox's container alike: both run these arguments)
    const d = await h.run(["start", ...p.json.start], true);
    expect(d.code, d.text).toBe(0);
    expect(h.detached).toEqual([["start", ...p.json.start]]);
    expect(d.json.run).toMatchObject({ mode: "calibration", sha: SHA, path: "app/web" });
    await h.rig.scan.idle();
    expect(h.ran.flatMap((c) => c.files).sort()).toEqual(["app/web/v.py", "app/web/w.py"]);
    expect(h.ran.map((c) => c.unit)).toEqual(["app"]);
    const s = await h.run(["status"], true);
    expect(s.json.run).toMatchObject({ path: "app/web", state: "complete" });
    const f = await h.run(["findings"], true);
    for (const x of f.json.findings) expect(x.file).toMatch(/^app\/web\//);
    // a whole-repo run says null
    const whole = harness();
    await scanWhole(whole);
    expect((await whole.run(["status"], true)).json.run.path).toBeNull();
  });

  it("composes with --delta: only the folder's changed files are read again", async () => {
    const changed = { ...TREE, "app/web/v.py": "v1\nv2\nv3\n", "lib/b.py": "x\ny\nz\n" };
    const h = harness({ trees: { [SHA]: TREE, [SHA2]: changed } });
    await scanWhole(h);
    const whole = await previewOf(h, ["--delta", "--sha", SHA2]);
    expect(whole.mode).toBe("delta");
    expect(whole.files).toBe(2);
    const web = await previewOf(h, ["--delta", "--sha", SHA2, "--path", "app/web"]);
    expect(web).toMatchObject({ mode: "delta", path: "app/web", files: 1 });
    expect(web.cases).toEqual([expect.objectContaining({ id: "app", files: 1 })]);
    const p = await h.run(["preview", "--delta", "--sha", SHA2, "--path", "app/web"], true);
    expect(p.json.start).toEqual(["--key", web.key, "--sha", SHA2, "--delta", "--path", "app/web"]);
    h.ran.length = 0;
    const s = await h.run(["start", ...p.json.start, "--foreground"], true);
    expect(s.code, s.text).toBe(0);
    expect(h.ran.flatMap((c) => c.files)).toEqual(["app/web/v.py"]);
    // the ledger now covers the folder, so it has nothing left there; the
    // rest of the repo still owes its changed file
    const after = await h.run(["preview", "--delta", "--sha", SHA2, "--path", "app/web"], true);
    expect(after.json.preview.blockers.join("\n")).toMatch(
      /nothing changed to read under app\/web/,
    );
    expect((await previewOf(h, ["--delta", "--sha", SHA2])).files).toBe(1);
  });
});

describe("refusals", () => {
  // MUTATION: drop `usage: true` from scopeOf's refusals — a path that names
  // no folder exits 1, and this fails.
  it("a path that is absolute, leaves the repo, or names no folder at the sha exits 2, and nothing is priced or run", async () => {
    const h = harness();
    for (const [path, why] of [
      ["/abs/app", /absolute/],
      ["../up", /leaves the repo/],
      ["nope", /not a folder in the tree at aaaaaaaaaaaa/],
      ["app/a.py", /is a file, not a folder/],
    ] as const) {
      const pv = await h.run(["preview", "--path", path], true);
      expect(pv.code, path).toBe(2);
      expect(pv.json.ok).toBe(false);
      expect(pv.json.errors.join("\n")).toMatch(why);
      for (const fg of [["--foreground"], []]) {
        const st = await h.run(["start", "--key", "k", "--path", path, ...fg], true);
        expect(st.code, `${path} ${fg.join(" ")}`).toBe(2);
        expect(st.json.errors.join("\n")).toMatch(why);
      }
      const s2 = await h.run(["stage2", "propose", "--deep", "--path", path], true);
      expect(s2.code, path).toBe(2);
    }
    expect((await h.run(["preview", "--path", "nope"])).text).toMatch(
      /Scan preview refused:\n✗ --path nope is not a folder/,
    );
    // a folder of another commit's tree is no folder of this one
    const two = harness({ trees: { [SHA]: TREE, [SHA2]: { "lib/b.py": "x\n" } } });
    expect((await two.run(["preview", "--sha", SHA2, "--path", "app"], true)).code).toBe(2);
    // nothing was planned into a run, nothing ran
    expect(h.ran).toEqual([]);
    expect(h.rig.scan.status().run).toBeNull();
  });

  it("with no unit cut, a folder scan stops and asks exactly as a whole-repo scan does", async () => {
    const h = harness({ cut: null });
    const whole = await h.run(["preview"], true);
    const web = await h.run(["preview", "--path", "app/web"], true);
    expect(whole.code).toBe(1);
    expect(web.code).toBe(1);
    expect(web.json).toEqual(whole.json);
    expect(web.json.errors.join("\n")).toMatch(/no saved unit cut/);
    expect(
      (await h.run(["start", "--key", "k", "--path", "app/web", "--foreground"], true)).json,
    ).toEqual((await h.run(["start", "--key", "k", "--foreground"], true)).json);
    expect(h.ran).toEqual([]);
  });
});

describe("a folder proposal's stage 2", () => {
  // MUTATION: drop the `underPath` check on a row's named files in
  // planStage2 — the lib/b.py row is planned, and this fails.
  it("names only files under the folder: its rows, their paired tests and the deep floor", async () => {
    const h = harness();
    await scanWhole(h);
    const rows = join(dir, "rows.json");
    writeFileSync(
      rows,
      JSON.stringify([{ lens: "pass-security", files: ["lib/b.py"], reason: "auth" }]),
    );
    const out = await h.run(["stage2", "propose", "--rows", rows, "--path", "app/web"], true);
    expect(out.code).toBe(1);
    expect(out.json.errors.join("\n")).toMatch(/lib\/b\.py is outside the scan's --path app\/web/);

    writeFileSync(
      rows,
      JSON.stringify([{ lens: "pass-security", files: ["app/web/v.py"], reason: "auth" }]),
    );
    const own = await h.run(["stage2", "propose", "--rows", rows, "--path", "app/web"], true);
    expect(own.code, own.text).toBe(0);
    expect(own.json.proposal.path).toBe("app/web");
    // the test beside it pairs; the one outside the folder does not
    expect(own.json.proposal.row_list[0]).toMatchObject({
      files: ["app/web/v.py"],
      tests: ["app/web/tests/test_v.py"],
    });
    const wide = await h.run(["stage2", "propose", "--rows", rows], true);
    expect(wide.json.proposal.path).toBeNull();
    expect(wide.json.proposal.row_list[0].tests).toContain("tests/app/web/test_v.py");
    expect(wide.json.proposal.key).not.toBe(own.json.proposal.key);

    const deep = await h.run(["stage2", "propose", "--deep", "--path", "app/web"], true);
    expect(deep.code, deep.text).toBe(0);
    expect(deep.json.proposal.floor_rows).toBeGreaterThan(0);
    const named = deep.json.proposal.row_list.flatMap((r: { files: string[]; tests: string[] }) => [
      ...r.files,
      ...r.tests,
    ]);
    expect(named.length).toBeGreaterThan(0);
    for (const f of named) expect(f).toMatch(/^app\/web\//);
    const human = await h.run(["stage2", "propose", "--deep", "--path", "app/web"]);
    expect(human.text).toMatch(/STAGE 2 proposal \(deep\) of app\/web\/ at/);

    // the start re-plans inside the folder: its cases read only the folder
    h.ran.length = 0;
    const s = await h.run(
      ["stage2", "start", "--key", deep.json.proposal.key, "--foreground"],
      true,
    );
    expect(s.code, JSON.stringify(s.json)).toBe(0);
    expect(h.ran.length).toBeGreaterThan(0);
    for (const c of h.ran) for (const f of c.files) expect(f).toMatch(/^app\/web\//);
  });
});

describe("the planners, pure", () => {
  const cut: UnitCut = {
    units: [
      { name: "core", roots: ["app/web", "lib"], kind: "directory", note: "" },
      { name: "app", roots: ["app"], kind: "directory", note: "" },
    ],
    ignored: [],
  };
  const files = Object.keys(TREE).map((path) => ({ path, blob: `b-${path}` }));
  const base = {
    cut,
    files,
    linesOf: (p: string) => TREE[p]!.split("\n").length - 1,
    covered: new Set<string>(),
    exclude: [],
    budget: { maxFiles: 30, maxLines: 1200 },
  };

  it("stage 1: a unit spanning the folder's edge contributes only its files inside, under its own name", () => {
    const plan = planStage1({ ...base, path: "lib" });
    expect(plan.cases.map((c) => [c.id, c.files.map((f) => f.path)])).toEqual([
      ["core", ["lib/b.py"]],
    ]);
    expect(planStage1({ ...base, path: null }).cases.map((c) => c.id)).toEqual(["core", "app"]);
  });

  it("stage 2: the floor covers only the folder", () => {
    const plan = planStage2({
      ...base,
      rows: [],
      riskPasses: [],
      defaultTier: "sol-high" as never,
      covered: () => new Set(),
      price: () => ({ rate: { usd_per_kline: 1 } }) as never,
      budgetUsd: null,
      floor: ["pass-security"],
      path: "app",
    });
    if (!plan.ok) throw new Error(plan.errors.join("; "));
    const named = plan.rows.flatMap((r) => r.files.map((f) => f.path));
    expect(named.sort()).toEqual(["app/a.py", "app/web/v.py", "app/web/w.py"]);
    expect(new Set(plan.rows.map((r) => r.reason))).toEqual(
      new Set(["deep floor: pass-security over core", "deep floor: pass-security over app"]),
    );
  });
});
