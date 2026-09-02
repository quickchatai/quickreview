// Metrics tab (key 5) — the aggregate dashboard: a Pulse-style stat
// strip for the selected window, then width-adaptive cards over the
// MetricsPayload `qcr metrics --json` produces, plus a per-PR timeline
// drill-down from `qcr metrics --pr <n> --json`.
//
// Presentation rules (2026-08-14 design review — "single row would work much
// better"): a distribution is ONE chart row of per-bucket glyph columns with a
// dim boundary row under it and its stats inline in the title, so a card is at
// most title+chart+labels; bar lists keep one thin `█` bar per entity on a dim
// `░` track with the value outside the bar in normal ink; text is never set
// inside a filled block; every card owns a FIXED accent hue (five in rotation,
// never adjacent) while entity bars keep their semantic colors; cards are
// packed into 1/2/3 columns balanced by real rendered height, and a tall
// terminal grows ACTIVITY into stacked multi-row column charts.
//
// Read-only like every other tab: the only VM touch is the two qcr reads
// through the shared ssh runner, cached stale-while-revalidate.
import type { Dist, DailyRow, MetricsPayload, MetricsWindow, OpsInfo, TimelinePayload } from "../metrics.js";
import type { TuiConfig } from "../config.js";
import type { App } from "./app.js";
import { paintCmdBar } from "./cmdbar.js";
import { HEAD_ARGV, logArgv, type LocalRunner } from "./deploytab.js";
import type { BoardKey } from "./keys.js";
// `MUTED` is LOAD-BEARING as of — it paints the TIME IN STATE card's
// retired-state rows (see that card below). It was an unused import for a
// while and reads like one at a glance, so: removing it is a compile error,
// not a cleanup. Flagged here because the unused-symbol sweep
// removed it independently, and a merge of the two auto-applies cleanly into
// `TS2304: Cannot find name 'MUTED'` — a semantic conflict git cannot see.
import { ACCENT, ACCENT_BG, BAD, HEADING, MUTED, OK, RESET as DRESET, SEP, STRONG, WARN, modeBadge, sectionTitle } from "./design.js";
import { Frame, displayWidth, fit, rule, sanitizeText, truncate } from "./paint.js";
import { RETIRED_STATES, RETIRED_STATE_MARK, historicalStateLabel } from "./model.js";
import { metricsArgv, metricsPrArgv, type SshRunner } from "./remote.js";
import { FG, RESET, fmtAge, stateColor, verdictColor } from "./theme.js";

// ---- chart primitives -------------------------------------------------------

const SPARK = ["▁", "▂", "▃", "▄", "▅", "▆", "▇", "█"] as const;

/** Card accents — §8 ("muted + one accent") retired the five-hue
 * rotation: every card mark rides the ONE accent; red/green/state colors
 * remain only where they carry truth (verdicts, states, failures). The keys
 * survive so card definitions stay diff-stable. */
export const ACCENTS = {
  cyan: ACCENT,
  blue: ACCENT,
  green: ACCENT,
  magenta: ACCENT,
  yellow: ACCENT,
} as const;

function dim(s: string): string {
  return `${FG.dim}${s}${RESET}`;
}

/** Average `values` down to exactly `n` buckets (oldest first is the contract). */
function bucketize(values: number[], n: number): number[] {
  if (n <= 0 || values.length === 0) return [];
  if (values.length <= n) return [...values];
  const per = values.length / n;
  const out: number[] = [];
  for (let i = 0; i < n; i++) {
    const slice = values.slice(Math.floor(i * per), Math.max(Math.floor((i + 1) * per), Math.floor(i * per) + 1));
    out.push(slice.reduce((a, b) => a + b, 0) / slice.length);
  }
  return out;
}

/**
 * One-line trend. Longer series than `width` are bucket-averaged (oldest
 * first is the caller's contract); an all-zero series renders as the floor
 * glyph rather than pretending to a shape.
 */
export function sparkline(values: number[], width: number): string {
  const w = Math.max(0, Math.floor(width));
  if (w === 0 || values.length === 0) return "";
  const buckets = bucketize(values, Math.min(values.length, w));
  const max = Math.max(...buckets);
  if (max <= 0) return SPARK[0]!.repeat(buckets.length);
  return buckets.map((v) => SPARK[Math.min(SPARK.length - 1, Math.max(0, Math.floor((v / max) * (SPARK.length - 1))))]!).join("");
}

/** Label column width for a bar row — under a third of the card, clamped. */
function labelWidth(width: number): number {
  return Math.min(16, Math.max(6, Math.floor(width * 0.3)));
}

/**
 * `label ███░░░░      value` in exactly `width` cells. The bar is THIN — it
 * never eats more than 60% of the row — the unfilled remainder is a dim `░`
 * track so a bar end is readable, and the value sits outside the bar in
 * normal ink. `max <= 0` renders an empty track: a zero row is still a row.
 */
export function hbar(label: string, value: number, max: number, width: number, valueText?: string, color?: string): string {
  const w = Math.max(8, Math.floor(width));
  const lw = labelWidth(w);
  const vt = valueText ?? String(value);
  const vw = Math.min(displayWidth(vt), Math.max(0, w - lw - 4));
  const avail = w - lw - 3 - vw; // gutters + one cell of right margin
  if (avail < 3) return fit(`${label} ${vt}`, w);
  // The bar scales across the whole row and the value rides at its end —
  // no cap, no track run-out to the far margin (the owner, 2026-08-14).
  const filled = max > 0 ? Math.min(avail, Math.max(value > 0 ? 1 : 0, Math.round((value / max) * avail))) : 0;
  const bar = filled > 0 ? `${color ?? ""}${"█".repeat(filled)}${color ? RESET : ""}` : dim("·");
  return `${fit(label, lw)} ${bar} ${truncate(vt, vw)}`;
}

/** `median 5m · p90 16m · n=56` — the distribution's stats, for a card title. */
export function distStats(dist: Dist, fmt: (v: number) => string = String): string {
  if (dist.n === 0) return "no data yet";
  return `median ${fmt(dist.median ?? 0)} · p90 ${fmt(dist.p90 ?? 0)} · n=${dist.n}`;
}

/**
 * A whole distribution in TWO rows: one chart row of per-bucket glyph columns
 * (2–3 cells each, scaled to the max count, in the card's accent; an empty
 * bucket is a single dim `·`), and one dim row of bucket boundaries under it.
 * Stats live in the card title — see `distStats`.
 */
export function histogramLines(dist: Dist, width: number, color: string = FG.accent): string[] {
  if (dist.n === 0 || dist.histogram.length === 0) return []; // the title already reads "no data yet"
  const w = Math.max(4, Math.floor(width));
  const buckets = dist.histogram;
  // Slots widen with the terminal (up to 12 cells) and the bars get real
  // height — a small column chart, not a row of nubs (the owner, 2026-08-14).
  // Buckets spread across the full width with a 2-space gap and sit on a dim
  // baseline, so the shape reads as one chart instead of floating strips.
  const slot = Math.max(3, Math.min(18, Math.floor((w + 2) / buckets.length)));
  const cell = Math.max(1, slot - 2);
  const height = 4;
  const max = buckets.reduce((m, b) => Math.max(m, b.count), 0);
  const levels = buckets.map((b) =>
    b.count <= 0 || max <= 0 ? 0 : Math.max(1, Math.ceil((b.count / max) * height * 8)),
  );
  const chartW = buckets.length * slot - 2;
  const rows: string[] = [];
  for (let r = height - 1; r >= 0; r--) {
    const row = buckets
      .map((b, i) => {
        const rem = levels[i]! - r * 8;
        if (rem >= 8) return `${color}${"█".repeat(cell)}${RESET}`;
        if (rem > 0) return `${color}${SPARK[rem - 1]!.repeat(cell)}${RESET}`;
        return " ".repeat(cell);
      })
      .join("  ");
    rows.push(truncate(row, w));
  }
  rows.push(truncate(dim("▔".repeat(Math.min(chartW, w))), w));
  const counts = buckets.map((b) => fit(b.count > 0 ? String(b.count) : "·", slot)).join("").trimEnd();
  const axis = buckets.map((b) => fit(b.label.replace(/^</, ""), slot)).join("").trimEnd();
  rows.push(truncate(dim(counts), w));
  rows.push(truncate(dim(axis), w));
  return rows;
}

/**
 * Multi-row column chart (tall terminals): block glyphs stacked per column,
 * full `█` rows plus a fractional top glyph, single hue, dim `·` baseline for
 * a zero day. Series longer than the width are bucket-averaged.
 */
export function columnChart(values: number[], width: number, height: number, color: string): string[] {
  const w = Math.max(1, Math.floor(width));
  const h = Math.max(1, Math.floor(height));
  if (values.length === 0) return [];
  // Columns widen with the terminal — up to 5 cells of bar per value plus a
  // one-space gap, so a wide pane fills instead of showing thin threads.
  const slot = Math.max(1, Math.min(6, Math.floor((w + 1) / values.length)));
  const cell = Math.max(1, slot - 1);
  const n = Math.min(values.length, Math.max(1, Math.floor((w + 1) / slot)));
  const vals = bucketize(values, n);
  const max = Math.max(...vals, 0);
  const gap = slot > 1 ? " " : "";
  const rows: string[] = [];
  for (let r = 0; r < h; r++) {
    const cells = vals.map((v) => {
      const eighths = max > 0 ? Math.round((v / max) * h * 8) : 0;
      const cellE = eighths - (h - 1 - r) * 8;
      if (cellE >= 8) return `${color}${"█".repeat(cell)}${RESET}${gap}`;
      if (cellE > 0) return `${color}${SPARK[cellE - 1]!.repeat(cell)}${RESET}${gap}`;
      return (r === h - 1 ? `${dim("·")}${" ".repeat(cell - 1)}` : " ".repeat(cell)) + gap;
    });
    rows.push(truncate(cells.join(""), w));
  }
  return rows;
}

/** Sparse day axis under a column chart: first, last, and weekly ticks. */
export function dayAxis(days: string[], width: number, slot: number): string {
  const w = Math.max(0, Math.floor(width));
  const buf = new Array<string>(w).fill(" ");
  const put = (idx: number, text: string): void => {
    const start = Math.min(Math.max(0, idx * slot), w - text.length);
    if (start < 0) return;
    for (let i = start - 1; i <= start + text.length; i++) if (i >= 0 && i < w && buf[i] !== " ") return;
    for (let i = 0; i < text.length; i++) buf[start + i] = text[i]!;
  };
  const short = (d: string): string => (d.length >= 10 ? d.slice(5) : d);
  if (days.length === 0) return "";
  put(0, short(days[0]!));
  if (days.length > 1) put(days.length - 1, short(days[days.length - 1]!));
  for (let i = 7; i < days.length - 1; i += 7) put(i, short(days[i]!));
  return dim(buf.join("").trimEnd());
}

/** 45s / 12m / 3h / 2d from a second count — fmtAge's vocabulary, no clock. */
export function fmtDur(seconds: number | null | undefined): string {
  if (seconds === null || seconds === undefined) return "—";
  const s = Math.max(0, Math.round(seconds));
  if (s < 60) return `${s}s`;
  if (s < 3600) return `${Math.round(s / 60)}m`;
  if (s < 86_400) return `${(s / 3600).toFixed(1)}h`;
  return `${(s / 86_400).toFixed(1)}d`;
}

function usd(v: number | null | undefined): string {
  return v === null || v === undefined ? "—" : `$${v.toFixed(2)}`;
}

function pct(v: number | null | undefined): string {
  return v === null || v === undefined ? "—" : `${Math.round(v * 100)}%`;
}

// ---- the deploy-needed seam ---------------------------------------------------

/** What the laptop's git says about the commit the VM reports running. */
export interface LocalHeadState {
  head?: string;
  /** Commits in `deployed..HEAD`; undefined when the sha is unknown to git. */
  ahead?: number;
}

/** Injectable so tests (and machines without the repo) never spawn git. */
export interface LocalHeadProbe {
  read(deployedSha: string | null): Promise<LocalHeadState>;
}

/** The real probe: deploytab's own read-only argvs through its LocalRunner —
 * one implementation of "what is local HEAD / how far ahead is it". */
export function localHeadProbe(local: LocalRunner): LocalHeadProbe {
  return {
    async read(deployedSha) {
      const head = await local(HEAD_ARGV);
      const out: LocalHeadState = {};
      if (head.ok && head.stdout.trim()) out.head = head.stdout.trim();
      if (deployedSha) {
        const log = await local(logArgv(deployedSha));
        if (log.ok) out.ahead = log.stdout.split("\n").filter((l) => l.trim() !== "").length;
      }
      return out;
    },
  };
}

// ---- view state -------------------------------------------------------------

export type MetricsWindowKey = "d7" | "d30" | "all";

export const WINDOW_LABELS: Array<{ key: MetricsWindowKey; label: string; hotkey: string }> = [
  { key: "d7", label: "7d", hotkey: "7" },
  { key: "d30", label: "30d", hotkey: "0" },
  { key: "all", label: "all", hotkey: "a" },
];

export type MetricsAction = { t: "window"; window: MetricsWindowKey } | { t: "back" };

export interface MetricsView {
  window: MetricsWindowKey;
  payload?: MetricsPayload;
  error?: string;
  loading: boolean;
  /** Per-PR drill-down; set means the timeline replaces the dashboard. */
  drill?: { pr: number; payload?: TimelinePayload; error?: string; loading: boolean };
  /** Digits typed towards a drill-down (`#` opens the prompt). */
  prEntry?: string;
  /** Local git's answer for the deploy-needed line; absent without a probe. */
  local?: LocalHeadState;
  scroll: number;
  dryRun: boolean | undefined;
  now?: Date;
}

// ---- cards ------------------------------------------------------------------

/** Card title: the one section language; the accent param is retired
 * (§8 — one accent) but kept for signature stability. */
function section(title: string, subtitle: string, _accent: string = ACCENT): string {
  return sectionTitle(title, subtitle);
}

export interface MetricsCard {
  title: string;
  /** Stats/meaning, rendered dim on the title row — the card's whole legend. */
  subtitle: string;
  /** Fixed hue for this card's marks (never cycled, never reused adjacently). */
  accent: string;
  body: (width: number) => string[];
}

/** Single-hue bar list: identity is the row label, not the color. Capped. */
function barList(
  rows: Array<{ label: string; value: number; text: string; color?: string }>,
  width: number,
  accent: string,
  cap = 6,
): string[] {
  if (rows.length === 0) return [dim("no data yet")];
  const max = rows.reduce((m, r) => Math.max(m, r.value), 0);
  const shown = rows.slice(0, cap);
  const lines = shown.map((r) => hbar(r.label, r.value, max, width, r.text, r.color ?? accent));
  if (rows.length > cap) lines.push(dim(`…+${rows.length - cap} more`));
  return lines;
}

function barsFromRecord(rec: Record<string, number>, width: number, accent: string, fmt: (v: number) => string): string[] {
  const rows = Object.entries(rec)
    .sort((a, b) => b[1] - a[1])
    .map(([k, v]) => ({ label: k, value: v, text: fmt(v) }));
  return barList(rows, width, accent);
}

/** Heartbeats older than this read as a stalled daemon, not a slow tick. */
export const HEARTBEAT_STALE_S = 300;

/**
 * The OPERATIONS card body: how the daemon is running (mode, heartbeat,
 * concurrency), which commit it is running (BUILD_SHA marker) with an accented
 * "deploy needed" when the operator's checkout has moved past it, and the
 * window's aggregate event traffic as a thin bar list.
 *
 * `ops` absent (an older daemon's payload) or `local` absent (no git here —
 * tests, or a laptop without the repo) both degrade to fewer lines, never to a
 * throw or a fake answer.
 */
export function opsLines(
  ops: OpsInfo | undefined,
  local: LocalHeadState | undefined,
  win: MetricsWindow,
  width: number,
  now: Date,
): string[] {
  const lines: string[] = [];
  if (!ops) {
    lines.push(dim("no ops data in this payload (older daemon?)"));
  } else {
    // No snapshot at all means we cannot claim a mode — "LIVE" is the one
    // label that must never be guessed.
    const mode = ops.heartbeat === null ? dim("mode unknown") : modeBadge(ops.dry_run);
    const beatS = ops.heartbeat ? Math.max(0, Math.floor((now.getTime() - new Date(ops.heartbeat).getTime()) / 1000)) : null;
    const beat =
      ops.heartbeat === null
        ? `${FG.anomaly}no heartbeat${RESET}`
        : `${beatS !== null && beatS > HEARTBEAT_STALE_S ? BAD : OK}♥${DRESET} ${fmtAge(ops.heartbeat, now)} ago`;
    const rounds = `${STRONG}${ops.running_rounds}${DRESET}/${ops.max_concurrent_rounds} rounds running`;
    lines.push(`${mode}  ${beat} ${SEP} ${rounds}`);

    const b = ops.build;
    lines.push(
      b
        ? `running ${STRONG}${b.sha}${DRESET}${b.at ? ` ${FG.dim}· deployed ${fmtAge(b.at, now)} ago${RESET}` : ""}${b.mode ? ` ${FG.dim}· ${b.mode}${RESET}` : ""}`
        : dim("running an unknown commit — no BUILD_SHA on the VM yet"),
    );
    if (b && local?.head) {
      lines.push(
        local.head === b.sha
          ? `${OK}✓${DRESET} ${FG.dim}your checkout (${local.head}) is what the VM runs${RESET}`
          : `${WARN}${STRONG}deploy needed${DRESET}${SEP}` +
            `${local.ahead === undefined ? `local ${local.head} differs` : `${local.ahead} commit${local.ahead === 1 ? "" : "s"} ahead (${local.head})`}`,
      );
    }
  }

  lines.push("");
  lines.push(sectionTitle("EVENTS"));
  const kinds = win.events_by_kind ?? [];
  if (win.events_by_kind === undefined) {
    lines.push(dim("events are not reported by the daemon build on the VM"));
  } else if (kinds.length === 0) {
    lines.push(dim("no events in this window"));
  } else {
    const max = kinds.reduce((m, k) => Math.max(m, k.count), 0);
    for (const k of kinds.slice(0, 8)) lines.push(hbar(k.kind, k.count, max, width, String(k.count), ACCENTS.magenta));
    if (kinds.length > 8) lines.push(dim(`…+${kinds.length - 8} more kinds`));
  }
  return lines;
}

/**
 * The CANCELLED ROUNDS card.
 *
 * A cancelled round used to leave no trace anywhere a human looks — 55 of them
 * since the cutover against 5 loud `overdue`s. The card exists to invert that,
 * and it groups by cause because an ungrouped total is worse than nothing
 * here: most cancellation is the boot orphan sweep after a redeploy (a
 * container restart orphans every in-flight round by construction), and that
 * bar stays in normal ink no matter how tall it gets. Only a round that
 * STOPPED DEAD is marked.
 */
export function cancellationLines(win: MetricsWindow, width: number): string[] {
  const c = win.cancellations;
  // Not reported ≠ none: an older daemon build simply omits it.
  if (!c) return [dim("cancellations are not reported by the daemon build on the VM")];
  if (c.total === 0) return [dim("no cancelled rounds in this window")];
  const max = c.by_cause.reduce((m, b) => Math.max(m, b.count), 0);
  const lines = c.by_cause.map((b) =>
    hbar(b.label, b.count, max, width, String(b.count), b.loud ? BAD : ACCENTS.yellow),
  );
  lines.push("");
  lines.push(
    c.loud > 0
      ? `${BAD}${c.loud} stopped dead${DRESET} ${FG.dim}— no verdict inside the deadline; the rest is the system working${RESET}`
      : dim("none stopped dead — every cancellation here is a redeploy artefact or a superseded round"),
  );
  return lines;
}

function cancelSubtitle(win: MetricsWindow): string {
  const c = win.cancellations;
  if (!c || c.total === 0) return "by cause";
  return `${c.total} by cause · ${c.loud} stopped dead`;
}

/** Tall terminals earn a real column chart in the ACTIVITY card. */
export function activityChartHeight(rows: number): number {
  if (rows < 34) return 0; // short: the 1-row sparkline degradation
  return Math.max(6, Math.min(10, Math.floor((rows - 18) / 4)));
}

export interface MetricsCardsExtra {
  ops?: OpsInfo;
  local?: LocalHeadState;
  now?: Date;
}

export function metricsCards(win: MetricsWindow, daily: DailyRow[], rows = 24, extra: MetricsCardsExtra = {}): MetricsCard[] {
  const chartH = activityChartHeight(rows);
  const now = extra.now ?? new Date();
  const opsSubtitle = extra.ops
    ? `${extra.ops.dry_run ? "dry-run" : "live"} · ${extra.ops.build ? extra.ops.build.sha : "build unknown"}`
    : "daemon health · version · event traffic";
  return [
    {
      title: "ACTIVITY",
      subtitle: daily.length > 0 ? `${daily[0]!.day} → ${daily[daily.length - 1]!.day}` : "per ops day",
      accent: ACCENTS.cyan,
      body: (w) => {
        if (daily.length === 0) return [dim("no data yet")];
        const rounds = daily.map((d) => d.rounds);
        const prs = daily.map((d) => d.prs);
        const spend = daily.map((d) => d.spend_usd);
        const days = daily.map((d) => d.day);
        if (chartH > 0) {
          const slot = Math.max(1, Math.min(6, Math.floor((w + 1) / days.length)));
          return [
            dim(`rounds/day · max ${Math.max(...rounds)}`),
            ...columnChart(rounds, w, chartH, ACCENTS.blue),
            dayAxis(days, w, slot),
            "",
            dim(`spend/day · max ${usd(Math.max(...spend))}`),
            ...columnChart(spend, w, chartH, ACCENTS.yellow),
            dayAxis(days, w, slot),
          ];
        }
        const sparkW = Math.max(8, w - 14);
        return [
          `${fit("rounds", 7)}${ACCENTS.blue}${sparkline(rounds, sparkW)}${RESET} ${Math.max(...rounds)}`,
          `${fit("prs", 7)}${ACCENTS.cyan}${sparkline(prs, sparkW)}${RESET} ${Math.max(...prs)}`,
          `${fit("spend", 7)}${ACCENTS.yellow}${sparkline(spend, sparkW)}${RESET} ${usd(Math.max(...spend))}`,
        ];
      },
    },
    {
      title: "OPERATIONS",
      subtitle: opsSubtitle,
      accent: ACCENTS.magenta,
      body: (w) => opsLines(extra.ops, extra.local, win, w, now),
    },
    {
      title: "TIME TO FIRST VERDICT",
      subtitle: `queue ${fmtDur(win.ttfv.queue_median_s)} · review ${fmtDur(win.ttfv.review_median_s)} · ${distStats(win.ttfv, fmtDur)}`,
      accent: ACCENTS.blue,
      body: (w) => histogramLines(win.ttfv, w, ACCENTS.blue),
    },
    {
      title: "VERDICT MIX",
      subtitle: "rounds by verdict",
      accent: ACCENTS.green,
      body: (w) =>
        barList(
          win.verdict_mix.map((r) => ({ label: r.verdict, value: r.count, text: String(r.count), color: verdictColor(r.verdict) })),
          w,
          ACCENTS.green,
        ),
    },
    {
      // HISTORY, not current state: these buckets come from the
      // `pr_transition` event log, so they can name a state the daemon has
      // since retired. Such a row is MARKED `†`, carries its
      // retirement date in the value column, and is painted MUTED — a
      // deliberate choice, not the accident of a lookup miss. It used to be
      // magenta purely because the park's state owned a colour, and when that
      // colour was renamed to the verdict it belongs to, the row silently
      // degraded to ordinary text and read like any other state.
      title: "TIME IN STATE",
      subtitle: `median dwell per state · ${RETIRED_STATE_MARK} = retired state, history only`,
      accent: ACCENTS.magenta,
      body: (w) =>
        barList(
          win.time_in_state
            .filter((r) => r.total_s > 0 || r.median_s !== null)
            .map((r) => {
              const retired = RETIRED_STATES[r.state];
              return {
                label: historicalStateLabel(r.state),
                value: r.median_s ?? 0,
                text: retired === undefined ? fmtDur(r.median_s) : `${fmtDur(r.median_s)} · ${retired}`,
                color: retired === undefined ? stateColor(r.state) : MUTED,
              };
            }),
          w,
          ACCENTS.magenta,
        ),
    },
    {
      title: "ROUND DURATION",
      subtitle: `overrun ${pct(win.duration.overrun_rate)} · ${distStats(win.duration, fmtDur)}`,
      accent: ACCENTS.yellow,
      body: (w) => histogramLines(win.duration, w, ACCENTS.yellow),
    },
    {
      title: "ROUNDS UNTIL RESOLUTION",
      subtitle: distStats(win.rounds_until_resolution),
      accent: ACCENTS.green,
      body: (w) => histogramLines(win.rounds_until_resolution, w, ACCENTS.green),
    },
    {
      title: "SPEND",
      subtitle: `per-PR median ${usd(win.spend.per_pr_median)} · p90 ${usd(win.spend.per_pr_p90)}`,
      accent: ACCENTS.cyan,
      body: (w) => barsFromRecord(win.spend.by_round_type, w, ACCENTS.cyan, usd),
    },
    {
      title: "SPEND BY LENS",
      subtitle: "usd per lens",
      accent: ACCENTS.blue,
      body: (w) => barsFromRecord(win.spend.by_lens, w, ACCENTS.blue, usd),
    },
    {
      title: "AUTHOR RESPONSE",
      subtitle: distStats(win.author_response, fmtDur),
      accent: ACCENTS.yellow,
      body: (w) => histogramLines(win.author_response, w, ACCENTS.yellow),
    },
    {
      title: "REVIEW DEPTH",
      subtitle: `bot comments per round · ${distStats(win.review_depth)}`,
      accent: ACCENTS.magenta,
      body: (w) => histogramLines(win.review_depth, w, ACCENTS.magenta),
    },
    {
      title: "PR SIZE",
      subtitle: "prs · median ttfv per size bucket",
      accent: ACCENTS.green,
      body: (w) =>
        barList(
          win.size.filter((r) => r.prs > 0).map((r) => ({ label: r.bucket, value: r.prs, text: `${r.prs} · ${fmtDur(r.median_ttfv_s)}` })),
          w,
          ACCENTS.green,
        ),
    },
    {
      title: "CANCELLED ROUNDS",
      subtitle: cancelSubtitle(win),
      accent: ACCENTS.yellow,
      body: (w) => cancellationLines(win, w),
    },
    {
      title: "PING-PONG",
      subtitle: `cap hits ${win.pingpong.cap_hits} · ${distStats(win.pingpong)}`,
      accent: ACCENTS.cyan,
      body: (w) => histogramLines(win.pingpong, w, ACCENTS.cyan),
    },
  ];
}

/** Always a single column — one card under the other (the owner, 2026-08-14). */
export function columnWidths(cols: number): number[] {
  return [cols - 2];
}

/**
 * Balance the cards across columns by their ACTUAL rendered height
 * (longest-first bin packing, then original order restored inside each
 * column) so no column strands a screenful of dead rows.
 */
export function packColumns(cards: MetricsCard[], widths: number[], targetRows = 0): string[][] {
  const n = widths.length;
  const measureW = Math.max(8, Math.min(...widths) - 1);
  const heights = new Array<number>(n).fill(0);
  const assign = new Array<number>(cards.length).fill(0);
  const sized = cards.map((card, i) => ({ i, h: card.body(measureW).length + 1 }));
  // The first card is the headline — it stays top-left; the rest are packed
  // longest-first so every column ends within a card of the others.
  const order = sized.slice(1).sort((a, b) => b.h - a.h || a.i - b.i);
  if (sized.length > 0) heights[0] = sized[0]!.h + 1;
  for (const it of order) {
    let target = 0;
    for (let k = 1; k < n; k++) if (heights[k]! < heights[target]!) target = k;
    assign[it.i] = target;
    heights[target]! += it.h + 1; // + the blank separator row
  }
  const blocks: string[][][] = widths.map(() => []);
  cards.forEach((card, i) => {
    const target = assign[i]!;
    const w = Math.max(8, widths[target]! - 1);
    const block = [truncate(section(card.title, card.subtitle, card.accent), w)];
    // Bodies sit indented under their title — the extra margin keeps
    // neighbouring charts from reading as one figure.
    for (const line of card.body(w - 2)) block.push(`  ${truncate(line, w - 2)}`);
    blocks[target]!.push(block);
  });
  // Two blank rows between cards — proper breathing room between figures.
  return blocks.map((column) => {
    const out: string[] = [];
    column.forEach((block, i) => {
      if (i > 0) out.push("", "");
      out.push(...block);
    });
    return out;
  });
}

// ---- header -----------------------------------------------------------------

export function statStrip(win: MetricsWindow, width: number): string {
  const h = win.header;
  const bits = [
    `${FG.dim}triggered${RESET} ${STRONG}${h.prs_triggered}${DRESET}`,
    `${FG.dim}reviewed${RESET} ${STRONG}${h.prs_reviewed}${DRESET}`,
    `${FG.approve}✓${h.approvals}${RESET} ${FG.request_changes}✗${h.request_changes}${RESET}`,
    `${FG.dim}rounds${RESET} ${STRONG}${h.rounds}${DRESET}`,
    `${FG.accent}$${h.spend_usd.toFixed(2)}${RESET}`,
    `${h.overruns > 0 ? WARN : FG.dim}overruns ${h.overruns}${RESET}`,
    // the loud cancellations only — a round that stopped dead. The
    // benign redeploy orphan sweep is in the card below, never in the strip:
    // a tile that lights up after every deploy is a tile nobody reads.
    // `undefined` means an older daemon does not report the field at all —
    // "?" not "0": a zero here reads as "nothing stopped dead".
    win.cancellations === undefined
      ? `${FG.dim}stopped ?${RESET}`
      : `${win.cancellations.loud > 0 ? WARN : FG.dim}stopped ${win.cancellations.loud}${RESET}`,
  ];
  return truncate(bits.join(SEP), width);
}

/** Window switcher, with the 1-based x-ranges of each button for zoning. */
export function windowSwitcher(
  selected: MetricsWindowKey,
  startX: number,
): { text: string; zones: Array<{ x1: number; x2: number; window: MetricsWindowKey }> } {
  let x = startX;
  const parts: string[] = [];
  const zones: Array<{ x1: number; x2: number; window: MetricsWindowKey }> = [];
  for (const w of WINDOW_LABELS) {
    const plain = `[ ${w.label} ]`;
    zones.push({ x1: x, x2: x + plain.length - 1, window: w.key });
    parts.push(w.key === selected ? `${ACCENT_BG}${plain}${DRESET}` : `${FG.dim}[${RESET} ${w.label} ${FG.dim}]${RESET}`);
    x += plain.length + 1;
  }
  return { text: parts.join(" "), zones };
}

// ---- timeline drill-down ----------------------------------------------------

const KIND_GLYPHS: Array<[RegExp, string, string]> = [
  [/trigger/i, "▸", FG.accent],
  [/round_start|round-start|started/i, "▶", FG.reviewing],
  [/verdict|round_finish|round-finish|finished/i, "■", FG.approve],
  [/push|synchron/i, "↑", FG.awaiting_author],
  [/merge/i, "⇢", FG.approve],
  [/close/i, "✖", FG.closed],
  [/state|transition/i, "→", FG.needs_human],
];

export function kindGlyph(kind: string): string {
  for (const [re, glyph] of KIND_GLYPHS) if (re.test(kind)) return glyph;
  return "·";
}

/** Only the glyph carries color in the timeline — the text stays in ink. */
export function kindColor(kind: string): string {
  for (const [re, , color] of KIND_GLYPHS) if (re.test(kind)) return color;
  return FG.dim;
}

export function timelineLines(tl: TimelinePayload, width: number, now: Date): string[] {
  const lines: string[] = [];
  const title = tl.title ? sanitizeText(tl.title) : "(unknown PR)";
  lines.push(truncate(`${HEADING}#${tl.pr}${DRESET} ${STRONG}${title}${DRESET}${tl.author ? ` ${FG.author}${tl.author}${RESET}` : ""}`, width));
  if (!tl.known) {
    lines.push(`${FG.dim}the daemon has no record of this PR${RESET}`);
    return lines;
  }
  lines.push(truncate(section("TIMELINE", `${tl.items.length} events, oldest first`), width));
  for (const item of tl.items) {
    lines.push(truncate(`${FG.dim}${fit(fmtAge(item.ts, now), 5)}${RESET} ${kindColor(item.kind)}${kindGlyph(item.kind)}${RESET} ${item.label}`, width));
    if (item.detail) lines.push(truncate(`      ${FG.dim}${sanitizeText(item.detail)}${RESET}`, width));
  }
  if (tl.backfilled_rounds.length > 0) {
    lines.push("");
    lines.push(truncate(section("BACKFILLED ROUNDS", "reconstructed from GitHub"), width));
    for (const r of tl.backfilled_rounds) {
      lines.push(truncate(`  r${r.round_no} ${verdictColor(r.verdict)}${r.verdict ?? "—"}${RESET} ${FG.dim}${r.submitted_at}${RESET}`, width));
    }
  }
  return lines;
}

// ---- render -----------------------------------------------------------------

export function renderMetrics(view: MetricsView, cols: number, rows: number): Frame {
  const frame = new Frame(cols, rows);
  const now = view.now ?? new Date();
  const drill = view.drill;
  frame.set(
    0,
    rule(cols, "┌", "┐", [
      `${HEADING}quickreview${DRESET}`,
      modeBadge(view.dryRun),
      drill ? `metrics · #${drill.pr}` : "metrics",
      drill ? `${FG.dim}Esc back to the dashboard · j/k scroll${RESET}` : "",
    ]),
  );

  if (drill) {
    const lines = drill.payload
      ? timelineLines(drill.payload, cols - 4, now)
      : [drill.error ? `${FG.dim}metrics unavailable: ${drill.error}${RESET}` : `${FG.dim}loading timeline for #${drill.pr}…${RESET}`];
    for (let r = 0; r < rows - 4; r++) frame.boxRow(1 + r, [{ text: ` ${lines[view.scroll + r] ?? ""}`, width: cols - 2 }]);
    paintCmdBar(frame, "metrics", cols, rows);
    frame.set(rows - 1, rule(cols, "└", "┘", []));
    return frame;
  }

  // Window switcher (row 1) + its click zones.
  const sw = windowSwitcher(view.window, 3);
  const entry = view.prEntry !== undefined ? `   ${FG.accent}#${view.prEntry}▁${RESET} ${FG.dim}⏎ open timeline · Esc cancel${RESET}` : "";
  const generated = view.payload ? `${FG.dim}generated ${fmtAge(view.payload.generated_at, now)} ago${RESET}` : "";
  frame.boxRow(1, [{ text: ` ${sw.text}${entry}   ${generated}`, width: cols - 2 }]);
  for (const z of sw.zones) {
    frame.zones.push({ x1: z.x1, y1: 2, x2: z.x2, y2: 2, action: { t: "window", window: z.window } satisfies MetricsAction });
  }

  const bodyRows = rows - 6; // top bar + switcher + stat strip + command bar (2 rows) + bottom
  if (!view.payload) {
    const msg = view.error ? `${FG.dim}metrics unavailable: ${view.error}${RESET}` : `${FG.dim}loading metrics…${RESET}`;
    for (let r = 2; r <= rows - 4; r++) frame.boxRow(r, [{ text: r === 2 ? ` ${msg}` : "", width: cols - 2 }]);
    paintCmdBar(frame, "metrics", cols, rows);
    frame.set(rows - 1, rule(cols, "└", "┘", []));
    return frame;
  }

  const win = view.payload.windows[view.window];
  const bf = view.payload.backfill;
  const bfNote = `${FG.dim}backfill ${bf.rounds} rounds / ${bf.prs} PRs${bf.oldest ? ` since ${bf.oldest}` : ""}${RESET}`;
  frame.boxRow(2, [{ text: ` ${statStrip(win, cols - 3)}  ${bfNote}`, width: cols - 2 }]);

  const widths = columnWidths(cols);
  const cards = metricsCards(win, view.payload.daily, bodyRows, {
    ...(view.payload.ops ? { ops: view.payload.ops } : {}),
    ...(view.local ? { local: view.local } : {}),
    now,
  });
  const columns = packColumns(cards, widths, bodyRows);
  for (let r = 0; r < bodyRows; r++) {
    frame.boxRow(
      3 + r,
      widths.map((w, i) => ({ text: ` ${columns[i]?.[view.scroll + r] ?? ""}`, width: w })),
    );
  }
  paintCmdBar(frame, "metrics", cols, rows);
  frame.set(rows - 1, rule(cols, "└", "┘", []));
  return frame;
}

// ---- fetching ---------------------------------------------------------------

export interface MetricsFetchResult<T> {
  payload?: T;
  error?: string;
}

export interface MetricsFetcher {
  overall(): Promise<MetricsFetchResult<MetricsPayload>>;
  timeline(pr: number): Promise<MetricsFetchResult<TimelinePayload>>;
}

/** Both reads are `qcr … --json` in the container — nothing writes. */
export class SshMetricsFetcher implements MetricsFetcher {
  constructor(
    private readonly cfg: TuiConfig,
    private readonly ssh: SshRunner,
  ) {}

  private async read<T>(argv: string[]): Promise<MetricsFetchResult<T>> {
    const res = await this.ssh(this.cfg.ssh_host, argv);
    if (!res.ok) return { error: res.stderr.trim().split("\n")[0] || `qcr exited ${res.code ?? "?"}` };
    try {
      return { payload: JSON.parse(res.stdout) as T };
    } catch {
      return { error: "unparseable JSON from qcr metrics" };
    }
  }

  overall(): Promise<MetricsFetchResult<MetricsPayload>> {
    return this.read<MetricsPayload>(metricsArgv(this.cfg));
  }

  timeline(pr: number): Promise<MetricsFetchResult<TimelinePayload>> {
    return this.read<TimelinePayload>(metricsPrArgv(this.cfg, pr));
  }
}

// ---- hooks ------------------------------------------------------------------

export const METRICS_TTL_MS = 60_000;

/** Digits survive the tab-key mapping: 1/2/4 decode as tab switches, so PR
 * entry has to read them back off the key kind. */
export function keyChar(key: BoardKey): string | undefined {
  switch (key.kind) {
    case "char":
      return key.ch;
    case "attach":
      return "a"; // `a` is the board's full-screen-attach key; here it is the all-time window
    case "tab-board":
      return "1";
    case "tab-digest":
      return "2";
    case "tab-deploy":
      return "3";
    case "tab-metrics":
      return "4";
    default:
      return undefined;
  }
}

export function installMetricsHooks(app: App, fetcher?: MetricsFetcher, probe?: LocalHeadProbe): MetricsView {
  const f = fetcher ?? new SshMetricsFetcher(app.cfg, app.ssh);
  const view: MetricsView = { window: "d7", loading: false, scroll: 0, dryRun: app.view.dryRun };
  let fetchedAt = 0;
  let lastFrame: Frame | undefined;
  const timelineCache = new Map<number, { payload: TimelinePayload; fetched_at: number }>();

  const load = async (force = false): Promise<void> => {
    if (view.loading) return;
    // Gate on fetch time alone: a failed fetch must also wait out the TTL, or
    // error -> repaint -> load would spin forever and the app could never quit.
    if (!force && fetchedAt && Date.now() - fetchedAt < METRICS_TTL_MS) return;
    view.loading = true;
    try {
      const res = await f.overall();
      if (res.payload) {
        view.payload = res.payload;
        view.error = undefined;
        fetchedAt = Date.now();
        // Local git answers "is a deploy needed?" against the sha the VM
        // reports. No probe (or a repo-less machine) simply omits the line.
        if (probe) {
          try {
            view.local = await probe.read(res.payload.ops?.build?.sha ?? null);
          } catch {
            view.local = undefined;
          }
        }
      } else {
        view.error = res.error ?? "unknown error";
        fetchedAt = Date.now();
      }
    } finally {
      view.loading = false;
    }
    app.repaint();
  };

  const drillTo = (pr: number): void => {
    const cached = timelineCache.get(pr);
    view.drill = { pr, payload: cached?.payload, loading: true };
    view.scroll = 0;
    if (cached && Date.now() - cached.fetched_at < METRICS_TTL_MS) {
      view.drill.loading = false;
      app.repaint();
      return;
    }
    void (async () => {
      const res = await f.timeline(pr);
      if (view.drill?.pr !== pr) return;
      if (res.payload) {
        timelineCache.set(pr, { payload: res.payload, fetched_at: Date.now() });
        view.drill = { pr, payload: res.payload, loading: false };
      } else {
        view.drill = { pr, payload: cached?.payload, error: res.error, loading: false };
      }
      app.repaint();
    })();
    app.repaint();
  };

  app.hooks.metricsScreen = (theApp, cols, rows) => {
    view.dryRun = theApp.view.dryRun;
    void load(); // TTL-gated: a repaint inside the window costs nothing
    const frame = renderMetrics(view, cols, rows);
    lastFrame = frame;
    return frame;
  };

  app.hooks.metricsClick = (theApp, x, y) => {
    if (!lastFrame) return false;
    for (let i = lastFrame.zones.length - 1; i >= 0; i--) {
      const z = lastFrame.zones[i]!;
      if (x >= z.x1 && x <= z.x2 && y >= z.y1 && y <= z.y2) {
        const action = z.action as MetricsAction;
        if (action.t === "window") {
          view.window = action.window;
          view.scroll = 0;
          theApp.repaint();
          return true;
        }
      }
    }
    return false;
  };

  app.hooks.metricsKey = (theApp, key: BoardKey): boolean => {
    // PR-entry mode owns every printable key until enter or Esc.
    if (view.prEntry !== undefined) {
      const ch = keyChar(key);
      if (key.kind === "escape") view.prEntry = undefined;
      else if (key.kind === "backspace") view.prEntry = view.prEntry.slice(0, -1);
      else if (key.kind === "enter") {
        const pr = Number(view.prEntry);
        view.prEntry = undefined;
        if (Number.isFinite(pr) && pr > 0) drillTo(pr);
      } else if (ch !== undefined && /^\d$/.test(ch)) view.prEntry += ch;
      else if (key.kind === "quit") return false;
      theApp.repaint();
      return true;
    }
    switch (key.kind) {
      case "escape":
        if (view.drill) {
          view.drill = undefined;
          view.scroll = 0;
          theApp.repaint();
          return true;
        }
        return false;
      case "down":
      case "up":
        view.scroll = key.kind === "down" ? view.scroll + 1 : Math.max(0, view.scroll - 1);
        theApp.repaint();
        return true;
      case "enter": {
        const pr = theApp.currentPr();
        if (pr !== undefined) drillTo(pr);
        return true;
      }
      case "refresh":
        if (view.drill) drillTo(view.drill.pr);
        else void load(true);
        theApp.repaint();
        return true;
      case "attach":
      case "char": {
        const ch = keyChar(key);
        const w = WINDOW_LABELS.find((x) => x.hotkey === ch);
        if (w) {
          view.window = w.key;
          view.scroll = 0;
          theApp.repaint();
          return true;
        }
        if (ch === "#") {
          view.prEntry = "";
          theApp.repaint();
          return true;
        }
        return false;
      }
      default:
        return false; // tabs/quit/help fall through to the app
    }
  };

  return view;
}
