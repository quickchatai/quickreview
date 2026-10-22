// `qcr checklist` — the mechanical half of the cutover checklist.
//
// Nine items; seven are automated here (① ② ④ ⑤ ⑦ ⑧ ⑨) and two are
// guided-manual (③ ⑥ — the live test PRs, the only places where dry_run is
// ever off, and that is the operator's act on the VM, never this code's).
//
// Every probe takes its dependencies injected: local fixtures drive them on
// this machine, the real daemon/adapter/tmux drive them on the VM. Nothing
// here opens a socket, spawns a process or touches GitHub by itself.
//
// Exit code = 0 only when every automated probe passed.
import { randomUUID } from "node:crypto";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { digestHeadline } from "./digest.js";
import { signBody } from "./webhook.js";

export interface ProbeResult {
  /** The checklist item marker: ①…⑨. */
  item: string;
  name: string;
  pass: boolean;
  detail: string;
  /** Guided-manual items are reported but never counted in the exit code. */
  manual?: boolean;
}

const ok = (item: string, name: string, detail: string): ProbeResult => ({
  item,
  name,
  pass: true,
  detail,
});
const bad = (item: string, name: string, detail: string): ProbeResult => ({
  item,
  name,
  pass: false,
  detail,
});

/** Run a probe so an exception is a failed item, never a crashed checklist. */
export async function safeProbe(
  item: string,
  name: string,
  fn: () => Promise<ProbeResult>,
): Promise<ProbeResult> {
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
export type HttpPost = (
  url: string,
  headers: Record<string, string>,
  body: string,
) => Promise<HttpResponseLike>;

export interface TunnelProbeDeps {
  /** Locally `http://127.0.0.1:8787/webhook`; on the VM the same (the tunnel
   * terminates at cloudflared on the host and forwards to this port). */
  url: string;
  webhookSecret: string;
  post: HttpPost;
  /** Optional: the public hostname, only reported. */
  hostname?: string;
}

/** ① A signed test delivery is accepted (2xx); a bad-signature one is rejected
 * (401/403 — 400 accepted as a rejection too). Both must hold. */
export async function probeTunnelHmac(deps: TunnelProbeDeps): Promise<ProbeResult> {
  const item = "①";
  const name = "tunnel + HMAC";
  const body = JSON.stringify({
    zen: "Non-blocking is better than blocking.",
    hook_id: 0,
    probe: "qcr-checklist",
  });
  const base = (guid: string) => ({
    "content-type": "application/json",
    "x-github-event": "ping",
    "x-github-delivery": guid,
  });

  const good = await deps.post(
    deps.url,
    { ...base(randomUUID()), "x-hub-signature-256": signBody(body, deps.webhookSecret) },
    body,
  );
  const forged = await deps.post(
    deps.url,
    { ...base(randomUUID()), "x-hub-signature-256": `sha256=${"0".repeat(64)}` },
    body,
  );

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
  return diff.missing.length === 0 && diff.extra.length === 0
    ? ok(item, name, detail)
    : bad(item, name, detail);
}

// ---- ④ push does not review -------------------------------------------------

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
  /** Put an approved-then-pushed PR into the store / read fixture. */
  injectStalePr: (pr: StalePrFixture) => void | Promise<void>;
  /** Run authoritative reconcile plus dispatch. */
  runStalenessReconcile: () => Promise<void>;
  /** Round orders the dispatcher issued during this run. */
  issuedOrders: () => IssuedOrder[] | Promise<IssuedOrder[]>;
}

/** ④ A push must not produce a review; only an explicit re-request may. */
export async function probeStalenessWake(deps: StalenessProbeDeps): Promise<ProbeResult> {
  const item = "④";
  const name = "push does not review";
  await deps.injectStalePr(deps.fixture);
  await deps.runStalenessReconcile();
  const orders = await deps.issuedOrders();
  // ANY round for the fixture is unsolicited — a regression may spell it
  // first or re-review as readily as staleness.
  const hit = orders.find((o) => o.pr === deps.fixture.number);
  const detail = hit
    ? `#${deps.fixture.number}: unsolicited ${hit.round_type} round issued after push`
    : `#${deps.fixture.number}: push stayed quiet (approved ${deps.fixture.approved_sha.slice(0, 7)} -> head ${deps.fixture.head_sha.slice(0, 7)})`;
  return hit ? bad(item, name, detail) : ok(item, name, detail);
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
 * inject file. (The three-exchange cap is the session's own business.)
 * The wake lands in the per-session subdir (`inject/pr-<n>/`), so diff there
 * when the fixture PR is known — diffing only the top level passes solely on
 * the run that first creates the subdir. */
export async function probePingPong(deps: PingPongProbeDeps): Promise<ProbeResult> {
  const item = "⑤";
  const name = "ping-pong reply";
  const watchDir = deps.pr === undefined ? deps.injectDir : join(deps.injectDir, `pr-${deps.pr}`);
  const before = new Set(listDir(watchDir));
  await deps.interpret(deps.event);
  const added = listDir(watchDir).filter((f) => !before.has(f));
  const detail = added.length
    ? `inject file(s) appeared: ${added.join(", ")}`
    : `no new inject file in ${watchDir} after the author-reply event`;
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
  if (!existsSync(deps.statusPath))
    return bad(item, name, `${file} present but no status.json at ${deps.statusPath}`);
  let headline: unknown;
  try {
    headline = (JSON.parse(readFileSync(deps.statusPath, "utf8")) as { digest_headline?: unknown })
      .digest_headline;
  } catch (err) {
    return bad(item, name, `status.json unreadable: ${(err as Error).message}`);
  }
  if (typeof headline !== "string" || headline.trim() === "")
    return bad(item, name, `${file} present but status.json has no digest_headline`);
  const expected = digestHeadline(readFileSync(file, "utf8"));
  if (expected !== undefined && headline !== expected)
    return bad(
      item,
      name,
      `${file} present but status.json digest_headline "${headline.slice(0, 60)}" is not its headline "${expected.slice(0, 60)}"`,
    );
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
  if (!existsSync(deps.statusPath))
    return bad(
      item,
      name,
      `no status.json at ${deps.statusPath} — the daemon never wrote a heartbeat`,
    );
  let heartbeat: unknown;
  try {
    heartbeat = (JSON.parse(readFileSync(deps.statusPath, "utf8")) as { heartbeat?: unknown })
      .heartbeat;
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
  return ok(
    item,
    name,
    `heartbeat ${Math.max(0, Math.round(ageS))}s old; adopt pass ok: [${adopted.join(", ") || "no sessions to adopt"}]`,
  );
}

// ---- ③ ⑥ guided-manual -------------------------------------------------------

/** The PR labels the reviewer reads and writes (`[github] trigger_label`,
 * `in_progress_label`, `reviewed_label`). */
export interface ChecklistLabels {
  trigger: string;
  in_progress: string;
  reviewed: string;
}

/** The labels config.example.toml ships, for a checklist given none. */
export const DEFAULT_CHECKLIST_LABELS: ChecklistLabels = {
  trigger: "AI review requested",
  in_progress: "AI review in progress",
  reviewed: "Automatic Review",
};

/** The two live test-PR items. Never automated: they are the only steps that
 * run with `dry_run` off, and running them is the operator's act on the VM.
 * The bot identity and the labels render from config, never from a
 * hardcoded login or label. */
export function manualItems(
  botLogin = "the review App bot",
  labels: ChecklistLabels = DEFAULT_CHECKLIST_LABELS,
): Array<{ item: string; name: string; instructions: string[] }> {
  return [
    {
      item: "③",
      name: "live test PR — full pipeline (dry_run OFF)",
      instructions: [
        "Open a trivial doc-change PR on the reviewed repo and add the",
        `"${labels.trigger}" label. Then, with dry_run set to false FOR THIS ITEM ONLY:`,
        "  - the trigger is consumed and verified gone (label removed / team request cleared)",
        `  - "${labels.in_progress}" cycles, then "${labels.reviewed}" lands`,
        `  - the review is posted as ${botLogin}`,
        "  - the per-PR worktree is created (it stays while the PR is open: the",
        "    PR's session is sticky)",
        "  - verdict/pr-<n>-round-1.json is written and valid",
        "  - close the test PR: its worktree is removed and its session archived",
        "Restore dry_run = true afterwards. The cutover flip is a separate, later act.",
      ],
    },
    {
      item: "⑥",
      name: "live test PR — the review is never handed back (dry_run OFF)",
      instructions: [
        "Open a second labelled test PR the reviewer would find hard to decide.",
        "Expect a DECISION anyway: the complete review posted, APPROVE or",
        "REQUEST_CHANGES on the merits, residual doubts under `### For a human to",
        "double-check` and one `[check this]` inline thread per item. No park, no",
        "third verdict, no state the PR sits in waiting for a person.",
        "Expect NO review request on GitHub unless YOU switched `[escalation]` on",
        "(it ships off, and an escalation is a note beside the verdict,",
        "never instead of one).",
        "Restore dry_run = true afterwards.",
      ],
    },
  ];
}

export function renderManualItems(botLogin?: string, labels?: ChecklistLabels): string {
  const lines: string[] = [
    "Guided-manual items (never automated — run these by hand on the VM):",
    "",
  ];
  for (const m of manualItems(botLogin, labels)) {
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
  /** `[github] bot_login`, rendered into the guided-manual prose.
   * Absent ⇒ the role wording ("the review App bot"). */
  bot_login?: string;
  /** The configured PR labels, rendered into the guided-manual prose.
   * Absent ⇒ the shipped defaults. */
  labels?: ChecklistLabels;
}

export function renderTable(results: ProbeResult[]): string {
  const nameWidth = Math.max(4, ...results.map((r) => r.name.length));
  const lines = [
    `item ${"check".padEnd(nameWidth)}  result  detail`,
    `---- ${"-".repeat(nameWidth)}  ------  ------`,
  ];
  for (const r of results) {
    lines.push(
      `${r.item}    ${r.name.padEnd(nameWidth)}  ${(r.pass ? "PASS" : "FAIL").padEnd(6)}  ${r.detail}`,
    );
  }
  const automated = results.filter((r) => !r.manual);
  const failed = automated.filter((r) => !r.pass);
  lines.push("");
  lines.push(
    failed.length === 0
      ? `all ${automated.length} automated items PASS`
      : `${failed.length}/${automated.length} automated items FAILED: ${failed.map((r) => r.item).join(" ")}`,
  );
  const pending = results.filter((r) => r.manual && !r.pass);
  if (pending.length > 0)
    lines.push(`guided-manual items pending: ${pending.map((r) => r.item).join(" ")}`);
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
    await safeProbe("④", "push does not review", () => probeStalenessWake(deps.staleness)),
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

/** The `qcr checklist` entrypoint (wired in `cliops.ts`);
 * `print` defaults to console.log so tests can capture instead. */
export async function runChecklist(
  deps: ChecklistDeps,
  print: (s: string) => void = console.log,
): Promise<ChecklistRun> {
  const results = await runChecklistProbes(deps);
  const report = [
    "Cutover checklist — automated items",
    "",
    renderTable(results),
    "",
    renderManualItems(deps.bot_login, deps.labels),
  ].join("\n");
  print(report);
  return { results, report, exitCode: exitCodeFor(results) };
}
