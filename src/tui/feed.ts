// Ambient feed writer (build slice C2) — the TUI is the only writer
// of `/feed`, the companion reads it on demand.
//
// Four local short-term files, all owned by the TUI:
//   snapshot.json  the current StatusSnapshot, verbatim, rewritten atomically
//                  (tmp + rename) on every successful poll;
//   events.jsonl   a bounded, append-only-in-normal-operation event tail; only
//                  events not already written, keyed by ts+kind+pr.
//   screen.txt     the LAST PAINTED FRAME as plain text — exactly
//                  what is on the owner's screen, ANSI stripped, never escapes;
//   view.json      a small projection of the derived state behind
//                  that frame, deploy state first.
//
// discipline, and it is the whole point of the split: these are FILES.
// Writing them costs bytes on disk and nothing in the companion's context; the
// companion pays only when it fires a `tui_*` tool (extensions/tui-view.ts) to
// read one. That is why the projection is deliberately small and why the
// snapshot was NOT widened — `prompts/companion.md` tells the companion to read
// snapshot.json before answering anything about "now", so every field added
// there is paid on every turn.
//
// IMPORTANT (the owner, 2026-08-21): feed changes NEVER inject a companion chat
// turn. The old `/feed/wake` → pi.sendUserMessage path interrupted active
// conversations with synthetic "feed updated" messages. The files are ambient
// short-term state only; a real operator message or alert is a separate path.
import {
  appendFileSync,
  closeSync,
  existsSync,
  mkdirSync,
  openSync,
  readFileSync,
  readSync,
  rmSync,
  renameSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { randomBytes } from "node:crypto";
import { join } from "node:path";
import type { StatusSnapshot } from "../state.js";
import { configDrift, configDriftText, type ConfigRead } from "./confighome.js";

/** A daemon event row as `qcr events --json` emits it. */
export interface FeedEvent {
  ts: string;
  kind: string;
  pr: number | null;
  payload: string | null;
}

export interface FeedWriteResult {
  /** Events appended to events.jsonl by this call. */
  appended: number;
}

/** Health remains part of the feed writer call contract even though the
 * snapshot is now the only place it is observed. */
export type FeedHealth = "ok" | "pipeline_unhealthy" | "stale" | "unreachable";

/** Bound both dedupe memory and the disk journal. On overflow the oldest half
 * is discarded in one atomic compaction, avoiding a rewrite on every poll. */
export const EVENT_TAIL_CAP = 4000;
const EVENT_TAIL_KEEP = EVENT_TAIL_CAP / 2;

export function eventKey(e: FeedEvent): string {
  return `${e.ts}|${e.kind}|${e.pr ?? "-"}`;
}

// ---- the operator's view -----------------------------------------

/** Hard caps. The frame is a picture in prose: a 200×50 screen is ~10 KB, so
 * the cap only ever bites on an absurd terminal, and biting is better than
 * handing the companion an unbounded read. */
export const SCREEN_MAX_CHARS = 20_000;
/** Two repaints in the same tick must not mean two fsyncs — repaints follow
 * keystrokes. The 3 s poll writes unconditionally, so freshness never depends
 * on this throttle letting a write through. */
export const VIEW_MIN_INTERVAL_MS = 500;

/** Deploy state as the deploy tab already fetched it — the trigger and
 * the reason `view.json` leads with it. Structural on purpose: `feed.ts` does
 * not import the deploy tab, and the deploy tab does not know it is published. */
export interface ViewDeploy {
  loaded: boolean;
  loading?: boolean;
  /** The VM's BUILD_SHA marker — the commit it is actually running. `"absent"`
   * is a VM this system has never deployed to (the first deploy writes the
   * marker); `"unparseable"` is a marker the TUI read but could not parse (a
   * corrupt file, not a failed read); `null` is a read that failed and says
   * NOTHING about what the VM runs. Never a dropped key: the
   * companion's renderer shows an absent key as nothing at all, and "nothing"
   * read as "nothing to report". */
  deployed: { sha: string; at?: string; mode?: string } | "absent" | "unparseable" | null;
  /** Local HEAD in the sandbox checkout; `null` when git could not be read. */
  head: string | null;
  /** `null` when the working tree could not be read — never 0. */
  dirty_files: number | null;
  /** `git log --oneline deployed..HEAD`, bounded. Empty when the diff could
   * not be computed — read `pending_commit_count` for which it is. */
  pending_commits: string[];
  /** `null` when the deployed sha is unknown or local git could not diff it,
   * so "nothing to ship" is never published from an unread repo. */
  pending_commit_count: number | null;
  /** Last line of `git diff --stat` — the "N files changed" summary. */
  diffstat_summary?: string;
  /** `docker ps` Status line ("Up 2 hours" / "Exited (0) …"); `""` when docker
   * lists no such container; `null` when the read failed. */
  container_status: string | null;
  /**: the deploy tab's config-home sentence ("profile changed, not
   * deployed", …) — `null` when either end could not be read, so an
   * uncompared home is never published as matching or as changed. */
  config_home: string | null;
  run?: { kind: string; running: boolean; code?: number | null };
}

/** The projection the `tui_*` tools read. Small by contract. */
export interface TuiView {
  /** When the TUI wrote this file. Every tool answer is stamped with it, and a
   * stale one says so rather than presenting old state as current. */
  written_at: string;
  deploy: ViewDeploy;
  screen: { tab: string; rows: number; chars: number; truncated: boolean };
  board: {
    snapshot_written_at?: string;
    /** `null` until a heartbeat proves a mode. NEVER a default — this is the
     * companion-facing twin of the badge whose `true` default told a live
     * installation it was in dry-run (the incident this ticket is
     * named for). The companion states this in WORDS to the owner. */
    dry_run: boolean | null;
    health: string;
    health_stale_s?: number;
    /** `null` when no snapshot has arrived — the feed's `PRS (?)`. */
    total: number | null;
    by_state: Record<string, number> | null;
    running_rounds?: number;
    max_concurrent_rounds?: number;
    today_spend_usd?: number;
    total_spend_usd?: number;
    pipeline_healthy?: boolean;
    pipeline_causes?: Array<{ key: string; pr: number | null }>;
    pipeline_recoveries?: Array<{ key: string; pr: number }>;
  };
  /** The row the owner is pointing at — the shared referent for "this one". */
  selected?: {
    number: number;
    title?: string;
    state?: string;
    head_sha?: string;
    rounds?: number;
    last_verdict?: string | null;
    author?: string | null;
    stale_recheck?: boolean;
  };
  /** Which pi session the board's pane is mirroring, and whether it has focus. */
  pane?: { pr?: number; focused: boolean };
  notice?: string;
}

const PENDING_COMMITS_MAX = 40;

/** Whichever age the health variant carries, in whole seconds. `Infinity`
 * (never reached the daemon) is reported as absent rather than as a number. */
function healthAgeS(h: ViewSource["health"]): number | undefined {
  const raw = h?.heartbeatAgeS ?? h?.dataAgeS ?? h?.sinceS;
  return raw !== undefined && Number.isFinite(raw) ? Math.round(raw) : undefined;
}

/** Everything `buildTuiView` needs, named structurally so tests (and the
 * caller) never have to construct an `App`. */
export interface ViewSource {
  now: Date;
  tab: string;
  snapshot?: StatusSnapshot;
  /** Structural echo of `poll.ts` `Health` — kind plus whichever age that
   * variant carries. */
  health?: { kind: string; heartbeatAgeS?: number; dataAgeS?: number; sinceS?: number };
  selectedPr?: number;
  panePr?: number;
  paneFocused?: boolean;
  notice?: string;
  screen?: string;
  deploy?: {
    loaded: boolean;
    loading?: boolean;
    /** Structural echo of `DeployState.deployed`: the marker, `"absent"` for a
     * VM with none, `"unparseable"` for a marker that is not a marker line,
     * `undefined` for a read that failed. */
    deployed?: { sha: string; at?: string; mode?: string } | "absent" | "unparseable";
    head?: string;
    /** undefined = git status could not be read, not "clean". */
    dirty: string[] | undefined;
    commits?: string[];
    diffstat?: string[];
    containerStatus?: string;
    /** Structural echo of `DeployState.configLocal` / `configDeployed`. */
    configLocal?: ConfigRead;
    configDeployed?: ConfigRead;
    run?: { kind: string; running: boolean; code?: number | null };
  };
}

/** Clamp + de-escape the frame. The producer strips, so the companion never
 * has to trust the file: `screen.txt` is plain text by construction. */
export function clampScreen(text: string): { body: string; truncated: boolean } {
  // Anything that could re-enter the terminal is removed here, not downstream:
  // OSC strings first, then CSI sequences, then any surviving C0 control (tab
  // and newline are kept — they are layout, not control).
  const plain = text
    .replace(/\u001b\][\s\S]*?(?:\u0007|\u001b\\)/g, "")
    .replace(/\u001b\[[0-9;?]*[ -/]*[@-~]/g, "")
    .replace(/\u001b[@-Z\\-_]/g, "")
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, "");
  if (plain.length <= SCREEN_MAX_CHARS) return { body: plain, truncated: false };
  return {
    body: `${plain.slice(0, SCREEN_MAX_CHARS)}\n… screen truncated at ${SCREEN_MAX_CHARS} chars`,
    truncated: true,
  };
}

/** The config-home sentence, or `null` when it would be built from no data. */
function configHomeFact(local?: ConfigRead, deployed?: ConfigRead): string | null {
  const drift = configDrift(local, deployed);
  return drift.kind === "unknown" ? null : configDriftText(drift);
}

export function buildTuiView(src: ViewSource): TuiView {
  const d = src.deploy;
  const commits = d?.commits;
  const diffstat = d?.diffstat ?? [];
  // A view PUBLISHED from no data is the same lie as a value RENDERED from no
  // data, and it is worse here: the companion reads this file and repeats it to
  // the owner in prose. Every field below that a snapshot would have filled is
  // `null` when there is no snapshot — never a confident zero.
  const prs = src.snapshot?.prs;
  const by_state: Record<string, number> | null = prs === undefined ? null : {};
  for (const pr of prs ?? []) by_state![pr.state] = (by_state![pr.state] ?? 0) + 1;
  const sel =
    src.selectedPr === undefined ? undefined : (prs ?? []).find((p) => p.number === src.selectedPr);
  const screen = clampScreen(src.screen ?? "");
  return {
    written_at: src.now.toISOString(),
    deploy: {
      loaded: d?.loaded ?? false,
      ...(d?.loading === true ? { loading: true } : {}),
      deployed: d?.deployed ?? null,
      head: d?.head ?? null,
      dirty_files: d?.dirty?.length ?? null,
      pending_commits: (commits ?? []).slice(0, PENDING_COMMITS_MAX),
      pending_commit_count: commits?.length ?? null,
      ...(diffstat.length > 0 ? { diffstat_summary: diffstat[diffstat.length - 1] } : {}),
      container_status: d?.containerStatus ?? null,
      config_home: configHomeFact(d?.configLocal, d?.configDeployed),
      ...(d?.run
        ? { run: { kind: d.run.kind, running: d.run.running, code: d.run.code ?? null } }
        : {}),
    },
    screen: {
      tab: src.tab,
      rows: src.screen === undefined || src.screen === "" ? 0 : screen.body.split("\n").length,
      chars: screen.body.length,
      truncated: screen.truncated,
    },
    board: {
      snapshot_written_at: src.snapshot?.written_at,
      dry_run: src.snapshot?.dry_run ?? null,
      health: src.health?.kind ?? "unknown",
      ...(healthAgeS(src.health) !== undefined ? { health_stale_s: healthAgeS(src.health) } : {}),
      total: prs === undefined ? null : prs.filter((p) => p.state !== "closed").length,
      by_state,
      running_rounds: src.snapshot?.running_rounds,
      max_concurrent_rounds: src.snapshot?.max_concurrent_rounds,
      today_spend_usd: src.snapshot?.today_spend_usd,
      total_spend_usd: src.snapshot?.total_spend_usd,
      ...(src.snapshot?.pipeline
        ? {
            pipeline_healthy: src.snapshot.pipeline.healthy,
            pipeline_causes: src.snapshot.pipeline.causes.map((cause) => ({
              key: cause.key,
              pr: cause.pr,
            })),
            pipeline_recoveries: (src.snapshot.pipeline.recoveries ?? []).map((recovery) => ({
              key: recovery.key,
              pr: recovery.pr,
            })),
          }
        : {}),
    },
    ...(sel
      ? {
          selected: {
            number: sel.number,
            title: sel.title,
            state: sel.state,
            head_sha: sel.head_sha,
            rounds: sel.rounds,
            last_verdict: sel.last_verdict ?? null,
            author: sel.author ?? null,
            stale_recheck: Boolean(sel.stale_recheck),
          },
        }
      : src.selectedPr !== undefined
        ? { selected: { number: src.selectedPr } }
        : {}),
    ...(src.panePr !== undefined || src.paneFocused === true
      ? { pane: { pr: src.panePr, focused: src.paneFocused === true } }
      : {}),
    ...(src.notice ? { notice: src.notice.slice(0, 400) } : {}),
  };
}

/**
 * Writes the ambient short-term feed. One instance per TUI run; `write()` is
 * called on every successful poll and is cheap when nothing changed.
 */
export class FeedWriter {
  private seen = new Set<string>();
  private eventLines = 0;
  private started = false;
  /** The journal as this writer last saw it (inode + byte length), so rows a
   * second concurrent TUI appended — or a compaction it ran — are folded into
   * `seen` before we append, instead of being re-journaled. */
  private journalIno = -1;
  private journalBytes = 0;

  constructor(readonly dir: string) {}

  get snapshotPath(): string {
    return join(this.dir, "snapshot.json");
  }

  get eventsPath(): string {
    return join(this.dir, "events.jsonl");
  }

  /**: the last painted frame, plain text. */
  get screenPath(): string {
    return join(this.dir, "screen.txt");
  }

  /**: the derived state behind that frame, deploy state first. */
  get viewPath(): string {
    return join(this.dir, "view.json");
  }

  private lastViewMs = Number.NEGATIVE_INFINITY;

  /**
   * publish the operator's view. Called from the poll AND from every
   * repaint (a repaint follows a keystroke, and "what is on their screen" is only
   * true if it tracks keystrokes), throttled to `VIEW_MIN_INTERVAL_MS`.
   *
   * Returns false when the throttle skipped this call — never an error: a
   * missed publish costs freshness measured in milliseconds and nothing else.
   */
  writeView(view: TuiView, screen: string | undefined, nowMs: number = Date.now()): boolean {
    if (nowMs - this.lastViewMs < VIEW_MIN_INTERVAL_MS) return false;
    this.lastViewMs = nowMs;
    this.start();
    this.writeAtomic(this.viewPath, JSON.stringify(view, null, 2));
    // A tab that renders as a bare string has no composed frame; leave the last
    // one on disk rather than blanking it — the tool stamps freshness anyway.
    if (screen !== undefined) this.writeAtomic(this.screenPath, clampScreen(screen).body);
    return true;
  }

  /** Idempotent: creates the dir, removes the retired wake marker, seeds the
   * seen-set from the retained tail, and bounds an old unbounded journal. */
  start(): void {
    if (this.started) return;
    this.started = true;
    mkdirSync(this.dir, { recursive: true });
    // A currently-running copy of the retired extension treats removal as a
    // no-op (the file no longer exists), while no future companion loads it.
    rmSync(join(this.dir, "wake"), { force: true });
    if (!existsSync(this.eventsPath)) return;

    let lines = readFileSync(this.eventsPath, "utf8")
      .split("\n")
      .filter((line) => line.trim() !== "");
    if (lines.length > EVENT_TAIL_CAP) {
      lines = lines.slice(-EVENT_TAIL_KEEP);
      this.writeAtomic(this.eventsPath, lines.join("\n") + "\n");
    }
    // Seed through the same whole-lines reader every later write uses, so a
    // row another TUI is mid-appending right now is not lost to a failed parse.
    this.journalIno = -1;
    this.syncJournal();
  }

  private seedSeen(lines: string[]): void {
    for (const line of lines) {
      try {
        this.seen.add(eventKey(JSON.parse(line) as FeedEvent));
      } catch {
        /* a torn tail line is not worth failing the feed over */
      }
    }
  }

  /** Record the journal's identity + length as this writer leaves it. */
  private noteJournal(): void {
    try {
      const st = statSync(this.eventsPath);
      this.journalIno = st.ino;
      this.journalBytes = st.size;
    } catch {
      this.journalIno = -1;
      this.journalBytes = 0;
    }
  }

  /**
   * Two TUIs may share one feed dir (companion.ts). Before appending, fold in
   * whatever the other one wrote since we last looked: new bytes on the same
   * inode are its appends; a new inode or a shorter file is its compaction (or
   * a restart's trim), which re-seeds from the whole retained tail.
   */
  private syncJournal(): void {
    let ino: number;
    let size: number;
    try {
      const st = statSync(this.eventsPath);
      ino = st.ino;
      size = st.size;
    } catch {
      return; // no journal yet: nothing anyone else wrote
    }
    if (ino === this.journalIno && size === this.journalBytes) return;
    const reseed = ino !== this.journalIno || size < this.journalBytes;
    const from = reseed ? 0 : this.journalBytes;
    const buf = Buffer.alloc(size - from);
    const fd = openSync(this.eventsPath, "r");
    try {
      readSync(fd, buf, 0, buf.length, from);
    } finally {
      closeSync(fd);
    }
    // Consume only whole lines: a row caught mid-append by the other writer
    // is left for the next sync, so its key is not lost to a failed parse.
    const end = buf.lastIndexOf(0x0a) + 1;
    const lines = buf
      .subarray(0, end)
      .toString("utf8")
      .split("\n")
      .filter((line) => line.trim() !== "");
    if (reseed) {
      this.eventLines = lines.length;
      this.seen.clear();
    } else {
      this.eventLines += lines.length;
    }
    this.seedSeen(lines);
    size = from + end;
    this.journalIno = ino;
    this.journalBytes = size;
  }

  write(snapshot: StatusSnapshot, events: FeedEvent[], _health: FeedHealth): FeedWriteResult {
    this.start();
    this.writeAtomic(this.snapshotPath, JSON.stringify(snapshot, null, 2));

    // Events: oldest first on disk (the TUI holds them newest-first).
    this.syncJournal();
    const fresh = [...events]
      .sort((a, b) => (a.ts < b.ts ? -1 : a.ts > b.ts ? 1 : 0))
      .filter((e) => !this.seen.has(eventKey(e)));
    if (fresh.length > 0) {
      appendFileSync(this.eventsPath, fresh.map((e) => JSON.stringify(e)).join("\n") + "\n");
      // Read our own rows back through the journal cursor rather than jumping
      // it to EOF: a row the other TUI appended between the sync above and our
      // append sits before ours and must be folded in, not skipped.
      this.syncJournal();
      if (this.eventLines > EVENT_TAIL_CAP) this.compactEvents();
    }
    return { appended: fresh.length };
  }

  private compactEvents(): void {
    const lines = readFileSync(this.eventsPath, "utf8")
      .split("\n")
      .filter((line) => line.trim() !== "")
      .slice(-EVENT_TAIL_KEEP);
    this.writeAtomic(this.eventsPath, lines.join("\n") + (lines.length > 0 ? "\n" : ""));
    this.eventLines = lines.length;
    this.seen.clear();
    this.seedSeen(lines);
    this.noteJournal();
  }

  /** Stage-then-rename. The staging name is unique per process AND per
   *  write, created exclusively (`wx`): two TUIs open at once publish into one
   *  feed dir, and a shared `<target>.tmp` let one truncate and rename the
   *  other's inode — a half-written file for the companion and an ENOENT for
   *  the loser. A failed write removes its own staging file, never another's. */
  private writeAtomic(target: string, body: string): void {
    const tmp = `${target}.${process.pid}.${randomBytes(4).toString("hex")}.tmp`;
    try {
      writeFileSync(tmp, body, { flag: "wx" });
      renameSync(tmp, target);
    } catch (e) {
      rmSync(tmp, { force: true });
      throw e;
    }
  }
}
