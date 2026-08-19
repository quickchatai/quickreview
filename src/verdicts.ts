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
import { join } from "node:path";
import { classifyCi, type CheckSummary } from "./cigate.js";
import { DEFAULT_MAX_SELF_REQUEUES, sandboxRoot, type Config } from "./config.js";
import { auditExecViolations, collectWindowLines, estimateUsd, measureRoundUsage, type ModelPricing, type UsageFs } from "./usage.js";
import type { GateResult } from "./gate.js";
import { applyEvent } from "./statemachine.js";
import type { VerdictAnnouncer } from "./slack/announce.js";
import type { RoundRow, StateStore } from "./state.js";
import { normalizeVerdict, type SessionHooks, type VerdictFile } from "./types.js";
import { flushHeldWakes } from "./wakes.js";

export interface VerdictAdapter {
  addLabel(n: number, label: string): Promise<GateResult>;
  removeLabel(n: number, label: string): Promise<GateResult>;
  /** Checks at a head (read-only, cigate's classifier input). Optional: with
   * it, a session-route withheld approval records WHICH CI state caused the
   * withhold; without it the mark stores null, as it always did. */
  listChecks?(ref: string): Promise<CheckSummary[]>;
}

export interface VerdictDeps {
  cfg: Config;
  store: StateStore;
  adapter: VerdictAdapter;
  hooks: SessionHooks;
  /** Directory the sessions write into (sandbox `verdict/`). */
  verdictDir: string;
  /** Slack announcer (S4). Optional: absent ⇒ no Slack, exactly as
   * every existing caller and test sees it. Never allowed to throw in here. */
  announce?: VerdictAnnouncer;
  /** Sandbox root — anchors the default pi-session dir. */
  root?: string;
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
  return { ok: true, verdict: raw as unknown as VerdictFile };
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
      await this.apply(parsed.verdict, name);
      this.archive(name);
      return true;
    } finally {
      this.inFlight.delete(name);
    }
  }

  /** The handoff: labels, round record, transition. */
  private async apply(v: VerdictFile, name: string): Promise<void> {
    const { cfg, store, adapter } = this.deps;
    const round = this.runningRound(v.pr, v.round_no);

    await this.safe(() => adapter.removeLabel(v.pr, cfg.github.in_progress_label), `remove ${cfg.github.in_progress_label} on #${v.pr}`);
    await this.safe(() => adapter.addLabel(v.pr, cfg.github.reviewed_label), `add ${cfg.github.reviewed_label} on #${v.pr}`);

    // spend_usd from the file is fiction (template echo) — never stored; the
    // measured figures land via recordRoundUsage below.
    if (round) store.finishRound(round.id, v.verdict, null, v.summary ?? null);
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
    if (round) this.measureUsage(v.pr, round.id, round.started_at, this.now().toISOString());
    // Round is over: compact the sticky conversation. Cache re-reads of the
    // ever-growing prefix were 41% of measured cost; the continuity that
    // matters (SETTLED digest, ledger) survives compaction by design.
    await this.safe(() => this.deps.hooks.compactSession?.(v.pr) ?? Promise.resolve(), `compact pr-${v.pr}`);
    // The round is over, so the PR's one main pi is free again (S4): deliver
    // whatever arrived while it was busy, in arrival order.
    await this.flushWakes(v.pr);
    this.log(`verdicts: #${v.pr} round ${v.round_no} → ${v.verdict}`);
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
    // pi-subagents' isolated children skip --session-dir → pi HOME global
    // store (in-container /home/review/.pi/agent/sessions). Best-effort.
    return configured ?? join(homedir(), ".pi", "agent", "sessions");
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

      const violations = auditExecViolations(collectWindowLines(opts));
      if (violations.length > 0) {
        store.logEvent("exec_policy_violation", pr, { commands: violations });
        this.execViolations.set(pr, violations);
        this.log(`verdicts: #${pr} exec-policy violations`, violations);
      }
    } catch (err) {
      this.log(`verdicts: usage measurement failed for #${pr}`, err);
    }
  }

  /** Malformed verdict or blown deadline: overseer anomaly, round marked, and
   * the PR parked on awaiting_human. Never an approve path. */
  private async handleAnomaly(pr: number, roundNo: number | null, message: string, kind: "malformed" | "overdue"): Promise<void> {
    const { cfg, store, adapter, hooks } = this.deps;
    const round = this.runningRound(pr, roundNo ?? undefined);
    if (round && round.status === "running") store.markRoundOverdue(round.id);

    // The in-progress label must not stick, but the "Automatic Review" label is
    // deliberately NOT applied — no review was soundly produced.
    await this.safe(() => adapter.removeLabel(pr, cfg.github.in_progress_label), `remove ${cfg.github.in_progress_label} on #${pr}`);

    applyEvent(store, pr, { type: "round_overdue" }, {}, { botLogin: cfg.github.bot_login, now: () => this.now(), reason: `anomaly:${kind}` });
    store.logEvent(kind === "overdue" ? "round_overdue" : "verdict_malformed", pr, {
      round_id: round?.id ?? null,
      round_no: roundNo,
      message,
    });
    // The durable anomaly record: the inject below is the wake, this
    // row is the queryable audit trail. One per anomaly, alongside the wake.
    store.logAnomaly(kind, pr, roundNo, message);
    // Piggyback pending exec-policy findings on an inject that happens anyway;
    // violations by themselves never trigger an inject (no spam).
    await this.announceSafe((a) =>
      a.anomaly({ pr, round_no: roundNo, kind, deadline_min: cfg.daemon.round_deadline_min }),
    );
    const pendingViolations = this.execViolations.get(pr);
    this.execViolations.delete(pr);
    await this.safe(
      () =>
        hooks.injectOverseer(
          [
            `ANOMALY (${kind}) — PR #${pr}${roundNo !== null ? ` round ${roundNo}` : ""}`,
            message,
            "Treated as NEEDS_HUMAN / no-approve: the in-progress label was cleared and the PR is parked on awaiting_human. No reviewer was requested on GitHub — parking is daemon-side only.",
            "Investigate the session and decide whether to rerun the round (commands/rerun-round) or restart the session.",
            ...(pendingViolations && pendingViolations.length > 0
              ? [`Also: exec-policy violations were audited on this PR — ${pendingViolations.join(" · ")}`]
              : []),
          ].join("\n"),
        ),
      "inject overseer anomaly",
    );
    // The round is abandoned, not running: an author reply held behind it must
    // not be stranded (S4). The session may be wedged — flushHeldWakes logs a
    // failed delivery per wake rather than throwing here.
    await this.flushWakes(pr);
    this.log(`verdicts: anomaly (${kind}) on #${pr}`, message);
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
  private async stuckDisposition(round: RoundRow): Promise<"not_stuck" | "verdict_pending" | "dead"> {
    const alive = this.deps.hooks.sessionAlive;
    if (!alive) return "not_stuck";
    let dead: boolean;
    try {
      dead = !(await alive.call(this.deps.hooks, round.pr));
    } catch {
      return "not_stuck";
    }
    if (!dead) return "not_stuck";
    if (existsSync(join(this.deps.verdictDir, `pr-${round.pr}-round-${round.round_no}.json`))) return "verdict_pending";
    return "dead";
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
  private async selfRequeue(round: RoundRow): Promise<boolean> {
    const { store, cfg } = this.deps;
    const row = store.getPr(round.pr);
    const head = row?.head_sha ?? "";
    const cap = cfg.daemon.max_self_requeues ?? DEFAULT_MAX_SELF_REQUEUES;
    const attempt = store.selfRequeueCount(round.pr, head) + 1;
    if (attempt > cap) {
      store.logEvent("self_requeue_cap_exhausted", round.pr, {
        round_id: round.id,
        round_no: round.round_no,
        head_sha: head,
        attempts: attempt - 1,
        cap,
      });
      return false;
    }
    const reason = `round ${round.round_no} passed its deadline (${round.deadline_at}) with no verdict and its session is dead`;
    store.markRoundCancelled(round.id, `self-requeue ${attempt}/${cap} — ${reason}`);
    store.logEvent("round_self_requeued", round.pr, {
      round_id: round.id,
      round_no: round.round_no,
      head_sha: head,
      attempt,
      cap,
      reason,
    });
    // Requeue through the normal dispatch path: back to queued with a fresh
    // trigger_ts; the pump re-dispatches and dispatchRound rebirths the dead
    // session. Never a parallel session, never a mid-round instruction.
    if (row && row.state === "reviewing") {
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
    for (const round of store.runningRounds()) {
      if (Date.parse(round.deadline_at) > nowMs) continue;
      if (store.hasLaterRound(round.pr, round.round_no)) {
        store.markRoundCancelled(round.id, `superseded — round ${round.round_no} outlived by a newer round`);
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
      const stuck = await this.stuckDisposition(round);
      if (stuck === "verdict_pending") {
        // A real verdict is on disk — the sweep consumes it; do nothing here.
        this.log(`verdicts: #${round.pr} round ${round.round_no} overdue but its verdict file is pending — leaving it to the sweep`);
        continue;
      }
      if (stuck === "dead" && (await this.selfRequeue(round))) continue;
      overdue.push(round.pr);
      await this.handleAnomaly(
        round.pr,
        round.round_no,
        `round ${round.round_no} passed its deadline (${round.deadline_at}); started ${round.started_at}` +
          (stuck === "dead" ? " — session dead and the self-requeue cap is exhausted; parking" : ""),
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
