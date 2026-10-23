// Before `qcr review` spends anything: does pi hold a credential for every
// provider the review's models run on? A login in pi's agent dir counts, and
// so does the provider's own API key in the environment. An API key for some
// OTHER provider never does: the review runs on the models its config names,
// or not at all, and it never switches models to use a key. The refusal names
// `qcr login`, the way to get the login.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  loginSummary,
  RUNTIME_KEY_ENVS,
  type LoginSummary,
} from "@quickchatai/pi-quickreview/src/engine/auth.js";

/** pi's stored logins in `agentDir`; empty when it holds none. */
export function readLogins(
  agentDir: string,
  read: (path: string) => string = (p) => readFileSync(p, "utf8"),
): LoginSummary {
  try {
    return loginSummary(read(join(agentDir, "auth.json")));
  } catch {
    return {};
  }
}

/** Why the review cannot run on this machine's credentials, or null when
 * every provider it needs has one. */
export function reviewLoginRefusal(o: {
  providers: readonly string[];
  agentDir: string;
  env: Readonly<Record<string, string | undefined>>;
  logins?: LoginSummary;
}): string | null {
  const logins = o.logins ?? readLogins(o.agentDir);
  const keyOf = (p: string): string | null => {
    const name = RUNTIME_KEY_ENVS[p];
    return name !== undefined && (o.env[name] ?? "").trim() !== "" ? name : null;
  };
  for (const p of o.providers) {
    if (logins[p] !== undefined || keyOf(p) !== null) continue;
    const otherKeys = Object.keys(RUNTIME_KEY_ENVS)
      .filter((q) => q !== p)
      .map(keyOf)
      .filter((k): k is string => k !== null);
    const keys =
      otherKeys.length > 0
        ? ` ${otherKeys.join(" and ")} ${otherKeys.length === 1 ? "is" : "are"} set, and the review does not switch models to use ${otherKeys.length === 1 ? "it" : "them"}: to review on another provider, set the review's models to it in your qcr config.`
        : "";
    return (
      `the review runs on ${p}, and pi has no login for it (pi's agent dir ${o.agentDir}). ` +
      `Run \`qcr login\` to log in with pi's own /login, then review again.${keys}`
    );
  }
  return null;
}
