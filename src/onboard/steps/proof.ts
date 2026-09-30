// The proof round — the wizard's done-bar, and the reason the whole
// wizard exists in this shape: the operator does not get told the reviewer
// works, they WATCH it work, on a real pull request of their own, and they read
// the review it produced before anything could ever reach GitHub.
//
// The shape:
//   1. ask for a real PR of theirs with the trigger label on it (the wizard
//      never creates a demo PR — spec, "Out of Scope");
//   2. follow the round to completion THROUGH THE STATE STORE — the daemon's
//      own record, read with the daemon's own `qcr why --json` inside the
//      container, so the wizard is reading exactly what the operator would;
//   3. SHOW the finished review, read out of the dry-run record — the file the
//      mutation gate wrote INSTEAD of calling GitHub. The operator judges the
//      output while it is still impossible for it to have posted.
//
// Two paths get real guidance rather than a spinner, because they are the two
// that actually happen: the round never starts (label spelling, webhook not
// arriving, the poll interval on the polling-only shape) and the round fails or
// is cancelled (the daemon's own event log says why). Neither ever hangs: the
// poll is bounded and every attempt logs where it got to.
//
// Nothing here writes anything anywhere. It reads the state store, reads the
// dry-run directory, and records what it saw on the checklist — the record the
// go-live step later demands before it will even offer the flip.
import { CHOICE_KEYS } from "../choices.js";
import type {
  CheckResult,
  OnboardAdapters,
  OnboardingStep,
  StepContext,
  StepReport,
} from "../engine.js";
import { sandboxReviewFrom, type DryrunRecord, type ReviewSnapshot } from "../../compare.js";
import { CONTAINER_DRYRUN_DIR, readConfigText } from "./compose.js";
import { readTomlKey } from "./ingress.js";
import { DEFAULT_LABELS } from "./githubapp.js";
import { stackTransportFor, type StackTransport, type TransportOptions } from "./transport.js";

export const PROOF_STEP_ID = "proof_round";
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
  if (round.status === "done" && round.verdict) return { kind: "done", round };
  if (round.status === "running") return { kind: "running", round };
  if (round.status === "done") return { kind: "running", round };
  return { kind: "failed", round };
}

// ---- the dry-run record, read out of the container ---------------------------

export interface DryrunRead {
  records: DryrunRecord[];
  problem: string;
}

/**
 * Read `state/dryrun/` from inside the daemon container: list, then read the
 * newest few. Through the transport's `exec`, because the state lives on the
 * daemon's own volume — `docker compose exec` on this machine, `ssh <alias>
 * sudo docker exec` on the server route, and this function never learns which.
 */
export async function readContainerDryrun(
  transport: StackTransport,
  limit = 40,
): Promise<DryrunRead> {
  const list = await transport.exec(["ls", "-1", CONTAINER_DRYRUN_DIR]);
  if (list.code !== 0) {
    return {
      records: [],
      problem:
        `could not list ${CONTAINER_DRYRUN_DIR} in the daemon container (${(list.stderr || list.stdout).trim() || `exit ${list.code}`}). ` +
        "That directory only exists once the gate has recorded its first would-be mutation",
    };
  }
  const names = list.stdout
    .split("\n")
    .map((l) => l.trim())
    .filter((l) => l.endsWith(".json"))
    .sort();
  const wanted = names.slice(Math.max(0, names.length - limit));
  const records: DryrunRecord[] = [];
  for (const name of wanted) {
    const cat = await transport.exec(["cat", `${CONTAINER_DRYRUN_DIR}/${name}`]);
    if (cat.code !== 0) continue;
    try {
      records.push({ ...(JSON.parse(cat.stdout) as DryrunRecord), file: name });
    } catch {
      records.push({
        kind: "unparseable",
        method: "?",
        path: "?",
        note: `could not parse ${name}`,
        file: name,
      });
    }
  }
  return { records, problem: "" };
}

/** The would-be review, rendered for a human to judge. */
export function renderReview(review: ReviewSnapshot, pr: number): string {
  const head = [
    `This is the review your reviewer produced for #${pr}. It was NOT posted: dry_run is on, so the`,
    `mutation gate wrote it to state/dryrun/ instead of calling GitHub.`,
    "",
    `Verdict it would have submitted: ${review.state}`,
    `Inline comments: ${review.comments.length}`,
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
}

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

function prFrom(
  input: Readonly<Record<string, unknown>>,
  choices: Readonly<Record<string, unknown>>,
): number | null {
  for (const raw of [input.pr, parseProofRecord(choices[PROOF_CHOICE_KEY])?.pr]) {
    const n = typeof raw === "string" ? Number(raw.trim()) : raw;
    if (typeof n === "number" && Number.isInteger(n) && n > 0) return n;
  }
  return null;
}

export function proofRoundStep(opts: ProofStepOptions = {}): OnboardingStep {
  const pollAttempts = opts.pollAttempts ?? 60;
  const pollIntervalMs = opts.pollIntervalMs ?? 30_000;
  const sleep = opts.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const dryrunLimit = opts.dryrunLimit ?? 40;

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

  return {
    id: PROOF_STEP_ID,
    title: "The proof: watch a real PR get reviewed",
    explain:
      "The wizard does not call itself done until you have seen the reviewer work. Ask the operator to open (or pick) one of " +
      "their own pull requests and put the trigger label on it, then call this tool with that PR number. It follows the round " +
      "through the daemon's own state until a verdict lands, and then SHOWS them the review it produced — read out of the " +
      "dry-run record, so they judge the output while it is still impossible for it to have posted to GitHub. If nothing " +
      "happens, or the round fails, it says what to check rather than waiting forever.",
    order: 76,
    parameters: {
      type: "object",
      properties: {
        pr: {
          type: "integer",
          description:
            "The pull request number the operator labelled. Call with no arguments first to get the exact instructions to read out.",
        },
      },
    },

    async run(ctx): Promise<StepReport> {
      const transport = stackTransportFor(ctx, opts.transport);
      const repo = repoOf(ctx.choices, ctx.adapters);
      const label = triggerLabelOf(ctx.adapters);
      const pr = prFrom(ctx.input, ctx.choices);
      if (pr === null) {
        return {
          ok: false,
          checks: [
            {
              name: "ask",
              ok: false,
              detail:
                `Read this out, then call this tool again with the PR number.\n\n` +
                `Pick a real, open pull request of yours in ${repo} — one you would actually want reviewed. Add the label ` +
                `"${label}" to it. That label IS the trigger: the reviewer never reviews anything on its own initiative.\n` +
                `Nothing will be posted to GitHub: dry_run is on, so every would-be comment and review is written to a file ` +
                `instead, and you will read it here before deciding anything.`,
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

      log(
        ctx,
        `following #${pr} — checking the daemon's state every ${Math.round(pollIntervalMs / 1000)}s, up to ${pollAttempts} times`,
      );
      let last = "";
      for (let attempt = 1; attempt <= pollAttempts; attempt += 1) {
        const { obs, detail } = await observe(transport, pr);
        if (obs === null) {
          return {
            ok: false,
            checks: [
              {
                name: "state-store",
                ok: false,
                detail:
                  `could not read the daemon's state (${detail}) — Fix: \`${transport.logsCommand(200)}\`. The daemon ` +
                  "builds itself on first boot, so give it a minute after bring-up and run this step again",
              },
            ],
          };
        }
        const outcome = classifyRounds(obs);
        if (outcome.kind === "done") {
          log(ctx, `round ${outcome.round.round_no} finished with ${outcome.round.verdict}`);
          return finish(ctx, transport, pr, outcome.round);
        }
        if (outcome.kind === "failed") {
          return { ok: false, checks: [roundFailedCheck(outcome.round, pr, transport)] };
        }
        last =
          outcome.kind === "running"
            ? `round ${outcome.round.round_no} is running (started ${outcome.round.started_at})`
            : outcome.detail;
        log(ctx, `${last} — attempt ${attempt}/${pollAttempts}`);
        if (attempt < pollAttempts) await sleep(pollIntervalMs);
      }
      return {
        ok: false,
        checks: [timeoutCheck(pr, repo, label, last, pollAttempts, pollIntervalMs, transport)],
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
      return round && round.status === "done" && round.verdict
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
    const read = await readContainerDryrun(transport, dryrunLimit);
    const { problem } = read;
    const records = roundRecords(read.records, round);
    const review = problem ? null : sandboxReviewFrom(records, pr);
    if (!review) {
      checks.push({
        name: "review",
        ok: false,
        detail:
          `the round finished, but no recorded review for #${pr} was found in the dry-run record` +
          `${problem ? ` (${problem})` : ""}. Fix: check that dry_run is still true (\`grep dry_run config.toml\`) — if it is ` +
          "false the review went to GitHub for real and you can read it there; otherwise " +
          `\`${transport.execCommand(`ls ${CONTAINER_DRYRUN_DIR}`)}\` shows what the gate did record`,
      });
      return { ok: false, checks };
    }
    const other = records.filter((r) => r.kind !== "create_review").length;
    checks.push({ name: "review", ok: true, detail: renderReview(review, pr) });
    checks.push({
      name: "nothing-posted",
      ok: true,
      detail:
        `${records.length} would-be GitHub call${records.length === 1 ? "" : "s"} were recorded to state/dryrun/ and none was ` +
        `executed — the review above plus ${other} other intent${other === 1 ? "" : "s"} (labels, comments). This is what ` +
        "dry_run means: the reviewer does all the work and the gate writes the result to a file instead of to GitHub",
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
 * every record (the pre-binding behaviour) rather than refusing outright.
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
      `install is that the review session has no working model credential — \`${transport.attachCommand(`pr-${pr}`)}\` ` +
      "shows the session, and a login prompt there is the answer.",
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
): CheckResult {
  const minutes = Math.round((attempts * intervalMs) / 60_000);
  return {
    name: "round",
    ok: false,
    detail:
      `no finished round for #${pr} after ${minutes} minutes of watching (last seen: ${last || "nothing at all"}). ` +
      "Nothing is broken by this — the wizard simply stopped waiting, and running this step again picks the watch back up.\n" +
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
