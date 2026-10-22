// The read client behind pr-context.sh, pr-checks.sh, pr-threads.sh and
// pr-self.sh on a host the daemon runs: the daemon makes the GitHub
// read (src/ghread.ts) with the App's installation token, which this process,
// running as the model's tool uid, can neither read nor mint.
//
//   node dist/src/ipc/ghreadshim.js get <path> <outfile>
//   node dist/src/ipc/ghreadshim.js graphql <query-name> <outfile> <variables-json>
//
// It writes GitHub's body to <outfile> and prints GitHub's status on stdout, as
// `curl -o <outfile> -w '%{http_code}'` does, so a script swaps one for the
// other. A body the daemon cut says so on stderr. A read the daemon refused, or
// a socket that cannot be reached, is a line on stderr and exit 1, with nothing
// printed on stdout.
import { writeFileSync } from "node:fs";
import { connectFromEnv, type IpcEnv } from "./client.js";
import { IpcError } from "./protocol.js";

const OP = "github.read";
const USAGE =
  "usage: ghreadshim get <path> <outfile> | graphql <query-name> <outfile> <variables-json>";

/** A read can wait on GitHub's own 60 s deadline, once more after a re-mint. */
const READ_TIMEOUT_MS = 150_000;
/** A 4 MiB body, JSON-escaped, fits well inside this. */
const MAX_ANSWER_LINE = 64 * 1024 * 1024;

export interface ReadShimIo {
  stdout(text: string): void;
  stderr(text: string): void;
  write(file: string, body: string): void;
}

const processIo: ReadShimIo = {
  stdout: (t) => void process.stdout.write(t),
  stderr: (t) => void process.stderr.write(t),
  write: (f, b) => writeFileSync(f, b),
};

/** The request body for the arguments, or an IpcError naming the usage. */
export function readRequest(args: readonly string[]): {
  body: Record<string, unknown>;
  out: string;
} {
  const [sub, what, out, vars] = args;
  if (!what || !out) throw new IpcError("bad_request", USAGE);
  if (sub === "get" && args.length === 3) return { body: { kind: "rest", path: what }, out };
  if (sub === "graphql" && args.length === 4) {
    let variables: unknown;
    try {
      variables = JSON.parse(vars ?? "");
    } catch {
      throw new IpcError("bad_request", "the variables are not JSON");
    }
    return { body: { kind: "graphql", name: what, variables }, out };
  }
  throw new IpcError("bad_request", USAGE);
}

export async function runReadShim(
  args: readonly string[],
  env: IpcEnv = process.env,
  io: ReadShimIo = processIo,
): Promise<number> {
  let client;
  try {
    const { body, out } = readRequest(args);
    client = await connectFromEnv("shim", env, {
      timeoutMs: READ_TIMEOUT_MS,
      maxLineBytes: MAX_ANSWER_LINE,
    });
    const a = await client.request<{ status?: unknown; body?: unknown; truncated?: unknown }>(
      OP,
      body,
      { timeoutMs: READ_TIMEOUT_MS },
    );
    if (typeof a?.status !== "number" || typeof a.body !== "string")
      throw new IpcError("internal", "the daemon's answer has no status and body");
    io.write(out, a.body);
    if (a.truncated === true) io.stderr("ghread: the body was cut at the daemon's cap\n");
    io.stdout(String(a.status));
    return 0;
  } catch (e) {
    const err = e instanceof IpcError ? e : new IpcError("internal", String(e));
    io.stderr(`ghread: ${err.code}: ${err.message}\n`);
    return 1;
  } finally {
    client?.close();
  }
}

// Run only as the entry point, not when a test imports runReadShim.
if (process.argv[1]?.endsWith("ghreadshim.js")) {
  void runReadShim(process.argv.slice(2)).then((code) => process.exit(code));
}
