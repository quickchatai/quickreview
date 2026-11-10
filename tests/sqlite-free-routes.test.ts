// qcr without better-sqlite3. The state store's driver is an optional
// dependency, so an install can lack it: the bin's front door (src/qcrbin.ts)
// routes the verbs in SQLITE_FREE_VERBS, and the home, to modules that never
// load the store, and every other verb prints the SQLite hint
// (src/sqlitehint.ts).
//
// Two halves. The routes fence walks the real import graph (static and
// dynamic imports both: a lazy import on a route's way loads the module just
// the same), from the front door and from every file a sqlite-free route
// starts by path. And this file's SQLite loader is injected to throw, so the
// routes run through runBin where the driver cannot load: any of them that
// reached it would fail here.
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, relative } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { homeExtensionPath } from "../src/home/launch.js";
import { APP_PI_EXTENSIONS } from "../src/npmverbs.js";
import { binRoute, runBin } from "../src/qcrbin.js";
import { detachedEntry } from "../src/reviewdetach.js";
import { SQLITE_FREE_VERBS, isSqliteUnavailable } from "../src/sqlitehint.js";
import { HEAVY_TIMEOUT_MS } from "./helpers/suite-timeouts.js";
import { closureReachesStateStore, type CutEdge } from "./helpers/worker-fences.js";

// The driver cannot load in this file: every import of it throws what Node
// throws when an install skipped the package.
vi.mock("better-sqlite3", () => {
  throw Object.assign(
    new Error("Cannot find package 'better-sqlite3' imported from /pkg/dist/src/state.js"),
    { code: "ERR_MODULE_NOT_FOUND" },
  );
});

const ROOT = join(import.meta.dirname, "..");

/** The front door's one store-backed door: the app's main, which every other
 * verb (and the image's own `qcr update`) goes through. */
const STORE_DOORS: readonly CutEdge[] = [{ from: "src/qcrbin.ts", spec: "./cli.js" }];

/** The plugin's pi entry, as its package.json names it, in the sources. */
function pluginEntry(): string {
  const pkg = JSON.parse(
    readFileSync(join(ROOT, "packages", "pi-plugin", "package.json"), "utf8"),
  ) as { pi: { extensions: string[] } };
  return pkg.pi.extensions.map((e) =>
    join("packages", "pi-plugin", e.replace(/^\.\/dist\//, "").replace(/\.js$/, ".ts")),
  )[0]!;
}

/** Every file a sqlite-free route runs: the front door itself (each route's
 * code and what it imports), and the files its children load by path. */
function routeEntries(): string[] {
  return [
    "src/qcrbin.ts",
    // `qcr review start`'s detached driver and its watchdog
    relative(ROOT, detachedEntry()),
    // the home's pi loads its extension
    relative(ROOT, homeExtensionPath(ROOT)),
    // `qcr pi` loads the plugin and the app's own extensions
    pluginEntry(),
    ...APP_PI_EXTENSIONS,
  ];
}

function planted<T>(files: Record<string, string>, fn: (root: string) => T): T {
  const root = mkdtempSync(join(tmpdir(), "sqlite-routes-"));
  try {
    for (const [p, text] of Object.entries(files)) {
      mkdirSync(dirname(join(root, p)), { recursive: true });
      writeFileSync(join(root, p), text);
    }
    return fn(root);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

describe("the sqlite-free routes fence", () => {
  // MUTATION: add `import { StateStore } from "./state.js";` to src/reviewcli.ts
  // (or to anything the review CLI imports) — the chain appears here.
  it(
    "no sqlite-free route reaches the state store or a SQLite package",
    {
      timeout: HEAVY_TIMEOUT_MS,
    },
    () => {
      expect(closureReachesStateStore(ROOT, routeEntries(), STORE_DOORS)).toEqual([]);
    },
  );

  // MUTATION: route `scan` to the app's main again — its route is "app", and
  // this fails.
  it("every sqlite-free verb has its own route in the front door", () => {
    for (const verb of SQLITE_FREE_VERBS) expect(binRoute([verb]).route, verb).toBe(verb);
  });

  it("cuts only the front door's own edge to the app's main, and follows the rest", () => {
    const hits = planted(
      {
        "src/qcrbin.ts": [
          `const a = await import("./reviewcli.js");`,
          `const b = await import("./cli.js");`,
        ].join("\n"),
        "src/reviewcli.ts": `import { s } from "./lazy.js";\n`,
        "src/lazy.ts": `export const s = () => import("./cli.js");\n`,
        "src/cli.ts": `import { StateStore } from "./state.js";\n`,
        "src/state.ts": `import Database from "better-sqlite3";\n`,
      },
      (root) => closureReachesStateStore(root, ["src/qcrbin.ts"], STORE_DOORS),
    );
    expect(hits).toEqual([
      "src/qcrbin.ts > src/reviewcli.ts > src/lazy.ts > src/cli.ts > src/state.ts",
    ]);
  });

  it("walks every entry it is given", () => {
    const hits = planted(
      {
        "src/qcrbin.ts": `export const x = 1;\n`,
        "extensions/cli/home.ts": `import { h } from "../../src/home/autoreview.js";\n`,
        "src/home/autoreview.ts": `import { snapshotHeartbeat } from "../state.js";\n`,
        "src/state.ts": `export const snapshotHeartbeat = 1;\n`,
      },
      (root) => closureReachesStateStore(root, ["src/qcrbin.ts", "extensions/cli/home.ts"]),
    );
    expect(hits).toEqual(["extensions/cli/home.ts > src/home/autoreview.ts > src/state.ts"]);
  });
});

describe("the bin's front door where the SQLite driver cannot load", () => {
  let dir: string;
  const saved: Record<string, string | undefined> = {};
  const KEYS = [
    "QCR_IN_SCAN_SANDBOX",
    "QCR_REVIEWED_REPO",
    "XDG_STATE_HOME",
    "XDG_CONFIG_HOME",
    "QCR_INSTALL",
    "QCR_STATE_HOME",
    "QCR_CONFIG_HOME",
    "QCR_CONFIG",
    "QCR_NO_UPDATE_NOTICE",
    "PATH",
    "XDG_DATA_HOME",
    "PI_CODING_AGENT_DIR",
    "QCR_SECRETS_MOUNT",
  ];
  let out: string[];
  let err: string[];

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "qcr-nosqlite-"));
    for (const k of KEYS) {
      saved[k] = process.env[k];
      delete process.env[k];
    }
    process.env.XDG_STATE_HOME = join(dir, "state");
    process.env.XDG_CONFIG_HOME = join(dir, "config");
    process.env.QCR_NO_UPDATE_NOTICE = "1";
    out = [];
    err = [];
    vi.spyOn(console, "log").mockImplementation((l: unknown) => void out.push(String(l)));
    vi.spyOn(console, "error").mockImplementation((l: unknown) => void err.push(String(l)));
    process.exitCode = undefined;
  });

  afterEach(() => {
    for (const k of KEYS) {
      if (saved[k] === undefined) delete process.env[k];
      else process.env[k] = saved[k];
    }
    vi.restoreAllMocks();
    process.exitCode = undefined;
    rmSync(dir, { recursive: true, force: true });
  });

  it("the driver cannot load here", async () => {
    const e = await import("better-sqlite3").then(
      () => null,
      (x: unknown) => x,
    );
    expect(isSqliteUnavailable(e)).toBe(true);
  });

  it("qcr version answers", { timeout: HEAVY_TIMEOUT_MS }, async () => {
    await runBin(["version", "--json"]);
    expect(process.exitCode ?? 0).toBe(0);
    expect(JSON.parse(out.join("\n"))).toHaveProperty("image.version");
  });

  it("qcr review status and stop answer", { timeout: HEAVY_TIMEOUT_MS }, async () => {
    await runBin(["review", "status", "--json"]);
    const status = JSON.parse(out.join("\n")) as Record<string, unknown>;
    expect(status).toHaveProperty("schema_version");
    out.length = 0;
    await runBin(["review", "stop", "--json"]);
    expect(JSON.parse(out.join("\n"))).toHaveProperty("schema_version");
    expect(err.join("\n")).not.toMatch(/state database|better-sqlite3/);
  });

  // The scan route reaches the scan CLI with what the app's main gave it.
  // MUTATION: route `scan` to the app's main again — the main loads the
  // store, the driver throws, and the hint replaces the scan's answer.
  it("qcr scan reaches the scan CLI", { timeout: HEAVY_TIMEOUT_MS }, async () => {
    process.env.QCR_IN_SCAN_SANDBOX = "1";
    process.env.QCR_REVIEWED_REPO = join(dir, "repo");
    await runBin(["scan", "status", "--json"]);
    expect(err.join("\n")).not.toMatch(/state database|better-sqlite3/);
    const status = JSON.parse(out.join("\n")) as Record<string, unknown>;
    expect(status).toHaveProperty("schema_version");
    out.length = 0;
    // its own usage error, exit 2, as before
    await runBin(["scan", "--sandbox", "nowhere"]);
    expect(process.exitCode).toBe(2);
    expect(out.join("\n")).toMatch(/^usage: qcr scan/);
  });

  // The installer loads the renderer from the package and asks each host on
  // PATH; with none there, every host is skipped.
  // MUTATION: import the state store from src/plugincli.ts — the driver
  // throws on the way in and this fails.
  it("qcr plugin answers", { timeout: HEAVY_TIMEOUT_MS }, async () => {
    process.env.PATH = join(dir, "no-hosts");
    process.env.XDG_DATA_HOME = join(dir, "data");
    // a temp HOME: Cursor is also found by its ~/.cursor
    const home = process.env.HOME;
    process.env.HOME = join(dir, "home");
    try {
      await runBin(["plugin", "update", "--json"]);
    } finally {
      if (home === undefined) delete process.env.HOME;
      else process.env.HOME = home;
    }
    expect(process.exitCode ?? 0).toBe(0);
    expect(err.join("\n")).not.toMatch(/state database|better-sqlite3/);
    const payload = JSON.parse(out.join("\n")) as {
      ok: boolean;
      hosts: Array<{ outcome: string }>;
    };
    expect(payload.ok).toBe(true);
    expect(payload.hosts.length).toBeGreaterThan(0);
    expect(payload.hosts.map((h) => h.outcome)).toEqual(payload.hosts.map(() => "skipped"));
  });

  // The model verb asks pi which model a review would run on: the config's
  // review sections, pi's agent dir and a route host, never the store. The
  // answer itself depends on what the environment holds a key for, so only
  // its shape is read here (tests/model-cli.test.ts has the answers).
  // MUTATION: route `model` to the app's main — the main loads the store, the
  // driver throws, and the hint replaces the answer.
  it("qcr model answers", { timeout: HEAVY_TIMEOUT_MS }, async () => {
    // an empty pi home of the test's own: never the person's
    process.env.PI_CODING_AGENT_DIR = join(dir, "pi-agent");
    await runBin(["model", "--json"]);
    expect(err.join("\n")).not.toMatch(/state database|better-sqlite3/);
    const answer = JSON.parse(out.join("\n")) as Record<string, unknown>;
    expect(typeof answer["ok"]).toBe("boolean");
    expect(answer).toHaveProperty("route");
    expect(answer).toHaveProperty("config_pin");
    expect(process.exitCode ?? 0).toBe(answer["ok"] === true ? 0 : 1);
    out.length = 0;
    // its own usage error, exit 2
    await runBin(["model", "nonsense"]);
    expect(process.exitCode).toBe(2);
    expect(err.join("\n")).toMatch(/usage: qcr model/);
  });

  it("qcr login refuses a bad provider by itself", { timeout: HEAVY_TIMEOUT_MS }, async () => {
    await runBin(["login", "x'; rm -rf /"]);
    expect(process.exitCode).toBe(2);
    expect(err.join("\n")).not.toMatch(/state database/);
  });

  it("qcr update answers for a checkout", { timeout: HEAVY_TIMEOUT_MS }, async () => {
    await runBin(["update"]);
    expect(process.exitCode).toBe(1);
    expect(err.join("\n")).toMatch(/git pull/);
    expect(err.join("\n")).not.toMatch(/state database/);
  });

  // The home's pi loads its extension by path; its auto-review label reads
  // Docker and the daemon's status.json, never the store.
  it("the home and its extension load", { timeout: HEAVY_TIMEOUT_MS }, async () => {
    await expect(import("../src/home/launch.js")).resolves.toHaveProperty("runHome");
    await expect(import("../extensions/cli/home.js")).resolves.toHaveProperty("default");
  });

  // MUTATION: drop the cause chain from isSqliteUnavailable — the loader's
  // wrapped failure propagates as a stack and this fails.
  it("a store-backed verb prints the hint", { timeout: HEAVY_TIMEOUT_MS }, async () => {
    await runBin(["status"]);
    expect(process.exitCode).toBe(1);
    const said = err.join("\n");
    expect(said).toMatch(/^qcr status: this needs the state database/);
    expect(said).toMatch(/Cannot find package 'better-sqlite3'/);
    for (const verb of SQLITE_FREE_VERBS) expect(said).toContain(`\`qcr ${verb}\``);
  });
});
