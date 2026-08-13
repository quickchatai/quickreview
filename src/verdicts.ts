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
import { join } from "node:path";
import type { Config } from "./config.js";
import type { GateResult } from "./gate.js";
import { applyEvent } from "./statemachine.js";
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
  if (v.spend_usd !== undefined && typeof v.spend_usd !== "number") return bad("spend_usd must be a number");
  if (v.ai_approved !== undefined && typeof v.ai_approved !== "boolean") return bad("ai_approved must be a boolean");
  if (v.ledger_snapshot !== undefined && typeof v.ledger_snapshot !== "string") return bad("ledger_snapshot must be a string");
  return { ok: true, verdict: raw as unknown as VerdictFile };
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

export class VerdictWatcher {
  private watcher: FSWatcher | null = null;
  private readonly inFlight = new Set<string>();
  private readonly processedDir: string;

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

    if (round) store.finishRound(round.id, v.verdict, v.spend_usd ?? null);
    applyEvent(store, v.pr, { type: "verdict", verdict: v.verdict }, { head_sha: v.head_sha }, { botLogin: cfg.github.bot_login, now: () => this.now(), reason: `verdict:${v.verdict}` });
    store.logEvent("verdict_applied", v.pr, {
      file: name,
      round_id: round?.id ?? null,
      round_no: v.round_no,
      head_sha: v.head_sha,
      verdict: v.verdict,
      ai_approved: v.ai_approved ?? null,
      spend_usd: v.spend_usd ?? null,
      escalation_skipped: escalation?.skipped ?? null,
    });
    this.log(`verdicts: #${v.pr} round ${v.round_no} → ${v.verdict}`);
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
    await this.safe(
      () =>
        hooks.injectOverseer(
          [
            `ANOMALY (${kind}) — PR #${pr}${roundNo !== null ? ` round ${roundNo}` : ""}`,
            message,
            "Treated as ESCALATE / no-approve: the in-progress label was cleared, the human reviewer was requested, and the PR is parked on awaiting_human.",
            "Investigate the session and decide whether to rerun the round (commands/rerun-round) or restart the session.",
          ].join("\n"),
        ),
      "inject overseer anomaly",
    );
    this.log(`verdicts: anomaly (${kind}) on #${pr}`, message);
  }

  /** Deadline sweep — a running round past `deadline_at` is an anomaly. */
  async checkDeadlines(): Promise<number[]> {
    const overdue: number[] = [];
    const nowMs = this.now().getTime();
    for (const round of this.deps.store.runningRounds()) {
      if (Date.parse(round.deadline_at) > nowMs) continue;
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
