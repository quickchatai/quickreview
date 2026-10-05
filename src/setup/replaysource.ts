// The PR replay's SOURCE port, for real: the pull request read
// through the companion's read-only GitHub token (GET only), and
// its code read from the reviewed checkout, READ-ONLY.
//
// GitHub gives the PR's facts — title, body, state, head, base, the commit it
// was merged as. The CODE comes from the local checkout's own objects, never
// the network: the tree at the PR's head is materialised into
// `<state home>/replay/tree/<sha>/` (scantree.ts, its own directory so a
// replay and a scan never prune each other's trees) and the diff against the
// merge base is written beside it, in `replay/diff/`, for the lenses to read
// in place of `git diff` (they have no shell). A PR whose head the checkout
// does not hold (a squash-merged branch long deleted) is read at the commit
// GitHub merged it as, diffed against that commit's first parent — the change
// as it landed. Neither in the checkout: refused, with the fix (pull it on the
// host; the checkout is mounted read-only and nothing here fetches).
import { execFileSync } from "node:child_process";
import { mkdirSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { GitHubReader } from "./engine.js";
import { parseUnifiedDiff, type ReplayPr, type ReplayTree } from "./replay.js";
import { gitScanSource } from "./scantree.js";

/** Where replay trees and diffs live, under the state home. */
export const REPLAY_TREES_DIR = "replay/tree";
export const REPLAY_DIFFS_DIR = "replay/diff";

/** The biggest diff a replay reads (git's output buffer). */
const MAX_DIFF_BYTES = 64 * 1024 * 1024;

const SHA_RE = /^[0-9a-f]{40}([0-9a-f]{24})?$/;

/** The PR and its code, as the replay runner needs them. */
export interface ReplaySource {
  /** The PR's facts, read-only. */
  pr(n: number): Promise<{ ok: true; pr: ReplayPr } | { ok: false; reason: string }>;
  /** Its code materialised for the lenses; earlier trees other than `keep`
   * (shas) may be removed to bound the disk. */
  open(
    pr: ReplayPr,
    keep: readonly string[],
  ): { ok: true; tree: ReplayTree } | { ok: false; reason: string };
}

/** Read a pulls API answer into a ReplayPr, or say what is missing. */
export function parsePull(
  n: number,
  data: unknown,
): { ok: true; pr: ReplayPr } | { ok: false; reason: string } {
  const d = (data ?? {}) as Record<string, unknown>;
  const head = (d.head ?? {}) as Record<string, unknown>;
  const base = (d.base ?? {}) as Record<string, unknown>;
  const sha = (v: unknown): string | null => (typeof v === "string" && SHA_RE.test(v) ? v : null);
  const headSha = sha(head.sha);
  const baseSha = sha(base.sha);
  if (d.number !== n || headSha === null || baseSha === null) {
    return {
      ok: false,
      reason: `GitHub's answer for PR #${n} is not a pull request with a head and a base`,
    };
  }
  return {
    ok: true,
    pr: {
      number: n,
      title: typeof d.title === "string" ? d.title : "",
      body: typeof d.body === "string" ? d.body : "",
      state: typeof d.state === "string" ? d.state : "unknown",
      merged: typeof d.merged_at === "string" && d.merged_at !== "",
      head_sha: headSha,
      base_sha: baseSha,
      merge_commit_sha:
        typeof d.merged_at === "string" && d.merged_at !== "" ? sha(d.merge_commit_sha) : null,
    },
  };
}

export function gitReplaySource(opts: {
  github: GitHubReader;
  /** `owner/name` — the config's `[github] repo` (a function: read when a
   * PR is, so a config edited since is picked up). */
  repo: string | (() => string);
  repoRoot: string;
  stateRoot: string;
}): ReplaySource {
  const git = (args: string[], maxBuffer = 16 * 1024 * 1024): string | null => {
    try {
      return execFileSync(
        "git",
        ["-c", `safe.directory=${opts.repoRoot}`, "-C", opts.repoRoot, ...args],
        {
          encoding: "utf8",
          maxBuffer,
          stdio: ["ignore", "pipe", "ignore"],
        },
      );
    } catch {
      return null;
    }
  };
  const has = (sha: string | null): boolean =>
    sha !== null && git(["cat-file", "-e", `${sha}^{commit}`]) !== null;
  const trees = gitScanSource(opts.repoRoot, opts.stateRoot, { treesDir: REPLAY_TREES_DIR });
  const diffsDir = join(opts.stateRoot, REPLAY_DIFFS_DIR);
  return {
    pr: async (n) => {
      const repo = typeof opts.repo === "function" ? opts.repo() : opts.repo;
      if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(repo)) {
        return {
          ok: false,
          reason: `the live config's [github] repo ${JSON.stringify(repo)} is not owner/name`,
        };
      }
      const got = await opts.github.get(`/repos/${repo}/pulls/${n}`);
      if (!got.ok) return { ok: false, reason: got.reason };
      return parsePull(n, got.data);
    },
    open: (pr, keep) => {
      // The change as reviewed (the head, against the merge base), else as it
      // landed (the merge commit, against its first parent).
      let sha: string;
      let base: string | null = null;
      if (has(pr.head_sha)) {
        sha = pr.head_sha;
        if (has(pr.base_sha)) base = git(["merge-base", pr.base_sha, pr.head_sha])?.trim() || null;
      } else if (pr.merge_commit_sha !== null && has(pr.merge_commit_sha)) {
        sha = pr.merge_commit_sha;
        base = git(["rev-parse", "--verify", "--quiet", `${sha}^1`])?.trim() || null;
      } else {
        return {
          ok: false,
          reason:
            `PR #${pr.number}'s head ${pr.head_sha.slice(0, 12)}${pr.merge_commit_sha ? ` and its merge commit ${pr.merge_commit_sha.slice(0, 12)}` : ""} ` +
            `are not in the reviewed checkout at ${opts.repoRoot} — pull it on the host (the companion mounts it read-only and fetches nothing)`,
        };
      }
      if (base === null || !SHA_RE.test(base)) {
        return {
          ok: false,
          reason: `PR #${pr.number}: no base to diff ${sha.slice(0, 12)} against in the reviewed checkout — pull its base branch on the host`,
        };
      }
      const diff = git(["diff", "--no-color", "--no-ext-diff", "-M", base, sha], MAX_DIFF_BYTES);
      if (diff === null)
        return {
          ok: false,
          reason: `git could not diff ${base.slice(0, 12)}..${sha.slice(0, 12)}`,
        };
      const opened = trees.open(sha, keep);
      if (!opened.ok) return opened;
      const diffPath = join(diffsDir, `${sha}.diff`);
      try {
        mkdirSync(diffsDir, { recursive: true });
        for (const other of readdirSync(diffsDir)) {
          if (other !== `${sha}.diff` && !keep.some((k) => other === `${k}.diff`))
            rmSync(join(diffsDir, other), { force: true });
        }
        writeFileSync(diffPath, diff);
      } catch (err) {
        return {
          ok: false,
          reason: `cannot write the diff: ${err instanceof Error ? err.message : String(err)}`,
        };
      }
      const tree = opened.tree;
      return {
        ok: true,
        tree: {
          sha,
          base,
          root: tree.root,
          diffPath,
          diffLines: diff === "" ? 0 : diff.split("\n").length - (diff.endsWith("\n") ? 1 : 0),
          files: parseUnifiedDiff(diff),
          lines: (p) => tree.lines(p),
        },
      };
    },
  };
}
