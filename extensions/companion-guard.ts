// companion-guard — the companion's bright lines, made structural (2026-08-25).
//
// The companion's boundary (CLAUDE.md rule 8) is mostly structural already: no
// GitHub credential, no VM credential, no gh binary in the image. But three
// bright lines were held by PROMPT alone, and this extension turns them into
// tool_call vetoes the model cannot talk itself past:
//
//   1. Rule 6 — the frozen seeds. The companion edits the real checkout on
//      master, live (rule 11), and prompts/ + agents/ seeded content is
//      canonical. The frozen set IS the seed manifest
//      (tests/fixtures/seed-manifest.json): the files we own (round-*.md, the
//      post-seed lenses, companion prompts) are deliberately NOT in it, and
//      tests/seed-integrity.test.ts guards that — so "in the manifest" is
//      exactly "frozen". The two registry fixtures are frozen too: the
//      manifest itself, and ratified-divergence.json, whose two sanctioned
//      writers (a human; the TUI rubric-accept path) do not include us.
//   2. Rule 8 — never GitHub, never deploy.sh: `git push`, `gh`,
//      `scripts/deploy.sh` are refused by name, not just by missing
//      credentials.
//   3. Rule 11 — the shared checkout is other actors' desk too: `git stash`,
//      `git reset --hard`, `git checkout --`/`git checkout .`, `git restore`
//      (worktree-discarding form) and `git clean` destroy uncommitted work
//      that is not recoverable from the reflog. The companion commits; it
//      never discards.
//
// A block is a REFUSAL WITH A REASON the model sees — it can relay the reason
// to the owner and argue for the change instead of making it. This is
// belt-and-braces, not a sandbox: bash can in principle write a frozen file
// (sed, tee), and we do not try to parse arbitrary shell for that. The bright
// lines above are the ones worth a hard veto.
//
// Loaded per spawn from piArgv (src/tui/companion.ts), companion only — the VM
// sessions have their own gate + guards.sh mirror, and pi-subagents children
// run --no-extensions so leaves never pay for this hook.
import { readFileSync } from "node:fs";
import { isAbsolute, relative, resolve } from "node:path";
import type { Pi, ToolCallEvent } from "@earendil-works/pi-coding-agent";

export interface BashRule {
  pattern: RegExp;
  reason: string;
}

/** Bash bright lines. Patterns are deliberately TIGHT: a false veto on a
 * legitimate command teaches the operator to want the guard gone (the same
 * lesson as the entrypoint's /proc/mounts note). `git checkout -b`, plain
 * branch switches, `git restore --staged` and `git stash list/show` stay
 * allowed on purpose. */
export const BASH_RULES: BashRule[] = [
  {
    pattern: /\bgit\s+push\b/,
    reason: "rule 8: the companion never mutates GitHub — no push, ever. Commit locally with the [companion] prefix and leave landing to the humans/daemon.",
  },
  {
    pattern: /(^|[\s/;&|])gh\s+/,
    reason: "rule 8: the companion never talks to GitHub — gh is not installed here, and this guard keeps it a boundary rather than an accident of the image.",
  },
  {
    pattern: /(^|[\s/;&|])deploy\.sh\b/,
    reason: "rule 8: the companion never runs scripts/deploy.sh. Deploys are the owner's, via the deploying skill.",
  },
  {
    pattern: /\bgit\s+stash\b(?!\s+(list|show)\b)/,
    reason: "rule 11: never stash in the shared checkout — uncommitted work here may be another actor's (or your own in-flight edit the owner is watching). Commit instead.",
  },
  {
    pattern: /\bgit\s+reset\s+(-\S+\s+)*--hard\b/,
    reason: "rule 11: git reset --hard destroys uncommitted work in the shared checkout, and it is not recoverable from the reflog.",
  },
  {
    pattern: /\bgit\s+checkout\s+(-\S+\s+)*(--(\s|$)|\.(\s|$))/,
    reason: "rule 11: git checkout -- <path> / git checkout . discards uncommitted changes. Branch switches and -b are fine; discarding is not.",
  },
  {
    pattern: /\bgit\s+restore\b(?!.*--staged)/,
    reason: "rule 11: git restore (worktree form) discards uncommitted changes. --staged alone is allowed — it touches the index, not the files.",
  },
  {
    pattern: /\bgit\s+clean\b/,
    reason: "rule 11: git clean deletes untracked files in the shared checkout — someone else's scratch work included.",
  },
];

/** First matching bash rule's reason, or undefined when the command is fine. */
export function bashBlockReason(command: string, rules: BashRule[] = BASH_RULES): string | undefined {
  for (const rule of rules) if (rule.pattern.test(command)) return rule.reason;
  return undefined;
}

/** The registry fixtures are frozen alongside what they pin. */
export const REGISTRY_FIXTURES = [
  "tests/fixtures/seed-manifest.json",
  "tests/fixtures/ratified-divergence.json",
] as const;

/** Repo-relative frozen paths: every file in the seed manifest, plus the two
 * registry fixtures. Read lazily and cached — the set changes only on a
 * ratified reseed, which also restarts everything. A missing/unreadable
 * manifest yields ONLY the fixtures (degraded, logged by the caller): the
 * guard must never make pi unable to start over a manifest problem. */
export function frozenPaths(root: string): Set<string> {
  const frozen = new Set<string>(REGISTRY_FIXTURES);
  try {
    const manifest = JSON.parse(readFileSync(resolve(root, "tests/fixtures/seed-manifest.json"), "utf8")) as {
      files?: Record<string, string>;
    };
    for (const rel of Object.keys(manifest.files ?? {})) frozen.add(rel);
  } catch {
    // degraded — caller logs it once
  }
  return frozen;
}

/** Veto reason for a write/edit target, or undefined when allowed. `path` is
 * whatever the tool got — absolute or cwd-relative. */
export function writeBlockReason(path: string, root: string, frozen: Set<string>): string | undefined {
  const abs = isAbsolute(path) ? path : resolve(root, path);
  const rel = relative(root, abs);
  if (rel.startsWith("..")) return undefined; // outside the repo — mounts enforce their own modes
  if (!frozen.has(rel)) return undefined;
  if ((REGISTRY_FIXTURES as readonly string[]).includes(rel)) {
    return `rule 6: ${rel} is a registry fixture with exactly two sanctioned writers (a human recording a ratified reseed; the TUI rubric-accept path) — the companion is neither. Argue for the change; never make it.`;
  }
  return `rule 6: ${rel} is a frozen seed (byte-identical to the assets, pinned by the seed manifest). Pass behaviour changes go through PASS_ADDENDA in src/include.ts; a reseed is the owner's to ratify.`;
}

/** Same hookup shape as extensions/bash-guard.ts: `pi.on("tool_call", …)`
 * returning { block, reason } is VERIFIED (§5 lines 132-141); the
 * payload field names (`toolName`, `input`/`arguments`, write/edit's `path`)
 * stay VERIFY-ON-PIN, probed defensively. */
export default function activate(pi: Pi): void {
  const root = process.env.QCR_ROOT ?? process.cwd();
  let frozen: Set<string> | undefined;
  let warnedDegraded = false;

  pi.on("tool_call", (event) => {
    const ev = event as ToolCallEvent;
    const input = (ev.input ?? ev.arguments) as { command?: unknown; path?: unknown; file_path?: unknown } | undefined;

    if (ev.toolName === "bash") {
      const cmd = input?.command;
      if (typeof cmd !== "string") return;
      const reason = bashBlockReason(cmd);
      if (reason) return { block: true, reason: `companion-guard: ${reason}` };
      return;
    }

    if (ev.toolName !== "write" && ev.toolName !== "edit") return;
    if (frozen === undefined) {
      frozen = frozenPaths(root);
      if (frozen.size === REGISTRY_FIXTURES.length && !warnedDegraded) {
        warnedDegraded = true;
        // Loud, never fatal: the guard must never make pi unable to start.
        console.error("companion-guard: DEGRADED — seed manifest unreadable; only the registry fixtures are vetoed.");
      }
    }
    const target = input?.path ?? input?.file_path;
    if (typeof target !== "string") return;
    const reason = writeBlockReason(target, root, frozen);
    if (reason) return { block: true, reason: `companion-guard: ${reason}` };
    return;
  });
}
