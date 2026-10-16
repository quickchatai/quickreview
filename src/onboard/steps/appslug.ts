// App-slug reconciliation — the one defect in the onboarding order that
// nothing else catches.
//
// The problem: config_fill (order 35) runs before the App exists, because the
// App step reads the reviewed repo config_fill records. So config_fill asks the
// operator for the App slug up front and derives `[github] bot_login` from it
// (`<slug>[bot]`). The App's real slug is only known
// after creation: GitHub suffixes the name for global uniqueness, and the
// operator can edit it on GitHub's own creation page — and can rename the App
// at any time afterwards, which moves the slug again.
//
// Why it matters: `bot_login` is how the daemon recognises its own
// reviews and comments. Get it wrong and posting-guard ① reads the bot's own
// review as a non-author human approval, the ping-pong path mistakes its own
// comments for the author's, and the backfill identity (which cascades off
// [github]) imports someone else's history. Nothing else in the system checks
// it: every one of those paths is happy with a login that simply never matches.
//
// The fix: after the App exists, ask the App itself (`GET /app` with the App
// JWT — the App's own identity, no installation token, no personal credential)
// and reconcile the answer against config.toml, correcting `[github] app_slug`
// and `[github] bot_login` when they disagree. The live answer wins over both
// the file and the checklist's recorded choice: a rename after creation is
// exactly the case a record cannot see.
//
// This runs (order 65) before bring-up (order 70) because the daemon reads
// config.toml once, at boot — and if the stack is somehow already running when a correction
// lands, the step restarts it rather than leaving a live daemon on a stale
// login.
//
// The dry-run flag is out of reach here as it is in config_fill (CLAUDE.md
// rule 1): every edit this step makes goes through `assertNoDryRunEdit`, which
// refuses an edit naming `dry_run` however it is spelled. The only onboarding
// step that writes that flag is golive.ts, and only on an explicit
// confirmation after a completed proof.
import { mintAppJwt } from "../../githubAuth.js";
import type { CheckResult, OnboardingStep, StepContext, StepReport } from "../engine.js";
import {
  configPath,
  readConfigText,
  secretsDirFor,
  writeAtomic,
  type StreamRunner,
} from "./compose.js";
import { deliverConfigChange } from "./configdelivery.js";
import {
  assertNoDryRunEdit,
  changedEdits,
  patchToml,
  tomlString,
  type TomlEdit,
} from "./configfill.js";
import { CHOICE_KEYS, botLoginFor } from "../choices.js";
import { api, readCredentials } from "./githubapp.js";

export const APP_SLUG_STEP_ID = "app_slug_reconcile";

/** Step data: a correction is on disk that the daemon has not been restarted onto. */
const RESTART_OWED_KEY = "restart_owed";

export interface AppSlugStepOptions {
  apiBase?: string;
  secretsDir?: string;
  stream?: StreamRunner;
  env?: NodeJS.ProcessEnv;
}

export { botLoginFor };

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
async function liveIdentity(
  ctx: StepContext,
  apiBase: string,
  secretsDir: string,
): Promise<AppIdentity> {
  const creds = readCredentials(secretsDir);
  if (!creds.complete) {
    return {
      ok: false,
      slug: "",
      detail: `${creds.problems.join("; ")} — Fix: run the github_app step; it writes app_id, app.pem and webhook_secret into ${secretsDir}`,
    };
  }
  const jwt = mintAppJwt(creds.appId!, creds.pem!, () => ctx.adapters.clock().getTime());
  const { status, body, text } = await api(ctx.adapters.fetch, `${apiBase}/app`, {
    headers: { authorization: `Bearer ${jwt}` },
  });
  if (status === 0) {
    return {
      ok: false,
      slug: "",
      detail: `could not reach GitHub to ask the App who it is (${text}) — Fix: check this machine's network, then run this step again`,
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
    return {
      ok: false,
      slug: "",
      detail:
        "GitHub answered without a slug for this App — Fix: run this step again; if it repeats, re-run the github_app step",
    };
  }
  return { ok: true, slug: slug.trim(), detail: "" };
}

export function appSlugStep(opts: AppSlugStepOptions = {}): OnboardingStep {
  const apiBase = opts.apiBase ?? "https://api.github.com";

  async function reconcile(ctx: StepContext, write: boolean): Promise<StepReport> {
    const secretsDir =
      opts.secretsDir ?? secretsDirFor(ctx.adapters, ctx.choices, opts.env ?? process.env);
    const checks: CheckResult[] = [];

    const identity = await liveIdentity(ctx, apiBase, secretsDir);
    if (!identity.ok) {
      checks.push({ name: "app-identity", ok: false, detail: identity.detail });
      return { ok: false, checks };
    }
    const recorded =
      typeof ctx.choices[CHOICE_KEYS.appSlug] === "string"
        ? (ctx.choices[CHOICE_KEYS.appSlug] as string)
        : "";
    checks.push({
      name: "app-identity",
      ok: true,
      detail:
        `GitHub says this App's slug is "${identity.slug}"` +
        (recorded && recorded !== identity.slug
          ? ` — the wizard had recorded "${recorded}", so the App was renamed or uniqueness-suffixed after creation; GitHub wins`
          : ""),
    });

    const configText = readConfigText(ctx.adapters);
    if (configText === null) {
      checks.push({
        name: "config",
        ok: false,
        detail: `${configPath(ctx.adapters)} does not exist — Fix: run the config_fill step first; it creates the file this step corrects`,
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
      writeAtomic(configPath(ctx.adapters), patchToml(configText, edits));
      checks.push({
        name: "config",
        ok: true,
        detail:
          `corrected ${edits.map((e) => `[${e.section}] ${e.key}`).join(", ")} to match the App: app_slug = "${identity.slug}", ` +
          `bot_login = "${botLoginFor(identity.slug)}". bot_login is how the daemon recognises its OWN reviews — a wrong one is ` +
          "invisible until the reviewer mistakes itself for a human",
      });
    }

    ctx.recordChoice(CHOICE_KEYS.appSlug, identity.slug);
    ctx.recordChoice(CHOICE_KEYS.botLogin, botLoginFor(identity.slug));

    // A correction only reaches a running daemon through a restart: the config
    // loader runs once, at boot. The file is corrected before the restart, so
    // a restart that fails leaves a file that already agrees — the owed
    // restart is kept in the step's data and paid by the next run, never
    // forgotten because the edits came back empty.
    let restartOwed = edits.length > 0 || ctx.data[RESTART_OWED_KEY] === true;
    if (write && restartOwed) {
      const delivery = await deliverConfigChange(
        ctx,
        opts.stream ? { stream: opts.stream } : {},
        restartOwed,
        APP_SLUG_STEP_ID,
      );
      checks.push(...delivery.checks);
      restartOwed = delivery.restartOwed;
    } else if (restartOwed) {
      checks.push({
        name: "daemon-restart",
        ok: false,
        detail:
          "the corrected bot_login is on disk but the daemon was never restarted onto it, so a running daemon still holds " +
          `the old login — Fix: run the ${APP_SLUG_STEP_ID} step; it restarts the daemon`,
      });
    }

    return {
      ok: checks.every((c) => c.ok),
      checks,
      data: {
        slug: identity.slug,
        bot_login: botLoginFor(identity.slug),
        corrected: edits.length > 0,
        [RESTART_OWED_KEY]: restartOwed,
      },
    };
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
      // verify never writes: a disagreement is red here and fixed by a run.
      return reconcile(ctx, false);
    },
  };
}
