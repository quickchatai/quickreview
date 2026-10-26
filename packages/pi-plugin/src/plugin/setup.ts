// /qcr-setup: what the plugin needs, checked and printed as a list.
//
//   pi        the running pi is inside the plugin's declared range
//   login     pi has a login for every provider the review runs on (only a
//             key for another provider is a failure, with the /login hint)
//   git       git is on PATH (every review target is a git one)
//   GitHub    a credential for PR targets: GH_TOKEN or GITHUB_TOKEN set, or
//             `gh` logged in (only their presence is read, never a value)
//   qcr       the qcr CLI is on PATH (/qcr-scan runs it); when it
//             is missing, the person is offered `npm i -g` of it, and it runs
//             only on their yes
import { assetRoot } from "../assetroot.js";
import { contextFrom } from "../engine/context.js";
import { homeProfilePlaces, loadOneShotConfig } from "../homes.js";
import type { CoreConfig } from "../reviewconfig.js";
import { noLoginHint, reviewProviders } from "./login.js";
import { QCR_PACKAGE } from "./scan.js";
import type { PluginHost, SessionUi } from "./session.js";
import { piGate } from "./versiongate.js";

export type CheckState = "ok" | "warn" | "fail";

export interface SetupCheck {
  name: string;
  state: CheckState;
  detail: string;
}

const MARK: Record<CheckState, string> = { ok: "✓", warn: "!", fail: "✗" };

export function renderChecks(checks: readonly SetupCheck[]): string {
  const bad = checks.filter((c) => c.state === "fail").length;
  return [
    "QuickReview setup",
    "",
    ...checks.map((c) => `- ${MARK[c.state]} **${c.name}** — ${c.detail}`),
    "",
    bad === 0 ? "Ready." : `${bad} check${bad === 1 ? "" : "s"} failed.`,
  ].join("\n");
}

/** The review's config as /qcr-review would load it; null (with why) when it
 * cannot be read. */
function reviewConfig(host: PluginHost, root: () => string): CoreConfig | string {
  try {
    const env = { ...host.env, HOME: host.home };
    const r = root();
    const loaded = loadOneShotConfig({ root: r, env });
    return contextFrom(r, loaded, loaded.cfg.review.profile, "", {
      homes: homeProfilePlaces(env),
    }).cfg;
  } catch (err) {
    return err instanceof Error ? err.message : String(err);
  }
}

/** Every check, and the qcr install when the person says yes. */
export async function runSetupChecks(
  host: PluginHost,
  ui: SessionUi,
  o: { range: string; root?: () => string },
): Promise<SetupCheck[]> {
  const checks: SetupCheck[] = [];
  const gate = piGate(host.piVersion, o.range);
  checks.push({
    name: "pi version",
    state: gate === null ? "ok" : "fail",
    detail: gate ?? `pi ${host.piVersion}, inside ${o.range}`,
  });

  const cfg = reviewConfig(host, o.root ?? assetRoot);
  if (typeof cfg === "string") checks.push({ name: "config", state: "fail", detail: cfg });
  else {
    const logins = host.auth.logins();
    const missing = reviewProviders(cfg).filter(
      (p) => logins[p]?.type !== "oauth" && !host.auth.configured(p),
    );
    const keyed = Object.entries(logins)
      .filter(([, l]) => l.type === "api_key")
      .map(([name]) => name);
    checks.push(
      missing.length === 0
        ? {
            name: "login",
            state: "ok",
            detail: `pi can reach ${reviewProviders(cfg).join(", ")}, the providers the review runs on`,
          }
        : {
            name: "login",
            state: "fail",
            detail: noLoginHint(
              missing[0]!,
              keyed.filter((k) => !missing.includes(k)),
            ),
          },
    );
  }

  const git = host.runner.which("git");
  checks.push(
    git === null
      ? { name: "git", state: "fail", detail: "git is not on PATH: every review reads a git repo" }
      : { name: "git", state: "ok", detail: git },
  );

  const tokenEnv = ["GH_TOKEN", "GITHUB_TOKEN"].find((k) => (host.env[k] ?? "").trim() !== "");
  let github: SetupCheck;
  if (tokenEnv !== undefined)
    github = { name: "GitHub", state: "ok", detail: `${tokenEnv} is set (for PR targets)` };
  else {
    const gh = host.runner.which("gh");
    const loggedIn =
      gh !== null &&
      (await host.runner.run(gh, ["auth", "status"], { cwd: host.cwd, env: host.env })).code === 0;
    github = loggedIn
      ? { name: "GitHub", state: "ok", detail: "gh is logged in (for PR targets)" }
      : {
          name: "GitHub",
          state: "warn",
          detail:
            "no GH_TOKEN, no GITHUB_TOKEN and no `gh auth login`: branch and uncommitted reviews work, a PR target needs one of them",
        };
  }
  checks.push(github);

  let qcr = host.runner.which("qcr");
  if (qcr === null && ui.interactive) {
    const yes = await ui.confirm(
      "QuickReview",
      `/qcr-scan runs the qcr CLI, which is not on PATH. Install it now with \`npm i -g ${QCR_PACKAGE}\`?`,
      host.shutdown,
    );
    if (yes) {
      const npm = host.runner.which("npm");
      if (npm === null)
        checks.push({
          name: "qcr",
          state: "fail",
          detail: "npm is not on PATH, so qcr cannot be installed from here",
        });
      else {
        ui.status(`QuickReview: npm i -g ${QCR_PACKAGE}…`);
        const r = await host.runner.run(npm, ["i", "-g", QCR_PACKAGE], {
          cwd: host.cwd,
          env: host.env,
          signal: host.shutdown,
        });
        ui.status(undefined);
        if (r.code !== 0)
          checks.push({
            name: "qcr",
            state: "fail",
            detail: `npm i -g ${QCR_PACKAGE} failed: ${(r.stderr.trim() || r.stdout.trim()).split("\n").slice(-2).join(" ")}`,
          });
        qcr = host.runner.which("qcr");
      }
    }
  }
  if (!checks.some((c) => c.name === "qcr"))
    checks.push(
      qcr !== null
        ? { name: "qcr", state: "ok", detail: qcr }
        : {
            name: "qcr",
            state: "fail",
            detail: `not on PATH: /qcr-scan needs it. Install it with \`npm i -g ${QCR_PACKAGE}\`.`,
          },
    );
  return checks;
}

/** /qcr-setup. */
export async function runSetupCommand(
  host: PluginHost,
  ui: SessionUi,
  o: { range: string; root?: () => string },
): Promise<void> {
  const text = renderChecks(await runSetupChecks(host, ui, o));
  if (ui.mode === "print") ui.print(text);
  else ui.show(text);
}
