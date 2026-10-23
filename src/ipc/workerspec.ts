// What a round worker asks the daemon for over the socket, and what the daemon
// answers (P8.3). Neutral, like the rest of src/ipc/: shapes and a validator,
// no engine, no pi, no state store.
//
// A worker never opens state.db. Everything it needs to know about its command
// arrives through `worker.spec`, and the held wakes through `wakes.take` and
// `wakes.ack`; everything it records goes back as events (protocol.ts). The
// daemon side of the three ops is the WorkerSupervisor's (P8.5), serving the
// wakes through HeldWakeHandoff (src/wakes.ts, P8.6); the worker treats a daemon
// that does not know `wakes.take` as one holding no wakes.
import { join } from "node:path";
import { IpcError } from "./protocol.js";

export const WORKER_SPEC_OP = "worker.spec";
export const WAKES_TAKE_OP = "wakes.take";
export const WAKES_ACK_OP = "wakes.ack";

export const WORKER_MODES = ["round", "answer"] as const;
export type WorkerMode = (typeof WORKER_MODES)[number];

/** Everything a worker needs to serve one command, as plain data. The paths are
 * the daemon's own layout: the worker derives none of them. */
export interface WorkerSpec {
  mode: WorkerMode;
  command_id: string;
  pr: number;
  /** `pr-<n>`: the session's name, its OpenViking id and its live-log key. */
  session: string;
  /** The round the command belongs to; null for a command that is no round's. */
  round_no: number | null;
  /** The command's saved payload (the stamped round order or the message) and
   * the sha256 the daemon recorded for it at dispatch. */
  payload_path: string;
  payload_sha256: string;
  /** The production tree (`QCR_SANDBOX_ROOT`): prompts, extensions, agents, the
   * reviewer stub, the planned wave's task dirs under `state/`. */
  root: string;
  /** The session's cwd: the production tree's root, as for the tmux bot, where
   * bash-guard recognises the sanctioned scripts (a PR's worktree is reached by
   * path). */
  cwd: string;
  /** pi's agent dir: where the login is borrowed from (a refresh-blanked copy
   * in memory, never written back), and where models.json and the built lens
   * agents are read from. */
  agent_dir: string;
  /** Where the PR's main JSONL lives (`state/pi-sessions/pr-<n>`). The worker
   * resumes the newest one under it, or starts a session there at birth. */
  session_dir: string;
  system_prompt_file: string;
  model: string;
  /** What the model's tools see. Never a GitHub token (rule 3), and none of the
   * IPC names: the worker adds those to the main session's env itself. */
  env: Record<string, string>;
  /** Where the session's event stream and its diagnostics go. */
  events_file: string;
  stderr_file: string;
  /** The worker's wall-clock cap for the whole command, and the dollar cap. */
  wall_clock_ms: number;
  cap_usd?: number;
  /** `[pi] engine_wave`: start the round's planned discovery wave at round start. */
  planned_wave: boolean;
  /** Where this round's lens ledger and lens JSONLs go (D10). Omitted: under
   * `<root>/state/lens/<session>/r<round>`. */
  lens_dir?: string;
  /** Compact the conversation before exit (ledger-pin). Omitted: yes. */
  compact?: boolean;
  /** Milliseconds between the worker's heartbeat events. Omitted: 15 000. */
  heartbeat_ms?: number;
  /** An answer worker only (P8.17): the operator marked the message may-post, so
   * the session also gets the bash tool for the post scripts. The daemon sets it
   * from its own record of the command; it is never read from the payload alone. */
  may_post?: boolean;
  /** An answer worker only (P8.17): the round whose live log (`state/live/<key>/r<round>`)
   * its turns are appended to, so a viewer following the PR sees the answer. The
   * PR's newest round; omitted when it has none, and then no live log is written. */
  live_round?: number;
}

/** A coalesced delivery of held wakes: one user message for the session. */
export interface WakeBatch {
  /** Names the delivery. The worker marks the message with it, so a batch a
   * dead worker delivered but never acked is not delivered twice. */
  id: string;
  message: string;
}

export interface WakesTaken {
  batches: WakeBatch[];
}

function isRecord(x: unknown): x is Record<string, unknown> {
  return typeof x === "object" && x !== null && !Array.isArray(x);
}

function bad(why: string): never {
  throw new IpcError("bad_request", `worker spec: ${why}`);
}

function str(o: Record<string, unknown>, key: string): string {
  const x = o[key];
  if (typeof x !== "string" || x === "") return bad(`\`${key}\` must be a non-empty string`);
  return x;
}

function abs(o: Record<string, unknown>, key: string): string {
  const x = str(o, key);
  if (!x.startsWith("/")) return bad(`\`${key}\` must be an absolute path`);
  return x;
}

function nat(o: Record<string, unknown>, key: string): number {
  const x = o[key];
  if (typeof x !== "number" || !Number.isSafeInteger(x) || x < 0)
    return bad(`\`${key}\` must be a non-negative integer`);
  return x;
}

/** The daemon's answer to `worker.spec`, checked. Throws a typed `bad_request`:
 * a worker that cannot trust its spec does nothing. */
export function parseWorkerSpec(raw: unknown): WorkerSpec {
  if (!isRecord(raw)) return bad("not an object");
  const mode = raw["mode"];
  if (!WORKER_MODES.includes(mode as WorkerMode)) return bad("`mode` must be round or answer");
  const session = str(raw, "session");
  const pr = nat(raw, "pr");
  if (session !== `pr-${pr}`) return bad("`session` is not pr-<pr>");
  const sha = str(raw, "payload_sha256");
  if (!/^[a-f0-9]{64}$/.test(sha)) return bad("`payload_sha256` is not a sha256");
  const envRaw = raw["env"];
  if (!isRecord(envRaw)) return bad("`env` must be an object");
  const env: Record<string, string> = {};
  for (const [k, v] of Object.entries(envRaw)) {
    if (typeof v !== "string") return bad(`env.${k} must be a string`);
    env[k] = v;
  }
  const round = raw["round_no"];
  if (
    round !== null &&
    round !== undefined &&
    (!Number.isSafeInteger(round) || (round as number) < 0)
  )
    return bad("`round_no` must be a non-negative integer or null");
  const wall = nat(raw, "wall_clock_ms");
  if (wall === 0) return bad("`wall_clock_ms` must be positive");
  const spec: WorkerSpec = {
    mode: mode as WorkerMode,
    command_id: str(raw, "command_id"),
    pr,
    session,
    round_no: (round as number | null | undefined) ?? null,
    payload_path: abs(raw, "payload_path"),
    payload_sha256: sha,
    root: abs(raw, "root"),
    cwd: abs(raw, "cwd"),
    agent_dir: abs(raw, "agent_dir"),
    session_dir: abs(raw, "session_dir"),
    system_prompt_file: abs(raw, "system_prompt_file"),
    model: str(raw, "model"),
    env,
    events_file: abs(raw, "events_file"),
    stderr_file: abs(raw, "stderr_file"),
    wall_clock_ms: wall,
    planned_wave: raw["planned_wave"] === true,
  };
  if (raw["cap_usd"] !== undefined) {
    const cap = raw["cap_usd"];
    if (typeof cap !== "number" || !Number.isFinite(cap) || cap < 0)
      return bad("`cap_usd` must be a non-negative number");
    spec.cap_usd = cap;
  }
  if (raw["lens_dir"] !== undefined) spec.lens_dir = abs(raw, "lens_dir");
  if (raw["compact"] !== undefined) {
    if (typeof raw["compact"] !== "boolean") return bad("`compact` must be a boolean");
    spec.compact = raw["compact"];
  }
  if (raw["heartbeat_ms"] !== undefined) {
    const beat = nat(raw, "heartbeat_ms");
    if (beat === 0) return bad("`heartbeat_ms` must be positive");
    spec.heartbeat_ms = beat;
  }
  if (raw["live_round"] !== undefined) spec.live_round = nat(raw, "live_round");
  if (raw["may_post"] !== undefined) {
    if (typeof raw["may_post"] !== "boolean") return bad("`may_post` must be a boolean");
    spec.may_post = raw["may_post"];
  }
  return spec;
}

/** The daemon's answer to `wakes.take`, checked. */
export function parseWakesTaken(raw: unknown): WakesTaken {
  if (!isRecord(raw) || !Array.isArray(raw["batches"]))
    throw new IpcError("bad_request", "wakes.take: `batches` must be a list");
  const batches: WakeBatch[] = [];
  for (const b of raw["batches"] as unknown[]) {
    if (!isRecord(b)) throw new IpcError("bad_request", "wakes.take: a batch is not an object");
    const id = b["id"];
    const message = b["message"];
    if (typeof id !== "string" || !/^[A-Za-z0-9_.:-]{1,128}$/.test(id))
      throw new IpcError("bad_request", "wakes.take: a batch id has an invalid shape");
    if (typeof message !== "string" || message.trim() === "")
      throw new IpcError("bad_request", "wakes.take: a batch has no message");
    batches.push({ id, message });
  }
  return { batches };
}

/** The round's pass directory: its task files and its context pack. */
export function roundPassesDir(spec: Pick<WorkerSpec, "root" | "pr">, round: number): string {
  return join(spec.root, "state", `pr-${spec.pr}-round-${round}-passes`);
}

/** Where this round's lens ledger and lens JSONLs go (D10): the spec's own override, else
 * state/lens/<session>/r<round>. */
export function lensDirOf(
  spec: Pick<WorkerSpec, "root" | "session" | "round_no" | "lens_dir">,
): string {
  return spec.lens_dir ?? join(spec.root, "state", "lens", spec.session, `r${spec.round_no ?? 0}`);
}
