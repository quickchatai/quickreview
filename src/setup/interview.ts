// The setup interview's deterministic half (setup & scan spec
// "Interview mapping"). The companion runs the interview — adaptive, driven by
// the repo portrait — and this file is what its answers MEAN: a fixed list of
// concerns, a priority per concern, and one table in code that turns a
// priority into lens settings. The same answers always produce the same
// profile, and every setting can say which concern put it there.
//
// Four points every interview covers, whatever else it asks (FIXED_POINTS):
// the project's goals (words, which become lens emphasis), what must block a
// merge, the risk areas (security, data, money, compliance), and style &
// tests. Every concern below belongs to one of the last three; the goals are
// recorded as text. A profile write is refused until every concern has a
// priority — that is how "covers the four points" is a property of the tool
// rather than a hope about the conversation.
//
// The table owns four keys of `[lenses.<pass>]` (src/lenstuning.ts) — `enabled`,
// `min_tier`, `effort`, `max_severity` — on every lens a concern names, and
// nothing else: `emphasis` is the companion's words, `guide` is a drafted
// style guide, and a lens no concern names is never touched. `normal` is the
// shipped behaviour, so it CLEARS those four keys rather than writing them.
// A lens two concerns share takes the HIGHER priority of the two: switching
// one concern off never switches off a lens another concern still wants.
//
// Pure — no port, no clock, no disk.
import type { LensTuning } from "../lenstuning.js";

/** The four points every setup interview covers. */
export const FIXED_POINTS = [
  {
    name: "goals",
    question: "What is this project for, and what does a good change to it look like?",
  },
  { name: "merge-blocking", question: "What must stop a pull request from merging?" },
  { name: "risk", question: "Which risk areas matter here — security, data, money, compliance?" },
  { name: "style-tests", question: "How much do code style and tests matter in review?" },
] as const;

export type FixedPoint = (typeof FIXED_POINTS)[number]["name"];

/** How much one concern matters to this repo, highest first. */
export const PRIORITIES = ["critical", "important", "normal", "ignore"] as const;
export type Priority = (typeof PRIORITIES)[number];

/** The keys of `[lenses.<pass>]` the table owns. */
export type TableSettings = Pick<LensTuning, "enabled" | "min_tier" | "effort" | "max_severity">;
export const TABLE_KEYS = ["enabled", "min_tier", "effort", "max_severity"] as const;

/**
 * THE table: a priority → the lens settings it means.
 *
 *   critical  — on, at the strongest tier, at the model's ceiling, and able
 *               to block (`P0` lifts every cap the lens would otherwise carry);
 *   important — on (a lens a `[review]` lever gates runs anyway), never below
 *               the mid tier, at medium effort; its own severity cap stands;
 *   normal    — nothing: the shipped behaviour (and a re-tune back to normal
 *               clears whatever an earlier answer wrote);
 *   ignore    — off: not planned, not addable, not paid for.
 */
export const PRIORITY_SETTINGS: Readonly<Record<Priority, Readonly<TableSettings>>> = {
  critical: {
    enabled: true,
    min_tier: "sol-high",
    effort: "high",
    max_severity: "P0",
  },
  important: { enabled: true, min_tier: "sol-med", effort: "medium" },
  normal: {},
  ignore: { enabled: false },
};

export interface Concern {
  name: string;
  point: Exclude<FixedPoint, "goals">;
  title: string;
  /** The lenses whose settings this concern's priority decides. */
  lenses: readonly string[];
}

/**
 * The concerns, and the lenses each one decides. Neither the validator
 * (`pass-validate` — a profile may switch it off by hand, the interview never
 * does), `pass-intent` (its question/nit cap is a ratified decision) nor
 * `pass-ask-human` is here.
 */
export const CONCERNS: readonly Concern[] = [
  {
    name: "correctness",
    point: "merge-blocking",
    title: "Correctness — logic bugs, broken invariants, local slips",
    lenses: ["pass-baseline", "pass-widened", "pass-sweep"],
  },
  {
    name: "reliability",
    point: "merge-blocking",
    title: "Production reliability — behaviour changes, many pods, queued work",
    lenses: ["pass-prod-risk", "pass-statelessness", "pass-deferred"],
  },
  {
    name: "compatibility",
    point: "merge-blocking",
    title: "Deploy-window compatibility — old and new code running together",
    lenses: ["pass-backcompat", "pass-rollout"],
  },
  {
    name: "integrations",
    point: "merge-blocking",
    title: "External contracts — provider payloads and their semantics",
    lenses: ["pass-contracts"],
  },
  {
    name: "frontend",
    point: "merge-blocking",
    title: "Frontend state — effects, mutations, async UI",
    lenses: ["pass-ui"],
  },
  {
    name: "design",
    point: "merge-blocking",
    title: "Design — placement, simplicity, abstraction, duplication, consistency",
    lenses: [
      "pass-placement",
      "pass-simplicity",
      "pass-abstraction",
      "pass-maintainability",
      "pass-duplication",
      "pass-consistency",
    ],
  },
  {
    name: "security",
    point: "risk",
    title: "Security — authz, injection, tenant isolation, trust bounds",
    lenses: ["pass-security", "pass-bounds"],
  },
  {
    name: "data",
    point: "risk",
    title: "Data safety — migrations, backfills, persisted bytes",
    lenses: ["pass-data-safety", "pass-roundtrip"],
  },
  {
    name: "money",
    point: "risk",
    title: "Money — payments and billing: double charges, lost events, races",
    lenses: ["pass-contracts", "pass-delivery", "pass-concurrency"],
  },
  {
    name: "compliance",
    point: "risk",
    title: "Compliance — personal data, audit trails, retention",
    lenses: ["pass-security", "pass-data-safety"],
  },
  {
    name: "style",
    point: "style-tests",
    title: "Code style — against a written guide",
    lenses: ["pass-style"],
  },
  {
    name: "tests",
    point: "style-tests",
    title: "Tests — what the change breaks, what its tests really test",
    lenses: ["pass-tests"],
  },
];

export const CONCERN_NAMES: readonly string[] = CONCERNS.map((c) => c.name);

export type Priorities = Readonly<Record<string, Priority>>;

const RANK: Record<Priority, number> = { critical: 3, important: 2, normal: 1, ignore: 0 };

/** Read a `{concern: priority}` object the companion sent. Unknown concerns
 * and unknown priorities are refused by name; a missing concern is not an
 * error here (the write decides whether the set is complete). */
export function parsePriorities(
  raw: unknown,
): { ok: true; priorities: Record<string, Priority> } | { ok: false; errors: string[] } {
  if (raw === undefined || raw === null) return { ok: true, priorities: {} };
  if (typeof raw !== "object" || Array.isArray(raw)) {
    return { ok: false, errors: ["`priorities` must be an object of {concern: priority}"] };
  }
  const errors: string[] = [];
  const out: Record<string, Priority> = {};
  for (const [concern, value] of Object.entries(raw as Record<string, unknown>)) {
    if (!CONCERN_NAMES.includes(concern)) {
      errors.push(`unknown concern "${concern}" — one of: ${CONCERN_NAMES.join(", ")}`);
      continue;
    }
    const p = typeof value === "string" ? value.trim().toLowerCase() : value;
    if (!(PRIORITIES as readonly unknown[]).includes(p)) {
      errors.push(
        `${concern}: priority must be one of ${PRIORITIES.join(", ")}, got ${JSON.stringify(value)}`,
      );
      continue;
    }
    out[concern] = p as Priority;
  }
  return errors.length > 0 ? { ok: false, errors } : { ok: true, priorities: out };
}

/** The concerns `priorities` does not answer yet, in table order. */
export function unansweredConcerns(priorities: Priorities): string[] {
  return CONCERN_NAMES.filter((c) => priorities[c] === undefined);
}

/** One lens's settings as the table decides them, and why. */
export interface LensDecision {
  lens: string;
  priority: Priority;
  /** The concern(s) at that priority that decided it. */
  because: string[];
  settings: TableSettings;
}

/**
 * The table applied: every lens any concern names, at the highest priority
 * among the concerns naming it, with that priority's settings. Only concerns
 * present in `priorities` count; a lens none of them names is absent.
 * Deterministic (lens name order).
 */
export function lensDecisions(priorities: Priorities): LensDecision[] {
  const best = new Map<string, { priority: Priority; because: string[] }>();
  for (const concern of CONCERNS) {
    const p = priorities[concern.name];
    if (p === undefined) continue;
    for (const lens of concern.lenses) {
      const cur = best.get(lens);
      if (!cur || RANK[p] > RANK[cur.priority])
        best.set(lens, { priority: p, because: [concern.name] });
      else if (RANK[p] === RANK[cur.priority]) cur.because.push(concern.name);
    }
  }
  return [...best.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([lens, { priority, because }]) => ({
      lens,
      priority,
      because,
      settings: { ...PRIORITY_SETTINGS[priority] },
    }));
}
