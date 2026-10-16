// The onboarding choice vocabulary — one declaration of every key the steps
// hand each other, and of every value vocabulary both sides of a handoff must
// agree on.
//
// Why this file exists: each step is tested against its own fake choices, so
// every per-step suite can stay green while the composed flow is broken — a
// reader looking under a key no step writes, or testing for a value the writer
// never records. Two rules prevent that, and `tests/onboard-choices.test.ts`
// enforces both:
//
//   1. No step carries its own string literal for a shared key. Every read and
//      every write names `CHOICE_KEYS.x`; a step's exported `*_CHOICE_KEY`
//      constants are aliases of these, kept only so existing call sites and
//      tests read naturally. A typo is then a compile error, not a silent miss.
//   2. Every declared key has a writer. `CHOICE_WRITERS` names the step(s) that
//      record each key, and the test proves each named step really does — so a
//      key that only ever gets read cannot survive review.
//
// A key private to one step — the go-live decision, the bring-up timestamp, the
// vm-deploy record, the model prefix, the memory key-file path — stays a local
// constant in that step. This file is about the handoffs.
//
// Nothing here imports a step (the steps import this), so there is no cycle and
// no ordering hazard.

// ---- value vocabularies ------------------------------------------------------
// Declared once and imported by both sides of the handoff, so a mismatch is a
// type error rather than a conditional that never fires.

/** Where the reviewer runs. Absent ⇒ "local" (see `topologyOf`). */
export const TOPOLOGY_CHOICES = ["vm", "local"] as const;
export type Topology = (typeof TOPOLOGY_CHOICES)[number];

/** The webhook ingress shapes. These four ids are also the operator-facing
 * names in `INGRESS_OPTIONS` and in docs/onboarding.md. */
export const INGRESS_CHOICES = ["quick", "ngrok", "named", "polling"] as const;
export type IngressChoice = (typeof INGRESS_CHOICES)[number];

/** The LLM auth routes. "api" is the API-key route — not "api_key": the value
 * the LLM step writes is the value every reader must test for. */
export const AUTH_ROUTES = ["oauth", "api"] as const;
export type AuthRoute = (typeof AUTH_ROUTES)[number];

/** "owner/name" — the reviewed repo as the interview records it and the App
 * step parses it: no URL, no trailing `.git`. */
export const REPO_SLUG_RE = /^([A-Za-z0-9._-]+)\/([A-Za-z0-9._-]+)$/;

/** Whether the operator set memory up or declined it (a supported answer). */
export const MEMORY_CHOICE_IDS = ["configure", "declined"] as const;
export type MemoryChoice = (typeof MEMORY_CHOICE_IDS)[number];

// ---- the keys ----------------------------------------------------------------

/**
 * Every choice key handed from one step to another, with the step that writes
 * it and the step(s) that read it. The comment on each is the contract: change
 * the value here and every side moves together.
 */
export const CHOICE_KEYS = {
  /** The operator's uid, captured by preflight so the images are built with it. */
  uid: "qcr_uid",

  /** `Topology`. Written by the topology step; read by everything that has to
   * know where the stack runs (transport selection, the VM-only steps). */
  topology: "topology",
  /** The ssh alias of the review host (VM route). */
  sshAlias: "vm_ssh_alias",
  /** The login user ssh resolves for that alias (VM route). */
  sshUser: "vm_ssh_user",

  /** `AuthRoute`. Written by the LLM step; read by the interview's shape line. */
  authRoute: "llm_auth_route",

  /** "owner/name" of the reviewed repo. Written by the interview; read by the
   * GitHub App step and the proof round. */
  repo: "reviewed_repo",
  /** The operator's local checkout of the reviewed repo. */
  repoDir: "reviewed_repo_dir",
  /** The repo's default branch. */
  baseBranch: "base_branch",
  /** IANA ops timezone. */
  timezone: "ops_timezone",
  /** The operator's GitHub login. */
  ownerLogin: "owner_github_login",
  /** The secrets dir the daemon reads — the App step and the slug reconcile
   * both resolve their credentials through it. */
  secretsDir: "secrets_dir",
  /** Absolute path of the config.toml the interview wrote. */
  configPath: "config_path",
  /** What `dry_run` the written config carries (informational for go-live). */
  dryRun: "config_dry_run",
  /** The three label names the config carries, so the App step creates the
   * labels this installation actually triggers on rather than the defaults. */
  labels: "github_labels",

  /** The App slug. Written by the interview (the operator's answer), then
   * corrected by the App step and the slug reconcile from GitHub itself. */
  appSlug: "github_app_slug",
  /** `botLoginFor(slug)` — how the daemon recognises its own reviews. */
  botLogin: "github_bot_login",
  /** Numeric App id. */
  appId: "github_app_id",
  /** "personal" | "org:<login>" — where the App is registered. */
  appTarget: "github_app_target",
  /** The App name the operator chose (absent ⇒ a suggested unique name). */
  appName: "github_app_name",
  /** The installation id on the repo's owner. */
  installationId: "github_installation_id",
  /** The App's page on GitHub. */
  appHtmlUrl: "github_app_html_url",

  /** `IngressChoice`. Written by the ingress step; read by the interview
   * (does the operator own the hostname?), compose/inventory (which sidecar)
   * and the verification layer. */
  ingress: "ingress_choice",
  /** The public hostname, where the chosen shape has one the operator owns. */
  ingressHostname: "ingress_hostname",
  /** The public webhook endpoint, once a stable hostname is settled — the App
   * step puts it in the manifest instead of the artifact's placeholder. */
  webhookUrl: "webhook_url",

  /** `MemoryChoice`. Written by the memory step; read by its phase-B peer. */
  memory: "memory_setup",

  /** The proof round record. Written by the proof step; read by go-live. */
  proof: "proof_round_completed",
} as const;

export type ChoiceName = keyof typeof CHOICE_KEYS;
export type ChoiceKey = (typeof CHOICE_KEYS)[ChoiceName];

/**
 * Which step records each key. Pinned against the sources by
 * `tests/onboard-choices.test.ts`: every name here must be written by every
 * step id listed, and no shared key may be left with no writer at all.
 */
export const CHOICE_WRITERS: Record<ChoiceName, readonly string[]> = {
  uid: ["preflight"],
  topology: ["topology"],
  sshAlias: ["topology"],
  sshUser: ["ssh_preflight"],
  authRoute: ["llm_auth"],
  repo: ["config_fill"],
  repoDir: ["config_fill"],
  baseBranch: ["config_fill"],
  timezone: ["config_fill"],
  ownerLogin: ["config_fill"],
  secretsDir: ["config_fill"],
  configPath: ["config_fill"],
  dryRun: ["config_fill"],
  labels: ["config_fill"],
  appSlug: ["config_fill", "github_app", "app_slug_reconcile"],
  botLogin: ["github_app", "app_slug_reconcile"],
  appId: ["github_app"],
  appTarget: ["github_app"],
  appName: ["github_app"],
  installationId: ["github_app"],
  appHtmlUrl: ["github_app"],
  ingress: ["ingress"],
  ingressHostname: ["ingress"],
  webhookUrl: ["ingress"],
  memory: ["memory"],
  proof: ["proof_round"],
};

/**
 * Keys deliberately private to one step: the step records them for its own
 * later verify() and nothing else ever reads them, so they stay a local literal
 * in that file rather than joining the shared vocabulary above.
 *
 * This is a closed list, and `tests/onboard-choices.test.ts` holds it shut: a
 * literal-keyed choice constant in a step must appear here (naming the one step
 * that owns it) and must be referenced by no other step. To hand a value to
 * another step you therefore have to declare it in `CHOICE_KEYS`, where the
 * writer check applies.
 */
export const PRIVATE_CHOICE_KEYS: Readonly<Record<string, string>> = {
  llm_model_prefix: "llm_auth",
  openviking_keys_file: "memory",
  stack_brought_up_at: "bringup",
  vm_deployed: "vm_deploy",
  go_live_decision: "go_live",
};

/** The bot login GitHub gives an App with this slug. One rule, one place —
 * every step that writes or checks `[github] bot_login` derives it here. */
export function botLoginFor(slug: string): string {
  return `${slug}[bot]`;
}

// ---- typed readers -----------------------------------------------------------
// The few places a value vocabulary is tested. Each is total: an absent or
// unrecognised value is the documented default, never a throw.

function raw(choices: Readonly<Record<string, unknown>>, key: ChoiceKey): string {
  const v = choices[key];
  return typeof v === "string" ? v.trim() : "";
}

/** `value` when it is a member of `vocabulary`, else null. */
export function memberOf<T extends string>(vocabulary: readonly T[], value: string): T | null {
  return (vocabulary as readonly string[]).includes(value) ? (value as T) : null;
}

/** The recorded auth route, or null when the LLM step has not run. */
export function authRouteOf(choices: Readonly<Record<string, unknown>>): AuthRoute | null {
  return memberOf(AUTH_ROUTES, raw(choices, CHOICE_KEYS.authRoute));
}

/** The recorded ingress shape, or null when the ingress step has not run. */
export function ingressChoiceOf(choices: Readonly<Record<string, unknown>>): IngressChoice | null {
  return memberOf(INGRESS_CHOICES, raw(choices, CHOICE_KEYS.ingress));
}
