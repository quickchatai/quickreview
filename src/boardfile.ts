// board.json: the daemon's board for a host, written beside its status
// snapshot (`<state>/board.json`).
//
// A host that runs a reviewer for its operator shows three short lists: the
// pull requests being reviewed now, the ones reviewed, and the open ones not
// reviewed yet. Half of a reviewed row (what reached GitHub, when, the review's
// id) is in the state database alone, and a host must not pay for a second
// process that opens it on every read. So the daemon, which has the store
// open, is the writer: it builds this file from the status snapshot it has
// just built and writes it atomically, on every status write (its tick, the
// end of a reconcile pass, a round-stage scan) and whenever a round moved
// since the last write (`roundTransitionKey`). `qcr --schema 3 board`
// (src/boardexport.ts) reads this one file and nothing else of the daemon's.
//
// The lists, over the pull requests the daemon tracks that are not closed:
//
//   reviewing   work is owed or in flight: queued, a round running, a
//               finished review still being delivered to GitHub, or a review
//               failure on record. Each row says which (`state`), and a
//               failed one says why in a closed word (`problem`).
//   reviewed    a last verdict is set and the pull request is not in
//               `reviewing`. A row carries the verdict the round decided and,
//               separately, what GitHub holds: `posted_event` is there only
//               for a review that is on GitHub (a round in dry-run records
//               its intent and posts nothing, so it has none).
//   open        the open pull requests the last reconcile pass listed, minus
//               those two lists. Absent until a pass has listed them.
//
// Each list is its newest BOARD_LIST_CAP rows, newest first, and `more` says
// that at least one was cut. A field the daemon cannot read is left out of its
// row: absent means unknown, never a zero or a default.
//
// Beside the lists the daemon counts the pull requests it reviewed today
// (`reviewed_today`): those with a review round that finished since midnight
// on the install's own calendar (`[ops] timezone`), open or closed, posted or
// practice. The lists cannot give that number (a closed pull request is in
// none of them), so it is counted from the round store when the board is
// written (src/boardtoday.ts), and carried with the day it is the count of:
// a reader prints it only while that day lasts. A count the daemon could not
// make is left out, never written as zero.
//
// It also carries the trigger the daemon follows (`trigger`, from the status
// snapshot: src/triggerchoice.ts), which is what the export reports. Left
// out when the daemon could not read its store, so a reader cannot take an
// unread trigger for a default.
//
// No row carries a URL, a repository name or an identity. A host builds its
// links from its own record of the repository and the integers here.
//
// The file is the daemon's own format (`format`), not the contract: the
// export's shape is schemas/board.v1.json, and the reader re-reads every field
// of a row it prints (`parseBoardFile`), so a file from another build prints
// only what both sides know.
//
// This module loads no state store: it takes the snapshot and the rounds as
// values, so the export's reader can import it where the SQLite driver cannot
// load (tests/sqlite-free-routes.test.ts).
import { mkdirSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { RoundRow } from "@quickchatai/pi-quickreview/src/storerows.js";
import { VERDICTS, normalizeVerdict, type Verdict } from "@quickchatai/pi-quickreview/src/types.js";
import type { GithubTrigger } from "@quickchatai/pi-quickreview/src/reviewconfig.js";
import type { PrStateRow, ReviewFailureRow, StatusSnapshot } from "./state.js";
import { followedTriggerOf } from "./triggerchoice.js";

/** The file's name in the daemon's state directory. */
export const BOARD_FILE = "board.json";
/** This file's own format. A reader that meets another reads nothing. */
export const BOARD_FILE_FORMAT = 1 as const;
/** The most rows a list carries. */
export const BOARD_LIST_CAP = 50;
/** The longest title a row carries. */
export const BOARD_TITLE_MAX = 256;

/** Where a pull request in `reviewing` stands. */
export const REVIEWING_STATES = ["queued", "running", "posting", "failed", "paused"] as const;
export type ReviewingState = (typeof REVIEWING_STATES)[number];

/**
 * Why a row is `failed`:
 *   retry_scheduled  the daemon retries it by itself, at `retry_at`
 *   posting_failed   the review finished and its delivery to GitHub did not,
 *                    or cannot be confirmed; it waits for the operator
 *   round_failed     the round itself failed and waits for the operator
 *   worker_parked    its worker kept crashing and is parked until the
 *                    operator reruns the round
 */
export const REVIEWING_PROBLEMS = [
  "retry_scheduled",
  "posting_failed",
  "round_failed",
  "worker_parked",
] as const;
export type ReviewingProblem = (typeof REVIEWING_PROBLEMS)[number];

/** What a review is on GitHub as. */
export const POSTED_EVENTS = ["APPROVE", "REQUEST_CHANGES", "COMMENT"] as const;
export type PostedEvent = (typeof POSTED_EVENTS)[number];

export interface BoardReviewingRow {
  number: number;
  title?: string;
  author?: string;
  state: ReviewingState;
  problem?: ReviewingProblem;
  /** The round in flight, or the one that failed. */
  round?: number;
  /** When the round in flight started. */
  started_at?: string;
  /** When a `retry_scheduled` failure is retried. */
  retry_at?: string;
}

export interface BoardReviewedRow {
  number: number;
  title?: string;
  author?: string;
  /** The last round's decision. Not what GitHub shows: see `posted_event`. */
  verdict?: Verdict;
  /** What the review is on GitHub as. Absent: the round posted nothing. */
  posted_event?: PostedEvent;
  /** An approval was decided and is held back until the checks pass. */
  approval_withheld?: boolean;
  posted_at?: string;
  /** The review's id on GitHub. */
  review_id?: number;
  /** How many rounds the pull request has had. */
  rounds?: number;
  /** The inline comments the last round's review carries. */
  findings?: number;
  /** The pull request's head moved since that round reviewed it. */
  head_changed?: boolean;
}

export interface BoardOpenRow {
  number: number;
  title?: string;
  author?: string;
  draft?: boolean;
  updated_at?: string;
}

/** The slice of the status snapshot the reviewer's label is judged on: the
 * keys `autoReviewLabel` (src/home/autoreview.ts) reads, and no other. The
 * daemon's own posting flag and its poll record are read from here too. */
export type BoardHealth = Pick<
  StatusSnapshot,
  "heartbeat" | "dry_run" | "poll" | "pi_auth_expired" | "login_refresh" | "pipeline" | "provider"
>;

/** What the daemon recorded as spent in the UTC day and month of
 * `written_at`. A count beside a sum is the rounds in it that used tokens
 * and have no price: the sum counts none of them. */
export interface BoardSpend {
  today_usd: number;
  month_usd: number;
  today_unknown_rounds?: number;
  month_unknown_rounds?: number;
}

/** How many pull requests had a review round finish in one day of the
 * install's own calendar, and which day: from its midnight (`since`) to the
 * next (`until`), as instants. */
export interface BoardReviewedToday {
  count: number;
  since: string;
  until: string;
}

export interface BoardFile {
  format: typeof BOARD_FILE_FORMAT;
  written_at: string;
  health: BoardHealth;
  spend?: BoardSpend;
  /** Absent when the daemon could not count it (its store, or its timezone). */
  reviewed_today?: BoardReviewedToday;
  /** The trigger the daemon follows. Absent: unknown. */
  trigger?: GithubTrigger;
  reviewing: BoardReviewingRow[];
  reviewed: BoardReviewedRow[];
  /** Absent until a reconcile pass has listed the open pull requests. */
  open?: BoardOpenRow[];
  /** When that pass listed them. */
  listed_at?: string;
  /** At least one list was cut to its newest BOARD_LIST_CAP rows. */
  more?: true;
}

/** The columns of a round a reviewed row is read from. */
export type BoardRound = Pick<
  RoundRow,
  | "round_no"
  | "verdict"
  | "posted_event"
  | "posted_at"
  | "gh_review_id"
  | "gh_commit_id"
  | "comments_posted"
  | "head_sha"
>;

type SnapshotPr = StatusSnapshot["prs"][number];

// ---- building it (the daemon) ------------------------------------------------

const text = (v: unknown): string | undefined =>
  typeof v === "string" && v.trim() !== "" ? v : undefined;

/** A time as a sort key: later is larger, and an unreadable one sorts last. */
const when = (v: string | null | undefined): number => {
  const at = typeof v === "string" ? Date.parse(v) : NaN;
  return Number.isFinite(at) ? at : -Infinity;
};

/** The newest `BOARD_LIST_CAP` of `rows` by `at`, newest first; a tie goes to
 * the higher number. `cut` says rows were left out. */
function newest<T extends { number: number }>(
  rows: readonly T[],
  at: (row: T) => number,
): { rows: T[]; cut: boolean } {
  const sorted = [...rows].sort((a, b) => at(b) - at(a) || b.number - a.number);
  return { rows: sorted.slice(0, BOARD_LIST_CAP), cut: sorted.length > BOARD_LIST_CAP };
}

/** The title and author every row leads with. */
interface Named {
  title?: string;
  author?: string;
}

/** A pull request's title and author, each only when there is one. */
function named(p: { title?: string | null; author?: string | null }): Named {
  const title = text(p.title);
  const author = text(p.author);
  return {
    ...(title !== undefined ? { title: title.slice(0, BOARD_TITLE_MAX) } : {}),
    ...(author !== undefined ? { author } : {}),
  };
}

function failureProblem(f: Pick<ReviewFailureRow, "stage" | "next_action">): ReviewingProblem {
  if (f.next_action === "retry_wait") return "retry_scheduled";
  return f.stage.startsWith("posting") ? "posting_failed" : "round_failed";
}

/**
 * Where a pull request stands in `reviewing`, or null when it is not there. A
 * review failure on record puts it there whatever its lifecycle state says;
 * otherwise it is there while work is owed or in flight. A pause holds a
 * queued pull request out of dispatch and never a round already running, so
 * `paused` is said of a queued one only.
 */
function reviewingState(p: SnapshotPr): Pick<BoardReviewingRow, "state" | "problem"> | null {
  if (p.review_failure !== undefined)
    return { state: "failed", problem: failureProblem(p.review_failure) };
  const round = p.current_round;
  if (round === undefined && p.state !== "queued" && p.state !== "reviewing") return null;
  if (p.worker_crash?.parked_at) return { state: "failed", problem: "worker_parked" };
  if (round !== undefined) return { state: round.posting_delivery ? "posting" : "running" };
  if (p.state === "reviewing") return { state: "running" };
  return { state: p.paused ? "paused" : "queued" };
}

/** The pull request's row in `reviewing`, or null when it is not there. */
function reviewingRow(p: SnapshotPr): BoardReviewingRow | null {
  const at = reviewingState(p);
  if (at === null) return null;
  const roundNo = p.current_round?.round_no ?? p.review_failure?.round_no;
  const startedAt = text(p.current_round?.started_at);
  const retryAt = text(p.review_failure?.next_retry_at);
  return {
    number: p.number,
    ...named(p),
    ...at,
    ...(typeof roundNo === "number" ? { round: roundNo } : {}),
    ...(startedAt !== undefined ? { started_at: startedAt } : {}),
    ...(retryAt !== undefined ? { retry_at: retryAt } : {}),
  };
}

/** When the work a `reviewing` row shows began: the round, else the failure,
 * else the trigger, else the pull request's last change in the daemon's record. */
function reviewingSince(p: SnapshotPr): number {
  return Math.max(
    when(p.current_round?.started_at),
    when(p.review_failure?.failed_at),
    when(p.trigger_ts),
    p.current_round || p.review_failure || p.trigger_ts ? -Infinity : when(p.updated_at),
  );
}

/** The round the snapshot's `last_verdict` is of: the highest-numbered one
 * that carries a verdict. */
function lastVerdictRound(rounds: readonly BoardRound[]): BoardRound | undefined {
  let last: BoardRound | undefined;
  for (const r of rounds)
    if (r.verdict !== null && (last === undefined || r.round_no > last.round_no)) last = r;
  return last;
}

function reviewedRow(p: SnapshotPr, rounds: readonly BoardRound[]): BoardReviewedRow {
  const last = lastVerdictRound(rounds);
  const verdict = normalizeVerdict(p.last_verdict);
  // On GitHub exactly when the round holds a review's id: a dry-run round
  // confirms its intended event too, and has none.
  const onGithub = last !== undefined && last.gh_review_id !== null ? last : undefined;
  const event = (onGithub?.posted_event ?? "").toUpperCase();
  const postedAt = text(onGithub?.posted_at);
  const reviewId = onGithub?.gh_review_id ?? null;
  const reviewedHead = text(last?.head_sha) ?? text(last?.gh_commit_id);
  return {
    number: p.number,
    ...named(p),
    ...(verdict !== null ? { verdict } : {}),
    ...((POSTED_EVENTS as readonly string[]).includes(event)
      ? { posted_event: event as PostedEvent }
      : {}),
    // null is the daemon's "none outstanding"; absent is an older snapshot's unknown
    ...(p.approval_withheld !== undefined
      ? { approval_withheld: p.approval_withheld !== null }
      : {}),
    ...(postedAt !== undefined ? { posted_at: postedAt } : {}),
    ...(reviewId !== null ? { review_id: reviewId } : {}),
    ...(typeof p.rounds === "number" ? { rounds: p.rounds } : {}),
    ...(last !== undefined && last.comments_posted !== null
      ? { findings: last.comments_posted }
      : {}),
    ...(reviewedHead !== undefined && text(p.head_sha) !== undefined
      ? { head_changed: reviewedHead.toLowerCase() !== p.head_sha.toLowerCase() }
      : {}),
  };
}

function boardSpend(s: StatusSnapshot): BoardSpend | undefined {
  const today = s.today_spend_usd;
  const month = s.month_spend_usd;
  if (typeof today !== "number" || typeof month !== "number") return undefined;
  const count = (n: number | undefined): n is number => typeof n === "number" && n > 0;
  return {
    today_usd: today,
    month_usd: month,
    ...(count(s.today_unknown_spend_rounds)
      ? { today_unknown_rounds: s.today_unknown_spend_rounds }
      : {}),
    ...(count(s.month_unknown_spend_rounds)
      ? { month_unknown_rounds: s.month_unknown_spend_rounds }
      : {}),
  };
}

/**
 * The board, from the status snapshot the daemon has just built and the
 * rounds of the pull requests it lists as reviewed. `roundsOf` is asked only
 * for the rows that survive the cap. `reviewedToday` is the day's count as
 * the daemon made it (src/boardtoday.ts); undefined, it could not, and the
 * board carries none.
 */
export function buildBoardFile(
  snapshot: StatusSnapshot,
  roundsOf: (pr: number) => readonly BoardRound[],
  reviewedToday?: BoardReviewedToday,
): BoardFile {
  const tracked = snapshot.prs.filter((p) => p.state !== "closed");
  const working: Array<{ number: number; pr: SnapshotPr; row: BoardReviewingRow }> = [];
  const verdicted: SnapshotPr[] = [];
  for (const pr of tracked) {
    const row = reviewingRow(pr);
    if (row !== null) working.push({ number: pr.number, pr, row });
    else if (text(pr.last_verdict) !== undefined) verdicted.push(pr);
  }
  const reviewing = newest(working, (w) => reviewingSince(w.pr));
  // newest by the pull request's last change in the daemon's record
  const reviewed = newest(verdicted, (p) => when(p.updated_at));
  const listed = new Set([...working.map((w) => w.number), ...verdicted.map((p) => p.number)]);
  const unlisted = snapshot.open_prs?.prs.filter((p) => !listed.has(p.number));
  const open = unlisted ? newest(unlisted, (p) => when(p.updated_at)) : undefined;
  const spend = boardSpend(snapshot);
  return {
    format: BOARD_FILE_FORMAT,
    written_at: snapshot.written_at,
    health: {
      heartbeat: snapshot.heartbeat,
      dry_run: snapshot.dry_run,
      ...(snapshot.poll ? { poll: snapshot.poll } : {}),
      ...(snapshot.pi_auth_expired ? { pi_auth_expired: snapshot.pi_auth_expired } : {}),
      ...(snapshot.login_refresh ? { login_refresh: snapshot.login_refresh } : {}),
      ...(snapshot.pipeline ? { pipeline: snapshot.pipeline } : {}),
      ...(snapshot.provider ? { provider: snapshot.provider } : {}),
    },
    ...(spend ? { spend } : {}),
    ...(reviewedToday !== undefined ? { reviewed_today: reviewedToday } : {}),
    ...(snapshot.trigger !== undefined ? { trigger: snapshot.trigger } : {}),
    reviewing: reviewing.rows.map((w) => w.row),
    reviewed: reviewed.rows.map((p) => reviewedRow(p, roundsOf(p.number))),
    ...(open && snapshot.open_prs
      ? {
          open: open.rows.map((p) => ({
            number: p.number,
            ...named(p),
            draft: p.draft,
            ...(text(p.updated_at) !== undefined ? { updated_at: p.updated_at } : {}),
          })),
          listed_at: snapshot.open_prs.listed_at,
        }
      : {}),
    ...(reviewing.cut || reviewed.cut || open?.cut ? { more: true as const } : {}),
  };
}

/** Write board.json atomically (temp + rename): a reader may hit it mid-write. */
export function writeBoardJson(stateDir: string, board: BoardFile): void {
  mkdirSync(stateDir, { recursive: true });
  const target = join(stateDir, BOARD_FILE);
  const tmp = `${target}.tmp`;
  writeFileSync(tmp, JSON.stringify(board));
  renameSync(tmp, target);
}

/** What a round transition changes, read off the store. */
export interface RoundTransitionSource {
  allPrs(): ReadonlyArray<Pick<PrStateRow, "number" | "state" | "paused">>;
  runningRounds(): ReadonlyArray<Pick<RoundRow, "id" | "posted_event" | "gh_review_id">>;
  openReviewFailures(): ReadonlyArray<
    Pick<ReviewFailureRow, "incident_id" | "next_action" | "next_retry_at">
  >;
}

/**
 * Everything a round transition moves, as one string: each tracked pull
 * request's lifecycle state and hold, the rounds in flight with what they
 * posted, and the failures owed. The daemon rewrites the board when it
 * differs from the key of its last write, so a pull request sent for review
 * shows as queued, then running, then reviewed, without waiting for the
 * status tick. Compared, never hooked: whatever moved a round (the dispatch
 * pump, the verdict watcher, a webhook, an operator's command) is seen.
 */
export function roundTransitionKey(store: RoundTransitionSource): string {
  const prs = store
    .allPrs()
    .filter((p) => p.state !== "closed")
    .map((p) => `${p.number}:${p.state}:${p.paused ? 1 : 0}`);
  const rounds = store
    .runningRounds()
    .map((r) => `${r.id}:${r.posted_event ?? ""}:${r.gh_review_id ?? ""}`);
  const failures = store
    .openReviewFailures()
    .map((f) => `${f.incident_id}:${f.next_action}:${f.next_retry_at ?? ""}`);
  return [prs.join(","), rounds.join(","), failures.join(",")].join("|");
}

// ---- reading it (the export) ---------------------------------------------------

type Obj = Record<string, unknown>;
const isObj = (v: unknown): v is Obj => typeof v === "object" && v !== null && !Array.isArray(v);
const count = (v: unknown, min: number): number | undefined =>
  typeof v === "number" && Number.isInteger(v) && v >= min ? v : undefined;
const flag = (v: unknown): boolean | undefined => (typeof v === "boolean" ? v : undefined);
const oneOf = <T extends string>(v: unknown, set: readonly T[]): T | undefined =>
  typeof v === "string" && (set as readonly string[]).includes(v) ? (v as T) : undefined;
/** `fields` without the keys whose value is undefined. */
function present<T extends object>(fields: T): T {
  const out: Obj = {};
  for (const [k, v] of Object.entries(fields)) if (v !== undefined) out[k] = v;
  return out as T;
}

/** The rows of a list as the reader knows them: a row with no number, or a
 * `reviewing` row with no known state, is not a row. Never more than the cap. */
function rowsOf<T>(v: unknown, row: (o: Obj) => T | null): T[] | undefined {
  if (!Array.isArray(v)) return undefined;
  const out: T[] = [];
  for (const x of v as unknown[]) {
    if (out.length === BOARD_LIST_CAP) break;
    const r = isObj(x) ? row(x) : null;
    if (r !== null) out.push(r);
  }
  return out;
}

const readNamed = (o: Obj): Named => ({
  title: text(o["title"])?.slice(0, BOARD_TITLE_MAX),
  author: text(o["author"]),
});

function readReviewing(o: Obj): BoardReviewingRow | null {
  const number = count(o["number"], 1);
  const state = oneOf(o["state"], REVIEWING_STATES);
  if (number === undefined || state === undefined) return null;
  return present({
    number,
    ...readNamed(o),
    state,
    problem: oneOf(o["problem"], REVIEWING_PROBLEMS),
    round: count(o["round"], 1),
    started_at: text(o["started_at"]),
    retry_at: text(o["retry_at"]),
  });
}

function readReviewed(o: Obj): BoardReviewedRow | null {
  const number = count(o["number"], 1);
  if (number === undefined) return null;
  return present({
    number,
    ...readNamed(o),
    verdict: oneOf(o["verdict"], VERDICTS),
    posted_event: oneOf(o["posted_event"], POSTED_EVENTS),
    approval_withheld: flag(o["approval_withheld"]),
    posted_at: text(o["posted_at"]),
    review_id: count(o["review_id"], 1),
    rounds: count(o["rounds"], 0),
    findings: count(o["findings"], 0),
    head_changed: flag(o["head_changed"]),
  });
}

function readOpen(o: Obj): BoardOpenRow | null {
  const number = count(o["number"], 1);
  if (number === undefined) return null;
  return present({
    number,
    ...readNamed(o),
    draft: flag(o["draft"]),
    updated_at: text(o["updated_at"]),
  });
}

function readSpend(v: unknown): BoardSpend | undefined {
  if (!isObj(v)) return undefined;
  const usd = (x: unknown): number | undefined =>
    typeof x === "number" && Number.isFinite(x) && x >= 0 ? x : undefined;
  const today = usd(v["today_usd"]);
  const month = usd(v["month_usd"]);
  if (today === undefined || month === undefined) return undefined;
  return present({
    today_usd: today,
    month_usd: month,
    today_unknown_rounds: count(v["today_unknown_rounds"], 1),
    month_unknown_rounds: count(v["month_unknown_rounds"], 1),
  });
}

/** The day's count, whole or not at all: a count with no day it is the count
 * of cannot be told from yesterday's. */
function readReviewedToday(v: unknown): BoardReviewedToday | undefined {
  if (!isObj(v)) return undefined;
  const n = count(v["count"], 0);
  const since = text(v["since"]);
  const until = text(v["until"]);
  if (n === undefined || since === undefined || until === undefined) return undefined;
  if (!(Date.parse(since) < Date.parse(until))) return undefined;
  return { count: n, since, until };
}

/**
 * board.json's text as a board, every field re-read; null when it is not one
 * (not JSON, not this format, or with no `reviewing` and `reviewed` lists).
 * The `health` block is passed through as written: its one reader takes it as
 * unread JSON and judges every key itself.
 */
export function parseBoardFile(fileText: string): BoardFile | null {
  let v: unknown;
  try {
    v = JSON.parse(fileText);
  } catch {
    return null;
  }
  if (!isObj(v) || v["format"] !== BOARD_FILE_FORMAT) return null;
  const writtenAt = text(v["written_at"]);
  const reviewing = rowsOf(v["reviewing"], readReviewing);
  const reviewed = rowsOf(v["reviewed"], readReviewed);
  if (writtenAt === undefined || !isObj(v["health"]) || !reviewing || !reviewed) return null;
  const open = rowsOf(v["open"], readOpen);
  const listedAt = text(v["listed_at"]);
  return present({
    format: BOARD_FILE_FORMAT,
    written_at: writtenAt,
    health: v["health"] as unknown as BoardHealth,
    spend: readSpend(v["spend"]),
    reviewed_today: readReviewedToday(v["reviewed_today"]),
    trigger: followedTriggerOf(v["trigger"]),
    reviewing,
    reviewed,
    // the open list and the time it was listed go together or not at all
    open: listedAt !== undefined ? open : undefined,
    listed_at: open !== undefined ? listedAt : undefined,
    more: v["more"] === true ? (true as const) : undefined,
  });
}
