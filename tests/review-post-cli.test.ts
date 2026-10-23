// `qcr review --to pr` end to end (src/reviewpost.ts via src/reviewcli.ts).
// A real throwaway git repo is the branch fixture; pi is a fake shell script
// (no network, no model, no docker, no GitHub).

import { piCliRuntime } from "./helpers/pi-cli-runtime.js";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { freshStateHomePerTest } from "./helpers/fresh-state-home.js";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { execFileSync } from "node:child_process";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { Destination } from "../src/reviewdest.js";

vi.stubEnv(
  "QCR_CONFIG",
  resolve(dirname(fileURLToPath(import.meta.url)), "fixtures", "config.toml"),
);

const { runReviewCli } = await import("../src/reviewcli.js");
const { saveDefaultDestinations, destinationChoices } = await import("../src/reviewdest.js");
const { contextFor } = await import("../src/bench/runner.js");
const { openReviewStore } = await import("../src/reviewstore.js");

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const tmp = mkdtempSync(join(tmpdir(), "review-cli-"));
afterAll(() => {
  rmSync(tmp, { recursive: true, force: true });
  vi.unstubAllEnvs();
});

freshStateHomePerTest();

const git = (cwd: string, ...args: string[]): string =>
  execFileSync(
    "git",
    ["-c", "user.name=T", "-c", "user.email=t@example.com", "-c", "commit.gpgsign=false", ...args],
    { cwd, encoding: "utf8" },
  ).trim();

/** main with one file, `feature` adding two lines to it. */
function mkRepo(name: string): string {
  const repo = join(tmp, name);
  mkdirSync(join(repo, "src"), { recursive: true });
  git(repo, "init", "-q", "-b", "main");
  writeFileSync(join(repo, "src", "a.ts"), "export const a = 1;\n");
  git(repo, "add", "-A");
  git(repo, "commit", "-q", "-m", "base");
  git(repo, "checkout", "-q", "-b", "feature");
  writeFileSync(
    join(repo, "src", "a.ts"),
    "export const a = 1;\nexport const b = 2;\nexport const c = 3;\n",
  );
  git(repo, "commit", "-q", "-am", "add b and c");
  return repo;
}

function mkRoot(name: string): string {
  const root = join(tmp, name);
  mkdirSync(root);
  for (const e of readdirSync(ROOT))
    if (!["wt", ".git", "state"].includes(e)) symlinkSync(join(ROOT, e), join(root, e));
  return root;
}

const findings = [
  {
    id: "f1",
    path: "src/a.ts",
    line: 2,
    severity: "P1",
    title: "b is wrong",
    body: "b should not be 2.",
    lens: "correctness",
    disposition: "posted",
    posted_as: "[blocker]",
  },
  {
    id: "f2",
    path: "src/a.ts",
    line: 3,
    severity: "P3",
    title: "c naming",
    body: "rename c.",
    lens: "style",
    disposition: "posted",
    posted_as: "[nit]",
  },
];
const record = JSON.stringify({ findings, verdict: "APPROVE" });
const outcome = JSON.stringify({ verdict: "APPROVE", passes: [] });

function fakePi(name: string, script: string[]): { bin: string; calls: string } {
  const calls = join(tmp, `${name}.calls`);
  const bin = join(tmp, `${name}-pi`);
  writeFileSync(
    bin,
    [
      "#!/bin/sh",
      "cat > /dev/null",
      `echo "$*" >> ${JSON.stringify(calls)}`,
      'sd=""; prev=""; for a in "$@"; do [ "$prev" = "--session-dir" ] && sd="$a"; prev="$a"; done',
      'mkdir -p "$sd"; echo \'{"type":"session"}\' > "$sd/s.jsonl"; cd="$(dirname "$sd")"',
      ...script,
      "",
    ].join("\n"),
  );
  chmodSync(bin, 0o755);
  return { bin, calls };
}

const happyPi = (name: string, cost = 0.25) =>
  fakePi(name, [
    `echo '{"type":"message_end","message":{"role":"assistant","usage":{"input":1,"output":1,"cost":{"total":${cost}}}}}'`,
    `printf '%s' ${JSON.stringify(record)} > "$cd/findings-record.json"`,
    `printf '%s' ${JSON.stringify(outcome)} > "$cd/outcome.json"`,
  ]);

let root: string;
let ctx: ReturnType<typeof contextFor>;
beforeAll(() => {
  root = mkRoot("root");
  ctx = contextFor(root, "");
});

function harness(o: {
  repo: string;
  piBin: string;
  confirm?: ((q: string) => Promise<boolean>) | null;
  /** Present: the session is interactive and answers the destination question. */
  choose?: (options: string[]) => Destination;
}) {
  const lines: string[] = [];
  const asked: string[] = [];
  const offered: string[][] = [];
  const deps = {
    cwd: o.repo,
    out: (l: string) => lines.push(l),
    confirm:
      o.confirm === null
        ? null
        : async (q: string) => {
            asked.push(q);
            return o.confirm ? o.confirm(q) : false;
          },
    ...(o.choose
      ? {
          choose: async (_q: string, opts: Array<{ value: string }>) => {
            const values = opts.map((x) => x.value);
            offered.push(values);
            return o.choose!(values);
          },
        }
      : {}),
    root,
    agentDir: join(tmp, "agent"),
    cfg: ctx.cfg,
    ecosystem: ctx.ecosystem,
    runtime: piCliRuntime({ bin: o.piBin }),
    runsDir: join(tmp, `runs-${Math.random().toString(36).slice(2)}`),
    dryrunDir: join(tmp, `dryrun-${Math.random().toString(36).slice(2)}`),
    timeoutMs: 10 * 60_000,
  };
  return { deps, lines, asked, offered, text: () => lines.join("\n") };
}

/** The repo's settings: the limit the review runs under without asking. */
function setLimit(repo: string, limit: number, extra: Record<string, number> = {}): void {
  writeFileSync(
    join(repo, ".git", "qcr-review.json"),
    JSON.stringify({ auto_limit_usd: limit, ...extra }),
  );
}

const rich = (repo: string) => setLimit(repo, 1000);

/** A "GitHub": a bare o/r.git holding main and pull/7/head, plus a stub API that
 * also records reviews posted to it and serves them back as PR comments. */
const gh = join(tmp, "gh-host");
const work = join(tmp, "gh-work");
mkdirSync(join(gh, "o"), { recursive: true });
mkdirSync(work, { recursive: true });
git(work, "init", "-q", "-b", "main");
mkdirSync(join(work, "src"));
writeFileSync(join(work, "src", "a.ts"), "export const a = 1;\n");
git(work, "add", "-A");
git(work, "commit", "-q", "-m", "base");
const baseSha = git(work, "rev-parse", "HEAD");
git(work, "checkout", "-q", "-b", "feat");
writeFileSync(
  join(work, "src", "a.ts"),
  "export const a = 1;\nexport const b = 2;\nexport const c = 3;\n",
);
git(work, "commit", "-q", "-am", "feat");
const headSha = git(work, "rev-parse", "HEAD");
git(gh, "init", "-q", "--bare", join(gh, "o", "r.git"));
git(work, "push", "-q", join(gh, "o", "r.git"), "main:refs/heads/main", "feat:refs/pull/7/head");

function stubApi() {
  const posts: Array<{ auth: string | null; body: any }> = [];
  const onPr: Array<{ path: string; line: number; body: string }> = [];
  const fetchFn = (async (u: string | URL | Request, init?: RequestInit) => {
    const url = String(u);
    const method = init?.method ?? "GET";
    if (method === "POST" && url.endsWith("/pulls/7/reviews")) {
      const body = JSON.parse(String(init!.body));
      posts.push({ auth: new Headers(init?.headers).get("authorization"), body });
      onPr.push(...body.comments);
      return new Response(JSON.stringify({ id: 1, html_url: "https://example.test/r/1" }), {
        status: 200,
      });
    }
    if (method === "GET" && url.includes("/pulls/7/comments"))
      return new Response(JSON.stringify(url.includes("page=1") ? onPr : []), { status: 200 });
    return new Response(
      JSON.stringify({
        title: "Add b",
        body: null,
        head: { sha: headSha },
        base: { ref: "main", sha: baseSha },
      }),
      { status: 200 },
    );
  }) as typeof fetch;
  return { posts, onPr, fetchFn };
}

function cwdRepo(name: string): string {
  const repo = mkRepo(name);
  git(repo, "remote", "add", "origin", "https://github.com/o/r.git");
  rich(repo);
  return repo;
}
function prHarness(
  repo: string,
  piBin: string,
  api: ReturnType<typeof stubApi>,
  pr: object = {},
  dryRun = false,
) {
  const h = harness({ repo, piBin });
  return {
    ...h,
    deps: {
      ...h.deps,
      // The posting gate takes the install's dry_run; these runs are live ones.
      cfg: { ...h.deps.cfg, dry_run: dryRun },
      pr: {
        fetchFn: api.fetchFn,
        gitBase: gh,
        env: { GITHUB_TOKEN: "tok" },
        ghAuthToken: () => null,
        ...pr,
      },
    },
  };
}

describe("qcr review --to pr", () => {
  it("posts one COMMENT review with the qcr marker and the hidden finding markers, even on an APPROVE verdict", async () => {
    const repo = cwdRepo("post-1");
    const api = stubApi();
    const h = prHarness(repo, happyPi("post-1").bin, api);
    expect(await runReviewCli(["7", "--to", "terminal,pr"], false, h.deps)).toBe(0);
    expect(api.posts).toHaveLength(1);
    const p = api.posts[0]!;
    expect(p.body.event).toBe("COMMENT");
    expect(p.body.commit_id).toBe(headSha);
    expect(p.auth).toBe("Bearer tok");
    expect(p.body.comments).toHaveLength(2);
    for (const c of p.body.comments) {
      expect(c.body).toContain("Posted by qcr");
      expect(c.body).toMatch(/<!-- qcr:f=1:f\d -->/);
    }
    expect(h.text()).toMatch(/Posted 2 comments/);
  });

  it("on a dry_run install records the review in its dryrun dir and posts nothing", async () => {
    const repo = cwdRepo("post-dry");
    const api = stubApi();
    const h = prHarness(repo, happyPi("post-dry").bin, api, {}, true);
    expect(await runReviewCli(["7", "--to", "terminal,pr"], false, h.deps)).toBe(0);
    expect(api.posts).toHaveLength(0);
    expect(h.text()).toMatch(/Dry run .*recorded, not posted/);
    // The record lands in the dir the terminal side names (the state home's),
    // never inside the installed package.
    const files = readdirSync(h.deps.dryrunDir).filter((f) => f.endsWith("-create_review.json"));
    expect(files.length).toBeGreaterThan(0);
  });

  it("a second review of the same PR with the same findings posts nothing new", async () => {
    const repo = cwdRepo("post-2");
    const api = stubApi();
    const h1 = prHarness(repo, happyPi("post-2a").bin, api);
    await runReviewCli(["7", "--to", "pr"], false, h1.deps);
    const h2 = prHarness(repo, happyPi("post-2b").bin, api);
    expect(await runReviewCli(["7", "--to", "pr"], false, h2.deps)).toBe(0);
    expect(api.posts).toHaveLength(1);
    expect(h2.text()).toMatch(/already on the PR/);
  });

  it("is unavailable for a branch: refused before anything runs or is paid", async () => {
    const repo = cwdRepo("post-branch");
    const pi = happyPi("post-branch");
    const h = harness({ repo, piBin: pi.bin });
    expect(await runReviewCli(["--to", "pr"], false, h.deps)).toBe(2);
    expect(h.text()).toMatch(/no PR|pull request/);
    expect(existsSync(pi.calls)).toBe(false);
  });

  it("is unavailable for the uncommitted tree", async () => {
    const repo = cwdRepo("post-unc");
    const h = harness({ repo, piBin: happyPi("post-unc").bin });
    expect(await runReviewCli(["--uncommitted", "--to", "pr"], false, h.deps)).toBe(2);
  });

  it("offers posting only for a PR target", () => {
    expect(destinationChoices({ pr: true }).map((c) => c.value)).toContain("pr");
    expect(destinationChoices({ pr: false }).map((c) => c.value)).not.toContain("pr");
  });

  it("a saved default of pr is not applied to a branch: it falls back to the terminal text and JSON", async () => {
    const repo = cwdRepo("post-saved");
    saveDefaultDestinations(repo, ["pr"]);
    const h = harness({ repo, piBin: happyPi("post-saved").bin });
    expect(await runReviewCli([], false, h.deps)).toBe(0);
    expect(h.lines.some((l) => l.startsWith("{"))).toBe(true);
  });

  it("a saved default of pr posts on a PR", async () => {
    const repo = cwdRepo("post-saved-pr");
    saveDefaultDestinations(repo, ["pr"]);
    const api = stubApi();
    const h = prHarness(repo, happyPi("post-saved-pr").bin, api);
    expect(await runReviewCli(["7"], false, h.deps)).toBe(0);
    expect(api.posts).toHaveLength(1);
  });

  it("a repeat run on an unchanged PR head spends nothing (the PR keeps local state)", async () => {
    const repo = cwdRepo("pr-state");
    const api = stubApi();
    const pi = happyPi("pr-state");
    const h1 = prHarness(repo, pi.bin, api);
    expect(await runReviewCli(["7", "--to", "terminal"], false, h1.deps)).toBe(0);
    expect(existsSync(join(openReviewStore(repo)!.dir, "state"))).toBe(true);
    expect(existsSync(join(repo, ".git", "qcr-review-state"))).toBe(false);
    const h2 = prHarness(repo, pi.bin, api);
    expect(await runReviewCli(["7", "--to", "terminal"], false, h2.deps)).toBe(0);
    expect(h2.text()).toMatch(/nothing new/i);
    expect(h2.text()).toMatch(/PR #7/);
    // --full still reviews again
    const h3 = prHarness(repo, pi.bin, api);
    expect(await runReviewCli(["7", "--to", "terminal", "--full"], false, h3.deps)).toBe(0);
    expect(h3.text()).not.toMatch(/nothing new/i);
  });

  it("PR state is keyed by the PR, apart from the branch of the same repo", async () => {
    const repo = cwdRepo("pr-state-key");
    const api = stubApi();
    const pi = happyPi("pr-state-key");
    await runReviewCli(["7", "--to", "terminal"], false, prHarness(repo, pi.bin, api).deps);
    const h = harness({ repo, piBin: pi.bin });
    expect(await runReviewCli(["--to", "terminal"], false, h.deps)).toBe(0);
    expect(h.text()).not.toMatch(/nothing new/i);
  });

  it("posts as the configured identity, else the resolved credential", async () => {
    const repo = cwdRepo("post-as");
    writeFileSync(
      join(repo, ".git", "qcr-review.json"),
      JSON.stringify({ auto_limit_usd: 1000, post_as: "env:GH_TOKEN" }),
    );
    const api = stubApi();
    const h = prHarness(repo, happyPi("post-as").bin, api, {
      env: { GITHUB_TOKEN: "tok", GH_TOKEN: "other" },
    });
    expect(await runReviewCli(["7", "--to", "pr"], false, h.deps)).toBe(0);
    expect(api.posts[0]!.auth).toBe("Bearer other");
  });

  it.each([
    ["gh", {}],
    ["app", {}],
    ["env:GH_TOKEN", {}],
    ["env:GITHUB_TOKN", { GITHUB_TOKN: "x" }],
    ["App", {}],
  ])(
    "post_as %s that is not available is an error: exit 1, nothing posted",
    async (postAs, env) => {
      const repo = cwdRepo(`post-as-bad-${postAs.replace(/\W/g, "")}`);
      writeFileSync(
        join(repo, ".git", "qcr-review.json"),
        JSON.stringify({ auto_limit_usd: 1000, post_as: postAs }),
      );
      const api = stubApi();
      const h = prHarness(repo, happyPi(`post-as-bad-${postAs.replace(/\W/g, "")}`).bin, api, {
        env: { GITHUB_TOKEN: "tok", ...env },
      });
      expect(await runReviewCli(["7", "--to", "pr"], false, h.deps)).toBe(1);
      expect(h.text()).toMatch(
        new RegExp(`post_as is ${postAs} but that credential is not available`),
      );
      expect(api.posts).toHaveLength(0);
    },
  );

  it("a failed post is reported and the run exits 1, the findings still shown", async () => {
    const repo = cwdRepo("post-fail");
    const api = stubApi();
    const inner = api.fetchFn;
    api.fetchFn = (async (u: string | URL | Request, init?: RequestInit) =>
      init?.method === "POST"
        ? new Response("no", { status: 403 })
        : inner(u, init)) as typeof fetch;
    const h = prHarness(repo, happyPi("post-fail").bin, api);
    expect(await runReviewCli(["7", "--to", "terminal,pr"], false, h.deps)).toBe(1);
    expect(h.text()).toMatch(/not posted/i);
    expect(h.text()).toMatch(/b is wrong/);
  });

  it("a repeat that adds a body-only finding still posts it", async () => {
    const repo = cwdRepo("post-body");
    const api = stubApi();
    const h1 = prHarness(repo, happyPi("post-body-a").bin, api);
    await runReviewCli(["7", "--to", "pr"], false, h1.deps);
    const withBody = JSON.stringify({
      findings: [
        ...findings,
        {
          id: "f3",
          path: "src/a.ts",
          line: 3,
          severity: "P3",
          title: "only in the body",
          body: "no anchor.",
          lens: "style",
          disposition: "posted",
          posted_as: "[nit]",
          inline: false,
        },
      ],
      verdict: "APPROVE",
    });
    const pi = fakePi("post-body-b", [
      `printf '%s' ${JSON.stringify(withBody)} > "$cd/findings-record.json"`,
      `printf '%s' ${JSON.stringify(outcome)} > "$cd/outcome.json"`,
    ]);
    const h2 = prHarness(repo, pi.bin, api);
    expect(await runReviewCli(["7", "--to", "pr"], false, h2.deps)).toBe(0);
    expect(api.posts).toHaveLength(2);
    expect(api.posts[1]!.body.body).toContain("only in the body");
  });

  it("a malformed entry in the findings record does not stop the repeat filter", async () => {
    const repo = cwdRepo("post-null");
    const api = stubApi();
    const h1 = prHarness(repo, happyPi("post-null-a").bin, api);
    await runReviewCli(["7", "--to", "pr"], false, h1.deps);
    const withNull = JSON.stringify({ findings: [...findings, null], verdict: "APPROVE" });
    const pi = fakePi("post-null-b", [
      `printf '%s' ${JSON.stringify(withNull)} > "$cd/findings-record.json"`,
      `printf '%s' ${JSON.stringify(outcome)} > "$cd/outcome.json"`,
    ]);
    const h2 = prHarness(repo, pi.bin, api);
    expect(await runReviewCli(["7", "--to", "pr"], false, h2.deps)).toBe(0);
    expect(api.posts).toHaveLength(1);
  });
});
