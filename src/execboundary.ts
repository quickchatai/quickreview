// The exec boundary's OUTCOME layer (docs/exec-boundary.md).
//
// Everything else in this system that defends the exec boundary asks about an
// ATTEMPT: `extensions/bash-guard.ts` inspects a command string, `usage.ts`
// re-reads those strings after the fact. A guard which must enumerate every
// way a general-purpose tool reaches `exec` (`gh api … --input`,
// `-fevent=APPROVE`, `git --git-dir=`, `HOME` / `XDG_CONFIG_HOME` …) will
// always miss a spelling, and nothing else would notice. This module asks a
// different question, and it is the only question in the codebase whose
// answer does not depend on knowing how the write was made:
//
//   **Is there a review on GitHub, authored by the bot, that this daemon has
//   no record of posting?**
//
// A review is the terminal harm of the whole class — every command-string
// bypass either posts one directly or grants the arbitrary execution from
// which one can be posted. GitHub is the authority here, exactly as
// `reconcile.ts` treats it for every other fact; the read is free, because
// the comment sweep already fetches full review bodies for the same PRs.
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
import { readFile, readdir } from "node:fs/promises";
import { POLICY_SURFACE_DIRS, POLICY_SURFACE_FILES } from "../extensions/bash-guard.js";
import { homeProfileDirs, locateConfig, type InstallEnv } from "./install.js";
import { yieldToLoop } from "./yieldloop.js";

// ---- git-config integrity ---------------------------------------------------
//
// The second thing in this file that asks about an OUTCOME rather than an
// attempt.
//
// The write veto in `extensions/bash-guard.ts` reads command strings, and a
// write to `<clone>/.git/config` makes a later plain `git diff <base> <head>`
// execute config-supplied shell. Some spellings of that write can never be
// seen by a string scan:
//
//   T=.git/config; cat payload >> $T
//
// `T=` is not a config-injecting variable and the redirection target is `$T`,
// so **no scan over a command string can ever see it.**
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
// The SAME check covers this system's own policy surface —
// `config.toml`, the sanctioned scripts, the compiled `dist/`, the extensions
// and the frozen seeds (`policySurfaceWatchPaths`). The write veto refuses a
// redirection or write-tool call onto those paths; this is what sees the one
// spelling no string scan can, `T=config.toml; cat p > $T`. Same claim, second
// path set: *the policy surface is unchanged between worktree preparation and
// round measurement.* The set is read from ONE definition shared with the
// guard (`POLICY_SURFACE_FILES` / `POLICY_SURFACE_DIRS`), so the write veto and
// this check cannot protect different files.
//
// The LIVE config is not `<sandbox>/config.toml` but wherever the install
// locator finds it (on the VM, the shipped config home named by
// `$QCR_CONFIG`), so layer 4 also watches that located file and the
// config home's `profiles/` (`locatedPolicyWatchPaths`). Those are concrete
// paths, not names under the root, so they sit beside the one definition
// rather than in it; the write veto's path shape is unchanged.
//
// Known limits, stated rather than implied away:
//   · It is a DETECTOR. The write lands; the round completes; the anomaly says
//     so afterwards. It bounds the damage to one round, it does not prevent it.
//     That is the honest trade for a check that needs no enumeration.
//   · Its window is round start → round measurement. A write made and REVERTED
//     inside that window leaves both hashes equal. Closing that needs a
//     filesystem watch, which is a different mechanism.
//   · `unreadable` is recorded distinctly from `absent`, so a permissions
//     change is a change rather than silently matching.

export interface IntegrityFingerprint {
  digest: string;
  /** watched path → `sha256:<hex>` (a file) | `dir:<hex>` (a directory, hashed
   * recursively by content) | "absent" | `unreadable:<errno>` */
  files: Record<string, string>;
}

/** The fingerprint's filesystem seam. Production reads are async; a test
 * double may answer synchronously — every call is awaited. */
export interface FingerprintFs {
  readFile: (path: string) => Buffer | string | Promise<Buffer | string>;
  readDir: (path: string) => string[] | Promise<string[]>;
  /** Over a file's BYTES as read (a string is hashed as its UTF-8 bytes). */
  sha256: (data: string | Uint8Array) => string;
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
    if (name) {
      paths.push(`${opts.clonePath}/.git/worktrees/${name}/config.worktree`);
      // The admin dir's `commondir` names the COMMON dir git reads the shared
      // config and hooks from — rewriting it relocates both without touching
      // any other watched file, the same shape as the `.git` pointer above.
      paths.push(`${opts.clonePath}/.git/worktrees/${name}/commondir`);
    }
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

/**
 * The policy surface that lives OUTSIDE the sandbox root: the LIVE config,
 * wherever the install locator finds it (`$QCR_CONFIG` — on the VM the
 * shipped config home, whose basename is the operator's
 * choice — else `<config home>/config.toml`), and the profile directories the
 * loader reads from the homes (`<config home>/profiles`, and `profiles/`
 * beside `$QCR_CONFIG` — the locator's own list, `homeProfileDirs`, so a new
 * place `locateProfile` searches is watched too). A profile's `profile.toml` and `addenda/` change what every
 * pass does, so they are policy exactly as `config.toml` is.
 *
 * Deliberately NOT the rest of the config home: `secrets/` is credentials (not
 * behaviour, and none of this check's business to hash) and `portrait/` is the
 * operator's narrative. The checkout's own `profiles/` (the generic examples)
 * is not added here either: it is not in the write veto's one definition, and
 * widening that is a separate decision.
 *
 * Resolved from `env` (default: this process's), so dispatch's baseline and
 * verdicts' re-check — same process, same env — watch the same set.
 */
export function locatedPolicyWatchPaths(env: InstallEnv = process.env): string[] {
  return [...new Set([locateConfig({ env }).path, ...homeProfileDirs(env)])];
}

/** The whole policy half of a round's watch set: the sandbox's own surface and
 * the located config's, deduplicated (`$QCR_CONFIG` may name the sandbox's own
 * `config.toml`). ONE function for both the fingerprint and the split, so the
 * two can never disagree about which paths are policy. */
function roundPolicyWatchPaths(sandboxRoot: string, env: InstallEnv): string[] {
  return [...new Set([...policySurfaceWatchPaths(sandboxRoot), ...locatedPolicyWatchPaths(env)])];
}

/** Deepest directory nesting the recursive hash follows — a bound against a
 * symlink cycle, well above anything under the sandbox (dist/ is 4 deep). */
const MAX_HASH_DEPTH = 16;

/** One watched path's value: a file's content hash, a directory's RECURSIVE
 * content hash (so a rewritten `scripts/guards.sh` changes `scripts`, not only
 * a planted file — a listing hash would miss the rewrite), or "absent".
 *
 * Async, with a real event-loop turn after every file hashed: the policy
 * surface is the whole of dist/, scripts/, extensions/ and the seeds —
 * hundreds of files, ~14 MB — and hashing it synchronously would hold the
 * daemon's loop. The value equals a synchronous hash byte for byte: the same
 * reads, the same sorted names, the same bytes hashed.
 *
 * A file is hashed as its bytes, never as decoded text: decoding folds every
 * invalid UTF-8 sequence onto U+FFFD, so two binaries differing only there
 * would hash alike and a rewritten binary hook would read as no change. A
 * file of valid UTF-8 hashes exactly as its decoded text does. */
async function hashPath(path: string, fs: FingerprintFs, depth: number): Promise<string> {
  try {
    const hashed = `sha256:${fs.sha256(await fs.readFile(path))}`;
    await yieldToLoop();
    return hashed;
  } catch (fileErr) {
    // A permissions (or any other) failure is NOT absence: folding it into
    // "absent" would let a chmod-then-restore read as no change at all.
    const fileCode = errnoCode(fileErr);
    if (!isMissing(fileCode) && fileCode !== "EISDIR") return `unreadable:${fileCode}`;
    // Not a readable file — a directory, or nothing.
    try {
      const names = [...(await fs.readDir(path))].sort();
      if (depth <= 0) return `dir:${fs.sha256(names.join("\n"))}`;
      const entries: string[] = [];
      for (const n of names) entries.push(`${n}=${await hashPath(`${path}/${n}`, fs, depth - 1)}`);
      return `dir:${fs.sha256(entries.join("\n"))}`;
    } catch (dirErr) {
      const dirCode = errnoCode(dirErr);
      return isMissing(dirCode) ? "absent" : `unreadable:${dirCode}`;
    }
  }
}

function errnoCode(err: unknown): string | undefined {
  const code = (err as { code?: unknown } | null)?.code;
  return typeof code === "string" ? code : undefined;
}

/** Nothing at the path. An error with no errno code (a test double's bare
 * `Error`) reads as absent. */
function isMissing(code: string | undefined): boolean {
  return code === undefined || code === "ENOENT" || code === "ENOTDIR";
}

/** Hash every watched path. Total: a missing or unreadable path is a RECORDED
 * value, never a throw — a fingerprint that fails to compute would silently
 * disable the check, which is the failure mode this whole layer exists for. */
export async function integrityFingerprint(
  paths: readonly string[],
  fs: FingerprintFs,
): Promise<IntegrityFingerprint> {
  const files: Record<string, string> = {};
  for (const path of [...paths].sort()) files[path] = await hashPath(path, fs, MAX_HASH_DEPTH);
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
  readFile: (path) => readFile(path),
  readDir: (path) => readdir(path),
  sha256: (data) => createHash("sha256").update(data).digest("hex"),
};

export interface RoundIntegrityOpts {
  clonePath: string;
  worktreePath?: string | undefined;
  piHome?: string | undefined;
  /** The sandbox root whose policy surface is watched; omitted ⇒
   * git's paths only, which is what a caller with no sandbox has. */
  sandboxRoot?: string | undefined;
  /** The install env the live config is located from; default
   * `process.env`. Only read when `sandboxRoot` is given — the located config
   * is part of the policy half. */
  installEnv?: InstallEnv | undefined;
}

/**
 * How long a dispatch waits for a round's integrity baseline, and a round end
 * for its re-hash. The hash is async and yields after every file, so the
 * loop is free throughout; this bounds a read that never returns. Past it the
 * round goes UNCHECKED — no baseline at the start, no verdict on the re-hash
 * at the end, a `round_integrity_unchecked` event either way. Never a
 * held dispatch pump, never a round end that does not finish.
 */
export const INTEGRITY_BUDGET_MS = 60_000;

/**
 * The whole round-side call in one place, so `dispatch.ts` (start) and
 * `verdicts.ts` (end) cannot compute it over DIFFERENT path sets — which would
 * turn every round into a false alarm and get the check switched off.
 */
export function fingerprintRoundIntegrity(
  opts: RoundIntegrityOpts,
  fs: FingerprintFs = defaultFingerprintFs,
): Promise<IntegrityFingerprint> {
  const paths = gitConfigWatchPaths(opts);
  if (opts.sandboxRoot !== undefined && opts.sandboxRoot.length > 0)
    paths.push(...roundPolicyWatchPaths(opts.sandboxRoot, opts.installEnv ?? process.env));
  return integrityFingerprint([...new Set(paths)], fs);
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
  // Total over a malformed fingerprint rather than throwing on one. That makes
  // the caller's "no baseline ⇒ never judged" guard LOAD-BEARING rather than
  // an exception a surrounding try/catch happens to swallow: without that
  // guard a round with no baseline reports every watched path as changed,
  // which a test can see.
  const beforeFiles = before.files ?? {};
  const afterFiles = after.files ?? {};
  // A path only ONE well-formed side watched is watch-set drift, not a change:
  // the set grows between releases, and a round dispatched before a deploy
  // and judged after it would otherwise read
  // every newly watched file as "absent → sha256" — a false
  // policy_surface_modified on every round in flight across an undrained
  // deploy (deploy.sh only warns). Unknown is not evidence of a change. A
  // malformed side (no `files` map) keeps the total behaviour above.
  const bothWatched = before.files !== undefined && after.files !== undefined;
  const paths = new Set([...Object.keys(beforeFiles), ...Object.keys(afterFiles)]);
  const out: IntegrityChange[] = [];
  for (const path of [...paths].sort()) {
    if (bothWatched && (!(path in beforeFiles) || !(path in afterFiles))) continue;
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
  installEnv: InstallEnv = process.env,
): { git: IntegrityChange[]; policy: IntegrityChange[] } {
  const policyPaths = new Set(sandboxRoot ? roundPolicyWatchPaths(sandboxRoot, installEnv) : []);
  const git: IntegrityChange[] = [];
  const policy: IntegrityChange[] = [];
  for (const c of changes) (policyPaths.has(c.path) ? policy : git).push(c);
  return { git, policy };
}

/** The operator-facing line. Names what a change MEANS, because the reader's
 * first question is "is this an attack or did the daemon do it?" The
 * fingerprint proves the content changed, not who changed it, so the message
 * names the session as the cause to rule out first, never as established. */
export function gitConfigChangeMessage(pr: number, changes: readonly IntegrityChange[]): string {
  return [
    `EXEC BOUNDARY — PR #${pr}: git's configuration changed DURING a round: ${changes.map((c) => c.path).join(", ")}.`,
    "Nothing the daemon does rewrites these files mid-round, so a session write is the cause to rule out first;",
    "the only other writer is a person or process editing the clone by hand. Config-supplied shell",
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
    "Nothing the daemon does rewrites these mid-round. Rule out first a session write that got past the write veto",
    "(a variable-indirected redirection, most likely); the other writers are a deploy or an operator's edit made",
    "while the round ran, and a local `tsc --watch` rebuilding dist/ under a local daemon — the check cannot tell",
    "them apart. config.toml carries dry_run and every posting-guard knob,",
    "scripts/ is the mutation gate's shell mirror and dist/ is the compiled guard itself — so treat this round's",
    "output as untrusted AND assume every later round in this container runs under a rewritten boundary.",
    "Restore the tree from the deployed revision (`git status` / `git diff` in the sandbox names the file;",
    "a path outside the sandbox is the located config or a config-home profile — restore it from the operator's",
    "config home and redeploy), then read the session transcript for the write.",
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
  /** Every `rounds.posting_key` the daemon ISSUED for this PR. A posting marker
   * in a review body excuses it only when it carries one of these keys — the
   * marker format is public, so an unverified marker is a string anyone who
   * already got past layer 2 can type. */
  postingKeys: ReadonlySet<string>;
}

export interface UngatedReview {
  review_id: number;
  state: string;
  commit_id: string;
  submitted_at: string | null;
}

/** The posting receipt marker: `<!-- qcr-post:v1:<pr>:<round>:<head> -->`. */
const POSTING_MARKER_RE = /<!--\s*qcr-post:(\S+?)\s*-->/g;

/** The body carries a marker whose key the daemon issued for this PR AT this
 * review's commit. The key names its head, and both shell routes pin the
 * review's `commit_id` to the round's head, so a legitimate marker always
 * agrees with it; a key from another PR, another head or no round at all is
 * not a trace. */
function hasIssuedMarker(body: string, commitId: string, issued: ReadonlySet<string>): boolean {
  for (const m of body.matchAll(POSTING_MARKER_RE)) {
    const key = m[1]!;
    if (!issued.has(key)) continue;
    if (key.split(":").slice(3).join(":").toLowerCase() === commitId.toLowerCase()) return true;
  }
  return false;
}

/** Authored by THIS reviewer — by its identities, never by the account type:
 * every GitHub App posts as a `Bot`, and another installed review bot has no
 * posting trace here by construction, so a type check would report each of
 * its reviews (and raise the severe wake on its approvals) as ours. */
function isBotAuthored(review: AuditedReview, botLogin: string, appSlug?: string): boolean {
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
  // at most one unaccounted COMMENT — an unbounded excuse would be a permanent
  // detection hole. It is not bounded to the RIGHT one; that limit is
  // recorded in docs/exec-boundary.md rather than implied away.
  let migrationExcusesLeft = traces.migrationPrecheck ? 1 : 0;
  for (const r of reviews) {
    if (!isBotAuthored(r, opts.botLogin, opts.appSlug)) continue;
    const state = (r.state ?? "").toUpperCase();
    if (state === "PENDING" || state === "DISMISSED") continue;
    if ((r.commit_id ?? "").toLowerCase() !== head) continue;
    if (hasIssuedMarker(r.body ?? "", r.commit_id ?? "", traces.postingKeys)) continue;
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
