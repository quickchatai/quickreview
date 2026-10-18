// What the third-party arms' runs share (src/bench/armrun.ts): a run dir set
// up for a new configuration — its cases, their judge inputs and the run's
// metrics — the run record's lifecycle, and the report's warnings. Temp dirs
// only; the bench CLI's usage text is read off the compiled entrypoint.
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { BenchCase } from "../src/bench/aacr.js";
import { caseWarningsSection, prepareArmCases, runLifecycle } from "../src/bench/armrun.js";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const A = { instance_id: "o__r@aaaaaaa" } as BenchCase;
const B = { instance_id: "o__r@bbbbbbb" } as BenchCase;

let out: string;
beforeEach(() => {
  out = mkdtempSync(join(tmpdir(), "bench-armrun-"));
});
afterEach(() => rmSync(out, { recursive: true, force: true }));

/** A case reviewed under `model`, with its result and judge inputs, in an
 * evaluated run (a metrics file beside the results). */
function seed(c: BenchCase, model: string): void {
  const caseDir = join(out, "cases", c.instance_id);
  mkdirSync(caseDir, { recursive: true });
  mkdirSync(join(out, "results", "all"), { recursive: true });
  writeFileSync(join(caseDir, "case-summary.json"), JSON.stringify({ fingerprint: { model } }));
  writeFileSync(join(caseDir, "review.md"), "body\n");
  writeFileSync(join(caseDir, "comments.json"), "[]\n");
  writeFileSync(join(out, "results", "all", `${c.instance_id}.json`), "{}");
  writeFileSync(join(out, "results", "all", "metrics_ocr_round_1.json"), "{}");
}

const has = (...p: string[]): boolean => existsSync(join(out, ...p));
const readSummary = (dir: string, c: BenchCase): { fingerprint: unknown } | null => {
  const p = join(dir, "cases", c.instance_id, "case-summary.json");
  return existsSync(p) ? (JSON.parse(readFileSync(p, "utf8")) as { fingerprint: unknown }) : null;
};

function prep(resume: boolean, model: string, log: string[] = []) {
  return prepareArmCases({
    outDir: out,
    cases: [A, B],
    resume,
    fingerprint: { model },
    readSummary,
    log: (l) => log.push(l),
    arm: "x",
    differs: "another model",
  });
}

describe("a run dir set up for a new configuration", () => {
  it.each(["missing", "unparseable"])(
    "a matching summary cannot retain a %s result on resume",
    (state) => {
      seed(A, "m");
      seed(B, "m");
      const result = join(out, "results/all", `${A.instance_id}.json`);
      if (state === "missing") rmSync(result);
      else writeFileSync(result, "{");
      const prepared = prep(true, "m");
      expect(prepared.dropped).toContain(A.instance_id);
      expect(has("cases", A.instance_id, "case-summary.json")).toBe(false);
      expect(has("cases", B.instance_id, "case-summary.json")).toBe(true);
      expect(has("results", "all", "metrics_ocr_round_1.json")).toBe(false);
    },
  );
  it("a fresh run drops every case, its judge inputs and the run's metrics", () => {
    seed(A, "m");
    seed(B, "m");
    prep(false, "m");
    for (const c of [A, B]) {
      expect(has("cases", c.instance_id, "case-summary.json")).toBe(false);
      expect(has("cases", c.instance_id, "review.md")).toBe(false);
      expect(has("cases", c.instance_id, "comments.json")).toBe(false);
      expect(has("results", "all", `${c.instance_id}.json`)).toBe(false);
    }
    expect(has("results", "all", "metrics_ocr_round_1.json")).toBe(false);
  });

  it("a resume drops only the cases another configuration reviewed — and the metrics that scored them", () => {
    seed(A, "old");
    seed(B, "new");
    const log: string[] = [];
    const p = prep(true, "new", log);
    expect(p.dropped).toEqual([A.instance_id]);
    expect(has("cases", A.instance_id, "case-summary.json")).toBe(false);
    expect(has("cases", A.instance_id, "comments.json")).toBe(false);
    expect(has("results", "all", `${A.instance_id}.json`)).toBe(false);
    expect(has("cases", B.instance_id, "case-summary.json")).toBe(true);
    expect(has("results", "all", `${B.instance_id}.json`)).toBe(true);
    expect(has("results", "all", "metrics_ocr_round_1.json")).toBe(false);
    expect(log.join("\n")).toContain(`x: ${A.instance_id} was reviewed by another model`);
  });

  it("a resume drops what an interrupted review left without a summary — and the metrics", () => {
    // A died after writing its result, before its case summary.
    seed(A, "old");
    rmSync(join(out, "cases", A.instance_id, "case-summary.json"));
    seed(B, "new");
    const log: string[] = [];
    const p = prep(true, "new", log);
    expect(p.dropped).toEqual([]);
    expect(has("results", "all", `${A.instance_id}.json`)).toBe(false);
    expect(has("cases", A.instance_id, "review.md")).toBe(false);
    expect(has("cases", A.instance_id, "comments.json")).toBe(false);
    expect(has("results", "all", `${B.instance_id}.json`)).toBe(true);
    expect(has("results", "all", "metrics_ocr_round_1.json")).toBe(false);
    expect(log.join("\n")).toContain(`x: ${A.instance_id} left a result without a case summary`);
  });

  it("a resume with nothing left by a summary-less case keeps the metrics", () => {
    seed(B, "m");
    const p = prep(true, "m");
    expect(p.dropped).toEqual([]);
    expect(has("results", "all", "metrics_ocr_round_1.json")).toBe(true);
  });

  it("an unreadable summary is no proof of the fingerprint: its case is dropped, never a throw", () => {
    seed(A, "new");
    seed(B, "new");
    writeFileSync(join(out, "cases", B.instance_id, "case-summary.json"), "{");
    const p = prep(true, "new");
    expect(p.dropped).toEqual([B.instance_id]);
    expect(has("results", "all", `${B.instance_id}.json`)).toBe(false);
    expect(has("cases", B.instance_id, "case-summary.json")).toBe(false);
    expect(has("results", "all", `${A.instance_id}.json`)).toBe(true);
    expect(has("results", "all", "metrics_ocr_round_1.json")).toBe(false);
  });

  it("a resume that keeps every case keeps the metrics until a case is reviewed again", () => {
    seed(A, "m");
    seed(B, "m");
    const log: string[] = [];
    const p = prep(true, "m", log);
    expect(p.dropped).toEqual([]);
    expect(has("results", "all", "metrics_ocr_round_1.json")).toBe(true);
    // A case reviewed again rewrites its result: the scores go, once.
    p.beforeReview();
    expect(has("results", "all", "metrics_ocr_round_1.json")).toBe(false);
    writeFileSync(join(out, "results", "all", "metrics_ocr_round_2.json"), "{}");
    p.beforeReview();
    expect(has("results", "all", "metrics_ocr_round_2.json")).toBe(true);
    expect(log.filter((l) => l.includes("metrics file(s)"))).toHaveLength(1);
  });
});

describe("the run record's lifecycle", () => {
  it("a resume keeps the start and appends itself; a fresh run starts over", () => {
    const previous = { started_at: "2026-01-01T00:00:00.000Z", resumes: [{ at: "x" }] };
    const r = runLifecycle(true, previous, { model: "m" });
    expect(r.started_at).toBe("2026-01-01T00:00:00.000Z");
    expect(r.resumes).toHaveLength(2);
    expect(r.resumes[1]).toMatchObject({ fingerprint: { model: "m" } });
    const f = runLifecycle(false, previous, { model: "m" });
    expect(f.started_at).not.toBe("2026-01-01T00:00:00.000Z");
    expect(f.resumes).toEqual([]);
    expect(runLifecycle(true, null, {}).resumes).toEqual([]);
  });
});

describe("the report's warnings section", () => {
  it("lists errors, warnings and a failed merge-base check; nothing when all is well", () => {
    expect(
      caseWarningsSection([{ instance_id: "a", status: "ok", merge_base_ok: true, warnings: [] }]),
    ).toEqual([]);
    const L = caseWarningsSection([
      { instance_id: "a", status: "ok", merge_base_ok: false, warnings: ["w1"] },
      { instance_id: "b", status: "failed", merge_base_ok: false, error: "e\nx", warnings: [] },
    ]);
    expect(L).toContain("## Warnings (case errors)");
    expect(L).toContain("- `a`: merge-base check failed — see case-summary.json");
    expect(L).toContain("- `a`: w1");
    expect(L).toContain("- `b`: e x");
    expect(L.some((l) => l.startsWith("- `b`: merge-base"))).toBe(false);
  });
});

describe("the bench CLI's usage", () => {
  it("lists every command its header documents, not a fixed number of lines", () => {
    const cli = join(ROOT, "dist", "src", "bench", "cli.js");
    if (!existsSync(cli)) throw new Error("dist/src/bench/cli.js is missing — run `npm run build`");
    const r = spawnSync(process.execPath, [cli, "no-such-command"], {
      encoding: "utf8",
      env: { PATH: process.env.PATH ?? "/usr/bin:/bin" },
    });
    expect(r.status).toBe(2);
    for (const cmd of [
      "ocr-review",
      "codex-review",
      "claude-rebuild",
      "pireview-review",
      "pragent-review",
      "defect-judge",
      "defect-report",
    ])
      expect(r.stderr, cmd).toContain(cmd);
    expect(r.stderr).not.toContain("import ");
  });
});
