// Carry the review history digest from the VM to the PC's state home.
//
// The VM daemon reads the history (it holds the App credential —
// `src/reviewhistory.ts`) and PRINTS the digest; this is the one place that
// digest lands: `<state home>/setup/review-history.json`, 0600 in a 0700
// directory, tmp+rename atomic. Nothing else is written, anywhere: the VM keeps
// no copy, and the companion — which mounts the state home — condenses it into
// themes there (`src/setup/history.ts`). The raw comments are colleagues' names
// and words; the state home is PC-only and never shipped.
//
// The operator starts it — `qcr history pull` on the PC, over the TUI's route
// (`[tui] target`: ssh to the VM, or local docker). Deliberately not a
// companion action: the companion holds no VM credentials, and the TUI does
// not fetch on its behalf (rule 8; `prompts/companion.md` "They read; they
// never fetch"). It asks the operator to run this, then reads the file.
import { mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import type { TuiConfig } from "../config.js";
import { parseDigest, type ReviewHistoryDigest } from "../reviewhistory.js";
import { HISTORY_DIGEST_FILE } from "../setup/history.js";
import { writePrivateAtomic } from "./ghread.js";
import { historyDigestArgv, type SshRunner } from "./remote.js";

/** The VM reads one GraphQL query per merged PR at the backfill's gentle
 * concurrency — six months of a busy repo takes minutes, not seconds. */
export const HISTORY_PULL_TIMEOUT_MS = 30 * 60_000;

export interface HistoryPullDeps {
  tui: TuiConfig;
  ssh: SshRunner;
  /** The install's state home on THIS machine. */
  stateHome: string;
  /** The repo this install reviews — a digest about another repo is refused. */
  repo: string;
  months?: number;
  log?: (line: string) => void;
}

export type HistoryPullResult =
  { ok: true; path: string; digest: ReviewHistoryDigest } | { ok: false; reason: string };

/** One line an operator (or the notice line) can read. */
export function describeDigest(d: ReviewHistoryDigest): string {
  const partial = d.problems.length > 0 ? ` · ${d.problems.length} problem(s), partial` : "";
  return (
    `${d.human.comments.length} human review comments on ${d.human.prs_scanned} merged PRs since ${d.window.since.slice(0, 10)}` +
    `${d.human.truncated ? " (capped)" : ""} · ${d.rounds.length} own rounds · ${d.feedback.length} feedback signals${partial}`
  );
}

export async function pullReviewHistory(deps: HistoryPullDeps): Promise<HistoryPullResult> {
  const log = deps.log ?? ((): void => {});
  log(
    `history: reading the review history on ${deps.tui.target === "local" ? "this machine" : deps.tui.ssh_host} (minutes on a busy repo)…`,
  );
  const res = await deps.ssh(deps.tui.ssh_host, historyDigestArgv(deps.tui, deps.months), {
    timeoutMs: HISTORY_PULL_TIMEOUT_MS,
  });
  if (!res.ok) {
    const why = res.stderr.trim().split("\n").filter(Boolean).at(-1) ?? `exit ${res.code ?? "?"}`;
    return { ok: false, reason: `the VM could not produce the digest: ${why}` };
  }
  const parsed = parseDigest(res.stdout);
  if (!parsed.ok)
    return { ok: false, reason: `the VM printed something that is not a digest (${parsed.error})` };
  if (parsed.digest.repo !== deps.repo) {
    return {
      ok: false,
      reason: `the digest is about ${parsed.digest.repo}, but this install reviews ${deps.repo} — nothing written`,
    };
  }
  const path = join(deps.stateHome, HISTORY_DIGEST_FILE);
  try {
    mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
    writePrivateAtomic(path, `${JSON.stringify(parsed.digest, null, 2)}\n`);
  } catch (err) {
    return { ok: false, reason: `could not write ${path}: ${String(err)}` };
  }
  log(`history: ${describeDigest(parsed.digest)} → ${path}`);
  return { ok: true, path, digest: parsed.digest };
}
