// Interview → config fill: the onboarding step that turns the ~8
// answers only a human can give into a real config.toml, by COMMENT-PRESERVING
// PATCH of the shipped `config.example.toml` template.
//
// Three properties carry the design:
//
//   * ASK ONLY WHAT A HUMAN KNOWS. `QUESTIONS` is the whole interview — the
//     reviewed repo, its local checkout, the App slug, owner identity, the ops
//     timezone, the base branch, the escalation mention, and (only where the
//     recorded topology/ingress make them real questions) the ssh alias and
//     public webhook hostname. Each carries `teach`: the concept is explained
//     at the moment it becomes relevant, never merely prompted.
//   * COMPUTE EVERYTHING ELSE. `DERIVABLES` is the closed enumeration of what
//     this step derives instead of asking — the bot login from the App slug,
//     the clone dir from the repo slug, the [eod]/[slack.policy] timezone
//     cascade off [ops], the [backfill] cascade off [github], the sink default,
//     directory defaults. `tests/onboard-configfill.test.ts` pins the id list,
//     so the list cannot silently shrink back into the interview.
//   * NEVER A BLIND REWRITE. The patch source is the operator's EXISTING
//     config.toml when there is one (the template only on a fresh install), and
//     only keys whose value actually changes are edited. A re-run with every
//     answer kept produces a byte-identical file and does not touch the disk.
//
// Rule 1 (dry_run is the owner's flag alone) is structural here, not prompted:
// no question and no derivable targets `dry_run`, `assertNoDryRunEdit` refuses
// any edit that names it however it is spelled, and the fresh-fill path ships
// whatever the template ships (true). An existing config's flag — flipped or
// not — is carried through untouched; this step cannot move it in either
// direction. The explicit, offered go-live flip belongs to golive.ts alone.
//
// Secrets are not collected here and their validators are not duplicated:
// `deploy/collect-secrets.sh` owns pasted-secret prompting and validation, and
// the GitHub App step's manifest exchange writes the App credentials straight into the
// secrets dir. This step only reports which of that wizard's required files
// exist yet, reading the `deploy_shape` marker the wizard itself writes.
//
// I/O: answers come as the tool's arguments (`ctx.input`, one string per
// question id — the pi-driven wizard has no prompter), through the engine's
// `prompter` adapter (the non-LLM fallback entry), or from choices a sibling
// step already recorded; the config is read and written at
// `adapters.paths.configPath` (the install-located file), the template and state
// files live under the sandbox root derived from `adapters.paths.stateDir`.
// Tests point both at a temp dir and fake the prompter — no network, no docker,
// no real repo write.
import { parse as parseToml } from "smol-toml";
import { splitTail, tomlValueAt } from "../toml.js";
export { splitTail } from "../toml.js";
import { existsSync, readFileSync, rmSync } from "node:fs";
import { isAbsolute, join } from "node:path";
import {
  ESCALATION_LOGIN_RE as LOGIN_RE,
  assertIanaTimeZone,
  expandHome,
  githubCloneDir,
  loadConfig,
  TUI_DEFAULTS,
  type Config,
} from "../../config.js";
import {
  CHOICE_KEYS,
  CHOICE_WRITERS,
  REPO_SLUG_RE,
  type ChoiceName,
  botLoginFor,
  ingressChoiceOf,
  userAuthRecorded,
  type IngressChoice,
} from "../choices.js";
import {
  readTextOrNull,
  sandboxRoot,
  writeAtomic,
  type CheckResult,
  type OnboardingStep,
  type StepContext,
  type StepReport,
} from "../engine.js";
import { deliverConfigChange, configDeliveryChecks } from "./configdelivery.js";
import type { TransportOptions } from "./transport.js";
import { BARE_HOSTNAME_RE, CONTAINER_STATE_DIR, readTomlKey, secretsDirFor } from "./ingress.js";
import { SSH_ALIAS_RE, topologyOf, type Topology } from "./topology.js";

export const CONFIG_FILL_STEP_ID = "config_fill";

/** The choice keys this step reads and writes live in one place for the whole
 * wizard (src/onboard/choices.ts) — re-exported here because half the wizard
 * imports them from this module. */
export { CHOICE_KEYS };

// ---- comment-preserving TOML patch ------------------------------------------

export interface TomlEdit {
  /** "" = the root table (keys before the first header). */
  section: string;
  key: string;
  /** Already-rendered TOML value (use `tomlString` for strings). */
  value: string;
}

// A header may carry a trailing comment (`[tui] # mine` is legal TOML, and the
// ingress reader accepts it) — missing one would append a duplicate table.
const HEADER_RE = /^\s*\[([^\]]+)\]\s*(?:#.*)?$/;

/** A TOML basic string. JSON's escape set is a subset of TOML's, so a hostile
 * answer (quotes, backslashes, newlines) can never break out of the value. */
export function tomlString(v: string): string {
  return JSON.stringify(v);
}

function validateGithubLogin(value: string): string | null {
  return LOGIN_RE.test(value)
    ? null
    : "a GitHub login is letters, digits and single dashes — no @, no URL";
}

function escapeRe(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** `← FILL (3): …` has done its job once the value is filled. Rewrite the
 * marker in place — the EXPLANATION after it is the part worth keeping. */
export function rewriteFillMarker(comment: string): string {
  if (!/←\s*FILL/.test(comment)) return comment;
  return comment.replace(/←\s*FILL(\s*\(\d+\))?\s*:?\s*/, "filled by qcr onboard: ");
}

function sectionAt(lines: string[]): string[] {
  const out: string[] = [];
  let cur = "";
  let continuation: string | null = null;
  for (const line of lines) {
    if (continuation !== null) {
      continuation += "\n" + line;
      out.push("\0");
      if (splitTail(continuation) !== null) continuation = null;
      continue;
    }
    const m = HEADER_RE.exec(line);
    if (m) cur = m[1]!.trim();
    out.push(cur);
    const assignment = /^\s*(?:"(?:[^"\\]|\\.)*"|'[^']*'|[A-Za-z0-9_-]+)\s*=\s*(.*)$/.exec(line);
    if (assignment && splitTail(assignment[1]!) === null) continuation = assignment[1]!;
  }
  return out;
}

/**
 * Apply `edits` to a TOML document, preserving every comment, blank line and
 * key order. An existing assignment has only its VALUE replaced (its trailing
 * comment survives, with a spent `← FILL` marker rewritten); a commented-out
 * assignment is uncommented in place; a key absent from its section is appended
 * to the end of that section; a missing section is appended at EOF.
 */
export function patchToml(text: string, edits: readonly TomlEdit[]): string {
  const lines = text.split("\n");
  for (const edit of edits) {
    const sections = sectionAt(lines);
    const spelling = `(?:${escapeRe(edit.key)}|"(?:[^"\\\\]|\\\\.)*"|'[^']*')`;
    const live = new RegExp(`^(\\s*)(${spelling})(\\s*=\\s*)(.*)$`);
    const commented = new RegExp(`^(\\s*)#\\s*(${spelling})(\\s*=\\s*)(.*)$`);
    let applied = false;
    for (const re of [live, commented]) {
      for (let i = 0; i < lines.length && !applied; i++) {
        if (sections[i] !== edit.section) continue;
        const m = re.exec(lines[i]!);
        if (!m) continue;
        try {
          if (!Object.hasOwn(parseToml(`${m[2]} = 0`), edit.key)) continue;
        } catch {
          continue;
        }
        let end = i;
        let tail = m[4]!;
        while (splitTail(tail) === null && end + 1 < lines.length) tail += "\n" + lines[++end]!;
        const parts = splitTail(tail);
        if (!parts) throw new Error(`cannot patch unterminated TOML assignment ${edit.key}`);
        const comment = parts.comment ? `${parts.gap}${rewriteFillMarker(parts.comment)}` : "";
        lines.splice(i, end - i + 1, `${m[1]}${m[2]}${m[3]}${edit.value}${comment}`);
        applied = true;
      }
      if (applied) break;
    }
    if (applied) continue;
    // Not present: append inside the section, or create the section at EOF.
    let end = -1;
    for (let i = 0; i < lines.length; i++) if (sections[i] === edit.section) end = i;
    if (end < 0) {
      if (lines.at(-1) !== "") lines.push("");
      lines.push(`[${edit.section}]`, `${edit.key} = ${edit.value}`, "");
      continue;
    }
    while (end > 0 && lines[end]!.trim() === "") end--;
    lines.splice(end + 1, 0, `${edit.key} = ${edit.value}`);
  }
  return lines.join("\n");
}

/** Rule 1's structural belt on the edit list: `dry_run` is not a key this step
 * may write, however it is spelled. Same spirit as `configPatchViolation` in
 * src/tui/proposals.ts — a refusal before anything reaches the file. */
const DRY_RUN_TOKEN = /(^|[^0-9A-Za-z_])dry_run([^0-9A-Za-z_]|$)/;

export function assertNoDryRunEdit(edits: readonly TomlEdit[]): void {
  for (const e of edits) {
    if (DRY_RUN_TOKEN.test(e.key) || DRY_RUN_TOKEN.test(e.section)) {
      throw new Error(
        "onboarding config fill: refused an edit touching dry_run — rule 1: the flag is the owner's alone",
      );
    }
  }
}

// ---- the interview ----------------------------------------------------------

/** Everything the fill needs: the answers plus the choices siblings recorded. */
export interface FillFacts {
  repo: string;
  app_slug: string;
  reviewed_repo_dir: string;
  owner_name: string;
  owner_github_login: string;
  owner_slack_id: string;
  timezone: string;
  base_branch: string;
  escalation_mention: string;
  ssh_host: string;
  webhook_hostname: string;
  /** Not asked: the shipped default, or a sibling step's recorded choice. */
  secrets_dir: string;
  topology: string;
  ingress: string;
  /** The GitHub route the github_account step recorded ("user" | "app"), ""
   * while unanswered — which is the App route's interview. */
  github_auth?: string;
  /** The person's own login on the "user" route (`GET /user`). */
  account_login?: string;
}

export type AnswerKey = Exclude<
  keyof FillFacts,
  "secrets_dir" | "topology" | "ingress" | "github_auth" | "account_login"
>;

export interface Question {
  id: AnswerKey;
  section: string;
  key: string;
  title: string;
  /** The concept, taught at the moment it becomes relevant. */
  teach: string;
  prompt: string;
  /** A blank answer is accepted (and means the empty/derived value). */
  optional: boolean;
  /** Choice keys a sibling step may have already recorded this under. */
  from?: readonly string[];
  /** Only asked when the recorded topology/ingress make it a real question. */
  asked?(choices: Readonly<Record<string, unknown>>): boolean;
  /** Current value in an existing config — the re-run default (Enter keeps). */
  read(cfg: Config): string;
  /** null = valid; otherwise the plain guidance the operator sees. */
  validate(value: string): string | null;
}

const SLUG_RE = /^[A-Za-z0-9][A-Za-z0-9-]*$/;

function oneLine(v: string): string | null {
  return /[\r\n]/.test(v) ? "that must be a single line" : null;
}

/** The ingress shapes where the operator supplies a stable public hostname.
 * The quick tunnel assigns its own, polling exposes nothing, and ngrok's
 * reserved domain is optional — so `named` is the one shape that MUST be
 * asked. Typed as `IngressChoice`, so a value the ingress step
 * cannot record is a compile error rather than a question that never fires. */
const OPERATOR_HOSTNAME_INGRESS = new Set<IngressChoice>(["named"]);

function str(choices: Readonly<Record<string, unknown>>, key: string): string {
  const v = choices[key];
  return typeof v === "string" ? v.trim() : "";
}

export const QUESTIONS: readonly Question[] = [
  {
    id: "repo",
    section: "github",
    key: "repo",
    title: "The repository to review",
    teach:
      "QuickReview watches exactly ONE repository. It never reviews a PR on its own initiative: a round starts when " +
      "someone puts the trigger label on a pull request (or requests the review team). Everything else — labels, " +
      "clone directory, backfill identity — is derived from this one answer.",
    prompt: 'Which repository should the reviewer watch? ("owner/name")',
    optional: false,
    // On the own-account route the github_account step already asked, from
    // the repos the person's account reaches.
    from: [CHOICE_KEYS.accountRepo, CHOICE_KEYS.repo],
    read: (cfg) => cfg.github.repo,
    validate: (v) =>
      REPO_SLUG_RE.test(v)
        ? null
        : 'a repository is "owner/name" — e.g. "acme/web-app" (no URL, no trailing .git)',
  },
  {
    id: "reviewed_repo_dir",
    section: "companion",
    key: "reviewed_repo_dir",
    title: "Your local checkout of that repository",
    teach:
      "The companion — the local pi that sits beside the TUI — reads the code a review is about. Your checkout is " +
      "mounted READ-ONLY into its container: it can read every file and change none of them. A missing checkout only " +
      "makes the companion less informed; it never breaks the reviewer.",
    prompt:
      "Where is your local checkout of that repository? (Enter if there is none here — the companion starts without it)",
    // A fresh box has no checkout, and the daemon clones the repository itself.
    optional: true,
    from: [CHOICE_KEYS.repoDir],
    read: (cfg) => cfg.companion.reviewed_repo_dir,
    validate: (v) => {
      const line = oneLine(v);
      if (line) return line;
      const p = expandHome(v);
      if (!isAbsolute(p))
        return "give an absolute path (or a ~/… path) — a relative path would depend on where the wizard ran";
      if (!existsSync(p))
        return `nothing exists at ${p} — clone the repository first, then give that directory`;
      return null;
    },
  },
  {
    id: "app_slug",
    section: "github",
    key: "app_slug",
    title: "The GitHub App slug",
    teach:
      "Reviews are posted by a GitHub App, not by you. Its slug is the name in its URL — and the bot login the reviews " +
      "appear under is DERIVED from it (`<slug>[bot]`), so you never type that twice. If the wizard already created " +
      "the App for you, this is filled in from that step.",
    prompt: "What is your GitHub App's slug?",
    optional: false,
    from: [CHOICE_KEYS.appSlug],
    // No App exists on the own-account route: `[github] app_slug` stays "".
    asked: (choices) => !userAuthRecorded(choices),
    read: (cfg) => cfg.github.app_slug,
    validate: (v) =>
      SLUG_RE.test(v)
        ? null
        : 'the slug is the name in the App URL — letters, digits and dashes, e.g. "acme-reviewer"',
  },
  {
    id: "timezone",
    section: "ops",
    key: "timezone",
    title: "The operations timezone",
    teach:
      "One knob decides whose calendar day the system runs on: the end-of-day learning sweep, the day-scoped feedback " +
      "rules, metrics buckets and the companion's day rollover. The [eod] and [slack.policy] sections default from it, " +
      "so this is the only place you state it.",
    prompt: 'Which IANA timezone is your working day in? (e.g. "Europe/Warsaw")',
    optional: false,
    read: (cfg) => cfg.ops.timezone,
    validate: (v) => {
      try {
        assertIanaTimeZone(v, "[ops] timezone");
        return null;
      } catch (err) {
        return `${String((err as Error).message)} — use an IANA name like "Europe/Warsaw" or "America/New_York", not an abbreviation`;
      }
    },
  },
  {
    id: "base_branch",
    section: "github",
    key: "base_branch",
    title: "The repository's default branch",
    teach:
      "Used where the system needs the repo's trunk: the base a bot improvement PR targets, and the diff base for " +
      "replays. A review round never uses it — a round always reads the pull request's OWN base branch from GitHub.",
    prompt: 'What is the repository\'s default branch? ("main" / "master")',
    optional: false,
    from: [CHOICE_KEYS.baseBranch],
    read: (cfg) => cfg.github.base_branch,
    validate: (v) =>
      /^[^\s~^:?*[\\]+$/.test(v) ? null : "a branch name, e.g. main or master (no spaces)",
  },
  {
    id: "owner_name",
    section: "owner",
    key: "name",
    title: "Your display name",
    teach:
      "The system has ONE accountable human, configured as a role. This name is rendered in prose — Slack messages, " +
      'the companion\'s day-open, the pinned-memory header. Leave it empty and every surface says "the owner" instead.',
    prompt: "What name should the system call you in its own prose? (Enter to stay anonymous)",
    optional: true,
    read: (cfg) => cfg.owner.name,
    validate: oneLine,
  },
  {
    id: "owner_github_login",
    section: "owner",
    key: "github_login",
    title: "Your GitHub login",
    teach:
      "Used to recognise you on the repository and as the last-resort @-mention when a review has to point at a human. " +
      "It is never used to authenticate anything — the App credential is the only identity that acts.",
    prompt: "What is your GitHub login? (Enter to skip)",
    optional: true,
    from: [CHOICE_KEYS.accountLogin, CHOICE_KEYS.ownerLogin],
    read: (cfg) => cfg.owner.github_login,
    validate: validateGithubLogin,
  },
  {
    id: "owner_slack_id",
    section: "owner",
    key: "slack_id",
    title: "Your Slack member id",
    teach:
      "Only needed if you later switch the Slack concierge on: it is the one identity allowed to claim authorship of " +
      "your own PRs in chat. Skipping it now costs nothing — Slack ships off.",
    prompt: "Your Slack member id, if you use Slack? (U…, Enter to skip)",
    optional: true,
    read: (cfg) => cfg.owner.slack_id,
    validate: (v) =>
      /^U[A-Z0-9]{4,}$/.test(v)
        ? null
        : 'a Slack member id looks like "U01ABCD2EFG" (Slack profile → More → Copy member ID)',
  },
  {
    id: "escalation_mention",
    section: "review",
    key: "escalation_mention_default",
    title: "Fallback @-mention for directive edits",
    teach:
      "When a PR edits the files that instruct coding agents (.claude/**, AGENTS.md, CLAUDE.md and kin), the review " +
      "adds ONE short comment @-mentioning the person who most recently touched those files. This is the fallback when " +
      "git history names nobody — your own login is the usual answer.",
    prompt:
      "Which GitHub login should that fallback mention? (Enter uses your login, or leave both empty for no @)",
    optional: true,
    read: (cfg) => cfg.review.escalation_mention_default,
    validate: validateGithubLogin,
  },
  {
    id: "ssh_host",
    section: "tui",
    key: "ssh_host",
    title: "The ssh alias of the review host",
    teach:
      "On the VM route the operator TUI reads the daemon over ssh. This is the alias from your ~/.ssh/config — the " +
      "same one you would type after `ssh`. On the local route nothing needs it and it stays empty.",
    prompt: "Which ssh alias reaches the machine running the reviewer?",
    optional: false,
    from: [CHOICE_KEYS.sshAlias],
    asked: (choices) => str(choices, CHOICE_KEYS.topology) === "vm",
    read: (cfg) => cfg.tui.ssh_host,
    validate: (v) =>
      SSH_ALIAS_RE.test(v)
        ? null
        : "an ssh alias as it appears in ~/.ssh/config — a Host name, not a URL",
  },
  {
    id: "webhook_hostname",
    section: "server",
    key: "hostname",
    title: "The public webhook hostname",
    teach:
      "GitHub delivers webhooks over HTTPS to a public hostname that fronts the daemon's loopback port. Tunnel shapes " +
      "that assign their own hostname fill this themselves; a named tunnel or your own ingress means you own the name.",
    prompt: "Which public hostname will GitHub deliver webhooks to?",
    optional: false,
    from: [CHOICE_KEYS.ingressHostname],
    asked: (choices) => {
      const ingress = ingressChoiceOf(choices);
      return ingress !== null && OPERATOR_HOSTNAME_INGRESS.has(ingress);
    },
    read: (cfg) => cfg.server.hostname,
    validate: (v) =>
      BARE_HOSTNAME_RE.test(v)
        ? null
        : 'a bare hostname like "review.example.com" — no scheme, no path',
  },
];

export function questionAsked(q: Question, choices: Readonly<Record<string, unknown>>): boolean {
  return q.asked ? q.asked(choices) : true;
}

// ---- what is derived, never asked -------------------------------------------

export interface Derivable {
  id: string;
  /** Dotted config path the derivation lands on. */
  path: string;
  explain: string;
  /** The value written into config.toml, or null when the derivation is a
   * loader-side cascade / code default that this step must simply LEAVE ALONE.
   * `fresh` is false when the source document is the operator's OWN config: a
   * fill-time default returns null there rather than overwriting their choice. */
  write(
    facts: FillFacts,
    fresh: boolean,
    existing?: Config,
  ): { section: string; key: string; value: string } | null;
  /** True ⇒ the derivation is an invariant re-checked at verify time. False ⇒
   * it is only a fill-time default the operator is free to change afterwards. */
  stable: boolean;
  /** Assertion over the PARSED config: null = holds, else the plain reason. */
  holds(cfg: Config, facts: FillFacts): string | null;
}

/** The topology a fill is for: the recorded one, and "local" while none is
 * recorded — `topologyOf`'s reading, the one every other step uses. */
function fillTopology(topology: string): Topology {
  return topologyOf({ [CHOICE_KEYS.topology]: topology });
}

/** The TUI transport a topology implies (an unrecorded one is local). */
function tuiTargetFor(topology: string): "local" | "ssh" {
  return fillTopology(topology) === "vm" ? "ssh" : "local";
}

/** The release image's state dir inside the compose daemon container (the
 * `qcr-state` volume), where the local TUI reads status.json. */
const LOCAL_TUI_STATE_DIR = CONTAINER_STATE_DIR;

export const DERIVABLES: readonly Derivable[] = [
  {
    id: "bot_login",
    path: "[github] bot_login",
    explain:
      "the bot login is the App slug plus the [bot] suffix — asking for it twice is how the two drift apart. On your own " +
      "GitHub account it is your login: the reviews are posted as you",
    write: (f) =>
      f.github_auth === "user"
        ? f.account_login
          ? { section: "github", key: "bot_login", value: tomlString(f.account_login) }
          : null
        : {
            section: "github",
            key: "bot_login",
            value: tomlString(botLoginFor(f.app_slug)),
          },
    stable: true,
    holds: (cfg, f) => {
      if (f.github_auth === "user") {
        if (!cfg.github.bot_login.trim())
          return "[github] bot_login is empty — on your own account it is your GitHub login; run the github_account step";
        return f.account_login && cfg.github.bot_login !== f.account_login
          ? `[github] bot_login is "${cfg.github.bot_login}" but your account is "${f.account_login}" — run the github_account step again`
          : null;
      }
      return cfg.github.bot_login === botLoginFor(cfg.github.app_slug)
        ? null
        : `[github] bot_login is "${cfg.github.bot_login}" but the App slug "${cfg.github.app_slug}" implies "${botLoginFor(cfg.github.app_slug)}"`;
    },
  },
  {
    id: "clone_dir",
    path: "[github] clone_dir",
    explain:
      'left empty so the base clone directory derives from the repo slug ("owner/name" ⇒ "name"); a clone_dir you ' +
      "set yourself (deploy.sh asks for one when the repo's name collides with a sandbox directory) is kept",
    write: (_f, fresh) =>
      fresh ? { section: "github", key: "clone_dir", value: tomlString("") } : null,
    stable: true,
    // The loader's own resolution (an explicit clone_dir wins, else the repo's
    // basename) must name ONE plain directory — the same test deploy.sh applies.
    holds: (cfg) => {
      const dir = githubCloneDir(cfg.github);
      return /^[A-Za-z0-9._-]+$/.test(dir) && dir !== "." && dir !== ".."
        ? null
        : `the clone dir resolves to "${dir}", which is not one plain directory name — set [github] clone_dir to one`;
    },
  },
  {
    id: "secrets_dir",
    path: "[github] secrets_dir",
    explain:
      "the install's secrets directory — left empty in the file, so the install locator finds it: <config home>/secrets " +
      "— the same dir deploy/collect-secrets.sh fills",
    // Fill-time only: the loader EXPANDS `~`, so writing back a parsed value
    // would replace the template's portable `~/…` with this machine's home.
    write: (f, fresh) =>
      fresh ? { section: "github", key: "secrets_dir", value: tomlString(f.secrets_dir) } : null,
    stable: true,
    holds: (cfg) =>
      cfg.github.secrets_dir.trim()
        ? null
        : "[github] secrets_dir is empty — the GitHub credential has nowhere to live",
  },
  {
    id: "review_team",
    path: "[github] review_team",
    explain:
      'left empty: the team trigger is optional, and the trigger label always works — "org/team" is added later if wanted',
    write: () => null,
    stable: false,
    holds: () => null,
  },
  {
    id: "eod_timezone",
    path: "[eod] timezone",
    explain:
      "the end-of-day sweep runs on the [ops] timezone — the cascade means you state your day once",
    write: () => null,
    stable: true,
    holds: (cfg) =>
      cfg.eod.timezone === cfg.ops.timezone
        ? null
        : `[eod] timezone "${cfg.eod.timezone}" no longer follows [ops] "${cfg.ops.timezone}"`,
  },
  {
    id: "slack_policy_timezone",
    path: "[slack.policy] timezone",
    explain: "the Slack day caps run on the [ops] timezone by the same cascade",
    write: () => null,
    stable: true,
    holds: (cfg) =>
      cfg.slack.policy.timezone === cfg.ops.timezone
        ? null
        : `[slack.policy] timezone "${cfg.slack.policy.timezone}" no longer follows [ops] "${cfg.ops.timezone}"`,
  },
  {
    id: "backfill_identity",
    path: "[backfill] *",
    explain:
      "the history importer's identity and labels cascade off [github] — never a second copy to keep in sync",
    write: () => null,
    stable: true,
    holds: (cfg, f) => {
      if (cfg.backfill.bot_login !== cfg.github.bot_login)
        return "[backfill] bot_login no longer follows [github] bot_login";
      // The actor is the App slug; the own-account route has no App, and the
      // loader decides what stands in for it there.
      if (f.github_auth !== "user" && cfg.backfill.bot_actor !== cfg.github.app_slug)
        return "[backfill] bot_actor no longer follows [github] app_slug";
      if (cfg.backfill.trigger_label !== cfg.github.trigger_label)
        return "[backfill] trigger_label no longer follows [github] trigger_label";
      return null;
    },
  },
  {
    id: "sink_kind",
    path: "[sink] kind",
    explain:
      'defect auto-filing defaults to "github" — flagged defects become issues on the reviewed repo, through the one mutation gate',
    write: (_f, fresh) =>
      fresh ? { section: "sink", key: "kind", value: tomlString("github") } : null,
    stable: false,
    // The loader's parseSink refuses an unknown kind before any derivation is
    // checked, so a parsed config always holds this.
    holds: () => null,
  },
  {
    id: "tui_target",
    path: "[tui] target",
    explain:
      'follows the recorded topology: "local" when the daemon runs on this machine (the TUI talks to local Docker), "ssh" on the VM route',
    write: (f) => ({ section: "tui", key: "target", value: tomlString(tuiTargetFor(f.topology)) }),
    stable: true,
    holds: (cfg, f) => {
      const want = tuiTargetFor(f.topology);
      return cfg.tui.target !== want
        ? `[tui] target = "${cfg.tui.target}", but the topology is ${f.topology || "local (none recorded)"} — the TUI would ` +
            `${want === "local" ? "look for the daemon over ssh" : "look for the daemon in local Docker"}. ` +
            `Fix: run this step again (it writes target = "${want}")`
        : null;
    },
  },
  {
    id: "tui_container",
    path: "[tui] container",
    explain:
      "the bundled local Compose project runs service daemon as quickreview-daemon-1; preserve an operator's custom container",
    write: (f, fresh, existing) =>
      fillTopology(f.topology) === "local" &&
      (fresh || existing?.tui.container === TUI_DEFAULTS.container)
        ? { section: "tui", key: "container", value: tomlString("quickreview-daemon-1") }
        : null,
    stable: false,
    holds: () => null,
  },
  {
    id: "tui_memory_container",
    path: "[tui] memory_container",
    explain:
      "the bundled local Compose project runs the memory sidecar as quickreview-memory-1, where the memory forward must relay; preserve an operator's custom container",
    write: (f, fresh, existing) =>
      fillTopology(f.topology) === "local" &&
      (fresh || (existing?.tui.memory_container ?? "") === "")
        ? { section: "tui", key: "memory_container", value: tomlString("quickreview-memory-1") }
        : null,
    stable: false,
    holds: () => null,
  },
  {
    id: "tui_remote_state_dir",
    path: "[tui] remote_state_dir",
    explain:
      `on this machine the TUI reads status.json inside the daemon container, where the release image keeps its state (${LOCAL_TUI_STATE_DIR}, ` +
      "the compose state volume) — the shipped default is the VM host's path; preserve an operator's custom path",
    write: (f, fresh, existing) =>
      fillTopology(f.topology) === "local" &&
      (fresh || existing?.tui.remote_state_dir === TUI_DEFAULTS.remote_state_dir)
        ? { section: "tui", key: "remote_state_dir", value: tomlString(LOCAL_TUI_STATE_DIR) }
        : null,
    stable: false,
    holds: () => null,
  },
  {
    id: "tui_sudo_docker",
    path: "[tui] sudo_docker",
    explain:
      "off on this machine: the wizard's own bring-up drives docker without sudo, so the TUI does too (a sudo password " +
      "prompt behind the TUI's screen can only fail); on the VM route sudo stays the shipped default",
    write: (f, fresh, existing) =>
      fillTopology(f.topology) === "local" &&
      (fresh || existing?.tui.sudo_docker === TUI_DEFAULTS.sudo_docker)
        ? { section: "tui", key: "sudo_docker", value: "false" }
        : null,
    stable: false,
    holds: () => null,
  },
  {
    id: "tui_ssh_host",
    path: "[tui] ssh_host",
    explain:
      "empty on the local topology (the TUI needs no ssh hop to reach a daemon on this machine); the recorded alias on the VM route",
    write: (f) =>
      f.ssh_host ? { section: "tui", key: "ssh_host", value: tomlString(f.ssh_host) } : null,
    stable: false,
    holds: () => null,
  },
  {
    id: "server_hostname",
    path: "[server] hostname",
    explain:
      "left empty where the chosen ingress assigns the hostname itself (the quick tunnel writes it at start-up)",
    write: (f) =>
      f.webhook_hostname
        ? { section: "server", key: "hostname", value: tomlString(f.webhook_hostname) }
        : null,
    stable: false,
    holds: () => null,
  },
  {
    id: "companion_repo_dir",
    path: "[companion] repo_dir",
    explain:
      "left empty so the companion's /workspace mount derives from the sandbox root — never a path to keep in sync",
    write: () => null,
    stable: true,
    holds: (cfg) =>
      isAbsolute(cfg.companion.repo_dir)
        ? null
        : "[companion] repo_dir did not derive to an absolute path",
  },
  {
    id: "escalation_mention_fallback",
    path: "[review] escalation_mention_default",
    explain: "falls back to the owner's GitHub login when the interview leaves it blank",
    write: (f) => {
      const mention = f.escalation_mention || f.owner_github_login;
      return mention
        ? { section: "review", key: "escalation_mention_default", value: tomlString(mention) }
        : null;
    },
    stable: false,
    holds: () => null,
  },
  {
    id: "dry_run",
    path: "dry_run",
    explain:
      "NEVER written by this step, in either direction (rule 1: the flag is the owner's alone). A fresh config ships the " +
      "template's true; an existing config keeps exactly the value it has. The offered go-live flip is its own act.",
    write: () => null,
    stable: false,
    holds: () => null,
  },
];

// ---- fill ------------------------------------------------------------------

export function rootFromStateDir(stateDir: string): string {
  return sandboxRoot({ stateDir });
}

export function templatePathFor(root: string): string {
  return join(root, "config.example.toml");
}

/** Empty = the install locator's answer: `<config home>/secrets`. */
export const DEFAULT_SECRETS_DIR = "";

/** The secret files `deploy/collect-secrets.sh` requires, by deployment shape.
 * Read from ITS artefacts (the `deploy_shape` marker it writes) so this step
 * reports the same required set without duplicating the wizard's validators. */
export const REQUIRED_SECRETS: readonly string[] = ["app_id", "app.pem", "webhook_secret"];
/** The own-account route's one secret: the person's token, written by
 * `qcr github-token sync` (the github_account step runs it). */
export const USER_ROUTE_SECRETS: readonly string[] = ["github_token"];
export const TUNNEL_SHAPE_SECRET = "tunnel_token";

/** Unlike `readTextOrNull`, only ABSENCE is null: a file that exists and
 * cannot be read is an error, never "no config" — the template must not be
 * renamed over an operator's file (and its dry_run) we could not even see. */
function readExisting(path: string): { text: string | null; error: string | null } {
  try {
    return { text: readFileSync(path, "utf8"), error: null };
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === "ENOENT") return { text: null, error: null };
    return { text: null, error: code ?? String(err) };
  }
}

/** The current config, when there is one that parses. A config that does NOT
 * parse is not an error here — it is exactly what this step is for — but its
 * values cannot be offered as defaults, so the answers fall back to asking. */
function currentConfig(path: string): Config | null {
  if (!existsSync(path)) return null;
  try {
    return loadConfig(path);
  } catch {
    return null;
  }
}

export interface CollectResult {
  facts: FillFacts;
  /** Questions with no answer at all (no argument, no prompter, nothing
   * recorded or configured). */
  missing: Array<{ id: AnswerKey; title: string; guidance: string }>;
  /** Answers rejected by validation (an argument, a kept value, or a prompted
   * answer once the attempt budget ran out). */
  rejected: Array<{ id: AnswerKey; guidance: string }>;
  /** Questions that were actually put to the operator this run. */
  asked: AnswerKey[];
  /** Arguments that were not used — a sibling step's recorded value settles
   * the question, or the recorded shape does not ask it — said out loud,
   * never dropped silently. */
  ignored: Array<{ id: AnswerKey; detail: string }>;
}

/** Choice keys this step alone writes. A value recorded under one is this
 * step's OWN earlier answer — never a sibling's word — so it ranks with the
 * previous answers a fresh argument overrides, not above them. */
const OWN_ANSWER_KEYS: ReadonlySet<string> = new Set(
  (Object.keys(CHOICE_WRITERS) as ChoiceName[])
    .filter((n) => CHOICE_WRITERS[n].length === 1 && CHOICE_WRITERS[n][0] === CONFIG_FILL_STEP_ID)
    .map((n) => CHOICE_KEYS[n]),
);

/** The tool argument for one question: a string the operator gave, or null
 * when the call did not carry one. */
function inputAnswer(ctx: StepContext, id: AnswerKey): string | null {
  const v = ctx.input[id];
  return typeof v === "string" ? v.trim() : null;
}

/** How an unanswered question is answered on the pi-driven route. */
function argumentHint(q: Question): string {
  return `${q.prompt} — pass the answer as the \`${q.id}\` argument`;
}

/** How many times one question may be re-asked before the step fails with the
 * validator's guidance. Enough for a typo, few enough that a wedged prompter
 * cannot loop forever. */
export const MAX_ATTEMPTS = 3;

/**
 * Run the interview. Precedence per question: a value a SIBLING step recorded
 * in the checklist (a key some other step writes) > a fresh answer (the tool
 * argument, else the prompter's) > the default a blank answer keeps: the
 * current config value when the config parses (the file wins, as verify says),
 * else this step's own previous answer. With neither an argument nor a
 * prompter the recorded/current values stand alone, and anything genuinely
 * unanswered is reported — never guessed. Every value that lands, whatever
 * its source, passes the question's validator.
 */
export async function collectAnswers(
  ctx: StepContext,
  cfg: Config | null,
  previous: Partial<Record<AnswerKey, string>>,
  /** The text `cfg` was parsed from: a kept value is read as the FILE spells
   * it, so a portable `~/…` is never replaced by the loader's expansion. */
  configText: string | null = null,
): Promise<CollectResult> {
  const choices = ctx.choices;
  const prompter = ctx.adapters.prompter;
  const answers: Partial<Record<AnswerKey, string>> = {};
  const missing: CollectResult["missing"] = [];
  const rejected: CollectResult["rejected"] = [];
  const asked: AnswerKey[] = [];
  const ignored: CollectResult["ignored"] = [];

  for (const q of QUESTIONS) {
    const given = inputAnswer(ctx, q.id);
    if (!questionAsked(q, choices)) {
      if (given)
        ignored.push({
          id: q.id,
          detail: `the argument "${given}" was not used — the recorded topology/ingress does not ask this question`,
        });
      continue;
    }
    const from = q.from ?? [];
    const recorded =
      from
        .filter((k) => !OWN_ANSWER_KEYS.has(k))
        .map((k) => str(choices, k))
        .find((v) => v.length > 0) ?? "";
    if (recorded && q.validate(recorded) === null) {
      answers[q.id] = recorded;
      if (given && given !== recorded)
        ignored.push({
          id: q.id,
          detail: `kept "${recorded}", which an earlier step recorded — the argument "${given}" was not used (re-run the step that owns it to change it)`,
        });
      continue;
    }
    const ownRecorded = from
      .filter((k) => OWN_ANSWER_KEYS.has(k))
      .map((k) => str(choices, k))
      .find((v) => v.length > 0);
    const fallback = cfg
      ? ((configText !== null ? readTomlKey(configText, q.section, q.key) : null) ?? q.read(cfg))
      : (previous[q.id] ?? ownRecorded ?? "");
    if (given !== null || !prompter) {
      const value = given || fallback;
      if (!value) {
        if (q.optional) answers[q.id] = "";
        else missing.push({ id: q.id, title: q.title, guidance: argumentHint(q) });
        continue;
      }
      const reason = q.validate(value);
      if (reason === null) answers[q.id] = value;
      else
        rejected.push({
          id: q.id,
          guidance: `${given ? "" : `the kept value "${value}" no longer holds: `}${reason} — pass a corrected \`${q.id}\` argument`,
        });
      continue;
    }
    let settled = false;
    let guidance = "";
    for (let attempt = 0; attempt < MAX_ATTEMPTS && !settled; attempt++) {
      const suffix = fallback ? ` [${fallback}]` : q.optional ? " [skip]" : "";
      const head = attempt === 0 ? `${q.teach}\n` : `${guidance}\n`;
      const raw = (await prompter(`${head}${q.prompt}${suffix}: `)).trim();
      asked.push(q.id);
      const value = raw || fallback;
      if (!value) {
        if (q.optional) {
          answers[q.id] = "";
          settled = true;
          break;
        }
        guidance = "that answer is required — there is no sensible default for it";
        continue;
      }
      const reason = q.validate(value);
      if (reason === null) {
        answers[q.id] = value;
        settled = true;
        break;
      }
      guidance = reason;
    }
    if (!settled) rejected.push({ id: q.id, guidance: guidance || "no valid answer" });
  }

  const facts: FillFacts = {
    repo: answers.repo ?? "",
    app_slug: answers.app_slug ?? "",
    reviewed_repo_dir: answers.reviewed_repo_dir ?? "",
    owner_name: answers.owner_name ?? "",
    owner_github_login: answers.owner_github_login ?? "",
    owner_slack_id: answers.owner_slack_id ?? "",
    timezone: answers.timezone ?? "",
    base_branch: answers.base_branch ?? "",
    escalation_mention: answers.escalation_mention ?? "",
    ssh_host: answers.ssh_host ?? "",
    webhook_hostname: answers.webhook_hostname ?? "",
    secrets_dir:
      str(choices, CHOICE_KEYS.secretsDir) ||
      (cfg ? cfg.github.secrets_dir : "") ||
      DEFAULT_SECRETS_DIR,
    topology: str(choices, CHOICE_KEYS.topology),
    ingress: str(choices, CHOICE_KEYS.ingress),
    github_auth: str(choices, CHOICE_KEYS.githubAuth),
    account_login: str(choices, CHOICE_KEYS.accountLogin),
  };
  return { facts, missing, rejected, asked, ignored };
}

/** Every edit the fill would make — answers first, then the derivations. The
 * caller filters this against the source document so only real changes land. */
export function buildEdits(
  facts: FillFacts,
  choices: Readonly<Record<string, unknown>>,
  fresh: boolean,
  existing?: Config,
): TomlEdit[] {
  const edits: TomlEdit[] = [];
  for (const q of QUESTIONS) {
    if (!questionAsked(q, choices)) continue;
    edits.push({ section: q.section, key: q.key, value: tomlString(facts[q.id]) });
  }
  for (const d of DERIVABLES) {
    const w = d.write(facts, fresh, existing);
    if (w) edits.push(w);
  }
  // Later wins: a derivation over the same key (the escalation-mention
  // fallback) is deliberately the last word.
  const seen = new Map<string, TomlEdit>();
  for (const e of edits) seen.set(`${e.section}.${e.key}`, e);
  const out = [...seen.values()];
  assertNoDryRunEdit(out);
  return out;
}

/** Drop edits whose value the document already carries — this is what makes a
 * re-run TARGETED rather than a rewrite (and byte-identical when nothing
 * changed). Comparison is on the rendered value, so formatting never counts. */
export function changedEdits(text: string, edits: readonly TomlEdit[]): TomlEdit[] {
  let parsed: unknown;
  try {
    parsed = parseToml(text);
  } catch {
    parsed = undefined;
  }
  const lines = text.split("\n");
  const sections = sectionAt(lines);
  return edits.filter((edit) => {
    if (parsed !== undefined) {
      try {
        const before = tomlValueAt(parsed, edit.section, edit.key);
        const after = parseToml(`value = ${edit.value}`)["value"];
        if (before !== undefined && typeof before !== "object" && Object.is(before, after))
          return false;
      } catch {
        /* The line reader below decides whether a malformed value needs repair. */
      }
    }
    const re = new RegExp(`^\\s*(${escapeRe(edit.key)})(\\s*=\\s*)(.*)$`);
    for (let i = 0; i < lines.length; i++) {
      if (sections[i] !== edit.section) continue;
      const m = re.exec(lines[i]!);
      if (!m) continue;
      const parts = splitTail(m[3]!);
      if (!parts) return true;
      if (parts.value === edit.value) return false;
      try {
        const before = parseToml(`value = ${parts.value}`)["value"];
        const after = parseToml(`value = ${edit.value}`)["value"];
        return typeof before === "object" || !Object.is(before, after);
      } catch {
        return true;
      }
    }
    return true;
  });
}

/** What the secrets dir holds, at the one resolution every step uses. */
function secretsReport(dir: string, userRoute: boolean): CheckResult {
  if (userRoute) {
    const missing = USER_ROUTE_SECRETS.filter((f) => !existsSync(join(dir, f)));
    return {
      name: "secrets",
      ok: true,
      detail: missing.length
        ? `${dir}: still missing ${missing.join(", ")} — the github_account step writes it from your GitHub sign-in (no App secrets on this route)`
        : `${dir}: your GitHub token is present — the own-account route needs no App secrets`,
    };
  }
  if (!existsSync(dir)) {
    return {
      name: "secrets",
      ok: true,
      detail: `${dir} does not exist yet — the App credential lands there (the manifest step writes it, or run \`bash deploy/collect-secrets.sh\`)`,
    };
  }
  const shape = (readTextOrNull(join(dir, "deploy_shape")) ?? "").trim();
  const required = [...REQUIRED_SECRETS, ...(shape === "tunnel" ? [TUNNEL_SHAPE_SECRET] : [])];
  const missing = required.filter((f) => !existsSync(join(dir, f)));
  return {
    name: "secrets",
    ok: true,
    detail: missing.length
      ? `${dir}: still missing ${missing.join(", ")} — filled by the GitHub App step or \`bash deploy/collect-secrets.sh\` (this step never asks for a secret)`
      : `${dir}: every secret this deployment shape needs is present`,
  };
}

function recordChoices(
  ctx: StepContext,
  facts: FillFacts,
  configPath: string,
  parsed: Config,
): void {
  ctx.recordChoice(CHOICE_KEYS.repo, facts.repo);
  ctx.recordChoice(CHOICE_KEYS.repoDir, expandHome(facts.reviewed_repo_dir));
  ctx.recordChoice(CHOICE_KEYS.appSlug, facts.app_slug);
  ctx.recordChoice(CHOICE_KEYS.baseBranch, facts.base_branch);
  ctx.recordChoice(CHOICE_KEYS.timezone, facts.timezone);
  ctx.recordChoice(CHOICE_KEYS.ownerLogin, facts.owner_github_login);
  ctx.recordChoice(CHOICE_KEYS.secretsDir, facts.secrets_dir);
  ctx.recordChoice(CHOICE_KEYS.configPath, configPath);
  ctx.recordChoice(CHOICE_KEYS.dryRun, parsed.dry_run);
  // The label NAMES this installation triggers on, straight off the file the
  // daemon itself reads — so the App step creates the labels this config
  // means rather than the shipped defaults (a customised label name would
  // otherwise be lost).
  ctx.recordChoice(CHOICE_KEYS.labels, {
    trigger: parsed.github.trigger_label,
    in_progress: parsed.github.in_progress_label,
    reviewed: parsed.github.reviewed_label,
  });
}

function previousAnswers(ctx: StepContext): Partial<Record<AnswerKey, string>> {
  const raw = ctx.data.answers;
  if (typeof raw !== "object" || raw === null) return {};
  const out: Partial<Record<AnswerKey, string>> = {};
  for (const [k, v] of Object.entries(raw as Record<string, unknown>)) {
    if (typeof v === "string") out[k as AnswerKey] = v;
  }
  return out;
}

/** The tool's argument schema: one optional string per interview question,
 * described by its title, prompt and the concept it teaches. */
function configFillParameters(): unknown {
  const properties: Record<string, { type: "string"; description: string }> = {};
  for (const q of QUESTIONS) {
    properties[q.id] = {
      type: "string",
      description: `${q.title}. ${q.prompt}${q.optional ? " Optional." : ""} ${q.teach}`,
    };
  }
  return { type: "object", properties };
}

export function configFillStep(opts: { transport?: TransportOptions } = {}): OnboardingStep {
  return {
    id: CONFIG_FILL_STEP_ID,
    title: "Interview and fill config.toml",
    explain:
      "Asks the handful of things only you can answer — the repository to review, your checkout of it, the App slug, " +
      "who you are, your timezone, the default branch — and computes everything else (the bot login, the clone " +
      "directory, the timezone cascade, the defect sink). It patches the shipped template in place, so every comment " +
      "in your config survives, and it re-runs as targeted edits over your own file rather than a rewrite. The review " +
      "flag `dry_run` is never written here: a fresh config ships the template's true, an existing one keeps exactly " +
      "the value it has, and going live is a separate, explicit act later. Pass the operator's answers as the " +
      "arguments (one per question; an omitted or blank one keeps the current value); a run that still lacks a " +
      "required answer names it and writes nothing.",
    order: 35,
    parameters: configFillParameters(),
    async run(ctx): Promise<StepReport> {
      const root = rootFromStateDir(ctx.adapters.paths.stateDir);
      const configPath = ctx.adapters.paths.configPath;
      const templatePath = templatePathFor(root);
      const current = readExisting(configPath);
      if (current.error !== null) {
        return {
          ok: false,
          checks: [
            {
              name: "config",
              ok: false,
              detail:
                `${configPath} exists but cannot be read (${current.error}) — nothing was written: replacing it from the ` +
                "template would lose every setting in it. Fix its ownership/permissions and run this step again",
            },
          ],
        };
      }
      const existing = current.text;
      const source = existing ?? readTextOrNull(templatePath);
      if (source === null) {
        return {
          ok: false,
          checks: [
            {
              name: "template",
              ok: false,
              detail: `neither ${configPath} nor the shipped template ${templatePath} is readable — is this a complete checkout?`,
            },
          ],
        };
      }

      const cfg = currentConfig(configPath);
      const collected = await collectAnswers(ctx, cfg, previousAnswers(ctx), existing);
      const checks: CheckResult[] = collected.ignored.map((i) => ({
        name: `answer:${i.id}`,
        ok: true,
        detail: i.detail,
      }));
      if (collected.missing.length || collected.rejected.length) {
        for (const m of collected.missing) {
          checks.push({
            name: `answer:${m.id}`,
            ok: false,
            detail: `${m.title} was never answered — ${m.guidance}`,
          });
        }
        for (const r of collected.rejected) {
          checks.push({
            name: `answer:${r.id}`,
            ok: false,
            detail: `the answer was not usable — ${r.guidance}`,
          });
        }
        return { ok: false, checks };
      }

      const facts = collected.facts;
      const wanted = buildEdits(facts, ctx.choices, existing === null, cfg ?? undefined);
      const edits = changedEdits(source, wanted);
      const rendered = edits.length ? patchToml(source, edits) : source;

      // Parse BEFORE writing: a config that would not load never reaches disk.
      let parsed: Config;
      const probe = writeProbe(ctx.adapters.paths.stateDir, rendered);
      try {
        parsed = loadConfig(probe);
      } catch (err) {
        return {
          ok: false,
          checks: [
            ...checks,
            {
              name: "loader",
              ok: false,
              detail: `the filled config would not load: ${String((err as Error).message)} — nothing was written`,
            },
          ],
        };
      } finally {
        rmSync(probe, { force: true });
      }
      if (existing === null && parsed.dry_run !== true) {
        return {
          ok: false,
          checks: [
            ...checks,
            {
              name: "dry_run",
              ok: false,
              detail:
                "the shipped template no longer ships dry_run = true — refusing to write (rule 1)",
            },
          ],
        };
      }

      if (rendered !== source) writeAtomic(configPath, rendered);
      const delivery = await deliverConfigChange(
        ctx,
        opts.transport,
        ctx.data.restart_owed === true || (existing !== null && rendered !== source),
        CONFIG_FILL_STEP_ID,
      );
      checks.push(...delivery.checks);

      checks.push({
        name: "config",
        ok: true,
        detail:
          rendered === source
            ? `${configPath} already carried every answer — nothing rewritten`
            : `${configPath} ${existing === null ? "created from config.example.toml" : "updated"}: ${edits.length} key${edits.length === 1 ? "" : "s"} (${edits
                .map((e) => `${e.section ? `[${e.section}] ` : ""}${e.key}`)
                .join(", ")})`,
      });
      checks.push({
        name: "loader",
        ok: true,
        detail: "the strict loader parses the file as written",
      });
      for (const d of DERIVABLES) {
        const reason = d.holds(parsed, facts);
        checks.push(
          reason === null
            ? { name: `derived:${d.id}`, ok: true, detail: `${d.path} — ${d.explain}` }
            : { name: `derived:${d.id}`, ok: false, detail: reason },
        );
      }
      checks.push({
        name: "dry_run",
        ok: true,
        detail: `dry_run = ${parsed.dry_run} — untouched by this step; every GitHub mutation is recorded to state/dryrun/ while it is true`,
      });
      // Which shape the fill was made for, said out loud: the two conditional
      // questions hang off these, and an unrecorded choice is an ASSUMPTION,
      // never a silent one. The topology/ingress steps own the choices; this
      // step only reads them.
      checks.push({
        name: "shape",
        ok: true,
        detail:
          `topology ${facts.topology || "(unrecorded — filled for a daemon on this machine, so [tui] ssh_host stays empty)"}, ` +
          `ingress ${facts.ingress || "(unrecorded — filled for an ingress that assigns its own hostname, so [server] hostname stays empty)"}, ` +
          `github ${facts.github_auth === "user" ? "own account (no App questions, no App secrets)" : "App"}` +
          `${str(ctx.choices, CHOICE_KEYS.authRoute) ? `, auth route ${str(ctx.choices, CHOICE_KEYS.authRoute)}` : ""}`,
      });
      // Read after the write, so the dir is the one the written config names.
      checks.push(
        secretsReport(secretsDirFor(ctx.adapters, ctx.choices), userAuthRecorded(ctx.choices)),
      );

      const ok = checks.every((c) => c.ok);
      if (ok) recordChoices(ctx, facts, configPath, parsed);
      return {
        ok,
        checks,
        data: {
          answers: Object.fromEntries(
            QUESTIONS.filter((q) => questionAsked(q, ctx.choices)).map((q) => [q.id, facts[q.id]]),
          ),
          config_path: configPath,
          restart_owed: delivery.restartOwed,
          filled_from: existing === null ? "config.example.toml" : "config.toml",
        },
      };
    },
    async verify(ctx): Promise<StepReport> {
      const configPath = ctx.adapters.paths.configPath;
      if (!existsSync(configPath)) {
        return {
          ok: false,
          checks: [
            {
              name: "config",
              ok: false,
              detail: `${configPath} does not exist — run the config step`,
            },
          ],
        };
      }
      let cfg: Config;
      try {
        cfg = loadConfig(configPath);
      } catch (err) {
        return {
          ok: false,
          checks: [
            {
              name: "loader",
              ok: false,
              detail: `${configPath} does not load: ${String((err as Error).message)}`,
            },
          ],
        };
      }
      const checks: CheckResult[] = [
        ...configDeliveryChecks(ctx),
        { name: "loader", ok: true, detail: `${configPath} parses under the strict loader` },
      ];
      const previous = previousAnswers(ctx);
      for (const q of QUESTIONS) {
        if (!questionAsked(q, ctx.choices)) continue;
        const current = q.read(cfg);
        if (!current) {
          checks.push(
            q.optional
              ? { name: `answer:${q.id}`, ok: true, detail: `${q.title}: empty (optional)` }
              : {
                  name: `answer:${q.id}`,
                  ok: false,
                  detail: `${q.title} is still empty in ${configPath} — re-run the config step`,
                },
          );
          continue;
        }
        const reason = q.validate(current);
        if (reason !== null) {
          checks.push({
            name: `answer:${q.id}`,
            ok: false,
            detail: `${q.title} is not usable as configured: ${reason}`,
          });
          continue;
        }
        const recorded = previous[q.id];
        checks.push({
          name: `answer:${q.id}`,
          ok: true,
          detail:
            recorded && recorded !== current
              ? `${q.title}: "${current}" (changed since onboarding — your file wins)`
              : `${q.title}: "${current}"`,
        });
      }
      // Only the STABLE derivations are invariants; the rest are fill-time
      // defaults the operator is free to change afterwards.
      const facts: FillFacts = {
        ...(Object.fromEntries(QUESTIONS.map((q) => [q.id, q.read(cfg)])) as Record<
          AnswerKey,
          string
        >),
        secrets_dir: cfg.github.secrets_dir,
        topology: str(ctx.choices, CHOICE_KEYS.topology),
        ingress: str(ctx.choices, CHOICE_KEYS.ingress),
        github_auth: str(ctx.choices, CHOICE_KEYS.githubAuth),
        account_login: str(ctx.choices, CHOICE_KEYS.accountLogin),
      };
      for (const d of DERIVABLES) {
        if (!d.stable) continue;
        const reason = d.holds(cfg, facts);
        checks.push(
          reason === null
            ? { name: `derived:${d.id}`, ok: true, detail: `${d.path} holds` }
            : { name: `derived:${d.id}`, ok: false, detail: reason },
        );
      }
      // dry_run is REPORTED, never judged: true is the shipped posture and
      // false is the owner's own flip (rule 1). Neither is red.
      checks.push({
        name: "dry_run",
        ok: true,
        detail: `dry_run = ${cfg.dry_run} (the owner's flag; this step never writes it)`,
      });
      return { ok: checks.every((c) => c.ok), checks };
    },
  };
}

/** Write the candidate to a scratch file under the state dir and hand back its
 * path, so the REAL loader (not a re-implementation of it) is what decides
 * whether the fill is good — before anything lands on config.toml. */
function writeProbe(stateDir: string, content: string): string {
  const path = join(stateDir, "onboarding", "config.candidate.toml");
  writeAtomic(path, content);
  return path;
}
