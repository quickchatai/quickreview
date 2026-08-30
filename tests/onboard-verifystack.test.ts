// the layered verification: container state, health endpoint, and
// GitHub's own record that a webhook ping reached the daemon.
//
// The two properties worth pinning are the layering itself (a red layer stops
// the step, so the later layers cannot report noise about a system that is not
// there) and that every red check names its own fix.
//
// Everything faked: a routed fake fetch for the health endpoint and GitHub, a
// fake ProcessRunner for `docker compose ps`, an instant sleep so no test waits
// on wall-clock time.
import { generateKeyPairSync } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { OnboardingEngine, type OnboardAdapters, type ProcessResult } from "../src/onboard/engine.js";
import { healthUrl } from "../src/onboard/steps/compose.js";
import { SECRET_FILES } from "../src/onboard/steps/githubapp.js";
import { INGRESS_CHOICE_KEY, setTomlKey } from "../src/onboard/steps/ingress.js";
import { VERIFY_STACK_STEP_ID, deliverySucceeded, parseDeliveries, verifyStackStep } from "../src/onboard/steps/verifyup.js";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const exampleConfig = readFileSync(join(repoRoot, "config.example.toml"), "utf8");
const { privateKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
const PEM = privateKey.export({ type: "pkcs8", format: "pem" }).toString();
const API = "https://api.test";

let root: string;
let secretsDir: string;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "qcr-verify-"));
  secretsDir = join(root, "secrets");
  mkdirSync(secretsDir, { recursive: true });
  mkdirSync(join(root, "state"), { recursive: true });
  writeFileSync(join(root, "config.toml"), setTomlKey(exampleConfig, "github", "secrets_dir", secretsDir)!);
  writeFileSync(join(secretsDir, SECRET_FILES.appId), "4242\n");
  writeFileSync(join(secretsDir, SECRET_FILES.pem), PEM);
  writeFileSync(join(secretsDir, SECRET_FILES.webhookSecret), "s".repeat(40));
});
afterEach(() => rmSync(root, { recursive: true, force: true }));

function seedChoices(choices: Record<string, unknown>): void {
  mkdirSync(join(root, "state", "onboarding"), { recursive: true });
  writeFileSync(
    join(root, "state", "onboarding", "checklist.json"),
    JSON.stringify({ version: 1, created_at: "2026-08-30T10:00:00Z", updated_at: "2026-08-30T10:00:00Z", completed_at: null, choices, steps: {} }),
  );
}

interface Delivery {
  id: number;
  event: string;
  status: string;
  status_code: number;
  delivered_at: string;
  redelivery: boolean;
}

const ping = (o: Partial<Delivery> = {}): Delivery => ({
  id: 1,
  event: "ping",
  status: "OK",
  status_code: 200,
  delivered_at: "2026-08-30T11:59:00Z",
  redelivery: false,
  ...o,
});

interface Harness {
  engine: OnboardingEngine;
  urls: string[];
  logs: string[];
}

function harness(
  o: {
    services?: Array<{ Service: string; State: string }>;
    health?: { status: number; body: string } | "refused";
    hookConfigStatus?: number;
    deliveries?: Delivery[] | "error";
    /** Deliveries returned AFTER a redelivery is requested. */
    afterRedelivery?: Delivery[];
    attemptStatus?: number;
    redeliver?: boolean;
    noCredentials?: boolean;
  } = {},
): Harness {
  const urls: string[] = [];
  const logs: string[] = [];
  if (o.noCredentials) rmSync(join(secretsDir, SECRET_FILES.appId));
  let redelivered = false;
  const fetchFake = (async (input: unknown, init?: RequestInit) => {
    const url = String(input);
    urls.push(`${init?.method ?? "GET"} ${url}`);
    if (url.endsWith("/health")) {
      if (o.health === "refused") throw new Error("connect ECONNREFUSED 127.0.0.1:8787");
      const h = o.health ?? { status: 200, body: JSON.stringify({ ok: true }) };
      return new Response(h.body, { status: h.status });
    }
    if (url === `${API}/app/hook/config`) {
      const status = o.hookConfigStatus ?? 200;
      return new Response(JSON.stringify(status === 200 ? { url: "https://abc.trycloudflare.com/webhook" } : { message: "bad" }), { status });
    }
    if (url.startsWith(`${API}/app/hook/deliveries?`)) {
      if (o.deliveries === "error") return new Response(JSON.stringify({ message: "not found" }), { status: 404 });
      const rows = redelivered && o.afterRedelivery ? o.afterRedelivery : (o.deliveries ?? [ping()]);
      return new Response(JSON.stringify(rows), { status: 200 });
    }
    if (/\/app\/hook\/deliveries\/\d+\/attempts$/.test(url)) {
      redelivered = true;
      return new Response("", { status: o.attemptStatus ?? 202 });
    }
    throw new Error(`unexpected fetch ${url}`);
  }) as unknown as typeof fetch;

  const runner = {
    run: async (_cmd: string, args: string[]): Promise<ProcessResult> => {
      if (args.includes("ps")) return { code: 0, stdout: JSON.stringify(o.services ?? [{ Service: "daemon", State: "running" }]), stderr: "" };
      return { code: 1, stdout: "", stderr: "unexpected" };
    },
  };
  const adapters: OnboardAdapters = {
    fetch: fetchFake,
    runner,
    clock: () => new Date("2026-08-30T12:00:00Z"),
    host: { nodeVersion: "v22.5.1", uid: 1000 },
    paths: { stateDir: join(root, "state") },
    log: (line) => logs.push(line),
  };
  const step = verifyStackStep({
    apiBase: API,
    secretsDir,
    sleep: async () => undefined,
    pingPollAttempts: 2,
    pingPollIntervalMs: 1,
    redeliver: o.redeliver,
  });
  return { engine: new OnboardingEngine([step], adapters), urls, logs };
}

describe("parsing GitHub's delivery log", () => {
  it("is total — junk yields no rows, and only 2xx counts as delivered", () => {
    expect(parseDeliveries(null)).toEqual([]);
    expect(parseDeliveries("nope")).toEqual([]);
    expect(parseDeliveries([{ id: "x", event: "ping" }, null, { id: 3, event: "ping" }])).toHaveLength(1);
    expect(deliverySucceeded(ping({ status_code: 200 }))).toBe(true);
    expect(deliverySucceeded(ping({ status_code: 502, status: "Bad Gateway" }))).toBe(false);
  });

  it("healthUrl follows the published port from the project .env", () => {
    expect(healthUrl(root)).toBe("http://127.0.0.1:8787/health");
    writeFileSync(join(root, ".env"), "QCR_WEBHOOK_PORT=9191\n");
    expect(healthUrl(root)).toBe("http://127.0.0.1:9191/health");
  });
});

describe("all three layers green", () => {
  it("containers, health, and a ping GitHub says it delivered", async () => {
    seedChoices({ [INGRESS_CHOICE_KEY]: "quick" });
    const h = harness({ services: [{ Service: "daemon", State: "running" }, { Service: "tunnel-quick", State: "running" }] });
    const result = await h.engine.runStep(VERIFY_STACK_STEP_ID);
    expect(result.ok).toBe(true);
    expect(result.checks.map((c) => c.name)).toEqual(["containers", "ingress-sidecar", "health", "webhook-url", "ping-delivery"]);
    expect(result.checks.find((c) => c.name === "webhook-url")!.detail).toMatch(/abc\.trycloudflare\.com/);
    expect(result.checks.find((c) => c.name === "ping-delivery")!.detail).toMatch(/proven end to end/);
  });
});

describe("a red layer blocks progress plainly", () => {
  it("a dead container stops the step — the later layers are not even attempted", async () => {
    const h = harness({ services: [{ Service: "daemon", State: "exited (1)" }] });
    const result = await h.engine.runStep(VERIFY_STACK_STEP_ID);
    expect(result.ok).toBe(false);
    expect(result.failures.join(" ")).toMatch(/docker compose logs --tail 200 daemon/);
    expect(result.failures.join(" ")).toMatch(/health and ping-delivery layers were not run/);
    expect(h.urls).toEqual([]);
  });

  it("a daemon that answers nothing on the health port stops the step before GitHub is asked", async () => {
    const h = harness({ health: "refused" });
    const result = await h.engine.runStep(VERIFY_STACK_STEP_ID);
    expect(result.ok).toBe(false);
    expect(result.failures.join(" ")).toMatch(/nothing answered http:\/\/127\.0\.0\.1:8787\/health/);
    expect(result.failures.join(" ")).toMatch(/QCR_WEBHOOK_PORT/);
    expect(h.urls.filter((u) => u.includes("api.test"))).toEqual([]);
  });

  it("a 500 from health names the usual cause — a config the loader rejected", async () => {
    const h = harness({ health: { status: 500, body: "boom" } });
    const result = await h.engine.runStep(VERIFY_STACK_STEP_ID);
    expect(result.ok).toBe(false);
    expect(result.failures.join(" ")).toMatch(/config\.toml the loader rejected/);
  });

  it("a 200 that is not the health payload says something else is on that port", async () => {
    const h = harness({ health: { status: 200, body: "<html>nginx</html>" } });
    const result = await h.engine.runStep(VERIFY_STACK_STEP_ID);
    expect(result.ok).toBe(false);
    expect(result.failures.join(" ")).toMatch(/something else is listening on that port/);
  });
});

describe("the ping layer", () => {
  it("redelivers a failed ping and goes green when the retry lands", async () => {
    const h = harness({ deliveries: [ping({ id: 7, status: "Bad Gateway", status_code: 502 })], afterRedelivery: [ping({ id: 8, redelivery: true })] });
    const result = await h.engine.runStep(VERIFY_STACK_STEP_ID);
    expect(result.ok).toBe(true);
    expect(h.urls).toContain(`POST ${API}/app/hook/deliveries/7/attempts`);
    expect(result.checks.find((c) => c.name === "ping-delivery")!.detail).toMatch(/redelivered ping was accepted/);
  });

  it("a ping that keeps failing is red with the three fixes worth trying, in order", async () => {
    const h = harness({ deliveries: [ping({ id: 7, status_code: 502 })], afterRedelivery: [ping({ id: 7, status_code: 502 })] });
    const result = await h.engine.runStep(VERIFY_STACK_STEP_ID);
    expect(result.ok).toBe(false);
    const detail = result.failures.join(" ");
    expect(detail).toMatch(/① the webhook URL above/);
    expect(detail).toMatch(/② a 401\/403 means the webhook secret/);
    expect(detail).toMatch(/③ a timeout means the tunnel/);
    expect(h.logs.some((l) => l.includes("asking GitHub to redeliver"))).toBe(true);
  });

  it("never redelivers when the caller asked for the read-only path", async () => {
    const h = harness({ deliveries: [ping({ id: 7, status_code: 502 })], redeliver: false });
    const result = await h.engine.runStep(VERIFY_STACK_STEP_ID);
    expect(result.ok).toBe(false);
    expect(h.urls.filter((u) => u.startsWith("POST"))).toEqual([]);
  });

  it("no ping at all points at the App's own Redeliver button", async () => {
    const h = harness({ deliveries: [{ ...ping(), event: "pull_request", id: 3 }] });
    const result = await h.engine.runStep(VERIFY_STACK_STEP_ID);
    expect(result.ok).toBe(false);
    expect(result.failures.join(" ")).toMatch(/Advanced tab/);
    expect(result.failures.join(" ")).toMatch(/reconcile poll/);
  });

  it("a delivery log GitHub will not show is red, not silently green", async () => {
    const h = harness({ deliveries: "error" });
    const result = await h.engine.runStep(VERIFY_STACK_STEP_ID);
    expect(result.ok).toBe(false);
    expect(result.failures.join(" ")).toMatch(/HTTP 404/);
  });

  it("a hook config GitHub rejects stops the layer with the key/id mismatch fix", async () => {
    const h = harness({ hookConfigStatus: 401 });
    const result = await h.engine.runStep(VERIFY_STACK_STEP_ID);
    expect(result.ok).toBe(false);
    expect(result.failures.join(" ")).toMatch(/must belong to the same App/);
  });

  it("missing App credentials are red and name the step that writes them", async () => {
    const h = harness({ noCredentials: true });
    const result = await h.engine.runStep(VERIFY_STACK_STEP_ID);
    expect(result.ok).toBe(false);
    expect(result.failures.join(" ")).toMatch(/run the github_app step/);
  });
});

describe("re-runnable as a diagnostic", () => {
  it("run and verify are the same act, and a green run marks the step done", async () => {
    const h = harness();
    expect((await h.engine.runStep(VERIFY_STACK_STEP_ID)).ok).toBe(true);
    expect(h.engine.list()[0]!.status).toBe("done");
    const again = await h.engine.verifyAll();
    expect(again.ok).toBe(true);
  });

  it("a stack that has since stopped is demoted on resume", async () => {
    const up = harness();
    await up.engine.runStep(VERIFY_STACK_STEP_ID);
    const down = harness({ services: [] });
    expect((await down.engine.reconcile()).demoted.map((d) => d.id)).toEqual([VERIFY_STACK_STEP_ID]);
  });
});
