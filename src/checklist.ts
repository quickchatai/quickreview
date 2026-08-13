// `qcr checklist` — the mechanical half of the cutover checklist.
//
// Nine items; seven are automated here (① ② ④ ⑤ ⑦ ⑧ ⑨) and two are
// guided-manual (③ ⑥ — the live test PRs, the only places where dry_run is
// ever off, and that is the owner's act on the VM, never this code's).
//
// Every probe takes its dependencies injected: local fixtures drive them on
// this machine, the real daemon/adapter/tmux drive them on the VM. Nothing
// here opens a socket, spawns a process or touches GitHub by itself.
//
// Exit code = 0 only when every automated probe passed.
import { createHmac, randomUUID } from "node:crypto";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

export interface ProbeResult {
  /** The item marker: ①…⑨. */
  item: string;
  name: string;
  pass: boolean;
  detail: string;
  /** Guided-manual items are reported but never counted in the exit code. */
  manual?: boolean;
}

const ok = (item: string, name: string, detail: string): ProbeResult => ({ item, name, pass: true, detail });
const bad = (item: string, name: string, detail: string): ProbeResult => ({ item, name, pass: false, detail });

/** Run a probe so an exception is a failed item, never a crashed checklist. */
export async function safeProbe(item: string, name: string, fn: () => Promise<ProbeResult>): Promise<ProbeResult> {
  try {
    return await fn();
  } catch (err) {
    return bad(item, name, `probe threw: ${(err as Error).message}`);
  }
}

// ---- ① tunnel + HMAC ---------------------------------------------------------

export interface HttpResponseLike {
  status: number;
}
export type HttpPost = (url: string, headers: Record<string, string>, body: string) => Promise<HttpResponseLike>;

export interface TunnelProbeDeps {
  /** Locally `http://127.0.0.1:8787/webhook`; on the VM the same (the tunnel
   * terminates at cloudflared on the host and forwards to this port). */
  url: string;
  webhookSecret: string;
  post: HttpPost;
  /** Optional: the public hostname, only reported. */
  hostname?: string;
}

export function signBody(secret: string, body: string): string {
  return `sha256=${createHmac("sha256", secret).update(body).digest("hex")}`;
}

/** ① A signed test delivery is accepted (2xx); a bad-signature one is rejected
 * (401/403 — 400 accepted as a rejection too). Both must hold. */
export async function probeTunnelHmac(deps: TunnelProbeDeps): Promise<ProbeResult> {
  const item = "①";
  const name = "tunnel + HMAC";
  const body = JSON.stringify({ zen: "Non-blocking is better than blocking.", hook_id: 0, probe: "qcr-checklist" });
  const base = (guid: string) => ({
    "content-type": "application/json",
    "x-github-event": "ping",
    "x-github-delivery": guid,
  });

  const good = await deps.post(deps.url, { ...base(randomUUID()), "x-hub-signature-256": signBody(deps.webhookSecret, body) }, body);
  const forged = await deps.post(deps.url, { ...base(randomUUID()), "x-hub-signature-256": `sha256=${"0".repeat(64)}` }, body);

  const goodOk = good.status >= 200 && good.status < 300;
  const forgedRejected = forged.status === 401 || forged.status === 403 || forged.status === 400;
  const where = deps.hostname ? ` via ${deps.hostname} -> ${deps.url}` : ` at ${deps.url}`;
  const detail = `signed -> ${good.status} (want 2xx), forged -> ${forged.status} (want 401/403)${where}`;
  return goodOk && forgedRejected ? ok(item, name, detail) : bad(item, name, detail);
}

// ---- ② reconcile queue vs a hand-run of the Step-1 queries --------------------

export interface QueueDiffDeps {
  /** The two triggered-set searches, through the adapter (reads only). */
  labelTriggered: () => Promise<number[]>;
  teamTriggered: () => Promise<number[]>;
  /** The daemon's derived queue — pr_state rows the reconcile poll owes work. */
  derivedQueue: () => Promise<number[]> | number[];
}

export interface QueueDiff {
  manual: number[];
  derived: number[];
  missing: number[];
  extra: number[];
}

export function diffQueues(manual: number[], derived: number[]): QueueDiff {
  const m = [...new Set(manual)].sort((a, b) => a - b);
  const d = [...new Set(derived)].sort((a, b) => a - b);
  return {
    manual: m,
    derived: d,
    missing: m.filter((n) => !d.includes(n)),
    extra: d.filter((n) => !m.includes(n)),
  };
}

/** ② The derived queue must match the union of the two trigger searches exactly. */
export async function probeQueueDiff(deps: QueueDiffDeps): Promise<ProbeResult> {
  const item = "②";
  const name = "reconcile queue == manual queries";
  const manual = [...(await deps.labelTriggered()), ...(await deps.teamTriggered())];
  const diff = diffQueues(manual, await deps.derivedQueue());
  const detail =
    `manual=[${diff.manual.join(",")}] derived=[${diff.derived.join(",")}]` +
    (diff.missing.length ? ` missing=[${diff.missing.join(",")}]` : "") +
    (diff.extra.length ? ` extra=[${diff.extra.join(",")}]` : "");
  return diff.missing.length === 0 && diff.extra.length === 0 ? ok(item, name, detail) : bad(item, name, detail);
}

// ---- ④ staleness wake --------------------------------------------------------

export interface StalePrFixture {
  number: number;
  head_sha: string;
  approved_sha: string;
}

export interface IssuedOrder {
  pr: number;
  round_type: string;
}

export interface StalenessProbeDeps {
  fixture: StalePrFixture;
  /** Put the stale PR into the store / the scan's result set. */
  injectStalePr: (pr: StalePrFixture) => void | Promise<void>;
  /** The daemon's staleness reconcile step. */
  runStalenessReconcile: () => Promise<void>;
  /** Round orders the dispatcher issued during this run. */
  issuedOrders: () => IssuedOrder[] | Promise<IssuedOrder[]>;
}

/** ④ An approved-then-pushed PR must produce a `staleness` round order. */
export async function probeStalenessWake(deps: StalenessProbeDeps): Promise<ProbeResult> {
  const item = "④";
  const name = "staleness wake";
  await deps.injectStalePr(deps.fixture);
  await deps.runStalenessReconcile();
  const orders = await deps.issuedOrders();
  const hit = orders.find((o) => o.pr === deps.fixture.number && o.round_type === "staleness");
  const detail = hit
    ? `#${deps.fixture.number}: staleness round issued (approved ${deps.fixture.approved_sha.slice(0, 7)} -> head ${deps.fixture.head_sha.slice(0, 7)})`
    : `#${deps.fixture.number}: no staleness round among [${orders.map((o) => `#${o.pr}:${o.round_type}`).join(", ") || "none"}]`;
  return hit ? ok(item, name, detail) : bad(item, name, detail);
}

// ---- ⑤ ping-pong -------------------------------------------------------------

export interface PingPongProbeDeps {
  /** inject/ — the session wake drop-box. */
  injectDir: string;
  /** An author-reply event fixture (webhook payload shape). */
  event: unknown;
  /** The daemon's event interpreter. */
  interpret: (event: unknown) => Promise<void>;
  pr?: number;
}

function listDir(dir: string): string[] {
  return existsSync(dir) ? readdirSync(dir).filter((f) => !f.startsWith(".")) : [];
}

/** ⑤ An author reply in a bot thread must wake the session — visible as a new
 * inject file. (The three-exchange cap is the session's own business.) */
export async function probePingPong(deps: PingPongProbeDeps): Promise<ProbeResult> {
  const item = "⑤";
  const name = "ping-pong reply";
  const before = new Set(listDir(deps.injectDir));
  await deps.interpret(deps.event);
  const added = listDir(deps.injectDir).filter((f) => !before.has(f));
  const detail = added.length
    ? `inject file(s) appeared: ${added.join(", ")}`
    : `no new inject file in ${deps.injectDir} after the author-reply event`;
  return added.length > 0 ? ok(item, name, detail) : bad(item, name, detail);
}

// ---- ⑦ digest presence -------------------------------------------------------

export interface DigestProbeDeps {
  digestDir: string;
  statusPath: string;
  /** YYYY-MM-DD in the EOD timezone. */
  today: string;
}

/** ⑦ digest/<today>.md exists and the headline reached status.json. */
export function probeDigest(deps: DigestProbeDeps): ProbeResult {
  const item = "⑦";
  const name = "EOD digest";
  const file = join(deps.digestDir, `${deps.today}.md`);
  if (!existsSync(file)) return bad(item, name, `missing ${file}`);
  const size = readFileSync(file, "utf8").trim().length;
  if (size === 0) return bad(item, name, `${file} is empty`);
  if (!existsSync(deps.statusPath)) return bad(item, name, `${file} present but no status.json at ${deps.statusPath}`);
  let headline: unknown;
  try {
    headline = (JSON.parse(readFileSync(deps.statusPath, "utf8")) as { digest_headline?: unknown }).digest_headline;
  } catch (err) {
    return bad(item, name, `status.json unreadable: ${(err as Error).message}`);
  }
  if (typeof headline !== "string" || headline.trim() === "") return bad(item, name, `${file} present but status.json has no digest_headline`);
  return ok(item, name, `${file} (${size} chars), headline: "${headline.slice(0, 60)}"`);
}

// ---- ⑧ tmux attach -----------------------------------------------------------

export interface TmuxProbeDeps {
  /** `tmux ls`-equivalent; on the VM this is `docker exec … tmux ls`. Throwing
   * (no server) is a legitimate failure, reported as such. */
  listSessions: () => Promise<string[]> | string[];
  /** Session names the checklist insists on. */
  requireOverseer?: boolean;
}

/** ⑧ The overseer session and at least one `pr-*` session must be attachable. */
export async function probeTmux(deps: TmuxProbeDeps): Promise<ProbeResult> {
  const item = "⑧";
  const name = "tmux attach";
  let sessions: string[];
  try {
    sessions = await deps.listSessions();
  } catch (err) {
    return bad(item, name, `no tmux server / listing failed: ${(err as Error).message}`);
  }
  const overseer = sessions.includes("overseer");
  const prSessions = sessions.filter((s) => /^pr-\d+$/.test(s));
  const wantOverseer = deps.requireOverseer !== false;
  const pass = (!wantOverseer || overseer) && prSessions.length > 0;
  const detail = `sessions=[${sessions.join(", ") || "none"}] overseer=${overseer ? "yes" : "NO"} pr-sessions=${prSessions.length}`;
  return pass ? ok(item, name, detail) : bad(item, name, detail);
}

// ---- ⑨ restart recovery ------------------------------------------------------

export interface RestartProbeDeps {
  statusPath: string;
  /** Adopt-existing-sessions, run as a dry pass: it must not throw and should
   * report what it would re-attach. */
  adoptExistingSessions: () => Promise<string[]> | string[];
  now?: () => Date;
  /** Heartbeat older than this is a dead daemon. Default 300 s. */
  maxHeartbeatAgeS?: number;
}

/** ⑨ Heartbeat is fresh and the adopt pass converges without throwing. */
export async function probeRestartRecovery(deps: RestartProbeDeps): Promise<ProbeResult> {
  const item = "⑨";
  const name = "restart recovery";
  const now = (deps.now ?? (() => new Date()))();
  const maxAge = deps.maxHeartbeatAgeS ?? 300;
  if (!existsSync(deps.statusPath)) return bad(item, name, `no status.json at ${deps.statusPath} — the daemon never wrote a heartbeat`);
  let heartbeat: unknown;
  try {
    heartbeat = (JSON.parse(readFileSync(deps.statusPath, "utf8")) as { heartbeat?: unknown }).heartbeat;
  } catch (err) {
    return bad(item, name, `status.json unreadable: ${(err as Error).message}`);
  }
  if (typeof heartbeat !== "string") return bad(item, name, "status.json has no heartbeat field");
  const ageS = (now.getTime() - Date.parse(heartbeat)) / 1000;
  if (!Number.isFinite(ageS)) return bad(item, name, `unparseable heartbeat: ${heartbeat}`);
  if (ageS > maxAge) return bad(item, name, `heartbeat ${Math.round(ageS)}s old (max ${maxAge}s)`);
  let adopted: string[];
  try {
    adopted = await deps.adoptExistingSessions();
  } catch (err) {
    return bad(item, name, `heartbeat fresh but adopt pass threw: ${(err as Error).message}`);
  }
  return ok(item, name, `heartbeat ${Math.max(0, Math.round(ageS))}s old; adopt pass ok: [${adopted.join(", ") || "no sessions to adopt"}]`);
}

// ---- ③ ⑥ guided-manual -------------------------------------------------------

/** The two live test-PR items. Never automated: they are the only steps that
 * run with `dry_run` off, and running them is the owner's act on the VM. */
export const MANUAL_ITEMS: Array<{ item: string; name: string; instructions: string[] }> = [
  {
    item: "③",
    name: "live test PR — full pipeline (dry_run OFF)",
    instructions: [
      "Open a trivial doc-change PR on example-org/example-app and add the",
      '"AI review requested" label. Then, with dry_run set to false FOR THIS ITEM ONLY:',
      "  - the trigger is consumed and verified gone (label removed / team request cleared)",
      '  - "AI review in progress" cycles, then "Automatic Review" lands',
      "  - the review is posted as example-review[bot]",
      "  - the per-PR worktree is created and removed again",
      "  - verdict/pr-<n>-round-1.json is written and valid",
      "Restore dry_run = true afterwards. The cutover flip is a separate, later act.",
    ],
  },
  {
    item: "⑥",
    name: "live test PR — escalation path (dry_run OFF)",
    instructions: [
      "Open a second labelled test PR touching an infra/ path.",
      "Expect: a clean AI review first, then a review request for mhale",
      "(it is the owner — the self-noise is accepted once), and the redundancy",
      "skips honored (no duplicate request, no request when a standing review exists).",
      "Restore dry_run = true afterwards.",
    ],
  },
];

export function renderManualItems(): string {
  const lines: string[] = ["Guided-manual items (never automated — run these by hand on the VM):", ""];
  for (const m of MANUAL_ITEMS) {
    lines.push(`${m.item} ${m.name}`);
    for (const l of m.instructions) lines.push(`   ${l}`);
    lines.push("");
  }
  return lines.join("\n").trimEnd();
}

// ---- the run -----------------------------------------------------------------

export interface ChecklistDeps {
  tunnel: TunnelProbeDeps;
  queue: QueueDiffDeps;
  staleness: StalenessProbeDeps;
  pingPong: PingPongProbeDeps;
  digest: DigestProbeDeps;
  tmux: TmuxProbeDeps;
  restart: RestartProbeDeps;
}

export function renderTable(results: ProbeResult[]): string {
  const nameWidth = Math.max(4, ...results.map((r) => r.name.length));
  const lines = [
    `item ${"check".padEnd(nameWidth)}  result  detail`,
    `---- ${"-".repeat(nameWidth)}  ------  ------`,
  ];
  for (const r of results) {
    lines.push(`${r.item}    ${r.name.padEnd(nameWidth)}  ${(r.pass ? "PASS" : "FAIL").padEnd(6)}  ${r.detail}`);
  }
  const failed = results.filter((r) => !r.pass);
  lines.push("");
  lines.push(
    failed.length === 0
      ? `all ${results.length} automated items PASS`
      : `${failed.length}/${results.length} automated items FAILED: ${failed.map((r) => r.item).join(" ")}`,
  );
  return lines.join("\n");
}

export function exitCodeFor(results: ProbeResult[]): number {
  return results.every((r) => r.pass || r.manual) ? 0 : 1;
}

/** Run the seven automated probes in checklist order. */
export async function runChecklistProbes(deps: ChecklistDeps): Promise<ProbeResult[]> {
  return [
    await safeProbe("①", "tunnel + HMAC", () => probeTunnelHmac(deps.tunnel)),
    await safeProbe("②", "reconcile queue == manual queries", () => probeQueueDiff(deps.queue)),
    await safeProbe("④", "staleness wake", () => probeStalenessWake(deps.staleness)),
    await safeProbe("⑤", "ping-pong reply", () => probePingPong(deps.pingPong)),
    await safeProbe("⑦", "EOD digest", async () => probeDigest(deps.digest)),
    await safeProbe("⑧", "tmux attach", () => probeTmux(deps.tmux)),
    await safeProbe("⑨", "restart recovery", () => probeRestartRecovery(deps.restart)),
  ];
}

export interface ChecklistRun {
  results: ProbeResult[];
  report: string;
  exitCode: number;
}

/** The `qcr checklist` entrypoint. Wire it into the CLI (coordinator's job);
 * `print` defaults to console.log so tests can capture instead. */
export async function runChecklist(deps: ChecklistDeps, print: (s: string) => void = console.log): Promise<ChecklistRun> {
  const results = await runChecklistProbes(deps);
  const report = [
    "cutover checklist — automated items",
    "",
    renderTable(results),
    "",
    renderManualItems(),
  ].join("\n");
  print(report);
  return { results, report, exitCode: exitCodeFor(results) };
}
