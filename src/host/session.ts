// Where a host verb may run: on the machine that runs the stack, from a
// host's own process, and nowhere an agent is.
//
// A host verb acts for a person a host has authenticated. An agent session is
// not that person, whoever started it, so every verb refuses when the process
// was started from one. Each session this system starts marks the environment
// of everything it runs:
//
//   QCR_SESSION_NAME   a review session (the daemon's, src/sessions.ts; a
//                      one-shot round's, packages/pi-plugin/src/engine/round.ts)
//                      and the companion's (src/tui/companion.ts)
//   QCR_SESSION        the companion's
//   QCR_PR             a review session's pull request
//   QCR_HOME_TOOLS     the home's own pi (src/home/launch.ts): the person is
//                      there, and so is an agent that can run a command
//
// The second wall is the place. Review sessions run inside the daemon's
// container, which carries no Docker and mounts the config read-only: there a
// host verb is not on the host at all, and refuses for that alone.
//
// A leaf: the names are held to the modules that set them by
// tests/host-fences.test.ts.

/** The environment names that mark a process as started from an agent
 * session. */
export const SESSION_ENV_MARKERS = [
  "QCR_SESSION_NAME",
  "QCR_SESSION",
  "QCR_PR",
  "QCR_HOME_TOOLS",
] as const;

/** The marker this environment carries, or null: no session started it. */
export function sessionMarker(env: Readonly<Record<string, string | undefined>>): string | null {
  for (const name of SESSION_ENV_MARKERS) if ((env[name] ?? "").trim() !== "") return name;
  return null;
}
