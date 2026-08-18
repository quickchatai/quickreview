// The RATIFIED wording (S4, annex §1-2), asserted byte for
// byte — emoji, separators and all. If a template needs to change, the annex
// changes first and these strings follow it, never the other way round.
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { beforeEach, describe, expect, it } from "vitest";
import { parseConfig, type Config } from "../src/config.js";
import * as messages from "../src/slack/messages.js";
import {
  causeMessage,
  escapeMrkdwn,
  formatGap,
  pickupMessage,
  reRoundMessage,
  supersededMessage,
  userRef,
  verdictMessage,
} from "../src/slack/messages.js";

const shipped = readFileSync(resolve(process.cwd(), "config.toml"), "utf8");

let cfg: Config;
beforeEach(() => {
  cfg = parseConfig(shipped);
  cfg.slack.enabled = true;
  cfg.slack.channel = "C_REVIEW";
  cfg.slack.legacy_owner_slack_id = "U_MAT";
  cfg.slack.users = { U_MAT: "mhale", U_ALICE: "alice" };
  cfg.github.repo = "example-org/example-app";
  cfg.github.escalation_reviewer = "mhale";
});

describe("escaping and refs", () => {
  it("escapes exactly &, < and > — ampersand first", () => {
    expect(escapeMrkdwn("a & b <c> d")).toBe("a &amp; b &lt;c&gt; d");
    expect(escapeMrkdwn("<&>")).toBe("&lt;&amp;&gt;");
  });

  it("mentions a mapped author and NEVER fabricates one for an unmapped login", () => {
    expect(userRef(cfg, "alice")).toBe("<@U_ALICE>");
    expect(userRef(cfg, "stranger")).toBe("stranger");
    expect(userRef(cfg, "stranger")).not.toContain("<@");
  });

  it("escapes an unmapped login rather than letting it inject markup", () => {
    expect(userRef(cfg, "<@U_FAKE>")).toBe("&lt;@U_FAKE&gt;");
  });

  it("formats a gap in minutes under an hour and h+min above it", () => {
    expect(formatGap(7 * 60_000)).toBe("7 min");
    expect(formatGap(65 * 60_000)).toBe("1 h 5 min");
    expect(formatGap(120 * 60_000)).toBe("2 h");
  });
});

describe("pickup (the thread root)", () => {
  it("renders the ratified two lines", () => {
    expect(
      pickupMessage(cfg, {
        pr: 5263,
        title: "Add rate limiting",
        author: "alice",
        round_no: 1,
        round_type: "first",
        changed_files: 7,
        additions: 120,
        deletions: 34,
        lenses: ["pass-baseline", "pass-validate"],
      }),
    ).toBe(
      "👀 *<https://github.com/example-org/example-app/pull/5263|#5263 Add rate limiting>* — review started for <@U_ALICE>\n" +
        "_round 1 · first review · 7 files, +120/−34 · lenses: pass-baseline, pass-validate_",
    );
  });

  it("renders re-review and staleness round types in words", () => {
    const base = {
      pr: 1,
      title: "t",
      author: "alice",
      round_no: 3,
      changed_files: 1,
      additions: 1,
      deletions: 0,
      lenses: ["pass-baseline"],
    };
    expect(pickupMessage(cfg, { ...base, round_type: "re-review" })).toContain("· re-review ·");
    expect(pickupMessage(cfg, { ...base, round_type: "staleness" })).toContain("· staleness recheck ·");
  });

  it("escapes the title", () => {
    const text = pickupMessage(cfg, {
      pr: 9,
      title: "Fix <script> & co",
      author: "nobody",
      round_no: 1,
      round_type: "first",
      changed_files: 1,
      additions: 0,
      deletions: 0,
      lenses: ["pass-baseline"],
    });
    expect(text).toContain("#9 Fix &lt;script&gt; &amp; co>*");
    expect(text).toContain("review started for nobody");
  });
});

describe("verdict (in-thread)", () => {
  it("renders APPROVED with the summary verbatim and the GitHub link", () => {
    expect(
      verdictMessage(cfg, {
        pr: 5263,
        author: "alice",
        round_no: 2,
        verdict: "APPROVE",
        summary: "Nothing blocking; the retry loop is bounded now.",
        duration_min: 14,
      }),
    ).toBe(
      "<@U_ALICE> ✅ *APPROVED* — round 2, 14 min\n" +
        "Nothing blocking; the retry loop is bounded now.\n" +
        "<https://github.com/example-org/example-app/pull/5263|review on GitHub>",
    );
  });

  it("renders CHANGES REQUESTED with the 🔧 glyph", () => {
    const text = verdictMessage(cfg, { pr: 1, author: "alice", round_no: 1, verdict: "REQUEST_CHANGES", summary: "s", duration_min: 3 });
    expect(text.split("\n")[0]).toBe("<@U_ALICE> 🔧 *CHANGES REQUESTED* — round 1, 3 min");
  });

  it("DROPS the summary line entirely when there is none — no filler", () => {
    expect(
      verdictMessage(cfg, { pr: 7, author: "alice", round_no: 1, verdict: "APPROVE", summary: null, duration_min: 2 }),
    ).toBe(
      "<@U_ALICE> ✅ *APPROVED* — round 1, 2 min\n<https://github.com/example-org/example-app/pull/7|review on GitHub>",
    );
  });

  it("escapes the summary", () => {
    const text = verdictMessage(cfg, {
      pr: 7,
      author: "alice",
      round_no: 1,
      verdict: "APPROVE",
      summary: "uses <Foo /> & <Bar />",
      duration_min: 2,
    });
    expect(text).toContain("uses &lt;Foo /&gt; &amp; &lt;Bar /&gt;");
  });

  it("appends the parked line on NEEDS A HUMAN, as a fourth line", () => {
    const text = verdictMessage(cfg, {
      pr: 5263,
      author: "alice",
      round_no: 4,
      verdict: "NEEDS_HUMAN",
      summary: "Auth path changed.",
      duration_min: 21,
    });
    expect(text).toBe(
      "<@U_ALICE> 🚨 *NEEDS A HUMAN* — round 4, 21 min\n" +
        "Auth path changed.\n" +
        "<https://github.com/example-org/example-app/pull/5263|review on GitHub>\n" +
        "parked for a person — <@U_MAT>, the merge decision is yours",
    );
    // The line must not claim a GitHub review request; none is made.
    expect(text.toLowerCase()).not.toContain("requested");
  });
});

describe("re-round, pre-flag, superseded", () => {
  it("renders every re-round reason", () => {
    expect(reRoundMessage({ round_no: 2, reason: { kind: "pushed" }, head_sha: "abcdef1234" })).toBe(
      "🔄 round 2 started — you pushed new commits (`abcdef1`)",
    );
    expect(reRoundMessage({ round_no: 3, reason: { kind: "base_moved" }, head_sha: "0123456789" })).toBe(
      "🔄 round 3 started — base moved, rechecking (`0123456`)",
    );
    expect(reRoundMessage({ round_no: 4, reason: { kind: "re_requested" }, head_sha: "0123456789" })).toBe(
      "🔄 round 4 started — re-requested review (`0123456`)",
    );
    expect(reRoundMessage({ round_no: 5, reason: { kind: "rerun", requested_by: "mhale" }, head_sha: "0123456789" })).toBe(
      "🔄 round 5 started — re-run by mhale (`0123456`)",
    );
  });

  it("no longer exports the escalation-worthy pre-flag (scrapped 2026-08-18)", async () => {
    const mod = (await import("../src/slack/messages.js")) as Record<string, unknown>;
    expect(mod.escalationWorthyMessage).toBeUndefined();
    expect(mod.escalationRef).toBeUndefined();
    expect(mod.ESCALATION_REASONS_MAX).toBeUndefined();
  });

  it("renders the superseded line without ever claiming a dismissal", () => {
    const text = supersededMessage({ old_round_no: 2, new_round_no: 3, head_sha: "deadbeefcafe" });
    expect(text).toBe("♻️ the round-2 review is superseded by round 3 (`deadbee`) — read the newest one");
    expect(text.toLowerCase()).not.toContain("dismiss");
  });
});

describe("unprompted causes", () => {
  it("renders round.overdue", () => {
    expect(causeMessage(cfg, { cause: "round.overdue", pr: 5263, round_no: 2, deadline_min: 45 })).toBe(
      "⏱ #5263 round 2 blew its 45-min deadline — parked on awaiting_human for <@U_MAT>. No verdict was posted.",
    );
  });

  it("renders round.malformed_verdict", () => {
    expect(causeMessage(cfg, { cause: "round.malformed_verdict", pr: 5263, round_no: 2 })).toBe(
      "⚠️ #5263 round 2 ended without a usable verdict — parked on awaiting_human, no approval was implied.",
    );
  });

  it("renders pr.not_picked_up", () => {
    expect(
      causeMessage(cfg, { cause: "pr.not_picked_up", pr: 5263, age_min: 35, queue_depth: 4, running: 2, max_concurrent: 2 }),
    ).toBe("🐢 #5263 has been waiting 35 min for a review slot (4 queued, 2/2 running).");
  });

  it("renders daemon.up and daemon.stopping", () => {
    expect(causeMessage(cfg, { cause: "daemon.up", version: "0.1.0", gap: "22 min", last_heartbeat: "2026-08-17T09:00:00Z" })).toBe(
      "🟢 review daemon up (0.1.0) — was down 22 min (since 2026-08-17T09:00:00Z); events in that window may have been missed, reconcile is catching up.",
    );
    expect(causeMessage(cfg, { cause: "daemon.stopping", reason: "deploy" })).toBe(
      "🟡 review daemon stopping (deploy) — back shortly.",
    );
  });

  it("renders slack.cap_reached with the owner by mention", () => {
    expect(causeMessage(cfg, { cause: "slack.cap_reached", cap: 80 })).toBe(
      "🔇 I've hit today's answer budget (80 turns). Verdicts and alerts keep posting; questions resume at midnight (or ask <@U_MAT>).",
    );
  });

  it("still renders the v1-OFF causes, so flipping the config flag is enough", () => {
    for (const input of [
      { cause: "reconcile.storm", corrections: 9, window_min: 30 },
      { cause: "digest.eod", headline: "3 reviews, 1 escalation" },
      { cause: "pr.awaiting_author_stale", pr: 5, hours: 48 },
      { cause: "pr.awaiting_human_stale", pr: 5, hours: 72 },
    ] as const) {
      expect(causeMessage(cfg, input).length).toBeGreaterThan(10);
    }
  });
});

describe("hard rule 2 — nothing the daemon says implies a dismissal", () => {
  it("the word 'dismiss' appears in no rendered template", () => {
    const rendered = [
      pickupMessage(cfg, {
        pr: 1,
        title: "t",
        author: "alice",
        round_no: 1,
        round_type: "first",
        changed_files: 1,
        additions: 1,
        deletions: 1,
        lenses: ["pass-baseline"],
      }),
      ...(["APPROVE", "REQUEST_CHANGES", "NEEDS_HUMAN"] as const).map((v) =>
        verdictMessage(cfg, { pr: 1, author: "alice", round_no: 1, verdict: v, summary: "s", duration_min: 1 }),
      ),
      reRoundMessage({ round_no: 2, reason: { kind: "pushed" }, head_sha: "abc1234" }),
      supersededMessage({ old_round_no: 1, new_round_no: 2, head_sha: "abc1234" }),
      causeMessage(cfg, { cause: "round.overdue", pr: 1, round_no: 1, deadline_min: 45 }),
      causeMessage(cfg, { cause: "round.malformed_verdict", pr: 1, round_no: 1 }),
      causeMessage(cfg, { cause: "pr.not_picked_up", pr: 1, age_min: 1, queue_depth: 1, running: 0, max_concurrent: 2 }),
      causeMessage(cfg, { cause: "daemon.up", version: "v", gap: "1 min", last_heartbeat: "x" }),
      causeMessage(cfg, { cause: "daemon.stopping", reason: "r" }),
      causeMessage(cfg, { cause: "slack.cap_reached", cap: 80 }),
      causeMessage(cfg, { cause: "reconcile.storm", corrections: 1, window_min: 1 }),
      causeMessage(cfg, { cause: "digest.eod", headline: "h" }),
      causeMessage(cfg, { cause: "pr.awaiting_author_stale", pr: 1, hours: 48 }),
      causeMessage(cfg, { cause: "pr.awaiting_human_stale", pr: 1, hours: 72 }),
      messages.heartbeatMessage({ refreshed_at: "2026-08-17T09:00:00.000Z", running: 1, max_concurrent: 2, queued: 0, dry_run: false }),
    ];
    for (const text of rendered) expect(text.toLowerCase()).not.toContain("dismiss");
  });

  it("the source file itself carries no dismissal wording", () => {
    const src = readFileSync(resolve(process.cwd(), "src/slack/messages.ts"), "utf8").toLowerCase();
    // Only the hard-rule comment may say the word — never a template string.
    const templateLines = src
      .split("\n")
      .filter((l) => !l.trim().startsWith("//") && !l.trim().startsWith("*"))
      .filter((l) => l.includes("`") || l.includes('"'));
    for (const line of templateLines) expect(line).not.toContain("dismiss");
  });
});
