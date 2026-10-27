// The home's reviews port (src/home/ports.ts `ReviewsPort`) over the app's
// own reviewer:
//
//   preview    `qcr review <PR> --repo R --preview --json`, the app's own bin
//              run as a child with the person's environment (their pi login):
//              the plan, the price and the key.
//   start      the detached registry's `start` (src/reviewdetach.ts), called
//              in this process: `<PR> --repo R --key K --to file --out <a
//              report in the state home>`. Never `--to pr`: a run posts
//              nothing by itself. The run's driver is the app's bin again,
//              detached, so it outlives the home.
//   status     the registry's `status`, read in this process.
//   stop       the registry's `stop`.
//   runs       every run the registry holds for the repo: what the home
//              re-attaches to when it opens.
//   latest     the person's own reviews of the repo's PRs: the registry's
//              finished runs and the app's per-target review state (the
//              review home's delta history, packages/pi-plugin/src/reviewstate.ts).
//   autoRounds the PRs the daemon finished a review round of, from its
//              status snapshot (src/home/daemonstatus.ts): a PR whose rounds
//              are all still running or failed has no review yet.
//   post       a finished review the run kept for later
//              (packages/pi-plugin/src/savedpost.ts `postSavedReview`): one
//              comment-only review through the gate with the install's dry_run.
//   dryRun     the install's dry_run.
//
// Everything effectful is a dependency; `realReviewsPort` is the assembly.
import { execFile } from "node:child_process";
import { randomBytes } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { openFindings, type ReviewState } from "@quickchatai/pi-quickreview/src/reviewstate.js";
import {
  detachedCommand,
  identifyTarget,
  launchDetached,
  listRunViews,
  runDetachedVerb,
  runView,
  type DetachDeps,
  type RunView,
  watchdogCommand,
} from "../reviewdetach.js";
import type { DaemonSnapshot } from "./daemonstatus.js";
import {
  known,
  unknown,
  type Known,
  type LiveLens,
  type Outcome,
  type PrReview,
  type ReviewFinding,
  type ReviewQuote,
  type ReviewRunState,
  type ReviewRunStatus,
  type ReviewsPort,
} from "./ports.js";

type Env = Readonly<Record<string, string | undefined>>;

export interface QcrResult {
  code: number;
  stdout: string;
  stderr: string;
}

export interface ReviewsPortDeps {
  /** The detached-run registry: `<state home>/review/detached`. */
  registry: string;
  /** Where the home's review reports go: `<state home>/home/reviews`. */
  reportsDir: string;
  /** The review home: `<state home>/review`, one store per repo. */
  reviewHome: string;
  /** The daemon's status snapshot (src/home/daemonstatus.ts). */
  snapshot: () => Promise<DaemonSnapshot>;
  /** Run the app's own CLI with these arguments, as the person. */
  qcr: (args: readonly string[], o: { signal?: AbortSignal }) => Promise<QcrResult>;
  /** The registry's process seams: what `start` launches and how a run's
   * liveness is told. */
  detach: Omit<DetachDeps, "home" | "out">;
  /** Post a saved review through the gate; `failed` with its line when it did not. */
  post: (file: string) => Promise<{ failed: boolean; line: string }>;
  /** The install's dry_run; throws when its config cannot be read. */
  dryRun: () => boolean;
  now: () => number;
  /** Read a file (the review state). */
  read?: (path: string) => string;
  list?: (dir: string) => string[];
}

const message = (err: unknown): string => (err instanceof Error ? err.message : String(err));
const isMissing = (err: unknown): boolean =>
  (err as NodeJS.ErrnoException | null)?.code === "ENOENT";

type Json = Record<string, unknown>;
const obj = (v: unknown): Json | undefined =>
  typeof v === "object" && v !== null && !Array.isArray(v) ? (v as Json) : undefined;
const str = (v: unknown): string | undefined => (typeof v === "string" ? v : undefined);
const num = (v: unknown): number | undefined =>
  typeof v === "number" && Number.isFinite(v) ? v : undefined;

/** The last JSON object a command printed. */
export function lastJson(stdout: string): Json | undefined {
  const lines = stdout.trim().split("\n");
  for (let i = lines.length - 1; i >= 0; i--) {
    const l = lines[i]!.trim();
    if (!l.startsWith("{")) continue;
    try {
      return obj(JSON.parse(l));
    } catch {
      // a stray line
    }
  }
  return undefined;
}

const errorsOf = (o: Json | undefined, fallback: string): string => {
  const e = o?.["errors"];
  return Array.isArray(e) && e.length > 0 ? e.map(String).join("; ") : fallback;
};

/** `qcr review --preview --json`'s answer as a quote. */
export function parsePreview(o: Json | undefined): Outcome<{ quote: ReviewQuote }> {
  const p = obj(o?.["preview"]);
  const est = num(p?.["estimate_usd"]);
  const key = str(p?.["key"]);
  if (o?.["ok"] !== true || p === undefined || est === undefined || key === undefined)
    return { ok: false, why: errorsOf(o, "the reviewer gave no price") };
  const cap = p["cap_usd"];
  const lenses = p["lenses"];
  return {
    ok: true,
    quote: {
      estimateUsd: est,
      capUsd: num(cap) ?? null,
      key,
      lenses: Array.isArray(lenses) ? lenses.map(String) : [],
      files: num(p["files"]) ?? 0,
      headSha: str(p["head_sha"]) ?? null,
    },
  };
}

/** The findings of a result, grouped by severity, as one list worst first. */
export function parseFindings(groups: unknown): ReviewFinding[] {
  const g = obj(groups);
  if (g === undefined) return [];
  return Object.entries(g).flatMap(([sev, list]) =>
    Array.isArray(list)
      ? list.flatMap((f: unknown) => {
          const x = obj(f);
          if (x === undefined) return [];
          return [
            {
              severity: str(x["severity"]) ?? sev,
              path: str(x["path"]) ?? null,
              line: num(x["line"]) ?? null,
              title: str(x["title"]) ?? "(untitled finding)",
              lens: str(x["lens"]) ?? null,
            },
          ];
        })
      : [],
  );
}

/** The PR a run reviews, from its target label (`PR owner/name#12`). */
export function prOfTarget(target: string | undefined): { repo: string; pr: number } | null {
  const m = /^PR ([\w.-]+\/[\w.-]+)#(\d+)$/.exec(target ?? "");
  return m ? { repo: m[1]!, pr: Number(m[2]) } : null;
}

const STATES: readonly ReviewRunState[] = ["running", "done", "failed", "stopped"];

/** One run as `qcr review status --json` reports it, as the home reads it. */
export function parseRunStatus(v: Json, argv: readonly string[] = []): ReviewRunStatus | null {
  const runId = str(v["run_id"]);
  const state = str(v["state"]) as ReviewRunState | undefined;
  if (runId === undefined || state === undefined || !STATES.includes(state)) return null;
  const target = prOfTarget(str(v["target"]));
  const out = argv.indexOf("--out");
  const reportArg = out >= 0 ? argv[out + 1] : undefined;
  const result = obj(v["result"]);
  const reportResult = str(result?.["report"]);
  const live = obj(obj(v["progress"])?.["live"]);
  const agents = live?.["agents"];
  const errors = [
    ...(Array.isArray(result?.["errors"]) ? (result["errors"] as unknown[]).map(String) : []),
    ...(Array.isArray(v["errors"]) ? (v["errors"] as unknown[]).map(String) : []),
  ];
  const ended = num(v["ended_at"]);
  const report = reportResult ?? reportArg;
  return {
    runId,
    state,
    repo: target?.repo ?? null,
    pr: target?.pr ?? null,
    startedAt: num(v["started_at"]) ?? 0,
    ...(ended !== undefined ? { endedAt: ended } : {}),
    ...(report !== undefined ? { report } : {}),
    ...(live !== undefined
      ? {
          live: {
            lastActivity: str(live["last_activity"]) ?? "",
            lenses: Array.isArray(agents)
              ? agents.flatMap((a: unknown): LiveLens[] => {
                  const x = obj(a);
                  const agent = str(x?.["agent"]);
                  if (x === undefined || agent === undefined) return [];
                  const tool = str(x["current_tool"]);
                  const on = str(x["current_target"]);
                  return [
                    {
                      agent,
                      status: str(x["status"]) ?? "pending",
                      toolCount: num(x["tool_count"]) ?? 0,
                      durationMs: num(x["duration_ms"]) ?? 0,
                      ...(tool !== undefined ? { currentTool: tool } : {}),
                      ...(on !== undefined ? { currentTarget: on } : {}),
                      line: str(x["line"]) ?? agent,
                    },
                  ];
                })
              : [],
          },
        }
      : {}),
    ...(state !== "running" && result !== undefined
      ? {
          result: {
            findings: parseFindings(result["findings"]),
            costUsd: num(result["cost_usd"]) ?? null,
            ...(str(result["post_ready"]) !== undefined
              ? { postFile: str(result["post_ready"])! }
              : {}),
            ...(obj(result["post"])?.["ok"] === true ? { posted: true } : {}),
          },
        }
      : {}),
    errors,
  };
}

const high = (list: readonly ReviewFinding[]): number =>
  list.filter((f) => /^P[01]$/i.test(f.severity)).length;

/** A finished run as the person's review of its PR. */
function runReview(s: ReviewRunStatus): PrReview | null {
  if (s.state !== "done" || s.result === undefined) return null;
  const list = s.result.findings;
  return {
    findings: list.length,
    high: high(list),
    by: "you",
    at: s.endedAt ?? s.startedAt,
    list,
    ...(s.report !== undefined ? { report: s.report } : {}),
    ...(s.endedAt !== undefined ? { tookMs: s.endedAt - s.startedAt } : {}),
    costUsd: s.result.costUsd,
  };
}

const later = (a: PrReview | undefined, b: PrReview): PrReview =>
  a === undefined || b.at > a.at ? b : a;

export function reviewsPort(d: ReviewsPortDeps): ReviewsPort {
  const read = d.read ?? ((p: string) => readFileSync(p, "utf8"));
  const list = d.list ?? ((dir: string) => readdirSync(dir));
  const liveness = {
    alive: d.detach.alive,
    now: d.now,
    ...(d.detach.liveContainers ? { liveContainers: d.detach.liveContainers } : {}),
  };
  /** Run one registry verb in this process; its one JSON line. */
  const verb = async (
    v: "start" | "status" | "stop",
    args: readonly string[],
  ): Promise<{ code: number; json: Json | undefined }> => {
    const lines: string[] = [];
    const code = await runDetachedVerb(v, args, true, {
      ...d.detach,
      home: d.registry,
      out: (l) => lines.push(l),
    });
    return { code, json: lastJson(lines.join("\n")) };
  };
  const views = (repo: string): Known<RunView[]> => {
    try {
      return known(
        listRunViews(d.registry, liveness).filter(
          (r) => prOfTarget(str(r.view["target"]))?.repo === repo,
        ),
      );
    } catch (err) {
      return unknown(`can't read the review runs in ${d.registry}: ${message(err)}`);
    }
  };

  return {
    preview: async (repo, pr, o = {}) => {
      const r = await d.qcr(["review", String(pr), "--repo", repo, "--preview", "--json"], o);
      const parsed = parsePreview(lastJson(r.stdout));
      if (parsed.ok || lastJson(r.stdout) !== undefined) return parsed;
      return {
        ok: false,
        why: (r.stderr.trim().split("\n").pop() ?? "").trim() || `qcr exited ${r.code}`,
      };
    },

    start: async (repo, pr, key) => {
      const stamp = new Date(d.now())
        .toISOString()
        .replace(/[^0-9]/g, "")
        .slice(0, 14);
      const dir = join(d.reportsDir, repo.replace("/", "-"));
      try {
        mkdirSync(dir, { recursive: true });
      } catch (err) {
        return { ok: false, why: `can't make ${dir}: ${message(err)}` };
      }
      const report = join(dir, `pr-${pr}-${stamp}.md`);
      // a file in the state home, never the PR: the run posts nothing by itself
      const args = [String(pr), "--repo", repo, "--key", key, "--to", "file", "--out", report];
      const r = await verb("start", args);
      const runId = str(r.json?.["run_id"]);
      if (r.code !== 0 || runId === undefined)
        return { ok: false, why: errorsOf(r.json, "the review did not start") };
      return { ok: true, runId, report };
    },

    status: async (runId) => {
      try {
        const v = runView(d.registry, runId, liveness);
        if (v === null) return unknown(`no review run ${runId}`);
        const s = parseRunStatus(v.view, v.argv);
        return s === null ? unknown(`run ${runId}'s status is not one the home reads`) : known(s);
      } catch (err) {
        return unknown(message(err));
      }
    },

    stop: async (runId) => {
      const r = await verb("stop", [runId]);
      return r.code === 0 ? { ok: true } : { ok: false, why: errorsOf(r.json, "it did not stop") };
    },

    runs: async (repo) => {
      const v = views(repo);
      if (v.kind === "unknown") return v;
      return known(
        v.value.flatMap((r) => {
          const s = parseRunStatus(r.view, r.argv);
          return s === null ? [] : [s];
        }),
      );
    },

    latest: async (repo) => {
      const v = views(repo);
      if (v.kind === "unknown") return v;
      const by = new Map<number, PrReview>();
      for (const r of v.value) {
        const s = parseRunStatus(r.view, r.argv);
        const rv = s && s.pr !== null ? runReview(s) : null;
        if (s && s.pr !== null && rv) by.set(s.pr, later(by.get(s.pr), rv));
      }
      // the per-target review state: a PR reviewed from a checkout
      let stores: string[];
      try {
        stores = existsSync(d.reviewHome) ? list(d.reviewHome) : [];
      } catch (err) {
        return unknown(`can't read the review state in ${d.reviewHome}: ${message(err)}`);
      }
      const prefix = `pr:${repo}#`;
      for (const store of stores) {
        const dir = join(d.reviewHome, store, "state");
        let files: string[];
        try {
          files = list(dir);
        } catch (err) {
          if (isMissing(err) || (err as NodeJS.ErrnoException).code === "ENOTDIR") continue;
          return unknown(`can't read ${dir}: ${message(err)}`);
        }
        for (const f of files.filter((x) => x.endsWith(".json"))) {
          let s: ReviewState;
          try {
            s = JSON.parse(read(join(dir, f))) as ReviewState;
          } catch {
            continue; // unreadable state is no state (reviewstate.ts)
          }
          if (typeof s.target !== "string" || !s.target.startsWith(prefix)) continue;
          const pr = Number(s.target.slice(prefix.length));
          const last = Array.isArray(s.rounds) ? s.rounds[s.rounds.length - 1] : undefined;
          const at = last ? Date.parse(last.reviewed_at) : NaN;
          if (!Number.isInteger(pr) || !Number.isFinite(at)) continue;
          let open: ReviewFinding[];
          try {
            open = openFindings(s).findings.map((x) => ({
              severity: x.severity ?? "P3",
              path: x.path,
              line: x.line,
              title: x.title ?? "(untitled finding)",
              lens: x.lens || null,
            }));
          } catch {
            continue;
          }
          by.set(
            pr,
            later(by.get(pr), {
              findings: open.length,
              high: high(open),
              by: "you",
              at,
              list: open,
              costUsd: last?.cost_usd ?? null,
            }),
          );
        }
      }
      return known(by);
    },

    autoRounds: async () => {
      let snapshot: DaemonSnapshot;
      try {
        snapshot = await d.snapshot();
      } catch (err) {
        return unknown(`can't read auto-review's status: ${message(err)}`);
      }
      // auto-review recorded nothing here: it reviewed nothing
      if (snapshot.kind === "none") return known(new Map());
      if (snapshot.kind === "off")
        return unknown("auto-review is off, and its reviews are read from it while it runs");
      if (snapshot.kind === "unknown") return unknown(snapshot.why);
      let snap: Json | undefined;
      try {
        snap = obj(JSON.parse(snapshot.text));
      } catch (err) {
        return unknown(`auto-review's status is not JSON: ${message(err)}`);
      }
      const prs = snap?.["prs"];
      if (!Array.isArray(prs)) return unknown("auto-review's status lists no pull requests");
      const written = Date.parse(str(snap?.["written_at"]) ?? "");
      const by = new Map<number, PrReview>();
      for (const p of prs) {
        const x = obj(p);
        const n = num(x?.["number"]);
        // `rounds` counts every round, running and failed ones too; a verdict
        // is only recorded when a round finishes (src/state.ts): that is a review
        const verdict = str(x?.["last_verdict"]);
        if (x === undefined || n === undefined || verdict === undefined || verdict === "") continue;
        const at = Date.parse(str(x["updated_at"]) ?? "");
        // the snapshot counts rounds, not findings: those are on the PR
        by.set(n, {
          findings: null,
          high: null,
          by: "auto",
          at: Number.isFinite(at) ? at : Number.isFinite(written) ? written : 0,
        });
      }
      return known(by);
    },

    post: async (file) => {
      try {
        const r = await d.post(file);
        return r.failed
          ? { ok: false, why: r.line.replace(/^Review not posted: /, "") }
          : { ok: true, line: r.line };
      } catch (err) {
        return { ok: false, why: message(err) };
      }
    },

    dryRun: async () => {
      try {
        return known(d.dryRun());
      } catch (err) {
        return unknown(message(err));
      }
    },
  };
}

// ---- the real assembly -------------------------------------------------------------

/** The app's bin, run as a child of this node. */
export function qcrChild(o: {
  execPath: string;
  bin: string;
  cwd: string;
  env: Env;
  timeoutMs?: number;
}): ReviewsPortDeps["qcr"] {
  return (args, { signal } = {}) =>
    new Promise((resolve) => {
      execFile(
        o.execPath,
        [o.bin, ...args],
        {
          cwd: o.cwd,
          env: { ...o.env },
          timeout: o.timeoutMs ?? 180_000,
          maxBuffer: 32 << 20,
          ...(signal ? { signal } : {}),
        },
        (err, stdout, stderr) => {
          const e = err as (NodeJS.ErrnoException & { code?: unknown }) | null;
          resolve({
            code: e === null ? 0 : typeof e.code === "number" ? e.code : 1,
            stdout: String(stdout),
            stderr: e && !stderr ? e.message : String(stderr),
          });
        },
      );
    });
}

/** The registry's process seams, as `qcr review start` has them, with the
 * app's bin as the driver: a run is a process group of its own that outlives
 * the home. */
export function realDetachSeams(o: {
  execPath: string;
  bin: string;
  cwd: string;
  env: Env;
}): Omit<DetachDeps, "home" | "out"> {
  const entry = { entry: o.bin, execPath: o.execPath, execArgv: [] as string[] };
  return {
    now: Date.now,
    sleep: (ms) => new Promise((r) => setTimeout(r, ms)),
    newId: () =>
      `${new Date()
        .toISOString()
        .replace(/[^0-9]/g, "")
        .slice(0, 14)}-${randomBytes(3).toString("hex")}`,
    alive: (pid) => {
      try {
        process.kill(pid, 0);
        return true;
      } catch {
        return false;
      }
    },
    kill: (pid, sig) => process.kill(-pid, sig),
    identify: (args) => identifyTarget(args, o.cwd),
    launch: (l) =>
      launchDetached({
        ...detachedCommand(l, entry),
        dir: l.dir,
        env: { ...o.env },
        cwd: o.cwd,
      }),
    watch: (w) => {
      launchDetached({
        ...watchdogCommand(w, entry),
        dir: w.dir,
        env: { ...o.env },
        cwd: o.cwd,
        log: "watchdog.log",
      });
    },
  };
}
