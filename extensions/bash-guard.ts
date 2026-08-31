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
import type { Pi, ToolCallEvent } from "@earendil-works/pi-coding-agent";

/** Read-only programs a review session may run directly. */
const ALLOWED = new Set([
  "git", "rg", "grep", "cat", "ls", "find", "head", "tail", "wc", "jq", "sed",
  "awk", "sort", "uniq", "diff", "gh", "echo", "printf", "cut", "tr", "xargs",
  "dirname", "basename", "test", "true", "false", "date", "nl", "stat",
]);

/** Sanctioned sandbox scripts — the controlled surface for routine GitHub
 * reads and gate-mirrored posting. mint-token.sh is sanctioned because the
 * templates allow raw READ-ONLY `gh`, which needs `GH_TOKEN="$(…)"` (first
 * live day blocked 9 legitimate reads on it). deploy.sh stays unreachable. */
const SANCTIONED_SCRIPTS = new Set([
  "approve-pr.sh",
  "mint-token.sh",
  "pr-context.sh",
  "pr-checks.sh",
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
  "pi", "claude", "codex", "node", "npm", "npx", "pnpm", "yarn", "bun", "bunx", "deno", "tsx", "ts-node",
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
const GH_READONLY_NAMESPACES: ReadonlySet<string> = new Set(["search", "status", "version", "help"]);

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
 * `gh api .../pulls/<n>/reviews --input`" (docs/retro/sources/12-review-content.md).
 * A session can write `{"event":"APPROVE"}` with its ordinary write tool and
 * mint the token from the sanctioned `scripts/mint-token.sh`, so leaving this
 * open left the historical approval channel open while closing the documented
 * one.
 *
 * NOTE — `-i` is deliberately NOT here. In gh it is `--include` (print response
 * status line and headers), a pure READ flag; `--input` has no short form.
 * Blocking `-i` would break legitimate reads and buy nothing. Verified in
 * `gh api --help`.
 */
const GH_API_BODY_FLAGS: ReadonlySet<string> = new Set(["--input", "-f", "-F", "--field", "--raw-field"]);
const GH_API_BODY_FLAG_ATTACHED = /^(--input|--field|--raw-field)=/;

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
    if (GH_API_BODY_FLAGS.has(a) || GH_API_BODY_FLAG_ATTACHED.test(a)) body = true;
  }
  if (explicit !== null) return explicit || "GET";
  return body ? "POST" : "GET";
}

function checkGh(args: string[]): BashCheck {
  // Skip leading global flags so `gh --repo o/n pr view` is judged on `pr`.
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
  "log", "show", "diff", "diff-tree", "diff-files", "diff-index", "status",
  "blame", "annotate", "cat-file", "rev-parse", "rev-list", "ls-files",
  "ls-tree", "ls-remote", "grep", "describe", "shortlog", "merge-base",
  "name-rev", "whatchanged", "show-ref", "show-branch", "check-ignore",
  "check-attr", "count-objects", "verify-commit", "verify-tag", "version",
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
  branch: new Set(["--list", "-l", "--contains", "--merged", "--no-merged", "--show-current", "-a", "-r", "-v", "-vv", "--all", "--remotes"]),
  tag: new Set(["--list", "-l", "--contains", "--points-at", "--merged"]),
};

/**
 * Options that let git run a command of the caller's choosing. `-c` and
 * `--config-env` set config for one invocation, and git executes config-
 * supplied shell from `alias.*` (`!cmd`), `core.pager`, `credential.helper`
 * (`!cmd`), `core.sshCommand`, `diff.*.textconv` and `filter.*.clean`.
 *
 * VERIFIED on this host, not inferred:
 *   git -c "alias.probe=!<cmd>" probe        → ran <cmd>
 * (`core.pager` did not fire because a tool call's stdout is not a TTY; it
 * fires whenever one is, so it is refused all the same.)
 *
 * `--upload-pack` / `--receive-pack` / `--exec` name a program too. `-C <dir>`
 * is deliberately NOT here: it only changes directory and can neither inject
 * config nor name a command — and the alias-from-another-repo trick it used to
 * enable is dead under the verb allowlist above.
 */
const GIT_COMMAND_INJECTING_OPTS = /^(?:-c|--config-env|--upload-pack|--receive-pack|--exec)(?:=|$)/;

function checkGit(args: string[]): BashCheck {
  // Leading global options, before the verb.
  let i = 0;
  while (i < args.length && args[i]!.startsWith("-")) {
    if (GIT_COMMAND_INJECTING_OPTS.test(args[i]!)) {
      return block(
        `exec policy: 'git ${args[i]}' can hand git a command to run (alias/pager/sshCommand/textconv) — the reviewer never executes anything`,
      );
    }
    if (args[i] === "-C") i++; // a directory, not a verb — skip its value
    i++;
  }
  const verb = args[i];
  if (verb === undefined) return { allowed: true }; // bare `git` prints usage
  // …and after it, where they are equally effective.
  for (const a of args.slice(i + 1)) {
    if (GIT_COMMAND_INJECTING_OPTS.test(a)) {
      return block(`exec policy: 'git ${verb} ${a}' can hand git a command to run — the reviewer never executes anything`);
    }
  }
  const sub = GIT_READONLY_SUBVERBS[verb];
  if (sub !== undefined) {
    return args.slice(i + 1).some((a) => sub.has(a))
      ? { allowed: true }
      : block(`exec policy: 'git ${verb}' is only allowed in its read-only form (${[...sub].join(", ")})`);
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
  "GIT_PAGER", "PAGER", "GIT_EXTERNAL_DIFF", "GIT_DIFF_OPTS", "GIT_SSH",
  "GIT_SSH_COMMAND", "GIT_EDITOR", "GIT_SEQUENCE_EDITOR", "GIT_ASKPASS",
  "GIT_PROXY_COMMAND", "GIT_CONFIG", "GIT_CONFIG_GLOBAL", "GIT_CONFIG_SYSTEM",
  "GIT_CONFIG_COUNT", "GIT_ALTERNATE_OBJECT_DIRECTORIES", "GIT_TEMPLATE_DIR",
  "EDITOR", "VISUAL", "SSH_ASKPASS",
  "LD_PRELOAD", "LD_LIBRARY_PATH", "DYLD_INSERT_LIBRARIES", "BASH_ENV", "ENV",
  "PATH", "SHELL", "IFS", "PYTHONSTARTUP", "NODE_OPTIONS", "PERL5OPT",
]);
/** `GIT_CONFIG_KEY_0=alias.x GIT_CONFIG_VALUE_0=!cmd` is `-c` by another name. */
const COMMAND_INJECTING_ENV_RE = /^GIT_CONFIG_(KEY|VALUE)_\d+$/;

function envInjectionBlock(name: string): BashCheck | null {
  if (!COMMAND_INJECTING_ENV.has(name) && !COMMAND_INJECTING_ENV_RE.test(name)) return null;
  return block(
    `exec policy: '${name}=' names a program for another command to run — the reviewer never executes anything`,
  );
}

/** One segment's program + args, env prefixes and subshell parens skipped. */
function checkSegment(tokens: string[]): BashCheck {
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
    if (afterEnv && raw.startsWith("-")) continue; // env -i etc.
    if (/^\d*[<>]/.test(raw)) continue; // redirection remnant
    // Program token found.
    const args = tokens.slice(i + 1).map((t) => t.replace(/^['"]+|['"]+$/g, ""));
    return checkProgram(raw, args);
  }
  return { allowed: true }; // empty segment
}

function checkProgram(prog: string, args: string[]): BashCheck {
  // Sanctioned scripts, invoked directly.
  const direct = sanctionedScript(prog);
  if (direct.name !== undefined || /(^|\/)scripts\//.test(prog)) {
    return direct.sanctioned ? { allowed: true } : block(`exec policy: '${prog}' is not a sanctioned script`);
  }
  const base = prog.slice(prog.lastIndexOf("/") + 1);
  if (base === "cd") return { allowed: true }; // builtin, argument is a path not a program
  // Checked before the allowlist so the reason is the directive one, and
  // before `sh`/`bash`, which have their own narrower rules below.
  if (AGENT_SPAWNERS.has(base)) return block(`${AGENT_SPAWN_REASON} — '${base}' is blocked`);
  if (base === "sh") {
    // Only the `sh -n <file>` syntax check is sanctioned.
    return args[0] === "-n" ? { allowed: true } : block("exec policy: 'sh' is only allowed as 'sh -n' (syntax check)");
  }
  if (base === "bash") {
    // bash may ONLY launch a sanctioned scripts/*.sh (flags before it allowed).
    const target = args.find((a) => !a.startsWith("-"));
    if (target !== undefined) {
      const s = sanctionedScript(target);
      if (s.sanctioned) return { allowed: true };
      return block(`exec policy: 'bash ${target}' is not a sanctioned scripts/*.sh`);
    }
    return block("exec policy: 'bash' may only run sanctioned scripts/*.sh");
  }
  if (base === "gh") return checkGh(args.filter((a) => a.length > 0));
  if (base === "git") return checkGit(args.filter((a) => a.length > 0));
  if (base === "xargs") {
    // xargs runs another program — vet the target too.
    const target = args.find((a) => !a.startsWith("-") && a !== "{}");
    if (target === undefined) return { allowed: true };
    return checkProgram(target, args.slice(args.indexOf(target) + 1));
  }
  if (ALLOWED.has(base)) return { allowed: true };
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
  { re: /(^|[^A-Za-z0-9_-])ov\.conf\b/, what: "the OpenViking server config (it holds root_api_key)" },
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

/** Pure policy check over a full bash command string: split into segments
 * (quote-aware) and vet each segment's first program token. */
export function checkBashCommand(cmd: string): BashCheck {
  const normalized = cmd.replace(/\d*>&\d*/g, " "); // 2>&1 etc. — not separators
  // Checked over the WHOLE command, before the per-segment program check: the
  // programs that would read a root credential (cat, grep, jq…) are all
  // legitimately allowed, so the path is the only thing that distinguishes it.
  const secret = checkSecretPaths(normalized);
  if (!secret.allowed) return secret;
  for (const segment of splitShellSegments(normalized)) {
    const tokens = segment.trim().split(/\s+/).filter((t) => t.length > 0);
    if (tokens.length === 0) continue;
    const res = checkSegment(tokens);
    if (!res.allowed) return res;
  }
  return { allowed: true };
}

/**
 * pi activation. VERIFIED (findings §5 lines 132-141): a tool_call
 * handler can return { block: true, reason } to veto the call, and event.input
 * is mutable. // VERIFY-ON-PIN: field names `toolName` and `input`/`arguments`
 * on the event payload.
 */
export default function activate(pi: Pi): void {
  pi.on("tool_call", (event) => {
    const ev = event as ToolCallEvent;
    if (ev.toolName !== "bash") return;
    const input = (ev.input ?? ev.arguments) as { command?: unknown } | undefined;
    const cmd = input?.command;
    if (typeof cmd !== "string") return;
    const res = checkBashCommand(cmd);
    if (!res.allowed) return { block: true, reason: res.reason ?? "exec policy: command blocked" };
    return;
  });
}
