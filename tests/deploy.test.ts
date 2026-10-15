// scripts/deploy.sh — pre-flight guardrails, exercised in a scratch git repo
// with a throwaway copy of the group_vars. Nothing here touches the
// real ansible asset, and no live deploy ever runs: every case stops at
// --dry-run or at a refusal.
import { afterEach, describe, expect, it } from "vitest";
import { execFileSync } from "node:child_process";
import {
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
}

interface LocalEmbedderPin {
  dir: string;
  model: string;
  url: string;
  sha: string;
  port: string;
  threads: string;
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
        QCR_CONFIG: "",
        QCR_INSTALL: "",
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

  it("a sync starts at the stale-image guard, which precedes the rsync", () => {
    const text = playbook();
    const start = /SYNC_START_TASK="([^"]+)"/.exec(readFileSync(deploySh, "utf8"))![1]!;
    expect(start).toBe("Build context fingerprint");
    const guard = text.indexOf(`- name: ${start}`);
    const fail = text.indexOf('- name: "Fail: the image predates this build context');
    const rsync = text.indexOf("- name: Sync the local sandbox working copy");
    expect(guard).toBeGreaterThan(0);
    expect(fail).toBeGreaterThan(guard);
    expect(rsync).toBeGreaterThan(fail);
  });

  it("the guard refuses only outside a rebuild, on an existing image, on a stamp mismatch (a missing stamp included)", () => {
    const text = playbook();
    const at = text.indexOf('- name: "Fail: the image predates this build context');
    const block = text.slice(at, text.indexOf("- name:", at + 1));
    expect(block).toContain("not (rebuild_image | default(false) | bool)");
    expect(block).toContain("image_on_vm.images | length > 0");
    expect(block).toContain(".get('qcr.build-context') != build_context_sha");
  });

  it("the image build stamps the same fingerprint the guard compares", () => {
    const text = playbook();
    const at = text.indexOf("- name: Build the sandbox image");
    const block = text.slice(at, text.indexOf("- name:", at + 1));
    expect(block).toContain('qcr.build-context: "{{ build_context_sha }}"');
    // …and the fingerprint covers both baked-in files.
    expect(text).toContain("lookup('ansible.builtin.template', 'Dockerfile.j2')");
    expect(text).toContain("lookup('ansible.builtin.template', 'entrypoint.sh.j2')");
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
