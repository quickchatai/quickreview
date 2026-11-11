// /qcr-setup: the plugin's setup checklist (../setupchecklist.ts), its own steps
// only, detected and printed as a list. The checklist lives in memory: every
// /qcr-setup detects afresh.
//
//   pi version     the running pi is inside the plugin's declared range
//   login          pi has a credential the review can run on: a route
//                  resolves over this pi's own registry (login.ts), for any
//                  provider, a stored login or a key in the environment. A
//                  config that pins a model needs that model's provider.
//   review model   the model reviews run on and why it is the one. Optional:
//                  it is pending only while two providers tie and nothing was
//                  chosen. `/qcr-setup model`, or yes to the offer after the
//                  list, picks the provider (or hands the pick back to
//                  QuickReview) and remembers it beside pi's logins.
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
import { PROFILES_DIR } from "../profilelookup.js";
import type { CoreConfig } from "../reviewconfig.js";
import { clearModelChoice, readModelChoice, writeModelChoice } from "../modelchoice.js";
import {
  credentialWords,
  refusalText,
  routeNoticeLines,
  routeWhy,
  type RouteInput,
} from "../modelroute.js";
import { isPinned } from "../reviewconfig.js";
import { SEVERITIES } from "../severityrank.js";
import { PASS_TIER_ORDER } from "../types.js";
import { providerRows, type HostRouted } from "./login.js";
import type { PluginHost, SessionUi } from "./session.js";
import { piGate } from "./versiongate.js";

/** The plugin's step ids, in their order on the checklist. */
export const PLUGIN_SETUP_STEPS = {
  pi: "pi_version",
  login: "pi_login",
  model: "review_model",
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

/** The review's config as /qcr-review would load it, and its file (null:
 * the shipped defaults stand in); the reason when it cannot be read. */
function reviewConfig(
  host: PluginHost,
  root: () => string,
): { cfg: CoreConfig; path: string | null } | string {
  try {
    const env = { ...host.env, HOME: host.home };
    const r = root();
    const loaded = loadOneShotConfig({ root: r, env });
    const { cfg } = contextFrom(r, loaded, loaded.cfg.review.profile, "", {
      homes: homeProfilePlaces(env),
    });
    return { cfg, path: loaded.path };
  } catch (err) {
    return err instanceof Error ? err.message : String(err);
  }
}

/** The route a review started now would run on, as this pi resolves it
 * (login.ts): the config's pin and the remembered choice. `unread` says why
 * it cannot be asked for at all. */
function reviewRoute(
  host: PluginHost,
  root: () => string,
):
  | { routed: HostRouted; pin: RouteInput["pin"] | undefined; configPath: string | null }
  | { unread: string } {
  const loaded = reviewConfig(host, root);
  if (typeof loaded === "string")
    return { unread: `the review's config cannot be read: ${loaded}` };
  const resolve = host.auth.route;
  if (resolve === undefined)
    return {
      unread: "this pi's model registry cannot be read here, so its credentials are unknown",
    };
  const pin: RouteInput["pin"] | undefined = isPinned(loaded.cfg.models.model)
    ? { text: loaded.cfg.models.model, from: "config" }
    : undefined;
  const choice = readModelChoice(host.agentDir).choice;
  return {
    routed: resolve({
      ...(pin !== undefined ? { pin } : {}),
      ...(choice !== undefined ? { choice } : {}),
    }),
    pin,
    configPath: loaded.path,
  };
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
    `The shipped profiles in ${join(o.root, PROFILES_DIR)} are worked examples of both files (\`example-django/\` has a profile.toml and addenda in this shape).`,
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
        explain: "pi has a login the review can run on.",
        order: 2,
      },
      async () => {
        const r = reviewRoute(host, root);
        if ("unread" in r) return { missing: r.unread };
        const { result, nameOf, notes } = r.routed;
        if (result.ok)
          return {
            found: `${result.route.providerName}, ${credentialWords(result.route.credential)}: a review runs on ${result.route.spec}`,
          };
        return {
          missing: [
            refusalText(result.refusal, "plugin", { configPath: r.configPath, nameOf }),
            ...notes,
          ].join(" "),
        };
      },
    ),
    checkStep(
      {
        id: PLUGIN_SETUP_STEPS.model,
        title: "review model",
        explain: "The model reviews run on, and why it is the one.",
        order: 2.5,
        optional: true,
      },
      async () => {
        const r = reviewRoute(host, root);
        if ("unread" in r || !r.routed.result.ok)
          return { missing: "none yet: no model resolves (the login check says why)" };
        const route = r.routed.result.route;
        const line = `${route.spec} (${routeWhy(route, "plugin", { configPath: r.configPath })})`;
        // Two providers tie and nothing was chosen: the pick is the person's.
        return route.ask
          ? {
              missing: `${line}. pi has credentials for ${1 + route.alternatives.length} providers: \`/qcr-setup model\` picks the one reviews run on`,
            }
          : { found: line };
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

/** The last row of /qcr-setup model: the pick goes back to the rule. */
export const AUTOMATIC = "automatic (let QuickReview pick)";

/**
 * /qcr-setup model: pick the provider reviews run on, through pi's select.
 * One row per usable provider (the model each would run, and whose
 * credential it is), then `AUTOMATIC`. A provider is remembered as a stated
 * choice, which holds like a pin; `AUTOMATIC` forgets the choice. The route a
 * review would now run on is said afterwards. Nothing is asked with nobody to
 * ask: the route is said, and how to name a model for one run.
 */
async function modelSetup(host: PluginHost, ui: SessionUi, root: () => string): Promise<void> {
  const say = (text: string): void => (ui.mode === "print" ? ui.print(text) : ui.show(text));
  const resolve = host.auth.route;
  if (resolve === undefined)
    return ui.notify("this pi's model registry cannot be read here: no model to choose", "error");
  const now = (): string[] => {
    const r = reviewRoute(host, root);
    if ("unread" in r) return [r.unread];
    const { result, nameOf, notes } = r.routed;
    if (!result.ok)
      return [
        "model: none",
        refusalText(result.refusal, "plugin", { configPath: r.configPath, nameOf }),
        ...notes,
      ];
    return [
      ...routeNoticeLines(result.route, "plugin"),
      // A stated choice does not move a model the config pins.
      ...(r.pin !== undefined && readModelChoice(host.agentDir).choice !== undefined
        ? [
            `[models] model in ${r.configPath ?? "the config"} still pins ${r.pin.text}: the config wins`,
          ]
        : []),
    ];
  };
  // Every usable provider, as the rule orders them with nothing chosen.
  const open = resolve({});
  if (!open.result.ok) return say(now().join("\n"));
  if (!ui.interactive)
    return say(
      [
        ...now(),
        "Choosing needs a person: run /qcr-setup model in an interactive pi, or name a model for one run with --model <provider>/<id>.",
      ].join("\n"),
    );
  const route = open.result.route;
  const options = [route, ...route.alternatives];
  const rows = providerRows(route);
  const picked = await ui.select(
    "QuickReview: which provider do reviews run on?",
    [...rows, AUTOMATIC],
    host.shutdown,
  );
  // Dismissed: nothing changes.
  if (picked === undefined) return;
  const answer = options[rows.indexOf(picked)];
  const written =
    answer === undefined
      ? clearModelChoice(host.agentDir)
      : writeModelChoice(host.agentDir, { provider: answer.provider, model: null, via: "use" });
  if (!written.ok) return ui.notify(written.error, "error");
  ui.notify(
    [
      answer === undefined
        ? "QuickReview picks the model again."
        : `QuickReview will use ${answer.providerName} from now on.`,
      ...now(),
    ].join("\n"),
    "info",
  );
}

/** /qcr-setup [model | profile]. Bare: the checklist, then (with someone to
 * ask) the provider question while two providers tie and nothing was chosen,
 * and the offer of Setup while there is no profile yet, No first. `model`:
 * the provider question now. `profile`: Setup now. */
export async function runSetupCommand(
  args: string,
  host: PluginHost,
  ui: SessionUi,
  o: { range: string; root?: () => string },
): Promise<void> {
  const say = (text: string): void => (ui.mode === "print" ? ui.print(text) : ui.show(text));
  if (args !== "" && args !== "profile" && args !== "model")
    return ui.notify(
      `/qcr-setup takes nothing, \`model\` to pick the provider reviews run on, or \`profile\` to set up this repo's profile; not ${JSON.stringify(args)}`,
      "error",
    );
  const root = o.root ?? assetRoot;
  if (args === "model") return modelSetup(host, ui, root);
  const checklist = pluginChecklist({ ...o, host, tellAgent: (t) => ui.tellAgent(t) });
  await checklist.detect();
  const profileSetup = async (): Promise<void> => {
    const r = await checklist.runStep(PLUGIN_SETUP_STEPS.profile);
    say(r.checks.map((c) => c.detail).join("\n"));
  };
  if (args === "profile") return profileSetup();
  const lines = checklist.list();
  say(renderChecklist(lines));
  if (!ui.interactive) return;
  // The model step is pending only while a route resolves and the pick
  // among several providers is still the person's to make.
  const model = lines.find((l) => l.id === PLUGIN_SETUP_STEPS.model);
  const login = lines.find((l) => l.id === PLUGIN_SETUP_STEPS.login);
  if (model?.status === "pending" && login?.status === "done") await modelSetup(host, ui, root);
  const profile = lines.find((l) => l.id === PLUGIN_SETUP_STEPS.profile);
  if (profile?.status !== "pending") return;
  const pick = await ui.select(
    "QuickReview: set up this repo's profile? Your agent surveys the repo, asks you about it, and writes .qcr/",
    [NOT_NOW, SET_UP],
    host.shutdown,
  );
  if (pick === SET_UP) await profileSetup();
}
