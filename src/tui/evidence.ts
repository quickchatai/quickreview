// Finished-round evidence transport.
//
// The companion cannot reach the VM — rule 8 is structural and this ticket does
// not widen it by a byte. So the TUI, which already holds the ssh access, copies
// every finished round's artefacts DOWN to a local store, and the companion
// reads plain files out of a read-only mount. Nothing new is granted to it: no
// ssh, no credential, no network reach.
//
// Why on completion rather than on demand: on-demand transport is exactly what
// lost #5306, #5308 and #5312 — nothing was copying while they happened, so the
// three most interesting episodes have no local record at all. A round that has
// finished is a round whose evidence is already complete; waiting for someone to
// ask for it is waiting for the session to be recycled first.
//
// Shape follows remote.ts: command construction is pure so tests can assert the
// exact argv, execution goes through the one injectable SshRunner, and every
// failure degrades (logged, retried on the next poll) rather than throwing into
// the paint loop.
//
// Retention: evidence is kept indefinitely by the owner's explicit choice
// — not by omission. Do not add a TTL or a cleanup sweep.
import { existsSync, mkdirSync, readdirSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { TuiConfig } from "../config.js";
import type { StatusSnapshot } from "../state.js";
import { whyArgv, type SshRunner } from "./remote.js";

/** Roles a round bundle can carry, in copy order. `transcript` carries the pass
 * output too: lens passes run as subagent children inside the PR's one
 * session, so their output IS the session JSONL (root rule 9 — passes are
 * leaves). */
export const EVIDENCE_ROLES = ["transcript", "ledger", "prompt", "verdict"] as const;
export type EvidenceRole = (typeof EVIDENCE_ROLES)[number];

/** Local file name each role lands under. */
const LOCAL_NAME: Record<EvidenceRole, string> = {
  transcript: "session.jsonl",
  ledger: "ledger.md",
  prompt: "prompt.md",
  verdict: "verdict.json",
};

/**
 * Per-file byte cap on the remote side (`head -c`).
 *
 * A knob would be knob sprawl: this is not a tuning dial but a blast-radius
 * bound. A transcript is ~0.6 MB per session; 32 MiB is two orders of magnitude
 * of headroom and still small enough that one runaway JSONL cannot fill
 * the owner's disk or stall an ssh for minutes. A truncated file is recorded as
 * truncated in the manifest — never silently short.
 */
export const MAX_FILE_BYTES = 32 * 1024 * 1024;

/** Rounds copied per PR per sweep. Keeps a first-ever sweep over a PR with 20
 * rounds from monopolising the poll; the rest land on the following ticks. */
export const ROUNDS_PER_SWEEP = 3;

/**
 * Roles whose remote file is the PR's CURRENT one, not the round's: the ledger
 * and session-prompt live at `pr-<n>.md` and the transcript is "the newest
 * JSONL in the session dir". Copying them into `round-<k>/` is honest only for
 * a round that finished under this copier's watch — for a backlog round the
 * copy would stamp TODAY's files into an old round's dir and silently corrupt
 * the adjudication evidence. Only `verdict` is genuinely round-scoped.
 */
export const PR_CURRENT_ROLES: readonly EvidenceRole[] = ["transcript", "ledger", "prompt"];

/** Recorded verbatim in every manifest so a reader of the store never has to
 * know the copier's version to interpret what it holds. */
export const ROLES_NOTE =
  "transcript, ledger and prompt are the PR's CURRENT files at copy time (scope: pr-current), not artefacts of this round; only verdict.json is round-scoped. Rounds that finished before this copier first saw the PR carry those roles under skipped_stale instead of a misleading copy.";

export interface EvidenceFile {
  role: EvidenceRole;
  /** Absolute path INSIDE the container, as the VM reported it. */
  remotePath: string;
}

/** One round's record, written last so its presence means "fully copied". */
export interface RoundManifest {
  pr: number;
  round_no: number;
  copied_at: string;
  round: unknown;
  /** `ROLES_NOTE`: which roles are round-scoped and which are pr-current. */
  roles_note: string;
  files: Array<{
    role: EvidenceRole;
    remote_path: string;
    chars: number;
    truncated: boolean;
    /** "round" = this file belongs to this round; "pr-current" = this is the
     * PR's file AS OF COPY TIME (honest only because the round finished under
     * this copier's watch). */
    scope: "round" | "pr-current";
  }>;
  /** Listed on the VM but absent at copy time. */
  missing: EvidenceRole[];
  /** PR-current roles deliberately NOT copied: the round finished before this
   * copier first saw the PR, so the current ledger/prompt/transcript would be
   * stamped into an old round's dir as if they were its own. */
  skipped_stale: EvidenceRole[];
}

export const MANIFEST_NAME = "manifest.json";

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

/**
 * Locate a round's artefacts on the VM in ONE call, printing `role<space>path`
 * for each that exists.
 *
 * Resolution is done remotely on purpose: the transcript is "the newest JSONL in
 * the session dir" and the verdict may be either still in `verdict/` or already
 * moved to `verdict/processed/<ts>-…` by the watcher. Guessing either one
 * client-side would produce a copier that works until the daemon moves a file.
 *
 * Ends `exit 0`: a trailing `[ -f … ] && echo` that finds nothing would
 * otherwise exit non-zero and make an entirely successful listing look failed.
 */
export function manifestArgv(
  cfg: TuiConfig,
  sessionDir: string,
  pr: number,
  round: number,
): string[] {
  const root = cfg.remote_sandbox_root;
  const script = [
    `r="${root}"`,
    `t=$(ls -1t "$r/${sessionDir}/pr-${pr}"/*.jsonl 2>/dev/null | head -1)`,
    `[ -n "$t" ] && echo "transcript $t"`,
    `[ -f "$r/state/ledgers/pr-${pr}.md" ] && echo "ledger $r/state/ledgers/pr-${pr}.md"`,
    `[ -f "$r/state/session-prompts/pr-${pr}.md" ] && echo "prompt $r/state/session-prompts/pr-${pr}.md"`,
    `v=$(ls -1t "$r/verdict/pr-${pr}-round-${round}.json" "$r"/verdict/processed/*pr-${pr}-round-${round}.json 2>/dev/null | head -1)`,
    `[ -n "$v" ] && echo "verdict $v"`,
    `exit 0`,
  ].join("\n");
  return dockerSh(cfg, script);
}

/**
 * Parse the listing, refusing any path that is not plainly inside the sandbox
 * root and plainly shell-safe. The VM answers here become the next command's
 * argument, so this is the trust boundary — a path is data, never a fragment of
 * script.
 */
export function parseManifest(stdout: string, root: string): EvidenceFile[] {
  const out: EvidenceFile[] = [];
  const seen = new Set<string>();
  for (const line of stdout.split("\n")) {
    const sp = line.indexOf(" ");
    if (sp <= 0) continue;
    const role = line.slice(0, sp).trim() as EvidenceRole;
    const remotePath = line.slice(sp + 1).trim();
    if (!(EVIDENCE_ROLES as readonly string[]).includes(role) || seen.has(role)) continue;
    if (!remotePath.startsWith(`${root}/`) || !/^[\w./@:+-]+$/.test(remotePath)) continue;
    seen.add(role);
    out.push({ role, remotePath });
  }
  return out;
}

/** `head -c <cap>` one artefact. Every artefact is text (JSONL / Markdown /
 * JSON), so the string the runner returns is the file — no base64 hop, and no
 * dependency on tar being present in the image. */
export function fetchArgv(cfg: TuiConfig, remotePath: string, maxBytes = MAX_FILE_BYTES): string[] {
  return dockerSh(cfg, `head -c ${maxBytes} '${remotePath}'`);
}

/** The round rows `qcr why --json` reports; only the fields the copier reads. */
export interface WhyRound {
  round_no: number;
  status: string;
  verdict: string | null;
  finished_at: string | null;
  [k: string]: unknown;
}

/**
 * A round is COPYABLE once it is no longer running. `done` is the common case;
 * `expired`, `overdue` and `cancelled` are copied too — a round that died is
 * precisely the episode worth having a local record of, and refusing them would
 * reproduce the gap this ticket exists to close.
 */
export function finishedRounds(rounds: WhyRound[]): WhyRound[] {
  return rounds
    .filter((r) => r.status !== "running" && Number.isInteger(r.round_no))
    .sort((a, b) => a.round_no - b.round_no);
}

/** The finished rounds out of one `qcr why --json` answer, or `undefined`
 * when the answer does not carry a round list at all. `[]` is reserved for a
 * payload that SAID there are no rounds; a payload that said nothing about
 * rounds is not that. */
export function readWhyRounds(stdout: string): WhyRound[] | undefined {
  let parsed: unknown;
  try {
    parsed = JSON.parse(stdout);
  } catch {
    return undefined;
  }
  if (typeof parsed !== "object" || parsed === null) return undefined;
  const rounds = (parsed as { rounds?: unknown }).rounds;
  return Array.isArray(rounds) ? finishedRounds(rounds as WhyRound[]) : undefined;
}

/** Cheap "has anything changed for this PR" key, read off the poll snapshot the
 * TUI already fetches. Unchanged ⇒ no `why` call at all, so the steady state
 * costs the copier ZERO extra ssh. */
export function prSignature(pr: StatusSnapshot["prs"][number]): string {
  return `${pr.rounds ?? 0}/${pr.last_verdict ?? ""}/${pr.state}/${pr.head_sha}`;
}

/** The local store: one dir per PR, one dir per round, manifest written last. */
export class EvidenceStore {
  constructor(readonly dir: string) {}

  ensure(): void {
    mkdirSync(this.dir, { recursive: true });
  }

  roundDir(pr: number, round: number): string {
    return join(this.dir, `pr-${pr}`, `round-${round}`);
  }

  /**
   * Idempotence, and the whole of it: the manifest is written last, atomically,
   * so its presence means every artefact for that round already landed. A
   * crashed half-copy leaves no manifest and is simply redone — files are
   * overwritten in place, never appended, so a retry cannot duplicate anything.
   */
  has(pr: number, round: number): boolean {
    return existsSync(join(this.roundDir(pr, round), MANIFEST_NAME));
  }

  /** Round numbers already copied for a PR (used only for reporting). */
  copiedRounds(pr: number): number[] {
    const dir = join(this.dir, `pr-${pr}`);
    if (!existsSync(dir)) return [];
    return readdirSync(dir)
      .map((d) => /^round-(\d+)$/.exec(d)?.[1])
      .filter((n): n is string => n !== undefined)
      .map(Number)
      .filter((n) => this.has(pr, n))
      .sort((a, b) => a - b);
  }

  writeArtifact(pr: number, round: number, role: EvidenceRole, body: string): void {
    const dir = this.roundDir(pr, round);
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, LOCAL_NAME[role]), body);
  }

  writeManifest(m: RoundManifest): void {
    const dir = this.roundDir(m.pr, m.round_no);
    mkdirSync(dir, { recursive: true });
    const target = join(dir, MANIFEST_NAME);
    const tmp = `${target}.tmp`;
    writeFileSync(tmp, `${JSON.stringify(m, null, 2)}\n`);
    renameSync(tmp, target); // atomic: a reader never sees a half-written marker
  }
}

export interface CopierDeps {
  /** Relative session dir inside the sandbox root (`[pi] session_dir`). */
  sessionDir: string;
  /** How long any single remote read may take before it is killed. */
  timeoutMs: number;
  onNotice?: (text: string) => void;
  now?: () => Date;
}

export interface SweepReport {
  /** `pr-<n> round <k>` for each round that landed this sweep. */
  copied: string[];
  /** Human note for a PR whose copy could not complete (retried next poll). */
  failures: string[];
}

/**
 * The copier itself. Driven from the TUI's existing poll — there is deliberately
 * no second scheduler and no timer of its own: `sweep()` is called by the poll
 * hook, never awaited by it, and a sweep already in flight makes the next call a
 * no-op, so a wedged ssh can stall this and nothing else.
 */
export class EvidenceCopier {
  private busy = false;
  /** Last snapshot signature per PR that was fully reconciled. */
  private readonly reconciled = new Map<number, string>();
  /** When THIS copier first saw each PR (ms since epoch). A round that
   * finished before that moment is a BACKFILL: its pr-current roles (ledger,
   * prompt, transcript) are skipped rather than stamped in as if today's
   * files were that round's — only verdict.json is copied. In-memory on
   * purpose: after a TUI restart everything already copied has a manifest,
   * and anything not yet copied is honestly "first seen now". */
  private readonly firstSeen = new Map<number, number>();
  /** Rounds whose failure has already been announced — so a VM that stays
   * unreachable degrades to silence rather than a notice every 3 seconds. */
  private readonly announced = new Set<string>();

  constructor(
    private readonly cfg: TuiConfig,
    readonly store: EvidenceStore,
    private readonly ssh: SshRunner,
    private readonly deps: CopierDeps,
  ) {}

  /** True while a sweep is in flight (the poll hook's re-entry guard). */
  get running(): boolean {
    return this.busy;
  }

  /**
   * One pass over the poll snapshot. Never throws: a failure is a note in the
   * report and a retry on the next poll, because a TUI that cannot copy
   * evidence is a TUI that must still paint.
   */
  async sweep(snapshot: StatusSnapshot | undefined): Promise<SweepReport> {
    const report: SweepReport = { copied: [], failures: [] };
    if (!snapshot || this.busy) return report;
    this.busy = true;
    try {
      this.store.ensure();
      const nowMs = (this.deps.now?.() ?? new Date()).getTime();
      for (const pr of snapshot.prs)
        if (!this.firstSeen.has(pr.number)) this.firstSeen.set(pr.number, nowMs);
      for (const pr of [...snapshot.prs].sort((a, b) => a.number - b.number)) {
        const sig = prSignature(pr);
        if (this.reconciled.get(pr.number) === sig) continue;
        if ((pr.rounds ?? 0) === 0) {
          this.reconciled.set(pr.number, sig);
          continue;
        }
        const before = report.copied.length;
        const ok = await this.reconcilePr(pr.number, report);
        // Only a clean reconcile retires the signature; anything else is
        // retried on the next poll, which is what "survives a wedged ssh"
        // means here.
        if (ok) this.reconciled.set(pr.number, sig);
        // Successful work is bounded to one PR per sweep: the poll runs every
        // few seconds and a backlog drains across ticks without ever holding
        // the loop. A FAILURE does not consume the sweep — a failed PR keeps
        // its stale signature, so stopping on it would make one permanently
        // failing PR the first pick every tick and starve all the others
        // forever. Move on to the next PR instead.
        if (ok || report.copied.length > before) break;
      }
    } catch (err) {
      report.failures.push(`evidence sweep failed: ${msg(err)}`);
    } finally {
      this.busy = false;
    }
    for (const note of report.copied) this.deps.onNotice?.(note);
    for (const note of report.failures) this.deps.onNotice?.(note);
    return report;
  }

  private async reconcilePr(pr: number, report: SweepReport): Promise<boolean> {
    const res = await this.ssh(this.cfg.ssh_host, whyArgv(this.cfg, pr), {
      timeoutMs: this.deps.timeoutMs,
    });
    if (!res.ok)
      return this.fail(report, `pr-${pr}`, `evidence: #${pr} — could not read round list (ssh)`);
    // The round list is what `qcr why --json` PROVES; anything else that came
    // back — a wrapper's own JSON, an older build's shape, a torn write — is an
    // unreadable list, not an empty one. Reading it as empty would retire this
    // PR's signature with nothing copied, and nothing would ever retry it
    //.
    const rounds = readWhyRounds(res.stdout);
    if (rounds === undefined)
      return this.fail(report, `pr-${pr}`, `evidence: #${pr} — unreadable round list`);
    const pending = rounds.filter((r) => !this.store.has(pr, r.round_no));
    if (pending.length === 0) return true;
    let complete = true;
    for (const round of pending.slice(0, ROUNDS_PER_SWEEP)) {
      const done = await this.copyRound(pr, round, report);
      if (!done) {
        complete = false;
        break; // the VM is unhappy; stop hammering it this tick
      }
    }
    return complete && pending.length <= ROUNDS_PER_SWEEP;
  }

  private async copyRound(pr: number, round: WhyRound, report: SweepReport): Promise<boolean> {
    const key = `pr-${pr} round ${round.round_no}`;
    const listed = await this.ssh(
      this.cfg.ssh_host,
      manifestArgv(this.cfg, this.deps.sessionDir, pr, round.round_no),
      {
        timeoutMs: this.deps.timeoutMs,
      },
    );
    if (!listed.ok)
      return this.fail(report, key, `evidence: ${key} — could not list artefacts (ssh)`);
    const files = parseManifest(listed.stdout, this.cfg.remote_sandbox_root);
    // A round that finished before this copier first saw the PR is a BACKFILL:
    // the pr-current roles on the VM are the PR's files as of TODAY, not that
    // round's, so copying them would fabricate round evidence. Verdict only.
    // An unparseable/absent finished_at is treated as backfill — the honest
    // direction, since freshness cannot be shown.
    const firstSeenAt = this.firstSeen.get(pr) ?? 0;
    const finishedMs = round.finished_at === null ? NaN : Date.parse(round.finished_at);
    const backfill = !Number.isFinite(finishedMs) || finishedMs < firstSeenAt;
    const skipped = backfill ? PR_CURRENT_ROLES.filter((r) => files.some((f) => f.role === r)) : [];
    const toCopy = backfill ? files.filter((f) => f.role === "verdict") : files;
    const written: RoundManifest["files"] = [];
    for (const f of toCopy) {
      const got = await this.ssh(this.cfg.ssh_host, fetchArgv(this.cfg, f.remotePath), {
        timeoutMs: this.deps.timeoutMs,
      });
      // An ssh that failed is a transport fault, not an absent artefact: leaving
      // the manifest unwritten is what makes the round come back next poll.
      if (!got.ok) return this.fail(report, key, `evidence: ${key} — ${f.role} fetch failed`);
      this.store.writeArtifact(pr, round.round_no, f.role, got.stdout);
      written.push({
        role: f.role,
        remote_path: f.remotePath,
        chars: got.stdout.length,
        truncated: got.stdout.length >= MAX_FILE_BYTES,
        scope: PR_CURRENT_ROLES.includes(f.role) ? "pr-current" : "round",
      });
    }
    this.store.writeManifest({
      pr,
      round_no: round.round_no,
      copied_at: (this.deps.now?.() ?? new Date()).toISOString(),
      round,
      roles_note: ROLES_NOTE,
      files: written,
      missing: EVIDENCE_ROLES.filter(
        (r) => !written.some((w) => w.role === r) && !skipped.includes(r),
      ),
      skipped_stale: skipped,
    });
    this.announced.delete(key);
    report.copied.push(
      `evidence: ${key} copied (${written.length} file${written.length === 1 ? "" : "s"})`,
    );
    return true;
  }

  /** Announce a failure once, then stay quiet until that round succeeds. */
  private fail(report: SweepReport, key: string, text: string): false {
    if (!this.announced.has(key)) {
      this.announced.add(key);
      report.failures.push(text);
    }
    return false;
  }
}

function msg(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
