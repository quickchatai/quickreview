// `slack_reply` — the overseer's ONLY way to speak in Slack (S3).
//
// The session never holds a Slack token and never names a channel: it writes a
// command file with a thread ts and some text, and this executor decides
// whether that becomes a message. Five guards, all in daemon code:
//
//   channel binding  the channel is always cfg.slack.channel; the command has
//                    no channel field, so a wrong channel is unrepresentable.
//   thread known     the thread must be one we opened or one we were spoken to
//                    in — the bot cannot cold-start a conversation.
//   cap + cooldown   slack/policy.decideReply, same ledger as every other post.
//   length           truncated at cfg.slack.max_reply_chars.
//   idempotence      one post per command file, claimed before the API call.
//
// Escaping is not cosmetic: model output goes into a channel with humans in it,
// so `&<>` are escaped and a `<@U…>` mention is only ever emitted for an id the
// daemon itself resolved — never one pasted through from the model.
import type { Config } from "../config.js";
import type { FileOutcome } from "../improvements.js";
import type { StateStore } from "../state.js";
import { claimPost, decideReply } from "./policy.js";
import type { SlackWebApi } from "./types.js";

/** Slack message ts, always "1712345678.123456". */
export const SLACK_TS_RE = /^\d{10}\.\d{6}$/;

export const TRUNCATION_SUFFIX = "…(truncated)";

/**
 * Escape Slack's three control characters in model-produced text. Slack's own
 * rule (and the only one): `&` first, then `<` and `>`. This is what makes a
 * pasted `<@U0OWNER>` render as literal text instead of pinging a human.
 */
export function escapeSlackText(text: string): string {
  return text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

/** `<@U…>` for an id the DAEMON resolved from config; never from model text. */
export function mentionFor(cfg: Config, slackUser: string): string {
  return Object.prototype.hasOwnProperty.call(cfg.slack.users, slackUser) ? `<@${slackUser}>` : "";
}

/** Truncate to `max` characters, leaving room for the marker. */
export function truncateReply(text: string, max: number): string {
  if (max <= 0 || text.length <= max) return text;
  // The result NEVER exceeds `max`, even for a limit shorter than the marker.
  if (max <= TRUNCATION_SUFFIX.length) return text.slice(0, max);
  return text.slice(0, max - TRUNCATION_SUFFIX.length) + TRUNCATION_SUFFIX;
}

/**
 * Has the daemon ever seen this thread? Either it opened the thread for a PR,
 * or somebody spoke to it there (the message's own ts, or the parent it replied
 * under). `slack_events` has no by-ts accessor on StateStore — this is a
 * read-only probe over the table the router owns.
 */
export function threadIsKnown(store: StateStore, channel: string, threadTs: string): boolean {
  if (store.slackThreadByRoot(channel, threadTs)) return true;
  const row = store.db
    .prepare("SELECT 1 AS hit FROM slack_events WHERE channel = ? AND (ts = ? OR thread_ts = ?) LIMIT 1")
    .get(channel, threadTs, threadTs) as { hit: number } | undefined;
  return row !== undefined;
}

export interface SlackReplyDeps {
  cfg: Config;
  store: StateStore;
  api: Pick<SlackWebApi, "postMessage">;
  now?: () => Date;
  log?: (line: string) => void;
}

export interface SlackReplyInput {
  thread: string;
  text: string;
  /** Idempotence scope — the command file basename ("" for direct calls). */
  file?: string;
}

/** FNV-1a, so a direct (file-less) call still gets a stable idem key. */
function shortHash(s: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h.toString(16).padStart(8, "0");
}

/** `reply:<command file basename>` — one post per command file, forever. */
export function replyIdemKey(input: SlackReplyInput): string {
  const scope = input.file && input.file.length > 0 ? input.file : `${input.thread}:${shortHash(input.text)}`;
  return `reply:${scope}`;
}

/**
 * Build the `CommandDeps.slackReply` handler. Returns a FileOutcome so every
 * refusal lands in the command's result file, which is the overseer's only
 * feedback channel.
 */
export function makeSlackReply(deps: SlackReplyDeps): (input: SlackReplyInput) => Promise<FileOutcome> {
  const now = deps.now ?? (() => new Date());
  const log = deps.log ?? (() => {});
  return async (input: SlackReplyInput): Promise<FileOutcome> => {
    const cfg = deps.cfg;
    const store = deps.store;
    if (!cfg.slack.enabled || !cfg.slack.channel) {
      return { ok: false, reason: "slack is disabled — no channel to reply in" };
    }
    const channel = cfg.slack.channel; // never from the command: unrepresentable
    const thread = input.thread;
    if (!SLACK_TS_RE.test(thread)) return { ok: false, reason: `'thread' ${JSON.stringify(thread)} is not a Slack ts` };
    if (!threadIsKnown(store, channel, thread)) {
      return { ok: false, reason: `unknown thread ${thread} — the daemon only replies where it was spoken to` };
    }

    const idemKey = replyIdemKey(input);
    const decision = decideReply(store, cfg, { threadTs: thread, idemKey }, now());
    if (!decision.allow) {
      return { ok: false, reason: decision.reason ?? "slack reply refused", cap: decision.cap ?? null };
    }

    const text = truncateReply(escapeSlackText(input.text), cfg.slack.max_reply_chars);
    if (!claimPost(store, { idem_key: idemKey, kind: "reply", thread_ts: thread, chars: text.length })) {
      return { ok: false, reason: `already replied for this command (idem_key ${idemKey})` };
    }

    let result;
    try {
      result = await deps.api.postMessage({ channel, text, thread_ts: thread });
    } catch (err) {
      result = { ok: false, error: (err as Error).message };
    }
    store.settleSlackPost(idemKey, { ts: result.ts ?? null, ok: result.ok, error: result.error ?? null });
    if (!result.ok) {
      // A failed post is recorded and never blocks anything else.
      log(`[slack] reply to ${thread} failed: ${result.error ?? "unknown"}`);
      return { ok: false, reason: `slack post failed: ${result.error ?? "unknown"}` };
    }
    const pr = store.slackThreadByRoot(channel, thread)?.pr;
    if (pr !== undefined) store.touchSlackThread(pr);
    store.logEvent("slack_reply_posted", pr ?? null, { thread, ts: result.ts, chars: text.length });
    return { ok: true, thread, ts: result.ts, chars: text.length, truncated: text.endsWith(TRUNCATION_SUFFIX) };
  };
}
