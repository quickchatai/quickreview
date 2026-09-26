// The defect judge's I/O half (the pure half is defects.ts): one pi session
// per case and round, READ-ONLY tools in the PR's own checkout, the answer
// parsed strictly and written to `<run>/judge/<label>/<case>.r<k>.json`.
//
// Every judgement is a file beside the run it judged, keyed by the ground
// truth's version and the judge model (the label), so a run can be re-judged
// against a newer defect set without touching the old verdicts, and re-scored
// (`defect-report`) with no model call at all.
import { spawn } from "node:child_process";
import {
  createWriteStream,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { createInterface } from "node:readline";
import {
  judgePrompt,
  parseJudgement,
  type CaseJudgement,
  type Defect,
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
  piBin?: string;
}

/**
 * The judge's pi argv: no session, no skills/templates/context files, no
 * project-local files, no extension but the no-exec bash guard, and only the
 * `read` and `bash` tools. The judge reads code to check a claim; it never
 * runs it and never writes.
 */
export function judgePiArgv(root: string, model: string): string[] {
  return [
    "-p",
    "--no-session",
    "--no-approve",
    "--no-extensions",
    "--extension",
    join(root, "extensions", "bash-guard.ts"),
    "--tools",
    "read,bash",
    "--no-skills",
    "--no-context-files",
    "--no-prompt-templates",
    "--no-themes",
    "--model",
    model,
    "--mode",
    "json",
  ];
}

export interface JudgePiResult {
  text: string;
  usage: { input: number; output: number; cacheRead: number };
  code: number | null;
  timedOut: boolean;
}

/** Run one judge session; the prompt goes in on stdin (argv caps at 128 KiB). */
export function runJudgePi(prompt: string, o: JudgePiOptions): Promise<JudgePiResult> {
  return new Promise((resolve) => {
    const events = createWriteStream(o.eventsPath, { flags: "w" });
    const child = spawn(o.piBin ?? "pi", judgePiArgv(o.root, o.model), {
      cwd: o.cwd,
      env: o.env,
      stdio: ["pipe", "pipe", "pipe"],
      detached: true,
    });
    let text = "";
    const usage = { input: 0, output: 0, cacheRead: 0 };
    let timedOut = false;
    const lines = createInterface({ input: child.stdout });
    lines.on("line", (line) => {
      if (
        line.startsWith('{"type":"message_update"') ||
        line.startsWith('{"type":"tool_execution_update"')
      )
        return;
      events.write(line + "\n");
      let e: {
        type?: string;
        message?: { role?: string; content?: unknown[]; usage?: Record<string, number> };
      };
      try {
        e = JSON.parse(line);
      } catch {
        return;
      }
      if (e.type !== "message_end" || e.message?.role !== "assistant") return;
      const u = e.message.usage ?? {};
      usage.input += u["input"] ?? 0;
      usage.output += u["output"] ?? 0;
      usage.cacheRead += u["cacheRead"] ?? 0;
      const t = (e.message.content ?? [])
        .map((p) =>
          (p as { type?: string; text?: string }).type === "text"
            ? ((p as { text?: string }).text ?? "")
            : "",
        )
        .join("");
      if (t.trim()) text = t;
    });
    child.stderr.on("data", (d) => events.write(`# stderr: ${String(d)}`));
    child.stdin.end(prompt);
    const kill = (sig: NodeJS.Signals): void => {
      try {
        if (child.pid) process.kill(-child.pid, sig);
      } catch {
        // already gone
      }
    };
    const timer = setTimeout(() => {
      timedOut = true;
      kill("SIGTERM");
      setTimeout(() => kill("SIGKILL"), 15_000).unref();
    }, o.timeoutMs);
    child.on("close", (code) => {
      clearTimeout(timer);
      events.end();
      resolve({ text, usage, code, timedOut });
    });
  });
}

export interface JudgeCaseOptions {
  pr: JudgePr;
  defects: readonly Defect[];
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
  const prompt = judgePrompt(o.pr, o.defects, o.review);
  const out: CaseJudgement[] = [];
  for (let k = 1; k <= o.rounds; k++) {
    const file = roundFile(o.outDir, o.pr.instance_id, k);
    if (o.resume && existsSync(file)) {
      const prior = JSON.parse(readFileSync(file, "utf8")) as CaseJudgement;
      if (!prior.error) {
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
    };
    // An empty review with no defects needs no model: nothing to find, nothing to check.
    if (!o.defects.length && !o.review.comments.length) {
      out.push(base);
      writeFileSync(file, JSON.stringify(base, null, 2) + "\n");
      continue;
    }
    const r = await runJudgePi(prompt, {
      ...o.pi,
      eventsPath: join(o.outDir, `${o.pr.instance_id}.r${k}.events.jsonl`),
    });
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
