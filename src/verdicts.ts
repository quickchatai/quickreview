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
import { DEFAULT_MAX_SELF_REQUEUES, DEFAULT_ROUND_STALL_GRACE_MIN, sandboxRoot, type Config } from "./config.js";
import { auditExecViolations, collectWindowLines, estimateUsd, measureRoundUsage, type ModelPricing, type UsageFs } from "./usage.js";
import type { GateResult } from "./gate.js";
import { applyEvent } from "./statemachine.js";
import type { VerdictAnnouncer } from "./slack/announce.js";
import type { RoundRow, StateStore } from "./state.js";
import { enforceLedgerFreshness } from "./ledgercheck.js";
import { normalizeVerdict, type SessionHooks, type VerdictFile, type VerdictPassEntry } from "./types.js";
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
        return;
      }
    }

    await this.safe(() => adapter.removeLabel(v.pr, cfg.github.in_progress_label), `remove ${cfg.github.in_progress_label} on #${v.pr}`);
    await this.safe(() => adapter.addLabel(v.pr, cfg.github.reviewed_label), `add ${cfg.github.reviewed_label} on #${v.pr}`);

    // spend_usd from the file is fiction (template echo) — never stored; the
    // measured figures land via recordRoundUsage below.
    // Captured BEFORE applyEvent: the transition context writes the verdict's
    // (possibly stale) head back onto pr_state, which would mask a mid-round
    // advance (see the chain below).
    const headBeforeApply = store.getPr(v.pr)?.head_sha ?? null;
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
    // Durability (the owner, 2026-08-19, #5314): a head that advanced WHILE the
    // round ran means the review just delivered targets a stale sha, and the
    // mid-round pushes were consumed by recheck_noop ("no-standing-approval")
    // — nobody would ever revisit them. Chain a SYSTEM-provenance re-trigger:
    // the delta classifier then decides for free whether the delta
    // deserves a full follow-up round (significant) or a short-circuit uphold
    // (trivial/empty). Never on a park (awaiting_human is sticky by design),
    // never on closed/paused, and never interleaved — the chained round only
    // dispatches after this one is fully over (S4 holds).
    if (v.head_sha && headBeforeApply && headBeforeApply !== v.head_sha) {
      const rowAfter = store.getPr(v.pr);
      if (rowAfter && rowAfter.state !== "closed" && rowAfter.state !== "awaiting_human" && !rowAfter.paused) {
        store.logEvent("mid_round_head_advance", v.pr, {
          round_no: v.round_no,
          reviewed_head: v.head_sha,
          current_head: headBeforeApply,
          verdict: v.verdict,
        });
        // Restore the advanced head (applyEvent stamped the reviewed one) and
        // queue with system provenance for the classifier.
        store.upsertPr({
          ...rowAfter,
          head_sha: headBeforeApply,
          state: "queued",
          trigger_ts: this.now().toISOString(),
          trigger_provenance: "system",
        });
        this.log(
          `verdicts: #${v.pr} head advanced mid-round (${v.head_sha.slice(0, 7)} → ${headBeforeApply.slice(0, 7)}) — chained a system re-trigger`,
        );
      }
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
    const settleMs = this.deps.ledgerCheckDelayMs ?? 90_000;
    if (settleMs <= 0) {
      await this.safe(() => this.checkLedger(v.pr, v.round_no, v.head_sha), `ledger check pr-${v.pr}`);
    } else {
      const timer = setTimeout(() => {
        void this.safe(() => this.checkLedger(v.pr, v.round_no, v.head_sha), `ledger check pr-${v.pr}`);
      }, settleMs);
      timer.unref?.();
    }
    // The round is over, so the PR's one main pi is free again (S4): deliver
    // whatever arrived while it was busy, in arrival order.
    await this.flushWakes(v.pr);
    this.log(`verdicts: #${v.pr} round ${v.round_no} → ${v.verdict}`);
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
      const planned = round.lenses ? round.lenses.split(",").filter(Boolean) : [];
      const executed = v.passes.map((p) => p.name);
      const missing = planned.filter((l) => !executed.includes(l));
      const added = [...new Set(executed.filter((l) => !planned.includes(l)))];
      if (missing.length === 0 && added.length === 0) return;
      store.logEvent("pass_plan_mismatch", v.pr, {
        round_id: round.id,
        round_no: v.round_no,
        planned,
        executed,
        missing,
        added,
      });
      this.log(`verdicts: #${v.pr} round ${v.round_no} pass plan mismatch`, { planned, executed, missing, added });
      // Durable anomaly row + (WAKE class) the overseer inject, both
      // through the one logAnomaly funnel.
      store.logAnomaly(
        "pass_plan_mismatch",
        v.pr,
        v.round_no,
        `plan≠executed — planned [${planned.join(",")}] vs executed [${executed.join(",")}]` +
          `${missing.length > 0 ? `; missing ${missing.join(",")}` : ""}${added.length > 0 ? `; added ${added.join(",")}` : ""}`,
        [
          `PASS-PLAN MISMATCH — PR #${v.pr} round ${v.round_no}`,
          `Planned: ${planned.join(", ") || "(none)"}`,
          `Executed (session-reported): ${executed.join(", ") || "(none — solo/degraded round)"}`,
          ...(missing.length > 0 ? [`Missing (planned but never returned): ${missing.join(", ")}`] : []),
          ...(added.length > 0 ? [`Added beyond the plan: ${added.join(", ")} (sanctioned only via the add protocol, with a stated reason in the summary)`] : []),
          "The verdict stands — this is telemetry, not a veto. Check the session if planned passes silently never ran (the posted review must not claim them).",
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
   * the PR returned to its standing-verdict state (the owner, 2026-08-19: no
   * park — the AI keeps driving). Never an approve path: "tracked" here means
   * "no work owed", not approved. */
  private async handleAnomaly(pr: number, roundNo: number | null, message: string, kind: "malformed" | "overdue"): Promise<void> {
    const { cfg, store, adapter } = this.deps;
    const round = this.runningRound(pr, roundNo ?? undefined);
    if (round && round.status === "running") store.markRoundOverdue(round.id);

    // The in-progress label must not stick, but the "Automatic Review" label is
    // deliberately NOT applied — no review was soundly produced.
    await this.safe(() => adapter.removeLabel(pr, cfg.github.in_progress_label), `remove ${cfg.github.in_progress_label} on #${pr}`);

    const standing = normalizeVerdict(store.reviewedHead(pr)?.verdict) ?? null;
    applyEvent(store, pr, { type: "round_overdue", standing }, {}, { botLogin: cfg.github.bot_login, now: () => this.now(), reason: `anomaly:${kind}` });
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
        "No review was produced: the in-progress label was cleared and the PR returned to its standing-verdict state (never an approve). No reviewer was requested on GitHub.",
        "Investigate the session and decide whether to rerun the round (commands/rerun-round) or restart the session.",
        ...(pendingViolations && pendingViolations.length > 0
          ? [`Also: exec-policy violations were audited on this PR — ${pendingViolations.join(" · ")}`]
          : []),
      ].join("\n"),
    );
    await this.announceSafe((a) =>
      a.anomaly({ pr, round_no: roundNo, kind, deadline_min: cfg.daemon.round_deadline_min }),
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
  private async stuckDisposition(round: RoundRow): Promise<"not_stuck" | "verdict_pending" | "dead" | "alive_stuck"> {
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
    // Live but past the deadline with nothing on disk (2026-08-19, the owner:
    // recover, don't park): the session is killed and the round requeued
    // through the same capped path. Without a kill hook the pre-existing park
    // stands — never inject a fresh round into a wedged live session.
    return this.deps.hooks.killSession ? "alive_stuck" : "not_stuck";
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
  private async selfRequeue(round: RoundRow, mode: "dead" | "alive_stuck" | "needs_human_incomplete" | "lost_prompt" = "dead"): Promise<boolean> {
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
            : `round ${round.round_no} verdicted NEEDS_HUMAN without executing any passes — the review was not done, so it is redone rather than handed to a person`;
    if (mode === "alive_stuck" && this.deps.hooks.killSession) {
      await this.safe(() => this.deps.hooks.killSession!.call(this.deps.hooks, round.pr), `kill wedged session pr-${round.pr}`);
    }
    store.markRoundCancelled(round.id, `self-requeue ${attempt}/${cap} — ${reason}`);
    store.logEvent("round_self_requeued", round.pr, {
      round_id: round.id,
      round_no: round.round_no,
      head_sha: head,
      attempt,
      cap,
      mode,
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

  /**: requeue a round whose prompt was consumed but never produced a
   * turn. Every signal is optional and every ambiguity is a no-op — this net
   * only ever fires on the unambiguous case (consumed + silent since before
   * the round started + past the grace window). */
  private async maybeRequeueLostPrompt(round: RoundRow, nowMs: number): Promise<void> {
    const { cfg, store } = this.deps;
    const hooks = this.deps.hooks;
    if (!hooks.sessionActivityAt || !hooks.injectPending) return;
    const graceMs = (cfg.daemon.round_stall_grace_min ?? DEFAULT_ROUND_STALL_GRACE_MIN) * 60_000;
    const startedMs = Date.parse(round.started_at);
    if (!Number.isFinite(startedMs) || nowMs - startedMs < graceMs) return;
    if (store.hasLaterRound(round.pr, round.round_no)) return; // superseded — the deadline sweep owns that case
    if (existsSync(join(this.deps.verdictDir, `pr-${round.pr}-round-${round.round_no}.json`))) return;
    // Once per head from this net: further recovery belongs to the deadline
    // path, which sees dead/wedged sessions rather than inferring from mtimes.
    const head = store.getPr(round.pr)?.head_sha ?? "";
    if (store.selfRequeueCount(round.pr, head) > 0) return;
    try {
      if (await hooks.injectPending.call(hooks, round.pr)) return; // bridge still retrying — patience, not loss
      const activity = await hooks.sessionActivityAt.call(hooks, round.pr);
      if (activity === null || activity >= startedMs) return; // unknown or alive-since — never guess
    } catch {
      return; // an unreadable signal is not evidence
    }
    store.logEvent("round_prompt_lost", round.pr, {
      round_id: round.id,
      round_no: round.round_no,
      started_at: round.started_at,
    });
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
      if ((stuck === "dead" || stuck === "alive_stuck") && (await this.selfRequeue(round, stuck))) continue;
      overdue.push(round.pr);
      await this.handleAnomaly(
        round.pr,
        round.round_no,
        `round ${round.round_no} passed its deadline (${round.deadline_at}); started ${round.started_at}` +
          (stuck === "dead" || stuck === "alive_stuck" ? " — the self-requeue cap is exhausted; parking" : ""),
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
