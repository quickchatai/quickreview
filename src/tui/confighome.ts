// The deploy tab's config-home half: `deploy.sh sync` ships the
// install's config home — config.toml and the profiles/ beside it — to the VM,
// and the tab says whether the VM runs the one this machine would ship.
// Both ends are fingerprinted by the same script (`scripts/config-fingerprint.sh`,
// over `scripts/install-locator.sh`), locally and inside the container; this
// module only reads and compares the two answers. Pure — shared by the tab's
// render and the companion feed, so the two can never say different things.
// the tab also says WHICH post-scan re-tune a pending profile change
// is, from the setup re-tune log (the type-only S2 leaf `setup/retunelog.js`).
import { retuneLine, type RetuneRecord, type RetunesRead } from "../setup/retunelog.js";

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

// ---- the re-tunes a deploy would ship ------------------------------

/**
 * Which post-scan re-tunes (`<state home>/setup/retunes.json`, written by the
 * companion's `setup_retune`) the VM does NOT run yet. The config drift is the
 * authority on WHETHER the profile is behind; the re-tune log only says WHICH
 * change that is, so it is consulted only while the profile is (or may be)
 * behind:
 *
 *   - drift `same`, `no-home`, or only config.toml changed → none: the VM runs
 *     these profiles (or nothing could ship them);
 *   - `never-shipped` → every logged re-tune that wrote a file is pending;
 *   - profiles `changed` → those written after the VM's last deploy (the
 *     BUILD_SHA marker's time, written on this machine by deploy.sh); with no
 *     readable deploy time, the latest re-tune, as UNKNOWN;
 *   - drift `unknown` → the re-tunes since the last deploy, as UNKNOWN (with
 *     no readable deploy time either, the latest re-tune, as UNKNOWN).
 *
 * An unreadable log is UNKNOWN with its reason, never "no re-tunes".
 */
export type PendingRetunes =
  | { state: "none" }
  | { state: "pending"; retunes: RetuneRecord[] }
  | { state: "unknown"; why: string; retunes: RetuneRecord[] };

export function pendingRetunes(
  log: RetunesRead | undefined,
  drift: ConfigDrift,
  deployedAt: string | undefined,
): PendingRetunes {
  if (drift.kind === "same" || drift.kind === "no-home") return { state: "none" };
  if (drift.kind === "changed" && !drift.profiles) return { state: "none" };
  if (log === undefined || log.state === "absent") return { state: "none" };
  if (log.state === "unreadable") return { state: "unknown", why: log.error, retunes: [] };
  const written = log.retunes.filter((r) => r.files.length > 0);
  if (written.length === 0) return { state: "none" };
  if (drift.kind === "never-shipped") return { state: "pending", retunes: written };
  // Compared as instants, never as strings: the BUILD_SHA marker is written
  // to the second (`…:32Z`) and a re-tune to the millisecond (`…:32.123Z`),
  // so a string compare reads a re-tune in the deploy's own second as shipped.
  const deployed = deployedAt === undefined ? Number.NaN : Date.parse(deployedAt);
  const known = Number.isFinite(deployed);
  const since = known ? written.filter((r) => !(Date.parse(r.at) < deployed)) : [];
  if (!known) {
    const why =
      drift.kind === "unknown"
        ? `${drift.why}; when the VM was last deployed is unknown`
        : "when the VM was last deployed is unknown";
    return { state: "unknown", why, retunes: written.slice(-1) };
  }
  if (drift.kind === "unknown") {
    return since.length === 0
      ? { state: "none" }
      : { state: "unknown", why: drift.why, retunes: since };
  }
  return since.length === 0 ? { state: "none" } : { state: "pending", retunes: since };
}

/** The deploy tab's lines for the pending re-tunes (plain text; the tab inks
 * them). Each re-tune, then each change with its reason. */
export function pendingRetuneLines(p: PendingRetunes): string[] {
  if (p.state === "none") return [];
  const head =
    p.state === "pending"
      ? `${p.retunes.length} post-scan re-tune${p.retunes.length === 1 ? "" : "s"} not deployed — a sync ships ${p.retunes.length === 1 ? "it" : "them"}:`
      : `whether these re-tunes are deployed is unknown — ${p.why}`;
  const out = [head];
  for (const r of p.retunes) {
    out.push(`  ${retuneLine(r)}`);
    for (const c of r.changes) out.push(`    ${c.input}: ${c.from} → ${c.to} — ${c.why}`);
  }
  return out;
}
