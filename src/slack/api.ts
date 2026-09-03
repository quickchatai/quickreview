// Slack Web API poster (S1) — plain global fetch, no SDK.
//
// Two hard properties:
//   1. ONE serialized post queue with a minimum interval between message posts,
//      so we never trip Slack's per-channel rate limit.
//   2. Slack delivery NEVER blocks a verdict, a label or a round: a failing
//      post is retried twice, then logged and dropped. Nothing throws into
//      callers — failures come back as `{ ok: false, error }`.
//
// This class reads no config and no files: tokens and intervals arrive as
// plain options (S2 owns config).
import type {
  SlackFetchFn,
  SlackIdentity,
  SlackPostResult,
  SlackUserInfo,
  SlackWebApi,
} from "./types.js";

export interface SlackApiOptions {
  /** Bot token (`xoxb-…`) — Bearer on every call. */
  botToken: string;
  /** Injected fetch (default: global fetch). */
  fetchFn?: SlackFetchFn;
  /** Minimum spacing between outbound message posts, ms. */
  postMinIntervalMs?: number;
  /** users.info memo TTL, seconds. */
  userCacheTtlSec?: number;
  /** Web API base (override in tests). */
  apiBase?: string;
  /** Clock seam. */
  now?: () => number;
  /** Timer seam. */
  setTimeoutFn?: (fn: () => void, ms: number) => unknown;
  /** Structured log sink. */
  log?: (message: string, meta?: Record<string, unknown>) => void;
}

const DEFAULT_POST_MIN_INTERVAL_MS = 1100;
const DEFAULT_USER_CACHE_TTL_SEC = 86_400;
/** One initial attempt + this many retries. */
const RETRIES = 2;
/** Cap on an honored Retry-After, so a hostile header cannot wedge the queue. */
const MAX_RETRY_AFTER_MS = 60_000;

interface SlackApiResponse {
  ok?: boolean;
  error?: string;
  ts?: string;
  [k: string]: unknown;
}

export class SlackApiClient implements SlackWebApi {
  private readonly botToken: string;
  private readonly fetchFn: SlackFetchFn;
  private readonly postMinIntervalMs: number;
  private readonly userCacheTtlMs: number;
  private readonly apiBase: string;
  private readonly now: () => number;
  private readonly setTimeoutFn: (fn: () => void, ms: number) => unknown;
  private readonly log: (message: string, meta?: Record<string, unknown>) => void;

  /** The single serialized post chain. */
  private queue: Promise<unknown> = Promise.resolve();
  private lastPostAt = Number.NEGATIVE_INFINITY;
  private readonly userCache = new Map<string, { at: number; info: SlackUserInfo }>();

  constructor(opts: SlackApiOptions) {
    this.botToken = opts.botToken;
    this.fetchFn = opts.fetchFn ?? fetch;
    this.postMinIntervalMs = opts.postMinIntervalMs ?? DEFAULT_POST_MIN_INTERVAL_MS;
    this.userCacheTtlMs = (opts.userCacheTtlSec ?? DEFAULT_USER_CACHE_TTL_SEC) * 1000;
    this.apiBase = opts.apiBase ?? "https://slack.com/api";
    this.now = opts.now ?? Date.now;
    this.setTimeoutFn = opts.setTimeoutFn ?? ((fn, ms) => setTimeout(fn, ms));
    this.log = opts.log ?? (() => {});
  }

  postMessage(args: {
    channel: string;
    text: string;
    thread_ts?: string;
  }): Promise<SlackPostResult> {
    const body: Record<string, unknown> = { channel: args.channel, text: args.text };
    if (args.thread_ts) body["thread_ts"] = args.thread_ts;
    return this.enqueuePost("chat.postMessage", body);
  }

  updateMessage(args: { channel: string; ts: string; text: string }): Promise<SlackPostResult> {
    return this.enqueuePost("chat.update", { channel: args.channel, ts: args.ts, text: args.text });
  }

  /** Best-effort: not queued, failures are expected (`no_permission`). */
  async pinsAdd(args: { channel: string; ts: string }): Promise<SlackPostResult> {
    const out = await this.callOnce("pins.add", { channel: args.channel, timestamp: args.ts });
    if (!out.ok) this.log("slack.api.pin_failed", { error: out.error });
    return out.ok ? { ok: true } : { ok: false, error: out.error ?? "unknown" };
  }

  async authTest(): Promise<SlackIdentity | undefined> {
    const res = await this.callOnce("auth.test", {});
    if (!res.ok || !res.raw) return undefined;
    const raw = res.raw;
    const userId = typeof raw["user_id"] === "string" ? raw["user_id"] : "";
    if (!userId) return undefined;
    return {
      user_id: userId,
      ...(typeof raw["bot_id"] === "string" ? { bot_id: raw["bot_id"] } : {}),
      ...(typeof raw["team_id"] === "string" ? { team_id: raw["team_id"] } : {}),
    };
  }

  async usersInfo(userId: string): Promise<SlackUserInfo | undefined> {
    const hit = this.userCache.get(userId);
    if (hit && this.now() - hit.at < this.userCacheTtlMs) return hit.info;

    const res = await this.callOnce("users.info", { user: userId });
    if (!res.ok || !res.raw) return undefined;
    const user = res.raw["user"] as
      | {
          id?: string;
          name?: string;
          real_name?: string;
          is_bot?: boolean;
          profile?: { display_name?: string; real_name?: string };
        }
      | undefined;
    if (!user) return undefined;
    const info: SlackUserInfo = {
      id: user.id ?? userId,
      display_name:
        user.profile?.display_name?.trim() ||
        user.profile?.real_name?.trim() ||
        user.real_name?.trim() ||
        user.name?.trim() ||
        userId,
      is_bot: user.is_bot === true,
    };
    this.userCache.set(userId, { at: this.now(), info });
    return info;
  }

  // ---- the serialized post queue -------------------------------------------

  private enqueuePost(method: string, body: Record<string, unknown>): Promise<SlackPostResult> {
    const run = this.queue.then(async () => {
      await this.spaceOut();
      const result = await this.callWithRetries(method, body);
      this.lastPostAt = this.now();
      return result;
    });
    // Keep the chain alive even if a link somehow rejects.
    this.queue = run.then(
      () => undefined,
      () => undefined,
    );
    return run;
  }

  private async spaceOut(): Promise<void> {
    const wait = this.lastPostAt + this.postMinIntervalMs - this.now();
    if (wait > 0) await this.sleep(wait);
  }

  private sleep(ms: number): Promise<void> {
    return new Promise<void>((resolve) => {
      this.setTimeoutFn(() => resolve(), ms);
    });
  }

  /** Initial attempt + 2 retries, then log and drop. Never throws. */
  private async callWithRetries(
    method: string,
    body: Record<string, unknown>,
  ): Promise<SlackPostResult> {
    let last: CallOutcome = { ok: false, error: "unknown" };
    for (let attempt = 0; attempt <= RETRIES; attempt += 1) {
      last = await this.callOnce(method, body);
      if (last.ok) return { ok: true, ...(last.ts ? { ts: last.ts } : {}) };
      if (attempt === RETRIES) break;
      const wait = last.retryAfterMs ?? this.postMinIntervalMs;
      this.log("slack.api.retry", {
        method,
        attempt: attempt + 1,
        wait_ms: wait,
        error: last.error,
      });
      await this.sleep(wait);
    }
    // Dropped, deliberately: Slack must never block a verdict, label or round.
    this.log("slack.api.dropped", { method, error: last.error });
    return { ok: false, error: last.error ?? "unknown" };
  }

  /** One HTTP call. Swallows everything; returns an outcome. */
  private async callOnce(method: string, body: Record<string, unknown>): Promise<CallOutcome> {
    try {
      const res = await this.fetchFn(`${this.apiBase}/${method}`, {
        method: "POST",
        headers: {
          authorization: `Bearer ${this.botToken}`,
          "content-type": "application/json; charset=utf-8",
        },
        body: JSON.stringify(body),
      });
      if (res.status === 429) {
        return { ok: false, error: "rate_limited", retryAfterMs: this.retryAfterMs(res) };
      }
      let payload: SlackApiResponse;
      try {
        payload = (await res.json()) as SlackApiResponse;
      } catch {
        return { ok: false, error: `bad_json_${res.status}` };
      }
      if (!res.ok || payload?.ok !== true) {
        return { ok: false, error: payload?.error ?? `http_${res.status}` };
      }
      // ts is a string, always — never coerce it to a number.
      const ts = typeof payload.ts === "string" ? payload.ts : undefined;
      return { ok: true, ...(ts ? { ts } : {}), raw: payload };
    } catch (err) {
      return { ok: false, error: String(err) };
    }
  }

  private retryAfterMs(res: Response): number {
    const raw = res.headers?.get?.("retry-after");
    const secs = Number(raw);
    if (!Number.isFinite(secs) || secs <= 0) return this.postMinIntervalMs;
    return Math.min(secs * 1000, MAX_RETRY_AFTER_MS);
  }
}

interface CallOutcome {
  ok: boolean;
  ts?: string;
  error?: string;
  retryAfterMs?: number;
  raw?: SlackApiResponse;
}
