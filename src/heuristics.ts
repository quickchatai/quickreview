// Pure dispatch heuristics ported from the old /auto-review flow:
// test-file exclusion (the jq filter as TS), the migration gate, lens
// selection and the pass tier. Consumed by dispatch (B2); unit-tested directly.

import type { PrFileEntry } from "./github.js";

export interface PrFile {
  filename: string;
  additions: number;
  deletions: number;
  /** GitHub file status ("added", "modified", …) when available — the
   * placement lens keys on new files (github.ts PrFileEntry.status). */
  status?: string;
  /** Unified diff for the file when available (github.ts PrFileEntry.patch). */
  patch?: string;
}

// Ported test-file jq filter: a file is a test file iff any of these match.
const TEST_PATTERNS: RegExp[] = [
  /(^|\/)tests?\//,
  /(^|\/)__tests__\//,
  /(^|\/)test_[^/]+$/,
  /_test\.[a-z0-9]+$/,
  /\.(test|spec)\.[a-z0-9]+$/i,
  /(^|\/)conftest\.py$/,
  /(^|\/)fixtures\//,
];

export function isTestFile(filename: string): boolean {
  return TEST_PATTERNS.some((re) => re.test(filename));
}

export interface ProdStats {
  prod_lines: number;
  prod_files: number;
}

export function prodStats(files: PrFile[]): ProdStats {
  const prod = files.filter((f) => !isTestFile(f.filename));
  return {
    prod_files: prod.length,
    prod_lines: prod.reduce((n, f) => n + f.additions + f.deletions, 0),
  };
}

// The escalation-worthiness heuristic (infra paths ∪ prod_lines > 500 ∪
// prod_files > 15) was DELETED on 2026-08-18 (the owner: "scrap the escalation
// mechanics entirely"). It scored every PR, drove a prompt block and a Slack
// flag, and no code ever checked whether the score predicted anything. Nothing
// replaces it under another name: the tier ladder below now keys on size and
// the migration gate alone.

export function migrationGate(files: PrFile[]): boolean {
  return files.some((f) => /(^|\/)migrations\//.test(f.filename));
}

/** Pass model tier for a round: small quiet diffs start at terra-med; a
 * migration or a size at/over `smallDiffLines` starts at sol-med. (Risk passes
 * and pass-validate have fixed tiers in config — this function only picks the
 * base tier for the raisable passes.) */
export function passTier(
  files: PrFileEntry[],
  opts: { migrationGate: boolean; smallDiffLines: number },
): "terra-med" | "sol-med" {
  const total = files.reduce((n, f) => n + f.additions + f.deletions, 0);
  if (total < opts.smallDiffLines && !opts.migrationGate) return "terra-med";
  return "sol-med";
}

// ---- pass-intent ------------------------------------------------
//
// The tenth lens: does the PR do what its author said it would? Its intent
// artifact is the PR TITLE + BODY and nothing else (intent-as-artifact — what
// the author told other humans; the implementing conversation/prompt is
// rejected as an echo chamber and is never fetched). Selection keys on the
// body clearing a minimum substance bar: dispatching a pass whose first act
// is to return NONE is pure spend, and the lens's own load-bearing rule is
// that a thin body supports no finding. The bar lives HERE (daemon-side, not
// in the lens text) so a thin-body PR never costs a subagent at all.

export const INTENT_PASS = "pass-intent";

/** Words of author prose a body must carry before pass-intent is worth a
 * dispatch. Below this, "the body says X" has no X to check — the lens's own
 * contract says NONE is the only honest output. */
export const INTENT_MIN_SUBSTANCE_WORDS = 20;

/**
 * Words of actual author prose in a PR body, after stripping the parts that
 * carry no intent: PR-template HTML comments, fenced/inline code, bare URLs,
 * template scaffolding headings and empty checkboxes. Deliberately crude —
 * this is a dispatch-cost gate, not comprehension.
 */
export function intentSubstanceWords(body: string | null | undefined): number {
  if (!body) return 0;
  const prose = body
    .replace(/<!--[\s\S]*?-->/g, " ") // PR-template comments
    .replace(/```[\s\S]*?(```|$)/g, " ") // fenced code blocks
    .replace(/`[^`\n]*`/g, " ") // inline code
    .replace(/https?:\/\/\S+/g, " ") // bare links carry no prose
    .replace(/^#{1,6}\s.*$/gm, " ") // headings = template scaffolding
    .replace(/^\s*[-*]\s*\[[ xX]?\]\s*$/gm, " "); // empty checkbox rows
  return prose.split(/\s+/).filter((w) => /[A-Za-z]/.test(w)).length;
}

/** The substance bar: run pass-intent iff the body clears it. */
export function meetsIntentBar(body: string | null | undefined): boolean {
  return intentSubstanceWords(body) >= INTENT_MIN_SUBSTANCE_WORDS;
}

// ---- placement / simplicity / backcompat ---------------
//
// Three judgment lenses added from the 2026-08-20 team-feedback charting.
// Selection is deterministic like everything above; the caps (placement and
// simplicity post at P2 max) are enforced at the validator via PASS_ADDENDA,
// not here.

export const PLACEMENT_PASS = "pass-placement";
export const SIMPLICITY_PASS = "pass-simplicity";
export const BACKCOMPAT_PASS = "pass-backcompat";

/** CODE files — the unit placement/simplicity judge. A new README, lockfile
 * or asset is "prod" by the test filter but has no placement or complexity
 * to judge: dispatching on it is the pure-spend case the intent bar above
 * exists to avoid. */
export const CODE_FILE_RE =
  /\.(py|pyi|ts|tsx|js|jsx|mjs|cjs|go|rb|java|kt|kts|rs|c|cc|cpp|h|hpp|cs|php|swift|scala|ex|exs|vue|svelte)$/i;

/** New-code statuses that pose the "does this live in the right place"
 * question — a move IS the purest placement change. */
const PLACEMENT_STATUSES = new Set(["added", "renamed", "copied"]);

/** Placement also fires on cross-cutting diffs: at least this many code files. */
export const PLACEMENT_MIN_PROD_FILES = 4;

/** Simplicity fires on diffs big enough to hide complexity — aligned with
 * `small_diff_lines` (150) so a "small quiet diff" round stays lean… */
export const SIMPLICITY_MIN_PROD_LINES = 150;
/** …or on a file gaining this many branches (`+ if/elif/else if/case`). */
export const SIMPLICITY_MIN_ADDED_BRANCHES = 5;
/** …or on added lines nested this deep (5 levels at 4-space, or tabs). */
const SIMPLICITY_DEEP_INDENT_RE = /^\+(?: {20,}|\t{5,})\S/m;
/** Added-branch counter: indent must not cross lines (`\s` matches
 * newlines), and brace languages open rungs with `} else if`. */
const SIMPLICITY_BRANCH_RE = /^\+[ \t]*[)\]}]*[ \t]*(if|elif|else[ \t]+if|case|when)\b/gm;

// Dependency-manifest / lockfile shapes — a security surface (supply chain).
const DEPS_MANIFEST_RE =
  /(^|\/)(package(-lock)?\.json|yarn\.lock|pnpm-lock\.yaml|requirements[^/]*\.txt|poetry\.lock|pyproject\.toml|Pipfile(\.lock)?|go\.(mod|sum)|Gemfile(\.lock)?|Cargo\.(toml|lock))$/;

// Deterministic lens selection (spec §5): baseline always; conditional lenses
// from the changed-file shape (path + patch-content signals), each tied to
// the seeded lens's stated focus; validator always runs last (added by
// dispatch, never selected here).
export function selectLenses(files: PrFile[], intent?: { body?: string | null }): string[] {
  const lenses = new Set<string>(["pass-baseline"]);
  const names = files.map((f) => f.filename);
  const any = (re: RegExp) => names.some((n) => re.test(n));
  /** Added-line content signal — only fires when a patch is present. */
  const added = (re: RegExp) => files.some((f) => f.patch !== undefined && re.test(f.patch));

  // UI: frontend files only — extensions or an explicit frontend/ path.
  if (any(/\.(tsx|jsx|vue|svelte|css|scss|less|html)$/) || any(/(^|\/)frontend\//)) lenses.add("pass-ui");

  // External contracts: provider payload surfaces — schema/serializer dirs,
  // wire-format files, integration/provider client dirs.
  if (any(/(^|\/)(serializers?|schemas?|integrations?|providers?|connectors?)\//) || any(/\.(proto|graphql)$/))
    lenses.add("pass-contracts");

  // Data safety: migrations DDL, raw SQL, backfills / management commands
  // (bulk per-row work) — not every models/ touch.
  if (any(/(^|\/)migrations\//) || any(/\.sql$/) || any(/(^|\/)backfills?\//) || any(/(^|\/)management\/commands\//))
    lenses.add("pass-data-safety");

  // Security & tenancy: auth/permission surfaces, secret/crypto-shaped names,
  // env/settings files, dependency manifests.
  if (
    any(/(^|\/)(auth|authn|authz|security|permissions|middleware|throttling)\//) ||
    any(/(secret|token|passw|crypt|oauth|jwt|csrf|cors)/i) ||
    any(/(^|\/)\.env(\.[^/]+)?$/) ||
    any(/(^|\/)settings[^/]*\.py$/) ||
    any(DEPS_MANIFEST_RE)
  )
    lenses.add("pass-security");

  // Statelessness: in-process state signals in the added lines (module-level
  // mutable collections, lru_cache/threading), or cache/singleton/registry
  // shaped filenames — not every tasks/ touch.
  if (
    added(/^\+.*(@lru_cache|functools\.(cache|lru_cache))/m) ||
    added(/^\+.*threading\.(Lock|local)\(/m) ||
    added(/^\+[A-Za-z_][A-Za-z0-9_]*\s*(?::[^=\n]+)?=\s*(\{\}|\[\]|set\(\)|dict\(\)|defaultdict\()/m) ||
    any(/(^|\/)[^/]*(cache|singleton|registry)[^/]*\.[a-z]+$/i)
  )
    lenses.add("pass-statelessness");

  // Production risk: infra-shaped paths — IaC, CI workflows, container files.
  if (
    any(/(^|\/)(infra|ansible|terraform|helm|k8s|kubernetes)\//) ||
    any(/(^|\/)\.github\/workflows\//) ||
    any(/\.tf$/) ||
    any(/(^|\/)(Dockerfile[^/]*|docker-compose[^/]*\.ya?ml)$/)
  )
    lenses.add("pass-prod-risk");

  // Delivery semantics: at-least-once handler surfaces — webhooks, background
  // tasks/workers/crons, queue consumers (not email/notification content dirs).
  if (
    any(/(^|\/)(webhooks?|tasks|jobs|workers?|crons?|consumers?|subscribers?)\//) ||
    any(/(pubsub|pub_sub|cloud_tasks|celery)/i) ||
    added(/^\+.*@background_decorator/m)
  )
    lenses.add("pass-delivery");

  // Placement: new (or moved — the purest placement change) CODE
  // needs a home judgment, and a cross-cutting code diff is where
  // wrong-layer changes hide. Docs/config/asset adds, test-only PRs and
  // small edits-in-place skip it — pure spend otherwise.
  const code = files.filter((f) => !isTestFile(f.filename) && CODE_FILE_RE.test(f.filename));
  if (code.some((f) => PLACEMENT_STATUSES.has(f.status ?? "")) || code.length >= PLACEMENT_MIN_PROD_FILES)
    lenses.add(PLACEMENT_PASS);

  // Simplicity: complexity signals — a large code diff, deep
  // nesting in added lines, or a file gaining a pile of branches.
  const codeLines = code.reduce((n, f) => n + f.additions + f.deletions, 0);
  if (
    codeLines >= SIMPLICITY_MIN_PROD_LINES ||
    code.some((f) => f.patch !== undefined && SIMPLICITY_DEEP_INDENT_RE.test(f.patch)) ||
    code.some((f) => (f.patch?.match(SIMPLICITY_BRANCH_RE)?.length ?? 0) >= SIMPLICITY_MIN_ADDED_BRANCHES)
  )
    lenses.add(SIMPLICITY_PASS);

  // Backcompat: deploy-window skew surfaces — wire formats, API
  // modules, queue/task payloads, migrations, settings, feature flags. The
  // dir arm requires a CODE file so a docs/api/ page never buys the lens.
  const codeIn = (re: RegExp) => code.some((f) => re.test(f.filename));
  if (
    codeIn(/(^|\/)(serializers?|schemas?|apis?|views?|endpoints?|routes?|controllers?|handlers?)\//) ||
    any(/(^|\/)(serializers?|views?|urls?|apis?)[^/]*\.py$/) ||
    any(/\.(proto|graphql)$/) ||
    any(/(^|\/)migrations\//) ||
    codeIn(/(^|\/)(tasks|jobs|workers?|consumers?|queues?)\//) ||
    any(/(^|\/)settings[^/]*\.py$/) ||
    added(/^\+.*(feature.?flag|waffle|launch.?darkly|unleash)/im)
  )
    lenses.add(BACKCOMPAT_PASS);

  // Intent: keyed on the BODY, not the file shape — the artifact it
  // judges against is the author's own description, so a body below the
  // substance bar means the pass's only honest output would be NONE. Skip it.
  if (meetsIntentBar(intent?.body)) lenses.add(INTENT_PASS);

  return [...lenses];
}
