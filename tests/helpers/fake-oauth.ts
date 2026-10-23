// A fake OAuth token endpoint for the login refresher's tests: the
// refresh-token grant of a provider that ROTATES the refresh token, as the real
// one does. A stale refresh token is refused (invalid_grant), so a second
// refresher racing the first shows up as a failed refresh, not a silent pass.
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import type { OAuthEntry, RefreshFn } from "../../src/loginrefresh/refresher.js";

export interface FakeOAuth {
  url: string;
  /** The refresh token the server will accept next. */
  current(): string;
  /** How many grants it has issued. */
  grants(): number;
  /** Make every request fail with this status (null: serve normally). */
  failWith(status: number | null): void;
  close(): Promise<void>;
  /** A RefreshFn that talks to this server over HTTP. */
  refresh(now: () => number): RefreshFn;
}

export async function fakeOAuth(
  firstRefresh = "refresh-1",
  lifetimeS = 36_000,
): Promise<FakeOAuth> {
  let current = firstRefresh;
  let n = 0;
  let fail: number | null = null;
  const server: Server = createServer((req, res) => {
    let body = "";
    req.on("data", (c: unknown) => (body += String(c)));
    req.on("end", () => {
      const form = new URLSearchParams(body);
      if (fail !== null) {
        res.writeHead(fail, { "content-type": "application/json" });
        res.end(JSON.stringify({ error: "server_error" }));
        return;
      }
      if (form.get("grant_type") !== "refresh_token" || form.get("refresh_token") !== current) {
        res.writeHead(400, { "content-type": "application/json" });
        res.end(JSON.stringify({ error: "invalid_grant" }));
        return;
      }
      n += 1;
      current = `refresh-${n + 1}`;
      res.writeHead(200, { "content-type": "application/json" });
      res.end(
        JSON.stringify({
          access_token: `access-${n + 1}`,
          refresh_token: current,
          expires_in: lifetimeS,
        }),
      );
    });
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}/token`;
  return {
    url,
    current: () => current,
    grants: () => n,
    failWith: (s) => {
      fail = s;
    },
    close: () => new Promise<void>((r) => server.close(() => r())),
    refresh: (now) => async (_provider: string, cred: OAuthEntry, signal: AbortSignal) => {
      const res = await fetch(url, {
        method: "POST",
        headers: { "content-type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({ grant_type: "refresh_token", refresh_token: cred.refresh }),
        signal,
      });
      if (!res.ok) throw new Error(`token refresh failed (${res.status})`);
      const j = (await res.json()) as {
        access_token: string;
        refresh_token: string;
        expires_in: number;
      };
      return {
        access: j.access_token,
        refresh: j.refresh_token,
        expires: now() + j.expires_in * 1000,
      };
    },
  };
}
