// GENERATED FROM examples/memory-plugin-shared/lib. DO NOT EDIT.
/**
 * Local pending queue for offline resilience.
 *
 * When the OpenViking server is temporarily unreachable, write operations
 * (addMessage, commitSession) serialize their payloads to
 * `~/.openviking/pending/` as JSON files. On the next session-start, the
 * queue is replayed in small batches. This is a session-start-triggered retry
 * path with maxRetries/TTL, not a long-running background worker.
 *
 * Each file contains: { type, sessionId, payload, createdAt, retries, dedupKey }
 *
 * [QCR PATCH 12] This module reads no environment and no home directory. The
 * caller hands every function the queue's settings as its last argument:
 *   { dir, maxRetries?, ttlDays?, replayLimit? }
 * `dir` is the queue directory; without one the queue is off (enqueue fails,
 * the rest find nothing). The shim in qcr-shim.ts turns
 * pending-queue variables and the `~/.openviking/pending` default into that object, so the same code serves a
 * tmux pi (env) and an SDK session (a value).
 *   maxRetries   max retry attempts per item (default: 3)
 *   ttlDays      max age in days before stale cleanup (default: 7)
 *   replayLimit  max items replayed per session-start (default: 50)
 */

import { mkdir, readdir, readFile, rename, writeFile, unlink, stat, chmod } from "node:fs/promises";
import { createHash } from "node:crypto";
import { join } from "node:path";
import { isRetryableFailure } from "./retryable.mjs";

const DEFAULT_MAX_RETRIES = 3;
const DEFAULT_TTL_DAYS = 7;
const DEFAULT_REPLAY_LIMIT = 50;
const PROCESSING_STALE_MS = 10 * 60 * 1000;

// Pending queue files may contain raw memory payload / transcript content.
// Use restrictive permissions explicitly so we don't depend on umask.
//   - dir: 0o700  (owner: rwx; group/other: none)
//   - file: 0o600 (owner: rw;  group/other: none)
const PENDING_DIR_MODE = 0o700;
const PENDING_FILE_MODE = 0o600;

/**
 * Ensure the pending directory exists with 0o700 permissions. If the
 * directory was created by a previous version of this code (or by hand)
 * with looser permissions, best-effort chmod it on first use.
 */
async function ensurePendingDir(dir) {
  await mkdir(dir, { recursive: true, mode: PENDING_DIR_MODE });
  try {
    await chmod(dir, PENDING_DIR_MODE);
  } catch {
    // Best effort: chmod may fail on some platforms (e.g. Windows); not fatal.
  }
}

function getPendingDir(queue) {
  return typeof queue?.dir === "string" ? queue.dir : "";
}

function getMaxRetries(queue) {
  const v = queue?.maxRetries;
  return typeof v === "number" && Number.isFinite(v) && v >= 0 ? v : DEFAULT_MAX_RETRIES;
}

function getTTLDays(queue) {
  const v = queue?.ttlDays;
  return typeof v === "number" && Number.isFinite(v) && v >= 0 ? v : DEFAULT_TTL_DAYS;
}

function getReplayLimit(queue) {
  const v = queue?.replayLimit;
  return typeof v === "number" && Number.isFinite(v) && v > 0 ? v : DEFAULT_REPLAY_LIMIT;
}

function stableStringify(value) {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(",")}]`;
  const keys = Object.keys(value).sort();
  return `{${keys.map((k) => `${JSON.stringify(k)}:${stableStringify(value[k])}`).join(",")}}`;
}

function makeDedupKey(type, sessionId, payload) {
  return createHash("sha256")
    .update(type)
    .update("\n")
    .update(sessionId)
    .update("\n")
    .update(stableStringify(payload))
    .digest("hex");
}

function pendingFilename(dedupKey, retries = 0) {
  return `${dedupKey}_${Math.max(0, Number(retries) || 0)}.json`;
}

function retryFilename(filename, retries) {
  const bare = filename.replace(/\.(json|processing)$/, "");
  const nextBare = /_\d+$/.test(bare)
    ? bare.replace(/_\d+$/, `_${retries}`)
    : `${bare}_${retries}`;
  return `${nextBare}.json`;
}

function processingFilename(filename) {
  return filename.replace(/\.json$/, ".processing");
}

function pendingFromProcessingFilename(filename) {
  return filename.replace(/\.processing$/, ".json");
}

function isRetryableReplayFailure(res) {
  return isRetryableFailure(res);
}

async function readEntry(dir, filename) {
  const raw = await readFile(join(dir, filename), "utf-8");
  return JSON.parse(raw);
}

async function findExistingByDedupKey(dir, dedupKey) {
  let files;
  try {
    files = await readdir(dir);
  } catch {
    return null;
  }

  // Fast path: filenames are `${dedupKey}_${retries}.json` (or
  // .processing). `dedupKey` is a sha256 hex produced by makeDedupKey
  // (no underscores), so `${dedupKey}_` is a unique prefix per key.
  // Filter on prefix BEFORE opening the file to avoid readFile +
  // JSON.parse on every entry in the directory on every enqueue call —
  // the previous implementation was O(n²) in queue size. Worst case here
  // is O(n) readdir entries, but only the (typically single) prefix
  // match actually gets opened and parsed.
  const prefix = `${dedupKey}_`;

  for (const f of files) {
    if (!f.startsWith(prefix)) continue;
    if (!f.endsWith(".json") && !f.endsWith(".processing")) continue;
    try {
      const entry = await readEntry(dir, f);
      if (entry?.dedupKey === dedupKey) return { filename: f, entry };
    } catch {
      // Corrupted file - ignore for dedup lookup.
    }
  }
  return null;
}

async function recoverStaleProcessing(dir) {
  let files;
  try {
    files = await readdir(dir);
  } catch {
    return 0;
  }

  const now = Date.now();
  let recovered = 0;
  for (const f of files) {
    if (!f.endsWith(".processing")) continue;
    const from = join(dir, f);
    try {
      const s = await stat(from);
      if (now - s.mtimeMs < PROCESSING_STALE_MS) continue;
      const to = join(dir, pendingFromProcessingFilename(f));
      await rename(from, to);
      recovered++;
    } catch {
      // Best effort. A concurrent process may have already handled it.
    }
  }
  return recovered;
}

/**
 * Enqueue a failed operation to local disk.
 *
 * @param {string} type - "addMessage" or "commitSession"
 * @param {string} sessionId - OV session ID
 * @param {object} payload - the data that failed to send
 * @param {object} options
 * @param {number} options.createdAt - optional queue timestamp override
 * @param {object} options.queue - the queue settings ({ dir, ... })
 */
export async function enqueue(type, sessionId, payload, options = {}) {
  const dir = getPendingDir(options.queue);
  if (!dir) return { ok: false, error: "no pending queue directory configured" };
  const now = Number.isFinite(options.createdAt) ? options.createdAt : Date.now();
  const dedupKey = makeDedupKey(type, sessionId, payload);
  const filename = pendingFilename(dedupKey, 0);
  const entry = {
    type,
    sessionId,
    payload,
    createdAt: now,
    retries: 0,
    dedupKey,
  };

  try {
    await ensurePendingDir(dir);
  } catch (err) {
    return { ok: false, error: err?.message || String(err), dedupKey };
  }

  const existing = await findExistingByDedupKey(dir, dedupKey);
  if (existing) {
    return { ok: true, path: existing.filename, deduped: true, dedupKey };
  }

  try {
    await writeFile(join(dir, filename), JSON.stringify(entry), {
      encoding: "utf-8",
      flag: "wx",
      mode: PENDING_FILE_MODE,
    });
    return { ok: true, path: filename, dedupKey };
  } catch (err) {
    if (err?.code !== "EEXIST") {
      return { ok: false, error: err?.message || String(err), dedupKey };
    }
  }

  const duplicate = await findExistingByDedupKey(dir, dedupKey);
  if (duplicate) {
    return { ok: true, path: duplicate.filename, deduped: true, dedupKey };
  }
  return { ok: false, error: `pending file exists but dedup entry was not readable: ${filename}`, dedupKey };
}

/**
 * List all pending queue entries.
 * Returns array of { filename, entry } sorted by createdAt ascending.
 */
export async function listPending(queue) {
  const dir = getPendingDir(queue);
  if (!dir) return [];
  let files;
  try {
    await recoverStaleProcessing(dir);
    files = await readdir(dir);
  } catch {
    return [];
  }

  const entries = [];
  for (const f of files) {
    if (!f.endsWith(".json")) continue;
    try {
      const entry = await readEntry(dir, f);
      entries.push({ filename: f, entry });
    } catch {
      // Corrupted file - skip.
    }
  }

  entries.sort((a, b) => (a.entry.createdAt || 0) - (b.entry.createdAt || 0));
  return entries;
}

/**
 * Atomically claim a pending file for replay. Only the process that successfully
 * renames the file may send the HTTP replay.
 */
export async function claimForReplay(filename, queue) {
  if (!filename.endsWith(".json")) return null;
  const dir = getPendingDir(queue);
  if (!dir) return null;
  const claimed = processingFilename(filename);
  try {
    await rename(join(dir, filename), join(dir, claimed));
    return claimed;
  } catch {
    return null;
  }
}

/**
 * Remove a pending entry after successful replay.
 */
export async function dequeue(filename, queue) {
  const dir = getPendingDir(queue);
  if (!dir) return false;
  try {
    await unlink(join(dir, filename));
    return true;
  } catch {
    return false;
  }
}

/**
 * Increment retry count on a pending entry. Returns false if max retries exceeded.
 */
export async function incrementRetry(filename, entry, queue) {
  const dir = getPendingDir(queue);
  if (!dir) return false;
  const maxRetries = getMaxRetries(queue);
  entry.retries = (entry.retries || 0) + 1;

  if (entry.retries > maxRetries) {
    try {
      await unlink(join(dir, filename));
    } catch {
      // Best effort.
    }
    return false;
  }

  const newFilename = retryFilename(filename, entry.retries);
  // Atomic write: write to a unique temp file in the same directory, then
  // rename into place. Avoids leaving a half-written JSON if the process
  // crashes mid-write.
  const tmpFilename = `${newFilename}.tmp.${process.pid}.${Date.now()}`;
  try {
    await writeFile(join(dir, tmpFilename), JSON.stringify(entry), {
      encoding: "utf-8",
      flag: "wx",
      mode: PENDING_FILE_MODE,
    });
    await rename(join(dir, tmpFilename), join(dir, newFilename));
    await unlink(join(dir, filename)).catch(() => {});
    return true;
  } catch {
    await unlink(join(dir, tmpFilename)).catch(() => {});
    return false;
  }
}

/**
 * Clean up stale entries older than TTL.
 */
export async function cleanStale(queue) {
  const ttlMs = getTTLDays(queue) * 24 * 60 * 60 * 1000;
  const now = Date.now();
  const pending = await listPending(queue);
  let cleaned = 0;

  for (const { filename, entry } of pending) {
    const age = now - (entry.createdAt || 0);
    if (age > ttlMs) {
      await dequeue(filename, queue);
      cleaned++;
    }
  }
  return cleaned;
}

/**
 * Replay pending entries. Call this during session-start when the server is
 * healthy. Each run processes at most the queue's replayLimit items so
 * a just-recovered server is not hit with an unbounded replay burst.
 *
 * @param {Function} fetchJSON - the configured fetchJSON from makeFetchJSON
 * @param {Function} log - logger function
 * @param {object} queue - the queue settings ({ dir, ... })
 * @returns {{ replayed: number, failed: number, skipped: number, deferred: number }}
 */
export async function replayPending(fetchJSON, log, queue) {
  const pending = await listPending(queue);

  if (pending.length === 0) {
    return { replayed: 0, failed: 0, skipped: 0, deferred: 0 };
  }

  const replayLimit = getReplayLimit(queue);
  log("pending-queue", { count: pending.length, replayLimit, action: "replay-start" });

  let replayed = 0;
  let failed = 0;
  let skipped = 0;
  let deferred = 0;
  let processed = 0;

  for (const { filename, entry } of pending) {
    if (processed >= replayLimit) {
      deferred++;
      continue;
    }

    if ((entry.retries || 0) >= getMaxRetries(queue)) {
      await dequeue(filename, queue);
      skipped++;
      continue;
    }

    const claimedFilename = await claimForReplay(filename, queue);
    if (!claimedFilename) {
      skipped++;
      continue;
    }
    processed++;

    let res;
    try {
      const encodedSid = encodeURIComponent(entry.sessionId);
      if (entry.type === "addMessage") {
        res = await fetchJSON(`/api/v1/sessions/${encodedSid}/messages`, {
          method: "POST",
          body: JSON.stringify(entry.payload),
        });
      } else if (entry.type === "commitSession") {
        res = await fetchJSON(`/api/v1/sessions/${encodedSid}/commit`, {
          method: "POST",
          body: JSON.stringify(entry.payload || {}),
        });
      } else {
        await dequeue(claimedFilename, queue);
        skipped++;
        continue;
      }
    } catch {
      res = { ok: false };
    }

    if (entry.type === "commitSession") {
      log("pending-queue", {
        action: "commit-replay",
        sessionId: entry.sessionId,
        ok: Boolean(res?.ok),
        status: res?.result?.status || res?.status,
        trace_id: res?.traceId || res?.result?.trace_id,
        error: res?.ok ? undefined : res?.error?.message || res?.error?.code,
      });
    }

    if (res?.ok) {
      await dequeue(claimedFilename, queue);
      replayed++;
    } else if (!isRetryableReplayFailure(res)) {
      await dequeue(claimedFilename, queue);
      skipped++;
    } else {
      await incrementRetry(claimedFilename, entry, queue);
      failed++;
      if (entry.type === "addMessage") {
        deferred += Math.max(0, pending.length - processed);
        break;
      }
    }
  }

  const cleaned = await cleanStale(queue);

  log("pending-queue", {
    action: "replay-done",
    replayed,
    failed,
    skipped,
    deferred,
    cleaned,
  });

  return { replayed, failed, skipped, deferred };
}
