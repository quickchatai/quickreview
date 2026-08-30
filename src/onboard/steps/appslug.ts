// App-slug reconciliation (inherited obligation ① from the ticket's
// note) — the one defect in the onboarding order that nothing else catches.
//
// THE PROBLEM. config_fill (order 35) runs BEFORE the App exists, because the
// App step reads the reviewed repo config_fill records. So config_fill asks the
// operator for the App slug up front and DERIVES `[github] bot_login` from it
// (`<slug>[bot]`, the derivable). The App's REAL slug is only known
// after creation: GitHub suffixes the name for global uniqueness, and the
// operator can edit it on GitHub's own creation page — and can rename the App
// at any time afterwards, which moves the slug again.
//
// WHY IT MATTERS, in one line: `bot_login` is how the daemon recognises ITS OWN
// reviews and comments. Get it wrong and posting-guard ① reads the bot's own
// review as a non-author human approval, the ping-pong path mistakes its own
// comments for the author's, and the backfill identity (which cascades off
// [github]) imports someone else's history. Nothing else in the system checks
// it: every one of those paths is happy with a login that simply never matches.
//
// THE FIX. After the App exists, ask the App itself (`GET /app` with the App
// JWT — the App's own identity, no installation token, no personal credential)
// and reconcile the answer against config.toml, correcting `[github] app_slug`
// and `[github] bot_login` when they disagree. The live answer wins over both
// the file and the checklist's recorded choice: a rename after creation is
// exactly the case a record cannot see.
//
// This runs BEFORE bring-up (order 65) because the daemon reads config.toml
// once, at boot — and if the stack is somehow already running when a correction
// lands, the step restarts it rather than leaving a live daemon on a stale
// login.
//
// Rule 1 is structural here as it is in config_fill: every edit this step makes
// goes through `assertNoDryRunEdit`, which refuses an edit naming `dry_run`
// however it is spelled. The ONLY file in this slice that writes that flag is
// golive.ts, and only on an explicit confirmation after a completed proof.
import { mintAppJwt } from "../../githubAuth.js";
import type { CheckResult, OnboardingStep, StepContext, StepReport } from "../engine.js";
import { configPath, readConfigText, rootOf, secretsDirFor, writeAtomic, type StreamRunner } from "./compose.js";
import { stackTransportFor } from "./transport.js";
import { assertNoDryRunEdit, changedEdits, patchToml, tomlString, type TomlEdit } from "./configfill.js";
import { APP_SLUG_CHOICE_KEY, BOT_LOGIN_CHOICE_KEY, readCredentials } from "./githubapp.js";

export const APP_SLUG_STEP_ID = "app_slug_reconcile";

export interface AppSlugStepOptions {
  apiBase?: string;
  secretsDir?: string;
  stream?: StreamRunner;
  env?: NodeJS.ProcessEnv;
}

/** The bot login GitHub gives an App with this slug. One rule, one place. */
export function botLoginFor(slug: string): string {
  return `${slug}[bot]`;
}

/**
 * The edits that make config.toml agree with the App's real slug. Empty when
 * the file already agrees — which is what makes a re-run a no-op rather than a
 * rewrite. Never returns an edit naming `dry_run` (asserted, not assumed).
 */
export function slugEdits(configText: string, slug: string): TomlEdit[] {
  const wanted: TomlEdit[] = [
    { section: "github", key: "app_slug", value: tomlString(slug) },
    { section: "github", key: "bot_login", value: tomlString(botLoginFor(slug)) },
  ];
  assertNoDryRunEdit(wanted);
  return changedEdits(configText, wanted);
}

interface AppIdentity {
  ok: boolean;
  slug: string;
  detail: string;
}

/** `GET /app` with the App's own JWT: the App's identity, from the App. */
async function liveIdentity(ctx: StepContext, apiBase: string, secretsDir: string): Promise<AppIdentity> {
  const creds = readCredentials(secretsDir);
  if (!creds.complete) {
    return {
      ok: false,
      slug: "",
      detail:
        `${creds.problems.join("; ")} — Fix: run the github_app step; it writes app_id, app.pem and webhook_secret into ${secretsDir}`,
    };
  }
  const jwt = mintAppJwt(creds.appId!, creds.pem!, () => ctx.adapters.clock().getTime());
  let status = 0;
  let body: unknown = null;
  try {
    const res = await ctx.adapters.fetch(`${apiBase}/app`, {
      headers: { accept: "application/vnd.github+json", authorization: `Bearer ${jwt}`, "user-agent": "quickreview-onboarding" },
    });
    status = res.status;
    const text = await res.text();
    try {
      body = text ? (JSON.parse(text) as unknown) : null;
    } catch {
      body = null;
    }
  } catch (err) {
    return {
      ok: false,
      slug: "",
      detail: `could not reach GitHub to ask the App who it is (${String(err)}) — Fix: check this machine's network, then run this step again`,
    };
  }
  if (status !== 200) {
    return {
      ok: false,
      slug: "",
      detail:
        `GET /app answered HTTP ${status} — Fix: the App id and private key in ${secretsDir} must belong to the same App; ` +
        "re-run the github_app step to re-create or re-verify them",
    };
  }
  const slug = (body as { slug?: unknown } | null)?.slug;
  if (typeof slug !== "string" || slug.trim() === "") {
    return { ok: false, slug: "", detail: "GitHub answered without a slug for this App — Fix: run this step again; if it repeats, re-run the github_app step" };
  }
  return { ok: true, slug: slug.trim(), detail: "" };
}

export function appSlugStep(opts: AppSlugStepOptions = {}): OnboardingStep {
  const apiBase = opts.apiBase ?? "https://api.github.com";

  async function reconcile(ctx: StepContext, write: boolean): Promise<StepReport> {
    const root = rootOf(ctx.adapters);
    const secretsDir = opts.secretsDir ?? secretsDirFor(root, ctx.choices, opts.env ?? process.env);
    const checks: CheckResult[] = [];

    const identity = await liveIdentity(ctx, apiBase, secretsDir);
    if (!identity.ok) {
      checks.push({ name: "app-identity", ok: false, detail: identity.detail });
      return { ok: false, checks };
    }
    const recorded = typeof ctx.choices[APP_SLUG_CHOICE_KEY] === "string" ? (ctx.choices[APP_SLUG_CHOICE_KEY] as string) : "";
    checks.push({
      name: "app-identity",
      ok: true,
      detail:
        `GitHub says this App's slug is "${identity.slug}"` +
        (recorded && recorded !== identity.slug
          ? ` — the wizard had recorded "${recorded}", so the App was renamed or uniqueness-suffixed after creation; GitHub wins`
          : ""),
    });

    const configText = readConfigText(root);
    if (configText === null) {
      checks.push({
        name: "config",
        ok: false,
        detail: `${configPath(root)} does not exist — Fix: run the config_fill step first; it creates the file this step corrects`,
      });
      return { ok: false, checks };
    }

    const edits = slugEdits(configText, identity.slug);
    if (edits.length === 0) {
      checks.push({
        name: "config",
        ok: true,
        detail: `[github] app_slug = "${identity.slug}" and bot_login = "${botLoginFor(identity.slug)}" already match the App — nothing rewritten`,
      });
    } else if (!write) {
      checks.push({
        name: "config",
        ok: false,
        detail:
          `config.toml disagrees with the App: ${edits.map((e) => `[${e.section}] ${e.key}`).join(", ")} — Fix: run the ` +
          `${APP_SLUG_STEP_ID} step, which corrects both to "${identity.slug}" / "${botLoginFor(identity.slug)}"`,
      });
      return { ok: false, checks };
    } else {
      writeAtomic(configPath(root), patchToml(configText, edits));
      checks.push({
        name: "config",
        ok: true,
        detail:
          `corrected ${edits.map((e) => `[${e.section}] ${e.key}`).join(", ")} to match the App: app_slug = "${identity.slug}", ` +
          `bot_login = "${botLoginFor(identity.slug)}". bot_login is how the daemon recognises its OWN reviews — a wrong one is ` +
          "invisible until the reviewer mistakes itself for a human",
      });
    }

    ctx.recordChoice(APP_SLUG_CHOICE_KEY, identity.slug);
    ctx.recordChoice(BOT_LOGIN_CHOICE_KEY, botLoginFor(identity.slug));

    // A correction only reaches a RUNNING daemon through a restart: the config
    // loader runs once, at boot.
    if (write && edits.length > 0) {
      // Whichever host the daemon lives on: `docker compose restart` here, the
      // deploy that ships the corrected config on the server route.
      const transport = stackTransportFor(ctx, opts.stream ? { stream: opts.stream } : {});
      const running = await transport.running();
      checks.push(await transport.restart((line) => ctx.adapters.log?.(`${APP_SLUG_STEP_ID}: ${line}`), running));
    }

    return { ok: checks.every((c) => c.ok), checks, data: { slug: identity.slug, bot_login: botLoginFor(identity.slug), corrected: edits.length > 0 } };
  }

  return {
    id: APP_SLUG_STEP_ID,
    title: "Reconcile the App's real slug into your config",
    explain:
      "Your GitHub App's slug is only settled once the App exists — GitHub makes the name globally unique and you can edit it " +
      "on GitHub's own page. The config was filled before that, and the login your reviews appear under is derived from the " +
      "slug, so this step asks the App itself who it is and corrects [github] app_slug and bot_login to match. It matters more " +
      "than it looks: bot_login is how the reviewer recognises its own reviews and comments, and a wrong one fails silently.",
    order: 65,
    async run(ctx): Promise<StepReport> {
      return reconcile(ctx, true);
    },
    async verify(ctx): Promise<StepReport> {
      // verify NEVER writes: a disagreement is red here and fixed by a run.
      return reconcile(ctx, false);
    },
  };
}
