// GitHub App authentication: RS256 app JWTs and cached installation tokens.
// The JWT is backdated 60 s against clock skew and lives 600 s from that iat
// (9 min from now); scripts/mint-token.sh signs its own with a 540 s life
// (8 min from now). Both stay under GitHub's 10-minute ceiling. Tokens are
// cached per installation off `expires_at` with a ~5 min proactive refresh
// window, refreshed single-flight, re-minted once on a 401 (by the caller's
// `invalidate`). Every request carries the adapter's 60 s deadline.
// The app PEM is the only credential anywhere — no personal token code path.
import { createSign } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";

export type FetchFn = typeof fetch;

function b64url(input: Buffer | string): string {
  return Buffer.from(input).toString("base64url");
}

export function mintAppJwt(
  appId: string,
  privateKeyPem: string,
  now: () => number = Date.now,
): string {
  const iat = Math.floor(now() / 1000) - 60;
  const header = b64url(JSON.stringify({ alg: "RS256", typ: "JWT" }));
  const payload = b64url(JSON.stringify({ iat, exp: iat + 600, iss: appId }));
  const signer = createSign("RSA-SHA256");
  signer.update(`${header}.${payload}`);
  return `${header}.${payload}.${signer.sign(privateKeyPem, "base64url")}`;
}

export interface InstallationToken {
  token: string;
  expires_at: string;
}

const REFRESH_MARGIN_MS = 5 * 60 * 1000;

/** The deadline on each request — the same as the adapter's REST calls, so a
 * stalled mint cannot hold every caller waiting on its shared promise. */
const REQUEST_TIMEOUT_MS = 60_000;

export class TokenMinter {
  private cache = new Map<number, InstallationToken>();
  private inflight = new Map<number, Promise<string>>();
  private installationId: number | null = null;

  constructor(
    private readonly secretsDir: string,
    private readonly fetchFn: FetchFn = fetch,
    private readonly apiBase = "https://api.github.com",
    private readonly now: () => number = Date.now,
  ) {}

  private readSecret(name: string): string {
    return readFileSync(join(this.secretsDir, name), "utf8").trim();
  }

  appJwt(): string {
    return mintAppJwt(
      this.readSecret("app_id"),
      readFileSync(join(this.secretsDir, "app.pem"), "utf8"),
      this.now,
    );
  }

  /** Resolve (and cache) the single installation this app serves. */
  async resolveInstallationId(): Promise<number> {
    if (this.installationId !== null) return this.installationId;
    const res = await this.fetchFn(`${this.apiBase}/app/installations`, {
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      headers: { authorization: `Bearer ${this.appJwt()}`, accept: "application/vnd.github+json" },
    });
    if (!res.ok) throw new Error(`GET /app/installations failed: ${res.status}`);
    const installs = (await res.json()) as Array<{ id: number }>;
    const first = installs[0];
    if (!first) throw new Error("app has no installations");
    this.installationId = first.id;
    return first.id;
  }

  private fresh(tok: InstallationToken | undefined): tok is InstallationToken {
    return !!tok && Date.parse(tok.expires_at) - this.now() > REFRESH_MARGIN_MS;
  }

  /** Installation token, minting/refreshing as needed (single-flight). */
  async installationToken(installationId?: number): Promise<string> {
    const id = installationId ?? (await this.resolveInstallationId());
    const cached = this.cache.get(id);
    if (this.fresh(cached)) return cached.token;
    const inflight = this.inflight.get(id);
    if (inflight) return inflight;
    const p = this.mint(id).finally(() => this.inflight.delete(id));
    this.inflight.set(id, p);
    return p;
  }

  private async mint(id: number): Promise<string> {
    const res = await this.fetchFn(`${this.apiBase}/app/installations/${id}/access_tokens`, {
      method: "POST",
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      headers: { authorization: `Bearer ${this.appJwt()}`, accept: "application/vnd.github+json" },
    });
    if (!res.ok) throw new Error(`token mint failed for installation ${id}: ${res.status}`);
    const tok = (await res.json()) as InstallationToken;
    this.cache.set(id, tok);
    return tok.token;
  }

  /** Drop the cache after a 401 so the next call re-mints. */
  invalidate(installationId?: number): void {
    if (installationId === undefined) this.cache.clear();
    else this.cache.delete(installationId);
  }
}
