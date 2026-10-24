// The daemon's GitHub credential, behind one seam (`GitHubCredential`), in
// one of two shapes chosen by `[github] auth`:
//
//  * "app" (the default) — `TokenMinter`: RS256 app JWTs and cached
//    installation tokens. The JWT is backdated 60 s against clock skew and
//    lives 600 s from that iat (9 min from now); scripts/mint-token.sh signs
//    its own with a 540 s life (8 min from now). Both stay under GitHub's
//    10-minute ceiling. Tokens are cached per installation off `expires_at`
//    with a ~5 min proactive refresh window, refreshed single-flight,
//    re-minted once on a 401 (by the caller's `invalidate`). Every request
//    carries the adapter's 60 s deadline.
//  * "user" — `UserTokenSource`: the person's own token, read from the ONE
//    file `<secrets dir>/github_token` (0600, the token alone) that the
//    host-side refresher keeps fresh. It is re-read on first use, every five
//    minutes, and after a 401. This mode is polling-only, it has no App JWT
//    (so every JWT-authed App route is refused), every mutation still goes
//    through the one gate, and the token reaches the daemon as that file,
//    never through the environment or a command line (SECURITY.md, hard
//    rule 3 as amended). Nothing here reads the environment.
import { createSign } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";

export type FetchFn = typeof fetch;

/** GraphQL's bare App actor, only for a matching configured bot login. */
export function appActorAlias(botLogin: string, appSlug: string): string | undefined {
  if (!appSlug) return undefined;
  return botLogin === `${appSlug}[bot]` ? appSlug : undefined;
}

/**
 * What the GitHub adapter authenticates with. `installationToken` is the
 * bearer for every repo read and gated write (the App's installation token,
 * or the person's own token); `invalidate` drops it after a 401 so the next
 * call fetches a fresh one. `appJwt` exists only on the App credential: a
 * route that needs it (the App's own hook configuration and deliveries) is
 * refused where it is absent.
 */
export interface GitHubCredential {
  installationToken(): Promise<string>;
  invalidate(): void;
  appJwt?(): string | Promise<string>;
}

/** The person's token file under the secrets dir (`auth = "user"`). */
export const USER_TOKEN_FILE = "github_token";
/** How long a read of the token file is trusted before it is read again. */
export const USER_TOKEN_REREAD_MS = 5 * 60 * 1000;

/** The person's own GitHub token, as the host-side refresher last wrote it. */
export class UserTokenSource implements GitHubCredential {
  private token: string | null = null;
  private readAt = 0;

  constructor(
    private readonly secretsDir: string,
    private readonly now: () => number = Date.now,
  ) {}

  /** The token file's path — named in every error, never its contents. */
  get path(): string {
    return join(this.secretsDir, USER_TOKEN_FILE);
  }

  async installationToken(): Promise<string> {
    if (this.token === null || this.now() - this.readAt >= USER_TOKEN_REREAD_MS) this.reload();
    return this.token!;
  }

  /** After a 401: the next call reads the file again (the refresher may have
   * written a new token since). */
  invalidate(): void {
    this.token = null;
  }

  private reload(): void {
    let text: string;
    try {
      text = readFileSync(this.path, "utf8");
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code ?? "unreadable";
      throw new Error(
        `no GitHub user token at ${this.path} (${code}) — [github] auth = "user" reads the person's ` +
          "token from this file; run `qcr github-token sync` on the host to write it",
        { cause: err },
      );
    }
    const token = text.trim();
    if (token === "")
      throw new Error(
        `the GitHub user token file ${this.path} is empty — run \`qcr github-token sync\``,
      );
    if (/\s/.test(token))
      throw new Error(
        `the GitHub user token file ${this.path} holds more than one token-shaped word`,
      );
    this.token = token;
    this.readAt = this.now();
  }
}

/** The credential `[github] auth` names: the App minter by default, the
 * person's token file under "user". */
export function githubCredential(
  g: { auth?: "app" | "user"; secrets_dir: string },
  fetchFn: FetchFn = fetch,
): GitHubCredential {
  return g.auth === "user"
    ? new UserTokenSource(g.secrets_dir)
    : new TokenMinter(g.secrets_dir, fetchFn);
}

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
export const GITHUB_REQUEST_TIMEOUT_MS = 60_000;

/** GitHub's own words for a failed call (its `message`), capped, as ": <text>";
 * empty when the body cannot be read. A 403's permission or rate-limit
 * explanation is what tells operators two failures of one status apart. */
async function explanation(res: Response): Promise<string> {
  try {
    const text = (await res.text()).replace(/\s+/g, " ").trim().slice(0, 300);
    return text ? `: ${text}` : "";
  } catch {
    return "";
  }
}

export class TokenMinter implements GitHubCredential {
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
      signal: AbortSignal.timeout(GITHUB_REQUEST_TIMEOUT_MS),
      headers: { authorization: `Bearer ${this.appJwt()}`, accept: "application/vnd.github+json" },
    });
    if (!res.ok)
      throw new Error(`GET /app/installations failed: ${res.status}${await explanation(res)}`);
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
      signal: AbortSignal.timeout(GITHUB_REQUEST_TIMEOUT_MS),
      headers: { authorization: `Bearer ${this.appJwt()}`, accept: "application/vnd.github+json" },
    });
    if (!res.ok)
      throw new Error(
        `token mint failed for installation ${id}: ${res.status}${await explanation(res)}`,
      );
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
