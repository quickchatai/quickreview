// Memory incident → ONE issue-tracker ticket (FT-0546 S1).
//
// Reviewer memory was dead from 2026-09-03 to 10-02 and the only party ever
// told was the overseer, which wrote it into 33 digests nobody reads. The
// `#bug` auto-filer (autofile.ts) could never have filed it either: it reads
// its defects OUT OF MEMORY, the very thing that was down. This filer reads
// the daemon's status.json `memory` block instead — never OpenViking — and
// files ONE ticket per incident once the incident is older than
// `[memory] incident_ticket_after_min` (2 h).
//
// Same tracker protocol as autofile.ts, which it reuses: actor `qcr-tui`, the
// next FT id claimed by exclusive create, the ticket in the configured
// effort. Dedup is by INCIDENT START: the ticket carries a
// `Memory-incident: <since>` line, and the daemon persists an open incident's
// start across restarts (src/memory/health.ts), so a restart inside the same
// outage never mints a second ticket. Only a wayfinder tracker is an issue
// tracker; with another `[sink]` this files nothing and says so once.
//
// Acts only on FRESH data (the caller passes the poller's verdict): a stale
// snapshot may describe an outage that already ended. Never throws — a broken
// tracker must not take down the TUI poll loop.
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { credentialPhrase, fmtDuration, type MemoryStatus } from "../memory/health.js";
import { claimNextId, type TrackerPaths } from "./autofile.js";

export const MEMORY_INCIDENT_LINE = "Memory-incident:";

/** The dedup key: the incident's START, whatever its kind became since. */
export function incidentKey(m: MemoryStatus): string | undefined {
  return m.incident?.since;
}

/** Incident keys already filed in the effort's tickets. */
export function filedIncidentKeys(paths: TrackerPaths): Set<string> {
  const keys = new Set<string>();
  const dir = join(paths.root, "efforts", paths.effort, "tickets");
  if (!existsSync(dir)) return keys;
  for (const f of readdirSync(dir)) {
    if (!f.endsWith(".md")) continue;
    let body: string;
    try {
      body = readFileSync(join(dir, f), "utf8");
    } catch {
      continue;
    }
    for (const m of body.matchAll(/^Memory-incident: (.+)$/gm)) keys.add(m[1]!.trim());
  }
  return keys;
}

/** The ticket, from the status block alone. Never carries a key: the block
 * holds credential VERDICTS, not credentials. */
export function incidentTicketBody(
  id: string,
  m: MemoryStatus,
  paths: TrackerPaths,
  now: Date,
): { name: string; content: string } {
  const since = m.incident?.since ?? m.since;
  const kind = m.state === "auth_failed" ? "auth failed" : "down";
  const name = `FT-${id}-reviewer-memory-${m.state === "auth_failed" ? "auth-failed" : "down"}.md`;
  const nowIso = now.toISOString();
  const age = fmtDuration(now.getTime() - Date.parse(since));
  const err = m.last_error;
  const prov = m.provision;
  const requests = Object.entries(m.requests)
    .map(
      ([op, c]) =>
        `${op} ${c.ok}/${c.total} ok${c.absent ? `, ${c.absent} not found` : ""}${c.auth_failed ? `, ${c.auth_failed} auth` : ""}${c.failed ? `, ${c.failed} failed` : ""}`,
    )
    .join("; ");
  const content = `# Reviewer memory ${kind} for ${age}

Id: FT-${id}
Effort: ${paths.effort}
Type: impl
Status: open
Role: —
Category: —
Labels: review-ops, auto-filed, memory
Assignee: —
Blocked-by: —
Parent: ${paths.parent}
Spec: —
Branch: —
PR: —
Created: ${nowIso} by qcr-tui
Updated: ${nowIso}
Claimed: —
Closed: —

## Question

Reviewer memory (OpenViking) has been unusable since ${since} — ${age} when
this was filed (FT-0546 S1). Every round runs memory-less and nothing the
reviewer learns is written until it is fixed. Auto-filed by the TUI from the
daemon's status.json \`memory\` block — not from memory, which is the thing
that is down. Diagnose and fix the cause, then resolve with a note; the
board banner clears on its own once memory answers again.

${MEMORY_INCIDENT_LINE} ${since}

## What status.json said

- state: ${m.state} (since ${m.since})
- daemon key: ${credentialPhrase(m.credentials.daemon)}
- sessions' ovcli.conf: ${credentialPhrase(m.credentials.sessions)}
- last authenticated success: ${m.last_ok_at ?? "none since the daemon booted"}
- last error: ${err ? `${err.at} ${err.op} — ${err.status || "no answer"} ${err.code} ${err.message}` : "none recorded"}
- boot provisioning: ${prov ? `${prov.state}${prov.at ? ` (${prov.at})` : ""}${prov.errors && prov.errors.length > 0 ? ` — ${prov.errors.join("; ")}` : ""}` : "not read"}
- daemon requests since boot: ${requests || "none"}

## Where to look

- \`qcr status\` (the memory line) and the \`openviking\` + \`memory\` blocks of state/status.json
- an auth failure: the reviewer key in the secrets mount must be the key the
  server holds for user \`reviewer\` — docs/companion-memory-access.md (never
  rotate from a session)
- down: the supervisor's \`openviking\` block (running, ready, restarts,
  last_error) and the daemon log
`;
  return { name, content };
}

export interface IncidentFilerMemo {
  /** Incident keys this process already knows are filed — saves a tickets
   * scan on every poll once filed. */
  filed: Set<string>;
  /** "no issue tracker configured" was said once already. */
  noTrackerSaid: boolean;
  /** When the last attempt FAILED (ms) — a broken tracker is retried every
   * `RETRY_AFTER_FAILURE_MS`, not rescanned on every 3 s poll. */
  failedAt?: number;
}

export const RETRY_AFTER_FAILURE_MS = 5 * 60_000;

export function newIncidentFilerMemo(): IncidentFilerMemo {
  return { filed: new Set(), noTrackerSaid: false };
}

export type IncidentFileOutcome =
  | { kind: "none" }
  | { kind: "filed"; ticketId: string; file: string }
  | { kind: "already"; key: string }
  | { kind: "no-tracker"; line: string }
  | { kind: "failed"; line: string };

/**
 * File the incident when it is due, once. `paths` undefined ⇒ no issue
 * tracker is configured (`[sink] kind` is not `wayfinder`): nothing is filed,
 * and the first due incident says so once.
 */
export function maybeFileMemoryIncident(
  paths: TrackerPaths | undefined,
  memory: MemoryStatus | undefined,
  opts: { fresh: boolean; now: Date; afterMs: number; memo: IncidentFilerMemo },
): IncidentFileOutcome {
  try {
    if (!opts.fresh || !memory || !memory.enabled) return { kind: "none" };
    if (memory.state !== "auth_failed" && memory.state !== "down") return { kind: "none" };
    const key = incidentKey(memory);
    if (key === undefined) return { kind: "none" };
    const started = Date.parse(key);
    if (!Number.isFinite(started) || opts.now.getTime() - started < opts.afterMs)
      return { kind: "none" };
    if (opts.memo.filed.has(key)) return { kind: "already", key };
    if (!paths) {
      if (opts.memo.noTrackerSaid) return { kind: "none" };
      opts.memo.noTrackerSaid = true;
      return {
        kind: "no-tracker",
        line: `memory incident since ${key} is past the ticket threshold, but no wayfinder tracker is configured ([sink] kind) — not filed; the board banner stands`,
      };
    }
    if (
      opts.memo.failedAt !== undefined &&
      opts.now.getTime() - opts.memo.failedAt < RETRY_AFTER_FAILURE_MS
    )
      return { kind: "none" };
    if (filedIncidentKeys(paths).has(key)) {
      opts.memo.filed.add(key);
      return { kind: "already", key };
    }
    const ticketsDir = join(paths.root, "efforts", paths.effort, "tickets");
    mkdirSync(ticketsDir, { recursive: true });
    const id = claimNextId(
      paths.root,
      (n) =>
        `efforts/${paths.effort}/tickets/${incidentTicketBody(n, memory, paths, opts.now).name}`,
    );
    const { name, content } = incidentTicketBody(id, memory, paths, opts.now);
    writeFileSync(join(ticketsDir, name), content);
    opts.memo.filed.add(key);
    delete opts.memo.failedAt;
    return { kind: "filed", ticketId: `FT-${id}`, file: name };
  } catch (err) {
    opts.memo.failedAt = opts.now.getTime();
    return {
      kind: "failed",
      line: `memory incident ticket could not be filed: ${err instanceof Error ? err.message : String(err)}`,
    };
  }
}
