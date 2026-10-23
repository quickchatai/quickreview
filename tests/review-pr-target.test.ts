// `qcr review <PR>`: the target, the credential chain and the daemon fence
// (packages/pi-plugin/src/prtarget.ts, packages/pi-plugin/src/ghcred.ts). Git is real (a local bare repo stands in
// for github.com); the GitHub API, `gh` and the App are stubs. No network.

import { afterAll, describe, expect, it } from "vitest";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  resolveGithubCredential,
  MISSING_CREDENTIAL_HELP,
} from "@quickchatai/pi-quickreview/src/ghcred.js";
import {
  fetchPrTarget,
  parsePrTarget,
  resolvePostCredential,
} from "@quickchatai/pi-quickreview/src/prtarget.js";
import {
  githubCredential,
  TokenMinter,
  UserTokenSource,
} from "@quickchatai/pi-quickreview/src/githubAuth.js";
import { resolveSpecifier, runtimeSpecifiers } from "./helpers/layers.js";
import { SRC_DIRS } from "./helpers/source-trees.js";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const tmp = mkdtempSync(join(tmpdir(), "review-pr-target-"));
afterAll(() => rmSync(tmp, { recursive: true, force: true }));

describe("parsePrTarget", () => {
  it("takes a number against the cwd repo", () => {
    expect(parsePrTarget("12", { cwdRepo: "o/r" })).toEqual({ ok: true, repo: "o/r", number: 12 });
    expect(parsePrTarget("#12", { cwdRepo: "o/r" })).toEqual({ ok: true, repo: "o/r", number: 12 });
  });
  it("takes a full URL", () => {
    expect(parsePrTarget("https://github.com/o/r/pull/7", { cwdRepo: "o/r" })).toEqual({
      ok: true,
      repo: "o/r",
      number: 7,
    });
    expect(
      parsePrTarget("https://github.com/o/r/pull/7/files?x=1#a", { cwdRepo: "o/r" }),
    ).toMatchObject({ ok: true, number: 7 });
  });
  it("refuses a PR on another repo unless that repo is given", () => {
    const r = parsePrTarget("https://github.com/other/thing/pull/7", { cwdRepo: "o/r" });
    expect(r.ok).toBe(false);
    expect(!r.ok && r.error).toMatch(/other\/thing/);
    expect(!r.ok && r.error).toMatch(/--repo other\/thing/);
    expect(
      parsePrTarget("https://github.com/other/thing/pull/7", {
        cwdRepo: "o/r",
        repo: "other/thing",
      }),
    ).toEqual({ ok: true, repo: "other/thing", number: 7 });
    expect(
      parsePrTarget("https://github.com/other/thing/pull/7", { cwdRepo: "o/r", repo: "x/y" }).ok,
    ).toBe(false);
  });
  it("takes a number on a given repo, even from a directory with no GitHub remote", () => {
    expect(parsePrTarget("5", { cwdRepo: null, repo: "a/b" })).toEqual({
      ok: true,
      repo: "a/b",
      number: 5,
    });
    const r = parsePrTarget("5", { cwdRepo: null });
    expect(!r.ok && r.error).toMatch(/--repo/);
  });
  it("refuses a malformed repo and a non-PR URL", () => {
    expect(parsePrTarget("5", { cwdRepo: "o/r", repo: "nonsense" }).ok).toBe(false);
    expect(parsePrTarget("https://github.com/o/r/issues/5", { cwdRepo: "o/r" }).ok).toBe(false);
    expect(parsePrTarget("https://example.com/o/r/pull/5", { cwdRepo: "o/r" }).ok).toBe(false);
  });
});

describe("resolveGithubCredential: the order", () => {
  const secrets = (withApp: boolean): string => {
    const d = mkdtempSync(join(tmp, "secrets-"));
    if (withApp) {
      writeFileSync(join(d, "app_id"), "1");
      writeFileSync(join(d, "app.pem"), "pem");
    }
    return d;
  };
  const run = async (o: {
    app: boolean;
    env?: Record<string, string>;
    gh?: string | null;
    mint?: () => Promise<string>;
  }) => {
    const ghCalls: number[] = [];
    const r = await resolveGithubCredential({
      secretsDir: secrets(o.app),
      env: o.env ?? {},
      mintApp: o.mint ?? (async () => "app-token"),
      ghAuthToken: () => {
        ghCalls.push(1);
        return o.gh ?? null;
      },
    });
    return { r, ghCalls };
  };

  it("uses the App first when it is configured, even with every other source present", async () => {
    const { r, ghCalls } = await run({
      app: true,
      env: { GITHUB_TOKEN: "g", GH_TOKEN: "h" },
      gh: "cli",
    });
    expect(r).toEqual({ ok: true, source: "app", token: "app-token" });
    expect(ghCalls).toHaveLength(0);
  });
  it("uses GITHUB_TOKEN when the App is absent, before GH_TOKEN and gh", async () => {
    const { r } = await run({ app: false, env: { GITHUB_TOKEN: "g", GH_TOKEN: "h" }, gh: "cli" });
    expect(r).toEqual({ ok: true, source: "env:GITHUB_TOKEN", token: "g" });
  });
  it("uses GH_TOKEN when only it is set", async () => {
    const { r } = await run({ app: false, env: { GH_TOKEN: "h" }, gh: "cli" });
    expect(r).toEqual({ ok: true, source: "env:GH_TOKEN", token: "h" });
  });
  it("treats a blank variable as absent", async () => {
    const { r } = await run({ app: false, env: { GITHUB_TOKEN: "  ", GH_TOKEN: "" }, gh: "cli" });
    expect(r).toEqual({ ok: true, source: "gh", token: "cli" });
  });
  it("falls back to `gh auth token` last", async () => {
    const { r, ghCalls } = await run({ app: false, gh: "cli" });
    expect(r).toEqual({ ok: true, source: "gh", token: "cli" });
    expect(ghCalls).toHaveLength(1);
  });
  it("falls through when the App is configured but cannot mint", async () => {
    const { r } = await run({
      app: true,
      env: { GH_TOKEN: "h" },
      mint: async () => {
        throw new Error("token mint failed: 401");
      },
    });
    expect(r).toMatchObject({ ok: true, source: "env:GH_TOKEN", token: "h" });
  });
  it("does not treat a secrets dir with half an App as configured", async () => {
    const d = secrets(false);
    writeFileSync(join(d, "app_id"), "1");
    const r = await resolveGithubCredential({
      secretsDir: d,
      env: {},
      mintApp: async () => {
        throw new Error("must not be called");
      },
      ghAuthToken: () => "cli",
    });
    expect(r).toMatchObject({ ok: true, source: "gh" });
  });
  it("names the fix when nothing is available", async () => {
    const { r } = await run({ app: false });
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.error).toContain("gh auth login");
      expect(r.error).toMatch(/GITHUB_TOKEN/);
      expect(r.error).toBe(MISSING_CREDENTIAL_HELP);
    }
  });
  it("mentions an App that failed to mint when nothing else is available", async () => {
    const { r } = await run({
      app: true,
      mint: async () => {
        throw new Error("token mint failed: 401");
      },
    });
    expect(!r.ok && r.error).toMatch(/token mint failed: 401/);
    expect(!r.ok && r.error).toContain("gh auth login");
  });
});

describe("resolvePostCredential", () => {
  it("keeps the App's mint failure in the error for post_as=app", async () => {
    const d = mkdtempSync(join(tmp, "secrets-post-"));
    writeFileSync(join(d, "app_id"), "1");
    writeFileSync(join(d, "app.pem"), "pem");
    const r = await resolvePostCredential(
      d,
      "app",
      { source: "gh", token: "t" },
      {
        env: {},
        mintApp: async () => {
          throw new Error("token mint failed: 401");
        },
      },
    );
    expect(r.ok).toBe(false);
    expect(!r.ok && r.error).toMatch(/post_as is app but that credential is not available/);
    expect(!r.ok && r.error).toMatch(/token mint failed: 401/);
  });
});

describe("the daemon's credential: the App, or the person's token FILE (rule 3 as amended)", () => {
  // Hard rule 3 as amended (SECURITY.md): the daemon may run on the
  // person's own GitHub credential (`[github] auth = "user"`) instead of an
  // App — polling only, every mutation through the one gate — and that token
  // reaches it as the FILE `<secrets dir>/github_token`, read through
  // `UserTokenSource`, never through the environment or a command line. Every
  // other personal-token route (GH_TOKEN, `gh auth token`, the credential
  // chain, the handoff file) stays out of the daemon, exactly as before.
  //
  // The daemon's GitHub code: its client and wiring, and the credential seam,
  // which is the core's (packages/pi-plugin/src/githubAuth.ts).
  const DAEMON_GITHUB_FILES = [
    "src/github.ts",
    "packages/pi-plugin/src/githubAuth.ts",
    "src/daemon.ts",
    "src/wire.ts",
    "src/sessions.ts",
  ];
  const srcFiles = (dir: string): string[] =>
    readdirSync(dir, { withFileTypes: true }).flatMap((e) =>
      e.isDirectory()
        ? srcFiles(join(dir, e.name))
        : e.name.endsWith(".ts")
          ? [join(dir, e.name)]
          : [],
    );

  it("only the local review route (and cli.ts's startup handoff read) imports the credential chain", () => {
    const importers = SRC_DIRS.flatMap((d) => srcFiles(join(ROOT, d)))
      .filter((f) => /from "[^"]*\/ghcred\.js"|from "\.\/ghcred\.js"/.test(readFileSync(f, "utf8")))
      .map((f) => f.slice(ROOT.length + 1))
      .sort();
    expect(importers).toEqual(["src/cli.ts", "packages/pi-plugin/src/prtarget.ts"].sort());
  });

  it("no daemon or worker entry reaches the local review route, however indirectly", () => {
    // The review route (the credential chain, the PR fetch, the local post) is
    // core, the layer the daemon shares: a direct-import check cannot see a
    // daemon module that imports something that imports it. Every runtime edge
    // from the daemon's process entries is walked.
    const ROUTE = [
      "packages/pi-plugin/src/reviewapi.ts",
      "packages/pi-plugin/src/prtarget.ts",
      "packages/pi-plugin/src/ghcred.ts",
      "packages/pi-plugin/src/reviewpost.ts",
    ];
    const entries = [
      "src/wire.ts",
      "src/botworker.ts",
      "src/answerworker.ts",
      "src/loginrefresh/main.ts",
      "src/openviking/sidecar-main.ts",
    ];
    const seen = new Set<string>();
    const via = new Map<string, string>();
    const queue = [...entries];
    while (queue.length > 0) {
      const f = queue.shift()!;
      if (seen.has(f)) continue;
      seen.add(f);
      for (const spec of runtimeSpecifiers(readFileSync(join(ROOT, f), "utf8"))) {
        const to = resolveSpecifier(ROOT, f, spec);
        if (to === null || seen.has(to)) continue;
        if (!via.has(to)) via.set(to, f);
        queue.push(to);
      }
    }
    // the walk reached the daemon's graph, not an empty set
    expect(seen.size).toBeGreaterThan(100);
    const chain = (f: string): string => {
      const path = [f];
      for (let at = via.get(f); at !== undefined; at = via.get(at)) path.unshift(at);
      return path.join(" -> ");
    };
    expect(ROUTE.filter((f) => seen.has(f)).map(chain)).toEqual([]);
  });

  it("the daemon's GitHub code reads no personal token", () => {
    for (const f of DAEMON_GITHUB_FILES) {
      const text = readFileSync(join(ROOT, f), "utf8");
      expect(text, f).not.toMatch(/process\.env\[?\.?["']?(GITHUB_TOKEN|GH_TOKEN)/);
      expect(text, f).not.toMatch(/gh auth token/);
      expect(text, f).not.toMatch(/ghcred|prtarget/);
    }
  });

  it("daemon mode of the image reads no personal token (the entrypoint's mode_daemon)", () => {
    const text = readFileSync(join(ROOT, "docker", "entrypoint.sh"), "utf8");
    const start = text.indexOf("mode_daemon() {");
    const body = text.slice(start, text.indexOf("\n}\n", start));
    expect(start).toBeGreaterThan(0);
    expect(body).not.toMatch(/GITHUB_TOKEN|GH_TOKEN|gh auth token|QCR_GH_TOKEN_FILE|\/run\/qcr-in/);
    // the daemon's git auth is the App's installation token, minted on demand
    expect(body).toMatch(/mint-token\.sh/);
  });

  it("the host wrapper is the one shell route that reads a personal token: to a file, never env or argv", () => {
    const wrapper = readFileSync(join(ROOT, "scripts", "qcr-host.sh"), "utf8")
      .split("\n")
      .filter((l) => !l.trimStart().startsWith("#"))
      .join("\n");
    // it resolves GITHUB_TOKEN, GH_TOKEN, gh (rule 3's carve-out) ...
    expect(wrapper).toMatch(/GITHUB_TOKEN/);
    expect(wrapper).toMatch(/gh auth token/);
    // ... and hands it over only as the read-once file
    expect(wrapper).toMatch(/QCR_GH_TOKEN_FILE=\/run\/qcr-in\/gh-token/);
    expect(wrapper).not.toMatch(/-e\s+"?\$?\{?(GITHUB_TOKEN|GH_TOKEN)/);
    expect(wrapper).not.toMatch(/--env\b|--env-file/);
    // no App on a laptop: nothing mounts the secrets, nothing mints
    expect(wrapper).not.toMatch(/secrets|app\.pem|\bmint\b/);
    // and the daemon's own code never reads the wrapper's file variable
    for (const f of DAEMON_GITHUB_FILES)
      expect(readFileSync(join(ROOT, f), "utf8"), f).not.toMatch(/QCR_GH_TOKEN_FILE|HANDOFF/);
  });

  it("GitHubAdapter's only credential source is the one seam, and it has exactly two shapes", () => {
    // MUTATION: give GitHubAdapter a second credential field, or add a third
    // `implements GitHubCredential` class (say one over process.env) — this fails.
    const text = readFileSync(join(ROOT, "src", "github.ts"), "utf8");
    expect(text).toMatch(/private readonly credential: GitHubCredential/);
    expect(text).not.toMatch(/GITHUB_TOKEN|GH_TOKEN/);
    const auth = readFileSync(join(ROOT, "packages", "pi-plugin", "src", "githubAuth.ts"), "utf8");
    const shapes = [...auth.matchAll(/class (\w+) implements GitHubCredential/g)].map((m) => m[1]);
    expect(shapes.sort()).toEqual(["TokenMinter", "UserTokenSource"]);
  });

  it("user mode reads the token from the secrets-dir file alone — never env or argv", async () => {
    // MUTATION: let UserTokenSource fall back to process.env.GH_TOKEN (or any
    // process.env / process.argv read) when the file is missing — this fails,
    // structurally and behaviourally.
    const auth = readFileSync(join(ROOT, "packages", "pi-plugin", "src", "githubAuth.ts"), "utf8");
    expect(auth).not.toMatch(/process\.(env|argv)/);
    expect(auth).toMatch(/USER_TOKEN_FILE = "github_token"/);
    const start = auth.indexOf("export class UserTokenSource");
    const body = auth.slice(start, auth.indexOf("\n}\n", start));
    expect(start).toBeGreaterThan(0);
    // the one read is of the file under the secrets dir
    expect([...body.matchAll(/readFileSync\(([^,)]+)/g)].map((m) => m[1])).toEqual(["this.path"]);
    expect(body).toMatch(/join\(this\.secretsDir, USER_TOKEN_FILE\)/);

    // Behaviour: a token in the environment and on the command line is never
    // picked up — an empty secrets dir is an error naming the file.
    const empty = mkdtempSync(join(tmp, "no-token-"));
    const saved = { gh: process.env.GH_TOKEN, gt: process.env.GITHUB_TOKEN, argv: process.argv };
    process.env.GH_TOKEN = "ghp_from_env";
    process.env.GITHUB_TOKEN = "ghp_from_env_too";
    process.argv = [...saved.argv, "--token", "ghp_from_argv"];
    try {
      const src = githubCredential({ auth: "user", secrets_dir: empty });
      expect(src).toBeInstanceOf(UserTokenSource);
      await expect(src.installationToken()).rejects.toThrow(/github_token/);
      writeFileSync(join(empty, "github_token"), "ghu_from_file");
      expect(await src.installationToken()).toBe("ghu_from_file");
    } finally {
      if (saved.gh === undefined) delete process.env.GH_TOKEN;
      else process.env.GH_TOKEN = saved.gh;
      if (saved.gt === undefined) delete process.env.GITHUB_TOKEN;
      else process.env.GITHUB_TOKEN = saved.gt;
      process.argv = saved.argv;
    }
    // "app" (and a missing key) stays the App minter.
    expect(githubCredential({ secrets_dir: empty })).toBeInstanceOf(TokenMinter);
    expect(githubCredential({ auth: "app", secrets_dir: empty })).toBeInstanceOf(TokenMinter);
  });

  it("the git credential helper's user branch prints the token file and reads no token from env", () => {
    // MUTATION: make mint-token.sh's user branch print "$GH_TOKEN" (or call
    // `gh auth token`) — this fails.
    const script = readFileSync(join(ROOT, "scripts", "mint-token.sh"), "utf8")
      .split("\n")
      .filter((l) => !l.trimStart().startsWith("#"))
      .join("\n");
    expect(script).toMatch(/TOKEN_FILE="\$SECRETS_DIR\/github_token"/);
    expect(script).not.toMatch(/GH_TOKEN|GITHUB_TOKEN|gh auth token|QCR_GH_TOKEN_FILE/);
  });
});

// ---- the fetch, against a local bare repo -------------------------------------------

const git = (cwd: string, ...args: string[]): string =>
  execFileSync(
    "git",
    ["-c", "user.name=T", "-c", "user.email=t@example.com", "-c", "commit.gpgsign=false", ...args],
    { cwd, encoding: "utf8" },
  ).trim();

/** A "GitHub": <base>/o/r.git with main and a pull/7/head ref. */
function mkRemote(): { base: string; headSha: string; baseSha: string } {
  const base = join(tmp, "gh");
  const work = join(tmp, "work");
  mkdirSync(join(base, "o"), { recursive: true });
  mkdirSync(work, { recursive: true });
  git(work, "init", "-q", "-b", "main");
  writeFileSync(join(work, "a.ts"), "export const a = 1;\n");
  git(work, "add", "-A");
  git(work, "commit", "-q", "-m", "base");
  const baseSha = git(work, "rev-parse", "HEAD");
  git(work, "checkout", "-q", "-b", "feat");
  writeFileSync(join(work, "a.ts"), "export const a = 1;\nexport const b = 2;\n");
  git(work, "commit", "-q", "-am", "feat");
  const headSha = git(work, "rev-parse", "HEAD");
  git(base, "init", "-q", "--bare", join(base, "o", "r.git"));
  git(
    work,
    "push",
    "-q",
    join(base, "o", "r.git"),
    "main:refs/heads/main",
    `feat:refs/pull/7/head`,
  );
  return { base, headSha, baseSha };
}

describe("fetchPrTarget", () => {
  const remote = mkRemote();
  const apiFetch = (calls: Array<{ url: string; auth: string | null }>, over: object = {}) =>
    (async (url: string, init?: RequestInit) => {
      calls.push({
        url,
        auth: new Headers(init?.headers).get("authorization"),
      });
      return new Response(
        JSON.stringify({
          title: "Add b",
          body: "why",
          state: "open",
          head: { sha: remote.headSha },
          base: { ref: "main", sha: remote.baseSha },
          ...over,
        }),
        { status: 200 },
      );
    }) as typeof fetch;

  it("fetches head and base into a scratch repo and reads the diff from it", async () => {
    const calls: Array<{ url: string; auth: string | null }> = [];
    const scratch = join(tmp, "scratch1");
    const r = await fetchPrTarget({
      repo: "o/r",
      number: 7,
      scratchDir: scratch,
      token: "tok",
      fetchFn: apiFetch(calls),
      gitBase: remote.base,
    });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(calls[0]!.url).toBe("https://api.github.com/repos/o/r/pulls/7");
    expect(calls[0]!.auth).toBe("Bearer tok");
    expect(r.gitDir).toBe(scratch);
    expect(r.title).toBe("Add b");
    expect(r.body).toBe("why");
    expect(r.target).toMatchObject({
      repo: "o/r",
      headSha: remote.headSha,
      baseSha: remote.baseSha,
      lines: 1,
    });
    expect(r.target.files.map((f) => f.filename)).toEqual(["a.ts"]);
    expect(r.target.branch).toBe("PR #7");
  });

  it("refuses a closed PR's missing head and a 404 with an actionable message", async () => {
    const notFound = (async () => new Response("{}", { status: 404 })) as unknown as typeof fetch;
    const r = await fetchPrTarget({
      repo: "o/r",
      number: 99,
      scratchDir: join(tmp, "scratch2"),
      token: "tok",
      fetchFn: notFound,
      gitBase: remote.base,
    });
    expect(r.ok).toBe(false);
    expect(!r.ok && r.error).toMatch(/o\/r#99/);
    const unauth = (async () => new Response("{}", { status: 401 })) as unknown as typeof fetch;
    const r2 = await fetchPrTarget({
      repo: "o/r",
      number: 7,
      scratchDir: join(tmp, "scratch3"),
      token: "bad",
      fetchFn: unauth,
      gitBase: remote.base,
    });
    expect(!r2.ok && r2.error).toMatch(/rejected|401/);
  });

  it("reports a head that git cannot fetch", async () => {
    const r = await fetchPrTarget({
      repo: "o/r",
      number: 8, // no pull/8/head ref in the remote
      scratchDir: join(tmp, "scratch4"),
      token: "tok",
      fetchFn: apiFetch([]),
      gitBase: remote.base,
    });
    expect(r.ok).toBe(false);
    expect(!r.ok && r.error).toMatch(/fetch/i);
  });

  it("runs git off the event loop, and a stop ends a fetch in flight", async () => {
    const stop = new AbortController();
    const seen: string[] = [];
    let ticks = 0;
    const timer = setInterval(() => ticks++, 5);
    try {
      const r = await fetchPrTarget({
        repo: "o/r",
        number: 7,
        scratchDir: join(tmp, "scratch-stop"),
        token: "tok",
        fetchFn: apiFetch([]),
        gitBase: remote.base,
        signal: stop.signal,
        // git's fetch hangs until the stop; the event loop keeps turning meanwhile
        exec: (_cmd, args, o) => {
          seen.push(args[0]!);
          if (args[0] !== "fetch") return Promise.resolve({ code: 0, stdout: "", stderr: "" });
          expect(o?.signal).toBe(stop.signal);
          expect(o?.timeoutMs).toBeGreaterThan(0);
          setTimeout(() => stop.abort(), 30);
          return new Promise((_, fail) =>
            o!.signal!.addEventListener("abort", () => fail(new Error("aborted")), { once: true }),
          );
        },
      });
      expect(r.ok).toBe(false);
      expect(!r.ok && r.error).toMatch(/stopped/);
      expect(seen).toEqual(["init", "fetch"]);
      expect(ticks).toBeGreaterThan(0);
    } finally {
      clearInterval(timer);
    }
  });

  it("never writes the token into the scratch repo's config", async () => {
    const scratch = join(tmp, "scratch5");
    await fetchPrTarget({
      repo: "o/r",
      number: 7,
      scratchDir: scratch,
      token: "SECRET-TOKEN-VALUE",
      fetchFn: apiFetch([]),
      gitBase: remote.base,
    });
    expect(readFileSync(join(scratch, ".git", "config"), "utf8")).not.toContain(
      "SECRET-TOKEN-VALUE",
    );
  });
});
