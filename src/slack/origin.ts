// The ORIGIN RECORD — the sole authority on what a Slack-driven overseer turn
// is allowed to do (S3, ratified D5).
//
// The overseer reads a Slack message as *text*, and text is attacker-controlled:
// nothing the model repeats back to the daemon can be trusted to carry rights.
// So the router writes the rights DOWN, next to the inject file it just dropped,
// and the command path reads them from disk. The inject body's `tier` line is
// decoration for the model; THIS file is what the gate consults.
//
// Attribution (ratified D5): a command in `commands/slack/` is attributed to
// the most recent UNEXPIRED origin. The window is short by design — an origin
// is a "a human is mid-conversation with you right now" marker, not a
// session-long grant, and no origin means no rights (fail closed).
//
// The legacy `commands/` belt asks a DIFFERENT question — "who caused the turn
// I am serving?" — and answers it from `latestAny()`, ignoring expiry: waiting
// out a TTL must never turn a guest's turn into an owner-tier one. Only a
// daemon wake (`writeLocal`) supersedes a Slack origin there.
import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { foldSlackTier, type SlackTier } from "../state.js";

/**
 * How long an origin authorises commands. 15 minutes: long enough for the
 * overseer to think, run a couple of tool calls and answer; short enough that a
 * later autonomous wake (EOD sweep, anomaly) is never mistaken for the Slack
 * user's turn. Deliberately a module constant — it is a safety parameter, not a
 * knob a config file (or a prompt) may widen.
 */
export const ORIGIN_TTL_MS = 15 * 60 * 1000;

/** What the router recorded about the turn it just injected. */
export interface OriginRecord {
  /**
   * WHO CAUSED THIS TURN, explicitly — never inferred from wall-clock recency.
   *
   * `slack` — a channel message became an overseer turn (the router wrote it).
   * `local` — the DAEMON woke the overseer itself (EOD sweep, anomaly wake,
   *           connections signal). Full autonomy, tier `system`, no user.
   *
   * A record read off disk with no `source` is treated as `slack`: old files
   * predate the field, and the safe reading of "unknown cause" is "a human in
   * the channel", which is the one that restricts.
   */
  source: "slack" | "local";
  /** Slack event id that caused the turn — the forensic join key. */
  event_id: string;
  /** Slack member id of the human who spoke. */
  slack_user: string;
  /** Rights tier, computed from `slack_user` alone — never from message text. */
  tier: SlackTier;
  /** Open PRs authored by this person (empty unless tier is `author`/`owner`). */
  authorized_prs: number[];
  /** ISO instant after which this origin authorises nothing. */
  expires_at: string;
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return v !== null && typeof v === "object" && !Array.isArray(v);
}

/** Parse + shape-check a record read off disk; unknown shapes are ignored. */
export function parseOriginRecord(raw: unknown): OriginRecord | null {
  if (!isRecord(raw)) return null;
  const { source, event_id, slack_user, tier, authorized_prs, expires_at } = raw;
  if (typeof event_id !== "string" || typeof slack_user !== "string") return null;
  // `foldSlackTier` accepts the retired "owner_legacy" spelling (records written
  // before are still on disk) and folds it to "owner" — accepted on
  // input, never emitted; everything unknown still grants nothing.
  const foldedTier = foldSlackTier(tier);
  if (foldedTier === null) return null;
  if (typeof expires_at !== "string" || Number.isNaN(Date.parse(expires_at))) return null;
  const prs = Array.isArray(authorized_prs)
    ? authorized_prs.filter((n): n is number => typeof n === "number" && Number.isInteger(n) && n > 0)
    : [];
  // Anything that is not literally "local" — missing, misspelled, non-string —
  // reads as a Slack-caused turn, i.e. the restricting value.
  return { source: source === "local" ? "local" : "slack", event_id, slack_user, tier: foldedTier, authorized_prs: prs, expires_at };
}

/**
 * `state/slack/origin/<inject-file-basename>.json`, written atomically
 * (tmp+rename, exactly like PiSessionManager.writeAtomic) so a command watcher
 * can never read a half-written grant.
 *
 * The file NAME is the inject file the router dropped, which is what makes the
 * record auditable against the overseer's transcript. Lookup, however, is
 * time-ordered, not name-keyed: `latest()` returns the most recent unexpired
 * record, because the overseer's command file carries no back-reference to the
 * inject that prompted it.
 */
export class OriginStore {
  private seq = 0;

  constructor(
    private readonly dir: string,
    private readonly now: () => Date = () => new Date(),
  ) {}

  /** Absolute path of the record for an inject basename. */
  path(injectBasename: string): string {
    return join(this.dir, `${injectBasename.replace(/\.md$/, "")}.json`);
  }

  /**
   * Record the rights of the turn just injected. `expires_at` is stamped here
   * (never taken from a caller) so the TTL cannot be widened from outside, and
   * `source` is stamped `slack` — this method exists for exactly one caller,
   * the inbound router, and a Slack turn is what it records.
   */
  write(injectBasename: string, rec: Omit<OriginRecord, "expires_at" | "source">): OriginRecord {
    return this.put(injectBasename, { ...rec, source: "slack" });
  }

  /**
   * Stamp a DAEMON-caused turn (EOD sweep, anomaly wake, connections signal).
   *
   * This is the other half of "who caused this turn": without it, a daemon wake
   * during a stale Slack origin would still look like the Slack user's turn, so
   * the legacy-dir belt would refuse the daemon's OWN commands (one guest
   * message every 15 minutes would have blocked the EOD pipeline forever).
   * Tier `system` with no user: the daemon keeps the autonomy it always had —
   * this is the stamped, auditable form of the same authority a missing origin
   * record grants (`authorizeCommand(_, null)` ⇒ ok).
   */
  writeLocal(reason: string): OriginRecord {
    const slug = (reason || "wake").replace(/[^a-zA-Z0-9._-]+/g, "-").slice(0, 48).replace(/^-+|-+$/g, "") || "wake";
    const stamp = this.now().toISOString().replace(/[:.]/g, "-");
    return this.put(`local-${stamp}-${this.seq}-${slug}`, {
      source: "local",
      event_id: `local:${slug}`,
      slack_user: "",
      tier: "system",
      authorized_prs: [],
    });
  }

  private put(basename: string, rec: Omit<OriginRecord, "expires_at">): OriginRecord {
    const full: OriginRecord = { ...rec, expires_at: new Date(this.now().getTime() + ORIGIN_TTL_MS).toISOString() };
    const path = this.path(basename);
    mkdirSync(this.dir, { recursive: true });
    const tmp = `${path}.tmp-${process.pid}-${this.seq++}`;
    writeFileSync(tmp, `${JSON.stringify(full, null, 2)}\n`);
    renameSync(tmp, path);
    this.prune();
    return full;
  }

  /** Move a record to its final name (the router binds it to the inject file
   * only once that file exists). Missing source ⇒ no-op. */
  rename(fromBasename: string, toBasename: string): void {
    const from = this.path(fromBasename);
    const to = this.path(toBasename);
    if (from === to || !existsSync(from)) return;
    try {
      renameSync(from, to);
    } catch {
      /* best effort — the record under the old name still carries the rights */
    }
  }

  /** Drop a record (the inject it was written for never landed). */
  remove(basename: string): void {
    rmSync(this.path(basename), { force: true });
  }

  /** Every unexpired record, newest first. */
  all(): OriginRecord[] {
    const now = this.now().getTime();
    return this.scan()
      .filter((o) => Date.parse(o.rec.expires_at) > now)
      .map((o) => o.rec);
  }

  /** The most recent unexpired origin, or null when no Slack turn is live. */
  latest(): OriginRecord | null {
    return this.all()[0] ?? null;
  }

  /**
   * The most recent origin REGARDLESS OF AGE — "what caused the last overseer
   * turn", not "is a turn live". The legacy-dir belt reads this one: expiry
   * must not be an escalation, so an old Slack origin keeps the belt on until a
   * daemon wake (a `local` record) supersedes it.
   */
  latestAny(): OriginRecord | null {
    return this.scan()[0]?.rec ?? null;
  }

  /** Newest-first scan of every parseable record on disk. */
  private scan(): Array<{ rec: OriginRecord; mtime: number; name: string }> {
    if (!existsSync(this.dir)) return [];
    const out: Array<{ rec: OriginRecord; mtime: number; name: string }> = [];
    for (const entry of readdirSync(this.dir, { withFileTypes: true })) {
      if (!entry.isFile() || !entry.name.endsWith(".json")) continue;
      const path = join(this.dir, entry.name);
      let rec: OriginRecord | null = null;
      try {
        rec = parseOriginRecord(JSON.parse(readFileSync(path, "utf8")) as unknown);
      } catch {
        rec = null; // unreadable/garbage grants authorise nothing
      }
      if (!rec) continue;
      let mtime = 0;
      try {
        mtime = statSync(path).mtimeMs;
      } catch {
        /* raced deletion — fall back to the name ordering */
      }
      out.push({ rec, mtime, name: entry.name });
    }
    // expires_at is the primary clock (TTL is constant, so it orders writes);
    // mtime then the name break ties inside the same millisecond.
    out.sort((a, b) => {
      const e = Date.parse(b.rec.expires_at) - Date.parse(a.rec.expires_at);
      if (e !== 0) return e;
      if (b.mtime !== a.mtime) return b.mtime - a.mtime;
      return b.name.localeCompare(a.name);
    });
    return out;
  }

  /**
   * Best-effort removal of expired records (opportunistic, never throws).
   *
   * The NEWEST record is always kept, expired or not: `latestAny()` is what the
   * legacy-dir belt consults, and deleting the last expired Slack origin would
   * silently release the belt — patience would once again buy rights.
   */
  prune(): void {
    if (!existsSync(this.dir)) return;
    const now = this.now().getTime();
    const keep = this.scan()[0]?.name;
    for (const entry of readdirSync(this.dir, { withFileTypes: true })) {
      if (!entry.isFile()) continue;
      const path = join(this.dir, entry.name);
      try {
        if (entry.name.endsWith(".tmp") || /\.tmp-\d+-\d+$/.test(entry.name)) {
          if (now - statSync(path).mtimeMs > ORIGIN_TTL_MS) rmSync(path, { force: true });
          continue;
        }
        if (!entry.name.endsWith(".json")) continue;
        if (entry.name === keep) continue;
        const rec = parseOriginRecord(JSON.parse(readFileSync(path, "utf8")) as unknown);
        if (!rec || Date.parse(rec.expires_at) <= now) rmSync(path, { force: true });
      } catch {
        /* best effort */
      }
    }
  }
}
