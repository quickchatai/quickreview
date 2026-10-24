// The proof round — the wizard's done-bar, and the reason the whole
// wizard exists in this shape: the operator does not get told the reviewer
// works, they WATCH it work, on a real pull request of their own, and they read
// the review it produced before anything could ever reach GitHub.
//
// The shape:
//   1. ask for one real, open PR (a number or its URL; the five most recently
//      updated open PRs of the repo are offered, the person's own included —
//      on the own-account route those are the main target). The wizard never
//      creates a demo PR;
//   2. start its review IMMEDIATELY: one `review-now` command into the
//      daemon's root-sealed operator channel (src/commands.ts, the channel
//      `qcr drain` and the TUI's levers use), which queues the PR exactly as a
//      fresh trigger label would — with no GitHub write and no label for the
//      person to add. A daemon that cannot take the command (an older image)
//      falls back to the label, said plainly;
//   3. follow the round to completion THROUGH THE STATE STORE — the daemon's
//      own record, read with the daemon's own `qcr why --json` inside the
//      container, so the wizard is reading exactly what the operator would;
//   4. SHOW the finished review, read out of the dry-run record — the file the
//      mutation gate wrote INSTEAD of calling GitHub: the verdict, how many
//      findings, the top ones, and where the full text is. The operator judges
//      the output while it is still impossible for it to have posted.
//
// Two paths get real guidance rather than a spinner, because they are the two
// that actually happen: the round never starts (label spelling, webhook not
// arriving, the poll interval on the polling-only shape) and the round fails or
// is cancelled (the daemon's own event log says why). Neither ever hangs: the
// poll is bounded and every attempt logs where it got to.
//
// The one thing it writes is that operator command file. Otherwise it reads the
// state store, the dry-run directory and (to offer PRs) GitHub, and records
// what it saw on the checklist — the record the go-live step later demands
// before it will even offer the flip.
import { join } from "node:path";
import { mintAppJwt } from "@quickchatai/pi-quickreview/src/githubAuth.js";
import { loadConfig } from "../../config.js";
import { GITHUB_TOKEN_FILE } from "../../githubtoken.js";
import { operatorCommandWriteScriptAt } from "../../operatorwrite.js";
import { CHOICE_KEYS, userAuthRecorded } from "../choices.js";
import { readTextOrNull } from "../engine.js";
import type {
  CheckResult,
  OnboardAdapters,
  OnboardingStep,
  StepContext,
  StepReport,
} from "../engine.js";
import {
  decodeDryrunRecord,
  sandboxReviewFrom,
  type DryrunRecord,
  type ReviewSnapshot,
} from "../../compare.js";
import {
  CONTAINER_COMMANDS_DIR,
  CONTAINER_DRYRUN_DIR,
  configPath,
  readConfigText,
} from "./compose.js";
import { readTomlKey, secretsDirFor } from "./ingress.js";
import {
  DEFAULT_LABELS,
  api,
  findInstallation,
  installationToken,
  parseRepoSlug,
  readCredentials,
  type RepoSlug,
} from "./githubapp.js";
import { stackTransportFor, type StackTransport, type TransportOptions } from "./transport.js";

export const PROOF_STEP_ID = "proof_round";

/** A string input or choice, else "" — never an object's stringification. */
function textOf(v: unknown): string {
  return typeof v === "string" ? v : "";
}
/** The completed-proof record. The go-live step will not offer the flip
 * without it AND a state-store re-verification of it. */
export const PROOF_CHOICE_KEY = CHOICE_KEYS.proof;

export interface ProofRecord {
  pr: number;
  round_no: number;
  verdict: string;
  completed_at: string;
  /** The review was rendered to the operator out of the dry-run record. */
  review_shown: boolean;
}

/** Total: anything that is not a complete proof record reads as "no proof". */
export function parseProofRecord(value: unknown): ProofRecord | null {
  if (typeof value !== "object" || value === null) return null;
  const r = value as Record<string, unknown>;
  if (typeof r.pr !== "number" || !Number.isInteger(r.pr) || r.pr <= 0) return null;
  if (typeof r.round_no !== "number" || typeof r.verdict !== "string" || r.verdict === "")
    return null;
  if (typeof r.completed_at !== "string" || r.completed_at === "") return null;
  return {
    pr: r.pr,
    round_no: r.round_no,
    verdict: r.verdict,
    completed_at: r.completed_at,
    review_shown: r.review_shown === true,
  };
}

// ---- what the state store says ----------------------------------------------

export interface ObservedRound {
  round_no: number;
  status: string;
  verdict: string | null;
  summary: string | null;
  started_at: string;
}

/** A merits verdict on a completed round, shared with go-live admission. */
export function completedRound(
  round: ObservedRound | undefined,
): round is ObservedRound & { verdict: string } {
  return round !== undefined && round.status === "done" && !!round.verdict;
}

export interface RoundObservation {
  known: boolean;
  state: string | null;
  rounds: ObservedRound[];
}

/** Parse `qcr why <n> --json`. Null means the output was not JSON at all — a
 * different failure (no container, no CLI) than "the daemon knows nothing". */
export function parseWhy(stdout: string): RoundObservation | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(stdout.trim());
  } catch {
    return null;
  }
  if (typeof parsed !== "object" || parsed === null) return null;
  const p = parsed as Record<string, unknown>;
  const rows = Array.isArray(p.rounds) ? p.rounds : [];
  const rounds: ObservedRound[] = [];
  for (const raw of rows) {
    if (typeof raw !== "object" || raw === null) continue;
    const r = raw as Record<string, unknown>;
    if (typeof r.round_no !== "number") continue;
    rounds.push({
      round_no: r.round_no,
      status: typeof r.status === "string" ? r.status : "",
      verdict: typeof r.verdict === "string" ? r.verdict : null,
      summary: typeof r.summary === "string" ? r.summary : null,
      started_at: typeof r.started_at === "string" ? r.started_at : "",
    });
  }
  rounds.sort((a, b) => a.round_no - b.round_no);
  return { known: p.known === true, state: typeof p.state === "string" ? p.state : null, rounds };
}

export type RoundOutcome =
  | { kind: "waiting"; detail: string }
  | { kind: "running"; round: ObservedRound }
  | { kind: "done"; round: ObservedRound }
  | { kind: "failed"; round: ObservedRound };

/** The LAST round decides: a re-run on a PR with history follows the newest. */
export function classifyRounds(obs: RoundObservation): RoundOutcome {
  const round = obs.rounds.at(-1);
  if (!round) {
    return {
      kind: "waiting",
      detail: obs.known
        ? "the daemon is tracking the PR but has not started a round yet"
        : "the daemon has not seen the PR yet",
    };
  }
  if (completedRound(round)) return { kind: "done", round };
  if (round.status === "running") return { kind: "running", round };
  if (round.status === "done") return { kind: "running", round };
  return { kind: "failed", round };
}

// ---- the dry-run record, read out of the container ---------------------------

export interface DryrunRead {
  records: DryrunRecord[];
  problem: string;
  /** Files that were listed but could not be read, each with why. */
  unread: string[];
}

/** When the gate wrote a dry-run file, from its name
 * (`<ISO time with : and . as ->-<seq>-<kind>.json`); null when the name does
 * not carry one. */
export function dryrunFileTime(name: string): number | null {
  const m = /^(\d{4}-\d{2}-\d{2}T\d{2})-(\d{2})-(\d{2})-(\d{3})Z-/.exec(name);
  if (!m) return null;
  const t = Date.parse(`${m[1]}:${m[2]}:${m[3]}.${m[4]}Z`);
  return Number.isNaN(t) ? null : t;
}

/**
 * Read `state/dryrun/` from inside the daemon container: list, then read the
 * newest few. Through the transport's `exec`, because the state lives on the
 * daemon's own volume — `docker compose exec` on this machine, `ssh <alias>
 * sudo docker exec` on the server route, and this function never learns which.
 *
 * `since` narrows the listing to files written at or after it (by the time in
 * their name) BEFORE the limit applies, and the review files are read apart
 * from the rest. With a target PR, review files are decoded before its limit
 * applies — unrelated reviews cannot push its readable evidence out of view.
 */
export async function readContainerDryrun(
  transport: StackTransport,
  limit = 40,
  opts: { since?: number; pr?: number } = {},
): Promise<DryrunRead> {
  const list = await transport.exec(["ls", "-1", CONTAINER_DRYRUN_DIR]);
  if (list.code !== 0) {
    return {
      records: [],
      problem:
        `could not list ${CONTAINER_DRYRUN_DIR} in the daemon container (${(list.stderr || list.stdout).trim() || `exit ${list.code}`}). ` +
        "That directory only exists once the gate has recorded its first would-be mutation",
      unread: [],
    };
  }
  const since = opts.since;
  const names = list.stdout
    .split("\n")
    .map((l) => l.trim())
    .filter((l) => l.endsWith(".json"))
    .filter((l) => {
      if (since === undefined || Number.isNaN(since)) return true;
      const at = dryrunFileTime(l);
      return at === null || at >= since;
    })
    .sort();
  const newest = (xs: string[]): string[] => xs.slice(Math.max(0, xs.length - limit));
  const isReview = (name: string): boolean => name.endsWith("-create_review.json");
  const wanted = new Set([
    ...(opts.pr === undefined ? newest(names.filter(isReview)) : names.filter(isReview)),
    ...newest(names.filter((n) => !isReview(n))),
  ]);
  const records: DryrunRecord[] = [];
  const unread: string[] = [];
  for (const name of names.filter((n) => wanted.has(n))) {
    const cat = await transport.exec(["cat", `${CONTAINER_DRYRUN_DIR}/${name}`]);
    if (cat.code !== 0) {
      unread.push(
        `${name}: ${(cat.stderr || cat.stdout).trim().slice(0, 120) || `exit ${cat.code}`}`,
      );
      continue;
    }
    const record = decodeDryrunRecord(cat.stdout, name);
    if (opts.pr === undefined || record.kind !== "create_review" || recordForPr(record, opts.pr))
      records.push(record);
  }
  const reviews = records.filter((record) => record.kind === "create_review");
  const retained = new Set(reviews.slice(Math.max(0, reviews.length - limit)));
  return {
    records: records.filter((record) => record.kind !== "create_review" || retained.has(record)),
    problem: "",
    unread,
  };
}

/** Does this dry-run record belong to PR `pr`? */
export function recordForPr(r: DryrunRecord, pr: number): boolean {
  return r.pr === pr || new RegExp(`/(pulls|issues)/${pr}(/|$)`).test(r.path);
}

/** How many findings the summary lists before "and N more". */
export const TOP_FINDINGS = 5;

export interface ReviewRenderExtras {
  /** The round's verdict on the merits (the review EVENT can be COMMENT on
   * the own-account route, where the verdict is stated in the body). */
  verdict?: string | null;
  /** Where the full record is, and the command that prints it. */
  file?: string;
  readCommand?: string;
}

/** The first line of a comment, trimmed to one readable line. */
function headline(body: string): string {
  const line =
    body
      .trim()
      .split("\n")
      .find((l) => l.trim() !== "") ?? "";
  const flat = line.trim();
  return flat.length > 160 ? `${flat.slice(0, 157)}…` : flat;
}

/** The would-be review, rendered for a human to judge. */
export function renderReview(
  review: ReviewSnapshot,
  pr: number,
  extras: ReviewRenderExtras = {},
): string {
  const top = review.comments
    .slice(0, TOP_FINDINGS)
    .map((c, i) => `  ${i + 1}. ${c.path}:${c.line} — ${headline(c.body)}`);
  const more = review.comments.length - top.length;
  const head = [
    `This is the review your reviewer produced for #${pr}. It was NOT posted: dry_run is on, so the`,
    `mutation gate wrote it to state/dryrun/ instead of calling GitHub.`,
    "",
    `Verdict it would have submitted: ${review.state}`,
    ...(extras.verdict && extras.verdict !== review.state
      ? [
          `Verdict on the merits: ${extras.verdict} (stated in the review body; GitHub gets it as a ${review.state} review)`,
        ]
      : []),
    `Inline comments: ${review.comments.length}`,
    ...(top.length > 0
      ? ["Top findings:", ...top, ...(more > 0 ? [`  … and ${more} more, below`] : [])]
      : []),
    ...(extras.file
      ? [
          `Full text: state/dryrun/${extras.file} in the daemon's state${extras.readCommand ? ` — \`${extras.readCommand}\`` : ""}`,
        ]
      : []),
    "",
    "--- review body ---",
    review.body.trim() === "" ? "(empty body)" : review.body.trim(),
  ];
  const comments = review.comments.map(
    (c, i) => `--- inline comment ${i + 1}: ${c.path}:${c.line} ---\n${c.body.trim()}`,
  );
  return [...head, ...(comments.length ? ["", ...comments] : [])].join("\n");
}

// ---- the step ----------------------------------------------------------------

export interface ProofStepOptions {
  pollAttempts?: number;
  pollIntervalMs?: number;
  sleep?: (ms: number) => Promise<void>;
  /** How many dry-run files to read back (newest wins). */
  dryrunLimit?: number;
  /** The stack transport's options. WHICH transport is never an option here —
   * `stackTransportFor` decides it from the recorded topology, so the proof
   * round is the same act on a laptop and on a server. */
  transport?: TransportOptions;
  /** GitHub's API base (the open-PR offer). */
  apiBase?: string;
  /** Secrets dir for the offer's read token; default: the one resolution. */
  secretsDir?: string;
  /** How many times the review-now result file is read before giving up. */
  resultAttempts?: number;
  resultIntervalMs?: number;
}

/** How many open PRs the offer lists. */
export const PR_OFFER_SIZE = 5;

function triggerLabelOf(adapters: OnboardAdapters): string {
  const text = readConfigText(adapters);
  const configured = text ? readTomlKey(text, "github", "trigger_label") : null;
  return configured && configured.trim() !== "" ? configured.trim() : DEFAULT_LABELS.trigger;
}

function repoOf(choices: Readonly<Record<string, unknown>>, adapters: OnboardAdapters): string {
  const recorded = choices[CHOICE_KEYS.repo];
  if (typeof recorded === "string" && recorded.trim() !== "") return recorded.trim();
  const text = readConfigText(adapters);
  return (text ? readTomlKey(text, "github", "repo") : null) ?? "your repository";
}

/** A PR answer: 17, "17", "#17", or the PR's URL (github.com/o/r/pull/17).
 * A URL names its repo too, which the caller checks against the reviewed one. */
export function parsePrAnswer(raw: unknown): { pr: number; repo: string | null } | null {
  if (typeof raw === "number")
    return Number.isInteger(raw) && raw > 0 ? { pr: raw, repo: null } : null;
  if (typeof raw !== "string") return null;
  const v = raw.trim();
  const url =
    /^(?:https?:\/\/)?(?:www\.)?github\.com\/([A-Za-z0-9._-]+\/[A-Za-z0-9._-]+)\/pull\/(\d+)(?:[/?#].*)?$/.exec(
      v,
    );
  if (url) return { pr: Number(url[2]), repo: url[1]! };
  const n = /^#?(\d+)$/.exec(v);
  return n && Number(n[1]) > 0 ? { pr: Number(n[1]), repo: null } : null;
}

function prFrom(
  input: Readonly<Record<string, unknown>>,
  choices: Readonly<Record<string, unknown>>,
): { pr: number; repo: string | null } | null {
  for (const raw of [input.pr, input.url, parseProofRecord(choices[PROOF_CHOICE_KEY])?.pr]) {
    const parsed = parsePrAnswer(raw);
    if (parsed) return parsed;
  }
  return null;
}

/** A command file name the daemon's watcher serves (`*.json`), unique per call. */
export function reviewNowFileName(now: Date, pr: number): string {
  return `${now.toISOString().replace(/[:.]/g, "-")}-onboard-reviewnow-${pr}.json`;
}

/** The argv that writes one `review-now` command into the root-sealed
 * operator directory, through the same script the TUI's levers use. The
 * payload is built here from a number, so it can carry no quote. */
export function reviewNowWriteArgv(name: string, pr: number): string[] {
  if (!Number.isInteger(pr) || pr <= 0) throw new Error(`not a PR number: ${pr}`);
  const payload = JSON.stringify({ command: "review-now", pr });
  return [
    "sh",
    "-c",
    `printf '%s\\n' '${payload}' | ( ${operatorCommandWriteScriptAt(CONTAINER_COMMANDS_DIR, name)} )`,
  ];
}

/** The argv that prints the daemon's result for that command, or `pending`. */
export function reviewNowResultArgv(name: string): string[] {
  const file = `${CONTAINER_COMMANDS_DIR}/results/${name.replace(/\.json$/, "")}.result.json`;
  return ["sh", "-c", `if [ -f '${file}' ]; then cat '${file}'; else echo pending; fi`];
}

export interface OpenPr {
  number: number;
  title: string;
  author: string;
  updated_at: string;
  draft: boolean;
}

/** A token that can read the reviewed repo: the person's token file on the
 * own-account route, an App installation token on the App route; null when
 * neither is to hand (the offer is then skipped, never guessed). */
async function readToken(
  ctx: StepContext,
  repo: RepoSlug,
  apiBase: string,
  secretsDir: string,
): Promise<string | null> {
  if (userAuthRecorded(ctx.choices)) {
    const token = (readTextOrNull(join(secretsDir, GITHUB_TOKEN_FILE)) ?? "").trim();
    return token === "" ? null : token;
  }
  const creds = readCredentials(secretsDir);
  if (!creds.complete) return null;
  try {
    const jwt = mintAppJwt(creds.appId!, creds.pem!, () => ctx.adapters.clock().getTime());
    const found = await findInstallation(ctx.adapters.fetch, apiBase, jwt, repo.owner);
    if (found.status !== "found") return null;
    const minted = await installationToken(ctx.adapters.fetch, apiBase, jwt, found.id);
    return "token" in minted ? minted.token : null;
  } catch {
    return null;
  }
}

/** The repo's most recently updated open PRs (any author — the person's own
 * included). Empty when GitHub cannot be read. */
export async function listOpenPrs(
  fetchFn: typeof fetch,
  apiBase: string,
  token: string,
  repo: RepoSlug,
  limit = PR_OFFER_SIZE,
): Promise<OpenPr[]> {
  const r = await api(
    fetchFn,
    `${apiBase}/repos/${repo.owner}/${repo.name}/pulls?state=open&sort=updated&direction=desc&per_page=${limit}`,
    { headers: { authorization: `Bearer ${token}` } },
  );
  if (r.status !== 200 || !Array.isArray(r.body)) return [];
  return (r.body as Array<Record<string, unknown>>)
    .filter((p) => typeof p.number === "number")
    .slice(0, limit)
    .map((p) => ({
      number: p.number as number,
      title: typeof p.title === "string" ? p.title : "",
      author: textOf((p.user as { login?: unknown } | null)?.login),
      updated_at: typeof p.updated_at === "string" ? p.updated_at : "",
      draft: p.draft === true,
    }));
}

export function proofRoundStep(opts: ProofStepOptions = {}): OnboardingStep {
  const pollAttempts = opts.pollAttempts ?? 60;
  const pollIntervalMs = opts.pollIntervalMs ?? 30_000;
  const sleep = opts.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const dryrunLimit = opts.dryrunLimit ?? 40;
  const apiBase = opts.apiBase ?? "https://api.github.com";
  const resultAttempts = opts.resultAttempts ?? 15;
  const resultIntervalMs = opts.resultIntervalMs ?? 2_000;

  function log(ctx: StepContext, line: string): void {
    ctx.adapters.log?.(`${PROOF_STEP_ID}: ${line}`);
  }

  async function observe(
    transport: StackTransport,
    pr: number,
  ): Promise<{ obs: RoundObservation | null; detail: string }> {
    const r = await transport.exec(["node", "dist/src/cli.js", "why", String(pr), "--json"]);
    if (r.code !== 0) {
      return {
        obs: null,
        detail:
          (r.stderr || r.stdout).trim() || `\`qcr why\` in the daemon container exited ${r.code}`,
      };
    }
    const obs = parseWhy(r.stdout);
    return obs
      ? { obs, detail: "" }
      : { obs: null, detail: `\`qcr why\` did not answer JSON: ${r.stdout.slice(0, 200)}` };
  }

  /** Send `review-now` for `pr` and wait for the daemon's receipt. `refused`
   * means the daemon read the command and said no (its reason is the answer);
   * otherwise a failure is the channel itself (write or no receipt). */
  async function requestReview(
    ctx: StepContext,
    transport: StackTransport,
    pr: number,
  ): Promise<{ ok: boolean; refused: boolean; detail: string }> {
    const name = reviewNowFileName(ctx.adapters.clock(), pr);
    const write = await transport.execAsRoot(reviewNowWriteArgv(name, pr));
    if (write.code !== 0)
      return {
        ok: false,
        refused: false,
        detail: `the command write failed: ${(write.stderr || write.stdout).trim().slice(0, 200) || `exit ${write.code}`}`,
      };
    for (let attempt = 1; attempt <= resultAttempts; attempt += 1) {
      await sleep(resultIntervalMs);
      const read = await transport.exec(reviewNowResultArgv(name));
      const body = read.code === 0 ? read.stdout.trim() : "";
      if (body === "" || body === "pending") continue;
      let v: Record<string, unknown>;
      try {
        v = JSON.parse(body) as Record<string, unknown>;
      } catch {
        continue; // the daemon may still be writing its receipt
      }
      if (v.ok === true)
        return {
          ok: true,
          refused: false,
          detail: `queued${typeof v.state === "string" ? `, state ${v.state}` : ""}`,
        };
      return {
        ok: false,
        refused: true,
        detail:
          typeof v.reason === "string"
            ? v.reason.replace(/\s+/g, " ").slice(0, 300)
            : "no reason given",
      };
    }
    return {
      ok: false,
      refused: false,
      detail: `no answer to ${name} after ${resultAttempts} reads — the daemon may still be starting`,
    };
  }

  /** No PR yet: offer the repo's open PRs, and say what happens next. */
  async function askCheck(
    ctx: StepContext,
    repo: string,
    label: string,
    posture: string | null,
    typed: boolean,
  ): Promise<CheckResult> {
    const slug = parseRepoSlug(repo);
    let offer: OpenPr[] = [];
    if (slug) {
      const token = await readToken(
        ctx,
        slug,
        apiBase,
        opts.secretsDir ?? secretsDirFor(ctx.adapters, ctx.choices),
      );
      if (token) offer = await listOpenPrs(ctx.adapters.fetch, apiBase, token, slug);
    }
    const me = textOf(ctx.choices[CHOICE_KEYS.accountLogin]);
    const rows = offer.map(
      (p) =>
        `  #${p.number} ${p.title}${p.draft ? " (draft)" : ""} — by ${p.author}${me !== "" && p.author === me ? " (yours)" : ""}, updated ${p.updated_at}`,
    );
    const assurance =
      posture === "true"
        ? "Nothing will be posted to GitHub: dry_run is on, so every would-be comment and review is written to a file instead, and you will read it here before deciding anything."
        : posture === "false"
          ? "This installation is LIVE (dry_run = false): the review will be posted to GitHub. The flag belongs to you; these instructions do not change it."
          : "The dry_run posture could not be read, so posting is unknown. Check the live config before reviewing a PR.";
    return {
      name: "ask",
      ok: false,
      detail:
        (typed ? "That is not a pull request number or link.\n" : "") +
        "Read this out, then call this tool again with the PR number (pr) or its link (url).\n\n" +
        (rows.length > 0
          ? `The ${rows.length} most recently updated open pull requests in ${repo}:\n${rows.join("\n")}\n` +
            "Pick one of these — or any other open PR in it — one you would actually want reviewed.\n"
          : `Pick a real, open pull request in ${repo} — one you would actually want reviewed (your own is fine).\n`) +
        "Its review starts as soon as you name it: nothing to add to the PR. (For later reviews, the trigger is the label " +
        `"${label}" — the reviewer never reviews anything on its own initiative.)\n` +
        assurance,
    };
  }

  return {
    id: PROOF_STEP_ID,
    title: "The proof: watch a real PR get reviewed",
    explain:
      "The wizard does not call itself done until you have seen the reviewer work, on one real, open pull request. Call this " +
      "tool with no arguments to get the repo's five most recently updated open PRs (the operator's own included) to pick " +
      "from, then call it again with pr (a number) or url (the PR's link). The review starts IMMEDIATELY — no label to add: " +
      "the wizard asks the daemon directly. It follows the round through the daemon's own state until a verdict lands, then " +
      "SHOWS the review — the verdict, how many findings, the top ones, and where the full text is — read out of the " +
      "dry-run record, so they judge it while it is still impossible for it to have posted to GitHub. If nothing happens, " +
      "or the round fails, it says what to check rather than waiting forever.",
    order: 76,
    parameters: {
      type: "object",
      properties: {
        pr: {
          type: "integer",
          description:
            "The pull request number to review now. Call with no arguments first to get the open PRs to choose from.",
        },
        url: {
          type: "string",
          description:
            "The pull request's URL, instead of its number (github.com/<owner>/<repo>/pull/<n>).",
        },
        confirm_live: {
          type: "string",
          description:
            'Only when the installation is LIVE (dry_run = false): "yes" means the operator agreed that this review posts to GitHub.',
        },
      },
    },

    async run(ctx): Promise<StepReport> {
      const transport = stackTransportFor(ctx, opts.transport);
      const repo = repoOf(ctx.choices, ctx.adapters);
      const label = triggerLabelOf(ctx.adapters);
      let posture: string | null = null;
      try {
        posture = String(loadConfig(configPath(ctx.adapters)).dry_run);
      } catch {
        /* Unknown posture stays explicit. */
      }
      const answer = prFrom(ctx.input, ctx.choices);
      const typed = ctx.input.pr !== undefined || ctx.input.url !== undefined;
      if (answer === null || (typed && parsePrAnswer(ctx.input.pr ?? ctx.input.url) === null)) {
        return { ok: false, checks: [await askCheck(ctx, repo, label, posture, typed)] };
      }
      const pr = answer.pr;
      if (answer.repo !== null && answer.repo.toLowerCase() !== repo.toLowerCase()) {
        return {
          ok: false,
          checks: [
            {
              name: "ask",
              ok: false,
              detail:
                `that link is a pull request in ${answer.repo}, but this reviewer reviews ${repo}. Pick an open PR in ${repo} ` +
                "(or change the reviewed repo in the earlier GitHub step)",
            },
          ],
        };
      }
      if (posture !== "true" && textOf(ctx.input.confirm_live).trim().toLowerCase() !== "yes") {
        return {
          ok: false,
          checks: [
            {
              name: "live",
              ok: false,
              detail:
                posture === "false"
                  ? `This installation is LIVE (dry_run = false): reviewing #${pr} now POSTS the review to GitHub. Ask the operator; ` +
                    'only on their yes, call this step again with confirm_live: "yes". The flag is theirs; this step never changes it.'
                  : `The dry_run posture could not be read (${configPath(ctx.adapters)}), so whether this review would post is unknown. ` +
                    'Fix the config first — or, on the operator\'s explicit yes, call again with confirm_live: "yes".',
            },
          ],
        };
      }
      if (!(await transport.running())) {
        return {
          ok: false,
          checks: [
            {
              name: "stack",
              ok: false,
              detail:
                `the daemon container is not running ${transport.where}, so no round can start — Fix: run the bring-up step ` +
                "for your topology (compose here, the deploy on the server route), then this one",
            },
          ],
        };
      }

      // Where the PR stands before anything is asked of the daemon.
      const first = await observe(transport, pr);
      if (first.obs === null)
        return { ok: false, checks: [stateStoreCheck(first.detail, transport)] };
      const before = first.obs.rounds.at(-1);
      const recorded = parseProofRecord(ctx.choices[PROOF_CHOICE_KEY]);
      const resumable =
        recorded !== null &&
        recorded.pr === pr &&
        before !== undefined &&
        before.round_no === recorded.round_no &&
        completedRound(before);
      const inFlight =
        before?.status === "running" ||
        first.obs.state === "queued" ||
        first.obs.state === "reviewing";
      const initial = classifyRounds(first.obs);
      log(
        ctx,
        initial.kind === "waiting"
          ? initial.detail
          : `#${pr} has ${first.obs.rounds.length} round${first.obs.rounds.length === 1 ? "" : "s"} on record (newest: round ${before?.round_no}, ${before?.status})`,
      );

      // Ask for the review — unless one is already under way, or this is a
      // re-run that only has to show the round it already recorded.
      let requested = false;
      let requestNote = "";
      if (!resumable && !inFlight) {
        const sent = await requestReview(ctx, transport, pr);
        requested = sent.ok;
        requestNote = sent.detail;
        if (!sent.ok && sent.refused)
          return {
            ok: false,
            checks: [
              {
                name: "review-now",
                ok: false,
                detail:
                  `the daemon refused to review #${pr} now: ${sent.detail}. ` +
                  `If this daemon predates "review this one PR now", add the label "${label}" to the PR instead and run this step again — ` +
                  "the label is the trigger the daemon has always understood.",
              },
            ],
          };
        log(
          ctx,
          sent.ok
            ? `asked the daemon to review #${pr} now (${sent.detail}) — no label needed`
            : `could not ask the daemon directly (${sent.detail}); following #${pr} in case it is labelled "${label}"`,
        );
      }
      // Only a round NEWER than the ones before the request answers it.
      const floor = requested ? (before?.round_no ?? 0) : -Infinity;

      log(
        ctx,
        `following #${pr} — checking the daemon's state every ${Math.round(pollIntervalMs / 1000)}s, up to ${pollAttempts} times`,
      );
      let last = "";
      let settledPolls = 0;
      for (let attempt = 1; attempt <= pollAttempts; attempt += 1) {
        const { obs, detail } = await observe(transport, pr);
        if (obs === null) return { ok: false, checks: [stateStoreCheck(detail, transport)] };
        const fresh = { ...obs, rounds: obs.rounds.filter((r) => r.round_no > floor) };
        const outcome = classifyRounds(fresh);
        if (outcome.kind === "done") {
          log(ctx, `round ${outcome.round.round_no} finished with ${outcome.round.verdict}`);
          return finish(ctx, transport, pr, outcome.round);
        }
        if (outcome.kind === "failed") {
          return { ok: false, checks: [roundFailedCheck(outcome.round, pr, transport)] };
        }
        // Asked, but the daemon settled the PR without a new round (nothing
        // changed since a review of this same head): that review is the answer.
        if (
          requested &&
          outcome.kind === "waiting" &&
          obs.state !== "queued" &&
          obs.state !== "reviewing"
        ) {
          settledPolls += 1;
          const standing = obs.rounds.at(-1);
          if (settledPolls >= 2 && completedRound(standing)) {
            log(
              ctx,
              `the daemon reviewed nothing new — #${pr}'s head was already reviewed in round ${standing.round_no}; showing that review`,
            );
            return finish(ctx, transport, pr, standing);
          }
        } else settledPolls = 0;
        last =
          outcome.kind === "running"
            ? `round ${outcome.round.round_no} is running (started ${outcome.round.started_at})`
            : requested && obs.state === "queued"
              ? "queued — the round starts as soon as a review slot is free"
              : outcome.detail;
        log(ctx, `${last} — attempt ${attempt}/${pollAttempts}`);
        if (attempt < pollAttempts) await sleep(pollIntervalMs);
      }
      return {
        ok: false,
        checks: [
          timeoutCheck(
            pr,
            repo,
            label,
            last,
            pollAttempts,
            pollIntervalMs,
            transport,
            requested ? requestNote : null,
          ),
        ],
      };
    },

    async verify(ctx): Promise<StepReport> {
      const proof = parseProofRecord(ctx.choices[PROOF_CHOICE_KEY]);
      if (!proof) {
        return {
          ok: false,
          checks: [
            {
              name: "proof",
              ok: false,
              detail:
                "no proof round yet — run this step: the wizard is not finished until you have watched a real PR reviewed",
            },
          ],
        };
      }
      const { obs, detail } = await observe(stackTransportFor(ctx, opts.transport), proof.pr);
      if (obs === null) {
        return {
          ok: false,
          checks: [
            {
              name: "proof",
              ok: false,
              detail: `could not re-read the proof round for #${proof.pr} (${detail}) — Fix: is the daemon running?`,
            },
          ],
        };
      }
      const round = obs.rounds.find((r) => r.round_no === proof.round_no);
      return completedRound(round)
        ? {
            ok: true,
            checks: [
              {
                name: "proof",
                ok: true,
                detail: `#${proof.pr} round ${proof.round_no} is still recorded as ${round.verdict} in the daemon's own state — the proof stands`,
              },
            ],
          }
        : {
            ok: false,
            checks: [
              {
                name: "proof",
                ok: false,
                detail:
                  `the daemon's state no longer shows #${proof.pr} round ${proof.round_no} as a finished round — Fix: run this ` +
                  "step again (label a PR and follow it) so the proof is real rather than remembered",
              },
            ],
          };
    },
  };

  /** Round finished: read the dry-run record and SHOW the review. */
  async function finish(
    ctx: StepContext,
    transport: StackTransport,
    pr: number,
    round: ObservedRound,
  ): Promise<StepReport> {
    const checks: CheckResult[] = [
      {
        name: "round",
        ok: true,
        detail:
          `#${pr} round ${round.round_no} finished with verdict ${round.verdict}` +
          `${round.summary ? `\nThe session's own summary: ${round.summary}` : ""}`,
      },
    ];
    const read = await readContainerDryrun(transport, dryrunLimit, {
      since: Date.parse(round.started_at),
      pr,
    });
    const { problem, unread } = read;
    const records = roundRecords(read.records, round).filter((r) => recordForPr(r, pr));
    const review = problem ? null : sandboxReviewFrom(records, pr);
    if (!review) {
      const cause = [
        problem,
        unread.length > 0
          ? `${unread.length} recorded file${unread.length === 1 ? "" : "s"} could not be read — ${unread.slice(0, 3).join("; ")}` +
            `${unread.length > 3 ? "; …" : ""}`
          : "",
      ]
        .filter(Boolean)
        .join("; ");
      checks.push({
        name: "review",
        ok: false,
        detail:
          `the round finished, but no recorded review for #${pr} was found in the dry-run record` +
          `${cause ? ` (${cause})` : ""}. Fix: ` +
          (unread.length > 0
            ? "the files above are on the daemon's volume but unreadable from here — fix that read first; then "
            : "") +
          `check that dry_run is still true (\`grep -n '^dry_run' ${configPath(ctx.adapters)}\`) — if it is ` +
          "false the review went to GitHub for real and you can read it there; otherwise " +
          `\`${transport.execCommand(`ls ${CONTAINER_DRYRUN_DIR}`)}\` shows what the gate did record`,
      });
      return { ok: false, checks };
    }
    const other = records.filter((r) => r.kind !== "create_review").length;
    const file = records
      .filter((r) => r.kind === "create_review" && r.reviewPurpose === undefined)
      .at(-1)?.file;
    checks.push({
      name: "review",
      ok: true,
      detail: renderReview(review, pr, {
        verdict: round.verdict,
        ...(file
          ? { file, readCommand: transport.execCommand(`cat ${CONTAINER_DRYRUN_DIR}/${file}`) }
          : {}),
      }),
    });
    checks.push({
      name: "nothing-posted",
      ok: true,
      detail:
        `${records.length} would-be GitHub call${records.length === 1 ? "" : "s"} for #${pr} were recorded to state/dryrun/ and ` +
        `none was executed — the review above plus ${other} other intent${other === 1 ? "" : "s"} (labels, comments). This is ` +
        "what dry_run means: the reviewer does all the work and the gate writes the result to a file instead of to GitHub",
    });
    const record: ProofRecord = {
      pr,
      round_no: round.round_no,
      verdict: round.verdict ?? "",
      completed_at: ctx.adapters.clock().toISOString(),
      review_shown: true,
    };
    ctx.recordChoice(CHOICE_KEYS.proof, record);
    return { ok: true, checks, data: { proof: record } };
  }
}

/**
 * The dry-run records that belong to THIS round: recorded at or after it
 * started. The dry-run dir is cumulative, so without this a re-run whose round
 * recorded no review would show — and certify — an earlier round's review.
 * A round whose start the daemon did not report cannot be bound, and keeps
 * every record rather than refusing outright.
 */
export function roundRecords(records: DryrunRecord[], round: ObservedRound): DryrunRecord[] {
  const start = Date.parse(round.started_at);
  if (Number.isNaN(start)) return records;
  return records.filter((r) => {
    const at = Date.parse(r.recorded_at ?? "");
    return !Number.isNaN(at) && at >= start;
  });
}

function roundFailedCheck(
  round: ObservedRound,
  pr: number,
  transport: StackTransport,
): CheckResult {
  return {
    name: "round",
    ok: false,
    detail:
      `#${pr} round ${round.round_no} ended as "${round.status}"${round.summary ? `: ${round.summary}` : ""}.\n` +
      "That is a real failure, not a wizard problem, and the daemon knows why. Fix, in order:\n" +
      `① \`${transport.cliCommand("events --tail 40")}\` — the daemon's own event log;\n` +
      `② \`${transport.logsCommand(200)}\` — the process log, including the review session's own errors;\n` +
      '③ a round that ended "cancelled" right after a restart is the boot-time orphan sweep and is harmless — ' +
      "re-add the trigger label and run this step again;\n" +
      '④ a round that ended "overdue" or "expired" ran out of its deadline: the most common cause on a first ' +
      "install is that the review session has no working model credential — " +
      `\`qcr tui ${pr}\` opens the board on the PR, whose pane is the round's own live log, ` +
      "and an authentication error there is the answer.",
  };
}

function stateStoreCheck(detail: string, transport: StackTransport): CheckResult {
  return {
    name: "state-store",
    ok: false,
    detail:
      `could not read the daemon's state (${detail}) — Fix: \`${transport.logsCommand(200)}\`. The daemon ` +
      "may still be starting (the image is prebuilt; its first boot migrates state and reconciles), so give it a minute after bring-up and run this step again",
  };
}

function timeoutCheck(
  pr: number,
  repo: string,
  label: string,
  last: string,
  attempts: number,
  intervalMs: number,
  transport: StackTransport,
  /** Set when the review was asked for directly (review-now): its receipt. */
  requested: string | null = null,
): CheckResult {
  const minutes = Math.round((attempts * intervalMs) / 60_000);
  return {
    name: "round",
    ok: false,
    detail:
      `no finished round for #${pr} after ${minutes} minutes of watching (last seen: ${last || "nothing at all"}). ` +
      "Nothing is broken by this — the wizard simply stopped waiting, and running this step again picks the watch back up.\n" +
      (requested !== null
        ? `The review WAS asked for directly (the daemon answered: ${requested}), so no label is needed. A first round on a ` +
          "big PR can take a while; `qcr tui " +
          `${pr}\` shows the round's own live log. If it never started:\n`
        : "") +
      "What to check, in the order that actually finds it:\n" +
      `① the label on #${pr} must be exactly "${label}" — the daemon matches the name from [github] trigger_label, and a ` +
      "near-miss looks like nothing happening;\n" +
      `② the PR must be in ${repo}, open, and not authored by the App itself;\n` +
      "③ if you chose the polling-only ingress there is no webhook at all: the reconcile poll picks the label up within one " +
      "poll interval ([daemon] poll_interval_s, 300s by default), so give it that long;\n" +
      "④ otherwise the webhook may not be arriving — re-run the verify_stack step, which checks GitHub's own delivery log;\n" +
      `⑤ \`${transport.cliCommand("events --tail 40")}\` shows what the daemon has been doing meanwhile.`,
  };
}
