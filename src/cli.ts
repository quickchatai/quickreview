// qcr — the operator CLI. Read-only against state/ (status.json + state.db);
// `attach` wraps tmux/docker-exec. Subcommands land across slices: status and
// spend here (B1); today/why in B5; checklist/compare in B6.
import { readFileSync, existsSync, mkdirSync, readdirSync, renameSync, writeFileSync } from "node:fs";
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
import { computeMetrics, computeTimeline, readOps, renderMetrics, renderTimeline } from "./metrics.js";

function stateDir(): string {
  return join(sandboxRoot(), "state");
}

function openStore(): StateStore {
  return new StateStore(join(stateDir(), "state.db"));
}

export function renderStatus(snapshot: StatusSnapshot): string {
  const lines: string[] = [];
  const mode = snapshot.dry_run ? "DRY-RUN" : "LIVE";
  lines.push(`quickreview — ${mode} — snapshot ${snapshot.written_at}`);
  if (snapshot.digest_headline) lines.push(`digest: ${snapshot.digest_headline}`);
  lines.push(`rounds running: ${snapshot.running_rounds}   total spend: $${snapshot.total_spend_usd.toFixed(2)}`);
  if (snapshot.draining) {
    lines.push(
      `DRAINING${snapshot.draining_since ? ` since ${snapshot.draining_since}` : ""} — ` +
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
        `#${String(pr.number).padEnd(5)} ${pr.state.padEnd(17)} ${(pr.stale_recheck ? "yes" : "-").padEnd(6)} ${pr.head_sha.slice(0, 10).padEnd(11)} ${pr.title.slice(0, 60)}`,
      );
    }
  }
  return lines.join("\n");
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
      .prepare("SELECT COALESCE(SUM(tokens_in), 0) AS tin, COALESCE(SUM(tokens_out), 0) AS tout FROM rounds")
      .get() as { tin: number; tout: number };
    const todayIn = todayRounds.reduce((n, r) => n + (r.tokens_in ?? 0), 0);
    const todayOut = todayRounds.reduce((n, r) => n + (r.tokens_out ?? 0), 0);
    console.log(`total spend: $${total.toFixed(2)} (est) — ${totals.tin} in / ${totals.tout} out tokens`);
    console.log(`today (${today}): $${todaySpend.toFixed(2)} across ${todayRounds.length} rounds — ${todayIn} in / ${todayOut} out tokens`);
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
      const tokens = r.tokens_in !== null || r.tokens_out !== null ? ` tok=${r.tokens_in ?? 0}/${r.tokens_out ?? 0}` : "";
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
  rounds: Array<{ round_no: number; round_type: string; status: string; verdict: string | null; started_at: string; finished_at: string | null; spend_usd: number | null; est_usd?: number | null; tokens_in?: number | null; tokens_out?: number | null; lenses: string; summary?: string | null; cancel_cause?: string | null }>;
  threads: { open: number; total: number };
  ledger?: string;
  archive?: string[];
  /** GitHub conversation surface — present only when the enrichment fetch
   * succeeded (needs the app credential; degrades silently without it). */
  description?: string;
  labels?: string[];
  comments?: Array<{ author: string; body: string; created_at: string }>;
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
    const gate = new MutationGate(true, join(sandboxRoot(), "state", "dryrun"), async () => undefined);
    const adapter = new GitHubAdapter(cfg, new TokenMinter(secretsDir ?? cfg.github.secrets_dir), gate);
    const convo = await adapter.prConversation(payload.pr, 3);
    return { ...payload, description: convo.body, labels: convo.labels, comments: convo.comments };
  } catch {
    return payload;
  }
}

export function whyJson(store: StateStore, n: number, archiveDir: string): WhyPayload {
  const pr = store.getPr(n);
  const rounds = store.db.prepare("SELECT * FROM rounds WHERE pr = ? ORDER BY round_no").all(n) as any[];
  const threadTotal = store.db.prepare("SELECT COUNT(*) AS c FROM bot_comments WHERE pr = ?").get(n) as { c: number };
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
      finished_at: r.finished_at ?? null,
      spend_usd: r.spend_usd ?? null,
      est_usd: r.est_usd ?? null,
      tokens_in: r.tokens_in ?? null,
      tokens_out: r.tokens_out ?? null,
      lenses: r.lenses,
      summary: r.summary ?? null,
      // Why a cancelled round was cancelled — null on every other
      // status. The TUI's detail pane reads this beside the prose summary.
      cancel_cause: r.cancel_cause ?? null,
    })),
    // The registry knows every bot thread; "open" needs GitHub truth the
    // daemon doesn't mirror, so it is reported as total until archived.
    threads: { open: threadTotal.c, total: threadTotal.c },
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
 * metrics payload carries, scoped to one Warsaw-agnostic ISO date so `qcr
 * today` can print it beside the rounds it explains. */
export function cancellationsOn(store: StateStore, date: string): CancellationTally[] {
  const counts = new Map<string, number>();
  for (const r of store.roundsOn(date)) {
    if (r.status !== "cancelled") continue;
    const cause = (r.cancel_cause ?? "unknown") as CancelCause;
    counts.set(cause, (counts.get(cause) ?? 0) + 1);
  }
  return [...counts.entries()]
    .map(([cause, count]) => ({ cause: cause as CancelCause, count, loud: isLoudCancelCause(cause) }))
    .sort((a, b) => Number(b.loud) - Number(a.loud) || b.count - a.count || a.cause.localeCompare(b.cause));
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

function cmdWhy(n: number): void {
  const archiveDir = join(sandboxRoot(), "archive", `pr-${n}`);
  const store = openStore();
  try {
    const pr = store.getPr(n);
    if (pr) console.log(`#${n} state=${pr.state} head=${pr.head_sha.slice(0, 10)} stale=${pr.stale_recheck} "${pr.title}"`);
    const rounds = store.db.prepare("SELECT * FROM rounds WHERE pr = ? ORDER BY round_no").all(n) as any[];
    for (const r of rounds) console.log(`round ${r.round_no} (${r.round_type}) [${r.status}] verdict=${r.verdict ?? "—"} started=${r.started_at}`);
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
    const payload = computeMetrics(store);
    // The operational half is file-derived: status.json (heartbeat/dry-run/
    // concurrency) + the BUILD_SHA marker deploy.sh writes into the sandbox
    // root. parseBuildSha is deploytab's — the marker format has one parser.
    const { parseBuildSha } = await import("./tui/deploytab.js");
    payload.ops = readOps(
      { statusPath: join(stateDir(), "status.json"), buildShaPath: join(sandboxRoot(), "BUILD_SHA") },
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
export async function cmdBackfill(dryRun: boolean, limit: number | undefined, json: boolean): Promise<void> {
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
  const { nodeReplayIo, parseRegressionArgs, readCaseSet, runRegressionCli, ScratchReplay } = await import("./replay.js");
  const cfg = loadConfig();
  const root = sandboxRoot();
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

/** The exact command payload — built here so this module cannot produce any
 * other command. */
export function drainPayload(on: boolean): string {
  return `${JSON.stringify({ command: "drain", on }, null, 2)}\n`;
}

/** The documented manual fallback: the exact ssh one-liner that writes the
 * same command file by hand when the runner path fails. */
export function drainManualSshCommand(tui: TuiConfig, on: boolean): string {
  const dir = `${tui.remote_sandbox_root}/commands`;
  const docker = `${tui.sudo_docker ? "sudo " : ""}docker exec -i ${tui.container}`;
  return (
    `printf '%s' '${JSON.stringify({ command: "drain", on })}' | ` +
    `ssh ${tui.ssh_host} "${docker} sh -c 'cat > ${dir}/drain-manual.json'"`
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
  const { commandFileName, commandResultArgv, commandWriteArgv } = await import("./tui/unwedge.js");
  const tui = deps.cfg.tui;
  const now = deps.now ?? (() => new Date());
  const sleep = deps.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const name = commandFileName(now(), 0);
  deps.log(`drain ${on ? "on" : "off"} → ${tui.ssh_host}:${tui.remote_sandbox_root}/commands/${name}`);
  const write = await deps.ssh(tui.ssh_host, commandWriteArgv(tui, name), { stdin: drainPayload(on) });
  if (!write.ok) {
    deps.log(`✖ command write failed (${write.stderr.trim() || `exit ${write.code}`})`);
    deps.log("manual fallback — run:");
    deps.log(`  ${drainManualSshCommand(tui, on)}`);
    return 1;
  }
  // Read the daemon's own verdict rather than assuming the write was the
  // outcome — a refusal (tier belt, unwired dep) is a real answer.
  const deadline = now().getTime() + tui.msg_timeout_s * 1000;
  while (now().getTime() < deadline) {
    await sleep(2000);
    const probe = await deps.ssh(tui.ssh_host, commandResultArgv(tui, name));
    if (!probe.ok) continue;
    const body = probe.stdout.trim();
    if (body === "pending" || body === "") continue;
    let result: { ok?: unknown; reason?: unknown; running_rounds?: unknown; dropped_deliveries?: unknown };
    try {
      result = JSON.parse(body) as typeof result;
    } catch {
      deps.log("✖ unreadable result file");
      return 1;
    }
    if (result.ok === true) {
      if (on) {
        const rounds = typeof result.running_rounds === "number" ? result.running_rounds : "?";
        deps.log(`✓ draining — ${rounds} round(s) still finishing; deploy when \`qcr status\` shows rounds running: 0`);
        deps.log("  (auto-lifts on the new boot's first healthy reconcile — re-drain before each step of a multi-deploy window)");
      } else {
        const dropped = typeof result.dropped_deliveries === "number" ? result.dropped_deliveries : 0;
        deps.log(`✓ drain lifted — ${dropped} webhook delivery(ies) were dropped; the reconcile poll recovers them`);
      }
      return 0;
    }
    deps.log(`✖ drain refused: ${String(result.reason ?? "no reason given")}`);
    return 1;
  }
  deps.log("✖ no result before the timeout (daemon down?)");
  deps.log("manual fallback — run:");
  deps.log(`  ${drainManualSshCommand(tui, on)}`);
  return 1;
}

/** `--local`: same command file, written straight into this machine's
 * sandbox commands/ dir (in-container use; no ssh). Fire-and-forget — the
 * local watcher's result lands in commands/results/. */
function runDrainLocal(on: boolean): number {
  const dir = join(sandboxRoot(), "commands");
  mkdirSync(dir, { recursive: true });
  const name = `${new Date().toISOString().replace(/[:.]/g, "-")}-cli-drain.json`;
  writeFileSync(join(dir, `.${name}.tmp`), drainPayload(on));
  renameSync(join(dir, `.${name}.tmp`), join(dir, name));
  console.log(`drain ${on ? "on" : "off"} command written to ${join(dir, name)} — result lands in commands/results/`);
  return 0;
}

async function cmdDrain(rest: string[]): Promise<number> {
  const sub = rest.find((a) => a === "on" || a === "off");
  if (!sub) throw new Error("usage: qcr drain <on|off> [--local]");
  const on = sub === "on";
  if (rest.includes("--local")) return runDrainLocal(on);
  const { realSshRunner } = await import("./tui/remote.js");
  return runDrain(on, { cfg: loadConfig(), ssh: realSshRunner, log: (l) => console.log(l) });
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
  const { CompanionLifecycle, realDockerRunner } = await import("./tui/companion.js");
  const cfg = loadConfig().companion;
  const lc = new CompanionLifecycle(cfg, realDockerRunner);
  switch (sub) {
    case "up": {
      const outcome = await lc.ensureUp();
      const born = await lc.spawnPi();
      console.log(`companion ${cfg.container_name}: ${outcome}; pi session ${born ? "spawned" : "already running"}`);
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
        `companion ${cfg.container_name}: ${st.running ? "running" : st.exists ? "stopped" : "absent"}` +
          `${st.running ? ` · pi session ${pi ? "live" : "down"}` : ""}`,
      );
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
      console.log(`companion ${cfg.container_name}: image rebuilt, ${outcome}; pi session ${born ? "spawned" : "already running"}`);
      return;
    }
    default:
      throw new Error("usage: qcr companion <up|down|status|rebuild>");
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
      if (prs.length === 0 || prs.some((n) => !Number.isInteger(n))) throw new Error("usage: qcr compare <pr-number...>");
      const { cmdCompare } = await import("./cliops.js");
      process.exitCode = await cmdCompare(prs);
      return;
    }
    case "metrics": {
      const prIdx = rest.indexOf("--pr");
      const pr = prIdx >= 0 ? Number(rest[prIdx + 1]) : null;
      if (pr !== null && !Number.isInteger(pr)) throw new Error("usage: qcr metrics [--pr <pr-number>] [--json]");
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
      if (!Number.isInteger(tail) || tail <= 0) throw new Error("usage: qcr events [--tail <k>] [--json]");
      return cmdEvents(tail, json);
    }
    case "tui": {
      const { runTui } = await import("./tui/index.js");
      return runTui(rest);
    }
    case "companion":
      return cmdCompanion(rest[0]);
    case "drain": {
      process.exitCode = await cmdDrain(rest);
      return;
    }
    case "attach": {
      if (!rest[0]) throw new Error("usage: qcr attach <pr-number|session>");
      return cmdAttach(rest[0]);
    }
    default:
      console.log(
        "usage: qcr <status|spend|today|why <n>|metrics [--pr <n>]|events|attach <n>|tui [pr|overseer]|drain <on|off>|" +
          "companion <up|down|status|rebuild>|backfill [--dry-run] [--limit <n>]|checklist|compare <pr...>|" +
          "regression [--set <path>] [--clone <path>] [--change <name>] [--limit <n>] [--out <path>]>",
      );
      loadConfig(); // surface config errors early even on bad usage
  }
}

if (process.argv[1]?.endsWith("cli.js")) {
  void main(process.argv.slice(2));
}
