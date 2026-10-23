// The containerised TUI's companion transport (D35).
//
// The sidebar, the rollover and the lifecycle all drive the companion through
// one `DockerRunner`, with `docker exec <container> tmux …` argv. A TUI that
// runs in a container has no docker.sock, and must not get one. It shares the
// companion's tmux socket through a named volume instead, so this runner takes
// the same argv and runs it against that socket:
//
//   exec <name> tmux <args…>   →  tmux -S <socket> <args…>
//   exec <name> sh -c <script> →  tmux -S <socket> run-shell <script>, its stdout
//                                  read back through a tmux buffer (the script
//                                  runs inside the companion's tmux server, so
//                                  it sees the companion's pi home)
//
// Anything else is refused by name: the host wrapper owns the container's
// lifecycle, and a call that wanted docker is a bug to see, not to absorb.
//
// One hazard this closes: a tmux client that finds no server starts one. Here
// that would put the companion's pi inside the TUI container (with the ssh
// agent) instead of the companion's. So a command that can start a server runs
// only after `show-options` proved one is answering on the socket.
import { randomBytes } from "node:crypto";
import { runCommand, type DockerResult, type DockerRunner } from "./companion.js";

/** Env var that puts the TUI in this mode, naming the mode. The wrapper sets it
 * on the TUI container only. */
export const TUI_COMPANION_ENV = "QCR_TUI_COMPANION";
export const TUI_COMPANION_TMUX_SOCKET = "tmux-socket";

/** tmux commands that start a server when none is listening. */
const SERVER_STARTING = new Set(["new-session", "new", "start-server", "start"]);

/** The tmux command word of `args` (after an optional `-S <path>`). */
function commandWord(args: string[]): string | undefined {
  const rest = args[0] === "-S" ? args.slice(2) : args;
  return rest.find((a) => !a.startsWith("-"));
}

export interface TmuxSocketDeps {
  /** Runs `tmux argv…`; the real one spawns it. Injectable so tests never do. */
  run?: (argv: string[], opts?: { timeoutMs?: number }) => Promise<DockerResult>;
}

const refuse = (stderr: string): DockerResult => ({ ok: false, stdout: "", stderr, code: null });

const shellQuote = (s: string): string => `'${s.replaceAll("'", `'\\''`)}'`;

/** The `run-shell` command that runs `script` and hands its output back
 * through a tmux buffer: its stdout, the exit status appended as `x<code>`,
 * then a line holding `buffer` (unique per call, so no output can forge it) and
 * the script's stderr.
 *
 * `tmux run-shell` is not a reliable way to read a script's output: tmux 3.4
 * (Ubuntu 24.04) never sends it to the invoking client's stdout. It lands in
 * the active pane's view-mode, or is dropped when no session exists, and the
 * client prints nothing. Newer tmux prints it. Worse, the view-mode swallows
 * the keys meant for the companion's pi. A buffer is read the same way on every
 * version, and the `x<code>` suffix keeps trailing newlines (the `$( )` would
 * strip them) and the exit status, which `run-shell` reports as its own. The
 * stderr goes to a temp file so it reaches the caller (as `docker exec` would
 * give it) instead of the pane's view-mode. */
function captureCommand(socket: string, buffer: string, script: string): string {
  return (
    `e=$(mktemp) || e=/dev/null; ` +
    `o=$(sh -c ${shellQuote(script)} 2>"$e"; printf 'x%s' "$?"); ` +
    `{ printf '%s\n%s\n' "$o" ${shellQuote(buffer)}; cat "$e"; } | tmux -S ${shellQuote(socket)} load-buffer -b ${buffer} -; ` +
    `rm -f "$e"`
  );
}

/** Splits a captured buffer into the script's stdout, exit status and stderr. */
function parseCaptured(
  text: string,
  buffer: string,
): { stdout: string; code: number; stderr: string } | undefined {
  const m = new RegExp(`^([\\s\\S]*)x(\\d+)\\n${buffer}\\n([\\s\\S]*)$`).exec(text);
  return m ? { stdout: m[1]!, code: Number(m[2]), stderr: m[3]! } : undefined;
}

export function tmuxSocketRunner(
  socket: string,
  containerName: string,
  deps: TmuxSocketDeps = {},
): DockerRunner {
  const run = deps.run ?? ((argv, opts) => runCommand("tmux", argv, opts));
  const alive = async (): Promise<boolean> =>
    (await run(["-S", socket, "show-options", "-s", "exit-empty"], { timeoutMs: 5_000 })).ok;
  return async (argv, opts) => {
    if (argv[0] !== "exec" || argv[1] !== containerName)
      return refuse(
        `docker ${argv[0] ?? ""} is not available in the tui container — the host wrapper runs the companion (D35)`,
      );
    const [bin, ...rest] = argv.slice(2);
    if (bin === "tmux") {
      const args = rest[0] === "-S" ? rest : ["-S", socket, ...rest];
      const word = commandWord(args);
      if (word !== undefined && SERVER_STARTING.has(word) && !(await alive()))
        return refuse(
          `the companion's tmux server is not up on ${socket} (is not running) — the host wrapper starts the companion container`,
        );
      return run(args, opts);
    }
    if (bin === "sh" && rest[0] === "-c" && rest.length === 2) {
      const script = rest[1]!;
      const buffer = `qcr-run-${randomBytes(6).toString("hex")}`;
      const ran = await run(
        ["-S", socket, "run-shell", captureCommand(socket, buffer, script)],
        opts,
      );
      if (!ran.ok) return ran;
      const read = await run(["-S", socket, "show-buffer", "-b", buffer], opts);
      void run(["-S", socket, "delete-buffer", "-b", buffer], { timeoutMs: 5_000 });
      if (!read.ok) return read;
      const got = parseCaptured(read.stdout, buffer);
      if (!got) return refuse(`tmux returned no output for the script on ${socket}`);
      return got.code === 0
        ? { ok: true, stdout: got.stdout, stderr: got.stderr, code: 0 }
        : {
            ok: false,
            stdout: got.stdout,
            stderr: `exit ${got.code}${got.stderr === "" ? "" : `\n${got.stderr.trimEnd()}`}`,
            code: got.code,
          };
    }
    return refuse(
      `docker exec ${bin ?? ""} is not available in the tui container — only tmux and sh -c reach the companion (D35)`,
    );
  };
}
