// Prompt template rendering: the round prompts injected into a PR session and
// the system prompts handed to pi at session birth (spec §4, brief B3 step 5).
// Contract: a {{placeholder}} in the text with no supplied value is a bug and
// throws; a supplied value the template does not use is fine (templates are
// edited independently of this renderer).
import type { RoundOrder, RoundType } from "./types.js";

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

const NO_ESCALATION = "none flagged — apply your own escalation judgment";
const GATE_ON =
  "MIGRATION GATE: this PR touches migrations — escalate unless the migration is provably INSTANT-safe, in sequence with master, backfill-free and ordering-safe.";
const GATE_OFF = "no migration gate on this round";

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
    escalation_criteria: order.escalation_worthy
      ? order.escalation_reasons.join("; ") || "flagged escalation-worthy (no reason recorded)"
      : order.escalation_reasons.join("; ") || NO_ESCALATION,
    migration_gate_note: order.migration_gate ? GATE_ON : GATE_OFF,
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
