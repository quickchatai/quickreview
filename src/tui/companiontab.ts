// Companion tab (slice C2) — tab `3` (or `c`) is the conversation
// with the local companion. There is nothing to render on it beyond the
// session itself, so entering the tab attaches: the same AttachScreen the PR
// sessions use, with the local `docker exec -it … tmux attach` argv from
// CompanionLifecycle instead of the ssh one. Detaching (Ctrl-q) drops back to
// this tab's resting screen, one ⏎ from re-attaching.
import { AttachScreen, type PtySpawner } from "./attach.js";
import type { App } from "./app.js";
import type { CompanionLifecycle } from "./companion.js";
import { CLEAR, Frame, SGR, rule } from "./paint.js";
import { FG, RESET } from "./theme.js";

/** The resting screen: what the tab shows while nothing is attached. */
export function renderCompanionRest(app: App, cols: number, rows: number, hint: string): string {
  const frame = new Frame(cols, rows);
  frame.set(0, rule(cols, "┌", "┐", [`${SGR.bold}companion${SGR.reset}`, hint]));
  const latest = app.view.alerts?.latest;
  const lines = [
    "",
    `  ${FG.accent}${SGR.bold}COMPANION${RESET} ${FG.dim}your conversation about the pipeline${RESET}`,
    "",
    `  ${FG.dim}⏎${RESET} attach the companion session   ${FG.dim}Ctrl-q${RESET} back here   ${FG.dim}1${RESET} board`,
    "",
    latest
      ? `  latest alert: ${latest.tier === "alert" ? FG.anomaly : FG.accent}${latest.title}${RESET}${latest.pr !== null ? ` (#${latest.pr})` : ""}`
      : `  ${FG.dim}no alerts today${RESET}`,
  ];
  for (let r = 1; r < rows - 1; r++) frame.boxRow(r, [{ text: lines[r - 1] ?? "", width: cols - 2 }]);
  frame.set(rows - 1, rule(cols, "└", "┘", []));
  return CLEAR + frame.render();
}

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
  app.hooks.companionScreen = (theApp, cols, rows) => {
    if (deps.available()) return renderCompanionRest(theApp, cols, rows, attached ? "attached" : "detached — ⏎ attach");
    if (retrying) return renderCompanionRest(theApp, cols, rows, "starting…");
    const why = deps.failure?.() ?? "not started";
    return renderCompanionRest(theApp, cols, rows, `not running: ${why} — ⏎ retry`);
  };

  app.hooks.companionAttach = async (theApp) => {
    if (attached) return;
    if (!deps.available()) {
      if (retrying || !deps.retry) return;
      retrying = true;
      theApp.repaint();
      try {
        await deps.retry();
      } finally {
        retrying = false;
      }
      theApp.repaint();
      if (!deps.available()) return;
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
      // Ctrl-q means "back to the board" — the companion tab is always pi,
      // never a resting screen you have to ⏎ through (the owner, 2026-08-14).
      if (theApp.tab === "companion") theApp.tab = "board";
      theApp.repaint();
    }
  };
}
