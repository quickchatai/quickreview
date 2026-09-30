// The scaling assertion's own fence: it must tell linear work from quadratic
// work by growth alone, so the linear-time tests that use it
// (tests/depsources.test.ts) fail on a quadratic regression and never on a
// loaded machine.
import { describe, expect, it } from "vitest";
import {
  LINEAR_HANG_GUARD_MS,
  LINEAR_RATIO_CEILING_10X,
  measureScaling,
} from "./helpers/scaling.js";

let sink = 0;

function linear(n: number): void {
  let acc = 0;
  for (let i = 0; i < n; i++) acc = (acc + i * 31) | 0;
  sink ^= acc;
}

function quadratic(n: number): void {
  let acc = 0;
  for (let i = 0; i < n; i++) for (let j = 0; j < n; j++) acc = (acc + i * j) | 0;
  sink ^= acc;
}

describe("measureScaling", () => {
  it(
    "reads linear work as ~factor and quadratic work as ~factor²",
    () => {
      const lin = measureScaling(linear, 200_000, 2_000_000);
      expect(lin.ratio, JSON.stringify(lin)).toBeLessThan(LINEAR_RATIO_CEILING_10X);
      const quad = measureScaling(quadratic, 400, 4_000);
      expect(quad.ratio, JSON.stringify(quad)).toBeGreaterThan(LINEAR_RATIO_CEILING_10X);
      expect(sink).toBeTypeOf("number");
    },
    LINEAR_HANG_GUARD_MS,
  );
});
