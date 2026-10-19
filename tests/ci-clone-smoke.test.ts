// The CI clone job (.github/workflows/ci.yml, `clone`) and its offline smoke
// (.github/ci/clone-smoke.sh). The native developer install is not promised in
// the user docs, so CI is what keeps it working. What is pinned here, with no
// docker and no model:
//   - the workflow: a `clone` job with no docker, no secret and no push that
//     does a fresh checkout, npm ci, npm run build and then the smoke;
//   - the smoke script, run in a throwaway tree whose scripts/qcr is a fake
//     that answers version --json and review --preview --json: it passes on a
//     good payload and fails on a wrong pi pin, a wrong schema version, a
//     preview for the wrong branch or a missing dist/, and it hands the
//     wrapper a scrubbed environment (no token, a throwaway HOME);
//   - the user docs leave the clone route out (docs/onboarding.md: skipped
//     until P6.15 rewrites it for the Docker install only).
import { afterEach, describe, expect, it } from "vitest";
import { spawnSync } from "node:child_process";
import {
  chmodSync,
  copyFileSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseConfig } from "../src/config.js";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const read = (rel: string): string => readFileSync(join(root, rel), "utf8");
const SMOKE = ".github/ci/clone-smoke.sh";
const workflow = read(".github/workflows/ci.yml");
const PI = parseConfig(read("config.example.toml")).pi.version;

/** The `clone:` job's text: from its key to the next top-level job or the end. */
const cloneJob = (): string => {
  const m = /^ {2}clone:\n([\s\S]*?)(?=^ {2}\S|(?![\s\S]))/m.exec(workflow);
  expect(m, "a `clone:` job").not.toBeNull();
  return m![1]!;
};

describe("ci.yml — the clone job", () => {
  it("does a fresh checkout, npm ci, npm run build, then the smoke, in that order", () => {
    const job = cloneJob();
    const at = (s: string): number => job.indexOf(s);
    expect(at("actions/checkout@")).toBeGreaterThanOrEqual(0);
    expect(at("npm ci")).toBeGreaterThan(at("actions/checkout@"));
    expect(at("npm run build")).toBeGreaterThan(at("npm ci"));
    expect(at(".github/ci/clone-smoke.sh")).toBeGreaterThan(at("npm run build"));
  });

  it("uses no docker, no secret, no login and no push", () => {
    const job = cloneJob();
    expect(job).not.toMatch(/docker|secrets\.|login|push/);
    expect(job).not.toMatch(/GITHUB_TOKEN|GH_TOKEN|OPENAI|ANTHROPIC/);
  });

  it("the smoke script is committed executable", () => {
    expect(statSync(join(root, SMOKE)).mode & 0o111).not.toBe(0);
  });
});

// ---- the smoke script against a fake wrapper --------------------------------

const good = {
  version: JSON.stringify({
    schema_version: 1,
    image: { version: "0.1.0", build_sha: null },
    schemas: { review: 1, scan: 1 },
    pi: { package: "@earendil-works/pi-coding-agent", version: PI },
  }),
  preview: JSON.stringify({
    schema_version: 1,
    ok: true,
    preview: { branch: "feat", base: "main" },
  }),
};

// A scripts/qcr that logs its argv, its cwd and the names of its environment,
// and answers from files next to it.
const FAKE_QCR = `#!/usr/bin/env bash
dir="$(cd "$(dirname "\${BASH_SOURCE[0]}")/.." && pwd)"
{ echo "args=$*"; echo "cwd=$PWD"; echo "home=$HOME"; echo "config=$QCR_CONFIG"; env | cut -d= -f1 | sort | tr '\\n' ' '; echo; } >> "$dir/calls.log"
case "$*" in
  "version --json") cat "$dir/fake/version.json" ;;
  "version") echo "qcr 0.1.0" ;;
  "review --preview --json") cat "$dir/fake/preview.json" ;;
  *) echo "fake qcr: unexpected: $*" >&2; exit 98 ;;
esac
`;

interface Rig {
  dir: string;
  run: (o?: {
    version?: string;
    preview?: string;
    dist?: boolean;
    env?: Record<string, string>;
  }) => {
    status: number | null;
    stderr: string;
  };
}
const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});
function rig(): Rig {
  const dir = mkdtempSync(join(tmpdir(), "ci-clone-smoke-"));
  dirs.push(dir);
  for (const sub of [".github/ci", "scripts", "fake"])
    mkdirSync(join(dir, sub), { recursive: true });
  copyFileSync(join(root, SMOKE), join(dir, SMOKE));
  chmodSync(join(dir, SMOKE), 0o755);
  copyFileSync(join(root, "config.example.toml"), join(dir, "config.example.toml"));
  writeFileSync(join(dir, "scripts", "qcr"), FAKE_QCR);
  chmodSync(join(dir, "scripts", "qcr"), 0o755);
  return {
    dir,
    run: ({ version = good.version, preview = good.preview, dist = true, env = {} } = {}) => {
      writeFileSync(join(dir, "fake", "version.json"), version);
      writeFileSync(join(dir, "fake", "preview.json"), preview);
      if (dist) {
        mkdirSync(join(dir, "dist", "src"), { recursive: true });
        writeFileSync(join(dir, "dist", "src", "cli.js"), "");
      }
      const r = spawnSync(join(dir, SMOKE), [], {
        encoding: "utf8",
        timeout: 60_000,
        env: { PATH: process.env["PATH"]!, HOME: dir, TMPDIR: dir, ...env },
      });
      return { status: r.status, stderr: r.stderr };
    },
  };
}

describe("clone-smoke.sh", () => {
  it("passes on a good wrapper and runs both calls on a fixture repo", () => {
    const r = rig();
    const out = r.run();
    expect(out.status, out.stderr).toBe(0);
    expect(out.stderr).toContain("clone smoke: ok");
    const calls = readFileSync(join(r.dir, "calls.log"), "utf8");
    expect(calls).toContain("args=version --json");
    expect(calls).toContain("args=review --preview --json");
    expect(calls).toMatch(/cwd=\S+\/repo\n/);
  });

  it("hands the wrapper a scrubbed environment: no token, a throwaway HOME, the example config", () => {
    const r = rig();
    const out = r.run({
      env: { GH_TOKEN: "x", GITHUB_TOKEN: "x", OPENAI_API_KEY: "x", ANTHROPIC_API_KEY: "x" },
    });
    expect(out.status, out.stderr).toBe(0);
    const calls = readFileSync(join(r.dir, "calls.log"), "utf8");
    expect(calls).not.toMatch(/TOKEN|API_KEY/);
    expect(calls).not.toContain(`home=${r.dir}\n`);
    expect(calls).toContain(`config=${join(r.dir, "config.example.toml")}\n`);
  });

  it("fails when dist/ is not built", () => {
    const out = rig().run({ dist: false });
    expect(out.status).toBe(1);
    expect(out.stderr).toContain("dist/ is not built");
  });

  it("fails when the pi pin is not config.example.toml's", () => {
    const bad = JSON.stringify({
      ...JSON.parse(good.version),
      pi: { package: "p", version: "0.0.1" },
    });
    const out = rig().run({ version: bad });
    expect(out.status).toBe(1);
    expect(out.stderr).toContain("version --json is not the expected payload");
  });

  it("fails when the preview payload is not the schema version version --json announced", () => {
    const bad = JSON.stringify({ ...JSON.parse(good.preview), schema_version: 2 });
    const out = rig().run({ preview: bad });
    expect(out.status).toBe(1);
    expect(out.stderr).toContain("review preview is not a v1 payload");
  });

  it("fails when the preview names another branch or does not lead with schema_version", () => {
    const other = JSON.stringify({ schema_version: 1, ok: true, preview: { branch: "x" } });
    expect(rig().run({ preview: other }).status).toBe(1);
    const p = JSON.parse(good.preview) as Record<string, unknown>;
    const unordered = JSON.stringify({ ok: true, schema_version: 1, preview: p["preview"] });
    expect(rig().run({ preview: unordered }).status).toBe(1);
  });
});

describe("the user docs leave the clone route out", () => {
  // docs/onboarding.md still opens with the clone today; P6.15 rewrites it for
  // the Docker install only and moves the clone route to a developer section.
  it.skip("docs/onboarding.md has no clone-install instruction (enabled by P6.15)", () => {
    const doc = read("docs/onboarding.md");
    expect(doc).not.toMatch(/git clone|npm (ci|install)\b|npm run build/);
    expect(doc).not.toMatch(/fresh clone|The clone, with/i);
  });
});
