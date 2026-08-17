// The ORIGIN RECORD — the sole authority on what a Slack-driven overseer turn
// is allowed to do (S3, ratified D5).
//
// The overseer reads a Slack message as *text*, and text is attacker-controlled:
// nothing the model repeats back to the daemon can be trusted to carry rights.
// So the router writes the rights DOWN, next to the inject file it just dropped,
// and the command path reads them from disk. The inject body's `tier` line is
// decoration for the model; THIS file is what the gate consults.
//
// Attribution (ratified D5): a command is attributed to the most recent
// UNEXPIRED origin. The window is short by design — an origin is a "a human is
// mid-conversation with you right now" marker, not a session-long grant.
import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { SlackTier } from "../state.js";

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
  /** Slack event id that caused the turn — the forensic join key. */
  event_id: string;
  /** Slack member id of the human who spoke. */
  slack_user: string;
  /** Rights tier, computed from `slack_user` alone — never from message text. */
  tier: SlackTier;
  /** Open PRs authored by this person (empty unless tier is `author`/`owner_legacy`). */
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
  const { event_id, slack_user, tier, authorized_prs, expires_at } = raw;
  if (typeof event_id !== "string" || typeof slack_user !== "string") return null;
  if (tier !== "anyone" && tier !== "author" && tier !== "owner_legacy" && tier !== "ignored") return null;
  if (typeof expires_at !== "string" || Number.isNaN(Date.parse(expires_at))) return null;
  const prs = Array.isArray(authorized_prs)
    ? authorized_prs.filter((n): n is number => typeof n === "number" && Number.isInteger(n) && n > 0)
    : [];
  return { event_id, slack_user, tier, authorized_prs: prs, expires_at };
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
   * (never taken from a caller) so the TTL cannot be widened from outside.
   */
  write(injectBasename: string, rec: Omit<OriginRecord, "expires_at">): OriginRecord {
    const full: OriginRecord = { ...rec, expires_at: new Date(this.now().getTime() + ORIGIN_TTL_MS).toISOString() };
    const path = this.path(injectBasename);
    mkdirSync(this.dir, { recursive: true });
    const tmp = `${path}.tmp-${process.pid}-${this.seq++}`;
    writeFileSync(tmp, `${JSON.stringify(full, null, 2)}\n`);
    renameSync(tmp, path);
    this.prune();
    return full;
  }

  /** Every unexpired record, newest first. */
  all(): OriginRecord[] {
    if (!existsSync(this.dir)) return [];
    const now = this.now().getTime();
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
      if (Date.parse(rec.expires_at) <= now) continue;
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
    return out.map((o) => o.rec);
  }

  /** The most recent unexpired origin, or null when no Slack turn is live. */
  latest(): OriginRecord | null {
    return this.all()[0] ?? null;
  }

  /** Best-effort removal of expired records (opportunistic, never throws). */
  prune(): void {
    if (!existsSync(this.dir)) return;
    const now = this.now().getTime();
    for (const entry of readdirSync(this.dir, { withFileTypes: true })) {
      if (!entry.isFile()) continue;
      const path = join(this.dir, entry.name);
      try {
        if (entry.name.endsWith(".tmp") || /\.tmp-\d+-\d+$/.test(entry.name)) {
          if (now - statSync(path).mtimeMs > ORIGIN_TTL_MS) rmSync(path, { force: true });
          continue;
        }
        if (!entry.name.endsWith(".json")) continue;
        const rec = parseOriginRecord(JSON.parse(readFileSync(path, "utf8")) as unknown);
        if (!rec || Date.parse(rec.expires_at) <= now) rmSync(path, { force: true });
      } catch {
        /* best effort */
      }
    }
  }
}
