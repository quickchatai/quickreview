// Moved to packages/pi-plugin/src/engine/auth.ts (P2.10). Kept as a re-export because the scan
// container imports `dist/src/scanauth.js` by path (src/scanbox.ts), and the
// companion image that carries that path is rebuilt on the owner's schedule.
// `syncScanAuthFromEnv` lives here: it is the container's one-shot probe, a
// host that owns its process (the engine never exits one).
import { SCAN_AUTH_SRC_ENV, syncScanAuth } from "@quickchatai/pi-quickreview/src/engine/auth.js";

export {
  SCAN_AUTH_FIX,
  SCAN_AUTH_SRC_ENV,
  SCAN_CASE_AUTH_BUDGET_MS,
  scanAuthCases,
  scanAuthExpiring,
  scanAuthMissing,
  scanCasesForEnv,
  syncScanAuth,
  type CaseRefused,
  type CaseRunnerOf,
} from "@quickchatai/pi-quickreview/src/engine/auth.js";

/** The container's one-shot copy (the doctor's probe): from the paths its
 * env names, the copy made or the refusal on stderr and exit 1. */
export function syncScanAuthFromEnv(env: NodeJS.ProcessEnv, needMs: number): void {
  const srcDir = env[SCAN_AUTH_SRC_ENV]?.trim();
  const dstDir = env["PI_CODING_AGENT_DIR"]?.trim();
  if (!srcDir || !dstDir) {
    console.error(`scan auth: ${SCAN_AUTH_SRC_ENV} and PI_CODING_AGENT_DIR must both be set`);
    process.exit(1);
  }
  try {
    syncScanAuth({ srcDir, dstDir, needMs });
  } catch (err) {
    console.error(`scan auth: ${err instanceof Error ? err.message : String(err)}`);
    process.exit(1);
  }
}
