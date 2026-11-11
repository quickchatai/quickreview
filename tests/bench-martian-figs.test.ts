// bench/aacr/martian_figs.py and martian_figvalues.py — the eight Martian figures' numbers come
// from shipped data, never from a value typed into the drawing script:
//
//   1. martian_figs.py draws every value charts/martian-figs.json holds: run under a recording
//      stand-in for matplotlib and numpy (the suite has neither), each value moved by one unit
//      moves what some figure draws;
//   2. martian_figs.py holds no module-level table of numbers (a figure's data typed in);
//   3. martian_figvalues.check fails a value that prints differently from the committed copy, and a
//      committed key or run list that differs from VALUES; with --partial it skips, never passes,
//      the values only --martian gives;
//   4. martian_figvalues.Opus scores a tool the way Martian's own scorer does: its false negatives
//      are the entry's own list (a golden its judge left out of both lists is in neither), skipped
//      entries are left out, and only Core categories count;
//   5. every committed value names its key and at least one run or table it reads;
//   6. martian_figs.py stamps no time into a PDF or SVG and salts the SVG ids (a redraw is the same
//      bytes), and has no default output directory (a bare run never writes over charts/);
//   7. showcase/refresh_v3.py's idea builder skips an idea whose unpublished source is absent (the
//      Martian check's write-up, the Qodo hand labels), keeping its committed entry, instead of failing.
//
// The check against the real release (`martian_figvalues.py --check` with --data, --archive and
// --martian) is in the module's docstring; this file needs no data.

import { afterAll, describe, expect, it } from "vitest";
import { spawnSync } from "node:child_process";
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const AACR = join(ROOT, "bench", "aacr");
const CHARTS = join(AACR, "charts");
const tmp = mkdtempSync(join(tmpdir(), "bench-martian-figs-"));
afterAll(() => rmSync(tmp, { recursive: true, force: true }));

function py(code: string, ...args: string[]): unknown {
  const p = spawnSync(
    "python3",
    ["-c", `import sys, json; sys.path.insert(0, ${JSON.stringify(AACR)})\n${code}`, ...args],
    {
      encoding: "utf8",
      cwd: ROOT,
    },
  );
  if (p.status !== 0) throw new Error(p.stderr);
  return JSON.parse(p.stdout);
}

type FigValues = { values: Record<string, { value: number; q: string; runs: string[] }> };
const committed = JSON.parse(readFileSync(join(CHARTS, "martian-figs.json"), "utf8")) as FigValues;

// A stand-in for matplotlib and numpy: every call is recorded with its arguments, every result is
// another recorder, so the log is what the figures would draw.
const STUB = `
import sys, types
LOG = []
def _r(x):
    if isinstance(x, R): return "R"
    if isinstance(x, float): return round(x, 9)
    if isinstance(x, (list, tuple)): return [_r(v) for v in x]
    if isinstance(x, dict): return {str(k): _r(v) for k, v in x.items()}
    return x if isinstance(x, (int, str, bool, type(None))) else type(x).__name__
class R:
    def __init__(self, name="R"): self._n = name
    def __getattr__(self, k):
        if k.startswith("__"): raise AttributeError(k)
        return R(self._n + "." + k)
    def __call__(self, *a, **kw):
        LOG.append((self._n.split(".")[-1], _r(list(a)), _r(kw)))
        return R(self._n + "()")
    def __iter__(self): return iter([R(self._n + "[0]"), R(self._n + "[1]")])
    def __getitem__(self, k): return R(self._n + "[]")
    def __bool__(self): return False
    def _op(self, *o): return R(self._n + "~")
    __add__ = __radd__ = __sub__ = __rsub__ = __mul__ = __rmul__ = __truediv__ = __rtruediv__ = _op
    __gt__ = __lt__ = __ge__ = __le__ = __and__ = __rand__ = _op
mpl = types.ModuleType("matplotlib"); mpl.use = lambda *a, **k: None
plt = types.ModuleType("matplotlib.pyplot"); plt.__getattr__ = lambda k: R("plt." + k)
np = types.ModuleType("numpy"); np.__getattr__ = lambda k: R("np." + k)
mpl.pyplot = plt
sys.modules.update({"matplotlib": mpl, "matplotlib.pyplot": plt, "numpy": np})
import runpy
def draw(script):
    del LOG[:]
    g = runpy.run_path(script, run_name="figs")
    for f in ("fig_audit", "fig_real_vs_trivia", "fig_extended_key", "fig_composition", "fig_policy",
              "fig_allfound", "fig_leaderboard", "fig_strength"):
        g[f]()
    return json.dumps(LOG, sort_keys=True)
`;

function figTree(name: string): string {
  // a copy of the script beside copies of every input it reads, so a test can change one
  const dir = join(tmp, name);
  mkdirSync(join(dir, "charts"), { recursive: true });
  mkdirSync(join(dir, "ext", "martian-tuning"), { recursive: true });
  copyFileSync(join(AACR, "martian_figs.py"), join(dir, "martian_figs.py"));
  for (const f of ["martian-data.json", "martian-tiers.json", "martian-figs.json"]) {
    copyFileSync(join(CHARTS, f), join(dir, "charts", f));
  }
  copyFileSync(
    join(AACR, "ext", "martian-tuning", "tune20-leaderboard.txt"),
    join(dir, "ext", "martian-tuning", "tune20-leaderboard.txt"),
  );
  return dir;
}

describe("martian_figs.py draws from the shipped values", () => {
  it("moves some figure for every value martian-figs.json holds", () => {
    // MUTATION: in martian_figs.py, draw `100 * v["real"] / 86` and the label "of 86" in place of
    // F["goldens/real"] — goldens/real then moves nothing, and this fails.
    const dir = figTree("draws");
    const moved = py(
      `${STUB}
script = sys.argv[1] + "/martian_figs.py"; vals = sys.argv[1] + "/charts/martian-figs.json"
doc = json.load(open(vals)); base = draw(script); still = []
for name, v in doc["values"].items():
    d = json.loads(json.dumps(doc))
    d["values"][name]["value"] = v["value"] + 1
    json.dump(d, open(vals, "w"))
    if draw(script) == base:
        still.append(name)
json.dump(doc, open(vals, "w"))
print(json.dumps({"n": len(doc["values"]), "still": still}))`,
      dir,
    ) as { n: number; still: string[] };
    expect(moved.n).toBe(Object.keys(committed.values).length);
    expect(moved.still).toEqual([]);
  }, 60_000);

  it("holds no module-level table of numbers", () => {
    // MUTATION: add back `QR_EST = (43.5, 45.6)` (or the typed FAIR table) at module level in
    // martian_figs.py — this fails naming it.
    const typed = py(
      `import ast
tree = ast.parse(open(sys.argv[1]).read())
def nums(n): return any(isinstance(x, ast.Constant) and type(x.value) in (int, float) for x in ast.walk(n))
out = []
for node in tree.body:
    if isinstance(node, ast.Assign) and isinstance(node.value, (ast.List, ast.Tuple)) and nums(node.value):
        out += [t.id for t in node.targets if isinstance(t, ast.Name)]
print(json.dumps(out))`,
      join(AACR, "martian_figs.py"),
    );
    expect(typed).toEqual([]);
  });
});

describe("martian_figs.py writes reproducible files, and only where it is told", () => {
  it("strips every timestamp and salts the SVG ids, so a redraw is byte for byte the same", () => {
    // MUTATION: drop `metadata=METADATA[ext]` from martian_figs.save — the PDFs and SVGs then
    // carry their draw time, and this fails.
    // MUTATION: drop "svg.hashsalt" from martian_figs.py's rcParams — the SVG ids are then random
    // per redraw, and this fails.
    const r = py(
      `${STUB}
log = json.loads(draw(sys.argv[1] + "/martian_figs.py"))
saves = [(a[0], kw.get("metadata")) for n, a, kw in log if n == "savefig"]
salt = [a[0].get("svg.hashsalt") for n, a, kw in log if n == "update" and a and isinstance(a[0], dict)]
print(json.dumps({"saves": saves, "salt": salt}))`,
      figTree("repro"),
    ) as { saves: [string, unknown][]; salt: unknown[] };
    expect(r.saves).toHaveLength(24);
    for (const [path, meta] of r.saves) {
      const ext = path.split(".").pop();
      expect(meta, path).toEqual(
        ext === "pdf" ? { CreationDate: null } : ext === "svg" ? { Date: null } : {},
      );
    }
    expect(r.salt.filter((x) => typeof x === "string" && x.length > 0)).toHaveLength(1);
  }, 60_000);

  it("has no default output: with no --out and no QCR_CHARTS_OUT it refuses, and --out is used", () => {
    // MUTATION: give martian_figs.py's --out the default charts/ (OUT) again — the bare run then
    // redraws the committed figures, and this fails.
    const r = py(
      `${STUB}
import os, runpy, io, contextlib
os.environ.pop("QCR_CHARTS_OUT", None)
script = sys.argv[1] + "/martian_figs.py"; out = sys.argv[1] + "/scratch"
def main(*argv):
    del LOG[:]
    sys.argv = [script, *argv]; err = io.StringIO()
    try:
        with contextlib.redirect_stderr(err), contextlib.redirect_stdout(io.StringIO()):
            runpy.run_path(script, run_name="__main__")
        code = 0
    except SystemExit as e:
        code = e.code
    return code, err.getvalue(), sorted({os.path.dirname(a[0]) for n, a, kw in LOG if n == "savefig"})
bare = main()
told = main("--out", out)
os.environ["QCR_CHARTS_OUT"] = out
env = main()
print(json.dumps({"bare": bare, "told": told, "env": env, "out": out}))`,
      figTree("noout"),
    ) as Record<string, [number, string, string[]]> & { out: string };
    const [code, err, dirs] = r.bare!;
    expect(code).toBe(2);
    expect(err).toMatch(/name the output: --out DIR/);
    expect(dirs).toEqual([]);
    expect(r.told![0]).toBe(0);
    expect(r.told![2]).toEqual([r.out]);
    expect(r.env![0]).toBe(0);
    expect(r.env![2]).toEqual([r.out]);
  }, 60_000);
});

describe("showcase/refresh_v3: an idea whose source is unpublished", () => {
  it("is not built when the source is absent, keeps its committed entry and says so", () => {
    // MUTATION: in ideas_v3_data.build_ideas, build every idea (drop the `if gone:` branch) — the
    // stranger's run then fails on the absent write-up, and this fails.
    // MUTATION: in build_ideas, drop the committed entry of a skipped idea (no `out[name] = committed[name]`)
    // — its figure then has no data, and this fails.
    const dir = join(tmp, "showcase");
    mkdirSync(join(dir, "aacr", "ext", "martian-tuning"), { recursive: true });
    mkdirSync(join(dir, "data", "ext-cache", "qodo"), { recursive: true });
    const r = py(
      `import os
sys.path.insert(0, ${JSON.stringify(join(AACR, "showcase"))})
import argparse, ideas_v3_data as I
root = sys.argv[1]
ctx = argparse.Namespace(aacr=os.path.join(root, "aacr"), data_root=os.path.join(root, "data"))
calls = []
def built(name):
    def b(c):
        calls.append(name)
        return {"built": name}
    return b
ideas = {"idea-uncredited": built("idea-uncredited"), "idea-funnel": built("idea-funnel")}
lines = []
committed = {"idea-uncredited": {"committed": True}}
absent = I.build_ideas(ctx, committed, lines.append, ideas)
none_committed = I.build_ideas(ctx, {}, lines.append, ideas)
for p in I.UNPUBLISHED_SOURCES["idea-uncredited"](ctx):
    open(p, "w").write("x")
present = I.build_ideas(ctx, committed, lines.append, ideas)
print(json.dumps({"absent": absent, "none": none_committed, "present": present, "calls": calls, "lines": lines}))`,
      dir,
    ) as {
      absent: [Record<string, unknown>, Record<string, string[]>];
      none: [Record<string, unknown>, Record<string, string[]>];
      present: [Record<string, unknown>, Record<string, string[]>];
      calls: string[];
      lines: string[];
    };
    const gone = [
      "bench/aacr/ext/martian-tuning/FAIR-COMPARISON.md",
      "<data root>/ext-cache/qodo/unlisted-check.json",
    ];
    expect(r.absent).toEqual([
      { "idea-uncredited": { committed: true }, "idea-funnel": { built: "idea-funnel" } },
      { "idea-uncredited": gone },
    ]);
    expect(r.none).toEqual([
      { "idea-funnel": { built: "idea-funnel" } },
      { "idea-uncredited": gone },
    ]);
    expect(r.present).toEqual([
      { "idea-uncredited": { built: "idea-uncredited" }, "idea-funnel": { built: "idea-funnel" } },
      {},
    ]);
    expect(r.calls).toEqual(["idea-funnel", "idea-funnel", "idea-uncredited", "idea-funnel"]);
    expect(r.lines[0]).toMatch(
      /^skipped idea-uncredited: not rebuilt, .*FAIR-COMPARISON\.md and .*unlisted-check\.json not here \(unpublished\); data\/v3\.json keeps its committed entry$/,
    );
  });
});

describe("martian_figvalues.check", () => {
  it("fails a value that prints differently, and a key or runs that differ from VALUES", () => {
    // MUTATION: in martian_figvalues.check, drop the `elif v != c.get("value")` branch — the moved
    // value then passes and this fails.
    const r = py(`import martian_figvalues as M
vals = {n: M.drawn(1, dp) for n, q, dp in M.VALUES}
doc = M.document(vals)
ok = M.check(doc, vals, False)
moved = dict(vals); moved["policy/snappy/recall"] = 2.0
rekeyed = json.loads(json.dumps(doc)); rekeyed["values"]["extended_key/key"]["q"] = "martian_ext:unlisted"
rerun = json.loads(json.dumps(doc)); rerun["values"]["policy/round3/recall"]["runs"] = []
extra = json.loads(json.dumps(doc)); extra["values"]["typed/in"] = {"value": 1, "q": "", "runs": []}
print(json.dumps({"ok": ok, "moved": M.check(doc, moved, False)[0], "rekeyed": M.check(rekeyed, vals, False)[0],
                  "rerun": M.check(rerun, vals, False)[0], "extra": M.check(extra, vals, False)[0]}))`) as Record<
      string,
      unknown
    >;
    expect(r.ok).toEqual([[], []]);
    expect(r.moved).toEqual(["policy/snappy/recall: computed 2.0, the figure draws 1.0"]);
    expect(r.rekeyed).toEqual([
      "extended_key/key: the committed key or runs differ from martian_figvalues.VALUES",
    ]);
    expect(r.rerun).toEqual([
      "policy/round3/recall: the committed key or runs differ from martian_figvalues.VALUES",
    ]);
    expect(r.extra).toEqual(["typed/in: in the committed copy, not in VALUES"]);
  });

  it("skips the values only --martian gives with --partial, and fails them without", () => {
    // MUTATION: in martian_figvalues.check, test `isinstance(v, NeedsMartian)` without `and partial`
    // — the strict run then skips them too, and this fails.
    const r = py(`import martian_figvalues as M
vals = {n: M.drawn(1, dp) for n, q, dp in M.VALUES}
doc = M.document(vals)
for n, q, _ in M.VALUES:
    if q.startswith("opus:"):
        vals[n] = M.NeedsMartian("needs --martian")
print(json.dumps({"partial": M.check(doc, vals, True), "strict": len(M.check(doc, vals, False)[0]),
                  "opus": sum(1 for _, q, _ in M.VALUES if q.startswith("opus:"))}))`) as {
      partial: [string[], string[]];
      strict: number;
      opus: number;
    };
    expect(r.opus).toBeGreaterThan(0);
    expect(r.partial[0]).toEqual([]);
    expect(r.partial[1]).toHaveLength(r.opus);
    expect(r.strict).toBe(r.opus);
  });

  it("rounds a value the way the verifier prints it", () => {
    const r = py(`import martian_figvalues as M
print(json.dumps([M.drawn(86.58536585, 1), M.drawn(8.95, 1), M.drawn(68.00000000001, 0), M.drawn(43.632, 1)]))`);
    expect(r).toEqual([86.6, 8.9, 68, 43.6]);
  });
});

describe("martian_figvalues.Opus — Martian's leaderboard rule", () => {
  it("takes the entry's own false negatives, leaves skipped entries out, and counts Core categories only", () => {
    // MUTATION: in Opus.value, count fn as the PR's Core goldens minus tp — PR 2's golden that is in
    // neither list then counts as missed, and this fails.
    const m = join(tmp, "martian");
    const res = join(m, "offline", "results");
    mkdirSync(join(res, "anthropic_claude-opus-4-5-20251101"), { recursive: true });
    const g = (comment: string, category: string) => ({ comment, category });
    writeFileSync(
      join(res, "benchmark_data.json"),
      JSON.stringify({
        "https://x/pull/1": { golden_comments: [g("a", "bug"), g("b", "style"), g("c", "perf")] },
        "https://x/pull/2": { golden_comments: [g("d", "bug"), g("e", "bug")] },
        "https://x/pull/3": { golden_comments: [g("f", "bug")] },
      }),
    );
    const tp = (c: string) => ({ golden_comment: c });
    writeFileSync(
      join(res, "anthropic_claude-opus-4-5-20251101", "evaluations.json"),
      JSON.stringify({
        // tp a (bug) and b (style: not Core); fn c (perf); 2 false positives
        "https://x/pull/1": {
          tool: { true_positives: [tp("a"), tp("b")], false_negatives: [tp("c")], fp: 2 },
        },
        // tp d; e is in neither list (Martian's matched-excluded handling): not a miss
        "https://x/pull/2": { tool: { true_positives: [tp("d")], false_negatives: [], fp: 0 } },
        // skipped: not counted at all
        "https://x/pull/3": {
          tool: { skipped: true, true_positives: [], false_negatives: [tp("f")], fp: 9 },
        },
      }),
    );
    const f2 = py(
      `import martian_figvalues as M
print(json.dumps(M.Opus(sys.argv[1]).value("tool:core_f2")))`,
      m,
    ) as number;
    // tp 2, fp 2, fn 1: P 0.5, R 2/3, F2 = 5PR / (4P + R)
    const p = 0.5;
    const rr = 2 / 3;
    expect(f2).toBeCloseTo((100 * 5 * p * rr) / (4 * p + rr), 9);
  });
});

describe("charts/martian-figs.json", () => {
  it("names every value's key and what it reads", () => {
    const bare = Object.entries(committed.values)
      .filter(([, v]) => !v.q || v.runs.length === 0 || typeof v.value !== "number")
      .map(([k]) => k);
    expect(bare).toEqual([]);
    // the posting-policy values name their scoring dirs, the extended key its blind classification
    expect(committed.values["policy/frozen_test30/f1"]!.runs).toEqual([
      "runs/mt-test30-frozen.martian",
    ]);
    expect(committed.values["extended_key/quickreview/recall"]!.runs).toContain(
      "analysis/external-benchmarks-2026-10-02/fair/",
    );
  });
});
