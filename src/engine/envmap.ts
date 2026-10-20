// Inventory of every QCR_* and OPENVIKING_* name that appears in extensions/,
// each classified by what the extension does with it. A pure table: nothing
// imports it at runtime yet (P1.2). The engine's SDK session builder (P2) and
// the extension factories (P3) read it to know which names must reach a session
// as factory config and which stay a concern of the bash child or the companion.
//
//   extension-config  an extension reads the name from the pi process's own env.
//                     On an SDK route it becomes factory config, since there is
//                     no spawn env to carry it.
//   bash-child-env    the name only concerns the model's bash: a per-invocation
//                     prefix (`QCR_EXPECTED_HEAD=… script`) or a relocator the
//                     posting scripts read and bash-guard refuses in a command.
//                     No extension reads its value.
//   companion-only    read only by the companion's extensions (setup*, onboarding,
//                     companion-guard, tui-view) or set only in the companion;
//                     no review session reads it.
//
// `readers` lists every file under extensions/ whose text carries the name,
// comments included: tests/extension-envmap.test.ts scans extensions/ and fails
// on an unclassified name, a stale entry or a reader list that has drifted.
// A name read only through a constant imported from src/ is caught by the
// comment that names it, so keep that comment.

export type ExtensionEnvKind = "extension-config" | "bash-child-env" | "companion-only";

export interface ExtensionEnvEntry {
  readonly kind: ExtensionEnvKind;
  readonly readers: readonly string[];
  readonly note: string;
}

const OV = "vendor/openviking-pi";

export const EXTENSION_ENV: Readonly<Record<string, ExtensionEnvEntry>> = {
  // ---- QCR_*: the session's identity and where it lives
  QCR_PR: {
    kind: "extension-config",
    readers: ["ledger-pin.ts"],
    note: "the session's own PR number; absent outside a PR session",
  },
  QCR_PR_META: {
    kind: "extension-config",
    readers: ["ledger-pin.ts"],
    note: "PR identity string the ledger mirror stamps",
  },
  QCR_SESSION_NAME: {
    kind: "extension-config",
    readers: ["inject-bridge.ts", "ledger-pin.ts"],
    note: "pr-<n>",
  },
  QCR_SANDBOX_ROOT: {
    kind: "extension-config",
    readers: ["bash-guard.ts", "inject-bridge.ts", "ledger-pin.ts"],
    note: "the sandbox the session runs in; also a relocator bash-guard refuses in a command",
  },
  QCR_STATE_DB: {
    kind: "extension-config",
    readers: ["bash-guard.ts"],
    note: "state database; the posting scripts read it too, and bash-guard refuses it in a command",
  },
  QCR_CONFIG: {
    kind: "extension-config",
    readers: ["bash-guard.ts", "onboarding.ts"],
    note: "the install's resolved config path; bash-guard reads it for the secrets dir and refuses it in a command",
  },
  QCR_CONFIG_HOME: {
    kind: "extension-config",
    readers: ["bash-guard.ts"],
    note: "absolute config-home override; feeds bash-guard's secret-path set",
  },
  QCR_INSTALL: {
    kind: "extension-config",
    readers: ["bash-guard.ts", "setup.ts"],
    note: "install locator; expands $QCR_INSTALL in guarded paths",
  },
  QCR_IPC_SOCKET: {
    kind: "extension-config",
    readers: ["bash-guard.ts"],
    note: "the worker-daemon socket (P7.2a); its directory is the IPC run dir bash-guard closes to reads",
  },
  QCR_IPC_CAP_FD: {
    kind: "extension-config",
    readers: ["debug-round.ts"],
    note: "the fd number of the round's IPC capability (P7.2a); a bot debug round's bash hands that fd to each command",
  },
  QCR_SECRETS_MOUNT: {
    kind: "extension-config",
    readers: ["bash-guard.ts"],
    note: "container secrets mount; feeds bash-guard's secret-path set",
  },
  QCR_REPLAY: {
    kind: "extension-config",
    readers: ["bash-guard.ts"],
    note: "=1 on a replay pi's own env, which no bash command can set",
  },
  QCR_TAKEOVER: {
    kind: "extension-config",
    readers: ["bash-guard.ts"],
    note: "=1 on a takeover pi's own env (P8.13): the post scripts are not sanctioned there",
  },

  // ---- QCR_*: the inject bridge and the ledger mirror
  QCR_INJECT_DIR: {
    kind: "extension-config",
    readers: ["inject-bridge.ts"],
    note: "inject directory override",
  },
  QCR_LEDGER_FILE: {
    kind: "extension-config",
    readers: ["debug-round.ts", "ledger-pin.ts", "lens.ts"],
    note: "ledger mirror file override; lens.ts keeps its lens-ledger.jsonl and lens-sessions/ beside it",
  },
  QCR_DEBUG_ORDER_FILE: {
    kind: "extension-config",
    readers: ["debug-round.ts"],
    note: "the round order a debug round (qcr review --debug-pi) sends as its first message",
  },
  QCR_DEBUG_TASKS_DIR: {
    kind: "extension-config",
    readers: ["debug-round.ts"],
    note: "the task dir whose rows a debug round launches as its planned wave",
  },
  QCR_DEBUG_STATUS_FILE: {
    kind: "extension-config",
    readers: ["debug-round.ts"],
    note: "where a bot debug round (P8.13b) records its progress; the daemon reads order_sent_at off it",
  },
  QCR_DEBUG_PACK_FILE: {
    kind: "extension-config",
    readers: ["debug-round.ts"],
    note: "the round's context pack, which a bot debug round keeps in its pass dir, not beside the ledger",
  },
  QCR_DEBUG_STUB_FILE: {
    kind: "extension-config",
    readers: ["debug-round.ts"],
    note: "the reviewer stub (D34) a bot debug round's lens passes carry; the production tree's cwd holds none",
  },
  QCR_DEBUG_LENS_DIR: {
    kind: "extension-config",
    readers: ["debug-round.ts"],
    note: "where a bot debug round keeps its lens ledger and lens JSONLs (D10)",
  },
  QCR_SESSION_BRIDGE_GENERATION: {
    kind: "extension-config",
    readers: ["inject-bridge.ts"],
    note: "bridge generation the daemon minted for this session",
  },
  QCR_SESSION_BRIDGE_STATE_FILE: {
    kind: "extension-config",
    readers: ["inject-bridge.ts"],
    note: "bridge state file the daemon wrote for this session",
  },

  // ---- QCR_*: lens launching
  QCR_SUBAGENT_MAX_CONCURRENCY: {
    kind: "extension-config",
    readers: ["setup.ts"],
    note: "concurrent lens cap; the VM and the companion each pass their own",
  },

  // ---- QCR_*: the model's bash (per-invocation arguments and relocators)
  QCR_EXPECTED_HEAD: {
    kind: "bash-child-env",
    readers: ["bash-guard.ts"],
    note: "per-call prefix on a posting command",
  },
  QCR_ROUND_NO: {
    kind: "bash-child-env",
    readers: ["bash-guard.ts"],
    note: "per-call prefix (or `export` line)",
  },
  QCR_POSTING_KEY: {
    kind: "bash-child-env",
    readers: ["bash-guard.ts"],
    note: "per-call argument of a posting script",
  },
  QCR_POST_RESPONSE: {
    kind: "bash-child-env",
    readers: ["bash-guard.ts"],
    note: "per-call argument of a posting script",
  },
  QCR_DRYRUN_DIR: {
    kind: "bash-child-env",
    readers: ["bash-guard.ts"],
    note: "relocator the posting scripts read; bash-guard refuses it in a command",
  },
  QCR_POSTING_RECEIPT_DIR: {
    kind: "bash-child-env",
    readers: ["bash-guard.ts"],
    note: "relocator the posting scripts read; bash-guard refuses it in a command",
  },

  // ---- QCR_*: the companion
  QCR_ROOT: {
    kind: "companion-only",
    readers: [
      "companion-guard.ts",
      "onboarding.ts",
      "setup-replay.ts",
      "setup-scan.ts",
      "setup.ts",
      "tui-view.ts",
    ],
    note: "the app checkout the companion runs from",
  },
  QCR_FEED_DIR: {
    kind: "companion-only",
    readers: ["tui-view.ts"],
    note: "the TUI's published feed",
  },
  QCR_GITHUB_READ_ENV: {
    kind: "companion-only",
    readers: ["companion-guard.ts", "setup-replay.ts", "setup.ts"],
    note: "file holding the companion's read-only GitHub token (rule 8)",
  },
  QCR_GITHUB_READ_TOKEN: {
    kind: "companion-only",
    readers: ["companion-guard.ts"],
    note: "named in the guard's message and its API-write patterns; the companion's read-only token",
  },
  QCR_REVIEWED_REPO: {
    kind: "companion-only",
    readers: ["setup.ts"],
    note: "reviewed checkout inside the companion",
  },
  QCR_TRACKER_DIR: {
    kind: "companion-only",
    readers: ["setup.ts"],
    note: "tracker mount for the scan triage",
  },

  // ---- QCR_OV_*: OpenViking fork additions
  QCR_OV_LEAF: {
    kind: "extension-config",
    readers: [`${OV}/qcr-leaf.ts`, `${OV}/qcr-shim.ts`],
    note: "forces leaf mode (no ambient memory work)",
  },
  QCR_OV_RECALL_HINT_FILE: {
    kind: "extension-config",
    readers: [`${OV}/qcr-hint.ts`],
    note: "per-session recall hint file",
  },
  QCR_OV_RETIRED_FILE: {
    kind: "extension-config",
    readers: [`${OV}/qcr-recall.ts`],
    note: "retired-URI list beside the sessions' ovcli.conf",
  },
  QCR_OV_SESSION_ID: {
    kind: "extension-config",
    readers: [`${OV}/qcr-shim.ts`, `${OV}/sync.ts`],
    note: "session id that survives the tmux server env",
  },

  // ---- OPENVIKING_*: upstream plugin config, read in-process by the vendored extension
  OPENVIKING_ACCOUNT: {
    kind: "extension-config",
    readers: [`${OV}/shared/credentials.mjs`],
    note: "account",
  },
  OPENVIKING_API_KEY: {
    kind: "extension-config",
    readers: [`${OV}/shared/credentials.mjs`],
    note: "credential; the daemon sets it only in env a model's bash cannot read",
  },
  OPENVIKING_BASE_URL: {
    kind: "extension-config",
    readers: [`${OV}/shared/credentials.mjs`],
    note: "server URL alias",
  },
  OPENVIKING_BEARER_TOKEN: {
    kind: "extension-config",
    readers: [`${OV}/shared/credentials.mjs`],
    note: "credential alias of OPENVIKING_API_KEY",
  },
  OPENVIKING_CLI_CONFIG_FILE: {
    kind: "extension-config",
    readers: [`${OV}/shared/credentials.mjs`],
    note: "ovcli.conf path",
  },
  OPENVIKING_CONFIG_FILE: {
    kind: "extension-config",
    readers: [`${OV}/config.ts`, `${OV}/shared/credentials.mjs`],
    note: "ov.conf path",
  },
  OPENVIKING_CREDENTIAL_SOURCE: {
    kind: "extension-config",
    readers: [`${OV}/shared/credentials.mjs`],
    note: "credential source selector",
  },
  OPENVIKING_CREDENTIALS_SOURCE: {
    kind: "extension-config",
    readers: [`${OV}/shared/credentials.mjs`],
    note: "alias of OPENVIKING_CREDENTIAL_SOURCE",
  },
  OPENVIKING_MCP_URL: {
    kind: "extension-config",
    readers: [`${OV}/shared/credentials.mjs`],
    note: "MCP endpoint",
  },
  OPENVIKING_PEER_ID: {
    kind: "extension-config",
    readers: [`${OV}/shared/credentials.mjs`],
    note: "actor peer",
  },
  OPENVIKING_PENDING_DIR: {
    kind: "extension-config",
    readers: [`${OV}/qcr-shim.ts`],
    note: "pending-queue directory",
  },
  OPENVIKING_PENDING_MAX_RETRIES: {
    kind: "extension-config",
    readers: [`${OV}/qcr-shim.ts`],
    note: "queue retry cap",
  },
  OPENVIKING_PENDING_REPLAY_LIMIT: {
    kind: "extension-config",
    readers: [`${OV}/qcr-shim.ts`],
    note: "items replayed per session start",
  },
  OPENVIKING_PENDING_TTL_DAYS: {
    kind: "extension-config",
    readers: [`${OV}/qcr-shim.ts`],
    note: "queue item age cap",
  },
  OPENVIKING_RECALL_LIMIT: {
    kind: "extension-config",
    readers: [`${OV}/qcr-shim.ts`],
    note: "recall result limit",
  },
  OPENVIKING_RECALL_PEER_SCOPE: {
    kind: "extension-config",
    readers: [`${OV}/qcr-shim.ts`],
    note: "actor or all",
  },
  OPENVIKING_RECALL_QUERY_EXPANSION: {
    kind: "extension-config",
    readers: [`${OV}/config.ts`, `${OV}/qcr-shim.ts`],
    note: "auto or off",
  },
  OPENVIKING_SESSION_ID: {
    kind: "extension-config",
    readers: [`${OV}/index.ts`, `${OV}/qcr-shim.ts`, `${OV}/sync.ts`],
    note: "upstream-shaped name of QCR_OV_SESSION_ID",
  },
  OPENVIKING_STATE_DIR: {
    kind: "extension-config",
    readers: [`${OV}/shared/recall-core.mjs`],
    note: "recall state directory",
  },
  OPENVIKING_URL: {
    kind: "extension-config",
    readers: [`${OV}/shared/credentials.mjs`],
    note: "server URL",
  },
  OPENVIKING_USER: {
    kind: "extension-config",
    readers: [`${OV}/qcr-namespaces.ts`, `${OV}/shared/credentials.mjs`],
    note: "user namespace",
  },
  OPENVIKING_WORKSPACE_PEER: {
    kind: "extension-config",
    readers: [`${OV}/qcr-shim.ts`],
    note: "workspace peer switch",
  },
  OPENVIKING_REVIEWER_KEY: {
    kind: "companion-only",
    readers: [`${OV}/config.ts`, `${OV}/index.ts`, `${OV}/qcr-namespaces.ts`],
    note: "second (reviewer) key; the daemon never puts it in a session env",
  },
  OPENVIKING_REVIEWER_USER: {
    kind: "companion-only",
    readers: [`${OV}/qcr-namespaces.ts`],
    note: "reviewer namespace user, read with OPENVIKING_REVIEWER_KEY",
  },
};

/** Names the scan finds that are not environment variables: error codes. They
 * are listed so the test can tell them from an unclassified env name. */
export const EXTENSION_NON_ENV_NAMES: Readonly<Record<string, string>> = {
  QCR_COMMIT_DISABLED:
    "error code of the fork's refused session commit (vendor/openviking-pi/qcr-recall.ts)",
};

/** The classified names of one kind, sorted. */
export function extensionEnvNames(kind: ExtensionEnvKind): string[] {
  return Object.entries(EXTENSION_ENV)
    .filter(([, e]) => e.kind === kind)
    .map(([name]) => name)
    .sort();
}
