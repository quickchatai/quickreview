// `node dist/src/bench/cli.js <command>` — the AACR-Bench harness entrypoint.
// Runs INSIDE the qcr-bench sandbox image; `bench/aacr/bench.sh` is the host
// side that builds the image and wires each command's mounts.
//
//   prefetch  --set <file> [--only id,id] [--store DIR] [--wait-rate-limit]
//   review    --set <file> --out DIR [--only id,id] [--store DIR] [--profile NAME]
//             [--timeout-min N] [--concurrency N] [--resume] [--keep-tree]
//   results   --set <file> --out DIR     rebuild result files from case dirs
//   subset    --set <file> --dataset <converted jsonl> --out <jsonl>
//   report    --set <file> --out DIR     write DIR/report.md from summaries + metrics
//   agents    [--profile NAME]           build the lens agents only (inspection)
//
// Nothing here can reach GitHub except `prefetch` (anonymous, read-only), and
// nothing can post: this module imports no gate, adapter or token code, and the
// image ships no `scripts/`, no `gh` and no credential.

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
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
import { prefetchCase, storeDir } from "./prefetch.js";
import { renderReport } from "./report.js";
import {
  buildBenchAgents,
  collectComments,
  contextFor,
  reviewCase,
  writeResults,
  type CaseSummary,
} from "./runner.js";

const DEFAULTS = {
  root: "/opt/quickreview/sandbox",
  store: "/repos",
  agentDir: "/pi-agent",
  timeoutMin: 45,
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

function unprefetchedSummary(c: BenchCase, error: string): CaseSummary {
  return {
    instance_id: c.instance_id,
    status: "failed",
    error,
    verdict: null,
    duration_seconds: 0,
    usage: { input: 0, output: 0, cacheRead: 0, children: 0 },
    planned_lenses: [],
    executed_passes: [],
    comments: { total: 0, by_tag: {}, left_side: 0, unparseable: 0, body: 0 },
    pr_meta: { title: false, body: false, base_ref_source: "none" },
    diff: { files: 0, additions: 0, deletions: 0 },
    continued: false,
    warnings: [],
  };
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

  if (f.cmd === "agents") {
    const { cfg } = contextFor(root, f.get("--profile") ?? "");
    log(`built ${buildBenchAgents(root, cfg)} agents into ${join(root, ".pi", "agents")}`);
    return 0;
  }

  if (f.cmd === "review") {
    const set = loadSet(f.get("--set"));
    const outDir = resolve(f.get("--out") ?? "");
    if (!f.get("--out")) throw new Error("--out <dir> is required");
    const profile = f.get("--profile") ?? "";
    const cases = selectCases(set, only(f));
    const ctx = contextFor(root, profile);
    const agents = buildBenchAgents(root, ctx.cfg);
    log(
      `review: ${agents} lens agents built (profile ${profile || "(generic)"}), ${cases.length} case(s)`,
    );
    mkdirSync(outDir, { recursive: true });
    const runFile = join(outDir, "run.json");
    const run = {
      set: set.name,
      dataset: set.dataset,
      profile,
      models: {
        conversation: ctx.cfg.models.conversation,
        tiers: ctx.cfg.models.tiers,
        validate_tier: ctx.cfg.models.validate_tier,
      },
      pi: ctx.cfg.pi.version,
      qcr_commit: process.env.QCR_BENCH_COMMIT ?? "unknown",
      cases: cases.map((c) => c.instance_id),
      started_at: new Date().toISOString(),
      finished_at: null as string | null,
    };
    writeFileSync(runFile, JSON.stringify(run, null, 2) + "\n");
    const timeoutMs = Number(f.get("--timeout-min") ?? DEFAULTS.timeoutMin) * 60_000;
    const summaries: CaseSummary[] = [];
    await pool(cases, Number(f.get("--concurrency") ?? "1"), async (c) => {
      const prior = join(outDir, "cases", safeId(c.instance_id), "case-summary.json");
      if (f.has("--resume") && existsSync(prior)) {
        const s = JSON.parse(readFileSync(prior, "utf8")) as CaseSummary;
        if (s.status === "ok") {
          log(`review: ${c.instance_id} already done — skipped (--resume)`);
          summaries.push(s);
          return;
        }
      }
      let meta: PrefetchMeta;
      try {
        meta = readMeta(store, c);
      } catch (err) {
        // Recorded as a failed case WITH an empty result file: the scorer
        // silently drops an instance that has no file from both denominators,
        // so a skipped case would shrink the benchmark instead of costing its
        // references.
        const error = String(err instanceof Error ? err.message : err);
        log(error);
        const s = unprefetchedSummary(c, error);
        mkdirSync(join(outDir, "cases", safeId(c.instance_id)), { recursive: true });
        writeFileSync(
          join(outDir, "cases", safeId(c.instance_id), "case-summary.json"),
          JSON.stringify(s, null, 2) + "\n",
        );
        writeResults(outDir, c, [], s);
        summaries.push(s);
        return;
      }
      summaries.push(
        await reviewCase(
          c,
          meta,
          {
            root,
            store,
            outDir,
            agentDir: f.get("--agent-dir") ?? DEFAULTS.agentDir,
            profile,
            timeoutMs,
            keepTree: f.has("--keep-tree"),
            log,
          },
          ctx,
        ),
      );
    });
    run.finished_at = new Date().toISOString();
    writeFileSync(runFile, JSON.stringify(run, null, 2) + "\n");
    const ok = summaries.filter((s) => s.status === "ok").length;
    log(`review: ${ok}/${cases.length} ok — results in ${join(outDir, "results")}`);
    return ok === cases.length ? 0 : 1;
  }

  if (f.cmd === "results") {
    const set = loadSet(f.get("--set"));
    const outDir = resolve(f.get("--out") ?? "");
    for (const c of selectCases(set, only(f))) {
      const dir = join(outDir, "cases", safeId(c.instance_id));
      const sPath = join(dir, "case-summary.json");
      if (!existsSync(sPath)) continue;
      const s = JSON.parse(readFileSync(sPath, "utf8")) as CaseSummary;
      writeResults(outDir, c, collectComments(dir).comments, s);
    }
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

  if (f.cmd === "report") {
    const set = loadSet(f.get("--set"));
    const outDir = resolve(f.get("--out") ?? "");
    writeFileSync(join(outDir, "report.md"), renderReport(set, outDir, selectCases(set, only(f))));
    log(`report: ${join(outDir, "report.md")}`);
    return 0;
  }

  process.stderr.write(
    readFileSync(new URL(import.meta.url))
      .toString()
      .split("\n")
      .slice(0, 16)
      .join("\n") + "\n",
  );
  return 2;
}

main().then(
  (code) => process.exit(code),
  (err) => {
    log(`fatal: ${err instanceof Error ? err.stack : String(err)}`);
    process.exit(2);
  },
);
