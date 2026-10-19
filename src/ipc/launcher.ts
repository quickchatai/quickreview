// The pane-side half of the launch-file handoff (D23).
//
// tmux does not pass file descriptors into a pane, so a takeover or debug pi
// is started as
//
//     node dist/src/ipc/launcher.js <launch-file> -- pi ...
//
// The launcher claims the launch file (opens it, unlinks it), then runs the
// command with the open fd as an inherited descriptor and QCR_IPC_CAP_FD set
// to its number. pi and the shims under it read the capability with pread, as
// anywhere else. The launch file's path is not a secret; the file is gone the
// moment this runs.
import { spawn } from "node:child_process";
import { closeSync } from "node:fs";
import { CAP_FD_INDEX, claimLaunchFile } from "./capability.js";

export async function runLauncher(
  argv: readonly string[],
  env: NodeJS.ProcessEnv = process.env,
): Promise<number> {
  const sep = argv.indexOf("--");
  const file = argv[0];
  const cmd = sep >= 0 ? argv.slice(sep + 1) : [];
  if (!file || sep !== 1 || cmd.length === 0) {
    process.stderr.write("usage: launcher <launch-file> -- <command> [args...]\n");
    return 2;
  }
  let fd: number;
  try {
    fd = claimLaunchFile(file);
  } catch (e) {
    process.stderr.write(`launcher: ${(e as Error).message}\n`);
    return 3;
  }
  const child = spawn(cmd[0]!, cmd.slice(1), {
    stdio: ["inherit", "inherit", "inherit", fd],
    env: { ...env, QCR_IPC_CAP_FD: String(CAP_FD_INDEX) },
  });
  closeSync(fd); // the child holds its own copy
  // The tty's SIGINT reaches the child directly; the launcher only outlives it.
  const ignore = (): void => {};
  const forward = (sig: NodeJS.Signals) => () => child.kill(sig);
  const relays: Array<[NodeJS.Signals, () => void]> = [
    ["SIGINT", ignore],
    ["SIGTERM", forward("SIGTERM")],
    ["SIGHUP", forward("SIGHUP")],
  ];
  for (const [sig, fn] of relays) process.on(sig, fn);
  try {
    return await new Promise<number>((resolve) => {
      child.on("error", (e) => {
        process.stderr.write(`launcher: ${e.message}\n`);
        resolve(127);
      });
      child.on("exit", (code, signal) => resolve(code ?? (signal ? 128 : 1)));
    });
  } finally {
    for (const [sig, fn] of relays) process.off(sig, fn);
  }
}

// Run only as the entry point, not when a test imports runLauncher.
if (process.argv[1]?.endsWith("launcher.js")) {
  void runLauncher(process.argv.slice(2)).then((code) => process.exit(code));
}
