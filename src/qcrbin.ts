// The `qcr` bin's front door (bin/qcr.js). The app's entry, src/cli.ts, loads
// the whole operator CLI, the state database's SQLite driver among it; the
// verbs a person runs from an npm install are routed here first and load only
// what they use, so they work where that native driver, an optional
// dependency, cannot load (src/sqlitehint.ts SQLITE_FREE_VERBS, pinned by
// tests/sqlite-free-routes.test.ts):
//
//   qcr                the home: the app's own pi (src/home/launch.ts)
//   qcr tui            the admin TUI (src/cli.ts)
//   qcr version        the install's identity (src/version.ts)
//   qcr review …       a daemonless review (src/reviewcli.ts)
//   qcr scan …         a scan of the repository (src/scancli.ts)
//   qcr login [p]      pi's own /login in the pinned pi (src/npmverbs.ts)
//   qcr pi [args]      the pinned pi with the qcr plugin and /selfimprove
//   qcr update         the installing package manager updates qcr
//
// `qcr --schema N review|scan|version …` is a host plugin's call: the verb
// in contract N's JSON, or a refusal (src/schemaflag.ts), and no update
// notice.
//
// Every other verb goes to src/cli.ts `main` unchanged. The image's
// `node /opt/qcr/dist/src/cli.js` never comes through here. Run as a script
// itself (`node dist/src/qcrbin.js`), this module is the bin: the detached
// review driver and its watchdog start that way (src/reviewdetach.ts), so
// they too run without the driver. After a verb, a
// newer published version is mentioned once on stderr (src/updatenotice.ts).
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { isEntryModule } from "./entrymodule.js";
import { isSqliteUnavailable, sqliteHint } from "./sqlitehint.js";
import { fsDeniedLine } from "./fsdenied.js";
import { MissingConfigError } from "./missingconfig.js";
import { parseSchemaFlag } from "./schemaflag.js";

/** The bin's own lines on top of the app's usage (`qcr help`). */
export const BIN_HELP = [
  "qcr — QuickReview",
  "",
  "  qcr                     open the home: pi with the plugin and your pull requests",
  "  qcr tui                 open the admin TUI",
  "  qcr review [target]     review code here, with no daemon (`qcr review --help`)",
  "  qcr scan <subcommand>   scan the whole repository for findings (`qcr scan` prints its usage)",
  "  qcr login [provider]    log in with pi's own /login, for the review sessions",
  "  qcr pi [args]           pi with the qcr plugin (/qcr-review, /qcr-scan, /qcr-setup) and /selfimprove",
  "  qcr update              update qcr with the package manager that installed it",
  "  qcr version [--json]    this install's version, schemas and pi pin",
  "  qcr --schema N <verb>   review, scan or version as JSON in host-plugin contract N",
  "",
  "Every app verb:",
].join("\n");

/** The verbs that never print the update notice: the ones that hand the
 * terminal over (the home, the TUI, pi) or are about versions themselves. */
const QUIET_VERBS = new Set(["home", "tui", "pi", "update", "version", "login"]);

/** What `runBin` would do with `argv`, before doing it. */
export type BinRoute =
  | { route: "home" }
  | { route: "help" }
  | { route: "pi"; args: string[] }
  | {
      route: "version" | "update" | "login" | "review" | "scan";
      args: string[];
      json: boolean;
      /** The host-plugin contract a `--schema N` run asked for. */
      schema?: number;
    }
  /** `--schema` refused before any verb ran: the line goes to stderr. */
  | { route: "refused"; code: 2 | 3; line: string }
  | { route: "app"; argv: string[] };

export function binRoute(argv: readonly string[]): BinRoute {
  const schema = parseSchemaFlag(argv);
  if (schema.kind === "refused") return { route: "refused", code: schema.code, line: schema.line };
  if (schema.kind === "ok") {
    const [verb, ...args] = schema.argv;
    return {
      route: verb as "review" | "scan" | "version",
      args,
      json: true,
      schema: schema.contract,
    };
  }
  if (argv.length === 0 || (argv.length === 1 && argv[0] === "home")) return { route: "home" };
  // pi's arguments are pi's, `--json` included
  if (argv[0] === "pi") return { route: "pi", args: argv.slice(1) };
  // `qcr message` carries free text: src/cli.ts reads its argv as it is
  if (argv[0] === "message") return { route: "app", argv: [...argv] };
  const json = argv.includes("--json");
  const rest = argv.filter((a) => a !== "--json");
  const [cmd, ...args] = rest;
  if (cmd === "help" || cmd === "--help" || cmd === "-h") return { route: "help" };
  if (
    cmd === "version" ||
    cmd === "update" ||
    cmd === "login" ||
    cmd === "review" ||
    cmd === "scan"
  )
    return { route: cmd, args, json };
  return { route: "app", argv: [...argv] };
}

async function appMain(argv: string[]): Promise<void> {
  const { main } = await import("./cli.js");
  await main(argv);
}

/** The GitHub token handed over as a file (packages/pi-plugin/src/ghcred.ts):
 * read and unlinked before a review can start a child, as src/cli.ts `main`
 * does for its verbs. False (and said) when it cannot be taken. */
async function takeHandoff(json: boolean): Promise<boolean> {
  const { takeHandoffToken } = await import("@quickchatai/pi-quickreview/src/ghcred.js");
  try {
    takeHandoffToken();
    return true;
  } catch (err) {
    const error = `the GitHub token handoff failed: ${err instanceof Error ? err.message : String(err)}`;
    if (json) console.log(JSON.stringify({ error }));
    else console.error(`qcr: ${error}`);
    return false;
  }
}

async function packageRoot(): Promise<string> {
  const { sandboxRoot } = await import("./config.js");
  return sandboxRoot();
}

/** The update notice after a verb, when one is due (never throws). */
async function maybeNotice(json: boolean): Promise<void> {
  try {
    const [{ updateNotice, updateCachePath, spawnRefresh }, { detectInstall, CLI_PACKAGE }] =
      await Promise.all([import("./updatenotice.js"), import("./npmverbs.js")]);
    const { stateHome } = await import("./homes.js");
    const { readFileSync, realpathSync } = await import("node:fs");
    const root = realpathSync(await packageRoot());
    const pkg = JSON.parse(readFileSync(join(root, "package.json"), "utf8")) as {
      version?: unknown;
    };
    const cachePath = updateCachePath(stateHome());
    const line = updateNotice({
      current: typeof pkg.version === "string" ? pkg.version : "0.0.0",
      cachePath,
      env: process.env,
      tty: Boolean(process.stderr.isTTY),
      json,
      installed: detectInstall(root, process.env).kind === "global",
      now: Date.now(),
      refresh: () => spawnRefresh(cachePath, CLI_PACKAGE),
    });
    if (line !== null) console.error(line);
  } catch {
    // the notice is a courtesy: it never costs the verb
  }
}

async function route(r: BinRoute): Promise<void> {
  switch (r.route) {
    case "home": {
      const { homeRunDeps, runHome } = await import("./home/launch.js");
      process.exitCode = runHome(homeRunDeps(await packageRoot()));
      return;
    }
    case "help":
      console.log(BIN_HELP);
      try {
        await appMain(["help"]);
      } catch {
        // the app's usage then loads the config to surface its errors, and a
        // fresh install has none: the usage above is the answer
      }
      return;
    case "version": {
      const { cmdVersion } = await import("./version.js");
      return cmdVersion(r.json);
    }
    case "review": {
      if (!(await takeHandoff(r.json))) {
        process.exitCode = 1;
        return;
      }
      const { cmdReview } = await import("./reviewcli.js");
      const { openReviewMemoryPortAt } = await import("./reviewmemory.js");
      process.exitCode = await cmdReview(r.args, r.json, { memory: openReviewMemoryPortAt });
      return;
    }
    case "scan": {
      // What src/cli.ts `main` gives it: the token handoff, then the scan
      // CLI, which reads its homes and config itself. Usage errors are its
      // own exit code 2.
      if (!(await takeHandoff(r.json))) {
        process.exitCode = 1;
        return;
      }
      const { cmdScan } = await import("./scancli.js");
      process.exitCode = await cmdScan(r.args, r.json);
      return;
    }
    case "login": {
      const { cmdLogin, npmVerbDeps } = await import("./npmverbs.js");
      process.exitCode = await cmdLogin(r.args, npmVerbDeps(await packageRoot()));
      return;
    }
    case "pi": {
      const { cmdPi, npmVerbDeps } = await import("./npmverbs.js");
      process.exitCode = cmdPi(r.args, npmVerbDeps(await packageRoot()));
      return;
    }
    case "update": {
      const { cmdUpdate, detectInstall, npmVerbDeps } = await import("./npmverbs.js");
      const root = await packageRoot();
      // The image keeps its own `qcr update`: whatever the app's entry says.
      if (detectInstall(root, process.env).kind === "image") return appMain(["update"]);
      process.exitCode = cmdUpdate(r.args, npmVerbDeps(root));
      return;
    }
    case "refused":
      console.error(r.line);
      process.exitCode = r.code;
      return;
    case "app":
      return appMain(r.argv);
  }
}

/** Run the `qcr` bin on `argv` (the process's arguments after the script). */
export async function runBin(argv: readonly string[]): Promise<void> {
  const r = binRoute(argv);
  try {
    await route(r);
  } catch (err) {
    const verb = r.route === "app" ? r.argv.find((a) => a !== "--json") : r.route;
    const line = isSqliteUnavailable(err)
      ? sqliteHint(verb, err)
      : err instanceof MissingConfigError
        ? `qcr ${verb}: ${err.message}`
        : fsDeniedLine(verb, err);
    if (line === null) throw err;
    console.error(line);
    process.exitCode = 1;
    return;
  }
  const verb = r.route === "app" ? r.argv.find((a) => a !== "--json") : r.route;
  // a host plugin's run reads stdout and stderr as the contract's, whole
  if (r.route === "refused" || ("schema" in r && r.schema !== undefined)) return;
  if (r.route !== "help" && !QUIET_VERBS.has(verb ?? ""))
    await maybeNotice("json" in r ? r.json : r.route === "app" && r.argv.includes("--json"));
}

if (isEntryModule(process.argv[1], fileURLToPath(import.meta.url))) {
  await runBin(process.argv.slice(2));
}
