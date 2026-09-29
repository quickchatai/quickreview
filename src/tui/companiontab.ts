// Companion startup healing (slice C2; retired the
// companion TAB; retired the full-screen attach behind it; 2026-09-02
// retired every other full-screen path in the TUI too).
//
// What is left is the part that was never about full-screen: the companion's
// startup can FAIL and later HEAL, so asking for it while it is down must
// re-run the startup rather than shrug. The conversation itself now lives in
// the permanent sidebar column (src/tui/sidebar.ts), so once the retry
// succeeds there is nothing to open — the column is already on screen and the
// only thing left to do is give it the keyboard.
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
 * The companion's start, wherever it is asked for — the boot bring-up AND
 * the operator's later retry. The feed / alert / tui-actions channels are
 * wired after the FIRST start that leaves the companion up, whichever path
 * that was: wiring only after a successful BOOT start left a companion healed
 * by retry running with no view feed, no alerts and a dead action channel
 * until the TUI restarted. Wired at most once — every wiring chains pollers.
 */
export function companionStarter(deps: {
  start: () => Promise<void>;
  up: () => boolean;
  wire: () => Promise<void>;
}): () => Promise<void> {
  let wired = false;
  return async () => {
    await deps.start();
    if (wired || !deps.up()) return;
    wired = true;
    await deps.wire();
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
    // "not started" is the last resort — a mislabel here sent the owner looking
    // for a --no-companion flag he had not passed.
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
