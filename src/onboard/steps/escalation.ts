// The escalation interview — the step that turns the optional,
// off-by-default escalation feature on, and the only place a new operator is
// asked about it.
//
// Why it is a step and not a config comment: the feature needs two answers the
// system must never guess: WHAT warrants a person's attention, and WHOM. A
// half-answer is worse than no answer — escalation switched on with nobody to
// escalate to is a feature that silently does nothing — so this step cannot
// finish in that state and neither can a hand-edited config: `parseEscalation`
// in src/config.ts refuses to load one. Two doors, one lock.
//
// What it teaches, because the wording is the feature: escalation here is not
// "ask someone to review this". The reviewer still decides, always, on the
// merits — the escalation is a note that goes out beside the verdict pointing
// one named person at one named thing. The step says that in the operator's
// language before it asks anything, because an operator who thinks they are
// configuring "send hard PRs to a human" has configured the wrong feature.
//
// Scope of the interview: it captures one set of triggers — the common case,
// and the one worth an interview — written as one rule PER TARGET, because
// `EscalationRule.to` names a single person by design. Teams that want
// different triggers for different people write more `[[escalation.rules]]`
// blocks by hand; the section this step writes documents that in place, and
// re-running the step never destroys rules it did not author (it rewrites only
// the `onboarding:<login>` family).
import { readFileSync } from "node:fs";
import { parse as parseToml } from "smol-toml";
import type { CheckResult, OnboardingStep, StepContext, StepReport } from "../engine.js";
import {
  ESCALATION_DEFAULTS,
  ESCALATION_LOGIN_RE as LOGIN_RE,
  ESCALATION_SEVERITY_FLOORS as SEVERITIES,
  parseConfig,
} from "../../config.js";
import { interviewConfigPath, writeAtomic } from "./compose.js";

export const ESCALATION_STEP_ID = "escalation";

/**
 * The name PREFIX of the rules this step owns: one rule per target, named
 * `onboarding:<login>`. A re-run rewrites every rule whose name starts with
 * this prefix and leaves hand-written siblings completely alone.
 *
 * One rule per target, never one rule pointing at the first login:
 * `EscalationRule.to` is a single person by design — an escalation names one
 * person to ask — so an operator answering `targets: "alice, bob"` gets two
 * rules, and the confirmation says so.
 */
export const INTERVIEW_RULE_PREFIX = "onboarding";

/** The rule name this step writes for one target. */
export function interviewRuleName(login: string): string {
  return `${INTERVIEW_RULE_PREFIX}:${login}`;
}

/** Is this a rule THIS STEP owns (and may therefore rewrite)? */
export function isInterviewRule(name: string): boolean {
  return name === INTERVIEW_RULE_PREFIX || name.startsWith(`${INTERVIEW_RULE_PREFIX}:`);
}

/** Split a comma/whitespace-separated answer into trimmed, non-empty items. */
export function splitList(raw: unknown): string[] {
  if (Array.isArray(raw)) return raw.map((v) => String(v).trim()).filter(Boolean);
  return String(raw ?? "")
    .split(/[,\s]+/)
    .map((s) => s.trim().replace(/^@/, ""))
    .filter(Boolean);
}

/** Split a comma-separated answer of NAMES (PR labels, check names) into
 * trimmed, non-empty items. Commas and line breaks separate; a space is part
 * of the name — `AI review requested` is one label, `CI / test` one check. */
export function splitNames(raw: unknown): string[] {
  if (Array.isArray(raw)) return raw.map((v) => String(v).trim()).filter(Boolean);
  return String(raw ?? "")
    .split(/[,\r\n]+/)
    .map((s) => s.trim())
    .filter(Boolean);
}

function yesNo(raw: unknown): boolean | null {
  const v = String(raw ?? "")
    .trim()
    .toLowerCase();
  if (["yes", "y", "true", "on", "enable", "enabled"].includes(v)) return true;
  if (["no", "n", "false", "off", "disable", "disabled", "skip"].includes(v)) return false;
  return null;
}

/** The teach-and-offer refusal: the step's question, as a red check. */
export function offerCheck(): CheckResult {
  return {
    name: "escalation",
    ok: false,
    detail: [
      "Escalation is OPTIONAL and ships OFF. Decide with the operator, then call this step again with `enable`.",
      "",
      "What it is: the reviewer ALWAYS decides the PR itself, on the merits, and posts the verdict.",
      "An escalation is a note that goes out BESIDE that verdict, @-mentioning one named person and",
      "pointing them at ONE thing — a file and line range, a migration, a named decision — with the",
      "question spelled out. It is a `[check this]` item with a name on it.",
      "",
      "What it is NOT: it never asks anyone to review the pull request, never holds the review open,",
      "and never makes the PR wait for a person. There is no way to configure it to do those.",
      "",
      'enable = "no"  → nothing changes; the system behaves exactly as it does today. This is the',
      "                 right answer unless the team already knows a class of change one specific",
      "                 person always wants to see.",
      'enable = "yes" → then you must also give `targets` (the logins escalation may reach — one rule is',
      "                 written per login, so naming two people means BOTH are told), `why`",
      "                 (why that person, in your words) and at least one trigger: `paths`, `labels`,",
      "                 `min_severity` or `failing_checks`. All of them together is fine; none of",
      "                 them is refused, because a rule with no trigger can never fire.",
      "",
      'Optional: `shape` — "comment" (default) posts the note; "review_request" ALSO puts the PR in',
      'that person\'s review-requested queue. GitHub words that queue entry "review this pull request",',
      "which is exactly what is NOT being asked, so the note is still posted alongside it and still",
      'carries the real ask. "comment" is the shape that matches the intent.',
      "Optional: `session_judgement` — may the reviewer ALSO escalate on its own judgement, bounded",
      "to the same targets? Default no; the rules above are the half with no model in the loop.",
    ].join("\n"),
  };
}

// ---- config surgery -------------------------------------------------------

/** A `[[escalation.rules]]` header line, in any valid TOML spelling (leading
 * whitespace, whitespace inside the brackets, a trailing comment). */
const RULE_HEADER_RE = /^[ \t]*\[\[[ \t]*escalation[ \t]*\.[ \t]*rules[ \t]*\]\][^\n]*$/;

/** `toml` with every `[[escalation.rules]]` block removed — wherever it sits,
 * not only right after `[escalation]`. A block runs from its header to the next
 * line that opens a table, the same extent `foreignRuleBlocks` reads. */
function withoutRuleBlocks(toml: string): string {
  const out: string[] = [];
  let inRule = false;
  for (const line of toml.split("\n")) {
    if (RULE_HEADER_RE.test(line)) {
      inRule = true;
      continue;
    }
    if (inRule && /^[ \t]*\[/.test(line)) inRule = false;
    if (!inRule) out.push(line);
  }
  return out.join("\n");
}

/**
 * Replace the `[escalation]` table AND every `[[escalation.rules]]` block in
 * the document with `body`. Every rule block is removed wherever it sits —
 * `body` carries the foreign ones back (`foreignRuleBlocks` collects them from
 * the whole document), so each survives exactly once.
 *
 * The generic `patchTomlSection` cannot do this: it stops at the next `[`, and
 * `[[escalation.rules]]` starts with `[` — so it would leave orphaned rules
 * behind a rewritten header, which is precisely the half-configured state this
 * step exists to make impossible.
 */
export function patchEscalationSection(original: string, body: string): string {
  const toml = withoutRuleBlocks(original);
  const header = /^[ \t]*\[[ \t]*escalation[ \t]*\][^\n]*\n/m.exec(toml);
  // TOML allows whitespace before a header, inside its brackets and a comment
  // after it — every spelling of the next table ends the section, or the
  // rewrite would swallow it.
  const tableRe = /^[ \t]*\[\[?[^\n\]]+\]\]?[^\n]*$/gm;
  if (header?.index === undefined) {
    // No table yet: put it before [slack] if that exists, else at the end.
    const slack = /^\[slack\]/m.exec(toml);
    if (slack?.index !== undefined)
      return `${toml.slice(0, slack.index)}${body}\n${toml.slice(slack.index)}`;
    return `${toml.replace(/\n*$/, "\n")}\n${body}`;
  }
  tableRe.lastIndex = header.index + header[0].length;
  const next = tableRe.exec(toml);
  const end = next ? next.index : toml.length;
  return `${toml.slice(0, header.index)}${body}${toml.slice(end)}`;
}

/** One field of a single rule block, PARSED rather than pattern-matched — a
 * literal string (`name = 'x'`) is as valid a spelling as `name = "x"`.
 * undefined when the block does not parse (`parseConfig` refuses it loudly
 * later) or does not carry the field. */
function ruleField(block: string, field: "name" | "to"): unknown {
  try {
    const doc = parseToml(block) as {
      escalation?: { rules?: Array<Record<string, unknown>> };
    };
    return doc.escalation?.rules?.[0]?.[field];
  } catch {
    return undefined;
  }
}

/** Every `[[escalation.rules]]` block in `toml` that this step does NOT own,
 * rendered back verbatim (its header line included, comment and all) — so a
 * re-run never eats a hand-written rule. */
export function foreignRuleBlocks(toml: string): string[] {
  const out: string[] = [];
  const re =
    /^([ \t]*\[\[[ \t]*escalation[ \t]*\.[ \t]*rules[ \t]*\]\][^\n]*)\n?((?:(?![ \t]*\[)[^\n]*\n?)*)/gm;
  for (let m = re.exec(toml); m; m = re.exec(toml)) {
    const block = `${m[1]!.trim()}\n${(m[2] ?? "").replace(/\n*$/, "\n")}`;
    const name = ruleField(block, "name");
    if (typeof name === "string" && isInterviewRule(name)) continue;
    out.push(block);
  }
  return out;
}

/** The `to` login of each hand-written rule block, in order, deduplicated.
 * They join the `targets` this step writes: `parseEscalation` refuses a rule
 * pointing outside `targets`, so a re-run that regenerated `targets` from the
 * interview alone would make a kept hand rule unloadable. */
export function foreignRuleTargets(foreign: readonly string[]): string[] {
  const out: string[] = [];
  for (const block of foreign) {
    // Parsed, not pattern-matched: a literal string (`to = 'bob'`) or an
    // `@bob` is as valid a spelling as `to = "bob"`, and normalised the way
    // `parseConfig` normalises it, so the two never disagree on the login.
    const raw = ruleField(block, "to");
    const to = typeof raw === "string" ? raw.trim().replace(/^@/, "") : "";
    if (to && !out.includes(to)) out.push(to);
  }
  return out;
}

/** The per-PR delivery cap this step writes: one delivery for every rule that
 * can fire on the same PR (each interview rule, each hand rule) plus one spare
 * for a session escalation — never below the shipped default of 2, so no
 * interview target is ever refused as capped. */
export function interviewMaxPerPr(a: EscalationAnswers, foreign: readonly string[]): number {
  const rules = (a.enabled ? a.targets.length : 0) + foreign.length;
  return Math.max(ESCALATION_DEFAULTS.max_per_pr, rules + 1);
}

function tomlList(values: readonly string[]): string {
  return `[${values.map((v) => JSON.stringify(v)).join(", ")}]`;
}

export interface EscalationAnswers {
  enabled: boolean;
  shape: "comment" | "review_request";
  targets: string[];
  session_judgement: boolean;
  paths: string[];
  labels: string[];
  failing_checks: string[];
  min_severity: string;
  why: string;
}

/** The `targets` the section carries: the interview's, then every hand rule's
 * recipient it does not already name (`parseEscalation` refuses a rule
 * pointing outside `targets`). */
export function effectiveTargets(a: EscalationAnswers, foreign: readonly string[]): string[] {
  const targets = [...a.targets];
  for (const t of foreignRuleTargets(foreign)) if (!targets.includes(t)) targets.push(t);
  return targets;
}

/** Render the whole `[escalation]` section — the switched-off form when the
 * operator declined, the full form otherwise. */
export function renderEscalationSection(
  a: EscalationAnswers,
  foreign: readonly string[] = [],
): string {
  const targets = effectiveTargets(a, foreign);
  const head = [
    "[escalation]",
    "# Optional escalation. The reviewer ALWAYS decides on the merits and",
    "# posts its verdict; an escalation is a note beside that verdict pointing ONE",
    "# named person at ONE thing. It never asks anyone to review the pull request,",
    "# and it never holds a review open. Written by `qcr onboard`'s escalation step.",
    `enabled = ${a.enabled}`,
    `shape = ${JSON.stringify(a.shape)}`,
    "# The closed set of logins any escalation may reach. A reviewer session that",
    "# names anyone else is dropped by the daemon.",
    "# (Includes the recipient of every hand-written rule below.)",
    `targets = ${tomlList(targets)}`,
    `session_judgement = ${a.session_judgement}`,
    "# One delivery per rule that can fire on a PR, plus one spare.",
    `max_per_pr = ${interviewMaxPerPr(a, foreign)}`,
    "",
  ];
  if (a.enabled) {
    head.push(
      "# The rules this interview captured — ONE PER TARGET, because an escalation",
      "# names one person to ask. Add more [[escalation.rules]] blocks by hand for",
      "# other classes of change: re-running the onboarding step rewrites only the",
      `# rules named ${INTERVIEW_RULE_PREFIX}:<login> and leaves yours alone.`,
    );
    for (const target of a.targets) {
      head.push(
        "[[escalation.rules]]",
        `name = ${JSON.stringify(interviewRuleName(target))}`,
        `to = ${JSON.stringify(target)}`,
        `why = ${JSON.stringify(a.why)}`,
        `paths = ${tomlList(a.paths)}`,
        `labels = ${tomlList(a.labels)}`,
        `failing_checks = ${tomlList(a.failing_checks)}`,
        `min_severity = ${JSON.stringify(a.min_severity)}`,
        "",
      );
    }
  }
  for (const block of foreign) head.push(block, "");
  return head.join("\n");
}

/**
 * Everything the answers must satisfy before this step may go green.
 *
 * This is the half-configured guard, and it is deliberately the SAME set of
 * conditions `parseEscalation` enforces at load: the wizard refuses to write
 * a config the loader would refuse to read, so the two can never disagree
 * about what "configured" means.
 */
export function answerProblems(a: EscalationAnswers): string[] {
  if (!a.enabled) return [];
  const bad: string[] = [];
  if (a.targets.length === 0)
    bad.push(
      "`targets` is empty — escalation on with nobody to escalate to is not a configuration",
    );
  for (const t of a.targets)
    if (!LOGIN_RE.test(t))
      bad.push(`"${t}" is not a GitHub login (letters, digits, single dashes; no @, no URL)`);
  if (!a.why) bad.push("`why` is empty — every escalation says why THIS person, in your words");
  if (a.paths.length + a.labels.length + a.failing_checks.length === 0 && !a.min_severity) {
    bad.push(
      "no trigger given — set at least one of `paths`, `labels`, `min_severity`, `failing_checks`, or a rule that can never fire is all this writes",
    );
  }
  if (a.min_severity && !SEVERITIES.includes(a.min_severity)) {
    bad.push(`\`min_severity\` must be one of ${SEVERITIES.join(", ")} (got "${a.min_severity}")`);
  }
  return bad;
}

function answersFrom(ctx: StepContext, enabled: boolean): EscalationAnswers {
  const shapeRaw = String(ctx.input.shape ?? "comment")
    .trim()
    .toLowerCase();
  const targets = splitList(ctx.input.targets);
  return {
    enabled,
    shape: shapeRaw === "review_request" ? "review_request" : "comment",
    targets,
    session_judgement: yesNo(ctx.input.session_judgement) === true,
    // A glob may contain a space (`docs/API changes/**`): commas separate.
    paths: splitNames(ctx.input.paths),
    labels: splitNames(ctx.input.labels),
    failing_checks: splitNames(ctx.input.failing_checks),
    min_severity: String(ctx.input.min_severity ?? "")
      .trim()
      .toUpperCase(),
    why: String(ctx.input.why ?? "").trim(),
  };
}

export function escalationStep(): OnboardingStep {
  return {
    id: ESCALATION_STEP_ID,
    title: "Escalation: optional, off by default",
    explain:
      'One question, and "no" is a perfectly good answer. The reviewer always decides every PR itself and posts a verdict — ' +
      "that never changes. Escalation, if you turn it on, adds a note beside the verdict that @-mentions one named person and " +
      "points them at ONE thing: this file and these lines, this migration, this decision. It is never a request to review the " +
      "pull request, and it never makes a review wait for anyone. Call the tool with no arguments first to read the trade-offs " +
      "out to the operator, then again with their answer.",
    order: 36,
    parameters: {
      type: "object",
      properties: {
        enable: {
          type: "string",
          enum: ["yes", "no"],
          description: "Turn escalation on? Omit to have the step explain it first.",
        },
        targets: {
          type: "string",
          description:
            "Comma-separated GitHub logins escalation may reach. Required when enable=yes.",
        },
        why: {
          type: "string",
          description:
            "Why this person, in the operator's own words — rendered verbatim in the note. Required when enable=yes.",
        },
        paths: {
          type: "string",
          description:
            "Comma-separated path globs that warrant a look (* within a segment, ** across).",
        },
        labels: { type: "string", description: "Comma-separated PR labels that warrant a look." },
        min_severity: {
          type: "string",
          enum: ["", ...SEVERITIES],
          description: "Escalate when the round posted a finding at or above this severity.",
        },
        failing_checks: {
          type: "string",
          description: "Comma-separated check names whose failure warrants a look.",
        },
        shape: {
          type: "string",
          enum: ["comment", "review_request"],
          description: 'Delivery shape; "comment" (default) is the one that matches the intent.',
        },
        session_judgement: {
          type: "string",
          enum: ["yes", "no"],
          description:
            "May the reviewer also escalate on its own judgement, bounded to `targets`? Default no.",
        },
      },
    },

    async run(ctx): Promise<StepReport> {
      const enable = yesNo(ctx.input.enable);
      if (enable === null) return { ok: false, checks: [offerCheck()] };

      const answers = answersFrom(ctx, enable);
      const problems = answerProblems(answers);
      if (problems.length > 0) {
        // The half-configured state, refused BEFORE anything is written: the
        // config on disk is never left describing a feature that is on and
        // cannot work.
        return {
          ok: false,
          checks: [
            { name: "escalation answers", ok: false, detail: problems.join("; ") },
            {
              name: "config",
              ok: true,
              detail: "nothing was written — fix the answers above and call this step again",
            },
          ],
        };
      }

      const path = interviewConfigPath(ctx);
      let toml: string;
      try {
        toml = readFileSync(path, "utf8");
      } catch (err) {
        return {
          ok: false,
          checks: [
            {
              name: "config.toml",
              ok: false,
              detail: `cannot read ${path}: ${String(err)} — run the interview step first`,
            },
          ],
        };
      }
      const foreign = foreignRuleBlocks(toml);
      const allTargets = effectiveTargets(answers, foreign);
      const handTargets = allTargets.slice(answers.targets.length);
      const maxPerPr = interviewMaxPerPr(answers, foreign);
      const patched = patchEscalationSection(toml, renderEscalationSection(answers, foreign));
      // Parse BEFORE writing: `parseEscalation` is the same lock the loader
      // uses, so a config this step writes can always be booted.
      try {
        parseConfig(patched);
      } catch (err) {
        return {
          ok: false,
          checks: [
            {
              name: "config validation",
              ok: false,
              detail: `the section this step would write does not load: ${String(err)} — nothing was written`,
            },
          ],
        };
      }
      writeAtomic(path, patched);

      const checks: CheckResult[] = [
        {
          name: "escalation",
          ok: true,
          detail: enable
            ? `on, shape "${answers.shape}" — ${answers.targets.length} rule(s), one per target: ` +
              answers.targets.map((t) => `@${t} (rule ${interviewRuleName(t)})`).join(", ") +
              ". Each of them is told about the same triggers below; escalation names one person per note, so" +
              " listing more than one login means more than one person is told." +
              ` At most ${maxPerPr} escalations are delivered per PR (max_per_pr) — one per rule plus one spare.` +
              (handTargets.length
                ? ` ${handTargets.map((t) => `@${t}`).join(", ")} stay${handTargets.length === 1 ? "s" : ""} in targets for your hand-written rule(s), which were kept as they are.`
                : "")
            : "off — the reviewer decides every PR and posts its verdict, and nobody is @-mentioned. You can turn this on later by re-running this step.",
        },
        { name: "config.toml", ok: true, detail: `[escalation] written to ${path} and it parses` },
      ];
      if (enable) {
        const trig = [
          answers.paths.length ? `paths ${answers.paths.join(", ")}` : "",
          answers.labels.length ? `labels ${answers.labels.join(", ")}` : "",
          answers.min_severity ? `findings at or above ${answers.min_severity}` : "",
          answers.failing_checks.length
            ? `failing checks ${answers.failing_checks.join(", ")}`
            : "",
        ].filter(Boolean);
        checks.push({ name: "triggers", ok: true, detail: trig.join("; ") });
        checks.push({
          name: "still a verdict",
          ok: true,
          detail:
            "reminder, and it is structural: escalation never withholds, defers or replaces a verdict. Every PR still gets " +
            "APPROVE or REQUEST_CHANGES on the merits, and the note rides beside it.",
        });
        if (answers.session_judgement) {
          checks.push({
            name: "session judgement",
            ok: true,
            detail: `the reviewer may also escalate on its own judgement, and ONLY to ${allTargets.map((t) => `@${t}`).join(", ")} — anything else is dropped by the daemon`,
          });
        }
      }
      return {
        ok: true,
        checks,
        data: {
          enabled: enable,
          shape: answers.shape,
          targets: allTargets,
          config_path: path,
        },
      };
    },

    async verify(ctx): Promise<StepReport> {
      const path = interviewConfigPath(ctx);
      let cfg;
      try {
        cfg = parseConfig(readFileSync(path, "utf8"));
      } catch (err) {
        return {
          ok: false,
          checks: [
            { name: "config.toml", ok: false, detail: `${path} does not load: ${String(err)}` },
          ],
        };
      }
      const esc = cfg.escalation;
      if (!esc.enabled) {
        return {
          ok: true,
          checks: [
            {
              name: "escalation",
              ok: true,
              detail:
                "off — nothing is evaluated, nobody is @-mentioned, no review request is ever made",
            },
          ],
        };
      }
      // On, so re-prove the two things that make it configured rather than
      // half-configured. `parseConfig` already refuses both, which is why this
      // is a re-assertion and not the only check.
      const checks: CheckResult[] = [
        {
          name: "targets",
          ok: esc.targets.length > 0,
          detail:
            esc.targets.length > 0
              ? `escalates only to ${esc.targets.map((t) => `@${t}`).join(", ")}`
              : "on with no targets",
        },
        {
          name: "triggers",
          ok: esc.rules.length > 0 || esc.session_judgement,
          detail:
            esc.rules.length > 0
              ? `${esc.rules.length} rule(s): ${esc.rules.map((r) => r.name).join(", ")}`
              : esc.session_judgement
                ? "session judgement only"
                : "nothing can fire",
        },
        {
          name: "shape",
          ok: true,
          detail:
            esc.shape === "comment"
              ? "a comment beside the verdict"
              : "a comment beside the verdict, plus a GitHub review request",
        },
      ];
      return { ok: checks.every((c) => c.ok), checks };
    },
  };
}
