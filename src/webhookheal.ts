// Webhook URL self-heal. A tunnel sidecar writes its assigned bare public
// hostname to a file on a shared volume; this watcher notices a change,
// debounces it, and re-points the GitHub App's own webhook URL through the one
// MutationGate — the `update_own_webhook_url` kind in the app-self-config
// class, which executes even in dry-run (CLAUDE.md rule 1) because new users
// run dry-run during exactly the window the self-heal matters.
//
// Shape mirrors the verdict watcher: fs.watch is the fast path only, the
// periodic sweep is the reliable one. Every failure surfaces as a log event +
// anomaly, never a crash, never silence — and GitHub does not auto-retry
// failed deliveries, so this narrows the gap; the reconcile poll carries
// correctness.
import { existsSync, mkdirSync, readFileSync, watch, type FSWatcher } from "node:fs";
import { basename, dirname } from "node:path";
import type { GateResult } from "./gate.js";

/** A bare DNS hostname — no scheme, no path, no port. The sidecar's contract
 * is exactly this (plus tolerated surrounding whitespace/newline). */
const HOSTNAME_RE = /^[a-z0-9]([a-z0-9-]{0,62})?(\.[a-z0-9]([a-z0-9-]{0,62})?)+$/i;

export interface WebhookHealDeps {
  /** The file the tunnel sidecar writes the bare public hostname into. */
  hostnameFile: string;
  /** The webhook route appended to `https://<hostname>`. */
  webhookPath?: string;
  /** `GET /app/hook/config` — the direct JWT read (adapter). */
  readConfig(): Promise<{ url: string }>;
  /** The gated `PATCH /app/hook/config` (adapter.updateOwnWebhookUrl). */
  updateUrl(newUrl: string, oldUrl: string): Promise<GateResult>;
  /** Ledger line (store.logEvent under a webhook_heal_* kind). */
  logEvent(kind: string, payload: unknown): void;
  /** Overseer anomaly surface — a failure here is never silent. */
  anomaly(detail: string): void;
  log(msg: string, extra?: unknown): void;
  /** Settle time after a file-change event before the sweep runs. */
  debounceMs?: number;
  /** The reliable path's cadence. 0 ⇒ no timer (tests drive sweep()). */
  sweepIntervalMs?: number;
  /** Parse retries for partially-written hostname files (verdicts.ts shape). */
  parseRetries?: number;
  retryDelayMs?: number;
}

export type HealOutcome =
  | "noop" // hostname matches the App's webhook URL already
  | "healed" // re-pointed and read-back verified
  | "missing" // hostname file absent — sidecar not up yet; logged once
  | "invalid" // file content never settled into a hostname
  | "failed"; // read, PATCH, or read-back verification failed

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

export class WebhookHealer {
  private watcher: FSWatcher | null = null;
  private sweepTimer: ReturnType<typeof setInterval> | null = null;
  private debounceTimer: ReturnType<typeof setTimeout> | null = null;
  private inFlight = false;
  /** One queued re-run when an event lands mid-sweep — never a pile-up. */
  private rerun = false;
  /** "log once" latches: reset when the condition clears. */
  private missingLogged = false;
  private lastInvalidContent: string | null = null;

  constructor(private readonly deps: WebhookHealDeps) {}

  private log(msg: string, extra?: unknown): void {
    this.deps.log(msg, extra);
  }

  private webhookPath(): string {
    return this.deps.webhookPath ?? "/webhook";
  }

  /** fs.watch fast path + periodic sweep (the reliable one). A watch that
   * cannot be established is logged and the sweep carries on alone. */
  start(): void {
    try {
      mkdirSync(dirname(this.deps.hostnameFile), { recursive: true });
      this.watcher = watch(dirname(this.deps.hostnameFile), (_event, filename) => {
        if (filename && String(filename) !== basename(this.deps.hostnameFile)) return;
        this.scheduleSweep();
      });
      this.watcher.on("error", (err) => {
        // The sweep interval below is the fallback — degraded, never blind.
        this.log("webhookheal: fs.watch failed — polling sweep continues alone", err);
        this.watcher?.close();
        this.watcher = null;
      });
    } catch (err) {
      this.log("webhookheal: could not watch hostname file — polling sweep continues alone", err);
      this.watcher = null;
    }
    const intervalMs = this.deps.sweepIntervalMs ?? 300_000;
    if (intervalMs > 0) {
      this.sweepTimer = setInterval(() => {
        void this.sweep().catch((err) => this.log("webhookheal: sweep failed", err));
      }, intervalMs);
      this.sweepTimer.unref?.();
    }
    // Startup sweep: the hostname may have rotated while the daemon was down.
    void this.sweep().catch((err) => this.log("webhookheal: startup sweep failed", err));
  }

  stop(): void {
    this.watcher?.close();
    this.watcher = null;
    if (this.sweepTimer) clearInterval(this.sweepTimer);
    this.sweepTimer = null;
    if (this.debounceTimer) clearTimeout(this.debounceTimer);
    this.debounceTimer = null;
  }

  /** Debounced trigger for file-change events — quick tunnels write, then
   * sometimes rewrite, within a second or two of coming up. */
  private scheduleSweep(): void {
    if (this.debounceTimer) clearTimeout(this.debounceTimer);
    this.debounceTimer = setTimeout(() => {
      this.debounceTimer = null;
      void this.sweep().catch((err) => this.log("webhookheal: sweep failed", err));
    }, this.deps.debounceMs ?? 3000);
    this.debounceTimer.unref?.();
  }

  /** Read the hostname file, retrying a partial write into shape (the
   * verdicts.ts pattern). Whitespace/newline around the hostname is the
   * sidecar's prerogative and is stripped. */
  private async readHostname(): Promise<
    { ok: true; hostname: string } | { ok: false; outcome: "missing" | "invalid" }
  > {
    const retries = this.deps.parseRetries ?? 3;
    const delay = this.deps.retryDelayMs ?? 40;
    let content: string | null = null;
    for (let attempt = 0; attempt <= retries; attempt++) {
      if (!existsSync(this.deps.hostnameFile)) {
        if (!this.missingLogged) {
          this.missingLogged = true;
          this.log(
            `webhookheal: hostname file ${this.deps.hostnameFile} absent — tunnel not up yet (logged once)`,
          );
        }
        return { ok: false, outcome: "missing" };
      }
      try {
        content = readFileSync(this.deps.hostnameFile, "utf8");
      } catch {
        content = null; // vanished between the existence check and the read
      }
      const hostname = content?.trim() ?? "";
      if (hostname && HOSTNAME_RE.test(hostname)) {
        this.missingLogged = false;
        this.lastInvalidContent = null;
        return { ok: true, hostname: hostname.toLowerCase() };
      }
      if (attempt < retries) await sleep(delay);
    }
    this.missingLogged = false;
    // Loud once per distinct bad content — a sidecar stuck writing garbage
    // must not fill the anomaly table on every sweep.
    const bad = (content ?? "").slice(0, 200);
    if (this.lastInvalidContent !== bad) {
      this.lastInvalidContent = bad;
      const detail = `webhook self-heal: hostname file ${this.deps.hostnameFile} never parsed as a bare hostname (content: ${JSON.stringify(bad)})`;
      this.deps.logEvent("webhook_heal_invalid_hostname", {
        file: this.deps.hostnameFile,
        content: bad,
      });
      this.deps.anomaly(detail);
      this.log(`webhookheal: ${detail}`);
    }
    return { ok: false, outcome: "invalid" };
  }

  /**
   * The whole heal, one pass: read the hostname, compare with the App's
   * webhook config, PATCH when different, read back to verify. Total — every
   * failure is an outcome, never a throw.
   */
  async sweep(): Promise<HealOutcome> {
    if (this.inFlight) {
      this.rerun = true;
      return "noop";
    }
    this.inFlight = true;
    try {
      return await this.heal();
    } finally {
      this.inFlight = false;
      if (this.rerun) {
        this.rerun = false;
        this.scheduleSweep();
      }
    }
  }

  private async heal(): Promise<HealOutcome> {
    const read = await this.readHostname();
    if (!read.ok) return read.outcome;
    const desired = `https://${read.hostname}${this.webhookPath()}`;

    let current: string;
    try {
      current = (await this.deps.readConfig()).url;
    } catch (err) {
      const detail = `webhook self-heal: GET /app/hook/config failed — cannot compare against ${desired} (${String(err).slice(0, 200)})`;
      this.deps.logEvent("webhook_heal_read_failed", { desired, error: String(err).slice(0, 300) });
      this.deps.anomaly(detail);
      this.log(`webhookheal: ${detail}`);
      return "failed";
    }
    if (current === desired) return "noop";

    try {
      await this.deps.updateUrl(desired, current);
    } catch (err) {
      const detail = `webhook self-heal: PATCH /app/hook/config ${current || "(unset)"} → ${desired} failed (${String(err).slice(0, 200)})`;
      this.deps.logEvent("webhook_heal_patch_failed", {
        old_url: current,
        new_url: desired,
        error: String(err).slice(0, 300),
      });
      this.deps.anomaly(detail);
      this.log(`webhookheal: ${detail}`);
      return "failed";
    }

    // Read-back verification: the PATCH's 200 is not the proof, the config is.
    let after: string;
    try {
      after = (await this.deps.readConfig()).url;
    } catch (err) {
      after = `(unreadable: ${String(err).slice(0, 120)})`;
    }
    if (after !== desired) {
      const detail = `webhook self-heal: re-point did not stick — PATCHed ${desired} but read back ${after}`;
      this.deps.logEvent("webhook_heal_verify_failed", {
        old_url: current,
        new_url: desired,
        read_back: after,
      });
      this.deps.anomaly(detail);
      this.log(`webhookheal: ${detail}`);
      return "failed";
    }
    this.deps.logEvent("webhook_url_repointed", { old_url: current, new_url: desired });
    this.log(
      `webhookheal: re-pointed App webhook URL ${current || "(unset)"} → ${desired} (read-back verified)`,
    );
    return "healed";
  }
}
