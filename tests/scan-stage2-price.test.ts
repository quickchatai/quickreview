// Stage 2's price for a row the ledger never measured at its own settings
// (src/setup/stage2.ts priceStage2Row), at the pricing seam with fake ledger
// rows. Round 6 of the scan loop: the skeptic went default-on, no stage-2
// row had been measured with the validator on, and every row was priced at
// stage 1's rate × the coarse `unmeasured_rate_factor` (~$0.31/kline against
// the ~$0.21 the same run then measured) — the fit cut 52 of 64 rows and
// left $2.47 of the budget unspent. The prior is now LEARNED where the
// ledger can teach it: stage 1's rate at the row's validator setting × the
// stage-2/stage-1 factor measured at the other setting.
import { describe, expect, it } from "vitest";
import { SCAN_DEFAULTS } from "../src/config.js";
import type { LedgerEntry } from "../src/setup/ledger.js";
import { priceStage2Row, type RowPrice } from "../src/setup/stage2.js";
import { priceIsMeasured, priceLabel } from "../src/setup/stage2request.js";

let n = 0;
/** One ledger row: `usd` over `lines`, one case per row. */
function row(
  lens: string,
  validator: boolean,
  usd: number,
  lines: number,
  over: Partial<LedgerEntry> = {},
): LedgerEntry {
  n++;
  return {
    path: `f${n}.py`,
    blob: `b${n}`,
    lens,
    tier: lens === "pass-scan" ? SCAN_DEFAULTS.tier : "sol-med",
    effort: lens === "pass-scan" ? SCAN_DEFAULTS.effort : "tier",
    validator,
    sha: "1".repeat(40),
    lines,
    cost_usd: usd,
    run: "scan-x",
    case: `c${n}`,
    at: "2026-09-30T10:00:00Z",
    ...over,
  };
}

const cfg = (validator: boolean) => ({ ...SCAN_DEFAULTS, validator });
const price = (
  entries: LedgerEntry[],
  validator = true,
  lens = "pass-security",
  tier: "sol-med" | "sol-high" = "sol-med",
  effort = "tier",
): RowPrice => priceStage2Row(entries, cfg(validator), lens, tier, effort)!;

// Stage 1: $0.05/kline with the skeptic off, $0.075/kline with it on (the
// skeptic is a third of a validated case). Stage 2, skeptic off: $0.14/kline.
const S1_OFF = row("pass-scan", false, 0.05, 1000);
const S1_ON = row("pass-scan", true, 0.075, 1000);
const S2_OFF = row("pass-security", false, 0.14, 1000);

describe("a stage-2 row's price", () => {
  it("is MEASURED when the ledger holds this lens at this tier, effort and validator setting", () => {
    const own = row("pass-security", true, 0.2, 1000);
    const p = price([S1_OFF, S1_ON, S2_OFF, own]);
    expect(p).toMatchObject({ basis: "measured", from: "pass-security" });
    expect(p.rate.usd_per_kline).toBeCloseTo(0.2, 9);
    expect(priceIsMeasured(p)).toBe(true);
  });

  it("is BORROWED from another deep lens at the exact settings before anything is learned", () => {
    const p = price([S1_OFF, S1_ON, S2_OFF, row("pass-contracts", true, 0.18, 1000)]);
    expect(p).toMatchObject({ basis: "borrowed", from: "pass-contracts" });
    expect(priceIsMeasured(p)).toBe(false);
  });

  it("is LEARNED from the lens's measurement at the other validator setting, adjusted by the measured skeptic share", () => {
    const p = price([S1_OFF, S1_ON, S2_OFF]);
    // Stage 1 at the row's setting (on) × the factor stage 2 showed over stage 1 at the other (off).
    expect(p.basis).toBe("learned");
    expect(p.from).toBe("pass-security");
    expect(p.rate.usd_per_kline).toBeCloseTo(0.075 * (0.14 / 0.05), 9);
    expect(p.learned).toMatchObject({ validator: false });
    expect(p.learned!.factor).toBeCloseTo(0.14 / 0.05, 9);
    expect(p.learned!.skeptic).toBeCloseTo(0.075 / 0.05, 9);
    expect(priceIsMeasured(p)).toBe(false);
    // …which is well under the coarse extrapolation it replaces.
    expect(p.rate.usd_per_kline).toBeLessThan(0.075 * SCAN_DEFAULTS.unmeasured_rate_factor);
  });

  it("learns the other way too: validator on measured, the row validator off", () => {
    const p = price([S1_OFF, S1_ON, row("pass-security", true, 0.21, 1000)], false);
    expect(p.basis).toBe("learned");
    expect(p.rate.usd_per_kline).toBeCloseTo(0.05 * (0.21 / 0.075), 9);
    expect(p.learned).toMatchObject({ validator: true });
  });

  it("round 6's shape: priced near what the run then measured, not at stage 1 × 4", () => {
    // Stage 1 measured at both settings; stage 2 had only ever been measured
    // skeptic-off. The extrapolation said $0.0775 × 4 ≈ $0.31.
    const s1on = row("pass-scan", true, 0.0775, 1000);
    const s1off = row("pass-scan", false, 0.052, 1000);
    const s2off = row("pass-security", false, 0.14, 1000);
    const p = price([s1on, s1off, s2off]);
    expect(p.basis).toBe("learned");
    expect(p.rate.usd_per_kline).toBeGreaterThan(0.19);
    expect(p.rate.usd_per_kline).toBeLessThan(0.23);
  });

  it("prefers the row's own lens over other deep lenses; learns from another deep lens only when its own has nothing", () => {
    const other = row("pass-contracts", false, 0.3, 1000);
    expect(price([S1_OFF, S1_ON, S2_OFF, other])).toMatchObject({
      basis: "learned",
      from: "pass-security",
    });
    const p = price([S1_OFF, S1_ON, other]);
    expect(p).toMatchObject({ basis: "learned", from: "pass-contracts" });
    expect(p.rate.usd_per_kline).toBeCloseTo(0.075 * (0.3 / 0.05), 9);
  });

  it("never learns from pass-scan, another tier or another effort — those fall back to the extrapolation", () => {
    const high = row("pass-security", false, 0.4, 1000, { tier: "sol-high" });
    const low = row("pass-security", false, 0.1, 1000, { effort: "low" });
    for (const entries of [
      [S1_OFF, S1_ON, high],
      [S1_OFF, S1_ON, low],
      [S1_OFF, S1_ON],
    ]) {
      const p = price(entries);
      expect(p).toMatchObject({ basis: "extrapolated", from: "pass-scan" });
      expect(p.rate.usd_per_kline).toBeCloseTo(0.075 * SCAN_DEFAULTS.unmeasured_rate_factor, 9);
    }
    // …while the sol-high row itself learns from the sol-high measurement.
    expect(price([S1_OFF, S1_ON, high], true, "pass-security", "sol-high")).toMatchObject({
      basis: "learned",
    });
  });

  it("cannot learn without stage 1 measured at BOTH settings (the skeptic share is unmeasured): extrapolated", () => {
    expect(price([S1_ON, S2_OFF])).toMatchObject({ basis: "extrapolated" });
    // Stage 1 off only: extrapolated from it, as before.
    expect(price([S1_OFF, S2_OFF])).toMatchObject({ basis: "extrapolated" });
  });

  it("reads the skeptic's share from stage 1 at ONE tier and effort — never a ratio across tiers", () => {
    // Stage 1 on at [scan]'s tier, off only at another tier: the ratio would
    // be the tier's price, not the skeptic's, so nothing is learned.
    const offElsewhere = row("pass-scan", false, 0.01, 1000, { tier: "sol-high" });
    expect(price([S1_ON, offElsewhere, S2_OFF])).toMatchObject({ basis: "extrapolated" });
    // A pair measured both ways at another tier still carries the share.
    const onElsewhere = row("pass-scan", true, 0.02, 1000, { tier: "sol-high" });
    const p = price([S1_ON, offElsewhere, onElsewhere, S2_OFF]);
    expect(p.basis).toBe("learned");
    expect(p.rate.usd_per_kline).toBeCloseTo(0.14 * 2, 9);
  });

  it("never lets a noisy stage-1 pair price a validated row under the unvalidated measurement (or the reverse)", () => {
    // Stage 1 happened to measure CHEAPER with the skeptic on.
    const on = row("pass-scan", true, 0.04, 1000);
    const p = price([S1_OFF, on, S2_OFF]);
    expect(p.basis).toBe("learned");
    expect(p.rate.usd_per_kline).toBeCloseTo(0.14, 9);
    expect(p.learned!.skeptic).toBe(1);
    // …and a skeptic-off row learned from a skeptic-on measurement is never raised.
    const q = price([S1_OFF, on, row("pass-security", true, 0.2, 1000)], false);
    expect(q.rate.usd_per_kline).toBeCloseTo(0.2, 9);
  });

  it("ignores unpriced rows, and is null with no priced stage 1 at all", () => {
    expect(
      price([S1_OFF, S1_ON, row("pass-security", false, 0, 1000, { cost_usd: null })]),
    ).toMatchObject({ basis: "extrapolated" });
    expect(priceStage2Row([S2_OFF], cfg(true), "pass-security", "sol-med", "tier")).toBeNull();
  });

  it("says in its label whether it is a measurement or an estimate, and how the estimate was made", () => {
    expect(priceLabel(price([S1_OFF, S1_ON, S2_OFF, row("pass-security", true, 0.2, 1000)]))).toBe(
      "measured",
    );
    expect(priceLabel(price([S1_OFF, S1_ON, S2_OFF]))).toBe(
      "estimate: learned from pass-security with the validator off (×2.80 stage 1), stage 1 validator on/off ×1.50",
    );
    expect(priceLabel(price([S1_OFF, S1_ON]))).toBe(
      `estimate: extrapolated from pass-scan (×${SCAN_DEFAULTS.unmeasured_rate_factor})`,
    );
    expect(priceLabel(price([S1_OFF, S1_ON, row("pass-contracts", true, 0.18, 1000)]))).toBe(
      "estimate: borrowed from pass-contracts",
    );
  });
});
