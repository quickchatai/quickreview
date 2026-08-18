// Prompt template rendering: the round prompts injected into a PR session and
// the system prompts handed to pi at session birth (spec §4, brief B3 step 5).
// Contract: a {{placeholder}} in the text with no supplied value is a bug and
// throws; a supplied value the template does not use is fine (templates are
// edited independently of this renderer).
import type { MigrationCollision } from "./migrations.js";
import type { FileClass, RecheckOrder } from "./recheck.js";
import type { PassPlanEntry, RoundOrder, RoundType } from "./types.js";

const PLACEHOLDER = /\{\{\s*([A-Za-z0-9_]+)\s*\}\}/g;

export type TemplateVars = Record<string, string>;

export class UnknownPlaceholderError extends Error {
  constructor(readonly names: string[]) {
    super(`template uses unknown placeholder(s): ${names.map((n) => `{{${n}}}`).join(", ")}`);
    this.name = "UnknownPlaceholderError";
  }
}

/** Substitute {{name}} occurrences; unknown placeholder => throw. */
export function render(templateText: string, vars: TemplateVars): string {
  const unknown = new Set<string>();
  const out = templateText.replace(PLACEHOLDER, (match, name: string) => {
    const v = vars[name];
    if (v === undefined) {
      unknown.add(name);
      return match;
    }
    return v;
  });
  if (unknown.size > 0) throw new UnknownPlaceholderError([...unknown]);
  return out;
}

/** Placeholder names a template text uses (diagnostics / tests). */
export function placeholdersIn(templateText: string): string[] {
  return [...new Set([...templateText.matchAll(PLACEHOLDER)].map((m) => m[1] as string))];
}

export const ROUND_TEMPLATE_FILES: Record<RoundType, string> = {
  first: "round-first.md",
  "re-review": "round-re-review.md",
  staleness: "round-staleness.md",
};

export function roundTemplateFile(roundType: RoundType): string {
  return ROUND_TEMPLATE_FILES[roundType];
}

/** The fourth template. Not a RoundType: a recheck starts no round,
 * plans no passes and asks one question. */
export const RECHECK_TEMPLATE_FILE = "round-recheck.md";

/** Markdown list of the delta, trivial classifications included so the session
 * can see what the daemon already ruled out and why. */
export function renderDeltaFiles(files: readonly FileClass[]): string {
  if (files.length === 0) return "(no files changed)";
  return files
    .map((f) => (f.class === "significant" ? `- \`${f.filename}\` — **review this**` : `- \`${f.filename}\` — trivial (${f.reason}), already ruled out`))
    .join("\n");
}

/** The full variable set the recheck template may reference. */
export function recheckVars(order: RecheckOrder): TemplateVars {
  return {
    n: String(order.pr),
    title: order.title,
    worktree: order.worktree,
    trigger: order.trigger,
    standing_verdict: order.standing_verdict,
    last_reviewed_sha: order.last_reviewed_sha,
    head_sha: order.head_sha,
    evidence: order.evidence,
    delta_files: renderDeltaFiles(order.files),
    decision_file: order.decision_file,
  };
}

/** Render prompts/round-recheck.md against a RecheckOrder. */
export function renderRecheckPrompt(templateText: string, order: RecheckOrder): string {
  return render(templateText, recheckVars(order));
}

// The migration gate survived the escalation scrap (the owner, 2026-08-18) as a
// data-safety signal: it still forces the sol-med tier and still tells the
// session the DDL must be judged. Only the "escalate unless…" framing is gone.
const GATE_ON =
  "MIGRATION GATE: this PR touches migrations — pass-data-safety must judge the real DDL (ALGORITHM, ordering against the base branch, backfill safety, rolling-deploy ordering). A migration you cannot prove safe is a blocker or a NEEDS_HUMAN, never an approve.";
const GATE_OFF = "no migration gate on this round";

/**
 * The GATE NOTES paragraph that carries's pre-check result to the
 * session (rendered inside `migration_gate_note`, which all three round
 * templates already print — no seed and no template edit needed).
 *
 * The daemon detected these collisions itself, before this round was ordered,
 * and already posted the remedy as a COMMENT. Without this paragraph the
 * session would re-derive the same fact from the diff and raise it as a
 * blocker, which is exactly what the ticket exists to stop: the finding is
 * correct, the verdict was wrong. So the note is imperative — the collision is
 * settled mechanics, it is not a finding, and it never moves the verdict.
 */
export function renderMigrationCollisionsNote(collisions: readonly MigrationCollision[]): string {
  if (collisions.length === 0) return "";
  const lines = [
    "",
    "",
    "MIGRATION NUMBERING — ALREADY HANDLED, DO NOT RAISE IT. The daemon checked",
    "this PR's migration numbers against the base branch at the pinned base sha",
    "before this round was ordered, found the collision(s) below, and has already",
    "posted the exact remedy to the PR as a COMMENT:",
    "",
  ];
  for (const c of collisions) {
    lines.push(
      `- \`${c.pr_path}\` collides with \`${c.base_path}\` → rename to \`${c.target_path}\`, dependencies \`[${c.dependency}]\``,
    );
  }
  lines.push(
    "",
    "This is mechanics, not review content: it is deterministic, it has exactly",
    "one remedy and it carries no design decision. It is **not a finding** — do",
    "not report it, do not post it inline or in the body, do not let any pass",
    "raise it, and above all do not let it become a `[blocker]` or move the",
    "verdict. A PR whose only migration problem is this numbering collision is",
    "still APPROVE-able on its merits. Everything else about these migrations —",
    "the DDL itself, ALGORITHM, backfill safety, rolling-deploy ordering — is",
    "judged exactly as it always was.",
  );
  return lines.join("\n");
}
const NO_BASE = "(unknown — the daemon could not resolve the base branch this round)";

/** Markdown table of the round's pass plan — one row per subagent launch. */
export function renderPassPlan(plan: PassPlanEntry[]): string {
  const rows = plan.map(
    (p) =>
      `| ${p.lens} | \`${p.agent}\` | ${p.tier} | ${
        p.raisable_to.length > 0 ? p.raisable_to.map((a) => `\`${a}\``).join(", ") : "— (pinned)"
      } |`,
  );
  return ["| lens | subagent to call | tier | may raise to |", "| --- | --- | --- | --- |", ...rows].join("\n");
}

/** Comma list of lenses the session may additionally run this round. */
export function renderAddableLenses(addable: string[]): string {
  return addable.length > 0 ? addable.join(", ") : "(none — every known lens is already planned)";
}

/** The full variable set every round template may reference. */
export function roundVars(order: RoundOrder): TemplateVars {
  return {
    n: String(order.pr),
    title: order.title,
    worktree: order.worktree,
    head_sha: order.head_sha,
    round_type: order.round_type,
    round_no: String(order.round_no),
    lenses: order.lenses.join(", "),
    pass_plan: renderPassPlan(order.pass_plan),
    addable_lenses: renderAddableLenses(order.addable_lenses),
    base_ref: order.base_ref || NO_BASE,
    base_sha: order.base_sha || NO_BASE,
    merge_base: order.merge_base || NO_BASE,
    migration_gate_note:
      (order.migration_gate ? GATE_ON : GATE_OFF) + renderMigrationCollisionsNote(order.migration_collisions ?? []),
    settled_digest: order.settled_digest.trim() || "(nothing settled yet)",
  };
}

/** Render a round-*.md template against a dispatched RoundOrder. */
export function renderRoundPrompt(templateText: string, order: RoundOrder): string {
  return render(templateText, roundVars(order));
}

export interface ConversationPromptVars {
  pr: number;
  title: string;
  worktree: string;
}

/** prompts/conversation-system.md — substituted at PR-session birth. */
export function renderConversationSystemPrompt(
  templateText: string,
  vars: ConversationPromptVars,
): string {
  return render(templateText, {
    n: String(vars.pr),
    title: vars.title,
    worktree: vars.worktree,
  });
}

/** prompts/overseer-system.md — no per-session substitution today; rendered
 * through the same path so a future placeholder fails loudly rather than
 * silently shipping "{{...}}" to the model. */
export function renderOverseerSystemPrompt(templateText: string, vars: TemplateVars = {}): string {
  return render(templateText, vars);
}
