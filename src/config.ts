// Typed access to config.toml — the single source of every runtime knob.
// The review sections (their types, defaults and parsers) live in
// packages/pi-plugin/src/reviewconfig.ts, the core's half; this module adds every other
// surface's, the install homes and the live config's loader, and re-exports
// the review half so its importers need not know where a knob lives.
import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { resolve, dirname, isAbsolute, join } from "node:path";
import { fileURLToPath } from "node:url";
import { parse } from "smol-toml";
import {
  locateConfig,
  locateSecrets,
  missingConfigMessage,
  strandedCheckoutConfig,
} from "./install.js";
import { packageRootFrom } from "@quickchatai/pi-quickreview/src/assetroot.js";
import { repoCloneDirName } from "./clonedir.js";
import { MissingConfigError } from "./missingconfig.js";
import { DEFAULT_LENS_GRANT_STAGGER_MS, DEFAULT_LENS_PERMITS } from "./ipc/permits.js";
import {
  configDeprecations,
  foldLegacyOwnerSlackId,
  MEMORY_DELIVERY_MODES,
  parseEngine,
  parseEscalation,
  parseGithubSection,
  parseGuardsSection,
  parseModels,
  parseOwnerSection,
  parsePiSection,
  parseReviewSection,
  parseScan,
  presetOf,
  req,
  requireGithubKeys,
  REVIEW_PRESETS,
  validateReviewSection,
  type CoreConfig,
  type GithubConfig,
  type MemoryDelivery,
  type OwnerConfig,
} from "@quickchatai/pi-quickreview/src/reviewconfig.js";

export * from "@quickchatai/pi-quickreview/src/reviewconfig.js";

/** Directory name of the base clone: `[github] clone_dir` when set, else the
 * repo slug's basename ("owner/name" → "name"; a URL's trailing path segment,
 * `.git` stripped), e.g. "acme/webapp" ⇒ "webapp". */
export function githubCloneDir(g: Pick<GithubConfig, "clone_dir" | "repo">): string {
  // ?? "": hand-rolled configs (tests) may omit both keys.
  const explicit = (g.clone_dir ?? "").trim();
  if (explicit) return explicit;
  return repoCloneDirName(g.repo ?? "");
}

/** Where the daemon container lives relative to the TUI. `"ssh"` is
 * the VM topology (every remote op rides `ssh <ssh_host> …`); `"local"` is the
 * laptop topology (the SAME commands run against local docker directly, and no
 * ssh process is ever spawned). Always explicit — never inferred from a magic
 * ssh_host value. */
export type TuiTarget = "ssh" | "local";

export interface TuiConfig {
  /** Transport for every TUI remote op (see TuiTarget). Default "ssh". */
  target: TuiTarget;
  /** ssh alias of the box running the container. Ignored when target = "local". */
  ssh_host: string;
  container: string;
  /** The container the memory forward relays into, when OpenViking does not
   * live in `container`: the memory sidecar (`[openviking] endpoint =
   * "remote"`, docker/memory/). Empty = `container` (the in-container
   * server). See `tuiMemoryContainer`. */
  memory_container: string;
  remote_state_dir: string;
  /** The app root inside the daemon container. "" (the default) = resolved
   * from the running container's `qcr.layout` label (src/tui/layout.ts): the
   * release image is /opt/qcr, the legacy container (no label)
   * /opt/quickreview/sandbox. A set value wins and is never probed. */
  remote_sandbox_root: string;
  sudo_docker: boolean;
  poll_interval_s: number;
  /** DATA STALE banner when status.json's written_at ages past this — sized
   * to the daemon's ~30s write cadence, not the TUI's fetch cadence. */
  stale_after_s: number;
  msg_timeout_s: number;
  /** Per-remote-read budget for the finished-round evidence copier.
   * Every artefact fetch is killed at this age, so a wedged ssh control master
   * costs one sweep and nothing else — never the poll, never the paint loop. */
  evidence_timeout_s: number;
  /** The evidence sweep's pace — the minimum gap between the end of
   * one `qcr why` exec and the start of the next (each costs the container
   * ~0.5–1 s of CPU), whatever the poll cadence. Clamped to 5–600 s
   * (`evidenceWhyIntervalMs`, src/tui/evidence.ts); the pacing cannot be
   * switched off. */
  evidence_why_interval_s: number;
}

/** The local companion container. Host paths are expanded; empty
 * strings mean "derive from the sandbox root" at parse time. */
export interface CompanionConfig {
  /** `qcr tui` starts the companion unless this is off or --no-companion. */
  enabled: boolean;
  container_name: string;
  image: string;
  /** Named volume for the companion's own pihome (OAuth, sessions, memory). */
  pihome_volume: string;
  /** tmux session name inside the container. */
  session: string;
  model: string;
  /** Host path of the review-sandbox repo → /workspace (rw). */
  repo_dir: string;
  /** Host path of the issue tracker → /tracker (rw, actor `companion`). */
  tracker_dir: string;
  /** Host path of the tracker's protocol docs → /tracker-docs (READ-ONLY).
   * Sits outside `tracker_dir`, so it needs its own mount: without it the
   * companion drives wayfinder from a summary instead of the real adapter. */
  tracker_docs_dir: string;
  /** Host path of the REVIEWED repo → /reviewed-repo, READ-ONLY. The
   * companion reads the code a review is about; it can never write to it, and
   * rule 8's boundary is otherwise unchanged (no GitHub write, no gate, no
   * deploy.sh, no VM credential). A missing checkout simply drops the mount —
   * under-equipped, never broken. */
  reviewed_repo_dir: string;
  /** Host dir the TUI copies finished-round evidence into → /evidence,
   * READ-ONLY. The companion reads transcripts, ledgers, prompts and
   * verdicts as plain files; it gains NO ssh, no credential and no new reach —
   * the TUI holds the VM access and does all the fetching. Read-only because
   * this is a RECORD: the companion reads history, it never rewrites it.
   * Empty ⇒ `<sandbox root>/evidence` (gitignored); the default lives outside
   * the repo because the store grows without bound and is kept indefinitely. */
  evidence_dir: string;
  /** Host dir the TUI writes ambient snapshots into → /feed. */
  feed_dir: string;
  /** Host dir the companion writes alert files into → /alerts. */
  alerts_dir: string;
  /** Accepted so an older config still loads, and read by nothing: the
   * companion never mounts `~/.ssh` (no ssh config, no agent socket). */
  ssh_dir: string;
  /** Docker build context for the companion image (auto-built when
   * missing): the app root. The image is the release image, built from
   * `docker/Dockerfile` under it, which compiles the app itself. */
  build_context: string;
  // --- watcher knobs ---
  /** A round overdue by more than this is worth waking the operator for. */
  overdue_grace_min: number;
  /** status.json older than this counts as a stale-daemon alert. */
  stale_alert_s: number;
  /** A PR sitting in awaiting_author longer than this is nag-worthy. */
  awaiting_age_h: number;
  /** Minimum gap between two alerts about the same subject. */
  cooldown_min: number;
}

/** [backfill] — knobs for the one-shot GitHub history importer.
 * Every default is derived from [github] at parse time; the section exists so
 * a re-run against a renamed label/identity needs no code change. */
export interface BackfillConfig {
  /** Review author to import (GraphQL `reviews(author:)`, with the [bot] suffix). */
  bot_login: string;
  /** The same identity as a timeline *actor* — GraphQL drops the [bot] suffix. */
  bot_actor: string;
  /** Label whose presence marks a PR as part of the bot-review era. */
  reviewed_label: string;
  /** Label a human adds to request a review — a trigger candidate. */
  trigger_label: string;
  /** Label the bot adds when a round starts — the fallback trigger candidate. */
  in_progress_label: string;
  /** Team slug whose review request is a trigger (bare slug, no org prefix). */
  review_team_slug: string;
  /** Per-PR detail queries in flight at once (kept small on purpose). */
  concurrency: number;
  /** Search pages per enumeration query (100 hits each; search caps at 1,000). */
  max_search_pages: number;
}

// ---- [slack] — the Slack concierge ----
// Tokens are never in config. `bot_token_file` / `app_token_file` name flat
// files under [github].secrets_dir, read the way every other secret is
// (PiSessionManager.secret / TokenMinter): the config carries the file NAME.

/** One announcement cause: may it speak at all, and how often. */
export interface SlackCausePolicy {
  enabled: boolean;
  /** 0 = no cooldown (every occurrence fires). */
  cooldown_min: number;
}

export interface SlackPolicyConfig {
  /** Channel-wide model turns per policy day. */
  daily_turns: number;
  /** Per-person model turns per policy day. */
  per_user_daily_turns: number;
  /** Daemon posts into any ONE thread per policy day. */
  thread_replies_per_day: number;
  /** Accepted so an older config still loads, and read by nothing: the
   * policy's turn caps are the daily and per-person ones above. */
  soft_exchange_limit: number;
  /** Rolling-hour ceiling on announcements (they bypass turn caps, not this). */
  announcements_per_hour: number;
  /** Cooldown for a cause with none of its own: one outside the built-in
   * table that is unlisted, or listed in [slack.policy.causes] without a
   * `cooldown_min`. A built-in cause keeps its own unless that table sets one. */
  default_cooldown_min: number;
  /** The day boundary for every cap here — DST-correct via src/eod.ts. */
  timezone: string;
  pickup_grace_min: number;
  downtime_notice_min: number;
  heartbeat_interval_min: number;
  /** Accepted so an older config still loads, and read by nothing: no
   * code raises the `reconcile.storm` announcement this would threshold. */
  storm_corrections: number;
  /** Accepted so an older config still loads, and read by nothing: no
   * code raises the `pr.awaiting_author_stale` announcement this would time. */
  awaiting_author_stale_h: number;
  /** Accepted so an older config still loads, and read by nothing: a
   * verdict always stays in-thread, never `reply_broadcast`, whatever this
   * says — the announcer has no broadcast parameter. */
  broadcast_verdicts: "never" | "always";
  causes: Record<string, SlackCausePolicy>;
}

export interface SlackConfig {
  enabled: boolean;
  /** The ONE channel id the concierge lives in; empty ⇒ cannot enable. */
  channel: string;
  channel_kind: "public" | "private";
  /** File name under [github].secrets_dir holding the xoxb- bot token. */
  bot_token_file: string;
  /** File name under [github].secrets_dir holding the xapp- socket token. */
  app_token_file: string;
  post_min_interval_ms: number;
  reconnect_backoff_ms: number[];
  server_ping_timeout_ms: number;
  /** Accepted so an older config still loads, and read by nothing: Slack
   * inbound turns are retired, so no backlog message is ever replayed or aged. */
  catchup_max_age_s: number;
  max_reply_chars: number;
  name_cache_ttl_s: number;
  /** Slack member id → GitHub login. The ONLY source of own-PR rights. */
  users: Record<string, string>;
  policy: SlackPolicyConfig;
}

/** Per-cause defaults. Absent causes fall back to `default_cooldown_min`. */
export const SLACK_CAUSE_DEFAULTS: Record<string, SlackCausePolicy> = {
  "round.overdue": { enabled: true, cooldown_min: 60 },
  "round.malformed_verdict": { enabled: true, cooldown_min: 60 },
  "review.failed_loud": { enabled: true, cooldown_min: 60 },
  "pr.not_picked_up": { enabled: true, cooldown_min: 120 },
  "daemon.up": { enabled: true, cooldown_min: 0 },
  "daemon.stopping": { enabled: true, cooldown_min: 0 },
  "slack.cap_reached": { enabled: true, cooldown_min: 0 },
  "reconcile.storm": { enabled: false, cooldown_min: 180 },
  "digest.eod": { enabled: false, cooldown_min: 0 },
  "pr.awaiting_author_stale": { enabled: false, cooldown_min: 1440 },
};

export const SLACK_POLICY_DEFAULTS: SlackPolicyConfig = {
  daily_turns: 80,
  per_user_daily_turns: 20,
  thread_replies_per_day: 6,
  soft_exchange_limit: 3,
  announcements_per_hour: 20,
  default_cooldown_min: 60,
  // Effective value comes from [slack.policy] timezone, else [ops] timezone
  // (parseSlack) — this static default (= OPS_DEFAULTS.timezone, declared
  // below) only reaches direct constructions that bypass parseConfig.
  timezone: "UTC",
  pickup_grace_min: 20,
  downtime_notice_min: 5,
  heartbeat_interval_min: 5,
  storm_corrections: 5,
  awaiting_author_stale_h: 48,
  broadcast_verdicts: "never",
  causes: SLACK_CAUSE_DEFAULTS,
};

/** [slack] is optional in config.toml, exactly like [tui] / [companion]. */
export const SLACK_DEFAULTS: SlackConfig = {
  enabled: false,
  channel: "",
  channel_kind: "public",
  bot_token_file: "slack_bot_token",
  app_token_file: "slack_app_token",
  post_min_interval_ms: 1100,
  reconnect_backoff_ms: [1000, 2000, 5000, 15000, 30000],
  server_ping_timeout_ms: 30000,
  catchup_max_age_s: 300,
  max_reply_chars: 3000,
  name_cache_ttl_s: 86400,
  users: {},
  policy: SLACK_POLICY_DEFAULTS,
};

/**
 * [recheck] — the post-approval delta recheck. One knob per trigger,
 * so a noisy trigger can be taken out of the path deliberately, in one place.
 * All on: the uphold-by-default design is what makes the broad set affordable.
 */
export interface RecheckConfig {
  enabled: boolean;
  /** A push landing after an approve — the core case. */
  on_push: boolean;
  /** CI completing at the approved head; an adverse conclusion is evidence. */
  on_ci: boolean;
  /** The base branch moving under an approved PR (the noisiest by far). */
  on_base_advance: boolean;
}

export const RECHECK_DEFAULTS: RecheckConfig = {
  enabled: true,
  on_push: true,
  on_ci: true,
  on_base_advance: true,
};

/**
 * OpenViking (github.com/volcengine/OpenViking) — the context store the daemon
 * runs as a SECOND process inside the container, on loopback :1933.
 *
 * Three invariants live in this block rather than in prose:
 *
 *   * `version` + `llama_cpp_python_version` are the TRIPLE-MIRRORED pins —
 *     this block == `deploy/ansible/group_vars/all.yml` == the Dockerfile venv
 *     layer, exactly like the `[pi]` pin. `tests/openviking.test.ts` fails on
 *     drift, and the running server's self-reported version is drift-checked
 *     against `version` in the heartbeat.
 *   * `host` is loopback and the port is NEVER published out of the container
 *     (the playbook's `published_ports` carries only the webhook port).
 *   * every path here is a CONTAINER path; on a dev PC the binary is absent,
 *     which the supervisor treats as "unavailable", not as a crash loop.
 */
export interface OpenVikingConfig {
  /** Off ⇒ the supervisor is never constructed and status.json says so. */
  enabled: boolean;
  /** Who runs the server. `local` (the default, and what every live daemon
   * does) supervises it, and the local embedder, as children of this process.
   * `remote` is the memory sidecar (docker/memory/): `host`:`port` names a
   * server some other container runs, the daemon only probes its health, and
   * the sidecar owns the processes, the boot provisioning and the re-embed
   * migration. */
  endpoint: OpenVikingEndpoint;
  /** The pinned server version (mirror 1 of 3). */
  version: string;
  /** Pinned llama-cpp-python: an OPTIONAL extra openviking does not declare,
   * without which the default local dense embedder raises
   * EmbeddingConfigurationError at startup (verified against 0.4.15). */
  llama_cpp_python_version: string;
  /** Upstream base commit of the vendored pi extension. Pinned beside the
   * server version so `tests/openviking-fork.test.ts` gates drift instead of
   * letting a bump rebase silently onto new upstream behaviour. */
  extension_commit: string;
  /** OpenViking user the daemon and review sessions act as. Their key is
   * confined to this user server-side — that confinement is what keeps
   * companion memory out of a posted review. */
  user: string;
  /** Tenant account; empty ⇒ derived from the key. */
  account: string;
  /** Secret FILE NAME under [github].secrets_dir holding the reviewer USER
   * key. Never an ADMIN or ROOT key: ADMIN grants no cross-user data access
   * and can list every user key in plaintext. */
  reviewer_key_file: string;
  /** ov.conf `server.auth_mode`. `api_key` is the required posture:
   * every request carries a USER key the server CONFINES to its own tree, and
   * that confinement is the only thing keeping companion memory out of a
   * posted review. `dev` bypasses authentication entirely — it is a local
   * development escape hatch, never the deployed value. MIRRORED into
   * `deploy/ansible/group_vars/all.yml` (`openviking_auth_mode`), which the
   * entrypoint template renders; `tests/openviking.test.ts` and the
   * `scripts/deploy.sh` preflight both fail on drift. */
  auth_mode: string;
  /** Secret FILE NAME under the container's secrets mount holding the
   * server's OWN root key — the credential ov.conf needs to run in `api_key`
   * mode and to mint users at boot. It is the server's, never a client's: no
   * daemon surface, no review session and no companion process ever reads it
   * (`writeOvcliConf` refuses it as a session credential and the bash guard
   * refuses to read the files that hold it). Mirrored as
   * `openviking_root_key_file`. */
  root_key_file: string;
  /** The OpenViking users boot provisioning ENSURES exist — created if
   * absent, left exactly as they are if present. Never rotated: a rotation
   * would orphan the keys already distributed to the companion's PC. Mirrored
   * as `openviking_provision_users` (comma-joined). */
  provision_users: string[];
  request_timeout_ms: number;
  /** Tighter than `request_timeout_ms`: a search sits on the round-build
   * path, where the deadline in [memory] is the real guard. It must exceed
   * one document embedding on the live VM. Clamped to
   * `SEARCH_TIMEOUT_BOUNDS_MS`; a seed that sent its search late passes its
   * time left, and the search takes the shorter. */
  search_timeout_ms: number;
  /** Where an entry lands when the writer names no category. */
  default_category: string;
  read_cache_ttl_ms: number;
  host: string;
  port: number;
  /** `openviking-server` inside the image's venv. */
  bin: string;
  /** `~/.openviking` is symlinked here at boot — it must sit on the state
   * volume so memory survives an image rebuild. */
  home: string;
  /** Empty ⇒ `<home>/ov.conf` (the path the boot template writes). */
  config_file: string;
  /** Empty ⇒ `<home>/workspace` (ov.conf `storage.workspace`). */
  workspace: string;
  /** ov.conf `server.workers` — one worker on a 2-CPU cap. */
  workers: number;
  /** Accepted, and read by nothing in the daemon: the entrypoint that
   * templates ov.conf takes its queue concurrency from the deploy
   * (`openviking_queue_concurrency` in group_vars, or
   * `QCR_OPENVIKING_QUEUE_CONCURRENCY` for the plain image), never from here. */
  queue_concurrency: number;
  /** Health-poll cadence; the heartbeat reports the CACHED sample, so
   * status.json writing never waits on the network. */
  health_interval_s: number;
  /** The supervisor's `/health` + `/ready` probe and the local embedder's
   * `/health` probe. `/ready` runs an embedding, so it queues behind a case
   * batch's embeddings — a shorter timeout makes `/ready` flap and can tip
   * memory health to degraded. It is the timeout behind memory health's
   * "serving" half (`memoryServing`). Clamped to `HEALTH_TIMEOUT_BOUNDS_MS`. */
  health_timeout_ms: number;
  /** Restart backoff ladder; the last entry is the ceiling. The supervisor
   * never gives up — a memory engine that stays down is worse than a slow
   * retry, and every call site already degrades memory-less. */
  restart_backoff_ms: number[];
  /** A child that stayed up this long resets the backoff ladder. */
  restart_reset_after_s: number;
  /** Which embedder memory runs. `local` is the shipped
   * default: the LOCAL ENGLISH EMBEDDER (`LOCAL_EMBEDDING`) — a loopback
   * service inside the container, so no memory text leaves the machine.
   * `openai` is the explicit hosted opt-in and needs `embedding_key_file` in
   * the secrets dir. Mirrored as `openviking_embedding_provider`. This is the
   * operator's word, not ov.conf's: under `local` the entrypoint renders
   * ov.conf's OpenAI-COMPATIBLE provider with `api_base` on loopback
   * (`ovConfEmbedder`). */
  embedding_provider: EmbeddingProvider;
  /** ov.conf `embedding.dense.model` / `.dimension`. Under `local` they are
   * the local embedder's model and its fixed dimension (`LOCAL_EMBEDDING`);
   * under `openai` the operator names the hosted model and its dimension. */
  embedding_model: string;
  embedding_dimension: number;
  /** Secrets-dir file name of the HOSTED embeddings credential — deliberately
   * NOT `openai_api_key` (pi's model credential), so the two can be set
   * independently. Read only by the ov.conf render, only under `openai`. */
  embedding_key_file: string;
  /** The local embedder's MODEL FILE pin (the version-pinning rule): the GGUF the
   * image downloads at BUILD time from `local_embedder_url`, verified against
   * `local_embedder_sha256` there and again by the service at every start.
   * TRIPLE-MIRRORED like `version`: this block == group_vars
   * (`openviking_local_embedder_*`) == the memory Dockerfile's model layer —
   * `tests/openviking.test.ts`, `tests/memory-image.test.ts` and the
   * `scripts/deploy.sh` preflight refuse on drift. The file's basename is
   * `<LOCAL_EMBEDDING.model>.gguf`; the image carries the file whatever the
   * provider, so a hosted opt-in can come back to local without a rebuild. */
  local_embedder_file: string;
  local_embedder_url: string;
  local_embedder_sha256: string;
  /** The service listens on 127.0.0.1 at this port — never published; ov.conf's
   * `api_base` names it. Mirrored as `openviking_local_embedder_port`. */
  local_embedder_port: number;
  /** llama.cpp threads for the service. One is the budget the model was chosen
   * on (~25 ms for a round's context query): the container has two CPUs and a
   * review round to run. Mirrored as `openviking_local_embedder_threads`. */
  local_embedder_threads: number;
}

export const OPENVIKING_ENDPOINTS = ["local", "remote"] as const;
export type OpenVikingEndpoint = (typeof OPENVIKING_ENDPOINTS)[number];

export const EMBEDDING_PROVIDERS = ["local", "openai"] as const;
export type EmbeddingProvider = (typeof EMBEDDING_PROVIDERS)[number];

/**
 * The LOCAL ENGLISH EMBEDDER: the model
 * `embedding_provider = "local"` runs, served on loopback by
 * `scripts/openviking-embedder.py` from the GGUF the image pins. Chosen by an
 * offline retrieval evaluation over the reviewer's own memory
 * (docs/memory-embeddings.md: MRR@10 0.56 against 0.34 for the engine's
 * built-in Chinese-first model; ~25 ms per round query on one thread). The
 * service's model table (`--describe`) carries the same name and dimension
 * plus the query instruction; `tests/openviking-embedder.test.ts` holds the
 * two together. Mirrored by `LOCAL_EMBEDDER` in scripts/openviking-reembed.mjs.
 */
export const LOCAL_EMBEDDING = Object.freeze({ model: "bge-small-en-v1.5-f16", dimension: 384 });
/** The engine's BUILT-IN local embedder — the retired meaning of `local`, and
 * what an older store was embedded under. A config.toml that still spells it
 * under `local` is read as the current local embedder rather than refused: the
 * daemon must not stop booting over a value an earlier release required. The
 * re-embed migration carries the store across. */
export const RETIRED_LOCAL_EMBEDDING = Object.freeze({
  model: "bge-small-zh-v1.5-f16",
  dimension: 512,
});
/** What an `openai` opt-in runs unless the operator names another model. */
export const HOSTED_EMBEDDING = Object.freeze({ model: "text-embedding-3-small", dimension: 1536 });

/** ov.conf's `embedding.dense.provider` under `local`: the engine's OpenAI-
 * COMPATIBLE client — its async embedder — pointed at the loopback service.
 * The wire format, never a destination. */
export const LOCAL_EMBEDDER_WIRE_PROVIDER = "openai";

/** `http://127.0.0.1:<port>/v1` — ov.conf's `api_base` under `local`. */
export function localEmbedderBaseUrl(c: Pick<OpenVikingConfig, "local_embedder_port">): string {
  return `http://127.0.0.1:${c.local_embedder_port}/v1`;
}

/** What ov.conf's `embedding.dense` must say for this config: provider,
 * model and dimension as the ENGINE spells them (the record its vector
 * collection stores), plus the loopback `api_base` under `local`. The
 * daemon's drift check holds the rendered ov.conf to it. */
export interface OvConfEmbedder {
  provider: string;
  model: string;
  dimension: number;
  api_base?: string;
}

export function ovConfEmbedder(
  c: Pick<
    OpenVikingConfig,
    "embedding_provider" | "embedding_model" | "embedding_dimension" | "local_embedder_port"
  >,
): OvConfEmbedder {
  if (c.embedding_provider === "local")
    return {
      provider: LOCAL_EMBEDDER_WIRE_PROVIDER,
      model: c.embedding_model,
      dimension: c.embedding_dimension,
      api_base: localEmbedderBaseUrl(c),
    };
  return {
    provider: c.embedding_provider,
    model: c.embedding_model,
    dimension: c.embedding_dimension,
  };
}

/** Round-seeding knobs: how much memory rides each round prompt and
 * how long the daemon is willing to wait for it. Every value is defaulted —
 * an absent `[memory]` block is a supported configuration, and a store that
 * misses the deadline costs the round its context, never the round. */
export interface MemoryConfig {
  /** Token budget for the assembled context block. */
  context_tokens: number;
  /** Deadline for the head + block assembly, after which the round proceeds
   * memory-less. It must exceed one document embedding on the live VM; the
   * seed's wait for the case writer's
   * embedding tail is inside it. Clamped to `CONTEXT_TIMEOUT_BOUNDS_MS`. */
  context_timeout_ms: number;
  /** The embedding tail of one written finding case (ms): after
   * a case batch's write returns the server goes on embedding it for about
   * this long a case, and a round seed starting inside that waits for it —
   * within its own `context_timeout_ms`. Clamped to 0…30000; 0 turns the
   * tail off. */
  case_embed_tail_ms: number;
  /** Memory health (`src/memory/health.ts`): how often the daemon's
   * AUTHENTICATED probe lists the reviewer memories root with each credential
   * in use (its key file and the sessions' ovcli.conf). A leftover
   * `alert_cooldown_min` key in a live config.toml is ignored. */
  probe_interval_s: number;
  /** No authenticated answer for this long ⇒ `down` (wakes `memory_down`). */
  down_after_min: number;
  /** After boot, a server still warming up reads `unknown`, not degraded,
   * for this long. Never applies to an authentication failure. */
  boot_grace_min: number;
  /** An outage that lasts re-wakes the overseer this often. */
  rewake_h: number;
  /** The TUI files ONE tracker ticket for a memory incident older than this
   * (sourced from status.json, never from memory). */
  incident_ticket_after_min: number;
  /** Writes that stick: how often the backfill pump writes the
   * [feedback] signals memory still owes (at most 20 a tick, only while
   * memory health reads healthy). */
  backfill_interval_s: number;
  /** An owed signal older than this wakes `memory_write_backlog` (and again
   * every `rewake_h` while the backlog lasts). */
  write_backlog_after_min: number;
  /** Finding cases (src/cases.ts): how often the case writer syncs the cases
   * state.db says are owed and, only while memory health reads healthy,
   * writes up to 2 of them (one batch-write, never started while a round
   * reads memory) and backfills two more PRs. */
  cases_interval_s: number;
  /** How far back the case backfill reaches: PRs with a finding posted in
   * the last this-many days get their cases written (resumable, a few PRs a
   * tick, only while memory reads healthy). 0 turns the backfill off. */
  cases_backfill_days: number;
  /** The learner (src/learner/learner.ts). The miner runs this
   * many minutes before the EOD sweep (and on `qcr lessons mine`). */
  lessons_mine_lead_min: number;
  /** How far back a mine reads human outcomes (fates, the feedback ledger,
   * recall sources). */
  lessons_mine_days: number;
  /** No `eod-curation-receipt` this long after the EOD sweep was delivered
   * wakes `eod_curation_missing`. */
  lessons_receipt_wait_min: number;
  /** An offered candidate still undecided this many ops days later EXPIRES —
   * recorded on the row, in an event and in the packet. */
  lessons_expiry_ops_days: number;
  /** At most this many candidates are offered for the FIRST time per EOD
   * packet (misses first); the rest wait for a later one. Carried candidates
   * are never capped. */
  lessons_packet_new_max: number;
  /** A bot-approved merged PR's later commits are read this long after the
   * merge (post-merge recall, read-only git on the base clone). */
  lessons_recall_window_days: number;
  /** The window a cluster's recurrence and counterweight count over. */
  lessons_recurrence_days: number;
  /** The digests whose "Learnings" never reached memory — the one-time
   * backfill into candidates (inclusive, YYYY-MM-DD). */
  lessons_digest_backfill_from: string;
  lessons_digest_backfill_to: string;
  /** How many items the round's context search may draw from each area it
   * searches. A round searches `experiences/` ONLY
   * (`ROUND_SEARCH_AREAS`, src/memory/layout.ts): any other key here is
   * ignored with one log line (src/openviking/context.ts
   * `roundSearchQuotas`), and a missing or non-positive `experiences` count
   * takes the default — the search is never left to the server's own balance
   * across every scope (see the comment in config.toml). */
  context_quotas: Record<string, number>;
  /**
   * How curated lessons and past finding cases reach a review:
   *   `off`    — nothing runs: no selection, no shadow ledger;
   *   `shadow` — the SHIPPED value: every round selects lessons and cases
   *              through OpenViking (one bounded prefetch, never delaying the
   *              round) and the shadow ledger records what WOULD have been
   *              delivered and which posted findings a delivered dont-raise
   *              lesson would have touched — and NO prompt, task file or
   *              agent changes;
   *   `on`     — delivery: the same selection, AWAITED beside the
   *              round's memory seed within the same budget, and rendered —
   *              each lens's task file, the lessons files of the validator
   *              and the lenses a session adds, the main session's "Lessons
   *              in force" index and past-review cases (the bleed rule
   *              reworded), the validator's `lesson-shape` addendum, and the
   *              repo facts for the paths a recheck or an author reply
   *              touches. A round that selects nothing renders as `off`.
   * The owner switches it to `on` after reading `qcr lessons shadow-report`.
   */
  delivery: MemoryDelivery;
  /** The round's ONE lesson prefetch may take at most this long (ms) when the
   * round WAITS for it — under `on` — then whatever arrived is used and every
   * find still out is a recorded timeout. Clamped to 1…2000: the contract's
   * hard ceiling is 2 s. */
  delivery_budget_ms: number;
  /** The same prefetch's budget (ms) when NOTHING waits for it — under
   * `shadow`, where it starts after the round's handoff: looser,
   * so a shadow selection behind a busy embedder still records what it would
   * have delivered. Clamped to 1…20000 — it holds the selector's two places
   * in the embedder queue for at most that long. */
  shadow_budget_ms: number;
}

/** The three memory timeouts are BOUNDED — memory must never
 * hold a round past a budget an operator can read off the config, and a
 * mistyped 0 must not turn every seed memory-less. Inclusive ms. */
export const CONTEXT_TIMEOUT_BOUNDS_MS = { min: 100, max: 15_000 } as const;
export const SEARCH_TIMEOUT_BOUNDS_MS = { min: 100, max: 15_000 } as const;
export const HEALTH_TIMEOUT_BOUNDS_MS = { min: 100, max: 20_000 } as const;
export const CASE_EMBED_TAIL_MAX_MS = 30_000;

/** `v` as an integer inside `bounds`, or `fallback` when it is not a finite
 * number at all. */
function clampMs(v: unknown, bounds: { min: number; max: number }, fallback: number): number {
  const n = typeof v === "number" ? v : Number.NaN;
  if (!Number.isFinite(n)) return fallback;
  return Math.max(bounds.min, Math.min(bounds.max, Math.floor(n)));
}

/** The contract's hard ceiling on the lesson prefetch. */
export const LESSON_PREFETCH_MAX_MS = 2000;
/** The shadow prefetch's ceiling and default. The default covers
 * the live VM's measured worst case — a find's 2.5 s p90 behind a case batch
 * already on the embedder (two ~3.4 s embeddings, src/cases.ts). */
export const LESSON_SHADOW_PREFETCH_MAX_MS = 20_000;
export const LESSON_SHADOW_PREFETCH_DEFAULT_MS = 10_000;

/**
 * The [memory] block, defaults filled and the delivery switch checked: an
 * unknown `delivery` value REFUSES to load (a misspelt `"onn"` must not
 * quietly mean shadow, or off), and the prefetch budget is clamped to the
 * contract's ceiling.
 */
export function parseMemory(raw: Record<string, unknown>): MemoryConfig {
  const m = { ...MEMORY_DEFAULTS, ...(raw as Partial<MemoryConfig>) };
  if (!(MEMORY_DELIVERY_MODES as readonly unknown[]).includes(m.delivery))
    throw new Error(
      `[memory] delivery must be one of ${MEMORY_DELIVERY_MODES.map((v) => `"${v}"`).join(", ")} (got ${JSON.stringify(m.delivery)})`,
    );
  const budget = Number(m.delivery_budget_ms);
  m.delivery_budget_ms = Number.isFinite(budget)
    ? Math.max(1, Math.min(LESSON_PREFETCH_MAX_MS, Math.floor(budget)))
    : LESSON_PREFETCH_MAX_MS;
  const shadow = Number(m.shadow_budget_ms);
  m.shadow_budget_ms = Number.isFinite(shadow)
    ? Math.max(1, Math.min(LESSON_SHADOW_PREFETCH_MAX_MS, Math.floor(shadow)))
    : LESSON_SHADOW_PREFETCH_DEFAULT_MS;
  m.context_timeout_ms = clampMs(
    m.context_timeout_ms,
    CONTEXT_TIMEOUT_BOUNDS_MS,
    MEMORY_DEFAULTS.context_timeout_ms,
  );
  m.case_embed_tail_ms = clampMs(
    m.case_embed_tail_ms,
    { min: 0, max: CASE_EMBED_TAIL_MAX_MS },
    MEMORY_DEFAULTS.case_embed_tail_ms,
  );
  return m;
}

/** The quota a round's context search gives each area it searches when
 * `[memory] context_quotas` names none (the round context assembler reads
 * this same constant). */
export const DEFAULT_ROUND_QUOTA = 24;

export const MEMORY_DEFAULTS: MemoryConfig = {
  context_tokens: 2000,
  context_timeout_ms: 9000,
  case_embed_tail_ms: 4000,
  probe_interval_s: 120,
  down_after_min: 10,
  boot_grace_min: 5,
  rewake_h: 6,
  incident_ticket_after_min: 120,
  backfill_interval_s: 60,
  write_backlog_after_min: 120,
  cases_interval_s: 120,
  cases_backfill_days: 60,
  lessons_mine_lead_min: 15,
  lessons_mine_days: 45,
  lessons_receipt_wait_min: 180,
  lessons_expiry_ops_days: 7,
  lessons_packet_new_max: 40,
  lessons_recall_window_days: 14,
  lessons_recurrence_days: 90,
  lessons_digest_backfill_from: "2026-08-31",
  lessons_digest_backfill_to: "2026-10-02",
  context_quotas: { experiences: DEFAULT_ROUND_QUOTA },
  delivery: "shadow",
  delivery_budget_ms: LESSON_PREFETCH_MAX_MS,
  shadow_budget_ms: LESSON_SHADOW_PREFETCH_DEFAULT_MS,
};

/** [openviking] is optional in config.toml — the defaults ARE the shipped
 * configuration, exactly like [tui]/[companion]. */
export const OPENVIKING_DEFAULTS: OpenVikingConfig = {
  enabled: true,
  endpoint: "local",
  version: "0.4.15",
  llama_cpp_python_version: "0.3.35",
  extension_commit: "d436baa23c83938b22bb0aab08b0ce48568b5ff4",
  user: "reviewer",
  account: "",
  reviewer_key_file: "openviking_reviewer_key",
  auth_mode: "api_key",
  root_key_file: "openviking_root_key",
  provision_users: ["reviewer", "companion"],
  request_timeout_ms: 10000,
  search_timeout_ms: 8000,
  default_category: "experiences",
  read_cache_ttl_ms: 15000,
  host: "127.0.0.1",
  port: 1933,
  bin: "/opt/openviking/venv/bin/openviking-server",
  home: "/opt/quickreview/state/openviking",
  config_file: "", // → <home>/ov.conf
  workspace: "", // → <home>/workspace
  workers: 1,
  queue_concurrency: 2,
  health_interval_s: 30,
  health_timeout_ms: 6000,
  restart_backoff_ms: [1000, 2000, 5000, 15000, 30000, 60000],
  restart_reset_after_s: 120,
  embedding_provider: "local",
  embedding_model: LOCAL_EMBEDDING.model,
  embedding_dimension: LOCAL_EMBEDDING.dimension,
  embedding_key_file: "openai_embeddings_api_key",
  local_embedder_file: `/opt/openviking/models/${LOCAL_EMBEDDING.model}.gguf`,
  local_embedder_url: `https://huggingface.co/CompendiumLabs/bge-small-en-v1.5-gguf/resolve/d32f8c040ea3b516330eeb75b72bcc2d3a780ab7/${LOCAL_EMBEDDING.model}.gguf`,
  local_embedder_sha256: "f0b2fef971e8366438bfd2d9aefea1b0115919389448806d290237f638bae999",
  local_embedder_port: 1934,
  local_embedder_threads: 1,
};

/**
 * The [openviking] block, defaults filled and the embedder checked.
 *
 * The embedder is validated at LOAD time because the boot validates it too,
 * and a memory engine that refuses to start is a silent outage: an unknown
 * provider, a non-positive dimension, a `local` model/dimension that is not
 * the local embedder's, or a local model-file pin that does not name that
 * model are all config errors here.
 */
export function parseOpenViking(raw: Record<string, unknown>): OpenVikingConfig {
  const merged = { ...OPENVIKING_DEFAULTS, ...(raw as Partial<OpenVikingConfig>) };
  if (!(OPENVIKING_ENDPOINTS as readonly string[]).includes(merged.endpoint)) {
    throw new Error(
      `config.toml: [openviking] endpoint must be one of ${OPENVIKING_ENDPOINTS.join(", ")} (got '${String(merged.endpoint)}')`,
    );
  }
  // Bounded, never a tight loop or an unbounded wait.
  merged.search_timeout_ms = clampMs(
    merged.search_timeout_ms,
    SEARCH_TIMEOUT_BOUNDS_MS,
    OPENVIKING_DEFAULTS.search_timeout_ms,
  );
  merged.health_timeout_ms = clampMs(
    merged.health_timeout_ms,
    HEALTH_TIMEOUT_BOUNDS_MS,
    OPENVIKING_DEFAULTS.health_timeout_ms,
  );
  // The defaults are the LOCAL embedder: a hosted opt-in that omits the model
  // runs HOSTED_EMBEDDING, never the local model (which no hosted API serves).
  // A named hosted model with no dimension has no default to fall back on.
  if (merged.embedding_provider !== "local") {
    if (raw.embedding_model === undefined) {
      merged.embedding_model = HOSTED_EMBEDDING.model;
      if (raw.embedding_dimension === undefined)
        merged.embedding_dimension = HOSTED_EMBEDDING.dimension;
    } else if (raw.embedding_dimension === undefined) {
      if (merged.embedding_model !== HOSTED_EMBEDDING.model)
        throw new Error(
          `config.toml: [openviking] embedding_model = "${String(merged.embedding_model)}" needs its embedding_dimension set too`,
        );
      merged.embedding_dimension = HOSTED_EMBEDDING.dimension;
    }
  } else if (
    merged.embedding_model === RETIRED_LOCAL_EMBEDDING.model &&
    (raw.embedding_dimension === undefined ||
      merged.embedding_dimension === RETIRED_LOCAL_EMBEDDING.dimension)
  ) {
    // An earlier release required this spelling under `local`. It means the
    // current local embedder — the boot renders the same, and the re-embed
    // migration moves the store across.
    merged.embedding_model = LOCAL_EMBEDDING.model;
    merged.embedding_dimension = LOCAL_EMBEDDING.dimension;
  }
  if (!(EMBEDDING_PROVIDERS as readonly string[]).includes(merged.embedding_provider)) {
    throw new Error(
      `config.toml: [openviking] embedding_provider must be one of ${EMBEDDING_PROVIDERS.join(", ")} (got '${String(merged.embedding_provider)}')`,
    );
  }
  if (!Number.isInteger(merged.embedding_dimension) || merged.embedding_dimension <= 0) {
    throw new Error(
      `config.toml: [openviking] embedding_dimension must be a positive integer (got '${String(merged.embedding_dimension)}')`,
    );
  }
  if (
    merged.embedding_provider === "local" &&
    (merged.embedding_model !== LOCAL_EMBEDDING.model ||
      merged.embedding_dimension !== LOCAL_EMBEDDING.dimension)
  ) {
    throw new Error(
      `config.toml: [openviking] embedding_provider = "local" runs the local English embedder, ${LOCAL_EMBEDDING.model} at ${LOCAL_EMBEDDING.dimension} dims — ` +
        `the only local model the image pins; set embedding_model/embedding_dimension to it, or opt into a hosted provider`,
    );
  }
  if (
    typeof merged.embedding_key_file !== "string" ||
    merged.embedding_key_file.trim() === "" ||
    merged.embedding_key_file.includes("/")
  ) {
    throw new Error(
      "config.toml: [openviking] embedding_key_file must be a bare file name inside the secrets dir",
    );
  }
  checkLocalEmbedderPin(merged);
  return resolveOpenVikingPaths(merged);
}

/** The local embedder's model-file pin and service knobs. The
 * file and the URL must both name `LOCAL_EMBEDDING.model`: a pin for another
 * model would put a file the service's model table does not describe under a
 * name the vector store trusts. */
function checkLocalEmbedderPin(c: OpenVikingConfig): void {
  const gguf = `${LOCAL_EMBEDDING.model}.gguf`;
  const file = c.local_embedder_file;
  if (typeof file !== "string" || !file.startsWith("/") || !file.endsWith(`/${gguf}`)) {
    throw new Error(
      `config.toml: [openviking] local_embedder_file must be an absolute container path ending in /${gguf} (got '${String(file)}')`,
    );
  }
  const url = c.local_embedder_url;
  if (typeof url !== "string" || !url.startsWith("https://") || !url.endsWith(`/${gguf}`)) {
    throw new Error(
      `config.toml: [openviking] local_embedder_url must be an https URL ending in /${gguf} (got '${String(url)}')`,
    );
  }
  if (
    typeof c.local_embedder_sha256 !== "string" ||
    !/^[0-9a-f]{64}$/.test(c.local_embedder_sha256)
  ) {
    throw new Error(
      "config.toml: [openviking] local_embedder_sha256 must be the file's sha256, 64 lowercase hex digits",
    );
  }
  const port = c.local_embedder_port;
  if (!Number.isInteger(port) || port < 1 || port > 65535 || port === c.port) {
    throw new Error(
      `config.toml: [openviking] local_embedder_port must be a TCP port other than the server's own ${c.port} (got '${String(port)}')`,
    );
  }
  const threads = c.local_embedder_threads;
  if (!Number.isInteger(threads) || threads < 1 || threads > 16) {
    throw new Error(
      `config.toml: [openviking] local_embedder_threads must be an integer in 1..16 (got '${String(threads)}')`,
    );
  }
}

/** Derived paths: `config_file`/`workspace` default off `home`, so the three
 * never drift apart in a hand-edited config. */
export function resolveOpenVikingPaths(c: OpenVikingConfig): OpenVikingConfig {
  const home = expandHome(c.home);
  return {
    ...c,
    home,
    config_file: c.config_file ? expandHome(c.config_file) : join(home, "ov.conf"),
    workspace: c.workspace ? expandHome(c.workspace) : join(home, "workspace"),
  };
}

/** `http://host:port` — the one place the base URL is spelled. */
export function openVikingBaseUrl(c: OpenVikingConfig): string {
  return `http://${c.host}:${c.port}`;
}

/**
 * [ops] — the operations timezone: the ONE knob that defines whose
 * calendar day the system runs on. Every day-scoped feature derives its day
 * from here — the [feedback] same-day addendum + agent-rebuild rollover,
 * metrics day buckets, TUI alert fold memory and companion day rollover —
 * and the two sections that carry their own zone ([eod] and [slack.policy]
 * `timezone`) DEFAULT from it, each still individually overridable in its own
 * section.
 */
export interface OpsConfig {
  /** IANA zone (e.g. "Europe/Warsaw") of the operator's day. */
  timezone: string;
}

/** `[eod] pinned_watchdog_window_min`'s default, and the watchdog's own. */
export const EOD_PINNED_WATCHDOG_WINDOW_MIN = 90;

/** Neutral default — a config that never names a zone runs on UTC days. */
export const OPS_DEFAULTS: OpsConfig = { timezone: "UTC" };

/** The same Intl-based check the EOD machinery relies on (src/eod.ts builds
 * an Intl.DateTimeFormat per zone): an unknown zone throws RangeError at
 * formatter construction, so validate at parse time rather than at 18:00. */
export function assertIanaTimeZone(tz: string, where: string): string {
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: tz });
  } catch {
    throw new Error(`config.toml: ${where} '${tz}' is not a valid IANA timezone`);
  }
  return tz;
}

/** A section carrying its own `timezone` (defaulted from [ops]), returned
 * once that zone passes `assertIanaTimeZone`. */
function checkSectionTimeZone<T extends { timezone: string }>(section: T, where: string): T {
  assertIanaTimeZone(String(section.timezone), where);
  return section;
}

/**
 * [ingress] — the webhook ingress shape. `tunnel-file` turns on the
 * hostname-file watcher: a tunnel sidecar writes its assigned bare
 * public hostname (e.g. `abc.trycloudflare.com`, trailing newline tolerated)
 * to `hostname_file`, and the daemon re-points the App's own webhook URL when
 * it changes — through the app-self-config gate class, which executes even in
 * dry-run (AGENTS.md invariant 6). `none` (the default, and
 * what an absent section means) starts nothing at all.
 */
export interface IngressConfig {
  /** "none" ⇒ no watcher is ever constructed; "tunnel-file" ⇒ self-heal on;
   * "polling" ⇒ no webhooks at all: the daemon's `/webhook` route refuses
   * every delivery, no webhook secret is read, and the reconcile poll is the
   * only trigger. `[github] auth = "user"` requires "polling". */
  shape: "none" | "tunnel-file" | "polling";
  /** File the tunnel sidecar writes the bare public hostname into. Empty ⇒
   * `<root>/state/ingress/hostname` (see ingressHostnameFile). */
  hostname_file: string;
  /** Settle time after a file change before the re-point runs — quick-tunnel
   * sidecars write, then sometimes rewrite, within a second or two. */
  debounce_ms: number;
  /** The reliable path: a periodic sweep backs up fs.watch (the fast path),
   * exactly like the verdict watcher. */
  sweep_interval_s: number;
}

export const INGRESS_DEFAULTS: IngressConfig = {
  shape: "none",
  hostname_file: "",
  debounce_ms: 3000,
  sweep_interval_s: 300,
};

/** Does this install take webhooks at all? Not under the polling shape
 * (and so never under `[github] auth = "user"`, which requires it): there the
 * `/webhook` route refuses every delivery and no webhook secret is read. */
export function webhooksEnabled(cfg: Pick<Config, "ingress">): boolean {
  return cfg.ingress.shape !== "polling";
}

/** The hostname file's resolved path — the one place the default is spelled. */
export function ingressHostnameFile(cfg: Config, root: string): string {
  const configured = cfg.ingress.hostname_file.trim();
  return configured ? expandHome(configured) : join(root, "state", "ingress", "hostname");
}

/** The whole config.toml: the review sections (`CoreConfig`) and every
 * other surface's. */
export interface Config extends CoreConfig {
  ops: OpsConfig;
  ingress: IngressConfig;
  server: { hostname: string; port: number };
  daemon: {
    poll_interval_s: number;
    max_concurrent_rounds: number;
    round_deadline_min: number;
    /** How many times the daemon may self-requeue a stuck round (overdue +
     * no verdict + session dead) per PR head. Past the cap the round
     * terminalizes through the overdue-anomaly path. Optional
     * so hand-rolled test configs keep compiling; readers default to
     * DEFAULT_MAX_SELF_REQUEUES. */
    max_self_requeues?: number;
    /** Minutes after dispatch before a running round with no prompt receipt
     * counts as lost and is recovered. Optional; readers
     * default to DEFAULT_ROUND_STALL_GRACE_MIN. */
    round_stall_grace_min?: number;
    /** How many times a round's prompt may be RE-DELIVERED before the
     * expensive recovery takes over. Separate from `max_self_requeues` on
     * purpose — redelivery costs one file write and keeps the round, the
     * session and the conversation, where a self-requeue burns a round and
     * (for a live session) kills it. Optional; readers default to
     * DEFAULT_MAX_PROMPT_REDELIVERIES. */
    max_prompt_redeliveries?: number;
    /** Daemon→pi stage bounds. Optional only for old configs; the
     * parser supplies the exported defaults so production always has finite
     * values. Progress telemetry never changes any of them. */
    session_command_start_lease_s?: number;
    /** Maximum wall time from tmux birth to a generation-matched inject-bridge
     * startup receipt. Tmux existence alone is never delivery readiness. */
    session_bridge_ready_timeout_s?: number;
    session_command_running_max_min?: number;
    /** Round execution milestones, all anchored to durable command
     * start. They never renew from heartbeat/activity telemetry. */
    round_first_pass_max_min?: number;
    round_passes_max_min?: number;
    round_finalize_grace_min?: number;
    /** Once a round's review is CONFIRMED posted, a stage limit
     * no longer cancels it — the session's tail (ledger, findings record,
     * verdict file) gets this long after the posting to finish, and a round
     * still without a verdict then is settled from the posting receipt. Never
     * a self-requeue, so never a second posting. Readers default to
     * DEFAULT_ROUND_POSTED_TAIL_GRACE_MIN. */
    round_posted_tail_grace_min?: number;
    /** The extra minutes a follow-up round whose pre-approval sweep
     * is OWED gets for its passes and its hard cap — the sweep is a whole
     * round-1 plan run after the delta's. Readers default to
     * DEFAULT_FOLLOW_UP_SWEEP_EXTRA_MIN. */
    follow_up_sweep_extra_min?: number;
    posting_receipt_grace_s?: number;
    /** A review POST GitHub answered 5xx (or not at all) is handed
     * to the daemon as a `deferred` receipt and retried at these offsets, in
     * minutes from the first failure — one attempt per entry, each through
     * the MutationGate after a marker read. Readers default to
     * DEFAULT_POSTING_RETRY_OFFSETS_MIN. */
    posting_retry_offsets_min?: number[];
    /** Every retry lies inside this many minutes of the first failure; past
     * it, nothing is POSTed (one last marker read) and the PR goes
     * FAILED_LOUD. Readers default to DEFAULT_POSTING_RETRY_WINDOW_MIN. */
    posting_retry_window_min?: number;
    session_command_unknown_grace_s?: number;
    session_command_unknown_max_checks?: number;
    session_command_max_start_retries?: number;
    /** How long a compaction the session's inject bridge reports
     * running may hold a waiting command's start lease open. pi refuses every
     * prompt while it compacts, so a command queued behind one is late, not
     * lost; past this bound a compaction still "running" is no reason to wait,
     * and the bounded redelivery → kill-and-replay recovery takes over.
     * Readers default to DEFAULT_SESSION_COMPACTION_MAX_S. */
    session_compaction_max_s?: number;
    /** The central lens permit ceiling: the most lens sessions alive at
     * once across every worker. Readers default to DEFAULT_LENS_PERMITS (20,
     * ruled for the VM: the CPU gate measured 20 sessions fine on 2 cores). */
    lens_permits?: number;
    /** The least gap, in ms, between two permit grants, so a wave never creates
     * its sessions in one burst (the gate measured a 0.7 to 2.5 s loop stall for
     * 8 to 20 at once). 0 turns it off. Default DEFAULT_LENS_GRANT_STAGGER_MS (250). */
    lens_grant_stagger_ms?: number;
    /** The idle-PR answer worker's wall-clock cap, in seconds: the
     * operator's message to a PR with no running worker is answered by a short
     * worker that is ended at this age. Readers default to DEFAULT_ANSWER_TIMEOUT_S. */
    answer_timeout_s?: number;
    /** The answer worker's dollar cap per message (the session's own spend, in
     * USD). Readers default to DEFAULT_ANSWER_CAP_USD. */
    answer_cap_usd?: number;
    round_stage_supervisor_stale_s?: number;
    /** The daemon's event-loop watch (src/eventloop.ts). All
     * optional — `eventLoopPolicy` defaults each (300 s window, a 10 s single
     * delay or a 2 s p99 over a full window is a stall, one wake per 60 min,
     * "CPU starved" from 20% of CFS periods throttled) and clamps a number
     * into range; a non-number falls back to the default. */
    event_loop_window_s?: number;
    event_loop_stall_max_s?: number;
    event_loop_stall_p99_s?: number;
    event_loop_wake_cooldown_min?: number;
    event_loop_starved_throttle_ratio?: number;
    /** Zombie-round expiry horizon: a round stuck `overdue` for longer than
     * this — and whose PR has since verdicted or closed, so a self-requeue
     * would never touch it — moves to terminal `expired`.
     * 0 disables the sweep. */
    expire_overdue_after_h: number;
  };
  eod: {
    time: string;
    timezone: string;
    /** Daily overseer heartbeat wall time; same zone as `time`. */
    heartbeat_time: string;
    /** Watch the pinned area across the sweep and raise an anomaly if
     * curation touched it. Off ⇒ no watch. */
    pinned_watchdog: boolean;
    /** How long after the inject the watchdog keeps looking, when the day's
     * digest never appears to close the window early. */
    pinned_watchdog_window_min: number;
  };
  caps: {
    improvement_pr_max_lines: number;
    improvement_pr_max_files: number;
    improvement_pr_per_day: number;
    improvement_pr_per_week: number;
    issues_per_day: number;
    /** Path prefixes a bot improvement PR may never touch. A configured
     * value REPLACES the list (it is repo-shape, not an invariant —
     * `migrations/` is Django's name for the concept), and `.env`-named files
     * are refused unconditionally regardless of this knob. */
    improvement_pr_deny_prefixes: string[];
  };
  openviking: OpenVikingConfig;
  memory: MemoryConfig;
  tui: TuiConfig;
  companion: CompanionConfig;
  sink: SinkConfig;
  backfill: BackfillConfig;
  recheck: RecheckConfig;
  levers: LeversConfig;
  slack: SlackConfig;
  /** Where `qcr scan start` drives a run: `[scan] sandbox`,
   * `pihome_volume` and `image`, read from the same table and kept out of
   * the scan settings (a profile cannot set them). */
  scan_sandbox: ScanSandboxConfig;
  /** The closed-PR archiver (`src/archive/`). Optional in the file;
   * the parser fills every key. */
  archive: ArchiveConfig;
  /** The bot login's single refresher (`src/loginrefresh/`). Optional
   * in the file; off unless the cutover's config turns it on. */
  login_refresh: LoginRefreshConfig;
  /** The home, the app's own pi a bare `qcr` opens (src/home/launch.ts).
   * Optional in the file and here, so hand-rolled configs keep compiling;
   * the parser fills every key. */
  home?: HomeConfig;
}

/** Which tools the home's model may call: `reviewer` is the plugin's tools,
 * the home's own `home_*` tools and pi's read tools; `full` is all of pi's. */
export type HomeToolSet = "reviewer" | "full";

/** `[home]`: the home a bare `qcr` opens (src/home/launch.ts reads it). */
export interface HomeConfig {
  /** The chat's model, `provider/id`. The panel's login line counts only
   * this model's provider as signed in. */
  model: string;
  tools: HomeToolSet;
}

export const HOME_DEFAULTS: Readonly<HomeConfig> = {
  model: "openai-codex/gpt-6.1-sol",
  tools: "reviewer",
};

/** `[home]`, every key defaulted; a value of the wrong kind is refused. */
export function parseHomeSection(raw: unknown): HomeConfig {
  const t = (raw ?? {}) as Record<string, unknown>;
  const model = t["model"] ?? HOME_DEFAULTS.model;
  if (typeof model !== "string" || !/^[^/\s]+\/\S+$/.test(model))
    throw new Error(
      `config.toml [home]: model must be "provider/id" (got ${JSON.stringify(model)})`,
    );
  const tools = t["tools"] ?? HOME_DEFAULTS.tools;
  if (tools !== "reviewer" && tools !== "full")
    throw new Error(
      `config.toml [home]: tools must be "reviewer" or "full" (got ${JSON.stringify(tools)})`,
    );
  return { model, tools };
}

/**
 * `[login_refresh]`: the VM-only exception to the login-refresh rule (packages/pi-plugin/src/engine/auth.ts). After
 * the cutover ONE refresher process, spawned and supervised by the daemon,
 * owns pihome/agent/auth.json and every worker borrows a refresh-blanked copy.
 * Off by default: while the bot's tmux pi sessions exist they refresh the file
 * themselves, and a second refresher would rotate the refresh token under them.
 */
export interface LoginRefreshConfig {
  enabled: boolean;
  /** Refresh once the token has less than pi's own refresh window plus this
   * left. Must exceed `[daemon] round_deadline_min` (the longest worker cap), so
   * a worker that borrowed the file can finish on it. */
  margin_min: number;
}

export const LOGIN_REFRESH_DEFAULTS: LoginRefreshConfig = Object.freeze({
  enabled: false,
  margin_min: 90,
});

/** Parse `[login_refresh]`; with the refresher enabled, a margin that does not
 * outlast the longest worker cap REFUSES to load (a worker would then outlive
 * the token it borrowed). Disabled, nothing borrows, so the rule is not checked. */
export function parseLoginRefresh(
  raw: Record<string, unknown>,
  roundDeadlineMin: number,
): LoginRefreshConfig {
  const enabled = raw.enabled ?? LOGIN_REFRESH_DEFAULTS.enabled;
  if (typeof enabled !== "boolean")
    throw new Error(`config.toml [login_refresh]: enabled must be true or false`);
  const m = raw.margin_min ?? LOGIN_REFRESH_DEFAULTS.margin_min;
  const margin = typeof m === "bigint" ? Number(m) : m;
  if (typeof margin !== "number" || !Number.isFinite(margin) || margin > 1440)
    throw new Error(
      `config.toml [login_refresh]: margin_min must be a number of minutes up to 1440 (got ${JSON.stringify(typeof m === "bigint" ? String(m) : m)})`,
    );
  if (enabled && margin <= roundDeadlineMin)
    throw new Error(
      `config.toml [login_refresh]: margin_min (${margin}) must exceed [daemon] round_deadline_min (${roundDeadlineMin}), the longest worker cap`,
    );
  return { enabled, margin_min: margin };
}

/** Where a `qcr scan start` driver runs. `docker`: in a throwaway
 * container from the scan sandbox image that mounts only the reviewed repo
 * (read-only), the state home, the scan's own pi home and the config
 * (src/scanbox.ts). `host`: a detached process on this machine. */
export const SCAN_SANDBOXES = ["docker", "host"] as const;
export type ScanSandbox = (typeof SCAN_SANDBOXES)[number];

export interface ScanSandboxConfig {
  sandbox: ScanSandbox;
  /** Whether config.toml names `sandbox`: only the default gives way to
   * where the CLI runs (inside the companion container it is `host`). */
  sandbox_set: boolean;
  /** The pi home volume whose login the sandbox reads — read-only, a
   * refresh-disabled copy per case; by default the companion's own
   * (`[companion] pihome_volume`), which alone refreshes it. */
  pihome_volume: string;
  /** The image the sandbox runs; `SCAN_IMAGE_DEFAULT` when the key is omitted (an empty value is refused). */
  image: string;
}

/** The scan sandbox's own image (docker/companion/Dockerfile, built by
 * `qcr scan rebuild`). Not the companion's: now that is the release
 * image in `companion` mode, which the sandbox's one-shot entrypoint does not
 * serve. */
export const SCAN_IMAGE_DEFAULT = "qcr-scan";

export const SCAN_SANDBOX_DEFAULTS: Omit<ScanSandboxConfig, "image" | "pihome_volume"> = {
  sandbox: "docker",
  sandbox_set: false,
};

/** `[scan] sandbox / pihome_volume / image`; the pi home volume defaults to
 * the companion's, the image to `SCAN_IMAGE_DEFAULT`. */
export function parseScanSandbox(
  raw: unknown,
  companion: { pihome_volume: string },
): ScanSandboxConfig {
  const t = (typeof raw === "object" && raw !== null ? raw : {}) as Record<string, unknown>;
  const name = (key: string, fallback: string): string => {
    const v = t[key];
    if (v === undefined) return fallback;
    if (typeof v !== "string" || v.trim() === "")
      throw new Error(
        `config.toml [scan] ${key} must be a non-empty name (got ${JSON.stringify(v)})`,
      );
    return v.trim();
  };
  const sandbox = t["sandbox"] ?? SCAN_SANDBOX_DEFAULTS.sandbox;
  if (typeof sandbox !== "string" || !(SCAN_SANDBOXES as readonly string[]).includes(sandbox))
    throw new Error(
      `config.toml [scan] sandbox must be "docker" or "host" (got ${JSON.stringify(sandbox)})`,
    );
  return {
    sandbox: sandbox as ScanSandbox,
    sandbox_set: t["sandbox"] !== undefined,
    pihome_volume: name("pihome_volume", companion.pihome_volume),
    image: name("image", SCAN_IMAGE_DEFAULT),
  };
}

/**
 * `[levers]`: the bounds on a SESSION-issued `drain` / `pause-pr`.
 * The operator's own levers (`qcr drain on`, the deploy tab) are not bounded
 * by anything here — the deploy flow's drain stands until the new boot's
 * first healthy reconcile lifts it. Every number is minutes; the budgets are
 * counted per `[ops] timezone` day.
 */
export interface LeversConfig {
  /** Longest single session drain. */
  session_drain_max_min: number;
  /** Total session-drain minutes grantable per day; must be ≥ the cap. */
  session_drain_budget_min_per_day: number;
  /** Longest single session pause of one PR. */
  session_pause_max_min: number;
  /** Total session-pause minutes grantable per PR per day; must be ≥ the cap. */
  session_pause_budget_min_per_day: number;
}

export const LEVERS_DEFAULTS: LeversConfig = {
  session_drain_max_min: 30,
  session_drain_budget_min_per_day: 90,
  session_pause_max_min: 240,
  session_pause_budget_min_per_day: 480,
};

/** Parse `[levers]`; a bound that is not a positive integer, or a budget
 * smaller than its cap, refuses to load — a lever bound of zero or a budget
 * that can never fund one full grant is a misconfiguration, not a setting. */
export function parseLevers(raw: Record<string, any>): LeversConfig {
  const cfg: LeversConfig = { ...LEVERS_DEFAULTS, ...(raw as Partial<LeversConfig>) };
  for (const key of Object.keys(LEVERS_DEFAULTS) as Array<keyof LeversConfig>) {
    const v = cfg[key];
    if (!Number.isInteger(v) || v < 1) {
      throw new Error(
        `config.toml [levers]: ${key} must be a positive integer number of minutes (got ${JSON.stringify(v)})`,
      );
    }
  }
  if (cfg.session_drain_budget_min_per_day < cfg.session_drain_max_min) {
    throw new Error(
      "config.toml [levers]: session_drain_budget_min_per_day must be at least session_drain_max_min",
    );
  }
  if (cfg.session_pause_budget_min_per_day < cfg.session_pause_max_min) {
    throw new Error(
      "config.toml [levers]: session_pause_budget_min_per_day must be at least session_pause_max_min",
    );
  }
  return cfg;
}

/** The values `[archive] mode` takes (docs/archiving.md §12). */
export const ARCHIVE_MODES = ["off", "plan", "on"] as const;
export type ArchiveMode = (typeof ARCHIVE_MODES)[number];

/**
 * `[archive]` (docs/archiving.md): closed-PR history out of every
 * live path into a compressed archive under `<root>/archive/`, nothing of
 * analysis value deleted. Read by `src/archive/` (the archiver's policy) and
 * `qcr archive status`.
 */
export interface ArchiveConfig {
  /**
   *   `off`  — the archiver arms no timer at all;
   *   `plan` — the SHIPPED value: it computes what it would move (status.json
   *            `archive`, `qcr status`, `qcr archive status --plan`) and
   *            writes nothing;
   *   `on`   — it MOVES, every tick: it restores reopened PRs' transcripts
   *            and payloads first; then the old reader-less event rows and
   *            webhook deliveries into `archive/db/`, sealing finished months;
   *            then each eligible closed PR's files into `archive/pr-<n>/`,
   *            removing each from the live tree once its copy is verified;
   *            then the overseer's non-current transcripts and pi's day-old
   *            global session files.
   *            Nothing is deleted that is not verified in the archive or a
   *            proven duplicate.
   */
  mode: ArchiveMode;
  /** Closed PRs' files and webhook deliveries leave the live tree this many
   * days after the close (clamped 7..3650). */
  after_days: number;
  /** The reader-less event kinds leave this many days after their row was
   * written (clamped 31..3650, so `qcr metrics` d30 stays exact). */
  events_after_days: number;
  /** The archiver's own timer (clamped 10..3600 s). */
  interval_s: number;
  /** No tick before the daemon's first healthy reconcile plus this (clamped
   * 0..1440 min). */
  start_delay_min: number;
  /** No new file is started after this much of a tick (clamped 1..300 s). */
  tick_budget_s: number;
  /** At most this many PRs a tick (clamped 1..100). */
  max_prs_per_tick: number;
  /** Input rate cap for compress + verify (clamped 1..200 MB/s). */
  max_mb_per_s: number;
  /** Free space kept on both the archive and the state mount (clamped
   * 0.5..1024 GB). */
  disk_headroom_gb: number;
  /** The DB mover's starting batch (clamped 100..2000 rows). */
  db_batch_rows: number;
  /** gzip level (clamped 1..9). */
  gzip_level: number;
  /** A worker round's logs under `state/live/` and `state/lens/`
   * are removed from the live tree this many days after the round's last write,
   * and only once the PR's archive holds a verified copy (clamped 7..3650). A
   * log nothing archived is never removed. */
  live_retention_days: number;
  /** The disk cap on `state/live/` plus `state/lens/` together, in GB (clamped
   * 0..4096; 0 turns the check off). Past it the archiver raises the
   * `archive_live_cap` wake once per incident and every 6 h; it never deletes
   * to get under the cap. */
  live_cap_gb: number;
}

export const ARCHIVE_DEFAULTS: Readonly<ArchiveConfig> = Object.freeze({
  mode: "plan",
  after_days: 14,
  events_after_days: 35,
  interval_s: 60,
  start_delay_min: 10,
  tick_budget_s: 20,
  max_prs_per_tick: 5,
  max_mb_per_s: 8,
  disk_headroom_gb: 2,
  db_batch_rows: 500,
  gzip_level: 6,
  live_retention_days: 30,
  live_cap_gb: 20,
});

/** Each numeric `[archive]` key's range, and whether it is a whole number. */
export const ARCHIVE_LIMITS: Readonly<
  Record<Exclude<keyof ArchiveConfig, "mode">, readonly [min: number, max: number, int: boolean]>
> = Object.freeze({
  after_days: [7, 3650, true],
  events_after_days: [31, 3650, true],
  interval_s: [10, 3600, true],
  start_delay_min: [0, 1440, true],
  tick_budget_s: [1, 300, true],
  max_prs_per_tick: [1, 100, true],
  max_mb_per_s: [1, 200, false],
  disk_headroom_gb: [0.5, 1024, false],
  db_batch_rows: [100, 2000, true],
  gzip_level: [1, 9, true],
  live_retention_days: [7, 3650, true],
  live_cap_gb: [0, 4096, false],
});

/**
 * Parse `[archive]`. An unknown `mode` REFUSES to load (a misspelt `"onn"`
 * must not quietly mean plan, or off), and so does a key that is not a
 * number; a number out of its range is CLAMPED into it (`ARCHIVE_LIMITS`).
 */
export function parseArchive(raw: Record<string, unknown>): ArchiveConfig {
  const mode = raw.mode ?? ARCHIVE_DEFAULTS.mode;
  if (!(ARCHIVE_MODES as readonly unknown[]).includes(mode))
    throw new Error(
      `config.toml [archive]: mode must be one of ${ARCHIVE_MODES.map((v) => `"${v}"`).join(", ")} (got ${JSON.stringify(mode)})`,
    );
  const out: ArchiveConfig = { ...ARCHIVE_DEFAULTS, mode: mode as ArchiveMode };
  for (const [key, [min, max, int]] of Object.entries(ARCHIVE_LIMITS) as Array<
    [Exclude<keyof ArchiveConfig, "mode">, readonly [number, number, boolean]]
  >) {
    const v = raw[key];
    if (v === undefined) continue;
    const n = typeof v === "bigint" ? Number(v) : v;
    if (typeof n !== "number" || !Number.isFinite(n))
      throw new Error(
        `config.toml [archive]: ${key} must be a number (got ${JSON.stringify(typeof v === "bigint" ? String(v) : v)})`,
      );
    out[key] = Math.min(max, Math.max(min, int ? Math.floor(n) : n));
  }
  return out;
}

/** The team slug a configured `org/team` review team is requested as — the
 * one rule the webhook's trigger and withdrawal, the trigger consumption and
 * the backfill all match on. A bare slug is its own slug. */
export function reviewTeamSlug(reviewTeam: string): string {
  return reviewTeam.split("/")[1] ?? reviewTeam;
}

/** Defaults for [backfill], derived from the already-parsed [github] block. */
export function backfillDefaults(github: GithubConfig): BackfillConfig {
  return {
    bot_login: github.bot_login,
    bot_actor: github.app_slug,
    reviewed_label: github.reviewed_label,
    trigger_label: github.trigger_label,
    in_progress_label: github.in_progress_label,
    review_team_slug: reviewTeamSlug(github.review_team),
    concurrency: 2,
    max_search_pages: 10,
  };
}

/** [tui] is optional in config.toml — the TUI is an operator convenience and
 * older configs must keep parsing. */
export const TUI_DEFAULTS: TuiConfig = {
  target: "ssh",
  ssh_host: "my-vm",
  container: "quickreview-sandbox",
  memory_container: "",
  remote_state_dir: "/opt/quickreview/state",
  remote_sandbox_root: "",
  sudo_docker: true,
  poll_interval_s: 3,
  stale_after_s: 90,
  msg_timeout_s: 30,
  evidence_timeout_s: 60,
  evidence_why_interval_s: 10,
};

/** The local companion image's tag: the release image (docker/Dockerfile) in
 * `companion` mode, built on the host. */
export const COMPANION_IMAGE = "qcr-companion:release";

/** [companion] is optional in config.toml, exactly like [tui]. */
export const COMPANION_DEFAULTS: CompanionConfig = {
  enabled: true,
  container_name: "qcr-companion",
  // The release image, locally built (`qcr companion rebuild`). A tag of its own:
  // the name `qcr-companion` is the retired companion image on an existing
  // PC, which the new container's entrypoint modes do not serve, so a
  // recreate must find no image here and build the right one.
  image: COMPANION_IMAGE,
  pihome_volume: "companion-pihome",
  session: "companion",
  model: "openai-codex/gpt-6.1-sol:medium",
  repo_dir: "", // → sandboxRoot()
  tracker_dir: "", // → /tracker (rw) when set; empty = no tracker mount
  tracker_docs_dir: "", // → /tracker-docs (ro) when set
  reviewed_repo_dir: "", // → /reviewed-repo (ro) when set and present
  evidence_dir: "~/.local/share/qcr/evidence", // → /evidence (ro)
  feed_dir: "", // → <root>/state/companion/feed
  alerts_dir: "", // → <root>/state/companion/alerts
  ssh_dir: "~/.ssh",
  build_context: "", // → <root> (the release image is built from it; Dockerfile at docker/Dockerfile)
  overdue_grace_min: 30,
  stale_alert_s: 300,
  awaiting_age_h: 24,
  cooldown_min: 20,
};

/**
 * The issue sink — where auto-filed defect flags (`#bug` memory entries)
 * land. Three kinds:
 *
 *   `wayfinder` — tickets written into a filesystem wayfinder tracker on the
 *                 operator's PC, into the effort and under the parent this
 *                 block names.
 *   `github`    — defects filed as issues on the reviewed repo. The TUI never
 *                 talks to GitHub: it writes a `file-issue` COMMAND into the
 *                 daemon's commands/ channel, so the daemon's MutationGate,
 *                 day caps and title dedup enforce the filing.
 *   `none`      — auto-filing off. The default when `[sink]` is absent:
 *                 unconfigured = off.
 */
export type IssueSinkKind = "wayfinder" | "github" | "none";

export interface SinkConfig {
  kind: IssueSinkKind;
  /** Wayfinder tracker root (also the ticket projection's root). Empty ⇒
   * defaults from `[companion] tracker_dir`. */
  root: string;
  /** Wayfinder: the effort auto-filed tickets are written into. */
  effort: string;
  /** Wayfinder: the `Parent:` map id stamped into each filed ticket. */
  parent: string;
  /** The TUI's read-only ticket projection's effort. Deliberately a
   * SEPARATE key: the board may read a different effort from the one the
   * filer writes into. Empty ⇒ same as `effort`. */
  tickets_effort: string;
}

export const SINK_DEFAULTS: SinkConfig = {
  kind: "none",
  root: "",
  effort: "",
  parent: "",
  tickets_effort: "",
};

/** [sink] parse + validation. Misconfig is loud at boot, not a quiet no-op:
 * a `wayfinder` sink missing its effort or parent would otherwise silently
 * file nothing (or file into a nameless effort) forever. */
function parseSink(raw: Record<string, any>, companion: CompanionConfig): SinkConfig {
  const sink: SinkConfig = { ...SINK_DEFAULTS, ...(raw as Partial<SinkConfig>) };
  if (!["wayfinder", "github", "none"].includes(sink.kind)) {
    throw new Error(
      `config.toml [sink]: kind must be "wayfinder", "github" or "none" (got ${JSON.stringify(sink.kind)})`,
    );
  }
  sink.root = sink.root ? expandHome(sink.root) : companion.tracker_dir;
  if (sink.kind === "wayfinder") {
    if (!sink.root.trim())
      throw new Error(
        'config.toml [sink]: kind = "wayfinder" requires a `root` (or a [companion] tracker_dir to default from)',
      );
    if (!sink.effort.trim())
      throw new Error('config.toml [sink]: kind = "wayfinder" requires a non-empty `effort`');
    if (!sink.parent.trim())
      throw new Error('config.toml [sink]: kind = "wayfinder" requires a non-empty `parent`');
  }
  return sink;
}

/** The ticket projection's effort — its own key when set, else the filer's.
 * Empty ⇒ the projection has nothing configured to read. */
export function sinkTicketsEffort(cfg: Config): string {
  return cfg.sink.tickets_effort.trim() || cfg.sink.effort.trim();
}

/** Default lost-prompt grace when [daemon] carries no
 * `round_stall_grace_min`: long enough that a slow first tool call is never
 * mistaken for a dropped prompt, far shorter than the round deadline. */
export const DEFAULT_ROUND_STALL_GRACE_MIN = 10;

/** Default self-requeue budget per PR head when [daemon] carries no
 * `max_self_requeues`. */
export const DEFAULT_MAX_SELF_REQUEUES = 2;

/** Default prompt-redelivery budget per round. Two is enough to cover
 * a delivery that raced a busy session and one that raced a session restart;
 * a third failure is no longer a delivery problem, so escalating beats
 * re-sending the same file forever. */
export const DEFAULT_MAX_PROMPT_REDELIVERIES = 2;

/** Finite daemon→pi stage bounds. The 45-minute hard run cap is above the
 * measured live maximum (~23 minutes) yet materially below the 75-minute
 * defense-in-depth round deadline. */
export const DEFAULT_SESSION_COMMAND_START_LEASE_S = 120;
export const DEFAULT_SESSION_BRIDGE_READY_TIMEOUT_S = 30;
export const DEFAULT_SESSION_COMMAND_RUNNING_MAX_MIN = 45;
export const DEFAULT_ROUND_FIRST_PASS_MAX_MIN = 5;
export const DEFAULT_ROUND_PASSES_MAX_MIN = 35;
export const DEFAULT_ROUND_FINALIZE_GRACE_MIN = 5;
/** Measured posting→verdict tails run to ~6.5 min; 15 is over twice that and
 * still well inside the 75-minute round deadline. */
export const DEFAULT_ROUND_POSTED_TAIL_GRACE_MIN = 15;
/** `[daemon] follow_up_sweep_extra_min`'s default. */
export const DEFAULT_FOLLOW_UP_SWEEP_EXTRA_MIN = 20;
/** The round stage bounds in minutes, each with its code default: the one
 * resolution status publication and the stage supervisor both use. */
export function resolveRoundStageBounds(daemon: Config["daemon"]): {
  first_pass_max_min: number;
  passes_max_min: number;
  running_max_min: number;
  follow_up_sweep_extra_min: number;
} {
  return {
    first_pass_max_min: daemon.round_first_pass_max_min ?? DEFAULT_ROUND_FIRST_PASS_MAX_MIN,
    passes_max_min: daemon.round_passes_max_min ?? DEFAULT_ROUND_PASSES_MAX_MIN,
    running_max_min:
      daemon.session_command_running_max_min ?? DEFAULT_SESSION_COMMAND_RUNNING_MAX_MIN,
    follow_up_sweep_extra_min:
      daemon.follow_up_sweep_extra_min ?? DEFAULT_FOLLOW_UP_SWEEP_EXTRA_MIN,
  };
}
export const DEFAULT_POSTING_RECEIPT_GRACE_S = 120;
/** Three retries, exponential,
 * all inside an hour of the first failure. */
export const DEFAULT_POSTING_RETRY_OFFSETS_MIN: readonly number[] = [4, 12, 36];
export const DEFAULT_POSTING_RETRY_WINDOW_MIN = 60;
export const DEFAULT_SESSION_COMMAND_UNKNOWN_GRACE_S = 60;
export const DEFAULT_SESSION_COMMAND_UNKNOWN_MAX_CHECKS = 1;
export const DEFAULT_SESSION_COMMAND_MAX_START_RETRIES = 2;
/** A post-verdict compaction can take over a minute with the container
 * CPU-starved; ten minutes is several times the worst seen and still well
 * inside the 75-minute round deadline. */
export const DEFAULT_SESSION_COMPACTION_MAX_S = 600;
/** The idle-PR answer worker: ten minutes of wall clock, two dollars. */
export const DEFAULT_ANSWER_TIMEOUT_S = 600;
export const DEFAULT_ANSWER_CAP_USD = 2;
export const DEFAULT_ROUND_STAGE_SUPERVISOR_STALE_S = 180;

/** The app's root: the checkout (or image tree) this module runs from. The
 * review core's shipped data is found through `assetRoot` (packages/pi-plugin/src/assetroot.ts). */
export function sandboxRoot(): string {
  return packageRootFrom(dirname(fileURLToPath(import.meta.url)), "sandbox root");
}

export function expandHome(p: string): string {
  return p.startsWith("~/") || p === "~" ? resolve(homedir(), p.slice(2)) : p;
}

/** Host paths for every companion mount: a set path gets its `~` expanded (a relative one stays relative); "" means derive from root. */
export function resolveCompanionPaths(
  c: CompanionConfig,
  root: string = sandboxRoot(),
): CompanionConfig {
  return {
    ...c,
    repo_dir: c.repo_dir ? expandHome(c.repo_dir) : root,
    tracker_dir: c.tracker_dir ? expandHome(c.tracker_dir) : "",
    tracker_docs_dir: c.tracker_docs_dir ? expandHome(c.tracker_docs_dir) : "",
    reviewed_repo_dir: expandHome(c.reviewed_repo_dir),
    evidence_dir: c.evidence_dir ? expandHome(c.evidence_dir) : resolve(root, "evidence"),
    feed_dir: c.feed_dir ? expandHome(c.feed_dir) : resolve(root, "state", "companion", "feed"),
    alerts_dir: c.alerts_dir
      ? expandHome(c.alerts_dir)
      : resolve(root, "state", "companion", "alerts"),
    ssh_dir: expandHome(c.ssh_dir),
    build_context: c.build_context ? expandHome(c.build_context) : root,
  };
}

/**
 * `[caps]` parsed with each numeric cap CHECKED, not cast: a key missing
 * from an operator's file must never reach `checkDiffstat` as `undefined`,
 * where `files > undefined` is `false` and the cap would pass. A cap the
 * daemon cannot compare against is a startup refusal: the improvement
 * channel is the one place this system pushes code, and it must never run uncapped.
 */
export function parseCaps(raw: Record<string, unknown>): Config["caps"] {
  const cap = (key: string): number => {
    const v = raw[key];
    if (typeof v !== "number" || !Number.isFinite(v) || v < 0) {
      throw new Error(
        `config.toml [caps]: ${key} must be a non-negative number (got ${JSON.stringify(v)})`,
      );
    }
    return v;
  };
  const isStrings = (v: unknown): v is string[] =>
    Array.isArray(v) && v.every((x) => typeof x === "string");
  const denyPrefixes = (): string[] => {
    const prefixes = raw.improvement_pr_deny_prefixes;
    if (prefixes === undefined) return [...IMPROVEMENT_DENY_PREFIXES_DEFAULT];
    if (isStrings(prefixes)) return [...prefixes];
    throw new Error(
      `config.toml [caps]: improvement_pr_deny_prefixes must be an array of strings (got ${JSON.stringify(prefixes)})`,
    );
  };
  return {
    improvement_pr_max_lines: cap("improvement_pr_max_lines"),
    improvement_pr_max_files: cap("improvement_pr_max_files"),
    improvement_pr_per_day: cap("improvement_pr_per_day"),
    improvement_pr_per_week: cap("improvement_pr_per_week"),
    issues_per_day: cap("issues_per_day"),
    improvement_pr_deny_prefixes: denyPrefixes(),
  };
}

/** The shipped improvement-PR path denylist. Lives here (not in
 * improvements.ts) so config carries the default without a runtime import cycle. */
export const IMPROVEMENT_DENY_PREFIXES_DEFAULT: readonly string[] = [
  "migrations/",
  "infra/",
  "ansible/",
  ".github/workflows/",
];

export function parseConfig(toml: string): Config {
  const raw = parse(toml) as Record<string, any>;
  for (const line of configDeprecations(raw)) console.warn(`[quickreviewd] ${line}`);
  const github = parseGithubSection(raw);
  const preset = presetOf(raw);
  const engine = parseEngine((raw.engine ?? {}) as Record<string, unknown>);
  const companion = resolveCompanionPaths({
    ...COMPANION_DEFAULTS,
    ...((raw.companion ?? {}) as Partial<CompanionConfig>),
  });
  // [ops] is optional so older configs keep parsing; [eod] and
  // [slack.policy] timezones default from it below, own-section value wins.
  const ops: OpsConfig = {
    timezone: assertIanaTimeZone(
      String(((raw.ops ?? {}) as Partial<OpsConfig>).timezone ?? OPS_DEFAULTS.timezone),
      "[ops] timezone",
    ),
  };
  // [ingress] is optional: absent ⇒ shape "none", nothing starts.
  const ingress: IngressConfig = {
    ...INGRESS_DEFAULTS,
    ...((raw.ingress ?? {}) as Partial<IngressConfig>),
  };
  if (!["none", "tunnel-file", "polling"].includes(ingress.shape)) {
    throw new Error(
      `config.toml [ingress]: shape must be "none", "tunnel-file" or "polling" (got ${JSON.stringify(ingress.shape)})`,
    );
  }
  // The person's own credential has no webhook: GitHub delivers webhooks to
  // an App, and the person has none. So that mode is polling-only, and any
  // other shape is refused here rather than left to run half-wired.
  if (github.auth === "user" && ingress.shape !== "polling") {
    throw new Error(
      `config.toml: [github] auth = "user" runs polling-only — set [ingress] shape = "polling" ` +
        `(got ${JSON.stringify(ingress.shape)}${raw.ingress === undefined ? ", the default for an absent [ingress]" : ""}). ` +
        `Webhooks and the webhook self-heal need a GitHub App: use auth = "app" for them.`,
    );
  }
  const cfg: Config = {
    dry_run: Boolean(req(raw, "dry_run")),
    ops,
    ingress,
    github,
    server: { ...(req(raw, "server") as Config["server"]) },
    // Every optional knob defaults so older configs keep parsing.
    daemon: {
      max_self_requeues: DEFAULT_MAX_SELF_REQUEUES,
      expire_overdue_after_h: 24,
      session_command_start_lease_s: DEFAULT_SESSION_COMMAND_START_LEASE_S,
      session_bridge_ready_timeout_s: DEFAULT_SESSION_BRIDGE_READY_TIMEOUT_S,
      session_command_running_max_min: DEFAULT_SESSION_COMMAND_RUNNING_MAX_MIN,
      round_first_pass_max_min: DEFAULT_ROUND_FIRST_PASS_MAX_MIN,
      round_passes_max_min: DEFAULT_ROUND_PASSES_MAX_MIN,
      round_finalize_grace_min: DEFAULT_ROUND_FINALIZE_GRACE_MIN,
      round_posted_tail_grace_min: DEFAULT_ROUND_POSTED_TAIL_GRACE_MIN,
      follow_up_sweep_extra_min: DEFAULT_FOLLOW_UP_SWEEP_EXTRA_MIN,
      posting_receipt_grace_s: DEFAULT_POSTING_RECEIPT_GRACE_S,
      posting_retry_offsets_min: [...DEFAULT_POSTING_RETRY_OFFSETS_MIN],
      posting_retry_window_min: DEFAULT_POSTING_RETRY_WINDOW_MIN,
      session_command_unknown_grace_s: DEFAULT_SESSION_COMMAND_UNKNOWN_GRACE_S,
      session_command_unknown_max_checks: DEFAULT_SESSION_COMMAND_UNKNOWN_MAX_CHECKS,
      session_command_max_start_retries: DEFAULT_SESSION_COMMAND_MAX_START_RETRIES,
      session_compaction_max_s: DEFAULT_SESSION_COMPACTION_MAX_S,
      lens_permits: DEFAULT_LENS_PERMITS,
      lens_grant_stagger_ms: DEFAULT_LENS_GRANT_STAGGER_MS,
      answer_timeout_s: DEFAULT_ANSWER_TIMEOUT_S,
      answer_cap_usd: DEFAULT_ANSWER_CAP_USD,
      round_stage_supervisor_stale_s: DEFAULT_ROUND_STAGE_SUPERVISOR_STALE_S,
      ...(req(raw, "daemon") as Partial<Config["daemon"]>),
    } as Config["daemon"],
    // heartbeat_time defaults so older configs keep parsing; the timezone
    // defaults from [ops], own [eod] value wins — and is checked as [ops] is.
    eod: checkSectionTimeZone(
      {
        heartbeat_time: "09:00",
        pinned_watchdog: true,
        pinned_watchdog_window_min: EOD_PINNED_WATCHDOG_WINDOW_MIN,
        timezone: ops.timezone,
        ...(req(raw, "eod") as Partial<Config["eod"]>),
      } as Config["eod"],
      "[eod] timezone",
    ),
    caps: parseCaps(req(raw, "caps") as Record<string, unknown>),
    models: parseModels(req(raw, "models") as Record<string, any>, REVIEW_PRESETS[preset].effort),
    engine,
    pi: parsePiSection(raw),
    openviking: parseOpenViking((raw.openviking ?? {}) as Record<string, unknown>),
    memory: parseMemory((raw.memory ?? {}) as Record<string, unknown>),
    tui: { ...TUI_DEFAULTS, ...((raw.tui ?? {}) as Partial<TuiConfig>) },
    companion,
    sink: parseSink((raw.sink ?? {}) as Record<string, any>, companion),
    backfill: { ...backfillDefaults(github), ...((raw.backfill ?? {}) as Partial<BackfillConfig>) },
    guards: parseGuardsSection(raw),
    recheck: { ...RECHECK_DEFAULTS, ...((raw.recheck ?? {}) as Partial<RecheckConfig>) },
    review: parseReviewSection(raw, preset),
    escalation: parseEscalation((raw.escalation ?? {}) as Record<string, any>),
    levers: parseLevers((raw.levers ?? {}) as Record<string, any>),
    slack: parseSlack((raw.slack ?? {}) as Record<string, any>, ops.timezone),
    owner: parseOwnerSection(raw),
    scan: parseScan(raw.scan),
    scan_sandbox: parseScanSandbox(raw.scan, companion),
    archive: parseArchive((raw.archive ?? {}) as Record<string, unknown>),
    login_refresh: parseLoginRefresh(
      (raw.login_refresh ?? {}) as Record<string, unknown>,
      Number((req(raw, "daemon") as { round_deadline_min?: number }).round_deadline_min ?? 75),
    ),
    home: parseHomeSection(raw.home),
  };
  validateReviewSection(cfg);
  foldLegacyOwnerSlackId(raw, cfg.owner);
  requireGithubKeys(cfg.github);
  // Every secrets reader in the daemon reads THIS field, so the
  // install locator decides it here, once, for all of them.
  cfg.github.secrets_dir = locateSecrets({
    configured: typeof cfg.github.secrets_dir === "string" ? cfg.github.secrets_dir : "",
  }).path;
  if (cfg.tui.target !== "ssh" && cfg.tui.target !== "local") {
    throw new Error(
      `config.toml [tui]: target must be "ssh" or "local" (got ${JSON.stringify(cfg.tui.target)})`,
    );
  }
  const firstPass = cfg.daemon.round_first_pass_max_min ?? DEFAULT_ROUND_FIRST_PASS_MAX_MIN;
  const passes = cfg.daemon.round_passes_max_min ?? DEFAULT_ROUND_PASSES_MAX_MIN;
  const running =
    cfg.daemon.session_command_running_max_min ?? DEFAULT_SESSION_COMMAND_RUNNING_MAX_MIN;
  const finalize = cfg.daemon.round_finalize_grace_min ?? DEFAULT_ROUND_FINALIZE_GRACE_MIN;
  const stageBounds = [firstPass, passes, running, finalize] as unknown[];
  if (!(
    stageBounds.every((v) => typeof v === "number" && Number.isFinite(v)) &&
    firstPass > 0 &&
    firstPass < passes &&
    passes < running &&
    finalize > 0 &&
    finalize < running
  )) {
    throw new Error(
      "config.toml: require finite numbers 0 < round_first_pass_max_min < round_passes_max_min < session_command_running_max_min and 0 < round_finalize_grace_min < session_command_running_max_min",
    );
  }
  // The two second-scale daemon→pi bounds become command deadlines
  // (`toISOString`), which a non-finite value would throw at the first command.
  for (const key of ["session_command_start_lease_s", "session_bridge_ready_timeout_s"] as const) {
    const v: unknown = cfg.daemon[key];
    if (!(typeof v === "number" && Number.isFinite(v) && v > 0))
      throw new Error(`config.toml: require a finite number [daemon] ${key} > 0`);
  }
  const postedTail = cfg.daemon.round_posted_tail_grace_min ?? DEFAULT_ROUND_POSTED_TAIL_GRACE_MIN;
  if (!(typeof postedTail === "number" && Number.isFinite(postedTail) && postedTail > 0)) {
    throw new Error("config.toml: require round_posted_tail_grace_min > 0");
  }
  const sweepExtra = cfg.daemon.follow_up_sweep_extra_min ?? DEFAULT_FOLLOW_UP_SWEEP_EXTRA_MIN;
  if (!(typeof sweepExtra === "number" && Number.isFinite(sweepExtra) && sweepExtra >= 0)) {
    throw new Error("config.toml: require follow_up_sweep_extra_min >= 0");
  }
  const retryWindow = cfg.daemon.posting_retry_window_min ?? DEFAULT_POSTING_RETRY_WINDOW_MIN;
  const retryOffsets = cfg.daemon.posting_retry_offsets_min ?? DEFAULT_POSTING_RETRY_OFFSETS_MIN;
  if (
    !(typeof retryWindow === "number" && Number.isFinite(retryWindow) && retryWindow > 0) ||
    !Array.isArray(retryOffsets) ||
    retryOffsets.length === 0 ||
    !retryOffsets.every(
      (m, i) =>
        typeof m === "number" &&
        Number.isFinite(m) &&
        m > 0 &&
        m < retryWindow &&
        (i === 0 || m > (retryOffsets[i - 1] as number)),
    )
  ) {
    throw new Error(
      "config.toml: require posting_retry_offsets_min = a non-empty, strictly increasing list of minutes, each > 0 and < posting_retry_window_min (> 0)",
    );
  }
  const lensPermits = cfg.daemon.lens_permits ?? DEFAULT_LENS_PERMITS;
  if (!(Number.isSafeInteger(lensPermits) && lensPermits >= 1)) {
    throw new Error("config.toml: require an integer [daemon] lens_permits >= 1");
  }
  const lensStagger = cfg.daemon.lens_grant_stagger_ms ?? DEFAULT_LENS_GRANT_STAGGER_MS;
  if (!(typeof lensStagger === "number" && Number.isFinite(lensStagger) && lensStagger >= 0)) {
    throw new Error("config.toml: require a finite number [daemon] lens_grant_stagger_ms >= 0");
  }
  const answerTimeout = cfg.daemon.answer_timeout_s ?? DEFAULT_ANSWER_TIMEOUT_S;
  if (!(typeof answerTimeout === "number" && Number.isFinite(answerTimeout) && answerTimeout > 0)) {
    throw new Error("config.toml: require a finite number [daemon] answer_timeout_s > 0");
  }
  const answerCap = cfg.daemon.answer_cap_usd ?? DEFAULT_ANSWER_CAP_USD;
  if (!(typeof answerCap === "number" && Number.isFinite(answerCap) && answerCap > 0)) {
    throw new Error("config.toml: require a finite number [daemon] answer_cap_usd > 0");
  }
  const compactionMax = cfg.daemon.session_compaction_max_s ?? DEFAULT_SESSION_COMPACTION_MAX_S;
  if (!(typeof compactionMax === "number" && Number.isFinite(compactionMax) && compactionMax > 0)) {
    throw new Error("config.toml: require session_compaction_max_s > 0");
  }
  // Shape checks are pure, so they fire on every parse (tests included);
  // the token-file check is I/O and lives in validateSlackConfig.
  checkSlackShape(cfg.slack, cfg.owner);
  delete (cfg.daemon as Record<string, unknown>)["overseer_rotation_days"];
  return cfg;
}

function parseSlack(raw: Record<string, any>, defaultTimezone: string): SlackConfig {
  // Inbound turns went with the overseer: nothing routes a Slack message to a
  // model any more. A config that still asks for it is refused, not ignored,
  // so nobody believes the bot is listening.
  if (raw.inbound !== undefined && raw.inbound !== false) {
    throw new Error(
      "config.toml [slack]: `inbound` is retired — Slack inbound turns went with the overseer " +
        "(the router refuses them: dropped_no_overseer); outbound announcements are unchanged. Remove the key.",
    );
  }
  const rawPolicy = (raw.policy ?? {}) as Record<string, any>;
  // A cause with no cooldown of its own takes the configured default — the
  // same one an unlisted cause gets (`causePolicy`).
  const defaultCooldown =
    rawPolicy.default_cooldown_min ?? SLACK_POLICY_DEFAULTS.default_cooldown_min;
  const causes: Record<string, SlackCausePolicy> = { ...SLACK_CAUSE_DEFAULTS };
  for (const [cause, v] of Object.entries(
    (rawPolicy.causes ?? {}) as Record<string, Partial<SlackCausePolicy>>,
  )) {
    causes[cause] = {
      enabled: v.enabled ?? causes[cause]?.enabled ?? true,
      cooldown_min: Number(v.cooldown_min ?? causes[cause]?.cooldown_min ?? defaultCooldown),
    };
  }
  const { causes: _drop, ...policyScalars } = rawPolicy;
  // `legacy_owner_slack_id` is the legacy alias for [owner] slack_id —
  // consumed by parseConfig's fold, never carried on the parsed shape.
  const { legacy_owner_slack_id: _legacyOwnerId, inbound: _retiredInbound, ...rawScalars } = raw;
  const slack: SlackConfig = {
    ...SLACK_DEFAULTS,
    ...(rawScalars as Partial<SlackConfig>),
    users: { ...((raw.users ?? {}) as Record<string, string>) },
    // The day boundary defaults from [ops]; an explicit
    // [slack.policy] timezone still wins.
    policy: {
      ...SLACK_POLICY_DEFAULTS,
      timezone: defaultTimezone,
      ...(policyScalars as Partial<SlackPolicyConfig>),
      causes,
    },
  };
  // An explicit zone is checked as [ops]'s is — when the concierge is on;
  // a switched-off section is a draft, and nothing reads its clock.
  if (slack.enabled) checkSectionTimeZone(slack.policy, "[slack.policy] timezone");
  // Token *files* are names under secrets_dir, but an absolute or ~-rooted
  // override must still work — expand here so every reader sees one shape.
  slack.bot_token_file = expandHome(slack.bot_token_file);
  slack.app_token_file = expandHome(slack.app_token_file);
  return slack;
}

/** Absolute path of a Slack token file: a bare name resolves under
 * [github].secrets_dir, an absolute/~ path is taken as given. */
export function slackTokenPath(cfg: Config, which: "bot" | "app"): string {
  const name = which === "bot" ? cfg.slack.bot_token_file : cfg.slack.app_token_file;
  return isAbsolute(name) ? name : join(cfg.github.secrets_dir, name);
}

/** Pure (I/O-free) part of Slack boot validation. When disabled, nothing at
 * all is required — the concierge is simply not there. When enabled, the
 * owner's Slack id (`[owner] slack_id`, legacy alias
 * `[slack] legacy_owner_slack_id`) must be set and be a key of [slack.users]. */
function checkSlackShape(slack: SlackConfig, owner: OwnerConfig): void {
  if (!slack.enabled) return;
  const fail = (msg: string): never => {
    throw new Error(`config.toml [slack]: ${msg}`);
  };
  if (!slack.channel.trim()) fail("enabled = true requires a non-empty `channel`");
  if (slack.channel_kind !== "public" && slack.channel_kind !== "private") {
    fail(`channel_kind must be "public" or "private" (got ${JSON.stringify(slack.channel_kind)})`);
  }
  if (!owner.slack_id.trim()) fail("enabled = true requires a non-empty `[owner] slack_id`");
  if (!(owner.slack_id in slack.users)) {
    fail(
      `[owner] slack_id '${owner.slack_id}' must appear as a key in [slack.users] (it is the only source of own-PR rights)`,
    );
  }
  for (const key of [
    "daily_turns",
    "per_user_daily_turns",
    "thread_replies_per_day",
    "announcements_per_hour",
  ] as const) {
    const cap = slack.policy[key];
    if (typeof cap !== "number" || !Number.isFinite(cap) || cap < 0)
      fail(`policy.${key} must be a finite non-negative number`);
  }
}

/** How validation reads a secret file. Injectable so tests never need real
 * files; the default is the same read-and-trim every other secret gets.
 * Undefined means absent or empty; a file that is there but cannot be read
 * (permissions, a directory) throws with its cause, so a mount problem is
 * never reported as a missing token. */
export type SecretReader = (path: string) => string | undefined;

export const fsSecretReader: SecretReader = (path) => {
  let v: string;
  try {
    v = readFileSync(path, "utf8").trim();
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw new Error(`cannot read secret file '${path}': ${(err as Error).message}`, { cause: err });
  }
  return v.length > 0 ? v : undefined;
};

/**
 * Full Slack boot validation — shape plus token-file presence. A missing or
 * empty token is a HARD startup error: the concierge never degrades silently
 * into a read-only half-presence in the channel. Disabled ⇒ nothing is read.
 */
export function validateSlackConfig(cfg: Config, deps: { readSecret?: SecretReader } = {}): void {
  checkSlackShape(cfg.slack, cfg.owner);
  if (!cfg.slack.enabled) return;
  const read = deps.readSecret ?? fsSecretReader;
  for (const which of ["bot", "app"] as const) {
    const path = slackTokenPath(cfg, which);
    if (!read(path)) {
      throw new Error(
        `config.toml [slack]: ${which} token file '${path}' is missing or empty — Slack cannot start`,
      );
    }
  }
}

let cached: Config | null = null;

/**
 * The live config's path for this process, decided by the install locator:
 * `$QCR_CONFIG`, else the install's config home — never the checkout's
 * `config.toml`. The ONE answer every no-argument
 * `loadConfig()` reads, and the one the daemon hands its sessions.
 */
export function liveConfigPath(): string {
  return locateConfig().path;
}

export function loadConfig(path?: string): Config {
  if (cached && !path) return cached;
  const p = path ?? liveConfigPath();
  if (!path && !existsSync(p)) {
    // A missing live config says where it was looked for, and — when the
    // checkout still strands one — how to move it.
    throw new MissingConfigError(
      missingConfigMessage(locateConfig(), strandedCheckoutConfig({ root: sandboxRoot() })),
    );
  }
  const cfg = parseConfig(readFileSync(p, "utf8"));
  validateSlackConfig(cfg);
  if (!path) cached = cfg;
  return cfg;
}
