// The embedder migration's daemon half: re-embed reviewer memory
// after the boot's `prepare` step reset the vector collection.
//
// ONE IMPLEMENTATION, NOT A SECOND ONE. `scripts/openviking-reembed.mjs` owns
// the migration — the journal, the disk reset the entrypoint runs before any
// server starts, and the reindex call against the server. This module drives
// its `resume` from inside the daemon once `/ready` passes and folds the
// journal into the heartbeat. The import is DYNAMIC and by file URL on
// purpose (the same shape as src/tui/memforward.ts): the script is
// dependency-free, build-free ESM that the container entrypoint runs BEFORE
// `dist/` exists, so a static import would either drag it into the build or
// fork the logic.
//
// Three properties, enforced rather than documented:
//
//   * NOTHING HERE IS ON A ROUND'S PATH. The driver is armed on a timer seam,
//     never awaited by the boot, and a round that runs while the reviewer's
//     vectors are still rebuilding simply gets a thinner memory block — the
//     standing rule for every OpenViking call site.
//   * THE REVIEWER KEY, AND NOTHING ELSE. The reindex carries the same USER
//     key every review session holds; the server confines it to the
//     reviewer's namespace (a 403 for any other, verified live), so no root
//     or admin credential exists on this path.
//   * HONEST STATUS. `status()` is synchronous and total, and re-reads the
//     journal on every call (an operator's `settle` lands with no timer
//     armed). The journal state it reports comes from the script's own
//     `journalStatus`; when the script cannot be loaded or read the state is
//     `unknown`, never `none` — "could not read" is not "nothing there".
//
// It also carries the one check that makes `[openviking] embedding_*` in
// config.toml mean something: the ENTRYPOINT renders the embedder (group_vars
// or the compose environment), and a config.toml that says one thing over an
// ov.conf that runs another is exactly the drift that turns a hosted store
// into a reset on the next boot. The daemon cannot correct it — it reports it,
// loudly, in the log and the heartbeat.
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import {
  openVikingBaseUrl,
  ovConfEmbedder,
  type OpenVikingConfig,
  type OvConfEmbedder,
} from "../config.js";
import type { Schedule } from "./supervisor.js";
import type { Embedder, ReembedJournalStatus, ReembedStatus } from "./types.js";

/** One namespace's reindex outcome, as the script reports it. */
type ReindexCounts = {
  scanned_records: number;
  rebuilt_records: number;
  failed_records: number;
  unsupported_records: number;
};
export type ReindexOutcome = { uri: string; detail?: string; task_id?: string } & (
  | ({ status: "completed" } & ReindexCounts)
  | ({ status: "failed" | "busy" | "timeout" } & Partial<ReindexCounts>)
);

/** The HTTP seam the script takes — the minimum it reads. */
export type ReembedFetch = (
  url: string,
  init?: { method?: string; headers?: Record<string, string>; body?: string; signal?: AbortSignal },
) => Promise<{ status: number; json?: () => Promise<unknown> }>;

/**
 * The slice of `scripts/openviking-reembed.mjs` this module depends on.
 * Declared structurally because the script is untyped JS: this interface IS
 * the contract, and `tests/openviking-reembed-driver.test.ts` checks the real
 * module still satisfies it.
 */
export interface ReembedModule {
  journalStatus(home: string): ReembedJournalStatus;
  configuredEmbedder(conf: unknown): Embedder;
  sameEmbedder(a: Embedder, b: Embedder): boolean;
  resume(opts: {
    home: string;
    base: string;
    key: string;
    user: string;
    fetchFn?: ReembedFetch;
    log?: (line: string) => void;
  }): Promise<{ action: string; state: string; detail?: string; entry?: { detail?: string } }>;
  reindexNamespace(opts: {
    base: string;
    key: string;
    user: string;
    fetchFn?: ReembedFetch;
    log?: (line: string) => void;
  }): Promise<ReindexOutcome>;
}

export function loadReembedModule(repoRoot: string): Promise<ReembedModule> {
  return import(
    pathToFileURL(join(repoRoot, "scripts", "openviking-reembed.mjs")).href
  ) as Promise<ReembedModule>;
}

/** How often the driver re-checks `/ready` while a re-embed is outstanding. */
export const REEMBED_POLL_MS = 15_000;
/** Pause between resume attempts that did not complete (busy, timeout, a
 * partial rebuild, a dead server). Retried forever, like the supervisor's
 * respawn: an outstanding re-embed is worse than a periodic retry, and every
 * attempt is on record in the journal and the heartbeat. */
export const REEMBED_RETRY_MS = 5 * 60_000;

export interface ReembedDriverDeps {
  cfg: OpenVikingConfig;
  /** The checkout root — where `scripts/openviking-reembed.mjs` lives. */
  repoRoot: string;
  /** Path of the reviewer USER key file in the secrets dir. */
  keyPath: string;
  /** The supervisor's cached `/ready` — the gate a resume waits for. */
  ready: () => boolean;
  log: (msg: string, extra?: unknown) => void;
  schedule?: Schedule;
  load?: () => Promise<ReembedModule>;
  fetchFn?: ReembedFetch;
  now?: () => Date;
  pollMs?: number;
  retryMs?: number;
}

const defaultSchedule: Schedule = (fn, ms) => {
  const t = setTimeout(fn, ms);
  t.unref?.();
  return () => clearTimeout(t);
};

/** A journal state with a re-embed still owed by this host: the one test the
 * boot, the tick and the retry all apply. */
function outstanding(state: ReembedJournalStatus["state"] | undefined): boolean {
  return state === "pending" || state === "failed";
}

/** An `api_base` for comparison: absent and empty are the same, and a trailing
 * slash means nothing. */
function baseOf(v: unknown): string {
  return typeof v === "string" ? v.trim().replace(/\/+$/, "") : "";
}

function describeOv(e: OvConfEmbedder): string {
  return `${e.provider}/${e.model} (${e.dimension} dims)${e.api_base ? ` at ${e.api_base}` : ""}`;
}

export class ReembedDriver {
  private readonly deps: ReembedDriverDeps;
  private readonly schedule: Schedule;
  private readonly now: () => Date;
  private module: ReembedModule | null = null;
  private journal: ReembedJournalStatus | null = null;
  private unknownWhy: string | undefined;
  private drift: ReembedStatus["config_drift"];
  private attempts = 0;
  private lastRunAt: string | undefined;
  private lastError: string | undefined;
  private migrationOwed = false;
  private inFlight = false;
  private cancel: (() => void) | null = null;
  private stopped = false;
  private started = false;

  constructor(deps: ReembedDriverDeps) {
    this.deps = deps;
    this.schedule = deps.schedule ?? defaultSchedule;
    this.now = deps.now ?? (() => new Date());
  }

  /** Synchronous and non-blocking: loads the script and reads the journal in
   * the background, then arms the resume loop only if a re-embed is on
   * record. The daemon's boot never waits on it. */
  start(): void {
    if (this.started) return;
    this.started = true;
    if (!this.deps.cfg.enabled) return;
    void this.boot();
  }

  stop(): void {
    this.stopped = true;
    this.cancel?.();
    this.cancel = null;
  }

  private async boot(): Promise<void> {
    try {
      this.module = await (this.deps.load ?? (() => loadReembedModule(this.deps.repoRoot)))();
    } catch (err) {
      this.unknownWhy = `could not load scripts/openviking-reembed.mjs: ${err instanceof Error ? err.message : String(err)}`;
      this.deps.log(`openviking: reembed driver off — ${this.unknownWhy}`);
      return;
    }
    this.checkDrift();
    if (!this.refresh()) return;
    const state = this.journal?.state;
    if (outstanding(state)) {
      this.deps.log(
        `openviking: reembed of ${this.deps.cfg.user} memory is outstanding (${state}) — resuming once the server is ready`,
      );
      this.arm(0);
    } else if (state === "unreadable") {
      this.deps.log(
        `openviking: reembed journal under ${this.deps.cfg.home} exists and cannot be parsed — an operator has to look (docs/memory-embeddings.md)`,
      );
    }
  }

  /** config.toml's declared embedder against the one ov.conf actually runs.
   * Both sides are spelled the way ov.conf spells them (`ovConfEmbedder`):
   * `local` is the engine's OpenAI-compatible provider at the local
   * embedder's loopback `api_base`, so the `api_base` is part of
   * the comparison — the record alone cannot tell the loopback service from a
   * hosted model of the same name. */
  private checkDrift(): void {
    const confPath = this.deps.cfg.config_file;
    if (!this.module || !existsSync(confPath)) return;
    let ovConf: OvConfEmbedder;
    try {
      const conf = JSON.parse(readFileSync(confPath, "utf8")) as {
        embedding?: { dense?: { api_base?: unknown } };
      };
      const apiBase = baseOf(conf?.embedding?.dense?.api_base);
      ovConf = {
        ...this.module.configuredEmbedder(conf),
        ...(apiBase ? { api_base: apiBase } : {}),
      };
    } catch (err) {
      this.deps.log(`openviking: could not read ${confPath} for the embedder check`, err);
      return;
    }
    const declared = ovConfEmbedder(this.deps.cfg);
    if (
      this.module.sameEmbedder(declared, ovConf) &&
      baseOf(declared.api_base) === baseOf(ovConf.api_base)
    )
      return;
    this.drift = { config_toml: declared, ov_conf: ovConf };
    this.deps.log(
      `openviking: EMBEDDER DRIFT — config.toml [openviking] declares ${this.deps.cfg.embedding_provider} (ov.conf should say ${describeOv(declared)}) ` +
        `but ov.conf, rendered by the entrypoint, runs ${describeOv(ovConf)}. The boot renders group_vars ` +
        "(or the compose environment), not config.toml: align them, or the next boot resets the vector store for the wrong embedder (docs/memory-embeddings.md)",
    );
  }

  /** Re-read the journal through the script. False when it could not be read
   * at all (the status then says `unknown`, not the last state it read). A
   * failure is logged when it starts or changes, not on every heartbeat. */
  private refresh(): boolean {
    if (!this.module) return false;
    try {
      this.journal = this.module.journalStatus(this.deps.cfg.home);
      if (this.journal.state !== "unreadable") this.migrationOwed = outstanding(this.journal.state);
      this.unknownWhy = undefined;
      return true;
    } catch (err) {
      const why = `journal read failed: ${err instanceof Error ? err.message : String(err)}`;
      this.journal = null;
      if (why !== this.unknownWhy) this.deps.log(`openviking: reembed ${why}`);
      this.unknownWhy = why;
      return false;
    }
  }

  private arm(ms: number): void {
    if (this.stopped) return;
    this.cancel?.();
    this.cancel = this.schedule(() => {
      this.cancel = null;
      void this.tick();
    }, ms);
  }

  private async tick(): Promise<void> {
    if (this.stopped || this.inFlight || !this.module) return;
    if (!this.refresh() || this.journal?.state === "unreadable") {
      if (this.migrationOwed) this.arm(this.deps.pollMs ?? REEMBED_POLL_MS);
      return;
    }
    if (!outstanding(this.journal?.state)) return;
    if (!this.deps.ready()) {
      this.arm(this.deps.pollMs ?? REEMBED_POLL_MS);
      return;
    }
    this.inFlight = true;
    let key = "";
    const scrub = (text: string): string => (key ? text.split(key).join("<redacted>") : text);
    try {
      key = readKey(this.deps.keyPath);
      this.attempts += 1;
      this.lastRunAt = this.now().toISOString();
      const run = await this.module.resume({
        home: this.deps.cfg.home,
        base: openVikingBaseUrl(this.deps.cfg),
        key,
        user: this.deps.cfg.user,
        ...(this.deps.fetchFn ? { fetchFn: this.deps.fetchFn } : {}),
        log: (line) => this.deps.log(scrub(line)),
      });
      const detail = scrub(run.detail ?? run.entry?.detail ?? "");
      if (run.state === "completed") {
        this.lastError = undefined;
        this.deps.log(`openviking: reembed of ${this.deps.cfg.user} memory completed — ${detail}`);
      } else {
        this.lastError = detail || run.state;
        this.deps.log(
          `openviking: reembed of ${this.deps.cfg.user} memory not finished (${run.state}) — retrying in ${Math.round((this.deps.retryMs ?? REEMBED_RETRY_MS) / 1000)}s: ${detail}`,
        );
      }
    } catch (err) {
      // The script is total, but a caller-supplied fetch seam is not.
      this.lastError = scrub(err instanceof Error ? err.message : String(err));
      this.deps.log(`openviking: reembed resume threw: ${this.lastError}`);
    } finally {
      this.inFlight = false;
    }
    this.refresh();
    if (this.migrationOwed) this.arm(this.deps.retryMs ?? REEMBED_RETRY_MS);
  }

  /** The `reembed` block of the heartbeat's `openviking` entry. Total.
   * Re-reads the journal: once the reviewer's run completes no timer is
   * armed, and an operator's `settle` for another namespace must still reach
   * the heartbeat without a daemon restart. */
  status(): ReembedStatus {
    const base: ReembedStatus = { state: "unknown", attempts: this.attempts };
    try {
      this.refresh();
      // The journal's own fields, forwarded whole (an empty awaiting list
      // is dropped: nothing is awaiting).
      const { awaiting_operator: awaiting, ...journal } = this.journal ?? {};
      return {
        ...base,
        ...journal,
        ...(awaiting?.length ? { awaiting_operator: awaiting } : {}),
        ...(this.lastRunAt ? { last_run_at: this.lastRunAt } : {}),
        ...((this.lastError ?? this.unknownWhy)
          ? { last_error: this.lastError ?? this.unknownWhy }
          : {}),
        ...(this.drift ? { config_drift: this.drift } : {}),
      };
    } catch {
      return base;
    }
  }
}

/** The reviewer key file's contents, or "" — an absent key is a degraded
 * mode the script answers (`no reviewer key`), never a throw here. */
function readKey(path: string): string {
  try {
    return readFileSync(path, "utf8").trim();
  } catch {
    return "";
  }
}

// ---- the operator's side (qcr memory reembed) --------------------------------

export interface OperatorReembedResult {
  user: string;
  status: ReindexOutcome["status"] | "no-key";
  detail: string;
}

/**
 * Re-embed the namespaces whose keys THIS machine holds — the operator's PC,
 * where the companion key lives and the daemon's never will (the companion
 * boundary). Runs the script's own `reindexNamespace` per user over the memory
 * forward; a user with no key in the keys file is reported, never skipped
 * silently. `ok` is true only when every namespace completed with zero failed
 * records.
 */
export async function reembedNamespaces(opts: {
  module: Pick<ReembedModule, "reindexNamespace">;
  base: string;
  users: readonly string[];
  keyFor: (user: string) => string | null;
  log: (line: string) => void;
  fetchFn?: ReembedFetch;
}): Promise<{ ok: boolean; results: OperatorReembedResult[] }> {
  const results: OperatorReembedResult[] = [];
  // Whether each namespace finished clean — read from the counts, never from
  // the words the detail renders them in.
  const clean: boolean[] = [];
  for (const user of opts.users) {
    const key = opts.keyFor(user);
    if (!key) {
      results.push({
        user,
        status: "no-key",
        detail: `no ${user} key on this machine — nothing was sent`,
      });
      clean.push(false);
      continue;
    }
    const run = await opts.module.reindexNamespace({
      base: opts.base,
      key,
      user,
      ...(opts.fetchFn ? { fetchFn: opts.fetchFn } : {}),
      log: opts.log,
    });
    const detail =
      run.status === "completed"
        ? `${run.rebuilt_records ?? 0} vector records rebuilt from ${run.scanned_records ?? 0} sources` +
          (run.failed_records ? ` — ${run.failed_records} FAILED (run it again)` : "")
        : (run.detail ?? run.status);
    results.push({ user, status: run.status, detail });
    clean.push(run.status === "completed" && !run.failed_records);
  }
  return { ok: clean.every(Boolean), results };
}
