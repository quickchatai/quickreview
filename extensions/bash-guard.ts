// bash-guard — pi extension enforcing the sessions' no-exec policy at the
// tool-call boundary. Review sessions read code; they never run it. The guard
// inspects every bash tool call and blocks any segment whose program is not on
// the read-only allowlist, plus mutating `gh` verbs (sanctioned mutations go
// through the repo's own scripts/*.sh surface, which IS allowed for the
// specific script basenames below — approve-pr.sh and the pr-*/post-review/
// reply-thread helpers; deploy.sh and mint-token.sh stay unreachable).
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
  "dirname", "basename", "test", "true",
]);

/** Sanctioned sandbox scripts — the controlled surface for routine GitHub
 * reads and gate-mirrored posting. Deliberately NOT deploy.sh/mint-token.sh. */
const SANCTIONED_SCRIPTS = new Set([
  "approve-pr.sh",
  "pr-context.sh",
  "pr-checks.sh",
  "pr-threads.sh",
  "post-review.sh",
  "reply-thread.sh",
]);

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

/** Pure policy check over a full bash command string. Splits on shell
 * separators (;, &&, ||, |, &, newline, $(, `) and vets each segment's first
 * program token. Quote-blind splitting can only over-block, never under. */
export function checkBashCommand(cmd: string): BashCheck {
  const normalized = cmd
    .replace(/\d*>&\d*/g, " ") // 2>&1 etc. — not separators
    .replace(/\$\(/g, ";"); // command substitution starts a new segment
  for (const segment of normalized.split(/[\n;&|`]+/)) {
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
