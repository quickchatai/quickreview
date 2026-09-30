// The defect judge's I/O half (the pure half is defects.ts): one pi session
// per case and round, READ-ONLY tools in the PR's own checkout, the answer
// parsed strictly and written to `<run>/judge/<label>/<case>.r<k>.json`.
//
// Every judgement is a file beside the run it judged, keyed by the ground
// truth's version and the judge model (the label), so a run can be re-judged
// against a newer defect set without touching the old verdicts, and re-scored
// (`defect-report`) with no model call at all.
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { runJudgeSession } from "./runner.js";
import {
  judgePrompt,
  judgedReview,
  parseJudgement,
  reviewHash as hashReview,
  type CaseJudgement,
  type Defect,
  type ExcludedClaim,
  type JudgePr,
  type ReviewForJudge,
} from "./defects.js";

export interface JudgePiOptions {
  root: string;
  cwd: string;
  model: string;
  env: NodeJS.ProcessEnv;
  eventsPath: string;
  timeoutMs: number;
}

export interface JudgePiResult {
  text: string;
  usage: { input: number; output: number; cacheRead: number };
  code: number | null;
  timedOut: boolean;
}

/**
 * Run one judge session through the bench's ONE pi spawn (runner.ts owns the
 * judge's argv too — tests/single-shepherd.test.ts S2), then read the answer
 * and the usage back out of the event stream it wrote.
 */
export async function runJudgePi(prompt: string, o: JudgePiOptions): Promise<JudgePiResult> {
  const r = await runJudgeSession(prompt, o);
  return { ...readJudgeEvents(o.eventsPath), code: r.code, timedOut: r.timedOut };
}

/** The last assistant text and the summed usage from a pi `--mode json` stream. */
export function readJudgeEvents(eventsPath: string): Pick<JudgePiResult, "text" | "usage"> {
  let text = "";
  const usage = { input: 0, output: 0, cacheRead: 0 };
  const raw = existsSync(eventsPath) ? readFileSync(eventsPath, "utf8") : "";
  for (const line of raw.split("\n")) {
    if (!line.startsWith("{")) continue;
    let e: {
      type?: string;
      message?: { role?: string; content?: unknown[]; usage?: Record<string, number> };
    };
    try {
      e = JSON.parse(line) as typeof e;
    } catch {
      continue;
    }
    if (e.type !== "message_end" || e.message?.role !== "assistant") continue;
    const u = e.message.usage ?? {};
    usage.input += u["input"] ?? 0;
    usage.output += u["output"] ?? 0;
    usage.cacheRead += u["cacheRead"] ?? 0;
    const t = (e.message.content ?? [])
      .map((p) => {
        const q = p as { type?: string; text?: string };
        return q.type === "text" ? (q.text ?? "") : "";
      })
      .join("");
    if (t.trim()) text = t;
  }
  return { text, usage };
}

export interface JudgeCaseOptions {
  pr: JudgePr;
  defects: readonly Defect[];
  /** Claims the ground truth already rejected, shown to the judge. */
  excluded?: readonly ExcludedClaim[];
  review: ReviewForJudge;
  outDir: string;
  rounds: number;
  defectSetVersion: string;
  pi: Omit<JudgePiOptions, "eventsPath">;
  /** Keep rounds already on disk (re-judge only what is missing). */
  resume: boolean;
  log: (m: string) => void;
}

export function roundFile(outDir: string, instanceId: string, round: number): string {
  return join(outDir, `${instanceId}.r${round}.json`);
}

/** Judge one case for `rounds` rounds; every round is written, errors included. */
export async function judgeCase(o: JudgeCaseOptions): Promise<CaseJudgement[]> {
  mkdirSync(o.outDir, { recursive: true });
  const prompt = judgePrompt(o.pr, o.defects, o.review, o.excluded ?? []);
  const reviewHash = hashReview(o.review);
  const out: CaseJudgement[] = [];
  for (let k = 1; k <= o.rounds; k++) {
    const file = roundFile(o.outDir, o.pr.instance_id, k);
    if (o.resume && existsSync(file)) {
      const prior = JSON.parse(readFileSync(file, "utf8")) as CaseJudgement;
      // A round kept on resume must have judged THIS review (judgedReview);
      // a legacy unstamped round is kept on matching ids — re-paying every
      // legacy round on resume would be a silent spend.
      if (!prior.error && judgedReview(prior, o.review)) {
        out.push(prior);
        continue;
      }
    }
    const base: CaseJudgement = {
      instance_id: o.pr.instance_id,
      round: k,
      defect_set_version: o.defectSetVersion,
      model: o.pi.model,
      defects: [],
      comments: [],
      review_hash: reviewHash,
    };
    // An empty review with no defects needs no model: nothing to find, nothing to check.
    if (!o.defects.length && !o.review.comments.length) {
      out.push(base);
      writeFileSync(file, JSON.stringify(base, null, 2) + "\n");
      continue;
    }
    // runPi APPENDS to the events file and readJudgeEvents takes the last
    // answer in it: a re-judged round starts from an empty file, or a pi that
    // dies without answering would inherit the previous attempt's answer.
    const eventsPath = join(o.outDir, `${o.pr.instance_id}.r${k}.events.jsonl`);
    rmSync(eventsPath, { force: true });
    const r = await runJudgePi(prompt, { ...o.pi, eventsPath });
    let j: CaseJudgement;
    try {
      if (r.timedOut) throw new Error("judge timed out");
      j = { ...base, ...parseJudgement(r.text, o.defects, o.review), usage: r.usage };
    } catch (err) {
      j = { ...base, usage: r.usage, error: String(err instanceof Error ? err.message : err) };
      writeFileSync(join(o.outDir, `${o.pr.instance_id}.r${k}.answer.txt`), r.text);
    }
    o.log(
      `defect-judge: ${o.pr.instance_id} round ${k} — ${j.error ? `ERROR ${j.error}` : `${j.defects.filter((d) => d.verdict === "found").length}/${o.defects.length} found, ${j.comments.length} comment(s) checked`}`,
    );
    writeFileSync(file, JSON.stringify(j, null, 2) + "\n");
    out.push(j);
  }
  return out;
}

/** Every saved round under a judge dir, by case. */
export function loadJudgements(dir: string): Record<string, CaseJudgement[]> {
  const by: Record<string, CaseJudgement[]> = {};
  if (!existsSync(dir)) return by;
  for (const f of readdirSync(dir).sort()) {
    const m = /^(.+)\.r(\d+)\.json$/.exec(f);
    if (!m) continue;
    const j = JSON.parse(readFileSync(join(dir, f), "utf8")) as CaseJudgement;
    (by[m[1]!] ??= []).push(j);
  }
  for (const k of Object.keys(by)) by[k]!.sort((a, b) => a.round - b.round);
  return by;
}

/** A judge dir's label: ground-truth version + model, filesystem-safe. */
export function judgeLabel(defectSetVersion: string, model: string): string {
  return `v${defectSetVersion}-${model.replace(/^[^/]*\//, "").replace(/[^A-Za-z0-9._-]+/g, "-")}`;
}

export function clearJudgeCase(dir: string, instanceId: string): void {
  if (!existsSync(dir)) return;
  for (const f of readdirSync(dir))
    if (f.startsWith(`${instanceId}.r`)) rmSync(join(dir, f), { force: true });
}
