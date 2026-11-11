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
// The model is the scan's one route, which the running pi resolved when the
// run started (scan.ts): every case's host is handed it as fixed, with the
// model object that pi resolved, so no case of one scan runs on another
// model. The login is the host pi's, borrowed per case for that route
// (login.ts): the host renews a short one first, and the case holds a
// refresh-disabled copy of the route's providers alone, in memory. A login
// the host could not renew stops the run with pi's /login as the fix. The
// case's private agent dir holds no login file; it gets pi's two catalog
// files, so its host knows the models the running pi knows. Nothing here
// owns the process: a turn its abort and dispose did not end stops the run
// instead.
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { AuthExpiring, SCAN_CASE_AUTH_BUDGET_MS } from "../engine/auth.js";
import type { Runtime, RuntimeSession } from "../engine/port.js";
import { readModelChoice } from "../modelchoice.js";
import { refusalText } from "../modelroute.js";
import { copyCatalogFiles } from "../reviewhost.js";
import type { CaseRunner } from "../scan/scanports.js";
import { sdkCaseRunner } from "../scan/scanleaves.js";
import { borrowLogin, type RunLogin } from "./login.js";
import type { PluginHost } from "./session.js";

/** A refusal the route words for a review, said of a scan: the command to
 * run again and the thing that was refused are the scan's. */
export function scanWords(text: string): string {
  return text
    .replaceAll("/qcr-review", "/qcr-scan")
    .replaceAll("this review", "this scan")
    .replaceAll("the review", "the scan");
}

/** One case's wall clock in a person's pi: the login is borrowed for it. */
export const PLUGIN_CASE_MS = SCAN_CASE_AUTH_BUDGET_MS;

/** Where each case's private agent dir is made, under the scan's state home. */
export const CASE_AGENT_DIRS = "scan/plugin-agent";

/** One scan's route, as its cases take it. */
export type ScanCaseRoute = Pick<RunLogin, "route" | "providers"> & {
  /** pi's display name for a provider id. */
  nameOf: (provider: string) => string;
};

export interface PluginScanCasesOptions {
  /** The host pi, as the latest command saw it: each case borrows its login. */
  host: () => PluginHost;
  /** The core's data root: the cases' cwd. */
  root: string;
  /** The scan's state home. */
  home: string;
  /** The route of the run in flight, as its start resolved it (scan.ts):
   * the fixed route each case's host is handed, and the providers whose
   * logins a case borrows. Read per case: the runner outlives one command.
   * Answering nothing (a host that hands no registry): each case's host
   * resolves its own route from the whole borrowed login. */
  route: () => ScanCaseRoute | undefined;
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

/**
 * Make one case's private agent dir under the scan's state home `home`. It
 * holds pi's two catalog files as the host pi's agent dir has them (the
 * person's own providers, and the models pi learned since its build), so the
 * case's host knows the models the running pi resolved the route over. It
 * holds no login: the case's host has the borrowed one in memory.
 */
export function makeCaseAgentDir(hostAgentDir: string, home: string): string {
  const base = join(home, CASE_AGENT_DIRS);
  mkdirSync(base, { recursive: true, mode: 0o700 });
  const agentDir = mkdtempSync(join(base, "case-"));
  try {
    copyCatalogFiles(hostAgentDir, agentDir);
  } catch (err) {
    rmSync(agentDir, { recursive: true, force: true });
    throw err;
  }
  return agentDir;
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
      const on = o.route();
      const refuse = (msg: string): never => {
        o.stop(msg);
        throw new AuthExpiring(msg);
      };
      let borrowed: Awaited<ReturnType<typeof borrowLogin>>;
      try {
        borrowed = await borrowLogin({
          agentDir: host.agentDir,
          host: host.auth,
          needMs: PLUGIN_CASE_MS,
          ...(on !== undefined ? { providers: on.providers, nameOf: on.nameOf } : {}),
        });
      } catch (err) {
        // A login file that is there and cannot be read: no case can run.
        return refuse(err instanceof Error ? err.message : String(err));
      }
      if (!borrowed.ok)
        return refuse(
          scanWords(refusalText(borrowed.refusal, "plugin", { needMs: PLUGIN_CASE_MS })),
        );
      // A private agent dir per case, holding pi's catalog and no login.
      const agentDir = makeCaseAgentDir(host.agentDir, o.home);
      const release = (): void => rmSync(agentDir, { recursive: true, force: true });
      try {
        const choice = on === undefined ? readModelChoice(host.agentDir).choice : undefined;
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
          credentials: borrowed.credentials,
          route:
            on !== undefined
              ? on.route
              : { skipped: borrowed.skipped, ...(choice !== undefined ? { choice } : {}) },
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
        throw err;
      }
    },
  });
}
