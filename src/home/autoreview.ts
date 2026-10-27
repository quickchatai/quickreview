// Auto-review in the home: its honest label, read from the daemon's
// container and its status snapshot, and the real switch over this machine's
// compose stack (src/home/switchon.ts runs the steps).
//
// The label:
//
//   off           the daemon's container is not running (switched off, or
//                 never brought up)
//   starting      it runs and its first poll has not ended yet, or the home
//                 is switching it on (the home holds that)
//   on-live/-dry  it runs, its heartbeat is within two poll intervals AND its
//                 last poll was clean; dry_run says which
//   paused-login  the login it reviews on expired (pi_auth_expired, or the
//                 login refresher's own record)
//   broken        it runs but is not working: the heartbeat or the poll is
//                 stale, the last poll failed, the container keeps
//                 restarting, or the pipeline or provider reports a cause
//   unknown       anything the home cannot read: Docker, the snapshot, or a
//                 snapshot from an older daemon with no `poll` record
//                 (invariant 9: never Off and never On)
import { readFileSync } from "node:fs";
import { parse } from "smol-toml";
import { snapshotHeartbeat } from "../state.js";
import { OnboardingEngine, type OnboardAdapters, type ProcessRunner } from "../onboard/engine.js";
import {
  CONTAINER_STATE_DIR,
  DAEMON_SERVICE,
  MEMORY_SERVICE,
  composeArgs,
  composePs,
  daemonExec,
  serviceRow,
} from "../onboard/steps/compose.js";
import {
  known,
  unknown,
  type AutoReviewControl,
  type AutoReviewPort,
  type AutoReviewStatus,
  type Known,
  type RunningRound,
  type SwitchResult,
} from "./ports.js";
import {
  MACHINE_CHECKS_STEP_ID,
  recordedProof,
  runGoLive,
  runProofRound,
  runSwitchOn,
  switchOnRegistry,
  type SwitchOnStepOptions,
} from "./switchon.js";

/** "On" needs a heartbeat within this many poll intervals. */
export const HEARTBEAT_INTERVALS = 2;
/** A poll older than this many intervals is not working: the daemon abandons
 * a pass after three (RECONCILE_OVERDUE_INTERVALS) and starts the next. */
export const POLL_STALE_INTERVALS = 4;

/** The daemon container, as Docker says. */
export type DaemonContainer = "running" | "restarting" | "stopped";

export interface AutoReviewReading {
  container: Known<DaemonContainer>;
  /** status.json's text, read while the container runs; null when the
   * daemon has written none. */
  snapshot: Known<string | null>;
  now: number;
}

const minutes = (ms: number): string => {
  const m = Math.max(0, Math.round(ms / 60_000));
  return m < 60 ? `${m}m` : `${Math.round(m / 60)}h`;
};

type Obj = Record<string, unknown>;
const isObj = (v: unknown): v is Obj => typeof v === "object" && v !== null && !Array.isArray(v);

/** status.json's text as an object; a reason when it is not one. */
function parseSnapshot(text: string): Obj | string {
  try {
    const v = JSON.parse(text) as unknown;
    return isObj(v) ? v : "its status.json is not an object";
  } catch {
    return "its status.json is not readable JSON";
  }
}

/** The refresher's record of the login, when the snapshot has one. */
function refresherLogin(s: Obj): Obj | null {
  const lr = s["login_refresh"];
  const login = isObj(lr) ? lr["login"] : undefined;
  return isObj(login) ? login : null;
}

/** A re-login ended the daemon's last auth failure: the refresher's record,
 * read after that failure, of a login that works now. It outweighs the
 * failure's flag, which would otherwise stand for its own half hour. */
function loginRecovered(s: Obj, now: number): boolean {
  const expired = s["pi_auth_expired"];
  const login = refresherLogin(s);
  return isObj(expired) && login !== null && worksSince(login, expired["last_at"], now);
}

/** Why the login it reviews on stops it, or null. A re-login ends the pause
 * (loginRecovered). */
function loginPause(s: Obj, now: number): string | null {
  const login = refresherLogin(s);
  if (isObj(s["pi_auth_expired"]) && !loginRecovered(s, now)) return "login expired";
  if (login === null) return null;
  if (login["paused"] === true) return "a login is in progress";
  const expires = typeof login["expires_at"] === "string" ? Date.parse(login["expires_at"]) : NaN;
  if (Number.isFinite(expires) && expires <= now && typeof login["last_error"] === "string")
    return "login expired";
  return null;
}

/** The refresher looked after `since` and found a login that works: not
 * paused, no error, a token not yet expired. */
function worksSince(login: Obj, since: unknown, now: number): boolean {
  const at = typeof since === "string" ? Date.parse(since) : NaN;
  const checked = typeof login["checked_at"] === "string" ? Date.parse(login["checked_at"]) : NaN;
  const expires = typeof login["expires_at"] === "string" ? Date.parse(login["expires_at"]) : NaN;
  return (
    Number.isFinite(at) &&
    Number.isFinite(checked) &&
    checked > at &&
    login["paused"] !== true &&
    login["last_error"] === null &&
    Number.isFinite(expires) &&
    expires > now
  );
}

/** The provider record the snapshot derives from that same auth failure
 * (src/state.ts writes the two together, with one `last_at`). */
function authDerived(s: Obj, pv: Obj): boolean {
  const expired = s["pi_auth_expired"];
  return (
    isObj(expired) && typeof pv["last_at"] === "string" && pv["last_at"] === expired["last_at"]
  );
}

/** The pipeline's or the provider's cause, or null. A provider failure that
 * is only the recovered login's own flag is not a cause; any other is. */
function brokenCause(s: Obj, now: number): string | null {
  const p = s["pipeline"];
  if (isObj(p) && p["healthy"] === false) {
    const first = Array.isArray(p["causes"]) ? (p["causes"][0] as unknown) : undefined;
    if (isObj(first)) {
      const pr = typeof first["pr"] === "number" ? `#${first["pr"]}: ` : "";
      const detail =
        typeof first["detail"] === "string" ? first["detail"] : "the pipeline is unhealthy";
      return `${pr}${detail}`;
    }
    return "the review pipeline reports itself unhealthy";
  }
  const pv = s["provider"];
  if (isObj(pv) && pv["healthy"] === false && !(authDerived(s, pv) && loginRecovered(s, now)))
    return typeof pv["detail"] === "string" ? pv["detail"] : "the model provider is failing";
  return null;
}

/** The label, from what was read. Pure. */
export function autoReviewLabel(r: AutoReviewReading): Known<AutoReviewStatus> {
  if (r.container.kind === "unknown")
    return unknown(`can't ask Docker whether the daemon runs: ${r.container.why}`);
  if (r.container.value === "stopped") return known({ state: "off" });
  if (r.container.value === "restarting")
    return known({
      state: "broken",
      cause: "the daemon keeps restarting (docker compose logs daemon says why)",
    });
  if (r.snapshot.kind === "unknown")
    return unknown(`can't read the daemon's status: ${r.snapshot.why}`);
  if (r.snapshot.value === null) return unknown("the daemon runs but has written no status yet");
  const s = parseSnapshot(r.snapshot.value);
  if (typeof s === "string") return unknown(s);
  const beat = Date.parse(snapshotHeartbeat(s) ?? "");
  if (!Number.isFinite(beat)) return unknown("its status has no heartbeat");
  const poll = s["poll"];
  if (!isObj(poll)) return unknown("its status has no poll record (an older daemon)");
  const interval = poll["interval_s"];
  if (typeof interval !== "number" || !(interval > 0))
    return unknown("its poll record has no poll interval");
  const step = interval * 1000;
  if (r.now - beat > HEARTBEAT_INTERVALS * step)
    return known({ state: "broken", cause: `no heartbeat for ${minutes(r.now - beat)}` });
  const paused = loginPause(s, r.now);
  if (paused) return known({ state: "paused-login", cause: paused });
  const lastAt = typeof poll["last_at"] === "string" ? Date.parse(poll["last_at"]) : null;
  if (poll["last_at"] === null) return known({ state: "starting" });
  if (lastAt === null || !Number.isFinite(lastAt))
    return unknown("its poll record has no readable time");
  const checkedAt = lastAt;
  if (poll["ok"] === false)
    return known({
      state: "broken",
      cause: `the last poll failed: ${typeof poll["error"] === "string" ? poll["error"] : "no reason given"}`,
      checkedAt,
    });
  if (poll["ok"] !== true) return unknown("its poll record does not say how the poll went");
  if (r.now - lastAt > POLL_STALE_INTERVALS * step)
    return known({
      state: "broken",
      cause: `no poll has finished for ${minutes(r.now - lastAt)}`,
      checkedAt,
    });
  const cause = brokenCause(s, r.now);
  if (cause) return known({ state: "broken", cause, checkedAt });
  if (s["dry_run"] === true) return known({ state: "on-dry", checkedAt });
  if (s["dry_run"] === false) return known({ state: "on-live", checkedAt });
  return unknown("its status does not say whether it runs in dry-run");
}

/** The rounds running now, from status.json's text. */
export function runningRounds(text: string): Known<readonly RunningRound[]> {
  const s = parseSnapshot(text);
  if (typeof s === "string") return unknown(s);
  if (!Array.isArray(s["prs"])) return unknown("its status lists no pull requests");
  const out: RunningRound[] = [];
  for (const p of s["prs"] as unknown[]) {
    if (!isObj(p) || typeof p["number"] !== "number" || !isObj(p["current_round"])) continue;
    const round = p["current_round"]["round_no"];
    out.push({ pr: p["number"], round: typeof round === "number" ? round : 0 });
  }
  return known(out);
}

/** "a review of #12 is running and will be stopped", for one or more. */
export function runningWarning(rounds: Known<readonly RunningRound[]>): string {
  if (rounds.kind === "unknown")
    return `Whether a review is running is unknown (${rounds.why}); one that is will be stopped.`;
  const n = rounds.value.map((r) => `#${r.pr}`);
  if (n.length === 0) return "Nothing is running now.";
  if (n.length === 1) return `A review of ${n[0]} is running and will be stopped.`;
  return `Reviews of ${n.slice(0, -1).join(", ")} and ${n[n.length - 1]} are running and will be stopped.`;
}

// ---- the real adapter: this machine's compose stack ----------------------

/** A container's state as Docker reports it, folded. */
export function containerState(state: string | undefined): "running" | "restarting" | "stopped" {
  if (state === undefined) return "stopped";
  if (/restarting/i.test(state)) return "restarting";
  return /running|up/i.test(state) ? "running" : "stopped";
}

/** One compose service's container, or unknown when Docker cannot answer. */
export async function serviceState(
  runner: ProcessRunner,
  root: string,
  service: string,
): Promise<Known<"running" | "restarting" | "stopped">> {
  const ps = await composePs(runner, root);
  if (!ps.ok) return unknown(ps.detail || "docker compose ps failed");
  return known(containerState(serviceRow(ps.rows, service)?.state));
}

const firstLine = (s: string): string => s.trim().split("\n")[0]?.trim() || "no output";
const message = (err: unknown): string => (err instanceof Error ? err.message : String(err));

/** The config's `[github]` table and root `dry_run`, read again each time. */
function readConfig(path: string, read: (p: string) => string): Obj | string {
  try {
    const v = parse(read(path)) as unknown;
    return isObj(v) ? v : `${path} is not a TOML table`;
  } catch (err) {
    return `can't read ${path}: ${message(err)}`;
  }
}

export interface ComposeAutoReviewOptions extends SwitchOnStepOptions {
  /** The app's root: the compose project directory, with `state/` under it. */
  root: string;
  configPath: () => string;
  runner: ProcessRunner;
  /** The wizard's adapters for the steps, with a line sink for progress. */
  stepAdapters: (log: (line: string) => void) => OnboardAdapters;
  now: () => number;
  read?: (p: string) => string;
}

/** Auto-review on this machine: Docker for the container, the daemon's own
 * status.json (inside its state volume) for the rest. */
export function composeAutoReview(o: ComposeAutoReviewOptions): AutoReviewPort {
  const read = o.read ?? ((p: string) => readFileSync(p, "utf8"));
  const statusText = async (): Promise<Known<string | null>> => {
    const r = await daemonExec(o.runner, o.root, ["cat", `${CONTAINER_STATE_DIR}/status.json`]);
    if (r.code === 0) return known(r.stdout);
    if (/no such file/i.test(r.stderr)) return known(null);
    return unknown(firstLine(r.stderr || r.stdout));
  };
  const config = (): Obj | string => readConfig(o.configPath(), read);
  const engine = (log: (line: string) => void): OnboardingEngine =>
    new OnboardingEngine(switchOnRegistry(o), o.stepAdapters(log));
  const dryRunNow = (): boolean | null => {
    const c = config();
    return typeof c === "string" ? null : typeof c["dry_run"] === "boolean" ? c["dry_run"] : null;
  };
  const compose = async (args: string[], what: string): Promise<SwitchResult> => {
    const r = await o.runner.run("docker", composeArgs(o.root, args));
    return r.code === 0
      ? { ok: true, detail: what }
      : {
          ok: false,
          detail: `docker compose ${args.join(" ")} exited ${r.code}: ${firstLine(r.stderr || r.stdout)}`,
        };
  };

  const control: AutoReviewControl = {
    machineChecks: async () => {
      const lines: string[] = [];
      const r = await engine((l) => lines.push(l)).runStep(MACHINE_CHECKS_STEP_ID);
      // the three the person is told about: Docker, disk, ports
      const said = r.checks
        .filter((c) => c.name === "docker" || c.name === "disk" || c.name === "ports")
        .map((c) => c.detail)
        .join(" · ");
      return r.ok ? { ok: true, detail: said } : { ok: false, detail: r.failures.join("; ") };
    },
    dryRun: async () => {
      const d = dryRunNow();
      return d === null ? unknown(`can't read dry_run from ${o.configPath()}`) : known(d);
    },
    switchOn: async (answers, progress) => {
      const c = config();
      const github = typeof c === "string" ? undefined : c["github"];
      const repo =
        isObj(github) && typeof github["repo"] === "string" && github["repo"] !== ""
          ? github["repo"]
          : null;
      return runSwitchOn({
        checklist: engine((l) => progress?.(l)),
        answers,
        repo,
        dryRun: dryRunNow,
        stopMemory: () => compose(["stop", MEMORY_SERVICE], "memory stopped"),
        startMemory: () => compose(["up", "-d", MEMORY_SERVICE], "the memory engine runs"),
        ...(progress ? { progress } : {}),
      });
    },
    proof: async () => {
      const p = recordedProof(engine(() => {}));
      return p ? { pr: p.pr, verdict: p.verdict } : null;
    },
    proofRound: (pr, progress) =>
      runProofRound(
        engine((l) => progress?.(l)),
        pr,
      ),
    goLive: (answers) =>
      runGoLive(
        engine(() => {}),
        answers,
      ),
    running: async () => {
      const t = await statusText();
      if (t.kind === "unknown") return t;
      return t.value === null ? known([]) : runningRounds(t.value);
    },
    switchOff: () => compose(["stop", DAEMON_SERVICE], "the daemon is stopped; its data is kept"),
  };

  return {
    status: async () => {
      const container = await serviceState(o.runner, o.root, DAEMON_SERVICE);
      const snapshot: Known<string | null> =
        container.kind === "known" && container.value === "running"
          ? await statusText()
          : known(null);
      return autoReviewLabel({ container, snapshot, now: o.now() });
    },
    trigger: async () => {
      const c = config();
      if (typeof c === "string") return unknown(c);
      const github = c["github"];
      const label = isObj(github) ? github["trigger_label"] : undefined;
      return typeof label === "string" && label.trim() !== ""
        ? known(label.trim())
        : unknown(`${o.configPath()} has no [github] trigger_label`);
    },
    control,
  };
}
