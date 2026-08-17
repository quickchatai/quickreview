// Socket Mode is the ONLY inbound Slack transport (ratified).
//
// This file turns that decision into a structural constraint rather than a
// paragraph in a spec: the webhook server must expose exactly two things —
// `GET /health` and `POST /webhook` — and every plausible Slack path must 404
// on every method. The second half is a source-level invariant: src/webhook.ts
// may not so much as MENTION slack, so an events endpoint cannot be added
// there quietly (the same trick as the allowed-mutation-set sweep in
// tests/e2e-dryrun.test.ts).
import { createHmac } from "node:crypto";
import { readFileSync } from "node:fs";
import type { AddressInfo } from "node:net";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { parseConfig } from "../src/config.js";
import { StateStore } from "../src/state.js";
import { createWebhookServer } from "../src/webhook.js";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const SECRET = "test-webhook-secret";

let store: StateStore;
let server: ReturnType<typeof createWebhookServer>;
let base: string;

beforeAll(async () => {
  store = new StateStore(":memory:");
  const cfg = parseConfig(readFileSync(join(root, "config.toml"), "utf8"));
  server = createWebhookServer({ cfg, store, secret: SECRET, onInterpretation: async () => {}, log: () => {} });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterAll(async () => {
  await new Promise<void>((r) => server.close(() => r()));
  store.close();
});

/** A correctly signed GitHub delivery, so `POST /webhook` proves it is HANDLED
 * (200) rather than merely "not 404". */
function signedDelivery(): { body: string; headers: Record<string, string> } {
  const body = JSON.stringify({ action: "opened", number: 4242 });
  return {
    body,
    headers: {
      "x-hub-signature-256": `sha256=${createHmac("sha256", SECRET).update(body).digest("hex")}`,
      "x-github-delivery": "d-no-route-1",
      "x-github-event": "pull_request",
      "content-type": "application/json",
    },
  };
}

/** Every path a future "just add a Slack endpoint" would plausibly reach for. */
const SLACK_PATHS = [
  "/slack",
  "/slack/",
  "/slack/events",
  "/slack/actions",
  "/slack/commands",
  "/slack/interactive",
  "/events",
  "/api/slack",
];

describe("no Slack HTTP route exists", () => {
  it("serves the two routes the daemon actually has", async () => {
    const health = await fetch(`${base}/health`);
    expect(health.status).toBe(200);
    expect(await health.json()).toEqual({ ok: true });

    const { body, headers } = signedDelivery();
    const hook = await fetch(`${base}/webhook`, { method: "POST", body, headers });
    expect(hook.status).toBe(200);
    expect(((await hook.json()) as { ok: boolean }).ok).toBe(true);
  });

  it("404s every plausible Slack path, on GET and on POST", async () => {
    for (const path of SLACK_PATHS) {
      for (const method of ["GET", "POST"] as const) {
        const res = await fetch(`${base}${path}`, {
          method,
          ...(method === "POST" ? { body: JSON.stringify({ type: "url_verification", challenge: "c" }) } : {}),
        });
        expect(res.status, `${method} ${path} must not be routed`).toBe(404);
      }
    }
  });

  it("404s a POST to /health too — the allowlist is method-exact", async () => {
    const res = await fetch(`${base}/health`, { method: "POST", body: "{}" });
    expect(res.status).toBe(404);
  });

  it("src/webhook.ts contains no reference to slack at all", () => {
    const source = readFileSync(join(root, "src", "webhook.ts"), "utf8");
    expect(source.toLowerCase()).not.toContain("slack");
  });
});
