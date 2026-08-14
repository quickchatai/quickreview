// Digest support: the EOD sweep writes digest/<date>.md; the daemon lifts its
// headline into state/status.json (the status collector's pickup surface,
//). Plus rubric-proposal helpers — rubric/<lens>-<topic>-<date>
// branches live in the SANDBOX's own local git and are NEVER pushed anywhere;
// the owner merges or deletes them by hand.
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { sandboxRoot } from "./config.js";
import type { Run } from "./improvements.js";
import type { StateStore } from "./state.js";

export const HEADLINE_MAX = 200;

export function defaultDigestDir(): string {
  return join(sandboxRoot(), "digest");
}

/** Write digest/<date>.md. Returns the path written. */
export function writeDigest(date: string, content: string, digestDir: string = defaultDigestDir()): string {
  mkdirSync(digestDir, { recursive: true });
  const path = join(digestDir, `${date}.md`);
  writeFileSync(path, content.endsWith("\n") ? content : `${content}\n`);
  return path;
}

/** First non-empty, non-heading line, trimmed and truncated to 200 chars. */
export function digestHeadline(content: string): string | undefined {
  for (const raw of content.split("\n")) {
    const line = raw.trim();
    if (!line) continue;
    if (line.startsWith("#")) continue;
    if (/^[-=]{3,}$/.test(line)) continue; // setext underline / rule
    return line.length > HEADLINE_MAX ? line.slice(0, HEADLINE_MAX) : line;
  }
  return undefined;
}

/** Newest digest/<date>.md file name (lexicographic == chronological). */
export function latestDigestFile(digestDir: string = defaultDigestDir()): string | undefined {
  if (!existsSync(digestDir)) return undefined;
  const files = readdirSync(digestDir)
    .filter((f) => /^\d{4}-\d{2}-\d{2}\.md$/.test(f))
    .sort();
  const last = files[files.length - 1];
  return last === undefined ? undefined : join(digestDir, last);
}

/** Headline of the most recent digest — what the daemon copies into status.json. */
export function latestDigestHeadline(digestDir: string = defaultDigestDir()): string | undefined {
  const path = latestDigestFile(digestDir);
  if (!path) return undefined;
  try {
    return digestHeadline(readFileSync(path, "utf8"));
  } catch {
    return undefined;
  }
}

// ---- daily usage summary -----------------------------------------

export interface DailyUsage {
  date: string;
  rounds: number;
  tokens_in: number;
  tokens_out: number;
  /** est_usd (measured) preferred; spend_usd only for pre-measurement rows. */
  est_usd: number;
}

/** Aggregate one day's measured usage from the rounds table. */
export function dailyUsage(store: StateStore, date: string): DailyUsage {
  const rounds = store.roundsOn(date);
  return {
    date,
    rounds: rounds.length,
    tokens_in: rounds.reduce((n, r) => n + (r.tokens_in ?? 0), 0),
    tokens_out: rounds.reduce((n, r) => n + (r.tokens_out ?? 0), 0),
    est_usd: rounds.reduce((n, r) => n + (r.est_usd ?? r.spend_usd ?? 0), 0),
  };
}

/** One digest-ready line, e.g. "usage: 3 rounds — 120000 in / 4000 out tokens — est $1.23". */
export function usageSummaryLine(usage: DailyUsage): string {
  return `usage: ${usage.rounds} rounds — ${usage.tokens_in} in / ${usage.tokens_out} out tokens — est $${usage.est_usd.toFixed(2)}`;
}

// ---- rubric proposals (local-only branches) --------------------------------

export function rubricBranchName(lens: string, topic: string, date: string): string {
  const clean = (s: string): string =>
    s
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "");
  return `rubric/${clean(lens)}-${clean(topic)}-${date}`;
}

/**
 * Create the local rubric proposal branch. Local only — no remote is ever
 * involved; the sweep then edits the pass agent file and adds PROPOSAL.md.
 */
export async function createRubricBranch(run: Run, lens: string, topic: string, date: string): Promise<string> {
  const branch = rubricBranchName(lens, topic, date);
  await run(["branch", branch]);
  return branch;
}

export interface PendingProposal {
  branch: string;
  hasProposal: boolean;
}

/** rubric/* branches with their PROPOSAL.md presence — the digest's "Pending proposals". */
export async function pendingProposals(run: Run): Promise<PendingProposal[]> {
  const out = await run(["branch", "--list", "rubric/*", "--format=%(refname:short)"]);
  const branches = out
    .split("\n")
    .map((l) => l.trim().replace(/^\*\s*/, ""))
    .filter((l) => l.startsWith("rubric/"));
  const proposals: PendingProposal[] = [];
  for (const branch of branches) {
    let hasProposal = false;
    try {
      const listed = await run(["ls-tree", "--name-only", branch, "PROPOSAL.md"]);
      hasProposal = listed.trim().length > 0;
    } catch {
      hasProposal = false;
    }
    proposals.push({ branch, hasProposal });
  }
  return proposals;
}
