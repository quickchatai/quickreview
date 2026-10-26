// /qcr-scan's cases, in the person's own pi: each case one SDK session of
// this pi process (scan/scanleaves.ts `sdkCaseRunner`), the way /qcr-review
// runs its lenses. The read-only boundary is the reviewer's:
//   - bash-guard is the one extension of every case session, its tools the
//     scan leaf's read tools (the agent build's `SCAN_LEAF_TOOLS`);
//   - the session's cwd is the core's own data root, never the scanned
//     checkout, and nothing of the person's pi setup (extensions, skills,
//     settings, context files) reaches it;
//   - the file tools are fenced from the person's pi home and login.
// There is no scan sandbox here: the app's container (`qcr scan` with
// `[scan] sandbox = "docker"`) is the app's, and this is the plugin's own
// safe mode without it.
//
// The login is the host pi's, borrowed per case (login.ts): the host
// refreshes a short one first, and the case reads a refresh-disabled copy of
// only the providers the scan runs on. A provider pi has no login for stops
// the run with pi's /login as the fix. Nothing here owns the process: a
// turn its abort and dispose did not end stops the run instead.
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import {
  AuthExpiring,
  PI_REFRESH_MARGIN_MS,
  SCAN_CASE_AUTH_BUDGET_MS,
  copyPiAuth,
  engineCredentials,
  type AuthCopyWords,
} from "../engine/auth.js";
import type { Runtime, RuntimeSession } from "../engine/port.js";
import type { CaseRunner } from "../scan/scanports.js";
import { sdkCaseRunner } from "../scan/scanleaves.js";
import { borrowLogin } from "./login.js";
import type { PluginHost } from "./session.js";

/** What a refused login says inside pi: pi's own /login is the fix. */
export const SCAN_AUTH_WORDS: AuthCopyWords = {
  missing: (src) => `no pi login at ${src}: run /login in pi, then /qcr-scan again`,
  expiring: ({ provider, expiresAt, needMs }) =>
    `your ${provider ?? "pi"} login expires at ${new Date(expiresAt).toISOString()}, inside a scan case's ${Math.round(needMs / 60_000)}-minute window, and pi did not renew it. Run /login${provider ? ` ${provider}` : ""} in pi, then /qcr-scan again.`,
};

/** One case's wall clock in a person's pi: the login is borrowed for it. */
export const PLUGIN_CASE_MS = SCAN_CASE_AUTH_BUDGET_MS;

/** Where each case's private agent dir is made, under the scan's state home. */
export const CASE_AGENT_DIRS = "scan/plugin-agent";

export interface PluginScanCasesOptions {
  /** The host pi, as the latest command saw it: each case borrows its login. */
  host: () => PluginHost;
  /** The core's data root: the cases' cwd. */
  root: string;
  /** The scan's state home. */
  home: string;
  /** The providers the scan's models name (login.ts `reviewProviders`). */
  providers: readonly string[];
  agentsDir: string;
  transcriptDir: string;
  /** Stops the run, saying why. */
  stop: (reason: string) => void;
}

/** A session that releases what it was built on when it is released. */
function releasing(s: RuntimeSession, release: () => void): RuntimeSession {
  return new Proxy(s, {
    get(target, key) {
      if (key === "dispose")
        return async () => {
          try {
            await target.dispose();
          } finally {
            release();
          }
        };
      const v: unknown = Reflect.get(target, key, target);
      return typeof v === "function" ? (v as (...a: unknown[]) => unknown).bind(target) : v;
    },
  });
}

/** The case runner /qcr-scan runs on: SDK sessions of this pi. */
export function pluginScanCases(o: PluginScanCasesOptions): CaseRunner {
  const first = o.host();
  return sdkCaseRunner({
    agentsDir: o.agentsDir,
    cwd: o.root,
    transcriptDir: o.transcriptDir,
    env: { ...first.env, HOME: first.home },
    home: first.home,
    timeoutMs: PLUGIN_CASE_MS,
    runtime: async (extras): Promise<Runtime> => {
      const host = o.host();
      const borrowed = await borrowLogin({
        providers: o.providers,
        host: host.auth,
        needMs: PLUGIN_CASE_MS,
        marginMs: PI_REFRESH_MARGIN_MS,
      });
      if (!borrowed.ok) {
        const msg = borrowed.error.replaceAll("/qcr-review", "/qcr-scan");
        o.stop(msg);
        throw new AuthExpiring(msg);
      }
      // A private agent dir per case: the borrowed providers' login, a
      // refresh-disabled copy, and the person's custom provider list.
      const base = join(o.home, CASE_AGENT_DIRS);
      mkdirSync(base, { recursive: true, mode: 0o700 });
      const agentDir = mkdtempSync(join(base, "case-"));
      const release = (): void => rmSync(agentDir, { recursive: true, force: true });
      try {
        copyPiAuth({
          srcDir: host.agentDir,
          dstDir: agentDir,
          needMs: PLUGIN_CASE_MS,
          words: SCAN_AUTH_WORDS,
          providers: borrowed.providers,
        });
        const models = join(host.agentDir, "models.json");
        if (existsSync(models)) copyFileSync(models, join(agentDir, "models.json"));
        const auth = engineCredentials({
          srcDir: agentDir,
          needMs: PLUGIN_CASE_MS,
          // the host pi renewed the login for this case's window just now
          marginMs: 0,
          words: SCAN_AUTH_WORDS,
        });
        // The SDK loads with the first case: a preview, a refusal and a scan
        // with nothing to read never load it.
        const [{ PiHost }, { sdkRuntime }] = await Promise.all([
          import("../engine/pisdk.js"),
          import("../engine/sdkruntime.js"),
        ]);
        const pi = await PiHost.create({
          agentDir,
          hostPi: true,
          homeDir: host.home,
          fenceDirs: [host.agentDir],
          credentials: auth.credentials,
        });
        const done = (): void => {
          pi.dispose();
          release();
        };
        const rt = sdkRuntime(pi, {
          extras,
          // A turn its abort and dispose did not end: the run stops, and pi
          // keeps running.
          backstop: (reason) =>
            o.stop(
              `a scan case did not stop at its ${reason === "cap" ? "dollar cap" : "time limit"}`,
            ),
        });
        return {
          ...rt,
          create: async (spec) => {
            try {
              return releasing(await rt.create(spec), done);
            } catch (err) {
              done();
              throw err;
            }
          },
        };
      } catch (err) {
        release();
        if (err instanceof AuthExpiring) o.stop(err.message);
        throw err;
      }
    },
  });
}
