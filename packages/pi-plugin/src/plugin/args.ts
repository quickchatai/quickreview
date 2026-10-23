// The /review command's arguments, as a person types them after the command:
//
//   /review                     the current branch against its base
//   /review 123 | #123 | URL    a pull request
//   /review --branch [--base R] the current branch (against R)
//   /review --uncommitted       the uncommitted tree against HEAD
//   --preview                   the plan and the price; nothing runs
//   --to pr | --to file | …     where the result goes (reviewdest.ts)
//   --json                      the result as JSON, nothing asked
//   --profile NAME              review under that profile
//   --limit USD                 this run's limit (above it the run asks)
//   --repo OWNER/NAME           the PR's repo, when it is not the cwd's
//   --full                      review everything again, ignoring history
import { parseDestinations, type Destination } from "../reviewdest.js";
import type { ReviewTarget } from "../reviewapi.js";

export interface ReviewCommand {
  target: ReviewTarget;
  preview: boolean;
  json: boolean;
  full: boolean;
  to: Destination[];
  profile?: string;
  limitUsd?: number;
}

export const REVIEW_COMMAND_USAGE =
  "usage: /review [PR number or URL | --branch [--base REF] | --uncommitted] [--preview] [--to terminal|file|json|pr] [--json] [--profile NAME] [--limit USD] [--repo OWNER/NAME] [--full]";

/** The words of a command line; double quotes group, nothing else is special. */
export function splitArgs(line: string): string[] {
  const out: string[] = [];
  const re = /"([^"]*)"|(\S+)/g;
  for (let m = re.exec(line); m !== null; m = re.exec(line)) out.push(m[1] ?? m[2]!);
  return out;
}

/** Parse `/review`'s arguments; a usage error is `{ error }`. */
export function parseReviewCommand(line: string): ReviewCommand | { error: string } {
  const a = splitArgs(line);
  let pr: string | undefined;
  let repo: string | undefined;
  let base: string | undefined;
  let branch = false;
  let uncommitted = false;
  const cmd: Omit<ReviewCommand, "target"> = { preview: false, json: false, full: false, to: [] };
  const value = (i: number, flag: string): string => {
    const v = a[i + 1];
    if (v === undefined || v.startsWith("--")) throw new Error(`${flag} needs a value`);
    return v;
  };
  try {
    for (let i = 0; i < a.length; i++) {
      const w = a[i]!;
      switch (w) {
        case "--preview":
          cmd.preview = true;
          break;
        case "--json":
          cmd.json = true;
          break;
        case "--full":
          cmd.full = true;
          break;
        case "--branch":
          branch = true;
          break;
        case "--uncommitted":
          uncommitted = true;
          break;
        case "--base":
          base = value(i++, w);
          break;
        case "--repo":
          repo = value(i++, w);
          break;
        case "--profile":
          cmd.profile = value(i++, w);
          break;
        case "--to":
          cmd.to = [...cmd.to, ...parseDestinations(value(i++, w))];
          break;
        case "--limit": {
          const n = Number(value(i++, w));
          if (!Number.isFinite(n) || n <= 0)
            throw new Error("--limit takes a positive amount in USD");
          cmd.limitUsd = n;
          break;
        }
        default:
          if (w.startsWith("--")) throw new Error(`unknown flag ${w}`);
          if (pr !== undefined) throw new Error(`one target at a time (got ${pr} and ${w})`);
          pr = w;
      }
    }
  } catch (err) {
    return {
      error: `${err instanceof Error ? err.message : String(err)}\n${REVIEW_COMMAND_USAGE}`,
    };
  }
  const kinds = [pr !== undefined, branch, uncommitted].filter(Boolean).length;
  if (kinds > 1)
    return {
      error: `a PR, --branch and --uncommitted are each a whole target: pick one\n${REVIEW_COMMAND_USAGE}`,
    };
  if (base !== undefined && (pr !== undefined || uncommitted))
    return { error: `--base goes with the branch review\n${REVIEW_COMMAND_USAGE}` };
  if (repo !== undefined && pr === undefined)
    return { error: `--repo names the PR's repo: give a PR too\n${REVIEW_COMMAND_USAGE}` };
  const target: ReviewTarget =
    pr !== undefined
      ? { kind: "pr", pr, ...(repo !== undefined ? { repo } : {}) }
      : uncommitted
        ? { kind: "uncommitted" }
        : { kind: "branch", ...(base !== undefined ? { base } : {}) };
  return { ...cmd, target };
}
