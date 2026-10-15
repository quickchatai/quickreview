// `codex-review` / `codex-report` — the Codex CLI arm's commands, called from
// cli.ts. Cases run ONE AT A TIME, as the harness's pipeline runs them by
// default (`--concurrency 1`), each with a fresh refresh-disabled token copy.

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { selectCases, type BenchCase, type CaseSet, type PrefetchMeta } from "./aacr.js";
import { prepareArmCases, runLifecycle } from "./armrun.js";
import { authFingerprint, AuthExpiring, benchAuthMode, syncBenchAuth } from "./auth.js";
import {
  CODEX_HARNESS_DEFAULTS,
  codexDriverTimeoutMs,
  readCodexSummary,
  reviewCaseCodex,
  unprefetchedCodexCase,
  type CodexCaseSummary,
  type CodexFingerprint,
} from "./codex.js";
import { renderCodexReport } from "./codexreport.js";
import { run } from "./exec.js";
import { assertArm } from "./ocr.js";
import { prTextEnabled } from "./prtext.js";

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

export async function codexCommand(cmd: string, d: CodexCliDeps): Promise<number> {
  const set = d.loadSet(d.get("--set"));
  if (!d.get("--out")) throw new Error("--out <dir> is required");
  const outDir = d.get("--out")!;
  const cases = selectCases(set, d.only);
  if (cmd === "codex-report") {
    assertArm(outDir, "codex");
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
  const prText = prTextEnabled();
  const fingerprint: CodexFingerprint = {
    qcr_commit: process.env.QCR_BENCH_COMMIT ?? "unknown",
    codex_version: codexVersion,
    model,
    effort,
    timeout_min: timeoutMin,
    ...(prText ? { pr_text: true as const } : {}),
    ...authFingerprint(),
  };
  const resume = d.has("--resume");
  mkdirSync(outDir, { recursive: true });
  assertArm(outDir, "codex");
  const runFile = join(outDir, "run.json");
  const previous = existsSync(runFile)
    ? (JSON.parse(readFileSync(runFile, "utf8")) as Record<string, unknown>)
    : null;
  // run.json is about to carry THIS configuration (prepareArmCases).
  const prep = prepareArmCases({
    outDir,
    cases,
    resume,
    fingerprint,
    readSummary: readCodexSummary,
    log: d.log,
    arm: "codex",
    differs: "a different Codex/model/effort",
  });
  const runRecord = {
    reviewer: "codex",
    set: set.name,
    dataset: set.dataset,
    codex_version: codexVersion,
    model,
    effort,
    timeout_min: timeoutMin,
    endpoint:
      benchAuthMode() === "api-key"
        ? "the public OpenAI API, an API key through the harness's own CODEX_API_KEY route"
        : "ChatGPT Codex backend, Codex's native ChatGPT auth (refresh-disabled token copy)",
    runner: "AACR harness evaluation/reviewers/codex.py (via bench/aacr/codex_arm.py)",
    // The equal-inputs switch (src/bench/prtext.ts): the PR title/body appended
    // to the harness's /review instructions.
    pr_text: prText,
    qcr_commit: fingerprint.qcr_commit,
    cases: cases.map((c) => c.instance_id),
    ...runLifecycle(resume, previous, fingerprint),
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
        needMs: codexDriverTimeoutMs(timeoutMin),
      });
    } catch (err) {
      if (!(err instanceof AuthExpiring)) throw err;
      stopped = err.message;
      d.log(`codex: STOPPED — ${err.message}`);
      break;
    }
    prep.beforeReview();
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
        prText,
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
