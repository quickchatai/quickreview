// Narrow cross-process ledger for inject-bridge.
//
// The daemon creates session_commands rows through StateStore. Pi runs in a
// different process, so the bridge claims/acks those rows directly through
// SQLite WAL. Every transition is one guarded UPDATE; owner_token prevents an
// extension instance that survived recovery from terminalizing a newer
// attempt. This module never creates schema and never reads any daemon table
// other than session_commands.
import Database from "better-sqlite3";
import { createHash, randomUUID } from "node:crypto";
import { mkdirSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

const DEFAULT_START_LEASE_MS = 2 * 60_000;
const DEFAULT_RUNNING_LEASE_MS = 45 * 60_000;

export interface SessionCommandLedgerLeases {
  startMs?: number;
  runningMs?: number;
}

interface CommandRow {
  id: string;
  pr: number;
  session: string;
  kind: string;
  payload_sha256: string;
  payload_path: string;
  inject_path: string;
  status: "pending" | "running" | "acked" | "failed" | "cancelled";
  owner_token: string | null;
  attempt: number;
  started_at: string | null;
}

export type CommandLink =
  | { ok: true; command: CommandRow }
  | { ok: false; reason: string };

function sha256(payload: Buffer): string {
  return createHash("sha256").update(payload).digest("hex");
}

function atomicWrite(path: string, payload: Buffer): void {
  mkdirSync(dirname(path), { recursive: true });
  const tmp = `${path}.tmp-${process.pid}-${randomUUID()}`;
  writeFileSync(tmp, payload);
  renameSync(tmp, path);
}

export class SessionCommandLedger {
  readonly ownerToken = randomUUID();
  private readonly db: Database.Database;

  constructor(
    path: string,
    private readonly root: string,
    private readonly session: string,
    private readonly now: () => Date = () => new Date(),
    private readonly leases: SessionCommandLedgerLeases = {},
  ) {
    this.db = new Database(path, { fileMustExist: true });
    this.db.pragma("busy_timeout = 2000");
  }

  close(): void {
    this.db.close();
  }

  /** Resolve a daemon-created command or conservatively adopt one legacy
   * pending file. Adoption is pending evidence only — never an ack. */
  linkOrAdopt(injectPath: string, payload: Buffer): CommandLink {
    try {
      return this.linkOrAdoptUnsafe(injectPath, payload);
    } catch (error) {
      return { ok: false, reason: `command ledger unavailable: ${String(error)}` };
    }
  }

  private linkOrAdoptUnsafe(injectPath: string, payload: Buffer): CommandLink {
    let row = this.byInjectPath(injectPath);
    const hash = sha256(payload);
    if (!row) {
      const prMatch = /^pr-(\d+)$/.exec(this.session);
      if (!prMatch) return { ok: false, reason: "non-PR session has no durable command slot" };
      const active = this.active();
      if (active) return { ok: false, reason: `session command ${active.id} is already ${active.status}` };
      const id = `legacy-${createHash("sha256").update(`${this.session}\0${injectPath}\0${hash}`).digest("hex").slice(0, 32)}`;
      const payloadPath = join(this.root, "state", "session-commands", `${id}.md`);
      try {
        atomicWrite(payloadPath, payload);
        const ts = this.now().toISOString();
        this.db.prepare(
          `INSERT INTO session_commands
             (id, pr, session, kind, round_no, payload_sha256, payload_path, inject_path,
              status, owner_token, attempt, created_at, updated_at, next_check_at)
           VALUES (?, ?, ?, 'legacy', NULL, ?, ?, ?, 'pending', NULL, 0, ?, ?, ?)`,
        ).run(
          id,
          Number(prMatch[1]),
          this.session,
          hash,
          payloadPath,
          injectPath,
          ts,
          ts,
          new Date(this.now().getTime() + this.startLeaseMs()).toISOString(),
        );
      } catch (error) {
        row = this.byInjectPath(injectPath);
        if (!row) return { ok: false, reason: `legacy adoption failed: ${String(error)}` };
      }
      row = this.byInjectPath(injectPath);
    }
    if (!row) return { ok: false, reason: "command row absent after adoption" };
    if (row.session !== this.session) return { ok: false, reason: `command belongs to ${row.session}` };
    if (row.payload_sha256 !== hash) {
      this.failPending(row.id, `payload hash mismatch: ${hash} != ${row.payload_sha256}`);
      return { ok: false, reason: "payload hash mismatch" };
    }
    if (row.status !== "pending") {
      return { ok: false, reason: `command ${row.id} is already ${row.status}` };
    }
    return { ok: true, command: row };
  }

  /** Reserve ownership BEFORE the fire-and-forget send. This closes the
   * accepted-before-claim crash window: a restarted bridge sees `running` and
   * must recover evidence, never blindly submit again. `started_at` remains
   * null until the correlated Pi message proves acceptance. */
  reserve(id: string): boolean {
    return this.totalUpdate(() => {
      const ts = this.now().toISOString();
      const next = new Date(this.now().getTime() + this.startLeaseMs()).toISOString();
      const changed = this.db.prepare(
        `UPDATE session_commands
            SET status='running', owner_token=?, attempt=attempt+1,
                started_at=NULL, updated_at=?, next_check_at=?
          WHERE id=? AND status='pending'`,
      ).run(this.ownerToken, ts, next, id).changes;
      if (changed === 1) return true;
      const row = this.byId(id);
      return row?.status === "running" && row.owner_token === this.ownerToken && row.started_at == null;
    });
  }

  markAccepted(id: string): boolean {
    return this.totalUpdate(() => {
      const ts = this.now().toISOString();
      const next = new Date(this.now().getTime() + this.runningLeaseMs()).toISOString();
      return this.db.prepare(
        `UPDATE session_commands
            SET started_at=COALESCE(started_at, ?), updated_at=?, next_check_at=?
          WHERE id=? AND status='running' AND owner_token=?`,
      ).run(ts, ts, next, id, this.ownerToken).changes === 1;
    });
  }

  /** A synchronous adapter throw occurred before acceptance. Return the same
   * command to pending under the same id/bytes; async failures cannot use this
   * path because Pi hides them. */
  releasePending(id: string): boolean {
    return this.totalUpdate(() => {
      const ts = this.now().toISOString();
      const next = new Date(this.now().getTime() + this.startLeaseMs()).toISOString();
      return this.db.prepare(
        `UPDATE session_commands
            SET status='pending', owner_token=NULL, updated_at=?, next_check_at=?
          WHERE id=? AND status='running' AND owner_token=? AND started_at IS NULL`,
      ).run(ts, next, id, this.ownerToken).changes === 1;
    });
  }

  ack(id: string): boolean {
    return this.totalUpdate(() => {
      const ts = this.now().toISOString();
      return this.db.prepare(
        `UPDATE session_commands
            SET status='acked', settled_at=?, updated_at=?, next_check_at=?, failure=NULL
          WHERE id=? AND status='running' AND owner_token=? AND started_at IS NOT NULL`,
      ).run(ts, ts, ts, id, this.ownerToken).changes === 1;
    });
  }

  failPending(id: string, failure: string): boolean {
    return this.totalUpdate(() => {
      const ts = this.now().toISOString();
      return this.db.prepare(
        `UPDATE session_commands
            SET status='failed', failed_at=?, failure=?, updated_at=?, next_check_at=?
          WHERE id=? AND status='pending'`,
      ).run(ts, failure, ts, ts, id).changes === 1;
    });
  }

  private startLeaseMs(): number {
    return this.leases.startMs && this.leases.startMs > 0 ? this.leases.startMs : DEFAULT_START_LEASE_MS;
  }

  private runningLeaseMs(): number {
    return this.leases.runningMs && this.leases.runningMs > 0 ? this.leases.runningMs : DEFAULT_RUNNING_LEASE_MS;
  }

  private totalUpdate(fn: () => boolean): boolean {
    try {
      return fn();
    } catch {
      return false;
    }
  }

  private byId(id: string): CommandRow | undefined {
    return this.db.prepare("SELECT * FROM session_commands WHERE id = ?").get(id) as CommandRow | undefined;
  }

  private byInjectPath(path: string): CommandRow | undefined {
    return this.db.prepare("SELECT * FROM session_commands WHERE inject_path = ?").get(path) as CommandRow | undefined;
  }

  private active(): CommandRow | undefined {
    return this.db
      .prepare("SELECT * FROM session_commands WHERE session = ? AND status != 'acked' ORDER BY created_at DESC LIMIT 1")
      .get(this.session) as CommandRow | undefined;
  }
}
