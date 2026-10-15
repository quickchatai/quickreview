// qcr — the operator CLI. Read-only against state/ (status.json + state.db)
// except where a subcommand says otherwise; `attach` wraps tmux/docker-exec.
import {
  readFileSync,
  existsSync,
  mkdirSync,
  readdirSync,
  renameSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { loadConfig, sandboxRoot, type Config, type TuiConfig } from "./config.js";
import { daemonLoadLine } from "./eventloop.js";
import {
  ManifestUnreadable,
  parseManifestText,
  summarizeManifest,
  type ManifestSummary,
} from "./archive/manifest.js";
import { archiveStatusLine, fmtBytes } from "./archive/status.js";
import { memoryStatusLine } from "./memory/health.js";
import {
  cancelCauseLabel,
  isLoudCancelCause,
  StateStore,
  type CancelCause,
  type CancellationTally,
  type StatusSnapshot,
} from "./state.js";
import {
  computeMetrics,
  computeTimeline,
  readOps,
  renderMetrics,
  renderTimeline,
} from "./metrics.js";
import { CommandDrainSender, drainPayload } from "./tui/deploy-drain.js";
import {
  locateConfig,
  locateKeysFile,
  locateSecrets,
  migrateConfig,
  migrateProfiles,
  migrateReport,
  profileMigrateReport,
  profileSearchDirs,
  migrateSecrets,
  repointComposeSecrets,
  composeRepointReport,
  secretsMigrateReport,
  stateHome,
  strandedCheckoutConfig,
  strandedCheckoutProfiles,
  strandedLegacySecrets,
  type InstallEnv,
} from "./install.js";
import { operatorCommandWriteScript } from "./tui/unwedge.js";
import { MutationGate } from "./gate.js";
import type { GitHubAdapter } from "./github.js";
import type { OutcomeCapture } from "./outcomes.js";
import type { Learner, MineReport } from "./learner/learner.js";
import type { CurationStatus } from "./learner/status.js";

export { drainPayload } from "./tui/deploy-drain.js";

function stateDir(): string {
  return join(sandboxRoot(), "state");
}

function openStore(): StateStore {
  return new StateStore(join(stateDir(), "state.db"));
}

export const OUTCOMES_USAGE =
  "usage: qcr outcomes [--days <n>] [--capture] [--read-github] [--json]";

/** `qcr outcomes` flags. An unknown token is refused, so a
 * mistyped `--capture` cannot quietly print a stale table. */
export function parseOutcomesArgs(rest: readonly string[]): {
  days: number;
  capture: boolean;
  readGithub: boolean;
} {
  let days = 30;
  let capture = false;
  let readGithub = false;
  for (let i = 0; i < rest.length; i++) {
    const a = rest[i];
    if (a === "--capture") capture = true;
    else if (a === "--read-github") readGithub = true;
    else if (a === "--days") {
      const n = Number(rest[++i]);
      if (!Number.isInteger(n) || n <= 0) throw new Error(OUTCOMES_USAGE);
      days = n;
    } else throw new Error(OUTCOMES_USAGE);
  }
  if (readGithub && !capture) throw new Error(`${OUTCOMES_USAGE} (--read-github needs --capture)`);
  return { days, capture, readGithub };
}

/**
 * The gate behind `qcr outcomes --read-github`: it can only
 * RECORD. Dry-run, so every ordinary kind is written to `dryrunDir` and never
 * executed; and an executor that refuses, so even the one class the gate runs
 * in dry-run (`APP_SELF_CONFIG_KINDS`) cannot reach GitHub. The read the
 * command makes goes direct, as every adapter read does; nothing can write.
 */
export function recordOnlyGate(dryrunDir: string): MutationGate {
  return new MutationGate(true, dryrunDir, async () => {
    throw new Error("qcr outcomes performs no mutations");
  });
}

/**
 * The `--capture` half of `qcr outcomes`: every PR with a posted finding
 * recorded since `since`, oldest number first — with `read`, ONE read of its
 * inline comments first for the link facts (a failed read is reported and the
 * PR is captured from what the state database holds) — then captured.
 * Returns the PRs captured.
 */
export async function captureOutcomesWindow(opts: {
  store: StateStore;
  outcomes: Pick<OutcomeCapture, "observeBotComments" | "capturePr">;
  since: string;
  read?: Pick<GitHubAdapter, "listReviewCommentsFull">;
  write?: (line: string) => void;
}): Promise<number[]> {
  const write = opts.write ?? ((line: string) => process.stderr.write(`${line}\n`));
  const prs = (
    opts.store.db
      .prepare(
        "SELECT DISTINCT pr FROM round_findings WHERE disposition = 'posted' AND recorded_at >= ? ORDER BY pr",
      )
      .all(opts.since) as Array<{ pr: number }>
  ).map((r) => r.pr);
  for (const pr of prs) {
    if (opts.read) {
      try {
        opts.outcomes.observeBotComments(pr, await opts.read.listReviewCommentsFull(pr));
      } catch (err) {
        write(`outcomes #${pr}: could not read its comments: ${String(err)}`);
      }
    }
    const r = await opts.outcomes.capturePr(pr);
    write(
      `outcomes #${pr}: ${r.posted} posted, ${r.linked} comment(s) linked, ${r.unmatched} unmatched, ${r.changed} fate(s) changed`,
    );
  }
  return prs;
}

/**
 * `qcr outcomes`: what became of the findings posted in the last
 * `--days` (default 30) — the fate table per lens, how many posted findings
 * are linked to their comment, and the whole-review signals per review.
 * `--capture` first re-captures every PR with a posted finding in the window
 * from state.db and the base clone's git (the daemon does this on its own for
 * open and just-closed PRs; this reaches the older ones). `--read-github` adds
 * ONE read per such PR — its inline comments, for the link facts — through a
 * gate that can only record (`recordOnlyGate`). Nothing is ever written to
 * GitHub.
 */
export async function cmdOutcomes(rest: string[], json: boolean): Promise<number> {
  const { days, capture, readGithub } = parseOutcomesArgs(rest);
  const cfg = loadConfig();
  const { OutcomeCapture, renderOutcomeSummary } = await import("./outcomes.js");
  const { WorktreeManager } = await import("./worktrees.js");
  const { githubCloneDir } = await import("./config.js");
  const root = sandboxRoot();
  const worktrees = new WorktreeManager({
    root,
    repo: cfg.github.repo,
    cloneDir: githubCloneDir(cfg.github),
  });
  const store = openStore();
  try {
    const outcomes = new OutcomeCapture({
      store,
      botLogin: cfg.github.bot_login,
      ...(existsSync(worktrees.basePath) ? { git: worktrees } : {}),
    });
    const since = new Date(Date.now() - days * 86_400_000).toISOString();
    if (capture) {
      let read: GitHubAdapter | undefined;
      if (readGithub) {
        const { TokenMinter } = await import("./githubAuth.js");
        const { GitHubAdapter } = await import("./github.js");
        read = new GitHubAdapter(
          cfg,
          new TokenMinter(cfg.github.secrets_dir),
          recordOnlyGate(join(stateDir(), "dryrun")),
        );
      }
      await captureOutcomesWindow({ store, outcomes, since, ...(read ? { read } : {}) });
    }
    const summary = outcomes.summary(since);
    console.log(json ? JSON.stringify(summary) : renderOutcomeSummary(summary));
    return 0;
  } finally {
    store.close();
  }
}

export const LESSONS_USAGE =
  "usage: qcr lessons [mine] [--json] | qcr lessons shadow-report [--days <n>] [--json] | " +
  "qcr lessons off|on | qcr lessons suppress|unsuppress <experiences/<file>.md | viking://… URI>";

/** The subcommands of `qcr lessons` beyond the table: the shadow report, and the
 * operator's kill switch (written into the root-sealed commands/operator/). */
export type LessonsSubcommand =
  | { kind: "shadow-report"; days: number }
  | { kind: "switch"; command: "lessons-off" | "lessons-on" }
  | { kind: "switch"; command: "suppress-lesson" | "unsuppress-lesson"; target: string };

/** `qcr lessons shadow-report|off|on|suppress|unsuppress …`, or null when
 * `rest` is the candidates table (`[mine]`). An unknown flag or a missing target is
 * refused. */
export function parseLessonsSubcommand(rest: readonly string[]): LessonsSubcommand | null {
  const [head, ...tail] = rest;
  switch (head) {
    case "shadow-report": {
      let days = 14;
      for (let i = 0; i < tail.length; i++) {
        if (tail[i] === "--days") {
          const n = Number(tail[i + 1]);
          if (!Number.isInteger(n) || n < 1 || n > 365) throw new Error(LESSONS_USAGE);
          days = n;
          i += 1;
        } else throw new Error(LESSONS_USAGE);
      }
      return { kind: "shadow-report", days };
    }
    case "off":
    case "on":
      if (tail.length > 0) throw new Error(LESSONS_USAGE);
      return { kind: "switch", command: head === "off" ? "lessons-off" : "lessons-on" };
    case "suppress":
    case "unsuppress":
      if (tail.length !== 1 || !tail[0]) throw new Error(LESSONS_USAGE);
      return {
        kind: "switch",
        command: head === "suppress" ? "suppress-lesson" : "unsuppress-lesson",
        target: tail[0],
      };
    default:
      return null;
  }
}

/** `qcr lessons` arguments: `mine` or nothing. An unknown token
 * is refused, so a mistyped `mine` cannot quietly print yesterday's table. */
export function parseLessonsArgs(rest: readonly string[]): { mine: boolean } {
  if (rest.length === 0) return { mine: false };
  if (rest.length === 1 && rest[0] === "mine") return { mine: true };
  throw new Error(LESSONS_USAGE);
}

/** What `qcr lessons` prints: the mine's report (with `mine`), the undecided
 * candidates per class, and the latest EOD curation. */
export function renderLessons(opts: {
  report: MineReport | null;
  clusters: ReturnType<Learner["clusters"]>;
  status: CurationStatus;
}): string {
  const out: string[] = [];
  const r = opts.report;
  if (r) {
    const by = Object.entries(r.added_by_source)
      .filter(([, v]) => (v ?? 0) > 0)
      .map(([k, v]) => `${k} ${v}`)
      .join(", ");
    out.push(`mined: ${r.added} new candidate${r.added === 1 ? "" : "s"}${by ? ` (${by})` : ""}`);
    if (r.recall)
      out.push(
        `post-merge recall: ${r.recall.scanned} merged PR(s) read, ${r.recall.unknown} unknown`,
      );
    else out.push("post-merge recall: not read (no base clone)");
    if (r.digest)
      out.push(
        `digest backfill: ${r.digest.added} added from ${r.digest.files} digest(s) (${r.digest.absent} absent, ${r.digest.unreadable} unreadable)`,
      );
    const f = r.fates;
    if (f.revised + f.withdrawn + f.reinstated > 0)
      out.push(
        `fate candidates re-read: ${f.revised} revised, ${f.withdrawn} withdrawn, ${f.reinstated} reinstated`,
      );
    if ((r.relinked ?? 0) > 0)
      out.push(`feedback candidates re-linked to their finding: ${r.relinked}`);
    for (const e of r.errors) out.push(`source error: ${oneLine(e)}`);
    out.push("");
  }
  out.push(
    opts.clusters.length === 0
      ? "No undecided lesson candidates."
      : "Undecided lesson candidates by class (offered / waiting for a packet / events in the recurrence window):",
  );
  for (const c of opts.clusters)
    out.push(
      `  ${c.class.padEnd(32)} ${c.polarity.padEnd(10)} ${String(c.open).padStart(4)} ${String(c.queued).padStart(4)} ${String(c.recurrence).padStart(5)}`,
    );
  const s = opts.status;
  out.push(
    "",
    s.day === null
      ? "EOD curation: no outcomes packet yet."
      : `EOD curation ${s.day}: ${s.state.replace("_", " ")} — ${s.offered} offered, ${s.adopted} adopted, ${s.declined} declined, ${s.verifying} verifying, ${s.not_persisted} not persisted, ${s.expired_today} expired${
          (s.unresolved ?? []).length > 0
            ? `\nunresolved: ${(s.unresolved ?? []).map((u) => `${u.day} ${u.state.replace("_", " ")} (${u.count})`).join("; ")}`
            : ""
        }`,
    s.balance
      ? `lessons in force: look-for:dont-raise ${s.balance.look_for}:${s.balance.dont_raise}${s.balance.ratio === null ? "" : ` (${s.balance.ratio.toFixed(2)})`} as of ${s.balance.as_of}`
      : "lessons in force: the daemon reads memory for the balance — see `qcr status`",
  );
  return out.join("\n");
}

/**
 * `qcr lessons [mine]`: the learner's candidates per class and
 * the latest EOD curation, from the state database. `mine` first runs the
 * miner on the operator's word — the same deterministic mine the daemon runs
 * before every EOD sweep (state.db, and read-only git in the base clone when
 * there is one). It reads no memory and writes none.
 */
export async function cmdLessons(rest: string[], json: boolean): Promise<number> {
  const sub = parseLessonsSubcommand(rest);
  if (sub?.kind === "shadow-report") return cmdShadowReport(sub.days, json);
  if (sub?.kind === "switch") return cmdLessonSwitch(sub);
  const { mine } = parseLessonsArgs(rest);
  const cfg = loadConfig();
  const { Learner, learnerKnobsOf } = await import("./learner/learner.js");
  const { WorktreeManager } = await import("./worktrees.js");
  const { githubCloneDir } = await import("./config.js");
  const root = sandboxRoot();
  const worktrees = new WorktreeManager({
    root,
    repo: cfg.github.repo,
    cloneDir: githubCloneDir(cfg.github),
  });
  const store = openStore();
  try {
    const learner = new Learner({
      store,
      root,
      eodTime: cfg.eod.time,
      timeZone: cfg.eod.timezone,
      botLogin: cfg.github.bot_login,
      baseBranch: cfg.github.base_branch,
      config: learnerKnobsOf(cfg.memory),
      ...(existsSync(worktrees.basePath) ? { git: worktrees } : {}),
    });
    const report = mine ? await learner.mine() : null;
    const clusters = learner.clusters();
    const status = learner.status();
    console.log(
      json
        ? JSON.stringify({ report, clusters, status })
        : renderLessons({ report, clusters, status }),
    );
    return report && report.errors.length > 0 ? 1 : 0;
  } finally {
    store.close();
  }
}

/**
 * `qcr lessons shadow-report [--days N]`: the lesson shadow
 * ledger joined with what humans did — in total, per lesson and per lens, the
 * findings a delivered dont-raise lesson would have touched that humans then
 * FIXED (harm), refuted or set aside (help), or not yet, each split by match
 * tier (`class`, the lesson's class matched too — the would-demote tier,
 * what the validator's license reaches; `lens`, lens and path alone —
 * evidence only); and the look-for lessons whose class later showed a
 * human-raised miss. state.db only (opening it migrates a ledger without
 * match tiers once).
 */
async function cmdShadowReport(days: number, json: boolean): Promise<number> {
  const cfg = loadConfig();
  const { LessonLedger } = await import("./lessonledger.js");
  const { renderShadowReport, shadowReport } = await import("./lessonshadow.js");
  const store = openStore();
  try {
    const report = shadowReport(new LessonLedger(store), { days, mode: cfg.memory.delivery });
    console.log(json ? JSON.stringify(report) : renderShadowReport(report));
    return 0;
  } finally {
    store.close();
  }
}

/**
 * `qcr lessons off|on|suppress|unsuppress`: the operator's kill
 * switch, written as root into the sealed commands/operator/ (the drain's
 * channel) and confirmed by the daemon's own result file.
 */
async function cmdLessonSwitch(
  sub: Extract<LessonsSubcommand, { kind: "switch" }>,
): Promise<number> {
  const cfg = loadConfig();
  const { runnerFor } = await import("./tui/remote.js");
  const { LessonSwitchSender, lessonUriOf } = await import("./tui/lessonswitch.js");
  const cmd: import("./tui/lessonswitch.js").LessonSwitchCommand =
    "target" in sub
      ? { command: sub.command, uri: lessonUriOf(sub.target, cfg.openviking.user) }
      : { command: sub.command };
  console.log(
    `${cmd.command}${"uri" in cmd ? ` ${cmd.uri}` : ""} → ${cfg.tui.ssh_host}:${cfg.tui.remote_sandbox_root}/commands/operator/`,
  );
  const res = await new LessonSwitchSender(cfg.tui, runnerFor(cfg.tui)).send(cmd);
  if (!res.ok) {
    console.log(`✖ refused: ${res.reason ?? "no reason given"}`);
    if (res.issuer === "session")
      console.log(
        "  the daemon found commands/operator/ UNSEALED (writable by its own uid), so it served the file as a session's — check the directory is root-owned 0755 in the container",
      );
    return 1;
  }
  console.log(
    `✓ ${res.changed === false ? "already so" : "done"} — lessons ${res.lessons_off ? "OFF (kill switch)" : "on"}; ${res.suppressed ?? "?"} suppressed`,
  );
  return 0;
}

/** Foreign free text (a PR title, a session's pause reason) headed for the
 * operator's terminal: one line, no C0/C1 control bytes — the board's
 * sanitizeText does the same, so an ESC/CSI in a title cannot drive the
 * terminal. */
function oneLine(s: string): string {
  return s.replace(/[\u0000-\u001f\u007f-\u009f]+/g, " ").trim();
}

export function renderStatus(snapshot: StatusSnapshot): string {
  const lines: string[] = [];
  const mode = snapshot.dry_run ? "DRY-RUN" : "LIVE";
  lines.push(`quickreview — ${mode} — snapshot ${snapshot.written_at}`);
  if (snapshot.digest_headline) lines.push(`digest: ${snapshot.digest_headline}`);
  lines.push(
    `rounds running: ${snapshot.running_rounds}   total spend: $${snapshot.total_spend_usd.toFixed(2)}`,
  );
  // Whether reviewer memory works, every time — an absent block
  // (older daemon) and an unmeasured one say so, never "healthy".
  lines.push(oneLine(memoryStatusLine(snapshot.memory, new Date(snapshot.written_at))));
  // The daemon's own event loop and the container's CPU
  // throttling, every time — an absent block (older daemon) and an unmeasured
  // one say so, never "ok".
  lines.push(oneLine(daemonLoadLine(snapshot.daemon)));
  // The closed-PR archiver, every time — an absent block (older
  // daemon) says so, and a backlog nobody planned yet is UNKNOWN, never 0.
  lines.push(oneLine(archiveStatusLine(snapshot.archive)));
  if (snapshot.draining) {
    lines.push(
      `DRAINING${snapshot.draining_since ? ` since ${snapshot.draining_since}` : ""} — ${drainHolderLine(snapshot)} — ` +
        `webhook deliveries dropped: ${snapshot.drained_deliveries ?? 0}; ` +
        `deploy when rounds running hits 0 (auto-lifts on the next boot's first healthy reconcile; qcr drain off to lift now)`,
    );
  }
  lines.push("");
  if (snapshot.prs.length === 0) {
    lines.push("no tracked PRs");
  } else {
    lines.push("PR     state             stale  head        title");
    for (const pr of snapshot.prs) {
      lines.push(
        `#${String(pr.number).padEnd(5)} ${pr.state.padEnd(17)} ${(pr.stale_recheck ? "yes" : "-").padEnd(6)} ${pr.head_sha.slice(0, 10).padEnd(11)} ${oneLine(pr.title).slice(0, 60)}`,
      );
    }
    // Every held PR says who holds it and when the hold lapses.
    const held = snapshot.prs.filter((pr) => pr.paused);
    if (held.length > 0) {
      lines.push("");
      for (const pr of held) {
        const hold = pr.pause;
        const who = hold
          ? hold.issuer === "operator"
            ? "paused by the operator until resumed"
            : `paused by a session${hold.expires_at ? `, lapses ${hold.expires_at}` : ""}`
          : "paused (holder unknown — older daemon)";
        // The reason is a SESSION's free text headed for a terminal.
        const reason = hold?.reason ? oneLine(hold.reason) : undefined;
        lines.push(`#${pr.number} ${who}${reason ? ` — ${reason}` : ""}`);
      }
    }
  }
  return lines.join("\n");
}

function drainHolderLine(snapshot: StatusSnapshot): string {
  if (snapshot.draining_by === undefined) return "holder unknown (older daemon)";
  if (snapshot.draining_by === "operator") {
    return snapshot.draining_until
      ? `held by the operator, lapses ${snapshot.draining_until}`
      : "held by the operator until lifted";
  }
  return `held by a SESSION, lapses ${snapshot.draining_until ?? "(no expiry recorded)"}`;
}

function cmdStatus(): void {
  const path = join(stateDir(), "status.json");
  if (!existsSync(path)) {
    console.log("no status.json yet — is the daemon running?");
    return;
  }
  console.log(renderStatus(JSON.parse(readFileSync(path, "utf8")) as StatusSnapshot));
}

function cmdSpend(): void {
  const store = openStore();
  try {
    const total = store.totalSpend();
    const today = new Date().toISOString().slice(0, 10);
    // est_usd is the one spend field. Expired rounds are counted: they blew
    // a deadline, they did not get a refund — excluding them would erase real
    // token cost.
    const todayRounds = store.roundsOn(today);
    const todaySpend = todayRounds.reduce((n, r) => n + (r.est_usd ?? 0), 0);
    const totals = store.db
      .prepare(
        "SELECT COALESCE(SUM(tokens_in), 0) AS tin, COALESCE(SUM(tokens_out), 0) AS tout FROM rounds",
      )
      .get() as { tin: number; tout: number };
    const todayIn = todayRounds.reduce((n, r) => n + (r.tokens_in ?? 0), 0);
    const todayOut = todayRounds.reduce((n, r) => n + (r.tokens_out ?? 0), 0);
    console.log(
      `total spend: $${total.toFixed(2)} (est) — ${totals.tin} in / ${totals.tout} out tokens`,
    );
    console.log(
      `today (${today}): $${todaySpend.toFixed(2)} across ${todayRounds.length} rounds — ${todayIn} in / ${todayOut} out tokens`,
    );
  } finally {
    store.close();
  }
}

function cmdToday(): void {
  const store = openStore();
  try {
    const today = new Date().toISOString().slice(0, 10);
    const rounds = store.roundsOn(today);
    console.log(`rounds on ${today}: ${rounds.length}`);
    for (const r of rounds) {
      const tokens =
        r.tokens_in !== null || r.tokens_out !== null
          ? ` tok=${r.tokens_in ?? 0}/${r.tokens_out ?? 0}`
          : "";
      // A cancelled round says why inline — its status alone does not.
      const why = r.status === "cancelled" ? ` cause=${cancelCauseLabel(r.cancel_cause)}` : "";
      console.log(
        `#${r.pr} round ${r.round_no} (${r.round_type}) [${r.status}]${why} verdict=${r.verdict ?? "—"} spend=$${(r.est_usd ?? 0).toFixed(2)}${tokens} lenses=${r.lenses}`,
      );
    }
    console.log(todayCancellationLine(cancellationsOn(store, today)));
    const events = store.eventsOn(today);
    console.log(`events: ${events.length}`);
    for (const e of events.slice(-40)) console.log(`  ${e.ts} ${e.kind}${e.pr ? ` #${e.pr}` : ""}`);
  } finally {
    store.close();
  }
}

// ---- machine-readable payloads (the TUI's detail-on-demand surface) -------

export interface WhyPayload {
  pr: number;
  known: boolean;
  state?: string;
  title?: string;
  head_sha?: string;
  author?: string;
  trigger_ts?: string | null;
  stale_recheck?: boolean;
  updated_at?: string;
  spend_usd: number;
  rounds: Array<{
    round_no: number;
    round_type: string;
    status: string;
    verdict: string | null;
    started_at: string;
    deadline_at?: string;
    finished_at: string | null;
    spend_usd: number | null;
    est_usd?: number | null;
    tokens_in?: number | null;
    tokens_out?: number | null;
    lenses: string;
    validate_tier?: string | null;
    executed_passes?: unknown[] | null;
    summary?: string | null;
    cancel_cause?: string | null;
  }>;
  /** `open` is null: resolution is GitHub's state and the daemon does not
   * mirror it — unknown, never the total dressed as a count. */
  threads: { open: number | null; total: number };
  /** The findings the validator doubted — kept, never posted, shown
   * in the TUI detail pane. Absent from an older daemon (never read as none). */
  doubted?: DoubtedFinding[];
  /** The survivors the profile's `[posting]` policy withheld: kept, never
   * posted. Same shape; `word` is the posting-policy word. Absent from an
   * older daemon. */
  withheld?: DoubtedFinding[];
  ledger?: string;
  archive?: string[];
  /** The PR's archive manifest in brief — what the archiver
   * holds for it and what left the live tree. Absent when there is no
   * manifest (nothing archived, or an older daemon); `unreadable` with why
   * when there is one that cannot be read — never read as "nothing". */
  archive_manifest?: WhyArchiveManifest;
  /** GitHub conversation surface — present only when the enrichment fetch
   * succeeded (needs the app credential; degrades silently without it). */
  description?: string;
  labels?: string[];
  comments?: Array<{ author: string; body: string; created_at: string }>;
}

/** `why --json`'s archive manifest summary. */
export type WhyArchiveManifest =
  ({ state: "read" } & ManifestSummary) | { state: "unreadable"; error: string };

/** The PR's archive manifest in brief, read in this process (synchronous:
 * `qcr why` is a CLI, never the daemon). Undefined when there is none. */
export function archiveManifestSummary(archiveDir: string): WhyArchiveManifest | undefined {
  const path = join(archiveDir, "manifest.json");
  let text: string;
  try {
    text = readFileSync(path, "utf8");
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    return { state: "unreadable", error: (err as Error).message };
  }
  try {
    return { state: "read", ...summarizeManifest(parseManifestText(text, path)) };
  } catch (err) {
    if (err instanceof ManifestUnreadable) return { state: "unreadable", error: err.message };
    throw err;
  }
}

/** `qcr why`'s archive manifest line. */
export function archiveManifestLine(m: WhyArchiveManifest): string {
  if (m.state === "unreadable") return `archive manifest: UNREADABLE (${oneLine(m.error)})`;
  return (
    `archive manifest: ${m.passes} pass(es), last ${m.last_pass_at ?? "unknown"}; ` +
    `${m.transcripts} transcript(s), ${m.files} large file(s), ${m.bundles} bundle(s) of ${m.records} record(s) — ` +
    `${fmtBytes(m.bytes)} → ${fmtBytes(m.gz_bytes)}; ${m.sources_removed} live source(s) removed` +
    (m.duplicates_removed > 0 ? `, ${m.duplicates_removed} legacy duplicate(s) removed` : "") +
    (m.restores > 0 ? `; ${m.restores} restore(s)` : "")
  );
}

/** One doubted finding as `why --json` carries it. */
export interface DoubtedFinding {
  round_no: number;
  lens: string;
  path: string | null;
  line: number | null;
  severity: string | null;
  /** The validity veto word: refuted, unverifiable or bad-anchor. */
  word: string | null;
  reason: string | null;
}

/** Best-effort GitHub enrichment for `why --json` (description, labels, last
 * comments). Read-only; any failure leaves the payload un-enriched.
 * `secretsDir` is an injection seam for tests — pointing it at an empty dir
 * makes the credential lookup fail fast instead of hitting the real network
 * when the developer machine carries the app credential. */
export async function enrichWhy(payload: WhyPayload, secretsDir?: string): Promise<WhyPayload> {
  try {
    const { TokenMinter } = await import("./githubAuth.js");
    const { MutationGate } = await import("./gate.js");
    const { GitHubAdapter } = await import("./github.js");
    const cfg = loadConfig();
    const gate = new MutationGate(
      true,
      join(sandboxRoot(), "state", "dryrun"),
      async () => undefined,
    );
    const adapter = new GitHubAdapter(
      cfg,
      new TokenMinter(secretsDir ?? cfg.github.secrets_dir),
      gate,
    );
    const convo = await adapter.prConversation(payload.pr, 3);
    return { ...payload, description: convo.body, labels: convo.labels, comments: convo.comments };
  } catch {
    return payload;
  }
}

export function whyJson(store: StateStore, n: number, archiveDir: string): WhyPayload {
  const pr = store.getPr(n);
  const rounds = store.db
    .prepare("SELECT * FROM rounds WHERE pr = ? ORDER BY round_no")
    .all(n) as any[];
  const threadTotal = store.db
    .prepare("SELECT COUNT(*) AS c FROM bot_comments WHERE pr = ?")
    .get(n) as { c: number };
  const payload: WhyPayload = {
    pr: n,
    known: pr !== undefined || rounds.length > 0,
    // Every round's cost, expired ones included.
    spend_usd: rounds.reduce((s, r) => s + (r.est_usd ?? 0), 0),
    rounds: rounds.map((r) => ({
      round_no: r.round_no,
      round_type: r.round_type,
      status: r.status,
      verdict: r.verdict ?? null,
      started_at: r.started_at,
      deadline_at: r.deadline_at,
      finished_at: r.finished_at ?? null,
      spend_usd: r.spend_usd ?? null,
      est_usd: r.est_usd ?? null,
      tokens_in: r.tokens_in ?? null,
      tokens_out: r.tokens_out ?? null,
      lenses: r.lenses,
      validate_tier: r.validate_tier ?? null,
      executed_passes: (() => {
        if (typeof r.executed_passes !== "string") return null;
        try {
          const parsed = JSON.parse(r.executed_passes) as unknown;
          return Array.isArray(parsed) ? parsed : null;
        } catch {
          return null;
        }
      })(),
      summary: r.summary ?? null,
      // Why a cancelled round was cancelled — null on every other
      // status. The TUI's detail pane reads this beside the prose summary.
      cancel_cause: r.cancel_cause ?? null,
    })),
    // The registry knows every bot thread; "open" needs GitHub truth the
    // daemon doesn't mirror, so it is UNKNOWN (null) — never the total.
    threads: { open: null, total: threadTotal.c },
    doubted: store.doubtedFindings(n).map((f) => ({
      round_no: f.round_no,
      lens: f.lens,
      path: f.path,
      line: f.line,
      severity: f.severity,
      word: f.word,
      reason: f.reason,
    })),
    withheld: store.withheldFindings(n).map((f) => ({
      round_no: f.round_no,
      lens: f.lens,
      path: f.path,
      line: f.line,
      severity: f.severity,
      word: f.word,
      reason: f.reason,
    })),
  };
  if (pr) {
    payload.state = pr.state;
    payload.title = pr.title;
    payload.head_sha = pr.head_sha;
    payload.author = pr.author;
    payload.trigger_ts = pr.trigger_ts;
    payload.stale_recheck = Boolean(pr.stale_recheck);
    payload.updated_at = pr.updated_at;
  }
  if (existsSync(archiveDir)) {
    payload.archive = readdirSync(archiveDir);
    const ledger = join(archiveDir, "ledger.md");
    if (existsSync(ledger)) payload.ledger = readFileSync(ledger, "utf8");
    const manifest = archiveManifestSummary(archiveDir);
    if (manifest) payload.archive_manifest = manifest;
  }
  return payload;
}

export function todayJson(
  store: StateStore,
  today: string,
): {
  date: string;
  rounds: unknown[];
  spend_usd: number;
  tokens_in: number;
  tokens_out: number;
  events: unknown[];
  cancellations: CancellationTally[];
} {
  const rounds = store.roundsOn(today);
  return {
    date: today,
    rounds,
    // Expired rounds included — see StateStore.totalSpend.
    spend_usd: rounds.reduce((n, r) => n + (r.est_usd ?? 0), 0),
    tokens_in: rounds.reduce((n, r) => n + (r.tokens_in ?? 0), 0),
    tokens_out: rounds.reduce((n, r) => n + (r.tokens_out ?? 0), 0),
    events: store.eventsOn(today),
    cancellations: cancellationsOn(store, today),
  };
}

/** Today's cancellations grouped by cause — the same tally the
 * metrics payload carries, scoped to one timezone-agnostic ISO date so `qcr
 * today` can print it beside the rounds it explains. */
export function cancellationsOn(store: StateStore, date: string): CancellationTally[] {
  const counts = new Map<string, number>();
  for (const r of store.roundsOn(date)) {
    if (r.status !== "cancelled") continue;
    const cause = (r.cancel_cause ?? "unknown") as CancelCause;
    counts.set(cause, (counts.get(cause) ?? 0) + 1);
  }
  return [...counts.entries()]
    .map(([cause, count]) => ({
      cause: cause as CancelCause,
      count,
      loud: isLoudCancelCause(cause),
    }))
    .sort(
      (a, b) =>
        Number(b.loud) - Number(a.loud) || b.count - a.count || a.cause.localeCompare(b.cause),
    );
}

/** `qcr today`'s one-line cancellation summary. Never silent: "none" is an
 * answer. */
export function todayCancellationLine(tallies: CancellationTally[]): string {
  if (tallies.length === 0) return "cancelled: none";
  const total = tallies.reduce((n, t) => n + t.count, 0);
  const loud = tallies.filter((t) => t.loud).reduce((n, t) => n + t.count, 0);
  const parts = tallies.map((t) => `${cancelCauseLabel(t.cause)} ${t.count}${t.loud ? " ⚑" : ""}`);
  return `cancelled: ${total} — ${parts.join(", ")}${loud > 0 ? `  (${loud} needing a look)` : ""}`;
}

/** `qcr why`'s first line; the title is the author's text, so one line. */
export function whyHeaderLine(
  n: number,
  pr: { state: string; head_sha: string; stale_recheck: number; title: string },
): string {
  return `#${n} state=${pr.state} head=${pr.head_sha.slice(0, 10)} stale=${pr.stale_recheck} "${oneLine(pr.title)}"`;
}

function cmdWhy(n: number): void {
  const archiveDir = join(sandboxRoot(), "archive", `pr-${n}`);
  const store = openStore();
  try {
    const pr = store.getPr(n);
    if (pr) console.log(whyHeaderLine(n, pr));
    const rounds = store.db
      .prepare("SELECT * FROM rounds WHERE pr = ? ORDER BY round_no")
      .all(n) as any[];
    for (const r of rounds)
      console.log(
        `round ${r.round_no} (${r.round_type}) [${r.status}] verdict=${r.verdict ?? "—"} started=${r.started_at}`,
      );
    if (existsSync(archiveDir)) {
      console.log(`archive: ${archiveDir}`);
      for (const f of readdirSync(archiveDir)) console.log(`  ${f}`);
      const manifest = archiveManifestSummary(archiveDir);
      if (manifest) console.log(archiveManifestLine(manifest));
      const ledger = join(archiveDir, "ledger.md");
      if (existsSync(ledger)) {
        console.log("--- archived ledger ---");
        console.log(readFileSync(ledger, "utf8"));
      }
    } else if (!pr && rounds.length === 0) {
      console.log(`nothing known about #${n}`);
    }
  } finally {
    store.close();
  }
}

/** `qcr metrics [--pr <n>] [--json]` — the aggregation engine over the live
 * sqlite (read-only, container-safe: same store/config opening as `why`). */
async function cmdMetrics(pr: number | null, json: boolean): Promise<void> {
  const store = openStore();
  try {
    if (pr !== null) {
      const payload = computeTimeline(store, pr);
      console.log(json ? JSON.stringify(payload) : renderTimeline(payload));
      return;
    }
    // Day buckets follow the ops timezone. `qcr metrics` must stay
    // usable beside a bare state.db, so an unreadable config degrades to UTC
    // rather than refusing.
    let timeZone = "UTC";
    try {
      timeZone = loadConfig().ops.timezone;
    } catch {
      /* config genuinely unavailable — UTC day buckets */
    }
    const payload = computeMetrics(store, { timeZone });
    // The operational half is file-derived: status.json (heartbeat/dry-run/
    // concurrency) + the BUILD_SHA marker deploy.sh writes into the sandbox
    // root. parseBuildSha is deploytab's — the marker format has one parser.
    const { parseBuildSha } = await import("./tui/deploytab.js");
    payload.ops = readOps(
      {
        statusPath: join(stateDir(), "status.json"),
        buildShaPath: join(sandboxRoot(), "BUILD_SHA"),
      },
      { readFile: (p) => readFileSync(p, "utf8"), parseBuildSha },
      payload.ops,
    );
    console.log(json ? JSON.stringify(payload) : renderMetrics(payload));
  } finally {
    store.close();
  }
}

/** `qcr backfill [--dry-run] [--limit N]` — the one-shot pre-daemon history
 * import. Read-only against GitHub: it opens the adapter purely for
 * its search/GraphQL reads and never reaches a mutation surface. */
export async function cmdBackfill(
  dryRun: boolean,
  limit: number | undefined,
  json: boolean,
): Promise<void> {
  const { TokenMinter } = await import("./githubAuth.js");
  const { MutationGate } = await import("./gate.js");
  const { GitHubAdapter } = await import("./github.js");
  const { runBackfill } = await import("./backfill.js");
  const cfg = loadConfig();
  // A gate that can only ever record: the importer performs no mutations, and
  // this keeps that structural rather than prompted.
  const gate = new MutationGate(true, join(stateDir(), "dryrun"), async () => {
    throw new Error("qcr backfill performs no mutations");
  });
  const adapter = new GitHubAdapter(cfg, new TokenMinter(cfg.github.secrets_dir), gate);
  const store = openStore();
  try {
    const stats = await runBackfill(store, adapter, cfg, {
      dryRun,
      ...(limit !== undefined ? { limit } : {}),
      log: (line) => process.stderr.write(`${line}\n`),
    });
    if (json) console.log(JSON.stringify(stats));
  } finally {
    store.close();
  }
}

/** `--months N` / `--limit N`, or undefined; a malformed value is an error. */
function intFlag(rest: string[], flag: string, usage: string): number | undefined {
  const i = rest.indexOf(flag);
  if (i < 0) return undefined;
  const n = Number(rest[i + 1]);
  if (!Number.isInteger(n) || n < 0) throw new Error(usage);
  return n;
}

const HISTORY_USAGE =
  "usage: qcr history <digest [--months <n>] [--limit <n>] | pull [--months <n>]>";

/**
 * `qcr history` — the review history digest setup reads.
 *
 * `digest` runs WHERE THE APP CREDENTIAL IS (in the VM container) and prints
 * the digest to stdout, writing nothing: read-only against GitHub, built with
 * the same record-only gate `qcr backfill` builds, so no mutation is reachable
 * from it even by mistake. `pull` runs on the PC: it runs `digest` over the
 * TUI's route and writes the result into THIS install's state home — the only
 * place the raw comments ever land.
 */
export async function cmdHistory(rest: string[]): Promise<number> {
  const sub = rest[0];
  const months = intFlag(rest, "--months", HISTORY_USAGE);
  if (sub === "digest") {
    const limit = intFlag(rest, "--limit", HISTORY_USAGE);
    const { TokenMinter } = await import("./githubAuth.js");
    const { MutationGate } = await import("./gate.js");
    const { GitHubAdapter } = await import("./github.js");
    const { collectReviewHistory } = await import("./reviewhistory.js");
    const cfg = loadConfig();
    const gate = new MutationGate(true, join(stateDir(), "dryrun"), async () => {
      throw new Error("qcr history performs no mutations");
    });
    const adapter = new GitHubAdapter(cfg, new TokenMinter(cfg.github.secrets_dir), gate);
    const store = openStore();
    try {
      const digest = await collectReviewHistory(adapter, store, cfg, {
        ...(months !== undefined ? { months } : {}),
        ...(limit !== undefined ? { limit } : {}),
        log: (line) => process.stderr.write(`${line}\n`),
      });
      process.stdout.write(`${JSON.stringify(digest)}\n`);
      return 0;
    } finally {
      store.close();
    }
  }
  if (sub === "pull") {
    const { runnerFor } = await import("./tui/remote.js");
    const { pullReviewHistory } = await import("./tui/historypull.js");
    const { stateHome } = await import("./install.js");
    const cfg = loadConfig();
    const r = await pullReviewHistory({
      tui: cfg.tui,
      ssh: runnerFor(cfg.tui),
      stateHome: stateHome(),
      repo: cfg.github.repo,
      ...(months !== undefined ? { months } : {}),
      log: (line) => console.log(line),
    });
    if (!r.ok) {
      console.log(`✖ ${r.reason}`);
      return 1;
    }
    return 0;
  }
  throw new Error(HISTORY_USAGE);
}

/**
 * `qcr regression` — run the human-review case set against the
 * reviewer and write the investigation.
 *
 * The gate is built HERE, exactly as `cmdBackfill` builds its own: a dry-run
 * gate whose executor throws. That is not a claim copied out of `config.toml`
 * — `runRegression` refuses to start unless the object it is handed reports
 * dry-run, and this is the only gate in the process. `src/replay.ts` holds no
 * adapter and no mutation surface at all, so there is nothing for a gate to
 * front even if one were live.
 */
export async function cmdRegression(rest: string[], json: boolean): Promise<number> {
  const { MutationGate } = await import("./gate.js");
  const { nodeReplayIo, parseRegressionArgs, readCaseSet, runRegressionCli, ScratchReplay } =
    await import("./replay.js");
  const root = sandboxRoot();
  // The replay plans rounds with `buildPassPlan`, so it must see the
  // profile's overlays exactly as the daemon does (wire.ts buildParts, the
  // same function) — otherwise a lens the profile switched off would be
  // replayed.
  const { applyProfileOverlays } = await import("./profiles.js");
  const cfg = applyProfileOverlays(root, loadConfig());
  const args = parseRegressionArgs(rest, json);
  const gate = new MutationGate(true, join(stateDir(), "dryrun"), async () => {
    throw new Error("qcr regression performs no mutations");
  });
  const scratchRoot = join(stateDir(), "regression");
  return runRegressionCli(args, {
    loadCaseSet: (p) => readCaseSet(p ?? join(root, "tests", "fixtures", "regression-cases.json")),
    gate,
    makeReplay: async (g) => {
      const io = await nodeReplayIo({ cfg, sandboxRoot: root, scratchRoot });
      return new ScratchReplay({
        gate: g,
        cfg,
        sandboxRoot: root,
        scratchRoot,
        io,
        ...(args.clonePath !== undefined ? { baseClone: args.clonePath } : {}),
        log: (l) => console.log(l),
      }).replay;
    },
    reportPath: (ranAt) => join(root, "reports", `regression-${ranAt.replace(/[:.]/g, "-")}.md`),
    writeReport: (p, body) => {
      mkdirSync(join(p, ".."), { recursive: true });
      writeFileSync(p, body);
    },
    log: (line) => console.log(line),
  });
}

// ---- deploy-window drain -----------------------------------------------------
//
// `qcr drain on|off` works as the TUI's unwedge does: ONE validated command
// file written as root into the daemon's sealed commands/operator/ dir
// (docker exec over ssh, payload on stdin, tmp+mv), then the daemon's own
// result file read back. src/commands.ts re-validates against the same
// whitelist and the same tier gate; nothing here touches GitHub or goes near
// the MutationGate. `--local` writes the file into THIS machine's sandbox
// commands/operator/ dir instead, as the current user (for running inside the
// container or against a local dev daemon) — sealed only if that dir is
// root-owned; otherwise the daemon bounds it like a session's drain.

/** The documented manual fallback: the exact ssh one-liner that writes the
 * same command file by hand when the runner path fails. */
export function drainManualSshCommand(tui: TuiConfig, on: boolean, now: Date): string {
  // Same root-owned operator directory the runner path writes: a
  // fallback that wrote into the session dir would be a bounded session drain.
  const docker = `${tui.sudo_docker ? "sudo " : ""}docker exec -i -u 0 ${tui.container}`;
  // A fresh name each time the fallback is printed, so the `off` after an
  // `on` (or the next deploy's `on`) never lands on a result file that already
  // holds an answer. The daemon's handled-ledger is keyed by file VERSION, so
  // a re-used name (an operator editing an old line) still executes — the
  // fresh name is what keeps its result readable.
  const name = `${now.toISOString().replace(/[:.]/g, "-")}-manual-drain.json`;
  // Single quotes for the remote `sh -c`, then backslash, dollar, double quote
  // and backtick for the LOCAL double-quoted ssh argument, which would
  // otherwise expand them on the operator's machine.
  const script = operatorCommandWriteScript(tui, name)
    .replace(/'/g, "'\\''")
    .replace(/[\\$"`]/g, "\\$&");
  return (
    `printf '%s' '${JSON.stringify({ command: "drain", on })}' | ` +
    `ssh ${tui.ssh_host} "${docker} sh -c '${script}'"`
  );
}

export interface DrainRunDeps {
  cfg: Config;
  ssh: import("./tui/remote.js").SshRunner;
  log: (line: string) => void;
  now?: () => Date;
  sleep?: (ms: number) => Promise<void>;
}

/** Write the drain command over ssh and wait for the daemon's verdict.
 * Returns a process exit code; every failure path prints the manual ssh
 * fallback so the operator is never stuck behind this wrapper. */
export async function runDrain(on: boolean, deps: DrainRunDeps): Promise<number> {
  const tui = deps.cfg.tui;
  deps.log(`drain ${on ? "on" : "off"} → ${tui.ssh_host}:${tui.remote_sandbox_root}/commands/`);
  const sender = new CommandDrainSender(tui, deps.ssh, deps.now, deps.sleep);
  const result = await sender.set(on);
  if (result.ok) {
    if (on) {
      deps.log(
        `✓ draining — ${result.running_rounds ?? 0} round(s) still finishing; deploy when \`qcr status\` shows rounds running: 0`,
      );
      if (result.issuer === "session") {
        // The daemon did not see the operator seal on commands/operator/ (the
        // directory was writable by its own uid), so it bounded this drain
        // like a session's. Saying so beats a drain that lifts mid-deploy.
        deps.log(
          `  ⚠ NOT an operator drain: the daemon found commands/operator/ unsealed and bounded it — lapses ${result.expires_at ?? "(unknown)"}`,
        );
        deps.log(
          "    check the directory is root-owned and 0755 in the container before deploying",
        );
      }
      deps.log(
        "  (auto-lifts on the new boot's first healthy reconcile — re-drain before each step of a multi-deploy window)",
      );
    } else {
      deps.log(
        `✓ drain lifted — ${result.dropped_deliveries ?? 0} webhook delivery(ies) were dropped; the reconcile poll recovers them`,
      );
    }
    return 0;
  }
  deps.log(`✖ drain refused: ${result.reason ?? "no reason given"}`);
  deps.log("manual fallback — run:");
  deps.log(`  ${drainManualSshCommand(tui, on, (deps.now ?? (() => new Date()))())}`);
  return 1;
}

/** `--local`: same command file, written straight into this machine's
 * sandbox commands/operator/ dir as the current user (in-container use; no
 * ssh). Fire-and-forget — the
 * local watcher's result lands in commands/results/. */
function runDrainLocal(on: boolean): number {
  const dir = join(sandboxRoot(), "commands", "operator");
  mkdirSync(dir, { recursive: true });
  const name = `${new Date().toISOString().replace(/[:.]/g, "-")}-cli-drain.json`;
  writeFileSync(join(dir, `.${name}.tmp`), drainPayload(on));
  renameSync(join(dir, `.${name}.tmp`), join(dir, name));
  console.log(
    `drain ${on ? "on" : "off"} command written to ${join(dir, name)} — result lands in commands/results/`,
  );
  console.log(
    "note: written as THIS user, so unless commands/operator/ is root-owned the daemon sees no operator seal and bounds the drain like a session's",
  );
  return 0;
}

async function cmdDrain(rest: string[]): Promise<number> {
  const sub = rest.find((a) => a === "on" || a === "off");
  if (!sub) throw new Error("usage: qcr drain <on|off> [--local]");
  const on = sub === "on";
  if (rest.includes("--local")) return runDrainLocal(on);
  // Honour [tui] target — on the laptop topology the same command
  // file write runs against local docker instead of ssh.
  const { runnerFor } = await import("./tui/remote.js");
  const cfg = loadConfig();
  return runDrain(on, { cfg, ssh: runnerFor(cfg.tui), log: (l) => console.log(l) });
}

/**
 * `qcr install <where|migrate>`. `where` prints what the install
 * locator resolves; `migrate` moves the checkout's old config.toml into the
 * install's config home, and every install profile out of the
 * checkout's `profiles/` — idempotent, and it never overwrites a differing
 * config or profile. Deliberately NOT loadConfig(): a config that does not
 * parse must still be movable. Both verbs cover the secrets too —
 * `where` names the secrets dir and the companion key file the locator picks
 * (without the configured `[github] secrets_dir`, which only a parsed config
 * knows), and `migrate` moves `~/.config/quickreview-bot/` into
 * `<config home>/secrets/` — and repoints a compose `.env` whose
 * `QCR_SECRETS_DIR` still names it. Nothing else reads those old
 * places, so `where` lists whatever is still STRANDED there, and
 * `migrate` is the one command that opens them.
 */
export function cmdInstall(
  rest: string[],
  deps: {
    root?: string;
    env?: InstallEnv & { QCR_OPENVIKING_KEYS?: string };
    log?: (line: string) => void;
  } = {},
): number {
  const root = deps.root ?? sandboxRoot();
  const env = deps.env ?? process.env;
  const log = deps.log ?? ((line: string) => console.log(line));
  switch (rest[0]) {
    case "where": {
      const located = locateConfig({ env });
      log(
        `config      ${located.path}  (${located.source}${existsSync(located.path) ? "" : ", missing"})`,
      );
      log(`config home ${located.home}`);
      log(`state home  ${stateHome(env)}`);
      log(
        `profiles    ${profileSearchDirs({ root, env }).join(" → ")}  (the checkout: generic examples only)`,
      );
      const secrets = locateSecrets({ env });
      const keys = locateKeysFile({ env });
      log(
        `secrets     ${secrets.path}  (${secrets.source}; a set [github] secrets_dir overrides it)`,
      );
      log(`memory keys ${keys.path}  (${keys.source})`);
      // Nothing reads the old places, so an install that
      // has not migrated is told what it is stranding, and the way out.
      const stranded = [
        strandedCheckoutConfig({ root, env }),
        ...strandedCheckoutProfiles({ root, env }),
        strandedLegacySecrets(env),
      ].filter((p): p is string => p !== null);
      for (const path of stranded)
        log(
          `stranded    ${path} — no longer read; \`qcr install migrate\` moves it into the homes`,
        );
      return 0;
    }
    case "migrate": {
      // The config, every install profile still in the checkout,
      // then the secrets — independent moves, so one refusal never
      // holds another back, and the exit code fails if any of them refused.
      const config = migrateReport(migrateConfig({ root, env }));
      const profiles = profileMigrateReport(migrateProfiles({ root, env }));
      const secrets = secretsMigrateReport(migrateSecrets({ env }));
      const compose = composeRepointReport(repointComposeSecrets({ root, env }));
      for (const line of [...config.lines, ...profiles.lines, ...secrets.lines, ...compose])
        log(line);
      return Math.max(config.code, profiles.code, secrets.code);
    }
    default:
      throw new Error("usage: qcr install <where|migrate>");
  }
}

function cmdAttach(target: string): void {
  // Live sessions run inside the quickreview container on the VM; locally the
  // tmux server is direct. Print the right invocation and exec it when local
  // tmux has the session.
  const session = /^\d+$/.test(target) ? `pr-${target}` : target;
  console.log(`attach: tmux attach -t ${session}`);
  console.log(`(on the VM: docker exec -it quickreview-sandbox tmux attach -t ${session})`);
}

function cmdEvents(tail: number, json: boolean): void {
  const store = openStore();
  try {
    const events = store.recentEvents(tail);
    if (json) {
      console.log(JSON.stringify({ events }));
      return;
    }
    for (const e of events) console.log(`${e.ts} ${e.kind}${e.pr ? ` #${e.pr}` : ""}`);
  } finally {
    store.close();
  }
}

/** `qcr companion up|down|status` — thin over CompanionLifecycle. */
export async function cmdCompanion(sub: string | undefined): Promise<void> {
  const { CompanionLifecycle, companionStateWord, realDockerRunner } =
    await import("./tui/companion.js");
  const cfg = loadConfig().companion;
  const lc = new CompanionLifecycle(cfg, realDockerRunner);
  switch (sub) {
    case "up": {
      // Mint the read-only GitHub token first. One-shot: nothing
      // refreshes it after this command exits (the TUI does, while it runs).
      const { CompanionGithubToken, tokenOutcomeLine } = await import("./tui/ghread.js");
      const { companionGithubDir } = await import("./install.js");
      const full = loadConfig();
      const gh = await new CompanionGithubToken({
        dir: companionGithubDir(),
        repo: full.github.repo,
        secretsDir: full.github.secrets_dir,
      }).refresh();
      console.log(`companion ${cfg.container_name}: ${tokenOutcomeLine(gh)}`);
      // One-shot too: the config mirror reflects the config as of now.
      const mirror = lc.syncConfigMirror();
      console.log(
        `companion ${cfg.container_name}: config mirror ${typeof mirror === "object" ? `NOT refreshed — ${mirror.failed}` : mirror}`,
      );
      const outcome = await lc.ensureUp();
      const born = await lc.spawnPi();
      console.log(
        `companion ${cfg.container_name}: ${outcome}; pi session ${born ? "spawned" : "already running"}`,
      );
      console.log(`attach: docker ${lc.attachArgv().join(" ")}`);
      return;
    }
    case "down":
      await lc.gracefulStop();
      console.log(`companion ${cfg.container_name}: stopped (volumes and conversation kept)`);
      return;
    case "status": {
      const st = await lc.status();
      const pi = st.running ? await lc.piRunning() : false;
      console.log(
        `companion ${cfg.container_name}: ${companionStateWord(st)}` +
          `${st.running ? ` · pi session ${pi ? "live" : "down"}` : ""}`,
      );
      // Unknown is not an answer: a script reading the exit code must not
      // take "docker could not be asked" for "no container".
      if (st.unknown !== undefined) process.exitCode = 1;
      return;
    }
    case "rebuild": {
      // The image is otherwise built ONLY when it is missing, so an
      // entrypoint or Dockerfile change never reaches a machine that already
      // has one — it just keeps starting yesterday's image. This is the
      // explicit "apply what I changed" path. The pihome volume is untouched,
      // so OAuth and the conversation survive; only the container and image
      // are replaced.
      await lc.removeContainer();
      await lc.buildImage((line) => console.log(line));
      const outcome = await lc.ensureUp((line) => console.log(line));
      const born = await lc.spawnPi();
      console.log(
        `companion ${cfg.container_name}: image rebuilt, ${outcome}; pi session ${born ? "spawned" : "already running"}`,
      );
      return;
    }
    default:
      throw new Error("usage: qcr companion <up|down|status|rebuild>");
  }
}

/**
 * `qcr memory reembed [--user <name>[,<name>…]]` — the operator's
 * half of the embedder migration, run from the PC that holds the keys.
 *
 * The daemon re-embeds ITS OWN namespace (the reviewer's) by itself once the
 * server is ready; it holds no other key and never will (root CLAUDE.md rule
 * 8), so the companion's namespace — and any other provisioned user's — is
 * rebuilt from here, over the memory forward, with the keys in the operator's
 * keys file. Default: every provisioned user EXCEPT the daemon's own. The
 * reindex is an idempotent upsert, so re-running it (or naming the reviewer
 * too) is safe, only slow. Nothing but the request leaves this machine: no
 * key ever reaches an argv or the output.
 */
export async function cmdMemory(rest: string[]): Promise<number> {
  const sub = rest[0];
  if (sub === "relayout") return cmdMemoryRelayout(rest.slice(1));
  if (sub !== "reembed") throw new Error(MEMORY_USAGE);
  const cfg = loadConfig();
  const own = cfg.openviking.user;
  const userIdx = rest.indexOf("--user");
  const users =
    userIdx >= 0
      ? String(rest[userIdx + 1] ?? "")
          .split(/[,\s]+/)
          .filter(Boolean)
      : cfg.openviking.provision_users.filter((u) => u !== own);
  if (users.length === 0)
    throw new Error(
      "usage: qcr memory reembed [--user <name>[,<name>…]] — no namespace to re-embed",
    );
  const [
    { loadReembedModule, reembedNamespaces },
    { USER_KEY_ENV, keysFileReader, tuiMemoryBaseUrl },
    { keysFilePath },
  ] = await Promise.all([
    import("./openviking/reembed.js"),
    import("./tui/memory.js"),
    import("./tui/companion.js"),
  ]);
  const keysFile = keysFilePath(process.env);
  const readKey = keysFileReader(keysFile);
  const base = tuiMemoryBaseUrl(process.env);
  console.log(
    `re-embedding ${users.join(", ")} through ${base} with the keys in ${keysFile} (this can take minutes per namespace)`,
  );
  const { ok, results } = await reembedNamespaces({
    module: await loadReembedModule(sandboxRoot()),
    base,
    users,
    keyFor: (user) => {
      const names = (USER_KEY_ENV as Record<string, readonly string[]>)[user] ?? [
        `OPENVIKING_${user.toUpperCase()}_KEY`,
      ];
      for (const name of names) {
        const v = readKey(name);
        if (v) return v;
      }
      return null;
    },
    log: (line) => console.log(line),
  });
  for (const r of results) console.log(`  ${r.user}: ${r.status} — ${r.detail}`);
  if (ok) {
    console.log(
      "done. The daemon's journal still lists these namespaces as awaiting you; receipt them in the container so the heartbeat stops naming them:\n" +
        users
          .map(
            (u) =>
              `  docker exec ${cfg.tui.container} node /opt/quickreview/sandbox/scripts/openviking-reembed.mjs settle --home ${cfg.openviking.home} --user ${u}`,
          )
          .join("\n"),
    );
  }
  return ok ? 0 : 1;
}

const MEMORY_USAGE =
  "usage: qcr memory reembed [--user <name>[,<name>…]] | qcr memory relayout [--plan|--apply] [--user <name>]";

/**
 * The flags of `qcr memory relayout`, or the usage error. `--plan` is the
 * default and writes nothing; only an explicit `--apply` writes, and the two
 * together are refused. `--user` must name a plain namespace; without it the
 * default (the daemon's `[openviking] user`) is asked for, lazily, so a bad
 * flag is reported before any config is read. An unknown token is refused
 * rather than ignored — a mistyped `--apply` must not quietly plan instead.
 */
export function parseRelayoutArgs(
  rest: readonly string[],
  defaultUser: () => string,
): { apply: boolean; user: string } {
  let apply = false;
  let plan = false;
  let user: string | null = null;
  for (let i = 0; i < rest.length; i += 1) {
    const arg = rest[i]!;
    if (arg === "--apply") apply = true;
    else if (arg === "--plan") plan = true;
    else if (arg === "--user" && user === null) {
      user = String(rest[i + 1] ?? "").trim();
      i += 1;
    } else throw new Error(MEMORY_USAGE);
  }
  if (apply && plan) throw new Error(MEMORY_USAGE);
  const name = user ?? defaultUser();
  if (!/^[a-z][a-z0-9_-]*$/.test(name)) throw new Error(MEMORY_USAGE);
  return { apply, user: name };
}

/**
 * `qcr memory relayout [--plan|--apply] [--user <name>]` — sort
 * one memory namespace (default: the daemon's, `[openviking] user`) into the
 * memory layout (src/memory/layout.ts). `--plan` (the default) prints where every entry goes;
 * `--apply` carries the plan out and reads the store again to show what is
 * left — idempotent, so a second `--apply` plans nothing. Run from the PC
 * that holds the keys, over the memory forward, like `reembed`; the daemon
 * never runs it. Nothing is deleted: a move leaves a retired stub, a
 * retirement is a tag.
 */
export async function cmdMemoryRelayout(rest: string[]): Promise<number> {
  const { apply, user } = parseRelayoutArgs(rest, () => loadConfig().openviking.user);
  const [
    { USER_KEY_ENV, keysFileReader, tuiMemoryBaseUrl },
    { keysFilePath },
    { OpenVikingClient },
    { OpenVikingStore },
    { runRelayout },
  ] = await Promise.all([
    import("./tui/memory.js"),
    import("./tui/companion.js"),
    import("./openviking/client.js"),
    import("./openviking/store.js"),
    import("./openviking/relayout.js"),
  ]);
  const keysFile = keysFilePath(process.env);
  const readKey = keysFileReader(keysFile);
  const names = (USER_KEY_ENV as Record<string, readonly string[]>)[user] ?? [
    `OPENVIKING_${user.toUpperCase()}_KEY`,
  ];
  const key = names.map((n) => readKey(n)).find((v) => v) ?? null;
  if (!key) {
    console.log(`no key for the ${user} namespace in ${keysFile} (${names.join(" or ")})`);
    return 1;
  }
  const base = tuiMemoryBaseUrl(process.env);
  const client = new OpenVikingClient({ baseUrl: base, apiKey: key, user, timeoutMs: 30_000 });
  // Every read is a fresh, full one: the plan must describe the store as it
  // is now, not a cached sweep.
  const store = new OpenVikingStore({ client, cacheTtlMs: 0, fullRefreshMs: 0 });
  console.log(`${apply ? "applying" : "planning"} the relayout of ${user} memory through ${base}`);
  const out = await runRelayout(store, { apply, log: (line) => console.log(line) });
  return out.ok ? 0 : 1;
}

const SETUP_USAGE = "usage: qcr setup [validate [<profile>] | commit]";

/**
 * `qcr setup` — set up the reviewed repo with the companion.
 *   qcr setup                     ask the companion to run its setup skill (an
 *                                 inject into its column; open `qcr tui`)
 *   qcr setup validate [profile]  the daemon's own check of a repo profile as
 *                                 it is on disk — for a direct edit
 *   qcr setup commit              carry out the profile commits setup asked
 *                                 for (the TUI does this on its own timer)
 */
export async function cmdSetup(rest: string[]): Promise<number> {
  const sub = rest[0];
  if (sub === "validate") {
    const { checkProfile, describeCheck, readProfileTarget } = await import("./setup/profile.js");
    const home = { root: sandboxRoot(), env: process.env };
    let name = rest[1]?.trim() ?? "";
    if (name === "") {
      const t = readProfileTarget(home);
      if (t.state !== "ok") {
        console.log(`✖ ${t.error}`);
        return 1;
      }
      name = t.named;
    }
    if (name === "") {
      console.log("the live config names no repo profile — name one: qcr setup validate <profile>");
      return 1;
    }
    const check = checkProfile(home, name);
    console.log(describeCheck(name, check));
    return check.ok ? 0 : 1;
  }
  if (sub === "commit") {
    const { commitRequestedProfiles, commitLine } = await import("./tui/setupentry.js");
    const results = commitRequestedProfiles();
    if (results.length === 0) console.log("no profile commits waiting");
    for (const r of results) console.log(commitLine(r));
    return results.some((r) => r.state === "failed" || r.state === "refused") ? 1 : 0;
  }
  if (sub !== undefined) throw new Error(SETUP_USAGE);
  const { requestSetup, commitRequestedProfiles, commitLine } = await import("./tui/setupentry.js");
  const { companionInjectDir } = await import("./tui/companion.js");
  const cfg = loadConfig();
  for (const r of commitRequestedProfiles()) console.log(commitLine(r));
  const file = requestSetup({ injectDir: companionInjectDir(cfg.companion) });
  if (!cfg.companion.enabled) {
    console.log(
      `the request is queued (${file}), but [companion] enabled = false — the companion never starts, so nothing ` +
        "picks it up until you turn it on. Setup runs in the companion.",
    );
    return 1;
  }
  console.log(
    `asked the companion to set up ${cfg.github.repo} (${file}).\n` +
      "Open `qcr tui` — the companion column picks it up (at its next start, if it is not running) and walks you through " +
      "the survey and the interview. Nothing reaches PR reviews until you deploy the profile it writes.",
  );
  return 0;
}

/** `qcr onboard` — the guided setup wizard: pi at the pinned
 * version via npx (works from a bare clone; pi stays a non-dependency), the
 * onboarding prompt + extension + a restricted tool set, then the TUI handoff
 * when the checklist verifies complete. Resumable: run it again after a crash
 * and completed steps are re-verified, not repeated. */
export async function cmdOnboard(): Promise<number> {
  const { piPinFromPackageJson, onboardingSessionDir, runOnboard } =
    await import("./onboard/launch.js");
  const { checklistComplete } = await import("./onboard/engine.js");
  const { spawn } = await import("node:child_process");
  const root = sandboxRoot();
  // Pin source: config.toml [pi] when it loads; package.json's "pi" block on a
  // bare clone (config.toml is written later, BY onboarding). Same pinned
  // version by the rule-7 mirror discipline.
  let pin: { package: string; version: string } | null = null;
  try {
    const { package: pkg, version } = loadConfig().pi;
    pin = { package: pkg, version };
  } catch {
    pin = piPinFromPackageJson(root);
  }
  if (!pin)
    throw new Error(
      'onboard: pi pin not found (need config.toml [pi] or the package.json "pi" block)',
    );
  mkdirSync(onboardingSessionDir(root), { recursive: true });
  const run = (cmd: string, args: string[]): Promise<number> =>
    new Promise((resolvePromise) => {
      const child = spawn(cmd, args, {
        stdio: "inherit",
        cwd: root,
        env: { ...process.env, QCR_ROOT: root },
      });
      child.on("error", (err) => {
        console.error(`onboard: ${cmd} failed to start: ${err.message}`);
        resolvePromise(1);
      });
      child.on("close", (code) => resolvePromise(code ?? 1));
    });
  return runOnboard({
    pin,
    root,
    spawn: run,
    isComplete: () => checklistComplete(join(root, "state")),
    log: (line) => console.log(line),
    cliPath: join(root, "dist", "src", "cli.js"),
  });
}

export const ARCHIVE_USAGE =
  "usage: qcr archive status [--plan] [--json] | qcr archive run | qcr archive restore <pr> | " +
  "qcr archive extract <pr> --to <dir>";

/** `qcr archive` arguments. An unknown token is refused, so a
 * mistyped `--plan` cannot quietly print the block alone. */
export type ArchiveArgs =
  | { verb: "status"; plan: boolean }
  | { verb: "run" }
  | { verb: "restore"; pr: number }
  | { verb: "extract"; pr: number; to: string };

export function parseArchiveArgs(rest: readonly string[]): ArchiveArgs {
  const prOf = (v: string | undefined): number => {
    const n = Number(v);
    if (v === undefined || !/^[1-9]\d*$/.test(v) || !Number.isSafeInteger(n))
      throw new Error(ARCHIVE_USAGE);
    return n;
  };
  switch (rest[0]) {
    case "status": {
      let plan = false;
      for (const a of rest.slice(1)) {
        if (a === "--plan") plan = true;
        else throw new Error(ARCHIVE_USAGE);
      }
      return { verb: "status", plan };
    }
    case "run":
      if (rest.length !== 1) throw new Error(ARCHIVE_USAGE);
      return { verb: "run" };
    case "restore":
      if (rest.length !== 2) throw new Error(ARCHIVE_USAGE);
      return { verb: "restore", pr: prOf(rest[1]) };
    case "extract": {
      const pr = prOf(rest[1]);
      if (rest.length !== 4 || rest[2] !== "--to" || !rest[3] || rest[3].startsWith("-"))
        throw new Error(ARCHIVE_USAGE);
      return { verb: "extract", pr, to: rest[3] };
    }
    default:
      throw new Error(ARCHIVE_USAGE);
  }
}

/**
 * `qcr archive …`:
 *   - `status [--plan] [--json]` — read-only, in this process. The daemon's
 *     status.json `archive` block, the archive ledger (`archive_prs`) — and
 *     with `--plan`, a plan computed HERE, now (tmux asked in this container;
 *     the daemon's in-flight births are not visible from a CLI, and the daemon
 *     re-checks them before anything moves). Moves nothing.
 *   - `run`, `restore <pr>` — the operator's two verbs: ONE command file
 *     written as root into the sealed `commands/operator/` (the kill switch's
 *     channel), confirmed by the daemon's own result file. The daemon runs
 *     them under the archiver's strict mutex.
 *   - `extract <pr> --to <dir>` — read-only over the archive: the PR's
 *     archive decompressed into a scratch dir, every byte sha-verified, never
 *     into a live tree. Runs where the archive is (the container).
 */
async function cmdArchive(rest: readonly string[], json: boolean): Promise<number> {
  const args = parseArchiveArgs(rest);
  const cfg = loadConfig();
  if (args.verb === "run" || args.verb === "restore") {
    const { runnerFor } = await import("./tui/remote.js");
    const { ArchiveOpSender, renderArchiveOp } = await import("./tui/archiveops.js");
    const cmd: import("./tui/archiveops.js").ArchiveOpCommand =
      args.verb === "run"
        ? { command: "archive-run" }
        : { command: "archive-restore", pr: args.pr };
    if (!json)
      console.log(
        `${cmd.command}${"pr" in cmd ? ` ${cmd.pr}` : ""} → ${cfg.tui.ssh_host}:${cfg.tui.remote_sandbox_root}/commands/operator/`,
      );
    const res = await new ArchiveOpSender(cfg.tui, runnerFor(cfg.tui)).send(cmd);
    if (json) console.log(JSON.stringify(res));
    else for (const line of renderArchiveOp(cmd, res)) console.log(line);
    return res.ok ? 0 : 1;
  }
  const root = sandboxRoot();
  const { archivePolicy } = await import("./archive/archiver.js");
  const policy = archivePolicy(cfg.archive);
  if (args.verb === "extract") {
    const { extractPr } = await import("./archive/extract.js");
    const res = await extractPr({
      root,
      sessionsRoot: join(root, cfg.pi.session_dir),
      pr: args.pr,
      to: args.to,
      bytesPerS: policy.maxBytesPerS,
    });
    if (json) console.log(JSON.stringify(res));
    else if (!res.ok) console.log(`✖ refused: ${res.reason}`);
    else {
      const written = res.files.filter((f) => f.outcome === "written").length;
      console.log(
        `✓ pr-${args.pr} extracted to ${res.dir}: ${res.files.length} file(s) verified by sha256 ` +
          `(${written} written, ${res.files.length - written} already there)` +
          (res.copied.length > 0 ? `; copied as they are: ${res.copied.join(", ")}` : ""),
      );
      for (const e of res.errors) console.log(`✖ ${e.path}: ${e.error}`);
    }
    return res.ok && res.errors.length === 0 ? 0 : 1;
  }
  const statusPath = join(stateDir(), "status.json");
  const { archiveLedgerSummary, archiveStatusJson, readArchiveBlockFile, renderArchiveReport } =
    await import("./archive/report.js");
  const { block, statusNote, archiveRead } = readArchiveBlockFile(statusPath);
  const store = openStore();
  try {
    const ledger = archiveLedgerSummary(store);
    let plan: import("./archive/plan.js").ArchivePlan | null = null;
    if (args.plan) {
      const { computePlan } = await import("./archive/plan.js");
      const { Tmux } = await import("./tmux.js");
      const tmux = new Tmux();
      const { piGlobalSessionsDir } = await import("./archive/piglobal.js");
      plan = await computePlan({
        store,
        root,
        sessionsRoot: join(root, cfg.pi.session_dir),
        now: () => new Date(),
        afterDays: cfg.archive.after_days,
        eventsAfterDays: cfg.archive.events_after_days,
        liveSessions: () => tmux.listSessionsKnown(),
        // This process's home: run in the container, the pihome volume.
        piGlobalDir: piGlobalSessionsDir(),
      });
    }
    if (json)
      console.log(
        JSON.stringify(archiveStatusJson({ block, archiveRead, statusNote, ledger, policy, plan })),
      );
    else console.log(renderArchiveReport({ block, statusNote, ledger, policy, plan }));
    return 0;
  } finally {
    store.close();
  }
}

export async function main(argv: string[]): Promise<void> {
  const json = argv.includes("--json");
  argv = argv.filter((a) => a !== "--json");
  const [cmd, ...rest] = argv;
  switch (cmd) {
    case "checklist": {
      const { cmdChecklist } = await import("./cliops.js");
      process.exitCode = await cmdChecklist();
      return;
    }
    case "compare": {
      const prs = rest.map(Number);
      if (prs.length === 0 || prs.some((n) => !Number.isInteger(n)))
        throw new Error("usage: qcr compare <pr-number...>");
      const { cmdCompare } = await import("./cliops.js");
      process.exitCode = await cmdCompare(prs);
      return;
    }
    case "metrics": {
      const prIdx = rest.indexOf("--pr");
      const pr = prIdx >= 0 ? Number(rest[prIdx + 1]) : null;
      if (pr !== null && !Number.isInteger(pr))
        throw new Error("usage: qcr metrics [--pr <pr-number>] [--json]");
      return cmdMetrics(pr, json);
    }
    case "backfill": {
      const limitIdx = rest.indexOf("--limit");
      const limit = limitIdx >= 0 ? Number(rest[limitIdx + 1]) : undefined;
      if (limit !== undefined && (!Number.isInteger(limit) || limit < 0)) {
        throw new Error("usage: qcr backfill [--dry-run] [--limit <n>] [--json]");
      }
      return cmdBackfill(rest.includes("--dry-run"), limit, json);
    }
    case "history": {
      process.exitCode = await cmdHistory(rest);
      return;
    }
    case "outcomes": {
      process.exitCode = await cmdOutcomes(rest, json);
      return;
    }
    case "lessons": {
      process.exitCode = await cmdLessons(rest, json);
      return;
    }
    case "regression": {
      process.exitCode = await cmdRegression(rest, json);
      return;
    }
    case "status":
      return cmdStatus();
    case "spend":
      return cmdSpend();
    case "today": {
      if (json) {
        const store = openStore();
        try {
          console.log(JSON.stringify(todayJson(store, new Date().toISOString().slice(0, 10))));
        } finally {
          store.close();
        }
        return;
      }
      return cmdToday();
    }
    case "why": {
      const n = Number(rest[0]);
      if (!Number.isInteger(n)) throw new Error("usage: qcr why <pr-number> [--json]");
      if (json) {
        const store = openStore();
        try {
          const payload = whyJson(store, n, join(sandboxRoot(), "archive", `pr-${n}`));
          console.log(JSON.stringify(await enrichWhy(payload)));
        } finally {
          store.close();
        }
        return;
      }
      return cmdWhy(n);
    }
    case "events": {
      const tailIdx = rest.indexOf("--tail");
      const tail = tailIdx >= 0 ? Number(rest[tailIdx + 1]) : 40;
      if (!Number.isInteger(tail) || tail <= 0)
        throw new Error("usage: qcr events [--tail <k>] [--json]");
      return cmdEvents(tail, json);
    }
    case "tui": {
      const { runTui } = await import("./tui/index.js");
      return runTui(rest);
    }
    case "companion":
      return cmdCompanion(rest[0]);
    case "memory": {
      process.exitCode = await cmdMemory(rest);
      return;
    }
    case "onboard": {
      process.exitCode = await cmdOnboard();
      return;
    }
    case "setup": {
      process.exitCode = await cmdSetup(rest);
      return;
    }
    case "drain": {
      process.exitCode = await cmdDrain(rest);
      return;
    }
    case "archive": {
      process.exitCode = await cmdArchive(rest, json);
      return;
    }
    case "install": {
      process.exitCode = cmdInstall(rest);
      return;
    }
    case "attach": {
      if (!rest[0]) throw new Error("usage: qcr attach <pr-number|session>");
      return cmdAttach(rest[0]);
    }
    default:
      console.log(
        "usage: qcr <onboard|setup [validate [<profile>]|commit]|status|spend|today|why <n>|metrics [--pr <n>]|events|attach <n>|tui [pr|overseer]|drain <on|off>|archive <status [--plan]|run|restore <pr>|extract <pr> --to <dir>>|install <where|migrate>|" +
          "companion <up|down|status|rebuild>|memory reembed [--user <name>]|memory relayout [--plan|--apply]|backfill [--dry-run] [--limit <n>]|history <digest|pull>|outcomes [--days <n>] [--capture [--read-github]]|lessons [mine|shadow-report [--days <n>]|off|on|suppress <id>|unsuppress <id>]|checklist|compare <pr...>|" +
          "regression [--set <path>] [--clone <path>] [--change <name>] [--limit <n>] [--out <path>]>",
      );
      loadConfig(); // surface config errors early even on bad usage
  }
}

if (process.argv[1]?.endsWith("cli.js")) {
  void main(process.argv.slice(2));
}
