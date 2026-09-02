// Improvement-PR and issue mechanics — the only place in the sandbox that
// files anything on GitHub, reached exclusively through the command executor
// (src/commands.ts). Every cap here is enforced in daemon code, never by
// prompt: the overseer can ask, the daemon decides.
//
// Branch rule: the ONLY branch this system ever pushes anywhere is
// bot/improve-<slug>. The base branch ([github] base_branch — master on
// the reviewed repo) is never pushed, never merged into, never touched beyond
// `fetch` + read-only diffing. rubric/* branches stay local (see digest.ts).
import { IMPROVEMENT_DENY_PREFIXES_DEFAULT, type Config } from "./config.js";
import type { GitHubAdapter } from "./github.js";
import type { MutationGate } from "./gate.js";
import type { StateStore } from "./state.js";

/** Injectable git runner — the daemon passes a real `git` exec; tests fake it. */
export type Run = (args: string[], cwd?: string) => Promise<string>;

export interface ImprovementPayload {
  branch: string;
  title: string;
  body: string;
  slug: string;
}

export interface IssuePayload {
  title: string;
  body: string;
  /**
   * The PR this issue was filed from (deferrals — the review session
   * files a deferral's ticket itself, in the round that deferred). Optional
   * and purely provenance: it attributes the events and the cap refusal to
   * that PR so the refusal is visible where the deferral happened. It changes
   * no cap and grants no rights of its own.
   */
  pr?: number;
}

export interface FileOutcome {
  ok: boolean;
  reason?: string;
  [k: string]: unknown;
}

export interface ImprovementContext {
  cfg: Config;
  adapter: GitHubAdapter;
  gate: MutationGate;
  store: StateStore;
  run: Run;
  /** Scratch worktree path used for the checkout (removed afterwards). */
  scratchDir: string;
  /** Base branch override. Default: `[github] base_branch` off `cfg`
   * ("main" unless configured — the original deployment sets "master").
   * Never pushed, never modified. */
  base?: string;
  now?: () => Date;
}

// ---- diffstat enforcement --------------------------------------------------

export interface NumstatEntry {
  additions: number;
  deletions: number;
  path: string;
  binary: boolean;
}

/** Parse `git diff --numstat` output. Binary files show as "-\t-\tpath". */
export function parseNumstat(out: string): NumstatEntry[] {
  const entries: NumstatEntry[] = [];
  for (const raw of out.split("\n")) {
    const line = raw.trim();
    if (!line) continue;
    const cols = line.split("\t");
    if (cols.length < 3) continue;
    const [a, d, ...rest] = cols;
    const path = rest.join("\t");
    const binary = a === "-" || d === "-";
    entries.push({
      additions: binary ? 0 : Number(a),
      deletions: binary ? 0 : Number(d),
      path,
      binary,
    });
  }
  return entries;
}

/** Paths the bot may never touch, whatever the diffstat says. The prefix list
 * is config since (`[caps] improvement_pr_deny_prefixes`, shipped
 * default = the old hardcode, `IMPROVEMENT_DENY_PREFIXES_DEFAULT` in
 * src/config.ts); `.env`-named files are refused UNCONDITIONALLY — a secrets
 * file is never repo-shape. */
export function deniedPath(path: string, prefixes: readonly string[] = IMPROVEMENT_DENY_PREFIXES_DEFAULT): boolean {
  const p = path.replace(/^\.\//, "");
  const segments = p.split("/");
  for (const prefix of prefixes) {
    const parts = prefix.replace(/\/$/, "").split("/");
    // match at the root or at any depth (…/migrations/foo.sql is still a migration)
    for (let i = 0; i + parts.length <= segments.length; i++) {
      if (parts.every((seg, j) => segments[i + j] === seg)) return true;
    }
  }
  return segments.some((seg) => seg.startsWith(".env"));
}

export interface DiffstatVerdict {
  ok: boolean;
  reason?: string;
  files: number;
  lines: number;
}

/**
 * A cap this check can compare against: a finite, non-negative number. The
 * type says every cap is a number; until `parseConfig` cast the TOML
 * section into that type, so a key missing from an operator's file reached
 * here as `undefined` — and `files > undefined` is `false`, which PASSED the
 * cap. `parseCaps` now refuses such a config at startup; this is the check's
 * own belt, so its answer never depends on who built the `caps` it was handed.
 * A cap it cannot compare against is a refusal, never a pass: the improvement
 * channel is the one place this system pushes code.
 */
function usableCap(value: number): boolean {
  return Number.isFinite(value) && value >= 0;
}

/** ≤ max_lines total (additions+deletions), ≤ max_files, no denylisted path. */
export function checkDiffstat(entries: NumstatEntry[], caps: Config["caps"]): DiffstatVerdict {
  const files = entries.length;
  const lines = entries.reduce((n, e) => n + e.additions + e.deletions, 0);
  for (const key of ["improvement_pr_max_files", "improvement_pr_max_lines"] as const) {
    if (!usableCap(caps[key])) {
      return { ok: false, reason: `caps.${key} is not a usable cap (${String(caps[key])}) — refusing rather than filing uncapped`, files, lines };
    }
  }
  const prefixes = caps.improvement_pr_deny_prefixes ?? IMPROVEMENT_DENY_PREFIXES_DEFAULT;
  const denied = entries.filter((e) => deniedPath(e.path, prefixes)).map((e) => e.path);
  const binary = entries.filter((e) => e.binary).map((e) => e.path);
  if (files === 0) return { ok: false, reason: "empty diff against the base branch — nothing to file", files, lines };
  if (binary.length > 0) {
    return { ok: false, reason: `binary file(s) not allowed in a bot improvement: ${binary.join(", ")}`, files, lines };
  }
  if (denied.length > 0) {
    return {
      ok: false,
      reason: `path denylist: ${denied.join(", ")} (${prefixes.join(", ")} and .env files are off-limits)`,
      files,
      lines,
    };
  }
  if (files > caps.improvement_pr_max_files) {
    return { ok: false, reason: `${files} files changed > cap ${caps.improvement_pr_max_files}`, files, lines };
  }
  if (lines > caps.improvement_pr_max_lines) {
    return { ok: false, reason: `${lines} changed lines > cap ${caps.improvement_pr_max_lines}`, files, lines };
  }
  return { ok: true, files, lines };
}

// ---- rate caps -------------------------------------------------------------

function startOfDayIso(now: Date): string {
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate())).toISOString();
}

function daysAgoIso(now: Date, days: number): string {
  return new Date(now.getTime() - days * 86_400_000).toISOString();
}

export function improvementRateReason(store: StateStore, caps: Config["caps"], now: Date): string | null {
  const day = store.filedSince("improvement_pr", startOfDayIso(now));
  if (day >= caps.improvement_pr_per_day) {
    return `improvement-PR day cap reached (${day}/${caps.improvement_pr_per_day})`;
  }
  const week = store.filedSince("improvement_pr", daysAgoIso(now, 7));
  if (week >= caps.improvement_pr_per_week) {
    return `improvement-PR week cap reached (${week}/${caps.improvement_pr_per_week})`;
  }
  return null;
}

export function issueRateReason(store: StateStore, caps: Config["caps"], now: Date): string | null {
  const day = store.filedSince("issue", startOfDayIso(now));
  return day >= caps.issues_per_day ? `issue day cap reached (${day}/${caps.issues_per_day})` : null;
}

// ---- issue dedup -----------------------------------------------------------

/** Lowercase, strip punctuation, split on whitespace, drop empties. */
export function normalizeTitleTokens(title: string): Set<string> {
  return new Set(
    title
      .toLowerCase()
      .replace(/[^\p{L}\p{N}\s]+/gu, " ")
      .split(/\s+/)
      .filter(Boolean),
  );
}

export function jaccard(a: Set<string>, b: Set<string>): number {
  if (a.size === 0 && b.size === 0) return 1;
  let inter = 0;
  for (const t of a) if (b.has(t)) inter++;
  const union = a.size + b.size - inter;
  return union === 0 ? 0 : inter / union;
}

export const DEDUP_THRESHOLD = 0.6;

export function findDuplicateIssue(
  title: string,
  open: Array<{ number: number; title: string }>,
  threshold = DEDUP_THRESHOLD,
): { number: number; title: string; score: number } | null {
  const tokens = normalizeTitleTokens(title);
  let best: { number: number; title: string; score: number } | null = null;
  for (const issue of open) {
    const score = jaccard(tokens, normalizeTitleTokens(issue.title));
    if (score >= threshold && (best === null || score > best.score)) {
      best = { number: issue.number, title: issue.title, score };
    }
  }
  return best;
}

// ---- slug / branch validation ---------------------------------------------

export const SLUG_RE = /^[a-z0-9][a-z0-9-]{0,48}$/;

export function botBranchFor(slug: string): string {
  return `bot/improve-${slug}`;
}

// ---- the improvement-PR pipeline ------------------------------------------

/**
 * file-improvement-pr: scratch worktree off the fresh base branch → check out the
 * overseer-prepared branch → daemon diffstat + rate caps → push bot/improve-<slug>
 * (gated) → open PR + label (gated) → record. Rejections come back with a
 * reason the command executor writes into the result file for the overseer.
 */
export async function fileImprovementPr(payload: ImprovementPayload, ctx: ImprovementContext): Promise<FileOutcome> {
  const now = (ctx.now ?? (() => new Date()))();
  const base = ctx.base ?? ctx.cfg.github.base_branch;
  const botBranch = botBranchFor(payload.slug);

  const reject = (reason: string, extra: Record<string, unknown> = {}): FileOutcome => {
    ctx.store.logEvent("improvement_pr_rejected", null, { slug: payload.slug, branch: payload.branch, reason, ...extra });
    return { ok: false, reason, ...extra };
  };

  if (!SLUG_RE.test(payload.slug)) return reject(`bad slug '${payload.slug}'`);

  const rate = improvementRateReason(ctx.store, ctx.cfg.caps, now);
  if (rate) return reject(rate);

  let worktreeAdded = false;
  try {
    // Fresh base branch — fetched, never pushed, never checked out for writing.
    await ctx.run(["fetch", "origin", `${base}:refs/remotes/origin/${base}`]);
    await ctx.run(["worktree", "add", "--force", "--detach", ctx.scratchDir, payload.branch]);
    worktreeAdded = true;

    const numstat = await ctx.run(["diff", "--numstat", `${base}...${payload.branch}`]);
    const entries = parseNumstat(numstat);
    const verdict = checkDiffstat(entries, ctx.cfg.caps);
    if (!verdict.ok) return reject(verdict.reason!, { files: verdict.files, lines: verdict.lines });

    // Push — the one and only branch this system ever pushes.
    const pushIntent = {
      kind: "push_branch" as const,
      method: "git" as const,
      path: `git push origin ${payload.branch}:refs/heads/${botBranch}`,
      body: { remote: "origin", source: payload.branch, target: botBranch },
      note: `push ${botBranch} (${verdict.files} files, ${verdict.lines} lines)`,
    };
    // the push goes through the gate in BOTH modes. It used to consult
    // the gate only when `isDryRun` was true and shell out directly otherwise —
    // so the one mode in which the push was real was the one mode the gate
    // never saw, which is precisely the bypass rule 1 forbids. The gate now
    // owns the decision (kind check, guards, dry-run branch) and calls this
    // performer only when the mutation is genuinely to happen.
    const pushResult = await ctx.gate.execute(pushIntent, async () => {
      await ctx.run(["push", "origin", `${payload.branch}:refs/heads/${botBranch}`]);
      ctx.store.logEvent("branch_pushed", null, { branch: botBranch });
      return { pushed: true };
    });
    // A refused push means no branch exists on the remote — opening a PR
    // against it would fail or, worse, target a stale branch of the same name.
    if (pushResult.blocked) return reject(`gate refused the branch push: ${pushResult.blocked}`, { branch: botBranch });
    const pushed = pushResult.executed;

    const pull = await ctx.adapter.createPull(botBranch, base, payload.title, payload.body);
    const prNumber = (pull.response as { number?: number } | undefined)?.number ?? 0;
    await ctx.adapter.addLabel(prNumber, ctx.cfg.github.improvement_label);

    const ref = prNumber > 0 ? `#${prNumber}` : botBranch;
    ctx.store.recordFiledItem("improvement_pr", payload.title, ref);
    ctx.store.logEvent("improvement_pr_filed", prNumber > 0 ? prNumber : null, {
      slug: payload.slug,
      branch: botBranch,
      files: verdict.files,
      lines: verdict.lines,
      dry_run: ctx.gate.isDryRun,
    });
    return {
      ok: true,
      branch: botBranch,
      files: verdict.files,
      lines: verdict.lines,
      pushed,
      pr: prNumber > 0 ? prNumber : null,
      dry_run: ctx.gate.isDryRun,
    };
  } catch (err) {
    return reject(`improvement-PR pipeline failed: ${(err as Error).message}`);
  } finally {
    if (worktreeAdded) {
      try {
        await ctx.run(["worktree", "remove", "--force", ctx.scratchDir]);
      } catch {
        /* scratch cleanup is best-effort */
      }
    }
  }
}

export interface IssueContext {
  cfg: Config;
  adapter: GitHubAdapter;
  gate: MutationGate;
  store: StateStore;
  now?: () => Date;
}

/** file-issue: dedup against open bot-filed issues, day cap, label, record. */
export async function fileIssue(payload: IssuePayload, ctx: IssueContext): Promise<FileOutcome> {
  const now = (ctx.now ?? (() => new Date()))();
  const pr = payload.pr ?? null;
  const reject = (reason: string, extra: Record<string, unknown> = {}): FileOutcome => {
    ctx.store.logEvent("issue_rejected", pr, { title: payload.title, reason, pr, ...extra });
    // **a cap refusal is loud.** A deferral that produced no ticket is
    // a deferral that silently became free again — exactly the failure this
    // mechanism exists to prevent — so a refusal on a PR-attributed draft also
    // leaves a durable anomaly row against that PR, beside the result file the
    // caller reads. The cap itself is untouched: the refusal is louder, never
    // weaker, and nothing here lifts a cap or files anything around it.
    if (pr !== null) ctx.store.logAnomaly("deferral_ticket_refused", pr, null, `${reason} (draft: "${payload.title}")`);
    return { ok: false, reason, pr, ...extra };
  };

  const rate = issueRateReason(ctx.store, ctx.cfg.caps, now);
  if (rate) return reject(rate);

  let open: Array<{ number: number; title: string }> = [];
  try {
    open = await ctx.adapter.listOpenBotIssues();
  } catch (err) {
    return reject(`dedup lookup failed: ${(err as Error).message}`);
  }
  const dup = findDuplicateIssue(payload.title, open);
  if (dup) {
    return reject(`duplicate of open issue #${dup.number} "${dup.title}" (similarity ${dup.score.toFixed(2)})`, {
      duplicate_of: dup.number,
    });
  }

  const result = await ctx.adapter.createIssue(payload.title, payload.body, [ctx.cfg.github.issue_label]);
  const issueNumber = (result.response as { number?: number } | undefined)?.number ?? 0;
  const ref = issueNumber > 0 ? `#${issueNumber}` : null;
  ctx.store.recordFiledItem("issue", payload.title, ref);
  ctx.store.logEvent("issue_filed", pr, { title: payload.title, issue: issueNumber || null, pr, dry_run: ctx.gate.isDryRun });
  return { ok: true, issue: issueNumber > 0 ? issueNumber : null, pr, dry_run: ctx.gate.isDryRun };
}
