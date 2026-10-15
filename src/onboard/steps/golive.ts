// The go-live offer — the one place in the entire wizard that may
// touch `dry_run`, and the strictest thing in it.
//
// Root rule 1: `dry_run` is the owner's flag alone — in a fresh installation,
// whoever now owns that installation — and the flip is their conscious act,
// offered once, after they have watched a real review, never assumed and
// never a side effect. Everything below is that sentence made structural:
//
//   * `flipDryRunToFalse` is the only function in the wizard that writes the
//     flag, and it throws unless it is handed (a) the exact confirmation
//     phrase and (b) a completed proof record. No caller can flip by omission,
//     by a default argument, or by passing an empty object.
//   * every other step in the wizard routes its config edits through
//     `assertNoDryRunEdit`, which refuses an edit naming the flag however it
//     is spelled — so the flag cannot move as a side effect of a slug
//     correction, a hostname fill or anything else.
//   * the proof is re-verified against the daemon's own state store at flip
//     time, not merely read from the checklist: a forged or stale checklist
//     entry does not buy a flip.
//   * with no `decision` in the tool call the step OFFERS and changes nothing.
//     The offer is red (the wizard wants an answer) but the answer "no" is
//     green.
//
// Declining is a first-class outcome, and this file has to mean it. A dry-run
// installation is a fully working installation: every round runs, every review
// is written, the TUI, the memory engine, the companion and the feedback loop
// all work — the single difference is that the gate writes the result to a
// file instead of to GitHub. The decline path therefore records the decision,
// writes nothing, and reports green with that explanation. It is not a failure
// and must never be presented as one.
import { rmSync } from "node:fs";
import { join } from "node:path";
import { loadConfig } from "../../config.js";
import type {
  CheckResult,
  OnboardAdapters,
  OnboardingStep,
  StepContext,
  StepReport,
} from "../engine.js";
import { configPath, readConfigText, writeAtomic, type StreamRunner } from "./compose.js";
import { patchToml } from "./configfill.js";
import {
  PROOF_CHOICE_KEY,
  PROOF_STEP_ID,
  parseProofRecord,
  parseWhy,
  type ProofRecord,
} from "./proof.js";
import { stackTransportFor, type StackTransport, type TransportOptions } from "./transport.js";

export const GO_LIVE_STEP_ID = "go_live";
/** Recorded decision: "live" | "dry_run" (declined). */
export const GO_LIVE_CHOICE_KEY = "go_live_decision";

/** The phrase the operator must say. Not "yes": a flip is worth a sentence. */
export const GO_LIVE_CONFIRMATION = "GO LIVE";

export function isGoLiveConfirmation(value: unknown): boolean {
  return typeof value === "string" && value.trim().toUpperCase() === GO_LIVE_CONFIRMATION;
}

/** The opening paragraph of the explanation: where the installation stands
 * NOW, read off config.toml — true, already live, or unreadable. */
function posture(dryRun: boolean | null): string[] {
  if (dryRun === false) {
    return [
      "Right now `dry_run = false` in your config.toml: this installation is already LIVE, and its reviews",
      "are posted to GitHub. In dry-run everything would still run, but the single gate every GitHub write",
      "passes through would record what it WOULD have done into state/dryrun/ instead of doing it.",
    ];
  }
  if (dryRun === null) {
    return [
      "Right now your config.toml cannot be read, so whether this installation is in dry-run is unknown —",
      "fix the file before deciding. In dry-run everything runs, but the single gate every GitHub write",
      "passes through records what it WOULD have done into state/dryrun/ instead of doing it.",
    ];
  }
  return [
    "Right now `dry_run = true` in your config.toml. Everything runs — a labelled PR starts a round, the",
    "lenses read the diff, the session writes a review — but the single gate every GitHub write passes",
    "through records what it WOULD have done into state/dryrun/ instead of doing it. You just read one of",
    "those records. Nothing this system has ever done has reached your repository.",
  ];
}

/** What dry-run is and what going live means — the teach text, offered once,
 * opening on the installation's current posture. */
export function goLiveExplanation(dryRun: boolean | null): string {
  return [
    "One decision is left, and it is yours alone.",
    "",
    ...posture(dryRun),
    "",
    "Going live sets that flag to false. From then on the reviewer posts for real: reviews and inline",
    "comments on labelled pull requests, its own status labels, and replies to the author. It still never",
    "dismisses anyone's review and never touches your default branch. It nominates a human reviewer only",
    "if you turned escalation on at step 36 — and then only the people you named, beside a verdict it has",
    "already decided.",
    "",
    "Declining is a completely normal answer, and not a lesser one. A dry-run installation is a fully",
    "working installation: you get every review, in files, and you can flip whenever you like by re-running",
    "this step or by editing that one line yourself. Plenty of people run it this way for a week first.",
  ].join("\n");
}

/** The explanation as offered on an installation still in dry-run. */
export const GO_LIVE_EXPLANATION = goLiveExplanation(true);

/** Step data: the flag is on disk as false, but the restart that makes the
 * daemon read it did not complete — kept until a run pays it. */
const RESTART_OWED_KEY = "restart_owed";

/**
 * What comes after onboarding, said at its end whichever way the operator
 * answered: the reviewer knows
 * nothing about the repo yet. A recommendation only — this step starts
 * nothing, and setup changes no review until the operator deploys the
 * profile it writes.
 */
export const SETUP_RECOMMENDATION =
  "Next, set up your repo: run `qcr setup` (or press I on the TUI board). Until you do, the reviewer knows nothing " +
  "about this codebase — every PR gets the same generic lenses. The companion surveys the repo (its agent and design " +
  "docs, then a sample of each part of the code; you see the cost first), reads what past reviews asked for, and " +
  "interviews you about what matters here; your answers become the repo profile. Nothing changes in PR reviews until " +
  "you deploy that profile.";

// ---- the flip ----------------------------------------------------------------

export class GoLiveRefused extends Error {}

/**
 * Set `dry_run = false` in a config document — the one writer of that key in
 * the wizard, and a total refusal without both guards.
 *
 * @throws GoLiveRefused when the confirmation phrase is not exactly right, when
 * there is no completed proof round behind it, or when the document does not
 * carry a `dry_run` key to change (we never INVENT the flag: a config without
 * it is not a config this step understands).
 */
export function flipDryRunToFalse(
  toml: string,
  guards: { confirmation: unknown; proof: ProofRecord | null },
): string {
  if (!isGoLiveConfirmation(guards.confirmation)) {
    throw new GoLiveRefused(
      `refusing to change dry_run: the flip needs the explicit confirmation "${GO_LIVE_CONFIRMATION}"`,
    );
  }
  if (guards.proof === null) {
    throw new GoLiveRefused(
      "refusing to change dry_run: the flip is only offered after a completed proof round",
    );
  }
  if (!/^\s*dry_run\s*=/m.test(toml)) {
    throw new GoLiveRefused(
      "refusing to change dry_run: this config.toml has no dry_run key — edit it by hand and re-run",
    );
  }
  return patchToml(toml, [{ section: "", key: "dry_run", value: "false" }]);
}

// ---- the step ----------------------------------------------------------------

export type GoLiveDecision = "go_live" | "stay_dry_run";

export interface GoLiveStepOptions {
  stream?: StreamRunner;
}

/** The stream runner is the transport's, not this step's: the "restart" that
 * makes the daemon re-read the flag is `docker compose restart` here and
 * `scripts/deploy.sh sync` on the server route, and only the transport knows
 * which. */
function transportOptionsOf(opts: GoLiveStepOptions): TransportOptions {
  return opts.stream ? { stream: opts.stream } : {};
}

function decisionOf(input: Readonly<Record<string, unknown>>): GoLiveDecision | null {
  const raw = String(input.decision ?? "")
    .trim()
    .toLowerCase();
  if (raw === "go_live" || raw === "live" || raw === "yes") return "go_live";
  if (raw === "stay_dry_run" || raw === "dry_run" || raw === "no") return "stay_dry_run";
  return null;
}

function currentDryRun(adapters: OnboardAdapters): boolean | null {
  try {
    return loadConfig(configPath(adapters)).dry_run;
  } catch {
    return null;
  }
}

export function goLiveStep(opts: GoLiveStepOptions = {}): OnboardingStep {
  const transportOpts = transportOptionsOf(opts);

  /**
   * The proof, re-verified against the daemon's own state store. The checklist
   * entry alone is NOT enough: it is a file, and this is the one decision in
   * the wizard where a file must not be the evidence.
   */
  async function provenProof(
    ctx: StepContext,
    transport: StackTransport,
  ): Promise<{ proof: ProofRecord | null; detail: string }> {
    const recorded = parseProofRecord(ctx.choices[PROOF_CHOICE_KEY]);
    if (!recorded) {
      return {
        proof: null,
        detail:
          "there is no completed proof round on this installation yet. The flip is offered only after you have watched a real " +
          `pull request reviewed end to end and read the result — run the ${PROOF_STEP_ID} step first.`,
      };
    }
    const r = await transport.exec([
      "node",
      "dist/src/cli.js",
      "why",
      String(recorded.pr),
      "--json",
    ]);
    const obs = r.code === 0 ? parseWhy(r.stdout) : null;
    if (obs === null) {
      return {
        proof: null,
        detail:
          `the proof round on #${recorded.pr} could not be re-checked against the daemon's own state ` +
          `(${(r.stderr || r.stdout).trim().slice(0, 200) || `exit ${r.code}`}) — the flip is never made on the strength of the ` +
          "checklist file alone. Fix: make sure the daemon is running, then run this step again",
      };
    }
    const round = obs.rounds.find((x) => x.round_no === recorded.round_no);
    if (!round || round.status !== "done" || !round.verdict) {
      return {
        proof: null,
        detail:
          `the daemon's state does not show #${recorded.pr} round ${recorded.round_no} as a finished round, so the recorded ` +
          "proof cannot be confirmed. Fix: run the proof_round step again and watch a round through",
      };
    }
    return { proof: recorded, detail: "" };
  }

  return {
    id: GO_LIVE_STEP_ID,
    title: "Go live, or stay in dry-run",
    explain:
      "The last decision, and it belongs to the operator. Read out what dry-run is and what going live means, then ask. " +
      "Do not push: declining is a completely normal outcome and leaves a fully working installation. Call this tool with no " +
      'arguments to get the explanation to read out; then call it again with decision: "stay_dry_run", or with ' +
      `decision: "go_live" AND confirm: "${GO_LIVE_CONFIRMATION}" if — and only if — they said so explicitly.`,
    order: 78,
    parameters: {
      type: "object",
      properties: {
        decision: {
          type: "string",
          enum: ["go_live", "stay_dry_run"],
          description:
            "The operator's own answer. Omit to have the step explain dry-run and going live so you can ask them.",
        },
        confirm: {
          type: "string",
          description: `Required for decision "go_live", and only then: the operator's explicit confirmation, the words ${GO_LIVE_CONFIRMATION}.`,
        },
      },
    },

    async run(ctx): Promise<StepReport> {
      const transport = stackTransportFor(ctx, transportOpts);
      const decision = decisionOf(ctx.input);

      // The proof gate comes FIRST, before the offer is even made: an
      // installation that has not proven itself is not offered a flip at all.
      const { proof, detail } = await provenProof(ctx, transport);
      if (proof === null) {
        return { ok: false, checks: [{ name: "proof", ok: false, detail }] };
      }

      if (decision === null) {
        return {
          ok: false,
          checks: [
            {
              name: "offer",
              ok: false,
              detail:
                `${goLiveExplanation(currentDryRun(ctx.adapters))}\n\n` +
                `You watched #${proof.pr} reviewed (round ${proof.round_no}, verdict ${proof.verdict}).\n` +
                `Ask them, then call this tool again: decision: "stay_dry_run", or decision: "go_live" with ` +
                `confirm: "${GO_LIVE_CONFIRMATION}".`,
            },
          ],
        };
      }

      if (decision === "stay_dry_run") {
        // A decline promises reviews land in files, so it is recorded only on
        // an installation that IS in dry-run. This step never writes the flag
        // back to true: a live installation stays live until its owner edits
        // that line, and the decline is refused rather than reported as true.
        const dryRunNow = currentDryRun(ctx.adapters);
        if (dryRunNow !== true) {
          return {
            ok: false,
            checks: [
              {
                name: "decision",
                ok: false,
                detail:
                  dryRunNow === false
                    ? `nothing was recorded and nothing was changed: ${configPath(ctx.adapters)} has dry_run = false, so this ` +
                      "installation is LIVE and reviews are posted to GitHub. This step only ever flips toward live; to go back " +
                      "to dry-run, set dry_run = true in config.toml yourself and restart the daemon, then run this step again."
                    : `nothing was recorded and nothing was changed: ${configPath(ctx.adapters)} could not be read, so whether ` +
                      "this installation is in dry-run is unknown. Fix the config, then run this step again.",
              },
            ],
          };
        }
        ctx.recordChoice(GO_LIVE_CHOICE_KEY, "dry_run");
        return {
          ok: true,
          checks: [
            {
              name: "decision",
              ok: true,
              detail:
                "staying in dry-run — recorded, and nothing was changed. This is a finished, fully working installation: " +
                "labelled PRs get reviewed, the reviewer learns, the TUI and the companion work, and every review is written " +
                "to state/dryrun/ instead of to GitHub. Flip whenever you want by running this step again with " +
                `decision: "go_live" and confirm: "${GO_LIVE_CONFIRMATION}", or by setting dry_run = false in config.toml ` +
                "yourself and restarting the daemon.",
            },
            { name: "next", ok: true, detail: SETUP_RECOMMENDATION },
          ],
          // The installation is in dry-run now, whatever an earlier flip
          // left owed: there is no flag on disk for a restart to deliver.
          data: { decision: "dry_run", [RESTART_OWED_KEY]: false },
        };
      }

      if (!isGoLiveConfirmation(ctx.input.confirm)) {
        return {
          ok: false,
          checks: [
            {
              name: "confirmation",
              ok: false,
              detail:
                `nothing was changed. Going live needs the operator's own explicit words: call this tool again with ` +
                `decision: "go_live" AND confirm: "${GO_LIVE_CONFIRMATION}". If they are unsure, "stay_dry_run" is a perfectly ` +
                "good answer and the flip stays available forever.",
            },
          ],
        };
      }

      const configText = readConfigText(ctx.adapters);
      if (configText === null) {
        return {
          ok: false,
          checks: [
            {
              name: "config",
              ok: false,
              detail: `${configPath(ctx.adapters)} is not readable — nothing was changed`,
            },
          ],
        };
      }
      let flipped: string;
      try {
        flipped = flipDryRunToFalse(configText, { confirmation: ctx.input.confirm, proof });
      } catch (err) {
        return {
          ok: false,
          checks: [
            {
              name: "flip",
              ok: false,
              detail: `${String((err as Error).message)} — nothing was changed`,
            },
          ],
        };
      }
      // The real loader decides, before anything reaches config.toml.
      const probe = join(ctx.adapters.paths.stateDir, "onboarding", "config.golive.toml");
      try {
        writeAtomic(probe, flipped);
        if (loadConfig(probe).dry_run !== false) {
          return {
            ok: false,
            checks: [
              {
                name: "flip",
                ok: false,
                detail:
                  "the edited config did not read back as dry_run = false — nothing was changed",
              },
            ],
          };
        }
      } catch (err) {
        return {
          ok: false,
          checks: [
            {
              name: "flip",
              ok: false,
              detail: `the edited config would not load (${String((err as Error).message)}) — nothing was changed`,
            },
          ],
        };
      } finally {
        rmSync(probe, { force: true });
      }
      writeAtomic(configPath(ctx.adapters), flipped);

      const checks: CheckResult[] = [
        {
          name: "flip",
          ok: true,
          detail:
            `dry_run = false in ${configPath(ctx.adapters)} — you ratified this, on the evidence of #${proof.pr} round ${proof.round_no}. ` +
            "From the daemon's next start, reviews are posted to GitHub for real. To go back, set it to true and restart.",
        },
      ];
      // A probe that could not ask the host is not a daemon that is down: the
      // restart stays owed rather than being discharged as "nothing to restart".
      const state = await transport.daemonState();
      const restarted: CheckResult =
        state.state === "unknown"
          ? {
              name: "daemon-restart",
              ok: false,
              detail:
                `could not tell whether the daemon is running ${transport.where} (${state.detail}), so it was not restarted ` +
                "onto dry_run = false — a running daemon is still in dry-run. Fix: make the host reachable, then run this " +
                `step again with decision: "go_live" and confirm: "${GO_LIVE_CONFIRMATION}"`,
            }
          : await transport.restart(
              (line) => ctx.adapters.log?.(`${GO_LIVE_STEP_ID}: ${line}`),
              state.state === "running",
            );
      checks.push(restarted);
      const now = currentDryRun(ctx.adapters);
      checks.push(
        now === false
          ? {
              name: "confirmed",
              ok: true,
              detail: "the config on disk reads back as dry_run = false",
            }
          : {
              name: "confirmed",
              ok: false,
              detail: `the config on disk reads back as dry_run = ${String(now)} — check ${configPath(ctx.adapters)} by hand`,
            },
      );
      if (checks.every((c) => c.ok)) {
        ctx.recordChoice(GO_LIVE_CHOICE_KEY, "live");
        checks.push({ name: "next", ok: true, detail: SETUP_RECOMMENDATION });
      }
      return {
        ok: checks.every((c) => c.ok),
        checks,
        data: {
          decision: "live",
          flipped_at: ctx.adapters.clock().toISOString(),
          [RESTART_OWED_KEY]: !restarted.ok,
        },
      };
    },

    async verify(ctx): Promise<StepReport> {
      const recorded = ctx.choices[GO_LIVE_CHOICE_KEY];
      const dryRun = currentDryRun(ctx.adapters);
      // The wizard's own flip whose restart failed: the file says live, the
      // daemon was never made to read it. Owed until a run restarts it.
      if (ctx.data[RESTART_OWED_KEY] === true && dryRun === false) {
        return {
          ok: false,
          checks: [
            {
              name: "daemon-restart",
              ok: false,
              detail:
                "dry_run = false is on disk, but the restart that makes the daemon read it did not complete, so a running " +
                `daemon may still be in dry-run. Fix: run this step again with decision: "go_live" and confirm: ` +
                `"${GO_LIVE_CONFIRMATION}" — it restarts the daemon`,
            },
          ],
        };
      }
      if (recorded !== "live" && recorded !== "dry_run") {
        return {
          ok: false,
          checks: [
            {
              name: "decision",
              ok: false,
              detail:
                `no answer recorded yet (config.toml currently has dry_run = ${String(dryRun)}). Run this step: it explains the ` +
                "choice and takes either answer — staying in dry-run is a complete, finished installation.",
            },
          ],
        };
      }
      if (recorded === "dry_run") {
        if (dryRun === false) {
          return {
            ok: true,
            checks: [
              {
                name: "decision",
                ok: true,
                detail:
                  "LIVE — dry-run was chosen here once, but config.toml now has dry_run = false, so reviews are posted " +
                  "to GitHub. A finished installation.",
              },
            ],
          };
        }
        if (dryRun === null) {
          return {
            ok: false,
            checks: [
              {
                name: "decision",
                ok: false,
                detail:
                  `dry-run was chosen here once, but ${configPath(ctx.adapters)} could not be read, so whether this ` +
                  "installation is in dry-run is unknown. Fix the config, then verify again.",
              },
            ],
          };
        }
        return {
          ok: true,
          checks: [
            {
              name: "decision",
              ok: true,
              detail: "dry-run, by the operator's own decision (config.toml has dry_run = true). A finished installation.",
            },
          ],
        };
      }
      return dryRun === false
        ? {
            ok: true,
            checks: [
              {
                name: "decision",
                ok: true,
                detail: "live, by the operator's own ratified flip — dry_run = false on disk",
              },
            ],
          }
        : {
            ok: false,
            checks: [
              {
                name: "decision",
                ok: false,
                detail:
                  `the operator ratified going live, but config.toml reads dry_run = ${String(dryRun)} — the flip did not stick. ` +
                  "Fix: run this step again, or set dry_run = false by hand and restart the daemon",
              },
            ],
          };
    },
  };
}
