// The cost estimator (priceReview in packages/pi-plugin/src/localreview.ts) against what reviews
// actually cost. The table is read from disk, not produced by a run: the final1
// bench runs' per-case usage priced at the model's list prices
// (tests/fixtures/review-cost/recorded.json).

import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  DEFAULT_REVIEW_SETTINGS,
  HARD_STOP_FACTOR,
  hardStopFor,
  priceReview,
  type ReviewSettings,
} from "@quickchatai/pi-quickreview/src/localreview.js";

const dir = dirname(fileURLToPath(import.meta.url));
const table = JSON.parse(
  readFileSync(resolve(dir, "fixtures", "review-cost", "recorded.json"), "utf8"),
) as { rows: Array<[string, number, number, number]> };
const rows = table.rows.map(([name, lenses, lines, cost]) => ({ name, lenses, lines, cost }));
const S = DEFAULT_REVIEW_SETTINGS;

const median = (a: number[]): number => [...a].sort((x, y) => x - y)[Math.floor(a.length / 2)]!;
const quantile = (a: number[], q: number): number =>
  [...a].sort((x, y) => x - y)[Math.floor(q * a.length)]!;

describe("priceReview against recorded costs", () => {
  it("has the recorded table", () => {
    expect(rows.length).toBeGreaterThan(250);
    for (const r of rows) expect(r.cost).toBeGreaterThan(0);
  });

  it("the total over the table is within 5% of what was spent", () => {
    const est = rows.reduce((n, r) => n + priceReview(r.lenses, r.lines, S), 0);
    const real = rows.reduce((n, r) => n + r.cost, 0);
    expect(Math.abs(est / real - 1)).toBeLessThan(0.05);
  });

  it("each review is off by 30% at the median and 80% at the 90th percentile", () => {
    const err = rows.map((r) => Math.abs(priceReview(r.lenses, r.lines, S) - r.cost) / r.cost);
    expect(median(err)).toBeLessThan(0.3);
    expect(quantile(err, 0.9)).toBeLessThan(0.8);
  });

  it("no recorded review cost more than the hard stop its estimate sets", () => {
    for (const r of rows)
      expect(hardStopFor(priceReview(r.lenses, r.lines, S)), r.name).toBeGreaterThanOrEqual(r.cost);
  });

  it("the biggest recorded diff is no longer priced several times over", () => {
    const big = rows.reduce((a, b) => (b.lines > a.lines ? b : a));
    // the old model charged every lens the per-kline rate: 28 lenses on 3.3k lines
    const old = big.lenses * (0.1 + (0.5 * big.lines) / 1000);
    expect(old).toBeGreaterThan(3 * big.cost);
    expect(priceReview(big.lenses, big.lines, S)).toBeLessThan(2 * big.cost);
  });
});

describe("priceReview's shape", () => {
  it("is a base, a fixed cost per lens and one diff term", () => {
    const s: ReviewSettings = {
      auto_limit_usd: 2,
      usd_base: 1,
      usd_per_lens: 0.5,
      usd_per_kline: 2,
    };
    expect(priceReview(0, 0, s)).toBe(1);
    expect(priceReview(4, 0, s)).toBe(3);
    expect(priceReview(4, 1000, s)).toBe(5);
    // the diff term does not multiply with the lenses
    expect(priceReview(20, 1000, s) - priceReview(20, 0, s)).toBeCloseTo(2);
  });

  it("rounds up to the cent and never quotes zero", () => {
    const s: ReviewSettings = { auto_limit_usd: 2, usd_base: 0, usd_per_lens: 0, usd_per_kline: 1 };
    expect(priceReview(0, 1, s)).toBe(0.01);
    expect(priceReview(0, 1001, s)).toBe(1.01);
  });

  it("the hard stop is the estimate times the factor, in whole cents", () => {
    expect(HARD_STOP_FACTOR).toBe(2);
    expect(hardStopFor(1.23)).toBe(2.46);
    expect(hardStopFor(0.01)).toBe(0.02);
  });
});
