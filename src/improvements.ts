// Improvement-PR and issue mechanics — the only place in the sandbox that
// files anything on GitHub, reached exclusively through the command executor
// (src/commands.ts). Every cap here is enforced in daemon code, never by
// prompt: the overseer can ask, the daemon decides.
//
// Branch rule: the ONLY branch this system ever pushes anywhere is
// bot/improve-<slug>. The base branch ([github] base_branch — master on
// the reviewed repo) is never pushed, never merged into, never touched beyond
// `fetch` + read-only diffing.
//
// Working tree rule: every git step below runs in the BASE CLONE of
// the reviewed repo (`WorktreeManager.basePath`) — the one working tree whose
// `origin` is the reviewed repo and whose ref namespace holds the branch the
// session prepared. For the channel's whole life the steps ran with no cwd at
// all, i.e. in the daemon's own checkout, which has no remote: zero
// `filed_items` rows, zero `branch_pushed` events, and a suite that discarded
// the cwd it was handed. `Run` now REQUIRES a cwd so a call without one does
// not compile, and the context carries the clone locator.
//
// The channel never checks anything out. A diffstat and a push both read refs;
// the scratch worktree the first shape materialised the branch into served no
// step and was a wedge waiting to happen (a daemon killed between `worktree
// add` and the cleanup left a populated directory that `--force` does not
// clear, and every later filing failed on "already exists"). The clone's own
// working tree is never touched either — the base fetch lands in
// `refs/remotes/`, and the branch is addressed by ref, never checked out.
import { IMPROVEMENT_DENY_PREFIXES_DEFAULT, type Config } from "./config.js";
import type { GitHubAdapter } from "./github.js";
import type { MutationGate } from "./gate.js";
import type { StateStore } from "./state.js";
import { runOrThrow, type ExecFn } from "./tmux.js";

/** Injectable git runner: `git <args>` in `cwd`, stdout on success, a THROW on
 * a non-zero exit. The cwd is mandatory — there is no sensible default. */
export type Run = (args: string[], cwd: string) => Promise<string>;

/** The production `Run` over an `ExecFn` (`nodeExec` in wire.ts). A failing
 * git step throws instead of returning its stdout — the daemon's first runner
 * ignored the exit code, so a refused fetch or push would have read as
 * success. The end-to-end test drives this same runner against real git. */
export function gitRunner(exec: ExecFn): Run {
  return async (args, cwd) => (await runOrThrow(exec, "git", args, { cwd })).stdout;
}

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
  /**
   * Resolves to the reviewed repo's base clone — the working tree every git
   * step runs in — cloning it first if no round has yet (production:
   * `WorktreeManager.ensureBaseClone`). A function rather than a path so an
   * EOD sweep on a daemon that never reviewed a PR still finds a repo with a
   * remote instead of failing on a missing directory.
   */
  ensureRepoDir: () => Promise<string>;
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
  /** A rename/copy record's source path (the destination is `path`). */
  from?: string;
}

/**
 * Parse `git diff --numstat -z` output. Binary files show as "-\t-\tpath".
 *
 * Always the NUL-terminated form, so a path is raw bytes — never the
 * core.quotePath-quoted `"…"` spelling, never a rename's display string
 * (`src/cfg.txt => .env`, `{src => migrations}/x.sql`), neither of which
 * the denylist can read. The caller also passes `--no-renames`, so a move is
 * a delete plus an add; the rename record (`a\td\t\0from\0to\0`) is still
 * parsed defensively, onto `path` = destination and `from` = source, and
 * `checkDiffstat` checks both. A newline-separated input (no NUL anywhere)
 * is read line by line — the non-`-z` spelling, kept for fixtures.
 */
export function parseNumstat(out: string): NumstatEntry[] {
  const entries: NumstatEntry[] = [];
  const push = (a: string, d: string, path: string, from?: string): void => {
    const binary = a === "-" || d === "-";
    entries.push({
      additions: binary ? 0 : Number(a),
      deletions: binary ? 0 : Number(d),
      path,
      binary,
      ...(from === undefined ? {} : { from }),
    });
  };
  if (!out.includes("\0")) {
    for (const raw of out.split("\n")) {
      const line = raw.trim();
      if (!line) continue;
      const cols = line.split("\t");
      if (cols.length < 3) continue;
      const [a, d, ...rest] = cols;
      push(a!, d!, rest.join("\t"));
    }
    return entries;
  }
  const tokens = out.split("\0");
  for (let i = 0; i < tokens.length; i++) {
    const tok = tokens[i]!.replace(/^\n+/, "");
    if (!tok) continue;
    const first = tok.indexOf("\t");
    const second = first < 0 ? -1 : tok.indexOf("\t", first + 1);
    if (second < 0) continue;
    const a = tok.slice(0, first);
    const d = tok.slice(first + 1, second);
    const path = tok.slice(second + 1);
    if (path !== "") {
      push(a, d, path);
      continue;
    }
    // Rename/copy record: the two paths ride the next two tokens.
    const from = tokens[i + 1];
    const to = tokens[i + 2];
    i += 2;
    if (from === undefined || to === undefined) continue;
    push(a, d, to, from);
  }
  return entries;
}

/** Paths the bot may never touch, whatever the diffstat says. The prefix list
 * is config since (`[caps] improvement_pr_deny_prefixes`, shipped
 * default = the old hardcode, `IMPROVEMENT_DENY_PREFIXES_DEFAULT` in
 * src/config.ts); `.env`-named files are refused UNCONDITIONALLY — a secrets
 * file is never repo-shape. */
export function deniedPath(
  path: string,
  prefixes: readonly string[] = IMPROVEMENT_DENY_PREFIXES_DEFAULT,
): boolean {
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
 * A cap this module can compare against: a finite, non-negative number. The
 * type says every cap is a number; until `parseConfig` cast the TOML
 * section into that type, so a key missing from an operator's file reached
 * here as `undefined` — and `files > undefined` is `false`, which PASSED the
 * cap. `parseCaps` now refuses such a config at startup; this is the cap
 * checks' own belt, so their answers never depend on who built the `caps`
 * they were handed — which is why it takes `unknown` and narrows, rather than
 * trusting the type it exists to distrust. A cap that cannot be compared
 * against is a refusal, never a pass: the improvement channel is the one
 * place this system pushes code.
 */
function usableCap(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0;
}

/** The refusal every cap comparison in this module returns on a cap it cannot
 * compare against, or `null` when every named cap is usable. */
function unusableCapReason(
  caps: Config["caps"],
  keys: ReadonlyArray<keyof Config["caps"]>,
): string | null {
  for (const key of keys) {
    if (!usableCap(caps[key]))
      return `caps.${key} is not a usable cap (${String(caps[key])}) — refusing rather than filing uncapped`;
  }
  return null;
}

/** ≤ max_lines total (additions+deletions), ≤ max_files, no denylisted path. */
export function checkDiffstat(entries: NumstatEntry[], caps: Config["caps"]): DiffstatVerdict {
  const files = entries.length;
  const lines = entries.reduce((n, e) => n + e.additions + e.deletions, 0);
  const unusable = unusableCapReason(caps, [
    "improvement_pr_max_files",
    "improvement_pr_max_lines",
  ]);
  if (unusable !== null) return { ok: false, reason: unusable, files, lines };
  const prefixes = caps.improvement_pr_deny_prefixes ?? IMPROVEMENT_DENY_PREFIXES_DEFAULT;
  const denied = entries.flatMap((e) =>
    [e.from, e.path].filter((p): p is string => p !== undefined && deniedPath(p, prefixes)),
  );
  const binary = entries.filter((e) => e.binary).map((e) => e.path);
  if (files === 0)
    return {
      ok: false,
      reason: "empty diff against the base branch — nothing to file",
      files,
      lines,
    };
  if (binary.length > 0) {
    return {
      ok: false,
      reason: `binary file(s) not allowed in a bot improvement: ${binary.join(", ")}`,
      files,
      lines,
    };
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
    return {
      ok: false,
      reason: `${files} files changed > cap ${caps.improvement_pr_max_files}`,
      files,
      lines,
    };
  }
  if (lines > caps.improvement_pr_max_lines) {
    return {
      ok: false,
      reason: `${lines} changed lines > cap ${caps.improvement_pr_max_lines}`,
      files,
      lines,
    };
  }
  return { ok: true, files, lines };
}

// ---- rate caps -------------------------------------------------------------

function startOfDayIso(now: Date): string {
  return new Date(
    Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()),
  ).toISOString();
}

function daysAgoIso(now: Date, days: number): string {
  return new Date(now.getTime() - days * 86_400_000).toISOString();
}

export function improvementRateReason(
  store: StateStore,
  caps: Config["caps"],
  now: Date,
): string | null {
  const unusable = unusableCapReason(caps, ["improvement_pr_per_day", "improvement_pr_per_week"]);
  if (unusable !== null) return unusable; // `day >= undefined` is false: uncapped, the same fail-open as checkDiffstat's
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
  const unusable = unusableCapReason(caps, ["issues_per_day"]);
  if (unusable !== null) return unusable;
  const day = store.filedSince("issue", startOfDayIso(now));
  return day >= caps.issues_per_day
    ? `issue day cap reached (${day}/${caps.issues_per_day})`
    : null;
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

/**
 * The branch a session says it prepared, as the command file carries it: a
 * plain LOCAL branch name (`wip/docs`) and nothing else. The overseer LLM
 * writes this field, and the daemon hands it to git — so the shape is
 * allowlisted at the command boundary (src/commands.ts) and again here, not
 * merely passed through: every path segment starts with a letter or digit
 * (so no leading `-` option and no leading `+` force-refspec), the segment
 * alphabet has no `:` (a refspec separator), no whitespace or control
 * character and none of git's forbidden punctuation, `..` never appears, and
 * no segment ends in `.lock`. Belt beside the structural fix below, which
 * addresses the branch as `refs/heads/<name>` everywhere — an argument that
 * begins with `refs/` is never an option to any git command.
 */
export const BRANCH_RE =
  /^(?!.*\.\.)(?!.*\.lock(?:\/|$))[A-Za-z0-9][A-Za-z0-9._-]*(?:\/[A-Za-z0-9][A-Za-z0-9._-]*)*$/;

export const BRANCH_MAX = 200;

export function isBranchName(name: string): boolean {
  return name.length <= BRANCH_MAX && BRANCH_RE.test(name);
}

export function botBranchFor(slug: string): string {
  return `bot/improve-${slug}`;
}

// ---- the improvement-PR pipeline ------------------------------------------

/**
 * One filing of a kind at a time, process-wide. The cap is checked before, and
 * recorded after, a run of git and network awaits; every command watcher
 * (commands/, commands/operator/, commands/slack/) serialises only its own
 * queue, so without this two overlapping filings both read the last slot as
 * free. A failing filing never wedges the next: the chain swallows it.
 */
const filingChains = new Map<"improvement_pr" | "issue", Promise<unknown>>();
function oneFilingAtATime<T>(kind: "improvement_pr" | "issue", fn: () => Promise<T>): Promise<T> {
  const next = (filingChains.get(kind) ?? Promise.resolve()).then(fn, fn);
  filingChains.set(
    kind,
    next.catch(() => undefined),
  );
  return next;
}

/**
 * file-improvement-pr: in the reviewed repo's base clone — fetch the fresh base
 * branch → confirm the session-prepared branch exists as a LOCAL branch there
 * → daemon diffstat + rate caps → push bot/improve-<slug> (gated) → open PR +
 * label (gated) → record. Nothing is checked out at any step. Rejections come
 * back with a reason the command executor writes into the result file for the
 * overseer.
 */
export function fileImprovementPr(
  payload: ImprovementPayload,
  ctx: ImprovementContext,
): Promise<FileOutcome> {
  return oneFilingAtATime("improvement_pr", () => fileImprovementPrNow(payload, ctx));
}

async function fileImprovementPrNow(
  payload: ImprovementPayload,
  ctx: ImprovementContext,
): Promise<FileOutcome> {
  const now = (ctx.now ?? (() => new Date()))();
  const base = ctx.base ?? ctx.cfg.github.base_branch;
  const botBranch = botBranchFor(payload.slug);

  const reject = (reason: string, extra: Record<string, unknown> = {}): FileOutcome => {
    ctx.store.logEvent("improvement_pr_rejected", null, {
      slug: payload.slug,
      branch: payload.branch,
      reason,
      ...extra,
    });
    return { ok: false, reason, ...extra };
  };

  if (!SLUG_RE.test(payload.slug)) return reject(`bad slug '${payload.slug}'`);
  if (!isBranchName(payload.branch))
    return reject(`bad branch name '${payload.branch}' (a plain local branch name is required)`);

  const rate = improvementRateReason(ctx.store, ctx.cfg.caps, now);
  if (rate) return reject(rate);

  // Fully qualified on both sides: the base as the remote-tracking ref the
  // fetch below writes, the session's branch as a LOCAL branch of the clone.
  // A remote-tracking or otherwise merely resolvable name (`origin/<base>`, a
  // tag, a sha) is not a branch the session prepared and is refused by the
  // existence check, and neither argument can ever begin with `-`.
  const baseRef = `refs/remotes/origin/${base}`;
  const branchRef = `refs/heads/${payload.branch}`;

  try {
    const repoDir = await ctx.ensureRepoDir();
    // Fresh base branch — fetched (forced, like every base fetch in
    // worktrees.ts: a rewritten base must not wedge the channel), never
    // pushed, never checked out for writing.
    await ctx.run(["fetch", "origin", `+refs/heads/${base}:${baseRef}`], repoDir);
    // `for-each-ref` with an exact ref prints that ref or nothing (a branch
    // cannot coexist with a branch nested under its name) — total, no exit
    // code to interpret. It also PINS the branch: the commit it names now is
    // the one validated below AND the one pushed, so a session that moves
    // its branch after submitting cannot ship a tip the caps never saw.
    const found = (
      await ctx.run(["for-each-ref", "--format=%(objectname) %(refname)", branchRef], repoDir)
    ).trim();
    const sep = found.indexOf(" ");
    const commit = sep > 0 ? found.slice(0, sep) : "";
    if (found.slice(sep + 1) !== branchRef || !/^[0-9a-f]{40,64}$/.test(commit)) {
      return reject(
        `branch '${payload.branch}' does not exist in the reviewed repo's clone — the session never prepared it`,
      );
    }
    const refspec = `${commit}:refs/heads/${botBranch}`;

    const numstat = await ctx.run(
      // -z: raw paths (no quotePath quoting, no rename display string);
      // --no-renames: a move is a delete + an add, so BOTH sides reach the
      // denylist and the line cap — whatever diff.renames the clone carries.
      ["diff", "--numstat", "-z", "--no-renames", `${baseRef}...${commit}`],
      repoDir,
    );
    const entries = parseNumstat(numstat);
    const verdict = checkDiffstat(entries, ctx.cfg.caps);
    if (!verdict.ok) return reject(verdict.reason!, { files: verdict.files, lines: verdict.lines });

    // Push — the one and only branch this system ever pushes.
    const pushIntent = {
      kind: "push_branch" as const,
      method: "git" as const,
      path: `git push origin ${refspec}`,
      body: { remote: "origin", source: branchRef, commit, target: botBranch },
      note: `push ${botBranch} (${verdict.files} files, ${verdict.lines} lines)`,
    };
    // the push goes through the gate in BOTH modes. It used to consult
    // the gate only when `isDryRun` was true and shell out directly otherwise —
    // so the one mode in which the push was real was the one mode the gate
    // never saw, which is precisely the bypass rule 1 forbids. The gate now
    // owns the decision (kind check, guards, dry-run branch) and calls this
    // performer only when the mutation is genuinely to happen.
    const pushResult = await ctx.gate.execute(pushIntent, async () => {
      await ctx.run(["push", "origin", refspec], repoDir);
      ctx.store.logEvent("branch_pushed", null, { branch: botBranch });
      return { pushed: true };
    });
    // A refused push means no branch exists on the remote — opening a PR
    // against it would fail or, worse, target a stale branch of the same name.
    if (pushResult.blocked)
      return reject(`gate refused the branch push: ${pushResult.blocked}`, { branch: botBranch });
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
export function fileIssue(payload: IssuePayload, ctx: IssueContext): Promise<FileOutcome> {
  return oneFilingAtATime("issue", () => fileIssueNow(payload, ctx));
}

async function fileIssueNow(payload: IssuePayload, ctx: IssueContext): Promise<FileOutcome> {
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
    if (pr !== null)
      ctx.store.logAnomaly(
        "deferral_ticket_refused",
        pr,
        null,
        `${reason} (draft: "${payload.title}")`,
      );
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
    return reject(
      `duplicate of open issue #${dup.number} "${dup.title}" (similarity ${dup.score.toFixed(2)})`,
      {
        duplicate_of: dup.number,
      },
    );
  }

  const result = await ctx.adapter.createIssue(payload.title, payload.body, [
    ctx.cfg.github.issue_label,
  ]);
  const issueNumber = (result.response as { number?: number } | undefined)?.number ?? 0;
  const ref = issueNumber > 0 ? `#${issueNumber}` : null;
  ctx.store.recordFiledItem("issue", payload.title, ref);
  ctx.store.logEvent("issue_filed", pr, {
    title: payload.title,
    issue: issueNumber || null,
    pr,
    dry_run: ctx.gate.isDryRun,
  });
  return { ok: true, issue: issueNumber > 0 ? issueNumber : null, pr, dry_run: ctx.gate.isDryRun };
}
