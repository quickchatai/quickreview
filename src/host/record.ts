// The host record: what the host verbs keep between calls, in one file beside
// the setup checklist (state/onboarding/host.json).
//
//   setup, go_live      how far a detached walk has got, and how it ended:
//                       what the board export prints as `setup` and `go_live`
//                       (and, for its walk alone, the `--trigger` a setup
//                       was given)
//   proof_request       the practice round `proof-start` asked for: the pull
//                       request, and the newest round that had already ended
//                       then, so only a later round answers it
//   proof_shown         the practice round `proof-result` returned. Going
//                       live is confirmed against a review a host has shown
//                       its operator, and this is the mark that it was
//                       returned to be shown
//   attestation_pending the attestation `go-live` admitted, until its walk
//                       takes it up
//   attestation         the attestation the go-live path was last run on:
//                       which operator of which host confirmed which practice
//                       round, when it was received, and when the reviewer
//                       went live on it (absent while it has not)
//
// It is written under the checklist lock (src/onboard/checklistlock.ts) by
// whoever holds it, tmp+rename, and read without it. The reader is total: a
// file that is absent, unreadable or not this shape reads as an empty record,
// and each part is taken only when every field of it is what it should be.
//
// `readHostProgress` is the board export's reader. A walk recorded as running
// whose process is gone did not finish: it is said as failed, `interrupted`,
// from the lock (which names the living holder, and is stale once the machine
// has booted again or its pid is another process's), and nothing is written.
import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { readChecklistFile } from "@quickchatai/pi-quickreview/src/setupchecklist.js";
import {
  checklistLockHolder,
  type LockHolder,
  type ProcessFacts,
} from "../onboard/checklistlock.js";
import { CHOICE_KEYS } from "../onboard/choices.js";
import {
  GO_LIVE_PROBLEMS,
  PROGRESS_STATES,
  SETUP_PROBLEMS,
  SETUP_STEPS,
  TRIGGER_WORDS,
  type GoLiveProblem,
  type HostProof,
  type ProgressState,
  type SetupProblem,
  type SetupStepId,
  type TriggerWord,
} from "./outcomes.js";

export const HOST_RECORD_VERSION = 1;

export function hostRecordPath(stateDir: string): string {
  return join(stateDir, "onboarding", "host.json");
}

/** Where the checklist lives under a state directory (src/onboard/engine.ts
 * `checklistPath`, restated here so the board export's reader stays a leaf). */
function checklistFile(stateDir: string): string {
  return join(stateDir, "onboarding", "checklist.json");
}

export interface SetupProgress {
  state: ProgressState;
  step?: SetupStepId;
  problem?: SetupProblem;
  /** The `--trigger` this setup was given, which its walk reads as it
   * starts and hands to the reviewer once it is up (the `set_trigger` step).
   * Absent: it was given none, and the reviewer's own choice stands. Not
   * printed by the export. */
  trigger?: TriggerWord;
  started_at: string;
  updated_at: string;
}

export interface GoLiveProgress {
  state: ProgressState;
  problem?: GoLiveProblem;
  started_at: string;
  updated_at: string;
}

export interface ProofRequest {
  pr: number;
  /** The newest round of the pull request that was not running when the
   * practice round was asked for; 0 when it had none. */
  floor: number;
  requested_at: string;
  /** The command file the request was written as, when one was: its receipt
   * says whether the daemon took it. */
  command?: string;
}

export interface ProofShown {
  pr: number;
  round_no: number;
  shown_at: string;
}

/** Who confirmed a go-live, as a host states it: the host's own name and its
 * own id for its authenticated operator. */
export interface Operator {
  host: string;
  id: string;
}

export interface Attestation {
  operator: Operator;
  confirmed_at: string;
  proof: { pr: number; round_no: number };
}

export interface HostRecord {
  version: number;
  setup?: SetupProgress;
  go_live?: GoLiveProgress;
  proof_request?: ProofRequest;
  proof_shown?: ProofShown;
  attestation_pending?: Attestation & { received_at: string };
  attestation?: Attestation & { received_at: string; live_at?: string };
}

// ---- reading ---------------------------------------------------------------------

type Obj = Record<string, unknown>;
const isObj = (v: unknown): v is Obj => typeof v === "object" && v !== null && !Array.isArray(v);
const str = (v: unknown): string | undefined => (typeof v === "string" && v !== "" ? v : undefined);
const posInt = (v: unknown): number | undefined =>
  typeof v === "number" && Number.isInteger(v) && v > 0 ? v : undefined;
const member = <T extends string>(set: readonly T[], v: unknown): T | undefined =>
  typeof v === "string" && (set as readonly string[]).includes(v) ? (v as T) : undefined;

function setupOf(v: unknown): SetupProgress | undefined {
  if (!isObj(v)) return undefined;
  const state = member(PROGRESS_STATES, v["state"]);
  const started = str(v["started_at"]);
  if (state === undefined || started === undefined) return undefined;
  const step = member(SETUP_STEPS, v["step"]);
  const problem = member(SETUP_PROBLEMS, v["problem"]);
  const trigger = member(TRIGGER_WORDS, v["trigger"]);
  return {
    state,
    ...(step !== undefined ? { step } : {}),
    ...(problem !== undefined ? { problem } : {}),
    ...(trigger !== undefined ? { trigger } : {}),
    started_at: started,
    updated_at: str(v["updated_at"]) ?? started,
  };
}

function goLiveOf(v: unknown): GoLiveProgress | undefined {
  if (!isObj(v)) return undefined;
  const state = member(PROGRESS_STATES, v["state"]);
  const started = str(v["started_at"]);
  if (state === undefined || started === undefined) return undefined;
  const problem = member(GO_LIVE_PROBLEMS, v["problem"]);
  return {
    state,
    ...(problem !== undefined ? { problem } : {}),
    started_at: started,
    updated_at: str(v["updated_at"]) ?? started,
  };
}

function requestOf(v: unknown): ProofRequest | undefined {
  if (!isObj(v)) return undefined;
  const pr = posInt(v["pr"]);
  const at = str(v["requested_at"]);
  const floor = v["floor"];
  if (pr === undefined || at === undefined) return undefined;
  if (typeof floor !== "number" || !Number.isInteger(floor) || floor < 0) return undefined;
  const command = str(v["command"]);
  return { pr, floor, requested_at: at, ...(command !== undefined ? { command } : {}) };
}

function shownOf(v: unknown): ProofShown | undefined {
  if (!isObj(v)) return undefined;
  const pr = posInt(v["pr"]);
  const round = posInt(v["round_no"]);
  const at = str(v["shown_at"]);
  return pr === undefined || round === undefined || at === undefined
    ? undefined
    : { pr, round_no: round, shown_at: at };
}

/** An attestation as a host sends it, or undefined when any part is missing
 * or the wrong shape. The instant is checked by whoever admits it. */
export function attestationOf(v: unknown): Attestation | undefined {
  if (!isObj(v) || !isObj(v["operator"]) || !isObj(v["proof"])) return undefined;
  const host = str(v["operator"]["host"]);
  const id = str(v["operator"]["id"]);
  const at = str(v["confirmed_at"]);
  const pr = posInt(v["proof"]["pr"]);
  const round = posInt(v["proof"]["round_no"]);
  if (host === undefined || id === undefined || at === undefined) return undefined;
  if (pr === undefined || round === undefined) return undefined;
  if (host.length > 64 || id.length > 128 || at.length > 40) return undefined;
  return { operator: { host, id }, confirmed_at: at, proof: { pr, round_no: round } };
}

/** The host record under `stateDir`; an empty one when there is none to read. */
export function readHostRecord(
  stateDir: string,
  read: (path: string) => string = (p) => readFileSync(p, "utf8"),
): HostRecord {
  let raw: unknown;
  try {
    raw = JSON.parse(read(hostRecordPath(stateDir)));
  } catch {
    return { version: HOST_RECORD_VERSION };
  }
  if (!isObj(raw)) return { version: HOST_RECORD_VERSION };
  const setup = setupOf(raw["setup"]);
  const goLive = goLiveOf(raw["go_live"]);
  const request = requestOf(raw["proof_request"]);
  const shown = shownOf(raw["proof_shown"]);
  const pending = attestationOf(raw["attestation_pending"]);
  const pendingAt = isObj(raw["attestation_pending"])
    ? str(raw["attestation_pending"]["received_at"])
    : undefined;
  const ran = attestationOf(raw["attestation"]);
  const ranObj: Obj = isObj(raw["attestation"]) ? raw["attestation"] : {};
  const ranAt = str(ranObj["received_at"]);
  const liveAt = str(ranObj["live_at"]);
  return {
    version: HOST_RECORD_VERSION,
    ...(setup !== undefined ? { setup } : {}),
    ...(goLive !== undefined ? { go_live: goLive } : {}),
    ...(request !== undefined ? { proof_request: request } : {}),
    ...(shown !== undefined ? { proof_shown: shown } : {}),
    ...(pending !== undefined && pendingAt !== undefined
      ? { attestation_pending: { ...pending, received_at: pendingAt } }
      : {}),
    ...(ran !== undefined && ranAt !== undefined
      ? {
          attestation: {
            ...ran,
            received_at: ranAt,
            ...(liveAt !== undefined ? { live_at: liveAt } : {}),
          },
        }
      : {}),
  };
}

// ---- writing ---------------------------------------------------------------------

/** Write the record whole: tmp+rename, so a reader never sees half of it. */
export function writeHostRecord(stateDir: string, record: HostRecord): void {
  const path = hostRecordPath(stateDir);
  mkdirSync(dirname(path), { recursive: true });
  const tmp = `${path}.${process.pid}.tmp`;
  writeFileSync(tmp, `${JSON.stringify(record, null, 2)}\n`, { mode: 0o600 });
  renameSync(tmp, path);
}

/** Read the record, change it, write it. The caller holds the checklist lock. */
export function updateHostRecord(
  stateDir: string,
  change: (record: HostRecord) => HostRecord,
): HostRecord {
  const next = change(readHostRecord(stateDir));
  writeHostRecord(stateDir, next);
  return next;
}

// ---- the board export's reader ----------------------------------------------------

/** What the board export prints of a host's long steps and practice review. */
export interface HostProgress {
  setup?: { state: ProgressState; step?: SetupStepId; problem?: SetupProblem };
  go_live?: { state: ProgressState; problem?: GoLiveProblem };
  proof?: HostProof;
}

/** The checklist's recorded practice round, each field checked; undefined
 * when the checklist holds none that is whole. */
export function recordedProofIn(
  stateDir: string,
): (HostProof & { review_shown: boolean }) | undefined {
  const raw = readChecklistFile(checklistFile(stateDir))?.choices[CHOICE_KEYS.proof];
  if (!isObj(raw)) return undefined;
  const pr = posInt(raw["pr"]);
  const round = posInt(raw["round_no"]);
  const verdict = str(raw["verdict"]);
  const at = str(raw["completed_at"]);
  return pr === undefined || round === undefined || verdict === undefined || at === undefined
    ? undefined
    : {
        pr,
        round_no: round,
        verdict,
        completed_at: at,
        review_shown: raw["review_shown"] === true,
      };
}

/** Was this recorded practice round returned by `proof-result`? */
export function proofWasShown(
  record: Pick<HostRecord, "proof_shown">,
  proof: { pr: number; round_no: number },
): boolean {
  const shown = record.proof_shown;
  return shown !== undefined && shown.pr === proof.pr && shown.round_no === proof.round_no;
}

/**
 * The `setup`, `go_live` and `proof` records under `stateDir`, for the board
 * export. Reads two files and the lock, and writes nothing.
 *
 * `proof` is the practice round a go-live would be admitted on: the one the
 * checklist records, and only once `proof-result` has returned it.
 */
export function readHostProgress(stateDir: string, o: ProcessFacts = {}): HostProgress {
  const record = readHostRecord(stateDir);
  const holder: LockHolder | undefined = checklistLockHolder(stateDir, o)?.holder;
  const out: HostProgress = {};
  if (record.setup !== undefined) {
    const s = record.setup;
    const lost = s.state === "running" && holder !== "setup";
    out.setup = {
      state: lost ? "failed" : s.state,
      ...(s.step !== undefined ? { step: s.step } : {}),
      ...(lost
        ? { problem: "interrupted" as const }
        : s.problem !== undefined
          ? { problem: s.problem }
          : {}),
    };
  }
  if (record.go_live !== undefined) {
    const g = record.go_live;
    const lost = g.state === "running" && holder !== "go_live";
    out.go_live = {
      state: lost ? "failed" : g.state,
      ...(lost
        ? { problem: "interrupted" as const }
        : g.problem !== undefined
          ? { problem: g.problem }
          : {}),
    };
  }
  const proof = recordedProofIn(stateDir);
  if (proof !== undefined && proofWasShown(record, proof))
    out.proof = {
      pr: proof.pr,
      round_no: proof.round_no,
      verdict: proof.verdict,
      completed_at: proof.completed_at,
    };
  return out;
}
