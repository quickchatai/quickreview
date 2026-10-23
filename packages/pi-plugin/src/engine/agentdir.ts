// What a pi agent dir hands an SDK host. The process route's pi reads these from
// the dir's files; an SDK host takes in-memory settings only.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { PiHostOptions } from "./pisdk.js";

/** What the process route's pi reads from the agent dir's settings.json and an
 * SDK host must be given instead (it takes in-memory settings only). */
export function agentDirSettings(agentDir: string): PiHostOptions["settings"] {
  try {
    const s = JSON.parse(readFileSync(join(agentDir, "settings.json"), "utf8")) as Record<
      string,
      unknown
    >;
    return {
      ...(s["retry"] !== undefined ? { retry: s["retry"] } : {}),
      ...(typeof s["httpIdleTimeoutMs"] === "number"
        ? { httpIdleTimeoutMs: s["httpIdleTimeoutMs"] }
        : {}),
    } as PiHostOptions["settings"];
  } catch {
    return {};
  }
}
