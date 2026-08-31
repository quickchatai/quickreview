// Verdict watcher (spec §3 "Verdict handling"). The PR session writes
// verdict/pr-<n>-round-<k>.json at round end; the daemon owns everything that
// touches GitHub from there: labels off/on, the escalation review request
// (redundancy-skipped inside the adapter), the round record, the state
// transition.
//
// Two anomaly paths, both explicitly no-approve: a malformed/unparseable
// verdict file, and a round that blows its deadline. Both mark the round and
// inject the overseer. There is no path here that touches an existing review:
// the invariant against retracting an approval is structural, not prompted
// (spec §3, §8).
import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, watch, type FSWatcher } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { classifyCi, type CheckSummary } from "./cigate.js";
import {
  DEFAULT_MAX_PROMPT_REDELIVERIES,
  DEFAULT_MAX_SELF_REQUEUES,
  DEFAULT_POSTING_RECEIPT_GRACE_S,
  DEFAULT_ROUND_STALL_GRACE_MIN,
  githubCloneDir,
  sandboxRoot,
  type Config,
} from "./config.js";
import {
  fingerprintRoundGitConfig,
  gitConfigChangeMessage,
  gitConfigChanges,
  type GitConfigFingerprint,
} from "./execboundary.js";
import { auditExecViolationDetails, collectWindowLines, estimateUsd, measureRoundUsage, type ModelPricing, type UsageFs } from "./usage.js";
import type { GateResult } from "./gate.js";
import { applyEvent } from "./statemachine.js";
import type { VerdictAnnouncer } from "./slack/announce.js";
import { isLoudCancelCause, type CancelCause, type RoundRow, type StateStore } from "./state.js";
import { enforceLedgerFreshness } from "./ledgercheck.js";
import { enforceFindingsRecord } from "./findingsrecord.js";
import { normalizeVerdict, type RoundRecoveryDisposition, type SessionHooks, type VerdictFile, type VerdictPassEntry } from "./types.js";
import { postingMarker, readPostingReceipt, receiptMatchesVerdict, type PostingReceipt } from "./posting-receipt.js";
import { flushHeldWakes } from "./wakes.js";

/** Self-requeue mode → the cancellation cause it records. Two modes
 * mean the same thing to a human — the round stopped dead with no verdict,
 * whether its session had died or was alive and wedged — and that is the ONE
 * loud cause; the rest are the machinery working (a moved head, a delivery
 * fault, a round redone because it executed no passes). */
type SelfRequeueMode = "dead" | "alive_stuck" | "needs_human_incomplete" | "lost_prompt" | "head_moved" | "infrastructure_active" | "infrastructure_settled";

const SELF_REQUEUE_CAUSE: Record<SelfRequeueMode, CancelCause> = {
  dead: "deadline_overrun",
  alive_stuck: "deadline_overrun",
  needs_human_incomplete: "incomplete_round",
  lost_prompt: "lost_prompt",
  head_moved: "head_moved",
  infrastructure_active: "infrastructure_failure",
  infrastructure_settled: "infrastructure_failure",
};

export interface VerdictAdapter {
  addLabel(n: number, label: string): Promise<GateResult>;
  removeLabel(n: number, label: string): Promise<GateResult>;
  /** Checks at a head (read-only, cigate's classifier input). Optional: with
   * it, a session-route withheld approval records WHICH CI state caused the
   * withhold; without it the mark stores null, as it always did. */
  listChecks?(ref: string): Promise<CheckSummary[]>;
  /** Read-only reconciliation for an ambiguous post-success/local-crash
   * window. Exact marker + bot identity + head are required. */
  listReviewsFull?(pr: number): Promise<Array<{
    id: number;
    user: string;
    user_type?: string;
    state: string;
    body: string;
    commit_id: string;
    submitted_at: string | null;
  }>>;
}

export interface VerdictDeps {
  cfg: Config;
  store: StateStore;
  adapter: VerdictAdapter;
  hooks: SessionHooks;
  /** Directory the sessions write into (sandbox `verdict/`). */
  verdictDir: string;
  /** Settle time between sending /compact and the ledger check.
   * compactSession only SENDS the keystrokes — an inject typed while the pane
   * is still compacting is lost with the aborted turn (live 2026-08-19,
   * #5290 round 7). 0 ⇒ inline (tests). Default 90s. */
  ledgerCheckDelayMs?: number;
  /** Slack announcer (S4). Optional: absent ⇒ no Slack, exactly as
   * every existing caller and test sees it. Never allowed to throw in here. */
  announce?: VerdictAnnouncer;
  /** Sandbox root — anchors the default pi-session dir. */
  root?: string;
  /** Atomic shell posting receipts. Defaults to state/posting-receipts. */
  postingReceiptDir?: string;
  postingReceiptGraceS?: number;
  /** Usage-measurement seams; every field defaults from cfg/root. */
  usage?: {
    /** pi session dir for a PR's sticky session (sessions.ts sessionDir()). */
    sessionDirFor?: (pr: number) => string;
    /** pi HOME global store (pass subagents); null disables the best-effort scan. */
    globalStoreDir?: string | null;
    /** Per-model pricing; defaults to config `[models.pricing]`. */
    pricing?: Record<string, ModelPricing>;
    fs?: UsageFs;
  };
  /** Where a PR's mirrored ledger snapshot lives. Defaults to
   * `<root>/state/ledgers/pr-<n>.md` — sessions.ts ledgerPath's shape. */
  ledgerPathFor?: (pr: number) => string;
  /**
   * Where the session writes its per-round reasoning record —
   * daemon.ts passes `<root>/state/findings`.
   *
   * Opt-in rather than defaulted off `root`, in the same shape as every other
   * additive round-end check here: absent ⇒ the record is neither parsed nor
   * enforced, which is exactly the legacy behaviour a stub-wired daemon
   * and every older test sees. Production has ONE assembly site (daemon.ts)
   * and it passes the dir.
   */
  findingsDir?: string;
  now?: () => Date;
  log?: (msg: string, extra?: unknown) => void;
  /** Parse retries for partially-written files. */
  parseRetries?: number;
  retryDelayMs?: number;
}

export const VERDICT_FILE_RE = /^pr-(\d+)-round-(\d+)\.json$/;

export interface ParsedVerdict {
  ok: boolean;
  verdict?: VerdictFile;
  error?: string;
  /** Why the `passes` telemetry ended up unknown/reduced — a note
   * for the log, NEVER a rejection reason. Absent when passes were clean. */
  passes_note?: string;
}

/**
 * Tolerant normalization of the executed-pass telemetry. LLM-written
 * files: digit-string counts coerce, `lens` is accepted for `name`,
 * `candidates`/`candidate_findings` for `findings`. Anything unusable —
 * a non-array, an entry with no name — degrades to UNKNOWN (undefined) or is
 * dropped with a note; nothing here can fail the verdict.
 */
export function normalizePasses(raw: unknown): { passes?: VerdictPassEntry[]; note?: string } {
  if (raw === undefined || raw === null) return { note: "absent" };
  if (!Array.isArray(raw)) return { note: `not an array (${typeof raw})` };
  const count = (val: unknown): number | null => {
    if (typeof val === "number" && Number.isFinite(val)) return Math.trunc(val);
    if (typeof val === "string" && /^\d+$/.test(val)) return Number(val);
    return null;
  };
  const passes: VerdictPassEntry[] = [];
  let dropped = 0;
  for (const entry of raw) {
    if (typeof entry !== "object" || entry === null) {
      dropped++;
      continue;
    }
    const e = entry as Record<string, unknown>;
    const name = typeof e.name === "string" && e.name.trim() ? e.name.trim() : typeof e.lens === "string" && e.lens.trim() ? e.lens.trim() : null;
    if (!name) {
      dropped++;
      continue;
    }
    passes.push({
      name,
      tier: typeof e.tier === "string" && e.tier.trim() ? e.tier.trim() : null,
      ...(typeof e.reason === "string" && e.reason.trim() ? { reason: e.reason.trim() } : {}),
      findings: count(e.findings) ?? count(e.candidates) ?? count(e.candidate_findings),
      survived: count(e.survived),
      killed: count(e.killed),
      downgraded: count(e.downgraded),
      merged: count(e.merged),
      folded: count(e.folded),
    });
  }
  return { passes, ...(dropped > 0 ? { note: `${dropped} malformed entr${dropped === 1 ? "y" : "ies"} dropped` } : {}) };
}

/** Shape validation for VerdictFile. Anything off → the anomaly path. */
export function validateVerdict(raw: unknown): ParsedVerdict {
  if (typeof raw !== "object" || raw === null) return { ok: false, error: "not an object" };
  const v = raw as Record<string, unknown>;
  const bad = (m: string): ParsedVerdict => ({ ok: false, error: m });
  // LLM-written files: coerce unambiguous digit-strings ("5263" → 5263) before
  // shape-checking — the first live rounds tripped exactly this.
  for (const k of ["pr", "round_no"] as const) {
    const val = v[k];
    if (typeof val === "string" && /^\d+$/.test(val)) v[k] = Number(val);
  }
  if (typeof v.pr !== "number" || !Number.isInteger(v.pr)) return bad("pr must be an integer");
  if (typeof v.round_no !== "number" || !Number.isInteger(v.round_no)) return bad("round_no must be an integer");
  // Guard-5 landing (follow-up): `outcome: "head_moved"` (or,
  // belt-and-braces, verdict spelled HEAD_MOVED) is a verdict-less round
  // ending — the PR advanced mid-round and the guard refused the stale post.
  // Only pr/round_no/head_sha/finished_at are required; the daemon cancels
  // the round and self-requeues instead of applying a verdict.
  const outcome = typeof v.outcome === "string" ? v.outcome.trim().toLowerCase() : "";
  const verdictSpelled = typeof v.verdict === "string" ? v.verdict.trim().toUpperCase() : "";
  if (outcome === "head_moved" || verdictSpelled === "HEAD_MOVED") {
    v.outcome = "head_moved";
    delete v.verdict;
    if (typeof v.head_sha !== "string" || v.head_sha.length === 0) return bad("head_sha must be a non-empty string");
    if (typeof v.finished_at !== "string" || v.finished_at.length === 0) return bad("finished_at must be a non-empty string");
    delete v.spend_usd;
    return { ok: true, verdict: raw as unknown as VerdictFile };
  }
  if (outcome) return bad(`bad outcome: ${String(v.outcome)}`);
  // normalizeVerdict also folds the retired "ESCALATE" spelling into
  // NEEDS_HUMAN — the frozen conversation-system.md seed still emits it.
  const verdict = normalizeVerdict(v.verdict);
  if (verdict === null) return bad(`bad verdict: ${String(v.verdict)}`);
  v.verdict = verdict;
  if (typeof v.head_sha !== "string" || v.head_sha.length === 0) return bad("head_sha must be a non-empty string");
  if (typeof v.finished_at !== "string" || v.finished_at.length === 0) return bad("finished_at must be a non-empty string");
  // spend_usd: legacy self-reported field — accepted in any shape and IGNORED
  // (models copy the template's example figure; real usage is measured from
  // the session JSONLs). Deleted so no consumer can store it.
  delete v.spend_usd;
  if (v.ai_approved !== undefined && typeof v.ai_approved !== "boolean") return bad("ai_approved must be a boolean");
  // LLM-written booleans arrive as strings often enough to coerce the
  // two unambiguous spellings rather than fail the whole file over them.
  if (v.approval_withheld === "true") v.approval_withheld = true;
  if (v.approval_withheld === "false") v.approval_withheld = false;
  if (v.approval_withheld !== undefined && typeof v.approval_withheld !== "boolean")
    return bad("approval_withheld must be a boolean");
  if (v.ledger_snapshot !== undefined && typeof v.ledger_snapshot !== "string") return bad("ledger_snapshot must be a string");
  if (v.summary !== undefined && typeof v.summary !== "string") return bad("summary must be a string");
  if (typeof v.summary === "string") v.summary = v.summary.trim().slice(0, 800);
  // Executed-pass telemetry: tolerant by design — old-prompt
  // sessions omit it and malformed shapes degrade to unknown, never to a
  // rejected verdict.
  const norm = normalizePasses(v.passes);
  if (norm.passes) v.passes = norm.passes;
  else delete v.passes;
  return { ok: true, verdict: raw as unknown as VerdictFile, ...(norm.note ? { passes_note: norm.note } : {}) };
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

export class VerdictWatcher {
  private watcher: FSWatcher | null = null;
  private readonly inFlight = new Set<string>();
  private readonly processedDir: string;
  /** Exec-policy violations found while measuring usage, kept only so an
   * overseer inject that happens anyway can carry a line about them —
   * violations alone never create inject spam. */
  private readonly execViolations = new Map<number, string[]>();

  constructor(private readonly deps: VerdictDeps) {
    this.processedDir = join(deps.verdictDir, "processed");
  }

  private now(): Date {
    return (this.deps.now ?? (() => new Date()))();
  }

  private log(msg: string, extra?: unknown): void {
    (this.deps.log ?? (() => {}))(msg, extra);
  }

  /** Startup sweep + fs.watch. fs.watch is the fast path only; the sweep (also
   * run by the daemon's periodic tick) is the reliable one. */
  start(): void {
    mkdirSync(this.deps.verdictDir, { recursive: true });
    void this.sweep();
    this.watcher = watch(this.deps.verdictDir, (_event, filename) => {
      if (!filename) return;
      const name = String(filename);
      if (!VERDICT_FILE_RE.test(name)) return;
      void this.handleFile(name).catch((err) => this.log(`verdicts: ${name} failed`, err));
    });
  }

  stop(): void {
    this.watcher?.close();
    this.watcher = null;
  }

  /** Process every verdict file sitting in the directory. */
  async sweep(): Promise<string[]> {
    if (!existsSync(this.deps.verdictDir)) return [];
    const done: string[] = [];
    for (const name of readdirSync(this.deps.verdictDir).sort()) {
      if (!VERDICT_FILE_RE.test(name)) continue;
      try {
        if (await this.handleFile(name)) done.push(name);
      } catch (err) {
        this.log(`verdicts: ${name} failed`, err);
      }
    }
    return done;
  }

  private runningRound(pr: number, roundNo?: number): RoundRow | undefined {
    if (roundNo !== undefined) {
      const row = this.deps.store.db
        .prepare("SELECT * FROM rounds WHERE pr = ? AND round_no = ? ORDER BY id DESC LIMIT 1")
        .get(pr, roundNo) as RoundRow | undefined;
      if (row) return row;
    }
    return this.deps.store.db
      .prepare("SELECT * FROM rounds WHERE pr = ? AND status = 'running' ORDER BY id DESC LIMIT 1")
      .get(pr) as RoundRow | undefined;
  }

  private archive(name: string): void {
    mkdirSync(this.processedDir, { recursive: true });
    try {
      renameSync(join(this.deps.verdictDir, name), join(this.processedDir, `${this.now().toISOString().replace(/[:.]/g, "-")}-${name}`));
    } catch (err) {
      this.log(`verdicts: could not archive ${name}`, err);
    }
  }

  /** Read + validate + apply one verdict file. Returns true when the file was
   * consumed (applied or quarantined). */
  async handleFile(name: string): Promise<boolean> {
    const match = VERDICT_FILE_RE.exec(name);
    if (!match) return false;
    if (this.inFlight.has(name)) return false;
    this.inFlight.add(name);
    try {
      const pr = Number(match[1]);
      const roundNo = Number(match[2]);
      const path = join(this.deps.verdictDir, name);
      if (!existsSync(path)) return false;

      // Partial writes: retry the parse a few times before declaring malformed.
      const retries = this.deps.parseRetries ?? 3;
      const delay = this.deps.retryDelayMs ?? 40;
      let parsed: ParsedVerdict = { ok: false, error: "unread" };
      for (let attempt = 0; attempt <= retries; attempt++) {
        try {
          parsed = validateVerdict(JSON.parse(readFileSync(path, "utf8")));
        } catch (err) {
          parsed = { ok: false, error: `unparseable: ${String(err)}` };
        }
        if (parsed.ok) break;
        if (attempt < retries) await sleep(delay);
      }

      if (!parsed.ok || !parsed.verdict) {
        await this.handleAnomaly(pr, roundNo, `malformed verdict file ${name}: ${parsed.error ?? "unknown"}`, "malformed");
        this.archive(name);
        return true;
      }
      if (parsed.passes_note) this.log(`verdicts: ${name} passes telemetry: ${parsed.passes_note}`);
      const applied = await this.apply(parsed.verdict, name);
      if (applied === "waiting") return false;
      this.archive(name);
      return true;
    } finally {
      this.inFlight.delete(name);
    }
  }

  private postingReceiptDir(): string {
    return this.deps.postingReceiptDir ?? join(this.deps.root ?? sandboxRoot(), "state", "posting-receipts");
  }

  private async postingProof(
    round: RoundRow,
    verdict?: VerdictFile,
  ): Promise<{ kind: "legacy" | "confirmed" | "waiting" | "failed"; detail?: string; receipt?: PostingReceipt }> {
    if (!round.posting_key) return { kind: "legacy" };
    const expectedHead = verdict?.head_sha ?? round.posting_key.split(":").slice(3).join(":");
    const receipt = readPostingReceipt(this.postingReceiptDir(), round.pr, round.round_no);
    const receiptIdentityOk = receipt !== undefined
      && receipt.posting_key === round.posting_key
      && receipt.pr === round.pr
      && receipt.round_no === round.round_no
      && receipt.head_sha.toLowerCase() === expectedHead.toLowerCase();
    if (receiptIdentityOk && receipt) {
      if (receipt.status === "confirmed" && (!verdict || receiptMatchesVerdict(receipt, verdict))) {
        const persisted = this.deps.store.confirmRoundPosting(round.id, {
          posting_key: receipt.posting_key,
          actual_event: receipt.actual_event,
          gh_review_id: receipt.gh_review_id!,
          gh_commit_id: receipt.gh_commit_id!,
          confirmed_at: receipt.confirmed_at!,
        });
        return persisted ? { kind: "confirmed", receipt } : { kind: "failed", detail: `conflicting posting linkage for ${round.posting_key}` };
      }
      if (receipt.status === "dryrun" && this.deps.cfg.dry_run && (!verdict || receiptMatchesVerdict(receipt, verdict))) {
        const persisted = this.deps.store.confirmRoundPosting(round.id, {
          posting_key: receipt.posting_key,
          actual_event: receipt.actual_event,
          gh_review_id: null,
          gh_commit_id: receipt.head_sha,
          confirmed_at: receipt.confirmed_at ?? receipt.prepared_at,
        });
        return persisted ? { kind: "confirmed", receipt } : { kind: "failed", detail: `conflicting dry-run posting linkage for ${round.posting_key}` };
      }
      if ((receipt.status === "confirmed" || receipt.status === "dryrun") && verdict) {
        return { kind: "failed", detail: `posting receipt ${round.posting_key} does not match verdict/head` };
      }
    }

    // The POST may have reached GitHub before the shell could persist its
    // response. Reconcile by the inert marker; never retry a mutation on an
    // ambiguous transport outcome.
    if (!this.deps.cfg.dry_run && this.deps.adapter.listReviewsFull) {
      try {
        const marker = postingMarker(round.posting_key);
        const bot = this.deps.cfg.github.bot_login;
        const matches = (await this.deps.adapter.listReviewsFull(round.pr)).filter((review) =>
          (review.user === bot || review.user === `${this.deps.cfg.github.app_slug}[bot]`)
          && review.commit_id?.toLowerCase() === expectedHead.toLowerCase()
          && review.body.includes(marker),
        );
        if (matches.length > 1) return { kind: "failed", detail: `multiple bot reviews match ${round.posting_key}` };
        if (matches.length === 1) {
          const match = matches[0]!;
          const actualEvent: PostingReceipt["actual_event"] = match.state.toUpperCase() === "APPROVED"
            ? "APPROVE"
            : match.state.toUpperCase() === "CHANGES_REQUESTED"
              ? "REQUEST_CHANGES"
              : "COMMENT";
          const synthetic: PostingReceipt = {
            version: 1,
            posting_key: round.posting_key,
            marker,
            pr: round.pr,
            round_no: round.round_no,
            head_sha: expectedHead,
            intended_event: actualEvent,
            actual_event: actualEvent,
            status: "confirmed",
            payload_sha256: "0".repeat(64),
            prepared_at: match.submitted_at ?? this.now().toISOString(),
            confirmed_at: match.submitted_at ?? this.now().toISOString(),
            gh_review_id: match.id,
            gh_commit_id: match.commit_id,
            gh_state: match.state,
          };
          if (verdict && !receiptMatchesVerdict(synthetic, verdict)) {
            return { kind: "failed", detail: `GitHub review ${match.id} event does not match verdict` };
          }
          const persisted = this.deps.store.confirmRoundPosting(round.id, {
            posting_key: round.posting_key,
            actual_event: actualEvent,
            gh_review_id: match.id,
            gh_commit_id: match.commit_id,
            confirmed_at: synthetic.confirmed_at!,
          });
          if (!persisted) return { kind: "failed", detail: `conflicting reconciled posting linkage for ${round.posting_key}` };
          this.deps.store.logEvent("posting_receipt_reconciled", round.pr, {
            round_no: round.round_no,
            posting_key: round.posting_key,
            gh_review_id: match.id,
          });
          return { kind: "confirmed", receipt: synthetic };
        }
      } catch (error) {
        this.log(`posting receipt reconciliation failed for #${round.pr} round ${round.round_no}`, error);
      }
    }

    const origin = receiptIdentityOk && receipt ? receipt.prepared_at : round.started_at;
    const graceS = this.deps.postingReceiptGraceS ?? this.deps.cfg.daemon.posting_receipt_grace_s ?? DEFAULT_POSTING_RECEIPT_GRACE_S;
    if (this.now().getTime() - Date.parse(origin) < graceS * 1000) return { kind: "waiting" };
    return { kind: "failed", detail: `no confirmed posting receipt for ${round.posting_key} after ${graceS}s` };
  }

  private async failPostingProof(round: RoundRow, detail: string, stage = "posting_receipt"): Promise<void> {
    const { store, cfg, adapter } = this.deps;
    store.markRoundCancelled(round.id, `posting receipt failure — ${detail}`, "infrastructure_failure");
    // this round ran a full review and burned its tokens — the
    // receipt is what failed, not the work. It stays in `SUM(est_usd) FROM
    // rounds` like every other row, so it must be measured here too. Its
    // window closes now and no successor is running, so nothing double-counts.
    this.measureUsage(round.pr, round.id, round.started_at, this.now().toISOString());
    await this.safe(() => adapter.removeLabel(round.pr, cfg.github.in_progress_label), `remove ${cfg.github.in_progress_label} on #${round.pr}`);
    const command = store.sessionCommandForRound(round.pr, round.round_no);
    const successor = store.successorFor(round.pr);
    const failure = store.openReviewFailure({
      pr: round.pr,
      command_id: command?.id ?? null,
      round_id: round.id,
      round_no: round.round_no,
      head_sha: successor?.head_sha ?? store.getPr(round.pr)?.head_sha ?? "",
      stage,
      detail,
      attempts: command?.attempt ?? 1,
      retry_cap: 0,
    });
    store.logAnomaly(
      "review_failed_loud",
      round.pr,
      round.round_no,
      `posting receipt: ${detail}; work remains owed as ${failure.incident_id}`,
    );
    await this.announceSafe((a) =>
      a.anomaly({
        pr: round.pr,
        round_no: round.round_no,
        kind: "failed_loud",
        deadline_min: cfg.daemon.round_deadline_min,
        incident_id: failure.incident_id,
      }),
    );
  }

  /** The handoff: posting receipt, labels, round record, transition. */
  private async apply(v: VerdictFile, name: string): Promise<"applied" | "waiting" | "failed"> {
    const { cfg, store, adapter } = this.deps;
    const round = this.runningRound(v.pr, v.round_no);

    // Guard-5 landing (follow-up): the session was refused at
    // posting time because the PR advanced mid-round, and said so explicitly
    // instead of idling to deadline expiry. Mapped exactly like the
    // needs_human_incomplete redo: immediate cancel + capped self-requeue
    // (SAME per-head counter, keyed on the FRESH head the PR row now
    // carries) — and the session is NOT killed: it is healthy, it did the
    // right thing. No verdict applies, no label lands, no reviewed-head mark
    // is stamped (nothing was reviewed-and-decided at the live head). Past
    // the cap (or with no running round) the anomaly path terminalizes —
    // never an approve.
    if (v.outcome === "head_moved") {
      store.logEvent("head_moved_reported", v.pr, {
        round_id: round?.id ?? null,
        round_no: v.round_no,
        reviewed_head: v.head_sha,
        file: name,
      });
      if (round && round.status === "running" && (await this.selfRequeue(round, "head_moved"))) {
        await this.safe(() => adapter.removeLabel(v.pr, cfg.github.in_progress_label), `remove ${cfg.github.in_progress_label} on #${v.pr}`);
        this.log(`verdicts: #${v.pr} round ${v.round_no} ended head_moved — cancelled and requeued at the fresh head`);
        return "applied";
      }
      await this.handleAnomaly(
        v.pr,
        v.round_no,
        `round ${v.round_no} reported head_moved (reviewed ${v.head_sha.slice(0, 7)}, the PR advanced mid-round) but could not be self-requeued — cap exhausted or no running round`,
        "overdue",
      );
      return "applied";
    }

    // NEEDS_HUMAN discipline (2026-08-19, the owner): a park hands a FINISHED
    // review to a person for the final call — it is never an escape hatch for
    // an unfinished one. A NEEDS_HUMAN with no executed-pass evidence (#5303:
    // "the configured passes were unavailable") did not do the review; redo it
    // through the capped self-requeue instead of parking. Past the cap (or
    // with no running round to cancel) the normal park below stands — the cap
    // guarantees this can never loop. No reviewed-head mark is recorded on
    // this path, so the redo round can dispatch and post at the same head.
    if (v.verdict === "NEEDS_HUMAN" && round && round.status === "running" && (!v.passes || v.passes.length === 0)) {
      store.logEvent("needs_human_incomplete", v.pr, {
        round_id: round.id,
        round_no: v.round_no,
        head_sha: v.head_sha,
        passes_reported: v.passes ? 0 : null,
      });
      if (await this.selfRequeue(round, "needs_human_incomplete")) {
        await this.safe(() => adapter.removeLabel(v.pr, cfg.github.in_progress_label), `remove ${cfg.github.in_progress_label} on #${v.pr}`);
        this.log(`verdicts: #${v.pr} round ${v.round_no} NEEDS_HUMAN without executed passes — requeued, not parked`);
        return "applied";
      }
    }

    if (round) {
      const proof = await this.postingProof(round, v);
      if (proof.kind === "waiting") {
        store.logEvent("verdict_waiting_posting_receipt", v.pr, { round_no: v.round_no, posting_key: round.posting_key });
        return "waiting";
      }
      if (proof.kind === "failed") {
        await this.failPostingProof(round, proof.detail ?? "posting receipt invalid");
        return "failed";
      }
      if (proof.kind === "legacy") store.logEvent("posting_receipt_legacy_unknown", v.pr, { round_no: v.round_no });
    }

    await this.safe(() => adapter.removeLabel(v.pr, cfg.github.in_progress_label), `remove ${cfg.github.in_progress_label} on #${v.pr}`);
    await this.safe(() => adapter.addLabel(v.pr, cfg.github.reviewed_label), `add ${cfg.github.reviewed_label} on #${v.pr}`);

    // spend_usd from the file is fiction (template echo) — never stored; the
    // measured figures land via recordRoundUsage below.
    // Captured BEFORE applyEvent: the transition context writes the verdict's
    // (possibly stale) head back onto pr_state, which would mask a mid-round
    // advance (see the chain below).
    const headBeforeApply = store.getPr(v.pr)?.head_sha ?? null;
    if (round && v.head_sha && headBeforeApply && headBeforeApply !== v.head_sha) {
      store.recordSuccessor({
        pr: v.pr,
        predecessor_round_id: round.id,
        head_sha: headBeforeApply,
        provenance: "system",
        reason: "verdict-observed-head-advance",
      });
    }
    if (round) store.finishRound(round.id, v.verdict, null, v.summary ?? null);
    // Executed-pass telemetry: persist what actually ran beside the
    // plan, and flag plan≠executed. Best-effort side channel — nothing in it
    // may disturb the verdict.
    if (round) await this.recordPassTelemetry(v, round);
    applyEvent(store, v.pr, { type: "verdict", verdict: v.verdict }, { head_sha: v.head_sha }, { botLogin: cfg.github.bot_login, now: () => this.now(), reason: `verdict:${v.verdict}` });
    store.logEvent("verdict_applied", v.pr, {
      file: name,
      round_id: round?.id ?? null,
      round_no: v.round_no,
      head_sha: v.head_sha,
      verdict: v.verdict,
      ai_approved: v.ai_approved ?? null,
    });
    // The reviewed-head mark: this head has now been reviewed and
    // decided. Read by the no-new-evidence guard at dispatch and at posting
    // time, and by the post-approval delta recheck.
    if (v.head_sha) store.recordReviewedHead(v.pr, { head_sha: v.head_sha, verdict: v.verdict, round_no: v.round_no });
    store.recoverReviewFailure(v.pr, "verdict-applied", { round_no: v.round_no, head_sha: v.head_sha });
    // The withheld-approval mark, session route. The session posted
    // its review as a COMMENT because CI was not green at this head; the mark
    // is what notices when CI goes green and re-queues the PR (cigate.ts).
    // Anything else clears it: the verdict here supersedes whatever earlier
    // round withheld an approval.
    if (v.head_sha && v.approval_withheld && v.verdict === "APPROVE") {
      // the mark carries the classifier verdict that caused the
      // withhold (red/pending/none). The session route cannot say which it
      // was, so the daemon re-reads the checks; an unreadable CI stores null
      // exactly as before — the mark itself never depends on the read.
      let ci: string | null = null;
      if (this.deps.adapter.listChecks) {
        try {
          ci = classifyCi(await this.deps.adapter.listChecks(v.head_sha));
        } catch (err) {
          this.log(`verdicts: checks read for withheld mark failed on #${v.pr}`, err);
        }
      }
      store.recordApprovalWithheld(v.pr, { head_sha: v.head_sha, reason: "red-ci", ci_state: ci });
      store.logEvent("approval_withheld_red_ci", v.pr, { head_sha: v.head_sha, source: "verdict", ci_state: ci });
    } else {
      store.clearApprovalWithheld(v.pr);
    }
    // Slack (S4), in-thread and never broadcast. duration_s is computed
    // inside finishRound, so it is read back off the row rather than recomputed.
    const finished = round ? store.roundsFor(v.pr).find((r) => r.id === round.id) : undefined;
    await this.announceSafe((a) =>
      a.verdict({
        pr: v.pr,
        round_no: v.round_no,
        verdict: v.verdict,
        summary: finished?.summary ?? v.summary ?? null,
        duration_s: finished?.duration_s ?? null,
      }),
    );
    // a head that advanced while this round ran was recorded as a
    // durable successor obligation before terminalization. An old-head verdict
    // can never erase it; a verdict covering the owed head settles it. Queue
    // publication and obligation retention are owned by StateStore.
    if (v.head_sha && headBeforeApply && headBeforeApply !== v.head_sha) {
      store.logEvent("mid_round_head_advance", v.pr, {
        round_no: v.round_no,
        reviewed_head: v.head_sha,
        current_head: headBeforeApply,
        verdict: v.verdict,
      });
    }
    if (v.head_sha) store.settleSuccessor(v.pr, v.head_sha);
    const successorPromoted = round ? store.promoteSuccessor(v.pr) : false;
    if (successorPromoted) {
      this.log(`verdicts: #${v.pr} preserved fresh-head successor after round ${v.round_no}`);
    }
    if (round) this.measureUsage(v.pr, round.id, round.started_at, this.now().toISOString());
    // Round is over: compact the sticky conversation. Cache re-reads of the
    // ever-growing prefix were 41% of measured cost; the continuity that
    // matters (SETTLED digest, ledger) survives compaction by design.
    await this.safe(() => this.deps.hooks.compactSession?.(v.pr) ?? Promise.resolve(), `compact pr-${v.pr}`);
    // Ledger freshness: AFTER compaction, so ledger-pin's mirror has
    // had its chance — and DELAYED, because compactSession only sends the
    // keystrokes: the pane is still compacting when apply continues, and a
    // nudge typed into that window is lost with the aborted turn (live
    // 2026-08-19, #5290 round 7: wake delivered to .done, never a turn).
    // Best-effort fire-and-forget — nothing here may disturb the verdict.
    //
    // The reasoning-record check rides the SAME settle window, for the
    // same reason: it may nudge, and a nudge typed into a compacting pane is
    // lost. It runs after the ledger check and is likewise fire-and-forget —
    // by the time either runs the verdict is applied, the round row is
    // finished and the PR has transitioned, so a record that never arrives
    // costs one anomaly row and one nudge and CANNOT hold the round open.
    const planned = round?.lenses ? round.lenses.split(",").filter(Boolean) : [];
    const roundId = round?.id ?? null;
    const tail = async (): Promise<void> => {
      await this.safe(() => this.checkLedger(v.pr, v.round_no, v.head_sha), `ledger check pr-${v.pr}`);
      await this.safe(
        () => this.checkFindingsRecord(v.pr, v.round_no, roundId, v.head_sha, planned),
        `findings record check pr-${v.pr}`,
      );
    };
    const settleMs = this.deps.ledgerCheckDelayMs ?? 90_000;
    if (settleMs <= 0) {
      await tail();
    } else {
      const timer = setTimeout(() => {
        void tail();
      }, settleMs);
      timer.unref?.();
    }
    // The round is over. Fresh-head review work wins the session command slot;
    // held conversational wakes stay behind it and flush at the successor's
    // terminal path. Without a successor, ordinary FIFO wake delivery resumes.
    if (!successorPromoted) await this.flushWakes(v.pr);
    this.log(`verdicts: #${v.pr} round ${v.round_no} → ${v.verdict}`);
    return "applied";
  }

  // ---- ledger freshness ---------------------------------------

  private ledgerPathFor(pr: number): string {
    const custom = this.deps.ledgerPathFor;
    if (custom) return custom(pr);
    const root = this.deps.root ?? sandboxRoot();
    return join(root, "state", "ledgers", `pr-${pr}.md`);
  }

  /** Enforce the end-of-round ledger rewrite: header must read
   * `LEDGER PR #<n> @ <head>`. Stale ⇒ anomaly + one capped re-nudge. */
  private async checkLedger(pr: number, roundNo: number, headSha: string): Promise<void> {
    if (!headSha) return;
    await enforceLedgerFreshness(
      {
        store: this.deps.store,
        ledgerPathFor: (n) => this.ledgerPathFor(n),
        inject: (n, message) => this.deps.hooks.inject(n, message),
        log: this.log.bind(this),
      },
      { pr, roundNo, headSha },
    );
  }

  // ---- the durable reasoning record ---------------------------

  /** Parse `state/findings/pr-<n>-round-<k>.json` into rows. Missing or
   * unparseable ⇒ anomaly + exactly ONE re-nudge, never a held-open round. */
  private async checkFindingsRecord(
    pr: number,
    roundNo: number,
    roundId: number | null,
    headSha: string,
    planned: readonly string[],
  ): Promise<void> {
    const findingsDir = this.deps.findingsDir;
    if (!findingsDir) return;
    await enforceFindingsRecord(
      {
        store: this.deps.store,
        findingsDir,
        inject: (n, message) => this.deps.hooks.inject(n, message),
        log: this.log.bind(this),
      },
      { pr, roundNo, roundId, headSha, planned },
    );
  }

  // ---- executed-pass telemetry --------------------------------

  /**
   * Persist the verdict's executed-pass report and compare it with the plan
   * (`rounds.lenses`). Missing telemetry ⇒ logged as UNKNOWN; plan≠executed ⇒
   * logged anomaly + overseer inject. NEVER blocks the verdict — everything
   * here is wrapped, and the verdict was already applied by the caller.
   */
  private async recordPassTelemetry(v: VerdictFile, round: RoundRow): Promise<void> {
    const { store } = this.deps;
    try {
      if (!v.passes) {
        // Old-prompt session (or the session reported nothing usable): the
        // record stays NULL = unknown, distinct from [] = "ran zero passes".
        store.logEvent("verdict_passes_unknown", v.pr, { round_id: round.id, round_no: v.round_no });
        this.log(`verdicts: #${v.pr} round ${v.round_no} executed passes unknown (no telemetry in verdict)`);
        return;
      }
      store.recordExecutedPasses(round.id, v.passes);
      const executed = v.passes.map((p) => p.name);
      const legacyPlanned = round.lenses ? round.lenses.split(",").filter(Boolean) : [];
      let planned = legacyPlanned;
      let missing: string[];
      let unknownAdditions: string[] = [];
      let missingReason: string[] = [];
      let wrongTier: string[] = [];
      let allowedAdditions: Array<{ name: string; tier: string | null; reason: string }> = [];

      if (round.pass_plan && round.addable_passes) {
        const plan = JSON.parse(round.pass_plan) as Array<{ lens: string; tier: string; raisable_to?: string[] }>;
        const addable = JSON.parse(round.addable_passes) as Array<{ lens: string; tier: string }>;
        planned = plan.map((p) => p.lens);
        missing = planned.filter((lens) => !executed.includes(lens));
        const byAddable = new Map(addable.map((p) => [p.lens, p]));
        const byPlan = new Map(plan.map((p) => [p.lens, p]));
        for (const pass of v.passes) {
          const plannedPass = byPlan.get(pass.name);
          if (plannedPass) {
            const tiers = [plannedPass.tier, ...(plannedPass.raisable_to ?? []).map((agent) => agent.split("--").at(-1)!)];
            if (!pass.tier || !tiers.includes(pass.tier)) wrongTier.push(pass.name);
            continue;
          }
          const policy = byAddable.get(pass.name);
          if (!policy) {
            unknownAdditions.push(pass.name);
            continue;
          }
          if (!pass.tier || pass.tier !== policy.tier) wrongTier.push(pass.name);
          if (!pass.reason) missingReason.push(pass.name);
          if (pass.tier === policy.tier && pass.reason) {
            allowedAdditions.push({ name: pass.name, tier: pass.tier, reason: pass.reason });
          }
        }
      } else {
        // In-flight/pre-migration rows retain's name-only behavior.
        missing = planned.filter((lens) => !executed.includes(lens));
        unknownAdditions = [...new Set(executed.filter((lens) => !planned.includes(lens)))];
      }

      if (allowedAdditions.length > 0) {
        store.logEvent("pass_plan_conformant_addition", v.pr, {
          round_id: round.id, round_no: v.round_no, additions: allowedAdditions,
        });
      }
      const violations = missing.length + unknownAdditions.length + missingReason.length + wrongTier.length;
      if (violations === 0) return;
      store.logEvent("pass_plan_mismatch", v.pr, {
        round_id: round.id, round_no: v.round_no, planned, executed, missing,
        added: unknownAdditions,
        unknown_additions: unknownAdditions, missing_reason: missingReason,
        wrong_tier: wrongTier, allowed_additions: allowedAdditions,
      });
      this.log(`verdicts: #${v.pr} round ${v.round_no} pass plan mismatch`, {
        planned, executed, missing, unknownAdditions, missingReason, wrongTier,
      });
      store.logAnomaly(
        "pass_plan_mismatch", v.pr, v.round_no,
        `pass policy violated` +
          `${missing.length ? `; missing ${missing.join(",")}` : ""}` +
          `${unknownAdditions.length ? `; unknown ${unknownAdditions.join(",")}` : ""}` +
          `${missingReason.length ? `; no reason ${missingReason.join(",")}` : ""}` +
          `${wrongTier.length ? `; wrong tier ${wrongTier.join(",")}` : ""}`,
        [
          `PASS-PLAN MISMATCH — PR #${v.pr} round ${v.round_no}`,
          `Planned: ${planned.join(", ") || "(none)"}`,
          `Executed: ${executed.join(", ") || "(none — solo/degraded round)"}`,
          ...(missing.length ? [`Missing planned passes: ${missing.join(", ")}`] : []),
          ...(unknownAdditions.length ? [`Not in the dispatched addable set: ${unknownAdditions.join(", ")}`] : []),
          ...(missingReason.length ? [`Allowed additions missing structured reason: ${missingReason.join(", ")}`] : []),
          ...(wrongTier.length ? [`Passes at a non-authorized tier: ${wrongTier.join(", ")}`] : []),
          "The verdict stands — this is telemetry, not a veto.",
        ].join("\n"),
      );
    } catch (err) {
      this.log(`verdicts: pass telemetry failed for #${v.pr}`, err);
    }
  }

  // ---- measured usage -----------------------------------------

  private sessionDirFor(pr: number): string {
    const custom = this.deps.usage?.sessionDirFor;
    if (custom) return custom(pr);
    const root = this.deps.root ?? sandboxRoot();
    return join(root, this.deps.cfg.pi.session_dir, `pr-${pr}`);
  }

  private globalStoreDir(): string | undefined {
    const configured = this.deps.usage?.globalStoreDir;
    if (configured === null) return undefined;
    // The subagent tool's isolated children skip --session-dir → pi HOME
    // global store (in-container /home/review/.pi/agent/sessions). Best-effort.
    return configured ?? join(homedir(), ".pi", "agent", "sessions");
  }

  /**
   * did git's configuration change while this round ran?
   *
   * The write veto in the bash guard reads command strings, and five write
   * primitives on the guard's own read-only allowlist go straight past it —
   * `T=.git/config; cat p >> $T` cannot EVER be seen by a token scan, because
   * the target is a variable. This check does not look at commands at all: the
   * fingerprint was taken when `dispatch` prepared the worktree, and any
   * difference now is a write the daemon did not make.
   *
   * Runs inside `measureUsage`, which is deliberately the one place that fires
   * on BOTH the verdict path and the anomaly/overdue path — a round that ends
   * badly is exactly when this most wants checking.
   *
   * Never throws and never fails a round: an unavailable fingerprint at either
   * end leaves the round unchecked, which is the legacy behaviour, and a
   * NULL baseline is never read as "changed" (the same rule the receipt scan
   * had to learn: unknown is not evidence of loss).
   */
  private checkGitConfigIntegrity(pr: number, roundId: number): void {
    const { cfg, store } = this.deps;
    try {
      const before = store.roundGitConfig(roundId) as GitConfigFingerprint | undefined;
      if (!before || typeof before.digest !== "string") return; // no baseline — never judged
      const root = this.deps.root ?? sandboxRoot();
      const after = fingerprintRoundGitConfig({
        clonePath: githubCloneDir(cfg.github),
        worktreePath: resolve(root, `wt/pr-${pr}`),
        piHome: join(root, "pihome"),
      });
      const changes = gitConfigChanges(before, after);
      if (changes.length === 0) return;
      store.logEvent("git_config_modified", pr, { round_id: roundId, changes });
      const message = gitConfigChangeMessage(pr, changes);
      store.logAnomaly("git_config_modified", pr, null, message, message);
      this.log(`verdicts: #${pr} GIT CONFIG CHANGED DURING THE ROUND`, changes);
    } catch (err) {
      this.log(`verdicts: #${pr} git-config integrity check unavailable`, err);
    }
  }

  /** Measure real token usage for the round window from the pi session JSONLs,
   * estimate USD from config pricing, and store both. Also the post-hoc
   * exec-policy audit. Best-effort: no failure here disturbs the verdict. */
  private measureUsage(pr: number, roundId: number, startedAt: string, finishedAt: string): void {
    const { cfg, store } = this.deps;
    try {
      const opts = {
        sessionDir: this.sessionDirFor(pr),
        globalStoreDir: this.globalStoreDir(),
        startedAt,
        finishedAt,
        ...(this.deps.usage?.fs ?? {}),
      };
      const usage = measureRoundUsage(opts);
      // pi's own per-record usage.cost.total is the primary source (verified
      // live on the VM); the config price table is only the fallback for
      // windows whose records carried no cost object.
      const pricing: Record<string, ModelPricing> = this.deps.usage?.pricing ?? cfg.models.pricing ?? {};
      const est = usage.cost_usd ?? estimateUsd(usage.models, pricing);
      store.recordRoundUsage(roundId, {
        tokens_in: usage.tokens_in,
        tokens_out: usage.tokens_out,
        tokens_cache_read: usage.tokens_cache_read,
        est_usd: est,
      });
      this.log(
        `verdicts: #${pr} round usage ${usage.tokens_in}in/${usage.tokens_out}out/${usage.tokens_cache_read}cache` +
          ` est=${est === null ? "unpriced" : `$${est.toFixed(2)}`}${usage.passes_included ? " (+passes)" : ""}`,
      );

      // classified, so the durable event says WHICH policy was
      // crossed. Until then the audit matched interpreters only, and none of
      // the four chains proved would have produced a single line here.
      this.checkGitConfigIntegrity(pr, roundId);

      const violations = auditExecViolationDetails(collectWindowLines(opts));
      if (violations.length > 0) {
        const commands = violations.map((v) => v.command);
        store.logEvent("exec_policy_violation", pr, { commands, violations });
        this.execViolations.set(pr, violations.map((v) => `${v.kind}: ${v.command}`));
        this.log(`verdicts: #${pr} exec-policy violations`, violations);
      }
    } catch (err) {
      this.log(`verdicts: usage measurement failed for #${pr}`, err);
    }
  }

  /** Malformed verdict or blown deadline: overseer anomaly, round marked, and
   * the PR returned to its standing-verdict state (the owner, 2026-08-19: no
   * park — the AI keeps driving). Never an approve path: "tracked" here means
   * "no work owed", not approved. */
  private async handleAnomaly(pr: number, roundNo: number | null, message: string, kind: "malformed" | "overdue"): Promise<void> {
    const { cfg, store, adapter } = this.deps;
    const round = this.runningRound(pr, roundNo ?? undefined);
    if (round && round.status === "running") {
      store.markRoundOverdue(round.id);
      // measure the round's tokens HERE, not only on the verdict path.
      // `measureUsage` had exactly one call site, so an overdue or malformed
      // round carried NULL cost forever and contributed exactly zero to every
      // aggregate that faithfully includes it — `markRoundOverdue` deliberately
      // keeps the row in spend ("hiding tokens this round really burned") and
      // the stranded-round operator message says "Its spend still counts."
      // Neither was true until this call existed. The window ends now, which is
      // the `finished_at` markRoundOverdue just stamped.
      this.measureUsage(pr, round.id, round.started_at, this.now().toISOString());
    }

    // The in-progress label must not stick, but the "Automatic Review" label is
    // deliberately NOT applied — no review was soundly produced.
    await this.safe(() => adapter.removeLabel(pr, cfg.github.in_progress_label), `remove ${cfg.github.in_progress_label} on #${pr}`);

    const standing = normalizeVerdict(store.reviewedHead(pr)?.verdict) ?? null;
    applyEvent(store, pr, { type: "round_overdue", standing }, {}, { botLogin: cfg.github.bot_login, now: () => this.now(), reason: `anomaly:${kind}` });
    const command = round ? store.sessionCommandForRound(pr, round.round_no) : undefined;
    const successor = store.successorFor(pr);
    const failure = store.openReviewFailure({
      pr,
      command_id: command?.id ?? null,
      round_id: round?.id ?? null,
      round_no: roundNo,
      head_sha: successor?.head_sha ?? store.getPr(pr)?.head_sha ?? "",
      stage: kind === "overdue" ? "round_deadline" : "malformed_verdict",
      detail: message,
      attempts: command?.attempt ?? 1,
      retry_cap: cfg.daemon.max_self_requeues ?? DEFAULT_MAX_SELF_REQUEUES,
    });
    store.logEvent(kind === "overdue" ? "round_overdue" : "verdict_malformed", pr, {
      round_id: round?.id ?? null,
      round_no: roundNo,
      message,
    });
    // Piggyback pending exec-policy findings on a wake that happens anyway;
    // violations by themselves never trigger an inject (no spam).
    const pendingViolations = this.execViolations.get(pr);
    this.execViolations.delete(pr);
    // The durable anomaly record — and,, the ONE wake
    // funnel: both kinds here are WAKE classes, so the store's sink writes the
    // overseer inject (dedup'd per kind+pr) from the message passed along.
    store.logAnomaly(
      kind,
      pr,
      roundNo,
      message,
      [
        `ANOMALY (${kind}) — PR #${pr}${roundNo !== null ? ` round ${roundNo}` : ""}`,
        message,
        `No review was produced: work remains owed as ${failure.incident_id} (never an approve). No reviewer was requested on GitHub.`,
        "Press u on the board to clear the FAILED_LOUD hold and rerun, or restart the session deliberately.",
        ...(pendingViolations && pendingViolations.length > 0
          ? [`Also: exec-policy violations were audited on this PR — ${pendingViolations.join(" · ")}`]
          : []),
      ].join("\n"),
    );
    await this.announceSafe((a) =>
      a.anomaly({ pr, round_no: roundNo, kind, deadline_min: cfg.daemon.round_deadline_min, incident_id: failure.incident_id }),
    );
    // FAILED_LOUD review debt owns the session ordering until an operator
    // presses u. Held conversation cannot overtake work that is still owed.
    this.log(`verdicts: anomaly (${kind}) on #${pr}`, message);
  }

  /**
   * Deadline-time recovery for a round whose prompt provably never arrived
   * (#5362): re-deliver the order and give the round a fresh deadline.
   *
   * The extension is what makes this a recovery rather than a formality — a
   * round already past its deadline would otherwise be re-judged on the very
   * next tick, before the session could possibly have finished. The clock is
   * reset from now, because the review has not started yet: none of the
   * elapsed time was spent reviewing.
   *
   * False ⇒ nothing was delivered (budget spent, or no saved prompt), and the
   * caller escalates.
   */
  private async recoverNeverDelivered(round: RoundRow): Promise<boolean> {
    const { cfg, store } = this.deps;
    const hooks = this.deps.hooks;
    const cap = cfg.daemon.max_prompt_redeliveries ?? DEFAULT_MAX_PROMPT_REDELIVERIES;
    if (!hooks.redeliverRound || round.redeliveries >= cap) return false;
    const attempt = store.countRedelivery(round.id);
    let redelivered = false;
    try {
      redelivered = await hooks.redeliverRound.call(hooks, round.pr, round.round_no);
    } catch (err) {
      this.log(`verdicts: #${round.pr} round ${round.round_no} deadline redelivery failed`, err);
      return false;
    }
    if (!redelivered) return false;
    store.extendRoundDeadline(round.id, cfg.daemon.round_deadline_min);
    store.clearRoundSilent(round.id);
    store.logEvent("round_prompt_redelivered", round.pr, {
      round_id: round.id,
      round_no: round.round_no,
      attempt,
      cap,
      at: "deadline",
      deadline_extended_min: cfg.daemon.round_deadline_min,
    });
    this.log(
      `verdicts: REDELIVER (deadline) #${round.pr} round ${round.round_no} attempt ${attempt}/${cap} — the session was alive and idle because the order never arrived; nothing cancelled, nothing killed`,
    );
    return true;
  }

  /**
   * Deliver wakes that are held with no round left to flush them (#5362 W3).
   *
   * `flushWakes` runs from exactly two places — a verdict landing and the
   * anomaly path — on the assumption that every round ends through one of
   * them. Three cancellations do not: `superseded`, a startup orphan that is
   * NOT requeued (the requeue needs `state === "reviewing"` and no later
   * round), and a self-requeue whose successor is cancelled the same way. The
   * wakes held while such a round was in flight — author replies included —
   * then sit in `pending_wakes` with nothing to flush them, and that table has
   * no expiry.
   *
   * A PR holding wakes with no round running is unambiguous: the reason to
   * hold is gone, so deliver. Runs on the deadline tick, which is already the
   * daemon's "is anything stuck?" sweep.
   */
  private async flushStrandedWakes(): Promise<void> {
    const { store } = this.deps;
    for (const pr of store.prsWithStrandedWakes()) {
      if (store.getPr(pr)?.state === "closed") {
        // The session is archived — there is nothing to wake. Drop them rather
        // than leave rows nothing will ever read.
        const dropped = store.dropHeldWakes(pr);
        if (dropped > 0) store.logEvent("wakes_dropped_closed", pr, { dropped });
        continue;
      }
      store.logEvent("wakes_stranded", pr, { held: store.heldWakes(pr).length });
      this.log(`verdicts: #${pr} held wakes with no round running — flushing`);
      await this.flushWakes(pr);
    }
  }

  /** Deliver the wakes held while this PR's round was in flight (S4). */
  private async flushWakes(pr: number): Promise<void> {
    await this.safe(
      () =>
        flushHeldWakes(
          { store: this.deps.store, inject: (n, message) => this.deps.hooks.inject(n, message), log: this.log.bind(this) },
          pr,
        ),
      `flush held wakes on #${pr}`,
    );
  }

  /**
   * Stuck-round triage: is this overdue round one the daemon should
   * requeue itself? "Stuck" is overdue (the caller already established that)
   * AND session dead AND no verdict file on disk.
   * - no `sessionAlive` hook, a hook error, or a live session ⇒ `not_stuck`:
   *   the legacy anomaly park stands (a live-but-slow session is a
   *   judgment call for a human, not a respawn).
   * - session dead but the round's verdict file is sitting unconsumed ⇒
   *   `verdict_pending`: the sweep will consume it — neither a requeue nor an
   *   anomaly may race a real verdict (the restart-orphan/self-requeue
   *   idempotency hinges on never double-owning a round that already decided).
   */
  private async stuckDisposition(
    round: RoundRow,
  ): Promise<"not_stuck" | "verdict_pending" | "dead" | "alive_stuck" | "never_delivered"> {
    const alive = this.deps.hooks.sessionAlive;
    if (!alive) return "not_stuck";
    let dead: boolean;
    try {
      dead = !(await alive.call(this.deps.hooks, round.pr));
    } catch {
      return "not_stuck";
    }
    if (existsSync(join(this.deps.verdictDir, `pr-${round.pr}-round-${round.round_no}.json`))) return "verdict_pending";
    if (dead) return "dead";
    // A LIVE session that never received the order is not wedged — it is idle,
    // waiting for work that was thrown away in transit (#5362, where the
    // session sat at "I'm ready to finish once the daemon dispatches the fresh
    // review round" for the whole deadline). Killing it destroys a healthy
    // conversation to fix a file that failed to arrive, so the receipt is
    // checked BEFORE `alive_stuck` is concluded.
    if (round.prompt_marker && this.deps.hooks.roundPromptAccepted) {
      try {
        const startedMs = Date.parse(round.started_at);
        const accepted = Number.isFinite(startedMs)
          ? await this.deps.hooks.roundPromptAccepted.call(this.deps.hooks, round.pr, round.round_no, startedMs)
          : null;
        if (accepted === false) return "never_delivered";
      } catch {
        // Unreadable evidence falls through to the pre-existing judgement.
      }
    }
    // Live but past the deadline with nothing on disk (2026-08-19, the owner:
    // recover, don't park): the session is killed and the round requeued
    // through the same capped path. Without a kill hook the pre-existing park
    // stands — never inject a fresh round into a wedged live session.
    return this.deps.hooks.killSession ? "alive_stuck" : "not_stuck";
  }

  /**: feed command-stage infrastructure failures into the SAME
   * capped cancellation→queue lifecycle as overdue/dead rounds. There is no
   * merits verdict and no GitHub mutation. A transient inability to stop an
   * active session is retryable; budget exhaustion is distinct durable fact. */
  async recoverInfrastructureFailure(
    pr: number,
    roundNo: number,
    stage:
      | "command_start"
      | "first_pass_start"
      | "passes_incomplete"
      | "parent_finalize"
      | "settled_without_verdict"
      | "running_hard_bound",
    detail: string,
  ): Promise<RoundRecoveryDisposition> {
    const round = this.runningRound(pr, roundNo);
    if (!round || round.status !== "running") return "requeued";
    if (stage === "settled_without_verdict" && round.posting_key) {
      const proof = await this.postingProof(round);
      if (proof.kind === "waiting") return "retryable";
      if (proof.kind === "confirmed") {
        await this.failPostingProof(
          round,
          `GitHub review ${proof.receipt?.gh_review_id ?? "confirmed"} was posted but the session settled before writing its verdict`,
          "posted_without_verdict",
        );
        return "failed_loud";
      }
      if (proof.kind === "failed") {
        await this.failPostingProof(round, proof.detail ?? "settled without a posting receipt");
        return "failed_loud";
      }
    }
    this.deps.store.logEvent("round_infrastructure_failure", pr, {
      round_id: round.id,
      round_no: roundNo,
      stage,
      detail,
    });
    const head = this.deps.store.getPr(pr)?.head_sha ?? "";
    const cap = this.deps.cfg.daemon.max_self_requeues ?? DEFAULT_MAX_SELF_REQUEUES;
    if (this.deps.store.selfRequeueCount(pr, head) >= cap) {
      const recovered = await this.selfRequeue(
        round,
        stage === "settled_without_verdict" ? "infrastructure_settled" : "infrastructure_active",
      );
      if (recovered) return "requeued";
      if (this.runningRound(pr, roundNo)?.status === "running") return "retryable";
      const command = this.deps.store.sessionCommandForRound(pr, roundNo);
      const successor = this.deps.store.successorFor(pr);
      const failure = this.deps.store.openReviewFailure({
        pr,
        command_id: command?.id ?? null,
        round_id: round.id,
        round_no: roundNo,
        head_sha: successor?.head_sha ?? this.deps.store.getPr(pr)?.head_sha ?? head,
        stage,
        detail,
        attempts: cap,
        retry_cap: cap,
      });
      this.deps.store.logAnomaly(
        "review_failed_loud",
        pr,
        roundNo,
        `${stage}: ${detail}; work remains owed as ${failure.incident_id}; press u to recover`,
      );
      await this.announceSafe((a) =>
        a.anomaly({ pr, round_no: roundNo, kind: "failed_loud", deadline_min: this.deps.cfg.daemon.round_deadline_min, incident_id: failure.incident_id }),
      );
      return "exhausted";
    }
    if (stage !== "settled_without_verdict" && !this.deps.hooks.killSession) return "retryable";
    const recovered = await this.selfRequeue(
      round,
      stage === "settled_without_verdict" ? "infrastructure_settled" : "infrastructure_active",
    );
    return recovered ? "requeued" : "retryable";
  }

  /**
   * Self-requeue a stuck round. Returns true when the round was
   * handled here (cancelled + PR re-queued for a fresh dispatch through the
   * NORMAL pump — same move as the overseer's rerun-round and the startup
   * orphan requeue); false when the per-head cap is exhausted and the caller
   * must terminalize through the anomaly park instead.
   *
   * Session-side only by construction: no label, no review, no gate call —
   * dry-run and live behave identically. The cancelled round keeps a NULL
   * verdict, so `priorRoundCount`/review_no never age (a failed round must
   * not age the PR). Held wakes stay held: the requeued round is about to
   * dispatch, and its own round-end paths flush them (S4).
   */
  private async selfRequeue(round: RoundRow, mode: SelfRequeueMode = "dead"): Promise<boolean> {
    const { store, cfg } = this.deps;
    const row = store.getPr(round.pr);
    const head = row?.head_sha ?? "";
    const cap = cfg.daemon.max_self_requeues ?? DEFAULT_MAX_SELF_REQUEUES;
    const attempt = store.selfRequeueCount(round.pr, head) + 1;
    const exhausted = attempt > cap;
    const infrastructure = mode === "infrastructure_active" || mode === "infrastructure_settled";
    if (exhausted && !infrastructure) {
      store.logEvent("self_requeue_cap_exhausted", round.pr, {
        round_id: round.id,
        round_no: round.round_no,
        head_sha: head,
        attempts: attempt - 1,
        cap,
        mode,
      });
      return false;
    }
    const reason =
      mode === "dead"
        ? `round ${round.round_no} passed its deadline (${round.deadline_at}) with no verdict and its session is dead`
        : mode === "alive_stuck"
          ? `round ${round.round_no} passed its deadline (${round.deadline_at}) with no verdict; its session was alive but wedged and has been killed for a fresh rebirth`
          : mode === "lost_prompt"
            ? `round ${round.round_no}'s prompt was consumed from the inject dir but the session shows no activity since the round started (${round.started_at}) — the prompt was dropped in delivery; redispatching`
            : mode === "head_moved"
              ? `round ${round.round_no} ended head_moved (guard 5): the PR advanced mid-round and the session correctly posted nothing — redispatching against the fresh head; the session is healthy and was not killed`
              : mode === "infrastructure_active" || mode === "infrastructure_settled"
                ? `round ${round.round_no} failed a bounded daemon→Pi infrastructure stage before any merits verdict — redispatching through the ordinary pump`
                : `round ${round.round_no} verdicted NEEDS_HUMAN without executing any passes — the review was not done, so it is redone rather than handed to a person`;
    if (mode === "infrastructure_active" && !this.deps.hooks.killSession) {
      store.logEvent("session_recovery_kill_unavailable", round.pr, { round_id: round.id, round_no: round.round_no, mode });
      return false;
    }
    if ((mode === "alive_stuck" || mode === "infrastructure_active") && this.deps.hooks.killSession) {
      try {
        await this.deps.hooks.killSession.call(this.deps.hooks, round.pr);
      } catch (error) {
        store.logEvent("session_recovery_kill_failed", round.pr, { round_id: round.id, round_no: round.round_no, mode, error: String(error) });
        this.log(`verdicts: refusing ${mode} requeue for #${round.pr}; old session could not be stopped`, error);
        return false;
      }
    }
    if (infrastructure) {
      // For active failures the strict kill above makes this check definitive:
      // no new verdict can appear after the session is gone. For a settled
      // parent, all writes are already over. A verdict that won this race is
      // left to the 10s sweep, never cancelled/quarantined here.
      if (existsSync(join(this.deps.verdictDir, `pr-${round.pr}-round-${round.round_no}.json`))) {
        store.logEvent("round_stage_verdict_won", round.pr, { round_id: round.id, round_no: round.round_no, mode });
        return false;
      }
      if (this.runningRound(round.pr, round.round_no)?.status !== "running") return true;
    }
    const cause = SELF_REQUEUE_CAUSE[mode];
    if (exhausted) {
      store.logEvent("self_requeue_cap_exhausted", round.pr, {
        round_id: round.id,
        round_no: round.round_no,
        head_sha: head,
        attempts: attempt - 1,
        cap,
        mode,
      });
      // Capacity must not remain consumed by work whose bounded recovery is
      // over. promotes this durable cancellation+failed command into
      // canonical FAILED_LOUD operator state; no quiet tracked transition and
      // no automatic successor is created here.
      store.markRoundCancelled(
        round.id,
        `infrastructure recovery exhausted after ${cap} self-requeue(s) — ${reason}`,
        "infrastructure_failure",
      );
      this.measureUsage(round.pr, round.id, round.started_at, this.now().toISOString());
      store.logEvent("round_infrastructure_recovery_exhausted", round.pr, {
        round_id: round.id,
        round_no: round.round_no,
        head_sha: head,
        attempts: cap,
        mode,
      });
      return false;
    }
    store.markRoundCancelled(round.id, `self-requeue ${attempt}/${cap} — ${reason}`, cause);
    // a cancelled round burned real tokens and stays in every spend
    // aggregate (`SUM(est_usd) FROM rounds` has no status filter), so it must be
    // measured before its successor starts. The window ends here and the
    // successor's begins later, so the two never overlap.
    this.measureUsage(round.pr, round.id, round.started_at, this.now().toISOString());
    if (isLoudCancelCause(cause)) {
      // the durable twin of the inject below. A round that stopped
      // dead inside its deadline window is the residual real defect
      // isolated (17 of 55 cancellations) — the redeploy orphan sweep, which
      // is 70% of the volume, writes NOTHING here. `round_stopped_dead` is
      // deliberately absent from anomalies.ts WAKE_KINDS: the bespoke
      // SELF-REQUEUE inject a few lines down IS this record's wake, and
      // listing it there would inject the same event twice.
      store.logAnomaly(
        "round_stopped_dead",
        round.pr,
        round.round_no,
        `round ${round.round_no} stopped dead inside its deadline window (${round.started_at} → ${round.deadline_at}) and was cancelled; self-requeue attempt ${attempt}/${cap}`,
      );
    }
    store.logEvent("round_self_requeued", round.pr, {
      cancel_cause: cause,
      round_id: round.id,
      round_no: round.round_no,
      head_sha: head,
      attempt,
      cap,
      mode,
      reason,
    });
    // Requeue through the normal dispatch path. A durable newer-head
    // obligation wins; otherwise redo the failed head. The old round is
    // terminal before either queue publication, so two rounds never coexist.
    const successorPromoted = store.promoteSuccessor(round.pr);
    if (!successorPromoted && row && row.state === "reviewing") {
      store.upsertPr({ ...row, state: "queued", trigger_ts: this.now().toISOString() });
    }
    this.log(`verdicts: SELF-REQUEUE #${round.pr} round ${round.round_no} attempt ${attempt}/${cap} — ${reason}`);
    await this.safe(
      () =>
        this.deps.hooks.injectOverseer(
          [
            `SELF-REQUEUE (recovery) — PR #${round.pr} round ${round.round_no}, attempt ${attempt}/${cap}`,
            reason,
            "The daemon cancelled the dead round and re-queued the PR for a fresh dispatch through the normal path; the session is reborn at dispatch. No GitHub state was touched.",
            "This is a recovery path, not a normal one — if it recurs on the same PR, investigate why its sessions die mid-round.",
          ].join("\n"),
        ),
      "inject overseer self-requeue",
    );
    return true;
  }

  /**
   * Recover a round whose prompt never reached its session (rebuilt
   * around a receipt after #5362).
   *
   * The original net inferred loss from a JSONL mtime and fired ZERO times in
   * the eight days it was live, for two independent reasons:
   *   - it refused to act once the head had spent a self-requeue, and a
   *     `head_moved` requeue spends one FOUR SECONDS before dispatching the
   *     round most likely to be lost;
   *   - it required "no activity since the round started" — but a prompt is
   *     dropped precisely BECAUSE the agent is busy, and a busy agent always
   *     has activity after round start. The net was blind to its own case.
   *
   * Both are gone. `roundPromptAccepted` is a FACT (the dispatched receipt
   * token, echoed into the session JSONL only when pi accepted the message),
   * so no budget-based guessing is needed to keep it honest: `false` means the
   * prompt is not there.
   *
   * Recovery is cheap first. A missing prompt is a DELIVERY fault, so the
   * remedy is to deliver it again — same round, same session, same
   * conversation — and only a redelivery that also fails to land escalates to
   * the expensive path (a cancelled round, and for a live session a kill).
   * Killing a healthy session because a file did not arrive was the old
   * behaviour and cost four live conversations.
   */
  private async maybeRequeueLostPrompt(round: RoundRow, nowMs: number): Promise<void> {
    const { cfg, store } = this.deps;
    const hooks = this.deps.hooks;
    if (!hooks.roundPromptAccepted || !hooks.injectPending || !hooks.sessionAlive) return;
    // A round dispatched before receipts existed carries no marker, so its
    // delivery is unknowable — never guess at it.
    if (!round.prompt_marker) return;
    const graceMs = (cfg.daemon.round_stall_grace_min ?? DEFAULT_ROUND_STALL_GRACE_MIN) * 60_000;
    const startedMs = Date.parse(round.started_at);
    if (!Number.isFinite(startedMs) || nowMs - startedMs < graceMs) return;
    if (store.hasLaterRound(round.pr, round.round_no)) return; // superseded — the deadline sweep owns that case
    if (existsSync(join(this.deps.verdictDir, `pr-${round.pr}-round-${round.round_no}.json`))) return;
    const clearSilent = (): void => {
      if (round.silent_since) store.clearRoundSilent(round.id);
    };
    try {
      if (await hooks.injectPending.call(hooks, round.pr)) {
        clearSilent(); // bridge still holding/retrying — patience, not loss
        return;
      }
      const accepted = await hooks.roundPromptAccepted.call(hooks, round.pr, round.round_no, startedMs);
      if (accepted !== false) {
        // true = delivered and the session owns it; null = no evidence either
        // way. Neither is loss.
        clearSilent();
        return;
      }
    } catch {
      clearSilent(); // an unreadable signal is not evidence
      return;
    }
    // Two consecutive observations before acting. The receipt is a fact, but
    // the WINDOW around it is not: a prompt delivered a moment ago may not yet
    // be flushed to the JSONL, and re-sending a round the session has already
    // started is worse than waiting one more tick.
    if (!round.silent_since) {
      store.markRoundSilent(round.id);
      this.log(
        `verdicts: #${round.pr} round ${round.round_no} shows no prompt receipt — marked; recovering on the next sweep if it is still missing`,
      );
      return;
    }
    store.logEvent("round_prompt_lost", round.pr, {
      round_id: round.id,
      round_no: round.round_no,
      started_at: round.started_at,
      silent_since: round.silent_since,
      redeliveries: round.redeliveries,
    });
    // ---- cheap recovery first: deliver the same order again ----------------
    const cap = cfg.daemon.max_prompt_redeliveries ?? DEFAULT_MAX_PROMPT_REDELIVERIES;
    if (hooks.redeliverRound && round.redeliveries < cap) {
      const attempt = store.countRedelivery(round.id);
      let redelivered = false;
      try {
        redelivered = await hooks.redeliverRound.call(hooks, round.pr, round.round_no);
      } catch (err) {
        this.log(`verdicts: #${round.pr} round ${round.round_no} redelivery failed`, err);
      }
      if (redelivered) {
        // A fresh window: the mark must be re-earned before the next escalation.
        store.clearRoundSilent(round.id);
        store.logEvent("round_prompt_redelivered", round.pr, {
          round_id: round.id,
          round_no: round.round_no,
          attempt,
          cap,
        });
        this.log(
          `verdicts: REDELIVER #${round.pr} round ${round.round_no} attempt ${attempt}/${cap} — the prompt never reached the session; same round, same session, nothing cancelled`,
        );
        return;
      }
      this.log(`verdicts: #${round.pr} round ${round.round_no} has no saved prompt to redeliver — escalating`);
    }
    // ---- redelivery is spent or impossible: the expensive path -------------
    await this.selfRequeue(round, "lost_prompt");
  }

  /** Deadline sweep — a running round past `deadline_at` is an anomaly.
   * A superseded round (a newer round exists on the same PR) is cancelled
   * silently instead: its PR state, labels and reviewer requests belong to
   * the newer round, and yanking them here corrupted live reviews.
   * an overdue round with no verdict whose session is DEAD is
   * self-requeued (capped per head) instead of parked — a stuck round no
   * longer waits for a deploy restart. */
  async checkDeadlines(): Promise<number[]> {
    const overdue: number[] = [];
    const nowMs = this.now().getTime();
    const { store } = this.deps;
    await this.flushStrandedWakes();
    for (const round of store.runningRounds()) {
      if (Date.parse(round.deadline_at) > nowMs) {
        // lost-prompt net, well before the deadline: the round's
        // inject was consumed (nothing pending, so the bridge is not merely
        // retrying), no verdict is on disk, and the session's newest JSONL
        // predates the round — the prompt never became a turn. Requeued
        // through the SAME capped path, at most once per head here
        // (deadline-time recovery keeps the rest of the budget). Sessions
        // that were mid-recheck when the round arrived stay covered by the
        // deadline path: their JSONL moved after round start, and guessing
        // on an ambiguous signal would cancel live rounds.
        await this.maybeRequeueLostPrompt(round, nowMs);
        continue;
      }
      if (store.hasLaterRound(round.pr, round.round_no)) {
        store.markRoundCancelled(round.id, `superseded — round ${round.round_no} outlived by a newer round`, "superseded");
        store.logEvent("round_superseded", round.pr, { round_id: round.id, round_no: round.round_no });
        // Slack: "read the newest one" — no existing review is touched, ever
        // (CLAUDE.md hard rule 2); the wording invariant lives in messages.ts.
        const newest = store.roundsFor(round.pr).reduce((a, b) => (b.round_no > a.round_no ? b : a), round);
        await this.announceSafe((a) =>
          a.superseded({
            pr: round.pr,
            old_round_no: round.round_no,
            new_round_no: newest.round_no,
            head_sha: store.getPr(round.pr)?.head_sha ?? "",
          }),
        );
        this.log(`verdicts: #${round.pr} round ${round.round_no} cancelled (superseded)`);
        continue;
      }
      if (round.posting_key && !existsSync(join(this.deps.verdictDir, `pr-${round.pr}-round-${round.round_no}.json`))) {
        const proof = await this.postingProof(round);
        if (proof.kind === "waiting") continue;
        if (proof.kind === "confirmed") {
          await this.failPostingProof(
            round,
            `GitHub review ${proof.receipt?.gh_review_id ?? "confirmed"} was posted but no verdict file arrived before the round deadline`,
            "posted_without_verdict",
          );
          continue;
        }
        if (proof.kind === "failed") {
          await this.failPostingProof(round, proof.detail ?? "round ended without posting confirmation");
          continue;
        }
      }
      const stuck = await this.stuckDisposition(round);
      if (stuck === "verdict_pending") {
        // A real verdict is on disk — the sweep consumes it; do nothing here.
        this.log(`verdicts: #${round.pr} round ${round.round_no} overdue but its verdict file is pending — leaving it to the sweep`);
        continue;
      }
      // A live session that provably never got the order: deliver it again
      // rather than kill a healthy conversation (#5362). Only when redelivery
      // is spent or impossible does this fall through to the expensive path.
      if (stuck === "never_delivered" && (await this.recoverNeverDelivered(round))) continue;
      const expensive = stuck === "dead" || stuck === "alive_stuck" || stuck === "never_delivered";
      if (expensive && (await this.selfRequeue(round, stuck === "never_delivered" ? "lost_prompt" : stuck))) continue;
      overdue.push(round.pr);
      await this.handleAnomaly(
        round.pr,
        round.round_no,
        `round ${round.round_no} passed its deadline (${round.deadline_at}); started ${round.started_at}` +
          (expensive ? " — the self-requeue cap is exhausted; parking" : ""),
        "overdue",
      );
    }
    return overdue;
  }

  /** Slack is a side channel: absent announcer ⇒ nothing happens, and a Slack
   * failure is logged, never propagated into the verdict path. */
  private async announceSafe(fn: (a: VerdictAnnouncer) => Promise<void>): Promise<void> {
    const announcer = this.deps.announce;
    if (!announcer) return;
    try {
      await fn(announcer);
    } catch (err) {
      this.log("verdicts: slack announcement failed", err);
    }
  }

  private async safe<T>(fn: () => Promise<T>, what: string): Promise<T | undefined> {
    try {
      return await fn();
    } catch (err) {
      this.log(`verdicts: ${what} failed`, err);
      this.deps.store.logEvent("verdict_action_failed", null, { what, error: String(err) });
      return undefined;
    }
  }
}
