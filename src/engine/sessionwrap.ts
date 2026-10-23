// A RuntimeSession that runs one more step when it is disposed: a route that
// puts something beside a session (a process env scope, a live log) ends it
// there, whoever disposes the session.
import type { RuntimeSession } from "./port.js";

/** A session that runs `after` once, when it is disposed. */
export function releasing(session: RuntimeSession, after: () => void): RuntimeSession {
  return {
    get id() {
      return session.id;
    },
    get sessionFile() {
      return session.sessionFile;
    },
    prompt: (text, options) => session.prompt(text, options),
    followUp: (text, options) => session.followUp(text, options),
    steer: (text, options) => session.steer(text, options),
    abort: () => session.abort(),
    subscribe: (listener, options) => session.subscribe(listener, options),
    ...(session.compact ? { compact: () => session.compact!() } : {}),
    stats: () => session.stats(),
    dispose: async () => {
      try {
        await session.dispose();
      } finally {
        after();
      }
    },
  };
}
