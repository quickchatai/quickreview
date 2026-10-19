// The containerised TUI's companion transport (D35).
//
// The sidebar, the rollover and the lifecycle all drive the companion through
// one `DockerRunner`, with `docker exec <container> tmux …` argv. A TUI that
// runs in a container has no docker.sock, and must not get one. It shares the
// companion's tmux socket through a named volume instead, so this runner takes
// the same argv and runs it against that socket:
//
//   exec <name> tmux <args…>   →  tmux -S <socket> <args…>
//   exec <name> sh -c <script> →  tmux -S <socket> run-shell <script>
//                                  (the script runs inside the companion's tmux
//                                  server, so it sees the companion's pi home)
//
// Anything else is refused by name: the host wrapper owns the container's
// lifecycle, and a call that wanted docker is a bug to see, not to absorb.
//
// One hazard this closes: a tmux client that finds no server starts one. Here
// that would put the companion's pi inside the TUI container (with the ssh
// agent) instead of the companion's. So a command that can start a server runs
// only after `show-options` proved one is answering on the socket.
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

/** `tmux run-shell` prints `'<script>' returned N` on a failing script. Move it
 * out of stdout, so a failed script leaves only its own output. */
function stripReturned(script: string, res: DockerResult): DockerResult {
  if (res.ok) return res;
  const marker = `'${script}' returned `;
  const at = res.stdout.lastIndexOf(marker);
  if (at < 0) return res;
  const code = /^(\d+)/.exec(res.stdout.slice(at + marker.length))?.[1];
  return {
    ...res,
    stdout: res.stdout.slice(0, at),
    stderr: res.stderr || `exit ${code ?? res.code}`,
  };
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
      return stripReturned(script, await run(["-S", socket, "run-shell", script], opts));
    }
    return refuse(
      `docker exec ${bin ?? ""} is not available in the tui container — only tmux and sh -c reach the companion (D35)`,
    );
  };
}
