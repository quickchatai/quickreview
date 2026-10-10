// Durable local deploy process. The deploy itself rebuilds dist/, and project
// policy requires that build to re-exec the TUI immediately. Therefore the
// deploy child is detached and identified by a durable run id; every new TUI
// generation attaches to the same log/result instead of starting a second
// deploy or declaring the expected reload a failure.
import {
  closeSync,
  existsSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { uptime } from "node:os";
import { join } from "node:path";
import { spawn } from "node:child_process";

export interface DurableDeployHandle {
  kill(): void;
}

interface Marker {
  pid: number;
  started_at: string;
  state?: "starting" | "running";
}
interface Result {
  code: number | null;
  signal?: string | null;
  error?: string;
}

export class DurableDeployProcess {
  constructor(
    private readonly root: string,
    private readonly stateDir = join(root, "state", "tui-deploy-runs"),
    private readonly pollMs = 250,
    private readonly startupLeaseMs = 5_000,
  ) {}

  startOrAttach(
    runId: string,
    onData: (chunk: string) => void,
    onExit: (code: number | null) => void,
  ): DurableDeployHandle {
    if (!/^[A-Za-z0-9._-]{8,120}$/.test(runId)) {
      queueMicrotask(() => {
        onData("invalid durable deploy run id\n");
        onExit(1);
      });
      return { kill: () => {} };
    }
    mkdirSync(this.stateDir, { recursive: true });
    const markerPath = join(this.stateDir, `${runId}.started.json`);
    const logPath = join(this.stateDir, `${runId}.log`);
    const resultPath = join(this.stateDir, `${runId}.result.json`);
    let marker = this.readMarker(markerPath);

    if (!marker && !existsSync(resultPath)) {
      // O_EXCL is the one-start gate across TUI generations. The log exists
      // before the detached child, so an immediate re-exec can still attach.
      let markerFd: number | undefined;
      try {
        markerFd = openSync(markerPath, "wx", 0o600);
      } catch {
        marker = this.readMarker(markerPath);
      }
      if (markerFd !== undefined) {
        const startedAt = new Date().toISOString();
        // The marker is valid BEFORE spawn. If this process dies in the tiny
        // startup window, a later attach times out the `starting` lease and
        // fails visibly instead of polling forever or duplicating the run.
        writeFileSync(
          markerFd,
          `${JSON.stringify({ pid: 0, started_at: startedAt, state: "starting" })}\n`,
        );
        closeSync(markerFd);
        closeSync(openSync(logPath, "a", 0o600));
        const child = spawn(
          process.execPath,
          [join(this.root, "scripts", "tui-deploy-runner.mjs"), this.root, logPath, resultPath],
          {
            cwd: this.root,
            detached: true,
            stdio: "ignore",
          },
        );
        if (child.pid) {
          marker = { pid: child.pid, started_at: startedAt, state: "running" };
          const tmp = `${markerPath}.tmp-${process.pid}`;
          writeFileSync(tmp, `${JSON.stringify(marker)}\n`, { mode: 0o600 });
          renameSync(tmp, markerPath);
          child.unref();
        } else {
          this.writeFailure(resultPath, "detached deploy runner returned no pid");
        }
        child.on("error", (err) => this.writeFailure(resultPath, String(err)));
      }
    }

    let offset = 0;
    let done = false;
    const pump = (): void => {
      if (done) return;
      try {
        const text = readFileSync(logPath, "utf8");
        if (text.length > offset) {
          onData(text.slice(offset));
          offset = text.length;
        }
      } catch {
        // The detached child may not have opened its log yet.
      }
      const finishWith = (result: Result): void => {
        done = true;
        clearInterval(timer);
        if (result.error) onData(`\ndeploy runner error: ${result.error}\n`);
        onExit(result.code);
      };
      const result = this.readResult(resultPath);
      if (result) {
        finishWith(result);
        return;
      }
      const current = this.readMarker(markerPath);
      if (current && current.pid > 0 && !this.runnerAlive(current)) {
        // The runner writes its result before it exits, so a result that
        // landed between the read above and the liveness check wins.
        const late = this.readResult(resultPath);
        if (late) {
          finishWith(late);
          return;
        }
        const error = "detached deploy runner exited without a result; drain remains on";
        this.writeFailure(resultPath, error);
        finishWith(this.readResult(resultPath) ?? { code: 1, error });
        return;
      }
      let malformedMarkerStale = false;
      if (!current && existsSync(markerPath)) {
        try {
          malformedMarkerStale = Date.now() - statSync(markerPath).mtimeMs > this.startupLeaseMs;
        } catch {
          /* raced a writer; the next pump decides */
        }
      }
      if (
        (current?.pid === 0 && Date.now() - Date.parse(current.started_at) > this.startupLeaseMs) ||
        malformedMarkerStale
      ) {
        done = true;
        clearInterval(timer);
        onData("\ndetached deploy runner never started; drain remains on\n");
        onExit(1);
      }
    };
    const timer = setInterval(pump, this.pollMs);
    timer.unref?.();
    queueMicrotask(pump);

    return {
      kill: () => {
        const current = this.readMarker(markerPath) ?? marker;
        if (!current || current.pid <= 0) return;
        try {
          process.kill(-current.pid, "SIGTERM");
        } catch {
          try {
            process.kill(current.pid, "SIGTERM");
          } catch {
            /* already gone */
          }
        }
      },
    };
  }

  // A runner started before the last boot is gone whatever now holds its
  // pid. Otherwise the run lives while anything in its process group does
  // (the runner leads it, and deploy.sh outlives a runner killed outright),
  // and signal 0 answers that without signalling (EPERM: it exists).
  private runnerAlive(marker: Marker): boolean {
    const started = Date.parse(marker.started_at);
    if (Number.isFinite(started) && started < Date.now() - uptime() * 1000) return false;
    for (const target of [-marker.pid, marker.pid]) {
      try {
        process.kill(target, 0);
        return true;
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code === "EPERM") return true;
      }
    }
    return false;
  }

  private readMarker(path: string): Marker | undefined {
    try {
      const value = JSON.parse(readFileSync(path, "utf8")) as Partial<Marker>;
      return Number.isInteger(value.pid) &&
        (value.pid ?? -1) >= 0 &&
        typeof value.started_at === "string"
        ? (value as Marker)
        : undefined;
    } catch {
      return undefined;
    }
  }

  private writeFailure(path: string, error: string): void {
    if (existsSync(path)) return;
    const tmp = `${path}.tmp-${process.pid}`;
    try {
      writeFileSync(
        tmp,
        `${JSON.stringify({ code: 1, error, finished_at: new Date().toISOString() })}\n`,
        { mode: 0o600 },
      );
      renameSync(tmp, path);
    } catch {
      // The startup lease remains the bounded fallback if even the result
      // write fails.
    }
  }

  private readResult(path: string): Result | undefined {
    try {
      const value = JSON.parse(readFileSync(path, "utf8")) as Partial<Result>;
      return value.code === null || (typeof value.code === "number" && Number.isInteger(value.code))
        ? (value as Result)
        : undefined;
    } catch {
      return undefined;
    }
  }
}
