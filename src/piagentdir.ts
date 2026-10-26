// pi's agent dir, the way pi itself finds it: a leaf, so the npm verbs
// (src/npmverbs.ts) and the home's login reader (src/home/adapters.ts) read
// one rule without importing each other.
import { homedir } from "node:os";
import { join } from "node:path";

/** pi's agent dir: `$PI_CODING_AGENT_DIR`, else `~/.pi/agent`, as pi reads it. */
export function piAgentDir(env: Readonly<Record<string, string | undefined>>): string {
  const set = (env["PI_CODING_AGENT_DIR"] ?? "").trim();
  if (set !== "") return set;
  return join((env["HOME"] ?? "").trim() || homedir(), ".pi", "agent");
}
