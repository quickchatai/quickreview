// Ambient feed writer (build slice C2) — the TUI is the only writer
// of `/feed`, the companion is the only reader.
//
// Two files, both owned by the poll loop (daemon-owned cadence — the
// companion never polls on its own timer):
//   snapshot.json  the current StatusSnapshot, verbatim, rewritten atomically
//                  (tmp + rename) on every successful poll;
//   events.jsonl   append-only tail; only events not already written, keyed by
//                  ts+kind+pr so a re-fetched window never duplicates rows.
//
// The `wake` marker is the wake channel: written ONLY when the feed changed
// meaningfully (a PR changed state/verdict/round count, events arrived, health
// or dry-run flipped) — never on a plain timestamp tick. extensions/
// companion-wake.ts watches exactly that file, so a quiet board wakes nobody.
import { appendFileSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { StatusSnapshot } from "../state.js";

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
  /** True when the change cleared the "worth waking the companion" bar. */
  meaningful: boolean;
  /** One-line human summary of what changed (empty when nothing did). */
  gist: string;
}

/** Health, reduced to the flip-worthy part (poll.ts Health without the ages —
 * a ticking age is not a change). */
export type FeedHealth = "ok" | "stale" | "unreachable";

const SEEN_CAP = 4000;

export function eventKey(e: FeedEvent): string {
  return `${e.ts}|${e.kind}|${e.pr ?? "-"}`;
}

/** Per-PR fingerprint: the fields whose change is worth a wake. */
function prSignature(snap: StatusSnapshot): Map<number, string> {
  const m = new Map<number, string>();
  for (const p of snap.prs) {
    m.set(p.number, `${p.state}|${p.last_verdict ?? "-"}|${p.rounds ?? 0}|${p.paused ? "P" : "-"}|${p.stale_recheck ? "S" : "-"}`);
  }
  return m;
}

/** Human diff of two PR signature maps, newest-interesting first. */
function diffPrs(prev: Map<number, string>, next: Map<number, string>): string[] {
  const bits: string[] = [];
  for (const [pr, sig] of next) {
    const before = prev.get(pr);
    if (before === undefined) {
      bits.push(`#${pr} new (${sig.split("|")[0]})`);
    } else if (before !== sig) {
      const [bs, bv] = before.split("|");
      const [as, av] = sig.split("|");
      if (bs !== as) bits.push(`#${pr} ${bs}→${as}`);
      if (bv !== av && av !== "-") bits.push(`#${pr} verdict ${av}`);
      if (bs === as && bv === av) bits.push(`#${pr} updated`);
    }
  }
  for (const pr of prev.keys()) if (!next.has(pr)) bits.push(`#${pr} gone`);
  return bits;
}

/**
 * Writes the ambient feed. One instance per TUI run; `write()` is called on
 * every successful poll and is cheap when nothing changed.
 */
export class FeedWriter {
  private seen = new Set<string>();
  private prevPrs = new Map<number, string>();
  private prevMeta = "";
  private started = false;

  constructor(
    readonly dir: string,
    private readonly now: () => Date = () => new Date(),
  ) {}

  get snapshotPath(): string {
    return join(this.dir, "snapshot.json");
  }

  get eventsPath(): string {
    return join(this.dir, "events.jsonl");
  }

  get wakePath(): string {
    return join(this.dir, "wake");
  }

  /** Idempotent: creates the dir and seeds the seen-set from an existing tail
   * so a TUI restart never re-appends events the companion already has. */
  start(): void {
    if (this.started) return;
    this.started = true;
    mkdirSync(this.dir, { recursive: true });
    if (!existsSync(this.eventsPath)) return;
    const lines = readFileSync(this.eventsPath, "utf8").split("\n").slice(-SEEN_CAP);
    for (const line of lines) {
      if (line.trim() === "") continue;
      try {
        this.seen.add(eventKey(JSON.parse(line) as FeedEvent));
      } catch {
        /* a torn tail line is not worth failing the feed over */
      }
    }
  }

  write(snapshot: StatusSnapshot, events: FeedEvent[], health: FeedHealth): FeedWriteResult {
    this.start();
    this.writeAtomic(this.snapshotPath, JSON.stringify(snapshot, null, 2));

    // Events: oldest first on disk (the TUI holds them newest-first).
    const fresh = [...events].sort((a, b) => (a.ts < b.ts ? -1 : a.ts > b.ts ? 1 : 0)).filter((e) => !this.seen.has(eventKey(e)));
    if (fresh.length > 0) {
      appendFileSync(this.eventsPath, fresh.map((e) => JSON.stringify(e)).join("\n") + "\n");
      for (const e of fresh) this.remember(eventKey(e));
    }

    const nextPrs = prSignature(snapshot);
    const nextMeta = `${health}|${snapshot.dry_run ? "dry" : "live"}|${snapshot.running_rounds}`;
    const prBits = this.prevPrs.size === 0 && this.prevMeta === "" ? [] : diffPrs(this.prevPrs, nextPrs);
    const metaBits: string[] = [];
    if (this.prevMeta !== "" && this.prevMeta !== nextMeta) {
      const [ph, pd, pr] = this.prevMeta.split("|");
      const [nh, nd, nr] = nextMeta.split("|");
      if (ph !== nh) metaBits.push(`daemon ${ph}→${nh}`);
      if (pd !== nd) metaBits.push(`mode ${pd}→${nd}`);
      if (pr !== nr) metaBits.push(`rounds ${pr}→${nr}`);
    }
    const first = this.prevMeta === "";
    this.prevPrs = nextPrs;
    this.prevMeta = nextMeta;

    const bits = [...(fresh.length > 0 ? [`${fresh.length} new event${fresh.length === 1 ? "" : "s"}`] : []), ...prBits, ...metaBits];
    // The first write of a run is a wake: the companion has just come up and
    // the board is news to it.
    const meaningful = first || bits.length > 0;
    const gist = bits.length > 0 ? bits.slice(0, 4).join("; ") : first ? `board loaded: ${snapshot.prs.length} PRs, daemon ${health}` : "";
    if (meaningful) {
      this.writeAtomic(this.wakePath, JSON.stringify({ ts: this.now().toISOString(), gist }) + "\n");
    }
    return { appended: fresh.length, meaningful, gist };
  }

  private remember(key: string): void {
    this.seen.add(key);
    if (this.seen.size > SEEN_CAP) {
      // Cheap bound: drop the oldest half (insertion order is chronological).
      const keep = [...this.seen].slice(SEEN_CAP / 2);
      this.seen = new Set(keep);
    }
  }

  private writeAtomic(target: string, body: string): void {
    const tmp = `${target}.tmp`;
    writeFileSync(tmp, body);
    renameSync(tmp, target);
  }
}
