// Remote access layer for qcr tui — every VM touch goes through here, and
// every command it can produce is read-only against the box except the
// user-initiated writes (attach keystrokes ride a pty in attach.ts; inject
// files in msg.ts; and `sendKeysArgv` types into the board's focused pi
// pane). Rubric proposals do NOT ride this runner any more: they are LOCAL
// state/rubric/ dirs (companion-authored) handled by fs in proposals.ts.
// Memory edits do NOT ride it either: the TUI talks HTTP to
// OpenViking over the memory forward's loopback listener — see
// src/tui/memory.ts.
// None of them touch GitHub mutations, so none go near the gate (the
// proposals pane's gh reads are reads — direct per the gate rules).
// Command construction is pure so tests can assert the exact argv; execution
// is one injectable runner.
import { spawn } from "node:child_process";
import { StringDecoder } from "node:string_decoder";
import type { TuiConfig } from "../config.js";

export interface RemoteResult {
  ok: boolean;
  stdout: string;
  stderr: string;
  code: number | null;
}

/** Runs `ssh <host> <argv…>`. Injectable — tests never spawn.
 *
 * this is the TUI's ONE remote-runner interface, and it now has two
 * implementations — `realSshRunner` (the VM topology) and
 * `realLocalCommandRunner` (the laptop topology: the same argv runs on THIS
 * machine, `host` ignored, no ssh anywhere). `runnerFor(cfg)` picks; callers
 * keep calling `ssh(cfg.ssh_host, someArgv(cfg))` untouched. */
export type SshRunner = (host: string, argv: string[], opts?: { stdin?: string; timeoutMs?: number }) => Promise<RemoteResult>;

/**: transport of every TUI remote op. Driven by the explicit
 * `[tui] target` knob ONLY — never inferred from ssh_host's value. */
export type Transport = "ssh" | "local";

export function transportOf(cfg: TuiConfig): Transport {
  return cfg.target === "local" ? "local" : "ssh";
}

function dockerPrefix(cfg: TuiConfig): string[] {
  return [...(cfg.sudo_docker ? ["sudo"] : []), "docker", "exec"];
}

/** `cat status.json` on the host — the state volume is host-mounted, no docker. */
export function statusArgv(cfg: TuiConfig): string[] {
  return ["cat", `${cfg.remote_state_dir}/status.json`];
}

/** In-container `qcr why <n> --json`. */
export function whyArgv(cfg: TuiConfig, pr: number): string[] {
  return [...dockerPrefix(cfg), cfg.container, "node", "dist/src/cli.js", "why", String(pr), "--json"];
}

/**
 * The selected PR's ephemeral parent/lens activity. Like status.json this is
 * on the host-mounted state volume, so the hot path is one read-only cat — no
 * container exec and, importantly, no repeated GitHub enrichment fetch.
 */
export function progressArgv(cfg: TuiConfig, pr: number): string[] {
  return ["cat", `${cfg.remote_state_dir}/round-progress/pr-${pr}.json`];
}

/** In-container `qcr events --tail <k> --json`. */
export function eventsArgv(cfg: TuiConfig, tail: number): string[] {
  return [...dockerPrefix(cfg), cfg.container, "node", "dist/src/cli.js", "events", "--tail", String(tail), "--json"];
}

/** In-container `qcr today --json` (digest tab's spend/rounds source). */
export function todayArgv(cfg: TuiConfig): string[] {
  return [...dockerPrefix(cfg), cfg.container, "node", "dist/src/cli.js", "today", "--json"];
}

/** In-container `qcr metrics --json` (the metrics tab's aggregate source). */
export function metricsArgv(cfg: TuiConfig): string[] {
  return [...dockerPrefix(cfg), cfg.container, "node", "dist/src/cli.js", "metrics", "--json"];
}

/** In-container `qcr metrics --pr <n> --json` (the per-PR timeline). */
export function metricsPrArgv(cfg: TuiConfig, pr: number): string[] {
  return [...dockerPrefix(cfg), cfg.container, "node", "dist/src/cli.js", "metrics", "--pr", String(pr), "--json"];
}

/**
 * How much scrollback a capture should reach for, expressed the way tmux
 * numbers pane lines: `0` is the first line of the *visible* pane and negative
 * numbers walk up into the history buffer.
 *
 * `startBack: n` → `-S -n` (start n lines above the top of the visible pane).
 * `endBack: m`   → `-E -m` (stop m lines above the top of the visible pane).
 *
 * The mirror only ever sets `startBack`: the pane's own height on the VM is not
 * knowable client-side, so an `-E` would have to guess where the bottom is.
 * Leaving `-E` off means the capture always runs through the bottom of the
 * visible pane, and the scrollback offset is applied board-side by dropping
 * that many lines off the tail (see `piBody`). `endBack` exists so the shape is
 * expressible (and tested) for callers that do know both edges.
 */
export interface CaptureRange {
  startBack: number;
  endBack?: number;
}

/**
 * Non-interactive snapshot of a live pi session for the board's mirror pane:
 * `-e` keeps the pane's colors, `-p` writes to stdout, `-J` joins wrapped
 * lines. Reads only — writing into the pane is `sendKeysArgv`.
 *
 * `size` prepends a `resize-window`, in the SAME tmux invocation, so the
 * capture can never race an asynchronous resize. A session the daemon created
 * detached sits at tmux's 80×24 default forever (verified on the VM: a fresh
 * detached session reports `80x24 window-size=latest`), so pi wraps its output
 * at 80 columns however wide the board paints the mirror — the text crowds into
 * the left of the pane and a selection drawn over the empty remainder picks up
 * nothing. Handing tmux the painted rectangle makes pi lay itself out for the
 * space its capture is rendered in.
 *
 * `resize-window -x/-y` flips the window's `window-size` option to `manual`,
 * which is why `attachArgv` puts it back to `latest` — see there.
 */
export function captureArgv(cfg: TuiConfig, session: string, range?: CaptureRange, size?: { cols: number; rows: number }): string[] {
  const window: string[] = [];
  if (range && range.startBack > 0) {
    window.push("-S", `-${range.startBack}`);
    if (range.endBack !== undefined && range.endBack > 0) window.push("-E", `-${range.endBack}`);
  }
  const resize: string[] = size ? ["resize-window", "-t", session, "-x", String(size.cols), "-y", String(size.rows), ";"] : [];
  return [...dockerPrefix(cfg), cfg.container, "tmux", ...resize, "capture-pane", "-e", "-p", "-J", ...window, "-t", session];
}

/**
 * Type into a live pi session without attaching to it — the board's mirror pane
 * is an embedded terminal, not a photograph. `parts` comes from `keysToTmux`
 * (pipane.ts): either `["-l", "<literal text>"]` or a run of tmux key names
 * (`Enter`, `Up`, `C-c`, …).
 *
 * This is the one write the TUI makes against a VM tmux session outside the
 * attach pty. It touches no GitHub state, so it does not go near the mutation
 * gate — it is the same keystroke the operator could type after `tmux attach`.
 */
export function sendKeysArgv(cfg: TuiConfig, session: string, parts: string[]): string[] {
  return [...dockerPrefix(cfg), cfg.container, "tmux", "send-keys", "-t", session, ...parts];
}

/**
 * The interactive attach argv — the whole remote command after `ssh`.
 *
 * `window-size latest` FIRST, in the same invocation: the mirror's
 * `resize-window` (see `captureArgv`) leaves the window pinned to the board
 * pane's rectangle in `manual` mode, and a full-screen attach would then open
 * a small window marooned in a large terminal. `latest` is tmux's own default
 * — verified on the VM — and hands sizing back to the attaching client, so
 * taking a session over full-screen looks exactly as it did before the mirror
 * ever resized it.
 */
export function attachArgv(cfg: TuiConfig, session: string): string[] {
  return ["-tt", cfg.ssh_host, ...attachDockerArgv(cfg, session)];
}

/** The docker/tmux half of the attach — shared by both transports so the
 * window-size discipline above cannot drift between them. */
function attachDockerArgv(cfg: TuiConfig, session: string): string[] {
  return [
    ...dockerPrefix(cfg),
    "-it",
    cfg.container,
    "tmux",
    "set-window-option",
    "-t",
    session,
    "window-size",
    "latest",
    ";",
    "attach",
    "-t",
    session,
  ];
}

/**
 * the FULL attach command, binary first — what the pty spawner
 * executes. One construction path for both topologies: ssh mode wraps
 * `attachArgv` (unchanged, argv after the ssh binary); local mode runs the
 * same docker/tmux tail directly, where the bare `;` reaches tmux as its own
 * argv element (tmux's multi-command separator) — same window-size handback,
 * no ssh process anywhere.
 */
export function attachCommand(cfg: TuiConfig, session: string): string[] {
  if (transportOf(cfg) === "local") return attachDockerArgv(cfg, session);
  return ["ssh", ...attachArgv(cfg, session)];
}

/**
 * POSIX-quote one argv element for the remote shell. ssh does NOT pass argv
 * through — it space-joins everything after the host into ONE string the
 * remote shell re-parses. Unquoted, a multi-word `sh -c <script>` argument
 * is shredded into separate words: `sh -c "cat '/x' || true"` reaches the
 * VM as `sh -c cat '/x' || true`, so sh runs bare `cat` against an empty
 * stdin and the `|| true` masks it — every dockerSh() read silently
 * returned nothing (the empty Memory & learning tab, and the digest tab's
 * reads before it). Quoting each element makes the remote shell rebuild
 * the exact argv.
 */
export function shellQuote(arg: string): string {
  if (/^[\w./:=@-]+$/.test(arg)) return arg; // common safe tokens stay readable
  return `'${arg.replaceAll("'", `'\\''`)}'`;
}

/**
 * Every ssh child this runner has started and not yet settled.
 *
 * The per-call SIGKILL below lives on OUR event loop, so it only fires while
 * that loop is turning. The hot reload stops it dead: `realReexec` calls
 * `spawnSync`, which blocks the stack forever, and the timers of any ssh
 * in flight at that moment never run again. Those children then outlive the
 * generation that spawned them — measured live at 4h58m against a wedged
 * ControlMaster (an ssh-config block with no `ServerAliveInterval`, so a
 * network blip hangs the master and every slave riding it).
 *
 * Hence this set and `killInFlightSsh`: whoever is about to freeze the loop
 * kills the children first, while it still can.
 */
const inFlightSsh = new Set<ReturnType<typeof spawn>>();

/**
 * SIGKILL every ssh still in flight. Call before anything that stops this
 * process's event loop (the re-exec's `spawnSync`) — after that point the
 * per-call timeouts can no longer fire. Returns how many were killed so the
 * caller can say so. Total: a child that is already gone is skipped, never
 * a throw.
 */
export function killInFlightSsh(): number {
  let killed = 0;
  for (const child of inFlightSsh) {
    try {
      child.kill("SIGKILL");
      killed++;
    } catch {
      /* already reaped — nothing to clean up */
    }
  }
  inFlightSsh.clear();
  return killed;
}

export const realSshRunner: SshRunner = (host, argv, opts) =>
  runChild("ssh", ["-o", "BatchMode=yes", host, argv.map(shellQuote).join(" ")], opts);

/**
 * the laptop topology's runner — the SAME argv every builder above
 * produces, executed directly on this machine (`spawn(argv[0], argv.slice(1))`,
 * no shell, no quoting, no ssh). `host` is accepted and ignored so every
 * caller's `ssh(cfg.ssh_host, …)` call site stays untouched; `sudo_docker`
 * is already honoured by the builders (`dockerPrefix`). Children ride the
 * same in-flight set, so the re-exec teardown's `killInFlightSsh` covers a
 * wedged local docker exactly as it covers a wedged ssh.
 */
export const realLocalCommandRunner: SshRunner = (_host, argv, opts) => {
  const [bin, ...rest] = argv;
  if (bin === undefined) return Promise.resolve({ ok: false, stdout: "", stderr: "empty argv", code: null });
  return runChild(bin, rest, opts);
};

/** The transport decision, made ONCE: everything wired off this runner runs
 * over ssh or locally per `[tui] target`, with no per-call branching. */
export function runnerFor(cfg: TuiConfig): SshRunner {
  return transportOf(cfg) === "local" ? realLocalCommandRunner : realSshRunner;
}

function runChild(bin: string, args: string[], opts?: { stdin?: string; timeoutMs?: number }): Promise<RemoteResult> {
  return new Promise((resolvePromise) => {
    const child = spawn(bin, args, { stdio: ["pipe", "pipe", "pipe"] });
    inFlightSsh.add(child);
    let stdout = "";
    let stderr = "";
    let settled = false;
    // Chunk boundaries fall wherever the kernel put them, and a bare
    // `buf.toString()` per chunk mangles any multi-byte character split across
    // two of them into replacement bytes. Harmless on a one-line `cat
    // status.json`; corrupting on a megabyte of pi transcript full of box
    // drawing and emoji (evidence copier reads exactly that). The
    // decoder carries the partial sequence across chunks.
    const outDec = new StringDecoder("utf8");
    const errDec = new StringDecoder("utf8");
    const settle = (ok: boolean, code: number | null) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      inFlightSsh.delete(child);
      resolvePromise({ ok, stdout: stdout + outDec.end(), stderr: stderr + errDec.end(), code });
    };
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      settle(false, null);
    }, opts?.timeoutMs ?? 15_000);
    child.stdout.on("data", (d: Buffer) => (stdout += outDec.write(d)));
    child.stderr.on("data", (d: Buffer) => (stderr += errDec.write(d)));
    child.on("error", () => settle(false, null));
    child.on("close", (code) => settle(code === 0, code));
    if (opts?.stdin !== undefined) child.stdin.end(opts.stdin);
    else child.stdin.end();
  });
}
