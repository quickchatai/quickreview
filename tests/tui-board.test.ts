import { BAD_BG } from "../src/tui/design.js";
import { describe, expect, it } from "vitest";
import type { WhyPayload } from "../src/cli.js";
import type { StatusSnapshot } from "../src/state.js";
import {
  piHeader,
  piPaneSize,
  piRows,
  renderBoard,
  topBar,
  detailLines,
  overlayInputBox,
  type BoardAction,
  type BoardView,
} from "../src/tui/board.js";
import { decodeKey, decodeInputKey } from "../src/tui/keys.js";
import {
  Frame,
  displayWidth,
  fit,
  rule,
  sanitizeText,
  stripAnsi,
  truncate,
  wrap,
} from "../src/tui/paint.js";
import {
  captureArgv,
  statusArgv,
  whyArgv,
  eventsArgv,
  progressArgv,
  type SshRunner,
} from "../src/tui/remote.js";
import { PiMirror, type PiPaneView } from "../src/tui/pipane.js";
import { hitTest, type Zone } from "../src/tui/mouse.js";
import { eventsOverlayBand } from "../src/tui/board.js";

/** The overlay band a rendered frame used (barRows recovered from its meta). */
function eventsOverlayBandFor(
  rows: number,
  frame: { meta: Record<string, number> },
): { top: number; height: number } {
  const barRows = rows - 2 - frame.meta["bodyRows"]! - frame.meta["piRows"]!;
  return eventsOverlayBand(rows, barRows);
}
import { TUI_DEFAULTS } from "../src/config.js";

const snapshot: StatusSnapshot = {
  written_at: "2026-08-13T12:00:00Z",
  dry_run: true,
  prs: [
    {
      number: 5012,
      state: "reviewing",
      title: "fix(crm): retry send_message",
      head_sha: "a2e380ff11",
      stale_recheck: 0,
    },
    {
      number: 5049,
      state: "awaiting_author",
      title: "feat(remote-api): dispatch",
      head_sha: "bb11223344",
      stale_recheck: 0,
    },
  ],
  running_rounds: 3,
  max_concurrent_rounds: 12,
  total_spend_usd: 20,
  today_spend_usd: 4.12,
  heartbeat: "2026-08-13T12:00:00Z",
};

const view = (over: Partial<BoardView> = {}): BoardView => ({
  health: { kind: "ok", heartbeatAgeS: 2 },
  dryRun: true,
  snapshot,
  events: [],
  selected: 0,
  eventsFocus: false,
  eventsScroll: 0,
  help: false,
  ...over,
});

describe("paint primitives", () => {
  it("truncates with an ellipsis and pads to width", () => {
    expect(truncate("hello world", 8)).toBe("hello w…");
    expect(truncate("short", 8)).toBe("short");
    expect(fit("ab", 5)).toBe("ab   ");
    expect(displayWidth(fit("界面测试", 6))).toBe(6); // CJK counts 2 cells
  });

  it("strips ANSI before measuring", () => {
    expect(displayWidth("\x1b[1mbold\x1b[0m")).toBe(4);
    expect(stripAnsi("\x1b[38;2;1;2;3mx\x1b[0m")).toBe("x");
  });

  it("builds a rule of exactly the requested width", () => {
    const r = rule(40, "┌", "┐", ["quickreview", "DRY-RUN"]);
    expect(displayWidth(r)).toBe(40);
    expect(r).toContain("quickreview ── DRY-RUN");
  });
});

describe("topBar", () => {
  it("shows dry-run, health, rounds and today spend", () => {
    const bar = stripAnsi(topBar(view(), 100));
    expect(bar).toContain("DRY-RUN");
    expect(bar).toContain("daemon ok (hb 2s)");
    expect(bar).toContain("rounds 3/12");
    expect(bar).toContain("today $4.12");
  });

  it("distinguishes a live daemon from a failed review pipeline", () => {
    const causes = [
      {
        key: "review-failure:cmd-1",
        pr: 5408,
        since: "2026-08-13T11:55:00Z",
        stage: "command_start",
        detail: "no start",
        next_action: "operator_unwedge",
      },
    ] as const;
    const bar = stripAnsi(
      topBar(
        view({ health: { kind: "pipeline_unhealthy", heartbeatAgeS: 2, causes: [...causes] } }),
        120,
      ),
    );
    expect(bar).toContain("daemon alive");
    expect(bar).toContain("PIPELINE FAILED · 1");
    expect(bar).not.toContain("daemon ok");
  });

  it("replaces health with the stale banner", () => {
    const bar = stripAnsi(topBar(view({ health: { kind: "stale", dataAgeS: 42 } }), 100));
    expect(bar).toContain("DATA STALE (42s)");
  });

  it("marks LIVE loudly when dry_run is off", () => {
    const bar = topBar(view({ dryRun: false }), 100);
    expect(stripAnsi(bar)).toContain("LIVE");
    expect(bar).toContain(BAD_BG); // red truth chip (design.badge)
  });
});

describe("detailLines", () => {
  const why: WhyPayload = {
    pr: 5012,
    known: true,
    state: "reviewing",
    title: "fix(crm): retry send_message",
    head_sha: "a2e380ff11",
    trigger_ts: "2026-08-13T14:02:00Z",
    spend_usd: 1.3,
    rounds: [
      {
        round_no: 1,
        round_type: "initial",
        status: "done",
        verdict: "REQUEST_CHANGES",
        started_at: "",
        finished_at: "",
        spend_usd: 0.5,
        lenses: "a",
      },
      {
        round_no: 2,
        round_type: "rework",
        status: "running",
        verdict: null,
        started_at: "",
        finished_at: null,
        spend_usd: null,
        lenses: "b",
      },
    ],
    threads: { open: 2, total: 2 },
    ledger: "F1 [P1/0.9][delivery] tasks.py:88 open\n",
  };

  it("shows independently retried posting debt even before detail loads", () => {
    const lines = detailLines(
      undefined,
      {
        ...snapshot.prs[0]!,
        current_round: {
          round_no: 1,
          round_type: "first",
          status: "running",
          started_at: "",
          deadline_at: "",
          lenses: "",
          validate_tier: null,
          posting_delivery: {
            attempts: 3,
            next_attempt_at: "2026-10-12T12:00:00Z",
            last_error: "GitHub unavailable",
          },
        },
      },
      100,
    ).map(stripAnsi);
    expect(lines.join("\n")).toContain("POSTING PENDING · automatic retry · attempts 3");
    expect(lines.join("\n")).toContain("GitHub unavailable");
  });

  it("renders header facts, ledger, rounds and threads", () => {
    const lines = detailLines(why, snapshot.prs[0], 60).map(stripAnsi);
    // No escalation-worthiness fact: the header carries state and round only.
    expect(lines[1]).toBe("reviewing · round 2");
    expect(lines[2]).toContain("spend $1.30 · head a2e380f · trig");
    expect(lines).toContain("F1 [P1/0.9][delivery] tasks.py:88 open");
    expect(lines.find((l) => l.startsWith("▍ROUNDS"))).toContain("r1 RC · r2 …");
    expect(lines.find((l) => l.startsWith("▍THREADS"))).toContain("2 known");
  });

  it("shows FAILED_LOUD stage, attempts and the operator recovery key", () => {
    const failed = {
      ...snapshot.prs[0]!,
      review_failure: {
        incident_id: "review-failure:cmd-1",
        command_id: "cmd-1",
        round_no: 1,
        head_sha: "a2e380ff11",
        stage: "command_start",
        detail: "no correlated start",
        attempts: 2,
        retry_cap: 2,
        retry_epoch: 0,
        next_retry_at: null,
        failed_at: "2026-08-13T11:55:00Z",
        next_action: "operator_unwedge" as const,
      },
    };
    const lines = detailLines(why, failed, 80, new Date("2026-08-13T12:00:00Z")).map(stripAnsi);
    expect(lines.join("\n")).toContain(
      "FAILED_LOUD · command_start · cmd-1 · round 1 · attempt 2/2 · 5m old",
    );
    expect(lines.join("\n")).toContain("press u to recover");
  });

  it("shows the finite automatic exit from a pre-fanout retry wait", () => {
    const retrying = {
      ...snapshot.prs[0]!,
      review_failure: {
        incident_id: "review-failure:cmd-stall",
        command_id: "cmd-stall",
        round_no: 9,
        head_sha: "a2e380ff11",
        stage: "first_pass_start",
        detail: "accepted and preparing; no planned pass started",
        attempts: 2,
        retry_cap: 2,
        retry_epoch: 1,
        next_retry_at: "2026-08-13T12:15:00Z",
        failed_at: "2026-08-13T12:00:00Z",
        next_action: "retry_wait" as const,
      },
    };
    const lines = detailLines(why, retrying, 100, new Date("2026-08-13T12:05:00Z")).map(stripAnsi);
    expect(lines.join("\n")).toContain("auto retry 12:15Z · epoch 1 · u now");
    expect(lines.join("\n")).not.toContain("press u to recover");
  });

  it("shows a loading line until the payload matches the selection", () => {
    const lines = detailLines(undefined, snapshot.prs[0], 60).map(stripAnsi);
    expect(lines[1]).toBe("loading detail…");
  });

  it("shows round timing, parent activity, every planned lens, and verdict progress", () => {
    const live: WhyPayload = {
      ...why,
      rounds: [
        {
          round_no: 14,
          round_type: "re-review",
          status: "running",
          verdict: null,
          started_at: "2026-08-27T09:34:54Z",
          deadline_at: "2026-08-27T10:49:54Z",
          finished_at: null,
          spend_usd: null,
          lenses: "pass-baseline,pass-security,pass-validate",
          validate_tier: "sol-high",
        },
      ],
    };
    const lines = detailLines(
      live,
      {
        ...snapshot.prs[0]!,
        current_round: {
          round_no: 14,
          round_type: "re-review",
          status: "running",
          started_at: "2026-08-27T09:34:54Z",
          deadline_at: "2026-08-27T10:49:54Z",
          lenses: "pass-baseline,pass-security,pass-validate",
          validate_tier: "sol-high",
          command_id: "cmd-14",
          command_sha256: "a".repeat(64),
          head_sha: "head-5012",
        },
      },
      76,
      new Date("2026-08-27T10:04:54Z"),
      {
        version: 2,
        pr: 5012,
        session: "pr-5012",
        command_id: "cmd-14",
        command_sha256: "a".repeat(64),
        command_accepted_at: "2026-08-27T09:34:55Z",
        preparing_at: "2026-08-27T09:34:55Z",
        round_no: 14,
        head_sha: "head-5012",
        run_started_at: "2026-08-27T09:34:55Z",
        updated_at: "2026-08-27T10:04:53Z",
        parent_status: "active",
        last_activity_at: "2026-08-27T10:04:50Z",
        last_activity: "pass-security · grep: bearer",
        active_tool: "subagent: pass-security",
        agents: [
          {
            execution_id: "baseline",
            agent: "pass-baseline",
            status: "completed",
            duration_ms: 120_000,
            tool_count: 7,
            started_at: "2026-08-27T09:35:00Z",
            finished_at: "2026-08-27T09:37:00Z",
          },
          {
            execution_id: "security",
            agent: "pass-validate",
            status: "running",
            duration_ms: 30_000,
            tool_count: 2,
            current_tool: "grep: bearer",
            started_at: "2026-08-27T10:04:24Z",
          },
          {
            execution_id: "validate-failed",
            agent: "pass-validate",
            status: "failed",
            duration_ms: 30_000,
            tool_count: 2,
            error: "timeout",
            started_at: "2026-08-27T10:04:24Z",
          },
          {
            execution_id: "architecture",
            agent: "pass-architecture",
            status: "completed",
            duration_ms: 60_000,
            tool_count: 5,
            started_at: "2026-08-27T09:38:00Z",
            finished_at: "2026-08-27T09:39:00Z",
          },
        ],
      },
    ).map(stripAnsi);
    expect(lines).toContain("▍CURRENT REVIEW round 14 · 30m elapsed · 45m left");
    expect(lines).toContain(
      "  parent ACTIVE · fanout-started · signal 1s ago · subagent: pass-security",
    );
    expect(lines).toContain("  ✓ pass-baseline · done in 2m · 7 tools");
    expect(lines).toContain("  ⟳ pass-validate · running 30s · grep: bearer · sol-high");
    expect(lines).toContain("  ○ pass-security · pending");
    expect(lines).toContain("  ✗ pass-validate · failed after 30s · timeout · sol-high");
    expect(lines).toContain("  ✓ pass-architecture · done in 1m · 5 tools · added");
    expect(lines).toContain("  ○ final verdict · pending");
    expect(lines).toContain("  last activity 4s ago · pass-security · grep: bearer");
  });

  it("rejects live progress from a different command even when PR/round timestamps match", () => {
    const live: WhyPayload = {
      ...why,
      rounds: [
        { ...why.rounds[1]!, round_no: 14, status: "running", deadline_at: "2026-08-27T10:49:54Z" },
      ],
    };
    const pr = {
      ...snapshot.prs[0]!,
      current_round: {
        round_no: 14,
        round_type: live.rounds[0]!.round_type,
        status: "running",
        started_at: live.rounds[0]!.started_at,
        deadline_at: "2026-08-27T10:49:54Z",
        lenses: live.rounds[0]!.lenses,
        validate_tier: live.rounds[0]!.validate_tier ?? null,
        command_id: "cmd-current",
        command_sha256: "a".repeat(64),
        head_sha: "head-current",
      },
    };
    const lines = detailLines(live, pr, 76, new Date("2026-08-27T10:04:54Z"), {
      version: 2,
      pr: 5012,
      session: "pr-5012",
      run_started_at: live.rounds[0]!.started_at,
      updated_at: "2026-08-27T10:04:53Z",
      parent_status: "active",
      command_id: "cmd-neighbor",
      command_sha256: "b".repeat(64),
      command_accepted_at: live.rounds[0]!.started_at,
      round_no: 14,
      head_sha: "head-current",
      preparing_at: live.rounds[0]!.started_at,
      last_activity_at: "2026-08-27T10:04:53Z",
      last_activity: "neighboring wake",
      agents: [],
    }).map(stripAnsi);
    expect(lines).toContain("  ? parent · live progress unavailable");
  });

  it("never invents pending agent state when the progress signal is absent", () => {
    const live: WhyPayload = {
      ...why,
      rounds: [
        {
          ...why.rounds[1]!,
          deadline_at: "2026-08-27T10:49:54Z",
          lenses: "pass-baseline,pass-validate",
        },
      ],
    };
    const lines = detailLines(live, snapshot.prs[0], 76, new Date("2026-08-27T10:04:54Z")).map(
      stripAnsi,
    );
    expect(lines).toContain("  ? parent · live progress unavailable");
    expect(lines).toContain("  ? pass-baseline · unknown");
    expect(lines).toContain("  ? pass-validate · unknown");
  });

  // The snapshot says the round is over (no current_round, no longer
  // reviewing) while the cached `why` still holds it `running`: no CURRENT
  // REVIEW. MUTATION: fall back to the cached running row whatever the state — red.
  it("a cached running round never paints CURRENT REVIEW once the snapshot moved on", () => {
    const live: WhyPayload = {
      ...why,
      rounds: [{ ...why.rounds[1]!, deadline_at: "2026-08-27T10:49:54Z" }],
    };
    const done = { ...snapshot.prs[0]!, state: "awaiting_author" as const };
    const lines = detailLines(live, done, 76, new Date("2026-08-27T10:04:54Z")).map(stripAnsi);
    expect(lines.some((l) => l.includes("CURRENT REVIEW"))).toBe(false);
  });

  // A lens planned twice (two task rows) shows both executions: the finished
  // one never hides its running sibling. MUTATION: one row per lens name — red.
  it("shows every execution of a lens planned more than once", () => {
    const pr = {
      ...snapshot.prs[0]!,
      current_round: {
        round_no: 14,
        round_type: "re-review",
        status: "running",
        started_at: "2026-08-27T09:34:54Z",
        deadline_at: "2026-08-27T10:49:54Z",
        lenses: "pass-sweep,pass-sweep",
        validate_tier: null,
        command_id: "cmd-14",
        command_sha256: "a".repeat(64),
        head_sha: "head-5012",
      },
    };
    const run = (id: string, status: "running" | "completed", ms: number) => ({
      execution_id: id,
      agent: "pass-sweep",
      status,
      duration_ms: ms,
      tool_count: 3,
      started_at: "2026-08-27T09:35:00Z",
      ...(status === "completed" ? { finished_at: "2026-08-27T09:36:00Z" } : {}),
    });
    const lines = detailLines(why, pr, 76, new Date("2026-08-27T10:04:54Z"), {
      version: 2,
      pr: 5012,
      session: "pr-5012",
      command_id: "cmd-14",
      command_sha256: "a".repeat(64),
      command_accepted_at: "2026-08-27T09:34:55Z",
      preparing_at: "2026-08-27T09:34:55Z",
      round_no: 14,
      head_sha: "head-5012",
      run_started_at: "2026-08-27T09:34:55Z",
      updated_at: "2026-08-27T10:04:53Z",
      parent_status: "active",
      last_activity_at: "2026-08-27T10:04:50Z",
      last_activity: "sweep",
      agents: [run("a", "running", 30_000), run("b", "completed", 60_000)],
    }).map(stripAnsi);
    expect(lines).toContain("  ⟳ pass-sweep · running 30s");
    expect(lines).toContain("  ✓ pass-sweep · done in 1m · 3 tools");
  });

  // A cancelled round is told apart from every other verdictless round: it
  // says which kind of cancellation it was.
  describe("cancelled rounds name their cause", () => {
    const withRounds = (rounds: WhyPayload["rounds"]): string[] =>
      detailLines({ ...why, rounds }, snapshot.prs[0], 60).map(stripAnsi);

    it("marks the round and spells the cause out underneath", () => {
      const lines = withRounds([
        {
          round_no: 1,
          round_type: "initial",
          status: "cancelled",
          verdict: null,
          started_at: "",
          finished_at: "",
          spend_usd: null,
          lenses: "a",
          cancel_cause: "orphan_sweep",
        },
        {
          round_no: 2,
          round_type: "rework",
          status: "cancelled",
          verdict: null,
          started_at: "",
          finished_at: "",
          spend_usd: null,
          lenses: "b",
          cancel_cause: "deadline_overrun",
        },
      ]);
      expect(lines.find((l) => l.startsWith("▍ROUNDS"))).toContain("r1 ✕ · r2 ✕");
      expect(lines).toContain("  ✕ r1 cancelled — orphan sweep (redeploy)");
      expect(lines).toContain("  ✕ r2 cancelled — stopped dead");
    });

    it("an older daemon's payload (no cause) reads as unclassified, never as benign", () => {
      const lines = withRounds([
        {
          round_no: 1,
          round_type: "initial",
          status: "cancelled",
          verdict: null,
          started_at: "",
          finished_at: "",
          spend_usd: null,
          lenses: "a",
        },
      ]);
      expect(lines).toContain("  ✕ r1 cancelled — unclassified");
    });

    it("adds nothing for a PR with no cancelled round", () => {
      expect(withRounds(why.rounds).filter((l) => l.includes("cancelled"))).toEqual([]);
    });
  });
});

describe("sanitizeText + wrap (foreign-text hygiene)", () => {
  it("strips CR so GitHub CRLF bodies cannot rehome the cursor", () => {
    expect(sanitizeText("line one\r\nline two\r")).toBe("line one\nline two\n");
  });
  it("expands tabs and drops other control bytes", () => {
    expect(sanitizeText("a\tb")).toBe("a  b");
    expect(sanitizeText("x\x00y\x08z\x07w")).toBe("xyzw");
  });
  it("word-wraps at cell width, preserving paragraph breaks", () => {
    expect(wrap("alpha beta gamma", 11)).toEqual(["alpha beta", "gamma"]);
    expect(wrap("one\n\ntwo", 20)).toEqual(["one", "", "two"]);
  });
  it("hard-breaks a word longer than the width", () => {
    expect(wrap("abcdefghij", 4)).toEqual(["abcd", "efgh", "ij"]);
  });
  it("counts CJK as two cells when wrapping", () => {
    expect(wrap("\u6c49\u5b57\u6c49\u5b57", 4)).toEqual(["\u6c49\u5b57", "\u6c49\u5b57"]);
  });
});

describe("detailLines keeps foreign text inside the pane", () => {
  const whyBase: WhyPayload = {
    pr: 5012,
    known: true,
    state: "reviewing",
    title: "fix(crm): retry send_message",
    head_sha: "a2e380ff11",
    trigger_ts: "2026-08-13T14:02:00Z",
    spend_usd: 1.3,
    rounds: [],
    threads: { open: 0, total: 0 },
    ledger: undefined,
  };
  it("wraps a long CRLF description instead of truncating rightwards", () => {
    const d: WhyPayload = {
      ...whyBase,
      description:
        "First sentence of the body.\r\nSecond line that is quite long and would previously vanish off the right edge of the pane entirely.",
    };
    const lines = detailLines(d, snapshot.prs[0], 30);
    const flat = lines.map(stripAnsi);
    expect(flat.some((l) => l.includes("First sentence"))).toBe(true);
    expect(flat.some((l) => l.includes("right edge"))).toBe(true);
    for (const l of lines) expect(displayWidth(l)).toBeLessThanOrEqual(30);
    for (const l of lines) expect(l.includes("\r")).toBe(false);
  });
  it("comments render as head line + wrapped indented body, never overwide", () => {
    const d: WhyPayload = {
      ...whyBase,
      comments: [
        {
          author: "alice",
          created_at: "2026-08-14T00:00:00Z",
          body: "A very long comment body\r\nwith CRLF endings that keeps going and going well past the pane width to prove wrapping works.",
        },
      ],
    };
    const lines = detailLines(d, snapshot.prs[0], 28, new Date("2026-08-14T01:00:00Z"));
    for (const l of lines) expect(displayWidth(l)).toBeLessThanOrEqual(28);
    const flat = lines.map(stripAnsi);
    expect(flat.some((l) => l.startsWith("  A very long"))).toBe(true);
  });
});

describe("adaptive layout", () => {
  it("sizes the list column to the longest PR row, clamped to 45% of the width", async () => {
    const { listWidth } = await import("../src/tui/board.js");
    const prs = snapshot.prs;
    const w = listWidth(prs, 120);
    // widest row incl. author/age/round columns and the legend floor
    expect(w).toBeGreaterThanOrEqual(43);
    expect(w).toBeLessThanOrEqual(Math.floor(120 * 0.45));
    expect(listWidth(prs, 60)).toBe(27); // clamp: 45% of 60
  });

  // The list is sized to the row as painted: a FAILED_LOUD chip (or any
  // verdict the chip table does not abbreviate) is part of it. MUTATION: a
  // second chip table in the width measure that drops them — red.
  it("measures the chip the row paints, failure and unabbreviated verdicts included", async () => {
    const { listWidth } = await import("../src/tui/board.js");
    const base = { ...snapshot.prs[0]!, title: "t".repeat(80), last_verdict: null };
    const plain = listWidth([base], 400);
    const failed = listWidth(
      [{ ...base, review_failure: { detail: "x" } } as unknown as typeof base],
      400,
    );
    expect(failed).toBe(plain + " FAILED_LOUD".length);
    expect(listWidth([{ ...base, last_verdict: "COMMENT" }], 400)).toBe(plain + " COMMENT".length);
  });

  // A PR title is the author's text: control bytes never reach the terminal
  // from a list row. MUTATION: truncate the raw title — red.
  it("paints a PR title as one inert line", () => {
    const evil = {
      ...snapshot,
      prs: [{ ...snapshot.prs[0]!, title: "fix\x1b[2J\x1b[Hcleared\rover\nnext" }],
    };
    const frame = renderBoard(view({ snapshot: evil }), 120, 30);
    const text = frame.lines.join("\n");
    expect(text).not.toContain("\x1b[2J");
    expect(text).not.toContain("\r");
    expect(stripAnsi(text)).toContain("fix[2J[Hcleared over next");
  });

  it("measures a verdict the board has no short chip for as it paints it — by its own name", async () => {
    const { listWidth } = await import("../src/tui/board.js");
    const base = { ...snapshot.prs[0]!, title: "t", author: "a", rounds: 0 };
    const known = listWidth([{ ...base, last_verdict: "APPROVE" }], 400);
    const odd = listWidth(
      [{ ...base, last_verdict: "A_FUTURE_VERDICT_NAME_LONGER_THAN_THE_LEGEND_BELOW_THE_LIST" }],
      400,
    );
    expect(odd).toBeGreaterThan(known);
  });

  it("gives the live pi mirror half the screen, never starving the body", async () => {
    const { piRows } = await import("../src/tui/board.js");
    // With the two-row bar the usable height is rows - 4.
    expect(piRows(24, 2)).toBe(10); // 20 usable / 2
    expect(piRows(40, 2)).toBe(18);
    expect(piRows(14, 2)).toBe(6); // floor
    expect(piRows(11, 2)).toBe(4); // squeezed: body keeps 3 rows
    // A wrapped bar costs the mirror, never the body's floor.
    expect(piRows(24, 3)).toBe(9);
  });

  it("the body reaches the command bar now the companion strip is retired", () => {
    // Frame geometry: top bar (0), body 1..rows-4, command bar rows-3..rows-2,
    // bottom border rows-1. The companion is a column, not a band, so it takes
    // no rows from the body. (140 wide: the bar is two rows only while the nav
    // and the globals share one — at 120 the eight nav slots wrap the globals
    // onto a row of their own.)
    for (const rows of [24, 40]) {
      const frame = renderBoard(
        view({ pi: { pr: 5012, lines: ["pi output"], missing: false, stale: false, offset: 0 } }),
        140,
        rows,
      );
      expect(frame.meta["bodyRows"]! + frame.meta["piRows"]!).toBe(rows - 4);
      expect(frame.meta["piTop"]! + frame.meta["piRows"]! - 1).toBe(rows - 4); // last body row
      expect(frame.lines[rows - 4]!.startsWith("│")).toBe(true); // still content, not chrome
      expect(stripAnsi(frame.lines[rows - 3]!)).toContain("1 board"); // the command bar
      for (const z of frame.zones) expect(z.y2).toBeLessThanOrEqual(rows - 3); // terminal rows are 1-based
    }
  });

  it("centers the events overlay band on the screen", async () => {
    const { eventsOverlayBand } = await import("../src/tui/board.js");
    expect(eventsOverlayBand(24, 2)).toEqual({ top: 5, height: 14 });
    expect(eventsOverlayBand(48, 2)).toEqual({ top: 10, height: 28 });
    // Never under a wrapped bar either.
    expect(eventsOverlayBand(12, 4)).toEqual({ top: 3, height: 5 });
  });

  it("shows full titles and more events on a tall wide terminal", () => {
    const events = Array.from({ length: 8 }, (_, i) => ({
      ts: `t${i}`,
      text: `10:00:0${i} event_${i}`,
      anomaly: false,
    }));
    const text = renderBoard(view({ events, eventsFocus: true }), 140, 48)
      .lines.map(stripAnsi)
      .join("\n");
    expect(text).toContain("fix(crm): retry send_message"); // uncropped title
    expect(text).toContain("event_7"); // more than 3 event lines visible
  });
});

describe("renderBoard", () => {
  it("renders the full frame with list, detail and the live pi mirror", () => {
    const frame = renderBoard(
      view({
        events: [
          { ts: "21:24:11", text: "21:24:11 verdict_applied #5049 (APPROVE)", anomaly: false },
        ],
        pi: {
          pr: 5012,
          lines: ["> reading tasks.py", "thinking…"],
          missing: false,
          stale: false,
          offset: 0,
        },
      }),
      100,
      24,
    );
    const text = frame.lines.map(stripAnsi).join("\n");
    expect(text).toContain("PRS (2)");
    expect(text).toContain("▶ #5012");
    expect(text).toContain("fix(crm)");
    expect(text).toContain("✎ #5049");
    expect(text).toContain("PI pr-5012 · live mirror · click to type");
    expect(text).toContain("> reading tasks.py");
    expect(text).toContain("1 board");
    expect(text).toContain("2 memory");
    expect(frame.lines.length).toBe(24);
    // The EVENTS strip is not painted; `e` opens it as an overlay.
    expect(text).not.toContain("EVENTS");
    expect(text).not.toContain("verdict_applied #5049");
  });

  it("keeps every row at the terminal width", () => {
    const frame = renderBoard(view(), 90, 24);
    for (const line of frame.lines) expect(displayWidth(line)).toBe(90);
  });

  it("keeps every row at the terminal width at 30 / 100 / 220 cols, mirror and overlay included", () => {
    const events = Array.from({ length: 20 }, (_, i) => ({
      ts: `t${i}`,
      text: `10:00:0${i} verdict_applied #504${i % 10}`,
      anomaly: i % 3 === 0,
    }));
    const pi: PiPaneView = {
      pr: 5012,
      lines: [
        "\x1b[32mgreen line that runs on and on and on past any sane pane width\x1b[0m",
        "plain",
      ],
      missing: false,
      stale: false,
      offset: 0,
    };
    for (const cols of [30, 100, 220]) {
      for (const over of [
        {},
        { eventsFocus: true },
        { piFocus: true, piPr: 5012 },
        { piFocus: true, piPr: 5012, pi: { ...pi, offset: 9 } },
      ]) {
        const frame = renderBoard(view({ events, pi, ...over }), cols, 30);
        for (const line of frame.lines) expect(displayWidth(line)).toBe(cols);
      }
    }
  });

  it("shows the tail of the capture and passes SGR colors through", () => {
    const lines = Array.from({ length: 40 }, (_, i) => `line_${i}`);
    lines[39] = "\x1b[31mlast line\x1b[0m";
    const frame = renderBoard(
      view({ pi: { pr: 5012, lines, missing: false, stale: false, offset: 0 } }),
      100,
      24,
    );
    const raw = frame.lines.join("\n");
    expect(raw).toContain("\x1b[31mlast line");
    const text = frame.lines.map(stripAnsi).join("\n");
    expect(text).toContain("last line");
    // At 100 columns the bar wraps to three rows (the nav slots, the globals,
    // the board's verbs), so the pane shows 7 lines.
    expect(text).toContain("line_33"); // tail, not head
    expect(text).not.toContain("line_32");
    expect(text).not.toContain("line_0 ");
  });

  it("falls back to a no-session line, keeping the last capture marked (stale)", () => {
    const gone = renderBoard(
      view({ pi: { pr: 5012, lines: [], missing: true, stale: false, offset: 0 } }),
      100,
      24,
    )
      .lines.map(stripAnsi)
      .join("\n");
    expect(gone).toContain("no pi session for #5012");
    expect(gone).not.toContain("(stale)");

    const stale = renderBoard(
      view({ pi: { pr: 5012, lines: ["old output"], missing: true, stale: true, offset: 0 } }),
      100,
      24,
    )
      .lines.map(stripAnsi)
      .join("\n");
    expect(stale).toContain("no pi session for #5012 · (stale)");
    expect(stale).toContain("old output");
  });

  it("ignores a mirror belonging to another PR (selection moved, capture in flight)", () => {
    const text = renderBoard(
      view({ pi: { pr: 5049, lines: ["other pr"], missing: false, stale: false, offset: 0 } }),
      100,
      24,
    )
      .lines.map(stripAnsi)
      .join("\n");
    expect(text).toContain("PI pr-5012 · connecting…");
    expect(text).not.toContain("other pr");
  });

  it("declares the whole pane region as one focus zone (never an attach zone)", () => {
    const frame = renderBoard(
      view({ pi: { pr: 5012, lines: ["x"], missing: false, stale: false, offset: 0 } }),
      100,
      24,
    );
    const piTop = frame.meta["piTop"]!;
    const zone = frame.zones.find((z) => (z.action as { t: string }).t === "pi-focus");
    expect(zone).toBeDefined();
    expect(zone!.y1).toBe(piTop + 1); // divider row included — the whole region
    expect(zone!.y2).toBe(piTop + frame.meta["piRows"]!);
    expect(frame.zones.some((z) => (z.action as { t: string }).t === "attach")).toBe(false);
  });

  it("accents the header and divider while the pane owns the keyboard", () => {
    const pi = { pr: 5012, lines: ["x"], missing: false, stale: false, offset: 0 };
    const frame = renderBoard(view({ pi, piFocus: true, piPr: 5012 }), 100, 24);
    const text = frame.lines.map(stripAnsi).join("\n");
    expect(text).toContain("PI pr-5012 · focused · Ctrl-q back to board");
    expect(text).not.toContain("click to type");
    expect(frame.lines[frame.meta["piTop"]!]).toContain("━"); // heavy divider cue
  });

  it("shows the scrollback offset and drops that many lines off the tail", () => {
    const lines = Array.from({ length: 40 }, (_, i) => `line_${i}`);
    const text = renderBoard(
      view({ pi: { pr: 5012, lines, missing: false, stale: false, offset: 6 } }),
      100,
      24,
    )
      .lines.map(stripAnsi)
      .join("\n");
    expect(text).toContain("↑ 6 lines back · End live");
    expect(text).toContain("line_33"); // 39 - 6
    expect(text).not.toContain("line_34");
  });

  it("keeps painting the locked session when the pane is focused elsewhere", () => {
    const pi = { pr: 5049, lines: ["locked output"], missing: false, stale: false, offset: 0 };
    const text = renderBoard(view({ pi, piFocus: true, piPr: 5049, selected: 0 }), 100, 24)
      .lines.map(stripAnsi)
      .join("\n");
    expect(text).toContain("PI pr-5049 · focused");
    expect(text).toContain("locked output");
  });

  it("declares PR zones only on rows the list actually paints — never on the legend", () => {
    const prs = Array.from({ length: 40 }, (_, i) => ({
      number: 6000 + i,
      state: "reviewing" as const,
      title: `pr ${i}`,
      head_sha: "a2e380ff11",
      stale_recheck: 0,
    }));
    const frame = renderBoard(view({ snapshot: { ...snapshot, prs } }), 140, 30);
    const bodyRows = frame.meta["bodyRows"]!;
    const legendY = 1 + (bodyRows - 1) + 1; // frame row of the legend → terminal y
    const text = frame.lines.map(stripAnsi);
    for (const z of frame.zones) {
      const t = (z.action as { t: string }).t;
      if (t !== "select-pr" && t !== "open-github") continue;
      expect(z.y1).toBeLessThan(legendY);
      const pr = (z.action as { pr: number }).pr;
      expect(text[z.y1 - 1]).toContain(String(pr)); // the zone's own PR is painted there
    }
  });

  it("scrolls the PR list so the selected row stays painted and clickable", () => {
    // `j` walks the whole sorted list; a list painted from index 0 would lose
    // the highlight (and its click target) once the selection passed the
    // visible rows — while m/u/g still acted on that invisible PR.
    const prs = Array.from({ length: 40 }, (_, i) => ({
      number: 6000 + i,
      state: "reviewing" as const,
      title: `pr ${i}`,
      head_sha: "a2e380ff11",
      stale_recheck: 0,
    }));
    for (const selected of [0, 20, 39]) {
      const frame = renderBoard(view({ snapshot: { ...snapshot, prs }, selected }), 140, 40);
      const bodyRows = frame.meta["bodyRows"]!;
      const legendY = 1 + (bodyRows - 1) + 1;
      const pr = 6000 + selected;
      const zone = frame.zones.find(
        (z) =>
          (z.action as { t: string; pr?: number }).t === "select-pr" &&
          (z.action as { pr: number }).pr === pr,
      );
      expect(zone, `selected #${pr} has a click target`).toBeDefined();
      expect(zone!.y1).toBeLessThan(legendY);
      const text = frame.lines.map(stripAnsi);
      expect(text[zone!.y1 - 1]).toContain(String(pr));
      expect(text.join("\n")).toContain("PRS (40)"); // the header never scrolls away
    }
  });

  it("the events overlay is opaque: nothing it covers stays clickable", () => {
    const events = [
      { ts: "t0", text: "10:00:00 verdict_applied #5049", anomaly: false },
      { ts: "t1", text: "10:00:01 reconcile ok", anomaly: false },
    ];
    const pi = { pr: 5012, lines: ["x"], missing: false, stale: false, offset: 0 };
    const frame = renderBoard(view({ events, eventsFocus: true, pi }), 100, 24);
    const { top, height } = eventsOverlayBandFor(24, frame);
    for (let y = top + 1; y <= top + height; y++)
      for (let x = 1; x <= 100; x++) {
        const hit = hitTest(frame.zones as Zone<{ t: string }>[], x, y);
        if (hit) expect(hit.t).toBe("event-jump");
      }
    // And the parts of the pi region the band leaves visible still focus it.
    expect(frame.zones.some((z) => (z.action as { t: string }).t === "pi-focus")).toBe(true);
  });

  it("toggles the events overlay on e, with its own scroll and jump zones", () => {
    const events = Array.from({ length: 6 }, (_, i) => ({
      ts: `t${i}`,
      text: `10:00:0${i} verdict_applied #504${i}`,
      anomaly: false,
    }));
    const closed = renderBoard(view({ events }), 100, 24).lines.map(stripAnsi).join("\n");
    expect(closed).not.toContain("EVENTS");

    const frame = renderBoard(view({ events, eventsFocus: true }), 100, 24);
    const text = frame.lines.map(stripAnsi).join("\n");
    expect(text).toContain("EVENTS");
    expect(text).toContain("j/k scroll · e/Esc close");
    expect(text).toContain("verdict_applied #5040");
    expect(
      frame.zones.some((z) => (z.action as { t: string; pr?: number }).t === "event-jump"),
    ).toBe(true);
    // The command bar keeps its constant "e events" button while it is open.
    const wide = renderBoard(view({ events, eventsFocus: true }), 220, 24)
      .lines.map(stripAnsi)
      .join("\n");
    expect(wide).toContain("e events");

    const scrolled = renderBoard(view({ events, eventsFocus: true, eventsScroll: 2 }), 100, 24)
      .lines.map(stripAnsi)
      .join("\n");
    expect(scrolled).not.toContain("verdict_applied #5040");
    expect(scrolled).toContain("verdict_applied #5042");
  });

  it("renders the help overlay over the board", () => {
    const text = renderBoard(view({ help: true }), 100, 30)
      .lines.map(stripAnsi)
      .join("\n");
    expect(text).toContain("KEYS");
    expect(text).toContain("Ctrl-q");
    expect(text).not.toContain("PRS (2)");
  });

  it("renders the quick-message input box in place of the events strip", () => {
    const text = renderBoard(
      view({ inputBox: { target: "#5012 (pi session pr-5012)", text: "also check" } }),
      100,
      24,
    )
      .lines.map(stripAnsi)
      .join("\n");
    expect(text).toContain("MSG → #5012 (pi session pr-5012)");
    expect(text).toContain("> also check");
    expect(text).toContain("⏎ send · Esc cancel");
  });

  // A memory edit opens the box on the whole entry: multi-line, longer than
  // the pane, and not guaranteed free of control bytes. The row the operator
  // types into must show where they type — the end and its cursor — on one
  // clean line.
  // MUTATION: paint `box.text` raw through `fit` — the suffix, the cursor and
  // the ⏎ markers vanish and the raw newline and ESC reach the row — red.
  it("paints a long multi-line draft as one clean line ending at the cursor", () => {
    const text =
      "#lesson kind=look-for lens=pass-baseline class=x\n\n" +
      "A long body that runs well past the width of the pane \x1b[31mwith a stray escape\x1b[0m " +
      "and more words after it to push the end out of sight. AMENDED";
    const check = (row: string, cols: number): void => {
      expect(row).toContain("AMENDED▁");
      expect(row).toContain("…");
      expect(row).not.toMatch(/[\n\x1b]/);
      expect(displayWidth(row)).toBe(cols);
    };
    const frame = new Frame(60, 20);
    overlayInputBox(frame, { target: "edit 01a01b03", text });
    check(
      frame.lines.find((l) => l.includes("> "))!,
      60,
    );
    const board = renderBoard(view({ inputBox: { target: "#5012", text } }), 60, 24);
    const row = board.lines.find((l) => stripAnsi(l).includes("│ > "))!;
    check(stripAnsi(row), 60);
    const short = new Frame(60, 20);
    overlayInputBox(short, { target: "t", text: "one\ntwo" });
    expect(short.lines.find((l) => l.includes("> "))).toContain("> one⏎two▁");
  });
});

describe("key decoding", () => {
  it("decodes navigation and action keys", () => {
    expect(decodeKey(Buffer.from("j"))).toEqual({ kind: "down" });
    expect(decodeKey(Buffer.from("\x1b[A"))).toEqual({ kind: "up", arrow: true });
    expect(decodeKey(Buffer.from("\r"))).toEqual({ kind: "enter" });
    expect(decodeKey(Buffer.from("q"))).toEqual({ kind: "quit" });
    expect(decodeKey(Buffer.from("\x03"))).toEqual({ kind: "quit" });
    // `o`/`M` are not verbs: the TUI never attaches full-screen, so both are
    // plain text the board hands to the companion column like any other
    // unclaimed printable.
    expect(decodeKey(Buffer.from("M"))).toEqual({ kind: "char", ch: "M" });
    expect(decodeKey(Buffer.from("o"))).toEqual({ kind: "char", ch: "o" });
    expect(decodeKey(Buffer.from("?"))).toEqual({ kind: "help" });
    expect(decodeKey(Buffer.from("a"))).toEqual({ kind: "attach" }); // ⏎'s twin
  });

  it("keeps printable text as chars in the input box, reserving control keys", () => {
    expect(decodeInputKey(Buffer.from("q"))).toEqual({ kind: "char", ch: "q" });
    expect(decodeInputKey(Buffer.from("\x1b\r"))).toEqual({ kind: "alt-enter" });
    expect(decodeInputKey(Buffer.from("\x7f"))).toEqual({ kind: "backspace" });
    expect(decodeInputKey(Buffer.from("\x1b"))).toEqual({ kind: "escape" });
  });
});

describe("remote argv builders", () => {
  it("reads status.json from the topology's state volume", () => {
    expect(statusArgv(TUI_DEFAULTS)).toEqual(["cat", "/opt/quickreview/state/status.json"]);
    const local = {
      ...TUI_DEFAULTS,
      target: "local" as const,
      container: "compose-daemon",
      sudo_docker: false,
    };
    expect(statusArgv(local)).toEqual([
      "docker",
      "exec",
      "compose-daemon",
      "cat",
      "/opt/quickreview/state/status.json",
    ]);
    expect(progressArgv(local, 5012)).toEqual([
      "docker",
      "exec",
      "compose-daemon",
      "cat",
      "/opt/quickreview/state/round-progress/pr-5012.json",
    ]);
    expect(statusArgv({ ...local, sudo_docker: true })).toEqual([
      "sudo",
      "docker",
      "exec",
      "compose-daemon",
      "cat",
      "/opt/quickreview/state/status.json",
    ]);
  });

  it("runs read-only CLI calls inside the container with sudo docker", () => {
    expect(whyArgv(TUI_DEFAULTS, 5012)).toEqual([
      "sudo",
      "docker",
      "exec",
      "quickreview-sandbox",
      "node",
      "dist/src/cli.js",
      "why",
      "5012",
      "--json",
    ]);
    expect(eventsArgv(TUI_DEFAULTS, 20)).toContain("--tail");
    expect(progressArgv(TUI_DEFAULTS, 5012)).toEqual([
      "cat",
      "/opt/quickreview/state/round-progress/pr-5012.json",
    ]);
  });

  it("drops sudo when configured off", () => {
    expect(whyArgv({ ...TUI_DEFAULTS, sudo_docker: false }, 1)[0]).toBe("docker");
  });
});

describe("the mirrored pi session gets the board's real geometry", () => {
  // A tmux session the daemon created detached sits at 80×24 forever, so
  // unless resized pi wraps its output at 80 columns however wide the board
  // paints the mirror: the text crowds into the left of the pane and a
  // selection drawn over the empty remainder picks up nothing.
  it("is the painted rectangle: two chrome rows off, borders and the leading space off the width", () => {
    expect(piPaneSize(100, 24, 2)).toEqual({ cols: 96, rows: piRows(24, 2) - 2 });
    expect(piPaneSize(200, 60, 2)).toEqual({ cols: 196, rows: piRows(60, 2) - 2 });
    expect(piPaneSize(100, 24, 3)).toEqual({ cols: 96, rows: piRows(24, 3) - 2 });
  });

  it("has no rectangle to offer when the pane is squeezed out of existence", () => {
    expect(piPaneSize(100, 6, 2)).toBeUndefined(); // piRows floors to 0 here
    expect(piPaneSize(3, 40, 2)).toBeUndefined();
    expect(piPaneSize(0, 0, 2)).toBeUndefined();
  });

  it("folds resize-window into the capture, ahead of it and in one invocation", () => {
    // One invocation matters: a separate resize could land after the capture
    // and the mirror would paint a frame laid out for the previous size.
    const argv = captureArgv(TUI_DEFAULTS, "pr-5012", undefined, { cols: 96, rows: 8 });
    expect(argv.indexOf("resize-window")).toBeLessThan(argv.indexOf("capture-pane"));
    expect(argv.slice(argv.indexOf("resize-window"))).toEqual([
      "resize-window",
      "-t",
      "pr-5012",
      "-x",
      "96",
      "-y",
      "8",
      ";",
      "capture-pane",
      "-e",
      "-p",
      "-J",
      "-t",
      "pr-5012",
    ]);
  });

  it("captures exactly as before when no rectangle is known yet", () => {
    // First capture can precede the first paint; it must not invent a size.
    expect(captureArgv(TUI_DEFAULTS, "pr-5012")).not.toContain("resize-window");
  });

  it("keeps the last usable rectangle rather than sending a degenerate one", () => {
    const seen: string[][] = [];
    const ssh: SshRunner = async (_h, argv) => {
      seen.push(argv);
      return { ok: true, stdout: "pane", stderr: "", code: 0 };
    };
    const mirror = new PiMirror(TUI_DEFAULTS, ssh);
    mirror.setViewport({ cols: 96, rows: 8 });
    mirror.setViewport(undefined); // board collapsed to nothing mid-resize
    mirror.setViewport({ cols: 0, rows: 8 });
    return mirror.fetch(5012).then(() => {
      expect(seen[0]).toContain("resize-window");
      expect(seen[0]?.slice(seen[0].indexOf("-x"), seen[0].indexOf("-x") + 4)).toEqual([
        "-x",
        "96",
        "-y",
        "8",
      ]);
    });
  });
});

describe("the DOUBTED overflow", () => {
  // `qcr why` text prints no findings; only its JSON carries the rest.
  // MUTATION: point the hint at plain `qcr why` — red.
  it("points at the view that actually lists the findings it cut", async () => {
    const { doubtedLines } = await import("../src/tui/board.js");
    const doubted = Array.from({ length: 10 }, (_, i) => ({
      round_no: i,
      lens: "pass-baseline",
      path: null,
      line: null,
      severity: null,
      word: "refuted",
      reason: null,
    }));
    const lines = doubtedLines(doubted, 80).map(stripAnsi);
    expect(lines.at(-1)).toBe("  … 2 more (qcr why <pr> --json)");
  });
});

it("fills every input-box row up to its companion border", () => {
  const frame = renderBoard(view({ inputBox: { target: "#5012", text: "hello" } }), 100, 40);
  const end = frame.meta["piTop"]! + frame.meta["piRows"]! - 1;
  expect(stripAnsi(frame.lines[end]!)).toMatch(/^│.*│$/);
});

describe("the transcript viewer in the board's pane", () => {
  const why: WhyPayload = {
    pr: 5012,
    known: true,
    state: "reviewing",
    title: "fix(crm): retry send_message",
    head_sha: "a2e380ff11",
    trigger_ts: "2026-10-19T11:00:00Z",
    spend_usd: 1.3,
    rounds: [],
    threads: { open: 0, total: 0 },
    ledger: "",
  };
  const RUNNING = {
    round_no: 3,
    round_type: "re-review",
    status: "running" as const,
    started_at: "2026-10-19T11:50:00Z",
    deadline_at: "2026-10-19T12:50:00Z",
    lenses: "pass-baseline,pass-security,pass-security",
    validate_tier: null,
    command_id: "cmd-3",
    command_sha256: "b".repeat(64),
    head_sha: "head-1",
  };
  const PROGRESS = {
    version: 2 as const,
    pr: 5012,
    session: "pr-5012",
    command_id: "cmd-3",
    command_sha256: "b".repeat(64),
    command_accepted_at: "2026-10-19T11:50:01Z",
    preparing_at: "2026-10-19T11:50:01Z",
    round_no: 3,
    head_sha: "head-1",
    run_started_at: "2026-10-19T11:50:01Z",
    updated_at: "2026-10-19T11:59:59Z",
    parent_status: "active" as const,
    last_activity_at: "2026-10-19T11:59:58Z",
    last_activity: "pass-security · grep",
    agents: [
      {
        execution_id: "a",
        agent: "pass-baseline--sol-high",
        status: "completed" as const,
        duration_ms: 1000,
        tool_count: 1,
        started_at: "2026-10-19T11:51:00Z",
      },
      {
        execution_id: "b",
        agent: "pass-security--sol-high",
        status: "running" as const,
        duration_ms: 1000,
        tool_count: 1,
        started_at: "2026-10-19T11:51:00Z",
      },
      {
        execution_id: "c",
        agent: "pass-security--sol-high",
        status: "running" as const,
        duration_ms: 1000,
        tool_count: 1,
        started_at: "2026-10-19T11:51:00Z",
      },
      {
        execution_id: "d",
        agent: "pass-extra--sol-high",
        status: "completed" as const,
        duration_ms: 1000,
        tool_count: 1,
        started_at: "2026-10-19T11:51:00Z",
      },
    ],
  };
  const NOW = new Date("2026-10-19T12:00:00Z");
  const running = { ...snapshot.prs[0]!, runtime: "worker" as const, current_round: RUNNING };
  const workerSnapshot: StatusSnapshot = { ...snapshot, prs: [running, snapshot.prs[1]!] };
  const viewerPane: PiPaneView = {
    pr: 5012,
    lines: ["12:00:01  tool lens pass-security", "    the diff reads clean", "last line"],
    missing: false,
    stale: false,
    offset: 0,
    viewer: {
      round: 3,
      rounds: 3,
      roundIndex: 3,
      atLatest: true,
      stream: "main",
      streamIndex: 1,
      streams: 3,
      live: true,
    },
  };
  const liveView = (over: Partial<BoardView> = {}): BoardView =>
    view({
      snapshot: workerSnapshot,
      detail: { ...why, pr: 5012, rounds: [] },
      progress: PROGRESS,
      pi: viewerPane,
      now: NOW,
      ...over,
    });

  it("detailLines names each lens row by line, lens and which run of it", () => {
    const rows: import("../src/tui/board.js").ProgressRow[] = [];
    const lines = detailLines(
      { ...why, pr: 5012, rounds: [] },
      running,
      80,
      NOW,
      PROGRESS,
      rows,
    ).map(stripAnsi);
    expect(rows.map((r) => [r.lens, r.nth])).toEqual([
      ["pass-baseline", 0],
      ["pass-security", 0],
      ["pass-security", 1],
      ["pass-extra", 0], // a lens the session added: a row too
    ]);
    for (const r of rows) expect(lines[r.line]).toContain(r.lens);
    expect(lines[rows[2]!.line]).toContain("pass-security · running");
  });

  it("a click on a progress row is a viewer-lens zone over exactly that painted row", () => {
    const frame = renderBoard(liveView(), 100, 40);
    const zones = (frame.zones as Zone<BoardAction>[]).filter((z) => z.action.t === "viewer-lens");
    expect(zones.map((z) => z.action)).toEqual([
      { t: "viewer-lens", lens: "pass-baseline", nth: 0 },
      { t: "viewer-lens", lens: "pass-security", nth: 0 },
      { t: "viewer-lens", lens: "pass-security", nth: 1 },
      { t: "viewer-lens", lens: "pass-extra", nth: 0 },
    ]);
    for (const z of zones) {
      expect(z.y1).toBe(z.y2);
      const action = z.action as { lens: string };
      expect(stripAnsi(frame.lines[z.y1 - 1]!)).toContain(action.lens);
      // a hit lands on the row, in the detail column, and nowhere in the list
      expect(hitTest(frame.zones as Zone<unknown>[], z.x1, z.y1)).toEqual(z.action);
      expect(z.x1).toBeGreaterThan(frame.meta["listW"] ?? 0);
    }
  });

  it("declares no lens zones while the pane is a mirror, or for another PR's viewer", () => {
    const mirror = renderBoard(liveView({ pi: { ...viewerPane, viewer: undefined } }), 100, 40);
    expect((mirror.zones as Zone<BoardAction>[]).some((z) => z.action.t === "viewer-lens")).toBe(
      false,
    );
    const other = renderBoard(liveView({ pi: { ...viewerPane, pr: 5049 } }), 100, 40);
    expect((other.zones as Zone<BoardAction>[]).some((z) => z.action.t === "viewer-lens")).toBe(
      false,
    );
  });

  it("paints the transcript bottom-anchored, parked by the offset", () => {
    const rows = 30;
    const frame = renderBoard(liveView(), 100, rows);
    const text = frame.lines.map(stripAnsi).join("\n");
    expect(text).toContain("the diff reads clean");
    expect(text).toContain("last line");
    const parked = renderBoard(liveView({ pi: { ...viewerPane, offset: 1 } }), 100, rows);
    const ptext = parked.lines.map(stripAnsi).join("\n");
    expect(ptext).toContain("the diff reads clean");
    expect(ptext).not.toContain("last line");
  });

  it("the header says where the viewer is, and its keys", () => {
    const h = stripAnsi(piHeader(5012, viewerPane));
    expect(h).toContain("LIVE pr-5012");
    expect(h).toContain("r3 (3/3)");
    expect(h).toContain("main (1/3)");
    expect(h).toContain("running");
    expect(h).toContain("following");
    expect(h).toContain("[ ] stream · < > round");
    expect(h).not.toContain("read-only");

    const past = stripAnsi(
      piHeader(5012, {
        ...viewerPane,
        offset: 12,
        viewer: { ...viewerPane.viewer!, roundIndex: 1, atLatest: false, live: false },
      }),
    );
    expect(past).toContain("r3 (1/3) · past");
    expect(past).toContain("settled");
    expect(past).toContain("↑ 12 rows back");
    expect(past).toContain("End follows");

    const focused = stripAnsi(piHeader(5012, viewerPane, true));
    expect(focused).toContain("read-only");
    expect(focused).toContain("Ctrl-q");

    const none = stripAnsi(
      piHeader(5012, { ...viewerPane, viewer: { ...viewerPane.viewer!, round: undefined } }),
    );
    expect(none).toContain("no round log yet");
  });

  it("a terminal surface names its own tmux session in the header", () => {
    const h = stripAnsi(
      piHeader(5012, {
        pr: 5012,
        lines: ["x"],
        missing: false,
        stale: false,
        offset: 0,
        session: "debug-pr-5012",
      }),
    );
    expect(h).toContain("PI debug-pr-5012");
    const gone = stripAnsi(
      piHeader(5012, {
        pr: 5012,
        lines: [],
        missing: true,
        stale: false,
        offset: 0,
        session: "takeover-pr-5012",
      }),
    );
    expect(gone).toContain("takeover-pr-5012");
  });

  it("the viewer's keys are registered only for a viewer PR", async () => {
    const { boardKeys } = await import("../src/tui/board.js");
    const keysFor = (runtime: string | undefined) =>
      boardKeys({
        snapshot: {
          ...snapshot,
          prs: [{ ...snapshot.prs[0]!, ...(runtime ? { runtime: runtime as never } : {}) }],
        },
        selected: 0,
        boardFilter: null,
        repo: undefined,
      }).inline;
    for (const rt of ["worker", "answer", "idle"])
      expect(keysFor(rt), rt).toEqual(["a", "[", "]", "<", ">"]);
    for (const rt of [undefined, "tmux", "debug", "takeover", "other"])
      expect(keysFor(rt), String(rt)).toEqual(["a"]);
  });
});
