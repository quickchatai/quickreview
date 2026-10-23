// SetupEngine (src/setup/engine.ts) — the deterministic half of setup
// & scan, driven the onboarding-engine way: every port faked (an in-memory
// repo, fake case runner / tracker sink / GitHub reader, no memory), the state
// home a temp dir through the real rooted state port. What is asserted is what
// the engine WRITES and RETURNS: facts, the unit cut's persistence and reuse,
// refusals, and the case split.
import { mkdtempSync, readFileSync, rmSync, writeFileSync, mkdirSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  SetupEngine,
  UNIT_CUT_FILE,
  type RepoReader,
  type SetupPorts,
  type UnitCutFile,
} from "../src/setup/engine.js";
import { notYetTrackerSink, stateHomeFs } from "../src/setup/adapters.js";

let stateDir: string;

beforeEach(() => {
  stateDir = mkdtempSync(join(tmpdir(), "qcr-setup-"));
});

afterEach(() => {
  rmSync(stateDir, { recursive: true, force: true });
});

function fakeRepo(
  files: Record<string, string> | null,
  head = "abc123def4567890",
): RepoReader & { files: Record<string, string> | null } {
  const r = {
    files,
    location: "/reviewed-repo",
    listFiles: () => (r.files === null ? null : Object.keys(r.files)),
    read: (p: string) => r.files?.[p] ?? null,
    lines: (p: string) => {
      const t = r.files?.[p];
      return t === undefined ? null : t.split("\n").length - (t.endsWith("\n") ? 1 : 0);
    },
    head: () => head,
  };
  return r;
}

const REPO = {
  "README.md": "# hi\n",
  "backend/manage.py": "import django\n",
  "backend/pyproject.toml": '[project]\ndependencies = ["django>=4"]\n',
  "backend/payments/apps.py": "x\n",
  "backend/payments/models.py": "a\nb\nc\n",
  "backend/users/apps.py": "x\n",
  "backend/users/views.py": "x\n",
  "frontend/package.json": JSON.stringify({ dependencies: { react: "18" } }),
  "frontend/src/app.tsx": "x\n",
  "frontend/node_modules/react/index.js": "x\n",
};

let now = new Date("2026-09-29T10:00:00Z");

function engine(
  repo: RepoReader = fakeRepo({ ...REPO }),
  caseBudget?: { maxFiles: number; maxLines: number },
) {
  const ports: SetupPorts = {
    repo,
    state: stateHomeFs(stateDir),
    clock: () => now,
    memory: null,
    cases: { run: async () => ({ ok: false, reason: "no cases in these tests" }) },
    tracker: notYetTrackerSink(),
    github: { get: async () => ({ ok: false, reason: "no network in tests" }) },
  };
  return new SetupEngine(ports, caseBudget ? { caseBudget } : {});
}

function onDisk(): UnitCutFile {
  return JSON.parse(readFileSync(join(stateDir, UNIT_CUT_FILE), "utf8")) as UnitCutFile;
}

describe("facts", () => {
  it("reads the repo through the port and names the head", () => {
    const r = engine().facts();
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.head).toBe("abc123def4567890");
    expect(r.facts.frameworks.map((f) => f.name)).toEqual(
      expect.arrayContaining(["Django", "React"]),
    );
    expect(r.facts.unit_candidates.map((u) => u.name)).toEqual(
      expect.arrayContaining(["payments", "users", "backend", "frontend", "rest"]),
    );
  });

  it("refuses honestly when the checkout is not there", () => {
    const r = engine(fakeRepo(null)).facts();
    expect(r).toEqual({
      ok: false,
      errors: [expect.stringMatching(/no readable checkout at \/reviewed-repo/)],
    });
  });
});

describe("the unit cut: propose → adjust → save, persisted in the state home", () => {
  it("proposes from the candidates when the companion gives no units, vendored trees ignored", () => {
    const r = engine().propose();
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.draft.ignored).toEqual(["frontend/node_modules"]);
    expect(r.draft.unassigned).toEqual([]);
    const file = onDisk();
    expect(file.saved).toBeNull();
    expect(file.draft).toMatchObject({ source: "candidates", updated_at: now.toISOString() });
  });

  it("stores the companion's proposal as a draft, reporting (not refusing) what save would refuse", () => {
    const r = engine().propose({ units: [{ name: "backend", roots: ["backend"] }] });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.draft.unassigned).toEqual(
      expect.arrayContaining(["README.md", "frontend/src/app.tsx"]),
    );
    expect(r.draft.blocking_save.join("\n")).toMatch(/belong to no unit/);
    expect(onDisk().draft?.source).toBe("companion");
  });

  it("refuses a structurally wrong proposal and stores nothing", () => {
    const r = engine().propose({ units: [{ name: "a", roots: ["nowhere"] }] });
    expect(r.ok).toBe(false);
    expect(existsSync(join(stateDir, UNIT_CUT_FILE))).toBe(false);
  });

  it("save refuses until the draft is a complete partition, then persists and reuses it", () => {
    const e = engine();
    e.propose({ units: [{ name: "backend", roots: ["backend"] }] });
    const refused = e.save();
    expect(refused.ok).toBe(false);
    if (refused.ok) return;
    expect(refused.errors.join("\n")).toMatch(/belong to no unit/);
    expect(onDisk().saved).toBeNull();

    const adjusted = e.adjust([
      { op: "add", name: "rest", roots: [""] },
      { op: "ignore", roots: ["frontend/node_modules"] },
    ]);
    expect(adjusted.ok).toBe(true);
    now = new Date("2026-09-29T11:00:00Z");
    const saved = e.save();
    expect(saved.ok).toBe(true);
    const file = onDisk();
    expect(file.draft).toBeNull();
    expect(file.saved).toMatchObject({
      saved_at: "2026-09-29T11:00:00.000Z",
      head: "abc123def4567890",
      files: 10,
    });
    expect(file.saved!.units.map((u) => u.name)).toEqual(["backend", "rest"]);

    // Reuse: a FRESH engine over the same state home serves the saved cut.
    const again = engine();
    expect(again.savedCut()?.units.map((u) => u.name)).toEqual(["backend", "rest"]);
    const status = again.status();
    expect(status.ok).toBe(true);
    expect(status.saved?.units.find((u) => u.name === "backend")?.files).toBe(6);
    expect(status.draft).toBeNull();
  });

  it("a propose or an adjust never touches the saved cut; a second save keeps the first as previous", () => {
    const e = engine();
    e.propose();
    expect(e.save().ok).toBe(true);
    const first = onDisk().saved!;
    e.adjust([{ op: "rename", unit: "payments", to: "billing" }]);
    expect(onDisk().saved).toEqual(first); // the draft is separate
    expect(e.status().draft?.units.map((u) => u.name)).toContain("billing");
    e.propose({ units: [{ name: "all", roots: [""] }] });
    expect(onDisk().saved).toEqual(first);
    expect(e.save().ok).toBe(true);
    const file = onDisk();
    expect(file.previous).toEqual(first);
    expect(file.saved!.units.map((u) => u.name)).toEqual(["all"]);
  });

  it("adjust starts from the saved cut when there is no draft, and is all-or-nothing", () => {
    const e = engine();
    expect(e.adjust([{ op: "remove", unit: "x" }])).toEqual({
      ok: false,
      errors: ["there is no unit cut to adjust yet — propose one first"],
    });
    e.propose();
    e.save();
    const bad = e.adjust([
      { op: "rename", unit: "payments", to: "billing" },
      { op: "remove", unit: "ghost" },
    ]);
    expect(bad.ok).toBe(false);
    expect(onDisk().draft).toBeNull(); // nothing stored
    const dup = e.adjust([{ op: "rename", unit: "payments", to: "users" }]);
    expect(dup.ok).toBe(false); // the RESULT is checked too
    const good = e.adjust([{ op: "rename", unit: "payments", to: "billing" }]);
    expect(good.ok).toBe(true);
    expect(onDisk().draft?.source).toBe("adjusted");
  });

  it("save with no draft says why", () => {
    const e = engine();
    expect(e.save()).toEqual({
      ok: false,
      errors: ["no draft to save — propose a unit cut first"],
    });
    e.propose();
    e.save();
    expect(e.save()).toEqual({
      ok: false,
      errors: ["no draft to save — the saved cut is already in use; adjust it to start a draft"],
    });
  });

  it("a saved cut the repo has outgrown shows as stale in status — never silently skipped", () => {
    const repo = fakeRepo({ ...REPO });
    const e = engine(repo);
    e.propose({
      units: [
        { name: "backend", roots: ["backend"] },
        { name: "frontend", roots: ["frontend"] },
        { name: "docs", roots: ["README.md"] },
      ],
      ignored: ["frontend/node_modules"],
    });
    expect(e.save().ok).toBe(true);
    repo.files = { ...REPO, "mobile/app.kt": "x\n" };
    const s = e.status();
    expect(s.saved?.unassigned).toEqual(["mobile/app.kt"]);
    expect(s.saved?.blocking_save.join("\n")).toMatch(
      /1 file\(s\) belong to no unit: mobile\/app.kt/,
    );
  });

  it("an unreadable state file is reported and never overwritten", () => {
    mkdirSync(join(stateDir, "setup"), { recursive: true });
    writeFileSync(join(stateDir, UNIT_CUT_FILE), "{ not json");
    const e = engine();
    const s = e.status();
    expect(s.ok).toBe(false);
    expect(s.problems.join("\n")).toMatch(/nothing will overwrite it/);
    const r = e.propose();
    expect(r.ok).toBe(false);
    expect(readFileSync(join(stateDir, UNIT_CUT_FILE), "utf8")).toBe("{ not json");
  });

  it("a hand-edited file of the wrong shape is reported, never a throw — and the saved cut reads UNKNOWN, not absent", () => {
    mkdirSync(join(stateDir, "setup"), { recursive: true });
    const bad = JSON.stringify({
      version: 1,
      saved: { units: [{ name: "x" }], ignored: [] },
      previous: null,
      draft: null,
    });
    writeFileSync(join(stateDir, UNIT_CUT_FILE), bad);
    const e = engine();
    const s = e.status();
    expect(s.ok).toBe(false);
    expect(s.cut_file_unreadable).toBe(true);
    expect(s.saved).toBeNull();
    expect(s.problems.join("\n")).toMatch(/`saved` units\[0\] is not/);
    expect(e.cases().ok).toBe(false);
    expect(e.adjust([{ op: "note", unit: "x", note: "y" }]).ok).toBe(false);
    expect(readFileSync(join(stateDir, UNIT_CUT_FILE), "utf8")).toBe(bad);
  });
});

describe("cases — the saved cut split to fit, names kept", () => {
  it("refuses without a saved cut: nothing runs on a guess", () => {
    const e = engine();
    e.propose();
    expect(e.cases()).toEqual({
      ok: false,
      errors: ["no saved unit cut — propose, adjust and save one first"],
    });
  });

  it("splits an oversized unit into parts that all carry the unit's name, skipping what no pass reads", () => {
    const files: Record<string, string> = { "README.md": "x\n", "big/package-lock.json": "{}\n" };
    for (let i = 0; i < 7; i++) files[`big/mod${i % 3}/f${i}.py`] = "a\nb\n";
    const e = engine(fakeRepo(files), { maxFiles: 3, maxLines: 100 });
    expect(
      e.propose({
        units: [
          { name: "big", roots: ["big"] },
          { name: "rest", roots: [""] },
        ],
      }).ok,
    ).toBe(true);
    expect(e.save().ok).toBe(true);
    const r = e.cases();
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const big = r.cases.filter((c) => c.unit === "big");
    expect(big.length).toBe(3);
    expect(big.map((c) => c.id)).toEqual(["big#1", "big#2", "big#3"]);
    expect(big.flatMap((c) => c.files)).not.toContain("big/package-lock.json");
    expect(big.flatMap((c) => c.files).length).toBe(7);
    // README.md is prose — the sweep's skip list — so rest has no case at all.
    expect(r.cases.filter((c) => c.unit === "rest")).toEqual([]);
    // The status view shows the same split.
    const view = e.status().saved!.units.find((u) => u.name === "big")!;
    expect(view.cases!.map((c) => c.id)).toEqual(["big#1", "big#2", "big#3"]);
    // A caller's filter narrows the files (a scan's stage 1 drops tests).
    const only0 = e.cases((p) => p.includes("/mod0/"));
    expect(only0.ok && only0.cases.map((c) => c.id)).toEqual(["big"]);
  });
});

describe("the later slices' ports are injected and honest", () => {
  it("the not-yet tracker sink refuses, honestly", async () => {
    expect(
      await notYetTrackerSink().file({
        title: "t",
        body: "b",
        effort: "e",
        fingerprint: "f",
      }),
    ).toEqual({
      ok: false,
      reason: "the tracker sink is not wired yet",
    });
  });
});

describe("unknown checkout measurements", () => {
  it("retains saved unit metadata with unknown coverage when the checkout vanishes", () => {
    const repo = fakeRepo({ "src/main.ts": "x\n" });
    const e = engine(repo);
    expect(e.propose({ units: [{ name: "src", roots: [""] }] })).toMatchObject({ ok: true });
    expect(e.save()).toMatchObject({ ok: true });
    repo.files = null;
    const status = e.status();
    expect(status.saved?.units).toEqual([
      expect.objectContaining({
        name: expect.any(String),
        files: null,
        reviewable: null,
        lines: null,
        cases: null,
      }),
    ]);
    expect(status.saved?.ignored_files).toBeNull();
    expect(status.saved?.unassigned).toBeNull();
  });

  it("refuses survey prices for unavailable line counts instead of calling them zero", async () => {
    const repo = fakeRepo({ "src/main.ts": "x\n" });
    const e = engine(repo);
    e.propose({ units: [{ name: "src", roots: [""] }] });
    expect(e.save().ok).toBe(true);
    repo.lines = () => null;
    expect(e.status().saved?.units[0]?.lines).toBeNull();
    const preview = await e.surveyPreview();
    expect(preview).toMatchObject({
      ok: false,
      errors: [expect.stringContaining("line count UNKNOWN")],
    });
  });
});
