// `[6] metrics` — the aggregate dashboard: a Pulse-style stat strip for the
// selected window, then width-adaptive cards over the MetricsPayload
// `qcr metrics --json` produces, plus a per-PR timeline drill-down from
// `qcr metrics --pr <n> --json`.
//
// Presentation rules: a distribution is a small column chart (block glyphs on
// a dim baseline, then dim rows of counts and bucket labels) with its stats
// inline in the title; bar lists keep one `█` bar per entity with the value
// at its end in normal ink; text is never set inside a filled block; every
// card mark rides the one accent while entity bars keep their semantic
// colors; cards stack in a single column, and a tall terminal grows ACTIVITY
// into a stacked multi-row column chart.
//
// Read-only like every other tab: the only VM touch is the two qcr reads
// through the shared ssh runner, cached stale-while-revalidate.
import type {
  Dist,
  DailyRow,
  MetricsPayload,
  MetricsWindow,
  OpsInfo,
  TimelinePayload,
} from "../metrics.js";
import type { TuiConfig } from "../config.js";
import type { App } from "./app.js";
import { barHeight, paintCmdBar, type BarButton, type LiveKeys } from "./cmdbar.js";
import { HEAD_ARGV, logArgv, type LocalRunner } from "./deploytab.js";
import { keyChar, type BoardKey } from "./keys.js";
// `MUTED` is used (it paints the TIME IN STATE card's retired-state rows),
// though it is easy to mistake for an unused import.
import {
  ACCENT,
  ACCENT_BG,
  BAD,
  HEADING,
  MUTED,
  OK,
  RESET as DRESET,
  SEP,
  STRONG,
  WARN,
  modeBadge,
  sectionTitle,
} from "./design.js";
import { Frame, displayWidth, fit, rule, sanitizeText, truncate } from "./paint.js";
import { RETIRED_STATES, RETIRED_STATE_MARK, historicalStateLabel } from "./model.js";
import { metricsArgv, metricsPrArgv, type SshRunner } from "./remote.js";
import { FG, RESET, fmtAge, stateColor, verdictColor } from "./theme.js";

// ---- chart primitives -------------------------------------------------------

const SPARK = ["▁", "▂", "▃", "▄", "▅", "▆", "▇", "█"] as const;

/** Card accents — every card mark rides the one accent; red/green/state
 * colors remain only where they carry truth (verdicts, states, failures).
 * The hue keys are kept so card definitions stay diff-stable. */
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
    const slice = values.slice(
      Math.floor(i * per),
      Math.max(Math.floor((i + 1) * per), Math.floor(i * per) + 1),
    );
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
  if (max <= 0) return SPARK[0].repeat(buckets.length);
  return buckets
    .map(
      (v) =>
        SPARK[Math.min(SPARK.length - 1, Math.max(0, Math.floor((v / max) * (SPARK.length - 1))))]!,
    )
    .join("");
}

/** Label column width for a bar row — under a third of the card, clamped. */
function labelWidth(width: number): number {
  return Math.min(16, Math.max(6, Math.floor(width * 0.3)));
}

/**
 * `label ███████ value` in exactly `width` cells. The bar scales across the
 * room the label and value leave, and the value sits at its end, outside the
 * bar, in normal ink. A zero value (or `max <= 0`) renders a dim `·`: a zero
 * row is still a row.
 */
export function hbar(
  label: string,
  value: number,
  max: number,
  width: number,
  valueText?: string,
  color?: string,
): string {
  const w = Math.max(8, Math.floor(width));
  const lw = labelWidth(w);
  const vt = valueText ?? String(value);
  const vw = Math.min(displayWidth(vt), Math.max(0, w - lw - 4));
  const avail = w - lw - 3 - vw; // gutters + one cell of right margin
  if (avail < 3) return fit(`${label} ${vt}`, w);
  // The bar scales across the whole row and the value rides at its end —
  // no cap, no track run-out to the far margin.
  const filled =
    max > 0 ? Math.min(avail, Math.max(value > 0 ? 1 : 0, Math.round((value / max) * avail))) : 0;
  const bar = filled > 0 ? `${color ?? ""}${"█".repeat(filled)}${color ? RESET : ""}` : dim("·");
  return `${fit(label, lw)} ${bar} ${truncate(vt, vw)}`;
}

/** `median 5m · p90 16m · n=56` — the distribution's stats, for a card title. */
export function distStats(dist: Dist, fmt: (v: number) => string = String): string {
  if (dist.n === 0) return "no data yet";
  return `median ${fmt(dist.median ?? 0)} · p90 ${fmt(dist.p90 ?? 0)} · n=${dist.n}`;
}

/**
 * A whole distribution as a small column chart: four rows of per-bucket block
 * columns scaled to the max count, in the card's accent, on a dim baseline,
 * then a dim row of per-bucket counts (`·` for an empty bucket) and a dim row
 * of bucket labels. Stats live in the card title — see `distStats`.
 */
export function histogramLines(dist: Dist, width: number, color: string = FG.accent): string[] {
  if (dist.n === 0 || dist.histogram.length === 0) return []; // the title already reads "no data yet"
  const w = Math.max(4, Math.floor(width));
  const buckets = dist.histogram;
  // Slots widen with the terminal (up to 18 cells) and the bars get real
  // height — a small column chart, not a row of nubs.
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
      .map((_b, i) => {
        const rem = levels[i]! - r * 8;
        if (rem >= 8) return `${color}${"█".repeat(cell)}${RESET}`;
        if (rem > 0) return `${color}${SPARK[rem - 1]!.repeat(cell)}${RESET}`;
        return " ".repeat(cell);
      })
      .join("  ");
    rows.push(truncate(row, w));
  }
  rows.push(truncate(dim("▔".repeat(Math.min(chartW, w))), w));
  const counts = buckets
    .map((b) => fit(b.count > 0 ? String(b.count) : "·", slot))
    .join("")
    .trimEnd();
  const axis = buckets
    .map((b) => fit(b.label.replace(/^</, ""), slot))
    .join("")
    .trimEnd();
  rows.push(truncate(dim(counts), w));
  rows.push(truncate(dim(axis), w));
  return rows;
}

/**
 * The column chart's geometry, shared with its day axis so the two can never
 * disagree: `slot` cells per column (bar + one-space gap; widens with the
 * terminal, up to 5 cells of bar, so a wide pane fills instead of showing thin
 * threads) and `n` columns — fewer than `len` when the series is
 * bucket-averaged to fit. A gapless slot-1 column needs no trailing gap.
 */
function columnGeometry(len: number, width: number): { slot: number; n: number } {
  const w = Math.max(1, Math.floor(width));
  const slot = Math.max(1, Math.min(6, Math.floor((w + 1) / len)));
  const n = Math.min(len, Math.max(1, Math.floor((w + (slot > 1 ? 1 : 0)) / slot)));
  return { slot, n };
}

/** The bucket `bucketize(len → n)` averages series index `i` into. */
function bucketOf(i: number, len: number, n: number): number {
  if (len <= n) return i;
  const per = len / n;
  let b = Math.min(n - 1, Math.floor(i / per));
  while (b + 1 < n && Math.floor((b + 1) * per) <= i) b++;
  while (b > 0 && Math.floor(b * per) > i) b--;
  return b;
}

/**
 * Multi-row column chart (tall terminals): block glyphs stacked per column,
 * full `█` rows plus a fractional top glyph, single hue, dim `·` baseline for
 * a zero day. Series longer than the width are bucket-averaged.
 */
export function columnChart(
  values: number[],
  width: number,
  height: number,
  color: string,
): string[] {
  const w = Math.max(1, Math.floor(width));
  const h = Math.max(1, Math.floor(height));
  if (values.length === 0) return [];
  const { slot, n } = columnGeometry(values.length, w);
  const cell = Math.max(1, slot - 1);
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

/**
 * Sparse day axis under a `columnChart` of the same series and width: first,
 * last, and weekly ticks, each at the column its day was bucketed into.
 */
export function dayAxis(days: string[], width: number): string {
  const w = Math.max(0, Math.floor(width));
  const buf = new Array<string>(w).fill(" ");
  const { slot, n } = columnGeometry(Math.max(1, days.length), w);
  const put = (idx: number, text: string): void => {
    const col = bucketOf(idx, days.length, n) * slot;
    const start = Math.min(Math.max(0, col), w - text.length);
    if (start < 0) return;
    for (let i = start - 1; i <= start + text.length; i++)
      if (i >= 0 && i < w && buf[i] !== " ") return;
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

/**
 * The window switcher. Hotkeys are letters — week / month / all — because the
 * digits `1`…`8` open the eight surfaces on every tab: a digit that did
 * something else on exactly one tab would be a hidden mode.
 */
export const WINDOW_LABELS: Array<{ key: MetricsWindowKey; label: string; hotkey: string }> = [
  { key: "d7", label: "7d", hotkey: "w" },
  { key: "d30", label: "30d", hotkey: "m" },
  { key: "all", label: "all", hotkey: "a" },
];

export type MetricsAction = { t: "window"; window: MetricsWindowKey };

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

/** Card title: the one section language; the accent param is unused (one
 * accent) but kept for signature stability. */
function section(title: string, subtitle: string, _accent: string = ACCENT): string {
  return sectionTitle(title, subtitle);
}

export interface MetricsCard {
  title: string;
  /** Stats/meaning, rendered dim on the title row — the card's whole legend. */
  subtitle: string;
  /** Accent for this card's marks (every `ACCENTS` key is the one accent). */
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

function barsFromRecord(
  rec: Record<string, number>,
  width: number,
  accent: string,
  fmt: (v: number) => string,
): string[] {
  const rows = Object.entries(rec)
    .sort((a, b) => b[1] - a[1])
    .map(([k, v]) => ({ label: k, value: v, text: fmt(v) }));
  return barList(rows, width, accent);
}

/** Heartbeats older than this read as a stalled daemon, not a slow tick. */
export const HEARTBEAT_STALE_S = 300;

/**
 * The operations card body: how the daemon is running (mode, heartbeat,
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
    const mode =
      ops.heartbeat === null || ops.dry_run === null ? dim("mode unknown") : modeBadge(ops.dry_run);
    const beatS = ops.heartbeat
      ? Math.max(0, Math.floor((now.getTime() - new Date(ops.heartbeat).getTime()) / 1000))
      : null;
    const beat =
      ops.heartbeat === null
        ? `${FG.anomaly}no heartbeat${RESET}`
        : `${beatS !== null && beatS > HEARTBEAT_STALE_S ? BAD : OK}♥${DRESET} ${fmtAge(ops.heartbeat, now)} ago`;
    const rounds = `${STRONG}${ops.running_rounds}${DRESET}/${ops.max_concurrent_rounds ?? "?"} rounds running`;
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
    for (const k of kinds.slice(0, 8))
      lines.push(hbar(k.kind, k.count, max, width, String(k.count), ACCENTS.magenta));
    if (kinds.length > 8) lines.push(dim(`…+${kinds.length - 8} more kinds`));
    // The all-time window counts rows the archiver moved out
    // of the live table too — say so, so the tally is never read as live.
    if (win.events_archived)
      lines.push(dim(`(incl. ${win.events_archived} archived row(s) — moved to archive/db)`));
  }
  return lines;
}

/**
 * The cancelled rounds card.
 *
 * It makes cancelled rounds visible, grouped by cause because an ungrouped
 * total would mislead: most cancellation is the boot orphan sweep after a
 * redeploy (a container restart orphans every in-flight round by
 * construction), and that bar stays in normal ink no matter how tall it gets.
 * Only a round that stopped dead is marked.
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
      : dim(
          "none stopped dead — every cancellation here is a redeploy artefact or a superseded round",
        ),
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

export function metricsCards(
  win: MetricsWindow,
  daily: DailyRow[],
  rows = 24,
  extra: MetricsCardsExtra = {},
): MetricsCard[] {
  const chartH = activityChartHeight(rows);
  const now = extra.now ?? new Date();
  const opsSubtitle = extra.ops
    ? `${extra.ops.heartbeat === null || extra.ops.dry_run === null ? "mode unknown" : extra.ops.dry_run ? "dry-run" : "live"} · ${extra.ops.build ? extra.ops.build.sha : "build unknown"}`
    : "daemon health · version · event traffic";
  return [
    {
      title: "ACTIVITY",
      subtitle:
        daily.length > 0 ? `${daily[0]!.day} → ${daily[daily.length - 1]!.day}` : "per ops day",
      accent: ACCENTS.cyan,
      body: (w) => {
        if (daily.length === 0) return [dim("no data yet")];
        const rounds = daily.map((d) => d.rounds);
        const prs = daily.map((d) => d.prs);
        const spend = daily.map((d) => d.spend_usd);
        const days = daily.map((d) => d.day);
        if (chartH > 0) {
          return [
            dim(`rounds/day · max ${Math.max(...rounds)}`),
            ...columnChart(rounds, w, chartH, ACCENTS.blue),
            dayAxis(days, w),
            "",
            dim(`spend/day · max ${usd(Math.max(...spend))}`),
            ...columnChart(spend, w, chartH, ACCENTS.yellow),
            dayAxis(days, w),
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
          win.verdict_mix.map((r) => ({
            label: r.verdict,
            value: r.count,
            text: String(r.count),
            color: verdictColor(r.verdict),
          })),
          w,
          ACCENTS.green,
        ),
    },
    {
      // History, not current state: these buckets come from the
      // `pr_transition` event log, so they can name a state the daemon has
      // since retired. Such a row is marked `†`, carries its retirement date
      // in the value column, and is painted MUTED on purpose, so it never
      // reads like a current state.
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
                text:
                  retired === undefined ? fmtDur(r.median_s) : `${fmtDur(r.median_s)} · ${retired}`,
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
          win.size
            .filter((r) => r.prs > 0)
            .map((r) => ({
              label: r.bucket,
              value: r.prs,
              text: `${r.prs} · ${fmtDur(r.median_ttfv_s)}`,
            })),
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

/** Always a single column — one card under the other. */
export function columnWidths(cols: number): number[] {
  return [cols - 2];
}

/**
 * Balance the cards across columns by their actual rendered height
 * (longest-first bin packing, then original order restored inside each
 * column) so no column strands a screenful of dead rows.
 */
export function packColumns(cards: MetricsCard[], widths: number[]): string[][] {
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
    // The loud cancellations only — a round that stopped dead. The benign
    // redeploy orphan sweep is in the card below, never in the strip: a tile
    // that lights up after every deploy is a tile nobody reads.
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
    parts.push(
      w.key === selected
        ? `${ACCENT_BG}${plain}${DRESET}`
        : `${FG.dim}[${RESET} ${w.label} ${FG.dim}]${RESET}`,
    );
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
  lines.push(
    truncate(
      `${HEADING}#${tl.pr}${DRESET} ${STRONG}${title}${DRESET}${tl.author ? ` ${FG.author}${tl.author}${RESET}` : ""}`,
      width,
    ),
  );
  if (!tl.known) {
    lines.push(`${FG.dim}the daemon has no record of this PR${RESET}`);
    return lines;
  }
  lines.push(truncate(section("TIMELINE", `${tl.items.length} events, oldest first`), width));
  for (const item of tl.items) {
    lines.push(
      truncate(
        `${FG.dim}${fit(fmtAge(item.ts, now), 5)}${RESET} ${kindColor(item.kind)}${kindGlyph(item.kind)}${RESET} ${item.label}`,
        width,
      ),
    );
    if (item.detail)
      lines.push(truncate(`      ${FG.dim}${sanitizeText(item.detail)}${RESET}`, width));
  }
  if (tl.backfilled_rounds.length > 0) {
    lines.push("");
    lines.push(truncate(section("BACKFILLED ROUNDS", "reconstructed from GitHub"), width));
    for (const r of tl.backfilled_rounds) {
      lines.push(
        truncate(
          `  r${r.round_no} ${verdictColor(r.verdict)}${r.verdict ?? "—"}${RESET} ${FG.dim}${r.submitted_at}${RESET}`,
          width,
        ),
      );
    }
  }
  return lines;
}

// ---- render -----------------------------------------------------------------

/**
 * What the metrics tab answers to on this frame: the `# <pr>` box owns the
 * digits while it is open (`1`…`8` decode as tab switches, and `keyChar`
 * folds them back — without registering them here `#5265` would lose its 5
 * to the companion column); a drill-down answers to Esc; the dashboard to
 * the window hotkeys and `#`. ⏎ is offered only inside the box: a key that
 * acts must be painted, and the dashboard paints no ⏎.
 */
export function metricsKeys(view: MetricsView): LiveKeys {
  if (view.prEntry !== undefined) {
    return {
      bar: [
        { key: "\r", label: "⏎ open" },
        { key: "\x1b", label: "Esc cancel" },
      ],
      inline: [..."0123456789"],
    };
  }
  if (view.drill) return { bar: [{ key: "\x1b", label: "Esc back" }], inline: [] };
  const bar: BarButton[] = WINDOW_LABELS.map((w) => ({
    key: w.hotkey,
    label: `${w.hotkey} ${w.label}`,
  }));
  bar.push({ key: "#", label: "# pr" });
  return { bar, inline: [] };
}

export function renderMetrics(view: MetricsView, cols: number, rows: number): Frame {
  const frame = new Frame(cols, rows);
  const now = view.now ?? new Date();
  const drill = view.drill;
  const live = metricsKeys(view);
  const barRows = barHeight("metrics", cols, live.bar);
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
    // A cached timeline stays on screen through a failed refresh, and the
    // failure is said above it rather than hidden behind the old data.
    const lines = drill.payload
      ? [
          ...(drill.error ? [`${WARN}refresh failed: ${drill.error}${RESET}`] : []),
          ...timelineLines(drill.payload, cols - 4, now),
        ]
      : [
          drill.error
            ? `${FG.dim}metrics unavailable: ${drill.error}${RESET}`
            : `${FG.dim}loading timeline for #${drill.pr}…${RESET}`,
        ];
    for (let r = 0; r < rows - 2 - barRows; r++)
      frame.boxRow(1 + r, [{ text: ` ${lines[view.scroll + r] ?? ""}`, width: cols - 2 }]);
    paintCmdBar(frame, "metrics", cols, rows, live.bar);
    frame.set(rows - 1, rule(cols, "└", "┘", []));
    return frame;
  }

  // Window switcher (row 1) + its click zones.
  const sw = windowSwitcher(view.window, 3);
  const entry =
    view.prEntry !== undefined
      ? `   ${FG.accent}#${view.prEntry}▁${RESET} ${FG.dim}⏎ open timeline · Esc cancel${RESET}`
      : "";
  // Cached metrics stay on screen through a failed refresh; the failure is
  // said beside their age rather than hidden behind the old data.
  const generated = view.payload
    ? `${FG.dim}generated ${fmtAge(view.payload.generated_at, now)} ago${RESET}` +
      (view.error ? `   ${WARN}refresh failed: ${view.error}${RESET}` : "")
    : "";
  frame.boxRow(1, [{ text: ` ${sw.text}${entry}   ${generated}`, width: cols - 2 }]);
  for (const z of sw.zones) {
    frame.zones.push({
      x1: z.x1,
      y1: 2,
      x2: z.x2,
      y2: 2,
      action: { t: "window", window: z.window } satisfies MetricsAction,
    });
  }

  const bodyRows = rows - 4 - barRows; // top bar + switcher + stat strip + command bar + bottom
  if (!view.payload) {
    const msg = view.error
      ? `${FG.dim}metrics unavailable: ${view.error}${RESET}`
      : `${FG.dim}loading metrics…${RESET}`;
    for (let r = 2; r <= rows - 2 - barRows; r++)
      frame.boxRow(r, [{ text: r === 2 ? ` ${msg}` : "", width: cols - 2 }]);
    paintCmdBar(frame, "metrics", cols, rows, live.bar);
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
  const columns = packColumns(cards, widths);
  for (let r = 0; r < bodyRows; r++) {
    frame.boxRow(
      3 + r,
      widths.map((w, i) => ({ text: ` ${columns[i]?.[view.scroll + r] ?? ""}`, width: w })),
    );
  }
  paintCmdBar(frame, "metrics", cols, rows, live.bar);
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
    if (!res.ok)
      return { error: res.stderr.trim().split("\n")[0] || `qcr exited ${res.code ?? "?"}` };
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

export function installMetricsHooks(
  app: App,
  fetcher?: MetricsFetcher,
  probe?: LocalHeadProbe,
): MetricsView {
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

  const drillTo = (pr: number, force = false): void => {
    const cached = timelineCache.get(pr);
    view.drill = { pr, payload: cached?.payload, loading: true };
    view.scroll = 0;
    if (!force && cached && Date.now() - cached.fetched_at < METRICS_TTL_MS) {
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

  const screen = (theApp: App, cols: number, rows: number): Frame => {
    view.dryRun = theApp.view.dryRun;
    // TTL-gated: a repaint inside the window costs nothing. Started after this
    // frame is written, never inside the paint: a TUI resumed on this tab
    // paints it first, and nothing external may precede the first frame.
    queueMicrotask(() => void load());
    const frame = renderMetrics(view, cols, rows);
    lastFrame = frame;
    return frame;
  };

  const click = (theApp: App, x: number, y: number): boolean => {
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

  const onKey = (theApp: App, key: BoardKey): boolean => {
    // PR-entry mode owns every printable key until enter or Esc.
    if (view.prEntry !== undefined) {
      const ch = keyChar(key);
      if (key.kind === "escape") view.prEntry = undefined;
      else if (key.kind === "backspace") view.prEntry = view.prEntry.slice(0, -1);
      else if (key.kind === "enter") {
        const pr = Number(view.prEntry);
        view.prEntry = undefined;
        if (Number.isFinite(pr) && pr > 0) drillTo(pr);
      } else if (ch !== undefined && /^\d+$/.test(ch)) view.prEntry += ch; // a pasted run arrives whole
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
      case "refresh":
        if (view.drill) drillTo(view.drill.pr, true);
        else void load(true);
        theApp.repaint();
        return true;
      case "attach":
      case "message":
      case "char": {
        // `a` and `m` decode as the board's verbs; `keyChar` folds them back
        // to the letters this tab's switcher reads. A drill-down answers to
        // Esc only; the dashboard's hotkeys are not its, so they reach the
        // companion column from here.
        if (view.drill) return false;
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

  app.hooks.tabs.metrics = { screen, click, key: onKey, keys: () => metricsKeys(view) };
  return view;
}
