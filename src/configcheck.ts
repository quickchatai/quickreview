// `qcr config check` — load a config home through config.ts with every
// refusal it has (retired keys included) and report ALL the errors, not the
// first. The VM's updater (deploy/qcr-update.sh) runs it with the NEW image on
// the staged config home BEFORE it stops anything, so a config the new build
// would refuse changes nothing on the VM.
//
// A config home is `config.toml` plus the `profiles/` beside it. The check is
// the daemon's own boot reading, without a daemon: `parseConfig` and
// `validateSlackConfig`, then every profile loader the boot runs over the
// profile the config names (its `extends` chain included). Profiles resolve
// from that home and the image's generic examples only, never the operator's
// own XDG home, so the answer is the VM's.
import { existsSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { parseConfig, sandboxRoot, validateSlackConfig } from "./config.js";
import { homeProfileLookup } from "./install.js";
import {
  loadProfileAddenda,
  loadProfileEcosystem,
  loadProfileHeuristics,
  loadProfileLensTuning,
  loadProfilePosting,
  loadProfileScan,
  type ProfileLookup,
} from "@quickchatai/pi-quickreview/src/profiles.js";

export const CONFIG_FILE_NAME = "config.toml";

export interface ConfigCheckError {
  /** What was being read when it failed: the config file, or a profile loader. */
  where: string;
  message: string;
}

export interface ConfigCheckResult {
  ok: boolean;
  config_home: string;
  errors: ConfigCheckError[];
}

function messageOf(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

export function checkConfigHome(opts: { home: string; root?: string }): ConfigCheckResult {
  const home = resolve(opts.home);
  const root = opts.root ?? sandboxRoot();
  const errors: ConfigCheckError[] = [];
  const result = (): ConfigCheckResult => ({ ok: errors.length === 0, config_home: home, errors });

  const file = join(home, CONFIG_FILE_NAME);
  if (!existsSync(file)) {
    errors.push({ where: file, message: `no ${CONFIG_FILE_NAME} in the config home` });
    return result();
  }
  let profile = "";
  try {
    const cfg = parseConfig(readFileSync(file, "utf8"));
    validateSlackConfig(cfg);
    profile = cfg.review.profile;
  } catch (err) {
    // The config did not load: its profile name is unknown, so no profile
    // loader can run. This is the one error there is.
    errors.push({ where: file, message: messageOf(err) });
    return result();
  }
  if (profile === "") return result();

  // Only this home's profiles/ and the image's generic examples are searched:
  // an XDG home that does not exist keeps the operator's own out of the answer.
  const lookup: ProfileLookup = homeProfileLookup({
    ...process.env,
    QCR_CONFIG: file,
    XDG_CONFIG_HOME: join(home, ".no-xdg-home"),
  });
  const loaders: Array<[string, () => unknown]> = [
    ["addenda", () => loadProfileAddenda(root, profile, lookup)],
    ["ecosystem", () => loadProfileEcosystem(root, profile, lookup)],
    ["lens tuning", () => loadProfileLensTuning(root, profile, lookup)],
    ["scan", () => loadProfileScan(root, profile, lookup)],
    ["posting", () => loadProfilePosting(root, profile, lookup)],
    ["heuristics", () => loadProfileHeuristics(root, profile, lookup)],
  ];
  const seen = new Set<string>();
  for (const [what, load] of loaders) {
    try {
      load();
    } catch (err) {
      const message = messageOf(err);
      // A missing profile fails every loader the same way: say it once.
      if (seen.has(message)) continue;
      seen.add(message);
      errors.push({ where: `profile ${profile} (${what})`, message });
    }
  }
  return result();
}

const CONFIG_USAGE = "usage: qcr config check [--json] [--config-home <dir>]";

/** The verb: `qcr config check [--json] [--config-home <dir>]`. Exit 0 on a
 * clean home, 1 on any error, 2 on a usage error. */
export function cmdConfig(
  rest: string[],
  json: boolean,
  deps: { defaultHome: () => string; out?: (line: string) => void; root?: string },
): number {
  const out = deps.out ?? ((l: string) => console.log(l));
  const [verb, ...args] = rest;
  if (verb !== "check") {
    out(CONFIG_USAGE);
    return 2;
  }
  let home: string | undefined;
  for (let i = 0; i < args.length; i++) {
    if (args[i] === "--config-home" && args[i + 1] !== undefined) {
      home = args[++i];
    } else {
      out(CONFIG_USAGE);
      return 2;
    }
  }
  const res = checkConfigHome({ home: home ?? deps.defaultHome(), root: deps.root });
  if (json) {
    out(JSON.stringify(res));
  } else if (res.ok) {
    out(`config ok: ${res.config_home}`);
  } else {
    for (const e of res.errors) out(`${e.where}: ${e.message}`);
    out(`config check failed: ${res.errors.length} error(s) in ${res.config_home}`);
  }
  return res.ok ? 0 : 1;
}
