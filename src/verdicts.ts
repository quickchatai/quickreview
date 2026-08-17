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
import { sandboxRoot, type Config } from "./config.js";
import { auditExecViolations, collectWindowLines, estimateUsd, measureRoundUsage, type ModelPricing, type UsageFs } from "./usage.js";
import type { GateResult } from "./gate.js";
import { applyEvent } from "./statemachine.js";
import type { VerdictAnnouncer } from "./slack/announce.js";
import type { RoundRow, StateStore } from "./state.js";
import type { SessionHooks, VerdictFile } from "./types.js";

export interface VerdictAdapter {
  addLabel(n: number, label: string): Promise<GateResult>;
  removeLabel(n: number, label: string): Promise<GateResult>;
  requestEscalationReview(n: number): Promise<{ skipped: string | null; result?: GateResult }>;
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
  if (v.verdict !== "APPROVE" && v.verdict !== "REQUEST_CHANGES" && v.verdict !== "ESCALATE")
    return bad(`bad verdict: ${String(v.verdict)}`);
  if (typeof v.head_sha !== "string" || v.head_sha.length === 0) return bad("head_sha must be a non-empty string");
  if (typeof v.finished_at !== "string" || v.finished_at.length === 0) return bad("finished_at must be a non-empty string");
  // spend_usd: legacy self-reported field — accepted in any shape and IGNORED
  // (models copy the template's example figure; real usage is measured from
  // the session JSONLs). Deleted so no consumer can store it.
  delete v.spend_usd;
  if (v.ai_approved !== undefined && typeof v.ai_approved !== "boolean") return bad("ai_approved must be a boolean");
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

  /** The handoff: labels, escalation request, round record, transition. */
  private async apply(v: VerdictFile, name: string): Promise<void> {
    const { cfg, store, adapter } = this.deps;
    const round = this.runningRound(v.pr, v.round_no);

    await this.safe(() => adapter.removeLabel(v.pr, cfg.github.in_progress_label), `remove ${cfg.github.in_progress_label} on #${v.pr}`);
    await this.safe(() => adapter.addLabel(v.pr, cfg.github.reviewed_label), `add ${cfg.github.reviewed_label} on #${v.pr}`);

    let escalation: { skipped: string | null } | null = null;
    if (v.verdict === "ESCALATE") {
      escalation = (await this.safe(() => adapter.requestEscalationReview(v.pr), `escalate #${v.pr}`)) ?? null;
    }

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
      escalation_skipped: escalation?.skipped ?? null,
    });
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
    const escalation = await this.safe(() => adapter.requestEscalationReview(pr), `escalate #${pr}`);

    applyEvent(store, pr, { type: "round_overdue" }, {}, { botLogin: cfg.github.bot_login, now: () => this.now(), reason: `anomaly:${kind}` });
    store.logEvent(kind === "overdue" ? "round_overdue" : "verdict_malformed", pr, {
      round_id: round?.id ?? null,
      round_no: roundNo,
      message,
      escalation_skipped: escalation?.skipped ?? null,
    });
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
            "Treated as ESCALATE / no-approve: the in-progress label was cleared, the human reviewer was requested, and the PR is parked on awaiting_human.",
            "Investigate the session and decide whether to rerun the round (commands/rerun-round) or restart the session.",
            ...(pendingViolations && pendingViolations.length > 0
              ? [`Also: exec-policy violations were audited on this PR — ${pendingViolations.join(" · ")}`]
              : []),
          ].join("\n"),
        ),
      "inject overseer anomaly",
    );
    this.log(`verdicts: anomaly (${kind}) on #${pr}`, message);
  }

  /** Deadline sweep — a running round past `deadline_at` is an anomaly.
   * A superseded round (a newer round exists on the same PR) is cancelled
   * silently instead: its PR state, labels and reviewer requests belong to
   * the newer round, and yanking them here corrupted live reviews. */
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
      overdue.push(round.pr);
      await this.handleAnomaly(
        round.pr,
        round.round_no,
        `round ${round.round_no} passed its deadline (${round.deadline_at}); started ${round.started_at}`,
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
