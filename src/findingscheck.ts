// The findings record's enforcement: the daemon's half of the durable
// reasoning record (src/findingsrecord.ts says what the record is, and holds
// its parser). After a round, the record is parsed into queryable rows; a
// missing or unparseable one costs an anomaly every time and at most ONE
// nudge, through `wakeOrHold`, and a record that lands after its nudge is
// still stored. A round is never held open for it.
import {
  findingsRecordFile,
  findingsRecordPath,
  findingsRecordWake,
  isConformant,
  readFindingsRecord,
  type FindingsRecordFile,
  type ParsedFindingsRecord,
} from "./findingsrecord.js";
import { enqueueRoundWork, finishRoundWork, pendingRoundWork } from "./round-work.js";
import type { StateStore } from "./state.js";
import { wakeOrHold } from "./wakes.js";

export interface FindingsCheckDeps {
  store: StateStore;
  /** Where the record lives — daemon.ts passes `<root>/state/findings`. */
  findingsDir: string;
  /** SessionHooks.inject — rides wakeOrHold, so a check that somehow lands
   * mid-round holds rather than interleaving (rule 9). */
  inject: (pr: number, message: string) => Promise<void>;
  log?: (msg: string, extra?: unknown) => void;
  /**
   * Told every time a round's findings record LANDS in `round_findings`: the
   * lesson shadow ledger marks the round's posted
   * findings a selected dont-raise lesson would have touched
   * (src/lessonshadow.ts). Runs asynchronously after `findings_recorded`;
   * its durable obligation is retried until the callback returns successfully.
   * A returned promise is awaited; synchronous callbacks stay accepted.
   */
  onRecorded?: (target: { pr: number; roundNo: number; roundId: number | null }) => unknown;
}

export interface FindingsCheckTarget {
  pr: number;
  roundNo: number;
  /** The round row the parsed entries hang off. Null ⇒ rows are still stored,
   * attributed by (pr, round_no) alone. */
  roundId: number | null;
  headSha: string;
  /** The round's PLANNED lenses (`rounds.lenses`). The add protocol lets the
   * main pi run a lens that appears in no plan, so the executed set is NOT
   * assumed equal to the plan: a lens outside this list is stored with
   * `unplanned = 1` rather than dropped or treated as an error. */
  planned: readonly string[];
}

export type FindingsCheckResult = "recorded" | "nudged" | "already_nudged";

/**
 * The enforcement step. Parsed ⇒ rows are written and the per-round comment
 * count lands on the round. Otherwise an anomaly EVERY time (the durable
 * audit trail) — `findings_record_missing` until the round's one nudge has
 * gone out, `findings_record_unresolved` after it — plus at most ONE nudge.
 *
 * The once-mark is stamped BEFORE the inject, so no failure mode — a throwing
 * inject, a crash between the two, a second sweep of the same round — can ever
 * nudge twice. The safety direction is "never a loop"; the wake is best-effort
 * on top of a durable anomaly row.
 */
export async function enforceFindingsRecord(
  deps: FindingsCheckDeps,
  target: FindingsCheckTarget,
): Promise<FindingsCheckResult> {
  const { store, log } = deps;
  const { pr, roundNo, headSha, planned } = target;
  const path = findingsRecordPath(deps.findingsDir, pr, roundNo);
  const parsed = readFindingsRecord(path, pr, roundNo);

  if (parsed.status === "ok" && parsed.record) {
    ingestFindingsRecord(deps, target, parsed, parsed.record);
    return "recorded";
  }

  const detail = `findings record ${parsed.status} at ${path}`;
  log?.(`findings: #${pr} round ${roundNo} record ${parsed.status}`, { path });

  const key = `round-${roundNo}`;
  if (store.findingsNudgeSent(pr, key)) {
    // Still missing AFTER its one nudge: the session ignored it. A distinct,
    // WAKE-grade kind (anomalies.ts) — first detection stays quiet, because
    // the nudge itself is the response.
    store.logAnomaly("findings_record_unresolved", pr, roundNo, detail);
    store.logEvent("findings_record_repeat", pr, { round_no: roundNo, status: parsed.status });
    return "already_nudged";
  }
  store.logAnomaly("findings_record_missing", pr, roundNo, detail);
  // The mark carries what `ingestRepairedFindingsRecords` needs to store the
  // record the nudge asks for once it lands.
  store.recordFindingsNudge(pr, key, {
    round_no: roundNo,
    round_id: target.roundId,
    head_sha: headSha,
    planned: [...planned],
    status: parsed.status,
  });
  await wakeOrHold(
    { store, inject: deps.inject, ...(log ? { log } : {}) },
    pr,
    findingsRecordWake(pr, roundNo, `state/findings/${findingsRecordFile(pr, roundNo)}`),
    "findings_record_missing",
  );
  return "nudged";
}

/** How long after its nudge a missing record is still looked for. */
export const FINDINGS_REPAIR_WINDOW_MS = 7 * 24 * 3_600_000;

/**
 * Store the records the missing-record nudge asked for. The round's tail
 * checks once and nudges once; the reconstructed file lands later, when no
 * round tail is left to read it. So every sweep re-reads the record of each
 * round nudged within `FINDINGS_REPAIR_WINDOW_MS` that has no
 * `findings_recorded` event yet, and stores a record that now parses exactly
 * as the tail would have — rows, comment count, prior reports, the
 * `findings_recorded` event and `onRecorded`. A record still missing is left
 * alone: no second nudge and no further anomaly. Returns how many it stored.
 */
export function ingestRepairedFindingsRecords(
  deps: Pick<FindingsCheckDeps, "store" | "findingsDir" | "log" | "onRecorded">,
  now: Date,
): number {
  const { store } = deps;
  const since = new Date(now.getTime() - FINDINGS_REPAIR_WINDOW_MS).toISOString();
  const nudges = store.db
    .prepare(
      "SELECT pr, payload FROM events WHERE kind = 'findings_record_nudged' AND ts >= ? ORDER BY id",
    )
    .all(since) as Array<{ pr: number | null; payload: string | null }>;
  const recorded = store.db.prepare(
    "SELECT 1 FROM events WHERE kind = 'findings_recorded' AND pr = ? AND json_extract(payload, '$.round_no') = ? LIMIT 1",
  );
  const roundRow = store.db.prepare(
    "SELECT id, lenses, head_sha FROM rounds WHERE pr = ? AND round_no = ? ORDER BY id DESC LIMIT 1",
  );
  let stored = 0;
  for (const n of nudges) {
    if (n.pr === null || !n.payload) continue;
    let mark: { round_no?: unknown; round_id?: unknown; head_sha?: unknown; planned?: unknown };
    try {
      mark = JSON.parse(n.payload) as typeof mark;
    } catch {
      continue;
    }
    const roundNo = typeof mark.round_no === "number" ? mark.round_no : null;
    if (roundNo === null || recorded.get(n.pr, roundNo) !== undefined) continue;
    const parsed = readFindingsRecord(
      findingsRecordPath(deps.findingsDir, n.pr, roundNo),
      n.pr,
      roundNo,
    );
    if (parsed.status !== "ok" || !parsed.record) continue;
    // A mark written before it carried the round's identity: the round row.
    const round = roundRow.get(n.pr, roundNo) as
      { id: number; lenses: string | null; head_sha: string | null } | undefined;
    const planned = Array.isArray(mark.planned)
      ? mark.planned.filter((l): l is string => typeof l === "string")
      : (round?.lenses ?? "").split(",").filter(Boolean);
    ingestFindingsRecord(
      deps,
      {
        pr: n.pr,
        roundNo,
        roundId: typeof mark.round_id === "number" ? mark.round_id : (round?.id ?? null),
        headSha: typeof mark.head_sha === "string" ? mark.head_sha : (round?.head_sha ?? ""),
        planned,
      },
      parsed,
      parsed.record,
    );
    deps.log?.(`findings: #${n.pr} round ${roundNo} record arrived after its nudge — stored`);
    stored++;
  }
  return stored;
}

/** Store one parsed record: its rows, the round's comment count, the prior
 * reports, the `findings_recorded` event, `onRecorded`, and the output-rule
 * audit. */
function ingestFindingsRecord(
  deps: Pick<FindingsCheckDeps, "store" | "log" | "onRecorded">,
  target: FindingsCheckTarget,
  parsed: ParsedFindingsRecord,
  record: FindingsRecordFile,
): void {
  const { store, log } = deps;
  const { pr, roundNo, roundId, headSha, planned } = target;
  const stored = store.db.transaction(() => {
    const stored = store.recordRoundFindings(
      { pr, round_id: roundId, round_no: roundNo, head_sha: record.head_sha ?? headSha },
      record.findings,
      planned,
    );
    if (record.comments_posted !== null && roundId !== null)
      store.recordRoundComments(roundId, record.comments_posted);
    // The statuses this round reported for prior findings. Stored
    // beside the listing the daemon made at order build; the next round's
    // list drops what a later report resolved.
    const priorReported =
      record.prior.length > 0
        ? store.recordPriorReports(pr, roundNo, record.head_sha ?? headSha, record.prior)
        : 0;
    if (deps.onRecorded)
      enqueueRoundWork(store, {
        key: `findings_hook:${roundId ?? `${pr}:${roundNo}`}`,
        kind: "findings_hook",
        pr,
        round_no: roundNo,
        due_at: "",
        payload: { pr, roundNo, roundId },
      });
    store.logEvent("findings_recorded", pr, {
      round_id: roundId,
      round_no: roundNo,
      entries: stored,
      comments_posted: record.comments_posted,
      ...(priorReported > 0 ? { prior_reported: priorReported } : {}),
      ...(parsed.note ? { note: parsed.note } : {}),
    });
    return stored;
  })();
  void resumeFindingsRecordedHooks(deps);
  // The round's posted output against the three output rules. A quiet
  // anomaly (anomalies.ts wakes nobody for this kind) — a durable, queryable
  // row is the point, and no round is ever held open for it.
  const c = parsed.conformance;
  if (c) {
    store.logEvent("findings_conformance", pr, {
      round_no: roundNo,
      ungrammatical_tags: c.ungrammatical_tags.length,
      nits_without_request: c.nits_without_request.length,
      doubted_posted: c.doubted_posted.length,
      restated: c.restated.length,
    });
    if (!isConformant(c)) {
      store.logAnomaly(
        "review_output_unreasoned",
        pr,
        roundNo,
        `posted output outside the output rules: ${c.ungrammatical_tags.length} tag(s) outside the grammar ` +
          `(${c.ungrammatical_tags.join(", ")}), ${c.nits_without_request.length} nit(s) asking for nothing ` +
          `(${c.nits_without_request.join(", ")})` +
          (c.doubted_posted.length > 0
            ? `, ${c.doubted_posted.length} doubted finding(s) posted (${c.doubted_posted.join(", ")})`
            : ""),
      );
    }
  }
  log?.(
    `findings: #${pr} round ${roundNo} recorded ${stored} entr${stored === 1 ? "y" : "ies"}` +
      (parsed.note ? ` (${parsed.note})` : ""),
  );
}

const recordedHookFlights = new WeakMap<StateStore, Promise<void>>();

/** Resume unfinished callback delivery. The callback may return an async
 * completion; legacy synchronous callbacks remain accepted. No round waits
 * for this worker, and an exhausted per-thread failure remains terminal. */
export function resumeFindingsRecordedHooks(
  deps: Pick<FindingsCheckDeps, "store" | "log" | "onRecorded">,
): Promise<void> {
  if (!deps.onRecorded) return Promise.resolve();
  const existing = recordedHookFlights.get(deps.store);
  if (existing) return existing;
  const work = Promise.resolve()
    .then(async () => {
      for (const row of pendingRoundWork(deps.store, "findings_hook", new Date().toISOString())) {
        try {
          const target = JSON.parse(row.payload) as {
            pr: number;
            roundNo: number;
            roundId: number | null;
          };
          await deps.onRecorded!(target);
          finishRoundWork(deps.store, row.key, new Date().toISOString());
        } catch (err) {
          deps.log?.(
            `findings: #${row.pr} round ${row.round_no} recorded hook incomplete — retained for retry`,
            err,
          );
        }
      }
    })
    .catch((err: unknown) => {
      deps.log?.("findings: recorded hook worker unavailable — obligations retained", err);
    })
    .finally(() => {
      recordedHookFlights.delete(deps.store);
    });
  recordedHookFlights.set(deps.store, work);
  return work;
}
