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
// per assets/findings.md §5 lines 132-141; the exact payload field
// names remain VERIFY-ON-PIN.
//
// this guard is ONE LAYER, and it is the layer that cannot be the
// layer. It vets command STRINGS; four adversarial rounds each found a way
// through, and the decisive ingredient in every one was a FILE the
// session writes, which a command guard never sees. Two things changed here as
// a result, and both are about the boundary rather than about any one attack:
//
//   · it now also vets the WRITE tools, on one question — is this path a
//     PROTECTED write target (`isProtectedWriteTarget`)? That is git's
//     configuration surface (`isGitConfigSurface`, — the repo config
//     scope, where a plain `git diff` executes a program named by
//     `<clone>/.git/config` with no suspicious token in the command at all)
//     and,, this system's OWN policy surface (`isPolicySurface`
//     — config.toml, the sanctioned scripts, the compiled guard, the seeds),
//     which seven rounds of hardening had never protected;
//   · the global/XDG/system scopes are closed OUTSIDE this file entirely, by
//     `sessionGitConfigPins` in src/sessions.ts, which pins where git looks for
//     configuration at spawn. That is not a rule this guard enforces; it is a
//     search that no longer happens. The guard's job there is only to stop a
//     caller RE-POINTING the pin (COMMAND_INJECTING_ENV), and that job stays.
import type { Pi, ToolCallEvent } from "@earendil-works/pi-coding-agent";

/**
 * Read-only programs a review session may run directly.
 *
 * **`awk` is deliberately ABSENT, and must not be re-added** (round 3).
 * It was here, gated by four regexes in `checkReaderModes`, and that gating was
 * unsound in a way no fifth regex fixes. `awk` is a programming language in
 * which `system(x)`, `x | getline`, `print | x` and `print > x` are all
 * first-class and every one takes an ARBITRARY EXPRESSION. The rules keyed on a
 * quote, `$` or `(` after the operator, so a bare identifier holding the
 * command defeated all of them. VERIFIED executing:
 *
 *     awk 'BEGIN{c="sh"; print "<cmd>" | c}'        → ran <cmd>
 *     awk 'BEGIN{f="<path>"; print "x" > f}'        → wrote <path>
 *     awk 'BEGIN{f=".git/config"; printf … >> f}'   → then a plain `git diff` ran <cmd>
 *
 * The first is the one that mattered: arbitrary execution with **no config file
 * touched**, so the round-boundary integrity check could not see it either, and
 * the outcome layer only sees reviews. Five layers, none of them covering it —
 * against a manifesto non-goal that says the reviewer never executes anything.
 * That is `T=.git/config; cat p >> $T` moved one level in, into a language
 * being parsed with regexes, and this file's own seventh review rule says stop
 * adding patterns and change the shape.
 *
 * The cost is close to zero: `awk` appears in no prompt, no agent and no
 * session-sanctioned script (the only occurrence in the tree is
 * `scripts/deploy.sh`, which sessions cannot run). A reviewer keeps `rg`,
 * `grep`, `jq`, `cut`, `sort`, `uniq`, `head`, `tail`, `wc`, `nl`, `tr` and
 * `sed -n` — and `gawk`/`mawk`/`nawk` were never here either.
 *
 * `sed` stays, on a narrower argument: its script language has exactly three
 * file/exec verbs (`w`/`r`/`e`) and they are single letters at a command
 * position, not expressions. That is parseable; awk's is not. The residual —
 * a `w` flag on a non-`/` `s` delimiter — is declared in
 * docs/exec-boundary.md and covered by the integrity check when it lands on a
 * config file.
 *
 * Exported in ORDER because the sentence every built pass reads ("Allowed
 * commands: …", `src/include.ts`) is rendered from this array: the
 * prompt kept advertising `awk` after it came off this list, and a model
 * told a tool exists and then refused reads the refusal as a malfunction. The
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
 * templates allow raw READ-ONLY `gh`, which needs `GH_TOKEN="$(…)"` (first
 * live day blocked 9 legitimate reads on it). deploy.sh stays unreachable. */
const SANCTIONED_SCRIPTS = new Set([
  "approve-pr.sh",
  "mint-token.sh",
  "pr-context.sh",
  "pr-checks.sh",
  // pr-self.sh is MANDATED by all three round templates and was absent here,
  // so every invocation form was blocked and the mandated read simply failed
  // (MC-08). Read-only by construction — GETs only, no method override, no
  // body — and its two delegates, pr-threads.sh and pr-checks.sh, are already
  // sanctioned. `tests/fences.test.ts` now derives this set from the prompts,
  // so the exec policy and the prompt contract can no longer disagree.
  "pr-self.sh",
  "pr-threads.sh",
  "post-review.sh",
  "reply-thread.sh",
]);

/** Agent-spawning programs. These already fell off ALLOWED, but the generic
 * "not an allowed read-only command" reason never told the model what to do
 * instead — and the single-shepherd invariant (S3) deserves a rule that greps.
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

function sanctionedScript(token: string): { sanctioned: boolean; name?: string } {
  const m = SCRIPT_PATH_RE.exec(token);
  if (!m) return { sanctioned: false };
  return { sanctioned: SANCTIONED_SCRIPTS.has(m[1]!), name: m[1]! };
}

/**
 * `gh` is READ-ONLY. It used to be a blocklist of three verbs —
 * `gh pr merge|close|edit` — which left `gh pr review <n> --approve` allowed:
 * a direct approval around the mutation gate, the CI gate and `dry_run`, using
 * a credential the session can mint from the sanctioned `scripts/mint-token.sh`
 * (that installation token carries `pull_requests: write`, and it is the very
 * token `scripts/approve-pr.sh` uses to POST an APPROVE review). A blocklist
 * also has to be extended every time `gh` grows a verb, and it had not been.
 *
 * So the shape is inverted: only the read verbs named here are allowed, plus
 * `gh api` without a mutating method or field flag. Every posting mutation goes
 * through the sanctioned scripts, which mirror the gate's guards.
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
 * empirically against a loopback server (follow-up):
 *
 *     gh api <path> --input f        → POST      gh api <path>                → GET
 *     gh api <path> --input=f        → POST      gh api <path> --method GET … → GET
 *
 * `--input` is the one that mattered and the one a flag blocklist missed: it is
 * the recipe the PREDECESSOR system actually used to post every one of its
 * reviews — "a JSON file written with `Write` then `POST`ed via
 * `gh api .../pulls/<n>/reviews --input`" (the retro corpus, sources/12-review-content.md — in the state home).
 * A session can write `{"event":"APPROVE"}` with its ordinary write tool and
 * mint the token from the sanctioned `scripts/mint-token.sh`, so leaving this
 * open left the historical approval channel open while closing the documented
 * one.
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
 * The set above is complete by flag NAME and was still bypassed, because a
 * name is not a form: `-fevent=APPROVE` attaches the value, and `-if` clusters
 * the boolean `-i` in front of `-f`. Both send POST, verified on gh 2.93.0:
 *
 *     gh api <path> -fevent=APPROVE   → POST
 *     gh api <path> -Fevent=APPROVE   → POST
 *     gh api <path> -if event=APPROVE → POST
 *     gh api <path> -i                → GET
 *
 * That is the SAME failure mode as `--input` itself — an unenumerated form
 * rather than an unenumerated name — so the answer is a shape, not three more
 * literals. Any single-dash cluster containing `f` or `F` carries a body;
 * `-i` alone contains neither, so `--include` keeps working. `-X`/`-XPOST`
 * contain neither either, and are handled by the explicit-method branch.
 */
const GH_API_SHORT_BODY_CLUSTER = /^-[A-Za-z]*[fF]/;

/**
 * What method will this `gh api` invocation actually send?
 *
 * The old check asked "does any flag look mutating?", which is a blocklist and
 * missed `--input`. This asks the question that decides the outcome: an
 * explicit `-X`/`--method` wins, otherwise a body flag promotes GET to POST,
 * otherwise it is gh's default GET. Only GET is allowed.
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
  // rather than `pr` — the comment here used to claim the opposite, which is
  // a false claim about behaviour in a security-relevant file.
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
 * `git` is READ-ONLY too, and — like `gh` — by ALLOWLIST.
 *
 * It first sat unconditionally on ALLOWED, three lines from `gh`'s filter, so
 * `git push` (a GitHub write around the one gate) and the discard family
 * (`reset --hard`, `checkout --`, `clean -fdx`, `stash`) were all permitted.
 * The first fix used a blocklist of write verbs, on the reasoning that reading
 * is what a session does all day with git and a missed read verb would wedge a
 * live review. That reasoning was wrong, and adversarial review proved it in
 * three ways:
 *
 *   1. The blocklist was not closed. `send-pack` — the documented plumbing for
 *      `push`, the very mutation blocked three lines above — was absent, as
 *      were `bundle`, `archive`, `svn`, `p4`, `daemon`, `fast-export`,
 *      `symbolic-ref`, `reflog`, `difftool`, `update-server-info`, and
 *      `branch -D` / `tag -d`.
 *   2. A blocklist keys on the verb, and `-c alias.x='!<shell>' x` supplies a
 *      NEW verb in one token. VERIFIED executing on this host.
 *   3. `git -C /some/repo <alias>` runs an alias out of that repo's own
 *      config. Under an allowlist the alias name is simply not a sanctioned
 *      read verb, so the whole class dies without enumerating it.
 *
 * A blocked read verb is a loud, recoverable refusal naming what to do; an
 * unblocked write verb is an ungated mutation. The failure modes are not
 * symmetric, which is what the first shape got wrong.
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
 * The family has THREE members, not two, and the shape only became clear after
 * the third was found. What they have in common is not "sets config" — it is
 * **anything that changes WHICH CONFIG GIT READS, or names a program
 * directly.**
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
 * Category 3 is the worst of them and took two rounds to see whole. The
 * minimum viable evil "repo" is ONE PLAIN-TEXT FILE: `--no-index` means git
 * never validates the directory as a repository, so there is no `objects/`,
 * no `refs/`, no `git init` and no exec bit — a session writes the config
 * with its ordinary write tool. `--ext-diff` is NOT required, because
 * `git diff` honours `diff.external` by default.
 *
 * The lesson of the miss is worth keeping: the explicit pointers
 * (`GIT_CONFIG_GLOBAL`, `GIT_CONFIG_SYSTEM`) were blocked while the implicit
 * SEARCH PATH they fall back to — `HOME`, `XDG_CONFIG_HOME` — was open. The
 * category is any control over WHICH CONFIG GIT READS, not the subset of it
 * that names a config file outright.
 *
 * `-C <dir>` is deliberately NOT here, and the reason is narrower than it once
 * claimed. `-C` DOES reach config: it chdirs, git then DISCOVERS the
 * repository there and reads its config, arriving at the same `diff.external`.
 * (An earlier note here asserted it "can neither relocate config nor name a
 * command" — that was false, and produced by testing against a stub `.git`
 * rather than a real repository.) It stays allowed because discovery requires
 * a VALID repository whose config the session controls, and `git init` and
 * `git clone` are both off the verb allowlist above — so the session cannot
 * create one. That is a real bound, but it is a different bound, and this file
 * has already paid once for a docstring asserting a closedness it did not
 * have.
 */
const GIT_COMMAND_INJECTING_OPTS =
  /^(?:-c|--config-env|--upload-pack|--receive-pack|--exec|--exec-path|--git-dir|--work-tree)(?:=|$)/;

/**
 * The same set MINUS bare `-c`, for the position after the verb.
 *
 * `git show -c` / `git log -c` / `git diff-tree -c` is git's COMBINED
 * MERGE DIFF option, not config injection — and it is exactly the tool the
 * ratified recheck decision needs: a hand-resolved conflict must be audited
 * against BOTH merge parents. Blocking it was a real functional regression in
 * a capability the system depends on. Git's top-level `-c` must precede the
 * subcommand anyway, so the before-verb check above loses nothing.
 */
const GIT_COMMAND_INJECTING_OPTS_AFTER_VERB =
  /^(?:--config-env|--upload-pack|--receive-pack|--exec|--exec-path|--git-dir|--work-tree)(?:=|$)/;

function checkGit(args: string[]): BashCheck {
  // Leading global options, before the verb.
  let i = 0;
  while (i < args.length && args[i]!.startsWith("-")) {
    if (GIT_COMMAND_INJECTING_OPTS.test(args[i]!)) {
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
    if (GIT_COMMAND_INJECTING_OPTS_AFTER_VERB.test(a)) {
      return block(
        `exec policy: 'git ${verb} ${a}' can hand git a command to run — the reviewer never executes anything`,
      );
    }
  }
  const sub = GIT_READONLY_SUBVERBS[verb];
  if (sub !== undefined) {
    // POSITIONAL, not `some()` over every argument (F8). A scan of all args
    // would accept the read-only marker wherever it appeared — including as
    // the VALUE of a write form, e.g. `git branch -m list`. Proven inert
    // today, but only by accident of which spellings collide; the first token
    // after the verb is the one that decides what the command does.
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
 * run — the env twin of `git -c` (follow-up). `VAR=val` prefixes are
 * skipped by the splitter below, so without this a read verb carries the
 * payload instead of the verb doing it.
 *
 * VERIFIED on this host, not inferred:
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
  // `$XDG_CONFIG_HOME/git/config`. Blocking the explicit door and leaving the
  // implicit one open beside it is exactly the shape of the miss. Same
  // primitive and the same cost as the repo-scope form: one plain-text file
  // written with the ordinary write tool, plus one ALLOWED command.
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
 * same primitive as `HOME=` above, aimed at us instead of at git (MC-05,
 * fenced by `tests/fences.test.ts` and `tests/bash-guard.test.ts`).
 *
 * The posting scripts are sanctioned, and every guard knob they consult is
 * read out of `$QCR_CONFIG`:
 *
 *     QCR_CONFIG=/tmp/mine.toml bash scripts/approve-pr.sh 5 body.md
 *
 * passed the exec policy, because `VAR=val` prefixes are skipped by the
 * splitter and only the git family was named. `guard_enabled` treats a knob as
 * ON unless the value is literally `false`, so one hand-written TOML file —
 * created with the ordinary write tool, which reviewer sessions have — turns
 * guards 2 through 5 off on a REAL approval. The same file carries `dry_run`,
 * so it also flips a dry-run install into posting for real: hard rule 1, by an
 * env prefix.
 *
 * `QCR_STATE_DB` relocates the database the guards query for the head mark and
 * the approval-withheld state; `QCR_DRYRUN_DIR` relocates where a suppressed
 * intent is recorded, which is the only evidence a dry-run run leaves.
 *
 * SCOPE: this closes the ENV-PREFIX spelling of MC-05. The two further routes
 * the review found — `bash -c '<sanctioned script> ; <anything>'` past
 * the segment policy, and overwriting the config / `guards.sh` / the posting
 * scripts / the compiled guard outright — are closed: the `bash -c`
 * payload is re-parsed as its own command (`bashCPayload`, from
 * `checkSegment`), and every policy-carrying file is unwritable at BOTH the
 * write-tool and the shell-redirection boundary (`isPolicySurface`).
 *
 * `QCR_POSTING_RECEIPT_DIR` is HERE as, moved out of the
 * "arguments" list below after the review flagged it as "closer to a
 * relocator than to an argument". The ruling: it names a DIRECTORY, exactly
 * like `QCR_DRYRUN_DIR` and `QCR_STATE_DB` beside it, not a per-call value like
 * `QCR_EXPECTED_HEAD`; the daemon never sets it (it relies on the scripts'
 * default `$ROOT/state/posting-receipts`, and `verdicts.ts` reads that same
 * default), so blocking it breaks no dispatch path; and a session has no
 * business moving where the posting RECEIPT — the record that settles a round —
 * is written. It is a relocator, and it is refused.
 *
 * `QCR_INSTALL` is HERE as: the install locator (src/install.ts,
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
  "QCR_INSTALL",
  "QCR_STATE_DB",
  "QCR_DRYRUN_DIR",
  "QCR_POSTING_RECEIPT_DIR",
]);

function envInjectionBlock(name: string): BashCheck | null {
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
function checkSegment(segment: string, tokens: string[], depth: number): BashCheck {
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
      // a second command line inside this one. `env -S 'bash -c "git push"'`
      // walked through the prior form of this guard (VERIFIED running).
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
      // judged from the RAW segment, never from these tokens (door 4).
      const lifted = bashCPayload(segment);
      if (lifted.kind === "payload") {
        if (depth >= MAX_NESTED_COMMAND_DEPTH)
          return block("exec policy: 'bash -c' nested too deep to analyse — refused");
        return checkBashCommand(lifted.payload, depth + 1);
      }
      if (lifted.kind === "unliftable") return block(lifted.reason);
    }
    return checkProgram(raw, args, rawArgs, depth);
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
function shellWords(s: string): ShellWords {
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
): BashCheck {
  // Sanctioned scripts, invoked directly.
  const direct = sanctionedScript(prog);
  if (direct.name !== undefined || /(^|\/)scripts\//.test(prog)) {
    return direct.sanctioned
      ? { allowed: true }
      : block(`exec policy: '${prog}' is not a sanctioned script`);
  }
  const base = prog.slice(prog.lastIndexOf("/") + 1);
  if (base === "cd") return { allowed: true }; // builtin, argument is a path not a program
  // Checked before the allowlist so the reason is the directive one, and
  // before `sh`/`bash`, which have their own narrower rules below.
  if (AGENT_SPAWNERS.has(base)) return block(`${AGENT_SPAWN_REASON} — '${base}' is blocked`);
  if (base === "sh") {
    // Only the `sh -n <file>` syntax check is sanctioned.
    return args[0] === "-n"
      ? { allowed: true }
      : block("exec policy: 'sh' is only allowed as 'sh -n' (syntax check)");
  }
  if (base === "bash") {
    // A `bash -c` with a readable payload never reaches here: `checkSegment`
    // lifts it from the raw segment and re-parses it (door 4). What
    // does reach here is `bash -c` through `xargs`, or a -c form
    // `bashCPayload` did not recognise — and a command string nobody vetted
    // must not run, so any -c BEFORE the script is refused. Otherwise bash may
    // ONLY launch a sanctioned scripts/*.sh (flags before it allowed; anything
    // after the script is the script's own argument).
    for (const a of args) {
      if (!a.startsWith("-")) {
        return sanctionedScript(a).sanctioned
          ? { allowed: true }
          : block(`exec policy: 'bash ${a}' is not a sanctioned scripts/*.sh`);
      }
      if (/^-[A-Za-z]*c/.test(a)) {
        return block(
          "exec policy: this 'bash -c' carries a command string the guard cannot read (through xargs, or a form it does not lift) — refused",
        );
      }
    }
    return block("exec policy: 'bash' may only run sanctioned scripts/*.sh");
  }
  if (base === "gh") return checkGh(args.filter((a) => a.length > 0));
  if (base === "git") return checkGit(args.filter((a) => a.length > 0));
  if (base === "xargs") {
    // xargs runs another program — vet the target too.
    const target = args.find((a) => !a.startsWith("-") && a !== "{}");
    if (target === undefined) return { allowed: true };
    const from = args.indexOf(target) + 1;
    return checkProgram(target, args.slice(from), rawArgs?.slice(from), depth);
  }
  if (ALLOWED.has(base)) {
    // Allowlisted for READING is not allowlisted outright: sed/sort/find each
    // carry a write or exec mode (round 2, all VERIFIED).
    return checkReaderModes(base, args, rawArgs);
  }
  // ALLOWLIST MEMBERSHIP is what decides — this table only makes the refusal
  // name a replacement. Deliberately AFTER the check above, not before it: the
  // first cut had it first, which meant `awk`'s removal from ALLOWED was
  // unobservable (putting awk back left the suite green, because this branch
  // blocked it anyway). A defence whose removal changes nothing is not a
  // defence, and that inversion is the exact fault this ticket keeps finding.
  const interpreter = INTERPRETER_REASONS[base];
  if (interpreter !== undefined) return block(interpreter);
  return block(`exec policy: '${base}' is not an allowed read-only command`);
}

/** Quote/substitution-aware segment splitter. The first live day proved
 * quote-blind splitting unusable: `rg 'a|b'` shredded on the quoted pipe and
 * pattern fragments were vetted as programs. Rules:
 *  - single quotes: everything inside is literal;
 *  - double quotes: separators are literal, but `$(` and backticks still
 *    execute, so they still split (quote state restored at the matching `)`);
 *  - backslash escapes the next char (outside single quotes);
 *  - unquoted `; & | && || newline ( )` split; `$(`/`)` track nesting so the
 *    command FOLLOWING a substitution lands in its own segment and is vetted
 *    (the old segment-merge was a bypass: `A="$(cat x)" python3 e.py`). */
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

/** The root-credential check, exported so the reason is testable on its own. */
export function checkSecretPaths(cmd: string): BashCheck {
  for (const { re, what } of ROOT_CREDENTIAL_PATTERNS) {
    if (re.test(cmd)) {
      return block(
        `exec policy: reading ${what} is never sanctioned — review sessions authenticate as the reviewer USER and nothing else`,
      );
    }
  }
  return { allowed: true };
}

/**
 * Git's configuration and hook surface — the files that turn an ORDINARY git
 * command into arbitrary shell execution.
 *
 * This is the half of the exec boundary a command-string guard cannot reach.
 * Every bypass across's four rounds needed a suspicious token in the
 * command, but the decisive ingredient in each was A FILE THE SESSION WRITES —
 * and the guard never sees a write. Push it one step and the command becomes
 * innocent. VERIFIED executing on this host, with the config-scope pin
 * already in force:
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
 * REACH, stated plainly, because two docstrings in this file have already
 * asserted a closedness they did not have. This binds the `write`/`edit` TOOL
 * path and shell REDIRECTION targets. It does NOT bind a write smuggled inside
 * a quoted program body (`awk 'BEGIN{print > "..."}'`) or through a sanctioned
 * script. Those remain the bash program allowlist's job, and the allowlist is
 * what keeps the set of programs that can write a file at all small.
 */
const GIT_CONFIG_SURFACE_RE = [
  /(^|\/)\.git(\/|$)/, // inside a .git dir (or the file/symlink itself)
  /(^|\/)\.gitconfig$/,
  /(^|\/)git\/config$/,
  /(^|\/)\.gitattributes$/,
];

/**
 * Is this path part of git's config/hook surface? Exported so both boundaries
 * — the bash redirection scan below and the write/edit tool veto in `activate`
 * — ask ONE question, and a future third caller cannot ask a narrower one.
 */
export function isGitConfigSurface(path: string): boolean {
  // Trailing shell noise a redirection token can carry; quotes are stripped by
  // the caller, and a bare `~` expansion never changes which rule matches.
  const p = path.replace(/^['"]+|['"]+$/g, "").replace(/\/+$/, "");
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
 *     pi 0.87.1 — VERIFY-ON-PIN: the candidate list is pi's), and every session
 *     and pass runs in the sandbox root. One write plants instructions in every
 *     later session until the next deploy — the overseer's included.
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
export const POLICY_SURFACE_DIRS = [
  "scripts",
  "dist",
  "extensions",
  "prompts",
  "agents",
  "seeds",
] as const;

const escapeRe = (s: string): string => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
const POLICY_SURFACE_RE = [
  new RegExp(`(^|/)(?:${POLICY_SURFACE_FILES.map(escapeRe).join("|")})$`),
  new RegExp(`(^|/)(?:${POLICY_SURFACE_DIRS.map(escapeRe).join("|")})/.+`),
];

/** Is this path part of this system's own policy surface? Exported so both
 * boundaries ask ONE question — see `POLICY_SURFACE_RE`. */
export function isPolicySurface(path: string): boolean {
  const p = path.replace(/^['"]+|['"]+$/g, "").replace(/\/+$/, "");
  if (p.length === 0) return false;
  return POLICY_SURFACE_RE.some((re) => re.test(p));
}

/** The full set a session may not write, from ONE definition: git's own config
 * and hook surface and this system's policy surface. Both
 * the write/edit tool veto (`checkWritePath`) and the shell-redirection / sed
 * scan (`checkProtectedWrites`) refuse exactly this, so they cannot drift. */
export function isProtectedWriteTarget(path: string): boolean {
  return isGitConfigSurface(path) || isPolicySurface(path);
}

/** Veto reason for a policy-surface write target. */
function policySurfaceWriteBlock(path: string): BashCheck {
  return block(
    `exec policy: '${path}' is part of this system's own policy surface (config.toml, scripts/, dist/, extensions/, prompts/agents/seeds) — writing it reconfigures the posting guards, the mutation gate or the compiled boundary itself. The reviewer reads code; it never edits its own controls.`,
  );
}

/** Whichever refusal fits the target — git's config surface keeps its own,
 * more specific message. */
function protectedWriteBlock(path: string): BashCheck {
  return isGitConfigSurface(path) ? gitConfigWriteBlock(path) : policySurfaceWriteBlock(path);
}

function gitConfigWriteBlock(path: string): BashCheck {
  return block(
    `exec policy: '${path}' is part of git's configuration surface — writing it makes an ORDINARY git command (a plain 'git diff') execute a program of the writer's choosing. The reviewer reads code; it never configures git.`,
  );
}

/** Operator token shapes AFTER `normalizeRedirections`: `>`/`>>`, optionally
 * fd-prefixed, bare or with the target attached. */
const REDIRECT_OP_RE = /^\d*>>?$/;
const REDIRECT_OP_ATTACHED_RE = /^\d*>>?(.+)$/;

/** A shell word with its quoting removed. bash opens `con"fig".toml`,
 * `config\.toml` and `config.toml` as the SAME file, so a write target is
 * judged by the name bash would open, not by its spelling — the first two
 * walked past the git-config veto too (VERIFIED writing). */
function dequote(word: string): string {
  return word.replace(/["'\\]/g, "");
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
 * All five VERIFIED writing the target on this host. The prior scan knew `>`
 * and `>>` only, so each was a bypass of the git-config veto as well
 * (found while closing the policy surface).
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
 * git's config/hook surface OR this system's own policy surface
 *: config.toml, scripts/, dist/, extensions/, prompts/agents/seeds.
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
    // second `>` as the target (a real bug this ordering fixes, caught by the
    // `printf … >> .git/config` case and not by `> .git/config`).
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
  return { allowed: true };
}

/** Pure policy check over a full bash command string: split into segments
 * (quote-aware) and vet each segment's first program token. */
export function checkBashCommand(cmd: string, depth = 0): BashCheck {
  const normalized = normalizeRedirections(cmd);
  // Checked over the WHOLE command, before the per-segment program check: the
  // programs that would read a root credential (cat, grep, jq…) are all
  // legitimately allowed, so the path is the only thing that distinguishes it.
  const secret = checkSecretPaths(normalized);
  if (!secret.allowed) return secret;
  // Same shape, same reason: a PROTECTED write surface — git's config surface
  // and this system's own policy surface. A redirection
  // target is not a program token, so the per-segment walk below never sees it.
  const protectedWrite = checkProtectedWrites(normalized);
  if (!protectedWrite.allowed) return protectedWrite;
  for (const segment of splitShellSegments(normalized)) {
    const tokens = segment
      .trim()
      .split(/\s+/)
      .filter((t) => t.length > 0);
    if (tokens.length === 0) continue;
    const res = checkSegment(segment, tokens, depth);
    if (!res.allowed) return res;
  }
  return { allowed: true };
}

/**
 * The read-only programs that are not read-only (round 2).
 *
 * `sed`, `sort` and `find` are on ALLOWED (`awk` was too, until round
 * 3 took it off — see the note at the end of this table) because a reviewer
 * greps and slices text all day. Each also has a mode that WRITES A FILE or
 * RUNS A COMMAND, and a review session needs none of them. Until this existed,
 * all of these were permitted and all are VERIFIED on this host:
 *
 *   sed -n 'w .git/config' payload            → wrote it; plain `git diff` then ran <cmd>
 *   sort -o .git/config payload               → same
 *   find . -maxdepth 0 -fprintf .git/config … → same
 *   awk 'BEGIN{print x >>".git/config"}'      → same
 *   awk 'BEGIN{system("<cmd>")}'              → ran <cmd> DIRECTLY, no config involved
 *   awk 'BEGIN{"<cmd>" | getline}'            → ran <cmd> directly
 *   find . -maxdepth 0 -exec <cmd> \;         → ran <cmd> directly
 *
 * The last three are worth separating out: they are not git-config bypasses at
 * all. They are arbitrary execution straight through the program allowlist,
 * which makes the no-exec policy's central claim false on its own terms. The
 * exec-mode half of this rule is therefore not a hardening of's write
 * story; it closes a hole that was always there.
 *
 * This is the NARROW form of "reduce what the boundary must permit" — gating
 * four programs' write/exec modes, not redesigning how sessions get context.
 * A blocked mode is a loud refusal on something a reviewer never legitimately
 * does; the failure modes are not symmetric.
 *
 * What it is NOT: the defence against the write class. A command-string rule
 * cannot see `T=.git/config; cat p >> $T`, and adding spellings here would be
 * the same mistake made four times. The class is closed by the
 * round-boundary config-integrity check (`src/execboundary.ts`), which needs no
 * enumeration at all. This narrows the surface; that catches what gets through.
 */
interface ReaderModeRule {
  /** Flags that write or execute, matched whole or as `--flag=value`. */
  flags?: RegExp;
  /** Patterns in a program body that write or execute. */
  body?: Array<{ re: RegExp; what: string }>;
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
  // spills to temp files (NOT reproduced here — sort did not spill on a small
  // input — so it is refused on documented behaviour, not on a probe; said
  // plainly so nobody later cites this line as evidence it was demonstrated).
  // `o` is unambiguous in sort's short-option set, so a cluster carrying it is
  // an output redirect.
  sort: {
    flags: /^(?:--(?:output|compress-program)(?:=|$)|-(?!-)[a-zA-Z]*o)/,
    what: "writes a file or names a program to run",
  },
  // -i rewrites in place, -f/--file is a script we cannot inspect, and the
  // script's own w/W (write), r/R (read a file into the stream) and e (execute)
  // commands are file/exec verbs at a COMMAND position. `i` and `f` are
  // unambiguous in sed's short-option set (n e f i r E s u z), so a cluster
  // carrying either is one of those modes — `sed -ni 'w f'` included.
  sed: {
    flags: /^(?:--(?:in-place|file)(?:[=.]|$)|-(?!-)[a-zA-Z]*[if])/,
    body: [
      {
        re: /(?:^|[;{}\n])[ \t]*(?:\/(?:\\.|[^/\\])*\/|[0-9]+|\$|,)*[ \t]*[wWrRe](?:[ \t]|$)/,
        what: "a w/r/e command",
      },
      { re: /\/[gpiImMnN0-9]*[we](?:[ \t]|$)/, what: "a w/e flag on s///" },
    ],
    what: "writes a file or runs a command",
  },
  // NOTE — there is no `awk` entry any more, and adding one back would be a
  // mistake. Four rules lived here and all four were defeated by a bare
  // identifier (`print "cmd" | c`), because awk's exec and write forms take
  // arbitrary EXPRESSIONS. awk is off ALLOWED instead; see the comment there.
};

/**
 * Does this invocation of an allowlisted reader use one of its write/exec
 * modes? Exported so the reason is testable on its own.
 */
export function checkReaderModes(
  prog: string,
  args: readonly string[],
  rawArgs?: readonly string[],
): BashCheck {
  const rule = READER_MODE_RULES[prog];
  if (rule === undefined) return { allowed: true };
  for (const raw of args) {
    const a = raw.replace(/^['"]+|['"]+$/g, "");
    if (a.length > 0 && a.startsWith("-") && rule.flags?.test(a)) {
      return block(
        `exec policy: '${prog} ${a}' ${rule.what} — the reviewer reads code and never writes or runs anything. Use the read-only form.`,
      );
    }
  }
  // The body rules run over the args JOINED **with their quotes intact**, and
  // over each argument on its own. Two separate mistakes made that necessary:
  //   · the splitter tokenises on whitespace, so a quoted program is already
  //     shredded here — `awk 'BEGIN { print x > "f" }'` arrives as five tokens
  //     and no per-token rule can see `print … >` as one thing (the reviewer's
  //     probe recorded exactly this: the no-space form passed while the spaced
  //     form blocked *by accident* on the redirection scan);
  //   · `checkProgram` strips a leading/trailing quote from every token, which
  //     turns `BEGIN{"id" | getline}` into `BEGIN{"id | getline}` and destroys
  //     the very quoting the rules key on. Hence `rawArgs`.
  //
  // The third form is a script GLUED TO ITS FLAG. `sed -e 'w f'` is caught
  // because `w` arrives as its own token, but `sed --expression='w f'` and
  // `sed -e'w f'` do not — the flag and the script share a token, so neither
  // the joined string (where `w` follows a quote, not a command position) nor
  // the per-arg pass sees a script. Stripping the flag prefix yields the same
  // script text either spelling produced.
  const unglued = args
    .map((a) => /^(?:--expression=|-e)(.+)$/.exec(a)?.[1])
    .filter((s): s is string => s !== undefined)
    .map((s) => s.replace(/^['"]+|['"]+$/g, ""));
  const candidates = [(rawArgs ?? args).join(" "), ...args, ...unglued];
  for (const { re, what } of rule.body ?? []) {
    if (candidates.some((c) => re.test(c))) {
      return block(
        `exec policy: this '${prog}' program contains ${what}, which ${rule.what} — the reviewer reads code and never writes or runs anything.`,
      );
    }
  }
  return { allowed: true };
}

/**
 * The write/edit tools' policy check. The write half of the
 * two boundaries `isProtectedWriteTarget` binds — the other is the shell
 * redirection / `sed -i` scan in `checkProtectedWrites`, and both read the same
 * predicate so a session cannot write through one what it is refused through the
 * other. Refuses git's config/hook surface and this system's own policy surface
 * (config.toml, scripts/, dist/, extensions/, prompts/agents/seeds); everything
 * else a session writes — the verdict file, the ledger, /tmp bodies — is
 * allowed. This is not a write allowlist.
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

/**
 * pi activation. VERIFIED (findings §5 lines 132-141): a tool_call
 * handler can return { block: true, reason } to veto the call, and event.input
 * is mutable. // VERIFY-ON-PIN: field names `toolName` and `input`/`arguments`
 * on the event payload, and (following extensions/companion-guard.ts, which
 * already vetoes writes this way) `path`/`file_path` on a write tool's input.
 */
export default function activate(pi: Pi): void {
  pi.on("tool_call", (event) => {
    const ev = event as ToolCallEvent;
    const input = (ev.input ?? ev.arguments) as
      { command?: unknown; path?: unknown; file_path?: unknown; filePath?: unknown } | undefined;

    if (ev.toolName === "bash") {
      const cmd = input?.command;
      if (typeof cmd !== "string") return;
      const res = checkBashCommand(cmd);
      if (!res.allowed)
        return { block: true, reason: res.reason ?? "exec policy: command blocked" };
      return;
    }

    if (typeof ev.toolName === "string" && WRITE_TOOLS.has(ev.toolName)) {
      const target = input?.path ?? input?.file_path ?? input?.filePath;
      if (typeof target !== "string") return;
      const res = checkWritePath(target);
      if (!res.allowed) return { block: true, reason: res.reason ?? "exec policy: write blocked" };
    }
    return;
  });
}
