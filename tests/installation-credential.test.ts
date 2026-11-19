// `[github] auth = "installation"`: an App installation's identity on a token
// its host supplies, with no App key on the machine.
//
// The mode touches two questions that must never be confused, and this file
// holds them apart at the seams that answer them:
//
//   who posts?           an App's bot. Everything that is not person mode's
//                        holds as under `auth = "app"`: verdict events, own
//                        content by login, the label search, own threads.
//   where is the token?  one file. Everything that needs the App's key is
//                        off as under `auth = "user"`: no minter, no JWT, no
//                        App file read.
//
// No network and no real credential: fetch is a recorder, the secrets dir is
// a temp dir, and every long token is generated here (none is written out).
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { MutationGate, type MutationIntent } from "@quickchatai/pi-quickreview/src/gate.js";
import {
  TokenMinter,
  USER_TOKEN_FILE,
  UserTokenSource,
  githubCredential,
  type FetchFn,
  type GitHubCredential,
} from "@quickchatai/pi-quickreview/src/githubAuth.js";
import { classifyGitHubFailure } from "@quickchatai/pi-quickreview/src/githubcore.js";
import { makePostingGuard, type GuardAdapter } from "@quickchatai/pi-quickreview/src/guards.js";
import {
  TOKEN_EXPIRY_NOTE_FILE,
  githubTokenHealth,
  readTokenFile,
  tokenIdentityProblem,
  tokenOwnLogin,
} from "@quickchatai/pi-quickreview/src/hosttoken.js";
import {
  authMode,
  botAccountLogin,
  excludeOwnAppQualifier,
  isInstallationMode,
  isOwnContent,
  isPersonMode,
  ownActorAlias,
  ownLogins,
  usesTokenFile,
  type GithubIdentity,
} from "@quickchatai/pi-quickreview/src/identity.js";
import {
  GITHUB_AUTH_MODES,
  TOKEN_FILE_AUTH_MODES,
  appBotLogin,
} from "@quickchatai/pi-quickreview/src/reviewconfig.js";
import { GUARDS_DEFAULTS, parseConfig, type Config } from "../src/config.js";
import { GitHubAdapter } from "../src/github.js";
import { TOKEN_RE, writeTokenFile } from "../src/githubtoken.js";
import { botLoginFor } from "../src/onboard/choices.js";
import { StateStore } from "../src/state.js";
import {
  COMPANION_NO_TOKEN_UNDER_INSTALLATION,
  CompanionGithubToken,
  TOKEN_FILE,
  renderTokenEnv,
  tokenOutcomeLine,
  writeTokenEnv,
} from "../src/tui/ghread.js";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const FIXTURE = readFileSync(join(root, "tests/fixtures/config.toml"), "utf8");
const SLUG = "acme-reviewer";
const BOT = `${SLUG}[bot]`;
const REPO = "example-org/example-app";
const HEAD = "68b8040aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
const INSTANT = { sleep: async () => {}, random: () => 0.5, checkRestartMs: 0 };

/** The fixture as an install on each mode, as its config loader reads it. */
function configOn(mode: "app" | "user" | "installation", secretsDir = ""): Config {
  const identity =
    mode === "installation"
      ? `auth = "installation"\ntoken_source = "host"\napp_slug = "${SLUG}"\nbot_login = "${BOT}"`
      : mode === "user"
        ? 'auth = "user"\napp_slug = ""\nbot_login = "alice"'
        : `app_slug = "${SLUG}"\nbot_login = "${BOT}"`;
  const text = `${FIXTURE.replace(/^app_slug = .*\n/m, "")
    .replace(/^bot_login = .*\n/m, "")
    .replace("[github]\n", `[github]\n${identity}\n`)}\n[ingress]\nshape = "polling"\n`;
  const cfg = parseConfig(text);
  return secretsDir === "" ? cfg : { ...cfg, github: { ...cfg.github, secrets_dir: secretsDir } };
}

/**
 * A SYNTHETIC token of `length` characters in GitHub's token alphabet: `ghs_`
 * and base64url segments joined by dots, derived from a hash so that no
 * token-shaped literal is in this file.
 */
function longToken(length = 600): string {
  let body = "";
  for (let i = 0; body.length < length; i += 1)
    body += `${createHash("sha256").update(`segment:${i}`).digest("base64url")}.`;
  return `ghs_${body}`.slice(0, length - 1).replace(/[.]$/, "x") + "z";
}

interface Call {
  url: string;
  method: string;
  body: unknown;
  auth: string;
}

function recorder(handler: (url: string, init: RequestInit) => unknown = () => ({})) {
  const calls: Call[] = [];
  const fetchFn = (async (url: string | URL, init: RequestInit = {}) => {
    calls.push({
      url: String(url),
      method: init.method ?? "GET",
      body: typeof init.body === "string" ? JSON.parse(init.body) : undefined,
      auth: String((init.headers as Record<string, string> | undefined)?.authorization ?? ""),
    });
    const payload = handler(String(url), init);
    return {
      ok: true,
      status: 200,
      headers: new Headers(),
      json: async () => payload,
      text: async () => JSON.stringify(payload),
    } as unknown as Response;
  }) as unknown as FetchFn;
  return { fetchFn, calls };
}

let dir: string;
let secrets: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "qcr-installation-"));
  secrets = join(dir, "secrets");
  mkdirSync(secrets, { mode: 0o700 });
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

/** App files that cannot be read: each is a directory, so any read of one
 * throws. A mode that never reads them never notices. */
function plantUnreadableAppFiles(): void {
  for (const name of ["app_id", "app.pem", "webhook_secret"]) mkdirSync(join(secrets, name));
}

describe("the credential seam", () => {
  // MUTATION: drop `|| g.auth === "installation"` from githubCredential — the
  // App minter is built, and this fails.
  it("is the token file, never the App minter, and has no App JWT", () => {
    const credential = githubCredential({
      auth: "installation",
      token_source: "host",
      secrets_dir: secrets,
    });
    expect(credential).toBeInstanceOf(UserTokenSource);
    expect(credential).not.toBeInstanceOf(TokenMinter);
    expect(credential.appJwt).toBeUndefined();
  });

  it("hands over the file's token and reads no app_id, app.pem or webhook secret", async () => {
    plantUnreadableAppFiles();
    writeFileSync(join(secrets, USER_TOKEN_FILE), "ghs_installation\n", { mode: 0o600 });
    const { fetchFn, calls } = recorder();
    const credential = githubCredential(
      { auth: "installation", token_source: "host", secrets_dir: secrets },
      fetchFn,
    );
    expect(await credential.installationToken()).toBe("ghs_installation");
    credential.invalidate();
    expect(await credential.installationToken()).toBe("ghs_installation");
    // nothing is minted: the token is the host's to supply
    expect(calls).toEqual([]);
  });

  it("a missing file names the host, and no command on this machine", async () => {
    const credential = githubCredential({
      auth: "installation",
      token_source: "host",
      secrets_dir: secrets,
    });
    const err = await credential.installationToken().then(
      () => null,
      (e: unknown) => e as Error,
    );
    expect(err?.message).toMatch(/the host that manages this install writes the token/);
    expect(err?.message).not.toMatch(/qcr github-token sync|gh auth/);
  });

  it("the config loader's own answer builds that credential", () => {
    const cfg = configOn("installation", secrets);
    expect(githubCredential(cfg.github)).toBeInstanceOf(UserTokenSource);
    expect(githubCredential(configOn("app", secrets).github)).toBeInstanceOf(TokenMinter);
  });
});

describe("token length is not assumed", () => {
  const token = longToken(600);

  it("the sample is 600 characters of GitHub's token alphabet, dots and dashes included", () => {
    expect(token).toHaveLength(600);
    expect(token).toMatch(/^ghs_[A-Za-z0-9_.-]+$/);
    expect(token).toContain(".");
  });

  it("is read whole by the credential, the token-file reader and its health word", async () => {
    writeFileSync(join(secrets, USER_TOKEN_FILE), `${token}\n`, { mode: 0o600 });
    const g = {
      auth: "installation" as const,
      token_source: "host" as const,
      secrets_dir: secrets,
    };
    expect(await githubCredential(g).installationToken()).toBe(token);
    expect(readTokenFile(secrets)).toEqual({
      ok: true,
      token,
      path: join(secrets, USER_TOKEN_FILE),
    });
    expect(githubTokenHealth(g)).toBe("ok");
  });

  // MUTATION: put the old `{20,255}` bound or the `[A-Za-z0-9_]` alphabet back
  // on TOKEN_RE (src/githubtoken.ts) — this fails.
  it("is written whole by the token-file writer", () => {
    expect(TOKEN_RE.test(token)).toBe(true);
    const path = writeTokenFile(secrets, token);
    expect(readFileSync(path, "utf8").trim()).toBe(token);
    expect(() => writeTokenFile(secrets, `${token} second-word`)).toThrow(/not a token/);
  });

  // MUTATION: narrow the mask in sanitizeDetail (githubcore.ts) back to
  // `[A-Za-z0-9_]+` — it stops at the token's first dot, the rest of the
  // token stays in the detail, and this fails.
  it("is masked whole in a GitHub failure's detail", () => {
    const failure = classifyGitHubFailure(new Error(`fetch failed with ${token} in the URL`));
    expect(failure.detail).toContain("ghs_***");
    for (const piece of token
      .slice(4)
      .split(".")
      .filter((p) => p.length >= 8))
      expect(failure.detail).not.toContain(piece.slice(0, 8));
  });

  it("is carried whole into an env file: the check there is the alphabet, never a length", () => {
    const text = renderTokenEnv(
      { token, expires_at: "2026-11-19T15:04:05Z", permissions: {} },
      REPO,
      "user",
    );
    expect(text).toContain(`=${token}\n`);
  });
});

describe("the token file's health word", () => {
  const g = (auth: "app" | "user" | "installation") => ({ auth, secrets_dir: secrets });

  // MUTATION: make githubTokenHealth return null for every mode but "user" —
  // an installation's host could no longer see its token arrive, and this fails.
  it("is read under installation as under user, and is unknown under the App", () => {
    expect(githubTokenHealth(g("installation"))).toBe("missing");
    writeFileSync(join(secrets, USER_TOKEN_FILE), "ghs_installation\n");
    expect(githubTokenHealth(g("installation"))).toBe("ok");
    expect(githubTokenHealth(g("user"))).toBe("ok");
    expect(githubTokenHealth(g("app"))).toBeNull();
    writeFileSync(join(secrets, TOKEN_EXPIRY_NOTE_FILE), "2026-01-01T00:00:00Z\n");
    expect(
      githubTokenHealth(g("installation"), { now: () => Date.parse("2026-06-01T00:00:00Z") }),
    ).toBe("expired");
  });
});

describe("who posts: an App's bot, as under auth = app", () => {
  const identity = (auth: "app" | "installation" | "user"): GithubIdentity =>
    auth === "user"
      ? { auth, app_slug: "", bot_login: "alice" }
      : { auth, app_slug: SLUG, bot_login: BOT };
  const app = identity("app");
  const installation = identity("installation");

  it("is not person mode, and is a token-file mode", () => {
    expect(authMode(installation)).toBe("installation");
    expect(isInstallationMode(installation)).toBe(true);
    expect(isPersonMode(installation)).toBe(false);
    expect(usesTokenFile(installation)).toBe(true);
    // the two questions, across all three modes
    expect([app, identity("user"), installation].map(isPersonMode)).toEqual([false, true, false]);
    expect([app, identity("user"), installation].map(usesTokenFile)).toEqual([false, true, true]);
    expect(authMode({})).toBe("app");
  });

  // identity.ts imports types only, so it spells the token-file modes out
  // beside the config's own list.
  // MUTATION: add a mode to TOKEN_FILE_AUTH_MODES (reviewconfig.ts) and not
  // to usesTokenFile, or the other way round — this fails.
  it("answers `usesTokenFile` for exactly the config's token-file modes", () => {
    for (const auth of GITHUB_AUTH_MODES)
      expect(usesTokenFile({ auth }), auth).toBe(TOKEN_FILE_AUTH_MODES.includes(auth));
  });

  // MUTATION: make isPersonMode true for "installation" (the token comes from
  // a file, after all) — every answer below turns into person mode's, and
  // this fails.
  it("answers every identity question exactly as the App does", () => {
    expect(ownLogins(installation)).toEqual(ownLogins(app));
    expect(ownLogins(installation)).toEqual([BOT]);
    expect(ownActorAlias(installation)).toBe(SLUG);
    expect(botAccountLogin(installation)).toBe(BOT);
    expect(excludeOwnAppQualifier(installation)).toBe(` -author:app/${SLUG}`);
    // own content is the bot's by its login, with or without a marker
    expect(isOwnContent(installation, BOT, "a review with no marker at all")).toBe(true);
    expect(isOwnContent(installation, SLUG, "the bare actor GraphQL names")).toBe(true);
    expect(isOwnContent(installation, "alice", "<!-- qcr:f=1:k -->")).toBe(false);
  });

  it("the login is one rule in the core and in the wizard", () => {
    expect(appBotLogin(SLUG)).toBe(BOT);
    expect(botLoginFor(SLUG)).toBe(appBotLogin(SLUG));
  });
});

describe("GitHubAdapter under auth = installation", () => {
  let dryrunDir: string;
  beforeEach(() => {
    dryrunDir = join(dir, "dryrun");
  });

  function build(
    credential: GitHubCredential,
    handler: (url: string, init: RequestInit) => unknown = () => ({}),
    o: { dryRun?: boolean; mode?: "installation" | "user" } = {},
  ) {
    const rec = recorder(handler);
    let adapter!: GitHubAdapter;
    const gate = new MutationGate(o.dryRun ?? false, dryrunDir, (intent) =>
      adapter.executeMutation(intent),
    );
    adapter = new GitHubAdapter(
      configOn(o.mode ?? "installation", secrets),
      credential,
      gate,
      rec.fetchFn,
      "https://api.github.com",
      INSTANT,
    );
    return { adapter, gate, calls: rec.calls };
  }

  const fileToken: GitHubCredential = {
    installationToken: async () => "ghs_installation",
    invalidate: () => {},
  };
  const queryOf = (url: string): string => new URL(url).searchParams.get("q") ?? "";
  const review = (event: string): MutationIntent => ({
    kind: "create_review",
    method: "POST",
    path: `/repos/${REPO}/pulls/3/reviews`,
    body: { commit_id: HEAD, event, body: "x", comments: [] },
    note: `post ${event} review on #3`,
    pr: 3,
  });

  // MUTATION: drop the `isInstallationMode` refusal from GitHubAdapter.appJwt —
  // a credential object that offers a JWT gets its App route sent, and this fails.
  it("refuses every App-JWT route unsent, even when handed a credential that could sign", async () => {
    const couldSign: GitHubCredential = { ...fileToken, appJwt: () => "jwt.should.never.be.sent" };
    for (const credential of [fileToken, couldSign]) {
      const { adapter, calls } = build(credential);
      await expect(adapter.listWebhookDeliveries()).rejects.toThrow(
        /auth = "installation" the App's key is with the host/,
      );
      await expect(adapter.getAppWebhookConfig()).rejects.toThrow(/auth = "installation"/);
      // the app-self-config kind executes even in dry-run; it must still not reach GitHub
      await expect(adapter.updateOwnWebhookUrl("https://x", "https://y")).rejects.toThrow(
        /auth = "installation"/,
      );
      expect(calls).toEqual([]);
    }
  });

  it("the label search and the team search exclude the App's own pull requests by its slug", async () => {
    const { adapter, calls } = build(fileToken, () => ({ items: [], incomplete_results: false }));
    await adapter.searchLabelTriggered();
    await adapter.searchTeamTriggered();
    expect(calls).toHaveLength(2);
    for (const c of calls) {
      expect(queryOf(c.url)).toContain(`-author:app/${SLUG}`);
      expect(c.auth).toBe("Bearer ghs_installation");
    }
    expect(queryOf(calls[0]!.url)).toContain('label:"');
  });

  it("resolves its own thread by the bare App actor, with no marker in the body", async () => {
    const thread = (login: string) => ({
      data: {
        repository: {
          pullRequest: {
            reviewThreads: {
              nodes: [
                {
                  id: "PRRT_node",
                  isResolved: false,
                  comments: {
                    nodes: [{ databaseId: 555, author: { login }, body: "[blocker] no marker" }],
                  },
                },
              ],
              pageInfo: { hasNextPage: false, endCursor: null },
            },
          },
        },
      },
    });
    for (const login of [SLUG, BOT]) {
      const own = build(fileToken, () => thread(login), { dryRun: true });
      expect((await own.adapter.resolveOwnReviewThread(3, 555)).skipped).toBeNull();
    }
    const other = build(fileToken, () => thread("alice"), { dryRun: true });
    await expect(other.adapter.resolveOwnReviewThread(3, 555)).rejects.toThrow(
      /root author is alice/,
    );
  });

  // MUTATION: widen the executor's brace from `isPersonMode` to `usesTokenFile`
  // (src/github.ts executeMutation) — the installation's APPROVE is refused,
  // and this fails.
  it("the executor sends APPROVE and REQUEST_CHANGES as they are", async () => {
    const { gate, calls } = build(fileToken, () => ({ id: 1, comments: [] }));
    for (const event of ["APPROVE", "REQUEST_CHANGES", "COMMENT"])
      await gate.execute(review(event));
    expect(calls.map((c) => (c.body as { event: string }).event)).toEqual([
      "APPROVE",
      "REQUEST_CHANGES",
      "COMMENT",
    ]);
    // the same file-read token on the person's own account is still refused a verdict event
    const person = build(fileToken, () => ({ id: 1 }), { mode: "user" });
    await expect(person.gate.execute(review("APPROVE"))).rejects.toThrow(
      /posts every review as a COMMENT/,
    );
    expect(person.calls).toEqual([]);
  });

  it("posts with the token file's token as the bearer, whatever its length", async () => {
    const token = longToken(600);
    writeFileSync(join(secrets, USER_TOKEN_FILE), `${token}\n`, { mode: 0o600 });
    const cfg = configOn("installation", secrets);
    const { gate, calls } = build(githubCredential(cfg.github), () => ({ id: 1, comments: [] }));
    await gate.execute(review("APPROVE"));
    expect(calls.map((c) => c.auth)).toEqual([`Bearer ${token}`]);
  });
});

// The acceptance at the gate: the config loader's answer decides the guard's
// last step, and the real gate carries the result to the executor.
describe("through the real gate: the COMMENT-only rule is the person identity's", () => {
  // one store per gate: a review posted at a head is that head's mark, and
  // the next case must not meet it
  const stores: StateStore[] = [];
  afterEach(() => {
    for (const store of stores.splice(0)) store.close();
  });

  const reads: GuardAdapter = {
    getPr: async () => ({ state: "open", merged: false, head_sha: HEAD, author: "pr-author" }),
    listReviews: async () => [],
  };

  /** A live gate with the posting guard installed as the daemon installs it:
   * `personMode` is `isPersonMode` of the loaded config, and nothing else. */
  function liveGate(cfg: Config) {
    const store = new StateStore(":memory:");
    stores.push(store);
    const executor = vi.fn(async () => ({ id: 900, comments: [] }));
    const gate = new MutationGate(
      false,
      join(dir, "dryrun"),
      executor as unknown as (i: MutationIntent) => Promise<unknown>,
    );
    gate.setGuard(
      makePostingGuard({
        store,
        adapter: reads,
        botLogin: cfg.github.bot_login,
        guards: { ...GUARDS_DEFAULTS },
        personMode: isPersonMode(cfg.github),
      }),
    );
    const sent = (): { event: string; body: string } =>
      (executor.mock.calls.at(-1) as unknown as [MutationIntent])[0].body as {
        event: string;
        body: string;
      };
    return { gate, executor, sent };
  }

  const review = (event: "APPROVE" | "REQUEST_CHANGES"): MutationIntent => ({
    kind: "create_review",
    method: "POST",
    path: `/repos/${REPO}/pulls/5180/reviews`,
    body: { commit_id: HEAD, event, body: "The review body.", comments: [] },
    note: `post ${event} review on #5180`,
    pr: 5180,
  });

  // MUTATION: pass `personMode: usesTokenFile(cfg.github)` where the daemon
  // builds its guard (the rule bound to "the token came from a file") — the
  // installation's verdicts post as COMMENTs, and this fails.
  it("an installation-mode APPROVE and REQUEST_CHANGES are admitted as such", async () => {
    for (const event of ["APPROVE", "REQUEST_CHANGES"] as const) {
      const { gate, executor, sent } = liveGate(configOn("installation"));
      const result = await gate.execute(review(event));
      expect(result.blocked ?? null).toBeNull();
      expect(executor).toHaveBeenCalledTimes(1);
      expect(sent().event).toBe(event);
      expect(sent().body).toBe("The review body.");
    }
  });

  it("a person-mode APPROVE is still forced to a COMMENT that states the verdict", async () => {
    const { gate, executor, sent } = liveGate(configOn("user"));
    await gate.execute(review("APPROVE"));
    expect(executor).toHaveBeenCalledTimes(1);
    expect(sent().event).toBe("COMMENT");
    expect(sent().body).toContain("Verdict: APPROVE");
  });

  it("the App route is unchanged: an APPROVE is an APPROVE", async () => {
    const { gate, sent } = liveGate(configOn("app"));
    await gate.execute(review("APPROVE"));
    expect(sent().event).toBe("APPROVE");
  });
});

describe("who a token is: GraphQL's viewer, never the user endpoint", () => {
  const answering = (payload: unknown, status = 200) => {
    const calls: Call[] = [];
    const fetchFn = (async (url: string | URL, init: RequestInit = {}) => {
      calls.push({
        url: String(url),
        method: init.method ?? "GET",
        body: typeof init.body === "string" ? JSON.parse(init.body) : undefined,
        auth: String((init.headers as Record<string, string>).authorization),
      });
      return {
        ok: status === 200,
        status,
        text: async () => JSON.stringify(payload),
      } as unknown as Response;
    }) as unknown as typeof fetch;
    return { fetchFn, calls };
  };

  // MUTATION: ask `GET /user` in tokenOwnLogin instead — this fails (and on
  // GitHub an installation token is refused there).
  it("asks one GraphQL question with the token as the bearer", async () => {
    const { fetchFn, calls } = answering({ data: { viewer: { login: BOT } } });
    expect(await tokenOwnLogin(fetchFn, "ghs_installation", "https://api.example.test")).toEqual({
      ok: true,
      login: BOT,
    });
    expect(calls).toHaveLength(1);
    expect(calls[0]).toMatchObject({
      url: "https://api.example.test/graphql",
      method: "POST",
      auth: "Bearer ghs_installation",
    });
    expect((calls[0]!.body as { query: string }).query).toMatch(/viewer\s*\{\s*login\s*\}/);
    expect(calls.some((c) => /\/user\b/.test(c.url))).toBe(false);
  });

  it("an answer that names no login, a refusal and an unreachable GitHub are each said, never guessed", async () => {
    const none = await tokenOwnLogin(
      answering({ data: { viewer: null }, errors: [{ message: "Resource not accessible" }] })
        .fetchFn,
      "ghs_installation",
    );
    expect(none).toMatchObject({ ok: false, status: 200 });
    expect((none as { detail: string }).detail).toMatch(/did not say who the token is/);

    const refused = await tokenOwnLogin(
      answering({ message: "Bad credentials" }, 401).fetchFn,
      "ghs_installation",
    );
    expect(refused).toMatchObject({ ok: false, status: 401 });

    const down = await tokenOwnLogin(
      (async () => {
        throw new Error("getaddrinfo ENOTFOUND ghs_installation");
      }) as unknown as typeof fetch,
      "ghs_installation",
    );
    expect(down).toMatchObject({ ok: false, status: 0 });
    for (const r of [none, refused, down])
      expect(JSON.stringify(r)).not.toContain("ghs_installation");
  });

  it("a login that is not the configured one is a problem said in words; case is not", () => {
    expect(tokenIdentityProblem(BOT, BOT)).toBeNull();
    expect(tokenIdentityProblem(BOT, "Acme-Reviewer[bot]")).toBeNull();
    const problem = tokenIdentityProblem(BOT, "other-app[bot]");
    expect(problem).toContain("other-app[bot]");
    expect(problem).toContain(BOT);
    expect(problem).toMatch(/would not recognise its own reviews/);
  });
});

describe("the companion under auth = installation", () => {
  // MUTATION: drop the `auth === "installation"` branch from
  // CompanionGithubToken.doRefresh — the App files are looked for (and the
  // outcome names a missing App credential), and this fails.
  it("gets no GitHub token: nothing is read, nothing is asked, nothing is handed over", async () => {
    plantUnreadableAppFiles();
    writeFileSync(join(secrets, USER_TOKEN_FILE), "ghs_installation\n", { mode: 0o600 });
    const handover = join(dir, "handover");
    const { fetchFn, calls } = recorder();
    const outcome = await new CompanionGithubToken({
      dir: handover,
      repo: REPO,
      secretsDir: secrets,
      auth: "installation",
      fetchFn,
    }).refresh();
    expect(outcome).toEqual({
      kind: "unavailable",
      reason: COMPANION_NO_TOKEN_UNDER_INSTALLATION,
    });
    expect(calls).toEqual([]);
    expect(existsSync(join(handover, TOKEN_FILE))).toBe(false);
    expect(tokenOutcomeLine(outcome)).toMatch(/no read-only GitHub token/);
    expect(tokenOutcomeLine(outcome)).not.toContain("ghs_installation");
  });

  it("an env file an earlier mode left in the hand-over dir is removed", async () => {
    const handover = join(dir, "handover");
    const left = writeTokenEnv(handover, "QCR_GITHUB_READ_TOKEN=ghs_earlier\n");
    expect(existsSync(left)).toBe(true);
    const outcome = await new CompanionGithubToken({
      dir: handover,
      repo: REPO,
      secretsDir: secrets,
      auth: "installation",
    }).refresh();
    expect(outcome.kind).toBe("unavailable");
    expect(existsSync(left)).toBe(false);
  });

  it("the person's own account still gets its copy: the rule is the mode's, not the file's", async () => {
    writeFileSync(join(secrets, USER_TOKEN_FILE), "ghu_person\n", { mode: 0o600 });
    const handover = join(dir, "handover");
    const outcome = await new CompanionGithubToken({
      dir: handover,
      repo: REPO,
      secretsDir: secrets,
      auth: "user",
    }).refresh();
    expect(outcome.kind).toBe("copied");
    expect(readFileSync(join(handover, TOKEN_FILE), "utf8")).toContain("ghu_person");
  });
});
