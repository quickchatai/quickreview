// The daemon-templated announcer (S4).
//
// Everything the daemon says in Slack on its own initiative is assembled HERE,
// in deterministic TypeScript, from state the daemon already holds: no model
// call, no overseer turn, nothing a prompt can reword. src/slack/messages.ts
// owns the wording; this module owns *whether*, *where* and *exactly once*.
//
// Three rules shape the whole file:
//
//  1. **Root-on-first-event (ratified DP-2a).** Whichever event reaches a PR
//     first — the pickup at dispatch, or a `pr.not_picked_up` notice while it
//     still waits — posts the top-level message and writes `slack_threads`.
//     Every later post targets that recorded `root_ts`, never a reply's own ts.
//     A reply for a PR with no root is PROMOTED to a root rather than dropped
//     into the channel unthreaded.
//  2. **Never block the daemon.** Slack is a side channel: every failure is
//     recorded (`ok = 0`) and swallowed. No path here throws into dispatch or
//     the verdict watcher, and none of them can delay a label, a verdict or a
//     round.
//  3. **Caps are daemon code.** Announcements bypass the model-turn caps (they
//     cost nothing) but still pass `decideAnnouncement` — per-cause switch,
//     cooldown with fold, one escalation bypass a day, rolling-hour ceiling —
//     and the `slack_posts` idem_key ledger, claimed BEFORE the API call so a
//     restart mid-post cannot double-post.
//
// Thread-lifecycle posts (pickup / verdict / re-round /
// superseded) are deliberately NOT cooldown-gated: they answer a real event on
// one PR and folding them would silently drop a verdict. They honour their
// cause's `enabled` switch (never hardcoded) and the idem ledger, nothing else.
import { existsSync, readFileSync } from "node:fs";
import type { Config } from "../config.js";
import { opsDay } from "../eod.js";
import type { SlackPostKind, StateStore } from "../state.js";
import type { RoundType } from "../types.js";
import {
  causeMessage,
  formatGap,
  heartbeatMessage,
  isoSeconds,
  pickupMessage,
  reRoundMessage,
  supersededMessage,
  verdictMessage,
  type CauseMessageInput,
  type ReRoundReason,
  type VerdictName,
} from "./messages.js";
import { causePolicy, decideAnnouncement } from "./policy.js";
import type { SlackWebApi } from "./types.js";

/** Cause keys for the thread-lifecycle posts. They live in the same namespace
 * as the unprompted causes so `[slack.policy.causes]` can silence any of them
 * without a code change (none of them is hardcoded-on). */
export const LIFECYCLE_CAUSES = {
  pickup: "pr.pickup",
  verdict: "pr.verdict",
  reRound: "round.restarted",
  superseded: "review.superseded",
} as const;

/** Fixed ledger key for the pinned heartbeat: one message, updated forever. */
export const HEARTBEAT_IDEM_KEY = "daemon.heartbeat";

export interface RoundAnnouncement {
  pr: number;
  title: string;
  author: string;
  head_sha: string;
  round_no: number;
  round_type: RoundType;
  lenses: string[];
  additions: number;
  deletions: number;
  changed_files: number;
  /** Why this later round started; defaults from `round_type`. Ignored when
   * the announcement opens the thread (the root carries the round type). */
  reason?: ReRoundReason;
}

export interface VerdictAnnouncement {
  pr: number;
  round_no: number;
  verdict: VerdictName;
  /** `rounds.summary` verbatim; null drops the line. */
  summary: string | null;
  /** Measured round duration; null ⇒ rendered as 0 min rather than invented. */
  duration_s: number | null;
  /** Falls back to the PR row when omitted. */
  author?: string;
}

export interface AnomalyAnnouncement {
  pr: number;
  round_no: number | null;
  kind: "malformed" | "overdue" | "failed_loud";
  deadline_min: number;
  incident_id?: string;
}

export interface SupersededAnnouncement {
  pr: number;
  old_round_no: number;
  new_round_no: number;
  head_sha: string;
}

/** The slice src/dispatch.ts depends on — optional there, so the stub-wired
 * daemon core and every existing test keep working with no Slack at all. */
export interface DispatchAnnouncer {
  roundStarted(a: RoundAnnouncement): Promise<void>;
}

/** The slice src/verdicts.ts depends on. Same optionality. */
export interface VerdictAnnouncer {
  verdict(a: VerdictAnnouncement): Promise<void>;
  anomaly(a: AnomalyAnnouncement): Promise<void>;
  superseded(a: SupersededAnnouncement): Promise<void>;
}

export interface AnnouncerDeps {
  cfg: Config;
  store: StateStore;
  slack: SlackWebApi;
  now?: () => Date;
  log?: (msg: string, extra?: unknown) => void;
  /** Reported by `daemon.up`; defaults to package version-ish "unknown". */
  version?: string;
  /**
   * Where the previous run's liveness lives. DOWNTIME MEASUREMENT SOURCE: the
   * `heartbeat` field of `state/status.json` (falling back to `written_at`),
   * i.e. the same snapshot the status collector and `qcr status` read. It is
   * written every daemon tick, so its age at boot IS the gap — no extra table,
   * and it survives a container replacement because the state volume does.
   */
  statusPath?: string;
  /** Test seam for the above (returns the file contents, or undefined). */
  readStatus?: () => string | undefined;
  /** Duplicate-socket-consumer signal. NOT a channel post — ops signals ship
   * OFF in v1; the wiring agent hooks this to the overseer-inject anomaly path. */
  onAnomalySignal?: (message: string) => void | Promise<void>;
  /** Bound on the shutdown announcement so it can never delay an exit. */
  stopTimeoutMs?: number;
  /** Timer seam, identical in shape to the one src/slack/api.ts and
   * src/slack/socket.ts expose: tests drive the heartbeat interval and the
   * shutdown budget without real timers. Defaults to the globals. */
  setTimeoutFn?: (fn: () => void, ms: number) => unknown;
  clearTimeoutFn?: (handle: unknown) => void;
  setIntervalFn?: (fn: () => void, ms: number) => unknown;
  clearIntervalFn?: (handle: unknown) => void;
}

/** Node timers are unref-able; an injected fake usually is not. */
function unref(handle: unknown): void {
  (handle as { unref?: () => void } | undefined)?.unref?.();
}

interface PostRequest {
  idemKey: string;
  kind: SlackPostKind;
  text: string;
  /** PR-scoped posts thread under the PR's root (or become it). */
  pr?: number;
}

/** One `pr.not_picked_up` candidate, as the scan reports it. */
export interface NotPickedUpItem {
  pr: number;
  age_min: number;
  queue_depth: number;
  running: number;
  max_concurrent: number;
}

/**
 * PRs that have waited past `pickup_grace_min` without a round: queued, not
 * paused, triggered, and with no round started since that trigger. Pure over
 * the store — the wiring agent drives it on a timer.
 */
export function scanNotPickedUp(
  store: StateStore,
  cfg: Config,
  now: Date = new Date(),
): NotPickedUpItem[] {
  const graceMs = cfg.slack.policy.pickup_grace_min * 60_000;
  const queued = store.allPrs().filter((p) => p.state === "queued" && !p.paused && p.trigger_ts);
  const running = store.runningRounds().length;
  const waiting = queued.filter((p) => {
    const triggered = Date.parse(p.trigger_ts!);
    if (!Number.isFinite(triggered)) return false;
    if (now.getTime() - triggered <= graceMs) return false;
    // A round already answering this trigger means the PR was picked up.
    return !store.roundsFor(p.number).some((r) => Date.parse(r.started_at) >= triggered);
  });
  return waiting.map((p) => ({
    pr: p.number,
    age_min: Math.round((now.getTime() - Date.parse(p.trigger_ts!)) / 60_000),
    queue_depth: queued.length,
    running,
    max_concurrent: cfg.daemon.max_concurrent_rounds,
  }));
}

export class SlackAnnouncer implements DispatchAnnouncer, VerdictAnnouncer {
  private heartbeatTimer: unknown = null;
  private lastConnections = 1;
  private readonly setTimeoutFn: (fn: () => void, ms: number) => unknown;
  private readonly clearTimeoutFn: (handle: unknown) => void;
  private readonly setIntervalFn: (fn: () => void, ms: number) => unknown;
  private readonly clearIntervalFn: (handle: unknown) => void;

  constructor(private readonly deps: AnnouncerDeps) {
    this.setTimeoutFn = deps.setTimeoutFn ?? ((fn, ms) => setTimeout(fn, ms));
    this.clearTimeoutFn =
      deps.clearTimeoutFn ?? ((h) => clearTimeout(h as ReturnType<typeof setTimeout>));
    this.setIntervalFn = deps.setIntervalFn ?? ((fn, ms) => setInterval(fn, ms));
    this.clearIntervalFn =
      deps.clearIntervalFn ?? ((h) => clearInterval(h as ReturnType<typeof setInterval>));
  }

  /** Inert when `[slack] enabled = false`: zero posts, zero state writes. */
  get enabled(): boolean {
    return this.deps.cfg.slack.enabled;
  }

  private now(): Date {
    return (this.deps.now ?? (() => new Date()))();
  }

  private log(msg: string, extra?: unknown): void {
    (this.deps.log ?? (() => {}))(msg, extra);
  }

  // ---- the one posting path ---------------------------------------------

  /**
   * Claim, post, settle. Returns the message ts on success, undefined on any
   * refusal or failure. The ONLY place this module talks to Slack.
   */
  private async post(req: PostRequest): Promise<string | undefined> {
    const { cfg, store, slack } = this.deps;
    if (!cfg.slack.enabled) return undefined;

    const thread = req.pr === undefined ? undefined : store.slackThreadForPr(req.pr);
    // Root-on-first-event: with no recorded root, this post BECOMES the root.
    const threadTs = thread?.root_ts;

    if (
      !store.recordSlackPost({
        idem_key: req.idemKey,
        kind: req.kind,
        pr: req.pr ?? null,
        thread_ts: threadTs ?? null,
        chars: req.text.length,
      })
    ) {
      const prior = store.slackPost(req.idemKey);
      // A previously FAILED attempt may be retried; a delivered one may not.
      if (!prior || prior.ok === 1) {
        this.log(`slack: skipping duplicate post (${req.idemKey})`);
        return undefined;
      }
    }

    let result: { ok: boolean; ts?: string; error?: string };
    try {
      result = await slack.postMessage({
        channel: cfg.slack.channel,
        text: req.text,
        thread_ts: threadTs,
      });
    } catch (err) {
      result = { ok: false, error: String(err) };
    }
    if (!result.ok || !result.ts) {
      store.settleSlackPost(req.idemKey, { ok: false, error: result.error ?? "no ts returned" });
      this.log(`slack: post failed (${req.idemKey})`, result.error);
      return undefined;
    }
    store.settleSlackPost(req.idemKey, { ok: true, ts: result.ts });
    if (req.pr !== undefined) {
      if (threadTs === undefined)
        store.upsertSlackThread({ pr: req.pr, channel: cfg.slack.channel, root_ts: result.ts });
      else store.touchSlackThread(req.pr);
    }
    return result.ts;
  }

  /** Lifecycle gate: the cause's own switch, nothing more (see header). */
  private lifecycleEnabled(cause: string): boolean {
    if (!this.enabled) return false;
    if (causePolicy(this.deps.cfg, cause).enabled) return true;
    this.log(`slack: lifecycle cause '${cause}' is disabled`);
    return false;
  }

  /** Unprompted-cause gate: switch + cooldown + fold + rolling-hour ceiling.
   * Mutates on decide, exactly like AlertPolicy — so a caller can never fire
   * without paying the cooldown. */
  private announcementAllowed(cause: string, pr?: number | null, escalated?: boolean): boolean {
    if (!this.enabled) return false;
    const d = decideAnnouncement(
      this.deps.store,
      this.deps.cfg,
      { cause, pr, escalated },
      this.now(),
    );
    if (!d.allow) this.log(`slack: announcement '${d.key}' suppressed — ${d.reason ?? d.block}`);
    return d.allow;
  }

  /** The policy-timezone day token — the shared opsDay (src/eod.ts) over
   * this section's zone; no private day-naming copy. */
  private policyDay(): string {
    return opsDay(this.deps.cfg.slack.policy.timezone, this.now());
  }

  /** Coarse buckets keep a repeatable cause idempotent across a restart while
   * still letting it speak again later (the cooldown decides when). */
  private hourBucket(): string {
    return this.now().toISOString().slice(0, 13);
  }

  private minuteBucket(): string {
    return this.now().toISOString().slice(0, 16);
  }

  // ---- thread lifecycle --------------------------------------------------

  /**
   * A round was created. Says the ratified pickup message the first time — as
   * the thread ROOT when nothing has spoken for this PR yet, or as the first
   * REPLY when a `pr.not_picked_up` notice already opened the thread (DP-2a is
   * root-on-first-event, NOT pickup-only-if-first) — and the 🔄 line in-thread
   * on every genuinely later round.
   *
   * The branch is on the PICKUP POST, never on thread existence: a thread the
   * 🐢 notice opened must still receive the pickup template, and a 🔄 line
   * ("you pushed new commits") about a PR that was merely queued would be a
   * lie. `round_no` is MAX+1 per PR (StateStore.startRound), so round 1 can
   * never be a re-round — that guard keeps a replayed first round silent
   * instead of inventing a 🔄 line for it.
   */
  async roundStarted(a: RoundAnnouncement): Promise<void> {
    if (!this.enabled) return;
    const { store, cfg } = this.deps;
    // A previously FAILED pickup (ok = 0) is retried by `post`, so it does not
    // count as said.
    const pickupSaid = store.slackPost(`pickup:${a.pr}`)?.ok === 1;
    if (!pickupSaid) {
      if (this.lifecycleEnabled(LIFECYCLE_CAUSES.pickup)) {
        await this.post({
          idemKey: `pickup:${a.pr}`,
          kind: "pickup",
          pr: a.pr,
          text: pickupMessage(cfg, {
            pr: a.pr,
            title: a.title,
            author: a.author,
            round_no: a.round_no,
            round_type: a.round_type,
            changed_files: a.changed_files,
            additions: a.additions,
            deletions: a.deletions,
            lenses: a.lenses,
          }),
        });
      }
    } else if (a.round_no > 1 && this.lifecycleEnabled(LIFECYCLE_CAUSES.reRound)) {
      const reason: ReRoundReason =
        a.reason ?? (a.round_type === "staleness" ? { kind: "base_moved" } : { kind: "pushed" });
      await this.post({
        idemKey: `reround:${a.pr}:${a.round_no}`,
        kind: "announce",
        pr: a.pr,
        text: reRoundMessage({ round_no: a.round_no, reason, head_sha: a.head_sha }),
      });
    }
  }

  // escalationWorthy() — the one-per-PR pre-flag — was removed on 2026-08-18
  // along with the heuristic that produced it. A PR now announces its verdict
  // and nothing before it.

  /** The verdict, in-thread. RATIFIED: never `reply_broadcast`, whatever
   * `broadcast_verdicts` says — the seam has no broadcast parameter at all. */
  async verdict(a: VerdictAnnouncement): Promise<void> {
    if (!this.lifecycleEnabled(LIFECYCLE_CAUSES.verdict)) return;
    const author = a.author ?? this.deps.store.getPr(a.pr)?.author ?? "";
    await this.post({
      idemKey: `verdict:${a.pr}:${a.round_no}`,
      kind: "verdict",
      pr: a.pr,
      text: verdictMessage(this.deps.cfg, {
        pr: a.pr,
        author,
        round_no: a.round_no,
        verdict: a.verdict,
        summary: a.summary,
        duration_min: Math.max(0, Math.round((a.duration_s ?? 0) / 60)),
      }),
    });
  }

  /** A round outlived by a newer one. Wording per CLAUDE.md hard rule 2. */
  async superseded(a: SupersededAnnouncement): Promise<void> {
    if (!this.lifecycleEnabled(LIFECYCLE_CAUSES.superseded)) return;
    await this.post({
      idemKey: `superseded:${a.pr}:${a.old_round_no}`,
      kind: "announce",
      pr: a.pr,
      text: supersededMessage(a),
    });
  }

  // ---- unprompted causes -------------------------------------------------

  /** Overdue / malformed: both return the PR to its standing-verdict state
   * (never a park) and neither implies an approval. A
   * round-less anomaly has nothing to say and stays silent. */
  async anomaly(a: AnomalyAnnouncement): Promise<void> {
    if (a.round_no === null) return;
    const cause =
      a.kind === "overdue"
        ? "round.overdue"
        : a.kind === "failed_loud"
          ? "review.failed_loud"
          : "round.malformed_verdict";
    // An anomaly is a genuine escalation: it may spend the day's one bypass.
    if (!this.announcementAllowed(cause, a.pr, true)) return;
    const text =
      a.kind === "overdue"
        ? causeMessage(this.deps.cfg, {
            cause: "round.overdue",
            pr: a.pr,
            round_no: a.round_no,
            deadline_min: a.deadline_min,
          })
        : a.kind === "failed_loud"
          ? `⛔ #${a.pr} round ${a.round_no} exhausted automatic recovery — review work is still owed. Use u on the board to recover.`
          : causeMessage(this.deps.cfg, {
              cause: "round.malformed_verdict",
              pr: a.pr,
              round_no: a.round_no,
            });
    await this.post({
      idemKey: a.incident_id ?? `${cause}:${a.pr}:${a.round_no}`,
      kind: "announce",
      pr: a.pr,
      text,
    });
  }

  /** A PR still waiting for a slot. This may be the FIRST event on the PR, in
   * which case it opens the thread (root-on-first-event). */
  async notPickedUp(item: NotPickedUpItem): Promise<void> {
    if (!this.announcementAllowed("pr.not_picked_up", item.pr)) return;
    await this.post({
      idemKey: `pr.not_picked_up:${item.pr}:${this.hourBucket()}`,
      kind: "announce",
      pr: item.pr,
      text: causeMessage(this.deps.cfg, { cause: "pr.not_picked_up", ...item }),
    });
  }

  /** Run the scan and announce every hit. Returns what it announced. */
  async announceNotPickedUp(): Promise<number[]> {
    if (!this.enabled) return [];
    const announced: number[] = [];
    for (const item of scanNotPickedUp(this.deps.store, this.deps.cfg, this.now())) {
      const before = this.deps.store.slackPost(`pr.not_picked_up:${item.pr}:${this.hourBucket()}`);
      await this.notPickedUp(item);
      const after = this.deps.store.slackPost(`pr.not_picked_up:${item.pr}:${this.hourBucket()}`);
      if (!before && after?.ok === 1) announced.push(item.pr);
    }
    return announced;
  }

  /** The Slack answer budget ran out — said once a day, never per refusal. */
  async capReached(cap: number): Promise<void> {
    if (!this.announcementAllowed("slack.cap_reached")) return;
    await this.post({
      idemKey: `slack.cap_reached:${this.policyDay()}`,
      kind: "announce",
      text: causeMessage(this.deps.cfg, { cause: "slack.cap_reached", cap }),
    });
  }

  // ---- daemon lifecycle --------------------------------------------------

  /** Previous run's liveness instant from state/status.json (see AnnouncerDeps
   * .statusPath for why that file is the source). */
  lastHeartbeatIso(): string | undefined {
    const raw = this.readStatusRaw();
    if (raw === undefined) return undefined;
    try {
      const snap = JSON.parse(raw) as { heartbeat?: unknown; written_at?: unknown };
      const value =
        typeof snap.heartbeat === "string"
          ? snap.heartbeat
          : typeof snap.written_at === "string"
            ? snap.written_at
            : undefined;
      return value !== undefined && Number.isFinite(Date.parse(value)) ? value : undefined;
    } catch (err) {
      this.log("slack: status.json unreadable for downtime measurement", err);
      return undefined;
    }
  }

  private readStatusRaw(): string | undefined {
    if (this.deps.readStatus) return this.deps.readStatus();
    const path = this.deps.statusPath;
    if (!path || !existsSync(path)) return undefined;
    try {
      return readFileSync(path, "utf8");
    } catch (err) {
      this.log("slack: status.json read failed", err);
      return undefined;
    }
  }

  /**
   * Announce a restart ONLY when the measured gap exceeds
   * `downtime_notice_min`. Shorter gaps are deploy noise: the socket overlaps,
   * nothing is lost, and a line about it would be pure spam. The gap that IS
   * reported is the measured one — never rounded into a reassuring shape.
   */
  async daemonUp(): Promise<boolean> {
    if (!this.enabled) return false;
    const last = this.lastHeartbeatIso();
    if (last === undefined) return false; // first ever boot: nothing was missed
    const gapMs = this.now().getTime() - Date.parse(last);
    if (gapMs <= this.deps.cfg.slack.policy.downtime_notice_min * 60_000) return false;
    if (!this.announcementAllowed("daemon.up")) return false;
    const ts = await this.post({
      idemKey: `daemon.up:${this.minuteBucket()}`,
      kind: "announce",
      text: causeMessage(this.deps.cfg, {
        cause: "daemon.up",
        version: this.deps.version ?? "unknown",
        gap: formatGap(gapMs),
        last_heartbeat: isoSeconds(last),
      }),
    });
    return ts !== undefined;
  }

  /** Best-effort goodbye, bounded so shutdown can never wait on Slack. */
  async daemonStopping(reason: string): Promise<void> {
    if (!this.announcementAllowed("daemon.stopping")) return;
    const budget = this.deps.stopTimeoutMs ?? 3000;
    const post = this.post({
      idemKey: `daemon.stopping:${this.minuteBucket()}`,
      kind: "announce",
      text: causeMessage(this.deps.cfg, { cause: "daemon.stopping", reason }),
    });
    let timer: unknown;
    try {
      await Promise.race([
        post,
        new Promise<void>((resolve) => {
          timer = this.setTimeoutFn(() => resolve(), budget);
          unref(timer);
        }),
      ]);
    } catch (err) {
      this.log("slack: stopping announcement failed", err);
    } finally {
      if (timer !== undefined) this.clearTimeoutFn(timer);
    }
  }

  // ---- pinned heartbeat --------------------------------------------------

  /**
   * One message, posted once and edited forever: its staleness is what shows
   * the current gap. The ts lives in the post ledger under a fixed idem key, so
   * a restart updates the same message instead of littering the channel.
   */
  async heartbeat(): Promise<string | undefined> {
    if (!this.enabled) return undefined;
    const { store, cfg, slack } = this.deps;
    const refreshedAt = this.now();
    const recoveries = store.recentReviewRecoveries(
      new Date(refreshedAt.getTime() - 10 * 60_000).toISOString(),
    );
    for (const recovered of recoveries) {
      const incidentPost = store.slackPost(recovered.incident_id);
      if (!incidentPost?.ts) continue;
      try {
        await slack.updateMessage({
          channel: cfg.slack.channel,
          ts: incidentPost.ts,
          text: `✓ #${recovered.pr} review failure recovered via ${recovered.recovery ?? "operator action"} — ${recovered.incident_id}`,
        });
      } catch (err) {
        this.log("slack: failure recovery update threw", err);
      }
    }
    const recovered = recoveries[0];
    const text = heartbeatMessage({
      refreshed_at: refreshedAt.toISOString(),
      running: store.runningRounds().length,
      max_concurrent: cfg.daemon.max_concurrent_rounds,
      queued: store.allPrs().filter((p) => p.state === "queued" && !p.paused).length,
      failed_loud: store.openReviewFailures().length,
      ...(recovered ? { recovered_incident: recovered.incident_id } : {}),
      dry_run: cfg.dry_run,
    });
    const existing = store.slackPost(HEARTBEAT_IDEM_KEY);
    if (existing?.ts) {
      try {
        const res = await slack.updateMessage({
          channel: cfg.slack.channel,
          ts: existing.ts,
          text,
        });
        if (!res.ok) this.log("slack: heartbeat update failed", res.error);
      } catch (err) {
        this.log("slack: heartbeat update threw", err);
      }
      return existing.ts;
    }
    const ts = await this.post({ idemKey: HEARTBEAT_IDEM_KEY, kind: "announce", text });
    if (ts) {
      // Pinning may be refused (`no_permission`) — the owner can pin by hand.
      try {
        const pin = await slack.pinsAdd({ channel: cfg.slack.channel, ts });
        if (!pin.ok) this.log(`slack: heartbeat pin skipped (${pin.error ?? "unknown"})`);
      } catch (err) {
        this.log("slack: heartbeat pin threw", err);
      }
    }
    return ts;
  }

  /** Drive the heartbeat on `heartbeat_interval_min`. Idempotent. */
  startHeartbeat(): void {
    if (!this.enabled || this.heartbeatTimer) return;
    void this.heartbeat();
    const every = Math.max(1, this.deps.cfg.slack.policy.heartbeat_interval_min) * 60_000;
    this.heartbeatTimer = this.setIntervalFn(() => void this.heartbeat(), every);
    unref(this.heartbeatTimer);
  }

  stopHeartbeat(): void {
    if (this.heartbeatTimer) this.clearIntervalFn(this.heartbeatTimer);
    this.heartbeatTimer = null;
  }

  // ---- ops signal (NOT a channel post) -----------------------------------

  /**
   * `hello.num_connections > 1` outside a deploy window means a second consumer
   * is eating our events. v1 ships ops signals OFF for the channel, so this
   * surfaces as an anomaly callback (the overseer-inject path) only, and only
   * when the count changes — a duplicate consumer is one event, not a stream.
   */
  noteConnections(numConnections: number, opts: { deployWindow?: boolean } = {}): void {
    const previous = this.lastConnections;
    this.lastConnections = numConnections;
    if (opts.deployWindow) return;
    if (numConnections <= 1 || numConnections === previous) return;
    const message =
      `Slack socket reports ${numConnections} connections outside a deploy window — ` +
      `a second consumer is receiving (and acking) our events. Check for a stray daemon or a duplicate container.`;
    this.log(`slack: ${message}`);
    void Promise.resolve(this.deps.onAnomalySignal?.(message)).catch((err) =>
      this.log("slack: anomaly signal failed", err),
    );
  }
}

/** Convenience for the wiring agent: an announcer that is only built when
 * Slack is on, so callers can pass `undefined` straight through. */
export function makeAnnouncer(deps: AnnouncerDeps): SlackAnnouncer | undefined {
  return deps.cfg.slack.enabled ? new SlackAnnouncer(deps) : undefined;
}

export type { CauseMessageInput, ReRoundReason };
