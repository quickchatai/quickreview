// The scan's leaf runner on the SDK: the `CaseRunner` port
// (scanports.ts) over the runtime port, the in-process twin of
// `piCaseRunner` (caserunner.ts). One case is one session on the
// runtime, with the same pieces the child process gets: the agent file's model,
// tools and body (appended to pi's own system prompt), bash-guard the one
// extension, no skill and no context file, a cwd that is first-party ground and
// never the reviewed checkout, and the allowlisted env. The outcome, the reads
// and the kept transcript are read off the same event stream by the same
// reader (`caseReadout`), so a case answers identically whichever host ran it.
//
// It builds no host: the runtime a case runs on is the caller's (`runtime`),
// so this module loads no SDK. Two hosts hand one in: the `qcr scan` driver,
// a disposable one-scan process (src/engine/caserunner-sdk.ts
// `scanSdkCases`), and the pi plugin's /qcr-scan, inside the person's own pi.
import {
  appendFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import type { ExtensionFactory } from "@earendil-works/pi-coding-agent";
import { bashGuardConfigFromEnv, createBashGuard } from "../../extensions/bash-guard.js";
import { CASE_STOP_GRACE_MS } from "../casebudget.js";
import { splitModelSpec } from "../reviewconfig.js";
import { AuthError, SCAN_CASE_AUTH_BUDGET_MS } from "../engine/auth.js";
import {
  TRANSCRIPT_RUNS_KEPT,
  caseReadout,
  leafEnv,
  parseAgentFile,
  pruneTranscripts,
  stderrExcerpt,
  transcriptFile,
  type AgentFile,
} from "./caseread.js";
import type { CaseOutcome, CaseRunner, CaseSpec } from "./scanports.js";
import { LENS_SESSIONS_DIR } from "../engine/openable.js";
import type { Runtime, SessionSpec, TurnResult } from "../engine/port.js";
import type { SessionExtras } from "../engine/sdkruntime.js";

/** A leaf turn's hard wall clock. The login's own case budget
 * (`SCAN_CASE_AUTH_BUDGET_MS`) is the usual bound and aborts first; this one
 * only backs it where no login budget applies, and is kept past it so the
 * budget's last-resort step (it ends the process) never races the abort. */
export const LEAF_TURN_TIMEOUT_MS = SCAN_CASE_AUTH_BUDGET_MS + 15 * 60_000;

/** What the model's bash may draw from the leaf env, beyond pi's defaults:
 * certificates, proxies, XDG dirs and the temp dirs. Never a provider key. */
const LEAF_BASH_ENV_ALLOW: readonly string[] = [
  "TMP",
  "TEMP",
  "XDG_*",
  "SSL_CERT_FILE",
  "SSL_CERT_DIR",
  "NODE_EXTRA_CA_CERTS",
  "HTTP_PROXY",
  "HTTPS_PROXY",
  "NO_PROXY",
  "ALL_PROXY",
  "http_proxy",
  "https_proxy",
  "no_proxy",
  "all_proxy",
];

/** The per-session pieces the runner hands whoever builds the runtime: the
 * `extras` of `sdkRuntime` (packages/pi-plugin/src/engine/sdkruntime.ts). */
export type LeafExtras = (spec: SessionSpec) => SessionExtras;

export interface SdkCaseRunnerOptions {
  /** The scan agent build: `<agent>.md` files. */
  agentsDir: string;
  /** The leaf's working directory: first-party ground, never the reviewed
   * checkout (whose own pi config must not load). Also what a relative read is
   * resolved against. */
  cwd: string;
  /** Where each case's event stream is kept; absent, none is. */
  transcriptDir?: string;
  /** The env the leaf's env is filtered from. */
  env: NodeJS.ProcessEnv;
  /** The user's home: a read's `~` expands against it. */
  home: string;
  /** The model of an agent that names none. */
  defaultModel?: string;
  /** The runtime this case runs on, built with the case's `extras`. Called once
   * per case: a route that must re-read its login per case builds its host
   * here. */
  runtime: (extras: LeafExtras) => Runtime | Promise<Runtime>;
  /** The guard extension. Omitted: bash-guard over the leaf env. */
  guard?: ExtensionFactory;
  /** Wall clock for a case's turn. Omitted: `LEAF_TURN_TIMEOUT_MS`. */
  timeoutMs?: number;
}

/** A transcript's path under `dir`, relative and absolute, with its run
 * directory made (and the old runs pruned when it is new); null when it cannot
 * be made. A transcript is evidence, never a reason to fail a case. */
function openTranscript(dir: string, id: string): { rel: string; at: string } | null {
  try {
    const rel = transcriptFile(id);
    const at = join(dir, rel);
    const runDir = rel.includes("/") ? rel.slice(0, rel.indexOf("/")) : null;
    const fresh = runDir !== null && !existsSync(join(dir, runDir));
    mkdirSync(dirname(at), { recursive: true });
    if (fresh) pruneTranscripts(dir, TRANSCRIPT_RUNS_KEPT, runDir);
    writeFileSync(at, "", { mode: 0o600 });
    return { rel, at };
  } catch {
    return null;
  }
}

/** Where a case's session JSONL goes: `<run>/lens-sessions/<case>/` beside the
 * transcript `rel` names (`<run>/<case>.jsonl`). */
export function caseSessionDir(transcriptDir: string, rel: string): string {
  return join(transcriptDir, dirname(rel), LENS_SESSIONS_DIR, basename(rel, ".jsonl"));
}

/**
 * Runs a case as one SDK session, the way `piCaseRunner` runs it as one child:
 * the agent's model (its `:thinking` suffix as the session's thinking level),
 * its tools, its body appended to pi's system prompt, the task as the one
 * message. The answer is the last assistant message's text; the cost is pi's
 * own per-message accounting summed (null when it reported none); `reads` is the
 * `read`/`grep` calls that finished without an error, resolved against `cwd`.
 * With `transcriptDir` the session's whole event stream is kept at
 * `transcriptFile(spec.id)` under it, the format `pi --mode json` prints, and
 * its session JSONL beside it (`caseSessionDir`). An
 * abort stops the session (abort, then dispose after the stop grace). Every
 * outcome resolves — a runtime that cannot be built or a session that cannot
 * start is a failed case, never a rejection.
 */
export function sdkCaseRunner(opts: SdkCaseRunnerOptions): CaseRunner {
  return {
    run: async (
      spec: CaseSpec,
      signal: AbortSignal,
      onCost?: (spentSoFar: number) => void,
    ): Promise<CaseOutcome> => {
      if (!/^[a-z][a-z0-9-]*$/.test(spec.agent))
        return {
          ok: false,
          reason: `not an agent name: ${JSON.stringify(spec.agent)}`,
          cost_usd: 0,
        };
      let agent: AgentFile | null;
      try {
        agent = parseAgentFile(readFileSync(join(opts.agentsDir, `${spec.agent}.md`), "utf8"));
      } catch {
        return { ok: false, reason: `no agent ${spec.agent} in ${opts.agentsDir}`, cost_usd: 0 };
      }
      if (agent === null || agent.name !== spec.agent)
        return { ok: false, reason: `${spec.agent}.md is not an agent file`, cost_usd: 0 };
      const modelSpec = agent.model ?? opts.defaultModel;
      if (!modelSpec)
        return { ok: false, reason: `${spec.agent} names no model and none is set`, cost_usd: 0 };
      if (signal.aborted) return { ok: false, reason: "stopped before it started", cost_usd: 0 };

      let tmp: string;
      try {
        tmp = mkdtempSync(join(tmpdir(), "qcr-case-"));
      } catch (err) {
        return { ok: false, reason: `no temp directory for the case: ${String(err)}`, cost_usd: 0 };
      }
      let session: Awaited<ReturnType<Runtime["create"]>> | undefined;
      try {
        const env = leafEnv(opts.env);
        const { model, thinking } = splitModelSpec(modelSpec);
        const guard = opts.guard ?? createBashGuard(bashGuardConfigFromEnv(env, opts.cwd));
        const extras: LeafExtras = () => ({
          extensions: [guard],
          appendSystemPrompt: [agent.systemPrompt],
          bashEnv: { allow: LEAF_BASH_ENV_ALLOW },
          ...(thinking !== null
            ? { thinkingLevel: thinking as NonNullable<SessionExtras["thinkingLevel"]> }
            : {}),
        });
        // The transcript: opened before the session, appended event by event,
        // abandoned (and its name dropped from the outcome) at the first write
        // that fails.
        const opened =
          opts.transcriptDir !== undefined ? openTranscript(opts.transcriptDir, spec.id) : null;
        const sessionSpec: SessionSpec = {
          cwd: opts.cwd,
          env,
          model,
          ...(agent.tools.length > 0 ? { tools: agent.tools } : {}),
          name: spec.id,
          // The case's session JSONL beside its transcript, so the case
          // opens in pi: `qcr open <run dir> --lens <case>`.
          ...(opts.transcriptDir !== undefined && opened !== null
            ? { sessionDir: caseSessionDir(opts.transcriptDir, opened.rel) }
            : {}),
          eventsFile: join(tmp, "events.jsonl"),
          stderrFile: join(tmp, "stderr.txt"),
          limits: { timeoutMs: opts.timeoutMs ?? LEAF_TURN_TIMEOUT_MS },
        };

        let transcript: string | undefined = opened?.rel;
        let transcriptAt: string | null = opened?.at ?? null;
        const keep = (event: unknown): void => {
          if (transcriptAt === null) return;
          try {
            appendFileSync(transcriptAt, JSON.stringify(event) + "\n");
          } catch {
            transcriptAt = null;
            transcript = undefined;
          }
        };
        const readout = caseReadout(opts.cwd, opts.home, onCost);
        const finish = <T extends CaseOutcome>(o: T): T =>
          transcript === undefined ? o : { ...o, transcript };

        try {
          const runtime = await opts.runtime(extras);
          session = await runtime.create(sessionSpec);
        } catch (err) {
          const reason = err instanceof Error ? err.message : String(err);
          // A refused login already says what to do; anything else is the host's.
          return {
            ok: false,
            reason: err instanceof AuthError ? reason : `could not start the session: ${reason}`,
            cost_usd: 0,
          };
        }
        session.subscribe((event) => {
          keep(event);
          readout.feed(event);
        });

        let stopped = false;
        let hardStop: ((o: CaseOutcome) => void) | undefined;
        const gone = new Promise<CaseOutcome>((resolve) => {
          hardStop = resolve;
        });
        const onAbort = (): void => {
          stopped = true;
          const live = session;
          void live?.abort().catch(() => {});
          // The stop grace, then the session is released; a turn still not
          // settled a grace later is given up on, so the case resolves.
          setTimeout(() => void live?.dispose().catch(() => {}), CASE_STOP_GRACE_MS).unref();
          setTimeout(
            () => hardStop?.({ ok: false, reason: "stopped", cost_usd: readout.spent() }),
            2 * CASE_STOP_GRACE_MS,
          ).unref();
        };
        signal.addEventListener("abort", onAbort, { once: true });
        if (signal.aborted) {
          onAbort();
          // Cancelled while the session was being created: no turn starts.
          return finish({ ok: false, reason: "stopped", cost_usd: 0 });
        }

        const turn = (async (): Promise<CaseOutcome> => {
          let result: TurnResult;
          try {
            result = await session.prompt(`Task: ${spec.prompt}`);
          } catch (err) {
            return {
              ok: false,
              reason: `the session failed: ${err instanceof Error ? err.message : String(err)}`,
              cost_usd: readout.spent(),
            };
          }
          // What a case that ended without an answer had spent: a failure costs
          // money too, and a caller holding a budget must count it.
          const cost_usd = readout.spent();
          if (stopped) return { ok: false, reason: "stopped", cost_usd };
          if (result.timedOut)
            return { ok: false, reason: "the case ran past its wall clock", cost_usd };
          // The model's own reason leads: a provider error also ends the turn non-zero.
          if (readout.failure !== null) return { ok: false, reason: readout.failure, cost_usd };
          if (result.code !== 0) {
            let tail = "";
            try {
              tail = stderrExcerpt(readFileSync(sessionSpec.stderrFile, "utf8"));
            } catch {
              // No stderr to quote.
            }
            return {
              ok: false,
              reason: `the session ended without a result${tail ? `: ${tail}` : ""}`,
              cost_usd,
            };
          }
          if (readout.final.trim() === "")
            return { ok: false, reason: "the subagent gave no answer", cost_usd };
          return { ok: true, output: readout.final, cost_usd, reads: readout.reads };
        })();
        try {
          return finish(await Promise.race([turn, gone]));
        } finally {
          signal.removeEventListener("abort", onAbort);
        }
      } finally {
        try {
          await session?.dispose();
        } catch {
          // Already released.
        }
        rmSync(tmp, { recursive: true, force: true });
      }
    },
  };
}
