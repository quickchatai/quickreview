// `qcr review <PR>`: the target, the credential chain and the daemon fence
// (src/prtarget.ts, src/ghcred.ts). Git is real (a local bare repo stands in
// for github.com); the GitHub API, `gh` and the App are stubs. No network.

import { afterAll, describe, expect, it } from "vitest";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { resolveGithubCredential, MISSING_CREDENTIAL_HELP } from "../src/ghcred.js";
import { fetchPrTarget, parsePrTarget } from "../src/prtarget.js";

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

describe("the daemon stays App-only (CLAUDE.md rule 3)", () => {
  const srcFiles = (dir: string): string[] =>
    readdirSync(dir, { withFileTypes: true }).flatMap((e) =>
      e.isDirectory()
        ? srcFiles(join(dir, e.name))
        : e.name.endsWith(".ts")
          ? [join(dir, e.name)]
          : [],
    );

  it("only the local review route (and cli.ts's startup handoff read) imports the credential chain", () => {
    const importers = srcFiles(join(ROOT, "src"))
      .filter((f) => /from "[^"]*\/ghcred\.js"|from "\.\/ghcred\.js"/.test(readFileSync(f, "utf8")))
      .map((f) => f.slice(ROOT.length + 1))
      .sort();
    expect(importers).toEqual(["src/cli.ts", "src/prtarget.ts", "src/reviewcli.ts"].sort());
  });

  it("the daemon's GitHub code reads no personal token", () => {
    for (const f of ["github.ts", "githubAuth.ts", "daemon.ts", "wire.ts", "sessions.ts"]) {
      const text = readFileSync(join(ROOT, "src", f), "utf8");
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
    // ... and hands it over only as the read-once file (D39)
    expect(wrapper).toMatch(/QCR_GH_TOKEN_FILE=\/run\/qcr-in\/gh-token/);
    expect(wrapper).not.toMatch(/-e\s+"?\$?\{?(GITHUB_TOKEN|GH_TOKEN)/);
    expect(wrapper).not.toMatch(/--env\b|--env-file/);
    // no App on a laptop (D14): nothing mounts the secrets, nothing mints
    expect(wrapper).not.toMatch(/secrets|app\.pem|\bmint\b/);
    // and the daemon's own code never reads the wrapper's file variable
    for (const f of ["github.ts", "githubAuth.ts", "daemon.ts", "wire.ts", "sessions.ts"])
      expect(readFileSync(join(ROOT, "src", f), "utf8"), f).not.toMatch(
        /QCR_GH_TOKEN_FILE|HANDOFF/,
      );
  });

  it("GitHubAdapter's only credential source is the App TokenMinter", () => {
    const text = readFileSync(join(ROOT, "src", "github.ts"), "utf8");
    expect(text).toMatch(/private readonly minter: TokenMinter/);
    expect(text).not.toMatch(/GITHUB_TOKEN|GH_TOKEN/);
  });

  // The rule names a private login; the published test file must not spell it out.
  const PRIVATE_LOGIN = ["mha", "le"].join("");
  it("CLAUDE.md rule 3 is the ratified text (owner, 2026-10-19)", () => {
    // Rule text changes only by the owner's ratification, so the test pins it
    // verbatim (whitespace folded: CLAUDE.md wraps it). The carve-out is the
    // credential only: the post still goes through the gate, and the token
    // handoff is a read-and-unlinked file, never env or argv.
    const RATIFIED =
      "[private rule text removed]";
    const text = readFileSync(join(ROOT, "docs", "rulebook", "hard-rules.md"), "utf8");
    const start = text.indexOf("\n3. ");
    const end = text.indexOf("\n4. ", start);
    expect(start).toBeGreaterThan(-1);
    const rule = text
      .slice(start + 4, end)
      .replace(/\s+/g, " ")
      .trim();
    expect(rule).toBe(RATIFIED.replace("${PRIVATE_LOGIN}", PRIVATE_LOGIN));
  });

  it("CLAUDE.md rule 1 carries the ratified image paragraph (owner, 2026-10-19)", () => {
    const PARAGRAPH =
      "[private rule text removed]";
    const text = readFileSync(join(ROOT, "docs", "rulebook", "hard-rules.md"), "utf8");
    const start = text.indexOf("\n1. ");
    const end = text.indexOf("\n2. ", start);
    expect(start).toBeGreaterThan(-1);
    const rule = text
      .slice(start + 4, end)
      .replace(/\s+/g, " ")
      .trim();
    expect(rule).toContain(PARAGRAPH);
    // The paragraph follows the two exceptions and no others, and the workers
    // paragraph (pinned word for word in tests/ratified-rule-texts.test.ts)
    // follows it and closes the rule.
    expect(rule).toContain("Two exceptions, and no others:");
    const workers = rule.indexOf("**The bot's workers are not a route of their own.**");
    expect(workers).toBeGreaterThan(rule.indexOf(PARAGRAPH) + PARAGRAPH.length - 1);
    expect(rule.endsWith("No worker holds a GitHub token.")).toBe(true);
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
