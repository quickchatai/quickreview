// `node dist/src/bench/cli.js <command>` — the AACR-Bench harness entrypoint.
// Runs INSIDE the qcr-bench sandbox image; `bench/aacr/bench.sh` is the host
// side that builds the image and wires each command's mounts.
//
//   prefetch  --set <file> [--only id,id] [--store DIR] [--wait-rate-limit]
//   review    --set <file> --out DIR [--only id,id] [--store DIR] [--profile NAME]
//             [--timeout-min N] [--concurrency N] [--resume] [--keep-tree]
//             [--allow-customised]   run although the profile replaces shipped
//                                    agents or prompts (refused otherwise)
//             [--config a.b=v,c.d=w]   config levers for this run (runner.ts)
//             pi runs in-process on the SDK, each case in its own host process
//             (src/bench/casehost.ts); the lens tool is [pi] lens_runtime (engine by
//             default, with the planned wave of [pi] engine_wave), set with --config
//             [--phase all|init|case|finish]   arm.sh's one-container-per-case split;
//             every case ends with a `result: <id> <status> retry= limited=` line
//   results   --set <file> --out DIR     rebuild result files from case dirs
//   subset    --set <file> --dataset <converted jsonl> --out <jsonl>
//   report    --set <file> --out DIR     write DIR/report.md from summaries + metrics
//   agents    [--profile NAME]           build the lens agents only (inspection)
//   whatif    --set <file> --out DIR     what-if variants from DIR/source (a copied run)
//   whatif-report --set <file> --out DIR DIR/report.md from the variants' metrics
//
// The open-code-review baseline arm (src/bench/ocr.ts; image target `ocr`):
//   ocr-review --set <file> --out DIR [--only id,id] [--store DIR] [--resume] [--keep-tree]
//              [--timeout-min 30] [--ocr-concurrency 8] [--max-tools 30]
//              [--bridge URL] [--ocr-bin PATH]      cases run ONE AT A TIME
//   ocr-report --set <file> --out DIR
//
// The Codex CLI arm (src/bench/codex.ts; image target `codex`):
//   codex-review --set <file> --out DIR [--only id,id] [--store DIR] [--resume] [--keep-tree]
//                [--timeout-min 30] [--effort medium] [--model gpt-6-sol]   cases ONE AT A TIME
//   codex-report --set <file> --out DIR
// The OpenCode arm (src/bench/opencode.ts; image target `opencode`):
//   opencode-review --set <file> --out DIR [--only id,id] [--store DIR] [--resume] [--keep-tree]
//                   [--timeout-min 30] [--variant medium] [--bridge URL] [--opencode-bin PATH]
//                   cases run ONE AT A TIME
//   opencode-report --set <file> --out DIR
// The Claude Code arm (src/bench/claudecode.ts; image target `claude`; root
// the project's one sanctioned place to run Claude Code — inside that sandbox ONLY):
//   claude-review --set <file> --out DIR [--only id,id] [--store DIR] [--resume] [--keep-tree]
//                 [--timeout-min 30]     through the harness's reviewers/claude.py, one case at a time
//   claude-report --set <file> --out DIR
//   claude-rebuild --set <file> --out DIR [--only id,id] [--store DIR] [--files-dir DIR]
//                 rebuild each result file's OCR-shaped view from what the harness
//                 stored (the prose parser for raw text) — no model, no network
// The pi-review arm (src/bench/pireview.ts; image target `pireview`):
//   pireview-review --set <file> --out DIR [--only id,id] [--store DIR] [--resume] [--keep-tree]
//                   [--timeout-min 30] [--thinking medium] [--model openai-codex/gpt-6-sol]
//                   [--work /work] [--pireview-bin pi-review]      cases run ONE AT A TIME
//   pireview-report --set <file> --out DIR
// The PR-Agent arm (src/bench/pragent.ts; image target `pragent`):
//   pragent-review --set <file> --out DIR [--only id,id] [--store DIR] [--resume] [--keep-tree]
//                  [--timeout-min 30] [--bridge URL] [--no-pr-text] [--python PATH] [--driver PATH]
//                  PR-Agent's /describe, /review, /improve per case, cases run ONE AT A TIME
//   pragent-report --set <file> --out DIR
//
// The defect benchmark (src/bench/defects.ts; any run dir, either arm):
//   defect-judge  --set <file> --defects <file> --out RUN_DIR [--only id,id] [--rounds 1]
//                 [--model openai-codex/gpt-6-sol:high] [--concurrency 3] [--resume] [--label L]
//                 (each judged case runs in its own host process)
//   defect-report --set <file> --defects <file> --out RUN_DIR [--label L]   rescore, no model calls
//
// Nothing here can reach GitHub except `prefetch` (anonymous, read-only), and
// nothing can post: this module imports no gate, adapter or token code, and the
// image ships no `scripts/`, no `gh` and no credential.

import { homeProfileLookup } from "../install.js";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import {
  parseCaseSet,
  parsePrefetchMeta,
  safeId,
  selectCases,
  type BenchCase,
  type CaseSet,
  type PrefetchMeta,
} from "./aacr.js";
import {
  apiKeyEnv,
  authFingerprint,
  AuthExpiring,
  benchAuthMode,
  modelForAuth,
  syncBenchAuth,
} from "./auth.js";
import { prepareArmCases, runLifecycle } from "./armrun.js";
import { prefetchCase, storeDir } from "./prefetch.js";
import {
  assertArm,
  OCR_HARNESS_DEFAULTS,
  ocrProcessTimeoutMs,
  readOcrSummary,
  reviewCaseOcr,
  runArmOf,
  unprefetchedOcrCase,
  type OcrCaseSummary,
  type OcrFingerprint,
} from "./ocr.js";
import { parseReferenceLabels, renderOcrReport, renderReport } from "./report.js";
import { OPENCODE_HARNESS_DEFAULTS, renderOpencodeReport, runOpencodeReview } from "./opencode.js";
import {
  CLAUDE_HARNESS_DEFAULTS,
  claudeRebuildRun,
  claudeReviewRun,
  renderClaudeReport,
} from "./claudecode.js";
import { prTextEnabled } from "./prtext.js";
import { PIREVIEW_DEFAULTS, renderPireviewReport, runPireviewReview } from "./pireview.js";
import { PRAGENT_DEFAULTS, renderPragentReport, runPragentReview } from "./pragent.js";
import { GIT_ISOLATION_ENV, run as runCmd } from "./exec.js";
import { renderWhatifReport, writeWhatifRun } from "./whatifrun.js";
import {
  applyConfigOverrides,
  benchConfig,
  benchCustomisation,
  buildBenchAgents,
  contextFor,
  prepareReviewCases,
  prepareTree,
  rebuildResults,
  recordUnprefetched,
  resultLine,
  limitedModelErrors,
  reviewCase,
  runFingerprint,
  type CaseSummary,
} from "./runner.js";
import {
  parseDefectSet,
  renderDefectReport,
  reviewForJudge,
  scoreRun,
  scoreExitCode,
  type DefectSet,
  type ReviewForJudge,
} from "./defects.js";
import { clearJudgeCase, judgeCase, judgeLabel, loadJudgements } from "./defectjudge.js";
import { codexCommand } from "./codexcli.js";
import { LENS_RUNTIME_KINDS, type EngineRuntimeKind, type LensRuntimeKind } from "../config.js";
import type { Runtime } from "@quickchatai/pi-quickreview/src/engine/port.js";
import {
  checkLensRuntime,
  parseRuntimeKind,
  selectRuntime,
} from "@quickchatai/pi-quickreview/src/engine/select.js";
import {
  CASE_HOST_AUTH_STOP,
  exitWithParent,
  judgeCaseHosted,
  killCaseHosts,
  reviewCaseHosted,
  type HostPool,
} from "./casehost.js";
import { caseTokenCounts, runCostUsd } from "./cost.js";

const DEFAULTS = {
  root: "/opt/quickreview/sandbox",
  store: "/repos",
  /** The companion's agent dir, mounted READ-ONLY (src/bench/auth.ts). */
  authSrc: "/pi-agent-src",
  /** The sandbox's own agent dir (tmpfs): a refresh-disabled token copy. */
  agentDir: "/tmp/pi-agent",
  /** 75 min: with sol-high on baseline/sweep/behaviour-delta (the shipped default) a large PR can exceed 45. */
  timeoutMin: 75,
  /** The loopback Codex bridge in-container.sh starts (bench/aacr/codex_bridge.py
   * --port 8766): OCR, OpenCode and PR-Agent reach the model through it. */
  bridgeUrl: "http://127.0.0.1:8766",
};

function flags(argv: string[]): {
  cmd: string;
  get: (k: string) => string | undefined;
  has: (k: string) => boolean;
} {
  const [cmd = "", ...rest] = argv;
  return {
    cmd,
    get: (k) => {
      const i = rest.indexOf(k);
      return i >= 0 ? rest[i + 1] : undefined;
    },
    has: (k) => rest.includes(k),
  };
}

/** The runtime kind a bench command hosts pi on: the config's `[engine]
 * runtime`, which a `--config` lever may have set to anything: it is checked
 * here (a lever is not parsed by the config loader). */
function benchRuntimeKind(fallback: string): EngineRuntimeKind {
  if (fallback === "proc")
    throw new Error(
      '[engine] runtime = "proc" is retired: pi runs in-process on the SDK; drop the lever',
    );
  return parseRuntimeKind(fallback);
}

/** `[pi] lens_runtime`, checked (a `--config` lever is not parsed by the config
 * loader). The engine's lens tool is the only kind. */
function benchLensKind(raw: string): LensRuntimeKind {
  if (!(LENS_RUNTIME_KINDS as readonly string[]).includes(raw))
    throw new Error(
      `[pi] lens_runtime must be ${LENS_RUNTIME_KINDS.join(" | ")} (got ${JSON.stringify(raw)})`,
    );
  const kind = raw as LensRuntimeKind;
  checkLensRuntime(kind, "bench", true);
  return kind;
}

/** An SDK runtime that is built when its first session is asked for: a bench
 * command that never opens a session, and a pool parent that only starts hosts,
 * never load the pi SDK. */
function lazyRuntime(make: () => Promise<Runtime>): Runtime {
  let built: Promise<Runtime> | undefined;
  const load = (): Promise<Runtime> => (built ??= make());
  return {
    create: async (spec) => (await load()).create(spec),
    resume: async (file, spec) => (await load()).resume(file, spec),
  };
}

/** The runtime a bench command hosts the review's main session on. */
function benchRuntime(kind: EngineRuntimeKind, plannedWave: boolean): Runtime {
  return selectRuntime(kind, "bench", () =>
    lazyRuntime(() =>
      import("../engine/benchsdk.js").then((m) => m.benchSdkRuntime({ plannedWave })),
    ),
  );
}

/** The runtime the defect judge's session runs on. */
function judgeRuntime(kind: EngineRuntimeKind): Runtime {
  return selectRuntime(kind, "bench", () =>
    lazyRuntime(() => import("../engine/benchsdk.js").then((m) => m.judgeSdkRuntime())),
  );
}

/** The pool's way of starting a case host: this very script, with this
 * process's own flags. */
function hostPool(what: string): HostPool {
  log(`${what}: runtime sdk — each case runs in a host process of its own`);
  const entry = process.argv[1];
  if (entry === undefined) throw new Error("bench: cannot find the script to host a case with");
  // A parent that is stopped takes its hosts with it.
  for (const sig of ["SIGTERM", "SIGINT"] as const)
    process.once(sig, () => {
      killCaseHosts();
      process.exit(sig === "SIGINT" ? 130 : 143);
    });
  process.once("exit", () => killCaseHosts());
  return { argv: process.argv.slice(2), entry, execArgv: process.execArgv, log };
}

function log(line: string): void {
  process.stderr.write(`[${new Date().toISOString().slice(11, 19)}] ${line}\n`);
}

function loadSet(path: string | undefined): CaseSet {
  if (!path) throw new Error("--set <file> is required");
  return parseCaseSet(JSON.parse(readFileSync(path, "utf8")));
}

function only(f: ReturnType<typeof flags>): string[] | undefined {
  const v = f.get("--only");
  return v
    ? v
        .split(",")
        .map((s) => s.trim())
        .filter(Boolean)
    : undefined;
}

function readMeta(store: string, c: BenchCase): PrefetchMeta {
  const p = join(storeDir(store, c), "bench-meta.json");
  const meta = existsSync(p) ? parsePrefetchMeta(JSON.parse(readFileSync(p, "utf8"))) : null;
  if (!meta) throw new Error(`${c.instance_id}: not prefetched (run \`bench.sh prefetch\` first)`);
  return meta;
}

/** The usage text: this file's whole header comment (every command), the
 * compiled file's own copy of it. */
function usage(source: string): string {
  const lines = source.split("\n");
  const end = lines.findIndex((l) => !l.startsWith("//"));
  return lines.slice(0, end < 0 ? lines.length : end).join("\n") + "\n";
}

/** What the loopback Codex bridge serves, from its /health: the model IS what
 * it reports, never a flag this process could disagree with. */
async function bridgeHealth(
  cmd: string,
  bridgeUrl: string,
): Promise<{ health: Record<string, unknown>; model: string }> {
  let health: Record<string, unknown>;
  try {
    const res = await fetch(`${bridgeUrl}/health`, { signal: AbortSignal.timeout(10_000) });
    health = (await res.json()) as Record<string, unknown>;
  } catch (err) {
    throw new Error(`${cmd}: the Codex bridge at ${bridgeUrl} is not answering (${String(err)})`, {
      cause: err,
    });
  }
  const model = typeof health["model"] === "string" ? health["model"] : "";
  if (!model) throw new Error(`${cmd}: the bridge reported no model`);
  return { health, model };
}

async function pool<T>(items: T[], n: number, fn: (x: T) => Promise<void>): Promise<void> {
  let next = 0;
  const workers = Array.from({ length: Math.max(1, n) }, async () => {
    while (next < items.length) {
      const x = items[next++]!;
      await fn(x);
    }
  });
  await Promise.all(workers);
}

async function main(): Promise<number> {
  const f = flags(process.argv.slice(2));
  if (f.has("--case-host")) exitWithParent();
  const root = resolve(f.get("--root") ?? DEFAULTS.root);
  const store = resolve(f.get("--store") ?? DEFAULTS.store);

  if (f.cmd === "prefetch") {
    const set = loadSet(f.get("--set"));
    const cases = selectCases(set, only(f));
    let failed = 0;
    for (const c of cases) {
      try {
        await prefetchCase(c, { store, waitForRateLimit: f.has("--wait-rate-limit"), log });
      } catch (err) {
        failed++;
        log(
          `prefetch: ${c.instance_id} FAILED — ${err instanceof Error ? err.message : String(err)}`,
        );
      }
    }
    log(`prefetch: ${cases.length - failed}/${cases.length} ready`);
    return failed ? 1 : 0;
  }

  if (f.cmd === "auth") {
    // The judge's pi login: the same read-only, refresh-disabled copy.
    const needMs = Number(f.get("--need-min") ?? "120") * 60_000;
    try {
      const { expiresAt } = syncBenchAuth({
        srcDir: f.get("--auth-src") ?? DEFAULTS.authSrc,
        dstDir: f.get("--agent-dir") ?? DEFAULTS.agentDir,
        root,
        needMs,
      });
      log(
        `auth: token copy ready${expiresAt ? `, expires ${new Date(expiresAt).toISOString()}` : ""}`,
      );
      return 0;
    } catch (err) {
      if (err instanceof AuthExpiring) {
        log(`auth: ${err.message}`);
        return 3;
      }
      throw err;
    }
  }

  if (f.cmd === "agents") {
    const { cfg } = contextFor(root, f.get("--profile") ?? "");
    const custom = benchCustomisation(root, cfg.review.profile, f.has("--allow-customised"));
    log(
      `built ${buildBenchAgents(root, cfg, join(root, ".pi", "agents"), custom)} agents into ${join(root, ".pi", "agents")}`,
    );
    return 0;
  }

  if (f.cmd === "review") {
    const set = loadSet(f.get("--set"));
    const outDir = resolve(f.get("--out") ?? "");
    if (!f.get("--out")) throw new Error("--out <dir> is required");
    assertArm(outDir, "qcr");
    // --phase splits one review run so arm.sh can schedule its cases on a
    // machine-wide queue, one container per case (bench/aacr/arm.sh):
    //   all     (default) the whole run in this process
    //   init    write run.json (and, without --resume, clear the cases'
    //           earlier results) — no case is reviewed
    //   case    review the --only cases with --resume semantics, never
    //           touching run.json, so concurrent case containers never race
    //           on it
    //   finish  stamp run.json finished_at and tally the cases' outcomes
    const phase = f.get("--phase") ?? "all";
    if (!["all", "init", "case", "finish"].includes(phase))
      throw new Error("--phase must be all | init | case | finish");
    const profileFlag = f.get("--profile") ?? "";
    const cases = selectCases(set, only(f));
    const runFile = join(outDir, "run.json");

    if (phase === "finish") {
      if (!existsSync(runFile)) throw new Error(`${runFile} missing — run --phase init first`);
      const runJson = JSON.parse(readFileSync(runFile, "utf8")) as Record<string, unknown>;
      runJson["finished_at"] = new Date().toISOString();
      writeFileSync(runFile, JSON.stringify(runJson, null, 2) + "\n");
      const tally: Record<string, number> = {};
      let limited = 0;
      for (const c of cases) {
        const p = join(outDir, "cases", safeId(c.instance_id), "case-summary.json");
        const s = existsSync(p) ? (JSON.parse(readFileSync(p, "utf8")) as CaseSummary) : null;
        const st = s?.status ?? "missing";
        tally[st] = (tally[st] ?? 0) + 1;
        if (s && s.status !== "ok" && limitedModelErrors(s) > 0) limited++;
      }
      const ok = tally["ok"] ?? 0;
      const kinds = Object.entries(tally)
        .map(([k, v]) => `${k} ${v}`)
        .join(", ");
      log(
        `review: ${ok}/${cases.length} ok (${kinds})${limited ? ` — ${limited} failed under rate limiting: re-run the arm with --resume` : ""} — results in ${join(outDir, "results")}`,
      );
      return ok === cases.length ? 0 : 1;
    }

    const overrides = f.get("--config") ?? "";
    const base = contextFor(root, profileFlag, overrides, (l) => console.warn(l));
    // `--config review.profile=<name>` chooses the profile as `--profile` does.
    const profile = base.cfg.review.profile;
    const bench = benchCustomisation(root, profile, f.has("--allow-customised"));
    const runtimeKind = benchRuntimeKind(base.cfg.engine.runtime);
    const lensKind = benchLensKind(base.cfg.pi.lens_runtime);
    // The planned wave is the engine lens tool's: `[pi] engine_wave` is read only with it.
    const wave = lensKind === "engine" && base.cfg.pi.engine_wave;
    const ctx = {
      ...base,
      fingerprint: runFingerprint(base.cfg, profile, overrides, bench.custom, {
        runtime: runtimeKind,
        lens_runtime: lensKind,
        engine_wave: wave,
      }),
      ...(bench.readFile ? { readFile: bench.readFile } : {}),
    };
    const authSrc = f.get("--auth-src") ?? DEFAULTS.authSrc;
    const agentDir = f.get("--agent-dir") ?? DEFAULTS.agentDir;
    // `--case-host`: this process was started by a pool (below) to host ONE
    // case, which the pool has already prepared the login and the agents for.
    const caseHost = f.has("--case-host");
    // On sdk a whole run (`--phase all`) puts each case in a host process of its
    // own, so a crash or a frozen loop costs that case. arm.sh's `--phase case`
    // is already one container, hence one process, per case.
    const hosted = phase === "all" && !caseHost;
    const runtime = hosted ? undefined : benchRuntime(runtimeKind, wave);
    // A case container always resumes: its run was set up (and, if fresh,
    // cleared) by the init phase, so a finished case it finds is this run's.
    const resume = f.has("--resume") || phase === "case";
    mkdirSync(outDir, { recursive: true });
    const run = {
      set: set.name,
      dataset: set.dataset,
      profile,
      ...(overrides ? { overrides } : {}),
      ...authFingerprint(),
      models: {
        effort: ctx.cfg.models.effort,
        conversation: ctx.cfg.models.conversation,
        tiers: ctx.cfg.models.tiers,
        validate_tier: ctx.cfg.models.validate_tier,
      },
      ...(bench.custom.customised
        ? { customised: true, profile_overrides: ctx.fingerprint.profile_overrides }
        : {}),
      ...(ctx.fingerprint.engine ? { engine: ctx.fingerprint.engine } : {}),
      pi: ctx.cfg.pi.version,
      qcr_commit: process.env.QCR_BENCH_COMMIT ?? "unknown",
      cases: cases.map((c) => c.instance_id),
      started_at: new Date().toISOString(),
      resumes: [] as unknown[],
      finished_at: null as string | null,
    };
    if (phase !== "case") {
      const previous = existsSync(runFile)
        ? (JSON.parse(readFileSync(runFile, "utf8")) as Record<string, unknown>)
        : null;
      // A fresh run owns its cases outright: nothing an earlier invocation
      // left for them may be scored as this run's (an interrupted run then
      // shows its unreached cases as MISSING, and eval refuses the number).
      // A resumed run keeps only what this configuration produced.
      prepareReviewCases(outDir, cases, { resume, fingerprint: ctx.fingerprint }, log);
      Object.assign(run, runLifecycle(resume, previous, ctx.fingerprint));
      writeFileSync(runFile, JSON.stringify(run, null, 2) + "\n");
      if (phase === "init") {
        log(`review: run initialised — ${cases.length} case(s)${resume ? " (resume)" : ""}`);
        return 0;
      }
    }
    // A case host finds the agents its pool built; rebuilding them under its
    // siblings' feet would empty the dir while they read it.
    if (!caseHost) {
      const agents = buildBenchAgents(root, ctx.cfg, join(root, ".pi", "agents"), {
        ...(bench.readFile ? { readFile: bench.readFile } : {}),
        lookup: homeProfileLookup(),
      });
      log(
        `review: ${agents} lens agents built (profile ${profile || "(generic)"}), ${cases.length} case(s)`,
      );
    }
    const timeoutMs = Number(f.get("--timeout-min") ?? DEFAULTS.timeoutMin) * 60_000;
    const hosts = hosted ? hostPool("review") : undefined;
    const summaries: CaseSummary[] = [];
    let authStop: string | null = null;
    await pool(cases, Number(f.get("--concurrency") ?? "1"), async (c) => {
      if (authStop) return;
      const prior = join(outDir, "cases", safeId(c.instance_id), "case-summary.json");
      if (resume && existsSync(prior)) {
        const s = JSON.parse(readFileSync(prior, "utf8")) as CaseSummary;
        const same = JSON.stringify(s.fingerprint ?? null) === JSON.stringify(ctx.fingerprint);
        if (s.status === "ok" && same) {
          log(`review: ${c.instance_id} already done — skipped (--resume)`);
          if (!caseHost) log(resultLine(s, true));
          summaries.push(s);
          return;
        }
        if (s.status === "ok")
          log(`review: ${c.instance_id} was reviewed by a different build/profile — re-running`);
      }
      // A fresh, refresh-disabled copy of the live token before every case;
      // stop the whole run (not case after case) when it would expire.
      try {
        if (!caseHost)
          syncBenchAuth({ srcDir: authSrc, dstDir: agentDir, root, needMs: timeoutMs });
      } catch (err) {
        if (!(err instanceof AuthExpiring)) throw err;
        authStop = err.message;
        log(`review: STOPPED — ${err.message}`);
        log(`result: ${c.instance_id} auth-stop retry=0 limited=0`);
        return;
      }
      let meta: PrefetchMeta;
      try {
        meta = readMeta(store, c);
      } catch (err) {
        // A failed case WITH an empty result file (recordUnprefetched).
        const error = String(err instanceof Error ? err.message : err);
        log(error);
        const s = recordUnprefetched(outDir, c, error, ctx.fingerprint);
        if (!caseHost) log(resultLine(s));
        summaries.push(s);
        return;
      }
      const s = hosts
        ? await reviewCaseHosted(c, hosts, {
            root,
            outDir,
            fingerprint: ctx.fingerprint,
            timeoutMs,
          })
        : await reviewCase(
            c,
            meta,
            {
              root,
              store,
              outDir,
              agentDir,
              timeoutMs,
              ...(runtime !== undefined ? { runtime } : {}),
              keepTree: f.has("--keep-tree"),
              log,
            },
            ctx,
          );
      // A case host leaves the line to its pool, which reads the summary.
      if (!caseHost) log(resultLine(s));
      summaries.push(s);
    });
    const ok = summaries.filter((s) => s.status === "ok").length;
    // Assigned inside the pool's closures, which TS's narrowing cannot see.
    const stopped = authStop as string | null;
    if (phase === "case") {
      if (stopped !== null) log(`review: stopped early — ${stopped}`);
      return ok === cases.length ? 0 : 1;
    }
    run.finished_at = new Date().toISOString();
    writeFileSync(runFile, JSON.stringify(run, null, 2) + "\n");
    log(`review: ${ok}/${cases.length} ok — results in ${join(outDir, "results")}`);
    if (stopped !== null) log(`review: run stopped early — ${stopped}`);
    return ok === cases.length ? 0 : 1;
  }

  if (f.cmd === "results") {
    const set = loadSet(f.get("--set"));
    const outDir = resolve(f.get("--out") ?? "");
    assertArm(outDir, "qcr");
    rebuildResults(outDir, selectCases(set, only(f)), log);
    log("results: rebuilt");
    return 0;
  }

  if (f.cmd === "subset") {
    const set = loadSet(f.get("--set"));
    const dataset = f.get("--dataset");
    const out = f.get("--out");
    if (!dataset || !out) throw new Error("subset needs --dataset and --out");
    const want = new Map(selectCases(set, only(f)).map((c) => [c.instance_id, c]));
    const lines: string[] = [];
    for (const line of readFileSync(dataset, "utf8").split("\n")) {
      if (!line.trim()) continue;
      const inst = JSON.parse(line) as {
        instance_id: string;
        base_commit: string;
        head_commit: string;
        reference_comments: unknown[];
      };
      const c = want.get(inst.instance_id);
      if (!c) continue;
      if (
        inst.base_commit !== c.base_commit ||
        inst.head_commit !== c.head_commit ||
        inst.reference_comments.length !== c.references
      ) {
        throw new Error(
          `subset: ${c.instance_id} disagrees with the converted dataset — wrong dataset revision?`,
        );
      }
      lines.push(line);
      want.delete(inst.instance_id);
    }
    if (want.size) throw new Error(`subset: not in the dataset: ${[...want.keys()].join(", ")}`);
    writeFileSync(out, lines.join("\n") + "\n");
    log(`subset: ${lines.length} instance(s) → ${out}`);
    return 0;
  }

  if (f.cmd === "ocr-review") {
    const set = loadSet(f.get("--set"));
    if (!f.get("--out")) throw new Error("--out <dir> is required");
    const outDir = resolve(f.get("--out")!);
    const cases = selectCases(set, only(f));
    const bridgeUrl = f.get("--bridge") ?? DEFAULTS.bridgeUrl;
    const ocrBin = f.get("--ocr-bin") ?? "opencodereview";
    const flagsOcr = {
      concurrency: Number(f.get("--ocr-concurrency") ?? OCR_HARNESS_DEFAULTS.concurrency),
      timeoutMin: Number(f.get("--timeout-min") ?? OCR_HARNESS_DEFAULTS.timeoutMin),
      maxTools: Number(f.get("--max-tools") ?? OCR_HARNESS_DEFAULTS.maxTools),
    };
    for (const [k, v] of Object.entries(flagsOcr))
      if (!Number.isInteger(v) || v < 1)
        throw new Error(`ocr-review: ${k} must be a positive integer`);
    const { health, model } = await bridgeHealth("ocr-review", bridgeUrl);
    const effort = typeof health["effort"] === "string" ? health["effort"] : "";
    const version = await runCmd(ocrBin, ["version"], {
      env: { ...process.env, OCR_NO_UPDATE: "1" },
    });
    const ocrVersion =
      (version.stdout.trim().split("\n")[0] ?? "").trim() ||
      process.env.QCR_OCR_VERSION ||
      "unknown";
    const prText = prTextEnabled();
    const fingerprint: OcrFingerprint = {
      qcr_commit: process.env.QCR_BENCH_COMMIT ?? "unknown",
      ocr_version: ocrVersion,
      model,
      effort,
      flags: flagsOcr,
      ...(prText ? { pr_text: true as const } : {}),
      ...authFingerprint(),
    };
    const resume = f.has("--resume");
    mkdirSync(outDir, { recursive: true });
    const runFile = join(outDir, "run.json");
    const previous = existsSync(runFile)
      ? (JSON.parse(readFileSync(runFile, "utf8")) as Record<string, unknown>)
      : null;
    assertArm(outDir, "ocr");
    // run.json is about to carry THIS configuration (prepareArmCases).
    const prep = prepareArmCases({
      outDir,
      cases,
      resume,
      fingerprint,
      readSummary: readOcrSummary,
      log,
      arm: "ocr",
      differs: "a different OCR/model/flags",
    });
    const runRecord = {
      reviewer: "ocr",
      set: set.name,
      dataset: set.dataset,
      ocr_version: ocrVersion,
      model,
      effort,
      verbosity: health["verbosity"] ?? null,
      endpoint:
        benchAuthMode() === "api-key"
          ? "the public OpenAI API (API key) via the loopback bridge (bench/aacr/codex_bridge.py)"
          : "ChatGPT Codex backend via the loopback bridge (bench/aacr/codex_bridge.py)",
      flags: {
        concurrency: flagsOcr.concurrency,
        timeout_min: flagsOcr.timeoutMin,
        max_tools: flagsOcr.maxTools,
      },
      // The equal-inputs switch (src/bench/prtext.ts): the PR title/body via --background.
      pr_text: prText,
      qcr_commit: fingerprint.qcr_commit,
      cases: cases.map((c) => c.instance_id),
      ...runLifecycle(resume, previous, fingerprint),
      finished_at: null as string | null,
    };
    writeFileSync(runFile, JSON.stringify(runRecord, null, 2) + "\n");
    const authSrc = f.get("--auth-src") ?? DEFAULTS.authSrc;
    const agentDir = f.get("--agent-dir") ?? DEFAULTS.agentDir;
    const summaries: OcrCaseSummary[] = [];
    let stopped: string | null = null;
    // One case at a time, always: OCR fans out per file inside a case already
    // (--concurrency), and the login is shared with the companion.
    for (const c of cases) {
      const prior = readOcrSummary(outDir, c);
      // (a prior summary here carries this run's fingerprint — the others went
      // above.) Only a clean case is kept on --resume, exactly as the
      // QuickReview arm keeps only `ok`: `partial` (some files failed, e.g. a
      // 429 at the bridge) is re-run, so rate-limit damage never persists in
      // one arm only.
      if (resume && prior && prior.status === "ok") {
        log(`ocr: ${c.instance_id} already done — skipped (--resume)`);
        summaries.push(prior);
        continue;
      }
      try {
        // The bridge reads this refresh-disabled copy on every call.
        syncBenchAuth({
          srcDir: authSrc,
          dstDir: agentDir,
          root,
          needMs: ocrProcessTimeoutMs(flagsOcr.timeoutMin) + 5 * 60_000,
        });
      } catch (err) {
        if (!(err instanceof AuthExpiring)) throw err;
        stopped = err.message;
        log(`ocr: STOPPED — ${err.message}`);
        break;
      }
      prep.beforeReview();
      let meta: PrefetchMeta;
      try {
        meta = readMeta(store, c);
      } catch (err) {
        const error = String(err instanceof Error ? err.message : err);
        log(error);
        summaries.push(unprefetchedOcrCase(outDir, c, fingerprint, error));
        continue;
      }
      summaries.push(
        await reviewCaseOcr(c, meta, {
          root,
          store,
          outDir,
          ocrBin,
          bridgeUrl,
          model,
          flags: flagsOcr,
          fingerprint,
          keepTree: f.has("--keep-tree"),
          log,
          prText,
        }),
      );
    }
    runRecord.finished_at = new Date().toISOString();
    writeFileSync(runFile, JSON.stringify(runRecord, null, 2) + "\n");
    const ok = summaries.filter((s) => s.status === "ok" || s.status === "partial").length;
    log(`ocr: ${ok}/${cases.length} reviewed — results in ${join(outDir, "results", "all")}`);
    if (stopped !== null) log(`ocr: run stopped early — ${stopped}`);
    return ok === cases.length ? 0 : 1;
  }

  // ---- the Codex CLI arm (src/bench/codexcli.ts) ----
  if (f.cmd === "codex-review" || f.cmd === "codex-report") {
    return codexCommand(f.cmd, {
      root,
      store,
      authSrc: f.get("--auth-src") ?? DEFAULTS.authSrc,
      agentDir: f.get("--agent-dir") ?? DEFAULTS.agentDir,
      get: (k) => (k === "--out" && f.get("--out") ? resolve(f.get("--out")!) : f.get(k)),
      has: f.has,
      loadSet,
      only: only(f),
      readMeta,
      log,
    });
  }

  if (f.cmd === "ocr-report") {
    const set = loadSet(f.get("--set"));
    const outDir = resolve(f.get("--out") ?? "");
    assertArm(outDir, "ocr");
    writeFileSync(
      join(outDir, "report.md"),
      renderOcrReport(set, outDir, selectCases(set, only(f))),
    );
    log(`report: ${join(outDir, "report.md")}`);
    return 0;
  }

  // ---- the OpenCode arm (src/bench/opencode.ts) ----------------------------------
  if (f.cmd === "opencode-review") {
    const set = loadSet(f.get("--set"));
    if (!f.get("--out")) throw new Error("--out <dir> is required");
    const outDir = resolve(f.get("--out")!);
    assertArm(outDir, "opencode");
    const bridgeUrl = f.get("--bridge") ?? DEFAULTS.bridgeUrl;
    const opencodeBin = f.get("--opencode-bin") ?? "opencode";
    const timeoutMin = Number(f.get("--timeout-min") ?? OPENCODE_HARNESS_DEFAULTS.timeoutMin);
    if (!Number.isInteger(timeoutMin) || timeoutMin < 1)
      throw new Error("opencode-review: --timeout-min must be a positive integer");
    // `native`: OpenCode's own ChatGPT provider (opencode.ts header); default
    // `bridge`, the published arm.
    const provider = f.get("--provider") ?? (process.env.QCR_OPENCODE_PROVIDER || "bridge");
    if (provider !== "bridge" && provider !== "native")
      throw new Error("opencode-review: --provider must be bridge | native");
    const variant = f.get("--variant") ?? "medium";
    // What the model IS comes from the bridge that serves it, never a flag —
    // except natively, where OpenCode is told the model and the variant.
    let health: Record<string, unknown>;
    let model: string;
    if (provider === "bridge")
      ({ health, model } = await bridgeHealth("opencode-review", bridgeUrl));
    else {
      // QCR_OPENCODE_MODEL (bench.sh QCR_BENCH_OPENCODE_MODEL): the Codex model id.
      model = f.get("--model") ?? (process.env.QCR_OPENCODE_MODEL || "gpt-6-sol");
      if (!model) throw new Error("opencode-review: --model must name a model");
      health = { model, effort: variant, verbosity: null };
    }
    const version = await runCmd(opencodeBin, ["--version"], {
      env: { ...process.env, OPENCODE_DISABLE_AUTOUPDATE: "1" },
    });
    return runOpencodeReview({
      set,
      cases: selectCases(set, only(f)),
      outDir,
      root,
      store,
      authSrc: f.get("--auth-src") ?? DEFAULTS.authSrc,
      agentDir: f.get("--agent-dir") ?? DEFAULTS.agentDir,
      opencodeBin,
      opencodeVersion:
        (version.stdout.trim().split("\n")[0] ?? "").trim() ||
        process.env.QCR_OPENCODE_VERSION ||
        "unknown",
      bridgeUrl,
      model,
      effort: typeof health["effort"] === "string" ? health["effort"] : "",
      verbosity: typeof health["verbosity"] === "string" ? health["verbosity"] : null,
      mcpPython: f.get("--mcp-python") ?? "/opt/aacr-venv/bin/python",
      mcpScript: f.get("--mcp-script") ?? "/opt/aacr-bench/evaluation/mcp_codex_finding_server.py",
      flags: { timeoutMin, variant, provider },
      prText: prTextEnabled(),
      qcrCommit: process.env.QCR_BENCH_COMMIT ?? "unknown",
      resume: f.has("--resume"),
      keepTree: f.has("--keep-tree"),
      readMeta: (c) => readMeta(store, c),
      log,
    });
  }

  if (f.cmd === "claude-review") {
    // The Claude Code arm: the harness's own runner, via the driver (claudecode.ts).
    if (!f.get("--out")) throw new Error("--out <dir> is required");
    const outDir = resolve(f.get("--out")!);
    assertArm(outDir, "claude");
    return claudeReviewRun({
      set: loadSet(f.get("--set")),
      only: only(f),
      outDir,
      store,
      workRoot: f.get("--work") ?? "/work",
      homeRoot: f.get("--home-root") ?? "/tmp/claude-home",
      python: f.get("--python") ?? "/opt/aacr-venv/bin/python",
      driver: f.get("--driver") ?? "/opt/quickreview/bench/claude_driver.py",
      timeoutMin: Number(f.get("--timeout-min") ?? CLAUDE_HARNESS_DEFAULTS.timeoutMin),
      resume: f.has("--resume"),
      keepTree: f.has("--keep-tree"),
      env: process.env,
      readMeta: (c) => readMeta(store, c),
      log,
    });
  }

  // ---- the pi-review arm (src/bench/pireview.ts) ----------------------------------
  if (f.cmd === "pireview-review") {
    const set = loadSet(f.get("--set"));
    if (!f.get("--out")) throw new Error("--out <dir> is required");
    const outDir = resolve(f.get("--out")!);
    assertArm(outDir, "pireview");
    const timeoutMin = Number(f.get("--timeout-min") ?? PIREVIEW_DEFAULTS.timeoutMin);
    if (!Number.isInteger(timeoutMin) || timeoutMin < 1)
      throw new Error("pireview-review: --timeout-min must be a positive integer");
    const pireviewBin = f.get("--pireview-bin") ?? "pi-review";
    // pi's version from its installed package (the runtime image's pin) — read,
    // never spawned: nothing here launches pi outside a benchmarked reviewer.
    let piVersion = "unknown";
    try {
      const pkg =
        f.get("--pi-package") ??
        "/usr/local/lib/node_modules/@earendil-works/pi-coding-agent/package.json";
      piVersion = String(
        (JSON.parse(readFileSync(pkg, "utf8")) as { version?: unknown }).version ?? "unknown",
      );
    } catch {
      // stays unknown
    }
    return runPireviewReview({
      set,
      cases: selectCases(set, only(f)),
      outDir,
      work: f.get("--work") ?? "/work",
      root,
      store,
      authSrc: f.get("--auth-src") ?? DEFAULTS.authSrc,
      agentDir: f.get("--agent-dir") ?? "/tmp/pi-agent-pireview",
      pireviewBin,
      pireviewVersion: process.env.QCR_PIREVIEW_VERSION || "unknown",
      piVersion,
      // QCR_PIREVIEW_MODEL (bench.sh QCR_BENCH_PIREVIEW_MODEL): pi's model id,
      // e.g. openai-codex/gpt-6.1-sol — which needs a pi whose catalog has it.
      model: modelForAuth(
        f.get("--model") ?? (process.env.QCR_PIREVIEW_MODEL || PIREVIEW_DEFAULTS.model),
      ),
      thinking:
        f.get("--thinking") ?? process.env.QCR_PIREVIEW_THINKING ?? PIREVIEW_DEFAULTS.thinking,
      // `--panel code-experts` = what /rv runs inside Pi (src/bench/pireview.ts header).
      panel: f.get("--panel") ?? (process.env.QCR_PIREVIEW_PANEL || null),
      prText: prTextEnabled(),
      timeoutMin,
      qcrCommit: process.env.QCR_BENCH_COMMIT ?? "unknown",
      resume: f.has("--resume"),
      keepTree: f.has("--keep-tree"),
      readMeta: (c) => readMeta(store, c),
      log,
    });
  }

  // ---- the PR-Agent arm (src/bench/pragent.ts) ------------------------------------
  if (f.cmd === "pragent-review") {
    const set = loadSet(f.get("--set"));
    if (!f.get("--out")) throw new Error("--out <dir> is required");
    const outDir = resolve(f.get("--out")!);
    assertArm(outDir, "pragent");
    const bridgeUrl = f.get("--bridge") ?? DEFAULTS.bridgeUrl;
    const timeoutMin = Number(f.get("--timeout-min") ?? PRAGENT_DEFAULTS.timeoutMin);
    if (!Number.isInteger(timeoutMin) || timeoutMin < 1)
      throw new Error("pragent-review: --timeout-min must be a positive integer");
    const { health, model } = await bridgeHealth("pragent-review", bridgeUrl);
    return runPragentReview({
      set,
      cases: selectCases(set, only(f)),
      outDir,
      root,
      store,
      authSrc: f.get("--auth-src") ?? DEFAULTS.authSrc,
      agentDir: f.get("--agent-dir") ?? DEFAULTS.agentDir,
      python: f.get("--python") ?? "/opt/pragent-venv/bin/python",
      driver: f.get("--driver") ?? "/opt/quickreview/bench/pragent_driver.py",
      pragentVersion: process.env.QCR_PRAGENT_VERSION || "unknown",
      bridgeUrl,
      model,
      effort: typeof health["effort"] === "string" ? health["effort"] : "",
      verbosity: typeof health["verbosity"] === "string" ? health["verbosity"] : null,
      timeoutMin,
      prText: !f.has("--no-pr-text"),
      qcrCommit: process.env.QCR_BENCH_COMMIT ?? "unknown",
      resume: f.has("--resume"),
      keepTree: f.has("--keep-tree"),
      readMeta: (c) => readMeta(store, c),
      log,
    });
  }

  if (f.cmd === "pragent-report") {
    const set = loadSet(f.get("--set"));
    const outDir = resolve(f.get("--out") ?? "");
    assertArm(outDir, "pragent");
    writeFileSync(
      join(outDir, "report.md"),
      renderPragentReport(set, outDir, selectCases(set, only(f))),
    );
    log(`report: ${join(outDir, "report.md")}`);
    return 0;
  }

  if (f.cmd === "pireview-report") {
    const set = loadSet(f.get("--set"));
    const outDir = resolve(f.get("--out") ?? "");
    assertArm(outDir, "pireview");
    writeFileSync(
      join(outDir, "report.md"),
      renderPireviewReport(set, outDir, selectCases(set, only(f))),
    );
    log(`report: ${join(outDir, "report.md")}`);
    return 0;
  }

  if (f.cmd === "opencode-report") {
    const set = loadSet(f.get("--set"));
    const outDir = resolve(f.get("--out") ?? "");
    assertArm(outDir, "opencode");
    writeFileSync(
      join(outDir, "report.md"),
      renderOpencodeReport(set, outDir, selectCases(set, only(f))),
    );
    log(`report: ${join(outDir, "report.md")}`);
    return 0;
  }

  if (f.cmd === "claude-rebuild") {
    // The Claude Code arm's view, rebuilt from the stored result — no model call.
    const set = loadSet(f.get("--set"));
    if (!f.get("--out")) throw new Error("--out <dir> is required");
    const outDir = resolve(f.get("--out")!);
    if (runArmOf(outDir) !== "claude")
      throw new Error(`${outDir} is not a Claude Code run (run.json reviewer != "claude")`);
    const filesDir = f.get("--files-dir");
    await claudeRebuildRun({
      set,
      only: only(f),
      outDir,
      filesDir: filesDir ? resolve(filesDir) : undefined,
      store: existsSync(store) ? store : undefined,
      readMeta: (c) => readMeta(store, c),
      log,
    });
    return 0;
  }

  if (f.cmd === "claude-report") {
    const set = loadSet(f.get("--set"));
    const outDir = resolve(f.get("--out") ?? "");
    assertArm(outDir, "claude");
    writeFileSync(
      join(outDir, "report.md"),
      renderClaudeReport(set, outDir, selectCases(set, only(f))),
    );
    log(`report: ${join(outDir, "report.md")}`);
    return 0;
  }

  if (f.cmd === "whatif") {
    const set = loadSet(f.get("--set"));
    if (!f.get("--out")) throw new Error("--out <dir> is required");
    const outDir = resolve(f.get("--out") ?? "");
    const summaries = writeWhatifRun(outDir, selectCases(set, only(f)));
    for (const s of summaries) {
      const v = s.variants;
      log(
        `whatif: ${s.instance_id} — ${s.raw.candidates} raw candidate(s), ${s.record.rows} record row(s); posted ${s.posted}, +killed ${v["posted+killed"].added}, +merged ${v["posted+merged"].added}, all-candidates ${v["all-candidates"].added}`,
      );
    }
    log(`whatif: ${summaries.length} case(s) → ${join(outDir, "results")}`);
    return 0;
  }

  if (f.cmd === "whatif-report") {
    const set = loadSet(f.get("--set"));
    if (!f.get("--out")) throw new Error("--out <dir> is required");
    const outDir = resolve(f.get("--out") ?? "");
    const r = renderWhatifReport(set, outDir, selectCases(set, only(f)));
    writeFileSync(join(outDir, "report.md"), r.markdown);
    writeFileSync(join(outDir, "whatif-summary.json"), JSON.stringify(r.summary, null, 2) + "\n");
    log(`whatif-report: ${join(outDir, "report.md")}`);
    return 0;
  }

  if (f.cmd === "defect-judge" || f.cmd === "defect-report") {
    // The defect benchmark (src/bench/defects.ts): did each review FIND the
    // real defects, and is what it says true? Works on any run dir — ours or
    // the OCR arm's, fresh or archived — without re-running a review.
    const set = loadSet(f.get("--set"));
    const outDir = resolve(f.get("--out") ?? "");
    if (!f.get("--out")) throw new Error("--out <run dir> is required");
    if (!f.get("--defects")) throw new Error("--defects <defect set file> is required");
    const defects: DefectSet = parseDefectSet(
      JSON.parse(readFileSync(f.get("--defects")!, "utf8")),
    );
    // On the API-key route (src/bench/auth.ts) an `openai-codex/` judge runs as
    // `openai/` — and judgeLabel keeps that provider in the label, so keyed
    // verdicts never land in (or --resume over) the published login verdicts.
    const model = modelForAuth(f.get("--model") ?? "openai-codex/gpt-6-sol:high");
    const label = f.get("--label") ?? judgeLabel(defects.version, model);
    const judgeDir = join(outDir, "judge", label);
    const cases = selectCases(set, only(f)).filter((c) => {
      if (defects.cases[c.instance_id]) return true;
      log(
        `defect-judge: ${c.instance_id} has no ground truth in ${defects.set} v${defects.version} — skipped`,
      );
      return false;
    });
    let judgeIncomplete = false;
    const reviews: Record<string, ReviewForJudge> = {};
    for (const c of cases) reviews[c.instance_id] = reviewForJudge(outDir, safeId(c.instance_id));
    if (f.cmd === "defect-judge") {
      const rounds = Number(f.get("--rounds") ?? "1");
      if (!Number.isInteger(rounds) || rounds < 1)
        throw new Error("--rounds must be a positive integer");
      const authSrc = f.get("--auth-src") ?? DEFAULTS.authSrc;
      const agentDir = f.get("--agent-dir") ?? DEFAULTS.agentDir;
      const timeoutMs = Number(f.get("--timeout-min") ?? "30") * 60_000;
      const resume = f.has("--resume");
      // The judge's runtime is the config's, as the review's is. Each judged
      // case is hosted by a process of its own (`--case-host` is that process,
      // told its one case by the pool).
      const runtimeKind = benchRuntimeKind(
        applyConfigOverrides(benchConfig(""), f.get("--config") ?? "", undefined, (l) =>
          console.warn(l),
        ).engine.runtime,
      );
      const caseHost = f.has("--case-host");
      const hosts = !caseHost ? hostPool("defect-judge") : undefined;
      const runtime = hosts ? undefined : judgeRuntime(runtimeKind);
      mkdirSync(judgeDir, { recursive: true });
      let authStop: string | null = null;
      const unjudged: string[] = [];
      /** One case in this process. False when it could not be prepared. */
      const judgeHere = async (c: BenchCase): Promise<boolean> => {
        const safe = safeId(c.instance_id);
        const tree = join(root, "wt", `judge-${safe}`);
        const tmpDir = join(root, "wt", `judge-${safe}.tmp`);
        // One case that cannot be prepared (not prefetched, a broken store)
        // is that case's error, never the whole judge's.
        try {
          const meta = readMeta(store, c);
          mkdirSync(tmpDir, { recursive: true });
          await prepareTree(storeDir(store, c), tree, meta);
          if (!resume) clearJudgeCase(judgeDir, safe);
          await judgeCase({
            pr: {
              instance_id: safe,
              repo: c.repo,
              title: meta.title,
              merge_base: meta.merge_base,
              head: meta.head_commit,
            },
            defects: defects.cases[c.instance_id]!.defects,
            excluded: defects.cases[c.instance_id]!.excluded,
            review: reviews[c.instance_id]!,
            outDir: judgeDir,
            rounds,
            defectSetVersion: defects.version,
            resume,
            log,
            pi: {
              root,
              cwd: tree,
              model,
              timeoutMs,
              ...(runtime !== undefined ? { runtime } : {}),
              env: {
                PATH: process.env.PATH ?? "/usr/local/bin:/usr/bin:/bin",
                HOME: process.env.HOME ?? "/tmp",
                TMPDIR: tmpDir,
                LANG: "C.UTF-8",
                PI_CODING_AGENT_DIR: agentDir,
                // An Anthropic judge model reads its key from the environment
                // (bench.sh passes the Claude arm's credential file); nothing
                // else is passed through.
                ...(model.startsWith("anthropic/") && process.env.ANTHROPIC_API_KEY
                  ? { ANTHROPIC_API_KEY: process.env.ANTHROPIC_API_KEY }
                  : {}),
                ...(model.startsWith("anthropic/") && process.env.CLAUDE_CODE_OAUTH_TOKEN
                  ? { ANTHROPIC_OAUTH_TOKEN: process.env.CLAUDE_CODE_OAUTH_TOKEN }
                  : {}),
                // An `openai/` judge on the API-key route reads OPENAI_API_KEY.
                ...(model.startsWith("openai/") ? apiKeyEnv() : {}),
                ...GIT_ISOLATION_ENV,
              },
            },
          });
          return true;
        } catch (err) {
          log(
            `defect-judge: ${c.instance_id} — ERROR ${String(err instanceof Error ? err.message : err)}`,
          );
          return false;
        } finally {
          rmSync(tree, { recursive: true, force: true });
          rmSync(tmpDir, { recursive: true, force: true });
        }
      };
      await pool(cases, Number(f.get("--concurrency") ?? "3"), async (c) => {
        if (authStop) return;
        try {
          // A case host's pool synced the login just before starting it.
          if (!caseHost)
            syncBenchAuth({ srcDir: authSrc, dstDir: agentDir, root, needMs: timeoutMs });
        } catch (err) {
          if (!(err instanceof AuthExpiring)) throw err;
          authStop = err.message;
          log(`defect-judge: STOPPED — ${err.message}`);
          return;
        }
        // A case the review never reached (the run stopped early) has no
        // summary: judging it would score a harness stop as a reviewer miss.
        if (!existsSync(join(outDir, "cases", safeId(c.instance_id), "case-summary.json"))) {
          log(`defect-judge: ${c.instance_id} was never reviewed in this run — not judged`);
          unjudged.push(c.instance_id);
          return;
        }
        if (hosts) {
          const r = await judgeCaseHosted(c, hosts, { root, rounds, timeoutMs });
          if (r === "auth-stop") {
            authStop = `a case host stopped: the login would expire inside the case (${c.instance_id})`;
            log(`defect-judge: STOPPED — ${authStop}`);
          } else if (r === "unjudged") unjudged.push(c.instance_id);
          return;
        }
        if (!(await judgeHere(c))) unjudged.push(c.instance_id);
      });
      // A case host reports to its pool by exit status and scores nothing.
      if (caseHost) return authStop ? CASE_HOST_AUTH_STOP : unjudged.length > 0 ? 1 : 0;
      if (unjudged.length)
        log(`defect-judge: ${unjudged.length} case(s) NOT judged: ${unjudged.join(", ")}`);
      if (authStop) return 1;
      judgeIncomplete = unjudged.length > 0;
    }
    const judged = loadJudgements(judgeDir);
    const byCase: Record<string, (typeof judged)[string]> = {};
    for (const c of cases) byCase[c.instance_id] = judged[safeId(c.instance_id)] ?? [];
    // Scored under `model`: when judging, or when a report names one, a round
    // another judge model left in the dir is stale rather than averaged in.
    const score = scoreRun(
      defects,
      cases.map((c) => c.instance_id),
      byCase,
      reviews,
      f.cmd === "defect-judge" || f.get("--model") !== undefined ? model : undefined,
    );
    // Cost, from what the run itself recorded (both arms).
    // A case that recorded no token counts is left out of the token average
    // rather than counted as zero.
    let tin = 0,
      tout = 0,
      tokened = 0;
    const secs: number[] = [];
    for (const c of cases) {
      const p = join(outDir, "cases", safeId(c.instance_id), "case-summary.json");
      if (!existsSync(p)) continue;
      const s = JSON.parse(readFileSync(p, "utf8")) as { duration_seconds?: number };
      const t = caseTokenCounts(s);
      if (t) {
        tin += t.input;
        tout += t.output;
        tokened++;
      }
      secs.push(s.duration_seconds ?? 0);
    }
    secs.sort((a, b) => a - b);
    // Dollars the way pi prices them (src/bench/cost.ts): summed per call for
    // our arm, the bridge's tokens at pi's rates for the case's model for the
    // bridge arms (OCR, OpenCode, PR-Agent); Claude Code's own for its arm.
    const dollars = runCostUsd(cases.map((c) => join(outDir, "cases", safeId(c.instance_id))));
    const extra = secs.length
      ? {
          ...(tokened ? { tokensInPerPr: tin / tokened, tokensOutPerPr: tout / tokened } : {}),
          medianMinPerPr: (secs[Math.floor(secs.length / 2)] ?? 0) / 60,
          ...dollars,
        }
      : {};
    mkdirSync(judgeDir, { recursive: true });
    writeFileSync(
      join(judgeDir, "score.json"),
      JSON.stringify(
        {
          label,
          model,
          defect_set: defects.set,
          defect_set_version: defects.version,
          ...score,
          cost: extra,
        },
        null,
        2,
      ) + "\n",
    );
    writeFileSync(
      join(judgeDir, "report.md"),
      renderDefectReport(
        `${set.name} — ${process.env.QCR_RUN_ID ?? outDir.split("/").pop()}`,
        defects,
        score,
        extra,
      ),
    );
    log(
      `${f.cmd}: ${score.judged}/${score.cases} judged — recall ${(score.defects.recall * 100).toFixed(0)}% (weighted ${(score.weighted_recall * 100).toFixed(0)}%), comments correct ${(score.comments.correct_share * 100).toFixed(0)}% → ${join(judgeDir, "report.md")}`,
    );
    return scoreExitCode(score, judgeIncomplete);
  }

  if (f.cmd === "report") {
    const set = loadSet(f.get("--set"));
    const outDir = resolve(f.get("--out") ?? "");
    assertArm(outDir, "qcr");
    // Agent-produced reference labels ride beside the set, when there are any.
    const labelsPath = (f.get("--set") ?? "").replace(/\.json$/, ".labels.json");
    const labels = existsSync(labelsPath)
      ? parseReferenceLabels(JSON.parse(readFileSync(labelsPath, "utf8")))
      : undefined;
    writeFileSync(
      join(outDir, "report.md"),
      renderReport(set, outDir, selectCases(set, only(f)), labels),
    );
    log(`report: ${join(outDir, "report.md")}`);
    return 0;
  }

  process.stderr.write(usage(readFileSync(new URL(import.meta.url), "utf8")));
  return 2;
}

main().then(
  (code) => process.exit(code),
  (err) => {
    log(`fatal: ${err instanceof Error ? err.stack : String(err)}`);
    process.exit(2);
  },
);
