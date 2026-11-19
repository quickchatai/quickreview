// The first question every host verb asks: may it run here at all?
// (src/host/session.ts says where it may, and why.) A refusal changes nothing
// and reads nothing.
import { refused, type HostAnswer } from "./outcomes.js";
import type { HostPorts } from "./ports.js";
import { sessionMarker } from "./session.js";

/** The refusal for a verb started where none may run, or null. */
export function admit(ports: Pick<HostPorts, "env" | "inImage">): HostAnswer | null {
  const marker = sessionMarker(ports.env);
  if (marker !== null)
    return refused(
      "in_session",
      `a host verb is not run from inside an agent session (${marker} is set): a host calls it from its own process, for the person it authenticated. Nothing changed`,
    );
  if (ports.inImage)
    return refused(
      "not_on_host",
      "a host verb runs on the machine that runs the reviewer's stack, never inside its container. Nothing changed",
    );
  return null;
}
