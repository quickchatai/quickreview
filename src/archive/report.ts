import { STORE_LABELS } from "./status.js";
import { archivedEventTotal } from "./rows.js";
// `qcr archive status [--plan]` (docs/archiving.md §11): the
// archiver's block as the daemon published it, the archive ledger, the
// policy every `[archive]` knob sets — and, with --plan, the plan detail:
// per-artifact counts and bytes, every held PR with its reason, the orphans.
// Read-only: it renders, it moves nothing.
import { readFileSync } from "node:fs";
import type { StateStore } from "../state.js";
import type { ArchivePolicy } from "./archiver.js";
import { ARTIFACT_CLASSES, type ArchivePlan } from "./plan.js";
import {
  archiveStatusLine,
  fmtBytes,
  fmtCount,
  readArchiveStatus,
  storePhrase,
  type ArchiveStatusRead,
} from "./status.js";

export interface ArchiveLedgerSummary {
  /** `archive_prs` rows by state. */
  by_state: Record<string, number>;
  /** Event rows moved to the archive DB, all time. */
  archived_event_rows: number;
  /** The mover's watermarks, as recorded (absent = nothing moved). */
  marks: Record<string, unknown>;
}

/** The archive ledger in live state.db — small tables, read whole. */
export function archiveLedgerSummary(store: StateStore): ArchiveLedgerSummary {
  const by_state: Record<string, number> = {};
  for (const r of store.db
    .prepare("SELECT state, COUNT(*) AS n FROM archive_prs GROUP BY state")
    .all() as Array<{ state: string; n: number }>)
    by_state[r.state] = r.n;
  const marks: Record<string, unknown> = {};
  for (const r of store.db
    .prepare("SELECT name, value FROM archive_marks ORDER BY name")
    .all() as Array<{
    name: string;
    value: unknown;
  }>)
    marks[r.name] = r.value;
  return { by_state, archived_event_rows: archivedEventTotal(store), marks };
}

const pad = (s: string, n: number): string => (s.length >= n ? s : s + " ".repeat(n - s.length));

export function policyLine(p: ArchivePolicy): string {
  return (
    `policy: mode ${p.mode} · files and deliveries after ${p.afterDays} d · events after ${p.eventsAfterDays} d · ` +
    `every ${p.intervalMs / 1000} s · start delay ${p.startDelayMs / 60_000} min · tick budget ${p.tickBudgetMs / 1000} s · ` +
    `≤ ${p.maxPrsPerTick} PR(s)/tick · ≤ ${fmtBytes(p.maxBytesPerS)}/s · headroom ${fmtBytes(p.diskHeadroomBytes)} · ` +
    `DB batch ${p.dbBatchRows} rows · gzip ${p.gzipLevel}`
  );
}

function planLines(plan: ArchivePlan): string[] {
  const out: string[] = [];
  const r = plan.registry;
  out.push(
    `plan (computed here at ${plan.computed_at}, took ${plan.took_ms} ms, longest synchronous span ${plan.max_sync_span_ms} ms):`,
  );
  out.push(
    `  registry: ${r.prs} PR(s) — ${r.open} open, ${r.closed} closed: ${r.waiting} inside the ${plan.after_days}-day window, ` +
      `${r.eligible} eligible, ${r.held} held${r.archived ? `, ${r.archived} archived already` : ""}`,
  );
  out.push(
    `  backlog: ${plan.backlog.prs} PR(s) · ${fmtBytes(plan.backlog.bytes)} · ` +
      `${fmtCount(plan.backlog.event_rows)} event row(s) older than ${plan.events.cutoff} · ` +
      `${fmtCount(plan.backlog.delivery_rows)} delivery row(s) older than ${plan.deliveries.cutoff}`,
  );
  out.push(`  artifacts over ${plan.candidates.length} PR(s) with live files:`);
  for (const cls of ARTIFACT_CLASSES) {
    const t = plan.artifacts[cls];
    out.push(`    ${pad(cls, 18)} ${pad(String(t.files), 8)} file(s)  ${fmtBytes(t.bytes)}`);
  }
  out.push(
    `  kept live, snapshotted: ${plan.ledger_snapshots.files} ledger(s), ${fmtBytes(plan.ledger_snapshots.bytes)}`,
  );
  out.push(
    `  legacy archive/pr-<n>/session.jsonl copies to check as duplicates: ${plan.legacy_copies.files}, ${fmtBytes(plan.legacy_copies.bytes)}`,
  );
  if (plan.unclassified && plan.unclassified.files > 0)
    out.push(
      `  KEPT LIVE, no class claims them: ${plan.unclassified.files} state/pr-<n>-* file(s) of eligible PRs, ${fmtBytes(plan.unclassified.bytes)} — ` +
        `${plan.unclassified.first.join(", ")}${plan.unclassified.files > plan.unclassified.first.length ? ", …" : ""}`,
    );
  if (plan.empty.length > 0)
    out.push(
      `  ${plan.empty.length} eligible PR(s) with nothing live to move (a zero-file archived row each)`,
    );
  const kinds = Object.entries(plan.events.by_kind ?? {}).sort((a, b) => b[1] - a[1]);
  out.push(
    `  events by kind: ${kinds.length > 0 ? kinds.map(([k, n]) => `${k} ${n}`).join(" · ") : "none"} ` +
      `(examined ${plan.events.examined} row(s) in ${plan.events.windows} window(s) after id ${plan.events.from_id})`,
  );
  out.push(
    `  deliveries: examined ${plan.deliveries.examined} row(s) in ${plan.deliveries.windows} window(s) after rowid ${plan.deliveries.from_id}`,
  );
  out.push(
    `  held (${plan.held.length}): ${plan.held.length > 0 ? plan.held.map((h) => `#${h.pr} ${h.reasons.join("+")}${h.detail ? ` (${h.detail})` : ""}`).join(", ") : "none"}`,
  );
  out.push(
    `  orphans — pi-sessions dirs with no registry row, never touched (${plan.orphans.length}): ${plan.orphans.length > 0 ? plan.orphans.join(", ") : "none"}`,
  );
  out.push(
    `  tmux: ${plan.tmux === "answered" ? "answered" : "UNKNOWN — could not be asked; every candidate is held tmux_unknown"}`,
  );
  if (!plan.births_observed)
    out.push(
      "  session births: not visible from a CLI process — the daemon re-checks them before anything moves",
    );
  out.push(
    `  archive/ and state/ on one device: ${plan.same_device === null ? "UNKNOWN" : plan.same_device ? "yes" : "no"}`,
  );
  if (plan.stores) {
    out.push(
      `  ${STORE_LABELS.overseer}: ${storeTallyPhrase(plan.stores.overseer, "the overseer's birth is not visible from a CLI process")}`,
    );
    out.push(
      `  ${STORE_LABELS.pi_global}: ${plan.stores.pi_global ? storeTallyPhrase(plan.stores.pi_global, "unknown") : "not measured"}`,
    );
  }
  return out;
}

/** A store's tally as the plan reports it; never a guessed 0. */
function storeTallyPhrase(t: import("./storepass.js").StoreTally, movableUnknown: string): string {
  if (t.state === "unreadable") return `UNREADABLE (${t.error})`;
  const movable =
    t.movable_files === null || t.movable_bytes === null
      ? `movable UNKNOWN (${movableUnknown})`
      : `${t.movable_files} movable, ${fmtBytes(t.movable_bytes)}`;
  const legacy =
    t.legacy_copies > 0
      ? `; legacy rotation copies to check: ${t.legacy_copies}, ${fmtBytes(t.legacy_bytes)}`
      : "";
  return `${t.files} file(s), ${fmtBytes(t.bytes)} live — ${movable}${legacy}`;
}

/** The whole report, as `qcr archive status` prints it. */
export function renderArchiveReport(input: {
  block: unknown;
  statusNote: string | null;
  ledger: ArchiveLedgerSummary;
  policy: ArchivePolicy;
  plan: ArchivePlan | null;
}): string {
  const lines: string[] = [];
  lines.push(input.statusNote ? `archive: ${input.statusNote}` : archiveStatusLine(input.block));
  const read = readArchiveStatus(input.block);
  if (read.kind === "read") {
    const s = read.view;
    if (s.last_tick_at)
      lines.push(`last tick ${s.last_tick_at}; last success ${s.last_success_at ?? "never"}`);
    lines.push(
      s.disk
        ? `disk: archive free ${fmtBytes(s.disk.archive_free)}, state free ${fmtBytes(s.disk.state_free)}, headroom ${fmtBytes(s.disk.headroom)}`
        : "disk: UNKNOWN (not checked yet, or statfs failed)",
    );
    if (s.held_prs && s.held_prs.count > 0)
      lines.push(
        `held PRs (${s.held_prs.count}): ${s.held_prs.first.map((h) => `#${h.pr} ${h.reason}`).join(", ")}${s.held_prs.count > s.held_prs.first.length ? ", …" : ""}`,
      );
    if (s.max_sync_span_ms !== null)
      lines.push(`longest synchronous span: ${s.max_sync_span_ms} ms`);
    if (s.freelist_pages !== null) lines.push(`state.db free pages: ${s.freelist_pages}`);
    // The stores that belong to no PR: each one's last pass, or that it
    // has not run (plan mode, not wired, or an older daemon).
    for (const [label, st] of [
      [STORE_LABELS.overseer, s.stores?.overseer ?? null],
      [STORE_LABELS.pi_global, s.stores?.pi_global ?? null],
    ] as const)
      lines.push(storePhrase(label, st) || `${label}: no pass yet`);
  }
  lines.push(policyLine(input.policy));
  const states = Object.entries(input.ledger.by_state);
  lines.push(
    `ledger: archive_prs ${states.length > 0 ? states.map(([k, n]) => `${k} ${n}`).join(", ") : "empty"}; ` +
      `archived event rows ${input.ledger.archived_event_rows}`,
  );
  if (input.plan) lines.push(...planLines(input.plan));
  return lines.join("\n");
}

/** The note `qcr archive status` gives a status.json with no `archive` key. */
export const NO_ARCHIVE_BLOCK_NOTE =
  "status.json carries no archive block — the daemon predates it";

/**
 * status.json's `archive` block as `qcr archive status` reads it — total:
 * the raw block (undefined when there is none), a note saying why when there
 * is no file or it cannot be parsed, and the reader's own verdict (no file =
 * `absent`, an unparsable file = `unreadable`, else `readArchiveStatus`).
 */
export function readArchiveBlockFile(statusPath: string): {
  block: unknown;
  statusNote: string | null;
  archiveRead: ArchiveStatusRead;
} {
  const unreadable = (cause: string) => {
    const why = `status.json is unreadable: ${cause}`;
    return { block: undefined, statusNote: why, archiveRead: { kind: "unreadable", why } as const };
  };
  let text: string;
  try {
    text = readFileSync(statusPath, "utf8");
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== "ENOENT") return unreadable(String(err));
    return {
      block: undefined,
      statusNote: "no status.json yet — is the daemon running?",
      archiveRead: { kind: "absent" },
    };
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch (err) {
    return unreadable(String(err));
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed))
    return unreadable("not a JSON object");
  const block = (parsed as { archive?: unknown }).archive;
  return { block, statusNote: null, archiveRead: readArchiveStatus(block) };
}

/**
 * `qcr archive status --json`. `archive` is the block as published (null when
 * there is none); `archive_read` is the reader's verdict — `absent`,
 * `unreadable` (with why) or `read` — so a consumer never has to guess what a
 * null stood for, and `status_note` says why when the block is absent.
 */
export function archiveStatusJson(input: {
  block: unknown;
  archiveRead: ArchiveStatusRead;
  statusNote: string | null;
  ledger: ArchiveLedgerSummary;
  policy: ArchivePolicy;
  plan: ArchivePlan | null;
}): Record<string, unknown> {
  const r = input.archiveRead;
  return {
    archive: input.block === undefined ? null : input.block,
    archive_read: r.kind === "unreadable" ? { kind: r.kind, why: r.why } : { kind: r.kind },
    status_note: input.statusNote ?? (r.kind === "absent" ? NO_ARCHIVE_BLOCK_NOTE : null),
    ledger: input.ledger,
    policy: input.policy,
    plan: input.plan,
  };
}
