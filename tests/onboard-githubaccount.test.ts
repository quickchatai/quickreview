// The github_account step — the wizard's GitHub question and the whole
// own-account route (src/onboard/steps/githubaccount.ts).
//
// Faked: a routed runner (sh / gh / crontab), a fetch over GitHub's `/user`,
// `/user/repos`, `/repos/{o}/{r}` and the label endpoints, temp dirs for the
// config and the secrets. The composed flow (tests/onboard-flow.test.ts) owns
// the handoffs; this file owns the step's own branches and its verify.
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { loadConfig } from "../src/config.js";
import { CHOICE_KEYS } from "../src/onboard/choices.js";
import {
  OnboardingEngine,
  type OnboardAdapters,
  type ProcessResult,
} from "../src/onboard/engine.js";
import {
  GITHUB_ACCOUNT_STEP_ID,
  githubAccountStep,
  parseRepoAnswer,
} from "../src/onboard/steps/githubaccount.js";
import { defaultSteps } from "../src/onboard/steps/index.js";
import { readTomlKey, setTomlKey } from "../src/onboard/steps/ingress.js";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const exampleConfig = readFileSync(join(repoRoot, "config.example.toml"), "utf8");
const GH = "/usr/local/bin/gh";
const TOKEN = "gho_personTokenValue0123456789abcdef";

let root: string;
let secretsDir: string;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "qcr-ghaccount-"));
  secretsDir = join(root, "secrets");
  mkdirSync(join(root, "state"), { recursive: true });
  writeFileSync(join(root, "config.example.toml"), exampleConfig);
  writeFileSync(
    join(root, "config.toml"),
    setTomlKey(exampleConfig, "github", "secrets_dir", secretsDir)!,
  );
});
afterEach(() => rmSync(root, { recursive: true, force: true }));

interface World {
  token: string | null;
  crontab: string | null;
  hasCrontab: boolean;
  perms: Record<string, boolean>;
  repoStatus: number;
  labels: Set<string>;
  calls: string[];
  /** Who GraphQL's `viewer` says the token is; null: it names nobody. */
  viewer: string | null;
}

function world(over: Partial<World> = {}): World {
  return {
    token: TOKEN,
    crontab: null,
    hasCrontab: true,
    perms: { pull: true, triage: true, push: true },
    repoStatus: 200,
    labels: new Set(),
    calls: [],
    viewer: null,
    ...over,
  };
}

function adapters(w: World, over: Partial<OnboardAdapters> = {}): OnboardAdapters {
  const runner = {
    async run(cmd: string, args: string[]): Promise<ProcessResult> {
      w.calls.push([cmd, ...args].join(" "));
      if (cmd === "sh" && args[1] === "command -v gh")
        return { code: 0, stdout: `${GH}\n`, stderr: "" };
      if (cmd === GH && args.join(" ") === "auth token")
        return w.token
          ? { code: 0, stdout: `${w.token}\n`, stderr: "" }
          : { code: 1, stdout: "", stderr: "not logged in" };
      if (cmd === "sh" && args[1] === "command -v crontab")
        return w.hasCrontab
          ? { code: 0, stdout: "/usr/bin/crontab\n", stderr: "" }
          : { code: 1, stdout: "", stderr: "" };
      if (cmd === "crontab" && args[0] === "-l")
        return w.crontab === null
          ? { code: 1, stdout: "", stderr: "no crontab for dana" }
          : { code: 0, stdout: w.crontab, stderr: "" };
      if (cmd === "crontab" && args.length === 1) {
        w.crontab = readFileSync(args[0]!, "utf8");
        return { code: 0, stdout: "", stderr: "" };
      }
      if (cmd === "docker") return { code: 0, stdout: "", stderr: "" }; // nothing running
      return { code: 127, stdout: "", stderr: `${cmd}: not found` };
    },
  };
  const fetchFn = (async (input: unknown, init?: RequestInit) => {
    const url = new URL(String(input));
    const method = (init?.method ?? "GET").toUpperCase();
    w.calls.push(`${method} ${url.pathname}`);
    const json = (status: number, body: unknown): Response =>
      new Response(JSON.stringify(body), {
        status,
        headers: { "content-type": "application/json" },
      });
    if (new Headers(init?.headers).get("authorization") !== `Bearer ${w.token}`)
      return json(401, { message: "Bad credentials" });
    if (url.pathname === "/user") return json(200, { login: "dana-op" });
    if (method === "POST" && url.pathname === "/graphql")
      return json(200, { data: { viewer: w.viewer === null ? null : { login: w.viewer } } });
    if (url.pathname === "/user/repos")
      return json(
        200,
        Array.from({ length: 20 }, (_, i) => ({
          full_name: `acme/repo-${String(i).padStart(2, "0")}`,
          pushed_at: `2026-10-${String(i + 1).padStart(2, "0")}T00:00:00Z`,
          private: i % 2 === 0,
          permissions: { pull: true, push: i !== 19 },
        })),
      );
    const label = /^\/repos\/acme\/web\/labels\/(.+)$/.exec(url.pathname);
    if (method === "GET" && label)
      return w.labels.has(decodeURIComponent(label[1]!))
        ? json(200, {})
        : json(404, { message: "Not Found" });
    if (method === "POST" && url.pathname === "/repos/acme/web/labels") {
      w.labels.add((JSON.parse(String(init?.body)) as { name: string }).name);
      return json(201, {});
    }
    if (url.pathname === "/repos/acme/web")
      return w.repoStatus === 200
        ? json(200, { full_name: "acme/web", permissions: w.perms })
        : json(w.repoStatus, { message: "Not Found" });
    return json(500, { message: `unrouted ${method} ${url.pathname}` });
  }) as unknown as typeof fetch;
  return {
    fetch: fetchFn,
    runner,
    clock: () => new Date("2026-10-24T12:00:00Z"),
    host: { nodeVersion: "v26.0.0", uid: 1000 },
    paths: { stateDir: join(root, "state"), configPath: join(root, "config.toml") },
    log: () => undefined,
    ...over,
  };
}

function engineFor(w: World, over: Partial<OnboardAdapters> = {}): OnboardingEngine {
  return new OnboardingEngine(
    [
      githubAccountStep({
        env: {},
        nodePath: "/usr/bin/node",
        cliPath: "/opt/qcr/dist/src/cli.js",
      }),
    ],
    adapters(w, over),
  );
}

const configText = (): string => readFileSync(join(root, "config.toml"), "utf8");

describe("which of the GitHub steps run, by route", () => {
  // The enabled matrix, over the REAL registry. Exactly one of github_account
  // and github_app runs once the route is answered.
  const matrix = (choices: Record<string, unknown>): Record<string, boolean> =>
    Object.fromEntries(
      defaultSteps()
        .filter((s) => ["github_account", "github_app", "app_slug_reconcile"].includes(s.id))
        .map((s) => [s.id, s.enabled ? s.enabled(choices) : true]),
    );

  it("user: github_account only", () => {
    expect(matrix({ [CHOICE_KEYS.githubAuth]: "user" })).toEqual({
      github_account: true,
      github_app: false,
      app_slug_reconcile: false,
    });
  });

  // MUTATION: leave github_app or app_slug_reconcile enabled on the
  // installation route (`!userAuthRecorded` instead of
  // `!tokenFileRouteRecorded`) — a second App would be created, or the App
  // asked who it is with a key that is not here; this fails.
  it("installation: github_account only — no App is created and none is asked who it is", () => {
    expect(matrix({ [CHOICE_KEYS.githubAuth]: "installation" })).toEqual({
      github_account: true,
      github_app: false,
      app_slug_reconcile: false,
    });
  });

  it("app: the App steps only", () => {
    expect(matrix({ [CHOICE_KEYS.githubAuth]: "app" })).toEqual({
      github_account: false,
      github_app: true,
      app_slug_reconcile: true,
    });
  });

  it("unanswered: github_account runs first (33) and asks; the App steps stay for older checklists", () => {
    expect(matrix({})).toEqual({
      github_account: true,
      github_app: true,
      app_slug_reconcile: true,
    });
    const order = defaultSteps().map((s) => [s.id, s.order] as const);
    const at = (id: string): number => order.find(([i]) => i === id)![1];
    expect(at("github_account")).toBe(33);
    expect(at("github_account")).toBeLessThan(at("config_fill"));
    expect(at("config_fill")).toBeLessThan(at("github_app"));
  });
});

describe("the own-account route", () => {
  it("writes the route's config — and the result loads", async () => {
    const w = world();
    const r = await engineFor(w).runStep(GITHUB_ACCOUNT_STEP_ID, { repo: "acme/web" });
    expect(r.ok, r.failures.join("; ")).toBe(true);
    const text = configText();
    expect(readTomlKey(text, "github", "auth")).toBe("user");
    expect(readTomlKey(text, "github", "bot_login")).toBe("dana-op");
    expect(readTomlKey(text, "github", "app_slug")).toBe("");
    expect(readTomlKey(text, "ingress", "shape")).toBe("polling");
    expect(loadConfig(join(root, "config.toml")).ingress.shape).toBe("polling");
    expect(r.checks[0]).toMatchObject({ name: "route" });
    expect(r.checks[0]!.detail).toMatch(/the default: gh is signed in here/);
  });

  it("lists at most 15 repos, most recently pushed first, and records nothing until one is picked", async () => {
    const w = world();
    const e = engineFor(w);
    const r = await e.runStep(GITHUB_ACCOUNT_STEP_ID);
    expect(r.ok).toBe(false);
    const offer = r.checks.find((c) => c.name === "repo")!.detail;
    const listed = offer.split("\n").filter((l) => l.startsWith("  acme/"));
    expect(listed).toHaveLength(15);
    expect(listed[0]).toContain("acme/repo-19");
    expect(listed[0]).toContain("(read only)");
    expect(offer).not.toContain("acme/repo-04");
    expect(e.choices()[CHOICE_KEYS.githubAuth]).toBeUndefined();
  });

  it("parses the repo answer as owner/name or any github.com URL inside it", () => {
    expect(parseRepoAnswer("acme/web")).toEqual({ owner: "acme", name: "web" });
    expect(parseRepoAnswer("https://github.com/acme/web.git")).toEqual({
      owner: "acme",
      name: "web",
    });
    expect(parseRepoAnswer("github.com/acme/web/pull/12")).toEqual({ owner: "acme", name: "web" });
    expect(parseRepoAnswer("acme")).toBeNull();
    expect(parseRepoAnswer("https://gitlab.com/acme/web")).toBeNull();
  });

  it("a repo the account cannot see is red, and nothing is recorded", async () => {
    const w = world({ repoStatus: 404 });
    const e = engineFor(w);
    const r = await e.runStep(GITHUB_ACCOUNT_STEP_ID, { repo: "acme/web" });
    expect(r.ok).toBe(false);
    expect(r.failures.join(" ")).toMatch(/cannot see acme\/web/);
    expect(e.choices()[CHOICE_KEYS.githubAuth]).toBeUndefined();
    expect(readTomlKey(configText(), "github", "auth")).toBeNull();
  });

  it("read access is enough: without triage the labels are skipped, with the reason", async () => {
    const w = world({ perms: { pull: true, triage: false, push: false } });
    const r = await engineFor(w).runStep(GITHUB_ACCOUNT_STEP_ID, { repo: "acme/web" });
    expect(r.ok, r.failures.join("; ")).toBe(true);
    expect(r.checks.find((c) => c.name === "labels")!.detail).toMatch(/cannot manage labels/);
    expect(w.calls.some((c) => c.startsWith("POST "))).toBe(false);
  });

  it("with triage or better the three labels are created, idempotently", async () => {
    const w = world();
    await engineFor(w).runStep(GITHUB_ACCOUNT_STEP_ID, { repo: "acme/web" });
    expect([...w.labels].sort()).toEqual([
      "AI review in progress",
      "AI review requested",
      "Automatic Review",
    ]);
    const again = await engineFor(w).runStep(GITHUB_ACCOUNT_STEP_ID, { repo: "acme/web" });
    expect(
      again.checks
        .filter((c) => c.name.startsWith("label "))
        .every((c) => /already present/.test(c.detail)),
    ).toBe(true);
  });

  it("no crontab: says what lapses for an 8 h ghu_ token, and gives the manual command with the resolved gh", async () => {
    const w = world({ hasCrontab: false, token: "ghu_brokerTokenValue0123456789abcd" });
    const r = await engineFor(w).runStep(GITHUB_ACCOUNT_STEP_ID, { repo: "acme/web" });
    expect(r.ok, r.failures.join("; ")).toBe(true);
    const refresh = r.checks.find((c) => c.name === "refresh")!.detail;
    expect(refresh).toMatch(/no `crontab`/);
    expect(refresh).toMatch(/expires within 8 hours/);
    expect(refresh).toContain(
      `/usr/bin/node /opt/qcr/dist/src/cli.js github-token sync --gh ${GH} --secrets-dir ${secretsDir}`,
    );
    expect(JSON.stringify(r)).not.toContain("ghu_brokerTokenValue");
  });

  it("inside a container no crontab entry is attempted", async () => {
    const w = world();
    const r = await engineFor(w, {
      host: { nodeVersion: "v26.0.0", uid: 1000, inContainer: true },
    }).runStep(GITHUB_ACCOUNT_STEP_ID, { repo: "acme/web" });
    expect(r.ok).toBe(true);
    expect(r.checks.find((c) => c.name === "refresh")!.detail).toMatch(/inside a container/);
    expect(w.calls.some((c) => c.startsWith("crontab"))).toBe(false);
  });
});

describe("verify re-checks reality", () => {
  it("holds after a run, and demotes on a loose token file, a lost cron entry or an edited config", async () => {
    const w = world();
    await engineFor(w).runStep(GITHUB_ACCOUNT_STEP_ID, { repo: "acme/web" });
    expect((await engineFor(w).verifyAll()).ok).toBe(true);

    chmodSync(join(secretsDir, "github_token"), 0o644);
    expect((await engineFor(w).verifyAll()).results[0]!.failures.join(" ")).toMatch(
      /readable by others/,
    );
    chmodSync(join(secretsDir, "github_token"), 0o600);

    const saved = w.crontab;
    w.crontab = "";
    expect((await engineFor(w).verifyAll()).results[0]!.failures.join(" ")).toMatch(
      /crontab refresh entry is gone/,
    );
    w.crontab = saved;

    writeFileSync(join(root, "config.toml"), setTomlKey(configText(), "github", "auth", "app")!);
    expect((await engineFor(w).verifyAll()).results[0]!.failures.join(" ")).toMatch(/auth = "app"/);
  });

  it("an expired token is red with the refresh command named", async () => {
    const w = world();
    await engineFor(w).runStep(GITHUB_ACCOUNT_STEP_ID, { repo: "acme/web" });
    w.token = "gho_aDifferentTokenNowSignedIn0000000";
    const all = await engineFor(w).verifyAll();
    expect(all.ok).toBe(false);
    expect(all.results[0]!.failures.join(" ")).toMatch(/qcr github-token sync/);
  });

  it("an older checklist with App credentials on disk verifies as the App route", async () => {
    mkdirSync(secretsDir, { recursive: true });
    for (const f of ["app_id", "app.pem", "webhook_secret"])
      writeFileSync(join(secretsDir, f), "x");
    expect((await engineFor(world()).verifyAll()).ok).toBe(true);
    rmSync(join(secretsDir, "app.pem"));
    expect((await engineFor(world()).verifyAll()).ok).toBe(false);
  });
});

describe("the App route", () => {
  it("records the answer, says what comes next, and disables itself", async () => {
    const w = world();
    const e = engineFor(w);
    const r = await e.runStep(GITHUB_ACCOUNT_STEP_ID, { github_auth: "app" });
    expect(r.ok).toBe(true);
    expect(r.checks[0]!.detail).toMatch(/github_app step creates it next/);
    expect(e.choices()[CHOICE_KEYS.githubAuth]).toBe("app");
    expect(e.list()[0]!.status).toBe("disabled");
    // Nothing of the own-account route ran.
    expect(w.calls.some((c) => c.includes("auth token") || c.startsWith("GET /user"))).toBe(false);
  });

  it("switching back from the own-account route flips [github] auth and leaves the token file alone", async () => {
    const w = world();
    await engineFor(w).runStep(GITHUB_ACCOUNT_STEP_ID, { repo: "acme/web" });
    const r = await engineFor(w).runStep(GITHUB_ACCOUNT_STEP_ID, { github_auth: "app" });
    expect(r.ok).toBe(true);
    expect(readTomlKey(configText(), "github", "auth")).toBe("app");
    expect(readFileSync(join(secretsDir, "github_token"), "utf8")).toBe(TOKEN);
  });

  it("a signed-out gh with no answer offers both routes", async () => {
    const r = await engineFor(world({ token: null })).runStep(GITHUB_ACCOUNT_STEP_ID);
    expect(r.ok).toBe(false);
    expect(r.failures.join(" ")).toMatch(/user: your own GitHub account \(RECOMMENDED/);
    expect(r.failures.join(" ")).toMatch(/gh auth login/);
  });
});

// `[github] token_source = "host"`: a host writes the token file and keeps it
// fresh, and owns the identity and the repository. The step proves the file's
// token and touches nothing a sign-in would: no gh, no crontab, no token write.
describe("a host-managed install", () => {
  const HOST_TOKEN = "ghu_hostWrittenTokenValue0123456789ab";
  /** Mark the config, and write the token file as the host would. */
  const hostManaged = (token: string | null = HOST_TOKEN): World => {
    writeFileSync(
      join(root, "config.toml"),
      setTomlKey(configText(), "github", "token_source", "host")!,
    );
    if (token !== null) {
      mkdirSync(secretsDir, { recursive: true, mode: 0o700 });
      writeFileSync(join(secretsDir, "github_token"), token, { mode: 0o600 });
    }
    // gh would answer with ANOTHER token: one that reaches GitHub proves gh was read
    return world({ token: token ?? "gho_neverWrittenByTheHost0123456789ab" });
  };
  /** Every process the step started that a sign-in or a refresher would. */
  const signInCalls = (w: World): string[] =>
    w.calls.filter((c) => /^(sh |crontab|gh |\/usr\/local\/bin\/gh )/.test(c));

  // MUTATION: drop the `hostManaged(ctx)` branch at the top of the step's run
  // — the step resolves gh and installs the crontab entry, and this fails.
  it("passes with no gh on the machine, installs no crontab entry and leaves the token file as the host wrote it", async () => {
    const w = hostManaged();
    const noGh: OnboardAdapters["runner"] = {
      async run(cmd, args) {
        w.calls.push([cmd, ...args].join(" "));
        return cmd === "docker"
          ? { code: 0, stdout: "", stderr: "" }
          : { code: 127, stdout: "", stderr: `${cmd}: not found` };
      },
    };
    const r = await engineFor(w, { runner: noGh }).runStep(GITHUB_ACCOUNT_STEP_ID, {
      github_auth: "user",
      repo: "acme/web",
    });
    expect(r.ok, r.failures.join("; ")).toBe(true);
    expect(signInCalls(w)).toEqual([]);
    expect(w.crontab).toBeNull();
    expect(readFileSync(join(secretsDir, "github_token"), "utf8")).toBe(HOST_TOKEN);
    expect(r.checks.find((c) => c.name === "token")!.detail).toMatch(/signs in as dana-op/);
    expect(r.checks.find((c) => c.name === "refresh")!.detail).toMatch(/no crontab entry/);
    expect(JSON.stringify(r)).not.toContain(HOST_TOKEN);
    expect(JSON.stringify(r)).not.toMatch(/gh auth login|github-token sync/);
  });

  it("proves the file's token with GitHub, and writes the route's config beside the marker", async () => {
    const w = hostManaged();
    const e = engineFor(w);
    const r = await e.runStep(GITHUB_ACCOUNT_STEP_ID, { repo: "acme/web" });
    expect(r.ok, r.failures.join("; ")).toBe(true);
    expect(w.calls).toContain("GET /user");
    expect(w.calls).toContain("GET /repos/acme/web");
    const text = configText();
    expect(readTomlKey(text, "github", "token_source")).toBe("host");
    expect(readTomlKey(text, "github", "auth")).toBe("user");
    expect(readTomlKey(text, "github", "bot_login")).toBe("dana-op");
    expect(readTomlKey(text, "ingress", "shape")).toBe("polling");
    const loaded = loadConfig(join(root, "config.toml"));
    expect(loaded.github.token_source).toBe("host");
    expect(loaded.github.auth).toBe("user");
    expect(e.choices()[CHOICE_KEYS.githubAuth]).toBe("user");
    expect(e.choices()[CHOICE_KEYS.accountRepo]).toBe("acme/web");
  });

  it("creates no label: the host's token may be read-only", async () => {
    const w = hostManaged();
    const r = await engineFor(w).runStep(GITHUB_ACCOUNT_STEP_ID, { repo: "acme/web" });
    expect(r.ok, r.failures.join("; ")).toBe(true);
    expect(w.calls.filter((c) => c.startsWith("POST ") || c.includes("/labels"))).toEqual([]);
    expect(w.labels.size).toBe(0);
    expect(r.checks.find((c) => c.name === "labels")!.detail).toMatch(/read-only/);
  });

  it("a token the host has not written yet is red, naming the host and no command", async () => {
    const w = hostManaged(null);
    const r = await engineFor(w).runStep(GITHUB_ACCOUNT_STEP_ID, { repo: "acme/web" });
    expect(r.ok).toBe(false);
    expect(r.failures.join(" ")).toMatch(/managed by its host/);
    expect(r.failures.join(" ")).not.toMatch(/gh auth login|github-token sync|GH_TOKEN/);
    expect(signInCalls(w)).toEqual([]);
    expect(w.calls.some((c) => c.startsWith("GET "))).toBe(false);
  });

  it("a token GitHub rejects is red, and the file is left as it was", async () => {
    const w = hostManaged();
    w.token = "ghu_theTokenGitHubNowExpects0123456789";
    const r = await engineFor(w).runStep(GITHUB_ACCOUNT_STEP_ID, { repo: "acme/web" });
    expect(r.ok).toBe(false);
    expect(r.failures.join(" ")).toMatch(/GitHub rejected the token/);
    expect(r.failures.join(" ")).toMatch(/managed by its host/);
    expect(readFileSync(join(secretsDir, "github_token"), "utf8")).toBe(HOST_TOKEN);
  });

  it("with no repository it lists none to pick: the repository is the host's", async () => {
    const w = hostManaged();
    const r = await engineFor(w).runStep(GITHUB_ACCOUNT_STEP_ID);
    expect(r.ok).toBe(false);
    expect(r.failures.join(" ")).toMatch(/the repository is managed by your host/);
    expect(w.calls).not.toContain("GET /user/repos");
  });

  it("refuses the App route in words, and changes nothing", async () => {
    const w = hostManaged();
    const before = configText();
    const e = engineFor(w);
    const r = await e.runStep(GITHUB_ACCOUNT_STEP_ID, { github_auth: "app" });
    expect(r.ok).toBe(false);
    expect(r.failures.join(" ")).toMatch(/who reviews is managed by your host/);
    expect(configText()).toBe(before);
    expect(e.choices()[CHOICE_KEYS.githubAuth]).toBeUndefined();
  });

  it("verify re-proves the token and looks for no crontab entry; a failure names the host", async () => {
    const w = hostManaged();
    await engineFor(w).runStep(GITHUB_ACCOUNT_STEP_ID, { repo: "acme/web" });
    w.calls.length = 0;
    expect((await engineFor(w).verifyAll()).ok).toBe(true);
    expect(signInCalls(w)).toEqual([]);

    w.token = "ghu_theTokenGitHubNowExpects0123456789";
    const lapsed = await engineFor(w).verifyAll();
    expect(lapsed.ok).toBe(false);
    expect(lapsed.results[0]!.failures.join(" ")).toMatch(/managed by its host/);
    expect(lapsed.results[0]!.failures.join(" ")).not.toMatch(/github-token sync|gh auth login/);
  });
});

// `[github] auth = "installation"` beside the marker: the token in the file
// is an App installation's, minted by the host that holds the App's key. The
// third route. It is the host-managed route in everything a sign-in would
// touch, and differs in how the token is proved and whose login it is.
describe("the installation route (a host-supplied App installation token)", () => {
  const SLUG = "acme-reviewer";
  const BOT = `${SLUG}[bot]`;
  const HOST_TOKEN = "ghs_hostMintedTokenValue0123456789ab";
  /** No role at all, as GitHub reports a repository to an installation token:
   * a proof that read `permissions` would refuse it. */
  const NO_ROLE = { pull: false, triage: false, push: false, maintain: false, admin: false };
  /** The config as a host's setup leaves it, and the token file as the host
   * writes it. */
  const installation = (o: { slug?: string | null; token?: string | null } = {}): World => {
    let text = setTomlKey(configText(), "github", "token_source", "host")!;
    text = setTomlKey(text, "github", "auth", "installation")!;
    if (o.slug !== null) text = setTomlKey(text, "github", "app_slug", o.slug ?? SLUG)!;
    writeFileSync(join(root, "config.toml"), text);
    const token = o.token === undefined ? HOST_TOKEN : o.token;
    if (token !== null) {
      mkdirSync(secretsDir, { recursive: true, mode: 0o700 });
      writeFileSync(join(secretsDir, "github_token"), token, { mode: 0o600 });
    }
    return world({
      token: token ?? "gho_neverWrittenByTheHost0123456789ab",
      perms: NO_ROLE,
      viewer: BOT,
    });
  };
  const signInCalls = (w: World): string[] =>
    w.calls.filter((c) => /^(sh |crontab|gh |\/usr\/local\/bin\/gh )/.test(c));
  const check = (r: { checks: Array<{ name: string; detail: string }> }, name: string): string =>
    r.checks.find((c) => c.name === name)?.detail ?? "";

  // MUTATION: send a marked config whose auth is "installation" down runHost
  // (drop the `hostRoute(ctx) === "installation"` branch) — the token is sent
  // to `GET /user`, which GitHub refuses for an installation token, and this fails.
  it("proves the token with the repository read, asks who it is by GraphQL, and never the user endpoint", async () => {
    const w = installation();
    const e = engineFor(w);
    const r = await e.runStep(GITHUB_ACCOUNT_STEP_ID, { repo: "acme/web" });
    expect(r.ok, r.failures.join("; ")).toBe(true);
    expect(w.calls).toContain("GET /repos/acme/web");
    expect(w.calls).toContain("POST /graphql");
    expect(w.calls).not.toContain("GET /user");
    expect(w.calls).not.toContain("GET /user/repos");
    expect(signInCalls(w)).toEqual([]);
    expect(check(r, "repo access")).toMatch(/proved with this read/);
    expect(check(r, "identity")).toMatch(/posts as acme-reviewer\[bot\]/);
    expect(JSON.stringify(r)).not.toContain(HOST_TOKEN);
    expect(JSON.stringify(r)).not.toMatch(/gh auth login|github-token sync/);
  });

  it("writes the route's config beside the marker, and both the file and the loader agree", async () => {
    const w = installation();
    const e = engineFor(w);
    const r = await e.runStep(GITHUB_ACCOUNT_STEP_ID, { repo: "acme/web" });
    expect(r.ok, r.failures.join("; ")).toBe(true);
    const text = configText();
    expect(readTomlKey(text, "github", "token_source")).toBe("host");
    expect(readTomlKey(text, "github", "auth")).toBe("installation");
    expect(readTomlKey(text, "github", "app_slug")).toBe(SLUG);
    expect(readTomlKey(text, "github", "bot_login")).toBe(BOT);
    expect(readTomlKey(text, "ingress", "shape")).toBe("polling");
    const loaded = loadConfig(join(root, "config.toml"));
    expect(loaded.github).toMatchObject({
      auth: "installation",
      token_source: "host",
      app_slug: SLUG,
      bot_login: BOT,
    });
    // the third route is on record, with the App the token was proved to be
    expect(e.choices()[CHOICE_KEYS.githubAuth]).toBe("installation");
    expect(e.choices()[CHOICE_KEYS.accountRepo]).toBe("acme/web");
    expect(e.choices()[CHOICE_KEYS.appSlug]).toBe(SLUG);
    expect(e.choices()[CHOICE_KEYS.botLogin]).toBe(BOT);
    // no person's login is recorded: nobody signed in
    expect(e.choices()[CHOICE_KEYS.accountLogin]).toBeUndefined();
  });

  it("the mode is the one the host wrote: switch-on's silent `user` answer does not choose it", async () => {
    const w = installation();
    const e = engineFor(w);
    const r = await e.runStep(GITHUB_ACCOUNT_STEP_ID, { github_auth: "user", repo: "acme/web" });
    expect(r.ok, r.failures.join("; ")).toBe(true);
    expect(e.choices()[CHOICE_KEYS.githubAuth]).toBe("installation");
    expect(readTomlKey(configText(), "github", "auth")).toBe("installation");
    expect(w.calls).not.toContain("GET /user");
  });

  it("touches nothing a sign-in would: no gh, no crontab entry, no token write, no label", async () => {
    const w = installation();
    const r = await engineFor(w).runStep(GITHUB_ACCOUNT_STEP_ID, { repo: "acme/web" });
    expect(r.ok, r.failures.join("; ")).toBe(true);
    expect(signInCalls(w)).toEqual([]);
    expect(w.crontab).toBeNull();
    expect(readFileSync(join(secretsDir, "github_token"), "utf8")).toBe(HOST_TOKEN);
    expect(w.calls.filter((c) => c.includes("/labels"))).toEqual([]);
    expect(w.labels.size).toBe(0);
  });

  // MUTATION: drop identityCheck from runInstallation — a slug that names
  // another App than the token's passes, the reviewer never recognises its
  // own reviews, and this fails.
  it("a token that is another App's than the slug names is red, said plainly, and nothing is recorded", async () => {
    const w = installation();
    w.viewer = "other-app[bot]";
    const before = configText();
    const e = engineFor(w);
    const r = await e.runStep(GITHUB_ACCOUNT_STEP_ID, { repo: "acme/web" });
    expect(r.ok).toBe(false);
    const said = r.failures.join(" ");
    expect(said).toMatch(/acts as other-app\[bot\]/);
    expect(said).toMatch(/set up to post as acme-reviewer\[bot\]/);
    expect(said).toMatch(/app_slug is "acme-reviewer"/);
    expect(configText()).toBe(before);
    expect(e.choices()[CHOICE_KEYS.githubAuth]).toBeUndefined();
  });

  it("a token that cannot say who it is is red too: unknown is not a match", async () => {
    const w = installation();
    w.viewer = null;
    const r = await engineFor(w).runStep(GITHUB_ACCOUNT_STEP_ID, { repo: "acme/web" });
    expect(r.ok).toBe(false);
    expect(r.failures.join(" ")).toMatch(
      /could not check that the token posts as acme-reviewer\[bot\]/,
    );
  });

  it("a repository the token cannot read is red, names the host, and the login is not asked", async () => {
    const w = installation();
    w.repoStatus = 404;
    const r = await engineFor(w).runStep(GITHUB_ACCOUNT_STEP_ID, { repo: "acme/web" });
    expect(r.ok).toBe(false);
    expect(r.failures.join(" ")).toMatch(/installation token cannot read acme\/web/);
    expect(r.failures.join(" ")).toMatch(/managed by its host/);
    expect(w.calls).not.toContain("POST /graphql");
  });

  it("a config that names no App is red before GitHub is asked anything", async () => {
    const w = installation({ slug: "" });
    const r = await engineFor(w).runStep(GITHUB_ACCOUNT_STEP_ID, { repo: "acme/web" });
    expect(r.ok).toBe(false);
    expect(r.failures.join(" ")).toMatch(/app_slug names no GitHub App/);
    expect(w.calls.some((c) => /^(GET|POST) /.test(c))).toBe(false);
  });

  it("a token the host has not written yet is red, naming the host and no command", async () => {
    const w = installation({ token: null });
    const r = await engineFor(w).runStep(GITHUB_ACCOUNT_STEP_ID, { repo: "acme/web" });
    expect(r.ok).toBe(false);
    expect(r.failures.join(" ")).toMatch(/managed by its host/);
    expect(r.failures.join(" ")).not.toMatch(/gh auth login|github-token sync|GH_TOKEN/);
    expect(w.calls.some((c) => /^(GET|POST) /.test(c))).toBe(false);
  });

  it("takes a token of any length GitHub issues", async () => {
    // generated here: no token-shaped literal of that size is written out
    let token = "ghs_";
    for (let i = 0; token.length < 600; i += 1) token += `${(i * 7919).toString(36)}.`;
    token = `${token.slice(0, 599)}z`;
    expect(token).toHaveLength(600);
    const w = installation({ token });
    const r = await engineFor(w).runStep(GITHUB_ACCOUNT_STEP_ID, { repo: "acme/web" });
    expect(r.ok, r.failures.join("; ")).toBe(true);
    expect(JSON.stringify(r)).not.toContain(token.slice(0, 40));
  });

  it("verify re-reads the repository and the token's own login; a drift names both logins", async () => {
    const w = installation();
    await engineFor(w).runStep(GITHUB_ACCOUNT_STEP_ID, { repo: "acme/web" });
    w.calls.length = 0;
    const green = await engineFor(w).verifyAll();
    expect(green.ok, green.results[0]!.failures.join("; ")).toBe(true);
    expect(w.calls).toContain("GET /repos/acme/web");
    expect(w.calls).toContain("POST /graphql");
    expect(w.calls).not.toContain("GET /user");
    expect(signInCalls(w)).toEqual([]);

    w.viewer = "other-app[bot]";
    const drifted = await engineFor(w).verifyAll();
    expect(drifted.ok).toBe(false);
    expect(drifted.results[0]!.failures.join(" ")).toMatch(/acts as other-app\[bot\]/);

    w.viewer = BOT;
    w.token = "ghs_theTokenGitHubNowExpects0123456789";
    const lapsed = await engineFor(w).verifyAll();
    expect(lapsed.ok).toBe(false);
    expect(lapsed.results[0]!.failures.join(" ")).toMatch(/managed by its host/);
    expect(lapsed.results[0]!.failures.join(" ")).not.toMatch(/github-token sync|gh auth login/);
  });

  // MUTATION: drop the INSTALLATION_NEEDS_HOST refusal from the step's run —
  // on an install that keeps its own credential the answer falls through to
  // the person's own route (gh, the crontab entry), and this fails.
  it("is refused in words as an answer on an install no host manages", async () => {
    const w = world();
    const before = configText();
    const e = engineFor(w);
    const typed = await e.runStep(GITHUB_ACCOUNT_STEP_ID, { github_auth: "installation" });
    expect(typed.ok).toBe(false);
    expect(typed.failures.join(" ")).toMatch(/installation token that a host supplies/);
    expect(typed.failures.join(" ")).toMatch(/github_auth: "user"/);
    expect(configText()).toBe(before);
    expect(e.choices()[CHOICE_KEYS.githubAuth]).toBeUndefined();
    expect(signInCalls(w)).toEqual([]);
    expect(w.crontab).toBeNull();
  });
});
