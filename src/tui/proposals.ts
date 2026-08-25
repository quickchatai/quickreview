// Proposals half of the Memory & learning tab (§7/§8).
//
// Three proposal kinds surface here:
//   * Rubric proposals — authored by the COMPANION's `land` skill as
//     `state/rubric/<slug>/` dirs in the LOCAL canonical repo (the checkout
//     this TUI runs in; the companion sees the same tree mounted rw at
//     /workspace). Each dir carries PROPOSAL.md + changes.patch. The old
//     producer — the EOD curator drafting dirs on the VM — is retired
//     (it flags candidates in the digest and authors nothing), so
//     everything here is local fs: no ssh, no VM path. Accept/reject verdicts
//     are the owner's, delivered as TUI keystrokes.
//   * Bot-filed improvement PRs (`bot/improve-*`) and issues (`bot-filed`
//     label) on the reviewed repo — status via a live in-container `gh` READ
//     (reads are direct per the gate rules; the mint-token credential).
//
// ACCEPT = merge + auto-ratify (ratified decision): the click IS the
// ratification. The patch is applied to the canonical repo, the seed manifest
// hash is re-pinned, the ratification is appended to
// tests/fixtures/ratified-divergence.json, and the lot is committed. The
// proposal dir is then removed. REJECT removes the dir and records a
// #rejected-proposal memory entry so the same change is never re-proposed.
//
// Containment (the patch is LLM output; these are the walls):
//   * targets — agents// prompts/ only, both diff sides plus rename/copy
//     headers (`patchTargets` + `targetsAllowed`);
//   * RATIFIED fences — a patch may neither edit lines inside a
//     `<!-- RATIFIED … -->` fence nor add a fence marker of its own
//     (`patchFenceViolation`). Rule 6's ratified passages are the owner's; the
//     accept click ratifies the proposal's OWN diff, never a fence rewrite
//     smuggled inside it.
import { createHash } from "node:crypto";
import { readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { TuiConfig } from "../config.js";

export interface RubricProposal {
  slug: string;
  /** First content lines of PROPOSAL.md — the pitch. */
  head: string[];
}

export interface ImprovementItem {
  kind: "pr" | "issue";
  number: number;
  title: string;
  /** open | merged | closed. */
  state: string;
}

const SLUG_RE = /^[A-Za-z0-9._-]+$/;

export function validSlug(slug: string): boolean {
  return SLUG_RE.test(slug) && !slug.startsWith(".");
}

// ---- the local proposal store: state/rubric/<slug>/ -----------------------

/** Where proposals live: the LOCAL repo's state dir — the same path the
 * companion writes under /workspace. Never a VM path. */
export function rubricDir(repoRoot: string): string {
  return join(repoRoot, "state", "rubric");
}

export function listRubricProposals(repoRoot: string): string[] {
  let names: string[];
  try {
    names = readdirSync(rubricDir(repoRoot));
  } catch {
    return []; // no dir yet = no proposals; never a throw on a fresh checkout
  }
  return names.filter(validSlug).sort();
}

/** Read one proposal file (capped — PROPOSAL.md is a pitch, not a book).
 * null = missing/unreadable. */
export function readRubricFile(repoRoot: string, slug: string, file: "PROPOSAL.md" | "changes.patch"): string | null {
  if (!validSlug(slug)) throw new Error(`bad rubric slug '${slug}'`);
  try {
    return readFileSync(join(rubricDir(repoRoot), slug, file), "utf8").slice(0, 65536);
  } catch {
    return null;
  }
}

/** The ONLY dir mutation this module performs — removing a decided proposal
 * dir. Slug-validated, path fixed under state/rubric. */
export function removeRubricDir(repoRoot: string, slug: string): void {
  if (!validSlug(slug)) throw new Error(`bad rubric slug '${slug}'`);
  rmSync(join(rubricDir(repoRoot), slug), { recursive: true, force: true });
}

// ---- improvement PRs/issues: still a remote gh READ -----------------------

function dockerSh(cfg: TuiConfig, script: string): string[] {
  return [...(cfg.sudo_docker ? ["sudo"] : []), "docker", "exec", cfg.container, "sh", "-c", script];
}

/** Bot-filed improvement PRs + issues, one in-container gh read. gh's exit
 * code is ignored per list (a missing label must not blank the other list). */
export function improvementsArgv(cfg: TuiConfig, repo: string): string[] {
  if (!/^[\w.-]+\/[\w.-]+$/.test(repo)) throw new Error(`bad repo '${repo}'`);
  const gh = `GH_TOKEN="$(bash scripts/mint-token.sh)"`;
  return dockerSh(
    cfg,
    `cd '${cfg.remote_sandbox_root}' && ` +
      `{ ${gh} gh pr list -R '${repo}' --state all --limit 30 --search 'head:bot/improve' --json number,title,state 2>/dev/null || echo '[]'; } && echo '---' && ` +
      `{ ${gh} gh issue list -R '${repo}' --state all --limit 30 --label bot-filed --json number,title,state 2>/dev/null || echo '[]'; }`,
  );
}

export function parseImprovements(stdout: string): ImprovementItem[] {
  const [prPart, issuePart] = stdout.split("\n---\n");
  const parse = (raw: string | undefined, kind: "pr" | "issue"): ImprovementItem[] => {
    try {
      const rows = JSON.parse((raw ?? "[]").trim()) as Array<{ number: number; title: string; state: string }>;
      return rows.map((r) => ({ kind, number: r.number, title: r.title, state: r.state.toLowerCase() }));
    } catch {
      return [];
    }
  };
  return [...parse(prPart, "pr"), ...parse(issuePart, "issue")];
}

// ---- accept = merge + auto-ratify (local, canonical repo) -----------------

export interface LocalGit {
  /** Run a command in the repo root; returns stdout, throws on failure. */
  run(cmd: string, args: string[], stdin?: string): Promise<string>;
}

/** EVERY path a rubric patch touches — both diff sides plus rename/copy
 * headers, so a deletion (`+++ /dev/null` with a `---` victim) or a rename
 * cannot smuggle a target past the allowlist. The patch is LLM output; this
 * list is the containment. */
export function patchTargets(patch: string): string[] {
  const files = new Set<string>();
  for (const m of patch.matchAll(/^(?:\+\+\+|---) (?:[ab]\/)?(\S+)/gm)) {
    if (m[1] !== "/dev/null") files.add(m[1]!);
  }
  for (const m of patch.matchAll(/^(?:rename|copy) (?:from|to) (\S+)/gm)) files.add(m[1]!);
  return [...files].sort();
}

/** Pass rubrics and prompts only — never src/, scripts/, or a traversal. */
export function targetsAllowed(files: string[]): boolean {
  return (
    files.length > 0 &&
    files.every((f) => (f.startsWith("agents/") || f.startsWith("prompts/")) && !f.split("/").includes("..") && !f.includes("\\"))
  );
}

// ---- RATIFIED fences: a proposal patch may never reach inside one ---------

const FENCE_OPEN = /<!--\s*RATIFIED\b/;
const FENCE_CLOSE = /<!--\s*\/RATIFIED\b/;

/** 1-based inclusive line ranges of `<!-- RATIFIED … -->` fences, MARKERS
 * INCLUDED (deleting a marker is as forbidden as editing the text it pins).
 * An unterminated fence protects to end-of-file rather than nothing. */
export function fenceRanges(content: string): Array<{ start: number; end: number }> {
  const out: Array<{ start: number; end: number }> = [];
  const lines = content.split("\n");
  let start: number | null = null;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!;
    if (start === null) {
      if (FENCE_OPEN.test(line) && !FENCE_CLOSE.test(line)) start = i + 1;
    } else if (FENCE_CLOSE.test(line)) {
      out.push({ start, end: i + 1 });
      start = null;
    }
  }
  if (start !== null) out.push({ start, end: lines.length });
  return out;
}

/**
 * Rule 6's structural half of the accept path: a changes.patch that touches
 * lines inside a RATIFIED fence — or that carries a fence marker on an added
 * line (minting/moving a fence) — is refused before git ever sees it.
 *
 * `readFile` resolves a target's CURRENT content (null = file does not exist
 * yet, so it has no fences). Returns the refusal message, or null when clean.
 */
export function patchFenceViolation(patch: string, readFile: (rel: string) => string | null): string | null {
  let file: string | null = null;
  let ranges: Array<{ start: number; end: number }> = [];
  let oldLine = 0;
  let inHunk = false;
  for (const line of patch.split("\n")) {
    if (line.startsWith("--- ")) {
      const m = /^--- (?:[ab]\/)?(\S+)/.exec(line);
      file = m && m[1] !== "/dev/null" ? m[1]! : null;
      const content = file === null ? null : readFile(file);
      ranges = content === null ? [] : fenceRanges(content);
      inHunk = false;
      continue;
    }
    if (line.startsWith("+++ ")) continue;
    const h = /^@@ -(\d+)(?:,\d+)? /.exec(line);
    if (h) {
      oldLine = Number(h[1]);
      inHunk = true;
      continue;
    }
    if (!inHunk) continue;
    if (line.startsWith("+")) {
      if (FENCE_OPEN.test(line) || FENCE_CLOSE.test(line)) {
        return `refused: patch adds a RATIFIED fence marker${file ? ` in ${file}` : ""} — fences are the owner's alone`;
      }
      // An insertion sits between old lines oldLine-1 and oldLine: inside a
      // fence when both neighbours are (strictly after the open marker, at or
      // before the close marker).
      if (ranges.some((r) => oldLine > r.start && oldLine <= r.end)) {
        return `refused: patch inserts inside a RATIFIED fence in ${file} — propose the change to the owner instead`;
      }
      continue;
    }
    if (line.startsWith("-")) {
      if (ranges.some((r) => oldLine >= r.start && oldLine <= r.end)) {
        return `refused: patch touches lines inside a RATIFIED fence in ${file} — propose the change to the owner instead`;
      }
      oldLine++;
      continue;
    }
    oldLine++; // context line
  }
  return null;
}

/** Append the ratification + re-pin manifest hashes for the seeded files the
 * accepted patch touched. Pure file transforms — caller does git. */
export function recordRatification(repoRoot: string, files: string[], slug: string, today: string): string[] {
  const manifestPath = join(repoRoot, "tests/fixtures/seed-manifest.json");
  const divergencePath = join(repoRoot, "tests/fixtures/ratified-divergence.json");
  const manifest = JSON.parse(readFileSync(manifestPath, "utf8")) as { files: Record<string, string> };
  const divergence = JSON.parse(readFileSync(divergencePath, "utf8")) as { files: Record<string, string[]> };
  const touched: string[] = [];
  for (const rel of files) {
    if (!(rel in manifest.files)) continue; // non-seeded (e.g. pass-intent.md) needs no exemption
    manifest.files[rel] = createHash("sha256").update(readFileSync(join(repoRoot, rel))).digest("hex");
    const notes = divergence.files[rel] ?? (divergence.files[rel] = []);
    notes.push(`${today} the owner: rubric proposal '${slug}' accepted via TUI (the accept click is the ratification)`);
    touched.push(rel);
  }
  if (touched.length > 0) {
    writeFileSync(manifestPath, JSON.stringify(manifest, null, 2) + "\n");
    writeFileSync(divergencePath, JSON.stringify(divergence, null, 2) + "\n");
  }
  return touched;
}

export interface AcceptDeps {
  git: LocalGit;
  repoRoot: string;
  today: () => string; // YYYY-MM-DD
}

export async function acceptProposal(deps: AcceptDeps, slug: string): Promise<{ ok: boolean; message: string }> {
  if (!validSlug(slug)) return { ok: false, message: `bad slug '${slug}'` };
  const patch = readRubricFile(deps.repoRoot, slug, "changes.patch");
  if (patch === null || patch.trim().length === 0) return { ok: false, message: `no changes.patch for '${slug}'` };
  const files = patchTargets(patch);
  if (!targetsAllowed(files)) return { ok: false, message: `refused: patch touches non-rubric paths (${files.join(", ") || "none"})` };
  const fence = patchFenceViolation(patch, (rel) => {
    try {
      return readFileSync(join(deps.repoRoot, rel), "utf8");
    } catch {
      return null;
    }
  });
  if (fence !== null) return { ok: false, message: fence };
  try {
    await deps.git.run("git", ["apply", "--check", "-"], patch);
  } catch (err) {
    return { ok: false, message: `patch does not apply cleanly: ${String(err instanceof Error ? err.message : err).slice(0, 200)}` };
  }
  try {
    await deps.git.run("git", ["apply", "-"], patch);
    const ratified = recordRatification(deps.repoRoot, files, slug, deps.today());
    const toAdd = [...files, ...(ratified.length > 0 ? ["tests/fixtures/seed-manifest.json", "tests/fixtures/ratified-divergence.json"] : [])];
    await deps.git.run("git", ["add", "--", ...toAdd]);
    await deps.git.run("git", ["commit", "-m", `rubric: accept '${slug}' — ratified by the owner via TUI`]);
  } catch (err) {
    return { ok: false, message: `apply/commit failed — repo may need manual attention: ${String(err instanceof Error ? err.message : err).slice(0, 200)}` };
  }
  let removed = true;
  try {
    removeRubricDir(deps.repoRoot, slug);
  } catch {
    removed = false;
  }
  return {
    ok: true,
    message: `accepted '${slug}': ${files.join(", ")} — committed locally; deploy to ship${removed ? "" : " (proposal dir removal failed — remove by hand)"}`,
  };
}
