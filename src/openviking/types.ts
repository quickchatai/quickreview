// Shared shapes for the OpenViking runtime. Kept in their own module
// so `src/state.ts` can type the heartbeat block without importing the
// supervisor (and its child-process machinery) into every status writer.

/** One health sample: what `/health` and `/ready` said, plus what it cost. */
export interface OpenVikingHealth {
  /** `/health` answered at all (the process is up and serving). */
  reachable: boolean;
  /** `/ready` returned 200 — AGFS, VectorDB, key manager and embedding are all
   * usable. 503 means "up but not serving memory yet", which is a legitimate
   * steady state during warm-up and must never look like a crash. */
  ready: boolean;
  /** Server-reported version from `/health` (unauthenticated). */
  version?: string;
  /** Why the probe failed, when it did. Never thrown — always reported. */
  error?: string;
  /** ISO instant of the probe. */
  at: string;
}

/** A `/proc/<pid>` sample of the supervised child. */
export interface ProcSample {
  rss_bytes: number;
  /** Percent of ONE core since the previous sample (so 200 = both cores of the
   * 2-CPU cap). Absent on the first sample — a rate needs two points. */
  cpu_pct?: number;
}

/** An embedder identity — provider, model and dimension, never a credential.
 * The three keys the server's own compatibility check compares. */
export interface Embedder {
  provider: string;
  model: string;
  dimension: number;
}

/** One namespace row of the re-embed journal (scripts/openviking-reembed.mjs). */
export interface ReembedNamespace {
  /** `operator` = a namespace whose key this host does not hold; its holder
   * rebuilds it (`qcr memory reembed`) and receipts it (`settle`). */
  state: "pending" | "failed" | "completed" | "operator";
  at?: string;
  attempts?: number;
  detail?: string;
  task_id?: string;
  scanned_records?: number;
  rebuilt_records?: number;
  failed_records?: number;
  unsupported_records?: number;
  settled_by?: string;
}

/** What the script's `journalStatus` answers — the journal, read. */
export interface ReembedJournalStatus {
  state: "none" | "pending" | "failed" | "completed" | "unreadable";
  embedder?: Embedder;
  previous?: Embedder | null;
  reset_at?: string;
  moved_to?: string;
  awaiting_operator?: string[];
  namespaces?: Record<string, ReembedNamespace>;
}

/**
 * The `reembed` block inside `openviking`: the embedder migration
 * as the daemon sees it. `unknown` means the journal could not be read at all
 * — never folded into `none`.
 */
export interface ReembedStatus extends Omit<ReembedJournalStatus, "state"> {
  state: ReembedJournalStatus["state"] | "unknown";
  /** Resume attempts this daemon process has made. */
  attempts: number;
  last_run_at?: string;
  last_error?: string;
  /** config.toml `[openviking] embedding_*` names a different embedder than
   * the ov.conf the entrypoint rendered — reported, never corrected here. */
  config_drift?: { config_toml: Embedder; ov_conf: Embedder };
}

/**
 * The `openviking` block of `state/status.json`.
 *
 * Everything here is a CACHED read: `OpenVikingSupervisor.status()` is
 * synchronous and never throws, because the heartbeat writer must not be able
 * to fail — or block — on the memory engine.
 */
export interface OpenVikingStatus {
  enabled: boolean;
  /** The supervisor believes a child process is alive. */
  running: boolean;
  pid?: number;
  /** `/health` answered on the last poll. */
  reachable: boolean;
  /** `/ready` returned 200 on the last poll — the gate that matters. */
  ready: boolean;
  /** Server-reported version. */
  version?: string;
  /** config.toml `[openviking] version` — the triple-mirrored pin. */
  pinned_version: string;
  /** Reported version present and != the pin. Absent when unknown. */
  version_drift?: boolean;
  /** Restarts since the daemon booted. */
  restarts: number;
  /** ISO instant the current child started. */
  started_at?: string;
  last_exit?: { code: number | null; signal: string | null; at: string };
  /** Last spawn/probe failure, human-readable. */
  last_error?: string;
  /** Resident set size of the server process (the 397 MiB idle / 456 MiB warm
   * measurement). Monitoring only — the owner ratified NO RSS watchdog and NO
   * auto-restart on a memory budget; do not add one. */
  rss_bytes?: number;
  /** Percent of one core since the previous sample. CPU is the cost to watch
   * (~1.63 core-seconds per ~500 B write on the 2-core quota). */
  cpu_pct?: number;
  /** ISO instant of the last health poll. */
  checked_at?: string;
  /** The embedder migration. Absent when no driver runs. */
  reembed?: ReembedStatus;
}
