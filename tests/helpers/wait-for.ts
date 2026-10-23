// A wait is a DEADLINE inside the test's own timeout, never a fixed sleep and
// never a count of ticks (tests/AGENTS.md "Timeouts under load"). It exits on
// the first true check, so a test that already passes keeps its speed; a miss
// throws "timed out waiting for <what>" instead of failing on a later
// expectation with no hint that it was a timeout.

/** Poll `ok` until it holds, or throw after `ms`. */
export async function waitFor(ok: () => boolean, what: string, ms = 20_000): Promise<void> {
  const deadline = Date.now() + ms;
  while (!ok()) {
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
    await new Promise((r) => setTimeout(r, 20));
  }
}
