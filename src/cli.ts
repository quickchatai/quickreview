// qcr — the operator CLI. Read-only against state/ (status.json + state.db);
// `attach` wraps tmux/docker-exec. Subcommands land across slices: status and
// spend here (B1); today/why in B5; checklist/compare in B6.
import { readFileSync, existsSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { loadConfig, sandboxRoot } from "./config.js";
import { StateStore, type StatusSnapshot } from "./state.js";

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

function cmdAttach(target: string): void {
  // Live sessions run inside the quickreview container on the VM; locally the
  // tmux server is direct. Print the right invocation and exec it when local
  // tmux has the session.
  const session = /^\d+$/.test(target) ? `pr-${target}` : target;
  console.log(`attach: tmux attach -t ${session}`);
  console.log(`(on the VM: docker exec -it quickreview-sandbox tmux attach -t ${session})`);
}

export async function main(argv: string[]): Promise<void> {
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
    case "status":
      return cmdStatus();
    case "spend":
      return cmdSpend();
    case "today":
      return cmdToday();
    case "why": {
      const n = Number(rest[0]);
      if (!Number.isInteger(n)) throw new Error("usage: qcr why <pr-number>");
      return cmdWhy(n);
    }
    case "attach": {
      if (!rest[0]) throw new Error("usage: qcr attach <pr-number|session>");
      return cmdAttach(rest[0]);
    }
    default:
      console.log("usage: qcr <status|spend|today|why <n>|attach <n>|checklist|compare <pr...>>");
      loadConfig(); // surface config errors early even on bad usage
  }
}

if (process.argv[1]?.endsWith("cli.js")) {
  void main(process.argv.slice(2));
}
