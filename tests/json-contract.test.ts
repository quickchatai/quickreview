// The versioned JSON contract (src/contract.ts, schemas/*.v1.json): every
// `--json` payload of `qcr review` and `qcr scan` leads with schema_version and
// validates against its schema, and `qcr version --json` names the versions.
//
// Two checks per payload. The committed golden outputs (fixtures/json-contract)
// validate against the schema — the contract a plugin reads. The same verbs,
// driven live over fakes (a fake pi script, a faked scan runner; no model, no
// network), validate too and carry the golden's top-level keys, so neither the
// code nor the goldens can drift from the schema alone.
//
// Regenerate the goldens ONLY for a deliberate change to a payload:
// `UPDATE_GOLDEN=1 npx vitest run tests/json-contract.test.ts` (then `npx prettier --write tests/fixtures/json-contract`).
import { piCliRuntime } from "./helpers/pi-cli-runtime.js";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { execFileSync } from "node:child_process";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { ScanTriage } from "../src/setup/triage.js";
import { stateHomeFs } from "../src/setup/adapters.js";
import { runScanCli, type ScanCliDeps } from "../src/scancli.js";
import { runDetachedVerb, type DetachDeps } from "../src/reviewdetach.js";
import {
  REVIEW_SCHEMA_VERSION,
  SCAN_SCHEMA_VERSION,
  VERSION_SCHEMA_VERSION,
  withSchemaVersion,
} from "../src/contract.js";
import { renderVersion, versionInfo } from "../src/version.js";
import { validate } from "./helpers/json-schema-lite.js";
import { FILES, SHA, scanRig } from "./helpers/scan-cli-rig.js";

vi.stubEnv(
  "QCR_CONFIG",
  resolve(dirname(fileURLToPath(import.meta.url)), "fixtures", "config.toml"),
);
const { runReviewCli } = await import("../src/reviewcli.js");
const { contextFor } = await import("../src/bench/runner.js");

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const GOLDEN_DIR = join(ROOT, "tests", "fixtures", "json-contract");
const UPDATE = process.env["UPDATE_GOLDEN"] === "1";
const tmp = mkdtempSync(join(tmpdir(), "json-contract-"));

type Json = Record<string, unknown>;
const schemaOf = (name: string): Json =>
  JSON.parse(readFileSync(join(ROOT, "schemas", `${name}.json`), "utf8")) as Json;
const review = schemaOf("review-result.v1");
const scan = schemaOf("scan-result.v1");
const versionSchema = schemaOf("version.v1");

/** What a payload was captured as, so the goldens can be rewritten. */
const captured = new Map<string, Json>();
function capture(name: string, payload: Json): void {
  // the volatile parts (temp paths, shas, run directories, keys) are fixed so a regeneration diffs only on shape
  const text = JSON.stringify(payload)
    .split(tmp)
    .join("/tmp/work")
    .replace(/runs-[a-z0-9]+/g, "runs-x")
    .replace(/\d{17}-[0-9a-f]{7}/g, "20260101000000000-0000000")
    .replace(/"([0-9a-f]{40})"/g, `"${"0".repeat(40)}"`)
    .replace(/"key":"[0-9a-f]{16}"/g, `"key":"${"0".repeat(16)}"`);
  captured.set(name, JSON.parse(text) as Json);
}

afterAll(() => {
  if (UPDATE)
    for (const [name, payload] of captured)
      writeFileSync(join(GOLDEN_DIR, `${name}.json`), `${JSON.stringify(payload, null, 2)}\n`);
  rmSync(tmp, { recursive: true, force: true });
  vi.unstubAllEnvs();
});

const golden = (name: string): Json =>
  JSON.parse(readFileSync(join(GOLDEN_DIR, `${name}.json`), "utf8")) as Json;

/** A live payload: schema-valid, versioned first, and shaped like its golden. */
function expectContract(schema: Json, name: string, version: number, live: Json): void {
  capture(name, live);
  expect(Object.keys(live)[0]).toBe("schema_version");
  expect(live["schema_version"]).toBe(version);
  expect(validate(schema, live)).toEqual([]);
  if (!UPDATE) expect(Object.keys(live).sort()).toEqual(Object.keys(golden(name)).sort());
}

// ---- the goldens and the schemas ------------------------------------------------

const REVIEW_GOLDENS = [
  "review-preview",
  "review-diff-preview",
  "review-done",
  "review-partial",
  "review-refused",
  "review-start",
  "review-status-running",
  "review-status-done",
  "review-stop",
];
const SCAN_GOLDENS = ["scan-preview", "scan-status", "scan-findings", "scan-refused"];

describe("the committed golden outputs", () => {
  it.skipIf(UPDATE).each(REVIEW_GOLDENS)("%s validates against review-result.v1", (name) => {
    const g = golden(name);
    expect(g["schema_version"]).toBe(REVIEW_SCHEMA_VERSION);
    expect(validate(review, g)).toEqual([]);
  });

  it.skipIf(UPDATE).each(SCAN_GOLDENS)("%s validates against scan-result.v1", (name) => {
    const g = golden(name);
    expect(g["schema_version"]).toBe(SCAN_SCHEMA_VERSION);
    expect(validate(scan, g)).toEqual([]);
  });

  it("a detached review that ended without output reports result:null", () => {
    const done = golden("review-status-done");
    expect(validate(review, { ...done, state: "stopped", exit_code: null, result: null })).toEqual(
      [],
    );
  });

  it("a detached scan start and a scan stop validate", () => {
    const started = {
      schema_version: 1,
      ok: true,
      run: { id: "scan-1", mode: "calibration", sha: SHA, cases: 3, cap_usd: 3 },
      log: "/tmp/x.log",
    };
    expect(validate(scan, started)).toEqual([]);
    const stopped = { schema_version: 1, ok: true, run: "scan-1", answer: "scan scan-1 stopped" };
    expect(validate(scan, stopped)).toEqual([]);
    expect(validate(scan, { ...stopped, run: 5 })).not.toEqual([]);
  });

  it.skipIf(UPDATE)("version validates against version.v1", () => {
    expect(validate(versionSchema, golden("version"))).toEqual([]);
  });

  it("every golden file is listed above (none is orphaned)", () => {
    expect(
      readdirSync(GOLDEN_DIR)
        .map((f) => f.replace(/\.json$/, ""))
        .sort(),
    ).toEqual([...REVIEW_GOLDENS, ...SCAN_GOLDENS, "version"].sort());
  });

  it("the schema files pin the version the code prints", () => {
    expect(review["$id"]).toBe("review-result.v1.json");
    expect(scan["$id"]).toBe("scan-result.v1.json");
    expect(versionSchema["$id"]).toBe("version.v1.json");
    for (const [s, v] of [
      [review, REVIEW_SCHEMA_VERSION],
      [scan, SCAN_SCHEMA_VERSION],
      [versionSchema, VERSION_SCHEMA_VERSION],
    ] as const)
      expect((s["properties"] as Record<string, { const?: number }>)["schema_version"]!.const).toBe(
        v,
      );
  });

  it("the validator rejects what the contract forbids", () => {
    const ok = golden("review-done");
    expect(validate(review, { ...ok, schema_version: 2 })).not.toEqual([]);
    const { schema_version: _drop, ...bare } = ok;
    expect(validate(review, bare)).not.toEqual([]);
    expect(validate(review, { ...ok, ok: "yes" })).not.toEqual([]);
  });

  it("withSchemaVersion puts the version first and keeps a nested payload's own", () => {
    expect(Object.keys(withSchemaVersion(1, { ok: true }))).toEqual(["schema_version", "ok"]);
    expect(withSchemaVersion(1, { schema_version: 7 })["schema_version"]).toBe(7);
  });
});

// ---- qcr version -----------------------------------------------------------------

describe("qcr version", () => {
  it("reports the image version, the schema versions and the pi pin", () => {
    const v = versionInfo(ROOT, { package: "@earendil-works/pi-coding-agent", version: "1.3.0" });
    const pkg = JSON.parse(readFileSync(join(ROOT, "package.json"), "utf8")) as { version: string };
    expect(v.image.version).toBe(pkg.version);
    expect(v.schemas).toEqual({ review: REVIEW_SCHEMA_VERSION, scan: SCAN_SCHEMA_VERSION });
    expect(v.pi).toEqual({ package: "@earendil-works/pi-coding-agent", version: "1.3.0" });
    expect(renderVersion(v)).toMatch(/JSON schemas: review v1, scan v1/);
    expectContract(versionSchema, "version", VERSION_SCHEMA_VERSION, v as unknown as Json);
  });

  it("falls back to package.json's pi block, and reads a stamped image's BUILD_SHA", () => {
    const root = join(tmp, "image");
    mkdirSync(root);
    writeFileSync(
      join(root, "package.json"),
      JSON.stringify({ version: "1.2.3", pi: { package: "p", version: "4.5.6" } }),
    );
    expect(versionInfo(root)).toMatchObject({
      image: { version: "1.2.3", build_sha: null },
      pi: { package: "p", version: "4.5.6" },
    });
    writeFileSync(join(root, "BUILD_SHA"), "0123456789abcdef\n");
    expect(versionInfo(root).image.build_sha).toBe("0123456789abcdef");
    writeFileSync(join(root, "BUILD_SHA"), "unstamped\n");
    expect(versionInfo(root).image.build_sha).toBeNull();
  });
});

// ---- qcr review ------------------------------------------------------------------

const git = (cwd: string, ...args: string[]): string =>
  execFileSync(
    "git",
    ["-c", "user.name=T", "-c", "user.email=t@example.com", "-c", "commit.gpgsign=false", ...args],
    { cwd, encoding: "utf8" },
  ).trim();

function mkRepo(name: string): string {
  const repo = join(tmp, name);
  mkdirSync(join(repo, "src"), { recursive: true });
  git(repo, "init", "-q", "-b", "main");
  writeFileSync(join(repo, "src", "a.ts"), "export const a = 1;\n");
  git(repo, "add", "-A");
  git(repo, "commit", "-q", "-m", "base");
  git(repo, "checkout", "-q", "-b", "feature");
  writeFileSync(
    join(repo, "src", "a.ts"),
    "export const a = 1;\nexport const b = 2;\nexport const c = 3;\n",
  );
  git(repo, "commit", "-q", "-am", "add b and c");
  writeFileSync(join(repo, ".git", "qcr-review.json"), JSON.stringify({ auto_limit_usd: 1000 }));
  return repo;
}

const findings = [
  {
    path: "src/a.ts",
    line: 2,
    severity: "P2",
    title: "b is a magic number",
    disposition: "posted",
  },
  { path: "src/a.ts", line: 3, severity: "P0", title: "c breaks the build", disposition: "posted" },
];
const record = JSON.stringify({ findings, verdict: "REQUEST_CHANGES" });
const outcome = JSON.stringify({ verdict: "REQUEST_CHANGES", passes: [] });

function fakePi(name: string, script: string[]): string {
  const bin = join(tmp, `${name}-pi`);
  writeFileSync(
    bin,
    [
      "#!/bin/sh",
      "cat > /dev/null",
      'sd=""; prev=""; for a in "$@"; do [ "$prev" = "--session-dir" ] && sd="$a"; prev="$a"; done',
      'mkdir -p "$sd"; echo \'{"type":"session"}\' > "$sd/s.jsonl"; cd="$(dirname "$sd")"',
      ...script,
      "",
    ].join("\n"),
  );
  chmodSync(bin, 0o755);
  return bin;
}

let root: string;
let ctx: ReturnType<typeof contextFor>;
beforeAll(() => {
  root = join(tmp, "root");
  mkdirSync(root);
  for (const e of readdirSync(ROOT))
    if (!["wt", ".git", "state"].includes(e)) symlinkSync(join(ROOT, e), join(root, e));
  ctx = contextFor(root, "");
});

async function reviewJson(
  repo: string,
  piBin: string,
  args: string[],
  stdin?: string,
): Promise<[number, Json]> {
  const lines: string[] = [];
  const code = await runReviewCli(args, true, {
    cwd: repo,
    ...(stdin !== undefined ? { readStdin: async () => stdin } : {}),
    out: (l: string) => lines.push(l),
    confirm: null,
    root,
    agentDir: join(tmp, "agent"),
    cfg: ctx.cfg,
    ecosystem: ctx.ecosystem,
    runtime: piCliRuntime({ bin: piBin }),
    runsDir: join(tmp, `runs-${Math.random().toString(36).slice(2)}`),
    timeoutMs: 10 * 60_000,
  });
  expect(lines).toHaveLength(1);
  return [code, JSON.parse(lines[0]!) as Json];
}

describe("qcr review --json", () => {
  it("a preview, a finished review, a capped one and a refusal each carry the version", async () => {
    const [c1, preview] = await reviewJson(mkRepo("pv"), "false", ["--preview"]);
    expect(c1).toBe(0);
    expectContract(review, "review-preview", REVIEW_SCHEMA_VERSION, preview);

    const happy = fakePi("happy", [
      `echo '{"type":"message_end","message":{"role":"assistant","usage":{"input":1,"output":1,"cost":{"total":0.25}}}}'`,
      `printf '%s' ${JSON.stringify(record)} > "$cd/findings-record.json"`,
      `printf '%s' ${JSON.stringify(outcome)} > "$cd/outcome.json"`,
    ]);
    const [c2, done] = await reviewJson(mkRepo("done"), happy, []);
    expect(c2).toBe(0);
    expectContract(review, "review-done", REVIEW_SCHEMA_VERSION, done);

    const runaway = fakePi("runaway", [
      `echo '{"type":"message_end","message":{"role":"assistant","usage":{"cost":{"total":9999}}}}'`,
      "sleep 60",
    ]);
    const [c3, partial] = await reviewJson(mkRepo("capped"), runaway, []);
    expect(c3).toBe(1);
    expectContract(review, "review-partial", REVIEW_SCHEMA_VERSION, partial);

    const [c4, refused] = await reviewJson(mkRepo("bad"), "false", ["--bogus"]);
    expect(c4).toBe(2);
    expectContract(review, "review-refused", REVIEW_SCHEMA_VERSION, refused);
  }, 120_000);

  it("a piped diff is a diff target: target.kind = diff, with a repository around it and without", async () => {
    const a = "export const a = 1;\n";
    const diff = [
      "diff --git a/src/a.ts b/src/a.ts",
      "index 1111111..2222222 100644",
      "--- a/src/a.ts",
      "+++ b/src/a.ts",
      "@@ -1,1 +1,2 @@",
      ` ${a.trimEnd()}`,
      "+export const b = 2;",
      "",
    ].join("\n");
    const withRepo = join(tmp, "diff-repo");
    mkdirSync(join(withRepo, "src"), { recursive: true });
    git(withRepo, "init", "-q", "-b", "main");
    writeFileSync(join(withRepo, "src", "a.ts"), a);
    git(withRepo, "add", "-A");
    git(withRepo, "commit", "-q", "-m", "base");
    const bare = join(tmp, "diff-bare");
    mkdirSync(bare);
    for (const [name, cwd] of [
      ["review-diff-preview", withRepo],
      ["review-diff-preview-norepo", bare],
    ] as const) {
      const [code, o] = await reviewJson(cwd, "false", ["--diff", "-", "--preview"], diff);
      expect(code).toBe(0);
      expect(validate(review, o)).toEqual([]);
      expect((o["preview"] as Json)["target"]).toEqual({ kind: "diff" });
      expect((o["preview"] as Json)["postable"]).toBe(false);
      if (cwd === withRepo) expectContract(review, name, REVIEW_SCHEMA_VERSION, o);
    }
    // a diff has no PR: posting is refused, and the refusal is a valid payload
    const [code, refused] = await reviewJson(bare, "false", ["--diff", "-", "--to", "pr"], diff);
    expect(code).toBe(2);
    expect(validate(review, refused)).toEqual([]);
  });

  it("--to json without --json is versioned too", async () => {
    const lines: string[] = [];
    await runReviewCli(["--preview", "--to", "json"], false, {
      cwd: mkRepo("tojson"),
      out: (l: string) => lines.push(l),
      confirm: null,
      root,
      agentDir: join(tmp, "agent"),
      cfg: ctx.cfg,
      ecosystem: ctx.ecosystem,
      runtime: piCliRuntime({ bin: "false" }),
      runsDir: join(tmp, "runs-tojson"),
      timeoutMs: 60_000,
    });
    const o = JSON.parse(lines.find((l) => l.startsWith("{"))!) as Json;
    expect(o["schema_version"]).toBe(REVIEW_SCHEMA_VERSION);
  });
});

describe("qcr review start | status | stop --json", () => {
  function detached(): { deps: DetachDeps; last: () => Json; live: Set<number>; home: string } {
    const home = join(tmp, `detached-${Math.random().toString(36).slice(2)}`);
    const lines: string[] = [];
    const live = new Set<number>();
    const clock = { t: 1_000_000 };
    const deps: DetachDeps = {
      home,
      out: (l) => lines.push(l),
      now: () => clock.t,
      sleep: async (ms) => {
        clock.t += ms;
      },
      newId: () => `run${(clock.t += 1000)}`,
      alive: (p) => live.has(p),
      kill: (p) => {
        live.delete(p);
      },
      identify: () => ({ ok: true, key: "branch:o/r@feature", label: "feature" }),
      launch: () => {
        live.add(4001);
        return { ok: true, pid: 4001 };
      },
    };
    return { deps, last: () => JSON.parse(lines[lines.length - 1]!) as Json, live, home };
  }

  it("start, a running status, a finished status and stop are versioned and valid", async () => {
    const h = detached();
    expect(await runDetachedVerb("start", [], true, h.deps)).toBe(0);
    const started = h.last();
    expectContract(review, "review-start", REVIEW_SCHEMA_VERSION, started);

    expect(await runDetachedVerb("status", [], true, h.deps)).toBe(0);
    expectContract(review, "review-status-running", REVIEW_SCHEMA_VERSION, h.last());

    // the child's own last line is the review's versioned result
    const dir = join(h.home, "runs", started["run_id"] as string);
    writeFileSync(
      join(dir, "output.jsonl"),
      `${JSON.stringify(captured.get("review-done") ?? golden("review-done"))}\n`,
    );
    writeFileSync(join(dir, "exit.json"), JSON.stringify({ code: 0 }));
    h.live.clear();
    expect(await runDetachedVerb("status", [], true, h.deps)).toBe(0);
    expectContract(review, "review-status-done", REVIEW_SCHEMA_VERSION, h.last());

    const s = detached();
    await runDetachedVerb("start", [], true, s.deps);
    expect(await runDetachedVerb("stop", [], true, s.deps)).toBe(0);
    expectContract(review, "review-stop", REVIEW_SCHEMA_VERSION, s.last());
  });
});

// ---- qcr scan --------------------------------------------------------------------

describe("qcr scan --json", () => {
  it("preview, status, findings and a refusal carry the version", async () => {
    const dir = mkdtempSync(join(tmp, "scan-"));
    const rig = scanRig({ dir });
    const lines: string[] = [];
    const deps: ScanCliDeps = {
      scan: rig.scan,
      findings: rig.findings,
      settingsOf: rig.settingsOf,
      triage: new ScanTriage({
        findings: rig.findings,
        state: stateHomeFs(rig.home),
        memory: null,
        tracker: { kind: "markdown" } as never,
        clock: () => new Date("2026-09-29T12:00:00Z"),
        units: () => ["app", "lib"],
        runs: () => [],
      }),
      afterMatch: null,
      home: rig.home,
      out: (l) => lines.push(l),
      detach: async () => ({ ok: false, errors: ["no detached driver in this test"] }),
      sleep: async () => {
        await rig.scan.idle();
      },
      now: () => Date.parse("2026-09-29T12:00:00Z"),
    };
    const run = async (args: string[]): Promise<Json> => {
      lines.length = 0;
      await runScanCli(args, true, deps);
      expect(lines).toHaveLength(1);
      return JSON.parse(lines[0]!) as Json;
    };
    expect(Object.keys(FILES).length).toBeGreaterThan(0);
    expect(SHA).toHaveLength(40);

    const preview = await run(["preview"]);
    expectContract(scan, "scan-preview", SCAN_SCHEMA_VERSION, preview);
    const key = (preview["preview"] as { key: string }).key;
    await run(["start", "--key", key, "--foreground"]);
    expectContract(scan, "scan-status", SCAN_SCHEMA_VERSION, await run(["status"]));
    expectContract(scan, "scan-findings", SCAN_SCHEMA_VERSION, await run(["findings"]));
    expectContract(
      scan,
      "scan-refused",
      SCAN_SCHEMA_VERSION,
      await run(["start", "--key", "stale", "--foreground"]),
    );
  }, 60_000);
});
