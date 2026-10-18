// SCAN TRIAGE and SCAN MEMORY (setup & scan spec "Findings" and
// "Scan memory"). The companion judges — which finding is a real problem,
// which effort it belongs in, what recurs across the repo — and these rules
// act on its answers, deterministically:
//
//   * DISMISS with a reason: the finding is `dismissed` (it stays dismissed
//     across re-scans, findings.ts) and an UNPINNED `#scan kind=dismissal`
//     note goes to reviewer memory, so PR rounds stop raising it. A note that
//     could not be written is recorded on the finding and retried by the next
//     dismiss of it — a note memory refused never blocks the dismissal.
//   * PROMOTE: one ticket per finding, filed through the tracker sink
//     (trackersink.ts — the issue tracker in the effort the companion picked,
//     or a markdown file without one), stamped with the fingerprint. NEVER
//     TWICE: a finding with a ticket record is never filed again (a matched,
//     fixed-then-returned or re-dismissed-then-promoted finding keeps its
//     record); the sink's fingerprint stamp is the backstop.
//   * CLOSE ON FIXED: a promoted finding a re-scan found `fixed` has its
//     ticket closed with the scan's sha. It runs at the end of every scan run
//     and after every match answer; a close the sink refused (a claimed
//     ticket, a held lock) stays pending and the next one retries it.
//   * SCAN MEMORY: recurring PATTERNS and per-unit HOTSPOTS as unpinned
//     `#scan` entries, APPENDED (never retiring — the EOD curator merges),
//     capped per scan — the runs at one sha — at `MAX_PATTERNS_PER_SCAN`
//     patterns and one hotspot per unit, the cap counted in
//     `<state home>/scan/memory.json` so it holds across calls. INDIVIDUAL
//     FINDINGS NEVER BECOME MEMORY: a pattern must name how many times it
//     recurs (at least twice), and text that anchors to one line, quotes a
//     stored finding's claim or carries its fingerprint is refused.
//
// Every header is written HERE from values the engine owns; the companion's
// text only ever follows the em dash, which ends the header scan
// (eventtags.ts), and its own `#word`s are de-hashed — so nothing it writes
// can pin itself or forge a tag. Never `#pinned`: the scan writes no pinned
// memory (spec, out of scope).
import { createHash } from "node:crypto";
import { dehash, formatEventTags } from "../memory/eventtags.js";
import type { MemoryStore } from "../memory/store.js";
import type { Refusal, StateFs, TrackerSink, TrackerTicket } from "./engine.js";
import { goneDismissal, settled, type FindingsStore, type ScanFinding } from "./findings.js";
import { DISMISS_REASON_MAX, validityOf } from "./scanreport.js";

export const SCAN_TAG = "scan";
export const SCAN_MEMORY_FILE = "scan/memory.json";
export const SCAN_MEMORY_VERSION = 1;

/** Patterns one scan (the runs at one sha) may write. One scan writes one
 * hotspot per unit: the cap record holds one per unit name. */
export const MAX_PATTERNS_PER_SCAN = 20;

export const MEMORY_TEXT_MAX = 400;
export const REASON_MAX = DISMISS_REASON_MAX;
export const TITLE_MAX = 120;
export const NOTE_MAX = 2000;
/** A claim this short is too generic to count as quoted. */
const QUOTE_MIN = 24;

const clean = (err: unknown): string => (err instanceof Error ? err.message : String(err));

/** One `k=v` value: no whitespace (it would end the header). */
const tagValue = (v: string): string => v.trim().replace(/\s+/g, "_") || "-";

const oneLine = (text: string): string => text.replace(/\s+/g, " ").trim();

const where = (f: ScanFinding): string =>
  `${f.path}:${f.start === f.end ? f.start : `${f.start}-${f.end}`}`;

// ---- memory spellings -------------------------------------------------------------

/** The dismissal note: what was dismissed and why, for PR rounds to read. */
export function dismissalMemoryText(f: ScanFinding, reason: string): string {
  const tags = {
    kind: "dismissal",
    lens: tagValue(f.lens),
    finding: tagValue(f.kind),
    unit: tagValue(f.unit),
  };
  const body =
    `Not a problem here (the operator dismissed a scan finding in ${where(f)}): ` +
    `"${oneLine(f.claim)}". Reason: ${oneLine(reason)}`;
  return `#${SCAN_TAG} ${formatEventTags(tags)} — ${dehash(body)}`;
}

export function patternMemoryText(p: { text: string; occurrences: number }, sha: string): string {
  const tags = { kind: "pattern", occurrences: String(p.occurrences), sha: sha.slice(0, 12) };
  return `#${SCAN_TAG} ${formatEventTags(tags)} — ${dehash(oneLine(p.text))}`;
}

export function hotspotMemoryText(h: { unit: string; text: string }, sha: string): string {
  const tags = { kind: "hotspot", unit: tagValue(h.unit), sha: sha.slice(0, 12) };
  return `#${SCAN_TAG} ${formatEventTags(tags)} — ${dehash(oneLine(h.text))}`;
}

// ---- the ticket ------------------------------------------------------------------

/** The skeptic's tier as a ticket states it — `unknown` never guessed. */
function validityLine(f: ScanFinding): string {
  const v = validityOf(f);
  if (v === "unknown") return "unknown — no skeptic judged it";
  if (v === "doubtful") return `doubtful${f.doubt?.class ? ` (${f.doubt.class})` : ""}`;
  return `${v}${f.scenario ? ` — ${oneLine(f.scenario)}` : ""}`;
}

/** The ticket a promoted finding becomes. The body is rendered from the
 * stored finding; the companion adds at most a title and a note. */
export function findingTicket(
  f: ScanFinding,
  effort: string,
  extra: { title?: string; note?: string } = {},
): TrackerTicket {
  const title = extra.title?.trim() || `[${f.severity}] ${oneLine(f.claim)}`;
  const body = [
    "## Scan finding",
    "",
    `A whole-repo scan (${(f.lenses?.length ?? 0) > 1 ? `lenses ${f.lenses!.map((l) => `\`${l}\``).join(", ")}` : `lens \`${f.lens}\``}, unit \`${f.unit}\`) reported this at \`${where(f)}\`, ` +
      `first at ${f.first_seen.sha.slice(0, 12)}, last at ${f.last_seen.sha.slice(0, 12)} (${f.seen} scan(s)). ` +
      "The companion promoted it; a re-scan that no longer reports it closes this ticket with its sha.",
    "",
    `- **Severity:** ${f.severity}${f.confidence !== null ? ` (confidence ${f.confidence})` : ""}`,
    `- **Kind:** ${f.kind}`,
    `- **Validated:** ${f.doubt ? `MAY NOT BE VALID — ${f.doubt.word}: ${oneLine(f.doubt.reason)}` : f.validated ? "yes" : "no validator looked at it"}`,
    `- **Validity:** ${validityLine(f)}`,
    "",
    `**Claim.** ${oneLine(f.claim)}`,
    ...(f.evidence ? ["", `**Evidence.** ${f.evidence.trim()}`] : []),
    ...(f.detail ? ["", `**Detail.** ${f.detail.trim()}`] : []),
    ...(f.fix ? ["", `**Suggested fix.** ${f.fix.trim()}`] : []),
    ...(extra.note?.trim() ? ["", "## Companion's note", "", extra.note.trim()] : []),
  ].join("\n");
  return {
    title: title.length > TITLE_MAX ? `${title.slice(0, TITLE_MAX - 1).trimEnd()}…` : title,
    body,
    effort,
    fingerprint: f.fingerprint,
    aliases: f.aliases ?? [],
    category:
      f.severity === "P0" || f.severity === "P1" || f.severity === "P2" ? "bug" : "enhancement",
  };
}

// ---- the scan memory ledger -------------------------------------------------------

type PendingScanNote =
  | { kind: "pattern"; text: string; occurrences: number; at: string }
  | { kind: "hotspot"; unit: string; text: string; at: string };

export interface ScanMemoryRecord {
  run: string;
  /** Durable reservation until both the named note and its cap count land. */
  pending?: PendingScanNote;
  patterns: Array<{ text: string; occurrences: number; at: string }>;
  hotspots: Record<string, { text: string; at: string }>;
}

export interface ScanMemoryFile {
  version: number;
  /** Keyed by the scan's full sha. */
  scans: Record<string, ScanMemoryRecord>;
}

export function readScanMemory(state: StateFs): { file: ScanMemoryFile; error: string | null } {
  const empty: ScanMemoryFile = { version: SCAN_MEMORY_VERSION, scans: {} };
  let text: string | null;
  try {
    text = state.read(SCAN_MEMORY_FILE);
  } catch (err) {
    return { file: empty, error: `${SCAN_MEMORY_FILE} cannot be read: ${clean(err)}` };
  }
  if (text === null) return { file: empty, error: null };
  try {
    const raw = JSON.parse(text) as Partial<ScanMemoryFile> | null;
    if (
      typeof raw !== "object" ||
      raw === null ||
      raw.version !== SCAN_MEMORY_VERSION ||
      typeof raw.scans !== "object" ||
      raw.scans === null
    ) {
      throw new Error("not a version-1 scan memory record");
    }
    return {
      file: { version: SCAN_MEMORY_VERSION, scans: raw.scans },
      error: null,
    };
  } catch (err) {
    return {
      file: empty,
      error: `${SCAN_MEMORY_FILE} is not a record this version reads (${clean(err)}) — nothing will overwrite it; move it aside to start over`,
    };
  }
}

// ---- the engine ------------------------------------------------------------------

/** A finished scan run the memory may be written for. */
export interface ScanRunRef {
  id: string;
  sha: string;
  state: string;
}

export interface TriagePorts {
  findings: FindingsStore;
  state: StateFs;
  memory: MemoryStore | null;
  tracker: TrackerSink;
  clock: () => Date;
  /** The saved unit cut's unit names, or null when none is saved. */
  units: () => string[] | null;
  /** The scan runs this state home knows, newest first. */
  runs: () => ScanRunRef[];
}

export type DismissResult =
  | { ok: true; finding: ScanFinding; memory: "written" | { problem: string }; again: boolean }
  | Refusal;

export type PromoteResult =
  | {
      ok: true;
      finding: ScanFinding;
      ref: string;
      sink: string;
      existing: boolean;
      closed: ClosedTicket | null;
    }
  | Refusal;

type ClosedTicket = NonNullable<NonNullable<ScanFinding["ticket"]>["closed"]>;

export interface CloseFixedResult {
  closed: Array<{ fingerprint: string; ref: string; sha: string }>;
  /** Closes the sink refused — each stays pending for the next attempt. */
  problems: string[];
}

export interface ScanMemoryRequest {
  run?: unknown;
  patterns?: unknown;
  hotspots?: unknown;
}

export type ScanMemoryResult =
  | {
      ok: true;
      sha: string;
      run: string;
      written: { patterns: number; hotspots: number };
      problems: string[];
      left: { patterns: number; units_without_hotspot: string[] };
    }
  | Refusal;

export class ScanTriage {
  constructor(private readonly ports: TriagePorts) {}

  private async note(text: string): Promise<"written" | { problem: string; uncertain?: true }> {
    const memory = this.ports.memory;
    if (memory === null) return { problem: "no reviewer memory in this assembly" };
    try {
      if (memory.ensureWritable) {
        const ready = await memory.ensureWritable();
        if (!ready.ok) return { problem: `reviewer memory is not writable: ${ready.message}` };
      }
      const name = `scan-${createHash("sha256").update(text).digest("hex").slice(0, 32)}`;
      const r = await memory.apply({ op: "note", text, name });
      return r.ok ? "written" : { problem: r.message };
    } catch (err) {
      return { problem: `memory unreachable: ${clean(err)}`, uncertain: true };
    }
  }

  /**
   * Dismiss a finding with the operator's reason. Refused for a promoted
   * finding (its ticket is where it is settled) and a fixed one. A finding
   * already dismissed may be dismissed again: the reason is replaced, and a
   * memory note that was not written is retried.
   */
  async dismiss(args: { fingerprint?: unknown; reason?: unknown }): Promise<DismissResult> {
    const reason = typeof args.reason === "string" ? oneLine(args.reason) : "";
    if (reason === "")
      return {
        ok: false,
        errors: ["a dismissal needs the operator's reason — it is what PR rounds will read"],
      };
    if (reason.length > REASON_MAX)
      return {
        ok: false,
        errors: [`the reason is at most ${REASON_MAX} characters (got ${reason.length})`],
      };
    if (typeof args.fingerprint !== "string")
      return { ok: false, errors: ["`fingerprint` is required"] };
    const found = this.ports.findings.find(args.fingerprint);
    if (!found.ok) return found;
    const f = found.finding;
    if (f.state === "promoted") {
      return {
        ok: false,
        errors: [
          `${f.fingerprint.slice(0, 12)} is promoted (${f.ticket?.ref ?? "no ticket"}) — settle it on its ticket, not by a dismissal`,
        ],
      };
    }
    if (f.state === "fixed")
      return {
        ok: false,
        errors: [`${f.fingerprint.slice(0, 12)} is already fixed — nothing to dismiss`],
      };
    const again = f.state === "dismissed";
    const sameReason = again && f.dismissal?.reason === reason;
    // The memory note is written once per reason: a repeat with the same
    // reason only retries a note that did not land.
    const memory =
      sameReason && f.dismissal?.memory === "written"
        ? "written"
        : await this.note(dismissalMemoryText(f, reason));
    const at = this.ports.clock().toISOString();
    const saved = this.ports.findings.update(f.fingerprint, (cur) =>
      cur.state === "new" || cur.state === "dismissed"
        ? { ...cur, state: "dismissed", dismissal: { reason, at, memory } }
        : `${cur.fingerprint.slice(0, 12)} became ${cur.state} meanwhile — list the findings again`,
    );
    if (!saved.ok) return saved;
    return { ok: true, finding: saved.finding, memory, again };
  }

  /**
   * Promote a finding: file its ticket in `effort` (the companion's pick),
   * unless it has one already — then it is promoted onto that ticket and
   * nothing is filed. Refused for a fixed finding; a dismissed one may be
   * promoted (the operator changed their mind). Promotion DEFAULTS TO
   * CONFIRMED findings (the scan validator is the skeptic): a likely,
   * doubtful or unjudged one is refused unless
   * `unconfirmed: true` says the operator asked for it explicitly.
   */
  async promote(args: {
    fingerprint?: unknown;
    effort?: unknown;
    title?: unknown;
    note?: unknown;
    unconfirmed?: unknown;
  }): Promise<PromoteResult> {
    if (typeof args.fingerprint !== "string")
      return { ok: false, errors: ["`fingerprint` is required"] };
    const found = this.ports.findings.find(args.fingerprint);
    if (!found.ok) return found;
    const f = found.finding;
    if (f.state === "fixed") {
      return {
        ok: false,
        errors: [
          `${f.fingerprint.slice(0, 12)} is fixed (at ${f.fixed?.sha.slice(0, 12) ?? "?"}) — nothing to file`,
        ],
      };
    }
    // A dismissal a re-scan no longer reports (findings.ts: sticky, stamped
    // `unreported`) is out of play as a fixed one is: nothing to file —
    // the ticket would close at the next scan. It is back in play once a
    // scan reports it again.
    if (goneDismissal(f)) {
      return {
        ok: false,
        errors: [
          `${f.fingerprint.slice(0, 12)} is dismissed and no longer reported (at ${f.unreported!.sha.slice(0, 12)}) — nothing to file`,
        ],
      };
    }
    const validity = validityOf(f);
    if (validity !== "confirmed" && args.unconfirmed !== true) {
      return {
        ok: false,
        errors: [
          `${f.fingerprint.slice(0, 12)} is ${validity === "unknown" ? "not judged by the skeptic (validity unknown)" : validity}, not confirmed — ` +
            "promotion defaults to confirmed findings; promote it only on the operator's explicit word, with `unconfirmed: true`",
        ],
      };
    }
    const at = this.ports.clock().toISOString();
    if (f.ticket) {
      // Never twice: back onto the ticket it already has.
      const ticket = f.ticket;
      // A ticket closed as fixed that the operator promotes again is this
      // episode's ticket again (reopened by hand): its closure is history,
      // or the next fix would never close it.
      const saved = this.ports.findings.update(f.fingerprint, (cur) =>
        settled(cur)
          ? "it became fixed, or no longer reported, meanwhile"
          : {
              ...cur,
              state: "promoted",
              ...(cur.ticket ? { ticket: { ...cur.ticket, closed: null } } : {}),
            },
      );
      if (!saved.ok) return saved;
      return {
        ok: true,
        finding: saved.finding,
        ref: ticket.ref,
        sink: ticket.sink,
        existing: true,
        closed: ticket.closed ?? null,
      };
    }
    const effort = typeof args.effort === "string" ? args.effort.trim() : "";
    if (effort === "")
      return {
        ok: false,
        errors: ["`effort` is required — the tracker effort this finding's work belongs in"],
      };
    const title = typeof args.title === "string" ? oneLine(args.title) : undefined;
    if (title !== undefined && (title === "" || title.length > TITLE_MAX))
      return { ok: false, errors: [`a title is 1..${TITLE_MAX} characters, one line`] };
    const note = typeof args.note === "string" ? args.note.trim() : undefined;
    if (note !== undefined && note.length > NOTE_MAX)
      return { ok: false, errors: [`the note is at most ${NOTE_MAX} characters`] };
    const filed = await this.ports.tracker.file(
      findingTicket(f, effort, { ...(title ? { title } : {}), ...(note ? { note } : {}) }),
    );
    if (!filed.ok) return { ok: false, errors: [filed.reason] };
    const ticket = {
      sink: this.ports.tracker.kind,
      ref: filed.ref,
      effort,
      filed_at: at,
      closed: null,
    };
    const saved = this.ports.findings.update(f.fingerprint, (cur) =>
      settled(cur)
        ? `it became fixed, or no longer reported, meanwhile — ${filed.ref} was filed; close it by hand`
        : { ...cur, state: "promoted", ticket },
    );
    if (!saved.ok) return saved;
    return {
      ok: true,
      finding: saved.finding,
      ref: filed.ref,
      sink: ticket.sink,
      existing: filed.existing === true,
      closed: null,
    };
  }

  /**
   * Close the ticket of every promoted finding a re-scan found fixed, with
   * the scan's sha. Idempotent: a closed ticket is recorded and never closed
   * again; a refused close stays pending.
   */
  async closeFixed(): Promise<CloseFixedResult> {
    const out: CloseFixedResult = { closed: [], problems: [] };
    const { findings, error } = this.ports.findings.load();
    if (error !== null) return { closed: [], problems: [error] };
    // Still the finding the snapshot showed: fixed from promoted by the same
    // run, its ticket the same and open. A background scan may report it
    // again while an earlier close is awaited.
    const stillFixed = (cur: ScanFinding | undefined, f: ScanFinding): boolean =>
      cur !== undefined &&
      cur.state === "fixed" &&
      cur.fixed?.from === "promoted" &&
      cur.fixed.run === f.fixed?.run &&
      cur.ticket?.ref === f.ticket?.ref &&
      !cur.ticket?.closed;
    for (const f of findings) {
      const t = f.ticket;
      if (f.state !== "fixed" || f.fixed?.from !== "promoted" || !t || t.closed) continue;
      const now = this.ports.findings.load();
      if (now.error !== null) {
        out.problems.push(
          `${t.ref} not closed: the findings store could not be re-read — ${now.error}`,
        );
        continue;
      }
      if (
        !stillFixed(
          now.findings.find((x) => x.fingerprint === f.fingerprint),
          f,
        )
      )
        continue;
      if (t.sink !== this.ports.tracker.kind) {
        out.problems.push(
          `${t.ref} was filed on the ${t.sink} sink, which this companion does not have — close it by hand`,
        );
        continue;
      }
      const fixed = f.fixed;
      const note =
        `A scan at ${fixed.sha} (run ${fixed.run}) no longer reports this finding ` +
        `(fingerprint ${f.fingerprint.slice(0, 12)}, ${where(f)}) — closed as fixed by the companion.`;
      const r = await this.ports.tracker.close(t.ref, note);
      if (!r.ok) {
        out.problems.push(`${t.ref}: ${r.reason}`);
        continue;
      }
      const closed = { at: this.ports.clock().toISOString(), sha: fixed.sha, run: fixed.run };
      const saved = this.ports.findings.update(f.fingerprint, (cur) =>
        stillFixed(cur, f)
          ? { ...cur, ticket: { ...cur.ticket!, closed } }
          : "it was reported again while its ticket closed — reopen the ticket by hand",
      );
      if (!saved.ok)
        out.problems.push(`${t.ref} was closed but not recorded: ${saved.errors.join("; ")}`);
      else out.closed.push({ fingerprint: f.fingerprint, ref: t.ref, sha: fixed.sha });
    }
    return out;
  }

  /** What `scan_memory` would still accept for a run (the cap's view). */
  memoryStatus(
    run?: string,
  ): { ok: true; sha: string; run: string; patterns: number; hotspots: string[] } | Refusal {
    const r = this.pickRun(run);
    if (!r.ok) return r;
    const { file, error } = readScanMemory(this.ports.state);
    if (error !== null) return { ok: false, errors: [error] };
    const rec = file.scans[r.run.sha];
    return {
      ok: true,
      sha: r.run.sha,
      run: r.run.id,
      patterns: (rec?.patterns.length ?? 0) + (rec?.pending?.kind === "pattern" ? 1 : 0),
      hotspots: [
        ...new Set([
          ...Object.keys(rec?.hotspots ?? {}),
          ...(rec?.pending?.kind === "hotspot" ? [rec.pending.unit] : []),
        ]),
      ],
    };
  }

  private pickRun(ref: unknown): { ok: true; run: ScanRunRef } | Refusal {
    // Live or interrupted, a run's findings are not settled (`finishedRuns`).
    const runs = this.ports
      .runs()
      .filter((r) => r.state !== "running" && r.state !== "interrupted");
    if (runs.length === 0)
      return {
        ok: false,
        errors: ["no finished scan run yet — scan memory is written from a scan"],
      };
    if (ref === undefined || ref === null || ref === "") return { ok: true, run: runs[0]! };
    const hit = runs.find((r) => r.id === ref);
    return hit
      ? { ok: true, run: hit }
      : {
          ok: false,
          errors: [`${JSON.stringify(ref)} is not a finished scan run (latest: ${runs[0]!.id})`],
        };
  }

  /** Why `text` reads as ONE finding rather than something that recurs, or null. */
  private individual(text: string, findings: readonly ScanFinding[]): string | null {
    if (/[\w./-]+\.[A-Za-z0-9]+:\d+/.test(text))
      return "anchors to one line (path:line) — that is a finding, and findings never become memory";
    const lower = text.toLowerCase();
    for (const hex of lower.match(/[0-9a-f]{12,}/g) ?? []) {
      if (
        findings.some(
          (f) => f.fingerprint.startsWith(hex) || (f.aliases ?? []).some((a) => a.startsWith(hex)),
        )
      ) {
        return "carries a finding's fingerprint — findings never become memory";
      }
    }
    for (const f of findings) {
      const claim = oneLine(f.claim).toLowerCase();
      if (claim.length >= QUOTE_MIN && lower.includes(claim))
        return `quotes a stored finding's claim (${f.fingerprint.slice(0, 12)}) — write the pattern, not the finding`;
    }
    return null;
  }

  /**
   * Write the companion's recurring patterns and per-unit hotspots for one
   * scan (default: the latest finished run) into reviewer memory, within the
   * scan's caps. Refused whole when any item is bad or the caps would be
   * exceeded; a note memory refuses is reported and not counted, so it can be
   * written again.
   */
  writeMemory(req: ScanMemoryRequest): Promise<ScanMemoryResult> {
    // Serialized: each call reads the cap record, awaits memory, then writes
    // the record back — two in flight (pi runs a turn's tool calls in
    // parallel) would both pass the caps and overwrite each other's accounting.
    const run = this.memoryWrites.then(() => this.writeMemoryNow(req));
    this.memoryWrites = run.catch(() => undefined);
    return run;
  }

  private memoryWrites: Promise<unknown> = Promise.resolve();

  private async writeMemoryNow(req: ScanMemoryRequest): Promise<ScanMemoryResult> {
    const picked = this.pickRun(req.run);
    if (!picked.ok) return picked;
    const run = picked.run;
    if (this.ports.memory === null)
      return {
        ok: false,
        errors: ["no reviewer memory in this assembly — nothing can be written"],
      };
    const { file, error } = readScanMemory(this.ports.state);
    if (error !== null) return { ok: false, errors: [error] };
    const { findings, error: fErr } = this.ports.findings.load();
    if (fErr !== null) return { ok: false, errors: [fErr] };
    const units = this.ports.units();
    const rec: ScanMemoryRecord = file.scans[run.sha] ?? {
      run: run.id,
      patterns: [],
      hotspots: {},
    };

    file.scans[run.sha] = rec;
    const persist = (): void =>
      this.ports.state.write(SCAN_MEMORY_FILE, `${JSON.stringify(file, null, 1)}\n`);
    const settlePending = async (
      recovering = false,
    ): Promise<{ written: boolean; problem: string | null }> => {
      const p = rec.pending!;
      const result = await this.note(
        p.kind === "pattern" ? patternMemoryText(p, run.sha) : hotspotMemoryText(p, run.sha),
      );
      if (result !== "written") {
        // A newly refused note is not counted. A recovered reservation may
        // already have landed before the prior process lost its checkpoint.
        if (!recovering && !result.uncertain) {
          delete rec.pending;
          try {
            persist();
          } catch {
            rec.pending = p;
          }
        }
        return { written: false, problem: result.problem };
      }
      if (p.kind === "pattern")
        rec.patterns.push({ text: p.text, occurrences: p.occurrences, at: p.at });
      else rec.hotspots[p.unit] = { text: p.text, at: p.at };
      delete rec.pending;
      try {
        persist();
        return { written: true, problem: null };
      } catch (err) {
        return {
          written: true,
          problem: `the cap checkpoint was not saved: ${clean(err)}; its durable reservation will be recovered before more notes`,
        };
      }
    };
    const written = { patterns: 0, hotspots: 0 };
    if (rec.pending) {
      const kind = rec.pending.kind;
      const recovery = await settlePending(true);
      if (recovery.problem !== null)
        return {
          ok: false,
          errors: [`the pending scan memory note could not be settled: ${recovery.problem}`],
        };
      written[kind === "pattern" ? "patterns" : "hotspots"]++;
    }
    const errors: string[] = [];
    const rawP = req.patterns ?? [];
    const rawH = req.hotspots ?? [];
    if (!Array.isArray(rawP)) errors.push("`patterns` must be a list of {text, occurrences}");
    if (!Array.isArray(rawH)) errors.push("`hotspots` must be a list of {unit, text}");
    if (errors.length > 0) return { ok: false, errors };
    const patterns: Array<{ text: string; occurrences: number }> = [];
    const hotspots: Array<{ unit: string; text: string }> = [];
    const textError = (at: string, text: string): void => {
      if (text === "" || text.length > MEMORY_TEXT_MAX)
        errors.push(`${at}.text must be 1..${MEMORY_TEXT_MAX} characters`);
      else if (text.startsWith("#"))
        errors.push(`${at}.text must not start with '#' (tags are the tool's to write)`);
      else {
        const why = this.individual(text, findings);
        if (why !== null) errors.push(`${at}.text ${why}`);
      }
    };
    for (const [i, raw] of (rawP as unknown[]).entries()) {
      const o = (raw ?? {}) as Record<string, unknown>;
      const text = typeof o.text === "string" ? oneLine(o.text) : "";
      const occ =
        typeof o.occurrences === "string" && /^\d+$/.test(o.occurrences)
          ? Number(o.occurrences)
          : o.occurrences;
      textError(`patterns[${i}]`, text);
      if (typeof occ !== "number" || !Number.isInteger(occ) || occ < 2) {
        errors.push(
          `patterns[${i}].occurrences must be an integer ≥ 2 — a pattern recurs; one occurrence is a finding`,
        );
      }
      if (!rec.patterns.some((p) => p.text === text && p.occurrences === occ))
        patterns.push({ text, occurrences: occ as number });
    }
    const seenUnits = new Set<string>();
    for (const [i, raw] of (rawH as unknown[]).entries()) {
      const o = (raw ?? {}) as Record<string, unknown>;
      const unit = typeof o.unit === "string" ? o.unit.trim() : "";
      const text = typeof o.text === "string" ? oneLine(o.text) : "";
      textError(`hotspots[${i}]`, text);
      if (units === null) errors.push(`hotspots[${i}]: no saved unit cut to name a unit from`);
      else if (!units.includes(unit))
        errors.push(`hotspots[${i}].unit ${JSON.stringify(unit)} is not a unit of the saved cut`);
      else if (
        seenUnits.has(unit) ||
        (Object.hasOwn(rec.hotspots, unit) && rec.hotspots[unit]!.text !== text)
      )
        errors.push(`hotspots[${i}]: ${unit} already has its one hotspot for this scan`);
      seenUnits.add(unit);
      if (rec.hotspots[unit]?.text !== text) hotspots.push({ unit, text });
    }
    if (rec.patterns.length + patterns.length > MAX_PATTERNS_PER_SCAN) {
      errors.push(
        `at most ${MAX_PATTERNS_PER_SCAN} patterns per scan: ${rec.patterns.length} written for ${run.sha.slice(0, 12)} already, ` +
          `${MAX_PATTERNS_PER_SCAN - rec.patterns.length} left (got ${patterns.length}) — keep the strongest`,
      );
    }
    if ((rawP as unknown[]).length === 0 && (rawH as unknown[]).length === 0)
      errors.push("nothing to write — give patterns, hotspots or both");
    if (errors.length > 0) return { ok: false, errors };

    const problems: string[] = [];
    const publish = async (pending: PendingScanNote): Promise<boolean> => {
      rec.pending = pending;
      try {
        persist();
      } catch (err) {
        delete rec.pending;
        problems.push(`the cap reservation could not be saved: ${clean(err)} — no note was sent`);
        return false;
      }
      const result = await settlePending();
      if (result.written) written[pending.kind === "pattern" ? "patterns" : "hotspots"]++;
      if (result.problem !== null) {
        problems.push(result.problem);
        return false;
      }
      return true;
    };
    let ready = true;
    for (const p of patterns) {
      if (!(await publish({ kind: "pattern", ...p, at: this.ports.clock().toISOString() }))) {
        ready = false;
        break;
      }
    }
    if (ready)
      for (const h of hotspots) {
        if (!(await publish({ kind: "hotspot", ...h, at: this.ports.clock().toISOString() })))
          break;
      }
    return {
      ok: true,
      sha: run.sha,
      run: run.id,
      written,
      problems,
      left: {
        patterns:
          MAX_PATTERNS_PER_SCAN - rec.patterns.length - (rec.pending?.kind === "pattern" ? 1 : 0),
        units_without_hotspot: (units ?? []).filter(
          (u) =>
            !Object.hasOwn(rec.hotspots, u) &&
            !(rec.pending?.kind === "hotspot" && rec.pending.unit === u),
        ),
      },
    };
  }
}
