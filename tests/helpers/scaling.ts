// Linear-time assertions that measure SCALING, never a wall-clock budget.
//
// "Parses 100k entries in under 2s" is a statement about the machine, not the
// code: it passes alone and fails the moment a benchmark shares the CPU, and a
// flaky test teaches everyone to read red as noise. What a "this must be
// linear" test actually claims is how the work GROWS, so it measures that:
// the same operation at n and at factor·n, on the same machine, back to back.
//
// Both sides do comparable work so load and timer granularity cancel: the
// small side runs `factor` times per sample (factor·n units of linear work,
// like the large side), the two sides' samples interleave, and each side
// keeps the MIN of its samples — a load spike can only make one sample
// slower, never faster. The ratio is then
// reported per single small run, so it reads the usual way: a linear
// operation grows ≈ factor, a quadratic one ≈ factor², and the assertion sits
// well between them.

export interface Scaling {
  /** Best time of ONE run on the small input, ms (a factor-run batch ÷ factor). */
  smallMs: number;
  /** Best time of one run on the large input, ms. */
  largeMs: number;
  /** largeMs / smallMs: ≈ factor when linear, ≈ factor² when quadratic. */
  ratio: number;
}

/** Shortest sample worth timing, ms. */
const MIN_SAMPLE_MS = 5;

/** Time `run` on `small` and on `large` (≈ factor× the size of `small`) and
 * return how the time grew. `run` is warmed up on the small input first, so
 * JIT tiering is not billed to the side measured first. The caller's test
 * timeout is the hang guard — keep sizes where a quadratic regression still
 * fails in seconds, not minutes. */
export function measureScaling<T>(
  run: (input: T) => void,
  small: T,
  large: T,
  opts: { factor?: number; samples?: number } = {},
): Scaling {
  const factor = opts.factor ?? 10;
  const samples = opts.samples ?? 3;
  // Warm-up, timed: `factor` small runs are the linear prediction of one
  // large run. The large input is never run before it is measured, so a
  // regression costs `samples` large runs to catch, not one more.
  const t0 = performance.now();
  for (let i = 0; i < factor; i++) run(small);
  // A sample shorter than a few ms is timer and scheduler noise: repeat an
  // operation that fast until one sample is long enough to mean something.
  const reps = Math.max(1, Math.ceil(MIN_SAMPLE_MS / Math.max(performance.now() - t0, 1e-3)));
  // Samples INTERLEAVE (small batch, large, small batch, large, …) so load
  // that comes and goes during the measurement lands on both sides alike.
  // Timing every small sample before any large one let a benchmark that
  // stopped (or started) between the two phases skew the ratio either way —
  // observed: a quadratic regression read 31 instead of ~140 because the
  // load lifted just as the large side began.
  let batch = Infinity;
  let large_ = Infinity;
  for (let s = 0; s < samples; s++) {
    const a = performance.now();
    for (let i = 0; i < factor * reps; i++) run(small);
    const b = performance.now();
    for (let i = 0; i < reps; i++) run(large);
    const c = performance.now();
    batch = Math.min(batch, b - a);
    large_ = Math.min(large_, c - b);
  }
  const smallMs = batch / (factor * reps);
  const largeMs = large_ / reps;
  return { smallMs, largeMs, ratio: largeMs / Math.max(smallMs, 1e-6) };
}

/** Ceiling on the growth ratio for a 10× input: linear is ~10 (GC and cache
 * effects on the bigger input push it higher, never to 30), quadratic ~100. */
export const LINEAR_RATIO_CEILING_10X = 30;

/** Per-test timeout for a scaling test: a hang guard only, never the
 * assertion — generous enough that a loaded machine never trips it on linear
 * code, while a quadratic regression is caught by the ratio long before. */
export const LINEAR_HANG_GUARD_MS = 60_000;
