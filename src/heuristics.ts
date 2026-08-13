// Pure dispatch heuristics ported from the old /auto-review flow:
// test-file exclusion (the jq filter as TS), escalation-worthiness, and the
// migration gate. Consumed by dispatch (B2); unit-tested directly.

export interface PrFile {
  filename: string;
  additions: number;
  deletions: number;
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

// Deterministic lens selection (spec §5): baseline always; conditional lenses
// from the changed-file shape; validator always runs last (added by dispatch).
export function selectLenses(files: PrFile[]): string[] {
  const lenses = new Set<string>(["pass-baseline"]);
  const names = files.map((f) => f.filename);
  const any = (re: RegExp) => names.some((n) => re.test(n));

  if (any(/\.(tsx|jsx|vue|svelte|css|scss|html)$/) || any(/(^|\/)(frontend|ui|components|templates)\//))
    lenses.add("pass-ui");
  if (any(/(^|\/)(api|routes|views|controllers|serializers|schemas?)\//) || any(/\.(proto|graphql)$/))
    lenses.add("pass-contracts");
  if (any(/(^|\/)migrations\//) || any(/(^|\/)(models|db|database)\//) || any(/\.sql$/))
    lenses.add("pass-data-safety");
  if (any(/(^|\/)(auth|security|permissions|middleware)\//) || any(/(secret|token|password|crypto)/i))
    lenses.add("pass-security");
  if (any(/(^|\/)(tasks|jobs|workers|queues?|celery|async)\//) || any(/(websocket|socket|stream)/i))
    lenses.add("pass-statelessness");
  if (any(/(^|\/)infra\//) || any(/(^|\/)ansible\//) || any(/(^|\/)\.github\/workflows\//) || any(/\.tf$/) || any(/(^|\/)(deploy|docker)/i))
    lenses.add("pass-prod-risk");
  if (any(/(^|\/)(email|mail|notifications?|sms|webhooks?)\//)) lenses.add("pass-delivery");

  return [...lenses];
}
