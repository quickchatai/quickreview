// scripts/deploy.sh — pre-flight guardrails, exercised in a scratch git repo
// with a throwaway copy of the group_vars. Nothing here touches the
// real ansible asset, and no live deploy ever runs: every case stops at
// --dry-run or at a refusal.
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const deploySh = join(root, "scripts", "deploy.sh");

/** The OpenViking half of the pins. `undefined` = no such pin in
 * the file, which is a distinct case from a mismatching one. */
interface OvPins {
  version?: string;
  llama?: string;
  extension?: string;
}

const GROUP_VARS = (piVersion: string, withSandboxSrc = true, ov?: OvPins) =>
  [
    "---",
    "sandbox_root: /opt/quickreview",
    "webhook_port: 8787",
    'image_name: quickreview-sandbox',
    'image_tag: v1',
    'pi_npm_package: "@earendil-works/pi-coding-agent"',
    `pi_version: "${piVersion}"`,
    ...(ov?.version === undefined ? [] : [`openviking_version: "${ov.version}"`]),
    ...(ov?.llama === undefined ? [] : [`llama_cpp_python_version: "${ov.llama}"`]),
    ...(withSandboxSrc ? ['sandbox_src: "/tmp/whatever"'] : ['# sandbox_src: "/tmp/whatever"']),
    "",
  ].join("\n");

const CONFIG = (piVersion: string, ov?: OvPins) =>
  [
    "dry_run = true",
    "",
    "[pi]",
    'package = "@earendil-works/pi-coding-agent"',
    `version = "${piVersion}"`,
    'session_dir = "state/pi-sessions"',
    ...(ov === undefined
      ? []
      : [
          "",
          "[openviking]",
          ...(ov.version === undefined ? [] : [`version = "${ov.version}"`]),
          ...(ov.llama === undefined ? [] : [`llama_cpp_python_version = "${ov.llama}"`]),
          ...(ov.extension === undefined ? [] : [`extension_commit = "${ov.extension}"`]),
        ]),
    "",
  ].join("\n");

interface Env {
  sandbox: string;
  ansible: string;
  dir: string;
}

let env: Env;

function makeScratch(opts: {
  configPi: string;
  groupVarsPi: string;
  sandboxSrc?: boolean;
  /** `[openviking]` in config.toml + the matching group_vars keys. */
  configOv?: OvPins;
  groupVarsOv?: OvPins;
  /** extensions/vendor/openviking-pi/upstream.json "commit". */
  upstreamCommit?: string;
}): Env {
  const dir = mkdtempSync(join(tmpdir(), "qcr-deploy-"));
  const sandbox = join(dir, "sandbox");
  const ansible = join(dir, "ansible");
  mkdirSync(sandbox, { recursive: true });
  mkdirSync(join(ansible, "group_vars"), { recursive: true });

  writeFileSync(join(sandbox, "config.toml"), CONFIG(opts.configPi, opts.configOv));
  writeFileSync(
    join(ansible, "group_vars", "all.yml"),
    GROUP_VARS(opts.groupVarsPi, opts.sandboxSrc ?? true, opts.groupVarsOv ?? opts.configOv),
  );
  if (opts.upstreamCommit !== undefined) {
    mkdirSync(join(sandbox, "extensions", "vendor", "openviking-pi"), { recursive: true });
    writeFileSync(
      join(sandbox, "extensions", "vendor", "openviking-pi", "upstream.json"),
      JSON.stringify({ repo: "https://github.com/volcengine/OpenViking", commit: opts.upstreamCommit }, null, 2) + "\n",
    );
  }
  writeFileSync(join(ansible, "playbook.yml"), "---\n# stub playbook (the real asset is never touched by tests)\n");
  writeFileSync(join(ansible, "inventory.ini"), "[quickreview]\nquickreview-vm ansible_user=mat\n");

  const git = (...args: string[]) =>
    execFileSync("git", ["-C", sandbox, ...args], {
      env: { ...process.env, GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@t", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@t" },
    });
  git("init", "-q");
  git("add", "-A");
  git("commit", "-qm", "scratch");
  return { dir, sandbox, ansible };
}

function run(e: Env, args: string[]): { code: number; stdout: string; stderr: string } {
  try {
    const stdout = execFileSync("bash", [deploySh, ...args], {
      encoding: "utf8",
      env: {
        ...process.env,
        QC_SANDBOX_DIR: e.sandbox,
        QC_ANSIBLE_DIR: e.ansible,
        QC_INVENTORY: join(e.ansible, "inventory.ini"),
      },
      stdio: ["ignore", "pipe", "pipe"],
    });
    return { code: 0, stdout, stderr: "" };
  } catch (err) {
    const e2 = err as { status?: number; stdout?: string; stderr?: string };
    return { code: e2.status ?? -1, stdout: String(e2.stdout ?? ""), stderr: String(e2.stderr ?? "") };
  }
}

afterEach(() => {
  if (env) rmSync(env.dir, { recursive: true, force: true });
});

describe("deploy.sh --dry-run", () => {
  it("is syntactically valid bash", () => {
    expect(() => execFileSync("bash", ["-n", deploySh])).not.toThrow();
  });

  it("prints the plan and exits 0 on a clean tree with matching pins", () => {
    env = makeScratch({ configPi: "0.84.1", groupVarsPi: "0.84.1" });
    const r = run(env, ["--dry-run"]);
    expect(r.code).toBe(0);
    expect(r.stdout).toContain("plan — deploy.sh sync");
    expect(r.stdout).toContain("pi pin       0.84.1");
    expect(r.stdout).toContain("rsync working copy");
    expect(r.stdout).toContain("(--dry-run: nothing executed)");
    // the flip is never automated
    expect(r.stdout).toContain("dry_run is NOT touched by deploy");
    // the deploy tab's marker is part of the plan (written only on a real run)
    expect(r.stdout).toContain("BUILD_SHA=");
  });

  it("plans an image rebuild in rebuild mode", () => {
    env = makeScratch({ configPi: "0.84.1", groupVarsPi: "0.84.1" });
    const r = run(env, ["--dry-run", "rebuild"]);
    expect(r.code).toBe(0);
    expect(r.stdout).toContain("-e rebuild_image=true");
  });

  it("plans ssh-only checks in verify mode (cloudflared + container + heartbeat)", () => {
    env = makeScratch({ configPi: "0.84.1", groupVarsPi: "0.84.1" });
    const r = run(env, ["--dry-run", "verify"]);
    expect(r.code).toBe(0);
    expect(r.stdout).toContain("systemctl is-active cloudflared");
    expect(r.stdout).toContain("status.json");
    expect(r.stdout).not.toContain("ansible-playbook");
  });

  it("refuses a dirty working tree", () => {
    env = makeScratch({ configPi: "0.84.1", groupVarsPi: "0.84.1" });
    writeFileSync(join(env.sandbox, "scratch-change.txt"), "uncommitted");
    const r = run(env, ["--dry-run"]);
    expect(r.code).toBe(1);
    expect(r.stderr).toContain("working tree is dirty");
    expect(r.stderr).toContain("scratch-change.txt");
  });

  it("gives an instructive error on the PIN-ME placeholder", () => {
    env = makeScratch({ configPi: "0.84.1", groupVarsPi: "PIN-ME" });
    const r = run(env, ["--dry-run"]);
    expect(r.code).toBe(1);
    expect(r.stderr).toContain("still the placeholder");
    expect(r.stderr).toContain('pi_version: "0.84.1"');
    expect(r.stderr).toContain("");
  });

  it("refuses when the pinned pi version would change", () => {
    env = makeScratch({ configPi: "0.85.0", groupVarsPi: "0.84.1" });
    const r = run(env, ["--dry-run"]);
    expect(r.code).toBe(1);
    expect(r.stderr).toContain("pi version mismatch");
    expect(r.stderr).toContain('config.toml   [pi] version = "0.85.0"');
    expect(r.stderr).toContain('group_vars    pi_version   = "0.84.1"');
  });

  it("refuses when sandbox_src is still commented out", () => {
    env = makeScratch({ configPi: "0.84.1", groupVarsPi: "0.84.1", sandboxSrc: false });
    const r = run(env, ["--dry-run"]);
    expect(r.code).toBe(1);
    expect(r.stderr).toContain("sandbox_src");
  });

  it("rejects unknown arguments and two modes", () => {
    env = makeScratch({ configPi: "0.84.1", groupVarsPi: "0.84.1" });
    expect(run(env, ["--wat"]).code).toBe(1);
    expect(run(env, ["sync", "rebuild"]).stderr).toContain("two modes");
  });
});

// ---- the memory-engine pins --------------------------------------
// The pi pin never floats; neither does OpenViking's. Three pins, two mirrors:
// server version and llama-cpp-python against the ansible group_vars (which
// the Dockerfile venv layer interpolates, so agreeing there means agreeing in
// the image), and the vendored fork's base commit against upstream.json.
describe("deploy.sh — OpenViking pin drift", () => {
  const OV: OvPins = { version: "0.4.15", llama: "0.3.35", extension: "d436baa23c83938b22bb0aab08b0ce48568b5ff4" };

  it("passes and names the memory pins in the plan when everything agrees", () => {
    env = makeScratch({ configPi: "0.84.1", groupVarsPi: "0.84.1", configOv: OV, upstreamCommit: OV.extension! });
    const r = run(env, ["--dry-run"]);
    expect(r.code).toBe(0);
    expect(r.stdout).toContain("memory pins  openviking 0.4.15");
    expect(r.stdout).toContain("extension d436baa2");
  });

  it("refuses when the pinned server version would change", () => {
    env = makeScratch({
      configPi: "0.84.1",
      groupVarsPi: "0.84.1",
      configOv: OV,
      groupVarsOv: { ...OV, version: "0.4.16" },
      upstreamCommit: OV.extension!,
    });
    const r = run(env, ["--dry-run"]);
    expect(r.code).toBe(1);
    expect(r.stderr).toContain("openviking pin mismatch");
    expect(r.stderr).toContain('config.toml   [openviking] version = "0.4.15"');
    expect(r.stderr).toContain('group_vars    openviking_version = "0.4.16"');
  });

  it("refuses when llama-cpp-python drifts — the server cannot boot without it", () => {
    env = makeScratch({
      configPi: "0.84.1",
      groupVarsPi: "0.84.1",
      configOv: OV,
      groupVarsOv: { ...OV, llama: "0.3.36" },
      upstreamCommit: OV.extension!,
    });
    const r = run(env, ["--dry-run"]);
    expect(r.code).toBe(1);
    expect(r.stderr).toContain("llama-cpp-python pin mismatch");
  });

  it("refuses when the vendored fork was rebased without recording it", () => {
    env = makeScratch({ configPi: "0.84.1", groupVarsPi: "0.84.1", configOv: OV, upstreamCommit: "0000000000000000000000000000000000000000" });
    const r = run(env, ["--dry-run"]);
    expect(r.code).toBe(1);
    expect(r.stderr).toContain("openviking pi-extension base commit pin mismatch");
  });

  it("a pin present on one side only is fatal, never silently skipped", () => {
    env = makeScratch({ configPi: "0.84.1", groupVarsPi: "0.84.1", configOv: OV, groupVarsOv: { version: OV.version } });
    const r = run(env, ["--dry-run"]);
    expect(r.code).toBe(1);
    expect(r.stderr).toContain("has no llama-cpp-python pin");
  });

  it("an extension_commit with no upstream.json beside it is fatal", () => {
    env = makeScratch({ configPi: "0.84.1", groupVarsPi: "0.84.1", configOv: OV });
    const r = run(env, ["--dry-run"]);
    expect(r.code).toBe(1);
    expect(r.stderr).toContain('upstream.json "commit" has no openviking pi-extension base commit pin');
  });

  it("stands down (with a note) on a config.toml carrying no [openviking] block", () => {
    env = makeScratch({ configPi: "0.84.1", groupVarsPi: "0.84.1" });
    const r = run(env, ["--dry-run"]);
    expect(r.code).toBe(0);
    // The plan SAYS it did not verify them — standing down is never silent.
    // (The `note` itself goes to stderr, which this helper only captures on a
    // non-zero exit.)
    expect(r.stdout).toContain("memory pins  <no [openviking] block");
  });
});
