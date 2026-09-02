// scripts/deploy.sh — pre-flight guardrails, exercised in a scratch git repo
// with a throwaway copy of the group_vars. Nothing here touches the
// real ansible asset, and no live deploy ever runs: every case stops at
// --dry-run or at a refusal.
import { afterEach, describe, expect, it } from "vitest";
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
  /** — the auth posture is mirrored exactly like the pins. */
  auth?: string;
  rootKeyFile?: string;
  reviewerKeyFile?: string;
  users?: string;
  /** — the embedder, mirrored against the EFFECTIVE ansible value. */
  embedProvider?: string;
  embedModel?: string;
  embedDimension?: string;
  embedKeyFile?: string;
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
    ...(ov?.auth === undefined ? [] : [`openviking_auth_mode: "${ov.auth}"`]),
    ...(ov?.rootKeyFile === undefined ? [] : [`openviking_root_key_file: "${ov.rootKeyFile}"`]),
    ...(ov?.reviewerKeyFile === undefined ? [] : [`openviking_reviewer_key_file: "${ov.reviewerKeyFile}"`]),
    ...(ov?.users === undefined ? [] : [`openviking_provision_users: "${ov.users}"`]),
    ...(ov?.embedProvider === undefined ? [] : [`openviking_embedding_provider: "${ov.embedProvider}"`]),
    ...(ov?.embedModel === undefined ? [] : [`openviking_embedding_model: "${ov.embedModel}"`]),
    ...(ov?.embedDimension === undefined ? [] : [`openviking_embedding_dimension: ${ov.embedDimension}`]),
    ...(ov?.embedKeyFile === undefined ? [] : [`openviking_embedding_key_file: "${ov.embedKeyFile}"`]),
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
          ...(ov.auth === undefined ? [] : [`auth_mode = "${ov.auth}"`]),
          ...(ov.rootKeyFile === undefined ? [] : [`root_key_file = "${ov.rootKeyFile}"`]),
          ...(ov.reviewerKeyFile === undefined ? [] : [`reviewer_key_file = "${ov.reviewerKeyFile}"`]),
          ...(ov.users === undefined
            ? []
            : [`provision_users = [${ov.users.split(",").map((u) => `"${u}"`).join(", ")}]`]),
          ...(ov.embedProvider === undefined ? [] : [`embedding_provider = "${ov.embedProvider}"`]),
          ...(ov.embedModel === undefined ? [] : [`embedding_model = "${ov.embedModel}"`]),
          ...(ov.embedDimension === undefined ? [] : [`embedding_dimension = ${ov.embedDimension}`]),
          ...(ov.embedKeyFile === undefined ? [] : [`embedding_key_file = "${ov.embedKeyFile}"`]),
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
  /** The inventory text — host vars on the host line outrank group_vars. */
  inventory?: string;
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
  writeFileSync(join(ansible, "inventory.ini"), opts.inventory ?? "[quickreview]\nquickreview-vm ansible_user=mat\n");

  const git = (...args: string[]) =>
    execFileSync("git", ["-C", sandbox, ...args], {
      env: { ...process.env, GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@t", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@t" },
    });
  git("init", "-q");
  git("add", "-A");
  git("commit", "-qm", "scratch");
  return { dir, sandbox, ansible };
}

function run(e: Env, args: string[], extraEnv: Record<string, string> = {}): { code: number; stdout: string; stderr: string } {
  try {
    const stdout = execFileSync("bash", [deploySh, ...args], {
      encoding: "utf8",
      env: {
        ...process.env,
        QC_SANDBOX_DIR: e.sandbox,
        QC_ANSIBLE_DIR: e.ansible,
        QC_INVENTORY: join(e.ansible, "inventory.ini"),
        ...extraEnv,
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

  // the auth posture is a mirror too, and for the sharper reason:
  // the entrypoint renders group_vars, so a config.toml saying "api_key" over a
  // group_vars saying "dev" ships a server with NO per-user confinement while
  // every doc claims otherwise. That is what shipped for a week.
  describe("auth-mode drift", () => {
    const AUTH: OvPins = {
      ...OV,
      auth: "api_key",
      rootKeyFile: "openviking_root_key",
      reviewerKeyFile: "openviking_reviewer_key",
      users: "reviewer,companion",
    };

    it("names the auth mode in the plan when the mirror holds", () => {
      env = makeScratch({ configPi: "0.84.1", groupVarsPi: "0.84.1", configOv: AUTH, upstreamCommit: OV.extension! });
      const r = run(env, ["--dry-run"]);
      expect(r.code).toBe(0);
      expect(r.stdout).toContain("memory auth  auth_mode api_key");
      expect(r.stdout).toContain("'dev' means NO per-user confinement");
    });

    it("REFUSES to deploy api_key over a group_vars still saying dev", () => {
      env = makeScratch({
        configPi: "0.84.1",
        groupVarsPi: "0.84.1",
        configOv: AUTH,
        groupVarsOv: { ...AUTH, auth: "dev" },
        upstreamCommit: OV.extension!,
      });
      const r = run(env, ["--dry-run"]);
      expect(r.code).toBe(1);
      expect(r.stderr).toContain("openviking auth_mode pin mismatch");
      expect(r.stderr).toContain('group_vars    openviking_auth_mode = "dev"');
    });

    it("refuses when a secret FILE NAME drifts — the template would read nothing", () => {
      env = makeScratch({
        configPi: "0.84.1",
        groupVarsPi: "0.84.1",
        configOv: AUTH,
        groupVarsOv: { ...AUTH, rootKeyFile: "ov_root" },
        upstreamCommit: OV.extension!,
      });
      const r = run(env, ["--dry-run"]);
      expect(r.code).toBe(1);
      expect(r.stderr).toContain("openviking root key file pin mismatch");
    });

    it("refuses when the provisioned user list drifts", () => {
      env = makeScratch({
        configPi: "0.84.1",
        groupVarsPi: "0.84.1",
        configOv: AUTH,
        groupVarsOv: { ...AUTH, users: "reviewer" },
        upstreamCommit: OV.extension!,
      });
      const r = run(env, ["--dry-run"]);
      expect(r.code).toBe(1);
      expect(r.stderr).toContain("openviking provisioned users pin mismatch");
    });

    it("a config.toml with auth_mode and a group_vars without it is fatal, never skipped", () => {
      env = makeScratch({
        configPi: "0.84.1",
        groupVarsPi: "0.84.1",
        configOv: AUTH,
        groupVarsOv: { ...AUTH, auth: undefined },
        upstreamCommit: OV.extension!,
      });
      const r = run(env, ["--dry-run"]);
      expect(r.code).toBe(1);
      expect(r.stderr).toContain("has no openviking auth_mode pin");
    });
  });

  describe("embedder drift", () => {
    const LOCAL = { embedProvider: "local", embedModel: "bge-small-zh-v1.5-f16", embedDimension: "512", embedKeyFile: "openai_embeddings_api_key" };
    const HOSTED = { embedProvider: "openai", embedModel: "text-embedding-3-small", embedDimension: "1536", embedKeyFile: "openai_embeddings_api_key" };
    const base = { version: "0.4.15", llama: "0.3.35" };

    it("names the embedder in the plan when config.toml and group_vars agree on local", () => {
      env = makeScratch({ configPi: "0.84.4", groupVarsPi: "0.84.4", configOv: { ...base, ...LOCAL } });
      const r = run(env, ["--dry-run"]);
      expect(r.code).toBe(0);
      expect(r.stdout).toContain("memory embed local (config.toml == ansible effective value; 'local' means no memory text leaves the VM)");
    });

    it("REFUSES a config.toml opted into a hosted embedder over a boot that would render local — that boot would reset the store", () => {
      env = makeScratch({ configPi: "0.84.4", groupVarsPi: "0.84.4", configOv: { ...base, ...HOSTED }, groupVarsOv: { ...base, ...LOCAL } });
      const r = run(env, ["--dry-run"]);
      expect(r.code).toBe(1);
      expect(r.stderr).toContain("openviking embedding provider pin mismatch");
      expect(r.stderr).toContain('embedding_provider = "openai"');
      expect(r.stderr).toContain('openviking_embedding_provider = "local"');
    });

    it("an opt-in written as INVENTORY HOST VARS (the wizard's way) is the effective value and passes", () => {
      env = makeScratch({
        configPi: "0.84.4",
        groupVarsPi: "0.84.4",
        configOv: { ...base, ...HOSTED },
        groupVarsOv: { ...base, ...LOCAL },
        inventory:
          "# written by the wizard\n[quickreview]\nquickreview-vm cloudflared_enabled=false openviking_embedding_provider=openai " +
          "openviking_embedding_model=text-embedding-3-small openviking_embedding_dimension=1536\n\n[quickreview:vars]\nansible_user=mat\n",
      });
      const r = run(env, ["--dry-run"]);
      expect(r.code).toBe(0);
      expect(r.stdout).toContain("memory embed openai");
    });

    it("a dimension that drifts alone is refused too — same provider, different vector space", () => {
      env = makeScratch({ configPi: "0.84.4", groupVarsPi: "0.84.4", configOv: { ...base, ...HOSTED }, groupVarsOv: { ...base, ...HOSTED, embedDimension: "3072" } });
      const r = run(env, ["--dry-run"]);
      expect(r.code).toBe(1);
      expect(r.stderr).toContain("openviking embedding dimension pin mismatch");
    });

    it("a config.toml naming the embedder over a group_vars without it is fatal, never skipped", () => {
      env = makeScratch({ configPi: "0.84.4", groupVarsPi: "0.84.4", configOv: { ...base, ...LOCAL }, groupVarsOv: base });
      const r = run(env, ["--dry-run"]);
      expect(r.code).toBe(1);
      expect(r.stderr).toContain("has no openviking embedding provider pin");
    });
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

// ---- drain advisory (2026-08-25) — WARN only, never a refusal ---------------
//
// The heartbeat read is seamed through QC_STATUS_JSON_CMD so no test ever
// opens an ssh connection. Every case runs --dry-run: the advisory fires
// before the plan exits, and a warning must never change the exit code.
describe("deploy.sh drain advisory", () => {
  function status(e: Env, body: string): string {
    const p = join(e.dir, "status.json");
    writeFileSync(p, body);
    return `cat ${p}`;
  }

  /** Like run(), but with stderr folded into the captured output — the
   * advisory speaks on stderr and exits 0, which run() throws away. */
  function runMerged(e: Env, args: string[], extraEnv: Record<string, string>): { code: number; out: string } {
    const r = run(e, ["--dry-run", ...args], extraEnv);
    if (r.code !== 0) return { code: r.code, out: r.stdout + r.stderr };
    const out = execFileSync("bash", ["-c", `bash '${deploySh}' --dry-run 2>&1`], {
      encoding: "utf8",
      env: {
        ...process.env,
        QC_SANDBOX_DIR: e.sandbox,
        QC_ANSIBLE_DIR: e.ansible,
        QC_INVENTORY: join(e.ansible, "inventory.ini"),
        ...extraEnv,
      },
    });
    return { code: 0, out };
  }

  it("WARNS (exit 0) on an undrained deploy while rounds run", () => {
    env = makeScratch({ configPi: "0.84.1", groupVarsPi: "0.84.1" });
    const cmd = status(env, JSON.stringify({ running_rounds: 3, dry_run: false }));
    const res = runMerged(env, [], { QC_STATUS_JSON_CMD: cmd });
    expect(res.code).toBe(0); // WARN only — the owner chose warn over refusal
    expect(res.out).toContain("WARNING — deploying UNDRAINED while 3 round(s) are running");
    expect(res.out).toContain("qcr drain on");
  });

  it("stays quiet when the board is drained and quiet", () => {
    env = makeScratch({ configPi: "0.84.1", groupVarsPi: "0.84.1" });
    const cmd = status(env, JSON.stringify({ running_rounds: 0, draining: true }));
    const res = runMerged(env, [], { QC_STATUS_JSON_CMD: cmd });
    expect(res.code).toBe(0);
    expect(res.out).not.toContain("WARNING");
    expect(res.out).toContain("good to deploy");
  });

  it("says the drain is still converging when rounds remain", () => {
    env = makeScratch({ configPi: "0.84.1", groupVarsPi: "0.84.1" });
    const cmd = status(env, JSON.stringify({ running_rounds: 2, draining: true }));
    const res = runMerged(env, [], { QC_STATUS_JSON_CMD: cmd });
    expect(res.code).toBe(0);
    expect(res.out).toContain("drain is ON with 2 round(s) still finishing");
  });

  it("notes an unreadable heartbeat and proceeds", () => {
    env = makeScratch({ configPi: "0.84.1", groupVarsPi: "0.84.1" });
    const res = runMerged(env, [], { QC_STATUS_JSON_CMD: "false" });
    expect(res.code).toBe(0);
    expect(res.out).toContain("heartbeat unreadable");
  });
});
