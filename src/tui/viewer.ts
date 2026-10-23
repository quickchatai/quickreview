// The board's transcript viewer: what the PR pane shows unless an operator is
// inside the PR's pi. Its source is the LiveEvent log of the PR's rounds
// (packages/pi-plugin/src/live/events.ts) under state/live/pr-<n>/r<round>/ — the main session's
// main.jsonl and one lens-<id>.jsonl per lens session — read over the same
// runner as every other state read (`liveReadArgv`: cat, then tail -c +offset),
// so it looks the same over ssh and locally.
//
// WHICH surface a PR gets is decided by status.json `runtime`, per PR, with no
// toggle (`paneSurface`). A PR whose runtime is `debug` or `takeover` runs inside
// interactive pi, which is a pi TERMINAL under the PR-pane rule (CLAUDE.md): it
// gets the termmirror of its own tmux session and every byte goes to pi, so the
// viewer — which is not a terminal — never paints there. Every other runtime,
// absent and unknown included, gets the viewer: the bot runs no `pr-<n>` tmux
// session to mirror (P9.6), and the viewer only reads.
//
// The viewer is read-only. The pane is bottom-anchored like the mirror: offset 0
// follows the tail, a positive offset parks that many wrapped rows above it and
// stays put while the log grows. `[` `]` step through the round's streams (the
// main session, then each lens), `<` `>` through its rounds.
import type { TuiConfig } from "../config.js";
import type { LiveEvent } from "@quickchatai/pi-quickreview/src/live/events.js";
import { parseLiveLines } from "@quickchatai/pi-quickreview/src/live/events.js";
import { newRenderState, renderLiveEvent, type RenderState } from "../livecli.js";
import { lensForAgent } from "@quickchatai/pi-quickreview/src/round-progress.js";
import type { PiPaneView } from "./pipane.js";
import { charWidth, displayWidth, sanitizeText } from "./paint.js";
import { liveListArgv, liveReadArgv, type PiTerminalSession, type SshRunner } from "./remote.js";
import { SCROLL_STEP } from "./termmirror.js";
import { FG, RESET } from "./theme.js";

// ---- which surface ---------------------------------------------------------------

/**
 * What the PR pane shows for one PR.
 *
 *   viewer    the transcript viewer (`worker`, `answer`, `idle`, and any
 *             runtime this reader does not know, absent included);
 *   terminal  the termmirror of a pi the operator is inside: `debug-pr-<n>`
 *             (a debug round) or `takeover-pr-<n>` (a takeover).
 *
 * There is no third surface: the bot runs no `pr-<n>` tmux session, so nothing
 * mirrors one (P9.6). An unknown runtime reads as the viewer because the viewer
 * only reads — the safe reading is the one that types into nothing.
 */
export type PaneSurface = { kind: "viewer" } | { kind: "terminal"; session: PiTerminalSession };

export function paneSurface(runtime: string | undefined, pr: number): PaneSurface {
  switch (runtime) {
    case "debug":
      return { kind: "terminal", session: `debug-pr-${pr}` };
    case "takeover":
      return { kind: "terminal", session: `takeover-pr-${pr}` };
    default:
      return { kind: "viewer" };
  }
}

/** The tmux session a surface mirrors; undefined for the viewer. */
export function surfaceSession(surface: PaneSurface): PiTerminalSession | undefined {
  return surface.kind === "terminal" ? surface.session : undefined;
}

// ---- the transcript as rows ------------------------------------------------------

/** How a row is painted. Foreign text carries no styling of its own. */
type Tone = "text" | "dim" | "user" | "error";

interface Row {
  t: string;
  tone: Tone;
}

/** Rows kept per log: the tail of a long round, not all of it. */
const MAX_ROWS = 4000;

const paint = (text: string, tone: Tone): string =>
  tone === "text"
    ? text
    : `${tone === "dim" ? FG.dim : tone === "user" ? FG.accent : FG.anomaly}${text}${RESET}`;

/** Break one row into rows of at most `width` cells: at the last space that
 * fits, else mid-word; continuation rows keep the row's indent. */
export function wrapRow(text: string, width: number): string[] {
  const w = Math.max(4, width);
  if (displayWidth(text) <= w) return [text];
  const lead = /^ */.exec(text)?.[0].length ?? 0;
  const pad = " ".repeat(Math.min(lead, Math.floor(w / 2)));
  const out: string[] = [];
  let cur = "";
  let curW = 0;
  let space = -1; // index in `cur` of the last space past the indent
  for (const ch of text) {
    const cw = charWidth(ch.codePointAt(0) ?? 0);
    if (curW + cw > w) {
      if (space > pad.length) {
        out.push(cur.slice(0, space));
        cur = pad + cur.slice(space + 1);
      } else {
        out.push(cur);
        cur = pad;
      }
      curW = displayWidth(cur);
      space = cur.length > pad.length ? cur.lastIndexOf(" ") : -1;
      if (space <= pad.length) space = -1;
    }
    cur += ch;
    curW += cw;
    if (ch === " " && cur.length > pad.length + 1) space = cur.length - 1;
  }
  out.push(cur);
  return out;
}

/** One lens session the main session started, as its tool results name it. */
interface LensRun {
  agent: string;
  id: string;
}

/** One log file's events, read so far and rendered to rows. */
class LogState {
  /** Bytes consumed: the next read asks for what follows. */
  offset = 0;
  private lastSeq = 0;
  private rows: Row[] = [];
  /** The last row is a streamed line still being appended to. */
  private open = false;
  private readonly render: RenderState = newRenderState();
  /** Bumped on every change, so a wrapped copy knows it is out of date. */
  private version = 0;
  private cache: { cols: number; version: number; lines: string[] } | undefined;
  /** An agent turn is running (true), or has settled (false); unknown before any. */
  running: boolean | undefined;
  /** The lens sessions this log started, in order of first appearance (main only). */
  readonly lensRuns: LensRun[] = [];
  /** At least one read of this file has succeeded. */
  loaded = false;
  /** The file did not exist the last time it was asked for. */
  missing = false;
  /** No more will be appended: a round that a later one has replaced. */
  final = false;

  /** Rows the last `ingest` dropped to stay within MAX_ROWS, oldest first. */
  dropped: Row[] = [];

  ingest(events: readonly LiveEvent[]): void {
    this.dropped = [];
    for (const e of events) {
      if (e.seq <= this.lastSeq) continue; // a re-read of what was seen
      this.lastSeq = e.seq;
      this.one(e);
    }
    if (events.length > 0) {
      if (this.rows.length > MAX_ROWS)
        this.dropped = this.rows.splice(0, this.rows.length - MAX_ROWS);
      this.version++;
    }
  }

  private push(text: string, tone: Tone): void {
    this.rows.push({ t: sanitizeText(text), tone });
    this.open = false;
  }

  private one(e: LiveEvent): void {
    if (e.type === "agent_start") this.running = true;
    else if (e.type === "agent_settled") this.running = false;
    else if (e.type === "tool_update" || e.type === "tool_end") {
      for (const r of e.results) {
        if (
          r.id !== undefined &&
          r.agent !== undefined &&
          !this.lensRuns.some((l) => l.id === r.id)
        )
          this.lensRuns.push({ agent: r.agent, id: r.id });
      }
    }
    if (e.type === "message_delta") {
      // Streamed text joins the line it continues; a thinking delta is not shown.
      if (!e.text) return;
      this.render.streamed = true;
      const parts = e.text.split("\n");
      parts.forEach((part, i) => {
        // A delta that ends in a newline leaves no empty row behind it.
        if (i > 0 && i === parts.length - 1 && part === "") return;
        const text = sanitizeText(part);
        if (i === 0 && this.open && this.rows.length > 0)
          this.rows[this.rows.length - 1]!.t += text;
        else this.rows.push({ t: `    ${text}`, tone: "text" });
      });
      this.open = !e.text.endsWith("\n");
      return;
    }
    for (const line of renderLiveEvent(e, this.render)) {
      // An assistant message's text is indented four; its summary line is not.
      if (e.type === "message_end")
        this.push(line, line.startsWith("    ") ? "text" : e.error ? "error" : "dim");
      else if (e.type === "message_start" && e.role === "user") this.push(line, "user");
      else this.push(line, e.type === "tool_end" && e.is_error ? "error" : "dim");
    }
  }

  /** The rows wrapped to `cols` cells and painted. */
  wrapped(cols: number): string[] {
    if (this.cache && this.cache.cols === cols && this.cache.version === this.version)
      return this.cache.lines;
    const lines: string[] = [];
    for (const r of this.rows)
      for (const piece of wrapRow(r.t, cols)) lines.push(paint(piece, r.tone));
    this.cache = { cols, version: this.version, lines };
    return lines;
  }

  get empty(): boolean {
    return this.rows.length === 0;
  }
}

// ---- the viewer ------------------------------------------------------------------

/** What the viewer knows of one PR. */
interface PrView {
  /** Round numbers that have a log directory, oldest first. */
  rounds: number[];
  /** The round the operator stepped back to; undefined follows the newest. */
  pinned: number | undefined;
  /** Log file names in the shown round. */
  files: string[];
  /** The lens log selected; undefined is the main session. */
  lens: string | undefined;
  /** Wrapped rows above the tail the pane is parked (0 follows it). */
  offset: number;
  listedAt: number;
  listed: boolean;
  /** Why the last listing or read failed, when it did. */
  error: string | undefined;
  logs: Map<string, LogState>;
}

/** The listing of a PR's rounds and a round's logs is not worth a round trip
 * per tick; the logs themselves are read every tick. */
const LIST_EVERY_MS = 3_000;
const MAX_LOGS = 8;

const lastLine = (s: string): string => s.trim().split("\n").at(-1) ?? "";

export class TranscriptViewer {
  private readonly prs = new Map<number, PrView>();
  private readonly inFlight = new Set<number>();
  private timer: NodeJS.Timeout | undefined;
  private size: { cols: number; rows: number } | undefined;

  constructor(
    private readonly cfg: TuiConfig,
    private readonly ssh: SshRunner,
    private readonly onUpdate: () => void = () => {},
    private readonly debounceMs = 300,
    private readonly now: () => number = Date.now,
  ) {}

  /** The painted pane rectangle (`piPaneSize`): rows wrap to its width. */
  setViewport(size: { cols: number; rows: number } | undefined): void {
    if (size && size.cols > 0 && size.rows > 0) this.size = size;
  }

  private state(pr: number): PrView {
    let s = this.prs.get(pr);
    if (!s) {
      s = {
        rounds: [],
        pinned: undefined,
        files: [],
        lens: undefined,
        offset: 0,
        listedAt: 0,
        listed: false,
        error: undefined,
        logs: new Map(),
      };
      this.prs.set(pr, s);
    }
    return s;
  }

  private roundOf(s: PrView): number | undefined {
    if (s.pinned !== undefined && s.rounds.includes(s.pinned)) return s.pinned;
    return s.rounds.at(-1);
  }

  /** The lens ids of the shown round: the ones the main log named first (in the
   * order it started them), then any other log the directory holds. */
  private lensIds(s: PrView, main: LogState | undefined): string[] {
    const onDisk = s.files.flatMap((f) => /^lens-(.+)\.jsonl$/.exec(f)?.[1] ?? []).sort();
    const named = (main?.lensRuns ?? []).map((l) => l.id).filter((id) => onDisk.includes(id));
    return [...new Set([...named, ...onDisk])];
  }

  private logKey(round: number, file: string): string {
    return `${round}/${file}`;
  }

  /** The agent a lens id belongs to, when the main log said so. */
  private labelOf(id: string, main: LogState | undefined): string {
    return main?.lensRuns.find((l) => l.id === id)?.agent ?? id;
  }

  /** What the board paints for `pr` right now (never throws, never waits). */
  view(pr: number | undefined): PiPaneView | undefined {
    if (pr === undefined) return undefined;
    const s = this.state(pr);
    const round = this.roundOf(s);
    const main = round !== undefined ? s.logs.get(this.logKey(round, "main.jsonl")) : undefined;
    const lens =
      s.lens !== undefined && this.lensIds(s, main).includes(s.lens) ? s.lens : undefined;
    const shown =
      round !== undefined
        ? s.logs.get(this.logKey(round, lens !== undefined ? `lens-${lens}.jsonl` : "main.jsonl"))
        : undefined;
    const cols = Math.max(8, this.size?.cols ?? 80);
    const lines =
      shown && !shown.empty ? shown.wrapped(cols) : this.placeholder(pr, s, round, lens);
    const streams = ["main", ...this.lensIds(s, main)];
    const streamAt = lens !== undefined ? streams.indexOf(lens) : 0;
    return {
      pr,
      lines,
      missing: false,
      // A failed refresh over rows already cached: the rows are older than the box.
      stale: s.error !== undefined && shown !== undefined && !shown.empty,
      offset: Math.min(s.offset, Math.max(0, lines.length - 1)),
      viewer: {
        round,
        rounds: s.rounds.length,
        roundIndex: round !== undefined ? s.rounds.indexOf(round) + 1 : 0,
        atLatest: s.pinned === undefined || s.pinned === s.rounds.at(-1),
        stream: lens !== undefined ? this.labelOf(lens, main) : "main",
        streamIndex: streamAt + 1,
        streams: streams.length,
        live: shown?.running,
      },
    };
  }

  private placeholder(
    pr: number,
    s: PrView,
    round: number | undefined,
    lens: string | undefined,
  ): string[] {
    if (s.error !== undefined)
      return [`${FG.anomaly}the transcript of #${pr} could not be read: ${s.error}${RESET}`];
    if (!s.listed) return [`${FG.dim}waiting for the first read…${RESET}`];
    if (round === undefined)
      return [`${FG.dim}no transcript for #${pr} yet — it has no round log${RESET}`];
    if (lens !== undefined) return [`${FG.dim}reading the lens transcript…${RESET}`];
    return [`${FG.dim}round ${round} has not logged anything yet${RESET}`];
  }

  // ---- scrollback -----------------------------------------------------------------

  offsetFor(pr: number | undefined): number {
    return pr === undefined ? 0 : (this.prs.get(pr)?.offset ?? 0);
  }

  /** Park the pane `n` rows above the tail; the top of the log is the limit. */
  setOffset(pr: number, n: number): number {
    const s = this.state(pr);
    const total = this.view(pr)?.lines.length ?? 0;
    const room = Math.max(0, total - Math.max(1, this.size?.rows ?? 1));
    s.offset = Math.min(Math.max(0, Math.floor(n)), room);
    return s.offset;
  }

  /** Wheel: `notches × SCROLL_STEP` rows. Positive is back in history. */
  scroll(pr: number, notches: number): number {
    return this.setOffset(pr, this.offsetFor(pr) + notches * SCROLL_STEP);
  }

  /** PgUp / PgDn: a page less one row. */
  page(pr: number, dir: 1 | -1): number {
    const page = Math.max(1, (this.size?.rows ?? 2) - 1);
    return this.setOffset(pr, this.offsetFor(pr) + dir * page);
  }

  // ---- streams and rounds ----------------------------------------------------------

  /** `[` (dir -1) and `]` (dir 1): the previous or next stream of the shown round. */
  stepStream(pr: number, dir: 1 | -1): void {
    const s = this.state(pr);
    const round = this.roundOf(s);
    const main = round !== undefined ? s.logs.get(this.logKey(round, "main.jsonl")) : undefined;
    const streams = [undefined, ...this.lensIds(s, main)];
    const at = Math.max(0, streams.indexOf(s.lens));
    const next = Math.min(Math.max(at + dir, 0), streams.length - 1);
    this.pickStream(s, streams[next]);
  }

  /** The lens a progress row stands for: the `nth` run of `lens` the main log
   * named. False when the main log has not named one yet. */
  selectLens(pr: number, lens: string, nth: number): boolean {
    const s = this.state(pr);
    const round = this.roundOf(s);
    const main = round !== undefined ? s.logs.get(this.logKey(round, "main.jsonl")) : undefined;
    const runs = (main?.lensRuns ?? []).filter((l) => lensForAgent(l.agent) === lens);
    const run = runs[nth] ?? runs.at(-1);
    if (!run) return false;
    this.pickStream(s, run.id);
    return true;
  }

  private pickStream(s: PrView, lens: string | undefined): void {
    s.lens = lens;
    s.offset = 0; // a different stream starts at its tail
  }

  /** `<` (dir -1) and `>` (dir 1): an earlier or later round. The newest round
   * is followed: stepping onto it unpins the choice. */
  stepRound(pr: number, dir: 1 | -1): void {
    const s = this.state(pr);
    const now = this.roundOf(s);
    if (now === undefined) return;
    const next = s.rounds[Math.min(Math.max(s.rounds.indexOf(now) + dir, 0), s.rounds.length - 1)]!;
    if (next === now) return;
    s.pinned = next === s.rounds.at(-1) ? undefined : next;
    s.lens = undefined;
    s.offset = 0;
    s.files = []; // the new round's listing is not this one's
    s.listedAt = 0;
  }

  // ---- reading ----------------------------------------------------------------------

  /** Selection moved (j/k, click, wheel): debounce, then read. */
  select(pr: number | undefined): void {
    if (this.timer) clearTimeout(this.timer);
    this.timer = undefined;
    if (pr === undefined) return;
    const t = setTimeout(() => {
      this.timer = undefined;
      void this.fetch(pr);
    }, this.debounceMs);
    t.unref?.();
    this.timer = t;
  }

  /** Poll tick: read what was appended now, no debounce. */
  async refresh(pr: number | undefined): Promise<void> {
    if (pr === undefined) return;
    await this.fetch(pr);
  }

  async fetch(pr: number): Promise<void> {
    if (this.inFlight.has(pr)) return;
    this.inFlight.add(pr);
    try {
      const s = this.state(pr);
      if (!s.listed || this.now() - s.listedAt >= LIST_EVERY_MS || s.files.length === 0)
        await this.list(pr, s);
      const round = this.roundOf(s);
      if (round !== undefined) {
        // The main log always: it names the lenses and says whether a turn runs.
        await this.read(pr, s, round, "main.jsonl");
        const main = s.logs.get(this.logKey(round, "main.jsonl"));
        if (s.lens !== undefined && this.lensIds(s, main).includes(s.lens))
          await this.read(pr, s, round, `lens-${s.lens}.jsonl`);
      }
    } finally {
      this.inFlight.delete(pr);
    }
    this.onUpdate();
  }

  private async list(pr: number, s: PrView): Promise<void> {
    const key = `pr-${pr}`;
    const res = await this.ssh(this.cfg.ssh_host, liveListArgv(this.cfg, [key]), {
      timeoutMs: 5_000,
    });
    s.listedAt = this.now();
    if (!res.ok) {
      // A PR the worker has not logged for is a missing directory, not a fault.
      if (/no such file/i.test(res.stderr)) {
        s.rounds = [];
        s.files = [];
        s.listed = true;
        s.error = undefined;
      } else s.error = lastLine(res.stderr) || `exit ${res.code ?? "?"}`;
      return;
    }
    s.error = undefined;
    s.listed = true;
    const round0 = this.roundOf(s);
    s.rounds = res.stdout
      .split("\n")
      .flatMap((n) => /^r(\d+)$/.exec(n.trim())?.[1] ?? [])
      .map(Number)
      .sort((a, b) => a - b);
    // A newly followed round starts at its tail, as stepping onto one does.
    if (round0 !== this.roundOf(s)) {
      s.lens = undefined;
      s.offset = 0;
    }
    const round = this.roundOf(s);
    if (round === undefined) {
      s.files = [];
      return;
    }
    const files = await this.ssh(this.cfg.ssh_host, liveListArgv(this.cfg, [key, `r${round}`]), {
      timeoutMs: 5_000,
    });
    if (files.ok)
      s.files = files.stdout
        .split("\n")
        .map((n) => n.trim())
        .filter((n) => n !== "");
  }

  private async read(pr: number, s: PrView, round: number, file: string): Promise<void> {
    const k = this.logKey(round, file);
    let log = s.logs.get(k);
    if (!log) {
      log = new LogState();
      s.logs.set(k, log);
      // Bounded: drop the oldest logs, keeping this one and its round's main log.
      const keep = this.logKey(round, "main.jsonl");
      for (const old of s.logs.keys()) {
        if (s.logs.size <= MAX_LOGS) break;
        if (old !== k && old !== keep) s.logs.delete(old);
      }
    }
    if (log.final) return;
    const res = await this.ssh(
      this.cfg.ssh_host,
      liveReadArgv(this.cfg, [`pr-${pr}`, `r${round}`, file], log.offset),
      { timeoutMs: 5_000 },
    );
    if (!res.ok) {
      // An empty tail is a success; a file that is not there yet is not an error.
      log.missing = /no such file/i.test(res.stderr);
      if (!log.missing) s.error = lastLine(res.stderr) || `exit ${res.code ?? "?"}`;
      return;
    }
    s.error = undefined;
    log.missing = false;
    log.loaded = true;
    const bytes = Buffer.from(res.stdout, "utf8");
    const { events, consumed } = parseLiveLines(bytes);
    // Parked reading stays on the same text: what the log gains goes under it.
    const cols = Math.max(8, this.size?.cols ?? 80);
    const before = s.offset > 0 ? log.wrapped(cols).length : 0;
    log.offset += consumed;
    log.ingest(events);
    // Rows dropped at the cap leave the log's top, so they count as well.
    const gone = log.dropped.reduce((n, r) => n + wrapRow(r.t, cols).length, 0);
    if (s.offset > 0 && this.isShown(s, round, file))
      s.offset += log.wrapped(cols).length - before + gone;
    log.final = s.rounds.length > 0 && round < s.rounds[s.rounds.length - 1]!;
  }

  private isShown(s: PrView, round: number, file: string): boolean {
    return (
      this.roundOf(s) === round &&
      file === (s.lens !== undefined ? `lens-${s.lens}.jsonl` : "main.jsonl")
    );
  }

  /** Drop a PR's transcript (session archived / round finished). */
  invalidate(pr: number): void {
    this.prs.delete(pr);
  }

  stop(): void {
    if (this.timer) clearTimeout(this.timer);
    this.timer = undefined;
  }
}
