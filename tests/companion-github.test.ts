// the companion's read-only GitHub token, minted on the host.
// What matters is external: what is ASKED of GitHub (read-only permissions,
// one repository), what is REFUSED (a grant wider than read), and what lands
// in the env file the companion mounts (the token, never the App key).
//
// H4: the file is `source`d in the container, so one test sources it
// with the real `sh`. That makes this a process suite
// (tests/helpers/suite-timeouts.ts PROCESS_SUITES).
import { execFileSync } from "node:child_process";
import { createHash, generateKeyPairSync } from "node:crypto";
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import {
  COMPANION_GITHUB_PERMISSIONS,
  CompanionGithubToken,
  EXPIRES_VAR,
  REFRESH_MARGIN_MS,
  REPO_VAR,
  TOKEN_FILE,
  TOKEN_VAR,
  mintReadOnlyToken,
  readOnlyGrantProblem,
  renderTokenEnv,
  tokenOutcomeLine,
  writeTokenEnv,
} from "../src/tui/ghread.js";
import { companionGithubDir, configHome, stateHome } from "../src/install.js";
import { tokenFileGitHubReader } from "../src/setup/adapters.js";

const { privateKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
const PEM = privateKey.export({ type: "pkcs8", format: "pem" }).toString();
const NOW = Date.parse("2026-09-29T10:00:00Z");
const EXPIRES = "2026-09-29T11:00:00Z";

/**
 * A SYNTHETIC token in GitHub's installation-token format as of 2026-10:
 * `ghs_`, then three base64url segments joined by dots, 383 characters. The
 * shape was measured on a real token that scripts/mint-token.sh cached on
 * 2026-10-07: segments of 48 (with the prefix), 247 and 86 characters, with
 * `-`, `.` and `_` beside the alphanumerics. No real token is in this file.
 */
function realFormatToken(): string {
  const b64url = (n: number, seed: string): string => {
    let s = "";
    while (s.length < n)
      s += createHash("sha256").update(`${seed}:${s.length}`).digest("base64url");
    return s.slice(0, n);
  };
  return `ghs_${b64url(44, "installation")}.${b64url(247, "claims")}.${b64url(86, "signature")}`;
}
const REAL_FORMAT_TOKEN = realFormatToken();

interface Call {
  url: string;
  method: string;
  body?: unknown;
  auth?: string;
}

/** A GitHub that answers the installation lookup and the token mint. */
function fakeGithub(
  grant: Record<string, unknown> = { ...COMPANION_GITHUB_PERMISSIONS, metadata: "read" },
  token = "ghs_readonly123",
) {
  const calls: Call[] = [];
  const fetchFn = (async (url: string, init?: RequestInit) => {
    const headers = (init?.headers ?? {}) as Record<string, string>;
    calls.push({
      url,
      method: init?.method ?? "GET",
      body: init?.body ? JSON.parse(String(init.body)) : undefined,
      auth: headers.authorization,
    });
    if (url.endsWith("/repos/acme/widgets/installation"))
      return new Response(JSON.stringify({ id: 42 }), { status: 200 });
    if (url.endsWith("/app/installations/42/access_tokens"))
      return new Response(
        JSON.stringify({
          token,
          expires_at: EXPIRES,
          permissions: grant,
          repositories: [{ name: "widgets" }],
        }),
        { status: 201 },
      );
    return new Response("nope", { status: 404 });
  }) as unknown as typeof fetch;
  return { fetchFn, calls };
}

const tmp = mkdtempSync(join(tmpdir(), "qcr-ghread-"));
afterAll(() => rmSync(tmp, { recursive: true, force: true }));

function secrets(): string {
  const dir = mkdtempSync(join(tmp, "secrets-"));
  writeFileSync(join(dir, "app_id"), "12345\n");
  writeFileSync(join(dir, "app.pem"), PEM);
  return dir;
}

describe("mintReadOnlyToken", () => {
  it("asks GitHub for read-only contents / issues / pull requests on ONE repository", async () => {
    const gh = fakeGithub();
    const tok = await mintReadOnlyToken({
      appId: "12345",
      pem: PEM,
      repo: "acme/widgets",
      fetchFn: gh.fetchFn,
      now: () => NOW,
    });
    expect(tok.token).toBe("ghs_readonly123");
    const mint = gh.calls.find((c) => c.method === "POST")!;
    expect(mint.url).toBe("https://api.github.com/app/installations/42/access_tokens");
    expect(mint.body).toEqual({
      repositories: ["widgets"],
      permissions: { contents: "read", issues: "read", pull_requests: "read" },
    });
    // JWT-authed as the App — the host holds the key, the companion never does.
    expect(mint.auth).toMatch(/^Bearer [\w-]+\.[\w-]+\.[\w-]+$/);
  });

  it("pins the permission set to reads only", () => {
    expect(COMPANION_GITHUB_PERMISSIONS).toEqual({
      contents: "read",
      issues: "read",
      pull_requests: "read",
    });
    expect(Object.isFrozen(COMPANION_GITHUB_PERMISSIONS)).toBe(true);
  });

  it("refuses a token whose reported grant is wider than read", async () => {
    for (const grant of [
      { contents: "write", issues: "read", pull_requests: "read" },
      { contents: "read", pull_requests: "read", issues: "read", checks: "read" },
      { contents: "read", administration: "write" },
    ]) {
      await expect(
        mintReadOnlyToken({
          appId: "1",
          pem: PEM,
          repo: "acme/widgets",
          fetchFn: fakeGithub(grant).fetchFn,
        }),
      ).rejects.toThrow(/refused the minted token/);
    }
    expect(readOnlyGrantProblem(undefined)).toBeDefined();
    expect(readOnlyGrantProblem({})).toBeDefined();
    expect(readOnlyGrantProblem({ contents: "read", metadata: "read" })).toBeUndefined();
  });

  it("refuses a repo that is not owner/name before calling anything", async () => {
    const gh = fakeGithub();
    await expect(
      mintReadOnlyToken({ appId: "1", pem: PEM, repo: "../etc", fetchFn: gh.fetchFn }),
    ).rejects.toThrow(/owner\/name/);
    expect(gh.calls).toEqual([]);
  });
});

describe("CompanionGithubToken — the env file the companion mounts", () => {
  it("writes the token as a 0600 env file in a 0700 dir, and never the App key", async () => {
    const dir = join(tmp, "out-1");
    const t = new CompanionGithubToken({
      dir,
      repo: "acme/widgets",
      secretsDir: secrets(),
      fetchFn: fakeGithub().fetchFn,
      now: () => NOW,
    });
    const outcome = await t.refresh();
    expect(outcome).toEqual({ kind: "minted", expiresAt: EXPIRES });
    const text = readFileSync(join(dir, TOKEN_FILE), "utf8");
    expect(text).toContain(`${TOKEN_VAR}=ghs_readonly123\n`);
    expect(text).toContain(`${EXPIRES_VAR}=${EXPIRES}\n`);
    expect(text).toContain(`${REPO_VAR}=acme/widgets\n`);
    expect(text).not.toContain("PRIVATE KEY");
    expect(text).not.toContain("12345");
    // Never a name any tool picks up on its own.
    expect(text).not.toMatch(/^(GH_TOKEN|GITHUB_TOKEN)=/m);
    // A docker env file and `source`-able: NAME=value lines or comments only.
    for (const line of text.split("\n").filter((l) => l !== "" && !l.startsWith("#")))
      expect(line).toMatch(/^[A-Z_]+=[^\s'"$`]+$/);
    expect(statSync(join(dir, TOKEN_FILE)).mode & 0o777).toBe(0o600);
    expect(statSync(dir).mode & 0o777).toBe(0o700);
  });

  it("re-mints only inside the refresh margin", async () => {
    const dir = join(tmp, "out-2");
    const gh = fakeGithub();
    let now = NOW;
    const t = new CompanionGithubToken({
      dir,
      repo: "acme/widgets",
      secretsDir: secrets(),
      fetchFn: gh.fetchFn,
      now: () => now,
    });
    expect((await t.refresh()).kind).toBe("minted");
    const mints = () => gh.calls.filter((c) => c.method === "POST").length;
    now = Date.parse(EXPIRES) - REFRESH_MARGIN_MS - 60_000;
    expect((await t.refresh()).kind).toBe("fresh");
    expect(mints()).toBe(1);
    now = Date.parse(EXPIRES) - REFRESH_MARGIN_MS + 60_000;
    expect((await t.refresh()).kind).toBe("minted");
    expect(mints()).toBe(2);
  });

  it("a token minted for another repo is not fresh — a changed [github] repo re-mints at once", async () => {
    const dir = join(tmp, "out-5");
    const gh = fakeGithub();
    const t = new CompanionGithubToken({
      dir,
      repo: "acme/widgets",
      secretsDir: secrets(),
      fetchFn: gh.fetchFn,
      now: () => NOW,
    });
    expect((await t.refresh()).kind).toBe("minted");
    writeFileSync(
      join(dir, TOKEN_FILE),
      readFileSync(join(dir, TOKEN_FILE), "utf8").replace("acme/widgets", "acme/other"),
    );
    expect((await t.refresh()).kind).toBe("minted");
    expect(gh.calls.filter((c) => c.method === "POST")).toHaveLength(2);
  });

  it("bounds every GitHub call with a timeout — a hung API cannot hold the bring-up", async () => {
    const signals: (AbortSignal | null | undefined)[] = [];
    const inner = fakeGithub().fetchFn;
    const fetchFn = ((url: string, init?: RequestInit) => {
      signals.push(init?.signal);
      return inner(url, init);
    }) as unknown as typeof fetch;
    await mintReadOnlyToken({
      appId: "1",
      pem: PEM,
      repo: "acme/widgets",
      fetchFn,
      now: () => NOW,
    });
    expect(signals).toHaveLength(2);
    for (const sig of signals) expect(sig).toBeInstanceOf(AbortSignal);
  });

  it("is total: no App credential, or GitHub failing, is an outcome — never a throw", async () => {
    const none = new CompanionGithubToken({
      dir: join(tmp, "out-3"),
      repo: "acme/widgets",
      secretsDir: join(tmp, "no-such-secrets"),
      fetchFn: fakeGithub().fetchFn,
    });
    const u = await none.refresh();
    expect(u.kind).toBe("unavailable");
    expect(tokenOutcomeLine(u)).toMatch(/no read-only GitHub token/);

    const wide = new CompanionGithubToken({
      dir: join(tmp, "out-4"),
      repo: "acme/widgets",
      secretsDir: secrets(),
      fetchFn: fakeGithub({ contents: "write" }).fetchFn,
      now: () => NOW,
    });
    const f = await wide.refresh();
    expect(f.kind).toBe("failed");
    // A refused grant writes NOTHING the companion could pick up.
    expect(() => readFileSync(join(tmp, "out-4", TOKEN_FILE))).toThrow();
  });
});

// H4. From 2026-10-02 to 2026-10-08 the companion never received
// its token. renderTokenEnv accepted only [A-Za-z0-9_], but GitHub's
// installation tokens now also contain `.` and `-`. Each 5-minute refresh
// minted a real token and threw it away.
describe("GitHub's current token format — the env file carries it, and only safe characters", () => {
  it("the sample has the real token's shape", () => {
    expect(REAL_FORMAT_TOKEN).toHaveLength(383);
    expect(REAL_FORMAT_TOKEN.startsWith("ghs_")).toBe(true);
    expect(REAL_FORMAT_TOKEN.split(".").map((s) => s.length)).toEqual([48, 247, 86]);
    // The two characters the old plain-word check refused.
    expect(REAL_FORMAT_TOKEN).toContain("-");
    expect(REAL_FORMAT_TOKEN).toContain(".");
  });

  it("a real-format token is minted and written to the env file whole", async () => {
    const dir = join(tmp, "out-real");
    const t = new CompanionGithubToken({
      dir,
      repo: "acme/widgets",
      secretsDir: secrets(),
      fetchFn: fakeGithub(undefined, REAL_FORMAT_TOKEN).fetchFn,
      now: () => NOW,
    });
    expect(await t.refresh()).toEqual({ kind: "minted", expiresAt: EXPIRES });
    const text = readFileSync(join(dir, TOKEN_FILE), "utf8");
    expect(text).toContain(`\n${TOKEN_VAR}=${REAL_FORMAT_TOKEN}\n`);
    for (const line of text.split("\n").filter((l) => l !== "" && !l.startsWith("#")))
      expect(line).toMatch(/^[A-Z_]+=[^\s'"$`\\#]+$/);
    // Fresh now: the next check mints nothing. Before H4, every check minted.
    expect((await t.refresh()).kind).toBe("fresh");
  });

  it("sourced by a real shell, the file yields exactly the token, the expiry and the repo", () => {
    const dir = join(tmp, "out-sourced");
    const file = writeTokenEnv(dir, renderTokenEnv(tokenOf(REAL_FORMAT_TOKEN), "acme/widgets"));
    // The way prompts/companion.md tells the companion to read it.
    const out = execFileSync(
      "sh",
      [
        "-c",
        '. "$1" && printf "%s\\n%s\\n%s" "$QCR_GITHUB_READ_TOKEN" "$QCR_GITHUB_READ_EXPIRES_AT" "$QCR_GITHUB_REPO"',
        "sh",
        file,
      ],
      { encoding: "utf8", cwd: dir },
    );
    expect(out).toBe(`${REAL_FORMAT_TOKEN}\n${EXPIRES}\nacme/widgets`);
  });

  it("the container's reader sends the whole token as the bearer", async () => {
    const file = writeTokenEnv(
      join(tmp, "out-reader"),
      renderTokenEnv(tokenOf(REAL_FORMAT_TOKEN), "acme/widgets"),
    );
    const auths: string[] = [];
    const gh = tokenFileGitHubReader({
      envFile: file,
      fetch: (async (_url: string, init?: RequestInit) => {
        auths.push((init?.headers as Record<string, string>).Authorization!);
        return new Response("{}", { status: 200 });
      }) as unknown as typeof fetch,
      clock: () => new Date(NOW),
    });
    expect((await gh.get("/repos/acme/widgets")).ok).toBe(true);
    expect(auths).toEqual([`Bearer ${REAL_FORMAT_TOKEN}`]);
  });

  it("still refuses a token with whitespace, quotes, $, a backtick, a backslash, # or a newline", async () => {
    const bad = [
      "ghs_a b",
      "ghs_a\tb",
      "ghs_a'b",
      'ghs_a"b',
      "ghs_a$b",
      "ghs_$(id)",
      "ghs_a`id`",
      "ghs_a\\b",
      "ghs_a#b",
      "ghs_a*",
      "ghs_a\nGH_TOKEN=x",
      "ghs_a\r",
      "ghs_a;id",
      "",
      `${REAL_FORMAT_TOKEN} `,
    ];
    for (const token of bad) {
      expect(() => renderTokenEnv(tokenOf(token), "acme/widgets"), JSON.stringify(token)).toThrow(
        /a character an env file cannot carry safely/,
      );
    }
    // Through the refresh too: a failed outcome that never echoes the token,
    // and no file the companion could pick up.
    const dir = join(tmp, "out-bad-token");
    const t = new CompanionGithubToken({
      dir,
      repo: "acme/widgets",
      secretsDir: secrets(),
      fetchFn: fakeGithub(undefined, "ghs_secret$(id)").fetchFn,
      now: () => NOW,
    });
    const o = await t.refresh();
    expect(o.kind).toBe("failed");
    expect(tokenOutcomeLine(o)).not.toContain("ghs_secret");
    expect(existsSync(join(dir, TOKEN_FILE))).toBe(false);
  });

  it("widening the charset widened nothing else: a wider grant is still refused", async () => {
    for (const grant of [
      { contents: "write", issues: "read", pull_requests: "read", metadata: "read" },
      { ...COMPANION_GITHUB_PERMISSIONS, actions: "read" },
    ]) {
      await expect(
        mintReadOnlyToken({
          appId: "1",
          pem: PEM,
          repo: "acme/widgets",
          fetchFn: fakeGithub(grant, REAL_FORMAT_TOKEN).fetchFn,
          now: () => NOW,
        }),
      ).rejects.toThrow(/refused the minted token/);
    }
    const dir = join(tmp, "out-real-wide");
    const t = new CompanionGithubToken({
      dir,
      repo: "acme/widgets",
      secretsDir: secrets(),
      fetchFn: fakeGithub({ contents: "write" }, REAL_FORMAT_TOKEN).fetchFn,
      now: () => NOW,
    });
    expect((await t.refresh()).kind).toBe("failed");
    expect(existsSync(join(dir, TOKEN_FILE))).toBe(false);
  });
});

function tokenOf(token: string) {
  return { token, expires_at: EXPIRES, permissions: { contents: "read" } };
}

describe("where the token dir lives", () => {
  it("sits outside both install homes and the operator's config tree", () => {
    const env = { HOME: "/h", XDG_CONFIG_HOME: "/h/cfg", XDG_STATE_HOME: "/h/st" };
    const dir = companionGithubDir(env);
    expect(dir).toBe("/h/st/qcr-operator/default/companion-github");
    // Not inside the state home (mounted rw into the companion) nor the
    // config home (shipped to the VM, and it holds secrets/).
    expect(dir.startsWith(`${stateHome(env)}/`)).toBe(false);
    expect(dir.startsWith(`${configHome(env)}/`)).toBe(false);
  });
});
