// `host go-live`: a host's attested operator takes the reviewer live.
//
// `dry_run` is the owner's flag, and on an install a host runs for a person
// the owner is that person: the one the host authenticated, who was shown a
// practice review and confirmed going live on it. The host says so in an
// attestation, on standard input and never on the command line:
//
//   { "operator":     { "host": "<the host's name>", "id": "<its id for the person>" },
//     "confirmed_at": "<ISO instant of the person's confirm>",
//     "proof":        { "pr": 412, "round_no": 1 } }
//
// The verb refuses unless all of these hold, and changes nothing when it
// refuses:
//
//   * the install is one a host manages: its config, as written, carries
//     `[github] token_source = "host"`. Only there is the person who owns the
//     flag the one a host authenticated; on any other install an attestation
//     admits nothing, whoever sends it;
//   * the proof is the practice round the checklist records;
//   * that round was returned by `host proof-result`, which is what marks a
//     practice review as shown;
//   * the confirm is under ten minutes old;
//   * the process was not started from an agent session.
//
// Then it starts the go-live walk, detached and under the checklist lock
// (one at a time), and answers `started`. The walk checks the attestation
// again, records it, and calls the existing go-live path, `runGoLive`
// (src/home/switchon.ts), with the confirm and nothing else. That path is the
// go-live step (src/onboard/steps/golive.ts): it re-verifies the practice
// round against the daemon's own state, flips the flag in a file that already
// states it, loads the result with the strict loader, and restarts the
// daemon. Nothing in this module, or under src/host/, writes `dry_run` or
// builds an edit of it; this module is one of the two callers the go-live
// path has (tests/host-fences.test.ts pins both).
//
// Nothing here writes to GitHub. The walk ends `done` once the go-live step
// has succeeded. The trigger label is the live daemon's own to make sure of,
// through the mutation gate (`create_label`, src/triggerlabel.ts), when it
// follows the label trigger; no host verb creates it.
//
// A repeat call on an install that is already live (the config reads
// `dry_run = false` and the attestation it went live on is on record) answers
// `done` and does nothing else: no go-live step, and no restart of a daemon
// that may be mid-round.
import { expiryInstant } from "@quickchatai/pi-quickreview/src/hosttoken.js";
import { readConfigToml } from "@quickchatai/pi-quickreview/src/shippedconfig.js";
import { acquireChecklistLock } from "../onboard/checklistlock.js";
import { runGoLive } from "../home/switchon.js";
import { admit, hostManaged, hostManagedRefusal } from "./admit.js";
import {
  refused,
  type GoLiveProblem,
  type HostAnswer,
  type HostProof,
  type HostReason,
} from "./outcomes.js";
import { lockOptions, type HostPorts } from "./ports.js";
import {
  attestationOf,
  proofWasShown,
  readHostRecord,
  recordedProofIn,
  updateHostRecord,
  type Attestation,
  type HostRecord,
} from "./record.js";
import { sessionMarker } from "./session.js";
import { adoptLock } from "./walk.js";

/** A confirm older than this no longer admits a go-live. */
export const CONFIRM_MAX_AGE_MS = 10 * 60_000;
/** How far ahead of this machine's clock a host's confirm may be. */
export const CONFIRM_SKEW_MS = 60_000;

export const GO_LIVE_USAGE =
  "usage: qcr --schema 3 host go-live, with the attestation as JSON on standard input";

/**
 * Why this attestation does not admit a go-live now, or null when it does.
 * `recorded` is the checklist's practice round; `record` holds the mark of
 * the round `proof-result` returned.
 */
export function attestationRefusal(
  a: Attestation,
  o: {
    now: number;
    recorded: Pick<HostProof, "pr" | "round_no"> | undefined;
    record: Pick<HostRecord, "proof_shown">;
  },
): { reason: HostReason; message: string } | null {
  if (o.recorded === undefined)
    return {
      reason: "proof_missing",
      message:
        "there is no practice review on record: going live is confirmed against one the person was shown",
    };
  if (o.recorded.pr !== a.proof.pr || o.recorded.round_no !== a.proof.round_no)
    return {
      reason: "proof_mismatch",
      message: `the confirm names #${a.proof.pr} round ${a.proof.round_no}, and the practice review on record is #${o.recorded.pr} round ${o.recorded.round_no}`,
    };
  if (!proofWasShown(o.record, o.recorded))
    return {
      reason: "proof_not_shown",
      message: `the practice review of #${o.recorded.pr} round ${o.recorded.round_no} was never returned by host proof-result, so nobody was shown it`,
    };
  const at = expiryInstant(a.confirmed_at);
  if (at === null)
    return { reason: "attestation_invalid", message: "confirmed_at is not an ISO 8601 instant" };
  if (at - o.now > CONFIRM_SKEW_MS)
    return { reason: "attestation_invalid", message: "confirmed_at is in the future" };
  if (o.now - at >= CONFIRM_MAX_AGE_MS)
    return {
      reason: "confirm_stale",
      message: "the confirm is ten minutes old or more: the person confirms again",
    };
  return null;
}

/** The `go-live` verb. */
export async function hostGoLive(ports: HostPorts, args: readonly string[]): Promise<HostAnswer> {
  const no = admit(ports);
  if (no !== null) return no;
  if (args.length > 0) return refused("usage", `host go-live takes no argument. ${GO_LIVE_USAGE}`);
  const unmanaged = hostManagedRefusal(
    ports,
    "this install's go-live is its owner's own, at the reviewer's home",
  );
  if (unmanaged !== null) return unmanaged;
  let sent: unknown;
  try {
    sent = JSON.parse(await ports.stdin());
  } catch {
    return refused("attestation_invalid", `no attestation was read. ${GO_LIVE_USAGE}`);
  }
  const attestation = attestationOf(sent);
  if (attestation === undefined)
    return refused(
      "attestation_invalid",
      "the attestation is not {operator: {host, id}, confirmed_at, proof: {pr, round_no}}. Nothing changed",
    );

  const got = acquireChecklistLock(ports.stateDir, "go_live", lockOptions(ports));
  if (!got.ok)
    return got.held.holder === "go_live"
      ? { state: "running" }
      : { state: "busy", holder: got.held.holder };
  const lock = got.lock;
  let handed = false;
  try {
    // Already live, on an attestation: there is nothing left to do, and
    // nothing is run again or restarted.
    if (alreadyLive(ports)) {
      const at = ports.now().toISOString();
      updateHostRecord(ports.stateDir, (r) => {
        const { attestation_pending: _none, ...rest } = r;
        return {
          ...rest,
          go_live: {
            state: "done",
            started_at: r.go_live?.started_at ?? at,
            updated_at: at,
          },
        };
      });
      return { state: "done" };
    }
    const why = attestationRefusal(attestation, {
      now: ports.now().getTime(),
      recorded: recordedProofIn(ports.stateDir),
      record: readHostRecord(ports.stateDir),
    });
    if (why !== null) return refused(why.reason, `${why.message}. Nothing changed`);

    const at = ports.now().toISOString();
    updateHostRecord(ports.stateDir, (r) => ({
      ...r,
      go_live: { state: "running", started_at: at, updated_at: at },
      attestation_pending: { ...attestation, received_at: at },
    }));
    const failed = (text: string): HostAnswer => {
      updateHostRecord(ports.stateDir, (r) => {
        const { attestation_pending: _dropped, ...rest } = r;
        return {
          ...rest,
          go_live: {
            state: "failed",
            problem: "internal_error",
            started_at: at,
            updated_at: ports.now().toISOString(),
          },
        };
      });
      return refused("launch_failed", `going live could not be started: ${text}`);
    };
    let child: ReturnType<HostPorts["launch"]>;
    try {
      child = ports.launch("go-live", lock.record.token);
    } catch (err) {
      return failed(err instanceof Error ? err.message : String(err));
    }
    if (!child.ok) return failed(child.error);
    if (!lock.handTo(child.pid)) return failed("the setup lock could not be handed to it");
    handed = true;
    return { state: "started" };
  } finally {
    if (!handed) lock.release();
  }
}

// ---- the walk -----------------------------------------------------------------------

/** The closed word for a go-live the step refused, from the name of its
 * first failed check (`runGoLive` says each as `name: detail`). */
export function goLiveProblem(detail: string): GoLiveProblem {
  const check = /^([a-z][a-z-]*): /.exec(detail)?.[1];
  switch (check) {
    case "proof":
      return "proof_unverified";
    case "config":
    case "flip":
    case "confirmed":
      return "config_failed";
    case "daemon-restart":
      return "restart_failed";
    default:
      return "go_live_failed";
  }
}

/**
 * Did this install go live on a host's attestation already? The config reads
 * `dry_run = false`, as the daemon reads it, and the record holds the
 * attestation with the time the go-live step succeeded on it. Anything less
 * (a flag that moved and a step that did not finish, a config that cannot be
 * read) is not: that go-live runs, or is refused, as any other.
 */
export function alreadyLive(
  ports: Pick<HostPorts, "read" | "configPath" | "template" | "stateDir">,
): boolean {
  if (readHostRecord(ports.stateDir).attestation?.live_at === undefined) return false;
  try {
    return readConfigToml(ports.read(ports.configPath), ports.template())["dry_run"] === false;
  } catch {
    return false;
  }
}

/**
 * Run the go-live walk under the lock `token` names. The process's exit
 * code: 0 when the go-live step succeeded (the reviewer is live), 1
 * otherwise. The host record says which.
 */
export async function walkGoLive(ports: HostPorts, token: string): Promise<number> {
  if (sessionMarker(ports.env) !== null || ports.inImage) {
    ports.log("host go-live: not run from an agent session or inside the stack's container");
    return 1;
  }
  const lock = await adoptLock(ports, token);
  if (lock === null) {
    ports.log("host go-live: no setup lock was handed to this walk; nothing was run");
    return 1;
  }
  const before = readHostRecord(ports.stateDir);
  const startedAt = before.go_live?.started_at ?? ports.now().toISOString();
  const end = (state: "done" | "failed", o: { problem?: GoLiveProblem } = {}): void => {
    updateHostRecord(ports.stateDir, (r) => {
      const { attestation_pending: _taken, ...rest } = r;
      return {
        ...rest,
        go_live: {
          state,
          ...(o.problem !== undefined ? { problem: o.problem } : {}),
          started_at: startedAt,
          updated_at: ports.now().toISOString(),
        },
      };
    });
  };
  try {
    // The attestation the verb admitted, admitted again: this walk goes live
    // on a confirm that is on record and still holds, and on nothing else.
    // And the install is still one a host manages: an attestation admits a
    // go-live there and nowhere else, whatever started this walk.
    const pending = before.attestation_pending;
    const why = !hostManaged(ports)
      ? { message: 'the config does not carry [github] token_source = "host"' }
      : pending === undefined
        ? { message: "no attestation is on record for this walk" }
        : attestationRefusal(pending, {
            now: ports.now().getTime(),
            recorded: recordedProofIn(ports.stateDir),
            record: before,
          });
    if (pending === undefined || why !== null) {
      ports.log(`host go-live: not admitted: ${why?.message ?? "unknown"}`);
      end("failed", { problem: "attestation_rejected" });
      return 1;
    }
    updateHostRecord(ports.stateDir, (r) => {
      const { attestation_pending: _taken, ...rest } = r;
      return { ...rest, attestation: { ...pending } };
    });
    const checklist = ports.checklist(ports.registry(), (l) => ports.log(l));
    // The existing go-live path, and nothing else. The confirm it is handed
    // is the attested operator's.
    const went = await runGoLive(checklist, { confirmed: true });
    ports.log(`host go-live: ${went.detail}`);
    if (!went.ok) {
      end("failed", { problem: goLiveProblem(went.detail) });
      return 1;
    }
    const liveAt = ports.now().toISOString();
    updateHostRecord(ports.stateDir, (r) => ({
      ...r,
      attestation: { ...pending, live_at: liveAt },
    }));
    end("done");
    return 0;
  } catch (err) {
    ports.log(
      `host go-live: the walk stopped: ${err instanceof Error ? err.message : String(err)}`,
    );
    try {
      end("failed", { problem: "internal_error" });
    } catch {
      // the record cannot be written either: the export says `interrupted`
    }
    return 1;
  } finally {
    lock.release();
  }
}
