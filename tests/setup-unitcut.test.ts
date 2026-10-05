// The unit cut as a value (src/setup/unitcut.ts): longest-prefix
// assignment, validation, the all-or-nothing adjust ops, and the case split —
// an oversized unit split to fit, every case under the unit's own name.
import { describe, expect, it } from "vitest";
import {
  applyOps,
  assign,
  checkCut,
  normalizeCut,
  normalizeRoot,
  splitUnit,
  type UnitCut,
} from "../src/setup/unitcut.js";

const FILES = [
  "README.md",
  "backend/manage.py",
  "backend/payments/models.py",
  "backend/payments/views.py",
  "backend/users/models.py",
  "backend/vendor/lib.py",
  "frontend/src/app.tsx",
];

function unit(name: string, ...roots: string[]): UnitCut["units"][number] {
  return { name, roots, kind: "custom", note: "" };
}

describe("assign — longest prefix wins", () => {
  it("nests units, carves ignored trees out, and lets a root catch the rest", () => {
    const cut: UnitCut = {
      units: [unit("backend", "backend"), unit("payments", "backend/payments"), unit("rest", "")],
      ignored: ["backend/vendor"],
    };
    const a = assign(cut, FILES);
    expect(a.byUnit.get("payments")).toEqual([
      "backend/payments/models.py",
      "backend/payments/views.py",
    ]);
    expect(a.byUnit.get("backend")).toEqual(["backend/manage.py", "backend/users/models.py"]);
    expect(a.byUnit.get("rest")).toEqual(["README.md", "frontend/src/app.tsx"]);
    expect(a.ignored).toEqual(["backend/vendor/lib.py"]);
    expect(a.unassigned).toEqual([]);
  });

  it("matches on segment boundaries, never on a bare string prefix", () => {
    const a = assign({ units: [unit("back", "back")], ignored: [] }, ["backend/x.py", "back/y.py"]);
    expect(a.byUnit.get("back")).toEqual(["back/y.py"]);
    expect(a.unassigned).toEqual(["backend/x.py"]);
  });
});

describe("checkCut", () => {
  it("refuses bad names, duplicates and roots that match nothing", () => {
    const { errors } = checkCut(
      {
        units: [unit("../x", "backend"), unit("a", "backend"), unit("a", "nowhere")],
        ignored: [],
      },
      FILES,
    );
    expect(errors.join("\n")).toMatch(/not a plain name/);
    expect(errors.join("\n")).toMatch(/used twice/);
    expect(errors.join("\n")).toMatch(/claimed by both/);
    expect(errors.join("\n")).toMatch(/"nowhere".*matches no file/);
  });

  it("separates save-blocking conditions: unclaimed files and a unit left empty", () => {
    const { errors, blocking_save } = checkCut(
      {
        units: [unit("backend", "backend"), unit("inner", "backend/payments")],
        ignored: ["backend/payments"],
      },
      FILES,
    );
    expect(errors.join("\n")).toMatch(/both ignored and owned/);
    const second = checkCut(
      {
        units: [unit("outer", "backend/users"), unit("inner", "backend/users/models.py")],
        ignored: [],
      },
      FILES,
    );
    expect(second.errors).toEqual([]);
    expect(second.blocking_save.join("\n")).toMatch(/"outer" ends up with no files/);
    expect(second.blocking_save.join("\n")).toMatch(/file\(s\) belong to no unit/);
    expect(blocking_save).toEqual([]);
  });
});

describe("normalizeCut / normalizeRoot", () => {
  it("normalises spellings and refuses anything that leaves the repo", () => {
    expect(normalizeRoot("./backend/")).toBe("backend");
    expect(normalizeRoot("/backend//payments/")).toBe("backend/payments");
    expect(normalizeRoot(".")).toBe("");
    expect(normalizeRoot("backend/../../etc")).toBeNull();
    const bad = normalizeCut({ units: [{ name: "x", roots: ["../up"] }] });
    expect(bad.ok).toBe(false);
    const good = normalizeCut({ units: [{ name: " x ", roots: "./a/", kind: "nonsense" }] });
    expect(good).toEqual({
      ok: true,
      cut: { units: [{ name: "x", roots: ["a"], kind: "custom", note: "" }], ignored: [] },
    });
    expect(normalizeCut({ units: [{ name: "x", roots: [""] }], ignored: [""] }).ok).toBe(false);
  });
});

describe("applyOps — all or nothing", () => {
  const base: UnitCut = {
    units: [unit("backend", "backend"), unit("frontend", "frontend"), unit("rest", "")],
    ignored: [],
  };

  it("renames, adds (taking the root from whoever held it), merges, moves and ignores", () => {
    const r = applyOps(base, [
      { op: "add", name: "payments", roots: ["backend/payments"], kind: "django-app" },
      { op: "rename", unit: "frontend", to: "web" },
      { op: "ignore", roots: ["backend/vendor"] },
      { op: "merge", units: ["web", "rest"], into: "everything-else" },
      { op: "move", root: "backend/payments", to: "backend" },
    ]);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const names = r.cut.units.map((u) => u.name);
    expect(names).toEqual(["backend", "everything-else", "payments"]);
    expect(r.cut.units.find((u) => u.name === "everything-else")!.roots).toEqual(["frontend", ""]);
    expect(r.cut.units.find((u) => u.name === "backend")!.roots).toEqual([
      "backend",
      "backend/payments",
    ]);
    expect(r.cut.units.find((u) => u.name === "payments")!.roots).toEqual([]);
    expect(r.cut.ignored).toEqual(["backend/vendor"]);
    // The input is never mutated.
    expect(base.units.map((u) => u.name)).toEqual(["backend", "frontend", "rest"]);
  });

  it("refuses the whole batch when one op is wrong", () => {
    const r = applyOps(base, [
      { op: "rename", unit: "backend", to: "api" },
      { op: "remove", unit: "nope" },
      { op: "explode" },
    ]);
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.errors.join("\n")).toMatch(/no unit named "nope"/);
    expect(r.errors.join("\n")).toMatch(/unknown op "explode"/);
  });

  it("refuses a note op without a note rather than silently doing nothing", () => {
    const r = applyOps(base, [{ op: "note", unit: "backend" }]);
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.errors.join("\n")).toMatch(/note needs `note`/);
  });
});

describe("splitUnit — an oversized unit split to fit, its name kept", () => {
  const lines = (n: number) => () => n;

  it("keeps a unit that fits as ONE case under its own name", () => {
    const cases = splitUnit("payments", ["p/a.py", "p/b.py"], lines(10), {
      maxFiles: 5,
      maxLines: 100,
    });
    expect(cases).toEqual([
      {
        unit: "payments",
        id: "payments",
        part: 1,
        parts: 1,
        files: ["p/a.py", "p/b.py"],
        lines: 20,
        over_budget: false,
      },
    ]);
  });

  it("splits by subdirectory first, then by file chunks, every case named for the unit", () => {
    const files = [
      "app/api/a.py",
      "app/api/b.py",
      "app/api/c.py",
      "app/models/a.py",
      "app/models/b.py",
      "app/x.py",
      "app/y.py",
      "app/z.py",
    ];
    const cases = splitUnit("app", files, lines(10), { maxFiles: 3, maxLines: 1000 });
    expect(cases.map((c) => c.unit)).toEqual(["app", "app", "app"]);
    expect(cases.map((c) => c.id)).toEqual(["app#1", "app#2", "app#3"]);
    expect(cases.map((c) => c.files)).toEqual([
      ["app/api/a.py", "app/api/b.py", "app/api/c.py"],
      ["app/models/a.py", "app/models/b.py"],
      ["app/x.py", "app/y.py", "app/z.py"],
    ]);
    // Every file lands in exactly one case.
    expect(cases.flatMap((c) => c.files).sort()).toEqual([...files].sort());
    expect(cases.every((c) => c.parts === 3)).toBe(true);
  });

  it("packs small neighbouring directories back together", () => {
    const files = ["u/a/1.py", "u/b/1.py", "u/c/1.py", "u/d/1.py", "u/d/2.py", "u/d/3.py"];
    const cases = splitUnit("u", files, lines(10), { maxFiles: 3, maxLines: 1000 });
    expect(cases.map((c) => c.files)).toEqual([
      ["u/a/1.py", "u/b/1.py", "u/c/1.py"],
      ["u/d/1.py", "u/d/2.py", "u/d/3.py"],
    ]);
  });

  it("splits by lines as well as files, and never cuts a file in half", () => {
    const sizes: Record<string, number> = { "m/big.py": 5000, "m/a.py": 40, "m/b.py": 40 };
    const cases = splitUnit("m", Object.keys(sizes), (p) => sizes[p]!, {
      maxFiles: 30,
      maxLines: 100,
    });
    expect(cases.map((c) => [c.files, c.over_budget])).toEqual([
      [["m/a.py", "m/b.py"], false],
      [["m/big.py"], true],
    ]);
    expect(cases.every((c) => c.unit === "m")).toBe(true);
  });

  it("is deterministic regardless of input order", () => {
    const files = Array.from({ length: 40 }, (_, i) => `z/d${i % 7}/f${i}.py`);
    const a = splitUnit("z", files, lines(50), { maxFiles: 6, maxLines: 250 });
    const b = splitUnit("z", [...files].reverse(), lines(50), { maxFiles: 6, maxLines: 250 });
    expect(a).toEqual(b);
    for (const c of a) expect(c.files.length <= 6 && c.lines <= 250).toBe(true);
  });
});
