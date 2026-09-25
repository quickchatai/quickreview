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
// Anonymous only: no token of any kind (root CLAUDE.md rule 3). The public API
// is used once per case for the PR's title/body/base branch and degrades to
// "unavailable" under the 60 req/h anonymous limit rather than blocking.

import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { parsePrefetchMeta, safeId, type BenchCase, type PrefetchMeta } from "./aacr.js";
import { must, run } from "./exec.js";

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
}

const GIT_ENV = {
  ...process.env,
  GIT_TERMINAL_PROMPT: "0",
  // No credential helper can ever be consulted, and no system/global config
  // (a host's `url.insteadOf` or credential store) leaks into the sandbox.
  GIT_CONFIG_NOSYSTEM: "1",
  GIT_CONFIG_GLOBAL: "/dev/null",
};

export function storeDir(store: string, c: BenchCase): string {
  return join(store, safeId(c.instance_id));
}

async function git(dir: string, args: string[], timeoutMs = 20 * 60_000): Promise<string> {
  return must("git", ["-C", dir, ...args], { env: GIT_ENV, timeoutMs });
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
  const r = await run("git", ["-C", dir, "merge-base", c.base_commit, c.head_commit], {
    env: GIT_ENV,
  });
  const sha = r.stdout.trim();
  if (r.code !== 0 || !/^[0-9a-f]{40}$/.test(sha)) return null;
  const shallowFile = join(dir, "shallow");
  if (!existsSync(shallowFile)) return sha;
  const shallow = new Set(readFileSync(shallowFile, "utf8").split("\n").filter(Boolean));
  if (shallow.size === 0) return sha;
  const above = await run("git", ["-C", dir, "rev-list", c.base_commit, c.head_commit, `^${sha}`], {
    env: GIT_ENV,
    timeoutMs: 120_000,
  });
  if (above.code !== 0) return null;
  return above.stdout.split("\n").some((l) => shallow.has(l.trim())) ? null : sha;
}

interface PrApi {
  title: string | null;
  body: string | null;
  base_ref: string | null;
}

async function prFromApi(c: BenchCase, o: PrefetchOptions): Promise<PrApi | "rate-limited" | null> {
  const f = o.fetchImpl ?? fetch;
  const url = `https://api.github.com/repos/${c.repo}/pulls/${c.pr}`;
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

async function defaultBranch(c: BenchCase): Promise<string> {
  const r = await run(
    "git",
    ["ls-remote", "--symref", `https://github.com/${c.repo}.git`, "HEAD"],
    {
      env: GIT_ENV,
      timeoutMs: 120_000,
    },
  );
  const m = /^ref: refs\/heads\/(\S+)\s+HEAD/m.exec(r.stdout);
  return m?.[1] ?? "main";
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
      (await mergeBase(dir, c)) === meta.merge_base
    ) {
      // A store fetched while the API was unavailable keeps working, but its
      // PR title/body are worth one more try — a degraded case plans no
      // pass-intent and reads no description, unlike production.
      if (meta.title === null && meta.body === null) {
        const api = await prFromApi(c, o);
        if (api && api !== "rate-limited") {
          const healed: PrefetchMeta = {
            ...meta,
            title: api.title,
            body: api.body,
            ...(api.base_ref && /^[A-Za-z0-9._/-]+$/.test(api.base_ref)
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
  await must("git", ["init", "--quiet", "--bare", tmp], { env: GIT_ENV });
  const remote = `https://github.com/${c.repo}.git`;
  let depth = o.depth ?? 50;
  const step = o.deepenStep ?? 200;
  const max = o.maxDepth ?? 5_000;
  log(`prefetch: ${c.instance_id} — fetching base+head (depth ${depth})`);
  await git(tmp, [
    "fetch",
    "--quiet",
    "--no-tags",
    `--depth=${depth}`,
    remote,
    c.base_commit,
    c.head_commit,
  ]);
  let mb = await mergeBase(tmp, c);
  while (!mb) {
    if (depth >= max) {
      rmSync(tmp, { recursive: true, force: true });
      throw new Error(`${c.instance_id}: no merge-base within depth ${max}`);
    }
    depth += step;
    log(`prefetch: ${c.instance_id} — deepening to ${depth}`);
    await git(tmp, [
      "fetch",
      "--quiet",
      "--no-tags",
      `--deepen=${step}`,
      remote,
      c.base_commit,
      c.head_commit,
    ]);
    mb = await mergeBase(tmp, c);
  }
  await git(tmp, ["update-ref", "refs/bench/base", c.base_commit]);
  await git(tmp, ["update-ref", "refs/bench/head", c.head_commit]);
  const shortstat = await git(tmp, ["diff", "--shortstat", mb, c.head_commit]);
  const n = (re: RegExp): number => Number(re.exec(shortstat)?.[1] ?? 0);

  const api = await prFromApi(c, o);
  const fromApi = api && api !== "rate-limited" ? api : null;
  if (api === "rate-limited")
    log(`prefetch: ${c.instance_id} — API rate-limited, title/body unavailable`);
  const baseRef = fromApi?.base_ref ?? (await defaultBranch(c));
  const meta: PrefetchMeta = {
    instance_id: c.instance_id,
    repo: c.repo,
    pr: c.pr,
    base_commit: c.base_commit,
    head_commit: c.head_commit,
    merge_base: mb,
    base_ref: /^[A-Za-z0-9._/-]+$/.test(baseRef) ? baseRef : "main",
    base_ref_source: fromApi?.base_ref ? "github-api" : "default-branch",
    title: fromApi?.title ?? null,
    body: fromApi?.body ?? null,
    depth,
    diff: {
      files: n(/(\d+) files? changed/),
      additions: n(/(\d+) insertions?/),
      deletions: n(/(\d+) deletions?/),
    },
    fetched_at: (o.now ?? (() => new Date()))().toISOString(),
  };
  writeFileSync(join(tmp, "bench-meta.json"), JSON.stringify(meta, null, 2) + "\n");
  rmSync(dir, { recursive: true, force: true });
  renameSync(tmp, dir);
  log(
    `prefetch: ${c.instance_id} ok — merge-base ${mb.slice(0, 10)}, ${meta.diff.files} files +${meta.diff.additions}/-${meta.diff.deletions}, depth ${depth}`,
  );
  return meta;
}
