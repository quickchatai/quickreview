// (slice C3): daily rollover, opening-context assembly, and the
// Warsaw-day alert-policy memory. No docker, no pi, no clock dependence —
// every seam is injected and every path is a temp dir.
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { COMPANION_DEFAULTS, type CompanionConfig } from "../src/config.js";
import { AlertPolicy, filePolicyStore, readPolicyState, type AlertRecord } from "../src/tui/alerts.js";
import type { DockerResult, DockerRunner } from "../src/tui/companion.js";
import {
  CompanionRollover,
  alertKnobs,
  compactConversation,
  conversationTail,
  decideRollover,
  digestLine,
  firstRunFileName,
  interviewDue,
  openAlerts,
  parseConversation,
  readFirstRunMarker,
  readRolloverState,
  renderDayOpen,
  renderFirstRun,
  snapshotSummary,
  todayDate,
  writeRolloverState,
  SUMMARY_MAX_CHARS,
  type Turn,
} from "../src/tui/rollover.js";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const TEMPLATE = readFileSync(join(repoRoot, "prompts", "companion-day-open.md"), "utf8");

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "qcr-rollover-"));
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

function cfg(overrides: Partial<CompanionConfig> = {}): CompanionConfig {
  return {
    ...COMPANION_DEFAULTS,
    repo_dir: join(dir, "repo"),
    tracker_dir: join(dir, "tracker"),
    feed_dir: join(dir, "feed"),
    alerts_dir: join(dir, "alerts"),
    ssh_dir: join(dir, "ssh"),
    ...overrides,
  };
}

const OK = (stdout = ""): DockerResult => ({ ok: true, stdout, stderr: "", code: 0 });

/** Records argv, answers `ls`/`tail` from a table, OK for everything else. */
function fakeDocker(answers: Record<string, string> = {}): { runner: DockerRunner; calls: string[][] } {
  const calls: string[][] = [];
  const runner: DockerRunner = async (argv) => {
    calls.push(argv);
    const script = argv[argv.length - 1] ?? "";
    for (const [needle, out] of Object.entries(answers)) {
      if (script.includes(needle)) return OK(out);
    }
    return OK();
  };
  return { runner, calls };
}

function rollover(
  runner: DockerRunner,
  opts: {
    now?: () => Date;
    env?: NodeJS.ProcessEnv;
    config?: CompanionConfig;
    /** Wire the first-run interview (template + marker path). */
    firstRun?: boolean;
    firstRunTemplatePath?: string;
    ownerName?: string;
  } = {},
): CompanionRollover {
  return new CompanionRollover(opts.config ?? cfg(), runner, {
    statePath: join(dir, "state", "rollover.json"),
    policyStatePath: join(dir, "state", "alert-policy.json"),
    templatePath: join(repoRoot, "prompts", "companion-day-open.md"),
    injectDir: join(dir, "repo", "inject", "companion"),
    ...(opts.firstRun || opts.firstRunTemplatePath
      ? {
          firstRunTemplatePath: opts.firstRunTemplatePath ?? join(repoRoot, "prompts", "companion-first-run.md"),
          firstRunMarkerPath: join(dir, "state", "companion", "first-run.json"),
        }
      : {}),
    ...(opts.ownerName !== undefined ? { ownerName: opts.ownerName } : {}),
    now: opts.now ?? (() => new Date("2026-08-14T09:00:00Z")),
    env: opts.env ?? {},
  });
}

// ---------------------------------------------------------------------------

describe("ops-day derivation", () => {
  // the zone is threaded from config; these pin the derivation for a
  // concrete zone (Europe/Warsaw) including both DST edges.
  const TZ = "Europe/Warsaw";

  it("uses the configured zone's calendar date, not UTC's", () => {
    // 22:30Z in summer (CEST, +02:00) is already tomorrow in Warsaw.
    expect(todayDate(new Date("2026-08-13T22:30:00Z"), {}, TZ)).toBe("2026-08-14");
    // 22:30Z in winter (CET, +01:00) is 23:30 local — still the same day.
    expect(todayDate(new Date("2026-01-13T22:30:00Z"), {}, TZ)).toBe("2026-01-13");
    // A different configured zone gives a different day for the same instant.
    expect(todayDate(new Date("2026-08-13T22:30:00Z"), {}, "America/New_York")).toBe("2026-08-13");
  });

  it("is correct across both DST transitions (offset flips, no date skew)", () => {
    // Spring forward: 2026-03-29 02:00 CET → 03:00 CEST.
    expect(todayDate(new Date("2026-03-28T23:30:00Z"), {}, TZ)).toBe("2026-03-29"); // 00:30 CET
    expect(todayDate(new Date("2026-03-29T01:30:00Z"), {}, TZ)).toBe("2026-03-29"); // 03:30 CEST
    expect(todayDate(new Date("2026-03-29T22:30:00Z"), {}, TZ)).toBe("2026-03-30"); // 00:30 CEST
    // Fall back: 2026-10-25 03:00 CEST → 02:00 CET (the repeated hour).
    expect(todayDate(new Date("2026-10-24T22:30:00Z"), {}, TZ)).toBe("2026-10-25"); // 00:30 CEST
    expect(todayDate(new Date("2026-10-25T00:30:00Z"), {}, TZ)).toBe("2026-10-25"); // 02:30 CEST
    expect(todayDate(new Date("2026-10-25T01:30:00Z"), {}, TZ)).toBe("2026-10-25"); // 02:30 CET (again)
    expect(todayDate(new Date("2026-10-25T23:30:00Z"), {}, TZ)).toBe("2026-10-26"); // 00:30 CET
  });

  it("honours QCR_FAKE_TODAY (the smoke script's only lever) and ignores junk", () => {
    expect(todayDate(new Date("2026-08-14T09:00:00Z"), { QCR_FAKE_TODAY: "1999-12-31" })).toBe("1999-12-31");
    expect(todayDate(new Date("2026-08-14T09:00:00Z"), { QCR_FAKE_TODAY: "yesterday" })).toBe("2026-08-14");
  });
});

describe("rollover decision", () => {
  it("first run records the day without touching the conversation", () => {
    expect(decideRollover("2026-08-14", undefined)).toEqual({ kind: "first-run", today: "2026-08-14" });
  });

  it("same day is a no-op, and a backwards clock never rotates", () => {
    expect(decideRollover("2026-08-14", { last_open_date: "2026-08-14", updated_at: "" }).kind).toBe("same-day");
    expect(decideRollover("2026-08-13", { last_open_date: "2026-08-14", updated_at: "" }).kind).toBe("same-day");
  });

  it("an earlier recorded day rolls over and names the previous day", () => {
    expect(decideRollover("2026-08-14", { last_open_date: "2026-08-13", updated_at: "" })).toEqual({
      kind: "rollover",
      today: "2026-08-14",
      previous: "2026-08-13",
    });
  });

  it("round-trips its state file and rejects a corrupt one", () => {
    const p = join(dir, "state", "rollover.json");
    writeRolloverState(p, { last_open_date: "2026-08-13", updated_at: "x", last_archive: "/a" });
    expect(readRolloverState(p)?.last_open_date).toBe("2026-08-13");
    writeFileSync(p, "{not json");
    expect(readRolloverState(p)).toBeUndefined();
  });
});

describe("conversation parsing and compaction", () => {
  const lines = [
    JSON.stringify({ role: "user", content: "how is the board" }),
    JSON.stringify({ type: "message", message: { role: "assistant", content: [{ type: "text", text: "quiet" }] } }),
    JSON.stringify({ entry: { role: "user", content: [{ type: "text", text: "thanks" }] } }),
    JSON.stringify({ role: "tool", content: "ignored" }),
    "{{ torn line",
  ].join("\n");

  it("accepts all three session-file shapes and skips what it cannot read", () => {
    expect(parseConversation(lines)).toEqual([
      { role: "user", text: "how is the board" },
      { role: "assistant", text: "quiet" },
      { role: "user", text: "thanks" },
    ]);
  });

  it("summarises head + tail with an elision marker, inside the budget", () => {
    const turns: Turn[] = Array.from({ length: 60 }, (_, i) => ({
      role: i % 2 === 0 ? "user" : "assistant",
      text: `turn ${i} ${"x".repeat(900)}`,
    }));
    const summary = compactConversation(turns);
    expect(summary.length).toBeLessThanOrEqual(SUMMARY_MAX_CHARS);
    expect(summary).toContain("60 turns");
    expect(summary).toContain("How it opened");
    expect(summary).toContain("How it ended");
    expect(summary).toMatch(/…\d+ turns elided…/);
    expect(summary).toContain("…"); // per-turn truncation too
  });

  it("labels user turns with the configured owner name, or the neutral role", () => {
    const turns: Turn[] = [
      { role: "user", text: "hello" },
      { role: "assistant", text: "hi" },
    ];
    const named = compactConversation(turns, undefined, "Casey");
    expect(named).toContain("from Casey");
    expect(named).toContain("- **Casey**: hello");
    const bare = compactConversation(turns);
    expect(bare).toContain("from the operator");
    expect(bare).toContain("- **the operator**: hello");
    expect(bare).not.toContain("Casey");
  });

  it("is empty for an empty conversation, and the tail is bounded", () => {
    expect(compactConversation([])).toBe("");
    expect(conversationTail([])).toBe("");
    const tail = conversationTail(Array.from({ length: 40 }, () => ({ role: "user" as const, text: "y".repeat(500) })));
    expect(tail.length).toBeLessThanOrEqual(2000);
    expect(tail.split("\n").length).toBeLessThanOrEqual(6);
  });
});

describe("carry items", () => {
  const snap = {
    written_at: "2026-08-14T06:00:00Z",
    dry_run: true,
    prs: [
      { number: 5012, state: "reviewing", title: "add retries", head_sha: "a", stale_recheck: false, rounds: 2, last_verdict: "changes" },
      { number: 5013, state: "awaiting_author", title: "docs", head_sha: "b", stale_recheck: false, paused: true },
    ],
    running_rounds: 1,
    total_spend_usd: 12.5,
    today_spend_usd: 1.25,
    digest_headline: "3 PRs reviewed, 1 escalation",
    heartbeat: "2026-08-14T06:00:00Z",
  };

  it("summarises the board snapshot by state, mode and spend", () => {
    const text = snapshotSummary(snap);
    expect(text).toContain("2 tracked PRs");
    expect(text).toContain("1 awaiting_author, 1 reviewing");
    expect(text).toContain("mode dry-run");
    expect(text).toContain("$12.50 total / $1.25 today");
    expect(text).toContain("#5013 awaiting_author [paused]");
  });

  it("degrades to empty (→ '—') with no snapshot and no digest", () => {
    expect(snapshotSummary(undefined)).toBe("");
    expect(digestLine(undefined, undefined)).toBe("");
    expect(digestLine(undefined, "local headline")).toBe("local headline");
    expect(digestLine(snap, "local headline")).toBe("3 PRs reviewed, 1 escalation");
  });

  it("lists unread alert files and alert-tier causes carried over from a past day", () => {
    const alertsDir = join(dir, "alerts");
    mkdirSync(alertsDir, { recursive: true });
    writeFileSync(
      join(alertsDir, "2026-08-14T05-00-00Z-overdue.json"),
      JSON.stringify({ tier: "alert", cause: "round-overdue", pr: "5012", title: "round overdue", body: "" }),
    );
    writeFileSync(join(alertsDir, "2026-08-14T05-01-00Z-bad.json"), "{oops");
    const policyPath = join(dir, "state", "alert-policy.json");
    mkdirSync(dirname(policyPath), { recursive: true });
    writeFileSync(
      policyPath,
      JSON.stringify({
        day: "2026-08-13",
        causes: {
          "daemon-stale": { day: "2026-08-13", lastAt: 1, lastTier: "alert", folds: 2, bypassed: false },
          chatter: { day: "2026-08-13", lastAt: 1, lastTier: "notice", folds: 0, bypassed: false },
        },
      }),
    );
    const text = openAlerts(alertsDir, policyPath, "2026-08-14");
    expect(text).toContain("[alert] round overdue (PR #5012)");
    expect(text).toContain("[malformed]");
    expect(text).toContain("cause `daemon-stale` last raised 2026-08-13");
    expect(text).toContain("+2 folded repeats");
    expect(text).not.toContain("chatter"); // notice tier is not "unresolved"
  });

  it("quotes the alert knobs from config", () => {
    expect(alertKnobs(cfg({ cooldown_min: 20, overdue_grace_min: 30 }))).toContain("per-cause cooldown: 20 min");
  });
});

describe("day-open rendering", () => {
  it("fills every placeholder and leaves none behind", () => {
    const out = renderDayOpen(TEMPLATE, {
      date: "2026-08-14",
      digest: "digest text",
      yesterday_summary: "summary text",
      yesterday_tail: "tail text",
      open_alerts: "alerts text",
      snapshot_summary: "snapshot text",
      alert_knobs: "knobs text",
    });
    expect(out).not.toMatch(/\{\{\w+\}\}/);
    for (const v of ["2026-08-14", "digest text", "summary text", "tail text", "alerts text", "snapshot text", "knobs text"]) {
      expect(out).toContain(v);
    }
  });

  it("renders an empty source as an explicit em dash, never a blank section", () => {
    const out = renderDayOpen(TEMPLATE, {
      date: "2026-08-14",
      digest: "",
      yesterday_summary: "",
      yesterday_tail: "  ",
      open_alerts: "",
      snapshot_summary: "",
      alert_knobs: "",
    });
    expect(out).not.toMatch(/\{\{\w+\}\}/);
    expect(out.match(/^—$/gm)?.length).toBe(6);
  });
});

describe("the rollover sequence", () => {
  it("first start records the day and issues no docker call at all", async () => {
    const { runner, calls } = fakeDocker();
    const report = await rollover(runner).run();
    expect(report.verdict.kind).toBe("first-run");
    expect(calls).toEqual([]);
    expect(readRolloverState(join(dir, "state", "rollover.json"))?.last_open_date).toBe("2026-08-14");
  });

  it("a second start on the same day does nothing", async () => {
    const { runner, calls } = fakeDocker();
    await rollover(runner).run();
    const report = await rollover(runner).run();
    expect(report.verdict.kind).toBe("same-day");
    expect(report.dayOpenFile).toBeUndefined();
    expect(calls).toEqual([]);
  });

  it("a new day archives, compacts, assembles, kills and queues — in that order", async () => {
    writeRolloverState(join(dir, "state", "rollover.json"), { last_open_date: "2026-08-13", updated_at: "" });
    mkdirSync(join(dir, "feed"), { recursive: true });
    writeFileSync(
      join(dir, "feed", "snapshot.json"),
      JSON.stringify({
        written_at: "2026-08-14T06:00:00Z",
        dry_run: true,
        prs: [{ number: 5012, state: "reviewing", title: "add retries", head_sha: "a", stale_recheck: false }],
        running_rounds: 1,
        total_spend_usd: 2,
        digest_headline: "yesterday: 3 PRs",
        heartbeat: "2026-08-14T06:00:00Z",
      }),
    );
    const convo = [
      JSON.stringify({ role: "user", content: "morning" }),
      JSON.stringify({ role: "assistant", content: "PR 5012 stalled overnight" }),
    ].join("\n");
    const { runner, calls } = fakeDocker({ "ls -1t": "/home/companion/.pi/agent/sessions/companion/abc.jsonl\n", "tail -c": convo });

    const report = await rollover(runner).run();
    expect(report.verdict).toEqual({ kind: "rollover", today: "2026-08-14", previous: "2026-08-13" });

    // Order: list → archive (stamped with YESTERDAY) → read → kill.
    const scripts = calls.map((c) => c.join(" "));
    expect(scripts[0]).toContain("ls -1t");
    expect(scripts[1]).toContain("archive/companion/2026-08-13");
    expect(scripts[1]).toContain("cp '/home/companion/.pi/agent/sessions/companion/abc.jsonl'");
    expect(scripts[2]).toContain("tail -c");
    expect(scripts[3]).toContain("tmux kill-session -t companion");
    expect(report.archivedTo).toBe("/home/companion/.pi/archive/companion/2026-08-13/session.jsonl");

    // All five carry items landed in the queued message.
    const queued = readFileSync(report.dayOpenFile!, "utf8");
    expect(report.dayOpenFile).toBe(join(dir, "repo", "inject", "companion", "2026-08-14-day-open.md"));
    expect(queued).toContain("2026-08-14");
    expect(queued).toContain("yesterday: 3 PRs"); // digest
    expect(queued).toContain("PR 5012 stalled overnight"); // tail + summary
    expect(queued).toContain("1 tracked PR"); // snapshot
    expect(queued).toContain("per-cause cooldown"); // knobs
    expect(queued).not.toMatch(/\{\{\w+\}\}/);

    // And the day is recorded, so the next start is a same-day no-op.
    expect(readRolloverState(join(dir, "state", "rollover.json"))?.last_open_date).toBe("2026-08-14");
    expect((await rollover(runner).run()).verdict.kind).toBe("same-day");
  });

  it("rolls over cleanly when there is no previous conversation on the volume", async () => {
    writeRolloverState(join(dir, "state", "rollover.json"), { last_open_date: "2026-08-13", updated_at: "" });
    const { runner } = fakeDocker({ "ls -1t": "" });
    const report = await rollover(runner).run();
    expect(report.steps[0]).toBe("no previous conversation found");
    expect(report.archivedTo).toBeUndefined();
    expect(readFileSync(report.dayOpenFile!, "utf8")).toContain("Good morning");
  });

  it("QCR_FAKE_TODAY drives the whole sequence (how the smoke script fakes a day)", async () => {
    writeRolloverState(join(dir, "state", "rollover.json"), { last_open_date: "2026-08-14", updated_at: "" });
    const { runner } = fakeDocker({ "ls -1t": "" });
    const report = await rollover(runner, { env: { QCR_FAKE_TODAY: "2026-08-15" } }).run();
    expect(report.verdict).toEqual({ kind: "rollover", today: "2026-08-15", previous: "2026-08-14" });
  });
});

describe("first-run interview", () => {
  const markerPath = (): string => join(dir, "state", "companion", "first-run.json");
  const writeMarker = (): void => {
    mkdirSync(dirname(markerPath()), { recursive: true });
    writeFileSync(markerPath(), JSON.stringify({ completed_at: "2026-08-14T08:00:00Z" }));
  };

  it("interviewDue: fallback (no state ever), marker, delivered-once, existing install", () => {
    const marker = { completed_at: "2026-08-14T08:00:00Z" };
    // No rollover state has ever existed ⇒ due, wizard or not.
    expect(interviewDue(undefined, undefined)).toBe(true);
    expect(interviewDue(marker, undefined)).toBe(true);
    // The wizard's marker on an installation with no interview on record ⇒ due.
    expect(interviewDue(marker, { last_open_date: "2026-08-14", updated_at: "" })).toBe(true);
    // Delivered once ⇒ never again, marker or not.
    expect(interviewDue(marker, { last_open_date: "2026-08-14", updated_at: "", first_run_interviewed: "2026-08-14" })).toBe(false);
    expect(interviewDue(undefined, { last_open_date: "2026-08-14", updated_at: "", first_run_interviewed: "2026-08-14" })).toBe(false);
    // An existing installation (state, no marker) never gets one.
    expect(interviewDue(undefined, { last_open_date: "2026-08-13", updated_at: "" })).toBe(false);
  });

  it("reads the wizard's marker contract and rejects junk", () => {
    writeMarker();
    expect(readFirstRunMarker(markerPath())).toEqual({ completed_at: "2026-08-14T08:00:00Z" });
    writeFileSync(markerPath(), "{oops");
    expect(readFirstRunMarker(markerPath())).toBeUndefined();
    writeFileSync(markerPath(), JSON.stringify({ completed_at: "" }));
    expect(readFirstRunMarker(markerPath())).toBeUndefined();
    expect(readFirstRunMarker(join(dir, "nope.json"))).toBeUndefined();
  });

  it("renderFirstRun fills every placeholder; an empty snapshot renders as an em dash", () => {
    const template = readFileSync(join(repoRoot, "prompts", "companion-first-run.md"), "utf8");
    const out = renderFirstRun(template, { date: "2026-08-14", owner: "Casey", snapshot_summary: "" });
    expect(out).not.toMatch(/\{\{\w+\}\}/);
    expect(out).toContain("**2026-08-14**");
    expect(out).toContain("**Casey**");
    expect(out).toContain("—");
  });

  it("fresh installation (no rollover state ever): greeting + interview fire exactly once", async () => {
    const { runner, calls } = fakeDocker();
    const report = await rollover(runner, { firstRun: true }).run();
    expect(report.verdict.kind).toBe("first-run");
    expect(calls).toEqual([]); // still no docker call — nothing to archive or kill
    expect(report.interviewFile).toBe(join(dir, "repo", "inject", "companion", firstRunFileName("2026-08-14")));
    const queued = readFileSync(report.interviewFile!, "utf8");
    expect(queued).toContain("first-run"); // no leftover placeholders either
    expect(queued).not.toMatch(/\{\{\w+\}\}/);
    // Delivered is recorded in the rollover state, beside the day.
    const state = readRolloverState(join(dir, "state", "rollover.json"));
    expect(state?.last_open_date).toBe("2026-08-14");
    expect(state?.first_run_interviewed).toBe("2026-08-14");
    // A second start the same day: nothing at all.
    const again = await rollover(runner, { firstRun: true }).run();
    expect(again.verdict.kind).toBe("same-day");
    expect(again.interviewFile).toBeUndefined();
    expect(again.dayOpenFile).toBeUndefined();
  });

  it("later days run the normal day-open — and the delivered mark survives the rollover rewrite", async () => {
    const { runner } = fakeDocker({ "ls -1t": "" });
    await rollover(runner, { firstRun: true }).run(); // day 1: interview
    const day2 = await rollover(runner, { firstRun: true, env: { QCR_FAKE_TODAY: "2026-08-15" } }).run();
    expect(day2.verdict.kind).toBe("rollover");
    expect(day2.dayOpenFile).toBeDefined();
    expect(readFileSync(day2.dayOpenFile!, "utf8")).toContain("Good morning");
    expect(day2.interviewFile).toBeUndefined();
    // record() preserved the mark, so a marker landing later still never re-fires.
    expect(readRolloverState(join(dir, "state", "rollover.json"))?.first_run_interviewed).toBe("2026-08-14");
    writeMarker();
    const day3 = await rollover(runner, { firstRun: true, env: { QCR_FAKE_TODAY: "2026-08-16" } }).run();
    expect(day3.interviewFile).toBeUndefined();
  });

  it("wizard marker on an installation with prior state: interview fires once, same-day", async () => {
    // The wizard finished AFTER a first TUI start already recorded the day.
    writeRolloverState(join(dir, "state", "rollover.json"), { last_open_date: "2026-08-14", updated_at: "" });
    writeMarker();
    const { runner, calls } = fakeDocker();
    const report = await rollover(runner, { firstRun: true }).run();
    expect(report.verdict.kind).toBe("same-day");
    expect(report.interviewFile).toBeDefined();
    expect(calls).toEqual([]);
    // Exactly once: the next start sees the mark.
    const again = await rollover(runner, { firstRun: true }).run();
    expect(again.interviewFile).toBeUndefined();
  });

  it("an existing installation without the marker never gets the interview", async () => {
    writeRolloverState(join(dir, "state", "rollover.json"), { last_open_date: "2026-08-13", updated_at: "" });
    const { runner } = fakeDocker({ "ls -1t": "" });
    const report = await rollover(runner, { firstRun: true }).run();
    expect(report.verdict.kind).toBe("rollover"); // normal day-open, nothing else
    expect(report.interviewFile).toBeUndefined();
  });

  it("a missing template degrades to a step note — the start is never blocked", async () => {
    const { runner } = fakeDocker();
    const report = await rollover(runner, { firstRunTemplatePath: join(dir, "no-such-template.md") }).run();
    expect(report.verdict.kind).toBe("first-run");
    expect(report.interviewFile).toBeUndefined();
    expect(report.steps.some((s) => s.includes("template unreadable"))).toBe(true);
    // Not marked delivered: fixing the template lets the next start deliver it.
    expect(readRolloverState(join(dir, "state", "rollover.json"))?.first_run_interviewed).toBeUndefined();
  });

  it("without the first-run wiring the rollover behaves exactly as before", async () => {
    const { runner } = fakeDocker();
    const report = await rollover(runner).run();
    expect(report.verdict.kind).toBe("first-run");
    expect(report.interviewFile).toBeUndefined();
  });
});

describe("alert-policy persistence and the Warsaw day boundary", () => {
  const alert = (cause: string, tier: "notice" | "alert" = "notice"): AlertRecord => ({
    tier,
    cause,
    pr: null,
    title: cause,
    body: "",
    ts: "2026-08-14T09:00:00Z",
    file: `${cause}.json`,
  });

  it("survives a TUI restart inside the same day — the fold memory is not re-armed", () => {
    const path = join(dir, "state", "alert-policy.json");
    const now = () => new Date("2026-08-14T09:00:00Z");
    const first = new AlertPolicy(20, now, filePolicyStore(path));
    expect(first.decide(alert("daemon-stale")).action).toBe("route");
    expect(readPolicyState(path)?.day).toBe("2026-08-14");

    // A fresh process, same day: the cause is still inside its cooldown.
    const second = new AlertPolicy(20, now, filePolicyStore(path));
    const d = second.decide(alert("daemon-stale"));
    expect(d).toEqual({ action: "fold", count: 1 });
    expect(second.totalFolds()).toBe(1);
    expect(readPolicyState(path)?.causes["daemon-stale"]?.folds).toBe(1);
  });

  it("resets on a new ops day (configured zone), including the once-a-day escalation bypass", () => {
    const path = join(dir, "state", "alert-policy.json");
    // 21:30Z on 2026-08-13 is 23:30 Warsaw; 22:30Z is already the 14th.
    let clock = new Date("2026-08-13T21:30:00Z");
    const policy = new AlertPolicy(120, () => clock, filePolicyStore(path), "Europe/Warsaw");
    expect(policy.decide(alert("daemon-stale")).action).toBe("route");
    clock = new Date("2026-08-13T21:40:00Z");
    expect(policy.decide(alert("daemon-stale")).action).toBe("fold");
    // Cross the zone's midnight — still inside the 120-minute cooldown by wall time.
    clock = new Date("2026-08-13T22:30:00Z");
    expect(policy.decide(alert("daemon-stale")).action).toBe("route");
    expect(readPolicyState(path)?.day).toBe("2026-08-14");
    expect(policy.totalFolds()).toBe(0);
  });

  it("discards a state file from an earlier day rather than importing it", () => {
    const path = join(dir, "state", "alert-policy.json");
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(
      path,
      JSON.stringify({ day: "2026-08-13", causes: { x: { day: "2026-08-13", lastAt: Date.now(), lastTier: "alert", folds: 9, bypassed: true } } }),
    );
    const policy = new AlertPolicy(20, () => new Date("2026-08-14T09:00:00Z"), filePolicyStore(path));
    expect(policy.folds("x")).toBe(0);
    expect(policy.decide(alert("x")).action).toBe("route");
  });

  it("works with no store at all (the C2 constructor still type-checks)", () => {
    const policy = new AlertPolicy(20, () => new Date("2026-08-14T09:00:00Z"));
    expect(policy.decide(alert("y")).action).toBe("route");
    expect(policy.decide(alert("y")).action).toBe("fold");
  });
});
