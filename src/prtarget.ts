// `qcr review <number|URL>`: which PR, and its head and base fetched into a
// scratch repository for a read-only review. The credential comes from the
// local route's chain (src/ghcred.ts); it is handed to git through the
// environment, never written into a config file or a URL.
import { execFileSync } from "node:child_process";
import { mkdirSync } from "node:fs";
import {
  CREDENTIAL_SOURCES,
  resolveGithubCredential,
  ghAuthTokenFromCli,
  handedToken,
  type CredentialResolution,
  type CredentialSource,
} from "./ghcred.js";
import { TokenMinter } from "./githubAuth.js";
import { originRepo, resolveBranch, type BranchTarget } from "./localreview.js";

export type PrTargetParse =
  { ok: true; repo: string; number: number } | { ok: false; error: string };

const REPO_RE = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/;

/** A PR argument: `12`, `#12` or a github.com pull URL. A PR on a repo other
 * than the current directory's is refused unless `--repo` names it. */
export function parsePrTarget(
  arg: string,
  o: { cwdRepo: string | null; repo?: string },
): PrTargetParse {
  if (o.repo !== undefined && !REPO_RE.test(o.repo))
    return { ok: false, error: `--repo ${o.repo}: expected owner/name` };
  const num = arg.match(/^#?(\d+)$/);
  if (num) {
    const repo = o.repo ?? o.cwdRepo;
    if (!repo)
      return {
        ok: false,
        error: `PR ${arg}: this directory has no GitHub remote — pass --repo owner/name`,
      };
    return { ok: true, repo, number: Number(num[1]) };
  }
  const url = arg.match(/^https:\/\/github\.com\/([^/\s]+\/[^/\s]+)\/pull\/(\d+)(?:[/?#].*)?$/);
  if (!url) return { ok: false, error: `${arg}: not a PR number or a github.com pull request URL` };
  const repo = url[1]!;
  if (o.repo !== undefined && o.repo.toLowerCase() !== repo.toLowerCase())
    return { ok: false, error: `${arg} is on ${repo} but --repo says ${o.repo}` };
  if (o.repo === undefined && (o.cwdRepo ?? "").toLowerCase() !== repo.toLowerCase())
    return {
      ok: false,
      error:
        `${arg} is on ${repo}, not this directory's repository` +
        `${o.cwdRepo ? ` (${o.cwdRepo})` : ""} — pass --repo ${repo} to review it anyway`,
    };
  return { ok: true, repo, number: Number(url[2]) };
}

export { originRepo };

export interface PrFetchRequest {
  repo: string;
  number: number;
  /** An empty or absent directory the PR is fetched into. */
  scratchDir: string;
  token: string;
  fetchFn?: typeof fetch;
  /** Where git fetches from: `<gitBase>/<owner>/<name>.git`. */
  gitBase?: string;
  apiBase?: string;
}

export type PrFetchResult =
  | {
      ok: true;
      /** The scratch repository: HEAD is the PR's head, `refs/qcr/base` its base. */
      gitDir: string;
      target: BranchTarget;
      title: string;
      body: string | null;
      number: number;
    }
  | { ok: false; error: string };

export const SCRATCH_BASE_REF = "refs/qcr/base";
const HEAD_REF = "refs/qcr/head";

/** Read the PR (title, body, base) and fetch its head and base. Read-only. */
export async function fetchPrTarget(req: PrFetchRequest): Promise<PrFetchResult> {
  const label = `${req.repo}#${req.number}`;
  const fetchFn = req.fetchFn ?? fetch;
  const apiBase = req.apiBase ?? "https://api.github.com";
  let pr: {
    title?: string;
    body?: string | null;
    head?: { sha?: string };
    base?: { ref?: string };
  };
  try {
    const res = await fetchFn(`${apiBase}/repos/${req.repo}/pulls/${req.number}`, {
      signal: AbortSignal.timeout(60_000),
      headers: {
        authorization: `Bearer ${req.token}`,
        accept: "application/vnd.github+json",
        "x-github-api-version": "2022-11-28",
      },
    });
    if (res.status === 401 || res.status === 403)
      return {
        ok: false,
        error: `GitHub rejected the credential reading ${label} (${res.status}): check it can read ${req.repo}, or run \`gh auth login\``,
      };
    if (res.status === 404)
      return {
        ok: false,
        error: `${label} was not found — wrong number or repo, or the credential cannot see ${req.repo}`,
      };
    if (!res.ok) return { ok: false, error: `GitHub answered ${res.status} for ${label}` };
    pr = (await res.json()) as typeof pr;
  } catch (err) {
    return {
      ok: false,
      error: `could not read ${label} from GitHub: ${String(err).slice(0, 200)}`,
    };
  }
  const baseRef = pr.base?.ref;
  if (!baseRef || !pr.head?.sha)
    return { ok: false, error: `${label}: GitHub's answer had no head or base` };

  mkdirSync(req.scratchDir, { recursive: true });
  const header = `Authorization: Basic ${Buffer.from(`x-access-token:${req.token}`).toString("base64")}`;
  const run = (args: string[], auth = false): string =>
    execFileSync("git", args, {
      cwd: req.scratchDir,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
      maxBuffer: 256 * 1024 * 1024,
      env: {
        ...process.env,
        GIT_TERMINAL_PROMPT: "0",
        ...(auth
          ? {
              GIT_CONFIG_COUNT: "1",
              GIT_CONFIG_KEY_0: "http.extraheader",
              GIT_CONFIG_VALUE_0: header,
            }
          : {}),
      },
    }).trim();
  try {
    run(["init", "-q"]);
    run(
      [
        "fetch",
        "-q",
        "--no-tags",
        `${req.gitBase ?? "https://github.com"}/${req.repo}.git`,
        `+refs/pull/${req.number}/head:${HEAD_REF}`,
        `+refs/heads/${baseRef}:${SCRATCH_BASE_REF}`,
      ],
      true,
    );
    run(["update-ref", "--no-deref", "HEAD", HEAD_REF]);
  } catch (err) {
    const msg = String((err as { stderr?: unknown }).stderr ?? err)
      .replaceAll(req.token, "***")
      .slice(0, 300);
    return { ok: false, error: `git could not fetch ${label}: ${msg}` };
  }
  const resolved = resolveBranch(req.scratchDir, SCRATCH_BASE_REF);
  if (!resolved.ok) return { ok: false, error: `${label}: ${resolved.error}` };
  return {
    ok: true,
    gitDir: req.scratchDir,
    target: { ...resolved.target, repo: req.repo, branch: `PR #${req.number}`, base: baseRef },
    title: pr.title ?? `PR #${req.number}`,
    body: pr.body ?? null,
    number: req.number,
  };
}

export interface PrCredentialDeps {
  env?: Record<string, string | undefined>;
  mintApp?: (secretsDir: string) => Promise<string>;
  ghAuthToken?: () => string | null;
  /** Default: the token handed to this container as a file, if any. */
  handoff?: string | null;
}

/** The local route's credential for `secretsDir`, with the real App, env and
 * `gh` unless a test says otherwise. */
export function resolvePrCredential(
  secretsDir: string,
  o: PrCredentialDeps = {},
): Promise<CredentialResolution> {
  return resolveGithubCredential({
    secretsDir,
    env: o.env ?? process.env,
    mintApp: o.mintApp ?? ((dir) => new TokenMinter(dir).installationToken()),
    ghAuthToken: o.ghAuthToken ?? ghAuthTokenFromCli,
    handoff: o.handoff === undefined ? handedToken() : o.handoff,
  });
}

/** The identity a review is posted as: the credential source the repo names
 * (`post_as` in its review settings), else the one already resolved for
 * reading the PR. A named source that is not available is an error, never a
 * silent switch to another identity. */
export async function resolvePostCredential(
  secretsDir: string,
  postAs: string | null,
  resolved: { source: CredentialSource; token: string },
  o: PrCredentialDeps = {},
): Promise<CredentialResolution> {
  if (postAs === null) return { ok: true, ...resolved };
  const known: readonly string[] = CREDENTIAL_SOURCES;
  if (!known.includes(postAs)) {
    return {
      ok: false,
      error: `post_as is ${postAs} but that credential is not available (expected one of ${known.join(", ")})`,
    };
  }
  const env = o.env ?? process.env;
  const r = await resolveGithubCredential({
    secretsDir: postAs === "app" ? secretsDir : "",
    env: postAs.startsWith("env:") ? { [postAs.slice(4)]: env[postAs.slice(4)] } : {},
    mintApp: o.mintApp ?? ((dir) => new TokenMinter(dir).installationToken()),
    ghAuthToken: postAs === "gh" ? (o.ghAuthToken ?? ghAuthTokenFromCli) : () => null,
    handoff: postAs === "handoff" ? (o.handoff === undefined ? handedToken() : o.handoff) : null,
  });
  return r.ok
    ? r
    : { ok: false, error: `post_as is ${postAs} but that credential is not available: ${r.error}` };
}
