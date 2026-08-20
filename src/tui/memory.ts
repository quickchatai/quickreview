// Memory & learning tab — the pi-memory model half.
//
// pi-memory's MEMORY.md is plain markdown: write batches delimited by header
// comments `<!-- YYYY-MM-DD HH:MM:SS [id] -->`, each batch holding one or
// more blank-line-separated paragraph blocks (one lesson per block). The TUI
// reads the whole file over ssh and parses it here; every management verb is
// executed remotely by scripts/memedit.mjs under flock (see that file for
// the concurrency contract) and addressed as `<batch id> + <block index> +
// expected-text hash`, so a concurrent overseer write turns into a refused
// op instead of a corrupted file.
import { createHash } from "node:crypto";
import type { TuiConfig } from "../config.js";
import type { SshRunner } from "./remote.js";

export interface MemoryEntry {
  /** The batch header id (the bracketed token). NOT unique on its own — it is
   * the writing session's id prefix, so several batches can carry
   * it. Every address is the (ts, id) pair plus the block index. */
  id: string;
  /** Wall-clock stamp from the batch header, `YYYY-MM-DD HH:MM:SS`. */
  ts: string;
  /** `YYYY-MM-DD` slice of ts — the day-highlight key. */
  day: string;
  /** Index of this block inside its batch (blocks are blank-line separated). */
  block: number;
  /** The block's raw text (trimmed, newlines preserved). */
  text: string;
  /** `#tag` tokens found in the text. */
  tags: string[];
  /** `[[link]]` tokens found in the text. */
  links: string[];
  pinned: boolean;
}

// pi-memory writes THREE header variants: plain, `last updated:`
// (overwrite mode), and `HANDOFF` (compaction). All three delimit batches —
// missing one would mis-attribute its blocks to the previous batch and hand
// every management verb the wrong address. Keep in step with memedit.mjs.
const HEADER_RE = /^<!--\s*(?:(?:last updated:|HANDOFF)\s+)?(\d{4}-\d{2}-\d{2}) (\d{2}:\d{2}:\d{2})\s*\[([^\]]+)\]\s*-->\s*$/;

/** sha1 of a block's exact text — the optimistic-concurrency token every
 * mutating op carries (`--expect`); memedit.mjs recomputes and refuses on
 * mismatch. */
export function blockHash(text: string): string {
  return createHash("sha1").update(text, "utf8").digest("hex").slice(0, 12);
}

/** Parse MEMORY.md into entries, file order (append order = oldest first). */
export function parseMemory(md: string): MemoryEntry[] {
  const entries: MemoryEntry[] = [];
  let header: { ts: string; day: string; id: string } | undefined;
  let block: string[] = [];
  let blockIdx = 0;

  const flush = (): void => {
    const text = block.join("\n").trim();
    block = [];
    if (!header || text.length === 0) return;
    const tags = [...text.matchAll(/(^|\s)#([\w-]+)/g)].map((m) => m[2]!);
    const links = [...text.matchAll(/\[\[([^\]]+)\]\]/g)].map((m) => m[1]!);
    entries.push({
      id: header.id,
      ts: header.ts,
      day: header.day,
      block: blockIdx,
      text,
      tags,
      links,
      pinned: tags.includes("pinned"),
    });
    blockIdx += 1;
  };

  for (const line of md.split("\n")) {
    const m = HEADER_RE.exec(line);
    if (m) {
      flush();
      header = { ts: `${m[1]} ${m[2]}`, day: m[1]!, id: m[3]! };
      blockIdx = 0;
      continue;
    }
    if (line.trim() === "") {
      flush();
      continue;
    }
    block.push(line);
  }
  flush();
  return entries;
}

/** Newest-first ordering for the timeline: by ts desc, then file order desc.
 * Pinned entries float to the top regardless of age — mirroring their
 * top-of-file placement (the part of MEMORY.md that survives pi-memory's
 * injection truncation). */
export function timelineOrder(entries: MemoryEntry[]): MemoryEntry[] {
  const indexed = entries.map((e, i) => ({ e, i }));
  indexed.sort((a, b) => {
    if (a.e.pinned !== b.e.pinned) return a.e.pinned ? -1 : 1;
    if (a.e.ts !== b.e.ts) return a.e.ts < b.e.ts ? 1 : -1;
    return b.i - a.i;
  });
  return indexed.map((x) => x.e);
}

/** Operational-defect entries — the auto-filer's input (§9). */
export function defectEntries(entries: MemoryEntry[]): MemoryEntry[] {
  return entries.filter((e) => e.tags.includes("bug"));
}

// ---- remote plumbing ------------------------------------------------------

const MEMORY_PATH = "/home/review/.pi/agent/memory/MEMORY.md";

function dockerSh(cfg: TuiConfig, script: string): string[] {
  return [...(cfg.sudo_docker ? ["sudo"] : []), "docker", "exec", cfg.container, "sh", "-c", script];
}

function dockerShStdin(cfg: TuiConfig, script: string): string[] {
  // -i: the op's payload (new text) rides stdin, never argv (quoting safety).
  return [...(cfg.sudo_docker ? ["sudo"] : []), "docker", "exec", "-i", cfg.container, "sh", "-c", script];
}

export function memoryCatArgv(cfg: TuiConfig): string[] {
  return dockerSh(cfg, `cat '${MEMORY_PATH}' 2>/dev/null || true`);
}

interface MemAddress {
  id: string;
  ts: string;
  block: number;
  expect: string;
}

export type MemEditOp =
  | ({ op: "retire" } & MemAddress)
  | ({ op: "pin" } & MemAddress)
  | ({ op: "unpin" } & MemAddress)
  | ({ op: "edit"; text: string } & MemAddress)
  | { op: "add"; text: string };

const TS_RE = /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/;

/** The remote memedit invocation. Mutating payload goes over stdin; the op
 * and address ride argv (all shell-safe tokens by construction: ids are
 * squashed to word chars, the ts must match its strict shape, hashes are
 * hex, indices are numbers). */
export function memEditArgv(cfg: TuiConfig, op: MemEditOp): { argv: string[]; stdin?: string } {
  const bin = `node '${cfg.remote_sandbox_root}/scripts/memedit.mjs'`;
  const safe = (s: string): string => s.replace(/[^\w.:-]/g, "");
  if (op.op === "add") return { argv: dockerShStdin(cfg, `${bin} add`), stdin: op.text };
  if (!TS_RE.test(op.ts)) throw new Error(`bad memory ts '${op.ts}'`);
  const addr = `--id '${safe(op.id)}' --ts '${op.ts}' --block ${op.block} --expect ${safe(op.expect)}`;
  if (op.op === "edit") return { argv: dockerShStdin(cfg, `${bin} edit ${addr}`), stdin: op.text };
  return { argv: dockerSh(cfg, `${bin} ${op.op} ${addr}`) };
}

export interface MemoryStore {
  read(): Promise<MemoryEntry[]>;
  apply(op: MemEditOp): Promise<{ ok: boolean; message: string }>;
}

export class SshMemoryStore implements MemoryStore {
  constructor(
    private readonly cfg: TuiConfig,
    private readonly ssh: SshRunner,
  ) {}

  async read(): Promise<MemoryEntry[]> {
    const res = await this.ssh(this.cfg.ssh_host, memoryCatArgv(this.cfg));
    return res.ok ? parseMemory(res.stdout) : [];
  }

  async apply(op: MemEditOp): Promise<{ ok: boolean; message: string }> {
    const { argv, stdin } = memEditArgv(this.cfg, op);
    const res = await this.ssh(this.cfg.ssh_host, argv, { stdin, timeoutMs: 15_000 });
    const line = (res.stdout || res.stderr).trim().split("\n").pop() ?? "";
    return { ok: res.ok, message: line || (res.ok ? "ok" : "failed") };
  }
}
