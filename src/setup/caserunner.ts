// The case runner: SetupEngine's `CaseRunner` port, for real — one case as
// one background pi subagent inside the companion container.
//
// This is the only file under src/setup/ that spawns pi, and it is kept apart
// on purpose: the single-shepherd fence (tests/single-shepherd.test.ts)
// allows it by path, like the companion's own argv and the bench runner. It
// is not a daemon module — nothing the daemon loads imports src/setup/ (that
// fence checks it too) — and what it spawns is a leaf: `-p --no-session -ne`
// with bash-guard the one extension, read-only tools, no memory, no fan-out
// (root rule 9: no new session kind, nothing on the VM).
import { CASE_STOP_GRACE_MS } from "../casebudget.js";
import { spawn as nodeSpawn } from "node:child_process";
import {
  appendFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { homedir, tmpdir } from "node:os";
import { dirname, join, posix, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { GITHUB_TOKEN_ENVS } from "../envstrip.js";
import { PI_PACKAGE, piCliPath } from "../picli.js";
import type { CaseOutcome, CaseRunner, CaseSpec } from "./engine.js";

/** An agent file of the companion set: `name`/`tools`/`model` frontmatter
 * and the system prompt below it — the native subagent loader's format. */
export interface AgentFile {
  name: string;
  tools: string[];
  model: string | null;
  systemPrompt: string;
}

export function parseAgentFile(text: string): AgentFile | null {
  const m = /^---\n([\s\S]*?)\n---\n?([\s\S]*)$/.exec(text.replace(/\r\n/g, "\n"));
  if (!m) return null;
  const fields: Record<string, string> = {};
  for (const line of m[1]!.split("\n")) {
    const kv = /^([A-Za-z_][\w-]*):\s*(.*)$/.exec(line);
    if (kv) fields[kv[1]!] = kv[2]!.trim();
  }
  if (!fields.name) return null;
  return {
    name: fields.name,
    tools: (fields.tools ?? "")
      .replace(/^\[|\]$/g, "")
      .split(",")
      .map((t) => t.trim())
      .filter(Boolean),
    model: fields.model || null,
    systemPrompt: m[2]!.trim(),
  };
}

/** The spawn this runner needs — `child_process.spawn`'s shape, narrowed so
 * tests hand in a fake child. */
export type SpawnFn = (
  command: string,
  args: string[],
  opts: { cwd: string; env?: NodeJS.ProcessEnv; stdio: ["ignore", "pipe", "pipe"] },
) => {
  stdout: NodeJS.ReadableStream;
  stderr: NodeJS.ReadableStream;
  on(event: "close", cb: (code: number | null) => void): unknown;
  on(event: "error", cb: (err: Error) => void): unknown;
  kill(signal?: NodeJS.Signals): boolean;
};

/** The package names pi's CLI ships under. VERIFY-ON-PIN (0.87.1, re-read at 0.99.1): the
 * pinned package is `@earendil-works/pi-coding-agent` (package.json `pi`
 * block); the legacy `@mariozechner` scope is what older installs carry. */
export const PI_PACKAGES: readonly string[] = [
  PI_PACKAGE,
  "@mariozechner/pi-coding-agent",
];

/** True only when `script` is a `bin` entry of the pi package: the nearest
 * package.json above its real path names pi, and one of its `bin` targets
 * resolves to that same real path. Anything unreadable is "not pi". */
export function isPiCliEntry(script: string): boolean {
  let real: string;
  try {
    real = realpathSync(script);
  } catch {
    return false;
  }
  for (let d = dirname(real); ; d = dirname(d)) {
    const pkgFile = join(d, "package.json");
    if (existsSync(pkgFile)) {
      try {
        const pkg = JSON.parse(readFileSync(pkgFile, "utf8")) as { name?: unknown; bin?: unknown };
        if (typeof pkg.name !== "string" || !PI_PACKAGES.includes(pkg.name)) return false;
        const bins =
          typeof pkg.bin === "string"
            ? [pkg.bin]
            : pkg.bin && typeof pkg.bin === "object"
              ? Object.values(pkg.bin)
              : [];
        return bins.some((b) => {
          if (typeof b !== "string") return false;
          try {
            return realpathSync(resolve(d, b)) === real;
          } catch {
            return false;
          }
        });
      } catch {
        return false;
      }
    }
    if (dirname(d) === d) return false;
  }
}

/** How to start pi. When the running process is pi (argv[1] is verifiably
 * pi's CLI entry — the native subagent extension's rule) it reuses that
 * script under the running runtime; any other host — a node driver, a test,
 * the TUI, the release image's scan — gets the pinned pi's own CLI
 * (src/picli.ts), so a non-pi host never spawns itself and never runs a `pi`
 * of another version off the PATH (the release image has none). A
 * bun-compiled pi (`/$bunfs/…`) takes that CLI too.
 * VERIFY-ON-PIN (0.87.1, re-read at 0.99.1, 1.0.0 and 1.3.0 — bin still dist/bundle/cli.js): pi's entry is a `bin` of its package, run by node. */
export function piInvocation(
  host: { argv1: string | undefined; execPath: string; piCli?: () => string } = {
    argv1: process.argv[1],
    execPath: process.execPath,
  },
): { command: string; prefix: string[] } {
  const script = host.argv1;
  if (script && !script.startsWith("/$bunfs/") && isPiCliEntry(script)) {
    return { command: host.execPath, prefix: [script] };
  }
  return { command: host.execPath, prefix: [(host.piCli ?? piCliPath)()] };
}

/** The tools whose `path` argument names content the model read. `find` and
 * `ls` list names and read no content, so they are not reads. */
export const FILE_READ_TOOLS: readonly string[] = ["read", "grep"];

/** The path a `tool_execution_start` event says the model asked to read, or
 * null. An attempt, not a read: `piCaseRunner` credits it only once the
 * call's `tool_execution_end` reports success (`readSucceeded`).
 * VERIFY-ON-PIN (read from 0.99.1's dist: the JSON mode passes agent events
 * through verbatim — `tool_execution_start` carries `toolName` and `args`;
 * `read` and `grep` both take `path`): the event and argument spelling. */
export function readPathOf(event: {
  type?: string;
  toolName?: unknown;
  args?: unknown;
}): string | null {
  if (event.type !== "tool_execution_start" || typeof event.toolName !== "string") return null;
  if (!FILE_READ_TOOLS.includes(event.toolName)) return null;
  const path = (event.args as { path?: unknown } | null | undefined)?.path;
  return typeof path === "string" && path.trim() !== "" ? path : null;
}

/** The id of a `tool_execution_end` that finished WITHOUT an error, or null.
 * A failed read (a missing file, an offset past its end) or a grep that
 * could not run read nothing, so its start credits no file.
 * VERIFY-ON-PIN (0.99.1's agent-core `tool_execution_end` carries
 * `toolCallId` and `isError`; the same pair is in the JSON-mode transcripts
 * kept by a scan at 1.0.0): the event spelling. */
export function readSucceeded(event: {
  type?: string;
  toolCallId?: unknown;
  isError?: unknown;
}): string | null {
  if (event.type !== "tool_execution_end" || typeof event.toolCallId !== "string") return null;
  return event.isError === false ? event.toolCallId : null;
}

/** The file a read of `raw` opened, for a child running in `cwd` — pi's own
 * resolution (`resolveToCwd`): one leading `@` stripped, `~` expanded, a
 * relative path taken against the child's cwd, `.`/`..` collapsed. The scan
 * judges what the lens opened, not how it spelled it: the child runs in the
 * app root, not the scanned tree, so a relative `api/x.py` opened the app
 * root's copy — another repository, or this checkout at HEAD — and must not
 * pass for a read of the tree.
 * VERIFY-ON-PIN (read from 0.99.1's dist/core/tools/path-utils.js
 * `resolveToCwd` → utils/paths `resolvePath` with `stripAtPrefix` and
 * `normalizeUnicodeSpaces`, `file://` URLs included): the macOS
 * filename variants its `resolveReadPath` also tries are not modelled — they
 * only differ for a path that does not exist as spelled. */
export function resolvedReadPath(raw: string, cwd: string, home: string = homedir()): string {
  // pi's `normalizePath` order: unicode spaces → ASCII space, one `@`
  // stripped, `~` expanded, a `file://` URL taken as its path.
  let p = raw.replace(/[\u00A0\u2000-\u200A\u202F\u205F\u3000]/g, " ");
  if (p.startsWith("@")) p = p.slice(1);
  if (p === "~") p = home;
  else if (p.startsWith("~/")) p = `${home}${p.slice(1)}`;
  else if (/^file:\/\//.test(p)) {
    try {
      p = fileURLToPath(p);
    } catch {
      // pi would throw on it and open nothing; left as spelled, it resolves
      // to no focus file and is never credited.
    }
  }
  return posix.resolve(cwd, p);
}

/** What one case's event stream says, fed event by event: the last assistant
 * text, pi's own per-message cost summed, how the model stopped, and the files
 * its `read`/`grep` calls opened. One reader for both hosts of a leaf — the
 * child process (`piCaseRunner`) and the in-process session
 * (src/engine/caserunner-sdk.ts) emit the same events. */
export function caseReadout(
  cwd: string,
  onCost?: (spentSoFar: number) => void,
): {
  feed(event: unknown): void;
  readonly final: string;
  readonly failure: string | null;
  readonly reads: string[];
  /** The summed cost; null when no message priced itself. */
  spent(): number | null;
} {
  let final = "";
  let cost = 0;
  let priced = false;
  let failure: string | null = null;
  const reads: string[] = [];
  // Started reads by call id, credited only when the call succeeds.
  const attempted = new Map<string, string>();
  return {
    feed(raw: unknown): void {
      if (typeof raw !== "object" || raw === null) return;
      const event = raw as {
        type?: string;
        message?: Record<string, unknown>;
        toolName?: unknown;
        toolCallId?: unknown;
        args?: unknown;
        isError?: unknown;
      };
      const read = readPathOf(event);
      if (read !== null && typeof event.toolCallId === "string")
        attempted.set(event.toolCallId, resolvedReadPath(read, cwd));
      const done = readSucceeded(event);
      if (done !== null && attempted.has(done)) {
        reads.push(attempted.get(done)!);
        attempted.delete(done);
      }
      const msg = event.message;
      if (event.type !== "message_end" || !msg || msg.role !== "assistant") return;
      const usage = msg.usage as { cost?: { total?: unknown } } | undefined;
      if (typeof usage?.cost?.total === "number") {
        cost += usage.cost.total;
        priced = true;
        try {
          onCost?.(cost);
        } catch {
          // A listener's fault never ends the case.
        }
      }
      const parts = Array.isArray(msg.content)
        ? (msg.content as Array<{ type?: string; text?: string }>)
        : [];
      const text = parts
        .filter((p) => p.type === "text" && typeof p.text === "string")
        .map((p) => p.text)
        .join("\n");
      if (text.trim() !== "") final = text;
      if (msg.stopReason === "error" || msg.stopReason === "aborted") {
        failure =
          typeof msg.errorMessage === "string"
            ? msg.errorMessage
            : `the model stopped: ${String(msg.stopReason)}`;
      } else {
        failure = null;
      }
    },
    get final(): string {
      return final;
    },
    get failure(): string | null {
      return failure;
    },
    get reads(): string[] {
      return reads;
    },
    spent(): number | null {
      return priced ? cost : null;
    },
  };
}

/** What a leaf's pi process may inherit, by exact name. The leaf's model runs
 * bash, so the process env is allowlisted rather than copied: no GitHub
 * credential (src/envstrip.ts) and nothing else of the driver's reaches it. */
const LEAF_ENV_NAMES: ReadonlySet<string> = new Set([
  "PATH",
  "HOME",
  "USER",
  "LOGNAME",
  "SHELL",
  "TERM",
  "TZ",
  "LANG",
  "TMPDIR",
  "TMP",
  "TEMP",
  "SSL_CERT_FILE",
  "SSL_CERT_DIR",
  "NODE_EXTRA_CA_CERTS",
  "HTTP_PROXY",
  "HTTPS_PROXY",
  "NO_PROXY",
  "ALL_PROXY",
  "http_proxy",
  "https_proxy",
  "no_proxy",
  "all_proxy",
]);

/** …and by prefix or shape: locale (`LC_*`), XDG dirs, pi's own settings
 * (`PI_*`, among them `PI_CODING_AGENT_DIR`), bash-guard's locators
 * (`QCR_*`: install, config home, sandbox root, replay flag) and the model
 * providers' key variables. */
const LEAF_ENV_PATTERNS: readonly RegExp[] = [
  /^LC_[A-Z_]+$/,
  /^XDG_[A-Z_]+$/,
  /^PI_[A-Z0-9_]+$/,
  /^QCR_[A-Z0-9_]+$/,
  /^[A-Z][A-Z0-9]*(?:_[A-Z0-9]+)*_API_KEY$/,
];

/** The env one leaf's pi starts with: `source` (the driver's) filtered to the
 * allowlist, the GitHub token envs always dropped, and `QCR_GITHUB_READ_ENV`
 * (the path of the file holding the read token) with them. */
export function leafEnv(source: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  for (const [name, value] of Object.entries(source)) {
    if (value === undefined) continue;
    if (LEAF_ENV_NAMES.has(name) || LEAF_ENV_PATTERNS.some((re) => re.test(name)))
      env[name] = value;
  }
  for (const k of GITHUB_TOKEN_ENVS) delete env[k];
  delete env["QCR_GITHUB_READ_ENV"];
  return env;
}

/** The stderr a failed case's reason is taken from: its last characters. */
const STDERR_TAIL_CHARS = 4000;

/** The last three lines of the last `STDERR_TAIL_CHARS` characters of a failed
 * leaf's stderr, joined with " / " — the excerpt a failure reason quotes. */
export function stderrExcerpt(stderr: string): string {
  return stderr.slice(-STDERR_TAIL_CHARS).trim().split("\n").slice(-3).join(" / ");
}

/** Transcript directories kept: the newest by modification time. */
export const TRANSCRIPT_RUNS_KEPT = 20;

/** Where a case's transcript lands under `dir`, relative to it: the case id's
 * first segment (the run) is the directory, the rest of it the file name —
 * `r3/row-2#1/validate` → `r3/row-2_1.validate.jsonl`. Every segment is
 * reduced to `[A-Za-z0-9._-]` and none may be `.` or `..`, so an id never
 * names a path outside `dir`. Pure. */
export function transcriptFile(id: string): string {
  const seg = (s: string): string => {
    const t = s.replace(/[^A-Za-z0-9._-]/g, "_");
    return t === "" || /^\.+$/.test(t) ? t.replace(/\./g, "_") || "_" : t;
  };
  const parts = id.split("/").map(seg);
  if (parts.length === 1) return `${parts[0]}.jsonl`;
  return `${parts[0]}/${parts.slice(1).join(".")}.jsonl`;
}

/** Remove all but the newest `keep` run directories under `dir` (by
 * modification time, never `except`). Best effort: a transcript is evidence,
 * not state, and a failure here never touches a case. */
export function pruneTranscripts(dir: string, keep: number, except: string): void {
  try {
    const runs = readdirSync(dir, { withFileTypes: true })
      .filter((d) => d.isDirectory() && d.name !== except)
      .map((d) => ({ name: d.name, at: statSync(join(dir, d.name)).mtimeMs }))
      .sort((a, b) => b.at - a.at || b.name.localeCompare(a.name));
    for (const r of runs.slice(Math.max(0, keep - 1)))
      rmSync(join(dir, r.name), { recursive: true, force: true });
  } catch {
    // Evidence only: nothing to undo.
  }
}

/**
 * Runs a case as one background pi subagent, the way pi's own subagent
 * extension runs a child: `pi --mode json -p --no-session` with the agent's
 * model, its tools and its body as the appended system prompt, the task as
 * the message — plus `-ne` with bash-guard as the one `-e` extension (a leaf
 * can neither fan out nor reach memory, and its bash is vetted like every
 * review session's), `-ns` and `-nc` (no skill, no context file: nothing of
 * the install's or a checkout's own reaches it) and `--approve` (the
 * no-stall rule: a child never waits on a trust modal). The child runs in
 * `cwd`, first-party ground, never in the reviewed checkout, whose `.pi/`
 * config must not load; it reads the
 * checkout by absolute path, and no context file is ever written there. Its
 * env is `leafEnv`: an allowlist, never the driver's whole environment.
 *
 * The answer is the last assistant message's text; the cost is pi's own
 * per-message accounting summed (null when it reported none); `reads` is
 * every path its `read`/`grep` calls named (`readPathOf`) whose call then
 * finished without an error (`readSucceeded`), resolved to the file that
 * call opened (`resolvedReadPath`, against `cwd`) — the scan's evidence that
 * the lens opened its files at all. With `transcriptDir`, the
 * child's whole `--mode json` stream is kept at `transcriptFile(spec.id)`
 * under it (`transcript` on the outcome, relative to the dir), so a reading
 * that missed something can be read back rather than inferred; the newest
 * `TRANSCRIPT_RUNS_KEPT` run directories are kept. A transcript that cannot
 * be written is left out, never a failed case. The task string names
 * every file by its absolute tree path for the same reason. An abort kills
 * the child (TERM, then KILL). Every outcome resolves — a temp directory that
 * cannot be made is a failed case, never a rejection.
 *
 * VERIFY-ON-PIN (0.87.1, re-read at 0.99.1, 1.0.0 and 1.3.0: examples/extensions/subagent the same but for its read-range rendering, CLI flag set identical but for the added --no-mcp; read from the published examples/extensions/subagent
 * and dist/cli/args.js): the argv spelling, `--no-extensions`/`--approve`,
 * and the `message_end` event carrying `message.usage.cost.total`.
 */
export function piCaseRunner(opts: {
  agentsDir: string;
  cwd: string;
  /** Where each case's event stream is kept; absent, none is. */
  transcriptDir?: string;
  /** The production tree holding extensions/bash-guard.ts. Omitted: `cwd`
   * (the app root in every production caller). */
  root?: string;
  /** The env the leaf's env is filtered from. Omitted: process.env. */
  env?: NodeJS.ProcessEnv;
  spawn?: SpawnFn;
  invocation?: { command: string; prefix: string[] };
}): CaseRunner {
  const spawn = opts.spawn ?? nodeSpawn;
  return {
    run: async (
      spec: CaseSpec,
      signal: AbortSignal,
      onCost?: (spentSoFar: number) => void,
    ): Promise<CaseOutcome> => {
      if (!/^[a-z][a-z0-9-]*$/.test(spec.agent))
        return {
          ok: false,
          reason: `not an agent name: ${JSON.stringify(spec.agent)}`,
          cost_usd: 0,
        };
      let agent: AgentFile | null;
      try {
        agent = parseAgentFile(readFileSync(join(opts.agentsDir, `${spec.agent}.md`), "utf8"));
      } catch {
        return { ok: false, reason: `no agent ${spec.agent} in ${opts.agentsDir}`, cost_usd: 0 };
      }
      if (agent === null || agent.name !== spec.agent)
        return { ok: false, reason: `${spec.agent}.md is not an agent file`, cost_usd: 0 };
      if (signal.aborted) return { ok: false, reason: "stopped before it started", cost_usd: 0 };

      let tmp: string;
      try {
        tmp = mkdtempSync(join(tmpdir(), "qcr-case-"));
      } catch (err) {
        return { ok: false, reason: `no temp directory for the case: ${String(err)}`, cost_usd: 0 };
      }
      try {
        const promptFile = join(tmp, `${spec.agent}.md`);
        try {
          writeFileSync(promptFile, agent.systemPrompt, { mode: 0o600 });
        } catch (err) {
          return {
            ok: false,
            reason: `the agent's prompt could not be written: ${String(err)}`,
            cost_usd: 0,
          };
        }
        const inv = opts.invocation ?? piInvocation();
        const args = [
          ...inv.prefix,
          "--mode",
          "json",
          "-p",
          "--no-session",
          "-ne",
          "-ns",
          "-nc",
          "--extension",
          join(opts.root ?? opts.cwd, "extensions", "cli", "bash-guard.ts"),
          "--approve",
        ];
        if (agent.model) args.push("--model", agent.model);
        if (agent.tools.length > 0) args.push("--tools", agent.tools.join(","));
        args.push("--append-system-prompt", promptFile, `Task: ${spec.prompt}`);
        // The transcript: opened before the child, appended chunk by chunk,
        // abandoned (and its name dropped from the outcome) at the first
        // write that fails.
        let transcript: string | undefined;
        let transcriptAt: string | null = null;
        if (opts.transcriptDir !== undefined) {
          try {
            const rel = transcriptFile(spec.id);
            const at = join(opts.transcriptDir, rel);
            const runDir = rel.includes("/") ? rel.slice(0, rel.indexOf("/")) : null;
            const fresh = runDir !== null && !existsSync(join(opts.transcriptDir, runDir));
            mkdirSync(dirname(at), { recursive: true });
            if (fresh) pruneTranscripts(opts.transcriptDir, TRANSCRIPT_RUNS_KEPT, runDir);
            writeFileSync(at, "", { mode: 0o600 });
            transcript = rel;
            transcriptAt = at;
          } catch {
            transcript = undefined;
          }
        }
        const keep = (chunk: string): void => {
          if (transcriptAt === null) return;
          try {
            appendFileSync(transcriptAt, chunk);
          } catch {
            transcriptAt = null;
            transcript = undefined;
          }
        };
        const withTranscript = <T extends CaseOutcome>(o: T): T =>
          transcript === undefined ? o : { ...o, transcript };
        return await new Promise<CaseOutcome>((resolve) => {
          let stderr = "";
          let buffer = "";
          const readout = caseReadout(opts.cwd, (c) => onCost?.(c));
          const onLine = (line: string): void => {
            try {
              readout.feed(JSON.parse(line));
            } catch {
              // Not an event: the stream is read line by line, noise skipped.
            }
          };
          let child: ReturnType<SpawnFn>;
          try {
            child = spawn(inv.command, args, {
              cwd: opts.cwd,
              env: leafEnv(opts.env),
              stdio: ["ignore", "pipe", "pipe"],
            });
          } catch (err) {
            resolve({
              ok: false,
              reason: `could not start pi: ${err instanceof Error ? err.message : String(err)}`,
              cost_usd: 0,
            });
            return;
          }
          const kill = (): void => {
            child.kill("SIGTERM");
            setTimeout(() => child.kill("SIGKILL"), CASE_STOP_GRACE_MS).unref();
          };
          signal.addEventListener("abort", kill, { once: true });
          child.stdout.on("data", (d: Buffer | string) => {
            keep(d.toString());
            buffer += d.toString();
            const lines = buffer.split("\n");
            buffer = lines.pop() ?? "";
            for (const l of lines) if (l.trim() !== "") onLine(l);
          });
          // The TAIL is kept: the cause of a failure is what pi printed last.
          child.stderr.on("data", (d: Buffer | string) => {
            stderr = (stderr + d.toString()).slice(-STDERR_TAIL_CHARS);
          });
          let settled = false;
          const finish = (outcome: CaseOutcome): void => {
            if (settled) return;
            settled = true;
            signal.removeEventListener("abort", kill);
            resolve(withTranscript(outcome));
          };
          // What a case that ended without an answer had spent: a failure
          // costs money too, and a caller holding a budget must count it.
          const spent = (): number | null => readout.spent();
          child.on("error", (err) =>
            finish({ ok: false, reason: `pi failed to run: ${err.message}`, cost_usd: spent() }),
          );
          child.on("close", (code) => {
            if (buffer.trim() !== "") onLine(buffer);
            if (signal.aborted) return finish({ ok: false, reason: "stopped", cost_usd: spent() });
            if (code !== 0) {
              const tail = stderrExcerpt(stderr);
              return finish({
                ok: false,
                reason: `pi exited ${code}${tail ? `: ${tail}` : ""}`,
                cost_usd: spent(),
              });
            }
            if (readout.failure !== null)
              return finish({ ok: false, reason: readout.failure, cost_usd: spent() });
            if (readout.final.trim() === "")
              return finish({
                ok: false,
                reason: "the subagent gave no answer",
                cost_usd: spent(),
              });
            finish({
              ok: true,
              output: readout.final,
              cost_usd: readout.spent(),
              reads: readout.reads,
            });
          });
        });
      } finally {
        rmSync(tmp, { recursive: true, force: true });
      }
    },
  };
}
