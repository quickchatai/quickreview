// A FAKE host for the managers that start a pi in tmux (the takeover lease, P8.13, and
// the bot's debug round, P8.13b): tmux sessions, pids with start times and process
// groups, signals that kill (or are ignored, or cannot kill), and a clock that the
// test moves. The managers' state store, leases, capabilities and launch files are the
// real ones. No pi, no model, no network.
import type { ProcView, SignalFn } from "../../src/workerlease.js";
import type { ExecFn } from "../../src/tmux.js";

interface FakeProc {
  alive: boolean;
  start: string;
  pgid: number;
  /** Ignores the hangup and the TERM: only a KILL ends it. */
  stubborn: boolean;
  /** Survives even a KILL (uninterruptible sleep). */
  immortal: boolean;
  session: string;
}

export class FakePaneHost {
  sessions = new Map<string, { pid: number; cmd: string[]; cwd: string | undefined }>();
  procs = new Map<number, FakeProc>();
  activity = new Map<string, number>();
  clock = Date.parse("2026-10-19T09:00:00.000Z");
  nextPid = 4000;
  /** The next pi started ignores the hangup and the TERM. */
  stubbornNext = false;
  immortalNext = false;
  /** tmux refuses the next new-session. */
  failNewSession = false;
  signals: Array<[number, string]> = [];

  readonly exec: ExecFn = async (_cmd, args) => {
    const name = (flag: string): string =>
      (args[args.indexOf(flag) + 1] ?? "").replace(/^=|:$/g, "");
    switch (args[0]) {
      case "new-session": {
        if (this.failNewSession) return { code: 1, stdout: "", stderr: "tmux: no space" };
        const session = name("-s");
        const cwdAt = args.indexOf("-c");
        const rest = args.slice(cwdAt >= 0 ? cwdAt + 2 : args.indexOf("-s") + 2);
        const pid = this.nextPid++;
        this.sessions.set(session, {
          pid,
          cmd: rest,
          cwd: cwdAt >= 0 ? args[cwdAt + 1] : undefined,
        });
        this.procs.set(pid, {
          alive: true,
          start: String(1000 + pid),
          pgid: pid,
          stubborn: this.stubbornNext || this.immortalNext,
          immortal: this.immortalNext,
          session,
        });
        this.stubbornNext = false;
        this.immortalNext = false;
        return { code: 0, stdout: "", stderr: "" };
      }
      case "kill-session": {
        const session = name("-t");
        const s = this.sessions.get(session);
        if (s) {
          const p = this.procs.get(s.pid)!;
          if (!p.stubborn) this.die(s.pid);
        }
        return { code: 0, stdout: "", stderr: "" };
      }
      case "list-sessions":
        return this.sessions.size === 0
          ? { code: 1, stdout: "", stderr: "no server running on /tmp/tmux-0/default" }
          : { code: 0, stdout: [...this.sessions.keys()].join("\n") + "\n", stderr: "" };
      case "has-session":
        return { code: this.sessions.has(name("-t")) ? 0 : 1, stdout: "", stderr: "" };
      case "list-panes": {
        const s = this.sessions.get(name("-t"));
        return s
          ? { code: 0, stdout: `${s.pid}\n`, stderr: "" }
          : { code: 1, stdout: "", stderr: "" };
      }
      case "display-message": {
        const at = this.activity.get(name("-t"));
        return at === undefined
          ? { code: 0, stdout: "\n", stderr: "" }
          : { code: 0, stdout: `${Math.floor(at / 1000)}\n`, stderr: "" };
      }
      default:
        return { code: 1, stdout: "", stderr: `unscripted tmux ${args[0]}` };
    }
  };

  die(pid: number): void {
    const p = this.procs.get(pid);
    if (!p) return;
    p.alive = false;
    this.sessions.delete(p.session);
  }

  readonly proc: ProcView = {
    identity: (pid) => {
      const p = this.procs.get(pid);
      return p?.alive ? { start: p.start, pgid: p.pgid } : undefined;
    },
    members: (pgid) =>
      [...this.procs.entries()]
        .filter(([, p]) => p.alive && p.pgid === pgid)
        .map(([pid, p]) => ({ pid, start: p.start })),
    bootId: () => "boot-1/ctr-1",
  };

  readonly signal: SignalFn = (target, sig) => {
    this.signals.push([target, sig]);
    const group = target < 0;
    let hit = false;
    for (const [pid, p] of this.procs) {
      if (!p.alive || (group ? p.pgid !== -target : pid !== target)) continue;
      hit = true;
      if (p.immortal) continue;
      if (sig === "SIGKILL" || (sig === "SIGTERM" && !p.stubborn)) this.die(pid);
    }
    return hit ? "sent" : "gone";
  };

  alivePis(): number {
    return [...this.procs.values()].filter((p) => p.alive).length;
  }
}
