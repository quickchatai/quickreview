// The setup checklist's real ports (src/home/setup.ts), and the one function
// that turns a process's environment into them: the env shim
// (extensions/cli/home.ts) calls `homeSetupFromEnv(process.env, VERSION)`.
//
//   first-run checks  the plugin's pi-version and git steps, over a
//                     PluginHost of this process (its PATH, the running pi)
//   repository pick   `gh`: the person's recently pushed repositories, the
//                     chosen one's canonical name and default branch, and the
//                     account's login and name
//   the write         the app config the home's repo port reads
//                     (locateConfig: $QCR_CONFIG, else the install home's
//                     config.toml), patched the way the onboarding config
//                     fill patches it (src/onboard/steps/configfill.ts):
//                     comment-preserving, only the keys that change, never
//                     dry_run. A fresh config starts from the shipped
//                     template, whose dry_run = true it keeps (invariant 6).
//   timezone          the machine's IANA zone, as Intl resolves it
//
// The silent defaults ride on the repository write: the base branch is the
// chosen repository's (always: it belongs to that repository), and the
// timezone and the owner's name and login fill a value only while it is
// empty (or the config is new), so an owner's own choice is never overwritten.
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { assetRoot } from "@quickchatai/pi-quickreview/src/assetroot.js";
import { nodeRunner } from "@quickchatai/pi-quickreview/src/plugin/runner.js";
import type { PluginHost } from "@quickchatai/pi-quickreview/src/plugin/session.js";
import { declaredPiRange } from "@quickchatai/pi-quickreview/src/plugin/versiongate.js";
import { writeAtomic } from "@quickchatai/pi-quickreview/src/setupchecklist.js";
import { locateConfig, stateHome } from "../homes.js";
import { piAgentDir } from "../piagentdir.js";
import { execRunner, type Runner, type RunResult } from "./adapters.js";
import { known, unknown, type Known } from "./ports.js";
import type { HomeSetupPorts, RepoPickPort, RepoWrite } from "./setup.js";

type Env = Readonly<Record<string, string | undefined>>;

const firstLine = (s: string): string => s.trim().split("\n")[0]?.trim() || "no output";
const message = (err: unknown): string => (err instanceof Error ? err.message : String(err));

/** gh's words for "you are not signed in". */
const SIGNED_OUT = /gh auth login|not logged in|authentication required|HTTP 401|bad credentials/i;

function ghWhy(r: RunResult): string {
  if (r.missing) return "gh is not installed";
  if (SIGNED_OUT.test(r.stderr)) return "gh is signed out: run `gh auth login`";
  return firstLine(r.stderr);
}

/** The machine's IANA timezone, or null when Intl cannot say. */
export function systemTimezone(): string | null {
  try {
    const tz = Intl.DateTimeFormat().resolvedOptions().timeZone;
    return typeof tz === "string" && tz !== "" ? tz : null;
  } catch {
    return null;
  }
}

/** A file's text; null only when it does not exist. Any other failure
 * throws: a config that exists and cannot be read is never "no config", or
 * the template would be written over it. */
function readIfThere(path: string): string | null {
  try {
    return readFileSync(path, "utf8");
  } catch (err) {
    if ((err as NodeJS.ErrnoException | null)?.code === "ENOENT") return null;
    throw err;
  }
}

export function repoPickPort(o: {
  runner: Runner;
  configPath: () => string;
  templatePath: () => string;
  read?: (path: string) => string | null;
  write?: (path: string, text: string) => void;
}): RepoPickPort {
  const read = o.read ?? readIfThere;
  const write = o.write ?? writeAtomic;
  return {
    recent: async () => {
      const r = await o.runner.run("gh", [
        "repo",
        "list",
        "--limit",
        "8",
        "--json",
        "nameWithOwner",
      ]);
      if (r.code !== 0) return unknown(ghWhy(r));
      try {
        const rows = JSON.parse(r.stdout) as unknown;
        if (!Array.isArray(rows)) return unknown("gh's answer is not a list");
        return known(
          rows.flatMap((x: { nameWithOwner?: unknown }) =>
            typeof x?.nameWithOwner === "string" ? [x.nameWithOwner] : [],
          ),
        );
      } catch (err) {
        return unknown(`gh's answer is not JSON: ${message(err)}`);
      }
    },
    describe: async (repo) => {
      const r = await o.runner.run("gh", [
        "repo",
        "view",
        repo,
        "--json",
        "nameWithOwner,defaultBranchRef",
      ]);
      if (r.code !== 0) return { ok: false, why: ghWhy(r) };
      try {
        const v = JSON.parse(r.stdout) as {
          nameWithOwner?: unknown;
          defaultBranchRef?: { name?: unknown } | null;
        };
        const branch = v.defaultBranchRef?.name;
        return {
          ok: true,
          repo: typeof v.nameWithOwner === "string" ? v.nameWithOwner : repo,
          defaultBranch: typeof branch === "string" && branch !== "" ? branch : null,
        };
      } catch (err) {
        return { ok: false, why: `gh's answer is not JSON: ${message(err)}` };
      }
    },
    profile: async (): Promise<Known<{ login: string; name: string | null }>> => {
      const r = await o.runner.run("gh", ["api", "user"]);
      if (r.code !== 0) return unknown(ghWhy(r));
      try {
        const v = JSON.parse(r.stdout) as { login?: unknown; name?: unknown };
        if (typeof v.login !== "string") return unknown("gh's account has no login");
        return known({
          login: v.login,
          name: typeof v.name === "string" && v.name.trim() !== "" ? v.name.trim() : null,
        });
      } catch (err) {
        return unknown(`gh's answer is not JSON: ${message(err)}`);
      }
    },
    write: async (choice): Promise<RepoWrite> => {
      let path: string;
      try {
        path = o.configPath();
      } catch (err) {
        return { ok: false, why: message(err) };
      }
      let existing: string | null;
      let template: string | null = "";
      try {
        existing = read(path);
      } catch (err) {
        return { ok: false, why: `can't read ${path} (${message(err)}); nothing was written` };
      }
      try {
        if (existing === null) template = read(o.templatePath());
      } catch {
        template = null;
      }
      if (template === null)
        return { ok: false, why: `there is no ${path} and the shipped template is not readable` };
      // the config fill's writer, loaded only when a repository is written
      const { renderRepoConfig } = await import("../onboard/steps/repoconfig.js");
      const r = renderRepoConfig(existing, template, choice);
      if (!r.ok) return r;
      try {
        if (r.text !== existing) write(path, r.text);
      } catch (err) {
        return { ok: false, why: `can't write ${path}: ${message(err)}` };
      }
      return { ok: true, path, wrote: r.wrote };
    },
  };
}

/** The PluginHost the first-run checks read: this process's PATH and the
 * running pi (its version, which the env shim reads off pi). Only the
 * plugin's pi-version and git steps run over it, so its auth answers
 * nothing. */
export function firstRunHost(env: Env, piVersion: string): PluginHost {
  return {
    cwd: join(stateHome(env), "home"),
    env,
    home: (env["HOME"] ?? "").trim() || homedir(),
    piVersion,
    agentDir: piAgentDir(env),
    auth: {
      logins: () => ({}),
      configured: () => false,
      refresh: () => Promise.reject(new Error("the home's first-run checks hold no login")),
    },
    runner: nodeRunner(env),
    shutdown: new AbortController().signal,
  };
}

/** The setup's options from a process's environment and the running pi's
 * version: the env shim's one call. */
export function homeSetupFromEnv(env: Env, piVersion: string): HomeSetupPorts {
  let range: string | null = null;
  try {
    range = declaredPiRange();
  } catch {
    range = null;
  }
  return {
    ...(range !== null ? { firstRun: { host: firstRunHost(env, piVersion), range } } : {}),
    repos: repoPickPort({
      runner: execRunner,
      configPath: () => locateConfig({ env }).path,
      templatePath: () => join(assetRoot(), "config.example.toml"),
    }),
    timezone: systemTimezone,
  };
}
