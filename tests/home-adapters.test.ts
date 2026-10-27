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
  seedStack,
  parsePulls,
  piLoginPort,
  repoPort,
  unbuiltPorts,
  type RunResult,
  type Runner,
} from "../src/home/adapters.js";
import { stateHome } from "../src/homes.js";

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
  it("take the launch's model and tool set, else the defaults", () => {
    const a = homeOptionsFromEnv({
      HOME: "/h",
      QCR_HOME_MODEL: "anthropic/claude-x",
      QCR_HOME_TOOLS: "full",
    });
    expect([a.model, a.tools]).toEqual(["anthropic/claude-x", "full"]);
    const b = homeOptionsFromEnv({ HOME: "/h" });
    expect([b.model, b.tools]).toEqual(["openai-codex/gpt-6.1-sol", "reviewer"]);
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
