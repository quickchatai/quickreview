// One host process per bench case (src/bench/casehost.ts): the pool's argv for a
// case, the host's end in every shape (clean, killed, hung, stopped on the
// login), and what each pool records when a host dies. The host here is a small
// node script standing in for the bench cli, so nothing reaches a model.
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import {
  CASE_HOST_AUTH_STOP,
  caseHostArgv,
  describeHostEnd,
  judgeCaseHosted,
  reviewCaseHosted,
  runCaseHost,
  type HostPool,
} from "../src/bench/casehost.js";

vi.stubEnv("QCR_CONFIG", join(import.meta.dirname, "fixtures", "config.toml"));
const { safeId } = await import("../src/bench/aacr.js");
type BenchCase = import("../src/bench/aacr.js").BenchCase;
const { benchConfig, runFingerprint } = await import("../src/bench/runner.js");

const tmp = mkdtempSync(join(tmpdir(), "bench-casehost-"));
afterAll(() => {
  rmSync(tmp, { recursive: true, force: true });
  vi.unstubAllEnvs();
});

const outDir = join(tmp, "out");
const hostLog = join(tmp, "hosts.log");
const entry = join(tmp, "fake-cli.cjs");

// The id says what the host does: crash (SIGKILL itself), hang, stop (the login
// would expire, exit 3), fail (exit 1), otherwise it finishes the case.
writeFileSync(
  entry,
  `
const fs = require("node:fs");
const path = require("node:path");
const a = process.argv.slice(2);
const get = (k) => a[a.indexOf(k) + 1];
const id = get("--only");
const out = get("--out");
fs.appendFileSync(process.env.HOST_LOG, JSON.stringify(a) + "\\n");
const caseDir = out ? path.join(out, "cases", id) : null;
if (caseDir) fs.mkdirSync(caseDir, { recursive: true });
if (id.includes("crash")) {
  if (caseDir) fs.writeFileSync(path.join(caseDir, "pi-events.jsonl"), '{"type":"session"}\\n');
  process.kill(process.pid, "SIGKILL");
}
if (id.includes("hang")) setInterval(() => {}, 1000);
else if (id.includes("stop")) process.exit(${CASE_HOST_AUTH_STOP});
else if (id.includes("fail")) process.exit(1);
else {
  if (a[0] === "review") fs.writeFileSync(path.join(caseDir, "case-summary.json"), JSON.stringify({ instance_id: id, status: "ok" }));
  process.exit(0);
}
`,
);

const caseOf = (name: string): BenchCase => ({
  instance_id: `acme__${name}@abcdef0`,
  repo: "acme/widget",
  pr: 7,
  pr_url: "https://github.com/acme/widget/pull/7",
  base_commit: "b".repeat(40),
  head_commit: "a".repeat(40),
  language: "TypeScript",
  pr_category: "bug",
  change_line_count: 1,
  references: 1,
});

const lines: string[] = [];
const pool = (cmd: string, extra: string[] = []): HostPool => ({
  argv: [
    cmd,
    "--set",
    "s.json",
    "--out",
    outDir,
    "--concurrency",
    "3",
    "--runtime",
    "sdk",
    ...extra,
  ],
  entry,
  env: { ...process.env, HOST_LOG: hostLog },
  log: (l) => lines.push(l),
});

beforeAll(() => mkdirSync(outDir, { recursive: true }));

describe("caseHostArgv", () => {
  it("replaces the pool's flags and keeps the rest, in the order given", () => {
    expect(
      caseHostArgv(
        [
          "review",
          "--set",
          "s.json",
          "--only",
          "a,b",
          "--concurrency",
          "3",
          "--phase",
          "all",
          "--runtime",
          "proc",
          "--timeout-min",
          "9",
          "--resume",
        ],
        "c1",
        { phase: "case" },
      ),
    ).toEqual([
      "review",
      "--set",
      "s.json",
      "--timeout-min",
      "9",
      "--resume",
      "--only",
      "c1",
      "--concurrency",
      "1",
      "--runtime",
      "sdk",
      "--phase",
      "case",
      "--case-host",
    ]);
  });

  it("gives the judge no phase, and never doubles --case-host", () => {
    const argv = caseHostArgv(["defect-judge", "--case-host", "--rounds", "2"], "c1");
    expect(argv).toEqual([
      "defect-judge",
      "--rounds",
      "2",
      "--only",
      "c1",
      "--concurrency",
      "1",
      "--runtime",
      "sdk",
      "--case-host",
    ]);
  });
});

describe("runCaseHost", () => {
  const run = (name: string, timeoutMs = 20_000) =>
    runCaseHost(caseHostArgv(["defect-judge", "--out", outDir], `acme__${name}@abcdef0`), {
      entry,
      env: { ...process.env, HOST_LOG: hostLog },
      timeoutMs,
    });

  it("reports a clean exit, an exit status and the login stop", async () => {
    expect(await run("ok")).toMatchObject({ code: 0, signal: null, timedOut: false });
    expect(await run("fail")).toMatchObject({ code: 1 });
    expect(await run("stop")).toMatchObject({ code: CASE_HOST_AUTH_STOP });
  });

  it("reports a host that was killed, with the signal", async () => {
    const end = await run("crash");
    expect(end).toMatchObject({ code: null, signal: "SIGKILL", timedOut: false });
    expect(describeHostEnd(end, 1000)).toMatch(/killed by SIGKILL/);
  });

  it("kills a host that outlives its wall clock", async () => {
    const t0 = Date.now();
    const end = await run("hang", 300);
    expect(end.timedOut).toBe(true);
    expect(Date.now() - t0).toBeLessThan(10_000);
    expect(describeHostEnd(end, 300)).toMatch(/outlived its wall clock/);
  });

  it("reports a host that cannot be started, without rejecting", async () => {
    const end = await runCaseHost(["x"], { entry, node: "/nonexistent/node", timeoutMs: 1000 });
    expect(end.spawnError).toBeDefined();
    expect(describeHostEnd(end, 1000)).toMatch(/could not be started/);
  });
});

describe("the judge's pool: a crash in one case leaves the other two finishing", () => {
  it("judges two, loses one, and says which", async () => {
    lines.length = 0;
    const cases = [caseOf("one"), caseOf("crash"), caseOf("three")];
    const results = await Promise.all(
      cases.map((c) =>
        judgeCaseHosted(c, pool("defect-judge"), { root: tmp, rounds: 1, timeoutMs: 60_000 }),
      ),
    );
    expect(results).toEqual(["judged", "unjudged", "judged"]);
    expect(lines.filter((l) => l.includes("acme__crash@abcdef0"))).toEqual([
      expect.stringMatching(/killed by SIGKILL/),
    ]);
    // Each host got exactly its own case, serially and with the host flag.
    const asked = readFileSync(hostLog, "utf8")
      .trim()
      .split("\n")
      .map((l) => JSON.parse(l) as string[]);
    for (const c of cases) {
      const a = asked.find((x) => x[x.indexOf("--only") + 1] === c.instance_id)!;
      expect(a).toContain("--case-host");
      expect(a[a.indexOf("--concurrency") + 1]).toBe("1");
    }
  });

  it("maps the host's own exit statuses: its refusal is unjudged, the login stop is the pool's stop", async () => {
    expect(
      await judgeCaseHosted(caseOf("fail"), pool("defect-judge"), {
        root: tmp,
        rounds: 1,
        timeoutMs: 60_000,
      }),
    ).toBe("unjudged");
    expect(
      await judgeCaseHosted(caseOf("stop"), pool("defect-judge"), {
        root: tmp,
        rounds: 1,
        timeoutMs: 60_000,
      }),
    ).toBe("auth-stop");
  });

  it("cleans the checkout a dead host left on the wt volume", async () => {
    const leftover = join(tmp, "wt", `judge-${safeId(caseOf("crash").instance_id)}`);
    mkdirSync(leftover, { recursive: true });
    await judgeCaseHosted(caseOf("crash"), pool("defect-judge"), {
      root: tmp,
      rounds: 1,
      timeoutMs: 60_000,
    });
    expect(existsSync(leftover)).toBe(false);
  });
});

describe("the review's pool: a host that dies costs its case, recorded as a failed case", () => {
  const fingerprint = () =>
    runFingerprint(benchConfig(""), "", "", undefined, { runtime: "sdk", lens_runtime: "engine" });
  const caseDir = (c: BenchCase) => join(outDir, "cases", safeId(c.instance_id));

  it("returns the summary a finished host wrote", async () => {
    const c = caseOf("fine");
    mkdirSync(caseDir(c), { recursive: true });
    const s = await reviewCaseHosted(c, pool("review"), {
      root: tmp,
      outDir,
      fingerprint: fingerprint(),
      timeoutMs: 60_000,
    });
    expect(s).toMatchObject({ instance_id: c.instance_id, status: "ok" });
  });

  it("records a crashed host as failed, with empty result files and its event stream kept", async () => {
    const c = caseOf("crash");
    mkdirSync(caseDir(c), { recursive: true });
    // An earlier attempt's summary must not be taken for this attempt's.
    writeFileSync(join(caseDir(c), "case-summary.json"), JSON.stringify({ status: "ok" }));
    writeFileSync(join(caseDir(c), "outcome.json"), "{}");
    const s = await reviewCaseHosted(c, pool("review"), {
      root: tmp,
      outDir,
      fingerprint: fingerprint(),
      timeoutMs: 60_000,
    });
    expect(s.status).toBe("failed");
    expect(s.error).toMatch(/killed by SIGKILL/);
    expect(s.fingerprint?.engine).toEqual({ runtime: "sdk", lens_runtime: "engine" });
    const written = JSON.parse(readFileSync(join(caseDir(c), "case-summary.json"), "utf8")) as {
      status: string;
    };
    expect(written.status).toBe("failed");
    expect(existsSync(join(outDir, "results", "all", `${safeId(c.instance_id)}.json`))).toBe(true);
    // The host's stream is kept for the cost reader; the earlier attempt's file is not.
    expect(existsSync(join(caseDir(c), "pi-events.jsonl"))).toBe(true);
    expect(existsSync(join(caseDir(c), "outcome.json"))).toBe(false);
  });

  it("records a host that exits without a summary as failed", async () => {
    const c = caseOf("fail");
    mkdirSync(caseDir(c), { recursive: true });
    const s = await reviewCaseHosted(c, pool("review"), {
      root: tmp,
      outDir,
      fingerprint: fingerprint(),
      timeoutMs: 60_000,
    });
    expect(s.status).toBe("failed");
    expect(s.error).toMatch(/exited 1 without recording the case/);
  });
});
