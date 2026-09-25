// The AACR-Bench what-if lever scorer (src/bench/whatif.ts, whatifrun.ts,
// `bench.sh whatif`). What is pinned here:
//
//   1. the RAW lens candidates come out of pi's event stream exactly as the
//      lenses wrote them — the validator excluded, junk lines skipped, the
//      findings-block grammar parsed tolerantly but never repaired;
//   2. every findings-record row is linked back to its lens candidate, so a
//      KILLED or MERGED row scores with the lens's own claim — never with the
//      record's `reason` (for those rows, WHY it was dropped);
//   3. the variants: `posted` is the run's own results/all comments, in order;
//      a posted+ variant keeps them first and appends; `all-candidates` is the
//      raw candidates alone; toOcrResult's rules hold (single line, RIGHT only,
//      no lineless comment — the harness would skip its line gate for one);
//   4. the report reads the harness's per-round metrics back and names every
//      reference whose match count moved, with the reference and OUR text;
//   5. bench.sh copies a source run into whatif/<id>/source without following
//      anything the review sandbox could have planted, and runs every
//      container hardened.
//
// Fixtures (tests/fixtures/bench-whatif/source): five cases cut from the real
// smoke10-2 run (gpt-5.6-sol, 2026-09-25) — every `subagent` tool_execution_end
// event with each pass reduced to its final findings text (task elided), plus
// one bash event and one non-JSON line; the case's findings record, comments,
// review body (its bot-name footer genericised for the publishability lint),
// summary and scored results/all file verbatim.

import { describe, expect, it } from "vitest";
import { spawnSync } from "node:child_process";
import {
  chmodSync,
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseCaseSet, selectCases } from "../src/bench/aacr.js";
import {
  allCandidateExtras,
  deltaVsControl,
  lineGate,
  linkRecord,
  lensOutputsFromEvents,
  normalizeLens,
  parseFindingsBlock,
  parseFindingsRecord,
  rawCandidatesFromEvents,
  recordExtras,
  refOutcomes,
  toOcrComments,
  whatifResult,
  WHATIF_VARIANTS,
  type MetricsRound,
  type RawCandidate,
} from "../src/bench/whatif.js";
import {
  buildWhatifCase,
  renderWhatifReport,
  roundMetrics,
  writeWhatifRun,
} from "../src/bench/whatifrun.js";

const here = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(here, "..");
const FIX = join(here, "fixtures", "bench-whatif", "source");
const SET = parseCaseSet(
  JSON.parse(readFileSync(join(ROOT, "bench", "aacr", "sets", "smoke10.json"), "utf8")),
);
const IDS = readdirSync(join(FIX, "cases")).sort();
const CASES = selectCases(SET, IDS);

function events(id: string): string[] {
  return readFileSync(join(FIX, "cases", id, "pi-events.jsonl"), "utf8").split("\n");
}
function record(id: string): unknown {
  return JSON.parse(readFileSync(join(FIX, "cases", id, "findings-record.json"), "utf8"));
}
function postedFile(id: string): { review: { comments: Array<Record<string, unknown>> } } {
  return JSON.parse(readFileSync(join(FIX, "results", "all", `${id}.json`), "utf8"));
}
const COMFY = "comfyanonymous__ComfyUI@0bb6023";
const DBEAVER = "dbeaver__dbeaver@bc3ac7b";
const RAGFLOW = "infiniflow__ragflow@7051234";
const LVGL = "lvgl__lvgl@4a57db3";
const OLLAMA = "ollama__ollama@b6002f6";
const WHO = { lens: "pass-baseline", agent: "pass-baseline--terra-med", call: 0 };

describe("raw lens candidates from pi's event stream", () => {
  it("reads every pass's final findings text, skips non-subagent events and junk lines", () => {
    const outs = lensOutputsFromEvents(events(RAGFLOW));
    expect(outs.map((o) => o.lens)).toEqual([
      "pass-intent",
      "pass-placement",
      "pass-backcompat",
      "pass-simplicity",
      "pass-baseline",
      "pass-security",
      "pass-validate",
    ]);
    expect(outs.every((o) => o.text.startsWith("FINDINGS "))).toBe(true);
    // Seven separate `single` calls in this case, one pass each.
    expect(outs.map((o) => o.call)).toEqual([0, 1, 2, 3, 4, 5, 6]);
  });

  it("the validator is not a lens: its survivors are rewrites, never raw candidates", () => {
    const raw = rawCandidatesFromEvents(events(RAGFLOW));
    expect(raw.candidates).toHaveLength(12);
    expect(raw.candidates.some((c) => c.lens === "pass-validate")).toBe(false);
    expect(raw.passes.map((p) => p.agent)).not.toContain("pass-validate--sol-high");
    expect(raw.dropped).toBe(0);
    // Two validator calls in ollama, neither contributes.
    const ol = rawCandidatesFromEvents(events(OLLAMA));
    expect(ol.candidates.map((c) => c.lens).sort()).toEqual([
      "pass-baseline",
      "pass-baseline",
      "pass-simplicity",
      "pass-simplicity",
    ]);
  });

  it("keeps the lens's own anchor, side and wording — a LEFT side and a missing line included", () => {
    const raw = rawCandidatesFromEvents(events(COMFY)).candidates;
    expect(raw).toHaveLength(5);
    const left = raw.find((c) => c.side === "LEFT")!;
    expect(left).toMatchObject({
      lens: "pass-backcompat",
      path: "notebooks/comfyui_colab.ipynb",
      line: 240,
    });
    const lineless = raw.find((c) => c.line === undefined)!;
    expect(lineless).toMatchObject({ lens: "pass-baseline", severity: "P1" });
    expect(lineless.claim).toMatch(/^The alternative Colab launch cells now reference modules/);
    const ruff = raw.find((c) => c.path === "ruff.toml" && c.lens === "pass-baseline")!;
    expect(ruff).toMatchObject({ line: 9, severity: "P1", confidence: 0.98 });
    expect(ruff.claim).toBe(
      "The configuration still ignores every Ruff rule, so selecting `F` does not enforce any Pyflakes checks.",
    );
  });

  it("parses the block grammar tolerantly and never repairs a finding", () => {
    const text = [
      "FINDINGS baseline PR#1 @abc",
      "```",
      "- title: A title the model added",
      "  path: `./src/a.py`",
      "  line: 848-857",
      "  side: RIGHT",
      "  severity: **P1**",
      "  confidence: 0.9",
      "  claim: The loop never terminates",
      "    when the log grows during pagination.",
      "  evidence: a.py:848 — note: see below",
      "    - a nested bullet: inside evidence, not a finding",
      "  required compatibility invariant: free-form keys are kept out of the claim",
      "- path: src/b.py:42",
      "  severity: nit",
      "  claim: Rename `x`.",
      "- path: src/c.py",
      "  line: 3",
      "  severity: P2",
      "- claim: no path here",
      "```",
      "NONE",
    ].join("\n");
    const { candidates, dropped } = parseFindingsBlock(text, WHO);
    expect(dropped).toBe(2); // no claim; no path
    expect(candidates).toHaveLength(2);
    expect(candidates[0]).toMatchObject({
      path: "src/a.py",
      line: 857, // a range anchors at its END, as GitHub's `line` does
      side: "RIGHT",
      severity: "P1",
      confidence: 0.9,
      title: "A title the model added",
      claim: "The loop never terminates when the log grows during pagination.",
    });
    expect(candidates[0]!.evidence).toContain("a nested bullet: inside evidence");
    expect(candidates[1]).toMatchObject({ path: "src/b.py", line: 42, severity: "nit" });
    expect(parseFindingsBlock("FINDINGS intent PR#1 @abc\nNONE", WHO).candidates).toEqual([]);
  });

  it("normalises lens names from agents, records and headers alike", () => {
    expect(normalizeLens("pass-security--sol-high")).toBe("pass-security");
    expect(normalizeLens("baseline")).toBe("pass-baseline");
    expect(normalizeLens(" Pass-Intent ")).toBe("pass-intent");
  });
});

describe("the findings record, linked back onto the lens candidates", () => {
  it("links every row it can by lens + file + nearest line, one-to-one", () => {
    const raw = rawCandidatesFromEvents(events(RAGFLOW)).candidates;
    const links = linkRecord(parseFindingsRecord(record(RAGFLOW)), raw);
    expect(links.every((l) => l.how === "lens+path+line")).toBe(true);
    const used = links.map((l) => l.candidate);
    expect(new Set(used).size).toBe(used.length);
    // f5: the validator re-anchored simplicity's :35 to :36.
    const f5 = links.find((l) => l.record.id === "f5")!;
    expect(f5.lineDelta).toBe(1);
    expect(raw[f5.candidate!]).toMatchObject({ lens: "pass-simplicity", line: 35 });
  });

  it("a row the session re-anchored onto another file is linked by the same lens's words", () => {
    // comfy f4: placement anchored the notebook breakage on ruff.toml:9; the
    // record files it under the notebook.
    const raw = rawCandidatesFromEvents(events(COMFY)).candidates;
    const f4 = linkRecord(parseFindingsRecord(record(COMFY)), raw).find(
      (l) => l.record.id === "f4",
    )!;
    expect(f4.how).toBe("lens+text");
    expect(raw[f4.candidate!]!.claim).toMatch(/Pyflakes rules to the notebook/);
  });

  it("a row no lens wrote (the validator's own finding) stays unlinked", () => {
    const raw = rawCandidatesFromEvents(events(OLLAMA)).candidates;
    const f5 = linkRecord(parseFindingsRecord(record(OLLAMA)), raw).find(
      (l) => l.record.id === "f5",
    )!;
    expect(f5).toMatchObject({ how: "unlinked", candidate: null });
  });

  it("killed rows score with the LENS'S claim — never the record's reason", () => {
    for (const id of [COMFY, DBEAVER, LVGL, OLLAMA]) {
      const raw = rawCandidatesFromEvents(events(id)).candidates;
      const rec = parseFindingsRecord(record(id));
      const extras = recordExtras(linkRecord(rec, raw), raw, ["killed"]);
      const killed = rec.filter((f) => f.disposition === "killed");
      expect(extras, id).toHaveLength(killed.length);
      for (const x of extras) {
        expect(x.prov.text_source, id).toBe("lens-claim");
        expect(
          raw.map((c) => c.claim),
          id,
        ).toContain(x.content);
        for (const f of killed) expect(x.content, id).not.toBe(f.reason);
      }
    }
  });

  it("an unlinkable dropped row falls back to its EVIDENCE, flagged — its reason never", () => {
    const rec = parseFindingsRecord({
      findings: [
        {
          id: "k1",
          disposition: "killed",
          lens: "pass-baseline",
          path: "x.py",
          line: 7,
          severity: "P2",
          evidence: "x.py:7 reads a closed handle",
          reason: "refuted: the handle is reopened",
        },
      ],
    });
    const [x] = recordExtras(linkRecord(rec, []), [], ["killed"]);
    expect(x).toMatchObject({
      path: "x.py",
      line: 7,
      content: "x.py:7 reads a closed handle",
      prov: { text_source: "record-evidence", link: "unlinked", origin: "killed" },
    });
  });
});

describe("the variants", () => {
  it("posted is the run's own results/all, comment for comment, in order", () => {
    for (const id of IDS) {
      const built = buildWhatifCase(
        FIX,
        CASES.find((c) => c.instance_id === id)!,
      );
      const own = postedFile(id).review.comments;
      const got = (built.results.posted["review"] as { comments: Array<Record<string, unknown>> })
        .comments;
      expect(
        got.map(({ qcr_whatif: _q, ...c }) => c),
        id,
      ).toEqual(own);
      expect(built.summary.posted_rebuilds, id).toBe(true);
    }
  });

  it("a posted+ variant keeps every posted comment first, then appends; all-candidates drops them", () => {
    const built = buildWhatifCase(
      FIX,
      CASES.find((c) => c.instance_id === DBEAVER)!,
    );
    const own = postedFile(DBEAVER).review.comments;
    type C = { content: string; qcr_whatif: { origin: string } };
    const killed = (built.results["posted+killed"]["review"] as { comments: C[] }).comments;
    expect(killed.slice(0, own.length).map((c) => c.content)).toEqual(own.map((c) => c.content));
    expect(killed.slice(own.length).map((c) => c.qcr_whatif.origin)).toEqual(["killed", "killed"]);
    const all = (built.results["all-candidates"]["review"] as { comments: C[] }).comments;
    expect(all.every((c) => c.qcr_whatif.origin === "candidate")).toBe(true);
    expect(all).toHaveLength(4);
    // The run's cost fields ride along untouched.
    expect(built.results["all-candidates"]["review"]).toMatchObject({
      summary: (postedFile(DBEAVER).review as unknown as { summary: unknown }).summary,
    });
  });

  it("converts by toOcrResult's rules: single line, RIGHT only, no lineless comment", () => {
    const c = (over: Partial<RawCandidate>): RawCandidate => ({
      ...WHO,
      index: 0,
      path: "a.ts",
      side: "RIGHT",
      severity: "P2",
      claim: "claim",
      ...over,
    });
    const extras = allCandidateExtras([
      c({ line: 10 }),
      c({ line: 11, side: "LEFT" }),
      c({ claim: "no anchor" }),
    ]);
    const { comments, excluded } = toOcrComments(extras);
    expect(comments).toEqual([
      expect.objectContaining({ path: "a.ts", start_line: 10, end_line: 10, content: "claim" }),
    ]);
    // A lineless comment would pass the harness's line gate for EVERY
    // reference in its file (judge.py skips stage 3 on a None line).
    expect(excluded).toEqual({ left_side: 1, no_line: 1 });
  });

  it("all-candidates dedupes only identical path + line + claim", () => {
    const base = { ...WHO, index: 0, path: "a.ts", side: "RIGHT" as const, severity: "P2" };
    const extras = allCandidateExtras([
      { ...base, line: 5, claim: "same" },
      { ...base, line: 5, claim: "same", lens: "pass-intent" },
      { ...base, line: 5, claim: "different wording, same defect" },
      { ...base, line: 6, claim: "same" },
    ]);
    expect(extras.map((x) => `${x.line}:${x.content}`)).toEqual([
      "5:same",
      "5:different wording, same defect",
      "6:same",
    ]);
  });

  it("a lineless lens candidate takes the line the session gave its record row", () => {
    const built = buildWhatifCase(
      FIX,
      CASES.find((c) => c.instance_id === COMFY)!,
    );
    type C = { path: string; end_line: number; qcr_whatif: { anchor: string; lens: string } };
    const all = (built.results["all-candidates"]["review"] as { comments: C[] }).comments;
    const fromRecord = all.filter((c) => c.qcr_whatif.anchor === "record");
    expect(fromRecord).toEqual([
      expect.objectContaining({ path: "notebooks/comfyui_colab.ipynb", end_line: 240 }),
    ]);
    // …and the LEFT-side backcompat candidate is excluded, and counted.
    expect(built.summary.variants["all-candidates"].excluded).toEqual({ left_side: 1, no_line: 0 });
  });

  it("whatifResult on a failed case (no comments) still yields a file", () => {
    const r = whatifResult({ review: { comments: [] } }, "posted+killed", []);
    expect(r.result["review"]).toMatchObject({ comments: [] });
  });
});

function metrics(
  rows: Array<{ id: string; refs: Array<[boolean, string]> }>,
  matched: number,
): MetricsRound {
  return {
    summary: {
      evaluated_instances: rows.length,
      expected_notes: rows.reduce((a, r) => a + r.refs.length, 0),
      generated_notes: 10,
      matched_semantic_notes: matched,
      matched_line_notes: matched,
      semantic_match_rate: matched / 10,
      semantic_recall_rate: 0.1,
      semantic_f1: 0.1,
    },
    eval_res: rows.map((r) => ({
      instance_id: r.id,
      comments: r.refs.map(([m, note], i) => ({
        note: `reference ${i} of ${r.id}`,
        path: "p.py",
        from_line: 1,
        to_line: 2,
        line_match: m,
        semantic_match: m,
        matched_note: m ? note : "",
      })),
    })),
  };
}

describe("reading the scored metrics back", () => {
  it("counts per reference the rounds each variant matched it, and diffs against the control", () => {
    const rounds = {
      posted: [
        metrics(
          [
            {
              id: "a",
              refs: [
                [true, "P"],
                [false, ""],
              ],
            },
          ],
          1,
        ),
        metrics(
          [
            {
              id: "a",
              refs: [
                [false, ""],
                [false, ""],
              ],
            },
          ],
          0,
        ),
      ],
      "posted+killed": [
        metrics(
          [
            {
              id: "a",
              refs: [
                [true, "P"],
                [true, "K"],
              ],
            },
          ],
          2,
        ),
        metrics(
          [
            {
              id: "a",
              refs: [
                [true, "P"],
                [true, "K"],
              ],
            },
          ],
          2,
        ),
      ],
      "all-candidates": [
        metrics(
          [
            {
              id: "a",
              refs: [
                [false, ""],
                [false, ""],
              ],
            },
          ],
          0,
        ),
        metrics(
          [
            {
              id: "a",
              refs: [
                [false, ""],
                [false, ""],
              ],
            },
          ],
          0,
        ),
      ],
    } as const;
    const rows = refOutcomes(rounds);
    expect(rows).toHaveLength(2);
    expect(rows[1]!.matched["posted+killed"]).toEqual({ rounds: 2, of: 2, notes: ["K"] });
    const k = deltaVsControl(rows, "posted+killed");
    expect(k.gained.map((r) => r.ref)).toEqual([0, 1]); // ref 0: 2/2 vs the control's 1/2
    expect(k.lost).toEqual([]);
    const all = deltaVsControl(rows, "all-candidates");
    expect(all.gained).toEqual([]);
    expect(all.lost.map((r) => r.ref)).toEqual([0]);
  });

  it("mirrors the harness's line gate (overlap, or within k lines)", () => {
    expect(lineGate(10, 12, 12, 12)).toBe(true); // overlap at the edge
    expect(lineGate(10, 12, 13, 13)).toBe(true); // 1 line away, k = 1
    expect(lineGate(10, 12, 14, 14)).toBe(false);
    expect(lineGate(10, 12, 8, 8)).toBe(false);
    expect(lineGate(10, 12, 9, 9)).toBe(true);
    expect(lineGate(10, 10, 5, 20)).toBe(true); // a span around the reference
  });

  it("reads rounds in round order, never the average; a single-round eval's unlabelled file is round 1", () => {
    const dir = mkdtempSync(join(tmpdir(), "whatif-m-"));
    const m = (n: number): string => JSON.stringify(metrics([{ id: "a", refs: [] }], n));
    writeFileSync(join(dir, "metrics_ocr_20260925_2_round_10.json"), m(10));
    writeFileSync(join(dir, "metrics_ocr_20260925_1_round_2.json"), m(2));
    writeFileSync(join(dir, "metrics_ocr_average.json"), m(99));
    expect(roundMetrics(dir).map((r) => r.summary["matched_semantic_notes"])).toEqual([2, 10]);
    const one = mkdtempSync(join(tmpdir(), "whatif-m1-"));
    writeFileSync(join(one, "metrics_ocr_20260925_212957.json"), m(4));
    expect(roundMetrics(one).map((r) => r.summary["matched_semantic_notes"])).toEqual([4]);
  });

  it("writes every variant for a copied run, and a report naming OUR text for each new match", () => {
    const out = mkdtempSync(join(tmpdir(), "whatif-"));
    cpSync(FIX, join(out, "source"), { recursive: true });
    writeFileSync(join(out, "source", "ORIGIN"), "/runs/smoke10-2\n");
    const summaries = writeWhatifRun(out, CASES);
    expect(summaries.map((s) => s.instance_id)).toEqual(IDS);
    for (const v of WHATIF_VARIANTS)
      expect(readdirSync(join(out, "results", v)).sort()).toEqual(IDS.map((i) => `${i}.json`));
    // Fake the harness's output: the killed ruff claim matches a reference in
    // every posted+killed round, and never in the control.
    const ruff =
      "The configuration still ignores every Ruff rule, so selecting `F` does not enforce any Pyflakes checks.";
    const refs = (m: boolean): Array<[boolean, string]> => [[m, m ? ruff : ""]];
    for (const [v, m] of [
      ["posted", false],
      ["posted+killed", true],
      ["posted+merged", false],
      ["all-candidates", true],
    ] as const) {
      for (const r of [1, 2, 3]) {
        writeFileSync(
          join(out, "results", v, `metrics_ocr_2026_round_${r}.json`),
          JSON.stringify(metrics([{ id: COMFY, refs: refs(m) }], m ? 1 : 0)),
        );
      }
    }
    const r = renderWhatifReport(SET, out, CASES);
    expect(r.markdown).toContain("source run `/runs/smoke10-2`");
    expect(r.markdown).toMatch(
      /## posted\+killed: references matched more often than by the control \(1\)/,
    );
    expect(r.markdown).toContain(`**Reference:** reference 0 of ${COMFY}`);
    expect(r.markdown).toContain(`**Ours** (killed · pass-baseline · P1): ${ruff}`);
    expect(r.markdown).toContain("3/3 rounds vs posted 0/3");
    // The ruff reference sits at p.py:1-2 in the fake metrics, where the
    // control posted nothing: the report says the extra was alone there.
    expect(r.markdown).toContain("The control posted NOTHING within this reference's line gate.");
    expect(r.markdown).toMatch(
      /## posted\+merged: references matched more often than by the control \(0\)/,
    );
  });
});

describe("bench.sh whatif: the copy follows nothing, and every container is hardened", () => {
  const sh = readFileSync(join(ROOT, "bench", "aacr", "bench.sh"), "utf8");

  it("runs the what-if steps in the same hardened sandbox, the login read-only", () => {
    const block = sh.slice(sh.indexOf("  whatif|whatif-eval)"), sh.indexOf("  shell)"));
    expect(block).toContain(
      '"${HARDEN[@]}" --network none --mount "type=bind,src=$d,dst=/bench-out"',
    );
    expect(block).toContain("judge_args");
    expect(block).not.toMatch(/src=\$HOME|src=~|\$REPO/);
    expect(sh).toContain(
      "type=volume,src=$AUTH_VOLUME,dst=/pi-agent-src,volume-subpath=agent,readonly",
    );
    expect(sh).toContain('>> "$HERE/whatif/$RUN.sandbox-commands.log"');
  });

  it("copies only regular files from the source run, and mounts only whatif/<id>", () => {
    // Run the real script against a stub `docker` in a scratch tree: the copy
    // is real, every docker call is logged instead of executed.
    const tmp = mkdtempSync(join(tmpdir(), "whatif-sh-"));
    const here = join(tmp, "repo", "bench", "aacr");
    mkdirSync(here, { recursive: true });
    cpSync(join(ROOT, "bench", "aacr", "bench.sh"), join(here, "bench.sh"));
    const bin = join(tmp, "bin");
    mkdirSync(bin);
    const log = join(tmp, "docker.log");
    writeFileSync(join(bin, "docker"), `#!/usr/bin/env bash\nprintf '%s\\n' "$*" >> "${log}"\n`);
    chmodSync(join(bin, "docker"), 0o755);
    // A source run with a planted symlink where a case file should be.
    const src = join(tmp, "src-run");
    const secret = join(tmp, "secret.txt");
    writeFileSync(secret, "do not copy me");
    cpSync(FIX, src, { recursive: true });
    symlinkSync(secret, join(src, "cases", COMFY, "outcome.json"));
    symlinkSync(secret, join(src, "results", "all", "planted@0000000.json"));
    mkdirSync(join(src, "cases", "not-an-instance"));
    const r = spawnSync(
      "bash",
      [join(here, "bench.sh"), "whatif", "--run", "t1", "--from", src, "--judge", "mock"],
      { env: { ...process.env, PATH: `${bin}:${process.env.PATH}` }, encoding: "utf8" },
    );
    // The stub never writes results/posted, so the script stops right after
    // the generation container — which is all this test needs.
    expect(r.stderr).toContain("no what-if variants");
    const dst = join(here, "whatif", "t1", "source");
    expect(existsSync(join(dst, "cases", COMFY, "pi-events.jsonl"))).toBe(true);
    expect(existsSync(join(dst, "cases", COMFY, "outcome.json"))).toBe(false);
    expect(existsSync(join(dst, "results", "all", "planted@0000000.json"))).toBe(false);
    expect(existsSync(join(dst, "cases", "not-an-instance"))).toBe(false);
    expect(readFileSync(join(dst, "ORIGIN"), "utf8").trim()).toBe(src);
    const calls = readFileSync(log, "utf8").trim().split("\n");
    const run = calls.find((l) => l.startsWith("run "))!;
    for (const flag of ["--read-only", "--cap-drop ALL", "no-new-privileges", "--network none"])
      expect(run).toContain(flag);
    expect(run).toContain(`type=bind,src=${join(here, "whatif", "t1")},dst=/bench-out`);
    expect(run.match(/type=bind/g)).toHaveLength(1);
    // A second prepare into the same id is refused without --force.
    const again = spawnSync(
      "bash",
      [join(here, "bench.sh"), "whatif", "--run", "t1", "--from", src],
      { env: { ...process.env, PATH: `${bin}:${process.env.PATH}` }, encoding: "utf8" },
    );
    expect(again.status).not.toBe(0);
    expect(again.stderr).toContain("exists");
  });
});
