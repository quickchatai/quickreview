// `qcr --schema N <verb> …`: a host plugin names the contract it was written
// for, and gets JSON in exactly that contract or a refusal it can read.
//
//   N        a host-plugin contract number (CONTRACTS in
//            packages/pi-plugin/src/contract.ts): one version per payload family
//   <verb>   review, scan or version, the verbs that print versioned JSON
//
// The flag comes before the verb and nowhere else; after the verb it is the
// verb's own argument. It implies `--json`, and the bin prints no update notice
// on such a run (src/qcrbin.ts). Exit codes:
//
//   2   usage: no N, an N that is not a number, or a verb with no versioned
//       payload (the home, login, pi, update, the operator verbs)
//   3   a contract this qcr does not print: one line on stderr, nothing on
//       stdout, so a plugin falls back to the release it was rendered from
//
// The bin's front door and the image's entry (src/cli.ts `main`) read it here,
// so `qcr` from npm and the image's wrapper answer alike.
import { supportedContracts } from "@quickchatai/pi-quickreview/src/contract.js";

/** The verbs whose `--json` payload leads with a family's schema_version. */
export const SCHEMA_VERBS: readonly string[] = ["review", "scan", "version"];

export type SchemaFlag =
  /** No `--schema` before the verb: the argv is the caller's as it came. */
  | { kind: "absent" }
  /** A contract this qcr prints: run `argv` (the verb and its arguments, no
   * `--json`) with JSON on. */
  | { kind: "ok"; contract: number; argv: string[] }
  | { kind: "refused"; code: 2 | 3; line: string };

const USAGE = `usage: qcr --schema N ${SCHEMA_VERBS.join("|")} [arguments…]`;

/** Read a leading `--schema N` (or `--schema=N`) off `argv`. */
export function parseSchemaFlag(argv: readonly string[]): SchemaFlag {
  const first = argv[0];
  if (first === undefined) return { kind: "absent" };
  let value: string | undefined;
  let rest: readonly string[];
  if (first === "--schema") {
    value = argv[1];
    rest = argv.slice(2);
  } else if (first.startsWith("--schema=")) {
    value = first.slice("--schema=".length);
    rest = argv.slice(1);
  } else {
    return { kind: "absent" };
  }
  if (value === undefined || !/^[1-9][0-9]{0,5}$/.test(value))
    return {
      kind: "refused",
      code: 2,
      line: `qcr --schema: ${value === undefined || value === "" ? "names no contract" : `"${value}" is not a contract number`} — ${USAGE}`,
    };
  const [verb, ...args] = rest.filter((a) => a !== "--json");
  if (verb === undefined || !SCHEMA_VERBS.includes(verb))
    return {
      kind: "refused",
      code: 2,
      line: `qcr --schema: ${verb === undefined ? "no verb follows it" : `\`qcr ${verb}\` prints no versioned JSON`} — ${USAGE}`,
    };
  const contract = Number(value);
  const known = supportedContracts();
  if (!known.includes(contract))
    return {
      kind: "refused",
      code: 3,
      line: `qcr --schema: this qcr does not print contract ${contract} (it prints ${known.join(", ")}) — use the qcr release the plugin was made for, or update the plugin`,
    };
  return { kind: "ok", contract, argv: [verb, ...args] };
}
