// The ORIGIN RECORD — the sole authority on what a Slack-driven overseer turn
// is allowed to do.
//
// The overseer reads a Slack message as *text*, and text is attacker-controlled:
// nothing the model repeats back to the daemon can be trusted to carry rights.
// So the router writes the rights DOWN, next to the inject file it just dropped.
// The inject body's `tier` line is decoration for the model; the record is what
// the gate consults.
//
// PROVENANCE: the gate consults the record THIS PROCESS wrote, held in memory —
// never whatever parses in the directory. The daemon runs as the same uid as
// every pi session, so `state/slack/origin/` is session-writable: a persuaded
// overseer could otherwise drop a far-future `source: "local", tier: "system"`
// file and sort itself to the top. The operator command channel answers the
// same problem with a root seal; here the daemon itself is the writer, so the
// seal is its own memory. The files are the AUDIT trail — forensically joined
// to the inject they sit beside, read back by `onDisk()` — and grant nothing.
// Across a restart the memory is empty: the Slack dir fails closed (no live
// origin), and disk seeds only what can RESTRICT. Two kinds of record are read
// back: the last accepted wake (or newest record when none is proven accepted)
// as `bootCause`, and every
// one bound to a wake still pending in the inject dir (`bootQueued`) — pending
// wakes survive a restart and the bridge serves them first, so a guest's
// queued message is a guest's turn after the restart too. Either is kept only
// when it is a Slack record from a non-owner, so a planted record can switch
// the belt on, or narrow the rights of a turn this process recorded, and
// nothing more. What disk cannot do is grant: a planted local/owner record
// reads as no record, and a disk record alone never opens the Slack dir. Both
// kinds stop counting only when a wake THIS process recorded is accepted after
// them; a wake from the previous run never lifts them, so its turn stays under
// the belt (fail closed).
//
// Attribution follows the turn being SERVED, never the newest record. The
// overseer runs one wake at a time: the inject bridge offers a wake only
// while pi is idle, takes pending wakes in FILE-NAME order, and moves a file
// to `.done/` when pi accepts it, so a wake written while another turn runs
// waits behind it. A record is bound to the wake file it was written for, and
// the order that matters is the bridge's: the record whose wake comes LAST in
// name order among the accepted ones is the running turn's. Write order is
// not that order — a writer records first and names its wake file only after
// an await, so two writers can finish in either order. Every record not yet
// accepted (unbound, or bound to a wake still pending) describes a turn still
// to come. The rights a command gets are the MOST RESTRICTIVE of the running
// record and every one still to come: a queued owner message or daemon wake
// never lends its rights to the guest turn still running, and a queued guest
// message restricts a running owner turn (fail closed). A record whose wake
// left the queue without being accepted, before the running one, describes no
// turn and drops out. Acceptance is read from disk only as "the wake left
// the pending queue AND landed in `.done/`": both live in the overseer's
// inject dir, which the bash guard refuses every session's write to, and a
// session has no program that removes or moves a file. Built without the
// delivery directory, the store sees no acceptance and the newest record is
// in force at once. A command file names no wake, so a command is judged by
// the turn being served when the watcher reads it: one written at the very
// end of a turn and read after the next wake is accepted gets that turn's
// rights.
//
// A command in `commands/slack/` is attributed to an UNEXPIRED origin. The
// window is short by design — an origin is a "a human is mid-conversation
// with you right now" marker, not a session-long grant, and no origin means
// no rights (fail closed).
//
// The legacy `commands/` belt asks a DIFFERENT question — "who caused the turn
// I am serving?" — and answers it from `latestAny()`, ignoring expiry: waiting
// out a TTL must never turn a guest's turn into an owner-tier one. Only a
// daemon wake (`writeLocal`) that pi has accepted supersedes a Slack origin
// there.
import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";
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
  // `foldSlackTier` accepts a legacy spelling of the owner tier (older records
  // on disk still carry it) and folds it to "owner" — accepted on input, never
  // emitted; everything unknown still grants nothing.
  const foldedTier = foldSlackTier(tier);
  if (foldedTier === null) return null;
  if (typeof expires_at !== "string" || Number.isNaN(Date.parse(expires_at))) return null;
  const prs = Array.isArray(authorized_prs)
    ? authorized_prs.filter(
        (n): n is number => typeof n === "number" && Number.isInteger(n) && n > 0,
      )
    : [];
  // Anything that is not literally "local" — missing, misspelled, non-string —
  // reads as a Slack-caused turn, i.e. the restricting value.
  return {
    source: source === "local" ? "local" : "slack",
    event_id,
    slack_user,
    tier: foldedTier,
    authorized_prs: prs,
    expires_at,
  };
}

/**
 * `state/slack/origin/<inject-file-basename>.json`, written atomically
 * (tmp+rename, exactly like PiSessionManager.writeAtomic) so an auditor can
 * never read a half-written record. The file is the audit copy; the grant the
 * gate consults is the in-memory one (see PROVENANCE at the top).
 *
 * The file NAME is the inject file the record was bound to, which is what
 * makes the record auditable against the overseer's transcript. The overseer's
 * command file carries no back-reference to the inject that prompted it, so
 * lookup is by delivery order: the turn being served is the one whose inject
 * pi accepted last (see "Attribution" at the top).
 */
/** One record this process wrote, with what it knows of its wake's delivery. */
interface Held {
  rec: OriginRecord;
  seq: number;
  /** The wake file's name without `.md`, once the record is bound to one. */
  stem: string | null;
  /** pi accepted the bound wake (sticky once seen). */
  accepted: boolean;
}

/** Rights order, least first: the most restrictive record wins a tie-break. */
const TIER_RANK: Record<SlackTier, number> = {
  ignored: 0,
  anyone: 1,
  author: 2,
  owner: 3,
  system: 4,
};

/**
 * The rights several candidate records leave: the lowest tier among them, and
 * for `author` only the PRs every author-tier candidate is authorised on.
 * `cands` comes latest first; the audit fields are those of the lowest-tier
 * record nearest the running turn.
 */
/**
 * The legacy `commands/` belt's question about a turn's origin: a Slack turn
 * from anyone but the owner restricts it. The same predicate decides which
 * records are read back off disk at boot, since those may only restrict.
 */
export function beltRestricts(rec: OriginRecord): boolean {
  return rec.source === "slack" && rec.tier !== "owner";
}

function mostRestrictive(cands: readonly OriginRecord[]): OriginRecord | null {
  if (cands.length === 0) return null;
  const low = Math.min(...cands.map((c) => TIER_RANK[c.tier]));
  const lowest = cands.filter((c) => TIER_RANK[c.tier] === low);
  const pick = lowest[lowest.length - 1]!;
  if (pick.tier !== "author") return pick;
  const prs = pick.authorized_prs.filter((n) => lowest.every((c) => c.authorized_prs.includes(n)));
  return { ...pick, authorized_prs: prs };
}

/**
 * The bridge's delivery order, latest first: unbound records (their wake
 * files will be named after every existing one), newest write first; then
 * bound ones by wake name, descending — the reverse of the bridge's own
 * `sort()`.
 */
function byDeliveryDesc(a: Held, b: Held): number {
  if (a.stem === null || b.stem === null) {
    if (a.stem === null && b.stem === null) return b.seq - a.seq;
    return a.stem === null ? -1 : 1;
  }
  return a.stem < b.stem ? 1 : a.stem > b.stem ? -1 : b.seq - a.seq;
}

export class OriginStore {
  private seq = 0;
  /** The records THIS process wrote, keyed by file path — the only authority. */
  private readonly authority = new Map<string, Held>();
  /** Where the bridge moves an accepted wake (`<inject dir>/.done`); null when
   * this store sees no delivery, and every record is in force at once. */
  private readonly deliveredDir: string | null;
  /** The bridge's pending queue — the directory `.done/` sits in. */
  private readonly pendingDir: string | null;
  /**
   * The belt's answer before this process has written anything: the newest
   * record left on disk by a previous run, kept ONLY when it restricts (a
   * Slack-caused turn from a non-owner). Anything that would lift the belt is
   * already what "no record" means, so it is never trusted from disk.
   */
  private readonly bootCause: OriginRecord | null;
  /**
   * The restricting records a previous run left bound to a wake still pending
   * at boot: turns the bridge has yet to serve. Each counts until a wake this
   * process recorded, named after its own, is accepted.
   */
  private readonly bootQueued: Array<{ rec: OriginRecord; stem: string }>;

  constructor(
    private readonly dir: string,
    private readonly now: () => Date = () => new Date(),
    opts: { deliveredDir?: string } = {},
  ) {
    this.deliveredDir = opts.deliveredDir ?? null;
    this.pendingDir = this.deliveredDir === null ? null : dirname(this.deliveredDir);
    const onDisk = this.scan();
    const accepted = this.acceptedDiskName(onDisk.map((entry) => entry.name));
    const newest = (onDisk.find((entry) => entry.name === accepted) ?? onDisk[0])?.rec ?? null;
    this.bootCause = newest && beltRestricts(newest) ? newest : null;
    this.bootQueued = [];
    for (const { rec, name } of onDisk) {
      const stem = name.replace(/\.json$/, "");
      if (beltRestricts(rec) && this.isPending(stem)) this.bootQueued.push({ rec, stem });
    }
  }

  /** The bridge's last accepted wake, independent of later queued writes. */
  private acceptedDiskName(names: readonly string[]): string | undefined {
    if (this.deliveredDir === null) return undefined;
    return names.filter((name) => {
      const stem = name.replace(/\.json$/, "");
      return !this.isPending(stem) && existsSync(join(this.deliveredDir!, `${stem}.md`));
    }).sort().at(-1);
  }

  /** A wake named `<stem>.md` is still in the bridge's pending queue. */
  private isPending(stem: string): boolean {
    return this.pendingDir !== null && existsSync(join(this.pendingDir, `${stem}.md`));
  }

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
   * the legacy-dir belt would refuse the daemon's own commands (one guest
   * message every 15 minutes would block the EOD pipeline indefinitely).
   * Tier `system` with no user: the daemon keeps the autonomy it always had —
   * this is the stamped, auditable form of the same authority a missing origin
   * record grants (`authorizeCommand(_, null)` ⇒ ok).
   */
  writeLocal(reason: string): OriginRecord {
    const slug =
      (reason || "wake")
        .replace(/[^a-zA-Z0-9._-]+/g, "-")
        .slice(0, 48)
        .replace(/^-+|-+$/g, "") || "wake";
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
    const full: OriginRecord = {
      ...rec,
      expires_at: new Date(this.now().getTime() + ORIGIN_TTL_MS).toISOString(),
    };
    const path = this.path(basename);
    mkdirSync(this.dir, { recursive: true });
    const seq = this.seq++;
    const tmp = `${path}.tmp-${process.pid}-${seq}`;
    writeFileSync(tmp, `${JSON.stringify(full, null, 2)}\n`);
    renameSync(tmp, path);
    this.authority.set(path, { rec: full, seq, stem: null, accepted: this.deliveredDir === null });
    this.prune();
    return full;
  }

  /**
   * Bind a record to the wake file written for it, and move the audit file to
   * that name (the router and the daemon's own wakes bind once the file
   * exists). Until it is bound, and until pi accepts that wake, the record
   * describes a queued turn: it restricts the running one, and lends it
   * nothing. The binding is held in memory, so a failed file move still binds.
   */
  rename(fromBasename: string, toBasename: string): void {
    const from = this.path(fromBasename);
    const to = this.path(toBasename);
    const held = this.authority.get(from);
    if (held) held.stem = toBasename.replace(/\.md$/, "");
    if (from === to || !existsSync(from)) return;
    try {
      renameSync(from, to);
    } catch {
      /* best effort — the binding above is what counts */
      return;
    }
    if (held) {
      this.authority.delete(from);
      this.authority.set(to, held);
    }
  }

  /** Bind a record `writeLocal` returned to the wake file written for it. */
  bind(rec: OriginRecord, injectPath: string): void {
    const basename = this.basenameOf(rec);
    if (basename !== null) this.rename(basename, injectPath.split("/").pop() ?? injectPath);
  }

  /** Drop a record `writeLocal` returned (the wake it was written for never
   * landed). */
  forget(rec: OriginRecord): void {
    const basename = this.basenameOf(rec);
    if (basename !== null) this.remove(basename);
  }

  /** The basename a held record is filed under, or null if not held. */
  private basenameOf(rec: OriginRecord): string | null {
    for (const [path, h] of this.authority) {
      if (h.rec === rec) return path.slice(this.dir.length + 1).replace(/\.json$/, "");
    }
    return null;
  }

  /** Drop a record (the inject it was written for never landed). */
  remove(basename: string): void {
    const path = this.path(basename);
    this.authority.delete(path);
    rmSync(path, { force: true });
  }

  /** Every unexpired record this process wrote, newest first. */
  all(): OriginRecord[] {
    const now = this.now().getTime();
    return this.held()
      .map((h) => h.rec)
      .filter((rec) => Date.parse(rec.expires_at) > now);
  }

  /**
   * The origin of the turn being served, while it is live: the most
   * restrictive of the accepted wake's record and every record queued behind
   * it. Null when any of them has expired — the running turn's origin then
   * has, and an expired turn authorises nothing — or when no record exists.
   */
  latest(): OriginRecord | null {
    const now = this.now().getTime();
    const serving = this.serving();
    // A record read off disk only narrows a turn this process recorded.
    if (serving.length === 0) return null;
    const cands = [...serving.map((h) => h.rec), ...this.bootQueuedLive(serving)];
    if (cands.some((rec) => Date.parse(rec.expires_at) <= now)) return null;
    return mostRestrictive(cands);
  }

  /**
   * The same origin REGARDLESS OF AGE — "what caused the turn being served",
   * not "is a turn live". The legacy-dir belt reads this one: expiry must not
   * be an escalation, so an old Slack origin keeps the belt on until a daemon
   * wake (a `local` record) pi has accepted supersedes it. Before this process
   * has seen any wake accepted, the restricting record a previous run left
   * (`bootCause`) is a candidate too, and so is every restricting record of
   * the previous run whose wake is still to be served (`bootQueued`).
   */
  latestAny(): OriginRecord | null {
    const serving = this.serving();
    const cands = serving.map((h) => h.rec);
    if (this.bootCause && !serving.some((h) => this.isAccepted(h))) cands.push(this.bootCause);
    cands.push(...this.bootQueuedLive(serving));
    return mostRestrictive(cands);
  }

  /**
   * The previous run's queued restricting records whose turn may still be
   * served: no wake this process recorded and named after theirs is accepted
   * yet. The bridge takes wakes in name order, so once one is, theirs is over.
   */
  private bootQueuedLive(serving: readonly Held[]): OriginRecord[] {
    if (this.bootQueued.length === 0) return [];
    const running = serving.find((h) => this.isAccepted(h));
    const over = (stem: string) => running !== undefined && running.stem! > stem;
    return this.bootQueued.filter((b) => !over(b.stem)).map((b) => b.rec);
  }

  /**
   * pi accepted the wake this record is bound to (always, with no delivery
   * view): the wake file is in `.done/` AND no longer pending. The bridge
   * moves it with one rename, so a real acceptance shows both; a file planted
   * in `.done/` beside a wake still queued is not an acceptance. Sticky once
   * seen.
   */
  private isAccepted(h: Held): boolean {
    if (h.accepted) return true;
    if (this.deliveredDir === null || h.stem === null) return false;
    const name = `${h.stem}.md`;
    if (existsSync(join(this.deliveredDir, name)) && !existsSync(join(this.pendingDir!, name))) {
      h.accepted = true;
    }
    return h.accepted;
  }

  /**
   * The records that may describe the turn being served, latest in the
   * bridge's delivery order first: every record not yet accepted (the unbound
   * ones ahead of the rest — their wake files do not exist yet), then the
   * running turn's — the accepted record whose wake comes last in name order.
   * Every record when none was accepted yet. Without a delivery view, the
   * newest record alone.
   */
  private serving(): Held[] {
    const held = this.held();
    if (this.deliveredDir === null) return held.slice(0, 1);
    let running: Held | null = null;
    for (const h of held) {
      if (this.isAccepted(h) && (running === null || h.stem! > running.stem!)) running = h;
    }
    const cands =
      running === null
        ? held
        : held.filter((h) => h === running || (!this.isAccepted(h) && this.toCome(h, running)));
    return cands.sort(byDeliveryDesc);
  }

  /**
   * A record not accepted is still to come unless its wake already left the
   * queue unaccepted ahead of the running one — the bridge takes wakes in
   * name order, so such a wake is never served.
   */
  private toCome(h: Held, running: Held): boolean {
    if (h.stem === null || h.stem > running.stem!) return true;
    return existsSync(join(this.pendingDir!, `${h.stem}.md`));
  }

  /**
   * Every parseable record in the directory, newest first — the AUDIT view.
   * It includes whatever a session may have planted there, which is exactly
   * why nothing that authorises reads it.
   */
  onDisk(): OriginRecord[] {
    return this.scan().map((o) => o.rec);
  }

  /** The in-memory records, newest first (expiry, then write order). */
  private held(): Held[] {
    return [...this.authority.values()].sort((a, b) => {
      const e = Date.parse(b.rec.expires_at) - Date.parse(a.rec.expires_at);
      return e !== 0 ? e : b.seq - a.seq;
    });
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
   * Every record that may describe the turn being served is kept, expired or
   * not — the accepted one and those queued behind it: `latestAny()` is what
   * the legacy-dir belt consults, and deleting the last expired Slack origin
   * would silently release the belt — waiting would buy rights.
   */
  prune(): void {
    const now = this.now().getTime();
    // Memory first: the records the belt answers from stay.
    const keepHeld = new Set(this.serving());
    for (const [path, h] of [...this.authority]) {
      if (!keepHeld.has(h) && Date.parse(h.rec.expires_at) <= now) this.authority.delete(path);
    }
    if (!existsSync(this.dir)) return;
    const disk = this.scan();
    const keep = new Set([disk[0]?.name, this.acceptedDiskName(disk.map((entry) => entry.name))]);
    for (const entry of readdirSync(this.dir, { withFileTypes: true })) {
      if (!entry.isFile()) continue;
      const path = join(this.dir, entry.name);
      try {
        if (entry.name.endsWith(".tmp") || /\.tmp-\d+-\d+$/.test(entry.name)) {
          if (now - statSync(path).mtimeMs > ORIGIN_TTL_MS) rmSync(path, { force: true });
          continue;
        }
        if (!entry.name.endsWith(".json")) continue;
        if (keep.has(entry.name)) continue;
        // A record bound to a wake still pending describes a turn to come,
        // which a restart before it is served must still find.
        if (this.isPending(entry.name.replace(/\.json$/, ""))) continue;
        const rec = parseOriginRecord(JSON.parse(readFileSync(path, "utf8")) as unknown);
        if (!rec || Date.parse(rec.expires_at) <= now) rmSync(path, { force: true });
      } catch {
        /* best effort */
      }
    }
  }
}
