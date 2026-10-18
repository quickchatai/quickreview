// The scan sandbox's pi login. There is one login: the companion's pi home,
// which is also the only refresher. The scan container mounts the companion's
// agent dir READ-ONLY at a source path (src/scanbox.ts) and, before every
// case, re-takes a private copy of its auth.json into the container's own pi
// agent dir with every refresh token neutralised (src/piauthcopy.ts, the copy
// the benchmark takes). So a scan never refreshes, never writes anything the
// companion reads, and picks up a token the companion refreshed at its next
// case. The price: a scan case cannot outlive the access token, so a case
// whose budget the token would not cover is refused before it starts, and the
// run is stopped with the fix.

import { CASE_STOP_GRACE_MS } from "./casebudget.js";
import { homedir } from "node:os";
import { join } from "node:path";
import { AuthExpiring, copyPiAuth, type AuthCopyWords } from "./piauthcopy.js";

/** The scan engine's case runner (src/setup/engine.ts `CaseRunner`), by
 * shape: this module stays outside src/setup/. */
export interface CaseRunnerOf<S, O> {
  run(spec: S, signal: AbortSignal, onCost?: (spentSoFar: number) => void): Promise<O>;
}
/** A case the copy refused: it never started, so it spent nothing. */
export type CaseRefused = { ok: false; reason: string; cost_usd: number };

/** Set in the scan container: where the companion's agent dir is mounted
 * read-only. Its presence is what makes the driver copy before each case. */
export const SCAN_AUTH_SRC_ENV = "QCR_SCAN_AUTH_SRC";
/** The time a scan case may take, which the access token must outlive. */
export const SCAN_CASE_AUTH_BUDGET_MS = 30 * 60_000;

/** The way out of a refused copy: the companion refreshes its own login. */
export const SCAN_AUTH_FIX =
  "open the companion so its pi refreshes the login (or run `qcr scan login`), then start the scan again";

export function scanAuthMissing(src: string): string {
  return `no pi login in the companion's pi home (${src}) — run \`qcr scan login\` to log the companion's pi in`;
}

export function scanAuthExpiring(o: {
  provider: string | null;
  expiresAt: number;
  needMs: number;
}): string {
  return (
    `the companion's ${o.provider ?? "pi"} access token expires at ${new Date(o.expiresAt).toISOString()}, inside a scan case's ${Math.round(o.needMs / 60_000)}-minute budget. ` +
    "A scan never refreshes it (a second refresher would invalidate the companion's own grant) — " +
    `${SCAN_AUTH_FIX}.`
  );
}

const SCAN_AUTH_WORDS: AuthCopyWords = { missing: scanAuthMissing, expiring: scanAuthExpiring };

/** Copy the companion's login from `srcDir` into the scan's agent dir
 * `dstDir`, refresh-disabled. Throws `AuthExpiring` when there is none, or
 * when its token would expire inside `needMs`. */
export function syncScanAuth(o: {
  srcDir: string;
  dstDir: string;
  needMs: number;
  now?: () => number;
}): { expiresAt: number | null } {
  return copyPiAuth({ ...o, words: SCAN_AUTH_WORDS });
}

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

/** A case runner over the borrowed login: before each case, the copy is
 * re-taken from the live source. A refused copy never starts the case — it
 * fails with the refusal and `onExpired` hears it, so the run can stop. */
export function scanAuthCases<S, O>(
  inner: CaseRunnerOf<S, O>,
  o: {
    srcDir: string;
    dstDir: string;
    needMs: number;
    now?: () => number;
    onExpired: (reason: string) => void;
  },
): CaseRunnerOf<S, O | CaseRefused> {
  return {
    run: async (spec, signal, onCost): Promise<O | CaseRefused> => {
      try {
        syncScanAuth(o);
      } catch (err) {
        const reason = err instanceof Error ? err.message : String(err);
        if (!(err instanceof AuthExpiring)) {
          return { ok: false, reason: `the login copy failed: ${reason}`, cost_usd: 0 };
        }
        o.onExpired(reason);
        return { ok: false, reason, cost_usd: 0 };
      }
      const bounded = new AbortController();
      const stop = (): void => bounded.abort();
      signal.addEventListener("abort", stop, { once: true });
      if (signal.aborted) stop();
      // Reserve the runner's forced-stop grace inside the login admission budget.
      const timer = setTimeout(stop, Math.max(0, o.needMs - CASE_STOP_GRACE_MS));
      timer.unref();
      try {
        // Wait for process cleanup and its final cost rather than racing a refusal.
        return await inner.run(spec, bounded.signal, onCost);
      } finally {
        clearTimeout(timer);
        signal.removeEventListener("abort", stop);
      }
    },
  };
}

/** The driver's case runner: over the borrowed login in the scan container
 * (its env names the read-only source), the plain runner anywhere else —
 * `sandbox = "host"` runs on the host pi's own login. */
export function scanCasesForEnv<S, O>(
  inner: CaseRunnerOf<S, O>,
  env: NodeJS.ProcessEnv,
  onExpired: (reason: string) => void,
): CaseRunnerOf<S, O | CaseRefused> {
  const srcDir = env[SCAN_AUTH_SRC_ENV]?.trim();
  if (!srcDir) return inner;
  const dstDir =
    env["PI_CODING_AGENT_DIR"]?.trim() || join(env["HOME"]?.trim() || homedir(), ".pi", "agent");
  return scanAuthCases(inner, { srcDir, dstDir, needMs: SCAN_CASE_AUTH_BUDGET_MS, onExpired });
}
