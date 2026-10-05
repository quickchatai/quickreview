// The case runner: SetupEngine's `CaseRunner` port, for real —
// one case as one background pi subagent inside the COMPANION container.
//
// This is the only file under src/setup/ that spawns pi, and it is kept apart
// on purpose: the single-shepherd fence (tests/single-shepherd.test.ts S2)
// allows it by path, like the companion's own argv and the bench runner. It
// is not a daemon module — nothing the daemon loads imports src/setup/ (that
// fence checks it too) — and what it spawns is a LEAF: `-p --no-session
// --no-extensions`, read-only tools, no memory, no fan-out (root rule 9 is
// unchanged: no new session kind, nothing on the VM).
import { spawn as nodeSpawn } from "node:child_process";
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { homedir, tmpdir } from "node:os";
import { dirname, join, posix, resolve } from "node:path";
import { fileURLToPath } from "node:url";
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
  opts: { cwd: string; stdio: ["ignore", "pipe", "pipe"] },
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
  "@earendil-works/pi-coding-agent",
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

/** How to start pi. When the running process IS pi (argv[1] is verifiably
 * pi's CLI entry — the native subagent extension's rule) it reuses that
 * script under the running runtime; any other host — a node driver, a test,
 * the TUI — gets `pi` on the PATH. The old rule reused argv[1] whenever the
 * file merely existed, so every non-pi host spawned ITSELF for every scan
 * case. A bun-compiled pi (`/$bunfs/…`) also falls back to the PATH.
 * VERIFY-ON-PIN (0.87.1, re-read at 0.99.1 and 1.0.0 — bin still dist/bundle/cli.js): pi's entry is a `bin` of its package, run by node. */
export function piInvocation(
  host: { argv1: string | undefined; execPath: string } = {
    argv1: process.argv[1],
    execPath: process.execPath,
  },
): { command: string; prefix: string[] } {
  const script = host.argv1;
  if (script && !script.startsWith("/$bunfs/") && isPiCliEntry(script)) {
    return { command: host.execPath, prefix: [script] };
  }
  return { command: "pi", prefix: [] };
}

/** The tools whose `path` argument names content the model READ. `find` and
 * `ls` list names and read no content, so they are not reads. */
export const FILE_READ_TOOLS: readonly string[] = ["read", "grep"];

/** The path a `tool_execution_start` event says the model read, or null.
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

/** The file a read of `raw` opened, for a child running in `cwd` — pi's own
 * resolution (`resolveToCwd`): one leading `@` stripped, `~` expanded, a
 * relative path taken against the CHILD's cwd, `.`/`..` collapsed. The scan
 * judges what the lens opened, not how it spelled it: the child runs in the
 * app root, not the scanned tree, so a relative `api/x.py` opened the app
 * root's copy — another repository, or this checkout at HEAD — and must not
 * pass for a read of the tree (scan-loop).
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

/**
 * Runs a case as ONE background pi subagent, the way pi's own subagent
 * extension runs a child: `pi --mode json -p --no-session` with the agent's
 * model, its tools and its body as the appended system prompt, the task as
 * the message — plus `--no-extensions` (a leaf loads nothing, so it can
 * neither fan out nor reach memory) and `--approve` (the no-stall rule: a
 * child never waits on a trust modal). The child runs in `cwd`, first-party
 * ground, NEVER in the reviewed checkout, whose `.pi/` config must not load
 * (extensions/subagents.ts reason 3); it reads the checkout by absolute path.
 *
 * The answer is the last assistant message's text; the cost is pi's own
 * per-message accounting summed (null when it reported none); `reads` is
 * every path its `read`/`grep` calls named (`readPathOf`), resolved to the
 * file that call opened (`resolvedReadPath`, against `cwd`) — the scan's
 * evidence that the lens opened ITS files at all. The task string names
 * every file by its absolute tree path for the same reason. An abort kills
 * the child (TERM, then KILL). Every outcome resolves.
 *
 * VERIFY-ON-PIN (0.87.1, re-read at 0.99.1 and 1.0.0: examples/extensions/subagent byte-identical, CLI flag set identical; read from the published examples/extensions/subagent
 * and dist/cli/args.js): the argv spelling, `--no-extensions`/`--approve`,
 * and the `message_end` event carrying `message.usage.cost.total`.
 */
export function piCaseRunner(opts: {
  agentsDir: string;
  cwd: string;
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

      const tmp = mkdtempSync(join(tmpdir(), "qcr-case-"));
      try {
        const promptFile = join(tmp, `${spec.agent}.md`);
        writeFileSync(promptFile, agent.systemPrompt, { mode: 0o600 });
        const inv = opts.invocation ?? piInvocation();
        const args = [
          ...inv.prefix,
          "--mode",
          "json",
          "-p",
          "--no-session",
          "--no-extensions",
          "--approve",
        ];
        if (agent.model) args.push("--model", agent.model);
        if (agent.tools.length > 0) args.push("--tools", agent.tools.join(","));
        args.push("--append-system-prompt", promptFile, `Task: ${spec.prompt}`);
        return await new Promise<CaseOutcome>((resolve) => {
          let final = "";
          let cost = 0;
          let priced = false;
          let failure: string | null = null;
          let stderr = "";
          let buffer = "";
          const reads: string[] = [];
          const onLine = (line: string): void => {
            let event: {
              type?: string;
              message?: Record<string, unknown>;
              toolName?: unknown;
              args?: unknown;
            };
            try {
              event = JSON.parse(line) as typeof event;
            } catch {
              return;
            }
            const read = readPathOf(event);
            if (read !== null) reads.push(resolvedReadPath(read, opts.cwd));
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
          };
          let child: ReturnType<SpawnFn>;
          try {
            child = spawn(inv.command, args, { cwd: opts.cwd, stdio: ["ignore", "pipe", "pipe"] });
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
            setTimeout(() => child.kill("SIGKILL"), 5000).unref();
          };
          signal.addEventListener("abort", kill, { once: true });
          child.stdout.on("data", (d: Buffer | string) => {
            buffer += d.toString();
            const lines = buffer.split("\n");
            buffer = lines.pop() ?? "";
            for (const l of lines) if (l.trim() !== "") onLine(l);
          });
          child.stderr.on("data", (d: Buffer | string) => {
            if (stderr.length < 4000) stderr += d.toString();
          });
          let settled = false;
          const finish = (outcome: CaseOutcome): void => {
            if (settled) return;
            settled = true;
            signal.removeEventListener("abort", kill);
            resolve(outcome);
          };
          // What a case that ended without an answer had spent: a failure
          // costs money too, and a caller holding a budget must count it.
          const spent = (): number | null => (priced ? cost : null);
          child.on("error", (err) =>
            finish({ ok: false, reason: `pi failed to run: ${err.message}`, cost_usd: spent() }),
          );
          child.on("close", (code) => {
            if (buffer.trim() !== "") onLine(buffer);
            if (signal.aborted) return finish({ ok: false, reason: "stopped", cost_usd: spent() });
            if (code !== 0) {
              const tail = stderr.trim().split("\n").slice(-3).join(" / ");
              return finish({
                ok: false,
                reason: `pi exited ${code}${tail ? `: ${tail}` : ""}`,
                cost_usd: spent(),
              });
            }
            if (failure !== null) return finish({ ok: false, reason: failure, cost_usd: spent() });
            if (final.trim() === "")
              return finish({
                ok: false,
                reason: "the subagent gave no answer",
                cost_usd: spent(),
              });
            finish({ ok: true, output: final, cost_usd: priced ? cost : null, reads });
          });
        });
      } finally {
        rmSync(tmp, { recursive: true, force: true });
      }
    },
  };
}
