#!/usr/bin/env node
// memedit — the ONE mutation path into pi-memory's MEMORY.md from outside a
// pi session (TUI management verbs + TUI-mediated companion edit
// requests both land here). Design contract:
//
//   * Byte-splicing: the file is NEVER re-rendered from a parse. Ops splice
//     only the addressed block's lines (plus, for pin/add, an inserted
//     header); every other byte — preambles, fenced code, indentation,
//     blank-line runs, HANDOFF sections — copies through verbatim.
//   * Serialized: a lock directory beside the file (mkdir is atomic) with a
//     5s bounded wait and a 60s stale-lock breaker. Refusals THROW (never
//     process.exit inside the lock) so the lock always releases.
//   * Optimistic: every addressed op carries --expect <sha1-12 of the
//     block's text, joined+trimmed exactly as src/tui/memory.ts hashes it>.
//     A mismatch (the overseer rewrote memory between the TUI's read and
//     the keystroke) REFUSES the op — stale views never destroy fresh
//     writes. pi-memory itself holds no lock, so the file's mtime
//     is re-checked before the write and the op re-applied on movement.
//   * Atomic: tmp + rename in the same directory, never in-place.
//
// Ops (payload text on stdin where applicable; every address is
// --id X --ts 'YYYY-MM-DD HH:MM:SS' --block N --expect H):
//   retire     remove the block
//   pin        tag #pinned + move to the top-of-file region (before the
//              first header, after any preamble — the slice that survives
//              pi-memory's injection truncation,: ~75 lines)
//   unpin      drop the #pinned tag (in place)
//   edit       replace block text (stdin; blank lines collapse — a blank
//              line would split the block)
//   add        append a #manual entry (stdin) — no address
//   note       append a pre-tagged entry verbatim (stdin; must open with a
//              #tag) — no address. The daemon's [feedback] loop
//              writes #feedback entries through this, so memedit stays the
//              ONE external mutation path into pi-memory.
//
// Addressing: batches start at a header comment — pi-memory writes THREE
// variants: `<!-- TS [id] -->`, `<!-- last updated: TS [id] -->`,
// `<!-- HANDOFF TS [id] -->` — and run to the next header. Blocks are
// blank-line-separated line runs inside a batch; N is the block's index
// within its batch. The id ALONE is not unique (it is the writing session's
// 8-char prefix) — the (ts, id) pair keys the batch. Keep the header regex
// and hash discipline in step with src/tui/memory.ts.
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, renameSync, rmdirSync, statSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

const MEMORY_PATH = process.env.QCR_MEMORY_PATH ?? "/home/review/.pi/agent/memory/MEMORY.md";
const HEADER_RE = /^<!--\s*(?:(?:last updated:|HANDOFF)\s+)?(\d{4}-\d{2}-\d{2}) (\d{2}:\d{2}:\d{2})\s*\[([^\]]+)\]\s*-->\s*$/;
const LOCK_WAIT_MS = 5_000;
const LOCK_STALE_MS = 60_000;

class Refusal extends Error {}

function die(msg) {
  throw new Refusal(msg);
}

function hash(text) {
  return createHash("sha1").update(text, "utf8").digest("hex").slice(0, 12);
}

const blank = (line) => line.trim() === "";

/**
 * Structure WITHOUT rewriting: line-index ranges over the original lines.
 * batches: { ts, id, headerLine (-1 for the id-less preamble), endLine
 * (exclusive), blocks: [{ start, end }] } — block ranges hold only
 * non-blank lines; blank lines stay outside every range and are never
 * touched except when a whole block is removed.
 */
function scan(lines) {
  const batches = [];
  let cur = null;
  for (let i = 0; i < lines.length; i++) {
    const m = HEADER_RE.exec(lines[i]);
    if (m) {
      if (cur) cur.endLine = i;
      cur = { ts: `${m[1]} ${m[2]}`, id: m[3], headerLine: i, endLine: lines.length, blocks: [] };
      batches.push(cur);
      continue;
    }
    if (blank(lines[i])) continue;
    if (!cur) {
      cur = { ts: "", id: "", headerLine: -1, endLine: lines.length, blocks: [] };
      batches.push(cur);
    }
    const last = cur.blocks[cur.blocks.length - 1];
    if (last && last.end === i) last.end = i + 1;
    else cur.blocks.push({ start: i, end: i + 1 });
  }
  return batches;
}

function blockText(lines, range) {
  return lines
    .slice(range.start, range.end)
    .join("\n")
    .trim();
}

function findBlock(batches, id, ts, blockIdx) {
  const batch = batches.find((b) => b.id === id && b.ts === ts);
  if (!batch) die(`no batch [${id}] @ ${ts}`);
  if (blockIdx < 0 || blockIdx >= batch.blocks.length) die(`batch [${id}] @ ${ts} has no block ${blockIdx}`);
  return { batch, range: batch.blocks[blockIdx] };
}

function checkExpect(lines, range, expect) {
  if (hash(blockText(lines, range)) !== expect) die("stale view — memory changed underneath you, refresh and retry");
}

/** Remove a line range plus the blank run right after it (or before it, at a
 * batch tail), so removals don't leave doubled blank lines. */
function spliceOut(lines, start, end) {
  let e = end;
  while (e < lines.length && blank(lines[e])) e++;
  let s = start;
  if (e === lines.length) while (s > 0 && blank(lines[s - 1])) s--;
  lines.splice(s, e - s);
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
      // A crashed holder must not brick the tool forever: break stale locks.
      try {
        if (Date.now() - statSync(lockDir).mtimeMs > LOCK_STALE_MS) {
          rmdirSync(lockDir);
          continue;
        }
      } catch {
        // The lock vanished — or was never creatable (memory dir missing,
        // EACCES). Without a deadline check + sleep here this branch was a
        // hot 100%-CPU spin whenever the PARENT dir was absent, which the
        // daemon's note op can now hit at webhook cadence (review).
        if (Date.now() > deadline) die(`lock timeout — cannot take ${lockDir} (memory dir missing or unwritable?)`);
        Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 100);
        continue;
      }
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
try {
  for (let i = 0; i < rest.length; i += 2) {
    if (!rest[i]?.startsWith("--")) die(`bad argument '${rest[i]}'`);
    args[rest[i].slice(2)] = rest[i + 1];
  }
  const needsAddress = op === "retire" || op === "pin" || op === "unpin" || op === "edit";
  if (needsAddress && (!args.id || !args.ts || args.block === undefined || !args.expect)) die(`${op} needs --id --ts --block --expect`);
  if (needsAddress && !/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/.test(args.ts)) die("--ts must be 'YYYY-MM-DD HH:MM:SS'");
  const blockIdx = needsAddress ? Number(args.block) : 0;
  if (needsAddress && !Number.isInteger(blockIdx)) die("--block must be an integer");
  const payload = op === "edit" || op === "add" || op === "note" ? readStdin() : "";
  if ((op === "edit" || op === "add" || op === "note") && payload.length === 0) die(`${op}: empty text on stdin`);
  if (payload.length > 4000) die(`${op}: text too long (${payload.length} > 4000 chars)`);
  const payloadLines = payload.replace(/\n{2,}/g, "\n").split("\n");

  const transform = (lines) => {
    const batches = scan(lines);
    switch (op) {
      case "retire": {
        const { batch, range } = findBlock(batches, args.id, args.ts, blockIdx);
        checkExpect(lines, range, args.expect);
        spliceOut(lines, range.start, range.end);
        if (batch.blocks.length === 1 && batch.headerLine >= 0) {
          // The batch is now empty — drop its (unmoved) header line too.
          const h = scan(lines).find((b) => b.id === args.id && b.ts === args.ts);
          if (h && h.blocks.length === 0) spliceOut(lines, h.headerLine, h.headerLine + 1);
        }
        break;
      }
      case "pin": {
        const { batch, range } = findBlock(batches, args.id, args.ts, blockIdx);
        checkExpect(lines, range, args.expect);
        let text = blockText(lines, range);
        if (!/(^|\s)#pinned(\s|$)/.test(text)) text = `#pinned ${text}`;
        const emptied = batch.blocks.length === 1 && batch.headerLine >= 0;
        spliceOut(lines, range.start, range.end);
        if (emptied) {
          const h = scan(lines).find((b) => b.id === args.id && b.ts === args.ts);
          if (h && h.blocks.length === 0) spliceOut(lines, h.headerLine, h.headerLine + 1);
        }
        // Insert before the first header but AFTER any id-less preamble, so
        // preamble lines are never absorbed into the pinned batch on the
        // next parse. Derived id keeps (ts,id) unique.
        const after = scan(lines);
        const firstHeader = after.find((b) => b.headerLine >= 0);
        const at = firstHeader ? firstHeader.headerLine : lines.length;
        lines.splice(at, 0, `<!-- ${batch.ts} [${args.id}.p${blockIdx}] -->`, ...text.split("\n"), "");
        break;
      }
      case "unpin": {
        const { range } = findBlock(batches, args.id, args.ts, blockIdx);
        checkExpect(lines, range, args.expect);
        const text = blockText(lines, range)
          .replace(/(^|\s)#pinned(?=\s|$)/g, "$1")
          .replace(/^ +/, "")
          .replace(/  +/g, " ");
        lines.splice(range.start, range.end - range.start, ...text.split("\n"));
        break;
      }
      case "edit": {
        const { range } = findBlock(batches, args.id, args.ts, blockIdx);
        checkExpect(lines, range, args.expect);
        lines.splice(range.start, range.end - range.start, ...payloadLines);
        break;
      }
      case "add": {
        const text = /(^|\s)#manual(\s|$)/.test(payload) ? payload : `#manual ${payload}`;
        while (lines.length > 0 && blank(lines[lines.length - 1])) lines.pop();
        if (lines.length > 0) lines.push("");
        lines.push(`<!-- ${localStamp()} [qcr-${Date.now().toString(36)}] -->`, ...text.replace(/\n{2,}/g, "\n").split("\n"));
        break;
      }
      case "note": {
        // Verbatim append for machine writers that carry their own tag —
        // never silently re-tagged (that is what distinguishes it from add,
        // whose #manual means "the owner's own words").
        if (!/^#[a-z]/i.test(payload)) die("note: text must open with a #tag (e.g. #feedback …)");
        while (lines.length > 0 && blank(lines[lines.length - 1])) lines.pop();
        if (lines.length > 0) lines.push("");
        // Random suffix: the daemon can append two notes inside one second,
        // and a duplicated (ts, id) pair would make later TUI addressing of
        // either batch ambiguous.
        const noteId = `qcrd-${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
        lines.push(`<!-- ${localStamp()} [${noteId}] -->`, ...payload.replace(/\n{2,}/g, "\n").split("\n"));
        break;
      }
      default:
        die(`unknown op '${op ?? ""}' — retire|pin|unpin|edit|add|note`);
    }
  };

  withLock(() => {
    // pi-memory holds no lock of its own: re-read and re-apply when the
    // file's mtime moves between our read and our write (three attempts).
    const mtimeOf = () => {
      try {
        return statSync(MEMORY_PATH).mtimeMs;
      } catch {
        return -1;
      }
    };
    for (let attempt = 0; ; attempt++) {
      const before = mtimeOf();
      let md = "";
      try {
        md = readFileSync(MEMORY_PATH, "utf8");
      } catch {
        // Appending ops create the file; addressed ops need it to exist.
        if (op !== "add" && op !== "note") die(`cannot read ${MEMORY_PATH}`);
      }
      const hadFinalNewline = md.endsWith("\n") || md === "";
      const lines = md.split("\n");
      if (hadFinalNewline && lines[lines.length - 1] === "") lines.pop();
      transform(lines);
      if (mtimeOf() !== before) {
        if (attempt >= 2) die("memory is being rewritten by a live session — try again");
        continue;
      }
      writeAtomic(lines.join("\n") + "\n");
      break;
    }
    process.stdout.write(`ok: ${op}\n`);
  });
} catch (err) {
  if (err instanceof Refusal) {
    process.stdout.write(`refused: ${err.message}\n`);
    process.exit(1);
  }
  throw err;
}

// Best-effort: refresh the qmd index so memory_search sees the edit (
// §6 — search reads the index, not the files). Detached; failure is fine.
try {
  spawn("sh", ["-c", "qmd update >/dev/null 2>&1 && qmd embed >/dev/null 2>&1"], { detached: true, stdio: "ignore" }).unref();
} catch {
  /* qmd absent — search catches up at the next session start */
}
