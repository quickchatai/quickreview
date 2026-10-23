// One real event-loop turn, for daemon work that walks a long list on the
// loop's own thread.
//
// `await` on a promise that is already settled — or that settles from
// synchronous work, like an `async` function with no real I/O inside — runs
// its continuation on the microtask queue, before any timer, socket or HTTP
// request gets a turn. A `for … await` loop over such calls is therefore one
// synchronous span however many `await`s it contains, and can block the
// daemon for minutes. `setImmediate` is a macrotask: everything already
// waiting runs first.
export function yieldToLoop(): Promise<void> {
  return new Promise((resolve) => setImmediate(resolve));
}
