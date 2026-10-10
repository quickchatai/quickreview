import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { generateKeyPairSync, createVerify } from "node:crypto";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { TokenMinter, mintAppJwt, type FetchFn } from "../src/githubAuth.js";

// A real throwaway RSA key, generated in-process — no filesystem secret and no
// network anywhere in this file.
const { privateKey, publicKey } = generateKeyPairSync("rsa", {
  modulusLength: 2048,
  publicKeyEncoding: { type: "spki", format: "pem" },
  privateKeyEncoding: { type: "pkcs8", format: "pem" },
});

const APP_ID = "1234567";
const T0 = Date.parse("2026-08-13T12:00:00.000Z");

let secretsDir: string;

beforeEach(() => {
  secretsDir = mkdtempSync(join(tmpdir(), "qcr-secrets-"));
  writeFileSync(join(secretsDir, "app_id"), `${APP_ID}\n`);
  writeFileSync(join(secretsDir, "app.pem"), privateKey);
});
afterEach(() => {
  rmSync(secretsDir, { recursive: true, force: true });
});

function decode(jwt: string) {
  const [h, p] = jwt.split(".");
  return {
    header: JSON.parse(Buffer.from(h!, "base64url").toString("utf8")),
    payload: JSON.parse(Buffer.from(p!, "base64url").toString("utf8")),
  };
}

function jsonResponse(body: unknown, status = 200): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
    text: async () => JSON.stringify(body),
  } as unknown as Response;
}

/** A fake fetch that serves /app/installations and the mint endpoint. */
function fakeGitHub(opts: { expiresAt: () => string; installationId?: number }) {
  const calls: Array<{ url: string; init?: RequestInit }> = [];
  let minted = 0;
  const fetchFn = (async (url: string | URL, init?: RequestInit) => {
    const u = String(url);
    calls.push({ url: u, init });
    if (u.endsWith("/app/installations")) return jsonResponse([{ id: opts.installationId ?? 42 }]);
    if (u.includes("/access_tokens")) {
      minted += 1;
      return jsonResponse({ token: `ghs_token_${minted}`, expires_at: opts.expiresAt() }, 201);
    }
    throw new Error(`unexpected fetch ${u}`);
  }) as unknown as FetchFn;
  return {
    fetchFn,
    calls,
    mints: () => minted,
    installCalls: () => calls.filter((c) => c.url.endsWith("/app/installations")).length,
  };
}

describe("mintAppJwt", () => {
  it("produces an RS256 JWT with iat 60s in the past and exp 10 min out", () => {
    const jwt = mintAppJwt(APP_ID, privateKey, () => T0);
    const { header, payload } = decode(jwt);

    expect(header).toEqual({ alg: "RS256", typ: "JWT" });
    expect(payload.iss).toBe(APP_ID);
    expect(payload.iat).toBe(Math.floor(T0 / 1000) - 60);
    expect(payload.exp - payload.iat).toBe(600);
    // exp is never more than 10 minutes past the real clock (GitHub's JWT limit).
    expect(payload.exp - Math.floor(T0 / 1000)).toBeLessThanOrEqual(600);
  });

  it("signs with the app private key (verifiable with its public half)", () => {
    const jwt = mintAppJwt(APP_ID, privateKey, () => T0);
    const [h, p, sig] = jwt.split(".");
    const verifier = createVerify("RSA-SHA256");
    verifier.update(`${h}.${p}`);
    expect(verifier.verify(publicKey, Buffer.from(sig!, "base64url"))).toBe(true);
  });

  it("mints a fresh JWT each call (iat tracks the clock)", () => {
    let now = T0;
    const a = decode(mintAppJwt(APP_ID, privateKey, () => now)).payload;
    now = T0 + 120_000;
    const b = decode(mintAppJwt(APP_ID, privateKey, () => now)).payload;
    expect(b.iat - a.iat).toBe(120);
  });
});

describe("TokenMinter", () => {
  it("reads app_id/app.pem from the secrets dir and authorizes with the JWT", async () => {
    const gh = fakeGitHub({ expiresAt: () => new Date(T0 + 3600_000).toISOString() });
    const minter = new TokenMinter(secretsDir, gh.fetchFn, "https://api.github.com", () => T0);

    const token = await minter.installationToken();

    expect(token).toBe("ghs_token_1");
    const auth = (gh.calls[0]!.init!.headers as Record<string, string>)["authorization"]!;
    expect(auth.startsWith("Bearer ")).toBe(true);
    expect(decode(auth.slice(7)).payload.iss).toBe(APP_ID);
    expect(gh.calls[1]!.url).toBe("https://api.github.com/app/installations/42/access_tokens");
    expect(gh.calls[1]!.init!.method).toBe("POST");
  });

  it("caches the installation id after the first resolve", async () => {
    const gh = fakeGitHub({ expiresAt: () => new Date(T0 + 3600_000).toISOString() });
    const minter = new TokenMinter(secretsDir, gh.fetchFn, "https://api.github.com", () => T0);
    await minter.resolveInstallationId();
    await minter.resolveInstallationId();
    expect(gh.installCalls()).toBe(1);
  });

  it("reuses a cached token while more than 5 minutes remain", async () => {
    let now = T0;
    const gh = fakeGitHub({ expiresAt: () => new Date(now + 3600_000).toISOString() });
    const minter = new TokenMinter(secretsDir, gh.fetchFn, "https://api.github.com", () => now);

    expect(await minter.installationToken()).toBe("ghs_token_1");
    now = T0 + 50 * 60_000; // 10 min of life left — still outside the margin
    expect(await minter.installationToken()).toBe("ghs_token_1");
    expect(gh.mints()).toBe(1);
  });

  it("refreshes proactively once expires_at - now drops inside the 5-min margin", async () => {
    let now = T0;
    const gh = fakeGitHub({ expiresAt: () => new Date(now + 3600_000).toISOString() });
    const minter = new TokenMinter(secretsDir, gh.fetchFn, "https://api.github.com", () => now);

    expect(await minter.installationToken()).toBe("ghs_token_1");
    now = T0 + 56 * 60_000; // 4 min left → inside the margin
    expect(await minter.installationToken()).toBe("ghs_token_2");
    expect(gh.mints()).toBe(2);
  });

  it("treats exactly-at-the-margin as stale (strict >)", async () => {
    let now = T0;
    const gh = fakeGitHub({ expiresAt: () => new Date(now + 3600_000).toISOString() });
    const minter = new TokenMinter(secretsDir, gh.fetchFn, "https://api.github.com", () => now);
    await minter.installationToken();
    now = T0 + 55 * 60_000; // exactly 5 min left
    await minter.installationToken();
    expect(gh.mints()).toBe(2);
  });

  it("single-flights concurrent mints — two callers, one POST", async () => {
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    let minted = 0;
    const fetchFn = (async (url: string | URL) => {
      const u = String(url);
      if (u.endsWith("/app/installations")) return jsonResponse([{ id: 42 }]);
      minted += 1;
      await gate;
      return jsonResponse(
        { token: `ghs_token_${minted}`, expires_at: new Date(T0 + 3600_000).toISOString() },
        201,
      );
    }) as unknown as FetchFn;

    const minter = new TokenMinter(secretsDir, fetchFn, "https://api.github.com", () => T0);
    await minter.resolveInstallationId(); // isolate the mint from the resolve

    const both = Promise.all([minter.installationToken(), minter.installationToken()]);
    release();
    const [a, b] = await both;

    expect(minted).toBe(1);
    expect(a).toBe("ghs_token_1");
    expect(b).toBe(a);

    // The in-flight entry is cleared, so a later stale call can mint again.
    minter.invalidate();
    await minter.installationToken();
    expect(minted).toBe(2);
  });

  it("invalidate() drops the cache so the next call re-mints (the 401 path)", async () => {
    const gh = fakeGitHub({ expiresAt: () => new Date(T0 + 3600_000).toISOString() });
    const minter = new TokenMinter(secretsDir, gh.fetchFn, "https://api.github.com", () => T0);

    expect(await minter.installationToken()).toBe("ghs_token_1");
    minter.invalidate(42);
    expect(await minter.installationToken()).toBe("ghs_token_2");

    minter.invalidate(); // clear-all form
    expect(await minter.installationToken()).toBe("ghs_token_3");
    expect(gh.mints()).toBe(3);
  });

  it("surfaces a failed mint and an installation-less app", async () => {
    const failing = (async (url: string | URL) => {
      const u = String(url);
      if (u.endsWith("/app/installations")) return jsonResponse([{ id: 42 }]);
      return jsonResponse({ message: "Bad credentials" }, 401);
    }) as unknown as FetchFn;
    await expect(
      new TokenMinter(secretsDir, failing, "https://api.github.com", () => T0).installationToken(),
    ).rejects.toThrow(/token mint failed for installation 42: 401/);

    const empty = (async () => jsonResponse([])) as unknown as FetchFn;
    await expect(
      new TokenMinter(
        secretsDir,
        empty,
        "https://api.github.com",
        () => T0,
      ).resolveInstallationId(),
    ).rejects.toThrow(/no installations/);

    const broken = (async () => jsonResponse({ message: "nope" }, 500)) as unknown as FetchFn;
    await expect(
      new TokenMinter(
        secretsDir,
        broken,
        "https://api.github.com",
        () => T0,
      ).resolveInstallationId(),
    ).rejects.toThrow(/GET \/app\/installations failed: 500/);
  });

  it("uses only the app PEM — no environment token is ever consulted", async () => {
    vi.stubEnv("GITHUB_TOKEN", "ghp_personal_should_never_be_used");
    const gh = fakeGitHub({ expiresAt: () => new Date(T0 + 3600_000).toISOString() });
    const minter = new TokenMinter(secretsDir, gh.fetchFn, "https://api.github.com", () => T0);
    const token = await minter.installationToken();
    expect(token).toBe("ghs_token_1");
    for (const call of gh.calls) {
      const auth = (call.init!.headers as Record<string, string>)["authorization"]!;
      expect(auth).not.toContain("ghp_personal_should_never_be_used");
    }
    vi.unstubAllEnvs();
  });
});
