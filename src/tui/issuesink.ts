// The pluggable issue sink: where auto-filed defect flags land.
//
// One seam in the MemoryStore style: every method is total (a broken backend
// is a refusal-as-answer, never a throw — the TUI poll loop must survive any
// sink), and the kinds are a closed set chosen by `[sink] kind` in
// config.toml:
//
//   * `wayfinder` — the auto-filer in src/tui/autofile.ts: tickets into a
//     local filesystem tracker, with the effort/parent carried by config.
//   * `github`    — defects filed as issues on the reviewed repo. The TUI has
//     no MutationGate and must never grow one, so this sink executes nothing
//     itself: it writes a `file-issue` command file into the daemon's
//     operator command channel, commands/operator/ (the same ssh idiom as src/tui/unwedge.ts)
//     and reads back the daemon's verdict. The daemon's whitelist re-validates
//     the payload, and `fileIssue` (src/improvements.ts) enforces the day cap,
//     the jaccard title dedup and the bot label behind the one gate — in
//     dry-run the gate writes an intent instead of creating anything.
//   * `none`      — clean off. `SinkReport` is always `{ filed: [] }`.
//
// Dedup discipline is shared: every sink checks the entry's own `filed=` tag
// first and stamps it back through the injected MemoryStore only after the
// filing exists on the other side, so a crash between the two costs a
// re-check, never a lost filing. The backstop differs per sink — wayfinder
// scans ticket `Memory-key:` lines, github leans on the daemon's title dedup
// (the re-filed duplicate is refused, not doubled).
import { validateCommand } from "../commands.js";
import type { Config, IssueSinkKind, TuiConfig } from "../config.js";
import { sinkTicketsEffort } from "../config.js";
import {
  autofileDefects,
  filedAs,
  MEMORY_KEY_LINE,
  memoryKey,
  withFiledTag,
  type TrackerPaths,
} from "./autofile.js";
import { refOf, type MemoryEntry, type MemoryStore } from "./memory.js";
import type { SshRunner } from "./remote.js";
import { commandFileName, commandResultArgv, commandWriteArgv, resultReason } from "./unwedge.js";

/** One filing the sink performed: `id` is the human handle ("FT-0123",
 * "#456", "dry-run intent"), `key` the entry's stable dedup key. */
export interface SinkFiled {
  id: string;
  key: string;
}

/** A sink's total answer. `refused` carries the FIRST refusal reason of the
 * batch (a cap, a dead channel) — filings before it still count. */
export interface SinkReport {
  filed: SinkFiled[];
  refused?: string;
}

/** The seam. `file` takes the CURRENT defect set (already filtered to
 * defect-tagged entries by the caller) and files whatever is not yet filed. */
export interface IssueSink {
  readonly kind: IssueSinkKind;
  file(defects: MemoryEntry[], nowIso: string): Promise<SinkReport>;
}

/** `none`: auto-filing is off, and off is inert — no reads, no writes. */
export class NoneIssueSink implements IssueSink {
  readonly kind = "none" as const;
  file(): Promise<SinkReport> {
    return Promise.resolve({ filed: [] });
  }
}

/** The filesystem wayfinder tracker — a thin adapter over the auto-filer,
 * so the ticket format, the id claim, the crash-safe order and the
 * quiet-skip on an unavailable tracker are exactly autofile.ts's. */
export class WayfinderIssueSink implements IssueSink {
  readonly kind = "wayfinder" as const;

  constructor(
    private readonly paths: TrackerPaths,
    private readonly store?: MemoryStore,
  ) {}

  async file(defects: MemoryEntry[], nowIso: string): Promise<SinkReport> {
    const filed = await autofileDefects(this.paths, defects, nowIso, this.store);
    return { filed: filed.map((f) => ({ id: f.ticketId, key: f.key })) };
  }
}

/** Header-stripped prose of an entry — tags and `k=v` tokens are not title
 * material (same token grammar `withFiledTag` uses to find the header end). */
export function issueTitleFor(e: MemoryEntry): string {
  const prose = e.text
    .split(/\s+/)
    .filter(
      (t) =>
        t !== "" &&
        !t.startsWith("#") &&
        !/^[a-z][a-z0-9_-]*=[^\s]+$/.test(t) &&
        !/^\[\[[^\]]*\]\]$/.test(t),
    )
    .join(" ");
  const head = (prose || "memory defect").slice(0, 90).trim();
  return `Auto-filed defect: ${head}`;
}

/** The issue body mirrors the wayfinder ticket: provenance line, the
 * `Memory-key:` backstop (searchable if the `filed=` stamp is ever refused),
 * then the flagged entry verbatim. */
export function issueBodyFor(e: MemoryEntry): string {
  return `The reviewer's overseer flagged an operational defect in the review system (memory entry ${e.id} @ ${e.ts}, auto-filed by the TUI). Diagnose, fix, and close — or close as duplicate/stale with a note.

${MEMORY_KEY_LINE} ${memoryKey(e)}

## Flagged entry

${e.text}
`;
}

type FileOneOutcome = { ok: true; id: string; stamp: string } | { ok: false; reason: string };

/**
 * GitHub issues via the daemon's command channel. Where this executes is the
 * point: the filer runs PC-side in the TUI, which holds no GitHub credential
 * and no gate — so the sink's only write is a command file, validated here
 * against the daemon's own `validateCommand` before it is ever sent, and
 * re-validated, tier-checked, capped and gated daemon-side. The TUI inherits
 * the `local`-dir belt exactly like unwedge does, instead of bypassing it.
 */
export class GithubIssueSink implements IssueSink {
  readonly kind = "github" as const;
  private seq = 0;

  constructor(
    private readonly cfg: TuiConfig,
    private readonly ssh: SshRunner,
    private readonly store?: MemoryStore,
    private readonly now: () => Date = () => new Date(),
    private readonly sleep: (ms: number) => Promise<void> = (ms) =>
      new Promise((r) => setTimeout(r, ms)),
  ) {}

  async file(defects: MemoryEntry[], _nowIso: string): Promise<SinkReport> {
    const filed: SinkFiled[] = [];
    let refused: string | undefined;
    for (const e of defects) {
      if (filedAs(e) !== undefined) continue;
      let outcome: FileOneOutcome;
      try {
        outcome = await this.fileOne(e);
      } catch (err) {
        outcome = { ok: false, reason: `issue channel failed: ${(err as Error).message}` };
      }
      if (!outcome.ok) {
        refused = refused ?? outcome.reason;
        continue;
      }
      filed.push({ id: outcome.id, key: memoryKey(e) });
      // Best-effort stamp, after the daemon's receipt — same crash-safe order
      // as the wayfinder filer. A refused stamp costs a re-check next tick,
      // where the daemon's title dedup refuses the duplicate.
      if (this.store) {
        try {
          await this.store.apply({
            op: "edit",
            ...refOf(e),
            text: withFiledTag(e.text, outcome.stamp),
          });
        } catch {
          /* the seam resolves refusals; only a broken transport lands here */
        }
      }
    }
    return refused === undefined ? { filed } : { filed, refused };
  }

  private async fileOne(e: MemoryEntry): Promise<FileOneOutcome> {
    const payload = { command: "file-issue", title: issueTitleFor(e), body: issueBodyFor(e) };
    // The daemon's own schema, checked before anything leaves this process:
    // this module can never produce a command the whitelist would not accept.
    const valid = validateCommand(payload);
    if (!valid.ok) return { ok: false, reason: `refused locally: ${valid.reason}` };
    const name = commandFileName(this.now(), this.seq++);
    const write = await this.ssh(this.cfg.ssh_host, commandWriteArgv(this.cfg, name), {
      stdin: `${JSON.stringify(payload, null, 2)}\n`,
    });
    if (!write.ok) return { ok: false, reason: "command write failed (ssh unreachable?)" };
    // Read the daemon's verdict, not the write's: a cap or dedup refusal is a
    // real answer, and only a receipt may stamp the entry as filed.
    const deadline = this.now().getTime() + this.cfg.msg_timeout_s * 1000;
    while (this.now().getTime() < deadline) {
      await this.sleep(2000);
      const probe = await this.ssh(this.cfg.ssh_host, commandResultArgv(this.cfg, name));
      if (!probe.ok) continue;
      const body = probe.stdout.trim();
      if (body === "pending" || body === "") continue;
      let result: { ok?: unknown; reason?: unknown; issue?: unknown };
      try {
        result = JSON.parse(body) as typeof result;
      } catch {
        return { ok: false, reason: "unreadable daemon result" };
      }
      if (result.ok !== true)
        return { ok: false, reason: resultReason(result.reason, "refused, no reason given") };
      const issue = typeof result.issue === "number" && result.issue > 0 ? result.issue : null;
      // Dry-run leaves no issue number, but the intent is on record (the
      // gate's dryrun/ file plus the day-cap row) — so the entry is stamped
      // anyway: re-filing the same defect every refresh would burn the cap on
      // rehearsal duplicates.
      return issue !== null
        ? { ok: true, id: `#${issue}`, stamp: `#${issue}` }
        : { ok: true, id: "dry-run intent", stamp: "dry-run" };
    }
    return { ok: false, reason: "no daemon result before the deadline" };
  }
}

/** The configured sink. The wayfinder guard is a belt — parseConfig already
 * refuses a wayfinder sink missing its root/effort/parent. */
export function buildIssueSink(full: Config, ssh: SshRunner, store?: MemoryStore): IssueSink {
  switch (full.sink.kind) {
    case "github":
      return new GithubIssueSink(full.tui, ssh, store);
    case "wayfinder": {
      const { root, effort, parent } = full.sink;
      if (!root || !effort || !parent) return new NoneIssueSink();
      return new WayfinderIssueSink({ root, effort, parent }, store);
    }
    case "none":
      return new NoneIssueSink();
  }
}

/** Where the TUI's read-only ticket projection reads from, or undefined when
 * no effort is configured. The root falls back to the companion's tracker
 * mount. */
export function ticketProjection(full: Config): { root: string; effort: string } | undefined {
  const effort = sinkTicketsEffort(full);
  const root = full.sink.root || full.companion.tracker_dir;
  return effort && root ? { root, effort } : undefined;
}
