#!/usr/bin/env node
// memedit — the ONE mutation path into pi-memory's MEMORY.md from outside a
// pi session (TUI management verbs + TUI-mediated companion edit
// requests both land here). Design contract:
//
//   * Serialized: a lock directory beside the file (mkdir is atomic) with a
//     5s bounded wait — concurrent pi-memory writes are file appends from the
//     extension; the lock only serializes OUR read-modify-write against a
//     second memedit.
//   * Optimistic: every addressed op carries --expect <sha1-12 of the block's
//     exact text>. The block is re-hashed at apply time; a mismatch (the
//     overseer rewrote memory between the TUI's read and the keystroke)
//     REFUSES the op — stale views never destroy fresh writes.
//   * Atomic: tmp + rename in the same directory, never in-place.
//
// Ops (payload text on stdin where applicable; every address is
// --id X --ts 'YYYY-MM-DD HH:MM:SS' --block N --expect H):
//   retire     remove the block
//   pin        tag #pinned + move to top of file
//   unpin      drop the #pinned tag (in place)
//   edit       replace block text (stdin)
//   add        append a #manual entry (stdin) — no address
//
// Addressing: batches are `<!-- YYYY-MM-DD HH:MM:SS [id] -->` headers; blocks
// are blank-line-separated paragraphs inside a batch; N is the block's index
// within its batch. The id ALONE is not unique (it is the writing
// session's 8-char prefix, repeated across that session's batches) — the
// (ts, id) pair is the batch key. Keep the parse in step with
// src/tui/memory.ts.
//
// pi-memory itself takes NO lock and rewrites the file in place, so
// beyond our own lock we stat the file before and after the transform and
// retry when its mtime moved — an in-session write between our read and our
// rename loses nothing. After a successful write, `qmd update` runs
// best-effort so external edits reach memory_search (§6).
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, renameSync, rmdirSync, statSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

const MEMORY_PATH = process.env.QCR_MEMORY_PATH ?? "/home/review/.pi/agent/memory/MEMORY.md";
const HEADER_RE = /^<!--\s*(\d{4}-\d{2}-\d{2}) (\d{2}:\d{2}:\d{2})\s*\[([^\]]+)\]\s*-->\s*$/;
const LOCK_WAIT_MS = 5_000;

function die(msg) {
  process.stdout.write(`refused: ${msg}\n`);
  process.exit(1);
}

function hash(text) {
  return createHash("sha1").update(text, "utf8").digest("hex").slice(0, 12);
}

/** Parse into batches: { ts, id, blocks: string[] } preserving order. */
function parse(md) {
  const batches = [];
  let cur;
  let block = [];
  const flush = () => {
    const text = block.join("\n").trim();
    block = [];
    if (cur && text.length > 0) cur.blocks.push(text);
  };
  for (const line of md.split("\n")) {
    const m = HEADER_RE.exec(line);
    if (m) {
      flush();
      cur = { ts: `${m[1]} ${m[2]}`, id: m[3], blocks: [] };
      batches.push(cur);
      continue;
    }
    if (line.trim() === "") {
      flush();
      continue;
    }
    if (!cur) {
      // Preamble before the first header: preserve as an id-less batch.
      cur = { ts: "", id: "", blocks: [] };
      batches.push(cur);
    }
    block.push(line);
  }
  flush();
  return batches;
}

function render(batches) {
  const out = [];
  for (const b of batches) {
    if (b.blocks.length === 0) continue; // an emptied batch drops its header
    if (b.id !== "") out.push(`<!-- ${b.ts} [${b.id}] -->`);
    for (const blk of b.blocks) {
      out.push(blk);
      out.push("");
    }
  }
  while (out.length > 0 && out[out.length - 1] === "") out.pop();
  return out.join("\n") + "\n";
}

function findBlock(batches, id, ts, blockIdx) {
  const batch = batches.find((b) => b.id === id && b.ts === ts);
  if (!batch) die(`no batch [${id}] @ ${ts}`);
  if (blockIdx < 0 || blockIdx >= batch.blocks.length) die(`batch [${id}] @ ${ts} has no block ${blockIdx}`);
  return batch;
}

function readStdin() {
  try {
    return readFileSync(0, "utf8").trim();
  } catch {
    return "";
  }
}

function localStamp(d = new Date()) {
  const p = (n) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
}

function withLock(fn) {
  const lockDir = join(dirname(MEMORY_PATH), ".memedit.lock");
  const deadline = Date.now() + LOCK_WAIT_MS;
  for (;;) {
    try {
      mkdirSync(lockDir);
      break;
    } catch {
      if (Date.now() > deadline) die("lock timeout — another memedit holds .memedit.lock");
      // Sleep 100ms synchronously (no spin): Atomics.wait on a throwaway buffer.
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 100);
    }
  }
  try {
    fn();
  } finally {
    try {
      rmdirSync(lockDir);
    } catch {
      /* already gone */
    }
  }
}

function writeAtomic(content) {
  const tmp = `${MEMORY_PATH}.memedit.tmp`;
  writeFileSync(tmp, content, "utf8");
  renameSync(tmp, MEMORY_PATH);
}

// ---- argv ----
const [op, ...rest] = process.argv.slice(2);
const args = {};
for (let i = 0; i < rest.length; i += 2) {
  if (!rest[i]?.startsWith("--")) die(`bad argument '${rest[i]}'`);
  args[rest[i].slice(2)] = rest[i + 1];
}
const needsAddress = op === "retire" || op === "pin" || op === "unpin" || op === "edit";
if (needsAddress && (!args.id || !args.ts || args.block === undefined || !args.expect)) die(`${op} needs --id --ts --block --expect`);
if (needsAddress && !/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/.test(args.ts)) die("--ts must be 'YYYY-MM-DD HH:MM:SS'");
const blockIdx = needsAddress ? Number(args.block) : 0;
if (needsAddress && !Number.isInteger(blockIdx)) die("--block must be an integer");
const payload = op === "edit" || op === "add" ? readStdin() : "";
if ((op === "edit" || op === "add") && payload.length === 0) die(`${op}: empty text on stdin`);
if (payload.length > 4000) die(`${op}: text too long (${payload.length} > 4000 chars)`);

function mtimeOf() {
  try {
    return statSync(MEMORY_PATH).mtimeMs;
  } catch {
    return -1;
  }
}

function transform(batches) {
  switch (op) {
    case "retire": {
      const batch = findBlock(batches, args.id, args.ts, blockIdx);
      if (hash(batch.blocks[blockIdx]) !== args.expect) die("stale view — memory changed underneath you, refresh and retry");
      batch.blocks.splice(blockIdx, 1);
      break;
    }
    case "pin": {
      const batch = findBlock(batches, args.id, args.ts, blockIdx);
      let text = batch.blocks[blockIdx];
      if (hash(text) !== args.expect) die("stale view — memory changed underneath you, refresh and retry");
      batch.blocks.splice(blockIdx, 1);
      if (!/(^|\s)#pinned(\s|$)/.test(text)) text = `#pinned ${text}`;
      // Top of file = the slice of MEMORY.md that survives pi-memory's
      // injection truncation (first ~75 lines / ~1,991 chars) —
      // pinned entries live there, one batch each, keeping the original
      // stamp and a derived id ((ts, derived id) stays a unique key).
      batches.unshift({ ts: batch.ts, id: `${args.id}.p${blockIdx}`, blocks: [text] });
      break;
    }
    case "unpin": {
      const batch = findBlock(batches, args.id, args.ts, blockIdx);
      const text = batch.blocks[blockIdx];
      if (hash(text) !== args.expect) die("stale view — memory changed underneath you, refresh and retry");
      batch.blocks[blockIdx] = text.replace(/(^|\s)#pinned(?=\s|$)/g, "$1").replace(/^ +/, "").replace(/  +/g, " ");
      break;
    }
    case "edit": {
      const batch = findBlock(batches, args.id, args.ts, blockIdx);
      if (hash(batch.blocks[blockIdx]) !== args.expect) die("stale view — memory changed underneath you, refresh and retry");
      batch.blocks[blockIdx] = payload.replace(/\n{2,}/g, "\n");
      break;
    }
    case "add": {
      const text = /(^|\s)#manual(\s|$)/.test(payload) ? payload : `#manual ${payload}`;
      batches.push({ ts: localStamp(), id: `qcr-${Date.now().toString(36)}`, blocks: [text.replace(/\n{2,}/g, "\n")] });
      break;
    }
    default:
      die(`unknown op '${op ?? ""}' — retire|pin|unpin|edit|add`);
  }
}

withLock(() => {
  // pi-memory holds no lock of its own: re-read and re-apply when the file's
  // mtime moves between our read and our write (three attempts, then refuse).
  for (let attempt = 0; ; attempt++) {
    const before = mtimeOf();
    let md = "";
    try {
      md = readFileSync(MEMORY_PATH, "utf8");
    } catch {
      if (op !== "add") die(`cannot read ${MEMORY_PATH}`);
    }
    const batches = parse(md);
    transform(batches);
    if (mtimeOf() !== before) {
      if (attempt >= 2) die("memory is being rewritten by a live session — try again");
      continue;
    }
    writeAtomic(render(batches));
    break;
  }
  process.stdout.write(`ok: ${op}\n`);
});

// Best-effort: refresh the qmd index so memory_search sees the edit (
// §6 — search reads the index, not the files). Detached; failure is fine.
try {
  spawn("sh", ["-c", "qmd update >/dev/null 2>&1 && qmd embed >/dev/null 2>&1"], { detached: true, stdio: "ignore" }).unref();
} catch {
  /* qmd absent — search catches up at the next session start */
}
