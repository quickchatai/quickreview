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
