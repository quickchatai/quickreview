// Switch-on's login step: one OpenAI login per box. The daemon's
// container reviews on the login the home signed in to, the host pi home's
// auth.json, instead of a login of its own.
//
//   .env      QCR_PI_LOGIN_DIR = the home's pi agent dir. docker-compose.yml
//             mounts it at /opt/qcr/login and names it to the daemon
//             (QCR_LOGIN_DIR), so the refresher keeps that one file and every
//             worker borrows it; pi's settings stay in the container's own
//             pi home, never the person's.
//   config    [login_refresh] enabled = true, so the daemon runs its single
//             refresher on that file while auto-review runs. The config must
//             still load with it (its margin outlasts the longest worker
//             cap), or nothing is written.
//   restart   a stack brought up before is recreated, so the daemon has the
//             mount and reads the config at boot (its volumes, so its data,
//             are kept). A first switch-on's bring-up starts it this way.
//   proof     a stack brought up before keeps its image pin and its extracted
//             docker-compose.yml, which may be an older release's. So the
//             compose file must define the mount before anything is written,
//             and the running daemon must show it reviews on the login (its
//             QCR_LOGIN_DIR, the login in the mount, an image whose
//             refresher reads that dir) before the step says so. Until then
//             the step is not done, and the next switch-on runs it again.
//
// The hand-over needs nothing more: while the refresher runs it refreshes far
// ahead of pi's own window, so the home's pi, a borrower now, never has a
// token to refresh; switching auto-review off stops the daemon, the refresher
// with it, and the home's pi refreshes on its own again (src/home/loginowner.ts).
// The single-instance lock lives beside the shared auth.json, so a second
// refresher on this box is refused whoever starts it.
//
// A remote server (the advanced route) never gets this step: it signs in on
// its own device login, and the host's login is never copied there.
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { parse } from "smol-toml";
import { parseConfig } from "../../config.js";
import type {
  CheckResult,
  OnboardingStep,
  ProcessRunner,
  StepContext,
  StepReport,
} from "../engine.js";
import { CONTAINER_LOGIN_DIR, LOGIN_DIR_ENV } from "../../loginrefresh/supervisor.js";
import { BROUGHT_UP_CHOICE_KEY } from "./bringup.js";
import {
  DAEMON_SERVICE,
  composeArgs,
  daemonExec,
  readEnvText,
  releaseVersion,
  rootOf,
  writeAtomic,
} from "./compose.js";
import { assertNoDryRunEdit, patchToml, type TomlEdit } from "./configfill.js";
import { readEnvKey, setEnvKey } from "./ingress.js";
import { topologyOf } from "./topology.js";

export const LOGIN_SHARE_STEP_ID = "login_share";
/** The project .env key docker-compose.yml mounts the host's login from. */
export const PI_LOGIN_DIR_ENV = "QCR_PI_LOGIN_DIR";

export interface LoginShareOptions {
  /** The home's pi agent dir, where its login is. Absent: nothing is shared
   * and the daemon keeps a login of its own. */
  loginDir?: string;
}

const firstLine = (s: string): string => s.trim().split("\n")[0]?.trim() || "no output";
const message = (err: unknown): string => (err instanceof Error ? err.message : String(err));

/** Does the config run the refresher? null when it cannot be read. */
export function refresherEnabled(configText: string): boolean | null {
  try {
    const t = (parse(configText) as Record<string, unknown>)["login_refresh"];
    return (
      typeof t === "object" && t !== null && (t as Record<string, unknown>)["enabled"] === true
    );
  } catch {
    return null;
  }
}

/** The config with the refresher on; null when it is on already. */
export function refresherPatch(configText: string): string | null {
  if (refresherEnabled(configText) === true) return null;
  const edits: TomlEdit[] = [{ section: "login_refresh", key: "enabled", value: "true" }];
  assertNoDryRunEdit(edits);
  return patchToml(configText, edits);
}

const fail = (name: string, detail: string): StepReport => ({
  ok: false,
  checks: [{ name, ok: false, detail }],
});

/** The upgrade a stack too old for a shared login needs, said once. */
function upgradeFix(root: string): string {
  const version = releaseVersion(root);
  return (
    `Fix: update the stack in ${root} to a release with the shared login` +
    `${version ? ` (QCR_VERSION=${version} in its .env, and that release's docker-compose.yml)` : ""}, ` +
    "then switch auto-review on again"
  );
}

/** Does the project's docker-compose.yml mount a shared login? null when
 * there is no compose file yet (the bring-up places it, this release's). */
export function composeMountsLogin(root: string): boolean | null {
  let text: string;
  try {
    text = readFileSync(join(root, "docker-compose.yml"), "utf8");
  } catch {
    return null;
  }
  return text.includes(PI_LOGIN_DIR_ENV);
}

/** The running daemon, asked whether it reviews on the shared login: the
 * compose definition hands it the dir, the mount holds the login, and its
 * image's refresher reads that dir. Exit codes name which failed. */
export const DAEMON_LOGIN_PROBE = [
  "sh",
  "-c",
  `test "$${LOGIN_DIR_ENV}" = ${CONTAINER_LOGIN_DIR} || exit 3; ` +
    `test -s ${CONTAINER_LOGIN_DIR}/auth.json || exit 4; ` +
    `grep -q ${LOGIN_DIR_ENV} dist/src/loginrefresh/supervisor.js 2>/dev/null || exit 5`,
] as const;

/** Ask the running daemon (DAEMON_LOGIN_PROBE). A daemon that cannot be
 * asked is not one that reviews on the login: never claimed. */
export async function daemonLoginCheck(runner: ProcessRunner, root: string): Promise<CheckResult> {
  const r = await daemonExec(runner, root, DAEMON_LOGIN_PROBE);
  if (r.code === 0)
    return { name: "daemon", ok: true, detail: "the daemon reviews on your login, data kept" };
  const why =
    r.code === 3
      ? `the running daemon is not handed the login (its ${LOGIN_DIR_ENV} is not ${CONTAINER_LOGIN_DIR}): the stack's docker-compose.yml is an older release's`
      : r.code === 4
        ? `the running daemon sees no login at ${CONTAINER_LOGIN_DIR}: the stack's docker-compose.yml does not mount it`
        : r.code === 5
          ? "the running daemon's image predates the shared login: it would keep reviewing on a login of its own"
          : `can't ask the running daemon whether it reviews on your login: ${firstLine(r.stderr || r.stdout)}`;
  return { name: "daemon", ok: false, detail: `${why}. ${upgradeFix(root)}` };
}

export function loginShareStep(o: LoginShareOptions = {}): OnboardingStep {
  const state = async (ctx: StepContext): Promise<StepReport> => {
    if (o.loginDir === undefined)
      return {
        ok: true,
        checks: [{ name: "login", ok: true, detail: "no home login to share here" }],
      };
    const env = readEnvKey(readEnvText(rootOf(ctx.adapters)), PI_LOGIN_DIR_ENV);
    let config: string;
    try {
      config = readFileSync(ctx.adapters.paths.configPath, "utf8");
    } catch (err) {
      return fail("login", `can't read ${ctx.adapters.paths.configPath}: ${message(err)}`);
    }
    const checks: CheckResult[] = [
      env === o.loginDir
        ? { name: "login", ok: true, detail: `auto-review reviews on your login in ${o.loginDir}` }
        : {
            name: "login",
            ok: false,
            detail: `the stack does not mount your login (${PI_LOGIN_DIR_ENV} is ${env === null ? "unset" : JSON.stringify(env)})`,
          },
      refresherEnabled(config) === true
        ? { name: "refresher", ok: true, detail: "its refresher keeps the login fresh" }
        : { name: "refresher", ok: false, detail: "[login_refresh] is not enabled" },
    ];
    return { ok: checks.every((c) => c.ok), checks };
  };

  return {
    id: LOGIN_SHARE_STEP_ID,
    title: "Share your login with auto-review",
    explain:
      "Auto-review reviews on the OpenAI login this home signed in to: one login per machine, which its refresher keeps fresh while it runs.",
    // after the config steps (memory is 60), before the daemon starts (69)
    order: 66,
    enabled: (choices) => topologyOf(choices) === "local",
    async run(ctx): Promise<StepReport> {
      const dir = o.loginDir;
      if (dir === undefined) return state(ctx);
      const auth = join(dir, "auth.json");
      if (!existsSync(auth))
        return fail(
          "login",
          `there is no login at ${auth} yet: sign in in the home first, then switch auto-review on again`,
        );
      // compose expands `$` in an .env value and treats ` #` as a comment
      if (/[$\n]|\s#/.test(dir))
        return fail(
          "login",
          `${dir} can't be passed to Docker Compose through .env (a \`$\`, a newline or a space before #): set PI_CODING_AGENT_DIR to a plainer path`,
        );
      const configPath = ctx.adapters.paths.configPath;
      let config: string;
      try {
        config = readFileSync(configPath, "utf8");
      } catch (err) {
        return fail("refresher", `can't read ${configPath}: ${message(err)}`);
      }
      const patched = refresherPatch(config);
      if (patched !== null) {
        try {
          parseConfig(patched);
        } catch (err) {
          return fail(
            "refresher",
            `[login_refresh] enabled = true would not load in ${configPath}: ${message(err)} — nothing was written`,
          );
        }
      }
      const root = rootOf(ctx.adapters);
      if (composeMountsLogin(root) === false)
        return fail(
          "daemon",
          `${join(root, "docker-compose.yml")} is an older release's: it does not mount a shared login, so the daemon would keep a login of its own. Nothing was written. ${upgradeFix(root)}`,
        );
      const envText = readEnvText(root);
      const nextEnv = setEnvKey(envText, PI_LOGIN_DIR_ENV, dir);
      if (patched !== null) writeAtomic(configPath, patched);
      if (nextEnv !== envText) writeAtomic(join(root, ".env"), nextEnv);
      const checks: CheckResult[] = [
        {
          name: "login",
          ok: true,
          detail: `auto-review reviews on your login in ${dir}, and its refresher keeps it fresh while it runs`,
        },
      ];
      const changed = patched !== null || nextEnv !== envText;
      if (typeof ctx.choices[BROUGHT_UP_CHOICE_KEY] === "string") {
        if (changed) {
          // the mount and the config are read when the container starts
          const r = await ctx.adapters.runner.run(
            "docker",
            composeArgs(root, ["up", "-d", "--no-deps", "--force-recreate", DAEMON_SERVICE]),
          );
          if (r.code !== 0)
            return fail(
              "daemon",
              `\`docker compose up -d --force-recreate ${DAEMON_SERVICE}\` exited ${r.code}: ${firstLine(r.stderr || r.stdout)}`,
            );
        }
        // a stack brought up before says so itself, or the step is not done
        const daemon = await daemonLoginCheck(ctx.adapters.runner, root);
        checks.push(daemon);
        if (!daemon.ok) return { ok: false, checks };
      }
      return { ok: true, checks };
    },
    verify: state,
  };
}
