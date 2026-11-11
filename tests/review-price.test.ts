// What a review's price is known from (packages/pi-plugin/src/measured.ts)
// and what a caller on an older contract is told of it
// (packages/pi-plugin/src/contract.ts, localreview.ts `reviewForContract`).
//
// The fitted estimate is true of one model, at one rate card, through one API
// family. Every case here is a catalog row a test writes: the measured row is
// built from `MEASURED` itself, and each other row differs from it in the one
// thing the case is about. No pi, no file and no process is touched; the
// review pipeline's own cases (the preview line, the stop, the question) are
// in tests/review-api.test.ts.
import { describe, expect, it } from "vitest";
import {
  CONTRACTS,
  REVIEW_SCHEMA_VERSION,
  reviewVersionFor,
  supportedContracts,
  toReviewNative,
  toReviewV1,
} from "@quickchatai/pi-quickreview/src/contract.js";
import {
  contractOneNoPrice,
  reviewForContract,
} from "@quickchatai/pi-quickreview/src/localreview.js";
import {
  catalogModelOf,
  isMeasured,
  MEASURED,
  measuredSpec,
  PRICE_BASES,
  priceBasis,
  priceKnowledge,
  specsMeasured,
} from "@quickchatai/pi-quickreview/src/measured.js";
import type {
  CatalogModel,
  ProviderInventory,
} from "@quickchatai/pi-quickreview/src/modelroute.js";

const ID = MEASURED.model_id;
const API = MEASURED.apis[0];

/** The measured model as a provider's catalog lists it. */
const measuredOn = (provider: string, over: Partial<CatalogModel> = {}): CatalogModel => ({
  provider,
  id: ID,
  api: API,
  reasoning: true,
  cost: { ...MEASURED.rates, cacheWrite: 0 },
  ...over,
});

const entry = (provider: string, models: CatalogModel[]): ProviderInventory => ({
  provider,
  name: provider.toUpperCase(),
  credential: { kind: "api_key", origin: "env-key", subscription: false },
  models,
});

/** A model pi prices that nothing was fitted to. */
const OTHER: CatalogModel = {
  provider: "beta",
  id: "some-other-model",
  api: "some-other-api",
  cost: { input: 4, cacheRead: 0.2, output: 20 },
};
/** A model pi has no price for. */
const FREE: CatalogModel = {
  provider: "gamma",
  id: "local-model",
  api: "some-other-api",
  cost: { input: 0, cacheRead: 0, output: 0 },
};

const INVENTORY: ProviderInventory[] = [
  entry("beta", [OTHER]),
  entry("alpha", [measuredOn("alpha")]),
  entry("gamma", [FREE]),
];

describe("isMeasured: the id, the rates and the API family, for every model of the run", () => {
  it("holds for the measured row, through each API of the family", () => {
    for (const api of MEASURED.apis)
      expect(isMeasured([measuredOn("alpha", { api })]), api).toBe(true);
    // a provider that prefixes the id (`vendor/<id>`) serves the same model
    expect(isMeasured([measuredOn("alpha", { id: `vendor/${ID}` })])).toBe(true);
  });

  // MUTATION: drop the `MEASURED.apis` test from measuredModel
  // (packages/pi-plugin/src/measured.ts) - the same id through another API
  // reads as measured, and this fails. MUTATION: drop any one of the three
  // rate comparisons - the row at another rate reads as measured, and this
  // fails.
  it.each([
    ["another id", { id: "some-other-model" }],
    ["the id through an API outside the family", { api: "some-other-api" }],
    ["no API named", { api: undefined }],
    ["another input rate", { cost: { ...MEASURED.rates, input: MEASURED.rates.input * 1.1 } }],
    ["another cached rate", { cost: { ...MEASURED.rates, cacheRead: 0 } }],
    ["another output rate", { cost: { ...MEASURED.rates, output: MEASURED.rates.output + 1 } }],
    ["no rates at all", { cost: undefined }],
  ] as Array<[string, Partial<CatalogModel>]>)("does not hold for %s", (_name, over) => {
    expect(isMeasured([measuredOn("alpha", over)])).toBe(false);
  });

  // MUTATION: make isMeasured `models.some(measuredModel)` - a run with one
  // tier elsewhere reads as measured, and this fails.
  it("one model elsewhere, or no model at all, is not measured", () => {
    expect(isMeasured([measuredOn("alpha"), OTHER])).toBe(false);
    expect(isMeasured([measuredOn("alpha"), measuredOn("delta")])).toBe(true);
    expect(isMeasured([])).toBe(false);
  });
});

describe("the specs of a run, read against pi's inventory", () => {
  it("finds the catalog row a spec names, with or without a level", () => {
    expect(catalogModelOf(`alpha/${ID}:high`, INVENTORY)).toEqual(measuredOn("alpha"));
    expect(catalogModelOf(`alpha/${ID}`, INVENTORY)).toEqual(measuredOn("alpha"));
    // no provider, a provider with no credential here, an id pi does not hold
    expect(catalogModelOf(":high", INVENTORY)).toBeUndefined();
    expect(catalogModelOf(ID, INVENTORY)).toBeUndefined();
    expect(catalogModelOf(`delta/${ID}`, INVENTORY)).toBeUndefined();
    expect(catalogModelOf("alpha/a-custom-id", INVENTORY)).toBeUndefined();
  });

  it("a run is measured only when every spec is a measured row", () => {
    expect(specsMeasured([`alpha/${ID}:medium`, `alpha/${ID}:high`], INVENTORY)).toBe(true);
    expect(specsMeasured([`alpha/${ID}:medium`, "beta/some-other-model:high"], INVENTORY)).toBe(
      false,
    );
    // a custom id is sent as written: nothing is known of its rates
    expect(specsMeasured([`alpha/${ID}`, "alpha/a-custom-id"], INVENTORY)).toBe(false);
    expect(specsMeasured([], INVENTORY)).toBe(false);
  });

  it("names a credentialed provider's spec for the measured model, the first in pi's order", () => {
    expect(measuredSpec(INVENTORY)).toBe(`alpha/${ID}`);
    expect(measuredSpec([entry("beta", [OTHER]), entry("gamma", [FREE])])).toBeNull();
    expect(measuredSpec([])).toBeNull();
  });
});

describe("priceBasis: the five things a price is known from", () => {
  const on = (
    over: Partial<Parameters<typeof priceBasis>[0]> = {},
  ): ReturnType<typeof priceBasis> =>
    priceBasis({
      route: { priced: true },
      repoRates: false,
      specs: [`alpha/${ID}:medium`],
      inventory: INVENTORY,
      ...over,
    });

  it("has five values, in the order they are decided", () => {
    expect(PRICE_BASES).toEqual(["unknown", "repo", "measured", "unpriced", "unmeasured"]);
  });

  it("no route is unknown, whatever else is true", () => {
    expect(on({ route: null })).toBe("unknown");
    expect(on({ route: null, repoRates: true })).toBe("unknown");
  });

  // MUTATION: test specsMeasured before `repoRates` in priceBasis - a repo's
  // own rates lose to the fit on the measured model, and this fails.
  it("the repo's own rates win for any model", () => {
    expect(on({ repoRates: true })).toBe("repo");
    expect(on({ repoRates: true, specs: ["beta/some-other-model"] })).toBe("repo");
    expect(on({ repoRates: true, route: { priced: false }, specs: ["gamma/local-model"] })).toBe(
      "repo",
    );
  });

  it("measured when every spec is, unpriced when pi has no price, else unmeasured", () => {
    expect(on()).toBe("measured");
    expect(on({ specs: [`alpha/${ID}`, "beta/some-other-model"] })).toBe("unmeasured");
    expect(on({ specs: ["beta/some-other-model"] })).toBe("unmeasured");
    expect(on({ specs: ["alpha/a-custom-id"] })).toBe("unmeasured");
    expect(on({ route: { priced: false }, specs: ["gamma/local-model"] })).toBe("unpriced");
  });

  it("a host that resolved no route of its own keeps the fitted estimate", () => {
    // no route and no catalog were handed over: nothing tells the model apart
    expect(on({ route: undefined, specs: ["some/model"], inventory: [] })).toBe("measured");
    expect(on({ route: undefined, repoRates: true, inventory: [] })).toBe("repo");
  });
});

describe("priceKnowledge: the words of one row of choices", () => {
  it("says what is known of each provider's price before a review", () => {
    expect(priceKnowledge({ provider: "alpha", modelId: ID, priced: true }, INVENTORY)).toBe(
      "measured estimate",
    );
    expect(
      priceKnowledge({ provider: "beta", modelId: "some-other-model", priced: true }, INVENTORY),
    ).toBe("no estimate");
    expect(
      priceKnowledge({ provider: "gamma", modelId: "local-model", priced: false }, INVENTORY),
    ).toBe("no list price");
    // a row the inventory does not hold is not measured
    expect(priceKnowledge({ provider: "delta", modelId: ID, priced: true }, INVENTORY)).toBe(
      "no estimate",
    );
  });
});

describe("the review family under a contract", () => {
  const preview = (estimate: number | null, basis: string, spec: string | null) => ({
    lenses: ["pass-a"],
    model: spec === null ? null : { spec },
    price_basis: basis,
    estimate_usd: estimate,
    cap_usd: estimate === null ? 15 : estimate * 2,
    key: "0123456789abcdef",
  });
  const MEASURED_PREVIEW = { ok: true, preview: preview(1.5, "measured", `alpha/${ID}`) };
  const UNMEASURED_PREVIEW = {
    ok: true,
    preview: preview(null, "unmeasured", "beta/some-other-model"),
  };

  it("the code prints version 2, and both contracts are supported", () => {
    expect(REVIEW_SCHEMA_VERSION).toBe(2);
    expect(CONTRACTS[1]).toEqual({ review: 1, scan: 1, version: 1 });
    expect(CONTRACTS[2]).toEqual({ review: 2, scan: 1, version: 1 });
    expect(supportedContracts()).toEqual([1, 2]);
    expect(reviewVersionFor(undefined)).toBe(2);
    expect(reviewVersionFor(2)).toBe(2);
    expect(reviewVersionFor(1)).toBe(1);
    // a contract this build does not know reads as the code's own
    expect(reviewVersionFor(99)).toBe(2);
  });

  it("version 1 is the same object under the older number, while the estimate is a number", () => {
    const v1 = toReviewV1(MEASURED_PREVIEW)!;
    expect(Object.keys(v1)[0]).toBe("schema_version");
    expect(v1).toEqual({ schema_version: 1, ...MEASURED_PREVIEW });
    // a payload with no preview states no estimate, so it projects
    expect(toReviewV1({ ok: false, errors: ["no"] })).toEqual({
      schema_version: 1,
      ok: false,
      errors: ["no"],
    });
    expect(toReviewNative({ schema_version: 1, ...MEASURED_PREVIEW })).toEqual({
      schema_version: 2,
      ...MEASURED_PREVIEW,
    });
  });

  // MUTATION: return `restamped(payload, 1)` from toReviewV1 whatever the
  // estimate (packages/pi-plugin/src/contract.ts) - a null estimate leaves
  // under version 1, and this fails.
  it("a payload with no estimate has no version-1 projection, a wrapped result included", () => {
    expect(toReviewV1(UNMEASURED_PREVIEW)).toBeNull();
    expect(
      toReviewV1({ ok: true, run_id: "r", state: "done", result: { ...UNMEASURED_PREVIEW } }),
    ).toBeNull();
    // the wrapped result of a status is restamped with its wrapper
    expect(
      toReviewV1({
        ok: true,
        run_id: "r",
        state: "done",
        result: { schema_version: 2, ...MEASURED_PREVIEW },
      }),
    ).toEqual({
      schema_version: 1,
      ok: true,
      run_id: "r",
      state: "done",
      result: { schema_version: 1, ...MEASURED_PREVIEW },
    });
  });

  it("a caller that names no contract, or contract 2, reads version 2 with a null estimate", () => {
    for (const contract of [undefined, 2]) {
      const got = reviewForContract(contract, UNMEASURED_PREVIEW);
      expect(got.refused).toBeNull();
      expect(got.data).toEqual({ schema_version: 2, ...UNMEASURED_PREVIEW });
    }
  });

  it("contract 1 reads the measured payload as version 1", () => {
    const got = reviewForContract(1, MEASURED_PREVIEW);
    expect(got.refused).toBeNull();
    expect(got.data).toEqual({ schema_version: 1, ...MEASURED_PREVIEW });
  });

  // MUTATION: return the v1 projection for an unmeasured preview (make
  // reviewForContract restamp the payload when toReviewV1 gives null,
  // packages/pi-plugin/src/localreview.ts) - this fails.
  it("contract 1 never carries a missing estimate: the refusal goes out in its place", () => {
    const got = reviewForContract(1, UNMEASURED_PREVIEW);
    const words =
      "this review would run on beta/some-other-model, which has no measured price, and contract 1 " +
      "cannot say so. Update the QuickReview skills (qcr plugin install).";
    expect(got.refused).toBe(words);
    expect(got.data).toEqual({ schema_version: 1, ok: false, errors: [words] });
    expect(JSON.stringify(got.data)).not.toMatch(/estimate_usd|cap_usd|preview/);
  });

  it("with no model route behind the preview, contract 1 hears the login refusal", () => {
    const got = reviewForContract(1, { ok: true, preview: preview(null, "unknown", null) });
    expect(got.refused).toMatch(/^pi has no model credential/);
    expect(got.refused).not.toMatch(/measured price/);
    expect(got.data).toEqual({ schema_version: 1, ok: false, errors: [got.refused] });
    // inside pi, in the plugin's words
    const inPi = reviewForContract(
      1,
      { ok: true, preview: preview(null, "unknown", null) },
      "plugin",
    );
    expect(inPi.refused).toMatch(/^pi has no model credential/);
  });

  it("a detached run's status keeps what it says of the run and loses the result", () => {
    const got = reviewForContract(1, {
      ok: true,
      run_id: "r1",
      state: "done",
      exit_code: 0,
      result: { schema_version: 2, ...UNMEASURED_PREVIEW },
    });
    expect(got.refused).toMatch(/no measured price/);
    expect(got.data).toEqual({
      schema_version: 1,
      run_id: "r1",
      state: "done",
      exit_code: 0,
      ok: false,
      errors: [got.refused],
    });
  });

  it("the refusal names a measured spec the caller could run on, when one is credentialed", () => {
    expect(contractOneNoPrice("beta/some-other-model", `alpha/${ID}`)).toBe(
      "this review would run on beta/some-other-model, which has no measured price, and contract 1 " +
        `cannot say so. Update the QuickReview skills (qcr plugin install), or run on a measured model: --model alpha/${ID}.`,
    );
    expect(contractOneNoPrice("", null)).toMatch(/^this review would run on a model, which/);
  });
});
