// Every knob added to the third-party arms (the fairness switches, PR-Agent's
// effort/model/no-pr-text) is default-OFF: with none set, bench.sh must hand
// docker EXACTLY the command the published runs recorded in their
// <run>.sandbox-commands.log. bench.sh runs for real here against a stub
// `docker` (no container, no model); the expected lines are the published
// ones with only the runs dir and the uid:gid parameterised.
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const run = promisify(execFile);
const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");

let t: string;
let runs: string;
let bin: string;
beforeEach(() => {
  t = mkdtempSync(join(tmpdir(), "qcr-pubargv-"));
  runs = join(t, "runs");
  bin = join(t, "bin");
  mkdirSync(runs);
  mkdirSync(bin);
  writeFileSync(join(bin, "docker"), `#!/usr/bin/env bash\nexit 0\n`);
  chmodSync(join(bin, "docker"), 0o755);
});
afterEach(() => rmSync(t, { recursive: true, force: true }));

const HARDEN = (uid: string) =>
  "docker run --rm --init --read-only --cap-drop ALL --security-opt no-new-privileges " +
  `--pids-limit 4096 --memory 8g --cpus 4 --user ${uid} ` +
  "--tmpfs /tmp:rw\\,exec\\,nosuid\\,size=4g\\,mode=1777 " +
  "--tmpfs /opt/quickreview/sandbox/state:rw\\,nosuid\\,size=64m\\,mode=1777 " +
  "--tmpfs /opt/quickreview/sandbox/.pi:rw\\,nosuid\\,size=64m\\,mode=1777 " +
  "--mount type=volume\\,dst=/opt/quickreview/sandbox/wt " +
  "--mount type=volume\\,src=companion-pihome\\,dst=/pi-agent-src\\,volume-subpath=agent\\,readonly " +
  "--mount type=tmpfs\\,dst=/pi-agent-src/sessions ";
const REPOS = "--mount type=volume\\,src=qcr-bench-repos\\,dst=/repos\\,readonly ";

async function reviewLine(arm: string, runName: string, set: string, imgVar: string, img: string) {
  await run(
    "bash",
    [
      join(ROOT, "bench", "aacr", "bench.sh"),
      "review",
      "--arm",
      arm,
      "--run",
      runName,
      "--set",
      set,
    ],
    {
      env: { HOME: t, PATH: `${bin}:/usr/bin:/bin`, QCR_BENCH_RUNS_DIR: runs, [imgVar]: img },
    },
  );
  const log = readFileSync(join(runs, `${runName}.sandbox-commands.log`), "utf8");
  return log.split("\n").filter((l) => l.startsWith("docker run"));
}

describe("bench.sh with every knob unset = the published sandbox commands", () => {
  const uid = `${process.getuid?.() ?? 1000}:${process.getgid?.() ?? 1000}`;
  const out = (r: string) => `--mount type=bind\\,src=${runs}/${r}\\,dst=/bench-out `;
  const cases: Array<[string, string, string, string, (r: string) => string]> = [
    [
      "codex",
      "all-codex-smoke10",
      "QCR_BENCH_CODEX_IMAGE",
      "qcr-bench-codex:six",
      (r) =>
        `${HARDEN(uid)}--security-opt seccomp=unconfined ${REPOS}${out(r)}qcr-bench-codex:six codex-review smoke10 `,
    ],
    [
      "opencode",
      "all-opencode-smoke10",
      "QCR_BENCH_OPENCODE_IMAGE",
      "qcr-bench-opencode:six",
      (r) => `${HARDEN(uid)}${REPOS}${out(r)}qcr-bench-opencode:six opencode-review smoke10 `,
    ],
    [
      "pireview",
      "all-pireview-smoke10",
      "QCR_BENCH_PIREVIEW_IMAGE",
      "qcr-bench-pireview:six",
      (r) =>
        `${HARDEN(uid)}--mount type=volume\\,dst=/work ${REPOS}${out(r)}qcr-bench-pireview:six pireview-review smoke10 `,
    ],
    [
      "ocr",
      "b40ocr-smoke10",
      "QCR_BENCH_OCR_IMAGE",
      "qcr-bench-ocr:b40",
      (r) => `${HARDEN(uid)}${REPOS}${out(r)}qcr-bench-ocr:b40 ocr-review smoke10 `,
    ],
    [
      "pragent",
      "best-pragent-g61-smoke10",
      "QCR_BENCH_PRAGENT_IMAGE",
      "qcr-bench-pragent:latest",
      (r) => `${HARDEN(uid)}${REPOS}${out(r)}qcr-bench-pragent:latest pragent-review smoke10 `,
    ],
  ];
  for (const [arm, r, imgVar, img, want] of cases)
    it(`${arm} (${r})`, async () => {
      expect(await reviewLine(arm, r, "smoke10", imgVar, img)).toEqual([want(r)]);
    });
});

describe("bench.sh doctor: a docker that cannot run containers fails plainly", () => {
  // The stub's `docker info` answers like a daemon that is down; `docker version` (which a
  // CLI with no daemon still half-answers) is never what doctor trusts.
  const doctor = (dockerBody: string, path?: string) => {
    writeFileSync(join(bin, "docker"), `#!/usr/bin/env bash\n${dockerBody}\n`);
    chmodSync(join(bin, "docker"), 0o755);
    return run("/bin/bash", [join(ROOT, "bench", "aacr", "bench.sh"), "doctor"], {
      env: { PATH: path ?? `${bin}:${process.env.PATH}`, HOME: t, QCR_BENCH_RUNS_DIR: runs },
    }).then(
      (r) => ({ code: 0, stdout: r.stdout, stderr: r.stderr }),
      (e: { code: number; stdout: string; stderr: string }) => ({
        code: e.code,
        stdout: e.stdout,
        stderr: e.stderr,
      }),
    );
  };

  // MUTATION: drop the `docker info` check from bench.sh doctor (back to `docker version`) — this fails
  it("exits 1 with one line naming docker info's error and what to do", async () => {
    const r = await doctor(
      `[[ "$1" == info ]] && { echo "Cannot connect to the Docker daemon at unix:///var/run/docker.sock. Is the docker daemon running?" >&2; exit 1; }\nexit 0`,
    );
    expect(r.code).toBe(1);
    const lines = r.stderr.trim().split("\n");
    expect(lines).toHaveLength(1);
    expect(lines[0]).toMatch(
      /^bench: docker info fails \(Cannot connect to the Docker daemon .*\): start the Docker daemon .* then rerun bench\.sh doctor$/,
    );
    expect(r.stdout).not.toContain("volume");
  });

  it("prints the daemon's version and goes on when docker info answers", async () => {
    const r = await doctor(`[[ "$1" == info ]] && { echo 29.0.0; exit 0; }\nexit 1`);
    expect(r.code, r.stderr).toBe(0);
    expect(r.stdout.split("\n")[0]).toBe("docker 29.0.0");
  });

  // MUTATION: drop the Docker 25+ version check from bench.sh doctor — this fails
  it("exits 1 with one line when the daemon is older than Docker 25", async () => {
    const r = await doctor(`[[ "$1" == info ]] && { echo 24.0.7; exit 0; }\nexit 0`);
    expect(r.code).toBe(1);
    const lines = r.stderr.trim().split("\n");
    expect(lines).toHaveLength(1);
    expect(lines[0]).toMatch(
      /^bench: docker 24\.0\.7 is too old: Docker 25\+ is needed for the auth volume's subpath mount; .*rerun bench\.sh doctor$/,
    );
    expect(r.stdout).toBe("");
  });

  it("accepts Docker 25 exactly", async () => {
    const r = await doctor(`[[ "$1" == info ]] && { echo 25.0.0; exit 0; }\nexit 1`);
    expect(r.code, r.stderr).toBe(0);
    expect(r.stdout.split("\n")[0]).toBe("docker 25.0.0");
  });

  // MUTATION: drop the `command -v docker` check from bench.sh doctor — this fails
  it("says how to install docker when there is none", async () => {
    // a PATH with the few tools bench.sh needs before doctor, and no docker
    const tools = join(t, "tools");
    mkdirSync(tools);
    for (const tool of ["dirname", "grep", "id"]) {
      const which = ["/usr/bin", "/bin"].map((d) => join(d, tool)).find((p) => existsSync(p))!;
      symlinkSync(which, join(tools, tool));
    }
    const r = await doctor("exit 0", tools);
    expect(r.code).toBe(1);
    expect(r.stderr.trim()).toMatch(
      /^bench: docker is not installed: install Docker Engine 25\+ .*rerun bench\.sh doctor$/,
    );
  });
});
