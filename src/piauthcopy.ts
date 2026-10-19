// Moved to src/engine/auth.ts (P2.10). Kept as a re-export because the scan
// container imports `dist/src/piauthcopy.js` by path (src/scanbox.ts), and the
// companion image that carries that path is rebuilt on the owner's schedule.
export {
  AuthExpiring,
  DISABLED_REFRESH,
  authCopyFrom,
  copyPiAuth,
  loginSummary,
  type AuthCopyWords,
  type LoginSummary,
} from "./engine/auth.js";
