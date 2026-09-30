// Scan stage 1's run (src/setup/scanrun.ts) driven the engine way:
// every port faked — an in-memory source of trees, a fake case runner that
// answers like pass-scan and the validator, the saved unit cut and settings
// handed in — and the state home a temp dir through the real rooted state
// port. What is asserted is what the run WRITES (ledger, findings,
// suggestions, the run record) and RETURNS (previews, refusals), never how.
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { SCAN_DEFAULTS, type ScanConfig } from "../src/config.js";
import { stateHomeFs } from "../src/setup/adapters.js";
import type { CaseOutcome, CaseSpec } from "../src/setup/engine.js";
import { FindingsStore } from "../src/setup/findings.js";
import { LEDGER_FILE, type LedgerFile } from "../src/setup/ledger.js";
import { anchoredLines, evidenceQuotesAnchor, findingFingerprint, normalizeCode, parseScanAnswer, scanValidatorPrompt } from "../src/setup/scan.js";
import { RUN_FILE, ScanRunner, type ScanPorts, type ScanSource, type ScanTree } from "../src/setup/scanrun.js";
import { gitScanSource } from "../src/setup/scantree.js";
import { renderPreview } from "../extensions/setup-scan.js";
import type { UnitCut } from "../src/setup/unitcut.js";

let stateDir: string;
beforeEach(() => {
  stateDir = mkdtempSync(join(tmpdir(), "qcr-scan-"));
});
afterEach(() => rmSync(stateDir, { recursive: true, force: true }));

const lines = (n: number, word = "x"): string => Array.from({ length: n }, (_, i) => `${word}_${i + 1} = ${i + 1}`).join("\n") + "\n";

const TREE: Record<string, string> = {
  "app/models.py": lines(10, "model"),
  "app/views.py": lines(20, "view"),
  "app/tests/test_views.py": lines(8),
  "app/migrations/0001_init.py": lines(6),
  "lib/util.py": lines(30, "util"),
  "lib/big.py": lines(50, "big"),
  "web/index.ts": lines(40, "web"),
  "web/package-lock.json": "{}\n",
  "gen/out.py": lines(5),
  "tools/x.py": lines(15, "tool"),
};

const CUT: UnitCut = {
  units: ["app", "lib", "web", "gen", "tools"].map((u) => ({ name: u, roots: [u], kind: "directory", note: "" })),
  ignored: [],
};

const blob = (text: string): string => createHash("sha1").update(`blob ${Buffer.byteLength(text)}\0${text}`).digest("hex");

/** An in-memory source: one tree per sha. */
function fakeSource(trees: Record<string, Record<string, string>>, head: string): ScanSource & { opened: string[] } {
  const src = {
    location: "/reviewed-repo",
    opened: [] as string[],
    resolve: (ref: string) => (ref === "HEAD" ? head : ref in trees ? ref : null),
    open: (sha: string): { ok: true; tree: ScanTree } | { ok: false; reason: string } => {
      const files = trees[sha];
      if (!files) return { ok: false, reason: "no such tree" };
      src.opened.push(sha);
      return {
        ok: true,
        tree: {
          sha,
          root: `/state/scan/tree/${sha}`,
          files: Object.entries(files).map(([path, text]) => ({ path, blob: blob(text) })),
          read: (p) => files[p] ?? null,
          lines: (p) => (files[p] === undefined ? null : files[p]!.split("\n").length - 1),
        },
      };
    },
    list: (sha: string) => (trees[sha] ? Object.entries(trees[sha]!).map(([path, text]) => ({ path, blob: blob(text) })) : null),
  };
  return src;
}

const SHA1 = "1".repeat(40);
const SHA2 = "2".repeat(40);

/** What the fake pass-scan answers for a case: one finding on the first
 * focus file's lines 2-3, one suggestion, and one junk item. */
function scanAnswer(spec: CaseSpec): string {
  const f = spec.files[0]!;
  return [
    `FINDINGS pass-scan SCAN ${spec.id} @sha`,
    `- path: ${f}`,
    "  line: 2-3",
    "  side: RIGHT",
    "  kind: Bug",
    "  severity: P1",
    "  confidence: 0.8",
    `  claim: ${f} does the wrong thing`,
    "  evidence: read it",
    "- path: nowhere/missing.py",
    "  line: 1",
    "  kind: bug",
    "  severity: P2",
    "  claim: a file the tree does not have",
    "",
    "SUGGEST",
    "- lens: pass-security",
    `  files: ${spec.files.join(", ")}`,
    "  reason: auth lives here",
    "- lens: pass-intent",
    `  files: ${f}`,
    "  reason: diff-only lenses are not suggestible",
  ].join("\n");
}

interface FakeRunner {
  run(spec: CaseSpec, signal: AbortSignal, onCost?: (spentSoFar: number) => void): Promise<CaseOutcome>;
  specs: CaseSpec[];
}

/** A runner that answers at once, costing `perFile` dollars per focus file
 * (or null: unpriced). */
function runner(
  opts: { perFile?: number | null; answer?: (spec: CaseSpec) => string; reads?: (spec: CaseSpec) => string[] | undefined } = {},
): FakeRunner {
  const specs: CaseSpec[] = [];
  return {
    specs,
    run: async (spec) => {
      specs.push(spec);
      const perFile = opts.perFile === undefined ? 0.01 : opts.perFile;
      const reads = opts.reads?.(spec);
      return {
        ok: true,
        output: (opts.answer ?? scanAnswer)(spec),
        cost_usd: perFile === null ? null : perFile * spec.files.length,
        ...(reads !== undefined ? { reads } : {}),
      };
    },
  };
}

let now = new Date("2026-09-29T10:00:00Z");

function ports(cases: FakeRunner, scan: Partial<ScanConfig> = {}, source = fakeSource({ [SHA1]: TREE }, SHA1)): ScanPorts {
  return {
    state: stateHomeFs(stateDir),
    clock: () => {
      now = new Date(now.getTime() + 1000);
      return now;
    },
    cases,
    source,
    savedCut: () => ({ ok: true, cut: CUT }),
    settings: () => ({ ok: true, settings: { scan: { ...SCAN_DEFAULTS, validator: false, exclude: ["gen/"], ...scan } } }),
    buildAgents: () => ({ ok: true }),
  };
}

const ledger = (): LedgerFile => JSON.parse(readFileSync(join(stateDir, LEDGER_FILE), "utf8")) as LedgerFile;

async function previewOf(s: ScanRunner, sha?: string) {
  const p = await s.preview(sha ? { sha } : {});
  if (!p.ok) throw new Error(p.errors.join("; "));
  return p.preview;
}

async function runToEnd(s: ScanRunner, sha?: string) {
  const p = await previewOf(s, sha);
  const r = await s.start({ key: p.key, ...(sha ? { sha } : {}) });
  if (!r.ok) throw new Error(r.errors.join("; "));
  await s.idle();
  return { preview: p, run: s.status().run! };
}

describe("what stage 1 reads", () => {
  it("never tests, migrations, lockfiles or excluded globs — and names the counts", async () => {
    const p = await previewOf(new ScanRunner(ports(runner())));
    expect(p.excluded).toEqual({ test: 1, migration: 1, "unreadable-kind": 1, "excluded-glob": 1 });
    const planned = p.cases.flatMap((c) => c.files.map((f) => f.path));
    for (const f of ["app/tests/test_views.py", "app/migrations/0001_init.py", "web/package-lock.json", "gen/out.py"]) {
      expect(planned).not.toContain(f);
    }
  });
});

describe("a stray NUL is still text; a binary is skipped and SAID (selfscan round 6)", () => {
  it("plans and reads a .ts with one NUL; reports PNG bytes as skipped: binary", async () => {
    const repo = join(stateDir, "repo");
    const put = (p: string, b: string | Buffer) => {
      mkdirSync(join(repo, p, ".."), { recursive: true });
      writeFileSync(join(repo, p), b);
    };
    put("app/stray.ts", "export const k = (a: string, b: string) => `${a}\0${b}`;\nexport const two = 2;\nexport const three = 3;\n");
    put("app/models.py", lines(10, "model"));
    put("app/logo.dat", Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0x0d, 0x49, 0x48, 0x44, 0x52, 0, 0, 1, 0, 0, 0, 1, 0, 8, 6, 0, 0, 0, 0x5c, 0x72, 0xa8, 0x66]));
    const git = (...args: string[]) =>
      execFileSync("git", ["-C", repo, "-c", "user.name=t", "-c", "user.email=t@t", "-c", "commit.gpgsign=false", ...args], { encoding: "utf8" }).trim();
    git("init", "-q");
    git("add", "-A");
    git("commit", "-qm", "init");
    const r = runner();
    const s = new ScanRunner(ports(r, {}, { ...gitScanSource(repo, join(stateDir, "state-home")), opened: [] }));
    const p = await previewOf(s);
    const planned = p.cases.flatMap((c) => c.files.map((f) => f.path));
    expect(planned).toContain("app/stray.ts");
    expect(planned).not.toContain("app/logo.dat");
    expect(p.unreadable).toBe(1);
    expect(p.skipped).toEqual([{ path: "app/logo.dat", why: "binary" }]);
    const text = renderPreview(p);
    expect(text).toContain("skipped: binary — 1 file(s): app/logo.dat");
    expect(text).not.toContain("\0");
    // A lens is handed the file, and the engine reads it to anchor findings.
    const started = await s.start({ key: p.key });
    if (!started.ok) throw new Error(started.errors.join("; "));
    await s.idle();
    expect(r.specs.flatMap((c) => c.files)).toContain("app/stray.ts");
    const findings = s.status().run!.cases.reduce((n, c) => n + (c.findings ?? 0), 0);
    expect(findings).toBeGreaterThan(0);
  });
});

describe("first-scan calibration, then previews from the ledger", () => {
  it("the first preview is a calibration run: units across the size range, a hard cap, no estimate", async () => {
    const p = await previewOf(new ScanRunner(ports(runner())));
    expect(p.mode).toBe("calibration");
    expect(p.estimate_usd).toBeNull();
    expect(p.cap_usd).toBe(SCAN_DEFAULTS.calibration_max_usd);
    // units by planned lines: tools 15, app 30, web 40, lib 80 → the spread
    // pick skips the smallest.
    expect(p.cases.map((c) => c.unit)).toEqual(["app", "web", "lib"]);
    expect(p.remaining_cases).toBe(1);
  });

  it("after calibration the preview is priced from what the ledger says it cost", async () => {
    const s = new ScanRunner(ports(runner({ perFile: 0.01 })));
    const cal = await runToEnd(s);
    expect(cal.run.state).toBe("complete");
    const rows = ledger().entries;
    expect(rows.map((e) => e.path).sort()).toEqual(["app/models.py", "app/views.py", "lib/big.py", "lib/util.py", "web/index.ts"]);
    expect(rows.every((e) => e.lens === "pass-scan" && e.sha === SHA1 && e.tier === "sol-med" && e.effort === "low")).toBe(true);

    const next = await previewOf(s);
    expect(next.mode).toBe("stage1");
    // Measured: $0.05 over 150 lines → $0.333…/kline; tools/x.py is 15 lines.
    expect(next.rate!.cases).toBe(3);
    expect(next.rate!.usd_per_kline).toBeCloseTo((0.05 / 150) * 1000, 9);
    expect(next.cases.map((c) => c.id)).toEqual(["tools"]);
    expect(next.estimate_usd).toBeCloseTo(0.015 * (0.05 / 150) * 1000, 9);
    expect(next.cap_usd).toBe(next.estimate_usd);
    expect(next.covered).toBe(5);
  });

  it("a runner that prices nothing blocks the estimate rather than calling it free", async () => {
    const s = new ScanRunner(ports(runner({ perFile: null })));
    await runToEnd(s);
    const p = await previewOf(s);
    expect(p.mode).toBe("calibration");
    expect(p.blockers.join(" ")).toMatch(/priced none/);
    expect((await s.start({ key: p.key })).ok).toBe(false);
  });

  it("a change of settings is a new price: back to calibration", async () => {
    const s = new ScanRunner(ports(runner()));
    await runToEnd(s);
    const p = await previewOf(new ScanRunner(ports(runner(), { effort: "medium" })));
    expect(p.mode).toBe("calibration");
  });
});

describe("nothing runs unseen", () => {
  it("start refuses no key, a stale key, and a different sha", async () => {
    const s = new ScanRunner(ports(runner(), {}, fakeSource({ [SHA1]: TREE, [SHA2]: TREE }, SHA1)));
    expect(await s.start({})).toMatchObject({ ok: false });
    expect(await s.start({ key: "deadbeef" })).toMatchObject({ ok: false });
    const p = await previewOf(s, SHA1);
    const other = await s.start({ key: p.key, sha: SHA2 });
    expect(other.ok).toBe(false);
    expect(await s.start({ key: p.key, sha: SHA1 })).toMatchObject({ ok: true });
    await s.idle();
  });

  it("two starts issued together run the scan once (review)", async () => {
    const r = runner();
    const s = new ScanRunner(ports(r));
    const p = await previewOf(s);
    const [a, b] = await Promise.all([s.start({ key: p.key }), s.start({ key: p.key })]);
    expect([a.ok, b.ok].filter(Boolean)).toHaveLength(1);
    await s.idle();
    expect(r.specs).toHaveLength(p.cases.length);
  });

  it("the build of the scan agents happens at start, and its refusal stops the start", async () => {
    const p = ports(runner());
    p.buildAgents = () => ({ ok: false, errors: ["profile broken"] });
    const s = new ScanRunner(p);
    const pv = await previewOf(s);
    const r = await s.start({ key: pv.key });
    expect(r).toEqual({ ok: false, errors: ["the scan agents could not be built: profile broken"] });
  });
});

describe("hard stop at the estimate", () => {
  it("a run whose actuals outrun the estimate stops at the cap; the rest stays unread", async () => {
    // Calibrate cheap, then make every case cost 10x what it was priced at.
    const cheap = runner({ perFile: 0.01 });
    const s = new ScanRunner(ports(cheap, { case_max_files: 1, concurrency: 1 }));
    await runToEnd(s);
    const before = ledger().entries.length;
    const dear = new ScanRunner(ports(runner({ perFile: 0.1 }), { case_max_files: 1, concurrency: 1 }));
    const p = await previewOf(dear);
    expect(p.mode).toBe("stage1");
    const { run } = await runToEnd(dear);
    expect(run.state).toBe("capped");
    expect(run.cases.filter((c) => c.status === "skipped").length).toBeGreaterThan(0);
    // Never a case started past the cap: at most the one in flight overshoots.
    expect(run.spent_usd).toBeLessThanOrEqual(run.cap_usd + 0.1 + 1e-9);
    const read = ledger().entries.length - before;
    expect(read).toBe(run.cases.filter((c) => c.status === "done").length);
    // The next preview prices exactly what is left.
    const rest = await previewOf(dear);
    expect(rest.cases.length).toBe(run.cases.filter((c) => c.status !== "done").length);
  });

  it("the calibration run stops hard at its own cap", async () => {
    const s = new ScanRunner(ports(runner({ perFile: 5 }), { concurrency: 1 }));
    const { run } = await runToEnd(s);
    expect(run.mode).toBe("calibration");
    expect(run.state).toBe("capped");
    expect(run.cases.filter((c) => c.status === "done")).toHaveLength(1);
  });
});

describe("hard stop — mid-case, and what a failure spent (review)", () => {
  it("a case whose running cost crosses the cap is aborted mid-flight, and what it spent is counted", async () => {
    // One calibration case that keeps spending until it is stopped.
    const specs: CaseSpec[] = [];
    const r: FakeRunner = {
      specs,
      run: (spec, signal, onCost) =>
        new Promise((res) => {
          specs.push(spec);
          let spent = 0;
          const tick = setInterval(() => {
            spent += 1;
            onCost?.(spent);
          }, 1);
          signal.addEventListener(
            "abort",
            () => {
              clearInterval(tick);
              res({ ok: false, reason: "stopped", cost_usd: spent });
            },
            { once: true },
          );
        }),
    };
    const s = new ScanRunner(ports(r, { concurrency: 1, calibration_units: 1, calibration_max_usd: 3 }));
    const { run } = await runToEnd(s);
    expect(run.mode).toBe("calibration");
    expect(run.state).toBe("capped");
    expect(specs).toHaveLength(1);
    expect(run.cases[0]!.status).toBe("stopped");
    // Aborted the moment it reached the cap, and the money counted.
    expect(run.spent_usd).toBe(3);
  });

  it("a FAILED case's spend counts toward the cap — failures cannot run a scan past it", async () => {
    const cheap = runner({ perFile: 0.01 });
    await runToEnd(new ScanRunner(ports(cheap, { case_max_files: 1, concurrency: 1 })));
    // Every case now fails after spending ten times its estimate.
    const failing: FakeRunner = {
      specs: [],
      run: async (spec) => {
        failing.specs.push(spec);
        return { ok: false, reason: "the subagent gave no answer", cost_usd: 0.1 };
      },
    };
    const s = new ScanRunner(ports(failing, { case_max_files: 1, concurrency: 1 }));
    const p = await previewOf(s);
    expect(p.mode).toBe("stage1");
    const { run } = await runToEnd(s);
    expect(run.state).toBe("capped");
    expect(failing.specs.length).toBeLessThan(p.cases.length);
    expect(run.spent_usd).toBeLessThanOrEqual(run.cap_usd + 0.1 + 1e-9);
  });

  it("a failed case that cannot say what it spent is counted at its estimate, never as free", async () => {
    await runToEnd(new ScanRunner(ports(runner({ perFile: 0.01 }), { case_max_files: 1, concurrency: 1 })));
    const s = new ScanRunner(ports({ specs: [], run: async () => ({ ok: false, reason: "pi exited 1" }) }, { case_max_files: 1, concurrency: 1 }));
    const p = await previewOf(s);
    const { run } = await runToEnd(s);
    expect(run.cases.every((c) => c.status === "failed")).toBe(true);
    expect(run.spent_usd).toBeCloseTo(p.estimate_usd!, 9);
    expect(run.unpriced_cases).toBe(run.cases.length);
  });
});

describe("stop, and resume by the ledger", () => {
  /** A runner whose cases for `hang` never finish until aborted. */
  function hanging(hang: (spec: CaseSpec) => boolean): FakeRunner {
    const specs: CaseSpec[] = [];
    return {
      specs,
      run: (spec, signal) => {
        specs.push(spec);
        if (!hang(spec)) return Promise.resolve({ ok: true, output: scanAnswer(spec), cost_usd: 0.01 });
        return new Promise((res) => signal.addEventListener("abort", () => res({ ok: false, reason: "stopped" }), { once: true }));
      },
    };
  }

  it("stop aborts in-flight cases; what finished is kept, and a new start reads only the rest", async () => {
    const r = hanging((spec) => spec.unit === "lib");
    const s = new ScanRunner(ports(r));
    const p = await previewOf(s);
    expect((await s.start({ key: p.key })).ok).toBe(true);
    await new Promise((res) => setTimeout(res, 20));
    expect(s.stop()).toMatchObject({ ok: true });
    await s.idle();
    const run = s.status().run!;
    expect(run.state).toBe("stopped");
    expect(run.cases.find((c) => c.unit === "lib")!.status).toBe("stopped");
    expect(ledger().entries.map((e) => e.path)).not.toContain("lib/big.py");

    const again = await previewOf(new ScanRunner(ports(runner())));
    const files = again.cases.flatMap((c) => c.files.map((f) => f.path));
    expect(files).toContain("lib/big.py");
    expect(files).not.toContain("app/views.py");
  });

  it("a run the companion was not there to finish reads as interrupted, and resumes", async () => {
    const r = hanging((spec) => spec.unit === "web");
    const first = new ScanRunner(ports(r));
    const p = await previewOf(first);
    await first.start({ key: p.key });
    await new Promise((res) => setTimeout(res, 20));
    // The companion restarts: a new runner over the same state home.
    const second = new ScanRunner(ports(runner()));
    expect(second.status().run!.display).toBe("interrupted");
    const resumed = await runToEnd(second);
    expect(resumed.preview.cases.flatMap((c) => c.files.map((f) => f.path))).toContain("web/index.ts");
    expect(resumed.preview.cases.flatMap((c) => c.files.map((f) => f.path))).not.toContain("app/models.py");
    const file = JSON.parse(readFileSync(join(stateDir, RUN_FILE), "utf8")) as { history: Array<{ state: string }> };
    expect(file.history[0]!.state).toBe("interrupted");
    first.stop();
    await first.idle();
  });

  it("nothing runs twice: a finished repo previews as nothing left", async () => {
    const s = new ScanRunner(ports(runner()));
    await runToEnd(s);
    await runToEnd(s);
    const p = await previewOf(s);
    expect(p.cases).toEqual([]);
    expect(p.blockers.join(" ")).toMatch(/nothing left/);
  });
});

describe("findings, fingerprinted", () => {
  it("are stored with a fingerprint over file + lens + kind + the anchored code; unanchorable items dropped", async () => {
    const s = new ScanRunner(ports(runner()));
    const { run } = await runToEnd(s);
    const { findings } = new FindingsStore(stateHomeFs(stateDir)).list();
    expect(findings).toHaveLength(3);
    const f = findings.find((x) => x.path === "app/models.py")!;
    expect(f).toMatchObject({ lens: "pass-scan", kind: "bug", severity: "P1", start: 2, end: 3, state: "new", validated: false, doubt: null, unit: "app" });
    expect(f.fingerprint).toBe(
      findingFingerprint({ path: "app/models.py", lens: "pass-scan", kind: "bug", code: normalizeCode(["model_2 = 2", "model_3 = 3"]) }),
    );
    // The missing-file item and the diff-only suggestion were dropped, counted.
    expect(run.cases.every((c) => c.dropped === 2)).toBe(true);
  });

  it("the same code re-indented and moved keeps its fingerprint; changed code does not", () => {
    const a = normalizeCode(["  if x:", "      return  y"]);
    const b = normalizeCode(["if x:", "", "\treturn y"]);
    expect(a).toBe(b);
    const fp = (code: string) => findingFingerprint({ path: "a.py", lens: "pass-scan", kind: "bug", code });
    expect(fp(a)).toBe(fp(b));
    expect(fp(a)).not.toBe(fp(normalizeCode(["if x:", "return z"])));
    expect(fp(a)).not.toBe(findingFingerprint({ path: "a.py", lens: "pass-scan", kind: "design", code: a }));
  });

  it("an exact fingerprint match on a later scan is the same finding: its state is kept", async () => {
    // Scan SHA1 fully, dismiss one finding by hand, then scan SHA2 where the
    // same code moved down two lines and was re-indented.
    const moved = { ...TREE, "app/models.py": `\n\n${TREE["app/models.py"]!.replace("model_2", "  model_2")}` };
    const src = fakeSource({ [SHA1]: TREE, [SHA2]: moved }, SHA1);
    const s = new ScanRunner(ports(runner(), {}, src));
    await runToEnd(s);
    const path = join(stateDir, "scan/findings.json");
    const file = JSON.parse(readFileSync(path, "utf8")) as { findings: Array<{ path: string; state: string }> };
    file.findings.find((f) => f.path === "app/models.py")!.state = "dismissed";
    writeFileSync(path, JSON.stringify(file));
    const answerAt4 = (spec: CaseSpec) => scanAnswer(spec).replace("line: 2-3", "line: 4-5");
    const s2 = new ScanRunner(ports(runner({ answer: answerAt4 }), {}, src));
    await runToEnd(s2, SHA2);
    const after = new FindingsStore(stateHomeFs(stateDir)).list().findings.filter((f) => f.path === "app/models.py");
    expect(after).toHaveLength(1);
    expect(after[0]).toMatchObject({ state: "dismissed", start: 4, end: 5, seen: 2 });
    expect(after[0]!.last_seen.sha).toBe(SHA2);
  });

  it("stores stage 1's deep-lens suggestions for stage 2 (allowed lenses, real files)", async () => {
    const s = new ScanRunner(ports(runner()));
    await runToEnd(s);
    const { suggestions } = s.suggestions();
    expect(suggestions.map((x) => `${x.unit}:${x.lens}`).sort()).toEqual(["app:pass-security", "lib:pass-security", "web:pass-security"]);
    expect(suggestions.find((x) => x.unit === "app")!.files.sort()).toEqual(["app/models.py", "app/views.py"]);
  });
});

describe("the validator — the skeptic; a profile may switch it off", () => {
  it("off: only pass-scan runs", async () => {
    const r = runner();
    await runToEnd(new ScanRunner(ports(r)));
    expect(new Set(r.specs.map((x) => x.agent))).toEqual(new Set(["pass-scan--sol-med"]));
  });

  it("on: it runs at the LENS's tier; a DOUBTED finding is kept as 'may not be valid', and so is a KILLED one", async () => {
    const answer = (spec: CaseSpec): string => {
      if (spec.agent.startsWith("pass-validate")) {
        const f = spec.files[0]!;
        if (spec.unit === "app") return `NONE\n\nDOUBTED\n- pass-scan ${f}:2 — refuted: the guard on line 1 covers it\n`;
        if (spec.unit === "web") return `NONE\n\nKILLED\n- pass-scan ${f}:2 — below-bar\n`;
        return scanAnswer(spec).split("SUGGEST")[0]!.replace("FINDINGS pass-scan", "FINDINGS pass-validate");
      }
      return scanAnswer(spec);
    };
    const r = runner({ answer });
    await runToEnd(new ScanRunner(ports(r, { validator: true })));
    // Never raised: pass-scan runs at sol-med, so its skeptic does too.
    expect(r.specs.filter((x) => x.agent === "pass-validate--sol-med")).toHaveLength(3);
    expect(r.specs.some((x) => x.agent === "pass-validate--sol-high")).toBe(false);
    const { findings } = new FindingsStore(stateHomeFs(stateDir)).list();
    const byUnit = new Map(findings.map((f) => [f.unit, f]));
    expect(byUnit.get("app")).toMatchObject({ validated: true, validity: "doubtful", doubt: { word: "refuted", reason: "the guard on line 1 covers it" } });
    expect(byUnit.get("lib")).toMatchObject({ validated: true, validity: "likely", doubt: null });
    expect(byUnit.get("web")).toMatchObject({ validated: true, validity: "doubtful", doubt: { word: "below-bar" } });
    expect(new FindingsStore(stateHomeFs(stateDir)).list({ doubted: true }).findings.map((f) => f.unit).sort()).toEqual(["app", "web"]);
  });
});

describe("an answer that is neither findings nor NONE is not a reading (selfscan a03e554c)", () => {
  it("a lens answering in prose fails its case: no ledger row, so nothing is certified clean", async () => {
    const answer = (spec: CaseSpec): string =>
      spec.unit === "app" ? "I could not inspect these files — they are too large to open." : scanAnswer(spec);
    const { run } = await runToEnd(new ScanRunner(ports(runner({ answer }))));
    const app = run.cases.filter((c) => c.unit === "app");
    expect(app.length).toBeGreaterThan(0);
    expect(app.every((c) => c.status === "failed")).toBe(true);
    expect(ledger().entries.some((e) => e.path.startsWith("app/"))).toBe(false);
    expect(ledger().entries.some((e) => e.path.startsWith("lib/"))).toBe(true);
  });

  it("a validator answering in prose is a failed validator: the lens's findings are kept unvalidated", async () => {
    const answer = (spec: CaseSpec): string =>
      spec.agent.startsWith("pass-validate") ? "Sorry, I was unable to read the tree." : scanAnswer(spec);
    const { run } = await runToEnd(new ScanRunner(ports(runner({ answer }), { validator: true })));
    const { findings } = new FindingsStore(stateHomeFs(stateDir)).list();
    expect(findings).toHaveLength(3);
    expect(findings.every((f) => f.validated === false)).toBe(true);
    expect(run.problems.some((p) => p.includes("validator"))).toBe(true);
  });
});

describe("a lens that read none of its focus files is not a reading (scan-loop round 7)", () => {
  const ROOT = `/state/scan/tree/${SHA1}`;
  const none = (spec: CaseSpec): string => `FINDINGS pass-scan SCAN ${spec.id} @sha\nNONE\n\nSUGGEST NONE\n`;

  it("a NONE with zero file reads fails its case: no ledger row (not coverage, not a price sample), and the run names it", async () => {
    const reads = (spec: CaseSpec): string[] => (spec.unit === "app" ? [] : spec.files.map((f) => `${ROOT}/${f}`));
    const { run } = await runToEnd(new ScanRunner(ports(runner({ answer: none, reads }))));
    const app = run.cases.filter((c) => c.unit === "app");
    expect(app.length).toBeGreaterThan(0);
    expect(app.every((c) => c.status === "failed" && /read none of its \d+ focus file/.test(c.error ?? ""))).toBe(true);
    expect(ledger().entries.some((e) => e.path.startsWith("app/"))).toBe(false);
    expect(ledger().entries.some((e) => e.path.startsWith("lib/"))).toBe(true);
    expect(run.problems.some((p) => p.includes(app[0]!.id) && /not a reading/.test(p))).toBe(true);
    expect(run.cases.filter((c) => c.unit !== "app").every((c) => c.status === "done")).toBe(true);
  });

  it("reading only files OUTSIDE the case is still no reading — and its findings are not stored", async () => {
    const reads = (spec: CaseSpec): string[] => (spec.unit === "app" ? [`${ROOT}/tools/x.py`, `${ROOT}/CLAUDE.md`] : spec.files.map((f) => `${ROOT}/${f}`));
    const { run } = await runToEnd(new ScanRunner(ports(runner({ reads }))));
    expect(run.cases.filter((c) => c.unit === "app").every((c) => c.status === "failed")).toBe(true);
    const { findings } = new FindingsStore(stateHomeFs(stateDir)).list();
    expect(findings.some((f) => f.path.startsWith("app/"))).toBe(false);
    expect(findings.some((f) => f.path.startsWith("lib/"))).toBe(true);
  });

  it("one focus file read by its path under the tree root is a reading — a relative path is not: it resolves against the runner's cwd, not the tree", async () => {
    const reads = (spec: CaseSpec): string[] =>
      spec.unit === "app" ? [spec.files[0]!] : [`${ROOT}/nowhere/../${spec.files.at(-1)!}`];
    const { run } = await runToEnd(new ScanRunner(ports(runner({ answer: none, reads }))));
    expect(run.cases.filter((c) => c.unit === "app").every((c) => c.status === "failed")).toBe(true);
    expect(run.cases.filter((c) => c.unit !== "app").every((c) => c.status === "done")).toBe(true);
  });

  it("an `@`-prefixed absolute path is the path pi opened (it strips the `@`)", async () => {
    const reads = (spec: CaseSpec): string[] => [`@${ROOT}/${spec.files[0]!}`];
    const { run } = await runToEnd(new ScanRunner(ports(runner({ answer: none, reads }))));
    expect(run.cases.every((c) => c.status === "done")).toBe(true);
  });

  it("a runner that cannot tell (no `reads`) is not judged — unknown is never read as zero", async () => {
    const { run } = await runToEnd(new ScanRunner(ports(runner({ answer: none }))));
    expect(run.cases.every((c) => c.status === "done")).toBe(true);
  });
});

describe("the validator — a survivor it also doubts (review)", () => {
  it("is one finding, doubted, counted once", async () => {
    const answer = (spec: CaseSpec): string => {
      if (spec.agent.startsWith("pass-validate")) {
        const f = spec.files[0]!;
        const kept = scanAnswer(spec).split("SUGGEST")[0]!.replace("FINDINGS pass-scan", "FINDINGS pass-validate");
        return `${kept}\nDOUBTED\n- pass-scan ${f}:2 — refuted: guarded above\n`;
      }
      return scanAnswer(spec);
    };
    const { run } = await runToEnd(new ScanRunner(ports(runner({ answer }), { validator: true })));
    const { findings } = new FindingsStore(stateHomeFs(stateDir)).list();
    expect(findings).toHaveLength(3);
    expect(findings.every((f) => f.doubt?.word === "refuted")).toBe(true);
    expect(run.cases.map((c) => [c.findings, c.doubted])).toEqual([
      [1, 1],
      [1, 1],
      [1, 1],
    ]);
  });
});

describe("reading the lens's answer", () => {
  it("strips an absolute tree prefix, reads ranges, and keeps NONE apart from junk", () => {
    const a = parseScanAnswer(
      "FINDINGS pass-scan SCAN x @y\n- path: /t/root/src/a.py\n  line: 7\n  kind: data loss\n  severity: p2\n  claim: c\n\nSUGGEST NONE\n",
      { root: "/t/root" },
    );
    expect(a.candidates).toEqual([
      expect.objectContaining({ path: "src/a.py", start: 7, end: 7, kind: "data-loss", severity: "P2" }),
    ]);
    expect(a.suggestions).toEqual([]);
    expect(parseScanAnswer("NONE\n\nSUGGEST NONE").none).toBe(true);
  });
});

describe("a finding's severity follows the reachability axis (scan-loop)", () => {
  const one = (sev: string, reach: string | null, conf = "0.9"): string =>
    [
      "FINDINGS pass-scan SCAN x @y",
      "- path: src/a.py",
      "  line: 7",
      "  kind: bug",
      `  severity: ${sev}`,
      `  confidence: ${conf}`,
      ...(reach === null ? [] : [`  reachability: ${reach}`]),
      "  claim: c",
    ].join("\n");

  it("contrived never blocks: a P0/P1/P2 caps at P3, a nit stays a nit", () => {
    for (const sev of ["P0", "P1", "P2"]) {
      const [c] = parseScanAnswer(one(sev, "contrived")).candidates;
      expect(c).toMatchObject({ severity: "P3", capped_from: sev, reachability: "contrived" });
    }
    expect(parseScanAnswer(one("nit", "contrived")).candidates[0]).toMatchObject({ severity: "nit", capped_from: null });
    expect(parseScanAnswer(one("P3", "contrived")).candidates[0]).toMatchObject({ severity: "P3", capped_from: null });
  });

  it("plausible: a P2 becomes P3, a P0/P1 keeps its severity", () => {
    expect(parseScanAnswer(one("P2", "plausible")).candidates[0]).toMatchObject({ severity: "P3", capped_from: "P2" });
    expect(parseScanAnswer(one("P1", "plausible")).candidates[0]).toMatchObject({ severity: "P1", capped_from: null });
  });

  it("the validator is shown the severity the lens WROTE, so a reach it corrects to routine restores it", () => {
    const [c] = parseScanAnswer(one("P1", "contrived")).candidates;
    expect(c).toMatchObject({ severity: "P3", capped_from: "P1" });
    const plan = { unit: "src", id: "src", part: 1, parts: 1, files: [{ path: "src/a.py", blob: "b", lines: 9 }], lines: 9 } as never;
    const prompt = scanValidatorPrompt(plan, [c!], { root: "/t", sha: "y", caseId: "x" });
    expect(prompt).toContain("  severity: P1\n");
    expect(prompt).toContain("  reachability: contrived\n");
    // Its survivor, re-read with the corrected axis, is a P1 again — and still capped if it upholds contrived.
    const back = (reach: string): unknown =>
      parseScanAnswer(prompt.replace(/^.*?(FINDINGS pass-scan SCAN)/s, "$1").replace("reachability: contrived", `reachability: ${reach}`)).candidates[0];
    expect(back("routine")).toMatchObject({ severity: "P1", capped_from: null });
    expect(back("contrived")).toMatchObject({ severity: "P3", capped_from: "P1" });
  });

  it("the validator is shown each candidate's detail paragraph, and it round-trips (selfscan 9cfaa2db)", () => {
    const [c] = parseScanAnswer(one("P1", "routine")).candidates;
    const withDetail = { ...c!, detail: "Two writers race on the cache; the second overwrites the first's entry." };
    const plan = { unit: "src", id: "src", part: 1, parts: 1, files: [{ path: "src/a.py", blob: "b", lines: 9 }], lines: 9 } as never;
    const prompt = scanValidatorPrompt(plan, [withDetail], { root: "/t", sha: "y", caseId: "x" });
    expect(prompt).toContain("  detail: Two writers race on the cache; the second overwrites the first's entry.\n");
    const back = parseScanAnswer(prompt.replace(/^.*?(FINDINGS pass-scan SCAN)/s, "$1")).candidates[0];
    expect(back?.detail).toBe(withDetail.detail);
  });

  it("routine — or the field absent, read as routine like a PR round — leaves severity alone", () => {
    expect(parseScanAnswer(one("P1", "routine")).candidates[0]).toMatchObject({ severity: "P1", capped_from: null, reachability: "routine" });
    expect(parseScanAnswer(one("P1", null)).candidates[0]).toMatchObject({ severity: "P1", capped_from: null, reachability: null });
    expect(parseScanAnswer(one("P1", "`Contrived`")).candidates[0]).toMatchObject({ severity: "P3", reachability: "contrived" });
  });
});

describe("the evidence quotes the anchored line (scan-loop)", () => {
  const code = [
    "def handler(request):", // 1
    "    user = lookup(request.user_id)", // 2
    "    if request.flag:", // 3
    "        log('x')", // 4
    "    return user.profile.name", // 5
    "", // 6
  ].join("\n");

  it("evidenceQuotesAnchor: a quoted fragment or the whole line counts; code elsewhere in the file does not", () => {
    const at5 = anchoredLines(code, 5, 5)!;
    expect(evidenceQuotesAnchor("L5 `user.profile.name` dereferences a None from lookup", at5)).toBe(true);
    expect(evidenceQuotesAnchor("line 5: return user.profile.name — lookup returns None", at5)).toBe(true);
    expect(evidenceQuotesAnchor("`lookup(request.user_id)` may return None", at5)).toBe(false);
    expect(evidenceQuotesAnchor(null, at5)).toBe(false);
    // An anchor with nothing quotable (a lone brace) cannot be checked, so it is not flagged.
    expect(evidenceQuotesAnchor("anything", ["    }"])).toBe(true);
  });

  it("a stored finding carries anchor_quoted — false when the anchor sits above the defect its evidence cites", async () => {
    const tree = { ...TREE, "app/models.py": code };
    const answer = (spec: CaseSpec): string =>
      spec.unit !== "app"
        ? "NONE\n\nSUGGEST NONE\n"
        : [
            `FINDINGS pass-scan SCAN ${spec.id} @sha`,
            "- path: app/models.py",
            "  line: 1",
            "  kind: bug",
            "  severity: P1",
            "  confidence: 0.99",
            "  reachability: plausible",
            "  claim: handler dereferences a None user",
            "  evidence: `user.profile.name` on a None from lookup",
            "- path: app/models.py",
            "  line: 5",
            "  kind: error-handling",
            "  severity: P2",
            "  confidence: 0.7",
            "  claim: same, anchored right",
            "  evidence: L5 `return user.profile.name` after `lookup` may return None",
            "",
            "SUGGEST NONE",
          ].join("\n");
    await runToEnd(new ScanRunner(ports(runner({ answer }), {}, fakeSource({ [SHA1]: tree }, SHA1))));
    const { findings } = new FindingsStore(stateHomeFs(stateDir)).list();
    const byLine = new Map(findings.map((f) => [f.start, f]));
    expect(byLine.get(1)).toMatchObject({ anchor_quoted: false, reachability: "plausible", severity: "P1" });
    expect(byLine.get(5)).toMatchObject({ anchor_quoted: true, severity: "P2", capped_from: null });
  });
});

describe("the preview's lines and the measured rate's lines agree (scan-loop)", () => {
  it("an empty __init__.py counts 0 lines on both sides", async () => {
    const tree = { ...TREE, "app/__init__.py": "", "web/empty.ts": "" };
    const s = new ScanRunner(ports(runner({ perFile: 0.01 }), {}, fakeSource({ [SHA1]: tree }, SHA1)));
    const cal = await runToEnd(s);
    expect(cal.preview.cases.flatMap((c) => c.files.map((f) => f.path))).toContain("app/__init__.py");
    const next = await previewOf(s);
    expect(next.rate!.lines).toBe(cal.preview.lines);
    // 7 priced files at $0.01 over the calibration's real lines.
    expect(next.rate!.usd_per_kline).toBeCloseTo((0.07 / cal.preview.lines) * 1000, 9);
  });
});
