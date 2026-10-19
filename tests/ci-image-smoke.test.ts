// The CI image job (.github/workflows/ci.yml, `image`) and its offline smoke
// (.github/ci/image-smoke.sh). Building the image is not part of the suite: it
// needs docker and the network, and the job itself does it on a branch run.
// What is pinned here, with no docker and no model:
//   - the workflow: an `image` job that builds docker/Dockerfile under BuildKit
//     and runs the smoke, and that has no secret, no registry login and no push;
//   - the smoke script, run against a fake `docker` on PATH that answers the
//     verbs it calls: it passes on a good image, fails on a wrong pi pin, a
//     wrong schema version, a wrapper that writes nothing or does not pin the
//     image, or any `install` failure, and it records ptrace_scope;
//   - how the smoke starts a container: the wrapper's flags, no token, the
//     repo read-only.
import { afterEach, describe, expect, it } from "vitest";
import { spawnSync } from "node:child_process";
import { chmodSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseConfig } from "../src/config.js";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const read = (rel: string): string => readFileSync(join(root, rel), "utf8");
const SMOKE = join(root, ".github", "ci", "image-smoke.sh");
const workflow = read(".github/workflows/ci.yml");
const PI = parseConfig(read("config.example.toml")).pi.version;

/** The `image:` job's text: from its key to the next top-level job or the end. */
const imageJob = (): string => {
  const m = /^ {2}image:\n([\s\S]*?)(?=^ {2}\S|(?![\s\S]))/m.exec(workflow);
  expect(m, "an `image:` job").not.toBeNull();
  return m![1]!;
};

describe("ci.yml — the image job", () => {
  it("builds the release Dockerfile under BuildKit and runs the smoke on the result", () => {
    const job = imageJob();
    expect(job).toMatch(/DOCKER_BUILDKIT:\s*"1"/);
    expect(job).toMatch(/docker build\b[^\n]*-f docker\/Dockerfile\b/);
    expect(job).toContain('--build-arg "BUILD_SHA=${GITHUB_SHA}"');
    expect(job).toMatch(/\.github\/ci\/image-smoke\.sh\s+qcr-ci:smoke/);
    expect(job).toMatch(/-t qcr-ci:smoke\b/);
  });

  it("needs no secret, logs in nowhere and pushes nothing", () => {
    const job = imageJob();
    expect(job).not.toMatch(/secrets\./);
    expect(job).not.toMatch(/docker (login|push)|--push|login-action|build-push-action/);
    expect(job).not.toMatch(/GITHUB_TOKEN|GH_TOKEN|OPENAI|ANTHROPIC/);
  });

  it("does not claim the private repo has no GitHub remote", () => {
    expect(workflow).not.toMatch(/no GitHub remote|local git only/);
  });

  it("keeps the test job's triggers and read-only permissions", () => {
    expect(workflow).toMatch(/^on:\n {2}push:\n {4}branches: \[main\]\n {2}pull_request:$/m);
    expect(workflow).toMatch(/^permissions:\n {2}contents: read$/m);
  });

  it("the smoke script is committed executable", () => {
    expect(statSync(SMOKE).mode & 0o111).not.toBe(0);
  });
});

// ---- the smoke script against a fake docker ---------------------------------

const IMAGE = "img:test";
const good = {
  version: JSON.stringify({
    schema_version: 1,
    image: { version: "0.1.0", build_sha: "abc" },
    schemas: { review: 1, scan: 1 },
    pi: { package: "@earendil-works/pi-coding-agent", version: PI },
  }),
  preview: JSON.stringify({
    schema_version: 1,
    ok: true,
    preview: { branch: "feat", base: "main" },
  }),
};
const INSTALLER = `mkdir -p "$HOME/.local/bin" && printf '#!/bin/sh\\n# pinned ${IMAGE}\\necho qcr\\n' > "$HOME/.local/bin/qcr" && chmod +x "$HOME/.local/bin/qcr"`;

// A `docker` that answers the verbs the smoke runs. It logs one line per call
// (argv up to the image) to $FAKE_LOG and takes its canned answers from env.
const FAKE_DOCKER = `#!/usr/bin/env bash
[ "$1" = run ] || exit 99
shift
pre=()
while [ "$#" -gt 0 ] && [ "$1" != "${IMAGE}" ]; do pre+=("$1"); shift; done
echo "\${pre[*]}" >> "$FAKE_LOG"
shift
case "\${pre[*]}" in *--entrypoint*) echo "$FAKE_SCOPE"; exit 0 ;; esac
case "$*" in
  "version --json") printf '%s\\n' "$FAKE_VERSION" ;;
  "version") echo "qcr 0.1.0" ;;
  "review --preview --json") printf '%s\\n' "$FAKE_PREVIEW" ;;
  "install") printf '%s' "$FAKE_INSTALL_OUT"; printf '%s' "$FAKE_INSTALL_ERR" >&2; exit "$FAKE_INSTALL_RC" ;;
  *) echo "fake docker: unexpected: $*" >&2; exit 98 ;;
esac
`;

interface Rig {
  dir: string;
  log: string;
  summary: string;
  run: (env?: Record<string, string>) => { status: number | null; stdout: string; stderr: string };
}
const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});
function rig(): Rig {
  const dir = mkdtempSync(join(tmpdir(), "ci-image-smoke-"));
  dirs.push(dir);
  const bin = join(dir, "bin");
  spawnSync("mkdir", ["-p", bin]);
  writeFileSync(join(bin, "docker"), FAKE_DOCKER);
  chmodSync(join(bin, "docker"), 0o755);
  const log = join(dir, "docker.log");
  const summary = join(dir, "summary.md");
  return {
    dir,
    log,
    summary,
    run: (env = {}) => {
      const r = spawnSync(SMOKE, [IMAGE], {
        encoding: "utf8",
        timeout: 60_000,
        env: {
          PATH: `${bin}:${process.env["PATH"]}`,
          HOME: dir,
          TMPDIR: dir,
          FAKE_LOG: log,
          FAKE_VERSION: good.version,
          FAKE_PREVIEW: good.preview,
          FAKE_SCOPE: "1",
          FAKE_INSTALL_OUT: INSTALLER,
          FAKE_INSTALL_ERR: "",
          FAKE_INSTALL_RC: "0",
          GITHUB_STEP_SUMMARY: summary,
          ...env,
        },
      });
      return { status: r.status, stdout: r.stdout, stderr: r.stderr };
    },
  };
}

describe("image-smoke.sh", () => {
  it("passes on a good image, installs the pinned wrapper and records ptrace_scope", () => {
    const r = rig();
    const out = r.run({ FAKE_SCOPE: "1" });
    expect(out.status, out.stderr).toBe(0);
    expect(out.stderr).toContain("kernel.yama.ptrace_scope: runner host=");
    expect(out.stderr).toContain("inside the container=1");
    const summary = readFileSync(r.summary, "utf8");
    expect(summary).toContain("kernel.yama.ptrace_scope");
  });

  it("names its own image to install, so the wrapper is pinned to it", () => {
    const r = rig();
    expect(r.run().status).toBe(0);
    const install = readFileSync(r.log, "utf8")
      .trim()
      .split("\n")
      .find((c) => c.includes(`QCR_IMAGE=${IMAGE}`));
    expect(install).toBeDefined();
  });

  it("never writes the wrapper into the caller's real HOME", () => {
    const r = rig();
    const out = r.run({ FAKE_INSTALL_OUT: INSTALLER, FAKE_INSTALL_RC: "0", FAKE_INSTALL_ERR: "" });
    expect(out.status, out.stderr).toBe(0);
    expect(() => statSync(join(r.dir, ".local", "bin", "qcr"))).toThrow();
  });

  it("fails when the installer writes no executable wrapper", () => {
    const out = rig().run({ FAKE_INSTALL_OUT: "true", FAKE_INSTALL_RC: "0", FAKE_INSTALL_ERR: "" });
    expect(out.status).toBe(1);
    expect(out.stderr).toContain("did not write an executable ~/.local/bin/qcr");
  });

  it("fails on an installer that prints nothing", () => {
    const out = rig().run({ FAKE_INSTALL_OUT: "", FAKE_INSTALL_RC: "0", FAKE_INSTALL_ERR: "" });
    expect(out.status).toBe(1);
    expect(out.stderr).toContain("install printed nothing");
  });

  it("fails on any install failure, the old not-shipped answer included", () => {
    const other = rig().run({ FAKE_INSTALL_RC: "1", FAKE_INSTALL_ERR: "boom\n" });
    expect(other.status).toBe(1);
    const code64 = rig().run({
      FAKE_INSTALL_OUT: "",
      FAKE_INSTALL_RC: "64",
      FAKE_INSTALL_ERR:
        "qcr-entrypoint: install: the host wrapper is not shipped in this image yet\n",
    });
    expect(code64.status).toBe(1);
  });

  it("fails when the installed wrapper is not pinned to the image", () => {
    const out = rig().run({
      FAKE_INSTALL_OUT: `mkdir -p "$HOME/.local/bin" && printf 'echo qcr\\n' > "$HOME/.local/bin/qcr" && chmod +x "$HOME/.local/bin/qcr"`,
    });
    expect(out.status).toBe(1);
    expect(out.stderr).toContain("not pinned");
  });

  it("fails when the image's pi pin is not config.example.toml's", () => {
    const bad = JSON.stringify({
      ...JSON.parse(good.version),
      pi: { package: "p", version: "0.0.1" },
    });
    const out = rig().run({ FAKE_VERSION: bad });
    expect(out.status).toBe(1);
    expect(out.stderr).toContain("version --json is not the expected payload");
  });

  it("fails when the preview payload is not the schema version version --json announced", () => {
    const bad = JSON.stringify({ ...JSON.parse(good.preview), schema_version: 2 });
    const out = rig().run({ FAKE_PREVIEW: bad });
    expect(out.status).toBe(1);
    expect(out.stderr).toContain("review preview is not a v1 payload");
  });

  it("fails when the preview does not lead with schema_version", () => {
    const p = JSON.parse(good.preview) as Record<string, unknown>;
    const bad = JSON.stringify({ ok: true, schema_version: 1, preview: p["preview"] });
    expect(rig().run({ FAKE_PREVIEW: bad }).status).toBe(1);
  });

  it("records an absent ptrace_scope instead of failing on it", () => {
    const out = rig().run({ FAKE_SCOPE: "absent" });
    expect(out.status, out.stderr).toBe(0);
    expect(out.stderr).toContain("inside the container=absent");
  });

  it("starts every container the way the wrapper does: capless, no new privileges, no token", () => {
    const r = rig();
    expect(r.run().status).toBe(0);
    const calls = readFileSync(r.log, "utf8").trim().split("\n");
    expect(calls.length).toBeGreaterThanOrEqual(5);
    for (const c of calls) {
      expect(c).toContain("--rm");
      expect(c).toContain("--init");
      expect(c).toContain("--cap-drop ALL");
      expect(c).toContain("--security-opt no-new-privileges");
      expect(c).toMatch(/--user \d+:\d+/);
      expect(c).not.toMatch(/TOKEN|SECRET|KEY|docker\.sock/i);
    }
    const preview = calls.find((c) => c.includes("/repo"))!;
    expect(preview).toMatch(/-v \S+:\/repo:ro\b/);
    expect(preview).toContain("-e QCR_CONFIG=/opt/qcr/config.example.toml");
    expect(preview.match(/ -e /g)).toHaveLength(1);
  });
});
