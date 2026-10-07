// One real event-loop turn, for daemon work that walks a long list on the
// loop's own thread (boot stall, 2026-10-07).
//
// `await` on a promise that is already settled — or that settles from
// synchronous work, like an `async` function with no real I/O inside — runs
// its continuation on the MICROTASK queue, before any timer, socket or HTTP
// request gets a turn. A `for … await` loop over such calls is therefore one
// synchronous span however many `await`s it contains: that is how 2,548
// receipt reads became a single 132.7 s block of the daemon. `setImmediate`
// is a MACROTASK: everything already waiting runs first.
export function yieldToLoop(): Promise<void> {
  return new Promise((resolve) => setImmediate(resolve));
}
