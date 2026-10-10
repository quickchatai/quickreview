// Django migration-number collision pre-check. Pure functions: the
// caller supplies the PR's changed files and the migration paths that exist on
// the base branch at the round's `base_sha`; this module decides whether the PR
// occupies a number the base already took, and writes the remedy.
//
// Why it lives daemon-side rather than in a lens: a leaf-node collision with
// the base branch is deterministic, machine-checkable without an LLM, has
// exactly one remedy (renumber + repoint `dependencies`) and carries no design
// content. Raised as a blocker it would consume the merge gate and cost the
// author a full re-review round for a mechanical rename. Nothing
// else in the pipeline catches it (GitHub reports MERGEABLE because the
// filenames differ, and CI is green), so the check does not get quieter here:
// it runs every round, deterministically, and is delivered as a COMMENT.
//
// This is not a trivial-delta classifier (src/recheck.ts owns that) —
// detection and comment text only.

import { codePath, flatControls } from "./codespan.js";

/** One migration file, parsed out of its path. */
export interface MigrationRef {
  path: string;
  /** Directory holding `migrations/` — the app's identity in this tree
   * ("backend/chat"); "" for a repo-root `migrations/`. */
  app: string;
  /** Last segment of `app` — what a `dependencies` tuple names ("chat"). */
  app_label: string;
  number: number;
  /** Zero-padded number exactly as it appears on disk ("0042"). */
  digits: string;
  /** Migration name without number or extension ("add_rate_limit"). */
  name: string;
}

/** A PR migration whose number is already taken on the base branch — or a
 * later PR migration whose `dependencies` reference one that the remedy
 * renames (a "renamed-dependency" follow-up). */
export interface MigrationCollision {
  app: string;
  app_label: string;
  /** The PR file that must be renamed (or, for a follow-up that keeps its
   * number, whose `dependencies` must be edited). */
  pr_path: string;
  /** The number both sides claim (follow-ups: the file's own number). */
  number: number;
  /** The base-branch migration sitting on that number ("" for follow-ups —
   * a follow-up collides with nothing on the base; its defect is the stale
   * dependency reference). */
  base_path: string;
  /** Free number the PR migration must move to (follow-ups that keep their
   * number: the current number). */
  target_number: number;
  /** Path the PR migration must move to (follow-ups that keep their number:
   * the current path). */
  target_path: string;
  /** Migration the renumbered file must depend on (name, no extension). */
  dependency_name: string;
  /** The exact `dependencies` entry to write. */
  dependency: string;
  /** Why this entry exists. Absent (orders built before follow-up detection
   * existed) reads as "base-collision". */
  kind?: "base-collision" | "renamed-dependency";
  /** Follow-ups only: the old (pre-renumber) name this file's `dependencies`
   * still reference. */
  stale_dependency?: string;
  /** Follow-ups only: false when the file keeps its number and only its
   * `dependencies` entry moves. */
  renumber?: boolean;
  /** Follow-ups only, and only when the renamed dependency lives in another
   * app: that app's label, which the stale tuple names. Absent ⇒ `app_label`. */
  dependency_app_label?: string;
}

const MIGRATION_PATH = /^(?:(.*)\/)?migrations\/(\d{2,})_([^/]+)\.py$/;

/** Parse `…/<app>/migrations/NNNN_name.py`; undefined for anything else
 * (including `__init__.py`, which carries no number). */
export function parseMigrationPath(path: string): MigrationRef | undefined {
  const m = MIGRATION_PATH.exec(path);
  if (!m) return undefined;
  const app = m[1] ?? "";
  const digits = m[2] as string;
  return {
    path,
    app,
    app_label: app.split("/").filter(Boolean).pop() ?? "",
    number: Number(digits),
    digits,
    name: m[3] as string,
  };
}

/** Re-number a ref onto `n`, keeping the on-disk zero-padding width. */
function renamedTo(ref: MigrationRef, n: number): { name: string; path: string } {
  const digits = String(n).padStart(ref.digits.length, "0");
  const name = `${digits}_${ref.name}`;
  return { name, path: `${ref.app ? `${ref.app}/` : ""}migrations/${name}.py` };
}

export interface CollisionInput {
  /** The PR's changed files (github.ts `PrFileEntry`, or any shape with a
   * filename and optionally a status and unified diff). The `patch` is what
   * lets the detector see a later migration's `dependencies` referencing a
   * migration the remedy renames. */
  files: Array<{ filename: string; status?: string; patch?: string }>;
  /** Every migration path present on the base branch at `base_sha`. */
  baseFiles: string[];
}

function escapeRe(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** Whitespace inside a tuple, where a line break in a unified diff carries
 * the next line's `+` prefix. */
const DIFF_GAP = "(?:[^\\S\\n]|\\n\\+?)*";

/** Does this file's diff name `(app_label, name)` as a `dependencies` tuple?
 * A cross-app reference must carry the label — a bare `"0001_initial"` in
 * another app is that app's own migration. The tuple may be split across
 * added diff lines and carry a trailing comma. */
function referencesAppMigration(
  patch: string | undefined,
  appLabel: string,
  name: string,
): boolean {
  if (!patch || !name || !appLabel) return false;
  const g = DIFF_GAP;
  return new RegExp(
    `\\(${g}["']${escapeRe(appLabel)}["']${g},${g}["']${escapeRe(name)}["']${g}(?:,${g})?\\)`,
  ).test(patch);
}

/** Same-app follow-up match. A same-app dependency is an `(app_label, name)`
 * tuple, but the label is inferred from the directory and Django's label can
 * differ, and a tuple split across diff lines carries a `+` between its halves
 * — so a bare quoted `name` still counts (the check must never get quieter
 * than a name-only match), except an occurrence that is the second
 * half of a tuple naming another app this PR or the base branch holds: that
 * one is that app's identically named migration. */
function referencesOwnMigration(
  patch: string | undefined,
  ownLabel: string,
  name: string,
  knownLabels: ReadonlySet<string>,
): boolean {
  if (!patch || !name) return false;
  if (referencesAppMigration(patch, ownLabel, name)) return true;
  const re = new RegExp(`["']${escapeRe(name)}["']`, "g");
  const tupleHead = /\(\s*["']([^"'\n]*)["']\s*,\s*$/;
  for (let m = re.exec(patch); m !== null; m = re.exec(patch)) {
    const head = tupleHead.exec(patch.slice(Math.max(0, m.index - 200), m.index));
    if (head && head[1] !== ownLabel && knownLabels.has(head[1] as string)) continue;
    return true;
  }
  return false;
}

/**
 * Migration numbers this PR claims that the base branch already occupies.
 *
 * A collision is "same app, same number, different file" — a PR file that
 * merely edits a migration already on the base (same path) is not one. Deleted
 * PR files are ignored. Collisions are returned in path order per app, and the
 * assigned target numbers form a chain: the first renumbered migration in an
 * app depends on the base branch's leaf, each later one on its predecessor.
 */
export function detectMigrationCollisions(input: CollisionInput): MigrationCollision[] {
  const baseByApp = new Map<string, Map<number, MigrationRef>>();
  // Every base migration path. Django names a migration by app + full name, so
  // a merged graph can legitimately hold 0042_a and 0042_b; a PR editing
  // either one edits an existing file and collides with nothing.
  const basePaths = new Set<string>();
  for (const path of input.baseFiles) {
    const ref = parseMigrationPath(path);
    if (!ref) continue;
    basePaths.add(ref.path);
    const byNumber = baseByApp.get(ref.app) ?? new Map<number, MigrationRef>();
    // Two base migrations on one number (branched history + a merge
    // migration): the higher path is the occupant a new file is told about.
    const prev = byNumber.get(ref.number);
    if (!prev || prev.path < ref.path) byNumber.set(ref.number, ref);
    baseByApp.set(ref.app, byNumber);
  }

  const prByApp = new Map<string, Array<{ ref: MigrationRef; patch?: string }>>();
  for (const f of input.files) {
    if (f.status === "removed") continue;
    const ref = parseMigrationPath(f.filename);
    if (!ref) continue;
    prByApp.set(ref.app, [
      ...(prByApp.get(ref.app) ?? []),
      { ref, ...(f.patch !== undefined ? { patch: f.patch } : {}) },
    ]);
  }

  // Every app label either side holds — what tells a same-app bare-name match
  // apart from another app's identically named migration.
  const knownLabels = new Set<string>();
  for (const path of basePaths) knownLabels.add(parseMigrationPath(path)!.app_label);
  for (const entries of prByApp.values())
    for (const { ref } of entries) knownLabels.add(ref.app_label);
  knownLabels.delete("");

  const out: MigrationCollision[] = [];
  // Every rename the remedy prescribes, per app, for the cross-app follow-up
  // pass below.
  const renamedByApp = new Map<
    string,
    { app_label: string; renamed: Map<string, { name: string; number: number }> }
  >();
  for (const [app, entries] of [...prByApp].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))) {
    const base = baseByApp.get(app) ?? new Map<number, MigrationRef>();
    const ordered = [...entries].sort(
      (a, b) => a.ref.number - b.ref.number || (a.ref.path < b.ref.path ? -1 : 1),
    );
    const colliding = ordered.filter(({ ref: r }) => {
      const occupant = base.get(r.number);
      return occupant !== undefined && !basePaths.has(r.path);
    });
    if (colliding.length === 0) continue;

    // Free numbers start above everything either side already uses, so the
    // remedy never collides with a sibling migration in the same PR.
    const used = [...base.keys(), ...ordered.map(({ ref: r }) => r.number)];
    let next = Math.max(...used) + 1;
    // The chain root is the base branch's leaf — the highest number the base
    // holds for this app, which is what the renumbered migration must depend on.
    const baseLeaf = [...base.values()].sort((a, b) => a.number - b.number).pop();
    let dependencyName = baseLeaf ? `${baseLeaf.digits}_${baseLeaf.name}` : "";
    // Old (pre-remedy) name → the new name the remedy assigns. Follow-up
    // detection below reads this to find later migrations whose `dependencies`
    // still point at a name the remedy retires.
    const renamed = new Map<string, { name: string; number: number }>();
    const collidingPaths = new Set(colliding.map(({ ref: r }) => r.path));
    for (const { ref } of colliding) {
      const targetNumber = next++;
      const target = renamedTo(ref, targetNumber);
      const occupant = base.get(ref.number) as MigrationRef;
      out.push({
        app,
        app_label: ref.app_label,
        pr_path: ref.path,
        number: ref.number,
        base_path: occupant.path,
        target_number: targetNumber,
        target_path: target.path,
        dependency_name: dependencyName,
        dependency: `("${ref.app_label}", "${dependencyName}")`,
        kind: "base-collision",
      });
      renamed.set(`${ref.digits}_${ref.name}`, { name: target.name, number: targetNumber });
      // Two colliding migrations in one app renumber into a chain: the second
      // depends on the first's new name, not on the base leaf.
      dependencyName = target.name;
    }

    // Follow-ups: a later PR migration in the same app whose
    // `dependencies` reference a migration the remedy just renamed. Its
    // dependency entry must move to the new name — and if its own number now
    // sits at or below its renumbered dependency, it must renumber too (which
    // may cascade onto migrations depending on it, hence the loop in number
    // order and the `renamed` map growing as it goes).
    for (const { ref, patch } of ordered) {
      if (collidingPaths.has(ref.path)) continue;
      // Same-app dependencies are `(app_label, name)` tuples too; a bare-name
      // match must not take another app's identically named migration.
      const stales = [...renamed.keys()].filter((old) =>
        referencesOwnMigration(patch, ref.app_label, old, knownLabels),
      );
      if (stales.length === 0) continue;
      const deps = stales.map((stale) => renamed.get(stale) as { name: string; number: number });
      // With the free-number policy above (targets sit above every number
      // either side uses) a follow-up is always at or below its renumbered
      // dependency, so today this is always true; the conditional keeps the
      // remedy correct if the target policy ever tightens.
      const mustRenumber = deps.some((dep) => ref.number <= dep.number);
      const targetNumber = mustRenumber ? next++ : ref.number;
      const target = mustRenumber
        ? renamedTo(ref, targetNumber)
        : { name: `${ref.digits}_${ref.name}`, path: ref.path };
      // One entry per stale dependency, so every stale tuple gets its own
      // replacement; the rename rides the first entry only.
      stales.forEach((stale, i) => {
        const dep = deps[i] as { name: string; number: number };
        out.push({
          app,
          app_label: ref.app_label,
          pr_path: ref.path,
          number: ref.number,
          base_path: "",
          target_number: targetNumber,
          target_path: target.path,
          dependency_name: dep.name,
          dependency: `("${ref.app_label}", "${dep.name}")`,
          kind: "renamed-dependency",
          stale_dependency: stale,
          renumber: mustRenumber && i === 0,
        });
      });
      if (mustRenumber)
        renamed.set(`${ref.digits}_${ref.name}`, { name: target.name, number: targetNumber });
    }
    renamedByApp.set(app, { app_label: colliding[0]!.ref.app_label, renamed });
  }

  // Cross-app follow-ups: a PR migration in another app whose `dependencies`
  // name a migration the remedy renames. Numbers are per app, so it never
  // renumbers — only its dependency tuple moves.
  if (renamedByApp.size > 0) {
    for (const [app, entries] of [...prByApp].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))) {
      const ordered = [...entries].sort(
        (a, b) => a.ref.number - b.ref.number || (a.ref.path < b.ref.path ? -1 : 1),
      );
      // Every PR file, including one the same-app pass already remedied: its
      // own-app entry moving says nothing about a stale tuple naming another
      // app. One entry per stale tuple, across every renamed app.
      for (const { ref, patch } of ordered) {
        for (const [otherApp, { app_label, renamed }] of renamedByApp) {
          if (otherApp === app) continue;
          for (const [stale, dep] of renamed) {
            if (!referencesAppMigration(patch, app_label, stale)) continue;
            out.push({
              app,
              app_label: ref.app_label,
              pr_path: ref.path,
              number: ref.number,
              base_path: "",
              target_number: ref.number,
              target_path: ref.path,
              dependency_name: dep.name,
              dependency: `("${app_label}", "${dep.name}")`,
              kind: "renamed-dependency",
              stale_dependency: stale,
              renumber: false,
              dependency_app_label: app_label,
            });
          }
        }
      }
    }
  }
  return out;
}

/** Stable identity of a detection result — used to post the comment once per
 * (head sha, collision set) rather than on every round at the same head. */
export function collisionFingerprint(headSha: string, collisions: MigrationCollision[]): string {
  return [headSha, ...collisions.map((c) => `${c.pr_path}→${c.target_path}@${c.dependency}`)].join(
    "|",
  );
}

export interface CollisionCommentInput {
  collisions: MigrationCollision[];
  base_ref: string;
  base_sha: string;
}

/**
 * The comment body. It states the exact target number and the exact
 * `dependencies` value, and says in plain words that this is mechanics — no
 * blocker, no verdict consumed, no re-review round owed. Filename-derived
 * fields are the PR author's and render through `codePath` (see
 * `renderMigrationCollisionsNote`).
 */
export function renderMigrationCollisionComment(input: CollisionCommentInput): string {
  const branch = input.base_ref || "the base branch";
  const at = input.base_sha ? ` (\`${input.base_sha.slice(0, 12)}\`)` : "";
  const subject =
    input.collisions.length === 1
      ? "the migration number this PR claims"
      : "migration numbers this PR claims";
  const lines: string[] = [
    "### Migration numbering — renumber needed (mechanics, not a blocker)",
    "",
    `\`${branch}\`${at} already occupies ${subject}. GitHub still reports the PR mergeable ` +
      "(the filenames differ) and CI is green, so nothing else catches this — but the " +
      "migration graph would break on merge.",
    "",
  ];
  for (const c of input.collisions) {
    if (c.kind === "renamed-dependency") {
      const stale = c.stale_dependency ?? "";
      lines.push(
        `- ${codePath(c.pr_path)} — its \`dependencies\` reference ${codePath(`"${stale}"`)}, which the renumber above moves to ${codePath(c.dependency_name)}.`,
        `  - in its \`dependencies\`, replace ${codePath(`("${c.dependency_app_label ?? c.app_label}", "${stale}")`)} with ${codePath(c.dependency)} — keep every other entry`,
      );
      if (c.renumber)
        lines.push(
          `  - and rename it to ${codePath(c.target_path)} (number **${String(c.target_number).padStart(4, "0")}**) — its current number would sit below its renumbered dependency`,
        );
      continue;
    }
    lines.push(
      `- ${codePath(c.pr_path)} collides with ${codePath(c.base_path)} on ${flatControls(branch)}.`,
      `  - rename it to ${codePath(c.target_path)} (number **${String(c.target_number).padStart(4, "0")}**)`,
      `  - in its \`dependencies\`, point its ${codePath(c.app_label)} entry at ${codePath(c.dependency)} — keep every other entry`,
    );
  }
  lines.push(
    "",
    "This is posted as a comment on purpose: the fix is mechanical, it consumes no " +
      "review verdict and it does not block the merge gate. Nothing else in this " +
      "round's review depends on it.",
  );
  return lines.join("\n");
}
