// Where a repo profile is found, given the places to look. Pure over its
// inputs: the profile directories outside the checkout (the install's homes)
// are an explicit argument, resolved by the caller (src/homes.ts
// `homeProfilePlaces` from the environment), so the review core never reads
// the environment or a home itself.
//
// The search order (the first place that holds the profile wins):
//   1. the install's config home — `<home>/profiles/`
//   2. `profiles/` beside `$QCR_CONFIG`, when it is set (the compose route's
//      mounted config home; the VM's shipped one; the bench image's)
//   3. the checkout's `profiles/` — the generic examples only
// Places 1 and 2 are the caller's `homes`; place 3 is `<root>/profiles`.
import { statSync } from "node:fs";
import { join } from "node:path";

/** A single path segment an install or a profile may be named by.
 * No separators, no leading dot, so `..` and `a/../../b` are unspellable. */
const SEGMENT_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;

/** Whether `name` is a plain path segment — the one admission rule behind
 * `assertPathSegment` and every listing that skips what it would refuse. */
export function isPathSegment(name: string): boolean {
  return SEGMENT_RE.test(name) && !name.includes("..");
}

/** Refuse a name that could escape its parent directory. `kind` names what the
 * segment is for, so the error says which knob is wrong. */
export function assertPathSegment(kind: string, name: string): string {
  if (!isPathSegment(name)) {
    throw new Error(
      `${kind} ${JSON.stringify(name)} is not a plain name — letters, digits, '.', '_' and '-' only, no path separators or '..'`,
    );
  }
  return name;
}

/** The directory, in every home, that holds one subdirectory per profile. */
export const PROFILES_DIR = "profiles";

/**
 * The checkout's generic profiles — the ones that belong to the app, not to
 * any install: the examples, and `default`, the shipped behaviour every
 * generated profile extends. They are the only profiles the lookup reads
 * from the checkout. Any other directory under the checkout's `profiles/` is
 * an install's own profile stranded in its old place: never read, and
 * `qcr install migrate` moves it into the config home. A new example is
 * registered here (a test holds the checkout to it, and the shell mirror's
 * `QCR_EXAMPLE_PROFILES` to this list).
 */
export const EXAMPLE_PROFILES: readonly string[] = [
  "default",
  "example-django",
  "minimal",
  "snappy",
  "fast",
];

/** Which search place a profile was found in. */
export type ProfileSource = "home" | "override" | "checkout";

/** One place profiles are looked up in. */
export interface ProfilePlace {
  dir: string;
  source: ProfileSource;
}

/** Every search place, in order, deduplicated (the first place a directory
 * is reached by names its source): the `homes`, then the checkout's. */
export function profileSearchPlaces(root: string, homes: readonly ProfilePlace[]): ProfilePlace[] {
  const places: ProfilePlace[] = [...homes, { dir: join(root, PROFILES_DIR), source: "checkout" }];
  return places.filter((p, i) => places.findIndex((q) => q.dir === p.dir) === i);
}

export interface LocatedProfile {
  name: string;
  dir: string;
  source: ProfileSource;
}

export function isDirectory(path: string): boolean {
  try {
    return statSync(path).isDirectory();
  } catch {
    return false;
  }
}

/**
 * Find the named profile: the first search place that holds it as a
 * directory — the checkout only for a generic example — or `null` when none
 * does (each loader words its own not-found). The name is a plain path
 * segment or a throw — `../x`, `a/b` and kin never reach a join.
 */
export function findProfile(opts: {
  root: string;
  profile: string;
  homes: readonly ProfilePlace[];
  isDir?: (path: string) => boolean;
}): LocatedProfile | null {
  const name = assertPathSegment("profile", opts.profile);
  const isDir = opts.isDir ?? isDirectory;
  for (const place of profileSearchPlaces(opts.root, opts.homes)) {
    if (place.source === "checkout" && !EXAMPLE_PROFILES.includes(name)) continue;
    const dir = join(place.dir, name);
    if (isDir(dir)) return { name, dir, source: place.source };
  }
  return null;
}

/**
 * The checkout's `profiles/<name>` when it is an install's own profile left
 * there (not a generic example) — stranded, never read. Only for a
 * not-found to name `qcr install migrate`; null when there is none, or when
 * one of the `homes` is the checkout's `profiles/` (then it was read).
 */
export function strandedProfile(opts: {
  root: string;
  profile: string;
  homes: readonly ProfilePlace[];
}): string | null {
  const name = assertPathSegment("profile", opts.profile);
  if (EXAMPLE_PROFILES.includes(name)) return null;
  const checkout = join(opts.root, PROFILES_DIR);
  if (
    !profileSearchPlaces(opts.root, opts.homes).some(
      (p) => p.dir === checkout && p.source === "checkout",
    )
  )
    return null;
  const dir = join(checkout, name);
  return isDirectory(dir) ? dir : null;
}
