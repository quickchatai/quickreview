// Companion startup healing.
//
// The companion's startup can fail and later heal, so asking for it while it
// is down must re-run the startup rather than shrug. The conversation itself
// lives in the permanent sidebar column (src/tui/sidebar.ts), so once the
// retry succeeds there is nothing to open — the column is already on screen
// and the only thing left to do is give it the keyboard.
import type { App } from "./app.js";
import type { CompanionLifecycle } from "./companion.js";

export interface CompanionTabDeps {
  lifecycle: CompanionLifecycle;
  /** Live view of the companion's state — startup may fail and later heal. */
  available: () => boolean;
  /** The real startup error when unavailable (never a mislabel). */
  failure?: () => string | undefined;
  /** Re-runs the full startup (build image if missing, up, rollover, spawn). */
  retry?: () => Promise<void>;
}

/**
 * The companion's start, wherever it is asked for — the boot bring-up and
 * the operator's later retry. The feed / alert / tui-actions channels are
 * wired after the first start that leaves the companion up, whichever path
 * that was, so a companion healed by retry gets its view feed, alerts and
 * action channel too. Wired at most once — every wiring chains pollers.
 *
 * A start asked for while another is still in flight joins it rather than
 * starting again: two overlapping starts each run the day rollover, and the
 * later one kills the conversation the earlier one just spawned.
 */
export function companionStarter(deps: {
  start: () => Promise<void>;
  up: () => boolean;
  wire: () => Promise<void>;
}): () => Promise<void> {
  let wired = false;
  let inFlight: Promise<void> | undefined;
  const once = async (): Promise<void> => {
    await deps.start();
    if (wired || !deps.up()) return;
    wired = true;
    await deps.wire();
  };
  return () => {
    inFlight ??= once().finally(() => {
      inFlight = undefined;
    });
    return inFlight;
  };
}

export function installCompanionTabHooks(app: App, deps: CompanionTabDeps): void {
  let retrying = false;

  app.hooks.companionEnsure = async (theApp) => {
    if (deps.available()) {
      theApp.focusCompanion();
      return;
    }
    // No retry wired, or one already in flight: say what is actually wrong.
    // "not started" is the last resort — a mislabel here points the operator
    // at a cause (such as a --no-companion flag) that is not the real one.
    if (retrying || !deps.retry) {
      theApp.notice(`companion not running: ${deps.failure?.() ?? "not started"}`);
      return;
    }
    retrying = true;
    theApp.notice("companion starting…");
    theApp.repaint();
    try {
      await deps.retry();
    } finally {
      retrying = false;
    }
    theApp.repaint();
    if (!deps.available()) {
      theApp.notice(`companion not running: ${deps.failure?.() ?? "not started"}`);
      return;
    }
    theApp.focusCompanion();
  };
}
