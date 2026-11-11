// The pick inside one provider (packages/pi-plugin/src/modelpick.ts): the
// version read from a model id, the candidate filter, the order the newest
// is first in, and the guard that lets pi's own default stand. The ids are
// pi 1.4.0's catalog and its neighbours; the rows marked "made up" exist to
// put a rule's boundary where a real id does not.
import { describe, expect, it } from "vitest";
import {
  CONTEXT_FLOOR,
  GUARD_RATIO,
  candidatesOf,
  compareModels,
  compareVersions,
  isCandidate,
  leafOf,
  listPrice,
  pickModel,
  versionOf,
  type ModelVersion,
  type PickableModel,
} from "@quickchatai/pi-quickreview/src/modelpick.js";

type Row = [id: string, version: ModelVersion | null];

/** A candidate unless a field says otherwise: it reasons, it has a 200k
 * window, and it costs `price` per million tokens, a fifth of it on input. */
function model(id: string, price = 5, over: Partial<PickableModel> = {}): PickableModel {
  return {
    id,
    reasoning: true,
    contextWindow: 200_000,
    cost: { input: price / 5, output: (price * 4) / 5 },
    ...over,
  };
}
const ids = (models: readonly PickableModel[]): string[] => models.map((m) => m.id);

/** Every order of a short list. */
function permutations<T>(list: readonly T[]): T[][] {
  if (list.length <= 1) return [[...list]];
  return list.flatMap((head, i) =>
    permutations([...list.slice(0, i), ...list.slice(i + 1)]).map((rest) => [head, ...rest]),
  );
}

describe("leafOf", () => {
  // MUTATION: keep the vendor path in leafOf (drop the lastIndexOf slice) — the path rows fail.
  it("keeps the text after the last slash", () => {
    expect(leafOf("moonshotai/kimi-k2.6")).toBe("kimi-k2.6");
    expect(leafOf("accounts/fireworks/models/kimi-k3")).toBe("kimi-k3");
    expect(leafOf("workers-ai/@cf/moonshotai/kimi-k2.6")).toBe("kimi-k2.6");
  });

  // MUTATION: cut at the last colon instead of the first — the two-colon row fails.
  it("cuts at the first colon", () => {
    expect(leafOf("meta-llama/llama-4-maverick:free")).toBe("llama-4-maverick");
    expect(leafOf("us.anthropic.claude-opus-4-6-v1:0")).toBe("us.anthropic.claude-opus-4-6-v1");
    expect(leafOf("vendor/name-3:thinking:free")).toBe("name-3");
  });

  // MUTATION: drop toLowerCase from leafOf — this fails.
  it("is lowercased, and a bare id is its own leaf", () => {
    expect(leafOf("zai-org/GLM-5.2")).toBe("glm-5.2");
    expect(leafOf("gpt-6.1-sol")).toBe("gpt-6.1-sol");
  });
});

describe("versionOf: the id table", () => {
  // MUTATION: return [major, 0] for an undotted token without reading the
  // next one — every row with a dash minor fails.
  // MUTATION: take any next token as the minor (drop the MINOR test) — the
  // build rows read 2.905 and 4.125 and this fails.
  const DASH_MINOR: Row[] = [
    ["claude-opus-5-5", [5, 5]],
    ["claude-opus-4-8", [4, 8]],
    ["grok-4-1-fast", [4, 1]],
    // The eight-digit date is neither the version nor its minor.
    ["claude-sonnet-4-5-20250929", [4, 5]],
    ["claude-3-5-sonnet-20241022", [3, 5]],
    // `0905` and `0125` are builds, not minors.
    ["kimi-k2-0905-preview", [2, 0]],
    ["gpt-4-0125-preview", [4, 0]],
  ];
  it.each(DASH_MINOR)("dash minor: %s", (id, version) => {
    expect(versionOf(id)).toEqual(version);
  });

  // MUTATION: keep walking after the first version token and return the
  // last one — the `-v1` rows read 1.0 and this fails.
  const FIRST_TOKEN_WINS: Row[] = [
    ["us.anthropic.claude-opus-4-6-v1", [4, 6]],
    ["us.anthropic.claude-opus-4-6-v1:0", [4, 6]],
    ["nvidia/nemotron-3.5-super-vl-120b-a12b", [3, 5]],
    ["Ring-2.6-1T", [2, 6]],
    ["llama-3.3-70b-versatile", [3, 3]],
  ];
  it.each(FIRST_TOKEN_WINS)("the first version token is the version: %s", (id, version) => {
    expect(versionOf(id)).toEqual(version);
  });

  const PLAIN: Row[] = [
    ["gpt-6.1-sol", [6, 1]],
    ["gpt-5.5", [5, 5]],
    ["gpt-6-luna", [6, 0]],
    ["o4-mini", [4, 0]],
    ["gemini-3.1-pro-preview", [3, 1]],
    ["gemini-4-argon", [4, 0]],
    ["grok-4.7", [4, 7]],
    ["deepseek-v4-pro", [4, 0]],
    ["mimo-v2.6-pro", [2, 6]],
    ["muse-spark-1.3", [1, 3]],
    ["nova-pro-v1", [1, 0]],
    ["phi-4", [4, 0]],
    // Letters glued in front of the number, and one behind it.
    ["qwen3.7-max", [3, 7]],
    ["gpt-4o-2024-08-06", [4, 0]],
    // Read whatever the id's case.
    ["MiniMax-M2.7", [2, 7]],
    ["zai-org/GLM-5.2", [5, 2]],
  ];
  // MUTATION: drop toLowerCase from leafOf — `MiniMax-M2.7` reads null and this fails.
  it.each(PLAIN)("plain: %s", (id, version) => {
    expect(versionOf(id)).toEqual(version);
  });

  // MUTATION: keep the vendor path (drop the lastIndexOf slice in leafOf) —
  // `qwen/qwen3.8-27b` reads null, its version glued to a token with a slash.
  // MUTATION: drop the colon cut in leafOf — `amazon.nova-pro-v1:0` reads null.
  // MUTATION: drop the VENDOR_PREFIX replace in versionOf — the glued
  // Bedrock row reads its later `-v1` (1.0) and `deepseek.v3.2` reads null.
  // MUTATION: drop the `(?=[a-z])` lookahead from VENDOR_PREFIX —
  // `deepseek.v3.2` loses its `v3.` and reads 2.0.
  const VENDOR: Row[] = [
    ["moonshotai/kimi-k2.6", [2, 6]],
    ["@cf/moonshotai/kimi-k2.6", [2, 6]],
    ["workers-ai/@cf/moonshotai/kimi-k2.6", [2, 6]],
    ["accounts/fireworks/models/kimi-k3", [3, 0]],
    ["qwen/qwen3.8-27b", [3, 8]],
    ["meta-llama/llama-4-maverick:free", [4, 0]],
    ["amazon.nova-pro-v1:0", [1, 0]],
    ["meta.llama4-maverick-17b-instruct-v1:0", [4, 0]],
    ["deepseek.v3.2", [3, 2]],
  ];
  it.each(VENDOR)("vendor path, dotted prefix, suffix: %s", (id, version) => {
    expect(versionOf(id)).toEqual(version);
  });

  // MUTATION: let VERSION take any number of digits (`\d*` for `\d?`) — the
  // YYMM rows read 2509 and 2603 and this fails.
  // MUTATION: drop the YEAR_FIRST_DATE replace — `qwen-max-2025-01-25`
  // reads its day (25.0) and this fails.
  // MUTATION: drop the MONTH_YEAR_DATE replace — the `11-2024` row reads
  // its month (11.0) and this fails.
  // MUTATION: let VERSION start on a zero (`\d` for `[1-9]`) — `name-08`
  // reads 8.0 and this fails.
  const DATES: Row[] = [
    ["magistral-small-2509", null],
    ["mistral-small-2603", null],
    ["qwen-max-2025-01-25", null],
    ["command-r-plus-08-2024", null],
    ["o3-2025-04-16", [3, 0]],
    ["gemini-2.5-flash-preview-09-2025", [2, 5]],
    // Made up: a month of two digits with no leading zero, and a leading
    // zero that stands alone.
    ["command-r-plus-11-2024", null],
    ["name-08", null],
  ];
  it.each(DATES)("a date or a build is not a version: %s", (id, version) => {
    expect(versionOf(id)).toEqual(version);
  });

  // MUTATION: drop the SIZE test from versionOf — `openai.gpt-oss-20b`
  // reads 20.0 and `mistral.voxtral-small-24b-2507` reads 24.0.
  const SIZES: Row[] = [
    ["gpt-oss-120b", null],
    ["openai/gpt-oss-120b", null],
    ["openai.gpt-oss-20b", null],
    ["mistral.voxtral-small-24b-2507", null],
    ["mistralai/mixtral-8x7b", null],
  ];
  it.each(SIZES)("a size is not a version: %s", (id, version) => {
    expect(versionOf(id)).toEqual(version);
  });

  const ALIASES: Row[] = [
    ["devstral-medium-latest", null],
    ["mistral-large-latest", null],
    ["kimi-for-coding", null],
    ["balanced", null],
  ];
  it.each(ALIASES)("an alias has none: %s", (id, version) => {
    expect(versionOf(id)).toEqual(version);
  });

  // MUTATION: drop the calendar-version skip from versionOf — the three
  // catalog rows read 26.10, 26.9 and 25.8 and this fails.
  // MUTATION: set CALENDAR_MAJOR to 19 or to 21 — a boundary row fails.
  // MUTATION: widen the month test to `minor <= 13`, or to `minor >= 0` — a
  // boundary row fails.
  const CALENDAR: Row[] = [
    ["unbiased/pareto-26.10", null],
    ["pareto-26.9", null],
    ["codestral-25.08", null],
    // Made up: the edges of "major 20 or more, minor 1 to 12".
    ["name-20.1", null],
    ["name-20.12", null],
    ["name-19.12", [19, 12]],
    ["name-20.13", [20, 13]],
    ["name-20.0", [20, 0]],
    // Undotted, so there is no month to read: a plain major.
    ["name-26", [26, 0]],
    // A calendar token is skipped, not the end of the walk.
    ["name-26.10-v3", [3, 0]],
  ];
  it.each(CALENDAR)("a calendar version never qualifies: %s", (id, version) => {
    expect(versionOf(id)).toEqual(version);
  });
});

describe("listPrice", () => {
  // MUTATION: return cost.input alone from listPrice — this fails.
  it("is input plus output per million tokens, and nothing else", () => {
    expect(listPrice({ id: "a", cost: { input: 2, output: 10 } })).toBe(12);
    const cached = { id: "a", cost: { input: 2, output: 10, cacheRead: 0.1, cacheWrite: 3 } };
    expect(listPrice(cached)).toBe(12);
  });

  // MUTATION: drop the `n > 0` test from amount — the negative row is -1 and this fails.
  it("is zero where pi has no price, whatever is missing", () => {
    expect(listPrice({ id: "a" })).toBe(0);
    expect(listPrice({ id: "a", cost: {} })).toBe(0);
    expect(listPrice({ id: "a", cost: { input: 3 } })).toBe(3);
    expect(listPrice({ id: "a", cost: { input: Number.NaN, output: 4 } })).toBe(4);
    expect(listPrice({ id: "a", cost: { input: -1, output: 0 } })).toBe(0);
  });
});

describe("the candidate filter", () => {
  // MUTATION: drop `m.reasoning === true` from isCandidate — this fails.
  it("a model that does not reason is not a candidate", () => {
    expect(isCandidate(model("a-1"))).toBe(true);
    expect(isCandidate(model("a-1", 5, { reasoning: false }))).toBe(false);
    expect(isCandidate({ id: "a-1", contextWindow: 200_000 })).toBe(false);
  });

  // MUTATION: set CONTEXT_FLOOR to 128_001 — the 128k model drops out and this fails.
  // MUTATION: set CONTEXT_FLOOR to 127_999 — the model one token short gets in and this fails.
  it("a window below 128k is not one a review fits in", () => {
    expect(CONTEXT_FLOOR).toBe(128_000);
    expect(isCandidate(model("a-1", 5, { contextWindow: 128_000 }))).toBe(true);
    expect(isCandidate(model("a-1", 5, { contextWindow: 127_999 }))).toBe(false);
    expect(isCandidate({ id: "a-1", reasoning: true })).toBe(false);
  });

  // MUTATION: return `ranked` unfiltered from withoutVariants — the speed
  // tier is the same version at a higher price, so it is the newest, and
  // every case here fails.
  it.each<[what: string, base: string, variant: string]>([
    ["a speed tier", "gpt-6.1-sol", "gpt-6.1-sol-fast"],
    ["a speed tier", "mimo-v2.6-pro", "mimo-v2.6-pro-ultraspeed"],
    ["a sibling", "gpt-5.5", "gpt-5.5-pro"],
    ["a dated snapshot", "claude-opus-4-5", "claude-opus-4-5-20251101"],
    [
      "a variant on another vendor path",
      "accounts/fireworks/models/kimi-k3",
      "accounts/fireworks/routers/kimi-k3-fast",
    ],
    ["a variant in another case", "zai-org/GLM-5.3", "zai-org/GLM-5.3-Fast"],
    ["a variant of a versionless id", "mistral-large", "mistral-large-latest"],
  ])("%s stands behind its base id: %s", (_what, base, variant) => {
    const models = [model(variant, 24), model(base, 12)];
    expect(ids(candidatesOf(models))).toEqual([base]);
    expect(pickModel(models)?.model.id).toBe(base);
  });

  // MUTATION: drop the same-version test from withoutVariants — the 4.1
  // model is dropped as a variant of 4.0 and this fails.
  it("an id that continues another at a different version is its own model", () => {
    const models = [model("grok-4"), model("grok-4-1-fast")];
    expect(ids(candidatesOf(models))).toEqual(["grok-4-1-fast", "grok-4"]);
  });

  // MUTATION: drop variants before the candidate filter (rank every model,
  // then filter) — the reasoning variant goes with its base and this fails.
  it("a variant stands for itself when its base is not a candidate", () => {
    const models = [model("name-3", 5, { reasoning: false }), model("name-3-thinking")];
    expect(ids(candidatesOf(models))).toEqual(["name-3-thinking"]);
  });

  it("a `:suffix` sibling has the same leaf: it stays, and loses on price", () => {
    const models = [
      model("meta-llama/llama-4-maverick:free", 0),
      model("meta-llama/llama-4-maverick"),
    ];
    expect(ids(candidatesOf(models))).toEqual([
      "meta-llama/llama-4-maverick",
      "meta-llama/llama-4-maverick:free",
    ]);
  });
});

describe("the order", () => {
  /** `first` sorts before `second` from either input order, and the
   * comparator says so in both directions. */
  function expectOrder(first: PickableModel, second: PickableModel, piDefaultId?: string): void {
    expect(compareModels(first, second, piDefaultId)).toBeLessThan(0);
    expect(compareModels(second, first, piDefaultId)).toBeGreaterThan(0);
    expect(ids(candidatesOf([second, first], piDefaultId))).toEqual([first.id, second.id]);
    expect(ids(candidatesOf([first, second], piDefaultId))).toEqual([first.id, second.id]);
  }

  // MUTATION: return 0 from compareVersions when either side is null — the
  // versionless model wins on price and this fails.
  it("1. a versioned model before a versionless one, whatever the price", () => {
    expectOrder(model("name-1", 0.1), model("balanced", 18, { contextWindow: 1_000_000 }));
    expect(compareVersions([1, 0], null)).toBeLessThan(0);
    expect(compareVersions(null, [1, 0])).toBeGreaterThan(0);
    expect(compareVersions(null, null)).toBe(0);
  });

  // MUTATION: compare the minor before the major in compareVersions — 5.9
  // comes before 6.0 and this fails.
  it("2. the higher major, whatever the price", () => {
    expectOrder(model("name-6", 0.6), model("name-5.9", 35));
    expect(compareVersions([6, 0], [5, 9])).toBeLessThan(0);
  });

  // MUTATION: compare versions as text (`${major}.${minor}`) — 4.9 comes
  // before 4.10 and this fails.
  it("3. the higher minor, as a number", () => {
    expectOrder(model("name-5.5", 1), model("name-5.4", 35));
    expectOrder(model("name-4.10", 1), model("name-4.9", 35));
    expect(compareVersions([4, 10], [4, 9])).toBeLessThan(0);
    expect(compareVersions([4, 9], [4, 9])).toBe(0);
  });

  // MUTATION: drop the price step from compareRanked — the larger window
  // wins and this fails.
  // MUTATION: return cost.input alone from listPrice — the model with the
  // dearer input and the lower sum wins and this fails.
  it("4. at one version, the higher list price", () => {
    const dear = model("vendor-a/name-5", 5, { cost: { input: 1, output: 4 } });
    const cheap = model("vendor-b/name-5", 4, {
      cost: { input: 3, output: 1 },
      contextWindow: 1_000_000,
    });
    expectOrder(dear, cheap);
  });

  // MUTATION: drop the window step from compareRanked — the id decides and this fails.
  it("5. at one version and price, the larger window", () => {
    expectOrder(
      model("vendor-b/name-5", 5, { contextWindow: 1_000_000 }),
      model("vendor-a/name-5", 5, { contextWindow: 272_000 }),
    );
  });

  // MUTATION: drop the piDefaultId branch from compareRanked — the id
  // decides, `mimo-v2.6-flash` is picked, and this fails.
  it("6. between equals, pi's default for the provider", () => {
    const pro = model("mimo-v2.6-pro", 0);
    const flash = model("mimo-v2.6-flash", 0);
    expectOrder(pro, flash, "mimo-v2.6-pro");
    expect(pickModel([flash, pro], "mimo-v2.6-pro")?.model.id).toBe("mimo-v2.6-pro");
    // It breaks a tie and nothing more: a default that is older stays behind.
    expectOrder(model("name-6", 1), model("name-5", 1), "name-5");
  });

  // MUTATION: return 0 at the end of compareRanked — the order follows the
  // input order, the permutations disagree, and this fails.
  it("7. then the id, so the order is total", () => {
    expectOrder(model("vendor-a/name-5"), model("vendor-b/name-5"));
    expectOrder(model("mimo-v2.6-flash", 0), model("mimo-v2.6-pro", 0));
    expect(compareModels(model("name-5"), model("name-5"))).toBe(0);
  });

  it("every input order of one list sorts the same way", () => {
    const sorted = [
      model("name-6.1", 12, { contextWindow: 1_050_000 }),
      model("name-6.1", 12),
      model("other-6.1", 12),
      model("name-6-mini", 0.6),
      model("name-5.5", 35),
      model("name-5.5-b", 0),
      model("zeta", 18, { contextWindow: 1_000_000 }),
      model("alpha", 18),
    ];
    // `name-5.5-b` would fold into `name-5.5` as a variant: this is the
    // comparator's own order, read without the filter.
    for (const order of permutations(sorted.slice(0, 6)))
      expect([...order].sort((a, b) => compareModels(a, b))).toEqual(sorted.slice(0, 6));
    for (const order of permutations(sorted.slice(3)))
      expect([...order].sort((a, b) => compareModels(a, b))).toEqual(sorted.slice(3));
  });
});

describe("the guard against pi's default", () => {
  const def = model("kimi-k3", 18, { cost: { input: 3, output: 15 } });

  it("no model at all: the provider has none the rule can pick", () => {
    expect(pickModel([])).toBeNull();
    expect(pickModel([], "kimi-k3")).toBeNull();
  });

  // MUTATION: return null from pickModel whenever no model passes the
  // filter — the first case fails.
  it("no candidate: pi's default when the provider has it, else none", () => {
    const plain = model("devstral-medium-latest", 2.4, { reasoning: false });
    expect(pickModel([plain], "devstral-medium-latest")).toEqual({
      model: plain,
      pick: "pi-default",
      newest: null,
      guarded: false,
    });
    expect(pickModel([plain])).toBeNull();
    expect(pickModel([plain], "not-in-the-list")).toBeNull();
  });

  // MUTATION: fall back to the first model when pi names no default — the
  // cheap newest is priced against it and this fails.
  it("no default: the newest, unguarded", () => {
    const cheap = model("gpt-6-luna", 0.6);
    const expected = { model: cheap, pick: "newest", newest: cheap, guarded: false };
    expect(pickModel([def, cheap])).toEqual(expected);
    expect(pickModel([def, cheap], "not-in-the-list")).toEqual(expected);
  });

  it("the newest is pi's default: it", () => {
    const older = model("kimi-k2.6", 4.95);
    expect(pickModel([older, def], "kimi-k3")).toEqual({
      model: def,
      pick: "newest",
      newest: def,
      guarded: false,
    });
  });

  // MUTATION: set GUARD_RATIO to 0.01 — $0.60 is not below a hundredth of
  // $18, the small tier runs, and this fails.
  it("the newest is priced far below pi's default: the default stands", () => {
    const cheap = model("gpt-6-luna", 0.6);
    expect(pickModel([cheap, def], "kimi-k3")).toEqual({
      model: def,
      pick: "pi-default",
      newest: cheap,
      guarded: true,
    });
  });

  // MUTATION: set GUARD_RATIO to 0.5 — a newer flagship at a third of the
  // older one's price is sent back to the older one, and this fails.
  it("a newer flagship at a third of the default's price is the pick", () => {
    const older = model("gpt-5.5", 35);
    const newer = model("gpt-6.1-sol", 12);
    expect(pickModel([older, newer], "gpt-5.5")).toEqual({
      model: newer,
      pick: "newest",
      newest: newer,
      guarded: false,
    });
  });

  // MUTATION: change `<` to `<=` in the guard — the model at exactly a
  // quarter is sent back, and so is an unpriced newest beside an unpriced
  // default; both cases fail.
  it("the line is a quarter, and a price on it passes", () => {
    expect(GUARD_RATIO).toBe(0.25);
    const quarter = model("name-6", 4.5, { cost: { input: 0.5, output: 4 } });
    const under = model("name-6", 4.25, { cost: { input: 0.25, output: 4 } });
    expect(pickModel([quarter, def], "kimi-k3")?.model).toBe(quarter);
    expect(pickModel([under, def], "kimi-k3")).toEqual({
      model: def,
      pick: "pi-default",
      newest: under,
      guarded: true,
    });
  });

  it("a default pi has no price for cannot guard", () => {
    const free = model("qwen3.7-max", 0);
    const newerFree = model("glm-5.3", 0);
    const newerPriced = model("glm-5.3", 0.01);
    for (const newer of [newerFree, newerPriced])
      expect(pickModel([free, newer], "qwen3.7-max")).toEqual({
        model: newer,
        pick: "newest",
        newest: newer,
        guarded: false,
      });
  });

  // MUTATION: look pi's default up among the candidates only — a default
  // that does not reason is not found, the cheap newest runs, and this fails.
  it("the default is looked up in the provider's whole list", () => {
    const plain = model("devstral-medium-latest", 18, { reasoning: false });
    const cheap = model("name-3-mini", 0.6);
    expect(pickModel([plain, cheap], "devstral-medium-latest")).toEqual({
      model: plain,
      pick: "pi-default",
      newest: cheap,
      guarded: true,
    });
  });

  it("the pick is one of the models it was given, not a copy", () => {
    const rich = { ...model("name-6", 12), provider: "vendor", name: "Name 6" };
    const got = pickModel([rich], "name-6");
    expect(got?.model).toBe(rich);
    expect(got?.model.provider).toBe("vendor");
  });
});
