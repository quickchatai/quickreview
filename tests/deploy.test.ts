// scripts/deploy.sh — pre-flight guardrails, exercised in a scratch git repo
// with a throwaway copy of the group_vars. Nothing here touches the
// real ansible asset, and no live deploy ever runs: every case stops at
// --dry-run or at a refusal.
import { afterEach, describe, expect, it } from "vitest";
import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { githubCloneDir } from "../src/config.js";

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
    "image_name: quickreview-sandbox",
    "image_tag: v1",
    'pi_npm_package: "@earendil-works/pi-coding-agent"',
    `pi_version: "${piVersion}"`,
    ...(ov?.version === undefined ? [] : [`openviking_version: "${ov.version}"`]),
    ...(ov?.llama === undefined ? [] : [`llama_cpp_python_version: "${ov.llama}"`]),
    ...(ov?.auth === undefined ? [] : [`openviking_auth_mode: "${ov.auth}"`]),
    ...(ov?.rootKeyFile === undefined ? [] : [`openviking_root_key_file: "${ov.rootKeyFile}"`]),
    ...(ov?.reviewerKeyFile === undefined
      ? []
      : [`openviking_reviewer_key_file: "${ov.reviewerKeyFile}"`]),
    ...(ov?.users === undefined ? [] : [`openviking_provision_users: "${ov.users}"`]),
    ...(ov?.embedProvider === undefined
      ? []
      : [`openviking_embedding_provider: "${ov.embedProvider}"`]),
    ...(ov?.embedModel === undefined ? [] : [`openviking_embedding_model: "${ov.embedModel}"`]),
    ...(ov?.embedDimension === undefined
      ? []
      : [`openviking_embedding_dimension: ${ov.embedDimension}`]),
    ...(ov?.embedKeyFile === undefined
      ? []
      : [`openviking_embedding_key_file: "${ov.embedKeyFile}"`]),
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
          ...(ov.reviewerKeyFile === undefined
            ? []
            : [`reviewer_key_file = "${ov.reviewerKeyFile}"`]),
          ...(ov.users === undefined
            ? []
            : [
                `provision_users = [${ov.users
                  .split(",")
                  .map((u) => `"${u}"`)
                  .join(", ")}]`,
              ]),
          ...(ov.embedProvider === undefined ? [] : [`embedding_provider = "${ov.embedProvider}"`]),
          ...(ov.embedModel === undefined ? [] : [`embedding_model = "${ov.embedModel}"`]),
          ...(ov.embedDimension === undefined
            ? []
            : [`embedding_dimension = ${ov.embedDimension}`]),
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
  /** A `[github]` table appended to config.toml (the clone name). */
  github?: { repo?: string; cloneDir?: string };
  /** Tracked files to commit with the scratch tree, path → contents. */
  tracked?: Record<string, string>;
}): Env {
  const dir = mkdtempSync(join(tmpdir(), "qcr-deploy-"));
  const sandbox = join(dir, "sandbox");
  const ansible = join(dir, "ansible");
  mkdirSync(sandbox, { recursive: true });
  mkdirSync(join(ansible, "group_vars"), { recursive: true });

  writeFileSync(
    join(sandbox, "config.toml"),
    CONFIG(opts.configPi, opts.configOv) +
      (opts.github === undefined
        ? ""
        : [
            "",
            "[github]",
            ...(opts.github.repo === undefined ? [] : [`repo = "${opts.github.repo}"`]),
            ...(opts.github.cloneDir === undefined
              ? []
              : [`clone_dir = "${opts.github.cloneDir}"   # trailing comment`]),
            "",
          ].join("\n")),
  );
  for (const [rel, body] of Object.entries(opts.tracked ?? {})) {
    mkdirSync(dirname(join(sandbox, rel)), { recursive: true });
    writeFileSync(join(sandbox, rel), body);
  }
  writeFileSync(
    join(ansible, "group_vars", "all.yml"),
    GROUP_VARS(opts.groupVarsPi, opts.sandboxSrc ?? true, opts.groupVarsOv ?? opts.configOv),
  );
  if (opts.upstreamCommit !== undefined) {
    mkdirSync(join(sandbox, "extensions", "vendor", "openviking-pi"), { recursive: true });
    writeFileSync(
      join(sandbox, "extensions", "vendor", "openviking-pi", "upstream.json"),
      JSON.stringify(
        { repo: "https://github.com/volcengine/OpenViking", commit: opts.upstreamCommit },
        null,
        2,
      ) + "\n",
    );
  }
  writeFileSync(
    join(ansible, "playbook.yml"),
    "---\n# stub playbook (the real asset is never touched by tests)\n",
  );
  writeFileSync(
    join(ansible, "inventory.ini"),
    opts.inventory ?? "[quickreview]\nquickreview-vm ansible_user=mat\n",
  );

  const git = (...args: string[]) =>
    execFileSync("git", ["-C", sandbox, ...args], {
      env: {
        ...process.env,
        GIT_AUTHOR_NAME: "t",
        GIT_AUTHOR_EMAIL: "t@t",
        GIT_COMMITTER_NAME: "t",
        GIT_COMMITTER_EMAIL: "t@t",
      },
    });
  git("init", "-q");
  git("add", "-A");
  git("commit", "-qm", "scratch");
  return { dir, sandbox, ansible };
}

function run(
  e: Env,
  args: string[],
  extraEnv: Record<string, string> = {},
): { code: number; stdout: string; stderr: string } {
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
    return {
      code: e2.status ?? -1,
      stdout: String(e2.stdout ?? ""),
      stderr: String(e2.stderr ?? ""),
    };
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
describe("deploy.sh — the install locator", () => {
  /** A config in the install's config home under a temp XDG dir. */
  function homeConfig(e: Env, pi: string): Record<string, string> {
    const xdg = join(e.dir, "xdg-config");
    mkdirSync(join(xdg, "qcr", "default"), { recursive: true });
    writeFileSync(join(xdg, "qcr", "default", "config.toml"), CONFIG(pi));
    return { XDG_CONFIG_HOME: xdg };
  }

  it("the pin preflight reads the config home, not the checkout, when the home has one", () => {
    env = makeScratch({ configPi: "0.84.1", groupVarsPi: "0.84.1" });
    const r = run(env, ["--dry-run", "verify"], homeConfig(env, "0.85.0"));
    expect(r.code).toBe(1);
    expect(r.stderr).toContain('config.toml   [pi] version = "0.85.0"');
  });

  it("the checkout's config.toml is still the fallback with an empty config home", () => {
    env = makeScratch({ configPi: "0.84.1", groupVarsPi: "0.84.1" });
    const r = run(env, ["--dry-run"], { XDG_CONFIG_HOME: join(env.dir, "empty-xdg") });
    expect(r.code).toBe(0);
  });

  it("a shipping mode REFUSES a live config outside the checkout — the rsync would not carry it", () => {
    env = makeScratch({ configPi: "0.84.1", groupVarsPi: "0.84.1" });
    for (const mode of ["sync", "rebuild"]) {
      const r = run(env, ["--dry-run", mode], homeConfig(env, "0.84.1"));
      expect(r.code).toBe(1);
      expect(r.stderr).toContain("outside the checkout");
      expect(r.stderr).toContain("");
    }
    const other = join(env.dir, "elsewhere.toml");
    writeFileSync(other, CONFIG("0.84.1"));
    const r = run(env, ["--dry-run"], { QCR_CONFIG: other });
    expect(r.code).toBe(1);
    expect(r.stderr).toContain("outside the checkout");
    // verify ships nothing, so it is not refused
    expect(run(env, ["--dry-run", "verify"], homeConfig(env, "0.84.1")).code).toBe(0);
  });
});

describe("deploy.sh — OpenViking pin drift", () => {
  const OV: OvPins = {
    version: "0.4.15",
    llama: "0.3.35",
    extension: "d436baa23c83938b22bb0aab08b0ce48568b5ff4",
  };

  it("passes and names the memory pins in the plan when everything agrees", () => {
    env = makeScratch({
      configPi: "0.84.1",
      groupVarsPi: "0.84.1",
      configOv: OV,
      upstreamCommit: OV.extension!,
    });
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
    env = makeScratch({
      configPi: "0.84.1",
      groupVarsPi: "0.84.1",
      configOv: OV,
      upstreamCommit: "0000000000000000000000000000000000000000",
    });
    const r = run(env, ["--dry-run"]);
    expect(r.code).toBe(1);
    expect(r.stderr).toContain("openviking pi-extension base commit pin mismatch");
  });

  it("a pin present on one side only is fatal, never silently skipped", () => {
    env = makeScratch({
      configPi: "0.84.1",
      groupVarsPi: "0.84.1",
      configOv: OV,
      groupVarsOv: { version: OV.version },
    });
    const r = run(env, ["--dry-run"]);
    expect(r.code).toBe(1);
    expect(r.stderr).toContain("has no llama-cpp-python pin");
  });

  it("an extension_commit with no upstream.json beside it is fatal", () => {
    env = makeScratch({ configPi: "0.84.1", groupVarsPi: "0.84.1", configOv: OV });
    const r = run(env, ["--dry-run"]);
    expect(r.code).toBe(1);
    expect(r.stderr).toContain(
      'upstream.json "commit" has no openviking pi-extension base commit pin',
    );
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
      env = makeScratch({
        configPi: "0.84.1",
        groupVarsPi: "0.84.1",
        configOv: AUTH,
        upstreamCommit: OV.extension!,
      });
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
    const LOCAL = {
      embedProvider: "local",
      embedModel: "bge-small-zh-v1.5-f16",
      embedDimension: "512",
      embedKeyFile: "openai_embeddings_api_key",
    };
    const HOSTED = {
      embedProvider: "openai",
      embedModel: "text-embedding-3-small",
      embedDimension: "1536",
      embedKeyFile: "openai_embeddings_api_key",
    };
    const base = { version: "0.4.15", llama: "0.3.35" };

    it("names the embedder in the plan when config.toml and group_vars agree on local", () => {
      env = makeScratch({
        configPi: "0.84.4",
        groupVarsPi: "0.84.4",
        configOv: { ...base, ...LOCAL },
      });
      const r = run(env, ["--dry-run"]);
      expect(r.code).toBe(0);
      expect(r.stdout).toContain(
        "memory embed local (config.toml == ansible effective value; 'local' means no memory text leaves the VM)",
      );
    });

    it("REFUSES a config.toml opted into a hosted embedder over a boot that would render local — that boot would reset the store", () => {
      env = makeScratch({
        configPi: "0.84.4",
        groupVarsPi: "0.84.4",
        configOv: { ...base, ...HOSTED },
        groupVarsOv: { ...base, ...LOCAL },
      });
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
      env = makeScratch({
        configPi: "0.84.4",
        groupVarsPi: "0.84.4",
        configOv: { ...base, ...HOSTED },
        groupVarsOv: { ...base, ...HOSTED, embedDimension: "3072" },
      });
      const r = run(env, ["--dry-run"]);
      expect(r.code).toBe(1);
      expect(r.stderr).toContain("openviking embedding dimension pin mismatch");
    });

    it("a config.toml naming the embedder over a group_vars without it is fatal, never skipped", () => {
      env = makeScratch({
        configPi: "0.84.4",
        groupVarsPi: "0.84.4",
        configOv: { ...base, ...LOCAL },
        groupVarsOv: base,
      });
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
  function runMerged(
    e: Env,
    args: string[],
    extraEnv: Record<string, string>,
  ): { code: number; out: string } {
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

// ---- the base clone, for ANY repo name ---------------------------
// The VM's base clone lives inside the rsync --delete target, and it survives
// a sync only because the playbook excludes it BY NAME. That name used to be
// one install's literal repo name, so any other reviewed repo had its clone
// wiped on every sync; and the tracked `.gitignore` line of that literal left
// any other clone reading as a dirty tree, which this script refuses. Both
// now follow the configured clone name.
describe("deploy.sh — base clone name", () => {
  const ACME = { repo: "acme/acme-api" };

  /** The sync task's rsync_opts, read out of the REAL playbook. */
  function playbookRsyncOpts(): string[] {
    const playbook = readFileSync(join(root, "deploy", "ansible", "playbook.yml"), "utf8");
    const at = playbook.indexOf("- name: Sync the local sandbox working copy");
    expect(at).toBeGreaterThan(0);
    const block = playbook.slice(at, playbook.indexOf("- name:", at + 1));
    return [...block.matchAll(/^\s+- "(--[^"]+)"$/gm)].map((m) => m[1]!);
  }

  /** Render the playbook's Jinja the way ansible would for these extra vars. */
  function render(opt: string, vars: Record<string, string>): string {
    return opt.replace(/\{\{\s*(\w+)(?:\s*\|\s*mandatory)?\s*\}\}/g, (_, k: string) => {
      const v = vars[k];
      if (v === undefined) throw new Error(`playbook var ${k} undefined — ansible would fail`);
      return v;
    });
  }

  /** The `-e k=v` extra vars on the planned ansible command. */
  function extraVars(stdout: string): Record<string, string> {
    const line = stdout.split("\n").find((l) => l.includes("  command      ")) ?? "";
    return Object.fromEntries(
      [...line.matchAll(/-e (\w+)=(\S+)/g)].map((m) => [m[1]!, m[2]!] as const),
    );
  }

  it("names the clone in the plan and hands it to the playbook in sync and rebuild", () => {
    env = makeScratch({ configPi: "0.84.1", groupVarsPi: "0.84.1", github: ACME });
    const sync = run(env, ["--dry-run"]);
    expect(sync.code).toBe(0);
    expect(sync.stdout).toContain("base clone   /acme-api");
    expect(extraVars(sync.stdout).base_clone_dir).toBe("acme-api");
    const rebuild = run(env, ["--dry-run", "rebuild"]);
    expect(rebuild.code).toBe(0);
    expect(extraVars(rebuild.stdout).base_clone_dir).toBe("acme-api");
  });

  it("derives the name exactly as githubCloneDir does", () => {
    const cases: { repo?: string; cloneDir?: string }[] = [
      { repo: "acme/acme-api" },
      { repo: "https://github.com/acme/widgets.git" },
      { repo: "git@github.com:acme/gadgets.git" },
      { repo: "acme/trailing/" },
      { repo: "acme/acme-api", cloneDir: "base" },
      { repo: "acme/acme-api", cloneDir: "  " },
      {},
    ];
    for (const g of cases) {
      env = makeScratch({ configPi: "0.84.1", groupVarsPi: "0.84.1", github: g });
      const r = run(env, ["--dry-run"]);
      expect(r.code, JSON.stringify(g)).toBe(0);
      const want = githubCloneDir({ repo: g.repo ?? "", clone_dir: g.cloneDir ?? "" } as never);
      expect(extraVars(r.stdout).base_clone_dir, JSON.stringify(g)).toBe(want);
      rmSync(env.dir, { recursive: true, force: true });
    }
  }, 60_000); // seven scratch repos + seven script runs

  it("a clone of another repo's name SURVIVES the playbook's real rsync --delete, and stale files still go", () => {
    let hasRsync = true;
    try {
      execFileSync("rsync", ["--version"], { stdio: "ignore" });
    } catch {
      hasRsync = false;
    }
    if (!hasRsync) return; // the sync itself needs rsync; the plan cases above still run
    env = makeScratch({ configPi: "0.84.1", groupVarsPi: "0.84.1", github: ACME });
    const vars = extraVars(run(env, ["--dry-run"]).stdout);
    const opts = playbookRsyncOpts().map((o) => render(o, vars));
    expect(opts).toContain("--exclude=/acme-api");
    // exactly one anchored exclude is not a known runtime dir: the clone's
    const runtime = ["state", "wt", "archive", "commands", "digest", "inject", "verdict", "memory",
      "notes", "ledger.md", "AGENTS.override.md", "pihome"];
    const clones = opts.filter((o) => /^--exclude=\/[^/]+$/.test(o) && !runtime.includes(o.slice(11)));
    expect(clones).toEqual(["--exclude=/acme-api"]);

    const src = join(env.dir, "src-tree");
    const dest = join(env.dir, "vm-sandbox");
    mkdirSync(join(src, "dist"), { recursive: true });
    writeFileSync(join(src, "dist", "daemon.js"), "new build\n");
    mkdirSync(join(dest, "acme-api", ".git"), { recursive: true });
    writeFileSync(join(dest, "acme-api", ".git", "HEAD"), "ref: refs/heads/main\n");
    writeFileSync(join(dest, "acme-api", "README.md"), "the reviewed repo\n");
    writeFileSync(join(dest, "removed-upstream.txt"), "stale\n");

    execFileSync("rsync", ["-a", ...opts, `${src}/`, `${dest}/`]);
    expect(readFileSync(join(dest, "acme-api", "README.md"), "utf8")).toBe("the reviewed repo\n");
    expect(existsSync(join(dest, "acme-api", ".git", "HEAD"))).toBe(true);
    expect(existsSync(join(dest, "removed-upstream.txt"))).toBe(false);
    expect(readFileSync(join(dest, "dist", "daemon.js"), "utf8")).toBe("new build\n");
  });

  it("the playbook refuses to render without a clone name (no silent default)", () => {
    const opt = playbookRsyncOpts().find((o) => o.includes("base_clone_dir"));
    expect(opt).toBe("--exclude=/{{ base_clone_dir | mandatory }}");
    expect(() => render(opt!, {})).toThrow(/undefined/);
  });

  it("a local clone of any name does not dirty the tree: it lands in info/exclude, once", () => {
    env = makeScratch({ configPi: "0.84.1", groupVarsPi: "0.84.1", github: ACME });
    // a real nested repo, exactly what WorktreeManager.ensureBaseClone leaves
    execFileSync("git", ["init", "-q", join(env.sandbox, "acme-api")]);
    const r = run(env, ["--dry-run"]);
    expect(r.code).toBe(0);
    const exclude = readFileSync(join(env.sandbox, ".git", "info", "exclude"), "utf8");
    expect(exclude).toMatch(/^\/acme-api\/$/m);
    const status = execFileSync("git", ["-C", env.sandbox, "status", "--porcelain"], {
      encoding: "utf8",
    });
    expect(status).toBe("");
    expect(run(env, ["--dry-run"]).code).toBe(0);
    const again = readFileSync(join(env.sandbox, ".git", "info", "exclude"), "utf8");
    expect(again.match(/^\/acme-api\/$/gm)).toHaveLength(1);
  });

  it("never glues the rule onto an exclude file's unterminated last line", () => {
    env = makeScratch({ configPi: "0.84.1", groupVarsPi: "0.84.1", github: ACME });
    writeFileSync(join(env.sandbox, ".git", "info", "exclude"), "*.swp");
    expect(run(env, ["--dry-run"]).code).toBe(0);
    expect(readFileSync(join(env.sandbox, ".git", "info", "exclude"), "utf8")).toBe(
      "*.swp\n/acme-api/\n",
    );
  });

  it("refuses a clone name that is not one plain directory name", () => {
    env = makeScratch({
      configPi: "0.84.1",
      groupVarsPi: "0.84.1",
      github: { repo: "acme/acme-api", cloneDir: "../escape" },
    });
    const r = run(env, ["--dry-run"]);
    expect(r.code).toBe(1);
    expect(r.stderr).toContain("not one plain directory name");
  });

  it("--help still prints the whole header, Usage and Env included, however long it grows", () => {
    const help = execFileSync("bash", [deploySh, "--help"], { encoding: "utf8" });
    expect(help).toContain("base-clone name");
    expect(help).toContain("Usage:");
    expect(help).toContain("QCR_CONFIG");
    expect(help).not.toContain("set -euo pipefail");
  });

  it("refuses a clone name that is a runtime/build dir of the sandbox root — the list mirrors the playbook", () => {
    // the reserved list in deploy.sh must name every exclude the playbook
    // carries besides the clone's own (read out of the REAL playbook)
    const reserved = /^BASE_CLONE_RESERVED=\(([^)]*)\)$/m.exec(readFileSync(deploySh, "utf8"))?.[1];
    expect(reserved).toBeDefined();
    const list = reserved!.split(/\s+/).filter(Boolean);
    const excludes = playbookRsyncOpts()
      .filter((o) => o.startsWith("--exclude=") && !o.includes("{{"))
      .map((o) => o.slice("--exclude=".length).replace(/^\//, ""));
    expect(excludes.length).toBeGreaterThan(5);
    for (const e of excludes) expect(list, e).toContain(e);
    expect(list).toContain("dist");

    for (const name of ["notes", "wt", "dist"]) {
      env = makeScratch({ configPi: "0.84.1", groupVarsPi: "0.84.1", github: { repo: `acme/${name}` } });
      const r = run(env, ["--dry-run"]);
      expect(r.code, name).toBe(1);
      expect(r.stderr, name).toContain("runtime or build directory");
      rmSync(env.dir, { recursive: true, force: true });
    }
  }, 60_000);

  it("refuses a clone name that collides with a tracked path — excluding it would ship no daemon", () => {
    env = makeScratch({
      configPi: "0.84.1",
      groupVarsPi: "0.84.1",
      github: { repo: "acme/src" },
      tracked: { "src/daemon.ts": "export {};\n" },
    });
    const r = run(env, ["--dry-run"]);
    expect(r.code).toBe(1);
    expect(r.stderr).toContain("collides with a tracked path");
  });

  it("the tracked .gitignore names no install's clone — that rule is local now", () => {
    const gitignore = readFileSync(join(root, ".gitignore"), "utf8");
    // this checkout's own live config, when it has one (the published
    // snapshot does not): its clone name must not be a tracked ignore line
    const live = join(root, "config.toml");
    if (existsSync(live)) {
      const g = /\[github\]([\s\S]*?)(?:\n\[|$)/.exec(readFileSync(live, "utf8"))?.[1] ?? "";
      const val = (k: string) => new RegExp(`^${k}\\s*=\\s*"([^"]*)"`, "m").exec(g)?.[1] ?? "";
      const name = githubCloneDir({ repo: val("repo"), clone_dir: val("clone_dir") } as never);
      expect(gitignore.split("\n").map((l) => l.replace(/^\/|\/$/g, ""))).not.toContain(name);
    }
    expect(gitignore).toContain("info/exclude");
  });
});
