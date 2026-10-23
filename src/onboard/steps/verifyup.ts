// Layered verification: "it's running" as a CHECKED claim.
//
// Three layers, deliberately in this order, because each one can only mean
// anything if the one before it holds:
//
//   1. CONTAINER STATE — is the daemon (with its memory sidecar, and the tunnel
//      the operator chose) actually running? Docker's own answer, not an
//      inference. The containers are the pulled release images; a stale pin is
//      `qcr update` / QCR_VERSION in .env, not a rebuild.
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
// noise. Every check names its own fix in its own detail line: the wizard
// refuses to proceed past a failed verification, and says why in plain words.
//
// Nothing here mutates the reviewed repo. The one write it can make is a
// webhook REDELIVERY on the App's own hook — App-scoped, never a review, a
// label, a branch or a comment, and so nowhere near the daemon's mutation gate
// (this is the wizard, running before and beside the daemon, exactly as the
// github_app step's App creation is).
//
// Layers 1 and 2 run against WHICHEVER host the system lives on. The
// step does not know or care which: it asks `stackTransportFor(ctx)` — the one
// decision point — and gets either the compose transport (docker on this
// machine, a fetch to the published port) or the ssh one (docker on the
// server, a curl on the box). Layer 3 needs no transport at all: it reads
// GitHub's OWN delivery log, which is the same record wherever the daemon
// runs, and that is exactly why it is the layer that proves the path.
import { CHOICE_KEYS } from "../choices.js";
import { mintAppJwt } from "@quickchatai/pi-quickreview/src/githubAuth.js";
import type { CheckResult, OnboardingStep, StepContext, StepReport } from "../engine.js";
import { ingressOptionOf, secretsDirFor, readConfigText } from "./compose.js";
import { api as githubApi, readCredentials } from "./githubapp.js";
import { readTomlKey, WEBHOOK_PATH } from "./ingress.js";
import { sshCommandLine } from "./ssh.js";
import { sshAliasOf, topologyOf } from "./topology.js";
import { tuiRouteCheck, type TuiRouteCheckOptions } from "./tuiroute.js";
import {
  DEFAULT_HEALTH_TIMEOUT_MS,
  stackTransportFor,
  type TransportOptions,
} from "./transport.js";

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
  /** The TUI-route check's seams (tuiroute.ts): its runner and route facts. */
  tuiRoute?: TuiRouteCheckOptions;
}

// ---- GitHub's delivery log ---------------------------------------------------

export interface HookDelivery {
  id: number;
  event: string;
  status: string;
  status_code: number;
  delivered_at: string;
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
    });
  }
  return out;
}

/** GitHub records a 2xx as delivered; anything else is a failure to deliver. */
export function deliverySucceeded(d: HookDelivery): boolean {
  return d.status_code >= 200 && d.status_code < 300;
}

/** The ping deliveries, NEWEST FIRST (delivery ids only grow). Only the
 * newest one speaks for the path as it is configured now: an older accepted
 * ping may have reached a previous URL, or been signed with a previous secret. */
export function pings(deliveries: readonly HookDelivery[]): HookDelivery[] {
  return deliveries.filter((d) => d.event === "ping").sort((a, b) => b.id - a.id);
}

/** How many pages of the delivery log (50 rows each) are read looking for the
 * newest ping: ordinary traffic after a ping pushes it off the first page. */
export const MAX_DELIVERY_PAGES = 10;

/** The `rel="next"` URL of a GitHub `Link` header, or null. */
export function nextPageUrl(link: string | null): string | null {
  if (!link) return null;
  for (const part of link.split(",")) {
    const m = /<([^>]+)>\s*;\s*rel="next"/.exec(part);
    if (m) return m[1]!;
  }
  return null;
}

/** The newest delivery of ANY event, when it is newer than `ping` and was NOT
 * accepted; undefined otherwise (a successful newest delivery hides earlier
 * failures, even ones newer than `ping`). GitHub pings only when the webhook is (re)configured,
 * so an accepted ping can be long stale: if the ingress stopped reaching the
 * daemon since, the deliveries after it say so and the ping must not speak
 * for the path as it is now. */
export function newerFailure(
  deliveries: readonly HookDelivery[],
  ping: HookDelivery,
): HookDelivery | undefined {
  const newest = [...deliveries].sort((a, b) => b.id - a.id)[0];
  return newest && newest.id > ping.id && !deliverySucceeded(newest) ? newest : undefined;
}

// ---- the step ----------------------------------------------------------------

interface ApiAnswer {
  status: number;
  body: unknown;
  error: string;
  /** The response's `Link` header (pagination), or null. */
  link: string | null;
}

async function api(
  ctx: StepContext,
  url: string,
  jwt: string,
  init?: RequestInit,
): Promise<ApiAnswer> {
  const result = await githubApi(ctx.adapters.fetch, url, {
    ...init,
    headers: { authorization: `Bearer ${jwt}`, ...(init?.headers ?? {}) },
  });
  return {
    status: result.status,
    body: result.body,
    error: result.status === 0 ? result.text : "",
    link: result.link ?? null,
  };
}

export function verifyStackStep(opts: VerifyStackStepOptions = {}): OnboardingStep {
  const apiBase = opts.apiBase ?? "https://api.github.com";
  const sleep = opts.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const pingPollAttempts = opts.pingPollAttempts ?? 6;
  const pingPollIntervalMs = opts.pingPollIntervalMs ?? 5_000;
  const redeliver = opts.redeliver ?? true;
  const healthTimeoutMs = opts.healthTimeoutMs ?? DEFAULT_HEALTH_TIMEOUT_MS;

  /** Layer 3 — GitHub's own record that a webhook reached the daemon. */
  async function pingLayer(ctx: StepContext): Promise<CheckResult[]> {
    const secretsDir =
      opts.secretsDir ?? secretsDirFor(ctx.adapters, ctx.choices, opts.env ?? process.env);
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
    if (ingressOptionOf(ctx.choices)?.id === "named") {
      const host =
        ctx.choices[CHOICE_KEYS.ingressHostname] ??
        readTomlKey(readConfigText(ctx.adapters) ?? "", "server", "hostname");
      const expected =
        ctx.choices[CHOICE_KEYS.webhookUrl] ??
        (typeof host === "string" && host ? `https://${host}${WEBHOOK_PATH}` : null);
      const normalize = (url: unknown): string | null => {
        try {
          return typeof url === "string" ? new URL(url).href : null;
        } catch {
          return null;
        }
      };
      if (normalize(expected) === null || normalize(hookUrl) !== normalize(expected)) {
        checks[checks.length - 1] = {
          name: "webhook-url",
          ok: false,
          detail: `GitHub webhook endpoint ${typeof hookUrl === "string" ? hookUrl : "unknown"} does not match the selected fixed endpoint ${typeof expected === "string" ? expected : "unknown"}; update the App webhook URL, then run this step again`,
        };
        return checks;
      }
    }

    // Newest first, page by page until a ping turns up: the deliveries
    // above it are exactly the ones `newerFailure` must see, and ordinary
    // traffic since the last ping must not push the ping out of view.
    const read = async (): Promise<{ rows: HookDelivery[]; problem: string }> => {
      const rows: HookDelivery[] = [];
      let url: string | null = `${apiBase}/app/hook/deliveries?per_page=50`;
      for (let page = 0; url !== null && page < MAX_DELIVERY_PAGES; page += 1) {
        const r = await api(ctx, url, jwt);
        if (r.status !== 200) {
          return {
            rows: [],
            problem:
              `GET /app/hook/deliveries answered HTTP ${r.status}${r.error ? ` (${r.error})` : ""} — Fix: an App created without a ` +
              "webhook has no delivery log; check the App's Advanced tab, and that the webhook is Active",
          };
        }
        const got = parseDeliveries(r.body);
        rows.push(...got);
        if (got.some((d) => d.event === "ping")) break;
        url = nextPageUrl(r.link);
      }
      return { rows, problem: "" };
    };

    let { rows, problem } = await read();
    if (problem) {
      checks.push({ name: "ping-delivery", ok: false, detail: problem });
      return checks;
    }
    let candidates = pings(rows);
    const good = candidates[0];
    const stale = good && deliverySucceeded(good) ? newerFailure(rows, good) : undefined;
    const pingDetail = (d: HookDelivery): string =>
      stale && deliverySucceeded(d) ? stalePingDetail(ctx, d, stale) : failedPingDetail(ctx, d);
    if (good && deliverySucceeded(good) && !stale) {
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
          `${rows.length} deliveries in the App's log and none of them a ping — only a ping counts here, and GitHub sends one ` +
          "only when the webhook is (re)configured: redelivering another event from the App's Advanced tab re-sends THAT " +
          "event, never a ping. Fix: change and re-save the webhook URL, then run this step again. " +
          "Reviews would still be triggered by the reconcile poll, but author replies and the feedback loop are webhook-only",
      });
      return checks;
    }

    // The newest ping failed — or it was accepted, but deliveries since then
    // were not (`stale`). Either way, a fresh delivery of it is the proof.
    const failed = candidates[0]!;
    if (!redeliver) {
      checks.push({ name: "ping-delivery", ok: false, detail: pingDetail(failed) });
      return checks;
    }
    ctx.adapters.log?.(
      stale
        ? `${VERIFY_STACK_STEP_ID}: the last ping was accepted, but a newer ${stale.event} delivery was not (HTTP ${stale.status_code}) — asking GitHub to redeliver the ping`
        : `${VERIFY_STACK_STEP_ID}: the last ping was not delivered (HTTP ${failed.status_code}) — asking GitHub to redeliver it`,
    );
    const attempt = await api(ctx, `${apiBase}/app/hook/deliveries/${failed.id}/attempts`, jwt, {
      method: "POST",
    });
    if (attempt.status !== 202 && attempt.status !== 200) {
      checks.push({
        name: "ping-delivery",
        ok: false,
        detail: `${pingDetail(failed)} The redelivery request itself answered HTTP ${attempt.status}, so nothing was retried.`,
      });
      return checks;
    }
    for (let i = 1; i <= pingPollAttempts; i += 1) {
      await sleep(pingPollIntervalMs);
      ({ rows, problem } = await read());
      if (problem) {
        // The watch itself failed: say THAT, not the older ping's diagnosis —
        // its fixes (URL, secret, tunnel) do not answer a log we cannot read.
        checks.push({
          name: "ping-delivery",
          ok: false,
          detail: `a ping redelivery was requested, but reading the delivery log again failed: ${problem}`,
        });
        return checks;
      }
      candidates = pings(rows);
      const good = candidates[0];
      // Only a ping NEWER than the one redelivered answers for the path now,
      // and — as on the first read — only when nothing newer has failed since.
      if (
        good &&
        good.id > failed.id &&
        deliverySucceeded(good) &&
        newerFailure(rows, good) === undefined
      ) {
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
    const last = candidates[0] ?? failed;
    const newer = deliverySucceeded(last) ? newerFailure(rows, last) : undefined;
    checks.push({
      name: "ping-delivery",
      ok: false,
      detail: newer ? stalePingDetail(ctx, last, newer) : failedPingDetail(ctx, last),
    });
    return checks;
  }

  function stalePingDetail(ctx: StepContext, ping: HookDelivery, newer: HookDelivery): string {
    return (
      `the last ping was accepted (HTTP ${ping.status_code} at ${ping.delivered_at || "an unrecorded time"}), but a newer ` +
      `${newer.event} delivery was not (HTTP ${newer.status_code}${newer.status ? `, ${newer.status}` : ""} at ` +
      `${newer.delivered_at || "an unrecorded time"}) and no fresh ping got through — so the path is NOT proven as it is now. ` +
      pingFixes(ctx)
    );
  }

  function failedPingDetail(ctx: StepContext, d: HookDelivery): string {
    return `GitHub could not deliver its ping: HTTP ${d.status_code}${d.status ? ` (${d.status})` : ""}. ${pingFixes(ctx)}`;
  }

  /** Where the tunnel's own log is: a compose sidecar here, the cloudflared
   * host service on the server route. */
  function tunnelLogs(ctx: StepContext): string {
    if (topologyOf(ctx.choices) !== "vm") return "`docker compose logs` on the tunnel sidecar";
    const alias = sshAliasOf(ctx.choices) || "<vm>";
    return `\`${sshCommandLine(alias, ["journalctl", "-u", "cloudflared", "-n", "50"])}\` (cloudflared runs as a service on the server)`;
  }

  function pingFixes(ctx: StepContext): string {
    return (
      "Fix, in the order worth trying: " +
      "① the webhook URL above must be the public address of THIS daemon — on a rotating tunnel the daemon re-points it itself, " +
      "so give it a few seconds after bring-up and run this step again; ② a 401/403 means the webhook secret on GitHub is not the " +
      "one in your secrets dir (re-run the github_app step to re-create the App with a fresh pair); ③ a timeout means the tunnel " +
      `is not reaching the daemon — ${tunnelLogs(ctx)}.`
    );
  }

  /** The whole verification. run() and verify() are the same act here: this
   * step only ever LOOKS (plus the one ping redelivery, which is the remedy
   * for what it looked at), so there is nothing for a "run" to do differently. */
  async function layers(ctx: StepContext): Promise<StepReport> {
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
    // The operator's own window onto the stack: can `qcr tui` read it the way
    // it will? Independent of webhook delivery, so it never stops layer 3.
    checks.push(await tuiRouteCheck(ctx, opts.tuiRoute));
    // Layer 3 exists only where GitHub can deliver. The polling topology
    // deliberately exposes nothing, so a ping can never land there — requiring
    // one would keep this step (and so onboarding's finish) red forever.
    if (ingressOptionOf(ctx.choices)?.id === "polling") {
      checks.push({
        name: "ping-delivery",
        ok: true,
        detail:
          "not checked — you chose polling, which exposes no webhook endpoint, so webhook delivery is not expected; " +
          "the reconcile poll is the only trigger path",
      });
      return { ok: checks.every((c) => c.ok), checks };
    }
    checks.push(...(await pingLayer(ctx)));
    return { ok: checks.every((c) => c.ok), checks };
  }

  return {
    id: VERIFY_STACK_STEP_ID,
    title: "Verify the running system, in layers",
    explain:
      "Checks that the system is really up, in three layers, each one meaningful only if the one before it holds: the " +
      "containers are running, the daemon answers its health endpoint, and GitHub's own delivery log shows a webhook ping " +
      "arriving (not under polling, which exposes no webhook endpoint). A red layer stops here and says exactly what to do about it — nothing later would mean anything until it is " +
      "fixed. Safe to run as often as you like; it changes nothing except asking GitHub to redeliver a ping that failed.",
    order: 74,

    run: layers,
    verify: layers,
  };
}
