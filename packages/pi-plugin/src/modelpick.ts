// The pick inside one provider: which of its models a review runs on when
// nothing pins one. The rule is "the newest version, guarded":
//
//   1. the candidates are the provider's models that reason and have a
//      window a review fits in, with the variants of a family folded into
//      its base id;
//   2. the first candidate by version number read from the id, then list
//      price, then window, is the newest;
//   3. when the newest is priced far below pi's own default for the
//      provider, pi's default stands instead: a small tier can carry the
//      highest number in a catalog, and pi's default is the one outside
//      reference for "the model this provider is used for".
//
// Everything here is read from catalog metadata: an id's shape, a price, a
// window, a flag. No model, family or provider is named, and none may be:
// a name written here is a rule about one vendor, and it is wrong the day
// that vendor ships the next model.
//
// A leaf on purpose, with no imports: it is read wherever a model id has to
// be ranked or recognised, and none of those readers should pull anything
// else in with it.

/** A review does not fit a smaller window. */
export const CONTEXT_FLOOR = 128_000;

/** The newest version stands unless its list price is below this share of
 * the price of pi's default. Small tiers are priced at a twentieth to a
 * fifth of their flagship and a newer flagship at a third or more of the
 * older one, so a quarter separates the two with room on both sides. */
export const GUARD_RATIO = 0.25;

/** What the rule reads of a model: a structural subset of pi's own model
 * type, so a catalog entry, an inventory row and a test literal all fit. */
export interface PickableModel {
  id: string;
  reasoning?: boolean;
  contextWindow?: number;
  /** USD per million tokens. */
  cost?: { input?: number; output?: number };
}

/** `[major, minor]` as read from a model id. */
export type ModelVersion = [major: number, minor: number];

export interface ModelPick<M> {
  /** The model that runs. */
  model: M;
  /** `newest`: the rule's first candidate. `pi-default`: pi's own default
   * for the provider stood, through the guard or for want of a candidate. */
  pick: "newest" | "pi-default";
  /** The rule's first candidate, or null when no model passes the filter.
   * It differs from `model` exactly when the guard fired. */
  newest: M | null;
  /** The guard fired: `newest` is priced below `GUARD_RATIO` of pi's
   * default, so the default runs. */
  guarded: boolean;
}

/** A price or a window the rule can compare: a finite number above zero,
 * else zero, so one bad catalog field cannot make the order depend on the
 * input order or put a price below "no price". */
function amount(n: number | undefined): number {
  return typeof n === "number" && Number.isFinite(n) && n > 0 ? n : 0;
}

/** The id's last path segment with its `:suffix` cut, lowercased: the part
 * that names the model once the vendor path (`vendor/name`,
 * `accounts/host/models/name`) and a routing or release suffix (`:free`,
 * `:0`) are gone. */
export function leafOf(id: string): string {
  const s = id.toLowerCase();
  const tail = s.slice(s.lastIndexOf("/") + 1);
  const colon = tail.indexOf(":");
  return colon > 0 ? tail.slice(0, colon) : tail;
}

// A dotted vendor prefix in front of the name: `region.vendor.name-…`.
const VENDOR_PREFIX = /^(?:[a-z][a-z0-9]*\.)+(?=[a-z])/;
// A dashed date, with or without the day: `2025-04-16`, `2025-04`.
const YEAR_FIRST_DATE = /(?:19|20)\d{2}-\d{2}(?:-\d{2})?/g;
// A dashed month and year: `09-2025`.
const MONTH_YEAR_DATE = /\b\d{2}-(?:19|20)\d{2}\b/g;
// A size: a parameter count or a window (`20b`, `32k`, `1m`, `1t`, `a12b`).
// It is tested before VERSION because a short one has a version's shape.
const SIZE = /^[a-z]?\d+(?:\.\d+)?[bkmt]$/;
// A version: one or two digits with no leading zero, an optional `.n`,
// letters glued in front and at most one behind (`6.1`, `4o`, `o3`, `k2.6`,
// `v4`, `name3.7`). The whole token has to fit, which is what keeps out a
// date or a build (three or more digits: `2509`, `0125`, `20250929`), a
// leading zero (`08`) and a mixture shape (`8x7b`).
const VERSION = /^[a-z]*?([1-9]\d?)(?:\.(\d{1,2}))?[a-z]?$/;
// The token after an undotted version, when it is its minor (`name-5-5`).
const MINOR = /^(?:0|[1-9]\d?)$/;
// A dotted token from this major up with a minor of 1 to 12 is a year and a
// month (`26.10`, `25.08`): a release date, not a version to rank by.
const CALENDAR_MAJOR = 20;

/** The version an id carries, or null when it carries none (an alias, a
 * name with only a size or a date). The first token that reads as a version
 * is the version: what comes later (`-v1`, a revision) is not. */
export function versionOf(id: string): ModelVersion | null {
  const name = leafOf(id)
    .replace(VENDOR_PREFIX, "")
    .replace(YEAR_FIRST_DATE, " ")
    .replace(MONTH_YEAR_DATE, " ");
  const tokens = name.split(/[-_ ]+/).filter((t) => t !== "");
  for (const [i, token] of tokens.entries()) {
    if (SIZE.test(token)) continue;
    const m = VERSION.exec(token);
    if (m === null) continue;
    const major = Number(m[1]);
    if (m[2] !== undefined) {
      const minor = Number(m[2]);
      if (major >= CALENDAR_MAJOR && minor >= 1 && minor <= 12) continue;
      return [major, minor];
    }
    const next = tokens[i + 1];
    return [major, next !== undefined && MINOR.test(next) ? Number(next) : 0];
  }
  return null;
}

/** USD per million tokens, input plus output: the one number the rule
 * compares prices by. Zero when pi has no price for the model. */
export function listPrice(m: PickableModel): number {
  return amount(m.cost?.input) + amount(m.cost?.output);
}

/** Versioned before versionless, then major and minor descending. Negative
 * when `a` ranks first. */
export function compareVersions(a: ModelVersion | null, b: ModelVersion | null): number {
  if (a === null || b === null) return a === b ? 0 : a === null ? 1 : -1;
  return a[0] !== b[0] ? b[0] - a[0] : b[1] - a[1];
}

/** A model with what the rule reads off its id, read once. */
interface Ranked<M> {
  model: M;
  leaf: string;
  version: ModelVersion | null;
}

function rank<M extends PickableModel>(model: M): Ranked<M> {
  return { model, leaf: leafOf(model.id), version: versionOf(model.id) };
}

function compareRanked<M extends PickableModel>(
  a: Ranked<M>,
  b: Ranked<M>,
  piDefaultId: string | undefined,
): number {
  const byVersion = compareVersions(a.version, b.version);
  if (byVersion !== 0) return byVersion;
  const byPrice = listPrice(b.model) - listPrice(a.model);
  if (byPrice !== 0) return byPrice;
  const byWindow = amount(b.model.contextWindow) - amount(a.model.contextWindow);
  if (byWindow !== 0) return byWindow;
  // The last two make the order total without reading a meaning into an id:
  // between equals pi's own default goes first, then the id decides.
  const aDefault = a.model.id === piDefaultId;
  if (piDefaultId !== undefined && aDefault !== (b.model.id === piDefaultId))
    return aDefault ? -1 : 1;
  return a.model.id < b.model.id ? -1 : a.model.id > b.model.id ? 1 : 0;
}

/** The order the newest is first in: versioned before versionless, major
 * then minor descending, list price descending, window descending, pi's
 * default for the provider before any other id, id ascending. Total: two
 * models compare equal only when their ids are equal. */
export function compareModels(a: PickableModel, b: PickableModel, piDefaultId?: string): number {
  return compareRanked(rank(a), rank(b), piDefaultId);
}

/** A model the rule may pick: it reasons, and a review fits its window. */
export function isCandidate(m: PickableModel): boolean {
  return m.reasoning === true && amount(m.contextWindow) >= CONTEXT_FLOOR;
}

/** Drop a model whose leaf is another's leaf plus `-suffix` at the same
 * version: a speed tier, a sibling, a dated snapshot. The base id stands
 * for the family. Without this the price tie-break picks the speed tier
 * wherever one exists, since it is the same version at a higher price. */
function withoutVariants<M>(ranked: readonly Ranked<M>[]): Ranked<M>[] {
  return ranked.filter(
    (mine) =>
      !ranked.some(
        (base) =>
          mine.leaf.startsWith(`${base.leaf}-`) &&
          compareVersions(mine.version, base.version) === 0,
      ),
  );
}

/** One provider's candidates, the newest first. `piDefaultId` only breaks
 * a tie between models that are equal in everything the rule ranks by. */
export function candidatesOf<M extends PickableModel>(
  models: readonly M[],
  piDefaultId?: string,
): M[] {
  return withoutVariants(models.filter(isCandidate).map(rank))
    .sort((a, b) => compareRanked(a, b, piDefaultId))
    .map((r) => r.model);
}

/** The model a review runs on at one provider, or null when the provider
 * has none the rule can pick.
 *
 * `models` is the provider's whole list; `piDefaultId` is pi's default id
 * for it, undefined when pi names none. The default is looked up in the
 * whole list, not only among the candidates: it is the reference the guard
 * prices against, and the fallback when nothing passes the filter (pi
 * clamps a thinking level the model cannot run). A default pi has no price
 * for cannot guard: no price is below a share of zero. */
export function pickModel<M extends PickableModel>(
  models: readonly M[],
  piDefaultId?: string,
): ModelPick<M> | null {
  const newest = candidatesOf(models, piDefaultId)[0];
  const def = piDefaultId === undefined ? undefined : models.find((m) => m.id === piDefaultId);
  if (newest === undefined)
    return def === undefined
      ? null
      : { model: def, pick: "pi-default", newest: null, guarded: false };
  if (def === undefined || def.id === newest.id)
    return { model: newest, pick: "newest", newest, guarded: false };
  if (listPrice(newest) < GUARD_RATIO * listPrice(def))
    return { model: def, pick: "pi-default", newest, guarded: true };
  return { model: newest, pick: "newest", newest, guarded: false };
}
