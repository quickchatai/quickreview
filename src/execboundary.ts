// The exec boundary's OUTCOME layer.
//
// Everything else in this system that defends the exec boundary asks about an
// ATTEMPT: `extensions/bash-guard.ts` inspects a command string, `usage.ts`
// re-reads those strings after the fact. hardened the command-string
// guard over four adversarial rounds, and each of the first three looked
// complete to its author and to a green suite while a live bypass stood:
//
//   1. `gh pr review --approve` closed; `gh api … --input` left open — the
//      channel the retro says the predecessor used for EVERY review it posted.
//   2. that closed and `git -c` closed; `gh api -fevent=APPROVE` (same flag,
//      different form) and `git --git-dir=` (same family, third mechanism) left.
//   3. both made structural; `HOME` / `XDG_CONFIG_HOME` — the implicit config
//      search path behind the explicit pointers — left.
//   4. those closed.
//
// The pattern is not "the lists were short". It is that a guard which must
// enumerate every way a general-purpose tool reaches `exec` will be wrong
// again, and that nothing else in the system would have noticed. This module
// asks a different question, and it is the only question in the codebase whose
// answer does not depend on knowing how the write was made:
//
//   **Is there a review on GitHub, authored by the bot, that this daemon has
//   no record of posting?**
//
// A review is the terminal harm of the whole class — bypasses 1 and 2 existed
// to post one, and bypasses 3, 4 and 5 grant the arbitrary execution from which
// one can be posted. GitHub is the authority here, exactly as `reconcile.ts`
// already treats it for every other fact; the read is free, because the comment
// sweep already fetches full review bodies for the same PRs.
//
// FALSIFIABLE CLAIM, stated as a claim so it can be shown false rather than as
// a reassurance: *for a review at a PR's current head, authored by the bot, at
// least one of four local traces exists whenever the daemon or a sanctioned
// script produced it* — the posting marker in the body, a `rounds` row
// carrying its review id, the `reviewed_heads` mark the shell route stamps, or
// a `migration_collision_comment` event. A review at the current head with
// none of them was produced by something else. The claim is testable in both
// directions and this module's tests exercise both.
//
// Known limits, recorded rather than papered over:
//   · It is bounded to the CURRENT head. `reviewed_heads` is one row per PR
//     (upsert), so an older head's legitimate review has no surviving trace and
//     auditing history would be all noise.
//   · `guard_stamp_reviewed_head` in scripts/guards.sh swallows its own
//     failures (`2>/dev/null || true`). A silently failed stamp presents here
//     as an unaccounted review. That is the right way round: a broken ledger
//     and an ungated write are both faults, and the message says so.
//   · It detects; it never blocks. A detector that could wedge a review would
//     be traded away the first time it misfired.

import { createHash } from "node:crypto";
import { readFileSync, readdirSync } from "node:fs";
import { POLICY_SURFACE_DIRS, POLICY_SURFACE_FILES } from "../extensions/bash-guard.js";

// ---- git-config integrity (round 2) --------------------------------
//
// The second thing in this file that asks about an OUTCOME rather than an
// attempt, and it exists because the first review of this ticket demolished the
// layer that did ask about attempts.
//
// The write veto in `extensions/bash-guard.ts` reads command strings, and five
// primitives already on the guard's own read-only allowlist write
// `<clone>/.git/config` straight past it — all five VERIFIED to make a
// subsequent plain `git diff <base> <head>` execute, with the config-scope pin
// in force:
//
//   T=.git/config; cat payload >> $T          find . -maxdepth 0 -fprintf .git/config …
//   awk 'BEGIN{print x >>".git/config"}'      sort -o .git/config payload
//   sed -n 'w .git/config' payload
//
// The first of those settles the design argument: `T=` is not a
// config-injecting variable and the redirection target is `$T`, so **no scan
// over a command string can ever see it.** A write veto built to compensate for
// a command guard's blindness had inherited exactly that blindness. Adding five
// more spellings would have been the fifth round of the same mistake.
//
// So: hash the files at round start, hash them again at round end, and treat a
// change as an anomaly. It enumerates nothing, it is immune to variable
// indirection, and it does not care whether the write came from bash, from the
// write tool, or from something nobody has thought of. It is the same
// philosophy as `auditUngatedReviews` below, applied to the one set of files
// that layer cannot see.
//
// FALSIFIABLE CLAIM: *between the moment a round's worktree is prepared and the
// moment that round is measured, the contents of every file git will read
// configuration or hooks from are unchanged.* Falsify it by changing one and
// getting a clean round — or by naming a config location git reads that
// `gitConfigWatchPaths` omits.
//
// widened the SAME check to this system's own policy surface —
// `config.toml`, the sanctioned scripts, the compiled `dist/`, the extensions
// and the frozen seeds (`policySurfaceWatchPaths`). The write veto refuses a
// redirection or write-tool call onto those paths; this is what sees the one
// spelling no string scan can, `T=config.toml; cat p > $T`. Same claim, second
// path set: *the policy surface is unchanged between worktree preparation and
// round measurement.* The set is read from ONE definition shared with the
// guard (`POLICY_SURFACE_FILES` / `POLICY_SURFACE_DIRS`), so the write veto and
// this check cannot protect different files.
//
// Known limits, stated rather than implied away:
//   · It is a DETECTOR. The write lands; the round completes; the anomaly says
//     so afterwards. It bounds the damage to one round, it does not prevent it.
//     That is the honest trade for a check that needs no enumeration.
//   · Its window is round start → round measurement. A write made and REVERTED
//     inside that window leaves both hashes equal. Closing that needs a
//     filesystem watch, which is a different mechanism and a different ticket.
//   · `unreadable` is recorded distinctly from `absent`, so a permissions
//     change is a change rather than silently matching.

export interface IntegrityFingerprint {
  digest: string;
  /** watched path → `sha256:<hex>` (a file) | `dir:<hex>` (a directory, hashed
   * recursively by content) | "absent" */
  files: Record<string, string>;
}

export interface FingerprintFs {
  readFile: (path: string) => Buffer | string;
  readDir: (path: string) => string[];
  sha256: (data: string) => string;
}

/**
 * Every location git reads configuration or hooks from for THIS round's tree.
 *
 * The list is git's, not ours, and it is deliberately narrow in one direction:
 * `<clone>/.git/worktrees/` is NOT watched wholesale, because other PRs' rounds
 * add and prune sibling worktree directories concurrently and every one of
 * those would be a false alarm. Only this worktree's own per-worktree config is
 * watched.
 */
export function gitConfigWatchPaths(opts: {
  clonePath: string;
  /** Absolute path of this round's worktree; omitted ⇒ only the clone's own. */
  worktreePath?: string | undefined;
  /** The pi HOME whose `.gitconfig` `sessionGitConfigPins` pins git to. The pin
   * relocates the global scope onto ONE named file, which also CONCENTRATES the
   * target — so that file has to be watched, or the pin trades a search path for
   * a single unguarded door. */
  piHome?: string | undefined;
}): string[] {
  const paths = [
    `${opts.clonePath}/.git/config`,
    `${opts.clonePath}/.git/config.worktree`,
    `${opts.clonePath}/.git/hooks`,
    `${opts.clonePath}/.git/info/attributes`,
  ];
  if (opts.worktreePath !== undefined && opts.worktreePath.length > 0) {
    const name = opts.worktreePath.replace(/\/+$/, "").split("/").pop() ?? "";
    // A linked worktree's `.git` is a FILE pointing at the admin dir — swapping
    // that pointer relocates the whole repo scope, so the pointer is watched too.
    paths.push(`${opts.worktreePath}/.git`);
    if (name) paths.push(`${opts.clonePath}/.git/worktrees/${name}/config.worktree`);
  }
  if (opts.piHome !== undefined && opts.piHome.length > 0) paths.push(`${opts.piHome}/.gitconfig`);
  return paths;
}

/**
 * This system's own policy surface under the sandbox root — the
 * files that decide what every layer of the exec boundary DOES. The names come
 * from the guard's own definition, never a second list here.
 */
export function policySurfaceWatchPaths(sandboxRoot: string): string[] {
  const root = sandboxRoot.replace(/\/+$/, "");
  return [...POLICY_SURFACE_FILES, ...POLICY_SURFACE_DIRS].map((name) => `${root}/${name}`);
}

/** Deepest directory nesting the recursive hash follows — a bound against a
 * symlink cycle, well above anything under the sandbox (dist/ is 4 deep). */
const MAX_HASH_DEPTH = 16;

/** One watched path's value: a file's content hash, a directory's RECURSIVE
 * content hash (so a rewritten `scripts/guards.sh` changes `scripts`, not only
 * a planted file — a listing hash would miss the rewrite), or "absent". */
function hashPath(path: string, fs: FingerprintFs, depth: number): string {
  try {
    const raw = fs.readFile(path);
    return `sha256:${fs.sha256(typeof raw === "string" ? raw : raw.toString("utf8"))}`;
  } catch {
    // Not a readable file — a directory, or nothing.
    try {
      const names = fs.readDir(path).sort();
      if (depth <= 0) return `dir:${fs.sha256(names.join("\n"))}`;
      return `dir:${fs.sha256(names.map((n) => `${n}=${hashPath(`${path}/${n}`, fs, depth - 1)}`).join("\n"))}`;
    } catch {
      return "absent";
    }
  }
}

/** Hash every watched path. Total: a missing or unreadable path is a RECORDED
 * value, never a throw — a fingerprint that fails to compute would silently
 * disable the check, which is the failure mode this whole ticket is about. */
export function integrityFingerprint(
  paths: readonly string[],
  fs: FingerprintFs,
): IntegrityFingerprint {
  const files: Record<string, string> = {};
  for (const path of [...paths].sort()) files[path] = hashPath(path, fs, MAX_HASH_DEPTH);
  return {
    digest: fs.sha256(
      Object.entries(files)
        .map(([p, h]) => `${p}=${h}`)
        .join("\n"),
    ),
    files,
  };
}

/** The production fs seam. Injected everywhere so the logic is testable with no
 * disk at all; this is the one place that touches node. */
export const defaultFingerprintFs: FingerprintFs = {
  readFile: (path) => readFileSync(path),
  readDir: (path) => readdirSync(path),
  sha256: (data) => createHash("sha256").update(data).digest("hex"),
};

export interface RoundIntegrityOpts {
  clonePath: string;
  worktreePath?: string | undefined;
  piHome?: string | undefined;
  /** The sandbox root whose policy surface is watched; omitted ⇒
   * git's paths only, which is what a caller with no sandbox has. */
  sandboxRoot?: string | undefined;
}

/**
 * The whole round-side call in one place, so `dispatch.ts` (start) and
 * `verdicts.ts` (end) cannot compute it over DIFFERENT path sets — which would
 * turn every round into a false alarm and get the check switched off.
 */
export function fingerprintRoundIntegrity(
  opts: RoundIntegrityOpts,
  fs: FingerprintFs = defaultFingerprintFs,
): IntegrityFingerprint {
  const paths = gitConfigWatchPaths(opts);
  if (opts.sandboxRoot !== undefined && opts.sandboxRoot.length > 0)
    paths.push(...policySurfaceWatchPaths(opts.sandboxRoot));
  return integrityFingerprint(paths, fs);
}

export interface IntegrityChange {
  path: string;
  before: string;
  after: string;
}

/** Which watched paths changed between the two fingerprints. Empty ⇒ clean. */
export function integrityChanges(
  before: IntegrityFingerprint,
  after: IntegrityFingerprint,
): IntegrityChange[] {
  if (before.digest === after.digest) return [];
  // Total over a malformed fingerprint rather than throwing on one. That is not
  // defensiveness for its own sake: it makes the caller's "no baseline ⇒ never
  // judged" guard LOAD-BEARING instead of a comment in front of an exception
  // the surrounding try/catch happened to swallow. Remove that guard now and a
  // round with no baseline reports every watched path as changed — which a test
  // can see, and which mutation-verification could not see before.
  const beforeFiles = before.files ?? {};
  const afterFiles = after.files ?? {};
  const paths = new Set([...Object.keys(beforeFiles), ...Object.keys(afterFiles)]);
  const out: IntegrityChange[] = [];
  for (const path of [...paths].sort()) {
    const b = beforeFiles[path] ?? "absent";
    const a = afterFiles[path] ?? "absent";
    if (b !== a) out.push({ path, before: b, after: a });
  }
  return out;
}

/** The two families a change can belong to, because they mean different things
 * to the operator and raise different anomalies: git's configuration
 * (`git_config_modified`) and this system's own policy surface
 * (`policy_surface_modified`). Membership is by the watched path, so
 * a caller with no sandbox root has an empty policy half. */
export function splitIntegrityChanges(
  changes: readonly IntegrityChange[],
  sandboxRoot: string | undefined,
): { git: IntegrityChange[]; policy: IntegrityChange[] } {
  const policyPaths = new Set(sandboxRoot ? policySurfaceWatchPaths(sandboxRoot) : []);
  const git: IntegrityChange[] = [];
  const policy: IntegrityChange[] = [];
  for (const c of changes) (policyPaths.has(c.path) ? policy : git).push(c);
  return { git, policy };
}

/** The operator-facing line. Names what a change MEANS, because the reader's
 * first question is "is this an attack or did the daemon do it?" */
export function gitConfigChangeMessage(pr: number, changes: readonly IntegrityChange[]): string {
  return [
    `EXEC BOUNDARY — PR #${pr}: git's configuration changed DURING a round: ${changes.map((c) => c.path).join(", ")}.`,
    "Nothing the daemon does rewrites these files mid-round, so this is a session write. Config-supplied shell",
    "(alias.*, core.pager, diff.external, *.textconv, filter.*.clean, credential.helper, core.sshCommand) turns an",
    "ordinary `git diff` into arbitrary execution, so treat this round's output as untrusted until the file is read.",
    "Restore the file from the daemon's own provisioning, then read the session transcript for the write.",
  ].join("\n");
}

/** The policy-surface twin. A changed root here is the boundary's
 * OWN controls rewritten — config.toml decides dry_run and every posting
 * guard, scripts/ is the gate's shell mirror, dist/ is the guard the container
 * runs — so the message says which root moved and what to do; the round's
 * output AND every later round in this container are suspect until the tree
 * is restored from the deployed revision. */
export function policySurfaceChangeMessage(
  pr: number,
  changes: readonly IntegrityChange[],
): string {
  return [
    `EXEC BOUNDARY — PR #${pr}: this system's OWN policy surface changed DURING a round: ${changes.map((c) => c.path).join(", ")}.`,
    "Nothing the daemon does rewrites these mid-round, so this is a session write that got past the write veto",
    "(a variable-indirected redirection, most likely). config.toml carries dry_run and every posting-guard knob,",
    "scripts/ is the mutation gate's shell mirror and dist/ is the compiled guard itself — so treat this round's",
    "output as untrusted AND assume every later round in this container runs under a rewritten boundary.",
    "Restore the tree from the deployed revision (`git status` / `git diff` in the sandbox names the file),",
    "then read the session transcript for the write.",
  ].join("\n");
}

/** A review as GitHub reports it — the subset this audit needs. */
export interface AuditedReview {
  id: number;
  user: string;
  user_type?: string;
  state: string;
  body: string;
  commit_id: string;
  submitted_at: string | null;
}

/**
 * Every local trace that can account for a bot review, gathered by the caller.
 *
 * The set is exhaustive against the three routes that create a review, and the
 * first two entries are BOTH load-bearing — a point worth stating because it is
 * easy to look at them and think one is redundant:
 *
 *   · `scripts/post-review.sh` and `scripts/approve-pr.sh` stamp the
 *     posting marker into the body, but **only when the round is receipt-keyed**
 *     (`QCR_ROUND_NO` / `QCR_POSTING_KEY` set). It is a conditional marker, not
 *     a universal one, so it cannot be the only trace.
 *   · `reviewed_heads` is the belt for exactly that gap: both shell scripts
 *     stamp it on every live post. It is one UPSERTED row per PR, so it is a
 *     belt with a hole of its own — a marker-less APPROVE at head H followed by
 *     any later COMMENT at the same H loses its trace (docs/exec-boundary.md).
 *   · `rounds.gh_review_id` is the per-review ledger, written when a posting
 *     receipt is confirmed.
 *   · the migration pre-check posts through the gate and deliberately stamps no
 *     mark, so it needs its own.
 *
 * Removing any one of the four turns a legitimate route into a false alarm.
 */
export interface PostingTraces {
  /** `rounds.gh_review_id` for this PR — the per-review ledger. */
  reviewIds: ReadonlySet<number>;
  /** The `reviewed_heads` mark: what the daemon or the shell route last posted. */
  reviewedHead?: { head_sha: string; posted_event: string | null } | undefined;
  /** The PR has had a mechanical migration-collision COMMENT posted through the
   * gate. That route deliberately does NOT stamp `reviewed_heads`, so
   * it needs its own trace. */
  migrationPrecheck: boolean;
}

export interface UngatedReview {
  review_id: number;
  state: string;
  commit_id: string;
  submitted_at: string | null;
}

/** The posting receipt marker: `<!-- qcr-post:v1:<pr>:<round>:<head> -->`.
 * Matched loosely on the prefix — the exact key is verified elsewhere, and a
 * malformed key is not evidence that the sanctioned route was NOT used. */
const POSTING_MARKER_RE = /<!--\s*qcr-post:/;

function isBotAuthored(review: AuditedReview, botLogin: string, appSlug?: string): boolean {
  if (review.user_type === "Bot") return true;
  const login = review.user.toLowerCase();
  return (
    login === botLogin.toLowerCase() ||
    (appSlug !== undefined && login === `${appSlug.toLowerCase()}[bot]`)
  );
}

/**
 * Bot-authored reviews at `headSha` that no local trace accounts for.
 *
 * Pure: the caller gathers the traces and decides what to do with the answer.
 * `PENDING` reviews are skipped — they are drafts GitHub has not submitted, and
 * the bot never creates one.
 */
export function auditUngatedReviews(
  reviews: readonly AuditedReview[],
  headSha: string,
  traces: PostingTraces,
  opts: { botLogin: string; appSlug?: string },
): UngatedReview[] {
  const head = headSha.toLowerCase();
  const out: UngatedReview[] = [];
  // The migration pre-check posts AT MOST ONE comment per head, so it excuses
  // at most one unaccounted COMMENT. The first cut excused every COMMENT
  // forever on any PR that had ever had one — a permanent detection hole opened
  // by an unbounded flag, the same shape as the claim-without-a-bound
  // rule. It is still not bounded to the RIGHT one; that limit is recorded in
  // docs/exec-boundary.md rather than implied away.
  let migrationExcusesLeft = traces.migrationPrecheck ? 1 : 0;
  for (const r of reviews) {
    if (!isBotAuthored(r, opts.botLogin, opts.appSlug)) continue;
    const state = (r.state ?? "").toUpperCase();
    if (state === "PENDING" || state === "DISMISSED") continue;
    if ((r.commit_id ?? "").toLowerCase() !== head) continue;
    if (POSTING_MARKER_RE.test(r.body ?? "")) continue;
    if (traces.reviewIds.has(r.id)) continue;
    // The shell route's mark. For an APPROVE the mark must ALSO say APPROVE:
    // an approval is the one outcome the whole gate exists to control, and
    // "some review was posted at this head" is not evidence that an approval
    // was among them.
    const mark = traces.reviewedHead;
    if (mark && mark.head_sha.toLowerCase() === head) {
      if (state !== "APPROVED") continue;
      if ((mark.posted_event ?? "").toUpperCase() === "APPROVE") continue;
    }
    // The gate's mechanical pre-check COMMENT, which stamps no mark by design.
    if (state === "COMMENTED" && migrationExcusesLeft > 0) {
      migrationExcusesLeft--;
      continue;
    }
    out.push({ review_id: r.id, state, commit_id: r.commit_id, submitted_at: r.submitted_at });
  }
  return out;
}

/** An unaccounted APPROVE is the severe case: rule 1, the CI hard-gate and
 * every posting guard are bypassed at once. Anything else is still reported,
 * but only this escalates to an overseer anomaly. */
export function hasUngatedApproval(found: readonly UngatedReview[]): boolean {
  return found.some((r) => r.state === "APPROVED");
}

/** The operator-facing line. Deliberately names BOTH readings — an ungated
 * write and a failed local stamp are different faults with the same shape here,
 * and asserting the wrong one would send the reader down the wrong path. */
export function ungatedReviewMessage(pr: number, found: readonly UngatedReview[]): string {
  const list = found
    .map((r) => `${r.state} review ${r.review_id} at ${r.commit_id.slice(0, 7)}`)
    .join("; ");
  return [
    `EXEC BOUNDARY — PR #${pr}: ${found.length} bot-authored review(s) at the current head with no local posting record: ${list}.`,
    "Two readings, both faults: (a) something posted to GitHub outside the mutation gate and the posting guards —",
    "check the round's session transcript and the exec_policy_violation events; or (b) the daemon posted it and the",
    "reviewed_heads stamp failed silently (scripts/guards.sh swallows that error), which breaks guard 2 for this PR.",
    "Rule out (a) first. This check only reports: it never withdraws, retracts or edits a review.",
  ].join("\n");
}
