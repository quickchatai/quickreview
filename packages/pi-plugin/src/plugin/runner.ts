// The plugin's way to run a program: a PATH lookup over the env it is given,
// and a child that the command's stop kills. Output is collected whole; the
// programs it runs (qcr, git, gh, npm) answer in one object or a few lines.
import { spawn } from "node:child_process";
import { accessSync, constants, statSync } from "node:fs";
import { delimiter, isAbsolute, join } from "node:path";
import type { Runner, RunResult } from "./session.js";

/** The first executable `cmd` on `path` (a PATH value); null when none. */
export function whichOn(cmd: string, path: string | undefined): string | null {
  if (isAbsolute(cmd)) return executable(cmd) ? cmd : null;
  for (const dir of (path ?? "").split(delimiter)) {
    if (dir === "") continue;
    const file = join(dir, cmd);
    if (executable(file)) return file;
  }
  return null;
}

function executable(file: string): boolean {
  try {
    if (!statSync(file).isFile()) return false;
    accessSync(file, constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

/** A Runner over node's child_process, looking programs up on `env.PATH`. */
export function nodeRunner(env: Readonly<Record<string, string | undefined>>): Runner {
  return {
    which: (cmd) => whichOn(cmd, env["PATH"]),
    run: (cmd, args, o) =>
      new Promise<RunResult>((done) => {
        let stdout = "";
        let stderr = "";
        let settled = false;
        const finish = (r: RunResult): void => {
          if (settled) return;
          settled = true;
          o.signal?.removeEventListener("abort", kill);
          done(r);
        };
        const child = spawn(cmd, [...args], {
          cwd: o.cwd,
          env: { ...(o.env ?? env) },
          stdio: ["ignore", "pipe", "pipe"],
        });
        const kill = (): void => {
          child.kill("SIGTERM");
        };
        if (o.signal?.aborted) kill();
        else o.signal?.addEventListener("abort", kill, { once: true });
        child.stdout.on("data", (d: Buffer) => (stdout += d.toString()));
        child.stderr.on("data", (d: Buffer) => (stderr += d.toString()));
        child.on("error", (err) => finish({ code: 127, stdout, stderr: stderr + String(err) }));
        child.on("close", (code) => finish({ code: code ?? 1, stdout, stderr }));
      }),
  };
}
