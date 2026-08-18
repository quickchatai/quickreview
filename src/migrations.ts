// Django migration-number collision pre-check. Pure functions: the
// caller supplies the PR's changed files and the migration paths that exist on
// the base branch at the round's `base_sha`; this module decides whether the PR
// occupies a number the base already took, and writes the remedy.
//
// Why it lives daemon-side rather than in a lens: a leaf-node collision with
// the base branch is deterministic, machine-checkable without an LLM, has
// exactly one remedy (renumber + repoint `dependencies`) and carries no design
// content. Raised as a blocker it consumed the merge gate and cost the author a
// full re-review round for a mechanical rename — ~15% of all blockers. Nothing
// else in the pipeline catches it (GitHub reports MERGEABLE because the
// filenames differ, and CI is green), so the check does not get quieter here:
// it runs every round, deterministically, and is delivered as a COMMENT.
//
// This is NOT a trivial-delta classifier (owns that) — detection and
// comment text only.

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

/** A PR migration whose number is already taken on the base branch. */
export interface MigrationCollision {
  app: string;
  app_label: string;
  /** The PR file that must be renamed. */
  pr_path: string;
  /** The number both sides claim. */
  number: number;
  /** The base-branch migration sitting on that number. */
  base_path: string;
  /** Free number the PR migration must move to. */
  target_number: number;
  /** Path the PR migration must move to. */
  target_path: string;
  /** Migration the renumbered file must depend on (name, no extension). */
  dependency_name: string;
  /** The exact `dependencies` entry to write. */
  dependency: string;
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
   * filename and optionally a status). */
  files: Array<{ filename: string; status?: string }>;
  /** Every migration path present on the base branch at `base_sha`. */
  baseFiles: string[];
}

/**
 * Migration numbers this PR claims that the base branch already occupies.
 *
 * A collision is "same app, same number, different file" — a PR file that
 * merely EDITS a migration already on the base (same path) is not one. Deleted
 * PR files are ignored. Collisions are returned in path order per app, and the
 * assigned target numbers form a chain: the first renumbered migration in an
 * app depends on the base branch's leaf, each later one on its predecessor.
 */
export function detectMigrationCollisions(input: CollisionInput): MigrationCollision[] {
  const baseByApp = new Map<string, Map<number, MigrationRef>>();
  for (const path of input.baseFiles) {
    const ref = parseMigrationPath(path);
    if (!ref) continue;
    const byNumber = baseByApp.get(ref.app) ?? new Map<number, MigrationRef>();
    // A base tree cannot legitimately hold two migrations on one number; if it
    // somehow does, the higher path wins deterministically.
    const prev = byNumber.get(ref.number);
    if (!prev || prev.path < ref.path) byNumber.set(ref.number, ref);
    baseByApp.set(ref.app, byNumber);
  }

  const prByApp = new Map<string, MigrationRef[]>();
  for (const f of input.files) {
    if (f.status === "removed") continue;
    const ref = parseMigrationPath(f.filename);
    if (!ref) continue;
    prByApp.set(ref.app, [...(prByApp.get(ref.app) ?? []), ref]);
  }

  const out: MigrationCollision[] = [];
  for (const [app, refs] of [...prByApp].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))) {
    const base = baseByApp.get(app) ?? new Map<number, MigrationRef>();
    const ordered = [...refs].sort((a, b) => a.number - b.number || (a.path < b.path ? -1 : 1));
    const colliding = ordered.filter((r) => {
      const occupant = base.get(r.number);
      return occupant !== undefined && occupant.path !== r.path;
    });
    if (colliding.length === 0) continue;

    // Free numbers start above everything either side already uses, so the
    // remedy never collides with a sibling migration in the same PR.
    const used = [...base.keys(), ...ordered.map((r) => r.number)];
    let next = Math.max(...used) + 1;
    // The chain root is the base branch's leaf — the highest number the base
    // holds for this app, which is what the renumbered migration must depend on.
    const baseLeaf = [...base.values()].sort((a, b) => a.number - b.number).pop();
    let dependencyName = baseLeaf ? `${baseLeaf.digits}_${baseLeaf.name}` : "";
    for (const ref of colliding) {
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
      });
      // Two colliding migrations in one app renumber into a chain: the second
      // depends on the first's NEW name, not on the base leaf.
      dependencyName = target.name;
    }
  }
  return out;
}

/** Stable identity of a detection result — used to post the comment once per
 * (head sha, collision set) rather than on every round at the same head. */
export function collisionFingerprint(headSha: string, collisions: MigrationCollision[]): string {
  return [headSha, ...collisions.map((c) => `${c.pr_path}→${c.target_path}@${c.dependency}`)].join("|");
}

export interface CollisionCommentInput {
  collisions: MigrationCollision[];
  base_ref: string;
  base_sha: string;
}

/**
 * The COMMENT body. It states the exact target number and the exact
 * `dependencies` value, and says in plain words that this is mechanics — no
 * blocker, no verdict consumed, no re-review round owed.
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
    lines.push(
      `- \`${c.pr_path}\` collides with \`${c.base_path}\` on ${branch}.`,
      `  - rename it to \`${c.target_path}\` (number **${String(c.target_number).padStart(4, "0")}**)`,
      `  - set its \`dependencies\` to \`[${c.dependency}]\``,
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
