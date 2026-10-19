// QCR FORK — file added by PATCH 2 (leaf isolation). Not upstream.
//
// A "leaf" is a pi process that is NOT the shepherd session: a pi-subagents
// child running one lens pass. Leaves must never do ambient OpenViking work —
// no recall injection into their context, no turn sync, no commit — because:
//
//   * the single-shepherd invariant (root CLAUDE.md rule 9) says the PR's ONE
//     main pi owns the review; a leaf is a stateless evaluator of a diff, and
//     memory injected under it is unaccounted context;
//   * a commit from a leaf would archive the SHEPHERD's session (the OV
//     session id is inherited through the environment), reordering the one
//     conversation the daemon owns.
//
// A pi-subagents child is spawned with `--no-extensions`
// (assets/findings.md §4.3), so on the tmux bot a leaf structurally
// never loads this extension. That is one layer. This is the second, for a
// process that did load it (an operator's `pi -e`, a flag the child argv grows):
// the child inherits the parent ENVIRONMENT, so anything keyed off env alone
// would read as "main" inside a leaf. Detection therefore keys off ARGV, which
// pi-subagents builds from scratch:
//
//   [...piBin.baseArgs, "--mode", "json", "-p", "--no-session", "--no-skills",
//    "--no-extensions", ...allowlisted custom-tool extensions]
//
// None of those flags appear in the shepherd argv that `src/sessions.ts`
// buildPiCommand emits (--approve/--model/--session-dir/--system-prompt/
// --theme/--extension/--name), so the two are cleanly separable.
//
// QCR PATCH 12: only the shim (qcr-shim.ts) calls this, with the argv and env
// of the pi process that loaded the file. `createOpenViking(cfg)` takes `leaf`
// as a value and never looks at argv, because an SDK session has no argv of its
// own (process.argv there is the host's): the SDK host that builds a lens
// session says `leaf: true`, and nothing here second-guesses it.
//
// VERIFY-ON-PIN: the flag set above is pi-subagents @1f54189 as read at pi
// 0.84.1. It has not been re-read at the pinned 1.3.0; a pi or pi-subagents
// bump re-verifies it.

/** Flags that only ever appear on a pi-subagents child command line. */
export const LEAF_ARGV_FLAGS: readonly string[] = [
  "--no-extensions",
  "--no-session",
  "--no-skills",
  "--print",
  "-p",
];

/** Env var that FORCES leaf mode. There is deliberately no env var that forces
 * MAIN mode: env is inherited by children, so a "this is the shepherd" marker
 * would be inherited by every leaf and defeat the whole check. */
export const FORCE_LEAF_ENV = "QCR_OV_LEAF";

function truthy(value: string | undefined): boolean {
  const v = (value ?? "").trim().toLowerCase();
  return v === "1" || v === "true" || v === "yes" || v === "on";
}

/**
 * True when this process is a pi-subagents leaf (or has been forced to behave
 * as one). Fail direction: an UNKNOWN argv reads as "main", which is the
 * shepherd's behaviour — the leaf never loads this extension anyway, so a
 * false negative costs nothing while a false positive would silently disable
 * memory for the review session.
 */
export function isLeafProcess(
  argv: readonly string[],
  env: Record<string, string | undefined>,
): boolean {
  if (truthy(env[FORCE_LEAF_ENV])) return true;
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === undefined) continue;
    if (LEAF_ARGV_FLAGS.includes(arg)) return true;
    if (arg === "--mode=json") return true;
    if (arg === "--mode" && argv[i + 1] === "json") return true;
  }
  return false;
}
