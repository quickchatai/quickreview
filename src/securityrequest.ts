// On-demand security review: a maintainer's PR label or `@<bot> security`
// comment, or the operator's `qcr review-now <pr> --security`.
//
// A request is one row in `pr_review_requests` (kind `security`). While it
// stands, every round of the PR plans the whole security family
// (packages/pi-plugin/src/planner.ts, `PlanSecurityInputs.securityRequest`); a
// request never plans a lens the profile switched off or skipped. It is
// served once: the reviewed-head mark is stamped with new evidence
// (`noteNewEvidence`) and the PR is triggered, so a PR already reviewed at its
// head is reviewed again rather than skipped by guard 2. An explicit
// maintainer request is new evidence; nothing else about it widens the posting
// boundary. A request that lands while a round runs — or while one is being
// prepared, after its inputs were read — waits for that round to settle (the
// round was planned without it, and its verdict re-stamps the mark), and the
// reconcile pass serves it then (`sweepSecurityRequests`). The first round
// that answers a request reviews the whole PR, never a follow-up over the
// change since a review that ran no security family.
//
// Who may ask: a label needs triage rights on GitHub already, and whoever set
// it counts — a person or an auto-labeler alike, since a polling install never
// learns who set a label at all; a comment is
// accepted only from an OWNER, MEMBER or COLLABORATOR (`author_association`),
// and only while `[security] command` is on. Anything else is ignored with a
// logged reason and no reply. The one reply is the acknowledgement of a fresh
// comment request, posted through the gate's `create_issue_comment` (so
// dry-run suppresses it).
//
// This module also holds the daemon's read-only git reader for what the
// security rows read from the repository: the threat model at the BASE commit
// (`.qcr/threat-model.md`) and the deterministic security facts
// (packages/pi-plugin/src/secfacts.ts). Reads are `git ls-tree` and `git
// cat-file` in the base clone with the daemon's git pins; nothing is checked
// out, rendered or executed (docs/exec-boundary.md).
import type { ExecFn } from "@quickchatai/pi-quickreview/src/execfn.js";
import {
  computeSecurityFacts,
  SEC_FACT_CHECKS,
  SECURITY_FACTS_MAX_FILES,
  type SecFactCheck,
  type SecurityFact,
  type SecurityFactsIo,
} from "@quickchatai/pi-quickreview/src/secfacts.js";
import { REPO_THREAT_MODEL_PATH } from "@quickchatai/pi-quickreview/src/threatmodel.js";
import { promptQuoted } from "@quickchatai/pi-quickreview/src/codespan.js";
import type { SecurityRequest } from "@quickchatai/pi-quickreview/src/types.js";
import type { PrFileEntry } from "./github.js";
import type { ReviewRequestRow, StateStore } from "./state.js";
import { applyEvent, isBotAuthor, type PrMeta } from "./statemachine.js";
import type { RoundFindingRow } from "@quickchatai/pi-quickreview/src/storerows.js";

/** The `pr_review_requests` kind a security request is recorded under. */
export const SECURITY_REQUEST_KIND = "security";

/**
 * One kind of on-demand review: the row kind it is recorded under, the word
 * its comment command takes (`@<bot> <word>`), and how its acknowledgement
 * reads. Every function below serves the security kind unless it is handed
 * another (src/staterequest.ts hands the state-machine one), so two kinds of
 * request live side by side on one PR, each with its own row, label and
 * serving.
 */
export interface ReviewRequestKind {
  /** The `pr_review_requests.kind` value. */
  kind: string;
  /** The command word, as a regex source (`security`, `state[- ]machines?`). */
  commandWord: string;
  /** The command as a person reads it, for the event log. */
  commandName: string;
  /** The config key that switches the command off, for the event log. */
  commandKey: string;
  /** The hidden marker on the acknowledgement. */
  ackMarker: string;
  /** The acknowledgement's sentence, before the asker and the marker. */
  ackTitle: string;
  ackBody: string;
}

/** The `author_association` values whose `@<bot> security` is accepted. */
export const SECURITY_REQUEST_ASSOCIATIONS: ReadonlySet<string> = new Set([
  "OWNER",
  "MEMBER",
  "COLLABORATOR",
]);

/** The hidden marker on the acknowledgement, so it reads as the reviewer's
 * own content (packages/pi-plugin/src/identity.ts) on every route. */
export const SECURITY_ACK_MARKER = "<!-- qcr-security-request -->";

/** The security request, as a `ReviewRequestKind`. */
export const SECURITY_REQUEST: ReviewRequestKind = {
  kind: SECURITY_REQUEST_KIND,
  commandWord: "security",
  commandName: "security",
  commandKey: "[security] command",
  ackMarker: SECURITY_ACK_MARKER,
  ackTitle: "Security review requested",
  ackBody: "The next review round of this pull request runs the security lenses.",
};

// ---- the comment grammar ---------------------------------------------------

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * Whether a comment body is the security command: its first line is
 * `@<bot> security` or `@<bot> security review`, case-insensitive, where
 * `<bot>` is the bot login without its `[bot]` suffix. Anything after the
 * first line is free text. False for an empty login.
 */
export function isSecurityCommand(
  body: unknown,
  botLogin: string,
  k: ReviewRequestKind = SECURITY_REQUEST,
): boolean {
  if (typeof body !== "string") return false;
  const mention = botLogin.replace(/\[bot\]$/i, "").trim();
  if (mention === "") return false;
  const first = (body.replace(/^\uFEFF/, "").split(/\r?\n/, 1)[0] ?? "").trim();
  return new RegExp(
    `^@${escapeRegExp(mention)}\\s+(?:${k.commandWord})(?:\\s+review)?\\s*$`,
    "i",
  ).test(first);
}

/**
 * Decide a comment that may be the security command. Null when it is not the
 * command at all (route it as any other comment); otherwise accepted, or
 * refused with the reason the event log records — the command switched off
 * (`[security] command = false`), or an author who is not an owner, member or
 * collaborator of the repository.
 */
export function securityCommandDecision(
  comment: { body: unknown; author_association?: unknown },
  opts: { botLogin: string; command: boolean },
  k: ReviewRequestKind = SECURITY_REQUEST,
): null | { ok: true } | { ok: false; reason: string } {
  if (!isSecurityCommand(comment.body, opts.botLogin, k)) return null;
  if (!opts.command)
    return { ok: false, reason: `${k.commandName} command is off (${k.commandKey})` };
  const association =
    typeof comment.author_association === "string" ? comment.author_association : "";
  if (!SECURITY_REQUEST_ASSOCIATIONS.has(association))
    return {
      ok: false,
      reason: `${k.commandName} command from a non-collaborator (author_association ${association || "unknown"})`,
    };
  return { ok: true };
}

/** How long before the PR's tracking began a command found on its first
 * comment sweep is still taken as a live request: a polling install sees no
 * comment on a PR it does not track, so a command made just before the PR
 * was adopted is heard late rather than never. */
export const SECURITY_COMMAND_HISTORY_GRACE_MS = 24 * 60 * 60 * 1000;

/**
 * Whether a command the reconcile comment sweep captured for the first time
 * is history rather than a live request: the reason when it is, else null.
 * Capturing a comment for the first time does not make it new — a fresh
 * state database, or a PR first tracked long after the comment, sweeps the
 * PR's whole history. Two facts tell history:
 *
 * - `acknowledged`: a later comment of the reviewer's own (`isOwn`) carries
 *   the acknowledgement marker, so a request was recorded after this command
 *   was made;
 * - `predates-tracking`: on the PR's first sweep (`trackedAt`, when this
 *   daemon began tracking it, is given then), a command made more than the
 *   grace before that.
 *
 * A command whose age cannot be read on a first sweep is history too.
 */
export function staleSecurityCommand(
  c: { id: number; created_at: string | null },
  ctx: {
    comments: ReadonlyArray<{ id: number; user: string; body: string }>;
    isOwn: (user: string, body: string) => boolean;
    trackedAt?: string;
  },
  k: ReviewRequestKind = SECURITY_REQUEST,
): "acknowledged" | "predates-tracking" | null {
  if (
    ctx.comments.some(
      (d) => d.id > c.id && d.body.includes(k.ackMarker) && ctx.isOwn(d.user, d.body),
    )
  )
    return "acknowledged";
  if (ctx.trackedAt !== undefined) {
    const made = Date.parse(c.created_at ?? "");
    const tracked = Date.parse(ctx.trackedAt);
    if (Number.isFinite(tracked) && !(made >= tracked - SECURITY_COMMAND_HISTORY_GRACE_MS))
      return "predates-tracking";
  }
  return null;
}

/** The acknowledgement of a fresh comment request. */
export function securityAckBody(by: string, k: ReviewRequestKind = SECURITY_REQUEST): string {
  const who = by ? ` (asked by @${by})` : "";
  return `${k.ackTitle}${who}. ${k.ackBody}\n\n${k.ackMarker}`;
}

// ---- applying and serving a request ----------------------------------------

export interface SecurityRequestInput {
  pr: number;
  source: ReviewRequestRow["source"];
  /** The login that asked; "" when it is not known. */
  by: string;
  comment_id?: number;
}

export type SecurityRequestOutcome =
  /** A request already stands for the PR, or the PR is closed: nothing was
   * written and nothing is queued. `upgraded`: a comment or operator request
   * took over a standing label request — the row now stands on the asker's
   * word (the label coming off no longer withdraws it), keeps its serving,
   * and queues nothing more; a comment is acknowledged. */
  | { fresh: false; reason: "already-requested" | "closed" | "upgraded" }
  /** The request was recorded. `served`: it reached the queue now; false
   * while a running round settles first, or for a PR this daemon does not
   * track yet (the reconcile pass adopts it from its open list). */
  | { fresh: true; served: boolean };

/**
 * Record a security request and serve it when it can be served now. One
 * transaction: the row, the evidence note and the trigger commit together.
 */
export function applySecurityRequest(
  store: StateStore,
  req: SecurityRequestInput,
  opts: { meta?: PrMeta; botLogin?: string; now?: () => Date } = {},
  kind: string = SECURITY_REQUEST_KIND,
): SecurityRequestOutcome {
  return store.db
    .transaction((): SecurityRequestOutcome => {
      if (store.getPr(req.pr)?.state === "closed") {
        store.logEvent("review_request_ignored", req.pr, {
          kind,
          source: req.source,
          by: req.by,
          reason: "pr-closed",
        });
        return { fresh: false, reason: "closed" };
      }
      const row = {
        pr: req.pr,
        kind,
        source: req.source,
        requested_by: req.by,
        ...(req.comment_id !== undefined ? { comment_id: req.comment_id } : {}),
      };
      const fresh = store.recordReviewRequest(row);
      if (!fresh)
        return {
          fresh: false,
          reason: store.upgradeLabelReviewRequest(row) ? "upgraded" : "already-requested",
        };
      return { fresh: true, served: serveInTransaction(store, req.pr, opts, kind) };
      // Reads, then writes: IMMEDIATE takes the write lock up front, so a busy
      // writer elsewhere is waited for rather than failing the upgrade.
    })
    .immediate();
}

/**
 * Hand a waiting request to the queue: note new evidence at the reviewed
 * head (once — the row is stamped served in the same transaction) and
 * trigger the PR, the same `trigger`/`manual` event `qcr review-now` uses.
 * False — and nothing written — while a round runs (the PR reviewing, or a
 * round of it started and not yet handed off: that round was planned without
 * the request), for a closed PR, for a PR not tracked here with no head to
 * adopt it at, or for a request already served. A bot-authored PR is never
 * reviewed: its request is withdrawn.
 */
export function serveSecurityRequest(
  store: StateStore,
  pr: number,
  opts: { meta?: PrMeta; botLogin?: string; now?: () => Date } = {},
  kind: string = SECURITY_REQUEST_KIND,
): boolean {
  // Reads, then writes: IMMEDIATE, as above.
  return store.db.transaction(() => serveInTransaction(store, pr, opts, kind)).immediate();
}

/** `serveSecurityRequest`'s body, for a caller already holding the write
 * transaction. */
function serveInTransaction(
  store: StateStore,
  pr: number,
  opts: { meta?: PrMeta; botLogin?: string; now?: () => Date },
  kind: string,
): boolean {
  const req = store.reviewRequest(pr, kind);
  if (!req || req.served_at !== null) return false;
  const row = store.getPr(pr);
  if (row?.state === "reviewing" || row?.state === "closed") return false;
  if (row && store.hasRunningRound(pr)) return false;
  if (!row && !opts.meta?.head_sha) return false;
  const now = opts.now ?? (() => new Date());
  const result = applyEvent(store, pr, { type: "trigger", source: "manual" }, opts.meta ?? {}, {
    ...(opts.botLogin !== undefined ? { botLogin: opts.botLogin } : {}),
    now,
    reason: `${kind}-request:${req.source}`,
  });
  if (result.skipped) {
    store.clearReviewRequests(pr, "bot-author", kind);
    return false;
  }
  store.noteNewEvidence(pr, now().toISOString());
  store.markReviewRequestServed(pr, kind);
  return true;
}

/**
 * Dispatch's half of "a request that lands while a round runs waits for it":
 * a request recorded while this round was being prepared — after its security
 * inputs were read, before its round row existed — was served into a queue
 * whose plan was already built without it. Called in the same turn as the
 * round row's start, for a round planned with no request; `seen` is the
 * `requested_at` of the row the inputs read (undefined: there was none). A
 * row recorded since, and served, loses its served stamp, so it waits for
 * this round to settle and the reconcile pass serves it then
 * (`sweepSecurityRequests`), with the family planned. A row the inputs saw is
 * left alone: the plan left it out on purpose (its label is off). True when a
 * request was put back.
 */
export function deferUncoveredSecurityRequest(
  store: StateStore,
  pr: number,
  seen: string | undefined,
  kind: string = SECURITY_REQUEST_KIND,
): boolean {
  const req = store.reviewRequest(pr, kind);
  if (!req || req.served_at === null || req.requested_at === seen) return false;
  return store.unserveReviewRequest(pr, kind, "served-during-preparation");
}

/**
 * Whether the PR's standing security request has been answered by a round
 * that looked at the whole PR: a live round with a verdict, started at or
 * after the request was served, that was a first review, a full re-review or
 * a follow-up whose whole-PR sweep ran. Until then a re-review is not a
 * follow-up over the change since the last reviewed head — an ordinary
 * approval before the request says nothing about the security family, and a
 * delta (empty, at the same head) would hand the family nothing to inspect.
 * False with no recorded request (a label GitHub shows that the reconcile
 * pass has not recorded yet is new as far as anything here knows).
 */
export function securityRequestCovered(
  store: StateStore,
  pr: number,
  kind: string = SECURITY_REQUEST_KIND,
): boolean {
  const req = store.reviewRequest(pr, kind);
  if (!req || req.served_at === null) return false;
  const servedAt = req.served_at;
  return store
    .roundsFor(pr)
    .some(
      (r) =>
        r.backfilled === 0 &&
        r.verdict !== null &&
        r.started_at >= servedAt &&
        (r.round_type === "first" ||
          r.scope === null ||
          r.scope === "full" ||
          r.sweep_status === "ran"),
    );
}

/**
 * The webhook's half of the label's edge: the security label came off the
 * PR, so a request standing on the label alone is withdrawn — and the label
 * put back records a fresh one. A comment or operator request (or a label
 * request one of those took over) stands on the asker's word and is kept.
 * True when a row went.
 */
export function withdrawLabelSecurityRequest(
  store: StateStore,
  pr: number,
  kind: string = SECURITY_REQUEST_KIND,
): boolean {
  if (store.reviewRequest(pr, kind)?.source !== "label") return false;
  return store.clearReviewRequests(pr, "label-removed", kind);
}

/**
 * The reconcile pass's half (GitHub wins): withdraw a label request whose
 * label is no longer on the PR, drop every request of a PR that closed or is
 * not open any more, record a label request for an open PR that carries the
 * label with no request standing, and serve each waiting request whose PR has
 * no round running — adopting a PR this daemon does not track from the open
 * list.
 *
 * The label is read here because a polling install has no `labeled` webhook
 * at all, and a webhook install can miss one: without this, a label added to
 * a PR already reviewed at its head would start nothing until some other
 * trigger did. The standing row is the label's edge record: it stays while
 * the label does, so a label left on records nothing new, and taking it off
 * and putting it back records a fresh request. Who set the label is not known
 * here (`requested_by` ""). A bot-authored PR is never reviewed, so its label
 * records nothing; neither does a paused PR's until it is resumed.
 *
 * `open` is the open-PR list this pass read, or null when it failed (then
 * nothing is withdrawn or dropped, and only tracked PRs are served).
 * `listedAt` is when it was read: a request recorded after it is not judged
 * by a list that could not have held its PR.
 */
export function sweepSecurityRequests(
  store: StateStore,
  a: {
    open: ReadonlyMap<
      number,
      { title: string; head_sha: string; author: string; labels: readonly string[] }
    > | null;
    listedAt: string;
    label: string;
    botLogin?: string;
    now?: () => Date;
    /** The request kind this sweep serves; absent ⇒ security. The pass runs
     * once per kind, each with its own label. */
    kind?: string;
  },
): { served: number[]; cleared: number[] } {
  const kind = a.kind ?? SECURITY_REQUEST_KIND;
  const served: number[] = [];
  const cleared: number[] = [];
  for (const pr of store.reviewRequestPrs()) {
    const req = store.reviewRequest(pr, kind);
    const listed = req !== undefined && req.requested_at <= a.listedAt;
    if (store.getPr(pr)?.state === "closed" || (a.open !== null && listed && !a.open.has(pr))) {
      if (store.clearReviewRequests(pr, "pr-closed")) cleared.push(pr);
      continue;
    }
    const ref = a.open?.get(pr);
    if (
      req?.source === "label" &&
      listed &&
      ref !== undefined &&
      (a.label === "" || !ref.labels.includes(a.label))
    ) {
      if (store.clearReviewRequests(pr, "label-removed", kind)) cleared.push(pr);
    }
  }
  const meta = (ref: { title: string; head_sha: string; author: string }): PrMeta => ({
    title: ref.title,
    head_sha: ref.head_sha,
    author: ref.author,
  });
  const opts = {
    ...(a.botLogin !== undefined ? { botLogin: a.botLogin } : {}),
    ...(a.now ? { now: a.now } : {}),
  };
  if (a.open !== null && a.label !== "") {
    for (const [pr, ref] of a.open) {
      if (!ref.labels.includes(a.label)) continue;
      if (store.reviewRequest(pr, kind) !== undefined) continue;
      if (a.botLogin !== undefined && isBotAuthor(ref.author, a.botLogin)) continue;
      const local = store.getPr(pr);
      if (local?.state === "closed" || local?.paused) continue;
      const outcome = applySecurityRequest(
        store,
        { pr, source: "label", by: "" },
        { meta: meta(ref), ...opts },
        kind,
      );
      if (outcome.fresh && outcome.served) served.push(pr);
    }
  }
  for (const req of store.unservedReviewRequests()) {
    if (req.kind !== kind) continue;
    const ref = a.open?.get(req.pr);
    if (serveSecurityRequest(store, req.pr, { ...(ref ? { meta: meta(ref) } : {}), ...opts }, kind))
      served.push(req.pr);
  }
  return { served, cleared };
}

/**
 * The request a round of this PR plans with, or none. A comment or operator
 * request stands until the PR closes. A label request stands while the label
 * is on the PR: `labels` is what GitHub said this round (null when the read
 * failed — then the recorded request stands). A configured label on the PR
 * with no row yet (its webhook was missed, or the install polls, and the
 * reconcile pass has not recorded it) is a request whose asker is not known.
 */
export function resolveSecurityRequest(a: {
  row: ReviewRequestRow | undefined;
  labels: readonly string[] | null;
  label: string;
}): SecurityRequest | undefined {
  const labelled = a.label !== "" && a.labels !== null && a.labels.includes(a.label);
  if (a.row && (a.row.source !== "label" || a.labels === null || labelled))
    return { by: a.row.requested_by, source: a.row.source };
  if (labelled) return { by: "", source: "label" };
  return undefined;
}

// ---- earlier rounds' partial chains -----------------------------------------

/** The most partial chains a `delta` row is handed. */
export const PRIOR_PARTIAL_CHAINS_MAX = 10;
const PARTIAL_CHAIN_LINE_MAX = 300;

/**
 * Earlier rounds' `partial-chain` records as one line each — where, and what
 * the record says — for the chain's `delta` row (`RoundOrder.prior_partial_chains`).
 * Each line is flattened (no line break can start a new instruction) and
 * capped; the task renders them under an UNCONFIRMED heading.
 */
export function partialChainLeads(rows: readonly RoundFindingRow[]): string[] {
  return rows.slice(0, PRIOR_PARTIAL_CHAINS_MAX).map((r) => {
    const where = r.path ? `${r.path}${r.line ? `:${r.line}` : ""}` : "(no anchor)";
    const what = r.title ?? r.reason ?? r.finding_key;
    const line = promptQuoted(`round ${r.round_no}: ${where} — ${what}`);
    return line.length > PARTIAL_CHAIN_LINE_MAX
      ? `${line.slice(0, PARTIAL_CHAIN_LINE_MAX - 1)}…`
      : line;
  });
}

// ---- the repository reads ---------------------------------------------------

/** Read-only access to the reviewed repository's committed files. */
export interface RepoGitReader {
  /** Every regular file at `sha`, with its size in bytes; null when the
   * listing failed. */
  listFiles(sha: string): Promise<ReadonlyArray<{ path: string; size: number }> | null>;
  /** A file's text at `sha`; null when it is absent, not a regular file,
   * over `maxBytes`, or unreadable. `knownSize`, the size `listFiles` gave
   * for this regular file at this `sha`, spares the reader asking for it. */
  readFile(
    sha: string,
    path: string,
    maxBytes?: number,
    knownSize?: number,
  ): Promise<string | null>;
}

const SHA_RE = /^[0-9a-f]{7,64}$/i;
/** The largest file a fact check or the threat model reads. */
export const REPO_READ_MAX_BYTES = 1024 * 1024;
/** The largest threat model read — what the repo-profile extraction caps a
 * `.qcr/` file at; the parser cuts the text it keeps further. */
export const THREAT_MODEL_READ_MAX_BYTES = 256 * 1024;

/**
 * The reader over a git directory (the daemon's base clone): `git ls-tree`
 * and `git cat-file` only, through `exec` (the daemon passes
 * `pinnedGitExec`, which carries its git pins). A sha that is not a sha, or
 * a path that could be read as an option or names no file, reads as null.
 */
export function gitRepoReader(exec: ExecFn, gitDir: string): RepoGitReader {
  const git = (args: string[]) => exec("git", args, { cwd: gitDir, timeoutMs: 30_000 });
  return {
    async listFiles(sha) {
      if (!SHA_RE.test(sha)) return null;
      try {
        const res = await git(["ls-tree", "-r", "-z", "--long", sha]);
        if (res.code !== 0) return null;
        const out: Array<{ path: string; size: number }> = [];
        for (const entry of res.stdout.split("\0")) {
          const tab = entry.indexOf("\t");
          if (tab < 0) continue;
          const [mode, type, , size] = entry.slice(0, tab).split(/\s+/);
          if (type !== "blob" || (mode !== "100644" && mode !== "100755")) continue;
          out.push({ path: entry.slice(tab + 1), size: Number(size) });
        }
        return out;
      } catch {
        return null;
      }
    },
    async readFile(sha, path, maxBytes = REPO_READ_MAX_BYTES, knownSize) {
      if (!SHA_RE.test(sha) || path === "" || path.includes("\0") || path.startsWith("/"))
        return null;
      const spec = `${sha}:${path}`;
      try {
        // A tree or a submodule has a size too; `cat-file blob` refuses it.
        // A size the listing gave is a regular file's: one spawn, not two.
        if (knownSize !== undefined) {
          if (!(knownSize <= maxBytes)) return null;
        } else {
          const size = await git(["cat-file", "-s", spec]);
          if (size.code !== 0 || !(Number(size.stdout.trim()) <= maxBytes)) return null;
        }
        const blob = await git(["cat-file", "blob", spec]);
        return blob.code === 0 ? blob.stdout : null;
      } catch {
        return null;
      }
    },
  };
}

/** The repository's threat model at the base commit, or null. */
export async function readRepoThreatModel(
  reader: RepoGitReader | undefined,
  baseSha: string,
): Promise<string | null> {
  if (!reader || !baseSha) return null;
  return reader.readFile(baseSha, REPO_THREAT_MODEL_PATH, THREAT_MODEL_READ_MAX_BYTES);
}

/** How many times the facts are recomputed while their reads are fetched. */
const FACT_PASSES = 4;
/** The most files the facts read in all, over both commits. */
export const FACT_READS_MAX = 4 * SECURITY_FACTS_MAX_FILES;
const FACT_READ_CONCURRENCY = 8;

/**
 * The security facts with their repository reads served from git.
 * `computeSecurityFacts` reads synchronously, so the facts are computed over a
 * cache: each pass records the reads it missed, they are fetched, and the
 * facts are computed again — until a pass misses nothing, or the passes or the
 * read budget run out, when a read still missing answers null and its check
 * says `unknown`, never `clear`. With no reader or no head, only the two
 * diff-only checks run.
 *
 * `checks` limits the run to those checks (dispatch computes the ones that
 * can plan a lens before the plan, and the route inventory only for a round
 * that plans a family row). Past `deadline` (epoch ms) no read is issued:
 * the facts are computed over what was read, the rest `unknown` — so a caller
 * that stopped waiting leaves no reads running behind it.
 */
export async function securityFactsAt(
  files: PrFileEntry[],
  reader: RepoGitReader | undefined,
  shas: { head: string; base: string },
  opts: { checks?: readonly SecFactCheck[]; deadline?: number; now?: () => number } = {},
): Promise<SecurityFact[]> {
  const checks = opts.checks ?? SEC_FACT_CHECKS;
  const now = opts.now ?? Date.now;
  const late = (): boolean => opts.deadline !== undefined && now() >= opts.deadline;
  if (!reader || !shas.head) return computeSecurityFacts(files, null, checks);
  const listing = await reader.listFiles(shas.head);
  const headSizes = new Map((listing ?? []).map((f) => [f.path, f.size]));
  const cache = new Map<string, string | null>();
  let budget = FACT_READS_MAX;
  let facts: SecurityFact[] = [];
  for (let pass = 0; pass < FACT_PASSES; pass++) {
    const missed = new Map<string, { sha: string; path: string; size?: number }>();
    const read = (side: "head" | "base", path: string): string | null => {
      const key = `${side}\0${path}`;
      if (cache.has(key)) return cache.get(key)!;
      const sha = side === "head" ? shas.head : shas.base;
      if (!sha) return null;
      if (side === "head" && listing !== null && !headSizes.has(path)) return null;
      const size = side === "head" ? headSizes.get(path) : undefined;
      missed.set(key, { sha, path, ...(size !== undefined ? { size } : {}) });
      return null;
    };
    const io: SecurityFactsIo = {
      readHead: (p) => read("head", p),
      readBase: (p) => read("base", p),
      listHead: () => (listing === null ? null : listing.map((f) => f.path)),
    };
    facts = computeSecurityFacts(files, io, checks);
    if (missed.size === 0 || budget <= 0 || pass === FACT_PASSES - 1 || late()) break;
    const todo = [...missed].slice(0, budget);
    budget -= todo.length;
    for (let i = 0; i < todo.length; i += FACT_READ_CONCURRENCY) {
      if (late()) break;
      const chunk = todo.slice(i, i + FACT_READ_CONCURRENCY);
      const texts = await Promise.all(
        chunk.map(([, r]) => reader.readFile(r.sha, r.path, undefined, r.size)),
      );
      chunk.forEach(([key], j) => cache.set(key, texts[j] ?? null));
    }
  }
  return facts;
}
