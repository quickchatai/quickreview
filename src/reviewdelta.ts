// The delta half of a re-review: what changed since the last reviewed head,
// computed offline with production's delta reader (src/prdelta.ts, the one
// `WorktreeManager.prOwnedDelta` runs) over the repo the person is standing
// in, and the follow-up round planned over it by production's `planFollowUp`.
// Any doubt answers a reason, and the caller runs a full review: a history
// rewrite, a head git no longer has, a base that moved backwards, a delta too
// large to be a follow-up.
import { execFileSync } from "node:child_process";
import type { CoreConfig } from "./reviewconfig.js";
import { deltaFollowUpEnabled } from "./followup-mode.js";
import { followUpSweepOwed, planFollowUp } from "./planner.js";
import type { Ecosystem } from "./ecosystem.js";
import type { PrFileEntry } from "./githubcore.js";
import {
  renderFollowUpOneShotPrompts,
  type FollowUpOneShotArgs,
  type FollowUpOneShotPrompts,
  type OneShotTarget,
} from "./engine/prompts.js";
import { priorSidecarText, renderPriorFindingsNote } from "./priorfindings.js";
import { lastRound, openFindings, type ReviewState } from "./reviewstate.js";
import { nodeExec, type ExecFn } from "./execfn.js";
import { gitDeltaRepo, readPrOwnedDelta, type PrOwnedDelta } from "./prdelta.js";

export type DeltaFound = Extract<PrOwnedDelta, { ok: true }>;

export type DeltaResult =
  { ok: true; delta: DeltaFound } | { ok: false; reason: string; detail?: string };

/** Git in the repo; the answer, or null on a non-zero exit. */
function tryGit(cwd: string, args: readonly string[]): string | null {
  try {
    return execFileSync("git", [...args], {
      cwd,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
  } catch {
    return null;
  }
}

/** git for the delta reader: everything local. A fetch would reach the
 * network and write refs in the person's repo; a head that is not here is
 * answered `old-head-missing`, a full review. */
const offlineExec: ExecFn = (cmd, args, opts) =>
  cmd === "git" && args[0] === "fetch"
    ? Promise.resolve({ code: 1, stdout: "", stderr: "offline: nothing is fetched" })
    : nodeExec(cmd, args, opts);

/**
 * The change the author made since the last reviewed head, or why there is no
 * safe answer. Total: it never throws.
 */
export async function computeDelta(
  cwd: string,
  state: ReviewState,
  now: { headSha: string; baseSha: string; mergeBase: string },
  exec: ExecFn = offlineExec,
): Promise<DeltaResult> {
  const last = lastRound(state);
  // A rewrite: the reviewed head is not in the new head's history (amend,
  // rebase, force-push, a branch reset) or no longer in the repo at all. What
  // the earlier review judged cannot be read as "the same PR plus a push".
  const has = tryGit(cwd, ["cat-file", "-e", `${last.head_sha}^{commit}`]) !== null;
  const ancestor =
    has && tryGit(cwd, ["merge-base", "--is-ancestor", last.head_sha, now.headSha]) !== null;
  if (!ancestor) return { ok: false, reason: "history-rewritten" };
  try {
    const top = tryGit(cwd, ["rev-parse", "--show-toplevel"]) ?? cwd;
    const delta = await readPrOwnedDelta(gitDeltaRepo(exec, top), {
      pr: 0,
      from: last.head_sha,
      to: now.headSha,
      mergeBase: now.mergeBase,
      baseSha: now.baseSha,
      ...(last.merge_base ? { fromMergeBase: last.merge_base } : {}),
    });
    if (!delta.ok)
      return { ok: false, reason: delta.reason, ...(delta.detail ? { detail: delta.detail } : {}) };
    return { ok: true, delta };
  } catch (err) {
    return { ok: false, reason: "delta-threw", detail: String(err).slice(0, 200) };
  }
}

/** `[review] follow_up = "full"` turns delta reviews off. */
export function deltaEnabled(cfg: CoreConfig): boolean {
  return deltaFollowUpEnabled(cfg);
}

/**
 * The follow-up round's prompts over a computed delta: production's order for
 * round k, the prior findings handed over to verify. `followUp.scope` says
 * whether production's plan stands (`delta`) or answered a full review
 * (`full`, with its reason) — the caller then renders the full review.
 */
export function renderDeltaRound(i: {
  root: string;
  cfg: CoreConfig;
  ecosystem: Ecosystem;
  target: OneShotTarget;
  tree: string;
  caseDir: string;
  files: PrFileEntry[];
  issuedAt: string;
  state: ReviewState;
  delta: DeltaFound;
  readFile?: FollowUpOneShotArgs["readFile"];
  profileLookup?: FollowUpOneShotArgs["profileLookup"];
  memory?: FollowUpOneShotArgs["memory"];
}): FollowUpOneShotPrompts {
  const last = lastRound(i.state);
  const list = openFindings(i.state, last.round_no + 1);
  return renderFollowUpOneShotPrompts({
    root: i.root,
    cfg: i.cfg,
    ecosystem: i.ecosystem,
    target: i.target,
    tree: i.tree,
    caseDir: i.caseDir,
    files: i.files,
    issuedAt: i.issuedAt,
    roundNo: last.round_no + 1,
    reviewNo: last.round_no + 1,
    prevHead: last.head_sha,
    ...(i.readFile ? { readFile: i.readFile } : {}),
    ...(i.profileLookup ? { profileLookup: i.profileLookup } : {}),
    ...(i.memory ? { memory: i.memory } : {}),
    decide: (ctx) =>
      planFollowUp(i.cfg, ctx.heuristics, {
        delta: i.delta,
        fromSha: last.head_sha,
        files: i.files,
        fullPlan: ctx.fullPlan,
        ecosystem: i.ecosystem,
        styleGuide: ctx.styleGuide,
        ciLinters: ctx.ciLinters,
        // The first review of a target is a full look; after an approval a
        // large push owes the sweep, as in production.
        sweepOwed: (deltaLines) =>
          followUpSweepOwed(i.cfg, {
            standing: last.verdict === "APPROVE" ? "APPROVE" : null,
            approvalWithheld: false,
            fullLookSinceFirst: () => i.state.rounds.some((r) => r.scope === "full"),
            deltaLines,
          }),
      }),
    prior: (sidecarPath) => ({
      list,
      note: renderPriorFindingsNote(list, { sidecar: sidecarPath }),
      sidecar: priorSidecarText(list, i.target.headSha),
    }),
    priorCount: list.findings.length,
  });
}
