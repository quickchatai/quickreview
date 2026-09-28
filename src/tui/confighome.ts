// The deploy tab's config-home half: `deploy.sh sync` ships the
// install's config home — config.toml and the profiles/ beside it — to the VM,
// and the tab says whether the VM runs the one this machine would ship.
// Both ends are fingerprinted by the same script (`scripts/config-fingerprint.sh`,
// over `scripts/install-locator.sh`), locally and inside the container; this
// module only reads and compares the two answers. Pure — shared by the tab's
// render and the companion feed, so the two can never say different things.

/** `scripts/config-fingerprint.sh` output: what a config home ships, as the
 * config file's hash and one hash over every file under its profiles/. */
export interface ConfigFingerprint {
  config: string;
  profiles: string;
}

/** One end's config home: its fingerprint; `"none"` when that end has no
 * shippable home (the PC: only a checkout config, so deploy.sh refuses; the
 * VM: nothing was ever shipped, it reads its checkout config); or
 * `"unparseable"` when the script answered something else. */
export type ConfigRead = ConfigFingerprint | "none" | "unparseable";

export function parseConfigFingerprint(stdout: string): ConfigRead {
  const text = stdout.trim();
  if (text === "none") return "none";
  const m = /^config=([0-9a-f]{64}) profiles=([0-9a-f]{64})$/.exec(text);
  return m ? { config: m[1]!, profiles: m[2]! } : "unparseable";
}

/**
 * Does the VM run the config home this machine would ship? Honest-unknown both
 * ways: an end that was not read, or read as garbage, makes the
 * answer `unknown` — never "matches" (that would hide an undeployed profile)
 * and never "changed" (that would invent one).
 */
export type ConfigDrift =
  | { kind: "unknown"; why: string }
  | { kind: "no-home" }
  | { kind: "never-shipped" }
  | { kind: "same" }
  | { kind: "changed"; config: boolean; profiles: boolean };

export function configDrift(local?: ConfigRead, deployed?: ConfigRead): ConfigDrift {
  if (local === undefined)
    return { kind: "unknown", why: "the local config home could not be fingerprinted" };
  if (local === "unparseable")
    return { kind: "unknown", why: "the local config home's fingerprint was unreadable" };
  if (local === "none") return { kind: "no-home" };
  if (deployed === undefined)
    return { kind: "unknown", why: "the VM's config home could not be read (ssh/docker failed)" };
  if (deployed === "unparseable")
    return { kind: "unknown", why: "the VM's config home fingerprint was unreadable" };
  if (deployed === "none") return { kind: "never-shipped" };
  const config = local.config !== deployed.config;
  const profiles = local.profiles !== deployed.profiles;
  return config || profiles ? { kind: "changed", config, profiles } : { kind: "same" };
}

/** The one sentence for a drift — painted in the tab and published to the
 * companion, so the two can never say different things. */
export function configDriftText(d: ConfigDrift): string {
  switch (d.kind) {
    case "unknown":
      return `unknown — ${d.why}; r retries`;
    case "no-home":
      return "no config home on this machine — deploy refuses until there is one (`qcr install migrate` moves a checkout config.toml there)";
    case "never-shipped":
      return "config home not deployed — the VM still reads its checkout config (the next sync ships the home)";
    case "same":
      return "config home deployed — the VM runs this config and these profiles";
    case "changed":
      return d.profiles && d.config
        ? "config.toml and profile changed, not deployed"
        : d.profiles
          ? "profile changed, not deployed"
          : "config.toml changed, not deployed";
  }
}
