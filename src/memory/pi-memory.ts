// `MemoryStore` over pi-memory — the ONLY module that knows MEMORY.md's
// markdown shape or that `scripts/memedit.mjs` exists.
//
// pi-memory's MEMORY.md is plain markdown: write batches delimited by header
// comments `<!-- YYYY-MM-DD HH:MM:SS [id] -->`, each batch holding one or
// more blank-line-separated paragraph blocks (one lesson per block). Reads
// parse the whole file; every mutation is executed by scripts/memedit.mjs
// under its lock and addressed as `<batch id> + <block index> +
// expected-text hash`, so a concurrent session write turns into a refused op
// instead of a corrupted file (memedit.mjs documents that contract).
//
// Two transports, one store: the daemon runs memedit as a local child
// process against its own memory file; the TUI runs it inside the VM
// container over ssh. The addressing, hashing and refusal semantics are the
// store's and identical on both.
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import type { TuiConfig } from "../config.js";
import type { SshRunner } from "../tui/remote.js";
import { matchesQuery, type MemoryEntry, type MemoryOp, type MemorySearchOptions, type MemoryStore, type MemoryWriteResult } from "./store.js";

/** MEMORY.md inside the review container (the TUI's remote path). */
export const CONTAINER_MEMORY_PATH = "/home/review/.pi/agent/memory/MEMORY.md";

/** MEMORY.md for a process running alongside pi (the daemon's own path). */
export function localMemoryPath(): string {
  return process.env["QCR_MEMORY_PATH"] ?? join(homedir(), ".pi", "agent", "memory", "MEMORY.md");
}

// pi-memory writes THREE header variants: plain, `last updated:`
// (overwrite mode), and `HANDOFF` (compaction). All three delimit batches —
// missing one would mis-attribute its blocks to the previous batch and hand
// every management verb the wrong address. Keep in step with memedit.mjs.
const HEADER_RE = /^<!--\s*(?:(?:last updated:|HANDOFF)\s+)?(\d{4}-\d{2}-\d{2}) (\d{2}:\d{2}:\d{2})\s*\[([^\]]+)\]\s*-->\s*$/;

/** sha1 of a block's exact text — the optimistic-concurrency token every
 * mutating op carries (`--expect`); memedit.mjs recomputes and refuses on
 * mismatch. Exposed because the companion feed republishes the token. */
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
      hash: blockHash(text),
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

// ---- memedit invocation ----------------------------------------------------

const TS_RE = /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/;

/** Address tokens are squashed to the alphabet memedit's addressing actually
 * uses. Belt-and-braces: the ssh transport interpolates them into a remote
 * shell command, and a batch id ultimately comes from a file a session wrote. */
const safeToken = (s: string): string => s.replace(/[^\w.:-]/g, "");

/**
 * The memedit CLI call one op becomes: `args` is the raw argv after the
 * script path, `stdin` the payload (text NEVER rides argv — quoting safety,
 * and memedit reads it from fd 0). Throws on a malformed timestamp: an
 * address that cannot be spelled is a bug, not a refusal to render.
 */
export function memeditArgs(op: MemoryOp): { args: string[]; stdin?: string } {
  if (op.op === "add" || op.op === "note") return { args: [op.op], stdin: op.text };
  if (!TS_RE.test(op.ts)) throw new Error(`bad memory ts '${op.ts}'`);
  const addr = ["--id", safeToken(op.id), "--ts", op.ts, "--block", String(op.block), "--expect", safeToken(op.expect)];
  if (op.op === "edit") return { args: ["edit", ...addr], stdin: op.text };
  return { args: [op.op, ...addr] };
}

/**
 * Where a memedit invocation actually runs. `readMemory` returns null when
 * the file could not be read at all (absent, unreachable) — an empty file is
 * `""`, and the two must stay distinguishable.
 */
export interface MemeditTransport {
  readMemory(): Promise<string | null>;
  runMemedit(args: string[], stdin?: string): Promise<{ ok: boolean; stdout: string; stderr: string }>;
}

/** memedit reports one line: `ok: <op>` or `refused: <why>`. */
function resultLine(res: { ok: boolean; stdout: string; stderr: string }): MemoryWriteResult {
  const line = (res.stdout || res.stderr).trim().split("\n").pop() ?? "";
  return { ok: res.ok, message: line || (res.ok ? "ok" : "failed") };
}

export class PiMemoryStore implements MemoryStore {
  constructor(private readonly transport: MemeditTransport) {}

  async read(): Promise<MemoryEntry[]> {
    const md = await this.transport.readMemory();
    return md === null ? [] : parseMemory(md);
  }

  /** pi-memory has no queryable index outside a pi session (qmd is the
   * session's, not ours), so search is a scan over the parsed file. Callers
   * see the interface's semantics either way. */
  async search(query: string, opts?: MemorySearchOptions): Promise<MemoryEntry[]> {
    const hits = (await this.read()).filter((e) => matchesQuery(e, query, opts));
    const limit = opts?.limit;
    return limit !== undefined && limit >= 0 ? hits.slice(0, limit) : hits;
  }

  async apply(op: MemoryOp): Promise<MemoryWriteResult> {
    let call: { args: string[]; stdin?: string };
    try {
      call = memeditArgs(op);
    } catch (err) {
      return { ok: false, message: `refused: ${err instanceof Error ? err.message : String(err)}` };
    }
    try {
      return resultLine(await this.transport.runMemedit(call.args, call.stdin));
    } catch (err) {
      // A broken transport is still an answer the operator can read; the
      // interface's contract is that writes resolve.
      return { ok: false, message: `memory write failed: ${err instanceof Error ? err.message : String(err)}` };
    }
  }
}

// ---- transport: the daemon's own container ---------------------------------

export interface LocalMemeditOptions {
  /** Path to scripts/memedit.mjs. */
  scriptPath: string;
  /** Overrides QCR_MEMORY_PATH for the child. */
  memoryPath?: string;
  timeoutMs?: number;
}

/** memedit as a child process against a local MEMORY.md — the daemon side. */
export class LocalMemeditTransport implements MemeditTransport {
  constructor(private readonly opts: LocalMemeditOptions) {}

  private memoryPath(): string {
    return this.opts.memoryPath ?? localMemoryPath();
  }

  async readMemory(): Promise<string | null> {
    try {
      return await readFile(this.memoryPath(), "utf8");
    } catch {
      return null;
    }
  }

  runMemedit(args: string[], stdin?: string): Promise<{ ok: boolean; stdout: string; stderr: string }> {
    return new Promise((resolvePromise, reject) => {
      const child = spawn(process.execPath, [this.opts.scriptPath, ...args], {
        env: { ...process.env, QCR_MEMORY_PATH: this.memoryPath() },
        stdio: ["pipe", "pipe", "pipe"],
      });
      const t = setTimeout(() => child.kill("SIGKILL"), this.opts.timeoutMs ?? 10_000);
      t.unref?.();
      let out = "";
      let err = "";
      child.stdout.on("data", (d) => (out += String(d)));
      child.stderr.on("data", (d) => (err += String(d)));
      child.on("error", (e) => {
        clearTimeout(t);
        reject(e);
      });
      child.on("close", (code) => {
        clearTimeout(t);
        resolvePromise({ ok: code === 0, stdout: out, stderr: err });
      });
      if (stdin !== undefined) child.stdin.write(stdin);
      child.stdin.end();
    });
  }
}

/** The daemon's store: memedit beside us, memory file per QCR_MEMORY_PATH. */
export function localPiMemoryStore(opts: { root?: string; memoryPath?: string; timeoutMs?: number } = {}): PiMemoryStore {
  return new PiMemoryStore(
    new LocalMemeditTransport({
      scriptPath: join(opts.root ?? process.cwd(), "scripts", "memedit.mjs"),
      ...(opts.memoryPath !== undefined ? { memoryPath: opts.memoryPath } : {}),
      ...(opts.timeoutMs !== undefined ? { timeoutMs: opts.timeoutMs } : {}),
    }),
  );
}

// ---- transport: the VM container over ssh ----------------------------------

function dockerSh(cfg: TuiConfig, script: string, withStdin: boolean): string[] {
  // -i: the op's payload (new text) rides stdin, never argv (quoting safety).
  return [...(cfg.sudo_docker ? ["sudo"] : []), "docker", "exec", ...(withStdin ? ["-i"] : []), cfg.container, "sh", "-c", script];
}

export function memoryCatArgv(cfg: TuiConfig): string[] {
  return dockerSh(cfg, `cat '${CONTAINER_MEMORY_PATH}' 2>/dev/null || true`, false);
}

/** `docker exec … sh -c "node …/memedit.mjs <args>"`. Every interpolated
 * value is either a bare flag/integer or a single-quoted token that cannot
 * contain a quote (`safeToken`, or a timestamp validated against its strict
 * shape), so the remote shell re-parses exactly the argv we meant. */
function memeditScriptArgv(cfg: TuiConfig, args: string[], hasStdin: boolean): string[] {
  const parts = args.map((a, i) => (i === 0 || a.startsWith("--") || /^\d+$/.test(a) ? a : `'${a}'`));
  return dockerSh(cfg, `node '${cfg.remote_sandbox_root}/scripts/memedit.mjs' ${parts.join(" ")}`, hasStdin);
}

/** The remote memedit invocation for one op — the op word and address ride
 * argv, the payload rides stdin. Exported for the argv tests. */
export function memEditArgv(cfg: TuiConfig, op: MemoryOp): { argv: string[]; stdin?: string } {
  const { args, stdin } = memeditArgs(op);
  const argv = memeditScriptArgv(cfg, args, stdin !== undefined);
  return stdin !== undefined ? { argv, stdin } : { argv };
}

/** memedit inside the VM container, driven over the TUI's ssh runner. */
export class SshMemeditTransport implements MemeditTransport {
  constructor(
    private readonly cfg: TuiConfig,
    private readonly ssh: SshRunner,
  ) {}

  async readMemory(): Promise<string | null> {
    const res = await this.ssh(this.cfg.ssh_host, memoryCatArgv(this.cfg));
    return res.ok ? res.stdout : null;
  }

  async runMemedit(args: string[], stdin?: string): Promise<{ ok: boolean; stdout: string; stderr: string }> {
    const argv = memeditScriptArgv(this.cfg, args, stdin !== undefined);
    const res = await this.ssh(this.cfg.ssh_host, argv, stdin !== undefined ? { stdin, timeoutMs: 15_000 } : { timeoutMs: 15_000 });
    return { ok: res.ok, stdout: res.stdout, stderr: res.stderr };
  }
}

/** The TUI's store: MEMORY.md inside the VM container, read and edited over ssh. */
export function sshPiMemoryStore(cfg: TuiConfig, ssh: SshRunner): PiMemoryStore {
  return new PiMemoryStore(new SshMemeditTransport(cfg, ssh));
}
