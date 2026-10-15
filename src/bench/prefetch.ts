// AACR-Bench prefetch — the ONLY network step besides the model API.
//
// For each case it builds a per-INSTANCE bare object store holding exactly two
// commits' worth of history: the PR's base and its reviewed head, fetched by
// sha from the public repo, shallow, deepened only until their merge-base
// resolves. Per instance (not per repo) on purpose: a store shared by two PRs
// of one project would let the reviewer `git log --all` its way to the other
// PR's later commits — the future of the code it is reviewing. The same reason
// the harness's own full clone (repo_utils.py, `fetch --all`) is not used.
//
// Anonymous only: no token of any kind (CLAUDE.md rule 3: the App's
// credential only, never a personal token). The public API is used once per
// case for the PR's title/body/base branch and degrades to "unavailable"
// under the 60 req/h anonymous limit rather than blocking.
//
// External benchmarks (bench/aacr/EXTERNAL-BENCHMARKS.md) add three things,
// each driven by a field of the case and absent from every AACR-Bench case:
//   - `fetch_repo`/`fetch_pr`: fetch the commits (and ask the API) from a
//     public fork rather than `repo` — Martian's benchmark forks;
//   - `title`/`body` carried by the set: no API call at all;
//   - `leakproof`: the store holds two SYNTHETIC commits over the real trees of
//     the PR's merge-base and head (aacr.ts leakproofCommitText) and nothing
//     else — no PR commit and no commit message (SWE-PRBench's ground truth is
//     the PR's human review, which later commits and their messages can echo).
// And an optional read-only local MIRROR (env QCR_BENCH_MIRRORS, set by
// bench.sh from QCR_BENCH_PREFETCH_MIRROR): bare repos the commits are fetched
// from first, over file://, before the network. A mirror is only ever mounted
// into the prefetch container, never into a review.

import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { isAbsolute, join, normalize } from "node:path";
import {
  BASE_REF_RE,
  leakproofCommitText,
  parsePrefetchMeta,
  safeId,
  type BenchCase,
  type PrefetchMeta,
} from "./aacr.js";
import { GIT_ISOLATION_ENV, must, run } from "./exec.js";

export interface PrefetchOptions {
  store: string;
  /** Initial shallow depth, then `--deepen` steps until the merge-base exists. */
  depth?: number;
  deepenStep?: number;
  maxDepth?: number;
  /** When the API is rate-limited: wait for the reset (full runs) or record
   * the metadata as unavailable (smoke runs). */
  waitForRateLimit?: boolean;
  log?: (line: string) => void;
  fetchImpl?: typeof fetch;
  now?: () => Date;
  /** The network remote of a public repo (default `https://github.com/<repo>.git`;
   * tests point it at a local path). */
  remoteFor?: (repo: string) => string;
  /** Local read-only bare repos to fetch from first, keyed by fetch repo;
   * default from env QCR_BENCH_MIRRORS (`mirrorsFromEnv`). */
  mirrors?: ReadonlyMap<string, string>;
  /** The mirror is the only source — no network fallback for a
   * commit, no API call, no `ls-remote` (a private replay's repo must never
   * be asked for over the network). Default from env QCR_BENCH_MIRROR_ONLY=1. */
  mirrorOnly?: boolean;
}

/** QCR_BENCH_MIRROR_ONLY=1. */
export function mirrorOnlyFromEnv(env: NodeJS.ProcessEnv = process.env): boolean {
  return env["QCR_BENCH_MIRROR_ONLY"] === "1";
}

const mirrorOnlyOf = (o: PrefetchOptions): boolean => o.mirrorOnly ?? mirrorOnlyFromEnv();

// No credential helper can ever be consulted, and no system/global config
// (a host's `url.insteadOf` or credential store) leaks into the sandbox.
const GIT_ENV = { ...process.env, ...GIT_ISOLATION_ENV };

export function storeDir(store: string, c: BenchCase): string {
  return join(store, safeId(c.instance_id));
}

/** The repo a case's commits are fetched from, and the PR the API is asked
 * about there: `fetch_repo`/`fetch_pr` (a fork's PR, #1 by default) or the
 * case's own repo and PR. */
export function fetchRepoOf(c: BenchCase): { repo: string; pr: number } {
  return c.fetch_repo ? { repo: c.fetch_repo, pr: c.fetch_pr ?? 1 } : { repo: c.repo, pr: c.pr };
}

/** QCR_BENCH_MIRRORS = `{"root": "/mirrors", "repos": {"owner/name": "rel/path.git"}}`.
 * Paths are relative to the root and may not climb out of it. A malformed
 * value throws: a mirror the operator named and the run silently ignored
 * would turn a local prefetch into hundreds of network fetches. */
export function mirrorsFromEnv(env: NodeJS.ProcessEnv = process.env): Map<string, string> {
  const raw = env["QCR_BENCH_MIRRORS"];
  const out = new Map<string, string>();
  if (!raw) return out;
  const j = JSON.parse(raw) as { root?: unknown; repos?: unknown };
  if (typeof j.root !== "string" || !isAbsolute(j.root) || typeof j.repos !== "object" || !j.repos)
    throw new Error("QCR_BENCH_MIRRORS: needs an absolute root and a repos map");
  for (const [repo, rel] of Object.entries(j.repos as Record<string, unknown>)) {
    if (typeof rel !== "string" || isAbsolute(rel) || normalize(rel).startsWith(".."))
      throw new Error(`QCR_BENCH_MIRRORS: bad path for ${repo}`);
    out.set(repo, join(j.root, normalize(rel)));
  }
  return out;
}

async function git(dir: string, args: string[], timeoutMs = 20 * 60_000): Promise<string> {
  return must("git", ["-C", dir, ...args], { env: GIT_ENV, timeoutMs });
}

const networkRemote = (o: PrefetchOptions, repo: string): string =>
  (o.remoteFor ?? ((r: string) => `https://github.com/${r}.git`))(repo);

/**
 * `git fetch <args> <remote> <shas…>` — from the local mirror first when one
 * is configured for the repo (file://, its upload-pack allowed to serve any
 * object it holds, since a merge-base is rarely a ref tip), then from the
 * network for whatever the mirror could not give. Says where it came from.
 */
async function fetchShas(
  dir: string,
  o: PrefetchOptions,
  repo: string,
  args: string[],
  shas: string[],
): Promise<"mirror" | "network"> {
  const mirror = (o.mirrors ?? mirrorsFromEnv()).get(repo);
  if (mirror && existsSync(mirror)) {
    const r = await run(
      "git",
      [
        "-C",
        dir,
        "fetch",
        "--upload-pack=git -c uploadpack.allowAnySHA1InWant=true upload-pack",
        ...args,
        `file://${mirror}`,
        ...shas,
      ],
      { env: GIT_ENV, timeoutMs: 20 * 60_000 },
    );
    if (r.code === 0) return "mirror";
    if (mirrorOnlyOf(o))
      throw new Error(
        `prefetch: ${repo} — mirror fetch failed and the run is mirror-only (QCR_BENCH_MIRROR_ONLY=1): ${r.stderr.trim().slice(0, 300)}`,
      );
    o.log?.(
      `prefetch: ${repo} — mirror fetch failed (${r.stderr.trim().slice(0, 160)}); trying the network`,
    );
  } else if (mirrorOnlyOf(o)) {
    throw new Error(
      `prefetch: ${repo} — no mirror for it, and the run is mirror-only (QCR_BENCH_MIRROR_ONLY=1)`,
    );
  }
  await git(dir, ["fetch", ...args, networkRemote(o, repo), ...shas]);
  return "network";
}

/**
 * The merge-base of base and head — VERIFIED against the shallow boundary.
 *
 * In a shallow store `git merge-base` answers from the history it has: in a
 * merge-commit repo, base's walk runs into the second parents of recent
 * merges, whose fork points are older than the PR's true one, and git returns
 * that older common ancestor instead of null. The PR diff would then include
 * unrelated base-branch work. The check: if any SHALLOW commit is reachable
 * from base or head but not from the candidate, history was cut above it and
 * the true merge-base may lie past the cut — so it is not trusted (null ⇒
 * keep deepening). With no shallow commit there, the region above the
 * candidate is complete and it is the real merge-base.
 */
export async function mergeBase(dir: string, c: BenchCase): Promise<string | null> {
  return verifiedMergeBase(dir, c.base_commit, c.head_commit);
}

/** The verified merge-base of any two commits (see `mergeBase`): null while
 * the shallow cut may hide the true one. */
export async function verifiedMergeBase(dir: string, a: string, b: string): Promise<string | null> {
  const r = await run("git", ["-C", dir, "merge-base", a, b], {
    env: GIT_ENV,
  });
  const sha = r.stdout.trim();
  if (r.code !== 0 || !/^[0-9a-f]{40}$/.test(sha)) return null;
  const shallowFile = join(dir, "shallow");
  if (!existsSync(shallowFile)) return sha;
  const shallow = new Set(readFileSync(shallowFile, "utf8").split("\n").filter(Boolean));
  if (shallow.size === 0) return sha;
  const above = await run("git", ["-C", dir, "rev-list", a, b, `^${sha}`], {
    env: GIT_ENV,
    timeoutMs: 120_000,
  });
  if (above.code !== 0) return null;
  return above.stdout.split("\n").some((l) => shallow.has(l.trim())) ? null : sha;
}

/**
 * Every merge-base a case's review needs, verified. An ordinary
 * case: base…head. A follow-up case also replays its previous head onto the
 * round's merge-base (WorktreeManager.prOwnedDelta): base…prev_head (the
 * base it was reviewed on) and prev_head…merge-base (what `git merge-tree`
 * merges from) must resolve inside the store too. Null while any may lie past
 * the shallow cut.
 */
export async function caseMergeBases(
  dir: string,
  c: BenchCase,
): Promise<{ mb: string; prevMb?: string } | null> {
  const mb = await mergeBase(dir, c);
  if (!mb || !c.followup) return mb ? { mb } : null;
  const prev = c.followup.prev_head;
  const prevMb = await verifiedMergeBase(dir, c.base_commit, prev);
  if (!prevMb) return null;
  if (!(await verifiedMergeBase(dir, prev, mb))) return null;
  return { mb, prevMb };
}

interface PrApi {
  title: string | null;
  body: string | null;
  base_ref: string | null;
}

async function prFromApi(c: BenchCase, o: PrefetchOptions): Promise<PrApi | "rate-limited" | null> {
  const f = o.fetchImpl ?? fetch;
  const fr = fetchRepoOf(c);
  const url = `https://api.github.com/repos/${fr.repo}/pulls/${fr.pr}`;
  for (let attempt = 0; attempt < 2; attempt++) {
    let res: Response;
    try {
      res = await f(url, {
        headers: { accept: "application/vnd.github+json", "user-agent": "qcr-aacr-bench" },
      });
    } catch (err) {
      o.log?.(`prefetch: ${c.instance_id} — PR API unreachable (${String(err).slice(0, 120)})`);
      return null;
    }
    if (res.status === 200) {
      const j = (await res.json()) as Record<string, unknown>;
      const base = j["base"] as Record<string, unknown> | undefined;
      return {
        title: typeof j["title"] === "string" ? j["title"] : null,
        body: typeof j["body"] === "string" ? j["body"] : null,
        base_ref: typeof base?.["ref"] === "string" ? base["ref"] : null,
      };
    }
    if (
      (res.status === 403 || res.status === 429) &&
      res.headers.get("x-ratelimit-remaining") === "0"
    ) {
      if (!o.waitForRateLimit || attempt > 0) return "rate-limited";
      const reset = Number(res.headers.get("x-ratelimit-reset") ?? "0") * 1000;
      const waitMs = Math.max(0, reset - (o.now ?? (() => new Date()))().getTime()) + 5_000;
      o.log?.(
        `prefetch: GitHub API rate limit — waiting ${Math.round(waitMs / 60_000)} min for the reset`,
      );
      await new Promise((r) => setTimeout(r, waitMs));
      continue;
    }
    o.log?.(`prefetch: ${c.instance_id} — PR API answered ${res.status}; title/body unavailable`);
    return null;
  }
  return null;
}

/** The PR text a set carries (no API call), or undefined when it carries none. */
function setText(c: BenchCase): PrApi | undefined {
  if (c.title === undefined && c.body === undefined && c.base_ref === undefined) return undefined;
  return { title: c.title ?? null, body: c.body ?? null, base_ref: c.base_ref ?? null };
}

async function defaultBranch(c: BenchCase, o: PrefetchOptions): Promise<string> {
  const r = await run(
    "git",
    ["ls-remote", "--symref", networkRemote(o, fetchRepoOf(c).repo), "HEAD"],
    {
      env: GIT_ENV,
      timeoutMs: 120_000,
    },
  );
  const m = /^ref: refs\/heads\/(\S+)\s+HEAD/m.exec(r.stdout);
  return m?.[1] ?? "main";
}

/** Write one commit object from its exact text; its id must be `want`. */
async function writeCommit(dir: string, text: string, want: string): Promise<void> {
  const f = join(dir, `bench-commit-${want}.txt`);
  writeFileSync(f, text);
  try {
    const got = (await git(dir, ["hash-object", "-t", "commit", "-w", f])).trim();
    if (got !== want)
      throw new Error(
        `synthetic commit ${got} != the set's ${want} (the set and prefetch disagree)`,
      );
  } finally {
    rmSync(f, { force: true });
  }
}

/**
 * The leak-proof store (BenchCase.leakproof): fetch the real merge-base and
 * head at depth 1 into a scratch repo, check their trees are the set's, write
 * the two synthetic commits over those trees, and clone ONLY what the
 * synthetic head reaches into the final store. The real commits — with their
 * messages — stay behind in the scratch repo, which is deleted; the final
 * store is then checked not to hold them.
 */
async function prefetchLeakproof(
  c: BenchCase,
  o: PrefetchOptions,
  tmp: string,
): Promise<{ mb: string; depth: number; via: string }> {
  const lp = c.leakproof!;
  const scratch = `${tmp}.scratch`;
  rmSync(scratch, { recursive: true, force: true });
  await must("git", ["init", "--quiet", "--bare", scratch], { env: GIT_ENV });
  try {
    const via = await fetchShas(
      scratch,
      o,
      c.repo,
      ["--quiet", "--no-tags", "--depth=1"],
      [lp.source_merge_base, lp.source_head],
    );
    for (const [commit, tree] of [
      [lp.source_merge_base, lp.base_tree],
      [lp.source_head, lp.head_tree],
    ] as const) {
      const got = (await git(scratch, ["rev-parse", `${commit}^{tree}`])).trim();
      if (got !== tree)
        throw new Error(`${c.instance_id}: tree of ${commit} is ${got}, the set says ${tree}`);
    }
    await writeCommit(scratch, leakproofCommitText(lp.base_tree, null), c.base_commit);
    await writeCommit(scratch, leakproofCommitText(lp.head_tree, c.base_commit), c.head_commit);
    await git(scratch, ["update-ref", "refs/heads/bench-head", c.head_commit]);
    await git(scratch, ["update-ref", "refs/heads/bench-base", c.base_commit]);
    // The scratch repo is shallow (depth 1); the synthetic commits are not.
    // Forget the cut so the clone below walks only real reachability.
    rmSync(join(scratch, "shallow"), { force: true });
    await must("git", ["clone", "--quiet", "--bare", "--no-local", scratch, tmp], {
      env: GIT_ENV,
      timeoutMs: 20 * 60_000,
    });
    const commits = (await git(tmp, ["rev-list", "--all"])).trim().split("\n").filter(Boolean);
    if (
      commits.length !== 2 ||
      !commits.includes(c.head_commit) ||
      !commits.includes(c.base_commit)
    )
      throw new Error(`${c.instance_id}: leak-proof store holds commits ${commits.join(",")}`);
    for (const real of [lp.source_head, lp.source_merge_base]) {
      const has = await run("git", ["-C", tmp, "cat-file", "-e", real], { env: GIT_ENV });
      if (has.code === 0) throw new Error(`${c.instance_id}: leak-proof store still holds ${real}`);
    }
    return { mb: c.base_commit, depth: 1, via };
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
}

/** Prefetch one case. Idempotent: a store whose meta.json validates and whose
 * two commits resolve is reused as-is (a full run is resumable). */
export async function prefetchCase(c: BenchCase, o: PrefetchOptions): Promise<PrefetchMeta> {
  const log = o.log ?? (() => {});
  const dir = storeDir(o.store, c);
  const metaPath = join(dir, "bench-meta.json");
  if (existsSync(metaPath)) {
    const meta = parsePrefetchMeta(JSON.parse(readFileSync(metaPath, "utf8")));
    if (
      meta &&
      meta.head_commit === c.head_commit &&
      // The exact base, not merely one with the same merge-base: prepareTree
      // installs meta.base_commit as origin/<base_ref>.
      meta.base_commit === c.base_commit &&
      // A follow-up case's store must hold the SAME previous head.
      (meta.prev_head ?? null) === (c.followup?.prev_head ?? null) &&
      // The set's own merge-base assertion holds for a cached store too.
      (c.expect_merge_base === undefined || c.expect_merge_base === meta.merge_base) &&
      (await caseMergeBases(dir, c).then(
        (m) =>
          m !== null &&
          m.mb === meta.merge_base &&
          (m.prevMb ?? null) === (meta.prev_merge_base ?? null),
      ))
    ) {
      // A store fetched while the API was unavailable keeps working, but its
      // PR title/body are worth one more try — a degraded case plans no
      // pass-intent and reads no description, unlike production.
      if (
        meta.title === null &&
        meta.body === null &&
        setText(c) === undefined &&
        !mirrorOnlyOf(o)
      ) {
        const api = await prFromApi(c, o);
        if (api && api !== "rate-limited") {
          const healed: PrefetchMeta = {
            ...meta,
            title: api.title,
            body: api.body,
            ...(api.base_ref && BASE_REF_RE.test(api.base_ref)
              ? { base_ref: api.base_ref, base_ref_source: "github-api" as const }
              : {}),
          };
          const tmpMeta = `${metaPath}.tmp`;
          writeFileSync(tmpMeta, JSON.stringify(healed, null, 2) + "\n");
          renameSync(tmpMeta, metaPath);
          log(`prefetch: ${c.instance_id} cached — PR title/body filled in`);
          return healed;
        }
        log(`prefetch: ${c.instance_id} cached — still WITHOUT PR title/body`);
        return meta;
      }
      log(`prefetch: ${c.instance_id} cached`);
      return meta;
    }
    rmSync(dir, { recursive: true, force: true });
  }
  mkdirSync(o.store, { recursive: true });
  const tmp = `${dir}.partial`;
  rmSync(tmp, { recursive: true, force: true });
  let mb: string;
  let prevMb: string | undefined;
  let depth: number;
  let via: string;
  // Mirror-only: nothing may ask the network for the PR text or
  // the default branch, so the set must carry the base branch.
  if (mirrorOnlyOf(o) && c.base_ref === undefined)
    throw new Error(
      `${c.instance_id}: a mirror-only prefetch needs the set to carry base_ref (and title/body) — nothing may be asked of the network`,
    );
  try {
    if (c.leakproof) {
      log(`prefetch: ${c.instance_id} — leak-proof: merge-base and head trees only`);
      ({ mb, depth, via } = await prefetchLeakproof(c, o, tmp));
    } else {
      await must("git", ["init", "--quiet", "--bare", tmp], { env: GIT_ENV });
      const repo = fetchRepoOf(c).repo;
      depth = o.depth ?? 50;
      const step = o.deepenStep ?? 200;
      const max = o.maxDepth ?? 5_000;
      // A follow-up case fetches the previous head explicitly: after a
      // force-push it is no ancestor of the head.
      const shas = c.followup
        ? [c.base_commit, c.followup.prev_head, c.head_commit]
        : [c.base_commit, c.head_commit];
      log(
        `prefetch: ${c.instance_id} — fetching ${c.followup ? "base+prev-head+head" : "base+head"} from ${repo} (depth ${depth})`,
      );
      via = await fetchShas(tmp, o, repo, ["--quiet", "--no-tags", `--depth=${depth}`], shas);
      let found = await caseMergeBases(tmp, c);
      while (!found) {
        if (depth >= max) throw new Error(`${c.instance_id}: no merge-base within depth ${max}`);
        depth += step;
        log(`prefetch: ${c.instance_id} — deepening to ${depth}`);
        await fetchShas(tmp, o, repo, ["--quiet", "--no-tags", `--deepen=${step}`], shas);
        found = await caseMergeBases(tmp, c);
      }
      mb = found.mb;
      prevMb = found.prevMb;
      if (c.followup) await git(tmp, ["update-ref", "refs/bench/prev-head", c.followup.prev_head]);
    }
    // Every store, leak-proof or not, names the case's base and head alike.
    await git(tmp, ["update-ref", "refs/bench/base", c.base_commit]);
    await git(tmp, ["update-ref", "refs/bench/head", c.head_commit]);
    if (c.expect_merge_base && c.expect_merge_base !== mb)
      throw new Error(
        `${c.instance_id}: merge-base ${mb} differs from the set's ${c.expect_merge_base}`,
      );
  } catch (err) {
    rmSync(tmp, { recursive: true, force: true });
    throw err;
  }
  const shortstat = await git(tmp, ["diff", "--shortstat", mb, c.head_commit]);
  const n = (re: RegExp): number => Number(re.exec(shortstat)?.[1] ?? 0);

  const carried = setText(c);
  const api = carried ?? (mirrorOnlyOf(o) ? null : await prFromApi(c, o));
  const fromApi = api && api !== "rate-limited" ? api : null;
  if (api === "rate-limited")
    log(`prefetch: ${c.instance_id} — API rate-limited, title/body unavailable`);
  const baseRef = fromApi?.base_ref ?? (await defaultBranch(c, o));
  const meta: PrefetchMeta = {
    instance_id: c.instance_id,
    repo: c.repo,
    pr: c.pr,
    base_commit: c.base_commit,
    head_commit: c.head_commit,
    merge_base: mb,
    base_ref: BASE_REF_RE.test(baseRef) ? baseRef : "main",
    base_ref_source:
      c.base_ref !== undefined ? "set" : fromApi?.base_ref ? "github-api" : "default-branch",
    title: fromApi?.title ?? null,
    body: fromApi?.body ?? null,
    depth,
    diff: {
      files: n(/(\d+) files? changed/),
      additions: n(/(\d+) insertions?/),
      deletions: n(/(\d+) deletions?/),
    },
    fetched_at: (o.now ?? (() => new Date()))().toISOString(),
    ...(c.followup && prevMb ? { prev_head: c.followup.prev_head, prev_merge_base: prevMb } : {}),
  };
  writeFileSync(join(tmp, "bench-meta.json"), JSON.stringify(meta, null, 2) + "\n");
  rmSync(dir, { recursive: true, force: true });
  renameSync(tmp, dir);
  log(
    `prefetch: ${c.instance_id} ok (${via}${carried ? ", PR text from the set" : ""}) — merge-base ${mb.slice(0, 10)}, ${meta.diff.files} files +${meta.diff.additions}/-${meta.diff.deletions}, depth ${depth}`,
  );
  return meta;
}
