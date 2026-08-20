// Proposals half of the Memory & learning tab (§7/§8).
//
// Three proposal kinds surface here:
//   * Rubric proposals — the EOD sweep drafts them as `state/rubric/<slug>/`
//     dirs on the VM (PROPOSAL.md + changes.patch; the VM sandbox has no git
//     repo, so the branch form the original seed described is impossible —
//     the reseeded eod-sweep.md matches this carrier). Accept/reject verdicts
//     are the owner's, delivered as TUI keystrokes.
//   * Bot-filed improvement PRs (`bot/improve-*`) and issues (`bot-filed`
//     label) on the reviewed repo — status via a live in-container `gh` READ
//     (reads are direct per the gate rules; the mint-token credential).
//
// ACCEPT = merge + auto-ratify (ratified decision): the click IS the
// ratification. The patch is applied to the CANONICAL repo (this working
// copy — the VM copy is an rsync target and would be clobbered by the next
// deploy), the seed manifest hash is re-pinned, the ratification is appended
// to tests/fixtures/ratified-divergence.json, and the lot is committed. The
// VM proposal dir is then removed. REJECT removes the dir and records a
// #rejected-proposal memory entry so the sweep never re-proposes it.
import { createHash } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { TuiConfig } from "../config.js";
import type { SshRunner } from "./remote.js";

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

function dockerSh(cfg: TuiConfig, script: string): string[] {
  return [...(cfg.sudo_docker ? ["sudo"] : []), "docker", "exec", cfg.container, "sh", "-c", script];
}

export function rubricListArgv(cfg: TuiConfig): string[] {
  return dockerSh(cfg, `ls '${cfg.remote_sandbox_root}/state/rubric' 2>/dev/null || true`);
}

export function rubricReadArgv(cfg: TuiConfig, slug: string, file: "PROPOSAL.md" | "changes.patch"): string[] {
  if (!validSlug(slug)) throw new Error(`bad rubric slug '${slug}'`);
  return dockerSh(cfg, `head -c 65536 '${cfg.remote_sandbox_root}/state/rubric/${slug}/${file}'`);
}

/** The ONLY remote mutation this module performs — removing a decided
 * proposal dir. Slug-validated, path fixed under state/rubric. */
export function rubricRemoveArgv(cfg: TuiConfig, slug: string): string[] {
  if (!validSlug(slug)) throw new Error(`bad rubric slug '${slug}'`);
  return dockerSh(cfg, `rm -rf '${cfg.remote_sandbox_root}/state/rubric/${slug}'`);
}

/** Bot-filed improvement PRs + issues, one in-container gh read. gh's exit
 * code is ignored per list (a missing label must not blank the other list). */
export function improvementsArgv(cfg: TuiConfig, repo: string): string[] {
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

export function parseRubricList(stdout: string): string[] {
  return stdout
    .split("\n")
    .map((l) => l.trim())
    .filter((l) => l.length > 0 && validSlug(l))
    .sort();
}

// ---- accept = merge + auto-ratify (local, canonical repo) -----------------

export interface LocalGit {
  /** Run a command in the repo root; returns stdout, throws on failure. */
  run(cmd: string, args: string[], stdin?: string): Promise<string>;
}

/** Paths a rubric patch may touch — pass rubrics and prompts, nothing else.
 * A proposal reaching for src/ or scripts/ is not a rubric change and is
 * refused outright. */
export function patchTargets(patch: string): string[] {
  const files = new Set<string>();
  for (const m of patch.matchAll(/^\+\+\+ (?:b\/)?(\S+)/gm)) {
    if (m[1] !== "/dev/null") files.add(m[1]!);
  }
  return [...files].sort();
}

export function targetsAllowed(files: string[]): boolean {
  return files.length > 0 && files.every((f) => f.startsWith("agents/") || f.startsWith("prompts/"));
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
  cfg: TuiConfig;
  ssh: SshRunner;
  git: LocalGit;
  repoRoot: string;
  today: () => string; // YYYY-MM-DD
}

export async function acceptProposal(deps: AcceptDeps, slug: string): Promise<{ ok: boolean; message: string }> {
  if (!validSlug(slug)) return { ok: false, message: `bad slug '${slug}'` };
  const res = await deps.ssh(deps.cfg.ssh_host, rubricReadArgv(deps.cfg, slug, "changes.patch"));
  if (!res.ok || res.stdout.trim().length === 0) return { ok: false, message: `no changes.patch for '${slug}'` };
  const patch = res.stdout;
  const files = patchTargets(patch);
  if (!targetsAllowed(files)) return { ok: false, message: `refused: patch touches non-rubric paths (${files.join(", ") || "none"})` };
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
  const rm = await deps.ssh(deps.cfg.ssh_host, rubricRemoveArgv(deps.cfg, slug));
  return {
    ok: true,
    message: `accepted '${slug}': ${files.join(", ")} — committed locally; deploy to ship${rm.ok ? "" : " (VM dir removal failed — remove by hand)"}`,
  };
}
