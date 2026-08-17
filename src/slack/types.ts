// The Slack transport seam (S1). ONE interface behind which both
// halves of Slack live: inbound over Socket Mode (the only inbound transport —
// there is no HTTP Events endpoint, ever) and outbound over the Web API.
// Everything above this seam (router, concierge, overseer bridge) codes against
// `SlackTransport` and is faked in tests exactly like the GitHub fetch is.
//
// Invariant: every Slack `ts` is a STRING, always. "1712345678.123456" is not a
// float — parsing it as a number silently loses precision and breaks threading.

/** fetch stand-in, injected so tests can script HTTP responses. */
export type SlackFetchFn = typeof fetch;

/** A normalized inbound Slack message, as everything above the seam sees it. */
export interface SlackInboundEvent {
  /** Slack's per-delivery id (`envelope.payload.event_id`) — the dedupe key. */
  event_id: string;
  /** Slack event type; S1 only ever emits `"message"`. */
  type: string;
  /** Channel id the message landed in (C…/G…/D…). */
  channel: string;
  /** Message timestamp — string, always; also the thread key when it is a root. */
  ts: string;
  /** Parent message ts when the message is a threaded reply. */
  thread_ts?: string;
  /** Author user id (absent for some bot/system messages). */
  user?: string;
  /** Message text (may be empty for attachment-only messages). */
  text: string;
  /** Message subtype (`bot_message`, `message_changed`, `channel_join`, …). */
  subtype?: string;
  /** Bot id when the message was posted by a bot — including our own. */
  bot_id?: string;
  /** Event timestamp from the envelope payload (string, always). */
  event_ts: string;
}

/** Handler the socket half calls once per normalized inbound event. */
export type SlackInboundHandler = (event: SlackInboundEvent) => void | Promise<void>;

/** Outcome of a post/update. Never throws into callers — failures are values. */
export interface SlackPostResult {
  /** True when Slack accepted the call. */
  ok: boolean;
  /** Message ts on success (string, always). */
  ts?: string;
  /** Slack error code (`rate_limited`, `channel_not_found`, …) or a local reason. */
  error?: string;
}

/** A resolved Slack user, for id -> human name rendering. */
export interface SlackUserInfo {
  /** User id (U…). */
  id: string;
  /** Best display name: profile display_name, else real_name, else the id. */
  display_name: string;
  /** Whether Slack marks the user as a bot. */
  is_bot: boolean;
}

/** Our own identity, from auth.test — used to ignore our own echoes. */
export interface SlackIdentity {
  /** Our bot user id (U…), the one @-mentions resolve to. */
  user_id: string;
  /** Our bot id (B…), as it appears on messages we post. */
  bot_id?: string;
  /** Workspace/team id. */
  team_id?: string;
}

/** Outbound half of the seam — Slack Web API calls. */
export interface SlackWebApi {
  /** Post a message (optionally into a thread). Serialized + rate-limited. */
  postMessage(args: { channel: string; text: string; thread_ts?: string }): Promise<SlackPostResult>;
  /** Edit a message we posted, addressed by its ts. */
  updateMessage(args: { channel: string; ts: string; text: string }): Promise<SlackPostResult>;
  /** Resolve a user id to a display name (memoized with a TTL). */
  usersInfo(userId: string): Promise<SlackUserInfo | undefined>;
  /** Our own identity; undefined when the call fails. */
  authTest(): Promise<SlackIdentity | undefined>;
  /** Best-effort pin. May fail (`no_permission`); callers ignore the outcome. */
  pinsAdd(args: { channel: string; ts: string }): Promise<SlackPostResult>;
}

/** Inbound half of the seam — Socket Mode. */
export interface SlackSocket {
  /** Connect and stream normalized message events to `handler`. */
  startSocket(handler: SlackInboundHandler): Promise<void>;
  /** Stop reconnecting and close the socket. */
  stopSocket(): Promise<void>;
  /**
   * `num_connections` from the last `hello` frame (0 before the first hello).
   * >1 outside a deploy window means a duplicate consumer — S4 raises it.
   */
  readonly numConnections: number;
}

/** The one seam. Composed from the socket half and the Web API half. */
export interface SlackTransport extends SlackWebApi, SlackSocket {}
