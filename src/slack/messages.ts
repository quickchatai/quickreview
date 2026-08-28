// The RATIFIED Slack message templates (S4, annex §1-2).
//
// Pure functions, zero I/O: every announcement the daemon can make is rendered
// here from data the daemon already has, so the wording is testable byte for
// byte and can never drift into a model's hands. House style, non-negotiable:
// one line of status, one short paragraph at most, one link. Plain mrkdwn in
// `text` — NO Block Kit anywhere.
//
// Two invariants live in this file:
//   * every interpolated user-derived string (titles, summaries, reasons,
//     author replies) goes through `escapeMrkdwn` — Slack's `&`/`<`/`>` are the
//     only three characters that can turn text into markup;
//   * `{author_ref}` is a real `<@U…>` mention ONLY when [slack.users] maps the
//     GitHub login. Otherwise it is the bare login as PLAIN TEXT — a fabricated
//     mention pings a stranger, so it is never constructed.
//
// CLAUDE.md hard rule 2 shows up here as a WORDING rule: nothing the daemon
// says may claim a review was dismissed. Superseding is "read the newest one".
import type { Config } from "../config.js";
import type { RoundType, Verdict } from "../types.js";

/** Slack mrkdwn escaping — `&` first, or the other two double-escape. */
export function escapeMrkdwn(text: string): string {
  return text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

/** Hard character budget, with an ellipsis when it bites. */
export function truncate(text: string, max: number): string {
  return text.length <= max ? text : `${text.slice(0, Math.max(0, max - 1))}…`;
}

/** The 7-char sha every GitHub UI shows. */
export function shortSha(sha: string): string {
  return (sha ?? "").slice(0, 7);
}

/** `<@U…>` for a known Slack id. Never call this with an unmapped login. */
export function mention(slackUserId: string): string {
  return `<@${slackUserId}>`;
}

/**
 * A GitHub login rendered for Slack: a mention when [slack.users] maps it,
 * otherwise the escaped bare login. NEVER a guessed id.
 */
export function userRef(cfg: Config, githubLogin: string): string {
  const login = (githubLogin ?? "").trim();
  if (!login) return "the author";
  for (const [slackId, gh] of Object.entries(cfg.slack.users)) {
    if (gh.toLowerCase() === login.toLowerCase()) return mention(slackId);
  }
  return escapeMrkdwn(login);
}

// escalationRef() was removed on 2026-08-18: there is no nominated escalation
// reviewer any more. Parked PRs are addressed to the owner, via legacyOwnerRef().

/** the owner — by mention when his id is configured, by name otherwise. */
export function legacyOwnerRef(cfg: Config): string {
  const id = cfg.slack.legacy_owner_slack_id.trim();
  return id ? mention(id) : "the owner";
}

export function prUrl(cfg: Config, pr: number): string {
  return `https://github.com/${cfg.github.repo}/pull/${pr}`;
}

/** Round type as a human says it. */
export const ROUND_TYPE_LABEL: Record<RoundType, string> = {
  first: "first review",
  "re-review": "re-review",
  staleness: "staleness recheck",
};

/** A downtime gap, honestly: minutes under an hour, `h`+`min` above it. */
export function formatGap(ms: number): string {
  const totalMin = Math.max(0, Math.round(ms / 60_000));
  if (totalMin < 60) return `${totalMin} min`;
  const h = Math.floor(totalMin / 60);
  const m = totalMin % 60;
  return m === 0 ? `${h} h` : `${h} h ${m} min`;
}

/** ISO instant trimmed to seconds — timestamps we quote, not decorate. */
export function isoSeconds(iso: string): string {
  return iso.replace(/\.\d{3}(Z|[+-]\d\d:\d\d)$/, "$1");
}

// ---- thread lifecycle -----------------------------------------------------

export interface PickupMessageInput {
  pr: number;
  title: string;
  author: string;
  round_no: number;
  round_type: RoundType;
  changed_files: number;
  additions: number;
  deletions: number;
  lenses: string[];
}

/** The thread ROOT: one line of status, one italic line of facts. */
export function pickupMessage(cfg: Config, m: PickupMessageInput): string {
  return (
    `👀 *<${prUrl(cfg, m.pr)}|#${m.pr} ${escapeMrkdwn(m.title)}>* — review started for ${userRef(cfg, m.author)}\n` +
    `_round ${m.round_no} · ${ROUND_TYPE_LABEL[m.round_type]} · ${m.changed_files} files, ` +
    `+${m.additions}/−${m.deletions} · lenses: ${m.lenses.join(", ")}_`
  );
}

export type VerdictName = Verdict;

const VERDICT_RENDER: Record<VerdictName, { glyph: string; label: string }> = {
  APPROVE: { glyph: "✅", label: "APPROVED" },
  REQUEST_CHANGES: { glyph: "🔧", label: "CHANGES REQUESTED" },
  NEEDS_HUMAN: { glyph: "🚨", label: "NEEDS A HUMAN" },
};

export interface VerdictMessageInput {
  pr: number;
  author: string;
  round_no: number;
  verdict: VerdictName;
  /** `rounds.summary`, VERBATIM. Null ⇒ the line is dropped, never filled in. */
  summary: string | null;
  duration_min: number;
  /** Link target; the daemon has no per-review URL, so this is the PR. */
  review_url?: string;
}

export function verdictMessage(cfg: Config, m: VerdictMessageInput): string {
  const { glyph, label } = VERDICT_RENDER[m.verdict];
  const lines = [`${userRef(cfg, m.author)} ${glyph} *${label}* — round ${m.round_no}, ${m.duration_min} min`];
  // A missing summary drops the line entirely: filler ("no summary provided")
  // is noise, and an invented one would be a lie about what the round found.
  if (m.summary !== null && m.summary.trim() !== "") lines.push(escapeMrkdwn(m.summary));
  lines.push(`<${m.review_url ?? prUrl(cfg, m.pr)}|review on GitHub>`);
  if (m.verdict === "NEEDS_HUMAN") {
    lines.push(`parked for a person — ${legacyOwnerRef(cfg)}, the merge decision is yours`);
  }
  return lines.join("\n");
}

/** Why a later round started. The `re-run by` variant carries the operator. */
export type ReRoundReason =
  | { kind: "pushed" }
  | { kind: "base_moved" }
  | { kind: "re_requested" }
  | { kind: "rerun"; requested_by: string };

export function reRoundReasonText(reason: ReRoundReason): string {
  switch (reason.kind) {
    case "pushed":
      return "you pushed new commits";
    case "base_moved":
      return "base moved, rechecking";
    case "re_requested":
      return "re-requested review";
    case "rerun":
      return `re-run by ${escapeMrkdwn(reason.requested_by)}`;
  }
}

/** A later round, in-thread. No lens/diffstat line — the root carries those. */
export function reRoundMessage(m: { round_no: number; reason: ReRoundReason; head_sha: string }): string {
  return `🔄 round ${m.round_no} started — ${reRoundReasonText(m.reason)} (\`${shortSha(m.head_sha)}\`)`;
}

// escalationWorthyMessage() and its pre-flag line were removed on 2026-08-18:
// the daemon no longer scores PRs for escalation-worthiness, so there is
// nothing to pre-announce.

/**
 * A newer round replaced an older one. WORDING IS LOAD-BEARING: no approval and
 * no other identity's review is ever dismissed (CLAUDE.md hard rule 2) — the
 * older review stays exactly where it is, this line only points at the newest.
 */
export function supersededMessage(m: { old_round_no: number; new_round_no: number; head_sha: string }): string {
  return (
    `♻️ the round-${m.old_round_no} review is superseded by round ${m.new_round_no} ` +
    `(\`${shortSha(m.head_sha)}\`) — read the newest one`
  );
}

// ---- unprompted causes ----------------------------------------------------

/** Every cause the announcer can speak for. v1 ships the first six ON; the
 * rest are config-disabled but fully templated, so flipping the flag works. */
export type CauseMessageInput =
  | { cause: "round.overdue"; pr: number; round_no: number; deadline_min: number }
  | { cause: "round.malformed_verdict"; pr: number; round_no: number }
  | { cause: "pr.not_picked_up"; pr: number; age_min: number; queue_depth: number; running: number; max_concurrent: number }
  | { cause: "daemon.up"; version: string; gap: string; last_heartbeat: string }
  | { cause: "daemon.stopping"; reason: string }
  | { cause: "slack.cap_reached"; cap: number }
  | { cause: "reconcile.storm"; corrections: number; window_min: number }
  | { cause: "digest.eod"; headline: string; url?: string }
  | { cause: "pr.awaiting_author_stale"; pr: number; hours: number }
  | { cause: "pr.awaiting_human_stale"; pr: number; hours: number };

export type Cause = CauseMessageInput["cause"];

export function causeMessage(cfg: Config, m: CauseMessageInput): string {
  switch (m.cause) {
    case "round.overdue":
      return (
        `⏱ #${m.pr} round ${m.round_no} blew its ${m.deadline_min}-min deadline — ` +
        `parked on awaiting_human for ${legacyOwnerRef(cfg)}. No verdict was posted.`
      );
    case "round.malformed_verdict":
      return `⚠️ #${m.pr} round ${m.round_no} ended without a usable verdict — parked on awaiting_human, no approval was implied.`;
    case "pr.not_picked_up":
      return (
        `🐢 #${m.pr} has been waiting ${m.age_min} min for a review slot ` +
        `(${m.queue_depth} queued, ${m.running}/${m.max_concurrent} running).`
      );
    case "daemon.up":
      return (
        `🟢 review daemon up (${escapeMrkdwn(m.version)}) — was down ${m.gap} (since ${m.last_heartbeat}); ` +
        `events in that window may have been missed, reconcile is catching up.`
      );
    case "daemon.stopping":
      return `🟡 review daemon stopping (${escapeMrkdwn(m.reason)}) — back shortly.`;
    case "slack.cap_reached":
      return (
        `🔇 I've hit today's answer budget (${m.cap} turns). Verdicts and alerts keep posting; ` +
        `questions resume at midnight (or ask ${legacyOwnerRef(cfg)}).`
      );
    // ---- OFF in v1 (config-disabled), templated so the flag is all it takes --
    case "reconcile.storm":
      return `🌀 reconcile corrected ${m.corrections} PRs in the last ${m.window_min} min — something upstream is flapping, I'm re-deriving from GitHub.`;
    case "digest.eod":
      return m.url
        ? `📋 end of day — ${escapeMrkdwn(m.headline)}\n<${m.url}|the full digest>`
        : `📋 end of day — ${escapeMrkdwn(m.headline)}`;
    case "pr.awaiting_author_stale":
      return `😴 #${m.pr} has been waiting on its author for ${m.hours} h — no action from me until a new push lands.`;
    case "pr.awaiting_human_stale":
      return `😴 #${m.pr} has been waiting on a human reviewer for ${m.hours} h — the merge decision is still theirs.`;
  }
}

/** The pinned liveness message. Its staleness IS the signal, so it carries the
 * instant it was last refreshed. */
export function heartbeatMessage(m: {
  refreshed_at: string;
  running: number;
  max_concurrent: number;
  queued: number;
  dry_run: boolean;
  failed_loud?: number;
  recovered_incident?: string;
}): string {
  return (
    `💓 review daemon alive — ${isoSeconds(m.refreshed_at)} · ${m.running}/${m.max_concurrent} rounds running · ` +
    `${m.queued} queued${m.failed_loud ? ` · ⛔ PIPELINE FAILED · ${m.failed_loud} review${m.failed_loud === 1 ? "" : "s"} needs u` : ""}` +
    `${m.recovered_incident ? ` · ✓ recovered ${m.recovered_incident}` : ""}${m.dry_run ? " · DRY-RUN" : ""}`
  );
}
