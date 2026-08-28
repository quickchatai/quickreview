import type { App } from "./app.js";

/** Compose one observer after the existing poll chain. A feature must never
 * assign `hooks.onPoll` without preserving prior observers: feed, evidence,
 * alerts and deploy coordination all share this one cadence. */
export function chainOnPoll(app: App, fn: (app: App) => void): void {
  const previous = app.hooks.onPoll;
  app.hooks.onPoll = (theApp) => {
    previous?.(theApp);
    fn(theApp);
  };
}
