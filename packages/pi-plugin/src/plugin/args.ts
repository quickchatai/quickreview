// /qcr-review's arguments, as a person types them after the command:
//
//   /qcr-review [preset] [target] [flags]
//
//   preset    quick | full | security: the first word, when it names one
//             (else the `quickreview.preset` pi setting, else none)
//   target    nothing         this branch against its base, with its
//                             uncommitted changes, as one review
//             123 | #123 | URL  a pull request
//             NAME            the branch NAME against its base (its commits)
//             --uncommitted   the uncommitted changes alone, against HEAD
//   --base REF      the base a branch is reviewed against
//   --preview       the plan and the price; nothing runs
//   --json          the result as JSON (pi's print mode)
//   --profile NAME  review under that profile
//   --limit USD     this run's limit (above it the run asks)
//   --repo O/N      the PR's repo, when it is not the cwd's
//   --stop          stop the review running in this session
//
// A preset is the review options the core already takes, named: a lens plan
// (`[review] preset`, `skip_lenses`) and a scope (`full`). It is never a code
// path of its own.
//
// Retired spellings stay accepted (tests/legacy-acceptance.test.ts), folded
// to the current ones and never named in the usage: `--full` is the `full`
// preset, `--branch` the bare command's branch, and `--to LIST` the old
// destination list, of which only `json` still means anything (a result is
// always shown and kept, and a post is the posting rule's).
import { ALL_PASSES } from "../passes.js";
import type { ReviewTarget } from "../reviewtarget.js";

/** The lenses the security preset keeps; every other lens is skipped. */
export const SECURITY_LENSES: readonly string[] = [
  "pass-baseline",
  "pass-security",
  "pass-data-safety",
  "pass-bounds",
  "pass-contracts",
  "pass-validate",
];

function securitySkips(): string[] {
  return ALL_PASSES.filter((p) => !SECURITY_LENSES.includes(p));
}

/** The presets /qcr-review takes, each as the core's review options. */
export const REVIEW_PRESETS = {
  /** The default plan at low reasoning: about half the cost and time. */
  quick: { levers: "review.preset=low", full: false },
  /** The full lever plan at the highest reasoning, over the whole target
   * again (what an earlier review left is ignored). */
  full: { levers: "review.preset=max", full: true },
  /** Only the risk lenses the change triggers (security, data safety,
   * bounds, contracts), with the baseline and the validator. */
  security: { levers: `review.skip_lenses=${securitySkips().join("|")}`, full: false },
} as const;

export type ReviewPresetName = keyof typeof REVIEW_PRESETS;

export const REVIEW_PRESET_NAMES = Object.keys(REVIEW_PRESETS) as ReviewPresetName[];

export const isPresetName = (w: string | undefined): w is ReviewPresetName =>
  w !== undefined && (REVIEW_PRESET_NAMES as readonly string[]).includes(w);

export interface ReviewCommand {
  preset: ReviewPresetName | null;
  target: ReviewTarget;
  preview: boolean;
  json: boolean;
  profile?: string;
  limitUsd?: number;
}

export const REVIEW_COMMAND_USAGE =
  `usage: /qcr-review [${REVIEW_PRESET_NAMES.join("|")}] [PR number or URL | BRANCH | --uncommitted] ` +
  "[--base REF] [--preview] [--json] [--profile NAME] [--limit USD] [--repo OWNER/NAME] | /qcr-review --stop";

/** The words of a command line; double quotes group, nothing else is special. */
export function splitArgs(line: string): string[] {
  const out: string[] = [];
  const re = /"([^"]*)"|(\S+)/g;
  for (let m = re.exec(line); m !== null; m = re.exec(line)) out.push(m[1] ?? m[2]!);
  return out;
}

/** The destinations the retired `--to` took. */
const LEGACY_DESTINATIONS = ["terminal", "file", "json", "pr"];

/** A word that names a pull request: a number, `#N`, or a pull URL. */
const isPrWord = (w: string): boolean => /^#?\d+$/.test(w) || /^https?:\/\/\S+\/pull\/\d+/.test(w);

/**
 * Parse `/qcr-review`'s arguments; a usage error is `{ error }`, `--stop` is
 * `{ stop: true }`. `defaultPreset` is the person's own (pi's settings): a
 * preset typed as the first word wins over it.
 */
export function parseReviewCommand(
  line: string,
  defaultPreset: ReviewPresetName | null = null,
): ReviewCommand | { stop: true } | { error: string } {
  const a = splitArgs(line);
  if (a.length === 1 && a[0] === "--stop") return { stop: true };
  let preset: ReviewPresetName | null = defaultPreset;
  const typed = isPresetName(a[0]);
  if (typed) preset = a.shift() as ReviewPresetName;
  let word: string | undefined;
  let repo: string | undefined;
  let base: string | undefined;
  let uncommitted = false;
  let full = false;
  let branch = false;
  const cmd: Omit<ReviewCommand, "target" | "preset"> = { preview: false, json: false };
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
        case "--limit": {
          const n = Number(value(i++, w));
          if (!Number.isFinite(n) || n <= 0)
            throw new Error("--limit takes a positive amount in USD");
          cmd.limitUsd = n;
          break;
        }
        case "--full":
          full = true;
          break;
        case "--branch":
          branch = true;
          break;
        case "--to":
          for (const d of value(i++, w).split(",").map((x) => x.trim())) {
            if (!LEGACY_DESTINATIONS.includes(d))
              throw new Error(`unknown destination ${d || "(empty)"}`);
            if (d === "json") cmd.json = true;
          }
          break;
        case "--stop":
          throw new Error("--stop goes alone");
        default:
          if (w.startsWith("--")) throw new Error(`unknown flag ${w}`);
          if (isPresetName(w) && word === undefined && i > 0)
            throw new Error(`the preset goes first: /qcr-review ${w} …`);
          if (word !== undefined) throw new Error(`one target at a time (got ${word} and ${w})`);
          word = w;
      }
    }
  } catch (err) {
    return {
      error: `${err instanceof Error ? err.message : String(err)}\n${REVIEW_COMMAND_USAGE}`,
    };
  }
  if (full) {
    if (typed && preset !== "full")
      return {
        error: `--full is the full preset, and ${preset} was asked for: pick one\n${REVIEW_COMMAND_USAGE}`,
      };
    preset = "full";
  }
  if (branch && (word !== undefined || uncommitted))
    return {
      error: `--branch is this branch: a PR, a branch name and --uncommitted are each a whole target\n${REVIEW_COMMAND_USAGE}`,
    };
  const pr = word !== undefined && isPrWord(word) ? word : undefined;
  const head = word !== undefined && pr === undefined ? word : undefined;
  if (word !== undefined && uncommitted)
    return {
      error: `${word} and --uncommitted are each a whole target: pick one\n${REVIEW_COMMAND_USAGE}`,
    };
  if (base !== undefined && (pr !== undefined || uncommitted))
    return { error: `--base goes with a branch review\n${REVIEW_COMMAND_USAGE}` };
  if (repo !== undefined && pr === undefined)
    return { error: `--repo names the PR's repo: give a PR too\n${REVIEW_COMMAND_USAGE}` };
  const target: ReviewTarget =
    pr !== undefined
      ? { kind: "pr", pr, ...(repo !== undefined ? { repo } : {}) }
      : uncommitted
        ? { kind: "uncommitted" }
        : {
            kind: "branch",
            ...(base !== undefined ? { base } : {}),
            ...(head !== undefined ? { head } : { uncommitted: true }),
          };
  return { ...cmd, preset, target };
}

/** What a review is of, in the words a person reads ("PR #12 (quick)"). */
export function reviewLabel(cmd: Pick<ReviewCommand, "target" | "preset">): string {
  const t = cmd.target;
  const what =
    t.kind === "pr"
      ? `PR ${/^\d+$/.test(String(t.pr)) ? `#${t.pr}` : String(t.pr)}`
      : t.kind === "uncommitted"
        ? "the uncommitted changes"
        : t.kind === "branch" && t.head !== undefined
          ? `the branch ${t.head}`
          : t.kind === "branch"
            ? "this branch with its uncommitted changes"
            : "the diff";
  return cmd.preset !== null ? `${what} (${cmd.preset})` : what;
}
