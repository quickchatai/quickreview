// Four defects in `qcr review` (src/reviewcli.ts), each pinned by a test that
// failed before its fix: a PR's delta is computed in the PR's scratch repo; a
// post sends what the bot has not already posted; the destination (menu pick
// included) is settled before it decides what is reviewed; the detached
// driver re-runs the CLI from where the code is, not from argv[1].
// Git is real (a local bare repo stands in for github.com); pi is a fake shell
// script and GitHub's API a fake fetch. No network, no model, no docker.

import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
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

const { runReviewCli, detachedCommand, detachedEntry } = await import("../src/reviewcli.js");
const { contextFor } = await import("../src/bench/runner.js");
const { findingMarker } = await import("../src/findingkey.js");

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const tmp = mkdtempSync(join(tmpdir(), "review-core-defects-"));
afterAll(() => {
  rmSync(tmp, { recursive: true, force: true });
  vi.unstubAllEnvs();
});

const git = (cwd: string, ...args: string[]): string =>
  execFileSync(
    "git",
    ["-c", "user.name=T", "-c", "user.email=t@example.com", "-c", "commit.gpgsign=false", ...args],
    { cwd, encoding: "utf8" },
  ).trim();

const body = (n: number): string =>
  Array.from({ length: n }, (_, i) => `export const v${i} = ${i};`).join("\n") + "\n";

/** The person's checkout: a clone of o/r that does NOT hold the PR's commits. */
function cwdRepo(name: string): string {
  const repo = join(tmp, name);
  mkdirSync(join(repo, "src"), { recursive: true });
  git(repo, "init", "-q", "-b", "main");
  writeFileSync(join(repo, "src", "a.ts"), "export const a = 1;\n");
  git(repo, "add", "-A");
  git(repo, "commit", "-q", "-m", "base");
  git(repo, "remote", "add", "origin", "https://github.com/o/r.git");
  writeFileSync(join(repo, ".git", "qcr-review.json"), JSON.stringify({ auto_limit_usd: 1000 }));
  return repo;
}

/** A "GitHub": a bare o/r.git holding main and pull/7/head. `push()` adds a
 * commit to the PR's head, as the author pushing again. */
function mkGithub(name: string) {
  const host = join(tmp, `${name}-host`);
  const work = join(tmp, `${name}-work`);
  mkdirSync(join(host, "o"), { recursive: true });
  mkdirSync(join(work, "src"), { recursive: true });
  git(work, "init", "-q", "-b", "main");
  writeFileSync(join(work, "src", "a.ts"), "export const a = 1;\n");
  git(work, "add", "-A");
  git(work, "commit", "-q", "-m", "base");
  const baseSha = git(work, "rev-parse", "HEAD");
  git(work, "checkout", "-q", "-b", "feat");
  writeFileSync(
    join(work, "src", "a.ts"),
    "export const a = 1;\nexport const b = 2;\nexport const c = 3;\n",
  );
  writeFileSync(join(work, "src", "big.ts"), body(40));
  git(work, "add", "-A");
  git(work, "commit", "-q", "-m", "feat");
  git(host, "init", "-q", "--bare", join(host, "o", "r.git"));
  const send = (): void =>
    void git(
      work,
      "push",
      "-q",
      "-f",
      join(host, "o", "r.git"),
      "main:refs/heads/main",
      "feat:refs/pull/7/head",
    );
  send();
  let n = 40;
  return {
    host,
    baseSha,
    headSha: () => git(work, "rev-parse", "HEAD"),
    push: (): void => {
      writeFileSync(join(work, "src", "big.ts"), body(++n));
      git(work, "commit", "-q", "-am", `push ${n}`);
      send();
    },
  };
}

type Posted = { path: string; line: number; body: string };

/** GitHub's API: the PR, its comments (`seed` are there already), and the
 * reviews posted to it. */
function stubApi(gh: ReturnType<typeof mkGithub>, seed: Posted[] = []) {
  const posts: Array<{ body: { comments: Posted[]; event: string } }> = [];
  const onPr: Posted[] = [...seed];
  const fetchFn = (async (u: string | URL | Request, init?: RequestInit) => {
    const url = String(u);
    const method = init?.method ?? "GET";
    if (method === "POST" && url.endsWith("/pulls/7/reviews")) {
      const b = JSON.parse(String(init!.body));
      posts.push({ body: b });
      onPr.push(...b.comments);
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
        head: { sha: gh.headSha() },
        base: { ref: "main", sha: gh.baseSha },
      }),
      { status: 200 },
    );
  }) as typeof fetch;
  return { posts, onPr, fetchFn };
}

const finding = (
  id: string,
  line: number,
  severity: string,
  title: string,
  lens = "correctness",
) => ({
  id,
  path: "src/a.ts",
  line,
  severity,
  title,
  body: `${title}.`,
  lens,
  disposition: "posted",
  posted_as: severity === "P0" ? "[blocker]" : "[nit]",
});

/** pi that writes the Nth record on its Nth call (the last repeats) and keeps
 * each call's stdin. */
function scriptedPi(name: string, records: unknown[][]) {
  const dir = join(tmp, `${name}-pi`);
  mkdirSync(dir);
  records.forEach((r, i) =>
    writeFileSync(join(dir, `record-${i + 1}.json`), JSON.stringify({ findings: r })),
  );
  writeFileSync(join(dir, "outcome.json"), JSON.stringify({ verdict: "APPROVE", passes: [] }));
  const bin = join(dir, "pi");
  writeFileSync(
    bin,
    [
      "#!/bin/sh",
      `D=${JSON.stringify(dir)}`,
      'n=$(cat "$D/count" 2>/dev/null || echo 0); n=$((n+1)); echo $n > "$D/count"',
      'cat > "$D/stdin-$n"',
      'r=$n; [ -f "$D/record-$r.json" ] || r=' + records.length,
      'sd=""; prev=""; for a in "$@"; do [ "$prev" = "--session-dir" ] && sd="$a"; prev="$a"; done',
      'mkdir -p "$sd"; echo \'{"type":"session"}\' > "$sd/s.jsonl"; cd="$(dirname "$sd")"',
      `echo '{"type":"message_end","message":{"role":"assistant","usage":{"input":1,"output":1,"cost":{"total":0.25}}}}'`,
      'cp "$D/record-$r.json" "$cd/findings-record.json"',
      'cp "$D/outcome.json" "$cd/outcome.json"',
      "",
    ].join("\n"),
  );
  chmodSync(bin, 0o755);
  return {
    bin,
    calls: (): number =>
      existsSync(join(dir, "count")) ? Number(readFileSync(join(dir, "count"), "utf8")) : 0,
    order: (n: number): string => readFileSync(join(dir, `stdin-${n}`), "utf8"),
  };
}

let root: string;
let ctx: ReturnType<typeof contextFor>;
beforeAll(() => {
  root = join(tmp, "root");
  mkdirSync(root);
  for (const e of readdirSync(ROOT))
    if (!["wt", ".git", "state"].includes(e)) symlinkSync(join(ROOT, e), join(root, e));
  ctx = contextFor(root, "");
});

function harness(o: {
  repo: string;
  piBin: string;
  gh: ReturnType<typeof mkGithub>;
  api: ReturnType<typeof stubApi>;
  choose?: (values: string[]) => Destination;
}) {
  const lines: string[] = [];
  const offered: string[][] = [];
  const deps = {
    cwd: o.repo,
    out: (l: string) => lines.push(l),
    confirm: null,
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
    piBin: o.piBin,
    runsDir: join(tmp, `runs-${Math.random().toString(36).slice(2)}`),
    timeoutMs: 10 * 60_000,
    pr: {
      fetchFn: o.api.fetchFn,
      gitBase: o.gh.host,
      env: { GITHUB_TOKEN: "tok" },
      ghAuthToken: () => null,
    },
  };
  return { deps, lines, offered, text: () => lines.join("\n") };
}

describe("a PR's delta is computed in the PR's scratch repository", () => {
  it("a second review of a pushed PR is a delta, though the checkout never held the PR", async () => {
    const gh = mkGithub("delta");
    const api = stubApi(gh);
    const repo = cwdRepo("delta-cwd");
    const pi = scriptedPi("delta", [[finding("f1", 3, "P0", "c breaks the build")], []]);

    const h1 = harness({ repo, piBin: pi.bin, gh, api });
    expect(await runReviewCli(["7", "--to", "terminal"], false, h1.deps)).toBe(0);
    expect(pi.calls()).toBe(1);

    gh.push();
    const h2 = harness({ repo, piBin: pi.bin, gh, api });
    expect(await runReviewCli(["7", "--to", "terminal"], false, h2.deps)).toBe(0);
    expect(pi.calls()).toBe(2);
    expect(h2.text()).toMatch(/delta since/);
    expect(h2.text()).not.toMatch(/full review, not a delta/);
    expect(pi.order(2)).toMatch(/PRIOR FINDINGS TO VERIFY/);
  });
});

describe("a post sends what the bot has not already posted", () => {
  it("leaves out a finding the bot's earlier comment already carries", async () => {
    const gh = mkGithub("post");
    // The bot's round-5 comment on a finding of ours, under a key and a line
    // ours do not share: only the skip by title and file recognises it.
    const api = stubApi(gh, [
      {
        path: "src/a.ts",
        line: 9,
        body: `**b is wrong**\n\nb should not be 2.\n\n${findingMarker(5, "zz")}`,
      },
    ]);
    const repo = cwdRepo("post-cwd");
    const pi = scriptedPi("post", [
      [finding("f1", 2, "P1", "b is wrong"), finding("f2", 3, "P3", "c naming", "style")],
    ]);
    const h = harness({ repo, piBin: pi.bin, gh, api });
    expect(await runReviewCli(["7", "--to", "terminal,pr"], false, h.deps)).toBe(0);
    expect(api.posts).toHaveLength(1);
    const comments = api.posts[0]!.body.comments;
    expect(comments).toHaveLength(1);
    expect(comments[0]!.body).toMatch(/c naming/);
    expect(comments[0]!.body).not.toMatch(/b is wrong/);
    expect(h.text()).toMatch(/Posted 1 comment /);
  });

  it("when the bot already posted every finding, posts nothing, not even a review body", async () => {
    const gh = mkGithub("post-none");
    const api = stubApi(gh, [
      { path: "src/a.ts", line: 9, body: `**b is wrong**\n\n${findingMarker(5, "zz")}` },
    ]);
    const repo = cwdRepo("post-none-cwd");
    const pi = scriptedPi("post-none", [[finding("f1", 2, "P1", "b is wrong")]]);
    const h = harness({ repo, piBin: pi.bin, gh, api });
    expect(await runReviewCli(["7", "--to", "terminal,pr"], false, h.deps)).toBe(0);
    expect(api.posts).toHaveLength(0);
    expect(h.text()).toMatch(/Nothing posted: 1 comment is already on the PR/);
  });

  it("with nothing posted by the bot, posts every finding", async () => {
    const gh = mkGithub("post-all");
    const api = stubApi(gh);
    const repo = cwdRepo("post-all-cwd");
    const pi = scriptedPi("post-all", [
      [finding("f1", 2, "P1", "b is wrong"), finding("f2", 3, "P3", "c naming", "style")],
    ]);
    const h = harness({ repo, piBin: pi.bin, gh, api });
    expect(await runReviewCli(["7", "--to", "pr"], false, h.deps)).toBe(0);
    expect(api.posts[0]!.body.comments).toHaveLength(2);
  });
});

describe("the destination is settled before it decides what is reviewed", () => {
  it("a menu pick of pr reviews in full and posts, though the PR was reviewed at this head", async () => {
    const gh = mkGithub("menu");
    const api = stubApi(gh);
    const repo = cwdRepo("menu-cwd");
    const pi = scriptedPi("menu", [[finding("f1", 2, "P1", "b is wrong")]]);

    expect(
      await runReviewCli(
        ["7", "--to", "terminal"],
        false,
        harness({ repo, piBin: pi.bin, gh, api }).deps,
      ),
    ).toBe(0);
    expect(pi.calls()).toBe(1);

    // No destination flag, nothing saved: the menu asks, the person picks pr.
    const h = harness({ repo, piBin: pi.bin, gh, api, choose: () => "pr" });
    expect(await runReviewCli(["7"], false, h.deps)).toBe(0);
    expect(h.offered).toHaveLength(1);
    expect(h.text()).not.toMatch(/nothing new/i);
    expect(pi.calls()).toBe(2);
    expect(api.posts).toHaveLength(1);
    expect(h.text()).toMatch(/Posted 1 comment /);
  });

  it("a menu pick of the terminal keeps the unchanged-head shortcut", async () => {
    const gh = mkGithub("menu-term");
    const api = stubApi(gh);
    const repo = cwdRepo("menu-term-cwd");
    const pi = scriptedPi("menu-term", [[finding("f1", 2, "P1", "b is wrong")]]);
    await runReviewCli(
      ["7", "--to", "terminal"],
      false,
      harness({ repo, piBin: pi.bin, gh, api }).deps,
    );
    const h = harness({ repo, piBin: pi.bin, gh, api, choose: () => "terminal" });
    expect(await runReviewCli(["7"], false, h.deps)).toBe(0);
    expect(h.text()).toMatch(/nothing new/i);
    expect(pi.calls()).toBe(1);
    expect(api.posts).toHaveLength(0);
  });

  it("a preview starts nothing and asks nothing", async () => {
    const gh = mkGithub("menu-preview");
    const api = stubApi(gh);
    const repo = cwdRepo("menu-preview-cwd");
    const pi = scriptedPi("menu-preview", [[]]);
    const h = harness({ repo, piBin: pi.bin, gh, api, choose: () => "pr" });
    expect(await runReviewCli(["7", "--preview"], false, h.deps)).toBe(0);
    expect(h.offered).toHaveLength(0);
    expect(pi.calls()).toBe(0);
  });
});

describe("the detached driver re-runs the CLI from where the code is", () => {
  const l = { dir: "/runs/d1", key: "pr:o/r#7", argv: ["7", "--limit", "3"] };

  it("takes the entry from the module's own location, not process.argv[1]", () => {
    const argv1 = process.argv[1];
    process.argv[1] = "/usr/local/bin/some-wrapper";
    try {
      const c = detachedCommand(l);
      expect(c.args).not.toContain("/usr/local/bin/some-wrapper");
      expect(c.args).toContain(detachedEntry());
    } finally {
      process.argv[1] = argv1!;
    }
  });

  it("names the cli beside the module, in the module's own kind of file", () => {
    expect(detachedEntry("file:///opt/qcr/dist/src/reviewcli.js")).toBe("/opt/qcr/dist/src/cli.js");
    expect(detachedEntry("file:///work/src/reviewcli.ts")).toBe("/work/src/cli.ts");
    expect(detachedEntry()).toBe(join(ROOT, "src", "cli.ts"));
  });

  it("builds the driver's command line: node flags, entry, review --detached-run, the run, the arguments, --json", () => {
    expect(
      detachedCommand(l, {
        entry: "/opt/qcr/cli.js",
        execPath: "/usr/bin/node",
        execArgv: ["--x"],
      }),
    ).toEqual({
      command: "/usr/bin/node",
      args: [
        "--x",
        "/opt/qcr/cli.js",
        "review",
        "--detached-run",
        "/runs/d1",
        "pr:o/r#7",
        "7",
        "--limit",
        "3",
        "--json",
      ],
    });
  });
});
