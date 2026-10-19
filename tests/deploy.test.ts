// scripts/deploy.sh — pre-flight guardrails, exercised in a scratch git repo
// with a throwaway copy of the group_vars. Nothing here touches the
// real ansible asset, and no live deploy ever runs: every case stops at
// --dry-run or at a refusal.
import { afterEach, describe, expect, it } from "vitest";
import { execFileSync, spawnSync } from "node:child_process";
import {
  chmodSync,
  existsSync,
  lstatSync,
  mkdtempSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parse as parseYaml } from "yaml";
import { githubCloneDir, LOCAL_EMBEDDING, RETIRED_LOCAL_EMBEDDING } from "../src/config.js";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const deploySh = join(root, "scripts", "deploy.sh");
const fingerprintSh = join(root, "scripts", "config-fingerprint.sh");

/** The OpenViking half of the pins. `undefined` = no such pin in
 * the file, which is a distinct case from a mismatching one. */
interface OvPins {
  version?: string;
  llama?: string;
  extension?: string;
  /** The auth posture is mirrored exactly like the pins. */
  auth?: string;
  rootKeyFile?: string;
  reviewerKeyFile?: string;
  users?: string;
  /** The embedder, mirrored against the effective ansible value. */
  embedProvider?: string;
  embedModel?: string;
  embedDimension?: string;
  embedKeyFile?: string;
  /** The local embedder's model-file pin and service knobs. */
  localEmbedder?: LocalEmbedderPin;
  /** Raw `[openviking]` lines for config.toml only — a partial pin block. */
  configLines?: string[];
  /** Who runs the server: config.toml `endpoint` / group_vars `openviking_endpoint`. */
  endpoint?: string;
  /** config.toml `[openviking] host` / `port` (the daemon's probe target). */
  host?: string;
  port?: string;
  /** group_vars `memory_container_name` — the sidecar's name on its network. */
  memoryContainer?: string;
}

interface LocalEmbedderPin {
  dir: string;
  model: string;
  url: string;
  sha: string;
  port: string;
  threads: string;
}

/** The scratch tree's memory shape. A shipping mode needs the sidecar (the
 * release image has no OpenViking), so by default both sides say `remote`;
 * `legacy` is the older, endpoint-less spelling the `verify`-side cases keep. */
interface Shape {
  legacy?: boolean;
  /** `[tui] remote_sandbox_root`; null leaves the key out. */
  tuiRoot?: string | null;
}

const GROUP_VARS = (piVersion: string, withSandboxSrc = true, ov?: OvPins, shape: Shape = {}) =>
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
    ...(ov?.endpoint !== undefined
      ? [`openviking_endpoint: "${ov.endpoint}"`]
      : shape.legacy
        ? []
        : ['openviking_endpoint: "remote"']),
    ...(ov?.memoryContainer === undefined ? [] : [`memory_container_name: ${ov.memoryContainer}`]),
    ...(ov?.port === undefined ? [] : [`openviking_port: ${ov.port}`]),
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
    ...(ov?.localEmbedder === undefined
      ? []
      : [
          `openviking_local_embedder_model: "${ov.localEmbedder.model}"`,
          `openviking_local_embedder_dir: ${ov.localEmbedder.dir}`,
          `openviking_local_embedder_url: "${ov.localEmbedder.url}"`,
          `openviking_local_embedder_sha256: "${ov.localEmbedder.sha}"`,
          `openviking_local_embedder_port: ${ov.localEmbedder.port}`,
          `openviking_local_embedder_threads: ${ov.localEmbedder.threads}`,
        ]),
    ...(withSandboxSrc ? ['sandbox_src: "/tmp/whatever"'] : ['# sandbox_src: "/tmp/whatever"']),
    "",
  ].join("\n");

const CONFIG = (piVersion: string, ov?: OvPins, shape: Shape = {}) =>
  [
    "dry_run = true",
    "",
    "[pi]",
    'package = "@earendil-works/pi-coding-agent"',
    `version = "${piVersion}"`,
    'session_dir = "state/pi-sessions"',
    ...(shape.tuiRoot === null
      ? []
      : ["", "[tui]", `remote_sandbox_root = "${shape.tuiRoot ?? "/opt/qcr"}"`]),
    ...(ov === undefined && shape.legacy
      ? []
      : [
          "",
          "[openviking]",
          ...(ov?.endpoint === undefined && !shape.legacy ? ['endpoint = "remote"'] : []),
          ...(ov?.host === undefined && !shape.legacy && (ov?.endpoint ?? "remote") === "remote"
            ? ['host = "quickreview-memory"']
            : []),
          ...(ov === undefined
            ? []
            : [
                ...(ov.version === undefined ? [] : [`version = "${ov.version}"`]),
                ...(ov.llama === undefined ? [] : [`llama_cpp_python_version = "${ov.llama}"`]),
                ...(ov.endpoint === undefined ? [] : [`endpoint = "${ov.endpoint}"`]),
                ...(ov.host === undefined ? [] : [`host = "${ov.host}"`]),
                ...(ov.port === undefined ? [] : [`port = ${ov.port}`]),
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
                ...(ov.embedProvider === undefined
                  ? []
                  : [`embedding_provider = "${ov.embedProvider}"`]),
                ...(ov.embedModel === undefined ? [] : [`embedding_model = "${ov.embedModel}"`]),
                ...(ov.embedDimension === undefined
                  ? []
                  : [`embedding_dimension = ${ov.embedDimension}`]),
                ...(ov.embedKeyFile === undefined
                  ? []
                  : [`embedding_key_file = "${ov.embedKeyFile}"`]),
                ...(ov.localEmbedder === undefined
                  ? []
                  : [
                      `local_embedder_file = "${ov.localEmbedder.dir}/${ov.localEmbedder.model}.gguf"`,
                      `local_embedder_url = "${ov.localEmbedder.url}"`,
                      `local_embedder_sha256 = "${ov.localEmbedder.sha}"`,
                      `local_embedder_port = ${ov.localEmbedder.port}`,
                      `local_embedder_threads = ${ov.localEmbedder.threads}`,
                    ]),
                ...(ov.configLines ?? []),
              ]),
        ]),
    "",
  ].join("\n");

interface Env {
  sandbox: string;
  ansible: string;
  dir: string;
  /** The scratch XDG_CONFIG_HOME every run uses unless a case overrides it —
   * the operator's own config home is never read. */
  xdg: string;
  /** The install's config home under it: `<xdg>/qcr/default`. */
  home: string;
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
  github?: { repo?: string; cloneDir?: string; secretsDir?: string };
  /** `[review] profile` in config.toml. */
  profile?: string;
  /** Tracked files to commit with the scratch tree, path → contents. */
  tracked?: Record<string, string>;
  /** Where the live config.toml lives: the install's config home (the
   * default — what a deploy ships), or stranded in the checkout (never read). */
  configAt?: "home" | "checkout";
  /** Files in the config home, path relative to it → contents. */
  homeFiles?: Record<string, string>;
  /** The memory shape and `[tui]` root the scratch config carries. */
  shape?: Shape;
}): Env {
  const dir = mkdtempSync(join(tmpdir(), "qcr-deploy-"));
  const sandbox = join(dir, "sandbox");
  const ansible = join(dir, "ansible");
  const xdg = join(dir, "xdg");
  const home = join(xdg, "qcr", "default");
  mkdirSync(sandbox, { recursive: true });
  mkdirSync(home, { recursive: true });
  mkdirSync(join(ansible, "group_vars"), { recursive: true });
  for (const [rel, body] of Object.entries(opts.homeFiles ?? {})) {
    mkdirSync(dirname(join(home, rel)), { recursive: true });
    writeFileSync(join(home, rel), body);
  }

  writeFileSync(
    join(opts.configAt === "checkout" ? sandbox : home, "config.toml"),
    CONFIG(opts.configPi, opts.configOv, opts.shape) +
      (opts.github === undefined
        ? ""
        : [
            "",
            "[github]",
            ...(opts.github.repo === undefined ? [] : [`repo = "${opts.github.repo}"`]),
            ...(opts.github.cloneDir === undefined
              ? []
              : [`clone_dir = "${opts.github.cloneDir}"   # trailing comment`]),
            ...(opts.github.secretsDir === undefined
              ? []
              : [`secrets_dir = "${opts.github.secretsDir}"`]),
            "",
          ].join("\n")) +
      (opts.profile === undefined ? "" : `\n[review]\nprofile = "${opts.profile}"   # c\n`),
  );
  for (const [rel, body] of Object.entries(opts.tracked ?? {})) {
    mkdirSync(dirname(join(sandbox, rel)), { recursive: true });
    writeFileSync(join(sandbox, rel), body);
  }
  writeFileSync(
    join(ansible, "group_vars", "all.yml"),
    GROUP_VARS(
      opts.groupVarsPi,
      opts.sandboxSrc ?? true,
      opts.groupVarsOv ?? opts.configOv,
      opts.shape,
    ),
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
  // An empty tree cannot be committed — keep one tracked file whatever the case.
  writeFileSync(join(sandbox, "README.md"), "scratch\n");
  git("add", "-A");
  git("commit", "-qm", "scratch");
  return { dir, sandbox, ansible, xdg, home };
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
        XDG_CONFIG_HOME: e.xdg,
        // The recorded ghcr token expiry is read from the state home: never the operator's.
        XDG_STATE_HOME: join(e.dir, "state-home"),
        QCR_GHCR_EXPIRY_FILE: "",
        QCR_CONFIG: "",
        QCR_INSTALL: "",
        // A release's pull check reads the VM over ssh; by default the stub finds both images.
        QC_PULL_CHECK_CMD: "true",
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
    // An image that comes out identical recreates nothing, and the code and
    // config are bind mounts: only a restart puts the shipped tree to work.
    expect(r.stdout).toContain("-e force_restart=true");
  });

  it("plans ssh-only checks in verify mode (cloudflared + container + heartbeat)", () => {
    env = makeScratch({ configPi: "0.84.1", groupVarsPi: "0.84.1" });
    const r = run(env, ["--dry-run", "verify"]);
    expect(r.code).toBe(0);
    expect(r.stdout).toContain("systemctl is-active cloudflared");
    expect(r.stdout).toContain("status.json");
    expect(r.stdout).not.toContain("ansible-playbook");
  });

  it("checks cloudflared only when the inventory enables it — the playbook installs it on that condition alone", () => {
    const withInventory = (line: string) => {
      env = makeScratch({
        configPi: "0.84.1",
        groupVarsPi: "0.84.1",
        inventory: `[quickreview]\n${line}\n\n[quickreview:vars]\nansible_user=mat\n`,
      });
      const r = run(env, ["--dry-run", "verify"]);
      rmSync(env.dir, { recursive: true, force: true });
      return r;
    };
    const off = withInventory("quickreview-vm cloudflared_enabled=false");
    expect(off.code).toBe(0);
    expect(off.stdout).not.toContain("systemctl is-active cloudflared");
    expect(off.stdout).toContain("cloudflared not checked — cloudflared_enabled=false");
    expect(off.stdout).toContain("systemctl is-active docker");
    // Ansible's `| bool` reading: a hand-edited quoted or capitalised yes is
    // true, and no host var at all is the tracked default (true).
    for (const on of ['cloudflared_enabled="True"', "cloudflared_enabled=yes", ""]) {
      const r = withInventory(`quickreview-vm ${on}`.trim());
      expect(r.code, on).toBe(0);
      expect(r.stdout, on).toContain("systemctl is-active cloudflared");
    }
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

// ---- the config home ships ---------------------------------------------------
// sync|rebuild deliver the install's config home — the located config and the
// profiles/ beside it — to the VM by a playbook task of its own; the container
// reads it through QCR_CONFIG. The pin/drift preflight reads that same config.

/** The `-e k=v` extra vars on the planned ansible command. */
function planVars(stdout: string): Record<string, string> {
  const line = stdout.split("\n").find((l) => l.includes("  command      ")) ?? "";
  return Object.fromEntries(
    [...line.matchAll(/-e (\w+)=(\S+)/g)].map((m) => [m[1]!, m[2]!] as const),
  );
}

describe("deploy.sh — the config home ships", () => {
  it("the pin preflight reads the config home — a checkout config.toml beside it changes nothing", () => {
    env = makeScratch({
      configPi: "0.85.0",
      groupVarsPi: "0.84.1",
      tracked: { "config.toml": CONFIG("0.84.1") },
    });
    const r = run(env, ["--dry-run", "verify"]);
    expect(r.code).toBe(1);
    expect(r.stderr).toContain('config.toml   [pi] version = "0.85.0"');
  });

  it("sync and rebuild hand the config home to the playbook; verify ships nothing", () => {
    env = makeScratch({ configPi: "0.84.1", groupVarsPi: "0.84.1" });
    const home = realpathSync(env.home);
    for (const mode of ["sync", "rebuild"]) {
      const r = run(env, ["--dry-run", mode]);
      expect(r.code, r.stderr).toBe(0);
      expect(planVars(r.stdout).config_home_src).toBe(home);
      expect(planVars(r.stdout).config_file_name).toBe("config.toml");
      expect(r.stdout).toContain(`config home  ${home} (config.toml + profiles/`);
      expect(r.stdout).toContain("secrets/ never rides it");
    }
    const v = run(env, ["--dry-run", "verify"]);
    expect(v.code).toBe(0);
    expect(v.stdout).not.toContain("config home");
  });

  it("sync and rebuild hand the playbook the checkout they validated and built, never its own default", () => {
    env = makeScratch({ configPi: "0.84.1", groupVarsPi: "0.84.1" });
    for (const mode of ["sync", "rebuild"]) {
      const r = run(env, ["--dry-run", mode]);
      expect(r.code, r.stderr).toBe(0);
      expect(planVars(r.stdout).sandbox_src).toBe(env.sandbox);
    }
  });

  it("REFUSES a sandbox path the playbook cannot be handed whole", () => {
    env = makeScratch({ configPi: "0.84.1", groupVarsPi: "0.84.1" });
    const spaced = join(env.dir, "my sandbox");
    symlinkSync(env.sandbox, spaced);
    const r = run(env, ["--dry-run"], { QC_SANDBOX_DIR: spaced });
    expect(r.code).toBe(1);
    expect(r.stderr).toContain("contains whitespace, quotes or braces");
    expect(r.stdout).not.toContain("ansible-playbook");
  });

  it("QCR_CONFIG names the file: its directory is the home that ships, under its own name", () => {
    env = makeScratch({ configPi: "0.84.1", groupVarsPi: "0.84.1" });
    const elsewhere = join(env.dir, "elsewhere");
    mkdirSync(elsewhere);
    writeFileSync(join(elsewhere, "prod.toml"), CONFIG("0.84.1"));
    const r = run(env, ["--dry-run"], { QCR_CONFIG: join(elsewhere, "prod.toml") });
    expect(r.code, r.stderr).toBe(0);
    expect(planVars(r.stdout).config_home_src).toBe(realpathSync(elsewhere));
    expect(planVars(r.stdout).config_file_name).toBe("prod.toml");
  });

  it("REFUSES a missing home: a config that lives only in the checkout is never read or shipped", () => {
    env = makeScratch({ configPi: "0.84.1", groupVarsPi: "0.84.1", configAt: "checkout" });
    // The checkout's config.toml is not a fallback for any mode —
    // the located config (the empty home's) is missing, and migrate is named.
    for (const mode of ["sync", "rebuild", "verify"]) {
      const r = run(env, ["--dry-run", mode]);
      expect(r.code).toBe(1);
      expect(r.stderr).toContain(`no config at ${join(env.home, "config.toml")}`);
      expect(r.stderr).toContain("qcr install migrate");
    }
    // QCR_CONFIG pointed back into the checkout: shipping refuses it…
    const r = run(env, ["--dry-run"], { QCR_CONFIG: join(env.sandbox, "config.toml") });
    expect(r.code).toBe(1);
    expect(r.stderr).toContain("no config home to ship");
    // …and verify, which ships nothing, reads the file the operator named.
    expect(
      run(env, ["--dry-run", "verify"], { QCR_CONFIG: join(env.sandbox, "config.toml") }).code,
    ).toBe(0);
  });

  it("REFUSES when there is no config anywhere", () => {
    env = makeScratch({ configPi: "0.84.1", groupVarsPi: "0.84.1" });
    rmSync(join(env.home, "config.toml"));
    const r = run(env, ["--dry-run"]);
    expect(r.code).toBe(1);
    expect(r.stderr).toContain("no config at");
  });

  it("refuses a config home path the playbook's -e k=v would split", () => {
    env = makeScratch({ configPi: "0.84.1", groupVarsPi: "0.84.1" });
    const spaced = join(env.dir, "with space");
    mkdirSync(spaced);
    writeFileSync(join(spaced, "config.toml"), CONFIG("0.84.1"));
    const r = run(env, ["--dry-run"], { QCR_CONFIG: join(spaced, "config.toml") });
    expect(r.code).toBe(1);
    expect(r.stderr).toContain("whitespace");
  });

  it("refuses a config file name that is not a plain name (it becomes an rsync filter pattern)", () => {
    env = makeScratch({ configPi: "0.84.1", groupVarsPi: "0.84.1" });
    const other = join(env.dir, "globbed");
    mkdirSync(other);
    writeFileSync(join(other, "c[1].toml"), CONFIG("0.84.1"));
    const r = run(env, ["--dry-run"], { QCR_CONFIG: join(other, "c[1].toml") });
    expect(r.code).toBe(1);
    expect(r.stderr).toContain("not a plain file name");
    // verify ships nothing, so it is not refused.
    expect(run(env, ["--dry-run", "verify"], { QCR_CONFIG: join(other, "c[1].toml") }).code).toBe(
      0,
    );
  });

  it("refuses a config home path with braces (ansible would template it)", () => {
    env = makeScratch({ configPi: "0.84.1", groupVarsPi: "0.84.1" });
    const braced = join(env.dir, "x{{y}}");
    mkdirSync(braced);
    writeFileSync(join(braced, "config.toml"), CONFIG("0.84.1"));
    const r = run(env, ["--dry-run"], { QCR_CONFIG: join(braced, "config.toml") });
    expect(r.code).toBe(1);
    expect(r.stderr).toContain("braces");
  });
});

describe("deploy.sh — the repo profile ships with the config home", () => {
  it("passes with the profile in the config home, and names it in the plan", () => {
    env = makeScratch({
      configPi: "0.84.1",
      groupVarsPi: "0.84.1",
      profile: "house",
      homeFiles: { "profiles/house/profile.toml": "# mine\n" },
    });
    const r = run(env, ["--dry-run"]);
    expect(r.code, r.stderr).toBe(0);
    expect(r.stdout).toContain("profile      house");
  });

  it("REFUSES a named profile the home does not hold — for sync and rebuild, never verify", () => {
    env = makeScratch({ configPi: "0.84.1", groupVarsPi: "0.84.1", profile: "house" });
    for (const mode of ["sync", "rebuild"]) {
      const r = run(env, ["--dry-run", mode]);
      expect(r.code).toBe(1);
      expect(r.stderr).toContain('[review] profile = "house"');
      expect(r.stderr).toContain("the config home does not hold it");
      expect(r.stderr).toContain(join("profiles", "house"));
    }
    const v = run(env, ["--dry-run", "verify"]);
    expect(v.stderr).not.toContain("[review] profile");
  });

  it("an install profile left in the checkout is REFUSED — the VM never reads it there", () => {
    env = makeScratch({
      configPi: "0.84.1",
      groupVarsPi: "0.84.1",
      profile: "house",
      tracked: { "profiles/house/addenda/.gitkeep": "" },
    });
    const r = run(env, ["--dry-run"]);
    expect(r.code).toBe(1);
    expect(r.stderr).toContain("the config home does not hold it");
    expect(r.stderr).toContain("qcr install migrate");
    rmSync(env.dir, { recursive: true, force: true });
    // A generic example in the checkout is still found there.
    env = makeScratch({
      configPi: "0.84.1",
      groupVarsPi: "0.84.1",
      profile: "minimal",
      tracked: { "profiles/minimal/addenda/.gitkeep": "" },
    });
    expect(run(env, ["--dry-run"]).code).toBe(0);
    rmSync(env.dir, { recursive: true, force: true });
    env = makeScratch({ configPi: "0.84.1", groupVarsPi: "0.84.1", profile: "" });
    expect(run(env, ["--dry-run"]).code).toBe(0);
  });

  it("every profile in the chain must be found — the home first, then the checkout's examples", () => {
    env = makeScratch({
      configPi: "0.84.1",
      groupVarsPi: "0.84.1",
      profile: "house",
      homeFiles: {
        "profiles/house/profile.toml": 'extends = "family"   # c\n',
        "profiles/family/profile.toml": "# a base\nextends = 'default'\n[addenda]\ndrop = []\n",
      },
    });
    let r = run(env, ["--dry-run", "sync"]);
    expect(r.code).toBe(1);
    expect(r.stderr).toContain('profile "family" extends "default"');
    rmSync(env.dir, { recursive: true, force: true });
    // The base rides the checkout (a generic example) — found where the VM looks.
    env = makeScratch({
      configPi: "0.84.1",
      groupVarsPi: "0.84.1",
      profile: "house",
      homeFiles: { "profiles/house/profile.toml": 'extends = "default"\n' },
      tracked: { "profiles/default/profile.toml": "# the shipped behaviour\n" },
    });
    r = run(env, ["--dry-run", "sync"]);
    expect(r.code, r.stderr).toBe(0);
    expect(r.stdout).toContain("profile      house → default");
    rmSync(env.dir, { recursive: true, force: true });
    // A cycle is the daemon's to refuse, not a hang here.
    env = makeScratch({
      configPi: "0.84.1",
      groupVarsPi: "0.84.1",
      profile: "house",
      homeFiles: {
        "profiles/house/profile.toml": 'extends = "family"\n',
        "profiles/family/profile.toml": 'extends = "house"\n',
      },
    });
    expect(run(env, ["--dry-run", "sync"]).code).toBe(0);
  });

  it("refuses a profile name — or an extends — that could climb out of profiles/", () => {
    env = makeScratch({ configPi: "0.84.1", groupVarsPi: "0.84.1", profile: "../secrets" });
    let r = run(env, ["--dry-run"]);
    expect(r.code).toBe(1);
    expect(r.stderr).toContain("not a plain profile name");
    rmSync(env.dir, { recursive: true, force: true });
    env = makeScratch({
      configPi: "0.84.1",
      groupVarsPi: "0.84.1",
      profile: "house",
      homeFiles: { "profiles/house/profile.toml": 'extends = "../../etc"\n' },
    });
    r = run(env, ["--dry-run"]);
    expect(r.code).toBe(1);
    expect(r.stderr).toContain('profile "house" extends "../../etc" is not a plain profile name');
  });
});

describe("the playbook's config-home ship", () => {
  const playbook = () => readFileSync(join(root, "deploy", "ansible", "playbook.yml"), "utf8");
  const SHIP = "- name: Ship the install's config home";

  /** The ship task's rsync_opts, read out of the REAL playbook. */
  function shipOpts(vars: Record<string, string>): string[] {
    const text = playbook();
    const at = text.indexOf(SHIP);
    expect(at).toBeGreaterThan(0);
    const block = text.slice(at, text.indexOf("- name:", at + 1));
    return [...block.matchAll(/^\s+- "(--[^"]+)"$/gm)].map((m) =>
      m[1]!.replace(/\{\{\s*(\w+)\s*\|\s*mandatory\s*\}\}/g, (_, k: string) => {
        const v = vars[k];
        if (v === undefined) throw new Error(`playbook var ${k} undefined — ansible would fail`);
        return v;
      }),
    );
  }

  it("runs in sync (after the start-at task), mounts the home read-only and names it QCR_CONFIG", () => {
    const text = playbook();
    const deploy = readFileSync(deploySh, "utf8");
    const start = /SYNC_START_TASK="([^"]+)"/.exec(deploy)![1]!;
    expect(text.indexOf(`- name: ${start}`)).toBeGreaterThan(0);
    expect(text.indexOf(SHIP)).toBeGreaterThan(text.indexOf(`- name: ${start}`));
    expect(text).toContain('src: "{{ config_home_src | mandatory }}/"');
    expect(text).toContain('- "{{ sandbox_root }}/config-home:/opt/quickreview/config-home:ro"');
    expect(text).toContain(
      'QCR_CONFIG: "/opt/quickreview/config-home/{{ config_file_name | mandatory }}"',
    );
  });

  it("ships exactly the config and profiles/ — never secrets/ — and mirrors deletions (real rsync)", () => {
    let hasRsync = true;
    try {
      execFileSync("rsync", ["--version"], { stdio: "ignore" });
    } catch {
      hasRsync = false;
    }
    if (!hasRsync) return;
    env = makeScratch({
      configPi: "0.84.1",
      groupVarsPi: "0.84.1",
      homeFiles: {
        "profiles/house/profile.toml": 'extends = "default"\n',
        "profiles/house/addenda/10-x.md": "rule\n",
        "secrets/app.pem": "PRIVATE\n",
        "notes.txt": "operator scratch\n",
      },
    });
    // a symlinked profile ships as the files it points at
    const linked = join(env.dir, "linked-profile");
    mkdirSync(linked);
    writeFileSync(join(linked, "profile.toml"), "# linked\n");
    symlinkSync(linked, join(env.home, "profiles", "linked"));
    const vars = planVars(run(env, ["--dry-run"]).stdout);
    const dest = join(env.dir, "vm-config-home");
    mkdirSync(join(dest, "profiles", "gone"), { recursive: true });
    writeFileSync(join(dest, "profiles", "gone", "profile.toml"), "stale\n");
    writeFileSync(join(dest, "leftover.toml"), "stale\n");
    execFileSync("rsync", ["-a", ...shipOpts(vars), `${vars.config_home_src}/`, `${dest}/`]);
    expect(readFileSync(join(dest, "config.toml"), "utf8")).toContain("[pi]");
    expect(readFileSync(join(dest, "profiles", "house", "addenda", "10-x.md"), "utf8")).toBe(
      "rule\n",
    );
    expect(lstatSync(join(dest, "profiles", "linked")).isDirectory()).toBe(true);
    expect(existsSync(join(dest, "secrets"))).toBe(false);
    expect(existsSync(join(dest, "notes.txt"))).toBe(false);
    expect(existsSync(join(dest, "profiles", "gone"))).toBe(false);
    expect(existsSync(join(dest, "leftover.toml"))).toBe(false);

    // The shipped copy fingerprints exactly like the home it came from — the
    // container runs the same script with QCR_CONFIG naming the shipped file.
    const fp = (extra: Record<string, string>) =>
      execFileSync("bash", [fingerprintSh, "--located", env.sandbox], {
        encoding: "utf8",
        env: {
          ...process.env,
          XDG_CONFIG_HOME: env.xdg,
          QCR_CONFIG: "",
          QCR_INSTALL: "",
          ...extra,
        },
      }).trim();
    const local = fp({});
    expect(local).toMatch(/^config=[0-9a-f]{64} profiles=[0-9a-f]{64}$/);
    expect(fp({ QCR_CONFIG: join(dest, "config.toml") })).toBe(local);
  });
});

describe("scripts/config-fingerprint.sh", () => {
  const fp = (e: Env, extra: Record<string, string> = {}) =>
    execFileSync("bash", [fingerprintSh, "--located", e.sandbox], {
      encoding: "utf8",
      env: { ...process.env, XDG_CONFIG_HOME: e.xdg, QCR_CONFIG: "", QCR_INSTALL: "", ...extra },
    }).trim();
  const parts = (line: string) => Object.fromEntries(line.split(" ").map((p) => p.split("=")));

  it("says `none` when the only config is the checkout's — there is no home to ship", () => {
    env = makeScratch({ configPi: "0.84.1", groupVarsPi: "0.84.1", configAt: "checkout" });
    expect(fp(env)).toBe("none");
  });

  it("moves the profiles hash on any profile edit, add or rename — and nothing else does", () => {
    env = makeScratch({
      configPi: "0.84.1",
      groupVarsPi: "0.84.1",
      homeFiles: { "profiles/house/profile.toml": "# v1\n", "secrets/app.pem": "K1\n" },
    });
    const base = parts(fp(env));
    // secrets and other files in the home never ship, so they never count
    writeFileSync(join(env.home, "secrets", "app.pem"), "K2\n");
    writeFileSync(join(env.home, "notes.txt"), "x\n");
    expect(parts(fp(env))).toEqual(base);
    // an edit
    writeFileSync(join(env.home, "profiles", "house", "profile.toml"), "# v2\n");
    const edited = parts(fp(env));
    expect(edited.profiles).not.toBe(base.profiles);
    expect(edited.config).toBe(base.config);
    // an added file
    mkdirSync(join(env.home, "profiles", "house", "addenda"));
    writeFileSync(join(env.home, "profiles", "house", "addenda", "10-a.md"), "a\n");
    const added = parts(fp(env));
    expect(added.profiles).not.toBe(edited.profiles);
    // a rename with identical bytes
    execFileSync("mv", [
      join(env.home, "profiles", "house", "addenda", "10-a.md"),
      join(env.home, "profiles", "house", "addenda", "20-a.md"),
    ]);
    expect(parts(fp(env)).profiles).not.toBe(added.profiles);
    // a config edit moves only the config hash
    writeFileSync(join(env.home, "config.toml"), CONFIG("0.84.2"));
    const cfg = parts(fp(env));
    expect(cfg.config).not.toBe(base.config);
  });
});

// ---- the memory-engine pins ------------------------------------------------
// The pi pin never floats; neither does OpenViking's. Three pins, two mirrors:
// server version and llama-cpp-python against the ansible group_vars (which
// the Dockerfile venv layer interpolates, so agreeing there means agreeing in
// the image), and the vendored fork's base commit against upstream.json.
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

  // The auth posture is a mirror too, and for the sharper reason: the
  // entrypoint renders group_vars, so a config.toml saying "api_key" over a
  // group_vars saying "dev" ships a server with no per-user confinement while
  // every doc claims otherwise.
  describe("auth-mode drift", () => {
    const AUTH: OvPins = {
      ...OV,
      auth: "api_key",
      rootKeyFile: "openviking_root_key",
      reviewerKeyFile: "openviking_reviewer_key",
      users: "reviewer,companion",
    };

    it("compares auth against the inventory values actually deployed", () => {
      env = makeScratch({
        configPi: "0.84.1",
        groupVarsPi: "0.84.1",
        configOv: AUTH,
        groupVarsOv: {
          ...AUTH,
          auth: "dev",
          rootKeyFile: "old-root",
          reviewerKeyFile: "old-user",
          users: "reviewer",
        },
        upstreamCommit: OV.extension!,
        inventory:
          "[quickreview]\nquickreview-vm openviking_auth_mode=api_key openviking_root_key_file=openviking_root_key openviking_reviewer_key_file=openviking_reviewer_key openviking_provision_users=reviewer,companion\n",
      });
      expect(run(env, ["--dry-run"]).code).toBe(0);
    });

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
      embedModel: "bge-small-en-v1.5-f16",
      embedDimension: "384",
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

    it("reads the RETIRED local spelling as the parser does: the live config.toml needs no edit (integration review)", () => {
      // The parser maps the retired bge-small-zh-v1.5-f16/512 spelling under
      // local, so a config.toml still carrying it deploys without an edit (and
      // survives a rollback); the preflight must agree.
      for (const embedDimension of ["512", undefined]) {
        env = makeScratch({
          configPi: "0.84.4",
          groupVarsPi: "0.84.4",
          configOv: {
            ...base,
            ...LOCAL,
            embedModel: "bge-small-zh-v1.5-f16",
            ...(embedDimension === undefined ? { embedDimension: undefined } : { embedDimension }),
          },
          groupVarsOv: { ...base, ...LOCAL },
        });
        const r = run(env, ["--dry-run"]);
        expect(r.code, `${String(embedDimension)}: ${r.stderr}`).toBe(0);
        expect(r.stdout).toContain("memory embed local");
      }
      // A retired model with ANOTHER dimension is no spelling the parser
      // maps: still refused.
      env = makeScratch({
        configPi: "0.84.4",
        groupVarsPi: "0.84.4",
        configOv: { ...base, ...LOCAL, embedModel: "bge-small-zh-v1.5-f16", embedDimension: "768" },
        groupVarsOv: { ...base, ...LOCAL },
      });
      expect(run(env, ["--dry-run"]).code).toBe(1);
      // The shell's two pairs are the parser's.
      const sh = readFileSync(join(process.cwd(), "scripts", "deploy.sh"), "utf8");
      expect(sh).toContain(`RETIRED_LOCAL_EMBED_MODEL="${RETIRED_LOCAL_EMBEDDING.model}"`);
      expect(sh).toContain(`RETIRED_LOCAL_EMBED_DIM="${RETIRED_LOCAL_EMBEDDING.dimension}"`);
      expect(sh).toContain(`LOCAL_EMBED_MODEL="${LOCAL_EMBEDDING.model}"`);
      expect(sh).toContain(`LOCAL_EMBED_DIM="${LOCAL_EMBEDDING.dimension}"`);
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

  // The local English embedder's model file is a pin like the
  // server version: config.toml == group_vars (== the image layer, which
  // interpolates group_vars). Port and threads ride the same check.
  describe("local embedder pin drift", () => {
    const PIN: LocalEmbedderPin = {
      dir: "/opt/openviking/models",
      model: "bge-small-en-v1.5-f16",
      url: "https://huggingface.co/CompendiumLabs/bge-small-en-v1.5-gguf/resolve/d32f8c040ea3b516330eeb75b72bcc2d3a780ab7/bge-small-en-v1.5-f16.gguf",
      sha: "f0b2fef971e8366438bfd2d9aefea1b0115919389448806d290237f638bae999",
      port: "1934",
      threads: "1",
    };
    const base = { version: "0.4.15", llama: "0.3.35" };

    it("passes and names the model pin in the plan when both sides agree", () => {
      env = makeScratch({
        configPi: "0.84.4",
        groupVarsPi: "0.84.4",
        configOv: { ...base, localEmbedder: PIN },
      });
      const r = run(env, ["--dry-run"]);
      expect(r.code).toBe(0);
      expect(r.stdout).toContain(`local model  bge-small-en-v1.5-f16 sha256 ${PIN.sha}`);
      expect(r.stdout).toMatch(/a changed pin needs rebuild/);
    });

    for (const [what, drifted, label] of [
      ["sha256", { ...PIN, sha: "0".repeat(64) }, "local embedder model sha256 pin mismatch"],
      [
        "url",
        { ...PIN, url: PIN.url.replace("d32f8c04", "deadbeef") },
        "local embedder model url pin mismatch",
      ],
      [
        "model file",
        { ...PIN, model: "bge-base-en-v1.5-q8_0" },
        "local embedder model file pin mismatch",
      ],
      ["port", { ...PIN, port: "1999" }, "local embedder port pin mismatch"],
      ["threads", { ...PIN, threads: "2" }, "local embedder threads pin mismatch"],
    ] as const) {
      it(`REFUSES when the ${what} drifts`, () => {
        env = makeScratch({
          configPi: "0.84.4",
          groupVarsPi: "0.84.4",
          configOv: { ...base, localEmbedder: PIN },
          groupVarsOv: { ...base, localEmbedder: drifted },
        });
        const r = run(env, ["--dry-run"]);
        expect(r.code).toBe(1);
        expect(r.stderr).toContain(label);
      });
    }

    it("a config.toml naming the pin over a group_vars without it is fatal, never skipped", () => {
      env = makeScratch({
        configPi: "0.84.4",
        groupVarsPi: "0.84.4",
        configOv: { ...base, localEmbedder: PIN },
        groupVarsOv: base,
      });
      const r = run(env, ["--dry-run"]);
      expect(r.code).toBe(1);
      expect(r.stderr).toContain("has no local embedder model file pin");
    });

    // The stand-down keys on none of the five being named — a
    // config.toml that names some is checked key by key, never skipped.
    it("a partial block is checked: a port-only config.toml that drifts REFUSES as the drift it is", () => {
      env = makeScratch({
        configPi: "0.84.4",
        groupVarsPi: "0.84.4",
        configOv: { ...base, configLines: ["local_embedder_port = 1999"] },
        groupVarsOv: { ...base, localEmbedder: PIN },
      });
      const r = run(env, ["--dry-run"]);
      expect(r.code).toBe(1);
      expect(r.stderr).toContain("local embedder port pin mismatch");
    });

    it("a partial block that agrees is still REFUSED, naming the keys it lacks — never half-verified", () => {
      env = makeScratch({
        configPi: "0.84.4",
        groupVarsPi: "0.84.4",
        configOv: {
          ...base,
          configLines: ["local_embedder_port = 1934", "local_embedder_threads = 1"],
        },
        groupVarsOv: { ...base, localEmbedder: PIN },
      });
      const r = run(env, ["--dry-run"]);
      expect(r.code).toBe(1);
      expect(r.stderr).toContain(
        "names only part of the local embedder pin — it lacks local_embedder_file local_embedder_url local_embedder_sha256",
      );
    });

    it("a config.toml from before the pin (no local_embedder_* keys) stands down, said aloud in the plan", () => {
      env = makeScratch({
        configPi: "0.84.4",
        groupVarsPi: "0.84.4",
        configOv: base,
        groupVarsOv: { ...base, localEmbedder: PIN },
      });
      const r = run(env, ["--dry-run"]);
      expect(r.code).toBe(0);
      expect(r.stdout).toContain("local model  <code default> sha256 <code default>");
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

// ---- release <version>, dev, and the cutover --------------------------------
//
// The VM runs the release image in daemon mode. `release` pulls it, `sync`/`dev`
// builds the same Dockerfile on the VM, and the first run on the legacy image is
// a guarded cutover. Everything here is a dry run, a refusal, or a stub
// ansible-playbook/ssh on PATH: nothing leaves the machine.
describe("deploy.sh — release <version>, dev and the cutover", () => {
  const scratch = (extra: Partial<Parameters<typeof makeScratch>[0]> = {}): Env =>
    makeScratch({ configPi: "0.84.1", groupVarsPi: "0.84.1", ...extra });

  const git = (e: Env, ...args: string[]): string =>
    execFileSync("git", ["-C", e.sandbox, ...args], {
      encoding: "utf8",
      env: {
        ...process.env,
        GIT_AUTHOR_NAME: "t",
        GIT_AUTHOR_EMAIL: "t@t",
        GIT_COMMITTER_NAME: "t",
        GIT_COMMITTER_EMAIL: "t@t",
      },
    }).trim();

  /** Run for real against stub ansible-playbook and ssh; returns what the stubs saw. */
  function realRun(
    e: Env,
    args: string[],
    extraEnv: Record<string, string> = {},
  ): { code: number; stderr: string; ansible: string } {
    const bin = join(e.dir, "bin");
    mkdirSync(bin, { recursive: true });
    const seen = join(e.dir, "ansible-argv");
    writeFileSync(
      join(bin, "ansible-playbook"),
      `#!/bin/sh\nprintf '%s\\n' "$*" > '${seen}'\nexit 7\n`,
      { mode: 0o755 },
    );
    writeFileSync(join(bin, "ssh"), "#!/bin/sh\nexit 255\n", { mode: 0o755 });
    const r = run(e, args, { PATH: `${bin}:${process.env.PATH ?? ""}`, ...extraEnv });
    return {
      code: r.code,
      stderr: r.stderr,
      ansible: existsSync(seen) ? readFileSync(seen, "utf8") : "",
    };
  }

  it("plans a release: the images by version, no rsync, no build, the legacy image kept for the way back", () => {
    env = scratch();
    const r = run(env, ["--dry-run", "release", "0.1.0"]);
    expect(r.code, r.stderr).toBe(0);
    expect(r.stdout).toContain("plan — deploy.sh release 0.1.0");
    expect(r.stdout).toContain("ghcr.io/quickchatai/quickreview:0.1.0");
    expect(r.stdout).toContain("ghcr.io/quickchatai/quickreview-memory:0.1.0");
    expect(r.stdout).toContain("no rsync, no build");
    expect(r.stdout).toContain("the legacy image quickreview-sandbox:v1 stays on the VM");
    const vars = planVars(r.stdout);
    expect(vars.image_source).toBe("release");
    expect(vars.release_version).toBe("0.1.0");
    expect(vars.force_restart).toBe("true");
    expect(vars.config_home_src).toBe(realpathSync(env.home));
    // A release ships no checkout and builds nothing from it.
    expect(vars.sandbox_src).toBeUndefined();
    expect(vars.build_sha).toBeUndefined();
    expect(r.stdout).toContain("--start-at-task Image source and version");
    // The CI stamp, not a local one, is what the deploy tab will read.
    expect(r.stdout).toContain("BUILD_SHA is CI's");
  });

  it("plans a dev build: the checkout is synced and built on the VM, stamped with HEAD", () => {
    env = scratch();
    const head = git(env, "rev-parse", "--short", "HEAD");
    for (const verb of ["sync", "dev", undefined]) {
      const r = run(env, ["--dry-run", ...(verb ? [verb] : [])]);
      expect(r.code, r.stderr).toBe(0);
      // `dev` is the new name of the same run.
      expect(r.stdout).toContain("plan — deploy.sh sync");
      const vars = planVars(r.stdout);
      expect(vars.image_source).toBe("dev");
      expect(vars.build_sha).toBe(head);
      expect(vars.sandbox_src).toBe(env.sandbox);
      expect(vars.rebuild_image).toBeUndefined();
      expect(r.stdout).toContain("build docker/Dockerfile on the VM");
      expect(r.stdout).toContain(`image quickreview-sandbox:dev, built on the VM at ${head}`);
    }
    const rebuild = planVars(run(env, ["--dry-run", "rebuild"]).stdout);
    expect(rebuild.image_source).toBe("dev");
    expect(rebuild.rebuild_image).toBe("true");
    expect(rebuild.build_sha).toBe(head);
  });

  it("builds nothing on the controller: the old npm build and the BUILD_SHA marker are gone", () => {
    const text = readFileSync(deploySh, "utf8");
    expect(text).not.toContain("npm run build");
    expect(text).not.toContain("verify-dist");
    expect(text).not.toMatch(/> "\$SANDBOX_DIR\/BUILD_SHA"/);
  });

  it("REFUSES a release with no version, a non-version, or latest — it names an image tag", () => {
    env = scratch();
    for (const [args, msg] of [
      [["release"], "release needs a version"],
      [["release", "latest"], "there is no latest tag"],
      [["release", "v0.1.0"], "is not X.Y.Z"],
      [["release", "0.1"], "is not X.Y.Z"],
      [["release", "0.1.0; rm"], "is not X.Y.Z"],
      [["release", "0.1.0", "sync"], "two modes given"],
    ] as const) {
      const r = run(env, ["--dry-run", ...args]);
      expect(r.code, args.join(" ")).toBe(1);
      expect(r.stderr, args.join(" ")).toContain(msg);
    }
    expect(run(env, ["--dry-run", "release", "0.1.0-rc.1"]).code).toBe(0);
  });

  it("REFUSES a config whose [tui] remote_sandbox_root is not the image's app root, for every shipping mode", () => {
    for (const shape of [{ tuiRoot: null }, { tuiRoot: "/opt/quickreview/sandbox" }]) {
      env = scratch({ shape });
      for (const args of [["sync"], ["rebuild"], ["release", "0.1.0"]]) {
        const r = run(env, ["--dry-run", ...args]);
        expect(r.code, `${JSON.stringify(shape)} ${args.join(" ")}`).toBe(1);
        expect(r.stderr).toContain("[tui] remote_sandbox_root mismatch");
        expect(r.stderr).toContain('remote_sandbox_root = "/opt/qcr"');
      }
      // verify ships nothing and reads whatever the locator found.
      expect(run(env, ["--dry-run", "verify"]).code).toBe(0);
      rmSync(env.dir, { recursive: true, force: true });
    }
  });

  it("verify checks the image stamp, pi's bash-guard registration and the reviewer stub, in the container", () => {
    env = scratch();
    const r = run(env, ["--dry-run", "verify"]);
    expect(r.code).toBe(0);
    expect(r.stdout).toContain(
      "sudo docker exec quickreview-sandbox grep -q bash-guard /home/qcr/.pi/agent/settings.json",
    );
    expect(r.stdout).toContain("/opt/qcr/AGENTS.override.md");
    expect(r.stdout).toContain("= 444");
    expect(r.stdout).toContain('{{index .Config.Labels "qcr.build-sha"}}');
    // Every in-container path is the image's app root, none the legacy one.
    expect(r.stdout).not.toContain("/opt/quickreview/sandbox");
  });

  it("verify FAILS when pi's settings do not register bash-guard or the stub is not the 12-line one — checked after the heartbeat", () => {
    const STARTED = "2026-10-03T09:55:40.000000000Z";
    const NOW = "2026-10-03T09:57:00Z";
    const fresh = `printf '%s\\n%s\\n%s' '${STARTED}' '${NOW}' '{"written_at":"2026-10-03T09:56:50.000Z","prs":[]}'`;
    const probes = {
      QC_HEARTBEAT_PROBE_CMD: fresh,
      QC_HEARTBEAT_WAIT_S: "0",
      QC_MEMORY_PROBE_CMD: "true",
      QC_MEMORY_SEARCH_CMD: "true",
    };
    for (const [needle, shown] of [
      ["bash-guard", "grep -q bash-guard"],
      ["AGENTS.override.md", "AGENTS.override.md"],
    ] as const) {
      env = scratch();
      const bin = join(env.dir, "bin");
      mkdirSync(bin);
      writeFileSync(
        join(bin, "ssh"),
        `#!/bin/sh\ncase "$*" in *'${needle}'*) echo missing >&2; exit 1 ;; esac\necho stub-ok\n`,
        { mode: 0o755 },
      );
      const r = run(env, ["verify"], { PATH: `${bin}:${process.env.PATH ?? ""}`, ...probes });
      expect(r.code, needle).toBe(1);
      expect(r.stderr).toContain("CHECK FAILED");
      expect(r.stderr).toContain(shown);
      // The heartbeat check ran first and passed; only the boot-time check failed.
      expect(r.stderr).not.toContain("no fresh heartbeat");
      rmSync(env.dir, { recursive: true, force: true });
    }
    env = scratch();
    const bin = join(env.dir, "bin");
    mkdirSync(bin);
    writeFileSync(join(bin, "ssh"), "#!/bin/sh\necho stub-ok\n", { mode: 0o755 });
    expect(run(env, ["verify"], { PATH: `${bin}:${process.env.PATH ?? ""}`, ...probes }).code).toBe(
      0,
    );
  });

  describe("the cutover guard", () => {
    const LEGACY = (sha: string) =>
      `printf 'image=quickreview-sandbox:v1\\nlabel=\\nmarker=%s\\n' '${sha}'`;
    const RELEASE = (sha: string) =>
      `printf 'image=ghcr.io/quickchatai/quickreview:0.1.0\\nlabel=%s\\nmarker=\\n' '${sha}'`;

    /** A scratch tree with an old commit (what the VM runs) and a newer one. */
    function history(): { env: Env; old: string; landed: string; head: string } {
      const e = scratch();
      const old = git(e, "rev-parse", "HEAD");
      writeFileSync(join(e.sandbox, "landed.txt"), "P1.8\n");
      git(e, "add", "-A");
      git(e, "commit", "-qm", "the phase 1 deploy");
      const landed = git(e, "rev-parse", "HEAD");
      writeFileSync(join(e.sandbox, "later.txt"), "later\n");
      git(e, "add", "-A");
      git(e, "commit", "-qm", "head");
      return { env: e, old, landed, head: git(e, "rev-parse", "HEAD") };
    }

    it("the plan names the VM's current image, and a release-layout VM needs no guard", () => {
      const h = history();
      env = h.env;
      const r = run(env, ["--dry-run", "release", "0.1.0"], {
        QC_VM_LAYOUT_CMD: RELEASE(h.landed),
      });
      expect(r.code).toBe(0);
      expect(r.stdout).toContain(
        `vm now       ghcr.io/quickchatai/quickreview:0.1.0 (layout release, build ${h.landed})`,
      );
      expect(r.stdout).not.toContain("  cutover  ");
      const real = realRun(env, ["release", "0.1.0"], { QC_VM_LAYOUT_CMD: RELEASE(h.landed) });
      // Past the guard: the (stub) ansible-playbook ran, with the release vars.
      expect(real.ansible).toContain("-e image_source=release -e release_version=0.1.0");
    });

    it("refuses the first run on the legacy image unless the prerequisite deploys are named", () => {
      const h = history();
      env = h.env;
      const probe = { QC_VM_LAYOUT_CMD: LEGACY(h.landed) };
      const plan = run(env, ["--dry-run", "release", "0.1.0"], probe);
      // A plan only says so: it exists to be reviewed.
      expect(plan.code).toBe(0);
      expect(plan.stdout).toContain("layout legacy");
      expect(plan.stdout).toContain("REFUSED in a real run");
      const real = realRun(env, ["release", "0.1.0"], probe);
      expect(real.code).toBe(1);
      expect(real.stderr).toContain("refusing the cutover");
      expect(real.stderr).toContain("QCR_CUTOVER_REQUIRES");
      expect(real.ansible).toBe("");
    });

    it("reads the VM's image through the real ssh command (quoting included), legacy and release", () => {
      const h = history();
      env = h.env;
      const bin = join(env.dir, "probe-bin");
      mkdirSync(bin);
      // ssh runs the remote command locally; sudo is transparent; docker answers
      // like a daemon would for the two inspect formats the probe asks.
      writeFileSync(
        join(bin, "ssh"),
        '#!/bin/sh\nfor a; do last="$a"; done\nexec sh -c "$last"\n',
        { mode: 0o755 },
      );
      writeFileSync(join(bin, "sudo"), '#!/bin/sh\nexec "$@"\n', { mode: 0o755 });
      writeFileSync(
        join(bin, "docker"),
        [
          "#!/bin/sh",
          '[ "$1" = inspect ] || exit 1',
          'case "$3" in',
          "  *Labels*) printf '%s\\n' \"$STUB_LABEL\" ;;",
          "  *) printf '%s\\n' \"$STUB_IMAGE\" ;;",
          "esac",
          "",
        ].join("\n"),
        { mode: 0o755 },
      );
      const base = { PATH: `${bin}:${process.env.PATH ?? ""}` };
      const legacy = run(env, ["--dry-run", "release", "0.1.0"], {
        ...base,
        STUB_IMAGE: "quickreview-sandbox:v1",
        STUB_LABEL: "",
      });
      expect(legacy.stdout).toContain("vm now       quickreview-sandbox:v1 (layout legacy");
      const release = run(env, ["--dry-run", "release", "0.1.0"], {
        ...base,
        STUB_IMAGE: "ghcr.io/quickchatai/quickreview:0.1.0",
        STUB_LABEL: h.landed,
      });
      expect(release.stdout).toContain(
        `vm now       ghcr.io/quickchatai/quickreview:0.1.0 (layout release, build ${h.landed})`,
      );
      // No container at all (a fresh VM): not a cutover, nothing to compare.
      const none = run(env, ["--dry-run", "release", "0.1.0"], {
        ...base,
        STUB_IMAGE: "",
        STUB_LABEL: "",
      });
      expect(none.stdout).toContain("(layout none");
      expect(none.stdout).not.toContain("  cutover  ");
    });

    it("lets the cutover run once every named commit is an ancestor of the VM's deployed build", () => {
      const h = history();
      env = h.env;
      const probe = {
        QC_VM_LAYOUT_CMD: LEGACY(h.head),
        QCR_CUTOVER_REQUIRES: `${h.old} ${h.landed}`,
      };
      const plan = run(env, ["--dry-run", "release", "0.1.0"], probe);
      expect(plan.stdout).toContain("first run on the legacy image");
      const real = realRun(env, ["release", "0.1.0"], probe);
      expect(real.stderr).not.toContain("refusing the cutover");
      expect(real.ansible).toContain("image_source=release");
    });

    it("refuses when a named commit is NOT in what the VM runs — it would arrive inside the image", () => {
      const h = history();
      env = h.env;
      const real = realRun(env, ["release", "0.1.0"], {
        QC_VM_LAYOUT_CMD: LEGACY(h.old),
        QCR_CUTOVER_REQUIRES: h.landed,
      });
      expect(real.code).toBe(1);
      expect(real.stderr).toContain(`does not contain ${h.landed}`);
      expect(real.ansible).toBe("");
    });

    it("refuses a deployed build it cannot compare, a requirement that is no commit, and an unreadable VM", () => {
      const h = history();
      env = h.env;
      const unknown = realRun(env, ["sync"], {
        QC_VM_LAYOUT_CMD: LEGACY("deadbee"),
        QCR_CUTOVER_REQUIRES: h.old,
      });
      expect(unknown.stderr).toContain("is not a commit of this checkout");
      const bogus = realRun(env, ["sync"], {
        QC_VM_LAYOUT_CMD: LEGACY(h.head),
        QCR_CUTOVER_REQUIRES: "nonesuch",
      });
      expect(bogus.stderr).toContain("QCR_CUTOVER_REQUIRES names 'nonesuch'");
      // The stub ssh fails: the layout is unknown, and the cutover cannot be ruled out.
      const dark = realRun(env, ["rebuild"]);
      expect(dark.code).toBe(1);
      expect(dark.stderr).toContain("could not be read");
      expect(dark.ansible).toBe("");
    });

    it("the same guard covers a dev build: pre-release fixes do not skip it", () => {
      const h = history();
      env = h.env;
      const real = realRun(env, ["dev"], { QC_VM_LAYOUT_CMD: LEGACY(h.head) });
      expect(real.code).toBe(1);
      expect(real.stderr).toContain("refusing the cutover");
    });
  });
});

// ---- drain advisory — WARN only, never a refusal ----------------------------
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
        XDG_CONFIG_HOME: e.xdg,
        QCR_CONFIG: "",
        QCR_INSTALL: "",
        ...extraEnv,
      },
    });
    return { code: 0, out };
  }

  it("WARNS (exit 0) on an undrained deploy while rounds run", () => {
    env = makeScratch({ configPi: "0.84.1", groupVarsPi: "0.84.1" });
    const cmd = status(env, JSON.stringify({ running_rounds: 3, dry_run: false }));
    const res = runMerged(env, [], { QC_STATUS_JSON_CMD: cmd });
    expect(res.code).toBe(0); // WARN only, never a refusal
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

// ---- the base clone, for any repo name ------------------------------------
// The VM's base clone lives inside the rsync --delete target, and it survives
// a sync only because the playbook excludes it by name. That exclude, and the
// dirty-tree check's ignore, follow the configured clone name: a literal repo
// name would wipe any other reviewed repo's clone on every sync and leave it
// reading as a dirty tree, which this script refuses.
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

  it("hands the install locator's secrets dir to rebuild's secrets copy", () => {
    // Temp homes only: the locator never sees the operator's own.
    const homes = (e: Env) => ({ HOME: join(e.dir, "home"), XDG_CONFIG_HOME: join(e.dir, "xdg") });
    env = makeScratch({ configPi: "0.84.1", groupVarsPi: "0.84.1", github: ACME });
    const h = homes(env);
    // Nothing anywhere → the config home's secrets dir.
    let r = run(env, ["--dry-run", "rebuild"], h);
    expect(r.code).toBe(0);
    const home = join(h.XDG_CONFIG_HOME, "qcr", "default", "secrets");
    expect(extraVars(r.stdout).secrets_src).toBe(home);
    expect(r.stdout).toContain(`secrets      ${home}`);
    // The legacy dir holding them changes nothing — it is never shipped.
    const legacy = join(h.HOME, ".config", "quickreview-bot");
    mkdirSync(legacy, { recursive: true });
    writeFileSync(join(legacy, "app_id"), "1\n");
    r = run(env, ["--dry-run", "rebuild"], h);
    expect(extraVars(r.stdout).secrets_src).toBe(home);
    mkdirSync(home, { recursive: true });
    r = run(env, ["--dry-run", "rebuild"], h);
    expect(extraVars(r.stdout).secrets_src).toBe(home);
    // sync ships no secrets, so it passes none.
    expect(extraVars(run(env, ["--dry-run"], h).stdout).secrets_src).toBeUndefined();
    // A secrets_dir the operator set wins.
    env = makeScratch({
      configPi: "0.84.1",
      groupVarsPi: "0.84.1",
      github: { ...ACME, secretsDir: "/srv/keys" },
    });
    r = run(env, ["--dry-run", "rebuild"], homes(env));
    expect(extraVars(r.stdout).secrets_src).toBe("/srv/keys");
  });

  it("derives the name exactly as githubCloneDir does", () => {
    const cases: { repo?: string; cloneDir?: string }[] = [
      { repo: "acme/acme-api" },
      { repo: "https://github.com/acme/widgets.git" },
      { repo: "git@github.com:acme/gadgets.git" },
      { repo: "acme/trailing/" },
      { repo: "https://github.com/acme/slashed.git/" },
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
    const runtime = [
      "state",
      "wt",
      "archive",
      "commands",
      "digest",
      "inject",
      "verdict",
      "memory",
      "notes",
      "ledger.md",
      "AGENTS.override.md",
      "pihome",
    ];
    const clones = opts.filter(
      (o) => /^--exclude=\/[^/]+$/.test(o) && !runtime.includes(o.slice(11)),
    );
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
      env = makeScratch({
        configPi: "0.84.1",
        groupVarsPi: "0.84.1",
        github: { repo: `acme/${name}` },
      });
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

// A sync can ship code whose entrypoint half is baked into an older image; the
// post-deploy check must then not read the previous daemon's status.json as
// healthy. These cases pin the guards against that.
describe("deploy — the stale-image outage", () => {
  const checker = join(root, "scripts", "heartbeat-fresh.mjs");
  const STARTED = "2026-10-03T09:55:40.000000000Z";
  const NOW = "2026-10-03T09:57:00Z";
  const status = (writtenAt: string) => JSON.stringify({ written_at: writtenAt, prs: [] });

  function judge(input: string): { code: number; out: string } {
    try {
      const out = execFileSync("node", [checker], { input, encoding: "utf8" });
      return { code: 0, out };
    } catch (err) {
      const e = err as { status?: number; stdout?: string };
      return { code: e.status ?? -1, out: String(e.stdout ?? "") };
    }
  }

  it("heartbeat-fresh: a heartbeat written after the container started, recently, is fresh", () => {
    const r = judge(`${STARTED}\n${NOW}\n${status("2026-10-03T09:56:50.000Z")}`);
    expect(r.code).toBe(0);
    expect(r.out).toContain("fresh");
  });

  it("heartbeat-fresh: the OLD daemon's last write — after the deploy began, before this boot — is stale", () => {
    // Deploy starts 09:55:05, the old daemon writes 09:55:31, the container
    // is recreated after that and never writes again.
    const r = judge(`${STARTED}\n${NOW}\n${status("2026-10-03T09:55:31.228Z")}`);
    expect(r.code).toBe(1);
    expect(r.out).toContain("predates the container start");
  });

  it("heartbeat-fresh: a heartbeat from this boot that stopped being written is stale", () => {
    const r = judge(`${STARTED}\n2026-10-03T10:10:00Z\n${status("2026-10-03T09:56:00.000Z")}`);
    expect(r.code).toBe(1);
    expect(r.out).toContain("stopped writing");
  });

  it("heartbeat-fresh: a missing or garbled reading is unreadable, never fresh", () => {
    expect(judge(`${STARTED}\n${NOW}\n`).code).toBe(2);
    expect(judge(`${STARTED}\n${NOW}\nnot json`).code).toBe(2);
    expect(judge(`\n${NOW}\n${status("2026-10-03T09:56:50.000Z")}`).code).toBe(2);
  });

  /** verify for real against a stub ssh on PATH — nothing leaves the machine. */
  function verifyWith(
    probe: string,
    opts: { inventory?: string; ssh?: string } = {},
  ): { code: number; stdout: string; stderr: string } {
    env = makeScratch({ configPi: "0.84.1", groupVarsPi: "0.84.1", inventory: opts.inventory });
    const bin = join(env.dir, "bin");
    mkdirSync(bin);
    writeFileSync(join(bin, "ssh"), opts.ssh ?? "#!/bin/sh\necho stub-ok\n", { mode: 0o755 });
    return run(env, ["verify"], {
      PATH: `${bin}:${process.env.PATH ?? ""}`,
      QC_HEARTBEAT_PROBE_CMD: probe,
      QC_HEARTBEAT_WAIT_S: "0",
    });
  }

  it("verify FAILS when the only heartbeat predates the running container", () => {
    const r = verifyWith(
      `printf '%s\\n%s\\n%s' '${STARTED}' '${NOW}' '${status("2026-10-03T09:55:31.228Z")}'`,
    );
    expect(r.code).toBe(1);
    expect(r.stderr).toContain("CHECK FAILED: no fresh heartbeat");
  });

  it("verify FAILS when the heartbeat cannot be read at all", () => {
    expect(verifyWith("exit 255").code).toBe(1);
  });

  it("verify passes on a polling-only VM (cloudflared_enabled=false), where no cloudflared service exists", () => {
    const fresh = `printf '%s\\n%s\\n%s' '${STARTED}' '${NOW}' '${status("2026-10-03T09:56:50.000Z")}'`;
    // The stub ssh answers every probe but a cloudflared one, as that host does.
    const ssh =
      '#!/bin/sh\ncase "$*" in *cloudflared*) echo inactive; exit 3 ;; esac\necho stub-ok\n';
    const polling = verifyWith(fresh, {
      inventory: "[quickreview]\nquickreview-vm cloudflared_enabled=false\n",
      ssh,
    });
    expect(polling.code).toBe(0);
    rmSync(env.dir, { recursive: true, force: true });
    // The same host with the tunnel enabled fails on the missing service.
    const tunnel = verifyWith(fresh, {
      inventory: "[quickreview]\nquickreview-vm cloudflared_enabled=true\n",
      ssh,
    });
    expect(tunnel.code).toBe(1);
    expect(tunnel.stderr).toContain("CHECK FAILED: systemctl is-active cloudflared");
  });

  it("verify passes on a heartbeat from this boot", () => {
    const r = verifyWith(
      `printf '%s\\n%s\\n%s' '${STARTED}' '${NOW}' '${status("2026-10-03T09:56:50.000Z")}'`,
    );
    expect(r.code).toBe(0);
  });

  const playbook = () => readFileSync(join(root, "deploy", "ansible", "playbook.yml"), "utf8");

  it("a sync or release starts at the image source check, which precedes the pull, the rsync and the build", () => {
    const text = playbook();
    const start = /SYNC_START_TASK="([^"]+)"/.exec(readFileSync(deploySh, "utf8"))![1]!;
    expect(start).toBe("Image source and version");
    const check = text.indexOf(`- name: ${start}`);
    const pull = text.indexOf("- name: Pull the release images");
    const rsync = text.indexOf("- name: Sync the local sandbox working copy");
    const build = text.indexOf("- name: Build the sandbox image (dev)");
    expect(check).toBeGreaterThan(0);
    expect(pull).toBeGreaterThan(check);
    expect(rsync).toBeGreaterThan(check);
    expect(build).toBeGreaterThan(rsync);
    // Nothing the run needs lives before the start task: host setup and the
    // secrets copies are the only tasks a sync skips.
    for (const skipped of ["Directory layout", "Secrets into place", "Base packages"]) {
      expect(text.indexOf(`- name: ${skipped}`), skipped).toBeLessThan(check);
    }
  });

  it("the source check refuses a non-version, a dev run with no commit, and a local memory endpoint", () => {
    const text = playbook();
    const at = text.indexOf("- name: Image source and version");
    const block = text.slice(at, text.indexOf("\n    - name:", at + 1));
    expect(block).toContain("image_source in ['release', 'dev']");
    expect(block).toContain("openviking_endpoint == 'remote'");
    expect(block).toContain("is match('^[0-9]+\\.[0-9]+\\.[0-9]+(-[0-9A-Za-z.]+)?$')");
    expect(block).toContain("is match('^[0-9a-f]{7,40}$')");
  });

  it("refuses an image that carries no CI or build stamp, so the legacy image never gets the new container shape", () => {
    const text = playbook();
    const at = text.indexOf('- name: "Fail: that is not a release-layout image"');
    const block = text.slice(at, text.indexOf("\n    - name:", at + 1));
    expect(block).toContain("daemon_image_info.images | length == 1");
    expect(block).toContain("get('qcr.build-sha', '') not in ['', 'unstamped']");
    // A dev build must carry the commit it was just built from.
    expect(block).toContain("get('qcr.build-sha') == build_sha");
    // …and it sits before anything is stopped, started or recreated.
    expect(at).toBeGreaterThan(text.indexOf("- name: Build the sandbox image (dev)"));
    expect(at).toBeLessThan(text.indexOf("- name: Memory sidecar network"));
    expect(at).toBeLessThan(text.indexOf("- name: Run the sandbox container"));
  });

  it("the dev build stamps its commit and passes the pins the Dockerfile mirrors, from group_vars", () => {
    const text = playbook();
    const at = text.indexOf("- name: Build the sandbox image (dev)");
    const block = text.slice(at, text.indexOf("\n    - name:", at + 1));
    expect(block).toContain("docker/Dockerfile");
    expect(block).toContain('DOCKER_BUILDKIT: "1"');
    expect(block).toContain("when: image_source == 'dev'");
    const dockerfile = readFileSync(join(root, "docker", "Dockerfile"), "utf8");
    for (const [arg, key] of [
      ["NODE_MAJOR", "node_major"],
      ["TMUX_VERSION", "tmux_version"],
      ["PI_PACKAGE", "pi_npm_package"],
      ["PI_VERSION", "pi_version"],
      ["BUILD_SHA", "build_sha"],
    ] as const) {
      expect(block, arg).toContain(`"${arg}={{ ${key} }}"`);
      expect(dockerfile, `ARG ${arg}`).toMatch(new RegExp(`^ARG ${arg}\\b`, "m"));
    }
    // The dockerignore that narrows the context is BuildKit's, so BuildKit is checked first.
    expect(text.indexOf("- name: BuildKit available for the dev build?")).toBeLessThan(at);
  });

  it("the release pull names no tag but the version, and a failed pull stops before anything changes", () => {
    const text = playbook();
    const at = text.indexOf("- name: Pull the release images");
    const block = text.slice(at, text.indexOf("\n    - name:", at + 1));
    expect(block).toContain("when: image_source == 'release'");
    expect(block).toContain("source: pull");
    expect(block).toContain("rescue:");
    expect(block).toContain("docker login ghcr.io");
    const refs = text.slice(
      text.indexOf("- name: Image references"),
      text.indexOf("- name: Pull the release images"),
    );
    expect(refs).toContain("release_image ~ ':' ~ release_version");
    expect(refs).toContain("release_memory_image ~ ':' ~ release_version");
    // The rsync is a dev-only step: a release ships no checkout.
    const sync = text.slice(
      text.indexOf("- name: Sync the local sandbox working copy"),
      text.indexOf("- name: Ship the install's config home"),
    );
    expect(sync).toContain("when: image_source == 'dev' and sandbox_src is defined");
  });

  it("host setup refreshes the apt cache only when a base package is missing", () => {
    const text = playbook();
    const at = text.indexOf("- name: Base packages");
    const block = text.slice(at, text.indexOf("- name:", at + 1));
    expect(block).toContain("update_cache: true");
    expect(block).toContain(
      "when: base_packages | difference(ansible_facts.packages.keys() | list) | length > 0",
    );
    expect(text.indexOf("ansible.builtin.package_facts")).toBeLessThan(at);
    // …and so does every other apt install: an unconditional refresh is the
    // whole failure, wherever it sits.
    const unconditional = [...text.matchAll(/update_cache:\s*(.+)$/gm)].map((m) => m[1]!.trim());
    expect(unconditional).toEqual(["true", `"{{ 'cloudflared' not in ansible_facts.packages }}"`]);
  });
});

// A recursive chown of the sandbox would hand commands/operator/ to the
// container user, so a pending operator drain would be served as a session's
// and the boot would never lift it.
describe("deploy — the operator channel's seal survives the sandbox chown", () => {
  const playbook = () => readFileSync(join(root, "deploy", "ansible", "playbook.yml"), "utf8");

  it("re-seals commands/operator root:root 0755 after the recursive chown and before the container starts", () => {
    const text = playbook();
    const chown = text.indexOf("- name: Sandbox tree owned by the container user");
    const seal = text.indexOf("- name: Operator command channel stays root-owned 0755 (the seal)");
    const run = text.indexOf("- name: Run the sandbox container");
    expect(chown).toBeGreaterThan(0);
    expect(seal).toBeGreaterThan(chown);
    expect(run).toBeGreaterThan(seal);
    const block = text.slice(seal, text.indexOf("- name:", seal + 1));
    expect(block).toContain('path: "{{ sandbox_root }}/sandbox/commands/operator"');
    expect(block).toContain('owner: "0"');
    expect(block).toContain('group: "0"');
    expect(block).toContain('mode: "0755"');
  });

  it("never creates the channel (a root-owned commands/ parent would lock the daemon out) and never follows a symlink", () => {
    const text = playbook();
    const seal = text.indexOf("- name: Operator command channel stays root-owned 0755 (the seal)");
    const block = text.slice(seal, text.indexOf("- name:", seal + 1));
    expect(block).toContain(
      "when: operator_channel.stat.exists and operator_channel.stat.isdir and not operator_channel.stat.islnk",
    );
  });

  it("runs in a sync (after the sync start task)", () => {
    const text = playbook();
    const start = /SYNC_START_TASK="([^"]+)"/.exec(readFileSync(deploySh, "utf8"))![1]!;
    expect(text.indexOf("- name: Operator command channel stays root-owned 0755")).toBeGreaterThan(
      text.indexOf(`- name: ${start}`),
    );
  });
});

describe("deployment identity and Slack token configuration", () => {
  it("passes configured Slack token filenames to provisioning", () => {
    env = makeScratch({ configPi: "0.84.1", groupVarsPi: "0.84.1" });
    const path = join(env.home, "config.toml");
    writeFileSync(
      path,
      readFileSync(path, "utf8") +
        '\n[slack]\nbot_token_file = "concierge_bot"\napp_token_file = "concierge_app"\n',
    );
    const res = run(env, ["--dry-run", "rebuild"]);
    expect(res.code).toBe(0);
    expect(planVars(res.stdout).slack_bot_token_file).toBe("concierge_bot");
    expect(planVars(res.stdout).slack_app_token_file).toBe("concierge_app");
    const playbook = readFileSync(join(root, "deploy/ansible/playbook.yml"), "utf8");
    expect(playbook).toContain(
      'loop: ["{{ slack_bot_token_file }}", "{{ slack_app_token_file }}"]',
    );
  });

  it("refuses token paths the VM secrets mount cannot supply", () => {
    env = makeScratch({ configPi: "0.84.1", groupVarsPi: "0.84.1" });
    const path = join(env.home, "config.toml");
    writeFileSync(
      path,
      readFileSync(path, "utf8") + '\n[slack]\nenabled = true\nbot_token_file = "/private/token"\n',
    );
    const res = run(env, ["--dry-run", "rebuild"]);
    expect(res.code).toBe(1);
    expect(res.stderr).toContain("bot_token_file");
    expect(res.stderr).toContain("flat filename");
  });

  it("keeps disabled Slack from blocking an unrelated deployment", () => {
    env = makeScratch({ configPi: "0.84.1", groupVarsPi: "0.84.1" });
    const path = join(env.home, "config.toml");
    writeFileSync(
      path,
      readFileSync(path, "utf8") +
        '\n[slack]\nenabled = false\nbot_token_file = "/private/token"\n',
    );
    const res = run(env, ["--dry-run", "rebuild"]);
    expect(res.code).toBe(0);
    expect(planVars(res.stdout).slack_bot_token_file).toBe("slack_bot_token");
  });

  it("runs the container as the UID used for provisioned ownership", () => {
    // MUTATION: replace {{ container_uid }} with 1001 in the container's user; this fails.
    // The release image has no passwd entry for the user it runs as: the caller picks it.
    const text = readFileSync(join(root, "deploy/ansible/playbook.yml"), "utf8");
    const at = text.indexOf("- name: Run the sandbox container");
    const block = text.slice(at);
    expect(block).toContain('user: "{{ container_uid }}:{{ container_uid }}"');
    // …and it is the uid the secrets and the mounted directories are given to.
    expect(text).toContain('owner: "{{ container_uid }}"');
  });
});

it("the deployment ownership walk preserves pending operator-file authority", () => {
  // MUTATION: remove the -prune branch — pending.json appears in chown's log.
  const text = readFileSync(join(root, "deploy/ansible/playbook.yml"), "utf8");
  const start = text.indexOf("- name: Sandbox tree owned by the container user");
  const block = text.slice(start, text.indexOf("- name:", start + 1));
  const listed = block
    .split("\n")
    .map((l) => /^\s+- (.+)$/.exec(l)?.[1])
    .filter((v): v is string => v !== undefined);
  expect(listed).toContain("-prune");
  const dir = mkdtempSync(join(tmpdir(), "qcr-chown-"));
  try {
    const bin = join(dir, "bin");
    mkdirSync(bin);
    mkdirSync(join(dir, "sandbox/commands/operator"), { recursive: true });
    mkdirSync(join(dir, "state"));
    mkdirSync(join(dir, "config-home"));
    const pending = join(dir, "sandbox/commands/operator/pending.json");
    writeFileSync(pending, "{}");
    const ordinary = join(dir, "sandbox/code.ts");
    writeFileSync(ordinary, "code");
    const log = join(dir, "chown.log");
    writeFileSync(join(bin, "chown"), '#!/bin/sh\nprintf "%s\\n" "$@" >> "$CHOWN_LOG"\n', {
      mode: 0o755,
    });
    const argv = listed.map((token) => {
      const value = token.startsWith('"') ? (JSON.parse(token) as string) : token;
      return value.replaceAll("{{ sandbox_root }}", dir).replaceAll("{{ container_uid }}", "1001");
    });
    execFileSync(argv[0]!, argv.slice(1), {
      env: { ...process.env, PATH: `${bin}:${process.env.PATH}`, CHOWN_LOG: log },
    });
    const touched = readFileSync(log, "utf8");
    expect(touched).toContain(ordinary);
    expect(touched).not.toContain(pending);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// The memory sidecar: a second container on the VM (docker/memory/), the
// `[openviking] endpoint` flip, and the deploy plumbing around both. Nothing
// here runs ansible or touches a VM: deploy.sh stops at --dry-run, a refusal or
// a stub ssh, and the playbook/template are read as text.
describe("deploy — the memory sidecar", () => {
  const OV_LOCAL: OvPins = {
    version: "0.4.15",
    llama: "0.3.35",
    extension: "d436baa23c83938b22bb0aab08b0ce48568b5ff4",
    endpoint: "local",
  };
  const OV_REMOTE: OvPins = {
    ...OV_LOCAL,
    endpoint: "remote",
    host: "quickreview-memory",
    port: "1933",
    memoryContainer: "quickreview-memory",
  };

  function scratch(config: OvPins, groupVars: OvPins = config): Env {
    return makeScratch({
      configPi: "0.84.1",
      groupVarsPi: "0.84.1",
      configOv: config,
      groupVarsOv: groupVars,
      upstreamCommit: OV_LOCAL.extension!,
    });
  }

  describe("the plan", () => {
    it("shows the second container, its network, the one-time verified copy and the way back", () => {
      env = scratch(OV_REMOTE);
      const r = run(env, ["--dry-run", "sync"]);
      expect(r.code).toBe(0);
      expect(r.stdout).toMatch(
        /containers\s+quickreview-sandbox \(daemon, image quickreview-sandbox:dev, built on the VM at [0-9a-f]+\) \+ quickreview-memory \(memory sidecar/,
      );
      expect(r.stdout).toContain("port 1933 unpublished");
      expect(r.stdout).toContain("endpoint remote (config.toml == ansible)");
      expect(r.stdout).toContain("checksum-verified ONCE");
      expect(r.stdout).toContain("never wiped");
      // The way back is no longer a flag: it is the legacy image and the old playbook.
      expect(r.stdout).toContain(
        "rollback     the legacy image quickreview-sandbox:v1 stays on the VM",
      );
    });

    it("lists the sidecar's own post-deploy checks: running, /ready, and a search from the daemon's container", () => {
      env = scratch(OV_REMOTE);
      const r = run(env, ["--dry-run", "sync"]);
      expect(r.stdout).toContain("sudo docker ps --filter name=quickreview-memory");
      expect(r.stdout).toContain("sudo docker inspect -f '{{.State.Running}}' quickreview-memory");
      expect(r.stdout).toContain(
        "(polled) sudo docker exec quickreview-memory curl -fsS http://127.0.0.1:1933/ready",
      );
      expect(r.stdout).toContain(
        "(polled) sudo docker exec quickreview-sandbox node /opt/qcr/scripts/memory-search-check.mjs --base http://quickreview-memory:1933 --key-file /opt/quickreview/secrets/openviking_reviewer_key",
      );
    });

    it("endpoint local plans ONE container and no sidecar check in verify, which ships nothing", () => {
      env = scratch(OV_LOCAL);
      const r = run(env, ["--dry-run", "verify"]);
      expect(r.code).toBe(0);
      expect(r.stdout).toMatch(/containers\s+quickreview-sandbox only \(endpoint local/);
      expect(r.stdout).not.toContain("quickreview-memory");
      expect(r.stdout).not.toContain("memory-search-check");
    });

    it("every shipping mode REFUSES endpoint local: the release image carries no OpenViking", () => {
      env = scratch(OV_LOCAL);
      for (const args of [["sync"], ["rebuild"], ["release", "0.1.0"]]) {
        const r = run(env, ["--dry-run", ...args]);
        expect(r.code, args.join(" ")).toBe(1);
        expect(r.stderr).toContain("the release image carries no OpenViking");
        expect(r.stderr).toContain('endpoint to "remote"');
      }
    });

    it("a config and a group_vars that predate the sidecar read as local, and agree (verify only)", () => {
      env = makeScratch({
        configPi: "0.84.1",
        groupVarsPi: "0.84.1",
        configOv: { version: "0.4.15", llama: "0.3.35", endpoint: undefined },
        shape: { legacy: true },
      });
      const r = run(env, ["--dry-run", "verify"]);
      expect(r.code).toBe(0);
      expect(r.stdout).toMatch(/containers\s+quickreview-sandbox only/);
      // …and shipping them is refused, not read as the sidecar.
      expect(run(env, ["--dry-run", "sync"]).code).toBe(1);
    });

    it("honours a renamed sidecar (group_vars memory_container_name) in the checks", () => {
      env = scratch(
        { ...OV_REMOTE, host: "mem-box" },
        { ...OV_REMOTE, memoryContainer: "mem-box" },
      );
      const r = run(env, ["--dry-run", "sync"]);
      expect(r.code).toBe(0);
      expect(r.stdout).toContain("sudo docker ps --filter name=mem-box");
      expect(r.stdout).toContain("--base http://mem-box:1933");
    });
  });

  describe("drift refusals", () => {
    it("REFUSES config remote over ansible local: the daemon would probe a sidecar nobody starts", () => {
      env = scratch(OV_REMOTE, { ...OV_REMOTE, endpoint: "local" });
      const r = run(env, ["--dry-run"]);
      expect(r.code).toBe(1);
      expect(r.stderr).toContain("openviking endpoint pin mismatch");
      expect(r.stderr).toContain('[openviking] endpoint = "remote"');
    });

    it("REFUSES config local over ansible remote: two writers on one store", () => {
      env = scratch(OV_LOCAL, { ...OV_REMOTE });
      const r = run(env, ["--dry-run"]);
      expect(r.code).toBe(1);
      expect(r.stderr).toContain("openviking endpoint pin mismatch");
    });

    it("REFUSES ansible remote over a config with no [openviking] block at all", () => {
      env = makeScratch({
        configPi: "0.84.1",
        groupVarsPi: "0.84.1",
        groupVarsOv: OV_REMOTE,
        shape: { legacy: true },
      });
      const r = run(env, ["--dry-run"]);
      expect(r.code).toBe(1);
      expect(r.stderr).toContain("openviking endpoint pin mismatch");
    });

    it("an inventory host var outranks group_vars, and the drift names where it came from", () => {
      env = makeScratch({
        configPi: "0.84.1",
        groupVarsPi: "0.84.1",
        configOv: OV_REMOTE,
        upstreamCommit: OV_LOCAL.extension!,
        inventory: "[quickreview]\nquickreview-vm openviking_endpoint=local\n",
      });
      const r = run(env, ["--dry-run"]);
      expect(r.code).toBe(1);
      expect(r.stderr).toContain("inventory    openviking_endpoint");
    });

    it("REFUSES an endpoint that is neither local nor remote", () => {
      env = scratch(OV_LOCAL, { ...OV_LOCAL, endpoint: "sidecar" });
      const r = run(env, ["--dry-run"]);
      expect(r.code).toBe(1);
      expect(r.stderr).toContain('must be "local" or "remote"');
    });

    it("REFUSES a remote config whose host is not the sidecar's name", () => {
      env = scratch({ ...OV_REMOTE, host: "127.0.0.1" }, OV_REMOTE);
      const r = run(env, ["--dry-run"]);
      expect(r.code).toBe(1);
      expect(r.stderr).toContain("memory sidecar host pin mismatch");
    });

    it("REFUSES a remote config whose port is not the server's", () => {
      env = scratch({ ...OV_REMOTE, port: "1999" }, OV_REMOTE);
      const r = run(env, ["--dry-run"]);
      expect(r.code).toBe(1);
      expect(r.stderr).toContain("memory sidecar port pin mismatch");
    });

    it("REFUSES a sidecar named like the daemon, or like something a shell would read", () => {
      env = scratch(
        { ...OV_REMOTE, host: "quickreview-sandbox" },
        { ...OV_REMOTE, memoryContainer: "quickreview-sandbox" },
      );
      const same = run(env, ["--dry-run"]);
      expect(same.code).toBe(1);
      expect(same.stderr).toContain("needs a name of its own");
      rmSync(env.dir, { recursive: true, force: true });
      env = scratch(
        { ...OV_REMOTE, host: "mem;box" },
        { ...OV_REMOTE, memoryContainer: "mem;box" },
      );
      const odd = run(env, ["--dry-run"]);
      expect(odd.code).toBe(1);
      expect(odd.stderr).toContain("not a plain container name");
    });

    it("the sidecar's pins are the same ones the daemon image carries: the existing pin drift still refuses under remote", () => {
      env = scratch(OV_REMOTE, { ...OV_REMOTE, version: "0.4.16" });
      const r = run(env, ["--dry-run"]);
      expect(r.code).toBe(1);
      expect(r.stderr).toContain("openviking pin mismatch");
    });
  });

  describe("verify", () => {
    const STARTED = "2026-10-03T09:55:40.000000000Z";
    const NOW = "2026-10-03T09:57:00Z";
    const fresh = `printf '%s\\n%s\\n%s' '${STARTED}' '${NOW}' '{"written_at":"2026-10-03T09:56:50.000Z","prs":[]}'`;

    function verifyRemote(extra: Record<string, string>): {
      code: number;
      stdout: string;
      stderr: string;
    } {
      env = scratch(OV_REMOTE);
      const bin = join(env.dir, "bin");
      mkdirSync(bin);
      writeFileSync(join(bin, "ssh"), "#!/bin/sh\necho stub-ok\n", { mode: 0o755 });
      return run(env, ["verify"], {
        PATH: `${bin}:${process.env.PATH ?? ""}`,
        QC_HEARTBEAT_PROBE_CMD: fresh,
        QC_HEARTBEAT_WAIT_S: "0",
        QC_MEMORY_WAIT_S: "0",
        ...extra,
      });
    }

    it("passes when the sidecar is ready and the reviewer-key search answers", () => {
      const r = verifyRemote({
        QC_MEMORY_PROBE_CMD: "echo ready",
        QC_MEMORY_SEARCH_CMD: "echo 'memory search ok: 0 hit(s)'",
      });
      expect(r.code).toBe(0);
      expect(r.stdout).toContain("--- memory sidecar ready");
      expect(r.stdout).toContain("--- memory sidecar search");
    });

    it("FAILS when the sidecar never becomes ready, and says where to look", () => {
      const r = verifyRemote({ QC_MEMORY_PROBE_CMD: "exit 22", QC_MEMORY_SEARCH_CMD: "echo ok" });
      expect(r.code).toBe(1);
      expect(r.stderr).toContain("CHECK FAILED: memory sidecar ready");
      expect(r.stderr).toContain("docker logs quickreview-memory");
      expect(r.stderr).toContain("Rollback");
    });

    it("FAILS when /ready passes but the search does not (key refused, embedder down)", () => {
      const r = verifyRemote({
        QC_MEMORY_PROBE_CMD: "echo ready",
        QC_MEMORY_SEARCH_CMD: "echo 'the reviewer key was refused (HTTP 401)'; exit 1",
      });
      expect(r.code).toBe(1);
      expect(r.stderr).toContain("CHECK FAILED: memory sidecar search");
      expect(r.stdout).toContain("the reviewer key was refused");
    });

    it("runs no sidecar check under endpoint local", () => {
      env = scratch(OV_LOCAL);
      const bin = join(env.dir, "bin");
      mkdirSync(bin);
      writeFileSync(join(bin, "ssh"), "#!/bin/sh\necho stub-ok\n", { mode: 0o755 });
      const r = run(env, ["verify"], {
        PATH: `${bin}:${process.env.PATH ?? ""}`,
        QC_HEARTBEAT_PROBE_CMD: fresh,
        QC_HEARTBEAT_WAIT_S: "0",
        QC_MEMORY_PROBE_CMD: "exit 1",
      });
      expect(r.code).toBe(0);
      expect(r.stdout).not.toContain("memory sidecar");
    });
  });

  describe("the playbook", () => {
    // Comment lines dropped: the prose around a task says what it must never do.
    const playbook = readFileSync(join(root, "deploy", "ansible", "playbook.yml"), "utf8")
      .split("\n")
      .filter((l) => !/^\s*#/.test(l))
      .join("\n");
    const at = (needle: string): number => {
      const i = playbook.indexOf(needle);
      expect(i, `${needle} is in the playbook`).toBeGreaterThan(-1);
      return i;
    };

    it("carries every sidecar task in a sync: after the start-at task, before the daemon's container", () => {
      const start = at("- name: Image source and version");
      const daemon = at("- name: Run the sandbox container");
      for (const task of [
        "- name: Memory sidecar network",
        "- name: Seed the sidecar's store from the daemon's (first flip only)",
        "- name: Build the memory sidecar image",
        "- name: Run the memory sidecar",
      ]) {
        const i = at(task);
        expect(i, task).toBeGreaterThan(start);
        expect(i, task).toBeLessThan(daemon);
      }
    });

    it("starts the sidecar before the daemon boots against it; the playbook has no way back to local", () => {
      expect(at("- name: Run the memory sidecar")).toBeLessThan(
        at("- name: Run the sandbox container"),
      );
      // The release image cannot supervise OpenViking: the way back is the legacy
      // image and the old playbook, so no task stops the sidecar here.
      expect(playbook).not.toContain("Memory sidecar stopped");
    });

    it("copies the store once, verifies it by checksum, marks it, and only then", () => {
      const block = playbook.slice(
        at("- name: Seed the sidecar's store from the daemon's (first flip only)"),
        at("- name: Build the memory sidecar image"),
      );
      expect(block).toContain("not memory_seed.stat.exists");
      const stop = block.indexOf("Stop the daemon container");
      const copy = block.indexOf("Copy the store");
      const verify = block.indexOf("Verify the copy");
      const mark = block.indexOf("Mark the store seeded");
      expect(stop).toBeGreaterThan(-1);
      expect(copy).toBeGreaterThan(stop);
      expect(verify).toBeGreaterThan(copy);
      expect(mark).toBeGreaterThan(verify);
      expect(block).toContain("--checksum");
      expect(block).toContain("failed_when: (memory_seed_diff.stdout | trim | length) > 0");
      // The failure path puts the daemon back on its own, untouched store.
      const rescue = block.slice(block.indexOf("rescue:"));
      expect(rescue).toContain("state: started");
      expect(rescue).toMatch(/did not\s+verify/);
    });

    it("NEVER wipes or moves a store: no --delete, no state: absent, the source is only read", () => {
      const block = playbook.slice(
        at("- name: Seed the sidecar's store from the daemon's (first flip only)"),
        at("- name: Build the memory sidecar image"),
      );
      expect(block).not.toMatch(/--delete/);
      expect(block).not.toMatch(/state: absent/);
      expect(block).not.toMatch(/\b(rm|mv)\b/);
      // The only argv that writes names the sidecar's directory as destination.
      expect(block).toContain(
        'argv: [rsync, -a, "{{ openviking_home }}/", "{{ memory_state_dir }}/"]',
      );
      // Nothing anywhere in the sidecar tasks removes anything.
      const all = playbook.slice(
        at("- name: Memory sidecar network"),
        at("- name: Run the sandbox container"),
      );
      expect(all).not.toMatch(
        /state: absent|force_source: true|--delete|remove_volumes|\brm -|\bmv /,
      );
    });

    it("builds the sidecar image with BuildKit, from the pins the daemon image uses", () => {
      const block = playbook.slice(
        at("- name: Build the memory sidecar image"),
        at("- name: Run the memory sidecar"),
      );
      expect(block).toContain('DOCKER_BUILDKIT: "1"');
      expect(block).toContain("docker/memory/Dockerfile");
      for (const [arg, key] of [
        ["OPENVIKING_VERSION", "openviking_version"],
        ["LLAMA_CPP_PYTHON_VERSION", "llama_cpp_python_version"],
        ["LOCAL_EMBEDDER_URL", "openviking_local_embedder_url"],
        ["LOCAL_EMBEDDER_SHA256", "openviking_local_embedder_sha256"],
        ["LOCAL_EMBEDDER_MODEL", "openviking_local_embedder_model"],
        ["NODE_MAJOR", "node_major"],
        ["REVIEW_UID", "container_uid"],
      ] as const) {
        expect(block, arg).toContain(`"${arg}={{ ${key} }}"`);
      }
      // Every build ARG it passes exists in the Dockerfile.
      const dockerfile = readFileSync(join(root, "docker", "memory", "Dockerfile"), "utf8");
      for (const m of block.matchAll(/"([A-Z0-9_]+)=\{\{/g)) {
        expect(dockerfile, `ARG ${m[1]}`).toMatch(new RegExp(`^ARG ${m[1]}\\b`, "m"));
      }
      expect(playbook).toContain("docker buildx version");
    });

    it("publishes NO port for the sidecar, mounts secrets and config read-only, and caps it", () => {
      const block = playbook.slice(
        at("- name: Run the memory sidecar"),
        at("- name: Run the sandbox container"),
      );
      expect(block).not.toMatch(/published_ports\s*:/);
      expect(block).toContain('"{{ sandbox_root }}/secrets:/opt/quickreview/secrets:ro"');
      expect(block).toContain('"{{ sandbox_root }}/config-home:/opt/quickreview/config-home:ro"');
      expect(block).toContain('"{{ memory_state_dir }}:{{ openviking_home }}"');
      expect(block).toContain("cpus:");
      expect(block).toContain("memory_swap:");
      expect(block).toContain("restart_policy: unless-stopped");
      // The daemon's secrets for OTHER services never reach it: it mounts the
      // secrets dir read-only, like the daemon (the companion key is not on the VM).
      expect(block).not.toMatch(/docker\.sock|\/\.ssh|state:\/opt\/quickreview\/state\b/);
    });

    it("passes the sidecar entrypoint exactly the knobs it reads, from the daemon's group_vars", () => {
      const block = playbook.slice(
        at("- name: Run the memory sidecar"),
        at("- name: Run the sandbox container"),
      );
      const entrypoint = readFileSync(join(root, "docker", "memory", "entrypoint.sh"), "utf8");
      const passed = [...block.matchAll(/^\s+(QCR_OPENVIKING_[A-Z0-9_]+):/gm)].map((m) => m[1]!);
      expect(passed.length).toBeGreaterThan(15);
      for (const name of passed) {
        expect(entrypoint, `${name} is read by docker/memory/entrypoint.sh`).toContain(name);
      }
      // …and every user-tunable knob the entrypoint reads is passed.
      for (const name of [
        "QCR_OPENVIKING_HOME",
        "QCR_OPENVIKING_PORT",
        "QCR_OPENVIKING_AUTH_MODE",
        "QCR_OPENVIKING_EMBEDDING_PROVIDER",
        "QCR_OPENVIKING_EMBEDDING_MODEL",
        "QCR_OPENVIKING_EMBEDDING_DIMENSION",
        "QCR_OPENVIKING_ROOT_KEY_FILE",
        "QCR_OPENVIKING_REVIEWER_KEY_FILE",
        "QCR_OPENVIKING_PROVISION_USERS",
        "QCR_OPENVIKING_LOCAL_EMBEDDER_SHA256",
      ]) {
        expect(passed, name).toContain(name);
      }
    });

    it("joins the daemon to the sidecar's network and keeps its published webhook port", () => {
      const daemon = playbook.slice(at("- name: Run the sandbox container"));
      expect(daemon).toMatch(/networks:\s*\n\s+- name: "\{\{ memory_network \}\}"/);
      expect(daemon).toContain('"127.0.0.1:{{ webhook_port }}:{{ webhook_port }}"');
    });

    it("restarts the sidecar on a rebuild or a changed config home, not on every sync", () => {
      expect(playbook).toContain("register: config_home_ship");
      expect(playbook).toContain(
        'restart: "{{ (rebuild_image | default(false) | bool) or (config_home_ship.changed | default(false)) }}"',
      );
    });

    it("parses as YAML and the tracked group_vars carries every knob it uses", () => {
      const groupVars = readFileSync(
        join(root, "deploy", "ansible", "group_vars", "all.yml"),
        "utf8",
      );
      // A task name with an unquoted `word: ` once made the whole playbook unparseable.
      expect(() => parseYaml(playbook), "playbook.yml").not.toThrow();
      expect(() => parseYaml(groupVars), "group_vars/all.yml").not.toThrow();
      for (const key of [
        "openviking_endpoint",
        "memory_container_name",
        "memory_image_name",
        "memory_image_tag",
        "memory_network",
        "memory_state_dir",
        "memory_container_cpus",
        "memory_container_memory",
        "image_source",
        "dev_image_tag",
        "release_image",
        "release_memory_image",
        "app_root",
        "legacy_sandbox_root",
      ]) {
        expect(groupVars, key).toMatch(new RegExp(`^${key}:`, "m"));
        expect(playbook, key).toContain(key);
      }
      // The VM's tracked value is the flip; its rollback value is `local`.
      expect(groupVars).toMatch(/^openviking_endpoint: "remote"/m);
      // The seeded copy never lands on the daemon's own directory.
      expect(groupVars).toMatch(/^memory_state_dir: \/opt\/quickreview\/memory-state$/m);
      expect(groupVars).not.toMatch(/^memory_state_dir: .*\/openviking$/m);
    });
  });

  describe("the daemon container (the release image in daemon mode)", () => {
    const playbook = readFileSync(join(root, "deploy", "ansible", "playbook.yml"), "utf8")
      .split("\n")
      .filter((l) => !/^\s*#/.test(l))
      .join("\n");
    const daemon = playbook.slice(playbook.indexOf("- name: Run the sandbox container"));
    const block = daemon.slice(0, daemon.indexOf("\n    - name:", 10));
    const volumes = [...block.matchAll(/^\s+- "([^"]+:[^"]+)"$/gm)].map((m) => m[1]!);

    it("keeps the container's name, port, caps and restart policy, and runs the image's daemon mode", () => {
      expect(block).toContain('name: "{{ image_name }}"');
      expect(block).toContain('image: "{{ daemon_image }}"');
      expect(block).toContain('command: ["daemon"]');
      expect(block).toContain("restart_policy: unless-stopped");
      expect(block).toContain("init: true");
      expect(block).toContain('cpus: "{{ container_cpus | float }}"');
      expect(block).toContain('memory: "{{ container_memory }}"');
      expect(block).toContain('"127.0.0.1:{{ webhook_port }}:{{ webhook_port }}"');
      // Joined to the sidecar's network: that is how [openviking] host resolves.
      expect(block).toMatch(/networks:\s*\n\s+- name: "\{\{ memory_network \}\}"/);
    });

    it("mounts the SAME host directories the legacy container used: state, pihome, secrets, config-home", () => {
      expect(volumes).toContain("{{ sandbox_root }}/state:{{ app_root }}/state");
      expect(volumes).toContain("{{ sandbox_root }}/pihome:/home/qcr/.pi");
      expect(volumes).toContain("{{ sandbox_root }}/secrets:/opt/quickreview/secrets:ro");
      expect(volumes).toContain("{{ sandbox_root }}/config-home:/opt/quickreview/config-home:ro");
    });

    it("mounts every runtime directory of the old sandbox root into the read-only app root, and creates each first", () => {
      const dirs = ["wt", "archive", "commands", "digest", "inject", "verdict"];
      for (const d of dirs) {
        expect(volumes, d).toContain(`{{ sandbox_root }}/sandbox/${d}:{{ app_root }}/${d}`);
      }
      expect(volumes).toContain(
        "{{ sandbox_root }}/sandbox/{{ base_clone_dir | mandatory }}:{{ app_root }}/{{ base_clone_dir }}",
      );
      // Docker would create a missing source as root: each is made for the container user first.
      const made = playbook.slice(
        playbook.indexOf("- name: Runtime directories the container mounts"),
        playbook.indexOf("- name: Memory sidecar network"),
      );
      for (const d of [...dirs, "{{ base_clone_dir | mandatory }}"]) {
        expect(made.includes(`- ${d}\n`) || made.includes(`- "${d}"`), d).toBe(true);
      }
      expect(made).toContain('owner: "{{ container_uid }}"');
      // Every runtime dir the deploy script reserves is either mounted or not a runtime dir of the image.
      const reserved = /BASE_CLONE_RESERVED=\(([^)]*)\)/.exec(readFileSync(deploySh, "utf8"))![1]!;
      for (const d of dirs) expect(reserved.split(/\s+/), d).toContain(d);
    });

    it("mounts the worktrees and the base clone a second time at their legacy path, so recorded absolute paths resolve", () => {
      expect(volumes).toContain("{{ sandbox_root }}/sandbox/wt:{{ legacy_sandbox_root }}/wt");
      expect(volumes).toContain(
        "{{ sandbox_root }}/sandbox/{{ base_clone_dir | mandatory }}:{{ legacy_sandbox_root }}/{{ base_clone_dir }}",
      );
      const groupVars = parseYaml(
        readFileSync(join(root, "deploy", "ansible", "group_vars", "all.yml"), "utf8"),
      ) as Record<string, unknown>;
      expect(groupVars.legacy_sandbox_root).toBe("/opt/quickreview/sandbox");
      expect(groupVars.app_root).toBe("/opt/qcr");
    });

    it("never mounts the app root itself, the docker socket or a home directory: the tree is the image's", () => {
      expect(block).not.toMatch(
        /docker\.sock|\/\.ssh|:\{\{ app_root \}\}["/]?$|sandbox:\{\{ app_root/m,
      );
      for (const v of volumes) {
        expect(v.split(":")[1], v).not.toBe("{{ app_root }}");
      }
    });

    it("sets only the env the image's daemon mode reads, and no OpenViking endpoint knob", () => {
      const env = block.slice(block.indexOf("env:"));
      for (const name of ["TZ", "QC_REVIEW_PORT", "QC_BIND_HOST", "QCR_CONFIG"]) {
        expect(env, name).toContain(`${name}:`);
      }
      // The legacy entrypoint read this to skip its memory boot; the image has no such boot.
      expect(env).not.toContain("QCR_OPENVIKING_ENDPOINT");
      // Nothing in env is a token (rule 3, D39).
      expect(env).not.toMatch(/TOKEN|SECRET|PASSWORD|PEM/);
    });

    it("the image's daemon mode does what the legacy entrypoint did: bash-guard merge (FATAL when absent), the stub, the agents link", () => {
      const entry = readFileSync(join(root, "docker", "entrypoint.sh"), "utf8");
      const daemonMode = entry.slice(
        entry.indexOf("mode_daemon() {"),
        entry.indexOf("mode_companion() {"),
      );
      expect(daemonMode).toContain('QCR_PI_REQUIRE_EXT="$APP/extensions/bash-guard.ts"');
      expect(entry).toContain('console.error("FATAL: pi extension missing: " + p)');
      expect(daemonMode).toContain("assert_subagent_example");
      expect(daemonMode).toContain('QCR_PI_AGENTS_TARGET="$STATE/agents"');
      expect(daemonMode).toContain("AGENTS.override.md");
      expect(daemonMode).toContain('exec node "$APP/dist/src/wire.js"');
      // The image bakes the stub, read-only, in the engine's cwd.
      const dockerfile = readFileSync(join(root, "docker", "Dockerfile"), "utf8");
      expect(dockerfile).toContain("COPY deploy/reviewer/AGENTS.override.md ./AGENTS.override.md");
    });
  });
});

describe("scripts/memory-search-check.mjs", () => {
  const checker = join(root, "scripts", "memory-search-check.mjs");

  it("sends the reviewer key as a Bearer token to POST /api/v1/search/find over the reviewer's tree", async () => {
    const mod = (await import(checker)) as typeof import("../scripts/memory-search-check.mjs");
    const { url, init } = mod.searchRequest("http://quickreview-memory:1933/", "KEY");
    expect(url).toBe("http://quickreview-memory:1933/api/v1/search/find");
    expect(init.method).toBe("POST");
    expect((init.headers as Record<string, string>).Authorization).toBe("Bearer KEY");
    expect(JSON.parse(init.body as string)).toMatchObject({
      target_uri: "viking://user/reviewer/",
      limit: 1,
    });
  });

  it("an empty store is a pass; a refused key, a server error and a garbled body are not", async () => {
    const mod = (await import(checker)) as typeof import("../scripts/memory-search-check.mjs");
    expect(mod.verdict(200, JSON.stringify({ status: "ok", result: { memories: [] } })).ok).toBe(
      true,
    );
    expect(
      mod.verdict(200, JSON.stringify({ result: { memories: [{ uri: "viking://x" }] } })),
    ).toMatchObject({
      ok: true,
      detail: "1 hit(s)",
    });
    expect(mod.verdict(401, "")).toMatchObject({ ok: false });
    expect(mod.verdict(403, "").detail).toContain("refused");
    expect(mod.verdict(500, "boom").detail).toContain("500");
    expect(mod.verdict(200, "not json").ok).toBe(false);
    expect(mod.verdict(200, "{}").ok).toBe(false);
  });

  it("run(): exit codes, and the key never reaches the output", async () => {
    const mod = (await import(checker)) as typeof import("../scripts/memory-search-check.mjs");
    const args = ["--base", "http://m:1933", "--key-file", "/k"];
    const read = () => "SECRET-KEY\n";
    const answer = (status: number, body: string) => async () =>
      ({ status, text: async () => body }) as unknown as Response;
    const out: string[] = [];
    const log = console.log;
    const err = console.error;
    console.log = (...a: unknown[]) => void out.push(a.join(" "));
    console.error = (...a: unknown[]) => void out.push(a.join(" "));
    try {
      expect(await mod.run(args, answer(200, '{"result":{"memories":[]}}'), read)).toBe(0);
      expect(await mod.run(args, answer(401, ""), read)).toBe(1);
      expect(
        await mod.run(
          args,
          async () => {
            throw new Error("getaddrinfo ENOTFOUND m");
          },
          read,
        ),
      ).toBe(1);
      expect(await mod.run(args, answer(200, "{}"), () => "  \n")).toBe(1);
      expect(
        await mod.run(args, answer(200, "{}"), () => {
          throw new Error("ENOENT");
        }),
      ).toBe(1);
      expect(await mod.run(["--base", "x"], answer(200, "{}"), read)).toBe(2);
    } finally {
      console.log = log;
      console.error = err;
    }
    expect(out.join("\n")).not.toContain("SECRET-KEY");
    expect(out.join("\n")).toContain("memory search ok against http://m:1933");
    expect(out.join("\n")).toContain("ENOTFOUND");
  });
});

// ---- the VM's ghcr pull credential (P7.13) ----------------------------------
//
// A release is pulled by the VM's own docker with the owner's classic
// read:packages login. deploy.sh checks the VM can read both images before
// anything changes, and `verify` warns before the recorded token expiry;
// scripts/vm-ghcr-login.sh is the one writer of that login. Every command here
// is a stub: no network, no ssh, no docker.
describe("deploy.sh — the release pull check and the token expiry warning", () => {
  const scratch = (): Env => makeScratch({ configPi: "0.84.1", groupVarsPi: "0.84.1" });

  /** A stub ansible-playbook and ssh on PATH; `ansible` is where the playbook's argv lands. */
  function stubBin(e: Env): { PATH: string; ansibleSeen: string; sshLog: string } {
    const bin = join(e.dir, "bin");
    mkdirSync(bin, { recursive: true });
    const ansibleSeen = join(e.dir, "ansible-argv");
    const sshLog = join(e.dir, "ssh-log");
    writeFileSync(
      join(bin, "ansible-playbook"),
      `#!/bin/sh\nprintf '%s\\n' "$*" > '${ansibleSeen}'\nexit 7\n`,
      { mode: 0o755 },
    );
    writeFileSync(join(bin, "ssh"), `#!/bin/sh\nprintf '%s\\n' "$*" >> '${sshLog}'\nexit 0\n`, {
      mode: 0o755,
    });
    return { PATH: `${bin}:${process.env.PATH ?? ""}`, ansibleSeen, sshLog };
  }

  const RELEASE_LAYOUT =
    "printf 'image=ghcr.io/quickchatai/quickreview:0.1.0\\nlabel=abc1234\\nmarker=\\n'";

  it("checks both images at the version, over the VM's own docker, and the plan shows it", () => {
    env = scratch();
    const log = join(env.dir, "refs");
    const r = run(env, ["--dry-run", "release", "0.1.0"], {
      QC_PULL_CHECK_CMD: `printf '%s\\n' "$1" >> '${log}'`,
      QC_VM_LAYOUT_CMD: RELEASE_LAYOUT,
    });
    expect(r.code).toBe(0);
    expect(readFileSync(log, "utf8").trim().split("\n")).toEqual([
      "ghcr.io/quickchatai/quickreview:0.1.0",
      "ghcr.io/quickchatai/quickreview-memory:0.1.0",
    ]);
    expect(r.stdout).toContain(
      "pull check   ok: the VM reads ghcr.io/quickchatai/quickreview:0.1.0",
    );
    expect(r.stdout).toContain(
      "pull check   ok: the VM reads ghcr.io/quickchatai/quickreview-memory:0.1.0",
    );
  });

  it("runs the check as `sudo docker manifest inspect` over ssh when no stub stands in", () => {
    env = scratch();
    const stub = stubBin(env);
    const r = run(env, ["--dry-run", "release", "0.1.0"], {
      PATH: stub.PATH,
      QC_PULL_CHECK_CMD: "",
      QC_VM_LAYOUT_CMD: RELEASE_LAYOUT,
      QC_VM_HOST: "the-vm",
    });
    expect(r.code).toBe(0);
    const calls = readFileSync(stub.sshLog, "utf8").split("\n");
    expect(calls).toContain(
      "-o BatchMode=yes -o ConnectTimeout=10 the-vm sudo docker manifest inspect ghcr.io/quickchatai/quickreview:0.1.0",
    );
    expect(calls).toContain(
      "-o BatchMode=yes -o ConnectTimeout=10 the-vm sudo docker manifest inspect ghcr.io/quickchatai/quickreview-memory:0.1.0",
    );
  });

  it("REFUSES a release whose image the VM cannot read, in a real run with nothing changed and in --dry-run", () => {
    env = scratch();
    const stub = stubBin(env);
    // The second image (the memory one) is the unreadable one.
    const probes = {
      PATH: stub.PATH,
      QC_VM_LAYOUT_CMD: RELEASE_LAYOUT,
      QC_PULL_CHECK_CMD: 'case "$1" in *-memory:*) exit 1 ;; esac',
    };
    const real = run(env, ["release", "0.1.0"], probes);
    expect(real.code).toBe(1);
    expect(real.stderr).toContain(
      "the VM cannot read ghcr.io/quickchatai/quickreview-memory:0.1.0",
    );
    expect(real.stderr).toContain("scripts/vm-ghcr-login.sh --version 0.1.0");
    // Nothing changed: the playbook never ran, no deploy-grace marker was opened.
    expect(existsSync(stub.ansibleSeen)).toBe(false);
    expect(existsSync(join(env.sandbox, "state", "companion", "alerts"))).toBe(false);
    const dry = run(env, ["--dry-run", "release", "0.1.0"], probes);
    expect(dry.code).toBe(1);
    expect(dry.stdout).not.toContain("(--dry-run: nothing executed)");
    // A readable pair goes on to the playbook.
    const ok = run(env, ["release", "0.1.0"], { ...probes, QC_PULL_CHECK_CMD: "true" });
    expect(ok.stderr).toContain("running: ansible-playbook");
    expect(readFileSync(stub.ansibleSeen, "utf8")).toContain("release_version=0.1.0");
  });

  it("checks no image for the dev build or verify: they pull nothing from ghcr", () => {
    env = scratch();
    const probes = { QC_PULL_CHECK_CMD: "exit 1" };
    expect(run(env, ["--dry-run", "sync"], probes).code).toBe(0);
    expect(run(env, ["--dry-run", "verify"], probes).code).toBe(0);
  });

  describe("the recorded token expiry", () => {
    const NOW = Date.parse("2026-10-19T12:00:00Z") / 1000;
    const probe = (e: Env, iso: string | null, mode = "verify") => {
      const file = join(e.dir, "ghcr-token-expiry");
      if (iso === null) rmSync(file, { force: true });
      else writeFileSync(file, `${iso}\n`);
      return run(e, ["--dry-run", ...(mode === "release" ? ["release", "0.1.0"] : [mode])], {
        QCR_GHCR_EXPIRY_FILE: file,
        QC_NOW_EPOCH: String(NOW),
        QC_VM_LAYOUT_CMD: RELEASE_LAYOUT,
      });
    };

    it("warns 14 days before the expiry, and on the day it lapses", () => {
      env = scratch();
      const near = probe(env, "2026-11-02T12:00:00Z");
      expect(near.code).toBe(0);
      expect(near.stdout).toContain(
        "WARNING — the VM's ghcr pull token expires at 2026-11-02T12:00:00Z, in 14 day(s)",
      );
      expect(near.stdout).toContain("scripts/vm-ghcr-login.sh");
      expect(probe(env, "2026-10-20T12:00:00Z", "release").stdout).toContain(
        "WARNING — the VM's ghcr",
      );
      expect(probe(env, "2026-10-19T11:59:59Z").stdout).toContain(
        "EXPIRED at 2026-10-19T11:59:59Z",
      );
    });

    it("says nothing alarming 15 or more days out, or with no record", () => {
      env = scratch();
      const far = probe(env, "2026-11-03T12:00:00Z");
      expect(far.stdout).toContain("expires at 2026-11-03T12:00:00Z, in 15 days");
      expect(far.stdout).not.toContain("WARNING — the VM's ghcr");
      const none = probe(env, null);
      expect(none.code).toBe(0);
      expect(none.stdout).toContain("no recorded expiry for the VM's ghcr pull token");
      expect(none.stdout).not.toContain("WARNING — the VM's ghcr");
    });

    it("warns on an unreadable record rather than staying quiet", () => {
      env = scratch();
      expect(probe(env, "next tuesday").stdout).toContain("is not a date");
    });

    it("a real verify repeats the warning at the end and still passes the checks it can", () => {
      env = scratch();
      const stub = stubBin(env);
      const file = join(env.dir, "ghcr-token-expiry");
      writeFileSync(file, "2026-10-25T00:00:00Z\n");
      // The ssh stub answers every check with success; the heartbeat and sidecar probes are stubbed.
      const r = run(env, ["verify"], {
        PATH: stub.PATH,
        QC_VM_HOST: "the-vm",
        QCR_GHCR_EXPIRY_FILE: file,
        QC_NOW_EPOCH: String(NOW),
        QC_HEARTBEAT_PROBE_CMD: "exit 1",
        QC_HEARTBEAT_WAIT_S: "0",
      });
      expect(r.stderr).toContain(
        "WARNING — the VM's ghcr pull token expires at 2026-10-25T00:00:00Z, in 5 day(s)",
      );
    });
  });
});

describe.skipIf(!existsSync(join(root, "CLAUDE.md")))(
  "CLAUDE.md rule 3 — the VM's registry pull login",
  () => {
    const claude = existsSync(join(root, "CLAUDE.md"))
      ? readFileSync(join(root, "CLAUDE.md"), "utf8")
      : "";
    const rule3 = claude.slice(
      claude.indexOf("\n3. **Only the App credential"),
      claude.indexOf("\n4. **Never touch"),
    );

    it("carries the ratified carve-out: the owner's classic read:packages token, in root's docker config on the VM host only", () => {
      expect(rule3).toContain("**The VM's registry pull login (owner's ruling, 2026-10-19).**");
      expect(rule3).toContain("CLASSIC personal access token, scoped `read:packages`");
      expect(rule3).toContain("root's docker config on the VM");
      expect(rule3).toContain("never in a container");
      expect(rule3).toContain("scripts/vm-ghcr-login.sh");
      expect(rule3).toContain("exactly `read:packages`");
      expect(rule3).toContain("`deploy.sh verify` warns 14 days before");
      // the ban it is an exception to is still there, and says so
      expect(rule3).toContain("token (the VM's registry pull login below is the");
    });

    it("names only a script that exists", () => {
      expect(existsSync(join(root, "scripts", "vm-ghcr-login.sh"))).toBe(true);
    });
  },
);

describe("scripts/vm-ghcr-login.sh", () => {
  const script = join(root, "scripts", "vm-ghcr-login.sh");
  const TOKEN = "ghp_SECRETtoken0123456789abcdefghijklmn";
  const NOW = Date.parse("2026-10-19T12:00:00Z") / 1000;

  const response = (opts: {
    status?: string;
    scopes?: string | null;
    expiry?: string | null;
    login?: string;
  }): string =>
    [
      `HTTP/2 ${opts.status ?? "200"}`,
      "content-type: application/json; charset=utf-8",
      ...(opts.scopes === null ? [] : [`X-OAuth-Scopes: ${opts.scopes ?? "read:packages"}`]),
      ...(opts.expiry === null
        ? []
        : [`GitHub-Authentication-Token-Expiration: ${opts.expiry ?? "2027-10-19 12:00:00 UTC"}`]),
      "",
      `{\n  "login": "${opts.login ?? "the-owner"}",\n  "id": 7\n}`,
    ].join("\r\n");

  interface Rig {
    dir: string;
    bin: string;
    log: string;
    expiry: string;
  }
  function rig(): Rig {
    const dir = mkdtempSync(join(tmpdir(), "qcr-ghcr-login-"));
    const bin = join(dir, "bin");
    mkdirSync(bin);
    const log = join(dir, "log");
    // Each stub records what a process could leak the token through: argv,
    // environment, and (for ssh only, where it is meant to arrive) stdin.
    writeFileSync(
      join(bin, "curl"),
      [
        "#!/bin/sh",
        `{ echo "CURL-ARGV $*"; env; } >> '${log}'`,
        `cat > '${dir}/curl-stdin'`,
        `cat '${dir}/response'`,
        "",
      ].join("\n"),
      { mode: 0o755 },
    );
    writeFileSync(
      join(bin, "ssh"),
      [
        "#!/bin/sh",
        `{ echo "SSH-ARGV $*"; env; } >> '${log}'`,
        `case "$*" in *"docker login"*) cat > '${dir}/login-stdin' ;; esac`,
        `[ -n "$STUB_SSH_FAIL" ] && case "$*" in *"$STUB_SSH_FAIL"*) exit 1 ;; esac`,
        "exit 0",
        "",
      ].join("\n"),
      { mode: 0o755 },
    );
    return { dir, bin, log, expiry: join(dir, "state", "ghcr-token-expiry") };
  }

  const dirs: string[] = [];
  afterEach(() => {
    for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
  });

  function login(
    r: Rig,
    resp: string,
    args: string[] = ["--version", "0.1.0", "--vm", "the-vm"],
    opts: { input?: string; env?: Record<string, string> } = {},
  ): { code: number; stdout: string; stderr: string } {
    dirs.push(r.dir);
    writeFileSync(join(r.dir, "response"), resp);
    const out = spawnSync("bash", [script, ...args], {
      encoding: "utf8",
      input: opts.input ?? `${TOKEN}\n`,
      env: {
        ...process.env,
        PATH: `${r.bin}:${process.env.PATH ?? ""}`,
        QCR_GHCR_EXPIRY_FILE: r.expiry,
        QC_NOW_EPOCH: String(NOW),
        ...opts.env,
      },
    });
    return { code: out.status ?? -1, stdout: out.stdout, stderr: out.stderr };
  }

  const sshCalls = (r: Rig): string[] =>
    existsSync(r.log)
      ? readFileSync(r.log, "utf8")
          .split("\n")
          .filter((l) => l.startsWith("SSH-ARGV "))
          .map((l) => l.slice("SSH-ARGV ".length))
      : [];

  it("is syntactically valid bash", () => {
    expect(() => execFileSync("bash", ["-n", script])).not.toThrow();
  });

  it("logs the VM in as the token's owner, checks both images at the version, and records the expiry", () => {
    const r = rig();
    const out = login(r, response({}));
    expect(out.code, out.stderr).toBe(0);
    expect(sshCalls(r)).toEqual([
      "-T -o BatchMode=yes the-vm sudo docker login ghcr.io -u the-owner --password-stdin",
      "-T -o BatchMode=yes the-vm sudo docker manifest inspect ghcr.io/quickchatai/quickreview:0.1.0",
      "-T -o BatchMode=yes the-vm sudo docker manifest inspect ghcr.io/quickchatai/quickreview-memory:0.1.0",
    ]);
    // The token reaches docker on the VM through ssh's stdin, and only there.
    expect(readFileSync(join(r.dir, "login-stdin"), "utf8")).toBe(`${TOKEN}\n`);
    expect(readFileSync(r.expiry, "utf8")).toBe("2027-10-19T12:00:00Z\n");
    expect(lstatSync(r.expiry).mode & 0o777).toBe(0o600);
    expect(out.stderr).toContain(
      "token ok: read:packages only, account the-owner, expires 2027-10-19T12:00:00Z",
    );
  });

  it("never lets the token into any stubbed ssh or curl argv or env, nor into its own output", () => {
    const r = rig();
    const out = login(r, response({}));
    expect(out.code).toBe(0);
    const log = readFileSync(r.log, "utf8");
    expect(log).toContain("CURL-ARGV");
    expect(log).toContain("SSH-ARGV");
    expect(log).not.toContain(TOKEN);
    expect(out.stdout + out.stderr).not.toContain(TOKEN);
    // GitHub gets it as a curl config on stdin: it is the only place it rides.
    expect(readFileSync(join(r.dir, "curl-stdin"), "utf8")).toContain(`Bearer ${TOKEN}`);
    // It is refused as an argument.
    for (const arg of [["--token", TOKEN], [`--token=${TOKEN}`], ["--password", TOKEN]]) {
      const bad = login(rig(), response({}), ["--version", "0.1.0", "--vm", "the-vm", ...arg]);
      expect(bad.code).toBe(1);
      expect(bad.stderr).toContain("the token is never an argument");
    }
  });

  it("REFUSES a token with any scope beyond read:packages, or none, or a fine-grained token, before touching the VM", () => {
    for (const [scopes, why] of [
      ["read:packages, repo", 'scopes are "read:packages, repo"'],
      ["repo", 'scopes are "repo"'],
      ["read:packages, write:packages", "write:packages"],
      ["", 'scopes are "none"'],
      [null, "not a classic personal access token"],
    ] as const) {
      const r = rig();
      const out = login(r, response({ scopes }));
      expect(out.code, String(scopes)).toBe(1);
      expect(out.stderr, String(scopes)).toContain(why);
      expect(sshCalls(r), String(scopes)).toEqual([]);
      expect(existsSync(r.expiry), String(scopes)).toBe(false);
    }
  });

  it("REFUSES a token with no expiry, an expired one, an invalid one, and another account's", () => {
    const cases: [string, string, string[]?][] = [
      [response({ expiry: null }), "has no expiry"],
      [response({ expiry: "2026-10-19 11:00:00 UTC" }), "expired at 2026-10-19T11:00:00Z"],
      [response({ expiry: "soon" }), "cannot read the token's expiry"],
      [response({ status: "401" }), "GitHub answered 401"],
      [
        response({}),
        'belongs to "the-owner", not "someone-else"',
        ["--version", "0.1.0", "--vm", "the-vm", "--login", "someone-else"],
      ],
    ];
    for (const [resp, why, args] of cases) {
      const r = rig();
      const out = login(r, resp, args);
      expect(out.code, why).toBe(1);
      expect(out.stderr, why).toContain(why);
      expect(sshCalls(r), why).toEqual([]);
      expect(existsSync(r.expiry), why).toBe(false);
    }
  });

  it("reads the token from a 0600 file, and refuses a file others can read", () => {
    const r = rig();
    const file = join(r.dir, "token");
    writeFileSync(file, `${TOKEN}\n`, { mode: 0o644 });
    chmodSync(file, 0o644);
    const loose = login(
      r,
      response({}),
      ["--version", "0.1.0", "--vm", "the-vm", "--token-file", file],
      {
        input: "",
      },
    );
    expect(loose.code).toBe(1);
    expect(loose.stderr).toContain("must be 0600");
    expect(sshCalls(r)).toEqual([]);
    chmodSync(file, 0o600);
    const ok = login(
      r,
      response({}),
      ["--version", "0.1.0", "--vm", "the-vm", "--token-file", file],
      {
        input: "",
      },
    );
    expect(ok.code, ok.stderr).toBe(0);
    expect(readFileSync(join(r.dir, "login-stdin"), "utf8")).toBe(`${TOKEN}\n`);
    expect(readFileSync(r.log, "utf8")).not.toContain(TOKEN);
    expect(readFileSync(file, "utf8")).toBe(`${TOKEN}\n`);
  });

  it("a failed manifest check exits non-zero and records no expiry; a re-run is idempotent", () => {
    const r = rig();
    const bad = login(r, response({}), undefined, {
      env: { STUB_SSH_FAIL: "quickreview-memory:0.1.0" },
    });
    expect(bad.code).toBe(1);
    expect(bad.stderr).toContain("cannot read ghcr.io/quickchatai/quickreview-memory:0.1.0");
    expect(existsSync(r.expiry)).toBe(false);
    const again = login(r, response({}));
    const twice = login(r, response({}));
    expect(again.code).toBe(0);
    expect(twice.code).toBe(0);
    expect(readFileSync(r.expiry, "utf8")).toBe("2027-10-19T12:00:00Z\n");
  });

  it("a failed docker login records nothing and checks nothing", () => {
    const r = rig();
    const bad = login(r, response({}), undefined, { env: { STUB_SSH_FAIL: "docker login" } });
    expect(bad.code).toBe(1);
    expect(bad.stderr).toContain("docker login on the-vm failed");
    expect(sshCalls(r)).toHaveLength(1);
    expect(existsSync(r.expiry)).toBe(false);
  });

  it("needs a published version and a plain host, and takes no token-shaped login", () => {
    const r = rig();
    const bad = (args: string[], why: string) => {
      const out = login(r, response({}), args);
      expect(out.code, why).toBe(1);
      expect(out.stderr, why).toContain(why);
    };
    bad(["--vm", "the-vm"], "--version is required");
    bad(["--version", "latest", "--vm", "the-vm"], "is not X.Y.Z");
    bad(["--version", "0.1.0", "--vm", "-oProxyCommand=x"], "not a plain ssh destination");
    bad(["--version", "0.1.0", "--vm", "the-vm", "--login", "a b"], "is not a GitHub login");
    expect(sshCalls(r)).toEqual([]);
  });

  it("the expiry it records is the one deploy.sh verify warns on", () => {
    const r = rig();
    expect(login(r, response({ expiry: "2026-11-01 00:00:00 UTC" })).code).toBe(0);
    const e = makeScratch({ configPi: "0.84.1", groupVarsPi: "0.84.1" });
    env = e;
    const out = run(e, ["--dry-run", "verify"], {
      QCR_GHCR_EXPIRY_FILE: r.expiry,
      QC_NOW_EPOCH: String(NOW),
    });
    expect(out.stdout).toContain(
      "WARNING — the VM's ghcr pull token expires at 2026-11-01T00:00:00Z",
    );
  });
});
