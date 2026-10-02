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
export const INTENT_MIN_SUBSTANCE_WORDS = 60;

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
export function meetsIntentBar(
  body: string | null | undefined,
  minWords: number = INTENT_MIN_SUBSTANCE_WORDS,
): boolean {
  return intentSubstanceWords(body) >= minWords;
}

/**
 * The cost-shaped selection thresholds (`[review]` knobs), so a benchmark arm
 * can test a tighter plan on the same image. Absent ⇒ the compiled defaults —
 * exactly the selection every test and the pre-knob daemon use.
 */
export interface SelectionTuning {
  /** pass-intent's substance bar (words of author prose). */
  intentMinWords?: number;
  /** Placement fires on this many code files… */
  placementMinCodeFiles?: number;
  /** …or on a new code file with at least this many added lines (0 = any). */
  placementMinNewFileLines?: number;
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
  /\.(py|pyi|ts|tsx|mts|cts|js|jsx|mjs|cjs|go|rb|java|kt|kts|rs|c|cc|cpp|cxx|h|hh|hpp|hxx|cs|php|swift|scala|dart|ex|exs|vue|svelte)$/i;

/** New-code statuses that pose the "does this live in the right place"
 * question — a move IS the purest placement change. */
const PLACEMENT_STATUSES = new Set(["added", "renamed", "copied"]);

/** Placement also fires on cross-cutting diffs: at least this many code files. */
export const PLACEMENT_MIN_PROD_FILES = 8;
/** …or on a new code file of at least this many added lines. The two
 * placement thresholds and the intent bar above are the `default` review
 * preset's (config.ts REVIEW_PRESETS, held equal by tests/review-levers.test.ts):
 * the lean plan, measured 2026-09-27 to keep recall at ~15% less spend. */
export const PLACEMENT_MIN_NEW_FILE_LINES = 30;

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

// ---- profile heuristics extension --------------------------------
//
// Lens selection keeps a GENERIC CORE compiled in below; the REPO-SHAPED
// predicates (framework settings-file globs, management-command dirs, a
// product-local decorator name, DRF filename vocabulary, a flag-library name)
// live in the selected repo profile's `heuristics.toml`
// (`src/profiles.ts loadProfileHeuristics`) and reach this module as extra
// per-lens path regexes and added-line probes. The extension can only ADD
// predicates — it never removes or weakens a compiled-in one — and it can
// only add lenses this module could already select by shape.

/** Extra per-lens selection predicates supplied by a repo profile. */
export interface HeuristicsExtension {
  /** lens → path regexes: any changed filename matching any of them selects
   * the lens (same contract as the compiled-in `any()` predicates). */
  paths: Partial<Record<string, RegExp[]>>;
  /** lens → added-line probes, tested against each file's unified patch when
   * one is present. The loader compiles each probe to match ADDED lines
   * (`^\+.*(?:…)`, case-insensitive multiline). */
  addedLines: Partial<Record<string, RegExp[]>>;
}

export const EMPTY_HEURISTICS: HeuristicsExtension = { paths: {}, addedLines: {} };

/** The lenses a profile may extend: exactly the shape-selected conditionals.
 * Deliberately NOT extendable: `pass-baseline`/`pass-validate` (always in the
 * plan already), `pass-intent` (keyed on the PR body, never the file shape —
 *), `pass-placement`/`pass-simplicity` (computed from code-file
 * status/size signals, not path membership), and `pass-concurrency`/
 * `pass-ask-human` (ADDABLE-ONLY by ratified decision, — a
 * profile path predicate would be exactly the re-added selection those
 * decisions reject). */
export const PROFILE_EXTENDABLE_LENSES: readonly string[] = [
  "pass-ui",
  "pass-contracts",
  "pass-data-safety",
  "pass-security",
  "pass-statelessness",
  "pass-prod-risk",
  "pass-delivery",
  "pass-backcompat",
];

// Deterministic lens selection (spec §5): baseline always; conditional lenses
// from the changed-file shape (path + patch-content signals), each tied to
// the seeded lens's stated focus; validator always runs last (added by
// dispatch, never selected here). `ext` is the selected profile's
// extension; each conditional below ORs in its extra predicates AT ITS CORE
// POSITION, so the emitted lens order is identical with and without a profile.
export function selectLenses(
  files: PrFile[],
  intent?: { body?: string | null },
  ext: HeuristicsExtension = EMPTY_HEURISTICS,
  tuning: SelectionTuning = {},
): string[] {
  const lenses = new Set<string>(["pass-baseline"]);
  const names = files.map((f) => f.filename);
  const any = (re: RegExp) => names.some((n) => re.test(n));
  /** Added-line content signal — only fires when a patch is present. */
  const added = (re: RegExp) => files.some((f) => f.patch !== undefined && re.test(f.patch));
  /** Profile-extension signal for one lens: extra path regexes ∪ extra
   * added-line probes. */
  const extHit = (lens: string): boolean =>
    (ext.paths[lens] ?? []).some((re) => any(re)) ||
    (ext.addedLines[lens] ?? []).some((re) => added(re));

  // UI: frontend files only — extensions or an explicit frontend/ path.
  if (
    any(/\.(tsx|jsx|vue|svelte|css|scss|less|html)$/) ||
    any(/(^|\/)frontend\//) ||
    extHit("pass-ui")
  )
    lenses.add("pass-ui");

  // External contracts: provider payload surfaces — schema/serializer dirs,
  // wire-format files, integration/provider client dirs.
  if (
    any(/(^|\/)(serializers?|schemas?|integrations?|providers?|connectors?)\//) ||
    any(/\.(proto|graphql)$/) ||
    extHit("pass-contracts")
  )
    lenses.add("pass-contracts");

  // Data safety: migrations DDL, raw SQL, backfills (bulk per-row work) — not
  // every models/ touch. Framework-specific command dirs (Django's
  // management/commands/) come from the profile.
  if (
    any(/(^|\/)migrations\//) ||
    any(/\.sql$/) ||
    any(/(^|\/)backfills?\//) ||
    extHit("pass-data-safety")
  )
    lenses.add("pass-data-safety");

  // Security & tenancy: auth/permission surfaces, secret/crypto-shaped names,
  // env files, dependency manifests. Framework settings-file globs
  // (settings*.py) come from the profile. A manifest/lockfile change
  // counts only when it ADDS lines: a deletion-only hunk introduces no
  // dependency, and on AACR-Bench it fired a sol-high security pass that
  // returned NONE (immich: a docs lockfile trimmed). A lockfile that adds lines
  // with no package.json change still fires — that is the poisoning shape.
  if (
    any(/(^|\/)(auth|authn|authz|security|permissions|middleware|throttling)\//) ||
    any(/(secret|token|passw|crypt|oauth|jwt|csrf|cors)/i) ||
    any(/(^|\/)\.env(\.[^/]+)?$/) ||
    files.some((f) => DEPS_MANIFEST_RE.test(f.filename) && f.additions > 0) ||
    extHit("pass-security")
  )
    lenses.add("pass-security");

  // Statelessness: in-process state signals in the added lines (module-level
  // mutable collections, lru_cache/threading), or cache/singleton/registry
  // shaped filenames — not every tasks/ touch. The content probes carry
  // Python spellings but stay COMPILED-IN as multi-language intent (decided
  //, recorded in docs/profiles.md): they detect real cross-language
  // smells — memoization on mutable state, in-process locks, module-level
  // mutable collections — and a profile may ADD probes for other spellings,
  // never remove these.
  if (
    added(/^\+.*(@lru_cache|functools\.(cache|lru_cache))/m) ||
    added(/^\+.*threading\.(Lock|local)\(/m) ||
    added(
      /^\+[A-Za-z_][A-Za-z0-9_]*\s*(?::[^=\n]+)?=\s*(\{\}|\[\]|set\(\)|dict\(\)|defaultdict\()/m,
    ) ||
    any(/(^|\/)[^/]*(cache|singleton|registry)[^/]*\.[a-z]+$/i) ||
    extHit("pass-statelessness")
  )
    lenses.add("pass-statelessness");

  // Production risk: infra-shaped paths — IaC, CI workflows, container files.
  if (
    any(/(^|\/)(infra|ansible|terraform|helm|k8s|kubernetes)\//) ||
    any(/(^|\/)\.github\/workflows\//) ||
    any(/\.tf$/) ||
    any(/(^|\/)(Dockerfile[^/]*|docker-compose[^/]*\.ya?ml)$/) ||
    extHit("pass-prod-risk")
  )
    lenses.add("pass-prod-risk");

  // Delivery semantics: at-least-once handler surfaces — webhooks, background
  // tasks/workers/crons, queue consumers (not email/notification content
  // dirs). Product-local handler markers (e.g. a repo-specific @background_decorator)
  // come from the profile.
  if (
    any(/(^|\/)(webhooks?|tasks|jobs|workers?|crons?|consumers?|subscribers?)\//) ||
    any(/(pubsub|pub_sub|cloud_tasks|celery)/i) ||
    extHit("pass-delivery")
  )
    lenses.add("pass-delivery");

  // Placement: new (or moved — the purest placement change) CODE
  // needs a home judgment, and a cross-cutting code diff is where
  // wrong-layer changes hide. Docs/config/asset adds, test-only PRs and
  // small edits-in-place skip it — pure spend otherwise.
  const code = files.filter((f) => !isTestFile(f.filename) && CODE_FILE_RE.test(f.filename));
  if (
    code.some(
      (f) =>
        PLACEMENT_STATUSES.has(f.status ?? "") &&
        f.additions >= (tuning.placementMinNewFileLines ?? PLACEMENT_MIN_NEW_FILE_LINES),
    ) ||
    code.length >= (tuning.placementMinCodeFiles ?? PLACEMENT_MIN_PROD_FILES)
  )
    lenses.add(PLACEMENT_PASS);

  // Simplicity: complexity signals — a large code diff, deep
  // nesting in added lines, or a file gaining a pile of branches.
  const codeLines = code.reduce((n, f) => n + f.additions + f.deletions, 0);
  if (
    codeLines >= SIMPLICITY_MIN_PROD_LINES ||
    code.some((f) => f.patch !== undefined && SIMPLICITY_DEEP_INDENT_RE.test(f.patch)) ||
    code.some(
      (f) => (f.patch?.match(SIMPLICITY_BRANCH_RE)?.length ?? 0) >= SIMPLICITY_MIN_ADDED_BRANCHES,
    )
  )
    lenses.add(SIMPLICITY_PASS);

  // Backcompat: deploy-window skew surfaces — wire formats, API
  // modules, queue/task payloads, migrations, feature flags. The dir arm
  // requires a CODE file so a docs/api/ page never buys the lens. The
  // framework-shaped FILENAME arms (serializers/views/urls .py modules,
  // settings*.py) and framework flag-library names (django-waffle) come from
  // the profile; the flag probe here keeps the language-agnostic
  // spellings (feature flag itself, plus the cross-language LaunchDarkly /
  // Unleash services).
  const codeIn = (re: RegExp) => code.some((f) => re.test(f.filename));
  if (
    codeIn(
      /(^|\/)(serializers?|schemas?|apis?|views?|endpoints?|routes?|controllers?|handlers?)\//,
    ) ||
    any(/\.(proto|graphql)$/) ||
    any(/(^|\/)migrations\//) ||
    codeIn(/(^|\/)(tasks|jobs|workers?|consumers?|queues?)\//) ||
    added(/^\+.*(feature.?flag|launch.?darkly|unleash)/im) ||
    extHit(BACKCOMPAT_PASS)
  )
    lenses.add(BACKCOMPAT_PASS);

  // NOT selected here, deliberately: `pass-concurrency` and
  // `pass-ask-human`. Neither has a PATH predicate — a
  // read-modify-write race has no filename, and neither does a question whose
  // answer was never written down. pass-ask-human reaches a round through the
  // add protocol only. pass-concurrency also does, unless the diff's CONTENT
  // touches synchronisation or the PR text says it is about a race or a lock:
  // then SUBLENS_TRIGGERS plans it (owner ruling 2026-10-02, amending
  // for content). Adding a path predicate for either is a decision, not a
  // tidy-up.

  // Intent: keyed on the BODY, not the file shape — the artifact it
  // judges against is the author's own description, so a body below the
  // substance bar means the pass's only honest output would be NONE. Skip it.
  if (meetsIntentBar(intent?.body, tuning.intentMinWords)) lenses.add(INTENT_PASS);

  return [...lenses];
}

// ---- content-triggered sub-lenses (benchmark 2026-09-26) -------------------
//
// The defect benchmark (bench/aacr/RESULTS.md) traced 48 real defects the
// review kept missing: 42 were never raised by ANY pass, and the conditional
// lenses that would have caught several never ran, because the selection
// above is path-shaped. A sub-lens is a narrow pass whose whole charter is ONE
// procedure — a table the pass must fill (every consumer of a widened check,
// every sample file through a round trip, every rollout pairing) — so skipping
// a row is visible instead of silent. Each is keyed on what the diff or the PR
// text SAYS, not on where the files live, and each names its family: the
// broad lens it narrows. Passes stay leaves (rule 9): a sub-lens is its own
// flat pass, launched by the PR's main session like every other lens.
//
// Triggers are deliberately cheap and a little generous: a sub-lens that runs
// for nothing returns NONE and costs one small pass; a sub-lens that never
// runs costs the defect. `SUBLENS_TRIGGERS` is the ONE registry — a new
// sub-lens is an agent file plus one entry here.

export interface SubLensTrigger {
  lens: string;
  /** The broad lens this one narrows — documentation and the plan's notes. */
  family: string;
  /** The reason the plan shows, or null when the trigger does not fire. */
  fires: (files: PrFile[], text: string) => string | null;
}

/** Added lines of CODE files only (a README that says "encoding" is not a
 * round trip). */
function addedCode(files: PrFile[]): { file: PrFile; added: string }[] {
  return files
    .filter(
      (f) => f.patch !== undefined && CODE_FILE_RE.test(f.filename) && !isTestFile(f.filename),
    )
    .map((f) => ({
      file: f,
      added: (f.patch as string)
        .split("\n")
        .filter((l) => l.startsWith("+") && !l.startsWith("+++"))
        .join("\n"),
    }));
}

/** Changed (added or removed) lines of code files. */
function changedCode(files: PrFile[]): { file: PrFile; changed: string }[] {
  return files
    .filter(
      (f) => f.patch !== undefined && CODE_FILE_RE.test(f.filename) && !isTestFile(f.filename),
    )
    .map((f) => ({
      file: f,
      changed: (f.patch as string)
        .split("\n")
        .filter((l) => /^[+-]/.test(l) && !/^(\+\+\+|---)/.test(l))
        .join("\n"),
    }));
}

/** A predicate's name: `isBinary(`, `is_supported(`, and the prefixed C
 * style `SDL_IsJoystick8BitDo(` — the verb may follow a `Prefix_`. */
const PREDICATE_CHANGE_RE =
  /(?:^|[^A-Za-z0-9])(?:[A-Za-z0-9]*_)?(?:[iI]s|[hH]as|[cC]an|[sS]hould|[sS]upports?|[aA]llows?|[aA]ccepts?|[nN]eeds?)(?:_[a-z]|[A-Z])\w*\s*\(/;
const LITERAL_GUARD_RE = /(===|!==|==|!=)\s*(['"][^'"\n]{1,40}['"]|0x[0-9a-fA-F]+)/;
const HEX_ID_RE = /\b0x[0-9a-fA-F]{3,}\b/g;
const CASE_LABEL_RE = /^\+\s*case\s+[^:\n]+:/gm;

const ENCODING_RE =
  /\b(encoding|charset|chardet|jschardet|iconv|TextDecoder|TextEncoder|codecs?|BOM|byte.?order|utf-?(8|16)|latin-?1|windows-125\d|\\r\\n|CRLF|EOL|line.?endings?)\b|\.(decode|encode)\(/i;
const WRITE_RE =
  /\b(writeFile\w*|createWriteStream|fs\.write\w*|\.write\(|\.save\(|saveDocument|applyEdit|open\([^)\n]*['"][wa]b?\+?['"]|write_text|write_bytes)/;

/** Work that is recorded now and done later: queues, timers, coalescing, and
 * the drain step on the other side ("run the pending callbacks", flush). Case
 * does not matter — a comment saying "Coalesce" counts as much as the call —
 * and a snake_case prefix does not hide a term (`task_enqueue`). */
const DEFER_RE =
  /(?:^|[^A-Za-z0-9])(?:[A-Za-z0-9]*_)?(enqueue\w*|dequeue\w*|queue\w*|setTimeout|setImmediate|nextTick|requestAnimationFrame|debounce\w*|throttle\w*|coalesc\w*|defer\w*|schedule\w*|apply_async|delay\(|create_task|call_soon\w*|run_in_executor|go func|spawn\w*|dispatch_async|post_task|wakeup\w*|pending\w*|flush\w*|drain\w*|\w*run_\w*callbacks)/gi;

const LOOP_RE = /^\+.*\b(while\s*\(|while\s+\w|loop\s*\{|for\s*\(\s*;\s*;|for\s*\{)/m;
const REMOTE_RE =
  /\b(fetch|request|axios|http\w*|grpc|rpc|client\.\w+|recv\w*|page|offset|cursor|next_?page|has_?more|continuation)\b/i;
const READ_ALL_RE =
  /\b(readFile\w*|read_to_end|read_to_string|ReadAll|readAll|\.read\(\)|arrayBuffer\(\)|\.text\(\))/;
const LIMIT_RE = /\b(MAX_\w+|max\w*Size|size\w*Limit|limit|LIMIT\w*)\b/;
const UNCHECKED_CAST_RE =
  /(\.json\(\)\s*\)?\s*as\s+[A-Z]|as\s+[A-Z]\w*\[\]|JSON\.parse\([^)\n]*\)\s*as\s+)/;
const LEAK_RE =
  /\b(os\.Hostname|hostname\(\)|gethostname|socket\.gethostname|os\.environ|process\.env)\b/;

const CLAIM_RE =
  /\b(silenc\w*|suppress\w*|warnings?|C\d{4}|-W[a-z-]+|clippy|eslint|lint|support(s|ed)?\s+(for\s+)?\S+|compatib\w*|prevent\w*|no longer|firmware|only\s+(for|when|if|on|with)|require[sd]?\s+(version|firmware|v?\d))\b/i;

const ROLLOUT_TEXT_RE =
  /\b(hotfix|backport|sdk|protocol|wire format|older (clients?|versions?|sdks?|nodes?)|backward|compat\w*|roll-?out|mixed.?version|persist\w*|migrat\w*|validators?|client and server|server and client)\b/i;
const ROLLOUT_CODE_RE =
  /\b(persistReducer|redux-persist|createMigrate|localStorage|sessionStorage|MAX_[A-Z_]*(ENTRIES|PAGE|ITEMS|SIZE|LEN)\w*|protocol_version|api_version|schema_version|version:\s*\d)\b/;

// ---- the concurrency trigger (owner ruling 2026-10-02) ----------------------
//
// pass-concurrency was ADDABLE-ONLY: a read-modify-write race has no
// FILENAME, so no path predicate may plan it. That ruling still stands for
// paths. The owner's ruling of 2026-10-02 (after the Martian tune20 golden
// mining: the lens was never added on any of 20 PRs, one of them titled "fix
// data race", approved with zero findings) amends it for CONTENT: a diff that
// touches synchronisation itself — a mutex, an atomic, a thread or goroutine,
// a channel, a lock held across an await — or a PR whose text says it is about
// a race, a lock or thread safety, plans the lens through this registry. The
// add protocol is unchanged for every other PR, and a profile still cannot
// give the lens a path predicate (profiles.ts PROFILE_EXTENDABLE_LENSES).
//
// The probes are per language, keyed on the file's extension, so a word that
// is synchronisation in one language (`volatile`, `chan`, `<-`, `lock`) cannot
// fire on another. They test CHANGED lines (added or removed — dropping a lock
// is as much a concurrency change as adding one) of non-test code files.

/** Per-language synchronisation spellings: [extension test, probe]. */
const SYNC_PROBES: ReadonlyArray<readonly [RegExp, RegExp]> = [
  // Go: sync/atomic, Lock/Unlock calls, goroutines, channels.
  [
    /\.go$/i,
    /\bsync\.(?:Mutex|RWMutex|WaitGroup|Once|Map|Cond)\b|\bsync\/atomic\b|\batomic\.(?:Add|Load|Store|Swap|CompareAndSwap|Int32|Int64|Uint32|Uint64|Bool|Value|Pointer)\w*|\.(?:R?Lock|R?Unlock|TryR?Lock)\(\)|\bgo\s+(?:func\b|[\w.]+\()|\bchan\b|<-/,
  ],
  // Java / Kotlin / Scala: monitors, j.u.c locks and collections, atomics.
  [
    /\.(?:java|kt|kts|scala)$/i,
    /\bsynchronized\b|@Synchronized\b|\bvolatile\b|@Volatile\b|\b(?:ReentrantLock|ReentrantReadWriteLock|ReadWriteLock|StampedLock|Semaphore|CountDownLatch|CyclicBarrier|ExecutorService|CompletableFuture|ThreadLocal)\b|\bConcurrent[A-Z]\w*|\bAtomic(?:Integer|Long|Boolean|Reference)\w*|\.(?:lock|unlock|tryLock)\(\)|\bnew\s+Thread\(|\bMutex\(\)/,
  ],
  // Rust: std/tokio sync, atomics, shared ownership across threads.
  [
    /\.rs$/i,
    /\b(?:Mutex|RwLock|Condvar|Barrier)\s*(?:<|::new)|\bArc\s*<|\bAtomic(?:Bool|Usize|Isize|U\d+|I\d+|Ptr)\b|\b(?:std|tokio|parking_lot)::sync\b|\.(?:lock|try_lock)\(\)|\b(?:thread|tokio)::spawn\b|\bOrdering::(?:SeqCst|Acquire|Release|AcqRel|Relaxed)\b|\bmpsc\b|\bunsafe\s+impl\s+(?:Send|Sync)\b/,
  ],
  // C / C++: std::mutex and friends, std::atomic, pthreads, C11 atomics.
  [
    /\.(?:c|cc|cpp|cxx|h|hh|hpp|hxx)$/i,
    /\bstd::(?:mutex|shared_mutex|recursive_mutex|timed_mutex|atomic\w*|lock_guard|unique_lock|scoped_lock|shared_lock|thread|jthread|condition_variable\w*|memory_order\w*)\b|\bpthread_\w+|\batomic_\w+\s*\(|\b_Atomic\b|\bvolatile\b|\b__(?:sync|atomic)_\w+/,
  ],
  // C#: lock statements, Interlocked, concurrent collections.
  [
    /\.cs$/i,
    /\block\s*\(|\bInterlocked\.\w+|\b(?:SemaphoreSlim|Monitor|Mutex|ReaderWriterLockSlim)\b|\bConcurrent(?:Dictionary|Queue|Bag|Stack)\b|\bvolatile\b/,
  ],
  // Python: threading, asyncio primitives, process pools, row locks.
  [
    /\.pyi?$/i,
    /\bthreading\.\w+|\bfrom\s+threading\s+import\b|\basyncio\.(?:Lock|Semaphore|BoundedSemaphore|Event|Condition|Queue|gather|create_task|TaskGroup)\b|\bmultiprocessing\b|\bconcurrent\.futures\b|\b(?:ThreadPoolExecutor|ProcessPoolExecutor)\b|\bselect_for_update\(|\bwith\s+(?:self\.)?_*\w*lock\w*\s*:|\bR?Lock\(\)/i,
  ],
  // Ruby: Mutex, threads, concurrent-ruby.
  [/\.rb$/i, /\bMutex\.new\b|\bThread\.new\b|\bConcurrent::\w+|\.synchronize\b/],
  // Swift: dispatch queues, locks, actors — and Swift concurrency's isolation
  // annotations, whose ADDITION or REMOVAL changes which thread a closure may
  // run on (round 5, REVIEW-MINING.md: dropped @Sendable/@MainActor on
  // callbacks, an unsafe `nonisolated(unsafe)` and an unisolated `Task {}` went
  // unplanned on three Swift PRs).
  [
    /\.swift$/i,
    /\bDispatchQueue\b|\bNSLock\b|\bos_unfair_lock\b|\bactor\s+[A-Z]\w*|\bOSAllocatedUnfairLock\b|@Sendable\b|@MainActor\b|\bnonisolated\b|@preconcurrency\b|\bTask(?:\.detached)?\s*(?:\(\s*priority:[^)]*\))?\s*\{/,
  ],
  // JS / TS: real shared memory and workers, explicit lock libraries, and the
  // one shared-state race the added lines can show — a member written after an
  // await, or bumped in place, on an object other callers share.
  [
    /\.(?:js|jsx|mjs|cjs|ts|tsx|mts|cts)$/i,
    /\bAtomics\.\w+|\bSharedArrayBuffer\b|\bnew\s+Worker\(|\bworker_threads\b|\bnavigator\.locks\b|\b(?:Mutex|Semaphore)\b|\bthis\.[\w.]+\s*=\s*await\b/,
  ],
];

/** JS/TS: an in-place read-modify-write of a shared member, counted only in a
 * file whose changed lines also await — the shape where two callers interleave. */
const JS_FILE_RE = /\.(?:js|jsx|mjs|cjs|ts|tsx|mts|cts)$/i;
const JS_SHARED_RMW_RE = /\bthis\.[\w.]+(?:\s*(?:\+\+|--|[-+*]=)|\[[^\]\n]+\]\s*(?:\+\+|--|[-+*]=))/;
const JS_AWAIT_RE = /\bawait\b/;

/** The PR text says the change is about concurrency. `lock` counts unless it
 * is a lockfile (`package-lock`, `lock file`). */
const CONCURRENCY_TEXT_RE =
  /\b(?:data[- ]races?|race[- ]conditions?|races?|racy|concurren(?:t|tly|cy)|thread[- ]?safe(?:ty)?|deadlocks?|mutex(?:es)?|(?<![-./])lock(?:s|ing|ed)?(?![- ]?files?\b))\b/i;

/** The changed line a sync probe fired on, trimmed and capped, for the plan's
 * reason — the lens gets the code, not one token of it. */
function syncHit(filename: string, changed: string): string | null {
  const shown = (line: string): string => {
    const t = line.slice(1).trim().replace(/`/g, "'");
    return t.length > 70 ? `${t.slice(0, 67)}…` : t;
  };
  const lines = changed.split("\n");
  for (const [ext, probe] of SYNC_PROBES) {
    if (!ext.test(filename)) continue;
    const hit = lines.find((l) => probe.test(l.slice(1)));
    if (hit !== undefined) return shown(hit);
  }
  if (JS_FILE_RE.test(filename) && JS_AWAIT_RE.test(changed)) {
    const hit = lines.find((l) => JS_SHARED_RMW_RE.test(l.slice(1)));
    if (hit !== undefined) return shown(hit);
  }
  return null;
}

/** The phrase a text trigger fired on: from the match to the end of its
 * line or sentence, capped — the pass gets the claim, not one word of it. */
function phraseAt(text: string, at: number): string {
  const rest = text.slice(at).split(/\n|(?<=[.!?])\s/)[0] ?? "";
  const clean = rest.replace(/[`"]/g, "'").trim();
  return clean.length > 80 ? `${clean.slice(0, 77)}…` : clean;
}

export const SUBLENS_TRIGGERS: readonly SubLensTrigger[] = [
  // Owner ruling 2026-10-02 (amends for content, see above): first in
  // the registry so the order matches ALL_PASSES.
  {
    lens: "pass-concurrency",
    family: "pass-statelessness",
    fires: (files, text) => {
      for (const { file, changed } of changedCode(files)) {
        const hit = syncHit(file.filename, changed);
        if (hit !== null)
          return `the diff touches synchronisation in ${file.filename} (\`${hit}\`)`;
      }
      const m = CONCURRENCY_TEXT_RE.exec(text);
      return m ? `the PR text says "${phraseAt(text, m.index)}"` : null;
    },
  },
  {
    lens: "pass-widened",
    family: "pass-baseline",
    fires: (files) => {
      for (const { file, changed } of changedCode(files)) {
        if (
          /^[+-].*(function|def|func|bool|boolean|static)\b[^\n]*/m.test(changed) &&
          changed.split("\n").some((l) => PREDICATE_CHANGE_RE.test(l) && /^[+-]/.test(l))
        )
          return `a predicate changes in ${file.filename}`;
        if (changed.split("\n").some((l) => LITERAL_GUARD_RE.test(l)))
          return `a guard compares against a literal in ${file.filename}`;
      }
      for (const { file, added } of addedCode(files)) {
        const ids = new Set(added.match(HEX_ID_RE) ?? []);
        const cases = (`\n${added}`.match(CASE_LABEL_RE) ?? []).length;
        if (ids.size >= 2 || cases >= 3) return `accepted values are added in ${file.filename}`;
      }
      return null;
    },
  },
  {
    lens: "pass-roundtrip",
    family: "pass-data-safety",
    fires: (files) => {
      const code = addedCode(files);
      const enc = code.find((c) => ENCODING_RE.test(c.added));
      if (!enc) return null;
      const write = code.find((c) => WRITE_RE.test(c.added));
      // Encoding work in one file and the write in another is still a round trip.
      return write ? `encoding handling and a write-back in ${enc.file.filename}` : null;
    },
  },
  {
    lens: "pass-deferred",
    family: "pass-concurrency",
    fires: (files) => {
      for (const { file, added } of addedCode(files)) {
        // Distinct TERMS (the capture), not distinct spellings around them.
        const hits = new Set([...added.matchAll(DEFER_RE)].map((m) => (m[1] ?? "").toLowerCase()));
        if (hits.size >= 2) return `work is queued or deferred in ${file.filename}`;
      }
      return null;
    },
  },
  {
    lens: "pass-bounds",
    family: "pass-security",
    fires: (files) => {
      for (const { file, added } of addedCode(files)) {
        if (LOOP_RE.test(added) && REMOTE_RE.test(added))
          return `a loop over another party's data in ${file.filename}`;
        if (READ_ALL_RE.test(added) && LIMIT_RE.test(added))
          return `a read with a size limit in ${file.filename}`;
        if (UNCHECKED_CAST_RE.test(added))
          return `fetched data is cast to a type in ${file.filename}`;
        if (LEAK_RE.test(added)) return `host or environment facts are read in ${file.filename}`;
      }
      return null;
    },
  },
  {
    lens: "pass-claims",
    family: "pass-intent",
    fires: (_files, text) => {
      const m = CLAIM_RE.exec(text);
      return m ? `the PR text claims "${phraseAt(text, m.index)}"` : null;
    },
  },
  {
    lens: "pass-rollout",
    family: "pass-backcompat",
    fires: (files, text) => {
      const m = ROLLOUT_TEXT_RE.exec(text);
      if (m) return `the PR text mentions "${phraseAt(text, m.index)}"`;
      for (const { file, added } of addedCode(files))
        if (ROLLOUT_CODE_RE.test(added))
          return `persisted or versioned state changes in ${file.filename}`;
      return null;
    },
  },
];

/** Every sub-lens pass name, in registry order. */
export const SUBLENS_PASSES: readonly string[] = SUBLENS_TRIGGERS.map((t) => t.lens);

/** The sub-lenses this PR fires, with the reason each fired. Pure. */
export function selectSubLenses(
  files: PrFile[],
  intent?: { title?: string | null; body?: string | null },
): { lens: string; why: string }[] {
  const text = `${intent?.title ?? ""}\n${intent?.body ?? ""}`;
  const out: { lens: string; why: string }[] = [];
  for (const t of SUBLENS_TRIGGERS) {
    const why = t.fires(files, text);
    if (why) out.push({ lens: t.lens, why });
  }
  return out;
}

// ---- the per-file sweep (benchmark 2026-09-26) ------------------------------
//
// Fifteen of the 48 missed defects were "attention": the pass had the code in
// front of it and never looked — a misspelled action name quoted twice without
// being noticed, a Bluetooth ID read in six runs and never checked. The
// open-code-review baseline catches that class by reviewing one file at a
// time. The sweep is that shape inside our pipeline: the changed files, cut
// into a few small groups, one line-by-line pass per group.

export const SWEEP_PASS = "pass-sweep";

/**: the tests lens (agents/pass-tests.md). */
export const TESTS_PASS = "pass-tests";

// The code-quality lenses (2026-09-27, `[review] quality_lenses`): the review
// is geared to find defects, and a benchmark built from what reviewers
// actually write (AACR-Bench: 42% of its references are maintainability) asked
// whether the other half of a review — will the next person understand and
// safely change this — is worth a lens of its own. Three lenses, each one
// question: maintainability (readers and future edits), duplication (the same
// knowledge written twice), abstraction (boundaries and contracts at the right
// level). Style is deliberately none of them: every repo has its own, so it
// has its own lens, planned only where the repo writes its style down.
export const MAINTAINABILITY_PASS = "pass-maintainability";
export const DUPLICATION_PASS = "pass-duplication";
export const ABSTRACTION_PASS = "pass-abstraction";
/** Is the change consistent with itself and with the code around it? An
 * outlier sibling is often a defect, so this one is not capped when it shows
 * a failure. */
export const CONSISTENCY_PASS = "pass-consistency";
export const QUALITY_PASSES: readonly string[] = [
  MAINTAINABILITY_PASS,
  DUPLICATION_PASS,
  ABSTRACTION_PASS,
  CONSISTENCY_PASS,
];
/** Added non-test code lines below which a change is too small to carry a
 * maintainability, duplication or abstraction question worth a pass. */
export const QUALITY_MIN_ADDED_LINES = 20;
/** The style lens (agents/pass-style.md): planned only when the repo has a
 * written style guide (src/styleguide.ts). */
export const STYLE_PASS = "pass-style";

/** The quality lenses a change warrants: all three once its non-test code
 * adds `minAdded` lines, none below. */
export function selectQualityLenses(files: PrFileEntry[], minAdded: number): string[] {
  const added = files
    .filter((f) => !isTestFile(f.filename) && CODE_FILE_RE.test(f.filename))
    .reduce((n, f) => n + f.additions, 0);
  return added >= minAdded && added > 0 ? [...QUALITY_PASSES] : [];
}

/** Files the sweep never reads: lockfiles, generated or minified output,
 * vendored trees, snapshots, binaries and prose. */
const SWEEP_SKIP_RE =
  /((^|\/)(package-lock\.json|yarn\.lock|pnpm-lock\.yaml|Cargo\.lock|go\.sum|poetry\.lock|uv\.lock|composer\.lock|Gemfile\.lock)$|\.(min\.js|map|snap|lock|svg|png|jpe?g|gif|ico|pdf|woff2?|ttf|md|rst|txt)$|(^|\/)(vendor|third_party|node_modules|dist|build|generated)\/)/i;

/** Is `path` a file the sweep never reads? Exported for the setup engine's
 * case sizing: a unit is sized by what a pass would actually read. */
export function isSweepSkipped(path: string): boolean {
  return SWEEP_SKIP_RE.test(path);
}

/** A group stays under both caps unless one file alone exceeds them. The
 * first batch capped groups at 3 files and 32 of its 36 groups came out under
 * 60 changed lines — a whole pass for a handful of lines — so the defaults
 * are sized to hold a typical small PR in one or two passes. */
export const SWEEP_MAX_FILES_PER_GROUP = 5;
export const SWEEP_MAX_LINES_PER_GROUP = 500;

/**
 * Cut the PR's changed files into sweep groups: diff order, greedy, at most
 * `SWEEP_MAX_FILES_PER_GROUP` files and `SWEEP_MAX_LINES_PER_GROUP` changed
 * lines per group, at most `maxGroups` groups. Files past the last group come
 * back in `unswept` so the plan can say so — a silent cap reads as "covered".
 */
export function sweepGroups(
  files: PrFile[],
  maxGroups: number,
  maxFiles: number = SWEEP_MAX_FILES_PER_GROUP,
  maxLines: number = SWEEP_MAX_LINES_PER_GROUP,
): { groups: string[][]; unswept: string[] } {
  const eligible = files.filter(
    (f) => f.status !== "removed" && f.additions > 0 && !SWEEP_SKIP_RE.test(f.filename),
  );
  const groups: string[][] = [];
  let cur: string[] = [];
  let lines = 0;
  const unswept: string[] = [];
  for (const f of eligible) {
    const size = f.additions + f.deletions;
    if (cur.length > 0 && (cur.length >= maxFiles || lines + size > maxLines)) {
      groups.push(cur);
      cur = [];
      lines = 0;
    }
    if (groups.length >= maxGroups) {
      unswept.push(f.filename);
      continue;
    }
    cur.push(f.filename);
    lines += size;
  }
  if (cur.length > 0) {
    if (groups.length < maxGroups) groups.push(cur);
    else unswept.push(...cur);
  }
  return { groups, unswept };
}
