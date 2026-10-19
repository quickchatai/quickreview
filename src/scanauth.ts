// Moved to src/engine/auth.ts (P2.10). Kept as a re-export because the scan
// container imports `dist/src/scanauth.js` by path (src/scanbox.ts), and the
// companion image that carries that path is rebuilt on the owner's schedule.
export {
  SCAN_AUTH_FIX,
  SCAN_AUTH_SRC_ENV,
  SCAN_CASE_AUTH_BUDGET_MS,
  scanAuthCases,
  scanAuthExpiring,
  scanAuthMissing,
  scanCasesForEnv,
  syncScanAuth,
  syncScanAuthFromEnv,
  type CaseRefused,
  type CaseRunnerOf,
} from "./engine/auth.js";
