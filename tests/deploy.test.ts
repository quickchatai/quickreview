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

const GROUP_VARS = (piVersion: string, withSandboxSrc = true) =>
  [
    "---",
    "sandbox_root: /opt/quickreview",
    "webhook_port: 8787",
    'image_name: quickreview-sandbox',
    'image_tag: v1',
    'pi_npm_package: "@earendil-works/pi-coding-agent"',
    `pi_version: "${piVersion}"`,
    ...(withSandboxSrc ? ['sandbox_src: "/tmp/whatever"'] : ['# sandbox_src: "/tmp/whatever"']),
    "",
  ].join("\n");

const CONFIG = (piVersion: string) =>
  [
    "dry_run = true",
    "",
    "[pi]",
    'package = "@earendil-works/pi-coding-agent"',
    `version = "${piVersion}"`,
    'session_dir = "state/pi-sessions"',
    "",
  ].join("\n");

interface Env {
  sandbox: string;
  ansible: string;
  dir: string;
}

let env: Env;

function makeScratch(opts: { configPi: string; groupVarsPi: string; sandboxSrc?: boolean }): Env {
  const dir = mkdtempSync(join(tmpdir(), "qcr-deploy-"));
  const sandbox = join(dir, "sandbox");
  const ansible = join(dir, "ansible");
  mkdirSync(sandbox, { recursive: true });
  mkdirSync(join(ansible, "group_vars"), { recursive: true });

  writeFileSync(join(sandbox, "config.toml"), CONFIG(opts.configPi));
  writeFileSync(join(ansible, "group_vars", "all.yml"), GROUP_VARS(opts.groupVarsPi, opts.sandboxSrc ?? true));
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
