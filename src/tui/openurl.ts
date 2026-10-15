// Open a URL in the operator's browser, detached. A launcher that cannot be
// spawned (xdg-open missing, ENOENT) emits 'error' on the ChildProcess; left
// unhandled that is an uncaughtException, and the TUI's handler exits — so
// a failed browser launch is reported, never fatal to the board. A launcher
// that starts and then exits non-zero (xdg-open with no handler for the URL)
// is reported too: the caller's "opened" notice must not stand alone.
import { spawn } from "node:child_process";

export function openUrlDetached(
  url: string,
  onError: (message: string) => void,
  launcher = "xdg-open",
): void {
  const child = spawn(launcher, [url], { detached: true, stdio: "ignore" });
  child.on("error", (err) => onError(`✖ could not open ${url} — ${launcher}: ${err.message}`));
  child.on("exit", (code) => {
    if (code !== null && code !== 0)
      onError(`✖ could not open ${url} — ${launcher} exited with code ${code}`);
  });
  child.unref();
}
