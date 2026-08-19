// Severity → posting-tag mapping (spec §5): P0/P1 → [blocker]; P2 → [blocker]
// iff confidence ≥ 0.8 else [question]; P3 → [question] (or [nit] when the
// finding is a nit-class polish item). Nits and questions never block.
//
// adds a third axis, `reachability` — how often the triggering state
// actually arises, as opposed to how bad it is (severity) or whether the claim
// is true (confidence). It is applied as a gate BEFORE the severity mapping and
// can only ever weaken a tag: `contrived` never blocks at any severity,
// `plausible` demotes P2 to a question, `routine` (and an absent field) leaves
// the mapping exactly as it was. The blocker bar itself does not move — a
// `routine` P0/P1 blocks today as it always did.
//
// adds the first-party directive gate (the owner, 2026-08-19): an
// injection finding anchored on the reviewed repo's OWN agent-directive files
// (.claude/**, prompts/**, AGENTS.md/CLAUDE.md and kin, edited through the
// normal PR flow) never blocks — directive text inside a directive file is the
// file doing its job, and the merge call belongs to a person. The finding
// posts as a [question] and the round's verdict routes to NEEDS_HUMAN (the
// standard non-blocking park), with one short escalation comment @-mentioning
// a teammate (assembled in posting.ts, mention picked in dispatch.ts).
// Third-party/vendored directive content keeps the P1 bright line unchanged.

import type { Verdict as VerdictType } from "./types.js";

export type Severity = "P0" | "P1" | "P2" | "P3" | "nit";
export type PostTag = "blocker" | "question" | "nit";

/** How often the state a finding depends on actually arises. */
export type Reachability = "routine" | "plausible" | "contrived";

export const REACHABILITY_VALUES: readonly Reachability[] = ["routine", "plausible", "contrived"];

/** Findings that omit the axis are read as `routine` — the legacy
 * behaviour, so an un-upgraded pass can never accidentally soften a blocker. */
export function normalizeReachability(value: string | undefined | null): Reachability {
  return REACHABILITY_VALUES.includes(value as Reachability) ? (value as Reachability) : "routine";
}

// ---- first-party directive provenance ---------------------------

/** Path segments that mark VENDORED/third-party content: a directive file
 * under one of these keeps the injection bright line — it was not authored
 * in-repo through the PR flow. */
const VENDORED_SEGMENTS = new Set(["node_modules", "vendor", "vendors", "vendored", "third_party", "third-party", "external"]);

/** Basenames that are agent-directive files wherever they sit in the tree. */
const DIRECTIVE_BASENAMES = new Set(["AGENTS.md", "AGENT.md", "CLAUDE.md", ".cursorrules"]);

/** Directory segments whose whole subtree is agent-directive content. */
const DIRECTIVE_DIR_SEGMENTS = new Set([".claude", ".cursor"]);

/**
 * Is `path` a FIRST-PARTY agent-directive file of the reviewed repo —
 * `.claude/**`, top-level `prompts/**`, an `AGENTS.md`/`CLAUDE.md` (and kin)
 * at any depth — and NOT under a vendored tree? The predicate is deliberately
 * path-shaped and shared: dispatch uses it to pick the escalation mention,
 * the tag mapping below uses it to keep such findings off the blocker bar.
 */
export function isFirstPartyDirectivePath(path: string | undefined | null): boolean {
  if (!path) return false;
  const segments = path.split("/").filter(Boolean);
  if (segments.length === 0) return false;
  if (segments.some((s) => VENDORED_SEGMENTS.has(s.toLowerCase()))) return false;
  const basename = segments[segments.length - 1] as string;
  if (DIRECTIVE_BASENAMES.has(basename)) return true;
  if (segments.some((s) => DIRECTIVE_DIR_SEGMENTS.has(s))) return true;
  // prompts/** binds at the repo root only — a nested `foo/prompts/` is an
  // ordinary source directory in most trees.
  if (segments[0] === "prompts") return true;
  if (segments.join("/") === ".github/copilot-instructions.md") return true;
  return false;
}

/** The gate condition: an injection-kind finding anchored on a
 * first-party directive path. Findings without a `kind` are never gated. */
export function isFirstPartyDirectiveInjection(kind: string | undefined | null, path: string | undefined | null): boolean {
  return kind?.trim().toLowerCase() === "injection" && isFirstPartyDirectivePath(path);
}

export interface PostTagContext {
  /** The finding's `kind` field, when the pass emitted one. */
  kind?: string | null;
  /** The finding's anchored path. */
  path?: string | null;
}

export function postTag(
  severity: Severity,
  confidence: number,
  reachability?: Reachability | null,
  ctx?: PostTagContext,
): PostTag {
  // First-party directive gate — applied before everything else and,
  // like reachability, only ever WEAKENS a tag: an injection finding on the
  // repo's own directive files posts as a question (the verdict routes to
  // NEEDS_HUMAN at the verdict layer), never as a blocker. Any other path —
  // vendored trees included — falls through to the unchanged bright line.
  if (ctx && isFirstPartyDirectiveInjection(ctx.kind, ctx.path)) {
    return severity === "nit" ? "nit" : "question";
  }
  const reach = normalizeReachability(reachability);
  // Reachability gate — never blocks something the base mapping wouldn't.
  if (reach === "contrived") return severity === "nit" ? "nit" : "question";
  if (reach === "plausible" && severity === "P2") return "question";
  switch (severity) {
    case "P0":
    case "P1":
      return "blocker";
    case "P2":
      return confidence >= 0.8 ? "blocker" : "question";
    case "P3":
      return "question";
    case "nit":
      return "nit";
  }
}

export type { Verdict } from "./types.js";

export interface VerdictInput {
  hasBlockers: boolean;
  /** The session's own "I cannot decide this" call. Since the escalation
   * heuristic was scrapped (2026-08-18) this is the ONLY session-side input
   * that parks a PR — no daemon-side criteria feed it. */
  needsHuman: boolean;
  /**: at least one injection finding sits on a first-party directive
   * path. Such findings are never tagged [blocker] (see postTag), and the
   * round parks: the merge call on the repo's own agent-directive edits
   * belongs to a person. A real blocker elsewhere still wins — the park
   * never softens REQUEST_CHANGES. */
  firstPartyDirectiveInjection?: boolean;
}

/** Verdict logic: any [blocker] ⇒ REQUEST_CHANGES; the session cannot decide,
 * or a first-party directive edit needs a human eye ⇒ NEEDS_HUMAN;
 * else APPROVE. */
export function deriveVerdict(v: VerdictInput): VerdictType {
  if (v.hasBlockers) return "REQUEST_CHANGES";
  if (v.needsHuman || v.firstPartyDirectiveInjection) return "NEEDS_HUMAN";
  return "APPROVE";
}
