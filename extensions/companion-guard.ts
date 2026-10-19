// companion-guard — the companion's bright lines, made structural.
//
// The companion's boundary (CLAUDE.md rule 8) is partly structural: no GitHub
// WRITE credential (its token is read-only), no App key, no gh binary in the
// image. It does hold the owner's full ssh to the VM and may deploy, and this
// guard cannot see inside a remote shell. Three
// bright lines would otherwise be held by PROMPT alone; this extension turns
// them into tool_call vetoes the model cannot talk itself past:
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
//   2. Rule 8 — never a GitHub WRITE, never the gate: `git push`, `gh` and
//      the gate's shell route (post-review.sh and kin, mint-token.sh) are
//      refused by name, not just by missing credentials. The companion holds
//      a READ-ONLY App token (src/tui/ghread.ts); write-shaped API calls made
//      with it are refused here too, though GitHub would refuse them anyway.
//      `scripts/deploy.sh` runs only in the modes rule 8 grants (`release`,
//      `provision`, `verify`, each with or without `--dry-run`); any other
//      mode is refused by name.
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
import type { ExtensionAPI, ToolCallEvent } from "@earendil-works/pi-coding-agent";
import { shellWords, splitShellSegments } from "./bash-guard.js";

export interface BashRule {
  pattern: RegExp;
  reason: string;
}

/** Bash bright lines. Patterns are deliberately TIGHT: a false veto on a
 * legitimate command teaches the operator to want the guard gone. `git
 * checkout -b`, plain branch switches, `git restore --staged` and `git stash
 * list/show` stay allowed on purpose. */
export const BASH_RULES: BashRule[] = [
  {
    pattern: /\bgit\s+push\b/,
    reason:
      "rule 8: the companion never mutates GitHub — no push, ever. Commit locally with the [companion] prefix and leave landing to the humans/daemon.",
  },
  {
    pattern: /(^|[\s/;&|])gh\s+/,
    reason:
      "rule 8: no gh here — it is not installed, and this guard keeps it a boundary rather than an accident of the image. GitHub reads go through the read-only token in $QCR_GITHUB_READ_ENV.",
  },
  {
    // Refused when RUN in a mode rule 8 does not grant; the granted modes
    // (`release`, `provision`, `verify`, optionally behind `--dry-run`) pass.
    // Spaces and tabs only between the words: a newline ends the command, so
    // `deploy.sh` on its own line is a bare call (deploy.sh's default mode).
    pattern:
      /(^|[;&|\n(`{]|\$\(|-exec(dir)?\s)\s*(([A-Za-z_]\w*=\S*|sudo|env|exec|nohup|command|time|eval|xargs|bash|sh|zsh|dash|source|\.|timeout(\s+-\S+)*\s+\S+)(\s+-\S+)*\s+)*['"]?(\S*\/)?deploy\.sh\b(?!['"]?[ \t]+(--dry-run[ \t]+)?(release|provision|verify)(?![\w-]))/,
    reason:
      "rule 8: the companion runs scripts/deploy.sh only as `release <version>`, `provision` or `verify` (each may take --dry-run first), following the deploying skill: drain first, a version CI already built. Any other mode (sync, rebuild, a bare call) is the owner's.",
  },
  {
    // The gate's shell route. The companion holds no App key, so these would
    // fail anyway — refused by name so that stays a boundary. Refused when
    // RUN, never when read (the companion edits these scripts too): the
    // script name in command position — at the start of a command, after
    // a separator, `$(`, a backtick, `-exec`, or behind env assignments and
    // the wrappers that run their argument (bash/sh/source/./env/sudo/exec/
    // xargs/timeout/eval…). `git diff`, `cat`, `grep` and an editor name it
    // as an ARGUMENT and pass.
    pattern:
      /(^|[;&|\n(`{]|\$\(|-exec(dir)?\s)\s*(([A-Za-z_]\w*=\S*|sudo|env|exec|nohup|command|time|eval|xargs|bash|sh|zsh|dash|source|\.|timeout(\s+-\S+)*\s+\S+)(\s+-\S+)*\s+)*['"]?(\S*\/)?(post-review|approve-pr|reply-thread|mint-token)\.sh\b/,
    reason:
      "rule 8: the companion never touches the gate — the posting scripts and mint-token.sh are the daemon's route to GitHub, not yours.",
  },
  {
    // The read-only token's belt. The token is scoped read-only by
    // GitHub itself (the brace — src/tui/ghread.ts); this refuses the shapes
    // of a write aimed at the API anyway: PUT/PATCH/DELETE, or a GraphQL
    // mutation.
    pattern:
      /^(?=[\s\S]*(api\.github\.com|QCR_GITHUB_READ_TOKEN))(?=[\s\S]*(-X\s*['"]?(PUT|PATCH|DELETE)\b|--request[=\s]+['"]?(PUT|PATCH|DELETE)\b|--method[=\s]+['"]?(PUT|PATCH|DELETE)\b|\bmutation\b))/i,
    reason:
      "rule 8: the companion reads GitHub and never writes it — its token is read-only, and write-shaped calls (PUT/PATCH/DELETE, GraphQL mutations) are refused outright.",
  },
  {
    // …and a REST POST (explicit, or implied by curl's data flags) anywhere
    // but /graphql, where POST is how a READ query is sent.
    pattern:
      /^(?=[\s\S]*(api\.github\.com|QCR_GITHUB_READ_TOKEN))(?![\s\S]*\/graphql\b)(?=[\s\S]*(-X\s*['"]?POST\b|--request[=\s]+['"]?POST\b|--method[=\s]+['"]?POST\b|\s(-d|-F|--data[\w-]*|--form|--json)[=\s]))/i,
    reason:
      "rule 8: the companion reads GitHub and never writes it — a POST to the REST API creates something; only GraphQL queries go by POST.",
  },
  {
    pattern: /\bgit\s+stash\b(?!\s+(list|show)\b)/,
    reason:
      "rule 11: never stash in the shared checkout — uncommitted work here may be another actor's (or your own in-flight edit the owner is watching). Commit instead.",
  },
  {
    pattern: /\bgit\s+reset\s+(-\S+\s+)*--hard\b/,
    reason:
      "rule 11: git reset --hard destroys uncommitted work in the shared checkout, and it is not recoverable from the reflog.",
  },
  {
    pattern: /\bgit\s+checkout\s+(-\S+\s+)*(--(\s|$)|\.(\s|$))/,
    reason:
      "rule 11: git checkout -- <path> / git checkout . discards uncommitted changes. Branch switches and -b are fine; discarding is not.",
  },
  {
    pattern: /\bgit\s+clean\b/,
    reason:
      "rule 11: git clean deletes untracked files in the shared checkout — someone else's scratch work included.",
  },
];

/** First matching bash rule's reason, or undefined when the command is fine. */
export function bashBlockReason(
  command: string,
  rules: BashRule[] = BASH_RULES,
): string | undefined {
  if (rules === BASH_RULES) {
    for (const segment of splitShellSegments(command)) {
      const { words } = shellWords(segment);
      // Quoted command strings (bash -c, eval) keep their separators inside
      // a word. Apply the same segment-aware checks to that literal payload.
      for (const word of words) {
        if (/\bgit\s/.test(word) && word.length < segment.length) {
          const reason = bashBlockReason(word, rules);
          if (reason) return reason;
        }
      }
      for (let i = 0; i < words.length; i++) {
        if (!/(?:^|\/)git$/.test(words[i]!)) continue;
        let at = i + 1;
        while (at < words.length && words[at]!.startsWith("-")) {
          const option = words[at++]!;
          if (
            [
              "-C",
              "-c",
              "--git-dir",
              "--work-tree",
              "--namespace",
              "--config-env",
              "--attr-source",
              "--super-prefix",
            ].includes(option)
          )
            at++;
          if (option === "--") break;
        }
        const verb = words[at];
        const args = words.slice(at + 1);
        if (verb === "restore") {
          let staged = false;
          let worktree = false;
          for (let j = 0; j < args.length; j++) {
            const arg = args[j]!;
            if (arg === "--") break;
            if (
              arg.startsWith("--") &&
              ["--source", "--pathspec-from-file", "--conflict"].some((option) =>
                option.startsWith(arg),
              )
            ) {
              j++;
              continue;
            }
            if (arg === "--staged") staged = true;
            else if (/^--w[\w-]*$/.test(arg)) worktree = true;
            else if (/^-[^-]/.test(arg)) {
              for (const flag of arg.slice(1)) {
                if (flag === "s") {
                  if (arg.endsWith("s")) j++; // detached source value
                  break;
                }
                if (flag === "S") staged = true;
                if (flag === "W") worktree = true;
              }
            }
          }
          if (!staged || worktree)
            return "rule 11: git restore that touches the worktree discards uncommitted changes. Use --staged or -S alone to change only the index.";
        }
        if (verb === "checkout" && args.includes("--"))
          return "rule 11: git checkout with path operands discards uncommitted changes in the shared checkout.";
        // Apply the existing bright lines after consuming git's global options.
        const normalized = `git ${words.slice(at).join(" ")}`;
        for (const rule of rules) if (rule.pattern.test(normalized)) return rule.reason;
      }
    }
  }
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
export type ManifestRead =
  { state: "manifest"; files: string[] } | { state: "unreadable"; reason: string };

/**
 * Read the seed manifest, classifying a STRUCTURALLY USELESS payload as
 * unreadable rather than as a good read of nothing.
 *
 * `{}`, `{"files":{}}`, or any JSON that lost the `files` key all name zero
 * frozen paths — which disarms the rule-6 veto for every seed just as
 * completely as an unparseable file does, and would do it silently. Same call as
 * `CandidateStore.read`'s "no candidates array" and
 * `readRolloverStateFile`'s "no usable last_open_date": the file is there and
 * we cannot use it, so it is unreadable.
 */
export function readSeedManifest(root: string): ManifestRead {
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(resolve(root, "tests/fixtures/seed-manifest.json"), "utf8"));
  } catch (err) {
    return { state: "unreadable", reason: err instanceof Error ? err.message : String(err) };
  }
  // Everything below is a TOTAL check on an `unknown`. A cast would not do: a
  // top-level `null` parses fine and `manifest.files` would then throw OUT of
  // the `pi.on` handler, printing no DEGRADED line and applying no veto — the
  // exact silent outcome this function exists to make impossible.
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    return { state: "unreadable", reason: "manifest is not an object" };
  }
  const files = (parsed as { files?: unknown }).files;
  if (typeof files !== "object" || files === null || Array.isArray(files)) {
    return { state: "unreadable", reason: "no files object" };
  }
  const keys = Object.keys(files);
  if (keys.length === 0) return { state: "unreadable", reason: "manifest lists no files" };
  return { state: "manifest", files: keys };
}

/**
 * Repo-relative frozen paths: every file in the seed manifest, plus the two
 * registry fixtures. A missing/unreadable manifest yields ONLY the fixtures.
 *
 * **This fail-open is DELIBERATE** — it is the one member of the "could not
 * read ⇒ there is nothing" family in this repo that is not a defect, so here
 * is why:
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
 * The degradation is (a) always LOUD — `readSeedManifest` classifies a
 * manifest that names no files as unreadable, so the empty frozen set cannot
 * arrive silently — and (b) never cached for the life of the session; see
 * `activate`.
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
export function writeBlockReason(
  path: string,
  root: string,
  frozen: Set<string>,
): string | undefined {
  const abs = isAbsolute(path) ? path : resolve(root, path);
  const rel = relative(root, abs);
  if (rel.startsWith("..")) return undefined; // outside the repo — mounts enforce their own modes
  if (!frozen.has(rel)) return undefined;
  if ((REGISTRY_FIXTURES as readonly string[]).includes(rel)) {
    return `rule 6: ${rel} is a registry fixture with exactly two sanctioned writers (a human recording a ratified reseed; the TUI rubric-accept path) — the companion is neither. Argue for the change; never make it.`;
  }
  return `rule 6: ${rel} is a frozen seed (byte-identical to the canonical copies under seeds/, pinned by the seed manifest). Pass behaviour changes go through PASS_ADDENDA in src/include.ts; a reseed is the owner's to ratify.`;
}

/** Same hookup shape as extensions/bash-guard.ts: `pi.on("tool_call", …)`
 * returning { block, reason } is VERIFIED (pi control-surface findings §5); the
 * payload field names (`toolName`, `input`/`arguments`, write/edit's `path`)
 * stay VERIFY-ON-PIN, probed defensively. */
export default function activate(pi: ExtensionAPI): void {
  const root = process.env.QCR_ROOT ?? process.cwd();
  let frozen: Set<string> | undefined;
  let warnedDegraded = false;

  pi.on("tool_call", (event) => {
    // `arguments` is not on pi 1.3.0's ToolCallEvent; the probe stays for a
    // pi that names the field that way (VERIFY-ON-PIN).
    const ev = event as ToolCallEvent & { arguments?: Record<string, unknown> };
    const input = (ev.input ?? ev.arguments) as
      { command?: unknown; path?: unknown; file_path?: unknown } | undefined;

    if (ev.toolName === "bash") {
      const cmd = input?.command;
      if (typeof cmd !== "string") return;
      const reason = bashBlockReason(cmd);
      if (reason) return { block: true, reason: `companion-guard: ${reason}` };
      return;
    }

    if (ev.toolName !== "write" && ev.toolName !== "edit") return;
    // Cache a GOOD read only, so a manifest unreadable for one moment (a
    // half-written fixture, a checkout mid-rewrite) does not leave the guard
    // degraded for the whole session. A degraded read is retried on the next
    // call; the read is one small JSON file, and only on the degraded path.
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
        console.error(
          `companion-guard: DEGRADED — seed manifest unreadable (${read.reason}); only the registry fixtures are vetoed.`,
        );
      }
    }
    const target = input?.path ?? input?.file_path;
    if (typeof target !== "string") return;
    const reason = writeBlockReason(target, root, set);
    if (reason) return { block: true, reason: `companion-guard: ${reason}` };
    return;
  });
}
