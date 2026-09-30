// `codex-review` / `codex-report` — the Codex CLI arm's commands, called from
// cli.ts. Cases run ONE AT A TIME, as the harness's pipeline runs them by
// default (`--concurrency 1`), each with a fresh refresh-disabled token copy.

import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { safeId, selectCases, type BenchCase, type CaseSet, type PrefetchMeta } from "./aacr.js";
import { AuthExpiring, syncBenchAuth } from "./auth.js";
import {
  CODEX_HARNESS_DEFAULTS,
  codexProcessTimeoutMs,
  readCodexSummary,
  reviewCaseCodex,
  unprefetchedCodexCase,
  type CodexCaseSummary,
  type CodexFingerprint,
} from "./codex.js";
import { renderCodexReport } from "./codexreport.js";
import { run } from "./exec.js";
import { runArmOf } from "./ocr.js";

export interface CodexCliDeps {
  root: string;
  store: string;
  authSrc: string;
  agentDir: string;
  get: (k: string) => string | undefined;
  has: (k: string) => boolean;
  loadSet: (path: string | undefined) => CaseSet;
  only: string[] | undefined;
  readMeta: (store: string, c: BenchCase) => PrefetchMeta;
  log: (line: string) => void;
}

function assertCodexRun(outDir: string): void {
  const found = runArmOf(outDir);
  if (found !== null && found !== "codex")
    throw new Error(
      `${outDir} is not a Codex CLI run (it holds the ${found} arm) — bench.sh --arm ${found}`,
    );
}

export async function codexCommand(cmd: string, d: CodexCliDeps): Promise<number> {
  const set = d.loadSet(d.get("--set"));
  if (!d.get("--out")) throw new Error("--out <dir> is required");
  const outDir = d.get("--out")!;
  const cases = selectCases(set, d.only);
  if (cmd === "codex-report") {
    assertCodexRun(outDir);
    writeFileSync(join(outDir, "report.md"), renderCodexReport(set, outDir, cases));
    d.log(`report: ${join(outDir, "report.md")}`);
    return 0;
  }
  const python = d.get("--python") ?? "/opt/aacr-venv/bin/python";
  const driver = d.get("--driver") ?? "/opt/quickreview/bench/codex_arm.py";
  const dataset = d.get("--dataset") ?? "/opt/aacr-data/aacr_bench_v1.jsonl";
  const model = d.get("--model") ?? process.env.QCR_CODEX_MODEL ?? "gpt-6-sol";
  const effort = d.get("--effort") ?? process.env.QCR_CODEX_EFFORT ?? "medium";
  const timeoutMin = Number(d.get("--timeout-min") ?? CODEX_HARNESS_DEFAULTS.timeoutMin);
  if (!Number.isInteger(timeoutMin) || timeoutMin < 1)
    throw new Error("codex-review: --timeout-min must be a positive integer");
  if (!/^(minimal|low|medium|high|xhigh|max)$/.test(effort))
    throw new Error("codex-review: effort must be minimal|low|medium|high|xhigh|max");
  const v = await run("codex", ["--version"], { env: { ...process.env } });
  const codexVersion =
    /codex-cli\s+(\S+)/.exec(v.stdout)?.[1] ?? process.env.QCR_CODEX_VERSION ?? "unknown";
  const fingerprint: CodexFingerprint = {
    qcr_commit: process.env.QCR_BENCH_COMMIT ?? "unknown",
    codex_version: codexVersion,
    model,
    effort,
    timeout_min: timeoutMin,
  };
  const resume = d.has("--resume");
  mkdirSync(outDir, { recursive: true });
  assertCodexRun(outDir);
  const runFile = join(outDir, "run.json");
  const previous = existsSync(runFile)
    ? (JSON.parse(readFileSync(runFile, "utf8")) as Record<string, unknown>)
    : null;
  // run.json is about to carry THIS configuration, so no case reviewed under
  // another may stay a result of the run: without --resume every case goes;
  // with it, every case whose fingerprint differs goes now, not when the loop
  // reaches it — a stop partway (AuthExpiring) must leave those cases
  // incomplete, never scored under the new model/effort label.
  for (const c of cases) {
    const prior = resume ? readCodexSummary(outDir, c) : null;
    if (resume && (!prior || JSON.stringify(prior.fingerprint) === JSON.stringify(fingerprint))) continue;
    if (prior) d.log(`codex: ${c.instance_id} was reviewed by a different Codex/model/effort — its result is dropped`);
    rmSync(join(outDir, "cases", safeId(c.instance_id), "case-summary.json"), { force: true });
    rmSync(join(outDir, "results", "all", `${safeId(c.instance_id)}.json`), { force: true });
  }
  const runRecord = {
    reviewer: "codex",
    set: set.name,
    dataset: set.dataset,
    codex_version: codexVersion,
    model,
    effort,
    timeout_min: timeoutMin,
    endpoint: "ChatGPT Codex backend, Codex's native ChatGPT auth (refresh-disabled token copy)",
    runner: "AACR harness evaluation/reviewers/codex.py (via bench/aacr/codex_arm.py)",
    qcr_commit: fingerprint.qcr_commit,
    cases: cases.map((c) => c.instance_id),
    started_at:
      (resume && typeof previous?.["started_at"] === "string" && previous["started_at"]) ||
      new Date().toISOString(),
    resumes: [
      ...(resume && Array.isArray(previous?.["resumes"]) ? (previous["resumes"] as unknown[]) : []),
      ...(resume && previous ? [{ at: new Date().toISOString(), fingerprint }] : []),
    ],
    finished_at: null as string | null,
  };
  writeFileSync(runFile, JSON.stringify(runRecord, null, 2) + "\n");
  const summaries: CodexCaseSummary[] = [];
  let stopped: string | null = null;
  for (const c of cases) {
    const prior = readCodexSummary(outDir, c);
    // (a prior summary here carries this run's fingerprint — the others went above)
    if (resume && prior && prior.status === "ok") {
      d.log(`codex: ${c.instance_id} already done — skipped (--resume)`);
      summaries.push(prior);
      continue;
    }
    try {
      syncBenchAuth({
        srcDir: d.authSrc,
        dstDir: d.agentDir,
        root: d.root,
        needMs: codexProcessTimeoutMs(timeoutMin) + 5 * 60_000,
      });
    } catch (err) {
      if (!(err instanceof AuthExpiring)) throw err;
      stopped = err.message;
      d.log(`codex: STOPPED — ${err.message}`);
      break;
    }
    let meta: PrefetchMeta;
    try {
      meta = d.readMeta(d.store, c);
    } catch (err) {
      const error = String(err instanceof Error ? err.message : err);
      d.log(error);
      summaries.push(unprefetchedCodexCase(outDir, c, fingerprint, model, error));
      continue;
    }
    summaries.push(
      await reviewCaseCodex(c, meta, {
        root: d.root,
        store: d.store,
        outDir,
        benchAuthFile: join(d.agentDir, "auth.json"),
        codexAuthFile: join(d.agentDir, "codex-auth.json"),
        python,
        driver,
        dataset,
        model,
        effort,
        timeoutMin,
        fingerprint,
        keepTree: d.has("--keep-tree"),
        log: d.log,
      }),
    );
  }
  runRecord.finished_at = new Date().toISOString();
  writeFileSync(runFile, JSON.stringify(runRecord, null, 2) + "\n");
  const ok = summaries.filter((s) => s.status === "ok").length;
  d.log(`codex: ${ok}/${cases.length} reviewed — results in ${join(outDir, "results", "all")}`);
  if (stopped !== null) d.log(`codex: run stopped early — ${stopped}`);
  return ok === cases.length ? 0 : 1;
}
