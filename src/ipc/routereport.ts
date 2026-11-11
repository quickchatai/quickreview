// The model route a worker reports, as the daemon keeps it.
//
// A worker resolves which model its command runs on (src/botworker.ts, over
// pi). The daemon never asks pi anything: it learns the route from the
// worker's `ready` event, as data. This module is that data: its shape, its
// check, the test for "the route changed", and the words the daemon's
// surfaces print for it. Neutral like the rest of src/ipc/: no engine, no pi,
// no state store.
//
// The values are the route's own (packages/pi-plugin/src/modelroute.ts:
// `RouteSource`, `ModelRoute.pick`, `CredentialOrigin`), carried as strings. A
// value this build does not know is kept and shown as written, never dropped
// and never folded to one it does know.
//
// Unknown is its own answer. A report that is missing or does not check is
// no report: nothing is recorded for it, and a reader with no record says
// `unknown`, never a model it assumes.

/** What a worker says of its route in `ready`. */
export interface RouteReport {
  /** `provider/id`, never a level. */
  spec: string;
  /** Why this route: the pin, the remembered choice, the order. */
  source: string;
  /** How the model was picked on its provider. */
  pick: string;
  /** The provider the pin named, when the run moved off it; else null. */
  moved_from: string | null;
  /** Where pi found the provider's credential. */
  credential_origin: string;
}

/** A report as the daemon keeps and publishes it: with when it arrived. */
export interface RouteRecord extends RouteReport {
  /** When the daemon took the report, ISO. */
  at: string;
}

/** The longest text a report's field may hold. */
export const ROUTE_REPORT_TEXT_MAX = 256;

const CONTROL_RE = /[\u0000-\u001f\u007f-\u009f]/;

/** A report's text field: non-empty, bounded, one printable line. */
function field(x: unknown): string | null {
  if (typeof x !== "string" || x === "" || x.length > ROUTE_REPORT_TEXT_MAX) return null;
  return CONTROL_RE.test(x) ? null : x;
}

/** The report of a resolved route. Takes the route's own fields, so the
 * worker hands it what pi's host resolved and nothing is retyped. */
export function routeReportOf(route: {
  spec: string;
  source: string;
  pick: string;
  movedFrom: string | null;
  credential: { origin: string };
}): RouteReport {
  return {
    spec: route.spec,
    source: route.source,
    pick: route.pick,
    moved_from: route.movedFrom,
    credential_origin: route.credential.origin,
  };
}

/** A report off the wire or out of a stored row, checked; null when it is
 * not one. Fields it does not know are left behind. */
export function parseRouteReport(raw: unknown): RouteReport | null {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) return null;
  const o = raw as Record<string, unknown>;
  const spec = field(o["spec"]);
  const source = field(o["source"]);
  const pick = field(o["pick"]);
  const origin = field(o["credential_origin"]);
  if (spec === null || source === null || pick === null || origin === null) return null;
  const moved = o["moved_from"];
  let movedFrom: string | null = null;
  if (moved !== null && moved !== undefined) {
    movedFrom = field(moved);
    if (movedFrom === null) return null;
  }
  return { spec, source, pick, moved_from: movedFrom, credential_origin: origin };
}

/** A kept report (status.json `model_route`, a stored row), checked; null
 * when it is absent or cannot be read. */
export function parseRouteRecord(raw: unknown): RouteRecord | null {
  const report = parseRouteReport(raw);
  if (report === null) return null;
  const at = field((raw as Record<string, unknown>)["at"]);
  return at === null ? null : { ...report, at };
}

/** Do reviews run somewhere else now: another model, another provider the
 * pin was moved off, or a credential pi found somewhere else. Why the route
 * was chosen and how the model was picked are not a change by themselves. */
export function routeReportChanged(prev: RouteReport, next: RouteReport): boolean {
  return (
    prev.spec !== next.spec ||
    prev.moved_from !== next.moved_from ||
    prev.credential_origin !== next.credential_origin
  );
}

const SOURCE_WORDS: ReadonlyMap<string, string> = new Map([
  ["flag", "pinned by --model"],
  ["config", "pinned by [models] model"],
  ["choice", "chosen with qcr model use"],
  ["remembered", "the provider picked when asked"],
  ["only-credential", "the one provider pi has a credential for"],
  ["pi-provider", "the provider pi itself starts on"],
  ["credential-order", "first of several providers by their credentials"],
]);

/** Why the route is what it is, in a phrase; a source this build does not
 * know is shown as written. */
export function routeSourceWords(source: string): string {
  return SOURCE_WORDS.get(source) ?? source;
}

const ORIGIN_WORDS: ReadonlyMap<string, string> = new Map([
  ["stored", "a login or key stored in pi"],
  ["runtime", "a key handed to pi for the run"],
  ["models-json", "a key in pi's models.json"],
  ["env-key", "an environment key"],
  ["ambient", "an ambient cloud credential"],
]);

/** Where the credential comes from, in a phrase; an origin this build does
 * not know is shown as written. */
export function credentialOriginWords(origin: string): string {
  return ORIGIN_WORDS.get(origin) ?? origin;
}

/** What an operator is told when the route changed: where reviews run now,
 * where they ran, the move when there is one, and what to do about it. */
export function routeChangeText(prev: RouteReport, next: RouteReport): string {
  const moved =
    next.moved_from !== null
      ? ` The config names ${next.moved_from}, which has no credential.`
      : "";
  return (
    `reviews now run on ${next.spec} (${credentialOriginWords(next.credential_origin)}); ` +
    `they ran on ${prev.spec} (${credentialOriginWords(prev.credential_origin)}).${moved} ` +
    "Pin it with [models] model, or check the login."
  );
}

/**
 * The `model:` line of `qcr status`, off status.json's `model_route` block as
 * it was read (any JSON). A block that is absent (a daemon that does not
 * report it), null (no worker has reported yet) or unreadable is `unknown`,
 * each with its reason: never a model nobody reported.
 */
export function modelRouteLine(block: unknown): string {
  if (block === undefined)
    return "model: unknown (this daemon does not report the model reviews run on)";
  if (block === null) return "model: unknown (no worker has reported the model it ran on yet)";
  const route = parseRouteRecord(block);
  if (route === null) return "model: unknown (unreadable model_route block)";
  const moved =
    route.moved_from !== null
      ? `, moved off ${route.moved_from}, which the config names and which has no credential`
      : "";
  return `model: ${route.spec} (${routeSourceWords(route.source)})${moved}; last reported ${route.at}`;
}
