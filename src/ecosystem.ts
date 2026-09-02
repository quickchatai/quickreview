// The ONE ecosystem pre-check seam.
//
// Everything framework-specific about a round — the tier-forcing migration
// gate, the migration-number collision pre-check, and the round prompt's
// migration-gate prose — talks to `Ecosystem`. No caller knows which framework
// (if any) the reviewed repo uses: dispatch asks the seam, the templates ask
// the seam, and the profile (`profiles/<name>/profile.toml`, loaded by
// `src/profiles.ts`) picks the implementation.
//
// Exactly TWO implementations, both here:
//
//   * `DJANGO_ECOSYSTEM` — today's behavior, byte-for-byte: the
//     collision pre-check (detection at the pinned base sha, remedy posted as
//     a gated COMMENT, degraded-is-never-quieter), the `migrations/` tier
//     gate, and the MIGRATION GATE prompt prose that used to live in
//     src/templates.ts. The detection/rendering pure functions stay in
//     src/migrations.ts — this object is the seam over them, not a rewrite.
//   * `NONE_ECOSYSTEM` — the clean CONFIGURED-OFF state, first-class and
//     distinct from degradation: no pre-check runs (`{ status: "off" }` — an
//     answer, not an error), no degraded path, no gate note, no anomaly, no
//     tier forcing. A generic install's rounds carry no migration-gate prose
//     at all.
//
// Shape notes (deliberate — the same discipline as src/memory/store.ts):
//
//   * Every method is TOTAL. `preCheck` resolves with an outcome for every
//     input — a check that could not run is `{ status: "degraded" }`
//     (refusal-as-answer), an ecosystem with no check is `{ status: "off" }`;
//     only a broken caller contract could throw, and the Django
//     implementation swallows even its own I/O failures into events, exactly
//     as the legacy dispatch function did.
//   * "off" and "degraded" are DIFFERENT arms of the outcome union, never one
//     boolean. Degraded is the ratified never-quieter path (gate note +
//     overseer anomaly + un-muzzled pass-data-safety); off is silence by
//     configuration, and conflating them would either spam a non-Django repo
//     with degradation noise or mute a Django repo's real degradation.
//   * The seam takes its I/O per call (`EcosystemPreCheckIo`), so the
//     implementations hold no state and dispatch keeps owning the store, the
//     gate-backed adapter and the git seam — nothing here can grow a second
//     mutation path.
import type { GateResult } from "./gate.js";
import { migrationGate as djangoMigrationGate, type PrFile } from "./heuristics.js";
import type { CollisionCommentRecord } from "./state.js";
import {
  collisionFingerprint,
  detectMigrationCollisions,
  renderMigrationCollisionComment,
  type MigrationCollision,
} from "./migrations.js";

/** The ecosystems a profile may select (`profile.toml`, key `ecosystem`). */
export type EcosystemName = "django" | "none";

/** One round's facts, as the dispatch pre-check call site knows them. */
export interface EcosystemRound {
  pr: number;
  /** The PR's changed files (the files-API shape migrations.ts consumes). */
  files: Array<{ filename: string; status?: string; patch?: string }>;
  head_sha: string;
  base_ref: string;
  base_sha: string;
}

/** The I/O the pre-check may perform, passed per call by dispatch. Every
 * write still rides the caller's gate-backed adapter (`createReview` is
 * dispatch's own gated COMMENT route) — the seam adds no mutation path. */
export interface EcosystemPreCheckIo {
  logEvent(kind: string, pr: number | null, payload?: unknown): void;
  /** Has this exact (head, collision set) already been commented? (
   * staleness-round dedupe — suppress the repost, never the check.) `unknown`
   * — a comment row the ledger cannot read — also suppresses the post: a
   * duplicate on the reviewed repo is the mutation this read exists to
   * prevent, and an unreadable row cannot rule it out. */
  migrationCollisionCommented(pr: number, fingerprint: string): CollisionCommentRecord;
  /** The gated COMMENT delivery — dispatch's `adapter.createReview`. */
  createReview(
    pr: number,
    payload: { commit_id: string; event: "APPROVE" | "REQUEST_CHANGES" | "COMMENT"; body: string },
    options?: { purpose?: "migration_precheck" },
  ): Promise<GateResult>;
  /** Every migration path on the base branch at a sha (read-only git).
   * Absent ⇒ the Django check degrades (never a throw, never silence). */
  listBaseMigrations?: (baseSha: string) => Promise<string[]>;
  log?: (msg: string, extra?: unknown) => void;
}

/**
 * What one round's pre-check concluded. THE off/degraded distinction lives in
 * this union:
 *
 *   * `"off"`       — configured off (`ecosystem = "none"`): no check exists,
 *                     nothing ran, nothing degraded, nothing to say.
 *   * `"checked"`   — the check ran; `collisions` is what it found (usually
 *                     empty, and already delivered as a COMMENT when not).
 *   * `"degraded"`  — the check EXISTS but could not run this round (no base
 *                     reader, no base sha, or the base read threw) while the
 *                     PR touches migrations. The ratified never-quieter path:
 *                     the caller raises the overseer anomaly and the round
 *                     prompt un-muzzles the lens.
 */
export type EcosystemPreCheckOutcome =
  | { status: "off" }
  | { status: "checked"; collisions: MigrationCollision[] }
  | { status: "degraded" };

/** The slice of a RoundOrder the gate note renders from — structural, so a
 * full RoundOrder satisfies it as-is. */
export interface GateNoteFacts {
  migration_gate: boolean;
  migration_precheck_degraded?: boolean;
  migration_collisions?: MigrationCollision[] | undefined;
}

export interface Ecosystem {
  readonly name: EcosystemName;
  /** The tier-forcing gate (heuristics: forces sol-med and flags the round's
   * `migration_gate`). Pure and total; `none` is constantly false. */
  migrationGate(files: PrFile[]): boolean;
  /**
   * The round's pre-check, run by dispatch after the worktree is prepared and
   * BEFORE the session hears about the round. Total: resolves with an outcome
   * for every input, never throws — a failure inside is an event plus a
   * degraded/checked outcome, exactly the legacy contract.
   */
  preCheck(io: EcosystemPreCheckIo, round: EcosystemRound): Promise<EcosystemPreCheckOutcome>;
  /** The round prompt's entire `{{migration_gate_note}}` text. `none` renders
   * `""` — a none round carries NO migration-gate prose at all. */
  gateNote(facts: GateNoteFacts): string;
}

// ---- Django prose (moved byte-for-byte from src/templates.ts) -----

// The migration gate survived the escalation scrap (the owner, 2026-08-18) as a
// data-safety signal: it still forces the sol-med tier and still tells the
// session the DDL must be judged. Only the "escalate unless…" framing is gone.
const GATE_ON =
  "MIGRATION GATE: this PR touches migrations — pass-data-safety must judge the ORM operations and any supplied generated SQL for destructive mutation, concrete rebuild/locking risk, backfill safety, and rolling-deploy ordering. Ordinary Django ORM operations are acceptable and must not be rewritten as handwritten SQL merely for reviewability. Only a concrete migration hazard blocks; missing generated SQL or an unproven database algorithm does not.";
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
    if (c.kind === "renamed-dependency") {
      lines.push(
        `- \`${c.pr_path}\` references renamed \`"${c.stale_dependency ?? ""}"\` → dependencies \`[${c.dependency}]\`` +
          (c.renumber ? `, rename to \`${c.target_path}\`` : ""),
      );
      continue;
    }
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

/**
 * The GATE NOTES paragraph for a DEGRADED pre-check ("more reliable,
 * never quieter"). When the daemon could not run the collision check at all —
 * no base reader, no base sha, or the base read failed — the class must not
 * fall between two stools: the daemon caught nothing AND the pass-data-safety
 * addendum (src/include.ts) muzzles the lens. This note is the key that
 * un-muzzles it for exactly this round: the addendum's withdrawal is
 * conditional on the round prompt NOT carrying this text.
 */
export function renderMigrationPrecheckDegradedNote(): string {
  return [
    "",
    "",
    "MIGRATION PRE-CHECK DID NOT RUN — CHECK COLLISIONS YOURSELF. The daemon",
    "normally checks this PR's migration numbers against the base branch before",
    "each round and posts the renumber remedy itself as a COMMENT. This round the",
    "migration pre-check did not run (the base branch facts were unavailable or",
    "the base read failed), so nothing has been checked and nothing has been",
    "posted. YOU must check base-branch migration-number collisions yourself this",
    "round: compare every migration this PR adds against the base branch's",
    "migrations, and report a number the base already occupies as a normal",
    "finding — with the remedy (the free target number and the exact",
    "`dependencies` entry) stated. This lifts, for this round only, the standing",
    "rule that base-branch numbering collisions are handled daemon-side.",
  ].join("\n");
}

// ---- the two implementations ----------------------------------------------

/**
 * Django: today's pre-check, behavior-identical (moved behind the
 * seam by — the body below is dispatch.ts's `migrationPreCheck`
 * verbatim, with its DispatchDeps slice renamed to the seam's `io`).
 *
 * A PR migration sitting on a number the base branch already took is
 * deterministic, has exactly one remedy and carries no design content — so the
 * daemon states the remedy itself, as a **COMMENT**. It is never a blocker, it
 * consumes no verdict, and it does not touch the PR's lifecycle state. The
 * write is `io.createReview`, i.e. the ordinary MutationGate path; in dry-run
 * it lands in state/dryrun/ like every other intent.
 *
 * Every failure here is logged and swallowed: a round must never be lost to
 * the pre-check. A degraded check must never be quieter than no check at all
 * (acceptance: "more reliable, never quieter"): the caller renders an
 * explicit "the pre-check did not run — check collisions yourself" note into
 * the round prompt, which is what conditionally un-muzzles pass-data-safety's
 * withdrawn finding class for exactly that round (see src/include.ts,
 * MIGRATION_NUMBERING_ADDENDUM), and raises the overseer anomaly.
 */
async function djangoPreCheck(io: EcosystemPreCheckIo, round: EcosystemRound): Promise<EcosystemPreCheckOutcome> {
  const log = io.log ?? (() => {});
  const touchesMigrations = round.files.some((f) => /(^|\/)migrations\//.test(f.filename));
  if (!io.listBaseMigrations || !round.base_sha) {
    // Not a silent pass: the check is ~15% of all blockers and nothing else in
    // the pipeline catches the class, so a round that could not run it says so.
    if (touchesMigrations) {
      io.logEvent("migration_precheck_skipped", round.pr, {
        head_sha: round.head_sha,
        reason: !io.listBaseMigrations ? "no_base_reader" : "no_base_sha",
      });
      return { status: "degraded" };
    }
    return { status: "checked", collisions: [] };
  }
  let collisions: MigrationCollision[];
  try {
    const baseFiles = await io.listBaseMigrations(round.base_sha);
    collisions = detectMigrationCollisions({ files: round.files, baseFiles });
  } catch (err) {
    log(`dispatch: migration pre-check failed on #${round.pr}`, err);
    io.logEvent("migration_precheck_failed", round.pr, { head_sha: round.head_sha, error: String(err) });
    return touchesMigrations ? { status: "degraded" } : { status: "checked", collisions: [] };
  }
  if (collisions.length === 0) return { status: "checked", collisions };
  io.logEvent("migration_collision_detected", round.pr, {
    head_sha: round.head_sha,
    base_ref: round.base_ref,
    base_sha: round.base_sha,
    collisions: collisions.map((c) => ({ pr_path: c.pr_path, base_path: c.base_path, target_path: c.target_path })),
  });
  const fingerprint = collisionFingerprint(round.head_sha, collisions);
  // A staleness round re-runs at the same head and must not repost the same
  // comment. Detection still runs and is still logged; only the duplicate
  // COMMENT is suppressed.
  const commented = io.migrationCollisionCommented(round.pr, fingerprint);
  if (commented === "commented") {
    log(`dispatch: #${round.pr} migration collision already commented at ${round.head_sha}`);
    return { status: "checked", collisions };
  }
  if (commented === "unknown") {
    // The ledger holds a comment row it cannot read. Posting would risk the
    // exact duplicate the dedupe exists to prevent, so the COMMENT is withheld
    // — loudly, and with the check still counted as RUN: the collisions ride
    // the round order into the gate note, so the session still hears them.
    log(`dispatch: #${round.pr} migration collision comment withheld — an earlier comment row is unreadable`);
    io.logEvent("migration_collision_comment_withheld", round.pr, {
      head_sha: round.head_sha,
      fingerprint,
      reason: "unreadable_comment_row",
    });
    return { status: "checked", collisions };
  }
  try {
    const body = renderMigrationCollisionComment({
      collisions,
      base_ref: round.base_ref,
      base_sha: round.base_sha,
    });
    const result = await io.createReview(round.pr, {
      commit_id: round.head_sha,
      event: "COMMENT",
      body,
    }, { purpose: "migration_precheck" });
    io.logEvent("migration_collision_comment", round.pr, {
      head_sha: round.head_sha,
      fingerprint,
      executed: result.executed,
      dry_run_file: result.dryRunFile ?? null,
    });
  } catch (err) {
    // The COMMENT failed, but the collisions are real, already detected and
    // already logged — throwing them away here would leave the round's gate
    // note empty while the addendum still muzzles the lens, i.e. NOBODY
    // holding the class. The check RAN (not degraded); the comment retries on
    // the next round because the fingerprint is only marked on success.
    log(`dispatch: migration pre-check failed on #${round.pr}`, err);
    io.logEvent("migration_precheck_failed", round.pr, {
      head_sha: round.head_sha,
      stage: "create_review",
      error: String(err),
    });
  }
  return { status: "checked", collisions };
}

export const DJANGO_ECOSYSTEM: Ecosystem = {
  name: "django",
  migrationGate: (files) => djangoMigrationGate(files),
  preCheck: djangoPreCheck,
  gateNote: (facts) =>
    (facts.migration_gate ? GATE_ON : GATE_OFF) +
    (facts.migration_precheck_degraded
      ? renderMigrationPrecheckDegradedNote()
      : renderMigrationCollisionsNote(facts.migration_collisions ?? [])),
};

/**
 * Configured off. Not a degraded Django: nothing runs, nothing is read,
 * nothing is logged, nothing is posted, no anomaly is raised, no prose is
 * rendered, and the tier gate never fires. `{ status: "off" }` is the
 * first-class answer that keeps every one of those a structural fact rather
 * than a skipped branch.
 */
export const NONE_ECOSYSTEM: Ecosystem = {
  name: "none",
  migrationGate: () => false,
  preCheck: async () => ({ status: "off" }),
  gateNote: () => "",
};

/** The implementation a profile's `ecosystem` name selects. */
export function ecosystemFor(name: EcosystemName): Ecosystem {
  return name === "django" ? DJANGO_ECOSYSTEM : NONE_ECOSYSTEM;
}
