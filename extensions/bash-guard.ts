// bash-guard — pi extension enforcing the sessions' no-exec policy at the
// tool-call boundary. Review sessions read code; they never run it. The guard
// inspects every bash tool call and blocks any segment whose program is not on
// the read-only allowlist, plus mutating `gh` verbs (sanctioned mutations go
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

/** gh is read-only except for explicit mutating verbs and mutating api calls. */
function checkGh(args: string[]): BashCheck {
  if (args[0] === "pr" && args[1] !== undefined && ["merge", "close", "edit"].includes(args[1])) {
    return block(`exec policy: 'gh pr ${args[1]}' is a mutating command`);
  }
  if (args[0] === "api") {
    for (let i = 1; i < args.length; i++) {
      const a = args[i]!;
      if ((a === "-X" || a === "--method") && /^(POST|PUT|PATCH|DELETE)$/i.test(args[i + 1] ?? "")) {
        return block(`exec policy: 'gh api ${a} ${args[i + 1]}' mutates`);
      }
      if (/^--method=(POST|PUT|PATCH|DELETE)$/i.test(a)) return block(`exec policy: '${a}' mutates`);
      if (a === "-f" || a === "-F" || a.startsWith("--field") || a.startsWith("--raw-field")) {
        return block("exec policy: 'gh api' with field flags mutates");
      }
    }
  }
  return { allowed: true };
}

/** One segment's program + args, env prefixes and subshell parens skipped. */
function checkSegment(tokens: string[]): BashCheck {
  let i = 0;
  let afterEnv = false;
  for (; i < tokens.length; i++) {
    const raw = tokens[i]!.replace(/^['"(]+|['")]+$/g, "");
    if (raw.length === 0) continue;
    if (/^[A-Za-z_][A-Za-z0-9_]*=/.test(raw)) continue; // VAR=val prefix
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
