// The companion inbox — where the bot leaves what the overseer used to be woken
// for. The overseer is retired (the owner never used it); everything that
// woke it is now an ITEM in a directory the companion's TUI pulls from:
// anomalies, the daily heartbeat, authwatch's and the login refresher's alerts,
// and the 18:00 EOD sweep.
//
//   <root>/inject/companion-inbox/<id>.json   { id, class, text, created_at }
//
// Three properties are structural:
//
//   * DURABLE. One file per item, written tmp + rename, so a reader never sees
//     half an item and a restart loses nothing. An item stays until the TUI
//     acks it (`ack`, which is a delete) — the EOD sweep therefore runs LATE
//     when the companion is off, never not at all.
//   * DEDUPED. The id is the identity: the same id written again while the
//     item is still pending is a no-op. Producers with a natural key pass it
//     (`eod-<date>`, `heartbeat-<date>`); the rest get a hash of class + text,
//     so an identical alert repeating while nobody has read it stays one item.
//   * BOUNDED. At most `INBOX_MAX_ITEMS` pending; past that the oldest
//     routine item goes first (anomaly, heartbeat), a login alert or an EOD
//     sweep only when nothing routine is left, and every eviction is logged.
//     One item's text is capped at `INBOX_MAX_TEXT_CHARS`.
//
// This module only writes files. It never schedules an agent and never
// touches GitHub (rule 9: the daemon nudges, it does not run one).
import { createHash } from "node:crypto";
import { mkdirSync, readdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";

/** What an item is, so the companion's prompt can handle each kind. */
export type InboxClass = "anomaly" | "heartbeat" | "login" | "eod";

export const INBOX_CLASSES: readonly InboxClass[] = ["anomaly", "heartbeat", "login", "eod"];

export interface InboxItem {
  id: string;
  class: InboxClass;
  text: string;
  /** ISO-8601, the instant the item was first written. */
  created_at: string;
}

/** The producers' view: write one item. Resolves once it is on disk. */
export type InboxWriter = (message: string, cls: InboxClass) => Promise<void>;

/** Pending items kept at most; the daemon's own volume of alerts is far below. */
export const INBOX_MAX_ITEMS = 200;

/** One item's text, in characters. An EOD sweep (the seed plus the day's
 * context and the outcomes packet) is tens of KB; this is a ceiling, not a target. */
export const INBOX_MAX_TEXT_CHARS = 400_000;

/** Classes that are evicted only when nothing routine is left to drop. */
const KEEP_CLASSES: ReadonlySet<InboxClass> = new Set(["login", "eod"]);

/** An item id is a file name on the bot and in the TUI's shell scripts: this
 * shape is all either side ever builds a path or a command from. */
export const INBOX_ID_RE = /^[a-z0-9][a-z0-9._-]{0,95}$/;
const ID_RE = INBOX_ID_RE;

/** The inbox directory under a root — the TUI's runner reads the same path. */
export function companionInboxDir(root: string): string {
  return join(root, "inject", "companion-inbox");
}

/** The anomaly kinds that mean "the bot's model login is failing or about to":
 * the owner has to run /login, so they carry their own class. */
const LOGIN_KINDS: ReadonlySet<string> = new Set(["pi_auth_expired", "login_refresh_failed"]);

/** The inbox class an anomaly of this kind is filed under. */
export function inboxClassForAnomaly(kind: string): InboxClass {
  return LOGIN_KINDS.has(kind) ? "login" : "anomaly";
}

function defaultId(cls: InboxClass, text: string): string {
  return `${cls}-${createHash("sha256").update(`${cls}\n${text}`).digest("hex").slice(0, 16)}`;
}

export function isItem(value: unknown): value is InboxItem {
  if (typeof value !== "object" || value === null) return false;
  const v = value as Record<string, unknown>;
  return (
    typeof v.id === "string" &&
    ID_RE.test(v.id) &&
    typeof v.text === "string" &&
    typeof v.created_at === "string" &&
    INBOX_CLASSES.includes(v.class as InboxClass)
  );
}

/** One item out of its file text (what the TUI's pull reads off the bot), or
 * null when it is not an item. The same check the bot's own reader applies. */
export function parseInboxItem(text: string): InboxItem | null {
  try {
    const parsed: unknown = JSON.parse(text);
    return isItem(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

export interface CompanionInboxOptions {
  root: string;
  now?: () => Date;
  maxItems?: number;
  maxTextChars?: number;
  log?: (msg: string, extra?: unknown) => void;
}

export class CompanionInbox {
  readonly dir: string;
  private readonly now: () => Date;
  private readonly maxItems: number;
  private readonly maxTextChars: number;
  private readonly log: (msg: string, extra?: unknown) => void;

  constructor(opts: CompanionInboxOptions) {
    this.dir = companionInboxDir(opts.root);
    this.now = opts.now ?? (() => new Date());
    this.maxItems = Math.max(1, opts.maxItems ?? INBOX_MAX_ITEMS);
    this.maxTextChars = Math.max(1, opts.maxTextChars ?? INBOX_MAX_TEXT_CHARS);
    this.log = opts.log ?? (() => {});
  }

  /** The producers' seam: a function that writes one item of a class. */
  writer(): InboxWriter {
    return async (message, cls) => {
      this.add(cls, message);
    };
  }

  /** The EOD timer's seam: the day's sweep is class `eod`, id `eod-<date>`, so
   * the timer's own retries (and a restart that fires the day again) never
   * leave two sweeps for one day. */
  eodWriter(): (message: string, date?: string) => Promise<void> {
    return async (message, date) => {
      if (date === undefined) throw new Error("the EOD sweep needs its date to name its item");
      this.add("eod", message, { id: `eod-${date}` });
    };
  }

  /** The heartbeat's seam: class `heartbeat`, id `heartbeat-<date>`. */
  heartbeatWriter(): (message: string, date: string) => Promise<void> {
    return async (message, date) => {
      this.add("heartbeat", message, { id: `heartbeat-${date}` });
    };
  }

  /**
   * Write one item. `opts.id` names it (a producer's natural key); without it
   * the id is a hash of class and text. An id already pending is NOT rewritten
   * — the existing item is returned, so a retried producer never doubles up.
   * Throws only when the file cannot be written.
   */
  add(cls: InboxClass, text: string, opts: { id?: string } = {}): InboxItem {
    const id = opts.id ?? defaultId(cls, text);
    if (!ID_RE.test(id)) throw new Error(`companion inbox: invalid item id ${JSON.stringify(id)}`);
    const existing = this.read(id);
    if (existing) return existing;
    const body =
      text.length > this.maxTextChars
        ? `${text.slice(0, this.maxTextChars)}\n\n[truncated: ${text.length - this.maxTextChars} more characters]`
        : text;
    const item: InboxItem = { id, class: cls, text: body, created_at: this.now().toISOString() };
    mkdirSync(this.dir, { recursive: true });
    const tmp = join(this.dir, `.${id}.${process.pid}.tmp`);
    writeFileSync(tmp, `${JSON.stringify(item)}\n`);
    renameSync(tmp, this.path(id));
    this.enforceBound(id);
    return item;
  }

  /** Pending items, oldest first. A file that does not parse as an item is
   * skipped (never deleted: someone may be mid-repair). */
  list(): InboxItem[] {
    let names: string[];
    try {
      names = readdirSync(this.dir);
    } catch {
      return [];
    }
    const items: InboxItem[] = [];
    for (const name of names) {
      if (!name.endsWith(".json") || name.startsWith(".")) continue;
      const item = this.read(name.slice(0, -".json".length));
      if (item) items.push(item);
    }
    return items.sort((a, b) =>
      a.created_at === b.created_at
        ? a.id.localeCompare(b.id)
        : a.created_at < b.created_at
          ? -1
          : 1,
    );
  }

  /** The TUI's acknowledgement: the item is delivered, drop it. */
  ack(id: string): boolean {
    if (!ID_RE.test(id)) return false;
    if (!this.read(id)) return false;
    rmSync(this.path(id), { force: true });
    return true;
  }

  private path(id: string): string {
    return join(this.dir, `${id}.json`);
  }

  private read(id: string): InboxItem | null {
    try {
      const parsed: unknown = JSON.parse(readFileSync(this.path(id), "utf8"));
      return isItem(parsed) && parsed.id === id ? parsed : null;
    } catch {
      return null;
    }
  }

  /** Past the cap, drop the oldest routine item (never the one just written),
   * a login alert or an EOD sweep only when nothing routine is left. */
  private enforceBound(justWritten: string): void {
    let items = this.list();
    while (items.length > this.maxItems) {
      const candidates = items.filter((i) => i.id !== justWritten);
      const victim = candidates.find((i) => !KEEP_CLASSES.has(i.class)) ?? candidates[0];
      if (!victim) return;
      rmSync(this.path(victim.id), { force: true });
      this.log(
        `companion inbox full (${this.maxItems}): evicted ${victim.id} (${victim.class}, ${victim.created_at}) unread`,
      );
      items = items.filter((i) => i.id !== victim.id);
    }
  }
}
