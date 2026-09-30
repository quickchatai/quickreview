// Rubric proposals — the PROPOSED pane of the `[7] feedback` tab (§7/§8).
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
// adds a second accepted kind alongside rubric proposals: CONFIG
// proposals — same dirs, same surface, but changes.patch targets config.toml
// (exactly that one file). Accept = apply + local commit (no ratification
// bookkeeping: config is not a seed); the structural guard is that a config
// patch may NEVER touch `dry_run` (`configPatchViolation` — rule 1).
//
// Containment (the patch is LLM output; these are the walls):
//   * targets — agents// prompts/ only (rubric) or config.toml alone
//     (config), both diff sides plus rename/copy headers (`patchTargets` +
//     `proposalKind`); anything else is refused;
//   * RATIFIED fences — a patch may neither edit lines inside a
//     `<!-- RATIFIED … -->` fence nor add a fence marker of its own
//     (`patchFenceViolation`). Rule 6's ratified passages are the owner's; the
//     accept click ratifies the proposal's OWN diff, never a fence rewrite
//     smuggled inside it.
//   * text only — binary, mode-change and non-100644 file sections are
//     refused (`patchShapeViolation`), and a seed is never deleted or
//     renamed away (`patchRemovals`);
//   * the POST-IMAGE — git applies the patch to a throwaway copy first and
//     the result is judged (`postImageViolation`): every fence byte-identical,
//     and a config patch leaves the PARSED root `dry_run` unchanged. The
//     header-coordinate checks are the fast refusal; this is the proof,
//     because git places a hunk by its context, not its header;
//   * the shared checkout (rule 11) — a target with uncommitted edits is
//     refused, and the commit is `--only` the proposal's paths, so neither
//     the companion's in-flight edits nor its staged work ride along.
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { parse as parseToml } from "smol-toml";
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
export function readRubricFile(
  repoRoot: string,
  slug: string,
  file: "PROPOSAL.md" | "changes.patch",
): string | null {
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
  return [
    ...(cfg.sudo_docker ? ["sudo"] : []),
    "docker",
    "exec",
    cfg.container,
    "sh",
    "-c",
    script,
  ];
}

/** What the in-container script prints in place of a list whose gh call
 * failed — deliberately not JSON, so it can never parse as an empty list. */
export const IMPROVEMENTS_FAILED = "QCR_GH_READ_FAILED";

/** Bot-filed improvement PRs + issues, one in-container gh read. A failing gh
 * call is caught PER LIST (a missing label must not blank the other list),
 * but it prints the failure sentinel, never `[]`: "could not ask" is not
 * "there are none". */
export function improvementsArgv(cfg: TuiConfig, repo: string): string[] {
  if (!/^[\w.-]+\/[\w.-]+$/.test(repo)) throw new Error(`bad repo '${repo}'`);
  const gh = `GH_TOKEN="$(bash scripts/mint-token.sh)"`;
  return dockerSh(
    cfg,
    `cd '${cfg.remote_sandbox_root}' && ` +
      `{ ${gh} gh pr list -R '${repo}' --state all --limit 30 --search 'head:bot/improve' --json number,title,state 2>/dev/null || echo '${IMPROVEMENTS_FAILED}'; } && echo '---' && ` +
      `{ ${gh} gh issue list -R '${repo}' --state all --limit 30 --label bot-filed --json number,title,state 2>/dev/null || echo '${IMPROVEMENTS_FAILED}'; }`,
  );
}

export interface ImprovementsRead {
  items: ImprovementItem[];
  /** The lists that could not be read — their absence from `items` is NOT
   * an empty list. */
  failed: Array<"pr" | "issue">;
}

export function parseImprovements(stdout: string): ImprovementsRead {
  const [prPart, issuePart] = stdout.split("\n---\n");
  const failed: ImprovementsRead["failed"] = [];
  const parse = (raw: string | undefined, kind: "pr" | "issue"): ImprovementItem[] => {
    try {
      const rows: unknown = JSON.parse((raw ?? "").trim());
      if (!Array.isArray(rows)) throw new Error("not a list");
      return (rows as Array<{ number: number; title: string; state: string }>).map((r) => ({
        kind,
        number: r.number,
        title: r.title,
        state: r.state.toLowerCase(),
      }));
    } catch {
      // The failure sentinel, a missing half, or garbage: all unread.
      failed.push(kind);
      return [];
    }
  };
  const items = [...parse(prPart, "pr"), ...parse(issuePart, "issue")];
  return { items, failed };
}

// ---- accept = merge + auto-ratify (local, canonical repo) -----------------

export interface LocalGit {
  /** Run a command in the repo root; returns stdout, throws on failure. */
  run(cmd: string, args: string[], stdin?: string): Promise<string>;
}

/** EVERY path a rubric patch touches — both diff sides, rename/copy headers
 * AND the `diff --git` headers, so a deletion (`+++ /dev/null` with a `---`
 * victim), a rename, or a section git applies with no ---/+++ lines at all
 * (a binary patch, a mode change) cannot smuggle a target past the
 * allowlist. A `diff --git` header this cannot split cleanly contributes its
 * raw text, which no allowlist admits — fail closed. The patch is LLM
 * output; this list is the containment. */
export function patchTargets(patch: string): string[] {
  const files = new Set<string>();
  for (const m of patch.matchAll(/^(?:\+\+\+|---) (?:[ab]\/)?(\S+)/gm)) {
    if (m[1] !== "/dev/null") files.add(m[1]!);
  }
  for (const m of patch.matchAll(/^(?:rename|copy) (?:from|to) (\S+)/gm)) files.add(m[1]!);
  for (const m of patch.matchAll(/^diff --git (.*)$/gm)) {
    const h = /^a\/(\S+) b\/(\S+)$/.exec(m[1]!);
    if (h) {
      files.add(h[1]!);
      files.add(h[2]!);
    } else files.add(m[1]!);
  }
  return [...files].sort();
}

/**
 * A proposal is a TEXT edit: every guard below reads hunks. A section git
 * applies without one — a binary patch, a mode change, a new file that is a
 * symlink or executable — is invisible to the fence and dry_run checks, so
 * it is refused outright. Returns the refusal message, or null when clean.
 */
export function patchShapeViolation(patch: string): string | null {
  if (/^(?:GIT binary patch|Binary files )/m.test(patch))
    return "refused: patch carries a binary section — a proposal is a text edit";
  if (/^(?:old|new) mode /m.test(patch))
    return "refused: patch changes a file mode — a proposal is a text edit";
  const fileMode = /^(?:new|deleted) file mode (\d+)/gm;
  for (const m of patch.matchAll(fileMode)) {
    if (m[1] !== "100644")
      return `refused: patch creates or deletes a file with mode ${m[1]} — a proposal is a plain text file`;
  }
  return null;
}

/** Paths a patch REMOVES — deletions (`+++ /dev/null`, `deleted file mode`)
 * and rename sources. */
export function patchRemovals(patch: string): string[] {
  const out = new Set<string>();
  let gitOld: string | null = null;
  let minus: string | null = null;
  for (const line of patch.split("\n")) {
    const g = /^diff --git a\/(\S+) b\/\S+$/.exec(line);
    if (g) {
      gitOld = g[1]!;
      minus = null;
      continue;
    }
    if (line.startsWith("deleted file mode ") && gitOld !== null) out.add(gitOld);
    const r = /^rename from (\S+)/.exec(line);
    if (r) out.add(r[1]!);
    const mm = /^--- (?:a\/)?(\S+)/.exec(line);
    if (mm) minus = mm[1] === "/dev/null" ? null : mm[1]!;
    if (/^\+\+\+ \/dev\/null/.test(line) && minus !== null) out.add(minus);
  }
  return [...out].sort();
}

/** Pass rubrics and prompts only — never src/, scripts/, or a traversal. */
export function targetsAllowed(files: string[]): boolean {
  return (
    files.length > 0 &&
    files.every(
      (f) =>
        (f.startsWith("agents/") || f.startsWith("prompts/")) &&
        !f.split("/").includes("..") &&
        !f.includes("\\"),
    )
  );
}

// ---- proposal kinds: rubric (agents//prompts/) vs config (config.toml) ----
//
// the first-run interview distills calibration answers into CONFIG
// proposals — same state/rubric/<slug>/ dirs, same accept/reject surface,
// but the patch targets config.toml. The two kinds never mix in one patch:
// a config proposal is exactly one file, config.toml, so the rubric
// containment above stays byte-identical for rubric patches.

export type ProposalKind = "rubric" | "config";

/** Classify a patch's target set. null = neither kind — refused at accept. */
export function proposalKind(files: string[]): ProposalKind | null {
  if (targetsAllowed(files)) return "rubric";
  if (files.length === 1 && files[0] === "config.toml") return "config";
  return null;
}

/** Matches `dry_run` as a whole word — assignments, inline tables, whatever
 * shape a patch smuggles it in. A comment merely MENTIONING dry_run also
 * trips this; that false positive is safe (the operator edits config by
 * hand), the false negative is not. */
const DRY_RUN_TOKEN = /(^|[^0-9A-Za-z_])dry_run([^0-9A-Za-z_]|$)/;

/**
 * Rule 1's structural half of the config-proposal path: a changes.patch may
 * NEVER touch `dry_run` — the flag is the owner's alone, and a proposal that
 * adds, removes or rewrites any line carrying it is refused before git ever
 * sees it. Returns the refusal message, or null when clean.
 */
export function configPatchViolation(patch: string): string | null {
  let inHunk = false;
  for (const line of patch.split("\n")) {
    if (line.startsWith("--- ") || line.startsWith("+++ ")) {
      inHunk = false;
      continue;
    }
    if (/^@@ -\d+(?:,\d+)? /.test(line)) {
      inHunk = true;
      continue;
    }
    if (!inHunk) continue;
    if ((line.startsWith("+") || line.startsWith("-")) && DRY_RUN_TOKEN.test(line.slice(1))) {
      return "refused: config proposal touches dry_run — rule 1: the flag is the owner's alone, never a proposal";
    }
  }
  return null;
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

/** The TEXT of each fence, markers included, in order — the invariant a
 * post-image must preserve byte for byte. */
export function fenceBlocks(content: string): string[] {
  const lines = content.split("\n");
  return fenceRanges(content).map((r) => lines.slice(r.start - 1, r.end).join("\n"));
}

/**
 * The post-image half of rule 6 (and rule 1 for config): `patchFenceViolation`
 * reads the hunk HEADERS, but git places a hunk by its context and will
 * relocate one whose header lies (or is merely stale) — onto a fence. So the
 * patch is also applied, by git itself, to a SHADOW copy of its targets, and
 * the result is judged: every fence must survive byte for byte, and a config
 * patch must leave the PARSED root `dry_run` exactly as it was (a quoted or
 * escaped key, or an edit that moves the assignment into a table, changes
 * what the daemon loads without any changed line saying `dry_run`).
 * Returns the refusal message, or null when clean.
 */
export function postImageViolation(
  files: string[],
  before: Map<string, string | null>,
  after: Map<string, string | null>,
  kind: ProposalKind,
): string | null {
  for (const rel of files) {
    const pre = before.get(rel) ?? null;
    const post = after.get(rel) ?? null;
    const a = pre === null ? [] : fenceBlocks(pre);
    const b = post === null ? [] : fenceBlocks(post);
    if (JSON.stringify(a) !== JSON.stringify(b)) {
      return `refused: applying the patch changes a RATIFIED fence in ${rel} (git places hunks by context, not by header) — propose the change to the owner instead`;
    }
  }
  if (kind === "config") {
    const rootDryRun = (text: string | null): { ok: boolean; value: unknown } => {
      if (text === null) return { ok: true, value: undefined };
      try {
        return { ok: true, value: (parseToml(text) as Record<string, unknown>)["dry_run"] };
      } catch {
        return { ok: false, value: undefined };
      }
    };
    const pre = rootDryRun(before.get("config.toml") ?? null);
    const post = rootDryRun(after.get("config.toml") ?? null);
    if (!pre.ok || !post.ok)
      return "refused: config.toml does not parse before or after the patch — cannot prove dry_run is untouched (rule 1)";
    if (JSON.stringify(pre.value) !== JSON.stringify(post.value))
      return "refused: config proposal changes the effective dry_run — rule 1: the flag is the owner's alone, never a proposal";
  }
  return null;
}

/**
 * What a fence-source read of a patch target found. `absent` (the patch
 * creates the file, so it has no fences yet) and `unreadable` (it exists and
 * we could not see it) are SEPARATE answers on purpose — see
 * `patchFenceViolation`.
 */
export type FenceSource =
  | { state: "content"; content: string }
  | { state: "absent" }
  | { state: "unreadable"; reason: string };

/** The production `FenceSource` reader. ENOENT is the only absence; every
 * other errno is an unreadable file and therefore a refusal. */
export function fenceSourceFrom(repoRoot: string, rel: string): FenceSource {
  try {
    return { state: "content", content: readFileSync(join(repoRoot, rel), "utf8") };
  } catch (err) {
    const code = (err as NodeJS.ErrnoException | undefined)?.code;
    if (code === "ENOENT") return { state: "absent" };
    return {
      state: "unreadable",
      reason: code ?? (err instanceof Error ? err.message : String(err)),
    };
  }
}

/**
 * Rule 6's structural half of the accept path: a changes.patch that touches
 * lines inside a RATIFIED fence — or that carries a fence marker on an added
 * line (minting/moving a fence) — is refused before git ever sees it.
 *
 * `readFile` resolves a target's CURRENT content. It has three answers and
 * they are not interchangeable: `absent` is a file the patch creates, which
 * genuinely has no fences; `unreadable` is a file whose fences we could not
 * look at, and that is a REFUSAL. This guard fails CLOSED — the old
 * `catch → null` made EACCES/EISDIR indistinguishable from ENOENT, so one
 * unreadable target let a patch reaching inside an owner-fenced region be
 * accepted, applied and committed: a rule-6 bright-line bypass with a local
 * commit behind it.
 *
 * Returns the refusal message, or null when clean.
 */
export function patchFenceViolation(
  patch: string,
  readFile: (rel: string) => FenceSource,
): string | null {
  let file: string | null = null;
  let ranges: Array<{ start: number; end: number }> = [];
  let oldLine = 0;
  let inHunk = false;
  for (const line of patch.split("\n")) {
    if (line.startsWith("--- ")) {
      const m = /^--- (?:[ab]\/)?(\S+)/.exec(line);
      file = m && m[1] !== "/dev/null" ? m[1]! : null;
      const source = file === null ? ({ state: "absent" } as const) : readFile(file);
      if (source.state === "unreadable") {
        return `refused: cannot read ${file} to check its RATIFIED fences (${source.reason}) — an unreadable file is not an unfenced one`;
      }
      ranges = source.state === "content" ? fenceRanges(source.content) : [];
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

/** Append the ratification + re-pin manifest hashes + refresh the seeds/
 * canonical copies for the seeded files the accepted patch touched. Pure file
 * transforms — caller does git.
 *
 * seeds/ carries the in-repo canonical copies the provenance suite
 * (tests/seed-integrity.test.ts) compares against, so an accepted reseed must
 * refresh the copy alongside the manifest sha — the canonical bytes track the
 * ratified content, while the divergence registry (not seeds/) records the
 * departure from the original lineage. The note is role-worded
 * ("owner": the accept click is the owner's ratification); legacy notes
 * say "the owner" and stay valid — history is never rewritten. */
export function recordRatification(
  repoRoot: string,
  files: string[],
  slug: string,
  today: string,
): string[] {
  const manifestPath = join(repoRoot, "tests/fixtures/seed-manifest.json");
  const divergencePath = join(repoRoot, "tests/fixtures/ratified-divergence.json");
  const manifest = JSON.parse(readFileSync(manifestPath, "utf8")) as {
    files: Record<string, string>;
  };
  const divergence = JSON.parse(readFileSync(divergencePath, "utf8")) as {
    files: Record<string, string[]>;
  };
  const touched: string[] = [];
  for (const rel of files) {
    if (!(rel in manifest.files)) continue; // non-seeded (e.g. pass-intent.md) needs no exemption
    const content = readFileSync(join(repoRoot, rel));
    manifest.files[rel] = createHash("sha256").update(content).digest("hex");
    const canonical = join(repoRoot, "seeds", rel);
    mkdirSync(dirname(canonical), { recursive: true });
    writeFileSync(canonical, content);
    const notes = divergence.files[rel] ?? (divergence.files[rel] = []);
    notes.push(
      `${today} owner: rubric proposal '${slug}' accepted via TUI (the accept click is the ratification)`,
    );
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
  /** The live config.toml as the install locator resolved it.
   * Absent = `<repoRoot>/config.toml`, the checkout's legacy file. */
  configPath?: string;
}

/**
 * Where a config proposal lands. The patch always names
 * `config.toml`; the live file may be the checkout's (apply + commit, as
 * before) or the install's config home's — outside this repo, so `git apply`
 * is pointed at its directory and nothing is committed. A `$QCR_CONFIG` file
 * under another name cannot take a `config.toml` patch: refused, never
 * applied to a file the daemon does not read.
 */
type ConfigTarget =
  | { kind: "checkout" }
  | { kind: "home"; dir: string; path: string }
  | { kind: "unappliable"; path: string };

function configTargetOf(deps: AcceptDeps): ConfigTarget {
  const path = deps.configPath;
  if (path === undefined || resolve(path) === resolve(deps.repoRoot, "config.toml"))
    return { kind: "checkout" };
  if (basename(path) !== "config.toml") return { kind: "unappliable", path };
  return { kind: "home", dir: dirname(resolve(path)), path: resolve(path) };
}

export async function acceptProposal(
  deps: AcceptDeps,
  slug: string,
): Promise<{ ok: boolean; message: string }> {
  if (!validSlug(slug)) return { ok: false, message: `bad slug '${slug}'` };
  const patch = readRubricFile(deps.repoRoot, slug, "changes.patch");
  if (patch === null || patch.trim().length === 0)
    return { ok: false, message: `no changes.patch for '${slug}'` };
  const files = patchTargets(patch);
  const kind = proposalKind(files);
  if (kind === null)
    return {
      ok: false,
      message: `refused: patch touches non-proposal paths (${files.join(", ") || "none"})`,
    };
  const shape = patchShapeViolation(patch);
  if (shape !== null) return { ok: false, message: shape };
  if (kind === "rubric") {
    // A seed cannot be deleted or renamed away: ratification re-pins the
    // file's bytes, and there are none to pin (it used to throw mid-accept,
    // leaving the deletion uncommitted in the shared checkout).
    let seeded: Record<string, string>;
    try {
      seeded = (
        JSON.parse(
          readFileSync(join(deps.repoRoot, "tests/fixtures/seed-manifest.json"), "utf8"),
        ) as { files: Record<string, string> }
      ).files;
    } catch (err) {
      return {
        ok: false,
        message: `refused: cannot read the seed manifest (${String(err instanceof Error ? err.message : err).slice(0, 120)})`,
      };
    }
    const gone = patchRemovals(patch).filter((rel) => rel in seeded);
    if (gone.length > 0)
      return {
        ok: false,
        message: `refused: patch deletes or renames seeded ${gone.join(", ")} — a seed is edited in place, never removed`,
      };
  }
  if (kind === "config") {
    const cfgViolation = configPatchViolation(patch);
    if (cfgViolation !== null) return { ok: false, message: cfgViolation };
  }
  const target: ConfigTarget = kind === "config" ? configTargetOf(deps) : { kind: "checkout" };
  if (target.kind === "unappliable")
    return {
      ok: false,
      message: `refused: the live config is ${target.path} (QCR_CONFIG), not a config.toml this patch can name — apply state/rubric/${slug}/changes.patch by hand`,
    };
  // The fence check reads the file the patch will actually land on: for a
  // config-home target that is the home's config.toml, not the checkout's.
  const fence = patchFenceViolation(patch, (rel) =>
    fenceSourceFrom(target.kind === "home" ? target.dir : deps.repoRoot, rel),
  );
  if (fence !== null) return { ok: false, message: fence };
  const sourceDir = target.kind === "home" ? target.dir : deps.repoRoot;
  const applyArgs =
    target.kind === "home" ? ["apply", "--unsafe-paths", `--directory=${target.dir}`] : ["apply"];
  try {
    await deps.git.run("git", [...applyArgs, "--check", "-"], patch);
  } catch (err) {
    return {
      ok: false,
      message: `patch does not apply cleanly: ${String(err instanceof Error ? err.message : err).slice(0, 200)}`,
    };
  }
  const shadow = await shadowApply(deps.git, patch, files, sourceDir);
  if ("message" in shadow) return { ok: false, message: shadow.message };
  const post = postImageViolation(files, shadow.before, shadow.after, kind);
  if (post !== null) return { ok: false, message: post };
  if (target.kind === "home") {
    // The config home is not this repo: applied in place, nothing to commit.
    try {
      await deps.git.run("git", [...applyArgs, "-"], patch);
    } catch (err) {
      return {
        ok: false,
        message: `apply failed — ${target.path} may need manual attention: ${String(err instanceof Error ? err.message : err).slice(0, 200)}`,
      };
    }
    return finishAccept(
      deps.repoRoot,
      slug,
      `accepted '${slug}': applied to ${target.path} (the install's config home — not committed)`,
    );
  }
  // The shared checkout is the companion's desk (rule 11): a target, or a
  // bookkeeping file, with uncommitted edits would have those edits folded
  // into this commit — and, for a seed, hashed into the ratification.
  const touches = [
    ...files,
    ...(kind === "rubric"
      ? [
          ...files.map((rel) => `seeds/${rel}`),
          "tests/fixtures/seed-manifest.json",
          "tests/fixtures/ratified-divergence.json",
        ]
      : []),
  ];
  try {
    const dirty = (
      await deps.git.run("git", [
        "status",
        "--porcelain",
        "--untracked-files=all",
        "--",
        ...touches,
      ])
    ).trim();
    if (dirty.length > 0)
      return {
        ok: false,
        message: `refused: uncommitted changes in the proposal's files — commit or wait for them first: ${dirty.split("\n").join("; ").slice(0, 200)}`,
      };
  } catch (err) {
    return {
      ok: false,
      message: `refused: cannot read the checkout's status: ${String(err instanceof Error ? err.message : err).slice(0, 200)}`,
    };
  }
  try {
    await deps.git.run("git", ["apply", "-"], patch);
    // config.toml is never a seeded file, so ratification bookkeeping is a
    // rubric-only concern (recordRatification would no-op anyway; skipping it
    // keeps the config path from ever reading the seed fixtures).
    const ratified =
      kind === "rubric" ? recordRatification(deps.repoRoot, files, slug, deps.today()) : [];
    const toAdd = [
      ...files,
      ...ratified.map((rel) => `seeds/${rel}`),
      ...(ratified.length > 0
        ? ["tests/fixtures/seed-manifest.json", "tests/fixtures/ratified-divergence.json"]
        : []),
    ];
    await deps.git.run("git", ["add", "--", ...toAdd]);
    const subject =
      kind === "config"
        ? `config: accept '${slug}' — applied by the owner via TUI`
        : `rubric: accept '${slug}' — ratified by the owner via TUI`;
    // `--only` with the paths: the commit is exactly this proposal. Anything
    // else already staged in the shared checkout stays staged, uncommitted.
    await deps.git.run("git", ["commit", "-m", subject, "--only", "--", ...toAdd]);
  } catch (err) {
    return {
      ok: false,
      message: `apply/commit failed — repo may need manual attention: ${String(err instanceof Error ? err.message : err).slice(0, 200)}`,
    };
  }
  return finishAccept(
    deps.repoRoot,
    slug,
    `accepted '${slug}': ${files.join(", ")} — committed locally; deploy to ship`,
  );
}

/**
 * Apply the patch with git to a throwaway copy of its targets and return both
 * images — git's own placement, never a re-implementation of it. The copy
 * lives in the OS temp dir and is always removed. A patch that does not apply
 * to the copy is refused (it passed `--check` against the same bytes, so this
 * is a race with a concurrent edit).
 */
async function shadowApply(
  git: LocalGit,
  patch: string,
  files: string[],
  sourceDir: string,
): Promise<
  { before: Map<string, string | null>; after: Map<string, string | null> } | { message: string }
> {
  const read = (dir: string, rel: string): string | null => {
    try {
      return readFileSync(join(dir, rel), "utf8");
    } catch {
      return null;
    }
  };
  const shadow = mkdtempSync(join(tmpdir(), "qcr-proposal-"));
  try {
    const before = new Map<string, string | null>();
    for (const rel of files) {
      const content = read(sourceDir, rel);
      before.set(rel, content);
      if (content !== null) {
        mkdirSync(dirname(join(shadow, rel)), { recursive: true });
        writeFileSync(join(shadow, rel), content);
      }
    }
    try {
      await git.run("git", ["apply", "--unsafe-paths", `--directory=${shadow}`, "-"], patch);
    } catch (err) {
      return {
        message: `patch does not apply cleanly: ${String(err instanceof Error ? err.message : err).slice(0, 200)}`,
      };
    }
    const after = new Map<string, string | null>();
    for (const rel of files) after.set(rel, read(shadow, rel));
    return { before, after };
  } finally {
    rmSync(shadow, { recursive: true, force: true });
  }
}

/** The accepted proposal's dir is removed; a failed removal is said, not fatal. */
function finishAccept(
  repoRoot: string,
  slug: string,
  message: string,
): { ok: boolean; message: string } {
  let removed = true;
  try {
    removeRubricDir(repoRoot, slug);
  } catch {
    removed = false;
  }
  return {
    ok: true,
    message: `${message}${removed ? "" : " (proposal dir removal failed — remove by hand)"}`,
  };
}
