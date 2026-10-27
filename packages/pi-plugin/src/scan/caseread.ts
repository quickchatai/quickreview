// What a scan case's leaf answers, read the same way whichever host ran it:
// the agent file it runs from, the event stream it emits (its answer, its
// cost, the files it opened), the env it may inherit and where its transcript
// is kept. The pi child (caserunner.ts `piCaseRunner`) and the in-process SDK
// session both read through these, so a case answers identically on either.
import { readdirSync, rmSync, statSync } from "node:fs";
import { join, posix } from "node:path";
import { fileURLToPath } from "node:url";
import { GITHUB_TOKEN_ENVS } from "../envstrip.js";

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
export function resolvedReadPath(raw: string, cwd: string, home: string): string {
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
  /** The user's home, which a read's `~` expands against. */
  home: string,
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
        attempted.set(event.toolCallId, resolvedReadPath(read, cwd, home));
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
 * credential (packages/pi-plugin/src/envstrip.ts) and nothing else of the driver's reaches it. */
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
export function leafEnv(source: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
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
export const STDERR_TAIL_CHARS = 4000;

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
