// Pure dispatch heuristics ported from the old /auto-review flow:
// test-file exclusion (the jq filter as TS), escalation-worthiness, and the
// migration gate. Consumed by dispatch (B2); unit-tested directly.

import type { PrFileEntry } from "./github.js";

export interface PrFile {
  filename: string;
  additions: number;
  deletions: number;
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

// Escalation-worthy path heuristics (spec §3): infra-shaped paths.
const ESCALATION_PATH_PATTERNS: RegExp[] = [
  /(^|\/)infra\//,
  /(^|\/)ansible\//,
  /(^|\/)\.github\/workflows\//,
  /\.tf$/,
  /(^|\/)setup\.sh$/,
];

const ESCALATION_PROD_LINES = 500;
const ESCALATION_PROD_FILES = 15;

export function escalationWorthy(files: PrFile[]): { worthy: boolean; reasons: string[] } {
  const reasons: string[] = [];
  const infraHits = files.filter((f) => ESCALATION_PATH_PATTERNS.some((re) => re.test(f.filename)));
  if (infraHits.length > 0) reasons.push(`infra paths: ${infraHits.map((f) => f.filename).join(", ")}`);
  const { prod_lines, prod_files } = prodStats(files);
  if (prod_lines > ESCALATION_PROD_LINES) reasons.push(`prod_lines ${prod_lines} > ${ESCALATION_PROD_LINES}`);
  if (prod_files > ESCALATION_PROD_FILES) reasons.push(`prod_files ${prod_files} > ${ESCALATION_PROD_FILES}`);
  return { worthy: reasons.length > 0, reasons };
}

export function migrationGate(files: PrFile[]): boolean {
  return files.some((f) => /(^|\/)migrations\//.test(f.filename));
}

/** Pass model tier for a round: small quiet diffs start at terra-med; any
 * migration, escalation-worthiness, or size at/over `smallDiffLines` starts
 * at sol-med. (Risk passes and pass-validate have fixed tiers in config —
 * this function only picks the base tier for the raisable passes.) */
export function passTier(
  files: PrFileEntry[],
  opts: { migrationGate: boolean; escalationWorthy: boolean; smallDiffLines: number },
): "terra-med" | "sol-med" {
  const total = files.reduce((n, f) => n + f.additions + f.deletions, 0);
  if (total < opts.smallDiffLines && !opts.migrationGate && !opts.escalationWorthy) return "terra-med";
  return "sol-med";
}

// Dependency-manifest / lockfile shapes — a security surface (supply chain).
const DEPS_MANIFEST_RE =
  /(^|\/)(package(-lock)?\.json|yarn\.lock|pnpm-lock\.yaml|requirements[^/]*\.txt|poetry\.lock|pyproject\.toml|Pipfile(\.lock)?|go\.(mod|sum)|Gemfile(\.lock)?|Cargo\.(toml|lock))$/;

// Deterministic lens selection (spec §5): baseline always; conditional lenses
// from the changed-file shape (path + patch-content signals), each tied to
// the seeded lens's stated focus; validator always runs last (added by
// dispatch, never selected here).
export function selectLenses(files: PrFile[]): string[] {
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

  return [...lenses];
}
