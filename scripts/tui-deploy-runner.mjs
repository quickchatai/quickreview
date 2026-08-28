#!/usr/bin/env node
// Detached child for the TUI deploy tab. deploy.sh rebuilds dist/, which
// intentionally re-execs the TUI; this process must outlive that re-exec and
// leave a durable result the new TUI generation can attach to.
import { closeSync, fsyncSync, mkdirSync, openSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { spawn } from "node:child_process";

const [root, logPath, resultPath] = process.argv.slice(2);
if (!root || !logPath || !resultPath) process.exit(2);
mkdirSync(dirname(logPath), { recursive: true });
const logFd = openSync(logPath, "a", 0o600);
const child = spawn("bash", [join(root, "scripts", "deploy.sh"), "sync"], {
  cwd: root,
  env: { ...process.env, ANSIBLE_FORCE_COLOR: "0", PY_COLORS: "0", NO_COLOR: "1" },
  stdio: ["ignore", logFd, logFd],
});

let stopping = false;
const stop = () => {
  if (stopping) return;
  stopping = true;
  try { child.kill("SIGTERM"); } catch { /* already gone */ }
};
process.on("SIGTERM", stop);
process.on("SIGINT", stop);

let finished = false;
const finish = (code, signal, error) => {
  if (finished) return;
  finished = true;
  closeSync(logFd);
  const result = {
    code: typeof code === "number" ? code : null,
    signal: signal ?? null,
    ...(error ? { error: String(error) } : {}),
    finished_at: new Date().toISOString(),
  };
  const tmp = `${resultPath}.tmp-${process.pid}`;
  const fd = openSync(tmp, "w", 0o600);
  writeFileSync(fd, `${JSON.stringify(result, null, 2)}\n`);
  fsyncSync(fd);
  closeSync(fd);
  renameSync(tmp, resultPath);
};

child.on("error", (err) => {
  finish(1, null, err);
  process.exit(1);
});
child.on("close", (code, signal) => {
  finish(code, signal);
  process.exit(typeof code === "number" ? code : 1);
});
