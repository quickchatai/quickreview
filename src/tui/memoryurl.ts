// Where this host reaches OpenViking: the memory forward's loopback
// listener. A leaf module, so a reader of the URL (the wizard's memory step,
// the home) never imports the TUI's memory store or the companion.

/** The port the memory forward and the companion agree on, the server's own
 * in the VM container (`[openviking] port`). */
export const MEMORY_PORT = 1933;

/**
 * Where the TUI reaches OpenViking: the memory forward's loopback listener.
 *
 * `QCR_MEMORY_URL` overrides it wholesale; `QCR_MEMORY_PORT` matches the flag
 * the forward itself takes, so a non-default port only has to be spelled once.
 * `MEMORY_PORT` is the shared constant the forward and the companion already
 * agree on.
 */
export function tuiMemoryBaseUrl(env: NodeJS.ProcessEnv = process.env): string {
  const explicit = (env["QCR_MEMORY_URL"] ?? env["QCR_MEMORY_ENDPOINT"] ?? "").trim();
  if (explicit !== "") return explicit.replace(/\/+$/, "");
  const port = Number(env["QCR_MEMORY_PORT"] ?? MEMORY_PORT) || MEMORY_PORT;
  return `http://127.0.0.1:${port}`;
}
