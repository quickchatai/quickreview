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
import { join } from "node:path";
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
): { bin: string; argv: string[] } | { refused: string } {
  const ids = toolIdsOf(procEnv);
  if (ids === null) return { bin, argv };
  if ("refused" in ids) return ids;
  return { bin: "setpriv", argv: [...setprivSwitches(ids), "--", bin, ...argv] };
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
    instead: "use [engine] runtime = proc here",
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
        `which this container asks for: ${host.instead}, or set ` +
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
  if (st.isDirectory()) {
    chmodSync(dir, (st.mode & 0o7777) | 0o070);
    for (const name of readdirSync(dir)) shareWithToolGroup(join(dir, name));
  } else if (st.isFile()) {
    chmodSync(dir, (st.mode & 0o7777) | 0o060);
  }
}

/** The shell the model's commands run in: pi's own choice on Unix. */
function shellPath(): string {
  return existsSync("/bin/bash") ? "/bin/bash" : "sh";
}

/** After the shell exits, how long output still arriving on a pipe a descendant
 * holds open is waited for (pi's own grace). */
const EXIT_STDIO_GRACE_MS = 100;

/**
 * The SDK bash tool's execution, with the model's command run as the tool uid.
 *
 * The command is `setpriv … -- bash -c <command>` in a process group of its
 * own. A timeout or an abort ends that group through setpriv too: the run uid
 * may not signal a process of another uid (kill(2): the sender's uid must match
 * the target's real or saved uid, and this process holds no CAP_KILL), so pi's
 * own kill of the tree would silently do nothing and the command would run on.
 * The saved uid cannot be left as the run uid to allow it: the tool could then
 * switch back.
 */
export function isolatedBashOperations(ids: ToolIds): BashOperations {
  const switches = setprivSwitches(ids);
  return {
    exec: async (command, cwd, { onData, signal, timeout, env }) => {
      if (signal?.aborted) throw new Error("aborted");
      if (timeout !== undefined && !(Number.isFinite(timeout) && timeout > 0))
        throw new Error("Invalid timeout: must be a finite number of seconds");
      try {
        await access(cwd);
      } catch {
        throw new Error(`Working directory does not exist: ${cwd}\nCannot execute bash commands.`);
      }
      const child = spawn("setpriv", [...switches, "--", shellPath(), "-c", command], {
        cwd,
        env: env ?? process.env,
        detached: true,
        stdio: ["ignore", "pipe", "pipe"],
      });
      const pgid = child.pid;
      // The group's end, as the tool uid. Best effort: a failure leaves the
      // command running, as pi's own kill does when it cannot signal.
      const killGroup = (): void => {
        if (pgid === undefined) return;
        try {
          spawn(
            "setpriv",
            [...switches, "--", shellPath(), "-c", 'kill -KILL -- "-$0" 2>/dev/null', String(pgid)],
            // found where the command's own setpriv was
            { stdio: "ignore", env: { PATH: env?.["PATH"] ?? process.env["PATH"] } },
          )
            .once("error", () => {})
            .unref();
        } catch {
          // setpriv could not be started: nothing more can be done from here
        }
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
        child.stdout.on("data", onData);
        child.stderr.on("data", onData);
        const exitCode = await new Promise<number | null>((resolve, reject) => {
          let exited = false;
          let code: number | null = null;
          let idle: NodeJS.Timeout | undefined;
          const done = (): void => {
            if (idle) clearTimeout(idle);
            child.stdout.destroy();
            child.stderr.destroy();
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
          child.stdout.on("data", () => exited && arm());
          child.stderr.on("data", () => exited && arm());
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
