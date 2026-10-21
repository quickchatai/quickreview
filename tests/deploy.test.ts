// scripts/deploy.sh — pre-flight guardrails, exercised in a scratch git repo
// with a throwaway copy of the group_vars. Nothing here touches the
// real ansible asset, and no live deploy ever runs: every case stops at
// --dry-run or at a refusal.
import { afterEach, describe, expect, it } from "vitest";
import { execFileSync, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  chmodSync,
  existsSync,
  lstatSync,
  mkdtempSync,
  mkdirSync,
  readFileSync,
  readdirSync,
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

const GROUP_VARS = (piVersion: string, ov?: OvPins, shape: Shape = {}) =>
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
  /** The pins the scratch config holds (the release manifest is built from them). */
  pi: string;
  ov?: OvPins;
}

let env: Env;

function makeScratch(opts: {
  configPi: string;
  groupVarsPi: string;
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
    GROUP_VARS(opts.groupVarsPi, opts.groupVarsOv ?? opts.configOv, opts.shape),
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
  return { dir, sandbox, ansible, xdg, home, pi: opts.configPi, ov: opts.configOv };
}

/** The registry stand-in: `<repo>:<version>` resolves to the digest the named
 * manifest holds for that repo, so only a test that wants a mismatch has one. */
function tagDigestStub(args: string[]): string {
  const i = args.indexOf("--manifest");
  const file = i >= 0 ? args[i + 1] : undefined;
  if (!file || !existsSync(file)) return "exit 1";
  return `node -e 'const m=JSON.parse(require("fs").readFileSync(process.argv[1],"utf8"));const i=m.images;const k=process.argv[2].split(":")[0]===i.memory.repository?"memory":"daemon";console.log(i[k].index_digest)' ${JSON.stringify(file)} "$1"`;
}

function runRaw(
  e: Env,
  args: string[],
  extraEnv: Record<string, string> = {},
): { code: number; stdout: string; stderr: string } {
  const r = spawnSync("bash", [deploySh, ...args], {
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
      // a stubbed run never restarts the developer's own memory-forward unit
      QC_NO_MEMORY_FORWARD: "1",
      QC_TAG_DIGEST_CMD: tagDigestStub(args),
      ...extraEnv,
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  return { code: r.status ?? -1, stdout: r.stdout, stderr: r.stderr };
}

/** A run that names no mode is a provision (the mode every pin/config
 * preflight case shares); release and verify cases name theirs. */
function run(
  e: Env,
  args: string[],
  extraEnv: Record<string, string> = {},
): { code: number; stdout: string; stderr: string } {
  if (!args.some((a) => ["release", "provision", "verify", "sync", "dev", "rebuild"].includes(a)))
    args = [...args, "provision"];
  return runRaw(e, args, extraEnv);
}

afterEach(() => {
  if (env) rmSync(env.dir, { recursive: true, force: true });
});

// ---- the release's inputs: the manifest and what the VM reports ---------------
// A release reads CI's deploy manifest and asks the VM's updater for its status
// (`sudo qcr-update status --json`). Both are fixtures here: the manifest is
// tests/fixtures/deploy-manifest-1.2.3.json with the pins the scratch config
// holds, and the status is a stub command (QC_UPDATE_STATUS_CMD).

const FIXTURE_MANIFEST = join(root, "tests", "fixtures", "deploy-manifest-1.2.3.json");
const DAEMON_DIGEST = "sha256:1111111111111111111111111111111111111111111111111111111111111111";
const MEMORY_DIGEST = "sha256:4444444444444444444444444444444444444444444444444444444444444444";

type Manifest = {
  version: string;
  pins: Record<string, string | number>;
  images: Record<string, { repository: string; index_digest: string }>;
} & Record<string, unknown>;

/** The manifest for this scratch tree; `patch` edits it before it is written. */
function writeManifest(
  e: Env,
  patch: (m: Manifest) => void = () => {},
  version = "1.2.3",
  name = `deploy-manifest-${version}.json`,
): string {
  const m = JSON.parse(readFileSync(FIXTURE_MANIFEST, "utf8")) as Manifest;
  m.version = version;
  m.pins.pi = e.pi;
  if (e.ov?.version !== undefined) m.pins.openviking = e.ov.version;
  if (e.ov?.llama !== undefined) m.pins.llama_cpp_python = e.ov.llama;
  if (e.ov?.localEmbedder !== undefined) {
    m.pins.embedder_file = `${e.ov.localEmbedder.dir}/${e.ov.localEmbedder.model}.gguf`;
    m.pins.embedder_sha256 = e.ov.localEmbedder.sha;
  }
  patch(m);
  const file = join(e.dir, name);
  writeFileSync(file, JSON.stringify(m, null, 2));
  return file;
}

/** The run-spec fingerprint group_vars renders to, as the provision plan shows it. */
function fingerprintOf(e: Env): string {
  const r = run(e, ["--dry-run", "provision"]);
  expect(r.code, r.stderr).toBe(0);
  const m = /fingerprint ([0-9a-f]{64})/.exec(r.stdout);
  expect(m, r.stdout).not.toBeNull();
  return m![1]!;
}

interface VmState {
  layout?: string;
  draining?: boolean | null;
  rounds?: number | null;
  fingerprint?: string;
}

/** `qcr-update status --json` as the updater prints it (its field order). */
function statusCmd(e: Env, s: VmState = {}): string {
  const j = JSON.stringify;
  const draining = s.draining === undefined ? true : s.draining;
  const rounds = s.rounds === undefined ? 0 : s.rounds;
  const body =
    `{"layout":${j(s.layout ?? "release")},"daemon":null,"memory":null,` +
    `"runspec":{"version":"1","fingerprint":${j(s.fingerprint ?? fingerprintOf(e))}},` +
    `"drain":{"draining":${draining === null ? "null" : draining},"running_rounds":${rounds === null ? "null" : rounds}},"last_run":null}`;
  return `printf '%s' '${body}'`;
}

/** A release run: the manifest written, the VM reporting `vm`. */
function release(
  e: Env,
  opts: {
    dry?: boolean;
    args?: string[];
    vm?: VmState;
    env?: Record<string, string>;
    version?: string;
    patch?: (m: Manifest) => void;
  } = {},
): { code: number; stdout: string; stderr: string } {
  const version = opts.version ?? "1.2.3";
  const manifest = writeManifest(e, opts.patch, version);
  return run(
    e,
    [
      ...(opts.dry === false ? [] : ["--dry-run"]),
      "release",
      version,
      "--manifest",
      manifest,
      ...(opts.args ?? []),
    ],
    { QC_UPDATE_STATUS_CMD: statusCmd(e, opts.vm), ...(opts.env ?? {}) },
  );
}

describe("deploy.sh --dry-run", () => {
  it("is syntactically valid bash", () => {
    expect(() => execFileSync("bash", ["-n", deploySh])).not.toThrow();
  });

  it("prints the provision plan and exits 0 on a clean tree with matching pins", () => {
    env = makeScratch({ configPi: "0.84.1", groupVarsPi: "0.84.1" });
    const r = run(env, ["--dry-run"]);
    expect(r.code, r.stderr).toBe(0);
    expect(r.stdout).toContain("plan — deploy.sh provision");
    expect(r.stdout).toContain("pi pin       0.84.1");
    expect(r.stdout).toContain("/usr/local/sbin/qcr-update and /etc/qcr/update.conf");
    expect(r.stdout).toContain("It pulls and starts no image");
    expect(r.stdout).toContain("(--dry-run: nothing executed)");
    // the flip is never automated
    expect(r.stdout).toContain("dry_run is NOT touched by deploy");
    // Nothing is rsynced or built: not in the plan, not in the command.
    expect(r.stdout).not.toMatch(/rsync|docker build|rebuild_image|sandbox_src/);
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
    // the way out is a new release now, not a rebuild on the VM
    expect(r.stderr).toMatch(/cut a new\s+release/);
    expect(r.stderr).not.toContain("deploy.sh rebuild");
  });

  it("needs no sandbox_src: nothing is synced from this checkout any more", () => {
    env = makeScratch({ configPi: "0.84.1", groupVarsPi: "0.84.1" });
    expect(readFileSync(join(env.ansible, "group_vars", "all.yml"), "utf8")).not.toContain(
      "sandbox_src",
    );
    expect(run(env, ["--dry-run"]).code).toBe(0);
  });

  it("rejects unknown arguments and two modes, and a run that names no mode", () => {
    env = makeScratch({ configPi: "0.84.1", groupVarsPi: "0.84.1" });
    expect(run(env, ["--wat"]).code).toBe(1);
    expect(run(env, ["provision", "verify"]).stderr).toContain("two modes");
    expect(run(env, ["release", "1.2.3", "provision"]).stderr).toContain("two modes");
    const none = runRaw(env, ["--dry-run"]);
    expect(none.code).toBe(1);
    expect(none.stderr).toContain("no mode given");
    expect(none.stderr).toContain("release <version>");
  });

  it("REFUSES sync, dev and rebuild with a pointer to release: nothing is rsynced, built or installed on the VM", () => {
    env = makeScratch({ configPi: "0.84.1", groupVarsPi: "0.84.1" });
    for (const mode of ["sync", "dev", "rebuild"]) {
      for (const dry of [["--dry-run"], []]) {
        const r = run(env, [...dry, mode]);
        expect(r.code, mode).toBe(1);
        expect(r.stderr, mode).toContain(`'${mode}' is gone`);
        expect(r.stderr, mode).toContain("deploy.sh release <version>");
        expect(r.stderr, mode).toContain("deploy.sh provision");
        expect(r.stdout, mode).not.toContain("plan —");
      }
    }
  });

  it("--manifest and --cutover-ack belong to release", () => {
    env = makeScratch({ configPi: "0.84.1", groupVarsPi: "0.84.1" });
    expect(run(env, ["--dry-run", "provision", "--cutover-ack"]).stderr).toContain(
      "belong to `release`",
    );
    expect(run(env, ["--dry-run", "verify", "--manifest", "x.json"]).stderr).toContain(
      "belong to `release`",
    );
  });
});

// ---- provision ----------------------------------------------------------------
// The one mode that runs ansible, and the whole playbook runs: host, secrets,
// the directory layout, the updater and its run spec. A stub ansible-playbook on
// PATH records its argv and copies the run spec it was handed.

describe("deploy.sh provision", () => {
  function provisionWithStub(e: Env, extraEnv: Record<string, string> = {}) {
    const bin = join(e.dir, "bin");
    mkdirSync(bin, { recursive: true });
    const seen = join(e.dir, "ansible-argv");
    const conf = join(e.dir, "update.conf.seen");
    writeFileSync(
      join(bin, "ansible-playbook"),
      `#!/bin/sh\nprintf '%s\\n' "$*" > '${seen}'\n` +
        `for a in "$@"; do case "$a" in update_conf_src=*) cp "\${a#update_conf_src=}" '${conf}' ;; esac; done\nexit 0\n`,
      { mode: 0o755 },
    );
    const r = run(e, ["provision"], { PATH: `${bin}:${process.env.PATH ?? ""}`, ...extraEnv });
    return {
      ...r,
      argv: existsSync(seen) ? readFileSync(seen, "utf8") : "",
      conf: existsSync(conf) ? readFileSync(conf, "utf8") : "",
    };
  }

  it("runs the WHOLE playbook — no tags, no start-at-task — and starts no image", () => {
    env = makeScratch({
      configPi: "0.84.1",
      groupVarsPi: "0.84.1",
      github: { repo: "acme/widgets" },
    });
    const r = provisionWithStub(env);
    expect(r.code, r.stderr).toBe(0);
    expect(r.argv).toContain("playbook.yml");
    expect(r.argv).not.toMatch(/--start-at-task|--tags|image_source|release_version|rebuild_image/);
    expect(r.argv).toContain("base_clone_dir=widgets");
    expect(r.argv).toContain("update_conf_src=");
    expect(r.argv).toContain("secrets_src=");
    expect(r.stderr).toContain("provision ok");
    expect(r.stderr).toContain("no image was pulled or started");
    // no deploy-grace window: provision touches no container
    expect(existsSync(join(env.sandbox, "state", "companion", "alerts"))).toBe(false);
  });

  it("renders the run spec from group_vars: names, caps, mounts' roots, the sidecar's env, a version and a fingerprint", () => {
    env = makeScratch({
      configPi: "0.84.1",
      groupVarsPi: "0.84.1",
      github: { repo: "acme/widgets" },
    });
    const r = provisionWithStub(env);
    expect(r.conf).toContain("RUNSPEC_VERSION=1\n");
    for (const line of [
      "SANDBOX_ROOT=/opt/quickreview",
      "APP_ROOT=/opt/qcr",
      "DAEMON_CONTAINER=quickreview-sandbox",
      "MEMORY_CONTAINER=quickreview-memory",
      "DAEMON_IMAGE_REPO=ghcr.io/quickchatai/quickreview",
      "MEMORY_IMAGE_REPO=ghcr.io/quickchatai/quickreview-memory",
      "MEMORY_NETWORK=quickreview-memory",
      "WEBHOOK_PORT=8787",
      "CONTAINER_UID=1001",
      "DAEMON_CPUS=2",
      "DAEMON_MEMORY=8g",
      "MEMORY_CPUS=1",
      "MEMORY_MEMORY=3g",
      "MEMORY_STATE_DIR=/opt/quickreview/memory-state",
      "OPENVIKING_HOME=/opt/quickreview/state/openviking",
      "OPENVIKING_PORT=1933",
      "BASE_CLONE_DIR=widgets",
      "LEGACY_SANDBOX_ROOT=/opt/quickreview/sandbox",
      "BACKUP_DIR=/var/backups/qcr",
      "SIDECAR_ENV_QCR_OPENVIKING_AUTH_MODE=api_key",
      "SIDECAR_ENV_QCR_OPENVIKING_EMBEDDING_PROVIDER=local",
      "SIDECAR_ENV_QCR_OPENVIKING_PROVISION_USERS=reviewer,companion",
    ]) {
      expect(r.conf.split("\n"), line).toContain(line);
    }
    // the fingerprint is the sha256 of every other KEY=VALUE line, in order
    const body = r.conf
      .split("\n")
      .filter((l) => /^[A-Z][A-Z0-9_]*=/.test(l) && !l.startsWith("RUNSPEC_FINGERPRINT="));
    const want = createHash("sha256")
      .update(body.join("\n") + "\n")
      .digest("hex");
    expect(r.conf).toContain(`RUNSPEC_FINGERPRINT=${want}\n`);
    expect(fingerprintOf(env)).toBe(want);
  });

  it("an inventory host var outranks group_vars in the run spec, and the fingerprint moves", () => {
    env = makeScratch({ configPi: "0.84.1", groupVarsPi: "0.84.1" });
    const before = fingerprintOf(env);
    rmSync(env.dir, { recursive: true, force: true });
    env = makeScratch({
      configPi: "0.84.1",
      groupVarsPi: "0.84.1",
      inventory: "[quickreview]\nquickreview-vm container_memory=12g\n",
    });
    const r = provisionWithStub(env);
    expect(r.conf).toContain("DAEMON_MEMORY=12g\n");
    expect(fingerprintOf(env)).not.toBe(before);
  });

  it("refuses a group_vars value the run spec cannot carry", () => {
    env = makeScratch({
      configPi: "0.84.1",
      groupVarsPi: "0.84.1",
      inventory: "[quickreview]\nquickreview-vm timezone=Europe/War$aw\n",
    });
    const r = run(env, ["--dry-run", "provision"]);
    expect(r.code).toBe(1);
    expect(r.stderr).toContain("the run spec cannot carry");
  });

  it("the run spec version is the one the image label and the updater agree on", () => {
    const sh = readFileSync(deploySh, "utf8");
    expect(/^RUNSPEC_VERSION=(\d+)$/m.exec(sh)![1]).toBe(
      /LABEL qcr\.layout="release"[\s\S]*?qcr\.runspec="(\d+)"/.exec(
        readFileSync(join(root, "docker", "Dockerfile"), "utf8"),
      )![1],
    );
    expect(parseManifestFixture().pins.runspec).toBe(1);
  });
});

function parseManifestFixture(): { pins: { runspec: number } } {
  return JSON.parse(readFileSync(FIXTURE_MANIFEST, "utf8")) as { pins: { runspec: number } };
}

/** The `-e k=v` extra vars on the planned ansible command. */
function planVars(stdout: string): Record<string, string> {
  const line = stdout.split("\n").find((l) => l.includes("  command      ")) ?? "";
  return Object.fromEntries(
    [...line.matchAll(/-e (\w+)=(\S+)/g)].map((m) => [m[1]!, m[2]!] as const),
  );
}

// ---- the config home ships ---------------------------------------------------
// A release delivers the install's config home — the located config and the
// profiles/ beside it — to the VM as the tar on qcr-update's stdin; the
// container reads it through QCR_CONFIG. The pin/drift preflight reads that
// same config.

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

  it("a release plans the config home as the tar on the updater's stdin; verify and provision ship none", () => {
    env = makeScratch({ configPi: "0.84.1", groupVarsPi: "0.84.1" });
    const home = realpathSync(env.home);
    const r = release(env);
    expect(r.code, r.stderr).toBe(0);
    expect(r.stdout).toContain(`config home  ${home} (config.toml as config.toml + profiles/`);
    expect(r.stdout).toContain("secrets/ never rides it");
    for (const mode of ["verify", "provision"]) {
      const v = run(env, ["--dry-run", mode]);
      expect(v.code).toBe(0);
      expect(v.stdout, mode).not.toContain("config home");
    }
  });

  it("QCR_CONFIG names the file: its directory is the home that ships, shipped as config.toml", () => {
    env = makeScratch({ configPi: "0.84.1", groupVarsPi: "0.84.1" });
    const elsewhere = join(env.dir, "elsewhere");
    mkdirSync(elsewhere);
    writeFileSync(join(elsewhere, "prod.toml"), CONFIG("0.84.1"));
    const r = release(env, { env: { QCR_CONFIG: join(elsewhere, "prod.toml") } });
    expect(r.code, r.stderr).toBe(0);
    expect(r.stdout).toContain(`config home  ${realpathSync(elsewhere)} (prod.toml as config.toml`);
  });

  it("REFUSES a missing home: a config that lives only in the checkout is never read or shipped", () => {
    env = makeScratch({ configPi: "0.84.1", groupVarsPi: "0.84.1", configAt: "checkout" });
    // The checkout's config.toml is not a fallback for any mode —
    // the located config (the empty home's) is missing, and migrate is named.
    for (const mode of ["provision", "verify"]) {
      const r = run(env, ["--dry-run", mode]);
      expect(r.code).toBe(1);
      expect(r.stderr).toContain(`no config at ${join(env.home, "config.toml")}`);
      expect(r.stderr).toContain("qcr install migrate");
    }
    const rel = run(env, ["--dry-run", "release", "1.2.3", "--manifest", "m.json"]);
    expect(rel.code).toBe(1);
    expect(rel.stderr).toContain("no config at");
    // QCR_CONFIG pointed back into the checkout: shipping refuses it…
    const r = run(env, ["--dry-run", "release", "1.2.3", "--manifest", "m.json"], {
      QCR_CONFIG: join(env.sandbox, "config.toml"),
    });
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

  it("refuses a config home path with whitespace, and one with braces", () => {
    env = makeScratch({ configPi: "0.84.1", groupVarsPi: "0.84.1" });
    for (const [name, needle] of [
      ["with space", "whitespace"],
      ["x{{y}}", "braces"],
    ] as const) {
      const dir = join(env.dir, name);
      mkdirSync(dir);
      writeFileSync(join(dir, "config.toml"), CONFIG("0.84.1"));
      const r = release(env, { env: { QCR_CONFIG: join(dir, "config.toml") } });
      expect(r.code, name).toBe(1);
      expect(r.stderr, name).toContain(needle);
    }
  });

  it("refuses a config file name that is not a plain name; verify, which ships nothing, is not refused", () => {
    env = makeScratch({ configPi: "0.84.1", groupVarsPi: "0.84.1" });
    const other = join(env.dir, "globbed");
    mkdirSync(other);
    writeFileSync(join(other, "c[1].toml"), CONFIG("0.84.1"));
    const r = release(env, { env: { QCR_CONFIG: join(other, "c[1].toml") } });
    expect(r.code).toBe(1);
    expect(r.stderr).toContain("not a plain file name");
    expect(run(env, ["--dry-run", "verify"], { QCR_CONFIG: join(other, "c[1].toml") }).code).toBe(
      0,
    );
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
    const r = release(env);
    expect(r.code, r.stderr).toBe(0);
    expect(r.stdout).toContain("profile      house");
  });

  it("REFUSES a named profile the home does not hold — for a release, never verify or provision", () => {
    env = makeScratch({ configPi: "0.84.1", groupVarsPi: "0.84.1", profile: "house" });
    const r = release(env);
    expect(r.code).toBe(1);
    expect(r.stderr).toContain('[review] profile = "house"');
    expect(r.stderr).toContain("the config home does not hold it");
    expect(r.stderr).toContain(join("profiles", "house"));
    for (const mode of ["verify", "provision"]) {
      const v = run(env, ["--dry-run", mode]);
      expect(v.stderr, mode).not.toContain("[review] profile");
    }
  });

  it("an install profile left in the checkout is REFUSED — the VM never reads it there", () => {
    env = makeScratch({
      configPi: "0.84.1",
      groupVarsPi: "0.84.1",
      profile: "house",
      tracked: { "profiles/house/addenda/.gitkeep": "" },
    });
    const r = release(env);
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
    expect(release(env).code).toBe(0);
    rmSync(env.dir, { recursive: true, force: true });
    env = makeScratch({ configPi: "0.84.1", groupVarsPi: "0.84.1", profile: "" });
    expect(release(env).code).toBe(0);
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
    let r = release(env);
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
    r = release(env);
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
    expect(release(env).code).toBe(0);
  });

  it("refuses a profile name — or an extends — that could climb out of profiles/", () => {
    env = makeScratch({ configPi: "0.84.1", groupVarsPi: "0.84.1", profile: "../secrets" });
    let r = release(env);
    expect(r.code).toBe(1);
    expect(r.stderr).toContain("not a plain profile name");
    rmSync(env.dir, { recursive: true, force: true });
    env = makeScratch({
      configPi: "0.84.1",
      groupVarsPi: "0.84.1",
      profile: "house",
      homeFiles: { "profiles/house/profile.toml": 'extends = "../../etc"\n' },
    });
    r = release(env);
    expect(r.code).toBe(1);
    expect(r.stderr).toContain('profile "house" extends "../../etc" is not a plain profile name');
  });
});

// A real release run against stubs: the tar the updater receives on stdin.
describe("deploy.sh release — the config tar the updater receives", () => {
  /** A stub ssh (answers every post-deploy check) and the stand-in for the update call. */
  function realRelease(
    e: Env,
    extraEnv: Record<string, string> = {},
    opts: { updateRc?: number; vm?: VmState } = {},
  ) {
    const bin = join(e.dir, "bin");
    mkdirSync(bin, { recursive: true });
    writeFileSync(join(bin, "ssh"), "#!/bin/sh\necho stub-ok\n", { mode: 0o755 });
    const tarOut = join(e.dir, "received.tar");
    const argvOut = join(e.dir, "update-argv");
    const r = release(e, {
      dry: false,
      vm: opts.vm,
      env: {
        PATH: `${bin}:${process.env.PATH ?? ""}`,
        QC_UPDATE_RUN_CMD: `cat > '${tarOut}'; printf '%s\\n' "$*" > '${argvOut}'; exit ${opts.updateRc ?? 0}`,
        QC_HEARTBEAT_PROBE_CMD: "exit 1",
        QC_HEARTBEAT_WAIT_S: "0",
        QC_MEMORY_WAIT_S: "0",
        QC_MEMORY_PROBE_CMD: "true",
        QC_MEMORY_SEARCH_CMD: "true",
        ...extraEnv,
      },
    });
    return {
      ...r,
      tarOut,
      argv: existsSync(argvOut) ? readFileSync(argvOut, "utf8").trim() : "",
      listing: existsSync(tarOut)
        ? execFileSync("tar", ["-tvf", tarOut], { encoding: "utf8" })
        : "",
    };
  }

  it("is config.toml and profiles/ only — never secrets/ — a symlinked profile dereferenced", () => {
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
    const linked = join(env.dir, "linked-profile");
    mkdirSync(linked);
    writeFileSync(join(linked, "profile.toml"), "# linked\n");
    symlinkSync(linked, join(env.home, "profiles", "linked"));
    const r = realRelease(env);
    expect(r.listing).toContain("config.toml");
    expect(r.listing).toContain("profiles/house/addenda/10-x.md");
    expect(r.listing).toContain("profiles/linked/profile.toml");
    expect(r.listing).not.toMatch(/secrets|app\.pem|PRIVATE|notes\.txt/);
    // no link survives into the tar: the updater refuses any
    expect(r.listing.split("\n").some((l) => /^[lh]/.test(l))).toBe(false);
    // …and a clean unpack reproduces the home exactly
    const dest = join(env.dir, "unpacked");
    mkdirSync(dest);
    execFileSync("tar", ["-xf", r.tarOut, "-C", dest]);
    expect(readdirSync(dest).sort()).toEqual(["config.toml", "profiles"]);
    expect(readFileSync(join(dest, "profiles", "linked", "profile.toml"), "utf8")).toBe(
      "# linked\n",
    );
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
    expect(fp({ QCR_CONFIG: join(dest, "config.toml") })).toBe(fp({}));
  });

  it("ships the config under the name config.toml whatever it is called here", () => {
    env = makeScratch({ configPi: "0.84.1", groupVarsPi: "0.84.1" });
    const elsewhere = join(env.dir, "elsewhere");
    mkdirSync(elsewhere);
    writeFileSync(join(elsewhere, "prod.toml"), CONFIG("0.84.1"));
    const r = realRelease(env, { QCR_CONFIG: join(elsewhere, "prod.toml") });
    expect(r.listing).toContain("config.toml");
    expect(r.listing).not.toContain("prod.toml");
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
      expect(r.stdout).toMatch(/a changed pin needs a new release/);
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

// ---- release <version> and the cutover --------------------------------------
// The deploy: a controller preflight over CI's manifest and the VM's reported
// status, then `tar | ssh vm sudo qcr-update ...`. Everything here is a dry
// run, a refusal, or a stub on PATH: nothing leaves the machine.
describe("deploy.sh — release <version>", () => {
  const scratch = (extra: Partial<Parameters<typeof makeScratch>[0]> = {}): Env =>
    makeScratch({ configPi: "0.84.1", groupVarsPi: "0.84.1", ...extra });

  it("plans a release: manifest, pull by digest, config check, stop, snapshot, preflight, seed, swap, sidecar, recreate — and no rsync, build or install", () => {
    env = scratch();
    const r = release(env);
    expect(r.code, r.stderr).toBe(0);
    expect(r.stdout).toContain("plan — deploy.sh release 1.2.3");
    expect(r.stdout).toContain("manifest     ");
    expect(r.stdout).toContain(`daemon ghcr.io/quickchatai/quickreview@${DAEMON_DIGEST}`);
    expect(r.stdout).toContain(`memory ghcr.io/quickchatai/quickreview-memory@${MEMORY_DIGEST}`);
    expect(r.stdout).toContain(
      `sudo qcr-update 1.2.3@${DAEMON_DIGEST} --memory-digest ${MEMORY_DIGEST}`,
    );
    // the VM-side order, as the plan states it
    const order = [
      "flock; refuse unless draining=true and running_rounds=0",
      "pull both images by digest",
      "`qcr config check --json`",
      "stop the daemon container; snapshot state.db",
      "`daemon --preflight` on a scratch copy",
      "seed the sidecar store once (legacy layout only",
      "swap the config",
      "start the memory sidecar, wait for /ready; recreate the daemon container",
    ].map((needle) => {
      const i = r.stdout.indexOf(needle);
      expect(i, needle).toBeGreaterThan(-1);
      return i;
    });
    expect([...order].sort((a, b) => a - b)).toEqual(order);
    expect(r.stdout).toContain("any failure from the stop to the recreate is RESCUED");
    expect(r.stdout).toContain("no rsync, no build, no install on the VM");
    // …and the plan contains no ansible at all: provision is the only ansible mode
    expect(r.stdout).not.toContain("ansible-playbook");
    expect(r.stdout).not.toMatch(/docker build|image_source|sandbox_src|rebuild_image/);
    expect(r.stdout).toContain("the legacy image quickreview-sandbox:v1 stays on the VM");
    expect(r.stdout).toContain("BUILD_SHA is CI's");
  });

  it("deploy.sh holds no rsync, no docker build, no BuildKit and no ansible image task", () => {
    const sh = readFileSync(deploySh, "utf8").replace(/^\s*#.*$/gm, "");
    expect(sh).not.toMatch(
      /\brsync\s+-|synchronize|docker build(?!x imagetools inspect )|buildx(?! imagetools inspect )|npm run build|BUILD_SHA"? >/,
    );
    const playbook = readFileSync(join(root, "deploy", "ansible", "playbook.yml"), "utf8");
    expect(playbook).not.toMatch(/synchronize|docker build|docker_image|docker_container/);
    expect(playbook).not.toMatch(
      /sandbox_src|rebuild_image|image_source|dev_image_tag|tmux_version/,
    );
  });

  it("REFUSES a release with no version, a non-version, or latest — it names an image tag", () => {
    env = scratch();
    for (const [args, msg] of [
      [["release"], "release needs a version"],
      [["release", "latest"], "there is no latest tag"],
      [["release", "v0.1.0"], "is not X.Y.Z"],
      [["release", "0.1"], "is not X.Y.Z"],
      [["release", "0.1.0; rm"], "is not X.Y.Z"],
      [["release", "0.1.0", "verify"], "two modes given"],
    ] as const) {
      const r = run(env, ["--dry-run", ...args]);
      expect(r.code, args.join(" ")).toBe(1);
      expect(r.stderr, args.join(" ")).toContain(msg);
    }
    expect(release(env, { version: "1.2.3-rc.1" }).code).toBe(0);
  });

  it("does not refuse on [tui] remote_sandbox_root (the TUI resolves the layout itself): an absent key is silent, an explicit other root only warns", () => {
    for (const [shape, warns] of [
      [{ tuiRoot: null }, false],
      [{ tuiRoot: "/opt/qcr" }, false],
      [{ tuiRoot: "/opt/quickreview/sandbox" }, true],
    ] as const) {
      env = scratch({ shape });
      const r = release(env);
      expect(r.code, JSON.stringify(shape)).toBe(0);
      expect(r.stderr.includes("remote_sandbox_root"), JSON.stringify(shape)).toBe(warns);
      expect(r.stderr).not.toContain("mismatch");
      rmSync(env.dir, { recursive: true, force: true });
    }
  });

  it("verify checks the image stamp, that pi's settings carry no bash-guard entry and the reviewer stub, in the container", () => {
    env = scratch();
    const r = run(env, ["--dry-run", "verify"]);
    expect(r.code).toBe(0);
    expect(r.stdout).toContain(
      "sudo docker exec quickreview-sandbox sh -c '! grep -q bash-guard /home/qcr/.pi/agent/settings.json'",
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
      ["bash-guard", "! grep -q bash-guard"],
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

  describe("what the VM reports: layout, drain and run spec", () => {
    it("REFUSES (in a real run; the plan says so) a legacy VM without the cutover ack", () => {
      env = scratch();
      const plan = release(env, { vm: { layout: "legacy" } });
      expect(plan.code, plan.stderr).toBe(0);
      expect(plan.stdout).toContain("REFUSED in a real run: the VM still runs the legacy layout");
      expect(plan.stdout).toContain("--cutover-ack");
      const real = release(env, { vm: { layout: "legacy" }, dry: false });
      expect(real.code).toBe(1);
      expect(real.stderr).toContain("refusing the release");
      expect(real.stderr).toContain("legacy layout");
      // nothing opened: no deploy-grace marker, the updater never called
      expect(existsSync(join(env.sandbox, "state", "companion", "alerts"))).toBe(false);
    });

    it("hands the ack to the updater and plans the cutover when --cutover-ack is given", () => {
      env = scratch();
      const r = release(env, { vm: { layout: "legacy" }, args: ["--cutover-ack"] });
      expect(r.code, r.stderr).toBe(0);
      expect(r.stdout).not.toContain("REFUSED in a real run");
      expect(r.stdout).toContain("--cutover-ack 1.2.3");
      expect(r.stdout).toContain("first run on the legacy layout, acknowledged");
    });

    it("takes the acknowledgement from QCR_CUTOVER_ACK=<version> too (the runbook's and the wizard's spelling), and only for this version", () => {
      env = scratch();
      const ok = release(env, { vm: { layout: "legacy" }, env: { QCR_CUTOVER_ACK: "1.2.3" } });
      expect(ok.code, ok.stderr).toBe(0);
      expect(ok.stdout).not.toContain("REFUSED in a real run");
      expect(ok.stdout).toContain("--cutover-ack 1.2.3");
      expect(ok.stdout).toContain("first run on the legacy layout, acknowledged");
      // an ack for another version authorizes nothing
      const stale = release(env, { vm: { layout: "legacy" }, env: { QCR_CUTOVER_ACK: "1.2.2" } });
      expect(stale.code).toBe(1);
      expect(stale.stderr).toContain("acknowledges another version");
    });

    it("names the recreate as the point of no return in the plan", () => {
      env = scratch();
      const r = release(env, { vm: { layout: "legacy" }, args: ["--cutover-ack"] });
      expect(r.stdout).toMatch(
        /recreate the daemon container on the new image — THE POINT OF NO RETURN on the legacy layout/,
      );
    });

    it("REFUSES an undrained or busy board (the updater refuses it too)", () => {
      env = scratch();
      const undrained = release(env, { vm: { draining: false } });
      expect(undrained.stdout).toContain("REFUSED in a real run: the bot is not drained");
      expect(release(env, { vm: { draining: false }, dry: false }).code).toBe(1);
      const busy = release(env, { vm: { rounds: 3 } });
      expect(busy.stdout).toContain("REFUSED in a real run: the board is busy (running_rounds=3)");
      const real = release(env, { vm: { rounds: 3 }, dry: false });
      expect(real.code).toBe(1);
      expect(real.stderr).toContain("running_rounds=3");
      // drained and idle: no refusal in the plan
      expect(release(env).stdout).not.toContain("REFUSED");
    });

    it("an unreadable status is UNKNOWN: the plan says so, a real run refuses", () => {
      env = scratch();
      const manifest = writeManifest(env);
      const plan = run(env, ["--dry-run", "release", "1.2.3", "--manifest", manifest], {
        QC_UPDATE_STATUS_CMD: "exit 255",
      });
      expect(plan.code, plan.stderr).toBe(0);
      expect(plan.stdout).toContain(
        "REFUSED in a real run: the VM's `qcr-update status` could not be read",
      );
      const real = run(env, ["release", "1.2.3", "--manifest", manifest], {
        QC_UPDATE_STATUS_CMD: "exit 255",
      });
      expect(real.code).toBe(1);
      expect(real.stderr).toContain("could not be read");
    });

    it("REFUSES a run spec the VM does not hold: re-run provision — fatal in a plan too", () => {
      env = scratch();
      for (const dry of [true, false]) {
        const r = release(env, { vm: { fingerprint: "0".repeat(64) }, dry });
        expect(r.code, String(dry)).toBe(1);
        expect(r.stderr).toContain("differs from the one group_vars renders");
        expect(r.stderr).toContain("re-run provision");
      }
      // …and a group_vars change moves the fingerprint, so the VM's stale spec is caught
      const stale = fingerprintOf(env);
      writeFileSync(
        join(env.ansible, "group_vars", "all.yml"),
        readFileSync(join(env.ansible, "group_vars", "all.yml"), "utf8") +
          "container_memory: 12g\n",
      );
      execFileSync("git", ["-C", env.sandbox, "status", "--porcelain"]);
      const r = release(env, { vm: { fingerprint: stale } });
      expect(r.code).toBe(1);
      expect(r.stderr).toContain("re-run provision");
    });

    it("refuses a release whose images need a newer run spec than this checkout renders", () => {
      env = scratch();
      const r = release(env, {
        patch: (m) => {
          m.pins.runspec = 2;
        },
      });
      expect(r.code).toBe(1);
      expect(r.stderr).toContain("need run spec v2 but this checkout renders v1");
      expect(r.stderr).toContain("re-run provision");
    });
  });

  describe("the manifest", () => {
    it("is required: a release names no image without CI's manifest", () => {
      env = scratch();
      const r = run(env, [
        "--dry-run",
        "release",
        "1.2.3",
        "--manifest",
        join(env.dir, "nope.json"),
      ]);
      expect(r.code).toBe(1);
      expect(r.stderr).toContain("no deploy manifest at");
      expect(r.stderr).toContain("deploy/manifest.schema.json");
    });

    it("REFUSES when the tag resolves to a different digest than the manifest's — in a plan too", () => {
      env = scratch();
      for (const dry of [true, false]) {
        const r = release(env, {
          dry,
          env: { QC_TAG_DIGEST_CMD: `echo sha256:${"9".repeat(64)}` },
        });
        expect(r.code, String(dry)).toBe(1);
        expect(r.stderr).toContain("resolves to sha256:99");
        expect(r.stderr).toContain("exactly the bytes CI built");
      }
    });

    it("an unreadable registry is UNKNOWN: the plan says so, a real run refuses", () => {
      env = scratch();
      const plan = release(env, { env: { QC_TAG_DIGEST_CMD: "exit 1" } });
      expect(plan.code, plan.stderr).toBe(0);
      expect(plan.stdout).toContain("REFUSED in a real run: the registry could not be read");
      const real = release(env, { dry: false, env: { QC_TAG_DIGEST_CMD: "exit 1" } });
      expect(real.code).toBe(1);
      expect(real.stderr).toContain("registry could not be read");
    });

    it("downloads the release's attached manifest when none is named or beside us", () => {
      env = scratch();
      const src = writeManifest(env, undefined, "1.2.3", "attached.json");
      const r = run(env, ["--dry-run", "release", "1.2.3"], {
        QC_UPDATE_STATUS_CMD: statusCmd(env),
        QC_RELEASE_DOWNLOAD_CMD: `cp ${JSON.stringify(src)} "$2/deploy-manifest-$1.json"`,
        QC_TAG_DIGEST_CMD: tagDigestStub(["--manifest", src]),
      });
      expect(r.code, r.stderr).toBe(0);
      expect(r.stdout).toContain(`daemon ghcr.io/quickchatai/quickreview@${DAEMON_DIGEST}`);
    });

    it("REFUSES a malformed manifest, naming the problem; accepts the fixture", () => {
      env = scratch();
      expect(release(env).code).toBe(0);
      const bad = release(env, {
        patch: (m) => {
          m.images.daemon!.index_digest = "sha256:short";
          delete (m as Record<string, unknown>).revision;
        },
      });
      expect(bad.code).toBe(1);
      expect(bad.stderr).toContain("malformed deploy manifest");
      expect(bad.stderr).toContain("index_digest");
      expect(bad.stderr).toContain('missing "revision"');
      const notJson = join(env.dir, "not-json.json");
      writeFileSync(notJson, "{ nope");
      const r = run(env, ["--dry-run", "release", "1.2.3", "--manifest", notJson]);
      expect(r.code).toBe(1);
      expect(r.stderr).toContain("not JSON");
    });

    it("REFUSES a manifest for another version, and images that are not the ones group_vars names", () => {
      env = scratch();
      const m = writeManifest(env, () => {}, "1.2.4", "other.json");
      const r = run(env, ["--dry-run", "release", "1.2.3", "--manifest", m]);
      expect(r.code).toBe(1);
      expect(r.stderr).toContain("is for version 1.2.4, not 1.2.3");
      const other = release(env, {
        patch: (x) => {
          x.images.daemon!.repository = "ghcr.io/elsewhere/quickreview";
        },
      });
      expect(other.code).toBe(1);
      expect(other.stderr).toContain("daemon image repository pin mismatch");
    });

    it("KEEPS rule 7: a pin drift between the manifest (the images' labels) and config.toml refuses", () => {
      env = scratch();
      const pi = release(env, {
        patch: (m) => {
          m.pins.pi = "1.4.0";
        },
      });
      expect(pi.code).toBe(1);
      expect(pi.stderr).toContain("pi (manifest) pin mismatch");
      expect(pi.stderr).toContain('manifest pins.pi = "1.4.0"');
      rmSync(env.dir, { recursive: true, force: true });

      const OV = { version: "0.4.15", llama: "0.3.35" };
      env = scratch({ configOv: OV });
      expect(release(env).code).toBe(0);
      for (const [key, value, label] of [
        ["openviking", "0.4.16", "openviking (manifest) pin mismatch"],
        ["llama_cpp_python", "0.3.99", "llama-cpp-python (manifest) pin mismatch"],
      ] as const) {
        const r = release(env, {
          patch: (m) => {
            m.pins[key] = value;
          },
        });
        expect(r.code, key).toBe(1);
        expect(r.stderr, key).toContain(label);
      }
    });

    it("KEEPS rule 7: the embedder file and sha256 in the manifest are held to group_vars", () => {
      const PIN: LocalEmbedderPin = {
        dir: "/opt/openviking/models",
        model: "bge-small-en-v1.5-f16",
        url: "https://example.invalid/bge.gguf",
        sha: "f0b2fef971e8366438bfd2d9aefea1b0115919389448806d290237f638bae999",
        port: "1934",
        threads: "1",
      };
      env = scratch({ configOv: { version: "0.4.15", llama: "0.3.35", localEmbedder: PIN } });
      expect(release(env).code).toBe(0);
      const sha = release(env, {
        patch: (m) => {
          m.pins.embedder_sha256 = "0".repeat(64);
        },
      });
      expect(sha.code).toBe(1);
      expect(sha.stderr).toContain("local embedder model sha256 (manifest) pin mismatch");
      const file = release(env, {
        patch: (m) => {
          m.pins.embedder_file = "/opt/openviking/models/other.gguf";
        },
      });
      expect(file.code).toBe(1);
      expect(file.stderr).toContain("local embedder model file (manifest) pin mismatch");
    });

    it("the config/group_vars pin refusals still bind a release (embedder, endpoint, openviking)", () => {
      env = scratch({
        configOv: { version: "0.4.15", llama: "0.3.35" },
        groupVarsOv: { version: "0.4.16", llama: "0.3.35" },
      });
      const r = run(env, ["--dry-run", "release", "1.2.3", "--manifest", writeManifest(env)], {
        QC_UPDATE_STATUS_CMD: "true",
      });
      expect(r.code).toBe(1);
      expect(r.stderr).toContain("openviking pin mismatch");
    });
  });

  describe("a real run against stubs", () => {
    function stubs(e: Env, updateRc = 0) {
      const bin = join(e.dir, "bin");
      mkdirSync(bin, { recursive: true });
      writeFileSync(join(bin, "ssh"), "#!/bin/sh\necho stub-ok\n", { mode: 0o755 });
      const argv = join(e.dir, "update-argv");
      const stdin = join(e.dir, "update-stdin.tar");
      return {
        argv,
        stdin,
        env: {
          PATH: `${bin}:${process.env.PATH ?? ""}`,
          QC_UPDATE_RUN_CMD: `cat > '${stdin}'; printf '%s\\n' "$*" > '${argv}'; exit ${updateRc}`,
          QC_HEARTBEAT_PROBE_CMD: `printf '%s\\n%s\\n%s' '2026-10-03T09:55:40.000000000Z' '2026-10-03T09:57:00Z' '{"written_at":"2026-10-03T09:56:50.000Z"}'`,
          QC_HEARTBEAT_WAIT_S: "0",
          QC_MEMORY_WAIT_S: "0",
          QC_MEMORY_PROBE_CMD: "true",
          QC_MEMORY_SEARCH_CMD: "true",
        },
      };
    }

    it("calls the updater once with <version>@<digest> and the memory digest; opens the deploy-grace window; then runs the post-deploy checks", () => {
      env = scratch();
      const s = stubs(env);
      const r = release(env, { dry: false, env: s.env });
      expect(r.code, r.stderr).toBe(0);
      expect(readFileSync(s.argv, "utf8").trim()).toBe(
        `1.2.3@${DAEMON_DIGEST} --memory-digest ${MEMORY_DIGEST}`,
      );
      expect(existsSync(s.stdin)).toBe(true);
      expect(r.stderr).toContain("running: tar config.toml");
      expect(r.stdout).toContain("--- heartbeat written by this boot");
      expect(r.stderr).toContain("deploy ok (release");
      const marker = readFileSync(
        join(env.sandbox, "state", "companion", "alerts", ".deploy-window.json"),
        "utf8",
      );
      expect(marker).toContain('"mode":"release"');
    });

    it("passes --cutover-ack <version> on the cutover", () => {
      env = scratch();
      const s = stubs(env);
      const r = release(env, {
        dry: false,
        env: s.env,
        vm: { layout: "legacy" },
        args: ["--cutover-ack"],
      });
      expect(r.code, r.stderr).toBe(0);
      expect(readFileSync(s.argv, "utf8").trim()).toBe(
        `1.2.3@${DAEMON_DIGEST} --memory-digest ${MEMORY_DIGEST} --cutover-ack 1.2.3`,
      );
    });

    it("a failing updater fails the release and runs no post-deploy check", () => {
      env = scratch();
      const s = stubs(env, 3);
      const r = release(env, { dry: false, env: s.env });
      expect(r.code).toBe(1);
      expect(r.stderr).toContain("qcr-update failed");
      expect(r.stderr).toContain("rescued");
      expect(r.stdout).not.toContain("--- heartbeat");
    });

    it("runs `sudo qcr-update` over ssh when no stub stands in, with the tar on stdin", () => {
      env = scratch();
      const s = stubs(env);
      const bin = join(env.dir, "bin");
      const log = join(env.dir, "ssh-log");
      const stdinCopy = join(env.dir, "ssh-stdin.tar");
      writeFileSync(
        join(bin, "ssh"),
        `#!/bin/sh\nprintf '%s\\n' "$*" >> '${log}'\ncase "$*" in *qcr-update*) cat > '${stdinCopy}' ;; esac\necho stub-ok\n`,
        { mode: 0o755 },
      );
      const r = release(env, {
        dry: false,
        env: {
          ...s.env,
          PATH: `${bin}:${process.env.PATH ?? ""}`,
          QC_UPDATE_RUN_CMD: "",
          QC_VM_HOST: "the-vm",
        },
      });
      expect(r.code, r.stderr).toBe(0);
      expect(readFileSync(log, "utf8")).toContain(
        `-o BatchMode=yes the-vm sudo qcr-update 1.2.3@${DAEMON_DIGEST} --memory-digest ${MEMORY_DIGEST}`,
      );
      expect(execFileSync("tar", ["-tf", stdinCopy], { encoding: "utf8" })).toContain(
        "config.toml",
      );
    });
  });
});

// ---- the base clone, for any repo name ------------------------------------
// The VM's base clone lives in the sandbox root and is mounted into the daemon
// container under the configured clone name: the run spec carries it
// (BASE_CLONE_DIR), provision creates its directory, the updater mounts it. A
// literal repo name would mount the wrong directory for any other reviewed repo.
describe("deploy.sh — base clone name", () => {
  const ACME = { repo: "acme/acme-api" };

  /** The `-e k=v` extra vars on the planned ansible command. */
  function extraVars(stdout: string): Record<string, string> {
    const line = stdout.split("\n").find((l) => l.includes("  command      ")) ?? "";
    return Object.fromEntries(
      [...line.matchAll(/-e (\w+)=(\S+)/g)].map((m) => [m[1]!, m[2]!] as const),
    );
  }

  it("names the clone in the plan, hands it to provision and writes it into the run spec", () => {
    env = makeScratch({ configPi: "0.84.1", groupVarsPi: "0.84.1", github: ACME });
    const prov = run(env, ["--dry-run", "provision"]);
    expect(prov.code).toBe(0);
    expect(prov.stdout).toContain("base clone   /acme-api");
    expect(extraVars(prov.stdout).base_clone_dir).toBe("acme-api");
    const rel = release(env);
    expect(rel.code, rel.stderr).toBe(0);
    expect(rel.stdout).toContain("base clone   /acme-api");
    // the release runs no ansible: the clone rides the run spec the VM already holds
    expect(rel.stdout).not.toContain("base_clone_dir=");
  });

  it("hands the install locator's secrets dir to provision's secrets copy — and a release ships none", () => {
    // Temp homes only: the locator never sees the operator's own.
    const homes = (e: Env) => ({ HOME: join(e.dir, "home"), XDG_CONFIG_HOME: join(e.dir, "xdg") });
    env = makeScratch({ configPi: "0.84.1", groupVarsPi: "0.84.1", github: ACME });
    const h = homes(env);
    // Nothing anywhere → the config home's secrets dir.
    let r = run(env, ["--dry-run", "provision"], h);
    expect(r.code).toBe(0);
    const home = join(h.XDG_CONFIG_HOME, "qcr", "default", "secrets");
    expect(extraVars(r.stdout).secrets_src).toBe(home);
    expect(r.stdout).toContain(`secrets      ${home}`);
    // The legacy dir holding them changes nothing — it is never shipped.
    const legacy = join(h.HOME, ".config", "quickreview-bot");
    mkdirSync(legacy, { recursive: true });
    writeFileSync(join(legacy, "app_id"), "1\n");
    r = run(env, ["--dry-run", "provision"], h);
    expect(extraVars(r.stdout).secrets_src).toBe(home);
    mkdirSync(home, { recursive: true });
    r = run(env, ["--dry-run", "provision"], h);
    expect(extraVars(r.stdout).secrets_src).toBe(home);
    // a release ships no secrets
    const rel = release(env, { env: h });
    expect(rel.stdout).not.toContain("secrets_src");
    expect(rel.stdout).not.toContain(`secrets      ${home}`);
    // A secrets_dir the operator set wins.
    env = makeScratch({
      configPi: "0.84.1",
      groupVarsPi: "0.84.1",
      github: { ...ACME, secretsDir: "/srv/keys" },
    });
    r = run(env, ["--dry-run", "provision"], homes(env));
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

  it("the playbook refuses to create the runtime directories without a clone name (no silent default)", () => {
    const playbook = readFileSync(join(root, "deploy", "ansible", "playbook.yml"), "utf8");
    expect(playbook).toContain('- "{{ base_clone_dir | mandatory }}"');
  });

  it("a local clone of any name leaves the checkout alone: no ignore rule is written and the tree stays clean", () => {
    env = makeScratch({ configPi: "0.84.1", groupVarsPi: "0.84.1", github: ACME });
    // nothing is rsynced from this tree any more, so a nested clone needs no rule
    const before = existsSync(join(env.sandbox, ".git", "info", "exclude"))
      ? readFileSync(join(env.sandbox, ".git", "info", "exclude"), "utf8")
      : "";
    expect(run(env, ["--dry-run"]).code).toBe(0);
    const after = existsSync(join(env.sandbox, ".git", "info", "exclude"))
      ? readFileSync(join(env.sandbox, ".git", "info", "exclude"), "utf8")
      : "";
    expect(after).toBe(before);
    expect(after).not.toContain("acme-api");
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

  it("refuses a clone name that is a runtime/build dir of the sandbox root — the list names every directory the updater mounts", () => {
    const reserved = /^BASE_CLONE_RESERVED=\(([^)]*)\)$/m.exec(readFileSync(deploySh, "utf8"))?.[1];
    expect(reserved).toBeDefined();
    const list = reserved!.split(/\s+/).filter(Boolean);
    // every `$ROOT/sandbox/<dir>` the updater mounts, besides the clone's own
    const updater = readFileSync(join(root, "deploy", "qcr-update.sh"), "utf8");
    const mounted = new Set([...updater.matchAll(/\$ROOT\/sandbox\/([a-z]+):/g)].map((m) => m[1]!));
    expect([...mounted].sort()).toEqual(
      ["archive", "commands", "digest", "inject", "verdict", "wt"].sort(),
    );
    for (const d of mounted) expect(list, d).toContain(d);
    // …and the playbook creates exactly those, plus the clone's own
    const playbook = readFileSync(join(root, "deploy", "ansible", "playbook.yml"), "utf8");
    const made = playbook.slice(
      playbook.indexOf("- name: Runtime directories the containers mount"),
      playbook.indexOf("- name: Directories for the sidecar's store"),
    );
    for (const d of mounted) expect(made, d).toMatch(new RegExp(`^\\s+- ${d}$`, "m"));
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

// A release can leave the previous daemon's status.json on disk; the
// post-deploy check must then not read it as healthy. These cases pin the guards against that.
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

// ---- the playbook is provision only: it installs the updater and pulls no image -------------
describe("deploy — what the playbook does (provision) and no longer does", () => {
  const raw = readFileSync(join(root, "deploy", "ansible", "playbook.yml"), "utf8");
  // Comment lines dropped: the prose around a task says what it must never do.
  const text = raw
    .split("\n")
    .filter((l) => !/^\s*#/.test(l))
    .join("\n");
  const tasks = (parseYaml(text) as { name: string; tasks?: { name: string }[] }[]).flatMap(
    (play) => (play.tasks ?? []).map((t) => t.name),
  );
  const at = (needle: string): number => {
    const i = text.indexOf(needle);
    expect(i, `${needle} is in the playbook`).toBeGreaterThan(-1);
    return i;
  };

  it("installs the updater (root 0755) and its run spec (root-owned) from the controller's files", () => {
    const updater = text.slice(
      at("- name: The updater (/usr/local/sbin/qcr-update, root 0755)"),
      at("- name: The updater's run spec (/etc/qcr/update.conf, root-owned)"),
    );
    expect(updater).toContain('src: "{{ playbook_dir }}/../qcr-update.sh"');
    expect(updater).toContain("dest: /usr/local/sbin/qcr-update");
    expect(updater).toContain('mode: "0755"');
    expect(updater).toContain("owner: root");
    expect(existsSync(join(root, "deploy", "qcr-update.sh"))).toBe(true);
    const spec = text.slice(
      at("- name: The updater's run spec (/etc/qcr/update.conf, root-owned)"),
      at("- name: Operator command channel present?"),
    );
    expect(spec).toContain('src: "{{ update_conf_src | mandatory }}"');
    expect(spec).toContain("dest: /etc/qcr/update.conf");
    expect(spec).toContain("owner: root");
    expect(spec).not.toContain("0666");
    // the backups and the updater's own state are root's alone
    const dirs = text.slice(
      at("- name: The updater's directories (root only)"),
      at("- name: The updater (/usr/local/sbin/qcr-update, root 0755)"),
    );
    expect(dirs).toContain("/var/backups/qcr");
    expect(dirs).toMatch(/\/var\/backups\/qcr, mode: "0700"/);
  });

  it("never pulls, builds, starts or stops an image or a container, and rsyncs nothing", () => {
    expect(text).not.toMatch(
      /docker_image|docker_container|docker_network|docker build|docker pull|docker run|synchronize|rsync_opts|buildx/,
    );
    for (const gone of [
      "Image source and version",
      "Pull the release images",
      "Sync the local sandbox working copy",
      "Ship the install's config home",
      "Sandbox tree owned by the container user",
      "Build the sandbox image (dev)",
      "Build the memory sidecar image",
      "Run the memory sidecar",
      "Run the sandbox container",
      "Seed the sidecar's store from the daemon's (first flip only)",
    ]) {
      expect(
        tasks.some((t) => t.includes(gone)),
        gone,
      ).toBe(false);
    }
    // the knobs of the deleted paths
    for (const knob of [
      "image_source",
      "dev_image_tag",
      "memory_image_tag",
      "rebuild_image",
      "sandbox_src",
      "tmux_version",
    ]) {
      expect(text, knob).not.toContain(knob);
    }
  });

  it("creates the directory layout the updater's mounts need, before the updater is installed or used", () => {
    expect(tasks).toContain("Directory layout (container user = uid {{ container_uid }})");
    expect(tasks).toContain(
      "Runtime directories the containers mount (container user = uid {{ container_uid }})",
    );
    expect(tasks).toContain(
      "Directories for the sidecar's store (container user = uid {{ container_uid }})",
    );
    // the config home's mount point exists for the first bind mount; its content is the updater's
    expect(text).toContain('path: "{{ sandbox_root }}/config-home", mode: "0755"');
  });

  it("parses as YAML and the tracked group_vars carries every knob it uses", () => {
    const groupVars = readFileSync(
      join(root, "deploy", "ansible", "group_vars", "all.yml"),
      "utf8",
    );
    // A task name with an unquoted `word: ` once made the whole playbook unparseable.
    expect(() => parseYaml(text), "playbook.yml").not.toThrow();
    expect(() => parseYaml(groupVars), "group_vars/all.yml").not.toThrow();
    // every group_vars knob is used somewhere: the playbook, the run spec or the checks
    const used = text + readFileSync(deploySh, "utf8");
    for (const key of [
      "openviking_endpoint",
      "memory_container_name",
      "memory_network",
      "memory_state_dir",
      "memory_container_cpus",
      "memory_container_memory",
      "release_image",
      "release_memory_image",
      "app_root",
      "legacy_sandbox_root",
    ]) {
      expect(groupVars, key).toMatch(new RegExp(`^${key}:`, "m"));
      expect(used, key).toContain(key);
    }
    for (const gone of [
      "image_source",
      "dev_image_tag",
      "memory_image_tag",
      "memory_image_name",
      "sandbox_src",
      "tmux_version",
    ]) {
      expect(groupVars, gone).not.toMatch(new RegExp(`^${gone}:`, "m"));
    }
    // The VM's tracked value is the flip; its rollback value is `local`.
    expect(groupVars).toMatch(/^openviking_endpoint: "remote"/m);
    // The seeded copy never lands on the daemon's own directory.
    expect(groupVars).toMatch(/^memory_state_dir: \/opt\/quickreview\/memory-state$/m);
    expect(groupVars).not.toMatch(/^memory_state_dir: .*\/openviking$/m);
  });

  it("ansible-playbook --syntax-check passes (when ansible is installed)", () => {
    let has = true;
    try {
      execFileSync("ansible-playbook", ["--version"], { stdio: "ignore" });
    } catch {
      has = false;
    }
    if (!has) return;
    const inv = join(root, "deploy", "ansible", "inventory.example.ini");
    expect(() =>
      execFileSync(
        "ansible-playbook",
        ["--syntax-check", "-i", inv, join(root, "deploy", "ansible", "playbook.yml")],
        { stdio: "pipe", env: { ...process.env, ANSIBLE_LOCAL_TEMP: tmpdir() } },
      ),
    ).not.toThrow();
  });
});

// A recursive chown of the sandbox would hand commands/operator/ to the
// container user, so a pending operator drain would be served as a session's
// and the boot would never lift it. The playbook no longer chowns the tree at
// all (the chown sweep went with the rsync); it still re-seals the channel.
describe("deploy — the operator channel's seal", () => {
  const playbook = () => readFileSync(join(root, "deploy", "ansible", "playbook.yml"), "utf8");

  it("has no recursive chown sweep any more, so nothing can hand the operator channel away", () => {
    const text = playbook();
    expect(text).not.toContain("Sandbox tree owned by the container user");
    expect(text).not.toMatch(/-exec\s*\n?\s*- chown|argv:\s*\n\s+- find/);
  });

  it("re-seals commands/operator root:root 0755 before the runtime directories are made", () => {
    const text = playbook();
    const seal = text.indexOf("- name: Operator command channel stays root-owned 0755 (the seal)");
    expect(seal).toBeGreaterThan(0);
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
    const res = run(env, ["--dry-run", "provision"]);
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
    const res = run(env, ["--dry-run", "provision"]);
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
    const res = run(env, ["--dry-run", "provision"]);
    expect(res.code).toBe(0);
    expect(planVars(res.stdout).slack_bot_token_file).toBe("slack_bot_token");
  });

  it("runs the container as the UID used for provisioned ownership", () => {
    // MUTATION: replace the uid in the updater's --user with 1001; this fails.
    // The release image has no passwd entry for the user it runs as: the caller picks it.
    const updater = readFileSync(join(root, "deploy/qcr-update.sh"), "utf8");
    expect(updater).toContain('UID_GID="${C[CONTAINER_UID]}:${C[CONTAINER_UID]}"');
    expect(updater).toContain('--user "$UID_GID"');
    // …and it is the uid the secrets and the mounted directories are given to.
    const text = readFileSync(join(root, "deploy/ansible/playbook.yml"), "utf8");
    expect(text).toContain('owner: "{{ container_uid }}"');
  });
});

// The memory sidecar: a second container on the VM (docker/memory/), the
// `[openviking] endpoint` flip, and the deploy plumbing around both. Nothing
// here runs ansible or touches a VM: deploy.sh stops at --dry-run, a refusal or
// a stub ssh, and the playbook and the updater are read as text.
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
      const r = release(env);
      expect(r.code, r.stderr).toBe(0);
      expect(r.stdout).toMatch(
        /containers\s+quickreview-sandbox \(daemon\) \+ quickreview-memory \(memory sidecar/,
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
      const r = release(env);
      expect(r.stdout).toContain("sudo docker ps --filter name=quickreview-memory");
      expect(r.stdout).toContain(
        "sudo docker container inspect -f '{{.State.Running}}' quickreview-memory",
      );
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
      const manifest = writeManifest(env);
      for (const r of [
        run(env, ["--dry-run", "release", "1.2.3", "--manifest", manifest], {
          QC_UPDATE_STATUS_CMD: "true",
        }),
        run(env, ["--dry-run", "provision"]),
      ]) {
        expect(r.code).toBe(1);
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
      expect(run(env, ["--dry-run", "provision"]).code).toBe(1);
    });

    it("honours a renamed sidecar (group_vars memory_container_name) in the checks", () => {
      env = scratch(
        { ...OV_REMOTE, host: "mem-box" },
        { ...OV_REMOTE, memoryContainer: "mem-box" },
      );
      const r = release(env);
      expect(r.code, r.stderr).toBe(0);
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

  describe("the updater (the sidecar and the daemon container are its)", () => {
    // Comment lines dropped: the prose around a step says what it must never do.
    const updater = readFileSync(join(root, "deploy", "qcr-update.sh"), "utf8")
      .split("\n")
      .filter((l) => !/^\s*#/.test(l))
      .join("\n");
    const at = (needle: string): number => {
      const i = updater.indexOf(needle);
      expect(i, `${needle} is in qcr-update`).toBeGreaterThan(-1);
      return i;
    };

    it("starts the sidecar and waits for /ready before the daemon boots against it; there is no way back to local", () => {
      const start = at("step sidecar-start");
      const ready = at("step sidecar-ready");
      const recreate = at("step recreate");
      const seed = at("step seed");
      const stop = at("step stop");
      expect([stop, seed, start, ready, recreate].sort((a, b) => a - b)).toEqual([
        stop,
        seed,
        start,
        ready,
        recreate,
      ]);
      // the release image cannot supervise OpenViking: no step turns the sidecar off for good
      expect(updater).not.toMatch(/OPENVIKING_ENDPOINT/);
    });

    it("copies the store once, on the legacy layout, verifies it by checksum, marks it, and only then", () => {
      const block = updater.slice(at("step seed"), at("step swap"));
      expect(block).toContain('"$LAYOUT" == legacy');
      expect(block).toContain('[[ ! -e "$marker" ]]');
      const copy = block.indexOf("rsync -a");
      const verify = block.indexOf("--checksum --dry-run --itemize-changes");
      const mark = block.indexOf('>"$marker"');
      expect(copy).toBeGreaterThan(-1);
      expect(verify).toBeGreaterThan(copy);
      expect(mark).toBeGreaterThan(verify);
      expect(block).toContain('[[ -z "$diff_out" ]] || die');
      // the daemon container is stopped before the copy (a live store is not consistent)
      expect(at("step stop")).toBeLessThan(at("step seed"));
    });

    it("NEVER wipes or moves a store: no --delete, no rm or mv of the memory dirs, the source is only read", () => {
      const block = updater.slice(at("step seed"), at("step swap"));
      expect(block).not.toMatch(/--delete|\brm\b|\bmv\b|--remove-source/);
      // the only writer names the sidecar's directory as destination
      expect(block).toContain('rsync -a "${C[OPENVIKING_HOME]}/" "${C[MEMORY_STATE_DIR]}/"');
    });

    it("publishes NO port for the sidecar, mounts secrets and config read-only, caps it and keeps it up", () => {
      const block = updater.slice(at("mem_args=("), at('mem_args+=("$MEMORY_REF")'));
      expect(block).not.toMatch(/\s-p\s|--publish/);
      expect(block).toContain('-v "$ROOT/secrets:/opt/quickreview/secrets:ro"');
      expect(block).toContain('-v "$ROOT/config-home:/opt/quickreview/config-home:ro"');
      expect(block).toContain('-v "${C[MEMORY_STATE_DIR]}:${C[OPENVIKING_HOME]}"');
      expect(block).toContain('--cpus "${C[MEMORY_CPUS]}"');
      expect(block).toContain('--memory-swap "${C[MEMORY_MEMORY]}"');
      expect(block).toContain("--restart unless-stopped");
      expect(block).toContain("--init");
      // the companion key is not on this machine: nothing like the docker socket or ssh either
      expect(block).not.toMatch(/docker\.sock|\/\.ssh|state:\/opt\/quickreview\/state\b/);
    });

    it("passes the sidecar entrypoint exactly the knobs it reads, from the run spec", () => {
      const sh = readFileSync(deploySh, "utf8");
      const passed = [...sh.matchAll(/'SIDECAR_ENV_(QCR_OPENVIKING_[A-Z0-9_]+)=/g)].map(
        (m) => m[1]!,
      );
      const entrypoint = readFileSync(join(root, "docker", "memory", "entrypoint.sh"), "utf8");
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
      // the updater turns each SIDECAR_ENV_<NAME> into -e <NAME>
      expect(updater).toContain(
        '[[ "$key" == SIDECAR_ENV_* ]] && mem_args+=(-e "${key#SIDECAR_ENV_}=${C[$key]}")',
      );
    });

    it("joins the daemon to the sidecar's network and keeps its published webhook port on loopback", () => {
      const block = updater.slice(at("daemon_args=("), at('daemon_args+=("$DAEMON_REF" daemon)'));
      expect(block).toContain('--network "${C[MEMORY_NETWORK]}"');
      expect(block).toContain('-p "127.0.0.1:${C[WEBHOOK_PORT]}:${C[WEBHOOK_PORT]}"');
    });
  });

  describe("the daemon container (the release image in daemon mode)", () => {
    const updater = readFileSync(join(root, "deploy", "qcr-update.sh"), "utf8")
      .split("\n")
      .filter((l) => !/^\s*#/.test(l))
      .join("\n");
    const start = updater.indexOf("daemon_args=(");
    const block = updater.slice(start, updater.indexOf('daemon_args+=("$DAEMON_REF" daemon)'));
    const volumes = [...block.matchAll(/^\s+-v "([^"]+)"$/gm)].map((m) => m[1]!);

    it("keeps the container's name, port, caps and restart policy, and runs the image's daemon mode", () => {
      expect(block).toContain('--name "$DAEMON"');
      expect(updater).toContain('daemon_args+=("$DAEMON_REF" daemon)');
      expect(block).toContain("--restart unless-stopped");
      expect(block).toContain("--init");
      expect(block).toContain('--cpus "${C[DAEMON_CPUS]}"');
      expect(block).toContain('--memory "${C[DAEMON_MEMORY]}"');
      expect(block).toContain('-p "127.0.0.1:${C[WEBHOOK_PORT]}:${C[WEBHOOK_PORT]}"');
      // Joined to the sidecar's network: that is how [openviking] host resolves.
      expect(block).toContain('--network "${C[MEMORY_NETWORK]}"');
    });

    it("mounts the SAME host directories the legacy container used: state, pihome, secrets, config-home", () => {
      expect(volumes).toContain("$ROOT/state:${C[APP_ROOT]}/state");
      expect(volumes).toContain("$ROOT/pihome:/home/qcr/.pi");
      expect(volumes).toContain("$ROOT/secrets:/opt/quickreview/secrets:ro");
      expect(volumes).toContain("$ROOT/config-home:/opt/quickreview/config-home:ro");
    });

    it("mounts every runtime directory of the old sandbox root into the read-only app root, and the playbook creates each first", () => {
      const dirs = ["wt", "archive", "commands", "digest", "inject", "verdict"];
      for (const d of dirs) {
        expect(volumes, d).toContain(`$ROOT/sandbox/${d}:\${C[APP_ROOT]}/${d}`);
      }
      expect(volumes).toContain(
        "$ROOT/sandbox/${C[BASE_CLONE_DIR]}:${C[APP_ROOT]}/${C[BASE_CLONE_DIR]}",
      );
      // Docker would create a missing source as root: each is made for the container user first.
      const playbook = readFileSync(join(root, "deploy", "ansible", "playbook.yml"), "utf8");
      const made = playbook.slice(
        playbook.indexOf("- name: Runtime directories the containers mount"),
        playbook.indexOf("- name: Directories for the sidecar's store"),
      );
      for (const d of [...dirs, '"{{ base_clone_dir | mandatory }}"']) {
        expect(made, d).toMatch(new RegExp(`^\\s+- ${d.replace(/[{}|"]/g, "\\$&")}$`, "m"));
      }
      expect(made).toContain('owner: "{{ container_uid }}"');
      // Every runtime dir the deploy script reserves is mounted.
      const reserved = /BASE_CLONE_RESERVED=\(([^)]*)\)/.exec(readFileSync(deploySh, "utf8"))![1]!;
      for (const d of dirs) expect(reserved.split(/\s+/), d).toContain(d);
    });

    it("mounts the worktrees and the base clone a second time at their legacy path, so recorded absolute paths resolve", () => {
      expect(volumes).toContain("$ROOT/sandbox/wt:${C[LEGACY_SANDBOX_ROOT]}/wt");
      expect(volumes).toContain(
        "$ROOT/sandbox/${C[BASE_CLONE_DIR]}:${C[LEGACY_SANDBOX_ROOT]}/${C[BASE_CLONE_DIR]}",
      );
      const groupVars = parseYaml(
        readFileSync(join(root, "deploy", "ansible", "group_vars", "all.yml"), "utf8"),
      ) as Record<string, unknown>;
      expect(groupVars.legacy_sandbox_root).toBe("/opt/quickreview/sandbox");
      expect(groupVars.app_root).toBe("/opt/qcr");
    });

    it("never mounts the app root itself, the docker socket or a home directory: the tree is the image's", () => {
      expect(block).not.toMatch(/docker\.sock|\/\.ssh|-v "\$ROOT\/sandbox:/m);
      for (const v of volumes) {
        expect(v.split(":")[1], v).not.toBe("${C[APP_ROOT]}");
      }
    });

    it("sets only the env the image's daemon mode reads, and no OpenViking endpoint knob", () => {
      const envLines = [...block.matchAll(/-e "?([A-Z_]+)=/g)].map((m) => m[1]!);
      for (const name of ["TZ", "QC_REVIEW_PORT", "QC_BIND_HOST", "QCR_CONFIG"]) {
        expect(envLines, name).toContain(name);
      }
      // The legacy entrypoint read this to skip its memory boot; the image has no such boot.
      expect(block).not.toContain("QCR_OPENVIKING_ENDPOINT");
      // Nothing in env is a token (rule 3, D39).
      expect(block).not.toMatch(/TOKEN|SECRET|PASSWORD|PEM/);
    });

    it("the image's daemon mode does what the legacy entrypoint did, less the global bash-guard merge (P9.5): the stub, the agents link", () => {
      const entry = readFileSync(join(root, "docker", "entrypoint.sh"), "utf8");
      const daemonMode = entry.slice(
        entry.indexOf("mode_daemon() {"),
        entry.indexOf("mode_companion() {"),
      );
      expect(daemonMode).not.toContain("QCR_PI_REQUIRE_EXT");
      expect(entry).not.toContain("FATAL: pi extension missing");
      expect(daemonMode).toContain("assert_pinned_pi_cli");
      expect(daemonMode).not.toContain("assert_subagent_example");
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
// The VM pulls the private release images with the owner's classic
// read:packages login. The updater pulls BY DIGEST on the VM (a lapsed login
// fails its pull before anything changes), `verify` and `release` warn before
// the recorded token expiry; scripts/vm-ghcr-login.sh is the one writer of that
// login. Every command here is a stub: no network, no ssh, no docker.
describe("deploy.sh — the pull login and the token expiry warning", () => {
  const scratch = (): Env => makeScratch({ configPi: "0.84.1", groupVarsPi: "0.84.1" });

  /** A stub ssh on PATH; the log is what the controller ran over it. */
  function stubBin(e: Env): { PATH: string; sshLog: string } {
    const bin = join(e.dir, "bin");
    mkdirSync(bin, { recursive: true });
    const sshLog = join(e.dir, "ssh-log");
    writeFileSync(join(bin, "ssh"), `#!/bin/sh\nprintf '%s\\n' "$*" >> '${sshLog}'\nexit 0\n`, {
      mode: 0o755,
    });
    return { PATH: `${bin}:${process.env.PATH ?? ""}`, sshLog };
  }

  it("the controller pulls and inspects no image: the updater pulls both by digest on the VM", () => {
    env = scratch();
    const stub = stubBin(env);
    const r = release(env, { env: { PATH: stub.PATH } });
    expect(r.code, r.stderr).toBe(0);
    // a dry-run release reads the VM through the status stub only: no ssh call, no manifest inspect
    expect(existsSync(stub.sshLog)).toBe(false);
    const sh = readFileSync(deploySh, "utf8").replace(/^\s*#.*$/gm, "");
    expect(sh).not.toMatch(/manifest inspect|docker pull|QC_PULL_CHECK_CMD/);
    const updater = readFileSync(join(root, "deploy", "qcr-update.sh"), "utf8");
    expect(updater).toContain('d pull "$DAEMON_REF"');
    expect(updater).toContain('d pull "$MEMORY_REF"');
    expect(updater).toContain('DAEMON_REF="${C[DAEMON_IMAGE_REPO]}@$DAEMON_DIGEST"');
  });

  it("reads the VM's status over ssh as `sudo qcr-update status --json` when no stub stands in", () => {
    env = scratch();
    const stub = stubBin(env);
    const manifest = writeManifest(env);
    const r = run(env, ["--dry-run", "release", "1.2.3", "--manifest", manifest], {
      PATH: stub.PATH,
      QC_VM_HOST: "the-vm",
    });
    // the stub ssh prints nothing, so the status is UNKNOWN: the plan says so
    expect(r.code, r.stderr).toBe(0);
    expect(readFileSync(stub.sshLog, "utf8")).toContain(
      "-o BatchMode=yes -o ConnectTimeout=10 the-vm sudo qcr-update status --json",
    );
    expect(r.stdout).toContain(
      "REFUSED in a real run: the VM's `qcr-update status` could not be read",
    );
  });

  describe("the recorded token expiry", () => {
    const NOW = Date.parse("2026-10-19T12:00:00Z") / 1000;
    const probe = (e: Env, iso: string | null, mode = "verify") => {
      const file = join(e.dir, "ghcr-token-expiry");
      if (iso === null) rmSync(file, { force: true });
      else writeFileSync(file, `${iso}\n`);
      const extra = { QCR_GHCR_EXPIRY_FILE: file, QC_NOW_EPOCH: String(NOW) };
      return mode === "release" ? release(e, { env: extra }) : run(e, ["--dry-run", mode], extra);
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

describe("the deploy docs describe the updater world", () => {
  const docs = [
    join(root, "deploy", "ansible", "README.md"),
    join(root, ".claude", "skills", "deploying", "SKILL.md"),
  ];
  it("name no retired deploy mode", () => {
    for (const f of docs) {
      const text = readFileSync(f, "utf8");
      expect(text, f).not.toMatch(/deploy\.sh sync|rebuild/);
    }
  });
  it("the skill's deploy.sh commands are modes of the usage string", () => {
    const text = readFileSync(join(root, ".claude", "skills", "deploying", "SKILL.md"), "utf8");
    const usage = readFileSync(join(root, "scripts", "deploy.sh"), "utf8");
    const modes = /usage: \$SELF \[--dry-run\] ([^"]+)"/.exec(usage)?.[1] ?? "";
    for (const m of text.matchAll(/deploy\.sh (?:--dry-run )?([a-z]+)/g)) {
      expect(modes, m[0]).toContain(m[1]);
    }
  });
});
