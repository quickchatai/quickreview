// The inbound router (S3): one Slack message -> at most one overseer
// turn. Every drop is a ROW, not a log line — `slack_events` is the forensic
// record, so "why did the bot ignore me?" is answerable from sqlite alone.
//
// The checks run in a fixed order and each has exactly one disposition:
//   1. channel   -> dropped_channel   (only cfg.slack.channel is ever handled)
//   2. echo      -> dropped_echo      (three independent layers, see below)
//   3. subtype   -> dropped_subtype   (only the plain message is a turn)
//   4. dedupe    -> dropped_dupe      (Slack redelivers on every missed ack)
//   5. stale     -> dropped_stale     (backlog older than catchup_max_age_s)
//   6. turn cap  -> dropped_cap       (asked BEFORE the model, never after)
//
// Two things the router will never do: take a channel id from a message, and
// take a tier from message text. Both come from config + the recorded Slack
// user id, which is why a pasted "| tier | owner_legacy |" table is inert.
import type { Config } from "../config.js";
import type { SlackDisposition, SlackTier, StateStore } from "../state.js";
import { decideTurn, type TurnDecision } from "./policy.js";
import type { OriginStore } from "./origin.js";
import type { SlackIdentity, SlackInboundEvent, SlackWebApi } from "./types.js";

/** The header marker the overseer's appendix keys the Slack envelope off. */
export const SLACK_INJECT_MARKER = "<!-- qcr:slack v1 -->";

/**
 * The only inbound shape that becomes a model turn: a plain message with no
 * subtype. `message_changed` is the important one — an EDIT NEVER RE-TRIGGERS
 * an answer, otherwise a user could rewrite history under an answer already
 * given (and a bot editing its own message would loop).
 */
function isPlainMessage(ev: SlackInboundEvent): boolean {
  return ev.type === "message" && (ev.subtype === undefined || ev.subtype === null || ev.subtype === "");
}

/** Has the daemon itself posted a message with this ts? (echo layer b) */
export function isOwnPostedTs(store: StateStore, ts: string): boolean {
  // slack_posts has no by-ts accessor on StateStore; this is a read-only probe
  // over the same table the post ledger owns.
  const row = store.db.prepare("SELECT 1 AS hit FROM slack_posts WHERE ts = ? LIMIT 1").get(ts) as
    | { hit: number }
    | undefined;
  return row !== undefined;
}

/** Rights tier of a Slack member id. Config is the ONLY input besides the id. */
export function computeTier(cfg: Config, slackUser: string | null | undefined): SlackTier {
  if (!slackUser) return "ignored";
  if (cfg.slack.legacy_owner_slack_id && slackUser === cfg.slack.legacy_owner_slack_id) return "owner_legacy";
  if (Object.prototype.hasOwnProperty.call(cfg.slack.users, slackUser)) return "author";
  // Ratified widening: an unmapped id gets read-only everything, but NO own-PR
  // resolution — there is no login to resolve, so it must name PRs by number.
  return "anyone";
}

/** GitHub login for a Slack id, or null when the id is unmapped. */
export function githubLoginFor(cfg: Config, slackUser: string | null | undefined): string | null {
  if (!slackUser) return null;
  return cfg.slack.users[slackUser] ?? null;
}

/**
 * Open PRs authored by `login`. Empty for an unmapped id — an `anyone` turn can
 * never resolve author->PR, by construction.
 *
 * For the owner this list is his own PRs too, and it is deliberately NOT his
 * authority: `authorizeCommand` lets tier `owner_legacy` act on any PR, so an empty
 * list costs him nothing. Keeping the field honest (his real PRs) means the
 * inject body reads the same for everyone.
 */
export function authorizedPrs(store: StateStore, login: string | null): number[] {
  if (!login) return [];
  return store
    .allPrs()
    .filter((p) => p.state !== "closed" && p.author.toLowerCase() === login.toLowerCase())
    .map((p) => p.number);
}

/**
 * Neutralise user text so it cannot forge the inject header.
 *
 * The overseer reads one markdown document; the top of it is a trusted table
 * written by the daemon and the rest is a quoted human. A user who pastes their
 * own `<!-- qcr:slack v1 -->` + `| tier | owner_legacy |` must end up with inert
 * characters: every line is blockquoted, pipes are escaped so no line can be a
 * table row, and comment delimiters are HTML-escaped so no line can be the
 * marker.
 */
export function quoteUserText(text: string): string {
  const body = (text ?? "").replace(/\r\n?/g, "\n");
  const lines = body.length === 0 ? ["(no text)"] : body.split("\n");
  return lines
    .map((line) => {
      const safe = line
        .replace(/<!--/g, "&lt;!&#45;&#45;")
        .replace(/-->/g, "&#45;&#45;&gt;")
        .replace(/\|/g, "\\|");
      return `> ${safe}`.trimEnd();
    })
    .join("\n");
}

function isoSeconds(d: Date): string {
  return `${d.toISOString().slice(0, 19)}Z`;
}

export interface InjectBodyInput {
  event: SlackInboundEvent;
  /** Root ts of the thread a reply must target. */
  threadTs: string;
  /** PR bound to that thread, when known. */
  threadPr: number | null;
  displayName: string;
  githubLogin: string | null;
  tier: SlackTier;
  authorizedPrs: number[];
  receivedAt: Date;
}

/** The exact envelope from the annex §3.2. */
export function buildInjectBody(input: InjectBodyInput): string {
  const dash = "—";
  const rows: Array<[string, string]> = [
    ["source", "slack"],
    ["event_id", input.event.event_id],
    ["channel", input.event.channel],
    ["thread", input.threadTs],
    ["thread_pr", input.threadPr === null ? dash : String(input.threadPr)],
    ["slack_user", input.event.user ?? dash],
    ["display_name", input.displayName],
    ["github_login", input.githubLogin ?? dash],
    ["tier", input.tier],
    ["authorized_prs", input.authorizedPrs.length ? input.authorizedPrs.join(", ") : dash],
    ["received_at", isoSeconds(input.receivedAt)],
  ];
  const table = ["| field | value |", "| --- | --- |", ...rows.map(([k, v]) => `| ${k} | ${v} |`)].join("\n");
  const where = input.threadPr === null ? "in the channel" : `in thread for PR #${input.threadPr}`;
  return [
    SLACK_INJECT_MARKER,
    table,
    "",
    `**${input.displayName}** ${where} said:`,
    "",
    quoteUserText(input.event.text),
    "",
    `Reply by writing a \`slack_reply\` command file with \`thread: "${input.threadTs}"\`.`,
    `Your tier for this turn is **${input.tier}** — see the Slack appendix in your system prompt.`,
    "",
  ].join("\n");
}

/**
 * Drops a wake file on the overseer and returns its BASENAME when it can.
 * `SessionHooks.injectOverseer` returns void, so wiring passes a thin wrapper
 * over PiSessionManager.injectFile (which does return the path) — the router
 * binds the origin record to whatever name comes back, and falls back to the
 * event id when the injector is the plain void-returning hook.
 */
export type OverseerInjector = (message: string) => Promise<string | void> | string | void;

export interface SlackRouterDeps {
  cfg: Config;
  store: StateStore;
  origins: OriginStore;
  inject: OverseerInjector;
  /** Name resolution only. The router never calls auth.test itself. */
  users: Pick<SlackWebApi, "usersInfo">;
  /** Our own identity, resolved ONCE at boot (echo layer a). */
  identity?: SlackIdentity | null;
  /** Fired when a turn was refused by a cap. The announcer (S4) owns the
   * user-visible message — the router only reports. */
  onCapReached?: (decision: TurnDecision, event: SlackInboundEvent) => void | Promise<void>;
  now?: () => Date;
  log?: (line: string) => void;
}

export interface RouteResult {
  disposition: SlackDisposition;
  tier: SlackTier;
  /** Set only when disposition is `injected`. */
  injectBasename?: string;
  reason?: string;
}

export class SlackRouter {
  private readonly now: () => Date;
  private readonly log: (line: string) => void;

  constructor(private readonly deps: SlackRouterDeps) {
    this.now = deps.now ?? (() => new Date());
    this.log = deps.log ?? (() => {});
  }

  /** Route one inbound event. Never throws into the socket loop. */
  async handle(event: SlackInboundEvent): Promise<RouteResult> {
    const cfg = this.deps.cfg;
    const store = this.deps.store;
    const tier = computeTier(cfg, event.user);

    // (1) channel allowlist — a message from anywhere else is not our business.
    if (event.channel !== cfg.slack.channel) {
      return this.record(event, "ignored", "dropped_channel", `channel ${event.channel} is not the concierge channel`);
    }

    // (2) echo, three layers. (a) it is a bot / it is us, (b) we posted this ts.
    const ownUserId = this.deps.identity?.user_id;
    const ownBotId = this.deps.identity?.bot_id;
    const looksLikeUs =
      event.bot_id !== undefined ||
      event.subtype === "bot_message" ||
      (ownUserId !== undefined && event.user === ownUserId) ||
      (ownBotId !== undefined && event.bot_id === ownBotId);
    if (looksLikeUs || isOwnPostedTs(store, event.ts)) {
      return this.record(event, "ignored", "dropped_echo", "message was posted by a bot (or by us)");
    }

    // (3) subtype allowlist — edits, deletions, joins and broadcasts are logged,
    //     never answered.
    if (!isPlainMessage(event)) {
      return this.record(event, tier, "dropped_subtype", `subtype '${event.subtype ?? event.type}' is not answerable`);
    }

    // (4) dedupe. The row is inserted BEFORE any work; a redelivery loses the
    //     race and is dropped, so at-least-once delivery becomes exactly-once
    //     injection. The provisional disposition is a DROP: if the daemon dies
    //     mid-turn the event stays un-injected (fail closed), and it costs no
    //     turn budget (only `injected` rows count).
    const created = store.recordSlackEvent({
      event_id: event.event_id,
      channel: event.channel,
      ts: event.ts,
      thread_ts: event.thread_ts ?? null,
      slack_user: event.user ?? null,
      tier,
      disposition: "dropped_stale",
    });
    if (!created) {
      return { disposition: "dropped_dupe", tier, reason: `event ${event.event_id} was already handled` };
    }

    // (5) staleness — a reconnect backlog is history, not a conversation. The
    //     boot announcement owns the honesty about the gap.
    const ageS = (this.now().getTime() - Number.parseFloat(event.event_ts) * 1000) / 1000;
    if (Number.isFinite(ageS) && ageS > cfg.slack.catchup_max_age_s) {
      store.setSlackEventDisposition(event.event_id, "dropped_stale");
      return { disposition: "dropped_stale", tier, reason: `event is ${Math.round(ageS)}s old` };
    }

    // (6) caps, BEFORE the model is asked anything at all.
    const decision = decideTurn(store, cfg, { slackUser: event.user ?? null }, this.now());
    if (!decision.allow) {
      store.setSlackEventDisposition(event.event_id, "dropped_cap");
      if (decision.cap && this.deps.onCapReached) {
        try {
          await this.deps.onCapReached(decision, event);
        } catch (err) {
          this.log(`[slack] cap announcement failed: ${String(err)}`);
        }
      }
      return { disposition: "dropped_cap", tier, reason: decision.reason };
    }

    // ---- admitted: resolve identity, write the rights down, then inject ----
    const threadTs = event.thread_ts ?? event.ts;
    const threadPr = store.slackThreadByRoot(cfg.slack.channel, threadTs)?.pr ?? null;
    const login = githubLoginFor(cfg, event.user);
    const prs = authorizedPrs(store, login);
    let displayName = event.user ?? "someone";
    try {
      const info = await this.deps.users.usersInfo(event.user ?? "");
      if (info?.display_name) displayName = info.display_name;
    } catch {
      /* name resolution is cosmetic — never block a turn on it */
    }

    const body = buildInjectBody({
      event,
      threadTs,
      threadPr,
      displayName,
      githubLogin: login,
      tier,
      authorizedPrs: prs,
      receivedAt: this.now(),
    });

    const returned = await this.deps.inject(body);
    const injectBasename = typeof returned === "string" && returned.length > 0 ? baseName(returned) : `event-${event.event_id}`;
    // The origin is written AFTER the inject file exists: an origin without a
    // turn would authorise a command nobody asked for.
    this.deps.origins.write(injectBasename, {
      event_id: event.event_id,
      slack_user: event.user ?? "",
      tier,
      authorized_prs: prs,
    });
    store.setSlackEventDisposition(event.event_id, "injected");
    return { disposition: "injected", tier, injectBasename };
  }

  /** Record a pre-dedupe drop. A redelivered drop reports `dropped_dupe` and
   * leaves the original row (and its disposition) untouched. */
  private record(event: SlackInboundEvent, tier: SlackTier, disposition: SlackDisposition, reason: string): RouteResult {
    const created = this.deps.store.recordSlackEvent({
      event_id: event.event_id,
      channel: event.channel,
      ts: event.ts,
      thread_ts: event.thread_ts ?? null,
      slack_user: event.user ?? null,
      tier,
      disposition,
    });
    if (!created) return { disposition: "dropped_dupe", tier, reason: `event ${event.event_id} was already handled` };
    return { disposition, tier, reason };
  }
}

function baseName(path: string): string {
  const parts = path.split("/");
  return parts[parts.length - 1] ?? path;
}
