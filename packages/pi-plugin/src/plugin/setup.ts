// /qcr-setup: the plugin's setup checklist (../setupchecklist.ts), its own steps
// only, detected and printed as a list. The checklist lives in memory: every
// /qcr-setup detects afresh.
//
//   pi version     the running pi is inside the plugin's declared range
//   login          pi has a login for every provider the review runs on (only
//                  a key for another provider is missing, with the /login hint)
//   git            git is on PATH (every review target is a git one)
//   GitHub         a credential for PR targets: GH_TOKEN or GITHUB_TOKEN set,
//                  or `gh` logged in (only their presence is read, never a
//                  value). Optional: branch and uncommitted reviews need none.
//   repo profile   `.qcr/profile.toml` in this repo. Optional: a review runs on
//                  the shipped profile without one. Its run is Setup, on
//                  request: `/qcr-setup profile`, or yes to the offer after
//                  the list, hands this session's agent the Setup brief.
//
// Only what the plugin itself can do: nothing here installs anything. The app
// builds its own checklist from these steps plus its own (pluginSetupSteps
// onto its StepRegistry); a step it registers is never on this one.
import { existsSync } from "node:fs";
import { join } from "node:path";
import { assetRoot } from "../assetroot.js";
import {
  SetupChecklist,
  StepRegistry,
  type ChecklistAdapters,
  type Detection,
  type SetupStep,
  type StepReport,
  type StepStatusLine,
} from "../setupchecklist.js";
import { contextFrom } from "../engine/context.js";
import { homeProfilePlaces, loadOneShotConfig } from "../homes.js";
import { LENS_TUNING_KEYS } from "../lenstuning.js";
import { REPO_PROFILE_DIR, REPO_TOML_KEYS } from "../profileoverrides.js";
import type { CoreConfig } from "../reviewconfig.js";
import { SEVERITIES } from "../severityrank.js";
import { PASS_TIER_ORDER } from "../types.js";
import { noLoginHint, reviewProviders } from "./login.js";
import type { PluginHost, SessionUi } from "./session.js";
import { piGate } from "./versiongate.js";

/** The plugin's step ids, in their order on the checklist. */
export const PLUGIN_SETUP_STEPS = {
  pi: "pi_version",
  login: "pi_login",
  git: "git",
  github: "github_credential",
  profile: "repo_profile",
} as const;

/** What the plugin's steps are built over. */
export interface PluginSetupOptions {
  host: PluginHost;
  /** The pi range the package declares. */
  range: string;
  /** The asset root (the shipped config and profiles); assetRoot by default. */
  root?: () => string;
  /** Hands this session's agent a message as the person: the repo profile's
   * Setup runs through it. Absent, the profile step's run refuses. */
  tellAgent?: (text: string) => void;
}

/** The review's config as /qcr-review would load it; the reason when it
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

/** A step whose run and verify both re-check what detect checks: there is
 * nothing for the plugin to do but say what is missing and how to fix it. */
function checkStep(
  def: Pick<SetupStep, "id" | "title" | "explain" | "order" | "optional">,
  check: () => Promise<Detection>,
): SetupStep {
  const report = async (): Promise<StepReport> => {
    const d = await check();
    return "found" in d
      ? { ok: true, checks: [{ name: def.title, ok: true, detail: d.found }] }
      : { ok: false, checks: [{ name: def.title, ok: false, detail: d.missing }] };
  };
  return { ...def, detect: check, run: report, verify: report };
}

/** The repo's top level (pi's cwd when git cannot say). */
async function repoTop(host: PluginHost): Promise<string> {
  const git = host.runner.which("git");
  if (git === null) return host.cwd;
  const r = await host.runner.run(git, ["rev-parse", "--show-toplevel"], {
    cwd: host.cwd,
    env: host.env,
  });
  return (r.code === 0 && r.stdout.trim()) || host.cwd;
}

/** The message that runs Setup for this repo's profile with the person's own
 * agent: survey, review history, interview, then the profile's files. */
export function profileSetupBrief(o: { top: string; root: string }): string {
  const keys = [...REPO_TOML_KEYS].map((k) => `\`${k}\``).join(", ");
  const lensKeys = LENS_TUNING_KEYS.filter((k) => k !== "guide")
    .map((k) => `\`${k}\``)
    .join(", ");
  return [
    `Set up QuickReview's repo profile for this repo (${o.top}). This is QuickReview's Setup: a survey of the repo, its review history, then an interview with me. Its result is the repo profile, \`${REPO_PROFILE_DIR}/\` at the repo root, which every QuickReview review of this repo reads from the base commit.`,
    "",
    "1. Survey. Read the repo's agent-directive files (AGENTS.md, CLAUDE.md, CONTRIBUTING.md and the like) and its design docs in full, then a sample of each unit's code. Note its stack, what it already enforces (linters, CI, tests) and the conventions it writes down. Hunt no bugs: this is not a review.",
    "2. Review history. If `gh` is signed in, read the human review comments on the repo's recently merged pull requests and condense them into a few themes, in your own words: never a quote, never a name. With no `gh` or no history, skip this step and say so.",
    "3. Interview. Tell me in a few lines what you learned. Then ask me, a few questions at a time, about four things: the repo's goals, what must block a merge, its risk areas, and its style and tests. For each concern that comes up (security, data, money, tests…) ask how much it matters: critical, important, normal (the reviewer as shipped) or ignore.",
    `4. The profile. Write \`${REPO_PROFILE_DIR}/profile.toml\` and, for each house rule, \`${REPO_PROFILE_DIR}/addenda/<nn>-<rule-id>.md\`. Show me each file and change it until I agree. Write nothing outside \`${REPO_PROFILE_DIR}/\`, and leave committing to me: a review reads the profile from the base commit, so it applies once it is committed there.`,
    "",
    "What a repo profile may carry (a review drops anything else and says so):",
    `- \`profile.toml\` with only ${keys}. Tune a lens with a \`[lenses.<lens>]\` table, whose keys are ${lensKeys}: \`enabled = false\` turns the lens off for this repo, \`min_tier\` is a floor (${PASS_TIER_ORDER.join(", ")}), \`effort\` is low, medium or high, \`max_severity\` is the lens's ceiling (${SEVERITIES.join(", ")}), and \`emphasis\` is a sentence or two on what matters most here. The lenses are the \`pass-*.md\` files in ${join(o.root, "agents")}; name one without the \`.md\`. A concern you weighed critical raises its lenses (a higher \`min_tier\` and \`effort\`, an \`emphasis\`), and one weighed ignore turns them off.`,
    "- `addenda/*.md`: one house rule each. The file opens with a front matter of exactly two lines, `id: <rule-id>` and `scope: <pass names, comma-separated>` (or `all`), between `---` fences, then the rule as you would tell a reviewer.",
    `The shipped profiles in ${join(o.root, "profiles")} are worked examples of both files (\`example-django/\` has a profile.toml and addenda in this shape).`,
    "",
    "Ask me before anything that reaches outside the repo. Never read or print a token or key.",
  ].join("\n");
}

/** The plugin's setup steps, built over `o`, in their order. */
export function pluginSetupSteps(o: PluginSetupOptions): SetupStep[] {
  const { host, range } = o;
  const root = o.root ?? assetRoot;
  const profileFile = async (): Promise<{ top: string; present: boolean }> => {
    const top = await repoTop(host);
    return { top, present: existsSync(join(top, REPO_PROFILE_DIR, "profile.toml")) };
  };
  const detectProfile = async (): Promise<Detection> =>
    (await profileFile()).present
      ? {
          found: `${REPO_PROFILE_DIR}/profile.toml in this repo (a review reads it from the base commit)`,
        }
      : {
          missing:
            "none yet: reviews run on the shipped profile. `/qcr-setup profile` sets one up with your agent (Setup: a survey, the review history, an interview)",
        };
  return [
    checkStep(
      {
        id: PLUGIN_SETUP_STEPS.pi,
        title: "pi version",
        explain: "The running pi is inside the range the plugin declares.",
        order: 1,
      },
      async () => {
        const gate = piGate(host.piVersion, range);
        return gate === null
          ? { found: `pi ${host.piVersion}, inside ${range}` }
          : { missing: gate };
      },
    ),
    checkStep(
      {
        id: PLUGIN_SETUP_STEPS.login,
        title: "login",
        explain: "pi has a login for every provider the review runs on.",
        order: 2,
      },
      async () => {
        const cfg = reviewConfig(host, root);
        if (typeof cfg === "string")
          return { missing: `the review's config cannot be read: ${cfg}` };
        const logins = host.auth.logins();
        const providers = reviewProviders(cfg);
        const missing = providers.filter(
          (p) => logins[p]?.type !== "oauth" && !host.auth.configured(p),
        );
        if (missing.length === 0)
          return {
            found: `pi can reach ${providers.join(", ")}, the providers the review runs on`,
          };
        const keyed = Object.entries(logins)
          .filter(([, l]) => l.type === "api_key")
          .map(([name]) => name);
        return {
          missing: noLoginHint(
            missing[0]!,
            keyed.filter((k) => !missing.includes(k)),
          ),
        };
      },
    ),
    checkStep(
      {
        id: PLUGIN_SETUP_STEPS.git,
        title: "git",
        explain: "git is on PATH: every review reads a git repo.",
        order: 3,
      },
      async () => {
        const git = host.runner.which("git");
        return git === null
          ? { missing: "git is not on PATH: every review reads a git repo" }
          : { found: git };
      },
    ),
    checkStep(
      {
        id: PLUGIN_SETUP_STEPS.github,
        title: "GitHub",
        explain: "A GitHub credential, for pull-request targets.",
        order: 4,
        optional: true,
      },
      async () => {
        const tokenEnv = ["GH_TOKEN", "GITHUB_TOKEN"].find(
          (k) => (host.env[k] ?? "").trim() !== "",
        );
        if (tokenEnv !== undefined) return { found: `${tokenEnv} is set (for PR targets)` };
        const gh = host.runner.which("gh");
        const loggedIn =
          gh !== null &&
          (await host.runner.run(gh, ["auth", "status"], { cwd: host.cwd, env: host.env })).code ===
            0;
        return loggedIn
          ? { found: "gh is logged in (for PR targets)" }
          : {
              missing:
                "no GH_TOKEN, no GITHUB_TOKEN and no `gh auth login`: branch and uncommitted reviews work, a PR target needs one of them",
            };
      },
    ),
    {
      ...checkStep(
        {
          id: PLUGIN_SETUP_STEPS.profile,
          title: "repo profile",
          explain:
            "This repo's profile, `.qcr/`: Setup surveys the repo, reads its review history and interviews you, and writes it.",
          order: 90,
          optional: true,
        },
        detectProfile,
      ),
      // Setup itself is the person's conversation with their agent: the run
      // hands the agent the brief, and the profile exists only once the agent
      // has written it, so the run reports it as not there yet.
      run: async () => {
        if (o.tellAgent === undefined)
          return {
            ok: false,
            checks: [
              {
                name: "repo profile",
                ok: false,
                detail: "Setup needs this pi session's agent, and there is none to hand it to",
              },
            ],
          };
        const { top, present } = await profileFile();
        o.tellAgent(profileSetupBrief({ top, root: root() }));
        return {
          ok: false,
          checks: [
            {
              name: "repo profile",
              ok: false,
              detail: `Setup is with your agent in this session; it ${present ? "revises" : "writes"} ${REPO_PROFILE_DIR}/ for you to commit`,
            },
          ],
        };
      },
    },
  ];
}

/** The plugin's steps on a registry of their own: the one a host registers
 * more steps onto. */
export function pluginSetupRegistry(o: PluginSetupOptions): StepRegistry {
  return new StepRegistry(pluginSetupSteps(o));
}

/** /qcr-setup's checklist: the plugin's steps only, kept in memory. */
function pluginChecklist(o: PluginSetupOptions): SetupChecklist {
  const adapters: ChecklistAdapters = { clock: () => new Date() };
  return new SetupChecklist(pluginSetupRegistry(o), adapters, { file: null });
}

/** Every step's line once detection ran. */
export async function runSetupChecks(o: PluginSetupOptions): Promise<StepStatusLine[]> {
  const checklist = pluginChecklist(o);
  await checklist.detect();
  return checklist.list();
}

/** A line's mark: done, missing but optional, missing. */
function mark(l: StepStatusLine): string {
  if (l.status === "done") return "✓";
  if (l.status === "disabled") return "-";
  return l.optional ? "!" : "✗";
}

export function renderChecklist(lines: readonly StepStatusLine[]): string {
  const bad = lines.filter((l) => l.status === "pending" && !l.optional).length;
  return [
    "QuickReview setup",
    "",
    ...lines.map((l) => `- ${mark(l)} **${l.title}** — ${l.found ?? l.note ?? l.explain}`),
    "",
    bad === 0 ? "Ready." : `${bad} check${bad === 1 ? "" : "s"} failed.`,
  ].join("\n");
}

const NOT_NOW = "No, not now";
const SET_UP = "Yes, set up this repo's profile";

/** /qcr-setup [profile]. Bare: the checklist, then (with someone to ask and
 * no profile yet) the offer of Setup, No first. `profile`: Setup now. */
export async function runSetupCommand(
  args: string,
  host: PluginHost,
  ui: SessionUi,
  o: { range: string; root?: () => string },
): Promise<void> {
  const say = (text: string): void => (ui.mode === "print" ? ui.print(text) : ui.show(text));
  if (args !== "" && args !== "profile")
    return ui.notify(
      `/qcr-setup takes nothing, or \`profile\` to set up this repo's profile; not ${JSON.stringify(args)}`,
      "error",
    );
  const checklist = pluginChecklist({ ...o, host, tellAgent: (t) => ui.tellAgent(t) });
  await checklist.detect();
  const profileSetup = async (): Promise<void> => {
    const r = await checklist.runStep(PLUGIN_SETUP_STEPS.profile);
    say(r.checks.map((c) => c.detail).join("\n"));
  };
  if (args === "profile") return profileSetup();
  const lines = checklist.list();
  say(renderChecklist(lines));
  const profile = lines.find((l) => l.id === PLUGIN_SETUP_STEPS.profile);
  if (!ui.interactive || profile?.status !== "pending") return;
  const pick = await ui.select(
    "QuickReview: set up this repo's profile? Your agent surveys the repo, asks you about it, and writes .qcr/",
    [NOT_NOW, SET_UP],
    host.shutdown,
  );
  if (pick === SET_UP) await profileSetup();
}
