// GitHub App in one click — the wizard step that turns the
// test-pinned manifest artifact into a fully credentialed, installed App.
//
// The shape, end to end:
//   1. serve a localhost page whose form POSTs deploy/github-app-manifest.json
//      to GitHub's app-creation page (personal or organization target — the
//      org URL differs only in path), carrying a `state` token for CSRF and a
//      `redirect_url` pointing back at this process's loopback listener;
//   2. receive the one-time `code` on that listener and exchange it at the
//      UNAUTHENTICATED conversion endpoint (POST /app-manifests/{code}/
//      conversions). The 201 carries id / slug / pem / webhook_secret — the
//      ONLY moment GitHub ever reveals that secret — and those three land
//      straight in the secrets dir under the same file names, permissions and
//      validation deploy/collect-secrets.sh uses. Nothing is ever pasted by
//      the operator, so no credential passes through a clipboard;
//   3. guided install click, then VERIFY it via the App's own installation
//      listing (App-JWT authed) — bounded polling with progress lines, never
//      an infinite wait;
//   4. create the trigger / in-progress / reviewed labels through the
//      installation token, idempotently (a label that already exists is a
//      success, not an error).
//
// Three hard boundaries this step inherits:
//   * root rule 3 — the App credential is the ONLY credential. Nothing here
//     reads, mints or accepts a personal token, and no credential VALUE is
//     ever logged (ids and lengths only).
//   * root rule 1 stays where it is — this is the WIZARD, not the daemon, and
//     it runs before any daemon exists. The only repo write it makes is
//     CREATING LABEL DEFINITIONS (POST /repos/{o}/{r}/labels), which is not a
//     `MutationKind` at all: it never posts a review, never applies or removes
//     a label on a PR, never pushes a branch, and so never goes near the
//     MutationGate's kinds. Do not grow this step into a repo-mutating path —
//     anything the daemon does belongs behind the gate.
//   * the manifest is CONSUMED, never copied: loadManifest reads
//     deploy/github-app-manifest.json, the artifact tests/github-app-manifest
//     .test.ts pins to the webhook handler and the mutation gate. Only three
//     fields are overridden for this operator (name, redirect_url, and the
//     webhook URL when the tunnel step has already recorded one); permissions
//     and events are whatever the pinned artifact says.
//
// Everything effectful is injected: fetch/clock/log/runner from the engine's
// adapters, and the loopback listener + sleep + token source through the
// step's own options — so the tests fake the whole flow and never bind a port
// or touch the network.
import { createPrivateKey, randomBytes } from "node:crypto";
import { chmodSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { isAbsolute, join } from "node:path";
import type { Socket } from "node:net";
import { mintAppJwt } from "../../githubAuth.js";
import { CHOICE_KEYS, REPO_SLUG_RE, botLoginFor } from "../choices.js";
import { CONFIG_FILL_STEP_ID } from "./configfill.js";
import { readTomlKey, secretsDirFor } from "./ingress.js";
import {
  sandboxRoot,
  readTextOrNull,
  type CheckResult,
  type OnboardingStep,
  type StepContext,
  type StepReport,
} from "../engine.js";

export const GITHUB_APP_STEP_ID = "github_app";

// ---- the choice vocabulary --------------------------------------------------
// Read: the reviewed repo and (optionally) the operator's target/name/webhook.
// Written: everything the config-fill step needs to write config.toml, so the
// App identity is derived once and never re-typed.

// Every one of these is an alias of the shared declaration in
// src/onboard/choices.ts, so this step reads exactly the keys its siblings
// write.

/** "owner/name" of the reviewed repo — recorded by the interview (config_fill). */
export const REPO_CHOICE_KEY = CHOICE_KEYS.repo;
/** "personal" | "org:<login>". Absent ⇒ asked (prompter) or derived. */
export const APP_TARGET_CHOICE_KEY = CHOICE_KEYS.appTarget;
/** The App name: this step's own `app_name` input, recorded so a re-run keeps
 * it. Absent ⇒ suggested with a uniqueness suffix. */
export const APP_NAME_CHOICE_KEY = CHOICE_KEYS.appName;
/** Public webhook URL, when the ingress step has already settled a stable one. */
export const WEBHOOK_URL_CHOICE_KEY = CHOICE_KEYS.webhookUrl;
/** Secrets dir override (config.toml [github] secrets_dir, via config_fill). */
export const SECRETS_DIR_CHOICE_KEY = CHOICE_KEYS.secretsDir;
/** Trigger/status label names as the operator's config carries them. */
export const LABELS_CHOICE_KEY = CHOICE_KEYS.labels;

export const APP_ID_CHOICE_KEY = CHOICE_KEYS.appId;
export const APP_SLUG_CHOICE_KEY = CHOICE_KEYS.appSlug;
export const BOT_LOGIN_CHOICE_KEY = CHOICE_KEYS.botLogin;
export const INSTALLATION_ID_CHOICE_KEY = CHOICE_KEYS.installationId;
export const APP_HTML_URL_CHOICE_KEY = CHOICE_KEYS.appHtmlUrl;

/** Secrets-dir file names — the SAME three deploy/collect-secrets.sh writes. */
export const SECRET_FILES = {
  appId: "app_id",
  pem: "app.pem",
  webhookSecret: "webhook_secret",
} as const;

/** config.example.toml's label defaults; a recorded choice overrides them. */
export const DEFAULT_LABELS = {
  trigger: "AI review requested",
  in_progress: "AI review in progress",
  reviewed: "Automatic Review",
} as const;

const LABEL_META: Array<{ key: keyof typeof DEFAULT_LABELS; color: string; description: string }> =
  [
    {
      key: "trigger",
      color: "1d76db",
      description: "Ask the automated reviewer for a review of this PR",
    },
    {
      key: "in_progress",
      color: "fbca04",
      description: "The automated reviewer is running a round on this PR",
    },
    {
      key: "reviewed",
      color: "0e8a16",
      description: "This PR has been reviewed by the automated reviewer",
    },
  ];

export const DEFAULT_CALLBACK_PORT = 8788;
export const CALLBACK_PATH = "/manifest-callback";
/** GitHub App names are globally unique and length-capped; the suggestion is
 * trimmed to fit and stays editable on GitHub's own creation page.
 * // VERIFY-ON-PIN: the exact 34-character cap is GitHub's, asserted from the
 * manifest-flow docs and not checkable offline — the named `github-app`
 * onboarding smoke step (register a throwaway App against a scratch account)
 * is where it is confirmed. Over-trimming costs nothing; the operator can
 * rename on the page. */
export const MAX_APP_NAME_LENGTH = 34;

// ---- the manifest artifact --------------------------------------------------

export interface AppManifest {
  name: string;
  url: string;
  description: string;
  public: boolean;
  hook_attributes: { url: string; active: boolean };
  redirect_url: string;
  default_permissions: Record<string, string>;
  default_events: string[];
  [key: string]: unknown;
}

/** The pinned artifact's path — deploy/github-app-manifest.json, never a copy. */
export function manifestPath(root: string): string {
  return join(root, "deploy", "github-app-manifest.json");
}

/** Read the pinned manifest. Throws with the path on a missing/broken file —
 * the step turns that into one red check. */
export function loadManifest(
  root: string,
  readFile: (p: string) => string = (p) => readFileSync(p, "utf8"),
): AppManifest {
  const path = manifestPath(root);
  const parsed = JSON.parse(readFile(path)) as AppManifest;
  if (
    !parsed ||
    typeof parsed !== "object" ||
    typeof parsed.name !== "string" ||
    typeof parsed.default_permissions !== "object"
  ) {
    throw new Error(`${path} is not a GitHub App manifest`);
  }
  return parsed;
}

/** A uniqueness suffix on the artifact's name; GitHub App names are global. */
export function suggestAppName(base: string, suffix: string): string {
  const cleanBase = base.trim().replace(/\s+/g, "-");
  const tail = `-${suffix}`;
  return `${cleanBase.slice(0, Math.max(1, MAX_APP_NAME_LENGTH - tail.length))}${tail}`;
}

export interface ManifestOverrides {
  name: string;
  redirectUrl: string;
  /** Public webhook endpoint; absent keeps the artifact's placeholder (the
   * tunnel step re-points the App's webhook URL later). */
  webhookUrl?: string;
}

/**
 * The manifest as POSTed: the pinned artifact with exactly three operator
 * fields overridden. `$comment` (documentation for humans reading the file) is
 * dropped; every permission and event stays exactly as pinned.
 */
export function renderManifest(manifest: AppManifest, o: ManifestOverrides): AppManifest {
  const rendered: AppManifest = { ...manifest };
  for (const key of Object.keys(rendered)) if (key.startsWith("$")) delete rendered[key];
  rendered.name = o.name;
  rendered.redirect_url = o.redirectUrl;
  rendered.hook_attributes = {
    ...manifest.hook_attributes,
    url: o.webhookUrl ?? manifest.hook_attributes.url,
  };
  return rendered;
}

// ---- target (personal vs organization) --------------------------------------

export type AppTarget = { kind: "personal" } | { kind: "org"; login: string };

/** The creation page. The org URL differs from the personal one only in path. */
export function appCreationUrl(target: AppTarget, githubBase = "https://github.com"): string {
  return target.kind === "org"
    ? `${githubBase}/organizations/${encodeURIComponent(target.login)}/settings/apps/new`
    : `${githubBase}/settings/apps/new`;
}

/** "personal" | "org:<login>" ⇒ a target; anything else ⇒ null. */
export function parseTargetChoice(value: unknown): AppTarget | null {
  if (typeof value !== "string") return null;
  const v = value.trim();
  if (v === "personal") return { kind: "personal" };
  const m = /^org:(.+)$/.exec(v);
  return m && m[1]!.trim() ? { kind: "org", login: m[1]!.trim() } : null;
}

export function formatTarget(target: AppTarget): string {
  return target.kind === "org" ? `org:${target.login}` : "personal";
}

// ---- repo slug --------------------------------------------------------------

export interface RepoSlug {
  owner: string;
  name: string;
}

export function parseRepoSlug(value: unknown): RepoSlug | null {
  if (typeof value !== "string") return null;
  const m = REPO_SLUG_RE.exec(value.trim());
  return m ? { owner: m[1]!, name: m[2]! } : null;
}

// ---- credentials on disk ----------------------------------------------------

export interface CredentialState {
  appId: string | null;
  pem: string | null;
  webhookSecret: string | null;
  /** One line per missing/malformed file — rendered straight into checks. */
  problems: string[];
  complete: boolean;
}

/** The same rules deploy/collect-secrets.sh validates with: a numeric app_id,
 * a PEM that actually parses as a private key (openssl pkey there, node's
 * createPrivateKey here — no subprocess), a non-trivial webhook secret. */
export function validateCredentialValues(v: {
  appId: string;
  pem: string;
  webhookSecret: string;
}): string[] {
  const problems: string[] = [];
  if (!/^[0-9]{1,12}$/.test(v.appId.trim())) problems.push("app_id is not a number");
  try {
    createPrivateKey(v.pem);
  } catch {
    problems.push("app.pem does not parse as a private key");
  }
  if (v.webhookSecret.trim().length < 8)
    problems.push("webhook_secret is suspiciously short (<8 chars)");
  return problems;
}

export function readCredentials(secretsDir: string): CredentialState {
  const read = (name: string): string | null => {
    const path = join(secretsDir, name);
    try {
      const body = readFileSync(path, "utf8");
      return body.trim() ? body : null;
    } catch {
      return null;
    }
  };
  const appId = read(SECRET_FILES.appId);
  const pem = read(SECRET_FILES.pem);
  const webhookSecret = read(SECRET_FILES.webhookSecret);
  const problems: string[] = [];
  for (const [name, value] of [
    [SECRET_FILES.appId, appId],
    [SECRET_FILES.pem, pem],
    [SECRET_FILES.webhookSecret, webhookSecret],
  ] as const) {
    if (value === null) problems.push(`${name} missing from ${secretsDir}`);
  }
  if (appId !== null && pem !== null && webhookSecret !== null) {
    problems.push(...validateCredentialValues({ appId, pem, webhookSecret }));
  }
  return {
    appId: appId?.trim() ?? null,
    pem,
    webhookSecret: webhookSecret?.trim() ?? null,
    problems,
    complete: problems.length === 0,
  };
}

/** Land the conversion response: 0600 files under a 0700 dir, validated
 * BEFORE anything is written (a half-written credential set is worse than
 * none). Returns the problems that stopped it; empty means written. */
export function writeCredentials(
  secretsDir: string,
  v: { appId: string; pem: string; webhookSecret: string },
): string[] {
  const problems = validateCredentialValues(v);
  if (problems.length > 0) return problems;
  mkdirSync(secretsDir, { recursive: true, mode: 0o700 });
  chmodSync(secretsDir, 0o700);
  const put = (name: string, body: string): void => {
    const path = join(secretsDir, name);
    writeFileSync(path, body, { mode: 0o600 });
    chmodSync(path, 0o600); // an existing file keeps its old mode otherwise
  };
  put(SECRET_FILES.appId, `${v.appId.trim()}\n`);
  put(SECRET_FILES.pem, v.pem.endsWith("\n") ? v.pem : `${v.pem}\n`);
  put(SECRET_FILES.webhookSecret, v.webhookSecret.trim());
  return [];
}

// ---- the localhost page -----------------------------------------------------

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

export interface PageInputs {
  postUrl: string;
  state: string;
  manifest: AppManifest;
  target: AppTarget;
}

/**
 * The one-click page. A real form POST (GitHub's manifest flow requires the
 * browser to submit the manifest as a form field) — deliberately NOT
 * auto-submitting: the operator sees what is about to be created, and the
 * click is theirs.
 */
export function manifestPageHtml(i: PageInputs): string {
  const json = JSON.stringify(i.manifest);
  const perms = Object.entries(i.manifest.default_permissions)
    .map(([k, v]) => `<li><code>${escapeHtml(k)}</code>: ${escapeHtml(v)}</li>`)
    .join("");
  const where =
    i.target.kind === "org"
      ? `the <strong>${escapeHtml(i.target.login)}</strong> organization`
      : "your personal account";
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><title>Create your QuickReview GitHub App</title>
<style>body{font:16px/1.5 system-ui,sans-serif;max-width:44rem;margin:3rem auto;padding:0 1rem}
button{font:inherit;padding:.6rem 1.2rem;cursor:pointer}code{background:#f3f3f3;padding:0 .2rem}
ul{columns:2}</style></head>
<body>
<h1>Create your GitHub App</h1>
<p>This creates the App <code>${escapeHtml(i.manifest.name)}</code> under ${where}. The name is
globally unique across GitHub — you can edit it on GitHub's own page before confirming.</p>
<p>Permissions and events come from this repository's pinned manifest
(<code>deploy/github-app-manifest.json</code>), so there is nothing to transcribe:</p>
<ul>${perms}</ul>
<p>Webhook: <code>${escapeHtml(i.manifest.hook_attributes.url)}</code></p>
<p>After you confirm on GitHub, you are sent back here and the wizard picks up the App id,
private key and webhook secret automatically. Nothing is copied by hand.</p>
<form action="${escapeHtml(i.postUrl)}?state=${encodeURIComponent(i.state)}" method="post">
  <input type="hidden" name="manifest" value="${escapeHtml(json)}">
  <button type="submit">Create the App on GitHub</button>
</form>
</body></html>
`;
}

function resultPageHtml(title: string, body: string): string {
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><title>${escapeHtml(title)}</title>
<style>body{font:16px/1.5 system-ui,sans-serif;max-width:40rem;margin:3rem auto;padding:0 1rem}</style>
</head><body><h1>${escapeHtml(title)}</h1><p>${escapeHtml(body)}</p></body></html>
`;
}

// ---- the loopback listener seam ---------------------------------------------

export interface CodeArrival {
  code: string | null;
  /** Plain-language account of what happened (timeout, state mismatch, …). */
  detail: string;
}

export interface CallbackListener {
  /** The page the operator opens. */
  url: string;
  /** What goes into the manifest as `redirect_url`. */
  redirectUrl: string;
  /** Resolves once GitHub redirects back, or on the listener's own timeout. */
  waitForCode(): Promise<CodeArrival>;
  close(): Promise<void>;
}

export interface CallbackServerOptions {
  /** The page body, built once the port is known — the manifest's
   * `redirect_url` must name the port actually bound, so the page cannot be
   * rendered before listening. */
  page: (bound: { url: string; redirectUrl: string }) => string;
  state: string;
  /** Preferred loopback port; a busy port falls back to an ephemeral one and
   * the manifest's redirect_url follows the port actually bound. */
  port: number;
  timeoutMs: number;
}

export type CallbackServerFactory = (o: CallbackServerOptions) => Promise<CallbackListener>;

/** The real listener: loopback only, deterministic close (open sockets are
 * destroyed, so close() never hangs on a browser keep-alive). */
export const nodeCallbackServer: CallbackServerFactory = async (o) => {
  const sockets = new Set<Socket>();
  let settle: ((a: CodeArrival) => void) | null = null;
  const arrival = new Promise<CodeArrival>((resolve) => {
    settle = resolve;
  });
  const deliver = (a: CodeArrival): void => {
    if (settle) {
      const s = settle;
      settle = null;
      s(a);
    }
  };

  let html = "";
  // The authorities this listener answers to, set once it is bound. Anything
  // else is a rebound hostname (DNS rebinding) that must never see the page,
  // which carries the state token, nor reach the callback.
  let allowedHosts = new Set<string>();
  const handler = (req: IncomingMessage, res: ServerResponse): void => {
    if (!allowedHosts.has((req.headers.host ?? "").toLowerCase())) {
      res.writeHead(421, { "content-type": "text/plain; charset=utf-8" });
      res.end("misdirected request\n");
      return;
    }
    let url: URL;
    try {
      url = new URL(req.url ?? "/", "http://127.0.0.1");
    } catch {
      res.writeHead(400, { "content-type": "text/plain; charset=utf-8" });
      res.end("bad request\n");
      return;
    }
    if (url.pathname === CALLBACK_PATH) {
      const code = url.searchParams.get("code");
      const state = url.searchParams.get("state");
      if (state !== o.state) {
        res.writeHead(400, { "content-type": "text/html; charset=utf-8" });
        res.end(
          resultPageHtml(
            "Ignored",
            "That callback did not carry this wizard's state token, so it was ignored.",
          ),
        );
        return;
      }
      res.writeHead(code ? 200 : 400, { "content-type": "text/html; charset=utf-8" });
      res.end(
        code
          ? resultPageHtml("App created", "You can close this tab and go back to the wizard.")
          : resultPageHtml(
              "No code",
              "GitHub redirected back without a code. Run the step again to restart.",
            ),
      );
      deliver(
        code
          ? { code, detail: "code received on the loopback callback" }
          : { code: null, detail: "callback carried no code" },
      );
      return;
    }
    if (url.pathname === "/") {
      res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
      res.end(html);
      return;
    }
    res.writeHead(404, { "content-type": "text/plain; charset=utf-8" });
    res.end("not found\n");
  };

  const server: Server = createServer(handler);
  server.on("connection", (s) => {
    sockets.add(s);
    s.on("close", () => sockets.delete(s));
  });

  const listen = (port: number): Promise<number> =>
    new Promise((resolve, reject) => {
      const onError = (err: Error): void => reject(err);
      server.once("error", onError);
      server.listen(port, "127.0.0.1", () => {
        server.removeListener("error", onError);
        const addr = server.address();
        resolve(typeof addr === "object" && addr !== null ? addr.port : port);
      });
    });

  let port: number;
  try {
    port = await listen(o.port);
  } catch {
    port = await listen(0); // preferred port busy — any loopback port will do
  }

  allowedHosts = new Set([`127.0.0.1:${port}`, `localhost:${port}`]);
  const url = `http://127.0.0.1:${port}/`;
  const redirectUrl = `http://127.0.0.1:${port}${CALLBACK_PATH}`;
  html = o.page({ url, redirectUrl });

  const timer = setTimeout(
    () => deliver({ code: null, detail: `no callback within ${Math.round(o.timeoutMs / 1000)}s` }),
    o.timeoutMs,
  );
  timer.unref?.();

  return {
    url,
    redirectUrl,
    waitForCode: () => arrival,
    close: () =>
      new Promise((resolve) => {
        clearTimeout(timer);
        deliver({ code: null, detail: "listener closed" });
        for (const s of sockets) s.destroy();
        server.close(() => resolve());
      }),
  };
};

// ---- GitHub calls -----------------------------------------------------------

export interface ApiResult {
  /** The HTTP status; 0 when the request itself failed (`text` says why). */
  status: number;
  body: unknown;
  text: string;
  link?: string | null;
}

/** One GitHub REST call with the wizard's headers, the body decoded
 * tolerantly. Total: a network failure is status 0, never a throw. */
export async function api(
  fetchFn: typeof fetch,
  url: string,
  init?: RequestInit,
): Promise<ApiResult> {
  const controller = new AbortController();
  const signal = init?.signal
    ? AbortSignal.any([init.signal, controller.signal])
    : controller.signal;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const deadline = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => {
      controller.abort();
      reject(new Error("GitHub request deadline exceeded"));
    }, 10_000);
  });
  const request = async (): Promise<ApiResult> => {
    try {
      const res = await fetchFn(url, {
        ...init,
        signal,
        headers: {
          accept: "application/vnd.github+json",
          "user-agent": "quickreview-onboarding",
          ...(init?.headers ?? {}),
        },
      });
      const text = await res.text();
      let body: unknown = null;
      try {
        body = text ? JSON.parse(text) : null;
      } catch {
        body = null;
      }
      return { status: res.status, body, text, link: res.headers?.get?.("link") ?? null };
    } catch (err) {
      return { status: 0, body: null, text: `request failed: ${String(err)}` };
    }
  };
  try {
    return await Promise.race([request(), deadline]);
  } catch (err) {
    return { status: 0, body: null, text: `request failed: ${String(err)}` };
  } finally {
    clearTimeout(timer);
  }
}

function apiError(r: ApiResult): string {
  const message = (r.body as { message?: string } | null)?.message;
  return `HTTP ${r.status}${message ? `: ${message}` : r.text ? `: ${r.text.slice(0, 200)}` : ""}`;
}

export interface ConvertedApp {
  id: number;
  slug: string;
  pem: string;
  webhook_secret: string;
  html_url?: string;
  owner?: { login?: string };
}

export type ConversionOutcome =
  { ok: true; app: ConvertedApp } | { ok: false; detail: string; restart: boolean };

/**
 * The UNAUTHENTICATED conversion: POST /app-manifests/{code}/conversions.
 * The code is single-use and expires one hour after GitHub issues it, so a
 * 404/422 is never a wedge — it means "start the flow again", and the step
 * says exactly that.
 * // VERIFY-ON-PIN: the 201-with-{id,slug,pem,webhook_secret} shape and the
 * 404-on-expired/used status are GitHub's documented manifest-flow contract,
 * unverifiable offline — the named `github-app` onboarding smoke step
 * (throwaway App on a scratch account) is where they are confirmed live.
 */
export async function convertManifestCode(
  fetchFn: typeof fetch,
  apiBase: string,
  code: string,
): Promise<ConversionOutcome> {
  const r = await api(fetchFn, `${apiBase}/app-manifests/${encodeURIComponent(code)}/conversions`, {
    method: "POST",
  });
  if (r.status === 201) {
    const app = r.body as Partial<ConvertedApp> | null;
    if (
      !app ||
      typeof app.id !== "number" ||
      typeof app.pem !== "string" ||
      typeof app.webhook_secret !== "string"
    ) {
      return {
        ok: false,
        detail:
          "GitHub accepted the code but the conversion response was missing id/pem/webhook_secret",
        restart: true,
      };
    }
    return {
      ok: true,
      app: { ...app, slug: typeof app.slug === "string" ? app.slug : "" } as ConvertedApp,
    };
  }
  if (r.status === 404 || r.status === 422) {
    return {
      ok: false,
      restart: true,
      detail:
        `the one-time code was rejected (${apiError(r)}) — manifest codes are single-use and expire an hour after GitHub issues them. ` +
        "Run this step again: it serves a fresh page and a fresh code. Nothing was written.",
    };
  }
  return {
    ok: false,
    restart: false,
    detail:
      `conversion failed (${apiError(r)}) — this looks transient; run the step again. ` +
      "Running it again creates a fresh App, so GitHub may still hold the one this run created: check your " +
      "GitHub App settings and delete an App this run left behind before retrying.",
  };
}

export type InstallationLookup =
  { status: "found"; id: number } | { status: "none" } | { status: "error"; detail: string };

/** The App's own installation listing (App JWT, never a user token). */
export async function findInstallation(
  fetchFn: typeof fetch,
  apiBase: string,
  jwt: string,
  owner: string,
): Promise<InstallationLookup> {
  const seen = new Set<string>();
  for (let page = 1; page <= 100; page++) {
    const r = await api(
      fetchFn,
      `${apiBase}/app/installations?per_page=100${page === 1 ? "" : `&page=${page}`}`,
      {
        headers: { authorization: `Bearer ${jwt}` },
      },
    );
    if (r.status !== 200)
      return { status: "error", detail: `GET /app/installations failed (${apiError(r)})` };
    if (!Array.isArray(r.body))
      return { status: "error", detail: "GET /app/installations returned an unreadable page" };
    const list = r.body as Array<{ id?: number; account?: { login?: string } }>;
    const match = list.find((i) => (i.account?.login ?? "").toLowerCase() === owner.toLowerCase());
    if (match && typeof match.id === "number") return { status: "found", id: match.id };
    if (list.length < 100) return { status: "none" };
    const signature = JSON.stringify(list.map((i) => i.id).sort((a, b) => (a ?? 0) - (b ?? 0)));
    if (seen.has(signature))
      return {
        status: "error",
        detail: "GET /app/installations repeated a full page; lookup remains incomplete",
      };
    seen.add(signature);
  }
  return {
    status: "error",
    detail: "GET /app/installations exceeded the page budget; lookup remains incomplete",
  };
}

async function installationToken(
  fetchFn: typeof fetch,
  apiBase: string,
  jwt: string,
  id: number,
): Promise<{ token: string } | { error: string }> {
  const r = await api(fetchFn, `${apiBase}/app/installations/${id}/access_tokens`, {
    method: "POST",
    headers: { authorization: `Bearer ${jwt}` },
  });
  const token = (r.body as { token?: string } | null)?.token;
  if (r.status !== 201 || typeof token !== "string")
    return { error: `installation token mint failed (${apiError(r)})` };
  return { token };
}

/** Does the installation actually cover the reviewed repo? A 404 through the
 * installation token means the App is installed on the account but this repo
 * was not selected — a distinct, fixable thing, said plainly. */
async function repoCovered(
  fetchFn: typeof fetch,
  apiBase: string,
  token: string,
  repo: RepoSlug,
): Promise<CheckResult> {
  const r = await api(fetchFn, `${apiBase}/repos/${repo.owner}/${repo.name}`, {
    headers: { authorization: `Bearer ${token}` },
  });
  if (r.status === 200)
    return {
      name: "repo access",
      ok: true,
      detail: `the installation can read ${repo.owner}/${repo.name}`,
    };
  if (r.status === 404) {
    return {
      name: "repo access",
      ok: false,
      detail:
        `the App is installed on ${repo.owner} but ${repo.owner}/${repo.name} is not among the selected repositories — ` +
        "open the App's Install/Configure page, add the repo, then run this step again",
    };
  }
  return {
    name: "repo access",
    ok: false,
    detail: `could not read ${repo.owner}/${repo.name} through the installation (${apiError(r)})`,
  };
}

/** Idempotent by construction: an existing label is a SUCCESS. */
export async function ensureLabel(
  fetchFn: typeof fetch,
  apiBase: string,
  token: string,
  repo: RepoSlug,
  label: { name: string; color: string; description: string },
  create: boolean,
): Promise<CheckResult> {
  const base = `${apiBase}/repos/${repo.owner}/${repo.name}/labels`;
  const auth = { authorization: `Bearer ${token}` };
  const existing = await api(fetchFn, `${base}/${encodeURIComponent(label.name)}`, {
    headers: auth,
  });
  if (existing.status === 200)
    return {
      name: `label "${label.name}"`,
      ok: true,
      detail: "already present — left exactly as it is",
    };
  if (existing.status !== 404) {
    return {
      name: `label "${label.name}"`,
      ok: false,
      detail: `could not read the label (${apiError(existing)})`,
    };
  }
  if (!create)
    return {
      name: `label "${label.name}"`,
      ok: false,
      detail: "missing from the repo — run the GitHub App step to create it",
    };
  const created = await api(fetchFn, base, {
    method: "POST",
    headers: { ...auth, "content-type": "application/json" },
    body: JSON.stringify({ name: label.name, color: label.color, description: label.description }),
  });
  if (created.status === 201) return { name: `label "${label.name}"`, ok: true, detail: "created" };
  // 422 is either "already_exists" (someone, or a parallel run, got there
  // first) or a validation failure (e.g. an over-long configured name) that
  // leaves the repo without it. Only a re-read tells them apart.
  if (created.status === 422) {
    const reread = await api(fetchFn, `${base}/${encodeURIComponent(label.name)}`, {
      headers: auth,
    });
    if (reread.status === 200)
      return {
        name: `label "${label.name}"`,
        ok: true,
        detail: "already existed at creation time — treated as success",
      };
  }
  return {
    name: `label "${label.name}"`,
    ok: false,
    detail: `could not create the label (${apiError(created)})`,
  };
}

// ---- step options -----------------------------------------------------------

export interface GithubAppStepOptions {
  /** Repo root holding deploy/github-app-manifest.json; default: the parent of
   * the engine's stateDir (`<root>/state`). */
  repoRoot?: string;
  /** Secrets dir; default: the recorded choice, then QC_SECRETS_DIR, then the
   * install locator's answer (`<config home>/secrets`). */
  secretsDir?: string;
  apiBase?: string;
  githubBase?: string;
  callbackPort?: number;
  callbackTimeoutMs?: number;
  installPollAttempts?: number;
  installPollIntervalMs?: number;
  sleep?: (ms: number) => Promise<void>;
  serveCallback?: CallbackServerFactory;
  /** Random hex source (state token + name suffix). */
  randomToken?: (bytes: number) => string;
  /** Try to open the operator's browser at the page (best effort, never fatal). */
  openBrowser?: boolean;
}

interface Resolved {
  root: string;
  secretsDir: string;
  apiBase: string;
  githubBase: string;
  repo: RepoSlug;
  labels: Array<{ name: string; color: string; description: string }>;
}

function resolveLabels(ctx: StepContext): Resolved["labels"] {
  const config = readTextOrNull(ctx.adapters.paths.configPath);
  const recorded = (ctx.choices[CHOICE_KEYS.labels] ?? {}) as Partial<
    Record<keyof typeof DEFAULT_LABELS, unknown>
  >;
  return LABEL_META.map((meta) => {
    const configKey = {
      trigger: "trigger_label",
      in_progress: "in_progress_label",
      reviewed: "reviewed_label",
    }[meta.key];
    const override =
      (config !== null ? readTomlKey(config, "github", configKey) : null) ?? recorded[meta.key];
    return {
      name:
        typeof override === "string" && override.trim()
          ? override.trim()
          : DEFAULT_LABELS[meta.key],
      color: meta.color,
      description: meta.description,
    };
  });
}

// ---- the step ---------------------------------------------------------------

export function githubAppStep(opts: GithubAppStepOptions = {}): OnboardingStep {
  const apiBase = opts.apiBase ?? "https://api.github.com";
  const githubBase = opts.githubBase ?? "https://github.com";
  const serve = opts.serveCallback ?? nodeCallbackServer;
  const sleep = opts.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const token = opts.randomToken ?? ((bytes: number) => randomBytes(bytes).toString("hex"));
  const callbackTimeoutMs = opts.callbackTimeoutMs ?? 10 * 60_000;
  const pollAttempts = opts.installPollAttempts ?? 40;
  const pollIntervalMs = opts.installPollIntervalMs ?? 15_000;

  function resolveInputs(ctx: StepContext): Resolved | string {
    // Config first, like the labels: a repository edited straight into
    // config.toml is the one the daemon watches, so it is the one verified.
    const config = readTextOrNull(ctx.adapters.paths.configPath);
    const repo =
      parseRepoSlug(config !== null ? readTomlKey(config, "github", "repo") : null) ??
      parseRepoSlug(ctx.choices[CHOICE_KEYS.repo]);
    if (!repo) {
      // Reachable only when the interview genuinely has not run (or its answer
      // is unusable): CONFIG_FILL_STEP_ID is the step that records this key,
      // and it is order 35 against this step's 40. Say which step, not just
      // which key — a refusal that names a choice nobody can set by hand is
      // a dead end.
      return (
        `no reviewed repo recorded — the "${CHOICE_KEYS.repo}" choice must hold "owner/name" before the App can be ` +
        `created or verified. Fix: run the ${CONFIG_FILL_STEP_ID} step (the interview) first; it asks for the repository ` +
        "and records it for this step."
      );
    }
    // The one resolution every step uses: config.toml, then the recorded
    // choice, then $QC_SECRETS_DIR, then the install locator.
    const secretsDir = opts.secretsDir ?? secretsDirFor(ctx.adapters, ctx.choices);
    const root = opts.repoRoot ?? sandboxRoot(ctx.adapters.paths);
    return {
      root,
      secretsDir: isAbsolute(secretsDir) ? secretsDir : join(root, secretsDir),
      apiBase,
      githubBase,
      repo,
      labels: resolveLabels(ctx),
    };
  }

  /** The App name the operator supplied — this call's input first, then what an
   * earlier call recorded. "" means nothing was supplied. */
  function chosenAppName(ctx: StepContext): string {
    for (const raw of [ctx.input.app_name, ctx.choices[CHOICE_KEYS.appName]]) {
      if (typeof raw === "string" && raw.trim()) return raw.trim();
    }
    return "";
  }

  function log(ctx: StepContext, line: string): void {
    ctx.adapters.log?.(`github_app: ${line}`);
  }

  /** The org caveat, stated wherever the target is an org — informational,
   * never a failure: the label trigger works fully without members:read
   * (only the review-TEAM trigger needs it), so onboarding never blocks on an
   * organization owner's approval. */
  function orgCaveat(target: AppTarget | null): CheckResult {
    if (target === null)
      return {
        name: "org approval",
        ok: true,
        detail:
          "App target is unknown (not recorded) — check its settings for organization approval; the label trigger works without the optional members:read permission",
      };
    if (target?.kind !== "org") {
      return {
        name: "org approval",
        ok: true,
        detail: "personal-account App — no organization approval is involved",
      };
    }
    return {
      name: "org approval",
      ok: true,
      detail:
        `the manifest requests the organization permission members:read, which an owner of "${target.login}" must approve. ` +
        "That approval is DEFERRABLE and nothing here waits for it: it only powers the optional review-team trigger. " +
        "The label trigger — the default way to ask for a review — works fully without it.",
    };
  }

  /** Everything that can be checked against reality, with no creation. Shared
   * by run() (called first, so a configured install verifies instead of
   * re-creating) and verify(). */
  async function verifyCore(
    ctx: StepContext,
    r: Resolved,
    createLabels: boolean,
  ): Promise<CheckResult[]> {
    const checks: CheckResult[] = [];
    const creds = readCredentials(r.secretsDir);
    if (!creds.complete) {
      checks.push({ name: "credentials", ok: false, detail: creds.problems.join("; ") });
      return checks;
    }
    checks.push({
      name: "credentials",
      ok: true,
      detail: `app_id ${creds.appId}, app.pem (${creds.pem!.length} bytes) and webhook_secret present and parseable in ${r.secretsDir}`,
    });

    const jwt = mintAppJwt(creds.appId!, creds.pem!, () => ctx.adapters.clock().getTime());
    const app = await api(ctx.adapters.fetch, `${r.apiBase}/app`, {
      headers: { authorization: `Bearer ${jwt}` },
    });
    if (app.status !== 200) {
      checks.push({
        name: "app reachable",
        ok: false,
        detail: `GET /app with the App JWT failed (${apiError(app)}) — the App id and private key must belong to the same App`,
      });
      return checks;
    }
    const meta = app.body as {
      id?: number;
      slug?: string;
      owner?: { login?: string; type?: string };
    };
    if (String(meta.id) !== creds.appId) {
      checks.push({
        name: "app reachable",
        ok: false,
        detail: `the private key belongs to App ${meta.id}, but app_id says ${creds.appId}`,
      });
      return checks;
    }
    checks.push({
      name: "app reachable",
      ok: true,
      detail: `App "${meta.slug ?? creds.appId}" (id ${meta.id}) answers to its own JWT`,
    });
    if (typeof meta.slug === "string" && meta.slug) {
      ctx.recordChoice(CHOICE_KEYS.appSlug, meta.slug);
      ctx.recordChoice(CHOICE_KEYS.botLogin, botLoginFor(meta.slug));
    }
    ctx.recordChoice(CHOICE_KEYS.appId, creds.appId);

    const found = await findInstallation(ctx.adapters.fetch, r.apiBase, jwt, r.repo.owner);
    if (found.status === "error") {
      // Its own name, never "installation": a lookup that failed is not an
      // App that is not installed, and waiting for an Install click cannot
      // fix it — the install poll returns on it at once, cause intact.
      checks.push({ name: "installation lookup", ok: false, detail: found.detail });
      return checks;
    }
    if (found.status === "none") {
      checks.push({
        name: "installation",
        ok: false,
        detail:
          `the App is not installed on "${r.repo.owner}" yet — open the App's page, choose Install App, pick ${r.repo.owner}, ` +
          `select "Only select repositories" and add ${r.repo.name}, then run this step again`,
      });
      return checks;
    }
    checks.push({
      name: "installation",
      ok: true,
      detail: `installation ${found.id} on ${r.repo.owner}`,
    });
    ctx.recordChoice(CHOICE_KEYS.installationId, found.id);

    const minted = await installationToken(ctx.adapters.fetch, r.apiBase, jwt, found.id);
    if ("error" in minted) {
      checks.push({ name: "installation token", ok: false, detail: minted.error });
      return checks;
    }
    checks.push({
      name: "installation token",
      ok: true,
      detail: "the App JWT exchanges for an installation token",
    });

    const covered = await repoCovered(ctx.adapters.fetch, r.apiBase, minted.token, r.repo);
    checks.push(covered);
    if (!covered.ok) return checks;

    for (const label of r.labels) {
      checks.push(
        await ensureLabel(ctx.adapters.fetch, r.apiBase, minted.token, r.repo, label, createLabels),
      );
    }
    return checks;
  }

  /** Choice > prompter > owner-type probe. The result is recorded, so the
   * question is asked at most once. */
  async function resolveTarget(ctx: StepContext, r: Resolved): Promise<AppTarget> {
    const recorded = parseTargetChoice(ctx.choices[CHOICE_KEYS.appTarget]);
    if (recorded) return recorded;

    const prompter = ctx.adapters.prompter;
    if (prompter) {
      const answer = await prompter(
        `Register the GitHub App under your personal account, or under an organization? ` +
          `Answer "personal", or the organization login (e.g. "${r.repo.owner}").`,
      );
      const trimmed = answer.trim();
      const parsed =
        parseTargetChoice(trimmed) ??
        (trimmed && trimmed !== "personal" ? { kind: "org", login: trimmed } : null);
      if (parsed) {
        ctx.recordChoice(CHOICE_KEYS.appTarget, formatTarget(parsed));
        return parsed;
      }
    }

    const probe = await api(ctx.adapters.fetch, `${r.apiBase}/users/${r.repo.owner}`);
    const type = (probe.body as { type?: string } | null)?.type;
    const derived: AppTarget =
      type === "Organization" ? { kind: "org", login: r.repo.owner } : { kind: "personal" };
    if (probe.status !== 200) {
      log(
        ctx,
        `could not read the owner type of "${r.repo.owner}" (${apiError(probe)}) — assuming a personal account. ` +
          `Record the "${CHOICE_KEYS.appTarget}" choice as "org:<login>" to override.`,
      );
    }
    ctx.recordChoice(CHOICE_KEYS.appTarget, formatTarget(derived));
    return derived;
  }

  /** Serve the page, wait for the code, exchange it, land the credentials. */
  async function createApp(
    ctx: StepContext,
    r: Resolved,
    target: AppTarget,
  ): Promise<CheckResult[]> {
    let manifest: AppManifest;
    try {
      manifest = loadManifest(r.root);
    } catch (err) {
      return [
        {
          name: "manifest",
          ok: false,
          detail: `could not read the pinned manifest: ${String(err)}`,
        },
      ];
    }

    // The operator's own App name: this step's `app_name` INPUT (its tool
    // parameter), or what an earlier call recorded. Absent means the suggested
    // uniqueness-suffixed name, which stays editable on GitHub's own page.
    const chosenName = chosenAppName(ctx);
    if (chosenName) ctx.recordChoice(CHOICE_KEYS.appName, chosenName);
    const name = chosenName || suggestAppName(manifest.name, token(3));
    const webhookUrl =
      typeof ctx.choices[CHOICE_KEYS.webhookUrl] === "string"
        ? (ctx.choices[CHOICE_KEYS.webhookUrl] as string).trim()
        : "";
    const state = token(16);

    // The page can only be rendered once the port is known (the manifest's
    // redirect_url must name the port actually bound), so the listener builds
    // it from its own bound address.
    let listener: CallbackListener;
    try {
      listener = await serve({
        state,
        port: opts.callbackPort ?? DEFAULT_CALLBACK_PORT,
        timeoutMs: callbackTimeoutMs,
        page: (bound) =>
          manifestPageHtml({
            postUrl: appCreationUrl(target, r.githubBase),
            state,
            target,
            manifest: renderManifest(manifest, {
              name,
              redirectUrl: bound.redirectUrl,
              webhookUrl: webhookUrl || undefined,
            }),
          }),
      });
    } catch (err) {
      return [
        {
          name: "callback listener",
          ok: false,
          detail: `could not listen on loopback for the GitHub callback: ${String(err)}`,
        },
      ];
    }

    try {
      log(ctx, `open ${listener.url} in your browser and click "Create the App on GitHub".`);
      log(
        ctx,
        `it creates "${name}" under ${formatTarget(target)}; you can rename it on GitHub's own page.`,
      );
      if (!webhookUrl)
        log(
          ctx,
          `the webhook URL is the manifest placeholder (${manifest.hook_attributes.url}) — no fixed hostname was recorded by the ingress step. ` +
            "A rotating tunnel's daemon re-points it itself; under polling nothing is delivered; for any other endpoint, set it on the App's settings page.",
        );
      if (opts.openBrowser) {
        const opener = process.platform === "darwin" ? "open" : "xdg-open";
        await ctx.adapters.runner.run(opener, [listener.url]).catch(() => undefined);
      }

      const arrival = await listener.waitForCode();
      if (!arrival.code) {
        return [
          {
            name: "manifest exchange",
            ok: false,
            detail:
              `${arrival.detail} — no credentials were saved. Whether GitHub created the App is not known from here: if ` +
              "you clicked Create on GitHub's page, check your GitHub App settings and delete an App this run left behind " +
              "before retrying. Run this step again: it serves a fresh page with a fresh one-time code (GitHub's codes are " +
              "single-use and expire after an hour).",
          },
        ];
      }

      const converted = await convertManifestCode(ctx.adapters.fetch, r.apiBase, arrival.code);
      if (!converted.ok) {
        return [{ name: "manifest exchange", ok: false, detail: converted.detail }];
      }

      const problems = writeCredentials(r.secretsDir, {
        appId: String(converted.app.id),
        pem: converted.app.pem,
        webhookSecret: converted.app.webhook_secret,
      });
      if (problems.length > 0) {
        return [
          {
            name: "credentials",
            ok: false,
            detail: `GitHub's conversion response did not validate: ${problems.join("; ")}`,
          },
        ];
      }
      ctx.recordChoice(CHOICE_KEYS.appId, String(converted.app.id));
      if (converted.app.slug) {
        ctx.recordChoice(CHOICE_KEYS.appSlug, converted.app.slug);
        ctx.recordChoice(CHOICE_KEYS.botLogin, botLoginFor(converted.app.slug));
      }
      if (converted.app.html_url) ctx.recordChoice(CHOICE_KEYS.appHtmlUrl, converted.app.html_url);
      log(
        ctx,
        `App ${converted.app.id} created; id, private key and webhook secret written to ${r.secretsDir} (0600). Nothing was pasted by hand.`,
      );
      return [
        {
          name: "manifest exchange",
          ok: true,
          detail: `App ${converted.app.id}${converted.app.slug ? ` ("${converted.app.slug}")` : ""} created; app_id, app.pem and webhook_secret written to ${r.secretsDir}`,
        },
      ];
    } finally {
      await listener.close();
    }
  }

  /**
   * The guided install click, then verification through the App's own
   * installation listing — bounded polling with a progress line per attempt.
   * Only a MISSING INSTALLATION is worth waiting for; any other red check
   * (network, wrong key, unselected repo) returns immediately with its own
   * plain guidance rather than burning the budget. Labels are created on the
   * way through, idempotently, by verifyCore's create pass.
   */
  async function pollInstallAndLabels(
    ctx: StepContext,
    r: Resolved,
    initial?: CheckResult[],
  ): Promise<CheckResult[]> {
    const appHtmlUrl =
      typeof ctx.choices[CHOICE_KEYS.appHtmlUrl] === "string"
        ? (ctx.choices[CHOICE_KEYS.appHtmlUrl] as string)
        : null;
    let announced = false;
    let checks: CheckResult[] = [];
    for (let attempt = 1; attempt <= pollAttempts; attempt += 1) {
      // `initial` is the caller's own just-taken reading — never re-taken, so
      // the poll budget counts attempts, not round-trips.
      checks = attempt === 1 && initial ? initial : await verifyCore(ctx, r, true);
      if (checks.every((c) => c.ok)) return checks;
      const blocker = checks.find((c) => !c.ok)!;
      if (blocker.name !== "installation") return checks;
      if (!announced) {
        announced = true;
        log(
          ctx,
          `now install the App on ${r.repo.owner}/${r.repo.name}: ${appHtmlUrl ? `${appHtmlUrl} → ` : ""}Install App → ${r.repo.owner} → ` +
            `"Only select repositories" → ${r.repo.name}.`,
        );
        log(
          ctx,
          `checking for it up to ${pollAttempts} times, ${Math.round(pollIntervalMs / 1000)}s apart — this never waits forever.`,
        );
      }
      log(
        ctx,
        `installation not visible yet (attempt ${attempt}/${pollAttempts}) — still waiting for the Install click.`,
      );
      if (attempt < pollAttempts) await sleep(pollIntervalMs);
    }
    return [
      ...checks.filter((c) => c.name !== "installation"),
      {
        name: "installation",
        ok: false,
        detail:
          `no installation on "${r.repo.owner}" appeared while waiting — the App exists and its credentials are saved, so nothing is lost. ` +
          "Install it on the repo (Install App → Only select repositories) and run this step again; it will verify, not re-create.",
      },
    ];
  }

  return {
    id: GITHUB_APP_STEP_ID,
    title: "GitHub App: create, install, label",
    explain:
      "Creates your GitHub App in one click. The wizard serves a page on your own machine that submits this repository's " +
      "pinned App manifest to GitHub — the permissions and webhook events come from the same artifact the tests pin, so there is " +
      "nothing to transcribe. GitHub sends the App id, private key and webhook secret straight back to the wizard, which stores " +
      "them 0600 in your secrets dir: no credential ever passes through your clipboard. Then you click Install on your repo, the " +
      "wizard verifies the installation through the App's own listing, and creates the trigger labels. If the App already exists " +
      "and is installed, running this again just verifies it.",
    // 40: after preflight (10), the topology/auth questions (20/30) and the
    // ingress step (39), whose recorded webhook URL goes into the manifest;
    // before the bring-up steps.
    order: 40,
    // The reviewed repo is NOT a parameter: it is the interview's answer, read
    // from the checklist (CHOICE_KEYS.repo). The only thing the operator may
    // supply here is what nothing else can derive — the App's display name.
    parameters: {
      type: "object",
      properties: {
        app_name: {
          type: "string",
          description:
            "The GitHub App's display name. Omit to have the wizard suggest a globally-unique one (still editable on " +
            "GitHub's page). Ignored when the App already exists.",
        },
      },
    },

    async run(ctx): Promise<StepReport> {
      const resolved = resolveInputs(ctx);
      if (typeof resolved === "string")
        return { ok: false, checks: [{ name: "inputs", ok: false, detail: resolved }] };
      const r = resolved;

      // Resume/verify-only: everything already in place ⇒ never re-create.
      const existing = readCredentials(r.secretsDir);
      if (existing.complete) {
        log(
          ctx,
          `credentials already present in ${r.secretsDir} — verifying the existing App instead of creating another one.`,
        );
        const checks = await verifyCore(ctx, r, true);
        if (checks.every((c) => c.ok)) {
          checks.push(orgCaveat(parseTargetChoice(ctx.choices[CHOICE_KEYS.appTarget])));
          return { ok: true, checks, data: { created: false, verified: true } };
        }
        const target = parseTargetChoice(ctx.choices[CHOICE_KEYS.appTarget]);
        // Only a missing INSTALLATION is worth waiting on; anything else
        // (network, wrong key, unselected repo) is reported as itself.
        if (checks.find((c) => !c.ok)!.name !== "installation") {
          checks.push(orgCaveat(target));
          return { ok: false, checks, data: { created: false } };
        }
        // Credentials exist but the install is missing: guide the install
        // click and poll — still no re-creation.
        const polled = await pollInstallAndLabels(ctx, r, checks);
        polled.push(orgCaveat(target));
        return { ok: polled.every((c) => c.ok), checks: polled, data: { created: false } };
      }

      const target = await resolveTarget(ctx, r);
      const created = await createApp(ctx, r, target);
      // A creation lands all three files, so surviving ones of an incomplete
      // set are replaced by the new App's: say so.
      const surviving = (
        [
          [SECRET_FILES.appId, existing.appId],
          [SECRET_FILES.pem, existing.pem],
          [SECRET_FILES.webhookSecret, existing.webhookSecret],
        ] as const
      )
        .filter(([, value]) => value !== null)
        .map(([name]) => name);
      if (surviving.length > 0)
        created.unshift({
          name: "credentials replaced",
          ok: true,
          detail:
            `${r.secretsDir} held an incomplete credential set (${existing.problems.join("; ")}); ` +
            `${surviving.join(", ")} ${surviving.length === 1 ? "was" : "were"} replaced by the new App's credentials if its creation succeeded`,
        });
      if (!created.every((c) => c.ok)) {
        created.push(orgCaveat(target));
        return { ok: false, checks: created };
      }

      const polled = await pollInstallAndLabels(ctx, r);
      const checks = [...created, ...polled, orgCaveat(target)];
      return {
        ok: checks.every((c) => c.ok),
        checks,
        data: { created: true, app_id: ctx.choices[CHOICE_KEYS.appId] ?? null },
      };
    },

    async verify(ctx): Promise<StepReport> {
      const resolved = resolveInputs(ctx);
      if (typeof resolved === "string")
        return { ok: false, checks: [{ name: "inputs", ok: false, detail: resolved }] };
      // verify NEVER creates: a missing label is red here and fixed by a run.
      const checks = await verifyCore(ctx, resolved, false);
      checks.push(orgCaveat(parseTargetChoice(ctx.choices[CHOICE_KEYS.appTarget])));
      return { ok: checks.every((c) => c.ok), checks };
    },
  };
}
