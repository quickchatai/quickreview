// `qcr --schema N <verb>`: a host plugin names its contract and gets JSON in
// exactly that contract, or a refusal (src/schemaflag.ts, the contracts in
// packages/pi-plugin/src/contract.ts). Driven at the bin's front door
// (runBin) and at the image's entry (src/cli.ts `main`), which the image's
// wrapper reaches instead. The update notice is faked to be always due, so a
// run that printed it would show it here.
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  CONTRACTS,
  REVIEW_SCHEMA_VERSION,
  SCAN_SCHEMA_VERSION,
  VERSION_SCHEMA_VERSION,
  supportedContracts,
} from "@quickchatai/pi-quickreview/src/contract.js";
import { main } from "../src/cli.js";
import { binRoute, runBin } from "../src/qcrbin.js";
import { SCHEMA_VERBS, parseSchemaFlag } from "../src/schemaflag.js";
import { HEAVY_TIMEOUT_MS } from "./helpers/suite-timeouts.js";

const NOTICE = "qcr 99.0.0 is available (this is 1.0.0): run `qcr update`.";
vi.mock("../src/updatenotice.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/updatenotice.js")>()),
  updateNotice: () => NOTICE,
}));

describe("the contracts", () => {
  // MUTATION: define contract 1 as { review: 2, scan: 1, version: 1 } — this fails.
  it("contract 1 is review v1, scan v1 and version v1", () => {
    expect(CONTRACTS[1]).toEqual({ review: 1, scan: 1, version: 1 });
  });

  // MUTATION: bump REVIEW_SCHEMA_VERSION to 2 without a new contract — this fails.
  it("every contract listed is one this build prints", () => {
    expect(supportedContracts()).toEqual(Object.keys(CONTRACTS).map(Number));
    for (const n of supportedContracts())
      expect(CONTRACTS[n]).toEqual({
        review: REVIEW_SCHEMA_VERSION,
        scan: SCAN_SCHEMA_VERSION,
        version: VERSION_SCHEMA_VERSION,
      });
  });
});

describe("reading the flag", () => {
  // MUTATION: drop `json: true` from binRoute's --schema route — this fails.
  it("a known contract routes its verb with JSON on, in either spelling", () => {
    expect(binRoute(["--schema", "1", "review", "--preview"])).toEqual({
      route: "review",
      args: ["--preview"],
      json: true,
      schema: 1,
    });
    expect(binRoute(["--schema=1", "scan", "status", "--json"])).toEqual({
      route: "scan",
      args: ["status"],
      json: true,
      schema: 1,
    });
    expect(binRoute(["--schema", "1", "version"])).toMatchObject({ route: "version", json: true });
  });

  it("an unknown contract is exit 3, named in one line", () => {
    const r = parseSchemaFlag(["--schema", "9", "review"]);
    expect(r).toMatchObject({ kind: "refused", code: 3 });
    expect(r.kind === "refused" && r.line).toMatch(/does not print contract 9/);
    expect(r.kind === "refused" && r.line).not.toContain("\n");
  });

  // MUTATION: let SCHEMA_VERBS include "login" — this fails.
  it("a verb with no versioned payload, no verb, or no number is usage", () => {
    for (const argv of [
      ["--schema", "1", "login"],
      ["--schema", "1", "pi"],
      ["--schema", "1", "home"],
      ["--schema", "1", "update"],
      ["--schema", "1", "tui"],
      ["--schema", "1", "status"],
      ["--schema", "1"],
      ["--schema"],
      ["--schema", "one", "review"],
      ["--schema=", "review"],
    ])
      expect(parseSchemaFlag(argv), argv.join(" ")).toMatchObject({ kind: "refused", code: 2 });
  });

  // MUTATION: hardcode USAGE as "usage: qcr --schema N review|scan [arguments…]" — this fails.
  it("a usage refusal names exactly the verbs it accepts", () => {
    for (const argv of [
      ["--schema", "1", "login"],
      ["--schema", "one", "review"],
    ]) {
      const r = parseSchemaFlag(argv);
      expect(r.kind === "refused" && r.line, argv.join(" ")).toContain(
        `usage: qcr --schema N ${SCHEMA_VERBS.join("|")} [`,
      );
    }
  });

  it("is read only before the verb: after it, it is the verb's own argument", () => {
    expect(parseSchemaFlag(["review", "--schema", "1"])).toEqual({ kind: "absent" });
    expect(binRoute(["review", "--schema", "1"])).toEqual({
      route: "review",
      args: ["--schema", "1"],
      json: false,
    });
  });
});

describe("at the front door", () => {
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
  ];
  let out: string[];
  let err: string[];

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "qcr-schema-"));
    for (const k of KEYS) {
      saved[k] = process.env[k];
      delete process.env[k];
    }
    process.env.XDG_STATE_HOME = join(dir, "state");
    process.env.XDG_CONFIG_HOME = join(dir, "config");
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

  it("the version probe lists the contracts", { timeout: HEAVY_TIMEOUT_MS }, async () => {
    await runBin(["--schema", "1", "version"]);
    expect(process.exitCode ?? 0).toBe(0);
    const v = JSON.parse(out.join("\n")) as Record<string, unknown>;
    expect(v["schema_version"]).toBe(CONTRACTS[1]!.version);
    expect(v["contracts"]).toEqual([1]);
    expect(err).toEqual([]);
  });

  // MUTATION: route an unknown contract's verb anyway — stdout gets a payload and this fails.
  it("an unknown contract exits 3 with empty stdout and one stderr line", async () => {
    await runBin(["--schema", "2", "version"]);
    expect(process.exitCode).toBe(3);
    expect(out).toEqual([]);
    expect(err).toHaveLength(1);
    expect(err[0]).toMatch(/^qcr --schema: this qcr does not print contract 2 \(it prints 1\)/);
  });

  it("a verb with no versioned payload runs nothing and is usage", async () => {
    await runBin(["--schema", "1", "login"]);
    expect(process.exitCode).toBe(2);
    expect(out).toEqual([]);
    expect(err).toHaveLength(1);
    expect(err[0]).toMatch(/`qcr login` prints no versioned JSON/);
  });

  // The control is the same verb without the flag: the faked notice prints.
  // MUTATION: drop the --schema early return before maybeNotice in runBin — this fails.
  it(
    "a review in contract 1 carries the review version, and prints no update notice",
    { timeout: HEAVY_TIMEOUT_MS },
    async () => {
      await runBin(["review", "status", "--json"]);
      expect(err).toContain(NOTICE);
      out.length = 0;
      err.length = 0;
      await runBin(["--schema", "1", "review", "status"]);
      const status = JSON.parse(out.join("\n")) as Record<string, unknown>;
      expect(Object.keys(status)[0]).toBe("schema_version");
      expect(status["schema_version"]).toBe(CONTRACTS[1]!.review);
      expect(err).not.toContain(NOTICE);
      await runBin(["--schema", "9", "review", "status"]);
      expect(err).not.toContain(NOTICE);
    },
  );

  it("a scan in contract 1 carries the scan version", { timeout: HEAVY_TIMEOUT_MS }, async () => {
    process.env.QCR_IN_SCAN_SANDBOX = "1";
    process.env.QCR_REVIEWED_REPO = join(dir, "repo");
    await runBin(["--schema", "1", "scan", "status"]);
    const status = JSON.parse(out.join("\n")) as Record<string, unknown>;
    expect(status["schema_version"]).toBe(CONTRACTS[1]!.scan);
    expect(err).not.toContain(NOTICE);
  });

  // The image's wrapper runs dist/src/cli.js, never the front door.
  // MUTATION: drop the parseSchemaFlag call from src/cli.ts main — this fails.
  it("the image's entry reads the flag the same way", { timeout: HEAVY_TIMEOUT_MS }, async () => {
    await main(["--schema", "1", "version"]);
    expect(process.exitCode ?? 0).toBe(0);
    expect(JSON.parse(out.join("\n"))).toMatchObject({ schema_version: 1, contracts: [1] });
    out.length = 0;
    await main(["--schema", "2", "version"]);
    expect(process.exitCode).toBe(3);
    expect(out).toEqual([]);
    process.exitCode = undefined;
    await main(["--schema", "1", "status"]);
    expect(process.exitCode).toBe(2);
    expect(out).toEqual([]);
  });
});
