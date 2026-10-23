// The host-neutral half of a PR session's life: birth ordering, the worktree,
// the raw-notes tier (OpenViking), the archive record, and close. Whatever
// actually runs the PR's pi (today a detached tmux session with an inject
// bridge, later a per-round worker) is behind `PrSessionHost`; nothing in this
// file knows tmux, the bridge or an inject dir.
//
// What the lifecycle owns is the ordering and the single-flights that make a
// PR's session safe to reopen: births share one flight per PR, a close and a
// raw-tier delete fence a later birth (so a reopened PR never recreates a
// session id that a still-running cleanup is about to delete), the archiver's
// restore runs before a birth, and a closed PR is never born.
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  readdirSync,
  renameSync,
  writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";
import type { Config } from "./config.js";
import { RESTORE_WAIT_MS } from "./archive/restore.js";
import { withinBudget } from "@quickchatai/pi-quickreview/src/budget.js";
import {
  OV_SESSION_SWEEP_BUDGET_MS,
  OV_SESSION_SWEEP_MAX,
  ovSessionIdForPr,
  prOfOvSessionId,
  planStaleOvSessions,
  type OvSessionLifecycle,
} from "./memory/ovsession.js";
import { newestSessionFile } from "./sessionjsonl.js";
import type { StateStore } from "./state.js";
import type { OvSessionSweepReport, RoundOrder } from "@quickchatai/pi-quickreview/src/types.js";
import type { WorktreeManager } from "./worktrees.js";

/** The PR's tmux session name — by design the same string as its OpenViking
 * session id, so the one formatter lives there. */
export function prSessionName(pr: number): string {
  return ovSessionIdForPr(pr);
}

export function prOfSession(name: string): number | undefined {
  return prOfOvSessionId(name) ?? undefined;
}

/** What the lifecycle asks of whatever runs the PR's pi. Every method is
 * asked about a PR, never a transport: the host maps it to its own session. */
export interface PrSessionHost {
  /** The names of the host's live sessions, or null when the host could not
   * be asked (then nothing is concluded from the listing). */
  liveSessions(): Promise<string[] | null>;
  /** Does the host affirmatively say the PR's session is gone? "Could not
   * ask" is never "gone". */
  provenGone(pr: number): Promise<boolean>;
  /** Kill the PR's session and confirm it gone. True only on proof. */
  killConfirmed(pr: number): Promise<boolean>;
  /** Stop the PR's session as part of closing the PR, and drop whatever the
   * host left for it that nothing else will collect. Not a confirmation:
   * the lifecycle asks `provenGone` afterwards. */
  stop(pr: number): Promise<void>;
  /** The PR's session when the host already runs a usable one (birth then
   * adopts it); undefined when there is none to adopt. A leftover the host
   * cannot vouch for is fenced here, and a leftover it cannot fence throws. */
  reuseLive(pr: number): Promise<string | undefined>;
  /** Start the PR's session. `rawReady` is false when its raw-notes tier
   * could not be created (the session then runs memory-less). Throws when
   * the session cannot be started; the host may adopt a creator that won a
   * race instead. */
  spawn(pr: number, title: string, worktree: string, opts: { rawReady: boolean }): Promise<string>;
}

export interface PrSessionLifecycleOptions {
  cfg: Config;
  /** Sandbox root. */
  root: string;
  worktrees: WorktreeManager;
  host: PrSessionHost;
  /** The PR's raw-notes tier. Absent ⇒ none is managed at all (test wiring,
   * or a daemon with memory off) — sessions run memory-less, which is the
   * standing degradation rule. */
  ovSessions?: OvSessionLifecycle;
  now?: () => Date;
  /** Narrow unit wiring may omit it; production binds the daemon's store. */
  commandStore?: StateStore;
}

export class PrSessionLifecycle {
  readonly worktrees: WorktreeManager;
  private readonly cfg: Config;
  private readonly root: string;
  private readonly host: PrSessionHost;
  private readonly ovSessions: OvSessionLifecycle | undefined;
  private readonly now: () => Date;
  private commandStore: StateStore | undefined;
  private readonly prSessionBirths = new Map<number, Promise<string>>();
  private readonly prSessionCloses = new Map<number, Promise<void>>();
  private readonly prOvDeletes = new Map<number, Promise<boolean>>();
  private readonly prCleanupVersions = new Map<number, number>();
  private writeSeq = 0;
  /** Stale-session deletes that failed, by session id → when (ms). A failed
   * id waits an hour before the sweep tries it again, so a delete the server
   * keeps refusing costs one log line an hour, not ten every pass. */
  private readonly ovSweepFailedAt = new Map<string, number>();
  /** Awaited before a PR session is born: the archiver's
   * restore of a reopened PR's archived files. Unset ⇒ nothing to wait for. */
  private beforeBirthHook?: (pr: number) => Promise<void>;

  constructor(opts: PrSessionLifecycleOptions) {
    this.cfg = opts.cfg;
    this.root = opts.root;
    this.worktrees = opts.worktrees;
    this.host = opts.host;
    this.ovSessions = opts.ovSessions;
    this.now = opts.now ?? (() => new Date());
    this.commandStore = opts.commandStore;
  }

  /** Late production binding: the daemon owns the StateStore. */
  setCommandStore(store: StateStore): void {
    this.commandStore = store;
  }

  // ---- paths -------------------------------------------------------------

  /** Where every session's `--session-dir` lives (one subdir per session). */
  sessionsRoot(): string {
    return join(this.root, this.cfg.pi.session_dir);
  }

  sessionDir(session: string): string {
    return join(this.sessionsRoot(), session);
  }

  ledgerPath(session: string): string {
    return join(this.root, "state", "ledgers", `${session}.md`);
  }

  archiveDir(session: string): string {
    return join(this.root, "archive", session);
  }

  // ---- registry ----------------------------------------------------------

  /** True only when the registry says the PR is closed; unknown is not closed. */
  prClosed(pr: number): boolean {
    return this.commandStore?.getPr(pr)?.state === "closed";
  }

  private recordEvent(kind: string, pr: number, payload: Record<string, unknown>): void {
    try {
      this.commandStore?.logEvent(kind, pr, payload);
    } catch {
      /* recording is best-effort; the log line says it too */
    }
  }

  private writeAtomic(path: string, body: string | Buffer): void {
    mkdirSync(dirname(path), { recursive: true });
    const tmp = `${path}.tmp-${process.pid}-${this.writeSeq++}`;
    writeFileSync(tmp, body);
    renameSync(tmp, path);
  }

  // ---- worktree ----------------------------------------------------------

  /**
   * The worktree a round is dispatched into. When the order's head commit is
   * already in the clone — the common case, the prepare hook fetched it for
   * the context pack — it is checked out in place; only when the sha is not
   * in the clone at all (no prepare hook ran) do we fetch.
   */
  async prepareRoundWorktree(order: RoundOrder): Promise<void> {
    if (order.head_sha && (await this.worktrees.hasCommit(order.head_sha))) {
      await this.worktrees.checkoutAt(order.pr, order.head_sha);
    } else {
      await this.worktrees.ensureWorktree(order.pr, { baseRef: order.base_ref });
    }
  }

  /** The PR's worktree path, as it stands on disk (no fetch, no reset). */
  worktreePathOf(pr: number): string {
    return this.worktrees.worktreePath(pr);
  }

  /** The PR's worktree path, re-ensured best-effort (a wake's message cites
   * it): an unfetchable worktree must not lose the wake — the session can
   * re-derive state from the message + GitHub reads. */
  async reviveWorktree(pr: number): Promise<string> {
    const worktree = this.worktrees.worktreePath(pr);
    try {
      await this.worktrees.ensureWorktree(pr);
    } catch {
      /* best-effort, see above */
    }
    return worktree;
  }

  /** Daemon start: remove worktrees whose PR is no longer active. */
  sweepStaleWorktrees(keep: Set<number>): Promise<number[]> {
    return this.worktrees.sweepStale(keep);
  }

  // ---- birth -------------------------------------------------------------

  /** The cleanup (close or raw-tier delete) that is still running for the PR,
   * if any. A birth or a wake's respawn waits it out: a reopened PR cannot
   * adopt the old consumer or recreate its raw tier while the earlier cleanup
   * can still kill or delete either one. */
  cleanupInFlight(pr: number): Promise<unknown> | undefined {
    return this.prSessionCloses.get(pr) ?? this.prOvDeletes.get(pr);
  }

  /** Bumped whenever a cleanup starts, so a liveness probe can tell that one
   * began (or finished) while it was in the air. */
  cleanupVersion(pr: number): number {
    return this.prCleanupVersions.get(pr) ?? 0;
  }

  /** Birth on first trigger; concurrent callers for one PR share the complete
   * has→prepare→spawn flight. Unrelated PRs remain independent. */
  async ensureSession(pr: number, title: string, worktree: string): Promise<string> {
    const closing = this.cleanupInFlight(pr);
    if (closing) {
      // The close caller reports any failure; birth rechecks the actual session.
      await closing.catch(() => undefined);
      return this.ensureSession(pr, title, worktree);
    }
    const existing = this.prSessionBirths.get(pr);
    if (existing) return existing;
    const birth = this.birth(pr, title, worktree);
    this.prSessionBirths.set(pr, birth);
    try {
      return await birth;
    } finally {
      if (this.prSessionBirths.get(pr) === birth) this.prSessionBirths.delete(pr);
    }
  }

  /** Is a session birth for `pr` in flight right now? Synchronous — the
   * archiver's eligibility re-reads it immediately before
   * anything of the PR's leaves the live tree. */
  birthInFlight(pr: number): boolean {
    return this.prSessionBirths.has(pr);
  }

  /** Late production binding (wire.ts): the archiver's `beforeBirth`. */
  setBeforeBirth(fn: (pr: number) => Promise<void>): void {
    this.beforeBirthHook = fn;
  }

  /**
   * Before a PR session is born, its archived transcripts and
   * session-command payloads go back (a reopen) — so the delivery receipts of
   * its pre-close wakes are read from the real files again. Bounded at
   * RESTORE_WAIT_MS (the archiver bounds it too), and it never refuses the
   * birth: a slow or failed restore lets the session be born, and the receipt
   * guard keeps the archived window unknown, never absent.
   */
  async awaitBeforeBirth(pr: number): Promise<void> {
    const hook = this.beforeBirthHook;
    if (!hook) return;
    try {
      await withinBudget(hook(pr), RESTORE_WAIT_MS + 5_000);
    } catch (err) {
      console.log(
        `[quickreviewd] sessions: the archive restore before pr-${pr}'s birth failed (${String(err)}) — born anyway`,
      );
    }
  }

  private async birth(pr: number, title: string, worktree: string): Promise<string> {
    await this.awaitBeforeBirth(pr);
    if (this.prClosed(pr)) throw new Error(`PR #${pr} is closed — refusing session birth`);
    const live = await this.host.reuseLive(pr);
    if (live !== undefined) return live;
    // The PR's raw-notes tier, created before pi starts so the extension has
    // something to attach to on the first turn. A store object, not a session
    // anyone schedules: the daemon still owns exactly two pi session kinds.
    const rawReady = await this.ensureOvSession(pr);
    if (this.prClosed(pr)) throw new Error(`PR #${pr} is closed — refusing session birth`);
    return this.host.spawn(pr, title, worktree, { rawReady });
  }

  // ---- raw tier (OpenViking) ----------------------------------------------

  /** Create the PR's raw-notes session. Total: a memory engine that is down
   * costs the PR its raw tier and nothing else. */
  private async ensureOvSession(pr: number): Promise<boolean> {
    if (this.cfg.openviking?.enabled === false || !this.ovSessions) return false;
    try {
      return await this.ovSessions.create(ovSessionIdForPr(pr));
    } catch {
      return false;
    }
  }

  /** Delete the PR's raw-notes session and its archives — the raw tier ages
   * out by DELETE, never by `commit` (which exists to promote notes into
   * durable memory, the extraction that is deliberately switched off).
   *
   * A failure is logged and recorded as an event, so lingering sessions are
   * visible. Total — the PR closes either way. */
  private deleteOvSession(pr: number): Promise<boolean> {
    return this.fenceOvDelete(pr, () => this.removeOvSession(pr));
  }

  private async fenceOvDelete(pr: number, remove: () => Promise<boolean>): Promise<boolean> {
    const existing = this.prOvDeletes.get(pr);
    if (existing) return existing;
    // Publish before the adapter runs: a sweep's awaited DELETE must finish
    // before a reopened birth can recreate the same raw session id.
    const deletion = Promise.resolve().then(remove);
    this.prCleanupVersions.set(pr, (this.prCleanupVersions.get(pr) ?? 0) + 1);
    this.prOvDeletes.set(pr, deletion);
    try {
      return await deletion;
    } finally {
      if (this.prOvDeletes.get(pr) === deletion) this.prOvDeletes.delete(pr);
    }
  }

  private async removeOvSession(pr: number): Promise<boolean> {
    if (this.cfg.openviking?.enabled === false || !this.ovSessions) return false;
    const id = ovSessionIdForPr(pr);
    let ok = false;
    let error: string | undefined;
    try {
      ok = await this.ovSessions.remove(id);
    } catch (err) {
      error = err instanceof Error ? err.message : String(err);
    }
    if (!ok) {
      console.log(
        `[quickreviewd] sessions: openviking session ${id} was NOT deleted${error ? ` (${error})` : ""} — it lingers on the server`,
      );
      this.recordEvent("openviking_session_delete_failed", pr, {
        session: id,
        ...(error ? { error } : {}),
      });
    }
    return ok;
  }

  /**
   * The reconcile sweep over the raw tier: delete the `pr-<n>` OpenViking
   * sessions of PRs the registry says are closed — the ones
   * `archiveAndClose` failed to delete or never got to. Bounded per pass
   * (`OV_SESSION_SWEEP_MAX`), every outcome logged and recorded. Before the
   * raw tier, and whether or not memory is on, it also kills the surviving host
   * session of every closed PR (the retry obligation), so a caller must not gate
   * this call on memory. A PR whose pi
   * session is still alive keeps its raw tier until that session is gone (its
   * turn sync would otherwise write into nothing), and an id whose delete
   * failed waits an hour. Null when no raw tier is managed (memory switched
   * off — `[openviking] enabled = false` runs no server to ask — no
   * lifecycle, or one that cannot list). Total: a dead server is a report,
   * never a throw.
   */
  async sweepStaleOvSessions(
    max: number = OV_SESSION_SWEEP_MAX,
  ): Promise<OvSessionSweepReport | null> {
    // Closed registry rows and surviving host sessions are the retry
    // obligation, independent of whether this install runs reviewer memory.
    let closedProbeUnknown = false;
    if (this.commandStore) {
      const names = await this.host.liveSessions();
      closedProbeUnknown = names === null;
      let attempted = 0;
      for (const name of names ?? []) {
        const pr = prOfSession(name);
        if (pr === undefined) continue;
        if (!this.prClosed(pr) || this.prSessionBirths.has(pr)) continue;
        if (attempted++ >= Math.max(0, Math.floor(max))) break;
        try {
          await this.withPrClose(pr, async () => {
            // Already inside the birth/close fence; do not recursively join it.
            if (this.prClosed(pr) && !(await this.host.killConfirmed(pr)))
              throw new Error(`closed session pr-${pr} survived its cleanup kill`);
          });
        } catch (error) {
          this.recordEvent("closed_session_kill_failed", pr, { error: String(error) });
        }
      }
    }
    if (this.cfg.openviking?.enabled === false) return null;
    const lifecycle = this.ovSessions;
    if (!lifecycle?.list) return null;
    let listed: Awaited<ReturnType<NonNullable<OvSessionLifecycle["list"]>>>;
    try {
      listed = await lifecycle.list();
    } catch (err) {
      listed = { ok: false, reason: err instanceof Error ? err.message : String(err) };
    }
    if (!listed.ok) {
      console.log(
        `[quickreviewd] sessions: stale openviking-session sweep could not list sessions (${listed.reason}) — nothing deleted this pass`,
      );
      return { listed: 0, stale: 0, deleted: [], failed: [], deferred: 0, error: listed.reason };
    }
    const nowMs = this.now().getTime();
    const plan = planStaleOvSessions(
      listed.ids,
      (pr) => {
        const row = this.commandStore?.getPr(pr);
        if (!row) return "unknown";
        return row.state === "closed" ? "closed" : "open";
      },
      Number.MAX_SAFE_INTEGER,
    );
    const report: OvSessionSweepReport = {
      listed: listed.ids.length,
      stale: plan.remove.length,
      deleted: [],
      failed: [],
      deferred: 0,
    };
    const bound = Math.max(0, Math.floor(max));
    let attempted = 0;
    // The pass rides the reconcile poll, so it must not hold it: after the
    // first failed delete (a struggling server — each one can cost the
    // lifecycle's whole deadline) and once `OV_SESSION_SWEEP_BUDGET_MS` has
    // gone, the rest wait for a later pass.
    let stopped = false;
    for (const id of plan.remove) {
      const failedAt = this.ovSweepFailedAt.get(id);
      if (failedAt !== undefined && nowMs - failedAt < 3_600_000) {
        report.deferred += 1;
        continue;
      }
      if (
        stopped ||
        attempted >= bound ||
        this.now().getTime() - nowMs >= OV_SESSION_SWEEP_BUDGET_MS
      ) {
        report.deferred += 1;
        continue;
      }
      const pr = Number(id.slice(3));
      // A closed PR whose pi is still running (archiveAndClose failed to kill
      // it) keeps its raw tier until the session is gone. A probe that could
      // not ask the host proves nothing either way, so it holds like a live one.
      const alive = closedProbeUnknown || !(await this.host.provenGone(pr));
      // The plan read the registry once; the probe and earlier deletes have
      // awaited since. A PR reopened and re-triggered in that window is
      // having its `pr-<n>` reused or recreated — re-check right before the
      // delete, and leave alone a PR whose session birth is in flight.
      if (this.commandStore?.getPr(pr)?.state !== "closed" || this.prSessionBirths.has(pr)) {
        report.deferred += 1;
        continue;
      }
      if (alive) {
        report.deferred += 1;
        continue;
      }
      attempted += 1;
      let ok = false;
      let error: string | undefined;
      try {
        ok = await this.fenceOvDelete(pr, () => lifecycle.remove(id));
      } catch (err) {
        error = err instanceof Error ? err.message : String(err);
      }
      if (ok) {
        this.ovSweepFailedAt.delete(id);
        report.deleted.push(id);
        console.log(
          `[quickreviewd] sessions: openviking session ${id} of closed PR #${pr} deleted (stale-session sweep)`,
        );
        this.recordEvent("openviking_session_deleted", pr, { session: id, source: "sweep" });
      } else {
        stopped = true;
        this.ovSweepFailedAt.set(id, nowMs);
        report.failed.push(id);
        console.log(
          `[quickreviewd] sessions: openviking session ${id} of closed PR #${pr} was NOT deleted by the stale-session sweep${error ? ` (${error})` : ""} — retried in an hour`,
        );
        this.recordEvent("openviking_session_delete_failed", pr, {
          session: id,
          source: "sweep",
          ...(error ? { error } : {}),
        });
      }
    }
    if (report.stale > 0) {
      console.log(
        `[quickreviewd] sessions: stale openviking-session sweep — ${report.stale} stale, ${report.deleted.length} deleted, ${report.failed.length} failed, ${report.deferred} left for a later pass`,
      );
    }
    return report;
  }

  // ---- archive -----------------------------------------------------------

  /** Newest *.jsonl anywhere under a session's --session-dir (src/sessionjsonl.ts). */
  newestSessionFile(session: string): string | undefined {
    return newestSessionFile(this.sessionDir(session));
  }

  /**
   * Write a session's record into an archive dir: its ledger (+ any verdict
   * still at the top of verdict/) and `meta.json`, whose `session_file` names
   * the live transcript that was newest at this moment. Returns what landed.
   *
   * The transcript itself is not copied: the closed-PR archiver keeps every
   * JSONL of the session — verified and compressed — in
   * `archive/<session>/transcripts/` once it is safe to move (`src/archive/`),
   * and a multi-MB synchronous copy does not belong on the close path.
   * `qcr why`, the TUI ledger and the overseer seed read `ledger.md` and
   * `meta.json`, which stay plain.
   */
  archiveSession(session: string, dest: string): string[] {
    mkdirSync(dest, { recursive: true });
    const written: string[] = [];
    const jsonl = this.newestSessionFile(session);
    const ledger = this.ledgerPath(session);
    if (existsSync(ledger)) {
      const target = join(dest, "ledger.md");
      copyFileSync(ledger, target);
      written.push(target);
    }
    const pr = prOfSession(session);
    if (pr !== undefined) {
      const verdictDir = join(this.root, "verdict");
      if (existsSync(verdictDir)) {
        const prefix = `pr-${pr}-round-`;
        for (const f of readdirSync(verdictDir)) {
          if (!f.startsWith(prefix) || !f.endsWith(".json")) continue;
          mkdirSync(join(dest, "verdicts"), { recursive: true });
          const target = join(dest, "verdicts", f);
          copyFileSync(join(verdictDir, f), target);
          written.push(target);
        }
      }
    }
    this.writeAtomic(
      join(dest, "meta.json"),
      `${JSON.stringify(
        {
          session,
          archived_at: this.now().toISOString(),
          session_file: jsonl ?? null,
          files: written,
        },
        null,
        2,
      )}\n`,
    );
    return written;
  }

  // ---- close -------------------------------------------------------------

  async archiveAndClose(pr: number): Promise<void> {
    return this.withPrClose(pr, () => this.closePrSession(pr));
  }

  /** Run `cleanup` as the PR's one close flight. Birth and delivery wait it,
   * so a successor cannot be born between a cleanup's last check and its
   * async kill. */
  async withPrClose(pr: number, cleanup: () => Promise<void>): Promise<void> {
    const existing = this.prSessionCloses.get(pr);
    if (existing) {
      // A sweep may only owe a kill, while a close also owes archival and
      // raw-tier cleanup. Serialize each requested operation in full.
      await existing.catch(() => undefined);
      return this.withPrClose(pr, cleanup);
    }
    // Capture births already underway before publishing the close flight. A
    // later birth waits this close, so looking it up from cleanup would make
    // the two flights wait on one another.
    const birth = this.prSessionBirths.get(pr);
    const close = Promise.resolve().then(async () => {
      await birth?.catch(() => undefined);
      await cleanup();
    });
    this.prCleanupVersions.set(pr, (this.prCleanupVersions.get(pr) ?? 0) + 1);
    this.prSessionCloses.set(pr, close);
    try {
      await close;
    } finally {
      if (this.prSessionCloses.get(pr) === close) this.prSessionCloses.delete(pr);
    }
  }

  private async closePrSession(pr: number): Promise<void> {
    const session = prSessionName(pr);
    if (this.commandStore?.getPr(pr) && !this.prClosed(pr)) return;
    // Terminalize outstanding ordinary wakes first, so no recovery sweep can
    // replay one into a session reborn after the kill below.
    this.commandStore?.cancelSessionCommandsForClosedPr(pr);
    // The kill never waits on the bookkeeping before it: a record or a
    // worktree that could not be removed is reported (rethrown below), never
    // a reason to leave the closed PR's pi running. The reconcile sweep
    // retries surviving closed sessions.
    let failed: { err: unknown } | null = null;
    try {
      this.archiveSession(session, this.archiveDir(session));
    } catch (err) {
      failed ??= { err };
    }
    try {
      await this.worktrees.remove(pr);
    } catch (err) {
      failed ??= { err };
    }
    if (this.commandStore?.getPr(pr) && !this.prClosed(pr)) {
      if (failed !== null) throw failed.err;
      return;
    }
    await this.host.stop(pr);
    // The raw tier dies with the PR: DELETE removes the session's messages AND
    // its archives. Only once the host proves the session gone, so nothing is
    // still syncing turns into it — a kill that did not take, or a probe that
    // could not ask, leaves it to the stale-session sweep, which deletes it
    // once the session is gone. Deliberately not in killSession(): a wedged
    // session is respawned and keeps its notes.
    if (await this.host.provenGone(pr)) {
      if (!this.commandStore?.getPr(pr) || this.prClosed(pr)) await this.deleteOvSession(pr);
    } else {
      console.log(
        `[quickreviewd] sessions: ${session} is not proven gone after the close kill — its openviking session is left to the stale-session sweep`,
      );
      this.recordEvent("openviking_session_delete_deferred", pr, {
        session,
        reason: "session not proven gone after the close kill",
      });
    }
    if (failed !== null) throw failed.err;
  }
}
