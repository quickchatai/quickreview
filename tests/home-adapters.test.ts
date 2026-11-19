// The home's real ports (src/home/adapters.ts) over fake files and a fake
// `gh`: what each answers, and that a source that cannot be read answers
// unknown rather than an empty value (invariant 9).
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import {
  githubPort,
  homeOptionsFromEnv,
  homeStackRoot,
  hostAwareGithubPort,
  realHomeAdapters,
  seedStack,
  parsePulls,
  piLoginPort,
  repoPort,
  tokenFileGithubPort,
  unbuiltPorts,
  type RunResult,
  type Runner,
} from "../src/home/adapters.js";
import { stateHome } from "../src/homes.js";
import { replacedLogin } from "../src/home/loginowner.js";
import { idleReviews } from "./helpers/fake-reviews.js";

const files =
  (map: Record<string, string | Error>) =>
  (p: string): string => {
    const v = map[p];
    if (v === undefined) throw Object.assign(new Error(`ENOENT: ${p}`), { code: "ENOENT" });
    if (v instanceof Error) throw v;
    return v;
  };

function fakeGh(
  answer: (args: readonly string[]) => Partial<RunResult>,
): Runner & { calls: string[][] } {
  const calls: string[][] = [];
  return {
    calls,
    run: async (cmd, args) => {
      calls.push([cmd, ...args]);
      return { code: 0, stdout: "", stderr: "", ...answer(args) };
    },
  };
}

describe("the pi login port", () => {
  const AGENT = "/home/person/.pi/agent";
  const AUTH = join(AGENT, "auth.json");

  it("lists the providers of the agent dir's auth file, never a token", async () => {
    const port = piLoginPort(
      AGENT,
      files({
        [AUTH]: JSON.stringify({
          "openai-codex": { type: "oauth", access: "SECRET", expires: 1 },
          anthropic: { type: "api_key", key: "K" },
        }),
      }),
    );
    const r = await port.providers();
    expect(r).toEqual({ kind: "known", value: ["openai-codex", "anthropic"] });
    expect(JSON.stringify(r)).not.toMatch(/SECRET|"K"/);
  });

  // MUTATION: build the stamp from the type and the expiry alone in
  // piLoginPort - an API key replaced by another reads the same, so a re-login
  // that pasted a new key ends as "no stored login changed"; this fails.
  it("a replaced API key stamps differently, and the stamp holds no key", async () => {
    const stampsOf = async (key: string): Promise<ReadonlyMap<string, string>> => {
      const r = await piLoginPort(
        AGENT,
        files({ [AUTH]: JSON.stringify({ north: { type: "api_key", key } }) }),
      ).stamps!();
      if (r.kind !== "known") throw new Error("unknown stamps");
      return r.value;
    };
    const before = { kind: "known" as const, value: await stampsOf("FIRST-KEY-VALUE") };
    const same = { kind: "known" as const, value: await stampsOf("FIRST-KEY-VALUE") };
    const after = { kind: "known" as const, value: await stampsOf("OTHER-KEY-VALUE") };
    expect(replacedLogin(before, same)).toBeNull();
    expect(replacedLogin(before, after)).toBe("north");
    expect(after.value.get("north")).toMatch(/^api_key::[0-9a-f]{8}$/);
    expect(JSON.stringify([...after.value])).not.toMatch(/KEY-VALUE/);
  });

  it("no auth file is no login", async () => {
    expect(await piLoginPort(AGENT, files({})).providers()).toEqual({ kind: "known", value: [] });
  });

  // MUTATION: answer known([]) when the file can't be read — this fails.
  it("an auth file that can't be read or parsed is unknown", async () => {
    const denied = Object.assign(new Error("EACCES: permission denied"), { code: "EACCES" });
    expect((await piLoginPort(AGENT, files({ [AUTH]: denied })).providers()).kind).toBe("unknown");
    const garbled = await piLoginPort(AGENT, files({ [AUTH]: "{not json" })).providers();
    expect(garbled.kind).toBe("unknown");
  });
});

describe("the GitHub port", () => {
  it("reads gh's account", async () => {
    const gh = fakeGh(() => ({ stdout: "octo\n" }));
    expect(await githubPort(gh).user()).toEqual({ kind: "known", value: "octo" });
    expect(gh.calls).toEqual([["gh", "api", "user", "--jq", ".login"]]);
  });

  it("a signed-out gh is no account; a missing or failing gh is unknown", async () => {
    const out = fakeGh(() => ({
      code: 1,
      stderr: "To get started with GitHub CLI, please run:  gh auth login",
    }));
    expect(await githubPort(out).user()).toEqual({ kind: "known", value: null });
    const missing = fakeGh(() => ({ code: 1, missing: true }));
    expect(await githubPort(missing).user()).toEqual({
      kind: "unknown",
      why: "gh is not installed",
    });
    const broken = fakeGh(() => ({ code: 1, stderr: "error connecting to api.github.com\n…" }));
    expect(await githubPort(broken).user()).toEqual({
      kind: "unknown",
      why: "gh failed: error connecting to api.github.com",
    });
  });

  it("lists the open pull requests only", async () => {
    const gh = fakeGh(() => ({
      stdout: JSON.stringify([
        {
          number: 7,
          title: "Fix it",
          author: { login: "dev" },
          updatedAt: "2026-10-26T10:00:00Z",
          isDraft: true,
          additions: 3,
          deletions: 1,
          changedFiles: 2,
          headRefName: "fix",
          headRefOid: "abc123",
        },
      ]),
    }));
    expect(await githubPort(gh).openPulls("acme/widgets")).toEqual({
      kind: "known",
      value: [
        {
          number: 7,
          title: "Fix it",
          author: "dev",
          updatedAt: "2026-10-26T10:00:00Z",
          isDraft: true,
          additions: 3,
          deletions: 1,
          changedFiles: 2,
          headRefName: "fix",
          headSha: "abc123",
        },
      ],
    });
    const args = gh.calls[0]!;
    // the head commit comes along: a price is cached by it
    expect(args[args.indexOf("--json") + 1]).toMatch(/,headRefOid$/);
    expect(args.slice(0, 5)).toEqual(["gh", "pr", "list", "-R", "acme/widgets"]);
    expect(args[args.indexOf("--state") + 1]).toBe("open");
  });

  it("a PR list gh can't give is unknown, never empty", async () => {
    const r = await githubPort(fakeGh(() => ({ code: 1, stderr: "HTTP 502" }))).openPulls("a/b");
    expect(r).toEqual({ kind: "unknown", why: "gh failed: HTTP 502" });
    const junk = await githubPort(fakeGh(() => ({ stdout: "{}" }))).openPulls("a/b");
    expect(junk.kind).toBe("unknown");
  });

  it("opens a PR in the browser through gh", async () => {
    const gh = fakeGh(() => ({}));
    expect(await githubPort(gh).openInBrowser("acme/widgets", 7)).toEqual({ ok: true });
    expect(gh.calls).toEqual([["gh", "pr", "view", "7", "-R", "acme/widgets", "--web"]]);
    const no = fakeGh(() => ({ code: 1, stderr: "no browser" }));
    expect(await githubPort(no).openInBrowser("a/b", 1)).toEqual({
      ok: false,
      why: "gh failed: no browser",
    });
  });

  it("parses gh's rows, a deleted author as ghost", () => {
    expect(parsePulls(JSON.stringify([{ number: 1, title: "t", author: null }]))[0]).toMatchObject({
      number: 1,
      author: "ghost",
      isDraft: false,
    });
    expect(() => parsePulls(JSON.stringify([{ title: "no number" }]))).toThrow();
  });
});

// A host-managed install (`[github] token_source = "host"`): no gh. The same
// three reads go to GitHub with the token file the host keeps.
describe("the GitHub port on a host-managed install: the host's token file", () => {
  const tmp = mkdtempSync(join(tmpdir(), "home-hosted-"));
  afterAll(() => rmSync(tmp, { recursive: true, force: true }));
  const HOSTS = "ghu_hostWrittenTokenValue0123456789ab";
  const secrets = (token: string | null): string => {
    const d = mkdtempSync(join(tmp, "secrets-"));
    if (token !== null) writeFileSync(join(d, "github_token"), `${token}\n`, { mode: 0o600 });
    return d;
  };
  const node = (n: number) => ({
    number: n,
    title: `Change ${n}`,
    author: { login: "dev" },
    updatedAt: "2026-11-19T10:00:00Z",
    isDraft: n % 2 === 0,
    additions: 3,
    deletions: 1,
    changedFiles: 2,
    headRefName: `b${n}`,
    headRefOid: `sha${n}`,
  });
  interface Call {
    method: string;
    path: string;
    auth: string | null;
    body: { query?: string; variables?: Record<string, unknown> } | null;
  }
  /** GitHub by shape: `/user`, and `/graphql` answering one page per call. */
  const github = (
    o: { status?: number; login?: string; pages?: unknown[][]; graphql?: unknown } = {},
  ): { fetch: typeof fetch; calls: Call[] } => {
    const calls: Call[] = [];
    const pages = o.pages ?? [[node(7)]];
    const fetchFn = (async (input: unknown, init?: RequestInit) => {
      const url = new URL(String(input));
      const body = typeof init?.body === "string" ? (JSON.parse(init.body) as Call["body"]) : null;
      calls.push({
        method: (init?.method ?? "GET").toUpperCase(),
        path: url.pathname,
        auth: new Headers(init?.headers).get("authorization"),
        body,
      });
      const json = (status: number, value: unknown): Response =>
        new Response(JSON.stringify(value), { status });
      if ((o.status ?? 200) !== 200) return json(o.status!, { message: "Bad credentials" });
      if (url.pathname === "/user") return json(200, { login: o.login ?? "dana-op" });
      if (url.pathname === "/graphql") {
        if (o.graphql !== undefined) return json(200, o.graphql);
        const at = calls.filter((c) => c.path === "/graphql").length - 1;
        return json(200, {
          data: {
            repository: {
              pullRequests: {
                nodes: pages[at] ?? [],
                pageInfo: { hasNextPage: at < pages.length - 1, endCursor: `cursor${at}` },
              },
            },
          },
        });
      }
      return json(500, { message: `unrouted ${url.pathname}` });
    }) as unknown as typeof fetch;
    return { fetch: fetchFn, calls };
  };

  it("names the account of the token the host wrote, with that token", async () => {
    const gh = github();
    const port = tokenFileGithubPort({ secretsDir: () => secrets(HOSTS), fetch: gh.fetch });
    expect(await port.user()).toEqual({ kind: "known", value: "dana-op" });
    expect(gh.calls).toEqual([
      { method: "GET", path: "/user", auth: `Bearer ${HOSTS}`, body: null },
    ]);
  });

  it("no token yet is no account, and GitHub is not asked", async () => {
    const gh = github();
    const port = tokenFileGithubPort({ secretsDir: () => secrets(null), fetch: gh.fetch });
    expect(await port.user()).toEqual({ kind: "known", value: null });
    expect(gh.calls).toEqual([]);
  });

  it("a token GitHub refuses, or a file that is not one token, is unknown: never signed out, never a sign-in", async () => {
    const refused = await tokenFileGithubPort({
      secretsDir: () => secrets(HOSTS),
      fetch: github({ status: 401 }).fetch,
    }).user();
    expect(refused.kind).toBe("unknown");
    const twoWords = await tokenFileGithubPort({
      secretsDir: () => secrets("ghu_one ghu_two"),
      fetch: github().fetch,
    }).user();
    expect(twoWords.kind).toBe("unknown");
    const down = await tokenFileGithubPort({
      secretsDir: () => secrets(HOSTS),
      fetch: (async () => {
        throw new Error("getaddrinfo ENOTFOUND api.github.com");
      }) as unknown as typeof fetch,
    }).user();
    expect(down.kind).toBe("unknown");
    for (const r of [refused, twoWords, down]) {
      const why = r.kind === "unknown" ? r.why : "";
      expect(why).not.toMatch(/gh auth login|ghu_/);
    }
    expect(refused.kind === "unknown" && refused.why).toMatch(/your host/);
  });

  it("lists the open pull requests with the token file, sizes and head commit included", async () => {
    const gh = github();
    const port = tokenFileGithubPort({ secretsDir: () => secrets(HOSTS), fetch: gh.fetch });
    expect(await port.openPulls("acme/widgets")).toEqual({
      kind: "known",
      value: [
        {
          number: 7,
          title: "Change 7",
          author: "dev",
          updatedAt: "2026-11-19T10:00:00Z",
          isDraft: false,
          additions: 3,
          deletions: 1,
          changedFiles: 2,
          headRefName: "b7",
          headSha: "sha7",
        },
      ],
    });
    expect(gh.calls).toHaveLength(1);
    const call = gh.calls[0]!;
    expect([call.method, call.path, call.auth]).toEqual(["POST", "/graphql", `Bearer ${HOSTS}`]);
    expect(call.body?.variables).toEqual({ owner: "acme", name: "widgets", after: null });
    expect(call.body?.query).toMatch(/states: OPEN/);
  });

  it("reads a second page when GitHub says there is one, and stops there", async () => {
    const page = (from: number) => Array.from({ length: 100 }, (_, i) => node(from + i));
    const gh = github({ pages: [page(1), page(101), page(201)] });
    const port = tokenFileGithubPort({ secretsDir: () => secrets(HOSTS), fetch: gh.fetch });
    const r = await port.openPulls("acme/widgets");
    expect(r.kind === "known" && r.value.length).toBe(200);
    expect(gh.calls.map((c) => c.body?.variables?.["after"])).toEqual([null, "cursor0"]);
  });

  it("a list it cannot read is unknown, never empty", async () => {
    const pulls = (o: Parameters<typeof github>[0], token: string | null = HOSTS) =>
      tokenFileGithubPort({ secretsDir: () => secrets(token), fetch: github(o).fetch }).openPulls(
        "acme/widgets",
      );
    expect((await pulls({ status: 401 })).kind).toBe("unknown");
    expect((await pulls({}, null)).kind).toBe("unknown");
    expect(
      await pulls({ graphql: { data: { repository: null }, errors: [{ message: "Not found" }] } }),
    ).toEqual({
      kind: "unknown",
      why: "GitHub did not list acme/widgets's pull requests: Not found",
    });
    const junk = await pulls({ pages: [[{ title: "no number" }]] });
    expect(junk.kind).toBe("unknown");
  });

  it("opens no browser, and says so", async () => {
    const port = tokenFileGithubPort({ secretsDir: () => secrets(HOSTS), fetch: github().fetch });
    expect(await port.openInBrowser("acme/widgets", 7)).toMatchObject({ ok: false });
  });

  // MUTATION: make hostAwareGithubPort return `o.own` whatever `managed()`
  // says — a host-managed home runs gh, and this fails.
  it("the home reads through gh or the token file by the marker, decided again on every call", async () => {
    const gh = fakeGh(() => ({ stdout: "octo\n" }));
    const api = github();
    let managed = false;
    const port = hostAwareGithubPort({
      managed: () => managed,
      own: githubPort(gh),
      host: tokenFileGithubPort({ secretsDir: () => secrets(HOSTS), fetch: api.fetch }),
    });
    expect(await port.user()).toEqual({ kind: "known", value: "octo" });
    expect(api.calls).toEqual([]);
    managed = true;
    gh.calls.length = 0;
    expect(await port.user()).toEqual({ kind: "known", value: "dana-op" });
    expect((await port.openPulls("acme/widgets")).kind).toBe("known");
    expect((await port.openInBrowser("acme/widgets", 7)).ok).toBe(false);
    expect(gh.calls).toEqual([]);
  });

  it("the real adapters take the marker from the config and the token from its secrets dir", async () => {
    const dir = mkdtempSync(join(tmp, "install-"));
    const cfg = join(dir, "config.toml");
    const kept = secrets(HOSTS);
    const gh = fakeGh(() => ({ stdout: "octo\n" }));
    const api = github();
    const adapters = realHomeAdapters({
      agentDir: join(dir, "agent"),
      configPath: () => cfg,
      reviews: idleReviews(),
      runner: gh,
      env: { HOME: join(dir, "home") },
      fetch: api.fetch,
    });
    // no config yet: an install that keeps its own, read through gh
    expect(adapters.hostManaged?.()).toBe(false);
    expect(await adapters.github.user()).toEqual({ kind: "known", value: "octo" });
    writeFileSync(
      cfg,
      `[github]\nrepo = "acme/widgets"\nauth = "user"\ntoken_source = "host"\nsecrets_dir = ${JSON.stringify(kept)}\n`,
    );
    gh.calls.length = 0;
    expect(adapters.hostManaged?.()).toBe(true);
    expect(await adapters.github.user()).toEqual({ kind: "known", value: "dana-op" });
    expect((await adapters.github.openPulls("acme/widgets")).kind).toBe("known");
    expect(gh.calls).toEqual([]);
    expect(api.calls.every((c) => c.auth === `Bearer ${HOSTS}`)).toBe(true);
  });
});

describe("the repository port", () => {
  const CFG = "/cfg/config.toml";
  const port = (content?: string | Error) =>
    repoPort(() => CFG, files(content === undefined ? {} : { [CFG]: content }));

  it("reads [github] repo", async () => {
    expect(await port('[github]\nrepo = "acme/widgets"\n').repo()).toEqual({
      kind: "known",
      value: "acme/widgets",
    });
  });

  it("no config, or an empty repo, is no repository", async () => {
    expect(await port().repo()).toEqual({ kind: "known", value: null });
    expect(await port('[github]\nrepo = ""\n').repo()).toEqual({ kind: "known", value: null });
  });

  it("a config that can't be read or parsed, or a repo of the wrong shape, is unknown", async () => {
    expect((await port("[github\nrepo=").repo()).kind).toBe("unknown");
    expect((await port('[github]\nrepo = "not a repo"\n').repo()).kind).toBe("unknown");
    expect((await port(Object.assign(new Error("EACCES"), { code: "EACCES" })).repo()).kind).toBe(
      "unknown",
    );
  });
});

describe("the ports without an adapter yet", () => {
  it("answer unknown, never a zero", async () => {
    expect((await unbuiltPorts.autoReview.status()).kind).toBe("unknown");
    expect((await unbuiltPorts.memory.status()).kind).toBe("unknown");
    expect((await unbuiltPorts.spend.totals()).kind).toBe("unknown");
  });
});

describe("the home's options from the env", () => {
  // MUTATION: fall back to a model name when QCR_HOME_MODEL is unset — this fails.
  it("take the launch's pinned model and tool set, else no model and the reviewer tools", () => {
    const a = homeOptionsFromEnv({
      HOME: "/h",
      QCR_HOME_MODEL: "made-up/large-3",
      QCR_HOME_TOOLS: "full",
    });
    expect([a.model, a.tools]).toEqual(["made-up/large-3", "full"]);
    const b = homeOptionsFromEnv({ HOME: "/h" });
    expect([b.model, b.tools]).toEqual(["", "reviewer"]);
  });

  it("name pi's agent dir, where the model route reads the remembered choice", () => {
    expect(homeOptionsFromEnv({ HOME: "/h" }).agentDir).toBe("/h/.pi/agent");
    expect(homeOptionsFromEnv({ HOME: "/h", PI_CODING_AGENT_DIR: "/srv/pi" }).agentDir).toBe(
      "/srv/pi",
    );
  });

  it("read the login from the agent dir pi itself reads", async () => {
    // PI_CODING_AGENT_DIR names a dir with no auth file: no login, not an error
    const o = homeOptionsFromEnv({
      HOME: "/nonexistent-home",
      PI_CODING_AGENT_DIR: "/nonexistent-agent",
    });
    expect(await o.adapters.login.providers()).toEqual({ kind: "known", value: [] });
  });
});

describe("the stack the home drives", () => {
  const tmp = mkdtempSync(join(tmpdir(), "home-stack-"));
  afterAll(() => rmSync(tmp, { recursive: true, force: true }));
  const env = { HOME: "/h", XDG_STATE_HOME: "/x/state" };

  it("is QCR_ROOT when set, and a checkout or the image is its own", () => {
    expect(homeStackRoot({ ...env, QCR_ROOT: " /srv/qcr " }, "/opt/qcr")).toBe("/srv/qcr");
    expect(homeStackRoot(env, "/src/quickreview")).toBe("/src/quickreview");
    expect(homeStackRoot(env, "/opt/qcr")).toBe("/opt/qcr");
  });

  // MUTATION: keep the package root for an installed app — this fails.
  it("is in the state home for an app a package manager installed, never inside the package", () => {
    const pkg = "/usr/lib/node_modules/@quickchatai/quickreview";
    expect(homeStackRoot(env, pkg)).toBe(join(stateHome(env), "stack"));
    expect(homeStackRoot(env, "/w/proj/node_modules/@quickchatai/quickreview")).toBe(
      join(stateHome(env), "stack"),
    );
  });

  it("gets the package's compose file, tunnel context and config template, and keeps the person's state", () => {
    const pkg = join(tmp, "pkg");
    mkdirSync(join(pkg, "docker", "tunnel"), { recursive: true });
    writeFileSync(join(pkg, "docker-compose.yml"), "services: {} # new\n");
    writeFileSync(join(pkg, "docker", "tunnel", "Dockerfile"), "FROM x\n");
    writeFileSync(join(pkg, "config.example.toml"), "dry_run = true\n");
    const stack = join(tmp, "stack");
    mkdirSync(join(stack, "state"), { recursive: true });
    writeFileSync(join(stack, "docker-compose.yml"), "services: {} # old\n");
    writeFileSync(join(stack, ".env"), "QCR_PI_LOGIN_DIR=/h/.pi/agent\n");
    writeFileSync(join(stack, "state", "keep.json"), "{}");
    seedStack(stack, pkg);
    expect(readFileSync(join(stack, "docker-compose.yml"), "utf8")).toBe("services: {} # new\n");
    expect(existsSync(join(stack, "docker", "tunnel", "Dockerfile"))).toBe(true);
    expect(existsSync(join(stack, "config.example.toml"))).toBe(true);
    expect(readFileSync(join(stack, ".env"), "utf8")).toBe("QCR_PI_LOGIN_DIR=/h/.pi/agent\n");
    expect(existsSync(join(stack, "state", "keep.json"))).toBe(true);
  });

  it("a checkout's own stack is left alone", () => {
    const pkg = join(tmp, "checkout");
    mkdirSync(pkg, { recursive: true });
    writeFileSync(join(pkg, "docker-compose.yml"), "services: {}\n");
    seedStack(pkg, pkg);
    expect(readFileSync(join(pkg, "docker-compose.yml"), "utf8")).toBe("services: {}\n");
  });
});
