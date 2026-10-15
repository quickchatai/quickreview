// Pure dispatch heuristics: test-file exclusion, the migration gate, lens
// selection, sub-lens triggers, sweep / behaviour-delta / baseline grouping
// and the pass tier. Consumed by dispatch; unit-tested directly.

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

// A file is a test file iff any of these match.
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

// There is no escalation-worthiness score, and none may be reintroduced under
// another name (CLAUDE.md rule 10): the tier ladder below keys on size and the
// migration gate alone.

/** A path under a `migrations/` directory — the one spelling of "this file is
 * a migration" shared by the migration gate, lens selection, the ecosystem
 * pre-check and the recheck's renumber classifier. */
export const MIGRATION_DIR_RE = /(^|\/)migrations\//;

export function isMigrationPath(path: string): boolean {
  return MIGRATION_DIR_RE.test(path);
}

export function migrationGate(files: PrFile[]): boolean {
  return files.some((f) => isMigrationPath(f.filename));
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

// ---- pass-intent -----------------------------------------------------------
//
// Does the PR do what its author said it would? Its intent
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
 * can test a tighter plan on the same image. Absent ⇒ the compiled defaults.
 */
export interface SelectionTuning {
  /** pass-intent's substance bar (words of author prose). */
  intentMinWords?: number;
  /** Placement fires on this many code files… */
  placementMinCodeFiles?: number;
  /** …or on a new code file with at least this many added lines (0 = any). */
  placementMinNewFileLines?: number;
}

// ---- placement / simplicity / backcompat -----------------------------------
//
// Three judgment lenses. Selection is deterministic like everything above;
// the caps (placement and simplicity post at P2 max) are enforced at the
// validator via PASS_ADDENDA, not here.

export const PLACEMENT_PASS = "pass-placement";
export const SIMPLICITY_PASS = "pass-simplicity";
export const BACKCOMPAT_PASS = "pass-backcompat";

/** A public or exported declaration on a removed or changed line: TS/JS
 * `export`, Go exported funcs/types, Rust `pub`, Java/Kotlin/C#/Swift `public`,
 * Python names in `__all__` or a top-level `def`/`class` without a leading
 * underscore. */
export const PUBLIC_SIGNATURE_RE =
  /^(?:\s*(?:export\s+(?:default\s+)?(?:async\s+)?(?:function|class|const|interface|type|enum)\b|func\s+(?:\([^)]*\)\s*)?[A-Z]\w*\s*\(|type\s+[A-Z]\w*\s|pub(?:\([^)]*\))?\s+(?:async\s+)?(?:fn|struct|enum|trait|type|const|mod)\b|public\s+(?:static\s+)?(?:final\s+)?(?:abstract\s+)?[\w<>[\],\s]+\s+\w+\s*\(|public\s+(?:class|interface|enum|record)\b|__all__\s*=)|(?:def|class)\s+[A-Za-z]\w*)/;
/** A wire-serialization site on a changed line: field names and order that
 * a peer or a stored payload agrees with. */
export const WIRE_FORMAT_RE =
  /(\bwriteTo\s*\(|\breadFrom\s*\(|@JsonProperty|@SerializedName|@JsonKey|\bserde\s*\(|#\[serde\(|\bStreamOutput\b|\bStreamInput\b|\bjson:"|\bprotobuf\b|\bMarshal\w*\(|\bUnmarshal\w*\()/;

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
 * the lean plan, measured on the defect benchmark to keep recall at ~15% less
 * spend. */
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

// ---- profile heuristics extension -----------------------------------------
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
 * plan already), `pass-intent` (keyed on the PR body, never the file shape),
 * `pass-placement`/`pass-simplicity` (computed from code-file status/size
 * signals, not path membership), and `pass-concurrency`/`pass-ask-human`
 * (never selected by path: a race or an unwritten answer has no filename, so a
 * profile path predicate would be exactly the selection that rule refuses). */
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

// Deterministic lens selection: baseline always; conditional lenses
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
  /** Filled with why each lens was planned: the plan explains every lens it
   * chose. */
  reasons?: Map<string, string>,
): string[] {
  const lenses = new Set<string>(["pass-baseline"]);
  reasons?.set("pass-baseline", "every round: the PR against its own claims");
  const names = files.map((f) => f.filename);
  // The signal that fired last — the conditions below are OR-chains, so when
  // one is true this names the arm that made it true.
  let lastHit = "";
  const any = (re: RegExp) => {
    const n = names.find((x) => re.test(x));
    if (n !== undefined) lastHit = `the diff touches ${n}`;
    return n !== undefined;
  };
  /** Added-line content signal — only fires when a patch is present. */
  const added = (re: RegExp) => {
    const f = files.find((x) => x.patch !== undefined && re.test(x.patch));
    if (f !== undefined) lastHit = `an added line in ${f.filename} matches its signal`;
    return f !== undefined;
  };
  const pick = (lens: string, why?: string) => {
    lenses.add(lens);
    reasons?.set(lens, why ?? lastHit);
  };
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
    pick("pass-ui");

  // External contracts: provider payload surfaces — schema/serializer dirs,
  // wire-format files, integration/provider client dirs.
  if (
    any(/(^|\/)(serializers?|schemas?|integrations?|providers?|connectors?)\//) ||
    any(/\.(proto|graphql)$/) ||
    extHit("pass-contracts")
  )
    pick("pass-contracts");

  // Data safety: migrations DDL, raw SQL, backfills (bulk per-row work) — not
  // every models/ touch. Framework-specific command dirs (Django's
  // management/commands/) come from the profile.
  if (
    any(MIGRATION_DIR_RE) ||
    any(/\.sql$/) ||
    any(/(^|\/)backfills?\//) ||
    extHit("pass-data-safety")
  )
    pick("pass-data-safety");

  // Security & tenancy: auth/permission surfaces, secret/crypto-shaped names,
  // env files, dependency manifests. Framework settings-file globs
  // (settings*.py) come from the profile. A manifest/lockfile change counts
  // only when it adds lines: a deletion-only hunk introduces no dependency. A
  // lockfile that adds lines with no package.json change still fires — that is
  // the poisoning shape.
  if (
    any(/(^|\/)(auth|authn|authz|security|permissions|middleware|throttling)\//) ||
    any(/(secret|token|passw|crypt|oauth|jwt|csrf|cors)/i) ||
    any(/(^|\/)\.env(\.[^/]+)?$/) ||
    files.some((f) => {
      const hit = DEPS_MANIFEST_RE.test(f.filename) && f.additions > 0;
      if (hit) lastHit = `the diff adds lines to the dependency manifest ${f.filename}`;
      return hit;
    }) ||
    extHit("pass-security")
  )
    pick("pass-security");

  // Statelessness: in-process state signals in the added lines (module-level
  // mutable collections, lru_cache/threading), or cache/singleton/registry
  // shaped filenames — not every tasks/ touch. The content probes carry
  // Python spellings but stay compiled in as multi-language intent
  // (docs/profiles.md): they detect real cross-language
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
    pick("pass-statelessness");

  // Production risk: infra-shaped paths — IaC, CI workflows, container files.
  if (
    any(/(^|\/)(infra|ansible|terraform|helm|k8s|kubernetes)\//) ||
    any(/(^|\/)\.github\/workflows\//) ||
    any(/\.tf$/) ||
    any(/(^|\/)(Dockerfile[^/]*|docker-compose[^/]*\.ya?ml)$/) ||
    extHit("pass-prod-risk")
  )
    pick("pass-prod-risk");

  // Delivery semantics: at-least-once handler surfaces — webhooks, background
  // tasks/workers/crons, queue consumers (not email/notification content
  // dirs). Product-local handler markers (e.g. a repo-specific @background_decorator)
  // come from the profile.
  if (
    any(/(^|\/)(webhooks?|tasks|jobs|workers?|crons?|consumers?|subscribers?)\//) ||
    any(/(pubsub|pub_sub|cloud_tasks|celery)/i) ||
    extHit("pass-delivery")
  )
    pick("pass-delivery");

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
    pick(
      PLACEMENT_PASS,
      code.length >= (tuning.placementMinCodeFiles ?? PLACEMENT_MIN_PROD_FILES)
        ? `the diff touches ${code.length} code files`
        : "the diff adds or moves a code file that needs a home",
    );

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
    pick(
      SIMPLICITY_PASS,
      codeLines >= SIMPLICITY_MIN_PROD_LINES
        ? `the code diff is ${codeLines} lines`
        : "added code nests deeply or piles up branches",
    );

  // Backcompat: deploy-window skew surfaces — wire formats, API
  // modules, queue/task payloads, migrations, feature flags. The dir arm
  // requires a CODE file so a docs/api/ page never buys the lens. The
  // framework-shaped FILENAME arms (serializers/views/urls .py modules,
  // settings*.py) and framework flag-library names (django-waffle) come from
  // the profile; the flag probe here keeps the language-agnostic
  // spellings (feature flag itself, plus the cross-language LaunchDarkly /
  // Unleash services).
  const codeIn = (re: RegExp) => {
    const f = code.find((x) => re.test(x.filename));
    if (f !== undefined) lastHit = `the diff touches ${f.filename}`;
    return f !== undefined;
  };
  // Content, not paths: a changed or removed public signature or a
  // wire-serialization change breaks callers and peers that were built against
  // the old one, wherever the file lives — a library's exported API, a
  // mixed-version cluster's wire format.
  const publicSurface = (): boolean => {
    for (const f of code) {
      if (f.patch === undefined) continue;
      const removed = f.patch
        .split("\n")
        .find(
          (l) => l.startsWith("-") && !l.startsWith("---") && PUBLIC_SIGNATURE_RE.test(l.slice(1)),
        );
      if (removed !== undefined) {
        lastHit = `a public signature changes in ${f.filename}`;
        return true;
      }
      if (
        /^[+-](?![+-]).*/m.test(f.patch) &&
        f.patch.split("\n").some((l) => /^[+-](?![+-])/.test(l) && WIRE_FORMAT_RE.test(l))
      ) {
        lastHit = `wire serialization changes in ${f.filename}`;
        return true;
      }
    }
    return false;
  };
  if (
    codeIn(
      /(^|\/)(serializers?|schemas?|apis?|views?|endpoints?|routes?|controllers?|handlers?)\//,
    ) ||
    any(/\.(proto|graphql)$/) ||
    any(MIGRATION_DIR_RE) ||
    codeIn(/(^|\/)(tasks|jobs|workers?|consumers?|queues?)\//) ||
    added(/^\+.*(feature.?flag|launch.?darkly|unleash)/im) ||
    publicSurface() ||
    extHit(BACKCOMPAT_PASS)
  )
    pick(BACKCOMPAT_PASS);

  // Not selected here, deliberately: `pass-concurrency` and `pass-ask-human`.
  // Neither has a path predicate — a
  // read-modify-write race has no filename, and neither does a question whose
  // answer was never written down. pass-ask-human reaches a round through the
  // add protocol only. pass-concurrency also does, unless the diff's CONTENT
  // touches synchronisation or the PR text says it is about a race or a lock:
  // then SUBLENS_TRIGGERS plans it. Adding a path predicate for either is a
  // decision, not a tidy-up.

  // Intent: keyed on the BODY, not the file shape — the artifact it
  // judges against is the author's own description, so a body below the
  // substance bar means the pass's only honest output would be NONE. Skip it.
  if (meetsIntentBar(intent?.body, tuning.intentMinWords))
    pick(INTENT_PASS, "the PR body is long enough to state intent the diff can be checked against");

  return [...lenses];
}

// ---- content-triggered sub-lenses ------------------------------------------
//
// The selection above is path-shaped, so a defect whose lens is chosen by what
// the diff says, not where it lives, can go unplanned (bench/aacr/RESULTS.md).
// A sub-lens is a narrow pass whose whole charter is ONE
// procedure — a table the pass must fill (every consumer of a widened check,
// every sample file through a round trip, every rollout pairing) — so skipping
// a row is visible instead of silent. Each is keyed on what the diff or the PR
// text SAYS, not on where the files live, and each names its family: the
// broad lens it narrows. Passes stay leaves (rule 9): a sub-lens is its own
// flat pass, launched by the PR's main session like every other lens.
//
// Triggers are deliberately cheap and a little generous: a sub-lens that runs
// for nothing returns NONE and costs one small pass; a sub-lens that never
// runs costs the defect. `SUBLENS_TRIGGERS` is the one registry — a new
// sub-lens is an agent file plus one entry here.

export interface SubLensTrigger {
  lens: string;
  /** The broad lens this one narrows — documentation and the plan's notes. */
  family: string;
  /** The reason the plan shows, or null when the trigger does not fire. */
  fires: (files: PrFile[], text: string) => string | null;
}

/** A non-test CODE file whose patch the content triggers can read — the
 * one population both `addedCode` and `changedCode` scan. */
function isPatchedSourceCode(f: PrFile): boolean {
  return f.patch !== undefined && CODE_FILE_RE.test(f.filename) && !isTestFile(f.filename);
}

/** Added lines of CODE files only (a README that says "encoding" is not a
 * round trip). */
function addedCode(files: PrFile[]): { file: PrFile; added: string }[] {
  return files.filter(isPatchedSourceCode).map((f) => ({
    file: f,
    added: (f.patch as string)
      .split("\n")
      .filter((l) => l.startsWith("+") && !l.startsWith("+++"))
      .join("\n"),
  }));
}

/** Changed (added or removed) lines of code files. */
function changedCode(files: PrFile[]): { file: PrFile; changed: string }[] {
  return files.filter(isPatchedSourceCode).map((f) => ({
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

/** A stated behaviour: "outputs the last lines that fit",
 * "keeps only the newest", "returns all …" — a one-line PR body below the
 * intent bar can still make a claim the code contradicts, and the claim check
 * is cheap. */
const BEHAVIOUR_CLAIM_RE =
  /\b(outputs?|returns?|renders?|displays?|shows?|keeps?|preserves?|ensures?|guarantees?|prints?|emits?)\s+(the|only|all|every|a|an|last|first|newest|latest|oldest)\b/i;

const ROLLOUT_TEXT_RE =
  /\b(hotfix|backport|sdk|protocol|wire format|older (clients?|versions?|sdks?|nodes?)|backward|compat\w*|roll-?out|mixed.?version|persist\w*|migrat\w*|validators?|client and server|server and client)\b/i;
const ROLLOUT_CODE_RE =
  /\b(persistReducer|redux-persist|createMigrate|localStorage|sessionStorage|MAX_[A-Z_]*(ENTRIES|PAGE|ITEMS|SIZE|LEN)\w*|protocol_version|api_version|schema_version|version:\s*\d)\b/;

// ---- the concurrency trigger ----------------------------------------------
//
// A read-modify-write race has no filename, so no path predicate may plan
// pass-concurrency. Content may: left to the add protocol alone, the lens went
// unplanned even on a PR titled "fix data race". So a diff that
// touches synchronisation itself — a mutex, an atomic, a thread or goroutine,
// a channel, a lock held across an await — or a PR whose text says it is about
// a race, a lock or thread safety, plans the lens through this registry. The
// add protocol is unchanged for every other PR, and a profile still cannot
// give the lens a path predicate (PROFILE_EXTENDABLE_LENSES above).
//
// The probes are per language, keyed on the file's extension, so a word that
// is synchronisation in one language (`volatile`, `chan`, `<-`, `lock`) cannot
// fire on another. They test changed lines (added or removed — dropping a lock
// is as much a concurrency change as adding one) of non-test code files.

/** The JS/TS family's extensions — one test for both of its signals below. */
const JS_FILE_RE = /\.(?:js|jsx|mjs|cjs|ts|tsx|mts|cts)$/i;

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
  // annotations, whose addition or removal changes which thread a closure may
  // run on (a dropped @Sendable/@MainActor on a callback, `nonisolated(unsafe)`,
  // an unisolated `Task {}`).
  [
    /\.swift$/i,
    /\bDispatchQueue\b|\bNSLock\b|\bos_unfair_lock\b|\bactor\s+[A-Z]\w*|\bOSAllocatedUnfairLock\b|@Sendable\b|@MainActor\b|\bnonisolated\b|@preconcurrency\b|\bTask(?:\.detached)?\s*(?:\(\s*priority:[^)]*\))?\s*\{/,
  ],
  // JS / TS: real shared memory and workers, explicit lock libraries, and the
  // one shared-state race the added lines can show — a member written after an
  // await, or bumped in place, on an object other callers share.
  [
    JS_FILE_RE,
    /\bAtomics\.\w+|\bSharedArrayBuffer\b|\bnew\s+Worker\(|\bworker_threads\b|\bnavigator\.locks\b|\b(?:Mutex|Semaphore)\b|\bthis\.[\w.]+\s*=\s*await\b/,
  ],
];

/** JS/TS: an in-place read-modify-write of a shared member, counted only in a
 * file whose changed lines also await — the shape where two callers interleave. */
const JS_SHARED_RMW_RE =
  /\bthis\.[\w.]+(?:\s*(?:\+\+|--|[-+*]=)|\[[^\]\n]+\]\s*(?:\+\+|--|[-+*]=))/;
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
  // The concurrency trigger (see above): first in the registry so the order
  // matches ALL_PASSES.
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
      const m = CLAIM_RE.exec(text) ?? BEHAVIOUR_CLAIM_RE.exec(text);
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

// ---- the per-file sweep ----------------------------------------------------
//
// Some misses are attention: the pass had the code in front of it and never
// looked (a misspelled name quoted twice, an ID never checked). Reviewing a
// few files at a time catches that class. The sweep is that shape: the
// changed files, cut into a few small groups, one line-by-line pass per group.

export const SWEEP_PASS = "pass-sweep";

/** The behaviour-delta lens (agents/pass-behaviour-delta.md): base versus
 * head on every modified, rewrapped, replaced or deleted line of non-test
 * code — a safeguard made conditional, a value changed in a new `else`,
 * deleted handling, nil turned into an empty map. No other lens reads base and
 * head side by side (the sweep reads added lines only and skips removed
 * files). */
export const BEHAVIOUR_DELTA_PASS = "pass-behaviour-delta";

// Behaviour-delta is planned only where base behaviour is at risk, not on
// every modified line (planned everywhere, it was nearly all noise). A file is
// at risk when its patch removes or replaces a line that carries behaviour — a
// guard or condition, a predicate or comparison, a call, a return / raise /
// default / error path, an assignment — rather than a comment, an import, a
// log line or a re-indented copy of itself (a statement re-added at the same
// indent elsewhere is a reorder, and counts); or when it wraps existing code in a NEW
// branch (a guard rewrapped, a value changed in a new `else`). A deleted file,
// and a file whose patch is not available, stay at risk: no signal is never
// read as no risk.
const DELTA_RISK_RE =
  /\b(if|elif|else|unless|guard|while|for|foreach|switch|case|match|when|try|catch|except|finally|rescue|ensure|defer|raise|throw|throws|return|yield|await|assert|require|default|break|continue|goto|null|nil|None|undefined)\b|&&|\|\||\?\?|[!=]==?|[<>]=|\w\s*[<>]\s*\w|[^=!<>:+\-*/%&|^]=[^=>]|\w\s*\(/;
const DELTA_NEW_BRANCH_RE =
  /^\s*(\}\s*)?(if|elif|else|unless|guard|switch|case|match|try|catch|except|rescue|when)\b/;
const DELTA_INERT_RE =
  /^\s*(\/\/|#(?!include|define|if|else|endif)|\*|\/\*|--|"""|'''|<!--)|^\s*(import|from\s+\S+\s+import|#include|use\s|using\s|package\s|export\s+\{[^}]*\}\s+from)\b|^\s*[)\]};,]*\s*$/;
const DELTA_LOG_ONLY_RE =
  /^\s*(console\.(log|debug|info|warn|error)|(self\.|this\.)?(log|logger|logging|LOG|Log)\.(trace|debug|info|warn|warning|error|fatal|Debugf|Infof|Warnf|Errorf)|print(ln|f)?|fmt\.Print(ln|f)?|System\.out\.print(ln)?|puts|echo)\s*\(/;
const norm = (l: string): string => l.replace(/\s+/g, " ").trim();

/** Does this file's change put base behaviour at risk? (see DELTA_RISK_RE). */
export function behaviourDeltaRisk(f: PrFile): boolean {
  if (f.status === "removed" || f.status === "deleted") return true;
  if (f.patch === undefined || f.patch === "") return true;
  const removed: string[] = [];
  const added: string[] = [];
  for (const line of f.patch.split("\n")) {
    if (line.startsWith("---") || line.startsWith("+++")) continue;
    if (line.startsWith("-")) removed.push(line.slice(1));
    else if (line.startsWith("+")) added.push(line.slice(1));
  }
  if (removed.length === 0) return false;
  const addedExact = new Set(added);
  const addedNorm = new Set(added.map(norm));
  for (const r of removed) {
    const n = norm(r);
    if (n === "") continue;
    // The same statement re-indented (a rewrap) is judged by the new-branch
    // check below; the same statement at the same indent re-added elsewhere is
    // a reorder, which changes behaviour, so it falls through to the risk test.
    if (addedNorm.has(n) && !addedExact.has(r)) continue;
    if (DELTA_INERT_RE.test(r) || DELTA_LOG_ONLY_RE.test(r)) continue;
    if (DELTA_RISK_RE.test(r)) return true;
  }
  // existing code wrapped in a NEW branch: a guard rewrapped, a value changed in a new else
  return added.some((a) => DELTA_NEW_BRANCH_RE.test(a) && !addedSetHasRemoved(a, removed));
}

function addedSetHasRemoved(a: string, removed: string[]): boolean {
  const n = norm(a);
  return removed.some((r) => norm(r) === n);
}

/**
 * Cut the PR's MODIFYING changes into behaviour-delta groups: non-test code
 * files that delete or replace lines AND put base behaviour at risk
 * (`behaviourDeltaRisk`; a file the PR removes included; pure additions are not
 * this lens's), diff order, packed by changed lines (at most `maxLines` per
 * group unless one file alone exceeds it), at most `maxGroups` groups. Files
 * past the last group come back in `unread` — a silent cap reads as covered.
 */
export function behaviourDeltaGroups(
  files: PrFile[],
  maxGroups: number,
  maxLines: number,
): { groups: string[][]; unread: string[] } {
  const eligible = files.filter(
    (f) =>
      f.deletions > 0 &&
      CODE_FILE_RE.test(f.filename) &&
      !isTestFile(f.filename) &&
      !SWEEP_SKIP_RE.test(f.filename) &&
      behaviourDeltaRisk(f),
  );
  const { groups, left: unread } = packGroups(
    eligible,
    (f) => f.additions + f.deletions,
    maxGroups,
    Number.POSITIVE_INFINITY,
    maxLines,
  );
  return { groups, unread };
}

/**
 * Greedy packing in the given order: a group closes when the next file would
 * take it past `maxFiles` files or `maxLines` lines (a file alone may exceed
 * `maxLines`), and at most `maxGroups` groups are made. Files past the last
 * group come back in `left`, never dropped.
 */
function packGroups(
  files: readonly PrFile[],
  size: (f: PrFile) => number,
  maxGroups: number,
  maxFiles: number,
  maxLines: number,
): { groups: string[][]; left: string[] } {
  const groups: string[][] = [];
  const left: string[] = [];
  let cur: string[] = [];
  let lines = 0;
  for (const f of files) {
    const n = size(f);
    if (cur.length > 0 && (cur.length >= maxFiles || lines + n > maxLines)) {
      groups.push(cur);
      cur = [];
      lines = 0;
    }
    if (groups.length >= maxGroups) {
      left.push(f.filename);
      continue;
    }
    cur.push(f.filename);
    lines += n;
  }
  if (cur.length > 0) {
    if (groups.length < maxGroups) groups.push(cur);
    else left.push(...cur);
  }
  return { groups, left };
}

/** The tests lens (agents/pass-tests.md). */
export const TESTS_PASS = "pass-tests";

// The code-quality lenses (`[review] quality_lenses`): the other half of a
// review — will the next person understand and safely change this — beside the
// defect-finding lenses. Three lenses, each one question: maintainability
// (readers and future edits), duplication (the same knowledge written twice),
// abstraction (boundaries and contracts at the right level). Style is
// deliberately none of them: every repo has its own, so it has its own lens,
// planned only where the repo writes its style down.
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
/** The lint-conformance sub-lens (agents/pass-lint-conformance.md): planned
 * only when a CI job runs a linter whose rules cover a changed file. */
export const LINT_CONFORMANCE_PASS = "pass-lint-conformance";

/** The quality lenses a change warrants: all of them once its non-test code
 * adds `minAdded` lines — or, on a test-only change (a test file is code a
 * reader maintains too), once its test code adds that many —
 * none below. */
export function selectQualityLenses(files: PrFileEntry[], minAdded: number): string[] {
  const { added } = qualityCount(files);
  return added >= minAdded && added > 0 ? [...QUALITY_PASSES] : [];
}

/** What the quality lenses count: the added lines of non-test code — or, on a
 * test-only change, of its test code. One count for the selection and the
 * reason the plan shows. */
function qualityCount(files: PrFileEntry[]): { testOnly: boolean; added: number } {
  const code = files.filter((f) => CODE_FILE_RE.test(f.filename));
  const testOnly = code.length > 0 && code.every((f) => isTestFile(f.filename));
  const added = code
    .filter((f) => isTestFile(f.filename) === testOnly)
    .reduce((n, f) => n + f.additions, 0);
  return { testOnly, added };
}

/** Why the quality lenses were planned, for the plan. */
export function qualityReason(files: PrFileEntry[], minAdded: number): string {
  const { testOnly, added: n } = qualityCount(files);
  return testOnly
    ? `a test-only change adds ${n} lines of test code (at least ${minAdded})`
    : `the change adds ${n} lines of non-test code (at least ${minAdded})`;
}

/** Files the sweep never reads: lockfiles, generated or minified output,
 * vendored trees, snapshots, binaries and prose — and translation catalogs
 * (`TRANSLATION_FILE_RE`). */
const SWEEP_SKIP_RE =
  /((^|\/)(package-lock\.json|yarn\.lock|pnpm-lock\.yaml|Cargo\.lock|go\.sum|poetry\.lock|uv\.lock|composer\.lock|Gemfile\.lock)$|\.(min\.js|map|snap|lock|svg|png|jpe?g|gif|ico|pdf|woff2?|ttf|md|rst|txt)$|(^|\/)(vendor|third_party|node_modules|dist|build|generated)\/)/i;

/** Translation catalogs: a data file under a locale /
 * translation directory, or a gettext / XLIFF / ARB catalog anywhere. A
 * line-by-line sweep of one is a row spent reading strings: one
 * per-language config change can touch dozens of these at once. The PR's other
 * lenses still see them (pass-ui owns translations where a profile says so),
 * and they still count toward the change — only the sweep skips them. */
const TRANSLATION_FILE_RE =
  /((^|\/)(locales?|i18n|l10n|translations?|langs?)\/(.+\/)?[^/]+\.(json|ya?ml|po|pot|xliff|xlf|arb|strings|properties|toml)$|\.(po|pot|xliff|xlf|arb)$)/i;

/** Is `path` a translation catalog the sweep skips (`TRANSLATION_FILE_RE`)? */
export function isTranslationFile(path: string): boolean {
  return TRANSLATION_FILE_RE.test(path);
}

/** Config and data files: what a "light" sweep row may hold besides tests and
 * prose. Source in a config-shaped language (a Dockerfile, a shell script, a
 * CI workflow's embedded script) is NOT light — it runs. */
const LIGHT_DATA_FILE_RE = /\.(json|jsonc|ya?ml|toml|ini|cfg|conf|properties|xml|csv|tsv|env)$/i;

/**
 * Is `path` a file a sweep row can read at a cheaper tier
 * (`[review] sweep_light_tier`)? Tests, prose and config/data files — the
 * rows that hold no production code. A CI workflow (`.github/workflows/`)
 * is not: its steps run.
 */
export function isLightSweepFile(path: string): boolean {
  if (/(^|\/)\.github\/workflows\//.test(path)) return false;
  return isTestFile(path) || SWEEP_DOC_RE.test(path) || LIGHT_DATA_FILE_RE.test(path);
}

/** Prose the sweep reads when the PR also changes code. */
const SWEEP_DOC_RE = /\.(md|mdx|rst|adoc)$/i;

/** Is `path` a file the sweep never reads? Exported for the setup engine's
 * case sizing: a unit is sized by what a pass would actually read. */
export function isSweepSkipped(path: string): boolean {
  return SWEEP_SKIP_RE.test(path) || TRANSLATION_FILE_RE.test(path);
}

/** A group stays under both caps unless one file alone exceeds them. The
 * defaults are sized to hold a typical small PR in one or two passes, so no
 * pass is spent on a handful of lines. */
export const SWEEP_MAX_FILES_PER_GROUP = 8;
export const SWEEP_MAX_LINES_PER_GROUP = 500;
/** A WIDE change — more eligible files than `maxFiles × maxGroups`, so the
 * file cap would leave files unswept — is packed by its changed-line budget
 * instead, at most this many files per group: cost tracks the number of
 * passes, and a wide, shallow change would otherwise run every sweep pass and
 * still leave most files unswept. Every non-wide plan is unchanged by it.
 * 0 turns the rule off. */
export const SWEEP_WIDE_FILES_PER_GROUP = 40;

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
  wideFiles: number = SWEEP_WIDE_FILES_PER_GROUP,
): { groups: string[][]; unswept: string[] } {
  // Changed prose (docs, READMEs) is swept too when the PR
  // also changes code — its commands, API names and examples can go stale with
  // the code — and every group is filled source-first: code, then tests and
  // fixtures, then prose, so a group cap starves the least likely place for a
  // defect, never a source file. A prose file counts half its lines.
  const changesCode = files.some(
    (f) => f.status !== "removed" && CODE_FILE_RE.test(f.filename) && !isTestFile(f.filename),
  );
  const isDoc = (name: string): boolean => SWEEP_DOC_RE.test(name);
  const rank = (name: string): number => (isDoc(name) ? 2 : isTestFile(name) ? 1 : 0);
  const eligible = files
    .filter(
      (f) =>
        f.status !== "removed" &&
        f.additions > 0 &&
        !TRANSLATION_FILE_RE.test(f.filename) &&
        (!SWEEP_SKIP_RE.test(f.filename) || (changesCode && isDoc(f.filename))),
    )
    .map((f, i) => ({ f, i }))
    .sort((a, b) => rank(a.f.filename) - rank(b.f.filename) || a.i - b.i)
    .map((x) => x.f);
  // A wide, shallow change: pack by changed lines, not by file count, so the
  // budget of passes covers every file instead of running out of groups.
  if (wideFiles > maxFiles && eligible.length > maxFiles * maxGroups) maxFiles = wideFiles;
  const { groups, left: unswept } = packGroups(eligible, sweepSize, maxGroups, maxFiles, maxLines);
  return { groups, unswept };
}

/** A file's changed lines by the sweep's sizing rule: prose counts half. */
function sweepSize(f: PrFile): number {
  const lines = f.additions + f.deletions;
  return SWEEP_DOC_RE.test(f.filename) ? Math.ceil(lines / 2) : lines;
}

/** At most this many pass-baseline rows when a very large change splits it:
 * each row is a whole baseline reading, so more rows buy a shorter
 * critical path at the price of more parallel full readings. */
export const BASELINE_SPLIT_MAX_ROWS = 3;

/** The changed lines a reader of `f` reads, by the sweep's own sizing rule:
 * prose half, lockfiles / generated / vendored / binary nothing, the rest
 * additions + deletions. */
function readLines(f: PrFile): number {
  if (SWEEP_DOC_RE.test(f.filename)) return sweepSize(f);
  return SWEEP_SKIP_RE.test(f.filename) ? 0 : sweepSize(f);
}

/** The changed lines `baselineGroups` measures a change by. */
export function baselineSplitLines(files: readonly PrFile[]): number {
  return files.reduce((n, f) => n + readLines(f), 0);
}

/**
 * Split pass-baseline by file group on a very large change
 * (`[review] baseline_split_lines`). pass-baseline is one row and, once the
 * fan-out launches in one turn, the round's critical path on the largest
 * PRs.
 *
 * Over `splitLines` changed lines (`baselineSplitLines`; 0 = never) the
 * change's files — every one the PR does not remove — are cut, in diff order
 * (directories stay together), into `ceil(lines / splitLines)` groups, at
 * most `maxRows`, balanced by those lines: each file goes to the group its
 * line midpoint falls in, so no file is split and every file has exactly one
 * group. A group under a quarter of its share joins its neighbour, so a
 * file that weighs nothing, or a few lines beside one file that is nearly
 * the whole change, never buys a row. Each group is where one baseline row
 * STARTS; the row's charter stays the whole PR.
 *
 * Returns `[]` — one ordinary row — at or under the
 * threshold, and when the cut leaves fewer than two groups.
 */
export function baselineGroups(
  files: readonly PrFile[],
  splitLines: number,
  maxRows: number = BASELINE_SPLIT_MAX_ROWS,
): string[][] {
  if (!(splitLines > 0)) return [];
  const total = baselineSplitLines(files);
  if (total <= splitLines) return [];
  const n = Math.min(Math.max(maxRows, 1), Math.ceil(total / splitLines));
  if (n < 2) return [];
  const target = total / n;
  const groups = Array.from({ length: n }, () => ({ files: [] as string[], lines: 0 }));
  let before = 0;
  for (const f of files) {
    if (f.status === "removed") continue;
    const w = readLines(f);
    const g = groups[Math.min(n - 1, Math.floor((before + w / 2) / target))]!;
    g.files.push(f.filename);
    g.lines += w;
    before += w;
  }
  // A group under a quarter of its share — weightless files past the last
  // real one, or the crumbs beside one file that is nearly the whole change —
  // is not worth a whole baseline reading: its files join the group before
  // it, or the one after when it is first.
  const kept: string[][] = [];
  let carry: string[] = [];
  for (const g of groups) {
    if (g.lines >= target / 4) {
      kept.push([...carry, ...g.files]);
      carry = [];
    } else if (kept.length > 0) kept.at(-1)!.push(...g.files);
    else carry.push(...g.files);
  }
  if (carry.length > 0) {
    if (kept.length === 0) return [];
    kept.at(-1)!.push(...carry);
  }
  return kept.length >= 2 ? kept : [];
}

/** A pass-baseline row of a split baseline (`baselineGroups`): its `focus`
 * is where it STARTS, never what it covers — unlike a sweep or
 * behaviour-delta row, whose focus is exactly its files. */
export function isSplitBaselineRow(p: { lens: string; focus?: readonly string[] }): boolean {
  return p.lens === "pass-baseline" && p.focus !== undefined;
}
