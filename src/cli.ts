// qcr — the operator CLI. Read-only against state/ (status.json + state.db);
// `attach` wraps tmux/docker-exec. Subcommands land across slices: status and
// spend here (B1); today/why in B5; checklist/compare in B6.
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

export { drainPayload } from "./tui/deploy-drain.js";

function stateDir(): string {
  return join(sandboxRoot(), "state");
}

function openStore(): StateStore {
  return new StateStore(join(stateDir(), "state.db"));
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
    // every held PR says who holds it and when the hold lapses.
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
    // est_usd is the ONE spend field (legacy spend_usd folded into it
    // at boot). Expired rounds ARE counted: they blew a deadline,
    // they did not get a refund — excluding them erased real token cost.
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
      // A cancelled round says WHY inline — its status alone was
      // exactly the thing nobody could read back.
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
  /** GitHub conversation surface — present only when the enrichment fetch
   * succeeded (needs the app credential; degrades silently without it). */
  description?: string;
  labels?: string[];
  comments?: Array<{ author: string; body: string; created_at: string }>;
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
 * answer, and it is the answer that used to be missing entirely. */
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
  // the replay plans rounds with `buildPassPlan`, so it must see the
  // profile's per-lens tuning exactly as the daemon does (wire.ts buildParts)
  // — otherwise a lens the profile switched off would be replayed.
  const { applyProfileTuning } = await import("./lenstuning.js");
  const { loadProfileLensTuning } = await import("./profiles.js");
  const loaded = loadConfig();
  const { loadProfilePosting } = await import("./profiles.js");
  const { applyProfilePosting } = await import("./postingpolicy.js");
  const cfg = applyProfilePosting(
    applyProfileTuning(loaded, loadProfileLensTuning(root, loaded.review.profile)),
    loadProfilePosting(root, loaded.review.profile),
  );
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

// ---- deploy-window drain (2026-08-25) -------------------------------------
//
// `qcr drain on|off` follows the TUI unwedge precedent EXACTLY: ONE validated
// command file written into the daemon's existing commands/ dir (docker exec
// over ssh, payload on stdin, tmp+mv), then the daemon's own result file read
// back. src/commands.ts re-validates against the same whitelist and the same
// tier gate; nothing here touches GitHub or goes near the MutationGate.
// `--local` writes the file into THIS machine's sandbox commands/ dir instead
// (for running inside the container or against a local dev daemon).

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
 * sandbox commands/ dir (in-container use; no ssh). Fire-and-forget — the
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
  // honour [tui] target — on the laptop topology the same command
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
 * parse must still be movable.: both verbs cover the secrets too —
 * `where` names the secrets dir and the companion key file the locator picks
 * (without the configured `[github] secrets_dir`, which only a parsed config
 * knows), and `migrate` moves `~/.config/quickreview-bot/` into
 * `<config home>/secrets/` — and repoints a compose `.env` whose
 * `QCR_SECRETS_DIR` still names it.: nothing else reads those old
 * places any more, so `where` lists whatever is still STRANDED there, and
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
      // nothing reads the old places any more, so an install that
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
      // mint the read-only GitHub token first. One-shot: nothing
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
  if (sub !== "reembed") throw new Error("usage: qcr memory reembed [--user <name>[,<name>…]]");
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
        "usage: qcr <onboard|setup [validate [<profile>]|commit]|status|spend|today|why <n>|metrics [--pr <n>]|events|attach <n>|tui [pr|overseer]|drain <on|off>|install <where|migrate>|" +
          "companion <up|down|status|rebuild>|memory reembed [--user <name>]|backfill [--dry-run] [--limit <n>]|history <digest|pull>|checklist|compare <pr...>|" +
          "regression [--set <path>] [--clone <path>] [--change <name>] [--limit <n>] [--out <path>]>",
      );
      loadConfig(); // surface config errors early even on bad usage
  }
}

if (process.argv[1]?.endsWith("cli.js")) {
  void main(process.argv.slice(2));
}
