// `qcr --schema 3 host <verb>`: the host contract's verbs (the `host` family,
// schemas/host.v1.json, packages/pi-plugin/src/contract.ts), for a host that
// runs the reviewer for a person it has authenticated itself.
//
//   setup --repo o/n (--auth user | --auth installation --app-slug s)
//         [--trigger label|all]
//                         write the config and start the reviewer, in dry-run
//                         (src/host/setup.ts, src/host/walk.ts)
//   review-now <pr>       review this pull request now
//   proof-start <pr>      ask for the practice review of one pull request
//   proof-result <pr>     the practice review, once its round has finished
//                         (src/host/proof.ts)
//   go-live               take the reviewer live, on the attestation sent on
//                         standard input; on one that is already live, try
//                         its trigger label again (src/host/golive.ts)
//   set-trigger label|all change which pull requests the reviewer picks up
//                         by itself: the labelled ones, or every one. The
//                         running daemon follows without a restart
//                         (src/host/trigger.ts)
//
// The verbs act for a host's attested operator, on installs a host manages
// (`[github] token_source = "host"`, src/host/admit.ts): `setup` makes a
// machine with no config one and refuses a config that is there without the
// marker, and `go-live` and `set-trigger` refuse any install without it.
//
// Every verb is non-interactive and answers within seconds: one JSON object
// on stdout, `schema_version` first (the number of the contract the caller
// named), then `verb`, then `state`, one of that verb's closed set
// (src/host/outcomes.ts). Long work is started detached and followed through
// the board export (`qcr --schema 3 board`: its `setup` and `go_live`
// fields). The exit code is 0 when the verb did what it was asked or says
// what is already under way, 2 for a call it could not read, 1 for any other
// refusal or failure; the object is printed in each case. A verb that is not
// one, or a run that cannot build its answer, prints nothing on stdout.
//
// `host walk <kind> <token>` is the detached half of `setup` and `go-live`:
// started by the verb, never by a caller. It prints no payload, and without
// the lock its verb handed over it does nothing.
import { hostPayloadVersion } from "@quickchatai/pi-quickreview/src/contract.js";
import { requestedContract } from "../schemaflag.js";
import { hostGoLive, walkGoLive } from "./golive.js";
import { HOST_VERBS, exitCodeOf, type HostAnswer, type HostVerb } from "./outcomes.js";
import { WALK_KINDS, realHostPorts, type HostPorts, type WalkKind } from "./ports.js";
import { hostProofResult, hostProofStart, hostReviewNow } from "./proof.js";
import { hostSetup } from "./setup.js";
import { hostSetTrigger } from "./trigger.js";
import { walkSetup } from "./walk.js";

export const HOST_USAGE = `usage: qcr --schema N host ${HOST_VERBS.join("|")} [arguments…]`;

export interface HostIo {
  /** The contract the caller named; default: the process's `--schema N`. */
  contract?: number;
  ports?: HostPorts;
  out?: (line: string) => void;
  err?: (line: string) => void;
}

const isVerb = (v: string | undefined): v is HostVerb =>
  v !== undefined && (HOST_VERBS as readonly string[]).includes(v);
const isWalk = (v: string | undefined): v is WalkKind =>
  v !== undefined && (WALK_KINDS as readonly string[]).includes(v);

/** Run one verb over the ports. */
export function runHostVerb(
  verb: HostVerb,
  ports: HostPorts,
  args: readonly string[],
): Promise<HostAnswer> {
  switch (verb) {
    case "setup":
      return hostSetup(ports, args);
    case "review-now":
      return hostReviewNow(ports, args);
    case "proof-start":
      return hostProofStart(ports, args);
    case "proof-result":
      return hostProofResult(ports, args);
    case "go-live":
      return hostGoLive(ports, args);
    case "set-trigger":
      return hostSetTrigger(ports, args);
  }
}

/** `qcr [--schema N] host <verb> …`. The process's exit code. */
export async function cmdHost(args: readonly string[], io: HostIo = {}): Promise<number> {
  const out = io.out ?? ((line: string) => console.log(line));
  const err = io.err ?? ((line: string) => console.error(line));
  const [verb, ...rest] = args;
  if (verb === "walk") {
    const [kind, token] = rest;
    if (rest.length !== 2 || !isWalk(kind) || token === undefined || token === "") {
      err("qcr host walk: started by a host verb, never by a caller");
      return 2;
    }
    const ports = io.ports ?? realHostPorts();
    return kind === "setup" ? walkSetup(ports, token) : walkGoLive(ports, token);
  }
  const contract = hostPayloadVersion("host", io.contract ?? requestedContract());
  if (contract === undefined) {
    err("qcr host: no contract this qcr prints carries the host verbs");
    return 3;
  }
  if (!isVerb(verb)) {
    err(
      `qcr host: ${verb === undefined ? "no verb follows it" : `${JSON.stringify(verb)} is not a host verb`} — ${HOST_USAGE}`,
    );
    return 2;
  }
  let answer: HostAnswer;
  try {
    answer = await runHostVerb(verb, io.ports ?? realHostPorts(), rest);
  } catch (e) {
    err(`qcr host ${verb}: ${e instanceof Error ? e.message : String(e)}`);
    return 1;
  }
  out(JSON.stringify({ schema_version: contract, verb, ...answer }));
  return exitCodeOf(answer);
}
