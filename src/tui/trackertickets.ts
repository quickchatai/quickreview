// Read-only tracker-ticket projection for the `[4] tickets` tab (and the
// `[7] feedback` tab's FILED summary).
//
// The tracker is a local PC directory already mounted/configured for the TUI's
// qcr-tui auto-filer. This reader never claims, locks, or rewrites a ticket: it
// tolerates a concurrent temp+rename by skipping an unreadable file and tries
// again on the next refresh. The companion sees the selected ticket through
// the last-painted-frame surface — no second state channel and no VM access.
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

export interface TrackerTicket {
  id: string;
  title: string;
  status: string;
  role: string;
  category: string;
  updated: string;
  path: string;
  body: string;
}

function header(body: string, key: string): string {
  return new RegExp(`^${key}:\\s*(.*)$`, "m").exec(body)?.[1]?.trim() ?? "—";
}

export function parseTrackerTicket(body: string, path = ""): TrackerTicket | undefined {
  const title = /^#\s+(.+)$/m.exec(body)?.[1]?.trim();
  const id = header(body, "Id");
  if (!title || !/^FT-\d{4}$/.test(id)) return undefined;
  return {
    id,
    title,
    status: header(body, "Status"),
    role: header(body, "Role"),
    category: header(body, "Category"),
    updated: header(body, "Updated"),
    path,
    body: body.trim(),
  };
}

export function isActionableTicket(ticket: TrackerTicket): boolean {
  return ticket.status === "open" || ticket.status === "claimed";
}

/** Actionable first, then newest update, then id. */
export function orderTrackerTickets(tickets: TrackerTicket[]): TrackerTicket[] {
  return [...tickets].sort((a, b) => {
    const action = Number(isActionableTicket(b)) - Number(isActionableTicket(a));
    if (action !== 0) return action;
    if (a.updated !== b.updated) return a.updated < b.updated ? 1 : -1;
    return a.id.localeCompare(b.id);
  });
}

/**: the effort is CONFIG (`[sink] tickets_effort`, falling back to
 * the filer's `effort`), never a literal — index.ts wires both arguments. */
export function readEffortTickets(root: string, effort: string): TrackerTicket[] {
  // A tracker root or effort that is not there is a read that FAILED (a
  // missing mount, a checkout this machine does not have, a typo in the
  // effort) — it throws, and the store shows it unreadable. Only an
  // EXISTING effort that has no tickets/ yet is a real, empty tracker.
  if (!existsSync(root)) throw new Error(`tracker root ${root} does not exist`);
  const effortDir = join(root, "efforts", effort);
  if (!existsSync(effortDir))
    throw new Error(`tracker effort '${effort}' does not exist under ${root}`);
  const dir = join(effortDir, "tickets");
  if (!existsSync(dir)) return [];
  const tickets: TrackerTicket[] = [];
  for (const name of readdirSync(dir)) {
    if (!/^FT-\d{4}-.+\.md$/.test(name)) continue;
    try {
      const path = join(dir, name);
      const ticket = parseTrackerTicket(readFileSync(path, "utf8"), path);
      if (ticket) tickets.push(ticket);
    } catch {
      // A concurrent tracker writer may be between rename steps. Refresh will
      // see the stable file; one missing row is better than breaking the TUI.
    }
  }
  return orderTrackerTickets(tickets);
}
