// AACR-Bench what-if lever scorer — the fs half. Runs inside the sandbox
// (`bench.sh whatif …`) over a COPY of a finished run: bench.sh copies the
// source run's case files and scored results into `whatif/<id>/source/`
// (regular files only), and everything here reads that copy and writes
// beside it. The pure half — parsing, linking, the variants — is whatif.ts.
//
//   whatif/<id>/source/            the copied run (read here, never written)
//   whatif/<id>/results/<variant>/ the scorer's input, then its metrics
//   whatif/<id>/extract/<case>.json every raw candidate, every record link,
//                                  every extra comment and where it came from
//   whatif/<id>/whatif-cases.json  per-case counts
//   whatif/<id>/report.md          the numbers + what each variant newly matched

import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { safeId, type BenchCase, type CaseSet } from "./aacr.js";
import { latestMetrics } from "./report.js";
import { collectComments } from "./runner.js";
import {
  ADDED_DISPOSITIONS,
  allCandidateExtras,
  deltaVsControl,
  lineGate,
  linkRecord,
  parseFindingsRecord,
  rawCandidatesFromEvents,
  recordExtras,
  refOutcomes,
  whatifResult,
  WHATIF_VARIANTS,
  type ExtraCandidate,
  type LinkHow,
  type MetricsRound,
  type RefOutcome,
  type WhatifExcluded,
  type WhatifVariant,
} from "./whatif.js";

export const SOURCE_DIR = "source";
/** Written by bench.sh beside the copy: which run it was copied from. */
export const ORIGIN_FILE = "ORIGIN";

interface SourceRun {
  qcr_commit?: string;
  pi?: string;
  models?: { conversation?: string };
}

function readJson(path: string): unknown {
  try {
    return JSON.parse(readFileSync(path, "utf8"));
  } catch {
    return undefined;
  }
}

export interface WhatifCaseSummary {
  instance_id: string;
  source_status: string | null;
  raw: { candidates: number; dropped: number; passes: number };
  record: {
    rows: number;
    by_disposition: Record<string, number>;
    links: Partial<Record<LinkHow, number>>;
  };
  /** Comments in the run's own results/all file (the control). */
  posted: number;
  /** Whether the current collectComments() over the copied case files rebuilds
   * exactly those comments — null when the case files are not there. */
  posted_rebuilds: boolean | null;
  variants: Record<
    WhatifVariant,
    { comments: number; added: number; excluded: WhatifExcluded; from_record_evidence: number }
  >;
}

/** The comments the harness reads from a result file, as comparable tuples. */
function scoredTuples(result: unknown): Array<[string, number, string]> {
  const comments = (result as { review?: { comments?: unknown } } | undefined)?.review?.comments;
  if (!Array.isArray(comments)) return [];
  return comments.map((c) => {
    const r = c as Record<string, unknown>;
    return [String(r["path"]), Number(r["end_line"]), String(r["content"])];
  });
}

/**
 * One case: raw candidates from the copied event stream, the record linked
 * onto them, and the four variants' result files. The control is the run's
 * OWN results/all file — never rebuilt — so a missing one is an error, not
 * an empty case: without it there is nothing to compare against.
 */
export function buildWhatifCase(
  srcDir: string,
  c: BenchCase,
): {
  results: Record<WhatifVariant, Record<string, unknown>>;
  summary: WhatifCaseSummary;
  extract: Record<string, unknown>;
} {
  const id = safeId(c.instance_id);
  const caseDir = join(srcDir, "cases", id);
  const postedPath = join(srcDir, "results", "all", `${id}.json`);
  const posted = readJson(postedPath);
  if (posted === undefined) {
    throw new Error(
      `${c.instance_id}: no scored results/all file in the source run (${postedPath})`,
    );
  }
  const eventsPath = join(caseDir, "pi-events.jsonl");
  const raw = existsSync(eventsPath)
    ? rawCandidatesFromEvents(readFileSync(eventsPath, "utf8").split("\n"))
    : { candidates: [], passes: [], dropped: 0 };
  const record = parseFindingsRecord(readJson(join(caseDir, "findings-record.json")));
  const links = linkRecord(record, raw.candidates);

  const extras: Record<WhatifVariant, ExtraCandidate[]> = {
    posted: [],
    "posted+killed": recordExtras(links, raw.candidates, ADDED_DISPOSITIONS["posted+killed"]),
    "posted+merged": recordExtras(links, raw.candidates, ADDED_DISPOSITIONS["posted+merged"]),
    "all-candidates": allCandidateExtras(raw.candidates, links),
  };
  const results = {} as Record<WhatifVariant, Record<string, unknown>>;
  const variants = {} as WhatifCaseSummary["variants"];
  for (const v of WHATIF_VARIANTS) {
    const r = whatifResult(posted, v, extras[v]);
    results[v] = r.result;
    variants[v] = {
      comments: scoredTuples(r.result).length,
      added: r.added,
      excluded: r.excluded,
      from_record_evidence: extras[v].filter((x) => x.prov.text_source === "record-evidence")
        .length,
    };
  }

  // Does the current reader still rebuild the control from the case files? If
  // not, the control is still the run's own file — but the report says so.
  let rebuilds: boolean | null = null;
  if (existsSync(join(caseDir, "comments.json"))) {
    const collected = collectComments(caseDir).comments.filter((x) => x.side !== "LEFT");
    const want = collected.map((x) => [x.path, x.line, x.body] as [string, number, string]);
    rebuilds = JSON.stringify(want) === JSON.stringify(scoredTuples(posted));
  }

  const byDisp: Record<string, number> = {};
  for (const f of record) byDisp[f.disposition || "?"] = (byDisp[f.disposition || "?"] ?? 0) + 1;
  const linkCounts: Partial<Record<LinkHow, number>> = {};
  for (const l of links) linkCounts[l.how] = (linkCounts[l.how] ?? 0) + 1;
  const status = (readJson(join(caseDir, "case-summary.json")) as { status?: unknown } | undefined)
    ?.status;

  return {
    results,
    summary: {
      instance_id: c.instance_id,
      source_status: typeof status === "string" ? status : null,
      raw: {
        candidates: raw.candidates.length,
        dropped: raw.dropped,
        passes: raw.passes.length,
      },
      record: { rows: record.length, by_disposition: byDisp, links: linkCounts },
      posted: scoredTuples(posted).length,
      posted_rebuilds: rebuilds,
      variants,
    },
    extract: {
      instance_id: c.instance_id,
      passes: raw.passes,
      candidates: raw.candidates,
      links: links.map((l) => ({
        record_id: l.record.id,
        disposition: l.record.disposition,
        lenses: l.record.lenses,
        path: l.record.path,
        line: l.record.line ?? null,
        severity: l.record.severity,
        how: l.how,
        line_delta: l.lineDelta ?? null,
        candidate: l.candidate,
      })),
      extras,
    },
  };
}

/** Build every variant for the set's cases from `<outDir>/source`. */
export function writeWhatifRun(outDir: string, cases: readonly BenchCase[]): WhatifCaseSummary[] {
  const src = join(outDir, SOURCE_DIR);
  if (!existsSync(join(src, "results", "all"))) {
    throw new Error(`no source run at ${src} (bench.sh whatif copies it there first)`);
  }
  const summaries: WhatifCaseSummary[] = [];
  mkdirSync(join(outDir, "extract"), { recursive: true });
  for (const v of WHATIF_VARIANTS) mkdirSync(join(outDir, "results", v), { recursive: true });
  for (const c of cases) {
    const built = buildWhatifCase(src, c);
    const id = safeId(c.instance_id);
    for (const v of WHATIF_VARIANTS) {
      writeFileSync(
        join(outDir, "results", v, `${id}.json`),
        JSON.stringify(built.results[v], null, 2) + "\n",
      );
    }
    writeFileSync(
      join(outDir, "extract", `${id}.json`),
      JSON.stringify(built.extract, null, 2) + "\n",
    );
    summaries.push(built.summary);
  }
  writeFileSync(join(outDir, "whatif-cases.json"), JSON.stringify(summaries, null, 2) + "\n");
  return summaries;
}

// ---- the report ----------------------------------------------------------------

/** The per-round metrics files of one variant dir, first round first. A
 * single-round eval writes one file with no `_round_N` label; it is round 1. */
export function roundMetrics(dir: string): MetricsRound[] {
  if (!existsSync(dir)) return [];
  const roundNo = (n: string): number => Number(/_round_(\d+)\.json$/.exec(n)?.[1] ?? 0);
  return readdirSync(dir)
    .filter((n) => /^metrics_ocr_.*\.json$/.test(n) && !n.includes("average"))
    .sort((a, b) => roundNo(a) - roundNo(b) || a.localeCompare(b))
    .map((n) => JSON.parse(readFileSync(join(dir, n), "utf8")) as MetricsRound);
}

function num(v: number | undefined, digits = 2): string {
  if (v === undefined || Number.isNaN(v)) return "?";
  return Number.isInteger(v) ? String(v) : String(Math.round(v * 10 ** digits) / 10 ** digits);
}

function clip(s: string, n: number): string {
  const one = s.replace(/\s+/g, " ").trim();
  return one.length > n ? `${one.slice(0, n - 1)}…` : one;
}

/** Which comment of a variant's result file produced a matched note. */
function originOf(outDir: string, variant: WhatifVariant, instance: string, note: string): string {
  const file = readJson(join(outDir, "results", variant, `${safeId(instance)}.json`)) as
    | { review?: { comments?: Array<{ content?: string; qcr_whatif?: Record<string, unknown> }> } }
    | undefined;
  const hit = file?.review?.comments?.find((c) => (c.content ?? "").trim() === note.trim());
  const p = hit?.qcr_whatif;
  if (!p) return "?";
  if (p["origin"] === "posted") return "posted comment";
  const text = (k: string): string => (typeof p[k] === "string" ? p[k] : "");
  const bits = [text("origin"), text("lens"), text("severity")];
  if (p["text_source"] === "record-evidence") bits.push("record evidence");
  return bits.filter(Boolean).join(" · ");
}

export interface WhatifVariantScore {
  variant: WhatifVariant;
  rounds: number;
  generated: number | null;
  matched_avg: number | null;
  matched_per_round: number[];
  expected: number | null;
  precision: number | null;
  recall: number | null;
  f1: number | null;
  line_matched: number | null;
}

function scoreOf(outDir: string, v: WhatifVariant): WhatifVariantScore {
  const dir = join(outDir, "results", v);
  const rs = roundMetrics(dir);
  const avg = latestMetrics(dir)?.summary;
  return {
    variant: v,
    rounds: rs.length,
    generated: avg?.["generated_notes"] ?? null,
    matched_avg: avg?.["matched_semantic_notes"] ?? null,
    matched_per_round: rs.map((r) => r.summary["matched_semantic_notes"] ?? 0),
    expected: avg?.["expected_notes"] ?? null,
    precision: avg?.["semantic_match_rate"] ?? null,
    recall: avg?.["semantic_recall_rate"] ?? null,
    f1: avg?.["semantic_f1"] ?? null,
    line_matched: avg?.["matched_line_notes"] ?? null,
  };
}

function refLine(r: RefOutcome, v: WhatifVariant, own?: RefOutcome): string {
  const m = r.matched[v];
  const c = r.matched.posted;
  const o = own?.matched.posted;
  const lines = r.from_line === r.to_line ? `${r.from_line}` : `${r.from_line}-${r.to_line}`;
  return `\`${r.instance_id}\` \`${r.path}:${lines}\` — ${v} ${m?.rounds ?? 0}/${m?.of ?? 0} rounds vs posted ${c?.rounds ?? 0}/${c?.of ?? 0}${o ? ` (the source run's own scoring: ${o.rounds}/${o.of})` : ""}`;
}

/** The control's posted comments the judge could have paired with this
 * reference — same file, inside the harness's line gate. Empty means the
 * extra comment was the ONLY thing at that spot: a new catch if its text
 * holds. Non-empty means the round already posted there, and a gain is the
 * judge preferring other wording (or a second finding at the same spot). */
function postedInGate(outDir: string, r: RefOutcome): string[] {
  if (r.from_line === null || r.to_line === null) return [];
  const file = readJson(join(outDir, "results", "posted", `${safeId(r.instance_id)}.json`)) as
    { review?: { comments?: Array<Record<string, unknown>> } } | undefined;
  return (file?.review?.comments ?? [])
    .filter(
      (c) =>
        c["path"] === r.path &&
        typeof c["start_line"] === "number" &&
        typeof c["end_line"] === "number" &&
        lineGate(r.from_line!, r.to_line!, c["start_line"], c["end_line"]),
    )
    .map((c) => String(c["content"]));
}

/** The what-if report: per variant the harness's numbers, the control beside
 * the run's own score, and every reference whose match count moved — with
 * the reference text and OUR text the judge matched it to, so a reader can
 * tell a real catch from judge noise. */
export function renderWhatifReport(
  set: CaseSet,
  outDir: string,
  cases: readonly BenchCase[],
): { markdown: string; summary: Record<string, unknown> } {
  const src = join(outDir, SOURCE_DIR);
  const run = (readJson(join(src, "run.json")) ?? {}) as SourceRun;
  const origin = existsSync(join(src, ORIGIN_FILE))
    ? readFileSync(join(src, ORIGIN_FILE), "utf8").trim()
    : "?";
  const judge = existsSync(join(outDir, "judge.txt"))
    ? readFileSync(join(outDir, "judge.txt"), "utf8").trim().split("\n")
    : ["not run"];
  const srcJudge = existsSync(join(src, "judge.txt"))
    ? readFileSync(join(src, "judge.txt"), "utf8").trim().split("\n")[0]
    : "unknown";
  const own = latestMetrics(join(src, "results", "all"))?.summary;
  const cs = (readJson(join(outDir, "whatif-cases.json")) ?? []) as WhatifCaseSummary[];
  const scores = WHATIF_VARIANTS.map((v) => scoreOf(outDir, v));
  const rounds = Object.fromEntries(
    WHATIF_VARIANTS.map((v) => [v, roundMetrics(join(outDir, "results", v))]),
  ) as Record<WhatifVariant, MetricsRound[]>;
  const rows = refOutcomes(rounds);
  // The source run's own per-reference matches, for the control-noise column.
  const ownRows = new Map(
    refOutcomes({ posted: roundMetrics(join(src, "results", "all")) }).map((r) => [
      `${r.instance_id}#${r.ref}`,
      r,
    ]),
  );
  const ownOf = (r: RefOutcome): RefOutcome | undefined => ownRows.get(`${r.instance_id}#${r.ref}`);

  const L: string[] = [];
  L.push(`# AACR-Bench what-if — ${set.name}, source run \`${origin}\``);
  L.push("");
  L.push(
    `- Source run: QuickReview \`${String(run.qcr_commit ?? "?").slice(0, 10)}\`, conversation model \`${run.models?.conversation ?? "?"}\`, pi ${run.pi ?? "?"}, ${cases.length} PRs, ${cases.reduce((a, c) => a + c.references, 0)} references`,
  );
  L.push(`- Judge (this scoring): ${judge[0] ?? ""}`);
  for (const w of judge.slice(1)) L.push(`  ${w}`);
  L.push(`- Judge (the source run's own scoring): ${srcJudge}`);
  L.push(
    "- Variants: `posted` = the run's own results/all, byte-for-byte (the control); `posted+killed` = + every validator-KILLED candidate; `posted+merged` = + every MERGED/FOLDED candidate as its own comment; `all-candidates` = every raw lens candidate alone (validator excluded; deduped only on identical path, line and claim). Extra comments carry the lens's own `claim:` sentence at the lens's own anchor, single-line, RIGHT side only.",
  );
  L.push("");
  L.push("## Scores (semantic, the AACR harness, line-k 1)");
  L.push("");
  L.push(
    "| Variant | Rounds | Generated | Matched (avg) | Per round | Precision | Recall | F1 | Line-matched |",
  );
  L.push("|---|---|---|---|---|---|---|---|---|");
  for (const s of scores) {
    L.push(
      `| ${s.variant} | ${s.rounds} | ${num(s.generated ?? undefined)} | ${num(s.matched_avg ?? undefined)}/${num(s.expected ?? undefined)} | ${s.matched_per_round.join(" / ") || "—"} | ${num(s.precision ?? undefined, 4)} | ${num(s.recall ?? undefined, 4)} | ${num(s.f1 ?? undefined, 4)} | ${num(s.line_matched ?? undefined)} |`,
    );
  }
  if (own) {
    L.push(
      `| _source run's own \`all\`_ | — | ${num(own["generated_notes"])} | ${num(own["matched_semantic_notes"])}/${num(own["expected_notes"])} | — | ${num(own["semantic_match_rate"], 4)} | ${num(own["semantic_recall_rate"], 4)} | ${num(own["semantic_f1"], 4)} | ${num(own["matched_line_notes"])} |`,
    );
  }
  L.push("");
  const posted = scores.find((s) => s.variant === "posted");
  if (own && posted?.matched_avg !== null && posted?.matched_avg !== undefined) {
    const d = posted.matched_avg - (own["matched_semantic_notes"] ?? 0);
    L.push(
      `Control check: \`posted\` re-scored ${num(posted.matched_avg)} matched vs the source run's own ${num(own["matched_semantic_notes"])} (Δ ${d >= 0 ? "+" : ""}${num(d)}) — the scale of judge noise on this set; read every delta below against it.`,
    );
    L.push("");
  }

  L.push("## What each variant adds");
  L.push("");
  L.push(
    "| Case | Raw candidates | Record rows (disp.) | Posted | +killed | +merged/folded | all-candidates | Excluded (LEFT / no line) | Control rebuilds |",
  );
  L.push("|---|---|---|---|---|---|---|---|---|");
  for (const s of cs) {
    const disp = Object.entries(s.record.by_disposition)
      .map(([k, n]) => `${k} ${n}`)
      .join(", ");
    const ex = (v: WhatifVariant): string =>
      `${s.variants[v].excluded.left_side}/${s.variants[v].excluded.no_line}`;
    const ev = (v: WhatifVariant): string =>
      s.variants[v].from_record_evidence
        ? ` (${s.variants[v].from_record_evidence} from record evidence)`
        : "";
    L.push(
      `| ${s.instance_id} | ${s.raw.candidates} | ${s.record.rows} (${disp || "—"}) | ${s.posted} | ${s.variants["posted+killed"].added}${ev("posted+killed")} | ${s.variants["posted+merged"].added}${ev("posted+merged")} | ${s.variants["all-candidates"].added} | killed ${ex("posted+killed")}, merged ${ex("posted+merged")}, all ${ex("all-candidates")} | ${s.posted_rebuilds === null ? "n/a" : s.posted_rebuilds ? "yes" : "NO"} |`,
    );
  }
  L.push("");

  const deltas: Record<string, unknown> = {};
  for (const v of WHATIF_VARIANTS) {
    if (v === "posted") continue;
    const { gained, lost } = deltaVsControl(rows, v);
    deltas[v] = {
      gained: gained.map((r) => ({
        instance_id: r.instance_id,
        path: r.path,
        from_line: r.from_line,
        to_line: r.to_line,
        reference: r.note,
        rounds: r.matched[v]?.rounds,
        control_rounds: r.matched.posted?.rounds,
        source_own_rounds: ownOf(r)?.matched.posted?.rounds ?? null,
        matched_notes: (r.matched[v]?.notes ?? []).map((n) => ({
          text: n,
          origin: originOf(outDir, v, r.instance_id, n),
        })),
        posted_in_gate: postedInGate(outDir, r),
      })),
      lost: lost.map((r) => ({
        instance_id: r.instance_id,
        path: r.path,
        reference: r.note,
        rounds: r.matched[v]?.rounds,
        control_rounds: r.matched.posted?.rounds,
        source_own_rounds: ownOf(r)?.matched.posted?.rounds ?? null,
        control_notes: r.matched.posted?.notes ?? [],
      })),
    };
    L.push(`## ${v}: references matched more often than by the control (${gained.length})`);
    L.push("");
    if (!gained.length) L.push("_None._");
    for (const r of gained) {
      L.push(`- ${refLine(r, v, ownOf(r))}`);
      L.push(`  - **Reference:** ${clip(r.note, 600)}`);
      for (const n of r.matched[v]?.notes ?? [])
        L.push(`  - **Ours** (${originOf(outDir, v, r.instance_id, n)}): ${clip(n, 600)}`);
      const there = postedInGate(outDir, r);
      if (!there.length)
        L.push("  - The control posted NOTHING within this reference's line gate.");
      // A gain is only a HIGHER match rate: the control may have matched in
      // some rounds, and then with one of these very comments.
      const c = r.matched.posted;
      for (const t of there)
        L.push(
          `  - The control already posted here (${
            c?.notes.includes(t)
              ? `the judge accepted it in ${c.rounds}/${c.of} control rounds`
              : c?.rounds
                ? "the judge matched a different control comment"
                : "the judge did not accept it"
          }): ${clip(t, 300)}`,
        );
    }
    L.push("");
    L.push(`### ${v}: references matched LESS often than by the control (${lost.length})`);
    L.push("");
    L.push(
      v === "all-candidates"
        ? "_all-candidates drops the posted comments (it scores the raw lens claims alone), so a loss here can be real: the posted wording carried something the raw claim did not — or it is judge noise._"
        : "_A posted+ variant keeps every posted comment first and in order, so each of these is judge noise on the control's own comments._",
    );
    L.push("");
    if (!lost.length) L.push("_None._");
    for (const r of lost) {
      L.push(`- ${refLine(r, v, ownOf(r))}`);
      L.push(`  - **Reference:** ${clip(r.note, 300)}`);
      for (const n of r.matched.posted?.notes ?? [])
        L.push(`  - **Control matched:** ${clip(n, 300)}`);
    }
    L.push("");
  }
  L.push(
    "Reading this: the judge is `pi -p` on a GPT model at its default temperature, and it is noisy — the same pair can be judged yes/no across rounds. A reference gained in 1 of 3 rounds is weak evidence; one gained in 3 of 3 whose OUR text states the reference's defect is a real catch the validator or the merge step removed. Precision counts every comment against the dataset's references only, so extra comments that are true but unrecorded still count as false positives.",
  );
  L.push("");
  return {
    markdown: L.join("\n"),
    summary: {
      set: set.name,
      source: { origin, ...run },
      judge,
      scores,
      own: own ?? null,
      deltas,
      cases: cs,
    },
  };
}
