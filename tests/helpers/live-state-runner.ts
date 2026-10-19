// An SshRunner over a directory standing in for the box's state: the three
// reads the transcript viewer makes (`cat`, `tail -c +N`, `ls -1` under
// <remote_state_dir>/live) answered from <root>/state/live. Records every argv,
// so a test can see exactly what was asked, over either transport.
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { TUI_DEFAULTS, type TuiConfig } from "../../src/config.js";
import type { RemoteResult, SshRunner } from "../../src/tui/remote.js";

const ok = (stdout: string | Buffer): RemoteResult => ({
  ok: true,
  stdout: stdout.toString("utf8"),
  stderr: "",
  code: 0,
});
const gone = (path: string): RemoteResult => ({
  ok: false,
  stdout: "",
  stderr: `${path}: No such file or directory`,
  code: 1,
});

export interface StateRunner {
  ssh: SshRunner;
  /** Every argv the runner was asked to run, in order. */
  calls: string[][];
}

/** `fallback` answers whatever is not a live read (status.json, capture-pane…). */
export function stateDirRunner(
  root: string,
  fallback: SshRunner = async () => ok(""),
  cfg: TuiConfig = TUI_DEFAULTS,
): StateRunner {
  const calls: string[][] = [];
  const local = (p: string): string => p.replace(cfg.remote_state_dir, join(root, "state"));
  const ssh: SshRunner = async (host, argv, opts) => {
    calls.push(argv);
    const at = argv.findIndex((a) => a === "cat" || a === "tail" || a === "ls");
    const cmd = at >= 0 ? argv.slice(at) : [];
    const path = cmd.at(-1) ?? "";
    if (!path.startsWith(`${cfg.remote_state_dir}/live`)) return fallback(host, argv, opts);
    try {
      if (cmd[0] === "cat") return ok(readFileSync(local(path)));
      if (cmd[0] === "tail") {
        const from = Number(/^\+(\d+)$/.exec(cmd[2] ?? "")?.[1]);
        return ok(readFileSync(local(path)).subarray(from - 1));
      }
      return ok(readdirSync(local(path)).join("\n") + "\n");
    } catch {
      return gone(path);
    }
  };
  return { ssh, calls };
}
