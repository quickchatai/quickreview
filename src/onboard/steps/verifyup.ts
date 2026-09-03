// Layered verification: "it's running" as a CHECKED claim.
//
// Three layers, deliberately in this order, because each one can only mean
// anything if the one before it holds:
//
//   1. CONTAINER STATE — is the daemon (and the tunnel the operator chose)
//      actually running? Docker's own answer, not an inference.
//   2. HEALTH — does the daemon answer `GET /health`? That is the process
//      saying "I booted, I loaded my config, I am serving".
//   3. PING DELIVERY — did GitHub's webhook actually ARRIVE? This is the only
//      layer that proves the path from GitHub, through the tunnel, into the
//      daemon. It is read from the App's OWN delivery log (`GET
//      /app/hook/deliveries`, App-JWT authed), so it is GitHub's record, not
//      ours; a failed ping is redelivered once (`POST …/attempts`) rather than
//      merely reported, because a redelivery is the exact remedy and it touches
//      only the App's own webhook.
//
// A red layer STOPS the step and says so: the later layers would report
// noise. Every check names its own fix in its own detail line — that is the
// promise that the wizard "refuses to proceed past a failed
// verification with a plain explanation".
//
// Nothing here mutates the reviewed repo. The one write it can make is a
// webhook REDELIVERY on the App's own hook — App-scoped, never a review, a
// label, a branch or a comment, and so nowhere near the daemon's mutation gate
// (this is the wizard, running before and beside the daemon, exactly as
//'s App creation is).
//
// layers 1 and 2 run against WHICHEVER host the system lives on. The
// step does not know or care which: it asks `stackTransportFor(ctx)` — the one
// decision point — and gets either the compose transport (docker on this
// machine, a fetch to the published port) or the ssh one (docker on the
// server, a curl on the box). Layer 3 needs no transport at all: it reads
// GitHub's OWN delivery log, which is the same record wherever the daemon
// runs, and that is exactly why it is the layer that proves the path.
import { mintAppJwt } from "../../githubAuth.js";
import type { CheckResult, OnboardingStep, StepContext, StepReport } from "../engine.js";
import { ingressOptionOf, rootOf, secretsDirFor } from "./compose.js";
import { readCredentials } from "./githubapp.js";
import { stackTransportFor, type TransportOptions } from "./transport.js";

export const VERIFY_STACK_STEP_ID = "verify_stack";

export interface VerifyStackStepOptions {
  apiBase?: string;
  secretsDir?: string;
  env?: NodeJS.ProcessEnv;
  /** Attempts to see a good ping AFTER a redelivery is requested. */
  pingPollAttempts?: number;
  pingPollIntervalMs?: number;
  sleep?: (ms: number) => Promise<void>;
  /** Redeliver a failed ping once (the remedy) — off only in tests that assert
   * the read-only path. */
  redeliver?: boolean;
  /** Health probe timeout. */
  healthTimeoutMs?: number;
  /** The stack transport's own options (the long-command stream runner).
   * WHICH transport is never an option: `stackTransportFor` decides from the
   * recorded topology, and this step never learns which one it got. */
  transport?: TransportOptions;
}

// ---- GitHub's delivery log ---------------------------------------------------

export interface HookDelivery {
  id: number;
  event: string;
  status: string;
  status_code: number;
  delivered_at: string;
  redelivery: boolean;
}

/** Parse `GET /app/hook/deliveries` totally: junk yields no rows. */
export function parseDeliveries(body: unknown): HookDelivery[] {
  if (!Array.isArray(body)) return [];
  const out: HookDelivery[] = [];
  for (const raw of body) {
    if (typeof raw !== "object" || raw === null) continue;
    const row = raw as Record<string, unknown>;
    if (typeof row.id !== "number" || typeof row.event !== "string") continue;
    out.push({
      id: row.id,
      event: row.event,
      status: typeof row.status === "string" ? row.status : "",
      status_code: typeof row.status_code === "number" ? row.status_code : 0,
      delivered_at: typeof row.delivered_at === "string" ? row.delivered_at : "",
      redelivery: row.redelivery === true,
    });
  }
  return out;
}

/** GitHub records a 2xx as delivered; anything else is a failure to deliver. */
export function deliverySucceeded(d: HookDelivery): boolean {
  return d.status_code >= 200 && d.status_code < 300;
}

export function pings(deliveries: readonly HookDelivery[]): HookDelivery[] {
  return deliveries.filter((d) => d.event === "ping");
}

// ---- the step ----------------------------------------------------------------

interface ApiAnswer {
  status: number;
  body: unknown;
  error: string;
}

async function api(
  ctx: StepContext,
  url: string,
  jwt: string,
  init?: RequestInit,
): Promise<ApiAnswer> {
  try {
    const res = await ctx.adapters.fetch(url, {
      ...init,
      headers: {
        accept: "application/vnd.github+json",
        authorization: `Bearer ${jwt}`,
        "user-agent": "quickreview-onboarding",
        ...(init?.headers ?? {}),
      },
    });
    const text = await res.text();
    let body: unknown = null;
    try {
      body = text ? (JSON.parse(text) as unknown) : null;
    } catch {
      body = null;
    }
    return { status: res.status, body, error: "" };
  } catch (err) {
    return { status: 0, body: null, error: String(err) };
  }
}

export function verifyStackStep(opts: VerifyStackStepOptions = {}): OnboardingStep {
  const apiBase = opts.apiBase ?? "https://api.github.com";
  const sleep = opts.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const pingPollAttempts = opts.pingPollAttempts ?? 6;
  const pingPollIntervalMs = opts.pingPollIntervalMs ?? 5_000;
  const redeliver = opts.redeliver ?? true;
  const healthTimeoutMs = opts.healthTimeoutMs ?? 10_000;

  /** Layer 3 — GitHub's own record that a webhook reached the daemon. */
  async function pingLayer(ctx: StepContext, root: string): Promise<CheckResult[]> {
    const secretsDir = opts.secretsDir ?? secretsDirFor(root, ctx.choices, opts.env ?? process.env);
    const creds = readCredentials(secretsDir);
    if (!creds.complete) {
      return [
        {
          name: "ping-delivery",
          ok: false,
          detail: `${creds.problems.join("; ")} — Fix: run the github_app step, which writes the App credentials into ${secretsDir}`,
        },
      ];
    }
    const jwt = mintAppJwt(creds.appId!, creds.pem!, () => ctx.adapters.clock().getTime());
    const checks: CheckResult[] = [];

    // The URL GitHub is delivering to. Reported, never judged on its own: the
    // quick tunnel rotates it and the daemon re-points it itself.
    const config = await api(ctx, `${apiBase}/app/hook/config`, jwt);
    const hookUrl = (config.body as { url?: unknown } | null)?.url;
    checks.push({
      name: "webhook-url",
      ok: config.status === 200,
      detail:
        config.status === 200
          ? `GitHub is delivering this App's webhooks to ${typeof hookUrl === "string" ? hookUrl : "(no URL set)"}`
          : `GET /app/hook/config answered HTTP ${config.status}${config.error ? ` (${config.error})` : ""} — Fix: the App id and ` +
            "private key must belong to the same App; re-run the github_app step",
    });
    if (config.status !== 200) return checks;

    const read = async (): Promise<{ rows: HookDelivery[]; problem: string }> => {
      const r = await api(ctx, `${apiBase}/app/hook/deliveries?per_page=50`, jwt);
      if (r.status !== 200) {
        return {
          rows: [],
          problem:
            `GET /app/hook/deliveries answered HTTP ${r.status}${r.error ? ` (${r.error})` : ""} — Fix: an App created without a ` +
            "webhook has no delivery log; check the App's Advanced tab, and that the webhook is Active",
        };
      }
      return { rows: parseDeliveries(r.body), problem: "" };
    };

    let { rows, problem } = await read();
    if (problem) {
      checks.push({ name: "ping-delivery", ok: false, detail: problem });
      return checks;
    }
    let candidates = pings(rows);
    if (candidates.some(deliverySucceeded)) {
      const good = candidates.filter(deliverySucceeded).at(0)!;
      checks.push({
        name: "ping-delivery",
        ok: true,
        detail:
          `GitHub's own delivery log shows a ping accepted by your daemon (HTTP ${good.status_code} at ${good.delivered_at || "an unrecorded time"}) — ` +
          "the whole path from GitHub through your ingress into the daemon is proven end to end",
      });
      return checks;
    }
    if (candidates.length === 0) {
      checks.push({
        name: "ping-delivery",
        ok: false,
        detail:
          `${rows.length} deliveries in the App's log and none of them a ping — Fix: GitHub sends a ping when the webhook is ` +
          '(re)configured. Open the App\'s Advanced tab and use "Redeliver" on any delivery, or change and re-save the webhook URL. ' +
          "Reviews would still be triggered by the reconcile poll, but author replies and the feedback loop are webhook-only",
      });
      return checks;
    }

    const failed = candidates[0]!;
    if (!redeliver) {
      checks.push({ name: "ping-delivery", ok: false, detail: failedPingDetail(failed) });
      return checks;
    }
    ctx.adapters.log?.(
      `${VERIFY_STACK_STEP_ID}: the last ping was not delivered (HTTP ${failed.status_code}) — asking GitHub to redeliver it`,
    );
    const attempt = await api(ctx, `${apiBase}/app/hook/deliveries/${failed.id}/attempts`, jwt, {
      method: "POST",
    });
    if (attempt.status !== 202 && attempt.status !== 200) {
      checks.push({
        name: "ping-delivery",
        ok: false,
        detail: `${failedPingDetail(failed)} The redelivery request itself answered HTTP ${attempt.status}, so nothing was retried.`,
      });
      return checks;
    }
    for (let i = 1; i <= pingPollAttempts; i += 1) {
      await sleep(pingPollIntervalMs);
      ({ rows, problem } = await read());
      if (problem) break;
      candidates = pings(rows);
      const good = candidates.find(deliverySucceeded);
      if (good) {
        checks.push({
          name: "ping-delivery",
          ok: true,
          detail:
            `the redelivered ping was accepted (HTTP ${good.status_code}) — the path from GitHub through your ingress into the ` +
            "daemon is proven end to end",
        });
        return checks;
      }
      ctx.adapters.log?.(
        `${VERIFY_STACK_STEP_ID}: no accepted ping yet (${i}/${pingPollAttempts}) — still watching GitHub's delivery log`,
      );
    }
    checks.push({
      name: "ping-delivery",
      ok: false,
      detail: failedPingDetail(candidates[0] ?? failed),
    });
    return checks;
  }

  function failedPingDetail(d: HookDelivery): string {
    return (
      `GitHub could not deliver its ping: HTTP ${d.status_code}${d.status ? ` (${d.status})` : ""}. Fix, in the order worth trying: ` +
      "① the webhook URL above must be the public address of THIS daemon — on a rotating tunnel the daemon re-points it itself, " +
      "so give it a few seconds after bring-up and run this step again; ② a 401/403 means the webhook secret on GitHub is not the " +
      "one in your secrets dir (re-run the github_app step to re-create the App with a fresh pair); ③ a timeout means the tunnel " +
      "is not reaching the daemon — `docker compose logs` on the tunnel sidecar."
    );
  }

  /** The whole verification. run() and verify() are the same act here: this
   * step only ever LOOKS (plus the one ping redelivery, which is the remedy
   * for what it looked at), so there is nothing for a "run" to do differently. */
  async function layers(ctx: StepContext): Promise<StepReport> {
    const root = rootOf(ctx.adapters);
    const transport = stackTransportFor(ctx, { ...opts.transport, healthTimeoutMs });
    const checks: CheckResult[] = await transport.containerChecks(ingressOptionOf(ctx.choices));
    if (!checks.every((c) => c.ok)) {
      checks.push({
        name: "layers",
        ok: false,
        detail:
          "the health and ping-delivery layers were not run — a container that is not up cannot answer either of them",
      });
      return { ok: false, checks };
    }
    // Layer 2 — the daemon's own answer on its health endpoint, however this
    // topology can reach it (a fetch to the published port on this machine; a
    // curl on the box, over ssh, on the server route).
    const health = await transport.health();
    checks.push(health);
    if (!health.ok) {
      checks.push({
        name: "layers",
        ok: false,
        detail:
          "the ping-delivery layer was not run — GitHub cannot deliver to a daemon that is not answering",
      });
      return { ok: false, checks };
    }
    checks.push(...(await pingLayer(ctx, root)));
    return { ok: checks.every((c) => c.ok), checks };
  }

  return {
    id: VERIFY_STACK_STEP_ID,
    title: "Verify the running system, in layers",
    explain:
      "Checks that the system is really up, in three layers, each one meaningful only if the one before it holds: the " +
      "containers are running, the daemon answers its health endpoint, and GitHub's own delivery log shows a webhook ping " +
      "arriving. A red layer stops here and says exactly what to do about it — nothing later would mean anything until it is " +
      "fixed. Safe to run as often as you like; it changes nothing except asking GitHub to redeliver a ping that failed.",
    order: 74,

    run: layers,
    verify: layers,
  };
}
