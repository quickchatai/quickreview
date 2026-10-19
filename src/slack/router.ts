// The inbound router: one Slack message -> one row, never a turn. The overseer
// is retired (its duties moved to the companion, whose inbox is fed by the
// daemon, not by Slack), so an inbound message reaches NO model: the router
// refuses every message that clears the gates below with `dropped_no_overseer`.
// Every drop is a ROW, not a log line — `slack_events` is the forensic record,
// so "why did the bot ignore me?" is answerable from sqlite alone. Outbound
// announcements and replies are unchanged.
//
// The checks run in a fixed order and each has exactly one disposition:
//   1. channel   -> dropped_channel   (only cfg.slack.channel is ever handled)
//   2. echo      -> dropped_echo      (three independent layers, see below;
//                                      a user-less event lands here too — it is
//                                      machine text, not a person)
//   3. subtype   -> dropped_subtype   (only the plain message is a message)
//   4. dedupe    -> dropped_dupe      (Slack redelivers on every missed ack)
//   5. retired   -> dropped_no_overseer (a person's plain message: there is no
//                                      session to hand it to)
//
// The router will never take a channel id from a message, nor a tier from
// message text. Both come from config + the recorded Slack user id.
import type { Config } from "../config.js";
import type { SlackDisposition, SlackTier, StateStore } from "../state.js";
import { isoSeconds } from "./messages.js";
import type { SlackIdentity, SlackInboundEvent } from "./types.js";

/** The header marker the overseer's appendix keys the Slack envelope off. */
export const SLACK_INJECT_MARKER = "<!-- qcr:slack v1 -->";

/**
 * The only inbound shape that becomes a model turn: a plain message with no
 * subtype. `message_changed` is the important one — an EDIT NEVER RE-TRIGGERS
 * an answer, otherwise a user could rewrite history under an answer already
 * given (and a bot editing its own message would loop).
 */
function isPlainMessage(ev: SlackInboundEvent): boolean {
  return (
    ev.type === "message" && (ev.subtype === undefined || ev.subtype === null || ev.subtype === "")
  );
}

/** Has the daemon itself posted a message with this ts? (echo layer b) */
function isOwnPostedTs(store: StateStore, ts: string): boolean {
  // slack_posts has no by-ts accessor on StateStore; this is a read-only probe
  // over the same table the post ledger owns.
  const row = store.db.prepare("SELECT 1 AS hit FROM slack_posts WHERE ts = ? LIMIT 1").get(ts) as
    { hit: number } | undefined;
  return row !== undefined;
}

/** Rights tier of a Slack member id. Config is the ONLY input besides the id. */
export function computeTier(cfg: Config, slackUser: string | null | undefined): SlackTier {
  if (!slackUser) return "ignored";
  // The configured owner (`[owner] slack_id`) gets the top rights tier.
  // Persisted records carrying a legacy spelling of this tier are folded to
  // "owner" on read (`foldSlackTier`); `system` is never computed here — it is
  // stamped only by OriginStore.writeLocal for daemon turns.
  if (cfg.owner.slack_id && slackUser === cfg.owner.slack_id) return "owner";
  if (Object.prototype.hasOwnProperty.call(cfg.slack.users, slackUser)) return "author";
  // An unmapped id gets read-only everything, but NO own-PR
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
 * For the owner this list is their own PRs too, and it is deliberately NOT
 * their authority: `authorizeCommand` lets tier `owner` act on any PR, so an
 * empty list costs them nothing. Keeping the field honest (their real PRs)
 * means the inject body reads the same for everyone.
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
 * own `<!-- qcr:slack v1 -->` + `| tier | owner |` must end up with inert
 * characters: every line is blockquoted, pipes are escaped so no line can be a
 * table row, and comment delimiters are HTML-escaped so no line can be the
 * marker.
 */
export function quoteUserText(text: string): string {
  const body = (text ?? "").replace(/\r\n?/g, "\n");
  const lines = body.length === 0 ? ["(no text)"] : body.split("\n");
  return lines.map((line) => `> ${inertLine(line)}`.trimEnd()).join("\n");
}

/** One line of user-controlled text made inert inside the envelope: comment
 * delimiters HTML-escaped (never the marker), pipes escaped (never a cell). */
function inertLine(line: string): string {
  return line
    .replace(/<!--/g, "&lt;!&#45;&#45;")
    .replace(/-->/g, "&#45;&#45;&gt;")
    .replace(/\|/g, "\\|");
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

/** The inject envelope: marker, trusted field table, then the quoted message. */
export function buildInjectBody(input: InjectBodyInput): string {
  const dash = "—";
  // The display name is user-chosen, so it gets the quoted body's escaping —
  // it sits in the part of the envelope the appendix says to trust.
  const displayName = inertLine(input.displayName.replace(/\s+/g, " "));
  const rows: Array<[string, string]> = [
    ["source", "slack"],
    ["event_id", input.event.event_id],
    ["channel", input.event.channel],
    ["thread", input.threadTs],
    ["thread_pr", input.threadPr === null ? dash : String(input.threadPr)],
    ["slack_user", input.event.user ?? dash],
    ["display_name", displayName],
    ["github_login", input.githubLogin ?? dash],
    ["tier", input.tier],
    ["authorized_prs", input.authorizedPrs.length ? input.authorizedPrs.join(", ") : dash],
    ["received_at", isoSeconds(input.receivedAt.toISOString())],
  ];
  const table = [
    "| field | value |",
    "| --- | --- |",
    ...rows.map(([k, v]) => `| ${k} | ${v} |`),
  ].join("\n");
  const where = input.threadPr === null ? "in the channel" : `in thread for PR #${input.threadPr}`;
  return [
    SLACK_INJECT_MARKER,
    table,
    "",
    `**${displayName}** ${where} said:`,
    "",
    quoteUserText(input.event.text),
    "",
    `Reply by writing a \`slack_reply\` command file with \`thread: "${input.threadTs}"\`.`,
    `Your tier for this turn is **${input.tier}** — see the Slack appendix in your system prompt.`,
    "",
  ].join("\n");
}

export interface SlackRouterDeps {
  cfg: Config;
  store: StateStore;
  /** Our own identity, resolved ONCE at boot (echo layer a). */
  identity?: SlackIdentity | null;
}

export interface RouteResult {
  disposition: SlackDisposition;
  tier: SlackTier;
  reason?: string;
}

export class SlackRouter {
  constructor(private readonly deps: SlackRouterDeps) {}

  /** Route one inbound event: one row, and never a turn. */
  async handle(event: SlackInboundEvent): Promise<RouteResult> {
    const cfg = this.deps.cfg;
    const store = this.deps.store;
    const tier = computeTier(cfg, event.user);

    // (1) channel allowlist — a message from anywhere else is not our business.
    if (event.channel !== cfg.slack.channel) {
      return this.record(
        event,
        "ignored",
        "dropped_channel",
        `channel ${event.channel} is not the concierge channel`,
      );
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
      return this.record(
        event,
        "ignored",
        "dropped_echo",
        "message was posted by a bot (or by us)",
      );
    }

    // (2b) no Slack user id ⇒ nobody asked anything. Such an event has no tier
    //      (`computeTier` says `ignored`). It is machine-emitted text, which is
    //      exactly what `dropped_echo` means.
    if (tier === "ignored") {
      return this.record(
        event,
        "ignored",
        "dropped_echo",
        "message carries no Slack user — not a person asking",
      );
    }

    // (3) subtype allowlist — edits, deletions, joins and broadcasts are logged,
    //     never answered.
    if (!isPlainMessage(event)) {
      return this.record(
        event,
        tier,
        "dropped_subtype",
        `subtype '${event.subtype ?? event.type}' is not answerable`,
      );
    }

    // (4) dedupe, then (5) refuse. The row is written with its final
    //     disposition in one insert, so a redelivery loses the race and reports
    //     `dropped_dupe` while the original row stands. Nothing past this point
    //     exists: the overseer a turn would have gone to is retired, so a plain
    //     message from a person is recorded and goes no further.
    return this.record(
      event,
      tier,
      "dropped_no_overseer",
      "Slack inbound turns are retired: there is no overseer to hand a message to",
    );
  }

  /** Record a pre-dedupe drop. A redelivered drop reports `dropped_dupe` and
   * leaves the original row (and its disposition) untouched. */
  private record(
    event: SlackInboundEvent,
    tier: SlackTier,
    disposition: SlackDisposition,
    reason: string,
  ): RouteResult {
    if (!this.insertRow(event, tier, disposition)) return this.dupe(event, tier);
    return { disposition, tier, reason };
  }

  /** Insert the event's dedupe row; false when the event id already has one. */
  private insertRow(
    event: SlackInboundEvent,
    tier: SlackTier,
    disposition: SlackDisposition,
  ): boolean {
    return this.deps.store.recordSlackEvent({
      event_id: event.event_id,
      channel: event.channel,
      ts: event.ts,
      thread_ts: event.thread_ts ?? null,
      slack_user: event.user ?? null,
      tier,
      disposition,
    });
  }

  private dupe(event: SlackInboundEvent, tier: SlackTier): RouteResult {
    return {
      disposition: "dropped_dupe",
      tier,
      reason: `event ${event.event_id} was already handled`,
    };
  }
}
