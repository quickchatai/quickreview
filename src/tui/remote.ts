// Remote access layer for qcr tui — every VM touch goes through here, and
// every command it can produce is read-only against the box except the
// user-initiated writes (inject files in msg.ts, and `sendKeysArgv` typing
// into the board's focused pi pane — a takeover's or a debug round's pi, never
// a bot session: the bot runs no `pr-<n>` tmux session) and the one bookkeeping delete, the
// companion inbox's ack (`inboxAckArgv`). There is no interactive attach: the TUI
// never takes a pty to a VM tmux session — the board's PR pane and the
// companion column are the only terminals, both embedded. Rubric proposals do
// not ride this runner: they are local state/rubric/ dirs (companion-authored)
// handled by fs in proposals.ts. Memory edits do not ride it either: the TUI
// talks HTTP to OpenViking over the memory forward's loopback listener — see
// src/tui/memory.ts.
// None of them touch GitHub mutations, so none go near the gate (the
// proposals pane's gh reads are reads — direct per the gate rules).
// Command construction is pure so tests can assert the exact argv; execution
// is one injectable runner.
import { spawn } from "node:child_process";
import { StringDecoder } from "node:string_decoder";
import type { TuiConfig } from "../config.js";
import { tmuxCaptureArgs } from "./termmirror.js";
import { INBOX_ID_RE, INBOX_REL_DIR } from "../companioninbox.js";
import { remoteSandboxRoot } from "./layout.js";

export interface RemoteResult {
  ok: boolean;
  stdout: string;
  stderr: string;
  code: number | null;
}

/** Runs `ssh <host> <argv…>`. Injectable — tests never spawn.
 *
 * This is the TUI's one remote-runner interface, with two implementations —
 * `realSshRunner` (the VM topology) and `realLocalCommandRunner` (the laptop
 * topology: the same argv runs on this machine, `host` ignored, no ssh
 * anywhere). `runnerFor(cfg)` picks; callers keep calling
 * `ssh(cfg.ssh_host, someArgv(cfg))` untouched. */
export type SshRunner = (
  host: string,
  argv: string[],
  opts?: { stdin?: string; timeoutMs?: number },
) => Promise<RemoteResult>;

/** Transport of every TUI remote op. Driven by the explicit `[tui] target`
 * knob only — never inferred from ssh_host's value. */
export type Transport = "ssh" | "local";

export function transportOf(cfg: TuiConfig): Transport {
  return cfg.target === "local" ? "local" : "ssh";
}

function dockerPrefix(cfg: TuiConfig): string[] {
  return [...(cfg.sudo_docker ? ["sudo"] : []), "docker", "exec"];
}

/** In-container `qcr <args…>` — the daemon's CLI entry point, spelled once. */
function cliArgv(cfg: TuiConfig, ...args: string[]): string[] {
  return [...dockerPrefix(cfg), cfg.container, "node", "dist/src/cli.js", ...args];
}

/** A shell script run inside the container: `[sudo] docker exec <container> sh -c <script>`. */
export function dockerShArgv(cfg: TuiConfig, script: string): string[] {
  return [...dockerPrefix(cfg), cfg.container, "sh", "-c", script];
}

/** The bot's companion inbox (src/companioninbox.ts), inside the container. */
export function inboxDirFor(cfg: TuiConfig): string {
  return `${remoteSandboxRoot(cfg)}/${INBOX_REL_DIR}`;
}

/** Items one pull reads at most: a backlog drains over a few polls rather
 * than as one transfer of every EOD sweep the companion missed. */
export const INBOX_PULL_MAX = 20;

/**
 * Print the pending inbox items, one JSON object per line (an item is written
 * with `JSON.stringify`, so it is a single line), oldest file names first and
 * at most `INBOX_PULL_MAX`. An absent directory prints nothing: a bot that has
 * not written an item yet is an empty inbox. Reads only.
 */
export function inboxListArgv(cfg: TuiConfig): string[] {
  const dir = shellQuote(inboxDirFor(cfg));
  return dockerShArgv(
    cfg,
    `d=${dir}; [ -d "$d" ] || exit 0; n=0; for f in "$d"/*.json; do [ -f "$f" ] || continue; ` +
      `[ "$n" -lt ${INBOX_PULL_MAX} ] || break; { cat "$f" && echo; } 2>/dev/null; n=$((n+1)); done; exit 0`,
  );
}

/**
 * Acknowledge delivered items: delete their files. This is the one write the
 * pull makes against the bot, and only for ids that came back from the bot's
 * own listing and passed the item-id shape, so no path or option can ride in.
 * `rm -f` of an id that is already gone is the normal answer of a second TUI.
 */
export function inboxAckArgv(cfg: TuiConfig, ids: readonly string[]): string[] {
  for (const id of ids) if (!INBOX_ID_RE.test(id)) throw new Error(`not an inbox item id: ${id}`);
  const dir = shellQuote(inboxDirFor(cfg));
  return dockerShArgv(
    cfg,
    `cd ${dir} 2>/dev/null || exit 0; rm -f -- ${ids.map((id) => `'${id}.json'`).join(" ")}`,
  );
}

/** VM state is host-mounted; local Compose state lives in a named Docker volume. */
export function statusArgv(cfg: TuiConfig): string[] {
  return stateReadArgv(cfg, "status.json");
}

function stateReadArgv(cfg: TuiConfig, path: string): string[] {
  return [
    ...(transportOf(cfg) === "local" ? [...dockerPrefix(cfg), cfg.container] : []),
    "cat",
    `${cfg.remote_state_dir}/${path}`,
  ];
}

/** In-container `qcr why <n> --json`. */
export function whyArgv(cfg: TuiConfig, pr: number): string[] {
  return cliArgv(cfg, "why", String(pr), "--json");
}

/**
 * The selected PR's ephemeral parent/lens activity. Like status.json this is
 * read with one cat from the topology's state volume, without GitHub enrichment.
 */
export function progressArgv(cfg: TuiConfig, pr: number): string[] {
  return stateReadArgv(cfg, `round-progress/pr-${pr}.json`);
}

/** One path component of a LiveEvent log location: a plain token, never a `..`
 * or a separator. Everything the viewer interpolates into a path goes through
 * this, because the names come from a directory listing on the box. */
const LIVE_PART = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;

function livePath(cfg: TuiConfig, rel: readonly string[]): string {
  for (const part of rel)
    if (!LIVE_PART.test(part)) throw new Error(`not a live log path: ${part}`);
  return [cfg.remote_state_dir, "live", ...rel].join("/");
}

/**
 * Read a LiveEvent log (src/live/events.ts) from byte `fromOffset` on: `cat`
 * for the whole file, `tail -c +<offset+1>` for what has been appended since.
 * The argv is the same on both transports, like every other state read here —
 * `stateReadArgv`'s container prefix on the laptop, a bare command on the VM
 * (state is host-mounted) — so the runner is the only thing that differs.
 * `rel` is the path under `state/live/`, e.g. `["pr-7", "r2", "main.jsonl"]`.
 */
export function liveReadArgv(cfg: TuiConfig, rel: readonly string[], fromOffset = 0): string[] {
  const prefix = transportOf(cfg) === "local" ? [...dockerPrefix(cfg), cfg.container] : [];
  const path = livePath(cfg, rel);
  return fromOffset > 0
    ? [...prefix, "tail", "-c", `+${Math.floor(fromOffset) + 1}`, path]
    : [...prefix, "cat", path];
}

/** The names in a directory under `state/live/` (`ls -1`): a PR's rounds, or a
 * round's logs. */
export function liveListArgv(cfg: TuiConfig, rel: readonly string[]): string[] {
  const prefix = transportOf(cfg) === "local" ? [...dockerPrefix(cfg), cfg.container] : [];
  return [...prefix, "ls", "-1", livePath(cfg, rel)];
}

/** In-container `qcr events --tail <k> --json`. */
export function eventsArgv(cfg: TuiConfig, tail: number): string[] {
  return cliArgv(cfg, "events", "--tail", String(tail), "--json");
}

/** In-container `qcr today --json` (digest tab's spend/rounds source). */
export function todayArgv(cfg: TuiConfig): string[] {
  return cliArgv(cfg, "today", "--json");
}

/** In-container `qcr metrics --json` (the metrics tab's aggregate source). */
export function metricsArgv(cfg: TuiConfig): string[] {
  return cliArgv(cfg, "metrics", "--json");
}

/** In-container `qcr history digest --json`: the review history
 * digest, printed — the VM keeps no copy; `historypull.ts` writes it into the
 * PC's state home. Read-only against GitHub and the box. */
export function historyDigestArgv(cfg: TuiConfig, months?: number): string[] {
  return cliArgv(
    cfg,
    "history",
    "digest",
    ...(months !== undefined ? ["--months", String(months)] : []),
    "--json",
  );
}

/** In-container `qcr metrics --pr <n> --json` (the per-PR timeline). */
export function metricsPrArgv(cfg: TuiConfig, pr: number): string[] {
  return cliArgv(cfg, "metrics", "--pr", String(pr), "--json");
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
 * The only tmux sessions the board's PR pane may capture or type into: the pi
 * an operator is inside, a debug round's (`debug-pr-<n>`) or a takeover's
 * (`takeover-pr-<n>`). The bot's rounds run in workers with no tmux session,
 * so a `pr-<n>` name does not type-check here (P9.6).
 */
export type PiTerminalSession = `debug-pr-${number}` | `takeover-pr-${number}`;

/**
 * Non-interactive snapshot of a live pi session for the board's mirror pane:
 * `-e` keeps the pane's colors, `-p` writes to stdout, `-J` joins wrapped
 * lines. Reads only — writing into the pane is `sendKeysArgv`.
 *
 * `size` prepends a `resize-window`, in the same tmux invocation, so the
 * capture can never race an asynchronous resize. A session the daemon created
 * detached sits at tmux's 80×24 default forever (verified on the VM: a fresh
 * detached session reports `80x24 window-size=latest`), so pi wraps its output
 * at 80 columns however wide the board paints the mirror — the text crowds into
 * the left of the pane and a selection drawn over the empty remainder picks up
 * nothing. Handing tmux the painted rectangle makes pi lay itself out for the
 * space its capture is rendered in.
 *
 * `resize-window -x/-y` flips the window's `window-size` option to `manual`.
 * A human attaching with plain `tmux attach` afterwards inherits that pinned
 * rectangle; the undo is `tmux set-window-option -t <session> window-size
 * latest` (root CLAUDE.md, "Run / deploy / observe").
 *
 * The bare `;` is tmux's command separator and reaches tmux intact because
 * this argv rides `realSshRunner`, which shell-quotes every element. Never
 * hand it to a transport that space-joins unquoted: the remote shell would
 * split on the `;` and run the second half as its own command.
 */
export function captureArgv(
  cfg: TuiConfig,
  session: PiTerminalSession,
  range?: CaptureRange,
  size?: { cols: number; rows: number },
): string[] {
  return [...dockerPrefix(cfg), cfg.container, "tmux", ...tmuxCaptureArgs(session, range, size)];
}

/** Extra history a scrolled capture asks for beyond the offset itself, so the
 * area above the parked window is filled rather than blank. One value for both
 * embedded terminals (the board's PR pane and the companion column). */
export const CAPTURE_SCROLL_PAD = 200;

/** The capture range of a mirror parked `offset` lines above its live tail —
 * none at the tail. */
export function scrolledRange(offset: number): CaptureRange | undefined {
  return offset > 0 ? { startBack: offset + CAPTURE_SCROLL_PAD } : undefined;
}

/**
 * Type into a live pi session without attaching to it — the board's mirror pane
 * is an embedded terminal, not a photograph. `parts` comes from `keysToTmux`
 * (termmirror.ts): either `["-l", "--", "<literal text>"]` or a run of tmux key names
 * (`Enter`, `Up`, `C-c`, …).
 *
 * This is the one write the TUI makes against a VM tmux session. It touches
 * no GitHub state, so it does not go near the mutation gate — it is the same
 * keystroke the operator could type after a manual `tmux attach`.
 */
export function sendKeysArgv(
  cfg: TuiConfig,
  session: PiTerminalSession,
  parts: string[],
): string[] {
  return [...dockerPrefix(cfg), cfg.container, "tmux", "send-keys", "-t", session, ...parts];
}

/**
 * POSIX-quote one argv element for the remote shell. ssh does not pass argv
 * through — it space-joins everything after the host into one string the
 * remote shell re-parses. Unquoted, a multi-word `sh -c <script>` argument
 * is shredded into separate words: `sh -c "cat '/x' || true"` reaches the
 * VM as `sh -c cat '/x' || true`, so sh runs bare `cat` against an empty
 * stdin and the `|| true` masks it — every dockerSh() read would silently
 * return nothing. Quoting each element makes the remote shell rebuild the
 * exact argv.
 */
export function shellQuote(arg: string): string {
  if (/^[\w./:=@-]+$/.test(arg)) return arg; // common safe tokens stay readable
  return `'${arg.replaceAll("'", `'\\''`)}'`;
}

/**
 * Every ssh child this runner has started and not yet settled.
 *
 * The per-call SIGKILL below lives on our event loop, so it only fires while
 * that loop is turning. The hot reload stops it dead: `realReexec` calls
 * `spawnSync`, which blocks the stack forever, and the timers of any ssh
 * in flight at that moment never run again. Those children then outlive the
 * generation that spawned them — for hours against a wedged ControlMaster
 * (with no `ServerAliveInterval`, a network blip hangs the master and every
 * slave riding it).
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
 * The laptop topology's runner — the same argv every builder above
 * produces, executed directly on this machine (`spawn(argv[0], argv.slice(1))`,
 * no shell, no quoting, no ssh). `host` is accepted and ignored so every
 * caller's `ssh(cfg.ssh_host, …)` call site stays untouched; `sudo_docker`
 * is already honoured by the builders (`dockerPrefix`). Children ride the
 * same in-flight set, so the re-exec teardown's `killInFlightSsh` covers a
 * wedged local docker exactly as it covers a wedged ssh.
 */
export const realLocalCommandRunner: SshRunner = (_host, argv, opts) => {
  const [bin, ...rest] = argv;
  if (bin === undefined)
    return Promise.resolve({ ok: false, stdout: "", stderr: "empty argv", code: null });
  return runChild(bin, rest, opts);
};

/** The transport decision, made once: everything wired off this runner runs
 * over ssh or locally per `[tui] target`, with no per-call branching. */
export function runnerFor(cfg: TuiConfig): SshRunner {
  return transportOf(cfg) === "local" ? realLocalCommandRunner : realSshRunner;
}

function runChild(
  bin: string,
  args: string[],
  opts?: { stdin?: string; timeoutMs?: number },
): Promise<RemoteResult> {
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
    // drawing and emoji (the evidence copier reads exactly that). The
    // decoder carries the partial sequence across chunks.
    const outDec = new StringDecoder("utf8");
    const errDec = new StringDecoder("utf8");
    // `cause` is the runner's own last stderr line when the child never
    // exited on its own — a spawn error (a missing binary prints nothing) or
    // the timeout — so a caller's "last stderr line" names it rather than
    // reading as a bare `exit ?`.
    const settle = (ok: boolean, code: number | null, cause?: string) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      inFlightSsh.delete(child);
      let err = stderr + errDec.end();
      if (cause !== undefined) err += `${err === "" || err.endsWith("\n") ? "" : "\n"}${cause}`;
      resolvePromise({ ok, stdout: stdout + outDec.end(), stderr: err, code });
    };
    const timeoutMs = opts?.timeoutMs ?? 15_000;
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      settle(false, null, `${bin}: timed out after ${timeoutMs}ms`);
    }, timeoutMs);
    child.stdout.on("data", (d: Buffer) => (stdout += outDec.write(d)));
    child.stderr.on("data", (d: Buffer) => (stderr += errDec.write(d)));
    child.on("error", (e: Error) => settle(false, null, e.message));
    child.on("close", (code) => settle(code === 0, code));
    child.stdin.on("error", (e: Error) => {
      child.kill("SIGKILL");
      settle(false, null, e.message);
    });
    if (opts?.stdin !== undefined) child.stdin.end(opts.stdin);
    else child.stdin.end();
  });
}
