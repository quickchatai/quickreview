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
// sessions have their own gate + guards.sh mirror, and subagent children load
// only the global settings extensions (this rides argv) so leaves never pay
// for this hook.
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

/** The manifest read, with "could not read it" kept as its own answer so the
 * caller can decline to CACHE a degraded set. */
export type ManifestRead = { state: "manifest"; files: string[] } | { state: "unreadable"; reason: string };

/**
 * Read the seed manifest, classifying a STRUCTURALLY USELESS payload as
 * unreadable rather than as a good read of nothing.
 *
 * `{}`, `{"files":{}}`, or any JSON that lost the `files` key all name zero
 * frozen paths — which disarms the rule-6 veto for every seed just as
 * completely as an unparseable file does. Treating those as a good read
 * printed no warning at all and cached the empty set for the session, which
 * is strictly worse than the fail-open it replaced. Same call as
 * `CandidateStore.read`'s "no candidates array" and
 * `readRolloverStateFile`'s "no usable last_open_date": the file is there and
 * we cannot use it, so it is unreadable.
 */
export function readSeedManifest(root: string): ManifestRead {
  let manifest: { files?: unknown };
  try {
    manifest = JSON.parse(readFileSync(resolve(root, "tests/fixtures/seed-manifest.json"), "utf8")) as { files?: unknown };
  } catch (err) {
    return { state: "unreadable", reason: err instanceof Error ? err.message : String(err) };
  }
  const files = manifest.files;
  if (typeof files !== "object" || files === null || Array.isArray(files)) {
    return { state: "unreadable", reason: "no files object" };
  }
  const keys = Object.keys(files as Record<string, unknown>);
  if (keys.length === 0) return { state: "unreadable", reason: "manifest lists no files" };
  return { state: "manifest", files: keys };
}

/**
 * Repo-relative frozen paths: every file in the seed manifest, plus the two
 * registry fixtures. A missing/unreadable manifest yields ONLY the fixtures.
 *
 * **This fail-open is DELIBERATE, and re-confirmed it** — it is the
 * one member of the "could not read ⇒ there is nothing" family in this repo
 * that is not a defect, so here is why, since every other one now is:
 *
 *  * This guard is BELT, not the brace. The module header says so already: it
 *    is a `tool_call` veto over the companion's own write/edit calls, and bash
 *    can in principle write a frozen file (sed, tee) without going near it.
 *    The AUTHORITATIVE enforcement of rule 6 is
 *    `tests/seed-integrity.test.ts` — a sha256 manifest that fails the suite —
 *    and that check reads the same file this one does, but a suite that cannot
 *    read it FAILS. Failing closed here would not close a hole; it would only
 *    move the report from the place that already catches it.
 *  * Failing closed means vetoing every write and edit the companion makes,
 *    which is a companion that cannot do its job at all (rule 11: it edits the
 *    live checkout, that IS the loop) — over a fixture problem it could
 *    normally fix ITSELF. The cost of the strict reading is total; the cost of
 *    the open one is bounded by the brace above.
 *
 * What DID change is that this degradation is now (a) always LOUD —
 * `readSeedManifest` classifies a manifest that names no files as unreadable,
 * so the empty frozen set can no longer arrive silently — and (b) never cached
 * for the life of the session; see `activate`.
 *
 * It takes the READ rather than a path so `activate` can use this one function
 * for the set AND classify the degradation from the same single read.
 */
export function frozenPaths(read: ManifestRead): Set<string> {
  const frozen = new Set<string>(REGISTRY_FIXTURES);
  if (read.state === "manifest") for (const rel of read.files) frozen.add(rel);
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
    // cache a GOOD read only. The old code cached whatever the first
    // write/edit call produced, so a manifest that was unreadable for one
    // moment (a half-written fixture, a checkout mid-rewrite) left the guard
    // degraded for the whole session, silently, long after the file was fine
    // again. A degraded read is retried on the next call; the read is one
    // small JSON file, and only on the degraded path.
    let set = frozen;
    if (set === undefined) {
      const read = readSeedManifest(root);
      set = frozenPaths(read);
      if (read.state === "manifest") {
        frozen = set; // cached: the set changes only on a reseed, which restarts everything
        warnedDegraded = false; // recovered — a later degradation is loud again
      } else if (!warnedDegraded) {
        warnedDegraded = true;
        // Loud, never fatal: the guard must never make pi unable to start.
        // Fail-open here is deliberate — see `frozenPaths` for why.
        console.error(`companion-guard: DEGRADED — seed manifest unreadable (${read.reason}); only the registry fixtures are vetoed.`);
      }
    }
    const target = input?.path ?? input?.file_path;
    if (typeof target !== "string") return;
    const reason = writeBlockReason(target, root, set);
    if (reason) return { block: true, reason: `companion-guard: ${reason}` };
    return;
  });
}
