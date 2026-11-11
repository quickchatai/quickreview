// What a review's price is known from.
//
// The review's estimate is a fit to recorded reviews, and a fit is true of
// what it was measured on: one model, at one rate card, through the API
// family whose prompt cache gave the recorded token mix. That measurement is
// data, and it is all here (`MEASURED`). A run shows the fitted estimate only
// when every model it uses is that model at those rates through that family
// (`isMeasured`); a repo that sets its own rates gets an estimate at those
// rates on any model. Everything else has no estimate, and says which of two
// things is missing (`priceBasis`): the measurement (`unmeasured`: pi has a
// list price, so a spend limit holds the run) or the price itself
// (`unpriced`: pi counts no cost, so no dollar figure can hold it).
//
// This is the one file in product code that names a model: the name is part
// of the measurement, not a rule about which model runs.
import { leafOf } from "./modelpick.js";
import type { CatalogModel, ProviderInventory } from "./modelroute.js";
import { splitModelSpec } from "./reviewconfig.js";

/** The estimate fitted to 295 recorded reviews. True for one model, on the
 * API family and at the rate card it was measured with
 * (tests/fixtures/review-cost/recorded.json): the median review is off by
 * about a fifth, the sum by 1%, and no recorded review cost more than twice
 * its estimate. `rates` are dollars per million tokens; `usd_base` is what a
 * review costs before any lens runs, `usd_per_lens` what one planned lens
 * costs whatever the diff, `usd_per_kline` what the diff adds per thousand
 * changed lines, once. */
export const MEASURED = {
  model_id: "gpt-6.1-sol",
  apis: ["openai-responses", "openai-codex-responses", "azure-openai-responses"],
  rates: { input: 2, cacheRead: 0.1, output: 10 },
  usd_base: 0.1,
  usd_per_lens: 0.125,
  usd_per_kline: 1.85,
} as const;

/** Is `m` the measured model: its id, its three rates and its API family? */
function measuredModel(m: CatalogModel): boolean {
  return (
    leafOf(m.id) === MEASURED.model_id &&
    m.api !== undefined &&
    (MEASURED.apis as readonly string[]).includes(m.api) &&
    m.cost?.input === MEASURED.rates.input &&
    m.cost?.cacheRead === MEASURED.rates.cacheRead &&
    m.cost?.output === MEASURED.rates.output
  );
}

/** Does the fitted estimate hold for a run on `models`: every model the run
 * uses (the main session's and each tier's, as they will run) is the
 * measured one. An empty list is not measured: nothing is known of it. */
export function isMeasured(models: readonly CatalogModel[]): boolean {
  return models.length > 0 && models.every(measuredModel);
}

/** The catalog model a spec as it will run (`provider/id`, with or without a
 * `:level`) names, among the providers pi has a credential for. Undefined for
 * a spec that names no provider, a provider with no credential here, or an id
 * pi's catalog does not hold (a custom id is sent as written, and nothing is
 * known of its rates). */
export function catalogModelOf(
  spec: string,
  inventory: readonly ProviderInventory[],
): CatalogModel | undefined {
  const { model } = splitModelSpec(spec);
  const at = model.indexOf("/");
  if (at <= 0) return undefined;
  const provider = model.slice(0, at);
  const id = model.slice(at + 1);
  return inventory.find((e) => e.provider === provider)?.models.find((m) => m.id === id);
}

/** Does the fitted estimate hold for a run on `specs` (each as it will run),
 * read against the providers pi has a credential for? */
export function specsMeasured(
  specs: readonly string[],
  inventory: readonly ProviderInventory[],
): boolean {
  const models: CatalogModel[] = [];
  for (const spec of specs) {
    const model = catalogModelOf(spec, inventory);
    if (model === undefined) return false;
    models.push(model);
  }
  return isMeasured(models);
}

/** A credentialed provider's spec for the measured model, when one serves it:
 * what a run with no estimate may be pointed at. The first in the
 * inventory's own order; null when none does. */
export function measuredSpec(inventory: readonly ProviderInventory[]): string | null {
  for (const entry of inventory) {
    const model = entry.models.find(measuredModel);
    if (model !== undefined) return `${entry.provider}/${model.id}`;
  }
  return null;
}

/**
 * What a review's price is known from:
 *  - `unknown`: no route resolves, so nothing is known of the model;
 *  - `repo`: the repo sets rates of its own, which price any model;
 *  - `measured`: every model the run uses is the measured one;
 *  - `unpriced`: pi has no list price for the route's model;
 *  - `unmeasured`: pi prices the model and no estimate was fitted to it (a
 *    custom id included).
 *
 * A host that resolves no route of its own (`route` undefined) hands the
 * core no catalog either, so nothing here can tell its model from the
 * measured one: the fitted estimate stands for it, as it did before a review
 * knew its route, and the stop at twice that estimate is the tighter of the
 * two a run could get. Both shipped hosts (`qcr review` and /qcr-review)
 * always resolve one.
 */
export type PriceBasis = "unknown" | "repo" | "measured" | "unpriced" | "unmeasured";

export const PRICE_BASES: readonly PriceBasis[] = [
  "unknown",
  "repo",
  "measured",
  "unpriced",
  "unmeasured",
];

export function priceBasis(o: {
  /** The run's route. Null: none resolves. Undefined: the host resolved none
   * of its own, and the run is on whatever the config pins: `measured`. */
  route: { priced: boolean } | null | undefined;
  /** The repo sets a rate of its own (`.git/qcr-review.json`). */
  repoRates: boolean;
  /** Every spec the run will use, as it will run. */
  specs: readonly string[];
  inventory: readonly ProviderInventory[];
}): PriceBasis {
  if (o.route === null) return "unknown";
  if (o.repoRates) return "repo";
  if (o.route === undefined) return "measured";
  if (specsMeasured(o.specs, o.inventory)) return "measured";
  return o.route.priced ? "unmeasured" : "unpriced";
}

/** What is known of one provider's price before a review on it, in the two
 * or three words a row of choices has room for. */
export type PriceKnowledge = "measured estimate" | "no estimate" | "no list price";

export function priceKnowledge(
  x: { provider: string; modelId: string; priced: boolean },
  inventory: readonly ProviderInventory[],
): PriceKnowledge {
  if (!x.priced) return "no list price";
  const model = inventory
    .find((e) => e.provider === x.provider)
    ?.models.find((m) => m.id === x.modelId);
  return model !== undefined && isMeasured([model]) ? "measured estimate" : "no estimate";
}
