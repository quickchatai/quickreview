// The separate tool uid (D32): the image's entrypoint asks for the model's tools
// to run as another uid than the process that holds the token. An in-process
// host (an SDK session, a pi on its interactive UI) runs the model's bash as
// this process's uid, so it cannot give that, and refuses rather than run
// without it unless the shared uid is accepted.

/** The names the image's entrypoint sets when the model's tools must run as
 * another uid than this process (procruntime.ts `toolIsolation`, D32). */
export const TOOL_UID_ENVS = ["QCR_TOOL_UID", "QCR_TOOL_GID", "QCR_TOOL_UID_REQUIRED"] as const;

/** The host that runs the model's bash in this process, as this process's uid,
 * cannot give the tools the separate uid the image asks for. It refuses rather
 * than run without it, unless the shared uid is accepted. `host` words the
 * refusal for the caller (the SDK runtime by default). */
export function checkToolUid(
  env: NodeJS.ProcessEnv,
  host: { what: string; instead: string } = {
    what: "the SDK runtime",
    instead: "use [engine] runtime = proc here",
  },
): void {
  if (env["QCR_ALLOW_SHARED_TOOL_UID"] === "1") return;
  if (TOOL_UID_ENVS.some((n) => env[n]))
    throw new Error(
      `${host.what} runs the model's tools in this process, so it cannot run them as another uid, ` +
        `which this container asks for: ${host.instead}, or set ` +
        "QCR_ALLOW_SHARED_TOOL_UID=1 to accept the shared uid",
    );
}
