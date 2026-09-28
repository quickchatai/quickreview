// the companion's read-only GitHub token, minted on the host.
// What matters is external: what is ASKED of GitHub (read-only permissions,
// one repository), what is REFUSED (a grant wider than read), and what lands
// in the env file the companion mounts (the token, never the App key).
import { generateKeyPairSync } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
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
  tokenOutcomeLine,
} from "../src/tui/ghread.js";
import { companionGithubDir, configHome, stateHome } from "../src/install.js";

const { privateKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
const PEM = privateKey.export({ type: "pkcs8", format: "pem" }).toString();
const NOW = Date.parse("2026-09-29T10:00:00Z");
const EXPIRES = "2026-09-29T11:00:00Z";

interface Call {
  url: string;
  method: string;
  body?: unknown;
  auth?: string;
}

/** A GitHub that answers the installation lookup and the token mint. */
function fakeGithub(grant: Record<string, unknown> = { ...COMPANION_GITHUB_PERMISSIONS, metadata: "read" }) {
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
          token: "ghs_readonly123",
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
    await mintReadOnlyToken({ appId: "1", pem: PEM, repo: "acme/widgets", fetchFn, now: () => NOW });
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
