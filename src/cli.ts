// qcr — the operator CLI. Read-only against state/ (status.json + state.db);
// `attach` wraps tmux/docker-exec. Subcommands land across slices: status and
// spend here (B1); today/why in B5; checklist/compare in B6.
import { readFileSync, existsSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { loadConfig, sandboxRoot } from "./config.js";
import { StateStore, type StatusSnapshot } from "./state.js";
import { computeMetrics, computeTimeline, renderMetrics, renderTimeline } from "./metrics.js";

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
    const todayRounds = store.roundsOn(today);
    const todaySpend = todayRounds.reduce((n, r) => n + (r.spend_usd ?? 0), 0);
    console.log(`total spend: $${total.toFixed(2)}`);
    console.log(`today (${today}): $${todaySpend.toFixed(2)} across ${todayRounds.length} rounds`);
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
      console.log(
        `#${r.pr} round ${r.round_no} (${r.round_type}) [${r.status}] verdict=${r.verdict ?? "—"} spend=$${(r.spend_usd ?? 0).toFixed(2)} lenses=${r.lenses}`,
      );
    }
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
  escalation_worthy?: boolean;
  updated_at?: string;
  spend_usd: number;
  rounds: Array<{ round_no: number; round_type: string; status: string; verdict: string | null; started_at: string; finished_at: string | null; spend_usd: number | null; lenses: string; summary?: string | null }>;
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
 * comments). Read-only; any failure leaves the payload un-enriched. */
export async function enrichWhy(payload: WhyPayload): Promise<WhyPayload> {
  try {
    const { TokenMinter } = await import("./githubAuth.js");
    const { MutationGate } = await import("./gate.js");
    const { GitHubAdapter } = await import("./github.js");
    const cfg = loadConfig();
    const gate = new MutationGate(true, join(sandboxRoot(), "state", "dryrun"), async () => undefined);
    const adapter = new GitHubAdapter(cfg, new TokenMinter(cfg.github.secrets_dir), gate);
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
    spend_usd: rounds.reduce((s, r) => s + (r.spend_usd ?? 0), 0),
    rounds: rounds.map((r) => ({
      round_no: r.round_no,
      round_type: r.round_type,
      status: r.status,
      verdict: r.verdict ?? null,
      started_at: r.started_at,
      finished_at: r.finished_at ?? null,
      spend_usd: r.spend_usd ?? null,
      lenses: r.lenses,
      summary: r.summary ?? null,
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
    payload.escalation_worthy = Boolean(pr.escalation_worthy);
    payload.updated_at = pr.updated_at;
  }
  if (existsSync(archiveDir)) {
    payload.archive = readdirSync(archiveDir);
    const ledger = join(archiveDir, "ledger.md");
    if (existsSync(ledger)) payload.ledger = readFileSync(ledger, "utf8");
  }
  return payload;
}

export function todayJson(store: StateStore, today: string): { date: string; rounds: unknown[]; spend_usd: number; events: unknown[] } {
  const rounds = store.roundsOn(today);
  return {
    date: today,
    rounds,
    spend_usd: rounds.reduce((n, r) => n + (r.spend_usd ?? 0), 0),
    events: store.eventsOn(today),
  };
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
function cmdMetrics(pr: number | null, json: boolean): void {
  const store = openStore();
  try {
    if (pr !== null) {
      const payload = computeTimeline(store, pr);
      console.log(json ? JSON.stringify(payload) : renderTimeline(payload));
      return;
    }
    const payload = computeMetrics(store);
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
    default:
      throw new Error("usage: qcr companion <up|down|status>");
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
    case "attach": {
      if (!rest[0]) throw new Error("usage: qcr attach <pr-number|session>");
      return cmdAttach(rest[0]);
    }
    default:
      console.log(
        "usage: qcr <status|spend|today|why <n>|metrics [--pr <n>]|events|attach <n>|tui [pr|overseer]|" +
          "companion <up|down|status>|backfill [--dry-run] [--limit <n>]|checklist|compare <pr...>>",
      );
      loadConfig(); // surface config errors early even on bad usage
  }
}

if (process.argv[1]?.endsWith("cli.js")) {
  void main(process.argv.slice(2));
}
