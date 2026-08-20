// Companion memory-edit requests (§6 — the narrow rule-8 amendment).
//
// The companion holds no VM credentials; when it wants a memory edit it drops
// `<alerts_dir>/memedit/<name>.json` (its /alerts mount, a subdirectory the
// alert consumer ignores). The TUI — the process that already owns ssh —
// validates the request against a strict schema and applies it through the
// SAME MemoryStore the keyboard verbs use, then writes
// `<name>.result.json` and moves the request to `.done/`. The TUI is the
// executor; the companion never reaches the VM itself.
import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { MemoryOp, MemoryStore } from "../memory/store.js";

export interface ProcessedRequest {
  file: string;
  ok: boolean;
  message: string;
}

const TS_RE = /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/;
const ID_RE = /^[\w.:-]{1,64}$/;
const HASH_RE = /^[0-9a-f]{12}$/;

/** Strict parse: unknown ops, malformed addresses, oversized text → refusal
 * (recorded in the result file), never a pass-through. */
export function parseMemRequest(text: string): { ok: true; op: MemoryOp } | { ok: false; error: string } {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    return { ok: false, error: "not JSON" };
  }
  if (typeof raw !== "object" || raw === null) return { ok: false, error: "not an object" };
  const r = raw as Record<string, unknown>;
  const op = r["op"];
  if (op === "add") {
    if (typeof r["text"] !== "string" || r["text"].trim().length === 0) return { ok: false, error: "add needs text" };
    if (r["text"].length > 4000) return { ok: false, error: "text too long" };
    return { ok: true, op: { op: "add", text: r["text"].trim() } };
  }
  if (op === "retire" || op === "pin" || op === "unpin" || op === "edit") {
    if (typeof r["id"] !== "string" || !ID_RE.test(r["id"])) return { ok: false, error: "bad id" };
    if (typeof r["ts"] !== "string" || !TS_RE.test(r["ts"])) return { ok: false, error: "bad ts" };
    if (typeof r["block"] !== "number" || !Number.isInteger(r["block"]) || r["block"] < 0) return { ok: false, error: "bad block" };
    if (typeof r["expect"] !== "string" || !HASH_RE.test(r["expect"])) return { ok: false, error: "bad expect hash" };
    const addr = { id: r["id"], ts: r["ts"], block: r["block"], expect: r["expect"] };
    if (op === "edit") {
      if (typeof r["text"] !== "string" || r["text"].trim().length === 0) return { ok: false, error: "edit needs text" };
      if (r["text"].length > 4000) return { ok: false, error: "text too long" };
      return { ok: true, op: { op: "edit", ...addr, text: r["text"].trim() } };
    }
    return { ok: true, op: { op, ...addr } };
  }
  return { ok: false, error: `unknown op '${String(op)}'` };
}

/** Result files older than this are swept; `.done/` keeps the newest N. */
const RESULT_TTL_MS = 24 * 3600 * 1000;
const DONE_KEEP = 200;

/** One sweep of the request dir. Serialized by the caller's poll cadence.
 * A request is archived to `.done/` BEFORE it is applied: a crash between
 * apply and archive would otherwise re-apply it next sweep (an `add` would
 * duplicate; addressed ops are only saved by their expect hash). A crash
 * after archive but before apply loses one request — the companion re-reads
 * the missing result and re-requests, which is the safer failure. */
export async function processMemRequests(dir: string, store: MemoryStore): Promise<ProcessedRequest[]> {
  const out: ProcessedRequest[] = [];
  if (!existsSync(dir)) return out;
  const files = readdirSync(dir)
    .filter((f) => f.endsWith(".json") && !f.endsWith(".result.json"))
    .sort();
  const doneDir = join(dir, ".done");
  if (files.length > 0) mkdirSync(doneDir, { recursive: true });
  for (const file of files) {
    const text = readFileSync(join(dir, file), "utf8");
    renameSync(join(dir, file), join(doneDir, file));
    let ok = false;
    let message: string;
    const parsed = parseMemRequest(text);
    if (!parsed.ok) {
      message = `refused: ${parsed.error}`;
    } else {
      const res = await store.apply(parsed.op);
      ok = res.ok;
      message = res.message;
    }
    writeFileSync(join(dir, `${file.replace(/\.json$/, "")}.result.json`), JSON.stringify({ ok, message, file }, null, 2) + "\n");
    out.push({ file, ok, message });
  }
  cleanup(dir, doneDir);
  return out;
}

/** Bounded housekeeping: results past their TTL, `.done/` past its cap. */
function cleanup(dir: string, doneDir: string): void {
  try {
    const now = Date.now();
    for (const f of readdirSync(dir)) {
      if (!f.endsWith(".result.json")) continue;
      if (now - statSync(join(dir, f)).mtimeMs > RESULT_TTL_MS) rmSync(join(dir, f), { force: true });
    }
    if (!existsSync(doneDir)) return;
    const done = readdirSync(doneDir).sort(); // iso-ts names: oldest first
    for (const f of done.slice(0, Math.max(0, done.length - DONE_KEEP))) rmSync(join(doneDir, f), { force: true });
  } catch {
    /* housekeeping is best-effort */
  }
}
