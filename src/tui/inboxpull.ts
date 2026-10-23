// The companion inbox pull — the TUI's half of the overseer's retired duties.
//
// The bot leaves what the overseer used to be woken for in a durable inbox
// (`<root>/inject/companion-inbox/`, src/companioninbox.ts): anomalies, the
// daily heartbeat, login alerts, the 18:00 EOD sweep. This module pulls the
// new items over the TUI's one runner (remote.ts — the same argv over ssh and
// locally), hands each to the companion, and acks it back to the bot:
//
//   * the companion's inject dir (`companionInjectDir`): the unmodified
//     inject-bridge drains it into the companion's session on arrival when it
//     runs, and at its next start when it does not — so the EOD sweep runs
//     LATE when the companion is off, never not at all;
//   * the alerts feed (`<alerts_dir>/<ts>-inbox-<id>.json`, the schema of
//     src/tui/alerts.ts): the owner sees an anomaly or a login alert on the
//     status line and the badge at once, without the companion having to be up.
//
// The order is the safety: write the inject file, write the alert, THEN ack.
// A crash or a failed ack leaves the item on the bot, and the next pull finds
// both files already there (their names derive from the item, not from the
// clock) and acks without delivering twice. A second TUI pulling the same
// inbox lands on the same file names for the same reason.
//
// Nothing here executes an item's text or writes anywhere but those two local
// dirs and the ack (a delete of the item's own file on the bot). It touches no
// GitHub and no session: delivery is a file, and what the companion does with
// it is the companion's.
import { existsSync, mkdirSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { parseInboxItem, type InboxClass, type InboxItem } from "../companioninbox.js";
import type { TuiConfig } from "../config.js";
import { MAX_TITLE, type AlertTier } from "./alerts.js";
import { inboxAckArgv, inboxListArgv, type SshRunner } from "./remote.js";

/** The class line each item carries into the companion's session. */
const CLASS_LABEL: Record<InboxClass, string> = {
  anomaly: "anomaly",
  heartbeat: "heartbeat",
  login: "login alert",
  eod: "EOD sweep",
};

/** An alert's tier per class: what needs the owner now is an alert, what is
 * routine or queued for the companion is a notice. */
const ALERT_TIER: Record<InboxClass, AlertTier> = {
  anomaly: "alert",
  login: "alert",
  heartbeat: "notice",
  eod: "notice",
};

/** The stamp both local file names lead with: the item's own time, so the name
 * is the item's and a re-pull lands on it. */
function stamp(item: InboxItem): string {
  return item.created_at.replace(/[:.]/g, "-");
}

/** Where the item lands in the companion's inject dir. Oldest first, as the
 * bridge drains by name. */
export function inboxInjectName(item: InboxItem): string {
  return `${stamp(item)}-inbox-${item.id}.md`;
}

/** The alert file's name in the alerts dir. */
export function inboxAlertName(item: InboxItem): string {
  return `${stamp(item)}-inbox-${item.id}.json`;
}

/** What the companion reads: the class and id on a header line, then the
 * bot's text verbatim. */
export function inboxInjectText(item: InboxItem): string {
  return `[companion inbox · ${CLASS_LABEL[item.class]} · ${item.id} · ${item.created_at}]\n\n${item.text}\n`;
}

/** The alert record an item becomes (the schema `parseAlert` reads). The cause
 * is the item's id: the bot already folded identical items into one, so each
 * distinct one reaches the owner. */
export function inboxAlert(item: InboxItem): Record<string, unknown> {
  const firstLine = item.text.split("\n").find((l) => l.trim() !== "") ?? item.text;
  const label = CLASS_LABEL[item.class];
  const title = (item.class === "eod" ? `${label} queued for the companion` : firstLine)
    .replace(/^\[[^\]]*\]\s*/, "")
    .trim();
  return {
    tier: ALERT_TIER[item.class],
    cause: `inbox:${item.id}`,
    pr: null,
    title: (title === "" ? label : title).slice(0, MAX_TITLE),
    body: item.class === "eod" ? "" : item.text.slice(0, 1500),
    ts: item.created_at,
  };
}

/** One file, tmp + rename, unless it (or the consumer's archived copy of it)
 * is already there. */
function writeOnce(dir: string, name: string, text: string): boolean {
  if (existsSync(join(dir, name)) || existsSync(join(dir, ".done", name))) return false;
  mkdirSync(dir, { recursive: true });
  const tmp = join(dir, `.${name}.tmp`);
  writeFileSync(tmp, text);
  renameSync(tmp, join(dir, name));
  return true;
}

export interface InboxPullDeps {
  cfg: TuiConfig;
  ssh: SshRunner;
  /** The companion's inject dir on this machine (`companionInjectDir`). */
  injectDir: string;
  /** The alerts feed the AlertConsumer scans. */
  alertsDir: string;
}

export interface InboxPullResult {
  /** Items now with the companion and acked on the bot. */
  delivered: InboxItem[];
  /** Lines that were not an item (never acked, so never lost). */
  skipped: number;
  /** Set when the listing or the ack failed. The items stay on the bot. */
  error?: string;
}

/** The last stderr line of a failed call, or its exit status. */
export function why(r: { stderr: string; code: number | null }): string {
  return r.stderr.trim().split("\n").filter(Boolean).at(-1) ?? `exit ${r.code ?? "?"}`;
}

/**
 * One pull: list, deliver, ack. Total — a failure is the result's `error`,
 * never a throw, and an item that could not be delivered or acked is simply
 * pulled again next time.
 */
export async function pullCompanionInbox(deps: InboxPullDeps): Promise<InboxPullResult> {
  const listed = await deps.ssh(deps.cfg.ssh_host, inboxListArgv(deps.cfg));
  if (!listed.ok)
    return { delivered: [], skipped: 0, error: `inbox listing failed: ${why(listed)}` };
  const items: InboxItem[] = [];
  let skipped = 0;
  for (const line of listed.stdout.split("\n")) {
    if (line.trim() === "") continue;
    const item = parseInboxItem(line);
    if (item) items.push(item);
    else skipped++;
  }
  items.sort((a, b) =>
    a.created_at === b.created_at ? a.id.localeCompare(b.id) : a.created_at < b.created_at ? -1 : 1,
  );
  const delivered: InboxItem[] = [];
  let error: string | undefined;
  for (const item of items) {
    try {
      writeOnce(deps.injectDir, inboxInjectName(item), inboxInjectText(item));
      writeOnce(deps.alertsDir, inboxAlertName(item), `${JSON.stringify(inboxAlert(item))}\n`);
      delivered.push(item);
    } catch (err) {
      // Not delivered, so not acked: the item stays on the bot for the next pull.
      error = `inbox item ${item.id} not delivered: ${err instanceof Error ? err.message : String(err)}`;
    }
  }
  if (delivered.length > 0) {
    const acked = await deps.ssh(
      deps.cfg.ssh_host,
      inboxAckArgv(
        deps.cfg,
        delivered.map((i) => i.id),
      ),
    );
    if (!acked.ok)
      error = `inbox ack failed (items stay pending, re-delivery is a no-op): ${why(acked)}`;
  }
  return { delivered, skipped, ...(error === undefined ? {} : { error }) };
}

/** Minimum gap between pulls, whatever the poll cadence: the inbox is a slow
 * channel and each pull is an ssh round trip. */
export const INBOX_PULL_MIN_MS = 20_000;

/**
 * The poll-cadence driver: `tick()` pulls when the gap has passed and no pull
 * is in flight, and says what happened through `onResult` — the TUI's notice
 * line. A failure is reported once per run of failures, not once per poll.
 */
export class InboxPuller {
  private busy = false;
  private last = 0;
  private failing = false;

  constructor(
    private readonly deps: InboxPullDeps,
    private readonly onResult: (line: string) => void,
    private readonly now: () => number = () => Date.now(),
    private readonly minGapMs: number = INBOX_PULL_MIN_MS,
  ) {}

  tick(): Promise<InboxPullResult | undefined> {
    if (this.busy || this.now() - this.last < this.minGapMs) return Promise.resolve(undefined);
    this.busy = true;
    this.last = this.now();
    return pullCompanionInbox(this.deps)
      .then((res) => {
        if (res.error !== undefined) {
          if (!this.failing) this.onResult(`✖ companion inbox: ${res.error}`);
          this.failing = true;
        } else {
          this.failing = false;
        }
        if (res.delivered.length > 0)
          this.onResult(
            `companion inbox ▸ ${res.delivered.length} new (${[...new Set(res.delivered.map((i) => i.class))].join(", ")})`,
          );
        return res;
      })
      .finally(() => {
        this.busy = false;
      });
  }
}
