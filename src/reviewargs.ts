// `qcr review`'s arguments: the usage line and the parse of argv into a
// command, in a module of their own. The terminal verb (src/reviewcli.ts) and
// the detached registry (src/reviewdetach.ts) both read them, and the
// registry's callers (the app's home) never import the review's runtime.
import { parseDestinations, type Destination } from "@quickchatai/pi-quickreview/src/reviewdest.js";

export const REVIEW_USAGE =
  "usage: qcr review start|status|stop (detached runs, see `qcr review start --help`) | qcr review [branch | --uncommitted | --diff FILE|- | <PR number|URL>] [--repo OWNER/NAME] [--base REF] [--preview] [--key K] [--limit USD] [--full] [--to DEST] [--out FILE] [--debug-pi] [--json] | --help";

export type ReviewCommand =
  | { help: true }
  | {
      help: false;
      uncommitted: boolean;
      /** `--diff`: a file to read the diff from, or "-" for stdin. */
      diff?: string;
      pr?: string;
      repo?: string;
      base?: string;
      preview: boolean;
      key?: string;
      limit?: number;
      full: boolean;
      to?: Destination[];
      out?: string;
      /** `--debug-pi`: the round runs inside interactive pi. */
      debugPi: boolean;
    };

const usage = (why?: string): Error => new Error(why ? `${REVIEW_USAGE}\n(${why})` : REVIEW_USAGE);

/** `qcr review`'s arguments (`--json` taken off before). An unknown token is
 * refused, so a mistyped flag never runs something else. */
export function parseReviewArgs(rest: readonly string[]): ReviewCommand {
  let help = false;
  let uncommitted = false;
  let diff: string | undefined;
  let preview = false;
  let full = false;
  let base: string | undefined;
  let pr: string | undefined;
  let repo: string | undefined;
  let key: string | undefined;
  let limit: number | undefined;
  let to: Destination[] | undefined;
  let out: string | undefined;
  let debugPi = false;
  const value = (i: number, flag: string): string => {
    const v = rest[i + 1];
    if (v === undefined || v.startsWith("--")) throw usage(`${flag} needs a value`);
    return v;
  };
  for (let i = 0; i < rest.length; i++) {
    const a = rest[i]!;
    if (a === "--help" || a === "-h") help = true;
    else if (a === "--preview") preview = true;
    else if (a === "--full") full = true;
    else if (a === "--debug-pi") debugPi = true;
    else if (a === "--base") base = value(i++, a);
    else if (a === "--diff") {
      // "-" is stdin; a file whose name begins with "-" is written ./-name
      const v = rest[i + 1];
      if (v === undefined || (v !== "-" && v.startsWith("-")))
        throw usage("--diff needs a file, or - for stdin");
      diff = v;
      i++;
    } else if (a === "--repo") repo = value(i++, a);
    else if (a === "--key") key = value(i++, a);
    else if (a === "--to") {
      try {
        to = parseDestinations(value(i++, a));
      } catch (err) {
        throw usage(err instanceof Error ? err.message : String(err));
      }
    } else if (a === "--out") out = value(i++, a);
    else if (a === "--limit") {
      const n = Number(value(i++, a));
      if (!Number.isFinite(n) || n <= 0)
        throw usage("--limit must be a positive number of dollars");
      limit = n;
    } else if (a === "branch") continue;
    else if (a === "--uncommitted") uncommitted = true;
    else if (/^#?\d+$/.test(a) || /^https?:\/\//.test(a)) {
      if (pr !== undefined) throw usage("one PR at a time");
      pr = a;
    } else throw usage(`unknown argument ${a}`);
  }
  if (help) return { help: true };
  if (uncommitted && base !== undefined)
    throw usage("--uncommitted reviews against HEAD; --base does not apply");
  if (uncommitted && rest.includes("branch"))
    throw usage("choose one target: branch or --uncommitted");
  if (uncommitted && pr !== undefined) throw usage("choose one target: --uncommitted or a PR");
  if (diff !== undefined) {
    if (uncommitted || pr !== undefined || rest.includes("branch"))
      throw usage("choose one target: branch, --uncommitted, --diff or a PR");
    if (base !== undefined) throw usage("--diff carries its own changes; --base does not apply");
    if (repo !== undefined) throw usage("--repo goes with a PR number or URL");
  }
  if (debugPi && preview) throw usage("--debug-pi runs a round; a preview starts nothing");
  if (debugPi && to?.includes("pr")) throw usage("a debug round posts nothing: drop --to pr");
  if (pr !== undefined && base !== undefined) throw usage("--base applies to a branch, not a PR");
  if (pr === undefined && repo !== undefined) throw usage("--repo goes with a PR number or URL");
  return {
    help: false,
    uncommitted,
    ...(diff !== undefined ? { diff } : {}),
    ...(pr !== undefined ? { pr } : {}),
    ...(repo !== undefined ? { repo } : {}),
    preview,
    full,
    debugPi,
    ...(base !== undefined ? { base } : {}),
    ...(key !== undefined ? { key } : {}),
    ...(limit !== undefined ? { limit } : {}),
    ...(to !== undefined ? { to } : {}),
    ...(out !== undefined ? { out } : {}),
  };
}
