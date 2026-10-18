// Memory incident → one issue-tracker ticket.
//
// A memory outage must reach a person, not only the overseer's digest. The
// `#bug` auto-filer (autofile.ts) cannot report it: it reads its defects out
// of memory, the very thing that is down. This filer reads the daemon's
// status.json `memory` block instead — never OpenViking — and files one
// ticket per incident once the incident is older than
// `[memory] incident_ticket_after_min` (default 2 h).
//
// Same tracker protocol as autofile.ts, which it reuses: actor `qcr-tui`, the
// next FT id claimed by exclusive create, the ticket in the configured
// effort. Dedup is by incident start: the ticket carries a
// `Memory-incident: <since>` line, and the daemon persists an open incident's
// start across restarts (src/memory/health.ts), so a restart inside the same
// outage never mints a second ticket. Only a wayfinder tracker is an issue
// tracker; with another `[sink]` this files nothing and says so once.
//
// Acts only on fresh data (the caller passes the poller's verdict): a stale
// snapshot may describe an outage that already ended. Never throws — a broken
// tracker must not take down the TUI poll loop.
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { CurationStatus } from "../learner/status.js";
import { credentialPhrase, fmtDuration, type MemoryStatus } from "../memory/health.js";
import { claimNextId, filedKeys, type TrackerPaths } from "./autofile.js";

export const MEMORY_INCIDENT_LINE = "Memory-incident:";

/** The dedup key: the incident's start, whatever its kind became since. */
export function incidentKey(m: MemoryStatus): string | undefined {
  return m.incident?.since;
}

/** Incident keys already filed in the effort's tickets. */
export function filedIncidentKeys(paths: TrackerPaths): Set<string> {
  return filedKeys(paths, MEMORY_INCIDENT_LINE);
}

/** One incident, as the shared filing protocol needs it. */
interface DueIncident {
  /** The dedup key — also the value of the ticket's marker line. */
  key: string;
  /** When the incident started (ISO): it is due once older than `afterMs`. */
  since: string;
  /** The ticket's dedup line marker. */
  marker: string;
  /** What the operator lines call it. */
  noTrackerLine: string;
  failedLine: string;
  body: (id: string) => { name: string; content: string };
}

/**
 * The protocol both incident filers share: due once older than the
 * threshold, once per key (the memo, then the tickets on disk), said once
 * when no tracker is configured, retried after a failure no sooner than
 * `RETRY_AFTER_FAILURE_MS`, the FT id claimed by exclusive create. Never
 * throws.
 */
function fileIncidentOnce(
  paths: TrackerPaths | undefined,
  incident: DueIncident,
  opts: { now: Date; afterMs: number; memo: IncidentFilerMemo },
): IncidentFileOutcome {
  try {
    const { key } = incident;
    const started = Date.parse(incident.since);
    if (!Number.isFinite(started) || opts.now.getTime() - started < opts.afterMs)
      return { kind: "none" };
    if (opts.memo.filed.has(key)) return { kind: "already", key };
    if (!paths) {
      if (opts.memo.noTrackerSaid) return { kind: "none" };
      opts.memo.noTrackerSaid = true;
      return { kind: "no-tracker", line: incident.noTrackerLine };
    }
    if (
      opts.memo.failedAt !== undefined &&
      opts.now.getTime() - opts.memo.failedAt < RETRY_AFTER_FAILURE_MS
    )
      return { kind: "none" };
    if (filedKeys(paths, incident.marker).has(key)) {
      opts.memo.filed.add(key);
      return { kind: "already", key };
    }
    const ticketsDir = join(paths.root, "efforts", paths.effort, "tickets");
    mkdirSync(ticketsDir, { recursive: true });
    const id = claimNextId(
      paths.root,
      (n) => `efforts/${paths.effort}/tickets/${incident.body(n).name}`,
    );
    const { name, content } = incident.body(id);
    writeFileSync(join(ticketsDir, name), content);
    opts.memo.filed.add(key);
    delete opts.memo.failedAt;
    return { kind: "filed", ticketId: `FT-${id}`, file: name };
  } catch (err) {
    opts.memo.failedAt = opts.now.getTime();
    return {
      kind: "failed",
      line: `${incident.failedLine}: ${err instanceof Error ? err.message : String(err)}`,
    };
  }
}

/** The ticket, from the status block alone. Never carries a key: the block
 * holds credential verdicts, not credentials. */
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
this was filed. ${
    m.credentials.daemon?.result === "ok"
      ? "The daemon key works: daemon memory reads and learning writes remain available. Review sessions cannot use memory until their credentials recover."
      : m.credentials.sessions?.result === "ok"
        ? "The daemon cannot use memory for its reads and learning writes. Review sessions still have a working memory credential."
        : "Every round runs memory-less and nothing the reviewer learns is written until it is fixed."
  } Auto-filed by the TUI from the
daemon's status.json \`memory\` block — not from memory, which is the thing
that is down. Diagnose and fix the cause, then resolve with a note; the
board banner clears on its own once memory answers again.

${MEMORY_INCIDENT_LINE} ${since}

## What status.json said

- state: ${m.state} (since ${m.since})
- daemon key: ${credentialPhrase(m.credentials.daemon)}
- sessions' ovcli.conf: ${credentialPhrase(m.credentials.sessions)}
- last authenticated success: ${m.last_ok_at ?? "none since the daemon booted"}
- serving search: ${servingLine(m)}
- last error: ${err ? `${err.at} ${err.op} — ${err.status || "no answer"} ${err.code} ${err.message}` : "none recorded"}
- boot provisioning: ${prov ? `${prov.state}${prov.at ? ` (${prov.at})` : ""}${prov.errors && prov.errors.length > 0 ? ` — ${prov.errors.join("; ")}` : ""}` : "not read"}
- daemon requests since boot: ${requests || "none"}

## Where to look

- \`qcr status\` (the memory line) and the \`openviking\` + \`memory\` blocks of state/status.json
- an auth failure: the reviewer key in the secrets mount must be the key the
  server holds for user \`reviewer\` — docs/companion-memory-access.md (never
  rotate from a session)
- down: the supervisor's \`openviking\` block (running, ready, restarts,
  last_error), its \`embedder\` block — the local English embedder the server
  searches through (state, reason, ready, restarts, last_exit, last_error) —
  and the daemon log
`;
  return { name, content };
}

/** The `serving` block as one phrase — unknown when unmeasured, never "yes". */
function servingLine(m: MemoryStatus): string {
  const s = m.serving;
  if (s === undefined) return "not reported (this daemon predates the serving check)";
  if (s === null) return "UNKNOWN (not measured)";
  if (s.ok === false || s.since !== null)
    return `NO${s.since ? ` since ${s.since}` : ""}${s.reason ? ` — ${s.reason}` : ""}`;
  return s.ok ? "yes" : "UNKNOWN (not measured)";
}

export interface IncidentFilerMemo {
  /** Incident keys this process already knows are filed — saves a tickets
   * scan on every poll once filed. */
  filed: Set<string>;
  /** "no issue tracker configured" was said once already. */
  noTrackerSaid: boolean;
  /** When the last attempt failed (ms) — a broken tracker is retried every
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
  if (!opts.fresh || !memory || !memory.enabled) return { kind: "none" };
  if (memory.state !== "auth_failed" && memory.state !== "down") return { kind: "none" };
  const key = incidentKey(memory);
  if (key === undefined) return { kind: "none" };
  return fileIncidentOnce(
    paths,
    {
      key,
      since: key,
      marker: MEMORY_INCIDENT_LINE,
      noTrackerLine: `memory incident since ${key} is past the ticket threshold, but no wayfinder tracker is configured ([sink] kind) — not filed; the board banner stands`,
      failedLine: "memory incident ticket could not be filed",
      body: (id) => incidentTicketBody(id, memory, paths!, opts.now),
    },
    opts,
  );
}

// ---- an EOD curation that did not reach memory → one ticket ---------------
//
// The learner's two failures — no curation receipt (`missing`), and lessons
// the curator adopted or tried to write that memory does not hold
// (`not_persisted`) — are overseer wakes, and the same person-facing path as
// a memory incident carries them too: the board banner, the desktop
// notification, `qcr status`, the companion's view, and this ticket. The
// daemon keeps a failure in status.json `memory.curation.unresolved` until
// something made it good (a later receipt; the candidate decided), and names
// the oldest as the `incident`: one ticket per incident, keyed by its state and day, once it is
// older than the same `incident_ticket_after_min`. A run of missed days is one
// incident (its oldest day stays the key until a receipt resolves the run).

export const CURATION_INCIDENT_LINE = "Curation-incident:";

/** The dedup key: the oldest unresolved failure's state and day. */
export function curationIncidentKey(c: CurationStatus | null | undefined): string | undefined {
  const i = c?.incident;
  return i ? `${i.state} ${i.day}` : undefined;
}

export function curationTicketBody(
  id: string,
  c: CurationStatus,
  paths: TrackerPaths,
  now: Date,
): { name: string; content: string } {
  const i = c.incident!;
  const missing = i.state === "missing";
  const name = `FT-${id}-eod-curation-${missing ? "missing" : "lessons-not-persisted"}.md`;
  const nowIso = now.toISOString();
  const age = fmtDuration(now.getTime() - Date.parse(i.since));
  const what = missing
    ? `the EOD sweep for ${i.day} was delivered, its outcomes packet offered ${i.count} lesson candidate(s), and no \`eod-curation-receipt\` came back — nothing says the day's human outcomes were curated`
    : `${i.count} lesson(s) from the ${i.day} curation are not in reviewer memory — a write the curator reported refused, or an adoption no typed lesson header cites (\`cand:c<id>\`)`;
  const unresolved = (c.unresolved ?? [])
    .map((u) => `${u.day} ${u.state.replace("_", " ")} (${u.count}, since ${u.since})`)
    .join("; ");
  const content = `# EOD curation ${missing ? `missing since ${i.day}` : `lessons not persisted (${i.day})`}

Id: FT-${id}
Effort: ${paths.effort}
Type: impl
Status: open
Role: —
Category: —
Labels: review-ops, auto-filed, memory, learner
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

The learner's EOD curation did not reach reviewer memory: ${what}.
Unresolved since ${i.since} — ${age} when this was filed. The overseer was
woken; this ticket is the person half. Auto-filed by the TUI from the
daemon's status.json \`memory.curation\` block. Find out why the curation did
not land, make it good (curate the packet and write the receipt, or get the
lessons written), then resolve with a note; the board banner clears on its
own once nothing is unresolved.

${CURATION_INCIDENT_LINE} ${i.state} ${i.day}

## What status.json said

- reported: ${c.day ?? "?"} ${c.state.replace("_", " ")} — ${c.offered} offered, ${c.adopted} adopted, ${c.declined} declined, ${c.verifying} verifying, ${c.not_persisted} not persisted
- unresolved: ${unresolved || "none listed"}
- candidates undecided: ${c.open} offered, ${c.queued} queued
- lessons in force: ${c.balance ? `look-for:dont-raise ${c.balance.look_for}:${c.balance.dont_raise} as of ${c.balance.as_of}` : "UNKNOWN (memory not read)"}

## Where to look

- \`qcr lessons\` and \`qcr status\` (the memory line: a refused write is
  usually memory refusing — its health is on the same line)
- the outcomes packet \`state/eod/${i.day}/outcomes.md\` and the overseer session
  the EOD sweep ran in
- the daemon's \`eod_curation_missing\` / \`eod_lessons_not_persisted\` anomalies
`;
  return { name, content };
}

/**
 * File the curation incident when it is due, once — the same tracker, actor,
 * memo shape and failure handling as `maybeFileMemoryIncident`. Use its own
 * memo: the two kinds of incident are keyed apart.
 */
export function maybeFileCurationIncident(
  paths: TrackerPaths | undefined,
  memory: MemoryStatus | undefined,
  opts: { fresh: boolean; now: Date; afterMs: number; memo: IncidentFilerMemo },
): IncidentFileOutcome {
  if (!opts.fresh || !memory) return { kind: "none" };
  const c = memory.curation;
  const key = curationIncidentKey(c);
  if (!c || key === undefined) return { kind: "none" };
  return fileIncidentOnce(
    paths,
    {
      key,
      since: c.incident!.since,
      marker: CURATION_INCIDENT_LINE,
      noTrackerLine: `EOD curation incident (${key}) is past the ticket threshold, but no wayfinder tracker is configured ([sink] kind) — not filed; the board banner stands`,
      failedLine: "EOD curation incident ticket could not be filed",
      body: (id) => curationTicketBody(id, c, paths!, opts.now),
    },
    opts,
  );
}
