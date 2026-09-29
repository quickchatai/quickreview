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
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
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

/** How to start pi from inside pi: the running script under the running
 * runtime when there is one (the native subagent extension's rule), else
 * `pi` on the PATH. */
export function piInvocation(): { command: string; prefix: string[] } {
  const script = process.argv[1];
  if (script && !script.startsWith("/$bunfs/") && existsSync(script)) {
    return { command: process.execPath, prefix: [script] };
  }
  return { command: "pi", prefix: [] };
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
 * per-message accounting summed (null when it reported none). An abort kills
 * the child (TERM, then KILL). Every outcome resolves.
 *
 * VERIFY-ON-PIN (0.87.1, read from the published examples/extensions/subagent
 * and dist/cli/args.js): the argv spelling, `--no-extensions`/`--approve`,
 * and the `message_end` event carrying `message.usage.cost.total`.
 */
export function piCaseRunner(opts: {
  agentsDir: string;
  cwd: string;
  spawn?: SpawnFn;
  invocation?: { command: string; prefix: string[] };
}): CaseRunner {
  const spawn = opts.spawn ?? (nodeSpawn as unknown as SpawnFn);
  return {
    run: async (spec: CaseSpec, signal: AbortSignal): Promise<CaseOutcome> => {
      if (!/^[a-z][a-z0-9-]*$/.test(spec.agent)) return { ok: false, reason: `not an agent name: ${JSON.stringify(spec.agent)}` };
      let agent: AgentFile | null;
      try {
        agent = parseAgentFile(readFileSync(join(opts.agentsDir, `${spec.agent}.md`), "utf8"));
      } catch {
        return { ok: false, reason: `no agent ${spec.agent} in ${opts.agentsDir}` };
      }
      if (agent === null || agent.name !== spec.agent) return { ok: false, reason: `${spec.agent}.md is not an agent file` };
      if (signal.aborted) return { ok: false, reason: "stopped before it started" };

      const tmp = mkdtempSync(join(tmpdir(), "qcr-case-"));
      try {
        const promptFile = join(tmp, `${spec.agent}.md`);
        writeFileSync(promptFile, agent.systemPrompt, { mode: 0o600 });
        const inv = opts.invocation ?? piInvocation();
        const args = [...inv.prefix, "--mode", "json", "-p", "--no-session", "--no-extensions", "--approve"];
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
          const onLine = (line: string): void => {
            let event: { type?: string; message?: Record<string, unknown> };
            try {
              event = JSON.parse(line) as typeof event;
            } catch {
              return;
            }
            const msg = event.message;
            if (event.type !== "message_end" || !msg || msg.role !== "assistant") return;
            const usage = msg.usage as { cost?: { total?: unknown } } | undefined;
            if (typeof usage?.cost?.total === "number") {
              cost += usage.cost.total;
              priced = true;
            }
            const parts = Array.isArray(msg.content) ? (msg.content as Array<{ type?: string; text?: string }>) : [];
            const text = parts.filter((p) => p.type === "text" && typeof p.text === "string").map((p) => p.text).join("\n");
            if (text.trim() !== "") final = text;
            if (msg.stopReason === "error" || msg.stopReason === "aborted") {
              failure = typeof msg.errorMessage === "string" ? msg.errorMessage : `the model stopped: ${String(msg.stopReason)}`;
            } else {
              failure = null;
            }
          };
          let child: ReturnType<SpawnFn>;
          try {
            child = spawn(inv.command, args, { cwd: opts.cwd, stdio: ["ignore", "pipe", "pipe"] });
          } catch (err) {
            resolve({ ok: false, reason: `could not start pi: ${err instanceof Error ? err.message : String(err)}` });
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
          child.on("error", (err) => finish({ ok: false, reason: `pi failed to run: ${err.message}` }));
          child.on("close", (code) => {
            if (buffer.trim() !== "") onLine(buffer);
            if (signal.aborted) return finish({ ok: false, reason: "stopped" });
            if (code !== 0) {
              const tail = stderr.trim().split("\n").slice(-3).join(" / ");
              return finish({ ok: false, reason: `pi exited ${code}${tail ? `: ${tail}` : ""}` });
            }
            if (failure !== null) return finish({ ok: false, reason: failure });
            if (final.trim() === "") return finish({ ok: false, reason: "the subagent gave no answer" });
            finish({ ok: true, output: final, cost_usd: priced ? cost : null });
          });
        });
      } finally {
        rmSync(tmp, { recursive: true, force: true });
      }
    },
  };
}
