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
import { CASE_STOP_GRACE_MS } from "@quickchatai/pi-quickreview/src/casebudget.js";
import { spawn as nodeSpawn } from "node:child_process";
import {
  appendFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { homedir, tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { PI_PACKAGE, piCliPath } from "../picli.js";
import {
  STDERR_TAIL_CHARS,
  TRANSCRIPT_RUNS_KEPT,
  caseReadout as readoutIn,
  leafEnv as leafEnvOf,
  parseAgentFile,
  pruneTranscripts,
  resolvedReadPath as readPathIn,
  stderrExcerpt,
  transcriptFile,
  type AgentFile,
} from "@quickchatai/pi-quickreview/src/scan/caseread.js";
import type { CaseOutcome, CaseRunner, CaseSpec } from "./engine.js";

export { parseAgentFile, type AgentFile } from "@quickchatai/pi-quickreview/src/scan/caseread.js";
export {
  FILE_READ_TOOLS,
  TRANSCRIPT_RUNS_KEPT,
  pruneTranscripts,
  readPathOf,
  readSucceeded,
  stderrExcerpt,
  transcriptFile,
} from "@quickchatai/pi-quickreview/src/scan/caseread.js";

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
export const PI_PACKAGES: readonly string[] = [PI_PACKAGE, "@mariozechner/pi-coding-agent"];

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
 * VERIFY-ON-PIN (0.87.1, re-read at 0.99.1, 1.0.0, 1.3.0 and 1.4.0 — bin still dist/bundle/cli.js): pi's entry is a `bin` of its package, run by node. */
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

/** The file a read of `raw` opened, for a child running in `cwd`
 * (caseread.ts `resolvedReadPath`), `~` taken as this process's home unless
 * told otherwise. */
export function resolvedReadPath(raw: string, cwd: string, home: string = homedir()): string {
  return readPathIn(raw, cwd, home);
}

/** What one case's event stream says (caseread.ts `caseReadout`), a read's
 * `~` taken as this process's home. */
export function caseReadout(
  cwd: string,
  onCost?: (spentSoFar: number) => void,
): ReturnType<typeof readoutIn> {
  return readoutIn(cwd, homedir(), onCost);
}

/** The env one leaf's pi starts with (caseread.ts `leafEnv`): `source`, this
 * process's env unless told otherwise, filtered to the allowlist. */
export function leafEnv(source: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  return leafEnvOf(source);
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
 * VERIFY-ON-PIN (0.87.1, re-read at 0.99.1, 1.0.0, 1.3.0 and 1.4.0: examples/extensions/subagent the same but for its read-range rendering, CLI flag set identical but for the added --no-mcp; read from the published examples/extensions/subagent
 * and dist/cli/args.js): the argv spelling, `--no-extensions`/`--approve`,
 * and the `message_end` event carrying `message.usage.cost.total`.
 */
export function piCaseRunner(opts: {
  agentsDir: string;
  cwd: string;
  /** Where each case's event stream is kept; absent, none is. */
  transcriptDir?: string;
  /** The production tree holding packages/pi-plugin/extensions/bash-guard.ts. Omitted: `cwd`
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
