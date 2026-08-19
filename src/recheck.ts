// Post-approval delta recheck.
//
// The gap this closes: once a PR is approved nothing looks at it again. The
// predecessor system's staleness gate caught 13 genuine post-approval
// regressions (a regex reorder, a string-truncation rewrite, a classification
// branch) — and cost 2.56M output tokens, 19% of all output, because its
// predicate was `committedDate > submittedAt` with no notion of what changed.
// So this is NOT that gate rebuilt: the delta is classified first, and the
// standing verdict is UPHELD BY DEFAULT.
//
// Shape of the mechanism:
//
//   trigger ──► planRecheck() ──► no-op (uphold, nothing posted, nothing spent)
//                             └─► one nudge to the PR's OWN sticky session
//
// Four triggers, all decided (the owner, 2026-08-18): a push after an approve,
// CI completing at the head, the base branch advancing, and an author reply.
// The author reply is deliberately a no-op HERE: `src/pingpong.ts` already owns
// that path (≤3 exchanges, reply + optional thread resolve) and a second reply
// handler is exactly the duplication the ticket forbids. With no code delta
// there is nothing to recheck; the value is the reply, which is already owned.
//
// Invariants this module keeps structurally, not by prompting:
//
//  1. **Only APPROVE → REQUEST_CHANGES.** A recheck is planned only when the
//     standing verdict is APPROVE, and the decision file accepts exactly two
//     outcomes: `uphold` and `request_changes`. Anything else — including a
//     literal "APPROVE" or "NEEDS_HUMAN" — is coerced to `uphold` and logged.
//     The path can therefore never re-approve (138 repeat approvals / 1.86M
//     output tokens in the old system) and never park.
//  2. **A trivial or empty delta costs one classification and a no-op.** That
//     is what makes the broad trigger set affordable. A base advance touching
//     no PR-owned file is the loudest instance and resolves to `empty-delta`.
//  3. **An unchanged head with no new evidence is a no-op** — the same rule
//     installed on the gate (`guards.hasNewEvidence`), read here off
//     the same single `reviewed_heads` mark. There is no second copy.
//  4. **Single shepherd.** The recheck is a nudge to the PR's existing `pr-<n>`
//     session — no new session, no lens fan-out, no round. It goes through
//     `wakeOrHold`, so a nudge arriving mid-round is held and flushed at round
//     end like any other wake.
//  5. **No GitHub write lives here.** The module reads (compare, files) and
//     writes nothing; the session posts its review through the gated scripts.
//     The MutationGate keeps its monopoly by this module having no mutation.
import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, watch, type FSWatcher } from "node:fs";
import { join } from "node:path";
import type { Config } from "./config.js";
import type { PrFileEntry } from "./github.js";
import { applyEvent } from "./statemachine.js";
import type { StateStore } from "./state.js";
import { normalizeVerdict } from "./types.js";
import { wakeOrHold } from "./wakes.js";

/** What woke the recheck. `author_reply` is listed because it is a decided
 * trigger — its handling is "hand it to ping-pong and do nothing else". */
export type RecheckTrigger = "push" | "ci" | "base_advance" | "author_reply";

/** A changed file as the compare/files APIs report it. */
export type DeltaFile = PrFileEntry & { previous_filename?: string };

// ---- the ONE trivial-delta classifier ------------------------------------

/** Why a file was judged not worth re-reviewing. */
export type TrivialReason =
  | "base-merge"
  | "migration-renumber"
  | "pure-rename"
  | "version-bump"
  | "formatting"
  | "no-content-change";

export interface FileClass {
  filename: string;
  class: "trivial" | "significant";
  /** The trivial rule that fired, or "content" for a real change. */
  reason: TrivialReason | "content";
}

export type DeltaClass = "empty" | "trivial" | "significant";

export interface DeltaClassification {
  class: DeltaClass;
  files: FileClass[];
  /** The subset the session is actually asked to look at. */
  significant: FileClass[];
}

/** Dependency-manifest lockfiles: generated, never reviewed on their content. */
const LOCKFILES = new Set([
  "package-lock.json",
  "npm-shrinkwrap.json",
  "yarn.lock",
  "pnpm-lock.yaml",
  "poetry.lock",
  "uv.lock",
  "Pipfile.lock",
  "Cargo.lock",
  "Gemfile.lock",
  "composer.lock",
  "go.sum",
]);

/** Manifests whose version field moves on a release bump. */
const VERSION_MANIFESTS = new Set(["package.json", "pyproject.toml", "Cargo.toml", "setup.cfg", "VERSION", "version.txt"]);

function baseName(path: string): string {
  return path.split("/").pop() ?? path;
}

function isMigration(path: string): boolean {
  return /(^|\/)migrations\//.test(path);
}

/**
 * Split a migration filename into its number and the rest: `0042_add_foo.py`
 * → `{ num: "0042", rest: "add_foo.py" }`. Null when the file is not a
 * numbered migration.
 */
export function migrationName(path: string): { num: string; rest: string } | null {
  const m = /^(\d+)[_-](.+)$/.exec(baseName(path));
  if (!m || !isMigration(path)) return null;
  return { num: m[1] as string, rest: m[2] as string };
}

/** A rename that only moves a migration's number: `0042_x.py` → `0043_x.py`. */
export function isMigrationRenumber(from: string, to: string): boolean {
  const a = migrationName(from);
  const b = migrationName(to);
  return a !== null && b !== null && a.rest === b.rest && a.num !== b.num;
}

interface PatchLines {
  added: string[];
  removed: string[];
}

/** Added/removed lines of a unified diff, headers excluded. */
export function patchLines(patch: string): PatchLines {
  const added: string[] = [];
  const removed: string[] = [];
  for (const line of patch.split("\n")) {
    if (line.startsWith("+++") || line.startsWith("---")) continue;
    if (line.startsWith("+")) added.push(line.slice(1));
    else if (line.startsWith("-")) removed.push(line.slice(1));
  }
  return { added, removed };
}

const squash = (lines: string[]): string => lines.join("").replace(/\s+/g, "");

/**
 * Whitespace-only change: the added and removed text are identical once every
 * whitespace character is dropped. Concatenation (not a per-line set) is the
 * comparison, so a re-indent or a re-flow passes while a reordering of real
 * lines does not.
 */
export function formattingOnly(patch: string): boolean {
  const { added, removed } = patchLines(patch);
  if (added.length === 0 && removed.length === 0) return false;
  return squash(added) === squash(removed);
}

/** Same text once every MIGRATION-NUMBER run is masked — the renumber's
 * content edit (`dependencies = [("app", "0042_x")]` → `"0043_x"`) and nothing
 * else. Only a digit run immediately followed by `_` (the `NNNN_name` shape a
 * migration filename or `dependencies` entry carries) is masked: a semantic
 * numeric change inside a renamed migration — a batch size, a timeout, a
 * default — does NOT mask away, so it classifies significant. */
export function digitsOnly(patch: string): boolean {
  const { added, removed } = patchLines(patch);
  const mask = (lines: string[]): string => squash(lines).replace(/\d+(?=_)/g, "#");
  return mask(added) === mask(removed);
}

/** Every changed line mentions a version field — the release-bump shape. */
export function versionOnly(patch: string): boolean {
  const { added, removed } = patchLines(patch);
  const lines = [...added, ...removed];
  if (lines.length === 0) return false;
  return lines.every((l) => /(^|[^a-z])version([^a-z]|$)/i.test(l));
}

export interface ClassifyOpts {
  /**
   * Files this PR owns — its own diff against its base. A delta file outside
   * that set arrived from the base branch (a master pull, a conflict
   * resolution, a base advance) and is not this PR's to review: "later commits
   * on the base are not yours". Omitted ⇒ ownership is not consulted.
   */
  prFiles?: ReadonlySet<string>;
  /** Files hand-resolved inside a merge commit (their content differs from
   * git's own auto-merge of the parents). A clean base merge is trivial; a
   * conflict RESOLUTION is a human/agent decision and classifies significant
   * even outside prFiles — the dropped-master-change bug lives exactly there
   * (the owner, 2026-08-19). */
  resolvedFiles?: ReadonlySet<string>;
}

/** Classify one file. The rules are deliberately narrow: anything a rule does
 * not positively recognise is significant. */
export function classifyFile(file: DeltaFile, opts: ClassifyOpts = {}): FileClass {
  const name = file.filename;
  const trivial = (reason: TrivialReason): FileClass => ({ filename: name, class: "trivial", reason });

  // A hand-resolved merge conflict is never trivial, wherever the file lives.
  if (opts.resolvedFiles?.has(name)) return { filename: name, class: "significant", reason: "content" };

  if (opts.prFiles && !opts.prFiles.has(name) && !(file.previous_filename && opts.prFiles.has(file.previous_filename)))
    return trivial("base-merge");

  const patch = file.patch ?? "";
  const churn = (file.additions ?? 0) + (file.deletions ?? 0);

  if (file.previous_filename && isMigrationRenumber(file.previous_filename, name)) {
    if (churn === 0 || !patch || digitsOnly(patch) || formattingOnly(patch)) return trivial("migration-renumber");
    return { filename: name, class: "significant", reason: "content" };
  }
  if (file.previous_filename && churn === 0) return trivial("pure-rename");

  if (LOCKFILES.has(baseName(name))) return trivial("version-bump");
  if (VERSION_MANIFESTS.has(baseName(name)) && patch && versionOnly(patch)) return trivial("version-bump");

  if (patch && formattingOnly(patch)) return trivial("formatting");
  if (!patch && churn === 0) return trivial("no-content-change");

  return { filename: name, class: "significant", reason: "content" };
}

/**
 * Classify the whole delta. Run before the per-file pass: GitHub reports a
 * migration renumber as a rename only when it detects one — a large enough
 * content edit comes back as a delete + an add, and that pair is the same
 * mechanical renumber.
 */
export function classifyDelta(files: readonly DeltaFile[], opts: ClassifyOpts = {}): DeltaClassification {
  const removedMigrations = new Map<string, DeltaFile>();
  for (const f of files) {
    if (f.status !== "removed") continue;
    const m = migrationName(f.filename);
    if (m) removedMigrations.set(m.rest, f);
  }
  const renumbered = new Set<string>();
  for (const f of files) {
    if (f.status !== "added") continue;
    const m = migrationName(f.filename);
    const partner = m ? removedMigrations.get(m.rest) : undefined;
    if (!m || !partner) continue;
    if (migrationName(partner.filename)?.num === m.num) continue;
    renumbered.add(f.filename);
    renumbered.add(partner.filename);
  }

  const classified = files.map((f): FileClass => {
    // A hand-resolved conflict beats every trivial rule, renumber included.
    if (opts.resolvedFiles?.has(f.filename)) return { filename: f.filename, class: "significant", reason: "content" };
    if (renumbered.has(f.filename)) {
      // Ownership still wins: a migration that arrived with the base is a
      // base-merge file whatever its number does.
      const owned = !opts.prFiles || opts.prFiles.has(f.filename);
      return { filename: f.filename, class: "trivial", reason: owned ? "migration-renumber" : "base-merge" };
    }
    return classifyFile(f, opts);
  });
  const significant = classified.filter((f) => f.class === "significant");
  const cls: DeltaClass = classified.length === 0 ? "empty" : significant.length > 0 ? "significant" : "trivial";
  return { class: cls, files: classified, significant };
}

// ---- the plan -------------------------------------------------------------

/** Why a trigger did not produce a nudge. Every one of these upholds the
 * standing verdict — that is the default, not an outcome. */
export type NoopReason =
  | "disabled"
  | "pingpong-owns-reply"
  | "no-standing-approval"
  | "pr-not-open"
  | "unchanged-head"
  | "empty-delta"
  | "trivial-delta"
  | "already-rechecked"
  | "no-delta-source" | "delivery-failed";

export interface RecheckPlanInput {
  trigger: RecheckTrigger;
  /** The verdict standing at `last_reviewed_sha` (the reviewed-head mark). */
  standing: string | null | undefined;
  last_reviewed_sha: string;
  head_sha: string;
  delta: readonly DeltaFile[];
  /** The PR's own changed files (ownership, see ClassifyOpts.prFiles). */
  prFiles?: readonly string[];
  /** Hand-resolved merge files (see ClassifyOpts.resolvedFiles). */
  resolvedFiles?: readonly string[];
  /** CI conclusion for the `ci` trigger, as GitHub spells it. */
  ci?: { conclusion: string | null };
}

export type RecheckPlan =
  | { action: "noop"; reason: NoopReason; class: DeltaClass; classification?: DeltaClassification }
  | { action: "recheck"; class: DeltaClass; evidence: string; classification: DeltaClassification };

/** CI conclusions that carry no bad news. Anything else at an approved head is
 * new evidence in the sense: something the standing review did not see. */
const CI_BENIGN = new Set(["success", "neutral", "skipped", "cancelled", "stale"]);

export function ciIsAdverse(conclusion: string | null | undefined): boolean {
  if (!conclusion) return false;
  return !CI_BENIGN.has(conclusion.toLowerCase());
}

/**
 * The whole decision, pure. Order matters: the cheap structural refusals come
 * before anything that would cost a classification, and the classification
 * comes before anything that would cost a session turn.
 */
/** Move a withheld-approval mark to a newer head after an uphold (the owner,
 * 2026-08-19). This is NOT a re-approve — the approval was never posted; the
 * retry still demands green CI at the new head before anything posts.
 * No mark, or a mark already at this head, is a silent no-op. */
export function carryWithheldMark(
  store: StateStore,
  pr: number,
  newHead: string,
  via: string,
  log: (msg: string) => void = () => {},
): void {
  const withheld = store.approvalWithheld(pr);
  if (!withheld || withheld.head_sha === newHead) return;
  // the classifier verdict that caused the withhold rides along with
  // the mark — the carried head has no fresher CI read to offer, and the
  // retry re-classifies at release time anyway.
  store.recordApprovalWithheld(pr, { head_sha: newHead, ci_state: withheld.ci_state ?? null, reason: withheld.reason ?? "red-ci" });
  store.logEvent("approval_withheld_carried", pr, { from: withheld.head_sha, to: newHead, via });
  log(`recheck: #${pr} withheld approval carried ${withheld.head_sha.slice(0, 7)} → ${newHead.slice(0, 7)} (${via})`);
}

export function planRecheck(input: RecheckPlanInput): RecheckPlan {
  const noop = (reason: NoopReason, classification?: DeltaClassification): RecheckPlan => ({
    action: "noop",
    reason,
    class: classification?.class ?? "empty",
    ...(classification ? { classification } : {}),
  });

  // The author-reply trigger is owned end to end by src/pingpong.ts. Nothing
  // to recheck without a code delta, and a second reply handler is the failure
  // mode the ticket names.
  if (input.trigger === "author_reply") return noop("pingpong-owns-reply");

  // Only a standing APPROVE can be moved by this path, and only downwards.
  // Everything else (REQUEST_CHANGES, NEEDS_HUMAN, never reviewed) already has
  // a route: the ordinary trigger → round path.
  if (normalizeVerdict(input.standing) !== "APPROVE") return noop("no-standing-approval");

  const adverseCi = input.trigger === "ci" && ciIsAdverse(input.ci?.conclusion);
  // The rule, read off the same mark: same head, nothing new ⇒ nothing
  // to do. A base advance is exempt because its delta is on the base side, and
  // an adverse CI conclusion IS the new evidence.
  if (input.trigger !== "base_advance" && input.head_sha === input.last_reviewed_sha && !adverseCi)
    return noop("unchanged-head");

  const classification = classifyDelta(input.delta, {
    ...(input.prFiles ? { prFiles: new Set(input.prFiles) } : {}),
    ...(input.resolvedFiles ? { resolvedFiles: new Set(input.resolvedFiles) } : {}),
  });
  if (adverseCi)
    return { action: "recheck", class: classification.class, evidence: `CI concluded ${input.ci?.conclusion}`, classification };
  if (classification.class === "empty") return noop("empty-delta", classification);
  if (classification.class === "trivial") return noop("trivial-delta", classification);
  return {
    action: "recheck",
    class: classification.class,
    evidence: `${classification.significant.length} changed file(s) this review has not seen`,
    classification,
  };
}

// ---- the order handed to the session --------------------------------------

/** The recheck's own order kind — deliberately NOT a RoundOrder: no round is
 * started, no pass plan exists, and the session is asked one question. */
export interface RecheckOrder {
  pr: number;
  title: string;
  trigger: RecheckTrigger;
  /** Always APPROVE — the only standing verdict this path can act on. */
  standing_verdict: "APPROVE";
  last_reviewed_sha: string;
  head_sha: string;
  worktree: string;
  evidence: string;
  files: FileClass[];
  /** Files hand-resolved inside merge commits of this delta — the session
   * must audit each against BOTH merge parents (the owner, 2026-08-19). */
  resolved_files: string[];
  /** Relative name of the decision file the session must write. */
  decision_file: string;
  issued_at: string;
}

/** `verdict/pr-<n>-recheck-<head12>.json`. */
export function recheckDecisionFile(pr: number, headSha: string): string {
  return `pr-${pr}-recheck-${headSha.slice(0, 12).toLowerCase()}.json`;
}

export const RECHECK_FILE_RE = /^pr-(\d+)-recheck-([0-9a-f]{7,40})\.json$/i;

const recheckSleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

/** The runaway-guard identity of one recheck question: (trigger, head, ci
 * conclusion, base target). Shared by runRecheck's claim and the reconcile
 * backstop's has-this-been-asked check. */
export function recheckFingerprint(req: { trigger: RecheckTrigger; head_sha?: string; ci?: { conclusion?: string | null } | null; base?: { after?: string } | null }, headOverride?: string): string {
  const head = headOverride ?? req.head_sha ?? "";
  return [req.trigger, head, req.ci?.conclusion ?? "", req.base?.after ?? ""].join(":");
}


/** Fallback renderer (stub-wired daemon, unit tests): the order as JSON. */
export function defaultRecheckPrompt(order: RecheckOrder): string {
  return JSON.stringify(order, null, 2);
}

// ---- the runner -----------------------------------------------------------

/** Read-only adapter slice. Every call here is a GET; this module never writes
 * to GitHub, so no mutation can escape the gate through it. */
export interface RecheckAdapter {
  getPr(n: number): Promise<{ base_ref: string; head_sha: string; state: string; merged: boolean; title?: string }>;
  listPrFiles(n: number): Promise<DeltaFile[]>;
  /** `GET /compare/<base>...<head>` — the files a range changed. */
  compareFiles(base: string, head: string): Promise<DeltaFile[]>;
}

export interface RecheckDeps {
  cfg: Config;
  store: StateStore;
  /** Partial: a daemon wired without the compare read simply never rechecks
   * (logged), exactly as it behaved before this slice existed. */
  adapter: Partial<RecheckAdapter>;
  /** SessionHooks.inject — the nudge goes to the PR's existing session. */
  inject: (pr: number, message: string) => Promise<void>;
  renderPrompt?: (order: RecheckOrder) => string;
  worktreeFor?: (pr: number) => string;
  /** Hand-resolved merge files between two shas (WorktreeManager
   * .resolvedFilesInMerges, wired by the daemon). Absent ⇒ merges classify by
   * the ownership rule alone, as before the 2026-08-19 amendment. */
  resolvedFilesInMerges?: (from: string, to: string, pr?: number) => Promise<{ files: string[]; degraded: boolean }>;
  now?: () => Date;
  log?: (msg: string, extra?: unknown) => void;
}

export interface RecheckRequest {
  pr: number;
  trigger: RecheckTrigger;
  /** The head the trigger is about; defaults to the PR row's head. */
  head_sha?: string;
  ci?: { conclusion: string | null };
  /** The base advance: which branch moved, and between which shas. */
  base?: { branch: string; before: string; after: string };
}

export type RecheckOutcome = RecheckPlan & { delivered?: "injected" | "held"; order?: RecheckOrder };

/**
 * One trigger, start to finish. Returns the plan so callers (and tests) can see
 * exactly why a trigger cost nothing.
 */
export async function runRecheck(deps: RecheckDeps, req: RecheckRequest): Promise<RecheckOutcome> {
  const { cfg, store } = deps;
  const log = deps.log ?? ((): void => {});
  const now = deps.now ?? ((): Date => new Date());

  const done = (plan: RecheckPlan): RecheckOutcome => {
    if (plan.action === "noop")
      store.logEvent("recheck_noop", req.pr, {
        trigger: req.trigger,
        reason: plan.reason,
        delta_class: plan.class,
        files: plan.classification?.files.map((f) => `${f.filename} (${f.reason})`) ?? [],
      });
    return plan;
  };

  if (!cfg.recheck.enabled || !triggerEnabled(cfg, req.trigger)) return done({ action: "noop", reason: "disabled", class: "empty" });
  // Cheapest refusal first: ping-pong owns the author reply.
  if (req.trigger === "author_reply") return done(planRecheck({ ...emptyPlanInput(req), standing: "APPROVE" }));

  const mark = store.reviewedHead(req.pr);
  if (normalizeVerdict(mark?.verdict) !== "APPROVE") return done({ action: "noop", reason: "no-standing-approval", class: "empty" });

  const row = store.getPr(req.pr);
  if (!row || row.state === "closed") return done({ action: "noop", reason: "pr-not-open", class: "empty" });

  const head = req.head_sha || row.head_sha;
  const lastReviewed = mark!.head_sha;
  const adverseCi = req.trigger === "ci" && ciIsAdverse(req.ci?.conclusion);
  // Refuse before spending a single API call on a head we already decided.
  if (req.trigger !== "base_advance" && head === lastReviewed && !adverseCi)
    return done({ action: "noop", reason: "unchanged-head", class: "empty" });

  if (!deps.adapter.compareFiles || !deps.adapter.listPrFiles)
    return done({ action: "noop", reason: "no-delta-source", class: "empty" });

  let delta: DeltaFile[];
  let prFiles: string[];
  try {
    delta =
      req.trigger === "base_advance" && req.base
        ? await deps.adapter.compareFiles(req.base.before, req.base.after)
        : await deps.adapter.compareFiles(lastReviewed, head);
    const own = await deps.adapter.listPrFiles(req.pr);
    prFiles = own.flatMap((f) => (f.previous_filename ? [f.filename, f.previous_filename] : [f.filename]));
  } catch (err) {
    // A read failure is not evidence of anything. Uphold and log: the reconcile
    // poll and the next trigger both come round again.
    log(`recheck: #${req.pr} delta read failed`, err);
    store.logEvent("recheck_delta_failed", req.pr, { trigger: req.trigger, error: String(err) });
    // Durable anomaly row. QUIET class: DB-only, reviewed
    // at the daily heartbeat — the reconcile poll retries this on its own.
    store.logAnomaly("recheck_delta_failed", req.pr, null, `delta read failed (${req.trigger}): ${String(err)}`);
    return done({ action: "noop", reason: "no-delta-source", class: "empty" });
  }

  // Conflict resolutions are never trivial (the owner, 2026-08-19): ask git
  // which files in this delta's merges were hand-resolved. Degraded/unknown
  // keeps prior behaviour but is LOGGED — never silently quieter.
  let resolvedFiles: string[] = [];
  if (deps.resolvedFilesInMerges) {
    const from = req.trigger === "base_advance" && req.base ? req.base.before : lastReviewed;
    const to = req.trigger === "base_advance" && req.base ? req.base.after : head;
    const res = await deps.resolvedFilesInMerges(from, to, req.pr);
    resolvedFiles = res.files;
    if (res.degraded) {
      store.logEvent("recheck_merge_verify_degraded", req.pr, { from, to });
      // Durable anomaly record — degraded is "never silently
      // quieter" (the owner, 2026-08-19), and now also never unqueryable.
      store.logAnomaly(
        "recheck_merge_verify_degraded",
        req.pr,
        null,
        `merge-verify degraded ${from.slice(0, 7)}→${to.slice(0, 7)} — prior (delta-only) classification kept`,
      );
    }
  }

  const plan = planRecheck({
    trigger: req.trigger,
    standing: mark!.verdict,
    last_reviewed_sha: lastReviewed,
    head_sha: head,
    delta,
    prFiles,
    resolvedFiles,
    ...(req.ci ? { ci: req.ci } : {}),
  });
  // Carry-forward (the owner, 2026-08-19): a withheld approval whose head moved
  // used to be stranded — the mark stayed pinned to the old sha, the retry
  // no-op'd on "head-moved" forever, and the recheck can never approve. When
  // the delta itself upholds (empty/trivial), the never-posted approval moves
  // with the head, so green CI at the NEW head releases it. A significant
  // delta carries only after the session's explicit uphold (watcher below).
  if (plan.action === "noop") {
    if ((plan.reason === "empty-delta" || plan.reason === "trivial-delta") && head !== lastReviewed) {
      carryWithheldMark(store, req.pr, head, `recheck-noop:${plan.reason}`, log);
      // A trivial/empty answer is terminal for this head: claim it, so the
      // reconcile backstop (below in reconcile.ts) never re-classifies the
      // same question every sweep.
      store.claimRecheck(req.pr, recheckFingerprint(req, head), { head_sha: head, trigger: req.trigger, reason: `noop:${plan.reason}` });
    }
    return done(plan);
  }

  // The runaway guard: one nudge per (trigger, head, evidence). Without it a
  // reconcile replay or a redelivered webhook re-asks the same question, which
  // is how the old staleness gate burned 19% of all output.
  const fingerprint = recheckFingerprint(req, head);
  if (!store.claimRecheck(req.pr, fingerprint, { head_sha: head, trigger: req.trigger, reason: plan.evidence }))
    return done({ action: "noop", reason: "already-rechecked", class: plan.class, classification: plan.classification });

  const order: RecheckOrder = {
    pr: req.pr,
    title: row.title,
    trigger: req.trigger,
    standing_verdict: "APPROVE",
    last_reviewed_sha: lastReviewed,
    head_sha: head,
    worktree: (deps.worktreeFor ?? ((n: number): string => `wt/pr-${n}`))(req.pr),
    evidence: plan.evidence,
    files: plan.classification.files,
    resolved_files: resolvedFiles,
    decision_file: recheckDecisionFile(req.pr, head),
    issued_at: now().toISOString(),
  };
  const render = deps.renderPrompt ?? defaultRecheckPrompt;
  // S4: mid-round nudges are held and flushed at round end — the PR's one main
  // pi is never given two instructions at once.
  let delivered: "injected" | "held";
  try {
    delivered = await wakeOrHold(
      { store, inject: deps.inject, log },
      req.pr,
      render(order),
      `recheck:${req.trigger}`,
    );
  } catch (err) {
    // A claim must not outlive a nudge that never reached the session — the
    // fingerprint would otherwise dedupe every retry and the delta is never
    // audited (live on #5290: boot-order inject failure).
    store.releaseRecheck(req.pr, fingerprint);
    store.logEvent("recheck_delivery_failed", req.pr, { trigger: req.trigger, head_sha: head, error: String(err) });
    log(`recheck: #${req.pr} delivery failed — claim released for retry`, err);
    return done({ action: "noop", reason: "delivery-failed", class: plan.class, classification: plan.classification });
  }
  store.logEvent("recheck_nudged", req.pr, {
    trigger: req.trigger,
    head_sha: head,
    last_reviewed_sha: lastReviewed,
    delta_class: plan.class,
    significant: plan.classification.significant.map((f) => f.filename),
    evidence: plan.evidence,
    delivered,
  });
  log(`recheck: #${req.pr} nudged (${req.trigger}, ${plan.classification.significant.length} file(s)) — ${delivered}`);
  return { ...plan, delivered, order };
}

function triggerEnabled(cfg: Config, trigger: RecheckTrigger): boolean {
  switch (trigger) {
    case "push":
      return cfg.recheck.on_push;
    case "ci":
      return cfg.recheck.on_ci;
    case "base_advance":
      return cfg.recheck.on_base_advance;
    case "author_reply":
      return true; // always reaches the ping-pong no-op
  }
}

function emptyPlanInput(req: RecheckRequest): RecheckPlanInput {
  return { trigger: req.trigger, standing: null, last_reviewed_sha: "", head_sha: req.head_sha ?? "", delta: [] };
}

/**
 * A base branch moved: fan the advance out to the PRs that target it and hold
 * a standing approval. Every other PR is skipped without an API call.
 */
export async function runBaseAdvance(
  deps: RecheckDeps,
  advance: { branch: string; before: string; after: string },
): Promise<Map<number, RecheckOutcome>> {
  const out = new Map<number, RecheckOutcome>();
  const log = deps.log ?? ((): void => {});
  if (!deps.cfg.recheck.enabled || !deps.cfg.recheck.on_base_advance) return out;
  for (const row of deps.store.allPrs()) {
    if (row.state === "closed") continue;
    if (normalizeVerdict(deps.store.reviewedHead(row.number)?.verdict) !== "APPROVE") continue;
    if (deps.adapter.getPr) {
      try {
        // Called on the adapter, never through a detached reference: the real
        // GitHubAdapter's methods are class methods and need their `this`.
        const ref = await deps.adapter.getPr(row.number);
        if (ref.base_ref && ref.base_ref !== advance.branch) continue;
      } catch (err) {
        log(`recheck: #${row.number} base ref lookup failed`, err);
        continue;
      }
    }
    out.set(row.number, await runRecheck(deps, { pr: row.number, trigger: "base_advance", base: advance }));
  }
  return out;
}

// ---- the decision file ----------------------------------------------------

/**
 * The session's answer. Two outcomes only — this is where invariant 1 lives.
 * `uphold` posts nothing at all; `request_changes` means the session has
 * posted its review through the gated scripts and the daemon moves the PR to
 * awaiting_author.
 */
export interface RecheckDecision {
  pr: number;
  head_sha: string;
  outcome: "uphold" | "request_changes";
  reason?: string;
}

export interface ParsedRecheckDecision {
  ok: boolean;
  decision?: RecheckDecision;
  error?: string;
  /** An outcome that was not one of the two, folded to `uphold`. */
  coerced?: string;
}

export function validateRecheckDecision(raw: unknown): ParsedRecheckDecision {
  if (typeof raw !== "object" || raw === null) return { ok: false, error: "not an object" };
  const v = raw as Record<string, unknown>;
  if (typeof v.pr === "string" && /^\d+$/.test(v.pr)) v.pr = Number(v.pr);
  if (typeof v.pr !== "number" || !Number.isInteger(v.pr)) return { ok: false, error: "pr must be an integer" };
  if (typeof v.head_sha !== "string" || v.head_sha.length === 0) return { ok: false, error: "head_sha must be a non-empty string" };
  const raw_outcome = typeof v.outcome === "string" ? v.outcome.trim().toLowerCase() : "";
  // NOT a rejection: an unrecognised outcome (including "approve" and
  // "needs_human", which a session may reach for out of round habit) becomes
  // the default — uphold. The recheck path has no other verdict to give.
  const coerced = raw_outcome === "uphold" || raw_outcome === "request_changes" ? undefined : String(v.outcome ?? "");
  const outcome: RecheckDecision["outcome"] = raw_outcome === "request_changes" ? "request_changes" : "uphold";
  return {
    ok: true,
    decision: {
      pr: v.pr,
      head_sha: v.head_sha,
      outcome,
      ...(typeof v.reason === "string" ? { reason: v.reason.trim().slice(0, 800) } : {}),
    },
    ...(coerced !== undefined ? { coerced } : {}),
  };
}

export interface RecheckWatcherDeps {
  cfg: Config;
  store: StateStore;
  verdictDir: string;
  now?: () => Date;
  log?: (msg: string, extra?: unknown) => void;
  /** Parse retries for partially-written files (fs.watch fires on creation,
   * before the session's write completes — same race the VerdictWatcher
   * survives with its own retry loop). */
  parseRetries?: number;
  retryDelayMs?: number;
}

/**
 * Consumes `verdict/pr-<n>-recheck-<head12>.json`. It touches GitHub not at
 * all: on `uphold` there is nothing to say, and on `request_changes` the
 * session has already posted the review through the gated scripts — the daemon
 * only moves the lifecycle state.
 *
 * Neither outcome moves the reviewed-head mark. The mark records what was
 * really REVIEWED and posted; an upheld recheck posted nothing, and stamping
 * it would make's no-new-evidence guard swallow a genuine review
 * re-request at that head. The recheck's own runaway guard is the `rechecks`
 * claim table instead.
 */
export class RecheckWatcher {
  private watcher: FSWatcher | null = null;
  private readonly inFlight = new Set<string>();
  private readonly processedDir: string;

  constructor(private readonly deps: RecheckWatcherDeps) {
    this.processedDir = join(deps.verdictDir, "processed");
  }

  start(): void {
    mkdirSync(this.deps.verdictDir, { recursive: true });
    void this.sweep();
    this.watcher = watch(this.deps.verdictDir, (_event, filename) => {
      const name = filename ? String(filename) : "";
      if (RECHECK_FILE_RE.test(name)) void this.handleFile(name);
    });
  }

  stop(): void {
    this.watcher?.close();
    this.watcher = null;
  }

  async sweep(): Promise<string[]> {
    if (!existsSync(this.deps.verdictDir)) return [];
    const done: string[] = [];
    for (const name of readdirSync(this.deps.verdictDir).sort()) {
      if (RECHECK_FILE_RE.test(name) && (await this.handleFile(name))) done.push(name);
    }
    return done;
  }

  private archive(name: string): void {
    mkdirSync(this.processedDir, { recursive: true });
    const ts = (this.deps.now ?? ((): Date => new Date()))().toISOString().replace(/[:.]/g, "-");
    try {
      renameSync(join(this.deps.verdictDir, name), join(this.processedDir, `${ts}-${name}`));
    } catch (err) {
      this.deps.log?.(`recheck: could not archive ${name}`, err);
    }
  }

  async handleFile(name: string): Promise<boolean> {
    const match = RECHECK_FILE_RE.exec(name);
    if (!match || this.inFlight.has(name)) return false;
    this.inFlight.add(name);
    try {
      const path = join(this.deps.verdictDir, name);
      if (!existsSync(path)) return false;
      const pr = Number(match[1]);
      // Retry on parse failure: fs.watch fires the moment the file appears,
      // often before the session's write completes — an eager single read eats
      // valid uphold decisions as "unparseable" (live on #5315, 2026-08-19).
      const retries = this.deps.parseRetries ?? 3;
      const delay = this.deps.retryDelayMs ?? 40;
      let parsed: ParsedRecheckDecision = { ok: false, error: "unread" };
      for (let attempt = 0; attempt <= retries; attempt++) {
        try {
          parsed = validateRecheckDecision(JSON.parse(readFileSync(path, "utf8")));
        } catch (err) {
          parsed = { ok: false, error: `unparseable: ${String(err)}` };
        }
        if (parsed.ok) break;
        if (attempt < retries) await recheckSleep(delay);
      }
      if (!parsed.ok || !parsed.decision) {
        // Malformed is the safe direction here — the standing verdict simply
        // stays standing. No park, no anomaly round, nothing posted. But say
        // so out loud: the silent branch hid the partial-read race for hours.
        this.deps.store.logEvent("recheck_decision_malformed", pr, { file: name, error: parsed.error ?? "unknown" });
        this.deps.log?.(`recheck: #${pr} decision ${name} malformed after ${retries + 1} reads — standing verdict kept (${parsed.error ?? "unknown"})`);
        this.archive(name);
        return true;
      }
      const d = parsed.decision;
      if (d.pr !== pr || d.head_sha.slice(0, 12).toLowerCase() !== (match[2] as string).toLowerCase()) {
        this.deps.store.logEvent("recheck_decision_rejected", pr, { file: name, reason: "pr/head do not match the filename" });
        this.archive(name);
        return true;
      }
      if (parsed.coerced !== undefined)
        this.deps.store.logEvent("recheck_outcome_coerced", pr, { file: name, given: parsed.coerced, applied: "uphold" });

      if (d.outcome === "request_changes") {
        // Approval is off the table now — a lingering withheld mark would let
        // a later green CI re-queue "for the withheld approval" of a PR whose
        // standing verdict this very decision just flipped.
        this.deps.store.clearApprovalWithheld(pr);
        applyEvent(
          this.deps.store,
          pr,
          { type: "verdict", verdict: "REQUEST_CHANGES" },
          { head_sha: d.head_sha },
          { botLogin: this.deps.cfg.github.bot_login, ...(this.deps.now ? { now: this.deps.now } : {}), reason: "recheck:request-changes" },
        );
      }
      if (d.outcome === "uphold") {
        // Session-examined significant delta, verdict upheld: the withheld
        // approval (if any) follows the head (the owner, 2026-08-19).
        carryWithheldMark(this.deps.store, pr, d.head_sha, "recheck-uphold", (m) => this.deps.log?.(m));
      }
      this.deps.store.logEvent(d.outcome === "request_changes" ? "recheck_request_changes" : "recheck_upheld", pr, {
        file: name,
        head_sha: d.head_sha,
        reason: d.reason ?? null,
      });
      this.deps.log?.(`recheck: #${pr} ${d.outcome} at ${d.head_sha.slice(0, 7)}`);
      this.archive(name);
      return true;
    } catch (err) {
      this.deps.log?.(`recheck: ${name} failed`, err);
      return false;
    } finally {
      this.inFlight.delete(name);
    }
  }
}
