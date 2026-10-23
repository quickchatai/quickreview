// The prompt-side half of escalation (src/escalation.ts holds the rest and
// says what it is for): the targets a round order carries, and the block the
// round prompt renders for them. The review core's half, so the planner and
// the renderer never reach the daemon's delivery.
import type { EscalationConfig } from "./reviewconfig.js";

/**
 * The targets a round order carries, or none.
 *
 * A round order gets this list ONLY when the feature is enabled AND the
 * operator turned session judgement on — so with escalation off (the default)
 * the field is absent, the note below renders `""`, and the round prompt is
 * identical in behaviour to a build without the feature (whitespace aside —
 * see the pin in tests/escalation.test.ts).
 */
export function promptTargetsFor(cfg: EscalationConfig): string[] | undefined {
  if (!cfg.enabled || !cfg.session_judgement || cfg.targets.length === 0) return undefined;
  return [...cfg.targets];
}

/**
 * The round-prompt block, rendered into `{{escalation_note}}` by
 * `packages/pi-plugin/src/templates.ts`.
 *
 * The deterministic rules need no prompt at all: the daemon evaluates and
 * delivers them itself. This block exists only so a session that MAY escalate
 * on its own judgement knows the shape, the bound and — above all — that
 * escalating never changes its job.
 */
export function renderEscalationPromptNote(targets: readonly string[] | undefined): string {
  if (!targets || targets.length === 0) return "";
  return [
    "ESCALATION (optional, and it never changes your job).",
    "",
    "You always decide this PR on the merits and post the review — escalation is a note that goes",
    "out BESIDE your verdict, never instead of it, and never a reason to withhold or defer one.",
    "",
    "If one specific thing in this change genuinely needs a named person's eyes, add an",
    "`escalations` array to your verdict file. Each entry:",
    "",
    "```json",
    '{ "target": "<one of the logins below>",',
    '  "scope": { "kind": "code", "path": "<repo-relative file>", "start_line": 12, "end_line": 30 },',
    '  "question": "<one or two sentences about THAT code>",',
    '  "why": "<why this person>" }',
    "```",
    "",
    `Targets you may name (any other login is dropped by the daemon): ${targets.map((t) => `@${t}`).join(", ")}`,
    "",
    "`scope.kind` is `code` (path plus line range), `migration` (path, optionally the migration",
    'id) or `decision` (a named decision). There is no way to escalate "the PR" and you must not',
    "try: an entry with no concrete scope, or a question that asks someone to review the change,",
    "is dropped. Think of it exactly as a `[check this]` item with a name on it — the smallest",
    "thing that actually needs a person, phrased so they can answer it in minutes.",
    "",
    "Escalating is rare. Omitting the array entirely is the normal outcome.",
  ].join("\n");
}
