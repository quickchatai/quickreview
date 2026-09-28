// the GitHub App onboarding step: manifest one-click, code exchange,
// credential landing, install verification, labels.
//
// Everything is faked: a routed fake fetch stands in for GitHub, a fake
// callback-server factory stands in for the loopback listener, secrets go to a
// temp dir. The ONE exception is the real listener's own test at the bottom,
// which binds 127.0.0.1:0 (ephemeral) to prove the CSRF state check and a
// deterministic close — the behaviour a fake could not prove.
//
// The properties that matter here:
//   * the step CONSUMES deploy/github-app-manifest.json (the artifact
//     tests/github-app-manifest.test.ts pins) — never an inline copy;
//   * no credential is ever pasted: id, pem and webhook_secret come straight
//     out of the conversion response into 0600 files;
//   * an expired/used code and a missing install are plain guidance with a
//     restart path, never a wedge;
//   * an existing label is success; re-running with everything in place
//     verifies instead of re-creating.
import { generateKeyPairSync } from "node:crypto";
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
  mkdirSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  OnboardingEngine,
  type CheckResult,
  type OnboardAdapters,
  type StepReport,
} from "../src/onboard/engine.js";
import {
  APP_HTML_URL_CHOICE_KEY,
  APP_ID_CHOICE_KEY,
  APP_SLUG_CHOICE_KEY,
  APP_TARGET_CHOICE_KEY,
  BOT_LOGIN_CHOICE_KEY,
  CALLBACK_PATH,
  DEFAULT_LABELS,
  GITHUB_APP_STEP_ID,
  INSTALLATION_ID_CHOICE_KEY,
  LABELS_CHOICE_KEY,
  REPO_CHOICE_KEY,
  SECRET_FILES,
  appCreationUrl,
  convertManifestCode,
  githubAppStep,
  loadManifest,
  manifestPageHtml,
  manifestPath,
  nodeCallbackServer,
  parseRepoSlug,
  parseTargetChoice,
  renderManifest,
  suggestAppName,
  validateCredentialValues,
  writeCredentials,
  type AppManifest,
  type CallbackListener,
  type CallbackServerFactory,
} from "../src/onboard/steps/githubapp.js";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const pinnedManifest = JSON.parse(readFileSync(manifestPath(repoRoot), "utf8")) as AppManifest;

// One keypair for the whole file — mintAppJwt signs with it in every verify.
const { privateKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
const PEM = privateKey.export({ type: "pkcs8", format: "pem" }).toString();

const API = "https://api.test";
const GH = "https://github.test";

let stateDir: string;
let secretsDir: string;

beforeEach(() => {
  stateDir = mkdtempSync(join(tmpdir(), "qcr-ghapp-state-"));
  secretsDir = mkdtempSync(join(tmpdir(), "qcr-ghapp-secrets-"));
});

afterEach(() => {
  rmSync(stateDir, { recursive: true, force: true });
  rmSync(secretsDir, { recursive: true, force: true });
});

// ---- fake GitHub -------------------------------------------------------------

interface GhState {
  /** Conversion response: 201 body, or a status to fail with. */
  conversion: { status: number; body?: unknown };
  installations: Array<{ id: number; account: { login: string } }>;
  /** Labels that already exist in the repo. */
  labels: Set<string>;
  repoStatus: number;
  appStatus: number;
  appBody: { id: number; slug: string };
  ownerType: string;
  calls: string[];
  labelCreateStatus?: number;
}

function ghState(over: Partial<GhState> = {}): GhState {
  return {
    conversion: {
      status: 201,
      body: {
        id: 4242,
        slug: "quick-review-abc123",
        pem: PEM,
        webhook_secret: "s".repeat(40),
        html_url: "https://github.test/apps/quick-review-abc123",
      },
    },
    installations: [{ id: 77, account: { login: "acme" } }],
    labels: new Set<string>(),
    repoStatus: 200,
    appStatus: 200,
    appBody: { id: 4242, slug: "quick-review-abc123" },
    ownerType: "Organization",
    calls: [],
    ...over,
  };
}

function ghFetch(s: GhState): typeof fetch {
  return (async (
    input: Parameters<typeof fetch>[0],
    init?: Parameters<typeof fetch>[1],
  ): Promise<Response> => {
    const url = String(input);
    const method = (init?.method ?? "GET").toUpperCase();
    const path = url.replace(API, "");
    s.calls.push(`${method} ${path}`);
    const json = (status: number, body: unknown): Response =>
      new Response(JSON.stringify(body), {
        status,
        headers: { "content-type": "application/json" },
      });

    if (method === "POST" && /^\/app-manifests\/.+\/conversions$/.test(path)) {
      return s.conversion.status === 201
        ? json(201, s.conversion.body)
        : json(s.conversion.status, s.conversion.body ?? { message: "Not Found" });
    }
    if (method === "GET" && path === "/app") {
      return s.appStatus === 200
        ? json(200, s.appBody)
        : json(s.appStatus, { message: "bad credentials" });
    }
    if (method === "GET" && path.startsWith("/app/installations?"))
      return json(200, s.installations);
    if (method === "POST" && /^\/app\/installations\/\d+\/access_tokens$/.test(path)) {
      return json(201, { token: "ghs_installation", expires_at: "2026-08-30T13:00:00Z" });
    }
    const labelGet = /^\/repos\/([^/]+)\/([^/]+)\/labels\/(.+)$/.exec(path);
    if (method === "GET" && labelGet) {
      const name = decodeURIComponent(labelGet[3]!);
      return s.labels.has(name) ? json(200, { name }) : json(404, { message: "Not Found" });
    }
    const labelPost = /^\/repos\/([^/]+)\/([^/]+)\/labels$/.exec(path);
    if (method === "POST" && labelPost) {
      const body = JSON.parse(String(init?.body ?? "{}")) as { name: string };
      if (s.labelCreateStatus && s.labelCreateStatus !== 201)
        return json(s.labelCreateStatus, { message: "already_exists" });
      s.labels.add(body.name);
      return json(201, { name: body.name });
    }
    if (method === "GET" && /^\/repos\/[^/]+\/[^/]+$/.test(path)) {
      return s.repoStatus === 200
        ? json(200, { full_name: path.slice(7) })
        : json(s.repoStatus, { message: "Not Found" });
    }
    if (method === "GET" && path.startsWith("/users/"))
      return json(200, { login: path.slice(7), type: s.ownerType });
    return json(500, { message: `unrouted ${method} ${path}` });
  }) as unknown as typeof fetch;
}

// ---- fake adapters / listener -------------------------------------------------

function adapters(s: GhState, over: Partial<OnboardAdapters> = {}): OnboardAdapters {
  return {
    fetch: ghFetch(s),
    runner: { run: async () => ({ code: 0, stdout: "", stderr: "" }) },
    clock: () => new Date("2026-08-30T12:00:00Z"),
    host: { nodeVersion: "v22.5.1", uid: 1000 },
    paths: { stateDir, configPath: join(dirname(stateDir), "config.toml") },
    log: () => undefined,
    ...over,
  };
}

interface FakeServer {
  factory: CallbackServerFactory;
  pages: string[];
  started: number;
  closed: number;
}

function fakeServer(arrival: { code: string | null; detail?: string }): FakeServer {
  const out: FakeServer = {
    pages: [],
    started: 0,
    closed: 0,
    factory: null as unknown as CallbackServerFactory,
  };
  out.factory = async (o) => {
    out.started += 1;
    const url = "http://127.0.0.1:8788/";
    const redirectUrl = `http://127.0.0.1:8788${CALLBACK_PATH}`;
    out.pages.push(o.page({ url, redirectUrl }));
    const listener: CallbackListener = {
      url,
      redirectUrl,
      waitForCode: async () => ({
        code: arrival.code,
        detail: arrival.detail ?? "code received on the loopback callback",
      }),
      close: async () => {
        out.closed += 1;
      },
    };
    return listener;
  };
  return out;
}

/** A factory that must never be called (the resume path creates nothing). */
const refusingServer: CallbackServerFactory = async () => {
  throw new Error("the callback server must not be started when credentials already exist");
};

function step(
  _s: GhState,
  server: CallbackServerFactory,
  over: Parameters<typeof githubAppStep>[0] = {},
) {
  return githubAppStep({
    repoRoot,
    secretsDir,
    apiBase: API,
    githubBase: GH,
    serveCallback: server,
    sleep: async () => undefined,
    installPollAttempts: 3,
    installPollIntervalMs: 1,
    randomToken: (bytes) => "a".repeat(bytes * 2),
    ...over,
  });
}

function ctxChoices(choices: Record<string, unknown> = {}): Record<string, unknown> {
  return { [REPO_CHOICE_KEY]: "acme/widgets", ...choices };
}

/** Drive the step through the real engine so persistence is covered too. */
async function runStep(
  s: GhState,
  server: CallbackServerFactory,
  choices: Record<string, unknown> = {},
  over: Parameters<typeof githubAppStep>[0] = {},
  ad: Partial<OnboardAdapters> = {},
): Promise<{
  engine: OnboardingEngine;
  report: { ok: boolean; checks: CheckResult[]; failures: string[] };
}> {
  const engine = new OnboardingEngine([step(s, server, over)], adapters(s, ad));
  // Seed the choices the earlier steps (config/topology) would have recorded.
  Object.assign(
    (engine as unknown as { checklist: { choices: Record<string, unknown> } }).checklist.choices,
    ctxChoices(choices),
  );
  const report = await engine.runStep(GITHUB_APP_STEP_ID);
  return { engine, report };
}

function verifyOnly(
  s: GhState,
  choices: Record<string, unknown> = {},
  over: Parameters<typeof githubAppStep>[0] = {},
): Promise<StepReport> {
  const st = step(s, refusingServer, over);
  const recorded = ctxChoices(choices);
  return st.verify({
    adapters: adapters(s),
    input: {},
    choices: recorded,
    data: {},
    recordChoice: (k, v) => {
      recorded[k] = v;
    },
  });
}

function detail(checks: readonly CheckResult[], name: string): string {
  return checks.find((c) => c.name === name)?.detail ?? `<no check named ${name}>`;
}

function landCredentials(appId = "4242"): void {
  expect(writeCredentials(secretsDir, { appId, pem: PEM, webhookSecret: "s".repeat(40) })).toEqual(
    [],
  );
}

// ---- the manifest artifact ----------------------------------------------------

describe("the pinned manifest is consumed, never copied", () => {
  it("loadManifest reads deploy/github-app-manifest.json itself", () => {
    const loaded = loadManifest(repoRoot);
    expect(loaded.default_permissions).toEqual(pinnedManifest.default_permissions);
    expect(loaded.default_events).toEqual(pinnedManifest.default_events);
    expect(manifestPath(repoRoot).endsWith("deploy/github-app-manifest.json")).toBe(true);
  });

  it("rendering overrides exactly name/redirect_url/webhook, and drops $comment", () => {
    const rendered = renderManifest(pinnedManifest, {
      name: "quick-review-abc",
      redirectUrl: "http://127.0.0.1:8788/manifest-callback",
      webhookUrl: "https://tunnel.example/webhook",
    });
    expect(rendered.name).toBe("quick-review-abc");
    expect(rendered.redirect_url).toBe("http://127.0.0.1:8788/manifest-callback");
    expect(rendered.hook_attributes).toEqual({
      url: "https://tunnel.example/webhook",
      active: true,
    });
    expect(rendered.default_permissions).toEqual(pinnedManifest.default_permissions);
    expect(rendered.default_events).toEqual(pinnedManifest.default_events);
    expect(Object.keys(rendered).some((k) => k.startsWith("$"))).toBe(false);
    // No webhook URL yet ⇒ the artifact's placeholder rides through untouched.
    expect(
      renderManifest(pinnedManifest, { name: "n", redirectUrl: "r" }).hook_attributes.url,
    ).toBe(pinnedManifest.hook_attributes.url);
  });

  it("the served page posts the pinned permissions and events verbatim", async () => {
    const s = ghState();
    const server = fakeServer({ code: "code-1" });
    await runStep(s, server.factory);
    const html = server.pages[0]!;
    const posted = JSON.parse(
      html
        .match(/name="manifest" value="([^"]*)"/)![1]!
        .replace(/&quot;/g, '"')
        .replace(/&lt;/g, "<")
        .replace(/&gt;/g, ">")
        .replace(/&amp;/g, "&"),
    ) as AppManifest;
    expect(posted.default_permissions).toEqual(pinnedManifest.default_permissions);
    expect(posted.default_events).toEqual(pinnedManifest.default_events);
    expect(posted.redirect_url).toBe(`http://127.0.0.1:8788${CALLBACK_PATH}`);
    // The name is suggested with a uniqueness suffix and stays editable on GitHub.
    expect(posted.name).toBe(suggestAppName(pinnedManifest.name, "aaaaaa"));
    expect(posted.name).not.toBe(pinnedManifest.name);
    expect(html).toContain("edit it on GitHub's own page");
  });

  it("suggestAppName keeps within GitHub's name cap", () => {
    expect(suggestAppName("quickreview", "abc123").length).toBeLessThanOrEqual(34);
    expect(suggestAppName("x".repeat(80), "abc123").length).toBeLessThanOrEqual(34);
    expect(suggestAppName("quickreview", "abc123")).toBe("quickreview-abc123");
  });
});

// ---- targeting ----------------------------------------------------------------

describe("personal vs organization targeting", () => {
  it("the org URL differs from the personal one only in path", () => {
    expect(appCreationUrl({ kind: "personal" }, GH)).toBe(`${GH}/settings/apps/new`);
    expect(appCreationUrl({ kind: "org", login: "acme" }, GH)).toBe(
      `${GH}/organizations/acme/settings/apps/new`,
    );
    expect(parseTargetChoice("personal")).toEqual({ kind: "personal" });
    expect(parseTargetChoice("org:acme")).toEqual({ kind: "org", login: "acme" });
    expect(parseTargetChoice("nonsense")).toBeNull();
  });

  it("a recorded org choice posts to the org page and states the deferrable members-read caveat", async () => {
    const s = ghState();
    const server = fakeServer({ code: "code-1" });
    const { report } = await runStep(s, server.factory, { [APP_TARGET_CHOICE_KEY]: "org:acme" });
    expect(report.ok).toBe(true);
    expect(server.pages[0]).toContain(`action="${GH}/organizations/acme/settings/apps/new?state=`);
    const caveat = report.checks.find((c) => c.name === "org approval")!;
    // Explained, never blocking: the check is green and says the label trigger works.
    expect(caveat.ok).toBe(true);
    expect(caveat.detail).toMatch(/members:read/);
    expect(caveat.detail).toMatch(/DEFERRABLE/);
    expect(caveat.detail).toMatch(/label trigger/);
    // The owner-type probe is never needed when the choice is recorded.
    expect(s.calls.some((c) => c.startsWith("GET /users/"))).toBe(false);
  });

  it("a personal choice posts to the personal page and says no org approval is involved", async () => {
    const s = ghState({ installations: [{ id: 77, account: { login: "acme" } }] });
    const server = fakeServer({ code: "code-1" });
    const { report } = await runStep(s, server.factory, { [APP_TARGET_CHOICE_KEY]: "personal" });
    expect(server.pages[0]).toContain(`action="${GH}/settings/apps/new?state=`);
    expect(detail(report.checks, "org approval")).toMatch(/no organization approval/);
  });

  it("with no choice and no prompter the target is DERIVED from the owner type", async () => {
    const s = ghState({ ownerType: "Organization" });
    const server = fakeServer({ code: "code-1" });
    const { engine } = await runStep(s, server.factory);
    expect(s.calls).toContain("GET /users/acme");
    expect(engine.choices()[APP_TARGET_CHOICE_KEY]).toBe("org:acme");
    expect(server.pages[0]).toContain("/organizations/acme/settings/apps/new");

    // A clean machine: fresh checklist AND fresh secrets, so nothing recorded
    // by the first run can decide the second.
    stateDir = mkdtempSync(join(tmpdir(), "qcr-ghapp-state-"));
    secretsDir = mkdtempSync(join(tmpdir(), "qcr-ghapp-secrets-"));
    const personal = ghState({ ownerType: "User" });
    const server2 = fakeServer({ code: "code-1" });
    const second = await runStep(personal, server2.factory);
    expect(second.engine.choices()[APP_TARGET_CHOICE_KEY]).toBe("personal");
  });

  it("the prompter's answer wins over the derivation and is recorded once", async () => {
    const s = ghState({ ownerType: "User" });
    const server = fakeServer({ code: "code-1" });
    const asked: string[] = [];
    const { engine } = await runStep(
      s,
      server.factory,
      {},
      {},
      {
        prompter: async (q) => {
          asked.push(q);
          return "acme";
        },
      },
    );
    expect(asked[0]).toMatch(/personal account, or under an organization/);
    expect(engine.choices()[APP_TARGET_CHOICE_KEY]).toBe("org:acme");
    expect(s.calls.some((c) => c.startsWith("GET /users/"))).toBe(false);
  });
});

// ---- the happy path -----------------------------------------------------------

describe("happy path: one click to a credentialed, installed, labelled App", () => {
  it("exchanges the code, lands the credentials 0600, verifies the install and creates the labels", async () => {
    const s = ghState();
    const server = fakeServer({ code: "one-time-code" });
    const { engine, report } = await runStep(s, server.factory, {
      [APP_TARGET_CHOICE_KEY]: "org:acme",
    });

    expect(report.ok).toBe(true);
    expect(report.checks.filter((c) => !c.ok)).toEqual([]);

    // The credential path: straight from the conversion response to disk.
    expect(s.calls).toContain("POST /app-manifests/one-time-code/conversions");
    expect(readFileSync(join(secretsDir, SECRET_FILES.appId), "utf8").trim()).toBe("4242");
    expect(readFileSync(join(secretsDir, SECRET_FILES.pem), "utf8")).toContain("BEGIN PRIVATE KEY");
    expect(readFileSync(join(secretsDir, SECRET_FILES.webhookSecret), "utf8")).toBe("s".repeat(40));
    for (const f of Object.values(SECRET_FILES))
      expect(statSync(join(secretsDir, f)).mode & 0o777).toBe(0o600);
    expect(statSync(secretsDir).mode & 0o777).toBe(0o700);

    // The install was verified through the App's OWN listing (JWT), not guessed.
    expect(s.calls).toContain("GET /app/installations?per_page=100");
    expect(detail(report.checks, "installation")).toMatch(/installation 77 on acme/);

    // Labels created through the INSTALLATION token, all three of them.
    expect([...s.labels].sort()).toEqual(
      [DEFAULT_LABELS.in_progress, DEFAULT_LABELS.reviewed, DEFAULT_LABELS.trigger].sort(),
    );
    expect(s.calls.filter((c) => c === "POST /repos/acme/widgets/labels")).toHaveLength(3);

    // Identity handed on to the config step.
    expect(engine.choices()[APP_ID_CHOICE_KEY]).toBe("4242");
    expect(engine.choices()[APP_SLUG_CHOICE_KEY]).toBe("quick-review-abc123");
    expect(engine.choices()[BOT_LOGIN_CHOICE_KEY]).toBe("quick-review-abc123[bot]");
    expect(engine.choices()[INSTALLATION_ID_CHOICE_KEY]).toBe(77);
    expect(engine.choices()[APP_HTML_URL_CHOICE_KEY]).toBe(
      "https://github.test/apps/quick-review-abc123",
    );

    // Persisted as done, and the listener always closed.
    expect(engine.list().find((l) => l.id === GITHUB_APP_STEP_ID)?.status).toBe("done");
    expect(server.closed).toBe(1);
  });

  it("nothing prompts for a credential: the operator only ever sees a URL to open", async () => {
    const s = ghState();
    const server = fakeServer({ code: "one-time-code" });
    const lines: string[] = [];
    const asked: string[] = [];
    await runStep(
      s,
      server.factory,
      { [APP_TARGET_CHOICE_KEY]: "personal" },
      {},
      {
        log: (l) => lines.push(l),
        prompter: async (q) => {
          asked.push(q);
          return "personal";
        },
      },
    );
    // The target question is the only thing asked, and no log line carries a secret.
    expect(asked).toHaveLength(0); // the recorded choice pre-empts even that one
    expect(lines.join("\n")).toMatch(/open http:\/\/127\.0\.0\.1:8788\//);
    for (const line of lines) {
      expect(line).not.toContain("s".repeat(40));
      expect(line).not.toContain("BEGIN PRIVATE KEY");
    }
  });

  it("a recorded webhook URL rides into the manifest; without one the placeholder is explained", async () => {
    const s = ghState();
    const withUrl = fakeServer({ code: "c" });
    await runStep(s, withUrl.factory, { webhook_url: "https://tunnel.example/webhook" });
    expect(withUrl.pages[0]).toContain("https://tunnel.example/webhook");

    stateDir = mkdtempSync(join(tmpdir(), "qcr-ghapp-state-"));
    secretsDir = mkdtempSync(join(tmpdir(), "qcr-ghapp-secrets-"));
    const lines: string[] = [];
    const without = fakeServer({ code: "c" });
    await runStep(ghState(), without.factory, {}, {}, { log: (l) => lines.push(l) });
    expect(lines.join("\n")).toMatch(/tunnel step points it at your real endpoint/);
  });
});

// ---- failure paths ------------------------------------------------------------

describe("expired / stale / single-use codes", () => {
  it("a 404 conversion is plain guidance with a restart, and writes nothing", async () => {
    const s = ghState({ conversion: { status: 404, body: { message: "Not Found" } } });
    const server = fakeServer({ code: "stale-code" });
    const { report } = await runStep(s, server.factory);
    expect(report.ok).toBe(false);
    const d = detail(report.checks, "manifest exchange");
    expect(d).toMatch(/single-use/);
    expect(d).toMatch(/expire an hour/);
    expect(d).toMatch(/Run this step again/);
    expect(d).toMatch(/Nothing was written/);
    expect(existsSync(join(secretsDir, SECRET_FILES.appId))).toBe(false);
    expect(server.closed).toBe(1);
  });

  it("convertManifestCode classifies 404/422 as restart and other failures as transient", async () => {
    const s = ghState({ conversion: { status: 422, body: { message: "Unprocessable" } } });
    const expired = await convertManifestCode(ghFetch(s), API, "c");
    expect(expired.ok).toBe(false);
    if (!expired.ok) expect(expired.restart).toBe(true);

    const flaky = ghState({
      conversion: { status: 503, body: { message: "Service Unavailable" } },
    });
    const transient = await convertManifestCode(ghFetch(flaky), API, "c");
    expect(transient.ok).toBe(false);
    if (!transient.ok) {
      expect(transient.restart).toBe(false);
      expect(transient.detail).toMatch(/transient/);
    }
  });

  it("a 201 missing pem/webhook_secret is refused rather than half-written", async () => {
    const s = ghState({ conversion: { status: 201, body: { id: 7, slug: "x" } } });
    const outcome = await convertManifestCode(ghFetch(s), API, "c");
    expect(outcome.ok).toBe(false);
    if (!outcome.ok) expect(outcome.detail).toMatch(/missing id\/pem\/webhook_secret/);
  });

  it("no callback at all (timeout / abandoned page) restarts instead of wedging", async () => {
    const s = ghState();
    const server = fakeServer({ code: null, detail: "no callback within 600s" });
    const { report } = await runStep(s, server.factory);
    expect(report.ok).toBe(false);
    expect(detail(report.checks, "manifest exchange")).toMatch(/no callback within 600s/);
    expect(detail(report.checks, "manifest exchange")).toMatch(/fresh one-time code/);
    expect(existsSync(join(secretsDir, SECRET_FILES.appId))).toBe(false);
  });
});

describe("declined or missing installation", () => {
  it("polls a bounded number of times, then explains the fix — credentials survive", async () => {
    const s = ghState({ installations: [] });
    const server = fakeServer({ code: "c" });
    const lines: string[] = [];
    const { report } = await runStep(s, server.factory, {}, {}, { log: (l) => lines.push(l) });

    expect(report.ok).toBe(false);
    expect(s.calls.filter((c) => c === "GET /app/installations?per_page=100")).toHaveLength(3); // installPollAttempts
    expect(lines.join("\n")).toMatch(/attempt 3\/3/);
    expect(lines.join("\n")).toMatch(/never waits forever/);
    const d = detail(report.checks, "installation");
    expect(d).toMatch(/nothing is lost/);
    expect(d).toMatch(/verify, not re-create/);
    // The App exists: its credentials stay on disk so the re-run resumes.
    expect(readFileSync(join(secretsDir, SECRET_FILES.appId), "utf8").trim()).toBe("4242");
  });

  it("installed on the account but the repo not selected says exactly that, without polling", async () => {
    const s = ghState({ repoStatus: 404 });
    landCredentials();
    const server = fakeServer({ code: "unused" });
    const { report } = await runStep(s, server.factory);
    expect(report.ok).toBe(false);
    expect(detail(report.checks, "repo access")).toMatch(/not among the selected repositories/);
    // A non-installation blocker is not something a wait can fix: one pass only.
    expect(s.calls.filter((c) => c === "GET /app/installations?per_page=100")).toHaveLength(1);
    expect(server.started).toBe(0);
  });

  it("a listing error is reported as itself, never as 'not installed'", async () => {
    const s = ghState({ appStatus: 401 });
    landCredentials();
    const report = await verifyOnly(s);
    expect(report.ok).toBe(false);
    expect(detail(report.checks, "app reachable")).toMatch(
      /GET \/app with the App JWT failed \(HTTP 401/,
    );
  });
});

describe("labels are idempotent", () => {
  it("an existing label is a success, not an error, and is never re-created", async () => {
    const s = ghState({ labels: new Set([DEFAULT_LABELS.trigger]) });
    const server = fakeServer({ code: "c" });
    const { report } = await runStep(s, server.factory);
    expect(report.ok).toBe(true);
    expect(detail(report.checks, `label "${DEFAULT_LABELS.trigger}"`)).toMatch(
      /already present — left exactly as it is/,
    );
    expect(s.calls.filter((c) => c === "POST /repos/acme/widgets/labels")).toHaveLength(2);
  });

  it("a 422 'already_exists' race on creation is also a success", async () => {
    const s = ghState({ labelCreateStatus: 422 });
    const server = fakeServer({ code: "c" });
    const { report } = await runStep(s, server.factory);
    expect(report.ok).toBe(true);
    expect(detail(report.checks, `label "${DEFAULT_LABELS.reviewed}"`)).toMatch(
      /already existed at creation time/,
    );
  });

  it("recorded non-default label names are used verbatim", async () => {
    const s = ghState();
    const server = fakeServer({ code: "c" });
    const { report } = await runStep(s, server.factory, {
      [LABELS_CHOICE_KEY]: { trigger: "please-review" },
    });
    expect(report.ok).toBe(true);
    expect(s.labels.has("please-review")).toBe(true);
    expect(s.labels.has(DEFAULT_LABELS.trigger)).toBe(false);
    expect(s.labels.has(DEFAULT_LABELS.reviewed)).toBe(true);
  });

  it("verify NEVER creates a label — a missing one is red and points at the run", async () => {
    const s = ghState({ labels: new Set([DEFAULT_LABELS.trigger, DEFAULT_LABELS.in_progress]) });
    landCredentials();
    const report = await verifyOnly(s);
    expect(report.ok).toBe(false);
    expect(detail(report.checks, `label "${DEFAULT_LABELS.reviewed}"`)).toMatch(
      /missing from the repo/,
    );
    expect(s.calls.some((c) => c.startsWith("POST /repos/acme/widgets/labels"))).toBe(false);
  });
});

// ---- resume / verify-only ------------------------------------------------------

describe("resume: re-running with everything in place verifies instead of re-creating", () => {
  it("run() with credentials on disk never starts the callback server or converts a code", async () => {
    const s = ghState({ labels: new Set(Object.values(DEFAULT_LABELS)) });
    landCredentials();
    const { engine, report } = await runStep(s, refusingServer);
    expect(report.ok).toBe(true);
    expect(s.calls.some((c) => c.includes("/app-manifests/"))).toBe(false);
    expect(s.calls.some((c) => c.startsWith("POST /repos/"))).toBe(false);
    expect(engine.list().find((l) => l.id === GITHUB_APP_STEP_ID)?.status).toBe("done");
  });

  it("credentials present but the install missing resumes at the install wait — still no re-creation", async () => {
    const s = ghState({ installations: [] });
    landCredentials();
    const { report } = await runStep(s, refusingServer);
    expect(report.ok).toBe(false);
    expect(s.calls.some((c) => c.includes("/app-manifests/"))).toBe(false);
    expect(detail(report.checks, "installation")).toMatch(/verify, not re-create/);
  });

  it("verify() is green on a configured installation and records the App identity", async () => {
    const s = ghState({ labels: new Set(Object.values(DEFAULT_LABELS)) });
    landCredentials();
    const report = await verifyOnly(s);
    expect(report.ok).toBe(true);
    expect(report.checks.map((c) => c.name)).toEqual([
      "credentials",
      "app reachable",
      "installation",
      "installation token",
      "repo access",
      `label "${DEFAULT_LABELS.trigger}"`,
      `label "${DEFAULT_LABELS.in_progress}"`,
      `label "${DEFAULT_LABELS.reviewed}"`,
      "org approval",
    ]);
  });

  it("a private key that belongs to another App fails verification loudly", async () => {
    const s = ghState({ appBody: { id: 9999, slug: "someone-else" } });
    landCredentials("4242");
    const report = await verifyOnly(s);
    expect(report.ok).toBe(false);
    expect(detail(report.checks, "app reachable")).toMatch(
      /belongs to App 9999, but app_id says 4242/,
    );
  });

  it("the engine's resume demotes the step when the installation disappears", async () => {
    const s = ghState({ labels: new Set(Object.values(DEFAULT_LABELS)) });
    landCredentials();
    const first = await runStep(s, refusingServer);
    expect(first.report.ok).toBe(true);

    const gone = ghState({ installations: [], labels: new Set(Object.values(DEFAULT_LABELS)) });
    const engine = new OnboardingEngine([step(gone, refusingServer)], adapters(gone));
    Object.assign(
      (engine as unknown as { checklist: { choices: Record<string, unknown> } }).checklist.choices,
      ctxChoices(),
    );
    const reconciled = await engine.reconcile();
    expect(reconciled.demoted.map((d) => d.id)).toEqual([GITHUB_APP_STEP_ID]);
    expect(reconciled.demoted[0]!.failures.join(" ")).toMatch(/not installed on "acme"/);
  });
});

// ---- inputs and credential validation -------------------------------------------

describe("inputs and credential validation", () => {
  it("no recorded repo is a refusal-as-answer naming the choice", async () => {
    const s = ghState();
    const st = step(s, refusingServer);
    const report = await st.run({
      adapters: adapters(s),
      input: {},
      choices: {},
      data: {},
      recordChoice: () => undefined,
    });
    expect(report.ok).toBe(false);
    expect(report.checks[0]!.detail).toMatch(/reviewed_repo/);
  });

  it("parseRepoSlug accepts owner/name and nothing else", () => {
    expect(parseRepoSlug("acme/widgets")).toEqual({ owner: "acme", name: "widgets" });
    expect(parseRepoSlug("https://github.com/acme/widgets")).toBeNull();
    expect(parseRepoSlug(42)).toBeNull();
  });

  it("the same validation the secrets wizard uses gates every write", () => {
    expect(
      validateCredentialValues({ appId: "4242", pem: PEM, webhookSecret: "s".repeat(40) }),
    ).toEqual([]);
    expect(
      validateCredentialValues({ appId: "not-a-number", pem: PEM, webhookSecret: "s".repeat(40) }),
    ).toContain("app_id is not a number");
    expect(
      validateCredentialValues({
        appId: "1",
        pem: "-----BEGIN PRIVATE KEY-----\nnope\n-----END PRIVATE KEY-----",
        webhookSecret: "s".repeat(40),
      }),
    ).toContain("app.pem does not parse as a private key");
    expect(validateCredentialValues({ appId: "1", pem: PEM, webhookSecret: "tiny" })).toContain(
      "webhook_secret is suspiciously short (<8 chars)",
    );
  });

  it("a malformed conversion response writes NOTHING at all", () => {
    const dir = join(secretsDir, "nested");
    expect(
      writeCredentials(dir, { appId: "x", pem: PEM, webhookSecret: "s".repeat(40) }),
    ).toHaveLength(1);
    expect(existsSync(join(dir, SECRET_FILES.appId))).toBe(false);
  });

  it("an existing 0644 secret file is tightened to 0600 on rewrite", () => {
    mkdirSync(secretsDir, { recursive: true });
    writeFileSync(join(secretsDir, SECRET_FILES.appId), "1\n", { mode: 0o644 });
    landCredentials();
    expect(statSync(join(secretsDir, SECRET_FILES.appId)).mode & 0o777).toBe(0o600);
  });
});

// ---- the real loopback listener --------------------------------------------------

describe("the loopback callback listener (real, on an ephemeral port)", () => {
  it("serves the page, honours the state token, hands back the code, and closes deterministically", async () => {
    const listener = await nodeCallbackServer({
      state: "state-token",
      port: 0,
      timeoutMs: 5_000,
      page: (bound) =>
        manifestPageHtml({
          postUrl: `${GH}/settings/apps/new`,
          state: "state-token",
          target: { kind: "personal" },
          manifest: pinnedManifest,
        }) + `<!--${bound.redirectUrl}-->`,
    });
    try {
      expect(listener.url).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/$/);
      expect(listener.redirectUrl).toBe(`${listener.url.replace(/\/$/, "")}${CALLBACK_PATH}`);

      const page = await fetch(listener.url);
      expect(page.status).toBe(200);
      expect(await page.text()).toContain('name="manifest"');

      // A callback carrying someone else's state is refused and never resolves.
      const forged = await fetch(
        `${listener.url.replace(/\/$/, "")}${CALLBACK_PATH}?code=evil&state=wrong`,
      );
      expect(forged.status).toBe(400);

      const good = await fetch(
        `${listener.url.replace(/\/$/, "")}${CALLBACK_PATH}?code=real-code&state=state-token`,
      );
      expect(good.status).toBe(200);
      await expect(listener.waitForCode()).resolves.toEqual({
        code: "real-code",
        detail: "code received on the loopback callback",
      });
    } finally {
      await listener.close();
    }
    // Closed deterministically: the port no longer answers.
    await expect(fetch(listener.url)).rejects.toBeTruthy();
  });
});
