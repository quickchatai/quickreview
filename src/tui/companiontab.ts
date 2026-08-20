// Companion attach (slice C2; retired the companion TAB).
// The full-screen conversation with the local companion: the same
// AttachScreen the PR sessions use, with the local `docker exec -it … tmux
// attach` argv from CompanionLifecycle instead of the ssh one. Reached from
// the strip's mirror rows and the alert badge — never from a tab. Detaching
// (Ctrl-q) drops straight back to whatever tab was up.
import { AttachScreen, type PtySpawner } from "./attach.js";
import type { App } from "./app.js";
import type { CompanionLifecycle } from "./companion.js";

export interface CompanionTabDeps {
  lifecycle: CompanionLifecycle;
  spawner: PtySpawner;
  /** Live view of the companion's state — startup may fail and later heal. */
  available: () => boolean;
  /** The real startup error when unavailable (never a mislabel). */
  failure?: () => string | undefined;
  /** Re-runs the full startup (build image if missing, up, rollover, spawn). */
  retry?: () => Promise<void>;
  /** Terminal the attach takes over; injectable so tests own their streams. */
  out?: NodeJS.WriteStream;
  input?: NodeJS.ReadStream;
}

export function installCompanionTabHooks(app: App, deps: CompanionTabDeps): void {
  let attached = false;
  let retrying = false;

  app.hooks.companionAttach = async (theApp) => {
    if (attached) return;
    if (!deps.available()) {
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
    }
    attached = true;
    try {
      // The session name is only a label here — the argv already points at the
      // local container's tmux session.
      await new AttachScreen(
        deps.lifecycle.cfg.session,
        theApp,
        deps.spawner,
        deps.out ?? process.stdout,
        deps.input ?? process.stdin,
        deps.lifecycle.attachArgv(),
      ).run();
    } finally {
      attached = false;
      theApp.repaint();
    }
  };
}
