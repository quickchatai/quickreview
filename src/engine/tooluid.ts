// The separate tool uid (D32): the image's entrypoint (docker/entrypoint.sh)
// runs the engine as an unprivileged run uid that holds the GitHub token, with
// CAP_SETUID/CAP_SETGID as ambient capabilities, and names the uid the model's
// tools run as in QCR_TOOL_UID/QCR_TOOL_GID. This module is the one place that
// turns those names into a spawn:
//
//   - `toolIsolation` wraps a child (pi, or anything else that runs the model's
//     bash) in setpriv, which switches to the tool uid and drops every
//     capability and the ability to gain one back, so the kernel refuses the
//     tools /proc/<this pid>/mem and /environ. Node's own `uid` spawn option is
//     not used: it would leave the ambient capabilities on the child.
//   - `isolatedBashOperations` is the same for the SDK session's bash tool: the
//     model's command is run through setpriv, and stopped through it too (the
//     run uid may not signal a process of another uid).
//   - `checkToolUid` is the gate in front of a host: one that arranges the
//     split passes, one that cannot (a host whose tools are children of a
//     process with no split of its own) refuses rather than run without it,
//     unless the shared uid is accepted.
//
// `QCR_TOOL_UID_REQUIRED` is set by the same entrypoint when it could not
// arrange the separation (it was not started as root): nothing that runs the
// model's tools is started then, unless QCR_ALLOW_SHARED_TOOL_UID=1 says the
// shared uid is accepted. Outside the image none of these names is set and
// nothing changes.
import { spawn } from "node:child_process";
import { chmodSync, existsSync, lstatSync, readdirSync } from "node:fs";
import { access } from "node:fs/promises";
import { dirname, join } from "node:path";
import { constants as osConstants } from "node:os";
import type { BashOperations } from "@earendil-works/pi-coding-agent";

/** The names the image's entrypoint sets when the model's tools must run as
 * another uid than this process (D32). */
export const TOOL_UID_ENVS = ["QCR_TOOL_UID", "QCR_TOOL_GID", "QCR_TOOL_UID_REQUIRED"] as const;

/** The uid and gid the model's tools run as: non-zero numeric ids. */
export interface ToolIds {
  uid: string;
  gid: string;
}

const ID = /^[1-9][0-9]*$/;

/** What the environment says about the tool uid: the ids to run the tools as, or
 * null where nothing asks for a separation, or why none can be made. Where the
 * ids are named they win, whatever else is set. */
export function toolIdsOf(env: NodeJS.ProcessEnv): ToolIds | { refused: string } | null {
  const uid = env["QCR_TOOL_UID"];
  const gid = env["QCR_TOOL_GID"];
  if (uid || gid) {
    if (!ID.test(uid ?? "") || !ID.test(gid ?? ""))
      return { refused: `QCR_TOOL_UID/QCR_TOOL_GID must be non-zero numeric ids (${uid}:${gid})` };
    return { uid: uid as string, gid: gid as string };
  }
  if (env["QCR_TOOL_UID_REQUIRED"] && env["QCR_ALLOW_SHARED_TOOL_UID"] !== "1")
    return {
      refused:
        "the model's tools would share this process's uid and could read its token through /proc: " +
        "start the container as root with --cap-drop ALL --cap-add SETUID --cap-add SETGID " +
        "(docker/entrypoint.sh drops to QCR_RUN_UID and runs the tools as QCR_TOOL_UID), " +
        "or set QCR_ALLOW_SHARED_TOOL_UID=1 to accept the shared uid",
    };
  return null;
}

/** setpriv's switches for the tool uid: its uid and gid with no supplementary
 * groups, no capability, and no way to gain one. Does not include `--`. */
export function setprivSwitches(ids: ToolIds): string[] {
  return [
    `--reuid=${ids.uid}`,
    `--regid=${ids.gid}`,
    "--clear-groups",
    "--inh-caps=-all",
    "--ambient-caps=-all",
    "--no-new-privs",
  ];
}

/** How a child that runs the model's tools is started: through setpriv where the
 * image asks for the tool uid, unchanged where nothing does, refused where the
 * entrypoint could not arrange it. */
export function toolIsolation(
  bin: string,
  argv: string[],
  procEnv: NodeJS.ProcessEnv = process.env,
): { bin: string; argv: string[]; isolated: boolean } | { refused: string } {
  const ids = toolIdsOf(procEnv);
  if (ids === null) return { bin, argv, isolated: false };
  if ("refused" in ids) return ids;
  // The bot's setid helper where the image names one, else setpriv itself.
  const helper = setidHelperOf(procEnv);
  if (helper !== null && "refused" in helper) return helper;
  return {
    bin: helper?.path ?? "setpriv",
    argv: [...setprivSwitches(ids), "--", bin, ...argv],
    isolated: true,
  };
}

/** The gate in front of a host that runs the model's tools.
 *
 * A host that starts them itself through the tool uid (`isolated`: the SDK
 * runtime's bash, a debug round's pi) passes where the ids are numeric and
 * non-zero, and is refused where the entrypoint could not arrange the split.
 *
 * A host that cannot (its tools are children of a process that runs in this
 * uid, such as the native lens tool's pi children) refuses wherever the image
 * asks for the separation, unless the shared uid is accepted. `host` words the
 * refusal for the caller. */
export function checkToolUid(
  env: NodeJS.ProcessEnv,
  host: { what: string; instead: string; isolated?: boolean } = {
    what: "the SDK runtime",
    instead: "",
  },
): void {
  if (host.isolated === true) {
    const ids = toolIdsOf(env);
    if (ids !== null && "refused" in ids) throw new Error(`${host.what}: ${ids.refused}`);
    return;
  }
  if (env["QCR_ALLOW_SHARED_TOOL_UID"] === "1") return;
  if (TOOL_UID_ENVS.some((n) => env[n]))
    throw new Error(
      `${host.what} runs the model's tools in this process, so it cannot run them as another uid, ` +
        `which this container asks for: ${host.instead === "" ? "" : `${host.instead}, or `}set ` +
        "QCR_ALLOW_SHARED_TOOL_UID=1 to accept the shared uid",
    );
}

/**
 * Opens `dir` and everything in it to the run gid, which the tool uid shares:
 * group read and write on files, and group access on directories. For a
 * process that runs as the tool uid and needs what the run uid made private
 * (a debug round's pi reading its agent dir); the owner's bits stay. Symbolic
 * links are left as they are, and a missing dir is nothing to share.
 */
export function shareWithToolGroup(dir: string): void {
  const st = lstatSync(dir, { throwIfNoEntry: false });
  if (st === undefined || st.isSymbolicLink()) return;
  // An entry another uid owns (the tool uid's own, made under its group-writable
  // umask) is not this process's to change, and needs no sharing.
  if (typeof process.getuid === "function" && st.uid !== process.getuid()) return;
  if (st.isDirectory()) {
    chmodSync(dir, (st.mode & 0o7777) | 0o070);
    for (const name of readdirSync(dir)) shareWithToolGroup(join(dir, name));
  } else if (st.isFile()) {
    chmodSync(dir, (st.mode & 0o7777) | 0o060);
  }
}

/**
 * The environment a command run as the tool uid needs on top of the one it was
 * given: git's `safe.directory = *` in the command scope.
 *
 * The repositories the model reads (the worktrees, the base clone) belong to the
 * run uid, and git refuses a repository another uid owns ("dubious ownership").
 * The image's system config says `*`, but a review session pins git's system
 * scope off (src/sessions.ts sessionGitConfigPins), and `safe.directory` is read
 * only from a protected scope: system, global or command. So it rides the
 * command scope (GIT_CONFIG_COUNT/KEY_n/VALUE_n), appended after any entries the
 * env already carries, never in place of them. It widens nothing: the
 * repositories are the run uid's, which the tool uid trusts by construction.
 */
export function toolUidEnv(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const given = env["GIT_CONFIG_COUNT"];
  const n = given !== undefined && /^\d{1,3}$/.test(given) ? Number(given) : 0;
  return {
    ...env,
    GIT_CONFIG_COUNT: String(n + 1),
    [`GIT_CONFIG_KEY_${n}`]: "safe.directory",
    [`GIT_CONFIG_VALUE_${n}`]: "*",
  };
}

/** The umask a tool-uid command runs under: group-writable files, which is how
 * the run uid and the tool uid (one gid, two uids) share what either writes. */
export const TOOL_UMASK = 0o002;

/** The shell program that runs a tool-uid command: it sets the umask and
 * replaces itself with the shell on the command, so the command is still
 * `<shell> -c <command>` (one argument, the same $0) under the same pid, which
 * leads its process group. */
const UMASK_THEN_RUN = `umask 002 && exec "$0" -c "$1"`;

/** Where setpriv is looked for: root-owned system dirs, never the model's PATH. */
const SETPRIV_DIRS = ["/usr/bin", "/bin", "/usr/sbin", "/sbin"];
const SETPRIV_PATH = SETPRIV_DIRS.join(":");

/** The setpriv the spawner runs, which holds the ambient SETUID/SETGID: an
 * absolute path in a system dir. A PATH entry the tool uid can write must not
 * be able to plant the binary the next command runs with those capabilities.
 * Null where no system dir has one. */
export function trustedSetpriv(
  exists: (p: string) => boolean = existsSync,
  env: NodeJS.ProcessEnv = process.env,
): string | null {
  const helper = setidHelperOf(env);
  if (helper !== null) return "path" in helper ? helper.path : null;
  return SETPRIV_DIRS.map((d) => join(d, "setpriv")).find(exists) ?? null;
}

/**
 * The bot's setid helper, named by `QCR_SETPRIV_BIN`: the image's
 * own copy of setpriv that carries CAP_SETUID/CAP_SETGID as FILE capabilities
 * and only a gate group may run (docker/Dockerfile). The always-on bot runs as
 * its own uid, not root, so `docker exec` into it keeps landing as that uid; it
 * reaches the tool uid through this helper instead of ambient capabilities
 * (docker/entrypoint.sh's daemon mode). The model's tools never get it: they run
 * with no_new_privs, under which a file capability grants nothing, and without
 * the gate group.
 *
 * Trusted only as a root-owned regular file in a root-owned directory, neither
 * writable by group or others: the run uid must not be able to swap the binary
 * it hands its capabilities to. Null where the env names none; `refused` where
 * it names one that fails those checks.
 */
export function setidHelperOf(
  env: NodeJS.ProcessEnv,
  stat: (
    p: string,
  ) => { uid: number; mode: number; isFile(): boolean; isDirectory(): boolean } | undefined = (p) =>
    lstatSync(p, { throwIfNoEntry: false }),
): { path: string } | { refused: string } | null {
  const named = env["QCR_SETPRIV_BIN"]?.trim();
  if (named === undefined || named === "") return null;
  const refuse = (why: string) => ({ refused: `QCR_SETPRIV_BIN ${named}: ${why}` });
  if (!named.startsWith("/")) return refuse("not an absolute path");
  const file = stat(named);
  if (file === undefined || !file.isFile()) return refuse("not a regular file");
  const dir = stat(dirname(named));
  if (dir === undefined || !dir.isDirectory()) return refuse("its directory is not a directory");
  for (const [what, st] of [
    ["it", file],
    ["its directory", dir],
  ] as const) {
    if (st.uid !== 0) return refuse(`${what} is not owned by root`);
    if ((st.mode & 0o022) !== 0) return refuse(`${what} is writable by group or others`);
  }
  return { path: named };
}

/** The shell the model's commands run in: pi's own choice on Unix. */
function shellPath(): string {
  return existsSync("/bin/bash") ? "/bin/bash" : "sh";
}

/** After the shell exits, how long output still arriving on a pipe a descendant
 * holds open is waited for (pi's own grace). */
const EXIT_STDIO_GRACE_MS = 100;

/** What differs between the two ways the SDK bash tool starts a command: the
 * program that runs the shell, and how a process group is ended. */
interface ShellPlan {
  /** Throws where the command cannot be started at all. */
  ready(): void;
  start(command: string): { bin: string; argv: string[] };
  /** The command's environment from the one it was given. */
  env?(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv;
  /** End the group `pgid` leads. Best effort. */
  killGroup(pgid: number): void;
}

/** The stdio of a command: nothing in, its output out, and each of `inherit`
 * handed to it at the SAME fd number. Node closes every descriptor a child is
 * not listed with, so an fd a command (or a script under it) must read has to be
 * named here. */
export function commandStdio(inherit: readonly number[]): Array<"ignore" | "pipe" | number> {
  const stdio: Array<"ignore" | "pipe" | number> = ["ignore", "pipe", "pipe"];
  for (const fd of inherit) {
    if (!Number.isInteger(fd) || fd < 3) throw new Error(`cannot hand a command fd ${fd}`);
    while (stdio.length < fd) stdio.push("ignore");
    stdio[fd] = fd;
  }
  return stdio;
}

function shellOperations(plan: ShellPlan, inherit: readonly number[]): BashOperations {
  const stdio = commandStdio(inherit);
  return {
    exec: async (command, cwd, { onData, signal, timeout, env }) => {
      plan.ready();
      if (signal?.aborted) throw new Error("aborted");
      if (timeout !== undefined && !(Number.isFinite(timeout) && timeout > 0))
        throw new Error("Invalid timeout: must be a finite number of seconds");
      try {
        await access(cwd);
      } catch {
        throw new Error(`Working directory does not exist: ${cwd}\nCannot execute bash commands.`);
      }
      const { bin, argv } = plan.start(command);
      const given = env ?? process.env;
      const child = spawn(bin, argv, {
        cwd,
        env: plan.env ? plan.env(given) : given,
        detached: true,
        stdio,
      });
      const pgid = child.pid;
      const killGroup = (): void => {
        if (pgid !== undefined) plan.killGroup(pgid);
      };
      let timedOut = false;
      const timer =
        timeout === undefined
          ? undefined
          : setTimeout(() => {
              timedOut = true;
              killGroup();
            }, timeout * 1000);
      const onAbort = (): void => killGroup();
      signal?.addEventListener("abort", onAbort, { once: true });
      try {
        child.stdout!.on("data", onData);
        child.stderr!.on("data", onData);
        const exitCode = await new Promise<number | null>((resolve, reject) => {
          let exited = false;
          let code: number | null = null;
          let idle: NodeJS.Timeout | undefined;
          const done = (): void => {
            if (idle) clearTimeout(idle);
            child.stdout!.destroy();
            child.stderr!.destroy();
            resolve(code);
          };
          const arm = (): void => {
            if (idle) clearTimeout(idle);
            idle = setTimeout(done, EXIT_STDIO_GRACE_MS);
          };
          child.once("error", reject);
          child.once("exit", (c) => {
            exited = true;
            code = c;
            arm();
          });
          child.once("close", (c) => {
            code = c ?? code;
            done();
          });
          // output still arriving after the exit keeps the wait open
          child.stdout!.on("data", () => exited && arm());
          child.stderr!.on("data", () => exited && arm());
        });
        if (signal?.aborted) throw new Error("aborted");
        if (timedOut) throw new Error(`timeout:${timeout}`);
        // A signal-killed shell has no exit code: the shell convention, as pi has it.
        const signalled = child.signalCode ? 128 + (osConstants.signals[child.signalCode] ?? 0) : 1;
        return { exitCode: exitCode ?? signalled };
      } finally {
        if (timer) clearTimeout(timer);
        signal?.removeEventListener("abort", onAbort);
      }
    },
  };
}

/**
 * The SDK bash tool's execution, with the model's command run as the tool uid.
 *
 * The command is `setpriv … -- bash -c <command>` in a process group of its
 * own, the umask set first (TOOL_UMASK) and git's safe.directory in its env
 * (toolUidEnv). A timeout or an abort ends that group through setpriv too: the run uid
 * may not signal a process of another uid (kill(2): the sender's uid must match
 * the target's real or saved uid, and this process holds no CAP_KILL), so pi's
 * own kill of the tree would silently do nothing and the command would run on.
 * The saved uid cannot be left as the run uid to allow it: the tool could then
 * switch back.
 *
 * `inherit` lists descriptors every command gets at the same number (the
 * bot worker's IPC capability, P8.3).
 */
export function isolatedBashOperations(
  ids: ToolIds,
  setprivBin?: string,
  inherit: readonly number[] = [],
): BashOperations {
  const switches = setprivSwitches(ids);
  const setpriv = setprivBin ?? trustedSetpriv();
  const helper = setprivBin === undefined ? setidHelperOf(process.env) : null;
  return shellOperations(
    {
      ready: () => {
        if (helper !== null && "refused" in helper)
          throw new Error(`${helper.refused}: the tool uid cannot be used`);
        if (setpriv === null)
          throw new Error(
            "setpriv is in none of " + SETPRIV_PATH + ": the tool uid cannot be used",
          );
      },
      start: (command) => ({
        bin: setpriv!,
        argv: [...switches, "--", shellPath(), "-c", UMASK_THEN_RUN, shellPath(), command],
      }),
      env: toolUidEnv,
      // The group's end, as the tool uid. Best effort: a failure leaves the
      // command running, as pi's own kill does when it cannot signal.
      killGroup: (pgid) => {
        try {
          spawn(
            setpriv!,
            [...switches, "--", shellPath(), "-c", 'kill -KILL -- "-$0" 2>/dev/null', String(pgid)],
            // the killing shell needs no PATH of the model's
            { stdio: "ignore", env: { PATH: SETPRIV_PATH } },
          )
            .once("error", () => {})
            .unref();
        } catch {
          // setpriv could not be started: nothing more can be done from here
        }
      },
    },
    inherit,
  );
}

/** The same execution with no uid change, for a host whose commands must
 * inherit descriptors (`inherit`): pi's own local operations start a command
 * with nothing but stdio. The command runs in a process group of its own, which
 * a timeout or an abort ends. */
export function inheritingBashOperations(inherit: readonly number[]): BashOperations {
  return shellOperations(
    {
      ready: () => {},
      start: (command) => ({ bin: shellPath(), argv: ["-c", command] }),
      killGroup: (pgid) => {
        try {
          process.kill(-pgid, "SIGKILL");
        } catch {
          // already gone
        }
      },
    },
    inherit,
  );
}
