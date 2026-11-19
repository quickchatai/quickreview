// The first questions every host verb asks. May it run here at all
// (src/host/session.ts says where it may, and why)? And, for the verbs that
// act for a host's attested operator, is this an install a host manages?
// A refusal changes nothing.
import { hostManagedToml } from "../hostmanaged.js";
import { refused, type HostAnswer } from "./outcomes.js";
import type { HostPorts } from "./ports.js";
import { sessionMarker } from "./session.js";

/** The refusal for a verb started where none may run, or null. Reads
 * nothing but its own environment. */
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

/**
 * Does the install's config, as written, say a host manages it
 * (`[github] token_source = "host"`, src/hostmanaged.ts)? A config that is
 * absent, unreadable or not TOML carries no marker.
 *
 * The attested operator exists only on such an install: there the person who
 * owns `dry_run` is the one a host authenticated, and the host's word is what
 * the reviewer has of their confirm. On any other install the owner confirms
 * at the home, in their own words, and an attestation admits nothing.
 */
export function hostManaged(ports: Pick<HostPorts, "read" | "configPath">): boolean {
  try {
    return hostManagedToml(ports.read(ports.configPath));
  } catch {
    return false;
  }
}

/** The refusal for a verb that acts only on an install a host manages. */
export const notHostManaged = (what: string): HostAnswer =>
  refused(
    "not_host_managed",
    `${what}: its config does not carry [github] token_source = "host", and a host verb never makes an install host-managed. Nothing changed`,
  );
